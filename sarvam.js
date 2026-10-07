// Sarvam STT (Saaras) + TTS (Bulbul). TTS is always Sarvam so Tamil sounds right.
const axios = require("axios");
const FormData = require("form-data");

const headers = () => ({ "api-subscription-key": process.env.SARVAM_API_KEY });

async function transcribe(buffer, filename = "audio.webm", languageCode) {
  const form = new FormData();
  form.append("file", buffer, filename);
  form.append("model", process.env.SARVAM_STT_MODEL || "saaras:v3");
  form.append("language_code", languageCode || process.env.SARVAM_STT_LANGUAGE || "ta-IN");
  form.append("mode", process.env.SARVAM_STT_MODE || "codemix");
  const res = await axios.post("https://api.sarvam.ai/speech-to-text", form, {
    headers: { ...form.getHeaders(), ...headers() },
    maxBodyLength: Infinity,
  });
  return res.data.transcript || "";
}

// Returns an mp3 Buffer.
async function speak(text, languageCode) {
  const res = await axios.post(
    "https://api.sarvam.ai/text-to-speech",
    {
      text,
      language_code: languageCode || process.env.SARVAM_STT_LANGUAGE || "ta-IN",
      model: process.env.SARVAM_TTS_MODEL || "bulbul:v3",
      speaker: process.env.SARVAM_TTS_SPEAKER || "kavitha",
      speech_sample_rate: Number(process.env.SARVAM_TTS_SAMPLE_RATE) || 22050,
      output_audio_codec: "mp3",
    },
    { headers: { ...headers(), "Content-Type": "application/json" } }
  );
  return Buffer.from(res.data.audios[0], "base64");
}

module.exports = { transcribe, speak };
