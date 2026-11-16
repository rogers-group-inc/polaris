/**
 * tests/unit/assetSightingService.test.ts — CQ-T010 own suite for
 * src/services/assetSightingService.ts.
 *
 * tests/unit/assetSightingFreshest.test.ts pins the pure
 * `computeFreshestGateChanges`. This suite covers the DB-facing half:
 * settings, the batch upsert and its gateway-change audit, the display
 * decoration and the quarantine candidate filter.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
const upstream = vi.hoisted(() => ({ resolveFirewallRefsByName: vi.fn() }));
vi.mock("../../src/services/assetUpstreamService.js", () => upstream);

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  getQuarantineCandidates,
  getSightingSettings,
  getSightingsForAsset,
  getSightingsForDisplay,
  recordSightings,
  updateSightingSettings,
} from "../../src/services/assetSightingService.js";

const settingFind = stubbed(prisma.setting.findUnique);
const settingUpsert = stubbed(prisma.setting.upsert);
const sightFind = stubbed(prisma.assetFortigateSighting.findMany);
const sightUpsert = stubbed(prisma.assetFortigateSighting.upsert);
const subnetFind = stubbed(prisma.subnet.findMany);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  upstream.resolveFirewallRefsByName.mockReset();
  upstream.resolveFirewallRefsByName.mockResolvedValue(new Map());
  sightFind.mockResolvedValue([]);
  sightUpsert.mockResolvedValue({});
  subnetFind.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Settings ────────────────────────────────────────────────────────────────

describe("getSightingSettings / updateSightingSettings", () => {
  it("defaults to 180 days with no row", async () => {
    settingFind.mockResolvedValue(null);
    expect(await getSightingSettings()).toEqual({ sightingMaxAgeDays: 180 });
    expect(settingFind).toHaveBeenCalledWith({ where: { key: "quarantineSightingSettings" } });
  });

  it("floors a fractional value and keeps 0 (= no filter)", async () => {
    settingFind.mockResolvedValue({ value: { sightingMaxAgeDays: 30.9 } });
    expect(await getSightingSettings()).toEqual({ sightingMaxAgeDays: 30 });
    settingFind.mockResolvedValue({ value: { sightingMaxAgeDays: 0 } });
    expect(await getSightingSettings()).toEqual({ sightingMaxAgeDays: 0 });
  });

  it("falls back to the default for a negative, non-numeric or missing value", async () => {
    for (const value of [{ sightingMaxAgeDays: -1 }, { sightingMaxAgeDays: "abc" }, {}, null]) {
      settingFind.mockResolvedValue({ value });
      expect(await getSightingSettings()).toEqual({ sightingMaxAgeDays: 180 });
    }
  });

  it("upserts the settings blob under its key", async () => {
    await updateSightingSettings({ sightingMaxAgeDays: 90 });
    expect(settingUpsert).toHaveBeenCalledWith({
      where: { key: "quarantineSightingSettings" },
      update: { value: { sightingMaxAgeDays: 90 } },
      create: { key: "quarantineSightingSettings", value: { sightingMaxAgeDays: 90 } },
    });
  });
});

// ─── recordSightings ─────────────────────────────────────────────────────────

describe("recordSightings", () => {
  const t = (iso: string) => new Date(iso);

  it("is a no-op for an empty batch", async () => {
    await recordSightings([]);
    expect(sightFind).not.toHaveBeenCalled();
    expect(sightUpsert).not.toHaveBeenCalled();
  });

  it("dedupes on (asset, gate, source), keeping the latest seenAt, and keeps a lease beside a reservation", async () => {
    await recordSightings([
      { assetId: "a", fortigateDevice: "GATE", source: "dhcp_lease", seenAt: t("2026-11-01T00:00:00Z"), ipAddress: "10.0.0.1" },
      { assetId: "a", fortigateDevice: "GATE", source: "dhcp_lease", seenAt: t("2026-11-02T00:00:00Z"), ipAddress: "10.0.0.2" },
      { assetId: "a", fortigateDevice: "GATE", source: "dhcp_lease", seenAt: t("2026-10-30T00:00:00Z"), ipAddress: "10.0.0.3" },
      { assetId: "a", fortigateDevice: "GATE", source: "dhcp_reservation", seenAt: t("2026-11-01T00:00:00Z") },
    ]);
    expect(sightUpsert).toHaveBeenCalledTimes(2);
    const lease = sightUpsert.mock.calls.find((c) => c[0].where.assetId_fortigateDevice_source.source === "dhcp_lease")![0];
    expect(lease.update).toEqual({ lastSeen: t("2026-11-02T00:00:00Z"), ipAddress: "10.0.0.2" });
  });

  it("drops rows with no asset or no gate", async () => {
    await recordSightings([
      { assetId: "", fortigateDevice: "GATE", source: "dhcp_lease" },
      { assetId: "a", fortigateDevice: "", source: "dhcp_lease" },
    ]);
    expect(sightUpsert).not.toHaveBeenCalled();
  });

  it("only overwrites integrationId / ipAddress when the caller supplied them; creates with nulls", async () => {
    const seen = t("2026-11-05T12:00:00Z");
    await recordSightings([{ assetId: "a", fortigateDevice: "GATE", source: "dhcp_reservation", seenAt: seen }]);
    expect(sightUpsert).toHaveBeenCalledWith({
      where: { assetId_fortigateDevice_source: { assetId: "a", fortigateDevice: "GATE", source: "dhcp_reservation" } },
      update: { lastSeen: seen },
      create: { assetId: "a", fortigateDevice: "GATE", source: "dhcp_reservation", integrationId: null, ipAddress: null, firstSeen: seen, lastSeen: seen },
    });

    sightUpsert.mockClear();
    await recordSightings([{ assetId: "a", fortigateDevice: "GATE", source: "dhcp_lease", seenAt: seen, integrationId: null, ipAddress: "10.0.0.9" }]);
    expect(sightUpsert.mock.calls[0][0].update).toEqual({ lastSeen: seen, integrationId: null, ipAddress: "10.0.0.9" });
  });

  it("defaults seenAt to now", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(t("2026-11-14T08:00:00Z"));
    await recordSightings([{ assetId: "a", fortigateDevice: "GATE", source: "dhcp_lease" }]);
    expect(sightUpsert.mock.calls[0][0].create.firstSeen).toEqual(t("2026-11-14T08:00:00Z"));
  });

  it("reads the pre-write rows once, for the batch's distinct assets", async () => {
    await recordSightings([
      { assetId: "a", fortigateDevice: "G1", source: "dhcp_lease" },
      { assetId: "a", fortigateDevice: "G2", source: "dhcp_lease" },
      { assetId: "b", fortigateDevice: "G1", source: "dhcp_lease" },
    ]);
    expect(sightFind).toHaveBeenCalledTimes(1);
    expect(sightFind.mock.calls[0][0]).toEqual({
      where: { assetId: { in: ["a", "b"] } },
      select: { assetId: true, fortigateDevice: true, lastSeen: true },
    });
  });

  it("never throws when an upsert rejects", async () => {
    sightUpsert.mockRejectedValueOnce(new Error("unique violation"));
    await expect(recordSightings([
      { assetId: "a", fortigateDevice: "G1", source: "dhcp_lease" },
      { assetId: "b", fortigateDevice: "G1", source: "dhcp_lease" },
    ])).resolves.toBeUndefined();
    expect(sightUpsert).toHaveBeenCalledTimes(2);
  });

  it("writes one asset.gateway_firewall.changed Event per moved asset, named by the caller's hostname", async () => {
    sightFind.mockResolvedValue([{ assetId: "a", fortigateDevice: "OLD-GATE", lastSeen: t("2026-11-01T00:00:00Z") }]);
    await recordSightings([
      { assetId: "a", fortigateDevice: "NEW-GATE", source: "dhcp_lease", seenAt: t("2026-11-10T00:00:00Z"), assetHostname: "laptop-7" },
    ]);
    expect(eventLog.logEventsBatch).toHaveBeenCalledTimes(1);
    const events = eventLog.logEventsBatch.mock.calls[0][0];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "asset.gateway_firewall.changed",
      resourceType: "asset",
      resourceId: "a",
      resourceName: "laptop-7",
      actor: "system:discovery",
    });
    expect(events[0].message).toContain("OLD-GATE → NEW-GATE");
  });

  it("falls back to the asset id in the message when no hostname was supplied", async () => {
    sightFind.mockResolvedValue([{ assetId: "a", fortigateDevice: "OLD", lastSeen: t("2026-11-01T00:00:00Z") }]);
    await recordSightings([{ assetId: "a", fortigateDevice: "NEW", source: "dhcp_lease", seenAt: t("2026-11-10T00:00:00Z") }]);
    const ev = eventLog.logEventsBatch.mock.calls[0][0][0];
    expect(ev.resourceName).toBeUndefined();
    expect(ev.message).toContain('Asset "a"');
  });

  it("writes no Event on a first sighting or when the incumbent is refreshed too", async () => {
    await recordSightings([{ assetId: "a", fortigateDevice: "G1", source: "dhcp_lease" }]);
    sightFind.mockResolvedValue([{ assetId: "a", fortigateDevice: "G1", lastSeen: t("2026-11-01T00:00:00Z") }]);
    await recordSightings([
      { assetId: "a", fortigateDevice: "G1", source: "dhcp_lease", seenAt: t("2026-11-10T00:00:00Z") },
      { assetId: "a", fortigateDevice: "G2", source: "dhcp_lease", seenAt: t("2026-11-10T00:00:01Z") },
    ]);
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("still records when the pre-read fails, and emits nothing", async () => {
    sightFind.mockRejectedValue(new Error("timeout"));
    await recordSightings([{ assetId: "a", fortigateDevice: "G1", source: "dhcp_lease" }]);
    expect(sightUpsert).toHaveBeenCalledTimes(1);
    expect(eventLog.logEventsBatch).not.toHaveBeenCalled();
  });

  it("swallows an audit write failure", async () => {
    sightFind.mockResolvedValue([{ assetId: "a", fortigateDevice: "OLD", lastSeen: t("2026-11-01T00:00:00Z") }]);
    eventLog.logEventsBatch.mockRejectedValueOnce(new Error("events table locked"));
    await expect(recordSightings([
      { assetId: "a", fortigateDevice: "NEW", source: "dhcp_lease", seenAt: t("2026-11-10T00:00:00Z") },
    ])).resolves.toBeUndefined();
  });
});

// ─── Readers ─────────────────────────────────────────────────────────────────

const sighting = (over: Record<string, unknown>) => ({
  id: "s", assetId: "a", integrationId: null, fortigateDevice: "GATE", source: "dhcp_lease",
  ipAddress: null, firstSeen: new Date("2026-01-01T00:00:00Z"), lastSeen: new Date("2026-11-01T00:00:00Z"), ...over,
});

describe("getSightingsForAsset", () => {
  it("returns the asset's rows newest first", async () => {
    sightFind.mockResolvedValue([sighting({})]);
    expect(await getSightingsForAsset("a")).toHaveLength(1);
    expect(sightFind).toHaveBeenCalledWith({ where: { assetId: "a" }, orderBy: { lastSeen: "desc" } });
  });
});

describe("getSightingsForDisplay", () => {
  it("decorates each row with the network on the SAME gate holding its IP, and the resolved gate", async () => {
    sightFind.mockResolvedValue([
      sighting({ id: "1", fortigateDevice: "GATE-A", ipAddress: "10.1.0.50" }),
      sighting({ id: "2", fortigateDevice: "GATE-B", ipAddress: "10.1.0.50" }),
      sighting({ id: "3", fortigateDevice: "GATE-A", ipAddress: null }),
    ]);
    subnetFind.mockResolvedValue([
      { id: "net-a", cidr: "10.1.0.0/24", name: "Users A", vlan: 30, fortigateDevice: "GATE-A" },
      { id: "net-a2", cidr: "10.2.0.0/24", name: "Other", vlan: 40, fortigateDevice: "GATE-A" },
    ]);
    const ref = { id: "fgt-a", hostname: "fgt-a", ipAddress: null, assetType: "firewall", status: "active", monitorStatus: null, managementAccess: null };
    upstream.resolveFirewallRefsByName.mockResolvedValue(new Map([["GATE-A", ref]]));

    const out = await getSightingsForDisplay("a");

    expect(subnetFind).toHaveBeenCalledWith({
      where: { fortigateDevice: { in: ["GATE-A", "GATE-B"] } },
      select: { id: true, cidr: true, name: true, vlan: true, fortigateDevice: true },
    });
    expect(upstream.resolveFirewallRefsByName).toHaveBeenCalledWith(["GATE-A", "GATE-B"]);
    expect(out[0]).toMatchObject({ id: "1", subnetName: "Users A", vlan: 30, subnetId: "net-a", subnetCidr: "10.1.0.0/24", fortigateAsset: ref });
    // Same IP, different gate: the GATE-A network does not decorate it.
    expect(out[1]).toMatchObject({ id: "2", subnetName: null, vlan: null, subnetId: null, subnetCidr: null, fortigateAsset: null });
    expect(out[2]).toMatchObject({ id: "3", subnetId: null, fortigateAsset: ref });
  });

  it("looks the gate up by its trimmed name", async () => {
    sightFind.mockResolvedValue([sighting({ fortigateDevice: " GATE-A " })]);
    const ref = { id: "fgt-a" };
    upstream.resolveFirewallRefsByName.mockResolvedValue(new Map([["GATE-A", ref]]));
    expect((await getSightingsForDisplay("a"))[0].fortigateAsset).toBe(ref);
  });

  it("issues no network query when there are no sightings", async () => {
    sightFind.mockResolvedValue([]);
    expect(await getSightingsForDisplay("a")).toEqual([]);
    expect(subnetFind).not.toHaveBeenCalled();
  });
});

describe("getQuarantineCandidates", () => {
  const NOW = new Date("2026-11-14T00:00:00Z");
  const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("returns one candidate per gate — the freshest row of each", async () => {
    settingFind.mockResolvedValue({ value: { sightingMaxAgeDays: 0 } });
    sightFind.mockResolvedValue([
      sighting({ id: "lease", fortigateDevice: "G1", source: "dhcp_lease", lastSeen: daysAgo(1) }),
      sighting({ id: "g2", fortigateDevice: "G2", lastSeen: daysAgo(2) }),
      sighting({ id: "resv", fortigateDevice: "G1", source: "dhcp_reservation", lastSeen: daysAgo(3) }),
    ]);
    expect((await getQuarantineCandidates("a")).map((s) => s.id)).toEqual(["lease", "g2"]);
  });

  it("drops gates last seen beyond the max age (the boundary day is kept)", async () => {
    settingFind.mockResolvedValue({ value: { sightingMaxAgeDays: 30 } });
    sightFind.mockResolvedValue([
      sighting({ id: "fresh", fortigateDevice: "G1", lastSeen: daysAgo(5) }),
      sighting({ id: "edge", fortigateDevice: "G2", lastSeen: daysAgo(30) }),
      sighting({ id: "stale", fortigateDevice: "G3", lastSeen: daysAgo(31) }),
    ]);
    expect((await getQuarantineCandidates("a")).map((s) => s.id)).toEqual(["fresh", "edge"]);
  });

  it("uses the 180-day default with no setting row", async () => {
    settingFind.mockResolvedValue(null);
    sightFind.mockResolvedValue([
      sighting({ id: "in", fortigateDevice: "G1", lastSeen: daysAgo(179) }),
      sighting({ id: "out", fortigateDevice: "G2", lastSeen: daysAgo(181) }),
    ]);
    expect((await getQuarantineCandidates("a")).map((s) => s.id)).toEqual(["in"]);
  });
});
