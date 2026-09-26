#!/usr/bin/env node
/* End-to-end: nothing said on a call is lost (0.5.0).
 *
 * Replays call 0e88e803c97a, where the voice answered "what will persist once I end the call?"
 * itself (wrongly) and Claude never heard it, then adds an instruction spoken right before the
 * user presses End call. Passes when:
 *   - the question reached Claude DURING the call (delegated by the voice, or handed over by the
 *     page because the voice kept it to itself), and
 *   - the last instruction, which nobody could answer on the call, is done by Claude in the
 *     session AFTER the call ended.
 *
 *   fake mic (SAPI WAV) -> headless Chrome on the real call page -> OpenAI gpt-live-1
 *   -> bridge -> a REAL `claude -p` with this plugin loaded.
 *
 * Costs real money on the OpenAI key (about $0.05 a minute, a run is ~1.5 minutes). Needs the
 * same env as run.mjs: TTC_E2E_OPENAI_KEY, PUPPETEER_FROM, optional CHROME_PATH. Windows only
 * (the question audio is synthesised with SAPI).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEY = (process.env.TTC_E2E_OPENAI_KEY || "").trim();
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUPPETEER_FROM = process.env.PUPPETEER_FROM || path.join(ROOT, "package.json");
const LINES = [
  "Hello.",
  "I want you to explain to me what type of things I can tell you, and then, what will persist in the session once I end the call?",
  "One more thing. Create a file called banana dot t x t containing the word yellow.",
];
const GAPS = [6, 5, 22, 0];   // seconds of silence before each line, and after the last

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), "ttc-left-"));
const WORK = path.join(RUN, "work");
const DATA = path.join(RUN, "data");
const URL_FILE = path.join(RUN, "url.txt");
const T0 = Date.now();
const say = (...a) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!KEY) { console.error("TTC_E2E_OPENAI_KEY is not set"); process.exit(2); }
if (process.platform !== "win32") { console.error("Windows only (SAPI speech)"); process.exit(2); }
say(`run dir ${RUN} (key ends in ${KEY.slice(-4)})`);
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(WORK, "README.md"), "# scratch\n");

/* ------------------------------------------------------------- audio -- */
function speak(sentence, file) {
  const ps = [
    "Add-Type -AssemblyName System.Speech",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    "$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)",
    `$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}', $f)`,
    `$s.Speak('${sentence.replace(/'/g, "''")}')`,
    "$s.Dispose()",
  ].join("; ");
  execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
  const buf = fs.readFileSync(file);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = buf.subarray(off + 8, off + 8 + size);
    if (id === "data") { data = buf.subarray(off + 8, off + 8 + size); break; }
    off += 8 + size + (size % 2);
  }
  return { fmt, data };
}
const parts = LINES.map((l, i) => speak(l, path.join(RUN, `line${i}.wav`)));
const fmt = parts[0].fmt;
const rate = fmt.readUInt32LE(4), block = fmt.readUInt16LE(12);
const pad = (s) => Buffer.alloc(Math.round(rate * s) * block);
// Silence after the last line keeps the fake mic sending audio (Chrome stops a %noloop track at EOF).
const pcm = Buffer.concat([...parts.flatMap((p, i) => [pad(GAPS[i]), p.data]), pad(200)]);
const head = Buffer.alloc(44);
head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8);
head.write("fmt ", 12); head.writeUInt32LE(16, 16); fmt.copy(head, 20, 0, 16);
head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
const WAV = path.join(RUN, "ask.wav");
fs.writeFileSync(WAV, Buffer.concat([head, pcm]));
say("question audio", WAV);

/* ------------------------------------------------------------ claude -- */
const env = { ...process.env, TTC_NO_BROWSER: "1", TTC_URL_FILE: URL_FILE, TTC_OPENAI_API_KEY: KEY, TTC_DATA_DIR: DATA, TTC_KEEP_TRANSCRIPTS: "1" };
delete env["OPENAI_API_KEY"];
const allowed = ["Glob", "Read", "Grep", "Write", "Bash(ls:*)", "PowerShell(Get-ChildItem:*)"];
const args = ["-p", "/talk", "--plugin-dir", ROOT, "--output-format", "stream-json", "--verbose",
  "--allowedTools", allowed.join(","), "--permission-mode", "default",
  "--max-budget-usd", "4", "--no-session-persistence"];
say("claude", args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" "));
let claudeOut = "", claudeExit = null;
const claude = spawn(process.env.CLAUDE_BIN || "claude", args, { env, cwd: WORK, stdio: ["ignore", "pipe", "pipe"] });
claude.stdout.on("data", (d) => { claudeOut += d; fs.appendFileSync(path.join(RUN, "claude.jsonl"), d); });
claude.stderr.on("data", (d) => fs.appendFileSync(path.join(RUN, "claude.stderr.txt"), d));
claude.on("exit", (c) => { claudeExit = c; say("claude exited", c); });

let url = "";
for (let i = 0; i < 360 && !url && claudeExit === null; i++) {
  try { url = fs.readFileSync(URL_FILE, "utf8").trim(); } catch {}
  if (!url) await sleep(250);
}
if (!url) { say("FAIL: call_start never ran (see claude.jsonl)"); process.exit(1); }

/* ------------------------------------------------------------ chrome -- */
const puppeteer = createRequire(PUPPETEER_FROM)("puppeteer-core");
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${WAV}%noloop`, "--autoplay-policy=no-user-gesture-required",
    "--no-first-run", "--no-default-browser-check"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
const consoleLines = [];
page.on("console", (m) => consoleLines.push(m.type() + ": " + m.text()));
page.on("pageerror", (e) => consoleLines.push("pageerror: " + e.message));
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.click("#go");
say("pressed Start talking");

const logLines = () => page.evaluate(() => [...document.querySelectorAll("#log li")].map((li) => ({
  who: li.querySelector(".who").textContent, text: li.lastChild.textContent, cls: li.className,
})));
const interim = () => page.$eval("#interim", (el) => el.textContent);
let lastSeen = 0;
async function watch(label, done, seconds) {
  for (let i = 0; i < seconds * 4; i++) {
    const lines = await logLines();
    for (const l of lines.slice(lastSeen)) say(`page ${l.who}:`, l.text.slice(0, 200));
    lastSeen = lines.length;
    const hit = await done(lines);
    if (hit) return hit;
    if (claudeExit !== null) { say(`claude exited while waiting for ${label}`); return null; }
    await sleep(250);
  }
  say(`timed out waiting for ${label}`);
  return null;
}

// The last instruction: hang up the moment all of it has been heard, the way an impatient user
// does, so Claude cannot possibly finish it on the call. (Hanging up at the first word of it cuts
// the sentence, and a Claude that then asks for the missing word instead of guessing is right.)
const heardLast = await watch("the last instruction to be heard", async (lines) =>
  lines.some((l) => l.cls === "you" && /yellow/i.test(l.text)) || /^You:.*yellow/i.test(await interim()), 150);
await sleep(700);
await page.screenshot({ path: path.join(RUN, "1-before-hangup.png") });
if ((await page.$eval("#go", (b) => b.textContent)) === "End call") await page.click("#go");
say("pressed End call", heardLast ? "" : "(the last line was never heard)");
for (let i = 0; i < 60 && !(await page.$eval("#status", (el) => el.textContent)).startsWith("Call ended"); i++) await sleep(250);
const lines = await logLines();
await page.screenshot({ path: path.join(RUN, "2-ended.png") });
await Promise.race([browser.close(), sleep(8000)]);
try { browser.process() && browser.process().kill(); } catch {}

say("waiting for Claude to finish the leftovers");
for (let i = 0; i < 480 && claudeExit === null; i++) await sleep(500);
if (claudeExit === null) { say("claude still running 4 minutes after hang-up; killing"); claude.kill(); }

/* ----------------------------------------------------------- verdict -- */
const transcript = (() => {
  try {
    const dir = path.join(DATA, "calls");
    return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  } catch { return []; }
})();
const banana = fs.readdirSync(WORK).find((f) => /banana/i.test(f));
const bananaText = banana ? fs.readFileSync(path.join(WORK, banana), "utf8") : "";
const endedAt = transcript.findIndex((l) => l.role === "system" && /^call ended/.test(l.text));
const questionReq = transcript.find((l) => l.role === "request" && /persist|type of things|tell you/i.test(l.text));
const questionReqAt = transcript.indexOf(questionReq);
const results = [...claudeOut.matchAll(/"type":"result"[^\n]*"result":"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
const report = {
  run: RUN,
  heard: lines.filter((l) => l.cls === "you").map((l) => l.text),
  voice: lines.filter((l) => l.cls === "voice").map((l) => l.text),
  claude: lines.filter((l) => l.cls === "claude" || l.cls === "progress").map((l) => l.text),
  notes: lines.filter((l) => l.cls === "note").map((l) => l.text),
  questionHandedBy: !questionReq ? "nobody" : lines.some((l) => /did not pass that on/.test(l.text)) ? "the page (the voice kept it)" : "the voice",
  bananaFile: banana || null,
  finalReport: results.at(-1) || null,
  claudeExit,
  pageConsoleErrors: consoleLines.filter((l) => /^(error|pageerror)/.test(l)),
  PASS_question_reached_claude_during_call: Boolean(questionReq) && (endedAt < 0 || questionReqAt < endedAt),
  PASS_claude_answered_on_call: lines.some((l) => l.cls === "claude"),
  PASS_end_result_carried_conversation: /The whole conversation, oldest first/.test(claudeOut) && /banana/i.test(claudeOut),
  PASS_leftover_done_after_call: Boolean(banana) && /yellow/i.test(bananaText),
  PASS_hung_up_cleanly: claudeExit === 0,
};
fs.writeFileSync(path.join(RUN, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const ok = Object.entries(report).filter(([k]) => k.startsWith("PASS_")).every(([, v]) => v === true);
say(ok ? "E2E PASS" : "E2E FAIL");
process.exit(ok ? 0 : 1);
