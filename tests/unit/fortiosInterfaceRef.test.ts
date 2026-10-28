import { describe, expect, it } from "vitest";
import { fortiosInterfaceRef, fortiosVlanParentOf } from "../../src/utils/fortiosInterfaceRef.js";

describe("fortiosVlanParentOf", () => {
  it("is the parent of a VLAN interface, from either transport's shape", () => {
    expect(fortiosVlanParentOf({ vlanid: 30, interface: "fortilink2" })).toBe("fortilink2");
    expect(fortiosVlanParentOf({ vlanid: "30", interface: ["agg1"] })).toBe("agg1");
  });
  it("is null for a row with no VLAN id, whatever its interface field says", () => {
    expect(fortiosVlanParentOf({ interface: "wan1" })).toBeNull();
    expect(fortiosVlanParentOf({ vlanid: 0, interface: "port1" })).toBeNull();
    expect(fortiosVlanParentOf({ vlanid: 30 })).toBeNull();
  });
});

describe("fortiosInterfaceRef", () => {
  it("reads FortiOS REST's string", () => {
    expect(fortiosInterfaceRef("fortilink2")).toBe("fortilink2");
    expect(fortiosInterfaceRef("  agg1 ")).toBe("agg1");
  });
  it("reads FortiManager's one-element array, of strings or of { name }", () => {
    expect(fortiosInterfaceRef(["fortilink"])).toBe("fortilink");
    expect(fortiosInterfaceRef([{ name: "internal" }])).toBe("internal");
  });
  it("is null when absent or blank", () => {
    for (const v of [undefined, null, "", "  ", [], [""], [{}], 42]) expect(fortiosInterfaceRef(v)).toBeNull();
  });
});
