import { describe, it, expect } from "vitest";
import { macSplitRefusal, hostnameBase } from "../../src/services/assetMacSplitService.js";

// Business rule 91(j): which MACs may be split off, and the name a split builds on.
describe("macSplitRefusal", () => {
  const P = "44:61:32:F2:BC:27";
  it("allows a MAC a lease or a gate's client list saw", () => {
    expect(macSplitRefusal({ mac: "44:61:32:71:7C:43", source: "device-inventory" }, P)).toBeNull();
    expect(macSplitRefusal({ mac: "44:61:32:71:7C:43", source: "fortigate" }, P)).toBeNull();
  });
  it("keeps the primary MAC, whatever its spelling", () => {
    expect(macSplitRefusal({ mac: P.toLowerCase(), source: "device-inventory" }, P)).toMatch(/primary/);
  });
  it("never splits what the device reports as its own", () => {
    expect(macSplitRefusal({ mac: "AA:00:00:00:00:01", source: "monitor-interface" }, P)).toMatch(/own/);
    expect(macSplitRefusal({ mac: "AA:00:00:00:00:02", source: "intune-wifi" }, P)).toMatch(/own/);
    expect(macSplitRefusal({ mac: "AA:00:00:00:00:03", source: "polaris-agent" }, P)).toMatch(/own/);
    expect(macSplitRefusal({ mac: "AA:00:00:00:00:00", macEnd: "AA:00:00:00:00:0F", source: "fortigate" }, P)).toMatch(/range/);
  });
});

describe("hostnameBase", () => {
  it("strips a MAC suffix, and only a MAC suffix", () => {
    expect(hostnameBase("iPhone-F2BC27")).toBe("iPhone");
    expect(hostnameBase("iPhone-446132F2BC27")).toBe("iPhone");
    expect(hostnameBase("iPhone-Pro")).toBe("iPhone-Pro");
    expect(hostnameBase("iPhone")).toBe("iPhone");
    expect(hostnameBase(null)).toBeNull();
  });
});
