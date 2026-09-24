#!/usr/bin/env node
/* End-to-end: a spoken question goes all the way through and the answer comes back spoken.
 *
 *   fake mic (a WAV) -> headless Chrome on the real call page -> WebRTC -> OpenAI gpt-live-1
 *   -> session.delegation.created -> bridge -> a REAL `claude -p` with this plugin loaded,
 *   looping on call_next -> it counts files with its own tools -> call_say -> commentary
 *   -> the voice's own transcript carries the number.
 *
 * Costs real money on the OpenAI key (about $0.05 a minute of call, a run is 1-2 minutes) and
 * one short Claude session. Needs:
 *   TTC_E2E_OPENAI_KEY  an OpenAI key with gpt-live-1 access (never printed)
 *   PUPPETEER_FROM      a package.json whose node_modules has puppeteer-core
 *   CHROME_PATH         Chrome/Chromium binary (defaults to the usual Windows path)
 *   ASK_WAV             optional: the question as a WAV. On Windows one is synthesised.
 *
 * Usage: node test/e2e/run.mjs [--prompt "/talk-to-claude"]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const PROMPT = arg("--prompt", "/talk-to-claude");
// "default" pre-allows the delete; "auto" leaves it to auto mode's classifier (and our note to it).
const PERMISSION_MODE = arg("--permission-mode", "default");
const KEY = (process.env.TTC_E2E_OPENAI_KEY || "").trim();
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUPPETEER_FROM = process.env.PUPPETEER_FROM || path.join(ROOT, "package.json");
const QUESTION = "Please ask Claude how many markdown files are in this folder.";
const QUESTION2 = "Now please ask Claude to delete the file called note seven.";
const EXPECT = /\b(7|seven)\b/i;
const GAP_S = Number(process.env.E2E_GAP_SECONDS || 45);   // between the two questions

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), "ttc-e2e-"));
const WORK = path.join(RUN, "work");
const DATA = path.join(RUN, "data");
const URL_FILE = path.join(RUN, "url.txt");
const T0 = Date.now();
const say = (...a) => console.log(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!KEY) { console.error("TTC_E2E_OPENAI_KEY is not set"); process.exit(2); }
say(`run dir ${RUN} (key ends in ${KEY.slice(-4)})`);

/* ------------------------------------------------------------ fixture -- */
fs.mkdirSync(WORK, { recursive: true });
for (let i = 1; i <= 7; i++) fs.writeFileSync(path.join(WORK, `note-${i}.md`), `# note ${i}\n`);
fs.writeFileSync(path.join(WORK, "a.txt"), "a\n");
fs.writeFileSync(path.join(WORK, "b.js"), "b\n");

/* The question, with silence in front so it lands after the greeting, and after, so the fake
   mic keeps sending audio (Chrome stops the track when a %noloop file runs out). */
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

function wav() {
  if (process.env.ASK_WAV) return process.env.ASK_WAV;
  if (process.platform !== "win32") throw new Error("set ASK_WAV to a spoken WAV of: " + QUESTION + " ... " + QUESTION2);
  const one = speak(QUESTION, path.join(RUN, "ask1.wav"));
  const two = speak(QUESTION2, path.join(RUN, "ask2.wav"));
  const fmt = one.fmt;
  const rate = fmt.readUInt32LE(4), block = fmt.readUInt16LE(12);
  const pad = (s) => Buffer.alloc(Math.round(rate * s) * block);
  const pcm = Buffer.concat([pad(6), one.data, pad(GAP_S), two.data, pad(120)]);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0); head.writeUInt32LE(36 + pcm.length, 4); head.write("WAVE", 8);
  head.write("fmt ", 12); head.writeUInt32LE(16, 16); fmt.copy(head, 20, 0, 16);
  head.write("data", 36); head.writeUInt32LE(pcm.length, 40);
  const out = path.join(RUN, "ask.wav");
  fs.writeFileSync(out, Buffer.concat([head, pcm]));
  return out;
}
const WAV = wav();
say("question audio", WAV);

/* -------------------------------------------------------------- claude -- */
const env = { ...process.env, TTC_NO_BROWSER: "1", TTC_URL_FILE: URL_FILE, TTC_OPENAI_API_KEY: KEY, TTC_DATA_DIR: DATA, TTC_KEEP_TRANSCRIPTS: "1" };
delete env["OPENAI_API_KEY"];
/* The call tools are deliberately NOT pre-allowed here: the plugin's own PreToolUse hook has to
   approve them, or this run stalls on the first call_start. In auto mode the delete is not
   pre-allowed either: auto mode's classifier decides, with the plugin's note about where the
   request came from. */
const allowed = ["Glob", "Read", "Grep", "Bash(ls:*)", "PowerShell(Get-ChildItem:*)"];
if (PERMISSION_MODE === "default") allowed.push("Bash(rm:*)", "PowerShell(Remove-Item:*)");
const args = ["-p", PROMPT, "--plugin-dir", ROOT, "--output-format", "stream-json", "--verbose",
  "--allowedTools", allowed.join(","), "--permission-mode", PERMISSION_MODE,
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
say("call link", url.replace(/\/launch\/.*/, "/launch/<one-time>"));

/* -------------------------------------------------------------- chrome -- */
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
say("page", page.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, ""));
const reuse = await (await fetch(url, { redirect: "manual" })).status;
say("reusing the one-time link answers", reuse);
await page.screenshot({ path: path.join(RUN, "1-ready.png") });
// A CDP click is a trusted gesture, so the page may open the mic and play audio.
await page.click("#go");
say("pressed Start talking");

const logLines = () => page.evaluate(() => [...document.querySelectorAll("#log li")].map((li) => ({
  who: li.querySelector(".who").textContent, text: li.lastChild.textContent, cls: li.className,
})));
const status = () => page.evaluate(() => document.getElementById("status").textContent + " | " + document.getElementById("detail").textContent);
let lastStatus = "";
async function watch(label, done, seconds) {
  for (let i = 0; i < seconds * 2; i++) {
    const s = await status();
    if (s !== lastStatus) { say("page:", s.slice(0, 160)); lastStatus = s; }
    const lines = await logLines();
    const hit = await done(lines);
    if (hit) return hit;
    if (claudeExit !== null) { say(`claude exited while waiting for ${label}`); return null; }
    await sleep(500);
  }
  say(`timed out waiting for ${label}`);
  return null;
}

// 1. The count.
const firstAnswer = await watch("the first answer", (lines) => lines.find((l) => l.cls === "claude" && EXPECT.test(l.text)), 150);
if (firstAnswer) say("Claude answered:", firstAnswer.text);
const firstSpoken = await watch("the voice to say it", async (lines) => {
  const i = lines.findIndex((l) => l.cls === "claude" && EXPECT.test(l.text));
  if (i < 0) return null;
  const logged = lines.slice(i + 1).find((l) => l.cls === "voice" && EXPECT.test(l.text));
  const live = await page.$eval("#interim", (el) => el.textContent);
  return logged ? logged.text : (/^Voice:/.test(live) && EXPECT.test(live) ? live : null);
}, 25);
if (firstSpoken) say("the voice said:", firstSpoken);
await page.screenshot({ path: path.join(RUN, "2-answered.png") });

// 2. The delete: must come as an approval card, and must not happen before the click.
const card = await watch("the approval card", async () => {
  const shown = await page.$eval("#confirmBox", (el) => !el.hidden);
  return shown ? await page.$eval("#confirmAction", (el) => el.textContent) : null;
}, 150);
let approvedAction = null, fileStillThereAtCard = null;
if (card) {
  approvedAction = card;
  fileStillThereAtCard = fs.existsSync(path.join(WORK, "note-7.md"));
  say("approval card:", card, "| file still there:", fileStillThereAtCard);
  await page.screenshot({ path: path.join(RUN, "3-approval.png") });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await page.screenshot({ path: path.join(RUN, "3-approval-phone.png"), fullPage: true });
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
  await page.click("#approve");
  say("pressed Approve");
}
const deletedAnswer = await watch("the delete answer", (lines) =>
  lines.find((l) => l.cls === "claude" && /delet|remov/i.test(l.text) && !/approve/i.test(l.text)), 120);
if (deletedAnswer) say("Claude answered:", deletedAnswer.text);
await sleep(6000);   // let the voice say it
await page.screenshot({ path: path.join(RUN, "4-deleted.png") });

// Hang up the way a user does, and the session must be let go of.
if ((await page.$eval("#go", (b) => b.textContent)) === "End call") await page.click("#go");
say("pressed End call");
for (let i = 0; i < 60 && !(await status()).startsWith("Call ended"); i++) await sleep(250);
const finalStatus = await status();
const lines = await logLines();
await page.screenshot({ path: path.join(RUN, "5-ended.png") });
// Closing a headless Chrome that holds a fake capture device can hang; do not let it.
await Promise.race([browser.close(), sleep(8000)]);
try { browser.process() && browser.process().kill(); } catch {}

for (let i = 0; i < 240 && claudeExit === null; i++) await sleep(500);
if (claudeExit === null) { say("claude still running 2 minutes after hang-up; killing"); claude.kill(); }

/* ------------------------------------------------------------- verdict -- */
const transcript = (() => {
  try {
    const dir = path.join(DATA, "calls");
    return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l)));
  } catch { return []; }
})();
const toolCalls = [...claudeOut.matchAll(/"name":"(mcp__plugin_[^"]+)"/g)].map((m) => m[1].replace(/^.*__/, ""));
const denials = [...claudeOut.matchAll(/"permission_denials":(\[[^\]]*\])/g)].map((m) => m[1]).filter((d) => d !== "[]");
const report = {
  run: RUN,
  permissionMode: PERMISSION_MODE,
  heard: lines.filter((l) => l.cls === "you").map((l) => l.text),
  voice: lines.filter((l) => l.cls === "voice").map((l) => l.text),
  claude: lines.filter((l) => l.cls === "claude" || l.cls === "progress").map((l) => l.text),
  approvalCard: approvedAction,
  errors: lines.filter((l) => l.cls === "err").map((l) => l.text),
  finalStatus,
  toolCalls,
  permissionDenials: denials,
  claudeExit,
  transcriptRoles: [...new Set(transcript.map((l) => l.role))],
  pageConsoleErrors: consoleLines.filter((l) => /^(error|pageerror)/.test(l)),
  PASS_link_is_one_time: reuse === 410,
  PASS_heard: lines.some((l) => l.cls === "you" && /markdown|files|folder/i.test(l.text)),
  PASS_delegated: transcript.some((l) => l.role === "request"),
  PASS_claude_answered: Boolean(firstAnswer),
  PASS_voice_said_it: Boolean(firstSpoken),
  PASS_delete_needed_a_click: Boolean(card) && /note-7/i.test(card) && fileStillThereAtCard === true,
  PASS_delete_done_after_click: !fs.existsSync(path.join(WORK, "note-7.md")) && Boolean(deletedAnswer),
  PASS_hook_approved_tools: toolCalls.includes("call_start") && !denials.some((d) => /call_/.test(d)),
  PASS_hung_up_cleanly: /^Call ended/.test(finalStatus) && claudeExit === 0,
};
fs.writeFileSync(path.join(RUN, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
const ok = Object.entries(report).filter(([k]) => k.startsWith("PASS_")).every(([, v]) => v === true);
say(ok ? "E2E PASS" : "E2E FAIL");
process.exit(ok ? 0 : 1);
