#!/usr/bin/env node
/* Deterministic page-side simulation of the 0.5.0 "nothing said is lost" behaviour (1-7) and the
 * 0.6.0 rich parity features (8-17): what Claude shows on screen, files both ways, Stop and
 * spoken cancel, the permission banner, the phone layout and the files that never went with a
 * request.
 *
 * The REAL bridge (server/bridge.mjs over stdio) and the REAL call page (server/call.html) in
 * headless Chrome. Only the two things that would cost money or need hardware are faked:
 *   - OpenAI's HTTP side: mockOpenAI() answers POST /v1/live/sessions.
 *   - The browser's media side: getUserMedia returns a silent AudioContext stream, and
 *     RTCPeerConnection is a stub whose data channel records what the page sends (window.__sent)
 *     and lets this harness play gpt-live-1's events into the page (window.__dc.onmessage).
 * Claude's side is driven with the MCP tools (call_next / call_say / call_instruct). The hooks'
 * side (/notify) is driven with the hook token, the way hooks/guard.mjs does it.
 *
 * No OpenAI call, no Claude session, no cost. About 5 minutes. Screenshots of the new cards go
 * to test/e2e/out/ (gitignored).
 *
 * Usage: node test/e2e/page_sim.mjs            all scenarios
 *        node test/e2e/page_sim.mjs 1 6        only scenarios 1 and 6
 * Env:   PUPPETEER_FROM  a package.json whose node_modules has puppeteer-core
 *        CHROME_PATH     Chrome binary
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { startBridge, mockOpenAI, sleep, ROOT } from "../helpers.mjs";

const PUPPETEER_FROM = process.env.PUPPETEER_FROM || "E:/FromC/projects/agency-board/package.json";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ONLY = process.argv.slice(2).filter((a) => /^\d+[a-z]?$/.test(a));
const T0 = Date.now();
const say = (...a) => console.error(`[+${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);

// The user's real question from call 0e88e803c97a, which the voice answered on its own.
const QUESTION = "I want you to explain to me what type of things can I tell you, and then like what will persist in the session once I end the call";

/* --------------------------------------------------------- page stubs -- */

/* Runs in the page before its own script. Serialised by puppeteer, so it must be self-contained. */
function pageStub() {
  window.__sent = [];
  window.__dc = null;
  const fakeMic = async () => {
    const ac = new AudioContext();
    return ac.createMediaStreamDestination().stream;
  };
  if (navigator.mediaDevices) navigator.mediaDevices.getUserMedia = fakeMic;
  else Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: fakeMic }, configurable: true });

  class FakeDataChannel {
    constructor(label) { this.label = label; this.readyState = "open"; this.onmessage = null; }
    send(s) { window.__sent.push(Object.assign(JSON.parse(s), { __at: Date.now() })); }
    close() { this.readyState = "closed"; }
    addEventListener() {}
    removeEventListener() {}
  }
  class FakePeerConnection {
    constructor() {
      this.iceGatheringState = "complete";
      this.connectionState = "connected";
      this.localDescription = null;
      this.remoteDescription = null;
      this.ontrack = null;
      this.onconnectionstatechange = null;
    }
    addTrack() {}
    createDataChannel(label) { const dc = new FakeDataChannel(label); window.__dc = dc; return dc; }
    async createOffer() { return { type: "offer", sdp: "v=0 fake" }; }
    async setLocalDescription() { this.localDescription = { type: "offer", sdp: "v=0 fake" }; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    addEventListener() {}
    removeEventListener() {}
    close() { this.connectionState = "closed"; }
  }
  window.RTCPeerConnection = FakePeerConnection;
}

/* -------------------------------------------------------------- tools -- */

const live = (page, ev) => page.evaluate((e) => { window.__dc.onmessage({ data: JSON.stringify(e) }); }, ev);

/* Live sends transcripts as fragments; three words at a time, 120 ms apart, like a real stream. */
async function chunked(page, type, text) {
  const words = text.split(" ");
  for (let i = 0; i < words.length; i += 3) {
    await live(page, { type, delta: (i ? " " : "") + words.slice(i, i + 3).join(" ") });
    await sleep(120);
  }
}
const userSays = (page, text) => chunked(page, "session.input_transcript.delta", text);
const voiceSays = (page, text) => chunked(page, "session.output_transcript.delta", text);
const delegation = (page, id) => live(page, { type: "session.delegation.created", delegation: { id } });

const sent = (page) => page.evaluate(() => window.__sent);
const commentaries = async (page) => (await sent(page)).filter((m) => m.type === "session.commentary.append");
const logLines = (page) => page.evaluate(() => [...document.querySelectorAll("#log li")].map((li) => ({
  who: li.querySelector(".who").textContent, text: li.querySelector(".text").textContent, cls: li.className,
  show: Boolean(li.querySelector("button.show")),
})));
const status = (page) => page.evaluate(() => document.getElementById("status").textContent + " | " + document.getElementById("detail").textContent);

function timed(p) { return p.then((text) => ({ text, at: Date.now() })); }
const firstLine = (s) => String(s).split("\n")[0].slice(0, 220);
const count = (hay, needle) => hay.split(needle).length - 1;

async function until(fn, ms, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error("timed out after " + ms + "ms waiting for " + what);
}

/* What the bridge wrote down (TTC_KEEP_TRANSCRIPTS=1 in startBridge): every request, every line. */
function transcript(b) {
  try {
    const dir = path.join(b.data, "calls");
    return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  } catch { return []; }
}
const requests = (b) => transcript(b).filter((l) => l.role === "request").map((l) => l.text);

/* ------------------------------------------------------- 0.6.0 tools -- */

const OUT = path.join(ROOT, "test", "e2e", "out");
const FENCE = "```";

// Everything the page sends that OpenAI reads. Display text, file names and activity must never be in it.
const toVoice = async (page) => (await sent(page)).filter((m) => /^session\.(commentary|thinking|instructions)\.append$/.test(m.type));
const thinkings = async (page) => (await sent(page)).filter((m) => m.type === "session.thinking.append");
async function leaks(page, needles) {
  return (await toVoice(page)).filter((m) => needles.some((n) => String(m.content).includes(n))).map((m) => m.content);
}

/* The hooks' side of the bridge, reached exactly like hooks/guard.mjs: port and hook token from
   the handover file only this user can read, and no Origin header. */
function hookSide(b) {
  const port = Number(new URL(b.launchUrl()).port);
  const f = JSON.parse(fs.readFileSync(path.join(b.data, "bridges", `${port}.json`), "utf8"));
  return { base: `http://127.0.0.1:${port}/c/${f.call}`, token: f.hookToken };
}
async function hookPost(b, sub, body) {
  const h = hookSide(b);
  const r = await fetch(h.base + sub, {
    method: "POST", headers: { "content-type": "application/json", "x-ttc-hook": h.token }, body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
}

/* A real PNG (solid colour), so a thumbnail can prove it decoded: naturalWidth > 0. */
function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, [r, g, b]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([r, g, b], y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
    len.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;   // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function scratch(b, name) {
  const d = path.join(b.data, name);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* The request's "Files the user shared with this request" block (or another heading's, such as the
   end-of-call hand-off's never-sent list): one "- <path> (<type>, <size>)" line per file. */
function sharedPaths(reqText, heading = "Files the user shared with this request") {
  const i = reqText.indexOf(heading);
  if (i < 0) return [];
  const out = [];
  for (const l of reqText.slice(i).split("\n").slice(1)) {
    const m = /^- (.+) \([^()]*\)$/.exec(l.trim());
    if (!m) break;
    out.push(m[1]);
  }
  return out;
}

const chipTexts = (page) => page.evaluate(() => [...document.querySelectorAll("#chips .chip-text")].map((c) => c.textContent));
const readyChips = async (page) => (await chipTexts(page)).filter((t) => !t.startsWith("uploading "));
const reqRows = (page) => page.evaluate(() => [...document.querySelectorAll("#reqs > li")].map((li) => {
  const btn = li.querySelector(".req-top button");
  return {
    label: li.querySelector(".req-label").textContent,
    btn: btn ? { label: btn.getAttribute("aria-label"), disabled: btn.disabled, text: btn.textContent } : null,
  };
}));
const screenPos = (page) => page.evaluate(() => {
  const box = document.getElementById("screenBox");
  return box.hidden ? "" : document.getElementById("screenPos").textContent;
});

/* A normal voice hand-over that Claude picks up, so a request is in flight. */
async function delegate(b, page, text, id) {
  const next = timed(b.tool("call_next", { wait_seconds: 30 }));
  await userSays(page, text);
  await sleep(1000);
  await delegation(page, id);
  await sleep(150);
  await voiceSays(page, "On it.");
  return next;
}

/* Desktop 1280 and phone 390, at twice the pixels, then back to the harness's default viewport. */
async function shots(page, name, selector) {
  fs.mkdirSync(OUT, { recursive: true });
  const saved = [];
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await sleep(350);
    const el = await page.$(selector);
    const box = el && await el.boundingBox();
    if (!box) continue;
    const file = path.join(OUT, `${name}-${w}.png`);
    await el.screenshot({ path: file });
    saved.push(path.relative(ROOT, file).replace(/\\/g, "/"));
  }
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  return saved.join(", ") || "none (element not visible)";
}

/* Interactive things that overlap each other (outside the boxes that scroll on their own). */
const overlaps = (page) => page.evaluate(() => {
  const name = (e) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (e.getAttribute("aria-label") ? `[${e.getAttribute("aria-label")}]` : "");
  const els = [...document.querySelectorAll("button, input:not([type=file]), a, summary")].filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && !e.closest("#screenBody, #log, .req-steps ol");
  });
  const out = [];
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
    const a = els[i].getBoundingClientRect(), c = els[j].getBoundingClientRect();
    const w = Math.min(a.right, c.right) - Math.max(a.left, c.left), h = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
    if (w > 1 && h > 1) out.push(name(els[i]) + " x " + name(els[j]));
  }
  return out;
});

/* ---------------------------------------------------------- the frame -- */

let browser;

/* A fresh bridge, a fresh mock OpenAI and a fresh browser context per scenario, with the call
   already live (Start pressed, the fake voice session started), exactly like a user's call. */
async function scenario(num, name, fn) {
  if (ONLY.length && !ONLY.includes(String(num))) return null;
  const started = Date.now();
  const evidence = [];
  let passed = true;
  const check = (cond, label, detail) => {
    const line = `${cond ? "ok" : "FAIL"}: ${label}${detail !== undefined ? ` [${detail}]` : ""}`;
    evidence.push(line);
    if (!cond) passed = false;
    say(`#${num}`, line);
  };
  const mock = await mockOpenAI();
  const b = startBridge({
    TTC_OPENAI_BASE: mock.base,
    TTC_OPENAI_API_KEY: "sk-test-" + "x".repeat(40),
    TTC_PAGE_GONE_SECONDS: "3600",
  });
  let ctx = null, page = null;
  const pageErrors = [], consoleErrors = [], dialogs = [];
  say(`#${num} ${name}: start`);
  try {
    await b.init();
    await b.tool("call_start", {});
    ctx = await browser.createBrowserContext();
    page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    // An alert() here means markdown from Claude ran as code.
    page.on("dialog", (d) => { dialogs.push(d.type() + ": " + d.message()); d.dismiss().catch(() => {}); });
    await page.evaluateOnNewDocument(pageStub);
    await page.goto(b.launchUrl(), { waitUntil: "domcontentloaded" });
    await until(async () => JSON.parse(await b.tool("call_status")).pageConnected, 8000, "the page's event stream");
    await page.click("#go");
    await until(async () => (await status(page)).startsWith("Connecting audio"), 8000, "the (mock) voice session to open");
    await live(page, { type: "session.started" });
    await until(async () => (await page.$eval("#go", (el) => el.textContent)) === "End call", 4000, "the page to go live");
    await until(async () => JSON.parse(await b.tool("call_status")).state === "live", 4000, "the bridge to see the call live");
    await fn({ b, page, mock, check, ctx, info: (label) => { evidence.push("info: " + label); say(`#${num}`, "info: " + label); } });
    check(pageErrors.length === 0, "no uncaught errors in the page", pageErrors.join(" | ") || "none");
    check(dialogs.length === 0, "no alert or confirm dialog ever opened", dialogs.join(" | ") || "none");
    const again = (await commentaries(page)).filter((c) => /say it again/i.test(c.content));
    check(again.length === 0, "the voice was never told 'Could you say it again'", again.length ? again.map((c) => c.content).join(" | ") : "none");
  } catch (e) {
    passed = false;
    evidence.push("FAIL: " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join(" / ") : e));
    say(`#${num} threw`, e && e.message);
    if (page) { try { evidence.push("page status: " + await status(page)); } catch {} }
  } finally {
    if (consoleErrors.length) evidence.push("page console errors (info): " + consoleErrors.slice(0, 5).join(" | "));
    if (ctx) { try { await Promise.race([ctx.close(), sleep(4000)]); } catch {} }
    b.stop();
    mock.close();
    await sleep(200);
    try { fs.rmSync(b.data, { recursive: true, force: true }); } catch {}
  }
  evidence.push(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);
  say(`#${num} ${name}: ${passed ? "PASS" : "FAIL"}`);
  return { name: `${num}. ${name}`, passed, evidence: evidence.join("\n") };
}

/* ---------------------------------------------------------- scenarios -- */

const SCENARIOS = [];
const def = (num, name, fn) => SCENARIOS.push(() => scenario(num, name, fn));

def(1, "the real failing call: the voice answers a question itself and never delegates", async ({ b, page, check }) => {
  const next = timed(b.tool("call_next", { wait_seconds: 40 }));
  await voiceSays(page, "Hi, Claude is listening. What should we work on?");
  await sleep(1500);
  await userSays(page, "Hello");
  await sleep(700);
  await voiceSays(page, "Hi there!");
  await sleep(1200);
  await userSays(page, QUESTION);
  const qEnd = Date.now();
  await sleep(1000);
  await voiceSays(page, "Nothing from this chat carries over.");
  const r = await next;
  const secs = (r.at - qEnd) / 1000;
  check(/^REQUEST r1 \(/.test(r.text), "call_next returned REQUEST r1", firstLine(r.text));
  check(r.text.includes("the voice did not hand this over"), "labelled 'the voice did not hand this over'");
  check(r.text.includes(QUESTION), "the request carries the user's exact question");
  check(r.text.includes("Voice: Nothing from this chat carries over."), "the voice's wrong self-answer is in the context Claude gets");
  check(secs <= 12, "handed to Claude within 12s of the question", `${secs.toFixed(1)}s after the question ended`);
  const note = (await logLines(page)).find((l) => /did not pass that on/.test(l.text));
  check(Boolean(note), "the page log says it went to Claude directly", note && note.text);

  const ANSWER = "Everything you say on this call is kept. I work on it while we talk, and when the call ends I read the whole conversation and finish anything left over.";
  const said = await b.tool("call_say", { id: "r1", text: ANSWER });
  check(/as the answer to r1/.test(said), "call_say closed r1", firstLine(said));
  const c = await until(async () => (await commentaries(page)).find((m) => m.content.includes(ANSWER)), 4000, "Claude's answer as commentary");
  check(c.content.startsWith("Claude's answer: ") && c.delegation_id === null,
    "the page sent Claude's answer to the voice as session.commentary.append", `delegation_id=${c.delegation_id} content="${c.content.slice(0, 80)}..."`);
});

def(2, "greeting only: nothing is handed over", async ({ b, page, check }) => {
  await voiceSays(page, "Hi, Claude is listening. What should we work on?");
  await sleep(1500);
  const next = timed(b.tool("call_next", { wait_seconds: 12 }));
  await userSays(page, "Hello");
  await sleep(700);
  await voiceSays(page, "Hi! What would you like to work on?");
  const r = await next;
  check(/^Nothing new yet \(waited 12s\)/.test(r.text), "call_next(wait 12) returned nothing new", firstLine(r.text));
  check(requests(b).length === 0, "no request was created", `requests=${JSON.stringify(requests(b))}`);
  const lines = await logLines(page);
  check(!lines.some((l) => /did not pass that on/.test(l.text)), "the page did not hand the greeting over");
  check(lines.some((l) => l.cls === "you" && l.text === "Hello"), "the greeting is still in the page log", "You: Hello");
});

def(3, "normal delegation: exactly one request, nothing overheard", async ({ b, page, check }) => {
  const Q = "How many markdown files are in this folder?";
  const next = timed(b.tool("call_next", { wait_seconds: 30 }));
  await userSays(page, Q);
  await sleep(1000);
  await delegation(page, "del_s3");
  await sleep(150);
  await voiceSays(page, "Let me check.");
  const r = await next;
  check(/^REQUEST r1 \(spoken by the user, transcribed, so words can be misheard\):/.test(r.text), "REQUEST r1 as a voice hand-over", firstLine(r.text));
  check(!r.text.includes("did not hand this over"), "not labelled as overheard");
  check(r.text.includes(`"${Q}"`), "carries the question");
  const said = await b.tool("call_say", { id: "r1", text: "There are seven markdown files in this folder." });
  const c = await until(async () => (await commentaries(page)).find((m) => m.content.includes("seven markdown files")), 4000, "the answer as commentary");
  check(c.delegation_id === "del_s3", "the answer went back under the voice's delegation id", `delegation_id=${c.delegation_id}; ${firstLine(said)}`);
  await voiceSays(page, "There are seven markdown files.");
  const r2 = await timed(b.tool("call_next", { wait_seconds: 12 }));
  check(/^Nothing new yet \(waited 12s\)/.test(r2.text), "no second request within 12s", firstLine(r2.text));
  const reqs = requests(b);
  check(reqs.length === 1, "exactly one request in the bridge transcript", JSON.stringify(reqs));
  check(!(await logLines(page)).some((l) => /did not pass that on/.test(l.text)), "the safety net stayed quiet");
});

def(4, "late delegation after Claude already answered the overheard request", async ({ b, page, check }) => {
  const next = timed(b.tool("call_next", { wait_seconds: 30 }));
  await userSays(page, "What branch am I on right now?");
  await sleep(800);
  await voiceSays(page, "You're on main.");
  const r = await next;
  check(/^REQUEST r1 \(/.test(r.text) && r.text.includes("the voice did not hand this over"), "the question was overheard as r1", firstLine(r.text));
  const ANSWER = "You are on the branch called feature voice, not main.";
  await b.tool("call_say", { id: "r1", text: ANSWER });
  await until(async () => (await commentaries(page)).find((m) => m.content.includes(ANSWER)), 4000, "Claude's answer as commentary");
  await voiceSays(page, "Correction: you are on the feature voice branch, not main.");
  await sleep(1000);
  await delegation(page, "del_late");
  const late = await until(async () => (await sent(page)).find((m) => m.delegation_id === "del_late"), 6000, "the page's reply to the late delegation");
  check(late.type === "session.commentary.append" && /already answered/.test(late.content),
    "the late delegation got 'already answered' commentary", `${late.type}: "${late.content}"`);
  const r2 = await timed(b.tool("call_next", { wait_seconds: 8 }));
  check(/^Nothing new yet/.test(r2.text), "no new request for the late delegation", firstLine(r2.text));
  const reqs = requests(b);
  check(reqs.length === 1, "still exactly one request", JSON.stringify(reqs));
  const st = JSON.parse(await b.tool("call_status"));
  check(st.inFlight.length === 0 && st.queued.length === 0, "nothing left in flight or queued", `inFlight=${st.inFlight.length} queued=${st.queued.length}`);
});

def(5, "listening mode holds dictation, then hands it over as one request", async ({ b, page, check }) => {
  await voiceSays(page, "Hi, Claude is listening.");
  await sleep(500);
  const ins = await b.tool("call_instruct", { text: "You are now in listening mode.", mode: "listening" });
  await until(async () => (await logLines(page)).some((l) => /Claude told the voice: You are now in listening mode/.test(l.text)), 4000, "the listening instruction on the page");
  const toVoice = (await sent(page)).find((m) => m.type === "session.instructions.append" && /listening mode/.test(m.content));
  check(Boolean(toVoice), "the voice got the listening-mode instruction", `${firstLine(ins)} / ${toVoice && toVoice.content}`);
  const LINES = [
    "First note, the login page needs a dark mode.",
    "Second, the export button is too small on phones.",
    "Third, add a retry when the upload fails.",
  ];
  const next = timed(b.tool("call_next", { wait_seconds: 25 }));
  const d0 = Date.now();
  for (let i = 0; i < LINES.length; i++) {
    await userSays(page, LINES[i]);
    if (i < LINES.length - 1) await sleep(8000 - 400);
  }
  const r = await next;
  check(/^Nothing new yet \(waited 25s\)/.test(r.text), "no request during 25s of dictation with 8s pauses",
    `${firstLine(r.text)} (dictation spanned ${((Date.now() - d0) / 1000).toFixed(0)}s)`);
  check(requests(b).length === 0, "the bridge got no request while listening", JSON.stringify(requests(b)));
  const next2 = timed(b.tool("call_next", { wait_seconds: 15 }));
  const back = Date.now();
  await b.tool("call_instruct", { text: "Listening mode is over. Resume normal back-and-forth.", mode: "normal" });
  const r2 = await next2;
  const all = LINES.join(" ");
  check(/^REQUEST r1 \(/.test(r2.text) && r2.text.includes("the voice did not hand this over"),
    "leaving listening mode handed the dictation over as overheard r1", `${firstLine(r2.text)} (${((r2.at - back) / 1000).toFixed(1)}s after mode normal)`);
  check(r2.text.includes(`"${all}"`), "all three dictated lines in one request, in order");
  await sleep(500);
  check(requests(b).length === 1, "exactly one request", JSON.stringify(requests(b)));
});

/* End call before the line's own 2s flush. The line's own /transcript post is held back 1.5s
   here, so the hang-up (and the pending call_next's CALL ENDED) always wins that race: the words
   can only reach Claude through the hang-up's tail, and the late post must not add a copy. */
async function endRightAfterSpeaking({ b, page, check }, holdTranscriptMs) {
  let hold = false;
  const held = [];
  if (holdTranscriptMs) {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (hold && req.method() === "POST" && req.url().endsWith("/transcript")) {
        held.push(req.postData());
        setTimeout(() => req.continue().catch(() => {}), holdTranscriptMs);
      } else req.continue().catch(() => {});
    });
  }
  const next = timed(b.tool("call_next", { wait_seconds: 30 }));
  await userSays(page, "Commit the changes in the server folder.");
  await sleep(1000);
  await delegation(page, "del_s6");
  await sleep(150);
  await voiceSays(page, "On it.");
  const r1 = await next;
  check(/^REQUEST r1 /.test(r1.text), "the first request was delegated normally", firstLine(r1.text));
  await b.tool("call_say", { id: "r1", text: "Committed." });
  await until(async () => (await commentaries(page)).find((m) => m.content.includes("Committed.")), 4000, "the answer as commentary");
  await voiceSays(page, "Done, Claude committed them.");
  await sleep(600);
  const ended = timed(b.tool("call_next", { wait_seconds: 30 }));
  await sleep(200);
  hold = true;
  await userSays(page, "and push it to main");
  const buttonText = await page.$eval("#go", (el) => el.textContent);
  await page.click("#go");
  const clickedAt = Date.now();
  await sleep(300);
  await live(page, { type: "session.closed", usage: { seconds: 20 } });
  const r = await ended;
  check(buttonText === "End call", "clicked the End call button", `button said "${buttonText}"; ended ${((r.at - clickedAt) / 1000).toFixed(1)}s after the click`);
  check((await sent(page)).some((m) => m.type === "session.close"), "the page closed the voice session (session.close)");
  check(/^CALL ENDED \(You ended the call\.\)/.test(r.text), "the pending call_next returned CALL ENDED", firstLine(r.text));
  const flagged = r.text.split("\n").find((l) => l.includes("and push it to main"));
  check(/User \(NOT HANDED OVER to you during the call\): and push it to main/.test(r.text), "the last words are flagged NOT HANDED OVER", flagged);
  // Listed once in full at the top (the work) and referenced once in the conversation (its place).
  check(count(r.text, "NOT HANDED OVER to you during the call): and push it to main") === 1 && count(r.text, "not handed over, in full above): and push it to main") === 1, "listed once in full and referenced once in the conversation", `full=${count(r.text, "NOT HANDED OVER to you during the call): and push it to main")} ref=${count(r.text, "not handed over, in full above): and push it to main")}`);
  check(/User: Commit the changes in the server folder\./.test(r.text), "the delegated line is not flagged");
  check(/1 thing\(s\) the user said never reached you/.test(r.text), "the result counts 1 line that never reached Claude");
  if (holdTranscriptMs) check(held.some((p) => p && p.includes("and push it to main")), "the line's own /transcript post really was late (held)", `held ${held.length} post(s) for ${holdTranscriptMs}ms`);
  await sleep((holdTranscriptMs || 0) + 1500);
  const again = await b.tool("call_next", { wait_seconds: 5 });
  check(count(again, "NOT HANDED OVER to you during the call): and push it to main") === 1 && count(again, "not handed over, in full above): and push it to main") === 1, "after the line's own post landed, call_next still has it once", `full=${count(again, "NOT HANDED OVER to you during the call): and push it to main")} ref=${count(again, "not handed over, in full above): and push it to main")}`);
  const inTranscript = transcript(b).filter((l) => l.role === "user" && l.text === "and push it to main").length;
  check(inTranscript === 1, "the bridge transcript holds one copy", `copies=${inTranscript}`);
  const tail = transcript(b).filter((l) => l.role === "voice" && l.text === "Done, Claude committed them.").length;
  check(tail === 1, "the voice line carried in the same tail is not doubled either", `copies=${tail}`);
}

def(6, "End call right after speaking (line's own post held back, the hang-up wins the race)", (S) => endRightAfterSpeaking(S, 1500));
def("6b", "End call right after speaking (natural network order)", (S) => endRightAfterSpeaking(S, 0));

def(7, "Claude asked a question, the user just says OK", async ({ b, page, check }) => {
  const next = timed(b.tool("call_next", { wait_seconds: 30 }));
  await userSays(page, "Fix the typo in the changelog.");
  await sleep(1000);
  await delegation(page, "del_s7");
  await sleep(150);
  await voiceSays(page, "On it.");
  const r1 = await next;
  check(/^REQUEST r1 /.test(r1.text), "the first request was delegated normally", firstLine(r1.text));
  await b.tool("call_say", { id: "r1", text: "Should I also update the README?" });
  await until(async () => (await commentaries(page)).find((m) => m.content.includes("Should I also update the README?")), 4000, "the question as commentary");
  await voiceSays(page, "Claude fixed it and asks: should it also update the README?");
  await sleep(1500);
  const next2 = timed(b.tool("call_next", { wait_seconds: 20 }));
  await userSays(page, "OK.");
  const okAt = Date.now();
  const r2 = await next2;
  check(/^REQUEST r2 \(/.test(r2.text) && r2.text.includes("the voice did not hand this over"),
    "the bare 'OK.' was handed over as overheard r2", `${firstLine(r2.text)} (${((r2.at - okAt) / 1000).toFixed(1)}s after it)`);
  check(r2.text.includes('"OK."'), "the request text is the user's OK");
  check(r2.text.includes("Voice: Claude fixed it and asks: should it also update the README?"), "Claude gets the question it asked as context");
});

/* ------------------------------------------------ 0.6.0 rich parity -- */

const DISPLAY_NOTE = "Claude also put details on the user's screen, on the call page.";

const RICH = [
  "# Deploy notes ZEBRA7731",
  "Some **bold**, *italic*, ~~old~~ and `inline code`.",
  "",
  "<img src=x onerror=alert(1)>",
  "<script>window.__xss = 1</script>",
  "[x](javascript:alert(1))",
  "[docs](https://example.com/docs) and https://example.com/bare?q=1.",
  "",
  "| Step | Command | Result |",
  "|:-----|:-------:|-------:|",
  "| 1 | `npm test` | 42 passed |",
  "| 2 | deploy | ok |",
  "",
  FENCE + "js",
  "const answer = 42; // ZEBRA7731",
  'console.log("<b>not bold</b>");',
  FENCE,
  "",
  FENCE + "diff",
  "- old line",
  "+ new line",
  FENCE,
  "",
  "> quoted **note**",
  "",
  "1. first",
  "   - nested a",
  "   - nested b",
  "2. second",
  "",
  "שלום, זו פסקה בעברית עם קוד `npm test`.",
  "",
  "---",
].join("\n");

def(8, "On screen: markdown rendered safely (XSS payloads stay text), table, code with Copy, Hebrew, Show on screen", async ({ b, page, check, ctx, info }) => {
  const src = fs.readFileSync(path.join(ROOT, "server", "call.html"), "utf8");
  const banned = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"].filter((w) => src.includes(w));
  check(banned.length === 0, "call.html never uses innerHTML, outerHTML, insertAdjacentHTML or document.write", banned.join(", ") || "none");
  const origin = new URL(page.url()).origin;
  try { await ctx.overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]); } catch (e) { info("clipboard permissions not granted: " + e.message); }

  const r1 = await delegate(b, page, "Show me the deploy script and the test results.", "del_s8");
  check(/^REQUEST r1 /.test(r1.text), "the request reached Claude", firstLine(r1.text));
  info("the request's answer line: " + ((r1.text.match(/[^\n]*call_say[^\n]*/) || [""])[0].slice(0, 200)));
  const said = await b.tool("call_say", { id: "r1", text: "I put the script and the results on your screen.", display: RICH });
  check(/on screen/i.test(said), "the call_say result says what was shown", firstLine(said));
  await until(async () => (await screenPos(page)) === "1 of 1", 5000, "the On screen card");
  const v = await page.evaluate(() => {
    const body = document.getElementById("screenBody"), md = body.querySelector(".md");
    const heb = [...md.querySelectorAll("p")].find((p) => /[֐-׿]/.test(p.textContent));
    let rtl = null;
    try { rtl = heb ? heb.matches(":dir(rtl)") : null; } catch {}
    const t = md.querySelector(".tablewrap table");
    return {
      text: body.textContent, imgs: body.querySelectorAll("img").length, scripts: body.querySelectorAll("script").length,
      bolds: body.querySelectorAll("b").length, xss: window.__xss,
      links: [...body.querySelectorAll("a")].map((a) => ({ href: a.getAttribute("href"), text: a.textContent, target: a.target, rel: a.rel })),
      h3: (md.querySelector("h3") || {}).textContent,
      table: t ? { th: [...t.querySelectorAll("th")].map((x) => x.textContent), rows: t.querySelectorAll("tbody tr").length,
        mid: t.querySelectorAll("th")[1].style.textAlign, code: Boolean(t.querySelector("td code")) } : null,
      code: [...md.querySelectorAll(".code")].map((c) => ({ lang: c.querySelector(".code-lang").textContent, text: c.querySelector("pre code").textContent, copy: Boolean(c.querySelector(".code-bar button")) })),
      diff: { add: md.querySelectorAll(".d-add").length, del: md.querySelectorAll(".d-del").length },
      nested: md.querySelectorAll("ol > li > ul > li").length,
      quote: Boolean(md.querySelector("blockquote strong")),
      inlines: ["strong", "em", "del", "code"].filter((tag) => md.querySelector("p " + tag)),
      heb: heb ? { dir: heb.getAttribute("dir"), rtl } : null,
      // Text blocks read their own direction; lists, quotes and tables take their first words' (all English here).
      noDir: [...md.querySelectorAll("p, h3, h4, h5, h6, th, td")].filter((e) => e.getAttribute("dir") !== "auto").map((e) => e.tagName)
        .concat([...md.querySelectorAll("ul, ol, li, blockquote, table")].filter((e) => e.getAttribute("dir") !== "ltr").map((e) => e.tagName + "=" + e.getAttribute("dir"))),
      meta: document.getElementById("screenMeta").textContent,
      copyStatus: (() => { const s = md.querySelector(".code .code-bar [role=status]"); return s ? s.className : null; })(),
    };
  });
  check(v.xss === undefined && v.scripts === 0 && v.imgs === 0, "no script ran and no element was made from raw HTML", `__xss=${v.xss} scripts=${v.scripts} imgs=${v.imgs}`);
  check(v.text.includes("<img src=x onerror=alert(1)>") && v.text.includes("<script>window.__xss = 1</script>"), "raw HTML is shown as text");
  check(v.text.includes("[x](javascript:alert(1))") && !v.links.some((l) => /^\s*javascript:/i.test(l.href || "") || l.text === "x"), "[x](javascript:alert(1)) is text, not a link", JSON.stringify(v.links.map((l) => l.href)));
  check(v.links.length > 0 && v.links.every((l) => /^(https?:|mailto:)/.test(l.href)), "every link is http, https or mailto");
  const docs = v.links.find((l) => l.text === "docs");
  check(docs && docs.href === "https://example.com/docs" && docs.target === "_blank" && docs.rel === "noopener noreferrer", "a markdown link opens in a new tab with noopener noreferrer", JSON.stringify(docs));
  check(v.links.some((l) => l.href === "https://example.com/bare?q=1" && l.text === "https://example.com/bare?q=1"), "a bare URL is linked, without the full stop after it");
  check(v.h3 === "Deploy notes ZEBRA7731", "a markdown heading renders (h1 becomes h3 under the card's h2)", v.h3);
  check(v.inlines.length === 4, "bold, italic, strike and inline code render", v.inlines.join(", "));
  check(v.table && v.table.th.join("|") === "Step|Command|Result" && v.table.rows === 2 && v.table.mid === "center" && v.table.code, "the GFM table renders with alignment, inside its scroll wrapper", JSON.stringify(v.table));
  const js = v.code.find((c) => c.lang === "js");
  check(js && js.text === 'const answer = 42; // ZEBRA7731\nconsole.log("<b>not bold</b>");' && js.copy && v.bolds === 0, "the fenced code block shows its exact text, a language label and a Copy button", js && JSON.stringify(js));
  check(v.diff.add === 1 && v.diff.del === 1, "a diff block colours its + and - lines", JSON.stringify(v.diff));
  check(v.nested === 2 && v.quote, "nested list by indentation, and a blockquote with bold inside", `nested=${v.nested} quote=${v.quote}`);
  check(v.heb && v.heb.dir === "auto" && v.heb.rtl !== false, "the Hebrew paragraph has dir=auto and reads right to left", JSON.stringify(v.heb));
  check(v.noDir.length === 0, "every text block has dir=auto, and every English list, quote and table is ltr", v.noDir.join(",") || "all");
  check(v.meta.startsWith("answer to r1 · "), "meta line says whose answer it is", v.meta);

  await page.bringToFront();
  await page.click("#screenBody .code .code-bar button");
  const copied = await until(async () => {
    const t = await page.$eval("#screenBody .code .code-bar button", (el) => el.textContent);
    return t !== "Copy" && t;
  }, 3000, "the code Copy button to answer");
  check(copied === "Copied", "the code block's Copy says Copied", copied);
  const announced = await page.$eval("#screenBody .code .code-bar [role=status]", (el) => el.textContent).catch(() => null);
  check(v.copyStatus === "sr-only" && announced === "Copied to the clipboard.", "a screen reader hears the code Copy result too (a status line of its own)", `${v.copyStatus} "${announced}"`);
  try { info("clipboard after code Copy: " + JSON.stringify(await page.evaluate(() => navigator.clipboard.readText()))); } catch (e) { info("clipboard read-back unavailable: " + e.message); }

  const lines = await logLines(page);
  const answer = lines.find((l) => l.cls === "claude" && l.text.startsWith("I put the script"));
  check(answer && answer.show, "the log line of that answer has a Show on screen button");
  const showName = await page.$eval("#log button.show", (el) => el.getAttribute("aria-label") || el.textContent);
  check(showName.startsWith("Show on screen"), "its spoken name starts with the words on it (voice control finds it)", showName);
  const notes = (await thinkings(page)).filter((m) => m.content === DISPLAY_NOTE);
  check(notes.length === 1, "the voice got exactly one note that details are on screen", `${notes.length} note(s)`);
  const leaked = await leaks(page, ["ZEBRA7731", "example.com", "Deploy notes", "not bold"]);
  check(leaked.length === 0, "nothing from the display reached the voice", leaked.join(" | ") || "none");

  // A second entry, then back to the first through the log's button.
  await b.tool("call_say", { text: "One more note is on your screen.", display: "Second note ZEBRA7731b" });
  await until(async () => (await screenPos(page)) === "2 of 2", 4000, "the second entry");
  const meta2 = await page.$eval("#screenMeta", (el) => el.textContent);
  check(meta2.startsWith("from Claude · "), "a say with no request is labelled from Claude", meta2);
  await page.$$eval("#log button.show", (bs) => bs[0].click());
  await until(async () => (await screenPos(page)) === "1 of 2", 3000, "Show on screen to jump back to the first entry");
  const h3 = await page.$eval("#screenBody h3", (el) => el.textContent);
  check(h3 === "Deploy notes ZEBRA7731", "Show on screen brought back the first entry", h3);
  await page.click("#screenCopy");
  const note = await until(async () => page.$eval("#screenCopied", (el) => el.textContent), 3000, "the Copy confirmation");
  check(note === "Copied to the clipboard.", "the card's Copy shows a visible confirmation", note);
  check((await thinkings(page)).filter((m) => m.content === DISPLAY_NOTE).length === 2, "one display note per say (two says, two notes)");
  info("screenshots: " + await shots(page, "onscreen", "#screenBox"));

  /* Pathological input: every scan is bounded or linear, so each of these renders at once. Before
     the 0.6.0 review each one was quadratic: at 40,000 characters the URL took 13 s, the digits 6 s. */
  const nasty = {
    "brackets, emphasis and backticks": "[".repeat(20000) + " " + "*a ".repeat(10000) + "`x ".repeat(10000) + "_".repeat(5000),
    "a URL followed by 99,000 ')'": "see https://x.io/" + ")".repeat(99000),
    "a heading with 99,000 spaces": "# a" + " ".repeat(99000) + "b",
    "a table delimiter with 99,000 spaces": "a | b\n" + " ".repeat(99000) + "x-",
    "25,000 digit-only code spans": "`1` ".repeat(25000),
    "a 4,500-row numeric table": "| a | b |\n| --- | --- |\n" + Array.from({ length: 4500 }, (_, k) => `| ${k} | ${k * 7} |`).join("\n"),
  };
  let at = 2;
  for (const [what, display] of Object.entries(nasty)) {
    at++;
    const t0 = Date.now();
    await b.tool("call_say", { text: "Another note is on your screen.", display });
    await until(async () => (await screenPos(page)) === `${at} of ${at}`, 60000, `the entry with ${what} to render`);
    const took = Date.now() - t0;
    check(took < 4000, `${what} (${display.length.toLocaleString("en-US")} characters) renders in under 4 seconds`, `${took}ms`);
  }
});

def(9, "files from Claude: an image thumbnail loads, a text file opens in a new tab", async ({ b, page, check, ctx, info }) => {
  const dir = scratch(b, "claude-files");
  const PNG = path.join(dir, "chart.png"), TXT = path.join(dir, "notes.txt"), ZIP = path.join(dir, "build.zip");
  fs.writeFileSync(PNG, png(64, 40, [30, 120, 200]));
  fs.writeFileSync(TXT, "hello from a shared file ZEBRA9\n");
  fs.writeFileSync(ZIP, "PK zip ZEBRA9\n");
  const said = await b.tool("call_say", {
    text: "The chart and my notes are on your screen.",
    display: "The chart:\n\n![weekly chart](chart.png)\n\nMy notes are in [the notes file](notes.txt).",
    files: [PNG, TXT, ZIP],
  });
  check(/3 file/.test(said), "the call_say result counts the files shown", firstLine(said));
  await until(async () => (await screenPos(page)) === "1 of 1", 5000, "the On screen card");
  const img = await until(() => page.evaluate(() => {
    const t = document.querySelector("#screenBody .files figure img");
    return t && t.complete && t.naturalWidth > 0 ? { w: t.naturalWidth, h: t.naturalHeight, src: t.getAttribute("src"), shownW: t.getBoundingClientRect().width } : null;
  }), 5000, "the thumbnail to load");
  check(img.w === 64 && img.h === 40 && /\/file\/[A-Za-z0-9_%-]+$/.test(img.src), "the image thumbnail actually loaded from /file/<token>", JSON.stringify(img));
  check(img.shownW <= img.w + 2, "a small picture is shown at its own size, never blown up to the card's width", `${img.w}px picture shown ${Math.round(img.shownW)}px wide (border included)`);
  const dl = await page.evaluate(() => {
    const a = [...document.querySelectorAll("#screenBody .file-row a")].find((x) => /build\.zip/.test(x.getAttribute("aria-label") || ""));
    return a ? { text: a.textContent, label: a.getAttribute("aria-label"), download: a.getAttribute("download"), target: a.getAttribute("target") } : null;
  });
  check(dl && dl.text === "Download" && dl.download === "build.zip" && !dl.target, "a file the browser can only save says Download, not Open", JSON.stringify(dl));
  const inMd = await page.evaluate(() => { const t = document.querySelector("#screenBody .md img"); return t ? { w: t.naturalWidth, alt: t.alt } : null; });
  check(inMd && inMd.w === 64 && inMd.alt === "weekly chart", "![weekly chart](chart.png) in the markdown shows the shared picture", JSON.stringify(inMd));
  const row = await page.evaluate(() => {
    const r = document.querySelector("#screenBody .file-row");
    const a = r && r.querySelector("a");
    return r ? { text: r.textContent, href: a && a.getAttribute("href"), target: a && a.target, rel: a && a.rel } : null;
  });
  check(row && /^notes\.txt ?· \d+ B · ?Open$/.test(row.text), "the text file is a row: name · size · Open", row && row.text);
  check(row && row.target === "_blank" && row.rel === "noopener noreferrer", "Open goes to a new tab with noopener noreferrer");
  const tab = ctx.waitForTarget((t) => t.url().includes("/file/"), { timeout: 6000 });
  await page.click("#screenBody .file-row a");
  const target = await tab;
  check(target.url().endsWith(row.href), "clicking Open opened the file in a new tab", target.url().replace(/^https?:\/\/[^/]+/, ""));
  const got = await page.evaluate(async (u) => { const r = await fetch(u); return { status: r.status, type: r.headers.get("content-type"), text: await r.text() }; }, row.href);
  check(got.status === 200 && /^text\/plain/.test(got.type || "") && got.text === "hello from a shared file ZEBRA9\n", "that tab's URL serves the file as text", `${got.status} ${got.type}`);
  try {
    const p2 = await target.page();
    info("the new tab shows: " + JSON.stringify(await Promise.race([p2.evaluate(() => document.body && document.body.innerText), sleep(3000).then(() => "(timed out)")])));
  } catch (e) { info("could not read the new tab (sandboxed): " + e.message); }
  const leaked = await leaks(page, ["chart.png", "notes.txt", "build.zip", "weekly chart", "ZEBRA9"]);
  check(leaked.length === 0, "no file name or content reached the voice", leaked.join(" | ") || "none");
});

def(10, "attach with the file input: progress chip, remove one, Send with only files", async ({ b, page, check, ctx, info }) => {
  const dir = scratch(b, "to-share");
  const A = path.join(dir, "alpha notes.txt"), B = path.join(dir, "beta.txt"), BIG = path.join(dir, "big.bin");
  fs.writeFileSync(A, "alpha ZEBRA10 upload\n");
  fs.writeFileSync(B, "beta\n");
  const bigBytes = crypto.randomBytes(1536 * 1024);
  fs.writeFileSync(BIG, bigBytes);
  await page.evaluate(() => {
    window.__chipTexts = [];
    new MutationObserver(() => {
      for (const c of document.querySelectorAll("#chips .chip-text")) window.__chipTexts.push(c.textContent);
      const n = document.getElementById("attachNote");
      if (!n.hidden) window.__chipTexts.push("NOTE " + n.textContent);
    }).observe(document.getElementById("convoBox"), { subtree: true, childList: true, characterData: true });
  });
  const input = await page.$("#fileInput");
  await input.uploadFile(A, B);
  await until(async () => (await readyChips(page)).length === 2, 8000, "two ready chips");
  const chips = await chipTexts(page);
  check(chips.some((c) => /^alpha notes\.txt · \d+ B$/.test(c)) && chips.some((c) => /^beta\.txt · \d+ B$/.test(c)), "each file is a chip: name · size", chips.join(" | "));
  const note = await until(async () => (await thinkings(page)).find((m) => /attached/.test(m.content)), 4000, "the attach note to the voice");
  check(note.content === "The user attached 2 file(s) on the call page. They go to Claude with the user's next request; you cannot see them.", "the voice got one generic note for the two files", note.content);
  const ready = await page.$eval("#attachNote", (el) => el.textContent);
  check(/^2 file\(s\) ready\. They go to Claude with your next request/.test(ready), "the page says the files wait for the next request", ready);

  // A second tab of the same call (a duplicated tab) sees the same waiting files.
  const tabB = await ctx.newPage();
  await tabB.goto(page.url(), { waitUntil: "domcontentloaded" });
  await until(async () => (await readyChips(tabB)).length === 2, 8000, "the second tab's chips");
  await page.bringToFront();   // a click in a background tab never lands (puppeteer waits for it to paint)
  await page.click('button[aria-label="Remove beta.txt"]');
  await until(async () => !(await chipTexts(page)).some((c) => c.startsWith("beta.txt")), 4000, "the beta.txt chip to go");
  // The line comes once the bridge has answered the remove.
  const removedLine = await until(async () => (await logLines(page)).find((l) => /^removed beta\.txt/.test(l.text)), 4000, "the removed line").catch(() => null);
  check(Boolean(removedLine), "the log says beta.txt was removed", removedLine && removedLine.text);
  await until(async () => (await readyChips(tabB)).length === 1, 4000, "the chip to go in the second tab too");
  await sleep(700);
  const linesB = (await logLines(tabB)).filter((l) => /beta\.txt/.test(l.text));
  check(linesB.length === 1 && linesB[0].who === "Call" && /^removed beta\.txt in another tab/.test(linesB[0].text),
    "the other tab says beta.txt was removed there, never 'You shared: beta.txt'", linesB.map((l) => l.who + ": " + l.text).join(" | ") || "nothing");
  await Promise.race([tabB.close(), sleep(3000)]);

  // Keyboard focus on a Remove stays there while another upload redraws the chips.
  await page.focus('button[aria-label="Remove alpha notes.txt"]');
  // Throttled, so the chip has time to show its progress.
  await page.emulateNetworkConditions({ download: -1, upload: 700 * 1024, latency: 0 });
  await input.uploadFile(BIG);
  await until(async () => (await readyChips(page)).some((c) => c.startsWith("big.bin · ")), 20000, "big.bin to finish uploading");
  await page.emulateNetworkConditions(null);
  const focused = await page.evaluate(() => document.activeElement.getAttribute("aria-label") || document.activeElement.tagName);
  check(focused === "Remove alpha notes.txt", "focus stayed on the Remove it was on while the chips were redrawn", focused);
  const seen = [...new Set(await page.evaluate(() => window.__chipTexts))];
  const progress = seen.filter((t) => /^uploading big\.bin \d+%$/.test(t));
  check(progress.length > 0, "the chip showed 'uploading big.bin N%' while it uploaded", progress.slice(0, 8).join(", "));
  info("upload status lines seen: " + seen.filter((t) => t.startsWith("NOTE Uploading")).slice(0, 4).join(" / "));
  info("screenshots: " + await shots(page, "chips", "#convoBox"));

  const next = timed(b.tool("call_next", { wait_seconds: 20 }));
  await page.click("#send");
  const r = await next;
  check(/^REQUEST r1 \(typed on the call page\):/.test(r.text), "Send with an empty box and files pending made a typed request", firstLine(r.text));
  check(r.text.includes("(no message: the user shared file(s) on the call page)"), "the request text says there was no message");
  const paths = sharedPaths(r.text);
  check(paths.length === 2 && paths.every((p) => path.isAbsolute(p) && fs.existsSync(p)), "call_next lists the files as absolute paths that exist", paths.join(" | "));
  check(paths.some((p) => fs.readFileSync(p, "utf8") === "alpha ZEBRA10 upload\n") && paths.some((p) => fs.readFileSync(p).equals(bigBytes)), "both files arrived byte for byte");
  check(!paths.some((p) => p.endsWith("beta.txt")), "the removed file did not go");
  await until(async () => (await chipTexts(page)).length === 0, 4000, "the chips to clear");
  const shared = await until(async () => (await logLines(page)).find((l) => l.who === "You" && l.text.startsWith("shared: ")), 4000, "the You shared line");
  check(shared.text === "shared: alpha notes.txt, big.bin", "the log says what went: You shared: ...", "You " + shared.text);
  const leaked = await leaks(page, ["alpha notes", "big.bin", "beta.txt", "ZEBRA10"]);
  check(leaked.length === 0, "no file name or content reached the voice", leaked.join(" | ") || "none");
});

def(11, "paste a screenshot: it becomes pasted-image-HHMMSS.png and rides with the typed request", async ({ b, page, check }) => {
  const bytes = png(48, 32, [220, 40, 40]);
  // Excel (and Word, OneNote) put a picture of the copied cells next to their text: that paste is text.
  const office = await page.evaluate((arr) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "A1\tB1\n1\t2");
    dt.setData("text/html", "<table><tr><td>A1</td><td>B1</td></tr></table>");
    dt.items.add(new File([new Uint8Array(arr)], "image.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (!ev.clipboardData) Object.defineProperty(ev, "clipboardData", { value: dt });
    const box = document.getElementById("typed");
    box.focus();
    box.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, types: [...dt.types] };
  }, [...bytes]);
  await sleep(1500);
  const chipsNow = await chipTexts(page);
  check(!office.prevented && chipsNow.length === 0, "pasting cells copied from Excel into the box pastes their text, not a picture", `${JSON.stringify(office)} chips=${JSON.stringify(chipsNow)}`);
  const r0 = await page.evaluate((arr) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(arr)], "image.png", { type: "image/png" }));
    const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (!ev.clipboardData) Object.defineProperty(ev, "clipboardData", { value: dt });
    const box = document.getElementById("typed");
    box.focus();
    box.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, typed: box.value };
  }, [...bytes]);
  check(r0.prevented && r0.typed === "", "the page took the pasted image (nothing pasted into the box as text)", JSON.stringify(r0));
  const chipText = await until(async () => (await readyChips(page)).find((c) => /^pasted-image-\d{6}\.png · /.test(c)), 8000, "the pasted image chip");
  check(true, "a pasted image with no real name becomes pasted-image-HHMMSS.png", chipText);
  const next = timed(b.tool("call_next", { wait_seconds: 20 }));
  await page.type("#typed", "What is wrong in this screenshot?");
  await page.keyboard.press("Enter");
  const r = await next;
  check(/^REQUEST r1 \(typed on the call page\):/.test(r.text) && r.text.includes("What is wrong in this screenshot?"), "the typed request reached Claude", firstLine(r.text));
  const paths = sharedPaths(r.text);
  check(paths.length === 1 && path.isAbsolute(paths[0]) && /pasted-image-\d{6}\.png$/.test(paths[0]), "the screenshot rides with it as an absolute path", paths.join(" | "));
  check(paths.length === 1 && fs.existsSync(paths[0]) && fs.readFileSync(paths[0]).equals(bytes), "the pasted bytes arrived intact");
  check((await leaks(page, ["pasted-image"])).length === 0, "the file name never reached the voice");
});

def(12, "drag and drop: overlay while dragging, the file rides with the next spoken request", async ({ b, page, check, info }) => {
  const CONTENT = "# Dropped notes\nZEBRA12 drop\n";
  const fire = (type) => page.evaluate((t, content) => {
    if (!window.__dt) {
      window.__dt = new DataTransfer();
      window.__dt.items.add(new File([content], "drop-notes.md", { type: "text/markdown" }));
    }
    const ev = new DragEvent(t, { dataTransfer: window.__dt, bubbles: true, cancelable: true });
    document.body.dispatchEvent(ev);
    const zone = document.getElementById("dropZone");
    return { prevented: ev.defaultPrevented, shown: !zone.hidden && getComputedStyle(zone).display !== "none", text: zone.textContent };
  }, type, CONTENT);
  fs.mkdirSync(OUT, { recursive: true });
  for (const [w, h] of [[1280, 900], [390, 844]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await fire("dragenter");
    await sleep(200);
    await page.screenshot({ path: path.join(OUT, `drop-overlay-${w}.png`) });
    await fire("dragleave");
  }
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
  info("screenshots: test/e2e/out/drop-overlay-1280.png, test/e2e/out/drop-overlay-390.png");
  const enter = await fire("dragenter");
  check(enter.prevented && enter.shown && enter.text === "Drop files to share them with Claude", "dragging files over the page shows the full-page overlay", JSON.stringify(enter));
  await fire("dragover");
  const drop = await fire("drop");
  check(drop.prevented && !drop.shown, "the drop was taken and the overlay went away", JSON.stringify(drop));
  await until(async () => (await readyChips(page)).some((c) => c.startsWith("drop-notes.md · ")), 8000, "the dropped file's chip");
  const r = await delegate(b, page, "Summarise the notes I just dropped.", "del_s12");
  check(/^REQUEST r1 \(spoken by the user/.test(r.text), "the spoken request reached Claude", firstLine(r.text));
  const paths = sharedPaths(r.text);
  check(paths.length === 1 && path.isAbsolute(paths[0]) && paths[0].endsWith("drop-notes.md"), "the dropped file rides with the spoken request as an absolute path", paths.join(" | "));
  check(paths.length === 1 && fs.readFileSync(paths[0], "utf8") === CONTENT, "its content arrived intact");
  check((await leaks(page, ["drop-notes", "ZEBRA12"])).length === 0, "the file never reached the voice");
});

def(13, "Stop buttons: a queued request is taken out, the working one is stopped and Claude is told", async ({ b, page, check, info }) => {
  const r1 = await delegate(b, page, "Run the full test suite.", "del_s13");
  check(/^REQUEST r1 /.test(r1.text), "r1 is in flight", firstLine(r1.text));
  await page.type("#typed", "Also update the changelog.");
  await page.keyboard.press("Enter");
  const fresh = await until(async () => { const rows = await reqRows(page); return rows.length === 2 && rows; }, 5000, "two rows in the Requests list");
  check(fresh[1].btn && fresh[1].btn.disabled, "a Stop that just swapped in is disabled for a moment", JSON.stringify(fresh[1].btn));
  check(/^r1 · working \d+:\d\d · Run the full test suite\.$/.test(fresh[0].label), "row r1 reads 'r1 · working m:ss · <text>'", fresh[0].label);
  check(/^r2 · queued · Also update the changelog\.$/.test(fresh[1].label), "row r2 reads 'r2 · queued · <text>'", fresh[1].label);
  check(fresh[0].btn && fresh[0].btn.label === "Stop request r1" && fresh[1].btn.label === "Stop request r2", "each row has a Stop labelled for its request");
  await sleep(800);
  check((await reqRows(page)).every((r) => r.btn && !r.btn.disabled), "the Stop buttons arm after 700 ms");
  info("screenshots: " + await shots(page, "requests", "#statusBox"));

  // A keyboard user on Stop r1 keeps their place when a new request redraws the list.
  await page.focus('button[aria-label="Stop request r1"]');
  const r3sent = await page.evaluate(async () => (await fetch(location.pathname.replace(/\/+$/, "") + "/typed", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "And bump the version." }),
  })).status);
  await until(async () => (await reqRows(page)).length === 3, 5000, "r3 in the Requests list");
  await sleep(900);
  const onStop = await page.evaluate(() => document.activeElement.getAttribute("aria-label") || document.activeElement.tagName);
  check(r3sent === 200 && onStop === "Stop request r1", "focus is back on Stop r1 after the list was redrawn (not thrown to the page)", onStop);

  // A spoken "stop" takes the newest QUEUED request first: r1 keeps working.
  await userSays(page, "Stop.");
  await until(async () => (await reqRows(page)).length === 2, 5000, "r3 to leave the list");
  const afterSpoken = await reqRows(page);
  const stoppedNote = (await logLines(page)).some((l) => l.cls === "note" && l.text === "you said stop, so the page is stopping r3");
  check(afterSpoken.length === 2 && /^r1 · working /.test(afterSpoken[0].label) && /^r2 · queued /.test(afterSpoken[1].label) && stoppedNote,
    "a spoken 'Stop.' took out the newest queued request (r3), not the one Claude is working on", afterSpoken.map((r) => r.label).join(" | "));
  await sleep(800);

  await page.click('button[aria-label="Stop request r2"]');
  await until(async () => { const rows = await reqRows(page); return rows.length === 1 && rows[0].label.startsWith("r1 ") && rows; }, 5000, "r2 to leave the list");
  check((await logLines(page)).some((l) => /^took r2 out of the queue/.test(l.text)), "the log says r2 was taken out of the queue");
  check((await thinkings(page)).some((m) => /pressed Stop/.test(m.content) && /taken out of the queue/.test(m.content)), "the voice was told generically that the user stopped one");
  await sleep(800);
  await page.click('button[aria-label="Stop request r1"]');
  const stopping = await until(async () => { const rows = await reqRows(page); return rows[0] && /stopping\.\.\./.test(rows[0].label) && rows[0]; }, 5000, "r1 to show stopping...");
  check(/^r1 · stopping\.\.\. · /.test(stopping.label) && !stopping.btn, "r1 now reads 'stopping...' with no Stop button", stopping.label);
  const st = await status(page);
  check(/^Stopping r1\./.test(st), "the status line says exactly what is happening", st);

  const p = await b.tool("call_say", { id: "r1", text: "Still running the tests.", final: false });
  check(p.startsWith('STOP r1: the user cancelled "Run the full test suite." on the call.'), "Claude's next call_say result starts with the STOP notice", firstLine(p));
  const closed = await b.tool("call_say", { id: "r1", text: "Stopped. Nothing was changed." });
  check(!closed.startsWith("STOP") && /r1/.test(closed), "Claude closes it with call_say, told only once", firstLine(closed));
  await until(async () => (await reqRows(page)).length === 0, 4000, "the list to empty");
  const r2 = await timed(b.tool("call_next", { wait_seconds: 5 }));
  check(/^Nothing new yet/.test(r2.text), "the stopped queued request never reached Claude", firstLine(r2.text));
});

def(14, "spoken cancel: 'Stop.' stops the work at once, and the voice's own hand-over of it is not a new request", async ({ b, page, check }) => {
  const r1 = await delegate(b, page, "Refactor the whole server folder.", "del_s14");
  check(/^REQUEST r1 /.test(r1.text), "r1 is in flight", firstLine(r1.text));
  await until(async () => (await reqRows(page)).length === 1, 4000, "r1 in the Requests list");
  const waiting = timed(b.tool("call_next", { wait_seconds: 30 }));
  await sleep(300);
  await userSays(page, "Stop.");
  const saidAt = Date.now();
  await sleep(500);
  await delegation(page, "del_s14b");   // the voice hands the "stop" over too, as it often does
  const w = await waiting;
  check(w.text.startsWith('STOP r1: the user cancelled "Refactor the whole server folder." on the call.') && w.text.includes("Then call call_next again."),
    "the waiting call_next returned the STOP notice at once", `${firstLine(w.text)} (${((w.at - saidAt) / 1000).toFixed(1)}s after 'Stop.')`);
  const c = await until(async () => (await commentaries(page)).find((m) => m.content === "The user cancelled Claude's request. Say only: Cancelled."), 4000, "the cancel commentary");
  check(c.delegation_id === null, "the voice was told to say only 'Cancelled.'", c.content);
  const d = await until(async () => (await sent(page)).find((m) => m.delegation_id === "del_s14b"), 6000, "the page's answer to the voice's own delegation");
  check(d.type === "session.commentary.append" && d.content === "That was the user cancelling; it is done. Say only: Cancelled.", "the voice's delegation of 'Stop.' was answered, not handed over", d.content);
  await sleep(1500);
  check(requests(b).length === 1, "no new request was created from 'Stop.'", JSON.stringify(requests(b)));
  check(!transcript(b).some((l) => l.role === "user" && /^stop\.?$/i.test(l.text)), "'Stop.' is not in the hand-off as something still to do");
  check((await logLines(page)).some((l) => l.cls === "note" && /stopping r1/.test(l.text)), "the page log says it is stopping r1");

  // Saying it again while r1 is still stopping is not a request either.
  const again = timed(b.tool("call_next", { wait_seconds: 10 }));
  await userSays(page, "Stop it.");
  await until(async () => (await logLines(page)).some((l) => l.cls === "note" && l.text === "you said stop; r1 is already stopping"), 5000, "the page to say r1 is already stopping");
  const cancels = (await commentaries(page)).filter((m) => m.content === "The user cancelled Claude's request. Say only: Cancelled.");
  check(cancels.length === 2, "a second 'Stop it.' while r1 is stopping: the voice says Cancelled again", `${cancels.length} cancel commentaries`);
  const a = await again;
  check(/^Nothing new yet/.test(a.text), "Claude got nothing new from it (the STOP notice was told once)", firstLine(a.text));

  const closed = await b.tool("call_say", { id: "r1", text: "Stopped the refactor; nothing was changed." });
  check(/r1/.test(closed) && !closed.startsWith("STOP"), "Claude closes the cancelled request normally", firstLine(closed));

  // With nothing of Claude's running, a bare "stop" is for the voice: the safety net keeps it there.
  await until(async () => (await reqRows(page)).length === 0, 4000, "the Requests list to empty");
  const idle = timed(b.tool("call_next", { wait_seconds: 12 }));
  await userSays(page, "Stop.");
  const i = await idle;
  check(/^Nothing new yet/.test(i.text), "a bare 'Stop.' with nothing running is not handed to Claude", firstLine(i.text));
  check(requests(b).length === 1, "still exactly one request", JSON.stringify(requests(b)));
});

def(15, "permission banner from the Notification hook, hidden when Claude moves again", async ({ b, page, check, info }) => {
  const r1 = await delegate(b, page, "Delete the build folder.", "del_s15");
  check(/^REQUEST r1 /.test(r1.text), "r1 is in flight", firstLine(r1.text));
  await until(async () => (await reqRows(page)).length === 1, 4000, "r1 in the Requests list");
  const NOTICE = "Claude needs your permission to use Bash (the approval is on screen in Claude's window)";
  const n = await hookPost(b, "/notify", { text: NOTICE, kind: "permission" });
  check(n.status === 200, "POST /notify with the hook token and kind permission", `${n.status} ${JSON.stringify(n.json)}`);
  const banner = await until(() => page.evaluate(() => {
    const box = document.getElementById("permBox");
    return !box.hidden && { role: box.getAttribute("role"), text: box.textContent.replace(/\s+/g, " ").trim(), top: box.getBoundingClientRect().top < document.getElementById("statusBox").getBoundingClientRect().top };
  }), 4000, "the permission banner");
  const shownAt = Date.now();
  check(banner.role === "alert" && banner.top, "a banner card with role=alert, above the call status");
  check(banner.text.includes("Claude is waiting for your approval in its own window") && banner.text.includes(NOTICE)
    && banner.text.includes("The call cannot approve this. Switch to the Claude window to allow or deny it."), "it says what is happening and what to do", banner.text.slice(0, 200));
  const st = await status(page);
  check(/^Claude is waiting for your approval in its own window\./.test(st), "the status line says the same", st);

  info("screenshots: " + await shots(page, "banner", "#permBox"));
  // The hook token opens status and notices only (0.6.0 has no activity endpoint).
  const a = await hookPost(b, "/activity", { tool: "Bash", summary: "rm -rf build" });
  check(a.status === 403, "the hook token cannot post anything else", `${a.status} ${JSON.stringify(a.json)}`);
  check(!(await page.evaluate(() => document.getElementById("permBox").hidden)), "the banner stays up until Claude moves");
  await b.tool("call_say", { id: "r1", text: "Waiting for your approval in the Claude window.", final: false });
  const hidden = await until(() => page.evaluate(() => document.getElementById("permBox").hidden), 4000, "the banner to hide once Claude moves again");
  check(hidden, "the banner hides on Claude's next say", `${Date.now() - shownAt}ms after it appeared`);
  check(JSON.parse(await b.tool("call_status")).state === "live", "the call is still live");

  // Claude moves on without saying anything (an instruction to the voice): the status line moves on too.
  await hookPost(b, "/notify", { text: NOTICE, kind: "permission" });
  await until(() => page.evaluate(() => !document.getElementById("permBox").hidden), 4000, "the banner again");
  await b.tool("call_instruct", { text: "Keep your answers short.", mode: "normal" });
  await until(() => page.evaluate(() => document.getElementById("permBox").hidden), 4000, "the banner to hide on the instruction");
  const moved = await status(page);
  check(!moved.startsWith("Claude is waiting for your approval"), "after an instruction the status line no longer says Claude waits for approval", moved);
});

def(16, "phone width: nothing scrolls the page sideways at 390 and 360, and nothing interactive overlaps", async ({ b, page, check, info }) => {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  const r1 = await delegate(b, page, "Show me the long config.", "del_s16");
  check(/^REQUEST r1 /.test(r1.text), "r1 is in flight", firstLine(r1.text));
  const LONG = path.join(scratch(b, "phone"), "a-very-long-file-name-that-keeps-going-" + "x".repeat(60) + ".log");
  fs.writeFileSync(LONG, "log\n");
  await (await page.$("#fileInput")).uploadFile(LONG);
  await until(async () => (await readyChips(page)).length === 1, 8000, "the long-named chip");
  const cols = Array.from({ length: 10 }, (_, k) => "Column" + k + "Header");
  const display = [
    "## Long things",
    FENCE + "js",
    "const config = " + JSON.stringify({ key: "v".repeat(300) }) + ";",
    FENCE,
    "",
    "| " + cols.join(" | ") + " |",
    "|" + " --- |".repeat(10),
    "| " + cols.map((c, k) => "value-" + "w".repeat(24) + k).join(" | ") + " |",
    "",
    "A long link: https://example.com/" + "segment/".repeat(30),
    "",
    "Unbroken: " + "z".repeat(240),
  ].join("\n");
  await b.tool("call_say", { id: "r1", text: "The config is on your screen.", final: false, display });
  await until(async () => (await screenPos(page)) === "1 of 1", 5000, "the On screen card");
  for (const [w, h] of [[390, 844], [360, 740]]) {
    await page.setViewport({ width: w, height: h, deviceScaleFactor: 2 });
    await sleep(300);
    const m = await page.evaluate(() => {
      const pre = document.querySelector("#screenBody pre"), tw = document.querySelector("#screenBody .tablewrap");
      return { sw: document.documentElement.scrollWidth, iw: innerWidth, pre: pre.scrollWidth > pre.clientWidth, table: tw.scrollWidth > tw.clientWidth };
    });
    check(m.sw <= m.iw, `at ${w} px the page does not scroll sideways`, `scrollWidth ${m.sw} vs innerWidth ${m.iw}`);
    check(m.pre && m.table, `at ${w} px the long code line and the wide table scroll inside their own boxes`, JSON.stringify(m));
    const o = await overlaps(page);
    check(o.length === 0, `at ${w} px no two interactive elements overlap`, o.join(" | ") || "none");
    const ph = await page.evaluate(() => {
      const i = document.getElementById("typed"), cs = getComputedStyle(i);
      const g = document.createElement("canvas").getContext("2d");
      g.font = cs.font;
      return { hint: i.placeholder, needs: Math.ceil(g.measureText(i.placeholder).width), room: Math.floor(i.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) };
    });
    check(ph.needs <= ph.room, `at ${w} px the typed box shows its whole hint, not cut mid-word`, JSON.stringify(ph));
  }
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2 });
  await sleep(300);
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, "phone-page-390.png"), fullPage: true });
  info("screenshot: test/e2e/out/phone-page-390.png (full page)");
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 1 });
});

def(17, "files that never went with a request: a stopped queued request, then the bridge ends the call", async ({ b, page, check }) => {
  const dir = scratch(b, "left");
  const Q = path.join(dir, "queued-notes.txt"), L = path.join(dir, "left-behind.txt");
  fs.writeFileSync(Q, "queued ZEBRA17\n");
  fs.writeFileSync(L, "left ZEBRA17\n");
  const r1 = await delegate(b, page, "Run the linter.", "del_s17");
  check(/^REQUEST r1 /.test(r1.text), "r1 is in flight", firstLine(r1.text));
  const input = await page.$("#fileInput");
  await input.uploadFile(Q);
  await until(async () => (await readyChips(page)).length === 1, 8000, "the queued-notes chip");
  await page.type("#typed", "Look at these notes too.");
  await page.keyboard.press("Enter");
  const rows = await until(async () => { const r = await reqRows(page); return r.length === 2 && r; }, 5000, "r2 queued with its file");
  check(/^r2 · queued · Look at these notes too\. · 1 file\(s\)$/.test(rows[1].label), "the queued row says it carries a file", rows[1].label);
  await sleep(800);
  await page.click('button[aria-label="Stop request r2"]');
  const took = await until(async () => (await logLines(page)).find((l) => /^took r2 out of the queue/.test(l.text)), 5000, "the queue note");
  check(/The 1 file\(s\) with it were not sent; Claude gets them in the end-of-call hand-off$/.test(took.text), "the log says the file that went with r2 was not sent", took.text);

  await input.uploadFile(L);
  await until(async () => (await readyChips(page)).some((c) => c.startsWith("left-behind.txt · ")), 8000, "the left-behind chip");
  // The bridge ends the call by itself (as at the time limit) while the page still listens.
  const st = await page.evaluate(async () => (await fetch(location.pathname.replace(/\/+$/, "") + "/state", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ state: "closed", reason: "test: the bridge ended the call" }),
  })).status);
  check(st === 200, "the bridge ended the call", `POST /state closed answered ${st}`);
  const NOTE = "1 file(s) you attached did not go with a request: left-behind.txt. Claude gets them in the end-of-call hand-off.";
  await until(async () => (await logLines(page)).some((l) => l.text === NOTE), 4000, "the page to say the file did not go");
  await until(async () => (await sent(page)).some((m) => m.type === "session.close"), 8000, "the page to close the voice session");
  await live(page, { type: "session.closed", usage: { seconds: 30 } });
  await until(async () => (await page.$eval("#go", (el) => el.textContent)) === "Call ended", 4000, "the page to show the call ended");
  const lines = (await logLines(page)).filter((l) => /left-behind/.test(l.text));
  check(lines.length === 1 && lines[0].who === "Call", "the page said it once, and never as 'You shared'", lines.map((l) => l.who + ": " + l.text).join(" | "));
  check((await chipTexts(page)).length === 0, "no chip is left on the ended page");

  const end = await b.tool("call_next", { wait_seconds: 5 });
  check(/^CALL ENDED \(test: the bridge ended the call\)/.test(end), "call_next reports the end", firstLine(end));
  const never = sharedPaths(end, "Files the user shared on the call but never sent with a request");
  check(never.length === 2 && never.every((p) => path.isAbsolute(p) && fs.existsSync(p))
    && never.some((p) => p.endsWith("queued-notes.txt")) && never.some((p) => p.endsWith("left-behind.txt")),
  "the hand-off lists both files as never sent, as absolute paths that exist", never.join(" | "));
  check((await leaks(page, ["queued-notes", "left-behind", "ZEBRA17"])).length === 0, "no file name or content reached the voice");
});

/* Where a piece of text is drawn: the box of the first place `needle` occurs in root's text. */
function textBoxes(page, sel, needles) {
  return page.evaluate((sel, needles) => {
    const root = document.querySelector(sel);
    if (!root) return null;
    const box = (needle) => {
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const i = n.data.indexOf(needle);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + needle.length);
        const b = r.getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right) };
      }
      return null;
    };
    return { text: root.textContent, name: box(needles[0]), size: box(needles[1]) };
  }, sel, needles);
}

def(18, "Hebrew: lists, quotes and tables read right to left, and a Hebrew file name keeps its size after it", async ({ b, page, check, info }) => {
  const HEB = [
    "- פריט ראשון",
    "- פריט שני",
    "",
    "1. שלב אחד",
    "",
    "> ציטוט חשוב",
    "",
    "| שם | כמות |",
    "| --- | --- |",
    "| תפוח | 3 |",
    "",
    "- English item",
    "- second item",
  ].join("\n");
  const dir = scratch(b, "hebrew");
  const IMG = path.join(dir, "צילום מסך 2026.png"), UP = path.join(dir, "צילום מסך.png");
  fs.writeFileSync(IMG, png(40, 30, [20, 160, 90]));
  fs.writeFileSync(UP, "x".repeat(21));
  await b.tool("call_say", { text: "The list and the picture are on your screen.", display: HEB, files: [IMG] });
  await until(async () => (await screenPos(page)) === "1 of 1", 5000, "the On screen card");
  await until(() => page.evaluate(() => { const t = document.querySelector("#screenBody figure img"); return t && t.complete && t.naturalWidth > 0; }), 5000, "the picture to load");
  const v = await page.evaluate(() => {
    const md = document.querySelector("#screenBody .md");
    const d = (e) => (e.matches(":dir(rtl)") ? "rtl" : "ltr");
    const q = md.querySelector("blockquote"), qs = getComputedStyle(q);
    return {
      lists: [...md.querySelectorAll(":scope > ul, :scope > ol")].map(d),
      items: [...md.querySelectorAll("li")].map(d),
      quote: d(q), bar: { left: qs.borderLeftWidth, right: qs.borderRightWidth },
      table: d(md.querySelector("table")),
      th: [...md.querySelectorAll("th")].map((x) => ({ t: x.textContent, x: Math.round(x.getBoundingClientRect().left) })),
    };
  });
  check(v.lists.join() === "rtl,rtl,ltr" && v.items.join() === "rtl,rtl,rtl,ltr,ltr", "Hebrew lists read right to left (bullets on the right), the English one left to right", `${v.lists.join()} / ${v.items.join()}`);
  check(v.quote === "rtl" && v.bar.right !== "0px" && v.bar.left === "0px", "a Hebrew quote reads right to left, with its bar on the right", JSON.stringify({ quote: v.quote, bar: v.bar }));
  check(v.table === "rtl" && v.th.length === 2 && v.th[0].x > v.th[1].x, "a Hebrew table puts its first column on the right", JSON.stringify(v.th));

  const imgSize = fs.statSync(IMG).size + " B";
  const cap = await textBoxes(page, "#screenBody figure figcaption", ["צילום מסך", imgSize]);
  check(cap && cap.name && cap.size && cap.size.left >= cap.name.right - 1, "the picture's caption shows the Hebrew name, then its size after it", JSON.stringify(cap));

  await (await page.$("#fileInput")).uploadFile(UP);
  await until(async () => (await readyChips(page)).length === 1, 8000, "the Hebrew-named chip");
  const chipBox = await textBoxes(page, "#chips .chip .chip-text", ["צילום מסך", "21 B"]);
  check(chipBox && chipBox.name && chipBox.size && chipBox.size.left >= chipBox.name.right - 1, "the chip shows the Hebrew name, then its size after it (not 'png · 21 B' in the middle)", JSON.stringify(chipBox));
  info("screenshots: " + await shots(page, "hebrew-screen", "#screenBox") + ", " + await shots(page, "hebrew-chip", "#convoBox"));
});

def(19, "an upload still running: a spoken request waits for it, a typed one survives End call, and an ended page has no Stop buttons", async ({ b, page, check }) => {
  const dir = scratch(b, "inflight");
  const SHOT = path.join(dir, "screenshot.png"), BIG = path.join(dir, "recording.bin");
  fs.writeFileSync(SHOT, crypto.randomBytes(1536 * 1024));
  fs.writeFileSync(BIG, crypto.randomBytes(3 * 1024 * 1024));
  const input = await page.$("#fileInput");

  // "What is wrong in this screenshot?" said while the screenshot is still uploading.
  await page.emulateNetworkConditions({ download: -1, upload: 300 * 1024, latency: 0 });
  await input.uploadFile(SHOT);
  await until(async () => (await chipTexts(page)).some((c) => c.startsWith("uploading screenshot.png")), 5000, "the screenshot to start uploading");
  const r1 = await delegate(b, page, "What is wrong in this screenshot?", "del_s19");
  await page.emulateNetworkConditions(null);
  const with1 = sharedPaths(r1.text);
  check(/^REQUEST r1 \(spoken/.test(r1.text) && with1.length === 1 && with1[0].endsWith("screenshot.png"), "the spoken request waited for the upload and took the screenshot with it", with1.join(" | ") || firstLine(r1.text));

  // A typed request waiting for a slow upload when the user presses End call.
  const TYPED = "Please rename the invoice folder to 2026";
  await page.emulateNetworkConditions({ download: -1, upload: 100 * 1024, latency: 0 });
  await input.uploadFile(BIG);
  await until(async () => (await chipTexts(page)).some((c) => c.startsWith("uploading recording.bin")), 5000, "the recording to start uploading");
  await page.type("#typed", TYPED);
  await page.keyboard.press("Enter");
  await until(async () => /as soon as the upload finishes/.test(await page.$eval("#attachNote", (el) => el.textContent)), 4000, "the typed request to wait for its upload");
  const ended = timed(b.tool("call_next", { wait_seconds: 40 }));
  await page.click("#go");
  await until(async () => (await sent(page)).some((m) => m.type === "session.close"), 5000, "the page to close the voice session");
  await live(page, { type: "session.closed", usage: { seconds: 20 } });
  const end = await ended;
  await page.emulateNetworkConditions(null);
  check(/^CALL ENDED \(You ended the call\.\)/.test(end.text), "the call ended", firstLine(end.text));
  check(end.text.includes("User (NOT HANDED OVER to you during the call): (typed on the call page, never sent: the call ended while it waited for an upload) " + TYPED),
    "the typed request that never went out is in the end-of-call hand-off as not handed over", (end.text.split("\n").find((l) => l.includes(TYPED)) || "missing").slice(0, 220));
  const after = await page.evaluate(() => ({ box: document.getElementById("typed").value, log: [...document.querySelectorAll("#log li")].map((li) => li.textContent) }));
  check(after.box === TYPED, "the typed text is back in the box", JSON.stringify(after.box));
  check(after.log.some((l) => l === "Callnot sent, the call ended first: " + TYPED) && after.log.some((l) => l === "Callthe call ended before recording.bin finished uploading, so it was not shared"),
    "the log says the request was not sent and the file was not shared", after.log.filter((l) => /not sent|not shared/.test(l)).join(" | ") || "nothing");

  // r1 was still open when the call ended. A reload of the ended page offers no Stop for it.
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(1200);
  const reloaded = await page.evaluate(() => ({ stops: document.querySelectorAll("#reqs button").length, hidden: document.getElementById("reqs").hidden, status: document.getElementById("status").textContent }));
  check(reloaded.stops === 0 && reloaded.hidden && reloaded.status === "This call has ended.", "a reloaded ended page lists no open requests and no Stop buttons", JSON.stringify(reloaded));
});

/* ---------------------------------------------------------------- run -- */

const puppeteer = createRequire(PUPPETEER_FROM)("puppeteer-core");
browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,   // puppeteer-core 24: true is the new headless mode (--headless=new)
  args: ["--no-first-run", "--no-default-browser-check", "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
});
const results = [];
try {
  for (const run of SCENARIOS) {
    const r = await run();
    if (r) results.push(r);
  }
} finally {
  await Promise.race([browser.close(), sleep(8000)]);
  try { browser.process() && browser.process().kill(); } catch {}
}
const ok = results.length > 0 && results.every((r) => r.passed);
console.log(JSON.stringify({ passed: ok, seconds: Math.round((Date.now() - T0) / 1000), scenarios: results }, null, 2));
say(ok ? "PAGE SIM PASS" : "PAGE SIM FAIL");
process.exit(ok ? 0 : 1);
