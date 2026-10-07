// Preview-mode audio sink: the board page itself plays the speech (open /?local=1).
class BoardSink {
  constructor(board) {
    this.board = board;
    this.pending = null;
    this.n = 0;
  }
  play(mp3) {
    this.stop();
    const id = ++this.n;
    this.board.emit("audio", { id, b64: mp3.toString("base64") });
    return new Promise((resolve) => (this.pending = { id, resolve }));
  }
  ended(id) {
    if (this.pending && this.pending.id === id) {
      this.pending.resolve("done");
      this.pending = null;
    }
  }
  stop() {
    if (!this.pending) return;
    this.board.emit("audio-stop", {});
    this.pending.resolve("stopped");
    this.pending = null;
  }
}

module.exports = { BoardSink };
