// public/js/mobile/topology-tab.js — Mobile topology surface.
//
// Reached via the `topology/<siteId>` detail route from the Map tab's
// site bottom sheet. Lazy-loads Cytoscape + dagre + cytoscape-dagre on
// first open (~670KB combined, kept off the initial bundle so users
// who never open topology don't pay for it).
//
// It draws the SAME map as the desktop topology modal in /js/map.js: the
// left-to-right column solver at the desktop's spacing, the shared server
// layout the modal saves (the /topology payload's `savedLayouts.flat` —
// node positions plus the operator-drawn connection lines, `edgepath:`
// entries rendered view-only by topology-edge-editor.js), the location
// boxes and their gutter-routed links. It works held either way; the map is
// wide, so turning the phone sideways shows more of it, but nothing asks to.
//
// The site's saved views (Layer 2 / Topology / Room, business rule 147) are
// picked from a select under the bar. A Layer 2 view draws here, with its
// device types and its own saved layout; a Topology or Room view mounts the
// Device Map page's own canvas (topology-physical.js / topology-room.js),
// read-only, as the Device Map widget does. Top right of the map: a Legend
// button (the desktop's key) and an eye — a Layer 2 view's device types for
// this visit, a Topology view's "Show on the map" panel.
//
// Differences vs. the desktop modal:
//   - View only: no drag-to-reposition, no Edit mode, no layout save.
//   - No screenshot, no fullscreen toggle (the surface IS fullscreen).
//   - Node tap opens a bottom sheet instead of a right-rail info panel,
//     with a "View asset" action that pivots to the asset detail page.
//   - Search input is in the top app bar; result tap pulses + zooms.
//
// Element + stylesheet construction is shared with desktop via
// public/js/topology-render.js so a new node/edge type only needs to be
// added in one place.

(function () {
  // Module state. Reset on every render() so navigating in/out of the
  // topology surface doesn't leak the previous instance.
  var _cy = null;
  var _topoData = null;
  var _siteId = null;
  var _siteName = null;
  var _focusTerm = null;
  var _resizeHandler = null;
  var _themeObserver = null;
  var _searchDebounce = null;
  var _suggestState = { open: false, items: [], index: -1 };
  var _cyPromise = null;
  var _viewTouched = false; // the operator has panned / zoomed since the last fit
  var _edgeEditor = null;   // view-only drawer of the saved connection lines
  // The location view on screen — "flat" (Base, the whole site) or an area /
  // building / floor key from computeFloorViews: the desktop's drill-down
  // (map.js topoState.activeView). Every open starts on Base, as there.
  var _activeView = "flat";
  // A search hit that lives outside the view on screen: the view drops back
  // to Base and the layoutstop that follows centres this node.
  var _pendingFocusId = null;

  // The desktop modal's lattice (map.js TOPO_COL_SPACING / TOPO_ROW_SPACING).
  // Must match: the shared saved layout is in these coordinates, and a node
  // the layout has no entry for lands on this grid beside the saved ones.
  var TOPO_COL_SPACING = 130;
  var TOPO_ROW_SPACING = 130; // square since 2026-11-06 (was 95) — map.js

  // ─── Saved views (Layer 2 / Topology / Room) ───────────────────────────
  // The site's saved views (GET …/topology → views, business rule 147), as the
  // desktop's view menu and the Device Map widget offer them: a Layer 2 view
  // draws here with Cytoscape, a Topology view with the Device Map page's own
  // Leaflet canvas (topology-physical.js) and a Room view with
  // topology-room.js — both read-only, mounted the way the widget mounts them
  // (widgets/deviceMap.js → modeCtx / renderMode).
  var VIEW_MODE_LABELS = { layer2: "Layer 2", topology: "Topology", room: "Room" };
  var VIEW_MODE_ORDER = { layer2: 0, topology: 1, room: 2 };
  // The desktop's device types for a view that names none (map.js).
  var DEFAULT_SHOWN_TYPES = ["firewall", "router", "switch", "access_point"];
  var _siteViews = [];        // the site's views, Layer 2 first, then Topology, then Room
  var _siteViewId = null;     // the saved view on screen
  var _modeInst = null;       // a Topology / Room canvas, when that view is on screen
  var _modeViewId = null;     // the view _modeInst was drawn for
  // A Layer 2 view's device types as this visit toggled them (the eye panel):
  // view id → shown types. Like the desktop out of edit mode, the choice lasts
  // until the map closes and is never saved with the view.
  var _shownOverride = {};
  var _arcgisLegendHtml = ""; // the Topology canvas's ArcGIS key (ctx.setArcgisLegend)
  var _typesPanel = null;     // the Layer 2 eye's panel, when open
  var _hashHandler = null;
  var _modeLibs = null;
  // The canvases' scripts, in the widget's load order (deviceMap.js MODE_SCRIPTS).
  var MODE_SCRIPTS = [
    "/js/topology-device-list.js",
    "/js/cable-run-geometry.js",
    "/js/topology-arcgis-layers.js",
    "/js/topology-physical.js",
    "/js/topology-rack.js",
    "/js/topology-wall.js",
    "/js/topology-room.js",
  ];
  // The desktop's topology stylesheet. It also carries the desktop Device
  // Map's own marker, legend and popup rules, which would restyle the phone's
  // Map tab — so it is switched on only while this screen is showing
  // (setMapCss) and off again when the screen is left. mobile.css maps the
  // desktop tokens it reads onto the phone's palette.
  var MAP_CSS = "/css/map.css";

  function viewMode(v) { return v && VIEW_MODE_LABELS[v.mode] ? v.mode : "layer2"; }

  // Layer 2 first, then Topology, then Room; the site's own order within a
  // mode — the desktop's view menu order. Pure.
  function sortedViews(list) {
    return (Array.isArray(list) ? list : []).map(function (v, i) { return { v: v, i: i }; }).sort(function (a, b) {
      return VIEW_MODE_ORDER[viewMode(a.v)] - VIEW_MODE_ORDER[viewMode(b.v)] || a.i - b.i;
    }).map(function (x) { return x.v; });
  }

  // A view's TopologyLayout key for a location key (map.js → _viewScopedKey):
  // the default view keeps the bare keys, any other prefixes its id. Pure.
  function scopedLayoutKey(view, key) {
    if (!view || view.isDefault) return key;
    var prefix = "v:" + view.id;
    return key === "flat" ? prefix : prefix + "|" + key;
  }

  function currentSiteView() {
    for (var i = 0; i < _siteViews.length; i++) if (_siteViews[i].id === _siteViewId) return _siteViews[i];
    return null;
  }
  function curMode() { return viewMode(currentSiteView()); }

  // The device types a Layer 2 view draws (map.js → _effectiveShownTypes,
  // less the edit session): this visit's toggles, else the view's own list,
  // else the desktop default. Pure over its arguments.
  function effectiveShownTypes(view, override) {
    var o = override ? override[view ? view.id : ""] : null;
    if (Array.isArray(o)) return o;
    return view && Array.isArray(view.shownTypes) ? view.shownTypes : DEFAULT_SHOWN_TYPES;
  }

  // ─── Lazy loaders ──────────────────────────────────────────────────────
  // Inline-duplicated from map-tab.js to keep each tab module
  // self-contained. The two helpers are 7 lines combined; extracting them
  // would just create a coordination dependency for no real reuse benefit.
  function _loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var s = document.createElement("script");
      s.src = src;
      s.async = false;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error("Failed to load " + src)); };
      document.head.appendChild(s);
    });
  }

  function loadCytoscape() {
    if (window.cytoscape && window.cytoscapeDagre && window._cytoscapeDagreRegistered && window.PolarisTopologyEdgeEditor) {
      return Promise.resolve(window.cytoscape);
    }
    if (_cyPromise) return _cyPromise;
    _cyPromise = (async function () {
      await _loadScript("/js/vendor/cytoscape.min.js");
      await _loadScript("/js/vendor/dagre.min.js");
      await _loadScript("/js/vendor/cytoscape-dagre.js");
      // Draws the operator's connection lines from the saved layout.
      await _loadScript("/js/topology-edge-editor.js");
      if (window.cytoscape && window.cytoscape.use && window.cytoscapeDagre && !window._cytoscapeDagreRegistered) {
        window.cytoscape.use(window.cytoscapeDagre);
        window._cytoscapeDagreRegistered = true;
      }
      return window.cytoscape;
    })();
    return _cyPromise;
  }

  function _addLink(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    var l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = href;
    document.head.appendChild(l);
  }

  // The Topology / Room canvases: Leaflet (+ the cluster plugin the Topology
  // canvas groups a floor's devices with) and the canvas scripts. Loaded on
  // the first Topology or Room view, never for a Layer 2 one.
  function loadModeLibs() {
    if (_modeLibs) return _modeLibs;
    _addLink("/css/vendor/leaflet/leaflet.css");
    _addLink("/css/vendor/leaflet/MarkerCluster.css");
    _addLink("/css/vendor/leaflet/MarkerCluster.Default.css");
    _modeLibs = (async function () {
      await _loadScript("/js/vendor/leaflet/leaflet.js");
      await _loadScript("/js/vendor/leaflet/leaflet.markercluster.js");
      for (var i = 0; i < MODE_SCRIPTS.length; i++) await _loadScript(MODE_SCRIPTS[i]);
      if (window.L && window.L.Icon && window.L.Icon.Default) window.L.Icon.Default.imagePath = "/css/vendor/leaflet/images/";
    })().catch(function (err) {
      _modeLibs = null; // retry on the next pick
      throw err;
    });
    return _modeLibs;
  }

  // map.css on while this screen shows, off when it is left (see MAP_CSS).
  function setMapCss(on) {
    var l = document.querySelector('link[href="' + MAP_CSS + '"]');
    if (!l) {
      if (!on) return;
      l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = MAP_CSS;
      document.head.appendChild(l);
    }
    l.disabled = !on;
  }

  // ─── Detail spec ───────────────────────────────────────────────────────
  // Registered into window.PolarisDetails by details.js. parentTab "map"
  // keeps the Map nav-item highlighted while the operator is inside the
  // topology view.
  var Topology = {
    parentTab: "map",
    renderTopbar: function () {
      // Empty — the topology surface renders its own floating chrome
      // (close FAB + search bar) over the graph.
      return "";
    },
    render: function (body, ctx) {
      // Parse "topology/<siteId>?q=<focusTerm>". The router splits on "/"
      // but doesn't carve query strings off the trailing part, so
      // parts[0] arrives as "<siteId>?q=<focusTerm>" — strip it here.
      var rawId = (ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
      var qIdx  = rawId.indexOf("?");
      _siteId   = qIdx >= 0 ? rawId.slice(0, qIdx) : rawId;
      _siteName = null;
      _focusTerm = parseFocusTermFromHash();
      _activeView = "flat";
      _pendingFocusId = null;

      if (!_siteId) {
        body.innerHTML = '<div class="empty-state" style="padding-top:64px;"><div class="ttl">Missing site id</div></div>';
        return;
      }

      // Fullbleed mode hides the topbar and search slots so the topology
      // owns the screen above the navbar. The navbar stays (lit on Map), so
      // a nav tap can leave without closeTopology — see leftTopology().
      var appEl = document.getElementById("app");
      if (appEl) appEl.dataset.tab = "__fullbleed";

      body.innerHTML = ''
        + '<div class="topo-screen" id="topo-screen">'
        + '  <div class="topo-bar">'
        + '    <button class="icon-btn" id="topo-close" aria-label="Back to map"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
        + '    <div class="topo-search-wrap">'
        + '      <input type="search" class="topo-search" id="topo-search-input" placeholder="Search this site…" autocomplete="off" spellcheck="false">'
        + '      <ul class="topo-search-results" id="topo-search-results" role="listbox" hidden></ul>'
        + '    </div>'
        + '    <button class="icon-btn" id="topo-refresh" aria-label="Refresh topology"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        // The site's saved views, once it has more than one: a native select,
        // which a phone opens as its own picker (the widget's choice too).
        + '  <div class="topo-viewbar" id="topo-viewbar" hidden>'
        + '    <select class="topo-viewsel" id="topo-viewsel" aria-label="View"></select>'
        + '  </div>'
        + '  <div class="topo-views" id="topo-views" hidden></div>'
        + '  <div class="topo-stage" id="topo-stage">'
        + '    <div class="topo-graph" id="topo-graph"></div>'
        // The map's own tools, top right: the legend and the eye (what the
        // map shows), then a canvas's other view-mode buttons (a Room view's
        // zoom). Bottom left: the open legend.
        + '    <div class="topo-tools" id="topo-tools">'
        + '      <button type="button" class="topo-tool" id="topo-legend-btn" aria-label="Legend" title="Legend" aria-expanded="false" hidden>' + LEGEND_SVG + '</button>'
        + '      <button type="button" class="topo-tool" id="topo-eye-btn" aria-label="Show on the map" title="Show on the map" aria-expanded="false" hidden>' + EYE_SVG + '</button>'
        + '      <span class="topo-mode-tools" id="topo-mode-tools"></span>'
        + '    </div>'
        + '    <div class="topology-legend topo-legend" id="topo-legend" role="dialog" aria-label="Legend" hidden>'
        + '      <header class="topology-legend-header"><span class="topology-legend-title">Legend</span>'
        + '        <button type="button" class="topo-legend-close" id="topo-legend-close" aria-label="Close the legend"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button></header>'
        + '      <div class="topology-legend-body" id="topo-legend-body"></div>'
        + '    </div>'
        + '  </div>'
        + '  <div class="topo-status" id="topo-status">Loading topology…</div>'
        + '</div>';

      setMapCss(true);
      _siteViews = [];
      _siteViewId = null;
      _shownOverride = {};
      _arcgisLegendHtml = "";

      document.getElementById("topo-close").addEventListener("click", function () {
        closeTopology();
      });
      document.getElementById("topo-viewsel").addEventListener("change", function (e) {
        pickSiteView(e.target.value);
      });
      document.getElementById("topo-legend-btn").addEventListener("click", function () {
        setLegendOpen(document.getElementById("topo-legend").hidden);
      });
      document.getElementById("topo-legend-close").addEventListener("click", function () {
        setLegendOpen(false);
      });
      document.getElementById("topo-eye-btn").addEventListener("click", function (e) {
        onEye(e.currentTarget);
      });
      // The router has no leave hook: a hash change that took this screen
      // away (Back, the navbar) tears it down now — map.css with it, before
      // the Map tab paints under the desktop's marker rules.
      if (_hashHandler) window.removeEventListener("hashchange", _hashHandler);
      _hashHandler = function () {
        if (!/^#topology\//.test(window.location.hash || "")) teardownTopology();
      };
      window.addEventListener("hashchange", _hashHandler);

      document.getElementById("topo-refresh").addEventListener("click", function () {
        refreshTopology();
      });

      wireSearchInput(document.getElementById("topo-search-input"));

      // Resize handler — the virtual keyboard, and a turn of the phone either
      // way, change the container's shape. Re-fit on a resize until the
      // operator has moved the view themselves; after that only reflow,
      // never yank their view.
      if (_resizeHandler) window.removeEventListener("resize", _resizeHandler);
      _resizeHandler = function () {
        if (leftTopology()) return;
        fadeAllViewRows();
        if (!_cy) return;
        try { _cy.resize(); } catch (e) {}
        if (!_viewTouched && !_focusTerm) {
          try { _cy.fit(undefined, 30); } catch (e) {}
        }
      };
      window.addEventListener("resize", _resizeHandler);

      // Re-render the graph when the operator toggles theme via More
      // tab → Appearance while topology is open. The Cytoscape
      // stylesheet captures theme at render time, so a flip needs a
      // rebuild to swap text/edge colors. Mobile doesn't persist node
      // positions so the dagre re-layout is the right behavior here.
      if (_themeObserver) { try { _themeObserver.disconnect(); } catch (e) {} }
      _themeObserver = new MutationObserver(function (muts) {
        if (leftTopology()) return;
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].attributeName === "data-theme" && _topoData) {
            drawCurrent();
            break;
          }
        }
      });
      _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      loadCytoscape().then(function () {
        return api.map.topology(_siteId);
      }).then(function (data) {
        _topoData = data;
        _siteName = (data && data.fortigate && data.fortigate.hostname) || _siteName;
        settleSiteView(data);
        drawCurrent();
        setStatus("");
      }).catch(function (err) {
        setStatus("Failed to load topology: " + ((err && err.message) || err));
      });
    },
  };

  // ─── Hash parsing ─────────────────────────────────────────────────────
  // PolarisRouter's parse() splits on "/" but doesn't carve query strings
  // off the trailing part. Read the raw hash for the focus term so deep
  // links from global search can pre-aim the graph.
  function parseFocusTermFromHash() {
    var raw = window.location.hash || "";
    var qIdx = raw.indexOf("?");
    if (qIdx < 0) return null;
    var qs = raw.slice(qIdx + 1);
    var parts = qs.split("&");
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split("=");
      if (kv[0] === "q" && kv[1]) {
        try { return decodeURIComponent(kv[1]); } catch (e) { return kv[1]; }
      }
    }
    return null;
  }

  function setStatus(msg) {
    var el = document.getElementById("topo-status");
    if (el) {
      el.textContent = msg || "";
      el.style.display = msg ? "" : "none";
    }
  }

  // The router has no leave hook, and the navbar (or the back gesture) can
  // swap the topology out without closeTopology. The first resize or theme
  // change after that finds the screen gone and disposes the graph, rather
  // than keep refitting and re-rendering a detached Cytoscape.
  function leftTopology() {
    if (document.getElementById("topo-screen")) return false;
    teardownTopology();
    return true;
  }

  function closeTopology() {
    var siteId = _siteId;
    teardownTopology();
    // Hand off to the site sheet on the map. router.go restores app
    // dataset.tab and renders the map underneath.
    if (siteId) PolarisRouter.go("site/" + siteId);
    else PolarisRouter.go("map");
  }

  function teardownTopology() {
    closeTopologySheet();
    closeTopologySearchResults();
    closeTypesPanel();
    teardownMode();
    setMapCss(false);
    if (_hashHandler) {
      window.removeEventListener("hashchange", _hashHandler);
      _hashHandler = null;
    }
    if (_themeObserver) {
      try { _themeObserver.disconnect(); } catch (e) {}
      _themeObserver = null;
    }
    if (_resizeHandler) {
      window.removeEventListener("resize", _resizeHandler);
      _resizeHandler = null;
    }
    if (_cy) {
      try { _cy.destroy(); } catch (e) {}
      _cy = null;
      _edgeEditor = null;
    }
    _topoData = null;
    _siteViews = [];
    _siteViewId = null;
    _shownOverride = {};
    _siteId = null;
    _focusTerm = null;
    _activeView = "flat";
    _pendingFocusId = null;
  }

  // Re-fetch the topology payload and rebuild the graph in place. Mirrors
  // the desktop modal's refresh button (map.js refreshTopology): there are no
  // manual node positions to snapshot here (autoungrabify + no savedLayouts),
  // so it's a straight re-fetch → renderGraph. Guards against a double-tap by
  // disabling the button for the duration.
  function refreshTopology() {
    if (!_siteId) return;
    var btn = document.getElementById("topo-refresh");
    if (btn) btn.disabled = true;
    setStatus("Refreshing…");
    api.map.topology(_siteId).then(function (data) {
      _topoData = data;
      _siteName = (data && data.fortigate && data.fortigate.hostname) || _siteName;
      settleSiteView(data);
      drawCurrent();
      setStatus("");
    }).catch(function (err) {
      setStatus("Failed to refresh topology: " + ((err && err.message) || err));
    }).then(function () {
      if (btn) btn.disabled = false;
    });
  }

  // ─── Saved views: picker, dispatch, the Topology / Room canvases ───────
  // Feather's list and eye glyphs, in the tool button's colour.
  var LEGEND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="6" cy="6" r="2"/><line x1="11" y1="6" x2="21" y2="6"/><circle cx="6" cy="12" r="2"/><line x1="11" y1="12" x2="21" y2="12"/>' +
    '<circle cx="6" cy="18" r="2"/><line x1="11" y1="18" x2="21" y2="18"/></svg>';
  var EYE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

  // Every load: the site's views again, the one on screen kept while it
  // exists, else the site's default view, else its first.
  function settleSiteView(data) {
    _siteViews = sortedViews(data && data.views);
    var ok = function (id) { return !!id && _siteViews.some(function (v) { return v.id === id; }); };
    if (!ok(_siteViewId)) {
      var def = _siteViews.filter(function (v) { return v.isDefault; })[0];
      _siteViewId = def ? def.id : _siteViews.length ? _siteViews[0].id : null;
    }
    fillViewSel();
  }

  // The picker, grouped by mode like the desktop's view menu. Hidden while
  // the site has a single view.
  function fillViewSel() {
    var bar = document.getElementById("topo-viewbar");
    var sel = document.getElementById("topo-viewsel");
    if (!bar || !sel) return;
    sel.innerHTML = "";
    bar.hidden = _siteViews.length < 2;
    var groups = {};
    _siteViews.forEach(function (v) {
      var m = viewMode(v);
      if (!groups[m]) {
        groups[m] = document.createElement("optgroup");
        groups[m].label = VIEW_MODE_LABELS[m];
        sel.appendChild(groups[m]);
      }
      var o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.name;
      groups[m].appendChild(o);
    });
    if (_siteViewId) sel.value = _siteViewId;
  }

  function pickSiteView(id) {
    if (!_topoData || id === _siteViewId || !_siteViews.some(function (v) { return v.id === id; })) return;
    _siteViewId = id;
    _activeView = "flat";   // a view opens on its whole site, as on the desktop
    _focusTerm = null;
    _viewTouched = false;
    closeTopologySheet();
    closeTypesPanel();
    drawCurrent();
  }

  // Draw the view on screen: Layer 2 in Cytoscape, Topology / Room on its
  // canvas. The search box and the location chips are Layer 2's.
  function drawCurrent() {
    if (!_topoData) return;
    var mode = curMode();
    var input = document.getElementById("topo-search-input");
    if (input) {
      input.disabled = mode !== "layer2";
      input.placeholder = mode === "layer2" ? "Search this site…" : "Search works in Layer 2 views";
    }
    if (mode === "layer2") {
      teardownMode();
      renderGraph(_topoData);
      paintTools();
      return;
    }
    if (_cy) { try { _cy.destroy(); } catch (e) {} _cy = null; _edgeEditor = null; }
    var views = document.getElementById("topo-views");
    if (views) { views.innerHTML = ""; views.hidden = true; }
    var sv = currentSiteView();
    paintTools();
    setStatus(_modeInst ? "" : "Loading view…");
    loadModeLibs().then(function () {
      if (!_topoData || currentSiteView() !== sv) return;
      renderMode(sv);
      setStatus("");
    }).catch(function (err) {
      setStatus("This view could not be loaded: " + ((err && err.message) || err));
    });
  }

  function teardownMode() {
    if (!_modeInst) return;
    try { if (_modeInst.destroy) _modeInst.destroy(); } catch (e) { /* already gone */ }
    _modeInst = null;
    _modeViewId = null;
    _arcgisLegendHtml = "";
    var graph = document.getElementById("topo-graph");
    if (graph) graph.innerHTML = "";
    paintTools();
  }

  // The topology node a canvas means by an id: the Topology canvas passes a
  // node id, the Room canvas an asset id. Its data, or null.
  function nodeDataFor(id) {
    if (!id || !_topoData) return null;
    var els = window.PolarisTopologyRender.buildTopologyElements(_topoData);
    var hit = null;
    els.forEach(function (e) {
      var d = e && e.data;
      if (!hit && d && !d.source && (d.id === id || d.assetId === id)) hit = d;
    });
    return hit;
  }

  // A tap on a device on a canvas opens the node sheet the Layer 2 graph
  // opens, through a stand-in for the Cytoscape node it reads.
  function openCanvasDevice(id) {
    var d = nodeDataFor(id);
    if (!d) {
      if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(id);
      return;
    }
    var node = { id: function () { return d.id; }, data: function (k) { return d[k]; } };
    openNodeSheet(node, { kind: d.role || "unknown" });
  }

  // The canvas context: the Device Map widget's, read-only (deviceMap.js →
  // modeCtx). Nothing stages; placements come from the site's saved layouts
  // under the view's own keys.
  function modeCtx(v, initial) {
    function none() { return false; }
    function noop() {}
    var data = _topoData;
    var siteId = _siteId;
    return {
      data: data,
      view: v,
      siteId: siteId,
      editing: false,
      canEdit: false,
      initial: initial || null,
      shownTypes: Array.isArray(v.shownTypes) ? v.shownTypes : DEFAULT_SHOWN_TYPES,
      loadPlacements: function (layer) {
        var e = data.savedLayouts && data.savedLayouts[scopedLayoutKey(v, layer ? "topo|L" + layer : "topo")];
        return e && e.positions && typeof e.positions === "object" ? e.positions : {};
      },
      backgroundUrl: function (imageId) { return api.map.topologyBackgroundUrl(siteId, imageId); },
      fetchArcgisLayers: api.map.arcgisLayers ? function () { return api.map.arcgisLayers(); } : undefined,
      fetchArcgisFeatures: api.map.arcgisFeatures ? function (id, p) { return api.map.arcgisFeatures(id, p); } : undefined,
      fetchCableRunLinks: api.map.cableRunLinks ? function () { return api.map.cableRunLinks(siteId); } : undefined,
      // The ArcGIS layers on the map close the legend, as on the desktop.
      setArcgisLegend: function (html) { _arcgisLegendHtml = html || ""; fillLegend(); },
      stageViewPatch: none, stagedViewPatch: function () { return {}; }, stagePlacements: none,
      stageLocationCode: noop, stageCableRunLinks: none,
      refreshSidebar: noop, historyChanged: noop, historyPushed: noop, closePopovers: noop,
      placedElsewhere: function () { return null; },
      selectAsset: function (id) { if (id) openCanvasDevice(id); },
      selectedId: function () { return null; },
      listViews: function () { return _siteViews; },
      openView: function (id) { pickSiteView(id); },
      linkTip: { show: noop, move: noop, hide: noop },
      openAsset: function (id) { if (id) openCanvasDevice(id); },
      toast: function (m, k) { if (window.PolarisTabs && PolarisTabs.showSnackbar) PolarisTabs.showSnackbar(m, { error: k === "error" }); },
    };
  }

  function renderMode(v) {
    var mod = viewMode(v) === "topology" ? window.PolarisTopologyPhysical : window.PolarisTopologyRoom;
    // A refresh or a theme change keeps the floor, centre, zoom and basemap.
    var initial = _modeInst && _modeViewId === v.id && _modeInst.viewState ? _modeInst.viewState() : null;
    teardownMode();
    var graph = document.getElementById("topo-graph");
    if (!graph) return;
    if (!mod || typeof mod.render !== "function") {
      setStatus("This view could not be drawn.");
      return;
    }
    var host = document.createElement("div");
    host.className = "topology-mode-canvas topo-mode-canvas";
    graph.appendChild(host);
    _modeInst = mod.render(host, modeCtx(v, initial));
    _modeViewId = v.id;
    paintTools();
    // The re-mount closed the eye's panel: reopen it where it was open.
    var eye = document.getElementById("topo-eye-btn");
    if (initial && initial.visOpen && eye && !eye.hidden) onEye(eye);
  }

  // The canvas's view-mode buttons (cornerButtons, not editOnly): the eye
  // ("Show on the map") on a Topology view, zoom on a Room view's boxes.
  function canvasButtons() {
    if (!_modeInst || typeof _modeInst.cornerButtons !== "function") return [];
    return _modeInst.cornerButtons().filter(function (b) { return !b.editOnly && typeof b.onClick === "function"; });
  }

  // Which tools the view on screen offers: Layer 2 a legend and a device-type
  // eye; Topology a legend and its canvas's eye; Room its canvas's buttons
  // (no legend — racks and boxes draw no links or health key).
  function paintTools() {
    var mode = curMode();
    var legendBtn = document.getElementById("topo-legend-btn");
    var eyeBtn = document.getElementById("topo-eye-btn");
    var extra = document.getElementById("topo-mode-tools");
    if (!legendBtn || !eyeBtn || !extra) return;
    var btns = canvasButtons();
    var eyeOf = btns.filter(function (b) { return b.id === "topology-visibility"; })[0];
    legendBtn.hidden = mode === "room";
    eyeBtn.hidden = mode === "room" || (mode === "topology" && !eyeOf);
    // Closed on a Room view, reopened on the next view that has a key if the
    // viewer left it open — without storing the forced close.
    setLegendOpen(mode !== "room" && legendWasOpen(), true);
    extra.innerHTML = "";
    btns.filter(function (b) { return b !== eyeOf; }).forEach(function (b) {
      var el = document.createElement("button");
      el.type = "button";
      el.className = "topo-tool";
      el.title = b.label;
      el.setAttribute("aria-label", b.label);
      el.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + b.icon + "</svg>";
      el.addEventListener("click", function () { b.onClick(el); });
      extra.appendChild(el);
    });
    fillLegend();
  }

  // ─── Legend ───────────────────────────────────────────────────────────
  // The Device Map's key (topology-render.js topologyLegendSpec /
  // topologyLegendHtml — the desktop modal's and the widget's), less
  // "Endpoint", which only the desktop's endpoint search draws; on a Topology
  // view the ArcGIS layers on the map follow it. Open or closed is per
  // viewer, best-effort storage.
  var LEGEND_KEY = "polaris.mobile.topologyLegend";
  function legendHtml() {
    var R = window.PolarisTopologyRender;
    if (!R || !R.topologyLegendSpec || !R.topologyLegendHtml) return "";
    var theme = window.PolarisTheme ? PolarisTheme.get() : "dark";
    var spec = R.topologyLegendSpec(theme);
    if (!spec) return "";
    spec = Object.assign({}, spec, {
      nodes: (spec.nodes || []).filter(function (n) { return n.label !== "Endpoint"; }),
    });
    var html = R.topologyLegendHtml(spec);
    if (curMode() === "topology" && _arcgisLegendHtml) html += '<div class="topology-legend-arcgis">' + _arcgisLegendHtml + "</div>";
    return html;
  }
  function fillLegend() {
    var body = document.getElementById("topo-legend-body");
    if (!body) return;
    body.innerHTML = curMode() === "room" ? "" : legendHtml();
  }
  // quiet: a state the screen sets for itself, not the viewer's choice — it
  // is not stored.
  function setLegendOpen(open, quiet) {
    var el = document.getElementById("topo-legend");
    var btn = document.getElementById("topo-legend-btn");
    if (!el) return;
    open = !!open && !(btn && btn.hidden);
    if (open) fillLegend();
    el.hidden = !open;
    if (btn) {
      btn.classList.toggle("is-active", open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    if (quiet) return;
    try { localStorage.setItem(LEGEND_KEY, open ? "1" : "0"); } catch (e) { /* storage off */ }
  }
  function legendWasOpen() {
    try { return localStorage.getItem(LEGEND_KEY) === "1"; } catch (e) { return false; }
  }

  // ─── The eye: what the map shows ──────────────────────────────────────
  // Topology: the canvas's own "Show on the map" panel (devices, groups,
  // connections, ArcGIS layers and their labels — this browser's choice).
  // Layer 2: the desktop sidebar's Device types icons, for this visit only.
  function onEye(btn) {
    var mode = curMode();
    if (mode === "topology") {
      var eye = canvasButtons().filter(function (b) { return b.id === "topology-visibility"; })[0];
      if (!eye) return;
      eye.onClick(btn);
      fitPanelBelow(document.querySelector(".topo-vis-panel"), btn);
      return;
    }
    if (mode === "layer2") {
      if (_typesPanel) closeTypesPanel(); else openTypesPanel(btn);
    }
  }

  // The canvas places its panel beside the button (left of it, top-aligned):
  // keep it on the screen, scrolling inside above the navbar.
  function fitPanelBelow(el, btn) {
    if (!el || !btn) return;
    var stage = document.getElementById("topo-stage");
    var r = btn.getBoundingClientRect();
    var bottom = stage ? stage.getBoundingClientRect().bottom : window.innerHeight;
    el.style.maxHeight = Math.max(120, bottom - Math.max(8, r.top) - 8) + "px";
    el.style.maxWidth = Math.max(180, r.left - 16) + "px";
  }

  function typesPanelHtml() {
    var R = window.PolarisTopologyRender;
    var types = R && R.siteDeviceTypes ? R.siteDeviceTypes(_topoData) : [];
    var shown = {};
    effectiveShownTypes(currentSiteView(), _shownOverride).forEach(function (t) { shown[t] = true; });
    shown.firewall = true;
    var icons = types.map(function (t) {
      var on = !!shown[t.type];
      var locked = t.type === "firewall";
      var word = typeWord(t.type);
      var tip = word + " (" + t.count + ") — " + (locked ? "always shown, the site's root" : on ? "shown; tap to hide" : "hidden; tap to show");
      return '<button type="button" class="topology-type-icon' + (on ? " is-on" : "") + '" data-topo-type="' + escapeHtml(t.type) + '"' +
        ' aria-pressed="' + (on ? "true" : "false") + '" aria-label="' + escapeHtml(tip) + '" title="' + escapeHtml(tip) + '"' +
        (locked ? " disabled" : "") + ">" + R.typeIconSvg(t.type, 18) +
        '<span class="topology-type-icon-count" aria-hidden="true">' + t.count + "</span></button>";
    }).join("");
    return '<div class="dropdown-heading">Device types</div>' +
      (icons ? '<div class="topology-type-icons" role="group" aria-label="Device types to show">' + icons + "</div>"
        : '<p class="topo-vis-hint topo-vis-note">No devices on this site yet.</p>') +
      '<p class="topo-vis-hint topo-vis-note">Shown until you leave the map. Edit the view on the desktop to save them with it.</p>';
  }
  // A type's name for the tooltip, as the desktop words it (map.js
  // DEVICE_TYPE_LABELS / _deviceTypeLabel).
  var DEVICE_TYPE_LABELS = {
    firewall: "Firewalls", router: "Routers", switch: "Switches", access_point: "Access points",
    server: "Servers", workstation: "Workstations", printer: "Printers", other: "Other",
    hypervisor: "Hypervisors", container: "Containers", kubernetes_cluster: "Kubernetes clusters",
  };
  function typeWord(type) {
    if (DEVICE_TYPE_LABELS[type]) return DEVICE_TYPE_LABELS[type];
    var s = String(type || "device").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function openTypesPanel(btn) {
    closeTypesPanel();
    var el = document.createElement("div");
    el.className = "btn-dropdown-menu open topo-vis-panel topo-types-panel";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Device types");
    el.innerHTML = typesPanelHtml();
    document.body.appendChild(el);
    var r = btn.getBoundingClientRect();
    el.style.top = Math.max(8, r.top) + "px";
    el.style.right = Math.max(8, window.innerWidth - r.left + 8) + "px";
    fitPanelBelow(el, btn);
    _typesPanel = { el: el, btn: btn, outside: null };
    btn.classList.add("is-active");
    btn.setAttribute("aria-expanded", "true");
    el.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-topo-type]");
      if (!b || b.disabled) return;
      toggleShownType(b.getAttribute("data-topo-type"));
      el.innerHTML = typesPanelHtml();
    });
    var outside = function (e) {
      if (!_typesPanel || el.contains(e.target) || btn.contains(e.target)) return;
      closeTypesPanel();
    };
    _typesPanel.outside = outside;
    setTimeout(function () { if (_typesPanel && _typesPanel.el === el) document.addEventListener("pointerdown", outside, true); }, 0);
  }

  function closeTypesPanel() {
    if (!_typesPanel) return;
    if (_typesPanel.outside) document.removeEventListener("pointerdown", _typesPanel.outside, true);
    if (_typesPanel.el.parentNode) _typesPanel.el.parentNode.removeChild(_typesPanel.el);
    _typesPanel.btn.classList.remove("is-active");
    _typesPanel.btn.setAttribute("aria-expanded", "false");
    _typesPanel = null;
  }

  // Show or hide one device type on the Layer 2 view (the FortiGate is the
  // root and stays). Pure over its arguments: the next shown list.
  function nextShownTypes(current, type) {
    var next = (current || []).slice();
    if (!type || type === "firewall") return next;
    var at = next.indexOf(type);
    if (at === -1) next.push(type); else next.splice(at, 1);
    return next;
  }
  function toggleShownType(type) {
    var sv = currentSiteView();
    var key = sv ? sv.id : "";
    _shownOverride[key] = nextShownTypes(effectiveShownTypes(sv, _shownOverride), type);
    renderGraph(_topoData);
  }

  // ─── Graph render ─────────────────────────────────────────────────────
  function renderGraph(data) {
    // The Layer 2 view on screen: its device types (business rule 147 — the
    // desktop draws only the types the view shows) and its own saved layouts.
    var sv = currentSiteView();
    var elements = window.PolarisTopologyRender.buildTopologyElements(data, {
      shownTypes: effectiveShownTypes(sv, _shownOverride),
    });

    // Inherit the page-wide theme — its FAMILY, since topologyStylesheet
    // branches on `theme === "dark"` and there is one palette per family.
    var theme = window.PolarisTheme ? PolarisTheme.get() : "dark";

    if (_cy) {
      try { _cy.destroy(); } catch (e) {}
      _cy = null;
      _edgeEditor = null;
    }

    // Edges need both ends present — a dangling reference throws in
    // Cytoscape and kills the whole render (the desktop filters the same way).
    var nodeIds = {};
    elements.forEach(function (el) {
      var d = el && el.data;
      if (d && d.id && !d.source) nodeIds[d.id] = true;
    });
    elements = elements.filter(function (el) {
      var d = el && el.data;
      if (!d) return false;
      if (d.source && d.target) return !!(nodeIds[d.source] && nodeIds[d.target]);
      return true;
    });

    // Location views — the desktop's drill-down (map.js renderTopologyGraph):
    // the views this payload offers (none unless a device carries a b: or f:
    // code), a view a refresh took away falling back to Base, the chip rows,
    // and the graph cut down to the view on screen — its devices, the
    // FortiGate as a root portal, and portal stubs where a link leaves it.
    var views = window.PolarisTopologyRender.computeFloorViews(elements);
    if (_activeView !== "flat" && !views.some(function (v) { return v.key === _activeView; })) {
      _activeView = "flat";
    }
    renderViewRows(views);
    if (_activeView !== "flat") {
      elements = window.PolarisTopologyRender.partitionElementsForFloor(elements, _activeView);
    }

    // The desktop's layout for this view: the shared server layout an
    // operator saved under the view's key, laid over the column solver's
    // baseline (a node the save has no entry for keeps its solver cell).
    // Desktop's per-browser localStorage fallback is not read — it belongs to
    // the desktop browser that made it.
    var layouts = data && data.savedLayouts;
    var layoutKey = scopedLayoutKey(sv, _activeView);
    var saved = layouts && layouts[layoutKey] && layouts[layoutKey].positions;
    var savedPositions = saved && typeof saved === "object" ? saved : null;

    // Deterministic column layout (shared solver with desktop), left to
    // right: depth → x, lane → y, at the desktop's spacing. Location-coded
    // sites use the quotient (grouped-box) layout; untagged sites fall
    // through to the flat column solver; no firewall root → dagre LR.
    // Laid out for the phone's graph pane: a portrait screen gets a tall map.
    var columns = window.PolarisTopologyRender.computeGroupedLayout(elements, {
      aspect: window.PolarisTopologyRender.layoutAspect(document.getElementById("topo-graph")),
    }) ||
      window.PolarisTopologyRender.computeTopologyColumns(elements);
    var layoutConfig;
    if (columns) {
      var positions = {};
      Object.keys(columns).forEach(function (id) {
        positions[id] = { x: columns[id].depth * TOPO_COL_SPACING, y: columns[id].lane * TOPO_ROW_SPACING };
      });
      layoutConfig = { name: "preset", positions: positions, fit: false, padding: 30 };
    } else {
      layoutConfig = {
        name: "dagre",
        rankDir: "LR",
        nodeSep: 30,
        rankSep: 160,
        fit: false, // fitted (or focused) in the layoutstop handler
        padding: 30,
      };
    }

    _cy = window.cytoscape({
      container: document.getElementById("topo-graph"),
      elements: elements,
      // Mobile users don't shift+drag — disable box-select to keep tap
      // targets crisp. Pinch-zoom + two-finger pan come for free.
      boxSelectionEnabled: false,
      autoungrabify: true, // nodes stay where the layout placed them; no manual drag
      // Match desktop's damped wheel zoom (mostly trackpads here).
      wheelSensitivity: 0.2,
      // NOTE: the layout is NOT passed here — it's run explicitly below via
      // .layout().run() so the layoutstop listener is registered first. A
      // `preset` layout (location-coded sites) runs SYNCHRONOUSLY, so if it
      // rode the constructor it would emit layoutstop during construction —
      // before the handler on the next lines attaches — silently dropping the
      // grouping-hull render + initial focus. Same hazard the desktop modal
      // documents in map.js (register listener before running the layout).
      // includeEndpointOverlay registers the .dimmed (display:none) and
      // synthetic-endpoint round-rectangle styles used by the connection-path
      // overlay when the operator deep-links here via global search on a
      // workstation. Without it, dimming has no visual effect on mobile and
      // the synthetic endpoint node renders with the default fortinetNode
      // styling (wrong shape + color).
      style: window.PolarisTopologyRender.topologyStylesheet(theme, { includeEndpointOverlay: true }),
    });

    // Registered BEFORE .layout().run() below (see the constructor note).
    //  - The saved positions, then the location grouping hulls (building /
    //    floor / room / jb shapes from a:/b:/f:/r:/jb: codes) around them,
    //    the gutter routing of cross-box links, and the operator-drawn
    //    connection lines last — the order the desktop modal applies them
    //    in, so a customised line keeps the routed shape it was drawn on.
    //    Nodes are ungrabbable here, so the layout is final once it stops.
    //  - Initial view: the whole graph, as the desktop opens it — or the
    //    searched node when the URL carries ?q=<term>.
    _cy.one("layoutstop", function () {
      // The desktop's saved spots (pinned: the box-overlap push leaves them),
      // and a device the save has none for placed beside its saved parent —
      // the same helper the desktop map uses.
      var applied = window.PolarisTopologyRender.applySavedPositions(_cy, savedPositions, elements);
      var suppress = locSuppressKinds();
      window.PolarisTopologyRender.renderLocationGroups(_cy, {
        suppressKinds: suppress || undefined,
        fixedIds: applied.pinned,
      });
      // Cross-box links through the gutters, and any straight link bent
      // around a device it would pass through — with or without boxes.
      window.PolarisTopologyRender.routeInterGroupEdges(_cy);
      if (window.PolarisTopologyEdgeEditor) {
        _edgeEditor = window.PolarisTopologyEdgeEditor.attach(_cy, {
          positions: savedPositions,
          isEditable: function () { return false; },
        });
      }
      applyInitialFocus();
    });

    // Any touch on the graph means the operator is steering the view now —
    // stop re-fitting it on resize (see _resizeHandler).
    _viewTouched = false;
    _cy.on("tapstart", function () { _viewTouched = true; });
    _cy.on("scrollzoom", function () { _viewTouched = true; });

    // Nothing is editable on the phone, so a one-finger drag anywhere pans
    // the map. Cytoscape only pans a drag that starts on empty background or
    // on a `pannable` element — without this, a drag that lands on a
    // location-group hull (which fills most of a grouped site) or a device
    // does nothing. Hulls are added later (layoutstop, re-renders), hence
    // the add listener. Taps still fire on pannable nodes.
    _cy.nodes().panify();
    _cy.on("add", "node", function (evt) { evt.target.panify(); });

    // Tap a node → bottom sheet with details. Skip ghost LLDP nodes for
    // the no-action case (they render but have no Polaris asset linkage).
    _cy.on("tap", "node", function (evt) {
      var node = evt.target;
      if (node.data("isLocGroup")) return; // location hull — not a device
      if (node.data("isPortal")) {
        // A link leaving this view: jump to the view at its far end.
        var target = node.data("targetView");
        if (target) setView(target);
        return;
      }
      var role = node.data("role");
      if (role === "lldp") {
        // Still show a sheet with what we know — chassisId / mgmt IP /
        // system name — just no "View asset" button.
        openNodeSheet(node, { kind: "lldp" });
        return;
      }
      openNodeSheet(node, { kind: role || "unknown" });
    });

    // Run the layout now that the layoutstop listener is attached. preset
    // (location-coded / firewall-rooted sites) is synchronous; dagre (no
    // firewall root) is async — either way the handler above catches it.
    // Fan-out links route orthogonally, exactly as on the desktop (map.js).
    if (columns) {
      window.PolarisTopologyRender.markFanOutEdges(_cy, columns, {
        colSpacing: TOPO_COL_SPACING,
        orientation: "horizontal",
      });
    }
    // Port labels on bent links sit on their end legs (see topology-render.js).
    window.PolarisTopologyRender.wireBentEdgeLabels(_cy);
    _cy.layout(layoutConfig).run();
  }

  function applyInitialFocus() {
    if (!_cy) return;
    if (_pendingFocusId) {
      var hit = _cy.getElementById(_pendingFocusId);
      _pendingFocusId = null;
      try { _cy.fit(undefined, 30); } catch (e) {}
      if (hit && hit.length > 0) pulseAt(hit, 1.5);
      return;
    }
    var node = _focusTerm ? pickFocusNode(_focusTerm) : null;
    if (!node || node.length === 0) {
      try { _cy.fit(undefined, 30); } catch (e) {}
      return;
    }
    try {
      _cy.animate({
        center: { eles: node },
        zoom: 1.3,
        duration: 400,
      });
    } catch (e) { /* fall through — single-node graph or animation error */ }
    node.addClass("topology-pulse");
    setTimeout(function () {
      try { node.removeClass("topology-pulse"); } catch (e) {}
    }, 1800);

    // Deep-link case: when ?q= came in via URL, also fire the authoritative
    // topology search so endpoints (which aren't graph nodes — they nest
    // under switches) resolve to their parent switch via the backend's
    // `switchId` field, and then overlay the asset's connection path so
    // the operator sees endpoint→switch→firewall instead of the whole
    // site graph. Mirrors the desktop search → handleTopologySearchPick
    // flow.
    if (_focusTerm) {
      api.map.topologySearch(_siteId, _focusTerm).then(function (resp) {
        var hits = (resp && resp.results) || [];
        if (hits.length === 0) return;
        var first = hits[0];
        if (first.switchId) {
          var switchNode = _cy.getElementById(first.switchId);
          if (switchNode && switchNode.length > 0) {
            try { _cy.animate({ center: { eles: switchNode }, zoom: 1.3, duration: 350 }); } catch (e) {}
            switchNode.addClass("topology-pulse");
            setTimeout(function () { try { switchNode.removeClass("topology-pulse"); } catch (e) {} }, 1500);
          }
        }
        if (first.id) {
          api.assets.connectionPath(first.id).then(function (path) {
            if (path) applyConnectionPathOverlay(path);
          }).catch(function () { /* best-effort */ });
        }
      }).catch(function () { /* best-effort — silent on failure */ });
    }
  }

  // Overlay a focused endpoint→firewall connection path on top of the live
  // Cytoscape graph: dim everything off-path, add the endpoint as a synthetic
  // node when it's not already in the graph (endpoints don't ride along in
  // the standard topology response), and flatten the path onto one row so
  // it reads at a glance, as the desktop modal does. Mobile
  // doesn't persist node positions (autoungrabify + no localStorage save),
  // so there's no "restore" path needed — closing the topology tears down
  // the cyInstance, and the operator re-opens fresh.
  function applyConnectionPathOverlay(path) {
    if (!_cy || !path || !path.asset || !Array.isArray(path.hops) || path.hops.length === 0) return;
    var ep = path.asset;
    var leaf = path.hops[0];
    var nextHop = path.hops[1];
    var syntheticEdgeId = null;

    var alreadyOnGraph = _cy.getElementById(ep.id).length > 0;
    if (!alreadyOnGraph && leaf.kind === "endpoint") {
      _cy.add({
        group: "nodes",
        data: {
          id: ep.id,
          label: ep.hostname || ep.ipAddress || "endpoint",
          role: "endpoint",
          nodeColor: window.PolarisTopologyRender.endpointNodeColor(leaf),
          synthetic: 1,
        },
      });
      if (nextHop && _cy.getElementById(nextHop.id).length > 0) {
        syntheticEdgeId = "ep-edge-" + ep.id;
        _cy.add({
          group: "edges",
          data: {
            id: syntheticEdgeId,
            source: ep.id,
            target: nextHop.id,
            label: nextHop.endpointPort ? "port " + nextHop.endpointPort : "",
            synthetic: 1,
          },
        });
      }
    }

    var pathNodeIds = path.hops.map(function (h) { return h.id; });
    var pathElements = _cy.collection();
    pathNodeIds.forEach(function (id) {
      var n = _cy.getElementById(id);
      if (n.length > 0) pathElements = pathElements.union(n);
    });
    if (syntheticEdgeId) {
      var syn = _cy.getElementById(syntheticEdgeId);
      if (syn.length > 0) pathElements = pathElements.union(syn);
    }
    _cy.edges().forEach(function (e) {
      var s = e.data("source");
      var t = e.data("target");
      if (pathNodeIds.indexOf(s) !== -1 && pathNodeIds.indexOf(t) !== -1) {
        pathElements = pathElements.union(e);
      }
    });

    _cy.elements().not(pathElements).addClass("dimmed");

    // Flatten the path onto one row, as the desktop modal does: real nodes
    // keep their column x, the synthetic endpoint lands one column further
    // from the firewall than its switch (right of a verified switch, left of
    // a FortiLink-fallback one at a negative column).
    pathNodeIds.forEach(function (id) {
      var n = _cy.getElementById(id);
      if (n.length > 0) n.position("y", 0);
    });
    var epNode = _cy.getElementById(ep.id);
    if (nextHop && epNode.length > 0 && epNode.data("synthetic")) {
      var hopNode = _cy.getElementById(nextHop.id);
      if (hopNode.length > 0) {
        var hopX = hopNode.position().x;
        epNode.position({ x: hopX + (hopX < 0 ? -1 : 1) * TOPO_COL_SPACING, y: 0 });
      }
    }
    // Drawn paths are anchored to the full-site layout; the chain would
    // stretch them across the canvas, so they step aside. Closing the
    // topology tears the graph down, so nothing has to bring them back.
    if (_edgeEditor) _edgeEditor.setSuspended(true);

    try {
      _cy.animate({ fit: { eles: pathElements, padding: 40 }, duration: 350 });
    } catch (e) { /* fit may fail on single-node paths */ }
  }

  // Pick the node to focus on initial render. No focusTerm → FortiGate.
  // Otherwise case-insensitive substring match across hostname / IP / MAC,
  // first hit wins. Returns Cytoscape collection (possibly empty).
  function pickFocusNode(focusTerm) {
    if (!_cy || !_topoData) return null;
    var fgNode = _cy.getElementById((_topoData.fortigate && _topoData.fortigate.id) || "");
    if (!focusTerm) return fgNode;

    var term = focusTerm.toLowerCase();
    var match = null;
    _cy.nodes().forEach(function (n) {
      if (match) return;
      var label = (n.data("label") || "").toLowerCase();
      if (label.indexOf(term) !== -1) match = n;
    });
    if (match) return match;

    // No node-level hit — see if it matches an endpoint nested under a
    // switch. Endpoints aren't graph nodes; their parent switch is.
    var sw = (_topoData.switches || []).find(function (s) {
      return (s.endpoints || []).some(function (ep) {
        var ip   = (ep.ipAddress || "").toLowerCase();
        var mac  = (ep.macAddress || "").toLowerCase();
        var host = (ep.hostname || "").toLowerCase();
        var who  = (ep.assignedTo || "").toLowerCase();
        return ip.indexOf(term) !== -1 || mac.indexOf(term) !== -1 || host.indexOf(term) !== -1 || who.indexOf(term) !== -1;
      });
    });
    if (sw) return _cy.getElementById(sw.id);

    return fgNode;
  }

  // ─── Search input ─────────────────────────────────────────────────────
  function wireSearchInput(input) {
    if (!input) return;
    input.addEventListener("input", function () {
      if (_searchDebounce) { clearTimeout(_searchDebounce); _searchDebounce = null; }
      var q = input.value.trim();
      if (!q) { closeTopologySearchResults(); return; }
      _searchDebounce = setTimeout(function () { runTopologySearch(q); }, 200);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeTopologySearchResults(); input.blur(); }
    });
    document.addEventListener("click", function (e) {
      var box = document.getElementById("topo-search-results");
      if (!box) return;
      if (e.target === input || (box.contains && box.contains(e.target))) return;
      closeTopologySearchResults();
    });
  }

  async function runTopologySearch(q) {
    if (!_siteId) return;
    try {
      var resp = await api.map.topologySearch(_siteId, q);
      _suggestState.items = (resp && resp.results) || [];
      _suggestState.open = true;
      paintSearchResults();
    } catch (err) {
      _suggestState.items = [];
      _suggestState.open = true;
      paintSearchResults();
    }
  }

  function paintSearchResults() {
    var box = document.getElementById("topo-search-results");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = !_suggestState.open;
    if (!_suggestState.open) return;
    if (_suggestState.items.length === 0) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No matches in this site.";
      box.appendChild(li);
      return;
    }
    _suggestState.items.forEach(function (item) {
      var li = document.createElement("li");
      var primary = item.hostname || item.ipAddress || item.macAddress || "(unnamed)";
      var bits = [];
      if (item.ipAddress)  bits.push(item.ipAddress);
      if (item.macAddress) bits.push(item.macAddress);
      if (item.assignedTo) bits.push(item.assignedTo);
      bits.push((item.switchHostname || "?") + (item.port ? "/" + item.port : ""));
      li.innerHTML =
        '<div>' + escapeHtml(primary) + '</div>' +
        '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span>';
      li.addEventListener("mousedown", function (e) {
        e.preventDefault();
        handleSearchPick(item);
      });
      box.appendChild(li);
    });
  }

  function handleSearchPick(item) {
    closeTopologySearchResults();
    var input = document.getElementById("topo-search-input");
    if (input) input.value = "";
    if (!_cy || !item.switchId) return;
    var node = _cy.getElementById(item.switchId);
    if ((!node || node.length === 0) && _activeView !== "flat") {
      // The hit lives outside the view on screen. The desktop leaves that
      // pick doing nothing; on the phone, with no room to see why, drop back
      // to Base and centre it there (applyInitialFocus).
      _pendingFocusId = item.switchId;
      setView("flat");
      _viewTouched = true;
      return;
    }
    _viewTouched = true; // the view is aimed at a pick now — a resize must not re-fit it away
    if (node && node.length > 0) pulseAt(node, 1.5);
  }

  function pulseAt(node, zoom) {
    try { _cy.animate({ center: { eles: node }, zoom: zoom, duration: 350 }); } catch (e) {}
    node.addClass("topology-pulse");
    setTimeout(function () { try { node.removeClass("topology-pulse"); } catch (e) {} }, 1500);
  }

  // ─── Location views (drill-down) ──────────────────────────────────────
  // The desktop's switcher (map.js _renderTopologyFloorViews), as chip rows
  // under the search bar: one row per level of the drill-down — the areas
  // (plus area-less buildings), then the selected area's buildings, then the
  // selected building's floors; every chip on the selected path lit. Base
  // rides at the head of the first row rather than alone on a row of its
  // own, which a phone has no height to spare for. A row too long for the
  // screen scrolls sideways with no scrollbar, and a chip the edge cuts
  // fades as a whole — its opacity the share of it still showing — as the
  // desktop's tab strips do (folder-tabs.js _layoutStrip).
  function setView(key) {
    if (!key || key === _activeView || !_topoData) return;
    _activeView = key;
    _focusTerm = null;     // the deep link was for the view it opened on
    _viewTouched = false;  // a new view opens fitted, and refits on a turn
    closeTopologySheet();
    renderGraph(_topoData);
  }

  // Which box levels the view on screen already IS (map.js _locSuppressKinds):
  // its own level and every level above it. Null on Base.
  function locSuppressKinds() {
    return window.PolarisTopologyRender.viewSuppressKinds(_activeView || "flat");
  }

  // viewSwitcherRows with Base folded into the first row. Pure.
  function viewChipRows(views, activeKey) {
    var rows = window.PolarisTopologyRender.viewSwitcherRows(views, activeKey);
    if (rows.length > 1) rows = [rows[0].concat(rows[1])].concat(rows.slice(2));
    return rows;
  }

  function renderViewRows(views) {
    var wrap = document.getElementById("topo-views");
    if (!wrap) return;
    wrap.innerHTML = "";
    if (!views || views.length === 0) { wrap.hidden = true; return; }
    viewChipRows(views, _activeView).forEach(function (chips, depth) {
      var row = document.createElement("div");
      row.className = "topo-view-row" + (depth ? " topo-view-row-depth-" + depth : "");
      chips.forEach(function (c) {
        var chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip topo-view-chip" + (c.active ? " selected" : "");
        chip.setAttribute("aria-pressed", c.active ? "true" : "false");
        chip.title = c.title;
        chip.textContent = c.label;
        chip.addEventListener("click", function () { setView(c.key); });
        row.appendChild(chip);
      });
      var queued = false;
      row.addEventListener("scroll", function () {
        if (queued) return;
        queued = true;
        (window.requestAnimationFrame || setTimeout)(function () { queued = false; fadeViewRow(row); });
      }, { passive: true });
      wrap.appendChild(row);
    });
    wrap.hidden = false;
    Array.prototype.forEach.call(wrap.children, function (row) {
      revealSelectedChip(row);
      fadeViewRow(row);
    });
  }

  // Scroll a row so its lit chip shows whole (a deep selection can sit past
  // the right edge of a long row).
  function revealSelectedChip(row) {
    var sel = row.querySelector(".topo-view-chip.selected");
    if (!sel) return;
    var r = row.getBoundingClientRect();
    var b = sel.getBoundingClientRect();
    if (b.left < r.left) row.scrollLeft -= (r.left - b.left) + 12;
    else if (b.right > r.right) row.scrollLeft += (b.right - r.right) + 12;
  }

  // A chip the row's edge cuts fades as a whole, its opacity the share of it
  // still inside; whole chips carry no opacity of their own.
  function fadeViewRow(row) {
    var r = row.getBoundingClientRect();
    Array.prototype.forEach.call(row.children, function (chip) {
      var b = chip.getBoundingClientRect();
      var inside = Math.min(b.right, r.right) - Math.max(b.left, r.left);
      chip.style.opacity = inside > 0.5 && inside < b.width - 0.5 ? (inside / b.width).toFixed(3) : "";
    });
  }

  function fadeAllViewRows() {
    var wrap = document.getElementById("topo-views");
    if (!wrap) return;
    Array.prototype.forEach.call(wrap.children, fadeViewRow);
  }

  function closeTopologySearchResults() {
    _suggestState.open = false;
    _suggestState.items = [];
    var box = document.getElementById("topo-search-results");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  // ─── Node-tap bottom sheet ────────────────────────────────────────────
  function openNodeSheet(node, meta) {
    closeTopologySheet();

    var role = node.data("role") || "";
    var label = node.data("label") || "(unnamed)";
    var resolved = resolveNodeAsset(node.id(), role);

    var roleLabel = ({
      fortigate:      "FortiGate",
      fortiswitch:    "FortiSwitch",
      fortiap:        "FortiAP",
      "remote-asset": "Remote asset",
      lldp:           "LLDP neighbor",
    })[role] || "Node";

    var monitorPill = renderMonitorPill(resolved);
    var endpointBlock = "";
    if (role === "fortiswitch" && resolved && resolved.endpoints && resolved.endpoints.length > 0) {
      var sample = resolved.endpoints.slice(0, 12);
      var rows = sample.map(function (ep) {
        var primary = ep.hostname || ep.ipAddress || ep.macAddress || "(unnamed)";
        var bits = [];
        if (ep.port)        bits.push(ep.port);
        if (ep.ipAddress)   bits.push(ep.ipAddress);
        if (ep.assignedTo)  bits.push(ep.assignedTo);
        return ''
          + '<li>'
          + '<button class="topo-endpoint-row" data-asset-id="' + escapeHtml(ep.id) + '">'
          + '<span>' + escapeHtml(primary) + '</span>'
          + '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span>'
          + '</button></li>';
      }).join("");
      var heading = "Endpoints (" + (resolved.endpointCount || resolved.endpoints.length) + ")";
      var moreHint = (resolved.endpointCount || 0) > sample.length
        ? '<div class="muted" style="font-size:12px;margin-top:6px;">Showing ' + sample.length + ' of ' + resolved.endpointCount + ' — use search to find a specific endpoint.</div>'
        : "";
      endpointBlock = ''
        + '<div class="topo-section">'
        + '  <div class="topo-section-title">' + escapeHtml(heading) + '</div>'
        + '  <ul class="topo-endpoints">' + rows + '</ul>'
        + moreHint
        + '</div>';
    }

    var canPivotToAsset = (role === "fortigate" || role === "fortiswitch" || role === "fortiap" || role === "remote-asset");

    var meta1 = [];
    if (resolved && resolved.ipAddress)    meta1.push('<span class="mono">' + escapeHtml(resolved.ipAddress) + '</span>');
    if (resolved && resolved.serial)       meta1.push('<span class="mono">' + escapeHtml(resolved.serial) + '</span>');
    if (resolved && resolved.model)        meta1.push(escapeHtml(resolved.model));
    if (meta && meta.kind === "lldp")      meta1.push('<span class="muted" style="font-size:12px;">LLDP neighbor</span>');

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "topo-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "topo-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px;">'
      + '  <div style="min-width:0;">'
      // An inventory node's name opens its asset sheet (PolarisAssetDetail.linkHtml);
      // a path-overlay endpoint's node id IS its asset id.
      + '    <h3 class="sheet-title" style="margin:0 0 4px;">'
      +        assetNameHtml(canPivotToAsset ? (node.data("assetId") || node.id()) : (role === "endpoint" ? node.id() : null), label) + '</h3>'
      + '    <div class="muted" style="font-size:13px;letter-spacing:.25px;">' + escapeHtml(roleLabel) + (meta1.length ? ' · ' + meta1.join(" · ") : '') + '</div>'
      + '  </div>'
      + '  <button class="icon-btn" id="topo-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div style="display:flex;gap:8px;margin:12px 0 16px;flex-wrap:wrap;align-items:center;">'
      +    monitorPill
      + '</div>'
      +  endpointBlock
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + (canPivotToAsset
          ? '  <button class="btn btn-tonal" id="topo-sheet-asset"><svg viewBox="0 0 24 24"><use href="#i-server"/></svg>View asset</button>'
          : '')
      + '</div>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeTopologySheet);
    document.getElementById("topo-sheet-close").addEventListener("click", closeTopologySheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeTopologySheet);

    if (canPivotToAsset) {
      document.getElementById("topo-sheet-asset").addEventListener("click", function () {
        var assetId = node.data("assetId") || node.id();
        closeTopologySheet();
        if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(assetId);
        else PolarisRouter.go("asset/" + assetId);
      });
    }

    // Endpoint rows pivot to the asset detail page directly.
    sheet.querySelectorAll(".topo-endpoint-row").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.dataset.assetId;
        if (id) {
          closeTopologySheet();
          if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(id);
          else PolarisRouter.go("asset/" + id);
        }
      });
    });
  }

  function closeTopologySheet() {
    var s = document.getElementById("topo-sheet");
    var sc = document.getElementById("topo-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  // Walk _topoData to find the asset entry that backs the given node id.
  // Mirrors how desktop's right-rail panel resolves nodes to source data.
  function resolveNodeAsset(id, role) {
    if (!_topoData) return null;
    if (role === "fortigate") return _topoData.fortigate || null;
    if (role === "fortiswitch") {
      return (_topoData.switches || []).find(function (s) { return s.id === id; }) || null;
    }
    if (role === "fortiap") {
      return (_topoData.aps || []).find(function (a) { return a.id === id; }) || null;
    }
    if (role === "remote-asset") {
      return (_topoData.remoteAssetNodes || []).find(function (r) { return r.id === id; }) || null;
    }
    if (role === "lldp") {
      return (_topoData.lldpNodes || []).find(function (n) { return n.id === id; }) || null;
    }
    return null;
  }

  // Same shape as renderMonitorPill in map-tab.js — kept local so the
  // mobile topology surface doesn't depend on map-tab's internals.
  function renderMonitorPill(asset) {
    if (!asset) return '<span class="status-pill unk">—</span>';
    if (asset.status === "maintenance") return '<span class="status-pill maint"><span class="dot maint"></span>Maintenance</span>';
    if (!asset.monitored && asset.monitored !== undefined) return '<span class="status-pill unk">Unmonitored</span>';
    if (asset.monitored === undefined) return ""; // ghost LLDP / remote node
    var samples  = asset.monitorRecentSamples  || 0;
    var failures = asset.monitorRecentFailures || 0;
    switch (asset.monitorHealth) {
      case "up":       return '<span class="status-pill up"><span class="dot up"></span>Up</span>';
      case "degraded": return '<span class="status-pill warn"><span class="dot warn"></span>Packet loss — ' + failures + '/' + samples + '</span>';
      case "down":     return '<span class="status-pill down"><span class="dot down"></span>Down</span>';
      default:         return '<span class="status-pill unk"><span class="dot unk"></span>No samples</span>';
    }
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  // An asset's name as the link that opens its sheet; plain text without one.
  function assetNameHtml(id, name) {
    return (window.PolarisAssetDetail && PolarisAssetDetail.linkHtml) ? PolarisAssetDetail.linkHtml(id, name) : escapeHtml(name);
  }

  // ─── Public surface ────────────────────────────────────────────────────
  window.PolarisTopologyTab = {
    spec: Topology,
    // map-tab.js: map.css off before the site map paints.
    releaseStyles: function () { setMapCss(false); },
    viewChipRows: viewChipRows, // exported for tests
    fadeViewRow: fadeViewRow,   // exported for tests
    sortedViews: sortedViews,                   // exported for tests
    scopedLayoutKey: scopedLayoutKey,           // exported for tests
    effectiveShownTypes: effectiveShownTypes,   // exported for tests
    nextShownTypes: nextShownTypes,             // exported for tests
  };
})();
