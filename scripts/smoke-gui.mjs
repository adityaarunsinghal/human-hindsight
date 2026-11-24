/**
 * scripts/smoke-gui.mjs: the GUI in a real Chrome, through the built CLI.
 *
 * Run after `npm run build`: `node scripts/smoke-gui.mjs` (GUI_HEADED=1 shows
 * the window). Two synthetic homes, each served by `dist/cli.js gui --no-open`:
 *   - "legacy": prompts and preference candidates written as plain files, no
 *     suggestion. Covers the reader, Markdown safety, copy, review, search,
 *     domain filters, consolidation, and the dropdown layout at 360px.
 *   - "guided": the test kit's sample home (test/support/home.ts, bundled here
 *     with tsdown) with verified quotations, a saved suggestion, and saved
 *     working agreements. Covers the landing tab, each guided overview, the
 *     agreement drill-down, stale labels, and the export zip.
 * Both themes are captured at three widths. Every request the page sends is
 * recorded through the DevTools protocol: each /api request must carry the
 * session key in its header, and no request address may contain it.
 * Screenshots and logs go to the printed artifacts folder.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";

const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cch-gui-browser-"));
const pictures = path.join(scratch, "screenshots");
const downloads = path.join(scratch, "downloads");
fs.mkdirSync(pictures);
fs.mkdirSync(downloads);
console.log(`GUI artifacts: ${pictures}`);
const home = path.join(scratch, "hindsight");
const longDomain = "Platform infrastructure, release engineering, and developer productivity";
const sharedPreference = "Preserve **existing behavior** and use `focused tests`.";
const unsafePreference =
  "<script>window.__preferenceInjected = true</script>\n\n![tracker](https://tracking.example/preference.png)\n\n[unsafe](javascript:alert(1))";
const observed = {
  "settings-page": [
    {
      text: sharedPreference,
      evidence: "Please **keep every existing option** and check keyboard navigation.",
    },
    {
      text: "Verify long labels on narrow screens.",
      evidence: "Keep the arrow clear of the label.",
    },
  ],
  "release-guide": [
    { text: sharedPreference, evidence: "Keep the release flow compatible." },
    {
      text: "Write concise documentation.",
      evidence: "Use direct instructions for new maintainers.",
    },
  ],
  "users-pagination": [
    { text: "Cover empty results and the last page.", evidence: "Validate endpoint edge cases." },
  ],
  "literal-markup": [
    {
      text: unsafePreference,
      evidence:
        "<script>window.__evidenceInjected = true</script>\n\n![evidence](https://tracking.example/evidence.png)",
    },
  ],
};
const samples = [
  [
    "settings-page",
    "Make the settings page easier to use",
    "Frontend design",
    "I want to simplify the settings page while keeping every existing option.\n\nGroup related settings, make the labels clear, and keep the layout easy to scan on a small screen. Match the existing visual style.\n\nCheck keyboard navigation and make sure longer labels have enough room.",
    "2026-10-21T10:00:00Z",
  ],
  [
    "release-guide",
    "Write a clear release guide",
    longDomain,
    "Write a short release guide that a new maintainer can follow.\n\n- Explain what must pass before a release.\n- Document the version and tag conventions.\n- Show how to verify the package after CI publishes it.\n\nKeep the instructions practical and use the commands already in this repository.",
    "2026-10-20T10:00:00Z",
  ],
  [
    "users-pagination",
    "Add pagination to the users endpoint",
    "Software engineering > Backend > APIs > Pagination > Cursor",
    "Add pagination to the users endpoint. Keep the existing response contract compatible, include sensible defaults, and explain how callers request the next page.\n\nCover empty results and the last page with focused tests.",
    "2026-10-19T10:00:00Z",
  ],
  [
    "literal-markup",
    "Keep literal markup safe",
    "Frontend design",
    '<script>window.__injected = true</script>\n<img src="https://unrelated.example/image">\nThese are literal prompt contents, never executable HTML.',
    "2026-10-18T10:00:00Z",
  ],
];
for (const [slug, title, domain, body, authored_at] of samples) {
  const dir = path.join(home, "library", slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "sources.json"),
    JSON.stringify({
      slug,
      title,
      domains: [domain, domain.toLowerCase()],
      authored_at,
      confidence: "high",
      members: ["one.md", "two.md"],
      rating: slug === "settings-page" ? "up" : null,
      preferences: observed[slug],
      // No session behind it reached a result that could be verified.
      ...(slug === "release-guide" ? { outcome_verified: false } : {}),
    }),
  );
  fs.writeFileSync(
    path.join(dir, `${slug}.oneshot.md`),
    `<!-- synthetic fixture -->\n# ${title}\n\n${body}\n`,
  );
}
samples[0][3] =
  '## Goal\n\nMake **focused changes** with `small commits`.\n\n1. Inspect the current behavior.\n2. Ship the smallest useful improvement.\n   - Keep existing libraries readable.\n\n> Verify the real user path.\n\n### Check\n\n```ts\nconst message = "<safe>";\nconsole.log(message);\n```\n\n| Step | Result |\n| --- | --- |\n| Install | One package |\n| Preview | Markdown |\n\n- [x] Preserve source Markdown\n- [ ] Ask before model calls\n\n[Jump to check](#check) · [Reference](https://example.com/docs)';
samples[3][3] +=
  "\n\n![tracker](https://tracking.example/pixel.png)\n\n[unsafe](javascript:alert(1))\n[encoded](javascript&#58;alert(1))";
for (const [slug, title, , body] of samples) {
  fs.writeFileSync(
    path.join(home, "library", slug, `${slug}.oneshot.md`),
    `# ${title}\n\n${body}\n`,
  );
}

/** The test kit's synthetic home builder and the readers it matches, bundled for Node. */
async function loadKit() {
  const out = path.join(scratch, "kit");
  await build({
    config: false,
    entry: {
      home: "test/support/home.ts",
      generalized: "src/core/generalized.ts",
      subagents: "src/core/subagents.ts",
      prompts: "src/distill/prompts/generalize.ts",
    },
    outDir: out,
    platform: "node",
    format: "esm",
    fixedExtension: true,
    dts: false,
    logLevel: "silent",
    deps: { alwaysBundle: [/.*/] },
  });
  const load = (name) => import(pathToFileURL(path.join(out, `${name}.mjs`)).href);
  return {
    ...(await load("home")),
    ...(await load("generalized")),
    ...(await load("subagents")),
    ...(await load("prompts")),
  };
}
const kit = await loadKit();
const guidedHome = kit.sampleHome().build(path.join(scratch, "guided")).dir;
/** One agreement over every current candidate, fresh for the home as it is now. */
function saveAgreements(dir) {
  const { inputs, projects } = kit.currentGeneralizeInputs(dir, "all-candidates");
  const ids = inputs.map((input) => input.id);
  const draft = {
    title: "Keep changes small and reviewable",
    instruction: "Keep each change small and focused so that it is easy to review and test.",
    applies_when: "Any code change.",
    exceptions: "",
    disposition: "generalized",
    source_ids: ids,
  };
  kit.writeGeneralized(dir, {
    version: 1,
    generated_at: "2026-01-02T03:04:05.000Z",
    prompt_version: kit.GENERALIZE_PROMPT_VERSION,
    inputs_hash: kit.generalizedInputsHash(inputs, projects),
    selection: "all-candidates",
    model: "synthetic-model",
    windows: { ["a".repeat(64)]: { input_ids: ids, result: { lessons: [draft], set_aside: [] } } },
    lessons: [{ id: "keep-changes-small-and-reviewable", ...draft }],
    set_aside: [],
  });
  return ids.length;
}
const agreementSources = saveAgreements(guidedHome);
assert.ok(agreementSources >= 2, "the sample home has at least two candidates");

/**
 * A large synthetic library, shaped like a real one: 40 sessions in four
 * projects, 139 preferences, and 120 saved working agreements made from them
 * (62 general, 41 for one project, 17 one-time notes). Every preference feeds
 * exactly one agreement, as a saved window requires.
 */
const LARGE = { sessions: 40, preferences: 139, general: 62, project: 41, oneTime: 17 };
const largeProjects = ["atlas", "harbor", "lumen", "quarry"];
const largeDomains = [
  "Software engineering > Testing",
  "Software engineering > Frontend > Accessibility",
  "Software engineering > Backend > APIs",
  "Software engineering > Security",
  "Software engineering > Infrastructure",
  "Writing & research > Documentation",
  "Data & AI > Evaluation",
  "Software engineering > Testing",
];
const verbs = ["Keep", "Check", "Name", "Explain", "Prefer", "Avoid", "Record", "Review"];
const things = [
  "small focused changes",
  "the failing test first",
  "plain release notes",
  "one source of truth",
  "readable error messages",
  "the public interface stable",
  "the slow suite for last",
  "measured numbers over guesses",
  "the user's own wording",
  "backups before migrations",
  "labels that match counts",
  "keyboard paths in every form",
  "secrets out of logs",
];
function largeText(index) {
  return `${verbs[index % verbs.length]} ${things[index % things.length]}, rule ${index + 1}`;
}
function buildLargeHome(dir) {
  // The first 45 preferences belong to one project; the rest are global.
  const projectScoped = (k) => k < 45;
  const sessionsOf = (k) => {
    const first = k % LARGE.sessions;
    if (projectScoped(k)) return [first];
    const more = [first];
    if (k % 3 === 0) more.push((k + 7) % LARGE.sessions);
    if (k % 5 === 0) more.push((k + 13) % LARGE.sessions);
    return [...new Set(more)];
  };
  const quotes = Array.from({ length: LARGE.sessions }, () => []);
  for (let k = 0; k < LARGE.preferences; k++) {
    for (const session of sessionsOf(k)) quotes[session].push(k);
  }
  let builder = kit.homeBuilder();
  for (let i = 0; i < LARGE.sessions; i++) {
    builder = builder.session({
      project: largeProjects[i % largeProjects.length],
      sessionId: `c${String(i).padStart(7, "0")}-0000-4000-8000-${String(i).padStart(12, "0")}`,
      messages: quotes[i].map((k) => `Please ${largeText(k).toLowerCase()} in this work.`),
    });
  }
  for (let i = 0; i < LARGE.sessions; i++) {
    builder = builder.digest(i, {
      domain: largeDomains[i % largeDomains.length],
      preferences: quotes[i].map((k) => ({
        text: `${largeText(k)}.`,
        quote: largeText(k).toLowerCase(),
        scope: projectScoped(k) ? "project" : "global",
      })),
    });
  }
  const built = builder.build(dir);
  const { inputs, projects } = kit.currentGeneralizeInputs(built.dir, "all-candidates");
  assert.equal(inputs.length, LARGE.preferences, "every large preference is a separate input");
  const scoped = inputs.filter((input) => input.scope === "project").map((input) => input.id);
  const global = inputs.filter((input) => input.scope !== "project").map((input) => input.id);
  // Sources per agreement: 41 project ones over 45 project preferences, 17 one-time
  // notes over 17 global ones, and 62 general ones over the other 77.
  // The first few agreements take two preferences, so every preference is used once.
  const take = (pool, count) => {
    const extra = pool.length - count;
    return Array.from({ length: count }, (_, i) => pool.splice(0, i < extra ? 2 : 1));
  };
  const oneTimeSources = global.splice(0, LARGE.oneTime).map((id) => [id]);
  const drafts = [
    ...take(global, LARGE.general).map((ids, i) => ({
      title: `${largeText(i)}`,
      instruction: `${largeText(i)} in every project, and say so when it cannot be done.`,
      applies_when: i % 4 === 0 ? "Any change that someone else will read." : "",
      exceptions: i % 6 === 0 ? "A throwaway sketch." : "",
      disposition: "generalized",
      source_ids: ids,
    })),
    ...take(scoped, LARGE.project).map((ids, i) => ({
      title: `Use the ${largeProjects[i % 4]} release checklist, step ${i + 1}`,
      instruction: `In ${largeProjects[i % 4]}, follow release checklist step ${i + 1} before shipping anything.`,
      applies_when: "",
      exceptions: "",
      disposition: "contextual",
      source_ids: ids,
    })),
    ...oneTimeSources.map((ids, i) => ({
      title: `Allowed once to skip review ${i + 1}`,
      instruction: `One change went out without the usual review by explicit permission, note ${i + 1}.`,
      applies_when: "",
      exceptions: "",
      disposition: "historical",
      source_ids: ids,
    })),
  ];
  const ids = inputs.map((input) => input.id);
  kit.writeGeneralized(built.dir, {
    version: 1,
    generated_at: "2026-01-02T03:04:05.000Z",
    prompt_version: kit.GENERALIZE_PROMPT_VERSION,
    inputs_hash: kit.generalizedInputsHash(inputs, projects),
    selection: "all-candidates",
    model: "synthetic-model",
    windows: { ["b".repeat(64)]: { input_ids: ids, result: { lessons: drafts, set_aside: [] } } },
    lessons: kit.assignLessonIds(drafts),
    set_aside: [],
  });
  return built.dir;
}
const largeHome = buildLargeHome(path.join(scratch, "large"));

/**
 * A library just upgraded from 1.x: five prompts were written, then the
 * sessions were grouped again into two tasks. The other three prompts stay on
 * disk from the earlier grouping (they may be edited or rated) until `prune`.
 */
const upgradedTitles = [
  "Fix the flaky build step",
  "Write the release notes",
  "Fix the flaky build step again",
  "Draft the release notes",
  "Tidy the build scripts",
];
function buildUpgradedHome(dir) {
  let builder = kit.homeBuilder();
  upgradedTitles.forEach((title, i) => {
    builder = builder
      .session({
        project: "atlas",
        sessionId: `d${i}000000-0000-4000-8000-00000000000${i}`,
        messages: [`${title}, please.`],
      })
      .digest(i)
      .task({ slug: `upgraded-task-${i + 1}`, title, members: [i] })
      .library(`upgraded-task-${i + 1}`);
  });
  const built = builder.build(dir);
  const tasksFile = path.join(built.dir, "distill", "tasks.json");
  const tasks = JSON.parse(fs.readFileSync(tasksFile, "utf8"));
  // The regrouping keeps the first two tasks.
  fs.writeFileSync(tasksFile, JSON.stringify({ ...tasks, tasks: tasks.tasks.slice(0, 2) }));
  return built.dir;
}
const upgradedHome = buildUpgradedHome(path.join(scratch, "upgraded"));
const servers = [];
const errors = [];
const network = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await delay(80);
  }
  throw new Error(`Timed out: ${label}`);
}
/**
 * Start `gui --no-open` for a home and read the printed address. With
 * `opener`, the browser is opened instead, through a stand-in `open` and
 * `xdg-open` placed first on PATH that record their arguments in that file.
 */
async function startGui(dir, { port, opener } = {}) {
  let env = { ...process.env, SSH_CONNECTION: "", SSH_CLIENT: "", SSH_TTY: "" };
  if (opener) {
    const bin = fs.mkdtempSync(path.join(scratch, "opener-"));
    for (const name of ["open", "xdg-open"]) {
      const script = path.join(bin, name);
      fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\n' "$@" > '${opener}'\n`, { mode: 0o700 });
    }
    env = {
      ...env,
      PATH: `${bin}${path.delimiter}${env.PATH}`,
      WSL_DISTRO_NAME: "",
      WSL_INTEROP: "",
    };
  }
  const proc = spawn(
    process.execPath,
    [
      path.resolve("dist/cli.js"),
      "gui",
      "--home",
      dir,
      ...(opener ? [] : ["--no-open"]),
      ...(port ? ["--port", String(port)] : []),
    ],
    { stdio: ["ignore", "pipe", "pipe"], env },
  );
  const server = { proc, stdout: "" };
  servers.push(server);
  proc.stdout.on("data", (data) => {
    server.stdout += data.toString();
  });
  await until(() => /library: \S+\n/.test(server.stdout), "GUI startup");
  const match = server.stdout.match(/library: (http:\/\/127\.0\.0\.1:\d+)\/#token=([0-9a-f]+)\n/);
  assert(match, `the printed address carries the session key: ${server.stdout}`);
  server.base = match[1];
  server.token = match[2];
  assert.match(server.token, /^[0-9a-f]{64}$/);
  server.address = (route = "") =>
    `${server.base}/#${route ? `${route}&` : ""}token=${server.token}`;
  return server;
}
async function stopGui(server) {
  if (server.proc.exitCode !== null) return;
  const closed = new Promise((resolve) => server.proc.once("exit", resolve));
  server.proc.kill("SIGTERM");
  await Promise.race([closed, delay(3000)]);
  assert.notEqual(server.proc.exitCode, null, "GUI did not stop on SIGTERM");
}
async function apiJson(server, route) {
  const response = await fetch(`${server.base}${route}`, {
    headers: { "x-hindsight-token": server.token },
  });
  assert.equal(response.status, 200, route);
  return response.json();
}
/** A raw request, so the Host header can be set. */
function rawRequest(server, route, { method = "GET", headers = {}, body } = {}) {
  const base = new URL(server.base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: base.hostname, port: base.port, path: route, method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}
/** What only a real socket can show: binding, refusals on the wire, HEAD, and the size limit. */
async function checkWire(server, privateText) {
  assert.ok(server.base.startsWith("http://127.0.0.1:"), "binds to loopback");
  const key = { "x-hindsight-token": server.token };
  for (const [label, route, headers] of [
    ["no key", "/api/library", {}],
    ["key in the query string", `/api/library?token=${server.token}`, {}],
    ["wrong key", "/api/library", { "x-hindsight-token": "f".repeat(64) }],
    ["rebinding Host", "/api/library", { ...key, host: "unrelated.example" }],
    ["cross-site Origin", "/api/library", { ...key, origin: "https://unrelated.example" }],
  ]) {
    const response = await rawRequest(server, route, { headers });
    assert.equal(response.status, 403, label);
    assert.ok(!response.text.includes(privateText), `${label} leaks nothing`);
  }
  assert.equal((await rawRequest(server, "/api/library", { headers: key })).status, 200);
  assert.equal((await rawRequest(server, "/", {})).status, 200, "the page loads without the key");
  const head = await rawRequest(server, "/api/library", { method: "HEAD", headers: key });
  assert.equal(head.status, 200);
  assert.equal(head.text, "");
  assert.ok(Number(head.headers["content-length"]) > 0);
  const large = await rawRequest(server, "/api/preferences/review", {
    method: "POST",
    headers: { ...key, origin: server.base, "content-type": "application/json" },
    body: "x".repeat(20_000),
  });
  assert.equal(large.status, 413);
}
let chrome;
let ws;
try {
  const legacy = await startGui(home);
  await checkWire(legacy, "Make the settings page easier to use");
  // Copyable commands quote any home path as one literal shell argument.
  const oddHome = path.join(scratch, "quotes' $(printf expanded) `printf expanded`\nnext line");
  const odd = await startGui(oddHome);
  const oddCommands = (await apiJson(odd, "/api/library")).commands;
  for (const [name, expected] of [
    [
      "consolidate",
      ["npx", "human-hindsight@latest", "preferences", "--consolidate", "--home", oddHome],
    ],
    ["start", ["npx", "human-hindsight@latest", "--home", oddHome]],
  ]) {
    const parsed = execFileSync(
      "/bin/sh",
      ["-c", `set -- ${oddCommands[name]}; printf '%s\\0' "$@"`],
      {
        encoding: "utf8",
      },
    )
      .split("\0")
      .filter(Boolean);
    assert.deepEqual(parsed, expected, name);
  }
  assert.equal(fs.existsSync(oddHome), false, "reading the library creates nothing");
  assert.notEqual(odd.token, legacy.token, "each start makes a new key");
  // Ctrl+C and a terminate signal together close the server once and exit cleanly.
  const oddExit = new Promise((resolve) => odd.proc.once("exit", (code) => resolve(code)));
  odd.proc.kill("SIGINT");
  odd.proc.kill("SIGTERM");
  assert.equal(await Promise.race([oddExit, delay(3000).then(() => "running")]), 0);
  const profile = path.join(scratch, "chrome");
  const chromePath =
    process.env.CHROME_BIN ||
    [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
    ].find((file) => fs.existsSync(file));
  assert(chromePath, "Chrome is required for browser verification");
  const chromeLog = path.join(scratch, "chrome-startup.log");
  const chromeStartedAt = Date.now();
  const maxChromeStderr = 16 * 1024;
  let chromeStderr = "";
  let chromeSpawnError;
  let chromeExit;
  const chromeDiagnostics = () =>
    [
      `Executable: ${chromePath}`,
      `Mode: ${process.env.GUI_HEADED === "1" ? "headed" : "headless"}`,
      `Elapsed: ${Date.now() - chromeStartedAt}ms`,
      `PID: ${chrome?.pid ?? "not started"}`,
      `Spawn error: ${chromeSpawnError?.message ?? "none"}`,
      `Exit: ${chromeExit ? JSON.stringify(chromeExit) : chromeSpawnError ? "not started" : "still running"}`,
      `Stderr (last ${maxChromeStderr} characters):`,
      chromeStderr || "(no stderr captured)",
    ].join("\n");
  const saveChromeDiagnostics = () => {
    try {
      fs.writeFileSync(chromeLog, `${chromeDiagnostics()}\n`, { mode: 0o600 });
    } catch {
      // Reporting the original startup failure must not depend on log writes.
    }
  };
  const chromeStartupFailure = (reason) => {
    saveChromeDiagnostics();
    return new Error(`${reason}\n${chromeDiagnostics()}\nChrome diagnostic log: ${chromeLog}`);
  };
  chrome = spawn(
    chromePath,
    [
      ...(process.env.GUI_HEADED === "1" ? [] : ["--headless=new"]),
      "--no-sandbox",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-features=Translate,MediaRouter",
      "--window-size=1280,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  chrome.stderr.setEncoding("utf8");
  chrome.stderr.on("data", (chunk) => {
    chromeStderr = (chromeStderr + chunk).slice(-maxChromeStderr);
    saveChromeDiagnostics();
  });
  chrome.once("error", (error) => {
    chromeSpawnError = error;
    saveChromeDiagnostics();
  });
  chrome.once("exit", (code, signal) => {
    chromeExit = { code, signal };
    saveChromeDiagnostics();
  });
  saveChromeDiagnostics();
  const portFile = path.join(profile, "DevToolsActivePort");
  try {
    await until(
      () => {
        if (chromeSpawnError) throw new Error("Chrome could not be started.");
        if (chromeExit) throw new Error("Chrome exited before its debugging port became ready.");
        if (!fs.existsSync(portFile)) return false;
        // The file can be observed while Chrome is still writing it.
        const value = fs.readFileSync(portFile, "utf8").split("\n")[0];
        const port = Number(value);
        return /^[0-9]+$/.test(value) && port > 0 && port <= 65535;
      },
      "Chrome debugging port",
      30_000,
    );
  } catch (error) {
    throw chromeStartupFailure(error.message);
  }
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0];
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const target = pages.find((page) => page.type === "page");
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      message.error
        ? item.reject(new Error(JSON.stringify(message.error)))
        : item.resolve(message.result);
    } else if (message.method === "Runtime.exceptionThrown")
      errors.push(message.params.exceptionDetails);
    else if (message.method === "Network.requestWillBeSent")
      network.push({
        url: message.params.request.url,
        headers: message.params.request.headers,
      });
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 8000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function screenshot(name) {
    const data = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(pictures, `${name}.png`), Buffer.from(data.data, "base64"));
  }
  async function settle() {
    await evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
  }
  async function selectDomain(parts, choose = true) {
    await evaluate(`(() => {
      const menu = document.getElementById("domain-menu");
      const trigger = document.getElementById("domain");
      trigger.scrollIntoView({block:"center"});
      if (menu.hidden) trigger.click();
      const parts = ${JSON.stringify(parts)};
      for (let depth = 1; depth < parts.length; depth++) {
        const key = parts.slice(0, depth).join(" > ").toLowerCase();
        const toggle = [...menu.querySelectorAll(".domain-toggle")].find(el => el.dataset.domainKey === key);
        if (!toggle) throw new Error("Missing domain branch: " + key);
        if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
      }
      const key = parts.join(" > ").toLowerCase();
      const button = [...menu.querySelectorAll(".domain-select")].find(el => el.dataset.domainKey === key);
      if (!button || button.closest("[hidden]")) throw new Error("Missing visible domain: " + key);
      button.scrollIntoView({block:"nearest"});
      if (${choose}) button.click();
    })()`);
    await settle();
  }
  async function expandEvidence() {
    await evaluate(`(() => {
      const details = document.getElementById("related");
      if (!details.hidden && !details.open) details.querySelector("summary").click();
    })()`);
    await settle();
  }
  /** Open the library at `route` the way a person does: the printed address. */
  async function open(server, route = "") {
    // A new document each time, as when the address is opened in a new tab.
    await call("Page.navigate", { url: "about:blank" });
    await until(() => evaluate("location.href === 'about:blank'"), "blank page");
    const previous = await evaluate("window.__documentId");
    await call("Page.navigate", { url: server.address(route) });
    await until(
      () =>
        evaluate(
          `window.__documentId !== ${JSON.stringify(previous)} && document.getElementById("count")?.textContent !== "Loading library…"`,
        ),
      "library loaded",
    );
    await settle();
    // The key leaves the address bar at once; the route stays.
    assert.equal(await evaluate("location.href.includes('token')"), false);
    // Without a route the page writes the tab it chose, e.g. #prompts.
    const hash = await evaluate("location.hash");
    assert.ok(route ? hash === `#${route}` : /^#?(prompts|subagents)?$/.test(hash), hash);
  }
  /**
   * A separate new tab with its own connection, as when a person opens a new
   * tab and types the address. It starts with empty tab storage.
   */
  async function openTab(url) {
    const created = await (
      await fetch(`http://127.0.0.1:${port}/json/new?${url}`, { method: "PUT" })
    ).json();
    const socket = new WebSocket(created.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let next = 0;
    const waiting = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    });
    const run = (expression) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => reject(new Error("CDP timeout in the second tab")), 8000);
        waiting.set(id, (message) => {
          clearTimeout(timer);
          if (message.error || message.result.exceptionDetails)
            reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
          else resolve(message.result.result.value);
        });
        socket.send(
          JSON.stringify({
            id,
            method: "Runtime.evaluate",
            params: { expression, returnByValue: true, awaitPromise: true },
          }),
        );
      });
    return {
      run,
      async close() {
        socket.close();
        await fetch(`http://127.0.0.1:${port}/json/close/${created.id}`);
      },
    };
  }
  /** Open the same view again from the printed address. */
  async function reopen(server) {
    await open(server, (await evaluate("location.hash")).slice(1));
  }
  /** The visible guided overview: its label, highlights with reasons, and its action. */
  async function checkGuide(label, { highlights: [least, most], action, stale = false }) {
    const guide = await evaluate(`(() => {
      const proseOf = ${PROSE};
      const region = [...document.querySelectorAll('section.overview[aria-label]')].find(el => !el.closest('[hidden]'));
      if (!region) return null;
      return {
        label: region.getAttribute('aria-label'),
        sentence: region.querySelector('p').textContent,
        // Only "Start here": agreement groups below use the same row markup.
        rows: [...region.querySelectorAll(':scope > ul.highlights li')].map(li => ({ link: li.querySelector('a').textContent, reason: li.querySelector('span').textContent, stale: li.dataset.stale === 'true' })),
        action: (region.querySelector('.overview-action') ?? region.querySelector('#export-all'))?.textContent ?? null,
        text: proseOf(region),
      };
    })()`);
    assert.ok(guide, `${label} is visible`);
    assert.equal(guide.label, label);
    assert.ok(
      guide.sentence.length > 40 && guide.sentence.split(". ").length === 1,
      guide.sentence,
    );
    assert.ok(
      guide.rows.length >= least && guide.rows.length <= most,
      `${label}: ${guide.rows.length} highlights`,
    );
    for (const row of guide.rows) {
      assert.ok(row.link.trim() && /\d/.test(row.reason), `${label}: ${JSON.stringify(row)}`);
      assert.equal(row.stale, stale, `${label}: ${row.link} stale label`);
      assert.equal(row.reason.endsWith("out of date"), stale);
    }
    if (action !== undefined) assert.equal(guide.action, action);
    assertPlainWords(`${label} overview`, guide.text);
    return guide;
  }
  /**
   * The page's own prose, as an expression for evaluate(): commands (code) and
   * the person's own Markdown are left out, since they are not page wording.
   */
  const PROSE = `((root) => { const copy = root.cloneNode(true); for (const el of copy.querySelectorAll("code, pre, textarea, .markdown, script, style, [hidden]")) el.remove(); return copy.innerText ?? copy.textContent; })`;
  /** Words the page never shows, so one word stays one idea. */
  function assertPlainWords(where, text) {
    for (const word of [
      /oneshot/i,
      /harness/i,
      /\bLLM/,
      /\bdistill\b/,
      /digest/i,
      /cluster/i,
      /lineage/i,
      /candidate/i,
      /\blessons?\b/i,
      /portable/i,
      /mapped to/i,
      /set aside/i,
      /[a-z]\(s\)/,
    ]) {
      assert.ok(!word.test(text), `${where} says ${word}: ${text.match(word)?.[0]}`);
    }
  }
  /** Visible text the layout cuts off: clipped boxes in the guide, and the closed sort label. */
  async function assertNothingCut(where) {
    const cut = await evaluate(`(() => {
      const out = [];
      for (const el of document.querySelectorAll("#guide *, #subagents-view .overview *")) {
        if (el.closest("[hidden]") || !el.checkVisibility() || !el.textContent.trim()) continue;
        const s = getComputedStyle(el);
        const clips = s.overflowX !== "visible" || s.textOverflow === "ellipsis";
        if (clips && el.scrollWidth > el.clientWidth + 1 && el.tagName !== "TEXTAREA") out.push(el.className || el.tagName);
        const r = el.getBoundingClientRect();
        if (r.right > innerWidth + 1) out.push("past the edge: " + (el.className || el.tagName));
      }
      const sort = document.getElementById("sort");
      if (sort.checkVisibility()) {
        const s = getComputedStyle(sort);
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.font = s.font;
        const room = sort.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight);
        for (const option of sort.options) {
          if (ctx.measureText(option.textContent).width > room + 0.5) out.push("sort: " + option.textContent);
        }
      }
      return out;
    })()`);
    assert.deepEqual(cut, [], `${where}: text cut off`);
  }
  async function pressEscape() {
    for (const type of ["keyDown", "keyUp"]) {
      await call("Input.dispatchKeyEvent", {
        type,
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
    }
    await settle();
  }
  async function inspectTree(selector) {
    const measured = await evaluate(`(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      const box = root.getBoundingClientRect();
      const rows = [...root.querySelectorAll(".domain-row")].filter(row => !row.closest("[hidden]")).map(row => {
        const label = row.querySelector(".domain-select");
        const gutter = row.querySelector(".domain-toggle,.domain-gutter");
        const arrow = gutter.querySelector("svg");
        const gap = gutter.getBoundingClientRect();
        const range = document.createRange();
        range.setStart(label.firstChild, 0);
        range.setEnd(label.firstChild, 1);
        const line = range.getBoundingClientRect();
        const icon = arrow?.getBoundingClientRect();
        return {
          path: label.dataset.domainKey,
          gutter: gap.width,
          textGap: line.left - gap.right,
          arrowCount: gutter.querySelectorAll("svg").length,
          arrowOffset: icon ? Math.abs(icon.top + icon.height / 2 - line.top - line.height / 2) : 0,
          clipped: label.scrollWidth > label.clientWidth + 1,
        };
      });
      const keys = [...root.querySelectorAll(".domain-select")].map(button => button.dataset.domainKey);
      return {x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom,viewportWidth:innerWidth,viewportHeight:innerHeight,rows,unique:keys.length===new Set(keys).size};
    })()`);
    assert.equal(measured.unique, true, "case variants must not duplicate domain nodes");
    assert.ok(measured.x >= 0 && measured.right <= measured.viewportWidth + 1);
    assert.ok(measured.y >= 0 && measured.bottom <= measured.viewportHeight + 1);
    for (const row of measured.rows) {
      assert.equal(row.gutter, 24, row.path);
      assert.ok(row.textGap >= 0, `text overlaps the arrow gutter: ${row.path}`);
      assert.ok(row.arrowCount <= 1, row.path);
      assert.ok(row.arrowOffset <= 4, `arrow is not aligned to the first line: ${row.path}`);
      assert.equal(row.clipped, false, row.path);
    }
    return measured;
  }
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
    eventsEnabled: true,
  });
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__documentId = Math.random(); Object.defineProperty(navigator, "clipboard", {configurable:true, value:{writeText:async(text)=>{window.__copied=text;}}});
      window.__intervals = 0;
      const originalInterval = window.setInterval.bind(window);
      window.setInterval = (...args) => { window.__intervals++; return originalInterval(...args); };`,
  });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await call("Page.bringToFront");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });

  // First visit without a suggestion: the Prompts overview.
  await open(legacy);
  await until(
    () => evaluate('document.querySelectorAll(".entry").length === 4'),
    "library content",
  );
  assert.equal(
    await evaluate('document.getElementById("prompts-tab").getAttribute("aria-selected")'),
    "true",
  );
  assert.equal(
    await evaluate('document.getElementById("title").textContent'),
    "Your prompt library",
  );
  const promptsGuide = await checkGuide("Prompts guide", {
    highlights: [2, 3],
    action: "Copy the first prompt",
  });
  // The liked prompt comes first, and the reason says so.
  assert.deepEqual(promptsGuide.rows[0], {
    link: samples[0][1],
    reason: "Liked · Based on 2 sessions",
    stale: false,
  });
  // A prompt whose outcome was not verified: never offered first while verified
  // ones exist, counted in the guide's sentence, and labeled in its row.
  assert.ok(
    promptsGuide.rows.every((row) => row.link !== samples[1][1]),
    JSON.stringify(promptsGuide.rows),
  );
  assert.ok(
    promptsGuide.sentence.endsWith(
      "; 1 of 4 is marked outcome not verified, because no session behind it was seen to reach a result.",
    ),
    promptsGuide.sentence,
  );
  const tailOf = (slug) =>
    evaluate(
      `document.querySelector('#list .entry[data-id="${slug}"] .entry-meta-tail')?.textContent`,
    );
  assert.equal(await tailOf("release-guide"), "Outcome not verified · 2 sessions");
  assert.equal(await tailOf("users-pagination"), "2 sessions");
  await screenshot("desktop-light-prompts-overview");
  await evaluate('document.querySelector("#guide .overview-action").click()');
  await until(() => evaluate("window.__copied !== undefined"), "copy the first prompt");
  assert.equal(await evaluate("window.__copied"), samples[0][3]);
  assert.equal(await evaluate('document.getElementById("title").textContent'), samples[0][1]);
  await evaluate("window.__copied=undefined");
  const outcomeNote = () =>
    evaluate('document.querySelector(".metadata-summary .outcome-note")?.textContent ?? null');
  assert.equal(await outcomeNote(), null);
  await evaluate("document.querySelector('#list .entry[data-id=\"release-guide\"]').click()");
  await until(
    async () => (await evaluate('document.getElementById("title").textContent')) === samples[1][1],
    "open the unverified prompt",
  );
  assert.equal(await outcomeNote(), "Outcome not verified");
  await screenshot("desktop-light-outcome-not-verified");
  await evaluate("document.querySelector('#list .entry[data-id=\"settings-page\"]').click()");
  await until(
    async () => (await evaluate('document.getElementById("title").textContent')) === samples[0][1],
    "back to the first prompt",
  );
  assert.equal(
    await evaluate('document.querySelector(".topbar").getBoundingClientRect().height'),
    53,
  );
  // Help stays closed until asked for and never changes on its own.
  assert.equal(await evaluate('document.getElementById("tips").open'), false);
  await evaluate('document.getElementById("tip-toggle").click()');
  assert.equal(await evaluate('document.getElementById("tip-topic").value'), "prompts");
  const chooseTopic = (topic) =>
    evaluate(
      `(() => { const s = document.getElementById("tip-topic"); s.value = ${JSON.stringify(topic)}; s.dispatchEvent(new Event("change")); })()`,
    );
  await chooseTopic("privacy");
  assert.equal(
    await evaluate('document.querySelector("#tip-text a").href'),
    "https://github.com/adityaarunsinghal/human-hindsight",
  );
  await screenshot("desktop-privacy-help");
  await chooseTopic("preferences");
  await evaluate('document.querySelector("#tip-command button").click()');
  await until(() => evaluate("window.__copied !== undefined"), "help command copy");
  assert.match(
    await evaluate("window.__copied"),
    /^npx human-hindsight@latest preferences --home /,
  );
  await evaluate("window.__copied=undefined");
  await chooseTopic("consolidate");
  assert.equal(
    await evaluate('document.getElementById("tip-cost").textContent.includes("credits")'),
    true,
  );
  assert.equal(
    await evaluate(
      'document.getElementById("tip-command").textContent.includes("preferences --consolidate")',
    ),
    true,
  );
  const topic = await evaluate('document.getElementById("tip-text").textContent');
  await delay(500);
  assert.equal(await evaluate('document.getElementById("tip-text").textContent'), topic);
  assert.equal(await evaluate("window.__intervals"), 0, "nothing rotates on a timer");
  await evaluate('document.getElementById("tip-toggle").click()');
  assert.equal(
    await evaluate('document.querySelector(".brand").firstChild.textContent.trim()'),
    "Human Hindsight",
  );
  await evaluate('document.getElementById("title").focus()');
  assert.equal(await evaluate('document.querySelectorAll("#body h2").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll("#body table").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll("#body pre code").length'), 1);
  assert.equal(
    await evaluate('document.querySelectorAll("#body input[type=checkbox]:disabled").length'),
    2,
  );
  assert.equal(
    await evaluate('document.querySelector("#body pre code").textContent.includes("<safe>")'),
    true,
  );
  assert.equal(
    await evaluate('document.querySelector("#body a[href^=https]").rel'),
    "noopener noreferrer",
  );
  assert.equal(
    await evaluate('getComputedStyle(document.body).fontFamily.includes("monospace")'),
    true,
  );
  await evaluate('document.getElementById("source-mode").click()');
  assert.equal(await evaluate('document.getElementById("source").value'), samples[0][3]);
  await evaluate('document.getElementById("copy").click()');
  await until(() => evaluate("window.__copied !== undefined"), "Markdown copy");
  assert.equal(await evaluate("window.__copied"), samples[0][3]);
  await evaluate('window.__copied=undefined; document.getElementById("preview-mode").click()');
  await screenshot("desktop-light");
  await evaluate(
    'document.getElementById("search").value = "pagination"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
  assert.equal(await evaluate('document.querySelectorAll(".entry").length'), 1);
  assert.equal(
    await evaluate('document.getElementById("title").textContent'),
    "Add pagination to the users endpoint",
  );
  await evaluate('document.getElementById("copy").click()');
  await until(() => evaluate("window.__copied !== undefined"), "copy");
  assert.equal(await evaluate("window.__copied"), samples[2][3]);
  await evaluate(
    'document.getElementById("search").value = "literal markup"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
  assert.equal(
    await evaluate(
      'document.querySelectorAll("#body script,#body img,#body svg,#body iframe,#body style,#body form").length',
    ),
    0,
  );
  assert.equal(
    await evaluate(
      '[...document.querySelectorAll("#body a")].some(a=>/javascript:/i.test(a.href))',
    ),
    false,
  );
  assert.equal(await evaluate("window.__injected === undefined"), true);
  await evaluate(
    'navigator.clipboard.writeText = async () => { throw new Error("denied"); }; document.getElementById("copy").click();',
  );
  await until(
    () =>
      evaluate('document.getElementById("copy-status").textContent.includes("Markdown selected")'),
    "copy fallback",
  );
  assert.equal(
    await evaluate(
      'document.getElementById("source").value.slice(document.getElementById("source").selectionStart,document.getElementById("source").selectionEnd)',
    ),
    samples[3][3],
  );
  await evaluate(
    'document.getElementById("preview-mode").click(); document.getElementById("search").value=""; document.getElementById("search").dispatchEvent(new Event("input")); document.getElementById("sort").value="title"; document.getElementById("sort").dispatchEvent(new Event("change"));',
  );
  assert.equal(
    await evaluate('document.querySelector(".entry-title").textContent'),
    "Add pagination to the users endpoint",
  );
  await evaluate(
    'navigator.clipboard.writeText=async(text)=>{window.__copied=text;}; document.getElementById("preferences-tab").click()',
  );
  assert.equal(await evaluate('document.getElementById("count").textContent'), "5 preferences");
  // The Preferences overview: no agreements yet, so it guides to the preferences.
  assert.equal(
    await evaluate("document.activeElement.id"),
    "title",
    "a tab click focuses its heading",
  );
  const preferencesGuide = await checkGuide("Preferences guide", {
    highlights: [2, 3],
    action: "Review your preferences",
  });
  // Nothing is accepted yet here, so no highlight says Accepted.
  assert.ok(preferencesGuide.rows.every((row) => !row.reason.includes("Accepted")));
  assert.match(
    await evaluate('document.querySelector("#guide .notice").textContent'),
    /No working agreements have been made yet/,
  );
  assert.equal(await evaluate('document.getElementById("reader-toolbar").hidden'), true);
  assert.equal(
    await evaluate(
      'document.querySelectorAll("#domain-menu > .domain-tree > .domain-node").length',
    ),
    1,
  );
  assert.equal(await evaluate('document.getElementById("sort").value'), "frequency");
  await evaluate('document.querySelector(".entry").click()');
  const preferenceBookmark = await evaluate("location.hash");
  assert.match(preferenceBookmark, /^#preferences\/[a-f0-9]{64}$/);
  assert.equal(await evaluate('document.querySelectorAll("#body strong").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll("#body code").length'), 1);
  assert.equal(await evaluate('document.querySelectorAll("#related-list > li > a").length'), 2);
  assert.equal(await evaluate('document.querySelectorAll(".evidence strong").length'), 1);
  assert.equal(await evaluate('document.getElementById("copy").disabled'), true);
  await evaluate('document.getElementById("accept-preference").click()');
  await until(
    () =>
      evaluate('document.getElementById("accept-preference").textContent.trim() === "Accepted"'),
    "explicit preference acceptance",
  );
  await evaluate('window.__copied=undefined; document.getElementById("copy").click()');
  await until(() => evaluate("window.__copied !== undefined"), "preference copy");
  assert.equal(await evaluate("window.__copied"), `- ${sharedPreference}`);
  await expandEvidence();
  await screenshot("desktop-preference-evidence");
  await evaluate('document.querySelector(".domain-context-summary").click()');
  assert.deepEqual(
    await evaluate(
      '[...document.querySelectorAll(".domain-context-tree > .domain-tree > .domain-node > .domain-row > .domain-select")].map(el => el.textContent)',
    ),
    ["Software engineering"],
  );
  assert.equal(
    await evaluate(
      '[...document.querySelectorAll(".domain-context-tree .domain-select")].filter(el => el.dataset.domainKey === "software engineering").length',
    ),
    1,
  );
  await screenshot("desktop-grouped-domains");
  await evaluate('document.querySelector(".domain-context-summary").click()');
  await evaluate('document.querySelector("#related-list > li > a").click()');
  assert.equal(
    await evaluate('document.getElementById("prompts-tab").getAttribute("aria-selected")'),
    "true",
  );
  assert.equal(await evaluate('document.getElementById("title").textContent'), samples[0][1]);
  assert.equal(await evaluate('document.querySelectorAll("#related-list a").length'), 2);
  await evaluate("history.back()");
  await until(
    () => evaluate(`location.hash === ${JSON.stringify(preferenceBookmark)}`),
    "back to preference",
  );
  await evaluate("history.forward()");
  await until(
    () =>
      evaluate('document.getElementById("prompts-tab").getAttribute("aria-selected") === "true"'),
    "forward to source prompt",
  );
  await evaluate("history.back()");
  await until(
    () =>
      evaluate(
        'document.getElementById("preferences-tab").getAttribute("aria-selected") === "true"',
      ),
    "preference history",
  );
  await evaluate(
    'document.getElementById("search").value="direct instructions"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
  assert.equal(await evaluate('document.querySelectorAll(".entry").length'), 1);
  await evaluate('document.getElementById("edit-preference").click()');
  await evaluate(`(() => {
    document.getElementById("preference-text").value="Write concise release documentation.";
    document.getElementById("preference-scope").value="project";
    document.getElementById("preference-scope").dispatchEvent(new Event("change"));
    document.getElementById("preference-project").value=${JSON.stringify(longDomain)};
    document.getElementById("save-preference").click();
  })()`);
  await until(
    () => evaluate('document.getElementById("review-summary").textContent.includes("Accepted")'),
    "edited project preference",
  );
  await evaluate(
    'document.getElementById("prompts-tab").click(); document.getElementById("preferences-tab").click()',
  );
  assert.equal(await evaluate('document.getElementById("search").value'), "direct instructions");
  await evaluate(
    'document.getElementById("search").value="not present anywhere"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
  assert.equal(await evaluate('document.getElementById("list-empty").hidden'), false);
  assert.equal(await evaluate('document.getElementById("copy").disabled'), true);
  await evaluate(
    'document.getElementById("accepted-preferences").click(); window.__copied=undefined; document.getElementById("copy").click()',
  );
  await until(() => evaluate("window.__copied !== undefined"), "accepted instructions copy");
  let snapshot = await apiJson(legacy, "/api/library");
  assert.equal(await evaluate("window.__copied"), snapshot.acceptedMarkdown);
  assert.ok(!snapshot.acceptedMarkdown.includes("Write concise release documentation."));
  assert.ok(
    snapshot.projectInstructions[0].markdown.includes("Write concise release documentation."),
  );
  assert.equal(
    await evaluate('document.getElementById("body").textContent.includes("generated")'),
    false,
  );
  await evaluate(
    'document.getElementById("search").value="preferenceInjected"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
  assert.equal(
    await evaluate(
      'document.querySelectorAll("#body script,#body img,.evidence script,.evidence img").length',
    ),
    0,
  );
  assert.equal(
    await evaluate(
      "window.__preferenceInjected === undefined && window.__evidenceInjected === undefined",
    ),
    true,
  );
  await evaluate('document.getElementById("dismiss-preference").click()');
  await until(
    () => evaluate('document.getElementById("review-summary").textContent.includes("Dismissed")'),
    "dismiss preference",
  );
  assert.equal(await evaluate('document.getElementById("copy").disabled'), true);
  await evaluate('document.getElementById("reset-preference").click()');
  await until(
    () => evaluate('document.getElementById("review-summary").textContent.includes("To review")'),
    "return preference to review",
  );
  await evaluate('document.getElementById("accept-preference").click()');
  await until(
    () =>
      evaluate('document.getElementById("accept-preference").textContent.trim() === "Accepted"'),
    "accept literal markup as inert content",
  );
  await evaluate(
    'navigator.clipboard.writeText=async()=>{throw new Error("denied");}; document.getElementById("copy").click()',
  );
  await until(
    () =>
      evaluate('document.getElementById("copy-status").textContent.includes("Markdown selected")'),
    "preference copy fallback",
  );
  assert.equal(await evaluate('document.getElementById("source").value'), `- ${unsafePreference}`);
  await evaluate(
    'document.getElementById("accepted-preferences").click(); document.getElementById("copy").click()',
  );
  await until(
    () =>
      evaluate(
        'document.getElementById("source").selectionEnd === document.getElementById("source").value.length',
      ),
    "all preferences fallback",
  );
  snapshot = await apiJson(legacy, "/api/library");
  assert.equal(
    await evaluate('document.getElementById("source").value'),
    snapshot.acceptedMarkdown,
  );
  await evaluate(`location.hash=${JSON.stringify(preferenceBookmark)}`);
  await until(
    () => evaluate('document.getElementById("source").value.includes("focused tests")'),
    "preference bookmark",
  );
  await reopen(legacy);
  await until(
    () => evaluate('document.getElementById("source")?.value.includes("focused tests")'),
    "reloaded preference bookmark",
  );
  await selectDomain(["Software engineering"]);
  assert.equal(await evaluate('document.querySelectorAll(".entry").length'), 5);
  await selectDomain(["Software engineering", "Backend", "APIs", "Pagination", "Cursor"]);
  assert.equal(await evaluate('document.querySelectorAll(".entry").length'), 1);
  assert.equal(
    await evaluate(
      `["Software engineering", "Software engineering > Backend", "Software engineering > Backend > APIs", "Software engineering > Backend > APIs > Pagination"].every(path => [...document.querySelectorAll("#domain-menu .domain-toggle")].find(el => el.dataset.domainKey === path.toLowerCase())?.getAttribute("aria-expanded") === "true")`,
    ),
    true,
  );
  await screenshot("desktop-five-level-domains");
  await evaluate('document.getElementById("all-preferences").click()');
  const sourcePreferences = snapshot.preferences
    .filter(
      (preference) =>
        preference.review.status === "accepted" && preference.review.scope === "global",
    )
    .map((preference) => ({
      id: preference.id,
      text: preference.review.text,
      count: preference.count,
      scope: "global",
      project: "",
    }));
  const sourceHash = createHash("sha256")
    .update(
      JSON.stringify(
        [...sourcePreferences].sort(
          (a, b) => a.id.localeCompare(b.id) || a.count - b.count || a.text.localeCompare(b.text),
        ),
      ),
    )
    .digest("hex");
  const savedMarkdown =
    "## Working preferences\n\n" +
    sourcePreferences.map((preference) => `- ${preference.text}`).join("\n");
  fs.writeFileSync(
    path.join(home, "library", "preferences.consolidated.json"),
    JSON.stringify({
      version: 2,
      generated_at: "2026-11-01T12:00:00.000Z",
      source_hash: sourceHash,
      source_preferences: sourcePreferences,
      task_count: 4,
      target: "agents",
      preferences: sourcePreferences.map((preference) => ({
        text: preference.text,
        source_ids: [preference.id],
      })),
      markdown: savedMarkdown,
    }),
  );
  await reopen(legacy);
  await until(
    () => evaluate('document.getElementById("saved-preferences").hidden === false'),
    "saved consolidation",
  );
  await evaluate(
    'document.getElementById("saved-preferences").click(); window.__copied=undefined; document.getElementById("copy").click()',
  );
  await until(() => evaluate("window.__copied !== undefined"), "saved consolidation copy");
  assert.equal(await evaluate("window.__copied"), savedMarkdown);
  assert.equal(
    await evaluate('document.querySelectorAll("#related-list a").length'),
    sourcePreferences.length,
  );
  const metadataFile = path.join(home, "library", "settings-page", "sources.json");
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  metadata.preferences[0].evidence += " Updated source evidence.";
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  await reopen(legacy);
  await until(
    () => evaluate('document.getElementById("consolidation-notice").hidden === false'),
    "stale saved consolidation",
  );
  assert.equal(await evaluate('document.getElementById("source").value'), savedMarkdown);
  await screenshot("desktop-saved-consolidation");
  const measurements = [];
  await call("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const theme of ["light", "dark"]) {
    await call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    for (const tab of ["prompts", "preferences"]) {
      await evaluate(
        `document.getElementById("${tab}-tab").click(); document.getElementById("search").value=""; document.getElementById("search").dispatchEvent(new Event("input")); window.scrollTo(0,0);`,
      );
      for (const [branch, parts] of [
        ["long-label", ["Software engineering", "Infrastructure", longDomain]],
        ["five-levels", ["Software engineering", "Backend", "APIs", "Pagination", "Cursor"]],
        ...(tab === "preferences" ? [["accepted-instructions", []]] : []),
      ]) {
        await selectDomain(parts);
        await evaluate(
          `document.getElementById("sort").value="${tab === "preferences" ? "frequency" : "newest"}"; document.getElementById("sort").dispatchEvent(new Event("change")); window.scrollTo(0,0);`,
        );
        if (tab === "preferences" && branch === "long-label") {
          await evaluate(
            '[...document.querySelectorAll(".entry")].find(el => el.textContent.includes("Preserve existing behavior")).click(); document.getElementById("edit-preference").click(); document.getElementById("preference-scope").value="task"; document.getElementById("preference-scope").dispatchEvent(new Event("change"));',
          );
        }
        if (branch === "accepted-instructions") {
          await evaluate(
            `document.getElementById("accepted-preferences").click(); document.getElementById("instruction-project").value=${JSON.stringify(longDomain)}; document.getElementById("instruction-project").dispatchEvent(new Event("change"));`,
          );
          assert.equal(
            await evaluate(
              'document.getElementById("source").value.includes("Write concise release documentation.")',
            ),
            true,
          );
        }
        await settle();
        const triggerPoint = await evaluate(`(() => {
          const element=document.getElementById("domain"); element.scrollIntoView({block:"center"});
          const rect=element.getBoundingClientRect(); return {x:rect.x+rect.width/2,y:rect.y+rect.height/2};
        })()`);
        await call("Input.dispatchMouseEvent", { type: "mouseMoved", ...triggerPoint });
        const measured = await evaluate(
          '[...document.querySelectorAll("select,#domain")].filter(el => !el.closest("[hidden]") && el.checkVisibility()).map(el => { const s=getComputedStyle(el); const r=el.getBoundingClientRect(); return {id:el.id,tag:el.tagName,value:el.value,appearance:s.appearance,paddingRight:s.paddingRight,backgroundSize:s.backgroundSize,backgroundPosition:s.backgroundPosition,backgroundImage:s.backgroundImage,textOverflow:s.textOverflow,x:r.x,y:r.y,width:r.width,height:r.height}; })',
        );
        for (const item of measured) {
          assert.equal(item.appearance, "none");
          assert.equal(item.paddingRight, "36px");
          assert.equal(item.backgroundSize, "12px 8px");
          assert.ok(
            item.backgroundPosition.includes("12px") && item.backgroundPosition.includes("50%"),
          );
          assert.equal((item.backgroundImage.match(/url\(/g) || []).length, 1);
          assert.equal(item.textOverflow, "ellipsis");
          assert.ok(item.width >= 100, `${item.id} keeps usable label space beside its arrow`);
        }
        assert.deepEqual(
          await evaluate(
            '[...document.querySelectorAll("body *")].filter(el => { if (!el.checkVisibility() || el.getBoundingClientRect().right <= innerWidth + 1) return false; for (let up = el.parentElement; up; up = up.parentElement) { if (getComputedStyle(up).overflowX !== "visible" && up.getBoundingClientRect().right <= innerWidth + 1) return false; } return true; }).map(el => el.id || el.className || el.tagName).slice(0, 8)',
          ),
          [],
          `${tab} ${branch} at 360px in ${theme}: wider than the screen`,
        );
        assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
        measurements.push({
          theme,
          tab,
          branch,
          selects: measured,
          background: await evaluate("getComputedStyle(document.body).backgroundColor"),
        });
        const palette = await evaluate(
          '[document.body,document.querySelector(".sidebar"),document.getElementById("copy")].map(el=>{ const s=getComputedStyle(el); return [s.color,s.backgroundColor]; }).flat()',
        );
        for (const value of palette) {
          const c = value.match(/\d+/g).map(Number);
          assert.equal(c[0], c[1]);
          assert.equal(c[1], c[2]);
        }
        await screenshot(`narrow-${tab}-${theme}-${branch}`);
        if (parts.length) {
          await selectDomain(parts, false);
          const tree = await inspectTree("#domain-menu");
          measurements.push({ theme, tab, branch, domainTree: tree });
          await screenshot(`narrow-${tab}-${theme}-${branch}-domain-tree`);
          await pressEscape();
          assert.equal(await evaluate('document.getElementById("domain-menu").hidden'), true);
          assert.equal(await evaluate("document.activeElement.id"), "domain");
          if (branch === "five-levels") {
            await selectDomain(parts, false);
            await evaluate(`(() => {
              const toggle=[...document.querySelectorAll("#domain-menu .domain-toggle")].find(el=>el.dataset.domainKey==="software engineering");
              toggle.focus(); toggle.click();
            })()`);
            await pressEscape();
            await evaluate('document.getElementById("domain").click()');
            assert.equal(
              await evaluate("document.activeElement.dataset.domainKey"),
              "software engineering",
              "reopening a collapsed selection focuses its visible ancestor",
            );
            await evaluate('document.getElementById("title").focus()');
            assert.equal(await evaluate('document.getElementById("domain-menu").hidden'), true);
            assert.equal(await evaluate("document.activeElement.id"), "title");
          }
        }
        if (tab === "preferences" && branch === "long-label") {
          await evaluate(`(() => {
            const summary=document.querySelector(".domain-context-summary");
            summary.scrollIntoView({block:"center"}); summary.click();
          })()`);
          await settle();
          measurements.push({
            theme,
            tab,
            branch,
            contextTree: await inspectTree(".domain-context-tree"),
          });
          await screenshot(`narrow-${theme}-grouped-domain-context`);
          await evaluate('document.querySelector(".domain-context-summary").focus()');
          await pressEscape();
          assert.equal(
            await evaluate('document.querySelector(".domain-context-more").open'),
            false,
          );
        }
        for (const item of measured.filter((item) => item.tag === "SELECT")) {
          await call("Page.bringToFront");
          const point = await evaluate(`(() => {
            const element = document.getElementById(${JSON.stringify(item.id)});
            element.scrollIntoView({block:"center"});
            const rect = element.getBoundingClientRect();
            return {x:rect.x + rect.width - 18, y:rect.y + rect.height / 2};
          })()`);
          await call("Input.dispatchMouseEvent", {
            type: "mousePressed",
            button: "left",
            clickCount: 1,
            ...point,
          });
          await call("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            button: "left",
            clickCount: 1,
            ...point,
          });
          await delay(150);
          for (let attempt = 0; attempt < 3; attempt++) {
            if (
              await evaluate(`document.getElementById(${JSON.stringify(item.id)}).matches(":open")`)
            )
              break;
            await evaluate(
              `(() => { const el=document.getElementById(${JSON.stringify(item.id)}); el.focus(); el.showPicker(); })()`,
            );
            await delay(150);
          }
          // Native picker windows are not exposed by headless Chrome. The headed
          // verification checks their open state; both modes inspect the controls.
          if (process.env.GUI_HEADED === "1") {
            assert.equal(
              await evaluate(
                `document.getElementById(${JSON.stringify(item.id)}).matches(":open")`,
              ),
              true,
              `${item.id} opens in the browser`,
            );
          }
          await screenshot(`${theme}-${tab}-${branch}-${item.id}-open`);
          await pressEscape();
          // macOS native menus can consume Escape outside the renderer. Disable
          // only during teardown so the next control gets its own fresh popup.
          await evaluate(`document.getElementById(${JSON.stringify(item.id)}).disabled = true`);
          await settle();
          if (process.env.GUI_HEADED === "1") {
            await until(
              () => evaluate('!document.querySelector("select:open")'),
              "previous native menu closes",
              3000,
            );
          }
          await evaluate(`document.getElementById(${JSON.stringify(item.id)}).disabled = false`);
          await delay(120);
        }
      }
    }
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));

  // Refresh reads the library again in place, keeping the key and the view.
  await evaluate(
    'document.getElementById("prompts-tab").click(); document.getElementById("search").value="pagination"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
  await selectDomain([]);
  fs.writeFileSync(
    path.join(home, "library/users-pagination/users-pagination.oneshot.md"),
    "# Add pagination to the users endpoint\n\nA refreshed pagination prompt.",
  );
  await evaluate('document.getElementById("refresh").click()');
  await until(
    () =>
      evaluate(
        'document.getElementById("body").textContent.trim() === "A refreshed pagination prompt."',
      ),
    "refresh",
  );

  // A browser reload keeps the library and the open prompt: the key is kept
  // for this tab only. (The search text is not part of the address.)
  const hashBeforeReload = await evaluate("location.hash");
  await call("Page.reload");
  await until(
    () => evaluate('document.getElementById("count")?.textContent !== "Loading library…"'),
    "library after a reload",
  );
  await settle();
  assert.ok((await evaluate('document.querySelectorAll(".entry").length')) > 1);
  assert.equal(
    await evaluate('document.getElementById("body").textContent.trim()'),
    "A refreshed pagination prompt.",
  );
  assert.equal(await evaluate('document.getElementById("notice").hidden'), true);
  assert.equal(await evaluate("location.hash"), hashBeforeReload);
  assert.equal(await evaluate("location.href.includes('token')"), false);
  // A second tab opened without the fragment does not get the key.
  const secondTab = await openTab(`${legacy.base}/`);
  await until(
    () => secondTab.run('document.getElementById("notice")?.hidden === false'),
    "session help in a second tab",
  );
  assert.match(
    await secondTab.run('document.querySelector("#notice p").textContent'),
    /address printed in your terminal/,
  );
  // The same form as every other command on the page; this tab cannot know the folder.
  assert.equal(
    await secondTab.run('document.querySelector("#notice code").textContent'),
    "npx human-hindsight@latest gui",
  );
  assert.equal(await secondTab.run('document.querySelectorAll(".entry").length'), 0);
  assert.equal(await secondTab.run("sessionStorage.length"), 0);
  await secondTab.close();
  // Pasting the printed address into the same tab changes only the fragment.
  await call("Page.navigate", { url: legacy.address() });
  await until(
    () => evaluate('document.querySelectorAll(".entry").length > 0'),
    "library after pasting the address",
  );
  assert.equal(await evaluate("location.href.includes('token')"), false);
  assert.equal(await evaluate('document.getElementById("notice").hidden'), true);

  // The guided home has a suggestion: a first visit lands on Subagents.
  const guided = await startGui(guidedHome);
  await checkWire(guided, "keep the change small");
  await call("Emulation.clearDeviceMetricsOverride");
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await open(guided);
  await until(
    () => evaluate('document.querySelector("#subagents-view section.overview") !== null'),
    "Subagents overview",
  );
  assert.equal(
    await evaluate('document.getElementById("subagents-tab").getAttribute("aria-selected")'),
    "true",
  );
  await checkGuide("Subagents guide", { highlights: [2, 3], action: "Download all targets (zip)" });
  // One export action: on the overview the toolbar is hidden and its controls sit in the guide.
  assert.equal(await evaluate('document.getElementById("subagents-toolbar").hidden'), true);
  assert.equal(
    await evaluate('document.querySelectorAll("#export-all, .overview-action").length'),
    1,
  );
  await evaluate(
    'document.getElementById("export-target").value="claude"; document.getElementById("export-target").dispatchEvent(new Event("change"))',
  );
  assert.equal(
    await evaluate('document.getElementById("export-all").textContent'),
    "Download Claude Code (zip)",
  );
  await evaluate(
    'document.getElementById("export-target").value="all"; document.getElementById("export-target").dispatchEvent(new Event("change"))',
  );
  await screenshot("desktop-light-subagents-overview");
  await evaluate('document.getElementById("export-all").click()');
  const suggestion = JSON.parse(fs.readFileSync(kit.suggestionPath(guidedHome), "utf8"));
  const zipName = `hindsight-subagents-${suggestion.generated_at.slice(0, 10)}.zip`;
  await until(() => fs.existsSync(path.join(downloads, zipName)), "export zip download", 15000);
  await until(
    () => evaluate('document.getElementById("export-status").textContent.startsWith("Downloaded")'),
    "export status",
  );
  const zip = fs.readFileSync(path.join(downloads, zipName));
  assert.equal(zip.subarray(0, 4).toString("binary"), "PK\x03\x04", "the download is a zip");
  const served = Buffer.from(
    await (
      await fetch(`${guided.base}/api/subagents/export.zip`, {
        headers: { "x-hindsight-token": guided.token },
      })
    ).arrayBuffer(),
  );
  assert.ok(zip.equals(served), "the downloaded zip is the served one");

  // Preferences: the agreement first, then its candidates and their quotations.
  await evaluate('document.getElementById("preferences-tab").click()');
  await settle();
  assert.equal(await evaluate("document.activeElement.id"), "title");
  const agreementsGuide = await checkGuide("Preferences guide", {
    highlights: [1, 3],
    action: "Copy the 1 general agreement as Markdown",
  });
  assert.equal(agreementsGuide.rows[0].link, "Keep changes small and reviewable");
  assert.match(agreementsGuide.rows[0].reason, /^Seen in \d+ sessions?$/);
  assert.match(
    agreementsGuide.sentence,
    new RegExp(`^1 working agreement from ${agreementSources} preferences: 1 general\\.$`),
  );
  // The action copies exactly the agreement the overview shows.
  await evaluate(
    'navigator.clipboard.writeText=async(text)=>{window.__copied=text;}; window.__copied=undefined; document.getElementById("copy-agreements").click()',
  );
  await until(() => evaluate("window.__copied !== undefined"), "copy the general agreements");
  const copiedAgreements = await evaluate("window.__copied");
  assert.match(copiedAgreements, /^# Working agreements\n/);
  assert.ok(copiedAgreements.includes("Keep each change small and focused"));
  await screenshot("desktop-light-preferences-overview");
  await evaluate('document.querySelector("#guide .highlights a").click()');
  await settle();
  assert.match(await evaluate("location.hash"), /^#preferences\/agreement\//);
  assert.equal(
    await evaluate('document.querySelectorAll("#guide .agreement-evidence").length'),
    agreementSources,
  );
  await evaluate(
    'for (const d of document.querySelectorAll("#guide .agreement-evidence")) d.open = true',
  );
  const quotes = await evaluate(
    '[...document.querySelectorAll("#guide .agreement-evidence blockquote.source-quote")].map(q => q.textContent)',
  );
  assert.ok(quotes.includes("keep the change small"), JSON.stringify(quotes));
  await screenshot("desktop-light-agreement-drilldown");

  // Dismissing a candidate makes the agreements and the suggestion out of date.
  await evaluate('document.querySelector("#guide .agreement-evidence a").click()');
  await until(
    () => evaluate('document.getElementById("preference-review").hidden === false'),
    "preference review",
  );
  await evaluate('document.getElementById("dismiss-preference").click()');
  await until(
    () => evaluate('document.getElementById("review-summary").textContent.includes("Dismissed")'),
    "dismissed preference",
  );
  await evaluate('document.getElementById("overview-button").click()');
  await settle();
  await checkGuide("Preferences guide", { highlights: [1, 3], stale: true });
  assert.match(
    await evaluate('document.querySelector("#guide .notice").textContent'),
    /some may be out of date/,
  );
  await screenshot("desktop-light-preferences-stale");
  await evaluate('document.getElementById("subagents-tab").click()');
  await until(
    () => evaluate('document.querySelector("#subagents-view section.overview") !== null'),
    "stale Subagents overview",
  );
  await checkGuide("Subagents guide", { highlights: [2, 3], stale: true });
  assert.match(
    await evaluate('document.getElementById("subagents-banner").textContent'),
    /changed since they were made\. Exporting now gives the roles as shown, including \d+ agreements? whose source/,
  );
  // The agreements whose source was dismissed are marked where a role lists them.
  await evaluate('document.querySelector("#list .entry").click()');
  await settle();
  assert.ok(
    (await evaluate('document.querySelectorAll("#subagents-view .lesson[data-changed]").length')) >
      0,
    "a role marks its agreements whose source was dismissed",
  );
  assert.match(
    await evaluate('document.querySelector("#subagents-view .lesson-changed").textContent'),
    /was dismissed\. An export made now still includes this agreement\./,
  );
  await screenshot("desktop-light-subagents-stale-role");
  // The export controls moved back from the overview whole: nothing missing, no stray text.
  assert.deepEqual(
    await evaluate(
      '[...document.getElementById("subagents-toolbar").childNodes].map(node => node.id || node.textContent.trim()).filter(Boolean)',
    ),
    ["export-target-label", "export-target", "export-all", "export-status"],
  );
  assert.equal(await evaluate('document.getElementById("subagents-toolbar").hidden'), false);

  // Each overview in both themes at three widths, without sideways scrolling.
  const overviews = [];
  for (const theme of ["light", "dark"]) {
    await call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    for (const width of [1280, 900, 360]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      for (const tab of ["prompts", "preferences", "subagents"]) {
        await evaluate(
          `document.getElementById("${tab}-tab").click(); document.getElementById("overview-button").click(); window.scrollTo(0,0);`,
        );
        await until(
          () =>
            evaluate(
              '[...document.querySelectorAll("section.overview[aria-label]")].some(el => !el.closest("[hidden]"))',
            ),
          `${tab} overview at ${width}px`,
        );
        await settle();
        const label = `${tab[0].toUpperCase()}${tab.slice(1)} guide`;
        await checkGuide(label, {
          highlights: tab === "prompts" ? [2, 3] : [1, 3],
          stale: tab !== "prompts",
        });
        assert.equal(
          await evaluate("document.documentElement.scrollWidth <= innerWidth"),
          true,
          `${tab} at ${width}px in ${theme} scrolls sideways`,
        );
        const palette = await evaluate(
          '[document.body,document.querySelector(".sidebar")].map(el=>{ const s=getComputedStyle(el); return [s.color,s.backgroundColor]; }).flat()',
        );
        for (const value of palette) {
          const c = value.match(/\d+/g).map(Number);
          assert.ok(c[0] === c[1] && c[1] === c[2], `monochrome ${value}`);
        }
        await screenshot(`overview-${tab}-${theme}-${width}`);
        overviews.push(`${tab} ${theme} ${width}px`);
      }
    }
  }
  await call("Emulation.clearDeviceMetricsOverride");
  assert.equal(errors.length, 0, JSON.stringify(errors));

  // A large library: about 120 agreements, shown grouped rather than flat.
  const large = await startGui(largeHome);
  await call("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await open(large, "preferences");
  await until(
    () => evaluate('document.querySelector("#guide section.overview") !== null'),
    "large Preferences overview",
  );
  const total = LARGE.general + LARGE.project + LARGE.oneTime;
  const largeGuide = await checkGuide("Preferences guide", {
    highlights: [3, 3],
    action: `Copy the ${LARGE.general} general agreements as Markdown`,
  });
  assert.equal(
    largeGuide.sentence,
    `${total} working agreements from ${LARGE.preferences} preferences: ${LARGE.general} general, ${LARGE.project} for specific projects, ${LARGE.oneTime} one-time notes.`,
  );
  for (const row of largeGuide.rows) {
    assert.match(row.reason, /^Seen in \d+ sessions?$/);
    assert.ok(!row.link.startsWith("Allowed once"), "a one-time note is never a highlight");
    assert.ok(!row.link.startsWith("Use the "), "a project agreement is never a highlight");
  }
  /** The overview's sections and groups, as a person sees them. */
  const largeLayout = () =>
    evaluate(`(() => ({
      sections: [...document.querySelectorAll("#guide .agreement-section")].map(section => ({
        heading: section.querySelector("h2").textContent,
        groups: [...section.querySelectorAll(".agreement-group")].map(group => ({
          label: group.querySelector("h3").firstChild.textContent,
          count: group.querySelector(".group-count").textContent,
          shown: [...group.querySelectorAll("li")].filter(li => !li.hidden).length,
          total: group.querySelectorAll("li").length,
          toggle: group.querySelector(".group-toggle")?.textContent ?? null,
          expanded: group.querySelector(".group-toggle")?.getAttribute("aria-expanded") ?? null,
        })),
      })),
      notes: (() => {
        const notes = document.querySelector("#guide .one-time-notes");
        return notes && { open: notes.open, summary: notes.querySelector("summary").textContent, items: notes.querySelectorAll("li").length };
      })(),
      count: document.getElementById("count").textContent,
      listSections: [...document.querySelectorAll("#list .list-section")].map(el => el.textContent),
      listNotes: document.querySelector("#list .list-one-time")?.open ?? null,
      scroll: document.getElementById("viewer").scrollTop,
    }))()`);
  let layout = await largeLayout();
  assert.deepEqual(
    layout.sections.map((section) => section.heading),
    ["General agreements", "For specific projects"],
  );
  const [generalSection, projectSection] = layout.sections;
  // Every count is what it claims to count.
  assert.equal(
    generalSection.groups.reduce((sum, group) => sum + group.total, 0),
    LARGE.general,
  );
  assert.equal(
    projectSection.groups.reduce((sum, group) => sum + group.total, 0),
    LARGE.project,
  );
  assert.deepEqual(
    projectSection.groups.map((group) => group.label).sort(),
    [...largeProjects].sort(),
  );
  for (const group of [...generalSection.groups, ...projectSection.groups]) {
    assert.equal(group.count, `${group.total} ${group.total === 1 ? "agreement" : "agreements"}`);
    assert.ok(group.shown <= 4, `${group.label} shows a few, not all ${group.total}`);
    assert.equal(group.toggle, group.total > 4 ? `Show all ${group.total}` : null);
  }
  assert.ok(generalSection.groups.length >= 4, "general agreements fall into several plain groups");
  assert.ok(
    generalSection.groups.every((group) => !group.label.includes(">")),
    "group headings are plain names, not paths",
  );
  assert.deepEqual(layout.notes, {
    open: false,
    summary: `${LARGE.oneTime} one-time notes`,
    items: LARGE.oneTime,
  });
  assert.equal(layout.count, `${total} agreements`);
  assert.deepEqual(layout.listSections, ["General", "For specific projects"]);
  assert.equal(layout.listNotes, false);
  await assertNothingCut("large overview at 1280px");
  await screenshot("large-preferences-overview-1280-light");

  // One click opens a group; the one-time notes open behind their disclosure.
  await evaluate('document.querySelector("#guide .group-toggle").click()');
  await evaluate('document.querySelector("#guide .one-time-notes summary").click()');
  await settle();
  layout = await largeLayout();
  const opened = layout.sections[0].groups.find((group) => group.expanded === "true");
  assert.ok(opened, "a group opened");
  assert.equal(opened.shown, opened.total);
  assert.equal(opened.toggle, "Show fewer");
  assert.equal(layout.notes.open, true);
  await screenshot("large-preferences-group-open");

  // Switching tabs keeps your place: the open group, the notes, and the scroll.
  await evaluate('document.getElementById("viewer").scrollTop = 900');
  const scrolled = await evaluate('document.getElementById("viewer").scrollTop');
  assert.ok(scrolled > 600, `the overview is long enough to scroll (${scrolled})`);
  await evaluate('document.getElementById("prompts-tab").click()');
  await settle();
  await evaluate('document.getElementById("preferences-tab").click()');
  await settle();
  layout = await largeLayout();
  assert.ok(
    Math.abs(layout.scroll - scrolled) <= 2,
    `scroll kept: ${layout.scroll} vs ${scrolled}`,
  );
  assert.equal(
    layout.sections[0].groups.find((group) => group.label === opened.label)?.expanded,
    "true",
  );
  assert.equal(layout.notes.open, true);
  // And the item you had open.
  await evaluate('document.querySelector("#guide .agreement-group a").click()');
  await settle();
  const openAgreement = await evaluate("location.hash");
  assert.match(openAgreement, /^#preferences\/agreement\//);
  assert.match(
    await evaluate('document.querySelector("#metadata > span:last-child").textContent'),
    /^General · [^·]+ · (Seen in \d+ sessions?|From \d+ preferences?)$/,
  );
  assertPlainWords(
    "agreement detail",
    await evaluate(`${PROSE}(document.getElementById("viewer"))`),
  );
  await evaluate('document.getElementById("prompts-tab").click()');
  await settle();
  assert.equal(await evaluate("location.hash"), "#prompts");
  await evaluate('document.getElementById("preferences-tab").click()');
  await settle();
  assert.equal(await evaluate("location.hash"), openAgreement);
  // Choosing the tab you are on goes back to its overview.
  await evaluate('document.getElementById("preferences-tab").click()');
  await settle();
  assert.equal(await evaluate("location.hash"), "#preferences");

  // Keyboard: the first Tab reaches the skip link, and it moves focus to the content.
  await call("Page.reload");
  await until(
    () => evaluate('document.querySelector("#guide section.overview") !== null'),
    "large overview after a reload",
  );
  await settle();
  for (const type of ["keyDown", "keyUp"]) {
    await call("Input.dispatchKeyEvent", {
      type,
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
  }
  assert.equal(await evaluate("document.activeElement.id"), "skip-link");
  assert.ok(
    (await evaluate('document.getElementById("skip-link").getBoundingClientRect().top')) >= 0,
    "the focused skip link is visible",
  );
  await screenshot("large-skip-link-focused");
  await call("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    text: "\r",
  });
  await call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await settle();
  assert.equal(await evaluate("document.activeElement.id"), "title");
  assert.equal(
    await evaluate("location.hash"),
    "#preferences",
    "the skip link leaves the address alone",
  );

  // Refresh says it worked.
  await evaluate('document.getElementById("refresh").click()');
  await until(
    () => evaluate('/read again at/.test(document.getElementById("refresh-status").textContent)'),
    "refresh confirmation",
  );

  // The grouped overview in both themes at 1280 and 360px, nothing cut off.
  for (const theme of ["light", "dark"]) {
    await call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    for (const width of [1280, 360]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await evaluate('document.getElementById("overview-button").click(); window.scrollTo(0,0);');
      await settle();
      await checkGuide("Preferences guide", { highlights: [3, 3] });
      await assertNothingCut(`large overview at ${width}px in ${theme}`);
      assert.equal(
        await evaluate("document.documentElement.scrollWidth <= innerWidth"),
        true,
        `large overview at ${width}px in ${theme} scrolls sideways`,
      );
      assertPlainWords("large page", await evaluate(`${PROSE}(document.body)`));
      await screenshot(`large-preferences-overview-${width}-${theme}`);
      overviews.push(`large preferences ${theme} ${width}px`);
    }
  }
  await call("Emulation.clearDeviceMetricsOverride");
  assert.equal(errors.length, 0, JSON.stringify(errors));

  // An unfinished set: one plain line with the command that finishes it, above
  // the agreements that exist, which still show.
  const largeSaved = JSON.parse(
    fs.readFileSync(path.join(largeHome, kit.GENERALIZED_PATH), "utf8"),
  );
  kit.writeGeneralized(largeHome, {
    ...largeSaved,
    incomplete: { windows_failed: 2, candidates_not_covered: 30 },
  });
  await evaluate('document.getElementById("refresh").click()');
  await until(
    () => evaluate('document.querySelector("#guide .notice") !== null'),
    "the unfinished-set line",
  );
  const unfinished = await evaluate(`(() => {
    const box = document.querySelector("#guide .notice");
    return { text: box.querySelector("p").textContent, command: box.querySelector("code")?.textContent ?? "" };
  })()`);
  assert.equal(
    unfinished.text,
    `${LARGE.preferences} of ${LARGE.preferences + 30} preferences are summarized so far. Run this to finish; finished work is reused:`,
  );
  assert.match(unfinished.command, /^npx human-hindsight@latest distill --home '/);
  const stillShown = await checkGuide("Preferences guide", { highlights: [3, 3] });
  assert.match(
    stillShown.sentence,
    new RegExp(`^${total} working agreements from ${LARGE.preferences} preferences`),
  );
  await screenshot("large-preferences-unfinished-1280-dark");
  kit.writeGeneralized(largeHome, largeSaved);

  // The general agreements say how they are grouped.
  await open(large, "preferences");
  await until(
    () => evaluate('document.querySelector("#guide .agreement-section") !== null'),
    "large overview again",
  );
  assert.equal(
    await evaluate(
      'document.querySelector("#guide .agreement-section .section-note")?.textContent',
    ),
    "Grouped by the kind of work where each was seen.",
  );
  assert.equal(await evaluate('document.querySelectorAll("#guide .section-note").length'), 1);

  // An upgraded library: current prompts first, the earlier ones apart.
  const upgraded = await startGui(upgradedHome);
  const currentTitles = upgradedTitles.slice(0, 2);
  const earlierTitles = upgradedTitles.slice(2);
  for (const theme of ["light", "dark"]) {
    await call("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    for (const width of [1280, 360]) {
      await call("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await open(upgraded, "prompts");
      const shown = await evaluate(`(() => ({
        count: document.getElementById("count").textContent,
        note: document.getElementById("count-note").hidden ? null : document.getElementById("count-note").textContent,
        current: [...document.querySelectorAll("#list > .entry .entry-title")].map(el => el.textContent),
        earlier: [...document.querySelectorAll("#list .list-earlier .entry-title")].map(el => el.textContent),
        earlierOpen: document.querySelector("#list .list-earlier")?.open ?? null,
        summary: document.querySelector("#list .list-earlier summary")?.textContent ?? null,
      }))()`);
      assert.equal(shown.count, "2 prompts");
      assert.equal(shown.note, "3 earlier prompts kept from before the last regrouping");
      assert.equal(shown.earlierOpen, false);
      assert.equal(shown.summary, "3 earlier prompts");
      assert.deepEqual([...shown.current].sort(), [...currentTitles].sort());
      assert.deepEqual([...shown.earlier].sort(), [...earlierTitles].sort());
      const guide = await checkGuide("Prompts guide", { highlights: [1, 2] });
      for (const row of guide.rows) {
        assert.ok(
          currentTitles.includes(row.link),
          `Start here shows an earlier prompt: ${row.link}`,
        );
      }
      assert.deepEqual(
        await evaluate(
          '[...document.querySelectorAll("body *")].filter(el => { if (!el.checkVisibility() || el.getBoundingClientRect().right <= innerWidth + 1) return false; for (let up = el.parentElement; up; up = up.parentElement) { if (getComputedStyle(up).overflowX !== "visible" && up.getBoundingClientRect().right <= innerWidth + 1) return false; } return true; }).map(el => el.id || el.className || el.tagName).slice(0, 8)',
        ),
        [],
        `upgraded library at ${width}px in ${theme}: wider than the screen`,
      );
      await screenshot(`upgraded-prompts-${width}-${theme}`);
      // An earlier prompt says what it is and names the prune command for this home.
      await evaluate(
        'document.querySelector("#list .list-earlier summary").click(); document.querySelector("#list .list-earlier .entry").click()',
      );
      await settle();
      const notice = await evaluate(`(() => {
        const box = document.getElementById("earlier-notice");
        return { hidden: box.hidden, text: box.querySelector("p")?.textContent, command: box.querySelector("code")?.textContent };
      })()`);
      assert.equal(notice.hidden, false);
      assert.match(notice.text, /^This prompt is from an earlier grouping of your sessions\./);
      assert.equal(notice.command, `npx human-hindsight@latest prune --home '${upgradedHome}'`);
      await screenshot(`upgraded-earlier-prompt-${width}-${theme}`);
      // A current prompt carries no such line.
      await evaluate('document.querySelector("#list > .entry").click()');
      await settle();
      assert.equal(await evaluate('document.getElementById("earlier-notice").hidden'), true);
    }
  }
  // Search still finds earlier prompts and says which they are.
  await evaluate(
    'document.getElementById("search").value="tidy"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
  await settle();
  assert.deepEqual(
    await evaluate(`(() => ({
      note: document.getElementById("count-note").textContent,
      open: document.querySelector("#list .list-earlier")?.open,
      tail: document.querySelector("#list .list-earlier .entry-meta-tail")?.textContent,
    }))()`),
    { note: "1 of 3 earlier prompts match", open: true, tail: "Earlier · 1 session" },
  );
  await call("Emulation.clearDeviceMetricsOverride");
  assert.equal(errors.length, 0, JSON.stringify(errors));

  // Every request: /api ones carry the key in a header, and no address contains it.
  const tokens = [legacy.token, guided.token, large.token, upgraded.token];
  const sent = network.filter((entry) => /^https?:/.test(entry.url));
  assert.ok(sent.length > 20, `recorded ${sent.length} requests`);
  for (const entry of sent) {
    for (const token of tokens) assert.ok(!entry.url.includes(token), `key in ${entry.url}`);
    const server = [legacy, guided, large, upgraded].find((candidate) =>
      entry.url.startsWith(`${candidate.base}/`),
    );
    assert.ok(server, `external request: ${entry.url}`);
    if (new URL(entry.url).pathname.startsWith("/api/")) {
      // Also after a reload, every request carries this server's key.
      const key = entry.headers["x-hindsight-token"] ?? entry.headers["X-Hindsight-Token"];
      assert.equal(key, server.token, `${entry.url} sent a wrong key or none`);
    }
  }
  const apiRequests = sent.filter((entry) => new URL(entry.url).pathname.startsWith("/api/"));
  assert.ok(apiRequests.length > 10);

  // An empty library guides to the bare command.
  fs.renameSync(path.join(home, "library"), path.join(home, "library-saved"));
  await open(legacy);
  await until(() => evaluate('document.querySelector("#guide .notice") !== null'), "empty library");
  assert.match(
    await evaluate('document.querySelector("#guide .notice code").textContent'),
    /^npx human-hindsight@latest --home /,
  );
  assert.match(
    await evaluate('document.querySelector("#guide .notice p").textContent'),
    /There are no prompts yet/,
  );
  await screenshot("desktop-empty-library");
  await evaluate('document.getElementById("preferences-tab").click()');
  assert.match(
    await evaluate('document.querySelector("#guide .notice p").textContent'),
    /No preferences have been found yet/,
  );
  assert.equal(await evaluate('document.getElementById("all-preferences").disabled'), true);
  fs.renameSync(path.join(home, "library-saved"), path.join(home, "library"));

  // After a restart on the same port, the old tab's key is refused: it is
  // forgotten, and the page names the command that reopens this library.
  const beforeRestart = await startGui(home);
  await open(beforeRestart);
  assert.ok((await evaluate('document.querySelectorAll(".entry").length')) > 0);
  await stopGui(beforeRestart);
  const restarted = await startGui(home, { port: new URL(beforeRestart.base).port });
  assert.equal(restarted.base, beforeRestart.base, "restarted on the same port");
  assert.notEqual(restarted.token, beforeRestart.token, "a restart makes a new key");
  await call("Page.reload");
  await until(
    () => evaluate('document.getElementById("notice").hidden === false'),
    "recovery text after a restart",
  );
  assert.match(
    await evaluate('document.querySelector("#notice p").textContent'),
    /library was restarted.*Open the new address printed in your terminal\./,
  );
  assert.match(
    await evaluate('document.querySelector("#notice code").textContent'),
    /^npx human-hindsight@latest gui --home '/,
  );
  assert.equal(await evaluate('document.querySelectorAll(".entry").length'), 0);
  assert.equal(await evaluate('sessionStorage.getItem("human-hindsight.session-key")'), null);
  await screenshot("desktop-restarted-library");
  // Opening the new printed address in the same tab brings the library back.
  await call("Page.navigate", { url: restarted.address() });
  await until(
    () => evaluate('document.querySelectorAll(".entry").length > 0'),
    "library after opening the new address",
  );
  assert.equal(await evaluate('document.getElementById("notice").hidden'), true);
  assert.equal(await evaluate("location.href.includes('token')"), false);
  // Opening the browser: the launcher gets an owner-only file in the data home,
  // never the address, because process arguments are readable by every local
  // user. The page redirects to the address and the file is gone once it loads.
  const openerLog = path.join(scratch, "opener-arguments.txt");
  const launched = await startGui(home, { opener: openerLog });
  await until(() => /Opened in your browser\./.test(launched.stdout), "browser opened");
  const launcherArgs = fs.readFileSync(openerLog, "utf8").trimEnd().split("\n");
  assert.equal(launcherArgs.length, 1, `one launcher argument: ${launcherArgs}`);
  const [redirectFile] = launcherArgs;
  assert(!redirectFile.includes(launched.token), "the launcher never sees the session key");
  assert.equal(path.dirname(redirectFile), home, "the file lives in the data home");
  assert.equal(fs.statSync(redirectFile).mode & 0o777, 0o600, "the file is owner-only");
  await call("Page.navigate", { url: pathToFileURL(redirectFile).href });
  await until(
    () => evaluate('document.querySelectorAll(".entry").length > 0'),
    "library after the redirect file",
  );
  assert.equal(await evaluate("location.origin"), launched.base);
  assert.equal(await evaluate("location.href.includes('token')"), false);
  await until(() => !fs.existsSync(redirectFile), "redirect file removed after the page loaded");
  await stopGui(launched);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log(
    JSON.stringify(
      {
        result: "passed",
        checks: [
          "session key: printed in the fragment, removed from the address bar, sent as a header on every /api request, never in a request address",
          "opening the browser: the launcher gets only an owner-only redirect file, removed once the page loads",
          "refused without the key, with a wrong key, a key in the query string, a rebinding Host, or a cross-site Origin (on the wire)",
          "a reload keeps the library; a second tab opened without the fragment gets no key",
          "after a restart the old tab forgets its refused key and names the command to run",
          "first visit lands on Prompts without a suggestion and on Subagents with one",
          "each overview: one sentence, 2 or 3 highlights with reasons, one action, a labelled region",
          "tab activation moves focus to the panel heading",
          "agreement drill-down to the preferences behind it and their quotations",
          `a library of ${LARGE.general + LARGE.project + LARGE.oneTime} agreements: grouped overview, true counts, a group opens, one-time notes behind one disclosure, at 1280 and 360px in both themes, nothing cut off`,
          "switching tabs keeps the open item, the open groups, and the scroll",
          "the skip link is the first Tab stop and moves focus to the content",
          "one export action whose label names what it downloads",
          "a stale suggestion marks the agreements whose source was dismissed",
          "no undefined jargon in the visible text",
          "an upgraded library counts current prompts apart from earlier ones, keeps the earlier ones behind one disclosure, never highlights them, and names the prune command, at 1280 and 360px in both themes",
          "general agreements say they are grouped by the kind of work where each was seen",
          "an unfinished set says how many preferences are summarized and names the command that finishes it",
          "stale agreements and a stale suggestion are labelled out of date",
          "export zip downloads and equals the served zip",
          "Markdown headings/lists/tables/code/tasks",
          "safe links and inert HTML/images",
          "source preview and exact Markdown copy",
          "monochrome monospace theme",
          "browse, search, sort, copy, copy fallback",
          "preference Markdown, evidence, and links in both directions",
          "preference search, remembered filters, and bookmarks",
          "hierarchical parent filters and five-level domain tree",
          "case-insensitive domain dedupe and grouped context",
          "domain popup keyboard focus and arrow gutters",
          "copy accepted preferences and saved consolidation",
          "saved consolidation freshness",
          "help topics: privacy link and copyable commands, nothing rotates",
          "copyable commands quote any home path",
          "literal markup",
          "refresh",
          "empty library points at the bare command",
          process.env.GUI_HEADED === "1"
            ? "both tabs' dropdowns opened in light/dark at 360px"
            : "both tabs' dropdown layouts checked in light/dark at 360px",
          `overviews in both themes at 1280, 900, and 360px (${overviews.length} views)`,
          "no external requests",
        ],
        measurements,
        screenshots: pictures,
      },
      null,
      2,
    ),
  );
  await call("Browser.close").catch(() => {});
} finally {
  ws?.close();
  chrome?.kill("SIGTERM");
  for (const server of servers) await stopGui(server);
}
