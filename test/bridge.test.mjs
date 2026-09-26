import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { startBridge, mockOpenAI, post, sleep } from "./helpers.mjs";
import { speakable, redactSecrets, fitSpoken, estimateTokens, peerUidFromTable } from "../server/bridge.mjs";

const KEY = "sk-test-" + "x".repeat(40) + "WXYZ";

async function started(env) {
  const b = startBridge(env);
  await b.init();
  const out = await b.tool("call_start", { focus: "testing" });
  const page = await b.open();
  return { b, out, page };
}

function rawGet(port, pathName, headers) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: pathName, agent: false, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode));
    });
    req.on("error", reject);
  });
}

test("MCP handshake lists exactly the seven call tools", async () => {
  const b = startBridge();
  try {
    const init = await b.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
    assert.equal(init.result.serverInfo.name, "kivi-talk");
    assert.equal(init.result.protocolVersion, "2025-06-18");
    const list = await b.rpc("tools/list", {});
    assert.deepEqual(list.result.tools.map((t) => t.name).sort(),
      ["call_confirm", "call_end", "call_instruct", "call_next", "call_say", "call_start", "call_status"]);
    assert.equal((await b.rpc("does/not/exist", {})).error.code, -32601);
    assert.deepEqual((await b.rpc("ping", {})).result, {});
  } finally { b.stop(); }
});

test("call tools refuse to run before call_start", async () => {
  const b = startBridge();
  try {
    await b.init();
    assert.match(await b.tool("call_next", { wait_seconds: 5 }), /No call is open/);
    assert.match(await b.tool("call_say", { text: "hi" }), /No call is open/);
    assert.match(await b.tool("call_confirm", { action: "rm -rf x", why: "clean" }), /No call is open/);
    assert.match(await b.tool("call_instruct", { text: "listening mode" }), /No call is open/);
  } finally { b.stop(); }
});

test("call_instruct pushes a redacted instruction, never a spoken answer, and closes no request", async () => {
  const { b, page } = await started();
  const events = page.sse();
  try {
    await events.waitFor((f) => f.type === "hello");
    await page.post("typed", { text: "let me dictate, don't interrupt" });
    await b.tool("call_next", { wait_seconds: 5 });            // r1 in flight
    const out = await b.tool("call_instruct", { text: "You are now in **listening mode**. Key sk-abcdefghijklmnopqrstuvwxyz123456" });
    assert.match(out, /Instruction sent to the voice/);
    const ins = await events.waitFor((f) => f.type === "instruct");
    assert.match(ins.text, /^You are now in listening mode\./);
    assert.doesNotMatch(ins.text, /sk-abc/);
    assert.match(ins.text, /\[secret removed\]/);
    assert.ok(!events.frames.some((f) => f.type === "say"), "nothing is spoken");
    assert.deepEqual(JSON.parse(await b.tool("call_status")).inFlight.map((r) => r.id), ["r1"], "the request stays open");
    assert.match(await b.tool("call_instruct", { text: "" }), /Nothing to send/);
  } finally { await events.close(); b.stop(); }
});

test("the voice briefing defines listening mode as opt-in", async () => {
  const oa = await mockOpenAI();
  const { b, page } = await started({ TTC_OPENAI_BASE: oa.base, TTC_OPENAI_API_KEY: KEY });
  try {
    await page.post("live", { sdp: "v=0 offer" });
    const sent = JSON.parse(oa.seen.find((s) => s.url === "/v1/live/sessions").body);
    assert.match(sent.session.instructions, /only when you are told you are in listening mode/);
    assert.match(sent.session.instructions, /Never enter it on your own/);
    assert.equal(sent.session.turn_detection, undefined, "default turn-taking is untouched");
  } finally { b.stop(); oa.close(); }
});

test("call_start never prints a reusable secret: only a one-time link and the port", async () => {
  const b = startBridge();
  try {
    await b.init();
    const out = await b.tool("call_start", {});
    assert.match(out, /\[ttc-bridge\] port=\d+ call=[a-f0-9]{12}/);
    assert.match(out, /one-time link/);
    const page = await b.open();
    assert.ok(!out.includes(page.cookie.split("=")[1]), "the page cookie never appears in Claude's transcript");
    const hand = JSON.parse(fs.readFileSync(path.join(b.data, "bridges", new URL(page.base).port + ".json"), "utf8"));
    assert.ok(!out.includes(hand.hookToken), "the hook token never appears in Claude's transcript");
  } finally { b.stop(); }
});

test("the launch link works once, sets a locked-down cookie, and a second use is refused", async () => {
  const b = startBridge();
  try {
    await b.init();
    await b.tool("call_start", {});
    const link = b.launchUrl();
    const page = await b.open();
    assert.match(page.setCookie, /HttpOnly/);
    assert.match(page.setCookie, /SameSite=Strict/);
    assert.match(page.setCookie, /Path=\/c\/[a-f0-9]{12}\//);
    assert.equal((await page.get("")).status, 200);
    const again = await fetch(link, { redirect: "manual" });
    assert.equal(again.status, 410, "a spent link is dead");
    // Its own browser, holding the cookie, is simply sent back to the page.
    const mine = await fetch(link, { redirect: "manual", headers: { cookie: page.cookie } });
    assert.equal(mine.status, 302);
    // Reopening from Claude mints a new link for the same call.
    await b.tool("call_start", {});
    const fresh = b.launchUrl();
    assert.notEqual(fresh, link);
    assert.equal((await fetch(fresh, { redirect: "manual" })).status, 302);
  } finally { b.stop(); }
});

test("HTTP gates: host, cookie, origin, content type, method", async () => {
  const { b, page } = await started();
  try {
    const port = new URL(page.base).port;
    const p = new URL(page.base).pathname;
    // DNS rebinding: the attacker's hostname arrives in Host.
    assert.equal(await rawGet(port, p, { host: "attacker.example:" + port, cookie: page.cookie }), 421);
    // No cookie: the page and every endpoint refuse.
    assert.equal((await fetch(page.base)).status, 403);
    assert.equal((await post(page.base + "typed", { text: "rm -rf" })).status, 403);
    assert.equal((await fetch(page.base + "events")).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/c/000000000000/`, { headers: { cookie: page.cookie } })).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);
    // Cookie, but a cross-site Origin (SameSite would normally stop the cookie; this is the belt).
    assert.equal((await page.post("typed", { text: "rm -rf" }, { origin: "https://attacker.example" })).status, 403);
    const form = await fetch(page.base + "typed", { method: "POST", headers: { cookie: page.cookie, "content-type": "application/x-www-form-urlencoded" }, body: "text=hi" });
    assert.equal(form.status, 415);
    assert.equal((await fetch(page.base + "typed", { method: "PUT", headers: { cookie: page.cookie, "content-type": "application/json" }, body: "{}" })).status, 405);
    assert.equal((await page.post("transcript", { role: "user", text: "hello" }, { origin: `http://127.0.0.1:${port}` })).status, 200);
  } finally { b.stop(); }
});

test("the hook token opens status and notices only, and never from a browser", async () => {
  const { b, page } = await started();
  try {
    const port = new URL(page.base).port;
    const hand = JSON.parse(fs.readFileSync(path.join(b.data, "bridges", port + ".json"), "utf8"));
    const h = { "x-ttc-hook": hand.hookToken };
    assert.equal((await fetch(page.base + "status", { headers: h })).status, 200);
    assert.equal((await post(page.base + "notify", { text: "hi" }, h)).status, 200);
    assert.equal((await post(page.base + "typed", { text: "do something" }, h)).status, 403, "hooks cannot inject requests");
    assert.equal((await post(page.base + "live", { sdp: "x" }, h)).status, 403, "hooks cannot open paid sessions");
    assert.equal((await fetch(page.base + "status", { headers: { ...h, origin: "https://attacker.example" } })).status, 403);
  } finally { b.stop(); }
});

test("the page is locked down: CSP with nonce, no framing, no key inside", async () => {
  const { b, page } = await started({ TTC_OPENAI_API_KEY: KEY });
  try {
    const r = await page.get("");
    const html = await r.text();
    const csp = r.headers.get("content-security-policy");
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9+/=]+'/);
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.ok(!html.includes(KEY), "the key must never be in the page");
    assert.ok(!html.includes("__NONCE__") && !html.includes("__CONFIG__"));
    assert.match(html, /"keyHint":"ends in WXYZ"/);
  } finally { b.stop(); }
});

test("a spoken request round-trips: delegate -> call_next -> call_say -> page", async () => {
  const { b, page } = await started();
  const events = page.sse();
  try {
    await events.waitFor((f) => f.type === "hello");
    const next = b.tool("call_next", { wait_seconds: 10 });
    await sleep(150);
    const d = await page.post("delegate", {
      delegation_id: "dlg_1",
      said: ["how many markdown files", "are in this folder"],
      recent: [{ role: "voice", text: "Claude is listening." }, { role: "user", text: "how many markdown files are in this folder" }],
    });
    assert.equal(d.status, 200);
    assert.equal(d.json.claudeWaiting, true);
    const got = await next;
    assert.match(got, /REQUEST r1/);
    assert.match(got, /how many markdown files are in this folder/);
    assert.match(got, /Voice: Claude is listening\./);
    assert.match(got, /lines marked Voice are the voice model, not the user/);
    const working = await events.waitFor((f) => f.type === "working" && f.id === "r1");
    assert.deepEqual(working.delegationIds, ["dlg_1"]);

    const said = await b.tool("call_say", { id: "r1", text: "There are **three** markdown files: `README.md`, see https://x.y/z" });
    assert.match(said, /answer to r1/);
    const say = await events.waitFor((f) => f.type === "say");
    assert.equal(say.final, true);
    assert.deepEqual(say.delegationIds, ["dlg_1"]);
    assert.equal(say.text, "There are three markdown files: README.md, see a link");
    assert.equal(JSON.parse(await b.tool("call_status")).inFlight.length, 0, "a final answer closes the request");
  } finally { await events.close(); b.stop(); }
});

test("requests queue while Claude is busy, and a repeat delegation joins the waiting request", async () => {
  const { b, page } = await started();
  try {
    const first = await page.post("delegate", { delegation_id: "d1", said: ["first thing"], recent: [] });
    assert.equal(first.json.claudeWaiting, false);
    const second = await page.post("delegate", { delegation_id: "d2", said: ["second thing"], recent: [] });
    assert.equal(second.json.ahead, 1);
    const repeat = await page.post("delegate", { delegation_id: "d3", said: [], recent: [] });
    assert.equal(repeat.json.attached, true);
    assert.equal(repeat.json.id, second.json.id);
    assert.match(await b.tool("call_next", { wait_seconds: 5 }), /REQUEST r1[\s\S]*first thing/);
    assert.match(await b.tool("call_next", { wait_seconds: 5 }), /REQUEST r2[\s\S]*second thing/);
    assert.deepEqual(JSON.parse(await b.tool("call_status")).inFlight.map((r) => r.id), ["r1", "r2"]);
  } finally { b.stop(); }
});

test("a delegation with nothing new said never re-sends an older command", async () => {
  const { b, page } = await started();
  try {
    const r = await page.post("delegate", { delegation_id: "d1", said: [], recent: [] });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /say it again/);
    // The user's last line is history, not a new request: running it again could repeat a command.
    const r2 = await page.post("delegate", { delegation_id: "d2", said: [], recent: [{ role: "user", text: "run the migration" }] });
    assert.equal(r2.status, 400);
    assert.match(await b.tool("call_next", { wait_seconds: 5 }), /Nothing new yet/);
  } finally { b.stop(); }
});

test("each redeemed link rotates the page secret and cuts off whoever held the old one", async () => {
  const b = startBridge();
  try {
    await b.init();
    await b.tool("call_start", {});
    const intruder = await b.open();                    // someone else redeemed the first link
    const events = intruder.sse();
    await events.waitFor((f) => f.type === "hello");
    assert.equal((await intruder.post("typed", { text: "x" })).status, 200);
    await b.tool("call_start", {});                     // the owner asks Claude for a fresh link
    const owner = await b.open();
    assert.equal((await intruder.post("typed", { text: "rm -rf" })).status, 403, "old cookie is dead");
    assert.equal((await intruder.get("")).status, 403);
    await events.close();
    assert.equal((await owner.post("typed", { text: "hello" })).status, 200);
  } finally { b.stop(); }
});

test("the approval card shows the exact action, while the spoken reason is redacted", async () => {
  const { b, page } = await started();
  const events = page.sse();
  try {
    await events.waitFor((f) => f.type === "hello");
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b";
    const asked = b.tool("call_confirm", { action: `git push --force origin ${sha}:main`, why: "Force-push, token sk-abcdefghijklmnopqrstuvwxyz123456" });
    const card = await events.waitFor((f) => f.type === "confirm");
    assert.equal(card.action, `git push --force origin ${sha}:main`, "nothing blanked out of what is being approved");
    assert.doesNotMatch(card.why, /sk-abc/);
    await page.post("confirm", { id: card.id, approved: false });
    await asked;
  } finally { await events.close(); b.stop(); }
});

test("a typed secret is redacted before the page can forward it to OpenAI", async () => {
  const { b, page } = await started();
  const events = page.sse();
  try {
    await events.waitFor((f) => f.type === "hello");
    await page.post("typed", { text: "set DB_PASSWORD=hunter2hunter2 in the env" });
    await b.tool("call_next", { wait_seconds: 5 });
    const working = await events.waitFor((f) => f.type === "working");
    assert.doesNotMatch(working.text, /hunter2/);
  } finally { await events.close(); b.stop(); }
});

test("a focus containing $' or $& cannot break the page", async () => {
  const b = startBridge();
  try {
    await b.init();
    await b.tool("call_start", { focus: "price $' and $& and $` here" });
    const page = await b.open();
    const html = await (await page.get("")).text();
    assert.match(html, /price \$' and \$& and \$` here/);
    assert.equal((html.match(/<\/html>/g) || []).length, 1, "the template was not spliced into itself");
  } finally { b.stop(); }
});

test("call_next times out with 'nothing new' and never loses a request", async () => {
  const { b, page } = await started();
  try {
    assert.match(await b.tool("call_next", { wait_seconds: 5 }), /Nothing new yet/);
    await page.post("typed", { text: "late request" });
    assert.match(await b.tool("call_next", { wait_seconds: 5 }), /late request/);
  } finally { b.stop(); }
});

test("a cancelled call_next stops waiting without eating the next request", async () => {
  const { b, page } = await started();
  try {
    const id = b.nextRpcId();
    const pending = b.tool("call_next", { wait_seconds: 30 }, id);
    await sleep(150);
    b.notify("notifications/cancelled", { requestId: id, reason: "user pressed Esc" });
    await sleep(150);
    assert.equal(JSON.parse(await b.tool("call_status")).nextPending, false);
    await page.post("typed", { text: "still here" });
    assert.match(await b.tool("call_next", { wait_seconds: 5 }), /still here/);
    const settled = await Promise.race([pending.then(() => "answered"), sleep(300).then(() => "silent")]);
    assert.equal(settled, "silent", "a cancelled request gets no response");
  } finally { b.stop(); }
});

test("call_confirm waits for a click on the page and reports exactly what was approved", async () => {
  const { b, page } = await started();
  const events = page.sse();
  try {
    await events.waitFor((f) => f.type === "hello");
    const asked = b.tool("call_confirm", { action: "git push --force origin main", why: "I want to force-push main." });
    const card = await events.waitFor((f) => f.type === "confirm");
    assert.equal(card.action, "git push --force origin main");
    assert.equal((await page.post("confirm", { id: "k00000000", approved: true })).status, 404, "unknown id");
    assert.equal((await page.post("confirm", { id: card.id, approved: true })).status, 200);
    assert.match(await asked, /^APPROVED: the user clicked Approve on the call page for exactly this: git push --force origin main/);

    const asked2 = b.tool("call_confirm", { action: "rm -rf build", why: "Clean the build folder." });
    const card2 = await events.waitFor((f) => f.type === "confirm" && f.id !== card.id);
    await page.post("confirm", { id: card2.id, approved: false });
    assert.match(await asked2, /^DECLINED/);
    assert.equal((await page.post("confirm", { id: card2.id, approved: true })).status, 404, "an answered confirmation cannot be flipped");
  } finally { await events.close(); b.stop(); }
});

test("call_confirm declines on timeout, when the page is gone, and when the call ends", async () => {
  const { b, page } = await started({ TTC_CONFIRM_SECONDS: "1" });
  try {
    assert.match(await b.tool("call_confirm", { action: "deploy", why: "Deploy." }), /DECLINED: the call page is not connected/);
    const events = page.sse();
    await events.waitFor((f) => f.type === "hello");
    assert.match(await b.tool("call_confirm", { action: "deploy", why: "Deploy." }), /DECLINED: no answer/);
    const pending = b.tool("call_confirm", { action: "deploy", why: "Deploy." });
    await events.waitFor((f) => f.type === "confirm" && f.action === "deploy" && events.frames.filter((x) => x.type === "confirm").length === 2);
    await page.post("state", { state: "closed", reason: "bye" });
    assert.match(await pending, /DECLINED: the call ended/);
    await events.close();
  } finally { b.stop(); }
});

test("/live proxies the offer with the key server-side and returns only the answer", async () => {
  const oa = await mockOpenAI();
  const { b, page } = await started({ TTC_OPENAI_BASE: oa.base, TTC_OPENAI_API_KEY: KEY, TTC_VOICE: "marin" });
  try {
    const r = await page.post("live", { sdp: "v=0 offer" });
    assert.equal(r.status, 200);
    assert.equal(r.json.sdp, "v=0 answer");
    assert.ok(!r.text.includes(KEY));
    const call = oa.seen.find((s) => s.url === "/v1/live/sessions");
    assert.equal(call.auth, "Bearer " + KEY);
    const sent = JSON.parse(call.body);
    assert.equal(sent.session.model, "gpt-live-1");
    assert.deepEqual(sent.session.delegation, { type: "client" });
    assert.equal(sent.session.store, false);
    assert.equal(sent.session.audio.output.voice, "marin");
    assert.equal(sent.transport.type, "webrtc");
    assert.equal(sent.transport.sdp, "v=0 offer");
    assert.match(sent.session.instructions, /testing/);
    assert.ok(sent.session.instructions.length < 16000 * 3, "well inside the 16,384-token instructions cap");
    assert.equal(JSON.parse(await b.tool("call_status")).state, "connecting");
  } finally { b.stop(); oa.close(); }
});

test("/live with no key asks for one; a refused key says so without echoing it", async () => {
  const oa = await mockOpenAI({ liveStatus: 401 });
  const noKey = await started({ TTC_OPENAI_BASE: oa.base });
  try {
    const r = await noKey.page.post("live", { sdp: "v=0 offer" });
    assert.equal(r.status, 400);
    assert.equal(r.json.needKey, true);
  } finally { noKey.b.stop(); }
  const bad = await started({ TTC_OPENAI_BASE: oa.base, TTC_OPENAI_API_KEY: KEY });
  try {
    const r = await bad.page.post("live", { sdp: "v=0 offer" });
    assert.equal(r.status, 401);
    assert.equal(r.json.needKey, true);
    assert.match(r.json.error, /ends in WXYZ/);
    assert.ok(!r.text.includes(KEY));
  } finally { bad.b.stop(); oa.close(); }
});

test("key sources: an unfilled plugin placeholder is ignored, the plugin setting is used when set", async () => {
  const oa = await mockOpenAI();
  const a = await started({ TTC_OPENAI_BASE: oa.base, CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY: "${user_config.openai_api_key}", OPENAI_API_KEY: KEY });
  try {
    assert.equal(JSON.parse(await a.b.tool("call_status")).keySource, "OPENAI_API_KEY environment variable");
  } finally { a.b.stop(); }
  const c = await started({ TTC_OPENAI_BASE: oa.base, CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY: KEY });
  try {
    assert.equal(JSON.parse(await c.b.tool("call_status")).keySource, "plugin setting");
  } finally { c.b.stop(); oa.close(); }
});

test("/key checks the key with OpenAI before saving it, and saves it only on disk", async () => {
  const oa = await mockOpenAI();
  const { b, page } = await started({ TTC_OPENAI_BASE: oa.base });
  try {
    assert.equal((await page.post("key", { key: "not-a-key" })).status, 400);
    const ok = await page.post("key", { key: KEY });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.keyHint, "ends in WXYZ");
    assert.ok(!ok.text.includes(KEY));
    const saved = JSON.parse(fs.readFileSync(path.join(b.data, "config.json"), "utf8"));
    assert.equal(saved.openai_api_key, KEY);
    assert.equal(oa.seen.at(-1).url, "/v1/models/gpt-live-1");
    assert.equal(JSON.parse(await b.tool("call_status")).keySource, "saved on this computer");
  } finally { b.stop(); oa.close(); }
  const oaBad = await mockOpenAI({ modelStatus: 401 });
  const b2 = await started({ TTC_OPENAI_BASE: oaBad.base });
  try {
    assert.equal((await b2.page.post("key", { key: KEY })).status, 400);
    assert.ok(!fs.existsSync(path.join(b2.b.data, "config.json")), "a refused key is not saved");
  } finally { b2.b.stop(); oaBad.close(); }
});

test("the page hanging up ends the call, and call_next reports it with the transcript", async () => {
  const { b, page } = await started();
  try {
    await page.post("state", { state: "live" });
    await page.post("transcript", { role: "user", text: "hello there" });
    const next = b.tool("call_next", { wait_seconds: 30 });
    await sleep(100);
    await page.post("state", { state: "closed", reason: "You said goodbye." });
    const got = await next;
    assert.match(got, /CALL ENDED \(You said goodbye\.\)/);
    const file = got.match(/Transcript: (.+)/)[1].trim();
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(lines.some((l) => l.role === "user" && l.text === "hello there"));
    assert.equal((await page.post("live", { sdp: "x" })).status, 409, "an ended call cannot reopen");
    assert.equal((await page.post("typed", { text: "x" })).status, 409);
  } finally { b.stop(); }
});

test("transcripts are not written to disk unless asked for", async () => {
  const { b, page } = await started({ TTC_KEEP_TRANSCRIPTS: "" });
  try {
    await page.post("typed", { text: "secret project plans" });
    await b.tool("call_next", { wait_seconds: 5 });
    await page.post("state", { state: "closed", reason: "done" });
    const got = await b.tool("call_next", { wait_seconds: 5 });
    assert.doesNotMatch(got, /Transcript:/);
    assert.match(got, /What the user asked for: secret project plans/);
    assert.ok(!fs.existsSync(path.join(b.data, "calls")), "nothing written");
  } finally { b.stop(); }
});

test("a closed tab ends a live call after the grace window", async () => {
  const { b, page } = await started({ TTC_PAGE_GONE_SECONDS: "1" });
  try {
    const events = page.sse();
    await events.waitFor((f) => f.type === "hello");
    await page.post("state", { state: "live" });
    await events.close();
    await sleep(1600);
    const st = JSON.parse(await b.tool("call_status"));
    assert.equal(st.state, "ended");
    assert.equal(st.endReason, "the call page was closed");
  } finally { b.stop(); }
});

test("a page that reconnects gets what was said while it was away", async () => {
  const { b, page } = await started();
  try {
    await page.post("typed", { text: "q" });
    await b.tool("call_next", { wait_seconds: 5 });
    await b.tool("call_say", { text: "Answer while the page was away." });
    const events = page.sse();
    const say = await events.waitFor((f) => f.type === "say");
    assert.equal(say.text, "Answer while the page was away.");
    await events.close();
  } finally { b.stop(); }
});

test("call_end tells the page to hang up", async () => {
  const { b, page } = await started();
  const events = page.sse();
  try {
    await events.waitFor((f) => f.type === "hello");
    assert.match(await b.tool("call_start", {}), /already open/);
    assert.match(await b.tool("call_end", { reason: "user asked" }), /Hanging up/);
    const end = await events.waitFor((f) => f.type === "end");
    assert.equal(end.reason, "user asked");
  } finally { await events.close(); b.stop(); }
});

test("an oversized body is refused", async () => {
  const { b, page } = await started();
  try {
    const r = await page.post("transcript", { text: "x".repeat(300 * 1024) }).catch(() => ({ status: 413 }));
    assert.equal(r.status, 413);
  } finally { b.stop(); }
});

test("work still in flight reads as 'working' even while a call_next waits (no idle hang-up mid-task)", async () => {
  const { b, page } = await started();
  try {
    await page.post("typed", { text: "long job" });
    await b.tool("call_next", { wait_seconds: 5 });            // r1 in flight
    const waiting = b.tool("call_next", { wait_seconds: 6 });  // Claude went back to listening early
    await sleep(150);
    const st = JSON.parse(await (await page.get("status")).text());
    assert.equal(st.nextPending, true);
    assert.equal(st.claude, "working", "the page's idle timer must see the job");
    await waiting;
  } finally { b.stop(); }
});

test("call_say with a stale id never closes a different request", async () => {
  const { b, page } = await started();
  try {
    await page.post("typed", { text: "one" });
    await b.tool("call_next", { wait_seconds: 5 });            // r1
    await b.tool("call_say", { id: "r1", text: "done one" });
    await page.post("typed", { text: "two" });
    await b.tool("call_next", { wait_seconds: 5 });            // r2 in flight
    await b.tool("call_say", { id: "r1", text: "late extra note about one" });
    assert.deepEqual(JSON.parse(await b.tool("call_status")).inFlight.map((r) => r.id), ["r2"], "r2 is still open");
  } finally { b.stop(); }
});

test("a repeat delegation joins the NEWEST request, not the oldest in flight", async () => {
  const { b, page } = await started();
  try {
    await page.post("delegate", { delegation_id: "d1", said: ["first"], recent: [] });
    await b.tool("call_next", { wait_seconds: 5 });            // r1 in flight
    await page.post("delegate", { delegation_id: "d2", said: ["second"], recent: [] });   // r2 queued
    const again = await page.post("delegate", { delegation_id: "d3", said: [], recent: [] });
    assert.equal(again.json.id, "r2");
  } finally { b.stop(); }
});

test("one voice session per call: a second /live is refused until the first is abandoned", async () => {
  const oa = await mockOpenAI();
  const { b, page } = await started({ TTC_OPENAI_BASE: oa.base, TTC_OPENAI_API_KEY: KEY });
  try {
    assert.equal((await page.post("live", { sdp: "v=0 a" })).status, 200);
    const second = await page.post("live", { sdp: "v=0 b" });
    assert.equal(second.status, 409);
    assert.match(second.json.error, /already connected/);
    await page.post("state", { state: "reset" });              // the page cancelled its attempt
    assert.equal((await page.post("live", { sdp: "v=0 c" })).status, 200);
    await page.post("state", { state: "live" });
    assert.equal((await page.post("live", { sdp: "v=0 d" })).status, 409);
    assert.equal(oa.seen.filter((s) => s.url === "/v1/live/sessions").length, 2);
  } finally { b.stop(); oa.close(); }
});

test("a request still queued when the user hung up is reported, not run", async () => {
  const { b, page } = await started();
  try {
    await page.post("typed", { text: "deploy the site" });
    await page.post("state", { state: "closed", reason: "bye" });
    const got = await b.tool("call_next", { wait_seconds: 5 });
    assert.match(got, /^CALL ENDED/);
    assert.match(got, /not answered on the call: "deploy the site"/);
    assert.doesNotMatch(got, /Do this now/);
  } finally { b.stop(); }
});

test("spoken answers stay under the 500-token append limit in any script", () => {
  const cjk = "这是一个很长的回答。".repeat(80);
  const out = fitSpoken(cjk);
  assert.ok(estimateTokens(out) <= 400, `CJK came to ${estimateTokens(out)} estimated tokens`);
  assert.match(out, /There is more; ask if you want the rest\.$/);
  const hebrew = "זו תשובה ארוכה מאוד על הקבצים בתיקייה. ".repeat(40);
  assert.ok(estimateTokens(fitSpoken(hebrew)) <= 400);
  assert.equal(fitSpoken("Short and sweet."), "Short and sweet.");
});

test("peer-account check reads the kernel's socket table correctly", () => {
  // Server listening on 127.0.0.1:40000 (0x9C40), a client on port 51234 (0xC822) owned by uid 1001.
  const table = [
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
    "   0: 0100007F:9C40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111",
    "   1: 0100007F:9C40 0100007F:C822 01 00000000:00000000 00:00000000 00000000  1000        0 112",
    "   2: 0100007F:C822 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 113",
  ].join("\n");
  assert.deepEqual(peerUidFromTable(table, 51234, 40000), { sawListener: true, uid: 1001 });
  assert.deepEqual(peerUidFromTable(table, 50000, 40000), { sawListener: true, uid: null }, "unknown client is not guessed");
  assert.equal(peerUidFromTable("header only", 51234, 40000).sawListener, false);
});

test("speakable strips what should not be read aloud", () => {
  assert.equal(speakable("## Done\n- **Fixed** the `parser`\n- see [docs](https://a.b/c)"), "Done Fixed the parser see docs");
  assert.equal(speakable("Run:\n```bash\nnpm test\n```\nall green"), "Run: (code omitted) all green");
  assert.equal(speakable("open https://example.com/x?y=1 now"), "open a link now");
});

test("secrets never reach the voice", () => {
  // Fakes are assembled at runtime so no secret-shaped literal sits in the repo for scanners.
  const j = (...p) => p.join("");
  const cases = [
    j("the key is sk-", "proj-abcdefghijklmnopqrstuvwxyz0123456789"),
    j("token gh", "p_abcdefghijklmnopqrstuvwxyz0123456789"),
    j("AK", "IAABCDEFGHIJKLMNOP is the id"),
    j("jwt ey", "JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"),
    "value 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "password: hunter2hunter2",
    "DB_PASSWORD=hunter2hunter2",
    "OPENAI_API_KEY='hunter2hunter2'",
    "the password is hunter2hunter2",
    "**the token is hunter2hunter2**",
  ];
  for (const c of cases) {
    const out = redactSecrets(c);
    assert.ok(!/sk-proj-abc|ghp_abc|AKIAABC|eyJhbGci|9f86d081|hunter2/.test(out), `leaked: ${out}`);
  }
  assert.equal(redactSecrets("I changed two lines in server.js"), "I changed two lines in server.js", "ordinary speech untouched");
  assert.match(speakable("done, key sk-abcdefghijklmnopqrstuvwxyz123456 set"), /\[secret removed\]/);
});
