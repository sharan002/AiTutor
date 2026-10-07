// Syllabus parser. A syllabus is a plain .txt file:
//
//   @title: Python for Beginners        <- optional directives (before/between content)
//   @language: ta-IN                    <- teaching language (default: env SARVAM_STT_LANGUAGE)
//   @code: python                       <- default language for #code# blocks (default: from file name)
//   @instructions: Use real-life examples
//
//   # Variables                         <- heading = topic (1-4 leading #, then a space)
//   Plain text lines = what the trainer must teach (notes, key points).
//   #code#                              <- starts a code block (also "#code python#" / "#code:js#")
//   x = 5
//   print(x)
//   #/code#                             <- ends it ("#endcode#" or another "#code#" also work)
//
// Result: { title, language, codeLang, instructions, blocks: [{type:'text'|'code', topic, ...}] }

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
  const codeLang = normLang(meta.code || meta.codelanguage || base);
  for (const b of blocks) if (b.type === "code") b.lang = b.lang || codeLang || "python";

  const topics = [];
  blocks.forEach((b, i) => {
    b.index = i;
    if (b.topic && !topics.includes(b.topic)) topics.push(b.topic);
  });

  return {
    title: meta.title || (base ? base[0].toUpperCase() + base.slice(1) : "Programming class"),
    language: meta.language || null,
    codeLang: codeLang || "python",
    instructions: meta.instructions || "",
    topics,
    blocks,
  };
}

module.exports = { parseSyllabus, normLang };
