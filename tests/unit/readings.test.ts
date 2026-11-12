/**
 * tests/unit/readings.test.ts — src/services/notifications/readings.ts (CQ-T010).
 *
 * The reading resolvers and the pure verdict helpers the engine applies to
 * them. Complements, rather than repeats:
 *   - interfaceStateReadings.test.ts   (interfaceSampleCarries / interfaceStateSeries)
 *   - dimensionTargetGuards.test.ts    (deletedTargetGone rule 167(a), sdwanCollectionStopped rule 174)
 *   - recoveryConfirmation.test.ts     (recoveredMeets on the rule-36 down corridor)
 *   - streamFailingField.test.ts       (rule 118 through the vocabulary)
 *   - fcPortRateReadings / notificationEngine / notificationEngineHysteresis (through the engine)
 * Pinned here directly: the device-identifier pre-filter, rule 136(e)'s
 * Priority-tag severity (device vs port subject, untagged readings dropped,
 * highest tag wins), the rule 133(g) / 136(e) tag-gate carve-out of the
 * vanished sweep, rule 118's failing-minutes arithmetic, readingMeets /
 * recoveredMeets hysteresis (the dead band), engineSustainSec's rule-36
 * zeroing, and resolveHostMetricReading's aggregation + narrowed select.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import { prisma } from "../../src/db.js";
import { resetDbStub } from "./_dbStub.js";
import type { Trigger, ResetConfig } from "../../src/services/notificationTypes.js";
import type { DbRule, ScopeAssetRow, Reading } from "../../src/services/notifications/ruleModel.js";
import {
  applyDeviceFilters,
  rulePrioritySubject,
  applyPrioritySeverity,
  tagGateGone,
  streamFailingMinutes,
  readingMeets,
  engineSustainSec,
  recoveredMeets,
  resolveHostMetricReading,
  type SweepStateRow,
} from "../../src/services/notifications/readings.js";

const T = (t: Record<string, unknown>): Trigger => t as unknown as Trigger;
const R = (r: Record<string, unknown>): ResetConfig => r as unknown as ResetConfig;
const DEVICE_DOWN = T({ type: "asset_state", field: "monitorStatus", operator: "==", value: "down" });
const PORT_DOWN = T({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" });
const rule = (o: Partial<DbRule>): DbRule => ({ id: "r1", name: "r", severity: "warning", ...o }) as unknown as DbRule;
const asset = (id: string, tags: string[] = []): ScopeAssetRow => ({ id, hostname: id, tags }) as unknown as ScopeAssetRow;
const reading = (assetId: string, dimKey = ""): Reading =>
  ({ assetId, hostname: assetId, tags: [], dimKey, dimLabel: dimKey, value: "down", series: [], readingAt: null }) as Reading;
const st = (id: string, assetId: string, dimensionKey = ""): SweepStateRow =>
  ({ id, assetId, dimensionKey, state: "firing", notificationId: null });

beforeEach(() => resetDbStub());

describe("applyDeviceFilters", () => {
  const assets = [
    { id: "a", hostname: "core-sw-1", ipAddress: "10.0.0.1", macAddress: null, manufacturer: "Cisco", model: "C9300" },
    { id: "b", hostname: "edge-fw-1", ipAddress: "10.0.1.1", macAddress: null, manufacturer: "Fortinet", model: "FG-100F" },
  ];
  it("returns the same array when there is no filter or no device dimension set", () => {
    expect(applyDeviceFilters(assets, undefined)).toBe(assets);
    expect(applyDeviceFilters(assets, {} as never)).toBe(assets);
    expect(applyDeviceFilters(assets, { ifNamePattern: "port1" } as never)).toBe(assets);
  });
  it("narrows on hostname / manufacturer / model substrings, case-blind, ANDed", () => {
    expect(applyDeviceFilters(assets, { hostnamePattern: "CORE" } as never).map((a) => a.id)).toEqual(["a"]);
    expect(applyDeviceFilters(assets, { manufacturerPattern: "forti" } as never).map((a) => a.id)).toEqual(["b"]);
    expect(applyDeviceFilters(assets, { hostnamePattern: "core", modelPattern: "100F" } as never)).toEqual([]);
  });
});

describe("rulePrioritySubject (rule 136(e))", () => {
  it("is null unless the rule opts in", () => {
    expect(rulePrioritySubject({ severityFromPriorityTag: false, trigger: DEVICE_DOWN } as never)).toBeNull();
    expect(rulePrioritySubject({ trigger: DEVICE_DOWN } as never)).toBeNull();
  });
  it("device for monitorStatus == down, interface for ifOperStatus == down, null otherwise", () => {
    expect(rulePrioritySubject({ severityFromPriorityTag: true, trigger: DEVICE_DOWN } as never)).toBe("device");
    expect(rulePrioritySubject({ severityFromPriorityTag: true, trigger: PORT_DOWN } as never)).toBe("interface");
    expect(rulePrioritySubject({ severityFromPriorityTag: true, trigger: T({ type: "asset_state", field: "monitorStatus", operator: "!=", value: "up" }) } as never)).toBeNull();
    expect(rulePrioritySubject({ severityFromPriorityTag: true, trigger: T({ type: "asset_metric", metric: "cpuPct" }) } as never)).toBeNull();
  });
});

describe("applyPrioritySeverity (rule 136(e))", () => {
  it("is a null no-op for an ordinary rule", async () => {
    expect(await applyPrioritySeverity(rule({ trigger: DEVICE_DOWN }), [reading("a")], new Map())).toBeNull();
    expect(prisma.assetInterfaceTag.findMany).not.toHaveBeenCalled();
  });

  it("device subject: reads the scope row's tags, keeps the highest Priority tag, drops untagged", async () => {
    const idx = new Map([
      ["a", asset("a", ["Warning", " critical ", "core"])],
      ["b", asset("b", ["core"])],
      ["c", asset("c", ["notice"])],
    ]);
    const out = await applyPrioritySeverity(rule({ trigger: DEVICE_DOWN, severityFromPriorityTag: true } as never), [reading("a"), reading("b"), reading("c")], idx);
    expect(out!.readings.map((r) => r.assetId)).toEqual(["a", "c"]);
    expect(out!.severityByKey.get("a|")).toBe("critical");
    expect(out!.severityByKey.get("c|")).toBe("notice");
    expect(prisma.assetInterfaceTag.findMany).not.toHaveBeenCalled();
  });

  it("interface subject: one read of the five Priority tags for the readings' assets, keyed by port", async () => {
    vi.mocked(prisma.assetInterfaceTag.findMany).mockResolvedValue([
      { assetId: "a", ifName: "port1", tag: "Serious" },
      { assetId: "a", ifName: "port1", tag: "Informational" },
      { assetId: "a", ifName: "port3", tag: "Notice" },
    ] as never);
    const out = await applyPrioritySeverity(
      rule({ trigger: PORT_DOWN, severityFromPriorityTag: true } as never),
      [reading("a", "port1"), reading("a", "port2"), reading("a", "port3")],
      new Map([["a", asset("a", ["Critical"])]]),
    );
    expect(out!.readings.map((r) => r.dimKey)).toEqual(["port1", "port3"]);
    expect(out!.severityByKey.get("a|port1")).toBe("serious");
    // The DEVICE's own Critical tag does not leak onto a port.
    expect(out!.severityByKey.get("a|port3")).toBe("notice");
    expect(prisma.assetInterfaceTag.findMany).toHaveBeenCalledTimes(1);
    const where = vi.mocked(prisma.assetInterfaceTag.findMany).mock.calls[0][0]!.where as { assetId: unknown; OR: unknown[] };
    expect(where.assetId).toEqual({ in: ["a"] });
    expect(where.OR).toHaveLength(5);
  });
});

describe("tagGateGone (rules 133(g), 136(e))", () => {
  it("no rows → empty set, no query", async () => {
    expect((await tagGateGone(rule({ trigger: PORT_DOWN }), [], new Map())).size).toBe(0);
    expect(prisma.assetInterfaceTag.findMany).not.toHaveBeenCalled();
  });

  it("ifTag filter: a port that lost the tag is gone, one that keeps it stays", async () => {
    vi.mocked(prisma.assetInterfaceTag.findMany).mockResolvedValue([{ assetId: "a", ifName: "p1", tag: "uplink" }] as never);
    const r = rule({ trigger: T({ type: "asset_state", field: "ifOperStatus", operator: "==", value: "down", dimensionFilter: { ifTag: "UPLINK" } }) });
    const gone = await tagGateGone(r, [st("s1", "a", "p1"), st("s2", "a", "p2")], new Map());
    expect([...gone]).toEqual(["s2"]);
  });

  it("interface Priority subject: a port with no Priority tag left is gone", async () => {
    vi.mocked(prisma.assetInterfaceTag.findMany).mockResolvedValue([
      { assetId: "a", ifName: "p1", tag: "Critical" },
      { assetId: "a", ifName: "p2", tag: "uplink" },
    ] as never);
    const r = rule({ trigger: PORT_DOWN, severityFromPriorityTag: true } as never);
    const gone = await tagGateGone(r, [st("s1", "a", "p1"), st("s2", "a", "p2")], new Map());
    expect([...gone]).toEqual(["s2"]);
  });

  it("device Priority subject: reads the scope row, no port query", async () => {
    const r = rule({ trigger: DEVICE_DOWN, severityFromPriorityTag: true } as never);
    const idx = new Map([["a", asset("a", ["Warning"])], ["b", asset("b", [])]]);
    const gone = await tagGateGone(r, [st("s1", "a"), st("s2", "b"), st("s3", "missing")], idx);
    expect([...gone].sort()).toEqual(["s2", "s3"]);
    expect(prisma.assetInterfaceTag.findMany).not.toHaveBeenCalled();
  });

  it("an ordinary rule retires nothing", async () => {
    const gone = await tagGateGone(rule({ trigger: PORT_DOWN }), [st("s1", "a", "p1")], new Map());
    expect(gone.size).toBe(0);
    expect(prisma.assetInterfaceTag.findMany).not.toHaveBeenCalled();
  });
});

describe("streamFailingMinutes (rule 118)", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m));
  it("never attempted → null; healthy → 0", () => {
    expect(streamFailingMinutes(null, t(0))).toBeNull();
    expect(streamFailingMinutes(t(5), null)).toBe(0);
  });
  it("whole minutes from first failure to the LATEST attempt, floored", () => {
    expect(streamFailingMinutes(t(17), t(5))).toBe(12);
    expect(streamFailingMinutes(new Date(t(5).getTime() + 59_999), t(5))).toBe(0);
  });
  it("never negative when the stamps are out of order", () => {
    expect(streamFailingMinutes(t(1), t(5))).toBe(0);
  });
});

describe("readingMeets", () => {
  const cpu = T({ type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 });
  it("null/undefined never meets", () => {
    expect(readingMeets(cpu, null)).toBe(false);
    expect(readingMeets(cpu, undefined as never)).toBe(false);
  });
  it("numeric triggers need a number", () => {
    expect(readingMeets(cpu, 90)).toBe(true);
    expect(readingMeets(cpu, 89.9)).toBe(false);
    expect(readingMeets(cpu, "95")).toBe(false);
    expect(readingMeets(T({ type: "host_metric", metric: "cpuPct", operator: "<", threshold: 10 }), 5)).toBe(true);
  });
  it("state triggers compare case-blind and coerce numbers for ordered ops", () => {
    expect(readingMeets(DEVICE_DOWN, "DOWN")).toBe(true);
    expect(readingMeets(DEVICE_DOWN, "up")).toBe(false);
    expect(readingMeets(T({ type: "asset_state", field: "consecutiveFailures", operator: ">", value: 2 }), "3")).toBe(true);
  });
  it("event / change triggers never meet a reading", () => {
    expect(readingMeets(T({ type: "event", actionPattern: "*" }), 1)).toBe(false);
  });
});

describe("engineSustainSec / recoveredMeets", () => {
  const cpu = T({ type: "asset_metric", metric: "cpuPct", operator: ">=", threshold: 90 });

  it("engineSustainSec is the reset's sustain, or 0 when the monitor machine served it (rule 36)", () => {
    expect(engineSustainSec({ trigger: cpu, reset: R({ mode: "auto", sustainSec: 300 }) })).toBe(300);
    expect(engineSustainSec({ trigger: cpu, reset: R({ mode: "auto" }) })).toBe(0);
    expect(engineSustainSec({ trigger: DEVICE_DOWN, reset: R({ mode: "auto", sustainSec: 300 }) })).toBe(0);
  });

  it("without a clear threshold, recovery is simply !meets", () => {
    expect(recoveredMeets(cpu, R({ mode: "auto" }), 85)).toBe(true);
    expect(recoveredMeets(cpu, R({ mode: "auto" }), 95)).toBe(false);
    expect(recoveredMeets(cpu, R({ mode: "auto" }), null)).toBe(true);
  });

  it("with a clear threshold: the dead band holds, crossing the clear line recovers", () => {
    const reset = R({ mode: "auto", clearThreshold: 80 });
    expect(recoveredMeets(cpu, reset, 95)).toBe(false);
    expect(recoveredMeets(cpu, reset, 85)).toBe(false); // dead band
    expect(recoveredMeets(cpu, reset, 80)).toBe(false); // still >= 80
    expect(recoveredMeets(cpu, reset, 79.9)).toBe(true);
  });

  it("a clear threshold is ignored on a manual reset and on state triggers", () => {
    expect(recoveredMeets(cpu, R({ mode: "manual", clearThreshold: 80 }), 85)).toBe(true);
    expect(recoveredMeets(DEVICE_DOWN, R({ mode: "auto", clearThreshold: 1 }), "up")).toBe(true);
  });

  it("a rule-36 down alert holds through recovering/warning and clears on up or no reading", () => {
    const reset = R({ mode: "auto", sustainSec: 180 });
    expect(recoveredMeets(DEVICE_DOWN, reset, "recovering")).toBe(false);
    expect(recoveredMeets(DEVICE_DOWN, reset, "Warning")).toBe(false);
    expect(recoveredMeets(DEVICE_DOWN, reset, "up")).toBe(true);
    expect(recoveredMeets(DEVICE_DOWN, reset, null)).toBe(true);
  });
});

describe("resolveHostMetricReading", () => {
  const NOW = new Date("2026-05-10T12:00:00Z");
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());
  const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
  const host = (o: Record<string, unknown>) =>
    T({ type: "host_metric", metric: "cpuPct", aggregation: "latest", windowSec: 0, operator: ">", threshold: 90, forDurationSec: 0, ...o }) as Extract<Trigger, { type: "host_metric" }>;

  it("no samples → null", async () => {
    vi.mocked(prisma.hostMetricsSample.findMany).mockResolvedValue([] as never);
    expect(await resolveHostMetricReading(host({}))).toBeNull();
  });

  it("selects only the timestamp and the metric's own column, over the default 15 min lookback", async () => {
    vi.mocked(prisma.hostMetricsSample.findMany).mockResolvedValue([] as never);
    await resolveHostMetricReading(host({ metric: "memUsedPct" }));
    const args = vi.mocked(prisma.hostMetricsSample.findMany).mock.calls[0][0]!;
    expect(args.select).toEqual({ timestamp: true, memUsedPct: true });
    expect(args.where).toEqual({ timestamp: { gte: ago(15 * 60) } });
    expect(args.orderBy).toEqual({ timestamp: "desc" });
  });

  it("latest takes the newest row; the series is the raw values newest-first", async () => {
    vi.mocked(prisma.hostMetricsSample.findMany).mockResolvedValue([
      { timestamp: ago(30), cpuPct: 95 }, { timestamp: ago(60), cpuPct: 50 }, { timestamp: ago(90), cpuPct: 70 },
    ] as never);
    const r = await resolveHostMetricReading(host({}));
    expect(r).toMatchObject({ assetId: "", hostname: "Polaris host", dimKey: "", value: 95, series: [95, 50, 70] });
    expect(r!.readingAt).toEqual(ago(30));
  });

  it.each([["avg", 70], ["median", 70], ["min", 50], ["max", 90]] as const)("%s aggregates the window", async (aggregation, want) => {
    vi.mocked(prisma.hostMetricsSample.findMany).mockResolvedValue([
      { timestamp: ago(30), cpuPct: 90 }, { timestamp: ago(60), cpuPct: 50 }, { timestamp: ago(90), cpuPct: 70 },
    ] as never);
    expect((await resolveHostMetricReading(host({ aggregation })))!.value).toBe(want);
  });

  it("converts the BigInt byte columns to numbers", async () => {
    vi.mocked(prisma.hostMetricsSample.findMany).mockResolvedValue([{ timestamp: ago(30), memUsedBytes: 2048n }] as never);
    expect((await resolveHostMetricReading(host({ metric: "memUsedBytes" })))!.value).toBe(2048);
  });
});
