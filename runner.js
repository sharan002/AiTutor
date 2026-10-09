// Runs the syllabus code on this machine and returns its output.
// Supported: python, javascript (node), java (11+, single file), c (gcc), cpp (g++).
// The code comes from YOUR syllabus file, so it runs unsandboxed - only use trusted syllabi.
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TIMEOUT_MS = Number(process.env.TUTOR_RUN_TIMEOUT_SEC || 10) * 1000;
const MAX_OUT = 8000;

function candidates(lang) {
  const win = process.platform === "win32";
  if (lang === "python") return process.env.PYTHON_CMD ? [process.env.PYTHON_CMD] : win ? ["python", "py", "python3"] : ["python3", "python"];
  if (lang === "javascript") return ["node"];
  return [];
}

// Run one command; resolves { stdout, stderr, exitCode, timedOut, missing }.
function exec(cmd, args, { cwd, timeout = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.slice(0, MAX_OUT), stderr: stderr.slice(0, MAX_OUT), timedOut, missing: false, ...r });
    };
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUNBUFFERED: "1", PYTHONUTF8: "1" },
        windowsHide: true,
      });
    } catch {
      return finish({ exitCode: -1, missing: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
      else child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => finish({ exitCode: -1, missing: e.code === "ENOENT", stderr: stderr + e.message }));
    child.on("close", (code) => finish({ exitCode: code ?? -1 }));
  });
}

async function firstWorking(cmds, args, opts) {
  let last;
  for (const cmd of cmds) {
    last = await exec(cmd, args, opts);
    // "missing" or the Windows Store python stub -> try the next candidate.
    if (last.missing || /Python was not found/i.test(last.stderr)) continue;
    return last;
  }
  return { ...last, stderr: `No interpreter found (tried: ${cmds.join(", ")}).`, exitCode: -1 };
}

async function runCode(lang, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tutor-run-"));
  const started = Date.now();
  try {
    let r;
    if (lang === "python" || lang === "javascript") {
      const file = path.join(dir, lang === "python" ? "main.py" : "main.js");
      fs.writeFileSync(file, code);
      r = await firstWorking(candidates(lang), [file], { cwd: dir });
    } else if (lang === "java") {
      const cls = (code.match(/public\s+(?:final\s+)?class\s+(\w+)/) || [])[1] || "Main";
      const file = path.join(dir, `${cls}.java`);
      fs.writeFileSync(file, code);
      r = await exec("java", [file], { cwd: dir });
    } else if (lang === "c" || lang === "cpp") {
      const file = path.join(dir, lang === "c" ? "main.c" : "main.cpp");
      const exe = path.join(dir, process.platform === "win32" ? "main.exe" : "main");
      fs.writeFileSync(file, code);
      const build = await exec(lang === "c" ? "gcc" : "g++", [file, "-o", exe], { cwd: dir });
      r = build.exitCode === 0 && !build.missing ? await exec(exe, [], { cwd: dir }) : build;
    } else {
      r = { stdout: "", stderr: `Running "${lang}" code is not supported yet.`, exitCode: -1, timedOut: false };
    }
    if (r.missing) r.stderr = `${lang} is not installed on this machine.`;
    if (r.timedOut) r.stderr += `\n[stopped: ran longer than ${TIMEOUT_MS / 1000}s]`;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: !!r.timedOut, ms: Date.now() - started };
  } finally {
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { runCode, candidates };
