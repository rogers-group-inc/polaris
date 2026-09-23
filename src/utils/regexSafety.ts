/**
 * src/utils/regexSafety.ts — guards for the regexes an OPERATOR supplies.
 *
 * Three Manufacturer Profile fields are regexes a human types and Polaris
 * compiles: `ManufacturerProfile.matchPattern` and `modelPattern` (the "also
 * applies when" and per-model-exception selectors, `profileResolver` →
 * `resolveDbMetric()` / `compiled()`) and the `model` metric row's
 * `parsePattern` (`utils/modelParse.ts` → `applyModelParse()`). That is the
 * point of the feature — a parse rule has to be a ROW to be editable, and a
 * row cannot hold a function — so the pattern can never be escaped or
 * literal-quoted the way CodeQL's `js/regex-injection` advice assumes. What
 * CAN be done is keep a pattern from hanging the process, which is what this
 * file is for.
 *
 * The exposure is real but narrow. Writing one needs `manufacturerProfiles:
 * write`, so the author is a trusted operator and the realistic failure is a
 * TYPO, not an attack — `(.+)+` where `(.+)` was meant. But the subject
 * strings are device-supplied SNMP scalars, matched once per asset per poll
 * on the monitor and discovery roles, and a JavaScript regex cannot be
 * interrupted: catastrophic backtracking does not slow a poll down, it parks
 * that worker forever. At 2000 assets the first symptom is a role that stops
 * reporting, with nothing in the log.
 *
 * Two guards, both cheap, neither a proof:
 *
 *   1. `findUnsafeRegexConstruct` rejects the shape that actually explodes —
 *      an unbounded quantifier applied to a group that already contains one
 *      (`(a+)+`, `(\w+|\d+)*`, `(.*)+`). It runs on the WRITE path only, so
 *      an operator is told at save time, in the editor, where it is fixable.
 *   2. `MAX_REGEX_SUBJECT` caps what a pattern is ever run against, which bounds
 *      the polynomial cases — the ones whose cost grows with subject length.
 *      It is set high enough never to truncate a real scalar.
 *
 * What they do NOT catch: overlapping alternation (`(a|a)*`), polynomial
 * blowup from adjacent unbounded quantifiers, and anything else a determined
 * author can still write. A pattern stored before this guard existed also
 * keeps running — validation is a write-path check, and nothing rewrites
 * stored rows. Treat this as a footgun guard, not a sandbox: the durable fix
 * is a linear-time engine (RE2), which is a native dependency this project
 * deliberately does not carry.
 */

/**
 * The longest subject an operator-supplied pattern is run against.
 *
 * Sized so it never truncates anything real: SNMP caps `sysDescr` at 255
 * octets, and the resolver's widest subject joins three such fields. What it
 * bounds is POLYNOMIAL blowup, where cost grows with subject length — a
 * quadratic pattern over 1024 characters is a million steps, which is nothing.
 * It does not bound the exponential case, which needs no more than about
 * thirty characters to hang forever; `findUnsafeRegexConstruct` is what stands
 * against that one.
 */
export const MAX_REGEX_SUBJECT = 1024;

/**
 * Cut a subject down to what an operator pattern may be run against.
 *
 * Truncation rather than refusal, because every caller is asking "does this
 * text mention X" — looking at less of it can only miss a match, whereas
 * refusing outright would drop a device's profile on the floor.
 */
export function clampRegexSubject(value: string): string {
  return value.length > MAX_REGEX_SUBJECT ? value.slice(0, MAX_REGEX_SUBJECT) : value;
}

/** An unbounded quantifier — one with no upper bound, so it can backtrack freely. */
interface Quantifier {
  /** Characters consumed, including a lazy/possessive `?` suffix. */
  length: number;
  unbounded: boolean;
}

/**
 * Read the quantifier at `i`, if there is one.
 *
 * Lazy (`+?`) counts as unbounded exactly like greedy: laziness changes the
 * order the engine tries alternatives, not how many there are, so `(a+?)+?`
 * blows up the same way `(a+)+` does.
 */
function quantifierAt(source: string, i: number): Quantifier | null {
  const c = source[i];
  if (c === "*" || c === "+") {
    return { length: source[i + 1] === "?" ? 2 : 1, unbounded: true };
  }
  if (c === "{") {
    const close = source.indexOf("}", i);
    if (close === -1) return null; // a literal brace, not a quantifier
    const body = source.slice(i + 1, close);
    if (!/^\d+(,\d*)?$/.test(body)) return null;
    const lazy = source[close + 1] === "?" ? 1 : 0;
    // `{n,}` has no ceiling; `{n}` and `{n,m}` do.
    return { length: close - i + 1 + lazy, unbounded: body.endsWith(",") };
  }
  return null;
}

/**
 * Does this fragment apply an unbounded quantifier to anything?
 *
 * Scanned rather than regex-matched because `[a+]` and `\+` are literals, and
 * a scan is the only way to tell those from the real thing.
 */
function hasUnboundedQuantifier(fragment: string): boolean {
  let inClass = false;
  for (let i = 0; i < fragment.length; i++) {
    const c = fragment[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    const q = quantifierAt(fragment, i);
    if (q?.unbounded) return true;
    if (q) i += q.length - 1;
  }
  return false;
}

/**
 * The first nested-quantifier construct in `source`, or null when there is none.
 *
 * Returns the offending text so the operator sees the part to fix rather than
 * being told their pattern is bad. It flags an unbounded quantifier on a group
 * whose body already holds one, which is the shape that goes exponential.
 * `(ab)+` and `(a{1,3})+` pass, because they do not.
 *
 * It OVER-flags, and that is the deliberate side to err on. `(v\d+)+` is
 * perfectly safe — `\d` never matches the `v` that begins each repetition, so
 * the split points are fixed — but seeing that needs an engine that knows
 * whether two subexpressions can match the same text, which is most of the way
 * to writing the linear-time matcher this guard exists to substitute for.
 * Refusing it costs an operator a rewrite at save time; the alternative is
 * deciding "probably fine" about a pattern that runs uninterruptibly on every
 * poll.
 *
 * An unbalanced or otherwise malformed pattern is not this function's problem —
 * both callers compile first, so anything reaching here is a valid regex.
 */
export function findUnsafeRegexConstruct(source: string): string | null {
  const openAt: number[] = [];
  let inClass = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      openAt.push(i);
      continue;
    }
    if (c === ")") {
      const open = openAt.pop();
      if (open === undefined) continue;
      const q = quantifierAt(source, i + 1);
      if (!q?.unbounded) continue;
      if (hasUnboundedQuantifier(source.slice(open + 1, i))) {
        return source.slice(open, i + 1 + q.length);
      }
    }
  }
  return null;
}

/**
 * How many CAPTURING groups a pattern has.
 *
 * Counted by scanning the source rather than by the usual
 * `new RegExp(source + "|").exec("")!.length` trick, for two reasons: it
 * compiles operator input a second time in a form the operator never wrote
 * (appending `|` makes every branch optional, which is a different regex), and
 * it is a second `new RegExp` on a user-provided value for no gain. A scan
 * answers the same question without either.
 *
 * `(?:…)`, `(?=…)`, `(?!…)`, `(?<=…)` and `(?<!…)` do not capture; `(…)` and
 * the named `(?<name>…)` do.
 */
export function countCaptureGroups(source: string): number {
  let count = 0;
  let inClass = false;

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c !== "(") continue;
    if (source[i + 1] !== "?") {
      count++; // a plain group
      continue;
    }
    // `(?<name>` captures; `(?<=` and `(?<!` are lookbehind and do not.
    if (source[i + 2] === "<" && source[i + 3] !== "=" && source[i + 3] !== "!") count++;
  }
  return count;
}
