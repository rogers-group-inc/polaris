/**
 * Per-core CPU helpers for the `cpuCorePct` automation metric ("Highest CPU
 * core utilization").
 *
 * The per-core vector is `AssetTelemetrySample.cpuCorePcts` — one 0-100 value
 * per logical core, index 0 first, written by the Polaris Agent and vCenter
 * only. The metric's READING is the hottest core of each sample, so a hold
 * counts samples in which SOME core was over the line even when the scheduler
 * moved the hot thread between cores. Which cores to NAME in the alert is a
 * separate question, answered per core over the same window (coresOver).
 *
 * Cores are numbered from 0, as the asset's CPU chart legend and the OS both
 * number them.
 */

/** Narrow a jsonb value to a finite-number core vector, or null. Anything that
 *  is not a non-empty array of finite numbers is "no per-core data" rather
 *  than a ragged array — an older agent or a hand-written row reaches here as
 *  whatever it is. */
export function coreVector(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== "number" || !Number.isFinite(x)) return null;
    out.push(x);
  }
  return out;
}

/** The hottest core of one sample, or null when the sample has no per-core data. */
export function hottestCorePct(v: unknown): number | null {
  const vec = coreVector(v);
  return vec ? Math.max(...vec) : null;
}

export interface CoreReading {
  index: number;
  pct: number;
}

/**
 * Each core's value over a window, by the trigger's aggregation. `vectors` are
 * NEWEST FIRST (so `latest` is vectors[0]); a core missing from a shorter
 * sample (a VM resized mid-window) simply contributes nothing to that core.
 */
export function aggregateCores(vectors: number[][], aggregation: string): number[] {
  if (vectors.length === 0) return [];
  if (aggregation === "latest") return [...vectors[0]!];
  const width = Math.max(...vectors.map((v) => v.length));
  const out: number[] = [];
  for (let c = 0; c < width; c++) {
    const vals = vectors.map((v) => v[c]).filter((x): x is number => typeof x === "number");
    if (vals.length === 0) { out.push(NaN); continue; }
    if (aggregation === "min") out.push(Math.min(...vals));
    else if (aggregation === "max") out.push(Math.max(...vals));
    else if (aggregation === "median") {
      const s = [...vals].sort((a, b) => a - b);
      const m = s.length >> 1;
      out.push(s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2);
    } else out.push(vals.reduce((a, b) => a + b, 0) / vals.length); // avg (and any unknown)
  }
  return out;
}

/**
 * The cores to name in an alert: every core whose windowed value meets the
 * condition, hottest first. When none does on its own — the reading is the
 * hottest core PER SAMPLE, so a hot thread hopping between cores can put the
 * device over the line while no single core's average is — the single hottest
 * core is named, so the alert never names nothing.
 */
export function coresOver(perCore: number[], meets: (v: number) => boolean): CoreReading[] {
  const all = perCore
    .map((pct, index) => ({ index, pct }))
    .filter((c) => Number.isFinite(c.pct));
  if (all.length === 0) return [];
  all.sort((a, b) => b.pct - a.pct || a.index - b.index);
  const hot = all.filter((c) => meets(c.pct));
  return hot.length ? hot : [all[0]!];
}

/** "Core 3 (97%), Core 7 (93%)" — capped, with "and N more" past `max`. */
export function formatCoreList(cores: CoreReading[], max = 8): string {
  if (cores.length === 0) return "";
  const shown = cores.slice(0, max).map((c) => `Core ${c.index} (${Math.round(c.pct)}%)`);
  const rest = cores.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}
