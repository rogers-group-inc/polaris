/**
 * tests/unit/primaryAddressService.test.ts — the own suite for
 * src/services/primaryAddressService.ts (business rules 101(b), 102, 103(a),
 * 103(b) and 126(d), CQ-T010).
 *
 * Complements primaryAddressPin.test.ts (the db.ts guard's pure decision) and
 * the integration suites that drive the guard on a real DB.
 *
 * Adds, on the shared db stub: the pin's 400 / 404 / 409 refusals (Fortinet
 * infra, a pair not on the address list), the MAC normalisation, the one write
 * that clears the other two operator IP pins and the contest stamp, the
 * learnedLocation move to the gate whose network holds the address, the
 * ip-override conflict close-out only when one was held, the Event's details;
 * unpin's pick by evidence score (IPv4 only, tie keeps the current address
 * then the lowest IP string) with the projection fallback for an empty list;
 * the release sweep's contest-window filter, batch scoring, conditional write
 * and Event; the follow audit staying best-effort.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  resolveConflicts: vi.fn(),
  buildConfidence: vi.fn(),
  project: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/ipOverrideService.js", () => ({ resolvePendingIpOverrideConflicts: h.resolveConflicts }));
vi.mock("../../src/services/addressConfidenceService.js", () => ({ buildAddressConfidence: h.buildConfidence }));
vi.mock("../../src/utils/assetProjection.js", () => ({ projectAssetFromSources: h.project }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import { PIN_CONTEST_WINDOW_MS } from "../../src/utils/assetInvariants.js";
import {
  CLEAR_PRIMARY_ADDRESS_PIN,
  pinPrimaryAddress,
  unpinPrimaryAddress,
  bestListedAddress,
  gateForPinnedAddress,
  releaseConfirmedPins,
  handlePrimaryAddressFollowed,
  loadIntegrationTokenTarget,
} from "../../src/services/primaryAddressService.js";

const db = prisma as any;
const MAC = "AA:BB:CC:00:00:01";

async function expectAppError(p: Promise<unknown>, status: number, msg?: RegExp) {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).httpStatus).toBe(status);
  if (msg) expect((err as Error).message).toMatch(msg);
}

/** A per-asset score map in the shape buildAddressConfidence returns. */
function scores(assetId: string, byIp: Record<string, { evidenceScore?: number; discoveryScore?: number; parts?: any[] }>) {
  const m = new Map<string, any>();
  for (const [ip, s] of Object.entries(byIp)) {
    m.set(ip, { evidenceScore: s.evidenceScore ?? 0, discoveryScore: s.discoveryScore ?? 0, parts: s.parts ?? [] });
  }
  return new Map([[assetId, m]]);
}

function asset(over: Record<string, unknown> = {}) {
  return {
    id: "a1", hostname: "pc-1", assetType: "workstation", fortinetTopology: null,
    ipAddress: "10.0.0.9", ipOverride: null, ipBlankPinned: false,
    primaryAddressMac: null, primaryAddressIp: null, learnedLocation: null,
    ...over,
  };
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.resolveConflicts.mockReset().mockResolvedValue(0);
  h.buildConfidence.mockReset().mockResolvedValue(new Map());
  h.project.mockReset().mockReturnValue({ projected: {}, provenance: {} });
  stubbed(db.subnet.findMany).mockResolvedValue([]);
});

describe("CLEAR_PRIMARY_ADDRESS_PIN", () => {
  it("nulls all five pin columns, including the contest stamp", () => {
    expect(CLEAR_PRIMARY_ADDRESS_PIN).toEqual({
      primaryAddressMac: null, primaryAddressIp: null, primaryAddressPinnedAt: null,
      primaryAddressPinnedBy: null, primaryAddressContestedAt: null,
    });
  });
});

describe("pinPrimaryAddress", () => {
  it("400s an unparseable MAC and a blank IP before reading anything", async () => {
    await expectAppError(pinPrimaryAddress({ assetId: "a1", mac: "nope", ip: "10.0.0.5", actor: "u" }), 400, /MAC/);
    await expectAppError(pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "   ", actor: "u" }), 400, /IP/);
    await expectAppError(pinPrimaryAddress({ assetId: "a1", mac: "00:00:00:00:00:00", ip: "10.0.0.5", actor: "u" }), 400);
    expect(db.asset.findUnique).not.toHaveBeenCalled();
  });

  it("404s an unknown asset", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(null);
    await expectAppError(pinPrimaryAddress({ assetId: "x", mac: MAC, ip: "10.0.0.5", actor: "u" }), 404);
  });

  it.each(["firewall", "switch", "access_point"])("409s Fortinet infra (%s with fortinetTopology)", async (assetType) => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset({ assetType, fortinetTopology: { role: "x" } }));
    await expectAppError(pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" }), 409, /management IP/);
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it("allows a non-Fortinet switch (no fortinetTopology)", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset({ assetType: "switch" }));
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue({ id: "r1", device: null });
    await expect(pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" })).resolves.toEqual({ assetId: "a1", mac: MAC, ip: "10.0.0.5" });
  });

  it("409s a (mac, ip) pair that is not on the asset's address list", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset());
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue(null);
    await expectAppError(pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" }), 409, /not an address of/);
    expect(db.asset.update).not.toHaveBeenCalled();
  });

  it("normalises the MAC and trims the IP for the lookup and the write", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset());
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue({ id: "r1", device: null });
    const out = await pinPrimaryAddress({ assetId: "a1", mac: "aa-bb-cc-00-00-01", ip: " 10.0.0.5 ", actor: "u" });
    expect(out).toEqual({ assetId: "a1", mac: MAC, ip: "10.0.0.5" });
    expect(stubbed(db.assetAssociatedIp.findFirst).mock.calls[0][0].where).toEqual({ assetId: "a1", ip: "10.0.0.5", mac: MAC });
  });

  it("writes the pin, sets ipAddress, clears the other operator pins and the contest stamp", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset({ ipOverride: "10.0.0.77" }));
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue({ id: "r1", device: null });
    await pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "alice" });
    const { where, data } = stubbed(db.asset.update).mock.calls[0][0];
    expect(where).toEqual({ id: "a1" });
    expect(data).toMatchObject({
      primaryAddressMac: MAC, primaryAddressIp: "10.0.0.5", primaryAddressPinnedBy: "alice", primaryAddressContestedAt: null,
      ipAddress: "10.0.0.5", ipSource: "pinned", ipOverride: null, ipBlankPinned: false, ipCleared: null,
    });
    expect(data.primaryAddressPinnedAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("macAddress");
    expect(data).not.toHaveProperty("learnedLocation");
  });

  it("closes pending ip-override conflicts only when a typed or blank pin was held", async () => {
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue({ id: "r1", device: null });
    stubbed(db.asset.findUnique).mockResolvedValue(asset());
    await pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" });
    expect(h.resolveConflicts).not.toHaveBeenCalled();

    stubbed(db.asset.findUnique).mockResolvedValue(asset({ ipBlankPinned: true }));
    h.resolveConflicts.mockResolvedValue(2);
    await pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" });
    expect(h.resolveConflicts).toHaveBeenCalledWith("a1", "u");
    expect(eventLog.logEvent.mock.calls[1][0].details).toMatchObject({ releasedBlankPin: true, autoResolvedConflicts: 2 });
  });

  it("writes asset.primary_address.pinned with the previous IP, previous pin and released override", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset({
      ipOverride: "10.0.0.77", primaryAddressMac: "AA:BB:CC:00:00:02", primaryAddressIp: "10.0.0.6",
    }));
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue({ id: "r1", device: null });
    await pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({ action: "asset.primary_address.pinned", resourceType: "asset", resourceId: "a1", resourceName: "pc-1", actor: "u" });
    expect(ev.message).toContain("(was 10.0.0.9)");
    expect(ev.details).toMatchObject({
      mac: MAC, ipAddress: "10.0.0.5", previousIp: "10.0.0.9",
      previousPin: { mac: "AA:BB:CC:00:00:02", ip: "10.0.0.6" }, releasedIpOverride: "10.0.0.77",
    });
    expect(ev.details).not.toHaveProperty("learnedLocation");
  });

  it("omits the 'was' clause when the address does not change", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset({ ipAddress: "10.0.0.5", hostname: null }));
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue({ id: "r1", device: null });
    await pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" });
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev.message).not.toContain("(was");
    expect(ev.resourceName).toBe("10.0.0.5");
  });

  it("moves learnedLocation to the gate whose network holds the pinned address (rule 101(b))", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset({ learnedLocation: "FW-OLD" }));
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue({ id: "r1", device: "FW-NEW" });
    stubbed(db.subnet.findMany).mockResolvedValue([{ cidr: "10.0.0.0/24", status: "available", fortigateDevice: "FW-NEW" }]);
    await pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" });
    expect(stubbed(db.asset.update).mock.calls[0][0].data.learnedLocation).toBe("FW-NEW");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ details: { learnedLocation: { from: "FW-OLD", to: "FW-NEW" } } });
  });

  it("leaves learnedLocation alone when the gate is already it, or IPAM cannot say", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(asset({ learnedLocation: "FW-A" }));
    stubbed(db.assetAssociatedIp.findFirst).mockResolvedValue({ id: "r1", device: null });
    stubbed(db.subnet.findMany).mockResolvedValue([{ cidr: "10.0.0.0/24", status: "available", fortigateDevice: "FW-A" }]);
    await pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" });
    expect(stubbed(db.asset.update).mock.calls[0][0].data).not.toHaveProperty("learnedLocation");

    stubbed(db.subnet.findMany).mockResolvedValue([]);
    await pinPrimaryAddress({ assetId: "a1", mac: MAC, ip: "10.0.0.5", actor: "u" });
    expect(stubbed(db.asset.update).mock.calls[1][0].data).not.toHaveProperty("learnedLocation");
  });
});

describe("gateForPinnedAddress", () => {
  it("reads only gate-owned, non-deprecated networks", async () => {
    await gateForPinnedAddress("10.0.0.5", []);
    expect(stubbed(db.subnet.findMany).mock.calls[0][0]).toEqual({
      where: { fortigateDevice: { not: null }, status: { not: "deprecated" } },
      select: { cidr: true, status: true, fortigateDevice: true },
    });
  });

  it("returns the single gate serving the address, null when none", async () => {
    stubbed(db.subnet.findMany).mockResolvedValue([
      { cidr: "10.0.0.0/24", status: "available", fortigateDevice: "FW-A" },
      { cidr: "10.9.0.0/24", status: "available", fortigateDevice: "FW-B" },
    ]);
    expect(await gateForPinnedAddress("10.0.0.5", [])).toBe("FW-A");
    expect(await gateForPinnedAddress("192.168.1.1", [])).toBeNull();
  });

  it("settles an overlap with a candidate, and returns null when no candidate names one", async () => {
    stubbed(db.subnet.findMany).mockResolvedValue([
      { cidr: "10.0.0.0/24", status: "available", fortigateDevice: "FW-A" },
      { cidr: "10.0.0.0/24", status: "available", fortigateDevice: "FW-B" },
    ]);
    expect(await gateForPinnedAddress("10.0.0.5", [null, "FW-B"])).toBe("FW-B");
    expect(await gateForPinnedAddress("10.0.0.5", ["FW-Z"])).toBeNull();
  });
});

describe("bestListedAddress", () => {
  it("returns null for an empty list or an IPv6-only list without scoring", async () => {
    expect(await bestListedAddress("a1", [], null)).toBeNull();
    expect(await bestListedAddress("a1", ["2001:db8::5", "fe80::1"], null)).toBeNull();
    expect(h.buildConfidence).not.toHaveBeenCalled();
  });

  it("picks the highest evidence score, never a listed IPv6 (rule 126)", async () => {
    h.buildConfidence.mockResolvedValue(scores("a1", {
      "10.0.0.5": { evidenceScore: 40 }, "10.0.0.6": { evidenceScore: 70 }, "2001:db8::6": { evidenceScore: 99 },
    }));
    expect(await bestListedAddress("a1", ["10.0.0.5", "2001:db8::6", "10.0.0.6"], null)).toEqual({ ip: "10.0.0.6", evidenceScore: 70 });
    expect(h.buildConfidence).toHaveBeenCalledWith(["a1"]);
  });

  it("on a tie keeps the current address, else the lowest IP string", async () => {
    h.buildConfidence.mockResolvedValue(scores("a1", { "10.0.0.5": { evidenceScore: 60 }, "10.0.0.6": { evidenceScore: 60 } }));
    expect(await bestListedAddress("a1", ["10.0.0.6", "10.0.0.5"], "10.0.0.6")).toEqual({ ip: "10.0.0.6", evidenceScore: 60 });
    expect(await bestListedAddress("a1", ["10.0.0.6", "10.0.0.5"], null)).toEqual({ ip: "10.0.0.5", evidenceScore: 60 });
  });

  it("scores an address missing from the map as 0 and de-duplicates the list", async () => {
    h.buildConfidence.mockResolvedValue(new Map());
    expect(await bestListedAddress("a1", ["10.0.0.7", "10.0.0.7"], null)).toEqual({ ip: "10.0.0.7", evidenceScore: 0 });
  });

  it("does not mutate the caller's list", async () => {
    const listed = ["10.0.0.9", "10.0.0.1"];
    await bestListedAddress("a1", listed, null);
    expect(listed).toEqual(["10.0.0.9", "10.0.0.1"]);
  });
});

describe("unpinPrimaryAddress", () => {
  it("404s an unknown asset", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(null);
    await expectAppError(unpinPrimaryAddress({ assetId: "x", actor: "u" }), 404);
  });

  it("is a no-op returning the current address when nothing is pinned", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ id: "a1", ipAddress: "10.0.0.9", primaryAddressMac: null, associatedIpRows: [] });
    expect(await unpinPrimaryAddress({ assetId: "a1", actor: "u" })).toEqual({ ipAddress: "10.0.0.9" });
    expect(db.asset.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("moves to the listed address with the best evidence score, ipSource = that row's gate", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({
      id: "a1", hostname: "pc-1", ipAddress: "10.0.0.5", primaryAddressMac: MAC, primaryAddressIp: "10.0.0.5",
      associatedIpRows: [{ ip: "10.0.0.5", device: "FW-A" }, { ip: "10.0.0.6", device: "FW-B" }],
    });
    h.buildConfidence.mockResolvedValue(scores("a1", { "10.0.0.5": { evidenceScore: 30 }, "10.0.0.6": { evidenceScore: 85 } }));
    expect(await unpinPrimaryAddress({ assetId: "a1", actor: "u" })).toEqual({ ipAddress: "10.0.0.6" });
    expect(stubbed(db.asset.update).mock.calls[0][0].data).toEqual({ ...CLEAR_PRIMARY_ADDRESS_PIN, ipAddress: "10.0.0.6", ipSource: "FW-B" });
    expect(h.project).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "asset.primary_address.unpinned", actor: "u",
      details: { mac: MAC, ipAddress: "10.0.0.5", nextIp: "10.0.0.6", chosenBy: "address-confidence", evidenceScore: 85 },
    });
  });

  it("falls back to ipSource 'discovery' when the picked row names no gate", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({
      id: "a1", hostname: null, ipAddress: "10.0.0.5", primaryAddressMac: MAC, primaryAddressIp: "10.0.0.5",
      associatedIpRows: [{ ip: "10.0.0.5", device: null }],
    });
    await unpinPrimaryAddress({ assetId: "a1", actor: "u" });
    expect(stubbed(db.asset.update).mock.calls[0][0].data.ipSource).toBe("discovery");
  });

  it("an empty list re-projects from the sources (provenance as ipSource)", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({
      id: "a1", hostname: "pc-1", ipAddress: "10.0.0.5", primaryAddressMac: MAC, primaryAddressIp: "10.0.0.5", associatedIpRows: [],
    });
    stubbed(db.assetSource.findMany).mockResolvedValue([{ sourceKind: "vcenter-vm", inferred: false, observed: { guestIp: "10.0.0.8" }, lastSeen: new Date() }]);
    h.project.mockReturnValue({ projected: { ipAddress: "10.0.0.8" }, provenance: { ipAddress: "vcenter-vm" } });
    expect(await unpinPrimaryAddress({ assetId: "a1", actor: "u" })).toEqual({ ipAddress: "10.0.0.8" });
    expect(h.project.mock.calls[0][0][0]).toMatchObject({ sourceKind: "vcenter-vm", observed: { guestIp: "10.0.0.8" } });
    expect(stubbed(db.asset.update).mock.calls[0][0].data).toMatchObject({ ipAddress: "10.0.0.8", ipSource: "vcenter-vm" });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ details: { chosenBy: "projection" } });
  });

  it("an IPv6-only list also falls back to the projection", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({
      id: "a1", hostname: "pc-1", ipAddress: "10.0.0.5", primaryAddressMac: MAC, primaryAddressIp: "2001:db8::5",
      associatedIpRows: [{ ip: "2001:db8::5", device: "FW-A" }],
    });
    stubbed(db.assetSource.findMany).mockResolvedValue([]);
    await unpinPrimaryAddress({ assetId: "a1", actor: "u" });
    expect(h.project).toHaveBeenCalled();
    expect(stubbed(db.asset.update).mock.calls[0][0].data.ipAddress).toBe("10.0.0.5");
  });

  it("with no source opinion keeps the current address as 'manual', or null with no address", async () => {
    stubbed(db.assetSource.findMany).mockResolvedValue([]);
    stubbed(db.asset.findUnique).mockResolvedValue({
      id: "a1", hostname: "pc-1", ipAddress: "10.0.0.5", primaryAddressMac: MAC, primaryAddressIp: "10.0.0.5", associatedIpRows: [],
    });
    await unpinPrimaryAddress({ assetId: "a1", actor: "u" });
    expect(stubbed(db.asset.update).mock.calls[0][0].data).toMatchObject({ ipAddress: "10.0.0.5", ipSource: "manual" });

    stubbed(db.asset.findUnique).mockResolvedValue({
      id: "a1", hostname: "pc-1", ipAddress: null, primaryAddressMac: MAC, primaryAddressIp: "10.0.0.5", associatedIpRows: [],
    });
    expect(await unpinPrimaryAddress({ assetId: "a1", actor: "u" })).toEqual({ ipAddress: null });
    expect(stubbed(db.asset.update).mock.calls[1][0].data).toMatchObject({ ipAddress: null, ipSource: null });
  });

  it("a projection with no provenance records 'discovery'", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({
      id: "a1", hostname: "pc-1", ipAddress: null, primaryAddressMac: MAC, primaryAddressIp: "10.0.0.5", associatedIpRows: [],
    });
    stubbed(db.assetSource.findMany).mockResolvedValue([]);
    h.project.mockReturnValue({ projected: { ipAddress: "10.0.0.8" }, provenance: {} });
    await unpinPrimaryAddress({ assetId: "a1", actor: "u" });
    expect(stubbed(db.asset.update).mock.calls[0][0].data.ipSource).toBe("discovery");
  });
});

describe("releaseConfirmedPins", () => {
  const NOW = new Date("2026-11-10T12:00:00Z");

  it("reads only uncontested pins (null, or contested before the window)", async () => {
    stubbed(db.asset.findMany).mockResolvedValue([]);
    expect(await releaseConfirmedPins(NOW)).toEqual({ checked: 0, released: 0 });
    const where = stubbed(db.asset.findMany).mock.calls[0][0].where;
    expect(where.primaryAddressIp).toEqual({ not: null });
    expect(where.primaryAddressMac).toEqual({ not: null });
    expect(where.OR).toEqual([
      { primaryAddressContestedAt: null },
      { primaryAddressContestedAt: { lt: new Date(NOW.getTime() - PIN_CONTEST_WINDOW_MS) } },
    ]);
    expect(h.buildConfidence).not.toHaveBeenCalled();
  });

  it("releases a pin whose discovery score reaches 50 and beats every other address, keeping the address", async () => {
    stubbed(db.asset.findMany).mockResolvedValue([{ id: "a1", hostname: "pc-1", primaryAddressIp: "10.0.0.5", primaryAddressMac: MAC }]);
    h.buildConfidence.mockResolvedValue(scores("a1", {
      "10.0.0.5": { discoveryScore: 72, parts: [{ kind: "operator", device: null }, { kind: "polling", device: null }, { kind: "arp", device: "FW-A" }] },
      "10.0.0.6": { discoveryScore: 30 },
    }));
    stubbed(db.asset.updateMany).mockResolvedValue({ count: 1 });
    expect(await releaseConfirmedPins(NOW)).toEqual({ checked: 1, released: 1 });
    expect(h.buildConfidence).toHaveBeenCalledWith(["a1"], { now: NOW });
    const call = stubbed(db.asset.updateMany).mock.calls[0][0];
    expect(call.where).toEqual({ id: "a1", primaryAddressIp: "10.0.0.5", primaryAddressMac: MAC });
    expect(call.data).toEqual({ ...CLEAR_PRIMARY_ADDRESS_PIN, ipSource: "FW-A" });
    expect(call.data).not.toHaveProperty("ipAddress");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "asset.primary_address.released", resourceId: "a1", actor: "system",
      details: { ipAddress: "10.0.0.5", mac: MAC, discoveryScore: 72, bestOther: { ip: "10.0.0.6", score: 30 } },
    });
    expect(eventLog.logEvent.mock.calls[0][0].message).toContain("next best 10.0.0.6 at 30");
  });

  it("uses ipSource 'discovery' when the strongest network piece names no device", async () => {
    stubbed(db.asset.findMany).mockResolvedValue([{ id: "a1", hostname: null, primaryAddressIp: "10.0.0.5", primaryAddressMac: MAC }]);
    h.buildConfidence.mockResolvedValue(scores("a1", { "10.0.0.5": { discoveryScore: 60, parts: [{ kind: "vcenter", device: null }] } }));
    stubbed(db.asset.updateMany).mockResolvedValue({ count: 1 });
    await releaseConfirmedPins(NOW);
    expect(stubbed(db.asset.updateMany).mock.calls[0][0].data.ipSource).toBe("discovery");
    expect(eventLog.logEvent.mock.calls[0][0].message).not.toContain("next best");
  });

  it("keeps a pin below the warn line, or one tied with a rival", async () => {
    stubbed(db.asset.findMany).mockResolvedValue([
      { id: "a1", hostname: null, primaryAddressIp: "10.0.0.5", primaryAddressMac: MAC },
      { id: "a2", hostname: null, primaryAddressIp: "10.0.1.5", primaryAddressMac: MAC },
    ]);
    const m = new Map<string, any>([
      ...scores("a1", { "10.0.0.5": { discoveryScore: 49 } }),
      ...scores("a2", { "10.0.1.5": { discoveryScore: 70 }, "10.0.1.6": { discoveryScore: 70 } }),
    ]);
    h.buildConfidence.mockResolvedValue(m);
    expect(await releaseConfirmedPins(NOW)).toEqual({ checked: 2, released: 0 });
    expect(db.asset.updateMany).not.toHaveBeenCalled();
  });

  it("an IPv6 rival does not hold an IPv4 pin (rule 126)", async () => {
    stubbed(db.asset.findMany).mockResolvedValue([{ id: "a1", hostname: null, primaryAddressIp: "10.0.0.5", primaryAddressMac: MAC }]);
    h.buildConfidence.mockResolvedValue(scores("a1", { "10.0.0.5": { discoveryScore: 60 }, "2001:db8::5": { discoveryScore: 95 } }));
    stubbed(db.asset.updateMany).mockResolvedValue({ count: 1 });
    expect((await releaseConfirmedPins(NOW)).released).toBe(1);
  });

  it("counts nothing and writes no Event when the conditional write misses (re-pinned meanwhile)", async () => {
    stubbed(db.asset.findMany).mockResolvedValue([{ id: "a1", hostname: null, primaryAddressIp: "10.0.0.5", primaryAddressMac: MAC }]);
    h.buildConfidence.mockResolvedValue(scores("a1", { "10.0.0.5": { discoveryScore: 90 } }));
    stubbed(db.asset.updateMany).mockResolvedValue({ count: 0 });
    expect(await releaseConfirmedPins(NOW)).toEqual({ checked: 1, released: 0 });
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("skips an asset the scorer returned nothing for", async () => {
    stubbed(db.asset.findMany).mockResolvedValue([{ id: "a1", hostname: null, primaryAddressIp: "10.0.0.5", primaryAddressMac: MAC }]);
    h.buildConfidence.mockResolvedValue(new Map());
    expect(await releaseConfirmedPins(NOW)).toEqual({ checked: 1, released: 0 });
  });

  it("scores pinned assets in batches of 200", async () => {
    const pinned = Array.from({ length: 450 }, (_, i) => ({ id: `a${i}`, hostname: null, primaryAddressIp: "10.0.0.5", primaryAddressMac: MAC }));
    stubbed(db.asset.findMany).mockResolvedValue(pinned);
    await releaseConfirmedPins(NOW);
    expect(h.buildConfidence.mock.calls.map((c) => c[0].length)).toEqual([200, 200, 50]);
  });
});

describe("handlePrimaryAddressFollowed", () => {
  it("writes asset.primary_address.followed naming the card", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ hostname: "pc-1", primaryAddressMac: MAC });
    await handlePrimaryAddressFollowed("a1", "10.0.0.5", "10.0.0.6");
    const ev = eventLog.logEvent.mock.calls[0][0];
    expect(ev).toMatchObject({
      action: "asset.primary_address.followed", resourceId: "a1", resourceName: "pc-1", actor: "system",
      details: { fromIp: "10.0.0.5", ipAddress: "10.0.0.6", mac: MAC },
    });
    expect(ev.message).toContain(`(${MAC})`);
  });

  it("still audits for a vanished asset, naming it by address", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue(null);
    await handlePrimaryAddressFollowed("a1", "10.0.0.5", "10.0.0.6");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ resourceName: "10.0.0.6", details: { mac: null } });
  });

  it("never throws when the read fails", async () => {
    stubbed(db.asset.findUnique).mockRejectedValue(new Error("db down"));
    await expect(handlePrimaryAddressFollowed("a1", "10.0.0.5", "10.0.0.6")).resolves.toBeUndefined();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("loadIntegrationTokenTarget", () => {
  it("reads the address and the discovering integration's type", async () => {
    stubbed(db.asset.findUnique).mockResolvedValue({ ipAddress: "10.0.0.5", discoveredByIntegration: { type: "fortimanager" } });
    expect(await loadIntegrationTokenTarget("a1")).toEqual({ ipAddress: "10.0.0.5", discoveredByIntegration: { type: "fortimanager" } });
    expect(stubbed(db.asset.findUnique).mock.calls[0][0]).toEqual({
      where: { id: "a1" }, select: { ipAddress: true, discoveredByIntegration: { select: { type: true } } },
    });
  });
});
