// public/js/map-fullscreen.js — the Device Map's and Application Map's
// on-map Full screen button.
//
// Same approach as the site topology modal's full screen (map.js
// toggleFullscreenTopology): native full screen is requested on the DOCUMENT
// root, never on the map element, and the .map-fullscreen class makes the map
// fill the viewport. A native-fullscreen element paints above everything
// outside its own subtree, which would bury the body-parented layers a map
// opens on top of itself — the asset details slide-over, the topology modal,
// the Export menu, toasts. With the whole document full screen, ordinary
// z-index stacking still applies (.map-fullscreen sits at 500: over the
// sidebar, under menus, modals and slide-overs). When the Fullscreen API is
// missing or refuses (no user activation, an iframe policy), the class alone
// still fills the browser window, and Esc leaves it.
//
// PolarisMapFullscreen.attach(button, target, onResize) wires `button` to
// toggle `target`; onResize runs after every change so the map can re-measure
// its container (Leaflet invalidateSize, Cytoscape resize).

(function () {
  "use strict";

  var ICON_ENTER =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/>' +
      '<path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>';
  var ICON_EXIT =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/>' +
      '<path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/></svg>';

  function nativeElement() { return document.fullscreenElement || document.webkitFullscreenElement || null; }

  function attach(button, target, onResize) {
    if (!button || !target) return null;
    var root = document.documentElement;

    function paint() {
      var on = target.classList.contains("map-fullscreen");
      button.innerHTML = on ? ICON_EXIT : ICON_ENTER;
      var label = on ? "Exit full screen" : "Full screen";
      button.title = label + (on ? " (Esc)" : "");
      button.setAttribute("aria-label", label);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }
    function changed() {
      paint();
      if (typeof onResize === "function") {
        // After the layout change lands, so the map measures its new box.
        requestAnimationFrame(function () { try { onResize(); } catch (e) { /* a map mid-teardown */ } });
      }
    }
    function enter() {
      target.classList.add("map-fullscreen");
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req && !nativeElement()) {
        var p;
        try { p = req.call(root); } catch (e) { /* refused — the class alone fills the window */ }
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
      changed();
    }
    function exit() {
      target.classList.remove("map-fullscreen");
      if (nativeElement()) {
        var ex = document.exitFullscreen || document.webkitExitFullscreen;
        if (ex) { try { ex.call(document); } catch (e) { /* already leaving */ } }
      }
      changed();
    }
    function toggle() {
      if (target.classList.contains("map-fullscreen")) exit(); else enter();
    }

    button.addEventListener("click", toggle);
    // The browser left native full screen (Esc, F11, an OS gesture): drop the
    // class with it, or the map stays pinned over a page that is no longer
    // full screen.
    function onNativeChange() {
      if (!nativeElement() && target.classList.contains("map-fullscreen")) {
        target.classList.remove("map-fullscreen");
        changed();
      }
    }
    document.addEventListener("fullscreenchange", onNativeChange);
    document.addEventListener("webkitfullscreenchange", onNativeChange);
    // CSS-only mode (no native full screen to catch Esc for us). A modal or
    // slide-over open on top gets the Esc first: only leave when none is.
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape" || nativeElement() || !target.classList.contains("map-fullscreen")) return;
      if (document.querySelector(".modal-overlay.open, .slideover-overlay.open")) return;
      exit();
    });
    paint();
    return { toggle: toggle, isOn: function () { return target.classList.contains("map-fullscreen"); } };
  }

  window.PolarisMapFullscreen = { attach: attach, ICON_ENTER: ICON_ENTER, ICON_EXIT: ICON_EXIT };
})();
