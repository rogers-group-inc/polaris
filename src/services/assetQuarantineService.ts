/**
 * src/services/assetQuarantineService.ts — Push / release asset MAC
 * quarantine on FortiGates.
 *
 * Pushes every MAC associated with an asset to every FortiGate the asset
 * has been recently sighted on (per assetSightingService) using the
 * persistent FortiOS user.quarantine.targets CMDB tree. Each Polaris-
 * managed quarantine becomes a single target named `polaris-<short-id>`
 * on the FortiGate, with one MAC entry per associated MAC. Release
 * removes that entry from the table.
 *
 * ── FortiOS endpoint, as the device describes it ────────────────────────
 * Every read and write goes through ONE resource:
 *
 *     GET /api/v2/cmdb/user/quarantine          → the whole object
 *     PUT /api/v2/cmdb/user/quarantine          → { targets: [ … ] }
 *
 * `user.quarantine` is a COMPLEX (single) object whose `targets` child table
 * holds one entry per quarantined device, keyed on `entry`, each carrying a
 * `macs` child table keyed on `mac`. Ask any gate and it will say so:
 *
 *     GET /api/v2/cmdb/user/quarantine?action=schema
 *
 * which is the authority for a given build — not this comment. It also
 * publishes `access_group: "wifi"`, i.e. the REST API admin needs WiFi &
 * Switch Controller write, and the field sizes (both descriptions: 63).
 *
 * The child table has NO collection resource. This service previously
 * assumed one and it does not exist:
 *
 *     POST   /api/v2/cmdb/user/quarantine/targets          → 405
 *     DELETE /api/v2/cmdb/user/quarantine/targets/<entry>   → likewise unreal
 *
 * FortiOS exposes POST/DELETE on a child table only where the parent is
 * itself a table and the URL carries the parent's mkey (the
 * `/firewall/policy/1/srcaddr` shape); this parent has no mkey. Create,
 * release and rollback were therefore all broken by one fact, which is why
 * they now share a single mechanism. See "The write mechanism" below for the
 * read-modify-write hazard that follows from PUTting a shared table, and
 * `tests/unit/quarantineRequestShape.test.ts` for the guards.
 *
 * ── Transport ───────────────────────────────────────────────────────────
 * Identical to reservationPushService:
 *   - useProxy=true  → wrap each call in FMG `/sys/proxy/json`
 *   - useProxy=false → resolve the device's mgmt IP via FMG, then call
 *                       the FortiGate REST API directly with
 *                       `fortigateApiUser` / `fortigateApiToken`.
 *
 * ── Atomicity ──────────────────────────────────────────────────────────
 * Per-FortiGate is all-or-nothing: a partial-target write rolls back by
 * deleting the target before throwing. Across-FortiGate is best-effort:
 * if 3 of 5 sites succeed, the asset still flips to `quarantined` and
 * the failed targets are recorded as `status: "failed"` in
 * `Asset.quarantineTargets[]` so an operator can retry.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logEvent } from "./eventLogService.js";
import {
  buildTransportForIntegration,
  callFortiOs,
  normalizeMac,
  type Transport,
} from "./reservationPushService.js";
import { getQuarantineCandidates, type AssetSighting } from "./assetSightingService.js";
import { expandMacRange } from "../utils/macAddresses.js";

// ─── FortiOS user.quarantine shapes (subset) ────────────────────────────

/**
 * `user.quarantine.targets`, as the device's own schema describes it
 * (`GET /api/v2/cmdb/user/quarantine/targets?action=schema` on FortiOS 7.x):
 *
 *   mkey: "entry"  (string, required, size 63)
 *   description    (string, size 63)
 *   macs[]         child table, mkey "mac" (mac-address)
 *     description  (string, size 63)
 *     drop         option, DEFAULT "disable" = "Sends quarantined device
 *                  traffic to FortiGate" — i.e. does NOT block it
 *     parent       readonly, set by the device
 *
 * The mkey is `entry`, NOT `name`. This interface modelled both from the start
 * and every writer used `name`, so every create POST was a body with no mkey
 * in it and FortiOS answered 500 — on both transports, on every install, since
 * the service shipped. `name` is gone rather than kept optional: leaving it
 * would let a future writer pick the one that silently fails.
 */
interface FortiOsQuarantineTarget {
  entry?: string;
  description?: string;
  macs?: Array<{
    mac?: string;
    description?: string;
    drop?: "enable" | "disable";
    parent?: string;
  }>;
}

/**
 * FortiOS caps both `description` fields at 63 characters. The cap here was 64
 * — one over, so a long hostname made the difference between a quarantine that
 * applied and one that was refused.
 */
const FORTIOS_DESCRIPTION_MAX = 63;

/**
 * Quarantine only means something with `drop` ENABLED. The device default is
 * `disable`, which the schema glosses as "Sends quarantined device traffic to
 * FortiGate" — the MAC is listed, the traffic flows. Polaris quarantine is a
 * containment action, so every MAC it writes carries drop=enable explicitly;
 * relying on a device default for the half that does the blocking is how a
 * security action becomes a no-op that reads as success.
 */
const QUARANTINE_DROP = "enable" as const;

// ─── Transport ──────────────────────────────────────────────────────────
// Shared with every other FortiOS write pathway: buildTransportForIntegration
// / callFortiOs / normalizeMac are imported from reservationPushService (the
// Transport surface's home). This file carried byte-identical private copies
// until 2026-08, when the 2026-08-04 production-readiness audit called it out.
// (The report itself is a generated artifact and is no longer tracked — see
// .gitignore — so this records the finding rather than pointing at a path.)

// ─── Helpers ───────────────────────────────────────────────────────────

export function quarantineTargetName(assetId: string): string {
  // FortiOS object names are typically capped at 35 chars. `polaris-q-`
  // is 10 chars; a short asset id of 12 hex chars gives a 22-char total
  // with comfortable headroom across versions. Strip dashes from the
  // UUID so the name is a clean prefix + alphanumeric tail.
  const compact = assetId.replace(/-/g, "");
  return `polaris-q-${compact.slice(0, 12)}`;
}

/**
 * Printable-ASCII only, for a string being written into FortiOS CMDB config.
 *
 * The target description was built with an em dash (U+2014) from the day this
 * service shipped, and a hostname reaches the per-MAC description as typed —
 * so a quarantine push could put non-ASCII bytes into a device config field.
 * FortiOS is inconsistent about accepting them (they also come back mangled in
 * the CLI and in FortiManager's copy of the config), and a rejected write here
 * costs an operator a security action: `pushQuarantineToFortigate` rolls the
 * target back and the asset never flips to `quarantined`. Descriptions are
 * ours to phrase, so nothing is lost by keeping them ASCII.
 *
 * Non-printable and non-ASCII runs collapse to a single space rather than
 * vanishing, so a name made entirely of them can't silently become "".
 */
export function asciiForDevice(value: string): string {
  return value
    .replace(/—|–/g, "-")   // em / en dash — the ones we author ourselves
    .replace(/[^ -~]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

function buildMacDescription(
  hostname: string | null | undefined,
  actor: string,
  fallback: string,
): string {
  // Format: "Polaris/<actor>: <hostname>" — origin first so a FortiGate
  // admin scanning the quarantine list immediately sees Polaris owns this
  // entry and which user/token initiated it.
  const name = (hostname && hostname.trim()) || fallback || "(unnamed)";
  // Sanitized BEFORE the length cap, so the cap counts the characters that will
  // actually be sent rather than bytes a replacement may shorten.
  const candidate = asciiForDevice(`Polaris/${actor}: ${name}`) || "Polaris";
  return candidate.length > FORTIOS_DESCRIPTION_MAX
    ? candidate.slice(0, FORTIOS_DESCRIPTION_MAX)
    : candidate;
}

/** The target's own description, ASCII and inside FortiOS's 63-char field. */
function buildTargetDescription(actor: string): string {
  const candidate = asciiForDevice(`Polaris asset quarantine - ${actor}`);
  return candidate.length > FORTIOS_DESCRIPTION_MAX
    ? candidate.slice(0, FORTIOS_DESCRIPTION_MAX)
    : candidate;
}

/**
 * ── The write mechanism ─────────────────────────────────────────────────────
 *
 * `user.quarantine` is a COMPLEX (single) object and `targets` is a child table
 * inside it, which FortiOS states in its own schema
 * (`GET /api/v2/cmdb/user/quarantine?action=schema` → `"category": "complex"`).
 * A child table of a single object has no addressable collection resource: a
 * `POST /api/v2/cmdb/user/quarantine/targets` answers **405 Method Not
 * Allowed**, whatever the body. FortiOS exposes POST/DELETE on a child table
 * only when the parent is itself a table and the URL carries the parent's mkey
 * (`/firewall/policy/1/srcaddr`); this parent has no mkey.
 *
 * So every write goes through ONE mechanism — `PUT /api/v2/cmdb/user/quarantine`
 * carrying the whole `targets` array — used by create, reconcile, rollback AND
 * release alike. That is deliberate: the previous design used POST to create and
 * DELETE on the child path to release and to roll back, so release was broken in
 * exactly the same way as create and neither could be fixed alone. A partial PUT
 * naming only `targets` leaves the object's other attributes (`quarantine`,
 * `traffic-policy`, `firewall-groups`) untouched, so the blast radius is the
 * targets table itself.
 *
 * Which raises the hazard that shapes everything below: **that table is not
 * ours.** The gate's own Quarantine Host action, NAC policies and automation
 * stitches write entries there too, and a full-array PUT deletes whatever it
 * omits. Hence read-modify-write with three guards:
 *
 *   - foreign entries are carried through VERBATIM apart from device-owned
 *     readonly fields, which FortiOS refuses on write (`parent`, and the
 *     `q_origin_key` some builds decorate reads with);
 *   - the read-back verifies not just that OUR entry landed but that every
 *     foreign entry survived, and restores the snapshot if one did not;
 *   - the rollback restores the exact array that was read, rather than deleting
 *     our entry, so a failure cannot leave the table shorter than it started.
 *
 * KNOWN LIMITATION: read-modify-write over a shared table has a lost-update
 * window, and FortiOS CMDB offers no ETag or compare-and-set to close it. Two
 * pushes to the same gate are serialized within a process
 * (`withQuarantineLane`), but Polaris runs split-role, so an operator-initiated
 * push from the web role and an auto-quarantine from the discovery role can
 * still interleave. The foreign-entry check turns the bad outcome from silent
 * entry loss into a failed push with the table restored. Quarantine is a rare,
 * operator-paced action, so that trade is deliberate rather than merely
 * tolerated.
 */

/** Fields FortiOS owns and refuses on write. */
const DEVICE_OWNED_TARGET_FIELDS = ["q_origin_key"];
const DEVICE_OWNED_MAC_FIELDS = ["parent", "q_origin_key"];

function stripKeys(row: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * A target as it must be sent back: readonly fields dropped from the target and
 * from every MAC row. Everything else passes through untouched — a foreign
 * entry's description, its MAC set, and any attribute a newer FortiOS added that
 * this code has never heard of.
 */
function sanitizeTargetForWrite(target: FortiOsQuarantineTarget): FortiOsQuarantineTarget {
  const clean = stripKeys(target, DEVICE_OWNED_TARGET_FIELDS);
  const macs = (target.macs ?? []).map(
    (m) => stripKeys(m, DEVICE_OWNED_MAC_FIELDS) as NonNullable<FortiOsQuarantineTarget["macs"]>[number],
  );
  if (target.macs !== undefined) clean.macs = macs;
  return clean as FortiOsQuarantineTarget;
}

interface QuarantineObject {
  /** The feature's own master switch. The schema default is "enable". */
  enabled: boolean;
  targets: FortiOsQuarantineTarget[];
}

/** Read the whole quarantine object: the master switch plus every target. */
async function readQuarantineObject(t: Transport): Promise<QuarantineObject> {
  const data = await callFortiOs<any>(t, "GET", "/api/v2/cmdb/user/quarantine");
  // FortiOS wraps a complex object's results in a single-element array on some
  // builds and returns it bare on others.
  const obj = Array.isArray(data) ? data[0] ?? {} : data ?? {};
  const targets: FortiOsQuarantineTarget[] = Array.isArray(obj.targets) ? obj.targets : [];
  // Absent reads as enabled, matching the schema default: refusing to quarantine
  // because an older build does not publish the field would be the wrong way to
  // be careful.
  return { enabled: obj.quarantine !== "disable", targets };
}

/** Replace the targets table. No other attribute of the object is named. */
async function writeQuarantineTargets(
  t: Transport,
  targets: FortiOsQuarantineTarget[],
): Promise<void> {
  await callFortiOs<unknown>(t, "PUT", "/api/v2/cmdb/user/quarantine", {
    targets: targets.map(sanitizeTargetForWrite),
  });
}

/**
 * One target by mkey. There is no per-entry GET worth using here: the object
 * read is a single round trip that answers for the whole table, and it is the
 * same read every write path needs, so this shares it rather than adding a
 * second endpoint whose 404 semantics would have to be handled separately.
 */
async function readOneTarget(
  t: Transport,
  entryName: string,
): Promise<FortiOsQuarantineTarget | null> {
  const obj = await readQuarantineObject(t);
  return obj.targets.find((x) => entryNameOf(x) === entryName) ?? null;
}

function entryNameOf(target: FortiOsQuarantineTarget): string {
  return String(target.entry ?? "");
}

function macSetOf(target: FortiOsQuarantineTarget | undefined): Set<string> {
  return new Set((target?.macs ?? []).map((m) => normalizeMac(m.mac || "")).filter(Boolean));
}

/**
 * Serialize read-modify-write per gate WITHIN this process. Keyed on the
 * transport's device identity, not on the asset: the contention is over the one
 * shared targets table, so two different assets pushing to the same gate is
 * exactly the case that needs ordering.
 */
const quarantineLanes = new Map<string, Promise<unknown>>();

function quarantineLaneKey(t: Transport): string {
  const anyT = t as unknown as Record<string, any>;
  return t.kind === "direct-fortigate"
    ? "fg:" + String(anyT.fgConfig?.host ?? "?") + ":" + String(anyT.vdom ?? "root")
    : "fmg:" + String(anyT.integrationId ?? "?") + ":" + String(anyT.deviceName ?? "?");
}

async function withQuarantineLane<T>(t: Transport, fn: () => Promise<T>): Promise<T> {
  const key = quarantineLaneKey(t);
  const prior = quarantineLanes.get(key) ?? Promise.resolve();
  // Runs after the prior holder settles either way — a failed push must not
  // wedge the lane for every later one.
  const run = prior.then(fn, fn);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  quarantineLanes.set(key, settled);
  try {
    return await run;
  } finally {
    // Only the last waiter clears the lane, so an in-flight successor is never
    // orphaned out of the map.
    if (quarantineLanes.get(key) === settled) quarantineLanes.delete(key);
  }
}

// ─── Public API ─────────────────────────────────────

export interface PushQuarantineParams {
  assetId: string;
  hostname?: string | null;
  /** All MACs to write to this device. Caller dedupes + normalizes. */
  macs: string[];
  /** "user:<username>" or "api:<token-name>" or "system:auto-quarantine". */
  actor: string;
  /** Pre-built transport for the target FortiGate. */
  transport: Transport;
  /** Device name (informational, used in error messages and result). */
  deviceName: string;
}

export interface PushQuarantineResult {
  fortigateDevice: string;
  targetName: string;
  pushedMacs: string[];
}

/**
 * Push a per-asset quarantine target to one FortiGate. Idempotent: an existing
 * target has its MAC list reconciled to match `macs`, and a target that already
 * matches costs no write at all. On any failure the targets table is restored to
 * exactly what was read before the attempt.
 */
export async function pushQuarantineToFortigate(
  params: PushQuarantineParams,
): Promise<PushQuarantineResult> {
  if (!params.deviceName) {
    throw new AppError(400, "Push requires a FortiGate device name");
  }
  if (params.macs.length === 0) {
    throw new AppError(400, "Push requires at least one MAC");
  }

  const targetName = quarantineTargetName(params.assetId);
  const desiredMacs = Array.from(new Set(params.macs.map(normalizeMac)))
    .filter((m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m));
  if (desiredMacs.length === 0) {
    throw new AppError(400, "Push requires at least one valid MAC");
  }

  const t = params.transport;

  return withQuarantineLane(t, async () => {
    const before = await readQuarantineObject(t);

    // A target written into a disabled feature is not containment. The asset
    // would flip to `quarantined` while the device kept forwarding its traffic,
    // which is worse than a push that fails and says why.
    if (!before.enabled) {
      throw new AppError(
        409,
        `FortiGate "${params.deviceName}" has quarantine disabled (user.quarantine: disable) — enable it on ` +
          `the device before pushing, or the entry would be written and never applied`,
      );
    }

    const ourTarget: FortiOsQuarantineTarget = {
      entry: targetName,
      description: buildTargetDescription(params.actor),
      macs: desiredMacs.map((mac) => ({
        mac,
        description: buildMacDescription(params.hostname, params.actor, mac),
        drop: QUARANTINE_DROP,
      })),
    };

    const existingIdx = before.targets.findIndex((x) => entryNameOf(x) === targetName);
    const existing = existingIdx >= 0 ? before.targets[existingIdx] : undefined;

    // Nothing to do when the device already says what we would say. Compared on
    // the MAC set and on `drop`, never on the descriptions — re-pushing every
    // cycle because an operator retitled something would be churn.
    const existingMacSet = macSetOf(existing);
    const macsMatch =
      existingMacSet.size === desiredMacs.length && desiredMacs.every((m) => existingMacSet.has(m));
    const allDropping = (existing?.macs ?? []).every((m) => m.drop === QUARANTINE_DROP);
    if (existing && macsMatch && allDropping) {
      return { fortigateDevice: params.deviceName, targetName, pushedMacs: desiredMacs };
    }

    // Ours replaces in place when present, so the table keeps its order.
    const next = [...before.targets];
    if (existingIdx >= 0) next[existingIdx] = ourTarget;
    else next.push(ourTarget);

    const foreignNames = before.targets.map(entryNameOf).filter((n) => n && n !== targetName);

    try {
      await writeQuarantineTargets(t, next);

      const after = await readQuarantineObject(t);
      const afterByName = new Map(after.targets.map((x) => [entryNameOf(x), x]));

      const landed = afterByName.get(targetName);
      if (!landed) {
        throw new AppError(
          502,
          `FortiGate accepted the write but the quarantine target ${targetName} was not visible on read-back`,
        );
      }
      const verifiedMacs = macSetOf(landed);
      const missing = desiredMacs.filter((m) => !verifiedMacs.has(m));
      if (missing.length > 0) {
        throw new AppError(
          502,
          `FortiGate verify mismatch — target ${targetName} is missing MACs: ${missing.join(", ")}`,
        );
      }

      // The guard that matters: a full-array PUT can delete entries Polaris does
      // not own, so prove none went missing before reporting success.
      const lostForeign = foreignNames.filter((n) => !afterByName.has(n));
      if (lostForeign.length > 0) {
        throw new AppError(
          502,
          `Quarantine write removed ${lostForeign.length} quarantine entry/entries Polaris does not own ` +
            `(${lostForeign.join(", ")}) — the table has been restored. Retry; if it repeats, another writer ` +
            `is changing user.quarantine concurrently`,
        );
      }

      return { fortigateDevice: params.deviceName, targetName, pushedMacs: desiredMacs };
    } catch (err) {
      // Restore the exact array that was read. This replaces the old
      // delete-our-target rollback, which could only ever shorten the table and
      // did nothing at all when the failure was a lost foreign entry.
      try {
        await writeQuarantineTargets(t, before.targets);
      } catch {
        /* swallow — the caller still surfaces the original error */
      }
      throw err;
    }
  });
}

export interface UnpushQuarantineParams {
  assetId: string;
  transport: Transport;
}

export interface UnpushQuarantineResult {
  removed: boolean;
  alreadyAbsent: boolean;
}

/**
 * Release: the same parent-object PUT, with our entry filtered out. It cannot be
 * a `DELETE /targets/<entry>` — the child table of a complex object exposes no
 * such resource (see "The write mechanism" above), which is why release used to
 * fail for exactly the reason create did.
 *
 * Absence is success, not an error: an entry already gone (released by hand on
 * the device, or a quarantine that never landed) reports `alreadyAbsent` and
 * costs no write.
 */
export async function unpushQuarantineFromFortigate(
  params: UnpushQuarantineParams,
): Promise<UnpushQuarantineResult> {
  const targetName = quarantineTargetName(params.assetId);
  const t = params.transport;

  return withQuarantineLane(t, async () => {
    const before = await readQuarantineObject(t);
    const present = before.targets.some((x) => entryNameOf(x) === targetName);
    if (!present) return { removed: false, alreadyAbsent: true };

    const next = before.targets.filter((x) => entryNameOf(x) !== targetName);
    const foreignNames = next.map(entryNameOf).filter(Boolean);

    try {
      await writeQuarantineTargets(t, next);

      const after = await readQuarantineObject(t);
      const afterNames = new Set(after.targets.map(entryNameOf));
      if (afterNames.has(targetName)) {
        throw new AppError(
          502,
          `FortiGate accepted the write but quarantine target ${targetName} is still present on read-back`,
        );
      }
      // Releasing one asset must not take anyone else's entry with it.
      const lostForeign = foreignNames.filter((n) => !afterNames.has(n));
      if (lostForeign.length > 0) {
        throw new AppError(
          502,
          `Quarantine release removed ${lostForeign.length} entry/entries Polaris does not own ` +
            `(${lostForeign.join(", ")}) — the table has been restored`,
        );
      }
      return { removed: true, alreadyAbsent: false };
    } catch (err) {
      try {
        await writeQuarantineTargets(t, before.targets);
      } catch {
        /* swallow — the caller still surfaces the original error */
      }
      throw err;
    }
  });
}

/**
 * Read-only verify against the device. Returns true if the target exists
 * and contains every desired MAC; false otherwise. Used by the discovery
 * sync for drift detection.
 */
export async function verifyQuarantineOnFortigate(params: {
  assetId: string;
  desiredMacs: string[];
  transport: Transport;
}): Promise<{ present: boolean; missingMacs: string[] }> {
  const targetName = quarantineTargetName(params.assetId);
  const desired = Array.from(new Set(params.desiredMacs.map(normalizeMac)));
  const target = await readOneTarget(params.transport, targetName);
  if (!target) return { present: false, missingMacs: desired };
  const verifiedMacs = new Set(
    (target.macs ?? []).map((m) => normalizeMac(m.mac || "")).filter(Boolean),
  );
  const missingMacs = desired.filter((m) => !verifiedMacs.has(m));
  return { present: missingMacs.length === 0, missingMacs };
}

// ─── High-level orchestration ───────────────────────────────────────────

/**
 * Per-FortiGate record stamped on Asset.quarantineTargets[]. Status:
 *   "synced" — push verified on read-back
 *   "failed" — last push attempt errored; may retry
 *   "drift"  — was synced; later discovery found the target/MACs missing
 */
export interface QuarantineTargetRecord {
  fortigateDevice: string;
  integrationId: string;
  pushedMacs: string[];
  pushedAt: string;
  status: "synced" | "failed" | "drift";
  error?: string;
}

/**
 * The asset's recorded quarantine targets after a push (business rule
 * 114(d)). An unscoped caller pushed to every sighting, so its targets ARE the
 * record. A bearer token scoped to some integrations pushed only to those: its
 * targets replace the in-scope entries and every out-of-scope entry is kept —
 * otherwise the token would erase the record of another site's quarantine,
 * which release and verify then could not find. Pure.
 */
export function mergeQuarantineTargets(
  existing: unknown,
  fresh: QuarantineTargetRecord[],
  tokenScope: string[] | undefined,
): QuarantineTargetRecord[] {
  if (!tokenScope) return fresh;
  const inScope = new Set(tokenScope);
  const kept = (Array.isArray(existing) ? (existing as QuarantineTargetRecord[]) : [])
    .filter((t) => t && typeof t.integrationId === "string" && !inScope.has(t.integrationId));
  return [...kept, ...fresh];
}

function macsForAsset(asset: { macAddress: string | null; macAddressRows?: Array<{ mac: string; macEnd?: string | null }> }): string[] {
  const set = new Set<string>();
  if (asset.macAddress) set.add(normalizeMac(asset.macAddress));
  if (Array.isArray(asset.macAddressRows)) {
    for (const entry of asset.macAddressRows) {
      if (!entry?.mac) continue;
      // Interface-fold range rows expand so quarantine blocks every port MAC
      // in the range, not just the range start. Capped — a quarantined asset
      // is an endpoint, so real ranges here are a handful of NICs.
      for (const mac of expandMacRange(entry.mac, entry.macEnd ?? null, 64)) {
        const m = normalizeMac(mac);
        if (m) set.add(m);
      }
    }
  }
  return Array.from(set).filter((m) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(m));
}

export interface QuarantineAssetParams {
  assetId: string;
  actor: string; // "user:<username>" | "api:<token-name>" | "system:auto-quarantine"
  reason?: string;
  // When provided (bearer-token callers), restricts which integrations the
  // push will fan out to. Sightings whose originating integration is not in
  // this list are silently ignored, so a SIEM token minted for "Site A" can
  // never accidentally quarantine via Site B's FortiGate. Undefined =
  // session-authenticated or system caller; no filter applied.
  tokenIntegrationIds?: string[];
}

export interface QuarantineAssetResult {
  assetId: string;
  status: "quarantined" | "ineligible";
  targets: QuarantineTargetRecord[];
  succeededCount: number;
  failedCount: number;
  message: string;
}

/**
 * Whether quarantine push is available on this install at all: does ANY
 * enabled FortiManager / FortiGate integration carry `config.pushQuarantine`?
 *
 * `quarantineAsset` already skips every sighting whose integration has the
 * toggle off, so with it off fleet-wide a push resolves to zero targets and
 * the operator gets a 502 reading "0/0 FortiGate(s) accepted the push" — a
 * failure that describes a device problem when the real answer is that the
 * feature was never turned on. The frontends call this to hide the quarantine
 * verbs rather than offer a button that can only fail.
 *
 * Deliberately install-wide rather than per-asset: the per-asset answer needs
 * each asset's sightings joined to their integrations, and the row menu asks
 * this question for every row of a 2000-asset table. On a multi-integration
 * install where only some carry the toggle this is therefore the OPTIMISTIC
 * answer — the push stays the authority, and its per-target records still name
 * the FortiGates it skipped.
 *
 * Release is NOT gated on it: `releaseQuarantine` unpushes from the targets
 * recorded on the asset without consulting the toggle, so an asset quarantined
 * before push was switched off must stay releasable.
 */
export async function getQuarantinePushAvailability(): Promise<{
  pushEnabled: boolean;
  integrationCount: number;
  pushEnabledCount: number;
}> {
  const rows = await prisma.integration.findMany({
    where: { type: { in: ["fortimanager", "fortigate"] }, enabled: true },
    select: { config: true },
  });
  const pushEnabledCount = rows.filter(
    (r) => ((r.config ?? {}) as Record<string, unknown>).pushQuarantine === true,
  ).length;
  return {
    pushEnabled: pushEnabledCount > 0,
    integrationCount: rows.length,
    pushEnabledCount,
  };
}

/**
 * Quarantine an asset across every FortiGate it has been recently sighted
 * on. Per-FortiGate is all-or-nothing; across-FortiGate is best-effort
 * (partial successes still flip the asset to `quarantined`).
 *
 * Eligibility:
 *   - Asset must exist and have at least one valid MAC.
 *   - At least one sighting must fall inside the configured
 *     `quarantine.sightingMaxAgeDays` window AND its integration must
 *     still be enabled.
 */
export async function quarantineAsset(
  params: QuarantineAssetParams,
): Promise<QuarantineAssetResult> {
  const asset = await prisma.asset.findUnique({
    where: { id: params.assetId },
    include: { macAddressRows: { select: { mac: true, macEnd: true } } },
  });
  if (!asset) throw new AppError(404, `Asset ${params.assetId} not found`);

  // Infrastructure assets discovered from FMG/FortiGate (firewalls, switches,
  // access points) cannot be quarantined — quarantining the device that does
  // the quarantining would lock the operator out of the network.
  if (asset.assetType === "firewall" || asset.assetType === "switch" || asset.assetType === "access_point") {
    throw new AppError(
      400,
      `Asset ${asset.hostname || asset.id} is a ${asset.assetType} and cannot be quarantined`,
    );
  }

  const macs = macsForAsset(asset);
  if (macs.length === 0) {
    throw new AppError(
      400,
      `Asset ${asset.hostname || asset.id} has no MAC addresses — cannot quarantine`,
    );
  }

  const allCandidates: AssetSighting[] = await getQuarantineCandidates(asset.id);
  if (allCandidates.length === 0) {
    throw new AppError(
      409,
      `Asset ${asset.hostname || asset.id} has no recent FortiGate sightings — nothing to push to`,
    );
  }

  // Bearer-token callers are scoped to a fixed integration set. Drop any
  // sighting whose integration isn't in that set before doing any work; if
  // nothing survives, fail with a 403 rather than silently no-op'ing.
  const tokenScope = params.tokenIntegrationIds;
  const candidates = tokenScope
    ? allCandidates.filter((c) => c.integrationId && tokenScope.includes(c.integrationId))
    : allCandidates;
  if (tokenScope && candidates.length === 0) {
    throw new AppError(
      403,
      `Asset ${asset.hostname || asset.id} has no recent sightings on the integrations this token is allowed to push to`,
    );
  }

  // Group sightings by integration so we load each integration once.
  const integrationIds = new Set(candidates.map((c) => c.integrationId).filter((id): id is string => !!id));
  const integrations = await prisma.integration.findMany({
    where: { id: { in: Array.from(integrationIds) }, enabled: true },
  });
  const integrationById = new Map(integrations.map((i) => [i.id, i]));

  const targets: QuarantineTargetRecord[] = [];

  for (const sighting of candidates) {
    if (!sighting.integrationId) continue;
    const integration = integrationById.get(sighting.integrationId);
    if (!integration) continue; // disabled or deleted; skip silently

    // Skip integrations where the operator has not enabled quarantine push.
    const intgCfg = integration.config as Record<string, unknown>;
    if (intgCfg.pushQuarantine !== true) continue;

    let transport: Transport;
    try {
      transport = await buildTransportForIntegration(
        integration as { id: string; type: string; config: unknown },
        sighting.fortigateDevice,
      );
    } catch (err: any) {
      targets.push({
        fortigateDevice: sighting.fortigateDevice,
        integrationId: integration.id,
        pushedMacs: [],
        pushedAt: new Date().toISOString(),
        status: "failed",
        error: err?.message || "Transport setup failed",
      });
      continue;
    }

    try {
      const res = await pushQuarantineToFortigate({
        assetId: asset.id,
        hostname: asset.hostname,
        macs,
        actor: params.actor,
        transport,
        deviceName: sighting.fortigateDevice,
      });
      targets.push({
        fortigateDevice: res.fortigateDevice,
        integrationId: integration.id,
        pushedMacs: res.pushedMacs,
        pushedAt: new Date().toISOString(),
        status: "synced",
      });
    } catch (err: any) {
      targets.push({
        fortigateDevice: sighting.fortigateDevice,
        integrationId: integration.id,
        pushedMacs: [],
        pushedAt: new Date().toISOString(),
        status: "failed",
        error: err?.message || "Quarantine push failed",
      });
    }
  }

  const succeeded = targets.filter((t) => t.status === "synced");
  const failed = targets.filter((t) => t.status === "failed");

  if (succeeded.length === 0) {
    // Nothing landed — do not flip status. Surface the worst error.
    const firstError = failed[0]?.error || "No FortiGates could be reached";
    await logEvent({
      action: "asset.quarantine.failed",
      resourceType: "asset",
      resourceId: asset.id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor: params.actor,
      level: "error",
      message: `Quarantine failed for ${asset.hostname || asset.id}: 0/${targets.length} FortiGate(s) accepted the push`,
      details: { targets },
    });
    throw new AppError(
      502,
      `Quarantine failed: 0/${targets.length} FortiGate(s) accepted the push. First error: ${firstError}`,
    );
  }

  // Stamp the new state. Preserve the prior status so release can pop back.
  // If the asset is already quarantined, don't overwrite statusBeforeQuarantine
  // (this can happen on auto-quarantine extending an existing quarantine).
  const newStatusBefore =
    asset.status === "quarantined" ? asset.statusBeforeQuarantine : asset.status;
  // Park `monitored` alongside the status. Quarantined is one of the statuses
  // that cannot be monitor-enabled (the clamp in db.ts turns polling off on
  // this very write, since every probe against an isolated device fails BY
  // DESIGN), so without the park a release would hand the device back to the
  // network unwatched. Same re-quarantine guard as the status above.
  const newMonitoredBefore =
    asset.status === "quarantined" ? asset.monitoredBeforeQuarantine : asset.monitored;
  const now = new Date();

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      status: "quarantined",
      statusChangedAt: now,
      statusChangedBy: params.actor,
      statusBeforeQuarantine: newStatusBefore,
      monitoredBeforeQuarantine: newMonitoredBefore ?? null,
      quarantineReason: params.reason || asset.quarantineReason || null,
      quarantinedAt: asset.quarantinedAt ?? now,
      quarantinedBy: params.actor,
      quarantineTargets: mergeQuarantineTargets(asset.quarantineTargets, targets, tokenScope) as any,
    },
  });

  const message =
    failed.length === 0
      ? `Quarantine succeeded for ${asset.hostname || asset.id}: ${succeeded.length}/${targets.length} FortiGate(s)`
      : `Quarantine partial for ${asset.hostname || asset.id}: ${succeeded.length}/${targets.length} FortiGate(s) accepted, ${failed.length} failed`;

  await logEvent({
    action: failed.length === 0 ? "asset.quarantine.succeeded" : "asset.quarantine.partial",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || asset.ipAddress || undefined,
    actor: params.actor,
    level: failed.length === 0 ? "info" : "warning",
    message,
    details: { reason: params.reason, targets, macs },
  });

  return {
    assetId: asset.id,
    status: "quarantined",
    targets,
    succeededCount: succeeded.length,
    failedCount: failed.length,
    message,
  };
}

export interface ReleaseQuarantineParams {
  assetId: string;
  actor: string;
  // See QuarantineAssetParams.tokenIntegrationIds. For release, we refuse
  // outright if the existing quarantine touches integrations outside the
  // token's scope — partial release would leave the asset's status flipped
  // back to active in Polaris while orphan entries linger on the out-of-
  // scope gateways. Session/system callers leave this undefined.
  tokenIntegrationIds?: string[];
}

export interface ReleaseQuarantineResult {
  assetId: string;
  newStatus: string;
  unpushedFrom: string[];
  failedToUnpush: Array<{ fortigateDevice: string; error: string }>;
  message: string;
}

/**
 * Release an asset's quarantine. Best-effort unpush from every recorded
 * target — a device-side failure is logged as a warning but does not block
 * the status flip. The asset's status is restored from
 * statusBeforeQuarantine (defaulting to "active" if null).
 */
export async function releaseQuarantine(
  params: ReleaseQuarantineParams,
): Promise<ReleaseQuarantineResult> {
  const asset = await prisma.asset.findUnique({ where: { id: params.assetId } });
  if (!asset) throw new AppError(404, `Asset ${params.assetId} not found`);

  if (asset.status !== "quarantined") {
    throw new AppError(409, `Asset ${asset.hostname || asset.id} is not currently quarantined`);
  }

  const recordedTargets = Array.isArray(asset.quarantineTargets)
    ? (asset.quarantineTargets as unknown as QuarantineTargetRecord[])
    : [];

  // Token-scope guard: refuse partial release.
  if (params.tokenIntegrationIds) {
    const allowed = new Set(params.tokenIntegrationIds);
    const outside = recordedTargets.filter((t) => !allowed.has(t.integrationId));
    if (outside.length > 0) {
      const names = Array.from(new Set(outside.map((t) => t.fortigateDevice))).join(", ");
      throw new AppError(
        403,
        `Quarantine for ${asset.hostname || asset.id} touches FortiGate(s) ${names} on integrations this token is not allowed to operate against — release must be performed by an admin or a token covering all targets`,
      );
    }
  }

  // Group by integrationId so we load each integration once.
  const integrationIds = new Set(recordedTargets.map((t) => t.integrationId).filter(Boolean));
  const integrations = await prisma.integration.findMany({
    where: { id: { in: Array.from(integrationIds) } },
  });
  const integrationById = new Map(integrations.map((i) => [i.id, i]));

  const unpushedFrom: string[] = [];
  const failedToUnpush: Array<{ fortigateDevice: string; error: string }> = [];

  for (const target of recordedTargets) {
    const integration = integrationById.get(target.integrationId);
    if (!integration) {
      // Integration was deleted while quarantine was active — record as a
      // soft failure so the operator knows there may be an orphan target.
      failedToUnpush.push({
        fortigateDevice: target.fortigateDevice,
        error: "Integration no longer exists — possible orphan quarantine entry on device",
      });
      continue;
    }
    try {
      const transport = await buildTransportForIntegration(
        integration as { id: string; type: string; config: unknown },
        target.fortigateDevice,
      );
      const res = await unpushQuarantineFromFortigate({
        assetId: asset.id,
        transport,
      });
      // Either removed or alreadyAbsent counts as success — both mean the
      // device no longer has the target.
      void res;
      unpushedFrom.push(target.fortigateDevice);
    } catch (err: any) {
      failedToUnpush.push({
        fortigateDevice: target.fortigateDevice,
        error: err?.message || "Unpush failed",
      });
    }
  }

  // Pop status back. statusBeforeQuarantine null → restore to active (the
  // asset was somehow quarantined without a prior-status snapshot, e.g.
  // hand-imported data; "active" is a safe default).
  const restoredStatus = asset.statusBeforeQuarantine ?? "active";
  // Pop `monitored` back with the status. null (never parked, or the asset
  // wasn't monitored when it was quarantined) restores to not-monitored, which
  // is also the pre-column behaviour. Staged in the SAME write as the status
  // so the db.ts clamp sees the restored status rather than "quarantined" and
  // lets the flag through.
  const restoredMonitored = asset.monitoredBeforeQuarantine === true;
  const now = new Date();

  await prisma.asset.update({
    where: { id: asset.id },
    data: {
      status: restoredStatus,
      monitored: restoredMonitored,
      statusChangedAt: now,
      statusChangedBy: params.actor,
      statusBeforeQuarantine: null,
      monitoredBeforeQuarantine: null,
      quarantineReason: null,
      quarantinedAt: null,
      quarantinedBy: null,
      quarantineTargets: [] as any,
    },
  });

  const message = failedToUnpush.length === 0
    ? `Quarantine released for ${asset.hostname || asset.id}: unpushed from ${unpushedFrom.length} FortiGate(s)`
    : `Quarantine released for ${asset.hostname || asset.id}: unpushed from ${unpushedFrom.length}, ${failedToUnpush.length} failed (orphan entries may remain on those devices)`;

  await logEvent({
    action: "asset.quarantine.released",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || asset.ipAddress || undefined,
    actor: params.actor,
    level: failedToUnpush.length === 0 ? "info" : "warning",
    message,
    details: { restoredStatus, unpushedFrom, failedToUnpush },
  });

  if (failedToUnpush.length > 0) {
    await logEvent({
      action: "asset.quarantine.unpush.failed",
      resourceType: "asset",
      resourceId: asset.id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor: params.actor,
      level: "warning",
      message: `Quarantine release: ${failedToUnpush.length} FortiGate(s) could not be unpushed — possible orphan entries`,
      details: { failedToUnpush },
    });
  }

  return {
    assetId: asset.id,
    newStatus: restoredStatus,
    unpushedFrom,
    failedToUnpush,
    message,
  };
}

/**
 * Drift check for a single asset: re-verify each recorded target. Returns
 * the updated quarantineTargets[] with any "synced" entries flipped to
 * "drift" if the device no longer holds the target / required MACs.
 * Caller is responsible for persisting the result.
 */
export async function verifyAssetQuarantine(
  assetId: string,
  tokenIntegrationIds?: string[],
): Promise<{
  targets: QuarantineTargetRecord[];
  driftDetected: boolean;
}> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { macAddressRows: { select: { mac: true, macEnd: true } } },
  });
  if (!asset) throw new AppError(404, `Asset ${assetId} not found`);

  const macs = macsForAsset(asset);
  const recordedTargets = Array.isArray(asset.quarantineTargets)
    ? (asset.quarantineTargets as unknown as QuarantineTargetRecord[])
    : [];

  if (tokenIntegrationIds) {
    const allowed = new Set(tokenIntegrationIds);
    const outside = recordedTargets.filter((t) => !allowed.has(t.integrationId));
    if (outside.length > 0) {
      const names = Array.from(new Set(outside.map((t) => t.fortigateDevice))).join(", ");
      throw new AppError(
        403,
        `Quarantine for ${asset.hostname || asset.id} touches FortiGate(s) ${names} on integrations this token is not allowed to read`,
      );
    }
  }

  const integrationIds = new Set(recordedTargets.map((t) => t.integrationId).filter(Boolean));
  const integrations = await prisma.integration.findMany({
    where: { id: { in: Array.from(integrationIds) } },
  });
  const integrationById = new Map(integrations.map((i) => [i.id, i]));

  let driftDetected = false;
  const updated: QuarantineTargetRecord[] = [];

  for (const target of recordedTargets) {
    const integration = integrationById.get(target.integrationId);
    if (!integration) {
      updated.push(target); // Can't verify — preserve existing record
      continue;
    }
    try {
      const transport = await buildTransportForIntegration(
        integration as { id: string; type: string; config: unknown },
        target.fortigateDevice,
      );
      const v = await verifyQuarantineOnFortigate({
        assetId: asset.id,
        desiredMacs: macs,
        transport,
      });
      if (target.status === "synced" && !v.present) {
        driftDetected = true;
        updated.push({ ...target, status: "drift", error: `Missing MACs on device: ${v.missingMacs.join(", ") || "(target absent)"}` });
      } else {
        updated.push(target);
      }
    } catch {
      // Verify itself failed — leave the existing record alone (don't flip to drift on a transport error).
      updated.push(target);
    }
  }

  return { targets: updated, driftDetected };
}
