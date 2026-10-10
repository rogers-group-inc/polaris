/**
 * tests/unit/inventoryLocality.test.ts
 *
 * The locality gate on FortiOS device-inventory sightings: a ZTNA access
 * proxy session creates an inventory entry on the gate the user connects
 * THROUGH, so an entry may only LOCATE a device on positive local evidence —
 * FortiSwitch/FortiAP attribution on the row, or an ARP binding for the same
 * MAC on the same gate this cycle.
 */

import { describe, it, expect } from "vitest";
import {
  buildArpMacDeviceIndex,
  inventorySightingIsLocal,
  inventorySwitchAttribution,
  parseInventoryClient,
  INVENTORY_QUERY_FORMAT,
} from "../../src/utils/inventoryLocality.js";

describe("buildArpMacDeviceIndex", () => {
  it("keys on normalized MAC + lowercased device", () => {
    const idx = buildArpMacDeviceIndex([
      { fortigateDevice: "METRO-1801F-1", mac: "68-34-21-b7-70-d7" },
    ]);
    expect(idx.has("68:34:21:B7:70:D7|metro-1801f-1")).toBe(true);
  });

  it("skips rows missing either half, and tolerates null/undefined input", () => {
    const idx = buildArpMacDeviceIndex([
      { fortigateDevice: "GATE-1", mac: null },
      { fortigateDevice: null, mac: "AA:BB:CC:DD:EE:FF" },
    ]);
    expect(idx.size).toBe(0);
    expect(buildArpMacDeviceIndex(null).size).toBe(0);
    expect(buildArpMacDeviceIndex(undefined).size).toBe(0);
  });
});

describe("inventorySightingIsLocal", () => {
  const empty = new Set<string>();

  it("FortiSwitch attribution is local by definition", () => {
    expect(inventorySightingIsLocal(
      { device: "GATE-1", macAddress: "AA:BB:CC:DD:EE:FF", switchName: "CKYSMA-148F-1", apName: "" },
      empty,
    )).toBe(true);
  });

  it("FortiAP attribution is local by definition", () => {
    expect(inventorySightingIsLocal(
      { device: "GATE-1", macAddress: "AA:BB:CC:DD:EE:FF", switchName: "", apName: "METRO3RD-431F-3" },
      empty,
    )).toBe(true);
  });

  it("an ARP binding on the SAME gate makes a bare row local", () => {
    const idx = buildArpMacDeviceIndex([
      { fortigateDevice: "Metro-1801F-1", mac: "aa:bb:cc:dd:ee:ff" },
    ]);
    expect(inventorySightingIsLocal(
      { device: "METRO-1801F-1", macAddress: "AA-BB-CC-DD-EE-FF", switchName: "", apName: "" },
      idx,
    )).toBe(true);
  });

  it("an ARP binding on a DIFFERENT gate does not vouch for this one", () => {
    const idx = buildArpMacDeviceIndex([
      { fortigateDevice: "METRO-1801F-1", mac: "AA:BB:CC:DD:EE:FF" },
    ]);
    // The ZTNA shape: fresh entry, no switch/AP, no ARP on the reporting gate.
    expect(inventorySightingIsLocal(
      { device: "JAMESTOWNSTONE-61F-1", macAddress: "AA:BB:CC:DD:EE:FF", switchName: "", apName: "" },
      idx,
    )).toBe(false);
  });

  it("a bare row with no MAC or no device can never prove locality", () => {
    expect(inventorySightingIsLocal({ device: "GATE-1", macAddress: "", switchName: "", apName: "" }, empty)).toBe(false);
    expect(inventorySightingIsLocal({ device: "", macAddress: "AA:BB:CC:DD:EE:FF", switchName: "", apName: "" }, empty)).toBe(false);
  });
});

describe("inventorySwitchAttribution", () => {
  it("reads the legacy field names", () => {
    expect(inventorySwitchAttribution({ switch_fortilink: "SW-1", switch_port: 7 }))
      .toEqual({ switchName: "SW-1", switchPort: "7" });
    expect(inventorySwitchAttribution({ fortiswitch: "SW-2", switch_port: "12" }))
      .toEqual({ switchName: "SW-2", switchPort: "12" });
  });

  it("reads the 7.x fortiswitch_* field names", () => {
    expect(inventorySwitchAttribution({
      fortiswitch_id: "CKYSMA-148F-1",
      fortiswitch_port_id: 43,
      fortiswitch_port_name: "port43",
    })).toEqual({ switchName: "CKYSMA-148F-1", switchPort: "43" });
  });

  it("strips a port_name's own 'port' prefix so the render can't double it", () => {
    expect(inventorySwitchAttribution({ fortiswitch_id: "SW-3", fortiswitch_port_name: "port43" }))
      .toEqual({ switchName: "SW-3", switchPort: "43" });
  });

  it("empty when the row carries no switch attribution", () => {
    expect(inventorySwitchAttribution({})).toEqual({ switchName: "", switchPort: "" });
  });

  it("the shared format list requests every field the fallback chains read", () => {
    for (const f of [
      "switch_fortilink", "fortiswitch", "fortiswitch_id",
      "switch_port", "fortiswitch_port_id", "fortiswitch_port_name",
      "ap_name", "fortiap", "is_online", "last_seen",
    ]) {
      expect(INVENTORY_QUERY_FORMAT.split("|")).toContain(f);
    }
  });
});

/**
 * parseInventoryClient — one parse for both collectors. The 7.x row below is
 * the shape a FortiGate returned in prod (2026-10-10), values synthetic: the
 * address is in `ipv4_address`, and a parser reading only `ip` handed
 * discovery an empty address for every detected device, so business rule
 * 101's strongest claim never fired.
 */
describe("parseInventoryClient", () => {
  const ROW_7X = {
    ipv4_address: "10.40.25.235",
    mac: "aa:bb:cc:4c:45:40",
    hardware_type: "Unknown",
    os_name: "Windows",
    os_version: "10/11",
    hostname: "PC-TEST01",
    unauth_user: "svc_test",
    last_seen: 1791665249,
    is_online: true,
    fortiswitch_id: "SW-TEST-124F",
    fortiswitch_port_id: 3,
    fortiswitch_port_name: "port3",
    detected_interface: "PlantLan",
  };

  it("reads a 7.x row: ipv4_address, os_name, detected_interface, unauth_user", () => {
    const p = parseInventoryClient(ROW_7X, "GW-1")!;
    expect(p).toMatchObject({
      device: "GW-1",
      macAddress: "aa:bb:cc:4c:45:40",
      ipAddress: "10.40.25.235",
      hostname: "PC-TEST01",
      os: "Windows",
      osVersion: "10/11",
      interfaceName: "PlantLan",
      switchName: "SW-TEST-124F",
      switchPort: "3",
      user: "svc_test",
      isOnline: true,
    });
    expect(p.lastSeen).toBe(new Date(1791665249 * 1000).toISOString());
  });

  it("still reads an older row's ip / os / interface / user", () => {
    const p = parseInventoryClient({
      mac: "aa:bb:cc:00:00:01", ip: "10.1.1.1", os: "Linux", interface: "internal", user: "bob",
      last_seen: 1700000000, is_online: false, ap_name: "AP-1",
    }, "GW-2")!;
    expect(p).toMatchObject({ ipAddress: "10.1.1.1", os: "Linux", interfaceName: "internal", user: "bob", apName: "AP-1", isOnline: false });
  });

  it("prefers the 7.x name when a row carries both", () => {
    expect(parseInventoryClient({ mac: "aa", ipv4_address: "10.0.0.2", ip: "10.0.0.9", last_seen: 1 }, "G")!.ipAddress).toBe("10.0.0.2");
  });

  it("drops a row with neither MAC nor address, or no last_seen", () => {
    expect(parseInventoryClient({ hostname: "x", last_seen: 1 }, "G")).toBeNull();
    expect(parseInventoryClient({ mac: "aa:bb:cc:00:00:01" }, "G")).toBeNull();
  });

  it("asks FortiOS for both spellings of every renamed field", () => {
    const fields = INVENTORY_QUERY_FORMAT.split("|");
    for (const f of ["ipv4_address", "ip", "os_name", "os", "detected_interface", "interface", "unauth_user", "user"]) {
      expect(fields).toContain(f);
    }
  });
});
