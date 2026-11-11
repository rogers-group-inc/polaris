/**
 * src/services/quarantineStrandedService.ts — a quarantine block that outlived
 * its release (business rule 164).
 *
 * Releasing a quarantine un-pushes the block from every FortiGate that holds
 * it. That is best-effort: a gate that is down, or reached through an
 * integration that has since been deleted, cannot be told. The release still
 * goes ahead — the operator asked for the device back and the gates that DID
 * answer have let it go — but the MAC stays blocked on the one that did not.
 * Before this rule the only trace of that was a warning Event, which is pruned
 * with every other Event after the retention period (seven days by default),
 * and nothing ever tried again. The device then sat blocked on one site with
 * Polaris showing it as released and no record anywhere of why.
 *
 * Operator decision (2026-11-11): release, remember, retry. The asset is
 * released exactly as before; the gates that still hold the block are stored
 * on it (`Asset.quarantineStranded`), shown on its Quarantine tab, retried in
 * the background on a backoff, and can be retried or dismissed by hand.
 *
 * `assetQuarantineService.releaseQuarantine` WRITES the list (through
 * utils/quarantineStranded.ts — this module imports that service, so the
 * service cannot import this one). Everything that reads or shrinks it is here.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { buildTransportForIntegration } from "./reservationPushService.js";
import { unpushQuarantineFromFortigate } from "./assetQuarantineService.js";
import {
  parseStranded,
  strandedKey,
  strandedRetryDue,
  type StrandedQuarantineEntry,
} from "../utils/quarantineStranded.js";

export interface StrandedRetryResult {
  assetId: string;
  /** FortiGates the block was removed from on this attempt. */
  cleared: string[];
  /** What is still listed afterwards. */
  remaining: StrandedQuarantineEntry[];
}

interface RetryOptions {
  actor: string;
  /** Limit the attempt to one FortiGate. */
  fortigateDevice?: string;
  /** A bearer token scoped to some integrations may only touch their gates. */
  tokenIntegrationIds?: string[];
  /** The background job passes this: only entries whose backoff has elapsed. */
  onlyDue?: Date;
}

const label = (a: { hostname: string | null; ipAddress: string | null; id: string }) => a.hostname || a.ipAddress || a.id;

/** 403 when a scoped token names a gate reached through an integration it may not operate. */
function assertTokenMayTouch(entries: readonly StrandedQuarantineEntry[], tokenIntegrationIds: string[] | undefined, verb: string): void {
  if (!tokenIntegrationIds) return;
  const allowed = new Set(tokenIntegrationIds);
  const outside = entries.filter((e) => !allowed.has(e.integrationId));
  if (outside.length === 0) return;
  const names = [...new Set(outside.map((e) => e.fortigateDevice))].join(", ");
  throw new AppError(403, `This token is not allowed to ${verb} the quarantine entry on FortiGate(s) ${names}`);
}

/**
 * Try again to remove the block from the gates still listed for one asset.
 * An entry already gone from the device counts as cleared (the un-push treats
 * absence as success). What fails stays listed with its attempt count and
 * reason updated. Writes one Event when anything cleared.
 *
 * The write re-reads the row and folds this attempt into whatever is stored
 * THEN, so a release or a dismiss that landed while the gates were being
 * called is not overwritten.
 */
export async function retryStrandedQuarantine(assetId: string, opts: RetryOptions): Promise<StrandedRetryResult> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true, ipAddress: true, quarantineStranded: true },
  });
  if (!asset) throw new AppError(404, `Asset ${assetId} not found`);

  const stored = parseStranded(asset.quarantineStranded);
  let wanted = opts.fortigateDevice ? stored.filter((e) => e.fortigateDevice === opts.fortigateDevice) : stored;
  if (opts.fortigateDevice && wanted.length === 0) {
    throw new AppError(404, `No stranded quarantine entry on FortiGate ${opts.fortigateDevice} for this asset`);
  }
  assertTokenMayTouch(wanted, opts.tokenIntegrationIds, "retry");
  if (opts.onlyDue) wanted = wanted.filter((e) => strandedRetryDue(e, opts.onlyDue!));
  if (wanted.length === 0) return { assetId, cleared: [], remaining: stored };

  const integrations = await prisma.integration.findMany({
    where: { id: { in: [...new Set(wanted.map((e) => e.integrationId).filter(Boolean))] } },
  });
  const byId = new Map(integrations.map((i) => [i.id, i]));

  const now = new Date();
  const cleared: StrandedQuarantineEntry[] = [];
  const failed = new Map<string, string>(); // key → reason
  // One gate at a time: the un-push already serializes per device, and an
  // asset is stranded on one or two gates, not hundreds.
  for (const e of wanted) {
    const integration = byId.get(e.integrationId);
    if (!integration) {
      failed.set(strandedKey(e), "The integration that reached this FortiGate no longer exists — remove the entry on the device, then dismiss it here");
      continue;
    }
    try {
      const transport = await buildTransportForIntegration(
        integration as { id: string; type: string; config: unknown },
        e.fortigateDevice,
      );
      await unpushQuarantineFromFortigate({ assetId, transport });
      cleared.push(e);
    } catch (err) {
      failed.set(strandedKey(e), err instanceof Error && err.message ? err.message : "Unpush failed");
    }
  }

  const clearedKeys = new Set(cleared.map(strandedKey));
  const fresh = await prisma.asset.findUnique({ where: { id: assetId }, select: { quarantineStranded: true } });
  const remaining = parseStranded(fresh?.quarantineStranded)
    .filter((e) => !clearedKeys.has(strandedKey(e)))
    .map((e) => {
      const why = failed.get(strandedKey(e));
      return why === undefined ? e : { ...e, error: why, lastAttemptAt: now.toISOString(), attempts: e.attempts + 1 };
    });
  await prisma.asset.update({ where: { id: assetId }, data: { quarantineStranded: remaining as object[] } });

  if (cleared.length > 0) {
    const gates = cleared.map((e) => e.fortigateDevice);
    await logEvent({
      action: "asset.quarantine.stranded_cleared",
      resourceType: "asset",
      resourceId: asset.id,
      resourceName: asset.hostname || asset.ipAddress || undefined,
      actor: opts.actor,
      level: "info",
      message: `The quarantine entry left behind for ${label(asset)} was removed from ${gates.join(", ")}` +
        (remaining.length ? `; ${remaining.length} FortiGate${remaining.length === 1 ? "" : "s"} still hold${remaining.length === 1 ? "s" : ""} it` : ""),
      details: { cleared: gates, remaining: remaining.map((e) => e.fortigateDevice) },
    });
  }
  return { assetId, cleared: cleared.map((e) => e.fortigateDevice), remaining };
}

/**
 * Stop tracking a stranded entry WITHOUT touching the device — for a gate that
 * is gone for good, or once the entry has been removed there by hand. Always
 * on the record, at warning: after this Polaris no longer knows the block may
 * still exist.
 */
export async function dismissStrandedQuarantine(
  assetId: string,
  opts: { actor: string; fortigateDevice?: string; tokenIntegrationIds?: string[] },
): Promise<StrandedRetryResult> {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    select: { id: true, hostname: true, ipAddress: true, quarantineStranded: true },
  });
  if (!asset) throw new AppError(404, `Asset ${assetId} not found`);
  const stored = parseStranded(asset.quarantineStranded);
  const going = opts.fortigateDevice ? stored.filter((e) => e.fortigateDevice === opts.fortigateDevice) : stored;
  if (going.length === 0) {
    throw new AppError(404, opts.fortigateDevice
      ? `No stranded quarantine entry on FortiGate ${opts.fortigateDevice} for this asset`
      : "This asset has no stranded quarantine entries");
  }
  assertTokenMayTouch(going, opts.tokenIntegrationIds, "dismiss");
  const goneKeys = new Set(going.map(strandedKey));
  const remaining = stored.filter((e) => !goneKeys.has(strandedKey(e)));
  await prisma.asset.update({ where: { id: assetId }, data: { quarantineStranded: remaining as object[] } });
  const gates = going.map((e) => e.fortigateDevice);
  await logEvent({
    action: "asset.quarantine.stranded_dismissed",
    resourceType: "asset",
    resourceId: asset.id,
    resourceName: asset.hostname || asset.ipAddress || undefined,
    actor: opts.actor,
    level: "warning",
    message: `Stopped tracking the quarantine entry for ${label(asset)} on ${gates.join(", ")} without removing it — if it is still on the device, the MAC is still blocked there`,
    details: { dismissed: going.map((e) => ({ fortigateDevice: e.fortigateDevice, integrationId: e.integrationId, since: e.since, attempts: e.attempts, lastError: e.error })) },
  });
  return { assetId, cleared: [], remaining };
}

/**
 * The background pass (`jobs/retryStrandedQuarantine.ts`): every asset with a
 * stranded entry whose backoff has elapsed. Normally there are none — the read
 * is one indexed-by-nothing scan of a JSON column that is `[]` on every row,
 * selecting only the id — and each asset with one costs a device call or two.
 */
export async function retryAllStrandedQuarantine(now: Date = new Date()): Promise<{ assets: number; cleared: number; failed: number }> {
  const rows = await prisma.asset.findMany({
    where: { NOT: { quarantineStranded: { equals: [] } } },
    select: { id: true, quarantineStranded: true },
  });
  let cleared = 0;
  let failed = 0;
  let assets = 0;
  for (const row of rows) {
    if (!parseStranded(row.quarantineStranded).some((e) => strandedRetryDue(e, now))) continue;
    assets += 1;
    try {
      const r = await retryStrandedQuarantine(row.id, { actor: "system:quarantine-retry", onlyDue: now });
      cleared += r.cleared.length;
      failed += r.remaining.length;
    } catch (err) {
      failed += 1;
      logger.warn({ err, assetId: row.id }, "stranded quarantine retry failed");
    }
  }
  return { assets, cleared, failed };
}
