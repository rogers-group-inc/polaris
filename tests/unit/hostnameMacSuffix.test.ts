import { describe, it, expect } from "vitest";
import { macNameSuffix, suffixedHostname, isHostnameFamilyMember } from "../../src/utils/hostnameMacSuffix.js";

// Business rule 91(i): devices sharing a discovered hostname are told apart by
// the last three octets of their MAC.
describe("hostnameMacSuffix", () => {
  it("takes the last three octets, upper-case, no separators", () => {
    expect(macNameSuffix("44:61:32:f2:bc:27")).toBe("F2BC27");
    expect(macNameSuffix("4461.32F2.BC27")).toBe("F2BC27");
    expect(macNameSuffix("44:61:32:F2:BC:27", true)).toBe("446132F2BC27");
  });

  it("has no suffix for no MAC or an unusable one", () => {
    expect(macNameSuffix(null)).toBeNull();
    expect(macNameSuffix("not-a-mac")).toBeNull();
    expect(suffixedHostname("iPhone", undefined)).toBeNull();
  });

  it("builds <base>-<suffix>", () => {
    expect(suffixedHostname("iPhone", "44:61:32:71:7C:43")).toBe("iPhone-717C43");
    expect(suffixedHostname("iPhone", "44:61:32:71:7C:43", true)).toBe("iPhone-446132717C43");
  });

  it("a family is the base and its MAC-suffixed forms, case-insensitively", () => {
    expect(isHostnameFamilyMember("iPhone", "iphone")).toBe(true);
    expect(isHostnameFamilyMember("IPHONE-F2BC27", "iPhone")).toBe(true);
    expect(isHostnameFamilyMember("iPhone-446132F2BC27", "iPhone")).toBe(true);
    expect(isHostnameFamilyMember("iPhone-Pro", "iPhone")).toBe(false);
    expect(isHostnameFamilyMember("iPhone-F2BC2", "iPhone")).toBe(false);
    expect(isHostnameFamilyMember("iPhone2", "iPhone")).toBe(false);
    expect(isHostnameFamilyMember(null, "iPhone")).toBe(false);
  });
});
