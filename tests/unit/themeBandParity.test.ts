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

  it("sizes the strip's art up front on both, so it seats before it decodes", () => {
    // Each screen's art carries its own intrinsic size (desktop 1676 x 64,
    // phone 3456 x 132); with width/height on each <img> the strip can be
    // measured and seated in the first paint.
    const moreTab = readFileSync(join(process.cwd(), "public", "js", "mobile", "more-tab.js"), "utf-8");
    expect(moreTab).toContain('width="3456" height="132"');
    expect(moreTab).toContain("stripImg() + stripImg() + stripImg()");
    expect(APP_JS).toContain("var THEME_BAND_ART_W = 1676, THEME_BAND_ART_H = 64;");
  });

  it("renders the same artwork on both, each at its own resolution", () => {
    // One engraving, two files: the desktop draws the strip 32 px tall and
    // takes a 2x copy (1676 x 64, 31 KB); the phone draws it 72 px tall and
    // keeps the full 3456 x 132 (88 KB). Both WebP — the shared PNG was 757 KB.
    // Positions are fractions of the strip's width, so the two must keep the
    // same aspect ratio or the same theme sits at two different places.
    expect(APP_JS).toContain('var THEME_BAND_ART = "/img/brand/time-strip-desktop.webp";');
    expect(readFileSync(join(process.cwd(), "public", "js", "mobile", "more-tab.js"), "utf-8"))
      .toContain('"/img/brand/time-strip.webp"');
    const webpSize = (file: string) => {
      // VP8 (lossy) WebP: 14-bit width/height at bytes 26-29 of the file.
      const b = readFileSync(join(process.cwd(), "public", "img", "brand", file));
      expect(b.toString("ascii", 0, 4)).toBe("RIFF");
      expect(b.toString("ascii", 12, 16)).toBe("VP8 ");
      return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    };
    const desk = webpSize("time-strip-desktop.webp");
    const phone = webpSize("time-strip.webp");
    expect(desk).toEqual({ w: 1676, h: 64 });
    expect(phone).toEqual({ w: 3456, h: 132 });
    expect(Math.abs(desk.w / desk.h - phone.w / phone.h)).toBeLessThan(0.01);
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
      // Line endings normalised: the multi-line snippets below are written with
      // "\n", and a Windows checkout (core.autocrlf) has "\r\n" — it failed
      // there while passing in CI, the outageMarkers trap.
      const css = readFileSync(join(process.cwd(), "public", "css", name), "utf-8").replace(/\r\n/g, "\n");
      expect(css).toContain('html[data-glow-turn="morning-noon"] {\n  animation: page-glow-round 2000ms');
      // Round at constant width: only the height moves, up to the oval's width.
      expect(css).toMatch(/12\.5%, 75% \{ --page-glow-h: 1[48]0vw; \}/);
      const keyframes = css.slice(css.indexOf("@keyframes page-glow-round"), css.indexOf("}\n}", css.indexOf("@keyframes page-glow-round")));
      expect(keyframes).not.toContain("--page-glow-w");
      // Noon -> nightfall's glow runs 2.5 s, keyed on the afternoon waypoint.
      expect(css).toContain('html[data-glow-turn][data-theme="afternoon"] {\n  transition-duration: 2500ms;\n}');
      // Glow transitions only during a theme change, never on page load.
      expect(css).toContain("html[data-glow-turn] {\n  transition-property: --page-glow-y,");
      expect(css).not.toContain("html {\n  transition-property: --page-glow-y,");
      const noon = css.slice(css.indexOf('html[data-theme="noon"] {'), css.indexOf("}", css.indexOf('html[data-theme="noon"] {')));
      expect(noon).not.toContain("--page-glow-w");
      expect(noon).not.toContain("--page-glow-h");
    }
  });

  it("keeps the glow off the inherited style of the page, on both", () => {
    // Inheriting glow parts restyled all ~4,200 elements of a busy page on
    // every frame of a 2-2.5 s turn (1.6-2 s of style recalculation). The
    // parts must not inherit, and the gradient tokens must live on the one
    // fixed layer that paints them — on :root an unregistered token is
    // inherited by everything and brings the full-page restyle back.
    for (const name of ["styles.css", "mobile.css"]) {
      const css = readFileSync(join(process.cwd(), "public", "css", name), "utf-8").replace(/\r\n/g, "\n");
      const glowProps = css.match(/@property --(?:page|night)-glow-[a-z0-9]+ *\{[^}]*\}/g) || [];
      expect(glowProps.length).toBe(15);
      for (const p of glowProps) expect(p, p).toContain("inherits: false;");
      // The selector may be a list (the desktop's top-bar curtain shares it).
      const at = css.search(/\nhtml::before[,\s][^{]*\{/);
      expect(at).toBeGreaterThan(-1);
      const layer = css.slice(at, css.indexOf("\n}\n", at));
      expect(layer).toContain("position: fixed;");
      expect(layer).toContain("z-index: -1;");
      expect(layer).toContain("--page-glow:");
      expect(layer).toContain("background: var(--page-glow);");
      const root = css.slice(css.indexOf(":root {"), css.indexOf("\n}\n", css.indexOf(":root {")));
      expect(root).not.toMatch(/\n {2}--page-glow:/);
      expect(root).not.toMatch(/\n {2}--night-glow:/);
    }
  });

  it("paints the top bar's curtain from the glow layer's own tokens, pinned from the first pixel", () => {
    // The curtain hides content under the sticky bar by repainting the page's
    // ground over it. It must share the glow layer's rule (the only place the
    // non-inheriting glow parts can be pulled in), or it paints a stale glow —
    // a box — during every theme turn. And the bar must reach over all of
    // .main's top padding, or the header slides on the first scroll.
    // Its position is MEASURED, never scroll-linked: anchor positioning made
    // Firefox move it with the scroll until layout caught up, so content
    // showed through the bar on every scroll.
    const css = readFileSync(join(process.cwd(), "public", "css", "styles.css"), "utf-8").replace(/\r\n/g, "\n");
    expect(css).toMatch(/\nhtml::before,\nhtml\[data-page-top-curtain\]::after \{/);
    expect(css).not.toMatch(/position-anchor|anchor-name/);
    // The LAST match: the first is the glow layer's shared selector list.
    const at = css.lastIndexOf("\nhtml[data-page-top-curtain]::after {");
    const curtain = css.slice(at, css.indexOf("\n}\n", at));
    expect(curtain).toContain("position: fixed;");
    expect(curtain).toContain("--page-top-h: inherit;");
    expect(curtain).toContain("--page-top-l: inherit;");
    for (const p of ["--page-top-h", "--page-top-l"]) {
      expect(css).toMatch(new RegExp(`@property ${p} \\{[^}]*inherits: false;`));
    }
    expect(curtain).toContain("background-color: var(--color-bg-secondary);");
    expect(curtain).toContain("background-attachment: fixed;");
    const z = (s: string) => Number(s.match(/z-index: (\d+);/)?.[1]);
    const bar = css.slice(css.indexOf(".page-top-sticky {"), css.indexOf("\n}\n", css.indexOf(".page-top-sticky {")));
    expect(z(curtain)).toBe(z(bar) - 1);
    const main = css.slice(css.indexOf("\n.main {"), css.indexOf("\n}\n", css.indexOf("\n.main {")));
    const mainPadTop = main.match(/padding: ([\d.]+rem)/)?.[1];
    expect(bar).toContain(`padding-top: ${mainPadTop};`);
    expect(bar).toContain(`margin-top: -${mainPadTop};`);
    // Every page that pins a bar loads the script that measures it, and the
    // script never listens to scroll.
    const measurer = readFileSync(join(process.cwd(), "public", "js", "page-top-curtain.js"), "utf-8");
    expect(measurer).not.toMatch(/["']scroll["']/);
    expect(measurer).toContain('setAttribute("data-page-top-curtain"');
    for (const page of ["index.html", "dash.html", "server-settings.html", "integrations.html"]) {
      const html = readFileSync(join(process.cwd(), "public", page), "utf-8");
      expect(html, page).toContain("page-top-sticky");
      expect(html, page).toContain('<script src="/js/page-top-curtain.js"></script>');
    }
  });

  it("slides the night glow in as a circle and out into one, on both", () => {
    // A circle while it slides, an oval at rest — keyframes on data-glow-turn,
    // the slide-in keyed on BOTH legs' values so the waypoint does not restart
    // it. The size must be out of every transition list (a running transition
    // outranks an animation) and in lengths, not percentages (a %-to-vw frame
    // is a mixed calc() Chromium rejects, blanking the background).
    for (const name of ["styles.css", "mobile.css"]) {
      const css = readFileSync(join(process.cwd(), "public", "css", name), "utf-8").replace(/\r\n/g, "\n");
      expect(css).toContain('html[data-glow-turn="noon-afternoon"],\nhtml[data-glow-turn="afternoon-nightfall"] {\n  animation: night-glow-in 2500ms');
      expect(css).toContain('html[data-glow-turn="nightfall-morning"] {\n  animation: night-glow-out 2000ms');
      expect(css).toContain("@keyframes night-glow-in");
      expect(css).toContain("@keyframes night-glow-out");
      expect(css).toContain('@property --night-glow-w { syntax: "<length>"');
      expect(css).toContain('@property --night-glow-h { syntax: "<length>"');
      for (const list of css.match(/transition-property:[^;]*;/g) || []) {
        expect(list).not.toContain("--night-glow-w");
        expect(list).not.toContain("--night-glow-h");
      }
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
