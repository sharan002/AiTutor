// Drives Google Meet with Chrome (Playwright): joins as a participant, speaks through a
// virtual microphone, listens to participants, and shares the board tab.
const path = require("path");
const fs = require("fs");
const { EventEmitter } = require("events");
const { chromium } = require("playwright-core");

const PROFILE_DIR = path.join(__dirname, ".browser-profile");
const BOARD_TITLE = "AI Tutor Board";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Where Chrome lives (override with CHROME_PATH).
function chromePath() {
  const local = process.env.LOCALAPPDATA || "";
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((p) => p && fs.existsSync(p));
}

class MeetSession extends EventEmitter {
  constructor({ boardUrl }) {
    super();
    this.boardUrl = boardUrl;
    this.token = null; // current playback, to tell "done" from "stopped"
  }

  async launch() {
    const exe = chromePath();
    this.context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...(exe ? { executablePath: exe } : { channel: "chrome" }),
      headless: false,
      viewport: null,
      locale: "en-US",
      permissions: ["microphone", "camera"],
      ignoreDefaultArgs: ["--enable-automation"],
      args: [
        "--disable-blink-features=AutomationControlled",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-background-timer-throttling",
        "--disable-renderer-backgrounding",
        "--disable-backgrounding-occluded-windows",
        // Pick the board tab automatically when Meet asks what to present.
        `--auto-select-desktop-capture-source=${BOARD_TITLE}`,
        `--auto-select-tab-capture-source-by-title=${BOARD_TITLE}`,
        "--window-size=1366,850",
      ],
    });
    const vad = {
      thresh: Number(process.env.TUTOR_VAD_THRESHOLD) || 0.012,
      silenceMs: Number(process.env.TUTOR_VAD_SILENCE_MS) || 1200,
    };
    await this.context.addInitScript(`window.__tutorCfg = ${JSON.stringify(vad)};`);
    await this.context.addInitScript({ path: path.join(__dirname, "browser-inject.js") });
    if (process.env.TUTOR_DEBUG_AUDIO) await this.context.exposeFunction("__tutorDebug", (m) => console.log("🎧", m));
    await this.context.exposeFunction("__tutorVoice", () => {
      if (process.env.TUTOR_DEBUG_AUDIO) console.log("🎤 voice detected");
      this.emit("voice");
    });
    await this.context.exposeFunction("__tutorSpeech", (b64) => this.emit("speech", Buffer.from(b64, "base64")));
    this.meetPage = this.context.pages()[0] || (await this.context.newPage());
  }

  async clickIf(locator, timeout = 1500) {
    try {
      await locator.first().click({ timeout });
      return true;
    } catch {
      return false;
    }
  }

  async join(url) {
    const p = this.meetPage;
    await p.goto(url, { waitUntil: "domcontentloaded" });
    console.log("🔗 Opened Meet. Joining...");
    await sleep(3000);

    // Pre-join screen: name (guests only), camera off, mic on.
    const name = p.locator('input[aria-label*="name" i]');
    if (await name.first().isVisible().catch(() => false)) await name.first().fill(process.env.TUTOR_NAME || "AI Trainer");
    await this.clickIf(p.getByRole("button", { name: /use microphone and camera|continue without/i }), 2500);
    await this.clickIf(p.getByRole("button", { name: /got it|dismiss/i }), 800);
    await this.clickIf(p.locator('[role="button"][aria-label*="Turn off camera" i]'), 2500);
    await this.clickIf(p.locator('[role="button"][aria-label*="Turn on microphone" i]'), 2500);

    const inCall = p.locator('[aria-label*="Leave call" i]');
    const joined =
      (await inCall.first().isVisible().catch(() => false)) ||
      (await this.clickIf(p.getByRole("button", { name: /^(join now|ask to join|switch here)/i }), 15000)) ||
      (await inCall.first().isVisible().catch(() => false));
    if (!joined) {
      const shot = path.join(__dirname, "join-error.png");
      await p.screenshot({ path: shot }).catch(() => {});
      const body = (await p.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
      throw new Error(
        `Could not find the "Join now / Ask to join" button. Meet says: "${body}". Screenshot: ${shot}. ` +
          "Check the link is valid, the trainer account is signed in (npm run login, then CLOSE that window), and the meeting allows this account."
      );
    }
    console.log("⏳ Waiting for the host to admit the trainer... (admit it from your Meet window)");

    const leave = p.locator('[aria-label*="Leave call" i]');
    const denied = p.getByText(/denied your request|removed from the meeting|can't join this video call/i);
    const outcome = await Promise.race([
      leave.first().waitFor({ timeout: (Number(process.env.MEET_ADMIT_TIMEOUT_MIN) || 10) * 60000 }).then(() => "in", () => "timeout"),
      denied.first().waitFor({ timeout: (Number(process.env.MEET_ADMIT_TIMEOUT_MIN) || 10) * 60000 }).then(() => "denied", () => "timeout"),
    ]);
    if (outcome === "timeout") throw new Error("Timed out waiting to be admitted.");
    if (outcome === "denied") throw new Error("The host denied entry (or the meeting blocked this account). Admit the trainer from the host's Meet window.");
    console.log("✅ In the meeting.");
    await sleep(1500);
    await this.clickIf(p.locator('[role="button"][aria-label*="Turn on microphone" i]'), 1500); // make sure mic is live

    this.watchEnd(leave);
  }

  watchEnd(leave) {
    let misses = 0;
    this.endTimer = setInterval(async () => {
      const gone = this.meetPage.isClosed() || (await leave.count().catch(() => 0)) === 0;
      misses = gone ? misses + 1 : 0;
      if (misses >= 3) {
        clearInterval(this.endTimer);
        this.emit("ended");
      }
    }, 5000);
  }

  // Open the board in its own tab and present that tab to the meeting.
  async share() {
    this.boardPage = await this.context.newPage();
    await this.boardPage.goto(this.boardUrl);
    await sleep(800);
    const p = this.meetPage;
    await p.bringToFront();

    const present = p.locator('[aria-label*="Present now" i], button:has-text("Present now")');
    if (!(await this.clickIf(present, 5000))) {
      console.log('⚠️  "Present now" not found - ask the host to allow participants to share their screen (or make the trainer co-host).');
      return false;
    }
    // Some Meet versions show a menu first.
    await this.clickIf(p.locator('[role="menuitem"]:has-text("tab"), li:has-text("A tab"), [role="menuitem"]:has-text("window")'), 2500);
    const stop = p.locator('[aria-label*="Stop presenting" i], [aria-label*="Stop sharing" i], button:has-text("Stop presenting")');
    const ok = await stop.first().waitFor({ timeout: 12000 }).then(() => true).catch(() => false);
    console.log(ok ? "🖥️  Sharing the board." : "⚠️  Could not confirm screen sharing started - check the Meet window.");
    return ok;
  }

  // ── audio sink for the Tutor ────────────────────────────────────────────────
  async play(mp3) {
    const token = { stopped: false };
    this.token = token;
    try {
      await this.meetPage.evaluate((b64) => window.__tutorPlay(b64), mp3.toString("base64"));
    } catch (e) {
      if (!token.stopped) console.error("play error:", e.message);
    }
    return token.stopped ? "stopped" : "done";
  }
  stop() {
    if (this.token) this.token.stopped = true;
    this.meetPage?.evaluate(() => window.__tutorStop && window.__tutorStop()).catch(() => {});
  }

  async leave() {
    clearInterval(this.endTimer);
    try {
      await this.clickIf(this.meetPage.locator('[aria-label*="Leave call" i]'), 2000);
    } catch {}
    await sleep(500);
    await this.context.close().catch(() => {});
  }
}

module.exports = { MeetSession, PROFILE_DIR, chromePath };
