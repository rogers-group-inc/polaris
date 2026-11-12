/**
 * src/utils/quarantineStranded.ts — the pure half of business rule 164: the
 * list of FortiGates that still hold a quarantine block for an asset Polaris
 * has already released (`Asset.quarantineStranded`), and when each is due for
 * another attempt.
 *
 * The database half is services/quarantineStrandedService.ts.
 */

/** One FortiGate that could not be reached when its asset's quarantine was released. */
export interface StrandedQuarantineEntry {
  fortigateDevice: string;
  integrationId: string;
  /** Why the last attempt failed. */
  error: string;
  /** When the release first failed on this gate (ISO). */
  since: string;
  /** When Polaris last tried (ISO). */
  lastAttemptAt: string;
  /** Attempts so far, the failed release included. */
  attempts: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Read a stored blob defensively: anything that is not a usable entry is dropped. */
export function parseStranded(raw: unknown): StrandedQuarantineEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: StrandedQuarantineEntry[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const fortigateDevice = str(o.fortigateDevice);
    if (!fortigateDevice) continue;
    const attempts = Number(o.attempts);
    out.push({
      fortigateDevice,
      integrationId: str(o.integrationId),
      error: str(o.error) || "Unpush failed",
      since: str(o.since) || str(o.lastAttemptAt) || new Date(0).toISOString(),
      lastAttemptAt: str(o.lastAttemptAt) || str(o.since) || new Date(0).toISOString(),
      attempts: Number.isFinite(attempts) && attempts >= 1 ? Math.floor(attempts) : 1,
    });
  }
  return out;
}

/** A gate is one entry: the same FortiGate reached through the same integration. */
export function strandedKey(e: { fortigateDevice: string; integrationId: string }): string {
  return `${e.integrationId}\u0000${e.fortigateDevice}`;
}

/**
 * Fold fresh failures into the stored list. A gate already listed keeps its
 * `since` and gains an attempt; a new one starts at one. Nothing is removed —
 * clearing an entry is `withoutStranded`.
 */
export function mergeStranded(
  existing: unknown,
  failed: ReadonlyArray<{ fortigateDevice: string; integrationId: string; error: string }>,
  now: Date,
): StrandedQuarantineEntry[] {
  const at = now.toISOString();
  const byKey = new Map(parseStranded(existing).map((e) => [strandedKey(e), e]));
  for (const f of failed) {
    if (!f.fortigateDevice) continue;
    const key = strandedKey(f);
    const prev = byKey.get(key);
    byKey.set(key, prev
      ? { ...prev, error: f.error || prev.error, lastAttemptAt: at, attempts: prev.attempts + 1 }
      : { fortigateDevice: f.fortigateDevice, integrationId: f.integrationId, error: f.error || "Unpush failed", since: at, lastAttemptAt: at, attempts: 1 });
  }
  return [...byKey.values()];
}

/**
 * Two records' stranded lists as one (business rule 164(a) — a merge). An
 * entry both hold keeps the first list's copy: its `since` and attempt count
 * are the survivor's own history with that gate.
 */
export function unionStranded(survivor: unknown, absorbed: unknown): StrandedQuarantineEntry[] {
  const byKey = new Map(parseStranded(survivor).map((e) => [strandedKey(e), e]));
  for (const e of parseStranded(absorbed)) {
    if (!byKey.has(strandedKey(e))) byKey.set(strandedKey(e), e);
  }
  return [...byKey.values()];
}

/**
 * Two records' quarantine TARGET lists as one (rule 164(a)). Targets are
 * opaque here — only `fortigateDevice` + `integrationId` are read — and a gate
 * both hold keeps the survivor's record.
 */
export function unionQuarantineTargets(survivor: unknown, absorbed: unknown): unknown[] {
  const list = (raw: unknown) => (Array.isArray(raw) ? raw.filter((t) => t && typeof t === "object" && typeof (t as { fortigateDevice?: unknown }).fortigateDevice === "string") : []);
  const keyOf = (t: unknown) => {
    const r = t as { fortigateDevice: string; integrationId?: unknown };
    return strandedKey({ fortigateDevice: r.fortigateDevice, integrationId: typeof r.integrationId === "string" ? r.integrationId : "" });
  };
  const out = list(survivor);
  const have = new Set(out.map(keyOf));
  for (const t of list(absorbed)) {
    if (!have.has(keyOf(t))) { out.push(t); have.add(keyOf(t)); }
  }
  return out;
}

/** The list without the given gates. */
export function withoutStranded(
  existing: unknown,
  cleared: ReadonlyArray<{ fortigateDevice: string; integrationId: string }>,
): StrandedQuarantineEntry[] {
  const gone = new Set(cleared.map(strandedKey));
  return parseStranded(existing).filter((e) => !gone.has(strandedKey(e)));
}

/** The list without any entry on the named FortiGates, whatever integration reached them. */
export function withoutStrandedDevices(existing: unknown, devices: ReadonlyArray<string>): StrandedQuarantineEntry[] {
  const gone = new Set(devices);
  return parseStranded(existing).filter((e) => !gone.has(e.fortigateDevice));
}

export const STRANDED_RETRY_BASE_MS = 15 * 60 * 1000;
export const STRANDED_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * The wait before the next automatic attempt: 15 minutes after the first
 * failure, doubling each time, capped at six hours. A gate that is down for a
 * maintenance window clears within minutes of coming back; one that is gone
 * for good costs four attempts a day.
 */
export function strandedRetryDelayMs(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts));
  return Math.min(STRANDED_RETRY_MAX_MS, STRANDED_RETRY_BASE_MS * 2 ** Math.min(n - 1, 10));
}

/** Is this entry due for an automatic retry at `now`? */
export function strandedRetryDue(e: StrandedQuarantineEntry, now: Date): boolean {
  const last = Date.parse(e.lastAttemptAt);
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= strandedRetryDelayMs(e.attempts);
}
