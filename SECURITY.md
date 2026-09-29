# Security and privacy

Kivi Talk lets a voice drive a Claude Code session that can read and change files and run
commands. That is the point of it, and it is also why the defaults below exist.

## What leaves your computer

| Goes to OpenAI | Stays on your computer |
|---|---|
| Your microphone audio during a call | Your files, code and command output |
| What Claude says out loud (short spoken answers) | Claude's full work and reasoning |
| The call instructions (project folder name, the focus you typed) | What Claude puts on the call page's **On screen** card (code, links, tables, pictures) |
| The text of your requests, with anything that looks like a key or password masked, so the voice can follow the conversation | Files in both directions and their names: what Claude shares with you and what you share with Claude |
| Short generic notes such as "Claude put details on the user's screen" or "the user attached 2 files", never the content | Files you share, saved in the plugin data folder under `uploads/<call id>/` (owner-only permissions on macOS and Linux), kept after the call so Claude can finish with them, and deleted after 7 days, at the start of a later call |
| | Call transcripts (`calls/*.jsonl` in the plugin data folder), only if you turn them on. What is on screen is never written to them. |

When a call ends, the whole conversation (what the microphone heard, what the voice said, what
Claude said) is handed to your Claude session so Claude can finish what you asked for. That puts
it in the session like anything you type: Claude Code's own session log on your computer, and
your Claude provider under its terms. This happens whether or not transcript files are on.

Claude is told never to say secrets out loud. Treat anything it speaks as sent to OpenAI under
your OpenAI account's data terms. If your employer restricts sending code or voice to third
parties, check before using it on that code.

## The local bridge

- Listens on `127.0.0.1` only, on a random port, for the life of your Claude session. On Linux it
  also refuses connections from other accounts on the same computer.
- The call page opens only through a one-time link (a random 192-bit code, dead after its first
  use). Opening it sets an HttpOnly, SameSite=Strict cookie, scoped to that call's path, holding a
  separate 256-bit secret that is never printed or put in a URL; nothing under the call is served
  without it. Asking Claude for a fresh link rotates the secret and cuts off any older page. The
  plugin's own hooks use a third token, handed over in a file only you can read, and it opens the
  call's status and notices only.
- Refuses requests whose `Host` is not `127.0.0.1`/`localhost` on that port (blocks DNS
  rebinding), refuses any cross-site `Origin`, and sends no CORS headers. Every POST must be
  `application/json`, except `POST /upload` (a file you share on the page), which must be
  `application/octet-stream`. A web page cannot send either type cross-site without a preflight,
  and the bridge never answers one. Uploads are capped at 25 MiB each and 20 waiting at a time.
- `GET /file/<token>` serves a file Claude shared, to the call page only (the hooks' token cannot
  read files). Each file is served as a picture, a PDF, plain text or a download, never as a page:
  under a sandbox Content Security Policy (no scripts run, not even in an SVG) and with nosniff.
- The page runs under a strict Content Security Policy (no external scripts, no framing). What
  Claude puts on screen is untrusted text: it is drawn without ever parsing HTML, and only http,
  https and mailto links are live.
- The OpenAI key is read by the bridge only. It is never sent to the page or written to logs.

## Voice-specific risks

- **Anyone the microphone hears can speak to Claude.** A person in the room, or audio playing
  from a video, can issue requests, and everything heard reaches Claude (the call page hands over
  anything the voice did not). Before anything destructive or outward-facing, Claude shows
  the exact action on the call page and waits for a click on Approve; a spoken "yes" never counts,
  and nothing is done if nobody clicks within about two minutes. After the call ends, Claude
  finishes what was left over, and for those same actions it asks in the chat and waits for your
  answer; something you declined on the call is never redone. Your Claude Code permission rules
  still apply on top. Use headphones and hang up when you are done.
- **Speech recognition can mishear.** Claude is told to ask when a request is ambiguous.
- **Content Claude reads is not you.** Instructions found inside files (including files shared on
  the call page), web pages or tool output are treated as data. Only requests that arrive through
  the call are yours.

## Permissions

The plugin approves only its own `call_*` tools, without a prompt. They drive the call and its
page: they cannot run commands or change files. `call_say` can show a local file Claude names on
the call page, on this computer only, the way Claude could paste it into the chat; network and
device paths (such as `\\server\share`) are refused before anything touches them, because on
Windows even looking one up would make the computer connect to that server with your credentials.

Everything else goes through your normal Claude Code permission mode. Files you share on a call
are saved outside your project folder, so in the default mode Claude's first look at one asks for
your approval in Claude's window (the call page shows a banner); with
`permissions.blockReadsOutsideWorkingDirectories` on, add the plugin data folder with `/add-dir`
first. For hands-free work, a mode that auto-approves more is your choice to make; the plugin never
changes it.

## Your OpenAI key

Stored by Claude Code's plugin settings (system secure storage where available), or, if you paste
it on the call page, in `config.json` in the plugin's data folder (readable only by you on macOS
and Linux). Use a key with a spending limit. Never paste a key into a GitHub issue.

## For plugin directory reviewers

The automated scan raises these on Kivi Talk. Each is expected; here is exactly what the code does.

- **A hook grants permission.** `hooks/hooks.json` has one PreToolUse hook that approves only
  this plugin's own seven tools, by an anchored name match
  (`^mcp__plugin_kivi-talk_voice__call_(start|next|say|instruct|confirm|end|status)$`), and
  `hooks/guard.mjs` checks the exact name a second time. No other tool is ever approved, including
  one from another server whose name merely contains ours (`test/guard.test.mjs` proves both).
  Without it, a voice call would stop for an on-screen prompt every time Claude goes back to
  listening. These tools cannot run commands or change files (see Permissions above).
- **The plugin uses a credential from your machine.** The only credential is the user's own
  OpenAI API key, from, in order: a key the user pasted on the local call page (checked with
  OpenAI first, then saved in the plugin data folder), the plugin's `sensitive` userConfig value,
  or an `OPENAI_API_KEY` environment variable. It is sent only in the `Authorization` header to
  the key's own issuer, `https://api.openai.com`, for exactly two requests: `GET /v1/models/<model>`
  (to check a pasted key) and `POST /v1/live/sessions` (to open the user's voice session). It is
  never sent to the call page, never logged, and removed from the environment of the one process
  the plugin starts. `TTC_OPENAI_BASE` changes that host only so the tests can use a local mock.
  The flagged test files use fake keys, except `test/e2e/run.mjs` and `test/e2e/leftovers.mjs`,
  which a developer runs by hand with a real key in `TTC_E2E_OPENAI_KEY`; they are not part of
  the plugin's behaviour.
- **A download-and-run pattern.** Nothing is downloaded and run. The one process the plugin starts
  is the operating system's own link opener (`rundll32 url.dll`, `open`, `xdg-open`, or
  `cmd /c start` under WSL) pointed at the bridge's own one-time `http://127.0.0.1` link, so the
  call page opens in the user's browser. The test helpers start the local bridge and a local
  headless Chrome. The hooks make requests to `127.0.0.1` only.
- **The MCP server is local.** It is a zero-dependency Node script that runs on the user's
  computer, so the plugin works in Claude Code only, not in Cowork or the Claude apps.

## Reporting a problem

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a
vulnerability"). Please do not open a public issue for a vulnerability.
