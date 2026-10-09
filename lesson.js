// The trainer: walks through the syllabus block by block, speaks, types + runs code
// on the board, and handles student doubts (pause -> answer -> resume).
//
// `sink` is where audio goes: { play(mp3Buffer) -> "done"|"stopped", stop() }
//   - MeetSink (meet.js): into the Google Meet microphone
//   - BoardSink (sinks.js): played in the browser board page (preview mode)
const fs = require("fs");
const path = require("path");
const { chat } = require("./llm");
const { transcribe } = require("./sarvam");
const tts = require("./tts");
const { runCode } = require("./runner");
const { plainSpeech, toChunks } = require("./speech");
const P = require("./prompts");
const tools = require("./tools");
const jupyter = require("./jupyter");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOUBT_WAIT_MS = (Number(process.env.TUTOR_DOUBT_WAIT_SEC) || 8) * 1000;
const TYPE_MS_PER_CHAR = 30;
// After the student stops talking, wait this long for more speech before treating it as one finished question.
const SETTLE_MS = Number(process.env.TUTOR_SETTLE_MS) || 700;
// After "what is your doubt?" / "is it clear?", how long to wait for the student's reply.
const AIDS_CLOSE_MS = (Number(process.env.TUTOR_AIDS_CLOSE_SEC) || 8) * 1000;
const STAGE_DOUBT_WAIT_MS = (Number(process.env.TUTOR_STAGE_DOUBT_WAIT_SEC) || 10) * 1000; // VS Code / Jupyter stays open this long for doubts
const FOLLOWUP_MS = (Number(process.env.TUTOR_FOLLOWUP_WAIT_SEC) || 15) * 1000;

class Tutor {
  constructor({ syllabus, sink, board, provider, language, autoLanguage = false, progressFile, restart }) {
    this.syllabus = syllabus;
    this.autoLanguage = autoLanguage;
    this.baseLanguage = language;
    this.sink = sink;
    this.board = board;
    this.progressFile = progressFile;
    this.lesson = {
      title: syllabus.title,
      topics: syllabus.topics,
      instructions: syllabus.instructions,
      language,
      provider,
      qa: [],
      lastSpoken: "",
    };
    this.pos = restart ? 0 : this.loadProgress();
    this.questions = [];
    this.hold = null; // Promise while a student is speaking / being transcribed
    this.pending = 0; // utterances detected but not yet transcribed
    this.partial = ""; // transcribed text of the question being spoken (may span several utterances)
    this.awaiting = null; // null | "doubt" (asked what the doubt is) | "confirm" (asked if it is resolved)
    this.aborted = false;
    this._ttsFails = 0;
    this.scripts = new Map();
    this.current = {}; // what's on screen right now (context for doubts)
    // Where syllabus code is shown and run: "vscode" | "jupyter" | "board" (the old in-page terminal).
    this.runner = syllabus.runner || "vscode";
    tools.setRunner(this.runner);
  }

  // ── progress (resume where the last class stopped) ─────────────────────────
  loadProgress() {
    try {
      const p = JSON.parse(fs.readFileSync(this.progressFile, "utf8"));
      return Math.min(Math.max(Number(p.pos) || 0, 0), this.syllabus.blocks.length);
    } catch {
      return 0;
    }
  }
  saveProgress() {
    fs.mkdirSync(path.dirname(this.progressFile), { recursive: true });
    const done = this.syllabus.blocks[this.pos - 1];
    fs.writeFileSync(
      this.progressFile,
      JSON.stringify({ pos: this.pos, total: this.syllabus.blocks.length, lastTopic: done?.topic || "", updated: new Date().toISOString() }, null, 2)
    );
  }
  lastTopic() {
    try {
      return JSON.parse(fs.readFileSync(this.progressFile, "utf8")).lastTopic || "";
    } catch {
      return "";
    }
  }

  // ── student input ───────────────────────────────────────────────────────────
  // Someone started talking in the meeting: stop immediately and hold the lesson until every
  // utterance is transcribed and the student has finished (pauses mid-sentence are merged).
  onVoiceStart() {
    this.sink.stop();
    clearTimeout(this.settleTimer);
    this.pending++;
    if (!this.hold) this.hold = new Promise((r) => (this.releaseHold = r));
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => {
      this.pending = 0;
      this.flush();
    }, 30000);
  }
  flush() {
    if (this.partial) this.questions.push(this.partial);
    this.partial = "";
    this.release();
  }
  release() {
    clearTimeout(this.holdTimer);
    clearTimeout(this.settleTimer);
    const r = this.releaseHold;
    this.hold = null;
    r?.();
  }
  async onSpeech(buffer, filename = "speech.wav") {
    let text = "";
    for (let attempt = 0; attempt < 2 && !text; attempt++) {
      try {
        text = (await transcribe(buffer, filename, this.lesson.language)).trim();
        break;
      } catch (e) {
        console.error("stt error:", e.response?.data || e.message);
      }
    }
    this.pending = Math.max(0, this.pending - 1);
    // Ignore noise, but keep short replies like "yes" / "no".
    if (text.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) {
      console.log(`❓ heard: ${text}`);
      this.partial = `${this.partial} ${text}`.trim();
    }
    if (this.pending === 0) {
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.flush(), SETTLE_MS);
    }
  }
  onQuestion(text) {
    console.log(`❓ typed: ${text}`);
    this.questions.push(text);
    this.sink.stop();
  }
  abort() {
    this.aborted = true;
    this.sink.stop();
    this.release();
  }

  // ── speaking ────────────────────────────────────────────────────────────────
  // retry=true: lesson speech - if interrupted, answer the doubt, then replay the
  // interrupted chunk. retry=false: an answer - if interrupted, wait for the student;
  // a new question takes over, otherwise (just noise) the chunk is replayed.
  // Returns true if everything was spoken.
  async speak(chunks, { retry = true } = {}) {
    const audio = new Map();
    const get = (i) => {
      if (i < chunks.length && !audio.has(i)) audio.set(i, tts.speak(chunks[i], this.lesson.language));
      return audio.get(i);
    };
    for (let i = 0; i < chunks.length && !this.aborted; ) {
      await this.hold;
      if (!retry && this.questions.length) return false;
      if (retry && this.questions.length) await this.drain();
      if (this.hold || this.aborted) continue;
      get(i + 1); // prefetch the next chunk's audio
      let mp3;
      try {
        mp3 = await get(i);
      } catch (e) {
        console.error("tts error:", e.response?.data || e.message);
        audio.delete(i);
        if (++this._ttsFails > 3) return false;
        await sleep(1500);
        continue;
      }
      this._ttsFails = 0;
      if (this.hold) continue;
      this.board.set("caption", chunks[i]);
      const r = await this.sink.play(mp3);
      if (r === "done") {
        i++;
        this.lesson.lastSpoken = chunks[i - 1];
      }
    }
    return !this.aborted;
  }

  // Wait for the student to reply to "what is your doubt?" / "is it clear?".
  async waitForStudent(ms = FOLLOWUP_MS) {
    const end = Date.now() + ms;
    while (Date.now() < end && !this.aborted && !this.hold && !this.questions.length) await sleep(200);
    await this.hold;
  }

  // Answer every queued doubt, one at a time, in the order asked.
  async drain() {
    while (!this.aborted) {
      await this.hold;
      const q = this.questions.shift();
      if (!q) return;
      this.board.set("ask", { q, at: Date.now() });
      let reply;
      // Agent mode: for "explain step by step" / "not clear" doubts, pick visual aids (a VS Code example that is
      // run, a Paint diagram). They open now and are closed again once the explanation is spoken.
      const onStage = tools.isOpen() ? this.current.stage : null; // lesson code currently open in VS Code / Jupyter
      const actions = await tools.plan(this.lesson.provider, this.lesson.language, q, { ...this.current, stage: onStage, awaiting: this.awaiting });
      let shown = actions.length ? await tools.execute(actions) : "";
      if (shown) this.current.stage = null; // a new example replaced the lesson code on screen
      else if (actions.walkthrough && onStage) {
        // "Not resolved": explain the code that is already open, step by step.
        const c = this.current;
        c.walked = (c.walked || 0) + 1;
        shown = `${onStage === "jupyter" ? "A Jupyter notebook" : "VS Code"} is open on the shared screen with this ${c.lang} code, which was already run:\n${String(c.code).slice(0, 1200)}\nIts output:\n${String(c.output || "(no output)").slice(0, 500)}\n(The student did not understand it: explain THIS code again, one line at a time, in simpler words.)`;
      }
      if (shown) this.lastShown = { text: shown, at: Date.now() };
      // Follow-up doubts ("what does line 3 do?") are answered from the last code / diagram shown.
      const earlier = !shown && this.lastShown && Date.now() - this.lastShown.at < 10 * 60 * 1000 ? this.lastShown.text : "";
      const closeAids = async () => {
        this.current.stage = null;
        if (await tools.close()) await this.sink.focus?.(); // back to the meeting tab
      };
      // The aids (VS Code / Paint) stay open while the student keeps asking about them.
      const aidsOpen = () => tools.isOpen();
      try {
        reply = await chat(this.lesson.provider, P.answerPrompt(this.lesson, q, this.current, this.awaiting, shown || (earlier && `(shown to the student a little earlier - answer follow-up doubts about it using exactly this)\n${earlier}`)), {
          maxTokens: shown ? 700 : 450,
        });
      } catch (e) {
        console.error("answer error:", e.response?.data || e.message);
        await closeAids();
        continue;
      }
      // The student said more while we were thinking: answer it all together, not a stale reply.
      await this.hold;
      if (this.questions.length) {
        this.questions[0] = `${q} ${this.questions[0]}`;
        continue;
      }
      const { tag, text } = P.parseReply(reply);
      const answer = plainSpeech(text);
      if (!answer) {
        await closeAids();
        continue;
      }
      this.awaiting = tag === "ASK" ? "doubt" : tag === "ANSWER" ? "confirm" : null;
      if (tag === "ANSWER" || tag === "CHAT") this.lesson.qa.push({ question: q, answer });
      const done = await this.speak(toChunks(answer), { retry: false });
      // Keep the demo window open while the tutor asks "is it clear?" and wait AIDS_CLOSE_MS for a reply.
      // A further doubt keeps it open (answered next round); "ok / yes / no doubt" (RESOLVED), silence or
      // an unrelated remark closes it and the lesson carries on.
      let kept = false;
      if (aidsOpen() && !this.stageOpen) { // while a code stage waits for doubts, teachCodeOnStage decides when to close
        if (this.awaiting && !this.questions.length) await this.waitForStudent(AIDS_CLOSE_MS);
        kept = this.awaiting && this.questions.length > 0;
        if (!kept) await closeAids();
      }
      this.board.set("ask", null);
      if (kept) continue;
      if (done && this.awaiting) {
        if (!shown) await this.waitForStudent();
        // No reply: treat the doubt as resolved and carry on with the lesson.
        if (!this.questions.length) this.awaiting = null;
      } else if (!done && !this.questions.length) {
        this.awaiting = null;
      }
    }
  }

  // After a topic, leave a short window for doubts.
  async doubtWindow() {
    const end = Date.now() + DOUBT_WAIT_MS;
    while (Date.now() < end && !this.aborted) {
      await sleep(250);
      if (this.hold || this.questions.length) {
        await this.hold;
        await this.drain();
        return;
      }
    }
  }

  // ── LLM scripts (prefetched one block ahead) ───────────────────────────────
  // Language a block is taught in: its detected language (Tamil / Tanglish / ...) unless --lang was forced.
  langOf(b) {
    return (this.autoLanguage && b.detectedLanguage) || this.baseLanguage;
  }
  script(i) {
    if (!this.scripts.has(i)) {
      const b = this.syllabus.blocks[i];
      const endOfTopic = this.endsTopic(i) ? b.topic || this.lesson.title : null;
      const l = { ...this.lesson, language: this.langOf(b) };
      const messages = b.type === "text" ? P.textPrompt(l, b, { endOfTopic }) : P.codeIntroPrompt(l, b);
      const fallback = b.type === "text" ? b.text : "";
      this.scripts.set(i, this.generate(messages, fallback));
    }
    return this.scripts.get(i);
  }
  async generate(messages, fallback, maxTokens = 1800) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = plainSpeech(await chat(this.lesson.provider, messages, { maxTokens }));
        if (text) return text;
      } catch (e) {
        console.error("llm error:", e.response?.data || e.message);
      }
    }
    return plainSpeech(fallback);
  }
  endsTopic(i) {
    const next = this.syllabus.blocks[i + 1];
    return !next || next.topic !== this.syllabus.blocks[i].topic;
  }

  // ── teaching ────────────────────────────────────────────────────────────────
  showSection(b) {
    const idx = this.lesson.topics.indexOf(b.topic);
    this.board.set("section", {
      topic: b.topic || this.lesson.title,
      topicNo: idx + 1,
      topicTotal: this.lesson.topics.length,
      text: b.type === "text" ? b.text : "",
      progress: `${b.index + 1} / ${this.syllabus.blocks.length}`,
    });
  }

  async teachText(b) {
    this.lesson.language = this.langOf(b); // used by TTS, STT and doubt answers while this block plays
    this.current = { topic: b.topic, text: b.text };
    this.board.set("code", null);
    this.board.set("output", null);
    this.showSection(b);
    const text = await this.script(b.index);
    await this.speak(toChunks(text));
  }

  // Shows the syllabus code in VS Code (or a Jupyter notebook for AI classes). Returns "vscode" | "jupyter",
  // or null when that is not possible (runner "board", tools off, not installed): the board terminal is used then.
  async openStage(b) {
    if (this.runner === "board" || !tools.enabled()) return null;
    try {
      if (this.runner === "jupyter") {
        if (b.lang !== "python" || !(await jupyter.available())) {
          if (!this._jupyterWarned) console.warn("⚠️  Jupyter not available (pip install notebook nbconvert ipykernel) - running code on the board instead.");
          this._jupyterWarned = true;
          return null;
        }
        await jupyter.begin({ code: b.code, topic: b.topic, title: b.topic });
        return "jupyter";
      }
      await tools.openLesson({ code: b.code, language: b.lang, title: b.topic });
      return "vscode";
    } catch (e) {
      console.error("code stage unavailable, using the board:", e.message);
      return null;
    }
  }

  // Close VS Code / the notebook and bring the meeting tab back to the front.
  async closeStage() {
    this.current.stage = null;
    if (await tools.close()) await this.sink.focus?.();
  }

  // Syllabus code on the "stage": shown in VS Code / Jupyter -> explained -> run there -> outcome explained ->
  // "is your doubt resolved?" (DOUBT_WAIT_MS) -> a doubt gets a step-by-step walkthrough or a new similar example
  // (drain) -> VS Code / Jupyter is closed and the Meet tab is shown again.
  async teachCodeOnStage(b, kind) {
    this.lesson.language = this.langOf(b);
    this.current = { ...this.current, topic: b.topic, code: b.code, lang: b.lang, output: "", stage: kind, walked: 0 };
    this.showSection({ ...b, text: "" });
    this.board.set("output", null);
    this.board.set("code", { lang: b.lang, code: b.code, typeMs: Math.min(TYPE_MS_PER_CHAR * b.code.length, 7000), id: Date.now() });
    const intro = this.script(b.index); // generated while the code is on screen
    await sleep(800);
    await this.speak(toChunks(await intro));

    // A doubt during the explanation may have closed or replaced the window: put the lesson code back before running.
    if (!tools.isOpen() || !this.current.stage) kind = await this.openStage(b);
    this.current.stage = kind;
    this.board.set("output", { running: true });
    console.log(`▶️  running ${b.lang} code in ${kind || "the board"} (${b.code.split("\n").length} lines)`);
    const result = kind === "jupyter" ? await jupyter.run() : kind === "vscode" ? await tools.runLesson(b.lang, b.code) : await runCode(b.lang, b.code);
    this.board.set("output", { ...result, running: false });
    this.current.output = (result.stdout + result.stderr).trim();
    await sleep(600);

    const endOfTopic = this.endsTopic(b.index) ? b.topic || this.lesson.title : null;
    const outro = await this.generate(P.codeOutputPrompt(this.lesson, b, result, { endOfTopic }), "", 900);
    if (outro) await this.speak(toChunks(outro));
    if (!kind) return;

    // "Is your doubt resolved?" - a topic's last block already ended with a doubt question.
    if (!endOfTopic && !this.questions.length && !this.hold) {
      const ask = await this.generate(P.resolvedPrompt(this.lesson), "Is your doubt resolved? Please tell me if anything is not clear.", 200);
      this.awaiting = "confirm";
      await this.speak(toChunks(ask), { retry: false });
    }
    this.awaiting = "confirm";
    // Stay on VS Code / Jupyter for 10s; every doubt asked is answered (and the window waits another 10s after each
    // answer) - it closes only after the student has been silent for the full wait.
    this.stageOpen = true;
    try {
      await this.waitForStudent(STAGE_DOUBT_WAIT_MS);
      while (this.questions.length && !this.aborted) {
        await this.drain();
        await this.waitForStudent(STAGE_DOUBT_WAIT_MS);
      }
    } finally {
      this.stageOpen = false;
    }
    if (!this.questions.length) this.awaiting = null; // silence = resolved
    await this.closeStage();
  }

  async teachCode(b) {
    const stage = await this.openStage(b);
    if (stage) return this.teachCodeOnStage(b, stage);
    this.lesson.language = this.langOf(b);
    this.current = { ...this.current, topic: b.topic, code: b.code, lang: b.lang, output: "" };
    this.showSection({ ...b, text: "" });
    this.board.set("output", null);
    const typeMs = Math.min(TYPE_MS_PER_CHAR * b.code.length, 7000);
    this.board.set("code", { lang: b.lang, code: b.code, typeMs, id: Date.now() });
    const intro = this.script(b.index); // generated while the code is being typed
    await sleep(typeMs + 400);
    await this.speak(toChunks(await intro));

    // Run it on screen.
    this.board.set("output", { running: true });
    console.log(`▶️  running ${b.lang} code (${b.code.split("\n").length} lines)`);
    const result = await runCode(b.lang, b.code);
    this.board.set("output", { ...result, running: false });
    this.current.output = (result.stdout + result.stderr).trim();
    await sleep(600);

    const endOfTopic = this.endsTopic(b.index) ? b.topic || this.lesson.title : null;
    const outro = await this.generate(P.codeOutputPrompt(this.lesson, b, result, { endOfTopic }), "", 900);
    if (outro) await this.speak(toChunks(outro));
  }

  async run() {
    const { blocks } = this.syllabus;
    if (!blocks.length) throw new Error("The syllabus has no content.");
    const resuming = this.pos > 0 && this.pos < blocks.length;
    if (this.pos >= blocks.length) {
      console.log("Syllabus already finished. Use --restart to teach it again.");
      return;
    }
    this.board.set("lesson", { title: this.lesson.title, topics: this.lesson.topics });
    console.log(`🎓 ${this.lesson.title}: ${resuming ? `resuming at block ${this.pos + 1}/${blocks.length}` : "starting from the beginning"}`);

    this.board.set("caption", "");
    this.showSection(blocks[this.pos]);
    this.script(this.pos); // warm up while greeting
    const opening = await this.generate(
      P.openingPrompt(this.lesson, { resuming, lastTopic: this.lastTopic(), nextTopic: blocks[this.pos].topic || this.lesson.title }),
      `Hello everyone, welcome to ${this.lesson.title}.`,
      500
    );
    await this.speak(toChunks(opening));

    while (this.pos < blocks.length && !this.aborted) {
      const b = blocks[this.pos];
      if (this.pos + 1 < blocks.length && blocks[this.pos + 1].type === "text") this.script(this.pos + 1);
      console.log(`📖 [${this.pos + 1}/${blocks.length}] ${b.topic || ""} (${b.type})`);
      if (b.type === "text") await this.teachText(b);
      else await this.teachCode(b);
      if (this.aborted) break;
      if (this.endsTopic(b.index)) await this.doubtWindow();
      await this.drain();
      this.pos++;
      this.saveProgress();
    }
    if (this.aborted) return;

    const closing = await this.generate(P.closingPrompt(this.lesson), "Thank you everyone, see you in the next class.", 500);
    await this.speak(toChunks(closing));
    await this.doubtWindow();
    this.board.set("caption", "Class finished");
    console.log("✅ Syllabus finished.");
  }
}

module.exports = { Tutor };
