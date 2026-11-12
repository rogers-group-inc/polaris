/**
 * tests/unit/quarantineCarry.test.ts
 *
 * Business rule 164(a): a MAC block on a FortiGate is recorded on an asset
 * row, and it does not go away because that row is merged into another or
 * deleted. A merge hands the absorbed record's quarantine and its stranded
 * gates to the survivor; a delete of an asset still blocked on a gate is
 * refused (the integration suite covers the refusal against a real row).
 *
 * `carryQuarantineState` runs inside the caller's transaction, so it is driven
 * here with a two-row in-memory `tx.asset`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({ logEvent: vi.fn(async (_e: unknown) => {}) }));
vi.mock("../../src/db.js", () => ({ prisma: {} }));
vi.mock("../../src/services/eventLogService.js", () => ({ logEvent: h.logEvent }));
vi.mock("../../src/services/assetRemovalService.js", () => ({ afterAssetMerged: vi.fn() }));
vi.mock("../../src/services/agentOrphanService.js", () => ({ listAgentHosts: vi.fn(async () => []), recordAgentsLeftOnHosts: vi.fn() }));
vi.mock("../../src/services/monitorOverrideService.js", () => ({ recomputeMonitorOverrideForAssets: vi.fn() }));

import { carryQuarantineState } from "../../src/services/assetMergeService.js";
import { unionStranded, unionQuarantineTargets } from "../../src/utils/quarantineStranded.js";

type Row = Record<string, unknown> & { id: string };
const stranded = (fortigateDevice: string, attempts = 1, integrationId = "int-1") => ({
  fortigateDevice, integrationId, error: "timeout", since: "2026-11-01T00:00:00.000Z", lastAttemptAt: "2026-11-01T00:00:00.000Z", attempts,
});
const target = (fortigateDevice: string, mac = "AA:BB:CC:00:00:01", integrationId = "int-1") => ({
  fortigateDevice, integrationId, pushedMacs: [mac], pushedAt: "2026-11-01T00:00:00.000Z", status: "synced",
});
const plain = (id: string, over: Partial<Row> = {}): Row => ({
  id, hostname: id, ipAddress: null, status: "active", monitored: true,
  statusBeforeQuarantine: null, monitoredBeforeQuarantine: null,
  quarantineReason: null, quarantinedAt: null, quarantinedBy: null,
  quarantineTargets: [], quarantineStranded: [], ...over,
});
const quarantinedRow = (id: string, devices: string[], over: Partial<Row> = {}): Row => plain(id, {
  status: "quarantined", monitored: false, statusBeforeQuarantine: "active", monitoredBeforeQuarantine: true,
  quarantineReason: "malware", quarantinedAt: new Date("2026-11-02T00:00:00Z"), quarantinedBy: "user:alice",
  quarantineTargets: devices.map((d) => target(d)), ...over,
});

function txWith(rows: Row[]) {
  const update = vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    Object.assign(rows.find((r) => r.id === where.id)!, data);
    return {};
  });
  return {
    update,
    tx: { asset: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => rows.filter((r) => where.id.in.includes(r.id))), update } },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("the pure unions", () => {
  it("unionStranded keeps the survivor's entry for a gate both hold, and adds the rest", () => {
    const out = unionStranded([stranded("FG-A", 5)], [stranded("FG-A", 1), stranded("FG-B", 2)]);
    expect(out.map((e) => [e.fortigateDevice, e.attempts])).toEqual([["FG-A", 5], ["FG-B", 2]]);
  });

  it("unionStranded treats the same device through another integration as another gate", () => {
    expect(unionStranded([stranded("FG-A", 1, "int-1")], [stranded("FG-A", 1, "int-2")])).toHaveLength(2);
  });

  it("unionQuarantineTargets keeps the survivor's record of a shared gate and ignores junk", () => {
    const out = unionQuarantineTargets([target("FG-A", "11:11:11:11:11:11")], [target("FG-A", "22:22:22:22:22:22"), target("FG-B"), null, "x", {}]) as Array<{ fortigateDevice: string; pushedMacs: string[] }>;
    expect(out.map((t) => t.fortigateDevice)).toEqual(["FG-A", "FG-B"]);
    expect(out[0].pushedMacs).toEqual(["11:11:11:11:11:11"]);
    expect(unionQuarantineTargets("nope", undefined)).toEqual([]);
  });
});

describe("rule 164(a): carryQuarantineState", () => {
  it("writes nothing on an ordinary merge", async () => {
    const { tx, update } = txWith([plain("ghost"), plain("keep")]);
    expect(await carryQuarantineState(tx, "ghost", "keep")).toEqual({ carried: false });
    expect(update).not.toHaveBeenCalled();
    expect(h.logEvent).not.toHaveBeenCalled();
  });

  it("writes nothing when only the SURVIVOR carries quarantine state", async () => {
    const { tx, update } = txWith([plain("ghost"), quarantinedRow("keep", ["FG-A"], { quarantineStranded: [stranded("FG-Z")] })]);
    expect(await carryQuarantineState(tx, "ghost", "keep")).toEqual({ carried: false });
    expect(update).not.toHaveBeenCalled();
  });

  it("moves stranded gates onto the survivor without changing its status", async () => {
    const rows = [plain("ghost", { quarantineStranded: [stranded("FG-A"), stranded("FG-B")] }), plain("keep", { quarantineStranded: [stranded("FG-B", 7)] })];
    const { tx } = txWith(rows);
    expect(await carryQuarantineState(tx, "ghost", "keep")).toEqual({ carried: true });
    const keep = rows[1];
    expect(keep.status).toBe("active");
    expect((keep.quarantineStranded as Array<{ fortigateDevice: string; attempts: number }>).map((e) => [e.fortigateDevice, e.attempts])).toEqual([["FG-B", 7], ["FG-A", 1]]);
    expect(keep.quarantineTargets).toEqual([]);
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: "asset.quarantine.carried", resourceId: "keep", level: "warning" }));
  });

  it("a quarantined record merged into an ordinary one quarantines the survivor, parking ITS status and monitoring", async () => {
    const rows = [quarantinedRow("ghost", ["FG-A", "FG-B"]), plain("keep", { status: "maintenance", monitored: true })];
    const { tx } = txWith(rows);
    await carryQuarantineState(tx, "ghost", "keep");
    const keep = rows[1];
    expect(keep).toMatchObject({
      status: "quarantined",
      statusBeforeQuarantine: "maintenance",
      monitoredBeforeQuarantine: true,
      quarantineReason: "malware",
      quarantinedBy: "user:alice",
      statusChangedBy: "system:merge",
    });
    expect(keep.quarantinedAt).toEqual(new Date("2026-11-02T00:00:00Z"));
    expect((keep.quarantineTargets as Array<{ fortigateDevice: string }>).map((t) => t.fortigateDevice)).toEqual(["FG-A", "FG-B"]);
    const ev = h.logEvent.mock.calls[0][0] as { message: string; details: { quarantined: boolean; survivorWasQuarantined: boolean } };
    expect(ev.message).toContain("now holds the quarantine");
    expect(ev.details).toMatchObject({ quarantined: true, survivorWasQuarantined: false });
  });

  it("two quarantined records become one quarantine: the survivor keeps its own park and reason and gains the gates it lacked", async () => {
    const rows = [
      quarantinedRow("ghost", ["FG-A", "FG-B"], { quarantineReason: "ghost reason", statusBeforeQuarantine: "storage" }),
      quarantinedRow("keep", ["FG-B", "FG-C"], { quarantineReason: "keep reason" }),
    ];
    const { tx } = txWith(rows);
    await carryQuarantineState(tx, "ghost", "keep");
    const keep = rows[1];
    expect(keep).toMatchObject({ status: "quarantined", statusBeforeQuarantine: "active", quarantineReason: "keep reason" });
    expect((keep.quarantineTargets as Array<{ fortigateDevice: string }>).map((t) => t.fortigateDevice)).toEqual(["FG-B", "FG-C", "FG-A"]);
  });

  it("does nothing when either row is already gone", async () => {
    const { tx, update } = txWith([quarantinedRow("ghost", ["FG-A"])]);
    expect(await carryQuarantineState(tx, "ghost", "missing")).toEqual({ carried: false });
    expect(update).not.toHaveBeenCalled();
  });
});
