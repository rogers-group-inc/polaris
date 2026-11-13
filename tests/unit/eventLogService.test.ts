/**
 * tests/unit/eventLogService.test.ts — the own suite for
 * src/services/eventLogService.ts (CQ-T010).
 *
 * Tests the REAL module (not _eventLogStub): only Prisma (via _dbStub) and the
 * cached retention settings are mocked. Pins:
 *   - logEvent: min-level drop, level default + levelRank stamping, the
 *     Event.assetId derivation, and that a write failure never throws;
 *   - logEventsBatch: one createMany, the same filter, the written count, 0 on
 *     an empty input / all-filtered / failure;
 *   - the Events page reads (queryEventsPage, withAssetNames, eventDeviceFilter,
 *     listEventResourceTypes);
 *   - buildChanges / computeMaterialAssetChanges / snapshotMaterialAssetFields;
 *   - the discovery audit loggers (asset.discovered, asset.discovery_updated and
 *     the firmware side event);
 *   - the pure change-event builders (firmware, switch port / AP, MAC adopted,
 *     gateway firewall, FortiLink — business rule 59).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  retention: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventArchiveService.js", () => ({
  getCachedRetentionSettings: h.retention,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import {
  eventAssetIdOf,
  logEvent,
  logEventsBatch,
  queryEventsPage,
  withAssetNames,
  eventDeviceFilter,
  listEventResourceTypes,
  buildChanges,
  snapshotMaterialAssetFields,
  logDiscoveryAssetCreated,
  computeMaterialAssetChanges,
  logDiscoveryAssetUpdated,
  computeFirmwareChange,
  buildFirmwareChangedEvent,
  buildConnectionChangedEvent,
  buildMacAdoptedEvent,
  buildFirewallChangedEvent,
  buildFortilinkChangedEvent,
} from "../../src/services/eventLogService.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const created = () => stubbed(prisma.event.create).mock.calls.map((c) => c[0].data);

beforeEach(() => {
  resetDbStub();
  h.retention.mockReset();
  h.retention.mockResolvedValue({ minLevel: "info" });
  stubbed(prisma.event.create).mockResolvedValue({});
  stubbed(prisma.event.createMany).mockResolvedValue({ count: 0 });
});

// ─── eventAssetIdOf ─────────────────────────────────────────────────────────

describe("eventAssetIdOf", () => {
  it("prefers an explicit assetId over everything else", () => {
    expect(eventAssetIdOf({ assetId: "x", resourceType: "asset", resourceId: "r", details: { assetId: "d" } })).toBe("x");
  });
  it("uses the resource id when the resource IS an asset", () => {
    expect(eventAssetIdOf({ resourceType: "asset", resourceId: "r", details: { assetId: "d" } })).toBe("r");
  });
  it("falls back to details.assetId for a non-asset resource", () => {
    expect(eventAssetIdOf({ resourceType: "notification", resourceId: "n1", details: { assetId: "d" } })).toBe("d");
  });
  it("ignores an empty explicit assetId and a null one", () => {
    expect(eventAssetIdOf({ assetId: "", resourceType: "asset", resourceId: "r" })).toBe("r");
    expect(eventAssetIdOf({ assetId: null, details: { assetId: "d" } })).toBe("d");
  });
  it("returns null when details.assetId is not a non-empty string", () => {
    expect(eventAssetIdOf({ details: { assetId: 42 } })).toBeNull();
    expect(eventAssetIdOf({ details: { assetId: "" } })).toBeNull();
    expect(eventAssetIdOf({})).toBeNull();
  });
  it("an asset resource with no id falls through to details", () => {
    expect(eventAssetIdOf({ resourceType: "asset", details: { assetId: "d" } })).toBe("d");
  });
});

// ─── logEvent ───────────────────────────────────────────────────────────────

describe("logEvent", () => {
  it("writes one Event with level info + levelRank 0 by default", async () => {
    await logEvent({ action: "a.b", message: "m", resourceType: "subnet", resourceId: "s1", resourceName: "S", actor: "bob" });
    expect(created()).toEqual([
      {
        action: "a.b",
        resourceType: "subnet",
        resourceId: "s1",
        resourceName: "S",
        actor: "bob",
        message: "m",
        level: "info",
        levelRank: 0,
        details: undefined,
        assetId: null,
      },
    ]);
  });

  it("stamps levelRank 1 for warning and 2 for error", async () => {
    await logEvent({ action: "w", message: "m", level: "warning" });
    await logEvent({ action: "e", message: "m", level: "error" });
    expect(created().map((d) => [d.level, d.levelRank])).toEqual([["warning", 1], ["error", 2]]);
  });

  it("stamps the derived assetId on the row", async () => {
    await logEvent({ action: "x", message: "m", resourceType: "asset", resourceId: "as1" });
    expect(created()[0].assetId).toBe("as1");
  });

  it("drops rows below the configured minimum level", async () => {
    h.retention.mockResolvedValue({ minLevel: "warning" });
    await logEvent({ action: "i", message: "m" });
    await logEvent({ action: "i2", message: "m", level: "info" });
    await logEvent({ action: "w", message: "m", level: "warning" });
    await logEvent({ action: "e", message: "m", level: "error" });
    expect(created().map((d) => d.action)).toEqual(["w", "e"]);
  });

  it("minLevel error keeps only errors", async () => {
    h.retention.mockResolvedValue({ minLevel: "error" });
    await logEvent({ action: "w", message: "m", level: "warning" });
    await logEvent({ action: "e", message: "m", level: "error" });
    expect(created().map((d) => d.action)).toEqual(["e"]);
  });

  it("an unknown minLevel keeps everything", async () => {
    h.retention.mockResolvedValue({ minLevel: "verbose" });
    await logEvent({ action: "i", message: "m" });
    expect(created()).toHaveLength(1);
  });

  it("an unknown level string is ranked 0 but kept verbatim", async () => {
    await logEvent({ action: "x", message: "m", level: "debug" as never });
    expect(created()[0]).toMatchObject({ level: "debug", levelRank: 0 });
  });

  it("never throws when the write fails", async () => {
    stubbed(prisma.event.create).mockRejectedValue(new Error("db down"));
    await expect(logEvent({ action: "x", message: "m" })).resolves.toBeUndefined();
  });

  it("never throws when the settings read fails (and writes nothing)", async () => {
    h.retention.mockRejectedValue(new Error("boom"));
    await expect(logEvent({ action: "x", message: "m" })).resolves.toBeUndefined();
    expect(prisma.event.create).not.toHaveBeenCalled();
  });
});

// ─── logEventsBatch ─────────────────────────────────────────────────────────

describe("logEventsBatch", () => {
  it("returns 0 for an empty input without reading settings", async () => {
    expect(await logEventsBatch([])).toBe(0);
    expect(h.retention).not.toHaveBeenCalled();
    expect(prisma.event.createMany).not.toHaveBeenCalled();
  });

  it("writes every kept row in ONE createMany and returns the count", async () => {
    const n = await logEventsBatch([
      { action: "a", message: "1" },
      { action: "b", message: "2", level: "error", details: { assetId: "d1" } },
    ]);
    expect(n).toBe(2);
    expect(prisma.event.createMany).toHaveBeenCalledTimes(1);
    const rows = stubbed(prisma.event.createMany).mock.calls[0][0].data;
    expect(rows.map((r: any) => [r.action, r.level, r.levelRank, r.assetId])).toEqual([
      ["a", "info", 0, null],
      ["b", "error", 2, "d1"],
    ]);
  });

  it("applies the min-level filter", async () => {
    h.retention.mockResolvedValue({ minLevel: "warning" });
    const n = await logEventsBatch([
      { action: "a", message: "1" },
      { action: "b", message: "2", level: "warning" },
    ]);
    expect(n).toBe(1);
    expect(stubbed(prisma.event.createMany).mock.calls[0][0].data.map((r: any) => r.action)).toEqual(["b"]);
  });

  it("returns 0 and writes nothing when every row is filtered", async () => {
    h.retention.mockResolvedValue({ minLevel: "error" });
    expect(await logEventsBatch([{ action: "a", message: "1" }])).toBe(0);
    expect(prisma.event.createMany).not.toHaveBeenCalled();
  });

  it("returns 0 instead of throwing when the write fails", async () => {
    stubbed(prisma.event.createMany).mockRejectedValue(new Error("x"));
    expect(await logEventsBatch([{ action: "a", message: "1" }])).toBe(0);
  });
});

// ─── reads ──────────────────────────────────────────────────────────────────

describe("queryEventsPage", () => {
  it("runs the paged read + count with the same where and names the devices", async () => {
    stubbed(prisma.event.findMany).mockResolvedValue([{ id: "e1", assetId: "a1" }, { id: "e2", assetId: null }]);
    stubbed(prisma.event.count).mockResolvedValue(7);
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a1", hostname: "host1", ipAddress: "10.0.0.1" }]);
    const where = { level: "info" };
    const out = await queryEventsPage({ where, orderBy: { timestamp: "desc" }, skip: 10, take: 5 });
    expect(prisma.event.findMany).toHaveBeenCalledWith({ where, orderBy: { timestamp: "desc" }, skip: 10, take: 5 });
    expect(prisma.event.count).toHaveBeenCalledWith({ where });
    expect(out).toEqual({
      total: 7,
      events: [
        { id: "e1", assetId: "a1", assetName: "host1" },
        { id: "e2", assetId: null, assetName: null },
      ],
    });
  });
});

describe("withAssetNames", () => {
  it("skips the asset read when no row names a device", async () => {
    const out = await withAssetNames([{ assetId: null }]);
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
    expect(out).toEqual([{ assetId: null, assetName: null }]);
  });

  it("reads each distinct id once", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([]);
    await withAssetNames([{ assetId: "a" }, { assetId: "a" }, { assetId: "b" }]);
    expect(prisma.asset.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(prisma.asset.findMany).mock.calls[0][0].where.id.in).toEqual(["a", "b"]);
  });

  it("uses hostname, else IP, else null; a deleted asset reads null", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([
      { id: "a", hostname: "h", ipAddress: "1.1.1.1" },
      { id: "b", hostname: null, ipAddress: "2.2.2.2" },
      { id: "c", hostname: "", ipAddress: null },
    ]);
    const out = await withAssetNames([{ assetId: "a" }, { assetId: "b" }, { assetId: "c" }, { assetId: "gone" }]);
    expect(out.map((e) => e.assetName)).toEqual(["h", "2.2.2.2", null, null]);
  });
});

describe("eventDeviceFilter", () => {
  it("empty → events about no device, without a lookup", async () => {
    expect(await eventDeviceFilter("ignored", "empty")).toEqual({ assetId: null });
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
  it("is_not_empty → events about some device", async () => {
    expect(await eventDeviceFilter(undefined, "is_not_empty")).toEqual({ assetId: { not: null } });
  });
  it("a blank value is no filter", async () => {
    expect(await eventDeviceFilter("   ", "contains")).toBeUndefined();
    expect(await eventDeviceFilter(undefined, undefined)).toBeUndefined();
    expect(prisma.asset.findMany).not.toHaveBeenCalled();
  });
  it("contains resolves the trimmed text to asset ids (hostname or IP, insensitive)", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a" }, { id: "b" }]);
    expect(await eventDeviceFilter("  sw1 ", "contains")).toEqual({ assetId: { in: ["a", "b"] } });
    expect(stubbed(prisma.asset.findMany).mock.calls[0][0].where).toEqual({
      OR: [
        { hostname: { contains: "sw1", mode: "insensitive" } },
        { ipAddress: { contains: "sw1", mode: "insensitive" } },
      ],
    });
  });
  it("not_contains keeps device-less events and excludes the matches", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([{ id: "a" }]);
    expect(await eventDeviceFilter("x", "not_contains")).toEqual({ OR: [{ assetId: null }, { assetId: { notIn: ["a"] } }] });
  });
  it("no match under contains filters to nothing", async () => {
    stubbed(prisma.asset.findMany).mockResolvedValue([]);
    expect(await eventDeviceFilter("zzz", undefined)).toEqual({ assetId: { in: [] } });
  });
});

describe("listEventResourceTypes", () => {
  it("groups inside the window, drops nulls, sorts", async () => {
    stubbed(prisma.event.groupBy).mockResolvedValue([{ resourceType: "subnet" }, { resourceType: null }, { resourceType: "asset" }]);
    const cutoff = new Date("2026-11-01T00:00:00Z");
    expect(await listEventResourceTypes(cutoff)).toEqual(["asset", "subnet"]);
    expect(prisma.event.groupBy).toHaveBeenCalledWith({
      by: ["resourceType"],
      where: { timestamp: { gte: cutoff }, resourceType: { not: null } },
    });
  });
});

// ─── diffs ──────────────────────────────────────────────────────────────────

describe("buildChanges", () => {
  it("reports only keys of `after` whose value moved", () => {
    expect(buildChanges({ a: 1, b: 2, c: 3 }, { a: 1, b: 5 })).toEqual({ b: { from: 2, to: 5 } });
  });
  it("returns undefined when nothing moved", () => {
    expect(buildChanges({ a: 1 }, { a: 1 })).toBeUndefined();
    expect(buildChanges({}, {})).toBeUndefined();
  });
  it("treats undefined and null as the same value", () => {
    expect(buildChanges({ a: undefined }, { a: null })).toBeUndefined();
    expect(buildChanges({}, { a: "x" })).toEqual({ a: { from: null, to: "x" } });
  });
  it("compares nested values structurally", () => {
    expect(buildChanges({ t: ["a", "b"] }, { t: ["a", "b"] })).toBeUndefined();
    expect(buildChanges({ t: ["a"] }, { t: ["a", "b"] })).toEqual({ t: { from: ["a"], to: ["a", "b"] } });
  });
  it("is key-order sensitive inside objects (JSON.stringify compare)", () => {
    // Current behaviour: a reordered object reads as a change.
    expect(buildChanges({ o: { a: 1, b: 2 } }, { o: { b: 2, a: 1 } })).toBeDefined();
  });
});

describe("snapshotMaterialAssetFields", () => {
  it("copies every material field, null when absent, and nothing else", () => {
    const snap = snapshotMaterialAssetFields({ hostname: "h", lastSeen: new Date(), status: "active" });
    expect(snap.hostname).toBe("h");
    expect(snap.status).toBe("active");
    expect(snap.osVersion).toBeNull();
    expect("lastSeen" in snap).toBe(false);
    expect(Object.keys(snap).sort()).toEqual(
      ["assetType", "hostname", "ipAddress", "learnedAddress", "learnedLocation", "macAddress", "manufacturer", "model", "notes", "os", "osVersion", "serialNumber", "status"].sort(),
    );
  });
});

describe("computeMaterialAssetChanges", () => {
  it("ignores fields discovery did not stage", () => {
    expect(computeMaterialAssetChanges({ hostname: "a" }, {})).toBeUndefined();
  });
  it("ignores non-material fields even when they moved", () => {
    expect(computeMaterialAssetChanges({ lastSeen: 1, lastSeenSwitch: "x" }, { lastSeen: 2, lastSeenSwitch: "y" })).toBeUndefined();
  });
  it("reports a moved material field", () => {
    expect(computeMaterialAssetChanges({ hostname: "a", model: "m" }, { hostname: "b", model: "m" })).toEqual({ hostname: { from: "a", to: "b" } });
  });
  it("undefined and null are equal; a staged null over a value is a change", () => {
    expect(computeMaterialAssetChanges({}, { serialNumber: null })).toBeUndefined();
    expect(computeMaterialAssetChanges({ serialNumber: "S" }, { serialNumber: null })).toEqual({ serialNumber: { from: "S", to: null } });
  });
});

// ─── discovery loggers ──────────────────────────────────────────────────────

describe("logDiscoveryAssetCreated", () => {
  it("writes asset.discovered attributed to system:discovery by default", async () => {
    logDiscoveryAssetCreated("a1", "host1", { integrationName: "FMG", integrationId: "i1", sourceKind: "fortiswitch" });
    await flush();
    expect(created()[0]).toMatchObject({
      action: "asset.discovered",
      resourceType: "asset",
      resourceId: "a1",
      resourceName: "host1",
      actor: "system:discovery",
      message: 'Asset "host1" discovered by FMG (fortiswitch)',
      details: { integrationId: "i1", integrationName: "FMG", sourceKind: "fortiswitch" },
      assetId: "a1",
    });
  });
  it("labels by id when nameless, omits the source suffix, keeps an operator actor", async () => {
    logDiscoveryAssetCreated("a1", null, { integrationName: "AD", actor: "alice" });
    await flush();
    expect(created()[0]).toMatchObject({ resourceName: undefined, actor: "alice", message: 'Asset "a1" discovered by AD' });
  });
});

describe("logDiscoveryAssetUpdated", () => {
  const ctx = { integrationName: "Entra", integrationId: "i9", sourceKind: "entra" };

  it("writes nothing when no material field moved", async () => {
    logDiscoveryAssetUpdated({ hostname: "a" }, { hostname: "a", lastSeen: new Date() }, "a1", "a", ctx);
    await flush();
    expect(prisma.event.create).not.toHaveBeenCalled();
  });

  it("writes asset.discovery_updated at info with the changes map", async () => {
    logDiscoveryAssetUpdated({ model: "x" }, { model: "y" }, "a1", "h", ctx);
    await flush();
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({
      action: "asset.discovery_updated",
      level: "info",
      actor: "system:discovery",
      message: 'Asset "h" updated by Entra discovery (entra)',
      details: { changes: { model: { from: "x", to: "y" } }, integrationId: "i9", integrationName: "Entra", sourceKind: "entra" },
    });
  });

  it("a status change raises the row to warning", async () => {
    logDiscoveryAssetUpdated({ status: "active" }, { status: "decommissioned" }, "a1", "h", ctx);
    await flush();
    expect(created()[0]).toMatchObject({ level: "warning", levelRank: 1 });
  });

  it("an osVersion upgrade also writes asset.firmware.changed", async () => {
    logDiscoveryAssetUpdated({ osVersion: "7.2" }, { osVersion: "7.4" }, "a1", "h", ctx);
    await flush();
    expect(created().map((d) => d.action).sort()).toEqual(["asset.discovery_updated", "asset.firmware.changed"]);
    const fw = created().find((d) => d.action === "asset.firmware.changed")!;
    expect(fw.details).toMatchObject({ source: "entra", integrationId: "i9", integrationName: "Entra" });
  });

  it("a first-learned osVersion is a discovery update but NOT a firmware change", async () => {
    logDiscoveryAssetUpdated({ osVersion: null }, { osVersion: "7.4" }, "a1", "h", ctx);
    await flush();
    expect(created().map((d) => d.action)).toEqual(["asset.discovery_updated"]);
  });
});

// ─── pure builders ──────────────────────────────────────────────────────────

describe("computeFirmwareChange", () => {
  it("value → different value is a change", () => {
    expect(computeFirmwareChange({ osVersion: "1", os: "A" }, { osVersion: "2", os: "B" })).toEqual({
      osVersion: { from: "1", to: "2" },
      os: { from: "A", to: "B" },
    });
  });
  it("null → value (first learn) is not", () => {
    expect(computeFirmwareChange({ osVersion: null }, { osVersion: "2" })).toBeUndefined();
  });
  it("value → null (source quiet) is not", () => {
    expect(computeFirmwareChange({ osVersion: "1" }, { osVersion: null })).toBeUndefined();
  });
  it("unstaged fields and equal values are not", () => {
    expect(computeFirmwareChange({ osVersion: "1" }, {})).toBeUndefined();
    expect(computeFirmwareChange({ osVersion: "1" }, { osVersion: "1" })).toBeUndefined();
  });
});

describe("buildFirmwareChangedEvent", () => {
  const ctx = { assetId: "a1", assetName: "fw1" };
  it("returns undefined when nothing moved", () => {
    expect(buildFirmwareChangedEvent(ctx, { osVersion: "1" }, { osVersion: "1" })).toBeUndefined();
  });
  it("osVersion only", () => {
    const e = buildFirmwareChangedEvent(ctx, { osVersion: "7.2.1" }, { osVersion: "7.4.0" })!;
    expect(e).toMatchObject({
      action: "asset.firmware.changed",
      resourceType: "asset",
      resourceId: "a1",
      resourceName: "fw1",
      actor: "system:discovery",
      level: "info",
      message: 'Asset "fw1" firmware changed: 7.2.1 → 7.4.0',
    });
  });
  it("os only reads 'OS changed:'", () => {
    expect(buildFirmwareChangedEvent(ctx, { os: "FortiOS" }, { os: "FortiSwitchOS" })!.message).toBe('Asset "fw1" OS changed: FortiOS → FortiSwitchOS');
  });
  it("both read as one sentence", () => {
    expect(buildFirmwareChangedEvent(ctx, { os: "A", osVersion: "1" }, { os: "B", osVersion: "2" })!.message).toBe('Asset "fw1" firmware changed: 1 → 2; OS A → B');
  });
  it("labels by id, keeps the actor, nulls in ctx become undefined in details", () => {
    const e = buildFirmwareChangedEvent({ assetId: "a1", actor: "op", source: null, integrationId: null }, { osVersion: "1" }, { osVersion: "2" })!;
    expect(e.message.startsWith('Asset "a1"')).toBe(true);
    expect(e.actor).toBe("op");
    expect(e.resourceName).toBeUndefined();
    expect(e.details).toEqual({ changes: { osVersion: { from: "1", to: "2" } }, source: undefined, integrationId: undefined, integrationName: undefined });
  });
});

describe("buildConnectionChangedEvent", () => {
  const ctx = { assetId: "a1", assetName: "pc", source: "fortiap" };
  it("a null / blank `to` is no event", () => {
    expect(buildConnectionChangedEvent("switch", ctx, "sw1/port1", null)).toBeUndefined();
    expect(buildConnectionChangedEvent("ap", ctx, "ap1", "   ")).toBeUndefined();
  });
  it("a trim / case-only difference is no event", () => {
    expect(buildConnectionChangedEvent("ap", ctx, " AP-1 ", "ap-1")).toBeUndefined();
  });
  it("switch move", () => {
    const e = buildConnectionChangedEvent("switch", ctx, "sw1/port1", " sw1/port2 ")!;
    expect(e).toMatchObject({
      action: "asset.switch_port.changed",
      message: 'Asset "pc" switch port changed: sw1/port1 → sw1/port2',
      details: { changes: { lastSeenSwitch: { from: "sw1/port1", to: "sw1/port2" } }, source: "fortiap" },
    });
  });
  it("first switch attachment reads (none) and from is null", () => {
    const e = buildConnectionChangedEvent("switch", ctx, null, "sw1/port1")!;
    expect(e.message).toBe('Asset "pc" switch port changed: (none) → sw1/port1');
    expect((e.details as any).changes.lastSeenSwitch.from).toBeNull();
  });
  it("AP roam vs first connect", () => {
    expect(buildConnectionChangedEvent("ap", ctx, "ap1", "ap2")!).toMatchObject({
      action: "asset.wireless_ap.changed",
      message: 'Asset "pc" roamed to AP "ap2" (was "ap1")',
    });
    expect(buildConnectionChangedEvent("ap", ctx, undefined, "ap2")!.message).toBe('Asset "pc" connected to AP "ap2"');
  });
});

describe("buildMacAdoptedEvent", () => {
  it("names the IP and attributes to the upstream-chain sweep", () => {
    const e = buildMacAdoptedEvent({ assetId: "a1" }, "10.1.1.5", "aa:bb:cc:dd:ee:ff");
    expect(e).toMatchObject({
      action: "asset.mac.adopted",
      resourceId: "a1",
      actor: "system:upstream-chain",
      message: "Asset \"a1\" adopted MAC aa:bb:cc:dd:ee:ff, resolved from the owning FortiGate's ARP entry for 10.1.1.5",
      details: { changes: { macAddress: { from: null, to: "aa:bb:cc:dd:ee:ff" } } },
    });
  });
});

describe("buildFirewallChangedEvent", () => {
  const ctx = { assetId: "a1", assetName: "pc" };
  it("same gate (case-insensitive) or blank next is no event", () => {
    expect(buildFirewallChangedEvent(ctx, "FGT-A", "fgt-a")).toBeUndefined();
    expect(buildFirewallChangedEvent(ctx, "FGT-A", " ")).toBeUndefined();
  });
  it("a move names both gates; a first sighting reads (none)", () => {
    expect(buildFirewallChangedEvent(ctx, "A", "B")!).toMatchObject({
      action: "asset.gateway_firewall.changed",
      message: 'Asset "pc" gateway FortiGate changed: A → B',
      details: { changes: { seenFirewall: { from: "A", to: "B" } } },
    });
    expect(buildFirewallChangedEvent(ctx, "", "B")!.message).toBe('Asset "pc" gateway FortiGate changed: (none) → B');
  });
});

describe("buildFortilinkChangedEvent (rule 59)", () => {
  const ctx = { assetId: "a1", assetName: "sw1" };
  it("null / unchanged to is no event", () => {
    expect(buildFortilinkChangedEvent(ctx, "up", null)).toBeUndefined();
    expect(buildFortilinkChangedEvent(ctx, "up", "up")).toBeUndefined();
  });
  it("up → down is a warning", () => {
    const e = buildFortilinkChangedEvent(ctx, "up", "down")!;
    expect(e).toMatchObject({
      action: "asset.fortilink.changed",
      actor: "system:fortilink-sweep",
      level: "warning",
      message: 'Asset "sw1" controller link up → down',
      details: { changes: { fortilinkStatus: { from: "up", to: "down" } } },
    });
  });
  it("down → up is info", () => {
    expect(buildFortilinkChangedEvent(ctx, "down", "up")!.level).toBe("info");
  });
  it("a first observation is info even when down", () => {
    const e = buildFortilinkChangedEvent(ctx, null, "down")!;
    expect(e.level).toBe("info");
    expect(e.message).toBe('Asset "sw1" controller link is down');
  });
  it("appends the controller's raw word only when it adds something", () => {
    expect(buildFortilinkChangedEvent(ctx, "up", "down", "offline")!.message).toBe('Asset "sw1" controller link up → down (controller reports "offline")');
    expect(buildFortilinkChangedEvent(ctx, "up", "down", "DOWN")!.message).toBe('Asset "sw1" controller link up → down');
  });
});
