// public/js/mobile/list-controls.js — the filter field + "Sort & filter"
// sheet the phone's list tabs share (Assets, Networks).
//
// One shape for both so a phone reads the same way on every list: a filter
// field and a sort chip on one row, the list's filter chips under them, and a
// bottom sheet behind the chip that picks the sort column, its direction and
// any secondary filter the chips have no room for. The two tabs differ in
// WHERE the work happens — Assets sorts and filters server-side (a fleet can
// be thousands of rows, paged), Networks client-side over the full list the
// desktop Networks page also loads — so this module draws and reports, and
// never touches data.
//
// The per-list choice (sort, direction, sheet filters) persists per viewer in
// localStorage; the filter text does not, since a stale term hiding rows on
// the next visit reads as missing data. Storage can be blocked or absent, so
// every read and write is guarded and the defaults stand in.

(function () {
  function loadPrefs(key, defaults) {
    var out = Object.assign({}, defaults);
    try {
      var raw = localStorage.getItem(key);
      if (raw) {
        var saved = JSON.parse(raw);
        if (saved && typeof saved === "object") {
          Object.keys(defaults).forEach(function (k) {
            if (typeof saved[k] === typeof defaults[k]) out[k] = saved[k];
          });
        }
      }
    } catch (_) { /* storage blocked or corrupt — defaults stand */ }
    return out;
  }

  function savePrefs(key, prefs) {
    try { localStorage.setItem(key, JSON.stringify(prefs)); } catch (_) { /* best effort */ }
  }

  /**
   * The toolbar row: filter field (with a clear button) + the sort chip.
   * `opts`: { id, placeholder, value, sortLabel, dir, active }
   * `active` marks the chip when a sheet filter is narrowing the list, so a
   * hidden filter is never invisible.
   */
  function toolbarHTML(opts) {
    var id = opts.id;
    var value = opts.value || "";
    return ''
      + '<div class="list-toolbar">'
      + '  <label class="list-filter">'
      + '    <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-filter"/></svg>'
      + '    <input type="search" id="' + id + '-filter" class="list-filter-input" placeholder="' + escapeHtml(opts.placeholder || "Filter") + '"'
      + '      value="' + escapeHtml(value) + '" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search">'
      + '    <button type="button" class="list-filter-clear' + (value ? '' : ' hidden') + '" id="' + id + '-filter-clear" aria-label="Clear filter"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '  </label>'
      + '  <button type="button" class="chip list-sort-chip' + (opts.active ? ' selected' : '') + '" id="' + id + '-sort">'
      +      sortChipInner(opts.sortLabel, opts.dir)
      + '  </button>'
      + '</div>';
  }

  function sortChipInner(label, dir) {
    return '<svg viewBox="0 0 24 24" class="list-sort-dir' + (dir === "desc" ? " desc" : "") + '" aria-hidden="true"><use href="#i-down-arrow"/></svg>'
      + '<span>' + escapeHtml(label || "Sort") + '</span>';
  }

  /**
   * Wire the toolbar. `onFilter(text)` fires debounced as the operator types
   * (and at once on clear / Enter); `onSort()` fires on a chip tap — the
   * caller opens its sheet with openSortSheet.
   */
  function wireToolbar(id, handlers) {
    var input = document.getElementById(id + "-filter");
    var clear = document.getElementById(id + "-filter-clear");
    var sort  = document.getElementById(id + "-sort");
    var timer = null;
    function fire(immediate) {
      if (timer) { clearTimeout(timer); timer = null; }
      var v = input ? input.value.trim() : "";
      if (clear) clear.classList.toggle("hidden", !(input && input.value));
      if (immediate) handlers.onFilter(v);
      else timer = setTimeout(function () { timer = null; handlers.onFilter(v); }, handlers.debounceMs || 250);
    }
    if (input) {
      input.addEventListener("input", function () { fire(false); });
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") { ev.preventDefault(); fire(true); try { input.blur(); } catch (_) {} }
      });
    }
    if (clear) clear.addEventListener("click", function (ev) {
      ev.preventDefault();
      if (input) input.value = "";
      fire(true);
    });
    if (sort) sort.addEventListener("click", function () { handlers.onSort(); });
  }

  /** Repaint the chip after a sheet choice without rebuilding the toolbar. */
  function updateSortChip(id, label, dir, active) {
    var chip = document.getElementById(id + "-sort");
    if (!chip) return;
    chip.innerHTML = sortChipInner(label, dir);
    chip.classList.toggle("selected", !!active);
  }

  /**
   * The "Sort & filter" sheet.
   * `opts`: {
   *   sortOptions: [{ key, label, defaultDir }],
   *   sortKey, sortDir,
   *   filters: [{ key, label, options: [{ value, label }], value }]   (optional)
   *   onApply({ sortKey, sortDir, filters: { <key>: value } })
   * }
   * Choices apply as they are tapped — the sheet is a picker, not a form,
   * so there is no Apply button to forget.
   */
  function openSortSheet(opts) {
    closeSortSheet();
    var state = { sortKey: opts.sortKey, sortDir: opts.sortDir, filters: {} };
    (opts.filters || []).forEach(function (f) { state.filters[f.key] = f.value; });

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "list-sort-scrim";
    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "list-sort-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Sort and filter");
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    function paint() {
      var html = ''
        + '<div class="sheet-handle"></div>'
        + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">'
        + '  <h3 class="sheet-title" style="margin:0;">Sort &amp; filter</h3>'
        + '  <button class="icon-btn" id="list-sort-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
        + '</div>'
        + '<div class="section-head" style="padding-left:0;padding-right:0;">Sort by</div>'
        + '<div class="sort-options">';
      opts.sortOptions.forEach(function (o) {
        var sel = o.key === state.sortKey;
        html += ''
          + '<button type="button" class="list-item sort-option' + (sel ? ' selected' : '') + '" data-sort="' + escapeHtml(o.key) + '" aria-pressed="' + (sel ? "true" : "false") + '">'
          + '  <div class="content"><div class="headline">' + escapeHtml(o.label) + '</div></div>'
          + (sel ? '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-check"/></svg></div>' : '')
          + '</button>';
      });
      html += '</div>'
        + '<div class="chip-row" style="padding-left:0;padding-right:0;">'
        + '  <button type="button" class="chip' + (state.sortDir === "asc" ? ' selected' : '') + '" data-dir="asc">'
        +      (state.sortDir === "asc" ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '') + 'Ascending</button>'
        + '  <button type="button" class="chip' + (state.sortDir === "desc" ? ' selected' : '') + '" data-dir="desc">'
        +      (state.sortDir === "desc" ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '') + 'Descending</button>'
        + '</div>';
      (opts.filters || []).forEach(function (f) {
        html += '<div class="section-head" style="padding-left:0;padding-right:0;">' + escapeHtml(f.label) + '</div>'
          + '<div class="chip-row wrap" style="padding-left:0;padding-right:0;">';
        f.options.forEach(function (o) {
          var sel = state.filters[f.key] === o.value;
          html += '<button type="button" class="chip' + (sel ? ' selected' : '') + '" data-filter="' + escapeHtml(f.key) + '" data-value="' + escapeHtml(o.value) + '">'
            + (sel ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '') + escapeHtml(o.label) + '</button>';
        });
        html += '</div>';
      });
      sheet.innerHTML = html;
      document.getElementById("list-sort-close").addEventListener("click", closeSortSheet);
    }

    function apply() {
      opts.onApply({ sortKey: state.sortKey, sortDir: state.sortDir, filters: Object.assign({}, state.filters) });
    }

    // Delegated, so a repaint never re-attaches per-button listeners.
    sheet.addEventListener("click", function (ev) {
      var t = ev.target && ev.target.closest ? ev.target : null;
      if (!t) return;
      var s = t.closest("[data-sort]");
      if (s) {
        var key = s.getAttribute("data-sort");
        if (key === state.sortKey) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = key;
          var o = opts.sortOptions.find(function (x) { return x.key === key; });
          state.sortDir = (o && o.defaultDir) || "asc";
        }
        paint(); apply();
        return;
      }
      var d = t.closest("[data-dir]");
      if (d) {
        state.sortDir = d.getAttribute("data-dir");
        paint(); apply();
        return;
      }
      var f = t.closest("[data-filter]");
      if (f) {
        state.filters[f.getAttribute("data-filter")] = f.getAttribute("data-value");
        paint(); apply();
      }
    });

    scrim.addEventListener("click", closeSortSheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeSortSheet);
    paint();
  }

  function closeSortSheet() {
    var s = document.getElementById("list-sort-sheet");
    var sc = document.getElementById("list-sort-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  window.PolarisListControls = {
    loadPrefs: loadPrefs,
    savePrefs: savePrefs,
    toolbarHTML: toolbarHTML,
    wireToolbar: wireToolbar,
    updateSortChip: updateSortChip,
    openSortSheet: openSortSheet,
    closeSortSheet: closeSortSheet,
  };
})();
