// loggedOnUserService — the Intune half of "who last logged on to this
// device" (business rule 180). Intune's per-device `usersLoggedOn` (Graph
// beta) lists each account that logged on and when; this pass reads it during
// an Entra/Intune discovery run, names the accounts, and merges them into
// `Asset.associatedUsers` as `intune` sightings stamped with Intune's own
// `lastLogOnDateTime`. The FortiGate half is Phase 7 of DHCP discovery
// (discovery/dhcp/deviceInventory.ts), merging into the same list through the
// same `mergeUserSightings`, so the newest entry is the last logged-on user
// whichever source saw it.
//
// `Asset.assignedTo` is untouched: it stays Intune's PRIMARY user, the person
// the device is enrolled to — a different fact from who used it last.
//
// Cost at 2000 devices: logons can only change when a device syncs, so a
// device is re-read only when its `lastSyncDateTime` moved since the last read
// (AssetInventoryScrape kind "logons:intune", stamp = that lastSync) or a week
// has passed. The first run is ~100 $batch calls; after that, the devices that
// checked in. Account names come free from each device's primary-user pair;
// only the rest cost a `/users/{id}` read, cached for a day.

import { prisma } from "../db.js";
import { chunkArray } from "../utils/chunk.js";
import { mergeUserSightings, type UserSighting } from "../utils/associatedUsers.js";
import {
  fetchIntuneLoggedOnUsers,
  resolveUserPrincipalNames,
  type DiscoveredEntraDevice,
  type EntraDiscoveryProgressCallback,
  type EntraIdConfig,
  type IntuneLogon,
} from "./entraIdService.js";

/** The AssetInventoryScrape kind that stamps an asset's last Intune logon read. */
export const INTUNE_LOGONS_SCRAPE_KIND = "logons:intune";
/** Re-read a device at least this often even when its lastSync has not moved. */
export const INTUNE_LOGONS_MAX_AGE_MS = 7 * 24 * 3600_000;
/** Devices per fetch-and-persist round, so a long run writes as it goes. */
const INTUNE_LOGONS_CHUNK = 200;
/** Writes per transaction. */
const WRITE_CHUNK = 100;

export interface IntuneLogonCandidate {
  assetId: string;
  managedDeviceId: string;
  lastSync: string | null;
}

/**
 * Which devices need a read. Pure. `force` (a scoped "Discover Now") reads
 * every candidate. A device with no lastSync is always read — there is no
 * stamp to compare.
 */
export function planIntuneLogonFetch(
  candidates: IntuneLogonCandidate[],
  scrapes: ReadonlyMap<string, { stamp: string | null; scrapedAt: Date }>,
  now: Date,
  force: boolean,
): { toFetch: IntuneLogonCandidate[]; skippedUnchanged: number } {
  const toFetch: IntuneLogonCandidate[] = [];
  let skippedUnchanged = 0;
  for (const c of candidates) {
    const prev = scrapes.get(c.assetId);
    if (!force && prev && c.lastSync && prev.stamp === c.lastSync
        && now.getTime() - prev.scrapedAt.getTime() < INTUNE_LOGONS_MAX_AGE_MS) {
      skippedUnchanged++;
      continue;
    }
    toFetch.push(c);
  }
  return { toFetch, skippedUnchanged };
}

/** One device's logons as sightings, named; an account with no name is left out. Pure. */
export function intuneLogonSightings(logons: ReadonlyArray<IntuneLogon>, upns: ReadonlyMap<string, string>): UserSighting[] {
  const out: UserSighting[] = [];
  for (const l of logons) {
    const upn = upns.get(l.userId.toLowerCase());
    const seenAt = new Date(l.lastLogOnDateTime);
    if (!upn || !Number.isFinite(seenAt.getTime())) continue;
    out.push({ account: upn, seenAt, source: "intune" });
  }
  return out;
}

/**
 * The Intune logged-on-user pass of an Entra/Intune discovery run, after
 * syncEntraDevices has written the assets. Never throws: a failure is a
 * progress-log error and the run's device sync stands. Runs whenever the
 * Intune read is on and succeeded — it needs no permission the device read
 * lacks, and naming the accounts that are nobody's primary user degrades to
 * leaving them out when User.Read.All is not granted.
 */
export async function syncIntuneLoggedOnUsers(
  integrationId: string,
  config: EntraIdConfig,
  devices: DiscoveredEntraDevice[],
  opts: { intuneRead: "ok" | "disabled" | "failed"; scoped: boolean; signal?: AbortSignal; log: EntraDiscoveryProgressCallback },
): Promise<void> {
  const { log, signal } = opts;
  if (!config.enableIntune || opts.intuneRead !== "ok" || signal?.aborted) return;
  try {
    const sources = await prisma.assetSource.findMany({
      where: { sourceKind: "intune", integrationId },
      select: { assetId: true, externalId: true },
    });
    const assetByDeviceId = new Map(sources.map((s) => [s.externalId.toLowerCase(), s.assetId]));
    const candidates: IntuneLogonCandidate[] = [];
    // Primary-user pairs: every account that is SOME device's primary user is
    // named without a /users read.
    const known = new Map<string, string>();
    for (const d of devices) {
      if (d.intuneUserId && d.userPrincipalName) known.set(d.intuneUserId.toLowerCase(), d.userPrincipalName);
      const assetId = assetByDeviceId.get(d.deviceId.toLowerCase());
      if (!assetId || !d.intuneManagedDeviceId) continue;
      candidates.push({ assetId, managedDeviceId: d.intuneManagedDeviceId, lastSync: d.lastSyncDateTime ?? null });
    }
    if (candidates.length === 0) return;

    const scrapes = new Map<string, { stamp: string | null; scrapedAt: Date }>();
    for (const chunk of chunkArray(candidates.map((c) => c.assetId), 5000)) {
      const rows = await prisma.assetInventoryScrape.findMany({
        where: { kind: INTUNE_LOGONS_SCRAPE_KIND, assetId: { in: chunk } },
        select: { assetId: true, stamp: true, scrapedAt: true },
      });
      for (const r of rows) scrapes.set(r.assetId, { stamp: r.stamp, scrapedAt: r.scrapedAt });
    }
    const now = new Date();
    const plan = planIntuneLogonFetch(candidates, scrapes, now, opts.scoped);

    let read = 0;
    let written = 0;
    let unresolved = 0;
    let failedBatches = 0;
    let batchCount = 0;
    let lastError = "";
    let upnError = "";
    for (const chunk of chunkArray(plan.toFetch, INTUNE_LOGONS_CHUNK)) {
      if (signal?.aborted) break;
      const res = await fetchIntuneLoggedOnUsers(config, chunk.map((c) => c.managedDeviceId), signal);
      failedBatches += res.failedBatches;
      batchCount += res.batchCount;
      if (res.lastError) lastError = res.lastError;
      const readHere = chunk.filter((c) => res.logons.has(c.managedDeviceId));
      if (readHere.length === 0) continue;
      read += readHere.length;

      const ids = new Set<string>();
      for (const c of readHere) for (const l of res.logons.get(c.managedDeviceId)!) ids.add(l.userId);
      const named = await resolveUserPrincipalNames(config, ids, known, signal);
      unresolved += named.unresolved;
      if (named.lastError) upnError = named.lastError;

      const stored = new Map(
        (await prisma.asset.findMany({
          where: { id: { in: readHere.map((c) => c.assetId) } },
          select: { id: true, associatedUsers: true },
        })).map((a) => [a.id, a.associatedUsers]),
      );
      const ops = [];
      for (const c of readHere) {
        if (!stored.has(c.assetId)) continue;
        const { list, changed } = mergeUserSightings(stored.get(c.assetId), intuneLogonSightings(res.logons.get(c.managedDeviceId)!, named.upns));
        if (changed) {
          ops.push(prisma.asset.update({ where: { id: c.assetId }, data: { associatedUsers: list as any } }));
          written++;
        }
        // Stamped even when an account could not be named: re-reading an
        // unchanged device every run would not name it either. The next sync
        // of the device re-reads it, after a grant has had time to land.
        ops.push(prisma.assetInventoryScrape.upsert({
          where: { assetId_kind: { assetId: c.assetId, kind: INTUNE_LOGONS_SCRAPE_KIND } },
          create: { assetId: c.assetId, kind: INTUNE_LOGONS_SCRAPE_KIND, scrapedAt: now, stamp: c.lastSync },
          update: { scrapedAt: now, stamp: c.lastSync },
        }));
      }
      for (const batch of chunkArray(ops, WRITE_CHUNK)) await prisma.$transaction(batch);
    }
    if (failedBatches > 0) {
      log("discover.intune.logons", "error", `Intune: ${failedBatches} of ${batchCount} logged-on-user batch read(s) failed — those devices keep their stored users and are retried next run (last error: ${lastError})`);
    }
    if (unresolved > 0) {
      log("discover.intune.logons", "info", `Intune: ${unresolved} logged-on account(s) could not be named — they are no device's primary user, and reading them needs the User.Read.All application permission (or the account was deleted)${upnError ? ` — ${upnError}` : ""}`);
    }
    log("discover.intune.logons", "info", `Intune: read logged-on users for ${read} device(s), updated ${written} (${plan.skippedUnchanged} unchanged since their last sync)`);
  } catch (err: any) {
    log("discover.intune.logons", "error", `Intune: logged-on-user pass failed: ${err?.message || err}`);
  }
}
