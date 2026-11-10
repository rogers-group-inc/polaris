/**
 * src/services/monitoring/pollStamps.ts — attempt vs success stamps (business rule 118; CQ-B061, moved verbatim from
 * monitoringService.ts): the failure text and the per-stream last-attempt / last-success
 * stamps a poll writes whether or not it read anything.
 */

import { prisma } from "../../db.js";
import { enqueueTelemetrySample, enqueueHardwareSensorSamples } from "../sampleWriteBuffer.js";
import { type TelemetrySample, type HardwareSensorSample, type CollectionResult } from "./types.js";

// ─── Persisting telemetry / system info ─────────────────────────────────────

/** Byte figure → BigInt, keeping null as null (a band nobody measured). */
function bytesOrNull(v: number | null | undefined): bigint | null {
  return v != null && Number.isFinite(v) ? BigInt(Math.max(0, Math.round(v))) : null;
}

// ─── Attempt vs success stamps (business rule 118) ──────────────────────────
//
// Each heavy stream keeps the last ATTEMPT (the scheduler's due anchor) apart
// from the last SUCCESS (what "updated X ago", the stale banner and the system
// info anchor read). One stamp used to do both jobs, and the two streams had
// settled the conflict in opposite directions: telemetry stamped every attempt,
// so a device whose REST pull failed forever read "updated 1m ago" over an
// empty chart; system info stamped only successes, so the UI was honest but a
// failing device was re-walked on every heavy tick.

/** Cap on a stored failure message — a collector error is one line, but a
 *  thrown HTML body or a stack must not land in an Asset column whole. */
export const POLL_ERROR_MAX_LEN = 500;

/** The message a failed collection leaves behind: its own error, or a plain
 *  statement that the device answered with nothing usable. */
export function pollFailureText(error: string | null | undefined, fallback: string): string {
  const text = (error ?? "").trim() || fallback;
  return text.length > POLL_ERROR_MAX_LEN ? text.slice(0, POLL_ERROR_MAX_LEN - 1) + "…" : text;
}

/** The columns a SUCCESSFUL poll of a stream writes: success and attempt
 *  together, and the failure run closed. Every success writer spreads this —
 *  the agent push routes included — because a success that left the attempt
 *  stamp behind would leave the stream due on every tick. */
export function telemetrySuccessStamps(at: Date) {
  return { lastTelemetryAt: at, lastTelemetryAttemptAt: at, telemetryFailingSince: null, telemetryLastError: null };
}

export function systemInfoSuccessStamps(at: Date) {
  return { lastSystemInfoAt: at, lastSystemInfoAttemptAt: at, systemInfoFailingSince: null, systemInfoLastError: null };
}

/** A FAILED poll: stamp the attempt, open the failure run if none is open
 *  (COALESCE — the run starts at its FIRST failure, which a read-then-write
 *  would race), record the message. The success stamp is untouched. One
 *  statement, and only on the failure path. */
export async function recordStreamFailure(stream: "telemetry" | "systemInfo", assetId: string, at: Date, message: string): Promise<void> {
  if (stream === "telemetry") {
    await prisma.$executeRaw`UPDATE assets SET "lastTelemetryAttemptAt" = ${at}, "telemetryFailingSince" = COALESCE("telemetryFailingSince", ${at}), "telemetryLastError" = ${message} WHERE id = ${assetId}`;
  } else {
    await prisma.$executeRaw`UPDATE assets SET "lastSystemInfoAttemptAt" = ${at}, "systemInfoFailingSince" = COALESCE("systemInfoFailingSince", ${at}), "systemInfoLastError" = ${message} WHERE id = ${assetId}`;
  }
}

export async function recordTelemetryResult(assetId: string, result: CollectionResult<TelemetrySample>): Promise<void> {
  if (!result.supported) return;
  const now = new Date();
  if (!result.data) {
    await recordStreamFailure("telemetry", assetId, now, pollFailureText(result.error, "The device returned no CPU / memory data"));
    return;
  }
  const d = result.data;
  enqueueTelemetrySample({
    assetId,
    timestamp: now,
    cpuPct:        d.cpuPct ?? null,
    memPct:        d.memPct ?? null,
    memUsedBytes:  d.memUsedBytes  != null ? BigInt(Math.round(d.memUsedBytes))  : null,
    memTotalBytes: d.memTotalBytes != null ? BigInt(Math.round(d.memTotalBytes)) : null,
    // Per-core CPU reaches this function from the vCenter collector and the
    // Unraid / TrueNAS host snapshot (workloadMonitorService);
    // the agent's copy arrives on its own push path (routes/agents.ts),
    // which writes this buffer directly. FortiOS REST, SNMP, WinRM and SSH
    // expose no per-core figure at all and leave it null.
    cpuCorePcts:     d.cpuCorePcts ?? null,
    // The agent's band set (used + buffers + cached + free = total). One
    // server-side collector fills it — a TrueNAS host, whose ZFS ARC is the
    // `cached` band (workloadMonitorService) and which reconciles the sum
    // itself. Everything else leaves it null.
    memBuffersBytes: bytesOrNull(d.memBuffersBytes),
    memCachedBytes:  bytesOrNull(d.memCachedBytes),
    memFreeBytes:    bytesOrNull(d.memFreeBytes),
    swapUsedBytes:   null,
    swapTotalBytes:  null,
    // The vCenter band set, disjoint from the one above. Null everywhere
    // else, and the two are never populated on the same row.
    memPrivateBytes:    bytesOrNull(d.memPrivateBytes),
    memSharedBytes:     bytesOrNull(d.memSharedBytes),
    memBalloonedBytes:  bytesOrNull(d.memBalloonedBytes),
    memSwappedBytes:    bytesOrNull(d.memSwappedBytes),
    memCompressedBytes: bytesOrNull(d.memCompressedBytes),
    memConsumedBytes:   bytesOrNull(d.memConsumedBytes),
    sessionCount:  d.sessionCount ?? null,
  });
  await prisma.asset.update({ where: { id: assetId }, data: telemetrySuccessStamps(now) });
}

/**
 * Persist a hardware-sensor collection result. Unlike telemetry there is no
 * Asset.lastHardwareSensorAt column — the System tab derives the last-sample
 * timestamp from the latest AssetHardwareSensorSample row. If no samples were
 * written (device exposes no sensors, or the scrape failed), the System tab
 * keeps showing the prior timestamp and surfaces an amber "last successful
 * update X ago" badge once it falls behind the resolved cadence.
 */
export async function recordHardwareSensorResult(assetId: string, result: CollectionResult<HardwareSensorSample[]>): Promise<void> {
  if (!result.supported) return;
  if (Array.isArray(result.data) && result.data.length > 0) {
    // Sanity-filter ONLY temperature-class rows to a plausible operating range
    // — covers misinterpreted ENTITY-SENSOR-MIB scale/precision on some agents
    // (we've seen FortiSwitch sensors report 52000 / 34937). Other classes
    // (fan RPM, voltage, presence) have unbounded/different ranges and pass
    // through. Null value is preserved as the "couldn't read" signal.
    const filtered = result.data.filter(
      (s) =>
        s.sensorClass !== "temperature" ||
        s.value == null ||
        (Number.isFinite(s.value) && s.value >= -40 && s.value <= 200),
    );
    if (filtered.length === 0) return;
    const now = new Date();
    enqueueHardwareSensorSamples(
      filtered.map((s) => ({
        assetId,
        timestamp:   now,
        sensorName:  s.sensorName,
        sensorClass: s.sensorClass,
        value:       s.value,
        unit:        s.unit,
        alarmStatus: s.alarmStatus,
        ifName:      s.ifName ?? null,
      })),
    );
  }
}
