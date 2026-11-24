"""Drive the real single-key menu and Start question in a pseudo-terminal and check the terminal is left as found.

For each case (arrow plus Enter, q, Ctrl-C) a tiny script opens the menu from
src/ui/prompt.ts, or the Start question from src/ui/start.ts, on a
pseudo-terminal. The terminal settings (`stty -g`) are read before and after;
they must be identical, the cursor must be shown again after it was hidden,
bracketed paste must be off again, and the answer and exit code must match.
No coding CLI, history store, or network is involved.

Type-ahead cases write keys before the process starts, so they wait in the
terminal's own input queue, as keys pressed during export do. They must never
answer, and the question says they were ignored. At the Start question only
`s` starts: a held Enter (first repeat 500 ms after the question appears, then
every 40 ms), a paste, and an `s` typed ahead never do, while an `s` pressed
after the person waited starts at once, also on a slow terminal and on 12 rows.

Run from the repository root: python3 scripts/smoke-menu.py
"""
import fcntl
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import sys
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
PROMPT = (ROOT / "src/ui/prompt.ts").as_uri()
START = (ROOT / "src/ui/start.ts").as_uri()

# Node runs the TypeScript source directly: types are stripped, and this hook
# maps the `.js` import specifiers in the sources to their `.ts` files.
HOOKS = """
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      return next(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw error;
  }
}
"""
REGISTER = 'import { register } from "node:module";\nregister("./hooks.mjs", import.meta.url);\n'
# Shown at 80 columns; left out whole at 40, never cut in the middle of a word.
DETAIL = "a detail long enough to be left out on a narrow terminal"
DEMO = f"""
import {{ execFileSync }} from "node:child_process";
import {{ chooseMenuAnswer }} from "{PROMPT}";
import {{ askStart }} from "{START}";
const answer = process.env.SMOKE_START === "1"
  ? await askStart({{
      options: [
        {{ key: "balanced", label: "Balanced", detail: "light reads, heavy writes" }},
        {{ key: "best", label: "Best", detail: "heavy reads, top writes" }},
      ],
      selected: "balanced",
    }})
  : await chooseMenuAnswer({{
      title: "Pick one",
      choices: [
        {{ key: "first", label: "First", recommended: true }},
        {{ key: "second", label: "Second", detail: "{DETAIL}" }},
        {{ key: "third", label: "Third" }},
      ],
      above: () => ["Synthetic setup table"],
    }});
// Read the settings while this process still runs: Node also resets the
// terminal when it exits, which would hide a menu that forgot to.
const settings = execFileSync("stty", ["-g"], {{ stdio: ["inherit", "pipe", "inherit"] }});
const said = typeof answer === "object" ? `start:${{answer.selected}}` : answer;
process.stdout.write(`STTY=${{settings.toString().trim()}}\\n`);
process.stdout.write(`ANSWER=${{said}}\\n`);
process.exitCode = answer === "interrupt" ? 130 : 0;
"""

PASTE = b"\x1b[200~git log -2\rs\r\x1b[201~"
CASES = [
    ("arrow and Enter", [b"\x1b[B", b"\r"], "second", 0, 80),
    ("q", [b"q"], "quit", 0, 80),
    ("Ctrl-C", [b"\x03"], "interrupt", 130, 80),
    ("a digit on a 40-column terminal", [b"3"], "third", 0, 40),
    # Typed before the menu existed: thrown away, said so, and only q answers.
    ("a digit and Enter typed ahead", [b"q"], "quit", 0, 80, {"ahead": b"3\r"}),
    # A paste at a menu answers nothing.
    ("a paste at a menu", [PASTE, b"q"], "quit", 0, 80, {"pasted": True}),
    # The Start question: only s starts.
    ("s after waiting at the Start question", [b"s"], "start:balanced", 0, 80, {"start": True, "wait": 0.5}),
    ("2, then s", [b"2", b"s"], "start:best", 0, 80, {"start": True}),
    ("s on a slow terminal", [b"s"], "start:balanced", 0, 80, {"start": True, "slow": True}),
    ("s on 12 rows", [b"s"], "start:balanced", 0, 80, {"start": True, "rows": 12}),
    ("a held Enter at the Start question", [b"q"], "quit", 0, 80, {"start": True, "held": b"\r", "hint": True}),
    ("a held 1 at the Start question", [b"q"], "quit", 0, 80, {"start": True, "held": b"1"}),
    ("an s typed ahead of the Start question", [b"q"], "quit", 0, 80, {"start": True, "ahead": b"s"}),
    ("a paste holding s at the Start question", [PASTE, b"q"], "quit", 0, 80, {"start": True, "pasted": True}),
    ("Ctrl-C at the Start question", [b"\x03"], "interrupt", 130, 80, {"start": True}),
]
TYPED_AHEAD = "Ignored keys typed ahead. Choose when you are ready."
ESCAPES = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)")


def stty(fd):
    return subprocess.run(["stty", "-g"], stdin=fd, capture_output=True, text=True, check=True).stdout.strip()


def read_until(master, needle, transcript, deadline, slow=False):
    while needle not in transcript[0]:
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {needle!r}; saw {transcript[0][-400:]!r}")
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            continue
        if slow:
            # A slow link: small reads with a delay between them.
            time.sleep(0.03)
        try:
            chunk = os.read(master, 256 if slow else 4096)
        except OSError:
            return
        if not chunk:
            return
        transcript[0] += chunk


def run_case(work, name, keys, expected, code, columns, o=None):
    o = o or {}
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", o.get("rows", 24), columns, 0, 0))
    before = stty(slave)
    env = {k: v for k, v in os.environ.items() if k not in {"CI", "HUMAN_HINDSIGHT_PLAIN", "NO_COLOR", "FORCE_COLOR", "LC_ALL", "LC_CTYPE"}}
    env.update({"TERM": "xterm-256color", "LANG": "en_US.UTF-8"})
    if o.get("start"):
        env["SMOKE_START"] = "1"
    # Keys pressed before the menu process exists wait in the terminal's queue.
    if o.get("ahead"):
        os.write(master, o["ahead"])
    child = subprocess.Popen(
        [shutil.which("node"), "--experimental-strip-types", "--no-warnings", "--import", "./register.mjs", "demo.mjs"],
        cwd=work, stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True,
    )
    transcript = [b""]
    deadline = time.monotonic() + 20
    try:
        slow = o.get("slow", False)
        read_until(master, b"Not now" if o.get("start") else b"Pick one", transcript, deadline, slow)
        if o.get("held"):
            # Held down: the first repeat 500 ms after the question appears, then every 40 ms.
            time.sleep(0.5)
            for _ in range(50):
                os.write(master, o["held"])
                time.sleep(0.04)
        # A person reads what is on screen before answering.
        time.sleep(o.get("wait", 0.1))
        for key in keys:
            os.write(master, key)
            time.sleep(0.05)
        read_until(master, b"ANSWER=", transcript, deadline, slow)
        status = child.wait(timeout=max(1, deadline - time.monotonic()))
        read_until(master, b"\n", transcript, deadline)
    finally:
        if child.poll() is None:
            child.kill()
    after = stty(slave)
    os.close(master)
    os.close(slave)
    text = transcript[0].decode("utf-8", "replace")
    failures = []
    if f"ANSWER={expected}" not in text:
        failures.append(f"answer: wanted {expected}; transcript {text[-300:]!r}")
    if status != code:
        failures.append(f"exit code: wanted {code}, got {status}")
    if before != after:
        failures.append(f"terminal settings changed after exit: {before} -> {after}")
    if f"STTY={before}" not in text:
        failures.append("terminal settings were not restored when the menu returned")
    if "\x1b[?25l" not in text or text.rfind("\x1b[?25h") < text.rfind("\x1b[?25l"):
        failures.append("cursor was not shown again after it was hidden")
    if "\x1b[?2004h" in text and text.rfind("\x1b[?2004l") < text.rfind("\x1b[?2004h"):
        failures.append("bracketed paste was left on")
    if "\x1b[?2004h" not in text:
        failures.append("bracketed paste was not turned on while the question was open")
    menu = ESCAPES.sub("", text.split("STTY=")[0]).replace("\r", "\n")
    if o.get("hint") and "Press s to start, or q to leave." not in menu:
        failures.append("the key that does not start did not say how to start")
    if o.get("start") and columns == 80:
        if "◖ › 1 Balanced (selected) ◗" not in menu or "◖ • 2 Best ◗" not in menu:
            failures.append("the first frame lost the rounded quality choices or their markers")
        if "\x1b[48;2;164;220;202;" not in text:
            failures.append("the selected quality lost its mint fill")
        if expected == "start:best" and "◖ › 2 Best (selected) ◗" not in menu:
            failures.append("selecting Best did not move the active pill")
    if not o.get("start"):
        if "› First (recommended)" not in menu or "• Second" not in menu or "• Third" not in menu:
            failures.append("the first frame did not mark its selected action and idle choices")
        if expected == "second" and ("• First (recommended)" not in menu or "› Second" not in menu):
            failures.append("the recommendation moved with the cursor")
        if columns == 80 and DETAIL not in menu:
            failures.append("the detail was left out although it fits")
    if columns < 80 and not o.get("start"):
        if DETAIL in menu or "a detail" in menu:
            failures.append("a detail that does not fit was printed or cut")
        wide = [line for line in menu.split("\n") if len(line) > columns]
        if wide:
            failures.append(f"lines wider than {columns}: {wide}")
    set_aside = o.get("ahead") or o.get("pasted") or (o.get("held") and not o.get("start"))
    if set_aside and TYPED_AHEAD not in ESCAPES.sub("", text):
        failures.append("keys typed ahead were not said to be ignored")
    if not set_aside and not o.get("held") and TYPED_AHEAD in text:
        failures.append("the type-ahead note appeared although nothing was typed ahead")
    interrupted = text.count("Interrupted.")
    if interrupted != (1 if expected == "interrupt" else 0):
        failures.append(f"interrupt line printed {interrupted} times")
    print(f"{'ok' if not failures else 'FAIL'}  {name}")
    for failure in failures:
        print(f"      {failure}")
    return not failures


def main():
    work = Path(tempfile.mkdtemp(prefix="hindsight-menu-"))
    try:
        (work / "hooks.mjs").write_text(HOOKS)
        (work / "register.mjs").write_text(REGISTER)
        (work / "demo.mjs").write_text(DEMO)
        results = [run_case(work, *case) for case in CASES]
    finally:
        shutil.rmtree(work, ignore_errors=True)
    if not all(results):
        sys.exit(1)
    print(
        "menu smoke: terminal settings identical before and after every case; keys typed "
        "ahead, pastes, and a held Enter never answered; s after waiting started at once"
    )


main()
