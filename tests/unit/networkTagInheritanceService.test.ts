/**
 * tests/unit/networkTagInheritanceService.test.ts — CQ-T010 own suite for
 * src/services/networkTagInheritanceService.ts (business rule 137).
 *
 * tests/unit/networkTagInheritance.test.ts pins the pure planner
 * (`planNetworkTagInheritance`, `portCarriesVlan`, `isInheritableNetworkTag`).
 * This suite drives the DB half — `reconcileNetworkTags` (load → diff → write,
 * the provenance rules) and the coalesced `scheduleNetworkTagReconcile` — with
 * the Prisma stub.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../src/utils/logger.js", () => ({ logger: log }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { reconcileNetworkTags, scheduleNetworkTagReconcile } from "../../src/services/networkTagInheritanceService.js";

type Port = { assetId: string; ifName: string; nativeVlan: number | null; taggedVlans: number[]; trunksAllVlans: boolean };
type PortTag = { assetId: string; ifName: string; tag: string; source: string };

const GATE = { id: "g", hostname: "FGT-A", serialNumber: "FGTA0000001", assetType: "firewall", fortinetTopology: null };
const SWITCH = { id: "s1", hostname: "IDF-1", serialNumber: "S1", assetType: "switch", fortinetTopology: { controllerSerial: "FGTA0000001", uplinkInterface: "fortilink" } };
const NET30 = { fortigateSerial: "FGTA0000001", fortigateDevice: null, fortigateVlanParent: "FortiLink", vlan: 30, tags: ["Critical", "region:east", "fortimanager"] };

let subnets: unknown[];
let gates: unknown[];
let switches: unknown[];
let ports: Port[];
let portTags: PortTag[];
let assetTags: Map<string, string[]>;
let assignments: { assetId: string; tag: string }[];
let registry: { id: string; name: string }[];
let autoAssign: { tagId: string; assetId: string }[];

const subnetFind = stubbed(prisma.subnet.findMany);
const assetFind = stubbed(prisma.asset.findMany);
const assetUpdate = stubbed(prisma.asset.update);
const ifFind = stubbed(prisma.assetInterface.findMany);
const tagFind = stubbed(prisma.assetInterfaceTag.findMany);
const tagCreate = stubbed(prisma.assetInterfaceTag.createMany);
const tagDelete = stubbed(prisma.assetInterfaceTag.deleteMany);
const ntaFind = stubbed(prisma.networkTagAssignment.findMany);
const ntaCreate = stubbed(prisma.networkTagAssignment.createMany);
const ntaDelete = stubbed(prisma.networkTagAssignment.deleteMany);
const registryFind = stubbed(prisma.tag.findMany);
const autoFind = stubbed(prisma.tagAutoAssignment.findMany);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  log.warn.mockReset();
  subnets = [NET30];
  gates = [GATE];
  switches = [SWITCH];
  ports = [
    { assetId: "s1", ifName: "port1", nativeVlan: 30, taggedVlans: [], trunksAllVlans: false },
    { assetId: "s1", ifName: "port2", nativeVlan: 1, taggedVlans: [30], trunksAllVlans: false },
    { assetId: "s1", ifName: "port3", nativeVlan: 40, taggedVlans: [], trunksAllVlans: false },
  ];
  portTags = [];
  assetTags = new Map([["s1", []]]);
  assignments = [];
  registry = [];
  autoAssign = [];

  subnetFind.mockImplementation(async () => subnets);
  assetFind.mockImplementation(async (args: { where: Record<string, any> }) => {
    if (args.where.assetType === "firewall") return gates;
    if (args.where.assetType === "switch") return switches;
    const ids: string[] = args.where.id.in;
    return ids.filter((id) => assetTags.has(id)).map((id) => ({ id, tags: assetTags.get(id) }));
  });
  ifFind.mockImplementation(async () => ports);
  tagFind.mockImplementation(async (args: { where: Record<string, any> }) =>
    portTags.filter((t) =>
      (args.where.assetId === undefined || t.assetId === args.where.assetId) &&
      (args.where.source === undefined || t.source === args.where.source) &&
      (args.where.tag === undefined || args.where.tag.in.includes(t.tag))));
  ntaFind.mockImplementation(async (args: { where: Record<string, any> }) =>
    assignments.filter((a) => args.where.assetId === undefined || a.assetId === args.where.assetId));
  registryFind.mockImplementation(async () => registry);
  autoFind.mockImplementation(async () => autoAssign);
  tagCreate.mockResolvedValue({ count: 0 });
  tagDelete.mockResolvedValue({ count: 0 });
  ntaCreate.mockResolvedValue({ count: 0 });
  ntaDelete.mockResolvedValue({ count: 0 });
  assetUpdate.mockImplementation(async (args: unknown) => args);
});

describe("reconcileNetworkTags — loading", () => {
  it("asks only for gated, VLAN'd, non-deprecated networks that carry tags", async () => {
    await reconcileNetworkTags();
    expect(subnetFind.mock.calls[0][0].where).toEqual({
      vlan: { not: null },
      fortigateVlanParent: { not: null },
      status: { not: "deprecated" },
      NOT: { tags: { isEmpty: true } },
      OR: [{ fortigateSerial: { not: null } }, { fortigateDevice: { not: null } }],
    });
  });

  it("reads ports by VLAN, never an allow-all trunk, and never an IN list of switches", async () => {
    await reconcileNetworkTags();
    const where = ifFind.mock.calls[0][0].where;
    expect(where).toEqual({ trunksAllVlans: false, OR: [{ nativeVlan: { in: [30] } }, { taggedVlans: { hasSome: [30] } }] });
    // Decommissioned switches are out of scope.
    const swCall = assetFind.mock.calls.find((c) => c[0].where.assetType === "switch")!;
    expect(swCall[0].where).toEqual({ assetType: "switch", status: { not: "decommissioned" } });
  });

  it("skips the asset and port reads when no network has an inheritable tag", async () => {
    subnets = [{ ...NET30, tags: ["region:east", "dhcp-discovered", "azure:sub"] }];
    const out = await reconcileNetworkTags();
    expect(assetFind.mock.calls.filter((c) => c[0].where.assetType)).toHaveLength(0);
    expect(ifFind).not.toHaveBeenCalled();
    expect(out).toEqual({ assetsAdded: 0, assetsRemoved: 0, portsAdded: 0, portsRemoved: 0 });
  });

  it("skips the port read when there is no switch in scope", async () => {
    switches = [];
    await reconcileNetworkTags();
    expect(ifFind).not.toHaveBeenCalled();
  });

  it("scopes every read to one switch when given an assetId", async () => {
    await reconcileNetworkTags({ assetId: "s1" });
    const swCall = assetFind.mock.calls.find((c) => c[0].where.assetType === "switch")!;
    expect(swCall[0].where.id).toBe("s1");
    expect(ifFind.mock.calls[0][0].where.assetId).toBe("s1");
    for (const c of tagFind.mock.calls) expect(c[0].where.assetId).toBe("s1");
    expect(ntaFind.mock.calls[0][0].where).toEqual({ assetId: "s1" });
  });
});

describe("reconcileNetworkTags — adding", () => {
  it("tags the ports carrying the VLAN (native or tagged) and the switch, with provenance", async () => {
    const out = await reconcileNetworkTags();
    expect(out).toEqual({ assetsAdded: 1, assetsRemoved: 0, portsAdded: 2, portsRemoved: 0 });
    expect(tagCreate).toHaveBeenCalledWith({
      data: [
        { assetId: "s1", ifName: "port1", tag: "Critical", source: "network" },
        { assetId: "s1", ifName: "port2", tag: "Critical", source: "network" },
      ],
      skipDuplicates: true,
    });
    expect(assetUpdate).toHaveBeenCalledWith({ where: { id: "s1" }, data: { tags: ["Critical"] } });
    expect(ntaCreate).toHaveBeenCalledWith({ data: [{ assetId: "s1", tag: "Critical" }], skipDuplicates: true });
  });

  it("adds only to an unoccupied port: a manual row of the tag occupies it", async () => {
    portTags = [{ assetId: "s1", ifName: "port1", tag: "Critical", source: "manual" }];
    const out = await reconcileNetworkTags();
    expect(out.portsAdded).toBe(1);
    expect(tagCreate.mock.calls[0][0].data).toEqual([{ assetId: "s1", ifName: "port2", tag: "Critical", source: "network" }]);
    // The manual row is never removed.
    expect(tagDelete).not.toHaveBeenCalled();
  });

  it("never claims a tag the switch already carries without provenance", async () => {
    assetTags.set("s1", ["Critical", "other"]);
    const out = await reconcileNetworkTags();
    expect(out.assetsAdded).toBe(0);
    expect(assetUpdate).not.toHaveBeenCalled();
    expect(ntaCreate).not.toHaveBeenCalled();
  });

  it("does not put back one of ours an operator took off the switch", async () => {
    assignments = [{ assetId: "s1", tag: "Critical" }];
    assetTags.set("s1", []);
    portTags = [
      { assetId: "s1", ifName: "port1", tag: "Critical", source: "network" },
      { assetId: "s1", ifName: "port2", tag: "Critical", source: "network" },
    ];
    const out = await reconcileNetworkTags();
    expect(out).toEqual({ assetsAdded: 0, assetsRemoved: 0, portsAdded: 0, portsRemoved: 0 });
    expect(assetUpdate).not.toHaveBeenCalled();
  });

  it("writes nothing in a steady state", async () => {
    assignments = [{ assetId: "s1", tag: "Critical" }];
    assetTags.set("s1", ["Critical"]);
    portTags = [
      { assetId: "s1", ifName: "port1", tag: "Critical", source: "network" },
      { assetId: "s1", ifName: "port2", tag: "Critical", source: "network" },
    ];
    await reconcileNetworkTags();
    for (const f of [tagCreate, tagDelete, assetUpdate, ntaCreate, ntaDelete]) expect(f).not.toHaveBeenCalled();
  });

  it("hands nothing down to a switch under a different gate", async () => {
    switches = [{ ...SWITCH, fortinetTopology: { controllerSerial: "OTHER", uplinkInterface: "fortilink" } }];
    const out = await reconcileNetworkTags();
    expect(out.portsAdded + out.assetsAdded).toBe(0);
  });
});

describe("reconcileNetworkTags — removing", () => {
  it("removes only its own port rows and switch tags when the inheritance ends", async () => {
    subnets = [];
    portTags = [
      { assetId: "s1", ifName: "port1", tag: "Old", source: "network" },
      { assetId: "s1", ifName: "port9", tag: "Old", source: "manual" },
    ];
    assignments = [{ assetId: "s1", tag: "Old" }];
    assetTags.set("s1", ["Old", "keep"]);
    const out = await reconcileNetworkTags();
    expect(out).toEqual({ assetsAdded: 0, assetsRemoved: 1, portsAdded: 0, portsRemoved: 1 });
    expect(tagDelete).toHaveBeenCalledWith({ where: { source: "network", OR: [{ assetId: "s1", ifName: "port1", tag: "Old" }] } });
    expect(assetUpdate).toHaveBeenCalledWith({ where: { id: "s1" }, data: { tags: ["keep"] } });
    expect(ntaDelete).toHaveBeenCalledWith({ where: { OR: [{ assetId: "s1", tag: "Old" }] } });
  });

  it("keeps the switch tag when a tag filter also owns it there", async () => {
    subnets = [];
    assignments = [{ assetId: "s1", tag: "Old" }];
    assetTags.set("s1", ["Old"]);
    registry = [{ id: "t1", name: "Old" }];
    autoAssign = [{ tagId: "t1", assetId: "s1" }];
    const out = await reconcileNetworkTags();
    expect(assetUpdate).not.toHaveBeenCalled();
    // Our provenance row still goes.
    expect(ntaDelete).toHaveBeenCalledTimes(1);
    expect(out.assetsRemoved).toBe(1);
  });

  it("does not consult tag filters when nothing is being removed", async () => {
    await reconcileNetworkTags();
    expect(registryFind).not.toHaveBeenCalled();
    expect(autoFind).not.toHaveBeenCalled();
  });

  it("deletes stale port rows in chunks of 50", async () => {
    subnets = [];
    portTags = Array.from({ length: 120 }, (_, i) => ({ assetId: "s1", ifName: `port${i}`, tag: "Old", source: "network" }));
    const out = await reconcileNetworkTags();
    expect(out.portsRemoved).toBe(120);
    expect(tagDelete).toHaveBeenCalledTimes(3);
    expect(tagDelete.mock.calls.map((c) => c[0].where.OR.length)).toEqual([50, 50, 20]);
  });

  it("swaps one inherited tag for another in a single asset update", async () => {
    assignments = [{ assetId: "s1", tag: "Old" }];
    assetTags.set("s1", ["Old"]);
    const out = await reconcileNetworkTags();
    expect(out).toMatchObject({ assetsAdded: 1, assetsRemoved: 1 });
    expect(assetUpdate).toHaveBeenCalledTimes(1);
    expect(assetUpdate).toHaveBeenCalledWith({ where: { id: "s1" }, data: { tags: ["Critical"] } });
  });
});

describe("scheduleNetworkTagReconcile", () => {
  const settle = async () => {
    for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
  };

  it("writes one tag.network_inherited Event, with the actor, when anything moved", async () => {
    scheduleNetworkTagReconcile("alice");
    await settle();
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "tag.network_inherited",
      resourceType: "tag",
      actor: "alice",
      message: "Network tags inherited: switches +1 / -0, ports +2 / -0",
      details: { assetsAdded: 1, assetsRemoved: 0, portsAdded: 2, portsRemoved: 0 },
    });
  });

  it("writes no Event when nothing moved", async () => {
    subnets = [];
    scheduleNetworkTagReconcile();
    await settle();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("folds edits that land while one runs into a single rerun", async () => {
    subnets = [];
    scheduleNetworkTagReconcile();
    scheduleNetworkTagReconcile();
    scheduleNetworkTagReconcile();
    await settle();
    expect(subnetFind).toHaveBeenCalledTimes(2);
  });

  it("swallows a failure (logged as a warning) and runs again on the next schedule", async () => {
    subnetFind.mockRejectedValueOnce(new Error("db gone"));
    scheduleNetworkTagReconcile();
    await settle();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0][0]).toEqual({ err: "db gone" });
    subnets = [];
    scheduleNetworkTagReconcile();
    await settle();
    expect(subnetFind).toHaveBeenCalledTimes(2);
  });
});
