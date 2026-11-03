import { describe, expect, it } from "vitest";
import { buildDigestPrompt } from "../src/claude/prompts/digest.js";
import { domainPath, MAX_DOMAIN_DEPTH, matchesDomain } from "../src/core/domains.js";

describe("hierarchical domains", () => {
  it("groups old flat labels without needing a migration or model call", () => {
    expect(domainPath("Frontend design")).toEqual([
      "Software engineering",
      "Frontend",
      "Frontend design",
    ]);
    expect(domainPath("testing")).toEqual(["Software engineering", "Testing"]);
    expect(domainPath("release engineering")).toEqual([
      "Software engineering",
      "Infrastructure",
      "release engineering",
    ]);
    expect(domainPath("documentation")).toEqual(["Writing & research", "documentation"]);
    expect(domainPath("Unusual custom category")).toEqual(["Other", "Unusual custom category"]);
    expect(domainPath("")).toEqual([]);
  });

  it("matches whole paths and includes descendants when a parent is selected", () => {
    const value = "software engineering > Backend > APIs > Pagination > Cursor";
    expect(domainPath(value)).toHaveLength(5);
    expect(matchesDomain(value, "Software engineering")).toBe(true);
    expect(matchesDomain(value, "Software engineering > Backend > APIs")).toBe(true);
    expect(matchesDomain(value, "Software engineering > Backend > API")).toBe(false);
    expect(matchesDomain(value, "Software engineering > Frontend")).toBe(false);
    expect(matchesDomain("Frontend design", "Software engineering > Frontend")).toBe(true);
  });

  it("normalizes root casing and spacing while keeping custom hierarchy labels", () => {
    expect(domainPath("  software   engineering >  Custom Tooling  > Plugins ")).toEqual([
      "Software engineering",
      "Custom Tooling",
      "Plugins",
    ]);
    expect(domainPath("Archive → Photography → Film")).toEqual(["Archive", "Photography", "Film"]);
    expect(matchesDomain("Design > Interface > Forms", "design > INTERFACE")).toBe(true);
    expect(domainPath("Data & AI")).toEqual(["Data & AI"]);
    expect(domainPath("OTHER")).toEqual(["Other"]);
  });

  it("keeps slash-containing legacy labels intact unless slashes separate path levels", () => {
    expect(domainPath("CI/CD")).toEqual(["Software engineering", "Infrastructure", "CI/CD"]);
    expect(domainPath("UI/UX")).toEqual(["Design", "UI/UX"]);
    expect(domainPath("Design / UI/UX / Forms")).toEqual(["Design", "UI/UX", "Forms"]);
  });

  it("ignores empty path segments and does not match partial category names", () => {
    expect(domainPath(" > Design > > Forms > ")).toEqual(["Design", "Forms"]);
    expect(domainPath(" > → > ")).toEqual([]);
    expect(matchesDomain("Design > Forms > Input", "Design > Form")).toBe(false);
    expect(matchesDomain("Design > Forms", "Design > Forms > Input")).toBe(false);
    expect(matchesDomain("Design > Forms", "Design systems")).toBe(false);
  });

  it("limits depth without losing the more specific labels", () => {
    const path = domainPath("One > Two > Three > Four > Five > Six");
    expect(path).toHaveLength(MAX_DOMAIN_DEPTH);
    expect(path.at(-1)).toBe("Five / Six");
    expect(domainPath("Design / Interfaces / Forms")).toEqual(["Design", "Interfaces", "Forms"]);
  });

  it("asks new digests for broad roots and optional levels, not project-name categories", () => {
    const prompt = buildDigestPrompt({ exportName: "session.md", content: "Build a form." });
    expect(prompt).toContain("hierarchical path of 1-5 short labels");
    expect(prompt).toContain("Software engineering > Backend > APIs > Pagination > Cursor");
    expect(prompt).toContain("avoid making project names");
  });
});
