/**
 * tests/unit/infraDhcpBinding.test.ts — the lease-vs-binding decisions behind
 * Fortinet-infra reservation rows (src/utils/infraDhcpBinding.ts).
 *
 * The bug these exist to prevent: Phase 3a/3b create a fortiswitch/fortinap
 * reservation for every managed switch/AP, sometimes from an address read out of
 * the gate's DHCP lease table, and Phase 5 had no branch for those source types
 * — so a leased address rendered as an authoritative reservation with no Reserve
 * action while the FortiGate reported "Not Reserved".
 *
 * Four properties are pinned hardest, because each one is a way the feature could
 * silently do damage rather than merely misbehave:
 *   - `expiresAt` is NEVER staged (it would hand these rows to expireReservations
 *     and churn a live AP through expired/re-created cycles),
 *   - the MAC is fill-only and comes from the lease entry (a wrong MAC yields a
 *     device-side binding that looks right everywhere and never binds),
 *   - only an explicit "lease" is claimable — NULL means unobserved, not free,
 *   - a reservation for THIS device isn't a conflict with this device (otherwise
 *     the first reserved AP produces a conflict card per cycle).
 */

import { describe, it, expect } from "vitest";
import {
  INFRA_SOURCE_TYPES,
  classifyOrphanInfraRow,
  decideInfraDhcpBinding,
  isInfraSourceType,
  isLeaseBackedInfraRow,
  reservationBelongsToInfraDevice,
  shouldReleaseInfraReservation,
  type InfraDhcpEntry,
  type InfraReleaseCandidate,
  type InfraReleaseDevice,
  type InfraReservationRow,
} from "../../src/utils/infraDhcpBinding.js";

const leaseEntry: InfraDhcpEntry = { type: "dhcp-lease", macAddress: "48:3a:02:00:00:01" };
const reservedEntry: InfraDhcpEntry = { type: "dhcp-reservation", macAddress: "48:3a:02:00:00:01" };

function apRow(over: Partial<InfraReservationRow> = {}): InfraReservationRow {
  return { sourceType: "fortinap", macAddress: null, hostname: "STONEHAVEN-108F-3", dhcpBinding: null, ...over };
}

describe("isInfraSourceType", () => {
  it("covers exactly the two managed-infra source types", () => {
    for (const t of INFRA_SOURCE_TYPES) expect(isInfraSourceType(t)).toBe(true);
    for (const t of ["manual", "dhcp_lease", "dhcp_reservation", "vip", "interface_ip", "dns_resolved"]) {
      expect(isInfraSourceType(t)).toBe(false);
    }
    expect(isInfraSourceType(null)).toBe(false);
    expect(isInfraSourceType(undefined)).toBe(false);
  });
});

describe("isLeaseBackedInfraRow", () => {
  it("admits an infra row the gate only leases", () => {
    expect(isLeaseBackedInfraRow(apRow({ dhcpBinding: "lease" }))).toBe(true);
    expect(isLeaseBackedInfraRow({ sourceType: "fortiswitch", dhcpBinding: "lease" })).toBe(true);
  });

  it("refuses a row backed by a real MAC-to-IP binding", () => {
    expect(isLeaseBackedInfraRow(apRow({ dhcpBinding: "reservation" }))).toBe(false);
  });

  it("refuses NULL — unobserved is not the same as free", () => {
    // The AP may be on a static address or simply not leasing right now.
    // Treating absence of evidence as "claimable" would hand an operator an
    // address a device is actively using.
    expect(isLeaseBackedInfraRow(apRow({ dhcpBinding: null }))).toBe(false);
    expect(isLeaseBackedInfraRow(apRow({ dhcpBinding: undefined }))).toBe(false);
  });

  it("never admits a non-infra row, whatever its binding says", () => {
    expect(isLeaseBackedInfraRow({ sourceType: "manual", dhcpBinding: "lease" })).toBe(false);
    expect(isLeaseBackedInfraRow(null)).toBe(false);
  });
});

describe("decideInfraDhcpBinding", () => {
  it("records a lease-backed address and fills the MAC from the lease entry", () => {
    const patch = decideInfraDhcpBinding(apRow(), leaseEntry);
    expect(patch).toEqual({ dhcpBinding: "lease", macAddress: "48:3A:02:00:00:01" });
  });

  it("records a real device-side reservation as such", () => {
    const patch = decideInfraDhcpBinding(apRow(), reservedEntry);
    expect(patch?.dhcpBinding).toBe("reservation");
  });

  it("NEVER stages expiresAt", () => {
    // A lease carries an expiry; stamping it here would let expireReservations
    // flip a live AP's row to `expired`, which discovery then re-creates —
    // churn, plus windows where the device reads as unreserved.
    const patch = decideInfraDhcpBinding(apRow(), { ...leaseEntry, seenLeased: true });
    expect(patch).not.toHaveProperty("expiresAt");
    expect(Object.keys(patch!).sort()).toEqual(["dhcpBinding", "lastSeenLeased", "macAddress"]);
  });

  it("never touches sourceType — ownership is a separate fact", () => {
    const patch = decideInfraDhcpBinding(apRow(), leaseEntry);
    expect(patch).not.toHaveProperty("sourceType");
  });

  it("leaves an existing MAC alone (fill-only)", () => {
    const row = apRow({ macAddress: "AA:BB:CC:DD:EE:FF", dhcpBinding: "lease" });
    expect(decideInfraDhcpBinding(row, leaseEntry)).toBeNull();
  });

  it("returns null in steady state so the hot path issues no write", () => {
    // This runs per DHCP entry per discovery cycle; at 2000 assets an
    // unconditional write here is the cost the surrounding code bulks to avoid.
    const settled = apRow({ macAddress: "48:3A:02:00:00:01", dhcpBinding: "lease" });
    expect(decideInfraDhcpBinding(settled, leaseEntry)).toBeNull();
  });

  it("still bumps presence when the entry is actively leased", () => {
    const settled = apRow({ macAddress: "48:3A:02:00:00:01", dhcpBinding: "lease" });
    expect(decideInfraDhcpBinding(settled, { ...leaseEntry, seenLeased: true }))
      .toEqual({ lastSeenLeased: true });
  });

  it("flips binding when the gate's state changes in either direction", () => {
    const leased = apRow({ macAddress: "48:3A:02:00:00:01", dhcpBinding: "lease" });
    expect(decideInfraDhcpBinding(leased, reservedEntry)).toEqual({ dhcpBinding: "reservation" });
    const reserved = apRow({ macAddress: "48:3A:02:00:00:01", dhcpBinding: "reservation" });
    expect(decideInfraDhcpBinding(reserved, leaseEntry)).toEqual({ dhcpBinding: "lease" });
  });

  it("records the lease clock in leaseExpiresAt, never expiresAt", () => {
    const settled = apRow({ macAddress: "48:3A:02:00:00:01", dhcpBinding: "lease" });
    const patch = decideInfraDhcpBinding(settled, { ...leaseEntry, expireTime: 1_793_000_000 });
    expect(patch).toEqual({ leaseExpiresAt: new Date(1_793_000_000 * 1000) });
  });

  it("writes no lease clock it already holds, so a cycle between renewals is write-free", () => {
    const settled = apRow({
      macAddress: "48:3A:02:00:00:01", dhcpBinding: "lease",
      leaseExpiresAt: new Date(1_793_000_000 * 1000),
    });
    expect(decideInfraDhcpBinding(settled, { ...leaseEntry, expireTime: 1_793_000_000 })).toBeNull();
    // A renewal moves the clock, and that is the one write.
    expect(decideInfraDhcpBinding(settled, { ...leaseEntry, expireTime: 1_793_014_400 }))
      .toEqual({ leaseExpiresAt: new Date(1_793_014_400 * 1000) });
  });

  it("clears the lease clock once the gate reserves the address, or stops reporting an expiry", () => {
    const leased = apRow({
      macAddress: "48:3A:02:00:00:01", dhcpBinding: "lease",
      leaseExpiresAt: new Date(1_793_000_000 * 1000),
    });
    expect(decideInfraDhcpBinding(leased, { ...reservedEntry, expireTime: 1_793_000_000 }))
      .toEqual({ dhcpBinding: "reservation", leaseExpiresAt: null });
    expect(decideInfraDhcpBinding(leased, leaseEntry)).toEqual({ leaseExpiresAt: null });
  });

  it("normalizes the lease MAC into storage form", () => {
    const patch = decideInfraDhcpBinding(apRow(), { type: "dhcp-lease", macAddress: "48-3a-02-00-00-01" });
    expect(patch?.macAddress).toBe("48:3A:02:00:00:01");
  });

  it("tolerates a lease entry with no MAC", () => {
    const patch = decideInfraDhcpBinding(apRow(), { type: "dhcp-lease" });
    expect(patch).toEqual({ dhcpBinding: "lease" });
  });

  it("declines to decide anything about a non-infra row", () => {
    expect(decideInfraDhcpBinding({ sourceType: "dhcp_lease" }, leaseEntry)).toBeNull();
    expect(decideInfraDhcpBinding({ sourceType: "manual" }, reservedEntry)).toBeNull();
  });
});

describe("reservationBelongsToInfraDevice", () => {
  it("matches on MAC", () => {
    const row: InfraReservationRow = { sourceType: "manual", macAddress: "48:3a:02:00:00:01", hostname: "typo-name" };
    expect(reservationBelongsToInfraDevice(row, { mac: "48:3A:02:00:00:01", name: "STONEHAVEN-108F-3" })).toBe(true);
  });

  it("trusts MAC over hostname when both are known and MAC disagrees", () => {
    // Hostname collisions across sites are common; a MAC mismatch is decisive,
    // so this must stay a conflict rather than being waved through by the name.
    const row: InfraReservationRow = { sourceType: "manual", macAddress: "AA:BB:CC:DD:EE:FF", hostname: "AP-1" };
    expect(reservationBelongsToInfraDevice(row, { mac: "48:3A:02:00:00:01", name: "AP-1" })).toBe(false);
  });

  it("falls back to hostname when either side has no MAC", () => {
    const row: InfraReservationRow = { sourceType: "manual", macAddress: null, hostname: "stonehaven-108f-3" };
    expect(reservationBelongsToInfraDevice(row, { mac: null, name: "STONEHAVEN-108F-3" })).toBe(true);
    expect(reservationBelongsToInfraDevice(row, { mac: "48:3A:02:00:00:01", name: "STONEHAVEN-108F-3" })).toBe(true);
  });

  it("accepts a Polaris-pushed row at the device's own address", () => {
    const row: InfraReservationRow = { sourceType: "manual", macAddress: null, hostname: null, pushedToId: "int-1" };
    expect(reservationBelongsToInfraDevice(row, { mac: null, name: "AP-1" })).toBe(true);
  });

  it("still reports a genuine collision", () => {
    // An operator reserved this address for something else entirely — the
    // conflict card is the correct outcome and must survive.
    const row: InfraReservationRow = { sourceType: "manual", macAddress: null, hostname: "printer-3" };
    expect(reservationBelongsToInfraDevice(row, { mac: "48:3A:02:00:00:01", name: "AP-1" })).toBe(false);
    expect(reservationBelongsToInfraDevice(row, { mac: null, name: null })).toBe(false);
  });

  it("is false for a missing row", () => {
    expect(reservationBelongsToInfraDevice(null, { mac: "48:3A:02:00:00:01", name: "AP-1" })).toBe(false);
  });
});

describe("shouldReleaseInfraReservation", () => {
  const ap: InfraReleaseDevice = {
    mac: "48:3A:02:00:00:01",
    name: "STONEHAVEN-108F-3",
    integrationId: "int-fmg",
    controllerFortigate: "STONEHAVEN-101F-1",
  };
  function row(over: Partial<InfraReleaseCandidate> = {}): InfraReleaseCandidate {
    return { sourceType: "fortinap", subnetDiscoveredBy: "int-fmg", subnetFortigateDevice: "STONEHAVEN-101F-1", ...over };
  }

  it("releases the device's own infra row", () => {
    expect(shouldReleaseInfraReservation(ap, row())).toBe(true);
    expect(shouldReleaseInfraReservation(ap, row({ sourceType: "fortiswitch" }))).toBe(true);
  });

  it("never releases an operator's manual reservation at the address", () => {
    // The device going away says nothing about a reservation a person typed.
    expect(shouldReleaseInfraReservation(ap, row({ sourceType: "manual" }))).toBe(false);
    expect(shouldReleaseInfraReservation(ap, row({ sourceType: "dhcp_reservation" }))).toBe(false);
    expect(shouldReleaseInfraReservation(ap, row({ sourceType: "vip" }))).toBe(false);
  });

  it("releases a Polaris-pushed row that belongs to this device", () => {
    const pushed = row({ sourceType: "manual", pushedToId: "int-fmg", macAddress: "48:3a:02:00:00:01" });
    expect(shouldReleaseInfraReservation(ap, pushed)).toBe(true);
  });

  it("leaves a pushed row for a DIFFERENT device alone", () => {
    const other = row({ sourceType: "manual", pushedToId: "int-fmg", macAddress: "AA:BB:CC:DD:EE:FF", hostname: "printer-3" });
    expect(shouldReleaseInfraReservation(ap, other)).toBe(false);
  });

  it("refuses to cross integrations", () => {
    // RFC1918 repeats: the same address behind another integration's gate is a
    // different address.
    expect(shouldReleaseInfraReservation(ap, row({ subnetDiscoveredBy: "int-other" }))).toBe(false);
  });

  it("refuses to cross FortiGates within one integration", () => {
    expect(shouldReleaseInfraReservation(ap, row({ subnetFortigateDevice: "SOMEWHERE-ELSE-1" }))).toBe(false);
  });

  it("compares FortiGate names case-insensitively", () => {
    expect(shouldReleaseInfraReservation(ap, row({ subnetFortigateDevice: "stonehaven-101f-1" }))).toBe(true);
  });

  it("does not treat an unknown scope on either side as a mismatch", () => {
    // An unknown must not block a legitimate release — but it must not be the
    // thing that authorizes one either, which is why ownership is still checked.
    expect(shouldReleaseInfraReservation(ap, row({ subnetDiscoveredBy: null, subnetFortigateDevice: null }))).toBe(true);
    expect(shouldReleaseInfraReservation({ ...ap, integrationId: null, controllerFortigate: null }, row())).toBe(true);
    expect(shouldReleaseInfraReservation(
      { integrationId: null, controllerFortigate: null },
      row({ sourceType: "manual", subnetDiscoveredBy: null, subnetFortigateDevice: null }),
    )).toBe(false);
  });
});

describe("classifyOrphanInfraRow", () => {
  it("releases when every device holding the address is decommissioned", () => {
    expect(classifyOrphanInfraRow({}, ["decommissioned"])).toBe("release");
    expect(classifyOrphanInfraRow({ pushedToId: "int-1" }, ["decommissioned", "decommissioned"])).toBe("release");
  });

  it("keeps the row while any holder is still alive", () => {
    expect(classifyOrphanInfraRow({}, ["active"])).toBe("keep");
    expect(classifyOrphanInfraRow({}, ["decommissioned", "active"])).toBe("keep");
    expect(classifyOrphanInfraRow({}, ["maintenance"])).toBe("keep");
  });

  it("releases an unpushed row with no device at all", () => {
    expect(classifyOrphanInfraRow({}, [])).toBe("release");
    expect(classifyOrphanInfraRow({ pushedToId: null }, [])).toBe("release");
  });

  it("SKIPS a pushed row with no device — the weak signal must not write to a gate", () => {
    // "No asset found" is also what a transient discovery state looks like.
    // Releasing a pushed row would delete a reserved-address entry on a live
    // FortiGate on the strength of that; a decommissioned asset is the only
    // evidence strong enough for a device write.
    expect(classifyOrphanInfraRow({ pushedToId: "int-1" }, [])).toBe("skip");
  });
});
