#!/usr/bin/env python3
"""Interactive-mode check (Linux/macOS, needs a logged-in `claude`).

In the interactive CLI, an MCP call still running after the auto-background threshold becomes a
background task and Claude's turn ends. The call only works if the user's next spoken request,
arriving while call_next is in the background, WAKES the idle session. This drives a real
`claude` TUI in a pseudo-terminal, lets call_next go to the background, then sends a request
through the call page's own API and checks that Claude answers it.

No microphone or OpenAI key needed: requests go in through the page's typed-request door.

Usage: python3 test/e2e/interactive_wake.py [plugin_dir]
"""
import http.cookiejar, json, os, pty, re, select, shutil, sys, tempfile, time, urllib.request

PLUGIN = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", ".."))
WORK = tempfile.mkdtemp(prefix="ttc-wake-")
DATA = os.path.join(WORK, ".data")
URL_FILE = os.path.join(WORK, ".url")
for i in range(1, 8):
    open(os.path.join(WORK, f"note-{i}.md"), "w").write(f"# note {i}\n")
T0 = time.time()
screen = bytearray()


def say(*a):
    print(f"[+{time.time() - T0:5.1f}s]", *a, flush=True)


env = dict(os.environ,
           TTC_NO_BROWSER="1", TTC_URL_FILE=URL_FILE, TTC_DATA_DIR=DATA, TTC_KEEP_TRANSCRIPTS="1",
           CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS=os.environ.get("BG_MS", "15000"), TERM="xterm-256color")
args = ["claude", "--plugin-dir", PLUGIN, "--permission-mode", "acceptEdits",
        "--allowedTools", "Glob", "Read", "Grep", "Bash(ls:*)", "Bash(find:*)", "Bash(wc:*)"]
pid, fd = pty.fork()
if pid == 0:
    os.chdir(WORK)
    os.execvpe("claude", args, env)


def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                screen.extend(os.read(fd, 65536))
            except OSError:
                return


def plain():
    return re.sub(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07", b"", bytes(screen)).decode("utf8", "replace")


def send(s):
    os.write(fd, s.encode())


say("claude TUI starting in", WORK)
pump(8)
if "trust" in plain().lower():
    say("answering the folder-trust prompt")
    send("\r")
    pump(4)
send("/talk-to-claude")
pump(1.5)
send("\r")
say("typed /talk-to-claude")

for _ in range(120):
    pump(1)
    if os.path.exists(URL_FILE):
        break
if not os.path.exists(URL_FILE):
    say("FAIL: call_start never ran. Screen tail:\n" + plain()[-2000:])
    sys.exit(1)

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
page = opener.open(open(URL_FILE).read().strip())       # follows the one-time link, keeps the cookie
base = page.geturl()
say("call page open:", re.sub(r"/c/.*", "/c/<id>/", base))


def status():
    return json.loads(opener.open(base + "status").read())


def post(sub, body):
    req = urllib.request.Request(base + sub, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
    return json.loads(opener.open(req).read())


# Let call_next go to the background and the turn end.
bg_s = int(env["CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS"]) / 1000
for _ in range(int(bg_s) + 60):
    pump(1)
    if status().get("nextPending"):
        break
say("call_next pending:", status().get("nextPending"))
pump(bg_s + 20)
st = status()
say(f"after {bg_s + 20:.0f}s more: nextPending={st.get('nextPending')} claude={st.get('claude')}")
backgrounded = "background" in plain().lower()
say("screen mentions background:", backgrounded)

# The user speaks while Claude is idle with call_next in the background.
post("typed", {"text": "How many markdown files are in this folder?"})
say("sent the request")
answer = None
for _ in range(150):
    pump(1)
    calls = os.path.join(DATA, "calls")
    if os.path.isdir(calls):
        for f in os.listdir(calls):
            for line in open(os.path.join(calls, f)):
                row = json.loads(line)
                if row["role"] == "claude" and re.search(r"\b(7|seven)\b", row["text"], re.I):
                    answer = row["text"]
    if answer:
        break
say("answer:", answer)

post("state", {"state": "closed", "reason": "test finished"})
pump(40)
send("/exit\r")
pump(5)
try:
    os.kill(pid, 9)
except OSError:
    pass
tail = plain()[-3000:]
open(os.path.join(WORK, "screen.txt"), "w").write(plain())
result = {"backgrounded": backgrounded, "woke_and_answered": bool(answer), "answer": answer, "work": WORK}
print(json.dumps(result, indent=2))
shutil.rmtree(DATA, ignore_errors=True) if answer else None
sys.exit(0 if answer else 1)
