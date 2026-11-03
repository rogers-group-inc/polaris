/**
 * tests/unit/duplicateReservationGroups.test.ts — business rule 139: which
 * assets hold two or more DHCP bindings with a reservation among them
 * (services/duplicateReservationConflictService.ts → groupDuplicateReservations).
 */

import { describe, it, expect } from "vitest";
import {
  groupDuplicateReservations,
  isDhcpBinding,
  isDhcpReservation,
  bindingsConflict,
  reservationSetKey,
  type ReservationRow,
  type MacOwnerRow,
} from "../../src/services/duplicateReservationConflictService.js";

const MAC = "84:8B:CD:4C:45:40";
const WIFI = "84:8B:CD:4C:45:41";
const subnet = (gate: string | null, cidr = "10.1.0.0/24") => ({ id: `s-${gate}-${cidr}`, cidr, name: "Office", fortigateDevice: gate });
let n = 0;
const res = (over: Partial<ReservationRow> = {}): ReservationRow => ({
  id: `r${++n}`, ipAddress: `10.1.0.${n}`, macAddress: MAC, hostname: "laptop-1",
  sourceType: "dhcp_reservation", pushStatus: null, createdAt: new Date("2026-10-01T00:00:00Z"), createdBy: null,
  subnet: subnet("FGT-A"), ...over,
});
const owner = (mac: string, over: Partial<MacOwnerRow["asset"]> = {}): MacOwnerRow => ({
  mac, asset: { id: "a1", hostname: "laptop-1", ipAddress: "10.1.0.1", assetType: "workstation", status: "active", ...over },
});

describe("isDhcpBinding / isDhcpReservation / bindingsConflict", () => {
  it("counts a gate-learned reservation, a Polaris row the gate confirmed and a held lease, nothing else", () => {
    expect(isDhcpBinding({ sourceType: "dhcp_reservation", pushStatus: null })).toBe(true);
    expect(isDhcpBinding({ sourceType: "manual", pushStatus: "synced" })).toBe(true);
    expect(isDhcpBinding({ sourceType: "dhcp_lease", pushStatus: null })).toBe(true);
    expect(isDhcpBinding({ sourceType: "manual", pushStatus: null })).toBe(false);
    expect(isDhcpReservation({ sourceType: "dhcp_lease", pushStatus: null })).toBe(false);
  });

  it("needs two or more bindings with a reservation among them", () => {
    expect(bindingsConflict([{ kind: "reservation" }, { kind: "lease" }])).toBe(true);
    expect(bindingsConflict([{ kind: "lease" }, { kind: "lease" }])).toBe(false);
    expect(bindingsConflict([{ kind: "reservation" }])).toBe(false);
  });
});

describe("groupDuplicateReservations", () => {
  it("groups two reservations on one asset's MAC, across gates, and marks the primary", () => {
    const a = res({ ipAddress: "10.1.0.1" });
    const b = res({ ipAddress: "10.9.0.7", subnet: subnet("FGT-B", "10.9.0.0/24") });
    const groups = groupDuplicateReservations([a, b], [owner(MAC)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].assetId).toBe("a1");
    expect(groups[0].reservations.map((r) => [r.ipAddress, r.gate, r.isPrimary])).toEqual([
      ["10.1.0.1", "FGT-A", true],
      ["10.9.0.7", "FGT-B", false],
    ]);
  });

  it("counts every MAC of the asset", () => {
    const groups = groupDuplicateReservations([res(), res({ macAddress: WIFI })], [owner(MAC), owner(WIFI)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].reservations).toHaveLength(2);
  });

  it("leaves an asset with one reservation, rows that are not gate bindings, and leases alone", () => {
    expect(groupDuplicateReservations([res(), res({ sourceType: "manual" })], [owner(MAC)])).toEqual([]);
    expect(groupDuplicateReservations([res({ sourceType: "dhcp_lease" }), res({ sourceType: "dhcp_lease", macAddress: WIFI })], [owner(MAC), owner(WIFI)])).toEqual([]);
  });

  it("groups a reservation with a lease the device holds elsewhere, naming each kind and the gate's asset", () => {
    const groups = groupDuplicateReservations(
      [res({ ipAddress: "10.1.0.50" }), res({ ipAddress: "10.1.0.90", sourceType: "dhcp_lease" })],
      [owner(MAC)],
      new Map([["FGT-A", "gate-asset-1"]]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].reservations.map((r) => [r.ipAddress, r.kind, r.gateAssetId])).toEqual([
      ["10.1.0.50", "reservation", "gate-asset-1"],
      ["10.1.0.90", "lease", "gate-asset-1"],
    ]);
  });

  it("skips decommissioned / disabled assets and Fortinet infra", () => {
    for (const over of [{ status: "decommissioned" }, { status: "disabled" }, { assetType: "access_point" }, { assetType: "firewall" }]) {
      expect(groupDuplicateReservations([res(), res()], [owner(MAC, over)])).toEqual([]);
    }
  });

  it("refuses a MAC two assets list, and the all-zero MAC", () => {
    expect(groupDuplicateReservations([res(), res()], [owner(MAC), owner(MAC, { id: "a2" })])).toEqual([]);
    const zero = "00:00:00:00:00:00";
    expect(groupDuplicateReservations([res({ macAddress: zero }), res({ macAddress: zero })], [owner(zero)])).toEqual([]);
  });

  it("matches a reservation MAC written in another spelling", () => {
    const groups = groupDuplicateReservations([res({ macAddress: "84-8b-cd-4c-45-40" }), res()], [owner(MAC)]);
    expect(groups[0].reservations).toHaveLength(2);
  });
});

describe("reservationSetKey", () => {
  it("is order-free", () => {
    expect(reservationSetKey([{ reservationId: "b" }, { reservationId: "a" }])).toBe(reservationSetKey([{ reservationId: "a" }, { reservationId: "b" }]));
  });
});
