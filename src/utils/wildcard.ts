/**
 * src/utils/wildcard.ts — operator-supplied pattern compilation.
 *
 * Lived in autoMonitorInterfacesService until the contact device filter needed
 * the same `matches` semantics: the flat tag-criteria builder has always
 * offered a wildcard operator, and the condition tree gained one so a legacy
 * contact filter folds forward losslessly. A second copy of this compile is
 * exactly how "matches" would come to mean two things, so the interface
 * auto-monitor selection, tag criteria, the app-map discovery rules and the
 * condition tree all resolve one pattern the same way.
 *
 * A util rather than a service because notificationTypes evaluates the tree and
 * must not pull `db.js` in behind a pattern compile.
 */

import { AppError } from "./errors.js";
import { compileSafeRegex } from "./safeRegex.js";

/** What compileWildcard / compilePattern return: a matcher, never a backtracking RegExp. */
export interface PatternMatcher {
  readonly source: string;
  test(s: string): boolean;
}

/**
 * Cap on an operator-supplied pattern. Every consumer matches SHORT strings
 * (ifNames, mount paths, hostnames, unit names), so no legitimate pattern comes
 * near this — it exists to bound what a single stored value can cost.
 *
 * Matching cost no longer depends on it (business rule 116): a wildcard runs
 * on the linear glob matcher below and a raw regex on RE2 (utils/safeRegex.ts),
 * neither of which can backtrack. Some of these patterns are evaluated from a
 * READ-gated preview (the Application Map discovery preview) and against
 * device-reported names, which is why "the author is trusted" was never enough.
 */
export const MAX_PATTERN_LENGTH = 512;

function isLineTerminator(c: string): boolean {
  return c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
}

/**
 * Anchored shell-style glob match, without a regex (business rule 116). `*`
 * matches any run of characters and `?` exactly one; neither matches a line
 * terminator (the regex `.` this replaces did not either); every other
 * character is literal. The greedy-star algorithm with one backtrack point:
 * worst case pattern length × subject length, never exponential — the regex
 * translation (`*` → `.*`) let `****…x` backtrack combinatorially. Pure.
 */
export function globMatches(pattern: string, subject: string, questionMark = true): boolean {
  const p = pattern;
  const s = subject;
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  while (si < s.length) {
    const pc = pi < p.length ? p[pi] : "";
    if (pc === "*") {
      star = pi++;
      mark = si;
    } else if (pc !== "" && (pc === "?" && questionMark ? !isLineTerminator(s[si]) : pc === s[si])) {
      pi++;
      si++;
    } else if (star !== -1 && !isLineTerminator(s[mark])) {
      pi = star + 1;
      si = ++mark;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/**
 * Compile a shell-style wildcard ("port4*", "wan?") into an anchored matcher.
 * Every non-wildcard character is literal, so "port[1]" matches the literal
 * string.
 *
 * Memoized per pattern: the notification engine's scope evaluation reaches
 * this per asset per rule per tick, and the down-detection index rebuild does
 * the same — patterns are stored rule text, so the working set is small and
 * stable. Only successful compiles are cached.
 */
const compiledWildcards = new Map<string, PatternMatcher>();
const COMPILED_CACHE_MAX = 1000;

export function compileWildcard(pattern: string): PatternMatcher {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new AppError(400, "Empty wildcard pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new AppError(400, `Wildcard pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  }
  const hit = compiledWildcards.get(pattern);
  if (hit) return hit;
  // A run of stars matches exactly what one star does; collapse it so the
  // matcher's backtrack never re-walks the same span per extra star.
  const collapsed = pattern.replace(/\*{2,}/g, "*");
  const matcher: PatternMatcher = { source: pattern, test: (s: string) => globMatches(collapsed, String(s)) };
  if (compiledWildcards.size >= COMPILED_CACHE_MAX) compiledWildcards.clear();
  compiledWildcards.set(pattern, matcher);
  return matcher;
}

/**
 * A glob for the consumers that take one with a case option and their own
 * length rules (log-flag rules, automation event patterns, NOC filters):
 * the same linear matcher as compileWildcard, stars collapsed, no regex.
 * Memoized. An empty pattern matches only the empty string.
 */
const compiledGlobs = new Map<string, PatternMatcher>();

export function compileGlob(pattern: string, opts: { ignoreCase?: boolean; questionMark?: boolean } = {}): PatternMatcher {
  const p = String(pattern);
  // questionMark: false = only `*` is a wildcard and `?` is literal — the
  // automation event-action patterns have always meant that.
  const q = opts.questionMark !== false;
  const key = `${opts.ignoreCase ? "i" : ""}${q ? "" : "q"}\u0000${p}`;
  const hit = compiledGlobs.get(key);
  if (hit) return hit;
  const collapsed = p.replace(/\*{2,}/g, "*");
  const folded = opts.ignoreCase ? collapsed.toLowerCase() : collapsed;
  const matcher: PatternMatcher = opts.ignoreCase
    ? { source: p, test: (s: string) => globMatches(folded, String(s).toLowerCase(), q) }
    : { source: p, test: (s: string) => globMatches(folded, String(s), q) };
  if (compiledGlobs.size >= COMPILED_CACHE_MAX) compiledGlobs.clear();
  compiledGlobs.set(key, matcher);
  return matcher;
}

/**
 * Compile an operator-supplied pattern, dispatching on the `regex` flag.
 * Wildcards are anchored (existing behavior). Regex is anchor-free — the
 * operator can include ^ and $ themselves if they want full-string match — and
 * runs on RE2 (business rule 116), so it cannot backtrack.
 */
export function compilePattern(pattern: string, regex: boolean): PatternMatcher {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw new AppError(400, "Empty pattern");
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new AppError(400, `Pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
  }
  if (!regex) return compileWildcard(pattern);
  return compileSafeRegex(pattern);
}
