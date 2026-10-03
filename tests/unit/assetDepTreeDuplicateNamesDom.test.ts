/**
 * tests/unit/assetDepTreeDuplicateNamesDom.test.ts — the asset-details
 * Dependency Tree when two rendered nodes share a hostname (business rule 91:
 * a FortiLink fleet names its switch-ids per site, so "IDF-1" sits behind
 * every gate).
 *
 * Pinned here:
 *  - every node whose hostname another node in the SAME tree shares gets a
 *    `.dep-tree-disambig` tag carrying its serial, or its address when it has
 *    no serial — parents, self, HA peer, children and grandchildren alike;
 *  - a node with a unique name gets no tag, whatever it carries;
 *  - the pivot link's tooltip names the disambiguator, so "Open IDF-1" says
 *    which one;
 *  - the "directly under X" subtitle names it too.
 *
 * Functions are sliced out by name and eval'd — the approach of
 * tests/unit/assetDepTreeAlertDotDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const read = (f: string) => readFileSync(resolve(__dirname, "../../public/js/" + f), "utf8").split(/\r?\n/);
const assetsLines = read("assets.js");
const appLines = read("app.js");

function src(lines: string[], name: string): string {
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`) || l.startsWith(`var ${name} =`));
  if (start < 0) throw new Error(`function/var ${name} not found`);
  if (lines[start].trimEnd().endsWith(";")) return lines[start];
  const end = lines.findIndex((l, i) => i > start && (l === "}" || l === "};"));
  if (end < 0) throw new Error(`no end of ${name}`);
  return lines.slice(start, end + 1).join("\n");
}

const node = (id: string, hostname: string, over: Record<string, unknown> = {}) => ({
  id, hostname, assetType: "switch", dependencyLayer: 2,
  monitorStatus: "up", monitored: true, serialNumber: null, ipAddress: null, ...over,
});

function render(payload: unknown): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = g.renderDependencyTreeBlock(payload, "self");
  return host;
}

function rowFor(host: HTMLElement, id: string): HTMLElement {
  const row = [...host.querySelectorAll<HTMLElement>(".dep-tree-row")]
    .find((r) => r.querySelector(`.dep-tree-link[data-asset-id="${id}"]`) || (id === "self" && r.classList.contains("dep-tree-row-self")));
  if (!row) throw new Error(`no row for ${id}`);
  return row;
}

beforeEach(() => {
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  for (const n of ["assetAlertStrobeColor", "alertSummaryDotHTML"]) (0, eval)(src(appLines, n));
  for (const n of [
    "_DEP_TREE_TYPE_LABEL", "_DEP_TREE_VIA_LABEL", "_DEP_TREE_VIA_TITLE",
    "_depTreeStatusPip", "_depTreeTypeLabel", "_depTreeNodeRow", "renderDependencyTreeBlock",
  ]) (0, eval)(src(assetsLines, n));
});

describe("dependency tree — same-named devices (rule 91)", () => {
  // A gate whose two children are both called IDF-1 (one of them has no serial
  // yet), plus a grandchild AP named like the self node's HA peer.
  const payload = {
    asset: node("self", "SITE-A-FW", { assetType: "firewall", dependencyLayer: 1, serialNumber: "FG100F000A" }),
    effectiveParents: [],
    haPeer: node("peer", "SITE-A-FW", { assetType: "firewall", dependencyLayer: 1, serialNumber: "FG100F000B", haRole: "secondary" }),
    children: [
      { ...node("swA", "IDF-1", { serialNumber: "S248EPTF000A" }), grandchildren: [node("apU", "AP-UNIQUE", { assetType: "access_point", serialNumber: "FP231F0001" })], childCount: 1 },
      { ...node("swA2", "idf-1", { serialNumber: null, ipAddress: "10.1.1.2" }), grandchildren: [], childCount: 0 },
      { ...node("swC", "CORE-1", { serialNumber: "S248EPTF000C" }), grandchildren: [], childCount: 0 },
    ],
  };

  it("tags every same-named row with its serial, case-insensitively", () => {
    const host = render(payload);
    expect(rowFor(host, "swA").querySelector(".dep-tree-disambig")!.textContent).toBe("S248EPTF000A");
    expect(rowFor(host, "self").querySelector(".dep-tree-disambig")!.textContent).toBe("FG100F000A");
    expect(rowFor(host, "peer").querySelector(".dep-tree-disambig")!.textContent).toBe("FG100F000B");
  });

  it("falls back to the address when the same-named row has no serial", () => {
    const tag = rowFor(render(payload), "swA2").querySelector<HTMLElement>(".dep-tree-disambig")!;
    expect(tag.textContent).toBe("10.1.1.2");
    expect(tag.getAttribute("title")).toContain("address 10.1.1.2");
  });

  it("leaves a uniquely named row untagged even though it carries a serial", () => {
    const host = render(payload);
    expect(rowFor(host, "swC").querySelector(".dep-tree-disambig")).toBeNull();
    expect(rowFor(host, "apU").querySelector(".dep-tree-disambig")).toBeNull();
  });

  it("names the disambiguator in the pivot link's tooltip", () => {
    const host = render(payload);
    expect(rowFor(host, "swA").querySelector(".dep-tree-link")!.getAttribute("title")).toBe("Open IDF-1 (S248EPTF000A)");
    expect(rowFor(host, "swC").querySelector(".dep-tree-link")!.getAttribute("title")).toBe("Open CORE-1");
  });

  it("names it in the 'directly under' subtitle when the parent shares a name in the tree", () => {
    const host = render({
      asset: node("self", "AP-7", { assetType: "access_point", dependencyLayer: 3 }),
      effectiveParents: [{ parent: node("swB", "IDF-1", { serialNumber: "S248EPTF000B" }), source: "computed", detectedVia: "controller" }],
      children: [{ ...node("sw-under", "IDF-1", { serialNumber: "S248EPTF00XX" }), grandchildren: [], childCount: 0 }],
    });
    expect(host.querySelector(".dep-tree-subtitle")!.textContent).toBe("Level 3 · directly under IDF-1 (S248EPTF000B)");
    expect(rowFor(host, "swB").querySelector(".dep-tree-disambig")!.textContent).toBe("S248EPTF000B");
  });

  it("renders no tag at all when every name in the tree is unique", () => {
    const host = render({
      asset: node("self", "AP-7", { assetType: "access_point", dependencyLayer: 3, serialNumber: "FP231F0007" }),
      effectiveParents: [{ parent: node("swB", "IDF-1", { serialNumber: "S248EPTF000B" }), source: "computed", detectedVia: "controller" }],
      children: [],
    });
    expect(host.querySelectorAll(".dep-tree-disambig").length).toBe(0);
    expect(host.querySelector(".dep-tree-subtitle")!.textContent).toBe("Level 3 · directly under IDF-1");
  });
});
