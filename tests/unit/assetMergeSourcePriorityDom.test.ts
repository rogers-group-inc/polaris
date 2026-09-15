/**
 * tests/unit/assetMergeSourcePriorityDom.test.ts — the merge modal's per-field
 * winner defaults (`_mergeSourceRank` / `_mergePreferredSide` /
 * `_mergeDefaultWinner` in public/js/asset-merge-modal.js).
 *
 * Two assets that are really one device were learned by different
 * integrations, and the operator has already ranked those integrations on
 * Assets -> Settings -> Sources. These helpers turn that ranking into the
 * pre-selected A/B radio for every differing field. What breaks silently:
 *
 *  - the order ranks only the LOCATION contributors, so `manual`,
 *    `polaris-agent`, `snmp-sysdescr` and `fortigate-firewall` are absent from
 *    it. An absent kind must rank BELOW every listed one, never above and
 *    never as index 0 (`indexOf` returning -1 read as a rank is exactly that
 *    bug);
 *  - an empty winner can never overwrite a value — the backend refuses it
 *    (assetMergeService.mergeAssets), so a default pointing at the empty side
 *    would render a radio that does nothing. The empty-value rule has to
 *    outrank the priority in both directions;
 *  - with no priority payload at all (fetch failed, older server) the defaults
 *    must reproduce the pre-feature behavior exactly: the side with a value,
 *    else A.
 *
 * asset-merge-modal.js is a plain browser script with no exports, so the
 * functions under test are sliced out by name and eval'd — the approach of
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

type Side = "this" | "other" | null;

let normalizePriority: (payload: unknown) => { order: string[]; labels: Record<string, string> } | null;
let sourceRank: (sources: unknown, order: unknown) => number;
let topRankedKind: (sources: unknown, order: unknown) => string | null;
let preferredSide: (a: number, b: number) => Side;
let defaultWinner: (a: any, b: any, key: string, preferred: Side) => "this" | "other";
let kindLabel: (kind: string) => string;

/** AssetSource rows as GET /assets/:id/sources ships them (only the kind matters here). */
function src(...kinds: string[]) {
  return kinds.map((k, i) => ({ id: `s${i}`, sourceKind: k }));
}

/** The default order, as GET /assets/source-priority emits it. */
const ORDER = DEFAULT_LOCATION_ORDER;

beforeEach(() => {
  g.escapeHtml = (s: unknown) => String(s ?? "");
  g._assetSourceLabels = { manual: "Manual / other", ad: "Active Directory (fallback label)" };
  g._mergeSourcePriority = null;
  for (const fn of [
    "_mergeIsEmpty",
    "_mergeFieldIsEmpty",
    "_mergeNormalizePriority",
    "_mergeSourceKindLabel",
    "_mergeSourceRank",
    "_mergeTopRankedKind",
    "_mergePreferredSide",
    "_mergeDefaultWinner",
  ]) {
    (0, eval)(fnSrc(fn));
  }
  normalizePriority = g._mergeNormalizePriority;
  sourceRank = g._mergeSourceRank;
  topRankedKind = g._mergeTopRankedKind;
  preferredSide = g._mergePreferredSide;
  defaultWinner = g._mergeDefaultWinner;
  kindLabel = g._mergeSourceKindLabel;
});

describe("_mergeNormalizePriority", () => {
  it("keeps the server's order and builds the kind -> label map", () => {
    const p = normalizePriority({
      order: ["ad", "intune"],
      integrationPrefix: false,
      contributors: [
        { kind: "ad", label: "Active Directory" },
        { kind: "intune", label: "Microsoft Intune" },
      ],
    });
    expect(p!.order).toEqual(["ad", "intune"]);
    expect(p!.labels.ad).toBe("Active Directory");
  });

  it("is null for every unusable payload so the caller falls back", () => {
    expect(normalizePriority(null)).toBeNull();
    expect(normalizePriority({})).toBeNull();
    expect(normalizePriority({ order: [] })).toBeNull();
    expect(normalizePriority({ order: "ad" })).toBeNull();
  });

  it("does not alias the server payload's array", () => {
    const payload = { order: ["ad"], contributors: [] };
    normalizePriority(payload)!.order.push("intune");
    expect(payload.order).toEqual(["ad"]);
  });
});

describe("_mergeSourceRank", () => {
  it("scores a side by its BEST-ranked source, not its first", () => {
    // ad is index 7, fortigate-endpoint index 0 — the FortiGate wins the side.
    expect(sourceRank(src("ad", "fortigate-endpoint"), ORDER)).toBe(0);
    expect(sourceRank(src("fortigate-endpoint", "ad"), ORDER)).toBe(0);
  });

  it("ignores kinds the order does not rank", () => {
    // manual / polaris-agent are absent from LOCATION_CONTRIBUTORS by design.
    expect(sourceRank(src("manual", "polaris-agent"), ORDER)).toBe(-1);
    expect(sourceRank(src("manual", "ad"), ORDER)).toBe(ORDER.indexOf("ad"));
  });

  it("is -1 for an empty or missing side and for a missing order", () => {
    expect(sourceRank([], ORDER)).toBe(-1);
    expect(sourceRank(null, ORDER)).toBe(-1);
    expect(sourceRank(src("ad"), null)).toBe(-1);
    expect(sourceRank(src("ad"), [])).toBe(-1);
  });

  it("follows a REORDERED list, not the catalogue default", () => {
    const operatorOrder = ["ad", "fortigate-endpoint"];
    expect(sourceRank(src("fortigate-endpoint"), operatorOrder)).toBe(1);
    expect(sourceRank(src("ad"), operatorOrder)).toBe(0);
  });
});

describe("_mergePreferredSide", () => {
  it("prefers the lower index", () => {
    expect(preferredSide(0, 3)).toBe("this");
    expect(preferredSide(3, 0)).toBe("other");
  });

  it("prefers any ranked source over an unranked side", () => {
    // The tail of the order still beats "not on the list at all".
    expect(preferredSide(ORDER.length - 1, -1)).toBe("this");
    expect(preferredSide(-1, ORDER.length - 1)).toBe("other");
  });

  it("has no opinion when the two sides tie", () => {
    expect(preferredSide(2, 2)).toBeNull();
    expect(preferredSide(-1, -1)).toBeNull();
  });
});

describe("_mergeDefaultWinner", () => {
  const A = { hostname: "fgt-learned", location: "", os: "Windows 11" };
  const B = { hostname: "ad-learned", location: "Nashville", os: "" };

  it("gives the field to the preferred side when both sides have a value", () => {
    expect(defaultWinner(A, B, "hostname", "other")).toBe("other");
    expect(defaultWinner(A, B, "hostname", "this")).toBe("this");
  });

  it("never defaults to an empty value, whichever side is preferred", () => {
    // A.location is empty: even preferring A, the radio must point at B, or it
    // would pre-select a choice the backend discards.
    expect(defaultWinner(A, B, "location", "this")).toBe("other");
    // B.os is empty, B preferred.
    expect(defaultWinner(A, B, "os", "other")).toBe("this");
  });

  it("reproduces the pre-feature behavior with no preference", () => {
    expect(defaultWinner(A, B, "hostname", null)).toBe("this");  // both set -> A
    expect(defaultWinner(A, B, "location", null)).toBe("other"); // A empty -> B
    expect(defaultWinner(A, B, "os", null)).toBe("this");        // B empty -> A
  });

  it("treats whitespace and null as empty", () => {
    const a = { note: "   ", tag: null };
    const b = { note: "real", tag: "real" };
    expect(defaultWinner(a, b, "note", "this")).toBe("other");
    expect(defaultWinner(a, b, "tag", "this")).toBe("other");
  });

  it("treats a Type of 'other' as empty — the specific type wins whatever the source rank", () => {
    const generic = { assetType: "other", model: "other" };
    const specific = { assetType: "switch", model: "FS-124F" };
    // Even when the operator's order prefers the "other" side.
    expect(defaultWinner(generic, specific, "assetType", "this")).toBe("other");
    expect(defaultWinner(specific, generic, "assetType", "other")).toBe("this");
    // Case and whitespace don't rescue it.
    expect(defaultWinner({ assetType: " Other " }, specific, "assetType", "this")).toBe("other");
    // Only the Type field reads "other" that way — a model literally called
    // "other" is a value like any other.
    expect(defaultWinner(generic, specific, "model", "this")).toBe("this");
    // Two specific types: the source rank decides as usual.
    expect(defaultWinner({ assetType: "server" }, specific, "assetType", "other")).toBe("other");
    expect(defaultWinner({ assetType: "server" }, specific, "assetType", null)).toBe("this");
  });
});

describe("labels for the explanatory hint", () => {
  it("names the kind that earned the side its rank", () => {
    expect(topRankedKind(src("ad", "fortigate-endpoint"), ORDER)).toBe("fortigate-endpoint");
    expect(topRankedKind(src("manual"), ORDER)).toBeNull();
  });

  it("prefers the server's label, then the local map, then the raw kind", () => {
    g._mergeSourcePriority = { order: ORDER, labels: { ad: "Active Directory" } };
    expect(kindLabel("ad")).toBe("Active Directory");
    expect(kindLabel("manual")).toBe("Manual / other");
    expect(kindLabel("brand-new-kind")).toBe("brand-new-kind");
  });
});

describe("end to end: the FortiGate-vs-AD duplicate this exists for", () => {
  it("pre-selects the FortiGate row's values under the default order", () => {
    const fortigateSide = src("fortigate-endpoint");
    const adSide = src("ad");
    const side = preferredSide(sourceRank(fortigateSide, ORDER), sourceRank(adSide, ORDER));
    expect(side).toBe("this");

    const fromFortigate = { hostname: "WS-1234", location: "", assignedTo: "" };
    const fromAd = { hostname: "ws-1234.corp.example", location: "OU=Workstations", assignedTo: "jdoe" };
    // Contested field goes to the higher-ranked source…
    expect(defaultWinner(fromFortigate, fromAd, "hostname", side)).toBe("this");
    // …but AD still fills in everything the FortiGate has nothing to say about.
    expect(defaultWinner(fromFortigate, fromAd, "location", side)).toBe("other");
    expect(defaultWinner(fromFortigate, fromAd, "assignedTo", side)).toBe("other");
  });
});
