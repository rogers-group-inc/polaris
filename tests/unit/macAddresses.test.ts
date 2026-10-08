/**
 * tests/unit/macAddresses.test.ts
 *
 * Primary-MAC selection: hardware-truth entries (Intune/agent/vCenter NICs)
 * outrank network sightings, so a dock, dongle, or randomized-Wi-Fi MAC kept
 * fresh by some gate's sighting can never displace the device's real NIC as
 * `Asset.macAddress`.
 */

import { describe, it, expect } from "vitest";
import {
  selectPrimaryMac,
  buildMacRowsForCreate,
  isHardwareMacSource,
  HARDWARE_MAC_SOURCES,
} from "../../src/utils/macAddresses.js";

const entry = (mac: string, source: string, lastSeen: string, macEnd?: string) => ({
  mac, source, lastSeen, ...(macEnd ? { macEnd } : {}),
});

describe("isHardwareMacSource", () => {
  it("accepts the four hardware-truth sources", () => {
    for (const s of ["polaris-agent", "intune-ethernet", "intune-wifi", "vcenter-vnic"]) {
      expect(isHardwareMacSource(s)).toBe(true);
      expect(HARDWARE_MAC_SOURCES.has(s)).toBe(true);
    }
  });

  it("rejects sighting sources, empty, and absent", () => {
    for (const s of ["device-inventory", "dhcp-lease", "dhcp-reservation", "fmg-discovery", "monitor-interface", "", undefined, null]) {
      expect(isHardwareMacSource(s as any)).toBe(false);
    }
  });
});

describe("selectPrimaryMac", () => {
  it("returns null for empty / missing lists", () => {
    expect(selectPrimaryMac([])).toBeNull();
    expect(selectPrimaryMac(null)).toBeNull();
    expect(selectPrimaryMac(undefined)).toBeNull();
  });

  it("keeps the historical freshest-overall rule when no hardware entry exists", () => {
    expect(selectPrimaryMac([
      entry("AA:AA:AA:AA:AA:01", "device-inventory", "2026-08-01T00:00:00.000Z"),
      entry("AA:AA:AA:AA:AA:02", "dhcp-lease", "2026-08-20T00:00:00.000Z"),
    ])).toBe("AA:AA:AA:AA:AA:02");
  });

  it("a fresher sighting never displaces a hardware NIC", () => {
    // The prod shape: the Intune ethernet MAC vs a dock MAC a remote gate's
    // inventory keeps re-freshening.
    expect(selectPrimaryMac([
      entry("40:C2:BA:7D:1B:5E", "device-inventory", "2026-08-21T12:52:52.000Z"),
      entry("68:34:21:B7:70:D7", "intune-wifi", "2026-08-21T11:30:56.000Z"),
    ])).toBe("68:34:21:B7:70:D7");
  });

  it("freshest wins among hardware entries", () => {
    expect(selectPrimaryMac([
      entry("68:34:21:B7:70:D7", "intune-wifi", "2026-08-20T00:00:00.000Z"),
      entry("68:34:21:B7:70:D8", "intune-ethernet", "2026-08-21T00:00:00.000Z"),
      entry("40:C2:BA:7D:1B:5E", "device-inventory", "2026-08-22T00:00:00.000Z"),
    ])).toBe("68:34:21:B7:70:D8");
  });

  it("ties keep the first entry, so re-runs are stable", () => {
    const t = "2026-08-21T00:00:00.000Z";
    expect(selectPrimaryMac([
      entry("AA:AA:AA:AA:AA:01", "intune-ethernet", t),
      entry("AA:AA:AA:AA:AA:02", "intune-wifi", t),
    ])).toBe("AA:AA:AA:AA:AA:01");
  });

  it("range rows are never primary, even as the only hardware-free entries", () => {
    expect(selectPrimaryMac([
      entry("AA:AA:AA:AA:AA:00", "monitor-interface", "2026-08-21T00:00:00.000Z", "AA:AA:AA:AA:AA:30"),
      entry("BB:BB:BB:BB:BB:01", "dhcp-lease", "2026-01-01T00:00:00.000Z"),
    ])).toBe("BB:BB:BB:BB:BB:01");
    expect(selectPrimaryMac([
      entry("AA:AA:AA:AA:AA:00", "monitor-interface", "2026-08-21T00:00:00.000Z", "AA:AA:AA:AA:AA:30"),
    ])).toBeNull();
  });

  it("unparseable lastSeen ranks as oldest rather than throwing", () => {
    expect(selectPrimaryMac([
      entry("AA:AA:AA:AA:AA:01", "dhcp-lease", "not-a-date"),
      entry("AA:AA:AA:AA:AA:02", "device-inventory", "2026-08-21T00:00:00.000Z"),
    ])).toBe("AA:AA:AA:AA:AA:02");
  });

  it("the all-zero MAC is never primary, even as the freshest hardware entry", () => {
    expect(selectPrimaryMac([
      entry("00:00:00:00:00:00", "polaris-agent", "2026-08-22T00:00:00.000Z"),
      entry("AA:AA:AA:AA:AA:01", "dhcp-lease", "2026-08-01T00:00:00.000Z"),
    ])).toBe("AA:AA:AA:AA:AA:01");
    expect(selectPrimaryMac([entry("00-00-00-00-00-00", "dhcp-lease", "2026-08-22T00:00:00.000Z")])).toBeNull();
  });
});

describe("buildMacRowsForCreate", () => {
  it("drops empty and all-zero entries", () => {
    const rows = buildMacRowsForCreate([
      { mac: "", source: "dhcp-lease" },
      { mac: "00:00:00:00:00:00", source: "fortigate-firewall" },
      { mac: "AA:AA:AA:AA:AA:01", source: "dhcp-lease" },
    ] as any);
    expect(rows.map((r) => r.mac)).toEqual(["AA:AA:AA:AA:AA:01"]);
  });
});
