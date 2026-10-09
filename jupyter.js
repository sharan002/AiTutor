// Jupyter Notebook stage for AI classes (syllabus `@run: jupyter`, or any file inside an "AI" folder).
//
// Each code block of the syllabus becomes a cell of ONE growing lesson notebook (tools-output/jupyter/):
//   begin(block)  appends the cell (not run yet), starts a local Jupyter server if needed and opens the notebook
//                 in its own browser window - the trainer explains the code while it is on screen
//   run()         executes the notebook with the real Jupyter kernel (nbconvert), re-opens it with the outputs
//                 showing and returns the cell's output (same shape as runner.runCode)
//   example(a)    a separate one-off notebook for a doubt ("similar example"), run and opened the same way
//   close()       closes the window (and the kernels it started); the server is stopped when the tutor exits
// Needs: pip install notebook nbconvert ipykernel (+ whatever the syllabus imports: numpy, pandas, ...).
// available() tells whether that is installed - the tutor falls back to the board when it is not.
const { spawn, execFile, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { candidates } = require("./runner");

const OUT_DIR = path.join(__dirname, "tools-output");
const NB_DIR = path.join(OUT_DIR, "jupyter");
const PROFILE_DIR = path.join(OUT_DIR, "jupyter-profile"); // own browser profile: closing it never touches your windows
const PORT = Number(process.env.TUTOR_JUPYTER_PORT) || 8899;
const TOKEN = "tutor" + Math.random().toString(36).slice(2, 10);
const EXEC_TIMEOUT_SEC = Number(process.env.TUTOR_JUPYTER_TIMEOUT_SEC) || 120;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let python = null; // working python command, once checked
let checked = false;
let server = null;
let browser = null; // { proc }
let seq = 0;
let lesson = null; // notebook JSON of the lesson so far (cells carry the outputs of the last run)
let lastTopic = null;

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true, timeout: 60000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })));

// Resolves to the python command with notebook + nbconvert + ipykernel, or null.
async function available() {
  if (checked) return python;
  checked = true;
  for (const cmd of candidates("python")) {
    const r = await run(cmd, ["-c", "import notebook, nbconvert, ipykernel; print('ok')"], { timeout: 30000 });
    if (!r.err && /ok/.test(r.stdout)) return (python = cmd);
  }
  return null;
}

function browserExe() {
  const local = process.env.LOCALAPPDATA || "";
  return [
    process.env.TUTOR_JUPYTER_BROWSER,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
  ].find((p) => p && fs.existsSync(p));
}

const killTree = (pid) => (process.platform === "win32" ? run("taskkill", ["/pid", String(pid), "/T", "/F"]) : Promise.resolve(process.kill(pid)));
const api = (p, opts = {}) => axios({ url: `http://127.0.0.1:${PORT}${p}`, headers: { Authorization: `token ${TOKEN}` }, timeout: 5000, validateStatus: () => true, ...opts });

async function ensureServer() {
  if (server && (await api("/api/status").then((r) => r.status === 200, () => false))) return;
  fs.mkdirSync(NB_DIR, { recursive: true });
  server = spawn(
    python,
    ["-m", "notebook", "--no-browser", `--port=${PORT}`, "--port-retries=0", `--ServerApp.token=${TOKEN}`, `--IdentityProvider.token=${TOKEN}`, `--notebook-dir=${NB_DIR}`],
    { stdio: "ignore", windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } }
  );
  server.on("error", (e) => console.error("could not start Jupyter:", e.message));
  for (let i = 0; i < 60; i++) {
    if (await api("/api/status").then((r) => r.status === 200, () => false)) return;
    await sleep(500);
  }
  throw new Error("Jupyter server did not start");
}

// ── notebook files ─────────────────────────────────────────────────────────────
const source = (s) => String(s).split(/(?<=\n)/);
const newNotebook = () => ({ cells: [], metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" }, language_info: { name: "python" } }, nbformat: 4, nbformat_minor: 5 });
const codeCell = (code) => ({ cell_type: "code", execution_count: null, id: "c" + (++seq).toString(36) + Date.now().toString(36), metadata: {}, outputs: [], source: source(code) });
const mdCell = (md) => ({ cell_type: "markdown", id: "m" + (++seq).toString(36) + Date.now().toString(36), metadata: {}, source: source(md) });

function write(nb, name) {
  const file = path.join(NB_DIR, name);
  fs.writeFileSync(file, JSON.stringify(nb, null, 1), "utf8");
  return file;
}

async function execute(file) {
  const r = await run(python, ["-m", "jupyter", "nbconvert", "--to", "notebook", "--execute", "--allow-errors", "--inplace", `--ExecutePreprocessor.timeout=${EXEC_TIMEOUT_SEC}`, file], {
    timeout: (EXEC_TIMEOUT_SEC + 60) * 1000,
    cwd: NB_DIR,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", MPLBACKEND: "module://matplotlib_inline.backend_inline" },
  });
  if (r.err) throw new Error((r.stderr || r.err.message).trim().split("\n").slice(-4).join(" "));
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

const ansi = (s) => String(s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

// Text a cell printed / returned / failed with -> { stdout, stderr } like runner.runCode.
function outputOf(cell) {
  let stdout = "", stderr = "";
  for (const o of cell.outputs || []) {
    const join = (t) => (Array.isArray(t) ? t.join("") : String(t || ""));
    if (o.output_type === "stream") (o.name === "stderr" ? (stderr += join(o.text)) : (stdout += join(o.text)));
    else if (o.output_type === "error") stderr += ansi(`${o.ename}: ${o.evalue}`) + "\n";
    else if (o.data?.["text/plain"]) stdout += join(o.data["text/plain"]) + (o.data["image/png"] ? "\n[a chart is shown in the notebook]" : "") + "\n";
    else if (o.data?.["image/png"]) stdout += "[a chart is shown in the notebook]\n";
  }
  return { stdout: stdout.slice(0, 8000), stderr: stderr.slice(0, 8000) };
}

// ── the browser window ─────────────────────────────────────────────────────────
async function show(file) {
  const exe = browserExe();
  if (!exe) throw new Error("Chrome/Edge not found (set TUTOR_JUPYTER_BROWSER)");
  const url = `http://127.0.0.1:${PORT}/notebooks/${encodeURIComponent(path.basename(file))}?token=${TOKEN}`;
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const old = browser;
  const proc = spawn(exe, [`--user-data-dir=${PROFILE_DIR}`, `--app=${url}`, "--new-window", "--start-maximized", "--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble"], { stdio: "ignore", detached: true });
  proc.on("error", (e) => console.error("could not open the notebook window:", e.message));
  proc.unref();
  browser = { proc };
  await sleep(1800);
  if (old?.proc?.pid) await killTree(old.proc.pid); // swap windows without a gap
}

async function closeSessions() {
  const r = await api("/api/sessions").catch(() => null);
  for (const s of Array.isArray(r?.data) ? r.data : []) await api(`/api/sessions/${s.id}`, { method: "DELETE" }).catch(() => {});
}

// ── API used by the tutor ───────────────────────────────────────────────────────
// Put the syllabus code on screen as a new (not yet run) cell of the lesson notebook.
async function begin({ code, topic, title }) {
  if (!(await available())) throw new Error("Jupyter is not installed (pip install notebook nbconvert ipykernel)");
  await ensureServer();
  if (!lesson) {
    lesson = newNotebook();
    for (const f of fs.readdirSync(NB_DIR)) if (/\.ipynb$/.test(f)) fs.rmSync(path.join(NB_DIR, f), { force: true }); // earlier classes
  }
  lesson.cells.forEach((c) => c.cell_type === "code" && (c.metadata.collapsed = false));
  if (topic && topic !== lastTopic) lesson.cells.push(mdCell(`# ${topic}`));
  lastTopic = topic || lastTopic;
  lesson.cells.push(codeCell(code));
  await close(); // one window at a time
  await show(write(lesson, `lesson-${++seq}.ipynb`));
  console.log(`📓 jupyter: ${title || topic || "notebook"} opened`);
}

// Run the notebook (all cells, in order, so the kernel state is right) and show it with the outputs.
async function runLesson() {
  const started = Date.now();
  const file = write(lesson, `lesson-${++seq}.ipynb`);
  let nb;
  try {
    nb = await execute(file);
  } catch (e) {
    return { stdout: "", stderr: `Jupyter could not run the notebook: ${e.message}`, exitCode: -1, timedOut: false, ms: Date.now() - started };
  }
  lesson = nb; // keeps the outputs for the next block
  await show(file);
  const last = [...nb.cells].reverse().find((c) => c.cell_type === "code");
  const out = last ? outputOf(last) : { stdout: "", stderr: "" };
  const failed = (last?.outputs || []).some((o) => o.output_type === "error");
  console.log(`📓 jupyter: ran the cell (${failed ? "error" : "ok"})`);
  return { ...out, exitCode: failed ? 1 : 0, timedOut: false, ms: Date.now() - started };
}

// A small one-off notebook (planner-made similar example for a doubt), executed and opened. Returns its output text.
async function example({ code, title }) {
  if (!(await available())) throw new Error("Jupyter is not installed");
  await ensureServer();
  const nb = newNotebook();
  nb.cells.push(mdCell(`# ${title || "Example"}`), codeCell(code));
  const file = write(nb, `example-${++seq}.ipynb`);
  const done = await execute(file);
  await close();
  await show(file);
  const last = [...done.cells].reverse().find((c) => c.cell_type === "code");
  const o = last ? outputOf(last) : { stdout: "", stderr: "" };
  console.log(`📓 jupyter: ran an example notebook`);
  return (o.stdout + o.stderr).trim() || "(no output)";
}

// Closes the notebook window; true if one was open.
async function close() {
  const b = browser;
  browser = null;
  if (!b?.proc?.pid) return false;
  await killTree(b.proc.pid);
  await closeSessions();
  return true;
}

// The notebook the student sees right now (for doubt answers).
const isOpen = () => !!browser?.proc?.pid;

function stopServer() {
  if (browser?.proc?.pid) try { execFileSync("taskkill", ["/pid", String(browser.proc.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  if (server?.pid) {
    try { process.platform === "win32" ? execFileSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" }) : server.kill(); } catch {}
  }
  server = null;
}
process.on("exit", stopServer);

module.exports = { available, begin, run: runLesson, example, close, isOpen };
