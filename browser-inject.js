// Injected into every page BEFORE Google Meet's own scripts run (see meet.js).
// 1. Replaces the microphone with a WebAudio stream we can play tutor speech into.
// 2. Taps the remote participants' audio, detects speech and sends each utterance
//    (as a 16 kHz WAV) back to Node via window.__tutorSpeech / __tutorVoice.
// No virtual audio cable needed.
(() => {
  if (window.__tutorInstalled) return;
  window.__tutorInstalled = true;
  const cfg = Object.assign({ thresh: 0.012, silenceMs: 1200, minMs: 500, maxMs: 30000 }, window.__tutorCfg || {});
  const AC = window.AudioContext || window.webkitAudioContext;

  // ── virtual microphone ───────────────────────────────────────────────────────
  let ctx, micDest;
  const playing = new Set();
  function audio() {
    if (!ctx) {
      ctx = new AC();
      micDest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator(); // silent source keeps the track "live"
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g).connect(micDest);
      osc.start();
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  }

  const md = navigator.mediaDevices;
  if (md && md.getUserMedia) {
    const orig = md.getUserMedia.bind(md);
    md.getUserMedia = async (c = {}) => {
      if (!c.audio) return orig(c);
      audio();
      const out = new MediaStream(micDest.stream.getAudioTracks().map((t) => t.clone()));
      if (c.video) {
        try {
          (await orig({ video: c.video })).getVideoTracks().forEach((t) => out.addTrack(t));
        } catch {}
      }
      return out;
    };
  }

  window.__tutorPlay = async (b64) => {
    const c = audio();
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const buf = await c.decodeAudioData(bytes.buffer);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(micDest);
    playing.add(src);
    await new Promise((res) => {
      src.onended = res;
      src.start();
    });
    playing.delete(src);
  };
  window.__tutorStop = () => {
    for (const s of playing) {
      try {
        s.stop();
      } catch {}
    }
    playing.clear();
  };

  // ── listening to participants ────────────────────────────────────────────────
  let lctx, mix;
  const seen = new Set();
  let inSpeech = false, speechStart = 0, lastVoice = 0, signalled = false;
  let frames = [], pre = [];
  let peak = 0, lastLog = 0;

  function toWav16k(parts, rate) {
    let len = 0;
    for (const p of parts) len += p.length;
    const all = new Float32Array(len);
    let o = 0;
    for (const p of parts) (all.set(p, o), (o += p.length));
    const ratio = rate / 16000;
    const n = Math.floor(all.length / ratio);
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const v = Math.max(-1, Math.min(1, all[Math.floor(i * ratio)]));
      pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
    const buf = new ArrayBuffer(44 + pcm.length * 2);
    const dv = new DataView(buf);
    const w = (off, s) => [...s].forEach((ch, i) => dv.setUint8(off + i, ch.charCodeAt(0)));
    w(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); w(8, "WAVE"); w(12, "fmt ");
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, 16000, true); dv.setUint32(28, 32000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    w(36, "data"); dv.setUint32(40, pcm.length * 2, true);
    new Int16Array(buf, 44).set(pcm);
    let bin = "";
    const u8 = new Uint8Array(buf);
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function finish() {
    const dur = performance.now() - speechStart;
    const parts = frames;
    const rate = lctx.sampleRate;
    inSpeech = false; signalled = false; frames = []; pre = [];
    if (dur >= cfg.minMs && window.__tutorSpeech) window.__tutorSpeech(toWav16k(parts, rate));
  }

  function ensureListening() {
    if (lctx) return;
    lctx = new AC();
    mix = lctx.createGain();
    const proc = lctx.createScriptProcessor(4096, 1, 1);
    mix.connect(proc);
    proc.connect(lctx.destination); // output stays silent
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
      const rms = Math.sqrt(sum / x.length);
      const now = performance.now();
      if (rms > peak) peak = rms;
      if (window.__tutorDebug && now - lastLog > 3000) {
        window.__tutorDebug("remote audio level peak=" + peak.toFixed(4) + " (threshold " + cfg.thresh + ")");
        peak = 0;
        lastLog = now;
      }
      const copy = new Float32Array(x);
      if (rms > cfg.thresh) {
        lastVoice = now;
        if (!inSpeech) {
          inSpeech = true;
          speechStart = now;
          frames = pre.slice();
        }
      }
      if (inSpeech) {
        frames.push(copy);
        // Barge-in: only once it's clearly speech, not a click or cough.
        if (!signalled && now - speechStart >= cfg.minMs) {
          signalled = true;
          if (window.__tutorVoice) window.__tutorVoice();
        }
        if (now - lastVoice > cfg.silenceMs || now - speechStart > cfg.maxMs) finish();
      } else {
        pre.push(copy);
        if (pre.length > 3) pre.shift();
      }
    };
  }

  function addRemote(track) {
    if (track.kind !== "audio" || seen.has(track.id)) return;
    seen.add(track.id);
    ensureListening();
    if (lctx.state === "suspended") lctx.resume();
    const stream = new MediaStream([track]);
    // Chromium delivers silence from a remote WebRTC track to WebAudio unless the stream
    // is also attached to a media element, so attach a muted one.
    try {
      const el = new Audio();
      el.muted = true;
      el.srcObject = stream;
      el.play().catch(() => {});
    } catch {}
    lctx.createMediaStreamSource(stream).connect(mix);
    if (window.__tutorDebug) window.__tutorDebug("remote audio track attached: " + track.id);
  }

  const OrigPC = window.RTCPeerConnection;
  if (OrigPC) {
    window.RTCPeerConnection = function (...args) {
      const pc = new OrigPC(...args);
      pc.addEventListener("track", (e) => addRemote(e.track));
      return pc;
    };
    window.RTCPeerConnection.prototype = OrigPC.prototype;
    Object.setPrototypeOf(window.RTCPeerConnection, OrigPC);
  }
  // Fallback: pick up audio from any media element Meet attaches a remote stream to.
  setInterval(() => {
    document.querySelectorAll("audio,video").forEach((el) => {
      const s = el.srcObject;
      if (s && s.getAudioTracks) s.getAudioTracks().forEach(addRemote);
    });
  }, 2000);
})();
