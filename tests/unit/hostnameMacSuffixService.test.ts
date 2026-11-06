import { describe, it, expect, vi, beforeEach } from "vitest";

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("../../src/db.js", () => ({ prisma: { asset: { findMany } } }));

import {
  isSuffixEligible,
  planFamilyRenames,
  planHostnameMacSuffixes,
  type FamilyMember,
} from "../../src/services/hostnameMacSuffixService.js";

const m = (over: Partial<FamilyMember>): FamilyMember => ({
  id: "a", hostname: "iPhone", macAddress: "44:61:32:F2:BC:27",
  hostnameOverride: null, sourceKinds: ["fortigate-endpoint"], ...over,
});

// Business rule 91(i).
describe("isSuffixEligible", () => {
  it("takes a lease / detected-device name with a MAC", () => {
    expect(isSuffixEligible(m({}))).toBe(true);
    expect(isSuffixEligible(m({ sourceKinds: [] }))).toBe(true);
  });
  it("never touches an operator rename", () => {
    expect(isSuffixEligible(m({ hostnameOverride: "Dave's phone" }))).toBe(false);
  });
  it("never touches a name another source gave", () => {
    expect(isSuffixEligible(m({ sourceKinds: ["fortigate-endpoint", "entra"] }))).toBe(false);
    expect(isSuffixEligible(m({ sourceKinds: ["polaris-agent"] }))).toBe(false);
  });
  it("needs a MAC to take the suffix from", () => {
    expect(isSuffixEligible(m({ macAddress: null }))).toBe(false);
  });
});

describe("planFamilyRenames", () => {
  it("a name nobody else carries is left alone", () => {
    expect(planFamilyRenames("iPhone", [m({})])).toEqual([]);
  });

  it("a second device under the name renames both", () => {
    const out = planFamilyRenames("iPhone", [
      m({ id: "old" }),
      m({ id: "new", macAddress: "44:61:32:71:7C:43" }),
    ]);
    expect(out).toEqual([
      { id: "old", from: "iPhone", to: "iPhone-F2BC27" },
      { id: "new", from: "iPhone", to: "iPhone-717C43" },
    ]);
  });

  it("a third device joins a family that is already suffixed", () => {
    const out = planFamilyRenames("iPhone", [
      m({ id: "a", hostname: "iPhone-F2BC27" }),
      m({ id: "b", hostname: "iPhone-717C43", macAddress: "44:61:32:71:7C:43" }),
      m({ id: "c", macAddress: "5A:1E:93:0C:44:D1" }),
    ]);
    expect(out).toEqual([{ id: "c", from: "iPhone", to: "iPhone-0C44D1" }]);
  });

  it("keeps an ineligible member's name but still names the new one apart", () => {
    const out = planFamilyRenames("iPhone", [
      m({ id: "intune", sourceKinds: ["intune"] }),
      m({ id: "new", macAddress: "44:61:32:71:7C:43" }),
    ]);
    expect(out).toEqual([{ id: "new", from: "iPhone", to: "iPhone-717C43" }]);
  });

  it("falls back to the full MAC when the short suffix is taken", () => {
    const out = planFamilyRenames("iPhone", [
      m({ id: "a", hostname: "iPhone-F2BC27" }),
      m({ id: "b", macAddress: "AA:BB:CC:F2:BC:27" }),
    ]);
    expect(out).toEqual([{ id: "b", from: "iPhone", to: "iPhone-AABBCCF2BC27" }]);
  });

  it("keeps each member's own casing of the base", () => {
    const out = planFamilyRenames("iPhone", [
      m({ id: "a", hostname: "IPHONE" }),
      m({ id: "b", macAddress: "44:61:32:71:7C:43" }),
    ]);
    expect(out.map((r) => r.to)).toEqual(["IPHONE-F2BC27", "iPhone-717C43"]);
  });

  it("ignores names outside the family", () => {
    expect(planFamilyRenames("iPhone", [m({ id: "a" }), m({ id: "b", hostname: "iPhone-Pro" })])).toEqual([]);
  });
});

describe("planHostnameMacSuffixes", () => {
  beforeEach(() => findMany.mockReset());

  it("does not query for no names", async () => {
    expect(await planHostnameMacSuffixes([null, "", "  "])).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("reads live family members and plans their renames", async () => {
    findMany.mockResolvedValue([
      { id: "old", hostname: "iPhone", macAddress: "44:61:32:F2:BC:27", hostnameOverride: null, sources: [{ sourceKind: "fortigate-endpoint" }] },
      { id: "new", hostname: "iPhone", macAddress: "44:61:32:71:7C:43", hostnameOverride: null, sources: [] },
    ]);
    const out = await planHostnameMacSuffixes(["iPhone", "iphone"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    const where = findMany.mock.calls[0]![0].where;
    expect(where.status).toEqual({ not: "decommissioned" });
    expect(where.OR).toHaveLength(2); // the two spellings fold to one base
    expect(out.map((r) => r.to)).toEqual(["iPhone-F2BC27", "iPhone-717C43"]);
  });
});
