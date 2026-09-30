/**
 * src/utils/sdwanDimensions.ts — the SD-WAN member vocabulary shared by the
 * notification engine, the chart-shading lookup, the dimension picker and the
 * SD-WAN Members strip.
 *
 * Three concerns, all keyed on the pair an `AssetPerfSlaSample` row names
 * (`healthCheck`, `link` = the SD-WAN member's interface name):
 *
 *  1. ANY-OF FILTERS. An automation's `dimensionFilter.healthCheck` / `.link`
 *     may name several health checks / members, stored joined by "|". FortiOS
 *     object names admit no "|" — the engine's `healthCheck|link` dimension key
 *     already leans on that — so the separator can never split a real name.
 *     Each term is a case-insensitive SUBSTRING, exactly as the single value
 *     always was, so every automation saved before multi-select reads the same.
 *
 *  2. PARENT MEMBERS (business rule 90). An overlay member is an IPsec tunnel
 *     riding an underlay port ("Overlay-3" over wan2). A lossy wan2 makes every
 *     overlay on it lossy too, and the operator wants the one alert that names
 *     the cause. `sdwanChildrenYielding` decides which member readings yield to
 *     a parent that is itself over the line.
 *
 *  3. STRIP SEVERITY. `sdwanSegmentVerdict` judges one scrape of one member for
 *     the Health Check Status strip: red when the FortiGate calls it dead or a
 *     reading is over the health check's own SLA target, else the worst
 *     automation severity tier the readings cross, else green.
 */

export const SDWAN_TERM_SEPARATOR = "|";

/** The terms of an SD-WAN dimension filter value — split on "|", trimmed,
 *  blanks dropped. An unset / blank value is no terms (= matches everything). */
export function sdwanDimensionTerms(pattern: string | null | undefined): string[] {
  if (!pattern) return [];
  return String(pattern).split(SDWAN_TERM_SEPARATOR).map((t) => t.trim()).filter(Boolean);
}

/** The canonical stored form of a term list: de-duplicated (case-insensitive,
 *  first spelling kept), joined by "|". */
export function joinSdwanTerms(terms: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of terms) {
    const t = String(raw ?? "").trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out.join(SDWAN_TERM_SEPARATOR);
}

/** Does `haystack` match ANY of the pattern's terms (case-insensitive
 *  substring)? No terms = match. MIRRORED client-side by the wizard's
 *  awSdwanDimensionMatch — keep the two in lockstep. */
export function sdwanDimensionMatch(haystack: string | null | undefined, pattern: string | null | undefined): boolean {
  const terms = sdwanDimensionTerms(pattern);
  if (terms.length === 0) return true;
  const h = String(haystack ?? "").toLowerCase();
  return terms.some((t) => h.includes(t.toLowerCase()));
}

/** Does an SD-WAN dimension filter select this (health check, member) pair? */
export function sdwanFilterSelects(
  df: { healthCheck?: string | null; link?: string | null } | null | undefined,
  pair: { healthCheck: string; link: string },
): boolean {
  if (!df) return true;
  return sdwanDimensionMatch(pair.healthCheck, df.healthCheck) && sdwanDimensionMatch(pair.link, df.link);
}

/** How far up a parent chain is followed (tunnel → VLAN sub-interface → port). */
export const SDWAN_PARENT_MAX_HOPS = 4;

export interface SdwanMemberReading {
  assetId: string;
  /** The SD-WAN member (interface) the reading is about. */
  member: string;
  /** The reading's own dimension key (`healthCheck|link`). */
  dimKey: string;
  /** Does the reading meet the automation's condition this tick? */
  meets: boolean;
}

/**
 * Business rule 90 — which member readings yield to their parent.
 *
 * A reading yields when it MEETS the condition and some ancestor of its member
 * (walked through `parentOf`, `${assetId}|${name}` → parent name, at most
 * SDWAN_PARENT_MAX_HOPS) is itself over the line: either the same automation
 * has a MEETING reading on that ancestor this tick, or `liveParents` holds
 * `${assetId}|${ancestor}` (an uncleared alert some automation raised on the
 * same condition about it). A reading that does not meet never yields — it is
 * recovering, and its alert must be allowed to reset normally.
 *
 * Returns `${assetId}|${dimKey}` → the ancestor it yields to. The top of a
 * chain never yields (nothing above it is over the line), so the alert that
 * survives is the one naming the cause.
 */
export function sdwanChildrenYielding(
  readings: SdwanMemberReading[],
  parentOf: Map<string, string>,
  liveParents: Set<string> = new Set(),
): Map<string, string> {
  const over = new Set<string>(liveParents);
  for (const r of readings) if (r.meets) over.add(`${r.assetId}|${r.member}`);
  const out = new Map<string, string>();
  for (const r of readings) {
    if (!r.meets) continue;
    let name = r.member;
    const visited = new Set<string>([name]);
    for (let hop = 0; hop < SDWAN_PARENT_MAX_HOPS; hop++) {
      const parent = parentOf.get(`${r.assetId}|${name}`);
      if (!parent || visited.has(parent)) break;
      if (over.has(`${r.assetId}|${parent}`)) { out.set(`${r.assetId}|${r.dimKey}`, parent); break; }
      visited.add(parent);
      name = parent;
    }
  }
  return out;
}

export type SdwanStripMetric = "sdwanLatencyMs" | "sdwanJitterMs" | "sdwanPacketLoss";

/** One health check's reading of a member at one scrape. */
export interface SdwanStripSample {
  healthCheck: string;
  state: string;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLoss: number | null;
  latencyThresholdMs: number | null;
  jitterThresholdMs: number | null;
  packetLossThreshold: number | null;
}

/** An ordered severity tier (MetricSeverityTier's shape, minus the rule ids). */
export interface SdwanStripTier {
  severity: string;
  operator: ">" | ">=" | "<" | "<=";
  threshold: number;
}

export interface SdwanSegmentVerdict {
  /** Alive in every health check (the FortiGate's own liveness verdict). */
  up: boolean;
  /** Alive, but a reading broke the health check's own SLA target. */
  outOfSla: boolean;
  /** Worst automation severity tier crossed — only for an alive, in-SLA
   *  segment (red already says everything a severity could), else null. */
  severity: string | null;
}

const crosses = (v: number, t: SdwanStripTier): boolean =>
  t.operator === ">" ? v > t.threshold : t.operator === ">=" ? v >= t.threshold : t.operator === "<" ? v < t.threshold : v <= t.threshold;

/**
 * Colour one scrape of one member. `tiersFor(metric, healthCheck)` returns the
 * severity tiers that would fire on that health check's reading of this member
 * (already filtered to automations whose dimension filter selects it).
 * `severityRank` orders severities, higher = worse.
 *
 * Red wins outright: a dead member, or one over the FortiGate's SLA target
 * (FortiOS fails the SLA when a value is ABOVE its threshold). Only an
 * in-SLA member is shaded by automation severity.
 */
export function sdwanSegmentVerdict(
  samples: SdwanStripSample[],
  tiersFor: (metric: SdwanStripMetric, healthCheck: string) => SdwanStripTier[],
  severityRank: (severity: string) => number,
): SdwanSegmentVerdict {
  if (samples.length === 0) return { up: false, outOfSla: false, severity: null };
  const dead = samples.some((s) => s.state !== "up");
  const over = (v: number | null, t: number | null) => v !== null && t !== null && v > t;
  const outOfSla = !dead && samples.some((s) =>
    over(s.latencyMs, s.latencyThresholdMs) || over(s.jitterMs, s.jitterThresholdMs) || over(s.packetLoss, s.packetLossThreshold));
  if (dead || outOfSla) return { up: !dead, outOfSla, severity: null };
  let worst: string | null = null;
  for (const s of samples) {
    const pairs: Array<[SdwanStripMetric, number | null]> = [
      ["sdwanLatencyMs", s.latencyMs], ["sdwanJitterMs", s.jitterMs], ["sdwanPacketLoss", s.packetLoss],
    ];
    for (const [metric, v] of pairs) {
      if (v === null || !Number.isFinite(v)) continue;
      for (const t of tiersFor(metric, s.healthCheck)) {
        if (crosses(v, t) && (worst === null || severityRank(t.severity) > severityRank(worst))) worst = t.severity;
      }
    }
  }
  return { up: true, outOfSla: false, severity: worst };
}
