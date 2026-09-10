import { describe, it, expect } from "vitest";
import {
  DEVICE_FILTER_FIELD_OPS,
  DEVICE_FILTER_ONLY_FIELDS,
  SCOPE_FIELD_OPS,
  deviceFilterConditionSchema,
  evaluateScopeCondition,
  scopeConditionMeta,
  scopeConditionSchema,
  scopeRank,
  type ScopeConditionAsset,
  type ScopeConditionGroup,
} from "../../src/services/notificationTypes.js";

const and = (...children: unknown[]): ScopeConditionGroup =>
  ({ op: "and", children } as ScopeConditionGroup);
const one = (field: string, operator: string, value: string) => and({ field, operator, value });

const ASSET: ScopeConditionAsset = {
  id: "a1",
  assetType: "switch",
  interfaces: [{ ifName: "port1" }, { ifName: "port9" }, { ifName: "fortilink" }],
  hostname: "PLV-61F-SW1",
  os: "FortiSwitch",
  osVersion: "7.4.2",
  department: "Plant Ops",
  location: "Ashfield Plant",
  learnedLocation: "CENTRALFGT1",
  fortigateSightings: [{ fortigateDevice: "ASHF-EDGE-01" }],
};

describe("the two condition vocabularies", () => {
  it("device filter is a strict superset of the automations scope", () => {
    for (const field of Object.keys(SCOPE_FIELD_OPS)) {
      expect(DEVICE_FILTER_FIELD_OPS[field]).toBeDefined();
      for (const op of SCOPE_FIELD_OPS[field]!) {
        expect(DEVICE_FILTER_FIELD_OPS[field]).toContain(op);
      }
    }
  });

  it("adds exactly the four fields the flat criteria builder had", () => {
    expect(DEVICE_FILTER_ONLY_FIELDS.sort()).toEqual(
      ["department", "fortigate", "location", "osVersion"],
    );
  });

  it("offers the wildcard only on free-string fields", () => {
    expect(DEVICE_FILTER_FIELD_OPS.hostname).toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.location).toContain("matches");
    // Closed / CIDR-shaped fields keep their operator sets.
    expect(DEVICE_FILTER_FIELD_OPS.assetType).not.toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.status).not.toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.tag).not.toContain("matches");
    expect(DEVICE_FILTER_FIELD_OPS.subnet).not.toContain("matches");
    // ...and automations gains nothing.
    expect(SCOPE_FIELD_OPS.hostname).not.toContain("matches");
  });

  it("refuses the extra fields and the wildcard on an automations scope", () => {
    expect(() => scopeConditionSchema.parse(one("location", "contains", "Ashfield"))).toThrow();
    expect(() => scopeConditionSchema.parse(one("hostname", "matches", "PLV*"))).toThrow();
    // Both are fine on the device filter.
    expect(() => deviceFilterConditionSchema.parse(one("location", "contains", "Ashfield"))).not.toThrow();
    expect(() => deviceFilterConditionSchema.parse(one("hostname", "matches", "PLV*"))).not.toThrow();
  });

  it("refuses an operator the field does not support, in either vocabulary", () => {
    expect(() => deviceFilterConditionSchema.parse(one("assetType", "contains", "sw"))).toThrow();
    expect(() => deviceFilterConditionSchema.parse(one("tag", "matches", "region:*"))).toThrow();
  });

  it("refuses a malformed wildcard at save time", () => {
    const tooLong = "a".repeat(600);
    expect(() => deviceFilterConditionSchema.parse(one("hostname", "matches", tooLong))).toThrow();
  });
});

describe("evaluateScopeCondition — device-filter fields", () => {
  it("matches the three plain columns", () => {
    expect(evaluateScopeCondition(one("osVersion", "startsWith", "7.4"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("department", "equals", "plant ops"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("location", "contains", "ashfield"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("location", "contains", "knoxville"), ASSET)).toBe(false);
  });

  it("treats an absent column as empty rather than matching everything", () => {
    const bare: ScopeConditionAsset = { id: "a2" };
    expect(evaluateScopeCondition(one("department", "contains", "ops"), bare)).toBe(false);
    expect(evaluateScopeCondition(one("department", "notContains", "ops"), bare)).toBe(true);
  });

  it("applies the wildcard operator anchored, with metacharacters literal", () => {
    expect(evaluateScopeCondition(one("hostname", "matches", "plv-*-sw?"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("hostname", "matches", "plv-*-sw"), ASSET)).toBe(false); // anchored
    expect(evaluateScopeCondition(one("hostname", "matches", "*61f*"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("location", "matches", "ashfield.plant"), ASSET)).toBe(false); // "." is literal
  });

  describe("fortigate — one rule against several candidate names", () => {
    it("is satisfied by learnedLocation OR any sighting", () => {
      expect(evaluateScopeCondition(one("fortigate", "contains", "central"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("fortigate", "contains", "ashf-edge"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("fortigate", "equals", "ashf-edge-01"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("fortigate", "contains", "memphis"), ASSET)).toBe(false);
    });

    it("requires a negative operator to hold for EVERY name", () => {
      // Sighted behind ASHF-EDGE-01, so "not behind ashf" must be false even
      // though the other candidate name doesn't contain it.
      expect(evaluateScopeCondition(one("fortigate", "notContains", "ashf"), ASSET)).toBe(false);
      expect(evaluateScopeCondition(one("fortigate", "notContains", "memphis"), ASSET)).toBe(true);
    });

    it("reads no known gate as absence, not as a match", () => {
      const bare: ScopeConditionAsset = { id: "a3" };
      expect(evaluateScopeCondition(one("fortigate", "contains", "central"), bare)).toBe(false);
      expect(evaluateScopeCondition(one("fortigate", "notContains", "central"), bare)).toBe(true);
    });

    it("ignores a sighting row with no device name", () => {
      const asset: ScopeConditionAsset = { id: "a4", fortigateSightings: [{ fortigateDevice: null }] };
      expect(evaluateScopeCondition(one("fortigate", "contains", "x"), asset)).toBe(false);
    });
  });

  describe("interfaceName — one rule against the interface inventory", () => {
    it("is satisfied by ANY interface the device reports", () => {
      expect(evaluateScopeCondition(one("interfaceName", "equals", "port9"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("interfaceName", "contains", "link"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("interfaceName", "startsWith", "port"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("interfaceName", "equals", "port42"), ASSET)).toBe(false);
    });

    it("requires a negative operator to hold for EVERY interface", () => {
      // Has port9, so "no interface named port9" is false even though two other
      // ports differ from it.
      expect(evaluateScopeCondition(one("interfaceName", "notEquals", "port9"), ASSET)).toBe(false);
      expect(evaluateScopeCondition(one("interfaceName", "notEquals", "port42"), ASSET)).toBe(true);
      expect(evaluateScopeCondition(one("interfaceName", "notContains", "link"), ASSET)).toBe(false);
    });

    it("reads an uncollected inventory as absence, not as a match", () => {
      const bare: ScopeConditionAsset = { id: "a5" };
      expect(evaluateScopeCondition(one("interfaceName", "equals", "port9"), bare)).toBe(false);
      expect(evaluateScopeCondition(one("interfaceName", "notEquals", "port9"), bare)).toBe(true);
    });

    // The pairing the field exists for: "switches that have a fortilink port".
    it("ANDs with a device-type rule", () => {
      const tree = and(
        { field: "assetType", operator: "equals", value: "switch" },
        { field: "interfaceName", operator: "contains", value: "fortilink" },
      );
      expect(evaluateScopeCondition(tree, ASSET)).toBe(true);
      expect(evaluateScopeCondition(tree, { ...ASSET, assetType: "firewall" })).toBe(false);
      expect(evaluateScopeCondition(tree, { ...ASSET, interfaces: [{ ifName: "port1" }] })).toBe(false);
    });

    it("is offered to BOTH vocabularies, with the wildcard only on the wider one", () => {
      expect(SCOPE_FIELD_OPS.interfaceName).toContain("equals");
      expect(SCOPE_FIELD_OPS.interfaceName).not.toContain("matches");
      expect(DEVICE_FILTER_FIELD_OPS.interfaceName).toContain("matches");
      expect(scopeConditionMeta(SCOPE_FIELD_OPS).fields.map((f) => f.field)).toContain("interfaceName");
    });

    // An interface is a COMPONENT, not a way of naming which devices a rule is
    // about, so it must not move the rule 18 carve-out ladder.
    it("does not raise scope specificity", () => {
      const byType = scopeRank({ condition: one("assetType", "equals", "switch") } as never);
      const byTypeAndIf = scopeRank({
        condition: and(
          { field: "assetType", operator: "equals", value: "switch" },
          { field: "interfaceName", operator: "contains", value: "fortilink" },
        ),
      } as never);
      expect(byTypeAndIf).toBe(byType);
      expect(scopeRank({ condition: one("interfaceName", "equals", "port9") } as never)).toBe(0);
    });
  });

  describe("ipBlock — the IPAM block an address falls inside", () => {
    // The block's own CIDR is what is stored, so the field is the `subnet`
    // predicate under a different picker. These pin that equivalence: if the
    // two ever diverge, a rule an operator built from the block list would
    // start meaning something other than the subnet rule beside it.
    const IN_BLOCK: ScopeConditionAsset = { ...ASSET, ipAddress: "10.20.7.9" };
    const OUT_OF_BLOCK: ScopeConditionAsset = { ...ASSET, ipAddress: "10.99.7.9" };

    it("matches an address inside the block and not one outside it", () => {
      expect(evaluateScopeCondition(one("ipBlock", "inCidr", "10.20.0.0/16"), IN_BLOCK)).toBe(true);
      expect(evaluateScopeCondition(one("ipBlock", "inCidr", "10.20.0.0/16"), OUT_OF_BLOCK)).toBe(false);
      expect(evaluateScopeCondition(one("ipBlock", "notInCidr", "10.20.0.0/16"), OUT_OF_BLOCK)).toBe(true);
    });

    // The block is the whole point: an address in the range but in no defined
    // Subnet row still matches, which a subnet-by-subnet filter cannot say.
    it("covers the block's range, not just its defined subnets", () => {
      expect(evaluateScopeCondition(one("ipBlock", "inCidr", "10.20.0.0/16"),
        { ...ASSET, ipAddress: "10.20.250.1" })).toBe(true);
    });

    it("reads an asset with no IP as outside every block", () => {
      const noIp: ScopeConditionAsset = { ...ASSET, ipAddress: null };
      expect(evaluateScopeCondition(one("ipBlock", "inCidr", "10.20.0.0/16"), noIp)).toBe(false);
      expect(evaluateScopeCondition(one("ipBlock", "notInCidr", "10.20.0.0/16"), noIp)).toBe(true);
    });

    it("is offered to BOTH vocabularies, CIDR-shaped in each", () => {
      expect(SCOPE_FIELD_OPS.ipBlock).toEqual(["inCidr", "notInCidr"]);
      // Closed-shape like `subnet`: the flat builder never offered a pattern
      // against a CIDR, so widening to the device filter must not add one.
      expect(DEVICE_FILTER_FIELD_OPS.ipBlock).not.toContain("matches");
      for (const vocab of [SCOPE_FIELD_OPS, DEVICE_FILTER_FIELD_OPS]) {
        expect(scopeConditionMeta(vocab).fields.map((f) => f.field)).toContain("ipBlock");
      }
      const meta = scopeConditionMeta(DEVICE_FILTER_FIELD_OPS).fields.find((f) => f.field === "ipBlock");
      expect(meta?.label).toBe("IP block");
      expect(meta?.optionsFrom).toBe("ipBlocks");
    });

    it("refuses a value that is not a CIDR or an IP", () => {
      expect(scopeConditionSchema.safeParse(one("ipBlock", "inCidr", "Corporate Core")).success).toBe(false);
      expect(scopeConditionSchema.safeParse(one("ipBlock", "inCidr", "10.20.0.0/16")).success).toBe(true);
      // A bare address is a host route, exactly as `subnet` reads one.
      expect(scopeConditionSchema.safeParse(one("ipBlock", "inCidr", "10.20.7.9")).success).toBe(true);
    });

    // A block CONTAINS subnets, so it targets less precisely than one — this is
    // the ordering the rule 18 carve-out ladder resolves ties by.
    it("ranks below a subnet and above a tag on the specificity ladder", () => {
      const rank = (field: string) => scopeRank({ condition: one(field, "inCidr", "10.20.0.0/16") } as never);
      expect(rank("ipBlock")).toBeLessThan(rank("subnet"));
      expect(rank("ipBlock")).toBeGreaterThan(
        scopeRank({ condition: one("tag", "has", "core") } as never),
      );
    });
  });

  it("keeps the automations fields working unchanged", () => {
    expect(evaluateScopeCondition(one("assetType", "equals", "switch"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("hostname", "endsWith", "sw1"), ASSET)).toBe(true);
    expect(evaluateScopeCondition(one("os", "notContains", "windows"), ASSET)).toBe(true);
  });
});

describe("scopeConditionMeta", () => {
  it("publishes only the fields of the vocabulary it is given", () => {
    const auto = scopeConditionMeta(SCOPE_FIELD_OPS).fields.map((f) => f.field);
    const contact = scopeConditionMeta(DEVICE_FILTER_FIELD_OPS).fields.map((f) => f.field);
    expect(auto).not.toContain("location");
    expect(contact).toContain("location");
    expect(contact).toContain("fortigate");
    for (const f of auto) expect(contact).toContain(f);
  });

  it("omits assetId from both (valid to store, not offered to build)", () => {
    expect(scopeConditionMeta(SCOPE_FIELD_OPS).fields.map((f) => f.field)).not.toContain("assetId");
    expect(scopeConditionMeta(DEVICE_FILTER_FIELD_OPS).fields.map((f) => f.field)).not.toContain("assetId");
  });

  it("carries the precedence ladder for automations only", () => {
    expect(scopeConditionMeta(SCOPE_FIELD_OPS)).toHaveProperty("specificity");
    expect(scopeConditionMeta(DEVICE_FILTER_FIELD_OPS)).not.toHaveProperty("specificity");
  });

  it("labels the wildcard operator", () => {
    expect(scopeConditionMeta(DEVICE_FILTER_FIELD_OPS).operatorLabels.matches).toMatch(/wildcard/i);
  });
});
