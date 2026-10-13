/**
 * src/utils/safeRegex.ts — business rule 115: every regex an OPERATOR supplies
 * runs on a linear-time engine.
 *
 * A JavaScript RegExp backtracks, and a backtracking match cannot be
 * interrupted: `(a+)+b`, `(.|\s)*x` or `.*.*.*x` against the wrong subject
 * does not slow a request down, it parks the whole process — the web role, a
 * monitor worker, discovery — until it finishes, which can be never. No static
 * check catches every such pattern (the scan walked straight past the old
 * `regexSafety.findUnsafeRegexConstruct`).
 *
 * So operator patterns compile with `re2js`, a pure-JavaScript port of RE2:
 * matching time is linear in the subject whatever the pattern, and it needs no
 * native build (every install path — RHEL, containers, Unraid — keeps
 * working). RE2 is also the syntax the Go agent already uses for path checks,
 * so a pattern means the same thing on the server and on an agent.
 *
 * What RE2 does not support: lookahead / lookbehind and backreferences.
 * `safeRegexProblem` names that at save time; a STORED pattern that does not
 * compile is skipped by its consumer rather than run on the old engine.
 *
 * Compiled patterns are memoized per (pattern, flags): consumers reach this
 * per asset per poll, and the working set is stored rule text.
 */

import { RE2JS } from "re2js";
import { AppError } from "./errors.js";

export interface SafeRegex {
  /** The operator's pattern, as typed. */
  readonly source: string;
  /** Does the pattern match anywhere in `s` (unanchored, like RegExp.test)? */
  test(s: string): boolean;
  /** First match as [whole, group1, …] (unset groups → undefined), like RegExp.exec, or null. */
  exec(s: string): Array<string | undefined> | null;
  /** Every non-overlapping match, left to right, like a /g exec loop — still linear overall. */
  execAll(s: string): SafeMatch[];
}

/** One match from execAll: [whole, group1, …] plus where it started. */
export type SafeMatch = Array<string | undefined> & { index: number };

export interface SafeRegexOptions {
  ignoreCase?: boolean;
}

const cache = new Map<string, SafeRegex>();
const CACHE_MAX = 2000;

/** Why `pattern` cannot be used, in operator words, or null when it compiles under RE2. */
export function safeRegexProblem(pattern: string, opts: SafeRegexOptions = {}): string | null {
  try {
    compileSafeRegex(pattern, opts);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function describeRe2Error(pattern: string, message: string): string {
  if (/\(\?[=!<]/.test(pattern)) {
    return `Regex "${pattern}" uses lookahead or lookbehind, which Polaris does not support (patterns run on the linear-time RE2 engine). Rewrite it without (?= (?! (?<= (?<!.`;
  }
  if (/\\[1-9]/.test(pattern)) {
    return `Regex "${pattern}" uses a backreference (\\1 …), which Polaris does not support (patterns run on the linear-time RE2 engine).`;
  }
  return `Invalid regex "${pattern}": ${message.replace(/^error parsing regexp:\s*/i, "")}`;
}

/** Compile `pattern` on RE2. Throws AppError(400) with an operator-readable reason. */
export function compileSafeRegex(pattern: string, opts: SafeRegexOptions = {}): SafeRegex {
  if (typeof pattern !== "string") throw new AppError(400, "Regex must be a string");
  const key = `${opts.ignoreCase ? "i" : ""}\u0000${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let re: RE2JS;
  try {
    re = RE2JS.compile(pattern, opts.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0);
  } catch (err) {
    throw new AppError(400, describeRe2Error(pattern, err instanceof Error ? err.message : String(err)));
  }
  const compiled: SafeRegex = {
    source: pattern,
    test(s: string): boolean {
      return re.matcher(String(s)).find();
    },
    exec(s: string): Array<string | undefined> | null {
      const m = re.matcher(String(s));
      if (!m.find()) return null;
      const out: Array<string | undefined> = [];
      for (let i = 0; i <= m.groupCount(); i++) {
        const g = m.group(i);
        out.push(g === null || g === undefined ? undefined : g);
      }
      return out;
    },
    execAll(s: string): SafeMatch[] {
      const m = re.matcher(String(s));
      const all: SafeMatch[] = [];
      while (m.find()) {
        const one = [] as unknown as SafeMatch;
        for (let i = 0; i <= m.groupCount(); i++) {
          const g = m.group(i);
          one.push(g === null || g === undefined ? undefined : g);
        }
        one.index = m.start();
        all.push(one);
      }
      return all;
    },
  };
  if (cache.size >= CACHE_MAX) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

/** compileSafeRegex, or null when the pattern does not compile — for consumers of STORED patterns. */
export function tryCompileSafeRegex(pattern: string, opts: SafeRegexOptions = {}): SafeRegex | null {
  try {
    return compileSafeRegex(pattern, opts);
  } catch {
    return null;
  }
}
