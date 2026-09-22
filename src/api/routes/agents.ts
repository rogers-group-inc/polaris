/**
 * src/api/routes/agents.ts — Polaris Agent inbound API surface
 *
 * Mounted at /api/v1/agents/. Two auth surfaces:
 *
 *  - `POST /enroll` is public: the agent posts its one-shot enrollment
 *    token (baked into agent.conf at install time) and reports the cert
 *    fingerprint it observed on the TLS handshake. Server cross-checks the
 *    pin, mints a long-lived bearer, transitions installStatus → "active".
 *
 *  - Everything else (`POST /samples`, `GET /config`, `POST /heartbeat`)
 *    is gated by `requireAgentBearer`. The bearer is bound to a single
 *    assetId at issuance; the /samples handler stamps that assetId onto
 *    every sample server-side, ignoring any client-supplied value —
 *    defense against stolen-bearer cross-asset reuse.
 *
 * Phase 2 scope: end-to-end testable with curl alone. The Go agent
 * (Phase 3) calls these endpoints; the WebSocket pull side comes in a
 * follow-on. Samples land via the existing sampleWriteBuffer so they
 * appear on the asset details page within 2 s.
 */

import { Router } from "express";
import { z } from "zod";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve as resolvePath, basename } from "node:path";
import { prisma } from "../../db.js";
import { AppError } from "../../utils/errors.js";
import { AGENT_BIN_DIR } from "../../utils/paths.js";
import { requireAgentBearer } from "../middleware/auth.js";
import { agentApiLimiter, agentBinaryLimiter } from "../middleware/rateLimits.js";
import {
  consumeEnrollmentToken,
} from "../../services/agentTokenService.js";
import {
  recordProbeResult,
  resolveMonitorSettings,
  invalidateMonitorSettingsCache,
  persistAssetProcesses,
  persistProcessConnections,
} from "../../services/monitoringService.js";
import {
  enqueueMonitorSample,
  enqueueTelemetrySample,
  enqueueHardwareSensorSamples,
  enqueueInterfaceSamples,
  enqueueStorageSamples,
  enqueueProcessSamples,
  enqueueProcessLogSamples,
  enqueueServiceLogSamples,
} from "../../services/sampleWriteBuffer.js";
import { persistAssetServices } from "../../services/serviceInventoryService.js";
import { persistInterfaceRows } from "../../services/interfaceInventoryService.js";
import { reconcileMacAddresses, reconcileInterfaceMacs } from "../../services/macAddressService.js";
import { selectPrimaryMac } from "../../utils/macAddresses.js";
import { isUsableSerial } from "../../utils/serialNumber.js";
import { logEvent } from "./events.js";
import { buildFirmwareChangedEvent } from "../../services/eventLogService.js";
import { ingestOsEventLog, getAgentEventLogConfig } from "../../services/osEventLogService.js";
import { fetchPendingCommands, recordCommandResult } from "../../services/agentCommandService.js";
import { SCRIPT_OUTPUT_CAP_BYTES } from "../../services/automationScriptService.js";
import { logger } from "../../utils/logger.js";
import { macColonUpperOrNull } from "../../utils/mac.js";

// ─── /enroll (public) ─────────────────────────────────────────────────
//
// Mounted on its own sub-router so router.ts can attach it BEFORE the
// requireAgentBearer guard (the agent has no bearer yet at this point).

export const agentsEnrollRouter = Router();

const EnrollSchema = z.object({
  enrollmentToken:             z.string().min(1),
  osPlatform:                  z.enum(["linux", "darwin", "windows"]),
  arch:                        z.enum(["amd64", "arm64"]),
  agentVersion:                z.string().min(1).max(64),
  hostname:                    z.string().max(255).optional(),
  serverCertFingerprintSeen:   z.string().regex(/^sha256:[0-9a-f]{64}$/i),
});

agentsEnrollRouter.post("/", async (req, res, next) => {
  try {
    const body = EnrollSchema.parse(req.body);

    const consumed = await consumeEnrollmentToken(body.enrollmentToken);
    const { managedAgent, bearer } = consumed;

    // Cross-check the pin against the SET of allowed fingerprints. Phase 2
    // dual-pin: the canonical `serverCertFingerprint` is what was captured
    // at install kickoff; `additionalServerCertFingerprints` is the staged
    // pins an operator added for zero-downtime rotation. The agent reports
    // the fingerprint it observed during the TLS handshake; we accept it if
    // it matches ANY pin in the union. Mismatch on every pin means
    // something is intercepting the connection (or the operator hasn't yet
    // staged the cert nginx is serving) — refuse to issue the bearer.
    // We've already consumed the enrollment token (it's one-shot); the
    // install is dead in this state and the operator must Reinstall to
    // get a fresh enrollment.
    const expectedPins = [
      managedAgent.serverCertFingerprint,
      ...managedAgent.additionalServerCertFingerprints,
    ].map((p) => p.toLowerCase());
    const observedPin = body.serverCertFingerprintSeen.toLowerCase();
    if (!expectedPins.includes(observedPin)) {
      // The transaction in consumeEnrollmentToken already minted a bearer
      // we now need to revoke. Mark the install as failed so the operator
      // sees a clear error in the UI.
      await prisma.managedAgent.update({
        where: { id: managedAgent.id },
        data: {
          installStatus: "failed",
          installError:  `Cert pin mismatch — expected one of [${expectedPins.join(", ")}], agent saw ${observedPin}`,
          bearerRevokedAt: new Date(),
        },
      });
      await logEvent({
        action:       "agent.install_failed",
        resourceType: "asset",
        resourceId:   managedAgent.assetId,
        level:        "error",
        message:      "Agent enrollment rejected: TLS cert pin mismatch",
        details:      { expectedPins, observedPin, managedAgentId: managedAgent.id },
      });
      throw new AppError(400, "Server cert fingerprint mismatch — refusing enrollment");
    }

    // Plat/arch sanity: the install scripts should already have stamped
    // these on the row, but if the agent reports a different combo (host
    // got re-imaged with a different OS), refuse rather than silently
    // accept a mismatch.
    if (managedAgent.osPlatform !== body.osPlatform || managedAgent.arch !== body.arch) {
      await prisma.managedAgent.update({
        where: { id: managedAgent.id },
        data: {
          installStatus: "failed",
          installError:  `Platform mismatch — install expected ${managedAgent.osPlatform}/${managedAgent.arch}, agent reported ${body.osPlatform}/${body.arch}`,
          bearerRevokedAt: new Date(),
        },
      });
      throw new AppError(400, "Platform/arch mismatch — refusing enrollment");
    }

    await prisma.managedAgent.update({
      where: { id: managedAgent.id },
      data: { agentVersion: body.agentVersion },
    });

    await logEvent({
      action:       "agent.enrolled",
      resourceType: "asset",
      resourceId:   managedAgent.assetId,
      level:        "info",
      message:      `Polaris Agent enrolled (${body.osPlatform}/${body.arch} v${body.agentVersion})`,
      details:      { managedAgentId: managedAgent.id, hostname: body.hostname ?? null },
    });

    res.json({
      bearer,
      assetId:    managedAgent.assetId,
      configEtag: await computeConfigEtag(managedAgent.assetId),
    });
  } catch (err) { next(err); }
});

// ─── Bearer-gated routes ──────────────────────────────────────────────

export const agentsRouter = Router();
agentsRouter.use(agentApiLimiter);
agentsRouter.use(requireAgentBearer);

// ─── Sample wire shapes ───────────────────────────────────────────────
//
// Discriminated union by `stream`. Each variant maps to a sampleWriteBuffer
// enqueue helper that batches inserts every 2 s. The /samples handler
// stamps `req.managedAgent.assetId` on every row — client-supplied assetId
// is intentionally not on the wire shape at all to make the cross-asset
// abuse surface vanishingly small.

const ResponseTimeSampleSchema = z.object({
  timestamp:      z.string().datetime().optional(), // defaults to server clock
  success:        z.boolean(),
  responseTimeMs: z.number().int().nullable().optional(), // null = packet loss
  error:          z.string().max(500).nullable().optional(),
  uptimeSec:      z.number().int().nonnegative().nullable().optional(), // host uptime → Asset.lastUptimeSec + reboot detection
});

const TelemetrySampleSchema = z.object({
  timestamp:     z.string().datetime().optional(),
  cpuPct:        z.number().nullable().optional(),
  // Per-logical-core utilisation, index = core id. Agent-only; every other
  // transport omits it and the column stays null. Capped at 512 to match the
  // agent's own `maxReportedCores` — the bound is what keeps a malformed or
  // hostile push from writing an unbounded jsonb array into a hypertable row.
  cpuCorePcts:   z.array(z.number()).max(512).nullable().optional(),
  memPct:        z.number().nullable().optional(),
  memUsedBytes:  z.number().int().nullable().optional(),
  memTotalBytes: z.number().int().nullable().optional(),
  // Memory breakdown. The agent guarantees used+buffers+cached+free ==
  // total; the server does NOT re-derive or re-clamp that, because a source
  // that ever sends bands which don't close should show as the anomaly it is
  // rather than be silently rounded into looking fine.
  memBuffersBytes: z.number().int().nonnegative().nullable().optional(),
  memCachedBytes:  z.number().int().nonnegative().nullable().optional(),
  memFreeBytes:    z.number().int().nonnegative().nullable().optional(),
  swapUsedBytes:   z.number().int().nonnegative().nullable().optional(),
  swapTotalBytes:  z.number().int().nonnegative().nullable().optional(),
  temperatures:  z.array(z.object({
    sensorName: z.string().max(128),
    celsius:    z.number().nullable(),
  })).optional(),
});

const InterfaceSampleSchema = z.object({
  timestamp:     z.string().datetime().optional(),
  ifName:        z.string().min(1).max(128),
  adminStatus:   z.string().max(32).nullable().optional(),
  operStatus:    z.string().max(32).nullable().optional(),
  speedBps:      z.number().int().nullable().optional(),
  ipAddress:     z.string().max(64).nullable().optional(),
  macAddress:    z.string().max(64).nullable().optional(),
  inOctets:      z.number().int().nullable().optional(),
  outOctets:     z.number().int().nullable().optional(),
  inErrors:      z.number().int().nullable().optional(),
  outErrors:     z.number().int().nullable().optional(),
  ifType:        z.string().max(32).nullable().optional(),
  ifParent:      z.string().max(128).nullable().optional(),
  vlanId:        z.number().int().nullable().optional(),
  alias:         z.string().max(255).nullable().optional(),
  description:   z.string().max(1024).nullable().optional(),
});

const StorageSampleSchema = z.object({
  timestamp:  z.string().datetime().optional(),
  mountPath:  z.string().min(1).max(255),
  totalBytes: z.number().int().nullable().optional(),
  usedBytes:  z.number().int().nullable().optional(),
});

// OS event-log entries — curated host events folded into the audit Event table
// (NOT a sample table). The agent normalizes severity to
// critical/error/warning/info and dedupes within a poll (count >= 1).
const EventLogSampleSchema = z.object({
  timestamp: z.string().datetime().optional(),
  channel:   z.string().min(1).max(128),
  provider:  z.string().max(255).nullable().optional(),
  eventId:   z.number().int().nullable().optional(),
  level:     z.string().max(32),
  message:   z.string().max(8192),
  count:     z.number().int().min(1).nullable().optional(),
});

// Current-state process inventory — one row per program (aggregated by name
// across PIDs). Replaces the asset's whole inventory per push.
const ProcessSampleSchema = z.object({
  name:          z.string().min(1).max(255),
  instanceCount: z.number().int().min(1).max(100000).optional(),
  cpuPct:        z.number().nullable().optional(),
  memRssBytes:   z.number().int().nullable().optional(),
  exePath:       z.string().max(1024).nullable().optional(),
  username:      z.string().max(255).nullable().optional(),
  startedAt:     z.string().datetime().nullable().optional(),
  serviceUnit:   z.string().max(255).nullable().optional(),
});

// Per-pinned-program CPU/RAM (Feature C). One row per pinned program per
// minute; cpu/mem summed across instances.
const ProcessTelemetrySampleSchema = z.object({
  timestamp:     z.string().datetime().optional(),
  name:          z.string().min(1).max(255),
  cpuPct:        z.number().nullable().optional(),
  memRssBytes:   z.number().int().nullable().optional(),
  instanceCount: z.number().int().nullable().optional(),
});

// Per-MAPPED-program socket facts (Application Map). Accumulate+age rows —
// see persistProcessConnections. Sentinels ("" / 0) fill the fields a kind
// doesn't use, matching the asset_process_connections business key.
const ProcessConnectionSampleSchema = z.object({
  name:       z.string().min(1).max(255),
  kind:       z.enum(["listen", "outbound", "inbound"]),
  proto:      z.enum(["tcp", "udp"]),
  localAddr:  z.string().max(64).optional(),
  localPort:  z.number().int().min(0).max(65535).optional(),
  remoteIp:   z.string().max(64).optional(),
  remotePort: z.number().int().min(0).max(65535).optional(),
  // Owning systemd unit / Windows service (Phase 3). Attribute-only.
  unit:       z.string().max(255).optional(),
});

// Per-pinned-program log lines (Feature C).
const ProcessLogSampleSchema = z.object({
  timestamp: z.string().datetime().optional(),
  name:      z.string().min(1).max(255),
  level:     z.string().max(32).nullable().optional(),
  message:   z.string().max(8192),
  source:    z.string().max(512).nullable().optional(),
});

// Current-state service inventory — one row per systemd unit / Windows service.
// Full-replaced per push (persistAssetServices). platform drives the state
// vocabulary; controllable is derived server-side.
const ServiceSampleSchema = z.object({
  unit:         z.string().min(1).max(255),
  platform:     z.enum(["systemd", "windows"]),
  displayName:  z.string().max(512).nullable().optional(),
  loadState:    z.string().max(64).nullable().optional(),
  activeState:  z.string().max(64).nullable().optional(),
  subState:     z.string().max(64).nullable().optional(),
  enabledState: z.string().max(64).nullable().optional(),
  mainPid:      z.number().int().min(0).nullable().optional(),
  mainProcess:  z.string().max(255).nullable().optional(),
  memBytes:     z.number().int().min(0).nullable().optional(),
});

// Per-pinned-unit journalctl log lines (Phase 2, service dimension). Same shape
// as ProcessLogSampleSchema with `unit` for `name`.
const ServiceLogSampleSchema = z.object({
  timestamp: z.string().datetime().optional(),
  unit:      z.string().min(1).max(255),
  level:     z.string().max(32).nullable().optional(),
  message:   z.string().max(8192),
  source:    z.string().max(512).nullable().optional(),
});

const SamplesBodySchema = z.discriminatedUnion("stream", [
  z.object({ stream: z.literal("responseTime"), samples: z.array(ResponseTimeSampleSchema).min(1).max(500) }),
  z.object({ stream: z.literal("telemetry"),    samples: z.array(TelemetrySampleSchema).min(1).max(500) }),
  z.object({ stream: z.literal("interfaces"),   samples: z.array(InterfaceSampleSchema).min(1).max(5000) }),
  z.object({ stream: z.literal("storage"),      samples: z.array(StorageSampleSchema).min(1).max(500) }),
  z.object({ stream: z.literal("eventLog"),     samples: z.array(EventLogSampleSchema).min(1).max(500) }),
  // A host can run thousands of processes; the agent already aggregates by
  // name, but cap generously so a pathological host can't OOM the handler.
  z.object({ stream: z.literal("processInventory"), samples: z.array(ProcessSampleSchema).max(10000) }),
  z.object({ stream: z.literal("processTelemetry"), samples: z.array(ProcessTelemetrySampleSchema).min(1).max(500) }),
  z.object({ stream: z.literal("processLog"),       samples: z.array(ProcessLogSampleSchema).min(1).max(2000) }),
  // Application Map: listen/outbound/inbound rows for mapped processes. Caps
  // are enforced on-agent (200/500/200 per process+kind); 5000 bounds a
  // worst-case many-processes push.
  z.object({ stream: z.literal("processConnections"), samples: z.array(ProcessConnectionSampleSchema).max(5000) }),
  // Current-state service/unit inventory. "All loaded units" is ~150-200 rows
  // on a typical host; cap generously (delete-replace per push).
  z.object({ stream: z.literal("serviceInventory"), samples: z.array(ServiceSampleSchema).max(5000) }),
  // Per-pinned-unit journalctl lines. Bounded like processLog.
  z.object({ stream: z.literal("serviceLog"), samples: z.array(ServiceLogSampleSchema).min(1).max(2000) }),
]);

// ─── Per-stream ingest handlers (split from the /samples dispatcher, 2026-08
// audit — the ingest tests in tests/integration/agentSamplesIngest.test.ts
// pin every branch's contract). Each takes the schema-narrowed samples for
// its stream and returns the accepted count.

type SamplesBody = z.infer<typeof SamplesBodySchema>;
type StreamSamples<S extends SamplesBody["stream"]> = Extract<SamplesBody, { stream: S }>["samples"];

async function ingestResponseTime(assetId: string, samples: StreamSamples<"responseTime">, now: Date): Promise<number> {
  let accepted = 0;
  for (const s of samples) {
    const ts = s.timestamp ? new Date(s.timestamp) : now;
    // Enqueue the time-series sample.
    enqueueMonitorSample({
      assetId,
      timestamp:      ts,
      success:        s.success,
      responseTimeMs: s.success ? (s.responseTimeMs ?? 0) : null,
      error:          s.success ? null : (s.error ?? "Agent reported failure"),
    });
    // Drive the state machine + Asset row fields. opts.fromAgent
    // bypasses the agent-polling guard in recordProbeResult.
    await recordProbeResult(
      assetId,
      s.success
        ? { success: true,  responseTimeMs: s.responseTimeMs ?? 0, uptimeSec: s.uptimeSec ?? undefined }
        : { success: false, responseTimeMs: 0, error: s.error ?? "Agent reported failure", uptimeSec: s.uptimeSec ?? undefined },
      null,
      { fromAgent: true },
    );
    accepted++;
  }
  return accepted;
}

async function ingestTelemetry(assetId: string, samples: StreamSamples<"telemetry">, now: Date, sampleLog: boolean): Promise<number> {
  let accepted = 0;
  for (const s of samples) {
    const ts = s.timestamp ? new Date(s.timestamp) : now;
    const bytes = (v: number | null | undefined): bigint | null =>
      v != null ? BigInt(Math.round(v)) : null;
    enqueueTelemetrySample({
      assetId,
      timestamp:     ts,
      cpuPct:        s.cpuPct ?? null,
      // An EMPTY array is stored as null, not as `[]`: the agent omits the
      // field on a host whose per-core read failed, and a zero-length core
      // list would chart as "this host has no cores" rather than "no
      // per-core data" — the fallback the CPU chart keys off.
      cpuCorePcts:   s.cpuCorePcts && s.cpuCorePcts.length > 0 ? s.cpuCorePcts : null,
      memPct:        s.memPct ?? null,
      memUsedBytes:  bytes(s.memUsedBytes),
      memTotalBytes: bytes(s.memTotalBytes),
      memBuffersBytes: bytes(s.memBuffersBytes),
      memCachedBytes:  bytes(s.memCachedBytes),
      memFreeBytes:    bytes(s.memFreeBytes),
      swapUsedBytes:   bytes(s.swapUsedBytes),
      swapTotalBytes:  bytes(s.swapTotalBytes),
      // The vCenter band set. An agent reports the guest's OWN view of its
      // memory; ballooning and host swap are things done TO that guest from
      // outside it, which the guest cannot see and the agent must never
      // claim to have measured. A row carries one band set or the other.
      memPrivateBytes:    null,
      memSharedBytes:     null,
      memBalloonedBytes:  null,
      memSwappedBytes:    null,
      memCompressedBytes: null,
      memConsumedBytes:   null,
      sessionCount:  null, // FortiGate-only metric; agents don't report it
    });
    if (s.temperatures && s.temperatures.length > 0) {
      // The Go agent still posts `temperatures` ({sensorName, celsius}).
      // Map them forward into the unified hardware-sensor stream as the
      // temperature class so existing agents keep working without a
      // binary bump; a richer agent-side sensor payload can land later.
      enqueueHardwareSensorSamples(
        s.temperatures.map((t) => ({
          assetId,
          timestamp:   ts,
          sensorName:  t.sensorName,
          sensorClass: "temperature",
          value:       t.celsius,
          unit:        "°C",
          alarmStatus: null,
        })),
      );
    }
    accepted++;
  }
  // Bump lastTelemetryAt so the System tab reflects freshness.
  await prisma.asset.update({ where: { id: assetId }, data: { lastTelemetryAt: now } });
  if (sampleLog) {
    logger.info(
      { assetId, enqueued: accepted },
      "agent telemetry samples enqueued to write buffer",
    );
  }
  return accepted;
}

async function ingestInterfaces(assetId: string, samples: StreamSamples<"interfaces">, now: Date): Promise<number> {
  // Selection-aware cadence: the agent reports the host's full NIC table,
  // so stamp pinned interfaces "fast" (full retention + rollup) and the
  // rest "slow" (24h). See selection-aware retention.
  const pinnedIfaces = new Set(
    (await prisma.asset.findUnique({ where: { id: assetId }, select: { monitoredInterfaces: true } }))?.monitoredInterfaces ?? [],
  );
  // Anchor every row AND lastSystemInfoAt to ONE shared timestamp. The agent
  // sends its full NIC table in a single push (all rows share one collection
  // time), and the /system-info GET endpoint loads interfaces with an exact
  // equality match `timestamp = lastSystemInfoAt`. If the rows carry the
  // agent's clock while lastSystemInfoAt carries the server's `now`, the two
  // never match and the System tab interface table renders empty for every
  // agent-monitored asset (platform-independent). Use the agent's reported
  // timestamp when present (more accurate for the time-series/rollups),
  // falling back to server `now`, and pin lastSystemInfoAt to the same value.
  const sampleTs = samples[0]?.timestamp ? new Date(samples[0].timestamp) : now;
  // `rows` covers the whole NIC table — it feeds the current-state inventory
  // below. Only the PINNED subset is enqueued as time-series (see the filter
  // after this map, and persistInterfaceSampleStream for the rationale), so
  // every row that does get enqueued is "fast" by construction.
  const rows = samples.map((s) => ({
    assetId,
    timestamp:   sampleTs,
    cadence:     "fast" as const,
    ifName:      s.ifName,
    adminStatus: s.adminStatus ?? null,
    operStatus:  s.operStatus ?? null,
    speedBps:    s.speedBps != null ? BigInt(Math.round(s.speedBps)) : null,
    ipAddress:   s.ipAddress ?? null,
    macAddress:  s.macAddress ?? null,
    inOctets:    s.inOctets  != null ? BigInt(Math.round(s.inOctets))  : null,
    outOctets:   s.outOctets != null ? BigInt(Math.round(s.outOctets)) : null,
    inErrors:    s.inErrors  != null ? BigInt(Math.round(s.inErrors))  : null,
    outErrors:   s.outErrors != null ? BigInt(Math.round(s.outErrors)) : null,
    ifType:      s.ifType ?? null,
    ifParent:    s.ifParent ?? null,
    vlanId:      s.vlanId ?? null,
    // The Polaris Agent doesn't observe switch-port VLAN config — it
    // reads its own host's NIC table. Always null/empty from this source.
    nativeVlan:  null,
    taggedVlans: [] as number[],
    trunksAllVlans: false,
    alias:       s.alias ?? null,
    description: s.description ?? null,
    // The Polaris Agent doesn't report L3 addressing mode (no FortiOS CMDB
    // equivalent on a generic host); leave null.
    addressingMode: null,
    // PoE comes from POWER-ETHERNET-MIB over SNMP against a switch. An agent
    // runs ON a host, not on the switch powering it, so there is nothing to
    // report here.
    poeStatus: null,
    poeClass: null,
  }));
  // Time-series for PINNED interfaces only — unpinned rows used to land here as
  // cadence="slow" and be deleted 24h later, which was the bulk of the largest
  // table in the database for rows nothing read as history. Current state for
  // every interface is written just below.
  const pinnedRows = rows.filter((r) => pinnedIfaces.has(r.ifName));
  if (pinnedRows.length > 0) enqueueInterfaceSamples(pinnedRows);
  // CURRENT-STATE interface inventory. The agent push IS the full NIC table for
  // an agent-monitored host, so it's a legitimate full-pass writer — unlike the
  // fast pinned re-walk, which must never touch this table. Reuses the rows
  // built above (minus the two sample-only columns) so the 22-field mapping
  // lives in exactly one place. Skipped on empty for the same reason
  // lastSystemInfoAt is: an empty push shouldn't blank the System tab.
  if (rows.length > 0) {
    await persistInterfaceRows(
      assetId,
      rows.map(({ assetId: _assetId, timestamp: _timestamp, cadence: _cadence, ...rest }) => rest),
      sampleTs,
    );
  }
  // Fold EVERY pushed interface MAC (monitored or not) into the asset's
  // Associated MACs list (AssetMacAddress) — the same range-coalescing
  // fold recordSystemInfoResult does for the SNMP/REST scrape. For
  // agent-monitored hosts this push IS the system-info source. Contiguous
  // MACs collapse to [mac, macEnd] range rows; the replace is scoped to
  // source="monitor-interface" so rows owned by discovery/manual writers
  // (including the enroll path's primaryMac reconcile) are never touched.
  const ifaceMacs = samples
    .map((s) => s.macAddress)
    .filter((m): m is string => !!m);
  if (ifaceMacs.length > 0) {
    await reconcileInterfaceMacs(assetId, ifaceMacs, sampleTs);
  }
  await prisma.asset.update({ where: { id: assetId }, data: { lastSystemInfoAt: sampleTs } });
  return rows.length;
}

async function ingestEventLog(assetId: string, samples: StreamSamples<"eventLog">, sampleLog: boolean): Promise<number> {
  // OS event-log entries are curated into the audit Event table (not a
  // sample table) so they appear in the asset Events tab + ride syslog/SFTP
  // archival. Gated by the global agentEventLog master switch — if an
  // operator turned it off, a stale agent's push is dropped rather than
  // flooding the audit log. ingestOsEventLog applies the min-level filter,
  // dedupe, per-push cap, and per-asset hourly rate cap.
  const cfg = await getAgentEventLogConfig();
  if (!cfg.enabled) return 0;
  const hostname =
    (await prisma.asset.findUnique({ where: { id: assetId }, select: { hostname: true } }))?.hostname ?? null;
  const result = await ingestOsEventLog(
    assetId,
    hostname,
    samples.map((s) => ({
      timestamp: s.timestamp ?? null,
      channel:   s.channel,
      provider:  s.provider ?? null,
      eventId:   s.eventId ?? null,
      level:     s.level,
      message:   s.message,
      count:     s.count ?? null,
    })),
    cfg,
  );
  if (sampleLog) {
    logger.info({ assetId, accepted: result.accepted, suppressed: result.suppressed }, "agent eventLog ingested");
  }
  return result.accepted;
}

async function ingestProcessInventory(assetId: string, samples: StreamSamples<"processInventory">): Promise<number> {
  // Current-state inventory: full-replace the asset's process rows. The
  // agent aggregates by name; serviceUnit/controllable resolution lands in
  // Phase 4 (the agent doesn't report it yet, so controllable stays false).
  await persistAssetProcesses(
    assetId,
    samples.map((s) => ({
      name:          s.name,
      instanceCount: s.instanceCount ?? 1,
      cpuPct:        s.cpuPct ?? null,
      memRssBytes:   s.memRssBytes != null ? BigInt(Math.round(s.memRssBytes)) : null,
      exePath:       s.exePath ?? null,
      username:      s.username ?? null,
      startedAt:     s.startedAt ? new Date(s.startedAt) : null,
      serviceUnit:   s.serviceUnit ?? null,
      controllable:  Boolean(s.serviceUnit),
    })),
  );
  return samples.length;
}

async function ingestProcessTelemetry(assetId: string, samples: StreamSamples<"processTelemetry">, now: Date): Promise<number> {
  // Per-pinned-program CPU/RAM time-series. All rows cadence="fast" (only
  // pinned programs are sampled). Bumps lastSystemInfoAt like other
  // system-info-class streams so freshness reflects.
  const rows = samples.map((s) => ({
    assetId,
    timestamp:     s.timestamp ? new Date(s.timestamp) : now,
    cadence:       "fast" as const,
    name:          s.name,
    cpuPct:        s.cpuPct ?? null,
    memRssBytes:   s.memRssBytes != null ? BigInt(Math.round(s.memRssBytes)) : null,
    instanceCount: s.instanceCount ?? null,
  }));
  enqueueProcessSamples(rows);
  return rows.length;
}

async function ingestProcessLog(assetId: string, samples: StreamSamples<"processLog">, now: Date): Promise<number> {
  const rows = samples.map((s) => ({
    assetId,
    timestamp: s.timestamp ? new Date(s.timestamp) : now,
    name:      s.name,
    level:     s.level ?? null,
    message:   s.message,
    source:    s.source ?? null,
  }));
  enqueueProcessLogSamples(rows);
  return rows.length;
}

async function ingestProcessConnections(assetId: string, samples: StreamSamples<"processConnections">): Promise<number> {
  // Application Map socket facts. Intersect pushed names with the CURRENT
  // mapped set — a guard against agents running on a stale config (the
  // agent filters on-host; this is the server-side backstop, same posture
  // as the storage arm's pinned lookup).
  const mapRow = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { mappedProcesses: true, mappedServices: true },
  });
  const mappedNames = new Set(mapRow?.mappedProcesses ?? []);
  const mappedUnits = new Set(mapRow?.mappedServices ?? []);
  const rows = samples
    // Keep a row if its program is mapped by name OR its unit is mapped
    // (Phase 3) — the two pin dimensions are independent.
    .filter((s) => mappedNames.has(s.name) || (s.unit != null && mappedUnits.has(s.unit)))
    .map((s) => ({
      processName: s.name,
      kind:        s.kind,
      proto:       s.proto,
      localAddr:   s.localAddr ?? null,
      localPort:   s.localPort ?? null,
      remoteIp:    s.remoteIp ?? null,
      remotePort:  s.remotePort ?? null,
      unit:        s.unit ?? null,
    }));
  await persistProcessConnections(assetId, rows);
  return rows.length;
}

async function ingestServiceInventory(assetId: string, samples: StreamSamples<"serviceInventory">): Promise<number> {
  // Current-state inventory: full-replace the asset's service rows. The
  // server derives `controllable` from platform + load state.
  await persistAssetServices(
    assetId,
    samples.map((s) => ({
      unit:         s.unit,
      platform:     s.platform,
      displayName:  s.displayName ?? null,
      loadState:    s.loadState ?? null,
      activeState:  s.activeState ?? null,
      subState:     s.subState ?? null,
      enabledState: s.enabledState ?? null,
      mainPid:      s.mainPid ?? null,
      mainProcess:  s.mainProcess ?? null,
      memBytes:     s.memBytes != null ? BigInt(Math.round(s.memBytes)) : null,
    })),
  );
  return samples.length;
}

async function ingestServiceLog(assetId: string, samples: StreamSamples<"serviceLog">, now: Date): Promise<number> {
  const rows = samples.map((s) => ({
    assetId,
    timestamp: s.timestamp ? new Date(s.timestamp) : now,
    unit:      s.unit,
    level:     s.level ?? null,
    message:   s.message,
    source:    s.source ?? null,
  }));
  enqueueServiceLogSamples(rows);
  return rows.length;
}

async function ingestStorage(assetId: string, samples: StreamSamples<"storage">, now: Date): Promise<number> {
  const pinnedStorage = new Set(
    (await prisma.asset.findUnique({ where: { id: assetId }, select: { monitoredStorage: true } }))?.monitoredStorage ?? [],
  );
  const rows = samples.map((s) => ({
    assetId,
    timestamp:  s.timestamp ? new Date(s.timestamp) : now,
    cadence:    pinnedStorage.has(s.mountPath) ? ("fast" as const) : ("slow" as const),
    mountPath:  s.mountPath,
    totalBytes: s.totalBytes != null ? BigInt(Math.round(s.totalBytes)) : null,
    usedBytes:  s.usedBytes  != null ? BigInt(Math.round(s.usedBytes))  : null,
  }));
  enqueueStorageSamples(rows);
  await prisma.asset.update({ where: { id: assetId }, data: { lastSystemInfoAt: now } });
  return rows.length;
}

agentsRouter.post("/samples", async (req, res, next) => {
  try {
    const assetId = req.managedAgent!.assetId;
    const body = SamplesBodySchema.parse(req.body);
    const now = new Date();

    // Diagnostic receive-logging, opt-in via POLARIS_AGENT_SAMPLE_LOG=1 on the
    // web role. Off by default so production stays quiet; only agent traffic
    // reaches this handler, so the volume is one line per push per agent.
    const sampleLog = process.env.POLARIS_AGENT_SAMPLE_LOG === "1";
    if (sampleLog) {
      const first =
        body.stream === "telemetry" && body.samples.length > 0
          ? {
              cpuPct: body.samples[0].cpuPct,
              memPct: body.samples[0].memPct,
              temps: body.samples[0].temperatures?.length ?? 0,
            }
          : undefined;
      logger.info(
        { assetId, stream: body.stream, received: body.samples.length, first },
        "agent /samples received",
      );
    }

    let accepted = 0;
    if (body.stream === "responseTime")            accepted = await ingestResponseTime(assetId, body.samples, now);
    else if (body.stream === "telemetry")          accepted = await ingestTelemetry(assetId, body.samples, now, sampleLog);
    else if (body.stream === "interfaces")         accepted = await ingestInterfaces(assetId, body.samples, now);
    else if (body.stream === "eventLog")           accepted = await ingestEventLog(assetId, body.samples, sampleLog);
    else if (body.stream === "processInventory")   accepted = await ingestProcessInventory(assetId, body.samples);
    else if (body.stream === "processTelemetry")   accepted = await ingestProcessTelemetry(assetId, body.samples, now);
    else if (body.stream === "processLog")         accepted = await ingestProcessLog(assetId, body.samples, now);
    else if (body.stream === "processConnections") accepted = await ingestProcessConnections(assetId, body.samples);
    else if (body.stream === "serviceInventory")   accepted = await ingestServiceInventory(assetId, body.samples);
    else if (body.stream === "serviceLog")         accepted = await ingestServiceLog(assetId, body.samples, now);
    else                                           accepted = await ingestStorage(assetId, body.samples, now);

    res.json({ accepted, rejected: 0 });
  } catch (err) { next(err); }
});

// GET /config — the agent fetches its resolved cadences + which streams it
// should collect. Etag lets the agent issue If-None-Match on subsequent
// polls to short-circuit work when nothing changed.
agentsRouter.get("/config", async (req, res, next) => {
  try {
    const assetId = req.managedAgent!.assetId;
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      include: { discoveredByIntegration: true },
    });
    if (!asset) throw new AppError(404, "Asset not found");

    // Self-heal: an active agent owns all five per-stream polling columns.
    // consumeEnrollmentToken stamps them at enroll, but historical assets
    // enrolled before that landed (commit d43b9d8) — or an operator manually
    // resetting one to null after the fact — leave drift. Re-stamp here so
    // the agent's cadence reads, the resolver, and the System tab gate all
    // agree without requiring a Reinstall. Cheap: at-most one UPDATE per
    // drifted asset, after which the per-minute /config polls find no
    // drift and skip the write.
    // `processes` is stamped to "agent" by default too: an installed agent
    // collects its host's process inventory as part of doing its job (like
    // interfaces/storage) — no operator toggle required. (eventLog is NOT
    // self-healed: it stays opt-in via the global agentEventLog switch because
    // host log text can carry PII and is high-volume.)
    const drift =
      asset.responseTimePolling !== "agent" ||
      asset.cpuMemoryPolling    !== "agent" ||
      asset.temperaturePolling  !== "agent" ||
      asset.interfacesPolling   !== "agent" ||
      asset.lldpPolling         !== "agent" ||
      asset.storagePolling      !== "agent" ||
      asset.processesPolling    !== "agent";
    if (drift) {
      const before = {
        responseTimePolling: asset.responseTimePolling,
        cpuMemoryPolling:    asset.cpuMemoryPolling,
        temperaturePolling:  asset.temperaturePolling,
        interfacesPolling:   asset.interfacesPolling,
        lldpPolling:         asset.lldpPolling,
        storagePolling:      asset.storagePolling,
        processesPolling:    asset.processesPolling,
      };
      await prisma.asset.update({
        where: { id: assetId },
        data: {
          responseTimePolling: "agent",
          cpuMemoryPolling:    "agent",
          temperaturePolling:  "agent",
          interfacesPolling:   "agent",
          lldpPolling:         "agent",
          storagePolling:      "agent",
          processesPolling:    "agent",
        },
      });
      invalidateMonitorSettingsCache({
        integrationId: asset.discoveredByIntegrationId ?? null,
        assetType:     asset.assetType,
      });
      asset.responseTimePolling = "agent";
      asset.cpuMemoryPolling    = "agent";
      asset.temperaturePolling  = "agent";
      asset.interfacesPolling   = "agent";
      asset.lldpPolling         = "agent";
      asset.storagePolling      = "agent";
      asset.processesPolling    = "agent";
      await logEvent({
        action:       "monitor.polling_overridden_by_agent",
        resourceType: "asset",
        resourceId:   assetId,
        level:        "info",
        message:      "Polaris Agent took over all monitoring streams on this asset",
        details:      { before, managedAgentId: req.managedAgent!.managedAgentId },
      });
    }

    const eff = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });

    // Phase 2 dual-pin: ship the current pin set so the agent updates
    // agent.conf when an operator stages a new pin. The agent re-saves
    // agent.conf if `certFingerprints` diverges from what's on disk —
    // next TLS handshake then trusts the new cert too. Steady state:
    // additionalServerCertFingerprints is empty and certFingerprints is a
    // single-element list equal to the canonical pin, so the agent
    // detects no change. ETag below covers this field so a config-only
    // pin change still invalidates the 304 cache.
    const managedAgent = await prisma.managedAgent.findUnique({
      where: { id: req.managedAgent!.managedAgentId },
      select: { serverCertFingerprint: true, additionalServerCertFingerprints: true },
    });
    const certFingerprints = managedAgent
      ? [managedAgent.serverCertFingerprint, ...managedAgent.additionalServerCertFingerprints]
      : [];

    // OS event-log stream config — only delivered when this asset resolves the
    // eventLog stream to "agent". Carries the operator-tuned filter (min-level
    // + Windows channels + Linux priority + per-push cap) so the agent collects
    // only what's wanted. Gated on the master switch too: when agentEventLog is
    // globally disabled, ship enabled:false regardless of the resolved method.
    const eventLogConfig =
      eff.eventLogPolling === "agent" ? await getAgentEventLogConfig() : null;

    // Pinned-process list for the Feature-C telemetry + log loops. Only when
    // the processes stream resolves to agent. Each entry pairs an operator-
    // pinned program name with its log config (auto-detect by default; an
    // operator-typed glob/unit overrides). Empty when the stream isn't agent
    // or nothing is pinned. Part of the ETag so a pin/config change refreshes.
    const pinnedProcessNames = eff.processesPolling === "agent"
      ? ((asset.monitoredProcesses ?? []) as string[])
      : [];
    let pinnedProcesses: Array<{ name: string; logSource: string; logPathGlob: string | null }> = [];
    if (pinnedProcessNames.length > 0) {
      const cfgs = await prisma.assetProcessConfig.findMany({
        where: { assetId, name: { in: pinnedProcessNames } },
        select: { name: true, logSource: true, logPathGlob: true },
      });
      const byName = new Map(cfgs.map((c) => [c.name, c]));
      pinnedProcesses = pinnedProcessNames.map((name) => {
        const c = byName.get(name);
        return {
          name,
          logSource:   c?.logSource ?? "auto",
          logPathGlob: c?.logPathGlob ?? null,
        };
      });
    }

    const payload = {
      streams: {
        responseTime: {
          enabled:     eff.responseTimePolling === "agent",
          intervalSec: eff.intervalSeconds,
          timeoutMs:   eff.probeTimeoutMs,
        },
        telemetry: {
          // Stream-split (Slice 2): the agent's "telemetry" stream still
          // covers CPU/memory + temperature together; the agent isn't yet
          // taught about the two-stream split. Read cpuMemoryPolling as
          // the unified telemetry signal — temperaturePolling is intended
          // to diverge from cpuMemoryPolling only on appliance sources
          // (FortiAP wants SNMP for temperature even when CPU/mem is REST),
          // which the agent never runs on.
          enabled:     eff.cpuMemoryPolling === "agent",
          intervalSec: eff.cpuMemoryIntervalSeconds,
          timeoutMs:   eff.cpuMemoryTimeoutMs,
        },
        interfaces: {
          enabled:     eff.interfacesPolling === "agent",
          intervalSec: eff.systemInfoIntervalSeconds,
          timeoutMs:   eff.systemInfoTimeoutMs,
        },
        lldp: {
          enabled:     eff.lldpPolling === "agent",
          intervalSec: eff.systemInfoIntervalSeconds,
          timeoutMs:   eff.systemInfoTimeoutMs,
        },
        eventLog: {
          // Enabled only when the stream resolves to agent AND the global
          // agentEventLog master switch is on. The agent reads channels /
          // minLevel / maxPerPush from here; SNMP/SSH/WinRM/REST collection is
          // server-side and never reaches the agent.
          enabled:     eff.eventLogPolling === "agent" && eventLogConfig?.enabled === true,
          intervalSec: eff.eventLogIntervalSeconds,
          timeoutMs:   eff.eventLogTimeoutMs,
          minLevel:        eventLogConfig?.minLevel ?? "error",
          windowsChannels: eventLogConfig?.windowsChannels ?? ["System", "Application"],
          linuxMinPriority: eventLogConfig?.linuxMinPriority ?? 3,
          maxPerPush:      eventLogConfig?.maxPerPush ?? 100,
        },
        processes: {
          // Process inventory + (Feature C) pinned-process telemetry. Enabled
          // when the processes stream resolves to agent. Agentless transports
          // (SNMP/SSH/WinRM) collect server-side and never reach the agent.
          enabled:     eff.processesPolling === "agent",
          intervalSec: eff.processesIntervalSeconds,
          timeoutMs:   eff.processesTimeoutMs,
        },
        services: {
          // Current-state systemd unit / Windows service inventory. Agent-only
          // (agentless does not resolve units), so it's simply on whenever a
          // live agent polls config — no per-stream polling column. Fixed
          // cadence (the agent falls back to its own default when 0).
          enabled:     true,
          intervalSec: 300,
        },
      },
      monitored: asset.monitored,
      certFingerprints,
      pinnedProcesses,
      // Mapped-process names for the Application Map connections loop. Plain
      // string array (no per-entry log config — a mapped-only process must NOT
      // trigger the telemetry/log loops). Independent of pinnedProcesses; the
      // agent's processConnections loop keys off this set alone. Part of the
      // ETag (payload hash) so a Map toggle refreshes running agents.
      mappedProcesses: eff.processesPolling === "agent"
        ? ((asset.mappedProcesses ?? []) as string[])
        : [],
      // Service pins — units the operator flagged for per-unit journalctl
      // tailing (monitoredServices; Phase 2) and Application Map connection
      // attribution (mappedServices; Phase 3). Not tied to a polling column;
      // shipped whenever set. Part of the ETag (payload hash) so a pin toggle
      // refreshes running agents.
      monitoredServices: (asset.monitoredServices ?? []) as string[],
      mappedServices:    (asset.mappedServices ?? []) as string[],
    };
    const etag = computeEtag(payload);

    // Conditional GET — short-circuit when client already has this exact config.
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch && ifNoneMatch === etag) {
      res.status(304).end();
      return;
    }
    res.setHeader("ETag", etag);
    res.json({ etag, ...payload });
  } catch (err) { next(err); }
});

const HeartbeatSchema = z.object({
  agentVersion: z.string().min(1).max(64).optional(),
  // Raw CapEff hex from the agent's /proc/self/status (Linux, agent ≥0.17.1).
  // The VERIFIED privilege state — decoded server-side (utils/capEff) so the
  // Privilege surfaces can distinguish a healthy ptrace unit (SYS_PTRACE +
  // DAC_READ_SEARCH) from the pre-fix SYS_PTRACE-only unit that collects no
  // Application Map connections.
  capEff: z.string().max(32).optional(),
});

agentsRouter.post("/heartbeat", async (req, res, next) => {
  try {
    const body = HeartbeatSchema.parse(req.body ?? {});
    const managedAgentId = req.managedAgent!.managedAgentId;
    if (body.agentVersion || body.capEff) {
      await prisma.managedAgent.update({
        where: { id: managedAgentId },
        data: {
          ...(body.agentVersion ? { agentVersion: body.agentVersion } : {}),
          ...(body.capEff ? { reportedCapEff: body.capEff } : {}),
        },
      });
    }
    // verifyBearer already bumped lastSeenAt/lastSeenIp opportunistically.
    res.json({ ok: true, configEtag: await computeConfigEtag(req.managedAgent!.assetId) });
  } catch (err) { next(err); }
});

// ─── /commands + /command-result (bearer) — Phase 4 process control ───
//
// The agent polls /commands for pending Stop/Start/Restart requests (poll
// fallback; a WS push can wake it sooner later), executes each via the OS
// service manager, and reports the outcome to /command-result. Operator-
// initiated only — these endpoints never originate an action.
agentsRouter.get("/commands", async (req, res, next) => {
  try {
    const commands = await fetchPendingCommands(req.managedAgent!.managedAgentId);
    res.json({ commands });
  } catch (err) { next(err); }
});

const CommandResultSchema = z.object({
  commandId:   z.string().uuid(),
  success:     z.boolean(),
  error:       z.string().max(2048).nullable().optional(),
  resultState: z.string().max(128).nullable().optional(),
  // run_script results (0.13.0+): exit code + captured output (≤64 KB each,
  // the agent caps before sending; re-capped server-side on persist).
  exitCode:    z.number().int().nullable().optional(),
  stdout:      z.string().max(SCRIPT_OUTPUT_CAP_BYTES).nullable().optional(),
  stderr:      z.string().max(SCRIPT_OUTPUT_CAP_BYTES).nullable().optional(),
});
agentsRouter.post("/command-result", async (req, res, next) => {
  try {
    const body = CommandResultSchema.parse(req.body);
    await recordCommandResult(
      req.managedAgent!.managedAgentId,
      body.commandId,
      body.success,
      body.error ?? null,
      body.resultState ?? null,
      { exitCode: body.exitCode ?? null, stdout: body.stdout ?? null, stderr: body.stderr ?? null },
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── /system-info (bearer) ────────────────────────────────────────────
//
// The agent runs ON the host so it sees the truth for hostname / OS /
// manufacturer / model / serial via OS APIs + DMI/SMBIOS. We persist
// that observation as an `AssetSource` row keyed on the ManagedAgent's
// id (one row per installed agent), then re-project the asset and
// write back the discovery-owned fields. Beats AD/Entra/Intune in the
// priority table — see assetProjection.ts.
//
// Cadence: agent pushes at startup + every heartbeat tick (default 5 min).
// Cheap to do — host identity doesn't change between firmware updates so
// most pushes are no-ops on the DB side (same observed blob → same
// projection → no Asset write).

const SystemInfoSchema = z.object({
  hostname:       z.string().max(255).optional(),
  os:             z.string().max(255).optional(),    // human-readable, e.g. "Red Hat Enterprise Linux 8.10"
  osVersion:      z.string().max(64).optional(),     // os-release VERSION_ID, sw_vers ProductVersion, Windows build
  kernelVersion:  z.string().max(255).optional(),
  kernelArch:     z.string().max(32).optional(),
  manufacturer:   z.string().max(255).optional(),
  model:          z.string().max(255).optional(),
  serialNumber:   z.string().max(255).optional(),
  biosVersion:    z.string().max(255).optional(),
  primaryMac:     z.string().max(64).optional(),
  primaryIp:      z.string().max(64).optional(),
  agentVersion:   z.string().max(64).optional(),     // copy of the running binary's version; informational
});

agentsRouter.post("/system-info", async (req, res, next) => {
  try {
    const body         = SystemInfoSchema.parse(req.body ?? {});
    const assetId      = req.managedAgent!.assetId;
    const managedAgentId = req.managedAgent!.managedAgentId;
    const now          = new Date();

    // Build the observed blob — strip undefined so the priority rules'
    // truthy-check works cleanly.
    const observed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v !== undefined && v !== null && v !== "") observed[k] = v;
    }

    // Upsert the per-agent source row. The externalId is the ManagedAgent
    // id (stable per install, rotates on reinstall) — matches the pattern
    // every other source uses (entra.deviceId, ad.objectGUID, etc.).
    await prisma.assetSource.upsert({
      where: {
        sourceKind_externalId: {
          sourceKind: "polaris-agent",
          externalId: managedAgentId,
        },
      },
      update: {
        observed: observed as any,
        syncedAt: now,
        lastSeen: now,
        inferred: false,
      },
      create: {
        assetId,
        sourceKind: "polaris-agent",
        externalId: managedAgentId,
        observed:   observed as any,
        inferred:   false,
        firstSeen:  now,
        lastSeen:   now,
        syncedAt:   now,
      },
    });

    // Re-project + write back any field where projection now disagrees
    // with what's on Asset. Mirrors the Phase 11 reprojection in
    // syncDhcpSubnets but scoped to one asset.
    const allSources = await prisma.assetSource.findMany({
      where:  { assetId },
      select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
    });
    const projInput = allSources.map((s) => ({
      sourceKind: s.sourceKind,
      inferred:   s.inferred,
      observed:   s.observed as Record<string, unknown> | null,
      lastSeen:   s.lastSeen,
    }));
    const { projectAssetFromSources } = await import("../../utils/assetProjection.js");
    const { projected } = projectAssetFromSources(projInput);

    const current = await prisma.asset.findUnique({
      where:  { id: assetId },
      select: {
        hostname: true, serialNumber: true, manufacturer: true, model: true,
        os: true, osVersion: true, learnedLocation: true, macAddress: true,
      },
    });
    if (current) {
      const diff: Record<string, string | null> = {};
      const FIELDS: Array<keyof typeof current> = [
        "hostname", "serialNumber", "manufacturer", "model", "os", "osVersion",
      ];
      for (const f of FIELDS) {
        const next = projected[f as keyof typeof projected];
        if (next !== null && current[f] !== next) {
          diff[f] = next as string;
        }
      }

      // Business rule 84: a stored serial that is NOT a serial gets cleared when
      // no source can replace it. The loop above deliberately never writes a null — "no
      // source has an opinion" must not wipe a field — but that rule stranded
      // the values this endpoint used to create: agents before 0.20.1 reported
      // the Windows SystemSKU as the serial, and a fixed agent on the same host
      // reports an honest empty one, which the projection turns into null and
      // the loop then ignores. The junk would outlive the bug forever.
      // Scoped as narrowly as it can be: only a value that fails isUsableSerial
      // is cleared, so a real serial is never lost to a transient read failure.
      if (
        projected.serialNumber === null &&
        current.serialNumber !== null &&
        !isUsableSerial(current.serialNumber)
      ) {
        diff.serialNumber = null;
      }

      // MAC isn't owned by projectAssetFromSources (see polaris-change-impact -> cross-cutting/asset-source-projection.md "Fields the
      // projection does NOT own") — every discovery path writes it inline.
      // Mirror that here: normalize the agent's primaryMac to colon-upper,
      // merge into the AssetMacAddress side table preserving entries from
      // other sources, and bump Asset.macAddress to the freshest MAC.
      const agentMac = formatMacColonUpper(body.primaryMac);
      if (agentMac) {
        const existingRows = await prisma.assetMacAddress.findMany({
          where:  { assetId },
          select: { mac: true, source: true, device: true, subnetCidr: true, subnetName: true, lastSeen: true },
        });
        const nowIso = now.toISOString();
        const merged = existingRows.map((r) => ({
          mac:        r.mac,
          source:     r.source,
          device:     r.device     ?? undefined,
          subnetCidr: r.subnetCidr ?? undefined,
          subnetName: r.subnetName ?? undefined,
          lastSeen:   r.lastSeen.toISOString(),
        }));
        const hit = merged.find((m) => m.mac === agentMac);
        if (hit) {
          hit.lastSeen = nowIso;
          hit.source   = "polaris-agent";
        } else {
          merged.push({
            mac:        agentMac,
            source:     "polaris-agent",
            device:     undefined,
            subnetCidr: undefined,
            subnetName: undefined,
            lastSeen:   nowIso,
          });
        }
        merged.sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime());
        await reconcileMacAddresses(assetId, merged);
        // Hardware-truth entries (this polaris-agent row included) outrank
        // sightings for the primary slot — see selectPrimaryMac.
        const primary = selectPrimaryMac(merged) ?? merged[0]?.mac ?? null;
        if (primary && current.macAddress !== primary) {
          diff.macAddress = primary;
        }
      }

      if (Object.keys(diff).length > 0) {
        await prisma.asset.update({ where: { id: assetId }, data: diff as any });
        // The agent reads the RUNNING OS in-guest, so its firmware moves are
        // the most trustworthy signal we get — audit them. `diff` is already
        // the edge-triggered set (only fields whose value actually changed),
        // so no extra comparison or query is needed here.
        const firmwareEvent = buildFirmwareChangedEvent(
          { assetId, assetName: current.hostname, actor: "system:agent", source: "polaris-agent" },
          current,
          diff,
        );
        if (firmwareEvent) void logEvent(firmwareEvent);

        // The serial clear is its own record: a value disappearing off an
        // asset is exactly the change an operator will otherwise spend an
        // afternoon explaining, and it is a mutation this handler makes on
        // its own initiative rather than one a source asked for.
        if (diff.serialNumber === null) {
          void logEvent({
            action:       "asset.serial.cleared",
            resourceType: "asset",
            resourceId:   assetId,
            resourceName: current.hostname || undefined,
            actor:        "system:agent",
            level:        "info",
            message:      `Cleared the serial number on "${current.hostname || assetId}" — the stored value ` +
                          `"${current.serialNumber}" is a vendor placeholder, not a serial, and no source reported a real one`,
            details:      { previousSerialNumber: current.serialNumber, source: "polaris-agent", managedAgentId },
          });
        }
      }
    }

    // Bump the running agent's version stamp opportunistically — keeps
    // the asset details modal's Agent panel current without waiting for
    // the next heartbeat tick.
    if (body.agentVersion) {
      await prisma.managedAgent
        .update({ where: { id: managedAgentId }, data: { agentVersion: body.agentVersion } })
        .catch(() => { /* best-effort */ });
    }

    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Helpers ──────────────────────────────────────────────────────────

// Normalize a MAC string to colon-uppercase (AA:BB:CC:DD:EE:FF) — the
// stored format on AssetMacAddress.mac. Returns "" when the input isn't a
// 12-hex-digit MAC after stripping separators.
function formatMacColonUpper(mac: unknown): string {
  return macColonUpperOrNull(mac) ?? "";
}

async function computeConfigEtag(assetId: string): Promise<string> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { discoveredByIntegration: true },
  });
  if (!asset) return '"deleted"';
  const eff = await resolveMonitorSettings({
    ...asset,
    discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
  });
  const compact = {
    rt:    [eff.responseTimePolling, eff.intervalSeconds,           eff.probeTimeoutMs],
    tel:   [eff.cpuMemoryPolling,    eff.cpuMemoryIntervalSeconds,  eff.cpuMemoryTimeoutMs],
    ifc:   [eff.interfacesPolling,   eff.systemInfoIntervalSeconds, eff.systemInfoTimeoutMs],
    lldp:  [eff.lldpPolling,         eff.systemInfoIntervalSeconds, eff.systemInfoTimeoutMs],
    // storage / processes / eventLog MUST be in the change-detector too — a
    // running agent only re-fetches /config when this heartbeat etag changes,
    // and the /config self-heal that flips processes to agent only runs on that
    // re-fetch. Omitting them deadlocked process collection on already-running
    // agents (they'd only pick it up on restart). Pin sets are folded in BY
    // CONTENT (not count) so swapping one pinned name for another at constant
    // count still wakes the loops — a count-only fold left that case stale
    // until the next full /config poll.
    sto:   [eff.storagePolling,      eff.storageIntervalSeconds,    eff.storageTimeoutMs],
    proc:  [eff.processesPolling,    eff.processesIntervalSeconds],
    evt:   [eff.eventLogPolling,     eff.eventLogIntervalSeconds],
    pins:   (asset.monitoredProcesses ?? []).join("\u0001"),
    mapped: (asset.mappedProcesses   ?? []).join("\u0001"),
    // Service pins, folded by content so a swap at constant count still wakes
    // the service log/connection loops (same reasoning as the process pins).
    spins: (asset.monitoredServices ?? []).join(""),
    smap:  (asset.mappedServices    ?? []).join(""),
    mon:   asset.monitored,
  };
  return computeEtag(compact);
}

function computeEtag(payload: unknown): string {
  // Strong etag — the agent only ever fetches /config for itself so cache
  // semantics are simple. Hex digest keeps it short on the wire.
  const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
  return `"${hash}"`;
}

// Surface debug helper for tests / curl smoke-tests.

// ─── /binary/:filename (public — for WinRM install path) ──────────────
//
// The Windows install path can't easily SOAP-upload large files via
// WinRM (the WS-Management `Send` shell verb caps stdin at ~8 KB per
// frame and requires chunked envelope construction). Instead, the
// PowerShell installer running on the host fetches the binary over
// HTTPS from this endpoint — with a cert-pin verification callback so
// it doesn't trust system CAs.
//
// Public on purpose:
//
//  - The binary is GENERIC across every Polaris deployment. Per-install
//    identity (server URL, cert fingerprint, bearer) lives in agent.conf
//    which is generated server-side and embedded in the install command
//    over WinRM — never delivered through this endpoint. Knowing the
//    binary bytes gets an attacker exactly nothing.
//  - Operators in test environments install via `curl` smoke tests where
//    bearer-mediated downloads would be annoying.
//  - Whitelisted against manifest.json — only filenames the manifest
//    declares are served; everything else 404s. No directory traversal.

export const agentsBinaryRouter = Router();

agentsBinaryRouter.get("/:filename", agentBinaryLimiter, async (req, res, next) => {
  try {
    const filename = req.params.filename as string;
    // Defense-in-depth path-traversal check (the whitelist below is the
    // primary guard, but belt-and-suspenders for security review).
    if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
      throw new AppError(400, "Invalid filename");
    }
    const manifestPath = resolvePath(AGENT_BIN_DIR, "manifest.json");
    let manifestRaw: string;
    try {
      manifestRaw = await readFile(manifestPath, "utf8");
    } catch {
      throw new AppError(404, "Agent binaries not configured on this server");
    }
    const manifest = JSON.parse(manifestRaw) as { currentVersion: string; binaries: Record<string, string> };
    // Whitelist: filename must match one of the binaries declared in the
    // manifest for the current version. Operators rotating versions get
    // automatic protection — old filenames stop serving when the
    // manifest's currentVersion flips.
    const valid = Object.values(manifest.binaries || {}).includes(filename);
    if (!valid) throw new AppError(404, "Unknown binary");

    const fullPath = resolvePath(AGENT_BIN_DIR, manifest.currentVersion, filename);
    // Final guard: refuse to serve any path that escapes AGENT_BIN_DIR.
    const expectedPrefix = resolvePath(AGENT_BIN_DIR) + (process.platform === "win32" ? "\\" : "/");
    if (!fullPath.startsWith(expectedPrefix)) {
      throw new AppError(400, "Invalid binary path");
    }

    const st = await stat(fullPath).catch(() => null);
    if (!st || !st.isFile()) throw new AppError(404, "Binary not found");

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(st.size));
    res.setHeader("Content-Disposition", `attachment; filename="${basename(fullPath)}"`);
    // No caching — operators uploading a freshly-rebuilt binary expect
    // the next install to pick up the new bytes.
    res.setHeader("Cache-Control", "no-store");
    createReadStream(fullPath).pipe(res);
  } catch (err) { next(err); }
});
