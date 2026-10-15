/**
 * tests/unit/subnetConditionOps.test.ts
 *
 * The three ways a `subnet` ("Subnet / IP") condition names addresses — CIDR,
 * Range and Name — each with its negation. CIDR and Range are pure over the
 * asset row; Name reads the subnet REGISTRY, so it is resolved by
 * `decorateSubnetNameHits` (also run inside `decorateRelationLeafHits`) and the
 * evaluator only reads the stamped verdict.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const subnetFindMany = vi.fn();
const assetFindMany = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: {
    subnet: { findMany: subnetFindMany },
    asset: { findMany: assetFindMany },
    assetInterface: { groupBy: vi.fn(), findMany: vi.fn() },
    assetApVap: { groupBy: vi.fn(), findMany: vi.fn() },
  },
}));

const { decorateSubnetNameHits, decorateRelationLeafHits, invalidateSubnetRegistryCache } =
  await import("../../src/services/scopeRelationIndex.js");
const {
  evaluateScopeCondition,
  scopeConditionSchema,
  scopeConditionMeta,
  scopeRank,
  SCOPE_FIELD_OPS,
  subnetNameLeafKey,
} = await import("../../src/services/notificationTypes.js");
const { parseIpv4Range, ipInIpv4Range } = await import("../../src/utils/cidr.js");

type Tree = Parameters<typeof evaluateScopeCondition>[0];
type Asset = Parameters<typeof evaluateScopeCondition>[1];

const and = (...children: unknown[]) => ({ op: "and", children }) as Tree;
const one = (operator: string, value: string) => and({ field: "subnet", operator, value });
const at = (ip: string | null, id = "a1"): Asset & { id: string } => ({ id, ipAddress: ip });

const REGISTRY = [
  { name: "Plant-Ashfield", cidr: "10.1.0.0/24" },
  { name: "Plant-Dock", cidr: "10.2.0.0/24" },
  { name: "Office", cidr: "10.3.0.0/24" },
];

beforeEach(() => {
  subnetFindMany.mockReset();
  assetFindMany.mockReset();
  subnetFindMany.mockResolvedValue(REGISTRY);
  invalidateSubnetRegistryCache();
});

describe("parseIpv4Range / ipInIpv4Range", () => {
  it("reads first-to-last, with or without spaces", () => {
    expect(parseIpv4Range("10.0.0.10-10.0.0.50")).toEqual({ first: "10.0.0.10", last: "10.0.0.50" });
    expect(parseIpv4Range(" 10.0.0.10 - 10.0.0.50 ")).toEqual({ first: "10.0.0.10", last: "10.0.0.50" });
  });

  it("reads the short form as the same /24's last octet", () => {
    expect(parseIpv4Range("10.0.0.10-50")).toEqual({ first: "10.0.0.10", last: "10.0.0.50" });
  });

  it("treats a single address as a one-address range", () => {
    expect(parseIpv4Range("10.0.0.7")).toEqual({ first: "10.0.0.7", last: "10.0.0.7" });
  });

  it("refuses a backwards range, a bad octet, IPv6 and junk", () => {
    expect(parseIpv4Range("10.0.0.50-10.0.0.10")).toBeNull();
    expect(parseIpv4Range("10.0.0.10-10.0.0.300")).toBeNull();
    expect(parseIpv4Range("fe80::1-fe80::9")).toBeNull();
    expect(parseIpv4Range("Plant")).toBeNull();
    expect(parseIpv4Range("1.1.1.1-2.2.2.2-3.3.3.3")).toBeNull();
    expect(parseIpv4Range("")).toBeNull();
  });

  it("is inclusive at both ends and spans octet boundaries", () => {
    expect(ipInIpv4Range("10.0.0.10", "10.0.0.10-10.0.0.50")).toBe(true);
    expect(ipInIpv4Range("10.0.0.50", "10.0.0.10-10.0.0.50")).toBe(true);
    expect(ipInIpv4Range("10.0.0.51", "10.0.0.10-10.0.0.50")).toBe(false);
    expect(ipInIpv4Range("10.0.1.4", "10.0.0.200-10.0.2.10")).toBe(true);
    expect(ipInIpv4Range("not-an-ip", "10.0.0.10-10.0.0.50")).toBe(false);
  });
});

describe("Range rules", () => {
  it("selects inside the range, and the negation selects outside it", () => {
    expect(evaluateScopeCondition(one("inRange", "10.0.0.10-50"), at("10.0.0.20"))).toBe(true);
    expect(evaluateScopeCondition(one("inRange", "10.0.0.10-50"), at("10.0.0.60"))).toBe(false);
    expect(evaluateScopeCondition(one("notInRange", "10.0.0.10-50"), at("10.0.0.60"))).toBe(true);
  });

  it("reads an asset with no address as outside every range", () => {
    expect(evaluateScopeCondition(one("inRange", "10.0.0.10-50"), at(null))).toBe(false);
    expect(evaluateScopeCondition(one("notInRange", "10.0.0.10-50"), at(null))).toBe(true);
  });
});

describe("Name rules", () => {
  it("selects devices inside ANY subnet whose name matches the wildcard", async () => {
    const rows = [at("10.1.0.5", "ash"), at("10.2.0.5", "dock"), at("10.3.0.5", "office"), at(null, "none")];
    const tree = one("inSubnetNamed", "plant-*");
    await decorateSubnetNameHits(rows, [tree]);
    expect(rows.filter((r) => evaluateScopeCondition(tree, r)).map((r) => r.id)).toEqual(["ash", "dock"]);
  });

  it("negates on the same lookup", async () => {
    const rows = [at("10.1.0.5", "ash"), at("10.3.0.5", "office")];
    const tree = one("notInSubnetNamed", "Plant-*");
    await decorateSubnetNameHits(rows, [tree]);
    expect(rows.filter((r) => evaluateScopeCondition(tree, r)).map((r) => r.id)).toEqual(["office"]);
  });

  it("matches a name with no wildcard exactly, ignoring case", async () => {
    const rows = [at("10.3.0.5", "office"), at("10.1.0.5", "ash")];
    const tree = one("inSubnetNamed", "OFFICE");
    await decorateSubnetNameHits(rows, [tree]);
    expect(rows.filter((r) => evaluateScopeCondition(tree, r)).map((r) => r.id)).toEqual(["office"]);
  });

  it("reads an undecorated row as in no such subnet, never throwing", () => {
    expect(evaluateScopeCondition(one("inSubnetNamed", "Plant-*"), at("10.1.0.5"))).toBe(false);
    expect(evaluateScopeCondition(one("notInSubnetNamed", "Plant-*"), at("10.1.0.5"))).toBe(true);
  });

  it("asks the registry only when a tree has a name leaf, once per burst", async () => {
    await decorateSubnetNameHits([at("10.1.0.5")], [one("inCidr", "10.1.0.0/24")]);
    expect(subnetFindMany).not.toHaveBeenCalled();
    await decorateSubnetNameHits([at("10.1.0.5")], [one("inSubnetNamed", "Plant-*")]);
    await decorateSubnetNameHits([at("10.2.0.5")], [one("inSubnetNamed", "Office")]);
    expect(subnetFindMany).toHaveBeenCalledTimes(1);
    expect(subnetFindMany.mock.calls[0]![0]).toMatchObject({ where: { status: { not: "deprecated" } } });
  });

  it("fetches the address for a row whose select left it out", async () => {
    assetFindMany.mockResolvedValue([{ id: "x", ipAddress: "10.1.0.9" }]);
    const row = { id: "x" } as Asset & { id: string };
    const tree = one("inSubnetNamed", "Plant-*");
    await decorateSubnetNameHits([row], [tree]);
    expect(evaluateScopeCondition(tree, row)).toBe(true);
  });

  it("rides decorateRelationLeafHits, so every fleet loader resolves it", async () => {
    const row = at("10.2.0.5");
    const tree = one("inSubnetNamed", "*dock");
    await decorateRelationLeafHits([row], [tree]);
    expect(row.relationLeafHits?.get(subnetNameLeafKey({ field: "subnet", operator: "inSubnetNamed", value: "*dock" }))).toBe(true);
    expect(evaluateScopeCondition(tree, row)).toBe(true);
  });
});

describe("validation and catalog", () => {
  const ok = (operator: string, value: string) => scopeConditionSchema.safeParse(one(operator, value)).success;

  it("offers CIDR, Range and Name, each with its negation", () => {
    expect([...SCOPE_FIELD_OPS["subnet"]!]).toEqual(["inCidr", "notInCidr", "inRange", "notInRange", "inSubnetNamed", "notInSubnetNamed"]);
    // IP block keeps CIDR only — a block is named by its own range already.
    expect([...SCOPE_FIELD_OPS["ipBlock"]!]).toEqual(["inCidr", "notInCidr"]);
  });

  it("checks each value against its own operator's kind", () => {
    expect(ok("inCidr", "10.0.0.0/8")).toBe(true);
    expect(ok("inCidr", "Plant-*")).toBe(false);
    expect(ok("inRange", "10.0.0.10-10.0.0.50")).toBe(true);
    expect(ok("notInRange", "10.0.0.10-50")).toBe(true);
    expect(ok("inRange", "10.0.0.0/24")).toBe(false);
    expect(ok("inRange", "10.0.0.50-10.0.0.10")).toBe(false);
    expect(ok("inSubnetNamed", "Plant-*")).toBe(true);
    expect(ok("notInSubnetNamed", "Office")).toBe(true);
  });

  it("labels the operators by how the addresses are given, and says what each value is", () => {
    const meta = scopeConditionMeta(SCOPE_FIELD_OPS);
    expect(meta.operatorLabels.inCidr).toBe("is within CIDR");
    expect(meta.operatorLabels.inRange).toBe("is within range");
    expect(meta.operatorLabels.inSubnetNamed).toBe("is in subnet named");
    expect(meta.operatorValueKinds).toMatchObject({ inRange: "ipRange", inSubnetNamed: "subnetName", inCidr: "cidr" });
  });

  it("counts a positive Range or Name rule as subnet-specific, and a negation as not", () => {
    const cidr = scopeRank({ condition: one("inCidr", "10.0.0.0/24") } as never);
    expect(scopeRank({ condition: one("inRange", "10.0.0.1-9") } as never)).toBe(cidr);
    expect(scopeRank({ condition: one("inSubnetNamed", "Plant-*") } as never)).toBe(cidr);
    expect(scopeRank({ condition: one("notInSubnetNamed", "Plant-*") } as never)).toBeLessThan(cidr);
  });
});
