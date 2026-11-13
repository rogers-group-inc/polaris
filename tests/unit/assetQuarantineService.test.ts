/**
 * tests/unit/assetQuarantineService.test.ts — assetQuarantineService's own suite
 * (CQ-T010): the ORCHESTRATION half, against fake gates.
 *
 * Complements, and does not repeat:
 *   - quarantineRequestShape.test.ts   — the per-gate write (PUT body, foreign
 *                                        entries, rollback, idempotent no-op)
 *   - quarantinePushBodyAscii.test.ts  — description sanitising through a push
 *   - quarantinePushAvailability.test.ts — getQuarantinePushAvailability
 *   - quarantineStatusDrift.test.ts    — getQuarantineStatus, recordQuarantineDrift
 *   - integration/quarantineStranded.test.ts — rule 165 / 165(a) end to end on a
 *                                        real DB (retry, dismiss, delete guard, merges)
 *   - assetWriteService / dhcpPhasesExtracted11 — callers
 *
 * Covered here: quarantineAsset (infrastructure refusal, MAC collection incl.
 * ranges, sightings, token scope 403, push toggle off = skipped, transport
 * failure recorded, 0-success 502 + Event, partial success, the re-quarantine
 * park of statusBefore / monitoredBefore, rule 165 stranded gates cleared by a
 * fresh push); releaseQuarantine (rule 165: still releases, restores status and
 * monitored in ONE write, records unreachable and integration-less gates as
 * stranded, keeps prior stranded history, two Events; token scope refuses a
 * partial release); verifyAssetQuarantine (drift flip only from synced, a
 * transport error never flips); mergeQuarantineTargets (rule 114(d));
 * asciiForDevice; assertQuarantineStatusUntouched.
 *
 * Each gate is a fake at the callFortiOs seam that ECHOES writes, so read-back
 * verification runs for real. No device, socket or FortiOS is contacted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const fake = vi.hoisted(() => {
  const gates = new Map<string, { quarantine: string; targets: any[] }>();
  const unreachable = new Set<string>();
  return { gates, unreachable };
});

vi.mock("../../src/services/reservationPushService.js", () => ({
  normalizeMac: (m: string) => String(m).trim().toLowerCase().replace(/-/g, ":"),
  buildTransportForIntegration: vi.fn(async (_i: { id: string }, device: string) =>
    ({ kind: "direct-fortigate", vdom: "root", fgConfig: { host: device } })),
  callFortiOs: vi.fn(async (t: any, method: string, _path: string, body?: any) => {
    const host = t.fgConfig.host as string;
    if (fake.unreachable.has(host)) throw new Error(`connect ETIMEDOUT ${host}`);
    let g = fake.gates.get(host);
    if (!g) { g = { quarantine: "enable", targets: [] }; fake.gates.set(host, g); }
    if (method === "GET") return JSON.parse(JSON.stringify(g));
    if (method === "PUT") { g.targets = JSON.parse(JSON.stringify(body.targets)); return {}; }
    throw new Error("unexpected " + method);
  }),
}));
vi.mock("../../src/services/assetSightingService.js", () => ({ getQuarantineCandidates: vi.fn(async () => []) }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

import {
  quarantineAsset,
  releaseQuarantine,
  verifyAssetQuarantine,
  mergeQuarantineTargets,
  asciiForDevice,
  assertQuarantineStatusUntouched,
  type QuarantineTargetRecord,
} from "../../src/services/assetQuarantineService.js";
import { buildTransportForIntegration } from "../../src/services/reservationPushService.js";
import { getQuarantineCandidates } from "../../src/services/assetSightingService.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const ASSET_ID = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
const ENTRY = "polaris-q-aaaabbbbcccc";

function asset(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ASSET_ID, hostname: "WKS-01", ipAddress: "10.1.1.5", assetType: "workstation",
    status: "active", monitored: true, macAddress: "00-11-22-33-44-55", macAddressRows: [],
    statusBeforeQuarantine: null, monitoredBeforeQuarantine: null, quarantineReason: null,
    quarantinedAt: null, quarantineTargets: null, quarantineStranded: null, ...over,
  };
}
const integ = (id: string, push = true) => ({ id, type: "fortigate", enabled: true, config: { pushQuarantine: push } });
const sighting = (integrationId: string | null, fortigateDevice: string) =>
  ({ id: "s-" + fortigateDevice, assetId: ASSET_ID, integrationId, fortigateDevice, source: "dhcp", ipAddress: null, firstSeen: NOW, lastSeen: NOW });
const target = (fortigateDevice: string, integrationId: string, status: QuarantineTargetRecord["status"] = "synced"): QuarantineTargetRecord =>
  ({ fortigateDevice, integrationId, pushedMacs: ["00:11:22:33:44:55"], pushedAt: NOW.toISOString(), status });
const updateData = () => stubbed(prisma.asset.update).mock.calls.at(-1)![0].data;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetDbStub();
  resetEventLogStub();
  fake.gates.clear();
  fake.unreachable.clear();
  vi.mocked(getQuarantineCandidates).mockReset();
  vi.mocked(getQuarantineCandidates).mockResolvedValue([]);
  stubbed(prisma.asset.update).mockResolvedValue({});
});
afterEach(() => {
  vi.useRealTimers();
});

describe("quarantineAsset — refusals before any device is touched", () => {
  it("404s a missing asset", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    await expect(quarantineAsset({ assetId: ASSET_ID, actor: "user:a" })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it.each(["firewall", "switch", "access_point"])("refuses a %s (it would cut off the operator)", async (assetType) => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ assetType }));
    await expect(quarantineAsset({ assetId: ASSET_ID, actor: "user:a" })).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining(`is a ${assetType}`) });
    expect(getQuarantineCandidates).not.toHaveBeenCalled();
  });

  it("refuses an asset with no valid MAC", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ macAddress: "not-a-mac", macAddressRows: [] }));
    await expect(quarantineAsset({ assetId: ASSET_ID, actor: "user:a" })).rejects.toThrow(/no MAC addresses/);
  });

  it("409s with no recent sightings", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    await expect(quarantineAsset({ assetId: ASSET_ID, actor: "user:a" })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("403s a token whose integrations saw none of the sightings", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    vi.mocked(getQuarantineCandidates).mockResolvedValue([sighting("i-other", "gate-x")]);
    await expect(quarantineAsset({ assetId: ASSET_ID, actor: "api:siem", tokenIntegrationIds: ["i-mine"] })).rejects.toMatchObject({ httpStatus: 403 });
    expect(prisma.integration.findMany).not.toHaveBeenCalled();
  });
});

describe("quarantineAsset — the fan-out", () => {
  beforeEach(() => {
    stubbed(prisma.integration.findMany).mockResolvedValue([integ("i1"), integ("i2"), integ("i-off", false)]);
  });

  it("pushes every MAC (ranges expanded) to each enabled gate, flips the status and parks status + monitored", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({
      macAddressRows: [{ mac: "aa:bb:cc:00:00:01", macEnd: "AA:BB:CC:00:00:02" }, { mac: "" }],
    }));
    vi.mocked(getQuarantineCandidates).mockResolvedValue([sighting("i1", "gate-a"), sighting("i2", "gate-b")]);
    const res = await quarantineAsset({ assetId: ASSET_ID, actor: "user:alice", reason: "malware" });

    expect(res).toMatchObject({ status: "quarantined", succeededCount: 2, failedCount: 0 });
    const onGate = fake.gates.get("gate-a")!.targets.find((t) => t.entry === ENTRY);
    expect(onGate.macs.map((m: any) => m.mac).sort()).toEqual(["00:11:22:33:44:55", "aa:bb:cc:00:00:01", "aa:bb:cc:00:00:02"]);
    expect(updateData()).toMatchObject({
      status: "quarantined", statusChangedBy: "user:alice", statusBeforeQuarantine: "active", monitoredBeforeQuarantine: true,
      quarantineReason: "malware", quarantinedAt: NOW, quarantinedBy: "user:alice",
    });
    expect(updateData().quarantineTargets.map((t: any) => [t.fortigateDevice, t.status])).toEqual([["gate-a", "synced"], ["gate-b", "synced"]]);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.quarantine.succeeded", level: "info" });
  });

  it("silently skips a gate whose integration has push off, a disabled/deleted integration, and an integration-less sighting", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    vi.mocked(getQuarantineCandidates).mockResolvedValue([
      sighting("i1", "gate-a"), sighting("i-off", "gate-off"), sighting("i-gone", "gate-gone"), sighting(null, "gate-null"),
    ]);
    const res = await quarantineAsset({ assetId: ASSET_ID, actor: "user:a" });
    expect(res.targets.map((t) => t.fortigateDevice)).toEqual(["gate-a"]);
    expect(fake.gates.has("gate-off")).toBe(false);
  });

  it("partial: one gate unreachable, one transport that cannot be built — still quarantined, warning Event", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    stubbed(prisma.integration.findMany).mockResolvedValue([integ("i1"), integ("i2"), integ("i3")]);
    vi.mocked(getQuarantineCandidates).mockResolvedValue([sighting("i1", "gate-a"), sighting("i2", "gate-down"), sighting("i3", "gate-nocfg")]);
    fake.unreachable.add("gate-down");
    vi.mocked(buildTransportForIntegration).mockImplementationOnce(async (_i, d) => ({ kind: "direct-fortigate", vdom: "root", fgConfig: { host: d } }) as never);
    vi.mocked(buildTransportForIntegration).mockImplementationOnce(async (_i, d) => ({ kind: "direct-fortigate", vdom: "root", fgConfig: { host: d } }) as never);
    vi.mocked(buildTransportForIntegration).mockRejectedValueOnce(new Error("FortiGate integration has no API token"));

    const res = await quarantineAsset({ assetId: ASSET_ID, actor: "user:a" });
    expect(res).toMatchObject({ succeededCount: 1, failedCount: 2 });
    expect(res.targets.find((t) => t.fortigateDevice === "gate-down")).toMatchObject({ status: "failed", pushedMacs: [], error: expect.stringContaining("ETIMEDOUT") });
    expect(res.targets.find((t) => t.fortigateDevice === "gate-nocfg")).toMatchObject({ status: "failed", error: "FortiGate integration has no API token" });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.quarantine.partial", level: "warning" });
    expect(updateData().status).toBe("quarantined");
  });

  it("nothing landed: 502 naming the first error, a failed Event, and NO status write", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    vi.mocked(getQuarantineCandidates).mockResolvedValue([sighting("i1", "gate-down")]);
    fake.unreachable.add("gate-down");
    await expect(quarantineAsset({ assetId: ASSET_ID, actor: "user:a" }))
      .rejects.toMatchObject({ httpStatus: 502, message: expect.stringMatching(/0\/1 FortiGate\(s\) accepted the push\. First error: connect ETIMEDOUT/) });
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "asset.quarantine.failed", level: "error" });
  });

  it("push off fleet-wide: 0/0 targets is a 502, not a silent success", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset());
    vi.mocked(getQuarantineCandidates).mockResolvedValue([sighting("i-off", "gate-off")]);
    await expect(quarantineAsset({ assetId: ASSET_ID, actor: "user:a" })).rejects.toThrow(/0\/0 FortiGate\(s\)/);
  });

  it("re-quarantining an already quarantined asset keeps the ORIGINAL parked status, monitored, start time and reason", async () => {
    const started = new Date("2026-06-01T00:00:00Z");
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({
      status: "quarantined", monitored: false, statusBeforeQuarantine: "maintenance", monitoredBeforeQuarantine: true,
      quarantinedAt: started, quarantineReason: "original",
    }));
    vi.mocked(getQuarantineCandidates).mockResolvedValue([sighting("i1", "gate-a")]);
    await quarantineAsset({ assetId: ASSET_ID, actor: "system:auto-quarantine" });
    expect(updateData()).toMatchObject({ statusBeforeQuarantine: "maintenance", monitoredBeforeQuarantine: true, quarantinedAt: started, quarantineReason: "original" });
  });

  it("rule 165: a gate the fresh push reached leaves the stranded list; others stay", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({
      quarantineStranded: [
        { fortigateDevice: "gate-a", integrationId: "i1", error: "x", since: "2026-06-01T00:00:00.000Z", lastAttemptAt: "2026-06-01T00:00:00.000Z", attempts: 3 },
        { fortigateDevice: "gate-z", integrationId: "i9", error: "y", since: "2026-06-01T00:00:00.000Z", lastAttemptAt: "2026-06-01T00:00:00.000Z", attempts: 1 },
      ],
    }));
    vi.mocked(getQuarantineCandidates).mockResolvedValue([sighting("i1", "gate-a")]);
    await quarantineAsset({ assetId: ASSET_ID, actor: "user:a" });
    expect(updateData().quarantineStranded.map((e: any) => e.fortigateDevice)).toEqual(["gate-z"]);
  });

  it("a scoped token's push keeps the out-of-scope targets on record (rule 114(d))", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ status: "quarantined", quarantineTargets: [target("gate-b", "i2"), target("gate-a", "i1", "failed")] }));
    vi.mocked(getQuarantineCandidates).mockResolvedValue([sighting("i1", "gate-a"), sighting("i2", "gate-b")]);
    await quarantineAsset({ assetId: ASSET_ID, actor: "api:site-a", tokenIntegrationIds: ["i1"] });
    expect(updateData().quarantineTargets.map((t: any) => [t.fortigateDevice, t.status])).toEqual([["gate-b", "synced"], ["gate-a", "synced"]]);
    expect(fake.gates.has("gate-b")).toBe(false);
  });
});

describe("releaseQuarantine — rule 165", () => {
  function seedQuarantined(over: Record<string, unknown> = {}): void {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({
      status: "quarantined", monitored: false, statusBeforeQuarantine: "active", monitoredBeforeQuarantine: true,
      quarantineTargets: [target("gate-a", "i1"), target("gate-down", "i2"), target("gate-orphan", "i-deleted")],
      ...over,
    }));
    stubbed(prisma.integration.findMany).mockResolvedValue([integ("i1"), integ("i2")]);
    fake.gates.set("gate-a", { quarantine: "enable", targets: [{ entry: ENTRY, macs: [{ mac: "00:11:22:33:44:55", drop: "enable" }] }, { entry: "foreign", macs: [] }] });
    fake.unreachable.add("gate-down");
  }

  it("404s a missing asset and 409s one that is not quarantined", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    await expect(releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" })).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ status: "active" }));
    await expect(releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it("releases despite unreachable gates, returning the same shape as before", async () => {
    seedQuarantined();
    const res = await releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" });
    expect(res).toEqual({
      assetId: ASSET_ID, newStatus: "active", unpushedFrom: ["gate-a"],
      failedToUnpush: [
        { fortigateDevice: "gate-down", error: expect.stringContaining("ETIMEDOUT") },
        { fortigateDevice: "gate-orphan", error: expect.stringContaining("Integration no longer exists") },
      ],
      message: expect.stringContaining("2 could not be reached and will be retried"),
    });
    expect(fake.gates.get("gate-a")!.targets.map((t) => t.entry)).toEqual(["foreign"]);
  });

  it("restores status AND monitored in ONE write and clears every quarantine column", async () => {
    seedQuarantined({ statusBeforeQuarantine: "storage" });
    await releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" });
    expect(prisma.asset.update).toHaveBeenCalledTimes(1);
    expect(updateData()).toMatchObject({
      status: "storage", monitored: true, statusChangedAt: NOW, statusChangedBy: "user:a",
      statusBeforeQuarantine: null, monitoredBeforeQuarantine: null, quarantineReason: null,
      quarantinedAt: null, quarantinedBy: null, quarantineTargets: [],
    });
  });

  it("a null snapshot restores 'active' and NOT monitored", async () => {
    seedQuarantined({ statusBeforeQuarantine: null, monitoredBeforeQuarantine: null });
    await releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" });
    expect(updateData()).toMatchObject({ status: "active", monitored: false });
  });

  it("remembers each gate that still holds the block — including one whose integration was deleted", async () => {
    seedQuarantined();
    await releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" });
    expect(updateData().quarantineStranded).toEqual([
      { fortigateDevice: "gate-down", integrationId: "i2", error: expect.stringContaining("ETIMEDOUT"), since: NOW.toISOString(), lastAttemptAt: NOW.toISOString(), attempts: 1 },
      { fortigateDevice: "gate-orphan", integrationId: "i-deleted", error: "The integration that reached this FortiGate no longer exists", since: NOW.toISOString(), lastAttemptAt: NOW.toISOString(), attempts: 1 },
    ]);
  });

  it("folds into an existing stranded history: the gate keeps its since and gains an attempt", async () => {
    seedQuarantined({
      quarantineTargets: [target("gate-down", "i2")],
      quarantineStranded: [{ fortigateDevice: "gate-down", integrationId: "i2", error: "old", since: "2026-06-01T00:00:00.000Z", lastAttemptAt: "2026-06-01T00:00:00.000Z", attempts: 2 }],
    });
    await releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" });
    expect(updateData().quarantineStranded).toEqual([
      expect.objectContaining({ fortigateDevice: "gate-down", since: "2026-06-01T00:00:00.000Z", lastAttemptAt: NOW.toISOString(), attempts: 3 }),
    ]);
  });

  it("writes a released Event and, on any failure, an unpush.failed Event", async () => {
    seedQuarantined();
    await releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" });
    expect(eventLog.logEvent.mock.calls.map((c) => [c[0].action, c[0].level])).toEqual([
      ["asset.quarantine.released", "warning"], ["asset.quarantine.unpush.failed", "warning"],
    ]);
  });

  it("a clean release (entry already absent counts) writes one info Event and strands nothing", async () => {
    seedQuarantined({ quarantineTargets: [target("gate-a", "i1"), target("gate-empty", "i1")] });
    const res = await releaseQuarantine({ assetId: ASSET_ID, actor: "user:a" });
    expect(res.unpushedFrom).toEqual(["gate-a", "gate-empty"]);
    expect(updateData().quarantineStranded).toEqual([]);
    expect(eventLog.logEvent.mock.calls.map((c) => [c[0].action, c[0].level])).toEqual([["asset.quarantine.released", "info"]]);
  });

  it("a scoped token may not release a quarantine that reaches outside its integrations — no partial release", async () => {
    seedQuarantined();
    await expect(releaseQuarantine({ assetId: ASSET_ID, actor: "api:t", tokenIntegrationIds: ["i1", "i2"] }))
      .rejects.toMatchObject({ httpStatus: 403, message: expect.stringContaining("gate-orphan") });
    expect(prisma.asset.update).not.toHaveBeenCalled();
    expect(fake.gates.get("gate-a")!.targets.some((t) => t.entry === ENTRY)).toBe(true);
  });
});

describe("verifyAssetQuarantine", () => {
  beforeEach(() => {
    stubbed(prisma.integration.findMany).mockResolvedValue([integ("i1"), integ("i2"), integ("i3")]);
    fake.gates.set("gate-ok", { quarantine: "enable", targets: [{ entry: ENTRY, macs: [{ mac: "00:11:22:33:44:55" }] }] });
    fake.gates.set("gate-gone", { quarantine: "enable", targets: [] });
    fake.unreachable.add("gate-down");
  });

  it("flips a synced target missing on the device to drift, keeps others as recorded", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({
      quarantineTargets: [target("gate-ok", "i1"), target("gate-gone", "i2"), target("gate-down", "i3"), target("gate-failed", "i2", "failed"), target("gate-x", "i-deleted")],
    }));
    const res = await verifyAssetQuarantine(ASSET_ID);
    expect(res.driftDetected).toBe(true);
    expect(res.targets.map((t) => [t.fortigateDevice, t.status])).toEqual([
      ["gate-ok", "synced"], ["gate-gone", "drift"], ["gate-down", "synced"], ["gate-failed", "failed"], ["gate-x", "synced"],
    ]);
    expect(res.targets[1].error).toBe("Missing MACs on device: 00:11:22:33:44:55");
  });

  it("names the MACs a partial entry is missing", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ macAddressRows: [{ mac: "aa:bb:cc:dd:ee:ff" }], quarantineTargets: [target("gate-ok", "i1")] }));
    const res = await verifyAssetQuarantine(ASSET_ID);
    expect(res.targets[0]).toMatchObject({ status: "drift", error: "Missing MACs on device: aa:bb:cc:dd:ee:ff" });
  });

  it("404s a missing asset and 403s a token outside the recorded targets", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(null);
    await expect(verifyAssetQuarantine(ASSET_ID)).rejects.toMatchObject({ httpStatus: 404 });
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ quarantineTargets: [target("gate-ok", "i1"), target("gate-gone", "i2")] }));
    await expect(verifyAssetQuarantine(ASSET_ID, ["i1"])).rejects.toMatchObject({ httpStatus: 403 });
  });

  it("an asset with no recorded targets has nothing to drift", async () => {
    stubbed(prisma.asset.findUnique).mockResolvedValue(asset({ quarantineTargets: "garbage" }));
    stubbed(prisma.integration.findMany).mockResolvedValue([]);
    await expect(verifyAssetQuarantine(ASSET_ID)).resolves.toEqual({ targets: [], driftDetected: false });
  });
});

describe("pure helpers", () => {
  it("mergeQuarantineTargets: unscoped replaces; scoped keeps out-of-scope entries and drops junk", () => {
    const fresh = [target("gate-a", "i1")];
    expect(mergeQuarantineTargets([target("gate-b", "i2")], fresh, undefined)).toBe(fresh);
    expect(mergeQuarantineTargets([target("gate-b", "i2"), target("gate-a-old", "i1"), null, { fortigateDevice: "x" }], fresh, ["i1"]))
      .toEqual([target("gate-b", "i2"), target("gate-a", "i1")]);
    expect(mergeQuarantineTargets("not-an-array", fresh, ["i1"])).toEqual(fresh);
  });

  it("asciiForDevice: dashes to '-', other non-ASCII runs to one space, trimmed", () => {
    expect(asciiForDevice("Polaris — asset – quarantine")).toBe("Polaris - asset - quarantine");
    expect(asciiForDevice("Café\tPC  ü")).toBe("Caf PC");
    expect(asciiForDevice("日本語")).toBe("");
  });

  it("assertQuarantineStatusUntouched: status enters or leaves quarantine only through the verbs", () => {
    expect(() => assertQuarantineStatusUntouched(undefined, "quarantined")).not.toThrow();
    expect(() => assertQuarantineStatusUntouched("", null)).not.toThrow();
    expect(() => assertQuarantineStatusUntouched("quarantined", "quarantined")).not.toThrow();
    expect(() => assertQuarantineStatusUntouched("active", "storage")).not.toThrow();
    expect(() => assertQuarantineStatusUntouched("quarantined", null)).toThrow(/POST \/assets\/:id\/quarantine/);
    expect(() => assertQuarantineStatusUntouched("active", "quarantined")).toThrow(/DELETE \/assets\/:id\/quarantine/);
  });
});
