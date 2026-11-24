import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runList } from "../src/commands/list.js";
import { counted, hint, nounFor } from "../src/ui/style.js";
import { closestMatch, closestMatches, editDistance, isCloseMatch } from "../src/ui/suggest.js";
import { fitLines, sayThenRun, wrapText } from "../src/ui/wrap.js";
import { type BuiltHome, homeBuilder } from "./support/home.js";
import { goldenText } from "./support/text.js";
import { fakeOutput } from "./support/tty.js";

/**
 * Words on screen: the one prose wrapper, the next-command hint, close-match
 * suggestions, and the library table that never shortens the name a person
 * types next.
 */

const homes: BuiltHome[] = [];
afterEach(() => {
  while (homes.length) homes.pop()?.remove();
  vi.unstubAllEnvs();
});

describe("counted", () => {
  it.each([
    [0, "session", undefined, "0 sessions"],
    [1, "session", undefined, "1 session"],
    [2, "batch", "batches", "2 batches"],
    [1234, "session", undefined, "1,234 sessions"],
  ])("%d %s", (n, noun, many, expected) => {
    expect(counted(n, noun, many)).toBe(expected);
    expect(nounFor(n, noun, many)).toBe(expected.split(" ").slice(1).join(" "));
  });
});

describe("wrapText", () => {
  it.each([
    ["fits", "one two three", 20, ["one two three"]],
    ["breaks between words", "one two three", 8, ["one two", "three"]],
    [
      "keeps a long word whole",
      "see https://example.invalid/a/very/long/path now",
      10,
      ["see", "https://example.invalid/a/very/long/path", "now"],
    ],
    ["keeps the leading indent", "  one two three", 9, ["  one two", "  three"]],
    [
      "treats a line break or tab inside the text as a space",
      "one\ntwo\tthree",
      20,
      ["one two three"],
    ],
  ] as [string, string, number, string[]][])("%s", (_name, text, width, lines) => {
    expect(wrapText(text, width)).toEqual(lines);
    for (const line of lines.filter((l) => !l.includes("https"))) {
      expect(line.length).toBeLessThanOrEqual(width);
    }
  });

  it("measures visible width, so color takes no room", () => {
    const red = "\u001b[31mred\u001b[39m";
    expect(wrapText(`${red} ${red} ${red}`, 7).map(stripVTControlCharacters)).toEqual([
      "red red",
      "red",
    ]);
  });

  it("a command is alone on its own line and never broken, even when wider than the terminal", () => {
    const command = "human-hindsight distill --home=/a/very/long/data/home/path --quality=best";
    const lines = sayThenRun("Your progress is saved. To continue, run:", command, 30);
    expect(lines.at(-1)).toBe(`  ${command}`);
    expect(lines.slice(0, -1).every((line) => line.length <= 30)).toBe(true);
  });
});

describe("fitLines", () => {
  it("wraps prose at words, two columns in, and leaves a command whole", () => {
    const long = "  5 earlier exports removed because their sessions no longer exist";
    const command =
      "    human-hindsight gui --home=/a/very/long/folder/that/is/wider --tab=preferences";
    const lines = fitLines([long, command, "short"], 40);
    expect(lines).toEqual([
      "  5 earlier exports removed because",
      "    their sessions no longer exist",
      command,
      "short",
    ]);
  });

  it("keeps the indent of a dimmed line, and changes nothing in a pipe", () => {
    const dimmed = "\u001b[2m  one two three four five six\u001b[22m";
    expect(fitLines([dimmed], 16).map(stripVTControlCharacters)).toEqual([
      "  one two three",
      "    four five",
      "    six",
    ]);
    expect(fitLines([dimmed, "a\nb"], undefined)).toEqual([dimmed, "a", "b"]);
  });
});

describe("hint", () => {
  it.each([
    ["fits on one line", 80, ["→ next: human-hindsight gui --home=/data"]],
    [
      "moves the command to its own line when narrow",
      30,
      ["→ next:", "  human-hindsight gui --home=/data"],
    ],
    ["stays one line in a pipe", undefined, ["→ next: human-hindsight gui --home=/data"]],
  ] as [string, number | undefined, string[]][])("%s", (_name, width, lines) => {
    vi.stubEnv("LANG", "en_US.UTF-8");
    expect(stripVTControlCharacters(hint("human-hindsight gui --home=/data", width))).toBe(
      lines.join("\n"),
    );
  });
});

describe("close-match suggestions", () => {
  it.each([
    ["distil", ["distill", "list"], "distill"],
    ["stauts", ["status", "scan"], "status"],
    ["frobnicate", ["rate", "show", "scan"], undefined],
    ["frob", ["rate", "show", "scan"], undefined],
    ["exprot", ["export", "edit"], "export"],
  ] as [string, string[], string | undefined][])("%s", (typed, names, expected) => {
    expect(closestMatch(typed, names)).toBe(expected);
  });

  it("finds prompt names that hold every typed word, nearest first", () => {
    const names = ["landing-page-polish", "release-notes-workflow", "cli-test-hardening"];
    expect(closestMatches("landing-polish", names)).toEqual(["landing-page-polish"]);
    expect(closestMatches("release", names)).toEqual(["release-notes-workflow"]);
    expect(closestMatches("zzz-nothing", names)).toEqual([]);
    // Every typed word must be there, not just one of them.
    expect(closestMatches("landing-workflow", names)).toEqual([]);
  });

  it("a swap of two letters is one edit, and a close match scales with the length", () => {
    expect(editDistance("soruce", "source")).toBe(1);
    expect(isCloseMatch("abcd", 1)).toBe(true);
    expect(isCloseMatch("abcd", 2)).toBe(false);
    expect(isCloseMatch("abcdefghi", 3)).toBe(true);
    // One or two letters typed are too few to guess from.
    expect(isCloseMatch("ab", 1)).toBe(false);
    expect(closestMatch("z", ["a"])).toBeUndefined();
  });
});

function library(): BuiltHome {
  const home = homeBuilder()
    .session({
      project: "alpha",
      sessionId: "a1111111-0000-4000-8000-000000000001",
      messages: ["Keep the release notes workflow small."],
    })
    .session({
      project: "alpha",
      sessionId: "a2222222-0000-4000-8000-000000000002",
      messages: ["Polish the landing page copy."],
    })
    .session({
      project: "beta",
      sessionId: "b3333333-0000-4000-8000-000000000003",
      messages: ["Harden the command line tests."],
    })
    .digestAll()
    .task({ slug: "release-notes-workflow", members: [0] })
    .task({ slug: "landing-page-polish", members: [1] })
    .task({ slug: "cli-test-hardening", members: [2] })
    .library("release-notes-workflow", { title: "Improve the release notes workflow" })
    .library("landing-page-polish", { title: "Polish the landing page" })
    .library("cli-test-hardening", { title: "Harden the CLI tests" })
    .build();
  homes.push(home);
  return home;
}

function rate(home: BuiltHome, slug: string, rating: "up" | "down"): void {
  const file = home.path(`library/${slug}/sources.json`);
  const sources = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...sources, rating }));
}

describe("list", () => {
  it.each([
    80, 60, 40, 24,
  ])("never shortens a name at %i columns, and nothing is wider", async (columns) => {
    vi.stubEnv("LANG", "en_US.UTF-8");
    const home = library();
    rate(home, "landing-page-polish", "up");
    const output = fakeOutput({ isTTY: true, columns });
    expect(runList({ home: home.dir }, output)).toBe("gui");
    const text = output.text();
    for (const name of ["release-notes-workflow", "landing-page-polish", "cli-test-hardening"]) {
      expect(text).toContain(name);
    }
    for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(columns);
    expect(text).not.toMatch(/slug/i);
    expect(text).toContain("3 prompts");
    await expect(goldenText(text)).toMatchFileSnapshot(`golden/ui/list-${columns}.txt`);
  });

  it("names every column, including the one for your own marks", () => {
    vi.stubEnv("LANG", "en_US.UTF-8");
    const home = library();
    rate(home, "cli-test-hardening", "down");
    fs.appendFileSync(
      home.path("library/landing-page-polish/landing-page-polish.oneshot.md"),
      "\nMine.\n",
    );
    const output = fakeOutput({ isTTY: true, columns: 200 });
    runList({ home: home.dir }, output);
    const [header = ""] = output.text().split("\n");
    expect(header.split(/\s{2,}/)).toEqual([
      "Name",
      "Title",
      "Domain",
      "Sessions",
      "Confidence",
      "Written",
      "Notes",
    ]);
    expect(output.text()).toContain("rated down");
    expect(output.text()).toContain("edited");
  });

  it("says in the Notes column when a prompt's outcome was not verified", () => {
    vi.stubEnv("LANG", "en_US.UTF-8");
    const home = library();
    const file = home.path("library/cli-test-hardening/sources.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), outcome_verified: false }),
    );
    // The mark alone brings the column.
    const output = fakeOutput({ isTTY: true, columns: 200 });
    runList({ home: home.dir }, output);
    const lines = output.text().split("\n");
    expect(lines[0]).toContain("Notes");
    const row = (slug: string) => lines.find((line) => line.startsWith(slug)) ?? "";
    expect(row("cli-test-hardening")).toMatch(/outcome not verified$/);
    // An older file without the field reads as verified.
    expect(row("release-notes-workflow")).not.toContain("not verified");
    // Several marks stay apart.
    rate(home, "cli-test-hardening", "down");
    const again = fakeOutput({ isTTY: true, columns: 200 });
    runList({ home: home.dir }, again);
    expect(again.text()).toContain("▼ rated down, outcome not verified");
  });

  it("leaves out the marks column when no prompt has a mark", () => {
    const home = library();
    const output = fakeOutput({ isTTY: true, columns: 200 });
    runList({ home: home.dir }, output);
    expect(output.text().split("\n")[0]).not.toContain("Notes");
  });

  it("a pipe gets every column whole for scripts", () => {
    const home = library();
    const output = fakeOutput({ isTTY: false });
    runList({ home: home.dir }, output);
    expect(output.text()).toContain("Improve the release notes workflow");
    expect(output.text().split("\n")[0]).toContain("Domain");
  });

  it("an empty library points at reflect", () => {
    const output = fakeOutput({ isTTY: false });
    const dir = homeBuilder().build();
    homes.push(dir);
    expect(runList({ home: path.join(dir.dir, "nothing") }, output)).toBe("reflect");
    expect(output.text()).toContain("Your library is empty.");
  });
});
