/**
 * tests/unit/quarantineStrandedService.test.ts — business rule 165, the DB half
 * (src/services/quarantineStrandedService.ts): retry, dismiss and the
 * background pass over `Asset.quarantineStranded`. The pure list helpers are
 * pinned in tests/unit/quarantineStranded.test.ts.
 *
 * Contract points checked here: the retry re-reads the row and folds into what
 * is stored THEN; an entry whose integration is gone is kept and reported, never
 * dropped; dismiss never calls a device and always writes a warning Event; a
 * scoped token only reaches its own integrations' gates (rule 114(d)).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import { eventLog, resetEventLogStub } from "./_eventLogStub.js";
import { AppError } from "../../src/utils/errors.js";

const m = vi.hoisted(() => ({
  buildTransportForIntegration: vi.fn(),
  unpushQuarantineFromFortigate: vi.fn(),
}));

vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/eventLogService.js", (orig) =>
  import("./_eventLogStub.js").then((s) => s.withEventLogStubs(orig)));
vi.mock("../../src/services/reservationPushService.js", () => ({ buildTransportForIntegration: m.buildTransportForIntegration }));
vi.mock("../../src/services/assetQuarantineService.js", () => ({ unpushQuarantineFromFortigate: m.unpushQuarantineFromFortigate }));

const { retryStrandedQuarantine, dismissStrandedQuarantine, retryAllStrandedQuarantine } =
  await import("../../src/services/quarantineStrandedService.js");

const db = {
  assetFindUnique: stubbed(prisma.asset.findUnique),
  assetFindMany: stubbed(prisma.asset.findMany),
  assetUpdate: stubbed(prisma.asset.update),
  integrationFindMany: stubbed(prisma.integration.findMany),
};

const LONG_AGO = "2026-01-01T00:00:00.000Z";
const entry = (fortigateDevice: string, integrationId: string, over: Record<string, unknown> = {}) => ({
  fortigateDevice, integrationId, error: "timeout", since: LONG_AGO, lastAttemptAt: LONG_AGO, attempts: 1, ...over,
});
const asset = (stranded: unknown[], over: Record<string, unknown> = {}) => ({
  id: "a1", hostname: "laptop-7", ipAddress: "10.0.0.7", quarantineStranded: stranded, ...over,
});

async function rejection(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

const lastEvent = () => eventLog.logEvent.mock.calls.at(-1)![0] as unknown as Record<string, any>;
const writtenList = () => db.assetUpdate.mock.calls.at(-1)![0].data.quarantineStranded as Array<Record<string, any>>;

/** Stored list on the first read; `fresh` on the re-read (defaults to the same list). */
function storeAsset(stranded: unknown[], fresh: unknown[] = stranded, over: Record<string, unknown> = {}) {
  db.assetFindUnique
    .mockResolvedValueOnce(asset(stranded, over))
    .mockResolvedValueOnce({ quarantineStranded: fresh });
}

beforeEach(() => {
  resetDbStub();
  resetEventLogStub();
  m.buildTransportForIntegration.mockReset();
  m.unpushQuarantineFromFortigate.mockReset();
  m.buildTransportForIntegration.mockImplementation(async (i: { id: string }, dev: string) => ({ via: i.id, dev }));
  m.unpushQuarantineFromFortigate.mockResolvedValue(undefined);
  db.integrationFindMany.mockResolvedValue([
    { id: "i1", type: "fortimanager", config: {} },
    { id: "i2", type: "fortigate", config: {} },
  ]);
  db.assetUpdate.mockResolvedValue({});
});

describe("retryStrandedQuarantine", () => {
  it("404s an unknown asset", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    expect((await rejection(retryStrandedQuarantine("nope", { actor: "u" }))).httpStatus).toBe(404);
  });

  it("404s a named FortiGate the asset is not stranded on", async () => {
    storeAsset([entry("FGT-A", "i1")]);
    const err = await rejection(retryStrandedQuarantine("a1", { actor: "u", fortigateDevice: "FGT-Z" }));
    expect(err.httpStatus).toBe(404);
    expect(m.unpushQuarantineFromFortigate).not.toHaveBeenCalled();
  });

  it("clears every gate that answers, writes the shrunk list and one cleared Event", async () => {
    storeAsset([entry("FGT-A", "i1"), entry("FGT-B", "i2")]);
    const r = await retryStrandedQuarantine("a1", { actor: "alice" });
    expect(r).toEqual({ assetId: "a1", cleared: ["FGT-A", "FGT-B"], remaining: [] });
    expect(m.buildTransportForIntegration).toHaveBeenCalledWith(expect.objectContaining({ id: "i1" }), "FGT-A");
    expect(m.unpushQuarantineFromFortigate).toHaveBeenCalledWith({ assetId: "a1", transport: { via: "i1", dev: "FGT-A" } });
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { quarantineStranded: [] } });
    expect(eventLog.logEvent).toHaveBeenCalledTimes(1);
    expect(lastEvent()).toMatchObject({
      action: "asset.quarantine.stranded_cleared",
      resourceType: "asset",
      resourceId: "a1",
      resourceName: "laptop-7",
      actor: "alice",
      level: "info",
      message: "The quarantine entry left behind for laptop-7 was removed from FGT-A, FGT-B",
      details: { cleared: ["FGT-A", "FGT-B"], remaining: [] },
    });
  });

  it("keeps a failed gate with its reason, a fresh lastAttemptAt and one more attempt", async () => {
    storeAsset([entry("FGT-A", "i1"), entry("FGT-B", "i2", { attempts: 3 })]);
    m.unpushQuarantineFromFortigate.mockImplementation(async ({ transport }: { transport: { dev: string } }) => {
      if (transport.dev === "FGT-B") throw new Error("gate unreachable");
    });
    const r = await retryStrandedQuarantine("a1", { actor: "alice" });
    expect(r.cleared).toEqual(["FGT-A"]);
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0]).toMatchObject({ fortigateDevice: "FGT-B", integrationId: "i2", error: "gate unreachable", attempts: 4, since: LONG_AGO });
    expect(r.remaining[0].lastAttemptAt).not.toBe(LONG_AGO);
    expect(writtenList()).toEqual(r.remaining);
    expect(lastEvent().message).toBe("The quarantine entry left behind for laptop-7 was removed from FGT-A; 1 FortiGate still holds it");
  });

  it("uses a generic reason when the failure carries no message", async () => {
    storeAsset([entry("FGT-A", "i1")]);
    m.unpushQuarantineFromFortigate.mockRejectedValue("nope");
    const r = await retryStrandedQuarantine("a1", { actor: "u" });
    expect(r.remaining[0].error).toBe("Unpush failed");
  });

  it("keeps and reports an entry whose integration no longer exists, without a device call, and writes no Event", async () => {
    storeAsset([entry("FGT-GONE", "deleted-int")]);
    const r = await retryStrandedQuarantine("a1", { actor: "u" });
    expect(m.buildTransportForIntegration).not.toHaveBeenCalled();
    expect(r.cleared).toEqual([]);
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0].error).toMatch(/integration that reached this FortiGate no longer exists/);
    expect(r.remaining[0].attempts).toBe(2);
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });

  it("limits the attempt to one named gate", async () => {
    storeAsset([entry("FGT-A", "i1"), entry("FGT-B", "i2")]);
    const r = await retryStrandedQuarantine("a1", { actor: "u", fortigateDevice: "FGT-B" });
    expect(m.unpushQuarantineFromFortigate).toHaveBeenCalledTimes(1);
    expect(r.cleared).toEqual(["FGT-B"]);
    expect(r.remaining.map((e) => e.fortigateDevice)).toEqual(["FGT-A"]);
    expect(r.remaining[0].attempts).toBe(1); // untouched
    expect(lastEvent().message).toContain("; 1 FortiGate still holds it");
  });

  it("refuses (403) a scoped token reaching a gate through another integration, before any device call", async () => {
    storeAsset([entry("FGT-A", "i1"), entry("FGT-B", "i2")]);
    const err = await rejection(retryStrandedQuarantine("a1", { actor: "tok", tokenIntegrationIds: ["i1"] }));
    expect(err.httpStatus).toBe(403);
    expect(err.message).toContain("FGT-B");
    expect(err.message).not.toContain("FGT-A");
    expect(m.unpushQuarantineFromFortigate).not.toHaveBeenCalled();
    expect(db.assetUpdate).not.toHaveBeenCalled();
  });

  it("lets a scoped token retry its own gate", async () => {
    storeAsset([entry("FGT-A", "i1"), entry("FGT-B", "i2")]);
    const r = await retryStrandedQuarantine("a1", { actor: "tok", tokenIntegrationIds: ["i1"], fortigateDevice: "FGT-A" });
    expect(r.cleared).toEqual(["FGT-A"]);
  });

  it("with onlyDue, skips entries still inside their backoff and writes nothing when none is due", async () => {
    const now = new Date("2026-11-16T12:00:00Z");
    const recent = new Date(now.getTime() - 60_000).toISOString();
    storeAsset([entry("FGT-A", "i1", { lastAttemptAt: recent })]);
    const r = await retryStrandedQuarantine("a1", { actor: "job", onlyDue: now });
    expect(r.cleared).toEqual([]);
    expect(r.remaining.map((e) => e.fortigateDevice)).toEqual(["FGT-A"]);
    expect(m.unpushQuarantineFromFortigate).not.toHaveBeenCalled();
    expect(db.assetUpdate).not.toHaveBeenCalled();
  });

  it("folds into the list stored at write time: an entry added mid-attempt survives, one dismissed mid-attempt stays gone", async () => {
    storeAsset(
      [entry("FGT-A", "i1"), entry("FGT-B", "i2")],
      [entry("FGT-B", "i2"), entry("FGT-NEW", "i1")], // FGT-A dismissed, FGT-NEW released meanwhile
    );
    m.unpushQuarantineFromFortigate.mockImplementation(async ({ transport }: { transport: { dev: string } }) => {
      if (transport.dev === "FGT-B") throw new Error("down");
    });
    const r = await retryStrandedQuarantine("a1", { actor: "u" });
    expect(r.remaining.map((e) => e.fortigateDevice)).toEqual(["FGT-B", "FGT-NEW"]);
    expect(r.remaining.find((e) => e.fortigateDevice === "FGT-B")!.attempts).toBe(2);
    expect(r.remaining.find((e) => e.fortigateDevice === "FGT-NEW")!.attempts).toBe(1);
  });

  it("matches entries by integration AND gate: the same gate name via another integration is a separate entry", async () => {
    storeAsset([entry("FGT-A", "i1"), entry("FGT-A", "i2")]);
    m.unpushQuarantineFromFortigate.mockImplementation(async ({ transport }: { transport: { via: string } }) => {
      if (transport.via === "i2") throw new Error("down");
    });
    const r = await retryStrandedQuarantine("a1", { actor: "u" });
    expect(r.remaining).toHaveLength(1);
    expect(r.remaining[0]).toMatchObject({ fortigateDevice: "FGT-A", integrationId: "i2", error: "down" });
  });

  it("labels the Event by address, then id, when the asset has no hostname", async () => {
    storeAsset([entry("FGT-A", "i1")], undefined, { hostname: null });
    await retryStrandedQuarantine("a1", { actor: "u" });
    expect(lastEvent()).toMatchObject({ resourceName: "10.0.0.7" });
    expect(lastEvent().message).toContain("for 10.0.0.7 was removed");
  });
});

describe("dismissStrandedQuarantine", () => {
  it("404s an unknown asset", async () => {
    db.assetFindUnique.mockResolvedValue(null);
    expect((await rejection(dismissStrandedQuarantine("nope", { actor: "u" }))).httpStatus).toBe(404);
  });

  it("404s an asset with nothing stranded, and a gate it is not stranded on", async () => {
    db.assetFindUnique.mockResolvedValue(asset([]));
    const a = await rejection(dismissStrandedQuarantine("a1", { actor: "u" }));
    expect(a.httpStatus).toBe(404);
    expect(a.message).toBe("This asset has no stranded quarantine entries");
    db.assetFindUnique.mockResolvedValue(asset([entry("FGT-A", "i1")]));
    const b = await rejection(dismissStrandedQuarantine("a1", { actor: "u", fortigateDevice: "FGT-Z" }));
    expect(b.httpStatus).toBe(404);
    expect(b.message).toContain("FGT-Z");
  });

  it("drops every entry without touching a device and writes a warning Event", async () => {
    db.assetFindUnique.mockResolvedValue(asset([entry("FGT-A", "i1"), entry("FGT-B", "i2", { attempts: 5, error: "refused" })]));
    const r = await dismissStrandedQuarantine("a1", { actor: "bob" });
    expect(r).toEqual({ assetId: "a1", cleared: [], remaining: [] });
    expect(m.buildTransportForIntegration).not.toHaveBeenCalled();
    expect(m.unpushQuarantineFromFortigate).not.toHaveBeenCalled();
    expect(db.assetUpdate).toHaveBeenCalledWith({ where: { id: "a1" }, data: { quarantineStranded: [] } });
    expect(lastEvent()).toMatchObject({
      action: "asset.quarantine.stranded_dismissed",
      level: "warning",
      actor: "bob",
      resourceId: "a1",
      details: {
        dismissed: [
          { fortigateDevice: "FGT-A", integrationId: "i1", since: LONG_AGO, attempts: 1, lastError: "timeout" },
          { fortigateDevice: "FGT-B", integrationId: "i2", since: LONG_AGO, attempts: 5, lastError: "refused" },
        ],
      },
    });
    expect(lastEvent().message).toContain("the MAC is still blocked there");
  });

  it("dismisses one named gate and keeps the rest", async () => {
    db.assetFindUnique.mockResolvedValue(asset([entry("FGT-A", "i1"), entry("FGT-B", "i2")]));
    const r = await dismissStrandedQuarantine("a1", { actor: "u", fortigateDevice: "FGT-A" });
    expect(r.remaining.map((e) => e.fortigateDevice)).toEqual(["FGT-B"]);
    expect(writtenList().map((e) => e.fortigateDevice)).toEqual(["FGT-B"]);
  });

  it("refuses (403) a scoped token dismissing another integration's gate", async () => {
    db.assetFindUnique.mockResolvedValue(asset([entry("FGT-A", "i1"), entry("FGT-B", "i2")]));
    const err = await rejection(dismissStrandedQuarantine("a1", { actor: "tok", tokenIntegrationIds: ["i2"] }));
    expect(err.httpStatus).toBe(403);
    expect(err.message).toContain("dismiss");
    expect(db.assetUpdate).not.toHaveBeenCalled();
    expect(eventLog.logEvent).not.toHaveBeenCalled();
  });
});

describe("retryAllStrandedQuarantine", () => {
  const NOW = new Date("2026-11-16T12:00:00Z");
  const recent = new Date(NOW.getTime() - 60_000).toISOString();

  it("reads only rows with a non-empty list and returns zeros when there are none", async () => {
    db.assetFindMany.mockResolvedValue([]);
    await expect(retryAllStrandedQuarantine(NOW)).resolves.toEqual({ assets: 0, cleared: 0, failed: 0, skipped: 0 });
    expect(db.assetFindMany).toHaveBeenCalledWith({
      where: { NOT: { quarantineStranded: { equals: [] } } },
      select: { id: true, quarantineStranded: true },
    });
  });

  it("skips assets with nothing due, retries due ones as the system actor, and sums the outcome", async () => {
    db.assetFindMany.mockResolvedValue([
      { id: "a1", quarantineStranded: [entry("FGT-A", "i1"), entry("FGT-B", "i2")] },
      { id: "a2", quarantineStranded: [entry("FGT-C", "i1", { lastAttemptAt: recent })] },
    ]);
    db.assetFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "a1" ? asset([entry("FGT-A", "i1"), entry("FGT-B", "i2")]) : null);
    m.unpushQuarantineFromFortigate.mockImplementation(async ({ transport }: { transport: { dev: string } }) => {
      if (transport.dev === "FGT-B") throw new Error("down");
    });
    const r = await retryAllStrandedQuarantine(NOW);
    expect(r).toEqual({ assets: 1, cleared: 1, failed: 1, skipped: 0 });
    expect(lastEvent()).toMatchObject({ actor: "system:quarantine-retry" });
  });

  it("counts an asset whose retry throws as one failure and carries on", async () => {
    db.assetFindMany.mockResolvedValue([
      { id: "gone", quarantineStranded: [entry("FGT-A", "i1")] },
      { id: "a1", quarantineStranded: [entry("FGT-B", "i2")] },
    ]);
    db.assetFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "a1" ? asset([entry("FGT-B", "i2")]) : null);
    await expect(retryAllStrandedQuarantine(NOW)).resolves.toEqual({ assets: 2, cleared: 1, failed: 1, skipped: 0 });
  });

  it("counts a not-yet-due entry left on a retried asset as skipped, not failed", async () => {
    const stored = [entry("FGT-A", "i1"), entry("FGT-B", "i2", { lastAttemptAt: recent })];
    db.assetFindMany.mockResolvedValue([{ id: "a1", quarantineStranded: stored }]);
    db.assetFindUnique.mockResolvedValue(asset(stored));
    const r = await retryAllStrandedQuarantine(NOW);
    expect(m.unpushQuarantineFromFortigate).toHaveBeenCalledTimes(1);
    // Was a bug until 2026-11-16: `failed` added r.remaining.length, so the backoff-skipped entry counted as a failure.
    expect(r).toEqual({ assets: 1, cleared: 1, failed: 0, skipped: 1 });
  });
});
