/**
 * src/utils/modelParse.ts — a declarative model-identity parse.
 *
 * Some devices publish their hardware model only inside a vendor SNMP scalar
 * that carries other things too. FortiSwitch `fsSysVersion` reads
 * "S548DF-v7.2.5-build0453,230511 (GA)": the model token, a separator, then
 * firmware. Until 2026-09 the only way to get "FortiSwitch S548DF" out of that
 * was a JS function on the hardcoded vendor profile (`fortiswitchModelFromFs
 * SysVersion`), which meant the model query could never move into the
 * operator-editable `ManufacturerProfile` — a function is not a row.
 *
 * This is the row-shaped form: a regex with a capture group, and a template
 * with `$1`. It covers the one parser that existed and is what the `model`
 * metric row stores (`parsePattern` / `parseTemplate`).
 *
 * Rules, in order:
 *   1. Blank input → null (nothing to stamp).
 *   2. The pattern must match and `$1` must capture something non-blank,
 *      else null — "unrecognized", never a guess. A firmware-only string
 *      fails the pattern by construction (see the FortiSwitch seed).
 *   3. No template → the captured token as-is.
 *   4. A token that ALREADY starts with the template's literal prefix (case-
 *      insensitively) is returned untouched. `FortiSwitchRugged-112D-POE` must
 *      not become "FortiSwitch FortiSwitchRugged-112D-POE". This is the
 *      generalized form of the "don't re-prefix" rule the FortiSwitch parser
 *      had, so it is no longer FortiSwitch-specific.
 *   5. Otherwise the template with `$1` replaced.
 */

import { MAX_REGEX_SUBJECT, countCaptureGroups, findUnsafeRegexConstruct } from "./regexSafety.js";

export interface ModelParse {
  /** Regex applied to the raw scalar (case-insensitive); group 1 is the model token. */
  pattern: string;
  /** Output template carrying `$1`; null = the token itself. */
  template: string | null;
}

/**
 * The literal text of a template before its `$1` — "FortiSwitch " for
 * "FortiSwitch $1". Empty when the template starts with the placeholder.
 */
export function templatePrefix(template: string | null): string {
  if (!template) return "";
  return template.split("$1")[0].trim();
}

export function applyModelParse(raw: string | null | undefined, parse: ModelParse): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Rule 2's "unrecognized, never a guess" also covers a scalar too long to be
  // a model string. The cap is what keeps an operator's pattern — which this
  // runs per asset per poll against whatever the DEVICE returned — from
  // backtracking over an unbounded subject. See utils/regexSafety.ts.
  if (trimmed.length > MAX_REGEX_SUBJECT) return null;

  let re: RegExp;
  try {
    re = new RegExp(parse.pattern, "i");
  } catch {
    return null; // write-path validates; defensive only
  }
  const m = re.exec(trimmed);
  const token = m?.[1]?.trim();
  if (!token) return null;

  if (!parse.template) return token;
  const prefix = templatePrefix(parse.template);
  if (prefix && token.toLowerCase().startsWith(prefix.toLowerCase())) return token;
  return parse.template.replace("$1", token);
}

/**
 * Validate what an operator typed into a `model` row. Returns an error
 * message or null. The pattern must compile and carry a capture group (a
 * pattern with none can never yield a token); the template, if given, must
 * carry `$1` (a template without it would stamp the same literal on every
 * device).
 */
export function validateModelParse(pattern: string | null, template: string | null): string | null {
  if (!pattern || !pattern.trim()) return "parsePattern is required when a model symbol is set";
  if (pattern.length > 512) return "parsePattern is too long (max 512 characters)";
  let re: RegExp;
  try {
    // Compiling what the operator typed is the feature, not a lapse — a parse
    // rule has to be a ROW to be editable, so it cannot be a literal or an
    // escaped string. utils/regexSafety.ts carries the reasoning and the two
    // guards that stand in for escaping (CodeQL js/regex-injection).
    re = new RegExp(pattern, "i");
  } catch {
    return "parsePattern must be a valid regex";
  }
  if (countCaptureGroups(re.source) < 1) return "parsePattern needs a capture group for the model token";
  // An operator types this and Polaris runs it on the monitor path, where a
  // regex cannot be interrupted — so the nested-quantifier shape is refused at
  // save time, while it is still in front of the person who can fix it.
  const unsafe = findUnsafeRegexConstruct(re.source);
  if (unsafe) {
    return `parsePattern may never finish on some inputs: \`${unsafe}\` repeats a group that already repeats. Rewrite it so only one of the two repeats.`;
  }
  if (template !== null && template !== undefined && template !== "" && !template.includes("$1")) {
    return "parseTemplate must contain $1";
  }
  if (template && template.length > 200) return "parseTemplate is too long (max 200 characters)";
  return null;
}
