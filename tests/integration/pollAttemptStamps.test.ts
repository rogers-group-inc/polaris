/**
 * tests/integration/pollAttemptStamps.test.ts
 *
 * Business rule 118 — the attempt / success / failure-run stamps the two heavy
 * recorders write. The incident: a FortiGate whose REST CPU / memory pull was
 * refused on every poll showed "updated 1m ago" over an empty chart, because
 * recordTelemetryResult advanced lastTelemetryAt on failures too; and system
 * info, which did the opposite, re-walked a failing device on every heavy tick.
 *
 * Pinned here against a real database, since the failure path is one raw
 * UPDATE whose COALESCE is the whole point (the run starts at its FIRST
 * failure and a second failure must not move it).
 */

import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { prisma } from "../../src/db.js";
import { dbDescribe, dbReachable } from "./_helpers.js";
import {
  recordTelemetryResult,
  recordSystemInfoResult,
  type SystemInfoSample,
  type TelemetrySample,
  type CollectionResult,
} from "../../src/services/monitoringService.js";
import { flushAllSampleBuffers } from "../../src/services/sampleWriteBuffer.js";

const d = dbDescribe;
const HOSTNAME = "poll-attempt-stamps-test";
let assetId = "";

async function wipe(): Promise<void> {
  const old = await prisma.asset.findMany({ where: { hostname: HOSTNAME }, select: { id: true } });
  const ids = old.map((a) => a.id);
  if (ids.length === 0) return;
  await flushAllSampleBuffers();
  await prisma.assetTelemetrySample.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.assetInterfaceSample.deleteMany({ where: { assetId: { in: ids } } });
  await prisma.asset.deleteMany({ where: { id: { in: ids } } });
}

const read = () => prisma.asset.findUniqueOrThrow({
  where: { id: assetId },
  select: {
    lastTelemetryAt: true, lastTelemetryAttemptAt: true, telemetryFailingSince: true, telemetryLastError: true,
    lastSystemInfoAt: true, lastSystemInfoAttemptAt: true, systemInfoFailingSince: true, systemInfoLastError: true,
  },
});

const telOk = (): CollectionResult<TelemetrySample> => ({ supported: true, data: { cpuPct: 12, memPct: 40 } });
const telFail = (error?: string): CollectionResult<TelemetrySample> => ({ supported: true, error });
const sysOk = (): CollectionResult<SystemInfoSample> => ({ supported: true, data: { interfaces: [{ ifName: "port1" }], storage: [] } });

/** Pause long enough that two Date() stamps cannot collide. */
const tick = () => new Promise((r) => setTimeout(r, 15));

beforeAll(async () => { if (dbReachable) await prisma.$connect(); });
afterAll(async () => {
  if (!dbReachable) return;
  try { await wipe(); await prisma.$disconnect(); } catch { /* noop */ }
});
beforeEach(async () => {
  if (!dbReachable) return;
  await wipe();
  const a = await prisma.asset.create({
    data: { hostname: HOSTNAME, assetType: "firewall", status: "active", ipAddress: "10.97.1.2", monitored: true } as never,
  });
  assetId = a.id;
});

d("recordTelemetryResult stamps (rule 118)", () => {
  it("a failure stamps the attempt and opens a run, and never the success stamp", async () => {
    await recordTelemetryResult(assetId, telFail("connection refused (ECONNREFUSED)"));
    const r = await read();
    expect(r.lastTelemetryAt).toBeNull();
    expect(r.lastTelemetryAttemptAt).not.toBeNull();
    expect(r.telemetryFailingSince?.getTime()).toBe(r.lastTelemetryAttemptAt?.getTime());
    expect(r.telemetryLastError).toBe("connection refused (ECONNREFUSED)");
  });

  it("a second failure moves the attempt and the message, never the run's start", async () => {
    await recordTelemetryResult(assetId, telFail("first"));
    const first = await read();
    await tick();
    await recordTelemetryResult(assetId, telFail(undefined));
    const second = await read();
    expect(second.telemetryFailingSince?.getTime()).toBe(first.telemetryFailingSince?.getTime());
    expect(second.lastTelemetryAttemptAt!.getTime()).toBeGreaterThan(first.lastTelemetryAttemptAt!.getTime());
    expect(second.telemetryLastError).toBe("The device returned no CPU / memory data");
  });

  it("a success stamps both and closes the run", async () => {
    await recordTelemetryResult(assetId, telFail("boom"));
    await tick();
    await recordTelemetryResult(assetId, telOk());
    const r = await read();
    expect(r.lastTelemetryAt).not.toBeNull();
    expect(r.lastTelemetryAttemptAt?.getTime()).toBe(r.lastTelemetryAt?.getTime());
    expect(r.telemetryFailingSince).toBeNull();
    expect(r.telemetryLastError).toBeNull();
  });

  it("an unsupported stream writes nothing — no attempt, no run", async () => {
    await recordTelemetryResult(assetId, { supported: false });
    const r = await read();
    expect(r.lastTelemetryAttemptAt).toBeNull();
    expect(r.telemetryFailingSince).toBeNull();
  });
});

d("recordSystemInfoResult stamps (rule 118)", () => {
  it("a transport failure stamps the attempt and opens a run", async () => {
    await recordSystemInfoResult(assetId, { supported: true, error: "HTTP 401" });
    const r = await read();
    expect(r.lastSystemInfoAt).toBeNull();
    expect(r.lastSystemInfoAttemptAt).not.toBeNull();
    expect(r.systemInfoFailingSince).not.toBeNull();
    expect(r.systemInfoLastError).toBe("HTTP 401");
  });

  it("an answer with no interfaces is a failure too — the anchor guard and the run agree", async () => {
    await recordSystemInfoResult(assetId, { supported: true, data: { interfaces: [], storage: [] } });
    const r = await read();
    expect(r.lastSystemInfoAt).toBeNull();
    expect(r.systemInfoFailingSince).not.toBeNull();
    expect(r.systemInfoLastError).toBe("The device answered but returned no interfaces");
  });

  it("a success stamps both and closes the run", async () => {
    await recordSystemInfoResult(assetId, { supported: true, error: "timeout" });
    await tick();
    await recordSystemInfoResult(assetId, sysOk());
    const r = await read();
    expect(r.lastSystemInfoAt).not.toBeNull();
    expect(r.lastSystemInfoAttemptAt?.getTime()).toBe(r.lastSystemInfoAt?.getTime());
    expect(r.systemInfoFailingSince).toBeNull();
    expect(r.systemInfoLastError).toBeNull();
  });

  it("the two streams keep separate runs", async () => {
    await recordTelemetryResult(assetId, telFail("cpu down"));
    await recordSystemInfoResult(assetId, sysOk());
    const r = await read();
    expect(r.telemetryFailingSince).not.toBeNull();
    expect(r.systemInfoFailingSince).toBeNull();
  });
});
