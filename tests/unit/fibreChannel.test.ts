/**
 * tests/unit/fibreChannel.test.ts
 *
 * Business rule 156 — the pure half (utils/fibreChannel.ts). The walk shapes
 * are a Cisco MDS 9148S's (2026-11-11), with synthetic WWNs:
 *
 *   fcIfNxPortName   …289.1.1.5.1.3.<ifIndex>.<vsan>.<loginIndex> = 8 bytes
 *   NS port name     …293.1.1.4.1.2.<vsan>.<d>.<a>.<p>            = 8 bytes
 *   NS symbolic      …293.1.1.4.1.13.<vsan>.<d>.<a>.<p>           = text
 *   FDMI host name   …373.1.2.2.1.7.<vsan>.<hba id 8>.<port wwn 8> = text
 *
 * Pinned: WWNs render as colon hex; rows join on the PORT WWN; FDMI beats
 * the symbolic HN:; a domain-only or empty host name names nothing; a host
 * matches only one asset, a FQDN never meets a different domain, and two
 * candidates is no match (rule 91).
 */

import { describe, it, expect } from "vitest";
import {
  wwnFromBytes,
  fcidFromParts,
  parseSymbolicNodeName,
  hostNameOrNull,
  buildFcInventory,
  pickHostMatch,
  hostLookupNames,
  type FcWalks,
} from "../../src/utils/fibreChannel.js";

const HOST_WWN = [0x10, 0x00, 0xaa, 0xbb, 0xcc, 0x00, 0x00, 0x01];
const ESX_WWN  = [0x10, 0x00, 0xaa, 0xbb, 0xcc, 0x00, 0x00, 0x02];
const PURE_WWN = [0x52, 0x4a, 0x93, 0x00, 0x00, 0x00, 0x30, 0x09];

function walks(over: Partial<FcWalks> = {}): FcWalks {
  return {
    errors: new Map([
      ["linkFailures", new Map<string, number | null>([["16777216", 34], ["16781312", 0], ["16785408", 0]])],
      ["invalidTxWords", new Map<string, number | null>([["16777216", 2296299291], ["16781312", 0], ["16785408", 0]])],
    ]),
    loginPortWwn: new Map([
      ["16777216.101.12525568", HOST_WWN],
      ["16781312.101.12525824", ESX_WWN],
      ["16805888.101.12519424", PURE_WWN],
    ]),
    loginNodeWwn: new Map([["16777216.101.12525568", [0x20, 0, 0xaa, 0xbb, 0xcc, 0, 0, 1]]]),
    nsPortWwn: new Map([
      ["101.191.31.0", HOST_WWN],
      ["101.191.32.0", ESX_WWN],
      ["101.191.8.0", PURE_WWN],
    ]),
    nsSymbolic: new Map([
      ["101.191.31.0", "Emulex SN1200E2P FV14.2.589.5 DV14.0.0.21 HN:lnx01.example.com OS:Linux"],
      ["101.191.32.0", "Emulex SN1610E2P FV14.4.473.14 DV14.4.0.47 HN:OS:VMware ESXi 8.0.3"],
      ["101.191.8.0", ""],
    ]),
    fdmiHostName: new Map([
      [["101", ...ESX_WWN, ...ESX_WWN].join("."), "esx07"],
      [["101", ...PURE_WWN, ...PURE_WWN].join("."), "PURE01-ct0"],
    ]),
    ...over,
  };
}

const IFNAMES = new Map([["16777216", "fc1/1"], ["16781312", "fc1/2"], ["16805888", "fc1/8"]]);

describe("wwnFromBytes / fcidFromParts", () => {
  it("renders 8 bytes as lower-case colon hex and refuses anything else", () => {
    expect(wwnFromBytes([0x10, 0x00, 0x5c, 0xba, 0x2c, 0xff, 0xac, 0x5a])).toBe("10:00:5c:ba:2c:ff:ac:5a");
    expect(wwnFromBytes([1, 2, 3])).toBeNull();
    expect(wwnFromBytes([0, 0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(wwnFromBytes(null)).toBeNull();
  });

  it("renders an FC address", () => {
    expect(fcidFromParts(191, 31, 0)).toBe("0xbf1f00");
    expect(fcidFromParts(256, 0, 0)).toBeNull();
  });
});

describe("parseSymbolicNodeName", () => {
  it("reads Emulex's layout, including an empty HN:", () => {
    expect(parseSymbolicNodeName("Emulex SN1200E2P FV14.2.589.5 DV14.0.0.21 HN:lnx01.example.com OS:Linux")).toEqual({
      hbaModel: "Emulex SN1200E2P", hbaFirmware: "14.2.589.5", hbaDriver: "14.0.0.21",
      hostName: "lnx01.example.com", osInfo: "Linux",
    });
    const esx = parseSymbolicNodeName("Emulex SN1610E2P FV14.4.473.14 DV14.4.0.47 HN:OS:VMware ESXi 8.0.3");
    expect(esx.hostName).toBeUndefined();
    expect(esx.osInfo).toBe("VMware ESXi 8.0.3");
  });

  it("reads nothing from another vendor's string", () => {
    expect(parseSymbolicNodeName("QLE2742 FW:v8.08.05 DVR:v10.01.00")).toEqual({});
    expect(parseSymbolicNodeName("")).toEqual({});
  });
});

describe("hostNameOrNull", () => {
  it("refuses an empty, domain-only or spaced name", () => {
    expect(hostNameOrNull(".example.com")).toBeNull();
    expect(hostNameOrNull("  ")).toBeNull();
    expect(hostNameOrNull("two words")).toBeNull();
    expect(hostNameOrNull("esx07")).toBe("esx07");
  });
});

describe("buildFcInventory", () => {
  it("joins logins, name server and FDMI on the port WWN", () => {
    const { ports, logins } = buildFcInventory(walks(), IFNAMES);
    // Every port the error table answered; one IF-MIB did not name stays null.
    expect(ports.map((p) => p.ifName)).toEqual(["fc1/1", "fc1/2", null]);
    expect(ports[0].errorCounters.invalidTxWords).toBe(2296299291);
    expect(ports[0].errorCounters.syncLosses).toBeNull();

    const byPort = Object.fromEntries(logins.map((l) => [l.ifName, l]));
    expect(byPort["fc1/1"]).toMatchObject({
      vsan: 101, portWwn: "10:00:aa:bb:cc:00:00:01", nodeWwn: "20:00:aa:bb:cc:00:00:01",
      fcid: "0xbf1f00", hostName: "lnx01.example.com", hbaModel: "Emulex SN1200E2P", osInfo: "Linux",
    });
    // ESXi registers no HN:, but FDMI names it.
    expect(byPort["fc1/2"].hostName).toBe("esx07");
    // The array registers only through FDMI, and no symbolic name.
    expect(byPort["fc1/8"]).toMatchObject({ hostName: "PURE01-ct0", symbolicName: null, fcid: "0xbf0800" });
  });

  it("drops a login whose WWN is unreadable", () => {
    const w = walks({ loginPortWwn: new Map([["16777216.101.1", null]]) });
    expect(buildFcInventory(w, IFNAMES).logins).toEqual([]);
  });
});

describe("pickHostMatch", () => {
  const assets = [
    { id: "a", hostname: "lnx01.example.com", dnsName: null },
    { id: "b", hostname: "esx07", dnsName: "esx07.example.com" },
    { id: "c", hostname: "dup", dnsName: null },
    { id: "d", hostname: "DUP", dnsName: null },
    { id: "e", hostname: "web01.other.com", dnsName: null },
  ];

  it("matches an exact name, either column, any case", () => {
    expect(pickHostMatch("LNX01.example.com", assets)).toBe("a");
    expect(pickHostMatch("esx07.example.com", assets)).toBe("b");
  });

  it("matches a short name to an asset's short name or FQDN", () => {
    expect(pickHostMatch("lnx01", assets)).toBe("a");
    expect(pickHostMatch("esx07", assets)).toBe("b");
  });

  it("never matches a FQDN against a different domain", () => {
    expect(pickHostMatch("web01.example.com", assets)).toBeNull();
  });

  it("is no match when two assets answer (rule 91), or for the switch itself", () => {
    expect(pickHostMatch("dup", assets)).toBeNull();
    expect(pickHostMatch("esx07", assets, "b")).toBeNull();
    expect(pickHostMatch(null, assets)).toBeNull();
  });
});

describe("hostLookupNames", () => {
  it("collects each name and its short form, once", () => {
    expect(hostLookupNames(["lnx01.example.com", "LNX01.example.com", "esx07", null, ".example.com"])).toEqual({
      exact: ["lnx01.example.com", "esx07"],
      shorts: ["lnx01", "esx07"],
    });
  });
});
