// public/js/mobile/app.js — Mobile app orchestrator.
//
// On boot, calls /auth/me. If unauthenticated, hands over to PolarisAuth.
// If authenticated, renders the tab shell and dispatches to the tab matching
// the current hash route.
//
// All state-changing requests funnel through window.api (loaded from the
// shared /js/api.js). The 401 hook below redirects to the in-app login
// rather than /login.html, so session expiry pops a familiar screen.

// Apply persisted theme BEFORE the IIFE below runs, so the first paint
// uses the right surface color (no dark-flash on a light-mode user’s
// reload). Same `polaris-theme` localStorage key the desktop uses, so a
// preference set on either surface flows to the other.
// Nothing saved (first launch of the installed app, typically) follows the OS
// — "morning" for a light preference, "nightfall" otherwise. Same rule as
// js/theme-init.js and app.js, and a retired id (the old "dark"/"light") names
// no token block, so it falls back the same way as no preference at all.
//
// The three SELECTABLE themes each carry their own Material palette in
// mobile.css. They used to share ONE palette per family, which is why this SPA
// read and wrote family-wise; the theme strip ended that, because a control
// that shows the day passing has to have something change when it passes.
// `PolarisTheme.get()` still answers the FAMILY, because that IS the
// granularity its remaining callers want (map-tab’s basemap pair,
// topology-tab’s node palette) — what was retired is the two-way light/dark
// TOGGLE, not the family question.
var MOBILE_THEMES = [
  { id: "morning",   label: "Morning",   family: "light" },
  { id: "noon",      label: "Noon",      family: "light" },
  { id: "nightfall", label: "Nightfall", family: "dark" },
];

// Transit palettes: real token blocks that nothing can select and nothing ever
// persists. The strip fades THROUGH each one that lies on the way, so noon →
// nightfall crosses the golden hour instead of cutting. Mirrors TRANSIT_THEMES
// in the desktop app.js — the two lists and their CSS blocks move together.
var MOBILE_TRANSIT_THEMES = [
  { id: "afternoon", label: "Afternoon", family: "light", transit: true },
];

// Back-compat for any caller still handing us a family rather than an id.
var MOBILE_THEME_IDS = { light: "morning", dark: "nightfall" };

(function () {
  // The selectable themes only. "afternoon" is deliberately absent: it is a
  // transit palette the strip travels through, never a saved preference, so a
  // reload mid-sweep lands on a real theme instead of a waypoint.
  var KNOWN = ["morning", "noon", "nightfall"];
  var saved = null;
  try { saved = localStorage.getItem("polaris-theme"); } catch (e) {}
  if (saved && KNOWN.indexOf(saved) === -1) saved = null;
  if (!saved) {
    var light = false;
    try { light = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches; } catch (e) {}
    saved = light ? "morning" : "nightfall";
  }
  document.documentElement.setAttribute("data-theme", saved);
})();

// Resolves selectable AND transit ids — PolarisTheme.set has to be able to
// apply a waypoint, and get() has to answer the right FAMILY while one shows.
function _mobileTheme(id) {
  var i;
  for (i = 0; i < MOBILE_THEMES.length; i++) if (MOBILE_THEMES[i].id === id) return MOBILE_THEMES[i];
  for (i = 0; i < MOBILE_TRANSIT_THEMES.length; i++) if (MOBILE_TRANSIT_THEMES[i].id === id) return MOBILE_TRANSIT_THEMES[i];
  return MOBILE_THEMES[2]; // nightfall — the default, as on the desktop
}

// ─── Theme strip ────────────────────────────────────────────────
//
// Where each palette sits along /img/brand/time-strip.png, as a fraction of
// the strip’s width. The anchor was set by eye on the two FACES (the marker has
// to sit on the face, not beside it) and then stepped by exactly a quarter: the
// engraving is a 24-hour clock unrolled, so six hours is a quarter of it, and
// the two faces land half a strip apart the way noon and midnight should.
// Changing one means changing all four — keep the quarter spacing and move the
// anchor. The desktop’s THEME_WHEEL_ANGLE is the same clock in degrees.
var THEME_STRIP_POS = { noon: 0.056, afternoon: 0.306, nightfall: 0.556, morning: 0.806 };

// Where the strip is now, in strip widths. May exceed 1 between a leg landing
// and the seam being normalised away. null until first paint.
var _stripPos = null;
var _stripSeamTimer = null;

function _themeStripTracks() { return document.querySelectorAll(".theme-strip-track"); }

// Writes _stripPos to every strip on the page. `animate` false parks it with
// the transition suppressed — used for the first paint, for the seam jump, and
// on resize, where a visible slide would be a bug rather than feedback.
function _paintThemeStrips(animate) {
  var tracks = _themeStripTracks();
  for (var i = 0; i < tracks.length; i++) {
    var track = tracks[i];
    var copy = track.firstElementChild;
    var win = track.parentElement;
    if (!copy || !win) continue;
    // Measured, not assumed: the art is a 2x asset sized by height, so its
    // rendered width depends on the row’s height and the device’s pixel ratio.
    var stripW = copy.getBoundingClientRect().width;
    // Before the art loads there is no width to measure and nothing to position
    // against. Seat on load rather than giving up, or the first tap travels from
    // the strip’s left edge instead of from the theme showing.
    if (!stripW) {
      if (!copy.complete) {
        copy.addEventListener("load", function () { _paintThemeStrips(false); }, { once: true });
      }
      continue;
    }
    // Anchored one strip width left: copy two sits under the marker and copies
    // one and three cover the window either side, so no position leaves bare
    // surface beside the art.
    var x = win.getBoundingClientRect().width / 2 - (_stripPos + 1) * stripW;
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

// Travels to `id`’s position, always leftward. Seats itself on `prevId` first if
// this is the page’s first change, so there is a from-value to travel from.
function _advanceThemeStrips(id, prevId) {
  var target = THEME_STRIP_POS[id];
  if (target === undefined) return;
  if (_stripSeamTimer) {
    // A seam normalisation still owed from the previous leg: settle it now,
    // unanimated, before measuring this one — otherwise this leg would start
    // from a position a full strip width away from where it looks.
    clearTimeout(_stripSeamTimer);
    _stripSeamTimer = null;
    if (_stripPos !== null && _stripPos >= 1) { _stripPos -= 1; _paintThemeStrips(false); }
  }
  if (_stripPos === null) {
    var seat = THEME_STRIP_POS[prevId];
    _stripPos = seat === undefined ? target : seat;
    _paintThemeStrips(false);
    if (seat === undefined) return;
  }
  // Forward-only: a target that is “behind” is reached by continuing off the end
  // of the strip and into the identical copy, never by running backwards. This
  // is the whole reason the day keeps moving one way.
  var forward = target - _stripPos;
  while (forward <= 0) forward += 1;
  _stripPos += forward;
  _paintThemeStrips(true);
  if (_stripPos >= 1) {
    _stripSeamTimer = setTimeout(function () {
      _stripSeamTimer = null;
      _stripPos -= 1;
      _paintThemeStrips(false);
    }, THEME_FADE_MS);
  }
}

// A resized window (or a rotated phone) moves the centre marker, so the strip
// has to be re-seated under it — without animation, because nothing about a
// resize is a theme change.
if (!window.__polarisStripResize) {
  window.__polarisStripResize = true;
  window.addEventListener("resize", function () {
    if (_stripPos !== null) _paintThemeStrips(false);
  });
}

// Matches the crossfade duration in mobile.css. Change one, change the other.
var THEME_FADE_MS = 800;
var _themeFadeTimer = null;

// Arms the palette crossfade for the length of one change. Called before
// data-theme moves, so the new values are what gets transitioned TO.
function _beginThemeFade(phase) {
  try {
    if (window.matchMedia &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch (e) { /* no matchMedia — fade anyway */ }
  var root = document.documentElement;
  root.setAttribute("data-theme-fading", phase || "solo");
  if (_themeFadeTimer) clearTimeout(_themeFadeTimer);
  _themeFadeTimer = setTimeout(function () {
    root.removeAttribute("data-theme-fading");
    _themeFadeTimer = null;
  }, THEME_FADE_MS + 80);
}

// Where the strip is headed: the destination of a sweep still in flight, or
// simply what is showing. Tapping mid-sweep steps on from the DESTINATION, not
// from the waypoint currently painted.
var _themeDest = null;
var _themeChainTimer = null;

// Shared get/set so map-tab, topology-tab and more-tab can read or flip the
// theme without duplicating the localStorage key. `get` answers the FAMILY
// ("light"|"dark") — the granularity every remaining caller wants — while `set`
// writes a concrete theme id the desktop also understands, and `advance` is the
// strip’s one-tap sweep. `getId` is the raw value for anything that needs it.
window.PolarisTheme = {
  getId: function () { return document.documentElement.getAttribute("data-theme") || "nightfall"; },
  get: function () {
    // Resolved through the theme list rather than by naming ids, so the
    // afternoon waypoint answers “light” while it shows. An id comparison here
    // flipped the basemap and the topology palette to dark mid-sweep.
    return _mobileTheme(document.documentElement.getAttribute("data-theme")).family;
  },
  set: function (theme, phase) {
    // Accepts a theme id, or a family for a legacy caller that only knows
    // "light"/"dark".
    var t = _mobileTheme(MOBILE_THEME_IDS[theme] || theme);
    var prevId = document.documentElement.getAttribute("data-theme") || "nightfall";
    // Only fade a real change — re-applying the current theme should be instant.
    if (t.id !== prevId) _beginThemeFade(phase);
    document.documentElement.setAttribute("data-theme", t.id);
    // Waypoints are never saved: a reload mid-sweep must land on a real theme.
    if (!t.transit) { try { localStorage.setItem("polaris-theme", t.id); } catch (e) {} }
    _advanceThemeStrips(t.id, prevId);
    var names = document.querySelectorAll(".theme-strip-name");
    for (var i = 0; i < names.length; i++) names[i].textContent = t.label;
    var strips = document.querySelectorAll(".theme-strip");
    for (i = 0; i < strips.length; i++) {
      strips[i].setAttribute("aria-label", "Time of day: " + t.label + ". Tap to move through the day.");
    }
    // Keep the installed app’s chrome (Android status bar / task switcher) in
    // step with the theme. The manifest colour itself is frozen at install time
    // and only affects the launch splash, so a light-mode user still gets a dark
    // splash — cosmetic and unavoidable.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", t.family === "dark" ? "#1d2244" : "#eef0f7");
  },
  // One tap, one step — but the step can have waypoints. Lands only on a
  // selectable theme; any transit position between here and there is faded
  // through on the way, so noon → nightfall passes the red afternoon and the
  // phone goes near-white → golden hour → indigo in one gesture.
  advance: function () {
    if (_themeChainTimer) { clearTimeout(_themeChainTimer); _themeChainTimer = null; }
    var from = _themeDest || window.PolarisTheme.getId();
    var i = MOBILE_THEMES.indexOf(_mobileTheme(from));
    var dest = MOBILE_THEMES[(i + 1) % MOBILE_THEMES.length].id;

    // Which waypoints lie between here and there, in the strip’s own direction
    // of travel. Same forward-gap arithmetic as the desktop dial, in fractions
    // of a strip rather than degrees.
    var a = THEME_STRIP_POS[from];
    var gap = function (x, y) { return ((y - x) % 1 + 1) % 1; };
    var span = gap(a, THEME_STRIP_POS[dest]) || 1;
    var stops = MOBILE_TRANSIT_THEMES
      .filter(function (t) {
        var d = gap(a, THEME_STRIP_POS[t.id]);
        return d > 0 && d < span;
      })
      .sort(function (x, y) { return gap(a, THEME_STRIP_POS[x.id]) - gap(a, THEME_STRIP_POS[y.id]); })
      .map(function (t) { return t.id; });

    _themeDest = dest;
    var queue = stops.concat([dest]);
    var legs = queue.length;
    var n = 0;
    (function step() {
      // No gap and no re-easing between legs: the phase splits one ease across
      // the whole sweep, so it reads as one continuous movement rather than two
      // changes with a stop in the middle.
      var phase = legs === 1 ? "solo" : (n === 0 ? "in" : (n === legs - 1 ? "out" : "mid"));
      n++;
      window.PolarisTheme.set(queue.shift(), phase);
      if (!queue.length) { _themeDest = null; return; }
      _themeChainTimer = setTimeout(step, THEME_FADE_MS);
    })();
  },
  // The name of the theme showing, for a caller rendering the strip caption.
  currentLabel: function () { return _mobileTheme(window.PolarisTheme.getId()).label; },
  // Seats every strip on the page at the current theme with no animation — for
  // a strip rendered after boot (the More tab is built on demand).
  seatStrips: function () {
    if (_stripPos === null) _stripPos = THEME_STRIP_POS[window.PolarisTheme.getId()];
    if (_stripPos === undefined) _stripPos = THEME_STRIP_POS.nightfall;
    _paintThemeStrips(false);
  },
};

// Delegated, so a strip rendered by anything turns without being wired up.
// Never add a direct listener to a .theme-strip as well, or one tap advances
// two steps.
if (!document.documentElement.hasAttribute("data-theme-strip-wired")) {
  document.documentElement.setAttribute("data-theme-strip-wired", "");
  document.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest(".theme-strip")) window.PolarisTheme.advance();
  });
}
(function () {
  var app = document.getElementById("app");
  var currentUser = null;

  // Hook the shared api.js 401 handler so it routes back to our in-app
  // login screen instead of /login.html.
  window.__polarisOn401 = function () {
    currentUser = null;
    PolarisAuth.renderLogin(app);
  };

  // Best-effort portrait lock. Honored on Android Chrome / Firefox; iOS
  // Safari outside an installed PWA silently rejects, which is fine —
  // mobile.css carries a landscape lockout overlay as the universal
  // fallback for that case. Wrapped in try/catch because the API throws
  // synchronously on some platforms when called outside fullscreen.
  try {
    if (screen && screen.orientation && typeof screen.orientation.lock === "function") {
      screen.orientation.lock("portrait").catch(function () { /* unsupported — fall through to CSS overlay */ });
    }
  } catch (e) { /* silent — same path as a quiet rejection */ }

  // ─── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    app.dataset.tab = "";
    app.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';

    // Branding carries the hardware-sensor display unit (°C/°F). Fire-and-forget
    // so it never delays the first paint — the sensor list reads the cached value
    // and a changed preference lands on the next boot at the latest.
    if (window.PolarisAuthFlow) { void PolarisAuthFlow.fetchBranding(); }

    var user = null;
    var bootError = null;
    try {
      var bootController = new AbortController();
      var bootTimeout = setTimeout(function () { bootController.abort(); }, 10000);
      var res = await fetch("/api/v1/auth/me", { signal: bootController.signal });
      clearTimeout(bootTimeout);
      if (res.ok) {
        var data = await res.json();
        // /auth/me returns { authenticated, username, role: {id,name,permissions,...},
        // authProvider, regionTags: {user, role, effective} }. Translate to
        // the shape the rest of the mobile bundle expects — role becomes the
        // role NAME string for back-compat with existing role-name checks in
        // reservations-tab.js / subnet-detail.js / more-tab.js. Permissions +
        // effective regions are passed through under explicit keys so future
        // surfaces (e.g. region-filtered reservation list) can read them.
        if (data && data.authenticated) {
          user = {
            username:     data.username,
            role:         (data.role && data.role.name) || null,
            permissions:  (data.role && data.role.permissions) || {},
            regions:      (data.regionTags && data.regionTags.effective) || [],
            authProvider: data.authProvider,
            displayName:  data.username,
          };
        }
      }
    } catch (err) {
      if (err && err.name === "AbortError") {
        bootError = "Connection timed out. Check your network and tap Retry.";
      } else if (err && err.message) {
        bootError = "Could not reach server: " + err.message + ". Tap Retry.";
      }
    }

    if (bootError) {
      app.innerHTML = ''
        + '<div class="empty-state" style="padding-top:64px;">'
        + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);">'
        + '    <svg viewBox="0 0 24 24"><use href="#i-warn"/></svg>'
        + '  </div>'
        + '  <div class="ttl">Unable to connect</div>'
        + '  <div class="desc">' + bootError + '</div>'
        + '  <button class="btn-filled" style="margin-top:24px;" id="boot-retry-btn">Retry</button>'
        + '</div>';
      var retryBtn = document.getElementById("boot-retry-btn");
      if (retryBtn) retryBtn.addEventListener("click", function () { boot(); });
      return;
    }

    if (!user) {
      currentUser = null;
      PolarisAuth.renderLogin(app);
      return;
    }

    currentUser = user;
    // Make the current user available to api.js callers (avatar, role checks).
    window.__polarisUser = user;

    renderShell();
    PolarisRouter.onChange(routeChanged);
    if (!window.location.hash) PolarisRouter.go("search", { replace: true });
    initPushOnce();
  }

  // Register the service worker once per page load, as soon as we know the
  // visitor is authenticated. boot() is re-entrant (the offline Retry button,
  // sign-out, and post-login all call it), hence the guard.
  //
  // Registering here rather than lazily from the More tab means (a) Chrome's
  // installability check sees an ACTIVE service worker whether or not the user
  // ever opens More, and (b) the push handler is live regardless. It subscribes
  // to nothing, so there is no permission or privacy consequence.
  //
  // syncToPreference brings THIS phone's subscription into line with the
  // account's stored notification preference (business rule 39) — enrolling it
  // when the account prefers push and permission is already granted,
  // un-enrolling it when the account has gone back to email. It has to happen
  // at BOOT, not when the More tab is opened: the whole point of storing the
  // preference on the account is that a device the operator never touches
  // again still honours a choice made somewhere else. It also re-posts an
  // already-granted subscription on the way past, so a rotated push endpoint
  // self-heals — see the comment in push.js; this boot-time pass is the
  // primary rotation repair, not the service worker's event handler.
  //
  // A failed preference read falls back to the bare reconcile, so a network
  // blip costs the sync but never the rotation repair.
  var _pushInitDone = false;
  function initPushOnce() {
    if (_pushInitDone || !window.polarisPush) return;
    _pushInitDone = true;
    var pref = "email";
    polarisPush.registerSW()
      .then(function () { return api.push.preference(); })
      .then(function (r) {
        pref = (r && r.preference) || "email";
        return polarisPush.syncToPreference(pref, "mobile");
      })
      .catch(function () { return polarisPush.reconcileSubscription("mobile"); })
      .catch(function () { /* push is optional — never block boot */ })
      // After the reconcile, never instead of it: a phone that has never been
      // asked for permission cannot be enrolled silently, so it is asked once.
      // `pref` is still "email" if the read above failed, which is the right
      // way to fail — an offer made off a preference nobody confirmed would be
      // asking on behalf of a setting that may say email.
      .then(function () { return maybeOfferPushEnrollment(pref); })
      .catch(function () { /* likewise */ });
  }

  /**
   * Offer enrollment on a phone the account's push preference cannot reach
   * yet (business rule 39).
   *
   * iOS grants Web Push only to a home-screen-installed app, and on iOS 16.4+
   * `"PushManager" in window` is true in plain Safari — so an Enable button
   * there is one that can only ever throw. That phone is not asked at all; the
   * More tab's Notifications row already tells it to Add to Home Screen, and
   * the offer is put to it once it is installed and signs in as an app.
   */
  function maybeOfferPushEnrollment(pref) {
    if (!window.polarisPush || !polarisPush.shouldOfferEnrollment) return;
    if (window.PolarisInstall && PolarisInstall.isIos() && !PolarisInstall.isStandalone()) return;
    return polarisPush
      .shouldOfferEnrollment(pref, { username: currentUser && currentUser.username })
      .then(function (offer) { if (offer) openPushOfferSheet(); })
      .catch(function () { /* an offer nobody asked for is never worth an error */ });
  }

  /**
   * The offer, as the bottom sheet every other choice on this app is made in.
   *
   * Recorded as made the moment it opens, not when a button is tapped: the
   * scrim and a swipe-away dismiss it with no callback, and a sheet that comes
   * back on every boot until it is answered one specific way is a nag.
   *
   * enable() is the first statement of the tap handler — before the sheet is
   * torn down and before any await — because Notification.requestPermission()
   * needs the tap's transient user activation and Safari drops it across an
   * await. Same rule as the More tab's chooser and push.js's enable().
   */
  function openPushOfferSheet() {
    polarisPush.recordOfferMade(currentUser && currentUser.username);
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<h3 class="sheet-title" style="margin:0 0 4px;">Push notifications</h3>'
      + '<p style="margin:0 0 16px;color:var(--md-on-surface-variant);font-size:14px;">'
      + 'Your account is set to be notified by push, but this phone has never been enrolled. '
      + 'Turn push notifications on here? You can change this any time from More → Notifications.</p>'
      + '<div style="display:flex;gap:12px;justify-content:flex-end;">'
      + '  <button id="push-offer-dismiss" class="btn btn-outlined">Not now</button>'
      + '  <button id="push-offer-enable" class="btn btn-filled">Enable</button>'
      + '</div>';
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    function close() { scrim.remove(); sheet.remove(); }
    scrim.addEventListener("click", close);
    sheet.querySelector("#push-offer-dismiss").addEventListener("click", close);
    sheet.querySelector("#push-offer-enable").addEventListener("click", function () {
      var enrolling = polarisPush.enable({ surface: "mobile" });
      close();
      enrolling.then(function () {
        PolarisTabs.showSnackbar("Push notifications are on for this phone");
      }, function (err) {
        PolarisTabs.showSnackbar((err && err.message) || "This browser refused push notifications.", { error: true });
      });
    });
  }

  // ─── Shell ─────────────────────────────────────────────────────────────
  function renderShell() {
    app.innerHTML = ''
      + '<div id="search-slot">' + buildSearchbar() + '</div>'
      + '<div id="topbar-slot"></div>'
      + '<main class="app-body" id="app-body"></main>'
      + buildNavbar();
    wireSearchbar();
    wireNavbar();
  }

  // Persistent searchbar — visible at the top of every page. Typing
  // routes the user to the Search tab (which renders results into
  // #app-body) without losing the input value across navigation, since
  // the input lives in this shell-owned slot and is never re-rendered.
  function buildSearchbar() {
    var initials = (currentUser && currentUser.username || "?").slice(0, 2).toUpperCase();
    return ''
      + '<div class="m3-searchbar" style="margin:8px 16px 4px;">'
      + '  <button class="icon-btn" id="search-clear-btn" aria-label="Clear" type="button" style="display:none;"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '  <button class="icon-btn" id="search-icon-btn" aria-label="Search" type="button"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>'
      + '  <input class="input" type="search" id="search-input" placeholder="Search IPs, assets, networks…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">'
      + '  <div class="avatar" id="search-avatar">' + PolarisTabs.escapeHtml(initials) + '</div>'
      + '</div>';
  }

  function wireSearchbar() {
    var input    = document.getElementById("search-input");
    var clearBtn = document.getElementById("search-clear-btn");
    var iconBtn  = document.getElementById("search-icon-btn");
    if (!input) return;

    function setClearVisible(visible) {
      if (!clearBtn || !iconBtn) return;
      clearBtn.style.display = visible ? "" : "none";
      iconBtn.style.display  = visible ? "none" : "";
    }

    input.addEventListener("input", function () {
      var q = input.value.trim();
      setClearVisible(!!input.value);
      // Typing anywhere except the Search tab routes to /search so the
      // results land in the body. Replace history so back doesn't have
      // to walk through every keystroke's intermediate route.
      var cur = PolarisRouter.current();
      if (q.length > 0 && cur.name !== "search") {
        PolarisRouter.go("search", { replace: true });
      }
      PolarisSearch.debounce(q);
    });

    // Tapping the search input from any tab brings up the Search tab so
    // the shortcut-hint chips are visible before the operator types. We
    // only route on empty input so this doesn't fight an in-progress
    // query (focus events fire on keyboard re-entry too).
    input.addEventListener("focus", function () {
      var cur = PolarisRouter.current();
      if (!input.value.trim() && cur.name !== "search") {
        PolarisRouter.go("search", { replace: true });
      }
    });

    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        input.value = "";
        setClearVisible(false);
        PolarisSearch.runSearch("");
      }
    });

    if (clearBtn) clearBtn.addEventListener("click", function () {
      input.value = "";
      setClearVisible(false);
      PolarisSearch.runSearch("");
      input.focus();
    });
  }

  function buildNavbar() {
    var html = '<nav class="m3-navbar" id="navbar">';
    PolarisTabs.list.forEach(function (t) {
      html += ''
        + '<button class="nav-item" data-tab="' + t.id + '">'
        + '  <div class="nav-icon-pill">'
        + '    <svg viewBox="0 0 24 24"><use href="' + t.spec.icon + '"/></svg>'
        + '  </div>'
        + '  <div class="nav-label">' + t.spec.title + '</div>'
        + '</button>';
    });
    html += '</nav>';
    return html;
  }

  function wireNavbar() {
    var nav = document.getElementById("navbar");
    if (!nav) return;
    nav.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tabId = btn.dataset.tab;
        PolarisRouter.go(tabId);
      });
    });
  }

  function setActiveTab(tabId) {
    app.dataset.tab = tabId || "";
    var nav = document.getElementById("navbar");
    if (!nav) return;
    nav.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.classList.toggle("active", btn.dataset.tab === tabId);
    });
  }

  // Pull-to-refresh handle for the currently-mounted route. Cleared on
  // every route change so handlers + indicator DOM don't stack up.
  var _ptrRelease = null;

  function installPtrForSpec(spec, ctx) {
    if (_ptrRelease) { try { _ptrRelease(); } catch (_) {} _ptrRelease = null; }
    if (!spec || typeof spec.onPullToRefresh !== "function") return;
    // Optional predicate — lets a spec like More disable PTR on its root
    // menu while keeping it on the sub-pages. Treat missing predicate as
    // "always enabled."
    if (typeof spec.enablesPullToRefresh === "function") {
      try { if (!spec.enablesPullToRefresh(ctx)) return; }
      catch (_) { return; }
    }
    var body = document.getElementById("app-body");
    if (!body || !window.PolarisTabs || !PolarisTabs.installPullRefresh) return;
    _ptrRelease = PolarisTabs.installPullRefresh(body, function () {
      try { return spec.onPullToRefresh(ctx); } catch (_) { return null; }
    });
  }

  // ─── Route handler ─────────────────────────────────────────────────────
  function routeChanged(route) {
    if (!currentUser) return;

    var topbar = document.getElementById("topbar-slot");
    var body = document.getElementById("app-body");
    if (!topbar || !body) {
      // Shell got torn down (login screen showing) — re-render and retry.
      renderShell();
      topbar = document.getElementById("topbar-slot");
      body = document.getElementById("app-body");
    }

    // Page-aware search ordering: snapshot every non-search route so
    // when the operator starts typing (which replace-navigates to
    // /search) the result renderer still knows which page they came
    // from and can hoist the matching section to the top.
    if (route && route.name !== "search" && window.PolarisSearch && PolarisSearch.setOriginRoute) {
      PolarisSearch.setOriginRoute(route.name, route.parts);
    }

    // Top-level tab?
    var tabSpec = PolarisTabs.byId(route.name);
    if (tabSpec) {
      setActiveTab(route.name);
      var tabCtx = { user: currentUser, route: route };
      topbar.innerHTML = tabSpec.renderTopbar
        ? tabSpec.renderTopbar(tabCtx) : '';
      tabSpec.render(body, tabCtx);
      body.scrollTop = 0;
      installPtrForSpec(tabSpec, tabCtx);
      return;
    }

    // Detail route? (asset, subnet, block, site)
    var details = window.PolarisDetails || {};
    var detailSpec = details[route.name];
    if (detailSpec) {
      // Detail specs may declare a parentTab — when set, the corresponding
      // navbar item stays highlighted so the user understands which tab
      // they're conceptually inside. Without a parentTab the navbar is
      // visible but no item is active (e.g. block detail).
      var parentTab = detailSpec.parentTab || "";
      app.dataset.tab = parentTab || route.name;
      var nav = document.getElementById("navbar");
      if (nav) nav.querySelectorAll(".nav-item").forEach(function (b) {
        b.classList.toggle("active", parentTab !== "" && b.dataset.tab === parentTab);
      });

      var detailCtx = { user: currentUser, route: route };
      topbar.innerHTML = detailSpec.renderTopbar
        ? detailSpec.renderTopbar(detailCtx) : '';
      detailSpec.render(body, detailCtx);
      body.scrollTop = 0;
      installPtrForSpec(detailSpec, detailCtx);
      return;
    }

    // Unknown route — bounce to search. Clear any installed PTR.
    if (_ptrRelease) { try { _ptrRelease(); } catch (_) {} _ptrRelease = null; }
    PolarisRouter.go("search", { replace: true });
  }

  // ─── Public surface ────────────────────────────────────────────────────
  window.PolarisMobile = {
    boot: boot,
    user: function () { return currentUser; },
  };

  // Kick off on DOM ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
