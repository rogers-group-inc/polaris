/**
 * tests/unit/downDetectionResolver.test.ts — pickDownWinner, the pure decision
 * behind "which automation defines down for this device, and at what count".
 *
 * Overlapping automations are the CENTRAL use case for this feature ("core
 * switches down after 2 and page the NOC; workstations down after 10 and stay
 * in-app"), so most of this file is stacking filters and checking the ladder
 * resolves the way business rule 18 already resolves alerting.
 */

import { describe, it, expect } from "vitest";
import { pickDownWinner, DEFAULT_MISSED_POLLS, type DownRule, type DownConflict } from "../../src/services/downDetectionService.js";
import { scopeRank, type RuleScope } from "../../src/services/notificationTypes.js";
import type { ScopeAsset } from "../../src/services/notificationTypes.js";

const T0 = new Date("2026-01-01T00:00:00Z");

function mk(id: string, scope: RuleScope, threshold: number, extra?: Partial<DownRule>): DownRule {
  return {
    id,
    name: id,
    createdAt: T0,
    scope,
    rank: scopeRank(scope),
    threshold,
    recoverySustainSec: null,
    recoverySustainPolls: null,
    severity: "warning",
    dimensionFilter: undefined,
    ...extra,
  };
}

const hostnameScope = (name: string): RuleScope =>
  ({ condition: { op: "and", children: [{ field: "hostname", operator: "equals", value: name }] } }) as any;

const coreSwitch: ScopeAsset = {
  id: "sw1", hostname: "core-sw-1", assetType: "switch", tags: ["site:hq"],
  discoveredByIntegrationId: null, manufacturer: "Fortinet", model: "FortiSwitch 148F",
  ipAddress: "10.1.1.10", macAddress: "aa:bb:cc:00:00:01", os: null, status: "active",
} as any;

const workstation: ScopeAsset = {
  id: "ws1", hostname: "desk-014", assetType: "workstation", tags: [],
  discoveredByIntegrationId: null, manufacturer: "Dell", model: "OptiPlex",
  ipAddress: "10.2.0.14", macAddress: "aa:bb:cc:00:00:02", os: "Windows 11 Pro", status: "active",
} as any;

describe("pickDownWinner — coverage", () => {
  it("returns null when nothing covers the asset (= passive)", () => {
    expect(pickDownWinner([], coreSwitch)).toBeNull();
    expect(pickDownWinner([mk("a", { assetTypes: ["firewall"] }, 3)], coreSwitch)).toBeNull();
  });

  it("an all-assets automation covers everything", () => {
    const w = pickDownWinner([mk("base", { allAssets: true }, 3)], workstation);
    expect(w).toMatchObject({ ruleId: "base", threshold: 3 });
  });

  it("falls back to the default count when the rule carries none", () => {
    // A rule authored before the count existed still governs, at the number
    // that was in force when it was written.
    const legacy: DownRule = { ...mk("legacy", { allAssets: true }, DEFAULT_MISSED_POLLS) };
    expect(pickDownWinner([legacy], coreSwitch)?.threshold).toBe(DEFAULT_MISSED_POLLS);
  });
});

describe("pickDownWinner — most specific wins", () => {
  it("device type beats all-assets", () => {
    const rules = [mk("base", { allAssets: true }, 10), mk("sw", { assetTypes: ["switch"] }, 2)];
    expect(pickDownWinner(rules, coreSwitch)?.ruleId).toBe("sw");
    expect(pickDownWinner(rules, workstation)?.ruleId).toBe("base");
  });

  it("climbs the rule-18 ladder: all assets < device type < tag < hostname", () => {
    const rules = [
      mk("base", { allAssets: true }, 10),
      mk("type", { assetTypes: ["switch"] }, 8),
      mk("tagged", { tags: ["site:hq"] }, 5),
      mk("host", hostnameScope("core-sw-1"), 2),
    ];
    expect(pickDownWinner(rules, coreSwitch)?.ruleId).toBe("host");
    expect(pickDownWinner(rules.filter((r) => r.id !== "host"), coreSwitch)?.ruleId).toBe("tagged");
    expect(pickDownWinner(rules.filter((r) => !["host", "tagged"].includes(r.id)), coreSwitch)?.ruleId).toBe("type");
    expect(pickDownWinner([rules[0]], coreSwitch)?.ruleId).toBe("base");
  });

  it("the winner is independent of input order", () => {
    const rules = [
      mk("base", { allAssets: true }, 10),
      mk("type", { assetTypes: ["switch"] }, 5),
      mk("host", hostnameScope("core-sw-1"), 2),
    ];
    const forward = pickDownWinner(rules, coreSwitch)?.ruleId;
    const reversed = pickDownWinner(rules.slice().reverse(), coreSwitch)?.ruleId;
    expect(forward).toBe("host");
    expect(reversed).toBe("host");
  });
});

describe("pickDownWinner — device filters bound coverage", () => {
  it("a rule whose device filter excludes the asset does not cover it", () => {
    const filtered = mk("core-only", { assetTypes: ["switch"] }, 2, { dimensionFilter: { hostnamePattern: "core-" } as any });
    expect(pickDownWinner([filtered], coreSwitch)?.ruleId).toBe("core-only");

    const edge: ScopeAsset = { ...coreSwitch, id: "sw2", hostname: "edge-sw-9" } as any;
    expect(pickDownWinner([filtered], edge)).toBeNull();
  });

  it("a filtered specific rule loses the asset back to the broader one", () => {
    const rules = [
      mk("base", { allAssets: true }, 10),
      mk("core-only", { assetTypes: ["switch"] }, 2, { dimensionFilter: { hostnamePattern: "core-" } as any }),
    ];
    const edge: ScopeAsset = { ...coreSwitch, id: "sw2", hostname: "edge-sw-9" } as any;
    expect(pickDownWinner(rules, coreSwitch)?.ruleId).toBe("core-only");
    expect(pickDownWinner(rules, edge)?.ruleId).toBe("base");
  });

  it("an empty filter object constrains nothing", () => {
    const r = mk("base", { allAssets: true }, 3, { dimensionFilter: {} as any });
    expect(pickDownWinner([r], coreSwitch)?.ruleId).toBe("base");
  });
});

describe("pickDownWinner — same-rank ties", () => {
  // Two equally-specific automations over one device. Alerting tolerates this
  // (rule 18 lets same-rank ties both fire); DEFINING down cannot, so the
  // ladder is: smaller count, then older, then lower id.
  it("the SMALLER count wins — the more sensitive definition", () => {
    const sameRankA = mk("a-rule", { assetTypes: ["switch"] }, 10);
    const sameRankB = mk("b-rule", { assetTypes: ["switch"] }, 2);
    expect(pickDownWinner([sameRankA, sameRankB], coreSwitch)?.threshold).toBe(2);
    expect(pickDownWinner([sameRankB, sameRankA], coreSwitch)?.threshold).toBe(2);
  });

  it("equal counts fall through to the older rule, then the lower id", () => {
    const older = mk("zzz", { assetTypes: ["switch"] }, 5, { createdAt: new Date("2025-06-01T00:00:00Z") });
    const newer = mk("aaa", { assetTypes: ["switch"] }, 5, { createdAt: new Date("2026-06-01T00:00:00Z") });
    expect(pickDownWinner([newer, older], coreSwitch)?.ruleId).toBe("zzz");

    const sameTimeA = mk("aaa", { assetTypes: ["switch"] }, 5);
    const sameTimeB = mk("bbb", { assetTypes: ["switch"] }, 5);
    expect(pickDownWinner([sameTimeB, sameTimeA], coreSwitch)?.ruleId).toBe("aaa");
  });

  it("records a conflict only when the tied rules DISAGREE on the count", () => {
    const sink: DownConflict[] = [];
    const a = mk("a", { assetTypes: ["switch"] }, 10);
    const b = mk("b", { assetTypes: ["switch"] }, 2);
    pickDownWinner([a, b], coreSwitch, sink);
    expect(sink).toHaveLength(1);
    expect(sink[0]).toMatchObject({ assetId: "sw1", hostname: "core-sw-1", chosen: 2 });
    expect(sink[0].counts).toContain(10);

    const quiet: DownConflict[] = [];
    pickDownWinner([mk("a", { assetTypes: ["switch"] }, 5), mk("b", { assetTypes: ["switch"] }, 5)], coreSwitch, quiet);
    expect(quiet).toHaveLength(0);
  });

  it("a higher-rank rule ends the tie outright — no conflict recorded", () => {
    const sink: DownConflict[] = [];
    const rules = [
      mk("a", { assetTypes: ["switch"] }, 10),
      mk("b", { assetTypes: ["switch"] }, 2),
      mk("host", hostnameScope("core-sw-1"), 7),
    ];
    expect(pickDownWinner(rules, coreSwitch, sink)?.threshold).toBe(7);
    expect(sink).toHaveLength(0);
  });
});
