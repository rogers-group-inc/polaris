/**
 * public/js/legend-toggle.js — a map legend that collapses into its own button.
 *
 * Collapsed, the legend IS a small legend-icon button sitting where the legend
 * sits (the panel's chrome and rows are hidden; styles.css "Collapsible map
 * legend"); clicking it opens the legend, whose × collapses it back. Used by
 * the Application Map, the Device Map and the Status Map widget (Dashboard and
 * /dash — dash.html has no app.js, so this is its own file).
 *
 *   PolarisLegendToggle.attach(el, {
 *     closeButton,      // an existing × inside el to reuse (else one is added)
 *     title,            // heading shown beside the added ×; default "Legend"
 *     storageKey,       // localStorage key for the open/closed state (per viewer)
 *     expanded,         // initial state, overriding storage
 *     defaultExpanded,  // when neither expanded nor storage say; default true
 *     onChange,         // fn(expanded) after a user toggle
 *     icon, openLabel,  // the collapsed button's SVG and label (default: a
 *                       // legend list, "Show legend") — the Device Map's
 *                       // Regions panel passes its own
 *   }) → { setExpanded(bool), isExpanded(), button }
 *
 * The state is a per-viewer convenience, so storage is best-effort: every
 * read and write is try/catch'd and the legend works without it.
 */
(function () {
  "use strict";

  var ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">' +
      '<circle cx="6" cy="6" r="2"/><line x1="11" y1="6" x2="21" y2="6"/>' +
      '<circle cx="6" cy="12" r="2"/><line x1="11" y1="12" x2="21" y2="12"/>' +
      '<circle cx="6" cy="18" r="2"/><line x1="11" y1="18" x2="21" y2="18"/>' +
    "</svg>";

  function attach(el, opts) {
    if (!el) return null;
    if (el.__legendToggle) return el.__legendToggle;
    opts = opts || {};
    el.classList.add("legend-collapsible");

    var openLabel = opts.openLabel || "Show legend";
    var open = document.createElement("button");
    open.type = "button";
    open.className = "btn btn-secondary btn-sm btn-icon-only legend-toggle-open";
    open.title = openLabel;
    open.setAttribute("aria-label", openLabel);
    open.innerHTML = (opts.icon || ICON) + openLabel;
    el.insertBefore(open, el.firstChild);

    var close = opts.closeButton;
    if (!close) {
      var head = document.createElement("div");
      head.className = "legend-toggle-head";
      var label = document.createElement("span");
      label.textContent = opts.title || "Legend";
      close = document.createElement("button");
      close.type = "button";
      close.className = "legend-toggle-close";
      close.title = "Hide legend";
      close.setAttribute("aria-label", "Hide legend");
      close.innerHTML = "&times;";
      head.appendChild(label);
      head.appendChild(close);
      el.insertBefore(head, open.nextSibling);
    }

    function stored() {
      if (!opts.storageKey) return null;
      try {
        var v = localStorage.getItem(opts.storageKey);
        return v === null ? null : v === "1";
      } catch (_) { return null; }
    }
    function store(expanded) {
      if (!opts.storageKey) return;
      try { localStorage.setItem(opts.storageKey, expanded ? "1" : "0"); } catch (_) { /* per-viewer only */ }
    }
    function set(expanded, byUser) {
      el.classList.toggle("legend-collapsed", !expanded);
      open.setAttribute("aria-expanded", expanded ? "true" : "false");
      if (byUser) {
        store(expanded);
        if (typeof opts.onChange === "function") opts.onChange(expanded);
        // Keyboard users land on the control that brings them back.
        (expanded ? close : open).focus();
      }
    }

    // Clicks on the legend must not reach the map under it (Leaflet's own
    // disableClickPropagation covers the Device Map; the widget and the
    // Application Map need it here).
    open.addEventListener("click", function (e) { e.stopPropagation(); set(true, true); });
    close.addEventListener("click", function (e) { e.stopPropagation(); set(false, true); });

    var initial = typeof opts.expanded === "boolean" ? opts.expanded : stored();
    if (initial === null) initial = opts.defaultExpanded !== false;
    set(initial, false);

    var api = {
      setExpanded: function (x) { set(!!x, false); },
      isExpanded: function () { return !el.classList.contains("legend-collapsed"); },
      button: open,
    };
    el.__legendToggle = api;
    return api;
  }

  window.PolarisLegendToggle = { attach: attach };
})();
