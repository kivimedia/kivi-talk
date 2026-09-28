# Kivi Talk

Talk out loud to the Claude Code session you are in. Voice for Claude Code, powered by OpenAI
GPT-Live.

Type `/talk`, press **Start talking** on the page that opens, and speak. A voice model
(OpenAI **gpt-live-1**, on your own OpenAI key) listens and talks back. Everything you ask for is
handed to **your Claude session**, which does the work with its own tools, in its own window,
under its own permission rules, and answers out loud.

> Kivi Talk is an independent project by Kivi Media. It is not affiliated with, endorsed by, or
> sponsored by Anthropic or OpenAI. Claude and Claude Code are trademarks of Anthropic, PBC. GPT is
> a trademark of OpenAI.

## Install

```
/plugin marketplace add kivimedia/kivi-talk
/plugin install kivi-talk@kivimedia
```

When the plugin is enabled, Claude Code asks for your **OpenAI API key** (masked, stored in your
system's secure storage). Skip it and the call page asks for it the first time instead.

Requires Node.js 20 or later on your PATH, and a desktop browser with a microphone
(Chrome, Edge, Firefox or Safari). The repository is private for now: installing uses your own
git credentials, so you need read access to `kivimedia/kivi-talk`.

Works wherever Claude Code runs on your own computer: the terminal, the VS Code extension and the
Code tab of the Claude desktop app. The browser and Claude Code must be on the same machine (the
call page lives on `127.0.0.1`), so remote SSH sessions, WSL-without-a-Windows-browser and
cloud sandboxes are not supported.

## Use

```
/talk                     start a call
/talk the failing tests   start a call about something specific
```

The full name is `/kivi-talk:talk`. Installed it while VS Code (or another Claude Code window) was
already open? That window keeps its old command list: type `/reload-plugins` in its chat once, and
`/talk` appears. Sending `/talk` works even before that.

- Talk normally. Ask it to read, run, fix, explain, look things up: anything you would type.
  Everything you say goes to Claude, not just what the voice decides to pass on: if the voice
  answers something itself, the call page hands it to Claude anyway.
- For longer work you hear short progress notes. You can keep talking; new requests queue.
- Claude shows you things, not just says them. Code, commands, file paths, links, tables, exact
  error text, screenshots and files appear on the call page's **On screen** card, with a Copy
  button for text. Pictures show on the card; PDFs and text files open in a new tab; anything
  else (Office files, archives, audio, video) is a Download link. Claude says the short version
  out loud and tells you the rest is on screen. Earlier entries stay one click away (Previous /
  Next).
- Show Claude things too: press **Attach**, drag files onto the page, or paste a screenshot. They
  go to Claude with your next request, typed or spoken, and Claude opens them with its own tools.
  Files alone are fine: press Send with an empty box. They are saved outside your project folder,
  so in Claude Code's default permission mode Claude's first look at one asks for your approval in
  its window (you hear a heads-up and the call page shows a banner).
- Stop a request: press **Stop** next to it in the list of open requests, or just say "stop" or
  "cancel" (Hebrew works too: "עצור", "בטל"). A request still waiting in the queue is dropped. One
  Claude is already working on stops at Claude's next check-in (its next progress note), and
  Claude tells you what, if anything, was already changed. Nothing is undone unless you ask.
- When one of Claude's own tools needs your permission, you hear a heads-up and the call page
  shows a banner. The approval itself is in Claude's window: the call cannot give it for you.
- Say **"bye"**, **"hang up"**, or press **End call**. Claude gets the whole conversation,
  finishes anything left over in the session (asking you in the chat first before anything
  destructive or outward-facing), and reports what was done.
- You can also type a request on the call page, or type in Claude's window as usual.

## What it costs

- **OpenAI**: gpt-live-1 bills per minute while a call is live (about $0.05 a minute at the time
  of writing, so about $3 an hour). The call page shows the running estimate. Calls hang up by
  themselves after 5 quiet minutes and after 60 minutes in total.
- **Claude**: the work is done by your normal Claude Code session and counts like typed prompts.

## How it works

```
 you ── mic ──► call page (localhost) ── WebRTC ──► OpenAI gpt-live-1
                     ▲   │                               │
                     │   └── "the user asked X" ◄── delegation
                     │            │
                     │            ▼
                     │   local bridge (plugin MCP server) ──► call_next ──► your Claude session
                     │                                                          │ does the work
                     └──── answer spoken ◄── commentary ◄── call_say ◄──────────┘
```

- The plugin's MCP server starts a small web server on `127.0.0.1` only, on a random port. The
  call page opens through a one-time link and then holds a per-call secret in a cookie.
- Your OpenAI key never reaches the page. The page sends its WebRTC offer to the local server,
  which opens the session with OpenAI and hands back only the answer.
- Claude only learns what you said through the `call_next` tool, as a request it handles like a
  typed prompt. Files you attach ride along with that request as local paths Claude can open.
- What Claude puts on screen, and files in both directions, travel only between the local bridge
  and the call page. The voice is told only that something is on screen or that you attached
  files, never what.

## Settings (optional, environment variables)

| Variable | Default | What it does |
|---|---|---|
| `TTC_VOICE` | OpenAI's default | Voice name for gpt-live-1 |
| `TTC_LANGUAGE` | match the user | Force a spoken language, e.g. `Hebrew` |
| `TTC_IDLE_MINUTES` | `5` | Hang up after this many quiet minutes |
| `TTC_MAX_MINUTES` | `60` | Hard limit on one call |
| `TTC_NO_BROWSER` | unset | `1` = print the call URL instead of opening a browser |

## Privacy and safety

Read [SECURITY.md](SECURITY.md). In short: your voice and whatever Claude says out loud go to
OpenAI; your files and Claude's work stay on your computer. Before anything destructive or
outward-facing, Claude shows the exact action on the call page and waits for you to click
**Approve**; a spoken "yes" is not enough, because anyone near the microphone could say it. Your
normal Claude Code permission rules still apply on top. When a tool needs approval, you hear a
heads-up, the call page shows a banner, and you approve or deny it in Claude's window.

What never leaves your computer: the **On screen** card (code, links, tables, anything Claude
shows you), files in both directions (what Claude shares with you and what you share with
Claude), and their file names. The voice model only hears that there is something on screen or
that you attached files, and on-screen content is not written to call transcripts either. Files
you share are saved in the plugin's data folder under
`uploads/<call id>/`, readable only by you (owner-only permissions on macOS and Linux), kept after
the call so Claude can finish working with them, and deleted automatically after 7 days (at the
start of a later call). What still goes to OpenAI: your speech, Claude's spoken answers, and the
text of your requests (with anything that looks like a key or password masked), so the voice can
follow the conversation.

## Releasing

Installed copies update only when `version` in `.claude-plugin/plugin.json` changes. Bump it (and
`package.json`, and `VERSION` in `server/bridge.mjs`) with every change meant to reach users.

## Develop

```
npm test                              # unit tests, no network
TTC_E2E_OPENAI_KEY=sk-... PUPPETEER_FROM=/path/with/puppeteer-core/package.json node test/e2e/run.mjs
claude --plugin-dir .                 # try it without installing
```

The end-to-end test plays a spoken question into a headless Chrome fake microphone, runs a real
`claude -p` session with the plugin, and checks that the answer is spoken back. It uses a minute
or two of gpt-live-1.

## Licence

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE). The licence does not cover the
Kivi Talk or Kivi Media names.
