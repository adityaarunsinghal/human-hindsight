import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "cch-gui-browser-"));
const pictures = path.join(scratch, "screenshots");
fs.mkdirSync(pictures);
console.log(`GUI artifacts: ${pictures}`);
const home = path.join(scratch, "hindsight");
const longDomain = "Platform infrastructure, release engineering, and developer productivity";
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
    "Backend development",
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
      domains: [domain],
      authored_at,
      confidence: "high",
      members: ["one.md", "two.md"],
      rating: slug === "settings-page" ? "up" : null,
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
    { stdio: ["ignore", "ignore", "ignore"] },
  );
  const portFile = path.join(profile, "DevToolsActivePort");
  await until(() => fs.existsSync(portFile), "Chrome debugging port");
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
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Network.enable");
  await call("Page.addScriptToEvaluateOnNewDocument", {
    source:
      'Object.defineProperty(navigator, "clipboard", {configurable:true, value:{writeText:async(text)=>{window.__copied=text;}}});',
  });
  await call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "light" }],
  });
  await call("Page.navigate", { url });
  await until(
    () => evaluate('document.querySelectorAll(".entry").length === 4'),
    "library content",
  );
  await settle();
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
    await evaluate(
      'document.getElementById("domain").value=' +
        JSON.stringify(longDomain) +
        '; document.getElementById("domain").dispatchEvent(new Event("change")); document.getElementById("sort").value="newest"; document.getElementById("sort").dispatchEvent(new Event("change"));',
    );
    await settle();
    const measured = await evaluate(
      '[...document.querySelectorAll("select")].map(el => { const s=getComputedStyle(el); const r=el.getBoundingClientRect(); return {id:el.id,value:el.value,appearance:s.appearance,paddingRight:s.paddingRight,backgroundSize:s.backgroundSize,backgroundPosition:s.backgroundPosition,backgroundImage:s.backgroundImage,textOverflow:s.textOverflow,x:r.x,y:r.y,width:r.width,height:r.height}; })',
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
      assert.ok(item.width > 250);
    }
    assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
    measurements.push({
      theme,
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
    await screenshot(`narrow-${theme}`);
    for (const item of measured) {
      const point = { x: item.x + item.width - 18, y: item.y + item.height / 2 };
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
      await evaluate(
        `(() => { const el=document.getElementById(${JSON.stringify(item.id)}); el.focus(); if (!el.matches(":open")) el.showPicker(); })()`,
      );
      await delay(100);
      // Native picker windows are not exposed by headless Chrome. The headed
      // verification checks their open state; both modes inspect the controls.
      if (process.env.GUI_HEADED === "1") {
        assert.equal(
          await evaluate(`document.getElementById(${JSON.stringify(item.id)}).matches(":open")`),
          true,
          `${item.id} opens in the browser`,
        );
      }
      await screenshot(`${theme}-${item.id}-open`);
      await call("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await call("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
    }
  }
  assert.equal(errors.length, 0, JSON.stringify(errors));
  assert.deepEqual(
    network.filter((value) => /^https?:/.test(value) && !value.startsWith(`${url}/`)),
    [],
  );
  await evaluate(
    'document.getElementById("domain").value=""; document.getElementById("domain").dispatchEvent(new Event("change")); document.getElementById("search").value="pagination"; document.getElementById("search").dispatchEvent(new Event("input"));',
  );
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
  fs.renameSync(path.join(home, "library"), path.join(home, "library-saved"));
  await evaluate('document.getElementById("refresh").click()');
  await until(() => evaluate('document.getElementById("empty").hidden === false'), "empty library");
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
          "literal markup",
          "refresh",
          "empty library",
          process.env.GUI_HEADED === "1"
            ? "both dropdowns opened in light/dark at 360px"
            : "both dropdown layouts checked in light/dark at 360px",
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
