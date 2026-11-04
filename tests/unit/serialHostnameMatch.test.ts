/**
 * tests/unit/serialHostnameMatch.test.ts
 *
 * Business rule 91(c). A managed FortiSwitch takes its management address by
 * DHCP from its gate, and FortiOS reports that client with the SWITCH SERIAL
 * as its hostname. With no MAC on the switch record yet, Phase 7 used to find
 * nothing and mint a "fortigate-endpoint" duplicate of the switch on its own
 * management IP (the duplicate-IP card in prod, 2026-10-21).
 *
 * The serial rung resolves that row to the switch — but only when the row's
 * address is the switch's recorded address, because the hostname is still the
 * client's claim (rule 91(b)) and anyone can send "S108FF…" as option 12.
 */

import { describe, it, expect } from "vitest";
import { serialHostnameCorroborated } from "../../src/utils/serialHostnameMatch.js";
import { AssetIndex } from "../../src/services/discovery/discoveryEngine.js";

const SERIAL = "S108FFTV25010503";
const MGMT_IP = "172.23.33.130";

function managedSwitch(over: Record<string, unknown> = {}) {
  return {
    id: "switch-1",
    hostname: "NEWTON-108F-7",
    serialNumber: SERIAL,
    assetType: "switch",
    ipAddress: MGMT_IP,
    macAddress: null,
    macAddresses: [],
    monitored: true,
    fortinetTopology: { role: "fortiswitch", controllerFortigate: "NEWTON-61F-1" },
    ...over,
  };
}

describe("serialHostnameCorroborated", () => {
  it("accepts a managed switch whose recorded address is the row's", () => {
    expect(serialHostnameCorroborated(managedSwitch(), SERIAL, MGMT_IP)).toBe(true);
  });

  it("accepts a managed access point", () => {
    expect(serialHostnameCorroborated(
      managedSwitch({ assetType: "access_point", fortinetTopology: { role: "fortiap" } }),
      "FP231FTF23012345", MGMT_IP,
    )).toBe(true);
  });

  it("refuses when the row's address differs — the serial is only a claim", () => {
    expect(serialHostnameCorroborated(managedSwitch(), SERIAL, "172.23.33.199")).toBe(false);
  });

  it("refuses when the row carries no address, or the switch has none recorded", () => {
    expect(serialHostnameCorroborated(managedSwitch(), SERIAL, null)).toBe(false);
    expect(serialHostnameCorroborated(managedSwitch({ ipAddress: null }), SERIAL, MGMT_IP)).toBe(false);
  });

  it("refuses an asset Fortinet discovery does not own", () => {
    // An operator-typed "switch" carries no topology stamp; its address was
    // never reported by a controller, so it corroborates nothing.
    expect(serialHostnameCorroborated(managedSwitch({ fortinetTopology: null }), SERIAL, MGMT_IP)).toBe(false);
  });

  it("refuses types a gate does not hand a serial-named lease to", () => {
    expect(serialHostnameCorroborated(managedSwitch({ assetType: "firewall" }), SERIAL, MGMT_IP)).toBe(false);
    expect(serialHostnameCorroborated(managedSwitch({ assetType: "server" }), SERIAL, MGMT_IP)).toBe(false);
  });

  it("refuses a placeholder serial as the hostname", () => {
    expect(serialHostnameCorroborated(managedSwitch({ serialNumber: "Default string" }), "Default string", MGMT_IP)).toBe(false);
  });
});

describe("AssetIndex serial rung (rule 91(c))", () => {
  it("resolves a serial-hostnamed row to the switch instead of missing", () => {
    const idx = new AssetIndex([managedSwitch()]);
    const hit = idx.findByEntryWithRung("48:3A:02:DA:54:54", SERIAL, MGMT_IP, { allowIpFallback: false, serialHostname: true });
    expect(hit?.asset.id).toBe("switch-1");
    expect(hit?.rung).toBe("serial");
  });

  it("matches the serial case-insensitively, as the serial index does", () => {
    const idx = new AssetIndex([managedSwitch()]);
    const hit = idx.findByEntryWithRung(undefined, SERIAL.toLowerCase(), MGMT_IP, { allowIpFallback: false, serialHostname: true });
    expect(hit?.asset.id).toBe("switch-1");
  });

  it("outranks an endpoint ghost a past run created under the serial", () => {
    const ghost = {
      id: "ghost-1", hostname: SERIAL, serialNumber: null, assetType: "other",
      ipAddress: MGMT_IP, macAddress: null, macAddresses: [], fortinetTopology: null,
    };
    const idx = new AssetIndex([managedSwitch(), ghost]);
    const hit = idx.findByEntryWithRung(undefined, SERIAL, MGMT_IP, { allowIpFallback: false, serialHostname: true });
    expect(hit?.asset.id).toBe("switch-1");
  });

  it("still lets a MAC match win over the serial rung", () => {
    const laptop = {
      id: "laptop-1", hostname: "LAPTOP", serialNumber: null, assetType: "workstation",
      ipAddress: "10.0.0.5", macAddress: "AA:BB:CC:DD:EE:FF", macAddresses: [], fortinetTopology: null,
    };
    const idx = new AssetIndex([managedSwitch(), laptop]);
    const hit = idx.findByEntryWithRung("AA:BB:CC:DD:EE:FF", SERIAL, MGMT_IP, { allowIpFallback: false, serialHostname: true });
    expect(hit?.asset.id).toBe("laptop-1");
    expect(hit?.rung).toBe("mac");
  });

  it("an uncorroborated serial claim falls through to the old ladder", () => {
    const idx = new AssetIndex([managedSwitch()]);
    const hit = idx.findByEntryWithRung("AA:BB:CC:00:00:01", SERIAL, "10.9.9.9", { allowIpFallback: false, serialHostname: true });
    expect(hit).toBeUndefined();
  });

  it("is off unless asked for", () => {
    const idx = new AssetIndex([managedSwitch()]);
    expect(idx.findByEntryWithRung(undefined, SERIAL, MGMT_IP, { allowIpFallback: false })).toBeUndefined();
  });
});

/**
 * Rule 91(f): the DHCP lease and detected-device paths pass
 * `allowHostname: false`, because a client's DHCP hostname is whatever it
 * sent and whole product lines send the same one.
 */
describe("AssetIndex hostname rung off (rule 91(f))", () => {
  const espressif = { id: "esp-1", hostname: "espressif", macAddress: "AA:BB:CC:00:00:01", macAddresses: [], ipAddress: "10.1.1.5", assetType: "other" };

  it("a second device sending the same DHCP hostname matches nothing", () => {
    const idx = new AssetIndex([espressif]);
    const hit = idx.findByEntryWithRung("AA:BB:CC:00:00:02", "espressif", "10.1.1.6", { allowIpFallback: false, serialHostname: true, allowHostname: false });
    expect(hit).toBeUndefined();
  });

  it("the device's own MAC still matches", () => {
    const idx = new AssetIndex([espressif]);
    const hit = idx.findByEntryWithRung("aa-bb-cc-00-00-01", "espressif", "10.1.1.5", { allowIpFallback: false, serialHostname: true, allowHostname: false });
    expect(hit?.asset.id).toBe("esp-1");
    expect(hit?.rung).toBe("mac");
  });

  it("the serial rung survives — it is corroborated by address", () => {
    const idx = new AssetIndex([managedSwitch()]);
    const hit = idx.findByEntryWithRung(undefined, SERIAL, MGMT_IP, { allowIpFallback: false, serialHostname: true, allowHostname: false });
    expect(hit?.rung).toBe("serial");
  });

  it("other callers keep the hostname rung by default", () => {
    const idx = new AssetIndex([espressif]);
    expect(idx.findByEntryWithRung(undefined, "ESPRESSIF", undefined, { allowIpFallback: false })?.rung).toBe("hostname");
  });
});
