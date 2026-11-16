/**
 * tests/unit/pollStamps.test.ts — business rule 118: attempt vs success stamps.
 * A success writes success + attempt and closes the failure run; a failure
 * stamps the attempt, opens the run with COALESCE (first failure wins) and
 * records the capped message, leaving the success stamp alone. An unsupported
 * stream writes nothing. Also the telemetry sample shape and the hardware
 * sensor temperature sanity filter.
 *
 * pollFailureText's trim / fallback / cap are in streamFailingField.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const buf = vi.hoisted(() => ({ telemetry: vi.fn(), sensors: vi.fn() }));
vi.mock("../../src/db.js", () => import("./_dbStub.js"));
vi.mock("../../src/services/sampleWriteBuffer.js", () => ({
  enqueueTelemetrySample: buf.telemetry,
  enqueueHardwareSensorSamples: buf.sensors,
}));

import {
  POLL_ERROR_MAX_LEN,
  pollFailureText,
  telemetrySuccessStamps,
  systemInfoSuccessStamps,
  recordStreamFailure,
  recordTelemetryResult,
  recordHardwareSensorResult,
} from "../../src/services/monitoring/pollStamps.js";
import { prisma } from "../../src/db.js";
import { resetDbStub, stubbed } from "./_dbStub.js";
import type { HardwareSensorSample } from "../../src/services/monitoring/types.js";

const executeRaw = () => stubbed(prisma.$executeRaw);
const assetUpdate = () => stubbed(prisma.asset.update);
const NOW = new Date("2026-11-16T12:00:00Z");

beforeEach(() => {
  resetDbStub();
  buf.telemetry.mockReset();
  buf.sensors.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("pollFailureText", () => {
  it("caps at exactly POLL_ERROR_MAX_LEN characters, ellipsis included", () => {
    const out = pollFailureText("x".repeat(POLL_ERROR_MAX_LEN + 1), "fb");
    expect(out).toHaveLength(POLL_ERROR_MAX_LEN);
    expect(out.endsWith("…")).toBe(true);
    expect(pollFailureText("y".repeat(POLL_ERROR_MAX_LEN), "fb")).toBe("y".repeat(POLL_ERROR_MAX_LEN));
  });

  it("uses the fallback for null and whitespace", () => {
    expect(pollFailureText(null, "fb")).toBe("fb");
    expect(pollFailureText(" \n ", "fb")).toBe("fb");
  });
});

describe("success stamps", () => {
  it("stamp success and attempt together and close the failure run", () => {
    expect(telemetrySuccessStamps(NOW)).toEqual({ lastTelemetryAt: NOW, lastTelemetryAttemptAt: NOW, telemetryFailingSince: null, telemetryLastError: null });
    expect(systemInfoSuccessStamps(NOW)).toEqual({ lastSystemInfoAt: NOW, lastSystemInfoAttemptAt: NOW, systemInfoFailingSince: null, systemInfoLastError: null });
  });
});

describe("recordStreamFailure", () => {
  const sql = () => (executeRaw().mock.calls[0][0] as string[]).join("?");
  const vals = () => executeRaw().mock.calls[0].slice(1);

  it("telemetry: stamps the attempt, opens the run with COALESCE, records the message — never the success stamp", async () => {
    await recordStreamFailure("telemetry", "a1", NOW, "timeout");
    expect(sql()).toContain('"lastTelemetryAttemptAt" = ?');
    expect(sql()).toContain('"telemetryFailingSince" = COALESCE("telemetryFailingSince", ?)');
    expect(sql()).toContain('"telemetryLastError" = ?');
    expect(sql()).not.toContain('"lastTelemetryAt"');
    expect(vals()).toEqual([NOW, NOW, "timeout", "a1"]);
  });

  it("systemInfo: the same on its own columns", async () => {
    await recordStreamFailure("systemInfo", "a1", NOW, "walk failed");
    expect(sql()).toContain('"lastSystemInfoAttemptAt" = ?');
    expect(sql()).toContain('"systemInfoFailingSince" = COALESCE("systemInfoFailingSince", ?)');
    expect(sql()).not.toContain('"lastSystemInfoAt"');
    expect(vals()).toEqual([NOW, NOW, "walk failed", "a1"]);
  });
});

describe("recordTelemetryResult", () => {
  it("writes nothing for an unsupported stream", async () => {
    await recordTelemetryResult("a1", { supported: false });
    expect(executeRaw()).not.toHaveBeenCalled();
    expect(assetUpdate()).not.toHaveBeenCalled();
    expect(buf.telemetry).not.toHaveBeenCalled();
  });

  it("records a failure with the collector's error, or the fallback sentence", async () => {
    await recordTelemetryResult("a1", { supported: true, error: "SNMP timeout" });
    expect(executeRaw().mock.calls[0].slice(1)).toEqual([NOW, NOW, "SNMP timeout", "a1"]);
    executeRaw().mockClear();
    await recordTelemetryResult("a1", { supported: true });
    expect(executeRaw().mock.calls[0][3]).toBe("The device returned no CPU / memory data");
    expect(buf.telemetry).not.toHaveBeenCalled();
    expect(assetUpdate()).not.toHaveBeenCalled();
  });

  it("enqueues the sample and writes the success stamps", async () => {
    await recordTelemetryResult("a1", { supported: true, data: { cpuPct: 12.5, memPct: 40, memUsedBytes: 1024.4, memTotalBytes: 4096, sessionCount: 7 } });
    expect(buf.telemetry).toHaveBeenCalledOnce();
    expect(buf.telemetry.mock.calls[0][0]).toMatchObject({
      assetId: "a1", timestamp: NOW, cpuPct: 12.5, memPct: 40, memUsedBytes: 1024n, memTotalBytes: 4096n,
      cpuCorePcts: null, memBuffersBytes: null, swapUsedBytes: null, swapTotalBytes: null, memConsumedBytes: null, sessionCount: 7,
    });
    expect(assetUpdate().mock.calls[0][0]).toEqual({ where: { id: "a1" }, data: telemetrySuccessStamps(NOW) });
    expect(executeRaw()).not.toHaveBeenCalled();
  });

  it("writes every absent figure as null, not undefined", async () => {
    await recordTelemetryResult("a1", { supported: true, data: {} });
    const row = buf.telemetry.mock.calls[0][0] as Record<string, unknown>;
    for (const [k, v] of Object.entries(row)) if (k !== "assetId" && k !== "timestamp") expect(v, k).toBeNull();
  });

  it("rounds band figures and clamps a negative band to 0, and drops a non-finite band to null", async () => {
    await recordTelemetryResult("a1", { supported: true, data: { memCachedBytes: 10.6, memFreeBytes: -3, memPrivateBytes: Number.NaN, memSharedBytes: Number.POSITIVE_INFINITY } });
    expect(buf.telemetry.mock.calls[0][0]).toMatchObject({ memCachedBytes: 11n, memFreeBytes: 0n, memPrivateBytes: null, memSharedBytes: null });
  });

  // Was a bug until 2026-11-14: memUsedBytes / memTotalBytes skip the bytesOrNull guard their band
  // siblings use: BigInt(Math.round(NaN)) throws a RangeError, so a collector
  // that hands back memUsedBytes: NaN makes recordTelemetryResult REJECT — no
  // sample, no success stamp. Right: a non-finite total/used reads as null
  // (like every band figure) and the poll still records its success.
  it("treats a non-finite memUsedBytes / memTotalBytes as null instead of throwing", async () => {
    await recordTelemetryResult("a1", { supported: true, data: { cpuPct: 5, memUsedBytes: Number.NaN, memTotalBytes: Number.POSITIVE_INFINITY } });
    expect(buf.telemetry.mock.calls[0][0]).toMatchObject({ memUsedBytes: null, memTotalBytes: null });
    expect(assetUpdate()).toHaveBeenCalledOnce();
  });
});

describe("recordHardwareSensorResult", () => {
  const sensor = (over: Partial<HardwareSensorSample>): HardwareSensorSample => ({ sensorName: "s", sensorClass: "temperature", value: 40, unit: "C", alarmStatus: null, ...over });
  const rows = () => buf.sensors.mock.calls[0][0] as Array<Record<string, unknown>>;

  it("writes nothing for an unsupported stream, a failed scrape or an empty list", async () => {
    await recordHardwareSensorResult("a1", { supported: false, data: [sensor({})] });
    await recordHardwareSensorResult("a1", { supported: true, error: "x" });
    await recordHardwareSensorResult("a1", { supported: true, data: [] });
    expect(buf.sensors).not.toHaveBeenCalled();
  });

  it("drops implausible temperatures (outside -40..200 or non-finite) but keeps a null reading", async () => {
    await recordHardwareSensorResult("a1", { supported: true, data: [
      sensor({ sensorName: "ok", value: 55 }),
      sensor({ sensorName: "low-edge", value: -40 }),
      sensor({ sensorName: "high-edge", value: 200 }),
      sensor({ sensorName: "scaled", value: 52000 }),
      sensor({ sensorName: "cold", value: -41 }),
      sensor({ sensorName: "nan", value: Number.NaN }),
      sensor({ sensorName: "unread", value: null }),
    ] });
    expect(rows().map((r) => r.sensorName)).toEqual(["ok", "low-edge", "high-edge", "unread"]);
  });

  it("passes other classes through whatever their range", async () => {
    await recordHardwareSensorResult("a1", { supported: true, data: [sensor({ sensorClass: "fan", value: 12000, unit: "rpm" })] });
    expect(rows()).toHaveLength(1);
  });

  it("writes nothing when every row was filtered out", async () => {
    await recordHardwareSensorResult("a1", { supported: true, data: [sensor({ value: 9999 })] });
    expect(buf.sensors).not.toHaveBeenCalled();
  });

  it("stamps each row with the asset and one timestamp, and ifName null when absent", async () => {
    await recordHardwareSensorResult("a1", { supported: true, data: [sensor({ sensorName: "sfp", ifName: "port1" }), sensor({ sensorName: "cpu" })] });
    expect(rows()).toEqual([
      { assetId: "a1", timestamp: NOW, sensorName: "sfp", sensorClass: "temperature", value: 40, unit: "C", alarmStatus: null, ifName: "port1" },
      { assetId: "a1", timestamp: NOW, sensorName: "cpu", sensorClass: "temperature", value: 40, unit: "C", alarmStatus: null, ifName: null },
    ]);
  });
});
