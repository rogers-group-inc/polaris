/**
 * tests/unit/dhcpPhasesExtracted8.test.ts — syncDhcpSubnets Phase 1, subnet
 * sync, now src/services/discovery/dhcp/subnetSync.ts (CQ-B060 slice 9). The
 * chassis decisions themselves are pinned in chassisIdentity's own suite; the
 * subnet create / supersede paths against a real database by the
 * subnetSupersedeDeprecated and chassis integration suites.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";

const db = {
  subnetUpdate: stubbed(prisma.subnet.update),
};

const m = vi.hoisted(() => ({
  createChecked: vi.fn(),
  snapshot: vi.fn(),
  archive: vi.fn(),
  raiseConflict: vi.fn(),
}));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
beforeEach(() => resetEventLogStub());
vi.mock("../../src/services/subnetService.js", () => ({ createSubnetRowChecked: m.createChecked }));
vi.mock("../../src/services/subnetArchiveService.js", () => ({ snapshotSubnet: m.snapshot, archiveSubnet: m.archive }));
vi.mock("../../src/services/subnetChassisConflictService.js", () => ({ raiseChassisReplacedConflict: m.raiseConflict }));

const { syncDiscoveredSubnets } = await import("../../src/services/discovery/dhcp/subnetSync.js");
const { AppError } = await import("../../src/utils/errors.js");

const BLOCK = { id: "b1", cidr: "10.0.0.0/8" };
beforeEach(() => {
  resetDbStub();
  vi.clearAllMocks();
  db.subnetUpdate.mockResolvedValue({});
  m.createChecked.mockImplementation(async (data: Record<string, unknown>) => ({ id: `new-${String(data.cidr)}`, ...data }));
  m.snapshot.mockResolvedValue({ archivedSubnetId: "arch-1", reservationCount: 3 });
  m.archive.mockResolvedValue({ reservationCount: 2 });
  m.raiseConflict.mockResolvedValue("raised");
});

type Entry = Record<string, unknown>;
const entry = (over: Entry = {}): Entry => ({ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FGT-A", fortigateSerial: "FGT60F0000000001", ...over });

function run(subnets: Entry[], over: Record<string, unknown> = {}) {
  const state = {
    result: { subnets } as never,
    allSubnets: [] as any[],
    subnetByCidr: new Map<string, any>(),
    siblingsByBlockId: new Map<string, any[]>(),
    deprecatedByBlockCidr: new Map<string, any>(),
    subnetExclusions: [] as any[],
    clusterSerialsByDevice: new Map<string, Set<string>>(),
    findParentBlock: (cidr: string) => (cidr.startsWith("10.") ? BLOCK : undefined),
    created: [] as string[], updated: [] as string[], skipped: [] as string[],
    integrationId: "i1", integrationName: "FMG", integrationType: "fortimanager", integrationLabel: "FortiManager",
    actor: "system", syncLog: vi.fn(),
    ...over,
  };
  return { state, done: syncDiscoveredSubnets(state as never) };
}

describe("Phase 1 — new networks", () => {
  it("creates a network through the locked seam, named for what served it, and indexes it for later phases", async () => {
    const { state, done } = run([entry({ vlan: 20, vlanParent: "port5" })]);
    await done;
    expect(m.createChecked).toHaveBeenCalledWith(expect.objectContaining({
      blockId: "b1", cidr: "10.1.0.0/24", name: "DHCP: lan (FGT-A)", purpose: "Discovered from FortiManager DHCP",
      discoveredBy: "i1", fortigateDevice: "FGT-A", fortigateSerial: "FGT60F0000000001", vlan: 20,
      fortigateInterface: "lan", fortigateVlanParent: "port5", tags: ["dhcp-discovered", "fortimanager"],
    }), { exclusions: state.subnetExclusions });
    expect(state.created).toEqual(["10.1.0.0/24"]);
    expect(state.subnetByCidr.get("10.1.0.0/24")).toMatchObject({ id: "new-10.1.0.0/24" });
    expect(state.siblingsByBlockId.get("b1")).toHaveLength(1);
    expect(state.allSubnets).toHaveLength(1);
  });

  it("labels a DHCPv6 scope and a router-advertised prefix by origin (rule 125)", async () => {
    await run([entry({ cidr: "10.6.0.0/24", origin: "dhcp6" }), entry({ cidr: "10.7.0.0/24", origin: "ra" })]).done;
    expect(m.createChecked.mock.calls.map((c) => c[0].name)).toEqual(["DHCPv6: lan (FGT-A)", "IPv6 RA: lan (FGT-A)"]);
  });

  it("skips an invalid CIDR, an excluded one (rule 42), one with no block, and one overlapping a known sibling", async () => {
    const { state, done } = run(
      [entry({ cidr: "not-a-cidr" }), entry({ cidr: "10.9.0.0/24" }), entry({ cidr: "192.0.2.0/24" }), entry({ cidr: "10.3.0.0/25" })],
      {
        subnetExclusions: [{ id: "x1", cidr: "10.9.0.0/16", name: "shared guest" }],
        siblingsByBlockId: new Map([["b1", [{ cidr: "10.3.0.0/24" }]]]),
      },
    );
    await done;
    expect(state.skipped).toEqual([
      "not-a-cidr (invalid CIDR)",
      '10.9.0.0/24 (excluded as "shared guest")',
      "192.0.2.0/24 (no matching parent block)",
      "10.3.0.0/25 (overlaps 10.3.0.0/24)",
    ]);
    expect(m.createChecked).not.toHaveBeenCalled();
  });

  it("a 409 from the locked seam is a normal skip, logged as info, not an error", async () => {
    m.createChecked.mockRejectedValueOnce(new AppError(409, "overlaps 10.1.0.0/23, created meanwhile"));
    const { state, done } = run([entry()]);
    await done;
    expect(state.skipped).toEqual(["10.1.0.0/24 (overlaps 10.1.0.0/23, created meanwhile)"]);
    expect(state.syncLog).toHaveBeenCalledWith("info", expect.stringContaining("Skipped subnet 10.1.0.0/24"));
  });
});

describe("Phase 1 — existing networks", () => {
  it("first claim of a manual network: renamed, tagged, purpose kept, mirrored in memory, and a subnet.claimed event", async () => {
    const row = { id: "s1", cidr: "10.1.0.0/24", blockId: "b1", name: "my lan", discoveredBy: null, purpose: "Office", tags: ["hq"], fortigateDevice: null, fortigateSerial: null };
    const { state, done } = run([entry()], { allSubnets: [row], subnetByCidr: new Map([["10.1.0.0/24", row]]) });
    await done;
    const data = db.subnetUpdate.mock.calls[0][0].data;
    expect(data).toMatchObject({ discoveredBy: "i1", name: "DHCP: lan (FGT-A)", status: "available", fortigateSerial: "FGT60F0000000001" });
    expect(data.tags).toEqual(["hq", "dhcp-discovered", "fortimanager"]);
    expect(data.purpose).toBeUndefined();
    expect(row.fortigateDevice).toBe("FGT-A"); // Phase 2 reads this row
    expect(state.updated).toEqual(["10.1.0.0/24"]);
    expect(eventLog.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "subnet.claimed", resourceId: "s1" }));
  });

  it("a different chassis on a known network archives a copy and raises a conflict without re-pointing the serial (rule 41)", async () => {
    const row = { id: "s1", cidr: "10.1.0.0/24", blockId: "b1", name: "DHCP: lan", discoveredBy: "i1", fortigateDevice: "FGT-OLD", fortigateSerial: "FGT60F0000000099" };
    const { state, done } = run([entry()], { allSubnets: [row], subnetByCidr: new Map([["10.1.0.0/24", row]]) });
    await done;
    expect(db.subnetUpdate.mock.calls[0][0].data.fortigateSerial).toBeUndefined();
    expect(m.snapshot).toHaveBeenCalledWith("s1", { reason: "chassis-replaced", actor: "system" });
    expect(m.raiseConflict).toHaveBeenCalledWith(expect.objectContaining({ oldSerial: "FGT60F0000000099", newSerial: "FGT60F0000000001", archivedSubnetId: "arch-1" }));
    expect(state.syncLog).toHaveBeenCalledWith("warning", expect.stringContaining("3 reservation(s) archived, conflict raised"));
  });

  it("an HA peer's serial is the same chassis, re-stamped without a conflict", async () => {
    const row = { id: "s1", cidr: "10.1.0.0/24", blockId: "b1", discoveredBy: "i1", fortigateDevice: "FGT-A", fortigateSerial: "FGT60F0000000002" };
    await run([entry()], {
      allSubnets: [row], subnetByCidr: new Map([["10.1.0.0/24", row]]),
      clusterSerialsByDevice: new Map([["fgt-a", new Set(["FGT60F0000000001", "FGT60F0000000002"])]]),
    }).done;
    expect(m.raiseConflict).not.toHaveBeenCalled();
    expect(db.subnetUpdate.mock.calls[0][0].data.fortigateSerial).toBe("FGT60F0000000001");
  });
});

describe("Phase 1 — a dead network on the CIDR", () => {
  const dead = (over: Entry = {}) => ({ id: "dead", cidr: "10.1.0.0/24", fortigateDevice: "FGT-OLD", fortigateSerial: "FGT60F0000000099", ...over });

  it("is retired, and dropped from memory, when a different gate now serves the range", async () => {
    const d = dead();
    const { state, done } = run([entry()], { allSubnets: [d], deprecatedByBlockCidr: new Map([["b1|10.1.0.0/24", d]]) });
    await done;
    expect(m.archive).toHaveBeenCalledWith("dead", { actor: "system", reason: "chassis-replaced" });
    expect(state.deprecatedByBlockCidr.size).toBe(0);
    expect(state.allSubnets.map((s: any) => s.id)).toEqual(["new-10.1.0.0/24"]);
    expect(state.created).toEqual(["10.1.0.0/24"]);
  });

  it("is kept — and the create skipped with an actionable reason — when its own gate still serves it", async () => {
    const d = dead({ fortigateDevice: "FGT-A", fortigateSerial: "FGT60F0000000001" });
    const { state, done } = run([entry()], { deprecatedByBlockCidr: new Map([["b1|10.1.0.0/24", d]]) });
    await done;
    expect(m.archive).not.toHaveBeenCalled();
    expect(m.createChecked).not.toHaveBeenCalled();
    expect(state.skipped).toEqual(["10.1.0.0/24 (a deprecated network still holds this range — archive it to free the address space)"]);
  });
});
