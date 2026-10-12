/**
 * tests/unit/severityPaletteTokens.test.ts
 *
 * The browser's severity palette is one --color-sev-<level> token per alert
 * severity (styles.css): every severity surface reads it — chart bands, the
 * .badge-level-* pills, severity-coloured tags, the alert dot. These pin the
 * three things that let it drift: a level missing from a theme block, a badge
 * reading some other token, and the phone's daylight palette disagreeing with
 * the desktop's.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const STYLES = readFileSync(resolve(__dirname, "../../public/css/styles.css"), "utf8").replace(/\r\n/g, "\n");
const MOBILE = readFileSync(resolve(__dirname, "../../public/css/mobile.css"), "utf8").replace(/\r\n/g, "\n");
const LEVELS = ["notice", "informational", "warning", "serious", "critical"];
const DAYLIGHT = ':is([data-theme="morning"],[data-theme="noon"],[data-theme="afternoon"]) {';

/** The declarations of the first rule whose selector line is exactly `selector`. */
function block(css: string, selector: string): string {
  const at = css.indexOf("\n" + selector + "\n") >= 0 ? css.indexOf("\n" + selector + "\n") : css.indexOf("\n" + selector);
  expect(at, `no rule ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", at);
  return css.slice(open + 1, css.indexOf("\n}", open));
}

function tokens(body: string, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(new RegExp("(" + prefix + "[a-z]+):\\s*([^;]+);", "g"))) out[m[1]] = m[2].trim();
  return out;
}

describe("severity palette tokens", () => {
  it(":root defines all five levels", () => {
    const t = tokens(block(STYLES, ":root {"), "--color-sev-");
    for (const l of LEVELS) expect(t["--color-sev-" + l], l).toBeTruthy();
  });

  it("the daylight block pins five distinct literal hues", () => {
    const t = tokens(block(STYLES, DAYLIGHT), "--color-sev-");
    const five = LEVELS.map((l) => t["--color-sev-" + l]);
    for (const v of five) expect(v, "a daylight severity must be a literal, not a theme token").toMatch(/^#[0-9a-f]{6}$/i);
    expect(new Set(five).size).toBe(5);
  });

  it("each severity badge reads its own token", () => {
    for (const l of LEVELS) {
      expect(STYLES).toMatch(new RegExp("\\.badge-level-" + l + "\\s*\\{\\s*--sev-c:\\s*var\\(--color-sev-" + l + "\\);"));
    }
    // and no daylight override repaints one behind the token's back
    expect(STYLES).not.toMatch(/\[data-theme="afternoon"\]\) \.badge-level-(notice|informational|warning|serious|critical)\b/);
  });

  it("the phone's daylight palette is the desktop's", () => {
    const desk = tokens(block(STYLES, DAYLIGHT), "--color-sev-");
    const phone = tokens(block(MOBILE, DAYLIGHT), "--md-sev-");
    expect(phone["--md-sev-notice"]).toBe(desk["--color-sev-notice"]);
    expect(phone["--md-sev-info"]).toBe(desk["--color-sev-informational"]);
    expect(phone["--md-sev-warning"]).toBe(desk["--color-sev-warning"]);
    expect(phone["--md-sev-serious"]).toBe(desk["--color-sev-serious"]);
    expect(phone["--md-sev-critical"]).toBe(desk["--color-sev-critical"]);
  });
});
