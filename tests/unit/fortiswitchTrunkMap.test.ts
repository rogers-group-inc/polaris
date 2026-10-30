import { describe, it, expect } from "vitest";
import {
  matchTrunkPeer,
  parseTrunkPortMap,
  stripTrunkRoleSuffix,
  trunkMemberMap,
  trunkPeerNameTail,
} from "../../src/utils/fortiswitchTrunkMap.js";

// Verbatim from a FortiSwitch-124E-FPOE running v7.6.6.
const REAL = "8EF5920000001-0: port23 ::8EPTQ21000003-0: port27 ::GT61FTK21000002: port24 ::";

// A 48-port access switch, same firmware family. Shape-identical to a real
// prod walk (names changed): operator-configured LAGs sit in the SAME string
// as the auto-created FortiLink trunks, so a trunk name carries spaces, an
// underscore-wrapped internal name, or a plain hostname just as often as it
// carries a peer serial. This is the string the OID fix made reachable — the
// scalar had been read one level too deep (…106.3.1.1.0), which answers
// noSuchObject, so no switch ever produced a member edge from SNMP.
const REAL_LAGS = [
  "_FlInK1_ICL0_: port51 ",
  "::EDGE2-T1024E: port54 ",
  "::Storage Node 2: port2 ",
  "::APPHOST01: port9 ",
  "::G181FTK20900967: port49 ::",
].join("");

// The same site's inventory, as Polaris stores it.
const SERIALS = new Map<string, string>([
  ["S108EPTQ21000003", "asset-108e-1"],
  ["S108EF5920000001", "asset-108e-2"],
  ["S124EFTQ22000001", "asset-124e-1"],
  ["FGT61FTK21000002", "asset-fortigate"],
]);

describe("parseTrunkPortMap", () => {
  it("parses the real device string", () => {
    expect(parseTrunkPortMap(REAL)).toEqual([
      { trunkName: "8EF5920000001-0", localPort: "port23", peerSerialTail: "8EF5920000001" },
      { trunkName: "8EPTQ21000003-0", localPort: "port27", peerSerialTail: "8EPTQ21000003" },
      { trunkName: "GT61FTK21000002", localPort: "port24", peerSerialTail: "GT61FTK21000002" },
    ]);
  });

  // A FortiGate trunk carries no -N suffix, so the tail is the whole name.
  it("leaves a suffix-less trunk name intact", () => {
    const [e] = parseTrunkPortMap("GT61FTK21000002: port24 ::");
    expect(e.peerSerialTail).toBe("GT61FTK21000002");
  });

  // Only -0 has been seen in the field; the pattern is general so a future
  // member index cannot silently break matching.
  it("strips any trailing member index, not just -0", () => {
    expect(parseTrunkPortMap("ABC123-1: port5 ::")[0].peerSerialTail).toBe("ABC123");
    expect(parseTrunkPortMap("ABC123-12: port5 ::")[0].peerSerialTail).toBe("ABC123");
  });

  it("returns nothing for an empty or absent string", () => {
    expect(parseTrunkPortMap("")).toEqual([]);
    expect(parseTrunkPortMap(null)).toEqual([]);
    expect(parseTrunkPortMap("   ")).toEqual([]);
  });

  // Undocumented vendor string: survive it, don't trust it.
  it("skips malformed chunks instead of failing the scrape", () => {
    const out = parseTrunkPortMap("GOOD-0: port1 ::garbage-no-colon:: :: BAD-0:  ::GOOD2-0: port2");
    expect(out.map((e) => e.localPort)).toEqual(["port1", "port2"]);
  });

  it("deduplicates repeated pairs", () => {
    expect(parseTrunkPortMap("A-0: port1 ::A-0: port1 ::")).toHaveLength(1);
  });
});

describe("matchTrunkPeer", () => {
  // The 15-char left-truncation means the stored serial is LONGER than the
  // trunk name, so the match has to be a suffix test rather than equality.
  it("resolves each real trunk to the right device", () => {
    const entries = parseTrunkPortMap(REAL);
    expect(matchTrunkPeer(entries[0].peerSerialTail, SERIALS)).toBe("asset-108e-2");
    expect(matchTrunkPeer(entries[1].peerSerialTail, SERIALS)).toBe("asset-108e-1");
    expect(matchTrunkPeer(entries[2].peerSerialTail, SERIALS)).toBe("asset-fortigate");
  });

  it("is case-insensitive", () => {
    expect(matchTrunkPeer("8ef5920000001", SERIALS)).toBe("asset-108e-2");
  });

  it("returns null when no serial ends with the tail", () => {
    expect(matchTrunkPeer("NOSUCHSERIAL", SERIALS)).toBeNull();
    expect(matchTrunkPeer("", SERIALS)).toBeNull();
  });

  // The guard that matters. Attaching a trunk to the wrong device would draw
  // the wrong edge on the map and, if it ever gated alerting, silence the
  // wrong port — so an ambiguous tail resolves to nothing.
  it("refuses an ambiguous tail rather than picking one", () => {
    const ambiguous = new Map<string, string>([
      ["S108EF5920000001", "asset-a"],
      ["S999EF5920000001", "asset-b"],
    ]);
    expect(matchTrunkPeer("8350", ambiguous)).toBeNull();
    expect(matchTrunkPeer("EF5920008350", ambiguous)).toBeNull();
  });

  it("is not confused by the same asset appearing under two serials", () => {
    const dual = new Map<string, string>([
      ["S108EF5920000001", "asset-a"],
      ["ALTF5920008350", "asset-a"],
    ]);
    expect(matchTrunkPeer("F5920008350", dual)).toBe("asset-a");
  });
});

describe("trunkPeerNameTail", () => {
  // The two shapes the ifTable actually publishes: switch peer with -0,
  // FortiGate peer bare.
  it("extracts the tail from real trunk interface names", () => {
    expect(trunkPeerNameTail("8EF5920000001-0")).toBe("8EF5920000001");
    expect(trunkPeerNameTail("GT61FTK21000002")).toBe("GT61FTK21000002");
    expect(trunkPeerNameTail("  8EPTQ21000003-0 ")).toBe("8EPTQ21000003");
  });

  // Ordinary port names must never trigger the peer lookup: the shape test is
  // what keeps the preservation pass off the hot path for every normal scrape.
  it("rejects ordinary interface names", () => {
    expect(trunkPeerNameTail("port23")).toBeNull();
    expect(trunkPeerNameTail("lan1")).toBeNull();
    expect(trunkPeerNameTail("internal")).toBeNull();
    expect(trunkPeerNameTail("Ethernet 2")).toBeNull();       // whitespace
    expect(trunkPeerNameTail("aggregate.uplink1")).toBeNull(); // punctuation
    expect(trunkPeerNameTail("fortilink")).toBeNull();         // too short
    expect(trunkPeerNameTail("")).toBeNull();
    expect(trunkPeerNameTail(null)).toBeNull();
    expect(trunkPeerNameTail(undefined)).toBeNull();
  });

  it("strips any member index, not just -0", () => {
    expect(trunkPeerNameTail("8EF5920000001-12")).toBe("8EF5920000001");
  });

  // A short tail would suffix-match too easily; the floor refuses it.
  it("rejects a tail below the minimum length even with a member suffix", () => {
    expect(trunkPeerNameTail("ABC123-0")).toBeNull();
  });
});

describe("trunkMemberMap", () => {
  it("groups the real device string into one entry per trunk", () => {
    expect([...trunkMemberMap(parseTrunkPortMap(REAL))]).toEqual([
      ["8EF5920000001-0", ["port23"]],
      ["8EPTQ21000003-0", ["port27"]],
      ["GT61FTK21000002", ["port24"]],
    ]);
  });

  // A two-link trunk arrives as two pairs sharing a name; the overlay wants
  // one trunk with two members, not two trunks with one each.
  it("collects every member of a multi-link trunk under one name", () => {
    const entries = parseTrunkPortMap("8EF5920000001-0: port23 ::8EF5920000001-0: port24 ::");
    expect(entries).toHaveLength(2);
    expect([...trunkMemberMap(entries)]).toEqual([
      ["8EF5920000001-0", ["port23", "port24"]],
    ]);
  });

  it("preserves the order the device published members in", () => {
    const entries = parseTrunkPortMap("t1: port9 ::t1: port2 ::t1: port5 ::");
    expect(trunkMemberMap(entries).get("t1")).toEqual(["port9", "port2", "port5"]);
  });

  it("is empty for an empty read", () => {
    expect(trunkMemberMap([]).size).toBe(0);
    expect(trunkMemberMap(parseTrunkPortMap("")).size).toBe(0);
  });
});

// The operator-named half of the same string. These are member/parent edges
// like any other, but they are NOT peer identities, and the peer lookup has to
// tell the difference or it will attach a trunk to an unrelated device.
describe("operator-named LAGs in the same scalar", () => {
  it("parses names carrying spaces and underscores", () => {
    const map = trunkMemberMap(parseTrunkPortMap(REAL_LAGS));
    expect(map.get("Storage Node 2")).toEqual(["port2"]);
    expect(map.get("_FlInK1_ICL0_")).toEqual(["port51"]);
    expect(map.get("APPHOST01")).toEqual(["port9"]);
    expect(map.get("G181FTK20900967")).toEqual(["port49"]);
  });

  it("offers only the serial-shaped names to the peer lookup", () => {
    const serials = new Map<string, string>([["FG181FTK20900967", "asset-gate"]]);
    expect(matchTrunkPeer("G181FTK20900967", serials)).toBe("asset-gate");
    // A space or an underscore means it is a label, not a serial — and a short
    // alphanumeric one could suffix-match a real serial by accident.
    expect(matchTrunkPeer("Storage Node 2", serials)).toBeNull();
    expect(matchTrunkPeer("_FlInK1_ICL0_", serials)).toBeNull();
    expect(matchTrunkPeer("0967", serials)).toBeNull();
  });
});

// FS-248E ifTable: trunks carry a role suffix the trunk scalar does not.
describe("stripTrunkRoleSuffix", () => {
  it("removes a trailing parenthesised role", () => {
    expect(stripTrunkRoleSuffix("1CD11A4549B7-0(primary)")).toBe("1CD11A4549B7-0");
    expect(stripTrunkRoleSuffix("_FlInK1_ICL0_(primary)")).toBe("_FlInK1_ICL0_");
    expect(stripTrunkRoleSuffix("trunkA (secondary)")).toBe("trunkA");
  });

  it("leaves a name without one unchanged", () => {
    expect(stripTrunkRoleSuffix("1CD11A4549B7-0")).toBe("1CD11A4549B7-0");
    expect(stripTrunkRoleSuffix("port52")).toBe("port52");
    expect(stripTrunkRoleSuffix("Storage Node 2")).toBe("Storage Node 2");
    expect(stripTrunkRoleSuffix("lag(1)")).toBe("lag(1)"); // not a role word
  });
});
