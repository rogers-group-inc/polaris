/**
 * tests/unit/sidebarThemeBandDom.test.ts
 *
 * The theme control is an always-visible sidebar BAND — bottom-left, below
 * Server Settings and above the version line — not a row in the page-header
 * account menu and no longer a button that opens a list. It was a rotating
 * DIAL of the same clock until 2026-09-21; the geometry is now the phone's,
 * so `tests/unit/mobileThemeStripDom.test.ts` is its opposite number and
 * `tests/unit/themeBandParity.test.ts` is what keeps the two in step.
 *
 * Seven things are worth pinning, each of which has already been got wrong
 * once on one screen or the other:
 *
 *  - its POSITION in the renderNav template, since "below Server Settings,
 *    above the version" is the whole request and a template is easy to
 *    reorder by accident;
 *  - that the click is DELEGATED and the template wires no listener of its
 *    own. Two listeners on one band advance two steps per click;
 *  - the TRACK TRANSFORM, written to the live node by _setTheme. Re-rendering
 *    the <img> copies restarts the transition from the new value, so the
 *    travel — the entire feedback of the control — is never seen;
 *  - that the band is SEATED after the markup lands rather than positioned in
 *    it. Its position is measured against the rendered artwork, which a
 *    template string cannot know, and renderNav rebuilds the whole rail — an
 *    unseated track sits at the strip's left edge and the next click travels
 *    from there instead of from the theme showing;
 *  - the SEAM: a leg landing past the end of copy one is normalised back by
 *    exactly one strip width with the transition off. That is invisible only
 *    because the pixel under every point is identical, so the subtraction has
 *    to be a whole strip and must never happen mid-transition;
 *  - that a TRANSIT palette is applied but NEVER PERSISTED, so a reload
 *    during the noon -> nightfall sweep lands on a real theme rather than on
 *    a waypoint the picker cannot name; and
 *  - the FALLBACK, which is what a browser holding the retired `dark`/`light`
 *    id lands on after the three-theme cutover. Trusting a saved value that
 *    names no token block would render the whole install unstyled.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP_JS = readFileSync(join(process.cwd(), "public", "js", "app.js"), "utf-8");
const STYLES_CSS = readFileSync(join(process.cwd(), "public", "css", "styles.css"), "utf-8");

function extractFn(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in app.js`);
  let depth = 0;
  let i = APP_JS.indexOf("{", start);
  for (; i < APP_JS.length; i++) {
    if (APP_JS[i] === "{") depth++;
    else if (APP_JS[i] === "}") { depth--; if (depth === 0) break; }
  }
  return APP_JS.slice(start, i + 1);
}

/** An array or object literal lifted verbatim, so the test can't drift from it. */
function extractDecl(decl: string, close: string): string {
  const start = APP_JS.indexOf(decl);
  const end = APP_JS.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`${decl} not found in app.js`);
  return APP_JS.slice(start, end + close.length);
}

const harness = [
  extractDecl("var THEMES = [", "];"),
  extractDecl("var TRANSIT_THEMES = [", "];"),
  extractDecl("var THEME_BAND_POS = {", "};"),
  'var DEFAULT_THEME = "nightfall";',
  'var THEME_BAND_ART = "/img/brand/time-strip.png";',
  "var THEME_FADE_MS = 800;",
  "var _bandPos = null, _bandSeamTimer = null, _themeFadeTimer = null;",
  "var _themeDest = null, _themeChainTimer = null;",
  extractFn("_getTheme"),
  extractFn("_getCurrentTheme"),
  extractFn("isLightTheme"),
  extractFn("_themeBandTracks"),
  extractFn("_paintThemeBands"),
  extractFn("_seatThemeBands"),
  extractFn("_advanceThemeBands"),
  extractFn("_beginThemeFade"),
  extractFn("_setTheme"),
  extractFn("_bandForwardGap"),
  extractFn("advanceTheme"),
  extractFn("_sunIcon"),
  extractFn("_sunriseIcon"),
  extractFn("_starIcon"),
  "return { setTheme: _setTheme, advanceTheme: advanceTheme, isLightTheme: isLightTheme,",
  "         getTheme: _getTheme, THEMES: THEMES, TRANSIT_THEMES: TRANSIT_THEMES,",
  "         POS: THEME_BAND_POS, seat: _seatThemeBands };",
].join("\n");

type Api = {
  setTheme: (theme: string, phase?: string) => void;
  advanceTheme: () => void;
  isLightTheme: (id?: string) => boolean;
  getTheme: (id?: string) => { id: string; label: string; family: string; transit?: boolean };
  THEMES: Array<{ id: string; label: string; family: string }>;
  TRANSIT_THEMES: Array<{ id: string; label: string; family: string; transit?: boolean }>;
  POS: Record<string, number>;
  seat: () => void;
};

/** A fresh evaluation, so the module-scope band state can't leak between tests. */
function freshApi(): Api {
  return new Function(harness)() as Api;
}

const BAND_HTML =
  '<button id="btn-theme-band" class="theme-band">' +
  '<span class="theme-band-window">' +
  '<span class="theme-band-track" id="theme-band-track">' +
  '<img src="/img/brand/time-strip.png"><img src="/img/brand/time-strip.png">' +
  '<img src="/img/brand/time-strip.png">' +
  "</span>" +
  '<span class="theme-band-marker"></span>' +
  "</span>" +
  '<span class="theme-band-label" id="theme-band-label">Nightfall</span>' +
  "</button>";

const STRIP_W = 1257; // the art at a 48px band: 3456 x 132 scaled by height
const WIN_W = 204;    // a 220px rail less its 0.5rem padding either side

/** happy-dom has no layout, so the two widths the painter measures are stubbed. */
function mountBand() {
  document.body.innerHTML = BAND_HTML;
  const win = document.querySelector<HTMLElement>(".theme-band-window")!;
  win.getBoundingClientRect = () => ({ width: WIN_W }) as DOMRect;
  document.querySelectorAll<HTMLElement>(".theme-band-track img").forEach((img) => {
    img.getBoundingClientRect = () => ({ width: STRIP_W }) as DOMRect;
  });
}

function trackX(): number {
  const t = document.querySelector<HTMLElement>(".theme-band-track")!;
  const m = /translateX\((-?[\d.]+)px\)/.exec(t.style.transform);
  if (!m) throw new Error(`no translate on the track: "${t.style.transform}"`);
  return Number(m[1]);
}

/** Recovers _bandPos from the painted transform: x = winW/2 - (pos+1)*stripW */
function bandPos(): number {
  return (WIN_W / 2 - trackX()) / STRIP_W - 1;
}

describe("sidebar theme band placement", () => {
  it("renders the band between the Server Settings link and the version line", () => {
    const serverSettings = APP_JS.indexOf('href="/server-settings.html" class="sidebar-bottom-link');
    const band = APP_JS.indexOf('id="btn-theme-band"');
    const version = APP_JS.indexOf('<div id="sidebar-version"');
    expect(serverSettings).toBeGreaterThan(-1);
    expect(band).toBeGreaterThan(serverSettings);
    expect(version).toBeGreaterThan(band);
  });

  it("ships the strip art the band renders, three copies of it", () => {
    // The track is anchored one strip width left of the marker, so copies one
    // and three cover the window either side. With two, bare surface shows on
    // the right as the position approaches the seam.
    expect(APP_JS).toContain('var THEME_BAND_ART = "/img/brand/time-strip.png"');
    const markup = APP_JS.slice(
      APP_JS.indexOf('id="btn-theme-band"'),
      APP_JS.indexOf("theme-band-marker"),
    );
    expect(markup.match(/\$\{THEME_BAND_ART\}/g)).toHaveLength(3);
  });

  it("seats the band AFTER the markup, never by interpolating a position", () => {
    // The position is measured against the rendered artwork — unknowable while
    // the rail is still a string — and renderNav rebuilds the rail, so each
    // re-render hands the painter a track that has never been positioned.
    expect(APP_JS).toContain("_seatThemeBands();");
    expect(APP_JS).not.toContain("translateX(${");
  });

  it("delegates the click instead of wiring a listener in the template", () => {
    // Two listeners on one band advance two steps per click, which reads as
    // the control skipping a theme.
    expect(APP_JS).toContain('e.target.closest(".theme-band")');
    expect(APP_JS).not.toContain('document.getElementById("btn-theme-band")');
  });

  it("retired the theme menu rather than leaving a second way in", () => {
    expect(APP_JS).toContain("function openThemeMenu() { advanceTheme(); }");
    expect(APP_JS).not.toContain("openThemeMenu(themeBtn)");
    expect(APP_JS).not.toContain('id="btn-theme-toggle"');
  });

  it("left no trace of the rotating dial behind", () => {
    // A stale .theme-wheel rule or a leftover rotation would be dead weight
    // that reads as a second control.
    expect(APP_JS).not.toContain("theme-wheel");
    expect(APP_JS).not.toContain("THEME_WHEEL");
    expect(STYLES_CSS).not.toContain(".theme-wheel");
  });
});

describe("theme band CSS", () => {
  it("fades the window's edges and never the track", () => {
    // A mask on the track travels with it and would fade a moving slice of the
    // artwork instead of the ends of the window.
    expect(STYLES_CSS).toContain(".theme-band-window::after");
    const track = STYLES_CSS.slice(
      STYLES_CSS.indexOf(".theme-band-track {"),
      STYLES_CSS.indexOf(".theme-band-track img"),
    );
    expect(track).not.toContain("mask-image");
    expect(track).not.toContain("filter:");
  });

  it("keeps the track's travel out of the crossfade's transition shorthand", () => {
    // That rule outspecifies the track's own `transition: transform`; replacing
    // it kills the travel, the one animation that must survive a theme change.
    expect(STYLES_CSS).toContain("html[data-theme-fading] *:not(.theme-band-track)");
    // ...and re-asserts the per-leg easing on it by name, so palette and band
    // stay locked together across a multi-leg sweep.
    expect(STYLES_CSS).toContain('html[data-theme-fading="in"] .theme-band-track');
    expect(STYLES_CSS).toContain('html[data-theme-fading="mid"] .theme-band-track');
    expect(STYLES_CSS).toContain('html[data-theme-fading="out"] .theme-band-track');
  });

  it("gives the track the same 800ms the palette crossfade takes", () => {
    // THEME_FADE_MS and this duration are one number in two files; a mismatch
    // makes a multi-leg sweep visibly drift apart.
    const track = STYLES_CSS.slice(
      STYLES_CSS.indexOf(".theme-band-track {"),
      STYLES_CSS.indexOf(".theme-band-track img"),
    );
    expect(track).toContain("transition: transform 800ms");
    expect(APP_JS).toContain("var THEME_FADE_MS = 800;");
  });
});

describe("THEMES", () => {
  const api = freshApi();

  it("lists morning, noon and nightfall in day order", () => {
    expect(api.THEMES.map((t) => t.id)).toEqual(["morning", "noon", "nightfall"]);
  });

  it("puts morning and noon in the daylight family and nightfall in the dark one", () => {
    expect(api.isLightTheme("morning")).toBe(true);
    expect(api.isLightTheme("noon")).toBe(true);
    expect(api.isLightTheme("nightfall")).toBe(false);
  });

  it("treats the retired dark/light ids as unknown, not as themes", () => {
    // They resolve to DEFAULT_THEME (nightfall), so a browser carrying one
    // lands on a real theme rather than on an unstyled page.
    expect(api.isLightTheme("light")).toBe(false);
    expect(api.isLightTheme("dark")).toBe(false);
  });

  it("keeps every theme's band position in step with the theme list", () => {
    // An id with no position silently strands the band where it stands while
    // painting someone else's palette.
    for (const t of [...api.THEMES, ...api.TRANSIT_THEMES]) {
      expect(api.POS[t.id], `no band position for ${t.id}`).toBeTypeOf("number");
    }
    expect(Object.keys(api.POS).sort()).toEqual(
      [...api.THEMES, ...api.TRANSIT_THEMES].map((t) => t.id).sort(),
    );
  });

  it("steps by exactly a quarter of the strip, in day order", () => {
    // Six hours of a 24-hour engraving. The two faces (noon, nightfall) must
    // land half a strip apart, the way noon and midnight do on a clock — edit
    // one position alone and the marker sits beside a face rather than on it.
    const order = ["noon", "afternoon", "nightfall", "morning"];
    for (let i = 1; i < order.length; i++) {
      expect(api.POS[order[i]] - api.POS[order[i - 1]]).toBeCloseTo(0.25, 10);
    }
    expect(Math.abs(api.POS.nightfall - api.POS.noon)).toBeCloseTo(0.5, 10);
  });
});

describe("transit palettes", () => {
  const api = freshApi();

  it("keeps afternoon out of THEMES so nothing can select it", () => {
    expect(api.THEMES.map((t) => t.id)).not.toContain("afternoon");
    expect(api.TRANSIT_THEMES.map((t) => t.id)).toEqual(["afternoon"]);
  });

  it("still resolves afternoon, and in the daylight family", () => {
    // isLightTheme has to answer correctly WHILE the waypoint is showing, or
    // every palette that branches on it flips to dark mid-sweep.
    expect(api.getTheme("afternoon").id).toBe("afternoon");
    expect(api.getTheme("afternoon").transit).toBe(true);
    expect(api.isLightTheme("afternoon")).toBe(true);
  });
});

describe("_setTheme", () => {
  let api: Api;

  beforeEach(() => {
    api = freshApi();
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "nightfall");
    document.documentElement.removeAttribute("data-theme-fading");
    mountBand();
    api.seat();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stores the theme on the root element and in localStorage", () => {
    api.setTheme("morning");
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
    expect(localStorage.getItem("polaris-theme")).toBe("morning");
  });

  it("falls back to nightfall rather than trusting an unrecognized id", () => {
    api.setTheme("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("nightfall");
    expect(localStorage.getItem("polaris-theme")).toBe("nightfall");
  });

  it("applies a transit palette but never persists it", () => {
    // A reload mid-sweep must land on a real theme, not on a waypoint.
    localStorage.setItem("polaris-theme", "noon");
    api.setTheme("afternoon");
    expect(document.documentElement.getAttribute("data-theme")).toBe("afternoon");
    expect(localStorage.getItem("polaris-theme")).toBe("noon");
  });

  it("repaints the label to name the CURRENT theme", () => {
    api.setTheme("morning");
    expect(document.querySelector(".theme-band-label")!.textContent).toBe("Morning");
    api.setTheme("noon");
    expect(document.querySelector(".theme-band-label")!.textContent).toBe("Noon");
    api.setTheme("nightfall");
    expect(document.querySelector(".theme-band-label")!.textContent).toBe("Nightfall");
  });

  it("travels by writing transform on the live track", () => {
    const before = document.querySelector(".theme-band-track");
    api.setTheme("morning");
    // Same node, new transform — a re-render would restart the transition from
    // the new value and the travel would never play.
    expect(document.querySelector(".theme-band-track")).toBe(before);
    expect(bandPos()).toBeCloseTo(api.POS.morning, 6);
  });

  it("arms the crossfade only for a real change", () => {
    api.setTheme("nightfall"); // already showing
    expect(document.documentElement.hasAttribute("data-theme-fading")).toBe(false);
    api.setTheme("morning");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("solo");
  });

  it("announces the change on document so cached palettes can repaint", () => {
    let detail: { theme: string; family: string } | null = null;
    document.addEventListener("themechange", (e) => {
      detail = (e as CustomEvent).detail;
    });
    api.setTheme("noon");
    expect(detail).toEqual({ theme: "noon", family: "light" });
  });

  it("is a no-op on a page with no band rather than throwing", () => {
    document.body.innerHTML = "";
    expect(() => api.setTheme("morning")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
  });
});

describe("the band travels", () => {
  let api: Api;

  beforeEach(() => {
    vi.useFakeTimers();
    api = freshApi();
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "morning");
    document.documentElement.removeAttribute("data-theme-fading");
    mountBand();
    api.seat();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("seats on the current theme before the first click", () => {
    expect(bandPos()).toBeCloseTo(api.POS.morning, 6);
  });

  it("steps morning -> noon in a single leg", () => {
    api.advanceTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("noon");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("solo");
  });

  it("fades noon -> nightfall THROUGH the afternoon waypoint", () => {
    api.advanceTheme(); // -> noon
    vi.advanceTimersByTime(800 * 2);
    api.advanceTheme(); // -> afternoon, then nightfall
    expect(document.documentElement.getAttribute("data-theme")).toBe("afternoon");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("in");
    vi.advanceTimersByTime(800);
    expect(document.documentElement.getAttribute("data-theme")).toBe("nightfall");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("out");
    // Only the real theme is remembered.
    expect(localStorage.getItem("polaris-theme")).toBe("nightfall");
  });

  it("only ever travels FORWARD through the day, a quarter per leg", () => {
    // Measured on the settled position rather than the raw transform: the seam
    // deliberately snaps the transform a whole strip to the RIGHT once per
    // revolution, and that jump is invisible precisely because it lands on
    // identical pixels. What must never happen is a BACKWARDS move through the
    // day — the wrap from nightfall round to morning is the one that wants to
    // rewind through the afternoon, and a gap of 0.75 here would mean it did.
    const gap = (x: number, y: number) => ((y - x) % 1 + 1) % 1;
    let prev = bandPos();
    const steps: number[] = [];
    for (let i = 0; i < 6; i++) {
      api.advanceTheme();
      vi.advanceTimersByTime(800 * 3); // both legs plus the seam normalisation
      const now = bandPos();
      steps.push(Number(gap(prev, now).toFixed(6)));
      prev = now;
    }
    // A single-leg click moves a quarter; noon -> nightfall covers two.
    expect(steps).toEqual([0.25, 0.5, 0.25, 0.25, 0.5, 0.25]);
  });

  it("normalises the seam by exactly one strip width, unanimated", () => {
    // morning -> noon is the leg that crosses the end of copy one.
    api.advanceTheme();
    const landed = bandPos();
    expect(landed).toBeGreaterThan(1); // past the seam, mid-transition
    vi.advanceTimersByTime(800);
    const settled = bandPos();
    expect(landed - settled).toBeCloseTo(1, 6); // a WHOLE strip, not a fraction
    expect(settled).toBeCloseTo(api.POS.noon, 6);
  });

  it("settles an owed seam before measuring the next leg", () => {
    // Clicking again before the normalisation runs would otherwise start the
    // leg a full strip width from where it looks.
    api.advanceTheme(); // morning -> noon, lands past the seam
    expect(bandPos()).toBeGreaterThan(1);
    api.advanceTheme(); // clicked before the seam timer fires
    vi.advanceTimersByTime(800 * 3);
    expect(bandPos()).toBeCloseTo(api.POS.nightfall, 6);
  });

  it("steps on from the DESTINATION when clicked mid-sweep", () => {
    api.advanceTheme(); // -> noon
    vi.advanceTimersByTime(800 * 2);
    api.advanceTheme(); // starts noon -> afternoon -> nightfall
    expect(document.documentElement.getAttribute("data-theme")).toBe("afternoon");
    api.advanceTheme(); // clicked while the waypoint is showing
    // Treating afternoon as "current" would aim at noon and never reach
    // morning; the destination (nightfall) is what the next step follows.
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
  });
});
