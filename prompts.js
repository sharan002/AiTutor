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

// After the code was run and explained: check whether the students are fine before moving on.
function resolvedPrompt(l) {
  return [
    { role: "system", content: persona(l) },
    {
      role: "user",
      content: `You just ran the code on the shared screen and explained its output.${tail(l)}
In ONE short sentence (under 25 words) ask the students whether their doubt is resolved / everything about this code is clear, and tell them to say so if not, because you will explain it again step by step. Do not greet and do not repeat what you said.
Write in ${lang(l)}. Output only the words to be spoken.`,
    },
  ];
}

const REPLY_TAGS = ["ASK", "ANSWER", "RESOLVED", "CHAT"];

// The doubt-handling model starts its reply with a tag so the tutor knows what to do next.
function parseReply(reply) {
  const m = String(reply).match(/^\s*\[?\s*(ASK|ANSWER|RESOLVED|CHAT)\s*\]?\s*[:\-]?\s*/i);
  return m ? { tag: m[1].toUpperCase(), text: reply.slice(m[0].length) } : { tag: "CHAT", text: String(reply) };
}

function answerPrompt(l, question, context, awaiting, visual = "") {
  const history = l.qa.slice(-4).flatMap((q) => [
    { role: "user", content: q.question },
    { role: "assistant", content: q.answer },
  ]);
  const state =
    awaiting === "doubt"
      ? 'You just asked the student what their doubt is, so this message should be the doubt itself.'
      : awaiting === "confirm"
      ? "You just answered a doubt and asked whether it is resolved, so this message is probably their reply to that."
      : "The student spoke up while the class was running (or after you asked if anyone has doubts).";
  return [
    {
      role: "system",
      content: `${persona(l)}

${state} The class is currently on topic "${context.topic || l.title}".
What you were teaching right now:
${context.text ? `Notes: ${context.text.slice(0, 700)}
` : ""}${context.code ? `Code on screen (${context.lang}):
${context.code.slice(0, 700)}
` : ""}${context.output ? `Terminal shows:
${context.output.slice(0, 400)}
` : ""}
The student's words come from speech-to-text and may contain small mistakes; infer what they meant from the lesson.
Begin your reply with exactly ONE tag in square brackets (it is removed before speaking), then the spoken words:
[ASK] - the student only greeted you, called for you, or said they have a doubt/question without saying what it is ("hello", "sir", "I have a doubt", "can I ask something"). Reply in one short sentence: welcome them and ask what their doubt is. Do NOT continue the lesson.
[ANSWER] - they asked an actual doubt, or said they did NOT understand / it is NOT resolved. Answer directly and clearly (under 90 words); if they said it was not clear, explain it differently with a simpler example. ALWAYS end by asking whether the doubt is clear now / resolved.
[RESOLVED] - they confirm it is clear, say thanks, or say they have no (more) doubts. Reply in one short friendly sentence saying you will continue the class.
[CHAT] - anything else (unrelated remark, or a very brief off-topic question): answer in one or two short sentences and steer back to the class.
${visual ? `\nYou have just put this on the shared screen for the student (they see it while you speak):\n${visual}\nWhen you answer, walk through it step by step in plain spoken words ("first... then... finally..."), pointing to the screen. For this reply you may use up to 160 words instead of 90.\n` : ""}Reply in the language the student used (default ${lang(l)}).`,
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

module.exports = { LANGUAGES, openingPrompt, textPrompt, codeIntroPrompt, codeOutputPrompt, resolvedPrompt, answerPrompt, parseReply, closingPrompt };
