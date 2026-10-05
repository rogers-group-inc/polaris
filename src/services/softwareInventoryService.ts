// softwareInventoryService — installed software per asset (the asset view's
// Software tab). One table, AssetSoftware, with three writers that each own
// only their own `source` rows:
//
//   agent  — the agent's softwareInventory stream (Windows Uninstall keys,
//            dpkg / rpm), pushed every six hours;
//   intune — Intune detected apps, read per device during an Entra/Intune
//            discovery run when the integration's pullSoftware is on;
//   arc    — Azure Change Tracking's software inventory, read from Log
//            Analytics during an Azure Arc discovery run.
//
// Every write is a DELTA (utils/inventoryDelta) in one transaction, like the
// service and process inventories: a reader sees the old list or the new one,
// never a mix, and a list that did not change costs one read. Freshness per
// source is AssetInventoryScrape (kind "software" / "software:intune" /
// "software:arc"), never a row's updatedAt.
//
// The read side does not merge sources: the tab shows one source at a time and
// prefers the agent (it reads the host directly, on its own cadence), then
// Intune, then Arc.
import { randomUUID } from "node:crypto";

import { prisma } from "../db.js";
import { retryOnDeadlock } from "../utils/dbRetry.js";
import { AppError } from "../utils/errors.js";
import { diffInventory, sameFields } from "../utils/inventoryDelta.js";
import {
  fetchIntuneDetectedApps,
  type DiscoveredEntraDevice,
  type EntraDiscoveryProgressCallback,
  type EntraIdConfig,
  type IntuneDetectedApp,
} from "./entraIdService.js";
import { fetchArcSoftware, type ArcDiscoveryProgressCallback, type ArcSoftwareRow, type AzureArcConfig } from "./azureArcService.js";

export type SoftwareSource = "agent" | "intune" | "arc";
/** Display and preference order: the first source an asset has is shown first. */
export const SOFTWARE_SOURCES: readonly SoftwareSource[] = ["agent", "intune", "arc"];

/** The AssetInventoryScrape kind that stamps one source's list. */
export function softwareScrapeKind(source: SoftwareSource): string {
  return source === "agent" ? "software" : `software:${source}`;
}

export interface AssetSoftwareInput {
  name:         string;
  version:      string | null;
  publisher:    string | null;
  architecture: string | null;
  platform:     string | null;
  /** YYYY-MM-DD; anything else is stored as null. */
  installDate:  string | null;
  sizeBytes:    bigint | null;
}

const KEY_SEP = "\u001f";

/**
 * A row's identity within (asset, source): name, version and architecture,
 * case-insensitive. Two versions of a program, or its x86 and x64 builds, are
 * two rows; the same program reported twice is one. Pure.
 */
export function softwareKey(r: Pick<AssetSoftwareInput, "name" | "version" | "architecture">): string {
  return [r.name, r.version ?? "", r.architecture ?? ""].map((s) => s.trim().toLowerCase()).join(KEY_SEP);
}

const SOFTWARE_FIELDS = ["name", "version", "publisher", "architecture", "platform", "installDate", "sizeBytes"] as const;
type SoftwareRow = { key: string } & { [K in (typeof SOFTWARE_FIELDS)[number]]: unknown };

function clip(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  const t = s.trim();
  return t ? t.slice(0, max) : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD → a UTC-midnight Date (what a @db.Date column reads back as). */
function toDateOnly(s: string | null): Date | null {
  if (!s || !DATE_RE.test(s)) return null;
  const d = new Date(`${s}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : d;
}

/** An input row as it will be STORED. Exported for the tests. */
export function storedSoftwareRow(r: AssetSoftwareInput) {
  const name = clip(r.name, 512) ?? "";
  const version = clip(r.version, 255);
  const architecture = clip(r.architecture, 32);
  return {
    key: softwareKey({ name, version, architecture }),
    name,
    version,
    publisher: clip(r.publisher, 255),
    architecture,
    platform: clip(r.platform, 32),
    installDate: toDateOnly(r.installDate),
    sizeBytes: r.sizeBytes != null && r.sizeBytes > 0n ? r.sizeBytes : null,
  };
}

function pickSoftwareFields(r: ReturnType<typeof storedSoftwareRow>) {
  return {
    name: r.name,
    version: r.version,
    publisher: r.publisher,
    architecture: r.architecture,
    platform: r.platform,
    installDate: r.installDate,
    sizeBytes: r.sizeBytes,
  };
}

/**
 * One source's installed-software list for one asset, written as a delta: in
 * one transaction, read the asset's rows for this source, create what
 * appeared, delete what vanished, update what changed, and stamp the scrape
 * (with the source's own version `stamp` when it has one). An empty `rows` is
 * a real answer — everything this source reported is gone. Callers must not
 * pass an empty list for a FAILED read; they skip the call instead.
 */
export async function persistAssetSoftware(
  assetId: string,
  source: SoftwareSource,
  rows: AssetSoftwareInput[],
  opts: { now?: Date; stamp?: string | null } = {},
): Promise<{ created: number; updated: number; removed: number; unchanged: number }> {
  const now = opts.now ?? new Date();
  const kind = softwareScrapeKind(source);
  const incoming = rows.map(storedSoftwareRow).filter((r) => r.name);
  return retryOnDeadlock(() =>
    prisma.$transaction(
      async (tx) => {
        const existing = await tx.assetSoftware.findMany({
          where: { assetId, source },
          select: { id: true, key: true, ...Object.fromEntries(SOFTWARE_FIELDS.map((f) => [f, true])) },
        }) as unknown as Array<SoftwareRow & { id: string }>;
        const delta = diffInventory(existing, incoming, (r) => r.key, (e) => e.key,
          (e, n) => sameFields<SoftwareRow>(e, n as SoftwareRow, SOFTWARE_FIELDS));
        if (delta.remove.length > 0) {
          await tx.assetSoftware.deleteMany({ where: { id: { in: delta.remove.map((e) => e.id) } } });
        }
        if (delta.create.length > 0) {
          await tx.assetSoftware.createMany({
            data: delta.create.map((r) => ({ id: randomUUID(), assetId, source, key: r.key, ...pickSoftwareFields(r) })),
            skipDuplicates: true,
          });
        }
        // updateMany: a concurrent write may have removed the row; the next
        // scrape converges instead of this one throwing.
        for (const { existing: e, next } of delta.update) {
          await tx.assetSoftware.updateMany({ where: { id: e.id }, data: pickSoftwareFields(next) });
        }
        const stamp = opts.stamp ?? null;
        await tx.assetInventoryScrape.upsert({
          where: { assetId_kind: { assetId, kind } },
          create: { assetId, kind, scrapedAt: now, stamp },
          update: { scrapedAt: now, stamp },
        });
        return { created: delta.create.length, updated: delta.update.length, removed: delta.remove.length, unchanged: delta.unchanged };
      },
      { timeout: 30_000 },
    ),
  );
}

/** Remove one source's list (and its stamp) from the given assets. */
export async function clearAssetSoftware(assetIds: string[], source: SoftwareSource): Promise<number> {
  if (assetIds.length === 0) return 0;
  let removed = 0;
  for (let i = 0; i < assetIds.length; i += 1000) {
    const chunk = assetIds.slice(i, i + 1000);
    const [del] = await prisma.$transaction([
      prisma.assetSoftware.deleteMany({ where: { assetId: { in: chunk }, source } }),
      prisma.assetInventoryScrape.deleteMany({ where: { assetId: { in: chunk }, kind: softwareScrapeKind(source) } }),
    ]);
    removed += del.count;
  }
  return removed;
}

/**
 * Drop an integration source's lists from assets that no longer carry that
 * source at all (the device left Intune, the machine left Arc, the asset was
 * merged away from it). The source's AssetSource row is the only thing that
 * says the asset is still that integration's, so this is keyed on it.
 */
export async function sweepOrphanedSoftware(source: "intune" | "arc"): Promise<number> {
  const kind = softwareScrapeKind(source);
  const removed = await prisma.$executeRaw`
    DELETE FROM "asset_software" s
     WHERE s."source" = ${source}
       AND NOT EXISTS (SELECT 1 FROM "asset_sources" a WHERE a."assetId" = s."assetId" AND a."sourceKind" = ${source})`;
  await prisma.$executeRaw`
    DELETE FROM "asset_inventory_scrapes" k
     WHERE k."kind" = ${kind}
       AND NOT EXISTS (SELECT 1 FROM "asset_sources" a WHERE a."assetId" = k."assetId" AND a."sourceKind" = ${source})`;
  return removed;
}

// ─── Read ───────────────────────────────────────────────────────────────────

export interface AssetSoftwareView {
  /** The sources that hold a list for this asset, in preference order. */
  sources: Array<{ source: SoftwareSource; scrapedAt: Date | null; count: number }>;
  rows: Array<{
    source: SoftwareSource;
    name: string;
    version: string | null;
    publisher: string | null;
    architecture: string | null;
    platform: string | null;
    installDate: string | null;
    sizeBytes: string | null;
    firstSeenAt: Date;
  }>;
}

/** Every source's list for one asset, for GET /assets/:id/software. 404 when the asset does not exist. */
export async function getAssetSoftware(assetId: string): Promise<AssetSoftwareView> {
  const asset = await prisma.asset.findUnique({ where: { id: assetId }, select: { id: true } });
  if (!asset) throw new AppError(404, "Asset not found");
  const [rows, scrapes] = await Promise.all([
    prisma.assetSoftware.findMany({
      where: { assetId },
      select: { source: true, name: true, version: true, publisher: true, architecture: true, platform: true, installDate: true, sizeBytes: true, firstSeenAt: true },
      orderBy: [{ name: "asc" }, { version: "asc" }],
    }),
    prisma.assetInventoryScrape.findMany({
      where: { assetId, kind: { in: SOFTWARE_SOURCES.map(softwareScrapeKind) } },
      select: { kind: true, scrapedAt: true },
    }),
  ]);
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.source, (counts.get(r.source) ?? 0) + 1);
  const scrapedAt = new Map(scrapes.map((s) => [s.kind, s.scrapedAt]));
  const sources = SOFTWARE_SOURCES
    .filter((s) => counts.has(s) || scrapedAt.has(softwareScrapeKind(s)))
    .map((s) => ({ source: s, scrapedAt: scrapedAt.get(softwareScrapeKind(s)) ?? null, count: counts.get(s) ?? 0 }));
  return {
    sources,
    rows: rows.map((r) => ({
      source: r.source as SoftwareSource,
      name: r.name,
      version: r.version,
      publisher: r.publisher,
      architecture: r.architecture,
      platform: r.platform,
      installDate: r.installDate ? r.installDate.toISOString().slice(0, 10) : null,
      sizeBytes: r.sizeBytes != null ? r.sizeBytes.toString() : null,
      firstSeenAt: r.firstSeenAt,
    })),
  };
}

// ─── Integration sync passes ────────────────────────────────────────────────

/** Persists in flight at once — each is one short transaction. */
const PERSIST_CONCURRENCY = 4;
/** Intune devices whose apps are read (and written) per round. */
const INTUNE_SOFTWARE_CHUNK = 200;
/** An agent list younger than this makes the Intune read for that asset redundant. */
export const AGENT_SOFTWARE_FRESH_MS = 2 * 24 * 3600_000;
/** Re-read a device's apps at least this often even when Intune's stamp says unchanged. */
export const INTUNE_SOFTWARE_MAX_AGE_MS = 7 * 24 * 3600_000;

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export interface IntuneSoftwareCandidate {
  assetId: string;
  managedDeviceId: string;
  lastSync: string | null;
}

/**
 * Which Intune devices need their detected apps read this run. Skipped: a
 * device whose asset has a fresh agent list (the agent reads the host itself),
 * and a device whose stored list was read at the same Intune lastSyncDateTime
 * and is not older than INTUNE_SOFTWARE_MAX_AGE_MS (it has not checked in, so
 * its apps cannot have changed). `force` (a scoped Discover Now) reads every
 * candidate. Pure.
 */
export function planIntuneSoftwareFetch(
  candidates: IntuneSoftwareCandidate[],
  intuneScrapes: ReadonlyMap<string, { stamp: string | null; scrapedAt: Date }>,
  agentScrapes: ReadonlyMap<string, Date>,
  now: Date,
  force: boolean,
): { toFetch: IntuneSoftwareCandidate[]; skippedAgent: number; skippedUnchanged: number } {
  const toFetch: IntuneSoftwareCandidate[] = [];
  let skippedAgent = 0;
  let skippedUnchanged = 0;
  for (const c of candidates) {
    const agentAt = agentScrapes.get(c.assetId);
    if (agentAt && now.getTime() - agentAt.getTime() < AGENT_SOFTWARE_FRESH_MS) {
      skippedAgent++;
      continue;
    }
    const prev = intuneScrapes.get(c.assetId);
    if (!force && prev && c.lastSync && prev.stamp === c.lastSync
        && now.getTime() - prev.scrapedAt.getTime() < INTUNE_SOFTWARE_MAX_AGE_MS) {
      skippedUnchanged++;
      continue;
    }
    toFetch.push(c);
  }
  return { toFetch, skippedAgent, skippedUnchanged };
}

/** An Intune detected app as a software row. Pure. */
export function intuneAppToInput(a: IntuneDetectedApp): AssetSoftwareInput {
  return {
    name: a.displayName,
    version: a.version,
    publisher: a.publisher,
    architecture: null,
    platform: a.platform,
    installDate: null,
    sizeBytes: a.sizeInByte != null ? BigInt(Math.round(a.sizeInByte)) : null,
  };
}

/** A Change Tracking software row as a software row. Pure. */
export function arcSoftwareToInput(r: ArcSoftwareRow): AssetSoftwareInput {
  return {
    name: r.name,
    version: r.version,
    publisher: r.publisher,
    architecture: r.architecture,
    platform: r.softwareType,
    installDate: null,
    sizeBytes: null,
  };
}

async function loadScrapes(assetIds: string[], kind: string): Promise<Map<string, { stamp: string | null; scrapedAt: Date }>> {
  const out = new Map<string, { stamp: string | null; scrapedAt: Date }>();
  for (let i = 0; i < assetIds.length; i += 5000) {
    const rows = await prisma.assetInventoryScrape.findMany({
      where: { kind, assetId: { in: assetIds.slice(i, i + 5000) } },
      select: { assetId: true, stamp: true, scrapedAt: true },
    });
    for (const r of rows) out.set(r.assetId, { stamp: r.stamp, scrapedAt: r.scrapedAt });
  }
  return out;
}

/**
 * The Intune software pass of an Entra/Intune discovery run, after
 * syncEntraDevices has written the assets. Never throws: a failure here is a
 * progress-log error and the run's device sync stands.
 *
 * With pullSoftware off it removes the Intune lists this integration's assets
 * carry, so switching the toggle off empties the tab rather than freezing it.
 */
export async function syncIntuneSoftware(
  integrationId: string,
  config: EntraIdConfig,
  devices: DiscoveredEntraDevice[],
  opts: { intuneRead: "ok" | "disabled" | "failed"; scoped: boolean; signal?: AbortSignal; log: EntraDiscoveryProgressCallback },
): Promise<void> {
  const { log, signal } = opts;
  try {
    const sources = await prisma.assetSource.findMany({
      where: { sourceKind: "intune", integrationId },
      select: { assetId: true, externalId: true },
    });
    if (!config.enableIntune || !config.pullSoftware) {
      if (!opts.scoped) {
        const removed = await clearAssetSoftware([...new Set(sources.map((s) => s.assetId))], "intune");
        if (removed > 0) log("discover.intune.software", "info", `Intune: installed-software read is off — removed ${removed} stored row(s)`);
      }
      return;
    }
    if (opts.intuneRead !== "ok" || signal?.aborted) return;

    const assetByDeviceId = new Map(sources.map((s) => [s.externalId.toLowerCase(), s.assetId]));
    const candidates: IntuneSoftwareCandidate[] = [];
    for (const d of devices) {
      const assetId = assetByDeviceId.get(d.deviceId.toLowerCase());
      if (!assetId || !d.intuneManagedDeviceId) continue;
      candidates.push({ assetId, managedDeviceId: d.intuneManagedDeviceId, lastSync: d.lastSyncDateTime ?? null });
    }
    const assetIds = candidates.map((c) => c.assetId);
    const [intuneScrapes, agentRows] = await Promise.all([
      loadScrapes(assetIds, softwareScrapeKind("intune")),
      loadScrapes(assetIds, softwareScrapeKind("agent")),
    ]);
    const agentScrapes = new Map([...agentRows].map(([k, v]) => [k, v.scrapedAt]));
    const plan = planIntuneSoftwareFetch(candidates, intuneScrapes, agentScrapes, new Date(), opts.scoped);

    let written = 0;
    let failedBatches = 0;
    let batchCount = 0;
    let lastError = "";
    for (let i = 0; i < plan.toFetch.length && !signal?.aborted; i += INTUNE_SOFTWARE_CHUNK) {
      const chunk = plan.toFetch.slice(i, i + INTUNE_SOFTWARE_CHUNK);
      const res = await fetchIntuneDetectedApps(config, chunk.map((c) => c.managedDeviceId), signal);
      failedBatches += res.failedBatches;
      batchCount += res.batchCount;
      if (res.lastError) lastError = res.lastError;
      await runPool(chunk, PERSIST_CONCURRENCY, async (c) => {
        const apps = res.apps.get(c.managedDeviceId);
        if (!apps) return; // failed read: keep the stored list and its stamp
        await persistAssetSoftware(c.assetId, "intune", apps.map(intuneAppToInput), { stamp: c.lastSync });
        written++;
      });
    }
    if (failedBatches > 0) {
      log("discover.intune.software", "error", `Intune: ${failedBatches} of ${batchCount} detected-apps batch read(s) failed — those devices keep their stored list and are retried next run (last error: ${lastError})`);
    }
    log("discover.intune.software", "info", `Intune: read installed software for ${written} device(s) (${plan.skippedUnchanged} unchanged since their last sync, ${plan.skippedAgent} covered by a Polaris agent)`);

    if (!opts.scoped && !signal?.aborted) await sweepOrphanedSoftware("intune");
  } catch (err: any) {
    log("discover.intune.software", "error", `Intune: installed-software pass failed: ${err?.message || err}`);
  }
}

/**
 * The Change Tracking software pass of an Azure Arc discovery run, after
 * syncArcDevices has written the assets. Tenant-wide (one workspace query per
 * chunk of machines), so a scoped run skips it. Never throws.
 *
 * A machine with no snapshot in any workspace keeps nothing: when every
 * workspace read succeeded, its stored Arc list is removed (Change Tracking
 * was switched off for it, or it left the workspace). When any workspace
 * failed, absent machines keep their lists — absence proves nothing then.
 */
export async function syncArcSoftware(
  integrationId: string,
  config: AzureArcConfig,
  opts: { scoped: boolean; signal?: AbortSignal; log: ArcDiscoveryProgressCallback },
): Promise<void> {
  const { log, signal } = opts;
  if (opts.scoped) return;
  try {
    const sources = await prisma.assetSource.findMany({
      where: { sourceKind: "arc", integrationId },
      select: { assetId: true, externalId: true },
    });
    const allAssetIds = [...new Set(sources.map((s) => s.assetId))];
    const workspaces = (config.logAnalyticsWorkspaceIds ?? []).filter((w) => w.trim());
    if (!config.pullSoftware || workspaces.length === 0) {
      const removed = await clearAssetSoftware(allAssetIds, "arc");
      if (removed > 0) log("discover.arc.software", "info", `Azure Arc: installed-software read is off — removed ${removed} stored row(s)`);
      return;
    }
    const res = await fetchArcSoftware(config, signal, log);
    if (signal?.aborted) return;
    const assetByArmId = new Map(sources.map((s) => [s.externalId.toLowerCase(), s.assetId]));
    const work: Array<{ assetId: string; rows: ArcSoftwareRow[] }> = [];
    for (const [rid, rows] of res.byResourceId) {
      const assetId = assetByArmId.get(rid);
      if (assetId) work.push({ assetId, rows });
    }
    await runPool(work, PERSIST_CONCURRENCY, async (w) => {
      await persistAssetSoftware(w.assetId, "arc", w.rows.map(arcSoftwareToInput));
    });
    let cleared = 0;
    if (res.failedWorkspaces === 0) {
      const covered = new Set(work.map((w) => w.assetId));
      cleared = await clearAssetSoftware(allAssetIds.filter((a) => !covered.has(a)), "arc");
    }
    log("discover.arc.software", "info", `Azure Arc: wrote installed software for ${work.length} machine(s)${cleared > 0 ? `; removed ${cleared} row(s) from machines with no snapshot in ${res.workspaceCount} workspace(s)` : ""}`);
    await sweepOrphanedSoftware("arc");
  } catch (err: any) {
    log("discover.arc.software", "error", `Azure Arc: installed-software pass failed: ${err?.message || err}`);
  }
}
