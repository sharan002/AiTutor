// Offline self-test (no API keys, no Meet): parser, code runner, and the teaching engine
// with a fake LLM/TTS - including a mid-lesson doubt and resuming from saved progress.
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
stub("./llm", {
  chat: async (provider, messages) => {
    const last = messages[messages.length - 1].content;
    llmCalls.push(last);
    return /doubt|why/i.test(last) && messages[0].content.includes("interrupted") ? "Great question. It is clear now. We continue." : "This is a spoken explanation. It has two sentences.";
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
  const src = fs.readFileSync(path.join(__dirname, "syllabus", "python.txt"), "utf8");
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
  console.log("\nAll tests passed.");
  process.exit(0);
})().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
