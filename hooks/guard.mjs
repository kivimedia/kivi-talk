#!/usr/bin/env node
/* kivi-talk hooks, one script, five modes:
 *
 *   allow     PreToolUse on this plugin's own call_* tools: approve them, so a call does not stop
 *             for a permission prompt every time Claude goes back to listening. Nothing else is
 *             approved here: every other tool keeps the session's own permission rules.
 *   classify  PostToolUse on call_next and call_say: tell auto mode where a request came from.
 *   bind      PostToolUse on call_start: remember which bridge belongs to this session. The MCP
 *             server cannot know the session id; the hook input carries it.
 *   stop      Stop: while this session's call is open and nothing is listening, send Claude back
 *             to call_next instead of letting the turn end and the voice go silent.
 *   notify    Notification (permission prompts): say it out loud on the call, because the user is
 *             talking, not watching the screen, and let the page show that it waits in Claude's
 *             own window, where the call cannot answer it.
 *
 * There is deliberately no hook on every tool: PreToolUse cannot run in the background, so each
 * one would hold up every tool call in every session by a Node start.
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

/* A few seconds, not one or two: a busy machine can spend that long just starting fetch in a fresh
   process, and a notice that never leaves is lost. Every mode still fails open after it. */
async function getJson(br, sub, ms = 5000) {
  const r = await fetch(br.base + sub, { headers: { "x-ttc-hook": br.token }, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function postJson(br, sub, body, ms = 5000) {
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

// A tool result arrives as a string, a content block, or a list of them.
function textOf(r) {
  if (typeof r === "string") return r;
  if (Array.isArray(r)) return r.map(textOf).join("\n");
  if (r && typeof r === "object") return typeof r.text === "string" ? r.text : textOf(r.content);
  return "";
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
        permissionDecisionReason: "kivi-talk call tool (drives the voice call and its local call page)",
      },
    });
    return;
  }

  /* Auto mode's classifier never sees tool results, so on its own it cannot know that the thing
     Claude is about to do was asked for, out loud, by the user. This tells it where the request
     came from, honestly: transcribed speech from the user's microphone, not speaker-verified.
     Only the request line itself is passed on, never the conversation around it. */
  if (mode === "classify") {
    /* At the end of a call Claude is told to finish what the user asked for on it. Pass on only
       the user's own unfinished asks: never the voice's lines, never anything already done. */
    const whole = textOf(input.tool_response);
    // Only the bridge's own hand-off starts this way (call_next, or call_say after the call ended).
    if (/^(?:The call has already ended, so nothing was spoken\. )?CALL ENDED \(/.test(whole)) {
      const asks = new Set();
      for (const m of whole.matchAll(/^\[[^\]\n]*\] User \(NOT HANDED OVER to you during the call\): (.*)$/gm)) asks.add(m[1]);
      const open = whole.match(/^Handed to you but not answered on the call: (.*)$/m);
      // Something the user clicked Decline on, or cancelled on the call, is not an ask. Each
      // request's notes run up to the next request.
      if (open) {
        const reqs = [...open[1].matchAll(/r\d+ "([^"]*)"/g)];
        reqs.forEach((m, i) => {
          const notes = open[1].slice(m.index + m[0].length, i + 1 < reqs.length ? reqs[i + 1].index : undefined);
          if (!/\(the user (?:clicked Decline|cancelled it)/.test(notes)) asks.add(m[1]);
        });
      }
      if (!asks.size) return;
      const list = [...asks].map((a) => `"${a.replace(/\s+/g, " ").slice(0, 300)}"`).join(" | ").slice(0, 1500);
      out({
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          classifierContext: `This call_next result ends a voice call the user started with /talk. Claude was told to finish, in this session, what the user asked for on it and did not get done; destructive or outward-facing steps must be asked in the chat first. The user's own unfinished words, transcribed from their microphone (speech recognition, not speaker-verified): ${list}`,
        },
      });
      return;
    }
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
    catch (e) {
      /* Gone (refused, or the port answers for another call): the call is over. Only slow (a busy
         machine): let this stop through, but keep the binding, or every later stop would too. */
      if (e.name !== "TimeoutError") dropBinding(sid);
      return;
    }
    if (st.state === "ended") { dropBinding(sid); return; }
    if (st.nextPending) return;                   // already listening (maybe in the background)
    /* A loop guard. If Claude has been sent back three times and has not touched the call
       since, something is wrong that another block will not fix: let it stop, and say so. */
    if (st.lastLoopAt && st.lastLoopAt === b.lastLoopAt && b.blocks >= 3) {
      if (!b.gaveUp) {   // said once, not on every later stop
        writeBinding(sid, { ...b, gaveUp: true });
        try { await postJson(br, "/notify", { text: "Claude stopped listening on the call. Type in its window, or say goodbye and call again.", kind: "stopped" }); } catch {}
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
    // hooks.json only routes permission prompts here; an older host may not name the type.
    const kind = !input.notification_type || input.notification_type === "permission_prompt" ? "permission" : undefined;
    try { await postJson(br, "/notify", { text: msg + " (the approval is on screen in Claude's window)", kind }); } catch {}
  }
}

main().catch(() => {}).finally(() => process.exit(0));
