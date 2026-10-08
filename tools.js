// Agent tools: when a student asks for a step-by-step explanation (or says something is unclear),
// the tutor can put a visual aid on the shared screen:
//   - "vscode":  writes a small commented example, opens it in its own VS Code window, runs it and shows the
//                output in the file; the window is closed again (close()) once the tutor has finished explaining
//   - "paint":   draws a flow diagram to a PNG and opens it in Paint
// The LLM only chooses WHAT to show (a small JSON plan); this file validates it and is the only code
// that touches the PC - no arbitrary commands, only these two whitelisted actions, files in ./tools-output.
// Windows only. Turn off with TUTOR_TOOLS=off.
const { spawn, execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chat } = require("./llm");
const { runCode } = require("./runner");

const OUT_DIR = path.join(__dirname, "tools-output");
const enabled = () => process.platform === "win32" && !/^(off|0|false)$/i.test(process.env.TUTOR_TOOLS || "");

// Only consult the planner when the student's words look like "explain / step by step / not clear / draw".
// English, Tanglish and Tamil-script phrases (speech-to-text may produce any of them).
const WANTS_VISUAL = new RegExp(
  [
    "step", "explain", "diagram", "draw", "show me", "example", "demonstrate", "visual", "picture", "flow",
    "not clear", "unclear", "don'?t understand", "didn'?t understand", "confus", "once more", "again",
    "puriy", "theriy", "vilakk", "padam", "varai", "sollu", "kaatt", "kaat",
    "புரி", "தெரி", "விளக்க", "படம்", "வரை", "படி", "காட்ட", "மீண்டும்", "சொல்லு",
  ].join("|"),
  "i"
);
const wantsVisual = (q) => enabled() && WANTS_VISUAL.test(q);

// Explicit trigger words (also usable for testing). The LLM is told it MUST use the matching tool.
//   Paint:   "draw", "diagram", "flow", "flowchart", "paint"      e.g. "open paint and draw the flow of a for loop"
//   VS Code: "vs code", "vscode", "example", "demo", "run"        e.g. "show an example in VS Code for a list"
const FORCE_PAINT = /diagram|draw|flow ?chart|\bflow\b|\bpain?t|\bpeint|padam|varai|படம்|வரை|பெ?[யே]ி?[ணன]்ட்|பைண்ட்/i;
const FORCE_VSCODE = /vs ?code|visual studio|\bexample|\bdemo|\brun\b|\bexecute|code (?:ah|a)? ?kaatt?|உதாரணம்|எடுத்துக்காட்டு/i;

const EXT = { python: "py", javascript: "js", java: "java", c: "c", cpp: "cpp" };
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// ── planning (LLM picks the aids) ────────────────────────────────────────────
function planPrompt(lang, question, context) {
  const must = [FORCE_PAINT.test(question) && '"paint" (a diagram of the flow)', FORCE_VSCODE.test(question) && '"vscode" (a runnable example)'].filter(Boolean);
  return [
    {
      role: "system",
      content: `You prepare visual aids for a live programming class. A student asked something; decide whether a visual on the shared screen would help, and design it.
Tools:
- "vscode": a small runnable example opened and run in VS Code. Use for "explain step by step", new concepts (functions, loops, lists...) or whenever the code on screen is not enough: write a NEW short example if needed. Fields: "title", "language" (python, javascript, java, c or cpp - the course language), "code" (complete program, max 30 lines, no input(), prints its results, with a short comment above each step in ${lang}; for Java use "public class Main").
- "paint": a flow/concept diagram drawn in Paint. Fields: "title", "nodes" (2 to 8 short labels, in order) and optional "edges" ([[fromIndex,toIndex,"optional label"], ...], 0-based; default is a chain through the nodes in order).
Use "vscode" for "explain step by step" or any concept that needs an example, "paint" for processes/flows/relationships, both if it really helps, and NONE for a simple factual doubt.
Write all titles, labels and code comments in ${lang} (Tamil script or Tanglish as the student spoke); keep code and technical words in English.
${must.length ? `The student explicitly asked for a visual, so you MUST include: ${must.join(" and ")}.\n` : ""}Reply with ONLY compact JSON (no markdown): {"actions":[...]} - use {"actions":[]} when no visual is needed.`,
    },
    {
      role: "user",
      content: `Topic: "${context.topic || ""}"${context.code ? `\nCode on screen:\n${String(context.code).slice(0, 500)}` : ""}${context.text ? `\nNotes:\n${String(context.text).slice(0, 500)}` : ""}\n\nStudent said: "${question}"`,
    },
  ];
}

function sanitize(raw) {
  const actions = [];
  for (const a of Array.isArray(raw?.actions) ? raw.actions : []) {
    const language = { js: "javascript", node: "javascript", "c++": "cpp", py: "python" }[String(a?.language).toLowerCase()] || String(a?.language).toLowerCase();
    if (a?.tool === "vscode" && a.code && EXT[language]) {
      const code = String(a.code).replace(/^\s*```\w*\n?/, "").replace(/```\s*$/, "");
      actions.push({ tool: "vscode", title: clip(a.title, 80) || "Example", language, code: code.slice(0, 3000) });
    } else if (a?.tool === "paint" && Array.isArray(a.nodes) && a.nodes.length >= 2) {
      const nodes = a.nodes.slice(0, 8).map((n) => clip(typeof n === "object" ? n?.label : n, 60)).filter(Boolean);
      if (nodes.length < 2) continue;
      const edges = (Array.isArray(a.edges) ? a.edges : [])
        .map((e) => (Array.isArray(e) ? { from: +e[0], to: +e[1], label: clip(e[2], 30) } : { from: +e?.from, to: +e?.to, label: clip(e?.label, 30) }))
        .filter((e) => Number.isInteger(e.from) && Number.isInteger(e.to) && e.from >= 0 && e.to >= 0 && e.from < nodes.length && e.to < nodes.length && e.from !== e.to)
        .slice(0, 16);
      if (!edges.length) for (let i = 0; i + 1 < nodes.length; i++) edges.push({ from: i, to: i + 1, label: "" });
      actions.push({ tool: "paint", title: clip(a.title, 80) || "Diagram", nodes, edges });
    }
  }
  return actions.slice(0, 2);
}

// Returns a list of validated actions ([] when no visual is needed or anything goes wrong).
async function plan(provider, lang, question, context) {
  if (!wantsVisual(question) && !(enabled() && (FORCE_PAINT.test(question) || FORCE_VSCODE.test(question)))) return [];
  try {
    const reply = await chat(provider, planPrompt(lang, question, context), { maxTokens: 2500, temperature: 0.3 });
    const json = reply.match(/\{[\s\S]*\}/);
    const actions = json ? sanitize(JSON.parse(json[0])) : [];
    // The student explicitly asked for Paint but the planner skipped it: draw a simple diagram of the topic.
    if (FORCE_PAINT.test(question) && !actions.some((a) => a.tool === "paint")) {
      const t = clip(context.topic, 40) || "Topic";
      actions.push({ tool: "paint", title: t, nodes: [t, "Input", "Process", "Output"], edges: [{ from: 0, to: 1, label: "" }, { from: 1, to: 2, label: "" }, { from: 2, to: 3, label: "" }] });
    }
    console.log(`🛠️  tool plan: ${actions.map((a) => a.tool).join(", ") || "none"}`);
    return actions;
  } catch (e) {
    console.error("tool plan error:", e.response?.data || e.message);
    return [];
  }
}

// ── executing ────────────────────────────────────────────────────────────────
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

function launch(exe, file) {
  try {
    const child = spawn(exe, [file], { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", (e) => console.error(`could not start ${exe}:`, e.message));
    child.unref();
    return true;
  } catch (e) {
    console.error(`could not start ${exe}:`, e.message);
    return false;
  }
}

const VSCODE_DIR = () => path.resolve(process.env.TUTOR_VSCODE_DIR || path.join(OUT_DIR, "vscode-demo"));
const PROFILE_DIR = path.join(OUT_DIR, "vscode-profile"); // own VS Code instance: closing it never touches your own windows
let vscodeProc = null;

function vscodeExe() {
  const c = [
    process.env.TUTOR_VSCODE_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe"),
    "C:\\Program Files\\Microsoft VS Code\\Code.exe",
    "C:\\Program Files (x86)\\Microsoft VS Code\\Code.exe",
  ].filter(Boolean);
  return c.find((p) => fs.existsSync(p));
}

function killTree(pid) {
  return new Promise((r) => execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => r()));
}

// Closes the demo VS Code window; true if one was open.
async function close() {
  const proc = vscodeProc;
  vscodeProc = null;
  if (!proc?.pid) return false;
  await killTree(proc.pid);
  return true;
}

function openVscode(file) {
  const exe = vscodeExe();
  if (!exe) throw new Error("VS Code not found (set TUTOR_VSCODE_PATH)");
  const settings = path.join(PROFILE_DIR, "User", "settings.json");
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(settings, "utf8")); } catch {}
  fs.writeFileSync(
    settings,
    JSON.stringify(
      {
        "editor.fontSize": 20, "editor.minimap.enabled": false, "workbench.startupEditor": "none", "security.workspace.trust.enabled": false,
        "update.mode": "none", "telemetry.telemetryLevel": "off",
        // lets the folder's tasks.json run the example in the integrated terminal as soon as the window opens
        "task.allowAutomaticTasks": "on", "terminal.integrated.defaultProfile.windows": "Command Prompt", "terminal.integrated.fontSize": 18,
        ...cur,
        "task.allowAutomaticTasks": "on", "terminal.integrated.defaultProfile.windows": "Command Prompt",
      },
      null, 2
    )
  );
  const child = spawn(exe, ["--user-data-dir", PROFILE_DIR, "--new-window", path.dirname(file), file], { detached: true, stdio: "ignore" });
  child.on("error", (e) => console.error("could not start VS Code:", e.message));
  child.unref();
  vscodeProc = child;
}

// A folder-open task: VS Code runs the example in its integrated terminal (cmd) as soon as the window opens.
function writeRunTask(dir, file, language, cls) {
  const f = `"${file}"`;
  const exe = path.join(dir, "demo.exe");
  const command = {
    python: `python -u ${f} || py -u ${f}`,
    javascript: `node ${f}`,
    java: `javac ${f} && java -cp "${dir}" ${cls || "Main"}`,
    c: `gcc ${f} -o "${exe}" && "${exe}"`,
    cpp: `g++ ${f} -o "${exe}" && "${exe}"`,
  }[language];
  const vs = path.join(dir, ".vscode");
  fs.mkdirSync(vs, { recursive: true });
  fs.writeFileSync(
    path.join(vs, "tasks.json"),
    JSON.stringify({
      version: "2.0.0",
      tasks: [{ label: "Run example", type: "shell", command, presentation: { reveal: "always", panel: "dedicated", focus: false, clear: true }, runOptions: { runOn: "folderOpen" }, problemMatcher: [] }],
    }, null, 2)
  );
}

// Writes the example into the demo folder, opens it in VS Code, runs it, and appends the output as comments.
async function showCode(a) {
  const dir = VSCODE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const cls = a.language === "java" ? (a.code.match(/public\s+(?:final\s+)?class\s+(\w+)/) || [])[1] || "Main" : null;
  const file = path.join(dir, `${cls || `example_${stamp()}`}.${EXT[a.language]}`);
  fs.writeFileSync(file, a.code, "utf8");
  writeRunTask(dir, file, a.language, cls);
  await close(); // never leave an older demo window open
  openVscode(file);
  const result = await runCode(a.language, a.code);
  const out = (result.stdout + result.stderr).trim() || "(no output)";
  const c = a.language === "python" ? "#" : "//";
  const outLines = out.slice(0, 1500).split(/\r?\n/).map((l) => `${c} ${l}`);
  fs.writeFileSync(file, `${a.code.trimEnd()}\n\n${c} ---- Output ----\n${outLines.join("\n")}\n`, "utf8"); // VS Code reloads it
  console.log(`💻 vscode: ran ${a.language} example (exit ${result.exitCode})`);
  return out;
}

// Snake layout (3 per row, rows alternate direction) so consecutive steps are always neighbours.
function layout(a) {
  const W = 300, H = 100, GX = 100, GY = 90, PER = 3, M = 50, TOP = 110;
  const rows = Math.ceil(a.nodes.length / PER);
  const boxes = a.nodes.map((label, i) => {
    const r = Math.floor(i / PER);
    const c = r % 2 ? PER - 1 - (i % PER) : i % PER;
    return { label, x: M + c * (W + GX), y: TOP + r * (H + GY), w: W, h: H };
  });
  return {
    title: a.title,
    width: M * 2 + Math.min(a.nodes.length, PER) * W + (Math.min(a.nodes.length, PER) - 1) * GX,
    height: TOP + rows * H + (rows - 1) * GY + M,
    boxes,
    edges: a.edges.map((e) => ({ ...e })),
  };
}

const DRAW_PS = `
param([string]$Json, [string]$Out)
Add-Type -AssemblyName System.Drawing
$d = Get-Content -Raw -Encoding UTF8 $Json | ConvertFrom-Json
$bmp = New-Object System.Drawing.Bitmap ([int]$d.width), ([int]$d.height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'
$g.Clear([System.Drawing.Color]::White)
$title = New-Object System.Drawing.Font 'Nirmala UI', 26, ([System.Drawing.FontStyle]::Bold)
$font  = New-Object System.Drawing.Font 'Nirmala UI', 16
$small = New-Object System.Drawing.Font 'Nirmala UI', 13
$ink = [System.Drawing.Brushes]::Black
$g.DrawString($d.title, $title, $ink, 40, 30)
$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(40,90,160)), 3
$pen.CustomEndCap = New-Object System.Drawing.Drawing2D.AdjustableArrowCap 6, 7
$border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(40,90,160)), 3
$fill = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(222,235,250))
$sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
function Clip($b, $dx, $dy) {  # distance from box centre to its border along (dx,dy)
  $sx = if ($dx -ne 0) { ($b.w / 2) / [math]::Abs($dx) } else { [double]::MaxValue }
  $sy = if ($dy -ne 0) { ($b.h / 2) / [math]::Abs($dy) } else { [double]::MaxValue }
  [math]::Min($sx, $sy)
}
foreach ($e in $d.edges) {
  $a = $d.boxes[$e.from]; $b = $d.boxes[$e.to]
  $ax = $a.x + $a.w/2; $ay = $a.y + $a.h/2; $bx = $b.x + $b.w/2; $by = $b.y + $b.h/2
  $dx = $bx - $ax; $dy = $by - $ay
  $ta = Clip $a $dx $dy; $tb = Clip $b $dx $dy
  $g.DrawLine($pen, [single]($ax + $dx*$ta), [single]($ay + $dy*$ta), [single]($bx - $dx*$tb - 2), [single]($by - $dy*$tb - 2))
  if ($e.label) { $g.DrawString($e.label, $small, [System.Drawing.Brushes]::DarkRed, [single](($ax+$bx)/2 + 6), [single](($ay+$by)/2 - 26)) }
}
$i = 1
foreach ($b in $d.boxes) {
  $r = New-Object System.Drawing.RectangleF ([single]$b.x), ([single]$b.y), ([single]$b.w), ([single]$b.h)
  $g.FillRectangle($fill, $r); $g.DrawRectangle($border, $b.x, $b.y, $b.w, $b.h)
  $inner = New-Object System.Drawing.RectangleF ([single]($b.x+8)), ([single]$b.y), ([single]($b.w-16)), ([single]$b.h)
  $g.DrawString("$i. " + $b.label, $font, $ink, $inner, $sf)
  $i++
}
$g.Dispose(); $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
`;

function drawDiagram(a) {
  return new Promise((resolve, reject) => {
    const base = path.join(OUT_DIR, `diagram-${stamp()}`);
    fs.writeFileSync(`${base}.json`, JSON.stringify(layout(a)), "utf8");
    fs.writeFileSync(`${base}.ps1`, `\uFEFF${DRAW_PS}`, "utf8");
    execFile(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${base}.ps1`, "-Json", `${base}.json`, "-Out", `${base}.png`],
      { timeout: 20000, windowsHide: true },
      (err, _out, stderr) => {
        fs.rm(`${base}.ps1`, { force: true }, () => {});
        fs.rm(`${base}.json`, { force: true }, () => {});
        if (err || !fs.existsSync(`${base}.png`)) reject(new Error(stderr || err?.message || "diagram not created"));
        else resolve(`${base}.png`);
      }
    );
  });
}

async function openDiagram(a) {
  const png = await drawDiagram(a);
  launch(process.env.TUTOR_PAINT_PATH || "mspaint.exe", png);
  return png;
}

// Opens each aid on the PC. Returns what is now on screen (for the answer prompt); a failed aid is logged and
// skipped - the spoken answer still happens.
async function execute(actions) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const shown = [];
  for (const a of actions) {
    try {
      if (a.tool === "vscode") {
        const out = await showCode(a);
        shown.push(`VS Code is open with this ${a.language} example "${a.title}", which was just run:\n${a.code.slice(0, 1200)}\nIts output:\n${out.slice(0, 500)}`);
      } else {
        console.log(`🎨 paint: ${clip(a.title, 60)}`);
        await openDiagram(a);
        shown.push(`a diagram "${a.title}" open in Paint with the boxes: ${a.nodes.join(" -> ")}`);
      }
    } catch (e) {
      console.error(`tool ${a.tool} failed:`, e.message);
    }
  }
  return shown.join("\n");
}

const isOpen = () => !!vscodeProc?.pid;

module.exports = { plan, execute, close, enabled, isOpen };
