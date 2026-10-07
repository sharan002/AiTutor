// Board page: renders what the server pushes (SSE). Add ?local=1 for the trainer's own
// control page (plays audio itself in preview mode + lets you type a doubt).
const $ = (id) => document.getElementById(id);
const local = new URLSearchParams(location.search).has("local");
let typer = null;
let askTimer = null;
let audioEl = null;

const handlers = {
  lesson(d) {
    $("course").textContent = d.title;
    document.title = "AI Tutor Board"; // Meet picks this tab by title
  },
  section(d) {
    $("topic").textContent = d.topicTotal ? `Topic ${d.topicNo}/${d.topicTotal}: ${d.topic}` : d.topic;
    $("progress").textContent = d.progress;
    $("slideTitle").textContent = d.topic;
    $("slideText").textContent = d.text;
  },
  code(d, snapshot) {
    clearInterval(typer);
    const el = $("code");
    if (!d) {
      el.textContent = "";
      el.classList.remove("cursor");
      $("lang").textContent = "";
      return;
    }
    $("lang").textContent = d.lang;
    if (snapshot || !d.typeMs) {
      el.textContent = d.code;
      el.classList.remove("cursor");
      return;
    }
    el.textContent = "";
    el.classList.add("cursor");
    const per = d.typeMs / d.code.length;
    const start = performance.now();
    typer = setInterval(() => {
      const n = Math.min(d.code.length, Math.floor((performance.now() - start) / per));
      el.textContent = d.code.slice(0, n);
      el.scrollTop = el.scrollHeight;
      if (n >= d.code.length) {
        clearInterval(typer);
        el.classList.remove("cursor");
      }
    }, 30);
  },
  output(d) {
    const out = $("out");
    const st = $("status");
    out.textContent = "";
    st.className = "";
    st.textContent = "";
    if (!d) return;
    if (d.running) {
      out.textContent = "$ running...";
      st.textContent = "running";
      st.className = "running";
      return;
    }
    out.append(document.createTextNode(d.stdout || ""));
    if (d.stderr) {
      const e = document.createElement("span");
      e.className = "err";
      e.textContent = (d.stdout && !d.stdout.endsWith("\n") ? "\n" : "") + d.stderr;
      out.append(e);
    }
    if (!d.stdout && !d.stderr) out.textContent = "(no output)";
    const ok = d.exitCode === 0;
    st.textContent = ok ? `finished in ${d.ms} ms` : `exit code ${d.exitCode}`;
    st.className = ok ? "ok" : "fail";
  },
  caption(text) {
    $("caption").textContent = text || "";
  },
  ask(d) {
    clearTimeout(askTimer);
    const el = $("ask");
    if (!d) return void (el.hidden = true);
    el.hidden = false;
    el.textContent = "❓ Student: " + d.q;
    askTimer = setTimeout(() => (el.hidden = true), 30000);
  },
  audio(d) {
    if (!local) return;
    handlers["audio-stop"]();
    audioEl = new Audio("data:audio/mpeg;base64," + d.b64);
    const id = d.id;
    const done = () => fetch("/api/audio-ended", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
    audioEl.onended = done;
    audioEl.onerror = done;
    audioEl.play().catch(done);
  },
  "audio-stop"() {
    if (audioEl) {
      audioEl.onended = audioEl.onerror = null;
      audioEl.pause();
      audioEl = null;
    }
  },
};

const es = new EventSource("/api/board/events");
es.onmessage = (e) => {
  const m = JSON.parse(e.data);
  handlers[m.type]?.(m.data, !!m.snapshot);
};

if (local) {
  $("controls").hidden = false;
  $("start").onclick = () => {
    $("start").hidden = true;
    fetch("/api/start", { method: "POST" });
  };
  $("controls").onsubmit = (e) => {
    e.preventDefault();
    const t = $("q").value.trim();
    if (!t) return;
    $("q").value = "";
    fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: t }) });
  };
}
