// ─── TTS / STT provider switch ───────────────────────────────────────────────
// Comment one line out and un-comment the other to switch engines.
// (Setting TUTOR_TTS_PROVIDER in the env overrides this without touching code.)
// const TTS_PROVIDER = "sarvam"; // Bulbul - understands Tamil well
const TTS_PROVIDER = "cartesia"; // Sonic - uses CARTESIA_* from the shared .env

// Speech-to-text is always Sarvam (Saaras) - see sarvam.js.
// ─────────────────────────────────────────────────────────────────────────────

const axios = require("axios");
const sarvam = require("./sarvam");

let cachedVoiceId = null;

async function cartesiaVoiceId(headers) {
  if (cachedVoiceId) return cachedVoiceId;
  const name = process.env.CARTESIA_VOICE_NAME || "Gayathri";
  const res = await axios.get("https://api.cartesia.ai/voices", { headers, params: { q: name, limit: 10 } });
  const match = res.data.data.find((v) => v.name.toLowerCase() === name.toLowerCase()) || res.data.data[0];
  if (!match) throw new Error(`No Cartesia voice found matching "${name}".`);
  return (cachedVoiceId = match.id);
}

async function cartesiaSpeak(text, languageCode) {
  if (!process.env.CARTESIA_API_KEY) throw new Error("CARTESIA_API_KEY is not set");
  const headers = { Authorization: `Bearer ${process.env.CARTESIA_API_KEY}`, "Cartesia-Version": "2026-08-14" };
  const res = await axios.post(
    "https://api.cartesia.ai/tts/bytes",
    {
      model_id: process.env.CARTESIA_MODEL || "sonic-3.6",
      transcript: text,
      voice: { id: await cartesiaVoiceId(headers), speed: 0.7 },
      // "ta-IN" -> "ta"; fall back to the shared CARTESIA_LANGUAGE.
      language: languageCode ? languageCode.split("-")[0] : process.env.CARTESIA_LANGUAGE || "ta",
      output_format: { container: "mp3", sample_rate: Number(process.env.CARTESIA_SAMPLE_RATE) || 44100 },
    },
    { headers: { ...headers, "Content-Type": "application/json" }, responseType: "arraybuffer" }
  );
  return Buffer.from(res.data);
}

function provider() {
  return (process.env.TUTOR_TTS_PROVIDER || TTS_PROVIDER).toLowerCase();
}

// Returns an mp3 Buffer.
function speak(text, languageCode) {
  return provider() === "cartesia" ? cartesiaSpeak(text, languageCode) : sarvam.speak(text, languageCode);
}

module.exports = { speak, provider };
