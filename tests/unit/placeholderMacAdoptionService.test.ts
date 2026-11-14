/**
 * tests/unit/placeholderMacAdoptionService.test.ts — the own suite for
 * runPlaceholderMacAdoption in src/services/placeholderMacAdoptionService.ts
 * (business rule 26, discovery Phase 7.7, CQ-T010).
 *
 * placeholderMacAdoption.test.ts already pins the pure halves
 * (buildMacEvidenceIndex, isAdoptionCandidate, createAdoptionBudget). This
 * file drives the DB/device pass on the shared db stub: both opt-in gates
 * (pushReservations re-checked server-side, adoptDiscoveredMac), the query
 * scoped to the gates the evidence names, the case-insensitive device match,
 * the same-subnet MAC collision skip, the per-RUN budget and its deferred
 * count, device-first ordering (a failed gate write leaves the row alone), a
 * pending row skipping the device, the colon-lower stored spelling, the
 * failed_permanent stamp on a permanent refusal only, both Events, and abort.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ updatePushed: vi.fn(), prefix: vi.fn() }));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) => import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/reservationMacService.js", () => ({ getPlaceholderPrefix: h.prefix }));
vi.mock("../../src/services/reservationPushService.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  updatePushedReservation: h.updatePushed,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";
import {
  runPlaceholderMacAdoption,
  createAdoptionBudget,
  type MacEvidence,
} from "../../src/services/placeholderMacAdoptionService.js";

const db = prisma as any;
const INT = "int-1";
const PLACEHOLDER = "02:0f:5e:aa:bb:01";
const REAL = "FC:AA:14:11:22:33";

function integration(config: Record<string, unknown> = { pushReservations: true, adoptDiscoveredMac: true }, type = "fortimanager") {
  return { id: INT, type, config };
}

function res(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `r${i}`, subnetId: "s1", ipAddress: `10.0.0.${i}`, hostname: `h${i}`, notes: null,
    macAddress: `02:0f:5e:aa:bb:${String(i).padStart(2, "0")}`, createdBy: "alice", pushStatus: "synced",
    pushedScopeId: 3, pushedEntryId: i,
    subnet: { cidr: "10.0.0.0/24", discoveredBy: INT, fortigateDevice: "FGT-Ashfield" },
    ...over,
  };
}

function evidence(entries: Array<[string, string, string, MacEvidence["source"]?]>): Map<string, MacEvidence> {
  return new Map(entries.map(([device, ip, mac, source]) => [`${device.toLowerCase()}|${ip}`, { mac, source: source ?? "arp", device }]));
}

const run = (ev: Map<string, MacEvidence>, extra: Record<string, unknown> = {}) =>
  runPlaceholderMacAdoption({ integrationId: INT, integrationName: "FMG", evidence: ev, budget: createAdoptionBudget(), actor: "system", ...extra } as any);

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  h.prefix.mockReset().mockResolvedValue("02:0F:5E");
  h.updatePushed.mockReset().mockResolvedValue({ scopeId: 4, entryId: 9 });
  stubbed(db.integration.findUnique).mockResolvedValue(integration());
  stubbed(db.reservation.findMany).mockResolvedValue([]);
  stubbed(db.reservation.update).mockResolvedValue({});
});

describe("runPlaceholderMacAdoption — gates", () => {
  it("does nothing, with no read, for empty evidence or a spent budget", async () => {
    expect(await run(new Map())).toEqual({ attempted: 0, adopted: 0, failed: 0, deferred: 0 });
    expect(await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]), { budget: createAdoptionBudget(0) }))
      .toEqual({ attempted: 0, adopted: 0, failed: 0, deferred: 0 });
    expect(db.integration.findUnique).not.toHaveBeenCalled();
  });

  it("does nothing for an unknown integration", async () => {
    stubbed(db.integration.findUnique).mockResolvedValue(null);
    expect((await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]))).attempted).toBe(0);
    expect(db.reservation.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["push off", integration({ adoptDiscoveredMac: true })],
    ["adoption off", integration({ pushReservations: true })],
    ["adoption truthy but not true", integration({ pushReservations: true, adoptDiscoveredMac: "yes" })],
    ["not a Fortinet type", integration({ pushReservations: true, adoptDiscoveredMac: true }, "entra")],
    ["null config", { id: INT, type: "fortigate", config: null }],
  ])("refuses when %s", async (_label, integ) => {
    stubbed(db.integration.findUnique).mockResolvedValue(integ);
    expect((await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]))).attempted).toBe(0);
    expect(db.reservation.findMany).not.toHaveBeenCalled();
    expect(h.updatePushed).not.toHaveBeenCalled();
  });

  it("works on a standalone FortiGate integration too", async () => {
    stubbed(db.integration.findUnique).mockResolvedValue(integration(undefined, "fortigate"));
    stubbed(db.reservation.findMany).mockResolvedValue([res(1)]);
    expect((await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]))).adopted).toBe(1);
  });

  it("scopes the read to this integration and the gates the evidence names (original case)", async () => {
    await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL], ["FGT-Ashfield", "10.0.0.2", REAL], ["FGT-Bury", "10.1.0.1", REAL]]));
    const where = stubbed(db.reservation.findMany).mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "active", ipAddress: { not: null }, macAddress: { not: null } });
    expect(where.subnet.discoveredBy).toBe(INT);
    expect(where.subnet.fortigateDevice.in.sort()).toEqual(["FGT-Ashfield", "FGT-Bury"]);
  });
});

describe("runPlaceholderMacAdoption — matching", () => {
  it("adopts a placeholder row the gate reports a real MAC at, matching the device case-insensitively", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1, { subnet: { cidr: "10.0.0.0/24", discoveredBy: INT, fortigateDevice: "fgt-ashfield" } })]);
    const out = await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]));
    expect(out).toEqual({ attempted: 1, adopted: 1, failed: 0, deferred: 0 });
  });

  it("ignores rows with no evidence, a real stored MAC, or a placeholder observed MAC", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([
      res(1),
      res(2, { macAddress: "00:11:22:33:44:55" }),
      res(3),
    ]);
    const out = await run(evidence([["FGT-Ashfield", "10.0.0.2", REAL], ["FGT-Ashfield", "10.0.0.3", "02:0f:5e:00:00:99"]]));
    expect(out.attempted).toBe(0);
    expect(h.updatePushed).not.toHaveBeenCalled();
  });

  it("skips a row already parked at failed_permanent", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1, { pushStatus: "failed_permanent" })]);
    expect((await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]))).attempted).toBe(0);
  });

  it("skips a candidate whose observed MAC another reservation in the same subnet already holds (any spelling)", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1), res(2, { macAddress: "fc-aa-14-11-22-33" })]);
    expect((await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]))).attempted).toBe(0);
  });

  it("does not treat the same MAC in a DIFFERENT subnet as a collision", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1), res(2, { subnetId: "s2", macAddress: REAL })]);
    expect((await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]))).adopted).toBe(1);
  });

  // BUG: occupiedBySubnet is built once from the STORED MACs and never updated
  // as candidates are chosen. Two placeholder rows in one subnet whose
  // evidence is the same real MAC (a card ARP shows at two addresses) are both
  // pushed; FortiOS refuses the second as a same-scope duplicate — a PERMANENT
  // refusal that parks it at failed_permanent, exactly the outcome the
  // collision skip's own comment says it exists to avoid. Right: only one of
  // the two is attempted in a run.
  it.fails("never adopts one observed MAC onto two reservations in the same subnet in one run", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1), res(2)]);
    const out = await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL], ["FGT-Ashfield", "10.0.0.2", REAL]]));
    expect(out.attempted).toBe(1);
  });
});

describe("runPlaceholderMacAdoption — writes", () => {
  it("writes the gate FIRST, then the row (colon-lower), and audits reservation.mac.adopted", async () => {
    const order: string[] = [];
    h.updatePushed.mockImplementation(async () => { order.push("device"); return { scopeId: 4, entryId: 9 }; });
    stubbed(db.reservation.update).mockImplementation(async () => { order.push("db"); return {}; });
    stubbed(db.reservation.findMany).mockResolvedValue([res(1)]);
    await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL, "device-inventory"]]));
    expect(order).toEqual(["device", "db"]);
    expect(h.updatePushed.mock.calls[0][0]).toMatchObject({
      reservationId: "r1", subnetCidr: "10.0.0.0/24", ip: "10.0.0.1", newMac: "fc:aa:14:11:22:33", hostname: "h1",
      createdBy: "alice", scopeId: 3, entryId: 1, deviceName: "FGT-Ashfield", integration: integration(),
    });
    const { where, data } = stubbed(db.reservation.update).mock.calls[0][0];
    expect(where).toEqual({ id: "r1" });
    expect(data).toMatchObject({ macAddress: "fc:aa:14:11:22:33", pushedToId: INT, pushedScopeId: 4, pushedEntryId: 9, pushStatus: "synced", pushError: null });
    expect(data.pushedAt).toBeInstanceOf(Date);
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "reservation.mac.adopted", resourceType: "reservation", resourceId: "r1", resourceName: "h1", actor: "system", level: "info",
      details: { integrationId: INT, deviceName: "FGT-Ashfield", ip: "10.0.0.1", previousMac: PLACEHOLDER, newMac: REAL, evidence: "device-inventory", queuedOnly: false },
    });
  });

  it("a pending (never-pushed) row is rewritten in Polaris only, no device contact", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1, { pushStatus: "pending", hostname: null })]);
    const out = await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]));
    expect(out.adopted).toBe(1);
    expect(h.updatePushed).not.toHaveBeenCalled();
    expect(stubbed(db.reservation.update).mock.calls[0][0]).toEqual({ where: { id: "r1" }, data: { macAddress: "fc:aa:14:11:22:33" } });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ resourceName: "10.0.0.1", details: { queuedOnly: true } });
  });

  it("a transient device failure leaves the row untouched and audits adopt_failed", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1)]);
    h.updatePushed.mockRejectedValue(new Error("ETIMEDOUT"));
    const out = await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]));
    expect(out).toEqual({ attempted: 1, adopted: 0, failed: 1, deferred: 0 });
    expect(db.reservation.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({
      action: "reservation.mac.adopt_failed", level: "warning",
      details: { kind: "transient", attemptedMac: REAL, previousMac: PLACEHOLDER, error: "ETIMEDOUT" },
    });
  });

  it("a permanent refusal parks the row at failed_permanent with the device's message (truncated to 500)", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1)]);
    h.updatePushed.mockRejectedValue(new AppError(409, "x".repeat(600)));
    await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]));
    const { where, data } = stubbed(db.reservation.update).mock.calls[0][0];
    expect(where).toEqual({ id: "r1" });
    expect(data.pushStatus).toBe("failed_permanent");
    expect(data.pushError).toHaveLength(500);
    expect(data.pushLastAttemptAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("macAddress");
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ details: { kind: "permanent" } });
  });

  it("still audits when stamping failed_permanent itself fails", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1)]);
    h.updatePushed.mockRejectedValue(new AppError(400, "bad"));
    stubbed(db.reservation.update).mockRejectedValue(new Error("db down"));
    const out = await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]));
    expect(out.failed).toBe(1);
    expect(eventLog.logEvent.mock.calls[0][0].action).toBe("reservation.mac.adopt_failed");
  });

  it("a DB failure after the device write counts as failed (transient)", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1)]);
    stubbed(db.reservation.update).mockRejectedValue(new Error("db down"));
    const out = await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]));
    expect(out).toMatchObject({ adopted: 0, failed: 1 });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ details: { kind: "transient" } });
  });

  it("an aborted run attempts no device write", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1)]);
    const ctl = new AbortController();
    ctl.abort();
    const out = await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]), { signal: ctl.signal });
    expect(h.updatePushed).not.toHaveBeenCalled();
    expect(out.adopted).toBe(0);
    // Current behaviour (suspicious, not pinned): the skipped row counts as a
    // failure, spends budget and writes a warning-level adopt_failed Event.
    expect(out).toMatchObject({ attempted: 1, failed: 1 });
    expect(eventLog.logEvent.mock.calls[0][0]).toMatchObject({ action: "reservation.mac.adopt_failed", details: { error: "aborted" } });
  });
});

describe("runPlaceholderMacAdoption — the per-run budget", () => {
  it("takes at most the remaining budget, defers the rest, and spends the shared budget", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1), res(2), res(3)]);
    const budget = createAdoptionBudget(2);
    const ev = evidence([
      ["FGT-Ashfield", "10.0.0.1", "FC:AA:14:00:00:01"],
      ["FGT-Ashfield", "10.0.0.2", "FC:AA:14:00:00:02"],
      ["FGT-Ashfield", "10.0.0.3", "FC:AA:14:00:00:03"],
    ]);
    const out = await run(ev, { budget });
    expect(out).toEqual({ attempted: 2, adopted: 2, failed: 0, deferred: 1 });
    expect(budget.remaining).toBe(0);
    expect(await run(ev, { budget })).toEqual({ attempted: 0, adopted: 0, failed: 0, deferred: 0 });
  });

  it("spends no budget when nothing is eligible", async () => {
    stubbed(db.reservation.findMany).mockResolvedValue([res(1, { macAddress: "00:11:22:33:44:55" })]);
    const budget = createAdoptionBudget(5);
    await run(evidence([["FGT-Ashfield", "10.0.0.1", REAL]]), { budget });
    expect(budget.remaining).toBe(5);
  });
});
