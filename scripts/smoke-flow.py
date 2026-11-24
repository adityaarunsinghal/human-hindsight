"""Drive the real CLI in a PTY; no private stores or paid model calls."""
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
    fake.write_text(
        "#!/bin/sh\n"
        f"MARKER='{marker}'\n"
        'case "$1" in\n'
        "  --help|--claude-help)\n"
        "    printf '%s\\n' '--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config --mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence'\n"
        "    exit 0 ;;\n"
        # Local metadata probes only. Anything else would be a model call.
        # HINDSIGHT_SLOW_PROBE holds the version back, like a cold start.
        "  --version)\n"
        '    [ -n "$HINDSIGHT_SLOW_PROBE" ] && sleep 4\n'
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

    # A second world for the runs that make model calls: a fake claude that
    # answers each stage with schema-valid JSON, logs every call, records its
    # process id, and holds a call whose prompt names SLOW-SESSION. Fake
    # `open` and `xdg-open` record what they were asked to open.
    model_dir = root / "model-bin"
    model_dir.mkdir()
    calls_log = model_dir / "calls.log"
    opened_log = model_dir / "opened.log"
    pids_dir = model_dir / "pids"
    pids_dir.mkdir()
    for opener in ["open", "xdg-open"]:
        (model_dir / opener).write_text(f"#!/bin/sh\necho \"$*\" >> '{opened_log}'\nexit 0\n")
        (model_dir / opener).chmod(0o755)
    (model_dir / "claude").write_text("#!" + shutil.which("node") + "\n" + r"""
const fs = require("node:fs");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const args = process.argv.slice(2);
fs.writeFileSync(path.join(dir, "pids", String(process.pid)), "");
const log = (kind) => fs.appendFileSync(path.join(dir, "calls.log"), kind + "\n");
if (args[0] === "--help") { console.log("--output-format --json-schema --tools --safe-mode --system-prompt --strict-mcp-config --mcp-config --settings --disable-slash-commands --no-chrome --no-session-persistence --model"); process.exit(0); }
if (args[0] === "--version") { console.log("9.9.9 (Claude Code)"); process.exit(0); }
if (args[0] === "auth") { console.log("Logged in"); process.exit(0); }
const schema = JSON.parse(args[args.indexOf("--json-schema") + 1] || "{}");
const p = schema.properties || {};
const prompt = fs.readFileSync(0, "utf8");
const json = prompt.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{") && l.endsWith("}"))
  .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const emit = (kind, value) => {
  log(kind);
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: value }));
  process.exit(0);
};
const answer = () => {
  if (p.ok) emit("check", { ok: true });
  if (p.goal) {
    const messages = json.filter((row) => row.message_id && row.text.includes("keep the change small")).slice(0, 2);
    const preferences = messages.length === 2 ? [{
      text: "Prefer small release changes.", evidence: "The session asks twice for small changes.",
      scope: "project", basis: "inferred",
      citations: messages.map((row) => ({ message_id: row.message_id, quote: "keep the change small" })),
    }] : [];
    emit("digest", { goal: "Improve a workflow", deliverable: "A patch", domain: "Software", keywords: ["release"], outcome: "completed", preferences });
  }
  if (p.tasks) {
    const ids = [...prompt.matchAll(/^- id: (.+)$/gm)].map((m) => m[1].trim());
    emit("group", { tasks: [{ slug: "release-workflow", title: "Improve the release workflow", rationale: "One goal.", members: ids }], misc: [] });
  }
  if (p.merges) emit("merge", { merges: [] });
  if (p.oneshot_markdown) {
    const slug = (prompt.match(/\(slug: ([^)]+)\)/) || [])[1];
    emit("write", { slug, title: "Improve the release workflow", confidence: "high", preferences: [], oneshot_markdown: "Improve the release workflow for this project. Keep the change small, explain each material change, and validate it with focused checks before you finish." });
  }
  if (p.lessons && p.set_aside) {
    const inputs = json.filter((j) => j.id && "count" in j);
    emit("summarize", { lessons: inputs.map((x, i) => ({ id: "lesson-" + (i + 1), title: "Keep changes small", instruction: "Keep each change small and explain every material change.", applies_when: "Any change.", exceptions: "", disposition: "generalized", source_ids: [x.id] })), set_aside: [] });
  }
  if (p.roles && p.shared) {
    const cards = json.filter((j) => j.id && "sources" in j).map((j) => j.id);
    emit("propose", { roles: [
      { name: "change-reviewer", display_name: "Change reviewer", description: "Reviews a finished change.", delegate_when: "A change is ready.", not_for: "New features.", lesson_ids: cards },
      { name: "test-runner", display_name: "Test runner", description: "Runs focused tests.", delegate_when: "Tests need running.", not_for: "Design.", lesson_ids: cards },
    ], shared: [], playbooks: [] });
  }
  if (p.prompt && p.triggers) emit("role", { prompt: ("You are a specialist coding agent. Do only the work you are handed, keep each change small, run the focused tests, and report plainly what changed and what is open. ").repeat(12).slice(0, 2000), triggers: ["review a change", "run tests"] });
  if (p.preferences) emit("merge-preferences", { preferences: [] });
  console.error("fake: unexpected schema " + Object.keys(p).join(","));
  process.exit(1);
};
if (prompt.includes("SLOW-SESSION") && !process.env.HINDSIGHT_FAST) setTimeout(answer, 60000);
else answer();
""")
    (model_dir / "claude").chmod(0o755)
    env = dict(os.environ)
    env.update({
        "PATH": isolated_path(binary_dir),
        # A temporary home folder: no real history or settings are ever read.
        "HOME": str(root / "home"),
        "NO_COLOR": "1",
        "TERM": "dumb",
        "LANG": "en_US.UTF-8",
        # A desktop terminal: on Linux a machine with no display counts as remote.
        "DISPLAY": ":0",
    })
    # The child PTYs simulate a person's terminal, including when this test runs in CI.
    for key in ["CI", "LC_ALL", "LC_CTYPE", "HUMAN_HINDSIGHT_PLAIN", "HUMAN_HINDSIGHT_FOLLOW_UP", "HUMAN_HINDSIGHT_PROJECT", "HUMAN_HINDSIGHT_RUNNER", "HUMAN_HINDSIGHT_MODEL"]:
        env.pop(key, None)
    args = [
        shutil.which("node"), str(cli), "--home", str(root / "library"),
        "--claude-dir", str(root / "claude"), "--source", "claude",
        "--runner", "claude", "--project", "project",
    ]

    def drive(arguments, responses, environment=None, columns=100, rows=40):
        primary, child = pty.openpty()
        # A real window size: without one the menu cannot fit and falls back to numbers.
        fcntl.ioctl(child, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        def controlling_terminal():
            # A session of its own with the pty as its terminal, so Ctrl-C at a
            # line question raises SIGINT as it does in a real terminal.
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)

        process = subprocess.Popen(
            arguments,
            stdin=child,
            stdout=child,
            stderr=child,
            env=environment or env,
            preexec_fn=controlling_terminal,
        )
        os.close(child)
        output = ""
        cursor = 0
        # Each answer waits for its prompt to appear after the previous answer,
        # then for a moment more, as a person reads; reading goes on meanwhile,
        # so the CLI is never left waiting to finish writing the question.
        mark = 0
        due = None
        deadline = time.monotonic() + 25
        try:
            while time.monotonic() < deadline:
                ready, _, _ = select.select([primary], [], [], 0.02)
                if ready:
                    try:
                        data = os.read(primary, 65536)
                    except OSError:
                        data = b""
                    if data:
                        output += data.decode("utf8", errors="replace")
                # A third item "anywhere" also counts a prompt drawn before the last answer.
                since = 0 if cursor < len(responses) and responses[cursor][2:] == ("anywhere",) else mark
                if cursor < len(responses) and due is None and responses[cursor][0] in output[since:]:
                    due = time.monotonic() + 0.1
                if due is not None and time.monotonic() >= due:
                    os.write(primary, responses[cursor][1])
                    cursor += 1
                    mark = len(output)
                    due = None
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

    # A mistyped flag is an error with a suggestion, and nothing runs.
    result = subprocess.run(
        args + ["--plian"], env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20
    )
    assert result.returncode == 1, result.stdout + result.stderr
    assert "Unknown option --plian. Did you mean --plain?" in result.stderr, result.stderr
    assert result.stdout == "", result.stdout
    assert not (root / "library").exists(), "An unknown flag must run nothing."

    def quiet(arguments, **extra):
        return subprocess.run(
            arguments, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20, **extra
        )

    # The bare command takes the home screen's own options: the summary and
    # the next command, no question, nothing written.
    for flag in ["--dry-run", "--yes", "--no-follow-up"]:
        result = quiet(args + [flag])
        assert result.returncode == 0, flag + result.stdout + result.stderr
        assert "Your history" in result.stdout, result.stdout
        assert "next:" in result.stdout and "Choose [" not in result.stdout, result.stdout
        assert not (root / "library").exists(), flag + " must write nothing."

    # A reflection option on the bare command points at reflect; a word that
    # resembles no command gets no guess.
    result = quiet(args + ["--fresh"])
    assert result.returncode == 1, result.stderr
    assert "That option belongs to reflect: npx human-hindsight reflect --fresh" in result.stderr, result.stderr
    result = quiet([shutil.which("node"), str(cli), "frobnicate"])
    assert result.returncode == 1 and "Did you mean" not in result.stderr, result.stderr
    assert "See `npx human-hindsight --help`" in result.stderr, result.stderr

    # A small synthetic library: list shows whole names at 60 columns, show
    # suggests the closest name, and preferences writes only its block to stdout.
    library_home = root / "library-home"
    slug = "release-notes-workflow-for-the-team"
    entry = library_home / "library" / slug
    entry.mkdir(parents=True)
    (entry / f"{slug}.oneshot.md").write_text("# Release notes\n\nWrite the release notes in plain words.\n")
    (entry / "sources.json").write_text(json.dumps({
        "slug": slug, "title": "Write the release notes for the team in plain words",
        "members": ["a.md"], "sessionIds": ["s"],
        "preferences": [{"text": "Keep each change small.", "evidence": "Keep the change small."}],
        "outcome_summary": "1 completed", "domains": ["writing"], "confidence": "high",
        "authored_at": "2026-10-22T12:00:00.000Z", "model": None, "prompt_version": 1,
        "tool_version": "0.0.0", "generation": "g1",
    }))
    library_args = [shutil.which("node"), str(cli), "--home", str(library_home)]
    code, output = drive(library_args[:2] + ["list"] + library_args[2:] + ["--no-follow-up"], [], dict(env, TERM="xterm-256color"), columns=60)
    assert code == 0 and slug in output, output
    assert "Name" in output and "Slug" not in output, output
    result = quiet(library_args[:2] + ["show", "release-notes"] + library_args[2:])
    assert result.returncode == 1 and f"Did you mean {slug}?" in result.stderr, result.stderr
    with open(root / "CLAUDE.md", "w") as handle:
        result = subprocess.run(
            library_args[:2] + ["preferences", "--include-unreviewed"] + library_args[2:],
            env=env, stdin=subprocess.DEVNULL, stdout=handle, stderr=subprocess.PIPE, text=True, timeout=20,
        )
    written = (root / "CLAUDE.md").read_text()
    assert result.returncode == 0, result.stderr
    assert written.startswith("<!-- human-hindsight preferences"), written
    assert "- Keep each change small." in written and "next:" not in written, written
    assert "next:" in result.stderr, result.stderr
    result = quiet(library_args[:2] + ["preferences"] + library_args[2:])
    assert result.stdout == "", result.stdout
    assert "waiting for your review" in result.stderr and "--include-unreviewed" in result.stderr, result.stderr

    # Ctrl-C at a follow-up question exits 130 after one line.
    code, output = drive(
        library_args[:2] + ["list"] + library_args[2:], [("[y/N]", b"\x03")], dict(env, TERM="xterm-256color")
    )
    assert code == 130 and output.count("Interrupted.") == 1, output

    # The single-key menu: a digit pressed while slower facts are still being
    # checked selects the item that was on screen, and nothing waits for them.
    keys_env = dict(env, TERM="xterm-256color", HINDSIGHT_SLOW_PROBE="1")
    key_args = [a if a != str(root / "library") else str(root / "keys-home") for a in args]
    started = time.monotonic()
    code, output = drive(key_args, [("Enter to choose", b"4")], keys_env)
    elapsed = time.monotonic() - started
    assert code == 0, output
    assert "counting" in output, output
    assert "• Show projects" in output and "› Show projects" in output, output
    assert "Found Claude Code (1 project, 1 session)" in output, output
    assert elapsed < 4, f"The menu waited for a slow probe ({elapsed:.1f}s):\n{output}"
    assert not (root / "keys-home" / "exports").exists(), output

    # Ctrl-C at the menu prints one line and exits with 130.
    code, output = drive(key_args, [("Enter to choose", b"\x03")], keys_env)
    assert code == 130, output
    assert output.count("Interrupted.") == 1, output

    # The bare command opens the home screen. TERM=dumb gives the numbered menu.
    # Choosing "Reflect on my history" exports, then shows the reflection plan.
    code, output = drive(args, [
        ("Choose [1]:", b"1\n"),
        # The Start question's own prompt, after the plan and its choices:
        # a y or an empty line does not start; q leaves.
        ("Choose [1/2/3/s/q]:", b"y\n"),
        ("Press s to start, or q to leave.", b"\n"),
        ("Press s to start, or q to leave.", b"q\n"),
    ])
    assert "s  Start reflection" in output, output
    assert code == 2, output
    assert "Your history" in output, output
    assert "Reflect on my history (recommended)" in output, output
    assert "Claude Code (claude 9.9.9)" in output and "session reads" in output, output
    manifest = root / "library/exports/manifest.json"
    assert manifest.exists() and len(json.loads(manifest.read_text())) == 1, output
    assert not marker.exists(), "The runner was invoked before model consent."
    code, output = drive(args + ["--no-follow-up"], [])
    assert code == 0 and "Choose [" not in output and "Start with" not in output, output
    assert "next:" in output, output

    # Keys typed ahead never answer a question. The audit's case: Enter on the
    # home menu, then one more Enter while the CLIs are being checked, before
    # any plan exists. The plan waits; only q, pressed after it appears, answers.
    typed_ahead = "Ignored keys typed ahead. Choose when you are ready."
    ahead_args = [a if a != str(root / "library") else str(root / "ahead-home") for a in args]
    # Whether the second Enter lands just before the plan is drawn or just
    # after, it does not start: it is set aside, or it gets the hint; then
    # the person declines.
    code, output = drive(ahead_args, [
        ("Enter to choose", b"\r"),
        ("Checking available coding CLIs…", b"\r"),
        ("Not now", b"q", "anywhere"),
    ], dict(env, TERM="xterm-256color"))
    assert code == 2, output
    assert "s  Start reflection" in output, output
    assert typed_ahead in output or "Press s to start" in output, output
    assert not marker.exists(), "An Enter typed before the plan appeared approved it."

    # Enter held down from the home menu: the terminal repeats it every 30 ms
    # through export, the CLI check, and the plan. Nothing is sent.
    held_args = [a if a != str(root / "library") else str(root / "held-home") for a in args]
    primary, child = pty.openpty()
    fcntl.ioctl(child, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
    process = subprocess.Popen(
        held_args, stdin=child, stdout=child, stderr=child,
        env=dict(env, TERM="xterm-256color"), start_new_session=True,
    )
    os.close(child)
    # A terminal drops keys while its input queue is full (nothing reads during
    # export); a blocking write would wait forever instead.
    os.set_blocking(primary, False)

    def press(key):
        try:
            os.write(primary, key)
        except BlockingIOError:
            pass

    output, holding, released, plan_at = "", None, None, None
    deadline = time.monotonic() + 25
    try:
        while time.monotonic() < deadline and process.poll() is None:
            ready, _, _ = select.select([primary], [], [], 0.03)
            if ready:
                try:
                    output += os.read(primary, 65536).decode("utf8", errors="replace")
                except BlockingIOError:
                    pass
                except OSError:
                    break
            if holding is None and "Enter to choose" in output:
                holding = time.monotonic()
            # Hold until the plan has been on screen for 1.5 seconds, then let go.
            if holding is not None and released is None:
                press(b"\r")
                if plan_at is None and "Start reflection" in output:
                    plan_at = time.monotonic()
                if plan_at is not None and time.monotonic() - plan_at > 1.5:
                    released = time.monotonic()
            if released is not None and time.monotonic() - released > 0.6:
                press(b"q")
                released = float("inf")
        code = process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(primary)
    assert holding is not None and "Start reflection" in output, output
    assert code == 2, output
    assert typed_ahead in output or "Press s to start" in output, output
    assert not marker.exists(), "A held Enter approved the plan; the fake CLI got a model call."

    # Enter pressed on the home menu and held with a keyboard's usual repeat
    # delay: the first repeat comes 500 ms after the plan is on screen, then
    # one every 40 ms for two seconds. Nothing is sent.
    realistic_args = [a if a != str(root / "library") else str(root / "repeat-home") for a in args]
    primary, child = pty.openpty()
    fcntl.ioctl(child, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 100, 0, 0))
    process = subprocess.Popen(
        realistic_args, stdin=child, stdout=child, stderr=child,
        env=dict(env, TERM="xterm-256color"), start_new_session=True,
    )
    os.close(child)
    os.set_blocking(primary, False)
    output, pressed, menu_at, plan_at, repeats = "", False, None, None, 0
    deadline = time.monotonic() + 25
    try:
        while time.monotonic() < deadline and process.poll() is None:
            ready, _, _ = select.select([primary], [], [], 0.01)
            if ready:
                try:
                    output += os.read(primary, 65536).decode("utf8", errors="replace")
                except BlockingIOError:
                    pass
                except OSError:
                    break
            if menu_at is None and "Enter to choose" in output:
                menu_at = time.monotonic()
            # Pressed once the person has seen the menu, and held from then on.
            if not pressed and menu_at is not None and time.monotonic() - menu_at > 0.2:
                press(b"\r")
                pressed = True
            if plan_at is None and "Start reflection" in output:
                plan_at = time.monotonic()
            if plan_at is not None:
                due = plan_at + 0.5 + repeats * 0.04
                if repeats < 50 and time.monotonic() >= due:
                    press(b"\r")
                    repeats += 1
                elif repeats >= 50 and time.monotonic() > due + 0.3:
                    press(b"q")
                    repeats = float("inf")
        code = process.wait(timeout=5)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(primary)
    assert plan_at is not None and code == 2, output
    assert "Press s to start, or q to leave." in output, output
    assert not marker.exists(), "A held Enter with a 500 ms repeat delay approved the plan."

    # Ctrl-C at the Start question: one line, exit 130, and nothing was sent.
    distill_args = args[:2] + ["distill"] + args[2:]
    xterm = dict(env, TERM="xterm-256color")
    code, output = drive(distill_args, [("Start reflection", b"\x03")], xterm)
    assert code == 130, output
    assert output.count("Interrupted.") == 1, output
    assert not marker.exists(), "Ctrl-C at the Start question must send nothing."

    # A terminal of 12 rows gets the short plan and the command that prints it whole.
    # The Start question's last line is its way out: the question is fully on screen.
    code, output = drive(distill_args, [("Not now", b"q")], xterm, rows=12)
    assert code == 2, output
    plain = " ".join(output.split())
    assert "To see the whole plan first, run:" in plain and "--dry-run" in plain, output
    assert not marker.exists(), "Declining the short plan must send nothing."

    # Two eligible binaries through the release launcher. The second one
    # records only the readiness models and refuses them with a sign-in error.
    choice_dir = root / "choice-bin"
    choice_dir.mkdir()
    (choice_dir / "claude").symlink_to(fake)
    selected_models = root / "selected-models.jsonl"
    (choice_dir / "codex").write_text("#!" + shutil.which("node") + "\n" + r"""
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("codex 9.9.9");
else if (args.includes("--help")) console.log("--json --ephemeral --sandbox --output-schema --output-last-message --skip-git-repo-check --color --model --config");
else if (args[0] === "debug") console.log(JSON.stringify({ models: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-astra"] }));
else if (args[0] === "exec") {
  const input = fs.readFileSync(0, "utf8");
  fs.appendFileSync(process.env.HH_MODEL_TRACE, JSON.stringify({ model: args[args.indexOf("--model") + 1], check: input.includes('{"ok":true}') }) + "\n");
  console.log(JSON.stringify({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Missing bearer or basic authentication in header" } }));
  process.exit(1);
} else process.exit(1);
""")
    (choice_dir / "codex").chmod(0o755)
    picker_env = dict(xterm, PATH=isolated_path(choice_dir), CODEX_HOME=str(root / "codex-config"), HH_MODEL_TRACE=str(selected_models))
    picker = [shutil.which("node"), str(Path("launcher/cli.cjs").resolve()), "reflect", "--home", str(root / "library"), "--no-follow-up"]
    question = "Which coding CLI should run this reflection?"
    code, output = drive(picker, [
        (question, b"s"), ("Choose a coding CLI before pressing s", b"x"),
        ("gpt-5.6-terra for session reads", b"3"), ("gpt-5.6-astra for grouping and writing", b"\r"),
        ("Press s to start, or q to leave.", b"q"),
    ], picker_env)
    # The choice is where the run starts; the plan names the CLI it may move to
    # and the way to keep it on one.
    flat_plan = " ".join(re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", output).split())
    assert code == 2, output
    assert "If Codex stops working, the run moves to Claude Code and says so." in flat_plan, output
    assert "To keep it on Codex only, run with --runner=codex." in flat_plan, output
    assert "This run stays on this CLI" not in output, output
    assert not selected_models.exists() and not marker.exists(), "A choice or Enter invoked a model."

    # Kept on one CLI with --runner: its failure ends the run and no other CLI is asked.
    code, output = drive(
        picker + ["--runner", "codex", "--quality", "best"], [("Start reflection", b"s")], picker_env
    )
    assert code == 1 and "Codex is not signed in" in output, output
    assert "Continuing with" not in output, output
    checks = [json.loads(line) for line in selected_models.read_text().splitlines()]
    assert {check["model"] for check in checks} == {"gpt-5.6-sol", "gpt-5.6-astra"}, checks
    assert all(check["check"] for check in checks) and not marker.exists(), "The run kept on one CLI asked another."

    # Chosen at the plan: when it is not signed in, the run moves to the other
    # ready CLI and says so in one line. Codex saw only the readiness requests.
    selected_models.unlink()
    code, output = drive(picker, [(question, b"x"), ("gpt-5.6-terra for session reads", b"3"),
                                 ("gpt-5.6-astra for grouping and writing", b"s")], picker_env)
    assert output.count("Codex is not signed in. Continuing with Claude Code.") == 1, output
    checks = [json.loads(line) for line in selected_models.read_text().splitlines()]
    assert {check["model"] for check in checks} == {"gpt-5.6-sol", "gpt-5.6-astra"}, checks
    assert all(check["check"] for check in checks), "Codex was sent more than the readiness requests."
    # The stand-in Claude Code refuses every model call, so the run ends there.
    assert code == 1 and marker.exists(), output
    marker.unlink()

    model_env = dict(env, TERM="xterm-256color", PATH=isolated_path(model_dir))

    # suggest-subagents at a terminal ends with its closing menu, and no
    # browser opener runs unless that item is chosen.
    suggest_args = library_args[:2] + ["suggest-subagents"] + library_args[2:] + ["--runner", "claude"]
    code, output = drive(
        suggest_args, [("Start with Balanced", b"s"), ("What next?", b"3")], model_env
    )
    assert code == 0, output
    assert "Open my subagents" in output and "Done for now" in output, output
    assert not opened_log.exists(), "An opener ran although the browser item was not chosen."
    code, output = drive(
        suggest_args,
        [("Start with Balanced", b"s"), ("What next?", b"1"), ("Opened in your browser.", b"\x03")],
        model_env,
    )
    assert opened_log.exists() and len(opened_log.read_text().splitlines()) == 1, output

    # Ctrl-C during a run: exit 130, no fake CLI process is left, and the
    # next run reuses the session reads that finished.
    run_claude = root / "run-claude/projects/-synthetic-run"
    run_claude.mkdir(parents=True)
    for index, words in enumerate(["first", "second", "SLOW-SESSION third"]):
        lines = [
            {
                "type": "user",
                "timestamp": f"2026-10-23T12:0{index}:{step:02d}Z",
                "message": {
                    "role": "user",
                    "content": f"The {words} task, step {step}: improve the release workflow and keep the change small, "
                    "explaining each material change and running the focused tests before finishing.",
                },
            }
            for step in range(6)
        ]
        (run_claude / f"bbbbbbbb-1111-2222-3333-44444444444{index}.jsonl").write_text(
            "".join(json.dumps(line) + "\n" for line in lines)
        )
    run_args = [
        shutil.which("node"), str(cli), "reflect", "--home", str(root / "run-home"),
        "--claude-dir", str(root / "run-claude"), "--source", "claude", "--runner", "claude",
        "--yes", "--no-follow-up",
    ]
    reflection_env = dict(model_env, FORCE_COLOR="1")
    code, output = drive(run_args, [("2/3", b"\x03")], reflection_env)
    assert code == 130, output
    assert output.count("Interrupted.") == 1, output
    assert "\x1b[34mrun\x1b[39m" in output, output
    text = re.sub(r"\x1b\[[0-9;]*m", "", output)
    assert "Reading run" in text, text
    assert text.index("Reading run") < text.index("Improve a workflow"), text
    assert text.index("Preference Prefer small release changes.") < text.index("Interrupted."), text
    assert output.count("Prefer small release changes.") == 2, output
    time.sleep(0.5)
    for pid_file in pids_dir.iterdir():
        try:
            os.kill(int(pid_file.name), 0)
        except ProcessLookupError:
            continue
        raise AssertionError(f"A fake CLI process {pid_file.name} outlived Ctrl-C:\n{output}")
    before = calls_log.read_text().splitlines().count("digest")
    assert before == 2, calls_log.read_text()
    code, output = drive(run_args, [], dict(reflection_env, HINDSIGHT_FAST="1"))
    assert code == 0, output
    assert calls_log.read_text().splitlines().count("digest") == before + 1, calls_log.read_text()
    assert re.search(r"Reused +run", re.sub(r"\x1b\[[0-9;]*m", "", output)), output
    assert "reused from saved work" in output, output
    # Suggest subagents from the first screen of a fresh data home: one run
    # exports, shows one plan that names the roles step, reads and summarizes,
    # writes no prompts, and goes on to the roles without a second approval.
    scratch_claude = root / "scratch-claude/projects/-synthetic-scratch"
    scratch_claude.mkdir(parents=True)
    (scratch_claude / "cccccccc-1111-2222-3333-444444444440.jsonl").write_text(
        "".join(
            json.dumps({
                "type": "user",
                "timestamp": f"2026-10-24T09:00:{step:02d}Z",
                "message": {
                    "role": "user",
                    "content": f"Step {step}: improve the release workflow and keep the change small, "
                    "explaining each material change and running the focused tests before finishing.",
                },
            }) + "\n"
            for step in range(6)
        )
    )
    scratch_args = [
        shutil.which("node"), str(cli), "--home", str(root / "scratch-home"),
        "--claude-dir", str(root / "scratch-claude"), "--source", "claude",
    ]
    calls_before = len(calls_log.read_text().splitlines()) if calls_log.exists() else 0
    code, output = drive(scratch_args, [
        ("Enter to choose", b"2"),
        # Fast is the first plan; s starts it.
        ("Start reflection", b"1"),
        ("sonnet for every step", b"s"),
        ("What next?", b"3"),
    ], model_env)
    assert code == 0, output
    assert "Suggest subagents  reads my sessions, then proposes roles" in output, output
    assert "No prompts are written in this run." in output, output
    assert "Then choose and write subagent roles" in output, output
    assert "Suggesting subagents, as approved with the plan above." in output, output
    assert "Open my subagents" in output, output
    scratch_calls = calls_log.read_text().splitlines()[calls_before:]
    for kind in ["digest", "summarize", "propose", "role"]:
        assert kind in scratch_calls, (kind, scratch_calls)
    assert "group" not in scratch_calls and "write" not in scratch_calls, scratch_calls
    assert (root / "scratch-home/exports/manifest.json").exists(), output
    assert (root / "scratch-home/library/subagents").is_dir(), output
    assert not any(
        entry.name.endswith(".oneshot.md") for entry in (root / "scratch-home/library").rglob("*")
    ), "A prompt was written in a run for subagents only."

    print(
        "PTY workflow passed: an Enter typed before the plan and a held Enter both sent "
        "nothing; unknown flag refused; the bare command's own options; a reflection "
        "option pointed at reflect; no guess for an unrelated word; whole names in list at 60 "
        "columns; show suggests a name; preferences writes only its block to a redirect; Ctrl-C "
        "130 at a follow-up and at the menu; a digit pressed during the refresh picked the item "
        "on screen; home screen, export, reflection plan; model consent declined; no model calls; "
        "opt-out respected; Ctrl-C at the Start question; the short plan at 12 rows; the subagents "
        "closing menu runs an opener only when chosen; Ctrl-C mid-run leaves no process and the "
        "rerun reuses finished reads; Suggest subagents from a fresh home makes its reads and "
        "summaries, writes no prompts, and reaches the roles on one approval."
    )
finally:
    shutil.rmtree(root)
