// CLI:
//   node index.js meet    <meet-url> <syllabus> [--restart] [--lang ta-IN] [--provider sarvam|openai]
//   node index.js preview <syllabus> [...]      (no Meet: open http://localhost:7100/?local=1)
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
if (fs.existsSync(path.join(__dirname, ".env"))) dotenv.config({ path: path.join(__dirname, ".env") });
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const { parseSyllabus } = require("./syllabus");
const { Board } = require("./board");
const { startServer } = require("./server");
const { Tutor } = require("./lesson");
const { BoardSink } = require("./sinks");
const { LANGUAGES } = require("./prompts");

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      flags[k] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    } else pos.push(argv[i]);
  }
  return { flags, pos };
}

function findSyllabus(name) {
  const tries = [name, path.join(__dirname, name), path.join(__dirname, "syllabus", name), path.join(__dirname, "syllabus", name + ".txt")];
  const hit = tries.find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
  if (!hit) throw new Error(`Syllabus not found: ${name} (looked in ./ and ./syllabus/)`);
  return hit;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const { flags, pos } = parseArgs(rest);
  if (!["meet", "preview"].includes(mode)) {
    console.log("Usage:\n  npm run teach -- <meet-url> <syllabus.txt> [--restart]\n  npm run preview -- <syllabus.txt> [--restart]");
    process.exit(1);
  }
  const url = mode === "meet" ? pos[0] : null;
  const file = findSyllabus(mode === "meet" ? pos[1] : pos[0]);
  if (mode === "meet" && !/^https:\/\/meet\.google\.com\/[a-z-]+/i.test(url || "")) throw new Error("First argument must be a https://meet.google.com/xxx-xxxx-xxx link.");

  const syllabus = parseSyllabus(fs.readFileSync(file, "utf8"), file);
  const language = flags.lang || syllabus.language || process.env.SARVAM_STT_LANGUAGE || "ta-IN";
  if (!LANGUAGES[language]) console.warn(`⚠️  Unknown language "${language}" - the LLM will be told to use it as-is.`);
  const provider = flags.provider || process.env.TUTOR_LLM_PROVIDER || "sarvam";
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const progressFile = path.join(__dirname, "progress", `${base}.json`);

  const board = new Board();
  const port = Number(process.env.TUTOR_PORT) || 7100;
  const boardSink = new BoardSink(board);
  let tutor;
  await startServer({
    board,
    port,
    onAsk: (t) => tutor?.onQuestion(t),
    onAudioEnded: (id) => boardSink.ended(id),
  });
  console.log(`📋 Board: http://localhost:${port}/  |  syllabus: ${path.relative(__dirname, file)} (${syllabus.blocks.length} blocks, ${syllabus.topics.length} topics)`);

  let meet = null;
  let sink = boardSink;
  if (mode === "meet") {
    const { MeetSession } = require("./meet");
    meet = new MeetSession({ boardUrl: `http://localhost:${port}/` });
    sink = meet;
    await meet.launch();
  }

  tutor = new Tutor({ syllabus, sink, board, provider, language, progressFile, restart: !!flags.restart });

  if (meet) {
    meet.on("voice", () => tutor.onVoiceStart());
    meet.on("speech", (buf) => tutor.onSpeech(buf));
    meet.on("ended", () => {
      console.log("Meeting ended - stopping. Progress is saved; run again to continue.");
      tutor.abort();
    });
    await meet.join(url);
    await meet.share();
  } else {
    console.log(`Open http://localhost:${port}/?local=1 in Chrome and click "Start" to hear the lesson.`);
    await new Promise((resolve) => board.waitStart(resolve));
  }

  process.on("SIGINT", async () => {
    console.log("\nStopping... progress is saved after each completed block.");
    tutor.abort();
    if (meet) await meet.leave();
    process.exit(0);
  });

  await tutor.run();
  if (meet) await meet.leave();
  process.exit(0);
}

main().catch((e) => {
  console.error("❌", e.response?.data || e.message);
  process.exit(1);
});
