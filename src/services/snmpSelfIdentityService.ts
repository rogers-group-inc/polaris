/**
 * src/services/snmpSelfIdentityService.ts
 *
 * Business rule 154: what an SNMP device says about ITSELF — its sysName and
 * its ENTITY-MIB chassis row (utils/snmpEntityIdentity.ts) — lands on the
 * asset through an ENRICHMENT `AssetSource` row (`snmp-identity`, externalId
 * = the assetId) and the projection, never a direct column write. The
 * `snmp-sysdescr` / `fortinet-live` precedent:
 *
 *  - **The ladder decides who wins.** `snmp-identity` ranks below every
 *    directory, hypervisor, controller and agent and above only the Generic
 *    API feed and a gate's DHCP / device-inventory fingerprint, so it fills
 *    the asset nothing manages — an SNMP-only switch, a fibre-channel switch a
 *    FortiGate merely saw — and never displaces a source that owns the device.
 *    Discovery's own projection apply reaches the same answer, so the two
 *    writers never trade values.
 *  - **Only the five fields this source speaks to are applied** (hostname,
 *    serial, manufacturer, model, osVersion). Applying the whole projection
 *    would make the monitor path a general projection writer.
 *  - **An operator's typed hostname wins** (`hostnameOverride`, re-asserted by
 *    the db.ts extension); this service does not even offer one. An operator
 *    OUI override likewise keeps the manufacturer, as on the sysDescr path.
 *
 * ── Steady state costs nothing ─────────────────────────────────────────────
 * A reading is acted on only when it differs from what this source last
 * recorded: an in-memory map first (no query at all for an unchanged device),
 * then the stored row after a restart. The writes happen once per real change
 * — a renamed device, a chassis swap, a firmware upgrade. At 2000 SNMP assets
 * on the ~10-minute system-info cadence the steady state is an in-memory
 * compare per device per pass.
 *
 * ── Audit ──────────────────────────────────────────────────────────────────
 * A first learn fills the columns silently (the `computeFirmwareChange` rule:
 * a first learn is not a change, or the first pass over a fleet would write
 * one Event per device saying nothing happened). A MOVE of hostname, model,
 * manufacturer or serial writes `asset.model_detected` — the vocabulary the
 * sysDescr path already uses — and a firmware move writes the standard
 * `asset.firmware.changed`, which the firmware_changed automation trigger
 * watches.
 */

import { prisma } from "../db.js";
import { logger } from "../utils/logger.js";
import { projectAssetFromSources } from "../utils/assetProjection.js";
import { normalizeManufacturer } from "../utils/manufacturerNormalize.js";
import { hasSelfIdentity, type SnmpSelfIdentity } from "../utils/snmpEntityIdentity.js";
import { buildFirmwareChangedEvent, logEvent } from "./eventLogService.js";
import { lookupOuiOverride } from "./ouiService.js";

const SNMP_IDENTITY_SOURCE_KIND = "snmp-identity";

const FIELDS = ["hostname", "serialNumber", "manufacturer", "model", "osVersion"] as const;
type Field = (typeof FIELDS)[number];

/** assetId → the observed blob (canonical JSON) last recorded. */
const lastRecorded = new Map<string, string>();

/** Test hook. */
export function resetSnmpSelfIdentityCache(): void {
  lastRecorded.clear();
}

/** Corporate suffixes that never distinguish one vendor from another. */
const VENDOR_SUFFIX = /[\s,.]+(inc|incorporated|corp|corporation|co|ltd|llc|gmbh|systems|technologies|networks)\b\.?/gi;

/**
 * True when two manufacturer strings name the same vendor: equal after the
 * alias table, or after dropping corporate suffixes and punctuation.
 */
export function sameVendor(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const na = normalizeManufacturer(a).toLowerCase();
  const nb = normalizeManufacturer(b).toLowerCase();
  if (na === nb) return true;
  const strip = (s: string) => s.replace(VENDOR_SUFFIX, "").replace(/[^a-z0-9]/g, "");
  const sa = strip(na);
  return sa.length > 0 && sa === strip(nb);
}

/** Canonical form of a reading: fixed key order, absent fields omitted. */
export function observedKey(identity: SnmpSelfIdentity): string {
  const o: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = identity[f];
    if (typeof v === "string" && v) o[f] = v;
  }
  return JSON.stringify(o);
}

/**
 * Reconcile one device's self-report onto its asset. Best-effort: a failure
 * is logged and never fails the system-info pass that carried the reading.
 * Returns true when the asset row was written.
 */
export async function reconcileSnmpSelfIdentity(
  assetId: string,
  identity: SnmpSelfIdentity | undefined,
): Promise<boolean> {
  if (!hasSelfIdentity(identity)) return false;
  const key = observedKey(identity);
  if (lastRecorded.get(assetId) === key) return false;
  try {
    return await recordOne(assetId, key);
  } catch (err) {
    logger.debug({ assetId, err: (err as Error)?.message }, "snmp self-identity reconcile failed");
    return false;
  }
}

async function recordOne(assetId: string, key: string): Promise<boolean> {
  const observed = JSON.parse(key) as Record<string, string>;
  const where = { sourceKind_externalId: { sourceKind: SNMP_IDENTITY_SOURCE_KIND, externalId: assetId } };

  // After a restart the map is empty: the stored row says whether the source
  // needs rewriting. The projection below is checked either way, once per
  // asset per process — which is what heals an apply a crash interrupted.
  const existing = await prisma.assetSource.findUnique({ where, select: { observed: true } });
  if (!existing || observedKey((existing.observed ?? {}) as SnmpSelfIdentity) !== key) {
    const now = new Date();
    await prisma.assetSource.upsert({
      where,
      create: { assetId, sourceKind: SNMP_IDENTITY_SOURCE_KIND, externalId: assetId, observed, syncedAt: now, lastSeen: now },
      update: { assetId, observed, syncedAt: now, lastSeen: now },
    });
  }
  const written = await applyProjection(assetId);
  // Cached only once the apply finished, so a failed one is retried next pass.
  lastRecorded.set(assetId, key);
  return written;
}

async function applyProjection(assetId: string): Promise<boolean> {

  const [sources, asset] = await Promise.all([
    prisma.assetSource.findMany({
      where: { assetId },
      select: { sourceKind: true, inferred: true, observed: true, lastSeen: true },
    }),
    prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        hostname: true, hostnameOverride: true, serialNumber: true,
        manufacturer: true, model: true, osVersion: true, macAddress: true,
      },
    }),
  ]);
  if (!asset) return false;

  const { projected } = projectAssetFromSources(
    sources.map((s) => ({
      sourceKind: s.sourceKind,
      inferred: s.inferred,
      observed: s.observed as Record<string, unknown> | null,
      lastSeen: s.lastSeen,
    })),
  );

  const diff: Partial<Record<Field, string>> = {};
  for (const f of FIELDS) {
    const next = projected[f];
    if (next !== null && next !== asset[f]) diff[f] = next;
  }
  // "Cisco" and "Cisco Systems, Inc." are one vendor spelled twice. The alias
  // table folds them on write, but it is DB-loaded and may not be warm on
  // this process role — a spelling is never a write or an audited "move".
  if (diff.manufacturer && sameVendor(diff.manufacturer, asset.manufacturer)) {
    delete diff.manufacturer;
  }
  // The operator's typed name is a pin; offering a different one would only
  // hand the db.ts guard a write to rewrite.
  if (asset.hostnameOverride) delete diff.hostname;
  // An operator OUI override is an explicit statement about the vendor, which
  // the projection cannot see (Phase 9a writes it straight onto the Asset).
  if (diff.manufacturer && asset.macAddress && (await lookupOuiOverride(asset.macAddress))) {
    delete diff.manufacturer;
  }
  if (Object.keys(diff).length === 0) return false;

  await prisma.asset.update({ where: { id: assetId }, data: diff });

  const name = diff.hostname ?? asset.hostname;
  const fw = buildFirmwareChangedEvent(
    { assetId, assetName: name, actor: "system:monitor", source: SNMP_IDENTITY_SOURCE_KIND },
    { osVersion: asset.osVersion },
    { osVersion: diff.osVersion ?? asset.osVersion },
  );
  if (fw) await logEvent(fw);

  const moved: string[] = [];
  for (const f of ["hostname", "model", "manufacturer", "serialNumber"] as const) {
    const before = (asset[f] ?? "").trim();
    if (diff[f] && before) moved.push(`${f} "${before}" → "${diff[f]}"`);
  }
  if (moved.length) {
    await logEvent({
      action: "asset.model_detected",
      resourceType: "asset",
      resourceId: assetId,
      resourceName: name || undefined,
      level: "info",
      message: `Identity restated by the device: ${name || assetId} ${moved.join("; ")}`,
      details: {
        source: "snmp:entity-mib",
        previous: Object.fromEntries(FIELDS.map((f) => [f, asset[f] ?? null])),
        next: Object.fromEntries(FIELDS.map((f) => [f, diff[f] ?? asset[f] ?? null])),
      },
    });
  }
  return true;
}
