"""Check the real CLI's progress and privacy copy in a PTY, using only synthetic history."""
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import time


def capture_tty(arguments, environment, columns=80, stdin_null=False):
    """Run with stdout and stderr on a terminal. stdin is the terminal too, or /dev/null."""
    primary, child = pty.openpty()
    fcntl.ioctl(child, termios.TIOCSWINSZ, struct.pack("HHHH", 30, columns, 0, 0))
    stdin = subprocess.DEVNULL if stdin_null else child
    process = subprocess.Popen(
        arguments, stdin=stdin, stdout=child, stderr=child, env=environment
    )
    os.close(child)
    chunks = []
    deadline = time.monotonic() + 20
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([primary], [], [], 0.1)
            if ready:
                try:
                    data = os.read(primary, 65536)
                except OSError:
                    break
                if not data:
                    break
                chunks.append(data)
            elif process.poll() is not None:
                break
        else:
            raise AssertionError("Timed out waiting for the synthetic terminal command.")
        return process.wait(timeout=2), b"".join(chunks).decode("utf8", errors="replace")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(primary)


def first_frame_ms(arguments, environment, marker, runs=5):
    """Median milliseconds from spawn until `marker` is on a 100x40 terminal, then quit with q."""
    times = []
    for _ in range(runs):
        primary, child = pty.openpty()
        fcntl.ioctl(child, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
        started = time.monotonic()
        process = subprocess.Popen(
            arguments, stdin=child, stdout=child, stderr=child, env=environment
        )
        os.close(child)
        seen = b""
        elapsed = None
        try:
            while elapsed is None and time.monotonic() - started < 20:
                ready, _, _ = select.select([primary], [], [], 0.005)
                if ready:
                    seen += os.read(primary, 65536)
                    if marker in seen:
                        elapsed = (time.monotonic() - started) * 1000
            assert elapsed is not None, seen.decode("utf8", errors="replace")
            # Quit once the menu is whole on screen: a key that arrives while the
            # question is still being written is typed ahead, and is thrown away.
            menu_end = time.monotonic() + 10
            while b"Use arrow keys and Enter" not in seen and b"Choose [" not in seen:
                assert time.monotonic() < menu_end, seen.decode("utf8", errors="replace")
                if select.select([primary], [], [], 0.02)[0]:
                    seen += os.read(primary, 65536)
            pause = time.monotonic() + 0.1
            while time.monotonic() < pause:
                if select.select([primary], [], [], 0.02)[0]:
                    seen += os.read(primary, 65536)
            os.write(primary, b"q" if b"Use arrow keys" in seen else b"q\n")
            # Keep reading: a full terminal buffer would block the last frame.
            deadline = time.monotonic() + 10
            while process.poll() is None and time.monotonic() < deadline:
                ready, _, _ = select.select([primary], [], [], 0.05)
                if ready:
                    try:
                        seen += os.read(primary, 65536)
                    except OSError:
                        pass
            assert process.wait(timeout=1) == 0, seen.decode("utf8", errors="replace")
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(primary)
        times.append(elapsed)
    return sorted(times)[len(times) // 2]


ESCAPES = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)")


def strip(text):
    """The text a person reads: escapes removed, carriage returns as line ends."""
    return ESCAPES.sub("", text).replace("\r\n", "\n").replace("\r", "\n")


def home_screen(arguments, environment, columns, rows):
    """The bare command on a `columns` x `rows` terminal until its menu is up, then q."""
    primary, child = pty.openpty()
    fcntl.ioctl(child, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    process = subprocess.Popen(arguments, stdin=child, stdout=child, stderr=child, env=environment)
    os.close(child)
    seen = b""
    try:
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and process.poll() is None:
            ready, _, _ = select.select([primary], [], [], 0.05)
            if ready:
                seen += os.read(primary, 65536)
            text = strip(seen.decode("utf8", errors="replace"))
            if "Use arrow keys and Enter" in text or "Choose [" in text:
                time.sleep(0.5)
                while select.select([primary], [], [], 0.1)[0]:
                    seen += os.read(primary, 65536)
                os.write(primary, b"q" if "Use arrow keys" in text else b"q\n")
                break
        deadline = time.monotonic() + 10
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([primary], [], [], 0.05)[0]:
                try:
                    seen += os.read(primary, 65536)
                except OSError:
                    break
        return process.wait(timeout=2), strip(seen.decode("utf8", errors="replace"))
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(primary)


def isolated_path(binary_dir):
    """The fake command first, then system folders that hold no coding CLI.

    The home screen probes every coding CLI it finds, so the inherited PATH
    must never reach a real one.
    """
    agents = ["claude", "codex", "kiro-cli", "opencode"]
    system = [
        folder
        for folder in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        if not any((Path(folder) / name).exists() for name in agents)
    ]
    return os.pathsep.join([str(binary_dir)] + system)


root = Path(tempfile.mkdtemp(prefix="hindsight-terminal-"))
cli = Path("dist/cli.js").resolve()
try:
    transcript = root / "claude/projects/-synthetic-project/aaaaaaaa-1111-2222-3333-444444444444.jsonl"
    transcript.parent.mkdir(parents=True)
    transcript.write_text(
        "".join(
            json.dumps(
                {
                    "type": "user",
                    "timestamp": f"2026-11-01T12:00:{index:02d}Z",
                    "message": {
                        "role": "user",
                        "content": "Improve the form labels, keep existing behavior, and test keyboard navigation.",
                    },
                }
            )
            + "\n"
            for index in range(4)
        )
    )
    binary_dir = root / "bin"
    binary_dir.mkdir()
    marker = root / "unexpected-model-call"
    fake = binary_dir / "claude"
    fake.write_text(
        "#!/bin/sh\n"
        f"MARKER='{marker}'\n"
        'case "$1" in\n'
        "  --help|--claude-help)\n"
        "    printf '%s\\n' '--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config --mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence'\n"
        "    exit 0 ;;\n"
        # Local metadata probes only. Anything else would be a model call.
        "  --version)\n"
        "    printf '%s\\n' '9.9.9 (Claude Code)'\n"
        "    exit 0 ;;\n"
        "  auth)\n"
        '    [ "$2" = status ] || { : > "$MARKER"; exit 99; }\n'
        "    printf '%s\\n' 'Logged in'\n"
        "    exit 0 ;;\n"
        "esac\n"
        f": > '{marker}'\nexit 99\n"
    )
    fake.chmod(0o755)
    environment = dict(os.environ)
    # The child PTYs simulate a person's terminal, including when this test runs in CI.
    for key in [
        "CI",
        "HUMAN_HINDSIGHT_PLAIN",
        "NO_COLOR",
        "FORCE_COLOR",
        "HUMAN_HINDSIGHT_FOLLOW_UP",
        "HUMAN_HINDSIGHT_PROJECT",
        "HUMAN_HINDSIGHT_RUNNER",
        "HUMAN_HINDSIGHT_MODEL",
    ]:
        environment.pop(key, None)
    environment.update(
        {
            "PATH": isolated_path(binary_dir),
            # A temporary home folder: no real history or settings are ever read.
            "HOME": str(root / "home"),
            "TERM": "xterm-256color",
            "FORCE_COLOR": "1",
        }
    )
    common = [
        "--home", str(root / "library"),
        "--source", "claude",
        "--claude-dir", str(root / "claude"),
        "--no-follow-up",
    ]
    executable = [shutil.which("node"), str(cli)]
    code, output = capture_tty(executable + ["export"] + common, environment)
    assert code == 0, output
    assert output.index("fully open source") < output.index("Discovering session history"), output
    assert output.index("Discovering session history") < output.index("Exported 1 session with"), output
    assert "\x1b]8;;https://github.com/adityaarunsinghal/human-hindsight" in output, output
    assert "\x1b[35m" in output and "\x1b[36m" in output, output
    assert re.search(r"\d+\.\ds", output), output
    assert "\x1b[2K" not in output[output.index("Exported 1 session with"):], output
    # The open-source notice wraps at word boundaries inside an 80-column terminal.
    notice = strip(output[: output.index("Discovering session history")])
    assert all(len(line) <= 80 for line in notice.splitlines()), notice
    assert "https://github.com/adityaarunsinghal/human-hindsight" in notice, notice

    code, output = capture_tty(
        executable + ["distill", "--dry-run", "--runner", "claude"] + common, environment
    )
    assert code == 0, output
    assert "fully open source" in output and "configured provider" in output, output
    assert "Reading exported sessions" in output, output
    assert "Finding ready CLIs and their models" in output, output
    assert not marker.exists(), "A model command ran during dry-run."

    # A terminal with stdin from /dev/null still shows live progress.
    code, output = capture_tty(executable + ["export"] + common, environment, stdin_null=True)
    assert code == 0, output
    assert "Discovering session history" in output, output
    assert "\x1b[2K" in output, "Progress must not depend on stdin being a terminal."
    assert "\x1b[35m" in output, "Color must not depend on stdin being a terminal."

    plain_environment = dict(environment)
    plain_environment.pop("FORCE_COLOR", None)
    plain_environment["NO_COLOR"] = "1"
    code, output = capture_tty(
        executable + ["export"] + common, plain_environment, columns=32
    )
    assert code == 0, output
    assert not re.search(r"\x1b\[[0-9;]*m", output), output
    assert "\x1b[2K" in output, "NO_COLOR should keep useful progress while disabling colors."

    result = subprocess.run(
        executable + ["export"] + common,
        env=plain_environment,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "\x1b" not in result.stdout, result.stdout
    assert "https://github.com/adityaarunsinghal/human-hindsight" in result.stdout
    assert not marker.exists(), "The terminal smoke check invoked a model."

    # The bare command paints its table and menu at once: the target is 100 ms
    # on a developer machine. The bound here is loose so a busy runner passes.
    bare = executable + common[:-1]
    first = first_frame_ms(bare, plain_environment, b"What would you like to do?")
    assert first < 1500, f"First frame took {first:.0f} ms"
    assert not marker.exists(), "The home screen invoked a model."
    print(f"Home screen first frame: {first:.0f} ms (median of 5).")

    # A default 80x24 window holds the title and the live single-key menu, and
    # no row is wider than the window. At 12 rows the numbered menu still works.
    code, screen = home_screen(bare, plain_environment, 80, 24)
    assert code == 0, screen
    assert "Human Hindsight" in screen and "Use arrow keys and Enter" in screen, screen
    assert "Choose [" not in screen, screen
    assert all(len(line) <= 80 for line in screen.splitlines()), screen
    code, screen = home_screen(bare, plain_environment, 80, 12)
    assert code == 0 and "Choose [1]:" in screen, screen
    assert not marker.exists(), "The home screen invoked a model."
    print(
        "Terminal smoke passed: early linked privacy copy wrapped to the window, immediate colored progress "
        "(also with stdin from /dev/null), "
        "distill dry-run, NO_COLOR, clean piped output, and the home screen on one 80x24 window "
        "(numbered menu at 12 rows); no model calls."
    )
finally:
    shutil.rmtree(root)
