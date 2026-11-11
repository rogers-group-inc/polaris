/**
 * tests/unit/sdwanParse.test.ts
 *
 * Pure-parser tests for the SD-WAN collector (monitoringService). Cover the
 * FortiOS /api/v2/monitor/virtual-wan/health-check and /api/v2/cmdb/system/sdwan
 * response shapes, null-tolerance, the up/alive→up state mapping, the
 * seq-num→interface member resolution, and the best-effort selected-member
 * inference (first up candidate in priority order; null when none resolvable).
 */

import { describe, it, expect } from "vitest";
import { parsePerfSlaHealthCheck, parseSdwanRules, parseSdwanSlaThresholds, parseSdwanMemberZones } from "../../src/services/monitoring/fortiosCollectors.js";

describe("parsePerfSlaHealthCheck", () => {
  it("flattens results.<hc>.<member> into one sample per (hc, link)", () => {
    const res = {
      results: {
        Metrocenter: {
          "Overlay-7": { status: "up", latency: 12.5, jitter: 1.1, packet_loss: 0 },
          "Overlay-2": { status: "down", latency: 0, jitter: 0, packet_loss: 100 },
        },
        Microsoft: {
          wan1: { state: "alive", latency: 8, jitter: 0.4, packetloss: 0.2 },
        },
      },
    };
    const { perfSla, memberUp } = parsePerfSlaHealthCheck(res);
    expect(perfSla).toHaveLength(3);
    const m = perfSla.find((s) => s.healthCheck === "Metrocenter" && s.link === "Overlay-7");
    expect(m).toMatchObject({ state: "up", latencyMs: 12.5, jitterMs: 1.1, packetLoss: 0 });
    // "alive" maps to up; packetloss (no underscore) is accepted.
    expect(perfSla.find((s) => s.link === "wan1")).toMatchObject({ state: "up", packetLoss: 0.2 });
    // memberUp: a member up in ANY health-check is true.
    expect(memberUp.get("Overlay-7")).toBe(true);
    expect(memberUp.get("Overlay-2")).toBe(false);
    expect(memberUp.get("wan1")).toBe(true);
  });

  it("accepts the un-enveloped object and tolerates missing gauges / junk keys", () => {
    const res = {
      hc1: { port1: { status: "up" } },        // no latency/jitter/loss
      vdom: "root",                            // junk scalar key — skipped
    };
    const { perfSla } = parsePerfSlaHealthCheck(res);
    expect(perfSla).toHaveLength(1);
    expect(perfSla[0]).toMatchObject({ healthCheck: "hc1", link: "port1", state: "up", latencyMs: null, jitterMs: null, packetLoss: null });
  });

  it("returns empty for null / non-object", () => {
    expect(parsePerfSlaHealthCheck(null).perfSla).toEqual([]);
    expect(parsePerfSlaHealthCheck("nope").perfSla).toEqual([]);
  });

  it("stamps SLA thresholds from the threshold map onto each member of the health-check", () => {
    const res = { results: { Metrocenter: { "Overlay-7": { status: "up", latency: 40 } } } };
    const thr = new Map([["Metrocenter", { latencyMs: 200, jitterMs: null, packetLoss: 5 }]]);
    const { perfSla } = parsePerfSlaHealthCheck(res, thr);
    expect(perfSla[0]).toMatchObject({ latencyThresholdMs: 200, jitterThresholdMs: null, packetLossThreshold: 5 });
  });
});

describe("parseSdwanSlaThresholds", () => {
  it("maps each health-check to its max configured per-metric threshold (0/absent → null)", () => {
    const sdwan = {
      results: {
        "health-check": [
          { name: "Metrocenter", sla: [{ "latency-threshold": 200, "jitter-threshold": 50, "packetloss-threshold": 0 }] },
          { name: "Microsoft", sla: [
            { "latency-threshold": 150, "packetloss-threshold": 3 },
            { "latency-threshold": 250, "packetloss-threshold": 1 },
          ] },
        ],
      },
    };
    const m = parseSdwanSlaThresholds(sdwan);
    expect(m.get("Metrocenter")).toEqual({ latencyMs: 200, jitterMs: 50, packetLoss: null });
    // max across multiple sla rows; jitter absent → null.
    expect(m.get("Microsoft")).toEqual({ latencyMs: 250, jitterMs: null, packetLoss: 3 });
  });

  it("drops thresholds for metrics not in the SLA link-cost-factor (disabled SLA)", () => {
    // jitter-threshold is FortiOS's default 5 but jitter is NOT in
    // link-cost-factor → the SLA is disabled and must not surface a line.
    const sdwan = {
      results: {
        "health-check": [
          { name: "Metrocenter", sla: [{
            "link-cost-factor": "latency packet-loss",
            "latency-threshold": 250, "jitter-threshold": 5, "packetloss-threshold": 2,
          }] },
        ],
      },
    };
    expect(parseSdwanSlaThresholds(sdwan).get("Metrocenter")).toEqual({ latencyMs: 250, jitterMs: null, packetLoss: 2 });
  });

  it("accepts link-cost-factor as an array and gates per metric", () => {
    const sdwan = {
      results: {
        "health-check": [
          { name: "Microsoft", sla: [{
            "link-cost-factor": ["jitter"],
            "latency-threshold": 200, "jitter-threshold": 30, "packetloss-threshold": 5,
          }] },
        ],
      },
    };
    expect(parseSdwanSlaThresholds(sdwan).get("Microsoft")).toEqual({ latencyMs: null, jitterMs: 30, packetLoss: null });
  });

  it("falls back to all metrics when link-cost-factor is absent (older FortiOS)", () => {
    const sdwan = {
      results: {
        "health-check": [
          { name: "Legacy", sla: [{ "latency-threshold": 200, "jitter-threshold": 50, "packetloss-threshold": 0 }] },
        ],
      },
    };
    expect(parseSdwanSlaThresholds(sdwan).get("Legacy")).toEqual({ latencyMs: 200, jitterMs: 50, packetLoss: null });
  });

  it("returns an empty map for null / no health-check", () => {
    expect(parseSdwanSlaThresholds(null).size).toBe(0);
    expect(parseSdwanSlaThresholds({ results: {} }).size).toBe(0);
  });
});

describe("parseSdwanMemberZones", () => {
  it("maps each member interface to its SD-WAN zone", () => {
    const sdwan = { results: { members: [
      { "seq-num": 1, interface: "wan1", zone: "virtual-wan-link" },
      { "seq-num": 2, interface: "Overlay-7", zone: "overlay" },
      { "seq-num": 3, interface: "x1" }, // no zone → skipped
    ] } };
    const z = parseSdwanMemberZones(sdwan);
    expect(z.get("wan1")).toBe("virtual-wan-link");
    expect(z.get("Overlay-7")).toBe("overlay");
    expect(z.has("x1")).toBe(false);
  });

  it("stamps the zone onto each perfSla sample for that member", () => {
    const res = { results: { Metrocenter: { "Overlay-7": { status: "up", latency: 40 } } } };
    const zones = new Map([["Overlay-7", "overlay"]]);
    const { perfSla } = parsePerfSlaHealthCheck(res, undefined, zones);
    expect(perfSla[0]).toMatchObject({ link: "Overlay-7", zone: "overlay" });
  });

  it("returns an empty map for null / no members", () => {
    expect(parseSdwanMemberZones(null).size).toBe(0);
    expect(parseSdwanMemberZones({ results: {} }).size).toBe(0);
  });
});

describe("parseSdwanRules", () => {
  const sdwan = {
    results: {
      members: [
        { "seq-num": 1, interface: "wan1" },
        { "seq-num": 2, interface: "wan2" },
        { "seq-num": 3, interface: "Overlay-7" },
      ],
      service: [
        {
          id: 6, name: "Office365", mode: "sla", status: "enable",
          "link-cost-factor": "latency",
          "health-check": [{ name: "Metrocenter" }],
          dst: [{ name: "Microsoft-Outlook" }],
          members: [{ "seq-num": 3 }, { "seq-num": 1 }],
        },
        {
          id: 1, name: "Internet_Failover", mode: "priority", status: "enable",
          members: [{ "seq-num": 1 }, { "seq-num": 2 }],
        },
      ],
    },
  };

  it("resolves seq-num members to interfaces in priority order + carries config fields", () => {
    const rules = parseSdwanRules(sdwan, new Map());
    expect(rules).toHaveLength(2);
    const o365 = rules[0];
    expect(o365).toMatchObject({
      ruleName: "Office365", ruleId: "6", seq: 0, enabled: true, mode: "sla",
      criteria: "Latency", healthChecks: ["Metrocenter"], dst: ["Microsoft-Outlook"],
      availableMembers: ["Overlay-7", "wan1"],
    });
  });

  it("infers selectedMember as the first up candidate in priority order", () => {
    // Overlay-7 down, wan1 up → Office365 selects wan1 (2nd priority).
    const up = new Map<string, boolean>([["Overlay-7", false], ["wan1", true], ["wan2", true]]);
    const rules = parseSdwanRules(sdwan, up);
    expect(rules.find((r) => r.ruleName === "Office365")).toMatchObject({ selectedMember: "wan1", status: "up" });
    expect(rules.find((r) => r.ruleName === "Internet_Failover")).toMatchObject({ selectedMember: "wan1", status: "up" });
  });

  it("leaves selectedMember null (status down) when no candidate is up", () => {
    const up = new Map<string, boolean>([["Overlay-7", false], ["wan1", false]]);
    const o365 = parseSdwanRules(sdwan, up).find((r) => r.ruleName === "Office365");
    expect(o365).toMatchObject({ selectedMember: null, status: "down" });
  });

  it("maps load-balance → Source IP criteria and disable → enabled:false", () => {
    const r = parseSdwanRules({
      results: { members: [], service: [{ id: 2, name: "LB", mode: "load-balance", status: "disable", members: [] }] },
    }, new Map());
    expect(r[0]).toMatchObject({ criteria: "Source IP", enabled: false, availableMembers: [] });
  });

  it("returns empty for null / missing service", () => {
    expect(parseSdwanRules(null, new Map())).toEqual([]);
    expect(parseSdwanRules({ results: {} }, new Map())).toEqual([]);
  });

  it("carries an empty priorityZones for interface-member rules", () => {
    const rules = parseSdwanRules(sdwan, new Map());
    expect(rules[0].priorityZones).toEqual([]);
    expect(rules[1].priorityZones).toEqual([]);
  });
});

describe("parseSdwanRules — zone preference", () => {
  // Zone-based rule: no interface members; candidates live in `priority-zone`.
  const zonedSdwan = {
    results: {
      members: [
        { "seq-num": 1, interface: "wan1", zone: "underlay" },
        { "seq-num": 2, interface: "wan2", zone: "underlay" },
        { "seq-num": 3, interface: "Overlay-7", zone: "overlay" },
      ],
      service: [
        {
          id: 9, name: "ZonePref", mode: "sla", status: "enable",
          "priority-zone": [{ name: "overlay" }, { name: "underlay" }],
          // no members / priority-members — selection is zone-driven
        },
      ],
    },
  };

  it("captures priorityZones and resolves availableMembers from the zones' members", () => {
    const zones = parseSdwanMemberZones(zonedSdwan);
    const rule = parseSdwanRules(zonedSdwan, new Map(), zones)[0];
    // Zones in configured priority order.
    expect(rule.priorityZones).toEqual(["overlay", "underlay"]);
    // Members resolved zone-by-zone, each zone's members in global priority order.
    expect(rule.availableMembers).toEqual(["Overlay-7", "wan1", "wan2"]);
  });

  it("infers the selected member among the zone's resolved candidates", () => {
    const zones = parseSdwanMemberZones(zonedSdwan);
    // Overlay-7 down, wan1 up → first up candidate in priority order is wan1.
    const up = new Map<string, boolean>([["Overlay-7", false], ["wan1", true], ["wan2", true]]);
    const rule = parseSdwanRules(zonedSdwan, up, zones)[0];
    expect(rule).toMatchObject({ selectedMember: "wan1", status: "up" });
  });

  it("captures priorityZones but leaves members empty when no zone map is supplied", () => {
    const rule = parseSdwanRules(zonedSdwan, new Map())[0];
    expect(rule.priorityZones).toEqual(["overlay", "underlay"]);
    expect(rule.availableMembers).toEqual([]);
  });

  it("does not overwrite explicit interface members with zone members", () => {
    // A rule with BOTH members and priority-zone keeps its explicit members.
    const mixed = {
      results: {
        members: zonedSdwan.results.members,
        service: [{
          id: 10, name: "Mixed", mode: "sla", status: "enable",
          "priority-zone": [{ name: "underlay" }],
          members: [{ "seq-num": 3 }],
        }],
      },
    };
    const zones = parseSdwanMemberZones(mixed);
    const rule = parseSdwanRules(mixed, new Map(), zones)[0];
    expect(rule.availableMembers).toEqual(["Overlay-7"]);
    expect(rule.priorityZones).toEqual(["underlay"]);
  });
});
