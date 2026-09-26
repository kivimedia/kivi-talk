#!/usr/bin/env node
/* kivi-talk hooks, one script, four modes:
 *
 *   allow   PreToolUse on this plugin's own call_* tools: approve them, so a call does not stop
 *           for a permission prompt every time Claude goes back to listening. Nothing else is
 *           approved here: every other tool keeps the session's own permission rules.
 *   bind    PostToolUse on call_start: remember which bridge belongs to this session. The MCP
 *           server cannot know the session id; the hook input carries it.
 *   stop    Stop: while this session's call is open and nothing is listening, send Claude back
 *           to call_next instead of letting the turn end and the voice go silent.
 *   notify  Notification (permission prompts): say it out loud on the call, because the user is
 *           talking, not watching the screen.
 *
 * Every mode fails OPEN: a hook that cannot reach the bridge lets Claude carry on normally.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const mode = process.argv[2] || "";
const dataArg = String(process.argv[3] || "").trim();
// Same order as the bridge, so both always agree on where the handover files are.
const DATA_DIR = (process.env.TTC_DATA_DIR || "").trim()
  || (dataArg && !dataArg.includes("${") ? dataArg : "")
  || (process.env.CLAUDE_PLUGIN_DATA || "").trim()
  || path.join(os.homedir(), ".kivi-talk");
const SESSIONS = path.join(DATA_DIR, "sessions");

function readStdin() {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => resolve(s));
    process.stdin.on("error", () => resolve(s));
    setTimeout(() => resolve(s), 3000).unref();
  });
}

function safeId(id) {
  return String(id || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 100);
}

function bindingFile(sessionId) {
  const id = safeId(sessionId);
  return id ? path.join(SESSIONS, id + ".json") : "";
}

function readBinding(sessionId) {
  const f = bindingFile(sessionId);
  if (!f) return null;
  try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function writeBinding(sessionId, b) {
  const f = bindingFile(sessionId);
  if (!f) return;
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(b), { mode: 0o600 });
}

function dropBinding(sessionId) {
  const f = bindingFile(sessionId);
  if (f) { try { fs.unlinkSync(f); } catch {} }
}

/* The bridge hands its hook token over in a file only this user can read, never through the
   transcript. The binding only knows the port and the call id. */
function bridgeFor(b) {
  try {
    const f = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "bridges", `${Number(b.port)}.json`), "utf8"));
    if (f.call !== b.call) return null;   // that port now belongs to a different call
    return { base: `http://127.0.0.1:${Number(b.port)}/c/${f.call}`, token: f.hookToken };
  } catch { return null; }
}

async function getJson(br, sub, ms = 2000) {
  const r = await fetch(br.base + sub, { headers: { "x-ttc-hook": br.token }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function postJson(br, sub, body, ms = 2000) {
  await fetch(br.base + sub, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ttc-hook": br.token },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj));
}

async function main() {
  let input = {};
  try { input = JSON.parse((await readStdin()) || "{}"); } catch {}
  const sid = input.session_id;

  if (mode === "allow") {
    /* The matcher is the first gate; this is the second. Only these exact seven tools, so a tool
       from some other MCP server whose name merely CONTAINS ours is never approved here. */
    const OURS = /^mcp__plugin_kivi-talk_voice__call_(start|next|say|instruct|confirm|end|status)$/;
    if (!OURS.test(String(input.tool_name || ""))) return;
    out({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "kivi-talk call tool (only drives the voice call)",
      },
    });
    return;
  }

  /* Auto mode's classifier never sees tool results, so on its own it cannot know that the thing
     Claude is about to do was asked for, out loud, by the user. This tells it where the request
     came from, honestly: transcribed speech from the user's microphone, not speaker-verified.
     Only the request line itself is passed on, never the conversation around it. */
  if (mode === "classify") {
    const raw = JSON.stringify(input.tool_response || "");
    const m = raw.match(/REQUEST (r\d+) \((typed on the call page|spoken by the user[^)]*)\):\\n\\"([\s\S]*?)\\"\\n/);
    if (!m) return;
    const said = JSON.parse('"' + m[3] + '"').replace(/\s+/g, " ").slice(0, 600);
    const how = m[2].startsWith("typed")
      ? "typed by the user on the local call page"
      : "spoken by the user on a voice call they started with /talk, transcribed from their microphone (speech recognition, not speaker-verified)";
    out({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        classifierContext: `This call_next result is the user's own request ${m[1]}, ${how}: "${said}"`,
      },
    });
    return;
  }

  if (mode === "bind") {
    const m = JSON.stringify(input.tool_response || input).match(/\[ttc-bridge\] port=(\d{2,5}) call=([a-f0-9]{12})/);
    if (!m || !sid) return;
    writeBinding(sid, { port: Number(m[1]), call: m[2], at: Date.now(), blocks: 0, lastLoopAt: 0 });
    // Old bindings are dead weight once their sessions are gone.
    try {
      for (const f of fs.readdirSync(SESSIONS)) {
        const p = path.join(SESSIONS, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 3 * 86400000) fs.unlinkSync(p);
      }
    } catch {}
    return;
  }

  const b = readBinding(sid);
  if (!b) return;
  const br = bridgeFor(b);
  if (!br) { dropBinding(sid); return; }

  if (mode === "stop") {
    let st;
    try { st = await getJson(br, "/status"); }
    catch { dropBinding(sid); return; }          // bridge gone: the call is over
    if (st.state === "ended") { dropBinding(sid); return; }
    if (st.nextPending) return;                   // already listening (maybe in the background)
    /* A loop guard. If Claude has been sent back three times and has not touched the call
       since, something is wrong that another block will not fix: let it stop, and say so. */
    if (st.lastLoopAt && st.lastLoopAt === b.lastLoopAt && b.blocks >= 3) {
      if (!b.gaveUp) {   // said once, not on every later stop
        writeBinding(sid, { ...b, gaveUp: true });
        try { await postJson(br, "/notify", { text: "Claude stopped listening on the call. Type in its window, or say goodbye and call again." }); } catch {}
      }
      return;
    }
    writeBinding(sid, { ...b, blocks: st.lastLoopAt === b.lastLoopAt ? (b.blocks || 0) + 1 : 1, lastLoopAt: st.lastLoopAt || 0 });
    const waiting = (st.queued || []).length;
    out({
      decision: "block",
      reason: waiting
        ? `The voice call is still open and ${waiting} spoken request(s) are waiting. Call call_next now to get the next one.`
        : "The voice call is still open. Call call_next to wait for the user's next spoken request (call_end only if they asked to hang up).",
    });
    return;
  }

  if (mode === "notify") {
    const msg = String(input.message || "").trim();
    if (!msg) return;
    try { await postJson(br, "/notify", { text: msg + " (the approval is on screen in Claude's window)" }); } catch {}
  }
}

main().catch(() => {}).finally(() => process.exit(0));
