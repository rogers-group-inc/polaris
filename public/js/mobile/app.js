// public/js/mobile/app.js — Mobile app orchestrator.
//
// On boot, calls /auth/me. If unauthenticated, hands over to PolarisAuth.
// If authenticated, renders the tab shell and dispatches to the tab matching
// the current hash route.
//
// All state-changing requests funnel through window.api (loaded from the
// shared /js/api.js). The 401 hook below redirects to the in-app login
// rather than /login.html, so session expiry pops a familiar screen.

// ─── Theme ──────────────────────────────────────────────────────────────────
//
// The engine is js/theme-core.js, loaded right before this file — the same
// one the desktop sidebar (app.js) and the Dash wallboard (dash-boot.js) run,
// so the strip and the band read one clock: one theme list (THEMES /
// TRANSIT_THEMES), one position table (THEME_BAND_POS), the same leg lengths,
// forward-only travel, seam and waypoint sweep. Same `polaris-theme`
// localStorage key the desktop uses, so a preference set on either surface
// flows to the other. This file is the strip's HOST: the caption and
// aria-label it repaints, the status bar, and window.PolarisTheme.
//
// The three SELECTABLE themes each carry their own Material palette in
// mobile.css. They used to share ONE palette per family, which is why this SPA
// read and wrote family-wise; the theme strip ended that, because a control
// that shows the day passing has to have something change when it passes.
// `PolarisTheme.get()` still answers the FAMILY, because that IS the
// granularity its remaining callers want (map-tab’s basemap pair,
// topology-tab’s node palette) — what was retired is the two-way light/dark
// TOGGLE, not the family question.

// Back-compat for any caller still handing us a family rather than an id.
var MOBILE_THEME_IDS = { light: "morning", dark: "nightfall" };

// Keep the phone's chrome (Android status bar / task switcher) in step with
// the theme: the theme's --status-bar-color (mobile.css), the colour at the
// top edge of the screen, so the bar runs on into the page. It was one cool
// near-white for every daylight theme, which sat on morning's parchment and
// noon's sunlight as a white band. The fallbacks cover a stylesheet without
// the token. The manifest colour itself is frozen at install time and only
// affects the launch splash, so a light-mode user still gets a dark splash —
// cosmetic and unavoidable.
function _syncStatusBar(t) {
  var meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  var c = "";
  try { c = getComputedStyle(document.documentElement).getPropertyValue("--status-bar-color").trim(); } catch (e) {}
  meta.setAttribute("content", c || (t.family === "dark" ? "#1d2244" : "#eef0f7"));
}

// Apply the persisted theme BEFORE the app IIFE below runs, so the first paint
// uses the right surface colour (no dark flash on a light-mode user’s reload);
// nothing saved (first launch of the installed app, typically) follows the
// OS. The status bar follows from the first paint, not from the first theme
// change: the static meta in mobile.html is nightfall's colour, so a daylight
// phone opened on the wrong bar until the strip was tapped.
_syncStatusBar(_getTheme(_applySavedTheme()));

var _themeEngine = createThemeEngine({
  track: ".theme-strip-track",
  control: ".theme-strip",
  onApply: function (t) {
    var names = document.querySelectorAll(".theme-strip-name");
    for (var i = 0; i < names.length; i++) names[i].textContent = t.label;
    var strips = document.querySelectorAll(".theme-strip");
    for (i = 0; i < strips.length; i++) {
      strips[i].setAttribute("aria-label", "Time of day: " + t.label + ". Tap to move through the day.");
    }
    _syncStatusBar(t);
  },
});

// Shared get/set so map-tab, topology-tab and more-tab can read or flip the
// theme without duplicating the localStorage key. `get` answers the FAMILY
// ("light"|"dark") — the granularity every remaining caller wants, resolved
// through the theme list so the afternoon waypoint answers “light” while it
// shows (an id comparison here flipped the basemap and the topology palette
// to dark mid-sweep) — while `set` writes a concrete theme id the desktop
// also understands, and `advance` is the strip’s one-tap sweep. `getId` is
// the raw value for anything that needs it. The tap itself is delegated by
// the engine; never add a direct listener to a .theme-strip as well, or one
// tap advances two steps.
window.PolarisTheme = {
  getId: function () { return _getCurrentTheme(); },
  get: function () { return _getTheme(_getCurrentTheme()).family; },
  // Accepts a theme id, or a family for a legacy caller that only knows
  // "light"/"dark".
  set: function (theme, phase) { _themeEngine.set(MOBILE_THEME_IDS[theme] || theme, phase); },
  advance: function () { _themeEngine.advance(); },
  // The name of the theme showing, for a caller rendering the strip caption.
  currentLabel: function () { return _getTheme(_getCurrentTheme()).label; },
  // Seats every strip on the page at the current theme with no animation — for
  // a strip rendered after boot (the More tab is built on demand).
  seatStrips: function () { _themeEngine.seat(); },
};
(function () {
  var app = document.getElementById("app");
  var currentUser = null;

  // Hook the shared api.js 401 handler so it routes back to our in-app
  // login screen instead of /login.html.
  window.__polarisOn401 = function () {
    currentUser = null;
    PolarisAuth.renderLogin(app);
  };

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
      // Raw fetch on purpose (CQ-F026): boot needs its own 10 s abort and hands a
      // signed-out user to PolarisAuth — api.js's request() would redirect to
      // the desktop /login.html instead.
      var res = await fetch("/api/v1/auth/me", { signal: bootController.signal });
      clearTimeout(bootTimeout);
      if (res.ok) {
        var data = await res.json();
        // /auth/me returns { authenticated, username, role: {id,name,permissions,...},
        // authProvider, regionTags / otherTags: {user, role, group, effective} }. Translate to
        // the shape the rest of the mobile bundle expects — role becomes the
        // role NAME string for back-compat with existing role-name checks in
        // reservation-actions.js / subnet-detail.js / more-tab.js. Permissions +
        // effective regions are passed through under explicit keys so future
        // surfaces (e.g. region-filtered reservation list) can read them.
        if (data && data.authenticated) {
          user = {
            username:     data.username,
            role:         (data.role && data.role.name) || null,
            permissions:  (data.role && data.role.permissions) || {},
            regions:      (data.regionTags && data.regionTags.effective) || [],
            // The second scope dimension (free-form tags), same union.
            tags:         (data.otherTags && data.otherTags.effective) || [],
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

    // Chat takes the Networks slot only when the assistant is usable here:
    // the last answer this phone saw decides the first paint, the live
    // status corrects it (refreshChatSlot).
    PolarisTabs.setChatInBar(chatPermitted(user) && lsChatAvailable() === "1");
    renderShell();
    refreshChatSlot(user);
    PolarisRouter.onChange(routeChanged);
    // Alerts is the home route — what an on-call phone opens to see.
    if (!window.location.hash) PolarisRouter.go("alerts", { replace: true });
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
    if (window.PolarisTabs && PolarisTabs.installListFade) PolarisTabs.installListFade(document.getElementById("app-body"));
  }

  // The searchbar. Hidden until search is opened: every page's top bar carries
  // a magnifier (addTopbarSearch), placed between its title and its own
  // buttons, and tapping it reveals this bar across the top (`.app.searching`)
  // over #search, which shows the scope shortcuts and then the results as the
  // operator types. Search has no navbar slot. The back arrow closes it. The
  // input lives in this shell-owned slot and is never re-rendered, so its
  // value survives navigation.
  function buildSearchbar() {
    var initials = (currentUser && currentUser.username || "?").slice(0, 2).toUpperCase();
    return ''
      + '<div class="m3-searchbar" id="m3-searchbar">'
      + '  <button class="icon-btn" id="search-back-btn" aria-label="Close search" type="button" style="display:none;"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  <button class="icon-btn" id="search-icon-btn" aria-label="Search" type="button"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></button>'
      + '  <input class="input" type="search" id="search-input" placeholder="Search IPs, assets, networks…" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">'
      + '  <button class="icon-btn" id="search-clear-btn" aria-label="Clear" type="button" style="display:none;"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '  <div class="avatar" id="search-avatar">' + PolarisTabs.escapeHtml(initials) + '</div>'
      + '</div>';
  }

  // Where closing search returns to. `pushed` = opening search added a history
  // entry, so the browser's own back (and the arrow) can simply pop it.
  var _searchReturn = { route: "", pushed: false };

  /** The searchbar's chrome for the route showing: open (back arrow) or closed (magnifier). */
  function syncSearchChrome() {
    var input = document.getElementById("search-input");
    var back  = document.getElementById("search-back-btn");
    var icon  = document.getElementById("search-icon-btn");
    var clear = document.getElementById("search-clear-btn");
    var avatar = document.getElementById("search-avatar");
    var bar   = document.getElementById("m3-searchbar");
    if (!input) return;
    var open = PolarisRouter.current().name === "search";
    var hasText = !!input.value;
    if (back)   back.style.display   = open ? "" : "none";
    if (icon)   icon.style.display   = open ? "none" : "";
    if (clear)  clear.style.display  = hasText ? "" : "none";
    if (avatar) avatar.style.display = hasText ? "none" : "";
    if (bar) bar.classList.toggle("expanded", open);
    app.classList.toggle("searching", open);
  }

  /** Open search over the current page. */
  function openSearch() {
    var cur = PolarisRouter.current();
    if (cur.name === "search") return;
    _searchReturn = { route: cur.full || "", pushed: true };
    PolarisRouter.go("search");
  }

  /**
   * The top-bar magnifier. Reveals the bar and focuses the input in the SAME
   * tap, before the route change lands: iOS only raises the keyboard for a
   * focus() made inside the user's gesture, and the input is display:none
   * until `.searching` is on.
   */
  function openSearchFromButton() {
    app.classList.add("searching");
    var input = document.getElementById("search-input");
    if (input) input.focus();
    openSearch();
  }

  /**
   * Put the magnifier into the page's top bar, first in its trailing group —
   * between the title on the left and the page's own buttons (refresh…) on
   * the right. Done here once for every page rather than in each
   * renderTopbar, so a new page cannot ship without search. A page with no
   * .m3-topbar (the topology graph, which has its own site search) gets none.
   */
  function addTopbarSearch(topbar) {
    if (!topbar) return;
    var trailing = topbar.querySelector(".m3-topbar .trailing");
    if (!trailing || trailing.querySelector(".topbar-search-btn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn topbar-search-btn";
    btn.setAttribute("aria-label", "Search");
    btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-search"/></svg>';
    btn.addEventListener("click", openSearchFromButton);
    trailing.insertBefore(btn, trailing.firstChild);
  }

  /** Close search: clear the box and go back to the page it was opened over. */
  function closeSearch() {
    var input = document.getElementById("search-input");
    if (input) { input.value = ""; input.blur(); }
    PolarisSearch.runSearch("");
    var ret = _searchReturn;
    _searchReturn = { route: "", pushed: false };
    if (PolarisRouter.current().name !== "search") { syncSearchChrome(); return; }
    // Through the asset sheet's helper: a sheet opened from a result sits on
    // a history entry of its own above #search.
    if (ret.pushed && window.history.length > 1) {
      if (window.PolarisAssetDetail && PolarisAssetDetail.historyBack) PolarisAssetDetail.historyBack();
      else window.history.back();
    }
    else PolarisRouter.go(ret.route || "alerts", { replace: true });
  }

  function wireSearchbar() {
    var input    = document.getElementById("search-input");
    var clearBtn = document.getElementById("search-clear-btn");
    var iconBtn  = document.getElementById("search-icon-btn");
    var backBtn  = document.getElementById("search-back-btn");
    if (!input) return;

    input.addEventListener("input", function () {
      var q = input.value.trim();
      // Typing while search is closed (a paste, an autofill) opens it, so the
      // results have somewhere to land.
      if (q.length > 0 && PolarisRouter.current().name !== "search") openSearch();
      syncSearchChrome();
      PolarisSearch.debounce(q);
    });

    // Tapping the box opens search with the shortcut chips showing before a
    // single character is typed. Focus also fires on keyboard re-entry; that
    // is harmless, because openSearch does nothing while search is open.
    input.addEventListener("focus", openSearch);
    if (iconBtn) iconBtn.addEventListener("click", function () { input.focus(); });
    if (backBtn) backBtn.addEventListener("click", closeSearch);

    input.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      // First Escape clears the query, a second one closes search.
      if (input.value) {
        input.value = "";
        syncSearchChrome();
        PolarisSearch.runSearch("");
      } else {
        closeSearch();
      }
    });

    if (clearBtn) clearBtn.addEventListener("click", function () {
      input.value = "";
      syncSearchChrome();
      PolarisSearch.runSearch("");
      input.focus();
    });
  }

  // ─── The Chat slot ─────────────────────────────────────────────────────
  // The AI assistant is optional and off by default, so the navbar's fourth
  // slot is Chat only for a user whose role reads `assistant` on an install
  // with an enabled AI Assistant integration; everyone else keeps Networks
  // there (PolarisTabs.setChatInBar). The answer is cached per phone so the
  // bar does not change shape on every load.
  var LS_CHAT_OK = "polaris-mobile-chat-available";
  function lsChatAvailable() { try { return localStorage.getItem(LS_CHAT_OK); } catch (_) { return null; } }
  function chatPermitted(user) {
    var rank = { none: 0, read: 1, write: 2, fullwrite: 3 };
    return (rank[(user && user.permissions && user.permissions.assistant) || "none"] || 0) >= 1;
  }
  function applyChatSlot(on) {
    try { localStorage.setItem(LS_CHAT_OK, on ? "1" : "0"); } catch (_) { /* private mode */ }
    if (!PolarisTabs.setChatInBar(on)) return;
    var nav = document.getElementById("navbar");
    if (nav) {
      nav.outerHTML = buildNavbar();
      wireNavbar();
    }
    // Re-dispatch so the current page agrees with the new bar (the More menu
    // gains or loses its Networks row; #chat / #networks change home).
    var cur = PolarisRouter.current();
    if (cur) routeChanged(cur);
  }
  function refreshChatSlot(user) {
    if (!chatPermitted(user) || !api.assistant) { applyChatSlot(false); return; }
    api.assistant.status()
      .then(function (s) { applyChatSlot(!!(s && s.enabled)); })
      .catch(function () { /* offline or transient — keep what the cache said */ });
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

  // `data-tab` keeps the ROUTE's id (CSS and map-tab key off it); the lit
  // navbar slot is resolved through PolarisTabs.navTabFor, so a route with no
  // slot of its own (the Device Map, under More) lights the one it lives in.
  function highlightNav(tabId) {
    var nav = document.getElementById("navbar");
    if (!nav) return;
    var lit = tabId ? PolarisTabs.navTabFor(tabId) : "";
    nav.querySelectorAll(".nav-item").forEach(function (btn) {
      btn.classList.toggle("active", lit !== "" && btn.dataset.tab === lit);
    });
  }

  function setActiveTab(tabId) {
    app.dataset.tab = tabId || "";
    highlightNav(tabId);
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

    // Retired routes. The Reservations tab and More → Networks both became
    // the Networks tab; an installed PWA keeps its home-screen shortcut
    // (#reservations) until the manifest is re-read, and bookmarks keep
    // theirs forever, so both land on the tab rather than bouncing to Search.
    if (route && (route.name === "reservations"
        || (route.name === "more" && route.parts && route.parts[0] === "subnets"))) {
      PolarisRouter.go("networks", { replace: true });
      return;
    }
    // More → Alerts became the Alerts tab. A push already sitting in a tray
    // carries the #more/alerts URL it was sent with, so it must still land.
    if (route && route.name === "more" && route.parts && route.parts[0] === "alerts") {
      PolarisRouter.go("alerts", { replace: true });
      return;
    }

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
    // Any route but search means search is closed: the history entry opening
    // it pushed is no longer the one on top, so a later close must navigate
    // rather than pop.
    if (route && route.name !== "search") _searchReturn.pushed = false;
    syncSearchChrome();

    // Top-level tab?
    var tabSpec = PolarisTabs.byId(route.name);
    if (tabSpec) {
      setActiveTab(route.name);
      var tabCtx = { user: currentUser, route: route };
      topbar.innerHTML = tabSpec.renderTopbar
        ? tabSpec.renderTopbar(tabCtx) : '';
      addTopbarSearch(topbar);
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
      // visible but no item is active (e.g. block detail). A parentTab that
      // is itself a route tab (the map, for #site / #topology) lights the
      // slot it lives under.
      var parentTab = detailSpec.parentTab || "";
      app.dataset.tab = parentTab || route.name;
      highlightNav(parentTab);

      var detailCtx = { user: currentUser, route: route };
      topbar.innerHTML = detailSpec.renderTopbar
        ? detailSpec.renderTopbar(detailCtx) : '';
      addTopbarSearch(topbar);
      detailSpec.render(body, detailCtx);
      body.scrollTop = 0;
      installPtrForSpec(detailSpec, detailCtx);
      return;
    }

    // Unknown route — bounce to the home route. Clear any installed PTR.
    if (_ptrRelease) { try { _ptrRelease(); } catch (_) {} _ptrRelease = null; }
    PolarisRouter.go("alerts", { replace: true });
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
