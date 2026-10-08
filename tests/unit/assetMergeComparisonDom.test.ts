/**
 * tests/unit/assetMergeComparisonDom.test.ts — the merge modal's comparison
 * table (`_renderMergeComparison` in public/js/asset-merge-modal.js), specifically that
 * the Sources priority order actually reaches the radios.
 *
 * The decision helpers are unit-tested next door
 * (assetMergeSourcePriorityDom.test.ts); this one is about the WIRING, which
 * is the half that fails silently: a preferred side computed but never passed
 * to the field rows leaves every radio on A and nothing on screen says so.
 * So the assertions are the three things an operator sees — which radio is
 * pre-checked, the badge on the winning column, and the hint naming the two
 * sources and the setting that decided it.
 *
 * asset-merge-modal.js is a plain browser script with no exports, so the
 * renderer and its helpers are sliced out by name and eval'd — the approach of
 * tests/unit/assetVipRowsDom.test.ts.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_LOCATION_ORDER } from "../../src/utils/assetSourceLocation.js";

vi.mock("../../src/db.js", () => ({ prisma: {} }));

const g = globalThis as Record<string, any>;
const modalLines = readFileSync(resolve(__dirname, "../../public/js/asset-merge-modal.js"), "utf8").split(/\r?\n/);

/** Slice a top-level `function NAME(...) {` … `}` block out of asset-merge-modal.js. */
function fnSrc(name: string): string {
  const start = modalLines.findIndex((l) => l.startsWith(`function ${name}(`));
  if (start < 0) throw new Error(`asset-merge-modal.js: function ${name} not found`);
  const end = modalLines.findIndex((l, i) => i > start && l === "}");
  if (end < 0) throw new Error(`asset-merge-modal.js: no end of function ${name}`);
  return modalLines.slice(start, end + 1).join("\n");
}

/** Slice a top-level `var NAME = [` … `];` array literal out of asset-merge-modal.js. */
function arrSrc(name: string): string {
  const start = modalLines.findIndex((l) => l.startsWith(`var ${name} = [`));
  if (start < 0) throw new Error(`asset-merge-modal.js: var ${name} not found`);
  const end = modalLines.findIndex((l, i) => i > start && l === "];");
  if (end < 0) throw new Error(`asset-merge-modal.js: no end of var ${name}`);
  return modalLines.slice(start, end + 1).join("\n");
}

const HELPERS = [
  "_mergeFieldVal",
  "_mergeIsEmpty",
  "_mergeFieldIsEmpty",
  "_mergeAssetLabel",
  "_mergeHistoryScore",
  "_mergeHistoryLonger",
  "_mergeHistoryText",
  "_mergeHistoryCell",
  "_mergeSourcesSummary",
  "_mergeNormalizePriority",
  "_mergeSourceKindLabel",
  "_mergeSourceRank",
  "_mergeTopRankedKind",
  "_mergePreferredSide",
  "_mergeDefaultWinner",
  "_mergeDepParents",
  "_mergeDepParentNames",
  "_mergeDepParentsKey",
  "_mergeDepsConflict",
  "_mergeDepParentsCell",
  "_renderMergeComparison",
];

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    hostname: "WS-1234",
    ipAddress: "10.4.12.63",
    os: "Windows 11",
    location: "",
    assignedTo: "",
    monitored: false,
    tags: [],
    ...over,
  };
}

function src(...kinds: string[]) {
  return kinds.map((k, i) => ({ id: `s${i}`, sourceKind: k }));
}

/** Render with both sides set up, returning the comparison container. */
function render(opts: {
  A: Record<string, unknown>;
  B: Record<string, unknown>;
  aSources: unknown[];
  bSources: unknown[];
  priority?: unknown;
}): HTMLElement {
  const host = document.createElement("div");
  host.id = "merge-compare";
  document.body.appendChild(host);
  g._mergeThisAsset = opts.A;
  g._mergeOtherAsset = opts.B;
  g._mergeThisSources = opts.aSources;
  g._mergeOtherSources = opts.bSources;
  g._mergeSourcePriority = g._mergeNormalizePriority(opts.priority ?? null);
  g._renderMergeComparison();
  return host;
}

/** The value ("this" / "other") whose radio is pre-checked for a field. */
function checkedFor(host: HTMLElement, key: string): string | null {
  const checked = host.querySelector<HTMLInputElement>(`input[name="mw-${key}"][checked]`);
  return checked ? checked.getAttribute("value") : null;
}

const PRIORITY = {
  order: DEFAULT_LOCATION_ORDER,
  integrationPrefix: false,
  contributors: [
    { kind: "fortigate-endpoint", label: "FortiGate / FortiManager (endpoint)" },
    { kind: "ad", label: "Active Directory" },
  ],
};

beforeEach(() => {
  document.body.innerHTML = "";
  g.escapeHtml = (s: unknown) =>
    String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  g.formatDate = (d: unknown) => String(d ?? "");
  g._assetSourceLabels = { "fortigate-endpoint": "FortiGate / FortiManager (endpoint)", ad: "Active Directory" };
  g._mergeThisHistory = null;
  g._mergeOtherHistory = null;
  g._mergeThisDeps = null;
  g._mergeOtherDeps = null;
  g._mergePreselected = true;
  (0, eval)(arrSrc("_mergeCompareFields"));
  for (const fn of HELPERS) (0, eval)(fnSrc(fn));
});

describe("_renderMergeComparison — Sources priority defaults", () => {
  it("pre-checks the higher-ranked side for a contested field", () => {
    const host = render({
      A: asset({ hostname: "WS-1234" }),
      B: asset({ id: "a2", hostname: "ws-1234.corp.example" }),
      aSources: src("ad"),
      bSources: src("fortigate-endpoint"),
      priority: PRIORITY,
    });
    // fortigate-endpoint outranks ad in the default order, and it is on B.
    expect(checkedFor(host, "hostname")).toBe("other");
  });

  it("still gives an empty higher-ranked side's field to the other row", () => {
    const host = render({
      A: asset({ location: "Nashville" }),
      B: asset({ id: "a2", location: "" }),
      aSources: src("ad"),
      bSources: src("fortigate-endpoint"),
      priority: PRIORITY,
    });
    expect(checkedFor(host, "location")).toBe("this");
  });

  it("badges the winning column and explains the pick", () => {
    const host = render({
      A: asset({ hostname: "WS-1234" }),
      B: asset({ id: "a2", hostname: "ws-1234.corp.example" }),
      aSources: src("fortigate-endpoint"),
      bSources: src("ad"),
      priority: PRIORITY,
    });
    const headers = Array.from(host.querySelectorAll("thead th")).map((h) => h.innerHTML);
    expect(headers[1]).toContain("higher-ranked source");
    expect(headers[2]).not.toContain("higher-ranked source");

    const hint = host.querySelector("#merge-priority-hint")!.textContent || "";
    expect(hint).toContain("FortiGate / FortiManager (endpoint)");
    expect(hint).toContain("Active Directory");
    expect(hint).toContain("Sources");
  });

  it("says nothing and defaults to A when the order cannot separate the sides", () => {
    const host = render({
      A: asset({ hostname: "WS-1234" }),
      B: asset({ id: "a2", hostname: "ws-1234.corp.example" }),
      aSources: src("ad"),
      bSources: src("ad"),
      priority: PRIORITY,
    });
    expect(checkedFor(host, "hostname")).toBe("this");
    expect(host.innerHTML).not.toContain("higher-ranked source");
  });

  it("falls back to the pre-feature defaults when the priority fetch failed", () => {
    const host = render({
      A: asset({ hostname: "WS-1234", os: "" }),
      B: asset({ id: "a2", hostname: "ws-1234.corp.example", os: "Windows 11" }),
      aSources: src("ad"),
      bSources: src("fortigate-endpoint"),
      priority: null,
    });
    expect(checkedFor(host, "hostname")).toBe("this");  // both set -> A
    expect(checkedFor(host, "os")).toBe("other");       // A empty -> B
    expect(host.innerHTML).not.toContain("higher-ranked source");
  });

  it("pre-checks the specific Type over 'other' even on the lower-ranked side", () => {
    const host = render({
      A: asset({ assetType: "other" }),
      B: asset({ hostname: "ws-1234.corp", assetType: "workstation" }),
      aSources: src("fortigate-endpoint"),   // A ranks higher…
      bSources: src("ad"),
      priority: PRIORITY,
    });
    expect(checkedFor(host, "hostname")).toBe("this");   // …and takes the contested field
    expect(checkedFor(host, "assetType")).toBe("other"); // but not the Type: "other" is unclassified
    const hint = host.querySelector("#merge-priority-hint")!.textContent || "";
    expect(hint).toMatch(/Type of .other. never overwrites a specific type/);
  });
});
