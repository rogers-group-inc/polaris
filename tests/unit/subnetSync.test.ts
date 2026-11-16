/**
 * tests/unit/subnetSync.test.ts — the own suite for
 * src/services/discovery/dhcp/subnetSync.ts (syncDiscoveredSubnets, discovery
 * Phase 1; business rules 41, 42, 125, 137, CQ-T010).
 *
 * Complements tests/integration/subnetSupersedeDeprecated.test.ts (drives the
 * REAL syncDhcpSubnets end to end for the dead-row supersede) and the pure
 * suites for chassisIdentity / discoveredSubnetName / subnetExclusion.
 *
 * Adds, on the shared db stub with the real pure helpers and the archive /
 * conflict / create seams mocked: invalid and excluded CIDRs skipped whole
 * (no update, no chassis check), the update path's base fields, chassis
 * learn / same / unknown / replaced (snapshot + conflict AFTER the batch, the
 * serial never re-pointed), first claim (name, status, tag union, purpose
 * kept, one subnet.claimed Event), the device-rename suffix and its
 * subnet.updated Event, the in-memory mirror Phase 2 reads, the origin label
 * (DHCP / DHCPv6 / IPv6 RA), rule 137's interface fields, the create path
 * (parent block, sibling pre-filter, locked seam, 409 as an info skip, other
 * failures as errors) and the deprecated-row supersede / keep branches.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  create: vi.fn(),
  snapshot: vi.fn(),
  archive: vi.fn(),
  raise: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/subnetService.js", () => ({ createSubnetRowChecked: h.create }));
vi.mock("../../src/services/subnetArchiveService.js", () => ({ snapshotSubnet: h.snapshot, archiveSubnet: h.archive }));
vi.mock("../../src/services/subnetChassisConflictService.js", () => ({ raiseChassisReplacedConflict: h.raise }));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import { syncDiscoveredSubnets } from "../../src/services/discovery/dhcp/subnetSync.js";

const db = prisma as any;
const BLOCK = { id: "b1", cidr: "10.0.0.0/8" };

type Entry = {
  cidr: string; name: string; fortigateDevice: string; dhcpServerId?: string;
  fortigateSerial?: string; vlan?: number; vlanParent?: string | null; origin?: "dhcp" | "dhcp6" | "ra";
};

function stored(over: Record<string, unknown> = {}) {
  return {
    id: "s1", blockId: "b1", cidr: "10.1.0.0/24", name: "DHCP: lan (FW-A)", status: "available", tags: ["dhcp-discovered", "fortimanager"],
    purpose: "Discovered", discoveredBy: "int-1", fortigateDevice: "FW-A", fortigateSerial: "FGT1",
    ...over,
  };
}

/** Build the run state the engine hands Phase 1, exactly as discoveryEngine indexes it. */
function makeInput(subnets: Entry[], existing: any[] = [], over: Record<string, unknown> = {}) {
  const allSubnets = [...existing];
  const subnetByCidr = new Map<string, any>();
  const siblingsByBlockId = new Map<string, any[]>();
  const deprecatedByBlockCidr = new Map<string, any>();
  for (const s of allSubnets) {
    if (s.status !== "deprecated") {
      subnetByCidr.set(s.cidr, s);
      siblingsByBlockId.set(s.blockId, [...(siblingsByBlockId.get(s.blockId) ?? []), s]);
    } else {
      deprecatedByBlockCidr.set(`${s.blockId}|${s.cidr}`, s);
    }
  }
  const log: Array<[string, string]> = [];
  const input = {
    result: { subnets: subnets.map((e) => ({ dhcpServerId: "1", ...e })) } as any,
    allSubnets, subnetByCidr, siblingsByBlockId, deprecatedByBlockCidr,
    subnetExclusions: [] as Array<{ cidr: string; name?: string }>,
    clusterSerialsByDevice: new Map<string, Set<string>>(),
    findParentBlock: vi.fn((cidr: string) => (cidr.startsWith("10.") || cidr.startsWith("2001:") ? BLOCK : undefined)),
    created: [] as string[], updated: [] as string[], skipped: [] as string[],
    integrationId: "int-1", integrationName: "FMG", integrationType: "fortimanager", integrationLabel: "FortiManager",
    actor: "system" as string | undefined,
    syncLog: (level: string, msg: string) => { log.push([level, msg]); },
    ...over,
  };
  return { input, log };
}

const updates = () => stubbed(db.subnet.update).mock.calls.map((c) => c[0]);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.create.mockReset().mockImplementation(async (data: any) => ({ id: `new-${data.cidr}`, ...data }));
  h.snapshot.mockReset().mockResolvedValue({ archivedSubnetId: "arch-1", cidr: "10.1.0.0/24", reservationCount: 3 });
  h.archive.mockReset().mockResolvedValue({ archivedSubnetId: "arch-2", cidr: "10.1.0.0/24", reservationCount: 2 });
  h.raise.mockReset().mockResolvedValue("raised");
  stubbed(db.subnet.update).mockResolvedValue({});
});

describe("syncDiscoveredSubnets — skips", () => {
  it("skips an invalid CIDR", async () => {
    const { input } = makeInput([{ cidr: "not-a-cidr", name: "lan", fortigateDevice: "FW-A" }]);
    await syncDiscoveredSubnets(input);
    expect(input.skipped).toEqual(["not-a-cidr (invalid CIDR)"]);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("skips an excluded CIDR WHOLE — no update and no chassis comparison on an existing row (rule 42)", async () => {
    const { input } = makeInput(
      [{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-B", fortigateSerial: "FGT-OTHER" }],
      [stored()],
      { subnetExclusions: [{ cidr: "10.0.0.0/8", name: "wide" }, { cidr: "10.1.0.0/16", name: "Shared site LAN" }] },
    );
    await syncDiscoveredSubnets(input);
    expect(input.skipped).toEqual([`10.1.0.0/24 (excluded as "Shared site LAN")`]);
    expect(db.subnet.update).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.raise).not.toHaveBeenCalled();
  });

  it("skips a network no block contains", async () => {
    const { input } = makeInput([{ cidr: "192.168.5.0/24", name: "lan", fortigateDevice: "FW-A" }]);
    await syncDiscoveredSubnets(input);
    expect(input.skipped).toEqual(["192.168.5.0/24 (no matching parent block)"]);
    expect(h.create).not.toHaveBeenCalled();
  });

  it("skips a network overlapping a known live sibling without opening the locked create", async () => {
    const { input } = makeInput([{ cidr: "10.1.0.128/25", name: "lan", fortigateDevice: "FW-A" }], [stored()]);
    await syncDiscoveredSubnets(input);
    expect(input.skipped).toEqual(["10.1.0.128/25 (overlaps 10.1.0.0/24)"]);
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe("syncDiscoveredSubnets — create", () => {
  it("creates through the locked seam with the generated name, tags and the run's exclusions", async () => {
    const { input } = makeInput([{ cidr: "10.2.0.0/24", name: "port5", fortigateDevice: "FW-A", fortigateSerial: "FGT1", vlan: 30, vlanParent: "fortilink" }]);
    await syncDiscoveredSubnets(input);
    const [data, opts] = h.create.mock.calls[0];
    expect(data).toMatchObject({
      blockId: "b1", cidr: "10.2.0.0/24", name: "DHCP: port5 (FW-A)", purpose: "Discovered from FortiManager DHCP",
      status: "available", discoveredBy: "int-1", fortigateDevice: "FW-A", fortigateSerial: "FGT1",
      tags: ["dhcp-discovered", "fortimanager"], vlan: 30, fortigateInterface: "port5", fortigateVlanParent: "fortilink",
    });
    expect(data.lastDiscoveredAt).toBeInstanceOf(Date);
    expect(opts).toEqual({ exclusions: input.subnetExclusions });
    expect(input.created).toEqual(["10.2.0.0/24"]);
  });

  it("normalises the CIDR before everything else", async () => {
    const { input } = makeInput([{ cidr: "10.2.0.77/24", name: "lan", fortigateDevice: "FW-A" }]);
    await syncDiscoveredSubnets(input);
    expect(h.create.mock.calls[0][0].cidr).toBe("10.2.0.0/24");
    expect(input.findParentBlock).toHaveBeenCalledWith("10.2.0.0/24");
  });

  it("omits serial, vlan and the vlan parent when the run did not read them", async () => {
    const { input } = makeInput([{ cidr: "10.2.0.0/24", name: "lan", fortigateDevice: "FW-A" }]);
    await syncDiscoveredSubnets(input);
    const data = h.create.mock.calls[0][0];
    expect(data).not.toHaveProperty("fortigateSerial");
    expect(data).not.toHaveProperty("vlan");
    expect(data).not.toHaveProperty("fortigateVlanParent");
    expect(data.fortigateInterface).toBe("lan");
  });

  it.each([
    ["dhcp6", "DHCPv6"],
    ["ra", "IPv6 RA"],
  ] as const)("names a %s network by its origin (rule 125)", async (origin, label) => {
    const { input } = makeInput([{ cidr: "2001:db8:1::/64", name: "lan", fortigateDevice: "FW-A", origin }]);
    await syncDiscoveredSubnets(input);
    expect(h.create.mock.calls[0][0]).toMatchObject({ name: `${label}: lan (FW-A)`, purpose: `Discovered from FortiManager ${label}` });
  });

  it("indexes the new row so a second entry for the same CIDR in the run updates it instead", async () => {
    const { input } = makeInput([
      { cidr: "10.2.0.0/24", name: "lan", fortigateDevice: "FW-A" },
      { cidr: "10.2.0.0/24", name: "lan", fortigateDevice: "FW-A" },
    ]);
    await syncDiscoveredSubnets(input);
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(input.created).toEqual(["10.2.0.0/24"]);
    expect(input.updated).toEqual(["10.2.0.0/24"]);
    expect(input.allSubnets).toHaveLength(1);
    expect(input.siblingsByBlockId.get("b1")).toHaveLength(1);
  });

  it("a 409 from the seam is a quiet info skip", async () => {
    h.create.mockRejectedValue(new AppError(409, "Subnet overlaps 10.2.0.0/25"));
    const { input, log } = makeInput([{ cidr: "10.2.0.0/24", name: "lan", fortigateDevice: "FW-A" }]);
    await syncDiscoveredSubnets(input);
    expect(input.skipped).toEqual(["10.2.0.0/24 (Subnet overlaps 10.2.0.0/25)"]);
    expect(log).toEqual([["info", "Skipped subnet 10.2.0.0/24: Subnet overlaps 10.2.0.0/25"]]);
    expect(input.created).toEqual([]);
  });

  it("any other create failure is an error line and the run continues", async () => {
    h.create.mockRejectedValueOnce(new Error("boom"));
    const { input, log } = makeInput([
      { cidr: "10.2.0.0/24", name: "lan", fortigateDevice: "FW-A" },
      { cidr: "10.3.0.0/24", name: "lan", fortigateDevice: "FW-A" },
    ]);
    await syncDiscoveredSubnets(input);
    expect(input.skipped).toEqual(["10.2.0.0/24 (create failed)"]);
    expect(log[0]).toEqual(["error", "Failed to create subnet 10.2.0.0/24: boom"]);
    expect(input.created).toEqual(["10.3.0.0/24"]);
  });
});

describe("syncDiscoveredSubnets — a deprecated row on the CIDR (rule 41)", () => {
  const dead = (over: Record<string, unknown> = {}) => stored({ id: "dead", status: "deprecated", ...over });

  it("retires it and creates when a DIFFERENT chassis serves the range", async () => {
    const { input, log } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-B", fortigateSerial: "FGT2" }], [dead()]);
    await syncDiscoveredSubnets(input);
    expect(h.archive).toHaveBeenCalledWith("dead", { actor: "system", reason: "chassis-replaced" });
    expect(input.deprecatedByBlockCidr.size).toBe(0);
    expect(input.allSubnets.find((s: any) => s.id === "dead")).toBeUndefined();
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(input.created).toEqual(["10.1.0.0/24"]);
    expect(log[0][0]).toBe("info");
    expect(log[0][1]).toContain("2 reservation(s) archived");
    expect(log[0][1]).toContain("a different chassis serial");
  });

  it("retires it on a different device NAME when no serial pair exists", async () => {
    const { input, log } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-B" }], [dead({ fortigateSerial: null })]);
    await syncDiscoveredSubnets(input);
    expect(h.archive).toHaveBeenCalled();
    expect(log[0][1]).toContain("a different FortiGate");
  });

  it("keeps it — skipped with an actionable message — when its own gate still serves the range", async () => {
    const { input, log } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A", fortigateSerial: "fgt1 " }], [dead()]);
    await syncDiscoveredSubnets(input);
    expect(h.archive).not.toHaveBeenCalled();
    expect(h.create).not.toHaveBeenCalled();
    expect(input.skipped).toEqual(["10.1.0.0/24 (a deprecated network still holds this range — archive it to free the address space)"]);
    expect(log[0][0]).toBe("warning");
    expect(log[0][1]).toContain("same-chassis");
  });

  it("skips (and creates nothing) when the archive fails", async () => {
    h.archive.mockRejectedValue(new Error("tx failed"));
    const { input, log } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-B", fortigateSerial: "FGT2" }], [dead()]);
    await syncDiscoveredSubnets(input);
    expect(h.create).not.toHaveBeenCalled();
    expect(input.skipped).toEqual(["10.1.0.0/24 (could not archive the deprecated subnet it replaces)"]);
    expect(log[0]).toEqual(["error", "Failed to archive deprecated subnet 10.1.0.0/24: tx failed"]);
    expect(input.deprecatedByBlockCidr.size).toBe(1);
  });

  it("only an EXACT block|cidr dead row is consulted — a partial overlap falls through to the create", async () => {
    const { input } = makeInput([{ cidr: "10.1.0.0/25", name: "lan", fortigateDevice: "FW-B", fortigateSerial: "FGT2" }], [dead()]);
    await syncDiscoveredSubnets(input);
    expect(h.archive).not.toHaveBeenCalled();
    expect(h.create).toHaveBeenCalledTimes(1);
  });
});

describe("syncDiscoveredSubnets — update", () => {
  it("re-stamps an existing row's base fields and collects it for the batch", async () => {
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A", fortigateSerial: "FGT1", vlan: 12, vlanParent: null }], [stored()]);
    await syncDiscoveredSubnets(input);
    const [u] = updates();
    expect(u.where).toEqual({ id: "s1" });
    expect(u.data).toMatchObject({ discoveredBy: "int-1", fortigateDevice: "FW-A", fortigateSerial: "FGT1", vlan: 12, fortigateInterface: "lan", fortigateVlanParent: null });
    expect(u.data.lastDiscoveredAt).toBeInstanceOf(Date);
    expect(u.data).not.toHaveProperty("name");
    expect(u.data).not.toHaveProperty("status");
    expect(input.updated).toEqual(["10.1.0.0/24"]);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("an unreadable serial writes no serial (unknown), a first one is learned", async () => {
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A" }], [stored()]);
    await syncDiscoveredSubnets(input);
    expect(updates()[0].data).not.toHaveProperty("fortigateSerial");

    resetDbStub();
    stubbed(db.subnet.update).mockResolvedValue({});
    const second = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A", fortigateSerial: "FGT9" }], [stored({ fortigateSerial: null })]);
    await syncDiscoveredSubnets(second.input);
    expect(updates()[0].data.fortigateSerial).toBe("FGT9");
  });

  it("an HA cluster member re-stamps the serial without a conflict", async () => {
    const { input } = makeInput(
      [{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A", fortigateSerial: "FGT1-B" }],
      [stored()],
      { clusterSerialsByDevice: new Map([["fw-a", new Set(["FGT1", "FGT1-B"])]]) },
    );
    await syncDiscoveredSubnets(input);
    expect(updates()[0].data.fortigateSerial).toBe("FGT1-B");
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it("a replaced chassis: no serial written, snapshot + conflict after the batch update, warning line", async () => {
    const order: string[] = [];
    stubbed(db.subnet.update).mockImplementation(async () => { order.push("update"); return {}; });
    h.snapshot.mockImplementation(async () => { order.push("snapshot"); return { archivedSubnetId: "arch-1", cidr: "10.1.0.0/24", reservationCount: 3 }; });
    const { input, log } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-NEW", fortigateSerial: "FGT2" }], [stored()]);
    await syncDiscoveredSubnets(input);
    expect(order).toEqual(["update", "snapshot"]);
    expect(updates()[0].data).not.toHaveProperty("fortigateSerial");
    expect(h.snapshot).toHaveBeenCalledWith("s1", { reason: "chassis-replaced", actor: "system" });
    expect(h.raise).toHaveBeenCalledWith({
      subnetId: "s1", cidr: "10.1.0.0/24", blockId: "b1", oldSerial: "FGT1", newSerial: "FGT2",
      oldDeviceName: "FW-A", newDeviceName: "FW-NEW", archivedSubnetId: "arch-1",
      integrationId: "int-1", integrationName: "FMG", actor: "system",
    });
    expect(log).toContainEqual(["warning", expect.stringContaining("(FGT1 → FGT2) — 3 reservation(s) archived, conflict raised")]);
  });

  it("a failing chassis record is logged and never fails the run", async () => {
    h.raise.mockRejectedValue(new Error("nope"));
    const { input, log } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A", fortigateSerial: "FGT2" }], [stored()]);
    await expect(syncDiscoveredSubnets(input)).resolves.toBeUndefined();
    expect(log).toContainEqual(["error", "Failed to record chassis replacement for 10.1.0.0/24: nope"]);
  });

  it("first claim of a manual row: generated name, available, tag union, purpose kept, subnet.claimed Event", async () => {
    const manual = stored({ discoveredBy: null, name: "Printers", status: "reserved", tags: ["printers", "dhcp-discovered"], purpose: "Office printers", fortigateDevice: null, fortigateSerial: null });
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A" }], [manual]);
    await syncDiscoveredSubnets(input);
    const data = updates()[0].data;
    expect(data).toMatchObject({ name: "DHCP: lan (FW-A)", status: "available", tags: ["printers", "dhcp-discovered", "fortimanager"] });
    expect(data).not.toHaveProperty("purpose");
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "subnet.claimed", resourceType: "subnet", resourceId: "s1", resourceName: "DHCP: lan (FW-A)", actor: "system",
      details: { reason: "first-claim", previousName: "Printers", previousDiscoveredBy: null, integrationId: "int-1", fortigateDevice: "FW-A", cidr: "10.1.0.0/24" },
    });
  });

  it("first claim stamps a purpose only when blank, and copes with non-array tags", async () => {
    const manual = stored({ discoveredBy: null, purpose: "", tags: null });
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A", origin: "dhcp" }], [manual]);
    await syncDiscoveredSubnets(input);
    expect(updates()[0].data).toMatchObject({ purpose: "Discovered from FortiManager DHCP", tags: ["dhcp-discovered", "fortimanager"] });
  });

  it("a gate rename moves the (device) suffix and writes subnet.updated", async () => {
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A2" }], [stored()]);
    await syncDiscoveredSubnets(input);
    expect(updates()[0].data).toMatchObject({ name: "DHCP: lan (FW-A2)", fortigateDevice: "FW-A2" });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "subnet.updated", resourceId: "s1", resourceName: "DHCP: lan (FW-A2)",
      details: { reason: "device-renamed", previousName: "DHCP: lan (FW-A)", newName: "DHCP: lan (FW-A2)", oldDevice: "FW-A", newDevice: "FW-A2" },
    });
  });

  it("an operator-edited name is left as typed on a rename", async () => {
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A2" }], [stored({ name: "Warehouse LAN" })]);
    await syncDiscoveredSubnets(input);
    expect(updates()[0].data).not.toHaveProperty("name");
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("heals a still-generated name an earlier run left stale", async () => {
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A2" }], [stored({ fortigateDevice: "FW-A2" })]);
    await syncDiscoveredSubnets(input);
    expect(updates()[0].data.name).toBe("DHCP: lan (FW-A2)");
    expect(eventLog.logEvent.mock.calls[0][0].details).toMatchObject({ oldDevice: "FW-A2", newDevice: "FW-A2" });
  });

  it("mirrors each write onto the in-memory row Phase 2 reads", async () => {
    const row = stored();
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A2" }], [row]);
    await syncDiscoveredSubnets(input);
    expect(input.allSubnets[0]).toBe(row);
    expect(row.fortigateDevice).toBe("FW-A2");
    expect(row.name).toBe("DHCP: lan (FW-A2)");
  });

  it("runs the batch update for every touched row", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => stored({ id: `s${i}`, cidr: `10.${i}.0.0/24` }));
    const { input } = makeInput(rows.map((r) => ({ cidr: r.cidr, name: "lan", fortigateDevice: "FW-A" })), rows);
    await syncDiscoveredSubnets(input);
    expect(db.subnet.update).toHaveBeenCalledTimes(120);
    expect(input.updated).toHaveLength(120);
  });

  // Was a bug until 2026-11-14: the batch update is settled and its results are discarded. When the
  // write for a manual row's first claim REJECTS, the row stays unclaimed
  // (discoveredBy null, old name) yet a `subnet.claimed` Event still says
  // "claimed by FMG — now tracked as DHCP: lan (FW-A)", and nothing logs the
  // failure. Right: no subnet.claimed Event for a claim that was not written.
  it("writes no subnet.claimed Event when the claim's update failed", async () => {
    stubbed(db.subnet.update).mockRejectedValue(new Error("deadlock"));
    const manual = stored({ discoveredBy: null, name: "Printers" });
    const { input } = makeInput([{ cidr: "10.1.0.0/24", name: "lan", fortigateDevice: "FW-A" }], [manual]);
    await syncDiscoveredSubnets(input);
    expect(eventLog.logEvent.mock.calls.filter((c) => c[0].action === "subnet.claimed")).toHaveLength(0);
  });
});
