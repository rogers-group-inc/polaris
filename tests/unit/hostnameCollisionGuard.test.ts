/**
 * tests/unit/hostnameCollisionGuard.test.ts
 *
 * Business rule 91(a): a shared hostname — exact or NetBIOS-truncated — is
 * not evidence that two records are one device. The prod case (2026-10-12):
 * a FortiSwitch named CROSSPLAINS-CSR-DESK and an Entra laptop whose 15-char
 * NetBIOS name is CROSSPLAINS-CSR were offered as "Duplicate assets".
 *
 * Pins three things: the guard's verdicts, that `lookupHostname` answers
 * "no match" for a refused pair (so discovery creates instead of queueing a
 * card), and that cards raised before the guard are dismissed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const findMany = vi.fn();
const updateMany = vi.fn();
vi.mock("../../src/db.js", () => ({ prisma: { conflict: { findMany, updateMany } } }));
const logEvent = vi.fn();
vi.mock("../../src/services/eventLogService.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  logEvent,
}));

const { hostnameCollisionRefusal } = await import("../../src/utils/hostnameCollisionGuard.js");
const { indexHostname, lookupHostname, dismissRefusedHostnameConflicts } =
  await import("../../src/services/discovery/discoveryEngine.js");

describe("hostnameCollisionRefusal", () => {
  it("refuses network infrastructure against an endpoint, either way round", () => {
    expect(hostnameCollisionRefusal({ assetType: "workstation" }, { assetType: "switch" })).toBe("class");
    expect(hostnameCollisionRefusal({ assetType: "access_point" }, { assetType: "server" })).toBe("class");
    expect(hostnameCollisionRefusal({ assetType: "hypervisor" }, { assetType: "firewall" })).toBe("class");
    expect(hostnameCollisionRefusal({ assetType: "container" }, { assetType: "router" })).toBe("class");
  });

  it("refuses two usable serials that differ, ignoring case and punctuation", () => {
    expect(hostnameCollisionRefusal({ serialNumber: "5CG1234ABC" }, { serialNumber: "5CG9999XYZ" })).toBe("serial");
    expect(hostnameCollisionRefusal({ serialNumber: "5cg-1234 abc" }, { serialNumber: "5CG1234ABC" })).toBeNull();
  });

  it("never refuses on absent, generic, placeholder or unclassified data", () => {
    expect(hostnameCollisionRefusal({}, {})).toBeNull();
    expect(hostnameCollisionRefusal({ assetType: "workstation" }, { assetType: "other" })).toBeNull();
    expect(hostnameCollisionRefusal({ assetType: "workstation" }, { assetType: null })).toBeNull();
    expect(hostnameCollisionRefusal({ assetType: "workstation" }, { assetType: "badge_reader" })).toBeNull();
    expect(hostnameCollisionRefusal({ serialNumber: "To Be Filled By O.E.M." }, { serialNumber: "5CG1234ABC" })).toBeNull();
    expect(hostnameCollisionRefusal({ serialNumber: "5CG1234ABC" }, { serialNumber: null })).toBeNull();
  });

  it("allows same-class pairs whose serials do not contradict", () => {
    expect(hostnameCollisionRefusal({ assetType: "workstation" }, { assetType: "server" })).toBeNull();
    expect(hostnameCollisionRefusal({ assetType: "switch" }, { assetType: "firewall" })).toBeNull();
    expect(hostnameCollisionRefusal({ assetType: "workstation", serialNumber: "5CG1234ABC" }, { assetType: "workstation", serialNumber: "5CG1234ABC" })).toBeNull();
  });
});

describe("lookupHostname with the rule 91(a) guard", () => {
  const sw = { id: "sw", hostname: "CROSSPLAINS-CSR-DESK", assetType: "switch", serialNumber: "S124FFTV21000001" };
  const pc = { id: "pc", hostname: "CROSSPLAINS-CSR-DESK", assetType: "workstation", serialNumber: "5CG1234ABC" };

  it("finds the NetBIOS-truncated match when nothing contradicts it", () => {
    const map = new Map<string, any>();
    indexHostname(map, pc.hostname, pc);
    expect(lookupHostname(map, "CROSSPLAINS-CSR", { assetType: "workstation", serialNumber: "5CG1234ABC" }))
      .toEqual({ asset: pc, via: "netbios" });
  });

  it("answers no match for a switch against an Entra laptop (the prod case)", () => {
    const map = new Map<string, any>();
    indexHostname(map, sw.hostname, sw);
    expect(lookupHostname(map, "CROSSPLAINS-CSR", { assetType: "workstation", serialNumber: "5CG1234ABC" })).toBeNull();
    // An exact name is no stronger: two kinds of device are still two devices.
    expect(lookupHostname(map, "CROSSPLAINS-CSR-DESK", { assetType: "workstation" })).toBeNull();
  });

  it("answers no match when the serials differ", () => {
    const map = new Map<string, any>();
    indexHostname(map, pc.hostname, pc);
    expect(lookupHostname(map, "CROSSPLAINS-CSR", { assetType: "workstation", serialNumber: "5CG9999XYZ" })).toBeNull();
  });

  it("keeps the unguarded behaviour when the caller passes nothing", () => {
    const map = new Map<string, any>();
    indexHostname(map, sw.hostname, sw);
    expect(lookupHostname(map, "CROSSPLAINS-CSR")).toEqual({ asset: sw, via: "netbios" });
  });
});

describe("dismissRefusedHostnameConflicts", () => {
  beforeEach(() => {
    findMany.mockReset();
    updateMany.mockReset();
    logEvent.mockReset();
  });

  it("rejects, as system, only the pending hostname cards the guard refuses", async () => {
    findMany.mockResolvedValue([
      { id: "c1", assetId: "sw", proposedDeviceId: "d1",
        proposedAssetFields: { hostname: "CROSSPLAINS-CSR", assetType: "workstation", collisionReason: "untagged-collision", bothAssetsExist: true },
        asset: { hostname: "CROSSPLAINS-CSR-DESK", assetType: "switch", serialNumber: "S124FFTV21000001" } },
      { id: "c2", assetId: "pc", proposedDeviceId: "d2",
        proposedAssetFields: { hostname: "LAPTOP-7", assetType: "workstation", collisionReason: "untagged-collision" },
        asset: { hostname: "LAPTOP-7", assetType: "other", serialNumber: null } },
      { id: "c3", assetId: "x", proposedDeviceId: "d3",
        proposedAssetFields: { hostname: "LAPTOP-8", assetType: "workstation", collisionReason: "mac-collision" },
        asset: { hostname: "SW-8", assetType: "switch", serialNumber: null } },
    ]);
    updateMany.mockResolvedValue({ count: 1 });

    expect(await dismissRefusedHostnameConflicts("int-1")).toBe(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["c1"] }, status: "pending" },
      data: expect.objectContaining({ status: "rejected", resolvedBy: "system" }),
    });
    expect(logEvent).toHaveBeenCalledTimes(1);
    expect(logEvent.mock.calls[0][0]).toMatchObject({ action: "conflict.rejected", resourceId: "sw", actor: "system" });
  });

  it("writes nothing when no card is refused", async () => {
    findMany.mockResolvedValue([]);
    expect(await dismissRefusedHostnameConflicts("int-1")).toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });
});
