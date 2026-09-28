/**
 * src/utils/inventoryDelta.ts — the delta write behind the current-state
 * service and process inventories (persistAssetServices / persistAssetProcesses).
 *
 * Both tables used to be delete-replaced: every agent push deleted all of the
 * host's rows and inserted the new list. Simple and atomic, but at fleet scale
 * it is almost all waste — a Windows host carries ~330 services and a few
 * hundred programs, scraped every five minutes, and between two scrapes nearly
 * none of them change. At 500 agents that was ~47M inserts + 47M deletes a
 * day on the service table alone, each one write-ahead-logged and vacuumed.
 *
 * So the writers now load the host's current rows, and only create what
 * appeared, delete what vanished, and update what changed — `diffInventory`.
 * A live CPU or memory figure jitters on every scrape, and compared raw it
 * would mark every running program changed and buy nothing, so the figures are
 * stored ROUNDED (`normalizeCpuPct`, `normalizeBytes` — invisible where they
 * are shown) and compared through a DEAD BAND (`sameInventoryRow`): a row is
 * rewritten only when CPU moved a point or memory 2%. Both happen on the
 * server, so they apply to every source — agent, agentless, any version.
 *
 * Pure: no Prisma, no clock.
 */

/**
 * CPU % to one decimal — the precision every surface prints. An idle service
 * reads 0.0 on scrape after scrape instead of 0.0333…, 0.0166…, 0.05.
 */
export function normalizeCpuPct(v: number | null): number | null {
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * 10) / 10;
}

/**
 * Bytes to three significant figures — what `formatBytes` shows ("384 MiB",
 * "1.2 GiB", "12 GiB"). A working set that moves by a few KiB between scrapes
 * keeps the same stored value; a real change of ~1% or more still lands.
 * Relative, not a fixed MiB step, so a small process is not flattened to 0.
 */
export function normalizeBytes(v: bigint | null): bigint | null {
  if (v == null) return null;
  if (v <= 0n) return v;
  const digits = v.toString().length;
  if (digits <= 3) return v;
  const scale = 10n ** BigInt(digits - 3);
  // Round half up on the 4th significant digit.
  return ((v + scale / 2n) / scale) * scale;
}

export interface InventoryDelta<In, Existing> {
  /** Incoming rows whose key is not stored yet. */
  create: In[];
  /** Stored rows whose incoming counterpart differs, paired. */
  update: Array<{ existing: Existing; next: In }>;
  /** Stored rows whose key is absent from the incoming list. */
  remove: Existing[];
  /** Stored rows left exactly as they are. */
  unchanged: number;
}

/**
 * Split an incoming full list against the stored rows by business key. A
 * duplicate incoming key keeps the FIRST occurrence (the table's unique index
 * would refuse the second; the old createMany skipped it the same way). Pure.
 */
export function diffInventory<In, Existing>(
  existing: readonly Existing[],
  incoming: readonly In[],
  keyOfIn: (r: In) => string,
  keyOfExisting: (r: Existing) => string,
  same: (existing: Existing, next: In) => boolean,
): InventoryDelta<In, Existing> {
  const stored = new Map<string, Existing>();
  for (const e of existing) stored.set(keyOfExisting(e), e);
  const seen = new Set<string>();
  const out: InventoryDelta<In, Existing> = { create: [], update: [], remove: [], unchanged: 0 };
  for (const r of incoming) {
    const k = keyOfIn(r);
    if (seen.has(k)) continue;
    seen.add(k);
    const e = stored.get(k);
    if (e === undefined) out.create.push(r);
    else if (same(e, r)) out.unchanged++;
    else out.update.push({ existing: e, next: r });
  }
  for (const [k, e] of stored) if (!seen.has(k)) out.remove.push(e);
  return out;
}

/** Field equality that treats bigint, Date and null the way the columns do. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === "bigint" || typeof b === "bigint") return BigInt(a as bigint) === BigInt(b as bigint);
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : new Date(a as string).getTime();
    const tb = b instanceof Date ? b.getTime() : new Date(b as string).getTime();
    return ta === tb;
  }
  return false;
}

/** True when every listed field is `sameValue`. */
export function sameFields<T>(a: T, b: T, fields: readonly (keyof T)[]): boolean {
  return fields.every((f) => sameValue(a[f], b[f]));
}

/**
 * The dead band a live figure has to leave before its row is rewritten.
 *
 * Rounding alone was not enough. Measured on a Windows workstation, two
 * inventory scrapes a minute apart: of 89 programs, 41 still differed after
 * rounding CPU to 0.1 and memory to three significant figures — mostly idle
 * processes flickering between 0.0 and 0.4% CPU. With these bands 16 did.
 * The cost is that a stored figure can lag the host by up to one band between
 * rewrites, which nothing that reads it (a table refreshed every five minutes,
 * a top-5 ranking) can tell from noise.
 */
export const CPU_DEAD_BAND_POINTS = 1;
export const MEMORY_DEAD_BAND_RATIO = 0.02;

/** CPU within the dead band of the stored value (null only matches null). Pure. */
export function cpuWithinBand(stored: unknown, next: unknown): boolean {
  if (stored == null || next == null) return stored == null && next == null;
  return Math.abs(Number(stored) - Number(next)) < CPU_DEAD_BAND_POINTS;
}

/** Bytes within the dead band of the stored value (null only matches null). Pure. */
export function bytesWithinBand(stored: unknown, next: unknown): boolean {
  if (stored == null || next == null) return stored == null && next == null;
  const s = Number(stored);
  const n = Number(next);
  if (s === n) return true;
  return Math.abs(s - n) < MEMORY_DEAD_BAND_RATIO * Math.max(Math.abs(s), 1);
}

/**
 * The row comparison both writers use: every exact field equal, and the CPU
 * and memory figures within their dead bands. Pure.
 */
export function sameInventoryRow<T>(
  stored: T,
  next: T,
  exactFields: readonly (keyof T)[],
  cpuField: keyof T,
  bytesField: keyof T,
): boolean {
  return (
    sameFields(stored, next, exactFields) &&
    cpuWithinBand(stored[cpuField], next[cpuField]) &&
    bytesWithinBand(stored[bytesField], next[bytesField])
  );
}
