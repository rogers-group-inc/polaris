/**
 * tests/unit/scopeRelationIndex.test.ts
 *
 * The SQL half of the condition tree's RELATION-backed fields — `interfaceName`
 * (AssetInterface) and `ssid` (AssetApVap). What matters here
 * is not the queries themselves but that the prefetched verdict and the
 * in-memory relation read reach the SAME answer — they are two paths through one
 * predicate, and a disagreement would make an automation select a different
 * device set on the engine tick than the wizard previewed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const groupBy = vi.fn();
const findMany = vi.fn();

const vapGroupBy = vi.fn();
const vapFindMany = vi.fn();

vi.mock("../../src/db.js", () => ({
  prisma: {
    assetInterface: { groupBy, findMany },
    assetApVap: { groupBy: vapGroupBy, findMany: vapFindMany },
  },
}));

const { decorateRelationLeafHits } = await import("../../src/services/scopeRelationIndex.js");
const { evaluateScopeCondition, relationLeafKey } = await import("../../src/services/notificationTypes.js");

type Tree = Parameters<typeof evaluateScopeCondition>[0];
type Asset = Parameters<typeof evaluateScopeCondition>[1];

const and = (...children: unknown[]) => ({ op: "and", children }) as Tree;
const leaf = (operator: string, value: string) => ({ field: "interfaceName", operator, value });
const one = (operator: string, value: string) => and(leaf(operator, value));

beforeEach(() => {
  groupBy.mockReset();
  findMany.mockReset();
  vapGroupBy.mockReset();
  vapFindMany.mockReset();
});

describe("decorateRelationLeafHits", () => {
  it("asks nothing when no leaf mentions an interface", async () => {
    const rows: Asset[] = [{ id: "a1" }];
    await decorateRelationLeafHits(rows, [and({ field: "hostname", operator: "contains", value: "sw" })]);
    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(rows[0]!.relationLeafHits).toBeUndefined();
  });

  it("asks nothing for an empty row set", async () => {
    await decorateRelationLeafHits([], [one("equals", "port9")]);
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("stamps a per-asset verdict and scopes the query to the rows it was given", async () => {
    groupBy.mockResolvedValue([{ assetId: "a1" }]);
    const rows: Asset[] = [{ id: "a1" }, { id: "a2" }];
    await decorateRelationLeafHits(rows, [one("equals", "port9")]);

    const key = relationLeafKey(leaf("equals", "port9"));
    expect(rows[0]!.relationLeafHits!.get(key)).toBe(true);
    expect(rows[1]!.relationLeafHits!.get(key)).toBe(false);

    const arg = groupBy.mock.calls[0]![0];
    expect(arg.by).toEqual(["assetId"]);
    expect(arg.where.assetId).toEqual({ in: ["a1", "a2"] });
    expect(arg.where.ifName).toEqual({ equals: "port9", mode: "insensitive" });
  });

  // The whole point of keying by the POSITIVE operator: a rule that asks "has
  // port9" and one that asks "has no port9" are answered by one query.
  it("shares one query between the halves of a negative pair", async () => {
    groupBy.mockResolvedValue([{ assetId: "a1" }]);
    const rows: Asset[] = [{ id: "a1" }];
    await decorateRelationLeafHits(rows, [
      one("equals", "port9"),
      one("notEquals", "port9"),
      one("contains", "port9"),
    ]);
    // equals+notEquals collapse to one key; contains is a second.
    expect(groupBy).toHaveBeenCalledTimes(2);
    expect(rows[0]!.relationLeafHits!.size).toBe(2);
  });

  it("merges rather than replacing, so a second pass keeps the first pass's answers", async () => {
    groupBy.mockResolvedValue([{ assetId: "a1" }]);
    const rows: Asset[] = [{ id: "a1" }];
    await decorateRelationLeafHits(rows, [one("equals", "port9")]);
    groupBy.mockResolvedValue([]);
    await decorateRelationLeafHits(rows, [one("equals", "fortilink")]);

    expect(rows[0]!.relationLeafHits!.get(relationLeafKey(leaf("equals", "port9")))).toBe(true);
    expect(rows[0]!.relationLeafHits!.get(relationLeafKey(leaf("equals", "fortilink")))).toBe(false);
  });

  it("narrows a wildcard by its literal prefix and tests the pattern here", async () => {
    findMany.mockResolvedValue([
      { assetId: "a1", ifName: "PLV-61F-1" },
      { assetId: "a2", ifName: "PLV-61F-22" },
    ]);
    const rows: Asset[] = [{ id: "a1" }, { id: "a2" }];
    await decorateRelationLeafHits(rows, [one("matches", "PLV-*-?")]);

    expect(groupBy).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0]![0].where.ifName).toEqual({ startsWith: "PLV-", mode: "insensitive" });
    const key = relationLeafKey(leaf("matches", "PLV-*-?"));
    // Anchored: the single "?" matches "1" but not "22".
    expect(rows[0]!.relationLeafHits!.get(key)).toBe(true);
    expect(rows[1]!.relationLeafHits!.get(key)).toBe(false);
  });

  it("reads the whole table for a pattern that opens with a metacharacter", async () => {
    findMany.mockResolvedValue([{ assetId: "a1", ifName: "wan1" }]);
    await decorateRelationLeafHits([{ id: "a1" } as Asset], [one("matches", "*an1")]);
    expect(findMany.mock.calls[0]![0].where.ifName).toBeUndefined();
  });
});

describe("prefetched verdict vs. joined relation", () => {
  const CASES: [string, string, string[], boolean][] = [
    // operator, value, the asset's real interface names, expected
    ["equals", "port9", ["port1", "port9"], true],
    ["equals", "port9", ["port1", "port10"], false],
    ["notEquals", "port9", ["port1", "port9"], false],
    ["notEquals", "port9", ["port1", "port10"], true],
    ["contains", "link", ["fortilink"], true],
    ["notContains", "link", ["fortilink", "port1"], false],
    ["startsWith", "wan", ["wan1"], true],
    ["endsWith", "1", ["wan1"], true],
    // Nothing known at all: a positive claim fails, an absence claim holds.
    ["equals", "port9", [], false],
    ["notEquals", "port9", [], true],
  ];

  for (const [operator, value, names, expected] of CASES) {
    it(`${operator} ${value} against [${names.join(", ")}] is ${expected} both ways`, async () => {
      const tree = one(operator, value);

      // Path A — the single-asset paths: the relation rides the row.
      const joined: Asset = { id: "a1", interfaces: names.map((ifName) => ({ ifName })) };
      expect(evaluateScopeCondition(tree, joined)).toBe(expected);

      // Path B — the fleet-scale paths: SQL answered the leaf's POSITIVE form,
      // which is what the mock stands in for here.
      const positiveHit = names.some((n) => {
        const hay = n.toLowerCase();
        const needle = value.toLowerCase();
        switch (operator) {
          case "equals": case "notEquals": return hay === needle;
          case "contains": case "notContains": return hay.includes(needle);
          case "startsWith": return hay.startsWith(needle);
          case "endsWith": return hay.endsWith(needle);
          default: return false;
        }
      });
      groupBy.mockResolvedValue(positiveHit ? [{ assetId: "a1" }] : []);
      const decorated: Asset = { id: "a1" };
      await decorateRelationLeafHits([decorated], [tree]);
      expect(evaluateScopeCondition(tree, decorated)).toBe(expected);
    });
  }

  // The reason matchScopeRule tests has() and not get(): a leaf nobody
  // prefetched is UNKNOWN. Answering "no" for it would make a peer rule's
  // interface filter silently select nothing.
  it("falls back to the relation for a leaf the decoration never resolved", async () => {
    groupBy.mockResolvedValue([]);
    const asset: Asset = { id: "a1", interfaces: [{ ifName: "port9" }] };
    await decorateRelationLeafHits([asset], [one("equals", "fortilink")]);
    expect(evaluateScopeCondition(one("equals", "port9"), asset)).toBe(true);
    expect(evaluateScopeCondition(one("equals", "fortilink"), asset)).toBe(false);
  });
});

// ─── The second relation-backed field ───────────────────────────────────────

const ssidLeaf = (operator: string, value: string) => ({ field: "ssid", operator, value });
const oneSsid = (operator: string, value: string) => and(ssidLeaf(operator, value));

describe("ssid (Broadcast SSID)", () => {
  it("queries the VAP inventory, not the interface inventory", async () => {
    vapGroupBy.mockResolvedValue([{ assetId: "ap1" }]);
    const rows: Asset[] = [{ id: "ap1" }, { id: "ap2" }];
    await decorateRelationLeafHits(rows, [oneSsid("equals", "GUEST")]);

    expect(groupBy).not.toHaveBeenCalled();
    const arg = vapGroupBy.mock.calls[0]![0];
    expect(arg.by).toEqual(["assetId"]);
    expect(arg.where.assetId).toEqual({ in: ["ap1", "ap2"] });
    expect(arg.where.ssid).toEqual({ equals: "GUEST", mode: "insensitive" });

    const key = relationLeafKey(ssidLeaf("equals", "GUEST"));
    expect(rows[0]!.relationLeafHits!.get(key)).toBe(true);
    expect(rows[1]!.relationLeafHits!.get(key)).toBe(false);
  });

  // The reason the key carries the field: two relations now share one map, and
  // "a port named GUEST" and "an SSID named GUEST" are different questions.
  it("does not let an interface leaf answer an SSID leaf of the same value", async () => {
    groupBy.mockResolvedValue([{ assetId: "ap1" }]);   // HAS an interface "GUEST"
    vapGroupBy.mockResolvedValue([]);                  // broadcasts NO "GUEST"
    const rows: Asset[] = [{ id: "ap1" }];
    await decorateRelationLeafHits(rows, [one("equals", "GUEST"), oneSsid("equals", "GUEST")]);

    expect(rows[0]!.relationLeafHits!.get(relationLeafKey(leaf("equals", "GUEST")))).toBe(true);
    expect(rows[0]!.relationLeafHits!.get(relationLeafKey(ssidLeaf("equals", "GUEST")))).toBe(false);
    expect(evaluateScopeCondition(one("equals", "GUEST"), rows[0]!)).toBe(true);
    expect(evaluateScopeCondition(oneSsid("equals", "GUEST"), rows[0]!)).toBe(false);
  });

  it("resolves both fields in one pass when a tree asks about both", async () => {
    groupBy.mockResolvedValue([{ assetId: "ap1" }]);
    vapGroupBy.mockResolvedValue([{ assetId: "ap1" }]);
    const rows: Asset[] = [{ id: "ap1" }];
    await decorateRelationLeafHits(rows, [and(leaf("equals", "wan1"), ssidLeaf("equals", "CORP"))]);
    expect(rows[0]!.relationLeafHits!.size).toBe(2);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(vapGroupBy).toHaveBeenCalledTimes(1);
  });

  it("narrows an SSID wildcard by its literal prefix and tests the pattern here", async () => {
    vapFindMany.mockResolvedValue([
      { assetId: "ap1", ssid: "CORP-1" },
      { assetId: "ap2", ssid: "CORP-22" },
    ]);
    const rows: Asset[] = [{ id: "ap1" }, { id: "ap2" }];
    await decorateRelationLeafHits(rows, [oneSsid("matches", "CORP-?")]);

    expect(vapFindMany.mock.calls[0]![0].where.ssid).toEqual({ startsWith: "CORP-", mode: "insensitive" });
    const key = relationLeafKey(ssidLeaf("matches", "CORP-?"));
    expect(rows[0]!.relationLeafHits!.get(key)).toBe(true);
    expect(rows[1]!.relationLeafHits!.get(key)).toBe(false);
  });
});

describe("ssid: prefetched verdict vs. joined relation", () => {
  const CASES: [string, string, (string | null)[], boolean][] = [
    // operator, value, the SSIDs the AP broadcasts, expected
    ["equals", "GUEST", ["CORP", "GUEST"], true],
    ["equals", "GUEST", ["CORP"], false],
    ["notEquals", "GUEST", ["CORP", "GUEST"], false],
    ["notEquals", "GUEST", ["CORP"], true],
    ["contains", "gue", ["GUEST"], true],
    ["startsWith", "CO", ["CORP"], true],
    ["endsWith", "RP", ["CORP"], true],
    // An AP whose radios have not been discovered reports nothing: a positive
    // claim fails, an absence claim holds — same reading as no interfaces.
    ["equals", "GUEST", [], false],
    ["notEquals", "GUEST", [], true],
    // A VAP row with a null SSID (a hidden/unnamed VAP) contributes nothing.
    ["equals", "GUEST", [null], false],
    ["notEquals", "GUEST", [null], true],
  ];

  for (const [operator, value, ssids, expected] of CASES) {
    it(`${operator} ${value} against [${ssids.join(", ")}] is ${expected} both ways`, async () => {
      const tree = oneSsid(operator, value);

      // Path A — the single-asset paths: the relation rides the row.
      const joined: Asset = { id: "ap1", apVaps: ssids.map((ssid) => ({ ssid })) };
      expect(evaluateScopeCondition(tree, joined)).toBe(expected);

      // Path B — the fleet-scale paths, where SQL answered the POSITIVE form.
      const positiveHit = ssids.some((n) => {
        if (!n) return false;
        const hay = n.toLowerCase();
        const needle = value.toLowerCase();
        switch (operator) {
          case "equals": case "notEquals": return hay === needle;
          case "contains": case "notContains": return hay.includes(needle);
          case "startsWith": return hay.startsWith(needle);
          case "endsWith": return hay.endsWith(needle);
          default: return false;
        }
      });
      vapGroupBy.mockResolvedValue(positiveHit ? [{ assetId: "ap1" }] : []);
      const decorated: Asset = { id: "ap1" };
      await decorateRelationLeafHits([decorated], [tree]);
      expect(evaluateScopeCondition(tree, decorated)).toBe(expected);
    });
  }

  // One SSID on two radios is two VAP rows; the filter is about the AP.
  it("treats an SSID broadcast by several radios as one value", async () => {
    const asset: Asset = { id: "ap1", apVaps: [{ ssid: "CORP" }, { ssid: "CORP" }, { ssid: "GUEST" }] };
    expect(evaluateScopeCondition(oneSsid("equals", "CORP"), asset)).toBe(true);
    // The negative has to hold for EVERY value — duplicates must not change it.
    expect(evaluateScopeCondition(oneSsid("notEquals", "CORP"), asset)).toBe(false);
    expect(evaluateScopeCondition(oneSsid("notEquals", "OTHER"), asset)).toBe(true);
  });
});

// Business rule 133: "Native VLAN" reads the same relation as interfaceName,
// but an INTEGER column matched by number.
const vlanLeaf = (operator: string, value: string) => ({ field: "nativeVlan", operator, value });
const oneVlan = (operator: string, value: string) => and(vlanLeaf(operator, value));

describe("nativeVlan (Native VLAN)", () => {
  it("queries the interface inventory by NUMBER, one GROUP BY for both halves of the pair", async () => {
    groupBy.mockResolvedValue([{ assetId: "sw1" }]);
    const rows: Asset[] = [{ id: "sw1" }, { id: "sw2" }];
    await decorateRelationLeafHits(rows, [and(vlanLeaf("equals", "30"), vlanLeaf("notEquals", "30"))]);
    expect(groupBy).toHaveBeenCalledTimes(1);
    const arg = groupBy.mock.calls[0]![0];
    expect(arg.where.nativeVlan).toBe(30);
    expect(arg.where.assetId).toEqual({ in: ["sw1", "sw2"] });
    expect(arg.where.ifName).toBeUndefined();
  });

  it("does not let an interface NAME leaf answer a VLAN leaf of the same value", async () => {
    groupBy.mockImplementation(async (a: { where: { ifName?: unknown } }) => (a.where.ifName ? [{ assetId: "sw1" }] : []));
    const rows: Asset[] = [{ id: "sw1" }];
    await decorateRelationLeafHits(rows, [and(leaf("equals", "30"), vlanLeaf("equals", "30"))]);
    expect(rows[0]!.relationLeafHits!.get(relationLeafKey(leaf("equals", "30")))).toBe(true);
    expect(rows[0]!.relationLeafHits!.get(relationLeafKey(vlanLeaf("equals", "30")))).toBe(false);
  });

  const CASES: [string, string, (number | null)[], boolean][] = [
    // operator, value, the native VLANs the switch's ports carry, expected
    ["equals", "30", [1, 30], true],
    ["equals", "030", [1, 30], true],
    ["equals", "30", [1, 40], false],
    ["notEquals", "30", [1, 30], false],
    ["notEquals", "30", [1, 40], true],
    ["equals", "30", [], false],
    ["notEquals", "30", [], true],
    ["equals", "30", [null], false],
  ];
  for (const [operator, value, vlans, expected] of CASES) {
    it(`${operator} ${value} against [${vlans.join(", ")}] is ${expected} both ways`, async () => {
      const tree = oneVlan(operator, value);
      const joined: Asset = { id: "sw1", interfaces: vlans.map((v, i) => ({ ifName: "port" + i, nativeVlan: v })) };
      expect(evaluateScopeCondition(tree, joined)).toBe(expected);

      groupBy.mockResolvedValue(vlans.includes(Number(value)) ? [{ assetId: "sw1" }] : []);
      const decorated: Asset = { id: "sw1" };
      await decorateRelationLeafHits([decorated], [tree]);
      expect(evaluateScopeCondition(tree, decorated)).toBe(expected);
    });
  }
});
