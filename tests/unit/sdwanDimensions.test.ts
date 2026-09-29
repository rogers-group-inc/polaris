/**
 * tests/unit/sdwanDimensions.test.ts
 *
 * The SD-WAN member vocabulary (src/utils/sdwanDimensions.ts):
 *  - the any-of health-check / member filter ("|"-joined terms, each a
 *    substring) that lets one automation name several of each, and reads a
 *    pre-multi-select single value exactly as before;
 *  - business rule 90's parent walk: which member readings yield to a parent
 *    member that is itself over the line;
 *  - the Health Check Status strip's per-scrape verdict.
 */

import { describe, it, expect } from "vitest";
import {
  sdwanDimensionTerms,
  joinSdwanTerms,
  sdwanDimensionMatch,
  sdwanFilterSelects,
  sdwanChildrenYielding,
  sdwanSegmentVerdict,
  SDWAN_PARENT_MAX_HOPS,
  type SdwanStripSample,
  type SdwanStripTier,
} from "../../src/utils/sdwanDimensions.js";

describe("sdwanDimensionTerms / joinSdwanTerms", () => {
  it("splits on |, trims, drops blanks", () => {
    expect(sdwanDimensionTerms(" Microsoft | Primary WAN ||")).toEqual(["Microsoft", "Primary WAN"]);
    expect(sdwanDimensionTerms("")).toEqual([]);
    expect(sdwanDimensionTerms(undefined)).toEqual([]);
    expect(sdwanDimensionTerms("wan1")).toEqual(["wan1"]);
  });
  it("joins canonically, de-duplicating case-insensitively and keeping the first spelling", () => {
    expect(joinSdwanTerms(["wan1", " WAN1 ", "", "wan2"])).toBe("wan1|wan2");
    expect(joinSdwanTerms([])).toBe("");
  });
});

describe("sdwanDimensionMatch", () => {
  it("treats a single value exactly as the old substring match did", () => {
    expect(sdwanDimensionMatch("Primary WAN", "primary")).toBe(true);
    expect(sdwanDimensionMatch("Microsoft", "primary")).toBe(false);
  });
  it("matches any of several terms", () => {
    expect(sdwanDimensionMatch("Microsoft", "Primary WAN|Microsoft")).toBe(true);
    expect(sdwanDimensionMatch("Metrocenter", "Primary WAN|Microsoft")).toBe(false);
  });
  it("matches everything when unset or blank", () => {
    expect(sdwanDimensionMatch("anything", undefined)).toBe(true);
    expect(sdwanDimensionMatch("anything", " | ")).toBe(true);
    expect(sdwanDimensionMatch(null, "")).toBe(true);
  });
  it("never matches a missing name against a real term", () => {
    expect(sdwanDimensionMatch(null, "wan1")).toBe(false);
  });
});

describe("sdwanFilterSelects", () => {
  it("ANDs the health-check and member filters", () => {
    const df = { healthCheck: "Microsoft|Primary WAN", link: "wan1|Overlay-1" };
    expect(sdwanFilterSelects(df, { healthCheck: "Microsoft", link: "Overlay-1" })).toBe(true);
    expect(sdwanFilterSelects(df, { healthCheck: "Microsoft", link: "wan2" })).toBe(false);
    expect(sdwanFilterSelects(df, { healthCheck: "Metrocenter", link: "wan1" })).toBe(false);
    expect(sdwanFilterSelects(null, { healthCheck: "x", link: "y" })).toBe(true);
  });
});

describe("sdwanChildrenYielding (business rule 90)", () => {
  const A = "gate-1";
  const parentOf = new Map([
    [`${A}|Overlay-3`, "wan2"],
    [`${A}|Overlay-4`, "wan2"],
    [`${A}|Overlay-1`, "wan1"],
  ]);
  const r = (member: string, meets: boolean, hc = "Microsoft") => ({ assetId: A, member, dimKey: `${hc}|${member}`, meets });

  it("yields overlays whose underlay is over the line in the same automation", () => {
    const out = sdwanChildrenYielding([
      r("wan2", true, "Secondary WAN"), r("Overlay-3", true), r("Overlay-4", true, "Flexential"), r("Overlay-1", true), r("wan1", false),
    ], parentOf);
    expect(Object.fromEntries(out)).toEqual({
      [`${A}|Microsoft|Overlay-3`]: "wan2",
      [`${A}|Flexential|Overlay-4`]: "wan2",
    });
  });

  it("never yields the parent itself — the alert that survives names the cause", () => {
    const out = sdwanChildrenYielding([r("wan2", true), r("Overlay-3", true)], parentOf);
    expect(out.has(`${A}|Microsoft|wan2`)).toBe(false);
  });

  it("does not yield a child whose reading is back under the line (it must recover normally)", () => {
    const out = sdwanChildrenYielding([r("wan2", true), r("Overlay-3", false)], parentOf);
    expect(out.size).toBe(0);
  });

  it("yields to a parent carrying a live alert from another automation", () => {
    const out = sdwanChildrenYielding([r("Overlay-1", true)], parentOf, new Set([`${A}|wan1`]));
    expect(out.get(`${A}|Microsoft|Overlay-1`)).toBe("wan1");
  });

  it("keeps a child whose parent is healthy, and one with no known parent", () => {
    expect(sdwanChildrenYielding([r("Overlay-1", true), r("wan1", false), r("Overlay-9", true)], parentOf).size).toBe(0);
  });

  it("keys per gate — another gate's lossy wan2 is no one's parent here", () => {
    const out = sdwanChildrenYielding([{ assetId: "gate-2", member: "wan2", dimKey: "x|wan2", meets: true }, r("Overlay-3", true)], parentOf);
    expect(out.size).toBe(0);
  });

  it("walks a VLAN hop to the port, bounded and cycle-safe", () => {
    const chain = new Map([[`${A}|Overlay-5`, "wan1.100"], [`${A}|wan1.100`, "wan1"]]);
    expect(sdwanChildrenYielding([r("Overlay-5", true), r("wan1", true)], chain).get(`${A}|Microsoft|Overlay-5`)).toBe("wan1");
    const loop = new Map([[`${A}|x`, "y"], [`${A}|y`, "x"]]);
    expect(sdwanChildrenYielding([r("x", true)], loop).size).toBe(0);
    const long = new Map<string, string>();
    for (let i = 0; i < SDWAN_PARENT_MAX_HOPS + 2; i++) long.set(`${A}|n${i}`, `n${i + 1}`);
    const top = `n${SDWAN_PARENT_MAX_HOPS + 2}`;
    expect(sdwanChildrenYielding([r("n0", true), r(top, true)], long).size).toBe(0);
  });
});

describe("sdwanSegmentVerdict", () => {
  const rank = (s: string) => ["notice", "informational", "warning", "serious", "critical"].indexOf(s);
  const sample = (over: Partial<SdwanStripSample> = {}): SdwanStripSample => ({
    healthCheck: "Microsoft", state: "up", latencyMs: 30, jitterMs: 1, packetLoss: 0,
    latencyThresholdMs: 150, jitterThresholdMs: 30, packetLossThreshold: 2, ...over,
  });
  const lossTiers: SdwanStripTier[] = [
    { severity: "warning", operator: ">=", threshold: 5 },
    { severity: "serious", operator: ">=", threshold: 25 },
    { severity: "critical", operator: ">=", threshold: 50 },
  ];
  const tiersFor = (metric: string) => (metric === "sdwanPacketLoss" ? lossTiers : []);

  it("is green-up with no severity when alive, in SLA and under every tier", () => {
    expect(sdwanSegmentVerdict([sample()], tiersFor, rank)).toEqual({ up: true, outOfSla: false, severity: null });
  });

  it("is down when any health check calls the member dead", () => {
    expect(sdwanSegmentVerdict([sample(), sample({ state: "down" })], tiersFor, rank)).toEqual({ up: false, outOfSla: false, severity: null });
  });

  it("is out of SLA (red) when a reading is over the health check's own target, whatever the tiers say", () => {
    const v = sdwanSegmentVerdict([sample({ packetLoss: 30, packetLossThreshold: 20 })], tiersFor, rank);
    expect(v).toEqual({ up: true, outOfSla: true, severity: null });
    expect(sdwanSegmentVerdict([sample({ latencyMs: 200 })], tiersFor, rank).outOfSla).toBe(true);
  });

  it("does not call a reading AT the SLA target a breach (FortiOS fails above it)", () => {
    expect(sdwanSegmentVerdict([sample({ packetLoss: 2 })], tiersFor, rank).outOfSla).toBe(false);
  });

  it("ignores an SLA metric with no configured target", () => {
    expect(sdwanSegmentVerdict([sample({ packetLoss: 9, packetLossThreshold: null })], tiersFor, rank).outOfSla).toBe(false);
  });

  it("takes the worst severity tier crossed across health checks and metrics", () => {
    const v = sdwanSegmentVerdict(
      [sample({ packetLoss: 6, packetLossThreshold: null }), sample({ healthCheck: "Primary WAN", packetLoss: 30, packetLossThreshold: null })],
      tiersFor, rank,
    );
    expect(v).toEqual({ up: true, outOfSla: false, severity: "serious" });
  });

  it("asks for tiers per health check, so a rule filtered to one check shades only it", () => {
    const perHc = (metric: string, hc: string) => (metric === "sdwanPacketLoss" && hc === "Primary WAN" ? lossTiers : []);
    expect(sdwanSegmentVerdict([sample({ packetLoss: 30, packetLossThreshold: null })], perHc, rank).severity).toBeNull();
  });

  it("reads an empty scrape as not up", () => {
    expect(sdwanSegmentVerdict([], tiersFor, rank).up).toBe(false);
  });
});
