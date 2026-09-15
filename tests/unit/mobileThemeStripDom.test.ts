/**
 * tests/unit/mobileThemeStripDom.test.ts
 *
 * The phone's theme control is a STRIP — the desktop dial's clockface unrolled,
 * travelling left under a fixed marker — and it replaced a two-way Dark/Light
 * row. Six things are worth pinning:
 *
 *  - that `afternoon` answers the DAYLIGHT family. `PolarisTheme.get()` is
 *    family-wise and is what map-tab picks its basemap with and topology-tab
 *    its node palette; an id comparison there flipped both to dark halfway
 *    through the sweep, which is the bug this port had to avoid;
 *  - that a TRANSIT palette is applied but NEVER persisted, so a reload
 *    mid-sweep lands on a real theme the picker can name;
 *  - the QUARTER SPACING of THEME_STRIP_POS — the engraving is a 24-hour clock,
 *    so six hours is a quarter of it and the two faces land half a strip apart.
 *    A position edited alone silently puts the marker beside a face rather
 *    than on it;
 *  - that the strip only ever travels LEFT, including across the wrap, since
 *    that one-way rule is the whole reason the day reads as moving forward;
 *  - the SEAM: a leg landing past the end of copy one is normalised back by
 *    exactly one strip width with the transition off. It is invisible only
 *    because the pixel under every point is identical, so the subtraction has
 *    to be a whole strip and must never happen mid-transition; and
 *  - that the tap is DELEGATED — a second listener advances two themes per tap.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MOBILE_CSS = readFileSync(join(process.cwd(), "public", "css", "mobile.css"), "utf-8");

const MOBILE_APP_JS = readFileSync(
  join(process.cwd(), "public", "js", "mobile", "app.js"),
  "utf-8",
);
const MORE_TAB_JS = readFileSync(
  join(process.cwd(), "public", "js", "mobile", "more-tab.js"),
  "utf-8",
);

/** Lifts a brace-balanced block starting at `opener`, verbatim. */
function extractBlock(src: string, opener: string, from = 0): string {
  const start = src.indexOf(opener, from);
  if (start < 0) throw new Error(`${opener} not found`);
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

const extractFn = (name: string) => extractBlock(MOBILE_APP_JS, `function ${name}(`);

function extractDecl(decl: string, close: string): string {
  const start = MOBILE_APP_JS.indexOf(decl);
  const end = MOBILE_APP_JS.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`${decl} not found`);
  return MOBILE_APP_JS.slice(start, end + close.length);
}

const harness = [
  extractDecl("var MOBILE_THEMES = [", "];"),
  extractDecl("var MOBILE_TRANSIT_THEMES = [", "];"),
  extractDecl("var MOBILE_THEME_IDS = {", "};"),
  extractDecl("var THEME_STRIP_POS = {", "};"),
  "var THEME_FADE_MS = 800;",
  "var _stripPos = null, _stripSeamTimer = null, _themeFadeTimer = null;",
  "var _themeDest = null, _themeChainTimer = null;",
  extractFn("_mobileTheme"),
  extractFn("_themeStripTracks"),
  extractFn("_paintThemeStrips"),
  extractFn("_advanceThemeStrips"),
  extractFn("_beginThemeFade"),
  extractBlock(MOBILE_APP_JS, "window.PolarisTheme = {") + ";",
  "return { POS: THEME_STRIP_POS, THEMES: MOBILE_THEMES, TRANSIT: MOBILE_TRANSIT_THEMES,",
  "         theme: _mobileTheme, api: window.PolarisTheme };",
].join("\n");

type Api = {
  POS: Record<string, number>;
  THEMES: Array<{ id: string; label: string; family: string }>;
  TRANSIT: Array<{ id: string; label: string; family: string; transit?: boolean }>;
  theme: (id?: string) => { id: string; label: string; family: string; transit?: boolean };
  api: {
    getId: () => string;
    get: () => string;
    set: (theme: string, phase?: string) => void;
    advance: () => void;
    seatStrips: () => void;
    currentLabel: () => string;
  };
};

const STRIP_W = 1885; // the art at a 72px row: 3456 x 132 scaled by height
const WIN_W = 390;    // a phone window

const STRIP_HTML =
  '<div class="theme-strip-row">' +
  '<button class="theme-strip" id="theme-strip">' +
  '<span class="theme-strip-track">' +
  '<img src="/img/brand/time-strip.png"><img src="/img/brand/time-strip.png"><img src="/img/brand/time-strip.png">' +
  "</span>" +
  '<span class="theme-strip-marker"></span>' +
  "</button>" +
  '<div class="theme-strip-caption"><span class="name theme-strip-name">Nightfall</span></div>' +
  "</div>";

/** happy-dom has no layout, so the two widths the painter measures are stubbed. */
function mountStrip() {
  document.body.innerHTML = STRIP_HTML + '<meta name="theme-color" content="#1d2024">';
  const win = document.querySelector<HTMLElement>(".theme-strip")!;
  win.getBoundingClientRect = () => ({ width: WIN_W }) as DOMRect;
  document.querySelectorAll<HTMLElement>(".theme-strip-track img").forEach((img) => {
    img.getBoundingClientRect = () => ({ width: STRIP_W }) as DOMRect;
  });
}

function trackX(): number {
  const t = document.querySelector<HTMLElement>(".theme-strip-track")!;
  const m = /translateX\((-?[\d.]+)px\)/.exec(t.style.transform);
  if (!m) throw new Error(`no translate on the track: "${t.style.transform}"`);
  return Number(m[1]);
}

/** Recovers _stripPos from the painted transform: x = winW/2 - (pos+1)*stripW */
function stripPos(): number {
  return (WIN_W / 2 - trackX()) / STRIP_W - 1;
}

function freshApi(): Api {
  return new Function(harness)() as Api;
}

describe("THEME_STRIP_POS", () => {
  const api = freshApi();

  it("carries a position for every selectable theme and every waypoint", () => {
    const ids = [...api.THEMES, ...api.TRANSIT].map((t) => t.id).sort();
    expect(Object.keys(api.POS).sort()).toEqual(ids);
  });

  it("steps by exactly a quarter of the strip, in day order", () => {
    // Six hours of a 24-hour engraving. The two faces (noon, nightfall) must
    // land half a strip apart, the way noon and midnight do on a clock.
    const order = ["noon", "afternoon", "nightfall", "morning"];
    for (let i = 1; i < order.length; i++) {
      expect(api.POS[order[i]] - api.POS[order[i - 1]]).toBeCloseTo(0.25, 10);
    }
    expect(Math.abs(api.POS.nightfall - api.POS.noon)).toBeCloseTo(0.5, 10);
  });
});

describe("theme families", () => {
  const api = freshApi();

  it("puts the afternoon waypoint in the DAYLIGHT family", () => {
    // map-tab's basemap and topology-tab's node palette both read this. An id
    // comparison here turned the phone dark in the middle of the sweep.
    expect(api.theme("afternoon").family).toBe("light");
    expect(api.theme("afternoon").transit).toBe(true);
    expect(api.theme("morning").family).toBe("light");
    expect(api.theme("nightfall").family).toBe("dark");
  });

  it("falls back to nightfall for a retired or unknown id", () => {
    expect(api.theme("dark").id).toBe("nightfall");
    expect(api.theme("light").id).toBe("nightfall");
  });

  it("keeps afternoon out of the selectable list", () => {
    expect(api.THEMES.map((t) => t.id)).toEqual(["morning", "noon", "nightfall"]);
    expect(api.THEMES.map((t) => t.id)).not.toContain("afternoon");
  });
});

describe("PolarisTheme.set", () => {
  let api: Api;

  beforeEach(() => {
    vi.useFakeTimers();
    api = freshApi();
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "nightfall");
    document.documentElement.removeAttribute("data-theme-fading");
    mountStrip();
  });

  afterEach(() => vi.useRealTimers());

  it("stores a selectable theme on the root element and in localStorage", () => {
    api.api.set("morning");
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
    expect(localStorage.getItem("polaris-theme")).toBe("morning");
  });

  it("applies a transit palette but never persists it", () => {
    localStorage.setItem("polaris-theme", "noon");
    api.api.set("afternoon");
    expect(document.documentElement.getAttribute("data-theme")).toBe("afternoon");
    expect(localStorage.getItem("polaris-theme")).toBe("noon");
  });

  it("answers the daylight family while the waypoint is showing", () => {
    api.api.set("afternoon");
    expect(api.api.get()).toBe("light");
  });

  it("names the current theme in the caption", () => {
    api.api.set("morning");
    expect(document.querySelector(".theme-strip-name")!.textContent).toBe("Morning");
    api.api.set("afternoon");
    expect(document.querySelector(".theme-strip-name")!.textContent).toBe("Afternoon");
  });

  it("keeps the installed app's chrome colour in step with the FAMILY", () => {
    api.api.set("noon");
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute("content")).toBe("#eef0f7");
    api.api.set("nightfall");
    expect(document.querySelector('meta[name="theme-color"]')!.getAttribute("content")).toBe("#1d2024");
  });

  it("arms the crossfade only for a real change", () => {
    api.api.set("nightfall");
    expect(document.documentElement.hasAttribute("data-theme-fading")).toBe(false);
    api.api.set("morning");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("solo");
  });
});

describe("the strip travels", () => {
  let api: Api;

  beforeEach(() => {
    vi.useFakeTimers();
    api = freshApi();
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "morning");
    mountStrip();
    api.api.seatStrips();
  });

  afterEach(() => vi.useRealTimers());

  it("seats on the current theme before the first tap", () => {
    expect(stripPos()).toBeCloseTo(api.POS.morning, 6);
  });

  it("fades noon -> nightfall THROUGH the afternoon waypoint", () => {
    api.api.advance(); // -> noon
    api.api.advance(); // -> afternoon, then nightfall
    expect(document.documentElement.getAttribute("data-theme")).toBe("afternoon");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("in");
    vi.advanceTimersByTime(800);
    expect(document.documentElement.getAttribute("data-theme")).toBe("nightfall");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("out");
    expect(localStorage.getItem("polaris-theme")).toBe("nightfall");
  });

  it("only ever travels FORWARD through the day, a quarter per leg", () => {
    // Measured on the settled position rather than the raw transform: the seam
    // deliberately snaps the transform a whole strip to the RIGHT once per
    // revolution, and that jump is invisible precisely because it lands on
    // identical pixels. What must never happen is a BACKWARDS move through the
    // day — a gap of 0.75 here would mean the strip rewound through the
    // afternoon to reach morning instead of carrying on round.
    const gap = (x: number, y: number) => ((y - x) % 1 + 1) % 1;
    let prev = stripPos();
    const steps: number[] = [];
    for (let i = 0; i < 6; i++) {
      api.api.advance();
      vi.advanceTimersByTime(800 * 3); // both legs plus the seam normalisation
      const now = stripPos();
      steps.push(Number(gap(prev, now).toFixed(6)));
      prev = now;
    }
    // A single-leg tap moves a quarter; noon -> nightfall covers two.
    expect(steps).toEqual([0.25, 0.5, 0.25, 0.25, 0.5, 0.25]);
  });

  it("normalises the seam by exactly one strip width, unanimated", () => {
    // morning -> noon is the leg that crosses the end of copy one.
    api.api.advance();
    const landed = stripPos();
    expect(landed).toBeGreaterThan(1); // past the seam, mid-transition
    vi.advanceTimersByTime(800);
    const settled = stripPos();
    expect(landed - settled).toBeCloseTo(1, 6); // a WHOLE strip, not a fraction
    expect(settled).toBeCloseTo(api.POS.noon, 6);
  });

  it("steps on from the DESTINATION when tapped mid-sweep", () => {
    api.api.advance(); // -> noon
    vi.advanceTimersByTime(800 * 2);
    api.api.advance(); // starts noon -> afternoon -> nightfall
    expect(document.documentElement.getAttribute("data-theme")).toBe("afternoon");
    api.api.advance(); // tapped while the waypoint shows
    // Treating afternoon as "current" would aim back at noon and never reach
    // morning.
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
  });
});

describe("the More tab's strip markup", () => {
  it("repeats the art three times, not two", () => {
    // The track is anchored one strip width left of the marker, so copies one
    // and three cover the window either side. With two, bare surface shows on
    // the right as the position approaches the seam.
    const row = MORE_TAB_JS.slice(
      MORE_TAB_JS.indexOf('theme-strip-row'),
      MORE_TAB_JS.indexOf("theme-strip-marker"),
    );
    expect(row.match(/time-strip\.png/g)).toHaveLength(3);
  });

  it("delegates the tap instead of wiring its own listener", () => {
    expect(MORE_TAB_JS).not.toContain('getElementById("theme-strip")');
    expect(MOBILE_APP_JS).toContain('e.target.closest(".theme-strip")');
  });

  it("retired the two-way Dark/Light row", () => {
    expect(MORE_TAB_JS).not.toContain("theme-toggle-row");
    expect(MORE_TAB_JS).not.toContain("theme-current-label");
  });

  it("seats the strip, since the tab is built long after boot", () => {
    expect(MORE_TAB_JS).toContain("PolarisTheme.seatStrips()");
  });
});

describe("the strip track carries no filter", () => {
  // A brightness() was added here and reverted in the same session: the
  // contrast measurement behind it was really describing the desktop dial's
  // rendering bug, not the artwork. The phone strip translates rather than
  // rotates, so it is not the same bug - but nothing has looked at it on a real
  // phone, so it stays unfiltered until something does.
  it("has no brightness lift on the track or the art inside it", () => {
    expect(MOBILE_CSS).not.toContain("--strip-lift");
    expect(MOBILE_CSS).not.toMatch(/\.theme-strip-track\s*\{[^}]*filter:/);
  });
});
