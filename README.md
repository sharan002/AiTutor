# AI Programming Trainer for Google Meet

Give it a syllabus `.txt` and a Meet link. The trainer joins as a participant, **shares a board tab**
(notes + code editor + terminal), teaches by voice, **types and runs the code** from your `#code#` blocks,
answers doubts when anyone speaks, and **continues from where it stopped** next time. You stay the host.

```
npm install
npm test                                   # offline self-test (no keys, no Meet)
npm run login                              # once: sign in the trainer's Google account (optional, see below)
npm run preview -- python1                 # try a lesson without Meet: open http://localhost:7100/?local=1
npm run teach -- https://meet.google.com/hhs-yvpi-ywe python1
npm run teach -- https://meet.google.com/vwy-zfmx-miv ML1             # an AI class (runs in Jupyter)
npm run teach -- https://meet.google.com/zwg-dmeo-hkb python1 -- --restart   # ignore saved progress, start from block 1
```

Reads `../.env` (Sarvam keys etc. - same as before). Needs Chrome, plus whatever compilers/interpreters your
syllabus uses (python, node, java 11+, gcc/g++).

## Syllabus format (`syllabus/<Course>/<name>.txt`)
Syllabi live in course folders: `syllabus/Python/python1.txt`, `syllabus/AI/ML1.txt`, ... Pass just the file name
(`python1`, `ML1`) or `Python/python1`; add more courses by adding folders. The folder name is the course.

```
@title: Python for Beginners      optional: @language: ta-IN | en-IN | hi-IN ..., @code: python, @instructions: ...
@run: vscode                      optional: where code runs - vscode | jupyter | board (see below)

# Variables                       heading = topic
Plain lines are what the trainer must teach (notes / key points). The LLM expands them into speech.

#code#                            code block (also "#code js#"); end with #/code# (or #endcode# / another #code#)
x = 5
print(x)
#/code#
```
Code language defaults to the file name without its number (`python1.txt` -> python; notebooks -> python). You can append new topics later; progress is kept.

## What happens in class
1. Trainer joins -> you **admit it** from your Meet window -> it presents the board tab automatically.
2. For each text block it explains the notes. For each `#code#` block it shows the code in **VS Code** (or a **Jupyter
   notebook** for AI classes), walks through it, **runs it there**, then explains the output/error. See "Where code runs".
3. After each topic it asks for doubts and waits a few seconds (`TUTOR_DOUBT_WAIT_SEC`, default 8).
4. **Anyone speaking pauses the trainer** -> speech is transcribed (Sarvam STT) -> answered with the current
   notes/code/output as context -> the interrupted sentence is replayed and the lesson continues.
   Typed doubts work too: open `http://localhost:7100/?local=1` and use the box top-right.
5. Progress is saved in `progress/<syllabus>.json` after every block. Stop with Ctrl+C any time; run the same
   command again to resume ("welcome back, last time we covered ...").

## Where code runs (`@run`)
| `@run` | Used when | What the students see |
|---|---|---|
| `vscode` | default (Python and other courses) | the code in its own VS Code window, run in VS Code's terminal |
| `jupyter` | default for syllabus files in an `AI` folder | one notebook per class: every `#code#` block becomes a cell, run by the real Jupyter kernel (cells share variables), outputs and charts shown |
| `board` | forced with `@run: board` or `TUTOR_RUNNER=board`, or when VS Code / Jupyter is unavailable | the old in-page code editor + terminal |

After a code block is run and explained the trainer asks **"is your doubt resolved?"** and waits `TUTOR_DOUBT_WAIT_SEC` (8 s):
- **Silence / "yes, clear"** -> VS Code (or the notebook) is closed and the Meet tab is brought back to the front.
- **"No / not clear"** -> the trainer explains the code that is open **step by step**; if that did not help, or the student asks for
  another example, it writes a **new similar example**, runs it in the same tool and explains it. After the explanation it asks
  again, waits 8 s, and closes the window when there are no more doubts.

Jupyter needs (once, in the Python the trainer uses): `pip install notebook nbconvert ipykernel numpy pandas scikit-learn matplotlib`
(the packages the AI syllabus imports). Without it, AI classes automatically fall back to the board. Settings:
`TUTOR_RUNNER` (vscode|jupyter|board, overrides the default but not an explicit `@run`), `TUTOR_JUPYTER_PORT` (8899),
`TUTOR_JUPYTER_TIMEOUT_SEC` (120 per run), `TUTOR_JUPYTER_BROWSER` (Chrome/Edge path for the notebook window).
Windows only, like the other agent tools below (`TUTOR_TOOLS=off` disables VS Code/Jupyter too).

## How it hooks into Meet (no virtual audio cable)
- Chrome profile is `.browser-profile/`. A script injected before Meet loads replaces the microphone with a
  WebAudio stream (trainer speech goes in there) and taps participants' audio for speech detection.
- Screen share: the board tab is titled "AI Tutor Board" and Chrome is launched with
  `--auto-select-desktop-capture-source`, so "Present now" picks it without a dialog.
- **Account**: Meet usually needs a signed-in account for the trainer. Run `npm run login` once and sign in
  to a Google account (use a separate one, not yours). Without login it tries to join as a guest, which only
  works if your meeting allows it.
- Host settings: allow participants to **share their screen** (or make the trainer co-host).

## Settings (`.env`, all optional)
`TUTOR_NAME` (display name) - `TUTOR_VAD_THRESHOLD` (0.012; raise if noise triggers it) - `TUTOR_VAD_SILENCE_MS` (1200) -
`TUTOR_RUN_TIMEOUT_SEC` (10) - `TUTOR_DOUBT_WAIT_SEC` (8) - `TUTOR_LLM_PROVIDER` (sarvam|openai) - `PYTHON_CMD` -
`CHROME_PATH` - `MEET_ADMIT_TIMEOUT_MIN` (10) - `TUTOR_PORT` (7100). TTS provider: top of `tts.js` (unchanged).

## Notes
- Code runs **on this machine, unsandboxed**, with a timeout - only use syllabi you wrote/trust.
- Use headphones on the host side, otherwise the trainer's voice can echo back through your mic and look like an interruption.
- Files: `index.js` CLI - `lesson.js` teaching engine - `syllabus.js` parser - `runner.js` code execution -
  `meet.js` + `browser-inject.js` Meet automation - `board.js`/`server.js`/`public/` the shared screen.

## Agent tools (Windows)
When a student asks to "explain step by step", draw/show something, or says it is not clear (English, Tanglish or Tamil),
the tutor decides what helps and puts it on screen while it explains aloud:
- **VS Code**: a short commented example (the syllabus code if it fits, otherwise a new one, e.g. for "explain functions") is
  written to a demo folder, opened in its own VS Code window, run, and the output is added to the file as comments.
- **Paint**: a flow diagram (PNG).

When the explanation ends the VS Code window is closed and the Meet tab is brought back to the front. The demo VS Code uses its
own profile, so your own VS Code windows are never closed. Only these whitelisted actions exist - the LLM never runs commands.
Settings: `TUTOR_TOOLS=off` disables it; `TUTOR_VSCODE_DIR` (demo folder, default `tools-output/vscode-demo`),
`TUTOR_VSCODE_PATH`, `TUTOR_PAINT_PATH`. The code runs with the same interpreters as the syllabus code (python, node, java, gcc).
Share your **entire screen** in Meet so students can see these windows.
