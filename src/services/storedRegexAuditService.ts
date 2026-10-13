/**
 * src/services/storedRegexAuditService.ts — business rule 116: find the
 * operator regexes ALREADY STORED that the linear-time engine cannot run.
 *
 * From rule 116 every operator regex compiles on RE2, which has no lookaround
 * and no backreferences. Save-time validation refuses new ones; a pattern
 * saved before the change is skipped by its consumer (it matches nothing)
 * rather than run on the old engine. This is how an operator finds out: the
 * boot audit (jobs/auditStoredRegexes) writes one warning Event per unusable
 * pattern, and the capacity card carries a watch reason while any remain.
 *
 * The sources are every place an operator types a regex: manufacturer profile
 * `matchPattern`, per-model override `modelPattern` / `parsePattern`, custom
 * widget `modelPattern`, asset-type match rules, the Application Map
 * discovery rules, an integration's interface / storage auto-monitor
 * patterns, an HTTP-check credential's body regex, a path check's body regex
 * and a log-flag rule. Read-only.
 */

import { createHash } from "node:crypto";
import { prisma } from "../db.js";
import { safeRegexProblem } from "../utils/safeRegex.js";
import { SETTING_KEY as APP_MAP_SETTING_KEY } from "./appMapDiscoveryService.js";

export interface UnusablePattern {
  /** Where it lives, in operator words ("Manufacturer profile", …). */
  source: string;
  /** The row that holds it. */
  id: string;
  /** The row's display name, when it has one. */
  name: string | null;
  pattern: string;
  problem: string;
  /** Stable identity of (source, row, pattern) — dedupes the warning Event. */
  key: string;
}

/**
 * Every regex inside a settings blob, by the shapes Polaris stores them in.
 * Pure. Recognises:
 *   - `{ regex: true, patterns: [...] }` (auto-monitor + Application Map blocks)
 *   - `{ op | operator: "regex" | "notRegex", value }` (asset-type match clauses)
 *   - `{ matchMode: "regex", expectBody }` (HTTP-check definition)
 *   - `{ mode: "regex", pattern | value }` (path-check body match)
 */
export function regexPatternsIn(value: unknown, depth = 0): string[] {
  if (depth > 12 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((v) => regexPatternsIn(v, depth + 1));
  const o = value as Record<string, unknown>;
  const out: string[] = [];
  if (o.regex === true && Array.isArray(o.patterns)) {
    for (const p of o.patterns) if (typeof p === "string" && p) out.push(p);
  }
  const op = o.op ?? o.operator;
  if ((op === "regex" || op === "notRegex") && typeof o.value === "string" && o.value) out.push(o.value);
  if (o.matchMode === "regex" && typeof o.expectBody === "string" && o.expectBody) out.push(o.expectBody);
  if (o.mode === "regex") {
    if (typeof o.pattern === "string" && o.pattern) out.push(o.pattern);
    else if (typeof o.value === "string" && o.value) out.push(o.value);
  }
  for (const v of Object.values(o)) if (v && typeof v === "object") out.push(...regexPatternsIn(v, depth + 1));
  return out;
}

function finding(source: string, id: string, name: string | null, pattern: string): UnusablePattern | null {
  const problem = safeRegexProblem(pattern);
  if (!problem) return null;
  const key = `${source}:${id}:${createHash("sha1").update(pattern).digest("hex").slice(0, 12)}`;
  return { source, id, name, pattern, problem, key };
}

/** Every stored operator regex RE2 cannot compile. One query per source. */
export async function findUnusableStoredPatterns(): Promise<UnusablePattern[]> {
  const out: UnusablePattern[] = [];
  const push = (f: UnusablePattern | null) => { if (f) out.push(f); };

  const [profiles, overrides, widgets, assetTypes, integrations, credentials, pathChecks, logFlags, appMap] = await Promise.all([
    prisma.manufacturerProfile.findMany({ where: { matchPattern: { not: null } }, select: { id: true, manufacturer: true, matchPattern: true } }),
    prisma.manufacturerProfileMetricOverride.findMany({
      where: { OR: [{ modelPattern: { not: null } }, { parsePattern: { not: null } }] },
      select: { id: true, modelPattern: true, parsePattern: true },
    }),
    prisma.manufacturerCustomWidget.findMany({ where: { modelPattern: { not: null } }, select: { id: true, name: true, modelPattern: true } }),
    prisma.assetTypeDef.findMany({ select: { id: true, label: true, matchRules: true } }),
    prisma.integration.findMany({ select: { id: true, name: true, config: true } }),
    prisma.credential.findMany({ where: { type: "http" }, select: { id: true, name: true, config: true } }),
    prisma.pathCheck.findMany({ select: { id: true, name: true, http: true } }),
    prisma.logFlagRule.findMany({ where: { matchType: "regex" }, select: { id: true, name: true, pattern: true } }),
    prisma.setting.findUnique({ where: { key: APP_MAP_SETTING_KEY }, select: { value: true } }).catch(() => null),
  ]);

  for (const p of profiles) if (p.matchPattern) push(finding("Manufacturer profile", p.id, p.manufacturer, p.matchPattern));
  for (const o of overrides) {
    if (o.modelPattern) push(finding("Manufacturer profile per-model exception", o.id, null, o.modelPattern));
    if (o.parsePattern) push(finding("Manufacturer profile model parse", o.id, null, o.parsePattern));
  }
  for (const w of widgets) if (w.modelPattern) push(finding("Custom widget", w.id, w.name, w.modelPattern));
  for (const t of assetTypes) for (const p of regexPatternsIn(t.matchRules)) push(finding("Asset type match rule", t.id, t.label, p));
  for (const i of integrations) for (const p of regexPatternsIn(i.config)) push(finding("Integration auto-monitor pattern", i.id, i.name, p));
  for (const c of credentials) for (const p of regexPatternsIn(c.config)) push(finding("HTTP check credential", c.id, c.name, p));
  for (const pc of pathChecks) for (const p of regexPatternsIn(pc.http)) push(finding("Path check", pc.id, pc.name, p));
  for (const l of logFlags) push(finding("Log-flag rule", l.id, l.name, l.pattern));
  if (appMap) for (const p of regexPatternsIn(appMap.value)) push(finding("Application Map discovery rule", APP_MAP_SETTING_KEY, null, p));
  return out;
}

let cached: { at: number; count: number } | null = null;
const CACHE_MS = 10 * 60 * 1000;

/** How many stored patterns are unusable — cached for the capacity card. Never throws. */
export async function countUnusableStoredPatterns(): Promise<number> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.count;
  try {
    const n = (await findUnusableStoredPatterns()).length;
    cached = { at: Date.now(), count: n };
    return n;
  } catch {
    return 0;
  }
}

export function _resetUnusablePatternCache(): void {
  cached = null;
}
