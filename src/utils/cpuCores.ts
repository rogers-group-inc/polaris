/**
 * Per-core CPU helpers for the `cpuCorePct` automation metric ("CPU core
 * utilization") — the condition that finds a single-threaded application
 * pinning one core while the all-cores average looks idle.
 *
 * The per-core vector is `AssetTelemetrySample.cpuCorePcts` — one 0-100 value
 * per logical core, index 0 first, written by the Polaris Agent, vCenter and
 * the Unraid / TrueNAS host collectors. Every hold is counted PER CORE: "over 90% for 3 polls" means the SAME
 * core was over 90% on three consecutive polls (coreSeries), never "some core"
 * on each of them — three different cores each spiking once is ordinary load,
 * not one thread stuck on one core.
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

/** A condition on a core reads "over" the line unless it is `<` / `<=`. */
export function coreConditionIsBelow(operator: string): boolean {
  return operator === "<" || operator === "<=";
}

export interface CoreReading {
  index: number;
  pct: number;
}

/**
 * Each core's value over a window, by the trigger's aggregation. `vectors` are
 * NEWEST FIRST (so `latest` is vectors[0]); a core missing from a shorter
 * sample simply contributes nothing to that core.
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

export interface CoreSeries {
  /** The reading's value: the most extreme core by the trigger's aggregation. */
  value: number | null;
  /**
   * NEWEST FIRST, built so that its leading run under ANY threshold in the
   * condition's direction equals the longest leading run of ONE core:
   * series[k] = max over cores of (min of that core's newest k+1 values)
   * (min/max swapped for a `<` condition). series[k] meets a threshold iff
   * some single core met it on every one of the newest k+1 polls — which is
   * what lets the engine's ordinary hold counting, and every severity tier's,
   * count per core without knowing cores exist.
   */
  series: number[];
  /**
   * NEWEST FIRST, the most extreme core of each poll. The RECOVERY run is
   * counted off this: an alert clears only once every core has stayed back
   * under the line. (The envelope above only ever falls as k grows, so it
   * would read one recovered poll as a whole run of them.)
   */
  clearSeries: number[];
  /** Each core's own series, newest first — raw per-poll values, or its
   *  disjoint poll-group aggregates under a count window. */
  perCore: number[][];
  /** Each core's current value on the reading's own basis, for naming. */
  current: number[];
}

/**
 * Build the per-core series behind a cpuCorePct reading from the device's
 * sample vectors, NEWEST FIRST. Only samples as wide as the newest one count:
 * a VM resized mid-window changes the set of cores, and a run must not
 * straddle two different sets. `groupAggregate` is the engine's disjoint
 * poll-group aggregation (rollingAggregate), passed in so the count window
 * means exactly what it means for every other metric.
 */
export function coreSeries(
  vectorsNewestFirst: number[][],
  opts: { aggregation: string; windowPolls: number; below: boolean },
  groupAggregate: (values: number[], windowPolls: number, aggregation: string) => number[],
): CoreSeries | null {
  if (vectorsNewestFirst.length === 0) return null;
  const width = vectorsNewestFirst[0]!.length;
  if (width === 0) return null;
  const vectors = vectorsNewestFirst.filter((v) => v.length === width);
  const pick = opts.below ? Math.min : Math.max; // across cores
  const hold = opts.below ? Math.max : Math.min; // along one core's run
  const perCore: number[][] = [];
  for (let c = 0; c < width; c++) {
    const raw = vectors.map((v) => v[c]!);
    perCore.push(opts.windowPolls > 0 ? groupAggregate(raw, opts.windowPolls, opts.aggregation) : raw);
  }
  const len = Math.min(...perCore.map((s) => s.length));
  if (len === 0) return null;
  const series: number[] = [];
  const clearSeries: number[] = [];
  const running = perCore.map((s) => s[0]!);
  for (let k = 0; k < len; k++) {
    if (k > 0) for (let c = 0; c < width; c++) running[c] = hold(running[c]!, perCore[c]![k]!);
    series.push(pick(...running));
    clearSeries.push(pick(...perCore.map((s) => s[k]!)));
  }
  let current: number[];
  if (opts.windowPolls > 0) current = perCore.map((s) => s[0]!);
  else current = aggregateCores(vectors, opts.aggregation);
  const finite = current.filter((x) => Number.isFinite(x));
  const value = finite.length ? pick(...finite) : null;
  return { value, series, clearSeries, perCore, current };
}

/**
 * The cores to NAME in an alert, hottest first (coolest first for a `<`
 * condition). With a hold, a core is named when ITS OWN leading run of
 * qualifying readings has reached the hold — the cores that are the reason the
 * alert fired. Without one, a core is named when its current value meets the
 * condition. Never empty while the reading has a core: the most extreme one is
 * named if none qualifies (a pending or recovering row).
 */
export function coresToName(
  s: CoreSeries,
  meets: (v: number) => boolean,
  holdPolls: number,
  below: boolean,
): CoreReading[] {
  const all = s.current
    .map((pct, index) => ({ index, pct, run: leadingCoreRun(s.perCore[index] ?? [], meets) }))
    .filter((c) => Number.isFinite(c.pct));
  if (all.length === 0) return [];
  all.sort((a, b) => (below ? a.pct - b.pct : b.pct - a.pct) || a.index - b.index);
  const hot = all.filter((c) => (holdPolls > 0 ? c.run >= holdPolls : meets(c.pct)));
  return (hot.length ? hot : [all[0]!]).map(({ index, pct }) => ({ index, pct }));
}

function leadingCoreRun(values: number[], meets: (v: number) => boolean): number {
  let n = 0;
  for (const v of values) {
    if (!meets(v)) break;
    n += 1;
  }
  return n;
}

/** "Core 3 (97%), Core 7 (93%)" — capped, with "and N more" past `max`. */
export function formatCoreList(cores: CoreReading[], max = 8): string {
  if (cores.length === 0) return "";
  const shown = cores.slice(0, max).map((c) => `Core ${c.index} (${Math.round(c.pct)}%)`);
  const rest = cores.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}
