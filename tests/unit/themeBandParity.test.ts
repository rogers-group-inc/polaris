/**
 * tests/unit/themeBandParity.test.ts
 *
 * The sidebar band and the phone's theme strip are the same control on two
 * screens: one artwork, one clock, one direction of travel. They are
 * implemented twice because mobile.html loads none of the desktop's JavaScript
 * and vice versa — the same reason THEMES and MOBILE_THEMES are two lists —
 * so nothing but a test can stop the two halves drifting apart.
 *
 * What drift looks like: the same theme sitting under the marker at a
 * different place on a phone than on a desk, a theme added to one screen and
 * not the other, or one side's travel quietly running the day backwards. None
 * of those break a page, which is why none of them would be noticed.
 *
 * This reads both files as text rather than importing them — neither is a
 * module, and evaluating them needs a DOM each. The position tables are lifted
 * verbatim and compared.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");
const MOBILE_APP_JS = readFileSync(
  join(process.cwd(), "public", "js", "mobile", "app.js"),
  "utf-8",
);

/** Lifts `var <name> = { … };` and evaluates just that literal. */
function positions(src: string, name: string): Record<string, number> {
  const decl = `var ${name} = {`;
  const start = src.indexOf(decl);
  if (start < 0) throw new Error(`${name} not found`);
  const end = src.indexOf("};", start);
  const literal = src.slice(start + decl.length - 1, end + 1);
  return new Function(`return ${literal};`)() as Record<string, number>;
}

const DESKTOP = positions(APP_JS, "THEME_BAND_POS");
const PHONE = positions(MOBILE_APP_JS, "THEME_STRIP_POS");

describe("the band and the strip read the same clock", () => {
  it("places every theme at the same point on the strip", () => {
    // Not "close enough": these are the same engraving at the same anchor, so
    // any difference at all is one side having been edited alone.
    expect(DESKTOP).toEqual(PHONE);
  });

  it("names the same set of themes on both screens", () => {
    // A theme added to one list and not the other renders a control that
    // travels to a position nothing selects, or one that cannot reach a
    // palette the other screen offers.
    expect(Object.keys(DESKTOP).sort()).toEqual(Object.keys(PHONE).sort());
  });

  it("steps by exactly a quarter of the strip on both", () => {
    const order = ["noon", "afternoon", "nightfall", "morning"];
    for (const table of [DESKTOP, PHONE]) {
      for (let i = 1; i < order.length; i++) {
        expect(table[order[i]] - table[order[i - 1]]).toBeCloseTo(0.25, 10);
      }
    }
  });

  it("renders the same artwork on both", () => {
    expect(APP_JS).toContain('"/img/brand/time-strip.png"');
    expect(MOBILE_APP_JS + readFileSync(
      join(process.cwd(), "public", "js", "mobile", "more-tab.js"), "utf-8",
    )).toContain("/img/brand/time-strip.png");
  });

  it("gives both the same 800ms travel, matching the palette crossfade", () => {
    expect(APP_JS).toContain("var THEME_FADE_MS = 800;");
    expect(MOBILE_APP_JS).toContain("var THEME_FADE_MS = 800;");
  });

  it("rounds the sun's glow on morning -> noon on both, keyed on the glow's own 2 s", () => {
    // The shape is a keyframe animation on data-glow-turn, which both scripts
    // hold for GLOW_MS. Noon's rule must not transition the glow's size: a
    // running transition outranks the animation and would flatten the circle.
    for (const js of [APP_JS, MOBILE_APP_JS]) {
      expect(js).toContain("var GLOW_MS = 2000;");
      expect(js).toContain('root.setAttribute("data-glow-turn", fromId + "-" + toId);');
    }
    for (const name of ["styles.css", "mobile.css"]) {
      const css = readFileSync(join(process.cwd(), "public", "css", name), "utf-8");
      expect(css).toContain('html[data-glow-turn="morning-noon"] {\n  animation: page-glow-round 2000ms');
      expect(css).toContain("25%, 75% { --page-glow-w: 65vmin; --page-glow-h: 65vmin; }");
      const noon = css.slice(css.indexOf('html[data-theme="noon"] {'), css.indexOf("}", css.indexOf('html[data-theme="noon"] {')));
      expect(noon).not.toContain("--page-glow-w");
      expect(noon).not.toContain("--page-glow-h");
    }
  });

  it("slows the same step on both, by the same amount, in JS and CSS alike", () => {
    // Nightfall -> morning takes 1.6 s. The JS holds the fading attribute (and
    // the seam) that long; the CSS gives the palette and the travel the same
    // duration. A mismatch either cuts the fade short or lands the band early.
    const decl = "var THEME_LEG_MS = { morning: 1600 };";
    expect(APP_JS).toContain(decl);
    expect(MOBILE_APP_JS).toContain(decl);
    const styles = readFileSync(join(process.cwd(), "public", "css", "styles.css"), "utf-8");
    const mobile = readFileSync(join(process.cwd(), "public", "css", "mobile.css"), "utf-8");
    expect(styles).toContain('html[data-theme-fading][data-theme="morning"] .theme-band-track { transition-duration: 1600ms; }');
    expect(mobile).toContain('html[data-theme-fading][data-theme="morning"] .theme-strip-track { transition-duration: 1600ms; }');
  });

  it("anchors both tracks one strip width left of the marker", () => {
    // The `+ 1` is the anchor, and it is what the three copies of the art
    // exist to cover. Drop it on one side and that screen shows bare surface
    // beside the engraving as the position nears the seam.
    const anchor = "getBoundingClientRect().width / 2 - (";
    expect(APP_JS).toContain(anchor + "_bandPos + 1) * stripW");
    expect(MOBILE_APP_JS).toContain(anchor + "_stripPos + 1) * stripW");
  });

  it("normalises the seam by a whole strip on both", () => {
    expect(APP_JS).toContain("_bandPos -= 1;");
    expect(MOBILE_APP_JS).toContain("_stripPos -= 1;");
  });

  it("travels forward only on both", () => {
    // The loop that keeps adding a whole strip until the target is ahead is
    // the entire reason the day reads as moving one way.
    expect(APP_JS).toContain("while (forward <= 0) forward += 1;");
    expect(MOBILE_APP_JS).toContain("while (forward <= 0) forward += 1;");
  });

  it("gives every theme on the strip its own mobile palette", () => {
    // A theme with no block in mobile.css falls back to :root's neutral
    // Material greys and still "works", which is how nightfall shipped grey
    // on the phone beside the desktop's indigo.
    const css = readFileSync(join(process.cwd(), "public", "css", "mobile.css"), "utf-8");
    for (const id of Object.keys(PHONE)) {
      const start = css.indexOf(`[data-theme="${id}"] {`);
      expect(start, `no [data-theme="${id}"] block in mobile.css`).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf("}", start));
      expect(block, `${id} block sets no --md-surface`).toMatch(/--md-surface:\s*#/);
    }
  });
});
