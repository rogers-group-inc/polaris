/**
 * tests/unit/helpIndexService.test.ts
 *
 * The assistant's search_help index over docs/wiki (business rule 95). What
 * matters: sections split at ## / ### (never at a # inside a code fence), the
 * links it hands the model point at the GitHub wiki the Help menu opens, the
 * real wiki answers an ordinary how-to question with the right page, and a
 * missing docs folder says "unavailable" instead of returning nothing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  tokenize,
  wikiAnchor,
  splitWikiPage,
  buildHelpIndex,
  rankHelp,
  searchHelp,
  WIKI_BASE_URL,
  _resetHelpIndexForTests,
} from "../../src/services/helpIndexService.js";

afterEach(() => _resetHelpIndexForTests());

describe("tokenize", () => {
  it("lower-cases, drops stopwords and folds simple plurals", () => {
    expect(tokenize("How do I add Integrations to Polaris?")).toEqual(["add", "integration"]);
  });
  it("keeps -ss / -us words whole", () => {
    expect(tokenize("address status")).toEqual(["address", "status"]);
  });
});

describe("wikiAnchor", () => {
  it("matches GitHub's heading slugs", () => {
    expect(wikiAnchor("Four fields every type has")).toBe("four-fields-every-type-has");
    expect(wikiAnchor("DHCP Push (FortiGate)")).toBe("dhcp-push-fortigate");
  });
});

describe("splitWikiPage", () => {
  const page = [
    "# Maintenance Windows",
    "",
    "Intro text.",
    "",
    "## Scheduling",
    "Pick a time.",
    "```",
    "## not a heading",
    "```",
    "### Recurrence",
    "Weekly works.",
  ].join("\n");

  it("takes the H1 as the title and splits at ## / ###, ignoring fenced lines", () => {
    const s = splitWikiPage("Maintenance-Windows", page);
    expect(s.map((x) => x.heading)).toEqual(["", "Scheduling", "Recurrence"]);
    expect(s[0].title).toBe("Maintenance Windows");
    expect(s[1].text).toContain("## not a heading");
    expect(s[2].anchor).toBe("recurrence");
  });
});

describe("rankHelp", () => {
  it("prefers the section whose heading carries the terms", () => {
    const index = buildHelpIndex([
      { page: "A", markdown: "# A\n\n## Backups\nRestore from a backup file.\n\n## Other\nNothing here." },
      { page: "B", markdown: "# B\n\n## Logins\nA backup is mentioned once." },
    ]);
    const top = rankHelp(index, "restore backup", 2);
    expect(top[0].section.page).toBe("A");
    expect(top[0].section.heading).toBe("Backups");
  });

  it("skips the sidebar / footer chrome pages", () => {
    const index = buildHelpIndex([{ page: "_Sidebar", markdown: "## Backups\nbackup backup" }]);
    expect(rankHelp(index, "backup", 5)).toEqual([]);
  });
});

describe("searchHelp", () => {
  it("answers a how-to question from the real wiki with a citable link", async () => {
    const r = await searchHelp("schedule a maintenance window");
    expect(r.available).toBe(true);
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.some((h) => h.page === "Maintenance-Windows")).toBe(true);
    for (const h of r.hits) expect(h.url.startsWith(`${WIKI_BASE_URL}/`)).toBe(true);
  });

  it("stays under its character budget", async () => {
    const r = await searchHelp("integration discovery monitoring alerts", { maxChars: 2000 });
    const total = r.hits.reduce((n, h) => n + h.text.length, 0);
    expect(total).toBeLessThanOrEqual(2001 + r.hits.length);
  });

  it("reports unavailable when the docs folder is missing", async () => {
    _resetHelpIndexForTests(join(tmpdir(), "polaris-no-such-wiki-" + Date.now()));
    expect(await searchHelp("anything")).toEqual({ available: false, hits: [] });
  });

  it("indexes whatever folder it is pointed at", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polaris-wiki-"));
    writeFileSync(join(dir, "Widgets.md"), "# Widgets\n\n## Sprockets\nHow to tune a sprocket.\n");
    _resetHelpIndexForTests(dir);
    const r = await searchHelp("tune sprocket");
    expect(r.hits[0]).toMatchObject({ page: "Widgets", heading: "Sprockets", url: `${WIKI_BASE_URL}/Widgets#sprockets` });
  });
});
