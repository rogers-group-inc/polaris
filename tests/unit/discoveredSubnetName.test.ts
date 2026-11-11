import { describe, it, expect } from "vitest";
import { renameDeviceSuffix, rebuildStaleGeneratedName } from "../../src/utils/discoveredSubnetName.js";

describe("rebuildStaleGeneratedName", () => {
  it("heals a generated name left on the old device by an earlier run", () => {
    expect(rebuildStaleGeneratedName("DHCP: Cameras (PULASKI-PL-91G-1)", "DHCP: Cameras", "COWAN-PL-91G-1"))
      .toBe("DHCP: Cameras (COWAN-PL-91G-1)");
  });

  it("returns null when the name is current", () => {
    expect(rebuildStaleGeneratedName("DHCP: Cameras (FG-1)", "DHCP: Cameras", "FG-1")).toBeNull();
  });

  it("never touches a name not built from this prefix", () => {
    expect(rebuildStaleGeneratedName("Yard cameras (OLD)", "DHCP: Cameras", "NEW")).toBeNull();
    expect(rebuildStaleGeneratedName("DHCP: Cameras", "DHCP: Cameras", "NEW")).toBeNull();
    expect(rebuildStaleGeneratedName("DHCP: Cameras ()", "DHCP: Cameras", "NEW")).toBeNull();
    expect(rebuildStaleGeneratedName("DHCP: Cameras (OLD) extra", "DHCP: Cameras", "NEW")).toBeNull();
  });

  it("does nothing without a device", () => {
    expect(rebuildStaleGeneratedName("DHCP: Cameras (OLD)", "DHCP: Cameras", null)).toBeNull();
  });
});

describe("renameDeviceSuffix", () => {
  it("swaps the device suffix when the gate was renamed", () => {
    expect(renameDeviceSuffix("DHCP: Cameras (PULASKI-PL-91G-1)", "PULASKI-PL-91G-1", "COWAN-PL-91G-1"))
      .toBe("DHCP: Cameras (COWAN-PL-91G-1)");
  });

  it("keeps an operator edit to the rest of the name", () => {
    expect(renameDeviceSuffix("Yard cameras (OLD-FG)", "OLD-FG", "NEW-FG")).toBe("Yard cameras (NEW-FG)");
  });

  it("only touches the trailing suffix", () => {
    expect(renameDeviceSuffix("DHCP: (OLD-FG) uplink (OLD-FG)", "OLD-FG", "NEW-FG"))
      .toBe("DHCP: (OLD-FG) uplink (NEW-FG)");
  });

  it("leaves a name the operator replaced alone", () => {
    expect(renameDeviceSuffix("Site cameras", "OLD-FG", "NEW-FG")).toBeNull();
  });

  it("does nothing when the device name did not change", () => {
    expect(renameDeviceSuffix("DHCP: lan (FG-1)", "FG-1", "FG-1")).toBeNull();
  });

  it("does nothing when either device name or the name is missing", () => {
    expect(renameDeviceSuffix("DHCP: lan (FG-1)", null, "FG-2")).toBeNull();
    expect(renameDeviceSuffix("DHCP: lan (FG-1)", "FG-1", "")).toBeNull();
    expect(renameDeviceSuffix(null, "FG-1", "FG-2")).toBeNull();
  });

  it("is case-sensitive, so a case-only rename still moves the suffix", () => {
    expect(renameDeviceSuffix("DHCP: lan (fg-1)", "fg-1", "FG-1")).toBe("DHCP: lan (FG-1)");
  });
});
