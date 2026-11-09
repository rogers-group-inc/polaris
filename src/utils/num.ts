/**
 * src/utils/num.ts — numeric coercion for loosely-typed values (stored
 * settings, device payloads, varbinds).
 *
 * `toNonNegativeInt` replaced two byte-identical private copies on 2026-11-04:
 * monitoringService.toPositiveInt (misnamed — it always accepted 0) and the
 * monitor-settings hierarchy migration's toInt.
 *
 * CQ-B027 (2026-11-09) added the two "finite number or null" contracts, each
 * absorbing only copies whose behaviour matched it on every input:
 *   - `toFiniteOrNull` (loose, `Number()` coercion): agentlessHostService.num,
 *     monitoringService.pickFiniteNumber, fortiosIpsec.pickFiniteNumber,
 *     vcenterService.intOrNull.
 *   - `parseFiniteOrNull` (strict, numbers + numeric strings only):
 *     azureArcService.num, firmwareEngines/deviceHttp.asNumber,
 *     fortiapRadioSnmp.toInt.
 * The look-alikes that stay local differ somewhere that matters — null/""
 * → null but whitespace → 0 (unraid/truenas `num`), `undefined` instead of
 * null (fortiapMonitorRow), booleans as 1/0 (stateProbes), truncation
 * (snmpInventory), strings-or-numbers-only with "" → 0 (proxmox) — and
 * the ledger row lists why.
 */

/**
 * `v` as an integer >= 0, floored; `fallback` when it is not a finite number
 * or is negative. Strings are coerced with `Number()`, so "30" reads as 30 and
 * "" as 0.
 */
export function toNonNegativeInt(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * `Number(v)` when that is finite, else null — the LOOSE reading. A number
 * passes through (NaN / ±Infinity → null); anything else goes through
 * `Number()`, so "42" → 42, " 7 " → 7, "" / "  " / null / false / [] → 0,
 * true → 1, "12abc" / undefined / {} → null. No rounding.
 */
export function toFiniteOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * A finite number, or a string that parses to one, else null — the STRICT
 * reading. "42" → 42 and " 7 " → 7 (`Number()` trims), but "" and
 * whitespace-only strings are null, as are null, undefined, booleans,
 * objects, NaN and ±Infinity. No rounding.
 */
export function parseFiniteOrNull(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
