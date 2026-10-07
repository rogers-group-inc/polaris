import { describe, it, expect } from "vitest";
import { computeConflictFields } from "../../src/services/discovery/discoveryEngine.js";

// Which fields upsertConflict raises a card on.
//
// "differs" is the manual-reservation case — discovery must never overwrite an
// operator-typed row, so every divergence is reviewable.
//
// "fill-only" is the VIP ↔ DHCP collision (an IP that is both a FortiGate VIP
// and a DHCP lease/reservation). The VIP is load-bearing firewall config, so
// its owner / projectRef win outright and are never offered for review; only a
// field the existing row left blank is worth an operator's time. Accepting a
// merge conflict has only ever filled blanks (conflictResolutionService's merge
// mode), so a card whose fields are all populated changed nothing on accept —
// pure noise on every VIP that also holds a lease.

const VIP_ROW = {
  hostname: "HW030CPKGN33",
  owner: "PINERUN-WEB-VIP",
  projectRef: "VIP: PINERUN-101F-1",
};
const DHCP_PROPOSAL = {
  hostname: "HW030CPKGN33",
  owner: "rarnold@example.com",
  projectRef: "FortiManager Integration",
};

describe("computeConflictFields — differs (default)", () => {
  it("raises every field that diverges", () => {
    expect(computeConflictFields(DHCP_PROPOSAL, VIP_ROW)).toEqual(["owner", "projectRef"]);
  });

  it("raises nothing when the values are back in sync", () => {
    expect(computeConflictFields(VIP_ROW, { ...VIP_ROW })).toEqual([]);
  });

  it("treats null and a missing key alike", () => {
    expect(computeConflictFields({ hostname: null }, {})).toEqual([]);
    expect(computeConflictFields({ hostname: "gw-1" }, { hostname: null })).toEqual(["hostname"]);
  });

  it("raises a field the proposal blanks out", () => {
    expect(computeConflictFields({ owner: null }, { owner: "netops" })).toEqual(["owner"]);
  });
});

describe("computeConflictFields — fill-only (VIP ↔ DHCP merge)", () => {
  it("raises nothing when the VIP row already carries owner + projectRef", () => {
    expect(computeConflictFields(DHCP_PROPOSAL, VIP_ROW, "fill-only")).toEqual([]);
  });

  it("raises only the fields the existing row left blank", () => {
    expect(
      computeConflictFields(DHCP_PROPOSAL, { ...VIP_ROW, owner: null, projectRef: "" }, "fill-only"),
    ).toEqual(["owner", "projectRef"]);
  });

  it("treats whitespace-only as blank", () => {
    expect(computeConflictFields({ owner: "dhcp-lease" }, { owner: "   " }, "fill-only")).toEqual(["owner"]);
  });

  it("never raises a blank field the proposal cannot fill", () => {
    expect(computeConflictFields({ owner: null }, { owner: null }, "fill-only")).toEqual([]);
    expect(computeConflictFields({ owner: "  " }, { owner: "" }, "fill-only")).toEqual([]);
  });

  it("does not raise a populated field even when it diverges", () => {
    expect(
      computeConflictFields({ hostname: "dhcp-name" }, { hostname: "vip-name" }, "fill-only"),
    ).toEqual([]);
  });
});
