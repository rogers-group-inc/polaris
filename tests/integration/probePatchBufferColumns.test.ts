/**
 * tests/integration/probePatchBufferColumns.test.ts
 *
 * The probe patch buffer flushes with a HAND-WRITTEN bulk UPDATE whose values
 * are positional: a placeholder list, a params array, and a `VALUES ... AS
 * v(...)` column list that have to agree three ways. Nothing typed guards
 * that agreement — add a column to two of the three and Postgres happily
 * files the wrong value in the wrong column, or the flush throws inside a
 * background timer where the only symptom is monitor state quietly going
 * stale.
 *
 * So this pins the flush against a real database: every column the buffer
 * claims to write lands where it says, for a full patch and a sparse one.
 * It exists because `lastDescrAt` (the sysDescr identity-read anchor) became
 * the 14th value, and the next column to be added deserves the same net.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/db.js";
import {
  enqueueProbePatch,
  flushProbePatchBuffer,
  type ProbePatch,
} from "../../src/services/probePatchBuffer.js";

const ids: string[] = [];

async function makeAsset(hostname: string): Promise<string> {
  const a = await prisma.asset.create({
    data: { hostname, assetType: "other", status: "active" },
    select: { id: true },
  });
  ids.push(a.id);
  return a.id;
}

beforeAll(async () => {
  await prisma.$queryRaw`SELECT 1`;
});

afterAll(async () => {
  if (ids.length) await prisma.asset.deleteMany({ where: { id: { in: ids } } });
});

describe("probe patch buffer — every column lands where the SQL says", () => {
  it("writes a full patch, including the sysDescr identity anchor", async () => {
    const id = await makeAsset(`pp-buffer-full-${Date.now()}`);
    const t = (ms: number) => new Date(Date.UTC(2026, 8, 4, 12, 0, 0) + ms);

    const patch: ProbePatch = {
      monitorStatus: "up",
      lastMonitorAt: t(0),
      lastResponseTimeMs: 42,
      consecutiveFailures: 0,
      consecutiveSuccesses: 3,
      monitorStatusChangedAt: t(1000),
      lastUptimeSec: 86_400,
      lastRebootAt: t(2000),
      lastSeen: t(3000),
      lastSeenSource: "probe",
      recoveryStartedAt: t(4000),
      lastDescrAt: t(5000),
      ipConfirmedFor: "10.9.8.7",
      ipConfirmedSince: t(6000),
    };
    enqueueProbePatch(id, patch);
    await flushProbePatchBuffer();

    const row = await prisma.asset.findUniqueOrThrow({
      where: { id },
      select: {
        monitorStatus: true, lastMonitorAt: true, lastResponseTimeMs: true,
        consecutiveFailures: true, consecutiveSuccesses: true,
        monitorStatusChangedAt: true, lastUptimeSec: true, lastRebootAt: true,
        lastSeen: true, lastSeenSource: true, recoveryStartedAt: true,
        lastDescrAt: true, ipConfirmedFor: true, ipConfirmedSince: true,
      },
    });

    expect(row.monitorStatus).toBe("up");
    expect(row.lastResponseTimeMs).toBe(42);
    expect(row.consecutiveSuccesses).toBe(3);
    expect(row.lastUptimeSec).toBe(86_400);
    expect(row.lastSeenSource).toBe("probe");
    // The timestamps are the real risk: a shifted positional param shows up
    // here as one stamp wearing another's value.
    expect(row.lastMonitorAt?.toISOString()).toBe(t(0).toISOString());
    expect(row.monitorStatusChangedAt?.toISOString()).toBe(t(1000).toISOString());
    expect(row.lastRebootAt?.toISOString()).toBe(t(2000).toISOString());
    expect(row.lastSeen?.toISOString()).toBe(t(3000).toISOString());
    expect(row.recoveryStartedAt?.toISOString()).toBe(t(4000).toISOString());
    expect(row.lastDescrAt?.toISOString()).toBe(t(5000).toISOString());
    // Rule 103's polling evidence — the 15th and 16th values.
    expect(row.ipConfirmedFor).toBe("10.9.8.7");
    expect(row.ipConfirmedSince?.toISOString()).toBe(t(6000).toISOString());
  });

  it("preserves prior stamps a sparse patch omits", async () => {
    // The COALESCE half of the contract: an ordinary probe carries no reboot,
    // no recovery anchor and no sysDescr, and must not erase them. For
    // lastDescrAt specifically, erasing it would make the next probe re-read
    // identity — turning a once-per-10-minutes varbind into every-probe.
    const id = await makeAsset(`pp-buffer-sparse-${Date.now()}`);
    const first = new Date(Date.UTC(2026, 8, 4, 12, 0, 0));

    enqueueProbePatch(id, {
      monitorStatus: "up",
      lastMonitorAt: first,
      lastResponseTimeMs: 10,
      consecutiveFailures: 0,
      consecutiveSuccesses: 1,
      lastRebootAt: first,
      lastSeen: first,
      lastSeenSource: "probe",
      recoveryStartedAt: first,
      lastDescrAt: first,
      ipConfirmedFor: "10.9.8.7",
      ipConfirmedSince: first,
    });
    await flushProbePatchBuffer();

    const later = new Date(first.getTime() + 60_000);
    enqueueProbePatch(id, {
      monitorStatus: "up",
      lastMonitorAt: later,
      lastResponseTimeMs: 11,
      consecutiveFailures: 0,
      consecutiveSuccesses: 2,
    });
    await flushProbePatchBuffer();

    const row = await prisma.asset.findUniqueOrThrow({
      where: { id },
      select: {
        lastMonitorAt: true, lastResponseTimeMs: true, lastRebootAt: true,
        recoveryStartedAt: true, lastDescrAt: true, lastSeen: true,
        ipConfirmedFor: true, ipConfirmedSince: true,
      },
    });
    // A probe that didn't restart the polling run keeps the run's start.
    expect(row.ipConfirmedFor).toBe("10.9.8.7");
    expect(row.ipConfirmedSince?.toISOString()).toBe(first.toISOString());
    expect(row.lastResponseTimeMs).toBe(11);
    expect(row.lastMonitorAt?.toISOString()).toBe(later.toISOString());
    expect(row.lastRebootAt?.toISOString()).toBe(first.toISOString());
    expect(row.recoveryStartedAt?.toISOString()).toBe(first.toISOString());
    expect(row.lastDescrAt?.toISOString()).toBe(first.toISOString());
    expect(row.lastSeen?.toISOString()).toBe(first.toISOString());
  });

  it("flushes several assets in one statement without crossing values", async () => {
    // The bulk path is where a positional slip does the most damage: values
    // land on the wrong ASSET rather than merely the wrong column.
    const a = await makeAsset(`pp-buffer-multi-a-${Date.now()}`);
    const b = await makeAsset(`pp-buffer-multi-b-${Date.now()}`);
    const base = new Date(Date.UTC(2026, 8, 4, 13, 0, 0));

    enqueueProbePatch(a, {
      monitorStatus: "up", lastMonitorAt: base, lastResponseTimeMs: 1,
      consecutiveFailures: 0, consecutiveSuccesses: 1, lastDescrAt: base,
    });
    enqueueProbePatch(b, {
      monitorStatus: "down", lastMonitorAt: base, lastResponseTimeMs: null,
      consecutiveFailures: 3, consecutiveSuccesses: 0,
    });
    await flushProbePatchBuffer();

    const rowA = await prisma.asset.findUniqueOrThrow({
      where: { id: a },
      select: { monitorStatus: true, lastResponseTimeMs: true, lastDescrAt: true },
    });
    const rowB = await prisma.asset.findUniqueOrThrow({
      where: { id: b },
      select: { monitorStatus: true, lastResponseTimeMs: true, lastDescrAt: true, consecutiveFailures: true },
    });

    expect(rowA.monitorStatus).toBe("up");
    expect(rowA.lastResponseTimeMs).toBe(1);
    expect(rowA.lastDescrAt?.toISOString()).toBe(base.toISOString());
    expect(rowB.monitorStatus).toBe("down");
    expect(rowB.lastResponseTimeMs).toBeNull();
    expect(rowB.consecutiveFailures).toBe(3);
    // b carried no identity read, so it must still be due.
    expect(rowB.lastDescrAt).toBeNull();
  });
});
