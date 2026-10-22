"""Drive the real CLI in a PTY; no private stores or paid model calls."""
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import tempfile
import time

root = Path(tempfile.mkdtemp(prefix="hindsight-flow-"))
cli = Path("dist/cli.js").resolve()
try:
    transcript = root / "claude/projects/-synthetic-project/aaaaaaaa-1111-2222-3333-444444444444.jsonl"
    transcript.parent.mkdir(parents=True)
    records = [
        {
            "type": "user",
            "timestamp": f"2026-10-22T12:00:{index:02d}Z",
            "message": {
                "role": "user",
                "content": f"Step {index}: improve the deployment workflow with clear release notes and focused validation. "
                "Preserve existing user libraries, explain each material change, and keep the implementation small.",
            },
        }
        for index in range(10)
    ]
    transcript.write_text("".join(json.dumps(record) + "\n" for record in records))
    binary_dir = root / "bin"
    binary_dir.mkdir()
    marker = root / "unexpected-model-call"
    fake = binary_dir / "claude"
    fake.write_text(f"#!/bin/sh\n: > '{marker}'\nexit 99\n")
    fake.chmod(0o755)
    env = dict(os.environ)
    env.update({
        "PATH": str(binary_dir) + os.pathsep + env.get("PATH", ""),
        "NO_COLOR": "1",
        "TERM": "dumb",
    })
    for key in ["HUMAN_HINDSIGHT_FOLLOW_UP", "HUMAN_HINDSIGHT_PROJECT", "HUMAN_HINDSIGHT_RUNNER", "HUMAN_HINDSIGHT_MODEL"]:
        env.pop(key, None)
    args = [
        shutil.which("node"), str(cli), "--home", str(root / "library"),
        "--claude-dir", str(root / "claude"), "--source", "claude",
        "--runner", "claude", "--project", "project",
    ]

    def drive(arguments, responses):
        primary, child = pty.openpty()
        process = subprocess.Popen(arguments, stdin=child, stdout=child, stderr=child, env=env)
        os.close(child)
        output = ""
        cursor = 0
        deadline = time.monotonic() + 25
        try:
            while time.monotonic() < deadline:
                ready, _, _ = select.select([primary], [], [], 0.1)
                if ready:
                    try:
                        data = os.read(primary, 65536)
                    except OSError:
                        data = b""
                    if data:
                        output += data.decode("utf8", errors="replace")
                if cursor < len(responses) and responses[cursor][0] in output:
                    os.write(primary, responses[cursor][1])
                    cursor += 1
                if process.poll() is not None:
                    break
            else:
                raise AssertionError("CLI workflow timed out:\n" + output)
            assert cursor == len(responses), output
            return process.wait(timeout=2), output
        finally:
            if process.poll() is None:
                process.kill()
                process.wait()
            os.close(primary)

    code, output = drive(args, [
        ("Run export now?", b"y\n"),
        ("Run distill now?", b"y\n"),
        ("Proceed? [y/N]", b"n\n"),
    ])
    assert code == 2, output
    assert "claude" in output and "session digests" in output, output
    manifest = root / "library/exports/manifest.json"
    assert manifest.exists() and len(json.loads(manifest.read_text())) == 1, output
    assert not marker.exists(), "The runner was invoked before model consent."
    code, output = drive(args + ["--no-follow-up"], [])
    assert code == 0 and "Run export now?" not in output, output
    print("PTY workflow passed: scan → export → distill plan; model consent declined; no model calls; opt-out respected.")
finally:
    shutil.rmtree(root)
