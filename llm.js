// One chat() for both providers: "sarvam" (sarvam-105b-conversations) or
// "openai" (ChatGPT). Same [{ role, content }] message shape for both.
const axios = require("axios");

function clean(text) {
  // Strip any leaked reasoning blocks so they're never spoken aloud.
  return String(text || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

async function chat(provider, messages, { maxTokens = 1500, temperature = 0.6 } = {}) {
  if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
    const res = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: process.env.OPENAI_CHAT_MODEL || "gpt-4o-mini",
        messages,
        max_tokens: maxTokens,
        temperature,
      },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    return clean(res.data.choices[0].message.content);
  }

  if (!process.env.SARVAM_API_KEY) throw new Error("SARVAM_API_KEY is not set");
  const res = await axios.post(
    "https://api.sarvam.ai/v1/chat/completions",
    {
      model: process.env.SARVAM_CHAT_MODEL || "sarvam-105b-conversations",
      messages,
      max_tokens: maxTokens,
      temperature,
      reasoning_effort: null,
    },
    { headers: { "api-subscription-key": process.env.SARVAM_API_KEY } }
  );
  return clean(res.data.choices[0].message.content);
}

module.exports = { chat };
