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


def capture_tty(arguments, environment, columns=80):
    primary, child = pty.openpty()
    fcntl.ioctl(child, termios.TIOCSWINSZ, struct.pack("HHHH", 30, columns, 0, 0))
    process = subprocess.Popen(
        arguments, stdin=child, stdout=child, stderr=child, env=environment
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
        'case "$1" in\n'
        "  --help|--claude-help)\n"
        "    printf '%s\\n' '--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config --mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence'\n"
        "    exit 0 ;;\n"
        "esac\n"
        f": > '{marker}'\nexit 99\n"
    )
    fake.chmod(0o755)
    environment = dict(os.environ)
    for key in [
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
            "PATH": str(binary_dir) + os.pathsep + environment.get("PATH", ""),
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
    assert output.index("Discovering session history") < output.index("exported 1 sessions"), output
    assert "\x1b]8;;https://github.com/adityaarunsinghal/human-hindsight" in output, output
    assert "\x1b[35m" in output and "\x1b[36m" in output, output
    assert re.search(r"\d+\.\ds", output), output
    assert "\x1b[2K" not in output[output.index("exported 1 sessions"):], output

    code, output = capture_tty(
        executable + ["distill", "--dry-run", "--runner", "claude"] + common, environment
    )
    assert code == 0, output
    assert "fully open source" in output and "configured provider" in output, output
    assert "Reading exported sessions" in output, output
    assert "Finding your coding harness" in output, output
    assert not marker.exists(), "A model command ran during dry-run."

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
    print(
        "Terminal smoke passed: early linked privacy copy, immediate colored progress, "
        "distill dry-run, NO_COLOR, and clean piped output; no model calls."
    )
finally:
    shutil.rmtree(root)
