/**
 * tests/unit/fortiosInterfaceCmdbFormat.test.ts
 *
 * FORTIOS_INTERFACE_CMDB_FORMAT is the `format=` filter every Polaris read of
 * FortiOS REST `/api/v2/cmdb/system/interface` sends. A field a reader needs
 * and the list lacks is not an error — FortiOS simply leaves it out — so the
 * contract is pinned here: every reader gives the SAME answer on a full row as
 * on that row cut down to the listed attributes (what `format=` returns).
 *
 * The rows are shaped after real lab responses (HUB1-a 7.6.8, 2026-11-04),
 * padded with attributes no reader uses, the way a real row carries ~228.
 * When a reader starts using a new attribute, add it to a fixture row here AND
 * to the format list; this test then proves the list carries it.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FORTIOS_INTERFACE_CMDB_FORMAT, fortiosVlanParentOf } from "../../src/utils/fortiosInterfaceRef.js";
import { fortiosSecondaryIpStrings } from "../../src/utils/fortiosSecondaryIp.js";
import { parseInterfaceIpv6 } from "../../src/utils/fortiosIpv6.js";
import { parseFortiCmdbInterfaceTable, fortilinkInterfaceNamesFromCmdb } from "../../src/services/monitoringService.js";

const NOISE = { mtu: 1500, "mtu-override": "disable", speed: "auto", allowaccess: "ping https", "dhcp-relay-service": "disable",
  vdom: "root", role: "lan", "device-identification": "enable", estimated_upstream_bandwidth: 0, q_origin_key: "x" };

const FULL_ROWS: Record<string, unknown>[] = [
  { ...NOISE, name: "BGP", type: "loopback", ip: "10.255.0.1 255.255.255.255", macaddr: "00:00:00:00:00:00", status: "up",
    mode: "static", alias: "bgp-lo", description: "router id", "secondary-IP": "enable",
    secondaryip: [
      { id: 1, q_origin_key: 1, ip: "99.1.1.1 255.255.255.255", allowaccess: "", gwdetect: "disable" },
      { id: 2, q_origin_key: 2, ip: "192.168.250.1 255.255.255.0", allowaccess: "", gwdetect: "disable" },
    ],
    ipv6: { "ip6-mode": "static", "ip6-address": "fd4c:7a91:3e20:10::1/64", "ip6-allowaccess": "ping", "ip6-send-adv": "enable",
      "ip6-extra-addr": [{ prefix: "fd4c:7a91:3e20:11::1/64", q_origin_key: "fd4c:7a91:3e20:11::1/64" }],
      "ip6-prefix-list": [{ prefix: "fd4c:7a91:3e20:10::/64", "autonomous-flag": "enable", "onlink-flag": "enable" }] } },
  { ...NOISE, name: "RGIUsers", type: "vlan", interface: "fortilink", vlanid: 30, ip: "10.30.0.1 255.255.255.0",
    macaddr: "04:d5:90:aa:bb:01", status: "up", mode: "static", "secondary-IP": "disable", secondaryip: [] },
  { ...NOISE, name: "fortilink", type: "aggregate", fortilink: "enable", ip: "10.255.1.1 255.255.255.0", macaddr: "04:d5:90:aa:bb:02",
    "switch-controller-mgmt-vlan": 4094, status: "up", mode: "static",
    member: [{ "interface-name": "a", q_origin_key: "a" }, { "interface-name": "b", q_origin_key: "b" }] },
  { ...NOISE, name: "Overlay-1", type: "tunnel", interface: "wan1", ip: "10.10.1.1 255.255.255.255", status: "up", mode: "static" },
  { ...NOISE, name: "wan1", type: "physical", ip: "0.0.0.0 0.0.0.0", mode: "dhcp", status: "down", macaddr: "04:d5:90:aa:bb:03" },
];

const KEEP = FORTIOS_INTERFACE_CMDB_FORMAT.split("|");
/** What FortiOS returns for a row under `format=`: the listed attributes (plus q_origin_key). */
const trimRow = (r: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => KEEP.includes(k) || k === "q_origin_key"));
const TRIMMED = FULL_ROWS.map(trimRow);

describe("FORTIOS_INTERFACE_CMDB_FORMAT carries everything the interface readers use", () => {
  it("monitoring's interface table parses identically", () => {
    expect(parseFortiCmdbInterfaceTable({ results: TRIMMED })).toEqual(parseFortiCmdbInterfaceTable({ results: FULL_ROWS }));
    // …and it actually read something, so the equality is not two empty maps.
    expect(parseFortiCmdbInterfaceTable({ results: FULL_ROWS }).get("BGP")?.secondaryIps).toEqual(["99.1.1.1", "192.168.250.1"]);
  });

  it("monitoring's FortiLink interface set is identical", () => {
    const full = fortilinkInterfaceNamesFromCmdb({ results: FULL_ROWS });
    expect(fortilinkInterfaceNamesFromCmdb({ results: TRIMMED })).toEqual(full);
    expect([...full].sort()).toEqual(["a", "b", "fortilink"]);
  });

  it("discovery's per-row readers agree on every row", () => {
    FULL_ROWS.forEach((full, i) => {
      const trimmed = TRIMMED[i];
      for (const k of ["name", "ip", "macaddr", "vlanid", "switch-controller-mgmt-vlan"]) expect(trimmed[k], `${full.name}.${k}`).toEqual(full[k]);
      expect(fortiosVlanParentOf(trimmed)).toBe(fortiosVlanParentOf(full));
      expect(fortiosSecondaryIpStrings(trimmed)).toEqual(fortiosSecondaryIpStrings(full));
      expect(parseInterfaceIpv6(trimmed)).toEqual(parseInterfaceIpv6(full));
    });
    expect(parseInterfaceIpv6(FULL_ROWS[0]).addresses.length).toBeGreaterThan(1);
  });

  it("names the secondary TABLE key, not only the flag", () => {
    expect(KEEP).toContain("secondaryip");
  });

  it("FortiManager's device-DB interface read asks for the `secondaryip` table, not the dead `secondary-ip` key", () => {
    // Prod FMG answers the table as `secondaryip` and the flag as `secondary-IP`;
    // `secondary-ip` is not a key it has, so a fields list naming only it drops every secondary.
    const src = readFileSync(join(process.cwd(), "src", "services", "fortimanagerService.ts"), "utf-8");
    const read = src.match(/url: `\/pm\/config\/device\/\$\{deviceName\}\/vdom\/root\/system\/interface`, fields: \[[^\]]*\]/);
    expect(read).not.toBeNull();
    expect(read![0]).toContain('"secondaryip"');
    expect(read![0]).not.toContain('"secondary-ip"');
  });

  it("is passed by every reader of the endpoint", () => {
    const read = (p: string) => readFileSync(join(process.cwd(), "src", "services", p), "utf-8");
    for (const [file, expected] of [["fortigateService.ts", 1], ["monitoringService.ts", 2]] as const) {
      const src = read(file);
      const calls = src.match(/fgRequest<[^>]*>\([^)]*"GET", "\/api\/v2\/cmdb\/system\/interface"[^\n]*(\n[^\n]*){0,3}/g) ?? [];
      expect(calls.length, file).toBe(expected);
      for (const c of calls) expect(c, file).toContain("FORTIOS_INTERFACE_CMDB_FORMAT");
    }
  });
});
