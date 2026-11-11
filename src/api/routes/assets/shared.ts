/**
 * src/api/routes/assets/shared.ts — Helpers more than one assets sub-router needs: the associated-IP shape, the monitored-state
 * clamp, credential-assignment guards, the write-time quarantine / integration-token guards,
 * the current-state interval. Split out of routes/assets.ts (CQ-B062).
 */

import { type Request } from "express";
import { prisma } from "../../../db.js";
import { AppError } from "../../../utils/errors.js";
import { hasPermission } from "../../middleware/permissions.js";
import { resolveMonitorSettings } from "../../../services/monitoringService.js";
import { type PollingMethod, credentialTypeForPollingMethod, pollingMethodLabel } from "../../../utils/pollingCompatibility.js";
import { assertIpChangeMayRetargetIntegrationToken as assertIpChangeMayRetargetIntegrationTokenUtil } from "../../../utils/integrationTokenTarget.js";

// ─── associatedIps shape helper ──────────────────────────────────────────────
//
// `Asset.associatedIps` was a JSONB column until the side-table migration; the
// frontend (`public/js/assets.js`) and any external API consumer still expect
// the response to carry an `associatedIps: [...]` JSON array on the asset
// object. Rather than change the wire format, every place that reads asset
// rows + their `associatedIpRows` relation runs the rows through this helper
// to project them back into the original JSON shape.

interface AssociatedIpJson {
  ip: string;
  source: string;
  interfaceName?: string;
  mac?: string;
  /** Interface-scrape rows where the device says: "primary" | "secondary". */
  interfaceRole?: string;
  /** Discovered rows: the gate that reported the binding, and its medium (rule 102). */
  device?: string;
  medium?: string;
  ptrName?: string;
  ptrTtl?: number;
  ptrFetchedAt?: string;
  lastSeen?: string;
  firstSeen?: string;
}

interface AssociatedIpRow {
  ip: string;
  source: string;
  interfaceName: string | null;
  mac: string | null;
  interfaceRole: string | null;
  device: string | null;
  medium: string | null;
  ptrName: string | null;
  ptrTtl: number | null;
  ptrFetchedAt: Date | null;
  lastSeen: Date;
  firstSeen: Date;
}

export function shapeAssociatedIps(rows: AssociatedIpRow[] | null | undefined): AssociatedIpJson[] {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const out: AssociatedIpJson = { ip: r.ip, source: r.source };
    if (r.interfaceName) out.interfaceName = r.interfaceName;
    if (r.mac)           out.mac           = r.mac;
    if (r.interfaceRole) out.interfaceRole = r.interfaceRole;
    if (r.device)       out.device        = r.device;
    if (r.medium)        out.medium        = r.medium;
    if (r.ptrName)       out.ptrName       = r.ptrName;
    if (r.ptrTtl != null) out.ptrTtl       = r.ptrTtl;
    if (r.ptrFetchedAt)   out.ptrFetchedAt = r.ptrFetchedAt.toISOString();
    out.lastSeen  = r.lastSeen.toISOString();
    out.firstSeen = r.firstSeen.toISOString();
    return out;
  });
}

export const ASSOCIATED_IP_SELECT = {
  ip: true, source: true, interfaceName: true, mac: true, interfaceRole: true, device: true, medium: true,
  ptrName: true, ptrTtl: true, ptrFetchedAt: true,
  lastSeen: true, firstSeen: true,
} as const;

/**
 * Apply Asset.monitored side-effects on save. The polling-method resolver is
 * the source of truth for HOW the asset gets probed — we don't re-validate
 * polling/credential consistency at write-time; the dispatcher reports
 * errors clearly when a missing credential surfaces during a probe.
 */
export function clampMonitoredState(data: Record<string, unknown>): void {
  const monitored = data.monitored === undefined ? undefined : Boolean(data.monitored);
  if (monitored === false) {
    data.consecutiveFailures = 0;
  } else if (monitored === true) {
    // Reset probe state so the pill always starts at Recovering on re-enable
    // rather than carrying over stale Down/Missed from the previous session.
    data.monitorStatus = "recovering";
    data.consecutiveFailures = 0;
    data.consecutiveSuccesses = 0;
  }
}

// ─── Credential assignment guards ───────────────────────────────────────────
//
// `monitorCredentialId` and the per-stream slots are plain UUID FKs in the Zod
// schema, so before this guard a well-formed id naming no row reached Postgres
// and came back as a foreign-key violation — which errorHandler.ts has no
// Prisma branch for, so the caller got a bare 500 "Internal server error". That
// is the worst shape of failure for an unattended API client: it reads as a
// Polaris outage rather than a stale id in its config. A wrong TYPE was worse
// still, because it wasn't an error at all — `loadClassOverrideStreamCredential`
// and `resolveSnmpConfigForStream` in monitoringService drop a credential whose
// type doesn't match the transport, so the asset saved clean and then silently
// collected nothing until somebody read the probe output.

/** The asset-level default, which is not stream-bound (see the type note below). */
const ASSET_DEFAULT_CREDENTIAL_FIELD = "monitorCredentialId" as const;

/**
 * Per-stream credential slots PUT /assets/:id exposes, each paired with the
 * polling-method column that decides which credential TYPE it needs. Storage
 * is absent deliberately — it rides the `interfaces` credential (see the
 * CREDENTIAL_STREAMS invariant in polaris-change-impact ->
 * services/auth-identity.md). The three slots with no PUT surface yet
 * (customWidget / processes / eventLog) join this list when they get one.
 */
const STREAM_CREDENTIAL_FIELDS = [
  ["responseTimeCredentialId", "responseTimePolling", "responseTime"],
  ["cpuMemoryCredentialId",    "cpuMemoryPolling",    "cpuMemory"],
  ["temperatureCredentialId",  "temperaturePolling",  "temperature"],
  ["interfacesCredentialId",   "interfacesPolling",   "interfaces"],
  ["lldpCredentialId",         "lldpPolling",         "lldp"],
] as const;

type CredentialField = typeof ASSET_DEFAULT_CREDENTIAL_FIELD | typeof STREAM_CREDENTIAL_FIELDS[number][0];

const ALL_CREDENTIAL_FIELDS: ReadonlyArray<CredentialField> = [
  ASSET_DEFAULT_CREDENTIAL_FIELD,
  ...STREAM_CREDENTIAL_FIELDS.map((f) => f[0]),
];

/** The asset columns this guard reads; structural so bulk-monitor can pass null. */
type AssetPollingColumns = Partial<Record<typeof STREAM_CREDENTIAL_FIELDS[number][1], string | null>>;

/**
 * Refuse a credential assignment that names no credential, or that hands a
 * stream a credential type its transport cannot use.
 *
 * `existing` is the asset's own polling columns; pass null to check existence
 * only. The type check is deliberately narrow, and skips rather than refuses
 * in three cases, because each one has a legitimate reading:
 *
 *  - **The asset default (`monitorCredentialId`) is never type-checked.** It is
 *    the fallback for all eight streams at once, which may legitimately poll
 *    over different transports, so no single type is "correct" for it. This
 *    matches the credential-usage resolver, which is wired by FK and explicitly
 *    NOT by polling-method type-match.
 *  - **A method that takes no credential** (icmp / disabled / agent / vcenter /
 *    fortimanager) leaves the slot dead rather than contradictory — an operator
 *    may be staging a credential before flipping the method.
 *  - **A method this request doesn't pin down** — cleared to null (inherit), or
 *    absent on both the request and the asset's own tier — would need the
 *    four-tier resolver to guess at, and that resolver falls THROUGH silently
 *    by design. Refusing on a guess would punish a plain re-save.
 *
 * So a 400 here means the contradiction is unambiguous: this stream polls over
 * this transport on this asset's own tier, and the credential cannot serve it.
 */
export async function assertCredentialAssignments(
  input: Partial<Record<CredentialField, string | null>> & Partial<Record<typeof STREAM_CREDENTIAL_FIELDS[number][1], PollingMethod | null>>,
  existing: AssetPollingColumns | null,
): Promise<void> {
  // Only ids being SET are checked — null clears the slot and undefined leaves
  // it alone, and neither can name a missing row.
  const assigned: Array<[CredentialField, string]> = [];
  for (const field of ALL_CREDENTIAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string") assigned.push([field, value]);
  }
  if (assigned.length === 0) return;

  // One query for the batch, not one per field.
  const rows = await prisma.credential.findMany({
    where:  { id: { in: [...new Set(assigned.map(([, id]) => id))] } },
    select: { id: true, name: true, type: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  for (const [field, id] of assigned) {
    if (!byId.has(id)) {
      throw new AppError(400, `Credential ${id} not found (field: ${field})`);
    }
  }
  if (!existing) return;

  for (const [credField, pollingField, stream] of STREAM_CREDENTIAL_FIELDS) {
    const credentialId = input[credField];
    if (typeof credentialId !== "string") continue;
    // Request wins over the stored column so a PUT that sets both is judged on
    // the method it is actually installing, not the one it is replacing.
    const method = input[pollingField] !== undefined ? input[pollingField] : (existing[pollingField] as PollingMethod | null | undefined);
    if (!method) continue;
    const needed = credentialTypeForPollingMethod(method);
    if (!needed) continue;
    const cred = byId.get(credentialId)!;
    if (cred.type !== needed) {
      throw new AppError(
        400,
        `Credential "${cred.name}" is a ${cred.type} credential, but the ${stream} stream polls over ` +
          `${pollingMethodLabel(method)} and needs a ${needed} credential (field: ${credField})`,
      );
    }
  }
}

/**
 * How often THIS device's current-state tables are actually refreshed, in
 * seconds — the figure the ARP Table, MAC Table and Wireless tabs state next
 * to their data, and the threshold they turn amber past.
 *
 * The system-info pass is the writer, so its resolved per-asset cadence is the
 * answer for a monitored device. `discoveryFallback` covers the one table
 * discovery ALSO writes: an unmonitored firewall — or one with system info off
 * — still gets ARP rows on its integration's pollInterval (12 h by default for
 * both Fortinet types), two orders of magnitude apart from the monitor
 * cadence, which is exactly why the tab cannot state one number for the fleet.
 * The forwarding database has no such second writer, so the MAC Table passes
 * `false` and gets null — "not being collected" rather than a cadence
 * borrowed from a pass that does not touch it.
 *
 * Returns null when nothing refreshes it, which the tab renders as "on
 * discovery only" / "not polled" rather than inventing a figure.
 */
export async function resolveCurrentStateIntervalSec(
  assetId: string,
  opts: { discoveryFallback: boolean },
): Promise<number | null> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: {
      id: true, assetType: true, monitored: true, status: true,
      discoveredByIntegrationId: true, monitorOverride: true,
      discoveredByIntegration: { select: { type: true, pollInterval: true } },
    },
  });
  if (!asset) return null;

  const discoverySec = opts.discoveryFallback && asset.discoveredByIntegration?.pollInterval
    ? asset.discoveredByIntegration.pollInterval * 3600
    : null;
  // A device that isn't being polled can only be refreshed by discovery.
  if (!asset.monitored || asset.status === "decommissioned" || asset.status === "disabled") {
    return discoverySec;
  }
  try {
    const resolved = await resolveMonitorSettings({
      ...(asset as any),
      discoveredByIntegrationType: asset.discoveredByIntegration?.type ?? null,
    } as any);
    const sec = (resolved as any)?.systemInfoIntervalSeconds;
    return typeof sec === "number" && sec > 0 ? sec : discoverySec;
  } catch {
    return discoverySec;
  }
}

/**
 * Quarantine status is owned by the quarantine endpoints (assetsQuarantine):
 * setting it anywhere else skips the FortiGate push, and discovery's
 * auto-quarantine pass then pushes a REAL quarantine for any sighted asset
 * whose status says "quarantined". `PUT /assets/:id` has always refused it;
 * create and the PDF import did not (re-scan F61). `current` is null for a
 * create. Throws 400.
 */
export function assertQuarantineStatusUntouched(next: unknown, current: string | null): void {
  if (next === undefined || next === null || next === "") return;
  if (next === "quarantined" && current !== "quarantined") {
    throw new AppError(400, "Quarantine an asset with POST /assets/:id/quarantine (Quarantine permission), not by setting its status");
  }
  if (next !== "quarantined" && current === "quarantined") {
    throw new AppError(400, "Release the quarantine with DELETE /assets/:id/quarantine before changing this asset's status");
  }
}

/** Rule 111(c) — see utils/integrationTokenTarget.ts. */
export function assertIpChangeMayRetargetIntegrationToken(
  req: Request,
  existing: { ipAddress: string | null; discoveredByIntegration?: { type: string } | null },
  nextIp: string | null | undefined,
): void {
  assertIpChangeMayRetargetIntegrationTokenUtil(hasPermission(req, "integrations", "write"), existing, nextIp);
}
