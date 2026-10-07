// Helpers that turn LLM output into short, speakable chunks.
function plainSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[*#_`>~|]/g, "")
    .replace(/^\s*(?:[-•]|\d+[.)])\s+/gm, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

// Short sentence groups keep each TTS call under the API limit and let a
// student's interruption take effect within a few seconds.
function toChunks(text, maxLen = 300) {
  const sentences = text.replace(/\n+/g, " ").match(/[^.!?।]+[.!?।]*\s*/g) || [text];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    if (cur && (cur + s).length > maxLen) {
      chunks.push(cur.trim());
      cur = "";
    }
    cur += s;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.flatMap((c) => (c.length > 450 ? c.match(/[\s\S]{1,400}(?:\s|$)/g).map((x) => x.trim()) : [c])).filter(Boolean);
}

module.exports = { plainSpeech, toChunks };
