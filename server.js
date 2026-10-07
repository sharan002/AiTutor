// Tiny web server: serves the board page and takes typed questions.
const path = require("path");
const express = require("express");
const cors = require("cors");

function startServer({ board, port, onAsk, onAudioEnded }) {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "public")));

  app.get("/api/board/events", (req, res) => board.subscribe(res));
  app.post("/api/ask", (req, res) => {
    const text = String(req.body.text || "").trim();
    if (text) onAsk(text);
    res.json({ ok: !!text });
  });
  app.post("/api/start", (req, res) => {
    board.startCb?.();
    board.startCb = null;
    res.json({ ok: true });
  });
  app.post("/api/audio-ended", (req, res) => {
    onAudioEnded(req.body.id);
    res.json({ ok: true });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(server));
    server.on("error", reject);
  });
}

module.exports = { startServer };
