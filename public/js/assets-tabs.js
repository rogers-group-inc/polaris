/**
 * public/js/assets-tabs.js — per-user view tabs for the Assets table.
 *
 * A tab is one open VIEW: a name plus the table's filter + sort state. Tabs are
 * this operator's workspace — private, server-persisted per user
 * (GET/PUT /api/v1/me/table-tabs?scope=assets, the /me/dashboard sibling), so
 * they follow them across browsers but are never shared. The durable, shareable
 * artifact is a saved filter preset (assets-filters.js); a tab opened from one
 * keeps a REFERENCE for its label, and editing the tab never writes back — the
 * preset may belong to someone else.
 *
 * A tab may also pin one preset as its BASE filter (Filters ▾ → ★): the view
 * the tab returns to. That's what makes narrowing INSIDE a saved filter
 * survivable — the operator filters further on top of the base and gets back
 * with one click, and while a base is set the page-controls row says "Reset
 * Filter" instead of "Clear Filters" (the label is assets.js's, read from
 * activeDefault()). `defaultState` is a SNAPSHOT and is what Reset applies, so
 * a preset that is deleted — or was someone else's private one — can never take
 * a tab's base away; refreshDefaultsFromPresets() re-syncs the snapshot from the
 * live preset every time the Filters menu lists them, which is how an edit to
 * the preset reaches the tabs based on it.
 *
 * The COLUMN ORDER is the tab's too. Order is part of a view in a way widths
 * and visibility are not — the operator arranges the columns each view is
 * ABOUT, so a firewall tab can lead with the FortiGate columns while an
 * addressing tab leads with the IPs — so it rides the tab onto the server,
 * while column widths / hidden columns stay per-browser in localStorage (that
 * is a property of the screen, not of the view). setupColumnLayout stores a
 * permutation of the MOVABLE column ids, which is exactly what is saved here;
 * `columnOrder: null` on a tab written before the feature adopts this browser's
 * stored layout once, the same one-shot rule favorites use.
 *
 * Favorites are the tab's too: the module registers a favorites.js PROVIDER for
 * the "assets" entity, so the stars assets.js renders — and the `?favoriteIds=`
 * it sends to float them to the top of the whole result set — come from the tab
 * the operator is on. Blocks / subnets favorites are untouched and still live in
 * localStorage; the Assets set moved onto the tab because a favorite is part of
 * a view, and a view is server-persisted and follows the operator between
 * browsers. A tab written before the feature carries `favoriteIds: null`, which
 * is the one moment it adopts this browser's old per-user set (every tab, since
 * that set is exactly what each tab used to show); once saved as an array, no
 * other browser re-seeds it.
 *
 * Contract with assets.js:
 *   init({hashSeeded})  — awaited before the first fetch so the page loads once
 *   syncFromTable()     — called from assetsApplyFilterState on every change
 *   syncColumnsFromTable() — called from the column layout's onChange
 *   activeDefault() / resetToDefault() — the Clear/Reset button's label + action
 * and with assets-filters.js:
 *   openInNewTab(preset) / noteFilterLoaded(preset) — the two load paths
 *   setDefaultFilter(preset) / clearDefaultFilter() / refreshDefaultsFromPresets()
 *
 * Re-entrancy: applying a tab's state calls assetsApplyFilterState, which calls
 * syncFromTable — guarded by _applying so a tab switch can't dirty the tab it
 * just left.
 *
 * Depends on globals from app.js (showToast/showConfirm/escapeHtml), api.js
 * (api), table-sf.js (TableSF.applyState/getPrefs and the setupColumnLayout
 * handle's getPrefs/setPrefs), favorites.js (registerFavoritesProvider/
 * getStoredFavorites) and assets.js (_assetsSF, _assetsLayout,
 * assetsApplyFilterState). Loaded by assets.html BEFORE assets.js so
 * window.PolarisAssetTabs exists when assets.js's DOMContentLoaded runs, and
 * AFTER favorites.js so the provider can be registered during init.
 */

/* global api, showToast, showConfirm, escapeHtml, _assetsSF, _assetsLayout,
          assetsApplyFilterState, registerFavoritesProvider, getStoredFavorites */

(function () {
  var SCOPE = "assets";
  var FAV_ENTITY = "assets";          // favorites.js entity this strip takes over
  // Mirrors tableTabsService.MAX_TAB_FAVORITES — the server rejects the whole
  // PUT past it, so the click is where the operator gets told.
  var MAX_FAVORITES = 500;
  var MAX_TABS = 20;
  var MAX_NAME = 40;
  var SAVE_DEBOUNCE_MS = 800;

  // [{ id, name, state, savedFilterId, savedFilterName,
  //    defaultFilterId, defaultFilterName, defaultState, favoriteIds }]
  var _tabs = [];
  var _activeId = "";
  var _applying = false;     // suppresses syncFromTable while we drive the table
  var _persisted = false;    // false until the server has a row for this user
  var _saveTimer = null;
  var _ready = false;

  function uid() {
    // Not security-sensitive — just needs to be unique within one user's strip.
    return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function activeTab() {
    for (var i = 0; i < _tabs.length; i++) if (_tabs[i].id === _activeId) return _tabs[i];
    return _tabs[0] || null;
  }

  function emptyState() {
    return { sfFilters: {}, sortKey: null, sortDir: null };
  }

  /** The live table state, in the shape the server stores. */
  function liveState() {
    if (!_assetsSF || typeof _assetsSF.getPrefs !== "function") return emptyState();
    var p = _assetsSF.getPrefs();
    return { sfFilters: p.sfFilters || {}, sortKey: p.sortKey || null, sortDir: p.sortDir || null };
  }

  /**
   * A detached copy of a filter state. A base snapshot must never alias the
   * live table state or the Filters menu's preset cache: TableSF.applyState
   * hands the filter objects it is given straight to the filter widgets, so a
   * shared reference would let the operator's next keystroke quietly edit the
   * thing they reset TO.
   */
  function cloneState(state) {
    if (!state || typeof state !== "object") return emptyState();
    return {
      sfFilters: JSON.parse(JSON.stringify(state.sfFilters || {})),
      sortKey: state.sortKey || null,
      sortDir: state.sortDir || null,
    };
  }

  function sameState(a, b) {
    return JSON.stringify(cloneState(a)) === JSON.stringify(cloneState(b));
  }

  function filterCount(state) {
    return Object.keys((state && state.sfFilters) || {}).length;
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  function scheduleSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }

  async function saveNow() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    try {
      await api.tableTabs.save(SCOPE, {
        tabs: _tabs.map(function (t) {
          return {
            id: t.id,
            name: t.name,
            state: t.state,
            savedFilterId: t.savedFilterId || null,
            savedFilterName: t.savedFilterName || null,
            defaultFilterId: t.defaultFilterId || null,
            defaultFilterName: t.defaultFilterName || null,
            defaultState: t.defaultState || null,
            // Array vs null is meaningful to the server (see the service): null
            // still means "may be seeded from the legacy per-user set".
            favoriteIds: Array.isArray(t.favoriteIds) ? t.favoriteIds : null,
            // Same contract for the column order — null means "may still be
            // seeded from this browser's stored table layout".
            columnOrder: Array.isArray(t.columnOrder) ? t.columnOrder : null,
          };
        }),
        activeId: _activeId,
      });
      _persisted = true;
    } catch (err) {
      // Non-fatal: the strip keeps working for this session. Surfacing it once
      // is better than silently losing the layout on the next login.
      showToast("Could not save your tabs — " + (err.message || "server error"), "error");
    }
  }

  // ─── Applying a tab to the table ──────────────────────────────────────────

  function applyActiveToTable() {
    var tab = activeTab();
    if (!tab || !_assetsSF || typeof _assetsSF.applyState !== "function") return;
    _applying = true;
    try {
      // Columns first: assetsApplyFilterState writes the layout back to
      // localStorage, so the order has to be this tab's before it runs.
      applyColumnOrderToTable(tab);
      _assetsSF.applyState(tab.state);
      assetsApplyFilterState();
    } finally {
      _applying = false;
    }
  }

  /**
   * Repaint the page-controls row, whose Clear/Reset button is labeled from the
   * active tab's base. assets.js only re-renders it after a fetch, so a base
   * change that leaves the query alone (setting one on the view already on
   * screen, clearing one) has to ask for the repaint itself.
   */
  function notifyBaseChanged() {
    if (typeof window._renderAssetsPageControls === "function") window._renderAssetsPageControls();
  }

  /** Drive the table to a state and let assets.js fetch + mirror it back. */
  function applyStateToTable(state) {
    if (!_assetsSF || typeof _assetsSF.applyState !== "function") return false;
    _assetsSF.applyState(cloneState(state));
    assetsApplyFilterState();
    return true;
  }

  // ─── Favorites (per tab) ──────────────────────────────────────────────────

  function favoriteIds(tab) {
    return (tab && Array.isArray(tab.favoriteIds)) ? tab.favoriteIds : [];
  }

  // ─── Column order (per tab) ───────────────────────────────────────────────

  /** The live table's movable-column order, or null when there is no table. */
  function liveColumnOrder() {
    if (!_assetsLayout || typeof _assetsLayout.getPrefs !== "function") return null;
    var order = _assetsLayout.getPrefs().order;
    return Array.isArray(order) ? order.slice() : null;
  }

  /**
   * Drive the table to a tab's column order. Only `order` is handed to
   * setPrefs — widths and hidden columns are per-browser and must survive a
   * tab switch untouched. A tab with no order of its own (null, or a strip
   * running without a column layout) leaves the table exactly as it is rather
   * than snapping back to the authored order: nothing has claimed otherwise.
   */
  function applyColumnOrderToTable(tab) {
    if (!tab || !Array.isArray(tab.columnOrder)) return;
    if (!_assetsLayout || typeof _assetsLayout.setPrefs !== "function") return;
    _assetsLayout.setPrefs({ order: tab.columnOrder.slice() });
  }

  /**
   * Fill in every tab that predates per-tab column order from this browser's
   * stored layout — the order the operator is looking at right now, which is
   * what every tab used to show. Same one-shot rule as seedLegacyFavorites:
   * once the tabs carry arrays no other browser can re-seed them.
   */
  function seedLegacyColumnOrder() {
    var pending = _tabs.filter(function (t) { return !Array.isArray(t.columnOrder); });
    if (!pending.length) return;
    var live = liveColumnOrder();
    if (!live) return;                                  // no column layout — nothing to seed from
    pending.forEach(function (t) { t.columnOrder = live.slice(); });
    if (_persisted) scheduleSave();
  }

  /** This browser's pre-provider per-user set, capped. Read once, at init. */
  function legacyFavorites() {
    if (typeof getStoredFavorites !== "function") return [];
    var set = getStoredFavorites(FAV_ENTITY);
    return set ? Array.from(set).slice(0, MAX_FAVORITES) : [];
  }

  /**
   * Fill in every tab that predates per-tab favorites from the legacy set. Runs
   * once per strip load and is a no-op the moment the tabs carry arrays, so the
   * first browser to open the page after the upgrade decides — a second one can
   * never re-seed a tab whose favorites the operator has since curated.
   */
  function seedLegacyFavorites() {
    var pending = _tabs.filter(function (t) { return !Array.isArray(t.favoriteIds); });
    if (!pending.length) return;
    var legacy = legacyFavorites();
    pending.forEach(function (t) { t.favoriteIds = legacy.slice(); });
    // Only worth a write for an operator who already has a server row; a first
    // visit stays write-free until they actually use tabs.
    if (_persisted) scheduleSave();
  }

  /**
   * Hand favorites.js the active tab as the store for the "assets" entity.
   * That's the whole integration: assets.js renders stars through starCellHTML
   * and builds `?favoriteIds=` through getFavorites, so both follow the tab
   * with no change on the page side.
   */
  function registerFavoritesBridge() {
    if (typeof registerFavoritesProvider !== "function") return;
    registerFavoritesProvider(FAV_ENTITY, {
      get: function () {
        return new Set(favoriteIds(activeTab()));
      },
      toggle: function (id) {
        var tab = activeTab();
        if (!tab || !id) return false;
        if (!Array.isArray(tab.favoriteIds)) tab.favoriteIds = [];
        var at = tab.favoriteIds.indexOf(id);
        if (at >= 0) {
          tab.favoriteIds.splice(at, 1);
        } else if (tab.favoriteIds.length >= MAX_FAVORITES) {
          // Refuse rather than drop the tail server-side, where it would look
          // like a star that didn't stick.
          showToast('"' + tab.name + '" already has ' + MAX_FAVORITES +
            " favorites — unstar one first", "error");
          return false;
        } else {
          tab.favoriteIds.push(id);
        }
        render();                                         // tooltip count
        scheduleSave();
        return tab.favoriteIds.indexOf(id) >= 0;
      },
      titleFor: function (_id, fav) {
        var tab = activeTab();
        // Named, because the next tab shows a different set — this is the only
        // surface that explains the scoping at the moment of the click.
        return (fav ? "Unfavorite" : "Favorite") +
          (tab ? ' in this view ("' + tab.name + '")' : " in this view");
      },
    });
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  function tabTitle(tab) {
    var n = filterCount(tab.state);
    var bits = [n ? (n + (n === 1 ? " filter" : " filters")) : "No filters"];
    var f = favoriteIds(tab).length;
    if (f) bits.push(f + (f === 1 ? " favorite" : " favorites"));
    if (tab.defaultState) {
      bits.push('resets to base filter "' + (tab.defaultFilterName || "base") + '"');
    } else if (tab.savedFilterName) {
      bits.push('from saved filter "' + tab.savedFilterName + '"');
    }
    bits.push("double-click to rename");
    return bits.join(" · ");
  }

  function render() {
    var list = document.getElementById("assets-tabs-list");
    if (!list) return;
    var closable = _tabs.length > 1;
    list.innerHTML = _tabs.map(function (t) {
      var active = t.id === _activeId;
      var dot = filterCount(t.state) ? '<span class="table-tab-dot" aria-hidden="true"></span>' : "";
      // The base marker does not replace the dot: "has filters" and "has a base
      // to get back to" are two different facts, and the operator acts on both.
      var base = t.defaultState
        ? '<span class="table-tab-base" title="Base filter: ' +
          escapeHtml(t.defaultFilterName || "saved filter") + '">&#9733;</span>'
        : "";
      return '<div class="table-tab' + (active ? " active" : "") + '" data-tab-id="' + escapeHtml(t.id) + '"' +
        ' role="tab" aria-selected="' + (active ? "true" : "false") + '" tabindex="0"' +
        ' title="' + escapeHtml(tabTitle(t)) + '">' +
          base + dot +
          '<span class="table-tab-name">' + escapeHtml(t.name) + "</span>" +
          (closable
            ? '<button type="button" class="table-tab-close" data-tab-close="' + escapeHtml(t.id) +
              '" title="Close tab" aria-label="Close ' + escapeHtml(t.name) + '">&times;</button>'
            : "") +
        "</div>";
    }).join("");
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  function selectTab(id) {
    if (id === _activeId) return;
    var found = _tabs.some(function (t) { return t.id === id; });
    if (!found) return;
    _activeId = id;
    render();
    applyActiveToTable();
    scheduleSave();
  }

  function addTab(opts) {
    opts = opts || {};
    if (_tabs.length >= MAX_TABS) {
      showToast("You can have at most " + MAX_TABS + " tabs — close one first", "error");
      return null;
    }
    var tab = {
      id: uid(),
      name: (opts.name || defaultTabName()).slice(0, MAX_NAME),
      state: opts.state ? cloneState(opts.state) : emptyState(),
      savedFilterId: opts.savedFilterId || null,
      savedFilterName: opts.savedFilterName || null,
      defaultFilterId: opts.defaultFilterId || null,
      defaultFilterName: opts.defaultFilterName || null,
      defaultState: opts.defaultState ? cloneState(opts.defaultState) : null,
      // A new view starts with no stars — that IS the per-tab promise. (Never
      // null: this tab has no legacy set to inherit.)
      favoriteIds: [],
      // Columns, unlike stars, are INHERITED from the view the operator is on:
      // a new tab that scrambled the arrangement they just built would read as
      // a bug, and they can still rearrange it here without touching the tab
      // they came from. Null only when the page has no column layout at all.
      columnOrder: liveColumnOrder(),
    };
    _tabs.push(tab);
    _activeId = tab.id;
    render();
    applyActiveToTable();
    scheduleSave();
    return tab;
  }

  function defaultTabName() {
    for (var n = _tabs.length + 1; ; n++) {
      var name = "Tab " + n;
      var taken = _tabs.some(function (t) { return t.name === name; });
      if (!taken) return name;
    }
  }

  async function closeTab(id) {
    if (_tabs.length <= 1) return;                       // never close the last one
    var idx = -1;
    for (var i = 0; i < _tabs.length; i++) if (_tabs[i].id === id) idx = i;
    if (idx < 0) return;
    var tab = _tabs[idx];
    // Only ask when there's hand-built work to lose: a tab backed by a saved
    // filter can be reopened from the Filters menu in one click, and a tab
    // sitting exactly on its own base has nothing on top of it to lose.
    var onBase = tab.defaultState && sameState(tab.state, tab.defaultState);
    var losesFilters = !!(filterCount(tab.state) && !tab.savedFilterId && !onBase);
    // Favorites live ONLY on this tab now, so closing it is the only way to
    // lose them — worth asking about even on a tab with no filters at all.
    var losesFavorites = favoriteIds(tab).length > 0;
    if (losesFilters || losesFavorites) {
      var lost = [];
      if (losesFilters) lost.push("Its filters are not saved");
      if (losesFavorites) lost.push("its favorites live only here");
      var ok = await showConfirm('Close "' + tab.name + '"? ' + lost.join(", and ") + ".");
      if (!ok) return;
    }
    _tabs.splice(idx, 1);
    if (_activeId === id) {
      _activeId = _tabs[Math.min(idx, _tabs.length - 1)].id;
      render();
      applyActiveToTable();
    } else {
      render();
    }
    scheduleSave();
  }

  /** Swap a tab's label for an input; Enter/blur commits, Escape reverts. */
  function beginRename(tabEl) {
    var id = tabEl.getAttribute("data-tab-id");
    var tab = null;
    _tabs.forEach(function (t) { if (t.id === id) tab = t; });
    if (!tab || tabEl.querySelector("input")) return;
    var nameEl = tabEl.querySelector(".table-tab-name");
    if (!nameEl) return;
    var input = document.createElement("input");
    input.type = "text";
    input.className = "table-tab-input";
    input.maxLength = MAX_NAME;
    input.value = tab.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();

    var done = false;
    function commit(save) {
      if (done) return;
      done = true;
      var next = (input.value || "").trim().replace(/\s+/g, " ").slice(0, MAX_NAME);
      if (save && next) {
        tab.name = next;
        // A renamed tab is the operator's own label now — drop the preset
        // reference from the LABEL story but keep the id so "not saved"
        // confirmations still know it came from somewhere.
        scheduleSave();
      }
      render();
    }
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", function () { commit(true); });
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  window.PolarisAssetTabs = {
    /**
     * Load the caller's tabs and apply the active one. Awaited by assets.js
     * before its first fetch. `hashSeeded` = a deep link already narrowed the
     * table, so keep that narrowing and fold it into the active tab instead of
     * replacing it.
     */
    init: async function (opts) {
      var strip = document.getElementById("assets-tabs");
      if (!strip) return;                                 // not the Assets page
      opts = opts || {};
      var layout = null;
      try {
        layout = await api.tableTabs.get(SCOPE);
      } catch (_) {
        layout = null;                                    // offline/denied — local-only strip
      }
      if (layout && Array.isArray(layout.tabs) && layout.tabs.length) {
        _tabs = layout.tabs.map(function (t) {
          return {
            id: String(t.id),
            name: String(t.name || "Tab"),
            state: (t.state && typeof t.state === "object") ? t.state : { sfFilters: {}, sortKey: null, sortDir: null },
            savedFilterId: t.savedFilterId || null,
            savedFilterName: t.savedFilterName || null,
            // Rows written before base filters existed carry none — an absent
            // default is simply a tab with nothing to reset to.
            defaultFilterId: t.defaultFilterId || null,
            defaultFilterName: t.defaultFilterName || null,
            defaultState: (t.defaultState && typeof t.defaultState === "object") ? t.defaultState : null,
            // null (not []) when absent — seedLegacyFavorites below reads that
            // as "may adopt this browser's old per-user stars".
            favoriteIds: Array.isArray(t.favoriteIds) ? t.favoriteIds.slice() : null,
            // Likewise: null here is what seedLegacyColumnOrder reads as "may
            // adopt this browser's stored column arrangement".
            columnOrder: Array.isArray(t.columnOrder) ? t.columnOrder.slice() : null,
          };
        });
        _activeId = layout.activeId || _tabs[0].id;
        _persisted = true;
      } else {
        // First visit: seed one tab from whatever the table is already showing
        // (the restored localStorage prefs), so nothing the operator had is lost.
        _tabs = [{
          id: uid(),
          name: "All assets",
          state: liveState(),
          savedFilterId: null,
          savedFilterName: null,
          defaultFilterId: null,
          defaultFilterName: null,
          defaultState: null,
          favoriteIds: legacyFavorites(),
          columnOrder: liveColumnOrder(),
        }];
        _activeId = _tabs[0].id;
        _persisted = false;                               // don't write until they use it
      }
      _ready = true;
      seedLegacyFavorites();
      seedLegacyColumnOrder();
      // Before the first render + before assets.js fetches: the star cells and
      // the ?favoriteIds= query both read through the provider.
      registerFavoritesBridge();
      render();
      wire(strip);

      // Columns are applied on BOTH paths: a deep link narrows the rows, it
      // says nothing about how the columns are arranged, so the tab still
      // decides that.
      _applying = true;
      try { applyColumnOrderToTable(activeTab()); } finally { _applying = false; }

      if (opts.hashSeeded) {
        // The deep link wins for this load; record it so the tab reflects what
        // is on screen (pre-tabs behavior overwrote the saved prefs the same way).
        var t = activeTab();
        if (t) { t.state = liveState(); if (_persisted) scheduleSave(); }
        render();
      } else {
        _applying = true;
        try {
          if (_assetsSF && typeof _assetsSF.applyState === "function") _assetsSF.applyState(activeTab().state);
        } finally {
          _applying = false;
        }
        // No assetsApplyFilterState here — assets.js fetches right after init,
        // and a second fetch would double-load the first page.
      }
    },

    /** Mirror the live table state into the active tab (assets.js hook). */
    syncFromTable: function () {
      if (!_ready || _applying) return;
      var tab = activeTab();
      if (!tab) return;
      var next = liveState();
      if (JSON.stringify(next) === JSON.stringify(tab.state)) return;
      tab.state = next;
      render();                                           // filter dot + tooltip
      scheduleSave();
    },

    /**
     * Mirror the live column order into the active tab (the column layout's
     * onChange hook in assets.js). Fires for width and visibility changes too
     * — those are per-browser, so a run that finds the order unchanged is
     * simply a no-op rather than a save.
     */
    syncColumnsFromTable: function () {
      if (!_ready || _applying) return;
      var tab = activeTab();
      if (!tab) return;
      var next = liveColumnOrder();
      if (!next) return;
      if (Array.isArray(tab.columnOrder) && next.join(",") === tab.columnOrder.join(",")) return;
      tab.columnOrder = next;
      scheduleSave();
    },

    /** Open a saved preset in a NEW tab (Filters ▾ → ⧉). */
    openInNewTab: function (preset) {
      if (!_ready || !preset) return false;
      return !!addTab({
        name: preset.name,
        state: preset.state,
        savedFilterId: preset.id,
        savedFilterName: preset.name,
      });
    },

    /** A preset was loaded into the CURRENT tab — record where it came from. */
    noteFilterLoaded: function (preset) {
      if (!_ready || !preset) return;
      var tab = activeTab();
      if (!tab) return;
      tab.savedFilterId = preset.id;
      tab.savedFilterName = preset.name;
      // Adopt the preset's name only while the tab is still unnamed scratch —
      // never clobber a name the operator typed.
      if (/^Tab \d+$/.test(tab.name) || tab.name === "All assets") {
        tab.name = String(preset.name).slice(0, MAX_NAME);
      }
      render();
      scheduleSave();
    },

    /**
     * Pin a saved preset as the ACTIVE tab's base filter, and apply it.
     *
     * Marking a base IS a reset to it: the base is where the tab starts from,
     * and on a tab already carrying hand-built filters a click that visibly
     * changed nothing would leave the operator unsure it took. What's lost is
     * scratch column filters, which the base is now the way back to.
     */
    setDefaultFilter: function (preset) {
      if (!_ready || !preset) return false;
      var tab = activeTab();
      if (!tab) return false;
      tab.defaultFilterId = preset.id || null;
      tab.defaultFilterName = preset.name ? String(preset.name).slice(0, MAX_NAME) : null;
      tab.defaultState = cloneState(preset.state);
      // The tab came from this preset in every sense now — keep the load-path
      // provenance in step so the close confirmation and tooltip agree.
      tab.savedFilterId = tab.defaultFilterId;
      tab.savedFilterName = tab.defaultFilterName;
      render();
      scheduleSave();
      // applyStateToTable mirrors the base back into tab.state via
      // syncFromTable; the repaint below then relabels the button.
      applyStateToTable(tab.defaultState);
      notifyBaseChanged();
      return true;
    },

    /**
     * Unpin the active tab's base. Deliberately leaves the live filters where
     * they are — the operator asked to stop having a way back, not to lose the
     * view they are looking at.
     */
    clearDefaultFilter: function () {
      if (!_ready) return false;
      var tab = activeTab();
      if (!tab || !tab.defaultState) return false;
      tab.defaultFilterId = null;
      tab.defaultFilterName = null;
      tab.defaultState = null;
      render();
      scheduleSave();
      notifyBaseChanged();
      return true;
    },

    /** The active tab's base filter, or null — read by assets.js + the menu. */
    activeDefault: function () {
      var tab = activeTab();
      if (!tab || !tab.defaultState) return null;
      return {
        id: tab.defaultFilterId,
        name: tab.defaultFilterName,
        state: cloneState(tab.defaultState),
      };
    },

    /** Re-apply the active tab's base filter. False when it has none. */
    resetToDefault: function () {
      var tab = activeTab();
      if (!tab || !tab.defaultState) return false;
      return applyStateToTable(tab.defaultState);
    },

    /**
     * Re-sync every tab's base snapshot from a fresh saved-filter list (the
     * Filters menu calls this on each fetch). An edit to the preset reaches the
     * tabs based on it this way; a preset that has gone — deleted, or someone
     * else's private one — leaves the snapshot alone, so the tab keeps a base
     * it can still reset to.
     */
    refreshDefaultsFromPresets: function (list) {
      if (!_ready || !Array.isArray(list)) return;
      var changed = false;
      _tabs.forEach(function (t) {
        if (!t.defaultState || !t.defaultFilterId) return;
        var preset = null;
        list.forEach(function (f) { if (f && f.id === t.defaultFilterId) preset = f; });
        if (!preset) return;
        var name = preset.name ? String(preset.name).slice(0, MAX_NAME) : null;
        if (name && name !== t.defaultFilterName) { t.defaultFilterName = name; changed = true; }
        if (!sameState(preset.state, t.defaultState)) { t.defaultState = cloneState(preset.state); changed = true; }
      });
      if (!changed) return;
      render();
      scheduleSave();
      notifyBaseChanged();
    },

    /** The active tab's name — seeds the save-preset modal. */
    activeTabName: function () {
      var t = activeTab();
      return t ? t.name : "";
    },

    /** Test seam: the current strip state without a round-trip. */
    _debugState: function () {
      return { tabs: _tabs.slice(), activeId: _activeId, persisted: _persisted };
    },
  };

  // ─── Wiring ───────────────────────────────────────────────────────────────

  function wire(strip) {
    if (strip.getAttribute("data-wired") === "1") return;
    strip.setAttribute("data-wired", "1");

    var add = document.getElementById("assets-tab-add");
    if (add) add.addEventListener("click", function () { addTab(); });

    var list = document.getElementById("assets-tabs-list");
    if (!list) return;

    list.addEventListener("click", function (e) {
      var close = e.target.closest("[data-tab-close]");
      if (close) {
        e.stopPropagation();
        closeTab(close.getAttribute("data-tab-close"));
        return;
      }
      var tabEl = e.target.closest(".table-tab");
      if (tabEl && !tabEl.querySelector("input")) selectTab(tabEl.getAttribute("data-tab-id"));
    });

    list.addEventListener("dblclick", function (e) {
      var tabEl = e.target.closest(".table-tab");
      if (tabEl) beginRename(tabEl);
    });

    // Keyboard parity for the click/dblclick pair: Enter/Space activates,
    // F2 renames — the strip's tabs are focusable (tabindex=0).
    list.addEventListener("keydown", function (e) {
      var tabEl = e.target.closest(".table-tab");
      if (!tabEl || tabEl.querySelector("input")) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectTab(tabEl.getAttribute("data-tab-id"));
      } else if (e.key === "F2") {
        e.preventDefault();
        beginRename(tabEl);
      }
    });

    // A debounced layout save can still be in flight when the operator leaves.
    window.addEventListener("beforeunload", function () {
      if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; saveNow(); }
    });
  }
})();
