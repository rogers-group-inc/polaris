import { describe, it, expect } from "vitest";
import { mergeVlanNames, vlanNamesFromInterfaces } from "../../src/utils/vlanNames.js";

describe("vlanNamesFromInterfaces", () => {
  it("names each VLAN id after the interface carrying it", () => {
    const names = vlanNamesFromInterfaces([
      { ifName: "Users_VL30", ifParent: "fortilink", vlanId: 30 },
      { ifName: "Voice_VL40", ifParent: "fortilink", vlanId: 40 },
    ]);
    expect([...names.entries()]).toEqual([[30, "Users_VL30"], [40, "Voice_VL40"]]);
  });

  it("settles a tie by the FortiLink parent, otherwise leaves the id unnamed", () => {
    const names = vlanNamesFromInterfaces([
      { ifName: "Users_VL30", ifParent: "fortilink", vlanId: 30 },
      { ifName: "DMZ30", ifParent: "port5", vlanId: 30 },
      { ifName: "A50", ifParent: "port5", vlanId: 50 },
      { ifName: "B50", ifParent: "port6", vlanId: 50 },
    ]);
    expect(names.get(30)).toBe("Users_VL30");
    expect(names.has(50)).toBe(false);
  });

  it("skips rows with no usable VLAN id", () => {
    const names = vlanNamesFromInterfaces([
      { ifName: "x", ifParent: null, vlanId: null },
      { ifName: "y", ifParent: null, vlanId: 0 },
      { ifName: "z", ifParent: null, vlanId: 4095 },
    ]);
    expect(names.size).toBe(0);
  });
});

describe("mergeVlanNames", () => {
  it("lets the first layer win per id", () => {
    const merged = mergeVlanNames(new Map([[30, "own"]]), new Map([[30, "gate"], [40, "gate40"]]));
    expect([...merged.entries()]).toEqual([[30, "own"], [40, "gate40"]]);
  });
});
