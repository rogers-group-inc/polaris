/**
 * src/db.ts — Prisma client singleton
 *
 * Import `prisma` from this module instead of instantiating PrismaClient
 * directly, so the connection pool is shared across the process.
 *
 * The extended client wraps every write so that:
 *   1. Any write to Asset.manufacturer or MibFile.manufacturer is run
 *      through normalizeManufacturer() before hitting the DB. The map is
 *      empty at module load — manufacturerAliasService.refreshAliasCache()
 *      populates it during app startup, so any pre-cache write falls
 *      through unchanged (which is fine: the startup backfill cleans up
 *      anything written before the cache loaded).
 *   2. Every asset.create / asset.update that sets ipAddress also records
 *      the IP in asset_ip_history (one row per assetId+ip). When the
 *      source changes (e.g. IP moves to a different FortiGate) firstSeen
 *      is reset so first/last seen reflect the current source rather than
 *      the original one.
 *   3. Asset writes that touch identity-relevant fields (assetTag, tags,
 *      discoveredByIntegrationId) shadow-write to asset_sources via the
 *      phase-1 derivation rules. Discovery hasn't cut over to writing
 *      AssetSource directly yet (phase 2), so this keeps the table fresh
 *      for new/edited assets between backfill runs at startup.
 *   4. Asset update/upsert writes that stage `hostname` without touching
 *      `hostnameOverride` are checked against the row's operator hostname
 *      override and rewritten to it when set — discovery projection writes
 *      can never clobber an operator pin. Writes staging `ipAddress` without
 *      touching `ipOverride` get the same guard with discovery-gets-a-vote
 *      semantics (enforceOperatorOverrides): a staged IP equal to the
 *      override releases the pin in the same write; a different staged IP is
 *      rewritten back to the override and an ip-override Conflict is raised
 *      (fire-and-forget, via ipOverrideService) for the operator to resolve.
 *      Asset.ipBlankPinned (an operator pin to NO address) is enforced the
 *      same way: a staged address is dropped and raises that conflict.
 *      The same read also enforces Asset.ipCleared (rule 40(j)): an address
 *      the operator blanked is dropped from a write re-staging it while
 *      another network-present asset still records it; any other staged
 *      address fills the blank and releases the hold.
 *   5. Asset writes staging `os` are run through normalizeOsInData() so a
 *      Windows 11 client stops being reported as "Windows 10" — the registry
 *      ProductName key every discovery source reads was frozen at "Windows
 *      10" when Windows 11 shipped, so the build number is the authority.
 *      Here for the same catch-all reason as the guards above: the projection
 *      normalizes its own output, but discoveryEngine's fortigate-endpoint
 *      path, the agents system-info route, conflictResolutionService and the
 *      assets PUT route all write `os` inline. See utils/osNormalize.ts.
 * The base client (_base) is reused for the history + source writes to
 * avoid a circular import.
 */

import { randomUUID } from "node:crypto";

import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { normalizeManufacturer } from "./utils/manufacturerNormalize.js";
import {
  applyHostnameOverride,
  applyIpBlankPin,
  applyIpCleared,
  applyIpOverride,
  stagedIpOf,
  statusAllowsMonitoring,
  UNMONITORABLE_STATUSES,
  type IpClearedOutcome,
  type IpOverrideOutcome,
} from "./utils/assetInvariants.js";
import { normalizeOsInData } from "./utils/osNormalize.js";
import { deriveAssetSources, type AssetSnapshot } from "./utils/assetSourceDerivation.js";
import { sealValue, openValue, isSealed } from "./utils/secretBox.js";
import {
  transformSecretFields,
  containsSecretField,
  RESULT_WALK_DEPTH,
} from "./utils/configSecretFields.js";

// Lazy-resolved to break the import cycle (dnsResolvedReservationService imports
// `prisma` from this file). The hooks below only invoke the service at runtime,
// not at module init, so a top-of-file dynamic import on first call is safe.
let _dnsResolvedSvcPromise: Promise<typeof import("./services/dnsResolvedReservationService.js")> | null = null;
function getDnsResolvedSvc() {
  if (!_dnsResolvedSvcPromise) {
    _dnsResolvedSvcPromise = import("./services/dnsResolvedReservationService.js");
  }
  return _dnsResolvedSvcPromise;
}
function fireDnsResolvedReconcile(assetId: string | undefined): void {
  if (!assetId) return;
  // Best-effort, fire-and-forget. Failures are swallowed inside the service.
  void (async () => {
    try {
      const svc = await getDnsResolvedSvc();
      await svc.reconcileDnsResolvedForAsset(assetId);
    } catch {
      /* swallowed — reconcile is best-effort */
    }
  })();
}
async function fireDnsResolvedRelease(assetId: string | undefined): Promise<void> {
  if (!assetId) return;
  try {
    const svc = await getDnsResolvedSvc();
    await svc.releaseDnsResolvedForAsset(assetId);
  } catch {
    // Best-effort — never block the delete.
  }
}

const g = globalThis as unknown as { prisma: any; _prismaBase: PrismaClient };

// Resolve the pg connection-pool size. The driver-adapter (`@prisma/adapter-pg`)
// runs queries through a `pg.Pool`, whose default `max` is 10 — undersized
// once you sum monitor workers + HTTP request handlers + background jobs at
// any meaningful asset count. `DATABASE_POOL_SIZE` lets operators raise it
// without editing code; the default of 25 is a safe step up that covers
// today's worker pool plus comfortable headroom for HTTP burst.
function resolveDatabasePoolSize(): number {
  const raw = process.env.DATABASE_POOL_SIZE;
  if (!raw) return 25;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return 25;
  return n;
}

function buildBaseClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL ?? "",
    max: resolveDatabasePoolSize(),
  });
  return new PrismaClient({ adapter });
}

// Shadow-write asset_sources from a freshly-written Asset row. Idempotent
// (per-source upsert on the (sourceKind, externalId) unique key). Best-effort:
// failures are swallowed so a transient table problem can't break the
// underlying asset write. Discovery cutover (phase 2) replaces this with
// integration-side writes.
async function shadowWriteAssetSources(base: PrismaClient, asset: any): Promise<void> {
  if (!asset?.id) return;
  const snapshot: AssetSnapshot = {
    id: String(asset.id),
    assetTag: asset.assetTag ?? null,
    tags: Array.isArray(asset.tags) ? asset.tags : [],
    discoveredByIntegrationId: asset.discoveredByIntegrationId ?? null,
    hostname: asset.hostname ?? null,
    ipAddress: asset.ipAddress ?? null,
    os: asset.os ?? null,
    osVersion: asset.osVersion ?? null,
    serialNumber: asset.serialNumber ?? null,
    manufacturer: asset.manufacturer ?? null,
    model: asset.model ?? null,
    assetType: asset.assetType ?? null,
    status: asset.status ?? null,
    learnedLocation: asset.learnedLocation ?? null,
    dnsName: asset.dnsName ?? null,
    latitude: typeof asset.latitude === "number" ? asset.latitude : null,
    longitude: typeof asset.longitude === "number" ? asset.longitude : null,
    acquiredAt: asset.acquiredAt ?? null,
    lastSeen: asset.lastSeen ?? null,
    createdBy: asset.createdBy ?? null,
  };
  const sources = deriveAssetSources(snapshot);
  if (sources.length === 0) return;
  const now = new Date();
  const seen = snapshot.lastSeen ?? now;
  for (const s of sources) {
    try {
      // The UPDATE path intentionally does NOT touch `observed` — once an
      // AssetSource row exists, its observed blob is owned by the discovery
      // path that writes the source explicitly (Phase 2). The shadow-write
      // here only refreshes metadata (assetId linkage, integrationId,
      // syncedAt, lastSeen) so it never downgrades a rich source-shaped blob
      // back to the simple tag-derived one.
      //
      // The CREATE path *does* write observed, since this is the first time
      // the row appears (e.g. a new Asset created before the discovery
      // cutover for its source kind). The next real discovery run replaces
      // it via explicit upsert.
      const updateData: Record<string, unknown> = {
        assetId: snapshot.id,
        syncedAt: now,
        lastSeen: seen,
      };
      if (!s.inferred) updateData.inferred = false;
      if (s.integrationId) updateData.integrationId = s.integrationId;

      await base.assetSource.upsert({
        where: { sourceKind_externalId: { sourceKind: s.sourceKind, externalId: s.externalId } },
        create: {
          assetId: snapshot.id,
          sourceKind: s.sourceKind,
          externalId: s.externalId,
          integrationId: s.integrationId,
          inferred: s.inferred,
          observed: s.observed as any,
          syncedAt: now,
          firstSeen: seen,
          lastSeen: seen,
        },
        update: updateData,
      });
    } catch {
      // Best-effort
    }
  }
}

// Quick gate: did the caller pass any field that affects source derivation?
// Avoids re-deriving on hot-path lastSeen / monitor-result writes.
function touchesAssetSources(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return "assetTag" in d || "tags" in d || "discoveredByIntegrationId" in d;
}

async function recordIpHistory(base: PrismaClient, assetId: string, ip: string, src: string) {
  // Single SQL upsert. Previously this was a findUnique-then-update-or-create
  // pair (two DB round-trips per Asset write that touched ipAddress). The
  // INSERT ... ON CONFLICT form below does the same work in one round-trip,
  // including the "reset firstSeen when source changes" logic via a CASE in
  // the UPDATE branch — discovery often re-asserts the same IP from the same
  // source, and the new statement reads as identical to the old behavior in
  // every case.
  //
  // The id column uses Prisma's @default(uuid()) which is generated client-
  // side; with raw SQL we generate it ourselves via node:crypto. The
  // generated UUID is only used when the row doesn't exist (CONFLICT path
  // ignores VALUES on the id column).
  //
  // Fire-and-forget — history is best-effort and the caller doesn't await.
  const now = new Date().toISOString();
  try {
    await base.$executeRawUnsafe(
      `INSERT INTO "asset_ip_history" ("id", "assetId", "ip", "source", "firstSeen", "lastSeen")
       VALUES ($1, $2, $3, $4, $5::timestamp, $5::timestamp)
       ON CONFLICT ("assetId", "ip") DO UPDATE SET
         "lastSeen" = EXCLUDED."lastSeen",
         "source" = EXCLUDED."source",
         "firstSeen" = CASE
           WHEN "asset_ip_history"."source" <> EXCLUDED."source" THEN EXCLUDED."firstSeen"
           ELSE "asset_ip_history"."firstSeen"
         END`,
      randomUUID(),
      assetId,
      ip,
      src,
      now,
    );
  } catch {
    // Best-effort; swallow errors so a transient DB issue can't break the
    // underlying Asset write.
  }
}

/**
 * Mutate args.data.manufacturer in place if present. Handles both single
 * data shapes ({manufacturer: "x"}) and Prisma's nested set/setNull form
 * ({manufacturer: {set: "x"}}). Empty/blank string is normalized to null.
 */
function normalizeManufacturerInData(data: any): void {
  if (!data || typeof data !== "object") return;
  if (!("manufacturer" in data)) return;
  const v = data.manufacturer;
  if (v === null || v === undefined) return;
  if (typeof v === "string") {
    data.manufacturer = normalizeManufacturer(v);
    return;
  }
  if (typeof v === "object" && "set" in v && typeof v.set === "string") {
    v.set = normalizeManufacturer(v.set);
  }
}

/**
 * Mutate args.data in place to enforce the "decommissioned/disabled assets
 * are not monitored" invariant. Whenever a write sets status to one of those
 * terminal-ish values, monitored is forced false and consecutiveFailures is
 * reset (matching the assets PUT route's existing behavior on manual disable
 * via validateMonitorConfig). Re-activation is left alone — flipping back to
 * "active" doesn't auto-resume monitoring; that's the operator's choice.
 *
 * Centralized here so every write path benefits: the assets PUT route, the
 * decommissionStaleAssets job, the integration FortiSwitch/FortiAP sweep,
 * and the Entra/AD syncs that flip status="disabled" on disabled accounts.
 */
function clampMonitoredForStatus(data: any): void {
  if (!data || typeof data !== "object") return;
  if (!("status" in data)) return;
  if (statusAllowsMonitoring(unwrapSet(data.status))) return;
  data.monitored = false;
  data.consecutiveFailures = 0;
}

/** Read the plain value out of either data shape Prisma accepts —
 *  `field: v` or the nested `field: { set: v }`. */
function unwrapSet(v: unknown): unknown {
  if (v && typeof v === "object" && "set" in (v as Record<string, unknown>)) {
    return (v as Record<string, unknown>).set;
  }
  return v;
}

/** Is this write turning monitoring ON? */
function stagesMonitoredOn(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  if (!("monitored" in d)) return false;
  return unwrapSet(d.monitored) === true;
}

/**
 * The OTHER direction of business rule 10: a write that turns monitoring ON
 * without saying anything about `status` has to be checked against the status
 * the row already carries, or every unmonitorable state (decommissioned /
 * disabled / storage / quarantined) is one `monitored: true` away from being
 * polled again — which is exactly the shape of the operator toggle, the
 * discovery monitored-sweep and the bulk-monitor endpoint.
 *
 * The read only fires when the write stages `monitored: true` WITHOUT a
 * `status`, so the monitor hot paths (probe results, lastSeen bumps, telemetry
 * anchors) never pay it — none of them touch `monitored`. A write that stages
 * BOTH is already covered by clampMonitoredForStatus above.
 *
 * Best-effort: a failed read leaves the write alone rather than failing it.
 * The boot sweep (jobs/clampMonitoredForStatus.ts) mops up any drift.
 */
async function enforceMonitorableStatus(base: PrismaClient, where: unknown, data: unknown): Promise<void> {
  if (!stagesMonitoredOn(data)) return;
  const d = data as Record<string, unknown>;
  if ("status" in d) return;
  try {
    const row = await base.asset.findFirst({ where: where as any, select: { status: true } });
    if (!row || statusAllowsMonitoring(row.status)) return;
    d.monitored = false;
    d.consecutiveFailures = 0;
  } catch {
    // Best-effort — see doc comment.
  }
}

/**
 * updateMany can't be resolved to one row, so the guard narrows the WHERE
 * instead: an unmonitorable row is excluded from the statement entirely rather
 * than updated with `monitored` quietly rewritten. Callers that need to tell
 * an operator WHICH rows were skipped filter the ids themselves first (see
 * POST /assets/bulk-monitor) — this is the backstop, not the message.
 */
function narrowUpdateManyForMonitorable(args: any): void {
  if (!stagesMonitoredOn(args?.data)) return;
  if (args.data && typeof args.data === "object" && "status" in args.data) return;
  const guard = { status: { notIn: UNMONITORABLE_STATUSES } };
  args.where = args.where ? { AND: [args.where, guard] } : guard;
}

/**
 * Result of the pre-write override enforcement, handed back so the hook can
 * fire the IP-override follow-ups (conflict raise / release audit) only
 * AFTER the guarded write actually lands.
 */
interface OperatorOverrideOutcome {
  ip: IpOverrideOutcome;
  /** The ipSource the writer originally staged, captured before the
   *  re-assertion rewrote it to "manual" — conflict provenance. */
  stagedIpSource: string | null;
  /** Rule 40(j): what the operator-blanked address did to this write. */
  cleared?: IpClearedOutcome;
}

/**
 * Enforce the operator overrides (Asset.hostnameOverride / Asset.ipOverride)
 * on a pending update/upsert. Centralized here (like clampMonitoredForStatus)
 * so every discovery projection write path — integrations, agents, FMG
 * service, merge/split endpoints — respects the pins without each writer
 * knowing about them. The row read only fires when the write stages
 * `hostname` WITHOUT touching `hostnameOverride` and/or `ipAddress` WITHOUT
 * touching `ipOverride` (the operator set/clear paths are authoritative), so
 * the monitor hot paths (probe results, lastSeen bumps) never pay it;
 * hostname/IP-carrying writes are discovery-cadence, where the extra indexed
 * point read is in the same budget as the drift-detection reads that already
 * follow them — and both pins share the single read. updateMany is
 * deliberately not guarded — no current writer stages hostname or ipAddress
 * through it (re-verified 2026-07); add the guard if one appears.
 *
 * The hostname pin is absolute (always re-asserted). The IP pin gives
 * discovery a vote via applyIpOverride: matching IP → the pin is released in
 * this same write; different IP → re-asserted, and the returned outcome
 * tells the hook to raise an ip-override Conflict once the write lands.
 *
 * Best-effort: a failed read skips the rewrite rather than failing the write.
 * Self-healing — projection re-stages the fields every discovery cycle, so
 * the next guarded write re-applies the pins.
 */
async function enforceOperatorOverrides(
  base: PrismaClient,
  where: unknown,
  data: unknown,
): Promise<OperatorOverrideOutcome | null> {
  const d = data as Record<string, unknown> | undefined;
  if (!d || typeof d !== "object") return null;
  const guardHostname = "hostname" in d && !("hostnameOverride" in d);
  const guardIp = "ipAddress" in d && !("ipOverride" in d) && !("ipBlankPinned" in d);
  if (!guardHostname && !guardIp) return null;
  try {
    const row = await base.asset.findFirst({
      where: where as any,
      select: { id: true, hostnameOverride: true, ipOverride: true, ipBlankPinned: true, ipCleared: true },
    });
    if (guardHostname) applyHostnameOverride(d, row?.hostnameOverride);
    if (guardIp) {
      const srcRaw = d.ipSource;
      const stagedIpSource =
        typeof srcRaw === "string"
          ? srcRaw
          : (srcRaw && typeof srcRaw === "object" && typeof (srcRaw as any).set === "string" ? (srcRaw as any).set : null);
      // The operator pinned the asset to NO address: a discovered address is
      // dropped and raises the same ip-override conflict an address pin does.
      const blank = applyIpBlankPin(d, row?.ipBlankPinned);
      if (blank.action !== "none") return { ip: blank, stagedIpSource };
      const ip = applyIpOverride(d, row?.ipOverride);
      if (ip.action !== "none") return { ip, stagedIpSource };
      // Business rule 40(j): an operator-blanked address. The "is it still
      // contested" read only fires when the write re-stages the blanked
      // address, which for a cleared row is the offline device's stale lease
      // — rare, and discovery-cadence.
      if (row?.ipCleared && !row.ipOverride) {
        const staged = stagedIpOf(d);
        let contested = false;
        if (staged && staged === row.ipCleared.trim()) {
          const holder = await base.asset.findFirst({
            where: {
              id: { not: row.id },
              ipAddress: staged,
              status: { notIn: UNMONITORABLE_STATUSES as any },
            },
            select: { id: true },
          });
          contested = !!holder;
        }
        const cleared = applyIpCleared(d, row.ipCleared, contested);
        if (cleared.action !== "none") return { ip, stagedIpSource, cleared };
      }
    }
  } catch {
    // Best-effort — see doc comment.
  }
  return null;
}

// Fire-and-forget follow-ups for the IP-override guard, lazily importing the
// service to break the import cycle (ipOverrideService imports `prisma` from
// this file) — same pattern as the dns_resolved reconcile above. Failures are
// logged and swallowed inside the service.
function fireIpOverrideFollowUp(outcome: OperatorOverrideOutcome, assetId: string | undefined): void {
  if (!assetId) return;
  void (async () => {
    try {
      const svc = await import("./services/ipOverrideService.js");
      const cleared = outcome.cleared;
      if (cleared && (cleared.action === "filled" || cleared.action === "returned")) {
        await svc.handleIpClearedReleased(assetId, cleared.ip, cleared.action);
        return;
      }
      if (outcome.ip.action === "released") {
        await svc.handleIpOverrideReleased(assetId, outcome.ip.ip);
      } else if (outcome.ip.action === "reasserted" && outcome.ip.discoveredIp) {
        // A staged clear (discoveredIp null) is not a disagreement — the pin
        // was re-asserted silently, no conflict.
        await svc.raiseIpOverrideConflict(assetId, outcome.ip.discoveredIp, outcome.stagedIpSource);
      }
    } catch {
      /* swallowed — follow-up is best-effort */
    }
  })();
}

// ─── Secret-at-rest layer ───────────────────────────────────────────────────
//
// Seals secret JSON fields on the way into the database and opens them on the
// way out, for Credential.config / Integration.config /
// NotificationChannel.config / Setting.value. See utils/secretBox.ts for the
// threat model (plaintext credentials in every pg_dump) and
// utils/configSecretFields.ts for which keys are covered and why the key set is
// a name union rather than per-type lists.
//
// This lives in the Prisma extension for the same reason the hostnameOverride
// and clampMonitoredForStatus guards do: it is the ONE seam every caller passes
// through. Several route files still read `prisma.credential.findUnique` and
// `prisma.integration.findUnique` inline (see the interim-state note in
// polaris-business-rules, rule 20b), and encrypting at the service layer would have left those reading
// ciphertext. Raw SQL bypasses this — the only raw reader of these columns is
// monitorOverrideService's `integrations.config #>> '{…,addAsMonitored}'`, which
// touches no secret field.
//
// Writes are sealed; reads are opened. `openValue` passes plaintext through
// unchanged, so an install mid-backfill (or with no key at all) works exactly as
// before.

function sealArgsData(data: unknown, jsonField: "config" | "value"): void {
  if (!data || typeof data !== "object") return;
  // Array form: createMany({ data: [...] }).
  if (Array.isArray(data)) {
    for (const row of data) sealArgsData(row, jsonField);
    return;
  }
  const d = data as Record<string, unknown>;
  const blob = d[jsonField];
  if (blob === undefined || blob === null) return;
  // A `{ set: … }` JSON-field wrapper is valid Prisma input; unwrap it.
  if (typeof blob === "object" && !Array.isArray(blob) && "set" in (blob as Record<string, unknown>)) {
    const inner = (blob as Record<string, unknown>).set;
    d[jsonField] = { set: transformSecretFields(inner, sealValue) };
    return;
  }
  d[jsonField] = transformSecretFields(blob, sealValue);
}

function openResultRows(result: unknown, jsonField: "config" | "value"): unknown {
  if (Array.isArray(result)) return result.map((r) => openResultRows(r, jsonField));
  if (!result || typeof result !== "object") return result;
  const row = result as Record<string, unknown>;
  if (!(jsonField in row)) return result;
  const blob = row[jsonField];
  if (blob === undefined || blob === null) return result;
  return { ...row, [jsonField]: transformSecretFields(blob, openValue) };
}

/**
 * Open every sealed secret anywhere in a query RESULT, at any nesting depth.
 *
 * The per-model hooks below only fire for TOP-LEVEL operations on their model —
 * that is how Prisma query extensions work, and it is not configurable. A
 * relation read pulls the same rows without ever entering them:
 *
 *   prisma.asset.findUnique({ include: { monitorCredential: true } })
 *
 * runs the `asset` hooks, never the `credential` ones, so `monitorCredential.
 * config.community` comes back as ciphertext. That is not a corner case here —
 * it is how the monitor hot path loads every credential it polls with, how
 * reservation push loads the FortiGate API token, and how description sync loads
 * its integration. Sealing those columns therefore broke SNMP / WinRM / SSH /
 * FortiOS polling and DHCP push on the first install that set POLARIS_SECRET_KEY,
 * while the surfaces that read a credential top-level (the SNMP Walk tab, the
 * credential Test button, discovery) kept working — which is exactly the shape
 * the field report had.
 *
 * So the open pass runs over the whole result of every operation, on every
 * model, rather than per-model. Correctness here cannot depend on remembering to
 * register a model, or on nobody adding an `include` later.
 *
 * Cost: a read-only `containsSecretField` pre-scan (no allocation) on each
 * result, and a rebuild only when something sealed is actually present — which
 * is never, for the sample and asset queries that dominate the hot loops.
 *
 * `openValue` passes plaintext through and never throws, so this stays a no-op
 * on an un-keyed install and degrades to an empty secret on a key mismatch.
 */
function openNestedSecrets<T>(result: T): T {
  if (!result || typeof result !== "object") return result;
  if (!containsSecretField(result, isSealed)) return result;
  return transformSecretFields(result, openValue, 0, RESULT_WALK_DEPTH) as T;
}

// The remaining hooks below are registered PER MODEL rather than via
// `$allModels.$allOperations`, because they seal WRITE ARGUMENTS and so have to
// know which JSON column of which model they are looking at. The read-side open
// pass is the opposite case — it is a property of the result, not of the model —
// and is registered once for all models in `secretOpenExtension` below.

type Hook = { args: any; query: (args: any) => Promise<any> };

/** The seal-on-write / open-on-read hook set for one secret-bearing model. */
function secretHooks(jsonField: "config" | "value") {
  const seal = (data: unknown) => sealArgsData(data, jsonField);
  const open = (result: unknown) => openResultRows(result, jsonField);
  return {
    async create({ args, query }: Hook) { seal(args?.data); return open(await query(args)); },
    async createMany({ args, query }: Hook) { seal(args?.data); return query(args); },
    async update({ args, query }: Hook) { seal(args?.data); return open(await query(args)); },
    async updateMany({ args, query }: Hook) { seal(args?.data); return query(args); },
    async upsert({ args, query }: Hook) {
      seal(args?.create);
      seal(args?.update);
      return open(await query(args));
    },
    async findUnique({ args, query }: Hook) { return open(await query(args)); },
    async findUniqueOrThrow({ args, query }: Hook) { return open(await query(args)); },
    async findFirst({ args, query }: Hook) { return open(await query(args)); },
    async findFirstOrThrow({ args, query }: Hook) { return open(await query(args)); },
    async findMany({ args, query }: Hook) { return open(await query(args)); },
    async delete({ args, query }: Hook) { return open(await query(args)); },
  };
}

/**
 * The all-models read-side open pass, as its OWN `$extends` layer.
 *
 * Kept separate from the per-model extension below so composition is
 * unambiguous: Prisma runs both layers, rather than leaving it to precedence
 * rules between `$allModels` and a specific model key inside one extension. The
 * two overlap only on the four secret-bearing models, where opening twice is a
 * no-op (`openValue` passes plaintext through).
 */
function _applySecretOpen(base: PrismaClient) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          return openNestedSecrets(await query(args));
        },
      },
    },
  });
}

function _buildClient(base: PrismaClient) {
  return _applySecretOpen(base).$extends({
    query: {
      // Secret-at-rest coverage. Must stay in step with SECRET_BEARING_MODELS /
      // secretJsonFieldFor() in utils/configSecretFields.ts, which is what the
      // backfill job walks — a model listed there but missing here would have
      // its existing rows sealed by the backfill and then never opened on read.
      // The tests in tests/unit/secretsAtRest.test.ts assert the two agree.
      credential: secretHooks("config"),
      integration: secretHooks("config"),
      notificationChannel: secretHooks("config"),
      setting: secretHooks("value"),
      asset: {
        async create({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          normalizeOsInData(args?.data);
          clampMonitoredForStatus(args?.data);
          const result = await query(args);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            recordIpHistory(base, (result as any).id, ip, src);
          }
          // Shadow-write asset_sources from the new row. Always fires on
          // create; on update we gate by touchesAssetSources() to skip the
          // re-derive on hot-path writes.
          shadowWriteAssetSources(base, result);
          // dns_resolved reservation auto-reconcile (fire-and-forget).
          fireDnsResolvedReconcile((result as any)?.id);
          return result;
        },
        async update({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          normalizeOsInData(args?.data);
          clampMonitoredForStatus(args?.data);
          await enforceMonitorableStatus(base, args?.where, args?.data);
          const overrideOutcome = await enforceOperatorOverrides(base, args?.where, args?.data);
          const result = await query(args);
          if (overrideOutcome) fireIpOverrideFollowUp(overrideOutcome, (result as any)?.id);
          const d = args.data as Record<string, unknown> | undefined;
          const ip = typeof d?.ipAddress === "string" ? d.ipAddress : undefined;
          if (ip) {
            const src = typeof d?.ipSource === "string" ? d.ipSource : "manual";
            recordIpHistory(base, (result as any).id, ip, src);
          }
          if (touchesAssetSources(d)) {
            shadowWriteAssetSources(base, result);
          }
          // Only re-run the dns_resolved reconcile when the write could have
          // changed eligibility: ipAddress / status / hostname / dnsName /
          // macAddress. Skips the hot monitor-result path that writes only
          // lastMonitorAt / monitorStatus / counters.
          if (
            d && (
              "ipAddress" in d || "status" in d || "hostname" in d ||
              "dnsName" in d || "macAddress" in d
            )
          ) {
            fireDnsResolvedReconcile((result as any)?.id);
          }
          return result;
        },
        async updateMany({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          normalizeOsInData(args?.data);
          clampMonitoredForStatus(args?.data);
          narrowUpdateManyForMonitorable(args);
          // updateMany: skip shadow-write. Rare on identity fields, and the
          // backfill job sweeps any drift on next startup. Same logic for the
          // dns_resolved reconcile — the periodic job catches drift.
          return query(args);
        },
        async upsert({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.create);
          normalizeManufacturerInData(args?.update);
          normalizeOsInData(args?.create);
          normalizeOsInData(args?.update);
          clampMonitoredForStatus(args?.create);
          clampMonitoredForStatus(args?.update);
          await enforceMonitorableStatus(base, args?.where, args?.update);
          // Create branch needs no guard — a brand-new row can't carry an
          // override; the read is a no-op miss when the row doesn't exist.
          const overrideOutcome = await enforceOperatorOverrides(base, args?.where, args?.update);
          const result = await query(args);
          if (overrideOutcome) fireIpOverrideFollowUp(overrideOutcome, (result as any)?.id);
          const updateTouches = touchesAssetSources(args?.update);
          // Always fires after a create branch (we can't tell from the
          // result alone which branch ran, so we re-derive when the inputs
          // could have produced an identity change in either case).
          if (touchesAssetSources(args?.create) || updateTouches) {
            shadowWriteAssetSources(base, result);
          }
          // Conservative: always re-run reconcile after upsert — we don't
          // know which branch ran and the eligibility-relevant fields are
          // likely to be present in at least one of create/update.
          fireDnsResolvedReconcile((result as any)?.id);
          return result;
        },
        async delete({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          // Release any owned dns_resolved reservations BEFORE the delete
          // cascades so we still have the asset's hostname/MAC to find them.
          const id = typeof args?.where?.id === "string" ? args.where.id : undefined;
          await fireDnsResolvedRelease(id);
          return query(args);
        },
      },
      mibFile: {
        async create({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          return query(args);
        },
        async update({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          return query(args);
        },
        async updateMany({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.data);
          return query(args);
        },
        async upsert({ args, query }: { args: any; query: (args: any) => Promise<any> }) {
          normalizeManufacturerInData(args?.create);
          normalizeManufacturerInData(args?.update);
          return query(args);
        },
      },
    },
  });
}

const _base: PrismaClient = g._prismaBase ?? buildBaseClient();
export const prisma: ReturnType<typeof _buildClient> = g.prisma ?? _buildClient(_base);

/**
 * The UNEXTENDED client. Almost nothing should use this — the extension carries
 * real invariants (operator overrides, monitored clamping, manufacturer
 * normalization, secret-at-rest sealing), and bypassing it bypasses those.
 *
 * The one legitimate caller is the secret-encryption backfill, which has to see
 * the RAW stored value to decide whether a row still holds plaintext: reading
 * through the extension would hand it decrypted strings and it could never tell
 * a sealed row from an unsealed one.
 */
export const prismaBase: PrismaClient = _base;

if (process.env.NODE_ENV !== "production") {
  g._prismaBase = _base;
  g.prisma = prisma;
}
