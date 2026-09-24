# talk-to-claude

Talk out loud to the Claude Code session you are in.

Type `/talk-to-claude`, press **Start talking** on the page that opens, and speak. A voice model
(OpenAI **gpt-live-1**, on your own OpenAI key) listens and talks back. Everything you ask for is
handed to **your Claude session**, which does the work with its own tools, in its own window,
under its own permission rules, and answers out loud.

> Not affiliated with, endorsed by, or sponsored by Anthropic or OpenAI. Claude is a trademark of
> Anthropic. GPT is a trademark of OpenAI.

## Install

```
/plugin marketplace add kivimedia/talk-to-claude
/plugin install talk-to-claude@kivimedia
```

When the plugin is enabled, Claude Code asks for your **OpenAI API key** (masked, stored in your
system's secure storage). Skip it and the call page asks for it the first time instead.

Requires Node.js 20 or later on your PATH, and a desktop browser with a microphone
(Chrome, Edge, Firefox or Safari). The repository is private for now: installing uses your own
git credentials, so you need read access to `kivimedia/talk-to-claude`.

Works wherever Claude Code runs on your own computer: the terminal, the VS Code extension and the
Code tab of the Claude desktop app. The browser and Claude Code must be on the same machine (the
call page lives on `127.0.0.1`), so remote SSH sessions, WSL-without-a-Windows-browser and
cloud sandboxes are not supported.

## Use

```
/talk-to-claude                     start a call
/talk-to-claude the failing tests   start a call about something specific
```

- Talk normally. Ask it to read, run, fix, explain, look things up: anything you would type.
- For longer work you hear short progress notes. You can keep talking; new requests queue.
- Say **"bye"**, **"hang up"**, or press **End call**. Claude writes a short summary of the call.
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

- The plugin's MCP server starts a small web server on `127.0.0.1` only, with a random port and
  a random per-call token in every URL.
- Your OpenAI key never reaches the page. The page sends its WebRTC offer to the local server,
  which opens the session with OpenAI and hands back only the answer.
- Claude only learns what you said through the `call_next` tool, as a request it handles like a
  typed prompt.

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
OpenAI; your files and Claude's work stay on your computer. Claude asks for a spoken "yes" before
anything destructive or outward-facing, and your normal Claude Code permission rules still apply.
When a tool needs approval, you hear a heads-up and approve it on screen.

## Develop

```
npm test                              # unit tests, no network
TTC_E2E_OPENAI_KEY=sk-... PUPPETEER_FROM=/path/with/puppeteer-core/package.json node test/e2e/run.mjs
claude --plugin-dir .                 # try it without installing
```

The end-to-end test plays a spoken question into a headless Chrome fake microphone, runs a real
`claude -p` session with the plugin, and checks that the answer is spoken back. It uses a minute
or two of gpt-live-1.
