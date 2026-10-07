// One-time sign-in: opens a normal Chrome window on the trainer's profile so you can log
// in to the Google account the bot will use in Meet. Close the window when done.
// (Signing in through a normal, non-automated window avoids Google's "browser not secure" block.)
const { spawn } = require("child_process");
const { PROFILE_DIR, chromePath } = require("./meet");

const exe = chromePath();
if (!exe) {
  console.error("Chrome not found. Set CHROME_PATH in .env.");
  process.exit(1);
}
console.log("Sign in to the trainer's Google account in the window that opens, then close it.");
spawn(exe, [`--user-data-dir=${PROFILE_DIR}`, "--no-first-run", "https://accounts.google.com/"], { detached: true, stdio: "ignore" }).unref();
