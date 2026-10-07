const LANGUAGES = {
  "ta-IN": "Tamil (தமிழ்) - write in Tamil script, simple spoken Tamil, with technical terms and code keywords left in English words",
  "en-IN": "English",
  "hi-IN": "Hindi (हिन्दी) - write in Devanagari script, with technical terms and code keywords left in English words",
  "te-IN": "Telugu (తెలుగు) - write in Telugu script, with technical terms and code keywords left in English words",
  "kn-IN": "Kannada (ಕನ್ನಡ) - write in Kannada script, with technical terms and code keywords left in English words",
  "ml-IN": "Malayalam (മലയാളം) - write in Malayalam script, with technical terms and code keywords left in English words",
};

const SPOKEN_RULES = `Your text is read aloud by a text-to-speech voice, so write ONLY plain spoken sentences:
no markdown, no bullet points, no numbered lists, no headings, no emojis, no code blocks, no symbols like * # - _ ; no raw code.
Never read code character by character. Describe it in words and name keywords and functions naturally (for example "the print function", "a for loop", "x equals five").`;

const lang = (l) => LANGUAGES[l.language] || l.language;

function persona(l) {
  return `You are a friendly, patient programming trainer teaching a live class on Google Meet while sharing your screen.
The shared screen shows the lesson notes, a code editor and a terminal; students only HEAR you, so refer to the screen naturally ("as you can see on the screen").
Course: "${l.title}". Teaching language: ${lang(l)}.
${l.instructions ? `Trainer's instructions: ${l.instructions}\n` : ""}${SPOKEN_RULES}`;
}

const tail = (l) => (l.lastSpoken ? `\nWhat you said just before (continue naturally; do NOT greet again or repeat it):\n"${l.lastSpoken.slice(-500)}"\n` : "");
const doubtLine = (l, endOfTopic) =>
  endOfTopic ? `\nThis finishes the topic "${endOfTopic}": end by briefly asking if anyone has any doubts, then say you are happy to wait.` : "\nDo not wrap up the topic; more material follows.";

function openingPrompt(l, { resuming, lastTopic, nextTopic }) {
  return [
    { role: "system", content: persona(l) },
    {
      role: "user",
      content: resuming
        ? `Welcome the class back in 2-3 short sentences. Last time you covered "${lastTopic || "the earlier topics"}"; today you continue with "${nextTopic}". Say they can interrupt any time with doubts. About 50 words.`
        : `Greet the class and introduce today's course "${l.title}" in 3-4 short sentences. Say they can interrupt any time with doubts, then say you are starting with "${nextTopic}". About 60 words.`,
    },
  ];
}

function textPrompt(l, block, { endOfTopic } = {}) {
  const words = Math.min(300, Math.max(70, block.words * 3));
  return [
    { role: "system", content: persona(l) },
    {
      role: "user",
      content: `Topic: "${block.topic || l.title}".
Teach the following syllabus notes to the class. Stay within this material, but make it easy to follow: plain explanation, a small relatable analogy or example if it helps. The notes:
"""
${block.text}
"""
${tail(l)}Length: about ${words} words.${doubtLine(l, endOfTopic)}
Write the whole thing in ${lang(l)}. Output only the words to be spoken.`,
    },
  ];
}

function codeIntroPrompt(l, block) {
  const words = Math.min(260, Math.max(60, block.code.split("\n").length * 22));
  return [
    { role: "system", content: persona(l) },
    {
      role: "user",
      content: `Topic: "${block.topic || l.title}". The following ${block.lang} code has just been typed into the editor on the shared screen:
"""
${block.code}
"""
${tail(l)}Walk the students through it in order: what each part does and why, in plain spoken words (never read symbols one by one). Finish by saying you will run it now.
Length: about ${words} words. Write in ${lang(l)}. Output only the words to be spoken.`,
    },
  ];
}

function codeOutputPrompt(l, block, result, { endOfTopic } = {}) {
  const out = result.stdout.trim() || "(no output)";
  const err = result.stderr.trim();
  return [
    { role: "system", content: persona(l) },
    {
      role: "user",
      content: `You just ran this ${block.lang} code:
"""
${block.code}
"""
The terminal on the shared screen shows:
OUTPUT:
${out.slice(0, 1500)}
${err ? `ERRORS:\n${err.slice(0, 1000)}\n` : ""}Exit code: ${result.exitCode}${result.timedOut ? " (it was stopped for running too long)" : ""}.
Explain the result in plain spoken words: how the output comes from the code. ${err ? "There is an error: explain calmly what it means and how to fix it." : ""}
Length: about 50-90 words.${doubtLine(l, endOfTopic)}
Write in ${lang(l)}. Output only the words to be spoken.`,
    },
  ];
}

function answerPrompt(l, question, context) {
  const history = l.qa.slice(-4).flatMap((q) => [
    { role: "user", content: q.question },
    { role: "assistant", content: q.answer },
  ]);
  return [
    {
      role: "system",
      content: `${persona(l)}

A student interrupted the class with a doubt. The class is currently on topic "${context.topic || l.title}".
What you were teaching right now:
${context.text ? `Notes: ${context.text.slice(0, 700)}\n` : ""}${context.code ? `Code on screen (${context.lang}):\n${context.code.slice(0, 700)}\n` : ""}${context.output ? `Terminal shows:\n${context.output.slice(0, 400)}\n` : ""}
Answer the doubt directly and clearly (under 130 words), in the same language the student used (default ${lang(l)}). Use a tiny example in words if useful. If it is unrelated to programming or the class, answer very briefly and steer back. Always end by asking if it is clear and saying you will continue.`,
    },
    ...history,
    { role: "user", content: question },
  ];
}

function closingPrompt(l) {
  return [
    { role: "system", content: persona(l) },
    { role: "user", content: `The syllabus is finished. Give a short recap of what was covered (topics: ${l.topics.join(", ") || l.title}), encourage the students to practise, and say goodbye. About 60 words. Write in ${lang(l)}.` },
  ];
}

module.exports = { LANGUAGES, openingPrompt, textPrompt, codeIntroPrompt, codeOutputPrompt, answerPrompt, closingPrompt };
