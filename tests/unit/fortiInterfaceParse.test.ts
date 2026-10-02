/**
 * tests/unit/fortiInterfaceParse.test.ts — the pure parse/merge cores of
 * collectSystemInfoFortinet (extracted 2026-08). Pins the FortiOS payload
 * quirks that were previously locked inside the transport-coupled collector:
 * the hyphenated CMDB member key, the ipv4_addresses vs legacy `ip`
 * fallback, Mbps→bps conversion, CMDB-over-monitor precedence, and the
 * aggregate-member back-fill/synthesis.
 */

import { describe, it, expect } from "vitest";
import {
  parseFortiCmdbInterfaceTable,
  buildFortiInterfaceSamples,
  backfillFortiAggregateMembers,
  backfillFortiCmdbOnlyTunnels,
} from "../../src/services/monitoringService.js";

describe("parseFortiCmdbInterfaceTable", () => {
  it("reads members through the hyphenated key with q_origin_key / underscore / string fallbacks", () => {
    const map = parseFortiCmdbInterfaceTable({
      results: [
        {
          name: "fortilink",
          type: "aggregate",
          member: [
            { "interface-name": "port15" },
            { q_origin_key: "port16" },
            { interface_name: "port17" },
            "port18",
            { unrelated: true },
          ],
        },
      ],
    });
    expect(map.get("fortilink")!.members).toEqual(["port15", "port16", "port17", "port18"]);
  });

  it("keeps vlan parent/id only for type=vlan, trims alias/description, whitelists addressing mode", () => {
    const map = parseFortiCmdbInterfaceTable([
      { name: "v100", type: "vlan", interface: "internal", vlanid: 100, alias: "  Guests ", description: " " , mode: "DHCP" },
      { name: "wan1", type: "physical", interface: "x", vlanid: 5, alias: "", mode: "pppoe-ish" },
    ]);
    expect(map.get("v100")).toMatchObject({ parent: "internal", vlanId: 100, alias: "Guests", description: null, addressingMode: "dhcp" });
    expect(map.get("wan1")).toMatchObject({ parent: null, vlanId: null, alias: null, addressingMode: null });
  });

  it("null / malformed responses yield an empty map", () => {
    expect(parseFortiCmdbInterfaceTable(null).size).toBe(0);
    expect(parseFortiCmdbInterfaceTable({ results: "nope" }).size).toBe(0);
    expect(parseFortiCmdbInterfaceTable([{ noName: true }]).size).toBe(0);
  });

  /**
   * The CMDB is the ONLY place a standalone FortiGate reports admin status:
   * `/api/v2/monitor/system/interface` carries `link` and nothing
   * status-shaped (confirmed on FortiOS 7.6.7). Dropping it left adminStatus
   * null on every interface, which silently disabled every `ifOperStatus`
   * automation on those gates — business rule 57 skips a reading whose
   * adminStatus is not "up", so the automation saved, looked right and never
   * fired. Found against real lab hardware 2026-09-21.
   */
  it("keeps the CMDB `status` as adminStatus — the only source a gate has for it", () => {
    const map = parseFortiCmdbInterfaceTable({
      results: [
        { name: "dmz", status: "down", type: "physical" },
        { name: "wan1", status: "up", type: "physical" },
        { name: "MIXED", status: "UP", type: "physical" },
      ],
    });
    expect(map.get("dmz")?.adminStatus).toBe("down");
    expect(map.get("wan1")?.adminStatus).toBe("up");
    // Case-folded, like `mode` beside it.
    expect(map.get("MIXED")?.adminStatus).toBe("up");
  });

  it("treats an absent or unrecognised status as UNKNOWN, never as a value", () => {
    // Null must not be coerced to "up": that would make an admin-downed port
    // look like a real outage on every firmware that omits the field.
    const map = parseFortiCmdbInterfaceTable({
      results: [
        { name: "noStatus", type: "physical" },
        { name: "weird", status: "flapping", type: "physical" },
      ],
    });
    expect(map.get("noStatus")?.adminStatus).toBeNull();
    expect(map.get("weird")?.adminStatus).toBeNull();
  });
});

describe("buildFortiInterfaceSamples", () => {
  it("maps runtime state: ipv4_addresses first, legacy ip fallback, Mbps→bps, MAC uppercased, error-counter aliases", () => {
    const rows = buildFortiInterfaceSamples(
      {
        wan1: {
          status: "up", link: true, speed: 1000.5,
          ipv4_addresses: [{ ip: "203.0.113.5" }],
          mac: "aa:bb:cc:dd:ee:ff",
          rx_bytes: 111, tx_bytes: 222, rx_errors: 3, tx_errors: 4,
          type: "physical",
        },
        internal: {
          status: "down", link: false,
          ip: "10.0.0.1 255.255.255.0",
          errors_in: 7, errors_out: 8,
        },
      },
      new Map(),
    );
    const wan1 = rows.find((r) => r.ifName === "wan1")!;
    expect(wan1).toMatchObject({
      adminStatus: "up", operStatus: "up",
      speedBps: 1000500000,
      ipAddress: "203.0.113.5",
      macAddress: "AA:BB:CC:DD:EE:FF",
      inOctets: 111, outOctets: 222, inErrors: 3, outErrors: 4,
    });
    const internal = rows.find((r) => r.ifName === "internal")!;
    expect(internal).toMatchObject({
      adminStatus: "down", operStatus: "down",
      ipAddress: "10.0.0.1",
      inErrors: 7, outErrors: 8,
      speedBps: null,
    });
  });

  it("CMDB metadata wins over the monitor payload for type/parent/vlan and supplies alias/description", () => {
    const cmdb = parseFortiCmdbInterfaceTable([
      { name: "v200", type: "vlan", interface: "lan", vlanid: 200, alias: "IoT", description: "IoT segment" },
    ]);
    const rows = buildFortiInterfaceSamples(
      { v200: { status: "up", link: true, type: "physical" } },
      cmdb,
    );
    expect(rows[0]).toMatchObject({
      ifType: "vlan", ifParent: "lan", vlanId: 200, alias: "IoT", description: "IoT segment",
    });
  });
});

describe("backfillFortiAggregateMembers", () => {
  it("stamps ifParent on present members and synthesizes CMDB-only members with null runtime fields", () => {
    const cmdb = parseFortiCmdbInterfaceTable([
      { name: "fortilink", type: "aggregate", member: [{ "interface-name": "port15" }, { "interface-name": "port16" }] },
      { name: "port16", type: "physical", alias: "uplink-b" },
    ]);
    const monitorObj = {
      fortilink: { status: "up", link: true, type: "aggregate" },
      port15:    { status: "up", link: true, type: "physical" },
      // port16 omitted from the monitor payload — FortiOS hides subordinate ports.
    };
    const interfaces = buildFortiInterfaceSamples(monitorObj, cmdb);
    backfillFortiAggregateMembers(interfaces, monitorObj, cmdb);

    const port15 = interfaces.find((r) => r.ifName === "port15")!;
    expect(port15.ifParent).toBe("fortilink");

    const port16 = interfaces.find((r) => r.ifName === "port16")!;
    expect(port16).toMatchObject({
      ifParent: "fortilink", ifType: "physical", alias: "uplink-b",
      adminStatus: null, operStatus: null, inOctets: null,
    });
  });

  it("never overwrites an existing ifParent and falls back to monitor-side member arrays", () => {
    const monitorObj = {
      agg1:  { member: ["portA"] },
      portA: {},
    };
    const interfaces = buildFortiInterfaceSamples(monitorObj, new Map());
    // Force agg1 to read as an aggregate and give portA a pre-existing parent.
    interfaces.find((r) => r.ifName === "agg1")!.ifType = "aggregate";
    interfaces.find((r) => r.ifName === "portA")!.ifParent = "already-set";
    backfillFortiAggregateMembers(interfaces, monitorObj, new Map());
    expect(interfaces.find((r) => r.ifName === "portA")!.ifParent).toBe("already-set");
  });
});

/**
 * `/api/v2/monitor/system/interface` omits `type tunnel` interfaces, so on a
 * REST-polled gate IPsec / ADVPN overlay interfaces never reached the System
 * tab and their overlay addresses were never tied to the firewall (reported
 * on a FortiGate 1801F ADVPN hub, 2026-10-02). The CMDB row carries both.
 */
describe("backfillFortiCmdbOnlyTunnels", () => {
  it("parses the CMDB ip pair to a bare address and drops 0.0.0.0", () => {
    const map = parseFortiCmdbInterfaceTable([
      { name: "ADVPN", type: "tunnel", ip: "10.255.0.1 255.255.255.255" },
      { name: "fmg-arr", type: "tunnel", ip: ["10.255.1.1", "255.255.255.255"] },
      { name: "s2s", type: "tunnel", ip: "0.0.0.0 0.0.0.0" },
      { name: "noip", type: "tunnel" },
    ]);
    expect(map.get("ADVPN")!.ipAddress).toBe("10.255.0.1");
    expect(map.get("fmg-arr")!.ipAddress).toBe("10.255.1.1");
    expect(map.get("s2s")!.ipAddress).toBeNull();
    expect(map.get("noip")!.ipAddress).toBeNull();
  });

  it("synthesizes a tunnel row from the CMDB for each tunnel the monitor omitted", () => {
    const cmdb = parseFortiCmdbInterfaceTable([
      { name: "wan1", type: "physical", ip: "203.0.113.2 255.255.255.252", status: "up" },
      { name: "ADVPN", type: "tunnel", interface: "wan1", ip: "10.255.0.1 255.255.255.255", status: "up", alias: "Hub overlay" },
    ]);
    const interfaces = buildFortiInterfaceSamples({ wan1: { link: true, ip: "203.0.113.2" } }, cmdb);
    backfillFortiCmdbOnlyTunnels(interfaces, cmdb);
    const t = interfaces.find((r) => r.ifName === "ADVPN")!;
    expect(t).toMatchObject({
      ifType: "tunnel", ipAddress: "10.255.0.1", adminStatus: "up", alias: "Hub overlay",
      // No runtime state in the CMDB — the SA status belongs to the IPsec stream.
      operStatus: null, macAddress: null, inOctets: null, ifParent: null,
    });
    expect(interfaces.filter((r) => r.ifName === "wan1")).toHaveLength(1);
  });

  it("leaves a tunnel the monitor did report alone, and ignores non-tunnel CMDB-only rows", () => {
    const cmdb = parseFortiCmdbInterfaceTable([
      { name: "vpn1", type: "tunnel", ip: "10.9.9.9 255.255.255.255" },
      { name: "port9", type: "physical", ip: "10.1.1.1 255.255.255.0" },
    ]);
    const interfaces = buildFortiInterfaceSamples({ vpn1: { link: true, ip: "10.9.9.1" } }, cmdb);
    backfillFortiCmdbOnlyTunnels(interfaces, cmdb);
    expect(interfaces).toHaveLength(1);
    expect(interfaces[0]).toMatchObject({ ifName: "vpn1", ipAddress: "10.9.9.1", operStatus: "up" });
  });
});
