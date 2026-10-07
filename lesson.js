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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DOUBT_WAIT_MS = (Number(process.env.TUTOR_DOUBT_WAIT_SEC) || 8) * 1000;
const TYPE_MS_PER_CHAR = 30;

class Tutor {
  constructor({ syllabus, sink, board, provider, language, progressFile, restart }) {
    this.syllabus = syllabus;
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
    this.aborted = false;
    this._ttsFails = 0;
    this.scripts = new Map();
    this.current = {}; // what's on screen right now (context for doubts)
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
  // Someone started talking in the meeting: stop immediately and wait for the transcript.
  onVoiceStart() {
    this.sink.stop();
    if (this.hold) return;
    this.hold = new Promise((r) => (this.releaseHold = r));
    this.holdTimer = setTimeout(() => this.release(), 30000);
  }
  release() {
    clearTimeout(this.holdTimer);
    const r = this.releaseHold;
    this.hold = null;
    r?.();
  }
  async onSpeech(buffer, filename = "speech.wav") {
    let text = "";
    try {
      text = (await transcribe(buffer, filename, process.env.SARVAM_STT_LANGUAGE)).trim();
    } catch (e) {
      console.error("stt error:", e.response?.data || e.message);
    }
    // Ignore noise / one-word fragments.
    if (text.replace(/[^\p{L}\p{N}]/gu, "").length >= 4) {
      console.log(`❓ heard: ${text}`);
      this.questions.push(text);
    }
    this.release();
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
  // interrupted chunk. retry=false: an answer - if interrupted, just stop.
  async speak(chunks, { retry = true } = {}) {
    const audio = new Map();
    const get = (i) => {
      if (i < chunks.length && !audio.has(i)) audio.set(i, tts.speak(chunks[i], this.lesson.language));
      return audio.get(i);
    };
    for (let i = 0; i < chunks.length && !this.aborted; ) {
      await this.hold;
      if (retry && this.questions.length) await this.drain();
      if (this.hold || this.aborted) continue;
      get(i + 1); // prefetch the next chunk's audio
      let mp3;
      try {
        mp3 = await get(i);
      } catch (e) {
        console.error("tts error:", e.response?.data || e.message);
        audio.delete(i);
        if (++this._ttsFails > 3) return;
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
      } else if (!retry) return;
    }
  }

  // Answer every queued doubt.
  async drain() {
    while (!this.aborted) {
      await this.hold;
      const q = this.questions.shift();
      if (!q) return;
      this.board.set("ask", { q, at: Date.now() });
      let answer;
      try {
        answer = plainSpeech(await chat(this.lesson.provider, P.answerPrompt(this.lesson, q, this.current), { maxTokens: 700 }));
      } catch (e) {
        console.error("answer error:", e.response?.data || e.message);
        continue;
      }
      this.lesson.qa.push({ question: q, answer });
      await this.speak(toChunks(answer), { retry: false });
      this.board.set("ask", null);
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
  script(i) {
    if (!this.scripts.has(i)) {
      const b = this.syllabus.blocks[i];
      const endOfTopic = this.endsTopic(i) ? b.topic || this.lesson.title : null;
      const messages = b.type === "text" ? P.textPrompt(this.lesson, b, { endOfTopic }) : P.codeIntroPrompt(this.lesson, b);
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
    this.current = { topic: b.topic, text: b.text };
    this.board.set("code", null);
    this.board.set("output", null);
    this.showSection(b);
    const text = await this.script(b.index);
    await this.speak(toChunks(text));
  }

  async teachCode(b) {
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
