/**
 * tests/unit/fortiosIpsec.test.ts — utils/fortiosIpsec.ts against the shapes
 * the lab ADVPN mesh answers (HUB1-a on FortiOS 7.6.7, SPK1 on 8.0.1,
 * trimmed to the fields the parser reads). The remote-access and SSL-VPN
 * fixtures are built from the documented field names: the lab has no
 * FortiClient user to capture.
 */

import { describe, it, expect } from "vitest";
import { parseFortiosIpsec, parseFortiosSslVpn, parsePhase1Cmdb, classifyIpsecChild } from "../../src/utils/fortiosIpsec.js";

const p2 = (status: string, inB: number, outB: number) => ({ status, incoming_bytes: inB, outgoing_bytes: outB, p2name: "x" });

const HUB_CMDB = {
  results: [
    { name: "H2H-1", type: "static", interface: "wan1", "remote-gw": "10.2.1.2", "auto-discovery-sender": "disable", "auto-discovery-receiver": "disable", xauthtype: "disable", eap: "disable", "wizard-type": "custom" },
    { name: "Overlay-1", type: "dynamic", interface: "wan1", "remote-gw": "0.0.0.0", "auto-discovery-sender": "enable", "auto-discovery-receiver": "disable", xauthtype: "disable", eap: "disable", "wizard-type": "custom" },
    { name: "Overlay-3", type: "dynamic", interface: "wan2", "remote-gw": "0.0.0.0", "auto-discovery-sender": "enable", "auto-discovery-receiver": "disable", xauthtype: "disable", eap: "disable", "wizard-type": "custom" },
  ],
};

const HUB_MONITOR = {
  results: [
    { name: "H2H-1", type: "automatic", proxyid: [p2("up", 1578444, 1132676)], username: "HUB2-ISP1", rgwy: "10.2.1.2", tun_id: "10.2.1.2", creation_time: 1590271, incoming_bytes: 1303637872, outgoing_bytes: 818545265 },
    { name: "Overlay-1_0", parent: "Overlay-1", type: "dialup", proxyid: [p2("up", 17169980, 8769481)], username: "10.4.1.2", rgwy: "10.4.1.2", tun_id: "10.254.250.14", creation_time: 286642, incoming_bytes: 165206348, outgoing_bytes: 84519982 },
    { name: "Overlay-1_1", parent: "Overlay-1", type: "dialup", proxyid: [p2("up", 7944108, 4418450)], username: "SPK1-ISP1", rgwy: "10.3.1.2", tun_id: "10.254.250.13", creation_time: 287092, incoming_bytes: 76818446, outgoing_bytes: 42735602 },
    { name: "Overlay-1", type: "", proxyid: [], rgwy: "0.0.0.0", tun_id: "10.0.0.1", incoming_bytes: 1386297620, outgoing_bytes: 709920777 },
    { name: "Overlay-3", type: "", proxyid: [], rgwy: "0.0.0.0", tun_id: "10.0.0.2" },
    { name: "Overlay-3_0", parent: "Overlay-3", type: "dialup", proxyid: [p2("up", 1, 2)], username: "10.4.2.2", rgwy: "10.4.2.2", tun_id: "10.0.0.6", creation_time: 286641 },
  ],
};

describe("parseFortiosIpsec — ADVPN hub", () => {
  const { tunnels, connections } = parseFortiosIpsec(HUB_CMDB, HUB_MONITOR);

  it("keeps the tunnel rows exactly as before: children never become tunnels", () => {
    expect(tunnels.map((t) => t.tunnelName).sort()).toEqual(["H2H-1", "Overlay-1", "Overlay-3"]);
    const ov = tunnels.find((t) => t.tunnelName === "Overlay-1")!;
    expect(ov.status).toBe("dynamic");
    expect(ov.parentInterface).toBe("wan1");
    const h2h = tunnels.find((t) => t.tunnelName === "H2H-1")!;
    expect(h2h).toMatchObject({ status: "up", remoteGateway: "10.2.1.2", incomingBytes: 1578444, outgoingBytes: 1132676, proxyIdCount: 1 });
  });

  it("lists each connected spoke as an advpn-spoke connection under its template", () => {
    expect(connections.map((c) => c.name)).toEqual(["Overlay-1_0", "Overlay-1_1", "Overlay-3_0"]);
    const spk1 = connections.find((c) => c.name === "Overlay-1_1")!;
    expect(spk1).toMatchObject({
      kind: "advpn-spoke", parentTunnel: "Overlay-1", peerId: "SPK1-ISP1",
      remoteGateway: "10.3.1.2", tunnelIp: "10.254.250.13", status: "up",
      // phase-1 totals, not the phase-2 sum
      incomingBytes: 76818446, outgoingBytes: 42735602, uptimeSec: 287092,
      userName: null,
    });
  });

  it("drops a peer ID that is only the echoed address (no localid sent)", () => {
    const c = connections.find((x) => x.name === "Overlay-1_0")!;
    expect(c.peerId).toBeNull();
    expect(c.remoteGateway).toBe("10.4.1.2");
  });

  it("falls back to the phase-2 byte sum when the child has no phase-1 totals", () => {
    const c = connections.find((x) => x.name === "Overlay-3_0")!;
    expect(c.incomingBytes).toBe(1);
    expect(c.outgoingBytes).toBe(2);
  });
});

describe("parseFortiosIpsec — ADVPN spoke", () => {
  const cmdb = { results: [
    { name: "Overlay-1", type: "static", interface: "wan1", "remote-gw": "10.1.1.2", "auto-discovery-receiver": "enable", "net-device": "enable" },
  ] };
  it("reports a shortcut under its static tunnel as advpn-shortcut", () => {
    const { tunnels, connections } = parseFortiosIpsec(cmdb, { results: [
      { name: "Overlay-1", type: "automatic", proxyid: [p2("up", 5, 6)], username: "HUB1-ISP1", rgwy: "10.1.1.2" },
      { name: "Overlay-1_0", parent: "Overlay-1", type: "automatic", proxyid: [p2("up", 5, 6)], username: "SPK2-ISP1", rgwy: "10.4.1.2", tun_id: "10.254.250.14", creation_time: 30 },
    ] });
    expect(tunnels).toHaveLength(1);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ kind: "advpn-shortcut", parentTunnel: "Overlay-1", peerId: "SPK2-ISP1", uptimeSec: 30 });
  });

  it("returns no connections on a quiet spoke", () => {
    const { connections } = parseFortiosIpsec(cmdb, { results: [
      { name: "Overlay-1", type: "automatic", proxyid: [p2("up", 5, 6)], username: "HUB1-ISP1", rgwy: "10.1.1.2" },
    ] });
    expect(connections).toEqual([]);
  });
});

describe("an EAP FortiClient user (field shape from a prod 7.6 gate; values synthetic)", () => {
  const RA_CMDB = { results: [{ name: "IPsecRA_VPN", type: "dynamic", interface: "wan1", eap: "disable", xauthtype: "disable" }] };
  const child = {
    name: "IPsecRA_VPN_0", parent: "IPsecRA_VPN", type: "dialup", "wizard-type": "custom",
    proxyid: [{ status: "up", p2name: "IPsecRA_VPN", incoming_bytes: 52, outgoing_bytes: 84 }],
    connection_count: 1, creation_time: 13712,
    username: "192.168.50.10",            // the client's own LAN address behind NAT
    user: "jdoe@example.com", auth_type: "eap", user_two_factor_auth: false, fct_uid: "0000AAAA",
    incoming_bytes: 8200, outgoing_bytes: 6900,
    rgwy: "203.0.113.7", tun_id: "10.255.8.1", rport: 59447, dialup_index: 0,
  };

  it("reads the user from `user`, not `username`", () => {
    const [c] = parseFortiosIpsec(RA_CMDB, { results: [child] }).connections;
    expect(c).toMatchObject({
      kind: "remote-access", userName: "jdoe@example.com", peerId: null,
      remoteGateway: "203.0.113.7", tunnelIp: "10.255.8.1", uptimeSec: 13712,
      incomingBytes: 8200, outgoingBytes: 6900,
    });
  });

  it("is remote access by its auth_type even with the user missing and EAP not visible in the CMDB", () => {
    const { user: _u, ...noUser } = child;
    const [c] = parseFortiosIpsec(RA_CMDB, { results: [noUser] }).connections;
    expect(c.kind).toBe("remote-access");
    expect(c.userName).toBeNull();
  });

  it("never treats an address in `username` as an identity", () => {
    const [c] = parseFortiosIpsec(HUB_CMDB, { results: [
      { name: "Overlay-1_5", parent: "Overlay-1", proxyid: [], username: "2001:db8::5", rgwy: "198.51.100.1" },
    ] }).connections;
    expect(c.peerId).toBeNull();
  });
});

describe("remote-access classification", () => {
  it("a child carrying an xauth user is remote-access whatever the template says", () => {
    const { connections } = parseFortiosIpsec(HUB_CMDB, { results: [
      { name: "Overlay-1_9", parent: "Overlay-1", proxyid: [], rgwy: "203.0.113.7", tun_id: "10.212.134.200", xauth_user: "jdoe" },
    ] });
    expect(connections[0]).toMatchObject({ kind: "remote-access", userName: "jdoe", tunnelIp: "10.212.134.200", remoteGateway: "203.0.113.7", status: "up" });
  });

  it("an EAP / xauth / FortiClient-wizard template makes its children remote-access", () => {
    const map = parsePhase1Cmdb({ results: [
      { name: "FCT-EAP", type: "dynamic", eap: "enable" },
      { name: "FCT-XAUTH", type: "dynamic", xauthtype: "auto" },
      { name: "FCT-WIZ", type: "dynamic", "wizard-type": "dialup-forticlient" },
      { name: "SITE", type: "dynamic" },
    ] });
    expect(classifyIpsecChild({}, map.get("FCT-EAP")!)).toBe("remote-access");
    expect(classifyIpsecChild({}, map.get("FCT-XAUTH")!)).toBe("remote-access");
    expect(classifyIpsecChild({}, map.get("FCT-WIZ")!)).toBe("remote-access");
    expect(classifyIpsecChild({}, map.get("SITE")!)).toBe("dialup-peer");
  });

  it("without the CMDB (token lacking cmdb scope) a hub child is a dialup-peer", () => {
    const { connections } = parseFortiosIpsec(null, { results: [
      { name: "Overlay-1_0", parent: "Overlay-1", type: "dialup", proxyid: [], rgwy: "10.3.1.2" },
    ] });
    expect(connections[0].kind).toBe("dialup-peer");
  });
});

describe("parseFortiosIpsec — status + edge cases", () => {
  it("rolls a child's mixed phase-2 selectors to partial, all-down to down", () => {
    const { connections } = parseFortiosIpsec(HUB_CMDB, { results: [
      { name: "Overlay-1_0", parent: "Overlay-1", proxyid: [p2("up", 1, 1), p2("down", 0, 0)] },
      { name: "Overlay-1_1", parent: "Overlay-1", proxyid: [p2("down", 0, 0)] },
    ] });
    expect(connections.map((c) => c.status)).toEqual(["partial", "down"]);
  });

  it("dedupes a repeated child name", () => {
    const row = { name: "Overlay-1_0", parent: "Overlay-1", proxyid: [] };
    expect(parseFortiosIpsec(HUB_CMDB, { results: [row, row] }).connections).toHaveLength(1);
  });

  it("still synthesizes configured-but-silent phase-1 tunnels", () => {
    const { tunnels } = parseFortiosIpsec(HUB_CMDB, { results: [] });
    expect(tunnels.map((t) => [t.tunnelName, t.status])).toEqual([
      ["H2H-1", "down"], ["Overlay-1", "dynamic"], ["Overlay-3", "dynamic"],
    ]);
  });
});

describe("parseFortiosSslVpn", () => {
  it("reads the session list the 7.6.7 lab answers (empty)", () => {
    expect(parseFortiosSslVpn({ results: [], status: "success" })).toEqual([]);
  });

  it("maps a tunnel-mode session: user, remote host, assigned IP, summed bytes", () => {
    const rows = parseFortiosSslVpn({ results: [{
      index: 3, user_name: "asmith", remote_host: "198.51.100.20", duration: 600,
      subsessions: [{ mode: "Tunnel", aip: "10.212.134.201", in_bytes: 100, out_bytes: 50 }, { mode: "Web", in_bytes: 1, out_bytes: 2 }],
    }] });
    expect(rows).toEqual([{
      name: "ssl:3", kind: "ssl-vpn", parentTunnel: null, peerId: null, userName: "asmith",
      remoteGateway: "198.51.100.20", tunnelIp: "10.212.134.201", status: "up",
      incomingBytes: 101, outgoingBytes: 52, uptimeSec: 600,
    }]);
  });
});
