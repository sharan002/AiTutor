# AI Programming Trainer for Google Meet

Give it a syllabus `.txt` and a Meet link. The trainer joins as a participant, **shares a board tab**
(notes + code editor + terminal), teaches by voice, **types and runs the code** from your `#code#` blocks,
answers doubts when anyone speaks, and **continues from where it stopped** next time. You stay the host.

```
npm install
npm test                                   # offline self-test (no keys, no Meet)
npm run login                              # once: sign in the trainer's Google account (optional, see below)
npm run preview -- python.txt              # try a lesson without Meet: open http://localhost:7100/?local=1
npm run teach -- https://meet.google.com/hhs-yvpi-ywe python.txt
npm run teach -- https://meet.google.com/thm-uvbp-wno python.txt -- --restart   # ignore saved progress, start from block 1
```

Reads `../.env` (Sarvam keys etc. - same as before). Needs Chrome, plus whatever compilers/interpreters your
syllabus uses (python, node, java 11+, gcc/g++).

## Syllabus format (`syllabus/python.txt`)

```
@title: Python for Beginners      optional: @language: ta-IN | en-IN | hi-IN ..., @code: python, @instructions: ...

# Variables                       heading = topic
Plain lines are what the trainer must teach (notes / key points). The LLM expands them into speech.

#code#                            code block (also "#code js#"); end with #/code# (or #endcode# / another #code#)
x = 5
print(x)
#/code#
```
Code language defaults to the file name (`python.txt` -> python). You can append new topics later; progress is kept.

## What happens in class
1. Trainer joins -> you **admit it** from your Meet window -> it presents the board tab automatically.
2. For each text block it explains the notes. For each `#code#` block it types the code on the board,
   walks through it, **runs it** (output appears in the terminal pane), then explains the output/error.
3. After each topic it asks for doubts and waits a few seconds (`TUTOR_DOUBT_WAIT_SEC`, default 8).
4. **Anyone speaking pauses the trainer** -> speech is transcribed (Sarvam STT) -> answered with the current
   notes/code/output as context -> the interrupted sentence is replayed and the lesson continues.
   Typed doubts work too: open `http://localhost:7100/?local=1` and use the box top-right.
5. Progress is saved in `progress/<syllabus>.json` after every block. Stop with Ctrl+C any time; run the same
   command again to resume ("welcome back, last time we covered ...").

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
