#!/usr/bin/env node
/* Deterministic page-side simulation of the 0.5.0 "nothing said is lost" behaviour.
 *
 * The REAL bridge (server/bridge.mjs over stdio) and the REAL call page (server/call.html) in
 * headless Chrome. Only the two things that would cost money or need hardware are faked:
 *   - OpenAI's HTTP side: mockOpenAI() answers POST /v1/live/sessions.
 *   - The browser's media side: getUserMedia returns a silent AudioContext stream, and
 *     RTCPeerConnection is a stub whose data channel records what the page sends (window.__sent)
 *     and lets this harness play gpt-live-1's events into the page (window.__dc.onmessage).
 * Claude's side is driven with the MCP tools (call_next / call_say / call_instruct).
 *
 * No OpenAI call, no Claude session, no cost. About 2.5 minutes.
 *
 * Usage: node test/e2e/page_sim.mjs            all scenarios
 *        node test/e2e/page_sim.mjs 1 6        only scenarios 1 and 6
 * Env:   PUPPETEER_FROM  a package.json whose node_modules has puppeteer-core
 *        CHROME_PATH     Chrome binary
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { startBridge, mockOpenAI, sleep } from "../helpers.mjs";

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
  who: li.querySelector(".who").textContent, text: li.lastChild.textContent, cls: li.className,
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
  const pageErrors = [], consoleErrors = [];
  say(`#${num} ${name}: start`);
  try {
    await b.init();
    await b.tool("call_start", {});
    ctx = await browser.createBrowserContext();
    page = await ctx.newPage();
    page.on("pageerror", (e) => pageErrors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    await page.evaluateOnNewDocument(pageStub);
    await page.goto(b.launchUrl(), { waitUntil: "domcontentloaded" });
    await until(async () => JSON.parse(await b.tool("call_status")).pageConnected, 8000, "the page's event stream");
    await page.click("#go");
    await until(async () => (await status(page)).startsWith("Connecting audio"), 8000, "the (mock) voice session to open");
    await live(page, { type: "session.started" });
    await until(async () => (await page.$eval("#go", (el) => el.textContent)) === "End call", 4000, "the page to go live");
    await until(async () => JSON.parse(await b.tool("call_status")).state === "live", 4000, "the bridge to see the call live");
    await fn({ b, page, mock, check });
    check(pageErrors.length === 0, "no uncaught errors in the page", pageErrors.join(" | ") || "none");
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
