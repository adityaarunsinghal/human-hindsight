import { describe, expect, it } from "vitest";
import { matchesDomain } from "../src/core/domains.js";
import {
  buildDomainTree,
  resolveDomainSelection,
  summarizeDomainContext,
} from "../src/gui/domains.js";

describe("domain chooser hierarchy", () => {
  it("merges case variants under one readable branch regardless of input order", () => {
    const domains = [
      "software engineering > frontend > forms",
      "Software engineering > Frontend > Forms",
      "SOFTWARE ENGINEERING > FRONTEND > FORMS",
      "Software engineering > Backend > APIs",
    ];
    const tree = buildDomainTree(domains);
    expect(tree).toEqual(buildDomainTree([...domains].reverse()));
    expect(tree).toHaveLength(1);
    expect(tree[0]?.label).toBe("Software engineering");
    expect(tree[0]?.children.map((node) => node.label)).toEqual(["Backend", "Frontend"]);
    const frontend = tree[0]?.children[1];
    expect(frontend?.children).toHaveLength(1);
    expect(frontend?.children[0]?.path).toBe("Software engineering > Frontend > Forms");
  });

  it("keeps identically named branches distinct beneath different parents", () => {
    const tree = buildDomainTree([
      "Software engineering > Backend > Testing",
      "Software engineering > Frontend > Testing",
    ]);
    const paths = tree[0]?.children.flatMap((node) => node.children.map((child) => child.path));
    expect(paths).toEqual([
      "Software engineering > Backend > Testing",
      "Software engineering > Frontend > Testing",
    ]);
  });

  it("keeps parent choices compatible with existing descendant filtering", () => {
    const source = "Frontend design";
    const tree = buildDomainTree([source, "Software engineering > Backend > APIs"]);
    const selected = resolveDomainSelection(tree, "SOFTWARE ENGINEERING > FRONTEND");
    expect(selected).toBe("Software engineering > Frontend");
    expect(matchesDomain(source, selected)).toBe(true);
    expect(matchesDomain("Software engineering > Backend > APIs", selected)).toBe(false);
  });

  it("falls back to the closest surviving parent without selecting a different branch", () => {
    const tree = buildDomainTree([
      "Software engineering > Backend > APIs",
      "Software engineering > Frontend",
    ]);
    expect(resolveDomainSelection(tree, "Software engineering > Backend > APIs > Pagination")).toBe(
      "Software engineering > Backend > APIs",
    );
    expect(resolveDomainSelection(tree, "Software engineering > Backend > Storage")).toBe(
      "Software engineering > Backend",
    );
    expect(resolveDomainSelection(tree, "Design > Forms")).toBe("");
    expect(resolveDomainSelection(tree, "")).toBe("");
  });
});

describe("compact domain context", () => {
  it("shows one complete breadcrumb for one unique domain", () => {
    const summary = summarizeDomainContext([
      "Software engineering > Backend > APIs",
      "software engineering > backend > apis",
    ]);
    expect(summary.breadcrumb).toEqual(["Software engineering", "Backend", "APIs"]);
    expect(summary.paths).toHaveLength(1);
    expect(summary.additional).toBe(0);
  });

  it("shows common ancestry once and groups sibling paths beneath it", () => {
    const summary = summarizeDomainContext([
      "Software engineering > Backend > APIs",
      "Software engineering > Backend > Storage",
      "Software engineering > Frontend > Forms",
    ]);
    expect(summary.breadcrumb).toEqual(["Software engineering"]);
    expect(summary.additional).toBe(3);
    expect(summary.tree[0]?.children.map((node) => node.label)).toEqual(["Backend", "Frontend"]);
    expect(summary.tree[0]?.children[0]?.children.map((node) => node.label)).toEqual([
      "APIs",
      "Storage",
    ]);
  });

  it("counts only additional distinct paths when the common parent is itself a domain", () => {
    const summary = summarizeDomainContext([
      "Software engineering > Backend",
      "Software engineering > Backend > APIs",
      "software engineering > backend > apis",
    ]);
    expect(summary.breadcrumb).toEqual(["Software engineering", "Backend"]);
    expect(summary.additional).toBe(1);
  });

  it("handles unrelated roots and empty input without inventing common ancestry", () => {
    const summary = summarizeDomainContext(["Design > Forms", "Data & AI > Analytics"]);
    expect(summary.breadcrumb).toEqual([]);
    expect(summary.additional).toBe(2);
    expect(summary.tree).toHaveLength(2);
    expect(summarizeDomainContext(["", " > "])).toEqual({
      tree: [],
      paths: [],
      breadcrumb: [],
      additional: 0,
    });
  });
});
