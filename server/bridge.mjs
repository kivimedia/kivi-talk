#!/usr/bin/env node
/* kivi-talk bridge.
 *
 * One process per Claude Code session, started by the plugin's .mcp.json.
 *   - stdio: a small MCP server (newline-delimited JSON-RPC 2.0) with the call_* tools.
 *   - http:  127.0.0.1 on a random port, serving the call page and its API under /c/<call id>/,
 *            behind a cookie the browser only gets by redeeming a one-time launch link.
 *
 * The session that started this process IS the brain. OpenAI gpt-live-1 is only the ear and
 * the mouth: when it wants work done it emits session.delegation.created, the page posts the
 * request here, call_next hands it to Claude, and call_say sends the answer back to the page,
 * which gives it to the voice as session.commentary.append.
 *
 * The OpenAI key never leaves this process. The page sends an SDP offer, this posts it with the
 * session config to POST /v1/live/sessions and hands back the SDP answer.
 *
 * Zero dependencies on purpose: a plugin has no install step, so whatever Node ships is all
 * there is.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION = "0.6.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = process.env;

const OPENAI_BASE = (ENV.TTC_OPENAI_BASE || "https://api.openai.com").replace(/\/+$/, "");
const MODEL = ENV.TTC_MODEL || "gpt-live-1";
const VOICE = (ENV.TTC_VOICE || "").trim();
const LANGUAGE = (ENV.TTC_LANGUAGE || "").trim();
const IDLE_MIN = num(ENV.TTC_IDLE_MINUTES, 5);
const MAX_MIN = num(ENV.TTC_MAX_MINUTES, 60);
const PRICE_PER_MIN = num(ENV.TTC_PRICE_PER_MINUTE, 0.05);
const START_GRACE_MIN = num(ENV.TTC_START_GRACE_MINUTES, 10);
const PAGE_GONE_MS = num(ENV.TTC_PAGE_GONE_SECONDS, 20) * 1000;
/* Claude Code aborts a stdio tool call that says nothing for 30 minutes, and moves any call still
   running after 2 minutes to a background task (the session stays free; the result arrives as a
   task notification). 20 minutes sits inside the first and makes good use of the second. */
const NEXT_WAIT_DEFAULT = num(ENV.TTC_NEXT_WAIT_SECONDS, 1200);
/* Each commentary append is capped at 500 tokens and a longer one is REJECTED, not trimmed.
   Hebrew runs about 3 characters a token, so 1,400 characters came within a few tokens of the
   wall; 900 leaves room for the page's framing line in any language. */
const SAY_MAX = 900;
const BODY_MAX = 256 * 1024;   // an SDP offer is a few KB
// TTC_DATA_DIR is an override (tests); the plugin passes its own data dir as TTC_PLUGIN_DATA.
const DATA_DIR = realDir(ENV.TTC_DATA_DIR) || realDir(ENV.TTC_PLUGIN_DATA) || realDir(ENV.CLAUDE_PLUGIN_DATA)
  || path.join(os.homedir(), ".kivi-talk");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
const BRIDGES_DIR = path.join(DATA_DIR, "bridges");
/* Transcripts on disk are opt-in: the call already reaches Claude's own session (the whole
   conversation is handed over when the call ends), and keeping a second copy of everything said
   is exactly the "extraneous data" a plugin should not collect by default. */
const KEEP_TRANSCRIPTS = /^(1|true|yes|on)$/i.test(String(ENV.TTC_KEEP_TRANSCRIPTS || ENV.TTC_OPTION_KEEP_TRANSCRIPTS
  || ENV.CLAUDE_PLUGIN_OPTION_KEEP_TRANSCRIPTS || "").trim());
const CONFIRM_WAIT_S = num(ENV.TTC_CONFIRM_SECONDS, 110);
/* What Claude puts on screen and the files that go either way never leave this computer (none of
   it is sent to OpenAI), so the voice's limits do not apply. These caps only keep one call from
   filling the disk or the page. */
const DISPLAY_MAX = 100000;
const DISPLAY_CUT = "\n\n(cut here; the rest is in the Claude window)";
const FILE_MAX = 25 * 1024 * 1024;
const SAY_FILES_MAX = 10;
const PENDING_MAX = 20;
const UPLOADS_DIR = path.join(DATA_DIR, "uploads");
const UPLOAD_KEEP_MS = 7 * 86400000;
const NO_MESSAGE = "(no message: the user shared file(s) on the call page)";

function realDir(s) {
  const v = String(s || "").trim();
  return v && !v.includes("${") ? v : "";
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function log(...a) {
  // stdout is the MCP wire. Everything human goes to stderr.
  process.stderr.write("[kivi-talk] " + a.join(" ") + "\n");
}

/* ------------------------------------------------------------------ key -- */

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) || {}; } catch { return {}; }
}

function writeConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
}

/* An unset plugin option can arrive as an empty string or, on some hosts, as the literal
   "${user_config.x}" placeholder. Neither is a key. */
function realKey(s) {
  const v = String(s || "").trim();
  return v && !v.includes("${") ? v : "";
}

/* A key pasted on the call page wins over the plugin setting: it is the newest thing the user
   did about keys, and it was checked with OpenAI before it was saved. Otherwise a rejected
   plugin-setting key could never be replaced from the page that reports the rejection. */
export function resolveKey() {
  const saved = realKey(readConfig().openai_api_key);
  if (saved) return { key: saved, source: "saved on this computer" };
  /* The plugin setting reaches an MCP server ONLY through ${user_config.*} substitution in
     .mcp.json (TTC_OPTION_*): Claude Code exports CLAUDE_PLUGIN_OPTION_* to hook processes, not
     to MCP servers. TTC_OPENAI_API_KEY is for tests and manual runs. */
  const opt = realKey(ENV.TTC_OPTION_OPENAI_API_KEY) || realKey(ENV.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY)
    || realKey(ENV.TTC_OPENAI_API_KEY);
  if (opt) return { key: opt, source: "plugin setting" };
  const env = realKey(ENV.OPENAI_API_KEY);
  if (env) return { key: env, source: "OPENAI_API_KEY environment variable" };
  return { key: "", source: "none" };
}

function keyHint(k) {
  return k ? "ends in " + k.slice(-4) : "";
}

/* ---------------------------------------------------------------- state -- */


let port = 0;
let call = null;              // the one call this session can have at a time

/* Three secrets per call, each with one job:
 *   launch     a one-time code in the link that opens the page. It ends up in the browser's
 *              argv, its history and Claude's transcript, so it is worthless after first use.
 *   secret     what the page actually holds, as an HttpOnly SameSite=Strict cookie. Never
 *              printed, never in a URL.
 *   hookToken  for this plugin's own hooks (status, notices only), handed over in a file only
 *              this user can read. */
function newCall(focus) {
  return {
    id: crypto.randomBytes(6).toString("hex"),
    launch: crypto.randomBytes(24).toString("base64url"),
    secret: crypto.randomBytes(32).toString("base64url"),
    hookToken: crypto.randomBytes(32).toString("base64url"),
    confirms: new Map(),        // confirm id -> { action, why, resolve }
    focus: String(focus || "").trim().slice(0, 500),
    state: "created",           // created -> connecting -> live -> ending -> ended
    createdAt: Date.now(), liveAt: 0, endedAt: 0, endReason: "",
    queue: [],                  // requests Claude has not picked up yet
    inFlight: new Map(),        // id -> request Claude picked up and has not answered
    seq: 0,
    waiter: null,               // the blocked call_next, if any
    lastLoopAt: 0,              // last time Claude touched call_next/call_say
    sse: new Set(),
    outbox: [],                 // page messages waiting for the page to (re)connect
    transcript: [],
    lastAnswered: null,         // { r, at }: the request call_say closed most recently
    pendingHanded: new Map(),   // normalised user line -> hand-overs that arrived before the line itself
    lineIds: new Set(),         // page line ids already recorded, so the hang-up tail and a late post are one line
    tailKeys: new Set(),        // the same for pages that send no ids: by text
    liveId: null, usage: null,
    timers: new Set(),
    logFile: "",
    shared: new Map(),          // file token -> { path, name, type, size }: files Claude put on screen
    uploads: [],                // files the user shared: { id, name, size, type, path, r (the request they went with) }
    uploadSeq: 0, uploading: 0,
  };
}

const isOpen = (c) => c && c.state !== "ended";
const launchUrl = (c) => `http://127.0.0.1:${port}/launch/${c.launch}`;
const bridgeFile = () => path.join(BRIDGES_DIR, `${port}.json`);

function writeBridgeFile(c) {
  try {
    fs.mkdirSync(BRIDGES_DIR, { recursive: true });
    fs.writeFileSync(bridgeFile(), JSON.stringify({ port, call: c.id, hookToken: c.hookToken, pid: process.pid }), { mode: 0o600 });
    try { fs.chmodSync(bridgeFile(), 0o600); } catch {}
  } catch (e) { log("could not write the hook handover file: " + e.message); }
}

process.on("exit", () => { if (port) { try { fs.unlinkSync(bridgeFile()); } catch {} } });
const minutesLive = (c) => (c.liveAt ? ((c.endedAt || Date.now()) - c.liveAt) / 60000 : 0);

function later(c, ms, fn) {
  const t = setTimeout(() => { c.timers.delete(t); fn(); }, ms);
  t.unref?.();
  c.timers.add(t);
  return t;
}

function remember(c, role, text) {
  const line = { at: new Date().toISOString(), role, text: String(text || "").slice(0, 4000) };
  if (role === "user") {
    // Handed over before its own transcript post landed: this is that line.
    const k = norm(line.text), owed = c.pendingHanded.get(k) || 0;
    if (owed) { line.handed = true; c.pendingHanded.set(k, owed - 1); }
  }
  c.transcript.push(line);
  // The whole call goes to Claude when it ends, so keep an hour of it, not the last few minutes.
  if (c.transcript.length > 2000) c.transcript.splice(0, c.transcript.length - 2000);
  if (!KEEP_TRANSCRIPTS) return;
  try {
    if (!c.logFile) {
      const dir = path.join(DATA_DIR, "calls");
      fs.mkdirSync(dir, { recursive: true });
      c.logFile = path.join(dir, `${line.at.slice(0, 10)}-${c.id}.jsonl`);
    }
    fs.appendFileSync(c.logFile, JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch (e) { /* a transcript that cannot be written must not break the call */ }
}

function claudeStatus(c) {
  /* Unanswered work wins over a waiting call_next: Claude can be listening for the next request
     while the last one still runs in the background, and reporting "listening" then would let the
     page hang up for quiet in the middle of the work. */
  const open = [...c.inFlight.values()];
  const working = open.filter((r) => !r.cancelled).at(-1) || open.at(-1);
  const items = requestItems(c);
  if (working) return { claude: "working", on: redactSecrets(working.text), queue: c.queue.length, items };
  if (c.waiter) return { claude: "listening", queue: c.queue.length, items };
  if (Date.now() - c.lastLoopAt < 15000) return { claude: "listening", queue: c.queue.length, items };
  return { claude: "away", queue: c.queue.length, items };
}

/* The page's Requests list (each with a Stop button), oldest first. The text is a glance, not a
   record: redacted and short. "stopping" is work the user cancelled that Claude has not closed.
   Empty once the call has ended: nothing can be stopped then (the hand-off lists what was open). */
function requestItems(c) {
  if (!isOpen(c)) return [];
  return [...c.inFlight.values(), ...c.queue].sort((a, b) => a.n - b.n).map((r) => ({
    id: r.id,
    state: !c.inFlight.has(r.id) ? "queued" : r.cancelled ? "stopping" : "working",
    text: clip(redactSecrets(r.text), 160),
    at: r.startedAt || r.at,
    files: r.files.length,
  }));
}

function push(msg) {
  if (!call) return false;
  if (!call.sse.size) {
    call.outbox.push(msg);
    if (call.outbox.length > 50) call.outbox.shift();
    return false;
  }
  const frame = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of call.sse) { try { res.write(frame); } catch {} }
  return true;
}

function pushStatus() {
  if (call) push({ type: "status", state: call.state, ...claudeStatus(call) });
}

function endCall(reason, usage) {
  const c = call;
  if (!c || c.state === "ended") return;
  c.state = "ended";
  c.endedAt = Date.now();
  c.endReason = String(reason || "ended");
  if (usage) c.usage = usage;
  for (const t of c.timers) clearTimeout(t);
  c.timers.clear();
  for (const [, pending] of c.confirms) {
    if (pending.r) pending.r.unconfirmed = pending.action;
    pending.resolve("DECLINED: the call ended before the user answered. Do not do it. " + AFTER_END);
  }
  c.confirms.clear();
  c.launch = null;
  remember(c, "system", "call ended: " + c.endReason);
  // Files still waiting stay on disk for the hand-off, but no request will take them now.
  if (pendingUploads(c).length) push({ type: "attachments", pending: [] });
  push({ type: "end", reason: c.endReason });
  if (c.waiter) { const w = c.waiter; c.waiter = null; w.resolve(endedResult(c)); }
  log(`call ${c.id} ended: ${c.endReason}`);
}

/* ------------------------------------------------------------- requests -- */

/* Long dictation is one request: allow a lot of it, and when it still does not fit, cut between
   lines and say so. Only the lines that went in count as handed over; the rest stay flagged for
   the end of the call instead of silently vanishing. */
const REQ_MAX = 20000;

function enqueue(c, text, recent, delegationId, source, lines) {
  let t = String(text);
  let went = lines || [];
  if (t.length > REQ_MAX) {
    went = [];
    let n = 0;
    for (const l of lines || []) { if (n + l.length + 1 > REQ_MAX) break; went.push(l); n += l.length + 1; }
    const kept = went.length ? went.join(" ") : t.slice(0, REQ_MAX);
    t = kept + ` [cut: ${t.length - kept.length} more characters did not fit in this request; they are in the end-of-call hand-off]`;
  }
  for (const l of went) markHanded(c, l);
  const r = {
    id: "r" + (++c.seq), n: c.seq,
    text: t,
    recent: Array.isArray(recent) ? recent.slice(-12) : [],
    delegationIds: delegationId ? [String(delegationId)] : [],
    source, at: Date.now(),
    // Whatever the user shared since the last request goes with this one, whoever sent it.
    files: pendingUploads(c),
  };
  for (const u of r.files) u.r = r;
  remember(c, "request", `${r.id}: ${r.text}${r.files.length ? ` (with ${r.files.length} file(s) the user shared)` : ""}`);
  if (r.files.length) pushAttachments(c);
  const ahead = c.queue.length + c.inFlight.size;
  if (c.waiter) {
    const w = c.waiter; c.waiter = null;
    w.resolve(deliver(c, r));
    return { r, ahead: 0, claudeWaiting: true };
  }
  c.queue.push(r);
  pushStatus();
  return { r, ahead, claudeWaiting: false };
}

/* Line for line, so the end-of-call hand-off can tell exactly which words never reached Claude.
   The lines a hand-over carries are the newest ones not yet handed over, so the mark goes on the
   latest such copy (a second "yes" is not the first one). */
function markHanded(c, said) {
  const k = norm(said);
  if (!k) return;
  for (let i = c.transcript.length - 1; i >= 0; i--) {
    const l = c.transcript[i];
    if (l.role === "user" && !l.handed && norm(l.text) === k) { l.handed = true; return; }
  }
  c.pendingHanded.set(k, (c.pendingHanded.get(k) || 0) + 1);
}

function deliver(c, r) {
  c.inFlight.set(r.id, r);
  r.startedAt = c.lastLoopAt = Date.now();
  /* The page forwards this to OpenAI as quiet context, so a typed secret must not ride along, and
     neither does anything about the files but how many. */
  push({ type: "working", id: r.id, text: redactSecrets(r.text), delegationIds: r.delegationIds, files: r.files.length });
  pushStatus();
  const convo = r.recent
    .map((l) => `${l.role === "user" ? "User" : "Voice"}: ${String(l.text || "").slice(0, 600)}`)
    .join("\n");
  /* The hooks' classify mode reads this first line; keep "spoken by the user" at its start and
     no closing parenthesis inside it. */
  const how = r.source === "typed" ? "typed on the call page"
    : r.source === "overheard" ? "spoken by the user, transcribed, so words can be misheard; the voice did not hand this over, it may have answered on its own"
    : "spoken by the user, transcribed, so words can be misheard";
  const files = r.files.map((u) => `- ${u.path} (${u.type}, ${humanSize(u.size)})`);
  return text([
    `REQUEST ${r.id} (${how}):`,
    `"${r.text.replace(/"/g, "'")}"`,
    ...(files.length ? ["Files the user shared with this request (use your Read tool; images show you the picture):", ...files] : []),
    convo ? `\nRecent conversation on the call (context only: lines marked Voice are the voice model, not the user):\n${convo}` : "",
    r.source === "overheard"
      ? "\nThe voice kept this to itself instead of passing it to you. If it already answered (see the conversation above), check that answer and correct anything it got wrong; either way, do what the user asked. If the voice's answer was right and there is nothing to do or add (small talk), close it with call_say and quiet=true, so nothing is said twice."
      : "",
    "",
    `Do this now, as if the user had typed it here. When you have the answer, call call_say with id "${r.id}": answer out loud in 1-3 plain sentences, and put code, commands, file paths, links, tables, lists and anything longer on screen with \`display\` (and screenshots or files with \`files\`).`,
    "If it will take more than about 15 seconds, first call call_say with final=false and a one-line progress note.",
    `Before anything destructive or outward-facing, call call_confirm with id "${r.id}" and the exact action, and do it only if it comes back APPROVED.`,
    "Then call call_next again.",
  ].join("\n"));
}

/* The end of a call is not the end of the work. What was said on the call has to reach Claude
   in full, including what the voice kept to itself, because the user expects everything they
   said to be acted on (call 0e88e803c97a: a question answered wrongly by the voice alone never
   reached Claude, and the old summary only listed hand-overs). Budgeted in TOKENS, not
   characters (a Hebrew hour is twice the tokens of an English one), under Claude Code's default
   25,000-token cap on one tool result, and ordered so that what to do and what never reached
   Claude come first: if anything is cut, it is old small talk, never the work. */
const HANDOFF_TOKENS = 18000;
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
/* Every hand-off line is ONE line: stored text (a quoted email in an approval, a pasted
   request) must never start a new line that looks like one of the bridge's own. */
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();
const clip = (s, n) => { s = oneLine(s); return s.length > n ? s.slice(0, n) + "..." : s; };
const AFTER_END = "The call has ended: call call_next once to collect the end-of-call hand-off (the whole conversation), then follow it.";

/* Lines the user said that never reached Claude, in full: these are the work. The hooks' classify
   mode reads exactly this form (upper case) and nothing else. */
function missedLines(c) {
  const t0 = c.liveAt || c.createdAt;
  return c.transcript
    .filter((l) => l.role === "user" && !l.handed && !l.text.startsWith("(typed) "))
    .map((l) => `[+${mmss(Date.parse(l.at) - t0)}] User (NOT HANDED OVER to you during the call): ${oneLine(l.text)}`);
}

function conversation(c, budget) {
  const t0 = c.liveAt || c.createdAt;
  const items = [];
  const add = (s, keep) => items.push({ s, keep, t: estimateTokens(s) + 1 });
  for (const l of c.transcript) {
    const at = "[+" + mmss(Date.parse(l.at) - t0) + "] ";
    if (l.role === "user") {
      const reached = l.handed || l.text.startsWith("(typed) ");
      if (reached) add(at + "User: " + clip(l.text, 1500));
      else add(at + "User (not handed over, in full above): " + clip(l.text, 120), true);
    } else if (l.role === "voice") add(at + "Voice: " + clip(l.text, 600));
    else if (l.role === "request") add(at + "-> handed to you as " + clip(l.text, 300));
    else if (l.role === "claude") add(at + (l.text.startsWith("(progress) ") ? "Claude (progress): " + clip(l.text.slice(11), 4000) : "Claude: " + clip(l.text, 4000)));
    // A cancel stays in: after the call, a cancelled request must not read as work still to do.
    else if (/^(confirmation |instruction to the voice|the user cancelled )/.test(l.text)) add(at + "(" + clip(l.text, 400) + ")");
  }
  let total = items.reduce((n, i) => n + i.t, 0), dropped = 0;
  // Over budget: first shorten every long line, then drop the oldest, never a line that did not
  // reach Claude (its place in the conversation is the context for the work).
  if (total > budget) {
    for (const i of items) if (!i.keep && i.s.length > 200) { total -= i.t; i.s = clip(i.s, 200); i.t = estimateTokens(i.s) + 1; total += i.t; }
  }
  for (let k = 0; k < items.length && total > budget; ) {
    if (items[k].keep) { k++; continue; }
    total -= items[k].t;
    items.splice(k, 1);
    dropped++;
  }
  const lines = items.map((i) => i.s);
  if (dropped) lines.unshift(`(${dropped} earlier line(s) left out for length${c.logFile ? "; they are in the transcript file" : ""})`);
  return lines.join("\n");
}

function mmss(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

// Keep lines in order while they fit the token cap, and say how many did not.
function capLines(lines, cap, where) {
  const out = [];
  let used = 0;
  for (const l of lines) {
    const t = estimateTokens(l) + 1;
    if (used + t > cap) break;
    out.push(l);
    used += t;
  }
  if (out.length < lines.length) out.push(`(${lines.length - out.length} more not shown here for length${where ? "; " + where : ""})`);
  return out;
}

function endedResult(c) {
  const mins = minutesLive(c);
  /* A request whose action the user declined on the page is not unfinished work, and one whose
     approval the hang-up cut off still needs a yes. Say which is which. */
  const open = capLines([...c.inFlight.values(), ...c.queue].map((r) => `${r.id} "${clip(r.text, 600).replace(/"/g, "'")}"`
    + (r.declined ? ` (the user clicked Decline on "${clip(r.declined, 200).replace(/"/g, "'")}": do not redo that)` : "")
    + (r.unconfirmed ? ` (the call ended before the user approved "${clip(r.unconfirmed, 200).replace(/"/g, "'")}": ask in this chat first)` : "")
    + (r.cancelled ? " (the user cancelled it on the call: do not do it)" : "")),
    3000, "each is in the conversation as a hand-over");
  const head = [
    `CALL ENDED (${c.endReason}). ${mins.toFixed(1)} minutes live, about $${(mins * PRICE_PER_MIN).toFixed(2)} of OpenAI voice time.`,
    "",
    "The call is over; the work is not. Stop calling call_next, and now, in this session:",
    "1. Go through the conversation below and list everything the user asked for, decided or said they want, including what the voice answered on its own and every line marked NOT HANDED OVER.",
    "2. Do each item that was not fully done and answered on the call, as if the user had typed it in this chat. The call page is gone, so call_say and call_confirm no longer work: before anything destructive or outward-facing (deleting, force-pushing, deploying, sending a message or email, spending money, changing credentials or permissions), ask in this chat and wait for the answer, because it came from transcribed speech. Never redo something the user declined on the call.",
    "3. If the voice told the user something wrong, correct it.",
    "4. Then write the user a short report: what was done on the call, what you did after it, and anything still open.",
    open.length ? `\nHanded to you but not answered on the call: ${open.join(", ")}` : "",
    uploadsSection(c),
    c.logFile ? `\nTranscript: ${c.logFile}` : "",
  ].filter((s, i) => s || i === 1).join("\n");
  const all = missedLines(c);
  const gone = capLines(all, 11000, c.logFile ? "read them in the transcript file" : "the transcript was not kept on disk");
  const missed = all.length ? `\n\n${all.length} thing(s) the user said never reached you during the call:\n${gone.join("\n")}` : "";
  const intro = "\n\nThe whole conversation, oldest first. User lines are the user's own words (transcribed speech, so words can be misheard). Voice lines are the voice model: not the user, not you, and it can be wrong. Claude lines are what you said.\n\n";
  const convo = conversation(c, HANDOFF_TOKENS - estimateTokens(head + missed + intro));
  return text(head + missed + (convo ? intro + convo : "\n\nNothing was said on the call."));
}

/* Uploads outlive the call so the work after it can open them. A file that rode with a request
   Claude never got (cancelled while it waited) counts as never sent. */
function uploadsSection(c) {
  if (!c.uploads.length) return "";
  const line = (u) => `- ${u.path} (${u.type}, ${humanSize(u.size)})`;
  const never = c.uploads.filter((u) => !u.r || (u.r.cancelled && !u.r.startedAt));
  const sent = c.uploads.filter((u) => !never.includes(u));
  const out = [];
  if (never.length) {
    out.push("\nFiles the user shared on the call but never sent with a request (open them with your Read tool if the conversation calls for it):",
      ...capLines(never.map(line), 1500, "they are all in " + uploadDirPath(c)));
  }
  if (sent.length) {
    out.push("\nFiles the user shared with a request (still on this computer):",
      ...capLines(sent.map((u) => line(u) + ", with " + u.r.id), 1500, "they are all in " + uploadDirPath(c)));
  }
  return out.join("\n");
}

function humanSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1).replace(/\.0$/, "") + " KB";
  return (n / 1048576).toFixed(1).replace(/\.0$/, "") + " MB";
}

/* Anything spoken goes to OpenAI. A key read out loud is a leaked key, and no spoken sentence
   ever needs a 32-character token in it, so these never reach the voice. */
const SECRET_PATTERNS = [
  /\bsk-(?:proj-|ant-|admin-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{32,}/g,
];

export function redactSecrets(s) {
  let out = String(s || "");
  for (const re of SECRET_PATTERNS) out = out.replace(re, " [secret removed] ");
  // NAME=value and NAME: value, including .env names like DB_PASSWORD or OPENAI_API_KEY.
  out = out.replace(/\b([A-Za-z0-9_]*(?:password|passwd|passcode|secret|token|api[_ -]?key|private[_ -]?key)[A-Za-z0-9_]*)(\s*[:=]\s*)["']?[^\s"']+["']?/gi, "$1$2[removed]");
  // "the password is hunter2" / "my token was abc123".
  return out.replace(/\b(password|passcode|secret|token|api key|private key)(\s+(?:is|was|=)\s+)["']?[^\s"',.;]+/gi, "$1$2[removed]");
}

/* Commentary is heard, not read. A star read aloud is the word star, a code block is noise,
   and a URL is thirty seconds of letters. */
export function speakable(s) {
  return redactSecrets(stripMarkdown(redactSecrets(s))).replace(/\s+/g, " ").trim();
}

function stripMarkdown(s) {
  return String(s)
    .replace(/```[\s\S]*?```/g, " (code omitted) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
}

/* The limit is 500 TOKENS, so count roughly in tokens, not characters: Chinese, Japanese and
   Korean run about one token per character, Hebrew, Arabic, Cyrillic and the like two or three
   characters a token, Latin text about four. Deliberately pessimistic. */
export function estimateTokens(s) {
  let t = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x3400 && c <= 0x9fff) || (c >= 0xac00 && c <= 0xd7af) || (c >= 0xf900 && c <= 0xfaff)) t += 1.3;
    else if (c > 0x2ff) t += 0.5;
    else t += 0.3;
  }
  return Math.ceil(t);
}

/* Cut at the last sentence that fits, and say that there is more, rather than stopping the
   voice mid-word (or having OpenAI refuse the whole append and saying nothing at all). */
const MORE = " There is more; ask if you want the rest.";
const SAY_TOKENS = 380;   // 500 minus the page's framing line, with room to spare
export function fitSpoken(s, maxTokens = SAY_TOKENS) {
  s = String(s).slice(0, SAY_MAX * 4);
  if (s.length <= SAY_MAX && estimateTokens(s) <= maxTokens) return s;
  const budget = maxTokens - estimateTokens(MORE);
  const parts = s.match(/[^.!?。！？׃]+[.!?。！？׃]*\s*/g) || [s];
  let out = "";
  for (const p of parts) {
    if (out.length + p.length > SAY_MAX - MORE.length || estimateTokens(out + p) > budget) break;
    out += p;
  }
  if (!out) {   // one enormous sentence: cut at a word
    for (const ch of s) {
      if (out.length + 1 > SAY_MAX - MORE.length || estimateTokens(out + ch) > budget) break;
      out += ch;
    }
    out = out.replace(/\s+\S*$/, "") + ".";
  }
  return out.trim() + MORE;
}

/* ------------------------------------------------------ voice briefing -- */

export function voiceInstructions(focus) {
  const project = path.basename(process.cwd());
  return [
    `You are the voice of Claude, an AI agent working on the user's computer${project ? ` in the folder "${project}"` : ""}. The user is talking to you out loud.`,
    "You cannot see the screen, read files, run anything or look anything up yourself. Claude can: it has its own tools on this computer and works on one request at a time. You are its voice.",
    "",
    "How to handle what the user says:",
    "- Hand EVERYTHING the user says to Claude (delegate): every request, instruction, idea, decision and question, including questions about you, about Claude, about this call, what you or Claude can do, and what is remembered. Say a very short acknowledgement first, such as \"On it.\" or \"Let me check.\", then stop talking and wait.",
    "- The only exceptions, which you answer yourself in one short sentence: a bare greeting, a thank-you, or a goodbye. Anything more than that goes to Claude, even if you think you know the answer.",
    "- Never answer a question yourself and never explain how this call works. You do not know; Claude does. If you ever have to say it: everything said on this call is kept and handed to Claude, which works on it during the call and, when the call ends, reads the whole conversation and finishes anything left over.",
    "- When Claude's answer arrives, say it in your own words, briefly. Keep numbers, names, file names and commands exactly as given. Never invent a result and never guess what Claude found.",
    "- A progress note from Claude: pass it on in a few words. The work is still running.",
    "- While you wait, stay quiet unless the user speaks. If they ask, say Claude is still working.",
    "- If Claude asks the user something or asks them to confirm an action, ask it clearly, then hand their reply to Claude.",
    "- Never read out a password, API key, token or other secret, even if an answer contains one.",
    "- Claude can put things on the user's screen, on the call page: code, links, tables, pictures, files. When it says it did, tell the user to look at the call page, and never try to read that content out: you do not have it.",
    "- The user can share files and screenshots on the call page. You cannot see them; Claude can. Hand anything about them to Claude.",
    "- If the user cancels while Claude works, the page stops that work; just say \"Cancelled.\"",
    "- Keep every reply short. This is a spoken conversation.",
    "- Listening mode: only when you are told you are in listening mode, do not delegate or reply on a pause alone, however long; the user is dictating and pauses to think. Stay silent until an explicit stop cue (\"go ahead\", \"that's it\", \"over to you\", or a direct question to you), then treat everything said since entering the mode as one turn. Leave the mode after a stop cue or when told to resume normally. Never enter it on your own.",
    LANGUAGE ? `- Speak ${LANGUAGE}.` : "- Reply in the language the user speaks.",
    focus ? `\nThe user started this call to work on: ${focus}` : "",
  ].join("\n").trim();
}

/* ---------------------------------------------------------------- http -- */

function tokenOk(given, want) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(String(want || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-resource-policy": "same-origin",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > BODY_MAX) { reject(Object.assign(new Error("body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* On Linux, loopback is shared by every account on the machine, and another account can read the
   launch link out of a browser's argv in /proc and race to redeem it. The kernel records which
   account owns each end of every TCP connection, so the bridge simply refuses connections that
   are not from the account running it. (Windows and macOS do not show other users' argv.)
   Parsed from /proc/net/tcp{,6}: fields are sl, local, remote, st, ..., uid (index 7). */
export function peerUidFromTable(text, clientPort, serverPort) {
  const hex = (n) => ":" + Number(n).toString(16).toUpperCase().padStart(4, "0");
  let sawListener = false, uid = null;
  for (const line of String(text).split("\n").slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 8) continue;
    if (p[1].endsWith(hex(serverPort)) && p[3] === "0A") sawListener = true;
    if (p[1].endsWith(hex(clientPort)) && p[2].endsWith(hex(serverPort))) uid = Number(p[7]);
  }
  return { sawListener, uid };
}

function peerIsMe(req) {
  if (process.platform !== "linux" || typeof process.getuid !== "function") return true;
  const sock = req.socket;
  if (sock.ttcPeerOk !== undefined) return sock.ttcPeerOk;
  let text = "";
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) { try { text += fs.readFileSync(f, "utf8"); } catch {} }
  const { sawListener, uid } = peerUidFromTable(text, sock.remotePort, sock.localPort);
  // A table that does not even show our own listener (some sandboxes, WSL1) cannot be judged.
  sock.ttcPeerOk = !sawListener ? true : uid === process.getuid();
  if (!sock.ttcPeerOk) log(`refused a connection from another account (uid ${uid})`);
  return sock.ttcPeerOk;
}

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return "";
}

function sendNote(res, status, title, body) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kivi Talk</title>`
    + `<body style="font:17px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color-scheme:light dark">`
    + `<h1 style="font-size:22px">${esc(title)}</h1><p>${esc(body)}</p></body>`);
}

/* Every request passes these gates before it is routed:
 *   1. Host must be this port on a loopback name. A DNS-rebinding page arrives with its own
 *      hostname in Host, so it stops here.
 *   2. Origin, when a browser sends one, must be this same origin. Cross-site pages always send
 *      it on POST, so a drive-by POST stops here. Hooks (plain Node fetch) send none.
 *   3. The page's HttpOnly SameSite=Strict cookie (or, for status and notices only, the hooks'
 *      token). The only way to get the cookie is the one-time launch link.
 * There are no CORS headers anywhere, and every POST must be application/json, which a
 * cross-site form cannot send without a preflight this server never answers. The one exception
 * is /upload, which must be application/octet-stream instead: just as impossible for a form, and
 * a 25 MiB file does not become a 35 MiB JSON string. Shared files (/file) are for the page only. */
export async function handle(req, res) {
  if (!peerIsMe(req)) return sendJson(res, 403, { error: "this call belongs to another account on this computer" });
  const host = String(req.headers.host || "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return sendJson(res, 421, { error: "wrong host" });
  const origin = req.headers.origin;
  if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    return sendJson(res, 403, { error: "cross-origin request refused" });
  }
  const url = new URL(req.url, "http://" + host);

  const launch = url.pathname.match(/^\/launch\/([A-Za-z0-9_-]{16,64})$/);
  if (launch) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
    const c = call;
    const already = c && tokenOk(readCookie(req, `ttc_${c.id}`), c.secret);
    if (c && isOpen(c) && (already || (c.launch && tokenOk(launch[1], c.launch)))) {
      if (!already) {
        /* Spent: the code in history, argv and the transcript is dead now. And the page secret
           ROTATES, closing every page that held the old one: whoever redeemed the previous link
           (another OS user can read a browser's argv on macOS and Linux) loses the call the
           moment its owner asks Claude for a fresh link and opens it. Newest opener owns it. */
        c.launch = null;
        c.secret = crypto.randomBytes(32).toString("base64url");
        for (const res of c.sse) { try { res.end(); } catch {} }
        c.sse.clear();
      }
      res.writeHead(302, {
        ...SECURITY_HEADERS,
        "set-cookie": `ttc_${c.id}=${c.secret}; HttpOnly; SameSite=Strict; Path=/c/${c.id}/`,
        location: `/c/${c.id}/`,
      });
      return res.end();
    }
    return sendNote(res, 410, "This call link was already used",
      "Each link opens the call page once. If your call is open in another tab, use that tab. Otherwise ask Claude to open the call page again.");
  }

  const m = url.pathname.match(/^\/c\/([a-f0-9]{12})(\/.*)?$/);
  if (!m || !call || m[1] !== call.id) return sendJson(res, 404, { error: "no such call" });
  const sub = m[2] || "";
  const c = call;
  if (req.method === "GET" && sub === "") { res.writeHead(302, { ...SECURITY_HEADERS, location: `/c/${c.id}/` }); return res.end(); }

  const byPage = tokenOk(readCookie(req, `ttc_${c.id}`), c.secret);
  const byHook = !origin && tokenOk(req.headers["x-ttc-hook"], c.hookToken) && (sub === "/status" || sub === "/notify");
  if (!byPage && !byHook) {
    if (req.method === "GET" && sub === "/") {
      return sendNote(res, 403, "Open the call from Claude",
        "This page only opens through the one-time link Claude gives you. Ask Claude to open the call page again.");
    }
    return sendJson(res, 403, { error: "not your call" });
  }

  if (req.method === "GET") {
    if (sub === "/") return servePage(res, c);
    if (sub === "/events") return serveEvents(req, res, c);
    if (sub === "/status") return sendJson(res, 200, statusObj(c));
    const file = sub.match(/^\/file\/([A-Za-z0-9_-]{32})$/);
    if (file && byPage) return serveFile(res, c, file[1]);
    return sendJson(res, 404, { error: "not found" });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
  if (sub === "/upload") return postUpload(req, res, c);
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    return sendJson(res, 415, { error: "content-type must be application/json" });
  }
  let body;
  try { body = JSON.parse((await readBody(req)) || "{}") || {}; }
  catch (e) { return sendJson(res, e.status || 400, { error: e.status ? e.message : "body must be JSON" }); }

  switch (sub) {
    case "/key": return postKey(res, body);
    case "/live": return postLive(res, c, body);
    case "/state": return postState(res, c, body);
    case "/delegate": return postDelegate(res, c, body);
    case "/typed": return postTyped(res, c, body);
    case "/transcript": return postTranscript(res, c, body);
    case "/notify": return postNotify(res, c, body);
    case "/confirm": return postConfirm(res, c, body);
    case "/mute": return postMute(res, c, body);
    case "/cancel": return postCancel(res, c, body);
    case "/attachments/remove": return postRemoveUpload(res, c, body);
    default: return sendJson(res, 404, { error: "not found" });
  }
}

function statusObj(c) {
  const k = resolveKey();
  const mins = minutesLive(c);
  return {
    call: c.id, state: c.state, endReason: c.endReason || null,
    minutes: Number(mins.toFixed(2)), estimatedCost: Number((mins * PRICE_PER_MIN).toFixed(2)),
    pageConnected: c.sse.size > 0,
    nextPending: Boolean(c.waiter),
    lastLoopAt: c.lastLoopAt,
    keySource: k.source,
    keepTranscripts: KEEP_TRANSCRIPTS,
    ...claudeStatus(c),
    inFlight: [...c.inFlight.values()].map((r) => ({ id: r.id, text: r.text })),
    queued: c.queue.map((r) => ({ id: r.id, text: r.text })),
  };
}

function pageConfig(c) {
  const k = resolveKey();
  return {
    version: VERSION, model: MODEL, project: path.basename(process.cwd()),
    focus: c.focus, state: c.state, endReason: c.endReason || null,
    keyPresent: Boolean(k.key), keySource: k.source, keyHint: keyHint(k.key), configFile: CONFIG_FILE,
    idleMinutes: IDLE_MIN, maxMinutes: MAX_MIN, pricePerMinute: PRICE_PER_MIN,
    ...claudeStatus(c),
  };
}

let pageTemplate = null;
function servePage(res, c) {
  if (!pageTemplate) pageTemplate = fs.readFileSync(path.join(HERE, "call.html"), "utf8");
  const nonce = crypto.randomBytes(16).toString("base64");
  const cfg = JSON.stringify(pageConfig(c)).replace(/</g, "\\u003c");
  // Replacer functions, not strings: a "$'" in the focus or a folder name would otherwise be
  // read as a replacement pattern and splice the rest of the template into the page.
  const html = pageTemplate.replaceAll("__NONCE__", () => nonce).replace("__CONFIG__", () => cfg);
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "media-src 'self' blob: mediastream:",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "permissions-policy": "microphone=(self), camera=(), geolocation=()",
  });
  res.end(html);
}

function serveEvents(req, res, c) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");
  res.write(`data: ${JSON.stringify({ type: "hello", ...pageConfig(c) })}\n\n`);
  c.sse.add(res);
  if (c.goneTimer) { clearTimeout(c.goneTimer); c.timers.delete(c.goneTimer); c.goneTimer = null; }
  for (const m of c.outbox.splice(0)) res.write(`data: ${JSON.stringify(m)}\n\n`);
  // A reloaded page lost its chips; the files are still waiting for the next request.
  if (isOpen(c) && pendingUploads(c).length) res.write(`data: ${JSON.stringify(attachmentsFrame(c))}\n\n`);
  const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 15000);
  req.on("close", () => {
    clearInterval(ka);
    c.sse.delete(res);
    /* The page is the only thing that can hang up the OpenAI session. If it is gone for good
       (tab closed, browser quit) the call is over, and call_next must say so rather than wait
       for a voice that no longer exists. A short blip reconnects inside the grace window. */
    if (!c.sse.size && (c.state === "connecting" || c.state === "live")) {
      // One timer, restarted by each loss and cleared by each reconnect, so two short blips
      // never add up to a hang-up.
      clearTimeout(c.goneTimer);
      c.goneTimer = later(c, PAGE_GONE_MS, () => {
        if (call === c && !c.sse.size && isOpen(c)) endCall("the call page was closed");
      });
    }
  });
}

async function postKey(res, body) {
  const key = realKey(body.key);
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return sendJson(res, 400, { error: "That does not look like an OpenAI API key (they start with sk-)." });
  /* Prove the key before keeping it: a saved key that cannot open a session only moves the
     failure to the moment he presses Start. */
  let r;
  try {
    r = await fetch(`${OPENAI_BASE}/v1/models/${encodeURIComponent(MODEL)}`, {
      headers: { authorization: "Bearer " + key }, signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return sendJson(res, 502, { error: "Could not reach OpenAI to check the key: " + String(e.message || e) });
  }
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    const why = (j.error && j.error.message) || `HTTP ${r.status}`;
    return sendJson(res, 400, { error: `OpenAI did not accept that key for ${MODEL}: ${why}` });
  }
  const cfg = readConfig();
  cfg.openai_api_key = key;
  writeConfig(cfg);
  log(`OpenAI key saved (${keyHint(key)}) to ${CONFIG_FILE}`);
  const overrides = Boolean(realKey(ENV.TTC_OPTION_OPENAI_API_KEY) || realKey(ENV.CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY));
  return sendJson(res, 200, { ok: true, keyHint: keyHint(key), configFile: CONFIG_FILE,
    note: overrides ? "This key is used instead of the one in the plugin settings." : "" });
}

async function postLive(res, c, body) {
  if (!isOpen(c)) return sendJson(res, 409, { error: "This call has ended. Start a new one from Claude with /talk." });
  /* One voice session per call. A second tab (or a double click) opening another would bill
     twice and hand every request to Claude twice. A connect attempt older than the page's own
     20-second timeout is dead and may be replaced. */
  if (c.liveId && (c.state === "live" || (c.state === "connecting" && Date.now() - (c.liveTriedAt || 0) < 25000))) {
    return sendJson(res, 409, { error: "This call is already connected in another tab or window. Use that one, or end it first." });
  }
  const { key, source } = resolveKey();
  if (!key) return sendJson(res, 400, { error: "No OpenAI key yet.", needKey: true });
  const sdp = String(body.sdp || "");
  if (!sdp.trim()) return sendJson(res, 400, { error: "an SDP offer is required" });

  const session = {
    model: MODEL,
    instructions: voiceInstructions(c.focus),
    delegation: { type: "client" },
    store: false,             // the default, said out loud: no stored recording at OpenAI
  };
  if (VOICE) session.audio = { output: { voice: VOICE } };

  let r;
  try {
    r = await fetch(`${OPENAI_BASE}/v1/live/sessions`, {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify({ session, transport: { type: "webrtc", sdp } }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return sendJson(res, 502, { error: "Could not reach OpenAI: " + String(e.message || e) });
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.transport || !j.transport.sdp) {
    const why = (j.error && j.error.message) || `HTTP ${r.status}`;
    log(`live session refused (${r.status}): ${why.slice(0, 300)}`);
    const badKey = r.status === 401 || r.status === 403;
    return sendJson(res, r.ok ? 502 : r.status, {
      error: badKey ? `OpenAI refused the key (${source}, ${keyHint(key)}): ${why}` : `OpenAI would not open the voice session: ${why}`,
      needKey: badKey,
    });
  }
  c.liveId = (j.session && j.session.id) || null;
  c.liveTriedAt = Date.now();
  if (c.state === "created") c.state = "connecting";
  remember(c, "system", `voice session ${c.liveId || "?"} opened on ${MODEL}`);
  pushStatus();
  return sendJson(res, 200, { sdp: j.transport.sdp, id: c.liveId, model: MODEL });
}

function postState(res, c, body) {
  const s = String(body.state || "");
  if (s === "live") {
    if (isOpen(c) && c.state !== "live") {
      c.state = "live";
      c.liveAt = c.liveAt || Date.now();
      remember(c, "system", "voice live");
      // The hard ceiling is also enforced here, in case the page's own timer never fires.
      later(c, (MAX_MIN + 1) * 60000, () => { push({ type: "end", reason: "maximum call length" }); later(c, 15000, () => endCall("maximum call length")); });
      pushStatus();
    }
    return sendJson(res, 200, { ok: true });
  }
  if (s === "closed") {
    /* Words said just before End call are posted at the same moment as this hang-up, and the
       hand-off to Claude goes out the instant the call ends. So the hang-up carries them itself,
       and their own post, whenever it lands, is recognised as the same line. */
    if (isOpen(c) && Array.isArray(body.tail)) {
      for (const l of body.tail.slice(-4)) {
        const role = l && l.role === "voice" ? "voice" : "user";
        const t = String((l && l.text) || "").trim().slice(0, 4000);
        if (!t) continue;
        const id = lineId(l);
        if (id) {
          // Its own post may have landed first: then it is already here. Same id, same line.
          if (c.lineIds.has(id)) continue;
          c.lineIds.add(id);
        } else {
          if (c.transcript.slice(-8).some((x) => x.role === role && x.text === t)) continue;
          c.tailKeys.add(role + "\n" + t);
        }
        remember(c, role, t);
      }
    }
    endCall(String(body.reason || "hung up on the call page").slice(0, 200), body.usage || null);
    return sendJson(res, 200, { ok: true });
  }
  if (s === "reset") {
    // The page gave up on a connect attempt (cancelled, or it failed): the call itself goes on.
    if (c.state === "connecting") { c.state = "created"; c.liveId = null; remember(c, "system", "connect attempt abandoned"); pushStatus(); }
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 400, { error: "state must be live, closed or reset" });
}

function postDelegate(res, c, body) {
  if (!isOpen(c)) return sendJson(res, 409, { error: "the call has ended" });
  const id = body.delegation_id ? String(body.delegation_id) : null;
  const said = (Array.isArray(body.said) ? body.said : []).map((s) => String(s || "").trim()).filter(Boolean);
  const recent = Array.isArray(body.recent) ? body.recent : [];
  const textSaid = said.join(" ").trim();

  /* The delegation event carries an id and nothing else, so the request is whatever the user
     said since the last hand-over. When nothing new was said, the only safe readings are "the
     voice delegated twice for the sentence it just handed over" (join that request, if it is
     seconds old) or "nothing to do". Re-sending an older line would run a finished command a
     second time. */
  if (!textSaid) {
    // The newest, never one the user cancelled: a stopped request takes nothing new.
    const pending = [...c.queue, ...c.inFlight.values()].filter((r) => !r.cancelled).sort((a, b) => a.at - b.at).at(-1);
    if (pending && id && Date.now() - pending.at < 20000) {
      pending.delegationIds.push(id);
      return sendJson(res, 200, { id: pending.id, attached: true, ...ackFor(c, pending) });
    }
    /* The page hands over what the voice kept to itself; if the voice delegates it after all,
       Claude may have answered already. That is the same request, not a new one to say again. */
    const done = c.lastAnswered;
    if (done && id && Date.now() - done.at < 20000 && (!pending || pending.at < done.r.at)) {
      return sendJson(res, 200, { id: done.r.id, attached: true, answered: true });
    }
    return sendJson(res, 400, { error: "I did not catch a request there. Could you say it again?" });
  }
  const t = textSaid;
  // Only a hand-over with no delegation of the voice's own can be one the voice did not make.
  const source = !id && body.source === "overheard" ? "overheard" : "voice";
  const { r, ahead, claudeWaiting } = enqueue(c, t, recent, id, source, said);
  return sendJson(res, 200, { id: r.id, ahead, claudeWaiting, claude: claudeStatus(c).claude });
}

function ackFor(c, r) {
  const idx = c.queue.indexOf(r);
  return { ahead: idx < 0 ? 0 : idx + c.inFlight.size, claudeWaiting: Boolean(c.waiter), claude: claudeStatus(c).claude };
}

function postTyped(res, c, body) {
  if (!isOpen(c)) return sendJson(res, 409, { error: "the call has ended" });
  // Files with nothing typed are still a request: the user is showing Claude something.
  const t = String(body.text || "").trim() || (pendingUploads(c).length ? NO_MESSAGE : "");
  if (!t) return sendJson(res, 400, { error: "empty" });
  remember(c, "user", "(typed) " + t);
  const { r, ahead, claudeWaiting } = enqueue(c, t, c.transcript.filter((l) => l.role === "user" || l.role === "voice").slice(-12), null, "typed");
  return sendJson(res, 200, { id: r.id, ahead, claudeWaiting, claude: claudeStatus(c).claude });
}

// The page numbers its lines; only a small positive integer is an id.
function lineId(l) {
  const n = Number(l && l.id);
  return Number.isInteger(n) && n > 0 && n < 1e7 ? String(n) : "";
}

function postTranscript(res, c, body) {
  const role = body.role === "voice" ? "voice" : "user";
  const t = String(body.text || "").trim();
  if (!t) return sendJson(res, 200, { ok: true });
  const id = lineId(body);
  if (id) {
    if (!c.lineIds.has(id)) { c.lineIds.add(id); remember(c, role, t); }
  } else if (!c.tailKeys.delete(role + "\n" + t)) remember(c, role, t);
  return sendJson(res, 200, { ok: true });
}

/* The answer to a call_confirm comes from a click on the page, never from speech: a spoken "yes"
   can come from a television, and the voice paraphrases, so a read-back is not the exact action. */
function postConfirm(res, c, body) {
  const pending = c.confirms.get(String(body.id || ""));
  if (!pending) return sendJson(res, 404, { error: "that confirmation is no longer open" });
  c.confirms.delete(String(body.id));
  const yes = body.approved === true;
  if (pending.r) { if (yes) { delete pending.r.declined; delete pending.r.unconfirmed; } else pending.r.declined = pending.action; }
  remember(c, "system", `confirmation ${body.id}: ${yes ? "approved" : "declined"} on the page: ${pending.action}`);
  pending.resolve(yes
    ? `APPROVED: the user clicked Approve on the call page for exactly this: ${pending.action}`
    : "DECLINED: the user clicked Decline on the call page. Do not do it. Say so briefly with call_say.");
  push({ type: "confirm_done", id: String(body.id), approved: yes });
  return sendJson(res, 200, { ok: true });
}

function postMute(res, c, body) {
  c.muted = body.muted === true;
  remember(c, "system", c.muted ? "microphone muted" : "microphone unmuted");
  return sendJson(res, 200, { ok: true });
}

/* kind "permission" is a prompt waiting in Claude's own window (the page shows a banner the call
   cannot act on); "stopped" is the Stop hook giving up on the loop. */
function postNotify(res, c, body) {
  const t = String(body.text || "").trim().slice(0, 400);
  if (!t || !isOpen(c)) return sendJson(res, 200, { ok: false });
  remember(c, "system", "notice: " + t);
  const kind = body.kind === "permission" || body.kind === "stopped" ? body.kind : undefined;
  push({ type: "notify", text: t, kind });
  return sendJson(res, 200, { ok: true });
}

/* Stop, from the page (a button or a spoken "stop"). Queued work simply goes. Work Claude already
   picked up cannot be interrupted from here (nothing stops a tool call from outside), so it is
   marked, and Claude hears it at its next call tool, or at once if it is waiting on call_next. */
function postCancel(res, c, body) {
  if (!isOpen(c)) return sendJson(res, 409, { error: "the call has ended" });
  const id = String(body.id || "");
  const qi = c.queue.findIndex((r) => r.id === id);
  let r, was;
  if (qi >= 0) {
    [r] = c.queue.splice(qi, 1);
    was = "queued";
  } else {
    r = c.inFlight.get(id);
    if (!r) return sendJson(res, 404, { error: "that request is not open" });
    if (r.cancelled) return sendJson(res, 200, { ok: true, was: "working" });
    was = "working";
  }
  r.cancelled = true;
  remember(c, "system", `the user cancelled ${r.id} (${was}) on the call page: ${r.text}`);
  if (was === "working") {
    // An approval card for work that no longer exists would ask the user to approve nothing.
    for (const [kid, pending] of c.confirms) {
      if (pending.r !== r) continue;
      c.confirms.delete(kid);
      pending.resolve(`DECLINED: the user cancelled ${r.id} on the call. Do not do it.`);
      push({ type: "confirm_done", id: kid, approved: false });
    }
    // toolCall puts the STOP notice in front of this.
    if (c.waiter) { const w = c.waiter; c.waiter = null; w.resolve(text("Then call call_next again.")); }
  }
  push({ type: "cancelled", id: r.id, was });
  pushStatus();
  return sendJson(res, 200, { ok: true, was });
}

/* ------------------------------------------------------------- files -- */

/* Content types by extension. A file Claude shows is only ever served as a picture, a PDF, plain
   text or a download: never as anything a browser would run in this origin. A file the user
   uploads is described to Claude with its closest real type. */
const MIME = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", md: "text/markdown", csv: "text/csv", json: "application/json", html: "text/html",
  htm: "text/html", xml: "application/xml", zip: "application/zip", mp3: "audio/mpeg", wav: "audio/wav",
  mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const TEXT_EXT = new Set(("txt md markdown log csv tsv json jsonl ndjson yaml yml toml ini cfg conf xml html htm css scss "
  + "sass less js mjs cjs jsx ts tsx mts cts py rb go rs java kt kts scala c h cc cpp cxx hpp hh cs php pl pm r lua swift "
  + "m mm dart sh bash zsh fish ps1 psm1 bat cmd sql graphql gql proto vue svelte astro diff patch gradle mk tf hcl ex exs "
  + "erl hs clj elm zig").split(" "));
const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]{1,10})$/) || [])[1] || "";
const typeOf = (name) => MIME[extOf(name)] || (TEXT_EXT.has(extOf(name)) ? "text/plain" : "application/octet-stream");

function servedType(name) {
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext) || ext === "pdf") return MIME[ext];
  // html too: shown as its source, never rendered.
  if (TEXT_EXT.has(ext)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/* A path on another machine (\\host\share, //host/share, \\?\UNC\...) or a device (\\.\...) is
   never looked at. On Windows even a stat of one makes the system connect to that host and offer
   the user's credentials, a host name leaks in the DNS lookup, and call_say runs without a
   permission prompt. So: a drive-letter path on Windows, nothing under the network automount on
   macOS, and never a path that starts with two slashes. */
export function isLocalPath(p) {
  const s = String(p || "");
  if (/^[\\/]{2}/.test(s)) return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(s);
  if (process.platform === "darwin") return !/^\/(?:net|Network)(?:\/|$)/i.test(s);
  return true;
}
const NOT_LOCAL = (given) => `"${given}" is not a file on this computer: only a full local path${process.platform === "win32" ? " with a drive letter (C:\\...)" : ""} can be shown, never a network or device path. Nothing was sent.`;

/* call_say's files: every one is checked before any is shown, so a bad path is a clear error and
   never half an answer on screen. */
function checkFiles(list) {
  if (list === undefined || list === null) return { files: [] };
  if (!Array.isArray(list)) return { error: "files must be a list of absolute file paths. Nothing was sent." };
  if (list.length > SAY_FILES_MAX) return { error: `files can list at most ${SAY_FILES_MAX} files; there were ${list.length}. Nothing was sent.` };
  const out = [];
  for (const p of list) {
    const given = String(p || "");
    if (!given || !path.isAbsolute(given)) return { error: `"${given}" is not an absolute path. Nothing was sent.` };
    if (!isLocalPath(given)) return { error: NOT_LOCAL(given) };
    let real, st;
    try { real = fs.realpathSync(given); }
    catch { return { error: `${given} does not exist. Nothing was sent.` }; }
    // A link on a local drive that points at a share is a share.
    if (!isLocalPath(real)) return { error: NOT_LOCAL(given) };
    try { st = fs.statSync(real); }
    catch { return { error: `${given} does not exist. Nothing was sent.` }; }
    if (!st.isFile()) return { error: `${given} is not a regular file. Nothing was sent.` };
    if (st.size > FILE_MAX) return { error: `${given} is over the 25 MiB limit per file (${st.size} bytes). Nothing was sent.` };
    const name = path.basename(given);
    out.push({ path: real, name, type: typeOf(name), size: st.size, image: IMAGE_EXT.has(extOf(name)), download: servedType(name) === "application/octet-stream" });
  }
  return { files: out };
}

function showable(d) {
  if (d === undefined || d === null) return undefined;
  const s = String(d);
  if (!s.trim()) return undefined;
  if (s.length <= DISPLAY_MAX) return s;
  const cut = /[\uD800-\uDBFF]/.test(s[DISPLAY_MAX - 1]) ? DISPLAY_MAX - 1 : DISPLAY_MAX;   // never half a character
  return s.slice(0, cut) + DISPLAY_CUT;
}

/* Only this page can fetch a shared file, and the response can never act as a page of this origin:
   a sandbox CSP (scripts, forms and same-origin access all off, even for SVG), nosniff, and markup
   served as text. */
const FILE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase());

function serveFile(res, c, token) {
  const f = c.shared.get(token);
  let st = null;
  try { st = f && isLocalPath(f.path) ? fs.statSync(f.path) : null; } catch {}
  if (!st || !st.isFile()) return sendJson(res, 404, { error: f ? "that file is no longer there" : "no such file" });
  if (st.size > FILE_MAX) return sendJson(res, 413, { error: "that file has grown past the 25 MiB limit since it was shared" });
  /* A file that says it is empty may not be: on Linux /proc and /sys files report size 0 and still
     have content. Read it (up to the cap) and send what was really there, so the length announced
     is the length sent. */
  let body = null;
  if (!st.size) {
    try { body = readCapped(f.path, FILE_MAX + 1); } catch { return sendJson(res, 404, { error: "that file is no longer there" }); }
    if (body.length > FILE_MAX) return sendJson(res, 413, { error: "that file is over the 25 MiB limit" });
  }
  const type = servedType(f.name);
  const headers = {
    ...SECURITY_HEADERS,
    "content-type": type,
    "content-length": body ? body.length : st.size,
    "content-security-policy": FILE_CSP,
    "x-content-type-options": "nosniff",
  };
  if (type === "application/octet-stream") headers["content-disposition"] = `attachment; filename*=UTF-8''${rfc5987(f.name)}`;
  res.writeHead(200, headers);
  if (body) return res.end(body);
  // Exactly the size just announced, even if the file grows while it is read.
  const s = fs.createReadStream(f.path, { start: 0, end: st.size - 1 });
  s.on("error", () => res.destroy());
  s.pipe(res);
}

function readCapped(p, max) {
  const fd = fs.openSync(p, "r");
  try {
    const parts = [];
    let got = 0;
    for (;;) {
      const buf = Buffer.alloc(Math.min(65536, max - got));
      const n = buf.length ? fs.readSync(fd, buf, 0, buf.length, null) : 0;
      if (!n) break;
      parts.push(buf.subarray(0, n));
      got += n;
    }
    return Buffer.concat(parts);
  } finally { fs.closeSync(fd); }
}

const pendingUploads = (c) => c.uploads.filter((u) => !u.r);
const attachmentsFrame = (c) => ({ type: "attachments", pending: pendingUploads(c).map((u) => ({ id: u.id, name: u.name, size: u.size, type: u.type })) });
const pushAttachments = (c) => push(attachmentsFrame(c));
const uploadDirPath = (c) => path.join(UPLOADS_DIR, c.id);

/* Names the user's own browser sends, so they are only a label: the basename, letters and digits
   of any script (with their marks), ". _ - space", no leading dot (hidden files), no trailing dot
   or space (Windows drops them), at most 100 characters and 200 bytes with the extension kept.
   Bytes too: Linux allows 255 bytes per name, and 100 Chinese characters are 300 of them. */
const NAME_BYTES = 200;
export function safeUploadName(raw) {
  let s = String(raw || "").split(/[\\/]/).pop().normalize("NFC");
  s = s.replace(/[^\p{L}\p{N}\p{M}._ -]/gu, "").replace(/^[. ]+/, "").replace(/[. ]+$/, "");
  const chars = Array.from(s);
  if (chars.length > 100 || Buffer.byteLength(s) > NAME_BYTES) {
    const ext = (s.match(/\.[\p{L}\p{N}]{1,16}$/u) || [""])[0];
    const stem = Array.from(s.slice(0, s.length - ext.length)).slice(0, 100 - Array.from(ext).length);
    while (stem.length && Buffer.byteLength(stem.join("") + ext) > NAME_BYTES) stem.pop();
    s = stem.join("").replace(/[. ]+$/, "") + ext;
  }
  return s || "file";
}

function mimeParam(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(s) ? s : "";
}

// A folder per call, this user's only. It outlives the call; call_start prunes it after a week.
function uploadDir(c) {
  const dir = uploadDirPath(c);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  return dir;
}

function pruneUploads() {
  let names = [];
  try { names = fs.readdirSync(UPLOADS_DIR); } catch { return; }
  for (const n of names) {
    const p = path.join(UPLOADS_DIR, n);
    try { if (Date.now() - fs.statSync(p).mtimeMs > UPLOAD_KEEP_MS) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

/* The answer to a too-big upload goes out before the rest of the body is read, and the connection
   closes behind it instead of taking the rest. */
function refuseBig(res) {
  res.writeHead(413, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", connection: "close" });
  res.end(JSON.stringify({ error: "That file is over the 25 MiB limit." }));
}

/* A file the user shares on the page: raw bytes, the name in a header. Counted as they arrive and
   refused the moment they pass the cap, stored as <n>-<safe name> so names never collide. */
function postUpload(req, res, c) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/octet-stream")) {
    return sendJson(res, 415, { error: "content-type must be application/octet-stream" });
  }
  if (!isOpen(c)) return sendJson(res, 409, { error: "the call has ended" });
  if (pendingUploads(c).length + c.uploading >= PENDING_MAX) {
    return sendJson(res, 429, { error: `At most ${PENDING_MAX} files can wait for the next request. Send it, or remove one.` });
  }
  if (Number(req.headers["content-length"]) > FILE_MAX) return refuseBig(res);
  let raw = String(req.headers["x-ttc-name"] || "");
  try { raw = decodeURIComponent(raw); } catch {}
  const name = safeUploadName(raw);
  const type = mimeParam(req.headers["x-ttc-type"]) || typeOf(name);
  let file;
  try { file = path.join(uploadDir(c), `${++c.uploadSeq}-${name}`); }
  catch (e) { return sendJson(res, 500, { error: "Could not create the uploads folder: " + e.message }); }
  const n = c.uploadSeq;
  c.uploading++;
  return new Promise((resolve) => {
    const out = fs.createWriteStream(file, { flags: "wx", mode: 0o600 });
    let size = 0, clash = false, over = false, ended = false, settled = false, gone = false;
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      c.uploading--;
      fn();
      resolve();
    };
    /* A refused or broken upload leaves nothing behind, and the answer waits until that is true.
       Only a file this upload created is ever removed ("wx" refuses to open one that exists).
       The first reason to give up is the answer: a stream destroyed in the middle of a write
       reports an error of its own, which must not turn a 413 into a 500. */
    const discard = (then) => {
      if (gone) return;
      gone = true;
      const rm = () => (clash ? then() : fs.rm(file, { force: true }, () => then()));
      if (out.closed) return rm();
      out.once("close", rm);
      out.destroy();
    };
    out.on("error", (e) => {
      if (e.code === "EEXIST") clash = true;
      discard(() => settle(() => sendJson(res, 500, { error: "Could not save the file: " + e.message })));
    });
    req.on("data", (chunk) => {
      if (over || gone || settled) return;
      size += chunk.length;
      if (size > FILE_MAX) {
        over = true;
        req.pause();
        discard(() => settle(() => refuseBig(res)));
        return;
      }
      if (!out.write(chunk)) { req.pause(); out.once("drain", () => { if (!over && !gone) req.resume(); }); }
    });
    req.on("end", () => {
      ended = true;
      if (over || gone || settled) return;
      /* A last write that fails (disk full) reaches this callback, with its error, before the stream's
         own "error" event: that one removes the file and answers 500, so this must not say 200 first. */
      out.end((err) => {
        if (err || gone) return;
        settle(() => {
          if (!isOpen(c)) { fs.rm(file, { force: true }, () => {}); return sendJson(res, 409, { error: "the call has ended" }); }
          try { fs.chmodSync(file, 0o600); } catch {}
          const u = { id: "f" + n, name, size, type, path: file, r: null };
          c.uploads.push(u);
          pushAttachments(c);
          sendJson(res, 200, { id: u.id, name, size, type });
        });
      });
    });
    req.on("error", () => {});
    // The browser gave up (tab closed, upload cancelled): nothing half-written stays.
    req.on("close", () => { if (!ended && !over && !settled) discard(() => settle(() => {})); });
  });
}

function postRemoveUpload(res, c, body) {
  if (!isOpen(c)) return sendJson(res, 409, { error: "the call has ended" });
  const u = pendingUploads(c).find((x) => x.id === String(body.id || ""));
  if (!u) return sendJson(res, 404, { error: "that file is not waiting to be sent" });
  c.uploads.splice(c.uploads.indexOf(u), 1);
  try { fs.unlinkSync(u.path); } catch {}
  // Named as removed, so another tab of this call does not take its leaving for a file that was sent.
  push({ ...attachmentsFrame(c), removed: [u.id] });
  return sendJson(res, 200, { ok: true });
}

/* One promise, shared: two call_starts racing both wait for the same listen, and a failed
   listen is forgotten so the next call_start tries again instead of handing out port 0. */
let listening = null;
function ensureServer() {
  if (!listening) {
    listening = new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          log("http error: " + (e && e.stack || e));
          try { sendJson(res, 500, { error: "internal error" }); } catch {}
        });
      });
      s.keepAliveTimeout = 5000;
      s.once("error", (e) => { listening = null; reject(e); });
      s.listen(Number(ENV.TTC_PORT || 0), "127.0.0.1", () => {

        port = s.address().port;
        s.unref();
        log(`bridge listening on 127.0.0.1:${port}`);
        resolve();
      });
    });
  }
  return listening;
}

/* ------------------------------------------------------------- browser -- */

function openBrowser(url) {
  if (ENV.TTC_NO_BROWSER === "1") return false;
  try {
    let cmd, args;
    if (process.platform === "win32") { cmd = "rundll32"; args = ["url.dll,FileProtocolHandler", url]; }
    else if (process.platform === "darwin") { cmd = "open"; args = [url]; }
    else if (ENV.WSL_DISTRO_NAME) { cmd = "cmd.exe"; args = ["/c", "start", "", url]; }
    else { cmd = "xdg-open"; args = [url]; }
    // The browser gets no copy of the key: strip anything that could carry it.
    const env = { ...process.env };
    for (const k of Object.keys(env)) {
      if (/^CLAUDE_PLUGIN_OPTION_|OPENAI|^TTC_/i.test(k)) delete env[k];
    }
    const p = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, env });
    p.on("error", () => {});
    p.unref();
    return true;
  } catch { return false; }
}

/* ----------------------------------------------------------------- mcp -- */

function text(s) {
  return { content: [{ type: "text", text: String(s) }] };
}
function fail(s) {
  return { content: [{ type: "text", text: String(s) }], isError: true };
}

/* The page needs to know when the user is dictating, or it would hand every thinking pause to
   Claude as a request. Claude is asked to say so; the text is the fallback. */
export function instructMode(args) {
  const m = String((args && args.mode) || "").toLowerCase();
  if (m === "listening" || m === "normal") return m;
  const t = String((args && args.text) || "");
  // Only explicit exit phrasing leaves the mode: "stay silent until the user says over to you" enters it.
  if (/listening mode (?:is )?(?:over|off|ended|done)|(?:leave|exit|end|stop)(?: the)? listening mode|resume normal/i.test(t)) return "normal";
  return /listening mode/i.test(t) ? "listening" : null;
}

export const TOOLS = [
  {
    name: "call_start",
    description: "Start a voice call with the user. Opens a call page in their browser (microphone + OpenAI gpt-live-1 voice). After this, loop on call_next until it reports the call ended.",
    inputSchema: {
      type: "object",
      properties: {
        focus: { type: "string", description: "Optional: what the user wants to work on, from the /talk arguments." },
      },
    },
  },
  {
    name: "call_next",
    description: "Wait for the next thing the user asks for out loud on the voice call, and return it. Blocks until they speak, the call ends, or wait_seconds passes. Call it again after every call_say.",
    inputSchema: {
      type: "object",
      properties: {
        wait_seconds: { type: "number", description: `How long to wait before returning 'nothing yet' (default ${NEXT_WAIT_DEFAULT}, max 1500).` },
      },
    },
  },
  {
    name: "call_say",
    description: "Say something to the user on the voice call, and show them what is better read than heard. Use final=true (default) for the answer to a request, final=false for a short progress note while you keep working. text is spoken: plain sentences only, no markdown, no code, no URLs, never a secret. Put code, commands, file paths, links, tables, lists and anything longer in display, and screenshots, images or files in files: both appear on the user's call page and never reach the voice.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to tell the user out loud, 1-3 short spoken sentences. If you also show something, say so (for example \"The diff is on your screen.\")." },
        display: { type: "string", description: "Optional markdown for the call page's On screen card: code, commands, file paths, links, tables, lists, anything longer than a sentence. Shown exactly as written (so leave secrets out), stays on this computer, never spoken. Up to 100,000 characters." },
        files: { type: "array", items: { type: "string" }, maxItems: SAY_FILES_MAX, description: "Optional absolute paths of local files to show on the call page (on Windows with a drive letter; network paths are refused): screenshots and images appear as pictures, PDFs and text or code files open in a new tab, and anything else downloads (Office files, archives, audio, video). Up to 10, each a regular file of at most 25 MiB." },
        id: { type: "string", description: "The request id from call_next (for example r3). Defaults to the latest request." },
        final: { type: "boolean", description: "true = this answers the request (default). false = progress note, still working." },
        quiet: { type: "boolean", description: "true = close the request WITHOUT speaking: only for something the voice kept to itself and already answered well (small talk), so the user does not hear it twice." },
      },
      required: ["text"],
    },
  },
  {
    name: "call_confirm",
    description: "Before anything destructive or outward-facing on a voice call (deleting, force-pushing, deploying, sending a message or email, spending money, changing credentials or permissions): show the user the EXACT action on the call page and wait for them to click Approve or Decline. Returns APPROVED or DECLINED. Do the action only on APPROVED.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "The exact action, as specific as a command line: what, where, which files or recipients." },
        why: { type: "string", description: "One short spoken sentence saying what you want to do, for the voice to tell the user." },
        id: { type: "string", description: "The request this action is for (for example r3). Pass it: a request the user cancelled is declined at once, and another one's cancel never declines this one. Defaults to the newest request still wanted." },
      },
      required: ["action", "why"],
    },
  },
  {
    name: "call_instruct",
    description: "Change how the voice model behaves for the rest of the call, without speaking. The text is appended to the voice's live instructions. Use it to enter listening mode when the user wants to dictate without being interrupted (for example: \"You are now in listening mode.\"), and again to leave it (\"Listening mode is over. Resume normal back-and-forth.\"). Never a secret.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The instruction for the voice model, one or two plain sentences." },
        mode: { type: "string", enum: ["listening", "normal"], description: "\"listening\" when entering listening mode, \"normal\" when leaving it. The call page holds back its own hand-overs while the user dictates." },
      },
      required: ["text"],
    },
  },
  {
    name: "call_end",
    description: "Hang up the voice call (for example when the user asks you to). The page closes the OpenAI session.",
    inputSchema: { type: "object", properties: { reason: { type: "string" } } },
  },
  {
    name: "call_status",
    description: "Where the voice call stands: state, minutes and cost so far, queued and unanswered requests.",
    inputSchema: { type: "object", properties: {} },
  },
];

/* Every call_* result but call_start's and call_status's carries a STOP notice for work the user
   cancelled that Claude has not heard about yet, so it hears at its very next call tool. Told
   once. Not once the call has ended: the hand-off says it, and its first line must stay first. */
async function toolCall(name, args, ctx) {
  const result = await runTool(name, args, ctx);
  if (!result || name === "call_start" || name === "call_status" || !call || !isOpen(call)) return result;
  const said = result.content[0].text;
  if (said.startsWith("Superseded:")) return result;   // Claude ignores this one, so it cannot carry news
  const stops = untoldStops(call);
  return stops ? { ...result, content: [{ type: "text", text: stops + "\n\n" + said }] } : result;
}

function untoldStops(c) {
  const lines = [];
  for (const r of c.inFlight.values()) {
    if (!r.cancelled || r.told) continue;
    r.told = true;
    lines.push(`STOP ${r.id}: the user cancelled "${clip(r.text, 200).replace(/"/g, "'")}" on the call. Stop working on it now. Do not undo what is already done unless they ask. Close it with call_say id "${r.id}": one short line saying it is stopped and what, if anything, was already changed.`);
  }
  return lines.join("\n");
}

async function runTool(name, args, ctx) {
  args = args || {};
  if (name === "call_start") {
    await ensureServer();
    let c = call;
    const reopen = Boolean(c && isOpen(c));
    if (!reopen) {
      pruneUploads();
      c = call = newCall(args.focus);
      remember(c, "system", `call started${c.focus ? " (focus: " + c.focus + ")" : ""}`);
      later(c, START_GRACE_MIN * 60000, () => {
        if (call === c && c.state === "created") endCall(`nobody pressed Start within ${START_GRACE_MIN} minutes`);
      });
      writeBridgeFile(c);
    } else {
      // A fresh one-time link for the same call (the tab was closed, or the first link got used).
      c.launch = crypto.randomBytes(24).toString("base64url");
    }
    c.lastLoopAt = Date.now();
    const url = launchUrl(c);
    const opened = openBrowser(url);
    if (ENV.TTC_URL_FILE) { try { fs.writeFileSync(ENV.TTC_URL_FILE, url); } catch {} }
    const k = resolveKey();
    return text([
      reopen ? `The call was already open (${c.state}); here is a fresh link to its page.` : "",
      opened ? `Call page opened in the browser (one-time link): ${url}` : `Open this one-time link in a browser: ${url}`,
      k.key
        ? `OpenAI key: ${k.source} (${keyHint(k.key)}).`
        : "No OpenAI key is set yet: the call page will ask for one (it is stored only on this computer).",
      "Tell the user in one short line to press Start talking on that page. Then call call_next and keep looping on it.",
      `[ttc-bridge] port=${port} call=${c.id}`,
    ].filter(Boolean).join("\n"));
  }

  if (name === "call_confirm") {
    if (!call) return fail("No call is open, so there is nobody to confirm with. Ask in the Claude window instead.");
    if (!isOpen(call)) return text("DECLINED: the call has ended, so there is nobody to confirm with on it. Do not do it now; ask in this chat instead. " + AFTER_END);
    const c = call;
    c.lastLoopAt = Date.now();
    const action = String(args.action || "").trim().slice(0, 1200);
    const why = speakable(args.why || "").slice(0, 300);
    if (!action) return fail("action is required: the exact thing you want to do.");
    /* The request this approval belongs to, so the end-of-call hand-off can say how it went: the one
       Claude names, else the newest one the user still wants. */
    const open = [...c.inFlight.values()];
    const r = args.id ? (c.inFlight.get(String(args.id)) || null) : (open.filter((q) => !q.cancelled).at(-1) || open.at(-1) || null);
    // Work the user already stopped on the page has nothing left to approve: no card.
    if (r && r.cancelled) return text(`DECLINED: the user cancelled ${r.id} on the call. Do not do it.`);
    /* A stop Claude has not heard yet may be for the very work this step belongs to, and a card
       would hold that news back for as long as the card waits. So no card: toolCall puts the STOP
       in front of this, and Claude asks again if the action is for work still wanted. */
    if (open.some((q) => q.cancelled && !q.told)) {
      return text("DECLINED: no card was shown, because the user cancelled a request you have not heard about yet (above). Do not do this if it is part of that work. If it is for a request that is still open, call call_confirm again with that request's id.");
    }
    if (!c.sse.size) return text("DECLINED: the call page is not connected, so the user cannot see the action. Do not do it; ask again once the page is back.");
    const id = "k" + crypto.randomBytes(4).toString("hex");
    remember(c, "system", `confirmation ${id} asked: ${action}`);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!c.confirms.has(id)) return;
        c.confirms.delete(id);
        if (r) r.unconfirmed = action;
        push({ type: "confirm_done", id, approved: false, expired: true });
        resolve(text(`DECLINED: no answer on the call page within ${CONFIRM_WAIT_S} seconds. Do not do it. Tell the user briefly with call_say.`));
      }, CONFIRM_WAIT_S * 1000);
      c.confirms.set(id, { action, why, r, resolve: (s) => { clearTimeout(timer); resolve(text(s)); } });
      /* The card shows the action EXACTLY, unredacted: it is drawn on this computer only (never
         sent to OpenAI; only `why` is spoken), and an approval of a line with parts blanked
         out is an approval of something the user could not read. */
      push({ type: "confirm", id, action, why, seconds: CONFIRM_WAIT_S });
    });
  }

  if (name === "call_next") {
    if (!call) return fail("No call is open. Call call_start first.");
    const c = call;
    c.lastLoopAt = Date.now();
    // Ended first: a request still queued when the user hung up is reported, not run.
    if (!isOpen(c)) return endedResult(c);
    if (c.queue.length) return deliver(c, c.queue.shift());
    /* A stop that came while nothing was waiting is news now, not after a wait of up to 20 minutes:
       toolCall puts the STOP in front, exactly as for a call_next that was already waiting. */
    if ([...c.inFlight.values()].some((q) => q.cancelled && !q.told)) return text("Then call call_next again.");
    // Under the plugin's 30-minute per-call timeout (.mcp.json), which progress does not extend.
    const wait = Math.min(Math.max(Number(args.wait_seconds) || NEXT_WAIT_DEFAULT, 5), 1500);
    if (c.waiter) { const old = c.waiter; c.waiter = null; old.resolve(text("Superseded: a newer call_next is waiting now. Ignore this result.")); }
    return await new Promise((resolve) => {
      let beat = null;
      const w = {
        resolve: (v) => { clearTimeout(timer); clearInterval(beat); c.lastLoopAt = Date.now(); resolve(v); },
        rpcId: ctx.rpcId,
      };
      const timer = setTimeout(() => {
        if (c.waiter === w) c.waiter = null;
        w.resolve(text(`Nothing new yet (waited ${wait}s). The call is still ${c.state}: call call_next again.`));
        pushStatus();
      }, wait * 1000);
      /* Progress keeps a long wait from looking hung, and lets hosts that reset their tool
         timeout on progress wait as long as the user takes. */
      if (ctx.progressToken !== undefined) {
        let n = 0;
        beat = setInterval(() => {
          ctx.notify("notifications/progress", { progressToken: ctx.progressToken, progress: ++n, message: "waiting for the user to speak" });
        }, 20000);
      }
      c.waiter = w;
      pushStatus();
    });
  }

  if (name === "call_say") {
    if (!call) return fail("No call is open.");
    const c = call;
    c.lastLoopAt = Date.now();
    if (!isOpen(c)) return text("The call has already ended, so nothing was spoken. " + endedResult(c).content[0].text);
    const said = fitSpoken(speakable(args.text));
    if (!said) return fail("Nothing to say: text was empty after removing markdown.");
    const checked = checkFiles(args.files);
    if (checked.error) return fail(checked.error);
    /* What is on screen goes out exactly as written, like the approval card: it is drawn on this
       computer only (the voice is told only that there is something to look at), and it is what
       chat would have shown. It is not kept in the transcript. */
    const display = showable(args.display);
    const files = checked.files.map((f) => {
      const token = crypto.randomBytes(24).toString("base64url");
      c.shared.set(token, f);
      return { token, name: f.name, type: f.type, size: f.size, image: f.image, download: f.download };
    });
    const final = args.final !== false;
    /* An explicit id that is no longer in flight (already answered, or never existed) must not
       fall through to closing some OTHER request: it goes out as a plain note. */
    const r = args.id ? (c.inFlight.get(String(args.id)) || null) : ([...c.inFlight.values()].at(-1) || null);
    // Quiet closes a request the voice already handled well: the voice is told, not asked to speak.
    const quiet = final && args.quiet === true;
    const delivered = push({ type: "say", id: r ? r.id : null, text: said, final, quiet, delegationIds: r ? r.delegationIds : [], display, files });
    remember(c, "claude", (quiet ? "(closed quietly) " : final ? "" : "(progress) ") + said);
    /* Closing a request the user cancelled a moment ago: it leaves the in-flight list here, where
       toolCall looks for untold stops, so the notice goes out with this result instead. */
    const lateStop = final && r && r.cancelled && !r.told
      ? `STOP ${r.id}: the user cancelled "${clip(r.text, 200).replace(/"/g, "'")}" on the call before this answer went out. Your answer was still sent. Do not undo anything unless they ask. If it did not already say what, if anything, was changed, say that in one short call_say line.\n\n`
      : "";
    if (lateStop) r.told = true;
    if (final && r) { c.inFlight.delete(r.id); c.lastAnswered = { r, at: Date.now() }; }
    pushStatus();
    const shown = display || files.length ? ` and shown on screen${files.length ? ` with ${files.length} file(s)` : ""}` : "";
    return text(lateStop + (delivered
      ? `Sent to the call${r ? ` as the ${final ? "answer to" : "progress on"} ${r.id}` : ""}${shown}. Now call call_next.`
      : `The call page is reconnecting; this will be spoken${shown ? " and shown" : ""} when it is back. Now call call_next.`));
  }

  if (name === "call_instruct") {
    if (!call) return fail("No call is open.");
    const c = call;
    c.lastLoopAt = Date.now();
    if (!isOpen(c)) return text("The call has already ended, so the instruction was not sent. " + AFTER_END);
    // Never spoken, but it still leaves this process for OpenAI, so it gets the same scrubbing.
    const said = fitSpoken(speakable(args.text));
    if (!said) return fail("Nothing to send: text was empty after removing markdown.");
    const delivered = push({ type: "instruct", text: said, mode: instructMode(args) });
    remember(c, "system", "instruction to the voice: " + said);
    return text(delivered
      ? "Instruction sent to the voice. Now call call_next."
      : "The call page is reconnecting; the instruction will be sent when it is back. Now call call_next.");
  }

  if (name === "call_end") {
    if (!call) return text("No call is open.");
    if (!isOpen(call)) return text("The call has already ended. " + AFTER_END);
    const c = call;
    c.state = "ending";
    push({ type: "end", reason: String(args.reason || "Claude hung up") });
    later(c, 15000, () => endCall(String(args.reason || "Claude hung up")));
    return text("Hanging up. The page is closing the voice session.");
  }

  if (name === "call_status") {
    if (!call) return text("No call has been started in this session.");
    return text(JSON.stringify(statusObj(call), null, 2));
  }

  return fail("Unknown tool: " + name);
}

/* A deliberately small MCP server: initialize, tools/list, tools/call, ping, and
   notifications/cancelled. Requests are handled concurrently, because call_next blocks for
   minutes and a ping must not wait behind it. */
export function startMcp(input = process.stdin, output = process.stdout) {
  const pending = new Map();      // rpc id -> { cancelled }
  const send = (obj) => output.write(JSON.stringify(obj) + "\n");
  const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

  let buf = "";
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onMessage(line);
    }
  });
  input.on("end", () => {
    // The session is gone. Tell the page, give it a moment to hang up, then leave.
    if (call && isOpen(call)) { push({ type: "end", reason: "the Claude session closed" }); }
    setTimeout(() => process.exit(0), 1500).unref?.();
  });

  function onMessage(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
    const { id, method, params } = msg;
    if (method === "notifications/cancelled") {
      const p = pending.get(params && params.requestId);
      if (p) {
        p.cancelled = true;
        // A cancelled call_next must stop waiting, but nothing it had not delivered is lost.
        if (call && call.waiter && call.waiter.rpcId === params.requestId) {
          const w = call.waiter; call.waiter = null; w.resolve(null); pushStatus();
        }
      }
      return;
    }
    if (id === undefined || id === null) return;   // other notifications need no answer
    const reply = (result) => { if (!pending.get(id)?.cancelled) send({ jsonrpc: "2.0", id, result }); pending.delete(id); };
    const error = (code, message) => { send({ jsonrpc: "2.0", id, error: { code, message } }); pending.delete(id); };
    pending.set(id, { cancelled: false });

    if (method === "initialize") {
      return reply({
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "kivi-talk", version: VERSION },
        instructions: "Voice calls with the user. /talk starts one: call_start, then loop call_next -> work -> call_say until call_next reports the call ended.",
      });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS });
    if (method === "tools/call") {
      const ctx = { rpcId: id, progressToken: params && params._meta && params._meta.progressToken, notify };
      toolCall(params && params.name, params && params.arguments, ctx)
        .then((r) => { if (r) reply(r); else pending.delete(id); })
        .catch((e) => { log("tool error: " + (e && e.stack || e)); reply(fail("Tool failed: " + String(e && e.message || e))); });
      return;
    }
    if (method === "resources/list") return reply({ resources: [] });
    if (method === "prompts/list") return reply({ prompts: [] });
    return error(-32601, "method not found: " + method);
  }
}

/* Test seam: lets the unit tests drive the HTTP side without a real MCP client. */
export const __test = {
  get call() { return call; },
  get port() { return port; },
  get dataDir() { return DATA_DIR; },
  toolCall: (name, args) => toolCall(name, args, { rpcId: 0, notify: () => {} }),
  ensureServer,
  endCall,
  reset() { if (call) endCall("test reset"); call = null; },
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startMcp();
}
