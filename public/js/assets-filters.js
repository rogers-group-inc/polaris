/**
 * public/js/assets-filters.js — saved filter presets for the Assets table.
 *
 * The page-header "Filters ▾" menu: save the table's current column filters +
 * sort as a named preset, load one back, and delete it. Presets live on the
 * SERVER (GET/POST/PUT/DELETE /api/v1/saved-filters?scope=assets), not in
 * localStorage, precisely because they're shareable:
 *
 *   Private — visible only to the operator who saved it.
 *   Public  — offered to every user who can read the Assets page. Publishing
 *             is a write to shared state, so it needs assets:write; keeping a
 *             private preset only needs the assets:read the page already has.
 *
 * A preset stores the QUERY only ({ sfFilters, sortKey, sortDir } — TableSF's
 * getPrefs shape). Column widths / visibility stay per-browser in localStorage
 * (applyTableLayout) — they describe the operator's screen, not what they're
 * looking for.
 *
 * Each row's ★ pins that preset as the ACTIVE VIEW TAB's base filter — the view
 * the tab returns to, so the operator can narrow further inside a saved filter
 * and get back in one click (the page-controls button then reads "Reset Filter"
 * instead of "Clear Filters"). The base lives on the tab, not on the preset:
 * assets-tabs.js owns it, this file only offers the verb, and every list fetch
 * hands the fresh presets to refreshDefaultsFromPresets so an edited preset
 * reaches the tabs based on it.
 *
 * Depends on globals from app.js (openModal/closeModal/showConfirm/permAtLeast),
 * api.js (api/showToast/escapeHtml), table-sf.js (TableSF.prototype.applyState)
 * and assets.js (_assetsSF, assetsApplyFilterState) — all loaded before this
 * file on assets.html.
 */

/* global api, openModal, closeModal, showToast, showConfirm, escapeHtml,
          permAtLeast, _assetsSF, assetsApplyFilterState */

var SFL_SCOPE = "assets";

var _sflCache = [];          // last server list, for the save-modal name collision check
var _sflLoaded = false;      // false until the first successful list fetch

// ─── Data ───────────────────────────────────────────────────────────────────

async function _sflFetch() {
  var data = await api.savedFilters.list(SFL_SCOPE);
  _sflCache = (data && data.filters) || [];
  _sflLoaded = true;
  // The presets a tab is based on may have been edited (or published) since the
  // last look — this is the only moment we hold the current ones. Feature-tested
  // rather than assumed: a browser holding a cached pre-base assets-tabs.js
  // must keep a working Filters menu, not throw on every open.
  if (_sflTabs("refreshDefaultsFromPresets")) window.PolarisAssetTabs.refreshDefaultsFromPresets(_sflCache);
  return _sflCache;
}

/** window.PolarisAssetTabs, but only when it carries the method we need. */
function _sflTabs(method) {
  var t = window.PolarisAssetTabs;
  return t && typeof t[method] === "function" ? t : null;
}

/** The active view tab's base filter, or null (no tab strip = no base). */
function _sflActiveBase() {
  return _sflTabs("activeDefault") ? window.PolarisAssetTabs.activeDefault() : null;
}

/** The live table state, in the shape the server stores. */
function _sflCurrentState() {
  if (!_assetsSF || typeof _assetsSF.getPrefs !== "function") {
    return { sfFilters: {}, sortKey: null, sortDir: null };
  }
  var p = _assetsSF.getPrefs();
  return { sfFilters: p.sfFilters || {}, sortKey: p.sortKey || null, sortDir: p.sortDir || null };
}

function _sflFilterCount(state) {
  return Object.keys((state && state.sfFilters) || {}).length;
}

// ─── Human-readable summaries ───────────────────────────────────────────────

/**
 * Column key → the header label the operator sees ("hostname" → "Hostname").
 * Walks the headers rather than building an attribute selector: a preset's
 * keys come back from the server, and a quote in one would break the selector
 * (or need CSS.escape, which not every runtime exposes). Falls back to the raw
 * key so a column removed since the preset was saved still reads sensibly.
 */
function _sflColumnLabel(key) {
  var ths = document.querySelectorAll("#assets-table-wrapper th[data-sf-key]");
  for (var i = 0; i < ths.length; i++) {
    if (ths[i].getAttribute("data-sf-key") !== key) continue;
    var label = ths[i].querySelector(".sf-label");
    return label ? label.textContent.trim() : key;
  }
  return key;
}

/** One column's filter as a phrase ("Hostname contains nsh"). */
function _sflDescribeFilter(key, raw) {
  var label = _sflColumnLabel(key);
  if (Array.isArray(raw)) return label + ": " + raw.join(", ");
  if (typeof raw === "string") {
    return raw.charAt(0) === "!"
      ? label + " excludes " + raw.slice(1)
      : label + " contains " + raw;
  }
  if (raw && typeof raw === "object") {
    if (raw.type === "date") {
      if (raw.from && raw.to) return label + " " + raw.from + " – " + raw.to;
      if (raw.from) return label + " since " + raw.from;
      if (raw.to) return label + " until " + raw.to;
      return label + " (any date)";
    }
    if (raw.op === "empty")        return label + " is empty";
    if (raw.op === "notempty")     return label + " is not empty";
    if (raw.op === "not-contains") return label + " excludes " + (raw.q || "");
    if (raw.op === "contains")     return label + " contains " + (raw.q || "");
    if (raw.op === "in-networks")  return label + " in " + (raw.terms || []).join(" or ");
  }
  return label;
}

/** Full state as one sentence, for the menu tooltip + the save modal preview. */
function _sflDescribeState(state) {
  var filters = (state && state.sfFilters) || {};
  var parts = Object.keys(filters).map(function (k) { return _sflDescribeFilter(k, filters[k]); });
  if (state && state.sortKey) {
    parts.push("sorted by " + _sflColumnLabel(state.sortKey) + (state.sortDir === "desc" ? " ↓" : " ↑"));
  }
  return parts.length ? parts.join(" · ") : "No filters — shows every asset";
}

// ─── Menu ───────────────────────────────────────────────────────────────────

function _sflCanDelete(f) {
  return f.isOwner || permAtLeast("assets", "fullwrite");
}

function _sflRowHtml(f, base) {
  var badge = f.visibility === "public"
    ? '<span class="sfl-badge" title="Shared with everyone">Public</span>' : "";
  var owner = f.isOwner ? "" : '<span class="sfl-owner">' + escapeHtml(f.ownerName) + "</span>";
  // Base filter toggle — only where the tab strip exists (assets.html), since a
  // base belongs to a tab.
  var isBase = !!(base && base.id === f.id);
  var star = _sflTabs("setDefaultFilter")
    ? '<button type="button" class="sfl-star' + (isBase ? " active" : "") + '" data-sfl-default="' +
      escapeHtml(f.id) + '" aria-pressed="' + (isBase ? "true" : "false") + '" title="' +
      (isBase
        ? "This tab's base filter — click to remove it"
        : "Use as this tab's base filter, the view Reset Filter returns to") +
      '" aria-label="' + (isBase ? "Remove " : "Use ") + escapeHtml(f.name) +
      ' as this tab\'s base filter">&#9733;</button>'
    : "";
  // Open-in-new-tab only exists where the tab strip does (assets.html).
  var newTab = window.PolarisAssetTabs
    ? '<button type="button" class="sfl-newtab" data-sfl-newtab="' + escapeHtml(f.id) +
      '" title="Open in a new tab" aria-label="Open ' + escapeHtml(f.name) + ' in a new tab">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13" aria-hidden="true">' +
      '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 8v8M8 12h8"/></svg></button>'
    : "";
  var del = _sflCanDelete(f)
    ? '<button type="button" class="sfl-del" data-sfl-del="' + escapeHtml(f.id) +
      '" title="Delete this saved filter" aria-label="Delete ' + escapeHtml(f.name) + '">&times;</button>'
    : "";
  return '<div class="sfl-row' + (isBase ? " sfl-row-base" : "") + '">' +
    '<button type="button" class="sfl-load" data-sfl-load="' + escapeHtml(f.id) + '" title="' +
      escapeHtml(_sflDescribeState(f.state)) + '">' +
      '<span class="sfl-name">' + escapeHtml(f.name) + "</span>" + badge + owner +
    "</button>" + star + newTab + del +
  "</div>";
}

function _sflRenderMenu(list, error) {
  var menu = document.getElementById("saved-filters-menu");
  if (!menu) return;
  // Read the base at render time — the menu is rebuilt on every open, so it is
  // always the base of the tab the operator is actually looking at.
  var base = _sflActiveBase();
  var html =
    '<button type="button" data-sfl-act="save">Save current filters&hellip;</button>' +
    (base
      ? '<button type="button" data-sfl-act="reset" title="' +
          escapeHtml(_sflDescribeState(base.state)) + '">Reset to base filter &ldquo;' +
          escapeHtml(base.name || "base") + '&rdquo;</button>'
      : "") +
    '<button type="button" data-sfl-act="clear">' +
      (base ? "Clear all filters" : "Clear active filters") + "</button>" +
    // The ★ can only unpin a base whose preset is still listed; a base whose
    // preset was deleted still resets, so removing it needs a way in here.
    (base
      ? '<button type="button" data-sfl-act="unbase">Remove base filter from this tab</button>'
      : "") +
    '<div class="dropdown-divider"></div>';

  if (error) {
    html += '<div class="sfl-empty">Could not load saved filters</div>';
  } else if (!_sflLoaded) {
    html += '<div class="sfl-empty">Loading&hellip;</div>';
  } else {
    var mine = list.filter(function (f) { return f.isOwner; });
    var shared = list.filter(function (f) { return !f.isOwner; });
    if (!mine.length && !shared.length) {
      html += '<div class="sfl-empty">No saved filters yet</div>';
    }
    var row = function (f) { return _sflRowHtml(f, base); };
    if (mine.length) {
      html += '<div class="dropdown-heading">My filters</div>' + mine.map(row).join("");
    }
    if (shared.length) {
      html += '<div class="dropdown-heading">Shared filters</div>' + shared.map(row).join("");
    }
  }
  menu.innerHTML = html;
}

async function _sflRefreshMenu() {
  try {
    _sflRenderMenu(await _sflFetch(), false);
  } catch (err) {
    _sflRenderMenu([], true);
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────

/** Load a preset into the CURRENT view tab. */
function _sflApply(filter) {
  if (!_assetsSF || typeof _assetsSF.applyState !== "function") return;
  _assetsSF.applyState(filter.state || {});
  assetsApplyFilterState();
  // The tab records where its filters came from (label + close confirmation).
  // Order matters: assetsApplyFilterState already mirrored the new state into
  // the tab, so this only stamps the provenance on top.
  if (window.PolarisAssetTabs) window.PolarisAssetTabs.noteFilterLoaded(filter);
  showToast('Applied filter "' + filter.name + '"');
}

/** Clear every live column filter. The tab's base (if any) stays configured. */
function _sflClearAll() {
  if (!_assetsSF) return;
  _assetsSF.clearFilters();
  assetsApplyFilterState();
}

/** Pin / unpin a preset as the active tab's base filter (the row's ★). */
function _sflToggleBase(id) {
  if (!_sflTabs("setDefaultFilter")) return;
  var base = _sflActiveBase();
  if (base && base.id === id) {
    if (window.PolarisAssetTabs.clearDefaultFilter()) {
      showToast("Base filter removed from this tab");
    }
    return;
  }
  var f = _sflCache.find(function (x) { return x.id === id; });
  if (!f) return;
  // Setting a base applies it — see setDefaultFilter's note on why.
  if (window.PolarisAssetTabs.setDefaultFilter(f)) {
    showToast('This tab now resets to "' + f.name + '"');
  }
}

/** Load a preset into a NEW view tab, leaving the current one untouched. */
function _sflApplyInNewTab(filter) {
  if (!window.PolarisAssetTabs) { _sflApply(filter); return; }
  if (window.PolarisAssetTabs.openInNewTab(filter)) {
    showToast('Opened "' + filter.name + '" in a new tab');
  }
}

async function _sflDelete(id) {
  var f = _sflCache.find(function (x) { return x.id === id; });
  if (!f) return;
  var extra = f.isOwner
    ? (f.visibility === "public" ? "\n\nIt is shared — everyone loses it." : "")
    : "\n\nIt belongs to " + f.ownerName + " and is shared with everyone.";
  var ok = await showConfirm('Delete the saved filter "' + f.name + '"?' + extra);
  if (!ok) return;
  try {
    await api.savedFilters.delete(id);
    showToast('Deleted "' + f.name + '"');
    await _sflRefreshMenu();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

function _sflOpenSaveModal() {
  var state = _sflCurrentState();
  var canPublish = permAtLeast("assets", "write");
  var count = _sflFilterCount(state);

  // Seed the name from the tab the operator is looking at — the usual intent
  // is "keep this view", and they already named the tab. Never seeded from the
  // untouched default names.
  var seedName = "";
  if (window.PolarisAssetTabs) {
    var tabName = window.PolarisAssetTabs.activeTabName();
    if (tabName && !/^Tab \d+$/.test(tabName) && tabName !== "All assets") seedName = tabName;
  }

  var body =
    '<div class="form-group">' +
      '<label for="sfl-name">Name</label>' +
      '<input type="text" id="sfl-name" maxlength="60" autocomplete="off" list="sfl-name-list" value="' +
        escapeHtml(seedName) + '" placeholder="e.g. Down firewalls">' +
      '<datalist id="sfl-name-list">' +
        _sflCache.filter(function (f) { return f.isOwner; })
          .map(function (f) { return '<option value="' + escapeHtml(f.name) + '"></option>'; }).join("") +
      "</datalist>" +
      '<div class="hint">Saving over one of your existing names replaces it.</div>' +
    "</div>" +
    '<div class="form-group">' +
      "<label>Visibility</label>" +
      '<label class="sfl-vis"><input type="radio" name="sfl-vis" value="private" checked>' +
        "<span><strong>Private</strong> — only you can see and use it</span></label>" +
      '<label class="sfl-vis' + (canPublish ? "" : " sfl-vis-disabled") + '">' +
        '<input type="radio" name="sfl-vis" value="public"' + (canPublish ? "" : " disabled") + ">" +
        "<span><strong>Public</strong> — everyone who can view assets can use it" +
        (canPublish ? "" : '<br><span class="hint">Requires asset write access</span>') +
        "</span></label>" +
    "</div>" +
    '<div class="form-group">' +
      "<label>What gets saved</label>" +
      '<div class="sfl-preview">' + escapeHtml(_sflDescribeState(state)) + "</div>" +
      '<div class="hint">' +
        (count ? count + (count === 1 ? " column filter" : " column filters") : "No column filters") +
        " · column widths and hidden columns are not part of a preset." +
      "</div>" +
    "</div>";

  var footer =
    '<button class="btn btn-secondary" id="sfl-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="sfl-save">Save</button>';

  openModal("Save current filters", body, footer);
  document.getElementById("sfl-cancel").addEventListener("click", closeModal);

  var nameInput = document.getElementById("sfl-name");
  var saveBtn = document.getElementById("sfl-save");

  async function submit() {
    var name = (nameInput.value || "").trim();
    if (!name) { showToast("Name is required", "error"); nameInput.focus(); return; }
    var visEl = document.querySelector('input[name="sfl-vis"]:checked');
    var visibility = visEl ? visEl.value : "private";

    var clash = _sflCache.find(function (f) {
      return f.isOwner && f.name.toLowerCase() === name.toLowerCase();
    });
    if (clash) {
      var ok = await showConfirm('You already have a filter named "' + clash.name + '" — replace it?');
      if (!ok) return;
    }

    saveBtn.disabled = true;
    try {
      // The server treats a same-(scope, owner, name) POST as an update, so
      // one call covers both create and overwrite.
      await api.savedFilters.create({ scope: SFL_SCOPE, name: name, visibility: visibility, state: state });
      closeModal();
      showToast('Saved filter "' + name + '"');
      await _sflRefreshMenu();
    } catch (err) {
      showToast(err.message || "Save failed", "error");
      saveBtn.disabled = false;
    }
  }

  saveBtn.addEventListener("click", submit);
  nameInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
  });
}

// ─── Wiring ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", function () {
  var btn = document.getElementById("btn-saved-filters");
  var menu = document.getElementById("saved-filters-menu");
  if (!btn || !menu) return;   // assets.js is also loaded on map.html

  // Render the placeholder once so the first open isn't an empty box.
  _sflRenderMenu([], false);

  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    var willOpen = !menu.classList.contains("open");
    // Sibling header menus (Import / Export) stopPropagation on their own
    // button, so their document-level close listener never fires for a click
    // on ours — close them explicitly instead of stacking two open menus.
    document.querySelectorAll(".btn-dropdown-menu.open").forEach(function (m) { m.classList.remove("open"); });
    if (willOpen) {
      menu.classList.add("open");
      // Re-fetch on every open: another operator may have published a preset
      // since the last look, and the list is small.
      _sflRefreshMenu();
    }
  });
  document.addEventListener("click", function () { menu.classList.remove("open"); });
  menu.addEventListener("click", function (e) { e.stopPropagation(); });

  menu.addEventListener("click", function (e) {
    var act = e.target.closest("[data-sfl-act]");
    if (act) {
      menu.classList.remove("open");
      var which = act.getAttribute("data-sfl-act");
      if (which === "save") {
        _sflOpenSaveModal();
      } else if (which === "reset") {
        if (_sflTabs("resetToDefault")) window.PolarisAssetTabs.resetToDefault();
      } else if (which === "unbase") {
        if (_sflTabs("clearDefaultFilter") && window.PolarisAssetTabs.clearDefaultFilter()) {
          showToast("Base filter removed from this tab");
        }
      } else {
        _sflClearAll();
      }
      return;
    }
    var star = e.target.closest("[data-sfl-default]");
    if (star) {
      menu.classList.remove("open");
      _sflToggleBase(star.getAttribute("data-sfl-default"));
      return;
    }
    var newTab = e.target.closest("[data-sfl-newtab]");
    if (newTab) {
      menu.classList.remove("open");
      var nf = _sflCache.find(function (x) { return x.id === newTab.getAttribute("data-sfl-newtab"); });
      if (nf) _sflApplyInNewTab(nf);
      return;
    }
    var load = e.target.closest("[data-sfl-load]");
    if (load) {
      menu.classList.remove("open");
      var f = _sflCache.find(function (x) { return x.id === load.getAttribute("data-sfl-load"); });
      if (f) _sflApply(f);
      return;
    }
    var del = e.target.closest("[data-sfl-del]");
    if (del) _sflDelete(del.getAttribute("data-sfl-del"));
  });
});
