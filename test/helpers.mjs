import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ttc-${tag}-`));
}

/* A fake OpenAI: records every request, answers /v1/live/sessions and /v1/models/<m>. */
export async function mockOpenAI({ liveStatus = 201, modelStatus = 200 } = {}) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/v1/live/sessions") {
        res.statusCode = liveStatus;
        if (liveStatus >= 400) return res.end(JSON.stringify({ error: { message: "Incorrect API key provided" } }));
        return res.end(JSON.stringify({ session: { id: "live_test123" }, transport: { type: "webrtc", sdp: "v=0 answer" } }));
      }
      if (req.url.startsWith("/v1/models/")) {
        res.statusCode = modelStatus;
        return res.end(JSON.stringify(modelStatus < 400 ? { id: "gpt-live-1" } : { error: { message: "bad key" } }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${srv.address().port}`, seen, close: () => srv.close() };
}

/* Spawns the real bridge over stdio and speaks JSON-RPC to it. */
export function startBridge(env = {}) {
  const data = tmpDir("data");
  const urlFile = path.join(data, "url.txt");
  const clean = { ...process.env };
  for (const k of ["OPENAI_API_KEY", "CLAUDE_PLUGIN_OPTION_OPENAI_API_KEY", "TTC_OPENAI_API_KEY", "CLAUDE_PLUGIN_DATA",
    "TTC_PLUGIN_DATA", "CLAUDE_PLUGIN_OPTION_KEEP_TRANSCRIPTS"]) delete clean[k];
  const child = spawn(process.execPath, [path.join(ROOT, "server", "bridge.mjs")], {
    env: { ...clean, TTC_NO_BROWSER: "1", TTC_DATA_DIR: data, TTC_URL_FILE: urlFile, TTC_KEEP_TRANSCRIPTS: "1", ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let nextId = 1;
  const waiting = new Map();
  const notes = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      else notes.push(msg);
    }
  });
  let stderr = "";
  child.stderr.on("data", (c) => { stderr += c; });

  function rpc(method, params, id = nextId++) {
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method, params) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  async function tool(name, args = {}, id) {
    const r = await rpc("tools/call", { name, arguments: args }, id);
    return r.result ? r.result.content.map((c) => c.text).join("\n") : JSON.stringify(r.error);
  }
  async function init() {
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    notify("notifications/initialized", {});
  }
  function launchUrl() { return fs.readFileSync(urlFile, "utf8").trim(); }
  function stop() { try { child.kill(); } catch {} }
  return { child, rpc, notify, tool, init, launchUrl, open: () => openPage(launchUrl()), stop, data, notes,
    get stderr() { return stderr; }, nextRpcId: () => nextId++ };
}

/* Opens the call the way a browser does: follow the one-time link, keep the cookie. */
export async function openPage(launch) {
  const r = await fetch(launch, { redirect: "manual" });
  if (r.status !== 302) throw new Error("launch link answered " + r.status);
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get("set-cookie")])[0].split(";")[0];
  const base = new URL(r.headers.get("location"), launch).href;   // http://127.0.0.1:P/c/<id>/
  const withCookie = (h = {}) => ({ cookie, ...h });
  return {
    base, cookie, setCookie: r.headers.get("set-cookie"),
    get: (sub = "", h) => fetch(base + sub, { headers: withCookie(h) }),
    post: (sub, body, h) => post(base + sub, body, withCookie(h)),
    sse: (sub = "events") => sse(base + sub, withCookie()),
  };
}

export async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let j = null;
  const text = await r.text();
  try { j = JSON.parse(text); } catch {}
  return { status: r.status, json: j, text };
}

/* Minimal SSE reader: collects parsed `data:` frames. */
export function sse(url, headers = {}) {
  const frames = [];
  const ctrl = new AbortController();
  const done = (async () => {
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers });
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = block.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n");
          if (data) { try { frames.push(JSON.parse(data)); } catch {} }
        }
      }
    } catch {}
  })();
  return {
    frames,
    close() { ctrl.abort(); return done; },
    async waitFor(pred, ms = 3000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        const f = frames.find(pred);
        if (f) return f;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timed out waiting for SSE frame; got " + JSON.stringify(frames.map((f) => f.type)));
    },
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
