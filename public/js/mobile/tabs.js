// public/js/mobile/tabs.js — Tab renderers.
//
// Each tab exposes `render(body, ctx)` where:
//   body — the .app-body element to populate
//   ctx  — { user, route } so handlers can act on the current user/route
//
// Phase 1 ships the navigation shell and placeholder bodies. Subsequent
// phases replace the placeholder bodies with real implementations.

(function () {
  function placeholder(title, message) {
    return ''
      + '<div class="empty-state">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-construction"/></svg></div>'
      + '  <div class="ttl">' + title + '</div>'
      + '  <div class="desc">' + message + '</div>'
      + '</div>';
  }

  // ─── Shared snackbar ───────────────────────────────────────────────────
  // Single-instance toast at the bottom of the viewport, above the navbar.
  // showSnackbar(message, opts?) where opts may carry { error, action: { label, onClick }, duration }.
  // Re-calling supersedes the previous toast immediately.
  var _snackTimer = null;
  function showSnackbar(message, opts) {
    opts = opts || {};
    var existing = document.getElementById("snackbar");
    if (existing) existing.remove();
    if (_snackTimer) { clearTimeout(_snackTimer); _snackTimer = null; }

    var sb = document.createElement("div");
    sb.id = "snackbar";
    sb.className = "snackbar" + (opts.error ? " error" : "");
    sb.innerHTML = '<span class="label">' + escapeHtml(message) + '</span>'
      + (opts.action ? '<button class="action" id="snack-action">' + escapeHtml(opts.action.label) + '</button>' : '');
    document.body.appendChild(sb);

    if (opts.action) {
      document.getElementById("snack-action").addEventListener("click", function () {
        try { opts.action.onClick(); } catch (_) {}
        sb.remove();
        if (_snackTimer) { clearTimeout(_snackTimer); _snackTimer = null; }
      });
    }

    _snackTimer = setTimeout(function () {
      sb.remove();
      _snackTimer = null;
    }, opts.duration || 3500);
  }

  // ─── Search ────────────────────────────────────────────────────────────
  // Default group order on results — picks the most discriminating hits
  // first so the user sees the answer they were typing toward at the top
  // of the list. IPs is first because typing an IP is the strongest
  // signal ("the user knows the exact IP and wants to see what's
  // there"). Page-aware hoisting: when the operator was on a specific
  // page before they started typing (Networks / Assets / Map / Blocks),
  // that page's section is moved to the top so they see
  // matches from the surface they were already working on first.
  var SEARCH_GROUP_ORDER = ["sites", "ips", "assets", "subnets", "reservations", "blocks"];

  // Updated by app.js whenever the user navigates to a non-search route.
  // Persists across the user typing in the searchbar (which replace-
  // navigates them to /search), so we still know which page they came
  // from when we render results.
  var _searchOriginRoute = { name: "", parts: [] };

  function setSearchOriginRoute(name, parts) {
    _searchOriginRoute = { name: name || "", parts: parts || [] };
  }

  // Map the current/originating route to its corresponding search group,
  // or null when the page doesn't correspond to any group (Search tab,
  // More root, Events, etc.).
  function groupForOriginRoute(route) {
    var n = route && route.name;
    var p = (route && route.parts) || [];
    if (n === "assets" || n === "asset")            return "assets";
    if (n === "map" || n === "site" || n === "topology") return "sites";
    if (n === "networks" || n === "subnet")         return "subnets";
    if (n === "block")                              return "blocks";
    if (n === "more") {
      if (p[0] === "subnets") return "subnets";
      if (p[0] === "blocks")  return "blocks";
    }
    return null;
  }

  function orderedSearchGroups() {
    var hoist = groupForOriginRoute(_searchOriginRoute);
    if (!hoist) return SEARCH_GROUP_ORDER.slice();
    var rest = SEARCH_GROUP_ORDER.filter(function (g) { return g !== hoist; });
    return [hoist].concat(rest);
  }

  var SEARCH_GROUP_META = {
    ips:           { label: "IP addresses",  icon: "#i-router",   leading: "tonal" },
    assets:        { label: "Assets",        icon: "#i-server",   leading: "" },
    sites:         { label: "Device Map",    icon: "#i-map",      leading: "tertiary" },
    subnets:       { label: "Networks",      icon: "#i-subnet",   leading: "tonal" },
    reservations:  { label: "Reservations",  icon: "#i-bookmark", leading: "" },
    blocks:        { label: "Blocks",        icon: "#i-block",    leading: "" },
  };

  // Map a hit to the route to navigate to on tap. Returns null when there's
  // no sensible mobile destination (those rows are still tappable but
  // navigate via fallback — see hitClick).
  function hitTarget(group, hit) {
    if (group === "assets")       return "asset/" + hit.id;
    if (group === "sites") {
      // Virtual map entry synthesized from an endpoint asset hit — open the
      // origin FortiGate's topology graph focused on the endpoint instead of
      // the firewall's own site sheet (which has no context for the asset).
      var sctx = hit.context || {};
      if (sctx.mapEntry && sctx.siteId) {
        var focus = sctx.focusHostname || sctx.focusIpAddress || sctx.focusMacAddress;
        return "topology/" + sctx.siteId + (focus ? "?q=" + encodeURIComponent(focus) : "");
      }
      return "site/" + hit.id;
    }
    if (group === "subnets")      return "subnet/" + hit.id;
    if (group === "blocks")       return "block/" + hit.id;
    if (group === "reservations") {
      var ctx = hit.context || {};
      if (ctx.subnetId) return "subnet/" + ctx.subnetId;
      return null;
    }
    if (group === "ips") {
      var ctx2 = hit.context || {};
      if (ctx2.subnetId) return "subnet/" + ctx2.subnetId;
      return null;
    }
    return null;
  }

  // ─── Persistent search engine ──────────────────────────────────────────
  // The search input lives in #search-slot in the app shell (wired by
  // app.js renderShell) so it's visible on every page. The actual query
  // execution + result rendering lives here and is exposed via
  // window.PolarisSearch — the shell calls run() on every input change
  // and the Search tab's render() calls it once on mount to paint
  // results for the current input value.
  var _searchInFlight = null;
  var _searchDebounce = null;

  function searchState() {
    return document.getElementById("search-state");
  }

  function renderSearchEmpty() {
    var state = searchState();
    if (!state) return;
    // Scope-prefix shortcuts. Tapping a chip pre-fills the search bar
    // with the prefix + space and leaves focus there so the operator can
    // keep typing into the scoped query.
    var hints = [
      { prefix: "block:",       short: "b:", label: "IP blocks only" },
      { prefix: "network:",     short: "n:", label: "Networks only" },
      { prefix: "asset:",       short: "a:", label: "Assets only" },
      { prefix: "reservation:", short: "r:", label: "Reservations only" },
      { prefix: "map:",         short: "m:", label: "Pinned firewalls only" },
    ];
    var chipHtml = hints.map(function (h) {
      return '<button class="search-hint-chip" type="button" data-prefix="' + escapeHtml(h.prefix) + '">'
        + '<div class="search-hint-keys">'
        + '<span class="search-hint-key">' + escapeHtml(h.prefix) + '</span>'
        + '<span class="search-hint-or">or</span>'
        + '<span class="search-hint-key">' + escapeHtml(h.short) + '</span>'
        + '</div>'
        + '<div class="search-hint-label">' + escapeHtml(h.label) + '</div>'
        + '</button>';
    }).join("");
    state.innerHTML = ''
      + '<div class="empty-state" style="padding-top:32px;padding-bottom:8px;">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></div>'
      + '  <div class="ttl">Search Polaris</div>'
      + '  <div class="desc">Find IPs, assets, networks, FortiGate sites and reservations. Try typing an IP, hostname, MAC, or partial name.</div>'
      + '</div>'
      + '<div class="search-hint-section">'
      + '  <div class="search-hint-section-label">Shortcuts — scope your search</div>'
      + '  <div class="search-hint-grid">' + chipHtml + '</div>'
      + '  <div class="search-hint-foot">Scoped searches return up to 200 results instead of the default top 8.</div>'
      + '</div>';
    state.querySelectorAll(".search-hint-chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var input = document.getElementById("search-input");
        if (!input) return;
        input.value = chip.getAttribute("data-prefix") + " ";
        input.focus();
        // Move caret to end so the next keystroke continues the scoped query.
        var v = input.value;
        input.setSelectionRange(v.length, v.length);
        // Keep the hint panel visible — the operator hasn't typed a real query yet.
      });
    });
  }

  function renderSearchLoading() {
    var state = searchState();
    if (!state) return;
    state.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
  }

  function renderSearchError(msg) {
    var state = searchState();
    if (!state) return;
    state.innerHTML = ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Search failed</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  function renderSearchResults(data) {
    var state = searchState();
    if (!state) return;
    // Mirror desktop: surface endpoint asset hits that resolved to a
    // pinned FortiGate as virtual "Device Map" entries so a workstation
    // search opens its origin site's topology graph, not just the asset
    // details page. Without this the Device Map section only ever appears
    // when the operator types a firewall hostname directly.
    //
    // Suppress the injection when the operator typed a non-map scope
    // prefix (e.g. `a:`, `asset:`, `r:`, `n:`, `b:`). The backend already
    // returns only that group's hits; synthesizing Device Map rows from
    // the asset list would defeat the scope.
    var scopeMatch = (data.query || "").match(/^(block|asset|reservation|network|b|a|r|n):/i);
    if (!scopeMatch) {
      var virtualSites = (data.assets || [])
        .filter(function (h) { return h.context && h.context.siteId; })
        .map(function (h) {
          var ctx = Object.assign({}, h.context, { mapEntry: true });
          var subtitle = ctx.siteHostname ? ("On " + ctx.siteHostname) : (h.subtitle || "");
          return Object.assign({}, h, { subtitle: subtitle, context: ctx });
        });
      data.sites = (data.sites || []).concat(virtualSites);
    }

    var groupOrder = orderedSearchGroups();
    var totalHits = 0;
    groupOrder.forEach(function (g) { totalHits += (data[g] || []).length; });
    if (totalHits === 0) {
      state.innerHTML = ''
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-search"/></svg></div>'
        + '  <div class="ttl">No matches</div>'
        + '  <div class="desc">Nothing matched “' + escapeHtml(data.query || "") + '”. Try a different query.</div>'
        + '</div>';
      return;
    }

    var html = "";
    groupOrder.forEach(function (g) {
      var hits = data[g] || [];
      if (hits.length === 0) return;
      var meta = SEARCH_GROUP_META[g];
      html += '<div class="section-head">' + meta.label + '<span class="count">' + hits.length + '</span></div>';
      hits.forEach(function (hit, idx) {
        var titleClass = (g === "ips" || g === "subnets" || g === "blocks") ? "headline mono" : "headline";
        var leadingCls = "leading" + (meta.leading ? " " + meta.leading : "");
        // Asset + site hits carry the same active-alert summary the Assets
        // list's flag reads (`hit.alert`, stamped by the search service in one
        // query for the whole result set), drawn here as the strobing dot —
        // so a device that looks alarmed in the list looks alarmed when you
        // search for it. Not a tap target; the row still opens the device.
        var alertDot = (window.PolarisMobileAlerts && hit.alert)
          ? PolarisMobileAlerts.dotHTML(hit.alert) : "";
        html += ''
          + '<button class="list-item two-line" data-group="' + g + '" data-idx="' + idx + '">'
          + '  <span class="' + leadingCls + '"><svg viewBox="0 0 24 24"><use href="' + meta.icon + '"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="' + titleClass + '">' + escapeHtml(hit.title || "") + alertDot + '</div>'
          + (hit.subtitle ? '    <div class="supporting">' + escapeHtml(hit.subtitle) + '</div>' : '')
          + '  </div>'
          + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
          + '</button>';
      });
    });
    state.innerHTML = html;

    // Wire row taps. We rebuild the list on every query so listeners
    // are fresh — no leak risk.
    state.querySelectorAll(".list-item").forEach(function (row) {
      row.addEventListener("click", function () {
        var g = row.dataset.group;
        var idx = parseInt(row.dataset.idx, 10);
        var hit = (data[g] || [])[idx];
        if (!hit) return;
        // Asset hits open the slide-up sheet over the current screen rather
        // than navigating to a full-page route.
        if (g === "assets" && hit.id && window.PolarisAssetDetail && PolarisAssetDetail.open) {
          PolarisAssetDetail.open(hit.id);
          return;
        }
        var target = hitTarget(g, hit);
        if (target) {
          PolarisRouter.go(target);
        } else {
          showSnackbar("No mobile view for this result yet — open it on desktop.");
        }
      });
    });
  }

  // Called by the shell on every searchbar input (debounced) and by the
  // Search tab's render() on mount. No-op when #search-state isn't in
  // the DOM yet — happens on detail pages where the body owns its own
  // content; the bar still navigates to /search via the shell handler
  // before this would matter.
  function runSearch(q) {
    if (!searchState()) return;
    if (_searchInFlight) { _searchInFlight.abort(); _searchInFlight = null; }
    if (q.length < 2) {
      renderSearchEmpty();
      return;
    }
    _searchInFlight = new AbortController();
    var thisFlight = _searchInFlight;

    renderSearchLoading();
    fetch("/api/v1/search?q=" + encodeURIComponent(q), { signal: thisFlight.signal })
      .then(function (r) {
        if (r.status === 401) { window.PolarisMobile.boot(); throw new Error("auth"); }
        if (!r.ok) throw new Error("Request failed (" + r.status + ")");
        return r.json();
      })
      .then(function (data) {
        if (thisFlight !== _searchInFlight) return; // superseded
        renderSearchResults(data);
      })
      .catch(function (err) {
        if (err.name === "AbortError" || err.message === "auth") return;
        renderSearchError(err.message || "Network error");
      });
  }

  // Intentionally a local helper, not table-sf.js's generic debounce():
  // table-sf.js isn't loaded on mobile.html, and this variant closes over the
  // per-keystroke query `q` (the generic one wraps a fixed fn with no args).
  function debounceSearch(q) {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(function () { runSearch(q); }, 200);
  }

  var Search = {
    title: "Search",
    icon: "#i-search",
    // No per-tab topbar — the persistent searchbar lives in the shell
    // (#search-slot, wired by app.js renderShell).
    renderTopbar: function () { return ''; },
    render: function (body) {
      body.innerHTML = '<div id="search-state"></div>';
      // Re-run against the current persistent-input value so coming back
      // to the Search tab with a non-empty bar shows the same results.
      var input = document.getElementById("search-input");
      var q = input ? (input.value || "").trim() : "";
      if (q.length >= 2) runSearch(q);
      else renderSearchEmpty();
    },
  };

  // Exposed so app.js can wire the persistent input.
  window.PolarisSearch = {
    runSearch: runSearch,
    debounce:  debounceSearch,
    // Called by app.js on every non-search route change so the result
    // renderer can hoist the matching section to the top.
    setOriginRoute: setSearchOriginRoute,
  };

  // ─── Map ───────────────────────────────────────────────────────────────
  // Real spec lives in /js/mobile/map-tab.js. Loaded before tabs.js so the
  // window.PolarisMapTab namespace is available here.
  var Map = (window.PolarisMapTab && window.PolarisMapTab.spec) || {
    title: "Device Map",
    icon: "#i-map",
    renderTopbar: function () { return ''; },
    render: function (body) { body.innerHTML = placeholder("Map module not loaded", "PolarisMapTab is missing — check script load order."); },
  };

  // ─── Assets ────────────────────────────────────────────────────────────
  // Real spec lives in /js/mobile/assets-tab.js. Loaded before tabs.js so the
  // window.PolarisAssetsTab namespace is available here.
  var Assets = (window.PolarisAssetsTab && window.PolarisAssetsTab.spec) || {
    title: "Assets",
    icon: "#i-list",
    renderTopbar: function () { return ''; },
    render: function (body) { body.innerHTML = placeholder("Assets module not loaded", "PolarisAssetsTab is missing — check script load order."); },
  };

  // ─── Networks ──────────────────────────────────────────────────────────
  // Real spec lives in /js/mobile/networks-tab.js. It took the slot the
  // Reservations tab held: a reservation is now seen and acted on in its
  // network's IP sheet.
  var Networks = (window.PolarisNetworksTab && window.PolarisNetworksTab.spec) || {
    title: "Networks",
    icon: "#i-subnet",
    renderTopbar: function () { return ''; },
    render: function (body) { body.innerHTML = placeholder("Networks module not loaded", "PolarisNetworksTab is missing — check script load order."); },
  };

  // ─── More ──────────────────────────────────────────────────────────────
  // Real spec lives in /js/mobile/more-tab.js.
  var More = (window.PolarisMoreTab && window.PolarisMoreTab.spec) || {
    title: "More",
    icon: "#i-more",
    renderTopbar: function () { return ''; },
    render: function (body) { body.innerHTML = placeholder("More module not loaded", "PolarisMoreTab is missing."); },
  };

  // ─── Tab registry ──────────────────────────────────────────────────────
  // Order here drives the navbar layout. Keep at five — that's the MD3 spec
  // limit and what fits comfortably on a phone width.
  var TABS = [
    { id: "search",  spec: Search },
    { id: "map",     spec: Map },
    { id: "assets",  spec: Assets },
    { id: "networks", spec: Networks },
    { id: "more",    spec: More },
  ];

  // ─── helpers ───────────────────────────────────────────────────────────
  // escapeHtml is the canonical global from api.js (loaded first on every page).

  // ─── Sheet swipe-to-dismiss ────────────────────────────────────────────
  // Touch-drag the sheet downward to dismiss. Companion to the X button
  // and scrim tap — all three end up calling the same close function.
  //
  // Rules:
  //   - Drag is captured only when the gesture starts on the handle, OR
  //     when the sheet's scroll position is already at the top. Anywhere
  //     else, native vertical scroll wins.
  //   - Form controls (input/textarea/select/contenteditable) opt out so
  //     the iOS text-cursor drag and selection handles still work.
  //   - Buttons and anchors stay tappable — we don't preventDefault on
  //     touchstart, so a clean tap still fires click; only a real drag
  //     (>5 px down) starts moving the sheet.
  //   - Dismiss fires past 30% of sheet height OR a short downward flick
  //     (≥40 px with velocity ≥0.5 px/ms). Below that, the sheet snaps
  //     back into place.
  // `opts.onSwipeDown`, if provided, replaces the default
  // animate-to-translateY(100%) → onDismiss sequence: the helper clears its
  // inline transform/transition first so the caller can run their own
  // CSS-class-driven animation (e.g. expanded → peek) and decide whether to
  // dismiss outright. Used by the asset detail sheet to make the first
  // swipe-down lock to the peek state and the second one dismiss.
  function attachSwipeToDismiss(sheetEl, onDismiss, opts) {
    if (!sheetEl || typeof onDismiss !== "function") return;
    opts = opts || {};

    var startY = 0;
    var startTime = 0;
    var currentY = 0;       // signed: positive = downward drag, negative = upward
    var baseline = 0;       // px to add to dy when writing inline transform
                            // (e.g. current peek offset, so drag continues from there)
    var tracking = false;   // touchstart accepted the gesture
    var dragging = false;   // user has moved past the activation threshold
    var direction = null;   // "down" or "up" once activated
    var startedOnHandle = false;
    var restoreTimer = null;

    function isFormControl(el) {
      if (!el || !el.closest) return false;
      return !!el.closest("input, textarea, select, [contenteditable=\"true\"]");
    }

    function onTouchStart(e) {
      if (!e.touches || e.touches.length !== 1) return;
      var target = e.target;

      // Form controls keep their native gesture handling.
      if (isFormControl(target)) return;

      var handle = sheetEl.querySelector(".sheet-handle");
      startedOnHandle = !!(handle && handle.contains(target));

      // Off-handle drags only count when the sheet content is already
      // scrolled to the top — otherwise the user is scrolling, not
      // dismissing.
      if (!startedOnHandle && sheetEl.scrollTop > 0) return;

      tracking = true;
      dragging = false;
      startY = e.touches[0].clientY;
      startTime = Date.now();
      currentY = 0;
      baseline = (typeof opts.baselineTranslate === "function")
        ? (Number(opts.baselineTranslate()) || 0)
        : 0;

      if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = null; }
      sheetEl.style.transition = "none";
    }

    function onTouchMove(e) {
      if (!tracking) return;
      var dy = e.touches[0].clientY - startY;

      // Below activation threshold: don't intercept yet, so a sloppy tap
      // still resolves to a click on the underlying button.
      if (!dragging && Math.abs(dy) < 5) return;

      if (!dragging) {
        dragging = true;
        direction = dy > 0 ? "down" : "up";
      }

      if (direction === "up") {
        // Upward gesture. If the sheet is offset (baseline > 0, e.g. peeked)
        // AND the caller wired an onSwipeUp handler, this is a "drag the
        // sheet back up" gesture — capture it. Otherwise let native scroll
        // take over.
        if (baseline > 0 && typeof opts.onSwipeUp === "function") {
          // Constrain so the inline transform never goes above the natural
          // position (baseline + dy >= 0).
          var translatedUp = Math.max(dy, -baseline);
          sheetEl.style.transform = "translateY(" + (baseline + translatedUp) + "px)";
          currentY = dy;   // negative
          if (e.cancelable) e.preventDefault();
          return;
        }
        // No upward handler available — release the gesture; native scroll
        // can take over.
        sheetEl.style.transition = "transform .2s ease-out";
        sheetEl.style.transform = "";
        tracking = false;
        dragging = false;
        direction = null;
        currentY = 0;
        return;
      }

      // Downward gesture.
      // Light resistance past 200 px so the sheet doesn't fly off-screen
      // on a long drag — keeps the snap-back feel reasonable.
      var translated = dy < 200 ? dy : 200 + (dy - 200) * 0.5;
      sheetEl.style.transform = "translateY(" + (baseline + translated) + "px)";
      currentY = dy;

      if (e.cancelable) e.preventDefault();
    }

    function onTouchEnd() {
      if (!tracking) return;
      tracking = false;
      if (!dragging) { sheetEl.style.transition = ""; direction = null; return; }
      dragging = false;
      var dir = direction;
      direction = null;

      var elapsed = Math.max(Date.now() - startTime, 1);
      var dist = Math.abs(currentY);
      var velocity = dist / elapsed;   // px per ms
      var height = sheetEl.offsetHeight || 400;
      var threshold = Math.min(120, height * 0.3);
      var crossed = dist >= threshold || (dist >= 40 && velocity >= 0.5);

      if (dir === "up" && typeof opts.onSwipeUp === "function") {
        if (crossed) {
          sheetEl.style.transition = "";
          sheetEl.style.transform = "";
          try { opts.onSwipeUp(); } catch (_) {}
        } else {
          // Not enough — snap back to baseline (peek position).
          sheetEl.style.transition = "transform .2s ease-out";
          sheetEl.style.transform = "";
          restoreTimer = setTimeout(function () {
            sheetEl.style.transition = "";
            restoreTimer = null;
          }, 220);
        }
        return;
      }

      if (dir === "down" && crossed) {
        if (typeof opts.onSwipeDown === "function") {
          // Hand off — the caller will animate (e.g. snap to peek). Clear our
          // inline overrides so their CSS-class transition runs cleanly.
          sheetEl.style.transition = "";
          sheetEl.style.transform = "";
          try { opts.onSwipeDown(); } catch (_) {}
        } else {
          sheetEl.style.transition = "transform .2s ease-out";
          sheetEl.style.transform = "translateY(100%)";
          setTimeout(function () {
            try { onDismiss(); } catch (_) {}
          }, 180);
        }
      } else {
        sheetEl.style.transition = "transform .2s ease-out";
        sheetEl.style.transform = "";
        restoreTimer = setTimeout(function () {
          sheetEl.style.transition = "";
          restoreTimer = null;
        }, 220);
      }
    }

    sheetEl.addEventListener("touchstart",  onTouchStart, { passive: true });
    sheetEl.addEventListener("touchmove",   onTouchMove,  { passive: false });
    sheetEl.addEventListener("touchend",    onTouchEnd,   { passive: true });
    sheetEl.addEventListener("touchcancel", onTouchEnd,   { passive: true });
  }

  // ─── Pull-to-refresh ───────────────────────────────────────────────────
  // Touch-pull on a scrollable element (typically #app-body) to trigger an
  // async refresh. MD3-style: only the indicator puck moves; body content
  // stays put. Caller passes onRefresh which may return a Promise — the
  // puck spins until it settles. Returns a release() function to tear down
  // the listeners + remove the indicator; the route handler in app.js
  // calls release() on every route change so handlers don't stack up.
  //
  // Rules:
  //   - Only tracks when the gesture starts with scrollEl.scrollTop === 0,
  //     so a pull from mid-scroll doesn't fire.
  //   - Form controls opt out so iOS text-cursor drag still works.
  //   - Click suppression is left to the browser: a touchmove past ~10px
  //     already cancels the underlying button's click, so we never need
  //     preventDefault here. That also means the touchmove listener can
  //     stay passive — no jank.
  //   - Threshold 70px to trigger; opacity ramps in from 0..40px so a
  //     stray nudge doesn't flash the puck.
  function installPullRefresh(scrollEl, onRefresh) {
    if (!scrollEl || typeof onRefresh !== "function") return function () {};

    var ind = document.createElement("div");
    ind.className = "ptr-indicator";
    ind.innerHTML = '<div class="ptr-circle"><svg class="ptr-svg" viewBox="0 0 24 24"><use href="#i-refresh"/></svg></div>';
    scrollEl.appendChild(ind);

    var THRESHOLD = 70;
    var MAX = 120;
    var startY = 0;
    var dy = 0;
    var tracking = false;
    var refreshing = false;

    function isFormControl(el) {
      if (!el || !el.closest) return false;
      return !!el.closest('input, textarea, select, [contenteditable="true"]');
    }

    function setPuck(amount, state) {
      var svg = ind.querySelector(".ptr-svg");
      if (state === "rest") {
        ind.classList.remove("ready", "refreshing");
        ind.style.opacity = "0";
        ind.style.transform = "translateY(-56px)";
        if (svg) svg.style.transform = "";
        return;
      }
      if (state === "refreshing") {
        ind.classList.add("refreshing");
        ind.classList.remove("ready");
        ind.style.opacity = "1";
        ind.style.transform = "translateY(8px)";
        if (svg) svg.style.transform = "";
        return;
      }
      // pulling
      var travel = Math.min(amount, MAX);
      ind.style.opacity = String(Math.min(travel / 40, 1));
      ind.style.transform = "translateY(" + (travel - 48) + "px)";
      ind.classList.toggle("ready", amount >= THRESHOLD);
      // Rotate the icon proportionally to progress, capped at the threshold.
      if (svg) {
        var rot = Math.min(amount / THRESHOLD, 1) * 270;
        svg.style.transform = "rotate(" + rot + "deg)";
      }
    }

    function reset() { setPuck(0, "rest"); }
    reset();

    function onTouchStart(e) {
      if (refreshing) return;
      if (!e.touches || e.touches.length !== 1) return;
      if (isFormControl(e.target)) return;
      if (scrollEl.scrollTop > 0) return;
      tracking = true;
      startY = e.touches[0].clientY;
      dy = 0;
      ind.style.transition = "none";
    }

    function onTouchMove(e) {
      if (!tracking || refreshing) return;
      dy = e.touches[0].clientY - startY;
      if (dy <= 0 || scrollEl.scrollTop > 0) {
        // Going up or page scrolled mid-gesture — abandon.
        tracking = false;
        ind.style.transition = "transform .2s ease, opacity .2s ease";
        reset();
        return;
      }
      // Light resistance past MAX so the puck doesn't run off-screen on a
      // long drag.
      var amount = dy < MAX ? dy : MAX + (dy - MAX) * 0.3;
      setPuck(amount, "pulling");
    }

    function onTouchEnd() {
      if (!tracking) return;
      tracking = false;
      ind.style.transition = "transform .25s ease, opacity .25s ease";
      if (dy >= THRESHOLD && !refreshing) {
        refreshing = true;
        setPuck(0, "refreshing");
        var done = function () {
          refreshing = false;
          reset();
        };
        var result;
        try { result = onRefresh(); } catch (_) { result = null; }
        if (result && typeof result.then === "function") {
          result.then(done, done);
        } else {
          // Caller returned nothing — keep the puck visible briefly so the
          // pull feels like it did something, then hide.
          setTimeout(done, 600);
        }
      } else {
        reset();
      }
    }

    scrollEl.addEventListener("touchstart",  onTouchStart, { passive: true });
    scrollEl.addEventListener("touchmove",   onTouchMove,  { passive: true });
    scrollEl.addEventListener("touchend",    onTouchEnd,   { passive: true });
    scrollEl.addEventListener("touchcancel", onTouchEnd,   { passive: true });

    return function release() {
      scrollEl.removeEventListener("touchstart",  onTouchStart);
      scrollEl.removeEventListener("touchmove",   onTouchMove);
      scrollEl.removeEventListener("touchend",    onTouchEnd);
      scrollEl.removeEventListener("touchcancel", onTouchEnd);
      if (ind.parentNode) ind.parentNode.removeChild(ind);
    };
  }

  window.PolarisTabs = {
    list: TABS,
    byId: function (id) {
      for (var i = 0; i < TABS.length; i++) if (TABS[i].id === id) return TABS[i].spec;
      return null;
    },
    escapeHtml: escapeHtml,
    placeholder: placeholder,
    showSnackbar: showSnackbar,
    attachSwipeToDismiss: attachSwipeToDismiss,
    installPullRefresh: installPullRefresh,
  };
})();
