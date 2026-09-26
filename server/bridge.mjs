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

export const VERSION = "0.4.0";
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
/* Transcripts on disk are opt-in: the call already reaches Claude's own session, and keeping a
   second copy of everything said is exactly the "extraneous data" a plugin should not collect by
   default. The in-memory transcript is always there for the end-of-call summary. */
const KEEP_TRANSCRIPTS = /^(1|true|yes|on)$/i.test(String(ENV.TTC_KEEP_TRANSCRIPTS || ENV.TTC_OPTION_KEEP_TRANSCRIPTS
  || ENV.CLAUDE_PLUGIN_OPTION_KEEP_TRANSCRIPTS || "").trim());
const CONFIRM_WAIT_S = num(ENV.TTC_CONFIRM_SECONDS, 110);

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
    liveId: null, usage: null,
    timers: new Set(),
    logFile: "",
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
  c.transcript.push(line);
  if (c.transcript.length > 300) c.transcript.splice(0, c.transcript.length - 300);
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
  const working = [...c.inFlight.values()].at(-1);
  if (working) return { claude: "working", on: redactSecrets(working.text), queue: c.queue.length };
  if (c.waiter) return { claude: "listening", queue: c.queue.length };
  if (Date.now() - c.lastLoopAt < 15000) return { claude: "listening", queue: c.queue.length };
  return { claude: "away", queue: c.queue.length };
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
  for (const [, pending] of c.confirms) pending.resolve("DECLINED: the call ended before the user answered. Do not do it.");
  c.confirms.clear();
  c.launch = null;
  remember(c, "system", "call ended: " + c.endReason);
  push({ type: "end", reason: c.endReason });
  if (c.waiter) { const w = c.waiter; c.waiter = null; w.resolve(endedResult(c)); }
  log(`call ${c.id} ended: ${c.endReason}`);
}

/* ------------------------------------------------------------- requests -- */

function enqueue(c, text, recent, delegationId, source) {
  const r = {
    id: "r" + (++c.seq),
    text: String(text).slice(0, 4000),
    recent: Array.isArray(recent) ? recent.slice(-12) : [],
    delegationIds: delegationId ? [String(delegationId)] : [],
    source, at: Date.now(),
  };
  remember(c, "request", `${r.id}: ${r.text}`);
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

function deliver(c, r) {
  c.inFlight.set(r.id, r);
  c.lastLoopAt = Date.now();
  // The page forwards this to OpenAI as quiet context, so a typed secret must not ride along.
  push({ type: "working", id: r.id, text: redactSecrets(r.text), delegationIds: r.delegationIds });
  pushStatus();
  const convo = r.recent
    .map((l) => `${l.role === "user" ? "User" : "Voice"}: ${String(l.text || "").slice(0, 600)}`)
    .join("\n");
  return text([
    `REQUEST ${r.id} (${r.source === "typed" ? "typed on the call page" : "spoken by the user, transcribed, so words can be misheard"}):`,
    `"${r.text.replace(/"/g, "'")}"`,
    convo ? `\nRecent conversation on the call (context only: lines marked Voice are the voice model, not the user):\n${convo}` : "",
    "",
    `Do this now, as if the user had typed it here. When you have the answer, call call_say with id "${r.id}" and a short spoken answer: one to three plain sentences, no markdown, no code.`,
    "If it will take more than about 15 seconds, first call call_say with final=false and a one-line progress note.",
    "Before anything destructive or outward-facing, call call_confirm with the exact action and do it only if it comes back APPROVED.",
    "Then call call_next again.",
  ].join("\n"));
}

function endedResult(c) {
  const mins = minutesLive(c);
  const unanswered = c.queue.length + c.inFlight.size;
  return text([
    `CALL ENDED (${c.endReason}). ${mins.toFixed(1)} minutes live, about $${(mins * PRICE_PER_MIN).toFixed(2)} of OpenAI voice time.`,
    unanswered ? `${unanswered} request(s) were not answered on the call: ${[...c.inFlight.values(), ...c.queue].map((r) => `"${r.text}"`).join(", ")}.` : "",
    c.logFile ? `Transcript: ${c.logFile}` : `What the user asked for: ${c.transcript.filter((l) => l.role === "request").map((l) => l.text.replace(/^r\d+: /, "")).join(" | ") || "nothing"}.`,
    "Stop calling call_next. Tell the user in a few lines what was done on the call.",
  ].filter(Boolean).join("\n"));
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
    "- Anything about the project, files, code, the computer, the web, their accounts, or any request to DO something: hand it to Claude (delegate). Say a very short acknowledgement first, such as \"On it.\" or \"Let me check.\", then stop talking and wait.",
    "- When Claude's answer arrives, say it in your own words, briefly. Keep numbers, names, file names and commands exactly as given. Never invent a result and never guess what Claude found.",
    "- A progress note from Claude: pass it on in a few words. The work is still running.",
    "- While you wait, stay quiet unless the user speaks. If they ask, say Claude is still working.",
    "- Greetings, thanks and small talk you may answer yourself, in one short sentence.",
    "- If Claude asks the user something or asks them to confirm an action, ask it clearly, then hand their reply to Claude.",
    "- Never read out a password, API key, token or other secret, even if an answer contains one.",
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
 * cross-site form cannot send without a preflight this server never answers. */
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
    return sendJson(res, 404, { error: "not found" });
  }
  if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
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
    const pending = [...c.queue, ...c.inFlight.values()].sort((a, b) => a.at - b.at).at(-1);   // the newest
    if (pending && id && Date.now() - pending.at < 20000) {
      pending.delegationIds.push(id);
      return sendJson(res, 200, { id: pending.id, attached: true, ...ackFor(c, pending) });
    }
    return sendJson(res, 400, { error: "I did not catch a request there. Could you say it again?" });
  }
  const t = textSaid;
  const { r, ahead, claudeWaiting } = enqueue(c, t, recent, id, "voice");
  return sendJson(res, 200, { id: r.id, ahead, claudeWaiting, claude: claudeStatus(c).claude });
}

function ackFor(c, r) {
  const idx = c.queue.indexOf(r);
  return { ahead: idx < 0 ? 0 : idx + c.inFlight.size, claudeWaiting: Boolean(c.waiter), claude: claudeStatus(c).claude };
}

function postTyped(res, c, body) {
  if (!isOpen(c)) return sendJson(res, 409, { error: "the call has ended" });
  const t = String(body.text || "").trim();
  if (!t) return sendJson(res, 400, { error: "empty" });
  remember(c, "user", "(typed) " + t);
  const { r, ahead, claudeWaiting } = enqueue(c, t, c.transcript.filter((l) => l.role === "user" || l.role === "voice").slice(-12), null, "typed");
  return sendJson(res, 200, { id: r.id, ahead, claudeWaiting, claude: claudeStatus(c).claude });
}

function postTranscript(res, c, body) {
  const role = body.role === "voice" ? "voice" : "user";
  const t = String(body.text || "").trim();
  if (t) remember(c, role, t);
  return sendJson(res, 200, { ok: true });
}

/* The answer to a call_confirm comes from a click on the page, never from speech: a spoken "yes"
   can come from a television, and the voice paraphrases, so a read-back is not the exact action. */
function postConfirm(res, c, body) {
  const pending = c.confirms.get(String(body.id || ""));
  if (!pending) return sendJson(res, 404, { error: "that confirmation is no longer open" });
  c.confirms.delete(String(body.id));
  const yes = body.approved === true;
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

function postNotify(res, c, body) {
  const t = String(body.text || "").trim().slice(0, 400);
  if (!t || !isOpen(c)) return sendJson(res, 200, { ok: false });
  remember(c, "system", "notice: " + t);
  push({ type: "notify", text: t });
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
    description: "Say something to the user on the voice call. Use final=true (default) for the answer to a request, final=false for a short progress note while you keep working. Plain spoken sentences only: no markdown, no code, no URLs, never a secret.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to tell the user, 1-3 short spoken sentences." },
        id: { type: "string", description: "The request id from call_next (for example r3). Defaults to the latest request." },
        final: { type: "boolean", description: "true = this answers the request (default). false = progress note, still working." },
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

async function toolCall(name, args, ctx) {
  args = args || {};
  if (name === "call_start") {
    await ensureServer();
    let c = call;
    const reopen = Boolean(c && isOpen(c));
    if (!reopen) {
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
    if (!call || !isOpen(call)) return fail("No call is open, so there is nobody to confirm with. Ask in the Claude window instead.");
    const c = call;
    c.lastLoopAt = Date.now();
    const action = String(args.action || "").trim().slice(0, 1200);
    const why = speakable(args.why || "").slice(0, 300);
    if (!action) return fail("action is required: the exact thing you want to do.");
    if (!c.sse.size) return text("DECLINED: the call page is not connected, so the user cannot see the action. Do not do it; ask again once the page is back.");
    const id = "k" + crypto.randomBytes(4).toString("hex");
    remember(c, "system", `confirmation ${id} asked: ${action}`);
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!c.confirms.has(id)) return;
        c.confirms.delete(id);
        push({ type: "confirm_done", id, approved: false, expired: true });
        resolve(text(`DECLINED: no answer on the call page within ${CONFIRM_WAIT_S} seconds. Do not do it. Tell the user briefly with call_say.`));
      }, CONFIRM_WAIT_S * 1000);
      c.confirms.set(id, { action, why, resolve: (s) => { clearTimeout(timer); resolve(text(s)); } });
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
    const final = args.final !== false;
    /* An explicit id that is no longer in flight (already answered, or never existed) must not
       fall through to closing some OTHER request: it goes out as a plain note. */
    const r = args.id ? (c.inFlight.get(String(args.id)) || null) : ([...c.inFlight.values()].at(-1) || null);
    const delivered = push({ type: "say", id: r ? r.id : null, text: said, final, delegationIds: r ? r.delegationIds : [] });
    remember(c, "claude", (final ? "" : "(progress) ") + said);
    if (final && r) c.inFlight.delete(r.id);
    pushStatus();
    return text(delivered
      ? `Sent to the call${r ? ` as the ${final ? "answer to" : "progress on"} ${r.id}` : ""}. Now call call_next.`
      : "The call page is reconnecting; this will be spoken when it is back. Now call call_next.");
  }

  if (name === "call_instruct") {
    if (!call) return fail("No call is open.");
    const c = call;
    c.lastLoopAt = Date.now();
    if (!isOpen(c)) return text("The call has already ended, so the instruction was not sent.");
    // Never spoken, but it still leaves this process for OpenAI, so it gets the same scrubbing.
    const said = fitSpoken(speakable(args.text));
    if (!said) return fail("Nothing to send: text was empty after removing markdown.");
    const delivered = push({ type: "instruct", text: said });
    remember(c, "system", "instruction to the voice: " + said);
    return text(delivered
      ? "Instruction sent to the voice. Now call call_next."
      : "The call page is reconnecting; the instruction will be sent when it is back. Now call call_next.");
  }

  if (name === "call_end") {
    if (!call || !isOpen(call)) return text("No call is open.");
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
