/**
 * src/utils/fortiswitchModel.ts — FortiSwitch model extraction from fsSysVersion.
 *
 * FORTINET-FORTISWITCH-MIB::fsSysVersion (1.3.6.1.4.1.12356.106.4.1.1) is the
 * only SNMP object on a FortiSwitch that carries the hardware model, but it's
 * a combined string: the model token followed by the firmware version, e.g.
 *
 *   "S548DF-v7.2.5-build0453,230511 (GA)"   → model "S548DF"
 *   "S124EN-v6.4.6-build470,210316 (GA)"    → model "S124EN"
 *
 * … except the separator is not always "-v". FortiSwitch Rugged publishes the
 * firmware after a SPACE, and names itself in full:
 *
 *   "FortiSwitchRugged-112D-POE v7.4.8,build0929,250909 (GA)"
 *                                        → model "FortiSwitchRugged-112D-POE"
 *
 * Requiring "-v" made that whole family parse to null, which did not merely
 * cost the model field — it DEADLOCKED the asset. `Asset.model` stays empty
 * (MODEL_RULES in utils/assetProjection.ts deliberately skips the fortiswitch
 * source's own model), an empty model matches no FortiSwitch profile, and the
 * generic FortiOS profile it falls into carries no model query — so nothing
 * ever re-read fsSysVersion to fill the field that would have fixed the match.
 * Meanwhile CPU and memory were read from the FortiGate root the switch does
 * not publish, and charted a flat 0% (prod 2026-08-31, FSR-112D-POE). The
 * deadlock's other half is broken by `fortinetClassHint` in
 * services/vendorTelemetryProfiles.ts, which identifies the class from
 * `assetType` instead of from this string.
 *
 * FMG / FortiGate discovery has no model field for managed switches (the
 * observed blob carries the literal "FortiSwitch"), so this parse — run during
 * the direct-SNMP system-info scrape — is the only source of the real model.
 *
 * The returned value is prefixed "FortiSwitch " (e.g. "FortiSwitch S548DF")
 * unless the token already names itself. That prefix is LOAD-BEARING, not
 * cosmetic: vendor telemetry profile matching (`pickVendorProfile`) tests
 * /fortiswitch/i against the haystack `${manufacturer} ${os} ${model}` and
 * FortiSwitch assets carry no `os`, so a bare "S548DF" model would drop the
 * asset out of the FortiSwitch profile into the generic Fortinet/FortiGate one,
 * whose OIDs (12356.101 root) a FortiSwitch doesn't expose. The persisted
 * ManufacturerProfile override's modelPattern ("FortiSwitch", regex-tested
 * against the model) matches for the same reason.
 *
 * It is no longer the ONLY thing holding that match together, though, and must
 * not be relied on as if it were: `fortinetClassHint` now derives the class
 * from `Asset.assetType`, so an asset this parse can't help — model empty
 * because the string was unparseable, or because it was never read — still
 * resolves to the right profile. That is what makes the deadlock above
 * recoverable rather than permanent.
 */

import { applyModelParse, type ModelParse } from "./modelParse.js";

/**
 * Extract the model from a raw fsSysVersion string. Returns the display model
 * ("FortiSwitch <token>") or null when the string doesn't carry a
 * recognizable model prefix (empty value, firmware-only string, etc.).
 *
 * A thin wrapper over the declarative parse below since Phase 4 of uniform
 * SNMP — kept so the existing callers and tests keep their names while the
 * `model` metric row carries the same rule as data.
 */
export function fortiswitchModelFromFsSysVersion(raw: string | null | undefined): string | null {
  return applyModelParse(raw, FORTISWITCH_MODEL_PARSE);
}

/**
 * The same parse as data — what the `model` metric row of the Fortinet
 * profile's FortiSwitch override stores (`parsePattern` / `parseTemplate`),
 * and what the seed job stamps. Model token = everything before the first
 * "<sep>v<digit>" firmware marker, where the separator is a hyphen OR
 * whitespace ("S548DF-v7.2.5…" vs "FortiSwitchRugged-112D-POE v7.4.8…");
 * non-greedy so a hyphenated token (112D-POE) stops at the first version-
 * looking segment. The `(?!v\d)` lookahead is the old "a string that STARTS
 * with the firmware marker has no model" guard; the template's prefix rule
 * in `applyModelParse` is the old "don't re-prefix FortiSwitchRugged".
 */
export const FORTISWITCH_MODEL_PARSE: ModelParse = {
  pattern:  String.raw`^(?!v\d)(.+?)[-\s]v\d`,
  template: "FortiSwitch $1",
};
