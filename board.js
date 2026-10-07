// The "board": state shown on the shared screen (notes, code, terminal, caption).
// The board page (public/) subscribes over Server-Sent Events.
class Board {
  constructor() {
    this.clients = new Set();
    this.state = {};
    this.endedHandlers = new Map();
  }

  // Preview mode: resolve once the page's Start button is clicked (needed for audio autoplay).
  waitStart(cb) {
    this.startCb = cb;
  }

  // Persistent state (replayed to a page that connects late).
  set(type, data) {
    this.state[type] = data;
    this.emit(type, data);
  }

  // One-shot event (not replayed).
  emit(type, data) {
    const msg = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of this.clients) res.write(msg);
  }

  subscribe(res) {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    for (const [type, data] of Object.entries(this.state)) res.write(`data: ${JSON.stringify({ type, data, snapshot: true })}\n\n`);
    this.clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 20000);
    res.on("close", () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }
}

module.exports = { Board };
