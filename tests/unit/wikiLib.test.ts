import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM script shared by scripts/check-wiki.mjs and scripts/wiki-publish.mjs; no type declarations
import { githubSlug, pageAnchors, pageLinks, checkWikiPages, planPublish, parsePublishMarker, toLf } from "../../scripts/wiki-lib.mjs";

const sidebar = "- [Home](Home)\n- [Automations](Automations)\n- [Business rules](Business-Rules)\n";
const wiki = (extra: Record<string, string> = {}) =>
  new Map<string, string>(
    Object.entries({
      Home: "# Polaris\n\nSee [Automations](Automations).\n",
      _Sidebar: sidebar,
      _Footer: "footer\n",
      Automations: "# Automations\n\n## The `monitorStatus == down` trigger\n\nSee [rule 7](Business-Rules#rule-7).\n",
      "Business-Rules": "# Business rules\n\n### Rule 7\n\ntext\n",
      README: "repo-only, links [anything](nowhere/at/all.md)\n",
      ...extra,
    }),
  );

describe("githubSlug", () => {
  it("keeps inline-code text, drops punctuation, turns spaces into hyphens", () => {
    expect(githubSlug("The `monitorStatus == down` trigger")).toBe("the-monitorstatus--down-trigger");
    expect(githubSlug("`fortilinkStatus` — the second opinion")).toBe("fortilinkstatus--the-second-opinion");
    expect(githubSlug("1. A `pg_dump` older than the server")).toBe("1-a-pg_dump-older-than-the-server");
    expect(githubSlug("Rule 7")).toBe("rule-7");
  });

  it("reads link text, not the URL", () => {
    expect(githubSlug("See [the API](API) page")).toBe("see-the-api-page");
  });
});

describe("pageAnchors", () => {
  it("suffixes duplicate headings like GitHub and ignores fenced code", () => {
    const a = pageAnchors("## Notes\n\n```\n## Not a heading\n```\n\n## Notes\n<a id=\"custom\"></a>\n");
    expect([...a].sort()).toEqual(["custom", "notes", "notes-1"]);
  });
});

describe("pageLinks", () => {
  it("skips links inside code spans and fences", () => {
    const links = pageLinks("[a](A) `[b](B)`\n```\n[c](C)\n```\n![img](https://x/y.png)\n");
    expect(links.map((l: { target: string }) => l.target)).toEqual(["A", "https://x/y.png"]);
  });
});

describe("checkWikiPages", () => {
  it("passes a well-formed wiki, ignoring README's links", () => {
    expect(checkWikiPages(wiki()).failures).toEqual([]);
  });

  it("fails a page missing from the sidebar", () => {
    const { failures } = checkWikiPages(wiki({ Orphan: "# Orphan\n" }));
    expect(failures).toEqual([expect.objectContaining({ page: "Orphan", msg: expect.stringMatching(/_Sidebar/) })]);
  });

  it("fails path-style links, .md suffixes and links to README", () => {
    const { failures } = checkWikiPages(
      wiki({ Home: "[a](docs/wiki/Automations.md) [b](Automations.md) [c](README)\n" }),
    );
    expect(failures.map((f: { msg: string }) => f.msg)).toEqual([
      expect.stringMatching(/is a path/),
      expect.stringMatching(/is a path/),
      expect.stringMatching(/repo-only/),
    ]);
  });

  it("fails a broken anchor and a missing page, suggesting the right case", () => {
    const { failures } = checkWikiPages(wiki({ Home: "[x](Business-Rules#rule-8) [y](automations) [z](#nope)\n" }));
    expect(failures.map((f: { msg: string; line: number }) => [f.line, f.msg])).toEqual([
      [1, expect.stringMatching(/no heading with anchor #rule-8/)],
      [1, expect.stringMatching(/did you mean "Automations"/)],
      [1, expect.stringMatching(/Home has no heading with anchor #nope/)],
    ]);
  });

  it("accepts a same-page anchor and a code-span heading anchor", () => {
    const { failures } = checkWikiPages(
      wiki({ Home: "# Top\n\n[up](#top) [t](Automations#the-monitorstatus--down-trigger)\n" }),
    );
    expect(failures).toEqual([]);
  });

  it("fails a relative image path", () => {
    const { failures } = checkWikiPages(wiki({ Home: "![shot](../img/dash.png)\n" }));
    expect(failures).toEqual([expect.objectContaining({ msg: expect.stringMatching(/404s on the published wiki/) })]);
  });
});

describe("planPublish", () => {
  it("adds, updates, deletes and leaves equal pages alone — CRLF is not a change", () => {
    const source = new Map([
      ["Home", "# Home\n"],
      ["New", "new\n"],
      ["Changed", "v2\n"],
      ["README", "never published\n"],
    ]);
    const current = new Map([
      ["Home", "# Home\r\n"],
      ["Changed", "v1\n"],
      ["Renamed-Away", "old\n"],
      ["README", "leaked once\n"],
    ]);
    expect(planPublish(source, current)).toEqual({
      added: ["New"],
      changed: ["Changed"],
      deleted: ["README", "Renamed-Away"],
      unchanged: ["Home"],
    });
  });
});

describe("parsePublishMarker / toLf", () => {
  it("reads the polaris@<sha> marker from a publish commit subject", () => {
    expect(parsePublishMarker("wiki: sync from polaris@689a83e4")).toBe("689a83e4");
    expect(parsePublishMarker("Initial Home page")).toBeNull();
  });

  it("normalises CRLF and lone CR", () => {
    expect(toLf("a\r\nb\rc\n")).toBe("a\nb\nc\n");
  });
});
