import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVACY_REMINDER } from "../src/core/privacy.js";
import { GUI_HTML, GUI_JS } from "../src/gui/assets.js";
import {
  PLAIN_GUI_COMMAND,
  SESSION_HEADER,
  sessionFragment,
  splitFragment,
} from "../src/gui/session.js";
import { bundleSources } from "./support/bundle-guard.js";

/**
 * The page as it ships: the generated bundle (`npm run build`), checked
 * against the current client sources. The vitest global setup already stops
 * the run when the bundle is older than its sources; the first test below
 * also fails on a bundle built from older client code, because these strings
 * exist only in the current client.
 */

const ROOT = path.resolve(import.meta.dirname, "..");

describe("the built page script", () => {
  it("is built from the current client", () => {
    expect(GUI_JS).toContain(SESSION_HEADER);
    expect(GUI_JS).toContain(PLAIN_GUI_COMMAND);
    expect(GUI_JS).toContain("Prompts guide");
    expect(GUI_JS).toContain("Download all targets (zip)");
    expect(GUI_JS).toContain("General agreements");
    expect(GUI_JS).toContain("Grouped by the kind of work where each was seen.");
    expect(GUI_JS).toContain("kept from before the last regrouping");
  });

  it("counts in plain words, never with an (s) plural", () => {
    // Words in running text, not minified calls such as `f(s)`.
    expect(GUI_JS).not.toMatch(/ [a-z]+\(s\)[ .,:;]/);
    // The skipped-files line counts with countLabel and names the exact status command.
    expect(GUI_JS).toContain("could not be read. Run this for details: ");
  });

  it("has no timer-driven rotation", () => {
    expect(GUI_JS).not.toMatch(/setInterval/);
    expect(GUI_JS).not.toMatch(/requestAnimationFrame/);
    // Two one-shot timers: the copy button label reset and the export URL cleanup.
    expect(GUI_JS.match(/setTimeout\(/g) ?? []).toHaveLength(2);
  });

  it("carries no renderer or schema code", () => {
    for (const marker of [
      // core/subagents-render.ts
      "Refusing to render a path outside the tree",
      "kirocrew agent create",
      // core/subagents.ts and core/generalized.ts schemas
      "must be kebab-case",
      "needs at least one source id",
      "The agreement list differs from its saved windows",
      // zod itself
      "ZodError",
      "$ZodType",
    ]) {
      expect(GUI_JS, marker).not.toContain(marker);
    }
  });

  it("names no remote address it could fetch", () => {
    const addresses = [...new Set(GUI_JS.match(/https?:\/\/[^"'`\s)\\]+/g) ?? [])].sort();
    expect(addresses).toEqual(
      [
        // XML namespaces for SVG icons and the sanitizer.
        "http://www.w3.org/1998/Math/MathML",
        "http://www.w3.org/1999/xhtml",
        "http://www.w3.org/2000/svg",
        // License notices kept by the bundler.
        "https://github.com/babel/babel/blob/main/packages/babel-helpers/LICENSE",
        "https://github.com/markedjs/marked.",
        // The project link in the privacy help topic, opened only by a click.
        "https://github.com/adityaarunsinghal/human-hindsight",
      ].sort(),
    );
  });

  it("uses innerHTML only for the static icon markup", () => {
    const sources = bundleSources(ROOT).filter((file) => file.startsWith("src/"));
    expect(sources).toContain("src/gui/client.ts");
    const users = sources.filter((file) =>
      fs.readFileSync(path.join(ROOT, file), "utf8").includes("innerHTML"),
    );
    expect(users).toEqual(["src/gui/icons.ts"]);
    expect(fs.readFileSync(path.join(ROOT, "src/gui/icons.ts"), "utf8")).toContain(
      "template.innerHTML = iconMarkup(name);",
    );
  });

  it("imports only types from the server, the schemas, and the renderer", () => {
    const sources = bundleSources(ROOT);
    for (const forbidden of [
      "src/gui/server.ts",
      "src/gui/highlights.ts",
      "src/core/subagents.ts",
      "src/core/subagents-render.ts",
      "src/core/generalized.ts",
    ]) {
      expect(sources, forbidden).not.toContain(forbidden);
    }
  });
});

describe("the page wording", () => {
  it('says "coding tool", "prompt", and "model", never "harness", "oneshot", or "LLM"', () => {
    const shown = [GUI_HTML, GUI_JS]
      .join("\n")
      // The topic classifier matches the word in prompt text; it is never shown.
      .replace("|ai|llm|model)", "|ai|model)")
      // Shared privacy text, worded outside the page code (see the open item).
      .replace(PRIVACY_REMINDER, "");
    expect(shown).not.toMatch(/harness|one-?shot|\bllms?\b/i);
  });
});

describe("the page markup", () => {
  it("downloads the export through a button, not a plain link the key cannot follow", () => {
    expect(GUI_HTML).toContain('<button id="export-all" class="button-link primary" type="button"');
    expect(GUI_HTML).not.toContain("/api/subagents/export.zip");
    expect(GUI_HTML).toContain('id="export-status"');
  });

  it("has a Refresh control that reads the library again in place", () => {
    expect(GUI_HTML).toContain('<button id="refresh"');
  });

  it("lets the panel heading take focus when a tab is activated", () => {
    expect(GUI_HTML).toContain('<h1 id="title" tabindex="-1">');
  });

  it("starts with a link that skips to the content", () => {
    expect(GUI_HTML.indexOf('id="skip-link"')).toBeGreaterThan(GUI_HTML.indexOf("<body>"));
    expect(GUI_HTML.indexOf('id="skip-link"')).toBeLessThan(GUI_HTML.indexOf("<header"));
  });

  it("names every review action in words beside its icon", () => {
    for (const [id, words] of [
      ["accept-preference", "Accept"],
      ["edit-preference", "Edit"],
      ["dismiss-preference", "Dismiss"],
      ["reset-preference", "Review again"],
    ]) {
      expect(GUI_HTML).toMatch(new RegExp(`id="${id}"[^>]*>[^]*?<span>${words}</span></button>`));
    }
  });
});

describe("the session fragment", () => {
  const key = "c".repeat(64);
  it.each([
    ["", `token=${key}`],
    ["preferences", `preferences&token=${key}`],
    ["subagents/role/docs-editor", `subagents/role/docs-editor&token=${key}`],
    ["prompts/a%26b", `prompts/a%26b&token=${key}`],
  ])("route %j round-trips through %j", (route, fragment) => {
    expect(sessionFragment(route, key)).toBe(fragment);
    expect(splitFragment(`#${fragment}`)).toEqual({ token: key, route });
    expect(splitFragment(fragment)).toEqual({ token: key, route });
  });

  it.each([
    ["", { token: null, route: "" }],
    ["#preferences", { token: null, route: "preferences" }],
    ["#token=", { token: null, route: "" }],
    ["#prompts/token-budget", { token: null, route: "prompts/token-budget" }],
    ["#token=abc&preferences", { token: null, route: "token=abc&preferences" }],
  ])("%j gives %o", (hash, expected) => {
    expect(splitFragment(hash)).toEqual(expected);
  });
});
