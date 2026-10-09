// Offline self-test (no API keys, no Meet): parser, code runner, and the teaching engine
// with a fake LLM/TTS - including a mid-lesson doubt and resuming from saved progress.
// This test exercises the board terminal path; the VS Code / Jupyter stage has its own test further down.
process.env.TUTOR_TOOLS = "off";
// Short waits (read when lesson.js loads) so the 8-second doubt windows do not slow the test down.
process.env.TUTOR_DOUBT_WAIT_SEC = "0.3";
process.env.TUTOR_AIDS_CLOSE_SEC = "0.3";
process.env.TUTOR_FOLLOWUP_WAIT_SEC = "0.3";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Stub the network modules before lesson.js loads them.
const stub = (name, exports) => {
  const p = require.resolve(name);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
};
const llmCalls = [];
const systemCalls = [];
stub("./llm", {
  chat: async (provider, messages) => {
    const last = messages[messages.length - 1].content;
    llmCalls.push(last);
    systemCalls.push(messages[0].content);
    if (messages[0].content.includes("speech-to-text")) return /resolved|clear/i.test(last) ? "[RESOLVED] Great, let us continue." : /^hello/i.test(last) ? "[ASK] Hello! What is your doubt?" : "[ANSWER] Great question. Is it clear now?";
    return "This is a spoken explanation. It has two sentences.";
  },
});
const spoken = [];
stub("./tts", { speak: async (text) => Buffer.from(text), provider: () => "fake" });
stub("./sarvam", { transcribe: async () => "why do we use print" });

const { parseSyllabus } = require("./syllabus");
const { runCode } = require("./runner");
const { Tutor } = require("./lesson");
const { Board } = require("./board");

(async () => {
  // ── parser ──
  const src = [
    "@title: Python for Beginners", "@language: en-IN", "@code: python", "",
    "# Variables", "A variable stores a value in memory.", "", "#code#", 'name = "Asha"', "age = 21", 'print(name, "is", age, "years old")', "#/code#", "",
    "# Loops", "A for loop repeats a block of code.", "", "#code#", "for i in range(1, 6):", '    print("Square of", i, "is", i * i)', "#/code#", "",
    "#code#", "total = 0", "for n in [10, 20, 30]:", "    total += n", 'print("Total =", total)', "#/code#",
  ].join("\n");
  const s = parseSyllabus(src, "python.txt");
  assert.equal(s.title, "Python for Beginners");
  assert.equal(s.language, "en-IN");
  assert.deepEqual(s.topics, ["Variables", "Loops"]);
  assert.deepEqual(s.blocks.map((b) => b.type), ["text", "code", "text", "code", "code"]);
  assert.equal(s.blocks[1].lang, "python");
  assert.ok(s.blocks[1].code.includes('print(name, "is", age'));
  assert.ok(!s.blocks[0].text.includes("#code#"));
  const t2 = parseSyllabus("#code js#\nconsole.log(1)\n#code#\nafter\n", "x.txt");
  assert.deepEqual(t2.blocks.map((b) => [b.type, b.lang || ""]), [["code", "javascript"], ["text", ""]]);
  // course folders: the folder gives the course, the default runner and (without @code) the code language
  const intro = "# Intro\n#code#\nprint(1)\n#/code#\n";
  const ml = parseSyllabus(intro, "D:\\x\\syllabus\\AI\\ML1.txt");
  assert.deepEqual([ml.course, ml.runner, ml.codeLang, ml.blocks[0].lang], ["AI", "jupyter", "python", "python"]);
  const py1 = parseSyllabus(intro, "/x/syllabus/Python/python1.txt");
  assert.deepEqual([py1.course, py1.runner, py1.codeLang], ["Python", "vscode", "python"]);
  assert.equal(parseSyllabus("@run: board\n# a", "/x/syllabus/AI/ML1.txt").runner, "board");
  console.log("✓ parser");

  // ── runner ──
  const py = await runCode("python", 'print("hi")\nfor i in range(2): print(i)');
  assert.equal(py.stdout.trim().replace(/\r/g, ""), "hi\n0\n1");
  const bad = await runCode("python", "print(1/0)");
  assert.notEqual(bad.exitCode, 0);
  assert.ok(/ZeroDivisionError/.test(bad.stderr));
  const js = await runCode("javascript", "console.log(2+3)");
  assert.equal(js.stdout.trim(), "5");
  process.env.TUTOR_RUN_TIMEOUT_SEC = "1";
  console.log("✓ runner");

  // ── engine: teach, get interrupted mid-lesson, answer, resume ──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-test-"));
  const progressFile = path.join(tmp, "p.json");
  const board = new Board();
  const events = [];
  const origSet = board.set.bind(board);
  board.set = (t, d) => (events.push(t), origSet(t, d));

  let tutor;
  let played = 0;
  let interruptedOnce = false;
  const sink = {
    async play(buf) {
      spoken.push(buf.toString());
      played++;
      await new Promise((r) => setTimeout(r, 5));
      if (!interruptedOnce && played === 4) {
        interruptedOnce = true;
        tutor.onVoiceStart(); // a participant starts talking
        setTimeout(() => tutor.onSpeech(Buffer.from("wav")), 20);
        return "stopped";
      }
      return "done";
    },
    stop() {},
  };
  process.env.TUTOR_DOUBT_WAIT_SEC = "0.05";
  tutor = new Tutor({ syllabus: s, sink, board, provider: "sarvam", language: "en-IN", progressFile, restart: false });
  await tutor.run();

  assert.ok(spoken.some((t) => t.includes("Great question")), "doubt was answered");
  assert.equal(tutor.lesson.qa.length, 1);
  assert.ok(events.filter((e) => e === "output").length >= 6, "code ran and output shown");
  assert.equal(JSON.parse(fs.readFileSync(progressFile, "utf8")).pos, s.blocks.length);
  // the interrupted chunk was replayed, not skipped
  const idx = spoken.findIndex((t) => t.includes("Great question"));
  assert.equal(spoken[idx + 1], spoken[idx - 1], "interrupted chunk replayed after the answer");
  console.log("✓ engine: teach + interrupt + answer + resume chunk");

  // ── resume from saved progress ──
  fs.writeFileSync(progressFile, JSON.stringify({ pos: 3, lastTopic: "Variables" }));
  spoken.length = 0;
  const t3 = new Tutor({ syllabus: s, sink: { play: async (b) => (spoken.push(b.toString()), "done"), stop() {} }, board: new Board(), provider: "sarvam", language: "en-IN", progressFile });
  await t3.run();
  assert.equal(JSON.parse(fs.readFileSync(progressFile, "utf8")).pos, 5);
  assert.ok(llmCalls.some((c) => /continue with/i.test(c) || /welcome the class back/i.test(c)));
  console.log("✓ resume from block 4");
  // ── code stage: syllabus code shown + run in VS Code / Jupyter, doubt check, close ──
  // (VS Code, Jupyter and the planner are replaced by fakes that record what was asked of them.)
  const tools = require("./tools");
  const jupyter = require("./jupyter");
  const stageSrc = "# Variables\nNotes.\n\n#code#\nprint(1)\n#/code#\n\n#code#\nprint(2)\n#/code#\n";
  const fakeStage = (syllabus, { doubt } = {}) => {
    const calls = [];
    let open = false;
    tools.enabled = () => true;
    tools.isOpen = () => open;
    tools.close = async () => {
      const was = open;
      open = false;
      if (was) calls.push("close");
      return was;
    };
    tools.openLesson = async () => (calls.push("vscode:open"), (open = true));
    tools.runLesson = async () => {
      calls.push("vscode:run");
      if (doubt) setTimeout(() => stageTutor.onQuestion(doubt), 20);
      return { stdout: "1\n", stderr: "", exitCode: 0 };
    };
    tools.plan = async (_p, _l, q, ctx) => {
      calls.push(`plan(stage=${ctx.stage},awaiting=${ctx.awaiting})`);
      const a = [];
      if (ctx.stage && /not clear/.test(q)) a.walkthrough = true;
      return a;
    };
    jupyter.available = async () => true;
    jupyter.begin = async () => (calls.push("jupyter:open"), (open = true));
    jupyter.run = async () => (calls.push("jupyter:run"), { stdout: "1\n", stderr: "", exitCode: 0 });
    let focused = 0;
    const sink = { play: async () => "done", stop() {}, focus: async () => focused++ };
    const stageTutor = new Tutor({ syllabus, sink, board: new Board(), provider: "sarvam", language: "en-IN", progressFile: path.join(tmp, `stage-${Math.random()}.json`), restart: true });
    return { calls, stageTutor, focused: () => focused };
  };

  // 1. silent students: open -> run -> "is your doubt resolved?" -> 8s of silence -> VS Code closes, tab navigates back
  let st = fakeStage(parseSyllabus(stageSrc, "/x/syllabus/Python/python1.txt"));
  assert.equal(st.stageTutor.runner, "vscode");
  await st.stageTutor.run();
  assert.deepEqual(st.calls.filter((c) => !c.startsWith("plan")), ["vscode:open", "vscode:run", "close", "vscode:open", "vscode:run", "close"]);
  assert.equal(st.focused(), 2, "meeting tab shown again after each block");
  assert.ok(systemCalls.length && llmCalls.some((c) => /whether their doubt is resolved/.test(c)), "asked whether the doubt is resolved");
  console.log("✓ code stage (VS Code): run -> ask -> silence -> close + navigate");

  // 2. "not clear": the open code is explained step by step, then (after the wait) the window closes
  const before = systemCalls.length;
  st = fakeStage(parseSyllabus(stageSrc, "/x/syllabus/Python/python1.txt"), { doubt: "it is not clear" });
  await st.stageTutor.run();
  assert.ok(st.calls.some((c) => c === "plan(stage=vscode,awaiting=confirm)") || st.calls.some((c) => c.startsWith("plan(stage=vscode")), "planner knew the lesson code is open");
  assert.ok(systemCalls.slice(before).some((c) => /explain THIS code again, one line at a time/.test(c)), "walkthrough of the open code requested");
  assert.equal(st.calls.filter((c) => c === "close").length, 2, "closed after each block");
  assert.equal(st.calls.at(-1), "close");
  console.log("✓ code stage (VS Code): not clear -> step-by-step walkthrough -> close");

  // 3. AI syllabus -> Jupyter notebook
  const ai = parseSyllabus(stageSrc, "/x/syllabus/AI/ML1.txt");
  st = fakeStage(ai);
  assert.equal(st.stageTutor.runner, "jupyter");
  await st.stageTutor.run();
  assert.deepEqual(st.calls.filter((c) => !c.startsWith("plan")), ["jupyter:open", "jupyter:run", "close", "jupyter:open", "jupyter:run", "close"]);
  console.log("✓ code stage (Jupyter) for AI courses");

  // 4. runner "board" (or tools unavailable) keeps the old behaviour: no VS Code, code runs on the board
  st = fakeStage(parseSyllabus("@run: board\n" + stageSrc, "/x/syllabus/Python/python1.txt"));
  await st.stageTutor.run();
  assert.deepEqual(st.calls, []);
  console.log("✓ @run: board keeps the in-page terminal");

  console.log("\nAll tests passed.");
  process.exit(0);
})().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
