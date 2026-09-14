/**
 * tests/unit/sidebarThemeDialDom.test.ts
 *
 * The theme control is an always-visible sidebar DIAL — bottom-left, below
 * Server Settings and above the version line — not a row in the page-header
 * account menu and no longer a button that opens a list. Five things are worth
 * pinning, each of which has already been got wrong once:
 *
 *  - its POSITION in the renderNav template, since "below Server Settings,
 *    above the version" is the whole request and a template is easy to
 *    reorder by accident;
 *  - that the click is DELEGATED and the template wires no listener of its
 *    own. Two listeners on one dial advance two steps per click;
 *  - the RING TRANSFORM, written to the live node by _setTheme. Re-rendering
 *    the <img> restarts the transition from the new value, so the turn — the
 *    entire feedback of the control — is never seen;
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
  extractDecl("var THEME_WHEEL_ANGLE = {", "};"),
  'var DEFAULT_THEME = "nightfall";',
  'var THEME_WHEEL_ART = "/img/brand/time-wheel.png";',
  "var THEME_FADE_MS = 800;",
  "var _wheelRotation = null, _themeFadeTimer = null, _themeDest = null, _themeChainTimer = null;",
  extractFn("_getTheme"),
  extractFn("_getCurrentTheme"),
  extractFn("isLightTheme"),
  extractFn("_wheelRotationFor"),
  extractFn("_themeWheelRings"),
  extractFn("_seatThemeWheels"),
  extractFn("_beginThemeFade"),
  extractFn("_setTheme"),
  extractFn("_wheelForwardGap"),
  extractFn("advanceTheme"),
  extractFn("_sunIcon"),
  extractFn("_sunriseIcon"),
  extractFn("_starIcon"),
  "return { setTheme: _setTheme, advanceTheme: advanceTheme, isLightTheme: isLightTheme,",
  "         getTheme: _getTheme, THEMES: THEMES, TRANSIT_THEMES: TRANSIT_THEMES,",
  "         ANGLE: THEME_WHEEL_ANGLE, seat: _seatThemeWheels };",
].join("\n");

type Api = {
  setTheme: (theme: string, phase?: string) => void;
  advanceTheme: () => void;
  isLightTheme: (id?: string) => boolean;
  getTheme: (id?: string) => { id: string; label: string; family: string; transit?: boolean };
  THEMES: Array<{ id: string; label: string; family: string }>;
  TRANSIT_THEMES: Array<{ id: string; label: string; family: string; transit?: boolean }>;
  ANGLE: Record<string, number>;
  seat: (deg?: number) => void;
};

/** A fresh evaluation, so the module-scope dial state can't leak between tests. */
function freshApi(): Api {
  return new Function(harness)() as Api;
}

const DIAL_HTML =
  '<button id="btn-theme-wheel" class="theme-wheel">' +
  '<span class="theme-wheel-window"><img class="theme-wheel-ring" id="theme-wheel-ring"></span>' +
  '<span class="theme-wheel-notch"></span>' +
  '<span class="theme-wheel-label" id="theme-wheel-label">Nightfall</span>' +
  "</button>";

function ringDeg(): number {
  const el = document.querySelector<HTMLElement>(".theme-wheel-ring")!;
  const m = /rotate\((-?[\d.]+)deg\)/.exec(el.style.transform);
  if (!m) throw new Error(`no rotation on the ring: "${el.style.transform}"`);
  return Number(m[1]);
}

describe("sidebar theme dial placement", () => {
  it("renders the dial between the Server Settings link and the version line", () => {
    const serverSettings = APP_JS.indexOf('href="/server-settings.html" class="sidebar-bottom-link');
    const dial = APP_JS.indexOf('id="btn-theme-wheel"');
    const version = APP_JS.indexOf('<div id="sidebar-version"');
    expect(serverSettings).toBeGreaterThan(-1);
    expect(dial).toBeGreaterThan(serverSettings);
    expect(version).toBeGreaterThan(dial);
  });

  it("ships the ring art the dial renders", () => {
    expect(APP_JS).toContain('var THEME_WHEEL_ART = "/img/brand/time-wheel.png"');
    expect(APP_JS).toContain('src="${THEME_WHEEL_ART}"');
  });

  it("seats the ring's starting angle in the markup, so first paint doesn't animate", () => {
    expect(APP_JS).toContain("style=\"transform:rotate(${_wheelRotation}deg)\"");
    expect(APP_JS).toContain("_wheelRotation = -(THEME_WHEEL_ANGLE[_getCurrentTheme()] || 0);");
  });

  it("delegates the click instead of wiring a listener in the template", () => {
    // Two listeners on one dial advance two steps per click, which reads as
    // the control skipping a theme.
    expect(APP_JS).toContain('e.target.closest(".theme-wheel")');
    expect(APP_JS).not.toContain('document.getElementById("btn-theme-wheel")');
  });

  it("retired the theme menu rather than leaving a second way in", () => {
    expect(APP_JS).toContain("function openThemeMenu() { advanceTheme(); }");
    expect(APP_JS).not.toContain("openThemeMenu(themeBtn)");
    expect(APP_JS).not.toContain('id="btn-theme-toggle"');
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

  it("keeps every theme's dial angle in step with the theme list", () => {
    // An id with no angle silently parks the dial at 0deg (noon's crest) while
    // painting someone else's palette.
    for (const t of [...api.THEMES, ...api.TRANSIT_THEMES]) {
      expect(api.ANGLE[t.id], `no dial angle for ${t.id}`).toBeTypeOf("number");
    }
    expect(Object.keys(api.ANGLE).sort()).toEqual(
      [...api.THEMES, ...api.TRANSIT_THEMES].map((t) => t.id).sort(),
    );
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
    document.body.innerHTML = DIAL_HTML;
    api.seat(-(api.ANGLE.nightfall));
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
    expect(document.querySelector(".theme-wheel-label")!.textContent).toBe("Morning");
    api.setTheme("noon");
    expect(document.querySelector(".theme-wheel-label")!.textContent).toBe("Noon");
    api.setTheme("nightfall");
    expect(document.querySelector(".theme-wheel-label")!.textContent).toBe("Nightfall");
  });

  it("turns the ring by writing transform on the live node", () => {
    const before = document.querySelector(".theme-wheel-ring");
    api.setTheme("morning");
    // Same node, new transform — a re-render would restart the transition from
    // the new value and the turn would never play.
    expect(document.querySelector(".theme-wheel-ring")).toBe(before);
    expect(ringDeg()).toBe(-(api.ANGLE.morning));
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

  it("is a no-op on a page with no dial rather than throwing", () => {
    document.body.innerHTML = "";
    expect(() => api.setTheme("morning")).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
  });
});

describe("advanceTheme", () => {
  let api: Api;

  beforeEach(() => {
    vi.useFakeTimers();
    api = freshApi();
    localStorage.clear();
    document.documentElement.setAttribute("data-theme", "morning");
    document.body.innerHTML = DIAL_HTML;
    api.seat(-(api.ANGLE.morning));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("steps morning -> noon in a single leg", () => {
    api.advanceTheme();
    expect(document.documentElement.getAttribute("data-theme")).toBe("noon");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("solo");
  });

  it("fades noon -> nightfall THROUGH the afternoon waypoint", () => {
    api.advanceTheme(); // -> noon
    api.advanceTheme(); // -> afternoon, then nightfall
    expect(document.documentElement.getAttribute("data-theme")).toBe("afternoon");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("in");
    vi.advanceTimersByTime(800);
    expect(document.documentElement.getAttribute("data-theme")).toBe("nightfall");
    expect(document.documentElement.getAttribute("data-theme-fading")).toBe("out");
    // Only the real theme is remembered.
    expect(localStorage.getItem("polaris-theme")).toBe("nightfall");
  });

  it("turns the ring one way only, 90deg per leg, right round the clock", () => {
    // The wrap from nightfall back to morning is the one that wants to rewind
    // through the afternoon; it must carry forward through the day instead.
    const seen: number[] = [ringDeg()];
    for (let i = 0; i < 6; i++) {
      api.advanceTheme();
      vi.advanceTimersByTime(800 * 2);
      seen.push(ringDeg());
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i], `leg ${i} reversed`).toBeLessThan(seen[i - 1]);
    }
    // One pass through the theme list is one full revolution of the 24-hour
    // face — three clicks, but four legs: noon -> nightfall covers 180deg
    // because it crosses the afternoon waypoint on the way.
    expect(seen[0] - seen[3]).toBe(360);
  });

  it("steps on from the DESTINATION when clicked mid-sweep", () => {
    api.advanceTheme(); // -> noon
    api.advanceTheme(); // starts noon -> afternoon -> nightfall
    expect(document.documentElement.getAttribute("data-theme")).toBe("afternoon");
    api.advanceTheme(); // clicked while the waypoint is showing
    // Treating afternoon as "current" would aim at noon and never reach
    // morning; the destination (nightfall) is what the next step follows.
    expect(document.documentElement.getAttribute("data-theme")).toBe("morning");
  });
});
