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
 * What protects these patterns now is the ENGINE (business rule 116): every
 * one compiles and runs on RE2 (utils/safeRegex.ts), whose matching time is
 * linear in the subject whatever the pattern, so no shape can hang a worker.
 * The heuristic that used to stand in for it (`findUnsafeRegexConstruct`,
 * which refused nested quantifiers and missed `.*.*x`, `(a|aa)+b`, `(.|\s)*x`)
 * is gone. What stays here:
 *
 *   - `MAX_REGEX_SUBJECT` / `clampRegexSubject` — a cheap cap on what a
 *     pattern is run against, so cost stays small even per poll at 2000
 *     assets. Set high enough never to truncate a real scalar.
 *   - `countCaptureGroups` — the model parse rule needs at least one group.
 */

/**
 * The longest subject an operator-supplied pattern is run against.
 *
 * Sized so it never truncates anything real: SNMP caps `sysDescr` at 255
 * octets, and the resolver's widest subject joins three such fields. What it
 * bounds is the constant factor: on RE2 a match costs time linear in the
 * subject, and 1024 characters of it is nothing.
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
