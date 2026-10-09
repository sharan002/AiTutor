// Syllabus parser. A syllabus is a plain .txt file:
//
//   @title: Python for Beginners        <- optional directives (before/between content)
//   @language: ta-IN                    <- teaching language (default: env SARVAM_STT_LANGUAGE)
//   @code: python                       <- default language for #code# blocks (default: from file name)
//   @run: vscode                        <- where code is executed: vscode | jupyter | board
//                                          (default: jupyter for files in an AI folder, vscode otherwise)
//   @instructions: Use real-life examples
//
//   # Variables                         <- heading = topic (1-4 leading #, then a space)
//   Plain text lines = what the trainer must teach (notes, key points).
//   #code#                              <- starts a code block (also "#code python#" / "#code:js#")
//   x = 5
//   print(x)
//   #/code#                             <- ends it ("#endcode#" or another "#code#" also work)
//
// Syllabus files can live in course folders (syllabus/Python/python1.txt, syllabus/AI/ML1.txt).
// Result: { title, course, runner, language, codeLang, instructions, blocks: [{type:'text'|'code', topic, ...}] }

const CODE_OPEN = /^\s*#code(?:[\s:]+([\w+-]+))?\s*#\s*$/i;
const CODE_CLOSE = /^\s*#\s*(?:\/code|endcode|end)\s*#\s*$/i;
const DIRECTIVE = /^@(\w+)\s*[:=]\s*(.*)$/;
const HEADING = /^#{1,4}\s+(.+?)\s*#*\s*$/;
const MAX_TEXT_WORDS = 110; // longer notes are split so each spoken block stays ~1 minute

const ALIASES = {
  py: "python", python3: "python", js: "javascript", node: "javascript", nodejs: "javascript",
  "c++": "cpp", cxx: "cpp", ts: "typescript",
};

function normLang(l) {
  const k = String(l || "").trim().toLowerCase();
  return ALIASES[k] || k;
}

// The course is the folder the syllabus sits in (inside a "syllabus" folder): syllabus/AI/ML1.txt -> "AI".
function courseOf(fileName) {
  const parts = String(fileName || "").split(/[\\/]/).filter(Boolean);
  const i = parts.lastIndexOf("syllabus");
  return i >= 0 && parts.length - i > 2 ? parts[parts.length - 2] : "";
}

function normRunner(r) {
  const k = String(r || "").trim().toLowerCase();
  if (/^(jupyter|notebook|ipynb)/.test(k)) return "jupyter";
  if (/^(vscode|vs ?code|code)$/.test(k)) return "vscode";
  if (/^(board|browser|terminal|off)$/.test(k)) return "board";
  return null;
}

const countWords = (s) => (s.match(/\S+/g) || []).length;

function pushText(blocks, topic, lines) {
  const raw = lines.join("\n").trim();
  if (!raw) return;
  const paras = raw.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  let cur = [];
  const flush = () => {
    if (cur.length) blocks.push({ type: "text", topic, text: cur.join("\n\n"), words: countWords(cur.join(" ")) });
    cur = [];
  };
  for (const p of paras) {
    if (cur.length && countWords(cur.join(" ") + " " + p) > MAX_TEXT_WORDS) flush();
    cur.push(p);
  }
  flush();
}

// ── language detection ─────────────────────────────────────────────────────────
// Native scripts map straight to a language; romanised Tamil ("Tanglish") is spotted by common words.
const SCRIPTS = [
  ["ta-IN", /[஀-௿]/g],
  ["hi-IN", /[ऀ-ॿ]/g],
  ["te-IN", /[ఀ-౿]/g],
  ["kn-IN", /[ಀ-೿]/g],
  ["ml-IN", /[ഀ-ൿ]/g],
];
const TANGLISH = new Set(
  ("la na oru panni pannum panna pannunga pannalam vaikkira vendiyadhilla vendam vendiya podhum vachu adhu idhu illa vera edhavadha nnu thaane " +
    "kandupidichukkum irukku irukkum irukkura enna ennanu inga anga nalla romba seiyalam paarunga sollunga nama naama ungalukku namakku innum ippo " +
    "epdi apdi mudiyum theriyum varum kudukkum kudutha aana aanaa pola mathiri kooda mattum ellam ellaam oru-thadava thadava").split(" ")
);

// Returns a language code ("ta-IN", ...) or null when the text is plain English / unknown.
function detectLanguage(text) {
  const s = String(text || "");
  for (const [code, re] of SCRIPTS) {
    const n = (s.match(re) || []).length;
    if (n >= 3) return code;
  }
  const words = s.toLowerCase().match(/[a-z]+/g) || [];
  const hits = words.filter((w) => TANGLISH.has(w));
  return new Set(hits).size >= 2 && hits.length / words.length >= 0.04 ? "ta-IN" : null;
}

function parseSyllabus(raw, fileName = "") {
  const lines = String(raw).replace(/^﻿/, "").replace(/\r/g, "").split("\n");
  const meta = {};
  const blocks = [];
  let topic = "";
  let text = [];
  let code = null; // { lang, lines }

  const flushText = () => {
    pushText(blocks, topic, text);
    text = [];
  };

  for (const line of lines) {
    if (code) {
      const m = line.match(CODE_OPEN);
      if (CODE_CLOSE.test(line) || (m && !m[1])) {
        const src = code.lines.join("\n").replace(/^\n+|\s+$/g, "");
        if (src) blocks.push({ type: "code", topic, lang: code.lang, code: src });
        code = null;
      } else code.lines.push(line);
      continue;
    }
    const open = line.match(CODE_OPEN);
    if (open) {
      flushText();
      code = { lang: normLang(open[1]), lines: [] };
      continue;
    }
    const dir = line.match(DIRECTIVE);
    if (dir) {
      meta[dir[1].toLowerCase()] = dir[2].trim();
      continue;
    }
    const head = line.match(HEADING);
    if (head) {
      flushText();
      topic = head[1];
      continue;
    }
    text.push(line);
  }
  if (code) {
    const src = code.lines.join("\n").replace(/^\n+|\s+$/g, "");
    if (src) blocks.push({ type: "code", topic, lang: code.lang, code: src });
  }
  flushText();

  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const course = courseOf(fileName);
  // "python1" / "python_2" -> "python"
  const runner = normRunner(meta.run || meta.runner) || normRunner(process.env.TUTOR_RUNNER) || (/^(ai|ml|data ?science|deep ?learning)$/i.test(course) ? "jupyter" : "vscode");
  // Notebooks run Python: "ML1.txt" has no language of its own.
  const codeLang = normLang(meta.code || meta.codelanguage || (runner === "jupyter" ? "python" : base.replace(/[\s_-]*\d+$/, "")));
  for (const b of blocks) if (b.type === "code") b.lang = b.lang || codeLang || "python";

  // Detected language per block (code blocks follow the notes before them); null = no detection.
  let prev = null;
  const votes = {};
  for (const b of blocks) {
    if (b.type === "text") {
      b.detectedLanguage = detectLanguage(b.text);
      prev = b.detectedLanguage;
      const k = b.detectedLanguage || "";
      votes[k] = (votes[k] || 0) + b.words;
    } else b.detectedLanguage = prev;
  }
  const dominant = Object.entries(votes).filter(([k]) => k).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const topics = [];
  blocks.forEach((b, i) => {
    b.index = i;
    if (b.topic && !topics.includes(b.topic)) topics.push(b.topic);
  });

  return {
    title: meta.title || (base ? base[0].toUpperCase() + base.slice(1) : "Programming class"),
    course,
    runner,
    language: meta.language || null,
    detectedLanguage: dominant,
    codeLang: codeLang || "python",
    instructions: meta.instructions || "",
    topics,
    blocks,
  };
}

module.exports = { parseSyllabus, normLang, detectLanguage };
