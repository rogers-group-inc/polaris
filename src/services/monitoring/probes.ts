/**
 * src/services/monitoring/probes.ts — response-time probes (CQ-B061, moved verbatim from monitoringService.ts): the
 * probeAsset entry point that dispatches on an asset's resolved polling method, and every
 * probe implementation — Fortinet REST, the managed-switch / AP controller probe, ICMP,
 * SNMP, WinRM, SSH, HTTP — plus the credential test the Test button runs.
 */

import { toNonNegativeInt } from "../../utils/num.js";
import { pinnedAgentFor } from "../../utils/pinnedTlsAgent.js";
import { performance } from "node:perf_hooks";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { type HttpCheckConfig, type HttpProbeDiagnostics, MAX_BODY_BYTES, bodyExcerpt, describeHttpTarget, evaluateHttpCheck, resolveHttpTarget, resolveHttpAuthMode, type HttpAuthConfig } from "../../utils/httpCheck.js";
import { parseDigestChallenge, buildDigestAuthorization, authSchemesOffered, newCnonce } from "../../utils/digestAuth.js";
import { URL } from "node:url";
import * as snmp from "net-snmp";
import { Client as SshClient } from "ssh2";
import { buildHostVerifier } from "../../utils/remoteExec.js";
import { prisma } from "../../db.js";
import { bareHost, urlHost } from "../../utils/cidr.js";
import { burstPingHost } from "../../utils/icmpPing.js";
import { fgRequest, FortiosAuthPausedError } from "../fortigateService.js";
import { SYS_OIDS } from "../../utils/snmpIdentity.js";
import { parseVendorSysDescr, descrReadDue } from "../../utils/snmpDescrIdentity.js";
import { logger } from "../../utils/logger.js";
import { adBindFallbackAllowed } from "../../utils/adBindFallback.js";
import { readSystemStatus } from "../../utils/fortiosEnvelope.js";
import { reconcileFortinetLiveVersions, fortigateLiveVersionFor } from "../fortinetLiveVersionService.js";
import { getPendingProbePatch } from "../probePatchBuffer.js";
import { judgeAgentSilence } from "../../utils/agentSilence.js";
import { probeStillDue } from "../../utils/monitorStatus.js";
import { assetSourceKindFromIntegrationType, isFortinetIntegrationType, isWorkloadPollingMethod } from "../../utils/pollingCompatibility.js";
import { probeWorkload } from "../workloadMonitorService.js";
import { probeGenericApi } from "../genericApiMonitorService.js";
import { snmpTicksToSeconds } from "../../utils/uptime.js";
import { type CredentialLike } from "../../utils/fortinetRestCredential.js";
import { dial } from "./dial.js";
import { HARDCODED_FLOOR, sysUpTimeOid, PROBE_ASSET_OMIT, resolveMonitorSettings, resolveSnmpConfigForStream } from "./monitorSettings.js";
import { type ProbeResult, type AssetMonitorSnapshot } from "./types.js";
import { finish } from "./common.js";
import { withSnmpGate, buildSnmpSession, snmpVbToString } from "./snmpCore.js";
import { buildFortinetConfig } from "./fortiosCollectors.js";
import { fetchFortinetControllerInventory } from "./fortinetControllers.js";
import { probeFortimanagerNative, probeVcenter } from "./vcenterFmgCollectors.js";
import { applyDescrIdentity } from "./systemInfoPersist.js";
import { agentListeningSince, agentFleetLiveness, restartAgentListening } from "./agentSilence.js";

// ─── Probe entry point ──────────────────────────────────────────────────────

/**
 * Run a single probe against the asset (no DB writes — caller persists).
 * The probe always returns a result; thrown errors are caught and packaged
 * into `{ success: false, error }` so the monitor loop never aborts.
 *
 * Hot loop callers pass `out` to surface the loaded asset row to the
 * subsequent `recordProbeResult` call — that lets recordProbeResult skip
 * its own findUnique on the state-machine update path. The /probe-now
 * route doesn't bother (one operator-triggered request, savings don't
 * matter); leaves `out` undefined and pays the second read.
 *
 * `out.dueIntervalSec` is the resolved probe interval the pg-boss publisher
 * carried on the job. When set, an asset already polled since the job was
 * published returns `{ duplicate: true }` without touching the network (see
 * `probeStillDue`). The row is already loaded, so the check costs nothing.
 */
export async function probeAsset(
  assetId: string,
  out?: { snapshot?: AssetMonitorSnapshot; dueIntervalSec?: number; timeoutMs?: number },
): Promise<ProbeResult> {
  const start = performance.now();
  try {
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      omit: PROBE_ASSET_OMIT,
      include: {
        monitorCredential: true,
        responseTimeCredential: true,
        discoveredByIntegration: true,
        // Rule 86: the agent-mode branch below judges silence from these.
        managedAgent: {
          select: { installStatus: true, bearerHash: true, bearerRevokedAt: true, bearerIssuedAt: true, lastSeenAt: true },
        },
      },
    });
    if (!asset) return finish(start, false, "Asset not found");
    // Surface the loaded asset to the caller so `recordProbeResult` can
    // skip its own findUnique. The fields in `AssetMonitorSnapshot` are a
    // subset of what this `include` already pulled — no extra DB cost.
    if (out) out.snapshot = asset;
    // A job that queued behind an ACTIVE job for the same asset: that job has
    // already taken this cycle's reading. A slow probe to a dark host
    // (probeTimeoutMs ~ one 5s publisher tick) is how the second job gets queued.
    if (
      out?.dueIntervalSec !== undefined &&
      !probeStillDue(asset.lastMonitorAt, out.dueIntervalSec, new Date(), getPendingProbePatch(assetId)?.lastMonitorAt)
    ) {
      return { success: false, responseTimeMs: 0, duplicate: true };
    }
    if (!asset.monitored) return finish(start, false, "Monitoring disabled");
    const effectiveRTCred = asset.responseTimeCredential ?? asset.monitorCredential;

    // Resolve effective settings (probeTimeoutMs + responseTimePolling) through
    // the four-tier hierarchy. The resolver's source-default fallback always
    // populates responseTimePolling — fortinet → "rest_api", everything else
    // → "icmp" — so dispatch never falls through to the legacy monitorType.
    const effective = await resolveMonitorSettings({
      ...asset,
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    });
    const timeoutMs = effective.probeTimeoutMs;
    // Hand it back the way the asset snapshot is handed back: the caller needs
    // it to record what a MISS cost (business rule 67), and it has already been
    // resolved here through the four-tier hierarchy. Re-resolving it at the
    // record site would be a second answer to one question.
    if (out) out.timeoutMs = timeoutMs;
    const polling   = effective.responseTimePolling;
    if (!polling) return finish(start, false, "No response-time polling method configured");

    // "Disabled" means DO NOT POLL — it is not a transport, and it is not a
    // failure. Without this branch the dispatch below falls all the way through
    // to the unknown-method error, which `recordProbeResult` then writes as a
    // failed sample that counts toward the covering automation's missedPolls —
    // turning the operator's off-switch into a manufactured outage. The
    // `skipped` contract is exactly right here for the same reason it is right
    // for an unreachable vCenter: nothing was measured, so no sample, no counter
    // movement, just the cadence anchor. The queue publishers gate on this too
    // (computeDueWork + jobs/monitorAssets.ts), so in the steady state we never
    // reach here — this stays as the correctness backstop for the
    // operator-triggered /probe-now path and for a "disabled" already sitting in
    // a JSON tier that no publisher gate can see.
    if (polling === "disabled") {
      return { success: false, responseTimeMs: 0, skipped: true };
    }

    // Agent owns its own probe cadence and pushes samples directly via
    // POST /api/v1/agents/samples. The hot monitor loop must not call out
    // to the host. While the agent is reporting, return a synthetic success
    // so the probeTotal counter increments under transport="agent" but no DB
    // write happens (recordProbeResult below early-returns for agent-mode
    // assets).
    //
    // What the agent cannot push is its own death: a dead host sends nothing,
    // so nothing ever moved its status. Business rule 86 — once an enrolled
    // agent has been silent past its window, THIS is the missed poll, returned
    // as a real failure (`agentSilent`) that recordProbeResult lets through.
    // A fleet-wide silence is Polaris failing to receive, not the hosts dying:
    // skipped (no reading), and it restarts every agent's silence clock.
    if (polling === "agent") {
      const now = new Date();
      const verdict = judgeAgentSilence({
        agent: asset.managedAgent,
        intervalSeconds: effective.intervalSeconds,
        now,
        listeningSince: agentListeningSince,
        fleet: asset.managedAgent ? await agentFleetLiveness() : { freshestLastSeenAt: null, reportingAgents: 0 },
      });
      if (verdict.kind === "fleetDark") {
        restartAgentListening(now);
        return { success: false, responseTimeMs: 0, skipped: true };
      }
      if (verdict.kind === "silent") {
        return {
          success: false,
          responseTimeMs: 0,
          agentSilent: true,
          error: `Polaris Agent has not reported since ${verdict.since.toISOString()}`,
        };
      }
      return finish(start, true);
    }

    const integration  = asset.discoveredByIntegration ?? null;
    const sourceKind   = assetSourceKindFromIntegrationType(integration?.type ?? null);
    const isFortinetSrc = isFortinetIntegrationType(sourceKind);
    const isAdSrc       = sourceKind === "activedirectory";

    // REST-API probes for managed FortiSwitches/FortiAPs query the parent
    // FortiGate's controller-status table, not the asset itself — so they
    // THE TIMER FOR THE DEVICE, taken here rather than at the top of the
    // function. `start` above is stamped before a findUnique with three
    // includes and the whole monitor-settings resolution — measured at ~4ms
    // for the query alone against a local Postgres — so every responseTimeMs
    // Polaris has ever recorded, on EVERY transport, carried a few
    // milliseconds of Polaris's own bookkeeping. The column is called
    // round-trip time and is charted as the device's latency, so that
    // overhead is simply wrong. `start` stays for the validation failures
    // below, where the number means nothing anyway.
    const dispatchStart = performance.now();

    // don't need an asset IP and dispatch before the IP guard below.
    if (
      polling === "rest_api" &&
      isFortinetSrc &&
      integration &&
      (asset.assetType === "switch" || asset.assetType === "access_point")
    ) {
      return await probeFortinetController(asset, integration as any, dispatchStart, timeoutMs);
    }

    // Asks FortiManager's own device database instead of the device. Needs no
    // asset IP (FMG is the target), so it dispatches before the IP guard —
    // which also means it reaches a gate Polaris has no route to.
    if (polling === "fortimanager") {
      if (!integration) {
        return finish(start, false, "FortiManager polling requires a FortiManager integration");
      }
      return await probeFortimanagerNative(asset, integration as any, dispatchStart);
    }

    // vCenter probes ask the vCenter SERVER about the asset, so they need no
    // asset IP at all — a VM whose guest exposes no address to Polaris, and an
    // ESXi host added to vCenter by a name that never resolved, are both still
    // probeable. Dispatches before the IP guard for exactly that reason.
    if (polling === "vcenter") {
      return await probeVcenter(assetId, dispatchStart);
    }
    // Unraid / TrueNAS: the same posture — the host's API answers for the
    // asset, so no asset IP is needed (services/workloadMonitorService.ts).
    if (isWorkloadPollingMethod(polling)) {
      return await probeWorkload(assetId, dispatchStart);
    }
    // Generic API: the integration's own response-time query answers for the
    // asset (rule 100(i)) — no asset IP needed, the workload posture.
    if (polling === "genericapi") {
      return await probeGenericApi(assetId);
    }

    // AD-discovered Windows hosts often have no IP yet (only dnsName/hostname),
    // and WinRM/SSH resolve FQDNs fine — fall back so the probe can still run
    // when the polling method is one that doesn't need an IPv4 literal. "http"
    // is in that set for a reason beyond DNS resolution: a TLS check against a
    // name is the check an operator means (the cert and any vhost routing are
    // keyed on the hostname), so a name is not merely tolerated here, it is
    // preferable when the asset has one and no IP.
    const adFallback = asset.dnsName || asset.hostname;
    const targetIp =
      dial(asset) ||
      ((polling === "winrm" || polling === "ssh") ? adFallback : null);
    if (!targetIp) return finish(start, false, "Asset has no IP address");

    if (polling === "icmp") {
      return await probeIcmp(targetIp, dispatchStart, timeoutMs);
    }
    // NOTE: there is no `polling === "http"` branch. The HTTP check was retired
    // as a polling method (2026-08) and is now a manufacturer custom widget —
    // `probeHttp` below is still the engine, but the widget collector calls it,
    // not this dispatch, and its result lands in AssetStateSample rather than
    // moving monitorStatus. See utils/pollingCompatibility.ts.
    if (polling === "rest_api") {
      // Fortinet-discovered firewalls reuse the integration's stored API token.
      // (Managed FortiSwitches/FortiAPs are dispatched earlier, above, since
      // they query the parent FortiGate rather than the asset's own IP.)
      // Manual REST API targets pull from a stored "restapi"-typed credential.
      if (isFortinetSrc && integration) {
        const result = await probeFortinet(targetIp, integration as any, dispatchStart, timeoutMs, effectiveRTCred);
        // Proxy mode only: after a successful FortiGate probe, pre-warm the
        // switch + AP controller-inventory cache so children that fire within
        // the 30 s TTL window get a free cache hit instead of a separate FMG
        // proxy call. Fire-and-forget — don't add to the FortiGate's RTT.
        // Direct mode keeps children independent (no proxy bottleneck, and
        // per-device parallelism is up to 20).
        // The running firmware rode the probe: keep Asset.osVersion current
        // between discoveries (fortinetLiveVersionService). Best-effort — an
        // identity write must never turn a successful probe into a failure.
        if (result.success && result.firmwareVersion && asset.assetType === "firewall") {
          try {
            await reconcileFortinetLiveVersions([{
              assetId: asset.id,
              hostname: asset.hostname,
              currentOsVersion: asset.osVersion,
              liveVersion: fortigateLiveVersionFor(integration.type, result.firmwareVersion),
              reader: "fortios-probe",
            }]);
          } catch (err: any) {
            logger.debug({ assetId: asset.id, err: err?.message }, "fortinet live version reconcile failed");
          }
        }
        if (
          result.success &&
          integration.type === "fortimanager" &&
          (integration.config as Record<string, unknown>).useProxy !== false &&
          asset.hostname
        ) {
          void fetchFortinetControllerInventory(integration as any, asset.hostname, "switches", timeoutMs).catch(() => {});
          void fetchFortinetControllerInventory(integration as any, asset.hostname, "aps",     timeoutMs).catch(() => {});
        }
        return result;
      }
      if (effectiveRTCred?.type === "restapi") {
        return await probeRestApiCredential(effectiveRTCred.config as Record<string, unknown>, dispatchStart, timeoutMs);
      }
      return finish(start, false, "REST API polling requires either a Fortinet integration or a REST API credential");
    }
    if (polling === "snmp") {
      // Per-stream asset credential wins, then asset default, then class-
      // override credential, then integration fallback (shared chain in
      // resolveSnmpConfigForStream). A Fortinet-lookup throw becomes a
      // probe failure with the lookup's message, as before.
      let probeCfg: Record<string, unknown>;
      try {
        const resolved = await resolveSnmpConfigForStream(effectiveRTCred, effective.responseTimeCredentialId, isFortinetSrc, integration);
        if (resolved.error !== undefined) return finish(start, false, resolved.error);
        probeCfg = resolved.cfg;
      } catch (err: any) {
        return finish(start, false, err?.message || "SNMP credential lookup failed");
      }
      const snmpRes = await probeSnmp(
        targetIp, probeCfg, dispatchStart, timeoutMs, descrReadDue(asset.lastDescrAt),
      );
      // The identity read rode this probe. Reconcile it here — the probe path
      // is the only reader that reaches an SNMP asset with no heavy stream
      // enabled, which is exactly the camera case: response time on SNMP and
      // nothing else. Best-effort by construction: an identity write must
      // never turn a successful probe into a failed one, and the anchor is
      // stamped by recordProbeResult off `result.sysDescr` regardless, so a
      // device whose blob we cannot parse is not re-read every tick.
      if (snmpRes.sysDescr) {
        const detail = parseVendorSysDescr(snmpRes.sysDescr);
        if (detail) {
          try {
            await applyDescrIdentity(asset.id, detail, snmpRes.sysDescr, asset);
          } catch (err: any) {
            logger.debug(
              { assetId: asset.id, err: err?.message },
              "sysDescr identity reconcile failed",
            );
          }
        }
      }
      return snmpRes;
    }
    if (polling === "winrm") {
      // Per-stream credential wins, then asset default, then AD bind fallback.
      if (effectiveRTCred?.type === "winrm") {
        return await probeWinRm(targetIp, effectiveRTCred.config as Record<string, unknown>, dispatchStart, timeoutMs);
      }
      if (isAdSrc && integration && adBindFallbackAllowed(asset)) {
        const cfg      = (integration.config as Record<string, unknown>) || {};
        const username = String(cfg.bindDn || "");
        const password = String(cfg.bindPassword || "");
        if (!username || !password) return finish(start, false, "Active Directory bind credentials not configured");
        return await probeWinRm(targetIp, { username, password, useHttps: true, port: 5986 }, dispatchStart, timeoutMs);
      }
      return finish(start, false, "No WinRM credential selected");
    }
    if (polling === "ssh") {
      // Per-stream credential wins, then asset default, then AD bind fallback.
      if (effectiveRTCred?.type === "ssh") {
        return await probeSsh(targetIp, effectiveRTCred.config as Record<string, unknown>, dispatchStart, timeoutMs);
      }
      if (isAdSrc && integration && adBindFallbackAllowed(asset)) {
        const cfg      = (integration.config as Record<string, unknown>) || {};
        const username = String(cfg.bindDn || "");
        const password = String(cfg.bindPassword || "");
        if (!username || !password) return finish(start, false, "Active Directory bind credentials not configured");
        return await probeSsh(targetIp, { username, password, port: 22 }, dispatchStart, timeoutMs);
      }
      return finish(start, false, "No SSH credential selected");
    }
    // RETIRED METHOD SAFETY NET. "http" was a polling method until 2026-08 and
    // is now a manufacturer custom widget. A stored value can still arrive here
    // because `assertPollingCompatible` validates WRITES only — nothing
    // re-checks what is already in the DB, and the value can sit in a JSON tier
    // (manualMonitorSettings, Integration.config per-class blocks) that no
    // migration realistically reaches. Falling through to the unknown-method
    // failure below would fail every probe on those assets, i.e. silently
    // false-down them fleet-wide. ICMP is the honest substitute: it is the
    // universal response-time fallback and gives up/down without content, which
    // is the closest thing to what the operator had configured.
    // The cast is load-bearing: `PollingMethod` no longer includes "http", so
    // the compiler is certain this branch is dead. It is not — the value comes
    // from the DATABASE, which the type system has no say over. This is exactly
    // the case where a narrowed union describes intent rather than reality.
    if ((polling as string) === "http") {
      logger.warn(
        { assetId: asset.id, hostname: asset.hostname },
        'Asset still configured for the retired "http" polling method — probing over ICMP instead. ' +
        "Re-point the Response Time stream; the HTTP check now lives on a manufacturer custom widget.",
      );
      return await probeIcmp(targetIp, dispatchStart, timeoutMs);
    }
    return finish(start, false, `Unknown polling method "${polling}"`);
  } catch (err: any) {
    return finish(start, false, err?.message || "Unknown probe error");
  }
}

// ─── Probe implementations ──────────────────────────────────────────────────

async function probeFortinet(
  host: string,
  integration: { type: string; config: Record<string, unknown> },
  start: number,
  timeoutMs: number,
  credential?: CredentialLike | null,
): Promise<ProbeResult> {
  // SNMP routing is handled by the dispatcher in probeAsset via the
  // resolved responseTimePolling field. By the time we get here the polling
  // method already resolved to "rest_api" — only Fortinet-discovered
  // firewalls hit this function.

  // Same credential/verifySsl assembly the FortiOS collectors use.
  const fgConfig = buildFortinetConfig(host, integration, credential);
  if ("error" in fgConfig) return finish(start, false, fgConfig.error);

  try {
    // /api/v2/monitor/system/status doubles as our liveness check; capture
    // the body so we can read device uptime for free instead of discarding it.
    // `envelope: true` because the running firmware (`version`) is an envelope
    // field; the uptime reader already accepts both the envelope and `results`.
    const res = await fgRequest<any>(fgConfig, "GET", "/api/v2/monitor/system/status", { timeoutMs, envelope: true });
    const ok = finish(start, true);
    const up = fortinetUptimeSecondsFromStatus(res);
    if (up !== null) ok.uptimeSec = up;
    const version = readSystemStatus(res).version;
    if (version) ok.firmwareVersion = version;
    return ok;
  } catch (err: any) {
    // Inside a 401 pause the request was never sent: not a reading, not a miss (rule 96).
    if (err instanceof FortiosAuthPausedError) return { success: false, responseTimeMs: 0, skipped: true, error: err.message };
    return finish(start, false, err?.message || "FortiOS request failed");
  }
}

/**
 * Pull device uptime (seconds) from a FortiOS /api/v2/monitor/system/status
 * response. FortiOS surfaces uptime under a few shapes across versions; we
 * probe the known candidates and treat any plain number as seconds.
 *
 * VERIFY on a real FortiOS 7.x device — confirm which field is populated and
 * its unit (compare against `get system performance status`). If system/status
 * doesn't carry uptime on the deployed version, move this capture into
 * collectTelemetryFortinet (which already calls resource/usage) instead.
 */
function fortinetUptimeSecondsFromStatus(res: any): number | null {
  if (res == null || typeof res !== "object") return null;
  const candidates = [res.uptime, res.results?.uptime, res.results?.system_uptime, res.system_uptime];
  for (const c of candidates) {
    const n = typeof c === "number" ? c : Number(c);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}

async function probeFortinetController(
  asset: {
    id: string;
    assetType: string;
    serialNumber: string | null;
    fortinetTopology: unknown;
  },
  integration: { id: string; type: string; config: Record<string, unknown> },
  start: number,
  timeoutMs: number,
): Promise<ProbeResult> {
  const serial = (asset.serialNumber || "").trim();
  if (!serial) {
    return finish(start, false, "Cannot probe via REST API — asset has no serial number recorded");
  }

  const topology = (asset.fortinetTopology ?? {}) as Record<string, unknown>;
  let deviceName = typeof topology.controllerFortigate === "string" ? topology.controllerFortigate.trim() : "";
  // For standalone FortiGate integrations, the FortiGate IS the controller —
  // the integration's own host is the right target regardless of what's
  // recorded on the asset's topology blob.
  if (!deviceName && integration.type === "fortigate") {
    const cfg = integration.config as Record<string, unknown>;
    deviceName = String(cfg.host || "");
  }
  if (!deviceName) {
    return finish(start, false, "Cannot probe via REST API — asset has no controller FortiGate recorded");
  }

  const kind: "switches" | "aps" = asset.assetType === "access_point" ? "aps" : "switches";

  try {
    // Report the upstream controller call's duration as the asset's RTT —
    // not the locally-measured elapsed time from `start`. The cache + in-
    // flight coalescing means the worker servicing this asset may have done
    // either a fresh upstream call (~hundreds of ms over FMG/FortiOS REST),
    // a wait on a peer worker's in-flight call (same), or a pure cache hit
    // (sub-ms). Showing the local elapsed time produced jarringly different
    // RTTs across switches/APs sharing one parent FortiGate (e.g. 650 ms
    // for the lead worker, 2 ms for its peers). Surfacing the real upstream
    // duration on every consumer keeps RTT consistent across the fleet and
    // accurately reflects what FortiOS took to answer.
    const { inventory, fetchDurationMs } = await fetchFortinetControllerInventory(
      integration,
      deviceName,
      kind,
      timeoutMs,
    );
    const entry = inventory.get(serial.toUpperCase());
    if (!entry) {
      const label = kind === "switches" ? "managed-switch" : "managed-AP";
      return { success: false, responseTimeMs: fetchDurationMs, error: `Not present in ${deviceName}'s ${label} table` };
    }
    if (entry.connected) {
      return { success: true, responseTimeMs: fetchDurationMs };
    }
    const role = kind === "switches" ? "switch" : "AP";
    return {
      success: false,
      responseTimeMs: fetchDurationMs,
      error: `Controller reports ${role} status: ${entry.status || "Disconnected"}`,
    };
  } catch (err: any) {
    // The controller gate is inside a 401 pause, so nobody asked it. Counting
    // that as a miss would mark every switch / AP behind it down at once (rule 96).
    if (err instanceof FortiosAuthPausedError) return { success: false, responseTimeMs: 0, skipped: true, error: err.message };
    // Precondition failures and upstream errors don't have a meaningful
    // upstream duration; fall back to local elapsed time so the operator
    // still sees how long the failure took.
    return finish(start, false, err?.message || "Controller query failed");
  }
}

/**
 * ONE ICMP echo, reporting the round trip `ping` ITSELF measured rather than
 * the wall clock around the call.
 *
 * Wall clock here is dominated by process spawn, not by the network: 20
 * sequential single-echo pings at 127.0.0.1 measured 36ms each on Windows
 * against a reported RTT of <1ms. A LAN device with a 0.2ms round trip cannot
 * chart as 0.2ms if the number includes a fork+exec.
 *
 * The codebase already knew this in one place and drew the opposite
 * conclusion: the loss sampler wrote responseTimeMs NULL because "we spawn
 * the system ping, so the measured time is dominated by process spawn and is
 * not an RTT worth recording". True of the wall clock; not true of the figure
 * ping prints, which is the actual round trip. So we parse it out instead of
 * discarding it.
 *
 * Falls back to the wall clock when the summary carried no timing — a total
 * loss has no RTT, and a failed probe's duration is at least a real bound.
 */
async function probeIcmp(host: string, start: number, timeoutMs: number): Promise<ProbeResult> {
  const r = await burstPingHost(host, { count: 1, intervalMs: 200, timeoutMs });
  // sent === 0 means we never reached the network (no ping binary): not a
  // measurement, and not the device's fault.
  if (r.sent === 0) return finish(start, false, "ping unavailable");
  const success = r.received > 0;
  if (success && r.avgRttMs != null) {
    return { success: true, responseTimeMs: Math.max(0, Math.round(r.avgRttMs)) };
  }
  return finish(start, success, success ? undefined : "no echo reply");
}

async function probeSnmp(
  host: string,
  config: Record<string, unknown>,
  start: number,
  timeoutMs: number,
  wantDescr = false,
): Promise<ProbeResult> {
  const port = toNonNegativeInt(config.port, 161);
  return withSnmpGate(host, port, () => new Promise<ProbeResult>((resolve) => {
    // Reset start INSIDE the gate so reported responseTimeMs reflects only
    // the device round-trip, not the FIFO wait behind a concurrent heavy
    // walk on the same (host, port). The caller's `start` is discarded.
    start = performance.now();
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { (session as any)?.close?.(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SNMP timed out")), timeoutMs);

    let session: any;
    try {
      // Same v2c/v3 session construction the collectors use — one builder.
      session = buildSnmpSession(host, config, timeoutMs);

      session.on("error", (err: Error) => finishOnce(finish(start, false, err?.message || "SNMP error")));
      // sysDescr rides along only when the identity read is due. Two OIDs in
      // ONE GET: no extra round trip, no second session, nothing new queued.
      const oids = wantDescr ? [sysUpTimeOid, SYS_OIDS.sysDescr] : [sysUpTimeOid];
      session.get(oids, (err: Error | null, varbinds: any[]) => {
        clearTimeout(timer);
        if (err) return finishOnce(finish(start, false, err.message || "SNMP get failed"));
        if (!varbinds || varbinds.length === 0) {
          return finishOnce(finish(start, false, "SNMP returned no varbinds"));
        }
        // Keyed by OID, never by position. Agents are free to answer in any
        // order, and once this GET can carry two OIDs, reading varbinds[0]
        // would eventually file a sysDescr STRING as the device's uptime.
        const byOid = new Map<string, any>();
        for (const v of varbinds) if (v?.oid) byOid.set(String(v.oid), v);
        const upVb = byOid.get(sysUpTimeOid) ?? varbinds[0];
        if (snmp.isVarbindError(upVb)) {
          return finishOnce(finish(start, false, snmp.varbindError(upVb)));
        }
        // sysUpTime is TimeTicks (hundredths of a second since boot) — capture
        // it for free (the probe already fetched it for the liveness check);
        // drives reboot detection. snmpTicksToSeconds ignores non-finite/neg.
        const ok = finish(start, true);
        const up = snmpTicksToSeconds(upVb?.value);
        if (up !== null) ok.uptimeSec = up;
        // The identity half is strictly best-effort: an error varbind here is
        // an agent that does not publish sysDescr, not a probe failure.
        if (wantDescr) {
          const dVb = byOid.get(SYS_OIDS.sysDescr);
          if (dVb && !snmp.isVarbindError(dVb)) {
            const text = snmpVbToString(dVb.value);
            if (text) ok.sysDescr = text;
          }
        }
        finishOnce(ok);
      });
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SNMP setup failed"));
    }
  }));
}

async function probeWinRm(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const useHttps = config.useHttps !== false;
  const port = toNonNegativeInt(config.port, useHttps ? 5986 : 5985);
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) return finish(start, false, "WinRM credential incomplete");

  // Minimal WS-Management Identify request — exercises authentication
  // without needing a configured shell/runspace.
  const body =
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ` +
    `xmlns:wsmid="http://schemas.dmtf.org/wbem/wsman/identity/1/wsmanidentity.xsd">` +
    `<s:Header/><s:Body><wsmid:Identify/></s:Body></s:Envelope>`;

  const url = new URL(`${useHttps ? "https" : "http"}://${urlHost(host)}:${port}/wsman`); // IPv6 bracketed (rule 128)
  const auth = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");

  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const reqFn = useHttps ? httpsRequest : httpRequest;
    const req = reqFn({
      hostname: bareHost(url.hostname),
      port: Number(url.port),
      path: url.pathname,
      method: "POST",
      headers: {
        "Authorization":  auth,
        "Content-Type":   "application/soap+xml;charset=UTF-8",
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      // WinRM Basic-auth sends credentials on the wire. verifyTls: true checks
      // the CA chain; otherwise the certificate is pinned on first use and
      // checked before the Authorization header is written (business rule 113).
      rejectUnauthorized: config.verifyTls === true,
      ...(useHttps && config.verifyTls !== true ? { agent: pinnedAgentFor(bareHost(url.hostname), Number(url.port)) } : {}),
      timeout: timeoutMs,
    } as any, (res) => {
      // Drain the body so the socket can close cleanly.
      res.on("data", () => {});
      res.on("end", () => {
        if (res.statusCode === 200) return finishOnce(finish(start, true));
        if (res.statusCode === 401) return finishOnce(finish(start, false, "WinRM authentication failed"));
        finishOnce(finish(start, false, `WinRM HTTP ${res.statusCode}`));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch {}; finishOnce(finish(start, false, "WinRM timed out")); });
    req.on("error", (err) => finishOnce(finish(start, false, err.message || "WinRM error")));
    req.write(body);
    req.end();
  });
}

async function probeSsh(host: string, config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const port = toNonNegativeInt(config.port, 22);
  const username = String(config.username || "");
  const password = typeof config.password === "string" ? config.password : "";
  const privateKey = typeof config.privateKey === "string" ? config.privateKey : "";
  const passphrase = typeof config.passphrase === "string" ? config.passphrase : "";
  if (!username || (!password && !privateKey)) return finish(start, false, "SSH credential incomplete");

  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const client = new SshClient();
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      try { client.end(); } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finishOnce(finish(start, false, "SSH timed out")), timeoutMs);

    client.on("ready", () => {
      clearTimeout(timer);
      finishOnce(finish(start, true));
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      finishOnce(finish(start, false, err.message || "SSH error"));
    });

    try {
      const opts: any = {
        host,
        port,
        username,
        readyTimeout: timeoutMs,
      };
      if (privateKey) {
        opts.privateKey = privateKey;
        // Required for an encrypted key — see remoteExec.withSshClient.
        if (passphrase) opts.passphrase = passphrase;
      } else {
        opts.password = password;
      }
      // Same server authentication as remoteExec.withSshClient — these are the
      // only two ssh2.connect sites and they must not drift apart on whether
      // the host key is checked. On unless verifyHostKey is false (rule 113).
      const verifier = buildHostVerifier(host, port, config);
      if (verifier) opts.hostVerifier = verifier;
      client.connect(opts);
    } catch (err: any) {
      clearTimeout(timer);
      finishOnce(finish(start, false, err?.message || "SSH connect failed"));
    }
  });
}

/**
 * REST API credential test — issues an HTTPS GET to the credential's
 * baseUrl with `Authorization: Bearer <apiToken>` and treats 200/204/401
 * as a successful auth round-trip (401 means the URL is reachable but
 * the token's wrong; we surface that explicitly so operators know the
 * connection isn't the problem). Other status codes get bubbled up as
 * the error message.
 *
 * Doesn't take a `host` argument — the URL is in the credential, not the
 * asset. The probe runs against config.baseUrl directly.
 */
async function probeRestApiCredential(config: Record<string, unknown>, start: number, timeoutMs: number): Promise<ProbeResult> {
  const baseUrl = String(config.baseUrl || "");
  const apiToken = String(config.apiToken || "");
  const verifyTls = config.verifyTls === true;
  if (!baseUrl) return finish(start, false, "REST API credential is missing baseUrl");
  if (!apiToken) return finish(start, false, "REST API credential is missing apiToken");
  let url: URL;
  try { url = new URL(baseUrl); }
  catch { return finish(start, false, "REST API baseUrl is not a valid URL"); }
  const isHttps = url.protocol === "https:";
  const reqFn = isHttps ? httpsRequest : httpRequest;
  const restPort = url.port ? Number(url.port) : (isHttps ? 443 : 80);
  return await new Promise<ProbeResult>((resolve) => {
    let resolved = false;
    const finishOnce = (r: ProbeResult) => {
      if (resolved) return;
      resolved = true;
      resolve(r);
    };
    const req = reqFn({
      hostname: bareHost(url.hostname),
      port:     restPort,
      path:     url.pathname + (url.search || ""),
      method:   "GET",
      headers:  { "Authorization": "Bearer " + apiToken, "Accept": "application/json,*/*" },
      rejectUnauthorized: !!verifyTls,
      // Rule 113(e), re-scan F6: without a CA check the bearer goes only to
      // the certificate pinned for this host:port.
      ...(isHttps && !verifyTls ? { agent: pinnedAgentFor(bareHost(url.hostname), restPort) } : {}),
      timeout:  timeoutMs,
    } as any, (res) => {
      // Drain so the socket releases.
      res.on("data", () => {});
      res.on("end", () => {
        const code = res.statusCode || 0;
        if (code === 200 || code === 204) return finishOnce(finish(start, true));
        if (code === 401 || code === 403) return finishOnce(finish(start, false, "REST API authentication failed (HTTP " + code + ")"));
        if (code === 0)                   return finishOnce(finish(start, false, "REST API request returned no status"));
        finishOnce(finish(start, false, "REST API HTTP " + code));
      });
    });
    req.on("timeout", () => { try { req.destroy(); } catch {}; finishOnce(finish(start, false, "REST API timed out")); });
    req.on("error",   (err) => finishOnce(finish(start, false, err.message || "REST API error")));
    req.end();
  });
}

/**
 * HTTP-check probe — one GET against the asset's own IP, up/down decided by the
 * status code and optionally by a string the response body must carry. The
 * check definition comes from an `http` Credential; `pathOverride` is the
 * asset's `httpCheckPath`. All the decision logic is the pure
 * `evaluateHttpCheck` (utils/httpCheck.ts) — this function owns only the socket.
 *
 * Three transport decisions worth stating, because each is the difference
 * between a check that means something and one that reads healthy while the
 * device is broken:
 *
 *  - `netGuard` is deliberately NOT applied. Every other outbound-HTTP path in
 *    Polaris (automation api_call actions, webhooks) SSRF-checks its target
 *    because the URL is attacker-influenced config pointed at arbitrary hosts.
 *    Here the target is the monitored asset's own address, which is private by
 *    definition — the same address SNMP, SSH and WinRM probes already dial —
 *    so a guard that rejects RFC1918 would reject the entire feature.
 *
 *  - Redirects are not followed (see the httpCheck.ts header): a 302 to a login
 *    page is how an HTTP health check lies about a device being up.
 *
 *  - The body is capped at MAX_BODY_BYTES and the request is torn down once the
 *    cap is reached. Without the teardown a device streaming at the check path
 *    would hold a monitor worker for the whole probe timeout, once per interval.
 */
/** One completed HTTP exchange, before any check semantics are applied. */
interface RawHttpExchange {
  statusCode: number;
  wwwAuthenticate: string | null;
  contentType: string | null;
  body: string;
  truncated: boolean;
}

export async function probeHttp(
  host: string,
  config: Record<string, unknown>,
  start: number,
  timeoutMs: number,
  pathOverride?: string | null,
  out?: { diag?: HttpProbeDiagnostics },
  // The AUTH half, from an `http` Credential. Separate from `config` (the check
  // definition) since 2026-08: the check lives on a manufacturer widget and the
  // login on a credential, so one login can serve many checks and vice versa.
  // Absent = unauthenticated, which is a widget with no credential selected.
  auth?: Record<string, unknown> | null,
  // Rule 110, re-scan F58: the credential test passes netGuard's
  // guardedLookup so the typed host is judged by what it resolves to WHEN
  // the socket connects, not by an earlier separate lookup.
  lookup?: import("node:net").LookupFunction,
): Promise<ProbeResult> {
  const cfg = config as HttpCheckConfig;
  const authCfg = (auth || {}) as HttpAuthConfig;
  const target = resolveHttpTarget(cfg, pathOverride);
  const reqFn = target.useHttps ? httpsRequest : httpRequest;
  const authMode = resolveHttpAuthMode(authCfg);
  // Rule 113(e), re-scan F7: a check that sends a password or token over TLS
  // without a CA check sends it only to the pinned certificate. An
  // unauthenticated check sends nothing secret and is left alone.
  const pinned = target.useHttps && cfg.verifyTls !== true && authMode !== "none";

  /**
   * Issue exactly one GET and resolve with the exchange, or with an error
   * string when the transport never produced a response. Factored out of the
   * probe body because Digest needs the same request issued twice — once to
   * collect the challenge, once carrying the answer.
   */
  const issueOnce = (
    extraAuth: string | null,
    perRequestTimeoutMs: number,
  ): Promise<{ exchange?: RawHttpExchange; error?: string }> => {
    const headers: Record<string, string> = { "Accept": "*/*" };
    if (extraAuth) headers["Authorization"] = extraAuth;
    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: { exchange?: RawHttpExchange; error?: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      const req = reqFn({
        hostname: host,
        port:     target.port,
        path:     target.path,
        method:   "GET",
        headers,
        rejectUnauthorized: cfg.verifyTls === true,
        ...(pinned ? { agent: pinnedAgentFor(host, target.port) } : {}),
        ...(lookup ? { lookup } : {}),
        timeout:  perRequestTimeoutMs,
      } as any, (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        const done = () => {
          // Node collapses repeated response headers into a single comma-joined
          // string for www-authenticate (set-cookie is the lone exception),
          // which is exactly the shape the challenge parser already handles.
          const wa = res.headers?.["www-authenticate"] as string | string[] | undefined;
          const ctype = res.headers?.["content-type"];
          settle({
            exchange: {
              statusCode:      res.statusCode || 0,
              wwwAuthenticate: Array.isArray(wa) ? wa.join(", ") : typeof wa === "string" ? wa : null,
              contentType:     typeof ctype === "string" ? ctype : null,
              body:            Buffer.concat(chunks).toString("utf8"),
              truncated,
            },
          });
        };
        res.on("data", (chunk: Buffer) => {
          if (truncated) return;
          size += chunk.length;
          if (size >= MAX_BODY_BYTES) {
            // Keep the slice that fits so a match sitting just under the cap is
            // still found, then stop: `done` runs now rather than on "end",
            // because destroying the response means "end" may never arrive.
            truncated = true;
            chunks.push(chunk.subarray(0, Math.max(0, MAX_BODY_BYTES - (size - chunk.length))));
            try { res.destroy(); } catch {}
            try { req.destroy(); } catch {}
            done();
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", done);
        // A connection reset mid-body is a failed check, not a partial success.
        res.on("error", (err: any) => settle({ error: err?.message || "HTTP response error" }));
      });
      req.on("timeout", () => { try { req.destroy(); } catch {}; settle({ error: "HTTP check timed out" }); });
      req.on("error",   (err) => settle({ error: err.message || "HTTP check error" }));
      req.end();
    });
  };

  // Bearer and Basic are computable up front. Digest is not — its response hash
  // is keyed on a server-issued nonce, so the first request goes out bare and
  // the challenge comes back on the 401. "form" (a device admin login held for
  // the firmware repository, business rule 87) deliberately falls through to
  // NO header: it is not an HTTP auth scheme, the widget writer refuses it at
  // save time, and guessing Basic would post the device's admin password to
  // whatever answered.
  let preAuth: string | null = null;
  if (authMode === "bearer" && typeof authCfg.apiToken === "string" && authCfg.apiToken) {
    preAuth = "Bearer " + authCfg.apiToken;
  } else if (authMode === "basic" &&
             typeof authCfg.username === "string" && authCfg.username &&
             typeof authCfg.password === "string" && authCfg.password) {
    preAuth = "Basic " + Buffer.from(`${authCfg.username}:${authCfg.password}`).toString("base64");
  }

  const first = await issueOnce(preAuth, timeoutMs);
  if (first.error || !first.exchange) return finish(start, false, first.error || "HTTP check failed");

  let exchange = first.exchange;
  let digestNegotiated = false;
  let authNote: string | null = null;

  // ── Digest handshake ──────────────────────────────────────────────────────
  // Re-fire exactly ONCE. A server that rejects a correctly-computed response
  // will reject it again, so retrying past this turns a wrong password into a
  // request amplifier against the device.
  if (authMode === "digest" && exchange.statusCode === 401) {
    const challenge = parseDigestChallenge(exchange.wwwAuthenticate);
    if (!challenge) {
      // Named rather than left as a bare 401: a device that answers with Basic
      // only, or with a malformed challenge, is a configuration finding.
      const offered = authSchemesOffered(exchange.wwwAuthenticate);
      authNote = offered.length
        ? `Device requested ${offered.join("/")} auth, not Digest`
        : "Device returned 401 with no Digest challenge";
    } else {
      try {
        const auth = buildDigestAuthorization({
          challenge,
          username: String(authCfg.username || ""),
          password: String(authCfg.password || ""),
          method:   "GET",
          // The request-URI must be byte-identical to the request line, or the
          // HA2 hash is computed over something the server never saw.
          uri:      target.path,
          cnonce:   newCnonce(),
          nc:       1,
        });
        // Keep the whole exchange inside the caller's timeout budget rather
        // than granting a fresh one — two full timeouts would let a slow device
        // hold a monitor worker for twice the configured probe window.
        const remaining = Math.max(1000, Math.round(timeoutMs - (performance.now() - start)));
        const second = await issueOnce(auth, remaining);
        if (second.error || !second.exchange) {
          return finish(start, false, second.error || "HTTP check failed");
        }
        exchange = second.exchange;
        digestNegotiated = true;
      } catch (err: any) {
        // Thrown by buildDigestAuthorization for a qop/algorithm it refuses to
        // guess at. Surfacing the reason beats a second opaque 401.
        authNote = err?.message || "Digest authentication failed";
      }
    }
  }

  const outcome = evaluateHttpCheck({
    statusCode: exchange.statusCode,
    body:       exchange.body,
    config:     cfg,
    truncated:  exchange.truncated,
  });

  // Diagnostics only when a caller asked for them (the operator-driven Test
  // Connection path). The monitor hot path passes no out-param, so it never
  // builds an excerpt or a URL string.
  if (out) {
    const ex = bodyExcerpt(exchange.body);
    const offered = authSchemesOffered(exchange.wwwAuthenticate ?? first.exchange.wwwAuthenticate);
    out.diag = {
      url:                describeHttpTarget(host, target),
      statusCode:         exchange.statusCode,
      contentType:        exchange.contentType,
      bytesRead:          Buffer.byteLength(exchange.body),
      bodyTruncatedAtCap: exchange.truncated,
      excerpt:            ex.text,
      excerptTruncated:   ex.truncated,
      matched:            outcome.matched,
      authRequested:      offered.length ? offered : null,
      digestNegotiated,
    };
  }

  // An outcome can in principle carry error text alongside ok:true; ProbeResult
  // has no slot for "succeeded, but note this", so such a note is dropped here
  // rather than being smuggled into a success. The Test Connection modal reports
  // the outcome directly and so still shows it.
  if (!outcome.ok) {
    // `authNote` explains WHY the status is 401 when the digest handshake
    // could not be completed; without it the operator sees only the code.
    return finish(start, false, authNote ? `${outcome.error} — ${authNote}` : outcome.error);
  }
  return finish(start, true);
}

/**
 * Run a one-shot probe against `host` with the given credential type + config,
 * without touching the asset row or writing samples. Used by the credential
 * Test Connection flow in Server Settings → Credentials, where the operator
 * picks an asset just to supply the host — the asset's stored monitor
 * settings are intentionally ignored. ICMP needs no credential.
 */
export async function probeCredentialAgainstHost(
  host: string,
  type: "snmp" | "winrm" | "ssh" | "icmp" | "restapi" | "http",
  config: Record<string, unknown>,
  // `http` only: filled with the request line, status, content-type and a body
  // excerpt so the operator can TAILOR the check against what the device
  // actually returns. Nothing else populates it, and the monitor hot path never
  // passes it — see probeHttp.
  out?: { diag?: HttpProbeDiagnostics },
  // `http` only: the check definition to exercise. It no longer lives on the
  // credential (that is auth only), so the Test Connection flow supplies one
  // straight from its form — which is also what lets a check be dialled in
  // against a real device BEFORE it is saved onto a manufacturer widget.
  check?: Record<string, unknown> | null,
  // The operator-typed-host test path (rule 110, re-scan F58): `http` connects
  // through this lookup, so the address is judged when the socket connects.
  lookup?: import("node:net").LookupFunction,
): Promise<ProbeResult> {
  const start = performance.now();
  // restapi uses config.baseUrl directly, so a missing host on the asset
  // isn't a deal-breaker for that type — the credential is tested against
  // the URL stored on the credential, not the asset.
  if (!host && type !== "restapi") return finish(start, false, "Host is required");
  // No asset context, so we use the hardcoded floor's probeTimeoutMs as the
  // default. Operator-driven credential test — they can re-trigger if the
  // host is genuinely slow.
  const timeoutMs = HARDCODED_FLOOR.probeTimeoutMs;
  try {
    if (type === "icmp")    return await probeIcmp(host, start, timeoutMs);
    if (type === "snmp")    return await probeSnmp(host, config, start, timeoutMs);
    if (type === "winrm")   return await probeWinRm(host, config, start, timeoutMs);
    if (type === "ssh")     return await probeSsh(host, config, start, timeoutMs);
    if (type === "restapi") return await probeRestApiCredential(config, start, timeoutMs);
    // `config` is the credential (auth only); the CHECK comes from the caller,
    // because since the split there is nothing on the credential that says
    // which request to make. No pathOverride: the modal tests the check it was
    // handed, and the asset it may have borrowed a host from is just a routable
    // target — honouring that asset's httpCheckPath would test a different path
    // and report the result as if it were this one.
    if (type === "http")    return await probeHttp(host, check || {}, start, timeoutMs, null, out, config, lookup);
    return finish(start, false, `Unsupported credential type "${type}"`);
  } catch (err: any) {
    return finish(start, false, err?.message || "Probe failed");
  }
}
