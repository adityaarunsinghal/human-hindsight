import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cch-gui-browser-"));
const pictures = path.join(scratch, "screenshots");
fs.mkdirSync(pictures);
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
let cli;
let chrome;
let ws;
let url;
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
try {
  cli = spawn(process.execPath, [path.resolve("dist/cli.js"), "gui", "--home", home, "--no-open"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  cli.stdout.on("data", (data) => {
    url ??= data.toString().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  });
  await until(() => !!url, "GUI startup");
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
      network.push(message.params.request.url);
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
  async function setTipExpanded(expanded) {
    await evaluate(`(() => {
      const button = document.getElementById("tip-toggle");
      if ((button.getAttribute("aria-expanded") === "true") !== ${expanded}) button.click();
    })()`);
    await settle();
  }
  async function stepTip(amount) {
    const before = await evaluate(
      'Number(document.getElementById("tip-number").textContent.match(/[0-9]+/)[0])',
    );
    await evaluate(
      `document.getElementById("${amount > 0 ? "next-tip" : "previous-tip"}").click()`,
    );
    const expected = ((before - 1 + amount + 10) % 10) + 1;
    await until(
      () =>
        evaluate(
          `document.getElementById("tip-number").textContent === "Tip ${expected}/10" && document.getElementById("tip-face").getAnimations().length === 0`,
        ),
      "tip transition",
    );
  }
  async function reloadPage() {
    const previous = await evaluate("window.__documentId");
    await call("Page.reload");
    await until(
      () =>
        evaluate(
          `window.__documentId !== ${JSON.stringify(previous)} && (document.querySelector(".entry") !== null || document.getElementById("empty")?.hidden === false)`,
        ),
      "reloaded library",
    );
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
  await call("Emulation.setFocusEmulationEnabled", { enabled: true });
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__documentId = Math.random(); Object.defineProperty(navigator, "clipboard", {configurable:true, value:{writeText:async(text)=>{window.__copied=text;}}});
      const originalInterval = window.setInterval.bind(window);
      window.setInterval = (callback, delay, ...args) => {
        if (delay === 14000) window.__rotateTip = () => callback(...args);
        return originalInterval(callback, delay, ...args);
      };`,
  });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await call("Page.navigate", { url });
  await call("Page.bringToFront");
  await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
  await until(
    () => evaluate('document.querySelectorAll(".entry").length === 4'),
    "library content",
  );
  await settle();
  assert.equal(await evaluate('document.getElementById("tip-number").textContent'), "Tip 1/10");
  assert.equal(await evaluate('document.getElementById("tip-details").hidden'), true);
  assert.equal(
    await evaluate('document.querySelector(".topbar").getBoundingClientRect().height'),
    53,
  );
  assert.equal(
    await evaluate('document.querySelector("#tip-text a").href'),
    "https://github.com/adityaarunsinghal/human-hindsight",
  );
  assert.equal(
    await evaluate(
      'document.getElementById("tip-text").textContent.includes("configured provider")',
    ),
    true,
  );
  await setTipExpanded(true);
  await screenshot("desktop-privacy-tip");
  await setTipExpanded(false);
  // Advance the registered timer callback deterministically, with focus outside
  // the bar. Native window activation and wall-clock timing are not the feature.
  await evaluate('document.getElementById("title").focus(); window.__rotateTip()');
  await until(
    () =>
      evaluate(
        'document.getElementById("tip-number").textContent === "Tip 2/10" && document.getElementById("tip-face").getAnimations().length === 0',
      ),
    "automatic tip rotation",
  );
  await stepTip(-1);
  await setTipExpanded(true);
  await stepTip(1);
  await evaluate('document.getElementById("copy-tip").click()');
  await until(() => evaluate("window.__copied !== undefined"), "tip command copy");
  assert.match(
    await evaluate("window.__copied"),
    /^npx human-hindsight@latest preferences --home /,
  );
  await evaluate("window.__copied=undefined");
  await stepTip(1);
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
  await evaluate('document.getElementById("pause-tips").click()');
  assert.equal(
    await evaluate('document.getElementById("pause-tips").getAttribute("aria-pressed")'),
    "true",
  );
  const pausedTip = await evaluate('document.getElementById("tip-number").textContent');
  await setTipExpanded(false);
  await evaluate('document.getElementById("title").focus(); window.__rotateTip()');
  assert.equal(await evaluate('document.getElementById("tip-number").textContent'), pausedTip);
  await evaluate('document.getElementById("hide-tips").click()');
  assert.equal(await evaluate('document.getElementById("tips").hidden'), true);
  assert.equal(await evaluate('document.getElementById("show-tips").hidden'), false);
  assert.equal(
    await evaluate('document.querySelector(".brand").firstChild.textContent.trim()'),
    "Human Hindsight",
  );
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
  assert.equal(
    await evaluate(
      'document.querySelectorAll("#domain-menu > .domain-tree > .domain-node").length',
    ),
    1,
  );
  assert.equal(await evaluate('document.getElementById("sort").value'), "frequency");
  assert.equal(
    await evaluate('document.getElementById("copy").getAttribute("aria-label")'),
    "Review candidates first",
  );
  assert.equal(await evaluate('document.getElementById("copy").disabled'), true);
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
      evaluate(
        'document.getElementById("accept-preference").getAttribute("aria-label") === "Accepted preference"',
      ),
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
    () => evaluate('document.getElementById("review-summary").textContent.includes("accepted")'),
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
  let snapshot = await (await fetch(`${url}/api/library`)).json();
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
    () => evaluate('document.getElementById("review-summary").textContent.includes("dismissed")'),
    "dismiss preference",
  );
  assert.equal(await evaluate('document.getElementById("copy").disabled'), true);
  await evaluate('document.getElementById("reset-preference").click()');
  await until(
    () => evaluate('document.getElementById("review-summary").textContent.includes("pending")'),
    "return preference to review",
  );
  await evaluate('document.getElementById("accept-preference").click()');
  await until(
    () =>
      evaluate(
        'document.getElementById("accept-preference").getAttribute("aria-label") === "Accepted preference"',
      ),
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
  snapshot = await (await fetch(`${url}/api/library`)).json();
  assert.equal(
    await evaluate('document.getElementById("source").value'),
    snapshot.acceptedMarkdown,
  );
  await evaluate(`location.hash=${JSON.stringify(preferenceBookmark)}`);
  await until(
    () => evaluate('document.getElementById("source").value.includes("focused tests")'),
    "preference bookmark",
  );
  await reloadPage();
  await until(
    () => evaluate('document.getElementById("source")?.value.includes("focused tests")'),
    "reloaded preference bookmark",
  );
  assert.equal(await evaluate('document.getElementById("tips").hidden'), true);
  await evaluate('document.getElementById("show-tips").click()');
  await setTipExpanded(true);
  assert.equal(await evaluate('document.getElementById("tip-number").textContent'), "Tip 1/10");
  await evaluate('document.getElementById("hide-tips").click()');
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
  await reloadPage();
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
  await reloadPage();
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
          '[...document.querySelectorAll("select,#domain")].filter(el => !el.closest("[hidden]")).map(el => { const s=getComputedStyle(el); const r=el.getBoundingClientRect(); return {id:el.id,tag:el.tagName,value:el.value,appearance:s.appearance,paddingRight:s.paddingRight,backgroundSize:s.backgroundSize,backgroundPosition:s.backgroundPosition,backgroundImage:s.backgroundImage,textOverflow:s.textOverflow,x:r.x,y:r.y,width:r.width,height:r.height}; })',
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
  assert.deepEqual(
    network.filter((value) => /^https?:/.test(value) && !value.startsWith(`${url}/`)),
    [],
  );
  await evaluate(
    'document.getElementById("prompts-tab").click(); document.getElementById("search").value="pagination"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
  await selectDomain([]);
  fs.writeFileSync(
    path.join(home, "library/users-pagination/users-pagination.oneshot.md"),
    "# Add pagination to the users endpoint\n\nA refreshed pagination prompt.",
  );
  await reloadPage();
  await until(
    () =>
      evaluate(
        'document.getElementById("body").textContent.trim() === "A refreshed pagination prompt."',
      ),
    "refresh",
  );
  fs.renameSync(path.join(home, "library"), path.join(home, "library-saved"));
  await reloadPage();
  await until(() => evaluate('document.getElementById("empty").hidden === false'), "empty library");
  assert.equal(await evaluate('document.getElementById("copy").disabled'), true);
  await evaluate('document.getElementById("preferences-tab").click()');
  assert.equal(
    await evaluate('document.getElementById("empty-title").textContent'),
    "No preferences yet",
  );
  assert.equal(await evaluate('document.getElementById("all-preferences").disabled'), true);
  assert.equal(await evaluate('document.getElementById("copy").disabled'), true);
  console.log(
    JSON.stringify(
      {
        result: "passed",
        checks: [
          "Markdown headings/lists/tables/code/tasks",
          "safe links and inert HTML/images",
          "source preview and exact Markdown copy",
          "monochrome monospace theme",
          "browse",
          "search",
          "sort",
          "copy exact body",
          "copy fallback",
          "preference Markdown, evidence, and links in both directions",
          "preference search, remembered filters, and bookmarks",
          "hierarchical parent filters and five-level domain tree",
          "case-insensitive domain dedupe and grouped context",
          "domain popup keyboard focus and arrow gutters",
          "copy accepted preferences and saved consolidation",
          "saved consolidation freshness",
          "linked privacy reminder and copyable npx tips",
          "compact animated tips pause, hide, restore, and remember visibility",
          "literal markup",
          "refresh",
          "empty library",
          process.env.GUI_HEADED === "1"
            ? "both tabs' dropdowns opened in light/dark at 360px"
            : "both tabs' dropdown layouts checked in light/dark at 360px",
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
  if (cli && cli.exitCode === null) {
    const closed = new Promise((resolve) => cli.once("exit", resolve));
    cli.kill("SIGTERM");
    await Promise.race([closed, delay(3000)]);
    assert.notEqual(cli.exitCode, null, "GUI did not stop on SIGTERM");
  }
}
