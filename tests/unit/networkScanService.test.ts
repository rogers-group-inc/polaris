/**
 * tests/unit/networkScanService.test.ts — saved Discovery CRUD, the run
 * lifecycle and adoption (business rules 34a, 157(d)) against the shared
 * Prisma stub (CQ-T010).
 *
 * Complements, does not repeat:
 *   - networkScanValidate.test.ts — validateScanInput, assetTypeForHit,
 *     methodKeyForHit and the three visibility predicates
 *   - assetRemovalService.test.ts / integration/assetRemoval.test.ts — callers
 *
 * What was unreached: every database-backed verb. listScans' three visibility
 * arms and newest-run join; getScan's 404 for a row the caller may not see
 * (indistinguishable from a missing id); createScan's name check scoped to the
 * caller's own rows, the token caller who may not save a PRIVATE row, and the
 * audit Event; updateScan's name check against the ROW'S owner and the orphan
 * that may not be made private; deleteScan refusing a live run (a stalled one
 * does not count); triggerScan — the run row, the queue publish, the
 * in-process fallback when pg-boss is not live, the 409 on a live run;
 * cancelRun's no-op on a finished run; and adoptHits — the cap, the
 * re-check of inventory at adopt time, a duplicate inside one call, the
 * interface / storage pins by identifying method, and one Event for the batch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));

const h = vi.hoisted(() => ({ publishScanJob: vi.fn(), runScan: vi.fn() }));
vi.mock("../../src/services/queueService.js", () => ({ publishScanJob: h.publishScanJob }));
vi.mock("../../src/services/monitoringService.js", () => ({
  probeCredentialAgainstHost: async () => ({ success: false, responseTimeMs: 0 }),
  snmpWalkRaw: async () => ({ rows: [], truncated: false, durationMs: 0 }),
}));
vi.mock("../../src/services/credentialService.js", () => ({ getCredential: async () => { throw new Error("unused"); } }));
vi.mock("../../src/services/networkScanRunner.js", async (orig) => ({
  ...(await orig<typeof import("../../src/services/networkScanRunner.js")>()),
  runScan: h.runScan,
}));

import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import {
  MAX_ADOPT_PER_CALL,
  adoptHits,
  cancelRun,
  createScan,
  deleteScan,
  getRun,
  getScan,
  getScanForWrite,
  listScans,
  triggerScan,
  updateScan,
  type SaveScanInput,
} from "../../src/services/networkScanService.js";

const NOW = new Date("2026-11-13T12:00:00Z");
const ALICE = { id: "u-alice", username: "alice" };
const BOB = { id: "u-bob", username: "bob" };
const TOKEN = { id: null, username: "api-token" };

const input: SaveScanInput = {
  name: "  Plant LAN ",
  description: "  floor 2 ",
  targets: [{ kind: "cidr", value: "10.4.0.0/30" }],
  methods: [{ type: "icmp", credentialIds: [] }],
};

function scanRow(over: Record<string, unknown> = {}) {
  return {
    id: "s1", name: "Plant LAN", description: null, visibility: "private",
    targets: [{ kind: "cidr", value: "10.4.0.0/30" }], methods: [{ type: "icmp", credentialIds: [] }],
    autoMonitor: null, ownerId: ALICE.id, createdBy: "alice",
    createdAt: NOW, updatedAt: NOW, lastRunAt: null, ...over,
  };
}

function runRow(over: Record<string, unknown> = {}) {
  return {
    id: "r1", scanId: "s1", status: "succeeded", actor: "alice", error: null,
    totalTargets: 4, droppedTargetCount: 0, scannedCount: 4, hitCount: 2, skippedKnownCount: 0,
    startedAt: NOW, finishedAt: NOW, createdAt: NOW, workerHeartbeatAt: NOW, hits: [], ...over,
  };
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  h.publishScanJob.mockReset();
  h.publishScanJob.mockResolvedValue(true);
  h.runScan.mockReset();
  h.runScan.mockResolvedValue(undefined);
  stubbed(prisma.networkScanRun.findMany).mockResolvedValue([]);
  stubbed(prisma.networkScanRun.findFirst).mockResolvedValue(null);
  stubbed(prisma.networkScan.findFirst).mockResolvedValue(null);
  stubbed(prisma.asset.findMany).mockResolvedValue([]);
  stubbed(prisma.assetAssociatedIp.findMany).mockResolvedValue([]);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("listScans", () => {
  it("published + mine; housekeeping adds the orphans; a token sees only published", async () => {
    stubbed(prisma.networkScan.findMany).mockResolvedValue([]);
    await listScans(ALICE.id);
    expect(stubbed(prisma.networkScan.findMany).mock.calls[0]![0].where).toEqual({ OR: [{ visibility: "public" }, { ownerId: ALICE.id }] });
    await listScans(ALICE.id, true);
    expect(stubbed(prisma.networkScan.findMany).mock.calls[1]![0].where.OR).toContainEqual({ ownerId: null });
    await listScans(null);
    expect(stubbed(prisma.networkScan.findMany).mock.calls[2]![0].where).toEqual({ OR: [{ visibility: "public" }] });
  });

  it("joins each Discovery's NEWEST run in one query, and says who owns what", async () => {
    stubbed(prisma.networkScan.findMany).mockResolvedValue([scanRow(), scanRow({ id: "s2", ownerId: BOB.id, visibility: "public" })]);
    stubbed(prisma.networkScanRun.findMany).mockResolvedValue([
      runRow({ id: "new", createdAt: new Date(NOW.getTime() - 1000) }),
      runRow({ id: "old", createdAt: new Date(NOW.getTime() - 9000) }),
    ]);
    const list = await listScans(ALICE.id);
    expect(prisma.networkScanRun.findMany).toHaveBeenCalledTimes(1);
    expect(list[0]).toMatchObject({ id: "s1", isOwner: true, latestRun: { id: "new" } });
    expect(list[1]).toMatchObject({ id: "s2", isOwner: false, latestRun: null, visibility: "public" });
  });
});

describe("getScan / getScanForWrite", () => {
  it("someone else's private Discovery is a 404 worded exactly like a missing one", async () => {
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(scanRow());
    const hidden = await getScan("s1", BOB.id).catch((e: unknown) => e as { httpStatus: number; message: string });
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(null);
    const missing = await getScan("s1", BOB.id).catch((e: unknown) => e as { httpStatus: number; message: string });
    expect(hidden).toMatchObject({ httpStatus: 404, message: "Discovery not found" });
    expect(missing).toMatchObject({ httpStatus: 404, message: "Discovery not found" });
  });

  it("an owned private Discovery reads back shaped; an orphan only for housekeeping", async () => {
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(scanRow());
    await expect(getScan("s1", ALICE.id)).resolves.toMatchObject({ isOwner: true, targets: [{ kind: "cidr", value: "10.4.0.0/30" }], methods: [{ type: "icmp" }] });
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(scanRow({ ownerId: null }));
    await expect(getScanForWrite("s1", BOB.id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(getScanForWrite("s1", BOB.id, true)).resolves.toMatchObject({ id: "s1", ownerId: null });
  });
});

describe("createScan", () => {
  it("trims, defaults to private, owns it, and writes the Event", async () => {
    stubbed(prisma.networkScan.create).mockImplementation(async ({ data }: any) => scanRow({ ...data }));
    const rec = await createScan(input, ALICE);
    const data = stubbed(prisma.networkScan.create).mock.calls[0]![0].data;
    expect(data).toMatchObject({ name: "Plant LAN", description: "floor 2", visibility: "private", ownerId: ALICE.id, createdBy: "alice" });
    expect(rec.isOwner).toBe(true);
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({
      action: "network_scan.created", actor: "alice", message: 'Discovery "Plant LAN" created (private)',
      details: { targets: 1, methods: ["icmp"], visibility: "private" },
    });
  });

  it("the name clash is checked against the caller's own rows only", async () => {
    stubbed(prisma.networkScan.create).mockImplementation(async ({ data }: any) => scanRow({ ...data }));
    await createScan(input, ALICE);
    expect(stubbed(prisma.networkScan.findFirst).mock.calls[0]![0].where).toEqual({ name: "Plant LAN", ownerId: ALICE.id });
    stubbed(prisma.networkScan.findFirst).mockResolvedValue({ id: "other" });
    await expect(createScan(input, ALICE)).rejects.toMatchObject({ httpStatus: 409, message: 'You already have a Discovery named "Plant LAN".' });
  });

  it("an invalid input is a 400 before anything is read", async () => {
    await expect(createScan({ ...input, methods: [] }, ALICE)).rejects.toMatchObject({ httpStatus: 400, message: "Select at least one probe method." });
    expect(prisma.networkScan.findFirst).not.toHaveBeenCalled();
  });

  it("a token caller may save a SHARED Discovery but not a private one; a blank actor reads 'unknown'", async () => {
    await expect(createScan(input, TOKEN)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringMatching(/needs a signed-in owner/) });
    stubbed(prisma.networkScan.create).mockImplementation(async ({ data }: any) => scanRow({ ...data }));
    const rec = await createScan({ ...input, visibility: "public" }, { id: null, username: "  " });
    expect(rec).toMatchObject({ visibility: "public", isOwner: false, ownerId: null });
    expect(stubbed(prisma.networkScan.create).mock.calls[0]![0].data.createdBy).toBe("unknown");
  });
});

describe("updateScan", () => {
  beforeEach(() => {
    stubbed(prisma.networkScan.update).mockImplementation(async ({ data }: any) => scanRow({ ...data }));
  });

  it("an unchanged name is not re-checked; a renamed one is checked against the ROW'S owner", async () => {
    await updateScan(scanRow({ ownerId: BOB.id, createdBy: "bob" }), { ...input, name: "Plant LAN" }, ALICE);
    expect(prisma.networkScan.findFirst).not.toHaveBeenCalled();
    await updateScan(scanRow({ ownerId: BOB.id, createdBy: "bob" }), { ...input, name: "Plant WAN" }, ALICE);
    expect(stubbed(prisma.networkScan.findFirst).mock.calls[0]![0].where).toEqual({ name: "Plant WAN", ownerId: BOB.id, id: { not: "s1" } });
    expect(eventLog.logEvent.mock.calls.at(-1)![0].details).toMatchObject({ previousName: "Plant LAN", owner: "bob" });
  });

  it("keeps the stored visibility when none is posted, and records a change of it", async () => {
    await updateScan(scanRow({ visibility: "public" }), { ...input, name: "Plant LAN" }, ALICE);
    expect(stubbed(prisma.networkScan.update).mock.calls[0]![0].data.visibility).toBe("public");
    await updateScan(scanRow({ visibility: "public" }), { ...input, name: "Plant LAN", visibility: "private" }, ALICE);
    expect(eventLog.logEvent.mock.calls.at(-1)![0].details).toMatchObject({ visibility: "private", previousVisibility: "public" });
  });

  it("an orphan cannot be made private (nobody could see it again)", async () => {
    await expect(updateScan(scanRow({ ownerId: null, visibility: "public" }), { ...input, visibility: "private" }, ALICE))
      .rejects.toMatchObject({ httpStatus: 400, message: "This Discovery has no owner, so it cannot be made private." });
  });
});

describe("deleteScan", () => {
  it("404 for a missing row", async () => {
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(null);
    await expect(deleteScan("nope", "alice")).rejects.toMatchObject({ httpStatus: 404 });
  });

  it("refuses while a run is live, but a STALLED run does not block it", async () => {
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(scanRow());
    stubbed(prisma.networkScanRun.findFirst).mockResolvedValue(runRow({ status: "running", workerHeartbeatAt: new Date(NOW.getTime() - 60_000) }));
    await expect(deleteScan("s1", "alice")).rejects.toMatchObject({ httpStatus: 409 });
    expect(prisma.networkScan.delete).not.toHaveBeenCalled();
    stubbed(prisma.networkScanRun.findFirst).mockResolvedValue(runRow({ status: "running", workerHeartbeatAt: new Date(NOW.getTime() - 4 * 60_000) }));
    await deleteScan("s1", "alice");
    expect(prisma.networkScan.delete).toHaveBeenCalledWith({ where: { id: "s1" } });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ action: "network_scan.deleted", level: "warning", resourceName: "Plant LAN" });
  });
});

describe("triggerScan", () => {
  beforeEach(() => {
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(scanRow({ ownerId: BOB.id, visibility: "public" }));
    stubbed(prisma.networkScanRun.create).mockImplementation(async ({ data }: any) => runRow({ id: "r9", ...data, startedAt: null, finishedAt: null }));
  });

  it("anyone who can SEE a shared Discovery may run it: a queued run row, handed to the worker", async () => {
    const run = await triggerScan("s1", ALICE);
    expect(stubbed(prisma.networkScanRun.create).mock.calls[0]![0].data).toEqual({ scanId: "s1", status: "queued", actor: "alice", workerHeartbeatAt: NOW });
    expect(h.publishScanJob).toHaveBeenCalledWith("r9", "s1", "alice");
    expect(h.runScan).not.toHaveBeenCalled();
    expect(run).toMatchObject({ id: "r9", status: "queued", active: true, stalled: false });
  });

  it("runs in-process, detached, when the queue is not live or publishing throws", async () => {
    h.publishScanJob.mockResolvedValue(false);
    await triggerScan("s1", ALICE);
    expect(h.runScan).toHaveBeenCalledWith("r9", "alice");
    h.runScan.mockClear();
    h.publishScanJob.mockRejectedValue(new Error("boss down"));
    h.runScan.mockRejectedValue(new Error("sweep failed"));
    await expect(triggerScan("s1", ALICE)).resolves.toMatchObject({ id: "r9" });
    expect(h.runScan).toHaveBeenCalledTimes(1);
  });

  it("refuses a second live run, and a stored config that no longer validates", async () => {
    stubbed(prisma.networkScanRun.findFirst).mockResolvedValue(runRow({ status: "queued" }));
    await expect(triggerScan("s1", ALICE)).rejects.toMatchObject({ httpStatus: 409, message: "That Discovery is already running." });
    stubbed(prisma.networkScanRun.findFirst).mockResolvedValue(null);
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(scanRow({ ownerId: BOB.id, visibility: "public", methods: [] }));
    await expect(triggerScan("s1", ALICE)).rejects.toMatchObject({ httpStatus: 400 });
    expect(prisma.networkScanRun.create).not.toHaveBeenCalled();
  });

  it("someone else's private Discovery cannot be run — it does not exist to them", async () => {
    stubbed(prisma.networkScan.findUnique).mockResolvedValue(scanRow({ ownerId: BOB.id }));
    await expect(triggerScan("s1", ALICE)).rejects.toMatchObject({ httpStatus: 404 });
  });
});

describe("cancelRun / getRun", () => {
  it("a finished run is returned as is — no flag, no Event", async () => {
    stubbed(prisma.networkScanRun.findUnique).mockResolvedValue({ ...runRow(), scan: scanRow() });
    await expect(cancelRun("r1", ALICE)).resolves.toMatchObject({ status: "succeeded", active: false });
    expect(prisma.networkScanRun.update).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("a live run gets cancelRequested and a warning Event", async () => {
    stubbed(prisma.networkScanRun.findUnique).mockResolvedValue({ ...runRow({ status: "running" }), scan: scanRow() });
    stubbed(prisma.networkScanRun.update).mockResolvedValue(runRow({ status: "running" }));
    await cancelRun("r1", ALICE);
    expect(prisma.networkScanRun.update).toHaveBeenCalledWith({ where: { id: "r1" }, data: { cancelRequested: true } });
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({ action: "network_scan.cancel_requested", level: "warning" });
  });

  it("a run inherits its Discovery's privacy; non-array hits read as none", async () => {
    stubbed(prisma.networkScanRun.findUnique).mockResolvedValue({ ...runRow({ hits: null }), scan: scanRow({ ownerId: BOB.id }) });
    await expect(getRun("r1", ALICE.id)).rejects.toMatchObject({ httpStatus: 404, message: "Run not found" });
    await expect(getRun("r1", BOB.id)).resolves.toMatchObject({ hits: [], scanName: "Plant LAN" });
  });
});

describe("adoptHits", () => {
  const hits = [
    {
      address: "10.4.0.1", respondedTo: ["icmp", "snmp"], identifiedBy: "snmp",
      identity: { hostname: "core-sw", os: "FortiSwitch-148F v7.2.5", manufacturer: "Fortinet", snmpLocation: "IDF2" },
      interfaces: [{ ifName: "port1", ifType: "ethernetCsmacd", operStatus: "up" }, { ifName: "port2", ifType: "ethernetCsmacd", operStatus: "down" }],
      storage: [{ mountPath: "/" }],
    },
    { address: "10.4.0.2", respondedTo: ["icmp"] },
    { address: "10.4.0.3", respondedTo: ["icmp"], identity: { model: "M3045", productType: "camera", os: "AXIS long string" } },
  ];
  const autoMonitor = { snmp: { interfaces: { byPatterns: { patterns: ["port*"], regex: false, onlyUp: true } }, storage: { all: { all: true } } } };

  beforeEach(() => {
    stubbed(prisma.networkScanRun.findUnique).mockResolvedValue({ ...runRow({ hits }), scan: scanRow({ autoMonitor }) });
    let n = 0;
    stubbed(prisma.asset.create).mockImplementation(async () => ({ id: `a${++n}` }));
  });

  it("requires a selection and caps it", async () => {
    await expect(adoptHits("r1", ["  ", ""], ALICE)).rejects.toMatchObject({ httpStatus: 400 });
    const tooMany = Array.from({ length: MAX_ADOPT_PER_CALL + 1 }, (_, i) => `10.9.${Math.floor(i / 250)}.${i % 250}`);
    await expect(adoptHits("r1", tooMany, ALICE)).rejects.toMatchObject({ httpStatus: 400, message: expect.stringContaining(`you selected ${MAX_ADOPT_PER_CALL + 1}`) });
  });

  it("creates manual assets, skipping non-responders and addresses inventory now carries", async () => {
    stubbed(prisma.assetAssociatedIp.findMany).mockResolvedValue([{ ip: " 10.4.0.2 " }]);
    const out = await adoptHits("r1", ["10.4.0.1", "10.4.0.2", "10.4.0.99", "10.4.0.1"], ALICE);
    expect(out.created).toBe(1);
    expect(out.assetIds).toEqual(["a1"]);
    expect(out.skipped).toEqual([
      { address: "10.4.0.2", reason: "An asset already carries this address" },
      { address: "10.4.0.99", reason: "Not a responder in this run" },
    ]);
    const data = stubbed(prisma.asset.create).mock.calls[0]![0].data;
    expect(data).toMatchObject({
      hostname: "core-sw", ipAddress: "10.4.0.1", ipSource: "manual", assetType: "switch", status: "active",
      manufacturer: "Fortinet", os: "FortiSwitch-148F v7.2.5", snmpLocation: "IDF2", createdBy: "alice",
      notes: 'Found by Polaris Discovery "Plant LAN" at 10.4.0.1 (answered snmp)',
    });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(eventLog.logEvent.mock.calls[0]![0]).toMatchObject({
      action: "network_scan.adopted", message: 'Added 1 asset(s) from Discovery "Plant LAN", 2 skipped', details: { created: 1 },
    });
  });

  it("pins by the method that identified the device; an ICMP-only hit gets no pins and its address as hostname", async () => {
    await adoptHits("r1", ["10.4.0.1", "10.4.0.2"], ALICE);
    const [snmpData, icmpData] = stubbed(prisma.asset.create).mock.calls.map((c) => c[0].data);
    expect(snmpData.monitoredInterfaces).toEqual(["port1"]);
    expect(snmpData.monitoredStorage).toEqual(["/"]);
    expect(icmpData).not.toHaveProperty("monitoredInterfaces");
    expect(icmpData).toMatchObject({ hostname: "10.4.0.2", assetType: "other", notes: 'Found by Polaris Discovery "Plant LAN" at 10.4.0.2' });
  });

  it("a parsed model keeps the raw sysDescr out of `os`", async () => {
    await adoptHits("r1", ["10.4.0.3"], ALICE);
    expect(stubbed(prisma.asset.create).mock.calls[0]![0].data).toMatchObject({ model: "M3045", productType: "camera", os: null });
  });

  it("a failed create is a skip with its reason, not a failed batch", async () => {
    stubbed(prisma.asset.create).mockRejectedValueOnce(new Error("unique violation")).mockResolvedValueOnce({ id: "a2" });
    const out = await adoptHits("r1", ["10.4.0.1", "10.4.0.2"], ALICE);
    expect(out).toEqual({ created: 1, assetIds: ["a2"], skipped: [{ address: "10.4.0.1", reason: "unique violation" }] });
  });
});
