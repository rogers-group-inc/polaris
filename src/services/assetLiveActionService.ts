/**
 * src/services/assetLiveActionService.ts — the asset details buttons that reach
 * the device or start a run: Poll now (probe-now), Refresh (system info),
 * Discover now (rediscover) and the SNMP Walk tab. Each is gated on the
 * originating integration's device filter before any traffic leaves the box,
 * and each leaves an Event. Moved out of routes/assets/detail.ts (CQ-B062
 * slice 2); the route keeps the Zod body, the gates and the request-bound
 * inputs (the caller's assets:write, the credential-use actor). The three that
 * can answer 409 / 202 return `{ status, body }` for the route to send as is.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { assetDialAddress } from "../utils/assetDialAddress.js";
import { ipv6Dialable } from "./ipv6GateService.js";
import { recordCredentialUse, type CredentialUseActor } from "./credentialUseAuditService.js";
import { logEvent } from "./eventLogService.js";
import { assetMatchesIntegrationFilter } from "../utils/integrationFilter.js";
import { probeAsset, recordProbeResult, collectTelemetry, recordTelemetryResult, collectHardwareSensors, recordHardwareSensorResult, collectSystemInfo, recordSystemInfoResult, runSdwanFor, snmpWalkRaw } from "./monitoringService.js";
import { getCredential } from "./credentialService.js";
import { isWorkloadPlatform, workloadSourceKindsFor } from "../utils/workloadSources.js";
import { triggerDiscovery } from "./discovery/discoveryEngine.js";
import { resolveDiscoveryScopeForAsset } from "./discovery/assetDiscoveryScope.js";
import { isRunActive } from "./discoveryRunState.js";
import { assertCredentialInAssetScope } from "./assetCredentialScopeService.js";

/** What a live action answers when it is not a plain 200. */
export interface LiveActionResult {
  status: number;
  body: unknown;
}

/**
 * Is this asset still inside its originating integration's device filter?
 *
 * Honors deviceInclude/deviceExclude (ouInclude/ouExclude for AD, vmInclude/
 * vmExclude for vCenter). Every operator-initiated pull shares this gate: a
 * refresh must not fetch from a device the next discovery sweep would skip —
 * operators tighten these filters precisely to keep Polaris off certain hosts.
 * Evaluated BEFORE any traffic leaves the box.
 *
 * Returns the loaded asset plus the blocking reason (`null` when in scope);
 * `notFound` distinguishes a missing asset so the caller 404s rather than
 * reporting a filter it never evaluated.
 */
async function resolveIntegrationFilterBlock(id: string): Promise<{
  notFound?: true;
  asset?: {
    hostname: string | null;
    ipAddress: string | null;
    discoveredByIntegration: { id: string; type: string; name: string } | null;
  };
  reason: string | null;
}> {
  const filterAsset = await prisma.asset.findUnique({
    where: { id },
    select: {
      hostname: true,
      ipAddress: true,
      learnedLocation: true,
      assetType: true,
      discoveredByIntegration: { select: { id: true, type: true, config: true, name: true } },
    },
  });
  if (!filterAsset) return { notFound: true, reason: null };
  if (!filterAsset.discoveredByIntegration) return { asset: filterAsset, reason: null };

  // For AD, prefer the source's own observed.ouPath over the merged
  // learnedLocation field (which other integrations can overwrite). The
  // lookup is cheap — one row, indexed by (sourceKind, externalId)'s
  // assetId index — and only runs on AD-discovered assets.
  let adOuPath: string | null = null;
  if (filterAsset.discoveredByIntegration.type === "activedirectory") {
    const adSource = await prisma.assetSource.findFirst({
      where: { assetId: id, sourceKind: "ad" },
      select: { observed: true },
    });
    const obs = (adSource?.observed as Record<string, unknown> | null) || null;
    if (obs && typeof obs.ouPath === "string") adOuPath = obs.ouPath;
  }
  // For vCenter, the vmInclude/vmExclude filters match the vCenter-side
  // VM name, which can differ from the merged hostname (guest hostname
  // wins projection) — same source-preferred pattern as AD's ouPath.
  let vmName: string | null = null;
  if (filterAsset.discoveredByIntegration.type === "vcenter") {
    const vmSource = await prisma.assetSource.findFirst({
      where: { assetId: id, sourceKind: "vcenter-vm" },
      select: { observed: true },
    });
    const obs = (vmSource?.observed as Record<string, unknown> | null) || null;
    if (obs && typeof obs.name === "string") vmName = obs.name;
  } else if (isWorkloadPlatform(filterAsset.discoveredByIntegration.type)) {
    // Unraid / TrueNAS: same idea — the platform's own VM / container name.
    const wlSource = await prisma.assetSource.findFirst({
      where: { assetId: id, sourceKind: { in: workloadSourceKindsFor(filterAsset.discoveredByIntegration.type) } },
      select: { observed: true },
    });
    const obs = (wlSource?.observed as Record<string, unknown> | null) || null;
    if (obs && typeof obs.name === "string") vmName = obs.name;
  }
  const filt = assetMatchesIntegrationFilter({ ...filterAsset, adOuPath, vmName }, filterAsset.discoveredByIntegration);
  return {
    asset: filterAsset,
    reason: filt.included ? null : (filt.reason || "Excluded by integration filter"),
  };
}

/**
 * POST /assets/:id/probe-now ("Poll now"): refused 409 when the asset is
 * outside its integration's device filter; otherwise probe + telemetry +
 * hardware sensors + system info (+ the SD-WAN pass), record each, and write
 * one asset.refresh Event summarising every stream (a skipped probe is n/a, not
 * a failure).
 */
export async function pollAssetNow(id: string, actor: string | undefined): Promise<LiveActionResult> {

  // Out of the originating integration's scope → short-circuit before any
  // probe traffic goes out. See resolveIntegrationFilterBlock.
  const gate = await resolveIntegrationFilterBlock(id);
  if (gate.notFound) throw new AppError(404, "Asset not found");
  if (gate.reason) {
    const reason = gate.reason;
    const filterAsset = gate.asset!;
    const label = filterAsset.hostname || filterAsset.ipAddress || id;
    logEvent({
      action: "asset.refresh",
      resourceType: "asset",
      resourceId: id,
      resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
      actor: actor,
      level: "warning",
      message: `Poll blocked: ${label} — ${reason}`,
      details: {
        integrationId: filterAsset.discoveredByIntegration?.id,
        integrationType: filterAsset.discoveredByIntegration?.type,
        reason,
      },
    });
    return { status: 409, body: {
      success: false,
      responseTimeMs: 0,
      error: reason,
      telemetry:   { supported: true, collected: false, error: reason },
      temperature: { supported: true, collected: false, error: reason },
      systemInfo:  { supported: true, collected: false, error: reason },
    } };
  }

  // Keep flat response-time fields at the root for back-compat with anything
  // that still reads `success` / `responseTimeMs` directly.
  const probe = await probeAsset(id);
  await recordProbeResult(id, probe);

  // Telemetry (CPU/mem) and temperature dispatch independently — different
  // polling methods, credentials, MIBs, timeouts — so run them in parallel.
  // System-info is its own collector but also kicked off concurrently
  // because none of the three depend on each other's results. Each catch
  // returns a properly-typed CollectionResult so the union below has `data`
  // on every branch (TS narrowing was complaining otherwise).
  type TelResult  = Awaited<ReturnType<typeof collectTelemetry>>;
  type HwResult   = Awaited<ReturnType<typeof collectHardwareSensors>>;
  type SysResult  = Awaited<ReturnType<typeof collectSystemInfo>>;
  const tr_p:    Promise<TelResult>  = collectTelemetry(id).catch((err: any): TelResult  => ({ supported: true, error: err?.message || "Telemetry collection failed" }));
  const hwR_p:   Promise<HwResult>   = collectHardwareSensors(id).catch((err: any): HwResult => ({ supported: true, error: err?.message || "Hardware sensor collection failed" }));
  const sr_p:    Promise<SysResult>  = collectSystemInfo(id).catch((err: any): SysResult  => ({ supported: true, error: err?.message || "System info collection failed" }));
  // SD-WAN left the system-info pass for its own cadence (2026-09), so a Poll
  // Now that should still refresh the SD-WAN tab asks for it explicitly. The
  // runner applies its own eligibility (integration pulls SD-WAN, REST gate)
  // and is a silent no-op everywhere else, so it stays out of the summary.
  const sdwan_p = runSdwanFor(id, { transport: "rest_api", assetType: "unknown" }).catch(() => "crash" as const);
  const [tr, hwR, sr] = [await tr_p, await hwR_p, await sr_p];
  await sdwan_p;
  await Promise.all([
    recordTelemetryResult(id, tr),
    recordHardwareSensorResult(id, hwR),
    recordSystemInfoResult(id, sr),
  ]);
  const telemetry   = { supported: tr.supported,    collected: !!tr.data,                                       error: tr.error };
  // Hardware sensors are "collected" when the device actually returned sensor
  // rows. An empty array (sensor-less device) is supported-but-empty —
  // surfaced as n/a rather than failure so the toast doesn't nag on devices
  // that simply don't publish hardware sensors.
  const hwData      = Array.isArray(hwR.data) ? hwR.data : null;
  const hardware    = { supported: hwR.supported, collected: !!hwData && hwData.length > 0,                    error: hwR.error };
  const hwNoData    = !!(hwR.supported && hwData && hwData.length === 0);
  const systemInfo  = { supported: sr.supported,    collected: !!sr.data,                                       error: sr.error };

  // Audit the manual poll. The periodic monitorAssets job only writes
  // events on up/down transitions; this endpoint is operator-initiated, so
  // each click should leave a trace regardless of status change.
  const asset = await prisma.asset.findUnique({
    where: { id },
    select: { hostname: true, ipAddress: true },
  });
  const label = asset?.hostname || asset?.ipAddress || id;
  const ok = probe.success;
  // A SKIPPED probe is not a failed one — nothing was measured. Two sources:
  // the response-time stream is set to Disabled (the operator's own choice),
  // and vCenter itself being unreachable. Rendering either as
  // "failed: unknown" and stamping a warning Event told the operator their
  // device was broken when Polaris had simply not asked.
  const probeSkipped = probe.skipped === true;
  const streamSummary: string[] = [];
  streamSummary.push(
    `probe ${ok
      ? probe.responseTimeMs + " ms"
      : probeSkipped
        ? "n/a" + (probe.error ? ` (${probe.error})` : " (not polled)")
        : "failed: " + (probe.error || "unknown")}`,
  );
  streamSummary.push(`telemetry ${telemetry.collected ? "ok" : (telemetry.supported ? "failed: " + (telemetry.error || "no data") : "n/a")}`);
  streamSummary.push(`hardware ${hardware.collected ? "ok" : (hwNoData ? "n/a (no sensors)" : (hardware.supported ? "failed: " + (hardware.error || "no data") : "n/a"))}`);
  streamSummary.push(`interfaces ${systemInfo.collected ? "ok" : (systemInfo.supported ? "failed: " + (systemInfo.error || "no data") : "n/a")}`);
  const anyFail = (!ok && !probeSkipped) ||
    (telemetry.supported && !telemetry.collected) ||
    (hardware.supported  && !hardware.collected && !hwNoData) ||
    (systemInfo.supported && !systemInfo.collected);
  logEvent({
    action: "asset.refresh",
    resourceType: "asset",
    resourceId: id,
    resourceName: asset?.hostname || asset?.ipAddress || undefined,
    actor: actor,
    level: anyFail ? "warning" : "info",
    message: `Poll: ${label} — ${streamSummary.join("; ")}`,
    details: { probe, telemetry, hardware, systemInfo },
  });

  return { status: 200, body: { ...probe, telemetry, hardware, systemInfo } };
}

/**
 * POST /assets/:id/refresh-system-info — the system-info collector alone (the
 * Wireless / MAC / ARP tabs' Refresh): same filter gate as Poll now, touches no
 * monitor state, logs the outcome, and answers with the row's own freshness stamp.
 */
export async function refreshAssetSystemInfo(id: string, actor: string | undefined): Promise<LiveActionResult> {

  const gate = await resolveIntegrationFilterBlock(id);
  if (gate.notFound) throw new AppError(404, "Asset not found");
  const gateAsset = gate.asset!;
  const label = gateAsset.hostname || gateAsset.ipAddress || id;
  if (gate.reason) {
    logEvent({
      action: "asset.refresh",
      resourceType: "asset",
      resourceId: id,
      resourceName: gateAsset.hostname || gateAsset.ipAddress || undefined,
      actor: actor,
      level: "warning",
      message: `System-info refresh blocked: ${label} — ${gate.reason}`,
      details: {
        integrationId: gateAsset.discoveredByIntegration?.id,
        integrationType: gateAsset.discoveredByIntegration?.type,
        reason: gate.reason,
      },
    });
    return { status: 409, body: { supported: true, collected: false, error: gate.reason } };
  }

  const result = await collectSystemInfo(id).catch((err: any) => ({
    supported: true as const,
    error: err?.message || "System info collection failed",
  }));
  await recordSystemInfoResult(id, result);
  const collected = !!(result as { data?: unknown }).data;

  // Operator-initiated, so it leaves a trace regardless of outcome — the
  // scheduled pass only logs on failure.
  logEvent({
    action: "asset.refresh",
    resourceType: "asset",
    resourceId: id,
    resourceName: gateAsset.hostname || gateAsset.ipAddress || undefined,
    actor: actor,
    level: result.supported && !collected ? "warning" : "info",
    message: `System-info refresh: ${label} — ${
      collected ? "ok" : result.supported ? "failed: " + (result.error || "no data") : "n/a (stream not delivered)"
    }`,
    details: { supported: result.supported, collected, error: result.error },
  });

  // The freshness stamp the tabs render comes from the row, not from this
  // response's timing — re-read it so a successful refresh cannot show an
  // age the collector did not actually achieve.
  const after = await prisma.asset.findUnique({
    where: { id },
    select: { lastSystemInfoAt: true },
  });

  return { status: 200, body: {
    supported: result.supported,
    collected,
    error: result.error ?? null,
    lastSystemInfoAt: after?.lastSystemInfoAt ?? null,
  } };
}

/**
 * POST /assets/:id/rediscover ("Discover now"): resolve which integration runs
 * and how it is scoped (a switch / AP runs through its controller gate), refuse
 * 409 when the device filter excludes it or a run is already active, else
 * queue the scoped run (202) and log asset.rediscover.
 */
export async function rediscoverAsset(id: string, actor: string | undefined): Promise<LiveActionResult> {
  const resolution = await resolveDiscoveryScopeForAsset(id);
  if (!resolution.ok) {
    // A missing asset is the only 404; every other reason is a legitimate
    // "this asset has no re-runnable discovery" → 400 with the reason as the
    // message, so the operator is told why.
    throw new AppError(resolution.notFound ? 404 : 400, resolution.reason);
  }
  const { integration, scope, deviceName, filterAsset, viaController } = resolution.resolved;

  // Honor deviceInclude/deviceExclude, same as probe-now: a discovery must
  // not pull a device the next full sweep would skip. Checked against the
  // hostname (assetMatchesIntegrationFilter's match field) and the resolved
  // FMG device name — the filter patterns can target either. For a
  // switch/AP, filterAsset is already the controller gate.
  const filtHost = assetMatchesIntegrationFilter(filterAsset, integration);
  const filtDevice = deviceName
    ? assetMatchesIntegrationFilter({ ...filterAsset, hostname: deviceName }, integration)
    : filtHost;
  if (!filtHost.included && !filtDevice.included) {
    const reason = filtHost.reason || "Excluded by integration filter";
    logEvent({
      action: "asset.rediscover",
      resourceType: "asset",
      resourceId: id,
      resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
      actor: actor,
      level: "warning",
      message: `Discovery blocked: ${filterAsset.hostname || deviceName} — ${reason}`,
      details: { integrationId: integration.id, integrationType: integration.type, deviceName, reason },
    });
    return { status: 409, body: { error: reason } };
  }

  // Pre-check for a friendly message; triggerDiscovery's coalescing return
  // is the authoritative guard (closes the TOCTOU window).
  if (await isRunActive(integration.id)) {
    return { status: 409, body: { error: `A discovery is already running for "${integration.name}" — try again when it finishes` } };
  }
  // requestActor covers bearer-token callers ("api:<token name>") as well
  // as sessions — the actor string labels the run's start/complete Events.
  const runActor = actor ?? "";
  // `scopeLabel` gives the run row a name an operator recognises: the gate
  // name for FMG, the asset's hostname for a directory device (whose scope
  // identifier is an opaque GUID).
  const started = scope
    ? await triggerDiscovery(integration.id, runActor, { scope, scopeLabel: deviceName })
    : await triggerDiscovery(integration.id, runActor);
  if (!started) {
    return { status: 409, body: { error: `A discovery is already running for "${integration.name}" — try again when it finishes` } };
  }

  const target = deviceName || integration.name;
  logEvent({
    action: "asset.rediscover",
    resourceType: "asset",
    resourceId: id,
    resourceName: filterAsset.hostname || filterAsset.ipAddress || undefined,
    actor: actor,
    message: viaController
      ? `Discovery requested via controller FortiGate "${target}" using "${integration.name}"`
      : `Discovery requested for FortiGate "${filterAsset.hostname || target}" via "${integration.name}"`,
    details: { integrationId: integration.id, integrationType: integration.type, deviceName, viaController },
  });
  return { status: 202, body: {
    message: viaController ? `Discovery started on controller ${target}` : "Discovery started",
    integrationId: integration.id,
    integrationName: integration.name,
    deviceName,
    viaController,
  } };
}

/**
 * POST /assets/:id/snmp-walk — walk `oid` on the asset's dial address with a
 * stored SNMP credential: at read level only one the asset already uses (rule
 * 112(e); `canWriteAssets` lifts that), the use recorded (rule 112), the walk
 * logged either way, a device failure answered 502.
 */
export async function snmpWalkAsset(
  id: string,
  walk: { credentialId: string; oid: string; maxRows: number },
  canWriteAssets: boolean,
  credentialActor: CredentialUseActor,
  actor: string | undefined,
): Promise<Record<string, unknown>> {
  const { credentialId, oid, maxRows } = walk;

  const asset = await prisma.asset.findUnique({
    where: { id },
    select: { id: true, hostname: true, ipAddress: true, ipv6Address: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");
  // IPv4, else (IPv6 on) the primary IPv6 — business rule 128.
  const walkHost = assetDialAddress(asset, ipv6Dialable());
  if (!walkHost) throw new AppError(400, "Asset has no IP address to walk");

  // Rule 112(e): this route is read-level, so only a credential the asset
  // already uses — anything else needs assets:write (re-scan F62).
  await assertCredentialInAssetScope(asset.id, credentialId, canWriteAssets);
  const cred = await getCredential(credentialId, { revealSecrets: true });
  if (cred.type !== "snmp") {
    throw new AppError(400, `Credential "${cred.name}" is type "${cred.type}", expected "snmp"`);
  }
  // Rule 112: the walk sends this credential's community / keys to the asset.
  await recordCredentialUse(credentialActor, "asset.snmp-walk", [
    { credentialId: cred.id, destination: walkHost, assetId: asset.id, assetName: asset.hostname ?? walkHost },
  ]);

  const label = asset.hostname || asset.ipAddress;
  try {
    const result = await snmpWalkRaw(walkHost, cred.config as Record<string, unknown>, oid, maxRows);
    logEvent({
      action: "asset.snmp_walk",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor: actor,
      level: "info",
      message: `SNMP walk: ${label} — ${oid} → ${result.rows.length} row(s)${result.truncated ? " (truncated)" : ""}`,
      details: { oid, credentialName: cred.name, rows: result.rows.length, truncated: result.truncated, durationMs: result.durationMs },
    });
    return { ...result, oid, host: walkHost };
  } catch (err: any) {
    const message = err?.message || "SNMP walk failed";
    logEvent({
      action: "asset.snmp_walk",
      resourceType: "asset",
      resourceId: id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor: actor,
      level: "warning",
      message: `SNMP walk failed: ${label} — ${oid} — ${message}`,
      details: { oid, credentialName: cred.name, error: message },
    });
    throw new AppError(502, message);
  }
}
