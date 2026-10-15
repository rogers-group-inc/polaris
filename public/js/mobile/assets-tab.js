// public/js/mobile/assets-tab.js — Assets list tab.
//
// Card feed of every asset, filterable by type via the chip row at the
// top. Tapping a card navigates to the asset detail route (real renderer
// arrives in Phase 5; Phase 4 lands on the placeholder).
//
// A card with live alerts additionally carries a strobing "Alerts" flag next
// to the hostname, coloured by the worst one — tapping it opens the alerts
// sheet for that device (acknowledge / clear, per the operator's role) rather
// than the device itself. Both the flag's markup and the sheet live in
// mobile/alerts.js; this file supplies the summary that rides the list
// payload and repaints the flag when the sheet hands back a new one.
//
// Above the chips sits the shared filter field + "Sort & filter" chip
// (mobile/list-controls.js). The text rides the route's `search` param, the
// sheet's status filter its `monitor` param (several statuses at once, CSV,
// which the route ORs), and the sort its sortBy/sortDir — all server-side,
// because the list is paged. The topbar no longer carries
// a search button: it only jumped to the Search tab, which the search bar
// above every page already reaches.
//
// State management: filter + asset list are kept on the module so a
// re-render (e.g. snapping back from a detail screen) can repopulate
// without re-fetching. Re-fetch on filter change.

(function () {
  // Asset type → leading icon + avatar class. Keep this in sync with the
  // .ico-* color tokens in mobile.css.
  var TYPE_META = {
    firewall:     { icon: "#i-shield",       cls: "ico-fw",    label: "Firewalls" },
    switch:       { icon: "#i-switch-icon",  cls: "ico-sw",    label: "Switches" },
    access_point: { icon: "#i-wifi",         cls: "ico-ap",    label: "APs" },
    router:       { icon: "#i-router",       cls: "ico-rtr",   label: "Routers" },
    server:       { icon: "#i-server",       cls: "ico-srv",   label: "Servers" },
    workstation:  { icon: "#i-desktop",      cls: "ico-wks",   label: "Workstations" },
    printer:      { icon: "#i-printer",      cls: "ico-prn",   label: "Printers" },
    hypervisor:   { icon: "#i-server",       cls: "ico-srv",   label: "Hypervisors" },
    container:    { icon: "#i-container",    cls: "ico-ctr",   label: "Containers" },
    other:       { icon: "#i-server",       cls: "ico-other", label: "Other" },
  };

  // Filter chips, in display order. `type` null = no assetType filter.
  var FILTERS = [
    { key: "all",          label: "All",          type: null },
    { key: "firewall",     label: "Firewalls",    type: "firewall" },
    { key: "switch",       label: "Switches",     type: "switch" },
    { key: "access_point", label: "APs",          type: "access_point" },
    { key: "router",       label: "Routers",      type: "router" },
    { key: "server",       label: "Servers",      type: "server" },
    { key: "workstation",  label: "Workstations", type: "workstation" },
    { key: "printer",      label: "Printers",     type: "printer" },
    { key: "container",    label: "Containers",   type: "container" },
    { key: "other",        label: "Other",        type: "other" },
  ];

  var PAGE_SIZE = 50;

  // Sort + filter run SERVER-side — the list is paged, so a client sort would
  // only order the pages already loaded. Keys are the route's own sortBy
  // whitelist (ASSET_SORT_COLUMNS in src/api/routes/assets.ts) and its
  // `monitor` chip vocabulary (monitorClause), so nothing here can ask for a
  // sort or a filter the server would refuse. "Recently added" is the
  // server's default order (no sortBy), which is what the list always showed.
  var PREFS_KEY = "polaris-mobile-assets-list";
  // `monitor` is an ARRAY: the sheet's status filter is multi-select, and the
  // route ORs the CSV it receives (monitorClause per value). Empty = Any.
  var DEFAULTS = { sortKey: "", sortDir: "desc", monitor: [] };
  var SORTS = [
    { key: "",          label: "Recently added", defaultDir: "desc" },
    { key: "hostname",  label: "Name",           defaultDir: "asc" },
    { key: "ipAddress", label: "IP address",     defaultDir: "asc" },
    { key: "_monitor",  label: "Status",         defaultDir: "asc" },
    { key: "assetType", label: "Type",           defaultDir: "asc" },
    { key: "lastSeen",  label: "Last seen",      defaultDir: "desc" },
  ];
  var MONITOR_FILTER = {
    key: "monitor",
    label: "Status",
    multi: true,
    options: [
      { value: "",            label: "Any" },
      { value: "Down",        label: "Down" },
      { value: "Missed",      label: "Missed" },
      { value: "Dep. Down",   label: "Dep. Down" },
      { value: "Recovering",  label: "Recovering" },
      { value: "Up",          label: "Up" },
      { value: "Monitored",   label: "Monitored" },
      { value: "Unmonitored", label: "Unmonitored" },
    ],
  };

  // ─── View tabs + favorites ─────────────────────────────────────────────
  // The desktop Assets page's tab strip (assets-tabs.js), read from the same
  // server-persisted layout (GET /me/table-tabs?scope=assets), so the views an
  // operator built at their desk — each with its own filters, sort and starred
  // assets — are here too. The phone keeps its OWN pick of which tab is showing
  // (localStorage): choosing one here never moves the desktop's active tab.
  // Its filter field, type chips and Sort & filter sheet narrow ON TOP of the
  // tab, overriding the tab's value for the same field (applyViewState →
  // loadPage). A star toggled here writes that tab's favoriteIds back, the same
  // whole-layout PUT the desktop makes.
  var VIEW_KEY = "polaris-mobile-assets-view";
  var TABS_SCOPE = "assets";
  // tableTabsService MAX_TAB_FAVORITES — the server refuses a layout over it.
  var MAX_FAVORITES = 500;
  // The desktop's text-filter columns (assets.js _buildAssetsQuery).
  var VIEW_TEXT_COLS = ["hostname", "ipAddress", "serialNumber", "assetTag", "manufacturer",
    "model", "os", "macAddress", "assignedTo", "purchaseOrder", "dnsName", "description", "tags"];

  var _state = {
    filterKey: "all",
    search: "",      // filter-field text; not persisted (see list-controls.js)
    views: null,     // the desktop tab layout { tabs, activeId }, or null when there is none
    viewId: "",      // the tab this phone is showing
    prefs: null,
    assets: [],      // accumulated rows
    total: 0,
    offset: 0,
    loading: false,
    // Monotonic sequence — incremented on every loadPage() call and checked
    // when the response arrives. Lets us drop stale results after a filter
    // change without needing AbortController support in api.js.
    seq: 0,
  };

  var Assets = {
    title: "Assets",
    icon: "#i-list",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Assets</div>'
        + '  <div class="trailing"></div>'
        + '</div>';
    },
    render: function (body) {
      var p = prefs();
      // The view tabs, filter/sort row and type chips are one pinned block
      // (.list-sticky-head) so they stay in reach while the cards scroll.
      body.innerHTML = ''
        + '<div class="list-sticky-head">'
        + '<div class="view-tabs" id="assets-views" role="tablist" aria-label="Asset views"' + (_state.views ? '' : ' hidden') + '>' + viewTabsHTML() + '</div>'
        + PolarisListControls.toolbarHTML({
            id: "assets",
            placeholder: "Filter assets",
            value: _state.search,
            sortLabel: sortLabel(),
            dir: sortDirShown(),
            active: p.monitor.length > 0,
          })
        + '<div class="chip-row" id="assets-chips"></div>'
        + '</div>'
        + '<div id="assets-list-host"></div>';

      PolarisListControls.wireToolbar("assets", {
        debounceMs: 350,
        onFilter: function (text) {
          if (text === _state.search) return;
          _state.search = text;
          reload();
        },
        onSort: openSortSheet,
      });

      renderChips();
      wireViewTabs();
      // Reset list state on every fresh render — operators expect tapping
      // the Assets tab to give them a clean view, not the leftover scroll
      // from yesterday.
      _state.assets = [];
      _state.offset = 0;
      _state.total = 0;
      return loadViewsThenPage();
    },
    onPullToRefresh: function () {
      // Reset paging + re-fetch the tabs (they may have changed at the desk)
      // and the first page under the current filter.
      _state.assets = [];
      _state.offset = 0;
      _state.total = 0;
      return loadViewsThenPage();
    },
  };

  // The tab layout decides the query, so it is read before the first page.
  // Re-read on every render: a tab added, renamed or re-filtered on the desktop
  // shows the next time the operator opens the list.
  function loadViewsThenPage() {
    if (!(window.api && api.tableTabs && typeof api.tableTabs.get === "function")) return loadPage(true);
    _state.loading = true;
    renderList();
    return api.tableTabs.get(TABS_SCOPE).then(function (layout) {
      setViews(layout);
    }, function () {
      // Offline or refused — the plain list is still the right answer.
    }).then(function () {
      renderViewTabs();
      return loadPage(true);
    });
  }

  function setViews(layout) {
    _state.views = (layout && Array.isArray(layout.tabs) && layout.tabs.length) ? layout : null;
    if (!_state.views) { _state.viewId = ""; return; }
    var tabs = _state.views.tabs;
    var has = function (id) { return !!id && tabs.some(function (t) { return t.id === id; }); };
    var want = _state.viewId || lsGet(VIEW_KEY);
    _state.viewId = has(want) ? want : (has(_state.views.activeId) ? _state.views.activeId : tabs[0].id);
  }

  function activeView() {
    if (!_state.views) return null;
    for (var i = 0; i < _state.views.tabs.length; i++) {
      if (_state.views.tabs[i].id === _state.viewId) return _state.views.tabs[i];
    }
    return null;
  }

  function viewFavorites() {
    var t = activeView();
    return (t && Array.isArray(t.favoriteIds)) ? t.favoriteIds : [];
  }

  function lsGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function lsSet(key, v) { try { localStorage.setItem(key, v); } catch (_) { /* private mode */ } }

  function viewTabsHTML() {
    if (!_state.views) return "";
    return _state.views.tabs.map(function (t) {
      var on = t.id === _state.viewId;
      var favs = Array.isArray(t.favoriteIds) ? t.favoriteIds.length : 0;
      return ''
        + '<button type="button" class="view-tab' + (on ? ' on' : '') + '" role="tab" aria-selected="' + on + '" data-view="' + escapeHtml(t.id) + '">'
        + escapeHtml(t.name || "Tab")
        + (favs ? '<span class="view-tab-favs" title="' + favs + (favs === 1 ? ' favorite' : ' favorites') + '"><svg viewBox="0 0 24 24"><use href="#i-star"/></svg>' + favs + '</span>' : '')
        + '</button>';
    }).join("");
  }

  function renderViewTabs() {
    var strip = document.getElementById("assets-views");
    if (!strip) return;
    strip.hidden = !_state.views;
    strip.innerHTML = viewTabsHTML();
    var on = strip.querySelector(".view-tab.on");
    if (on && on.scrollIntoView) { try { on.scrollIntoView({ block: "nearest", inline: "nearest" }); } catch (_) {} }
    PolarisListControls.updateSortChip("assets", sortLabel(), sortDirShown(), prefs().monitor.length > 0);
    // The reset chip follows the tab showing (and its state after a reset).
    renderChips();
  }

  function wireViewTabs() {
    var strip = document.getElementById("assets-views");
    if (!strip) return;
    strip.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest(".view-tab") : null;
      if (!btn) return;
      var id = btn.getAttribute("data-view");
      if (!id || id === _state.viewId) return;
      _state.viewId = id;
      lsSet(VIEW_KEY, id);
      renderViewTabs();
      reload();
    });
  }

  /**
   * One desktop tab's filter state onto the list route's query params.
   * MIRRORS the filter half of _buildAssetsQuery + _pushAssetText in
   * public/js/assets.js (the phone does not load that file);
   * tests/unit/mobileAssetViews.test.ts runs both over the same states and
   * fails when they disagree.
   */
  function applyViewState(params, state) {
    var filters = (state && state.sfFilters) || {};
    if (Array.isArray(filters.status) && filters.status.length) params.status = filters.status.join(",");
    if (Array.isArray(filters.assetType) && filters.assetType.length) params.assetType = filters.assetType.join(",");
    if (Array.isArray(filters._monitor) && filters._monitor.length) params.monitor = filters._monitor.join(",");
    VIEW_TEXT_COLS.forEach(function (key) { pushViewText(params, key, filters[key]); });
    pushViewText(params, "server", filters._server);
    if (filters.lastSeen && filters.lastSeen.type === "date") {
      if (filters.lastSeen.from) params.lastSeenFrom = filters.lastSeen.from;
      if (filters.lastSeen.to)   params.lastSeenTo = filters.lastSeen.to;
    }
    return params;
  }

  function pushViewText(params, paramKey, raw) {
    if (raw == null) return;
    if (typeof raw === "string") {
      var v = raw.trim();
      if (!v) return;
      if (v.charAt(0) === "!") {
        var rest = v.slice(1).trim();
        if (!rest) return;
        params[paramKey] = rest;
        params[paramKey + "Op"] = "not_contains";
      } else {
        params[paramKey] = v;
      }
    } else if (typeof raw === "object") {
      if (raw.op === "empty") {
        params[paramKey + "Op"] = "empty";
      } else if (raw.op === "notempty") {
        params[paramKey + "Op"] = "is_not_empty";
      } else if (raw.op === "not-contains") {
        var q = (raw.q || "").trim();
        if (!q) return;
        params[paramKey] = q;
        params[paramKey + "Op"] = "not_contains";
      } else if (raw.op === "in-networks") {
        var terms = (raw.terms || []).map(function (t) { return String(t).trim(); }).filter(Boolean);
        if (!terms.length) return;
        params[paramKey] = terms.join(",");
        params[paramKey + "Op"] = "in_networks";
      }
    }
  }

  // ─── Favorites ──────────────────────────────────────────────────────────
  // A star belongs to the TAB showing, as on the desktop. Painted optimistic;
  // the write re-reads the layout first so a tab edited at the desk since this
  // list loaded is not overwritten with the copy held here.
  function isFavorite(id) { return viewFavorites().indexOf(id) >= 0; }

  function favStarHTML(a) {
    if (!activeView()) return "";
    var on = isFavorite(a.id);
    return '<button type="button" class="fav-star-m' + (on ? ' on' : '') + '" aria-pressed="' + on + '"'
      + ' aria-label="' + (on ? 'Unfavorite' : 'Favorite') + '" data-fav="' + escapeHtml(a.id) + '">'
      + '<svg viewBox="0 0 24 24"><use href="#i-star"/></svg></button>';
  }

  function paintStars(assetId) {
    var on = isFavorite(assetId);
    document.querySelectorAll(".fav-star-m").forEach(function (b) {
      if (b.getAttribute("data-fav") !== assetId) return;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", on ? "Unfavorite" : "Favorite");
    });
  }

  function toggleFavorite(assetId) {
    var view = activeView();
    if (!view || !api.tableTabs || typeof api.tableTabs.save !== "function") return Promise.resolve();
    var viewId = view.id;
    var viewName = view.name || "this tab";
    var wasOn = isFavorite(assetId);
    if (!wasOn && viewFavorites().length >= MAX_FAVORITES) {
      PolarisTabs.showSnackbar("A tab holds at most " + MAX_FAVORITES + " favorites — unstar one first", { error: true });
      return Promise.resolve();
    }
    // Optimistic: flip the local copy and the star now.
    var local = viewFavorites().slice();
    if (wasOn) local.splice(local.indexOf(assetId), 1); else local.push(assetId);
    view.favoriteIds = local;
    paintStars(assetId);
    renderViewTabs();

    return api.tableTabs.get(TABS_SCOPE).then(function (layout) {
      var tabs = layout && Array.isArray(layout.tabs) ? layout.tabs : [];
      var tab = null;
      tabs.forEach(function (t) { if (t.id === viewId) tab = t; });
      if (!tab) throw new Error("“" + viewName + "” was closed on another device");
      var ids = Array.isArray(tab.favoriteIds) ? tab.favoriteIds.slice() : [];
      var at = ids.indexOf(assetId);
      if (wasOn) { if (at >= 0) ids.splice(at, 1); }
      else if (at < 0) ids.push(assetId);
      if (ids.length > MAX_FAVORITES) throw new Error("A tab holds at most " + MAX_FAVORITES + " favorites");
      tab.favoriteIds = ids;
      return api.tableTabs.save(TABS_SCOPE, { tabs: tabs, activeId: layout.activeId });
    }).then(function (saved) {
      setViews(saved && Array.isArray(saved.tabs) ? saved : _state.views);
      paintStars(assetId);
      renderViewTabs();
      PolarisTabs.showSnackbar((wasOn ? "Removed from favorites in " : "Added to favorites in ") + viewName);
    }).catch(function (err) {
      // Put the star back the way the server still has it.
      var back = viewFavorites().slice();
      var i = back.indexOf(assetId);
      if (wasOn && i < 0) back.push(assetId);
      if (!wasOn && i >= 0) back.splice(i, 1);
      var v = activeView();
      if (v) v.favoriteIds = back;
      paintStars(assetId);
      renderViewTabs();
      PolarisTabs.showSnackbar((err && err.message) || "Couldn’t save the favorite", { error: true });
    });
  }

  function prefs() {
    if (!_state.prefs) _state.prefs = PolarisListControls.loadPrefs(PREFS_KEY, DEFAULTS);
    var p = _state.prefs;
    if (!SORTS.some(function (s) { return s.key === p.sortKey; })) p.sortKey = DEFAULTS.sortKey;
    if (p.sortDir !== "asc" && p.sortDir !== "desc") p.sortDir = DEFAULTS.sortDir;
    // A saved pick can outlive the option it named (or predate the array
    // shape — the filter was a single string until 2026-09-24); keep only
    // values the sheet still offers, in the order they were picked.
    var raw = Array.isArray(p.monitor) ? p.monitor : (typeof p.monitor === "string" && p.monitor ? [p.monitor] : []);
    p.monitor = raw.filter(function (v, i) {
      return v && raw.indexOf(v) === i && MONITOR_FILTER.options.some(function (o) { return o.value === v; });
    });
    return p;
  }

  // The tab's own sort, when the sheet has not picked one ("Recently added" is
  // "no override" while a tab is showing). Null when neither sorts.
  function viewSort() {
    var t = activeView();
    var st = t && t.state;
    if (!st || !st.sortKey) return null;
    return { key: st.sortKey, dir: st.sortDir === "asc" ? "asc" : "desc" };
  }

  function sortDirShown() {
    var p = prefs();
    if (p.sortKey) return p.sortDir;
    var vs = viewSort();
    return vs ? vs.dir : p.sortDir;
  }

  function sortLabel() {
    var p = prefs();
    var s = SORTS.find(function (x) { return x.key === p.sortKey; });
    var label = s ? s.label : "Sort";
    // No sheet sort while the tab sorts: name what is actually ordering the
    // list — the sheet's label when it knows the column, the tab otherwise.
    var vs = !p.sortKey ? viewSort() : null;
    if (vs) {
      var vsMatch = SORTS.find(function (x) { return x.key === vs.key; });
      label = vsMatch ? vsMatch.label : "Tab’s sort";
    }
    // The status filter lives in the sheet, so the chip names it — a list
    // narrowed by something the operator can't see reads as missing assets.
    // One pick is named; two are both named; more are counted, since the
    // chip shares a row with the filter field.
    var picked = p.monitor.map(function (v) {
      var m = MONITOR_FILTER.options.find(function (o) { return o.value === v; });
      return m ? m.label : v;
    });
    if (picked.length === 1 || picked.length === 2) label += " · " + picked.join(", ");
    else if (picked.length > 2) label += " · " + picked.length + " statuses";
    return label;
  }

  // Reset paging and re-fetch the first page under the current filters.
  function reload() {
    _state.assets = [];
    _state.offset = 0;
    _state.total = 0;
    return loadPage(true);
  }

  function openSortSheet() {
    var p = prefs();
    PolarisListControls.openSortSheet({
      sortOptions: SORTS,
      sortKey: p.sortKey,
      sortDir: p.sortDir,
      filters: [Object.assign({ value: p.monitor.slice() }, MONITOR_FILTER)],
      onApply: function (choice) {
        var monitor = Array.isArray(choice.filters.monitor) ? choice.filters.monitor : [];
        var changed = choice.sortKey !== p.sortKey || choice.sortDir !== p.sortDir
          || monitor.join(",") !== p.monitor.join(",");
        if (!changed) return;
        p.sortKey = choice.sortKey;
        p.sortDir = choice.sortDir;
        p.monitor = monitor;
        PolarisListControls.savePrefs(PREFS_KEY, p);
        PolarisListControls.updateSortChip("assets", sortLabel(), sortDirShown(), p.monitor.length > 0);
        reload();
      },
    });
  }

  // ─── Reset the tab's filter ─────────────────────────────────────────────
  // A filter built at the desk rides the tab onto the phone (applyViewState),
  // and none of the phone's own controls can remove it — they only narrow on
  // top. This chip does what the desktop's Clear Filters / Reset Filter button
  // does (assets.js _renderAssetsPageControls): back to the tab's BASE filter
  // when it pins one (assets-tabs.js resetToDefault), otherwise every column
  // filter cleared with the sort kept. It writes the tab, so the desk sees the
  // reset too — the same re-read-then-save as a favorite.
  function emptyFilterState(st) {
    return { sfFilters: {}, sortKey: (st && st.sortKey) || null, sortDir: (st && st.sortDir) || null };
  }

  function cloneFilterState(st) {
    return {
      sfFilters: JSON.parse(JSON.stringify((st && st.sfFilters) || {})),
      sortKey: (st && st.sortKey) || null,
      sortDir: (st && st.sortDir) || null,
    };
  }

  // The state a reset would put the tab in, or null when it is already there.
  function viewResetTarget(tab) {
    if (!tab) return null;
    var cur = cloneFilterState(tab.state);
    var target = tab.defaultState ? cloneFilterState(tab.defaultState) : emptyFilterState(cur);
    return JSON.stringify(cur) === JSON.stringify(target) ? null : target;
  }

  function resetChipHTML() {
    var tab = activeView();
    if (!viewResetTarget(tab)) return "";
    var label = tab.defaultState ? "Reset filter" : "Clear filters";
    var title = tab.defaultState
      ? "Back to this tab’s base filter “" + (tab.defaultFilterName || "base") + "”"
      : "Clear every column filter this tab carries from the desktop";
    return '<button class="chip chip-reset" id="assets-reset-filter" title="' + escapeHtml(title) + '">'
      + '<svg viewBox="0 0 24 24"><use href="#i-close"/></svg>' + label + '</button>';
  }

  function resetViewFilter() {
    var view = activeView();
    if (!view || !viewResetTarget(view) || !api.tableTabs || typeof api.tableTabs.save !== "function") return Promise.resolve();
    var viewId = view.id;
    var viewName = view.name || "this tab";
    var wasBase = !!view.defaultState;
    return api.tableTabs.get(TABS_SCOPE).then(function (layout) {
      var tabs = layout && Array.isArray(layout.tabs) ? layout.tabs : [];
      var tab = null;
      tabs.forEach(function (t) { if (t.id === viewId) tab = t; });
      if (!tab) throw new Error("“" + viewName + "” was closed on another device");
      var target = viewResetTarget(tab);
      if (!target) return layout; // already reset at the desk since this list loaded
      tab.state = target;
      return api.tableTabs.save(TABS_SCOPE, { tabs: tabs, activeId: layout.activeId });
    }).then(function (saved) {
      setViews(saved && Array.isArray(saved.tabs) ? saved : _state.views);
      renderViewTabs();
      reload();
      PolarisTabs.showSnackbar((wasBase ? "Reset to the base filter in " : "Cleared the filters in ") + viewName);
    }).catch(function (err) {
      renderChips();
      PolarisTabs.showSnackbar((err && err.message) || "Couldn’t reset the filter", { error: true });
    });
  }

  function renderChips() {
    var row = document.getElementById("assets-chips");
    if (!row) return;
    row.innerHTML = resetChipHTML() + FILTERS.map(function (f) {
      var sel = f.key === _state.filterKey;
      return ''
        + '<button class="chip ' + (sel ? "selected" : "") + '" data-key="' + f.key + '">'
        + (sel ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '')
        + escapeHtml(f.label)
        + '</button>';
    }).join("");
    var reset = document.getElementById("assets-reset-filter");
    if (reset) reset.addEventListener("click", function () {
      reset.disabled = true;
      resetViewFilter();
    });
    row.querySelectorAll(".chip[data-key]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.key;
        if (key === _state.filterKey) return;
        _state.filterKey = key;
        _state.assets = [];
        _state.offset = 0;
        _state.total = 0;
        renderChips();
        loadPage(true);
      });
    });
  }

  function loadPage(replace) {
    var filter = FILTERS.find(function (f) { return f.key === _state.filterKey; }) || FILTERS[0];
    _state.seq++;
    var thisSeq = _state.seq;
    _state.loading = true;
    // Paint the pending state. On a Load more that is just the button going
    // to its spinner, so refresh that node rather than re-rendering every
    // card already on screen (this call was the second full rebuild per tap).
    if (replace || !refreshFooter()) renderList();

    var params = { limit: PAGE_SIZE, offset: _state.offset };
    // The desktop tab first; the phone's own controls then override the field
    // they speak to (a type chip replaces the tab's Type filter, a status pick
    // its Status filter, a sheet sort its sort).
    var view = activeView();
    if (view) applyViewState(params, view.state);
    if (filter.type) params.assetType = filter.type;
    var p = prefs();
    if (_state.search) params.search = _state.search;
    if (p.monitor.length) params.monitor = p.monitor.join(",");
    var vs = viewSort();
    if (p.sortKey) { params.sortBy = p.sortKey; params.sortDir = p.sortDir; }
    else if (vs) { params.sortBy = vs.key; params.sortDir = vs.dir; }
    // The tab's starred assets float to the top of the whole result set.
    var favs = viewFavorites();
    if (favs.length) params.favoriteIds = favs.join(",");

    return api.assets.list(params).then(function (resp) {
      if (thisSeq !== _state.seq) return; // superseded by a later filter change
      _state.loading = false;
      if (!resp) return;
      var fresh = Array.isArray(resp.assets) ? resp.assets : [];
      _state.total = resp.total || fresh.length;
      _state.assets = replace ? fresh : _state.assets.concat(fresh);
      _state.offset = (replace ? 0 : _state.offset) + fresh.length;
      // Append the new page's cards when we can; fall back to a full render
      // for a filter change, the first page, or an empty tail (where the
      // footer swaps from button to count).
      if (replace || fresh.length === 0 || !appendCards(fresh)) renderList();
    }).catch(function (err) {
      if (thisSeq !== _state.seq) return;
      _state.loading = false;
      renderError(err && err.message ? err.message : "Failed to load assets");
    });
  }

  function renderList() {
    var host = document.getElementById("assets-list-host");
    if (!host) return;

    if (_state.assets.length === 0 && _state.loading) {
      host.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
      return;
    }
    if (_state.assets.length === 0 && !_state.loading) {
      host.innerHTML = ''
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-list"/></svg></div>'
        + '  <div class="ttl">No assets</div>'
        + '  <div class="desc">' + (_state.search || prefs().monitor.length
          ? 'Nothing matches this filter. Clear it, or pick “Any” status in Sort &amp; filter.'
          : activeView()
          ? 'Nothing in “' + escapeHtml(activeView().name || "this tab") + '” matches. Try “All”, '
            + (viewResetTarget(activeView()) ? (activeView().defaultState ? '“Reset filter”' : '“Clear filters”') + ', ' : '')
            + 'or another tab.'
          : 'Nothing matches this filter. Try “All” or run a discovery to populate the inventory.') + '</div>'
        + '</div>';
      return;
    }

    var html = '<div class="asset-list">';
    _state.assets.forEach(function (a) {
      html += renderAssetCard(a);
    });
    html += '</div><div id="assets-list-footer">' + footerHTML() + '</div>';

    host.innerHTML = html;
    wireListHost(host);
  }

  // The Load-more button, or the final count once everything is in. Its own
  // node so an append can refresh it without touching the cards.
  function footerHTML() {
    if (_state.assets.length < _state.total) {
      return ''
        + '<div style="display:flex;justify-content:center;padding:8px 16px 24px;">'
        + '  <button class="btn btn-tonal" id="assets-load-more"' + (_state.loading ? ' disabled' : '') + '>'
        + '    ' + (_state.loading
          ? '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span> Loading…'
          : 'Load more (' + (_state.total - _state.assets.length) + ' remaining)')
        + '  </button>'
        + '</div>';
    }
    return '<div style="text-align:center;padding:16px 16px 24px;color:var(--md-on-surface-variant);font-size:12px;letter-spacing:.5px;">' + _state.assets.length + ' asset' + (_state.assets.length === 1 ? "" : "s") + '</div>';
  }

  function refreshFooter() {
    var f = document.getElementById("assets-list-footer");
    if (!f) return false;
    f.innerHTML = footerHTML();
    return true;
  }

  // ONE delegated listener on the host instead of one per card, attached once.
  // Walking a 2000-asset fleet is 40 taps of Load more, and the old shape
  // re-attached a listener to every ACCUMULATED card on each one — tens of
  // thousands of attachments on a phone, on top of rebuilding every card.
  function wireListHost(host) {
    if (host.dataset.listWired === "1") return;
    host.dataset.listWired = "1";
    host.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var more = t.closest("#assets-load-more");
      if (more) {
        if (!more.disabled) loadPage(false);
        return;
      }
      // The star lives inside the card too, so it is checked before the card.
      var star = t.closest(".fav-star-m");
      if (star) {
        toggleFavorite(star.getAttribute("data-fav"));
        return;
      }
      // The alert flag is checked BEFORE the card: it lives inside the card,
      // so a tap on it matches both and the more specific one has to win, or
      // "show me what is wrong with this device" would open the device.
      var flag = t.closest(".alert-flag");
      if (flag) {
        var fcard = flag.closest(".asset-card");
        if (fcard) openAlertsFor(fcard.dataset.id);
        return;
      }
      var card = t.closest(".asset-card");
      if (!card) return;
      var id = card.dataset.id;
      if (!id) return;
      if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(id);
      else PolarisRouter.go("asset/" + id);
    });
    // The card stopped being a <button> when the alert flag (a real button)
    // moved inside it, so Enter/Space activation is supplied here. A key
    // pressed on the flag itself is left alone — it is still a button and
    // fires its own click, which the listener above already handles.
    host.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      var t = ev.target;
      if (!t || !t.closest) return;
      if (!t.classList || !t.classList.contains("asset-card")) return;
      ev.preventDefault();
      t.click();
    });
  }

  // Append-only render for a Load more: the page's cards go on the end of the
  // existing list. Rebuilding the whole accumulated set per tap made the walk
  // to 2000 assets quadratic in DOM work (~82k card renders across 40 taps),
  // and the last tap alone destroyed and rebuilt 2000 cards.
  function appendCards(fresh) {
    var host = document.getElementById("assets-list-host");
    if (!host) return false;
    var list = host.querySelector(".asset-list");
    if (!list) return false;
    var holder = document.createElement("div");
    holder.innerHTML = fresh.map(renderAssetCard).join("");
    while (holder.firstChild) list.appendChild(holder.firstChild);
    refreshFooter();
    wireListHost(host);
    return true;
  }

  function renderError(msg) {
    var host = document.getElementById("assets-list-host");
    if (!host) return;
    host.innerHTML = ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Couldn’t load assets</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  function renderAssetCard(a) {
    var meta = TYPE_META[a.assetType] || TYPE_META.other;
    var dotCls = monitorDotCls(a);
    var bits = [];
    if (a.ipAddress) bits.push('<span class="mono">' + escapeHtml(a.ipAddress) + '</span>');
    var modelLine = [a.manufacturer, a.model].filter(Boolean).join(" ");
    if (modelLine) bits.push(escapeHtml(modelLine));
    if (a.location || a.learnedLocation) bits.push(escapeHtml(a.location || a.learnedLocation));
    if (!bits.length) bits.push(escapeHtml(a.assetType || "asset"));

    // A DIV, not a BUTTON, since the alert flag inside it is itself a button
    // and a nested <button> swallows the tap that opens the device (the same
    // trap the More tab's alert rows hit). Role + tabindex keep the keyboard
    // affordance the element used to carry for free; the host's keydown
    // handler supplies the Enter/Space activation a real button gave.
    return ''
      + '<div class="asset-card" role="button" tabindex="0" data-id="' + escapeHtml(a.id) + '">'
      + '  <div class="top">'
      + '    <div class="ico ' + meta.cls + '"><svg viewBox="0 0 24 24"><use href="' + meta.icon + '"/></svg></div>'
      + '    <div class="name">' + escapeHtml(a.hostname || a.assetTag || "(unnamed)") + '</div>'
      + alertFlagHTML(a)
      + favStarHTML(a)
      + (dotCls ? '    <span class="dot ' + dotCls + '" title="' + escapeHtml(monitorTitle(a)) + '"></span>' : '')
      + '  </div>'
      + '  <div class="meta">' + bits.join('<span class="muted">·</span>') + '</div>'
      + '</div>';
  }

  // ─── Active-alert flag ──────────────────────────────────────────────────
  // "Alerts" beside the hostname, strobing in the colour of the worst live
  // alert on the device — the phone's counterpart to the desktop list's dot
  // and the asset slide-over's strobing Alerts tab. The summary rides the
  // list payload already (`activeAlert`, one query per PAGE — see
  // activeAlertSummaryByAsset), so the flag costs no extra request; the
  // markup and the severity colour come from PolarisMobileAlerts so the flag
  // and the sheet it opens can't disagree about how bad this device is.
  function alertFlagHTML(a) {
    if (!window.PolarisMobileAlerts) return "";
    return PolarisMobileAlerts.flagHTML(a && a.activeAlert);
  }

  /**
   * Repaint one card's flag from a summary the sheet just recomputed, so an
   * acknowledge or a clear settles the list behind it without a re-fetch. The
   * accumulated row is updated too — a Load more re-renders from `_state`, and
   * a card rebuilt from a stale row would start strobing again.
   */
  function paintAlertFlag(assetId, summary) {
    var row = _state.assets.find(function (x) { return x.id === assetId; });
    if (row) row.activeAlert = summary || null;
    var card = null;
    document.querySelectorAll(".asset-card").forEach(function (c) {
      if (c.dataset.id === assetId) card = c;
    });
    if (!card) return;
    var top = card.querySelector(".top");
    if (!top) return;
    var existing = top.querySelector(".alert-flag");
    var html = window.PolarisMobileAlerts ? PolarisMobileAlerts.flagHTML(summary) : "";
    if (!html) { if (existing) existing.remove(); return; }
    var holder = document.createElement("div");
    holder.innerHTML = html;
    var flag = holder.firstChild;
    if (existing) top.replaceChild(flag, existing);
    else top.insertBefore(flag, top.querySelector(".fav-star-m") || top.querySelector(".dot"));   // before the star / status dot, or last
  }

  function openAlertsFor(assetId) {
    if (!assetId || !window.PolarisMobileAlerts) return;
    var row = _state.assets.find(function (x) { return x.id === assetId; });
    PolarisMobileAlerts.openForAsset(assetId, {
      hostname: (row && (row.hostname || row.assetTag)) || "",
      onSummary: function (summary) { paintAlertFlag(assetId, summary); },
    });
  }

  function monitorDotCls(a) {
    if (!a.monitored) return "";
    // Maintenance outranks everything — polling is paused, the probe state is
    // frozen. Matches desktop assetMonitorBadge and the asset sheet.
    if (a.status === "maintenance") return "maint";
    // Suppression outranks the probe state — matches desktop assetMonitorBadge.
    if (a.dependencySuppressed) return "dep-down";
    switch (a.monitorStatus) {
      case "up":      return "up";
      case "down":    return "down";
      case "warning": return "warn";
      case "recovering": return "recovering";
      case "unknown": return "unk";
      // No down-detection automation covers it — still polled, no verdict.
      case "passive": return "passive";
      default:        return "unk";
    }
  }
  function monitorTitle(a) {
    if (!a.monitored) return "Unmonitored";
    if (a.status === "maintenance")    return "Maintenance — monitoring and notifications paused";
    if (a.dependencySuppressed)        return "Dep. Down — upstream parent is down";
    if (a.monitorStatus === "up")      return "Up — last RTT " + (a.lastResponseTimeMs != null ? a.lastResponseTimeMs + " ms" : "n/a");
    if (a.monitorStatus === "down")    return "Down";
    // "Missed", not "Warning" — the alert severities own that word (api.js
    // POLARIS_MONITOR_STATUS_LABELS). No count here: the list payload does not
    // select consecutiveFailures, and "0 missed polls" would contradict the pill.
    if (a.monitorStatus === "warning") return "Missed — a poll failed, below the down threshold";
    if (a.monitorStatus === "recovering") return "Recovering — answering again, not yet Up";
    if (a.monitorStatus === "unknown") return "No samples yet";
    if (a.monitorStatus === "passive") return "Passive — no down-detection automation covers this device";
    return "Monitored";
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  window.PolarisAssetsTab = {
    spec: Assets,
    // For tests/unit/mobileAssetViews.test.ts — the desktop-parity mirror.
    _applyViewState: applyViewState,
  };
})();
