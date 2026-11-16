/**
 * tests/unit/deviceFilterService.test.ts — CQ-T010 own suite for
 * src/services/deviceFilterService.ts (business rule 124: device filters).
 *
 * The contract (polaris-change-impact → alerting-scope-dimensions.md): no SQL
 * prefilter derived from the tree, `opts.where` ANDed outside it, every
 * relation-backed field selected only when a rule asks for it, the scalar
 * select covering the whole DEVICE_FILTER vocabulary, and an empty tree
 * resolving to the whole eligible fleet. The evaluator is the REAL one;
 * Prisma is the shared stub and the relation-leaf decoration is mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));

const rel = vi.hoisted(() => ({ decorateRelationLeafHits: vi.fn(async () => undefined) }));
vi.mock("../../src/services/scopeRelationIndex.js", () => ({ decorateRelationLeafHits: rel.decorateRelationLeafHits }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { DEVICE_FILTER_FIELD_OPS, relationLeafKey, type ScopeConditionGroup } from "../../src/services/notificationTypes.js";
import {
  deviceFilterSelect,
  resolveDeviceFilterAssetIds,
  resolveDeviceFilterAssetIdsMany,
  INTERFACE_CONDITION_SELECT,
} from "../../src/services/deviceFilterService.js";

const p = prisma as any;

const leaf = (field: string, operator: string, value: string) => ({ field, operator, value });
const and = (...children: ScopeConditionGroup["children"]): ScopeConditionGroup => ({ op: "and", children });
const or = (...children: ScopeConditionGroup["children"]): ScopeConditionGroup => ({ op: "or", children });
const none = (...children: ScopeConditionGroup["children"]): ScopeConditionGroup => ({ op: "none", children });

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id, assetType: "switch", manufacturer: "Fortinet", model: "FS-148F", hostname: id, os: "FortiSwitchOS",
    osVersion: "7.4.2", department: "IT", location: "HQ", status: "active", ipAddress: "10.0.0.1", tags: [], ...over,
  };
}

const SCALARS = ["id", "assetType", "manufacturer", "model", "hostname", "os", "osVersion", "department", "location", "status", "ipAddress", "tags"];

beforeEach(() => {
  resetDbStub();
  rel.decorateRelationLeafHits.mockReset();
  rel.decorateRelationLeafHits.mockResolvedValue(undefined);
  stubbed(p.asset.findMany).mockResolvedValue([]);
});

describe("INTERFACE_CONDITION_SELECT", () => {
  it("reads the port name and its native VLAN", () => {
    expect(INTERFACE_CONDITION_SELECT).toEqual({ ifName: true, nativeVlan: true });
  });
});

describe("deviceFilterSelect", () => {
  it("with no trees selects exactly the scalar columns", () => {
    const s = deviceFilterSelect([]);
    expect(Object.keys(s).sort()).toEqual([...SCALARS].sort());
  });

  it("ignores null / undefined trees", () => {
    expect(deviceFilterSelect([null, undefined])).toEqual(deviceFilterSelect([]));
  });

  it("joins the gate sightings + learnedLocation only for a fortigate leaf", () => {
    const s = deviceFilterSelect([and(leaf("fortigate", "contains", "HQ"))]) as Record<string, unknown>;
    expect(s.learnedLocation).toBe(true);
    expect(s.fortigateSightings).toEqual({ select: { fortigateDevice: true } });
    const plain = deviceFilterSelect([and(leaf("hostname", "contains", "x"))]) as Record<string, unknown>;
    expect(plain).not.toHaveProperty("fortigateSightings");
    expect(plain).not.toHaveProperty("learnedLocation");
  });

  it("joins apVaps only for an ssid leaf, and managedAgent only for an agentInstalled leaf — nested anywhere", () => {
    const s = deviceFilterSelect([and(or(leaf("ssid", "equals", "GUEST")), none(leaf("agentInstalled", "equals", "yes")))]) as Record<string, unknown>;
    expect(s.apVaps).toEqual({ select: { ssid: true } });
    expect(s.managedAgent).toEqual({ select: { installStatus: true } });
  });

  it("never joins interfaces from the tree — only when the caller asks (single-asset path)", () => {
    const tree = and(leaf("interfaceName", "equals", "port1"), leaf("nativeVlan", "equals", "30"));
    expect(deviceFilterSelect([tree])).not.toHaveProperty("interfaces");
    expect(deviceFilterSelect([tree], { needsInterfaces: true })).toMatchObject({ interfaces: { select: INTERFACE_CONDITION_SELECT } });
    expect(deviceFilterSelect([], { needsInterfaces: false })).not.toHaveProperty("interfaces");
  });

  it("unions the relations several trees ask for", () => {
    const s = deviceFilterSelect([and(leaf("fortigate", "contains", "a")), and(leaf("ssid", "equals", "b"))]) as Record<string, unknown>;
    expect(s).toHaveProperty("fortigateSightings");
    expect(s).toHaveProperty("apVaps");
    expect(s).not.toHaveProperty("managedAgent");
  });

  it("covers every scalar field of the DEVICE_FILTER vocabulary (a missing column matches nothing)", () => {
    // The relation-backed and derived fields are read elsewhere: tag → tags,
    // subnet / ipBlock → ipAddress, assetId → id.
    const viaOther: Record<string, string | null> = {
      tag: "tags", subnet: "ipAddress", ipBlock: "ipAddress", assetId: "id",
      fortigate: null, interfaceName: null, ssid: null, agentInstalled: null, nativeVlan: null,
    };
    const s = deviceFilterSelect([]) as Record<string, unknown>;
    for (const field of Object.keys(DEVICE_FILTER_FIELD_OPS)) {
      const col = field in viaOther ? viaOther[field] : field;
      if (col) expect(s[col], `select must cover ${field} (column ${col})`).toBe(true);
    }
  });
});

describe("resolveDeviceFilterAssetIds", () => {
  it("reads the fleet with NO where of its own, decorates the rows, and returns the matching ids", async () => {
    const rows = [row("sw1", { hostname: "plv-sw1" }), row("sw2", { hostname: "other" })];
    stubbed(p.asset.findMany).mockResolvedValue(rows);
    const tree = and(leaf("hostname", "startsWith", "plv"));
    const ids = await resolveDeviceFilterAssetIds(tree);
    expect(ids).toEqual(new Set(["sw1"]));
    const q = stubbed(p.asset.findMany).mock.calls[0]![0];
    expect(q).not.toHaveProperty("where");
    expect(q.select).toEqual(deviceFilterSelect([tree]));
    expect(rel.decorateRelationLeafHits).toHaveBeenCalledWith(rows, [tree]);
  });

  it("ANDs the caller's eligibility where outside the tree, verbatim", async () => {
    const where = { status: { not: "decommissioned" as const } };
    await resolveDeviceFilterAssetIds(and(leaf("status", "equals", "active")), { where });
    expect(stubbed(p.asset.findMany).mock.calls[0]![0].where).toBe(where);
  });

  it("an empty and-tree is the whole (eligible) fleet; an empty or-tree is nobody", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([row("a"), row("b")]);
    await expect(resolveDeviceFilterAssetIds(and())).resolves.toEqual(new Set(["a", "b"]));
    await expect(resolveDeviceFilterAssetIds(or())).resolves.toEqual(new Set());
  });

  it("evaluates or / none groups in memory (no SQL narrowing could be sound)", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([
      row("a", { manufacturer: "Cisco" }),
      row("b", { manufacturer: "Fortinet", department: "OT" }),
      row("c", { manufacturer: "Fortinet", department: "IT" }),
    ]);
    const tree = and(or(leaf("manufacturer", "equals", "cisco"), leaf("department", "equals", "ot")));
    await expect(resolveDeviceFilterAssetIds(tree)).resolves.toEqual(new Set(["a", "b"]));
    await expect(resolveDeviceFilterAssetIds(none(leaf("manufacturer", "equals", "cisco")))).resolves.toEqual(new Set(["b", "c"]));
  });

  it("reads the device-filter extras (osVersion, location) and the wildcard operator", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([
      row("a", { osVersion: "7.4.2", location: "Plant-61" }),
      row("b", { osVersion: "7.2.9", location: "Plant-61" }),
      row("c", { osVersion: "7.4.1", location: null }),
    ]);
    const tree = and(leaf("osVersion", "startsWith", "7.4"), leaf("location", "matches", "plant-*"));
    await expect(resolveDeviceFilterAssetIds(tree)).resolves.toEqual(new Set(["a"]));
  });

  it("reads a relation verdict the decoration stamped onto the row", async () => {
    const rows = [row("a"), row("b")];
    stubbed(p.asset.findMany).mockResolvedValue(rows);
    const rule = leaf("ssid", "equals", "GUEST");
    const tree = and(rule);
    rel.decorateRelationLeafHits.mockImplementation((async (rs: any[]) => {
      for (const r of rs) r.relationLeafHits = new Map([[relationLeafKey(rule), r.id === "b"]]);
    }) as never);
    await expect(resolveDeviceFilterAssetIds(tree)).resolves.toEqual(new Set(["b"]));
  });

  it("an undecorated relation leaf on the fleet path matches no device (no relation is joined)", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([row("a")]);
    await expect(resolveDeviceFilterAssetIds(and(leaf("interfaceName", "equals", "port1")))).resolves.toEqual(new Set());
  });

  it("an empty fleet resolves to an empty set", async () => {
    await expect(resolveDeviceFilterAssetIds(and())).resolves.toEqual(new Set());
  });
});

describe("resolveDeviceFilterAssetIdsMany", () => {
  it("returns [] for no trees without reading anything", async () => {
    await expect(resolveDeviceFilterAssetIdsMany([])).resolves.toEqual([]);
    expect(p.asset.findMany).not.toHaveBeenCalled();
    expect(rel.decorateRelationLeafHits).not.toHaveBeenCalled();
  });

  it("is ONE fleet read with the union select and ONE decoration pass for every tree", async () => {
    const rows = [row("a", { manufacturer: "Cisco" }), row("b")];
    stubbed(p.asset.findMany).mockResolvedValue(rows);
    const t1 = and(leaf("manufacturer", "equals", "cisco"));
    const t2 = and(leaf("fortigate", "contains", "hq"));
    const t3 = and();
    const out = await resolveDeviceFilterAssetIdsMany([t1, t2, t3]);
    expect(p.asset.findMany).toHaveBeenCalledTimes(1);
    expect(stubbed(p.asset.findMany).mock.calls[0]![0]).toEqual({ select: deviceFilterSelect([t1, t2, t3]) });
    expect(rel.decorateRelationLeafHits).toHaveBeenCalledTimes(1);
    expect(rel.decorateRelationLeafHits).toHaveBeenCalledWith(rows, [t1, t2, t3]);
    expect(out).toEqual([new Set(["a"]), new Set(), new Set(["a", "b"])]);
  });

  it("applies the per-tree eligibility in memory, the twin of the single-tree where", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([row("a"), row("dead", { status: "decommissioned" })]);
    const mentionsStatus = and(leaf("status", "equals", "decommissioned"));
    const plain = and();
    const eligible = vi.fn((cond: ScopeConditionGroup, r: { status?: unknown }) =>
      cond === mentionsStatus || r.status !== "decommissioned");
    const [a, b] = await resolveDeviceFilterAssetIdsMany([mentionsStatus, plain], eligible);
    expect(a).toEqual(new Set(["dead"]));
    expect(b).toEqual(new Set(["a"]));
    expect(eligible).toHaveBeenCalledWith(plain, expect.objectContaining({ id: "dead" }));
  });

  it("gives each tree its own result set", async () => {
    stubbed(p.asset.findMany).mockResolvedValue([row("a")]);
    const [x, y] = await resolveDeviceFilterAssetIdsMany([and(), and()]);
    expect(x).not.toBe(y);
  });
});
