/**
 * public/js/widget-library.js — "Add Widgets" picker (SolarWinds-style).
 *
 * A standard slide-over (index.html / dash.html) with: a Group-By category list, a search box, a name sort, and the available
 * widgets list with live mini-previews + a per-widget favorite (★) toggle.
 * Favorites are per-user localStorage via favorites.js (entity "widgetlib").
 *
 * Exposes window.WidgetLibrary { open, close, isOpen }; the panel chrome +
 * element ids live in index.html. Cards keep `.widget-library-card` +
 * data-type + draggable so the dashboard orchestrator's drag/drop is unchanged.
 */

(function () {
  var FAV_ENTITY = "widgetlib";

  var overlayEl = null, bodyEl = null, closeBtn = null, groupsEl = null, searchEl = null, sortEl = null;
  var _onAddCallback = null;
  var _activeGroup = "All";   // "All" | "Favorites" | <category>
  var _search = "";
  var _sort = "name-asc";

  function init() {
    if (overlayEl) return;
    overlayEl = document.getElementById("widget-library-overlay");
    bodyEl    = document.getElementById("widget-library-body");
    closeBtn  = document.getElementById("widget-library-close");
    groupsEl  = document.getElementById("widget-picker-groups");
    searchEl  = document.getElementById("widget-picker-search");
    sortEl    = document.getElementById("widget-picker-sort");
    if (!overlayEl || !bodyEl || !closeBtn) return;
    closeBtn.addEventListener("click", close);
    // An off-click (the backdrop) closes it — unless slide-overs are locked:
    // panel-lock.js's capture listener stops this click and blooms the X
    // instead. initPanelLock is idempotent; calling it here is what wires the
    // lock and injects its button on the /dash wallboard, which has no app.js.
    if (typeof initPanelLock === "function") initPanelLock();
    overlayEl.addEventListener("click", function (e) { if (e.target === overlayEl) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && isOpen()) close(); });
    if (searchEl) searchEl.addEventListener("input", function () { _search = searchEl.value.trim().toLowerCase(); renderList(); });
    if (sortEl) sortEl.addEventListener("change", function () { _sort = sortEl.value; renderList(); });
  }

  function isOpen() { return overlayEl && overlayEl.classList.contains("open"); }

  function open(onAdd) {
    init();
    if (!overlayEl) return;
    _onAddCallback = onAdd || null;
    renderGroups();
    renderList();
    overlayEl.classList.remove("drag-hidden");
    overlayEl.classList.add("open");
    overlayEl.setAttribute("aria-hidden", "false");
    if (searchEl) { try { searchEl.focus(); } catch (_) {} }
  }

  function close() {
    if (!overlayEl) return;
    overlayEl.classList.remove("open");
    overlayEl.classList.remove("drag-hidden");
    overlayEl.setAttribute("aria-hidden", "true");
    _onAddCallback = null;
  }

  function categoryOf(w) { return w.category || "Other"; }

  function favCount(widgets) {
    return widgets.filter(function (w) { return isFavorite(FAV_ENTITY, w.type); }).length;
  }

  function renderGroups() {
    if (!groupsEl) return;
    var widgets = PolarisWidgets.getAllowed();
    var cats = {};
    widgets.forEach(function (w) { var c = categoryOf(w); cats[c] = (cats[c] || 0) + 1; });
    var catNames = Object.keys(cats).sort();
    var groups = [{ key: "All", label: "All", count: widgets.length },
                  { key: "Favorites", label: "★ Favorites", count: favCount(widgets) }];
    catNames.forEach(function (c) { groups.push({ key: c, label: c, count: cats[c] }); });

    groupsEl.innerHTML = groups.map(function (g) {
      return '<li><button type="button" class="widget-picker-group' + (g.key === _activeGroup ? ' active' : '') +
        '" data-group="' + escapeHtml(g.key) + '">' + escapeHtml(g.label) +
        '<span class="widget-picker-group-count">' + g.count + '</span></button></li>';
    }).join("");
    groupsEl.querySelectorAll("[data-group]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        _activeGroup = btn.getAttribute("data-group");
        renderGroups();
        renderList();
      });
    });
  }

  function filteredWidgets() {
    var widgets = PolarisWidgets.getAllowed();
    if (_activeGroup === "Favorites") widgets = widgets.filter(function (w) { return isFavorite(FAV_ENTITY, w.type); });
    else if (_activeGroup !== "All") widgets = widgets.filter(function (w) { return categoryOf(w) === _activeGroup; });
    if (_search) {
      widgets = widgets.filter(function (w) {
        return (w.label || "").toLowerCase().indexOf(_search) !== -1 ||
               (w.description || "").toLowerCase().indexOf(_search) !== -1;
      });
    }
    widgets = widgets.slice().sort(function (a, b) {
      var cmp = (a.label || "").localeCompare(b.label || "");
      return _sort === "name-desc" ? -cmp : cmp;
    });
    // Favorites pinned to the top of the result (skip when already on the
    // Favorites group, where every row is a favorite anyway).
    if (_activeGroup !== "Favorites") {
      var favs = [], rest = [];
      widgets.forEach(function (w) { (isFavorite(FAV_ENTITY, w.type) ? favs : rest).push(w); });
      widgets = favs.concat(rest);
    }
    return widgets;
  }

  function renderList() {
    if (!bodyEl) return;
    var widgets = filteredWidgets();
    if (!widgets.length) {
      bodyEl.innerHTML = '<p class="empty-state" style="margin-top:32px">' +
        (PolarisWidgets.getAllowed().length ? "No widgets match." : "No widgets available for your role.") + '</p>';
      return;
    }
    bodyEl.innerHTML = widgets.map(function (w) {
      var fav = isFavorite(FAV_ENTITY, w.type);
      return '<div class="widget-library-card" data-type="' + escapeHtml(w.type) + '" draggable="true" tabindex="0" role="button">' +
        '<button type="button" class="widget-fav-star' + (fav ? " fav-on" : "") + '" data-fav-type="' + escapeHtml(w.type) + '"' +
          ' title="' + (fav ? "Unfavorite" : "Favorite") + '" aria-label="Toggle favorite">' + (fav ? "★" : "☆") + '</button>' +
        '<div class="widget-library-card-info">' +
          '<div class="widget-library-card-title">' + escapeHtml(w.label) + '</div>' +
          '<div class="widget-library-card-desc">' + escapeHtml(w.description || "") + '</div>' +
          '<div class="widget-library-card-tag">' + escapeHtml(categoryOf(w)) + ' · drag onto dashboard</div>' +
        '</div>' +
        '<div class="widget-library-preview" data-preview-for="' + escapeHtml(w.type) + '"></div>' +
      '</div>';
    }).join("");

    widgets.forEach(function (w) {
      var previewEl = bodyEl.querySelector('[data-preview-for="' + cssEsc(w.type) + '"]');
      if (previewEl) { try { w.renderPreview(previewEl); } catch (_err) { /* best-effort */ } }
    });

    bodyEl.querySelectorAll(".widget-library-card").forEach(function (card) {
      var type = card.getAttribute("data-type");
      card.addEventListener("dragstart", function (e) {
        e.dataTransfer.effectAllowed = "copy";
        e.dataTransfer.setData("application/x-polaris-widget", type);
        e.dataTransfer.setData("text/plain", type);
        // Hide the picker once the drag is under way so the whole dashboard
        // (including columns behind the panel) is a reachable drop target.
        // Deferred a tick so the browser has captured the drag image first —
        // hiding the source synchronously can cancel the drag.
        setTimeout(function () { if (overlayEl) overlayEl.classList.add("drag-hidden"); }, 0);
      });
      // Restore the picker if the drag ends without a drop (a successful drop
      // calls WidgetLibrary.close(), so the un-hide is a no-op there).
      card.addEventListener("dragend", function () {
        if (overlayEl) overlayEl.classList.remove("drag-hidden");
      });
      card.addEventListener("click", function (e) {
        if (e.target.closest(".widget-fav-star")) return; // star handles itself
        if (typeof _onAddCallback === "function") { _onAddCallback(type); close(); }
      });
      card.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          if (typeof _onAddCallback === "function") { _onAddCallback(type); close(); }
        }
      });
      var star = card.querySelector(".widget-fav-star");
      if (star) star.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        toggleFavorite(FAV_ENTITY, type);
        renderGroups();
        renderList();
      });
    });
  }

  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
  }

  window.WidgetLibrary = { open: open, close: close, isOpen: isOpen };
})();
