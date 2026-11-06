/**
 * public/js/theme-core.js — the ONE theme engine.
 *
 * Three surfaces carry the same time-of-day control: the sidebar band on every
 * desktop page (app.js), the corner ribbon on the Dash wallboard (dash-boot.js)
 * and the More tab's strip on the phone (mobile/app.js). None of those
 * documents loads the others' JavaScript, which is why each used to carry its
 * own copy of everything below and a test held the copies' numbers equal.
 * Now each page loads this file BEFORE its host script, and the host builds
 * one engine with createThemeEngine(host), passing only what genuinely
 * differs:
 *
 *   track    the selector of the sliding art (".theme-band-track" /
 *            ".theme-strip-track"); the window is the track's parent.
 *   control  the delegated click target (".theme-band" / ".theme-strip").
 *   measure  an element's rendered width. Default getBoundingClientRect —
 *            the wallboard passes layout widths instead, because its ribbon
 *            is ROTATED 45° and getBoundingClientRect answers a rotated
 *            element's axis-aligned box (the strip would seat at the wrong
 *            hour).
 *   onApply  (t, prevId) side effects after the palette and the track have
 *            moved: the aria-label / caption, the phone's status bar.
 *
 * The engine owns data-theme, the saved preference, the crossfade, the glow
 * turn, the track's travel and seam, the waypoint sweep, the `themechange`
 * event, and the delegated click + resize listeners. theme-init.js stays a
 * separate standalone file: it runs in <head> before the CSS on every page,
 * including login and setup, which load none of this.
 *
 * Classic script, no dependencies; every name below is a global the hosts and
 * the unit tests read.
 */

// ─── The catalogue ───────────────────────────────────────────────────────────
//
// Three SELECTABLE themes in two families: `nightfall` is dark, `morning`/
// `noon` share the daylight overrides in styles.css (and each has its own
// Material palette in mobile.css). Listed in day order, which is the order
// the band steps through them. The retired `dark`/`light` ids are not
// recognized anywhere any more — a browser holding one falls through to
// DEFAULT_THEME.
//
// Adding a theme = one entry here, one position in THEME_BAND_POS, one token
// block in styles.css AND in mobile.css, one id in theme-init.js's KNOWN list.
var THEMES = [
  { id: "morning",   label: "Morning",   family: "light" },
  { id: "noon",      label: "Noon",      family: "light" },
  { id: "nightfall", label: "Nightfall", family: "dark" },
];

// Transit palettes: real themes with real token blocks that NOTHING can
// select. They exist so the band has somewhere to be between two selectable
// themes — advance() fades THROUGH each one that lies on the way and carries
// on without stopping, so noon → nightfall crosses the golden hour instead of
// cutting from near-white to indigo. Not in THEMES, so no keyboard step, and
// never persisted.
var TRANSIT_THEMES = [
  { id: "afternoon", label: "Afternoon", family: "light", transit: true },
];

// The fallback for an unknown or retired saved value. Deliberately NOT
// THEMES[0]: display order and the default move independently, so reordering
// the band never changes what a new install lands on.
var DEFAULT_THEME = "nightfall";

// Where each palette sits along the strip art, as a fraction of the strip's
// width. The desktop draws /img/brand/time-strip-desktop.webp and the phone
// /img/brand/time-strip.webp — one engraving at two resolutions with the same
// aspect ratio, so one table serves both. The engraving is a 24-hour clock
// unrolled, so six hours is a quarter of it and the two faces land half a
// strip apart the way noon and midnight should:
//
//   0.056   sun face                -> noon
//   0.306   red-rust late afternoon -> afternoon  (transit only)
//   0.556   moon face               -> nightfall
//   0.806   dawn gold               -> morning
//
// These are not decoration: each palette was sampled from its own position on
// this engraving, so the position and the tokens have to agree. Rightward
// along the strip is forward in time, which is why the ids read in day order.
// The anchor was set by eye on the two FACES (the marker has to sit on the
// face, not beside it) and then stepped by exactly a quarter — changing one
// means changing all four, keeping the quarter spacing and moving the anchor.
var THEME_BAND_POS = { noon: 0.056, afternoon: 0.306, nightfall: 0.556, morning: 0.806 };

// Matches the crossfade duration in styles.css and mobile.css (the
// data-theme-fading blocks). Change one, change the others.
var THEME_FADE_MS = 800;
// Steps that take longer than THEME_FADE_MS, by DESTINATION. Nightfall →
// morning is one step where noon → nightfall gets two (1.6 s), so dark to
// light came in a snap; it takes the same 1.6 s here. Every timer tied to a
// step's length reads _themeLegMs() — the fading attribute's removal (a
// transition whose rule leaves is cut short), the seam normalisation (never
// mid-travel) and the next leg's start — and the [data-theme="morning"] rules
// in the crossfade blocks of styles.css and mobile.css carry the same number
// for the palette and the band's travel.
var THEME_LEG_MS = { morning: 1600 };
function _themeLegMs(id) { return THEME_LEG_MS[id] || THEME_FADE_MS; }

// The page glows run on their own, longer clock (the bare `html` rule in the
// crossfade blocks). data-glow-turn names the turn — "morning-noon" — for that
// long, so a glow animation can key on WHICH turn it is (the sun rounding to a
// circle as it climbs) and outlive data-theme-fading. Change GLOW_MS with the
// CSS's 2000ms.
var GLOW_MS = 2000;

// ─── Lookups ─────────────────────────────────────────────────────────────────

// SELECTABLE ids only — transit palettes are deliberately absent, so a saved
// "afternoon" (which nothing should ever write) is rejected here the same way
// a retired "dark" is, and the browser lands on a real theme.
function _themeExists(id) {
  for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return true;
  return false;
}

/**
 * The theme record for `id`, or DEFAULT_THEME's when it names nothing.
 * Resolves selectable AND transit ids — set() has to be able to apply a
 * waypoint, and isLightTheme has to answer correctly while one is showing.
 */
function _getTheme(id) {
  for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
  for (var j = 0; j < TRANSIT_THEMES.length; j++) if (TRANSIT_THEMES[j].id === id) return TRANSIT_THEMES[j];
  for (var k = 0; k < THEMES.length; k++) if (THEMES[k].id === DEFAULT_THEME) return THEMES[k];
  return THEMES[0];
}

function _getCurrentTheme() {
  return document.documentElement.getAttribute("data-theme") || DEFAULT_THEME;
}

// True for the daylight family. Use this instead of comparing against a theme
// id anywhere a surface picks an image, a basemap or a chart palette by
// brightness — an id check misses morning, noon and the afternoon waypoint.
function isLightTheme(id) {
  return _getTheme(id || _getCurrentTheme()).family === "light";
}
window.isLightTheme = isLightTheme;

// The saved theme, or — with nothing saved (a fresh browser, a wallboard, the
// first launch of the installed phone app) — the OS's: "morning" for a light
// preference, DEFAULT_THEME for dark or for a browser that states no
// preference. Mirrors js/theme-init.js. Writes data-theme and returns the id;
// deliberately does not persist, because staying unsaved is what keeps the
// user tracking their system and the band is the opt-out.
function _applySavedTheme() {
  var saved = null;
  try { saved = localStorage.getItem("polaris-theme"); } catch (e) {}
  if (saved && !_themeExists(saved)) saved = null;
  if (!saved) {
    var light = false;
    try { light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) {}
    saved = light ? "morning" : DEFAULT_THEME;
  }
  document.documentElement.setAttribute("data-theme", saved);
  return saved;
}

// Forward distance from position `a` to position `b` in the band's own
// direction of travel, 0–1. Used to work out which waypoints lie on the way.
function _bandForwardGap(a, b) { return ((b - a) % 1 + 1) % 1; }

// ─── The crossfade ───────────────────────────────────────────────────────────

var _themeFadeTimer = null;
var _glowTurnTimer = null;

function _markGlowTurn(fromId, toId) {
  var root = document.documentElement;
  root.setAttribute("data-glow-turn", fromId + "-" + toId);
  if (_glowTurnTimer) clearTimeout(_glowTurnTimer);
  _glowTurnTimer = setTimeout(function () {
    root.removeAttribute("data-glow-turn");
    _glowTurnTimer = null;
  }, GLOW_MS + 80);
}

function _prefersReducedMotion() {
  try {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { return false; /* no matchMedia — animate */ }
}

// Can this browser crossfade the theme change as ONE picture — a same-document
// view transition WITH types (the types carry the step's easing and length to
// the CSS)? Chromium 125+, Safari 18.2+, Firefox 147+. Anything else takes the
// per-element crossfade (data-theme-xfade). See the "Theme changes as one
// crossfade" blocks in styles.css and mobile.css for why: per-element
// transitions on a busy page were the 100-150 ms frames.
function _themeViewTransitions() {
  try {
    return typeof document.startViewTransition === "function" &&
      typeof ViewTransition !== "undefined" && "types" in ViewTransition.prototype;
  } catch (e) { return false; }
}

// Arms the palette crossfade for the length of one change. Called before
// data-theme moves, so the new values are what gets transitioned TO.
// data-theme-fading drives the band's travel and the timers either way;
// data-theme-xfade switches on the per-element colour transitions, and only
// when the change is NOT a view transition (which crossfades the page whole).
function _beginThemeFade(phase, ms, viaViewTransition) {
  if (_prefersReducedMotion()) return;
  var root = document.documentElement;
  root.setAttribute("data-theme-fading", phase || "solo");
  if (viaViewTransition) root.removeAttribute("data-theme-xfade");
  else root.setAttribute("data-theme-xfade", "");
  if (_themeFadeTimer) clearTimeout(_themeFadeTimer);
  _themeFadeTimer = setTimeout(function () {
    root.removeAttribute("data-theme-fading");
    root.removeAttribute("data-theme-xfade");
    _themeFadeTimer = null;
  }, (ms || THEME_FADE_MS) + 80);
}

// ─── The engine ──────────────────────────────────────────────────────────────

function _rectWidth(el) { return el.getBoundingClientRect().width; }

/**
 * Builds the page's theme engine. One per document: the delegated click and
 * the resize listener are wired once and always drive the most recently
 * built engine (window.__polarisThemeEngine), so a re-evaluated host takes
 * over instead of stacking a second listener — two listeners on one band
 * advance two steps per click.
 */
function createThemeEngine(host) {
  var trackSel = host.track;
  var measure = host.measure || _rectWidth;
  var onApply = host.onApply || function () {};

  // Where the band is now, in strip widths. May exceed 1 between a leg
  // landing and the seam being normalised away. null until first paint.
  var pos = null;
  var seamTimer = null;
  // Where the band is headed: the destination of a sweep still in flight, or
  // null. Clicking mid-sweep steps on from the DESTINATION, not from the
  // waypoint currently painted — otherwise a click during the golden hour
  // would treat afternoon as the current theme and never reach nightfall.
  var dest = null;
  var chainTimer = null;

  // Writes `pos` to every track on the page — a second shell or a specimen
  // card can each hold one, and they all read the same clock. `animate` false
  // parks it with the transition suppressed: the first paint, the seam jump
  // and a resize, where a visible slide would be a bug rather than feedback.
  function paint(animate) {
    var tracks = document.querySelectorAll(trackSel);
    for (var i = 0; i < tracks.length; i++) {
      var track = tracks[i];
      var copy = track.firstElementChild;
      var win = track.parentElement;
      if (!copy || !win) continue;
      // Measured, not assumed: the art is a 2x asset sized by height, so its
      // rendered width depends on the band's height and the display's pixel
      // ratio, and the sidebar is hidden outright under the narrow breakpoint.
      var stripW = measure(copy);
      // Before the art loads there is no width to measure and nothing to
      // position against. Seat on load rather than giving up, or the first
      // click travels from the band's left edge instead of from the theme
      // showing. A band that is display:none measures zero with the image
      // already complete — the resize listener repaints it once it is back.
      if (!stripW) {
        if (!copy.complete) {
          copy.addEventListener("load", function () { paint(false); }, { once: true });
        }
        continue;
      }
      // Anchored one strip width left: copy two sits under the centre and
      // copies one and three cover the window either side, so no position
      // leaves bare surface beside the art.
      var x = measure(win) / 2 - (pos + 1) * stripW;
      if (animate) {
        track.style.transform = "translateX(" + x + "px)";
      } else {
        var prev = track.style.transition;
        track.style.transition = "none";
        track.style.transform = "translateX(" + x + "px)";
        void track.offsetWidth;
        track.style.transition = prev;
      }
    }
  }

  // Parks every track at the current position (or at the current theme's,
  // when there is none yet) with no animation. For first paint, and for a
  // track added after boot — renderNav rebuilds the whole rail and the phone
  // builds the More tab on demand, so the track painted a moment ago may be a
  // different node by the time anyone sees it.
  function seat() {
    if (pos === null) pos = THEME_BAND_POS[_getCurrentTheme()];
    if (pos === undefined) pos = THEME_BAND_POS[DEFAULT_THEME];
    paint(false);
  }

  // Travels to `id`'s position, always forward. Seats itself on `prevId`
  // first if this is the page's first change, so there is a from-value to
  // travel from rather than a snap straight to the destination.
  function travel(id, prevId) {
    var target = THEME_BAND_POS[id];
    if (target === undefined) return;
    if (seamTimer) {
      // A seam normalisation still owed from the previous leg: settle it now,
      // unanimated, before measuring this one — otherwise this leg would start
      // from a position a full strip width away from where it looks.
      clearTimeout(seamTimer);
      seamTimer = null;
      if (pos !== null && pos >= 1) { pos -= 1; paint(false); }
    }
    if (pos === null) {
      var seatAt = THEME_BAND_POS[prevId];
      pos = seatAt === undefined ? target : seatAt;
      paint(false);
      if (seatAt === undefined) return;
    }
    // Forward-only: a target that is "behind" is reached by continuing off the
    // end of the strip and into the identical copy, never by running
    // backwards. This is the whole reason the day keeps moving one way.
    var forward = target - pos;
    while (forward <= 0) forward += 1;
    pos += forward;
    paint(true);
    if (pos >= 1) {
      // The seam is what makes a finite strip endless: past the end of one
      // copy is identical pixels in the next, so exactly ONE strip width can
      // be subtracted unseen once the leg has landed. It must be a whole width
      // (anything else lands on different pixels and the jump shows) and it
      // must never run mid-transition.
      seamTimer = setTimeout(function () {
        seamTimer = null;
        pos -= 1;
        paint(false);
      }, _themeLegMs(id));
    }
  }

  // The DOM half of set(), split out so a view transition can run it as its
  // update callback (after the outgoing picture is captured). The track is
  // TRANSFORMED, never rebuilt: writing style.transform on the live node is
  // what lets the user watch it travel; re-rendering the <img> copies would
  // snap it.
  function apply(t, prevId) {
    document.documentElement.setAttribute("data-theme", t.id);
    // Waypoints are never saved: a reload mid-turn must land on a real theme.
    if (!t.transit) { try { localStorage.setItem("polaris-theme", t.id); } catch (e) {} }
    travel(t.id, prevId);
    onApply(t, prevId);
    // Anything that cached colors at render time — canvases, Leaflet layers,
    // Cytoscape stylesheets, hand-rolled SVG charts, the brand logo — listens
    // for this rather than hooking the band.
    document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: t.id, family: t.family } }));
  }

  /**
   * Applies a theme. `phase` positions this change within a multi-leg turn:
   * "solo" (or omitted), "in", "mid", "out" — see the data-theme-fading
   * blocks in styles.css and mobile.css. An unknown id lands on DEFAULT_THEME.
   */
  function set(theme, phase) {
    var t = _getTheme(theme);
    var prevId = _getCurrentTheme();
    // Only fade a real change — re-applying the current theme (a page re-boot,
    // another tab syncing) should be instant.
    var change = t.id !== prevId;
    var legMs = _themeLegMs(t.id);
    var viaVT = change && !_prefersReducedMotion() && _themeViewTransitions();
    if (change) { _beginThemeFade(phase, legMs, viaVT); _markGlowTurn(prevId, t.id); }
    if (viaVT) {
      // One crossfade of the whole page instead of thousands of per-element
      // colour transitions. The update runs after the browser has captured
      // the outgoing picture; the incoming one is live, so the glow and the
      // band keep moving inside it.
      document.startViewTransition({
        update: function () { apply(t, prevId); },
        types: ["polaris-theme", "polaris-theme-" + (phase || "solo"),
                legMs > THEME_FADE_MS ? "polaris-theme-slow" : "polaris-theme-std"],
      });
    } else {
      apply(t, prevId);
    }
  }

  // One click, one step — but the step can have waypoints. It lands only on
  // THEMES entries; any TRANSIT_THEMES position between here and there is
  // faded through on the way, so noon → nightfall passes the red-rust late
  // afternoon and the room goes near-white → golden hour → indigo in one
  // gesture. The band travels in the same steps, so the palette and the
  // artwork always show the same hour.
  function advance() {
    if (chainTimer) { clearTimeout(chainTimer); chainTimer = null; }
    var from = dest || _getCurrentTheme();
    var i = THEMES.indexOf(_getTheme(from));
    var to = THEMES[(i + 1) % THEMES.length].id;

    var a = THEME_BAND_POS[from] || 0;
    var span = _bandForwardGap(a, THEME_BAND_POS[to] || 0) || 1;
    var stops = TRANSIT_THEMES
      .filter(function (t) {
        var d = _bandForwardGap(a, THEME_BAND_POS[t.id] || 0);
        return d > 0 && d < span;
      })
      .sort(function (x, y) {
        return _bandForwardGap(a, THEME_BAND_POS[x.id] || 0) -
               _bandForwardGap(a, THEME_BAND_POS[y.id] || 0);
      })
      .map(function (t) { return t.id; });

    dest = to;
    var queue = stops.concat([to]);
    var legs = queue.length;
    var n = 0;
    (function step() {
      // No gap and no re-easing between legs: the next fade starts the instant
      // the last one lands, and the phase splits one ease across the whole
      // turn, so it reads as a single continuous sweep rather than two
      // changes with a stop in the middle.
      var phase = legs === 1 ? "solo" : (n === 0 ? "in" : (n === legs - 1 ? "out" : "mid"));
      n++;
      var leg = queue.shift();
      set(leg, phase);
      if (!queue.length) { dest = null; return; }
      chainTimer = setTimeout(step, _themeLegMs(leg));
    })();
  }

  var engine = {
    set: set,
    advance: advance,
    seat: seat,
    paint: paint,
    control: host.control,
    position: function () { return pos; },
  };
  window.__polarisThemeEngine = engine;

  // A resized window (or a rotated phone) moves the centre, so the band has
  // to be re-seated under it — without animation, because nothing about a
  // resize is a theme change. This is also what paints a band that could not
  // be measured at all while it was hidden.
  if (!window.__polarisThemeResize) {
    window.__polarisThemeResize = true;
    window.addEventListener("resize", function () {
      var e = window.__polarisThemeEngine;
      if (e && e.position() !== null) e.paint(false);
    });
  }
  // Delegated, so a band rendered by anything — renderNav, a second shell, a
  // tab built on demand — travels without being wired up. Never add a direct
  // listener to the control as well, or one click advances two steps.
  if (!document.documentElement.hasAttribute("data-theme-control-wired")) {
    document.documentElement.setAttribute("data-theme-control-wired", "");
    document.addEventListener("click", function (ev) {
      var e = window.__polarisThemeEngine;
      if (e && e.control && ev.target && ev.target.closest && ev.target.closest(e.control)) e.advance();
    });
  }
  return engine;
}
