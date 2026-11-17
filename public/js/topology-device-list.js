/**
 * public/js/topology-device-list.js — the Device List of a topology view's
 * Topology and Rack canvases (business rule 147): every shown device of the
 * site in ONE list, with a text filter. A device already on the canvas is
 * highlighted and carries an × that takes it off again; one that is not is
 * dragged from the list onto the canvas (edit mode).
 *
 *   window.PolarisTopologyDeviceList.html(opts)  → the section's markup
 *   window.PolarisTopologyDeviceList.wire(pane, opts)
 *
 * The list shows about five and a half rows and scrolls past that (map.css
 * .topo-device-list), so a site with hundreds of endpoints switched on keeps
 * the details pane usable. The filter text survives a re-render: the caller
 * keeps it (opts.filter / opts.onFilter) because map.js redraws the whole
 * pane after every placement.
 *
 * The drag itself (startDrag / carries / token): a drop target must not rely
 * on the drag's own data alone. A browser add-on or a data-loss-prevention
 * hook can strip a custom type off the drag after dragstart (operator report
 * 2026-11-17: dragover saw `types` = [] although dragstart set
 * application/x-polaris-asset, so every rack refused the drop). The page
 * remembers what it started dragging and the targets read that back.
 */
(function () {
  "use strict";

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s))
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  }

  // ── The drag in flight (see the header) ─────────────────────────────
  var dragToken = null;
  function startDrag(e, mime, token) {
    dragToken = token || null;
    if (!e || !e.dataTransfer) return;
    try { e.dataTransfer.setData(mime, token); } catch (_) { /* some browsers refuse custom types */ }
    e.dataTransfer.effectAllowed = "move";
  }
  /** Does this drag carry a device or room item of ours? */
  function carries(e, mime) {
    if (dragToken) return true;
    var types = e && e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, mime) !== -1;
  }
  /** The token being dropped: the drag's data, else what the page started. */
  function token(e, mime) {
    var t = null;
    try { t = e && e.dataTransfer ? e.dataTransfer.getData(mime) : null; } catch (_) { t = null; }
    return t || dragToken;
  }
  function endDrag() { dragToken = null; }
  if (typeof document !== "undefined" && document.addEventListener) {
    document.addEventListener("dragend", endDrag, true);
    // The source row can be redrawn away before its dragend; a drop ends it
    // too, once the targets' own drop handlers have read the token.
    document.addEventListener("drop", function () { setTimeout(endDrag, 0); }, true);
  }

  /** Pure — does a row match the filter text (name or the meta column, any case)? */
  function matches(row, filter) {
    var f = String(filter || "").trim().toLowerCase();
    if (!f) return true;
    return (String(row.label || "") + " " + String(row.meta || "")).toLowerCase().indexOf(f) !== -1;
  }

  /**
   * opts: { title, hint, rows: [{id, label, meta, inUse, title?}], editing,
   *         dragMime, filter, removeLabel, selectedId, emptyText, dragPlaced }
   * A row in use is highlighted; while editing it has an × (data-unplace) and
   * a row not in use is draggable (data-place-asset). With `dragPlaced` a row
   * in use drags too — the Room view moves the device to where it is dropped.
   */
  function html(opts) {
    var rows = opts.rows || [];
    var used = rows.filter(function (r) { return r.inUse; }).length;
    var items = rows.map(function (r) {
      var drag = opts.editing && (!r.inUse || !!opts.dragPlaced);
      var hidden = matches(r, opts.filter) ? "" : " hidden";
      return '<li class="topo-device-row' + (r.inUse ? " is-in-use" : "") + (opts.selectedId === r.id ? " is-selected" : "") + '"' +
        ' data-device-row="' + esc(r.id) + '"' +
        ' data-filter-text="' + esc((r.label || "") + " " + (r.meta || "")) + '"' +
        (drag ? ' draggable="true" data-place-asset="' + esc(r.id) + '"' : "") +
        (r.title ? ' title="' + esc(r.title) + '"' : "") + hidden + '>' +
        '<span class="topo-device-name">' + esc(r.label || r.id) + '</span>' +
        '<span class="meta">' + esc(r.meta || "") + '</span>' +
        (opts.editing && r.inUse
          ? '<button type="button" class="btn-icon topo-device-unplace" data-unplace="' + esc(r.id) + '" title="' + esc(opts.removeLabel || "Remove from the map") + '" aria-label="' + esc((opts.removeLabel || "Remove from the map") + ": " + (r.label || r.id)) + '">×</button>'
          : "") +
        '</li>';
    }).join("");
    var none = rows.length && !rows.some(function (r) { return matches(r, opts.filter); });
    return '<div class="topology-section topo-device-section">' +
      '<h5>' + esc(opts.title || "Device List") + ' <span class="topo-device-count">' + used + ' / ' + rows.length + '</span></h5>' +
      (opts.hint ? '<p class="topology-type-hint" style="margin:0 0 6px">' + esc(opts.hint) + '</p>' : "") +
      (rows.length
        ? '<input type="text" class="topo-device-filter" placeholder="Filter devices" aria-label="Filter the device list" value="' + esc(opts.filter || "") + '">' +
          '<ul class="topo-device-list">' + items + '</ul>' +
          '<p class="muted topo-device-none"' + (none ? "" : " hidden") + '>No device matches.</p>'
        : '<p class="muted">' + esc(opts.emptyText || "No device of a shown type on this site.") + '</p>') +
      '</div>';
  }

  /**
   * opts: { dragMime, onRemove(id), onSelect(id), onFilter(text) }
   * Binds the section map.js just drew. Delegated listeners on the section,
   * so a row added later needs nothing.
   */
  function wire(pane, opts) {
    var sec = pane && pane.querySelector(".topo-device-section");
    if (!sec) return;
    var input = sec.querySelector(".topo-device-filter");
    if (input) {
      input.addEventListener("input", function () {
        var f = input.value;
        var any = false;
        Array.prototype.forEach.call(sec.querySelectorAll("[data-device-row]"), function (li) {
          var ok = matches({ label: li.getAttribute("data-filter-text") }, f);
          li.hidden = !ok;
          if (ok) any = true;
        });
        var none = sec.querySelector(".topo-device-none");
        if (none) none.hidden = any;
        if (typeof opts.onFilter === "function") opts.onFilter(f);
      });
    }
    sec.addEventListener("dragstart", function (e) {
      var li = e.target.closest && e.target.closest("[data-place-asset]");
      if (!li) return;
      startDrag(e, opts.dragMime, li.getAttribute("data-place-asset"));
    });
    sec.addEventListener("click", function (e) {
      var x = e.target.closest("[data-unplace]");
      if (x) {
        e.stopPropagation();
        if (typeof opts.onRemove === "function") opts.onRemove(x.getAttribute("data-unplace"));
        return;
      }
      var li = e.target.closest("[data-device-row]");
      if (li && typeof opts.onSelect === "function") opts.onSelect(li.getAttribute("data-device-row"));
    });
  }

  window.PolarisTopologyDeviceList = {
    html: html, wire: wire, _matches: matches,
    startDrag: startDrag, carries: carries, token: token, endDrag: endDrag,
  };
})();
