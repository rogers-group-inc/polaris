/**
 * tests/unit/fortiswitchTrunks.test.ts
 *
 * Own suite for src/services/monitoring/fortiswitchTrunks.ts —
 * overlayFortiswitchTrunkMembers, which stamps a managed FortiSwitch trunk's
 * member ports onto the interface list (shared by the SNMP and FortiOS REST
 * collectors). The end-to-end feed from the CMDB parser is pinned in
 * fortiswitchTrunkMembers.test.ts; this file covers the function's own
 * contract and edges: in-place mutation, the return count, synthesis on/off,
 * type stamping, role-suffix renames and their children.
 */

import { describe, it, expect } from "vitest";
import { overlayFortiswitchTrunkMembers } from "../../src/services/monitoring/fortiswitchTrunks.js";
import type { InterfaceSample } from "../../src/services/monitoring/types.js";

function i(ifName: string, over: Partial<InterfaceSample> = {}): InterfaceSample {
  return { ifName, ...over };
}

function byName(list: InterfaceSample[]): Record<string, InterfaceSample> {
  return Object.fromEntries(list.map((x) => [x.ifName, x]));
}

describe("overlayFortiswitchTrunkMembers", () => {
  it("returns 0 and leaves the list untouched for an empty trunk map", () => {
    const list = [i("port1")];
    expect(overlayFortiswitchTrunkMembers(list, new Map())).toBe(0);
    expect(list).toEqual([i("port1")]);
  });

  it("skips a trunk with no members — the trunk row is not even retyped", () => {
    const list = [i("trunk1", { ifType: "physical" })];
    expect(overlayFortiswitchTrunkMembers(list, new Map([["trunk1", []]]))).toBe(0);
    expect(list[0].ifType).toBe("physical");
  });

  it("marks the trunk aggregate when its type is null, missing or guessed physical", () => {
    for (const ifType of [undefined, null, "physical"]) {
      const list = [i("T", { ifType }), i("port1")];
      overlayFortiswitchTrunkMembers(list, new Map([["T", ["port1"]]]));
      expect(list[0].ifType).toBe("aggregate");
    }
  });

  it("never clobbers another real type on the trunk row", () => {
    const list = [i("T", { ifType: "aggregate" }), i("T2", { ifType: "vlan" }), i("p1"), i("p2")];
    overlayFortiswitchTrunkMembers(list, new Map([["T", ["p1"]], ["T2", ["p2"]]]));
    expect(list[0].ifType).toBe("aggregate");
    expect(list[1].ifType).toBe("vlan");
  });

  it("stamps ifParent and a physical type on each existing member, in place, and counts the links", () => {
    const list = [i("T"), i("p1"), i("p2", { ifType: "physical" })];
    const n = overlayFortiswitchTrunkMembers(list, new Map([["T", ["p1", "p2"]]]));
    expect(n).toBe(2);
    expect(byName(list).p1).toMatchObject({ ifParent: "T", ifType: "physical" });
    expect(byName(list).p2).toMatchObject({ ifParent: "T", ifType: "physical" });
  });

  it("keeps a member's existing parent and type", () => {
    const list = [i("T"), i("p1", { ifParent: "OTHER", ifType: "aggregate" })];
    const n = overlayFortiswitchTrunkMembers(list, new Map([["T", ["p1"]]]));
    expect(byName(list).p1).toMatchObject({ ifParent: "OTHER", ifType: "aggregate" });
    // Counted although nothing was stamped — see the report (suspicious, not pinned).
    expect(n).toBe(1);
  });

  it("synthesizes a missing member by default, and only once when two trunks name it", () => {
    const list: InterfaceSample[] = [i("T")];
    const n = overlayFortiswitchTrunkMembers(list, new Map([["T", ["port52", "port52"]]]));
    expect(n).toBe(2);
    expect(list.filter((x) => x.ifName === "port52")).toEqual([{ ifName: "port52", ifType: "physical", ifParent: "T" }]);
  });

  it("synthesizes a member even when the trunk row itself is absent", () => {
    const list: InterfaceSample[] = [];
    overlayFortiswitchTrunkMembers(list, new Map([["T", ["p1"]]]));
    expect(list).toEqual([{ ifName: "p1", ifType: "physical", ifParent: "T" }]);
  });

  it("with synthesizeMissing:false, back-fills only and does not count unknown members", () => {
    const list = [i("T"), i("p1")];
    const n = overlayFortiswitchTrunkMembers(list, new Map([["T", ["p1", "ghost"]]]), { synthesizeMissing: false });
    expect(n).toBe(1);
    expect(list.map((x) => x.ifName)).toEqual(["T", "p1"]);
  });

  it("treats an explicit synthesizeMissing:true like the default", () => {
    const list: InterfaceSample[] = [];
    expect(overlayFortiswitchTrunkMembers(list, new Map([["T", ["p1"]]]), { synthesizeMissing: true })).toBe(1);
    expect(list).toHaveLength(1);
  });

  it("renames a role-suffixed trunk row, retypes it, and moves its children", () => {
    const list = [
      i("1CD11A4549B7-0 (primary)", { ifType: "physical" }),
      i("vlan10", { ifParent: "1CD11A4549B7-0 (primary)", ifType: "vlan" }),
      i("port52"),
    ];
    const n = overlayFortiswitchTrunkMembers(list, new Map([["1CD11A4549B7-0", ["port52"]]]));
    expect(n).toBe(1);
    expect(list[0]).toMatchObject({ ifName: "1CD11A4549B7-0", ifType: "aggregate" });
    expect(list[1].ifParent).toBe("1CD11A4549B7-0");
    expect(list[2].ifParent).toBe("1CD11A4549B7-0");
    expect(list).toHaveLength(3);
  });

  it("renames only the first of two suffixed rows sharing a base", () => {
    const list = [i("T(primary)"), i("T(secondary)"), i("p1")];
    overlayFortiswitchTrunkMembers(list, new Map([["T", ["p1"]]]));
    expect(list.map((x) => x.ifName)).toEqual(["T", "T(secondary)", "p1"]);
  });

  it("does not treat a parenthesised word containing digits as a role suffix", () => {
    const list = [i("T(1)"), i("p1")];
    overlayFortiswitchTrunkMembers(list, new Map([["T", ["p1"]]]));
    expect(list[0].ifName).toBe("T(1)");
  });

  it("can stamp a member that is itself a renamed suffixed row's base name", () => {
    // The synthetic / renamed rows are visible to later trunks in the same call.
    const list = [i("A(primary)"), i("p1")];
    const n = overlayFortiswitchTrunkMembers(list, new Map([["A", ["p1"]], ["B", ["A"]]]));
    expect(n).toBe(2);
    expect(byName(list).A.ifParent).toBe("B");
  });

  it("handles a multi-member LACP bundle and a single-member FortiLink uplink in one call", () => {
    const list = [i("lacp1"), i("p1"), i("p2"), i("p3"), i("FL-UP"), i("port52")];
    const n = overlayFortiswitchTrunkMembers(list, new Map([["lacp1", ["p1", "p2", "p3"]], ["FL-UP", ["port52"]]]));
    expect(n).toBe(4);
    const m = byName(list);
    expect([m.p1.ifParent, m.p2.ifParent, m.p3.ifParent, m.port52.ifParent]).toEqual(["lacp1", "lacp1", "lacp1", "FL-UP"]);
    expect(m.lacp1.ifType).toBe("aggregate");
    expect(m["FL-UP"].ifType).toBe("aggregate");
  });
});
