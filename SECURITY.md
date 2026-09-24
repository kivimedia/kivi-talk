# Security and privacy

talk-to-claude lets a voice drive a Claude Code session that can read and change files and run
commands. That is the point of it, and it is also why the defaults below exist.

## What leaves your computer

| Goes to OpenAI | Stays on your computer |
|---|---|
| Your microphone audio during a call | Your files, code and command output |
| What Claude says out loud (short spoken answers) | Claude's full work and reasoning |
| The call instructions (project folder name, the focus you typed) | Call transcripts (`calls/*.jsonl` in the plugin data folder) |

Claude is told never to say secrets out loud. Treat anything it speaks as sent to OpenAI under
your OpenAI account's data terms. If your employer restricts sending code or voice to third
parties, check before using it on that code.

## The local bridge

- Listens on `127.0.0.1` only, on a random port, for the life of your Claude session.
- Every URL carries a random 192-bit token created for that call; nothing is served without it.
- Refuses requests whose `Host` is not `127.0.0.1`/`localhost` on that port (blocks DNS
  rebinding), refuses any cross-site `Origin`, sends no CORS headers, and only accepts
  `application/json` POSTs (a web page cannot forge them without a preflight that is never
  answered).
- The page runs under a strict Content Security Policy (no external scripts, no framing).
- The OpenAI key is read by the bridge only. It is never sent to the page or written to logs.

## Voice-specific risks

- **Anyone the microphone hears can speak to Claude.** A person in the room, or audio playing
  from a video, can issue requests. Before anything destructive or outward-facing, Claude shows
  the exact action on the call page and waits for a click on Approve; a spoken "yes" never counts,
  and nothing is done if nobody clicks within about two minutes. Your Claude Code permission rules
  still apply on top. Use headphones and hang up when you are done.
- **Speech recognition can mishear.** Claude is told to ask when a request is ambiguous.
- **Content Claude reads is not you.** Instructions found inside files, web pages or tool output
  are treated as data. Only requests that arrive through the call are yours.

## Permissions

The plugin approves only its own `call_*` tools (they only drive the call). Everything else goes
through your normal Claude Code permission mode. For hands-free work, a mode that auto-approves
more is your choice to make; the plugin never changes it.

## Your OpenAI key

Stored by Claude Code's plugin settings (system secure storage where available), or, if you paste
it on the call page, in `config.json` in the plugin's data folder (readable only by you on macOS
and Linux). Use a key with a spending limit. Never paste a key into a GitHub issue.

## Reporting a problem

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a
vulnerability"). Please do not open a public issue for a vulnerability.
