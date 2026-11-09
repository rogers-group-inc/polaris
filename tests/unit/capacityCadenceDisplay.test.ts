/**
 * tests/unit/capacityCadenceDisplay.test.ts — the Database card's Cadences row
 * shows whole seconds (public/js/server-settings.js → _fmtCadenceSec).
 *
 * The figures are fleet averages from monitoringService.fleetCadences — the
 * harmonic, rate-weighted mean of every monitored asset's resolved interval
 * (CQ-B012). Mixed cadences give a fraction (100.93645484949833) and even a
 * uniform 60 s fleet carries float noise (60.000000000000014); the card printed
 * both raw. The capacity model keeps the exact value; only the display rounds.
 *
 * Sliced out of the browser script by name, as capacityAlertHoldDom.test.ts does.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(__dirname, "../../public/js/server-settings.js"), "utf8");
const lines = src.split(/\r?\n/);
const start = lines.findIndex((l) => l.startsWith("function _fmtCadenceSec("));
const end = lines.findIndex((l, i) => i > start && l === "}");
// eslint-disable-next-line no-new-func
const fmt = new Function(`${lines.slice(start, end + 1).join("\n")}; return _fmtCadenceSec;`)() as (s: unknown) => string;

describe("Cadences row", () => {
  it("rounds the fleet averages to whole seconds", () => {
    expect(fmt(60.000000000000014)).toBe("60s");
    expect(fmt(100.93645484949833)).toBe("101s");
    expect(fmt(260.5767570367812)).toBe("261s");
  });

  it("never shows 0s, and a missing figure reads as a dash", () => {
    expect(fmt(0.4)).toBe("1s");
    expect(fmt(0)).toBe("-");
    expect(fmt(undefined)).toBe("-");
    expect(fmt(Number.NaN)).toBe("-");
  });

  it("the row uses it for all three streams and says they are averages", () => {
    const row = src.slice(src.indexOf('dbInfoRow("Cadences"'), src.indexOf('dbInfoRow("Cadences"') + 600);
    expect(row.match(/_fmtCadenceSec\(work\.cadences\.\w+\)/g)).toHaveLength(3);
    expect(row).toMatch(/Fleet averages/);
  });
});
