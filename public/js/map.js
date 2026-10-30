/**
 * public/js/map.js — Device Map page
 *
 * Reads firewall assets populated by FortiManager / FortiGate discovery (with
 * lat/lng pulled from `config system global`) and plots them on a Leaflet map.
 * A FortiGate click fetches /map/sites/:id/topology and renders a Cytoscape
 * graph of FortiGate → FortiSwitches → FortiAPs, using edge data captured from
 * switch-controller detected-device MAC learnings (real uplinks, not guesses).
 */

(function () {
  var map = null;
  var markerCluster = null;
  var markersById = Object.create(null); // id → L.Marker
  var cyInstance = null;
  // Operator-drawn connection paths on the current graph
  // (PolarisTopologyEdgeEditor.attach) — rebuilt with every render.
  var edgeEditor = null;
  var siteCache = [];                    // last /map/sites payload
  // Currently-open topology modal state. siteId drives Refresh + position
  // persistence; data is the latest /topology payload (used for endpoint
  // pivots from search results without a re-fetch).
  // activeView: "flat" (default — the whole-site render, chip-labelled
  // "Base") or an area / building / floor view key from computeFloorViews.
  // Not persisted — the modal always opens on Base. floorViews caches the current payload's
  // view list for the switcher chips.
  // `editing`: the map is view-only until the Edit button (top-right of the
  // graph, the dashboard's pencil) is pressed; never persisted — every open
  // starts view-only, and it survives re-renders (refresh, view switches)
  // until Done or close.
  var topoState = { siteId: null, hostname: null, data: null, pathOverlay: null, activeView: "flat", floorViews: [], hasLocationCodes: false, editing: false };
  var topoSearchDebounce = null;
  var topoSuggestState  = { open: false, items: [], index: -1 };
  var POSITION_STORAGE_PREFIX = "polaris.topology.positions:";
  // Entries per saved layout blob — MAX_LAYOUT_NODES in
  // src/services/topologyLayoutService.ts, which rejects a bigger blob.
  var TOPO_LAYOUT_MAX_ENTRIES = 3000;
  // Per-browser restore points — the local half of Save, and the only half a
  // non-writer gets. Keyed like the positions store (bare key = flat view).
  var CHECKPOINT_STORAGE_PREFIX = "polaris.topology.saved:";
  // Column-layout spacing (shared by the base preset layout + the
  // connection-path overlay so an endpoint lands exactly one column right of
  // its access switch/AP). depth → x (px between adjacent columns),
  // lane → y (px between stacked nodes in a column).
  var TOPO_COL_SPACING = 130;
  var TOPO_ROW_SPACING = 95;
  // Legend overlay: per-user (singleton) — same key for every site, since
  // the legend describes the rendering rules, not site-specific content.
  // Persisted state is `{visible, x, y}` so opening the modal restores the
  // operator's last spot. Drag offsets are clamped on render to keep the
  // panel inside the graph if the modal was resized between sessions.
  var LEGEND_STORAGE_KEY = "polaris.topology.legend";
  // The map's corner tools (top right of the graph, right → left: Edit,
  // Export, then — edit mode only — Grid, Snap devices, Snap line points).
  // Every toggle is a per-user, per-browser pref; what they produce
  // (snapped positions, drawn lines) persists through the normal layout
  // save.
  //
  // The GRID has two weights. The thick (major) lines are the column
  // solver's lattice, TOPO_COL_SPACING × TOPO_ROW_SPACING — where devices
  // land. The thin (minor) lines split each major cell TOPO_GRID_DIV ways,
  // or TOPO_GRID_DIV_FINE ways once zoomed in far enough that a fine cell is
  // TOPO_GRID_FINE_MIN_PX on screen (_topologyGridDiv); thin AND thick lines
  // together are the lattice line points snap to, so the snap follows the
  // split being drawn.
  var TOPO_GRID_DIV = 4;
  var TOPO_GRID_DIV_FINE = 8;
  var TOPO_GRID_FINE_MIN_PX = 16;
  var GRID_STORAGE_KEY = "polaris.topology.grid";                 // default off
  // Snap devices: drags land on the MAJOR lattice on release, and turning it
  // on re-snaps every current position. Same key as the old single "Snap"
  // chip, so an operator who had snapping on keeps it.
  var SNAP_STORAGE_KEY = "polaris.topology.snapToGrid";           // default off
  var SNAP_POINTS_STORAGE_KEY = "polaris.topology.snapLinePoints"; // default off

  // Register cytoscape-dagre once. Both globals are populated by the UMD builds
  // loaded in map.html. Guarded so hot-reload doesn't throw.
  if (window.cytoscape && window.cytoscapeDagre && !window._cytoscapeDagreRegistered) {
    window.cytoscape.use(window.cytoscapeDagre);
    window._cytoscapeDagreRegistered = true;
  }

  // ─── Boot ─────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", async function () {
    await fetchCurrentUser();
    renderNav();

    initMap();
    wireModal();
    // The Regions panel first: it builds the pencil wireRegionEditing wires.
    regionViewState.hidden = await loadHiddenRegions();
    wireShowRegions();
    wireRegionEditing();

    try {
      await loadSites();
    } catch (err) {
      setStatus("Failed to load sites: " + (err && err.message ? err.message : err));
    }
  });

  // ─── Leaflet setup ────────────────────────────────────────────────────────
  function initMap() {
    map = L.map("map", {
      worldCopyJump: true,
      // Fractional zoom so fitBounds fills the viewport instead of rounding
      // down to the nearest integer zoom (which left a large empty border
      // around the fleet on the default load).
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      // Continental-US starting view — bounds will tighten once data loads
      center: [39.5, -95],
      zoom: 4,
    });

    // Leaflet's default marker icons rely on images being sibling to leaflet.css.
    // We bundle them under /css/vendor/leaflet/images — point Leaflet at that
    // path so PNG URLs resolve correctly.
    L.Icon.Default.imagePath = "/css/vendor/leaflet/images/";

    // Theme-aware basemap. OpenStreetMap tiles in BOTH themes; dark is a
    // CSS filter over the tile pane rather than a second tile set. CARTO's
    // Dark Matter served the dark half until CARTO started requiring an API
    // key on its basemap CDN — unkeyed tiles now come back as an "API KEY
    // REQUIRED" watermark. OSM is the only unkeyed source, so filtering it
    // is what keeps dark working without a per-install third-party account.
    // Tile layer is swapped in place when the operator clicks the map-theme
    // toggle, OR when the global app theme changes AND the user hasn't set a
    // per-user map override (getMapTheme falls back to the global theme).
    applyBasemapTheme();
    var themeObserver = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === "data-theme") {
          applyBasemapTheme();
          // The topology graph's palette is app-themed (see the note at its
          // `appThemeFamily()` call), and the Cytoscape stylesheet is read once
          // at render time rather than reactively — so an open modal has to be
          // re-rendered here or it keeps the palette of the theme it opened in.
          repaintOpenTopology();
          // The legend's link and box swatches are per family too.
          var legendBody = document.getElementById("topology-legend-body");
          if (legendBody && legendBody.dataset.rendered) {
            delete legendBody.dataset.rendered;
            renderTopologyLegend();
          }
          break;
        }
      }
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    // Per-user map theme toggle in the toolbar — separate from the
    // global app theme. Click flips the saved preference and swaps the
    // basemap; the topology modal is app-themed and does not follow it.
    var mapThemeBtn = document.getElementById("map-theme-toggle");
    if (mapThemeBtn) mapThemeBtn.addEventListener("click", toggleMapTheme);

    markerCluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      // Wide clusters while zoomed out; from CLUSTER_TIGHT_ZOOM on, a cluster
      // forms only where gates would draw on top of each other — that used
      // to be disableClusteringAtZoom, which left co-located gates stacked
      // under one visible marker with nothing to click to reach the others.
      maxClusterRadius: function (zoom) { return zoom >= CLUSTER_TIGHT_ZOOM ? CLUSTER_TIGHT_RADIUS : 40; },
      // A cluster click is ours (onClusterActivate): zoom until the gates
      // separate, or fan them out with legs to their shared location.
      zoomToBoundsOnClick: false,
      spiderfyOnMaxZoom: false,
      // .fg-marker is 34px against the 25px marker the foot spacing assumes,
      // and the legs back to the shared location need room to be seen.
      spiderfyDistanceMultiplier: 2.6,
      spiderLegPolylineOptions: { weight: 2, opacity: 0.9, className: "fg-spider-leg" },
      // Default markercluster coloring buckets by child count (small/medium/large
      // → green/yellow/orange). That's misleading here: a cluster of 100 healthy
      // FortiGates would show orange. Roll up the worst monitor health among
      // children instead so the cluster matches the dot colors it represents.
      iconCreateFunction: clusterIcon,
    });
    map.addLayer(markerCluster);
    wireClusterInteractions();
    addStatusLegend();
    addMapThemeControl();
    // Before the Regions panel (wireShowRegions), so it is the rightmost
    // control in the top-right corner — see .map-view-tools in map.css.
    addMapViewTools();

    attachRightClickPan();
  }

  // ─── View tools: Full screen / Refresh / Export (top-right) ───────────────
  var ICON_REFRESH =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>' +
      '<path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
  var ICON_EXPORT =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  var ICON_MENU_CAMERA =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
  var ICON_MENU_DOC =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

  function addMapViewTools() {
    var ctl = L.control({ position: "topright" });
    ctl.onAdd = function () {
      var div = L.DomUtil.create("div", "map-view-tools");
      div.innerHTML =
        '<button type="button" class="btn btn-secondary btn-sm btn-icon-only" id="map-fullscreen" style="line-height:0"></button>' +
        '<button type="button" class="btn btn-secondary btn-sm btn-icon-only" id="map-refresh" aria-label="Refresh" title="Refresh the map" style="line-height:0">' + ICON_REFRESH + "</button>" +
        '<button type="button" class="btn btn-secondary btn-sm btn-icon-only" id="map-export" aria-label="Export" aria-haspopup="menu" title="Export what is in view: screenshot or PDF" style="line-height:0">' + ICON_EXPORT + "</button>";
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    ctl.addTo(map);

    if (window.PolarisMapFullscreen) {
      window.PolarisMapFullscreen.attach(document.getElementById("map-fullscreen"), map.getContainer(),
        function () { map.invalidateSize(); });
    }
    var refreshBtn = document.getElementById("map-refresh");
    refreshBtn.addEventListener("click", async function () {
      refreshBtn.disabled = true;
      try {
        await loadSites({ keepView: true });
      } catch (err) {
        setStatus("Failed to load sites: " + (err && err.message ? err.message : err));
      } finally {
        refreshBtn.disabled = false;
      }
    });
    var exportBtn = document.getElementById("map-export");
    exportBtn.addEventListener("click", function () {
      showRowMenu(exportBtn, [
        { label: "Copy screenshot", icon: ICON_MENU_CAMERA, onSelect: function () { exportMapView("png"); } },
        { label: "Export PDF", icon: ICON_MENU_DOC, onSelect: function () { exportMapView("pdf"); } },
      ], { align: "end", label: "Export" });
    });
  }

  // The map as it is in the viewer, on a canvas at 2x: exactly the visible
  // area — what is panned or zoomed out of view is not in it. Two layers,
  // because html-to-image fetch()es every <img> it inlines and the CSP's
  // connect-src does not (and need not) list the tile host: the basemap tiles
  // are drawn straight from their loaded <img> elements (CORS-loaded, see
  // applyBasemapTheme, so the canvas stays exportable) under the tile pane's
  // own filter (the dark basemap), then html-to-image renders everything
  // else — markers, clusters, region polygons, the status legend and the
  // attribution — over them with the tile pane and the top corners' buttons
  // left out.
  async function captureMapCanvas() {
    var el = map.getContainer();
    var box = el.getBoundingClientRect();
    var SCALE = 2;
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(box.width * SCALE);
    canvas.height = Math.round(box.height * SCALE);
    var ctx = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);
    ctx.fillStyle = getComputedStyle(el).backgroundColor || "#ffffff";
    ctx.fillRect(0, 0, box.width, box.height);

    var tilePane = el.querySelector(".leaflet-tile-pane");
    if (tilePane) {
      var f = getComputedStyle(tilePane).filter;
      ctx.filter = f && f !== "none" ? f : "none";
      tilePane.querySelectorAll("img.leaflet-tile-loaded").forEach(function (img) {
        var r = img.getBoundingClientRect();
        if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) return;
        ctx.drawImage(img, r.left - box.left, r.top - box.top, r.width, r.height);
      });
      ctx.filter = "none";
    }

    if (typeof htmlToImage !== "undefined" && htmlToImage.toCanvas) {
      var overlay = await htmlToImage.toCanvas(el, {
        pixelRatio: SCALE,
        // The container's own card background would paint over the tiles.
        style: { background: "transparent", backgroundColor: "transparent", boxShadow: "none" },
        filter: function (node) {
          var cl = node && node.classList;
          return !(cl && (cl.contains("leaflet-tile-pane") || cl.contains("leaflet-top")));
        },
      });
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(overlay, 0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }

  async function exportMapView(kind) {
    var canvas;
    try {
      canvas = await captureMapCanvas();
    } catch (err) {
      showToast("Export failed: " + (err && err.message ? err.message : err), "error");
      return;
    }
    var stamp = new Date().toISOString().slice(0, 10);
    if (kind === "pdf") {
      if (!window.jspdf || !window.jspdf.jsPDF) {
        showToast("PDF library not loaded. Reload the page and try again.", "error");
        return;
      }
      try {
        var doc = new window.jspdf.jsPDF({ orientation: canvas.width >= canvas.height ? "landscape" : "portrait", unit: "pt", format: "letter" });
        var pw = doc.internal.pageSize.getWidth(), ph = doc.internal.pageSize.getHeight();
        var M = 28, now = new Date();
        doc.setFontSize(14);
        doc.setTextColor(26, 26, 26);
        doc.text(((typeof _branding !== "undefined" && _branding && _branding.appName) || "Polaris") + " — Device Map", M, M + 10);
        doc.setFontSize(8);
        doc.setTextColor(110, 110, 110);
        var statusEl = document.getElementById("map-status");
        var sub = "Generated: " + now.toLocaleDateString() + " " + now.toLocaleTimeString() +
          (statusEl && statusEl.textContent ? "  |  " + statusEl.textContent : "");
        doc.text(sub, M, M + 24);
        var top = M + 34, aw = pw - 2 * M, ah = ph - top - M;
        var k = Math.min(aw / canvas.width, ah / canvas.height);
        var w = canvas.width * k, h = canvas.height * k;
        // JPEG: map tiles are photographic enough that a PNG of the 2x capture
        // made a 15 MB PDF; at 0.9 it is a small fraction of that, unblurred.
        doc.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", M + (aw - w) / 2, top, w, h);
        doc.save("polaris-device-map-" + stamp + ".pdf");
        showToast("Device Map exported as PDF");
      } catch (err) {
        showToast("Export failed: " + (err && err.message ? err.message : err), "error");
      }
      return;
    }
    var blob = await new Promise(function (resolve) {
      try { canvas.toBlob(resolve, "image/png"); } catch (e) { resolve(null); }
    });
    if (!blob) { showToast("Screenshot failed", "error"); return; }
    if (await copyPngToClipboard(blob)) {
      showToast("Map copied to clipboard");
      return;
    }
    // Clipboard unavailable or refused (needs HTTPS + permission): download.
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "polaris-device-map-" + stamp + ".png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  // Right-click drag pans the map. Useful when left-click is captured by
  // another tool (e.g. drawing a region polygon with leaflet-draw — the
  // first vertex placement would otherwise start a polygon you can't abort).
  // Active everywhere on the map page; suppresses the context menu inside
  // the map container only.
  function attachRightClickPan() {
    var container = map.getContainer();
    var state = { active: false, lastX: 0, lastY: 0 };
    container.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    container.addEventListener("mousedown", function (e) {
      if (e.button !== 2) return;
      state.active = true;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      container.style.cursor = "grabbing";
      e.preventDefault();
    });
    window.addEventListener("mousemove", function (e) {
      if (!state.active) return;
      var dx = e.clientX - state.lastX;
      var dy = e.clientY - state.lastY;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      map.panBy([-dx, -dy], { animate: false });
    });
    window.addEventListener("mouseup", function (e) {
      if (e.button !== 2 || !state.active) return;
      state.active = false;
      container.style.cursor = "";
    });
  }

  // Active basemap tile layer; swapped in place when the map theme
  // changes. Holding the reference here so the MutationObserver in initMap
  // can remove the previous layer cleanly.
  var basemapLayer = null;

  // Map page has its own theme toggle, separate from the overall app
  // theme. Persisted per user in localStorage so each operator's
  // preference survives reload. Falls back to the global app theme
  // when no preference is set, so users who don't toggle see no change.
  function _mapThemePrefKey() {
    var u = (typeof currentUsername === "string" && currentUsername) ? currentUsername : "anon";
    return "polaris-prefs-map-" + u;
  }
  // The app theme's FAMILY — "light" for the daylight pair, "dark" for
  // nightfall. Every palette on this page that is NOT a basemap pair keys off
  // this: the Cytoscape topology stylesheet, whose canvas is an app-themed
  // CSS pane. Never compare a theme id; there are three themes, two families.
  function appThemeFamily() {
    return (typeof isLightTheme === "function" && isLightTheme()) ? "light" : "dark";
  }
  function getMapTheme() {
    try {
      var raw = localStorage.getItem(_mapThemePrefKey());
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && (parsed.theme === "dark" || parsed.theme === "light")) {
          return parsed.theme;
        }
      }
    } catch (e) { /* fall through */ }
    // The app theme's FAMILY, not its id: this value indexes a basemap pair,
    // and there are three themes but only two basemaps. An id comparison here
    // put nightfall on the light OpenStreetMap tiles.
    return appThemeFamily();
  }
  function setMapTheme(theme) {
    try {
      localStorage.setItem(_mapThemePrefKey(), JSON.stringify({ theme: theme }));
    } catch (e) { /* quota / private mode — silently skip */ }
  }

  function applyBasemapTheme() {
    if (!map) return;
    var isDark = getMapTheme() === "dark";
    // Single-host tile URL. The OSM tile usage policy permits only
    // https://tile.openstreetmap.org/{z}/{x}/{y}.png — the older {s} a/b/c
    // subdomain form spreads one viewport over three hosts instead of one
    // multiplexed HTTP/2 connection, and reads to their operators as a
    // policy violation: tiles come back as the "Access blocked" image.
    var url = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    var attribution = "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors";
    if (basemapLayer) map.removeLayer(basemapLayer);
    // crossOrigin: tiles are fetched in CORS mode (tile.openstreetmap.org
    // answers Access-Control-Allow-Origin: *) so the Export menu can paint
    // them onto a canvas without tainting it (captureMapCanvas).
    basemapLayer = L.tileLayer(url, { maxZoom: 19, attribution: attribution, crossOrigin: "anonymous" }).addTo(map);
    // Dark is the same tiles under a filter — see the note in initMap.
    map.getContainer().classList.toggle("polaris-basemap-dark", isDark);
    paintMapThemeToggle();
  }

  // Update the toolbar toggle's icon to reflect the current state.
  // Sun = "switch to light" (i.e. we're currently dark); moon = "switch
  // to dark" (i.e. we're currently light). Matches the global theme
  // toggle's idiom.
  function paintMapThemeToggle() {
    var btn = document.getElementById("map-theme-toggle");
    if (!btn) return;
    var isDark = getMapTheme() === "dark";
    btn.innerHTML = isDark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>';
    btn.title = "Map theme: " + (isDark ? "dark" : "light") + " (click to toggle, saved per user)";
  }
  function toggleMapTheme() {
    var next = getMapTheme() === "dark" ? "light" : "dark";
    setMapTheme(next);
    applyBasemapTheme();
    // Deliberately NOT re-rendering the topology modal: this toggle picks the
    // basemap pair, and the topology graph follows the app theme instead.
  }
  // Re-render an open topology modal in place. Its Cytoscape stylesheet is
  // evaluated once per render, so any palette input that changes underneath it
  // has to come back through here.
  function repaintOpenTopology() {
    var overlay = document.getElementById("topology-overlay");
    if (overlay && overlay.classList.contains("open") && topoState.data) {
      renderTopologyGraph(topoState.data);
    }
  }

  function clusterIcon(cluster) {
    var children = cluster.getAllChildMarkers();
    var sawMonitored = false;
    var sawDepDown = false;
    var sawMaint = false;
    var worst = "up"; // up < degraded < down
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      // Maintenance isn't an outage (its health is frozen) — it never rolls a
      // cluster up to red/amber. It surfaces only when nothing worse is
      // present, mirroring the single-marker priority + the NOC feeds.
      if (s.status === "maintenance") { sawMaint = true; continue; }
      // Suppressed sites contribute dep-down regardless of their own probe
      // health — matches the per-site marker and the assets-list pill.
      if (s.dependencySuppressed) { sawDepDown = true; continue; }
      if (s.monitorHealth === "down") { worst = "down"; break; }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
    }
    // Non-suppressed probe-down/degraded wins over dep-down — those are real
    // independent failures. A cluster where every monitored child is healthy
    // or dep-down rolls up to dep-down; maintenance surfaces last, above only
    // an all-up cluster.
    var cls;
    if (!sawMonitored)               cls = "monitor-unmonitored";
    else if (worst !== "up")         cls = "monitor-" + worst;
    else if (sawDepDown)             cls = "monitor-dep-down";
    else if (sawMaint)               cls = "monitor-maintenance";
    else                             cls = "monitor-up";
    var count = cluster.getChildCount();
    return L.divIcon({
      html: '<div class="fg-cluster ' + cls + '"><span>' + count + "</span></div>",
      className: "",
      iconSize: [40, 40],
    });
  }

  // ─── Cluster hover list + click ───────────────────────────────────────────
  // A cluster bubble names its gates on hover (each name opens that gate's
  // topology) and, on click, either zooms until the gates separate or — when
  // no zoom would separate them because they share a location — fans them
  // out around that location with a leg from each back to it.
  var CLUSTER_TIGHT_ZOOM = 11;     // from here on, cluster only overlapping markers
  var CLUSTER_TIGHT_RADIUS = 24;   // px — two 34px .fg-marker discs this close read as one
  var CLUSTER_ZOOM_CAP = 18;       // deepest zoom a cluster click will take the map to
  var CLUSTER_SPLIT_PX = 40;       // spread at the cap below which zooming can't split them
  var CLUSTER_FAN_ZOOM = 15;       // zoom a fan-out is drawn at when clicked from further out
  var CLUSTER_LIST_CLOSE_MS = 250; // grace to move the pointer from the bubble into the list
  // Worst-first, the same precedence monitorClass and clusterIcon read.
  var CLUSTER_LIST_RANK = {
    "monitor-down": 0, "monitor-degraded": 1, "monitor-dep-down": 2, "monitor-unknown": 3,
    "monitor-maintenance": 4, "monitor-passive": 5, "monitor-up": 6, "monitor-unmonitored": 7,
  };
  var clusterList = { popup: null, cluster: null, closeTimer: null };
  var spiderAnchor = null;

  function wireClusterInteractions() {
    markerCluster.on("clustermouseover", function (e) {
      cancelClusterListClose();
      showClusterList(e.layer);
    });
    markerCluster.on("clustermouseout", scheduleClusterListClose);
    markerCluster.on("clusterclick clusterkeypress", function (e) {
      if (e.type === "clusterkeypress") {
        var oe = e.originalEvent;
        if (!oe || (oe.key !== "Enter" && oe.keyCode !== 13)) return;
      }
      closeClusterList();
      onClusterActivate(e.layer);
    });
    // The fan's legs meet at the gates' real location; mark that point so
    // the legs read as "these are all here" rather than ending in nothing.
    markerCluster.on("spiderfied", function (e) {
      hideSpiderAnchor();
      // markercluster leaves the bubble at 30% under the fan; the anchor dot
      // replaces it. It restores the bubble's opacity itself on unspiderfy.
      e.cluster.setOpacity(0);
      spiderAnchor = L.circleMarker(e.cluster.getLatLng(), {
        radius: 5, weight: 2, fillOpacity: 1, interactive: false, className: "fg-spider-anchor",
      }).addTo(map);
    });
    markerCluster.on("unspiderfied", hideSpiderAnchor);
    map.on("zoomstart", closeClusterList);
  }

  function hideSpiderAnchor() {
    if (spiderAnchor) { map.removeLayer(spiderAnchor); spiderAnchor = null; }
  }

  // Pixel distance across the markers' bounds at a given zoom.
  function clusterSpreadPx(markers, zoom) {
    var b = L.latLngBounds(markers.map(function (m) { return m.getLatLng(); }));
    return map.project(b.getNorthWest(), zoom).distanceTo(map.project(b.getSouthEast(), zoom));
  }
  function clusterIsCoLocated(markers) {
    return clusterSpreadPx(markers, CLUSTER_ZOOM_CAP) < CLUSTER_SPLIT_PX;
  }

  function onClusterActivate(cluster) {
    var markers = cluster.getAllChildMarkers();
    if (!markers.length) return;
    var zoom = map.getZoom();
    if (!clusterIsCoLocated(markers)) {
      var bounds = L.latLngBounds(markers.map(function (m) { return m.getLatLng(); }));
      var fitZoom = Math.min(map.getBoundsZoom(bounds, false, L.point(120, 120)), CLUSTER_ZOOM_CAP);
      if (fitZoom > zoom) {
        map.fitBounds(bounds, { padding: [60, 60], maxZoom: CLUSTER_ZOOM_CAP });
        return;
      }
      // Already as close as a fit would go — fan them out instead.
    }
    if (zoom >= CLUSTER_FAN_ZOOM) { cluster.spiderfy(); return; }
    // Zoom in on the shared location, then fan out the cluster that holds
    // these gates at the new zoom. markercluster refuses to spiderfy during
    // its zoom animation, so wait it out (bounded).
    var tries = 0;
    var fanOut = function () {
      var parent = markerCluster.getVisibleParent(markers[0]);
      var ready = !markerCluster._inZoomAnimation && parent && parent !== markers[0] && typeof parent.spiderfy === "function";
      if (ready) { parent.spiderfy(); return; }
      if (++tries < 20) setTimeout(fanOut, 100);
    };
    map.once("moveend", function () { setTimeout(fanOut, 0); });
    map.setView(cluster.getLatLng(), CLUSTER_FAN_ZOOM);
  }

  function showClusterList(cluster) {
    if (clusterList.cluster === cluster && clusterList.popup && map.hasLayer(clusterList.popup)) return;
    // A fanned-out bubble is hidden under its own fan; the markers are the list.
    if (markerCluster._spiderfied === cluster) return;
    var markers = cluster.getAllChildMarkers();
    var sites = markers.map(function (m) { return m._site; }).filter(Boolean);
    sites.sort(function (a, b) {
      var ra = CLUSTER_LIST_RANK[monitorClass(a)], rb = CLUSTER_LIST_RANK[monitorClass(b)];
      if (ra !== rb) return (ra == null ? 99 : ra) - (rb == null ? 99 : rb);
      return String(a.hostname || "").localeCompare(String(b.hostname || ""), undefined, { numeric: true });
    });
    var coLocated = clusterIsCoLocated(markers);
    var rows = sites.map(function (s) {
      return '<li><button type="button" class="fg-cluster-list-item" data-site-id="' + escapeHtml(String(s.id)) + '"' +
        ' title="' + escapeHtml(monitorTooltipLine(s)) + '">' +
        '<i class="' + monitorClass(s) + '" aria-hidden="true"></i>' +
        '<span class="fg-cluster-list-name">' + escapeHtml(s.hostname || "(unnamed)") + '</span>' +
        (s.model ? '<span class="fg-cluster-list-model">' + escapeHtml(s.model) + '</span>' : '') +
        '</button></li>';
    }).join("");
    var html =
      '<div class="fg-cluster-list">' +
        '<div class="fg-cluster-list-head">' + sites.length + ' FortiGate' + (sites.length === 1 ? '' : 's') +
          (coLocated ? ' at this location' : '') + '</div>' +
        '<ul>' + rows + '</ul>' +
        '<div class="fg-cluster-list-hint">Click a name for its topology · click the circle to ' +
          (coLocated ? 'fan them out' : 'zoom in') + '</div>' +
      '</div>';
    closeClusterList();
    var popup = L.popup({
      closeButton: false,
      autoPan: false,
      className: "fg-cluster-popup",
      offset: [0, -14],
      minWidth: 200,
      maxWidth: 320,
    }).setLatLng(cluster.getLatLng()).setContent(html);
    popup.openOn(map);
    clusterList.popup = popup;
    clusterList.cluster = cluster;
    var el = popup.getElement();
    if (!el) return;
    el.addEventListener("mouseenter", cancelClusterListClose);
    el.addEventListener("mouseleave", scheduleClusterListClose);
    el.addEventListener("click", function (ev) {
      var btn = ev.target.closest("[data-site-id]");
      if (!btn) return;
      var id = btn.getAttribute("data-site-id");
      var site = siteCache.find(function (s) { return String(s.id) === id; });
      closeClusterList();
      if (site) openTopology(site.id, site.hostname || "");
    });
  }

  function scheduleClusterListClose() {
    cancelClusterListClose();
    clusterList.closeTimer = setTimeout(closeClusterList, CLUSTER_LIST_CLOSE_MS);
  }
  function cancelClusterListClose() {
    if (clusterList.closeTimer) { clearTimeout(clusterList.closeTimer); clusterList.closeTimer = null; }
  }
  function closeClusterList() {
    cancelClusterListClose();
    if (clusterList.popup && map) map.closePopup(clusterList.popup);
    clusterList.popup = null;
    clusterList.cluster = null;
  }

  // ─── Sites load ───────────────────────────────────────────────────────────
  // opts.keepView (the on-map Refresh button): re-read the sites without
  // re-fitting the view or re-running the URL hash's pan / topology open —
  // the operator's zoom and pan stay where they are.
  async function loadSites(opts) {
    opts = opts || {};
    setStatus("Loading FortiGates…");
    var sites = await api.map.sites();
    siteCache = Array.isArray(sites) ? sites : [];
    closeClusterList();
    markerCluster.clearLayers();
    hideSpiderAnchor();
    markersById = Object.create(null);

    if (siteCache.length === 0) {
      setStatus("No FortiGates with coordinates yet. Run a discovery; the map populates from `config system global`.");
      return;
    }

    siteCache.forEach(function (s) {
      if (s.latitude == null || s.longitude == null) return;
      markersById[s.id] = makeMarker(s);
    });
    // Sites inside a region the viewer hid stay off the map (map.js
    // applySiteVisibility), so the region geometry has to be in hand first.
    await ensureRegionPayloadForSites();
    applySiteVisibility({ fit: !opts.keepView });

    // If the operator landed here from a global-search hit, the URL hash
    // tells us what to do:
    //   #site=<assetId>                                — pan to marker
    //   #site=<assetId>&topology=1                     — pan + open topology
    //   #site=<assetId>&topology=1&q=<focusQuery>      — pan + open topology
    //                                                    + auto-search the
    //                                                    modal to highlight
    //                                                    a specific endpoint
    // Defer one frame so fitBounds completes before the override.
    var hash = opts.keepView ? "" : (window.location.hash || "");
    if (hash.startsWith("#site=")) {
      var params = {};
      hash.slice(1).split("&").forEach(function (kv) {
        var idx = kv.indexOf("=");
        if (idx <= 0) return;
        params[kv.slice(0, idx)] = decodeURIComponent(kv.slice(idx + 1));
      });
      var hashSiteId = params.site;
      requestAnimationFrame(function () {
        if (params.topology === "1" && hashSiteId) {
          window.polarisMapOpenSiteTopology(hashSiteId, params.q || null);
        } else if (hashSiteId) {
          window.polarisMapPanToAsset(hashSiteId);
        }
      });
    }
  }

  // ─── Sites in hidden regions ──────────────────────────────────────────────
  // A FortiGate whose pin lies inside a region the viewer hid in the Regions
  // panel (or inside anything nested under one) is left off the map, whether
  // or not the panel is open — the hidden set is a standing per-user filter,
  // and the status line says how many it holds back. Every marker is still
  // built and kept in markersById; only the cluster layer's membership
  // changes, so showing the region again is a re-add, not a re-fetch.
  async function ensureRegionPayloadForSites() {
    if (Object.keys(regionViewState.hidden).length === 0) return;
    try { await loadRegionOverlay(); }
    catch (e) { /* no geometry, no filter: every site shows */ }
  }

  function siteHiddenTest() {
    if (!regionViewState.payload || !window.PolarisRegionTree) return null;
    return window.PolarisRegionTree.hiddenPointTest(regionViewState.payload, regionViewState.hidden);
  }

  // opts.fit re-centres / re-zooms on the FortiGates still shown (the same
  // fit the first load makes). With every site hidden the view is left alone.
  function applySiteVisibility(opts) {
    opts = opts || {};
    var test = siteHiddenTest();
    closeClusterList();
    hideSpiderAnchor();
    markerCluster.clearLayers();
    var shown = [];
    var latlngs = [];
    var hiddenCount = 0;
    siteCache.forEach(function (s) {
      var m = markersById[s.id];
      if (!m) return;
      if (test && test(s.latitude, s.longitude)) { hiddenCount++; return; }
      shown.push(m);
      latlngs.push([s.latitude, s.longitude]);
    });
    markerCluster.addLayers(shown);

    if (latlngs.length > 0 && opts.fit) {
      // Tighter fit — 5% padding around the actual asset bounds (was 20%)
      // so the operator's eye lands on the cluster, not the empty
      // ocean/border. maxZoom bumped to 12 for clustered fleets where
      // the natural fit zoom would otherwise be capped too far out.
      map.fitBounds(L.latLngBounds(latlngs).pad(0.05), { maxZoom: 12 });
    }
    var total = shown.length + hiddenCount;
    if (shown.length === 0 && hiddenCount > 0) {
      setStatus("All " + total + " FortiGate" + (total === 1 ? " is" : "s are") +
        " in hidden regions — show a region in the Regions panel to see them.");
    } else {
      setStatus(shown.length + " FortiGate" + (shown.length === 1 ? "" : "s") + " on the map" +
        (hiddenCount > 0 ? " · " + hiddenCount + " in hidden regions" : ""));
    }
  }

  // Status legend, bottom-left - the Status Map widget's legend
  // (siteMap.js) on the page that paints the same dots. The widget's stops
  // at five because its own healthKey has five; monitorClass() below can
  // return eight, and a swatch an operator can see with no row to read it
  // against is the thing a legend exists to prevent. Order mirrors
  // monitorClass's own precedence, worst-verdict-first after Up.
  // Every color lives in the .fg-marker / .map-legend i palette in map.css
  // - the swatch is styled by the SAME class the marker carries, so the two
  // cannot drift.
  var LEGEND_ENTRIES = [
    ["monitor-up",          "Up"],
    ["monitor-degraded",    "Warn"],
    ["monitor-down",        "Down"],
    ["monitor-dep-down",    "Dep. Down"],
    ["monitor-maintenance", "Maint"],
    ["monitor-passive",     "Passive"],
    ["monitor-unmonitored", "Unmonitored"],
    ["monitor-unknown",     "Unknown"],
  ];

  // The map-theme toggle lives ON the map, top-left above the zoom buttons
  // (moved there from the toolbar 2026-10-16). Leaflet stacks a corner's
  // controls in the order they are added, so it is re-inserted at the top of
  // the corner. The button element (and its click wiring) is map.html's.
  function addMapThemeControl() {
    var btn = document.getElementById("map-theme-toggle");
    if (!btn) return;
    var ctl = L.control({ position: "topleft" });
    ctl.onAdd = function () {
      var div = L.DomUtil.create("div", "map-theme-control");
      div.appendChild(btn);
      L.DomEvent.disableClickPropagation(div);
      return div;
    };
    ctl.addTo(map);
    var el = ctl.getContainer();
    if (el && el.parentNode) el.parentNode.insertBefore(el, el.parentNode.firstChild);
  }

  function addStatusLegend() {
    var ctl = L.control({ position: "bottomleft" });
    ctl.onAdd = function () {
      var div = L.DomUtil.create("div", "map-legend");
      div.innerHTML = LEGEND_ENTRIES.map(function (e) {
        return '<span><i class="' + e[0] + '" aria-hidden="true"></i>' + escapeHtml(e[1]) + "</span>";
      }).join("");
      // Without this a click on the legend reaches the map underneath - which
      // in region edit mode drops a polygon vertex behind the panel.
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      // Collapses into its own button in this corner (legend-toggle.js).
      if (window.PolarisLegendToggle) {
        window.PolarisLegendToggle.attach(div, { title: "Status", storageKey: "polaris.legend.deviceMap" });
      }
      return div;
    };
    ctl.addTo(map);
  }

  function monitorClass(site) {
    // Maintenance wins over everything: polling is paused so monitorHealth is
    // frozen (not live), and the gate is intentionally offline. Paint it the
    // maintenance purple rather than letting the stale health show red. Checked
    // first, mirroring the Status Map widget's healthKey (siteMap.js).
    if (site.status === "maintenance") return "monitor-maintenance";
    if (!site.monitored) return "monitor-unmonitored";
    // Dependency suppression takes precedence over the probe-derived health,
    // whether the site's own probe is failing (the usual case behind a down
    // parent) or still succeeding through a redundant path — see
    // assetMonitorBadge for the matching priority on the assets list.
    if (site.dependencySuppressed) return "monitor-dep-down";
    switch (site.monitorHealth) {
      case "up":       return "monitor-up";
      case "degraded": return "monitor-degraded";
      case "down":     return "monitor-down";
      // No down-detection automation covers it, so there is no verdict to
      // paint. NOT "unknown", which claims we have no samples.
      case "passive":  return "monitor-passive";
      default:         return "monitor-unknown";
    }
  }

  function monitorTooltipLine(site) {
    if (site.status === "maintenance") return "In maintenance — polling paused";
    if (!site.monitored) return "Unmonitored";
    var samples = site.monitorRecentSamples || 0;
    var failures = site.monitorRecentFailures || 0;
    if (site.dependencySuppressed) {
      var layerHint = (site.dependencyLayer != null) ? " (Layer " + site.dependencyLayer + ")" : "";
      return "Dependency down — upstream parent is offline" + layerHint;
    }
    switch (site.monitorHealth) {
      case "up":       return "Up — last " + samples + " samples ok";
      case "degraded": return "Packet loss — " + failures + "/" + samples + " recent samples failed";
      case "down":     return "Down — " + failures + "/" + samples + " samples failed";
      default:         return "Monitored — no samples yet";
    }
  }

  function makeMarker(site) {
    var label = (site.hostname || "FG").slice(0, 3).toUpperCase();
    var icon = L.divIcon({
      className: "",
      html: '<div class="fg-marker ' + monitorClass(site) + '" aria-hidden="true">' + escapeHtml(label) + "</div>",
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    var marker = L.marker([site.latitude, site.longitude], {
      icon: icon,
      title: site.hostname || "",
      // Stack maintenance gates BENEATH everything else so a gate that's
      // intentionally offline never sits on top of (and hides) a live gate
      // where two markers overlap at nearly-identical coordinates. Leaflet's
      // default is latitude-based ordering; a negative offset pushes
      // maintenance markers to the bottom of the z-stack.
      zIndexOffset: site.status === "maintenance" ? -1000 : 0,
    });
    // Stashed for clusterIcon() to roll up health across children.
    marker._site = site;
    marker.bindTooltip(
      '<strong>' + escapeHtml(site.hostname || "(unnamed)") + '</strong>' +
      (site.model ? '<br><span style="opacity:.8">' + escapeHtml(site.model) + '</span>' : "") +
      '<br><span style="opacity:.8">' + escapeHtml(monitorTooltipLine(site)) + '</span>' +
      (site.subnetCount ? '<br>' + site.subnetCount + ' subnet' + (site.subnetCount === 1 ? '' : 's') : ''),
      { direction: "top", offset: [0, -12] }
    );
    marker.on("click", function () { openTopology(site.id, site.hostname || ""); });
    return marker;
  }

  function focusSite(site) {
    if (site.latitude == null || site.longitude == null) return;
    var marker = markersById[site.id];
    if (marker && !markerCluster.hasLayer(marker)) {
      // Left off the map by a hidden region (applySiteVisibility): there is
      // no pin to fly to, so the view stays put. Returns false so the
      // search hooks keep this status line; the topology still opens.
      setStatus((site.hostname || "This FortiGate") + " is in a hidden region — show the region in the Regions panel to see its pin.");
      return false;
    }
    map.flyTo([site.latitude, site.longitude], 13, { duration: 0.8 });
    if (marker) {
      // If the marker is still inside a cluster, zoom to it; once revealed,
      // fire a click so the tooltip/modal path is consistent with direct use.
      setTimeout(function () {
        if (markerCluster.hasLayer(marker)) {
          markerCluster.zoomToShowLayer(marker, function () {
            marker.openTooltip();
          });
        } else if (marker._map) {
          marker.openTooltip();
        }
      }, 700);
    }
    return true;
  }

  // ─── Hooks for the global app-wide search ─────────────────────────────────
  // The global search bar in the page header (see app.js _searchTargetFor)
  // covers FortiGate hostname/serial lookup AND endpoint discovery hits as
  // part of its asset results. These hooks let the dropdown drive the map
  // page in place — pan-to-marker, optionally open the topology modal,
  // optionally highlight a specific endpoint via the modal's site-scoped
  // search. All return true on success so the caller can fall back to a
  // page navigation when the asset isn't on this map.
  window.polarisMapPanToAsset = function (assetId) {
    if (!assetId) return false;
    var site = siteCache.find(function (s) { return s.id === assetId; });
    if (!site) return false;
    if (focusSite(site) !== false) setStatus('Showing "' + (site.hostname || site.id) + '"');
    return true;
  };

  // Pan to a site, then open its topology modal — like clicking the
  // marker. When focusQuery is set (asset hostname / IP / MAC), the
  // topology modal's site-scoped search runs after load to pulse the
  // matching switch and let the operator see where that endpoint
  // plugs in.
  window.polarisMapOpenSiteTopology = function (siteId, focusQuery) {
    if (!siteId) return false;
    var site = siteCache.find(function (s) { return s.id === siteId; });
    if (!site) return false;
    // A gate in a hidden region has no pin, but its topology still opens —
    // search finds a hidden gate the same as any other.
    if (focusSite(site) !== false) setStatus('Showing "' + (site.hostname || site.id) + '"');
    // Slight delay so the marker pan-and-zoom animation has started
    // before the modal opens — feels like one continuous gesture.
    setTimeout(function () {
      openTopology(site.id, site.hostname || "");
      if (focusQuery) {
        // The topology modal builds its search async. Wait for the
        // input to exist + the topology data to load before populating
        // it. Bounded retry loop keeps this from hanging.
        var tries = 0;
        var iv = setInterval(async function () {
          tries++;
          var input = document.getElementById("topology-search-input");
          if (input && topoState.data) {
            input.value = focusQuery;
            await runTopologySearch(focusQuery, true);
            clearInterval(iv);
          } else if (tries > 40) { // ~4s max
            clearInterval(iv);
          }
        }, 100);
      }
    }, 400);
    return true;
  };

  // ─── Topology modal ───────────────────────────────────────────────────────
  function wireModal() {
    var overlay = document.getElementById("topology-overlay");
    var closeBtn = document.getElementById("topology-close");
    var fullscreenBtn = document.getElementById("topology-fullscreen");
    var refreshBtn = document.getElementById("topology-refresh");
    var legendCloseBtn = document.getElementById("topology-legend-close");
    var showFullBtn = document.getElementById("topology-show-full");
    var searchInput = document.getElementById("topology-search-input");
    closeBtn.addEventListener("click", closeTopology);
    // Export, and in edit mode Save / Reset layout, live on the map itself
    // (top-right corner) — see _ensureTopologyCornerTools, re-added with
    // every render.
    if (fullscreenBtn) fullscreenBtn.addEventListener("click", toggleFullscreenTopology);
    if (refreshBtn) refreshBtn.addEventListener("click", refreshTopology);
    // The legend sits in the graph's bottom-left corner and collapses into
    // its own button there (legend-toggle.js), its header × collapsing it
    // again — the Device Map / Application Map / Status Map pattern. The
    // open state is the existing per-browser legend pref.
    var legendOverlay = document.getElementById("topology-legend-overlay");
    if (legendOverlay && window.PolarisLegendToggle) {
      window.PolarisLegendToggle.attach(legendOverlay, {
        closeButton: legendCloseBtn,
        expanded: _readLegendPrefs().visible,
        onChange: function (expanded) {
          var prefs = _readLegendPrefs();
          prefs.visible = !!expanded;
          _writeLegendPrefs(prefs);
        },
      });
    }
    // Graph / details edge: hides and restores the details pane. The state is
    // a per-browser convenience; cytoscape re-measures once the column has
    // finished its 0.2s slide.
    var infoToggle = document.getElementById("topology-info-toggle");
    if (infoToggle) {
      var setInfoCollapsed = function (collapsed, save) {
        var layout = infoToggle.closest(".topology-layout");
        if (!layout) return;
        layout.classList.toggle("info-collapsed", collapsed);
        var label = collapsed ? "Show details" : "Hide details";
        infoToggle.title = label;
        infoToggle.setAttribute("aria-label", label);
        infoToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
        if (save) {
          try { localStorage.setItem("polaris.topology.infoCollapsed", collapsed ? "1" : "0"); } catch (e) { /* per-viewer */ }
          setTimeout(function () {
            if (cyInstance) { try { cyInstance.resize(); } catch (e) {} }
          }, 230);
        }
      };
      var startCollapsed = false;
      try { startCollapsed = localStorage.getItem("polaris.topology.infoCollapsed") === "1"; } catch (e) {}
      setInfoCollapsed(startCollapsed, false);
      infoToggle.addEventListener("click", function () {
        var layout = infoToggle.closest(".topology-layout");
        setInfoCollapsed(!(layout && layout.classList.contains("info-collapsed")), true);
      });
    }
    if (showFullBtn) showFullBtn.addEventListener("click", clearConnectionPathOverlay);
    if (searchInput) wireTopologySearch(searchInput);
    // Restore legend visibility on first open per page load so operators
    // who left it visible see it again the next time they pop the modal.
    renderTopologyLegend();
    // Intercept clicks on asset links in the topology right-bar so they open
    // the asset details slide-over instead of navigating away to assets.html.
    var infoPanel = document.getElementById("topology-info");
    if (infoPanel) {
      infoPanel.addEventListener("click", function (e) {
        var link = e.target.closest("a[href]");
        if (!link) return;
        var id = _assetIdFromTopoHref(link.getAttribute("href"));
        if (!id) return;
        e.preventDefault();
        openViewModal(id);
      });
    }
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        // Shared escalating flash + bloom (defined in app.js, loaded first).
        if (typeof flashModalCloseBtn === "function") flashModalCloseBtn(closeBtn);
      }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && overlay.classList.contains("open")) closeTopology();
      // Delete / Backspace removes the selected connection-path handles (a
      // bend goes; an end point returns to automatic). Never while typing.
      if ((e.key === "Delete" || e.key === "Backspace") && overlay.classList.contains("open") && edgeEditor) {
        var t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (edgeEditor.deleteSelected()) e.preventDefault();
      }
      // Ctrl+Z undo, Ctrl+Shift+Z / Ctrl+Y redo (⌘ on a Mac) — edit mode
      // only, never while typing.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && overlay.classList.contains("open") && topoState.editing) {
        var tt = e.target;
        if (tt && (tt.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(tt.tagName))) return;
        var k = (e.key || "").toLowerCase();
        if (k === "z" && !e.shiftKey) { e.preventDefault(); _layoutUndo(); }
        else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); _layoutRedo(); }
      }
    });
    // When the browser exits fullscreen via Esc / OS gesture, drop the
    // fullscreen class so the modal styling reverts cleanly.
    var onFullscreenChange = function () {
      var modal = overlay && overlay.querySelector(".modal");
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fsEl && modal) modal.classList.remove("topology-fullscreen");
      // Cytoscape needs a resize hint when the container size changes.
      if (cyInstance) { try { cyInstance.resize(); cyInstance.fit(undefined, 30); } catch (e) {} }
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
  }

  // Toggle native browser fullscreen for the topology modal. Fullscreen is
  // requested on the DOCUMENT root, not the modal element: a native-fullscreen
  // element paints above everything outside its own subtree, which buried the
  // asset details slide-over (a document.body child, z-index 1050) whenever a
  // node was opened from a fullscreened topology. With the whole document
  // fullscreen, normal z-index stacking applies and body-parented layers
  // (slide-overs, nested drilldowns, confirm modals, toasts) sit on top; the
  // topology-fullscreen class makes the modal fill the viewport. Falls back to
  // the CSS class alone when the Fullscreen API is unavailable or denied
  // (older Safari / iframe contexts).
  function toggleFullscreenTopology() {
    var overlay = document.getElementById("topology-overlay");
    var modal = overlay && overlay.querySelector(".modal");
    if (!modal) return;
    var root = document.documentElement;
    var nativeAvailable = !!(root.requestFullscreen || root.webkitRequestFullscreen);
    var cssToggleOff = function () {
      modal.classList.remove("topology-fullscreen");
      if (cyInstance) { try { cyInstance.resize(); cyInstance.fit(undefined, 30); } catch (e) {} }
    };
    if (nativeAvailable) {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        // The fullscreenchange handler drops the class + resizes cytoscape.
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else if (modal.classList.contains("topology-fullscreen")) {
        // A prior native request was denied and we're in CSS-only fullscreen.
        cssToggleOff();
      } else {
        modal.classList.add("topology-fullscreen");
        var p;
        try { p = (root.requestFullscreen || root.webkitRequestFullscreen).call(root); } catch (e) {}
        // Denied (e.g. no user-activation, iframe policy) → the class alone
        // still gives the CSS viewport-filling mode.
        if (p && typeof p.catch === "function") p.catch(function () {});
        if (cyInstance) { try { cyInstance.resize(); cyInstance.fit(undefined, 30); } catch (e) {} }
      }
    } else {
      modal.classList.toggle("topology-fullscreen");
      if (cyInstance) { try { cyInstance.resize(); cyInstance.fit(undefined, 30); } catch (e) {} }
    }
  }

  // Cytoscape ships a built-in cy.png() that respects the current layout/colors
  // and renders independently of the live <canvas>. We pull it as a Blob and
  // copy to the clipboard, mirroring the chart-screenshot UX in assets.js.
  // full:false — the viewport, not the whole graph: whatever the operator has
  // zoomed or panned out of view stays out of the picture (as every topology
  // and Application Map export does).
  // cy.png with the connection-path editing handles left out: they are
  // chrome for the operator dragging a line, not part of the drawing (the
  // PDF / Visio export skips them through their noExport flag).
  function _topologyPng(opts) {
    var handles = cyInstance.nodes("[isEdgeHandle]");
    handles.style("display", "none");
    try { return cyInstance.png(opts); }
    finally { handles.removeStyle("display"); }
  }
  function screenshotTopology() {
    if (!cyInstance) {
      if (typeof showToast === "function") showToast("Topology not loaded", "error");
      return;
    }
    var rootCs = getComputedStyle(document.documentElement);
    var bg = rootCs.getPropertyValue("--color-bg-primary").trim() ||
             rootCs.getPropertyValue("--color-surface").trim() || "#ffffff";
    var blob = _topologyPng({ output: "blob", scale: 2, full: false, bg: bg });
    if (!blob) {
      if (typeof showToast === "function") showToast("Screenshot failed", "error");
      return;
    }
    copyPngToClipboard(blob).then(function (ok) {
      if (typeof showToast === "function") showToast(ok ? "Topology copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
    });
  }

  // What the Export menu's PDF / Visio entries draw (graph-export.js): the
  // live graph exactly as laid out, read through the DAYLIGHT stylesheet —
  // paper is white whatever the theme — with the topology legend as the key.
  // Health and link colours come from the same legend spec the on-screen
  // legend draws, so the printed key cannot drift from it. Only what is in
  // the viewer (viewport: true → clipSceneToExtent): zoom in, and whatever
  // leaves the view leaves the export — and the device / link count with it.
  function topologyExportContext() {
    var R = window.PolarisTopologyRender;
    var titleEl = document.getElementById("topology-title");
    var site = titleEl ? (titleEl.textContent || "").trim() : "";
    var spec = R.topologyLegendSpec();
    // Links export through the daylight stylesheet below, so their key rows
    // take the light shades whatever theme is on screen. Location boxes keep
    // the on-screen family: their colours are per-node bypasses the export
    // reads as painted.
    var lightSpec = R.topologyLegendSpec("light");
    var keyItems = [];
    spec.health.forEach(function (h) { keyItems.push({ kind: "dot", color: h.color, fill: h.color, text: h.label }); });
    lightSpec.edges.forEach(function (e) { keyItems.push({ kind: "line", color: e.color, dashed: e.style === "dashed", text: e.label }); });
    spec.locations.forEach(function (l) { keyItems.push({ kind: "box", color: l.color, dashed: l.style === "dashed", text: l.label }); });
    var meta = [];
    var ext = cyInstance ? cyInstance.extent() : null;
    var inView = function (ele) {
      var b = ele.boundingBox({ includeLabels: false });
      return b.x2 >= ext.x1 && b.x1 <= ext.x2 && b.y2 >= ext.y1 && b.y1 <= ext.y2;
    };
    var nodes = cyInstance ? cyInstance.nodes(":visible").filter(function (n) { return !n.data("isLocGroup") && !n.data("isPortal") && !n.data("isEdgeHandle") && inView(n); }).length : 0;
    var links = cyInstance ? cyInstance.edges(":visible").filter(inView).length : 0;
    meta.push(nodes + " device" + (nodes === 1 ? "" : "s") + " · " + links + " link" + (links === 1 ? "" : "s"));
    var showFull = document.getElementById("topology-show-full");
    if (showFull && !showFull.hidden) meta.push("Narrowed to an endpoint search — the export shows the narrowed view");
    return {
      cy: cyInstance,
      lightStylesheet: R.topologyStylesheet("light", { includeEndpointOverlay: true }),
      title: "Site Topology" + (site && site !== "Site topology" ? " — " + site : ""),
      fileBase: "polaris-topology" + (site ? "-" + site.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") : ""),
      noun: "topology",
      metaLines: meta,
      keyItems: keyItems,
      viewport: true,
      scopeNote: "Exports what is in the viewer now — only the part of the topology on screen at the current zoom and pan — in its current layout.",
    };
  }

  // Whole-modal screenshot: the cytoscape map (cy.png) on the left, the info
  // panel rendered as text on the right, titled with the site. The map is a
  // canvas and the info panel is HTML, so we composite them onto one canvas
  // rather than rasterizing the live DOM (no html2canvas dependency).
  function screenshotTopologyModal() {
    if (!cyInstance) {
      if (typeof showToast === "function") showToast("Topology not loaded", "error");
      return;
    }
    var rootCs = getComputedStyle(document.documentElement);
    var pick = function (n, f) { var v = rootCs.getPropertyValue(n).trim(); return v || f; };
    var bg = pick("--color-bg-primary", pick("--color-surface", "#ffffff"));
    // The viewport only, as screenshotTopology.
    var uri = _topologyPng({ output: "base64uri", scale: 2, full: false, bg: bg });
    var mapImg = new Image();
    mapImg.onload = function () { _composeTopologyModalCanvas(mapImg, pick); };
    mapImg.onerror = function () {
      if (typeof showToast === "function") showToast("Screenshot failed", "error");
    };
    mapImg.src = uri;
  }

  // Extract the topology info-panel (#topology-info) into ordered blocks:
  //   { type: 'title',   text }            the <h4> FortiGate name
  //   { type: 'kv',      label, value }    the top .detail-row pairs
  //   { type: 'heading', text }            each .topology-section <h5>
  //   { type: 'item',    primary, meta, indent }  each <li> (expanded endpoint
  //                                        sub-lists are included, indented)
  function _extractTopologyInfoBlocks(infoEl) {
    var blocks = [];
    if (!infoEl) return blocks;
    var h4 = infoEl.querySelector("h4");
    if (h4) blocks.push({ type: "title", text: (h4.textContent || "").trim() });
    infoEl.querySelectorAll(":scope > .detail-row").forEach(function (dr) {
      var l = dr.querySelector(".label");
      var v = dr.querySelector(".value");
      blocks.push({
        type: "kv",
        label: (l ? l.textContent : "").trim(),
        value: (v ? v.textContent : "").trim(),
      });
    });
    function liText(li) {
      // Primary label = li text minus the trailing .meta span and any nested list.
      var clone = li.cloneNode(true);
      Array.prototype.forEach.call(clone.querySelectorAll(".meta, ul, details"), function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      return (clone.textContent || "").replace(/\s+/g, " ").trim();
    }
    infoEl.querySelectorAll(".topology-section").forEach(function (sec) {
      var h5 = sec.querySelector("h5");
      if (h5) blocks.push({ type: "heading", text: (h5.textContent || "").trim() });
      var topList = sec.querySelector(":scope > ul");
      if (!topList) return;
      Array.prototype.forEach.call(topList.children, function (li) {
        if (li.tagName !== "LI") return;
        var details = li.querySelector(":scope > details");
        if (details) {
          var summary = details.querySelector("summary");
          blocks.push({ type: "item", primary: summary ? (summary.textContent || "").trim() : "", meta: "", indent: 0 });
          if (details.hasAttribute("open")) {
            var subList = details.querySelector("ul");
            if (subList) {
              Array.prototype.forEach.call(subList.children, function (sub) {
                if (sub.tagName !== "LI") return;
                var subMeta = sub.querySelector(":scope > .meta");
                blocks.push({ type: "item", primary: liText(sub), meta: subMeta ? (subMeta.textContent || "").trim() : "", indent: 1 });
              });
            }
          }
          return;
        }
        var meta = li.querySelector(":scope > .meta");
        blocks.push({ type: "item", primary: liText(li), meta: meta ? (meta.textContent || "").trim() : "", indent: 0 });
      });
    });
    return blocks;
  }

  function _composeTopologyModalCanvas(mapImg, pick) {
    var bgPrimary = pick("--color-bg-primary", "#ffffff");
    var bgSurface = pick("--color-surface", "#f5f5f5");
    var clrBorder = pick("--color-border", "#e0e0e0");
    var clrText   = pick("--color-text-primary", "#111");
    var clrMuted  = pick("--color-text-tertiary", "#888");
    var accent    = pick("--color-accent", "#4fc3f7");

    var fontFamily = "system-ui,-apple-system,sans-serif";
    var scale = 2;
    var pad = 20;
    var gap = 24;
    var titleH = 40;
    var infoColW = 340;
    var lineH = 19;

    var titleEl = document.getElementById("topology-title");
    var title = titleEl ? (titleEl.textContent || "").trim() : "Site topology";

    var blocks = _extractTopologyInfoBlocks(document.getElementById("topology-info"));

    // cy.png is rendered at 2x; treat its logical size as half so text drawn at
    // 2x stays crisp alongside a near-native map.
    var mapLogW = mapImg.width / 2;
    var mapLogH = mapImg.height / 2;
    var maxMapW = 1100;
    var mapDrawW = Math.min(mapLogW, maxMapW);
    var mapDrawH = mapLogW ? mapLogH * (mapDrawW / mapLogW) : mapLogH;

    var measureCtx = document.createElement("canvas").getContext("2d");
    function fit(text, maxW, font) {
      measureCtx.font = font;
      var t = String(text == null ? "" : text);
      while (measureCtx.measureText(t).width > maxW && t.length > 3) t = t.slice(0, -4) + "…";
      return t;
    }

    // Measure info column height.
    var infoH = 0;
    blocks.forEach(function (b) {
      if (b.type === "title") infoH += 26;
      else if (b.type === "heading") infoH += 28;
      else infoH += lineH;
    });

    var contentH = Math.max(mapDrawH, infoH);
    var w = pad + mapDrawW + gap + infoColW + pad;
    var h = titleH + contentH + pad;

    var canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    var ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    ctx.fillStyle = bgPrimary;
    ctx.fillRect(0, 0, w, h);

    // Title.
    ctx.fillStyle = clrText;
    ctx.font = "bold 16px " + fontFamily;
    ctx.textBaseline = "alphabetic";
    ctx.fillText(fit(title, w - pad * 2, "bold 16px " + fontFamily), pad, 26);

    // Map.
    ctx.drawImage(mapImg, pad, titleH, mapDrawW, mapDrawH);
    ctx.strokeStyle = clrBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad + 0.5, titleH + 0.5, mapDrawW - 1, mapDrawH - 1);

    // Info column.
    var ix = pad + mapDrawW + gap;
    var iw = infoColW;
    var y = titleH;
    blocks.forEach(function (b) {
      if (b.type === "title") {
        ctx.fillStyle = accent;
        ctx.font = "bold 14px " + fontFamily;
        ctx.fillText(fit(b.text, iw, "bold 14px " + fontFamily), ix, y + 16);
        y += 26;
        return;
      }
      if (b.type === "heading") {
        y += 8;
        ctx.fillStyle = clrMuted;
        ctx.font = "600 10px " + fontFamily;
        ctx.fillText(fit(b.text.toUpperCase(), iw, "600 10px " + fontFamily), ix, y + 12);
        y += 20;
        return;
      }
      if (b.type === "kv") {
        ctx.fillStyle = clrMuted;
        ctx.font = "11px " + fontFamily;
        ctx.fillText(fit(b.label, 110, "11px " + fontFamily), ix, y + 14);
        ctx.fillStyle = clrText;
        ctx.font = "12px " + fontFamily;
        ctx.textAlign = "right";
        ctx.fillText(fit(b.value || "—", iw - 120, "12px " + fontFamily), ix + iw, y + 14);
        ctx.textAlign = "left";
        y += lineH;
        return;
      }
      // item
      var indentX = ix + (b.indent ? 14 : 0);
      ctx.fillStyle = clrText;
      ctx.font = "12px " + fontFamily;
      measureCtx.font = "11px " + fontFamily;
      var metaW = b.meta ? measureCtx.measureText(b.meta).width + 12 : 0;
      ctx.fillText(fit(b.primary, iw - (indentX - ix) - metaW, "12px " + fontFamily), indentX, y + 14);
      if (b.meta) {
        ctx.fillStyle = clrMuted;
        ctx.font = "11px " + fontFamily;
        ctx.textAlign = "right";
        ctx.fillText(fit(b.meta, iw - 60, "11px " + fontFamily), ix + iw, y + 14);
        ctx.textAlign = "left";
      }
      y += lineH;
    });

    canvas.toBlob(function (blob) {
      if (!blob) { if (typeof showToast === "function") showToast("Screenshot failed", "error"); return; }
      copyPngToClipboard(blob).then(function (ok) {
        if (typeof showToast === "function") showToast(ok ? "Topology view copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
      });
    }, "image/png");
  }

  async function openTopology(id, hostname) {
    var overlay = document.getElementById("topology-overlay");
    document.getElementById("topology-title").textContent = hostname || "Site topology";
    // Wipe the graph container but keep the legend overlay alive — it's
    // static markup shipped inside #topology-graph (map.html), so a plain
    // innerHTML wipe would destroy it and every later legend toggle would
    // silently no-op. Detach + re-append preserves its event listeners
    // (close button, header drag).
    var graphEl = document.getElementById("topology-graph");
    var legendEl = document.getElementById("topology-legend-overlay");
    graphEl.innerHTML = "";
    if (legendEl) graphEl.appendChild(legendEl);
    document.getElementById("topology-info").innerHTML = '<p class="muted">Loading…</p>';
    var searchInput = document.getElementById("topology-search-input");
    if (searchInput) searchInput.value = "";
    closeTopologySearchResults();
    overlay.classList.add("open");
    overlay.setAttribute("aria-hidden", "false");
    topoState.siteId = id;
    topoState.hostname = hostname || null;
    topoState.data = null;
    topoState.activeView = "flat";
    topoState.floorViews = [];
    topoState.editing = false;

    try {
      var data = await api.map.topology(id);
      topoState.data = data;
      renderTopologyGraph(data);
      renderTopologyInfo(data);
    } catch (err) {
      document.getElementById("topology-info").innerHTML =
        '<p class="error">Failed to load topology: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p>';
    }
  }

  // Re-fetch + re-render WITHOUT destroying the cytoscape instance up
  // front. We capture current node positions before tear-down so the new
  // graph keeps the operator's manual layout where possible.
  async function refreshTopology(opts) {
    if (!topoState.siteId) return;
    // Strict === true so a click listener passing its MouseEvent can't
    // accidentally silence the toast.
    var silent = !!(opts && opts.silent === true);
    var btn = document.getElementById("topology-refresh");
    if (btn) btn.disabled = true;
    try {
      // Snapshot positions for any nodes that survive the refresh, and land
      // any pending server save BEFORE re-fetching — the fresh payload's
      // savedLayouts embed must reflect it or the re-render would restore
      // the server's stale (pre-drag) layout over the operator's moves.
      if (cyInstance) saveNodePositions(topoState.siteId);
      await _flushServerLayoutSaves();
      var data = await api.map.topology(topoState.siteId);
      topoState.data = data;
      renderTopologyGraph(data);
      renderTopologyInfo(data);
      if (!silent && typeof showToast === "function") showToast("Topology refreshed");
    } catch (err) {
      if (typeof showToast === "function") {
        showToast("Refresh failed — " + (err && err.message ? err.message : String(err)), "error");
      }
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // == Save / Reset ========================================================
  // Drags persist on their own (debounced, shared), which is the layout
  // everyone sees but not a decision anyone made. Save stamps the current
  // arrangement as a RESTORE POINT, and that is what gives Reset two
  // meanings: back to the last save, or back to the column solver's baseline.
  //
  // Both stores mirror the live-position ones: the server row's
  // `savedPositions` for a deviceMap writer (shared with every operator),
  // localStorage for everyone else — a non-writer's drags are already
  // local-only, so their restore point is too.
  function _checkpointStorageKey(siteId) {
    var view = _activeViewKey();
    return CHECKPOINT_STORAGE_PREFIX + siteId + (view !== "flat" ? ":" + view : "");
  }
  // The active view's restore point, or null when it was never saved. Server
  // wins over localStorage, the same precedence loadNodePositions uses — a
  // shared save is the one the whole team agreed on.
  function _readCheckpoint(siteId) {
    if (!siteId) return null;
    var layouts = topoState.data && topoState.data.savedLayouts;
    var server = layouts && layouts[_activeViewKey()];
    if (server && server.savedPositions && typeof server.savedPositions === "object") {
      return {
        positions: server.savedPositions,
        savedAt:   server.savedAt || null,
        savedBy:   server.savedBy || null,
        shared:    true,
      };
    }
    try {
      var raw = localStorage.getItem(_checkpointStorageKey(siteId));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (!parsed.positions || typeof parsed.positions !== "object") return null;
      return { positions: parsed.positions, savedAt: parsed.savedAt || null, savedBy: null, shared: false };
    } catch (e) { return null; }
  }
  function _writeLocalCheckpoint(siteId, positions) {
    try {
      localStorage.setItem(_checkpointStorageKey(siteId), JSON.stringify({
        positions: positions,
        savedAt: new Date().toISOString(),
      }));
    } catch (e) { /* quota / private mode — the server copy (if any) still stands */ }
  }
  // Current on-canvas positions of the real nodes. Synthetic overlays (hulls,
  // floor portals, path handles) are derived every render, so persisting
  // them would pin stale geometry onto ids the next render rebuilds.
  // Operator-drawn connection paths ride the same blob as `edgepath:` entries
  // (topology-edge-editor.js), which is how Save / Reset cover them too.
  function _currentNodePositions() {
    if (!cyInstance) return null;
    var out = {};
    var count = 0;
    cyInstance.nodes().forEach(function (n) {
      if (n.data("isLocGroup") || n.data("isPortal") || n.data("isEdgeHandle")) return;
      var p = n.position();
      if (p && typeof p.x === "number" && typeof p.y === "number") {
        out[n.id()] = { x: p.x, y: p.y };
        count++;
      }
    });
    if (edgeEditor) {
      // The server refuses a blob over its node cap outright, so path
      // entries past it are left out rather than losing the whole save.
      var paths = edgeEditor.serialize();
      Object.keys(paths).forEach(function (k) {
        if (count >= TOPO_LAYOUT_MAX_ENTRIES) return;
        out[k] = paths[k];
        count++;
      });
    }
    return out;
  }
  // A connection-path overlay parks the graph in a temporary tight chain the
  // operator never arranged, which is why every other persistence path skips
  // it too. Saving or restoring there would stamp (or overwrite) a restore
  // point with scaffolding.
  function _layoutActionBlockedByOverlay() {
    if (!topoState.pathOverlay) return false;
    if (typeof showToast === "function") showToast("Clear the connection path first — those positions are temporary");
    return true;
  }
  function _checkpointLabel(cp) {
    if (!cp) return "";
    var when = "";
    if (cp.savedAt) {
      var d = new Date(cp.savedAt);
      if (!isNaN(d.getTime())) when = d.toLocaleString();
    }
    var who = cp.shared && cp.savedBy ? " by " + cp.savedBy : "";
    if (!when && !who) return cp.shared ? "shared save" : "saved in this browser";
    return (when || "saved") + who;
  }
  // Keep the toolbar honest about what the active view can do: the Save
  // tooltip says where the save will land, the Reset tooltip says whether
  // there is a restore point to go back to. Re-run on every render and after
  // each save / reset, since both answers are per view.
  function _refreshLayoutToolbar() {
    var saveBtn = document.getElementById("topology-save-layout");
    var resetBtn = document.getElementById("topology-reset-layout");
    var cp = topoState.siteId ? _readCheckpoint(topoState.siteId) : null;
    if (saveBtn) {
      saveBtn.disabled = !topoState.siteId || !cyInstance;
      _setCornerTip(saveBtn, "Save layout", _canWriteServerLayout()
        ? "Save this layout as a restore point (shared with everyone)"
        : "Save this layout as a restore point (this browser only)");
    }
    if (resetBtn) {
      _setCornerTip(resetBtn, "Reset layout", cp
        ? "Back to the last save (" + _checkpointLabel(cp) + ") or to the automatic layout"
        : "Back to the automatic layout");
    }
  }

  // Explicit Save. Lands the live positions through the normal pipeline first
  // (so the shared layout and this browser agree), then stamps them as the
  // restore point. The server write carries the positions itself rather than
  // checkpointing whatever the row happens to hold, because the debounced drag
  // PUT may not have landed yet and a restore point of a layout the server
  // never stored would restore a state nobody displayed.
  async function saveTopologyLayoutCheckpoint() {
    if (!topoState.siteId || !cyInstance) return;
    if (_layoutActionBlockedByOverlay()) return;
    var view = _activeViewKey();
    var positions = _currentNodePositions();
    if (!positions) return;
    var btn = document.getElementById("topology-save-layout");
    if (btn) btn.disabled = true;
    try {
      saveNodePositions(topoState.siteId);
      _writeLocalCheckpoint(topoState.siteId, positions);
      if (!_canWriteServerLayout()) {
        // A non-writer cannot touch the shared row at all, so say where the
        // save actually went instead of implying the team now sees it.
        if (typeof showToast === "function") {
          showToast("Layout saved in this browser — saving it for everyone requires Device Map write access");
        }
        return;
      }
      await _flushServerLayoutSaves();
      var saved = await api.map.saveTopologyCheckpoint(topoState.siteId, view, positions);
      if (topoState.data) {
        if (!topoState.data.savedLayouts) topoState.data.savedLayouts = {};
        topoState.data.savedLayouts[view] = {
          view: view,
          positions: positions,
          savedPositions: positions,
          savedAt: (saved && saved.savedAt) || new Date().toISOString(),
          savedBy: (saved && saved.savedBy) || null,
        };
      }
      if (typeof showToast === "function") showToast("Layout saved");
    } catch (err) {
      if (typeof showToast === "function") {
        showToast("Layout not saved — " + (err && err.message ? err.message : String(err)), "error");
      }
    } finally {
      if (btn) btn.disabled = false;
      _refreshLayoutToolbar();
    }
  }

  // Reset menu. Two destinations, and the last-save entry is DISABLED (with
  // the reason in its tooltip) rather than hidden when this view was never
  // saved — a menu whose shape changes is harder to learn than one whose
  // entries grey out.
  function openResetLayoutMenu(anchor) {
    if (!topoState.siteId || !topoState.data) return;
    if (typeof showRowMenu !== "function") { resetTopologyLayoutToBaseline(); return; }
    var cp = _readCheckpoint(topoState.siteId);
    showRowMenu(anchor, [
      { heading: "Reset layout" },
      {
        label: cp ? "Reset to last save (" + _checkpointLabel(cp) + ")" : "Reset to last save",
        title: cp
          ? "Put every node back where it was when this layout was last saved"
          : "This view has never been saved — use Save first",
        disabled: !cp,
        onSelect: restoreTopologyLayoutCheckpoint,
      },
      {
        label: "Reset to baseline",
        title: "Discard manual node positions and re-run the automatic layout"
             + (cp ? " — the saved restore point is kept" : ""),
        danger: true,
        onSelect: resetTopologyLayoutToBaseline,
      },
    ], { label: "Reset layout", align: "end" });
  }

  // Put the active view back to its restore point. The checkpoint blob becomes
  // the live layout through the normal save pipeline, so it propagates to both
  // stores exactly like a drag would — and the restore point itself survives,
  // because an operator who restores once usually wants to be able to do it
  // again after the next experiment.
  function restoreTopologyLayoutCheckpoint() {
    if (!topoState.siteId || !topoState.data) return;
    if (_layoutActionBlockedByOverlay()) return;
    var cp = _readCheckpoint(topoState.siteId);
    if (!cp) {
      if (typeof showToast === "function") showToast("This view has no saved layout yet");
      return;
    }
    var view = _activeViewKey();
    // Copy rather than alias: the restore point must survive the live blob
    // being rewritten by the next drag.
    var positions = {};
    Object.keys(cp.positions).forEach(function (id) {
      var p = cp.positions[id];
      if (p && typeof p.x === "number" && typeof p.y === "number") positions[id] = { x: p.x, y: p.y };
    });
    try { localStorage.setItem(_positionsStorageKey(topoState.siteId), JSON.stringify(positions)); }
    catch (e) { /* quota / private mode — the in-memory render below still applies */ }
    var layouts = topoState.data.savedLayouts;
    var entry = layouts && layouts[view];
    if (entry) {
      entry.positions = positions;
    } else if (cp.shared) {
      if (!topoState.data.savedLayouts) topoState.data.savedLayouts = {};
      topoState.data.savedLayouts[view] = {
        view: view, positions: positions,
        savedPositions: cp.positions, savedAt: cp.savedAt, savedBy: cp.savedBy,
      };
    }
    // Writers push the restored layout back to the shared row; a non-writer
    // only ever had the local copy, which the setItem above already updated.
    if (_canWriteServerLayout()) {
      _markLayoutDirty();
      _queueServerLayoutSave(topoState.siteId, view, positions);
    }
    renderTopologyGraph(topoState.data);
    if (typeof showToast === "function") showToast("Layout restored to the last save");
  }

  // Drop the manual node positions for this view and re-run the column layout
  // against the cached topology data — used when drags have produced a layout
  // the operator wants to abandon (e.g. positions inherited from before a
  // column-spacing change). Clears BOTH position stores: the per-browser
  // localStorage copy and, for deviceMap writers, the shared server one. A
  // non-writer can only clear their local copy — the shared layout re-asserts
  // on their next open. The RESTORE POINT is deliberately untouched in either
  // store, so going back to the last save stays available afterwards.
  function resetTopologyLayoutToBaseline() {
    if (!topoState.siteId || !topoState.data) return;
    // Scoped to the ACTIVE view — resetting a floor view's drags leaves the
    // Flat layout (and every other floor's) untouched.
    var view = _activeViewKey();
    try { localStorage.removeItem(_positionsStorageKey(topoState.siteId)); }
    catch (e) { /* quota / private mode — proceed with re-render anyway */ }
    delete _layoutDirty[topoState.siteId + "|" + view];
    var entry = topoState.data.savedLayouts && topoState.data.savedLayouts[view];
    // An emptied row (a previous baseline reset that kept its restore point)
    // is not a shared layout to be re-asserted, so it must not trip the
    // non-writer refusal below.
    var hadServerLayout = !!(entry && entry.positions && Object.keys(entry.positions).length > 0);
    if (hadServerLayout && !_canWriteServerLayout()) {
      // The shared layout would simply re-assert on re-render — tell the
      // operator why nothing moved instead of pretending to reset.
      if (typeof showToast === "function") {
        showToast("Shared layout kept — resetting it requires Device Map write access");
      }
      return;
    }
    if (entry) {
      // Mirror the server: a row carrying a restore point is EMPTIED, not
      // dropped, so _readCheckpoint can still offer it. An empty positions
      // blob restores nothing at render, which is the baseline.
      if (entry.savedPositions) entry.positions = {};
      else delete topoState.data.savedLayouts[view];
    }
    if (hadServerLayout) {
      api.map.deleteTopologyLayout(topoState.siteId, view).catch(function (err) {
        if (typeof showToast === "function") {
          showToast("Server layout not reset — " + (err && err.message ? err.message : String(err)), "error");
        }
      });
    }
    renderTopologyGraph(topoState.data);
    if (typeof showToast === "function") showToast("Layout reset to baseline");
  }

  // ── Right-click description editor ──────────────────────────────────────
  // cxttap on an asset-backed node opens a small modal editing
  // Asset.description in place — the fast path for stamping the location
  // codes (a:/b:/f:/r:/jb:) that drive grouping hulls, row clustering, and
  // the building/floor switcher. Saves through the normal PUT /assets/:id
  // pathway (so description sync to the device applies when the integration
  // has it on), then silently refreshes the topology so the server
  // re-resolves each node's effective codes.
  async function openTopologyDescriptionEditor(assetId) {
    if (typeof canManageAssets === "function" && !canManageAssets()) {
      if (typeof showToast === "function") showToast("Editing assets requires write access", "error");
      return;
    }
    if (typeof openModal !== "function") return;
    var asset;
    try {
      asset = await api.assets.get(assetId);
    } catch (err) {
      if (typeof showToast === "function") {
        showToast("Failed to load asset — " + (err && err.message ? err.message : String(err)), "error");
      }
      return;
    }
    var name = asset.hostname || asset.dnsName || asset.ipAddress || "asset";
    // Same warn-never-limit posture as the asset edit form: a FortiAP's
    // description pushes to the short device `location` field, and this editor
    // is the fast path for stamping location codes into exactly that field.
    var descTarget = typeof descriptionDeviceTarget === "function"
      ? descriptionDeviceTarget(asset) : null;
    var bodyHtml =
      '<label for="topo-desc-input" style="display:block;margin-bottom:6px;font-size:0.9rem">Description</label>' +
      '<textarea id="topo-desc-input" maxlength="255" rows="3" ' +
        'style="width:100%;resize:vertical;padding:6px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);color:var(--color-text-primary)">' +
        escapeHtml(asset.description || "") + '</textarea>' +
      (descTarget && typeof descriptionCapWarningHTML === "function"
        ? descriptionCapWarningHTML(descTarget, "topo-desc-cap-warn") : '') +
      '<div style="margin-top:10px;font-size:0.8rem;color:var(--color-text-secondary)">' +
        'Device grouping shortcuts — include anywhere in the description:' +
        '<div style="margin-top:4px;font-family:monospace">' +
          'a:<i>Area</i> &nbsp; b:<i>Building</i> &nbsp; f:<i>Floor</i> &nbsp; r:<i>Room</i> &nbsp; jb:<i>Junction box</i>' +
        '</div>' +
        '<div style="margin-top:4px;color:var(--color-text-tertiary)">' +
          'e.g. <code>a:Mine b:Shop f:2 r:North Closet jb:112-305</code> — a value runs until the ' +
          'next code, so multi-word names need no quotes. Codes in the asset’s Notes override ' +
          'the same code here.' +
        '</div>' +
        (typeof locationCodesDiagramHTML === "function" ? locationCodesDiagramHTML() : '') +
      '</div>';
    var footer =
      '<button type="button" class="btn btn-secondary" id="topo-desc-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary" id="topo-desc-save">Save</button>';
    openModal("Edit Description — " + name, bodyHtml, footer);
    setTimeout(function () {
      var input = document.getElementById("topo-desc-input");
      var cancel = document.getElementById("topo-desc-cancel");
      var save = document.getElementById("topo-desc-save");
      if (input) input.focus();
      if (typeof wireDescriptionCapWarning === "function") {
        wireDescriptionCapWarning("topo-desc-input", "topo-desc-cap-warn");
      }
      if (cancel) cancel.addEventListener("click", function () {
        if (typeof closeModal === "function") closeModal();
      });
      if (save) save.addEventListener("click", async function () {
        save.disabled = true;
        try {
          await api.assets.update(assetId, { description: input ? input.value.trim() : "" });
          if (typeof closeModal === "function") closeModal();
          if (typeof showToast === "function") showToast("Description saved");
          refreshTopology({ silent: true });
        } catch (err) {
          save.disabled = false;
          if (typeof showToast === "function") {
            showToast("Save failed — " + (err && err.message ? err.message : String(err)), "error");
          }
        }
      });
    }, 0);
  }

  // ── Legend overlay ────────────────────────────────────────────────────────
  function _readLegendPrefs() {
    try {
      var raw = localStorage.getItem(LEGEND_STORAGE_KEY);
      if (!raw) return { visible: false, x: null, y: null };
      var p = JSON.parse(raw);
      return { visible: !!p.visible, x: (typeof p.x === "number" ? p.x : null), y: (typeof p.y === "number" ? p.y : null) };
    } catch (e) { return { visible: false, x: null, y: null }; }
  }
  function _writeLegendPrefs(prefs) {
    try { localStorage.setItem(LEGEND_STORAGE_KEY, JSON.stringify(prefs)); } catch (e) {}
  }
  function renderTopologyLegend() {
    var el = document.getElementById("topology-legend-overlay");
    if (!el) return;
    // Open/closed is legend-toggle.js's (wired above); this only fills the
    // body once and shows the panel.
    var spec = (window.PolarisTopologyRender && window.PolarisTopologyRender.topologyLegendSpec)
      ? window.PolarisTopologyRender.topologyLegendSpec() : null;
    if (!spec) { el.hidden = true; return; }
    var body = document.getElementById("topology-legend-body");
    if (body && !body.dataset.rendered) {
      body.innerHTML = _buildLegendHTML(spec);
      body.dataset.rendered = "1";
    }
    el.hidden = false;
    // Always the CSS-anchored bottom-left corner, like every map legend: it
    // is no longer dragged, so a position an older build saved is ignored.
    el.style.left = ""; el.style.top = "";
  }
  function _buildLegendHTML(spec) {
    function nodeSwatch(row) {
      var size = row.size === "lg" ? 22 : (row.size === "sm" ? 14 : 18);
      var border = row.border ? row.border : "rgba(255,255,255,0.85)";
      var borderStyle = row.borderStyle === "dashed" ? "dashed" : "solid";
      var fill = row.fill === "data(nodeColor)" ? window.PolarisTopologyRender.HEALTH_NODE_COLORS.up : row.fill;
      var shape = "";
      if (row.kind === "diamond") {
        shape = '<div style="width:' + size + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';transform:rotate(45deg)"></div>';
      } else if (row.kind === "round-rectangle") {
        shape = '<div style="width:' + (size + 8) + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';border-radius:4px"></div>';
      } else {
        shape = '<div style="width:' + size + 'px;height:' + size + 'px;background:' + fill +
                ';border:2px ' + borderStyle + ' ' + border + ';border-radius:50%"></div>';
      }
      return '<span class="topology-legend-swatch">' + shape + '</span>';
    }
    function edgeSwatch(row) {
      var dash = row.style === "dashed" ? "4 3" : "0";
      return '<span class="topology-legend-swatch">' +
        '<svg width="28" height="12" viewBox="0 0 28 12" aria-hidden="true">' +
          '<line x1="2" y1="6" x2="26" y2="6" stroke="' + row.color +
          '" stroke-width="2.4" stroke-dasharray="' + dash + '" stroke-linecap="round"/>' +
        '</svg></span>';
    }
    function healthSwatch(row) {
      return '<span class="topology-legend-swatch">' +
        '<div style="width:14px;height:14px;background:' + row.color +
        ';border-radius:50%;border:2px solid rgba(255,255,255,0.85)"></div></span>';
    }
    function row(swatchHtml, label, desc) {
      var html = '<div class="topology-legend-row">' + swatchHtml +
                 '<span class="topology-legend-label">' + escapeHtml(label) + '</span></div>';
      if (desc) html += '<div class="topology-legend-desc">' + escapeHtml(desc) + '</div>';
      return html;
    }
    // Location grouping hull swatches — every level is a rounded rectangle
    // with a FIXED per-level color + solid/dashed border, mirroring
    // LOC_GROUP_KINDS in topology-render.js.
    function locationSwatch(rowSpec) {
      var color = rowSpec.color || "#4fc3f7";
      var borderStyle = rowSpec.style === "dashed" ? "dashed" : "solid";
      var shape = '<div style="width:22px;height:16px;background:' + color + '22;border:2px ' +
        borderStyle + ' ' + color + ';border-radius:4px"></div>';
      return '<span class="topology-legend-swatch">' + shape + '</span>';
    }
    var parts = [];
    parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Nodes</div>');
    spec.nodes.forEach(function (n) { parts.push(row(nodeSwatch(n), n.label, n.desc)); });
    parts.push('</div>');
    parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Monitor health</div>');
    spec.health.forEach(function (h) { parts.push(row(healthSwatch(h), h.label)); });
    parts.push('</div>');
    parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Edges</div>');
    spec.edges.forEach(function (e) { parts.push(row(edgeSwatch(e), e.label, e.desc)); });
    parts.push('</div>');
    if (spec.locations) {
      parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Location groups</div>');
      spec.locations.forEach(function (l) { parts.push(row(locationSwatch(l), l.label, l.desc)); });
      parts.push('</div>');
    }
    // Mouse controls are a property of THIS desktop modal (cytoscape wiring
    // in map.js), not of the shared render spec — the mobile topology tab
    // has its own touch gestures.
    parts.push('<div class="topology-legend-section"><div class="topology-legend-section-title">Mouse controls</div>');
    [
      ["Drag empty space", "Pan the view (scroll wheel zooms)"],
      ["Click", "Select just that device, link or location box"],
      ["Shift + click", "Add to the selection"],
      ["Shift + drag", "Box-select multiple devices"],
      ["Ctrl + drag", "Pan from anywhere (even over devices)"],
      ["Edit (pencil, top right)", "Turn on layout editing — the rows below; the check mark ends it"],
      ["Drag a selected device", "Edit mode: move the selected devices together"],
      ["Drag a connection line", "Edit mode: add a bend point there and move it"],
      ["Click a connection line", "Edit mode: show its points — drag an end point around a device to attach the line there"],
      ["Delete", "Edit mode: remove the selected bend point (an end point goes back to automatic)"],
      ["Ctrl + Z / Ctrl + Shift + Z", "Edit mode: undo / redo a layout change (also the arrows under Edit)"],
      ["Grid (top right)", "Edit mode: show the grid — thick lines where devices snap, thin lines in between"],
      ["Snap devices / Snap line points", "Edit mode: devices land on the thick lines; line points on any line"],
      ["Double-click a device", "Open its asset details"],
      ["Right-click a device", "Edit its description / grouping codes"],
    ].forEach(function (c) { parts.push(row("", c[0], c[1])); });
    parts.push('</div>');
    return parts.join("");
  }

  // ── Position persistence ───────────────────────────────────────────────────
  // Per-site, per-view node positions ({ nodeId: {x, y} } pixel model coords).
  // Two stores, server-first:
  //   1. SERVER (shared): the TopologyLayout rows embedded in the /topology
  //      payload as `savedLayouts[view]` — the hand-tuned map every operator
  //      sees. Written via debounced PUT, gated deviceMap=write client-side
  //      (permAtLeast) so readonly viewers never emit 403 noise.
  //   2. localStorage (per-browser fallback/cache): the pre-server store,
  //      still written on every save — it's what a NON-writer's drags land
  //      in, and it seeds the server the first time a writer saves a site
  //      that predates server layouts.
  // Load order: server → localStorage → solver default. localStorage keying:
  // the Flat view keeps the legacy bare key for back-compat; floor views
  // append ":<viewKey>". The server always uses the explicit "flat" key.
  // Stale entries (nodes that left the topology) are silently dropped on the
  // next save in both stores. Server writes only happen after a real drag
  // (the dirty flag below) — open/close/refresh alone never PUTs, so the
  // solver's automatic layout keeps improving for untouched sites.
  function _activeViewKey() {
    return topoState.activeView && topoState.activeView !== "flat" ? topoState.activeView : "flat";
  }
  function _positionsStorageKey(siteId) {
    var view = _activeViewKey();
    return POSITION_STORAGE_PREFIX + siteId + (view !== "flat" ? ":" + view : "");
  }
  function _canWriteServerLayout() {
    return typeof permAtLeast === "function" && permAtLeast("deviceMap", "write");
  }
  // Views whose positions changed via an actual operator gesture (drag /
  // hull drag / snap-all) since their last queued server save. Keyed by
  // "<siteId>|<view>" so a pending flag can't leak across sites.
  var _layoutDirty = {};
  function _markLayoutDirty() {
    if (!topoState.siteId) return;
    _layoutDirty[topoState.siteId + "|" + _activeViewKey()] = true;
  }
  // Debounced server save, one timer per (site, view). The in-memory
  // savedLayouts cache is updated immediately so re-renders inside this
  // session (view switches, Locations toggle) see the latest positions even
  // before the PUT lands.
  var _serverSaveTimers = {};
  function _queueServerLayoutSave(siteId, view, positions) {
    if (!_canWriteServerLayout()) return;
    var dirtyKey = siteId + "|" + view;
    if (!_layoutDirty[dirtyKey]) return;
    delete _layoutDirty[dirtyKey];
    if (topoState.data && topoState.siteId === siteId) {
      if (!topoState.data.savedLayouts) topoState.data.savedLayouts = {};
      // MERGE, never replace: the entry also carries this view's restore
      // point (savedPositions / savedAt / savedBy), which a drag must not
      // clear — the server does not, and the two must agree or "Reset to
      // last save" would grey out until the next topology fetch.
      var prev = topoState.data.savedLayouts[view] || {};
      prev.view = view;
      prev.positions = positions;
      topoState.data.savedLayouts[view] = prev;
    }
    if (_serverSaveTimers[dirtyKey]) clearTimeout(_serverSaveTimers[dirtyKey].timer);
    var entry = {
      run: function () {
        delete _serverSaveTimers[dirtyKey];
        return api.map.saveTopologyLayout(siteId, view, positions).catch(function (err) {
          if (typeof showToast === "function") {
            showToast("Layout not saved to server — kept locally (" + (err && err.message ? err.message : String(err)) + ")", "error");
          }
        });
      },
    };
    entry.timer = setTimeout(entry.run, 1000);
    _serverSaveTimers[dirtyKey] = entry;
  }
  // Fire any pending debounced PUTs immediately (close / view switch /
  // refresh would otherwise race or drop the trailing save). Returns a
  // promise so refreshTopology can await the write before re-fetching the
  // payload (whose savedLayouts embed must include it).
  function _flushServerLayoutSaves() {
    var pending = [];
    Object.keys(_serverSaveTimers).forEach(function (key) {
      var entry = _serverSaveTimers[key];
      clearTimeout(entry.timer);
      pending.push(entry.run());
    });
    return Promise.all(pending);
  }
  function saveNodePositions(siteId) {
    if (!cyInstance || !siteId) return;
    // Shared with the explicit Save so the two can never disagree about
    // which nodes are persistable.
    var out = _currentNodePositions();
    if (!out) return;
    try { localStorage.setItem(_positionsStorageKey(siteId), JSON.stringify(out)); }
    catch (e) { /* quota / private mode — silently skip */ }
    _queueServerLayoutSave(siteId, _activeViewKey(), out);
  }
  function loadNodePositions(siteId) {
    if (!siteId) return null;
    // Server layout wins — it's the shared map. localStorage remains the
    // per-browser fallback (non-writer drags, pre-server installs).
    var layouts = topoState.data && topoState.data.savedLayouts;
    var server = layouts && layouts[_activeViewKey()];
    if (server && server.positions && typeof server.positions === "object") {
      return server.positions;
    }
    try {
      var raw = localStorage.getItem(_positionsStorageKey(siteId));
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) { return null; }
  }

  // ── Topology search (slice 2) ──────────────────────────────────────────────
  function wireTopologySearch(input) {
    input.addEventListener("input", function () {
      if (topoSearchDebounce) { clearTimeout(topoSearchDebounce); topoSearchDebounce = null; }
      var q = input.value.trim();
      if (!q) { closeTopologySearchResults(); return; }
      topoSearchDebounce = setTimeout(function () { runTopologySearch(q); }, 200);
    });
    input.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeTopologySearchResults(); input.blur(); return; }
      if (!topoSuggestState.open) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        topoSuggestState.index = Math.min(topoSuggestState.items.length - 1, topoSuggestState.index + 1);
        paintTopologySearchResults();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        topoSuggestState.index = Math.max(0, topoSuggestState.index - 1);
        paintTopologySearchResults();
      } else if (e.key === "Enter") {
        e.preventDefault();
        var pick = topoSuggestState.items[topoSuggestState.index];
        if (pick) handleTopologySearchPick(pick);
      }
    });
    document.addEventListener("click", function (e) {
      var box = document.getElementById("topology-search-results");
      if (!box) return;
      if (e.target === input || (box.contains && box.contains(e.target))) return;
      closeTopologySearchResults();
    });
  }

  async function runTopologySearch(q, autoSelect) {
    if (!topoState.siteId) return;
    try {
      var resp = await api.map.topologySearch(topoState.siteId, q);
      topoSuggestState.items = (resp && resp.results) || [];
      topoSuggestState.index = topoSuggestState.items.length > 0 ? 0 : -1;
      topoSuggestState.open = true;
      paintTopologySearchResults();
      if (autoSelect && topoSuggestState.items.length > 0) {
        handleTopologySearchPick(topoSuggestState.items[0]);
      }
    } catch (err) {
      topoSuggestState.items = [];
      topoSuggestState.index = -1;
      topoSuggestState.open = true;
      paintTopologySearchResults();
    }
  }

  function paintTopologySearchResults() {
    var box = document.getElementById("topology-search-results");
    if (!box) return;
    box.innerHTML = "";
    box.hidden = !topoSuggestState.open;
    if (!topoSuggestState.open) return;
    if (topoSuggestState.items.length === 0) {
      var li = document.createElement("li");
      li.className = "empty";
      li.textContent = "No endpoints matched in this site.";
      box.appendChild(li);
      return;
    }
    topoSuggestState.items.forEach(function (item, i) {
      var li = document.createElement("li");
      li.setAttribute("role", "option");
      if (i === topoSuggestState.index) li.classList.add("active");
      var primary = item.hostname || item.ipAddress || item.macAddress || "(unnamed)";
      var bits = [];
      if (item.ipAddress)   bits.push(item.ipAddress);
      if (item.macAddress)  bits.push(item.macAddress);
      if (item.assignedTo)  bits.push(item.assignedTo);
      bits.push(item.switchHostname + (item.port ? "/" + item.port : ""));
      li.innerHTML =
        '<div>' + escapeHtml(primary) + '</div>' +
        '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span>';
      li.addEventListener("mousedown", function (e) {
        e.preventDefault();
        handleTopologySearchPick(item);
      });
      box.appendChild(li);
    });
  }

  // When the operator picks an endpoint from the topology search:
  //   1. Pulse the matched endpoint's switch on the graph.
  //   2. Fetch the asset's connection path (GET /assets/:id/connection-path)
  //      and overlay the endpoint as a synthetic Cytoscape node connected to
  //      its switch, dimming everything off the path so the chain stands out
  //      visually. The "Show full site" button appears in the modal header
  //      to clear the dim and reveal the rest of the graph.
  // (Asset details aren't auto-opened in the slide-over for this path —
  // operators usually want to see the topology answer first; the asset
  // is reachable from the right-side info panel rows.)
  async function handleTopologySearchPick(item) {
    closeTopologySearchResults();
    if (cyInstance && item.switchId) {
      var node = cyInstance.getElementById(item.switchId);
      if (node && node.length > 0) {
        cyInstance.animate({ center: { eles: node }, zoom: 1.4, duration: 350 });
        node.addClass("topology-pulse");
        setTimeout(function () { try { node.removeClass("topology-pulse"); } catch (e) {} }, 1500);
      }
    }
    if (!item.id || !cyInstance) return;
    try {
      var path = await api.assets.connectionPath(item.id);
      if (path) applyConnectionPathOverlay(path);
    } catch (e) {
      // Best-effort overlay — fall through to the plain pulse on failure.
    }
  }

  // Overlay a focused endpoint→firewall connection path on top of the live
  // Cytoscape graph. Adds a synthetic endpoint node + edge to the first
  // switch hop (when the endpoint isn't already a graph node), then dims
  // every element NOT on the path. Clearing is via the "Show full site"
  // button in the header or by tapping any non-path node.
  function applyConnectionPathOverlay(path) {
    if (!cyInstance || !path || !path.asset || !Array.isArray(path.hops) || path.hops.length === 0) return;
    // Sweep any leftover overlay from a previous search before drawing the new one.
    clearConnectionPathOverlay();
    var ep = path.asset;
    var leaf = path.hops[0];
    var nextHop = path.hops[1];
    var syntheticEdgeId = null;

    // Add the endpoint as a synthetic node when the live topology graph
    // doesn't already include it (which is almost always — endpoints don't
    // appear as Cytoscape nodes in the standard topology response, only in
    // the right-side panel). Switches / APs / firewalls already have nodes,
    // so we skip the synthesis in those cases.
    var alreadyOnGraph = cyInstance.getElementById(ep.id).length > 0;
    if (!alreadyOnGraph && leaf.kind === "endpoint") {
      cyInstance.add({
        group: "nodes",
        data: {
          id: ep.id,
          label: ep.hostname || ep.ipAddress || "endpoint",
          role: "endpoint",
          nodeColor: endpointNodeColor(leaf),
          synthetic: 1,
        },
      });
      // Edge from the endpoint to its first switch hop, labeled with the
      // switch port the endpoint plugs into (parsed from lastSeenSwitch).
      if (nextHop && cyInstance.getElementById(nextHop.id).length > 0) {
        syntheticEdgeId = "ep-edge-" + ep.id;
        cyInstance.add({
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

    // Build the set of path node ids and resolve each into Cytoscape elements.
    var pathNodeIds = path.hops.map(function (h) { return h.id; });
    var pathElements = cyInstance.collection();
    pathNodeIds.forEach(function (id) {
      var n = cyInstance.getElementById(id);
      if (n.length > 0) pathElements = pathElements.union(n);
    });
    if (syntheticEdgeId) {
      var syn = cyInstance.getElementById(syntheticEdgeId);
      if (syn.length > 0) pathElements = pathElements.union(syn);
    }
    // Edges between two path nodes (controller / interfaceEdges / lldpEdges
    // wiring the switches and FortiGate together) are part of the path too.
    cyInstance.edges().forEach(function (e) {
      var s = e.data("source");
      var t = e.data("target");
      if (pathNodeIds.indexOf(s) !== -1 && pathNodeIds.indexOf(t) !== -1) {
        pathElements = pathElements.union(e);
      }
    });

    cyInstance.elements().not(pathElements).addClass("dimmed");

    // Snapshot the path nodes' original positions, then lay the path out
    // left-to-right along the column grid: each real node keeps its solver
    // column (x) and is flattened onto a single row (y=0) so the chain reads
    // firewall → switch → AP → endpoint. The synthetic endpoint sits in its
    // ODD column — one column right of the access switch/AP it plugs into
    // (hops[1]) — matching the base layout's even-infra / odd-endpoint grid.
    // The base layout spaces nodes across the whole site, so without this the
    // dimmed path could land scattered across a huge canvas. Positions are
    // restored on overlay clear so the persisted layout is untouched.
    var savedPositions = {};
    pathNodeIds.forEach(function (id) {
      var n = cyInstance.getElementById(id);
      if (n.length > 0) {
        var p = n.position();
        if (p && typeof p.x === "number" && typeof p.y === "number") {
          savedPositions[id] = { x: p.x, y: p.y };
        }
        // Flatten every path node onto one row; real nodes already sit at
        // their column x from the base layout. A synthetic endpoint (added
        // above with no real column) is repositioned explicitly below.
        n.position("y", 0);
      }
    });
    // Synthetic endpoint → odd column, one column right of its first real hop
    // (hops[1]). Skip when the searched node is a real infra node (no synthetic
    // node was added) so we don't yank a switch/AP out of its own column.
    var epNode = cyInstance.getElementById(ep.id);
    if (nextHop && epNode.length > 0 && epNode.data("synthetic")) {
      var hopNode = cyInstance.getElementById(nextHop.id);
      if (hopNode.length > 0) {
        // Place the endpoint one column further from the firewall than its
        // switch — right for a verified switch (positive column), left for a
        // FortiLink-fallback switch (negative column → endpoint lands in the
        // odd col -3). Firewall itself (x≈0) defaults to the right.
        var hopX = hopNode.position().x;
        var dir = hopX < 0 ? -1 : 1;
        epNode.position({ x: hopX + dir * TOPO_COL_SPACING, y: 0 });
      }
    }

    topoState.pathOverlay = {
      endpointId: ep.id,
      edgeId: syntheticEdgeId,
      savedPositions: savedPositions,
    };
    // Drawn paths are anchored to the full-site layout; the temporary chain
    // would stretch them across the canvas, so they step aside until cleared.
    if (edgeEditor) edgeEditor.setSuspended(true);

    var btn = document.getElementById("topology-show-full");
    if (btn) btn.hidden = false;

    try {
      cyInstance.animate({ fit: { eles: pathElements, padding: 80 }, duration: 350 });
    } catch (e) { /* fit may fail if pathElements is empty / single node */ }
  }

  // Remove the dim class and tear down any synthetic endpoint node + edge
  // we added in applyConnectionPathOverlay. Idempotent.
  function clearConnectionPathOverlay() {
    if (!cyInstance) return;
    cyInstance.elements().removeClass("dimmed");
    var overlay = topoState.pathOverlay;
    if (overlay) {
      // Restore original positions BEFORE removing synthetic nodes so the
      // operator's previous layout (whether persisted or just from the
      // current dagre run) snaps back into place when they "Show full site".
      if (overlay.savedPositions) {
        Object.keys(overlay.savedPositions).forEach(function (id) {
          var n = cyInstance.getElementById(id);
          if (n.length > 0) n.position(overlay.savedPositions[id]);
        });
      }
      if (overlay.edgeId) {
        var edge = cyInstance.getElementById(overlay.edgeId);
        try { if (edge.length > 0) cyInstance.remove(edge); } catch (e) {}
      }
      // Only remove the endpoint node when it was synthetic (added by us).
      // Tagged via data.synthetic = 1 so we don't accidentally rip out a
      // pre-existing node (e.g. when the operator searched a switch hostname
      // — that case never adds a synthetic node, but be defensive).
      var ep = cyInstance.getElementById(overlay.endpointId);
      if (ep.length > 0 && ep.data("synthetic")) {
        try { cyInstance.remove(ep); } catch (e) {}
      }
      topoState.pathOverlay = null;
      if (edgeEditor) edgeEditor.setSuspended(false);
    }
    var btn = document.getElementById("topology-show-full");
    if (btn) btn.hidden = true;
  }

  // Color the synthetic endpoint node by its monitor state — same five-state
  // palette the firewall / switch / AP nodes use, so the path reads as a
  // single visual scheme.
  function endpointNodeColor(hop) {
    // Shared node-health palette (api.js POLARIS_HEALTH_COLORS, re-exposed by
    // topology-render.js which loads before this file).
    var P = window.PolarisTopologyRender.HEALTH_NODE_COLORS;
    if (!hop || !hop.monitored) return P.unmonitored;
    switch (hop.monitorStatus) {
      case "up":         return P.up;
      case "warning":    return P.degraded;
      case "down":       return P.down;
      case "recovering": return P.recovering;
      // No verdict rendered — distinct from the grey "no samples" unknown.
      case "passive":    return P.passive;
      default:           return P.unknown;
    }
  }

  function closeTopologySearchResults() {
    topoSuggestState.open = false;
    topoSuggestState.items = [];
    topoSuggestState.index = -1;
    var box = document.getElementById("topology-search-results");
    if (box) { box.hidden = true; box.innerHTML = ""; }
  }

  function closeTopology() {
    // If the connection-path overlay is active, restore the operator's
    // original node positions BEFORE saving — otherwise the temporary tight
    // chain would replace their persisted layout on close.
    if (topoState.pathOverlay && topoState.pathOverlay.savedPositions && cyInstance) {
      var saved = topoState.pathOverlay.savedPositions;
      Object.keys(saved).forEach(function (id) {
        var n = cyInstance.getElementById(id);
        if (n.length > 0) n.position(saved[id]);
      });
    }
    // Persist current node positions before tear-down so reopening the
    // same site restores the operator's manual layout. Flush the debounced
    // server PUT immediately (fire-and-forget — the modal is closing).
    if (topoState.siteId && cyInstance) saveNodePositions(topoState.siteId);
    _flushServerLayoutSaves();
    closeTopologySearchResults();
    topoState.siteId = null;
    topoState.hostname = null;
    topoState.data = null;
    topoState.pathOverlay = null;
    topoState.editing = false;
    var showFullBtn = document.getElementById("topology-show-full");
    if (showFullBtn) showFullBtn.hidden = true;
    // Exit native fullscreen first — otherwise the browser stays in
    // fullscreen mode showing nothing after the modal hides, and the user
    // has to hit Esc / their OS gesture to recover.
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) {
        try { exit.call(document); } catch (e) {}
      }
    }
    var overlay = document.getElementById("topology-overlay");
    var modal = overlay && overlay.querySelector(".modal");
    if (modal) modal.classList.remove("topology-fullscreen");
    overlay.classList.remove("open");
    overlay.setAttribute("aria-hidden", "true");
    if (cyInstance) {
      cyInstance.destroy();
      cyInstance = null;
    }
    edgeEditor = null;
  }

  // Delegates to PolarisTopologyRender so desktop and mobile share one
  // color scheme. Kept as a local alias for the existing call sites.
  function fortigateNodeColor(fg) {
    return window.PolarisTopologyRender.fortinetNodeColor(fg);
  }

  function renderTopologyGraph(data) {
    // Refresh / reset rebuilds the cyInstance from scratch — any synthetic
    // overlay nodes / edges are gone, so reset the state and hide the
    // "Show full site" button before drawing the new graph. Don't call
    // clearConnectionPathOverlay() here because cyInstance is about to be
    // torn down regardless.
    topoState.pathOverlay = null;
    var showFullBtn = document.getElementById("topology-show-full");
    if (showFullBtn) showFullBtn.hidden = true;

    // Element + stylesheet construction is shared with the mobile topology
    // surface — see public/js/topology-render.js. Desktop opts into the
    // endpoint-overlay styles because the connection-path search dims
    // off-path elements and adds a synthetic round-rectangle endpoint node.
    var elements = window.PolarisTopologyRender.buildTopologyElements(data);

    // Does ANY device on this site carry a location code? (Location boxes
    // are always drawn when one does — the Locations chip is gone.)
    topoState.hasLocationCodes = elements.some(function (el) {
      var d = el && el.data;
      return !!(d && !d.source && (d.locA || d.locB || d.locF || d.locR || d.locJb));
    });

    // Floor views present in this payload (empty unless some device carries
    // an f: code). Computed from the unfiltered set; if a refresh removed the
    // active view's floor, fall back to Flat rather than rendering nothing.
    topoState.floorViews = window.PolarisTopologyRender.computeFloorViews(elements);
    var isFloorView = topoState.activeView !== "flat";
    if (isFloorView && !topoState.floorViews.some(function (v) { return v.key === topoState.activeView; })) {
      topoState.activeView = "flat";
      isFloorView = false;
    }

    // Every device type is drawn (the Switches / APs show-hide chips are
    // gone). Edges still need both ends present — a dangling reference
    // throws in Cytoscape and kills the whole render. Two passes because mesh
    // edges can precede their target AP node in the element order.
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

    // Floor view: partition down to the active (building, floor) pair — its
    // tagged devices + the FortiGate root + portal stubs where an edge
    // crosses to another floor.
    if (isFloorView) {
      elements = window.PolarisTopologyRender.partitionElementsForFloor(elements, topoState.activeView);
    }

    // The topology graph follows the APP theme's family, not the per-user MAP
    // theme. It used to take getMapTheme() on the theory that one toolbar
    // toggle should drive the basemap and the modal together — but the
    // topology modal has no basemap: its canvas is .topology-graph painting
    // --color-bg-secondary, an APP-themed token. So an operator on nightfall
    // who preferred the light OpenStreetMap tiles got the light Cytoscape
    // palette — #1a1a1a node labels — on a #0d0d1a pane. The two must come
    // from the same place, and the pane is the one the CSS owns.
    var theme = appThemeFamily();

    // Refresh path: tear down the previous cytoscape before mounting the
    // new one. Without this, a Refresh click stacks two graphs and the
    // canvas leaks.
    if (cyInstance) {
      try { cyInstance.destroy(); } catch (e) {}
      cyInstance = null;
    }
    edgeEditor = null;

    // Restore manually-dragged node positions from localStorage if any
    // are saved for this site. We use the dagre layout as the base
    // (handles new nodes that didn't exist last time), then snap saved
    // nodes to their stored positions in a layoutstop hook below.
    var savedPositions = topoState.siteId ? loadNodePositions(topoState.siteId) : null;

    // Construct cytoscape with the default no-op `preset` layout so we can
    // register the layoutstop listener BEFORE running dagre — otherwise the
    // layout can finish (and emit layoutstop) before `.one()` registers,
    // silently dropping the saved-position restore on reopen.
    cyInstance = cytoscape({
      container: document.getElementById("topology-graph"),
      elements: elements,
      // Box-select: shift+drag on background draws a selection rectangle;
      // selected nodes can be dragged together to rearrange. Multi-node
      // selection is also addable via shift-click on individual nodes.
      // Pan stays as plain drag on background (Cytoscape default).
      // "single": a PLAIN click replaces the selection — a link, a group box
      // or a device becomes the only thing selected (it used to be
      // "additive", so clicking a second link or a box after a box-select
      // kept everything before it selected). Shift-click and shift-drag
      // still add: Cytoscape treats a held shift as additive in either mode.
      // Dragging an already-selected device still moves the whole set.
      boxSelectionEnabled: true,
      selectionType: "single",
      // Damp scroll-wheel zoom hard — the default felt jumpy on typical
      // mouse wheels (one notch was 25–30% zoom step), and even the earlier
      // 0.5 stepped too far on large site graphs. 0.2 ≈ one notch nudges
      // zoom ~5%, so a flick of the wheel stays readable.
      wheelSensitivity: 0.2,
      style: window.PolarisTopologyRender.topologyStylesheet(theme, { includeEndpointOverlay: true }),
    });

    // Restore saved positions AFTER the dagre layout finishes so any
    // brand-new nodes get a sensible default placement and only the ones
    // the operator dragged previously snap to their stored coordinates.
    cyInstance.one("layoutstop", function () {
      if (!savedPositions) return;
      cyInstance.batch(function () {
        cyInstance.nodes().forEach(function (n) {
          var p = savedPositions[n.id()];
          if (p && typeof p.x === "number" && typeof p.y === "number") {
            n.position({ x: p.x, y: p.y });
          }
        });
      });
      try { cyInstance.fit(undefined, 30); } catch (e) {}
    });

    // Deterministic column layout: Dijkstra-weighted depth from the firewall
    // places infra (firewall/switch/AP) on even columns and leaf nodes
    // (endpoints/wireless/ghosts/remote) on the odd column right of their
    // parent. Left-to-right here: depth → x, lane → y. Falls back to dagre
    // when there's no firewall root to anchor the solver.
    //
    // Location-coded sites get the QUOTIENT layout instead: each top-level
    // group (area/building) is laid out as its own compact box using local
    // depth, and the boxes are shelf-packed left-to-right by inter-group
    // depth — so a building deep in the site's chain no longer renders as a
    // huge sparse rectangle. Same {depth, lane} grid contract; falls back to
    // the flat solver on untagged sites (computeGroupedLayout returns null).
    // Port labels on bent links sit on their end legs, re-placed as nodes
    // move (see topology-render.js → wireBentEdgeLabels).
    window.PolarisTopologyRender.wireBentEdgeLabels(cyInstance);
    var columns = window.PolarisTopologyRender.computeGroupedLayout(elements) ||
      window.PolarisTopologyRender.computeTopologyColumns(elements);
    if (columns) {
      var positions = {};
      Object.keys(columns).forEach(function (id) {
        positions[id] = { x: columns[id].depth * TOPO_COL_SPACING, y: columns[id].lane * TOPO_ROW_SPACING };
      });
      cyInstance.layout({ name: "preset", positions: positions, fit: true, padding: 30 }).run();
      // Fan-out links (a switch to its non-spine child switches, a mesh root
      // to its leaves) route orthogonally through the gutter instead of
      // slicing diagonally across the AP column between them — geometry the
      // solver reserved cells for. Stamped from the grid, so it holds under
      // saved positions and drags too (the turn is a fixed half column out
      // from the shallow end, so it never shares the spine link's row).
      window.PolarisTopologyRender.markFanOutEdges(cyInstance, columns, {
        colSpacing: TOPO_COL_SPACING,
        orientation: "horizontal",
      });
    } else {
      cyInstance.layout({
        name: "dagre",
        rankDir: "LR",
        nodeSep: 30,
        rankSep: 160,
        fit: true,
        padding: 30,
      }).run();
    }

    // Persist node position on every drag-stop so a refresh / reopen
    // restores the operator's manual layout. Debounced via the timer
    // below so a long drag doesn't write per-tick.
    var saveTimer = null;
    cyInstance.on("dragfree", "node", function (evt) {
      if (!topoState.siteId) return;
      // Suppress auto-save while the connection-path overlay is active —
      // the path nodes are sitting in a temporary tight-chain layout (not
      // their persisted positions), and any drag in that mode is in the
      // overlay's coordinate space. Letting it persist would clobber the
      // operator's saved layout.
      if (topoState.pathOverlay) return;
      // Snap-to-grid: on release, land the dragged node — and every other
      // selected node, since a multi-select drag moves them together — on
      // the nearest grid cell. Hull re-fit follows via the `position`
      // listener below. Hull nodes are excluded here: their members were
      // already snapped by the hull `free` handler, and re-centering the
      // hull itself is refreshLocationGroups' job.
      if (_readSnapToGrid()) {
        var toSnap = cyInstance.collection(evt.target).union(cyInstance.nodes(":selected"));
        cyInstance.batch(function () {
          toSnap.forEach(function (n) {
            if (n.data("isLocGroup") || n.data("isPortal") || n.data("isEdgeHandle")) return;
            n.position(_snapPos(n.position()));
          });
        });
      }
      _markLayoutDirty();
      _layoutHistoryRecordSoon(); // a finished drag is one undo step
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveNodePositions(topoState.siteId);
      }, 250);
    });

    // Single-click selects a node (Cytoscape's built-in selection highlight);
    // DOUBLE-click opens its asset details. Cytoscape has no native double-tap,
    // so we detect two taps on the same node within a short window. Resolves
    // the asset id from the node: firewall/switch/AP/endpoint use the node id
    // (which IS the asset id); cross-site remotes + matched wireless stations
    // carry it in `assetId`; LLDP ghosts and unmatched stations have no asset.
    function _assetIdForNode(node) {
      if (node.data("isPortal")) return null; // floor portal — tap navigation, not an asset
      if (node.data("isLocGroup")) return null; // location hull — hover surface only
      if (node.data("isEdgeHandle")) return null; // connection-path handle
      var role = node.data("role");
      if (role === "lldp") return null; // ghost neighbor — no Polaris asset
      if (role === "wireless-station" || role === "remote-asset") {
        return node.data("assetId") || null;
      }
      return node.data("assetId") || node.id() || null;
    }
    function _openAssetForNode(node) {
      var assetId = _assetIdForNode(node);
      if (assetId) openViewModal(assetId);
    }
    var _lastNodeTap = { id: null, t: 0 };
    cyInstance.on("tap", "node", function (evt) {
      var node = evt.target;
      var id = node.id();
      var now = (window.performance && window.performance.now) ? window.performance.now() : Date.now();
      if (_lastNodeTap.id === id && (now - _lastNodeTap.t) < 350) {
        _lastNodeTap = { id: null, t: 0 };
        _openAssetForNode(node);
        return;
      }
      _lastNodeTap = { id: id, t: now };
      // Single tap: selection highlight is handled by Cytoscape automatically.
    });

    // Right-click on an asset-backed node opens the in-place description
    // editor — the quick path for stamping a:/b:/f:/r:/jb: grouping codes
    // without opening the full asset slide-over.
    cyInstance.on("cxttap", "node", function (evt) {
      var assetId = _assetIdForNode(evt.target);
      if (assetId) openTopologyDescriptionEditor(assetId);
    });
    // The native context menu would cover the editor — suppress it over the
    // graph. Bound once; the container element survives cytoscape re-renders.
    var graphEl = document.getElementById("topology-graph");
    if (graphEl && !graphEl.dataset.ctxMenuBound) {
      graphEl.dataset.ctxMenuBound = "1";
      graphEl.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    }

    // Auto-clear the connection-path dim if the operator taps any node
    // currently dimmed off-path — they're trying to navigate the rest of
    // the graph, so get out of their way without forcing them to hunt for
    // the "Show full site" button.
    cyInstance.on("tap", "node.dimmed", function () {
      if (topoState.pathOverlay) clearConnectionPathOverlay();
    });

    // Floor portal tap → jump to the remote device's floor view.
    cyInstance.on("tap", "node[isPortal]", function (evt) {
      var target = evt.target.data("targetView");
      if (target) _setTopologyView(target);
    });

    // Hover tooltip on edges — concise: the two devices, the interface on each
    // side, and a one-line connection kind. Works for every edge type
    // (controller / interface / LLDP / mesh / wireless).
    cyInstance.on("mouseover", "edge", function (evt) {
      var html = buildEdgeTooltipHtml(evt.target);
      if (!html) return;
      var orig = evt.originalEvent;
      var x = orig && typeof orig.clientX === "number" ? orig.clientX : 0;
      var y = orig && typeof orig.clientY === "number" ? orig.clientY : 0;
      showEdgeTooltip(html, x, y);
    });
    cyInstance.on("mousemove", "edge", function (evt) {
      // Track the cursor so the tooltip follows the edge as the operator
      // sweeps along it.
      var orig = evt.originalEvent;
      if (!orig) return;
      moveEdgeTooltip(orig.clientX, orig.clientY);
    });
    cyInstance.on("mouseout", "edge", function () { hideEdgeTooltip(); });

    // Location-hull hover tooltip: the hovered shape's label plus every
    // shape it nests inside (hit-testing hands the hover to the innermost
    // hull, so a jb inside a room inside a building lists all three).
    // Reuses the edge-tooltip element/positioning helpers.
    var LOC_KIND_LABELS = { area: "Area", building: "Building", floor: "Floor", room: "Room", jb: "Junction box" };
    cyInstance.on("mouseover", "node[isLocGroup]", function (evt) {
      var parts = window.PolarisTopologyRender.locationGroupTooltipParts(cyInstance, evt.target);
      if (!parts.length) return;
      var html = parts.map(function (p) {
        return '<div><span style="color:' + p.color + ';font-size:0.76em;text-transform:uppercase;letter-spacing:0.5px">' +
          escapeHtml(LOC_KIND_LABELS[p.kind] || p.kind) + '</span> <strong>' + escapeHtml(p.name || "") + '</strong></div>';
      }).join("");
      var orig = evt.originalEvent;
      showEdgeTooltip(html, orig && typeof orig.clientX === "number" ? orig.clientX : 0,
                            orig && typeof orig.clientY === "number" ? orig.clientY : 0);
    });
    cyInstance.on("mousemove", "node[isLocGroup]", function (evt) {
      var orig = evt.originalEvent;
      if (orig) moveEdgeTooltip(orig.clientX, orig.clientY);
    });
    cyInstance.on("mouseout", "node[isLocGroup]", function () { hideEdgeTooltip(); });

    // Location grouping hulls — drawn after the layout so bounding boxes
    // reflect final positions (the preset/dagre run + saved-position restore
    // above are synchronous), then re-fitted whenever any real node moves
    // (drag, path overlay snap-back). RAF-throttled: one refresh per frame no
    // matter how many nodes a batch reposition touches. In building/floor
    // views the enclosing tiers are suppressed — the view itself IS that
    // scope, so only the deeper shapes stay useful.
    if (topoState.hasLocationCodes) {
      var supKinds = _locSuppressKinds();
      window.PolarisTopologyRender.renderLocationGroups(
        cyInstance,
        supKinds ? { suppressKinds: supKinds } : undefined
      );
      // Route cross-group links through the gutters between boxes.
      window.PolarisTopologyRender.routeInterGroupEdges(cyInstance);
    }
    // Operator-drawn connection paths — after the router, so a customised
    // line's first edit can keep the routed shape it was drawn with. Edits
    // persist through the same dirty-flag + debounced save as a node drag.
    if (window.PolarisTopologyEdgeEditor) {
      edgeEditor = window.PolarisTopologyEdgeEditor.attach(cyInstance, {
        positions: savedPositions,
        isSuspended: function () { return !!topoState.pathOverlay; },
        isEditable: function () { return !!topoState.editing; },
        snapPoint: function (p) { return _readPref(SNAP_POINTS_STORAGE_KEY) ? _snapFine(p) : p; },
        onChange: function () {
          if (!topoState.siteId || topoState.pathOverlay) return;
          _markLayoutDirty();
          saveNodePositions(topoState.siteId);
          _layoutHistoryRecordSoon(); // a new bend / a Delete is one undo step
        },
        onGeometryReset: function () {
          // A line back on automatic takes its routed shape again.
          if (cyInstance && cyInstance.nodes("[isLocGroup]").length > 0) {
            window.PolarisTopologyRender.routeInterGroupEdges(cyInstance);
          } else if (cyInstance) {
            window.PolarisTopologyRender.refreshBentEdgeLabels(cyInstance);
          }
        },
      });
    }
    // Dragging a group box moves its member devices with it; nested boxes
    // re-fit around the moved members. The RAF drag-follow refresh is
    // suppressed for the drag's duration (the handlers keep everything
    // consistent themselves), then a full re-fit + re-route runs on release.
    var hullDrag = null;
    // A box becomes the whole selection when it is clicked OR dragged:
    // leaving a box-selected set of devices lit while their box moves reads
    // as though the drag were acting on them. On the first real MOVE, not on
    // the press — a Shift-drag box-select that starts inside a box presses
    // (grabs) the box too, and must not select it or drop the devices.
    function _selectOnlyHull(hull) {
      if (topoState.pathOverlay) return;
      cyInstance.elements(":selected").not(hull).unselect();
      hull.selectify();
      hull.select();
    }
    cyInstance.on("grab", "node[isLocGroup]", function (evt) {
      var h = evt.target;
      var p = h.position();
      var members = [];
      (h.data("memberIds") || []).forEach(function (id) {
        var m = cyInstance.getElementById(id);
        if (m.length === 0) return;
        var mp = m.position();
        members.push({ node: m, x: mp.x, y: mp.y });
      });
      hullDrag = { startX: p.x, startY: p.y, members: members };
    });
    cyInstance.on("drag", "node[isLocGroup]", function (evt) {
      if (!hullDrag) return;
      var p = evt.target.position();
      var dx = p.x - hullDrag.startX;
      var dy = p.y - hullDrag.startY;
      if (!hullDrag.selected && (dx || dy)) {
        hullDrag.selected = true;
        _selectOnlyHull(evt.target);
      }
      cyInstance.batch(function () {
        hullDrag.members.forEach(function (m) {
          m.node.position({ x: m.x + dx, y: m.y + dy });
        });
      });
    });
    cyInstance.on("free", "node[isLocGroup]", function (evt) {
      if (!hullDrag) return;
      hullDrag = null;
      // Snap-to-grid: land every member the hull drag just moved on the
      // nearest grid cell before the hulls re-fit around them.
      if (_readSnapToGrid() && !topoState.pathOverlay) {
        var memberIds = evt.target.data("memberIds") || [];
        cyInstance.batch(function () {
          memberIds.forEach(function (id) {
            var m = cyInstance.getElementById(id);
            if (m.length > 0) m.position(_snapPos(m.position()));
          });
        });
      }
      window.PolarisTopologyRender.refreshLocationGroups(cyInstance);
      window.PolarisTopologyRender.routeInterGroupEdges(cyInstance);
    });
    // Clicking a group box selects it, and only it — whatever was selected
    // (a box-selected set of devices, a link) lets go. Boxes are created
    // unselectable so a shift-drag box-select never sweeps one in (a
    // selected box would ride along on the next device drag, and its own
    // drag handler would then move its members a second time), so a box is
    // made selectable for exactly as long as a click keeps it selected.
    cyInstance.on("tap", "node[isLocGroup]", function (evt) { _selectOnlyHull(evt.target); });
    cyInstance.on("unselect", "node[isLocGroup]", function (evt) { evt.target.unselectify(); });
    var locRefreshPending = false;
    cyInstance.on("position", "node[!isLocGroup][!isEdgeHandle]", function () {
      if (hullDrag || locRefreshPending) return;
      locRefreshPending = true;
      window.requestAnimationFrame(function () {
        locRefreshPending = false;
        if (!cyInstance) return;
        window.PolarisTopologyRender.refreshLocationGroups(cyInstance);
        window.PolarisTopologyRender.routeInterGroupEdges(cyInstance);
      });
    });

    // Corner tools, overlaid at the top-right of the graph area.
    // (openTopology wipes #topology-graph's innerHTML and cytoscape re-mounts,
    // so they're re-added here on every render rather than living in static
    // HTML.) The grid follows this graph's pan and zoom.
    _ensureTopologyCornerTools();
    _wireTopologyGrid();
    _renderTopologyFloorViews();
    _wireCtrlPan();
    // Save/Reset affordances are per VIEW — re-state them whenever the
    // graph is rebuilt (open, refresh, view switch, reset).
    _refreshLayoutToolbar();
    // Group boxes are re-built after layout (refreshLocationGroups adds
    // nodes), so a node added in view-only mode takes the mode's panning.
    cyInstance.on("add", "node", function (evt) {
      if (!topoState.editing) evt.target.panify();
    });
    // View-only unless Edit is on: the fresh graph takes the current mode.
    _applyTopologyEditMode();
  }

  // ── Corner tools + edit mode ─────────────────────────────────────────────
  // One row at the top right of the graph, right → left:
  //   Edit       the dashboard's pencil, a check mark while editing
  //              (Customize Page / Done Editing, index.html)
  //   Export     screenshots, PDF, Visio (graph-export.js)
  //   — edit mode only —
  //   Grid       show / hide the two-weight grid (an editing aid: never
  //              drawn outside edit mode; the on/off pref is kept for the
  //              next edit)
  //   Snap devices · Snap line points
  // The map opens view-only: devices and location boxes don't drag, lines
  // take no bends or end-point moves, and the layout verbs (Save, Reset and
  // the three edit-only toggles) are hidden, the grid with them. Clicking,
  // selecting, panning, zooming, the location views, search and Export work
  // either way.
  function _svg(inner, strokeWidth) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + (strokeWidth || 2) +
      '" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">' + inner + "</svg>";
  }
  var EDIT_ICON = _svg('<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>');
  var DONE_ICON = _svg('<polyline points="20 6 9 17 4 12"/>', 2.5);
  var GRID_ICON = _svg('<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>');
  var SNAP_DEVICES_ICON = _svg('<path d="m6 15-4-4 6.75-6.77a7.79 7.79 0 0 1 11 11L13 22l-4-4 6.39-6.36a2.14 2.14 0 0 0-3-3L6 15"/><path d="m5 8 4 4"/><path d="m12 15 4 4"/>');
  var SNAP_POINTS_ICON = _svg('<circle cx="12" cy="12" r="3"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>');

  function _readPref(key) {
    try { return localStorage.getItem(key) === "on"; } catch (e) { return false; }
  }
  function _writePref(key, on) {
    try { localStorage.setItem(key, on ? "on" : "off"); }
    catch (e) { /* quota / private mode — the toggle still applies this session */ }
  }

  // A button inside the Cytoscape container: a press on it must not read as
  // a background tap and clear the selection.
  function _cornerButton(id, className, onClick) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.id = id;
    btn.className = className;
    ["mousedown", "pointerdown", "touchstart"].forEach(function (type) {
      btn.addEventListener(type, function (e) { e.stopPropagation(); });
    });
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      hideEdgeTooltip();
      onClick(btn);
    });
    // Hover tip: the map's own styled tooltip (the one links and location
    // boxes use) — name in bold, what it does underneath. Read at hover time
    // from _setCornerTip's data attributes, so a toggle's tip follows its
    // state. Not a native `title`: that would stack a second tooltip.
    btn.addEventListener("mouseenter", function (e) {
      var name = btn.getAttribute("data-tip-name");
      if (!name) return;
      var body = btn.getAttribute("data-tip-body");
      showEdgeTooltip("<strong>" + escapeHtml(name) + "</strong>" +
        (body ? '<div style="margin-top:2px;opacity:0.85">' + escapeHtml(body) + "</div>" : ""), e.clientX, e.clientY);
    });
    btn.addEventListener("mousemove", function (e) { moveEdgeTooltip(e.clientX, e.clientY); });
    btn.addEventListener("mouseleave", function () { hideEdgeTooltip(); });
    return btn;
  }
  // A corner tool's hover tip and accessible name.
  function _setCornerTip(btn, name, body) {
    btn.setAttribute("data-tip-name", name);
    btn.setAttribute("data-tip-body", body || "");
    btn.setAttribute("aria-label", name);
    btn.removeAttribute("title");
  }
  // An on/off tool: icon, the word as its accessible name (aria-label),
  // aria-pressed, `is-on` when lit. `onToggle(next)` runs after the pref is
  // written.
  function _toggleTool(id, key, icon, word, titleOn, titleOff, onToggle) {
    var btn = _cornerButton(id, "btn-icon topology-tool", function () {
      var next = !_readPref(key);
      _writePref(key, next);
      paint();
      if (onToggle) onToggle(next);
    });
    function paint() {
      var on = _readPref(key);
      btn.innerHTML = icon;
      btn.classList.toggle("is-on", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      _setCornerTip(btn, word + (on ? " — on" : " — off"), on ? titleOn : titleOff);
    }
    paint();
    return btn;
  }

  function _ensureTopologyCornerTools() {
    var graph = document.getElementById("topology-graph");
    if (!graph || document.getElementById("topology-corner-tools")) return;
    if (!graph.style.position) graph.style.position = "relative";
    var row = document.createElement("div");
    row.id = "topology-corner-tools";
    row.className = "topology-corner-tools";

    var snapPoints = _toggleTool("topology-snap-points", SNAP_POINTS_STORAGE_KEY, SNAP_POINTS_ICON,
      "Snap line points",
      "Line points snap to the grid (thin and thick lines) — click to stop",
      "Snap line points to the grid (thin and thick lines)");
    var snapDevices = _toggleTool("topology-snap-devices", SNAP_STORAGE_KEY, SNAP_DEVICES_ICON,
      "Snap devices",
      "Devices snap to the grid's thick lines — click to stop",
      "Snap devices to the grid's thick lines (re-snaps them now)",
      function (on) { if (on) _snapAllPositions(); });
    var grid = _toggleTool("topology-grid", GRID_STORAGE_KEY, GRID_ICON,
      "Grid", "Hide the grid", "Show the grid",
      function () { _paintTopologyGrid(); });

    var exportBtn = _cornerButton("topology-export", "btn-icon topology-tool", function (btn) {
      if (!window.PolarisGraphExport) return;
      window.PolarisGraphExport.openMenu(btn, topologyExportContext, {
        screenshots: [
          { label: "Copy map as image", run: screenshotTopology },
          { label: "Copy screenshot (map + details)", run: screenshotTopologyModal },
        ],
      });
    });
    _setCornerTip(exportBtn, "Export", "Copy a screenshot, or save the view as a PDF or a Visio drawing");
    exportBtn.setAttribute("aria-haspopup", "menu");
    exportBtn.innerHTML = _svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>');

    var editBtn = _cornerButton("topology-edit", "btn btn-primary btn-icon-only topology-map-edit", function () {
      _setTopologyEditing(!topoState.editing);
    });

    [snapPoints, snapDevices, grid, exportBtn, editBtn].forEach(function (b) { row.appendChild(b); });
    graph.appendChild(row);

    // Save / Reset layout: a column under the Edit button, edit mode only
    // (they were header buttons). Their tips — where a save lands, whether a
    // restore point exists — are kept current by _refreshLayoutToolbar.
    var stack = document.createElement("div");
    stack.id = "topology-corner-stack";
    stack.className = "topology-corner-stack";
    var saveBtn = _cornerButton("topology-save-layout", "btn-icon topology-tool", function () {
      saveTopologyLayoutCheckpoint();
    });
    saveBtn.innerHTML = _svg('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>');
    _setCornerTip(saveBtn, "Save layout", "Save this layout as a restore point");
    var resetBtn = _cornerButton("topology-reset-layout", "btn-icon topology-tool", function (b) {
      openResetLayoutMenu(b);
    });
    resetBtn.innerHTML = _svg('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>');
    resetBtn.setAttribute("aria-haspopup", "menu");
    _setCornerTip(resetBtn, "Reset layout", "Back to the last save or to the automatic layout");
    // Undo / Redo (Ctrl+Z / Ctrl+Shift+Z) — greyed out with nothing to step
    // to; _paintUndoRedo keeps their state and tips current.
    var undoBtn = _cornerButton("topology-undo", "btn-icon topology-tool", function () { _layoutUndo(); });
    undoBtn.innerHTML = _svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>');
    var redoBtn = _cornerButton("topology-redo", "btn-icon topology-tool", function () { _layoutRedo(); });
    redoBtn.innerHTML = _svg('<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5 5.5 5.5 0 0 0 9.5 20H13"/>');
    [saveBtn, resetBtn, undoBtn, redoBtn].forEach(function (b) { stack.appendChild(b); });
    graph.appendChild(stack);
    _paintUndoRedo();
  }

  // ── Grid ───────────────────────────────────────────────────────────────────
  // Edit mode only (hidden the moment editing ends). Painted as CSS
  // gradients on the graph container, under Cytoscape's
  // transparent canvas, re-positioned on every pan / zoom: thick lines on
  // the device lattice, thin ones on its _topologyGridDiv() subdivisions.
  // Lines too dense to read at the current zoom are left out (thin below
  // 6 px apart, all of it below 8 px).
  function _paintTopologyGrid() {
    var graph = document.getElementById("topology-graph");
    if (!graph) return;
    if (!cyInstance || !topoState.editing || !_readPref(GRID_STORAGE_KEY)) {
      graph.style.backgroundImage = "";
      graph.style.backgroundSize = "";
      graph.style.backgroundPosition = "";
      return;
    }
    var z = cyInstance.zoom();
    var pan = cyInstance.pan();
    var w = TOPO_COL_SPACING * z, h = TOPO_ROW_SPACING * z;
    var div = _topologyGridDiv();
    var mw = w / div, mh = h / div;
    if (Math.min(w, h) < 8) {
      graph.style.backgroundImage = "";
      return;
    }
    var major = "rgba(148, 163, 184, 0.34)";
    var minor = "rgba(148, 163, 184, 0.14)";
    var layers = [
      "linear-gradient(to right, " + major + " 1.5px, transparent 1.5px)",
      "linear-gradient(to bottom, " + major + " 1.5px, transparent 1.5px)",
    ];
    var sizes = [w + "px " + h + "px", w + "px " + h + "px"];
    if (Math.min(mw, mh) >= 6) {
      layers.push("linear-gradient(to right, " + minor + " 1px, transparent 1px)");
      layers.push("linear-gradient(to bottom, " + minor + " 1px, transparent 1px)");
      sizes.push(mw + "px " + mh + "px", mw + "px " + mh + "px");
    }
    var pos = pan.x + "px " + pan.y + "px";
    graph.style.backgroundImage = layers.join(", ");
    graph.style.backgroundSize = sizes.join(", ");
    graph.style.backgroundPosition = layers.map(function () { return pos; }).join(", ");
  }
  function _wireTopologyGrid() {
    if (!cyInstance) return;
    var pending = false;
    cyInstance.on("viewport resize", function () {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () { pending = false; _paintTopologyGrid(); });
    });
    _paintTopologyGrid();
  }
  // How many ways the thin lines split a major cell at the current zoom: 4,
  // or 8 once an eighth of the shorter side is TOPO_GRID_FINE_MIN_PX on
  // screen. The thick lines never move.
  function _topologyGridDiv() {
    if (!cyInstance) return TOPO_GRID_DIV;
    var fineCell = Math.min(TOPO_COL_SPACING, TOPO_ROW_SPACING) * cyInstance.zoom() / TOPO_GRID_DIV_FINE;
    return fineCell >= TOPO_GRID_FINE_MIN_PX ? TOPO_GRID_DIV_FINE : TOPO_GRID_DIV;
  }
  // The point a line's bend lands on with "Snap line points" on: the nearest
  // intersection of the thin + thick lines as currently drawn.
  function _snapFine(p) {
    var div = _topologyGridDiv();
    var sx = TOPO_COL_SPACING / div, sy = TOPO_ROW_SPACING / div;
    return { x: Math.round(p.x / sx) * sx, y: Math.round(p.y / sy) * sy };
  }
  function _setTopologyEditing(on) {
    topoState.editing = !!on;
    _applyTopologyEditMode();
  }
  function _applyTopologyEditMode() {
    var on = !!topoState.editing;
    if (cyInstance) {
      cyInstance.autoungrabify(!on);
      // View-only: a drag that starts on a device or a group box pans the
      // map. Cytoscape pans only from empty background or a `pannable`
      // element, and an ungrabbable node is neither — so a building box,
      // which can fill most of the canvas, left nowhere to drag the map
      // from. Editing turns it off again so boxes and devices grab; Ctrl+drag
      // (_wireCtrlPan) still pans there. Taps fire on pannable nodes too.
      if (on) cyInstance.nodes().unpanify();
      else cyInstance.nodes().panify();
    }
    if (edgeEditor) edgeEditor.refresh();
    _paintTopologyGrid(); // the grid is an editing aid: drawn only while editing
    var btn = document.getElementById("topology-edit");
    if (btn) {
      // Icon + hidden word, as the dashboard's buttons; the hover tip says
      // what pressing it does now.
      btn.innerHTML = (on ? DONE_ICON + "Done Editing" : EDIT_ICON + "Edit Map");
      _setCornerTip(btn, on ? "Done editing" : "Edit map",
        on ? "Stop editing — the map goes back to view-only"
           : "Move devices and boxes, draw lines, snap to the grid");
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    }
    ["topology-save-layout", "topology-reset-layout", "topology-undo", "topology-redo",
     "topology-snap-devices", "topology-snap-points", "topology-grid"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.hidden = !on;
    });
    // Undo history belongs to one edit session in one view: started when
    // editing starts (or the view changes under it), dropped on Done. A
    // re-render while editing (Refresh, Reset, restore) records its result
    // as the next step instead of starting over.
    if (!on) {
      layoutHistory = null;
    } else if (!layoutHistory || layoutHistory.view !== _activeViewKey() || layoutHistory.siteId !== topoState.siteId) {
      _layoutHistoryStart();
    } else {
      _layoutHistoryRecordSoon();
    }
    _paintUndoRedo();
  }

  // ── Undo / redo (edit mode) ──────────────────────────────────────────────
  // A history of whole-layout snapshots — the same blob a save writes
  // (_currentNodePositions: device positions + drawn-line `edgepath:`
  // entries), so one entry restores everything a step changed. A step is
  // recorded when an edit settles: a device / box / point drag ends
  // (dragfree), a bend is created or Deleted (the editor's onChange), snap-
  // all runs, or a Reset / restore re-renders. Identical consecutive
  // snapshots collapse, so a multi-node drag (one dragfree per node) is one
  // step. Undo / redo put a snapshot back and save it like any edit; they
  // are not themselves recorded. Capped at LAYOUT_HISTORY_MAX steps.
  var LAYOUT_HISTORY_MAX = 100;
  var layoutHistory = null; // { siteId, view, entries: [json], index }
  var _historyTimer = null;
  function _layoutSnapshot() {
    var blob = _currentNodePositions();
    return blob ? JSON.stringify(blob) : null;
  }
  function _layoutHistoryStart() {
    var snap = _layoutSnapshot();
    layoutHistory = snap
      ? { siteId: topoState.siteId, view: _activeViewKey(), entries: [snap], index: 0 }
      : null;
  }
  function _layoutHistoryRecord() {
    if (!topoState.editing || !cyInstance || topoState.pathOverlay) return;
    if (!layoutHistory || layoutHistory.view !== _activeViewKey() || layoutHistory.siteId !== topoState.siteId) {
      _layoutHistoryStart();
      _paintUndoRedo();
      return;
    }
    var snap = _layoutSnapshot();
    if (!snap || snap === layoutHistory.entries[layoutHistory.index]) return;
    var entries = layoutHistory.entries.slice(0, layoutHistory.index + 1);
    entries.push(snap);
    if (entries.length > LAYOUT_HISTORY_MAX) entries.shift();
    layoutHistory.entries = entries;
    layoutHistory.index = entries.length - 1;
    _paintUndoRedo();
  }
  // After the current task: several handlers can fire for one gesture (a
  // box drag's free + dragfree, grid snapping on release) — record once,
  // after all of them have moved what they move.
  function _layoutHistoryRecordSoon() {
    if (_historyTimer) clearTimeout(_historyTimer);
    _historyTimer = setTimeout(function () { _historyTimer = null; _layoutHistoryRecord(); }, 0);
  }
  function _layoutHistoryApply(json) {
    if (!cyInstance || !topoState.siteId) return;
    var blob;
    try { blob = JSON.parse(json); } catch (e) { return; }
    cyInstance.batch(function () {
      cyInstance.nodes().forEach(function (n) {
        if (n.data("isLocGroup") || n.data("isPortal") || n.data("isEdgeHandle")) return;
        var p = blob[n.id()];
        if (p && typeof p.x === "number" && typeof p.y === "number") n.position({ x: p.x, y: p.y });
      });
    });
    if (edgeEditor) edgeEditor.setPaths(blob);
    if (topoState.hasLocationCodes) {
      window.PolarisTopologyRender.refreshLocationGroups(cyInstance);
      window.PolarisTopologyRender.routeInterGroupEdges(cyInstance);
    }
    _markLayoutDirty();
    saveNodePositions(topoState.siteId);
  }
  function _layoutUndo() {
    if (!topoState.editing || !layoutHistory || layoutHistory.index <= 0) return;
    if (_historyTimer) { clearTimeout(_historyTimer); _historyTimer = null; _layoutHistoryRecord(); }
    if (layoutHistory.index <= 0) return;
    layoutHistory.index--;
    _layoutHistoryApply(layoutHistory.entries[layoutHistory.index]);
    _paintUndoRedo();
  }
  function _layoutRedo() {
    if (!topoState.editing || !layoutHistory || layoutHistory.index >= layoutHistory.entries.length - 1) return;
    layoutHistory.index++;
    _layoutHistoryApply(layoutHistory.entries[layoutHistory.index]);
    _paintUndoRedo();
  }
  function _paintUndoRedo() {
    var undo = document.getElementById("topology-undo");
    var redo = document.getElementById("topology-redo");
    var h = layoutHistory;
    var canUndo = !!(h && h.index > 0);
    var canRedo = !!(h && h.index < h.entries.length - 1);
    if (undo) {
      undo.disabled = !canUndo;
      _setCornerTip(undo, "Undo (Ctrl+Z)", canUndo ? "Undo the last layout change" : "Nothing to undo");
    }
    if (redo) {
      redo.disabled = !canRedo;
      _setCornerTip(redo, "Redo (Ctrl+Shift+Z)", canRedo ? "Redo the change you undid" : "Nothing to redo");
    }
  }

  // Ctrl + left-drag pans the viewport from ANYWHERE on the graph —
  // including on top of device nodes and group boxes, which normally grab
  // and move. Needed since hulls became draggable: a large building box can
  // cover most of the canvas, leaving no background to drag-pan on.
  // Intercepted on the container in capture phase so Cytoscape never sees
  // the gesture; wired once per page load (the #topology-graph div survives
  // openTopology's innerHTML wipe) and closes over the module-level
  // cyInstance so it tracks re-renders. Trade-off: Ctrl+click no longer
  // toggles node selection (shift+click / shift+drag box-select still do).
  function _wireCtrlPan() {
    var graph = document.getElementById("topology-graph");
    if (!graph || graph.dataset.ctrlPanWired) return;
    graph.dataset.ctrlPanWired = "1";
    var panning = null;
    graph.addEventListener("mousedown", function (e) {
      if (!e.ctrlKey || e.button !== 0 || !cyInstance) return;
      panning = { x: e.clientX, y: e.clientY };
      graph.style.cursor = "grabbing";
      e.preventDefault();
      e.stopPropagation();
    }, true);
    window.addEventListener("mousemove", function (e) {
      if (!panning || !cyInstance) return;
      cyInstance.panBy({ x: e.clientX - panning.x, y: e.clientY - panning.y });
      panning = { x: e.clientX, y: e.clientY };
      e.preventDefault();
      e.stopPropagation();
    }, true);
    window.addEventListener("mouseup", function (e) {
      if (!panning) return;
      panning = null;
      graph.style.cursor = "";
      e.stopPropagation();
    }, true);
  }

  // Which hull tiers to hide for the ACTIVE view: an area view IS the area
  // (keep buildings and below); a building view IS the area+building (keep
  // floors/rooms/jbs); a floor view additionally IS the floor (keep
  // rooms/jbs). Null = flat (Base) view, show everything.
  function _locSuppressKinds() {
    var v = topoState.activeView || "flat";
    if (v === "flat") return null;
    if (v.charAt(0) === "a") return ["area"];
    if (v.charAt(0) === "b") return ["area", "building"];
    return ["area", "building", "floor"];
  }

  // ── Location-view switcher ──────────────────────────────────────────────
  // Chips at the top-left of the graph, one row per level of a drill-down:
  // row 1 is "Base" alone (whole site, default; its view key stays "flat",
  // which saved layouts are filed under). Row 2 is the top level present —
  // the area chips, plus any building tagged with no area — or, on a site
  // with no areas, the building chips. Each row after that appears only
  // under a selection and lists the NEXT level of it: an area's buildings,
  // then a building's floors. Every chip on the selected path stays lit.
  // Keeps a many-building site to a few short rows instead of a wall of
  // chips over the canvas. Rendered only when at least one device carries a
  // b: or f: code — untagged fleets see no switcher.
  function _setTopologyView(key) {
    if (topoState.activeView === key) return;
    // Persist any manual drags under the OUTGOING view's key before switching.
    if (cyInstance && topoState.siteId && !topoState.pathOverlay) saveNodePositions(topoState.siteId);
    topoState.activeView = key;
    if (topoState.data) renderTopologyGraph(topoState.data);
  }
  function _renderTopologyFloorViews() {
    var graph = document.getElementById("topology-graph");
    if (!graph) return;
    if (!graph.style.position) graph.style.position = "relative";
    var wrap = document.getElementById("topology-floor-views");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "topology-floor-views";
      wrap.className = "topology-floor-views";
      graph.appendChild(wrap);
    }
    wrap.innerHTML = "";
    var views = topoState.floorViews || [];
    if (views.length === 0) { wrap.hidden = true; return; }
    function chipEl(key, label, title, active) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "topology-type-chip topology-floor-chip" + (active ? " is-active" : "");
      chip.setAttribute("aria-pressed", active ? "true" : "false");
      chip.title = title;
      chip.textContent = label;
      chip.addEventListener("click", function () { _setTopologyView(key); });
      return chip;
    }
    // One row per drill-down level (topology-render.js viewSwitcherRows):
    // Base, the top level, then the next level under each selection.
    window.PolarisTopologyRender.viewSwitcherRows(views, topoState.activeView).forEach(function (chips, depth) {
      var r = document.createElement("div");
      r.className = "topology-floor-row" + (depth ? " topology-floor-row-depth-" + depth : "");
      chips.forEach(function (c) { r.appendChild(chipEl(c.key, c.label, c.title, c.active)); });
      wrap.appendChild(r);
    });
    wrap.hidden = false;
  }

  // ── Snap devices ─────────────────────────────────────────────────────────
  function _readSnapToGrid() { return _readPref(SNAP_STORAGE_KEY); }

  // Nearest grid cell for a pixel model position. The grid IS the column
  // solver's lattice (TOPO_COL_SPACING × TOPO_ROW_SPACING), so snapped nodes
  // line up exactly with auto-laid-out ones.
  function _snapPos(p) {
    return {
      x: Math.round(p.x / TOPO_COL_SPACING) * TOPO_COL_SPACING,
      y: Math.round(p.y / TOPO_ROW_SPACING) * TOPO_ROW_SPACING,
    };
  }
  // One-time re-snap when the toggle turns on: every live node in the
  // current view lands on its nearest grid cell, hulls re-fit, and the
  // result persists through the normal save pipeline. Other views' SAVED
  // blobs (server-side, writers only) are snapped arithmetically without
  // rendering them — stale node ids inside those blobs snap too, which is
  // harmless (they're ignored at render and dropped on the next real save).
  function _snapAllPositions() {
    if (!cyInstance || !topoState.siteId) return;
    if (topoState.pathOverlay) return; // overlay positions are temporary — don't snap or save them
    var moved = false;
    cyInstance.batch(function () {
      cyInstance.nodes().forEach(function (n) {
        if (n.data("isLocGroup") || n.data("isPortal") || n.data("isEdgeHandle")) return;
        var p = n.position();
        var s = _snapPos(p);
        if (s.x !== p.x || s.y !== p.y) {
          n.position(s);
          moved = true;
        }
      });
    });
    if (moved) {
      if (topoState.hasLocationCodes) {
        window.PolarisTopologyRender.refreshLocationGroups(cyInstance);
        window.PolarisTopologyRender.routeInterGroupEdges(cyInstance);
      }
      _markLayoutDirty();
      saveNodePositions(topoState.siteId);
      _layoutHistoryRecordSoon(); // snapping everything is one undo step
    }
    // Snap the OTHER views' server blobs (the active view was just handled
    // live above). Local-only view layouts stay as-is until visited.
    if (_canWriteServerLayout() && topoState.data && topoState.data.savedLayouts) {
      var activeView = _activeViewKey();
      Object.keys(topoState.data.savedLayouts).forEach(function (view) {
        if (view === activeView) return;
        var entry = topoState.data.savedLayouts[view];
        var positions = entry && entry.positions;
        if (!positions || typeof positions !== "object") return;
        var changed = false;
        var out = {};
        Object.keys(positions).forEach(function (id) {
          var p = positions[id];
          if (!p || typeof p.x !== "number" || typeof p.y !== "number") return;
          var s = _snapPos(p);
          out[id] = s;
          if (s.x !== p.x || s.y !== p.y) changed = true;
        });
        if (changed) {
          _layoutDirty[topoState.siteId + "|" + view] = true;
          _queueServerLayoutSave(topoState.siteId, view, out);
        }
      });
    }
  }


  // Humanize an interface speed in bits/sec → "1 Gbps" / "100 Mbps" etc.
  function _humanizeSpeedBps(bps) {
    if (bps == null || bps <= 0) return "";
    if (bps >= 1e9) return (bps % 1e9 === 0 ? (bps / 1e9).toFixed(0) : (bps / 1e9).toFixed(1)) + " Gbps";
    if (bps >= 1e6) return (bps % 1e6 === 0 ? (bps / 1e6).toFixed(0) : (bps / 1e6).toFixed(1)) + " Mbps";
    if (bps >= 1e3) return (bps / 1e3).toFixed(0) + " Kbps";
    return bps + " bps";
  }
  // One-line interface detail: "lan1 · 1 Gbps · up · errors ↓3 ↑1" (speed/
  // status omitted when unknown; errors shown only when nonzero).
  function _formatIfDetail(d) {
    if (!d || !d.name) return "";
    var bits = [d.name];
    var sp = _humanizeSpeedBps(d.speedBps);
    if (sp) bits.push(sp);
    if (d.operStatus) bits.push(d.operStatus);
    var ie = d.inErrors || 0, oe = d.outErrors || 0;
    if (ie > 0 || oe > 0) bits.push("errors ↓" + ie + " ↑" + oe);
    return bits.join(" · ");
  }

  // Build the concise edge tooltip: "DeviceA  ⇄  DeviceB" on top, the per-side
  // interface ports next, a one-line connection kind, then per-side interface
  // details (speed / status / errors) when available. Reads device names from
  // the endpoint nodes and the port pair from the edge label
  // ("<srcPort> ↔ <tgtPort>"). Returns null when there's nothing useful.
  function buildEdgeTooltipHtml(edge) {
    if (!cyInstance || !edge) return null;
    var srcId = edge.data("source");
    var tgtId = edge.data("target");
    var srcLabel = (cyInstance.getElementById(srcId).data("label")) || srcId || "?";
    var tgtLabel = (cyInstance.getElementById(tgtId).data("label")) || tgtId || "?";
    var ports = String(edge.data("label") || "").trim();
    var kind = edge.data("isMesh")     ? "Wireless mesh backhaul"
             : edge.data("isBridge")   ? "Switch bridged behind AP (wired)"
             : edge.data("isWireless") ? "Wireless client"
             : edge.data("isIface")    ? "Interface-confirmed peer link"
             : edge.data("isLldp")     ? "LLDP neighbor"
             : edge.data("isApLink")   ? "AP switch uplink"
             :                            "FortiLink controller";
    var html =
      '<div style="font-weight:600">' + escapeHtml(srcLabel) +
      ' <span style="opacity:0.7">⇄</span> ' + escapeHtml(tgtLabel) + '</div>';
    if (ports && ports !== "unknown ↔ unknown") {
      html += '<div style="font-family:var(--font-mono,monospace);font-size:0.82em;margin-top:2px">' +
        escapeHtml(ports) + '</div>';
    }
    html += '<div style="opacity:0.7;font-size:0.82em;margin-top:2px">' + escapeHtml(kind) + '</div>';
    // Per-side interface detail, each prefixed with its device so the operator
    // can tell which end "port14" / "port52" lives on (srcIf belongs to the
    // source node, tgtIf to the target).
    var sd = _formatIfDetail(edge.data("srcIf"));
    var td = _formatIfDetail(edge.data("tgtIf"));
    if (sd) html += '<div style="font-size:0.78em;opacity:0.85;margin-top:3px">' +
      '<span style="opacity:0.7">' + escapeHtml(srcLabel) + ':</span> ' + escapeHtml(sd) + '</div>';
    if (td) html += '<div style="font-size:0.78em;opacity:0.85">' +
      '<span style="opacity:0.7">' + escapeHtml(tgtLabel) + ':</span> ' + escapeHtml(td) + '</div>';
    return html;
  }

  // ── Edge hover tooltip ─────────────────────────────────────────────────────
  // Rendered as a fixed-position div appended to <body> (not the modal) so
  // it doesn't get clipped by the modal's overflow rules and stays visible
  // when the modal is fullscreen. Single instance reused for every edge.
  var _edgeTooltipEl = null;
  function ensureEdgeTooltip() {
    if (_edgeTooltipEl) return _edgeTooltipEl;
    var el = document.createElement("div");
    el.id = "topology-edge-tooltip";
    el.setAttribute("role", "tooltip");
    document.body.appendChild(el);
    _edgeTooltipEl = el;
    return el;
  }
  function showEdgeTooltip(html, clientX, clientY) {
    var el = ensureEdgeTooltip();
    // Structured (escaped) HTML built by buildEdgeTooltipHtml — device names,
    // interface ports, and connection kind.
    el.innerHTML = html;
    el.classList.add("visible");
    moveEdgeTooltip(clientX, clientY);
  }
  function moveEdgeTooltip(clientX, clientY) {
    var el = _edgeTooltipEl;
    if (!el || !el.classList.contains("visible")) return;
    // Anchor below-right of the cursor, but flip to above-left near the
    // viewport edge so the tooltip never escapes the screen.
    var pad = 14;
    var rect = el.getBoundingClientRect();
    var maxX = window.innerWidth - rect.width - 6;
    var maxY = window.innerHeight - rect.height - 6;
    var x = clientX + pad; if (x > maxX) x = clientX - rect.width - pad;
    var y = clientY + pad; if (y > maxY) y = clientY - rect.height - pad;
    if (x < 6) x = 6;
    if (y < 6) y = 6;
    el.style.left = x + "px";
    el.style.top  = y + "px";
  }
  function hideEdgeTooltip() {
    if (_edgeTooltipEl) _edgeTooltipEl.classList.remove("visible");
  }

  function renderTopologyInfo(data) {
    var fg = data.fortigate || {};
    var parts = [];
    var fgLabel = escapeHtml(fg.hostname || "FortiGate");
    if (fg.id) {
      parts.push('<h4><a href="/assets.html#asset=' + encodeURIComponent(fg.id) + '">' + fgLabel + '</a></h4>');
    } else {
      parts.push('<h4>' + fgLabel + '</h4>');
    }

    parts.push('<div class="detail-row"><span class="label">Serial</span>' + copyableValue(fg.serial) + '</div>');
    parts.push('<div class="detail-row"><span class="label">Model</span><span class="value">' + escapeHtml(fg.model || "—") + '</span></div>');
    parts.push('<div class="detail-row"><span class="label">Mgmt IP</span>' + copyableValue(fg.ip) + '</div>');
    parts.push('<div class="detail-row"><span class="label">Status</span><span class="value">' + escapeHtml(fg.status || "—") + '</span></div>');
    if (fg.lastSeen) {
      parts.push('<div class="detail-row"><span class="label">Last seen</span><span class="value">' + escapeHtml(new Date(fg.lastSeen).toLocaleString()) + '</span></div>');
    }
    if (fg.latitude != null && fg.longitude != null) {
      var coordsText = fg.latitude.toFixed(4) + ', ' + fg.longitude.toFixed(4);
      parts.push('<div class="detail-row"><span class="label">Coords</span>' + copyableValue(coordsText) + '</div>');
    }

    // With the location boxes on, the switch and AP lists follow the boxes'
    // nesting — area › building › floor › room › junction box — under one
    // heading row per group, so the list reads in the same order as the graph.
    var byLocation = topoState.hasLocationCodes;
    var groupHeadingAt = byLocation ? _topologyLocationHeadings : function () { return null; };

    if ((data.switches || []).length > 0) {
      var switchList = byLocation ? _sortByLocationGroups(data.switches) : data.switches;
      parts.push('<div class="topology-section"><h5>FortiSwitches (' + data.switches.length + ')</h5><ul>');
      switchList.forEach(function (s, si) {
        var swHeading = groupHeadingAt(switchList, si);
        if (swHeading) parts.push(swHeading);
        var endpointCount = s.endpointCount || 0;
        var endpoints = s.endpoints || [];
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(s.id) + '">' + escapeHtml(s.hostname || "(unnamed)") + '</a>' +
          '<span class="meta">' + escapeHtml(displayableUplink(s.uplinkInterface) || "—") + '</span></li>'
        );
        if (endpointCount > 0) {
          var samplesShown = Math.min(endpoints.length, 25);
          var heading = "Endpoints (" + endpointCount + ")";
          if (samplesShown < endpointCount) heading += " — showing " + samplesShown;
          parts.push(
            '<li class="switch-endpoints"><details>' +
            '<summary>' + escapeHtml(heading) + '</summary><ul>'
          );
          endpoints.forEach(function (ep) {
            var primary = ep.hostname || ep.ipAddress || ep.macAddress || "(unnamed)";
            var bits = [];
            if (ep.port) bits.push(ep.port);
            if (ep.ipAddress)  bits.push(ep.ipAddress);
            if (ep.assignedTo) bits.push(ep.assignedTo);
            parts.push(
              '<li><a href="/assets.html#view=asset:' + encodeURIComponent(ep.id) + '">' +
              escapeHtml(primary) + '</a>' +
              '<span class="meta">' + escapeHtml(bits.join(" · ")) + '</span></li>'
            );
          });
          parts.push('</ul></details></li>');
        }
      });
      parts.push('</ul></div>');
    }
    if ((data.aps || []).length > 0) {
      var apList = byLocation ? _sortByLocationGroups(data.aps) : data.aps;
      parts.push('<div class="topology-section"><h5>FortiAPs (' + data.aps.length + ')</h5><ul>');
      apList.forEach(function (a, ai) {
        var apHeading = groupHeadingAt(apList, ai);
        if (apHeading) parts.push(apHeading);
        var meta = a.peerSwitch ? (a.peerSwitch + "/" + (a.peerPort || "?")) : "direct";
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(a.id) + '">' + escapeHtml(a.hostname || "(unnamed)") + '</a>' +
          '<span class="meta">' + escapeHtml(meta) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }
    if ((data.subnets || []).length > 0) {
      parts.push('<div class="topology-section"><h5>Subnets (' + data.subnets.length + ')</h5><ul>');
      data.subnets.forEach(function (n) {
        parts.push(
          '<li><a href="/subnets.html#subnet=' + encodeURIComponent(n.id) + '">' + escapeHtml(n.cidr) + '</a>' +
          '<span class="meta">' + (n.vlan ? 'VLAN ' + n.vlan : (n.name ? escapeHtml(n.name) : '—')) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }

    // CMDB-inferred peers from interface naming conventions (FortiOS-auto
    // serial aggregates + operator-named hostname aggregates). These map
    // back to the solid teal edges in the graph. Built from the inventory
    // we already loaded; sourceIfName tells the operator which local
    // aggregate carries the link.
    var interfaceEdges = data.interfaceEdges || [];
    var remoteLookup = {};
    (data.remoteAssetNodes || []).forEach(function (n) { remoteLookup[n.id] = n; });
    var siblingLookup = {};
    (data.switches || []).forEach(function (s) { siblingLookup[s.id] = s; });
    (data.aps || []).forEach(function (a) { siblingLookup[a.id] = a; });
    if (interfaceEdges.length > 0) {
      parts.push('<div class="topology-section"><h5>Interface-inferred peers (' + interfaceEdges.length + ')</h5><ul>');
      interfaceEdges.forEach(function (e) {
        var target = remoteLookup[e.target] || siblingLookup[e.target] || null;
        var label = target ? (target.hostname || target.ipAddress || target.id) : e.target;
        var hrefId = e.target;
        parts.push(
          '<li><a href="/assets.html#asset=' + encodeURIComponent(hrefId) + '">' + escapeHtml(label) + '</a>' +
          '<span class="meta">' + escapeHtml((e.sourceIfName || "") + (e.matchVia === "hostname" ? " · hostname" : "")) + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }

    // LLDP-discovered neighbors (matched + ghost). Listed alongside Switches /
    // APs so the operator can see what the FortiGate / managed switches
    // actually advertise on the wire — the dashed orange edges in the graph
    // map back to entries here.
    var lldpNodes = data.lldpNodes || [];
    var lldpEdges = data.lldpEdges || [];
    if (lldpNodes.length > 0 || lldpEdges.length > 0) {
      parts.push('<div class="topology-section"><h5>LLDP Neighbors (' + lldpEdges.length + ')</h5><ul>');
      lldpEdges.forEach(function (e) {
        var label = e.targetLabel || "Unknown neighbor";
        var titleHtml = e.targetIsAsset
          ? '<a href="/assets.html#asset=' + encodeURIComponent(e.target) + '">' + escapeHtml(label) + '</a>'
          : escapeHtml(label);
        parts.push(
          '<li><span>' + titleHtml + '</span>' +
          '<span class="meta">' + escapeHtml(e.label || "") + '</span></li>'
        );
      });
      parts.push('</ul></div>');
    }

    var infoEl = document.getElementById("topology-info");
    infoEl.innerHTML = parts.join("");
    _wireCopyableValues(infoEl);
  }

  // The location tiers in nesting order — the same chain the grouping boxes
  // nest by (topology-render.js locationData).
  var _TOPO_LOC_TIERS = ["area", "building", "floor", "room", "junctionBox"];
  function _topoLocKey(value) {
    return String(value).replace(/\s+/g, " ").trim().toLowerCase();
  }
  // Group path of one device: the tier keys it carries, outermost first.
  function _topoLocPath(item) {
    var loc = (item && item.location) || {};
    var path = [];
    _TOPO_LOC_TIERS.forEach(function (t) {
      if (loc[t]) path.push({ tier: t, key: _topoLocKey(loc[t]), name: String(loc[t]) });
    });
    return path;
  }
  // Stable sort by group path, tier by tier (a device stops at its innermost
  // tier, so it lists ahead of the groups nested inside it), devices with no
  // location last, then by hostname. Names compare numerically, so Floor 2
  // comes before Floor 10.
  function _sortByLocationGroups(items) {
    function cmpText(a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }); }
    return items
      .map(function (item, i) { return { item: item, path: _topoLocPath(item), i: i }; })
      .sort(function (x, y) {
        if (!x.path.length !== !y.path.length) return x.path.length ? -1 : 1;
        for (var k = 0; k < Math.min(x.path.length, y.path.length); k++) {
          var tx = _TOPO_LOC_TIERS.indexOf(x.path[k].tier);
          var ty = _TOPO_LOC_TIERS.indexOf(y.path[k].tier);
          if (tx !== ty) return tx - ty;
          var c = cmpText(x.path[k].key, y.path[k].key);
          if (c) return c;
        }
        if (x.path.length !== y.path.length) return x.path.length - y.path.length;
        var h = cmpText(x.item.hostname || "", y.item.hostname || "");
        return h || x.i - y.i;
      })
      .map(function (w) { return w.item; });
  }
  // A heading row for items[i] when it opens a new group (its path differs
  // from the previous item's), or null.
  function _topologyLocationHeadings(items, i) {
    function sig(item) { return _topoLocPath(item).map(function (p) { return p.tier + ":" + p.key; }).join("|"); }
    if (i > 0 && sig(items[i]) === sig(items[i - 1])) return null;
    var path = _topoLocPath(items[i]);
    var label = path.length
      ? path.map(function (p) { return escapeHtml(p.name); }).join(' <span class="sep">›</span> ')
      : "No location";
    return '<li class="topology-loc-group' + (path.length ? "" : " is-none") + '">' + label + '</li>';
  }

  // Renders a value cell with a click-to-copy affordance. Falls back to a
  // plain (non-copyable) cell for empty values so we never copy a literal
  // em-dash.
  function copyableValue(raw) {
    if (raw == null || raw === "") return '<span class="value">—</span>';
    var s = String(raw);
    return '<span class="value copyable" data-copy="' + escapeHtml(s) +
      '" role="button" tabindex="0" title="Click to copy">' + escapeHtml(s) + '</span>';
  }

  function _wireCopyableValues(root) {
    if (!root || root.__copyableWired) return;
    root.__copyableWired = true;
    root.addEventListener("click", function (ev) {
      var el = ev.target && ev.target.closest && ev.target.closest(".copyable");
      if (!el || !root.contains(el)) return;
      ev.preventDefault();
      _copyToClipboard(el.getAttribute("data-copy") || el.textContent, el);
    });
    root.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var el = ev.target && ev.target.closest && ev.target.closest(".copyable");
      if (!el || !root.contains(el)) return;
      ev.preventDefault();
      _copyToClipboard(el.getAttribute("data-copy") || el.textContent, el);
    });
  }

  function _copyToClipboard(text, sourceEl) {
    // Shared robust copy (api.js) — clipboard API with legacy fallback.
    copyTextToClipboard(text).then(function (ok) { _flashCopied(sourceEl, ok); });
  }

  function _flashCopied(el, ok) {
    if (!el) return;
    el.classList.remove("copy-flash-ok", "copy-flash-err");
    void el.offsetWidth; // restart animation
    el.classList.add(ok ? "copy-flash-ok" : "copy-flash-err");
    setTimeout(function () { el.classList.remove("copy-flash-ok", "copy-flash-err"); }, 800);
  }

  // Cross-site asset clicks + topology right-bar links pivot to the canonical
  // asset details slide-over (openViewModal in assets.js, the canonical
  // Slide-over implementation — polaris-ui-canon). assets.js + its UI deps are loaded
  // on map.html for this; each file's DOMContentLoaded handler self-guards
  // so the Assets-page UI doesn't try to bootstrap here.

  function _assetIdFromTopoHref(href) {
    if (!href) return null;
    var m = href.match(/\/assets\.html#(?:asset=|view=asset:)([^&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function setStatus(text) {
    var el = document.getElementById("map-status");
    if (el) el.textContent = text;
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  // Filter out FortiOS meta-interface names that don't add useful
  // information to the topology view. "fortilink" is the software-managed
  // FortiLink interface on the FortiGate side; the relationship it
  // represents is already encoded in the FG→switch edge itself, so
  // displaying it as a label is redundant. Real port names like "port49"
  // or aggregate serial-fragments like "8FFTV23000001-0" still pass through.
  function displayableUplink(name) {
    if (!name) return "";
    return String(name).toLowerCase() === "fortilink" ? "" : name;
  }

  // ─── Region editing (admin / networkadmin only) ──────────────────────────
  // Regions are NOT rendered on the default map view. The "Edit regions"
  // toolbar button toggles an edit mode that overlays existing regions and
  // mounts the leaflet-draw control. Saving / renaming / deleting reconciles
  // tags on the backend; exiting edit mode hides the overlay again.
  var regionState = {
    editing: false,
    layer: null,           // L.featureGroup of L.polygon
    drawControl: null,
    polygonsByRegionId: {}, // id → L.polygon
    drawing: false,         // a new polygon is being drawn (its own clicks own the keys)
    listPayload: null,      // decorated GET /map/regions for the panel tree + drag-to-nest
    undo: [],               // shape edits this session: { id, before, after }
    redo: []
  };

  // ─── Read-only region overlay ("Show regions", any map viewer) ────────────
  // A SEPARATE state object from regionState, not a field on it:
  // teardownRegionEditMode() nulls regionState.layer and clears its polygon
  // map, so hanging the read-only layer off the same object guarantees an
  // eventual accidental teardown. Exactly one of the two owns the drawn
  // regions at any moment — see the handshake in enter/teardown edit mode.
  var regionViewState = {
    showing: false,
    layer: null,
    payload: null,      // memoized /map/region-overlay response
    wasShowing: false,  // restore the overlay after edit mode exits
    polys: {},          // region id -> read-only polygon, shown or not
    hidden: {}          // region ids this account hid (loadHiddenRegions)
  };

  // The pencil is offered to roles holding mapRegions:write — the key every
  // region mutation in src/api/routes/mapRegions.ts gates on. Viewing and the
  // per-region show / hide eyes need only the deviceMap:read that opened the
  // page.
  function canEditRegions() {
    return typeof permAtLeast === "function" && permAtLeast("mapRegions", "write");
  }

  function wireRegionEditing() {
    var editBtn    = document.getElementById("map-edit-regions");
    var saveBtn    = document.getElementById("map-save-regions");
    var undoBtn    = document.getElementById("map-undo-region");
    var redoBtn    = document.getElementById("map-redo-region");
    if (!editBtn) return;
    if (!canEditRegions()) return;
    editBtn.hidden = false;
    // The check mark (save), undo and redo stay hidden until the operator
    // enters edit mode, where the check takes the pencil's place and the
    // panel's × discards. Visibility flips in setEditModeButtons.
    editBtn.addEventListener("click", function () {
      enterRegionEditMode().catch(function (err) {
        setStatus("Failed to load regions: " + (err && err.message ? err.message : err));
      });
    });
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        saveAndExitRegionEditMode().catch(function (err) {
          setStatus("Failed to save regions: " + (err && err.message ? err.message : err));
        });
      });
    }
    if (undoBtn) undoBtn.addEventListener("click", function () { undoRegionEdit(); });
    if (redoBtn) redoBtn.addEventListener("click", function () { redoRegionEdit(); });
    // While editing, the panel's × is Discard Changes rather than "hide".
    // Caught on the panel in the capture phase so legend-toggle's own click
    // handler on the × (which would fold the panel) never runs.
    var panel = editBtn.closest(".map-regions-panel");
    if (panel) {
      panel.addEventListener("click", function (e) {
        if (!regionState.editing) return;
        if (!e.target.closest || !e.target.closest(".legend-toggle-close")) return;
        e.stopPropagation();
        e.preventDefault();
        confirmDiscardRegionEdits();
      }, true);
    }
    document.addEventListener("keydown", function (e) {
      if (!regionState.editing || regionState.drawing) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      var t = e.target;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (document.querySelector(".modal-overlay.open, .modal-overlay.active")) return;
      var k = (e.key || "").toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undoRegionEdit(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redoRegionEdit(); }
    });
  }

  async function confirmDiscardRegionEdits() {
    var dirty = 0;
    for (var rid in regionState.polygonsByRegionId) {
      var p = regionState.polygonsByRegionId[rid];
      if (p && p._polarisDirty) dirty++;
    }
    if (dirty > 0) {
      var ok = await showConfirm("Discard " + dirty + " unsaved region change" + (dirty === 1 ? "" : "s") + "?");
      if (!ok) return;
    }
    discardAndExitRegionEditMode();
  }

  // ---- Undo / redo (edit mode) ----------------------------------------------
  // Covers the edits that are still local until the check mark saves them:
  // vertex drags, midpoint-to-vertex conversions and vertex deletions. Draw,
  // rename, recolor and delete write to the server on the spot (and run the
  // tag reconcile), so they are not in the history. Each entry is the whole
  // ring before and after one leaflet-draw "edit" event.
  function samePairs(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
    }
    return true;
  }

  function setPolygonShape(poly, pairs) {
    poly.setLatLngs(pairs);
    // Re-enable to move the vertex handles with the outline (as Discard does).
    if (poly.editing) { poly.editing.disable(); poly.editing.enable(); }
    setTimeout(function () { colorEditMarkers(poly); }, 0);
    poly._polarisLastPairs = pairs;
    poly._polarisDirty = !samePairs(pairs, poly._polarisSavedPolygon);
  }

  function stepRegionHistory(from, to, field) {
    while (from.length) {
      var entry = from.pop();
      var poly = regionState.polygonsByRegionId[entry.id];
      if (!poly) continue; // the region was deleted since; nothing to reshape
      setPolygonShape(poly, entry[field]);
      to.push(entry);
      break;
    }
    updateUndoRedoButtons();
  }
  function undoRegionEdit() { stepRegionHistory(regionState.undo, regionState.redo, "before"); }
  function redoRegionEdit() { stepRegionHistory(regionState.redo, regionState.undo, "after"); }

  function updateUndoRedoButtons() {
    var undoBtn = document.getElementById("map-undo-region");
    var redoBtn = document.getElementById("map-redo-region");
    if (undoBtn) undoBtn.disabled = regionState.undo.length === 0;
    if (redoBtn) redoBtn.disabled = regionState.redo.length === 0;
  }

  // The panel's rows while editing: read from the edit layer, so a region
  // drawn, renamed, recoloured or deleted this session shows at once. Levels
  // are left off — they are derived on the server and an edit can move them.
  // Edit mode's panel list: the same nested tree as view mode, from the
  // decorated GET /map/regions (levels, parents, containerIds), with rows
  // draggable for drag-to-nest. Re-fetched after every saved change, since a
  // create / delete / nest can re-level the whole tree. Callers don't await
  // it except where they report the new level.
  async function renderEditRegionsList() {
    var el = document.getElementById("map-regions-list");
    if (!el) return;
    var regions = [];
    try {
      regions = await api.mapRegions.list();
    } catch (e) {
      regions = [];
    }
    if (!regionState.editing) return; // exited while the fetch was in flight
    regionState.listPayload = { regions: Array.isArray(regions) ? regions : [] };
    if (!window.PolarisRegionTree) { el.innerHTML = ""; return; }
    el.innerHTML = window.PolarisRegionTree.buildPanelTreeHtml(regionState.listPayload, {
      draggable: true,
      emptyText: "No regions yet. Draw one with the polygon tool."
    });
    wireRegionsListDnD();
  }

  // ---- "Show regions" (read-only) -----------------------------------------
  // Unlike Edit regions this is NOT permission-gated: any viewer who can see
  // the map can see how its regions nest. It reads /map/region-overlay, which
  // sits under the deviceMap:read mount for exactly that reason.
  //
  // Since 2026-10-16 it is a panel on the map's top-right corner that
  // collapses into its own button (legend-toggle.js), like the status legend:
  // opening it draws the regions and lists them; its × hides them again; its
  // pencil (roles that may edit regions — wireRegionEditing) enters edit mode,
  // replacing the toolbar's Edit regions. The collapsed button keeps the
  // #map-show-regions id the edit-mode code disables, and the pencil keeps
  // #map-edit-regions.
  var REGIONS_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true">' +
      '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>' +
    "</svg>";
  var PENCIL_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true">' +
      '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>';
  var CHECK_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">' +
      '<polyline points="20 6 9 17 4 12"/></svg>';
  var UNDO_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">' +
      '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>';
  var REDO_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14" aria-hidden="true">' +
      '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>';
  var regionsPanelApi = null;

  function buildRegionsPanel() {
    var ctl = L.control({ position: "topright" });
    ctl.onAdd = function () {
      var div = L.DomUtil.create("div", "map-legend map-regions-panel");
      div.innerHTML =
        '<div class="legend-toggle-head">' +
          '<span class="map-regions-title">' +
            '<button type="button" id="map-edit-regions" class="map-regions-tool" title="Edit regions" aria-label="Edit regions" hidden>' + PENCIL_ICON + "</button>" +
            '<button type="button" id="map-save-regions" class="map-regions-tool map-regions-save" title="Save region changes" aria-label="Save region changes" hidden>' + CHECK_ICON + "</button>" +
            '<span class="map-regions-name">Regions</span>' +
          "</span>" +
          '<span class="map-regions-actions">' +
            '<button type="button" id="map-undo-region" class="map-regions-tool" title="Undo (Ctrl+Z)" aria-label="Undo" hidden disabled>' + UNDO_ICON + "</button>" +
            '<button type="button" id="map-redo-region" class="map-regions-tool" title="Redo (Ctrl+Y)" aria-label="Redo" hidden disabled>' + REDO_ICON + "</button>" +
            '<button type="button" class="legend-toggle-close" title="Hide regions" aria-label="Hide regions">&times;</button>' +
          "</span>" +
        "</div>" +
        '<div class="map-regions-list" id="map-regions-list"></div>';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.disableScrollPropagation(div);
      return div;
    };
    ctl.addTo(map);
    var panel = ctl.getContainer();
    if (!window.PolarisLegendToggle) return null;
    regionsPanelApi = window.PolarisLegendToggle.attach(panel, {
      closeButton: panel.querySelector(".legend-toggle-close"),
      icon: REGIONS_ICON,
      openLabel: "Show regions",
      expanded: false,
      onChange: function (expanded) {
        (expanded ? showRegionOverlay() : Promise.resolve(hideRegionOverlay())).catch(function (err) {
          setStatus("Failed to load regions: " + (err && err.message ? err.message : err));
        });
      },
    });
    regionsPanelApi.button.id = "map-show-regions";
    return regionsPanelApi.button;
  }

  // The panel's rows: the containment tree, each region indented under its
  // parent with its colour, name and nesting level (region-tree.js), and an
  // eye per row that shows / hides that region's polygon.
  function renderRegionsList(payload) {
    var el = document.getElementById("map-regions-list");
    if (!el) return;
    if (!window.PolarisRegionTree) { el.innerHTML = ""; return; }
    el.innerHTML = window.PolarisRegionTree.buildPanelTreeHtml(payload, {
      visibility: true,
      hidden: regionViewState.hidden
    });
    wireRegionEyes();
  }

  // ---- Per-region show / hide (view mode) -----------------------------------
  // Any viewer of the map may hide regions they don't care about; it changes
  // only what their own maps draw, so it needs no permission beyond
  // deviceMap:read. Stored on the account (GET / PUT /me/hidden-map-regions)
  // so the phone's Map tab hides the same regions and FortiGates; keyed by
  // region id (a rename keeps it hidden; a deleted region's id is simply never
  // matched). Hiding a region hides everything nested under it and every
  // FortiGate inside it (applySiteVisibility), and each toggle re-fits the
  // view to the FortiGates still shown. Global search still opens a hidden
  // gate's topology: polarisMapOpenSiteTopology looks it up in siteCache,
  // which keeps every site, not only the drawn ones. Edit mode ignores the
  // set for POLYGONS and draws every one — an editor has to see what they are
  // reshaping and nesting.

  // The browser-only copy this page kept before the hidden set moved onto
  // the User (2026-10-28). Read once, uploaded when the account has nothing
  // stored yet, then removed.
  function _legacyHiddenRegionsKey() {
    var u = (typeof currentUsername === "string" && currentUsername) ? currentUsername : "anon";
    return "polaris-prefs-map-hidden-regions-" + u;
  }

  function idsToSet(ids) {
    var out = {};
    if (Array.isArray(ids)) ids.forEach(function (id) { if (typeof id === "string" && id) out[id] = true; });
    return out;
  }

  // GET /me/hidden-map-regions — the same list the phone's Map tab reads. A
  // failed read hides nothing rather than blocking the map.
  async function loadHiddenRegions() {
    var legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(_legacyHiddenRegionsKey()) || "[]"); } catch (e) { legacy = []; }
    try {
      var res = await api.hiddenMapRegions.get();
      var ids = res && Array.isArray(res.regionIds) ? res.regionIds : [];
      if (ids.length === 0 && Array.isArray(legacy) && legacy.length > 0) {
        res = await api.hiddenMapRegions.set(legacy);
        ids = res && Array.isArray(res.regionIds) ? res.regionIds : legacy;
      }
      try { localStorage.removeItem(_legacyHiddenRegionsKey()); } catch (e) { /* nothing to clean */ }
      return idsToSet(ids);
    } catch (e) {
      return idsToSet(legacy);
    }
  }

  // PUT the whole set after every toggle. Writes are chained so a quick
  // hide-then-show lands in click order; a failed write says so but keeps the
  // map as the operator left it.
  var hiddenRegionsWrite = Promise.resolve();
  function saveHiddenRegions() {
    var ids = Object.keys(regionViewState.hidden);
    hiddenRegionsWrite = hiddenRegionsWrite.then(function () {
      return api.hiddenMapRegions.set(ids);
    }).catch(function (err) {
      showToast("Could not save hidden regions: " + (err && err.message ? err.message : err), "error");
    });
  }

  function wireRegionEyes() {
    var el = document.getElementById("map-regions-list");
    if (!el || el._polarisEyes) return;
    el._polarisEyes = true;
    el.addEventListener("click", function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest(".map-regions-eye[data-region-eye]") : null;
      if (!btn || !el.contains(btn) || regionState.editing) return;
      ev.preventDefault();
      toggleRegionVisibility(btn.getAttribute("data-region-eye"));
    });
  }

  // Hiding cascades: a region nested under a hidden one is hidden with it
  // (PolarisRegionTree.effectiveHidden), and shown again with it.
  function regionEffectiveHidden() {
    if (!regionViewState.payload || !window.PolarisRegionTree) return regionViewState.hidden;
    return window.PolarisRegionTree.effectiveHidden(regionViewState.payload, regionViewState.hidden);
  }

  // Brings the read-only layer in line with the hidden set: every polygon
  // added or removed, then the shown ones re-stacked largest first (a re-add
  // lands on top, which would bury the regions inside it and their hover).
  function syncRegionPolygons() {
    if (!regionViewState.layer) return;
    var eff = regionEffectiveHidden();
    var ordered = regionViewState.payload && window.PolarisRegionTree
      ? window.PolarisRegionTree.paintOrder(regionViewState.payload)
      : [];
    ordered.forEach(function (r) {
      var p = regionViewState.polys[r.id];
      if (!p) return;
      if (eff[r.id]) { regionViewState.layer.removeLayer(p); return; }
      regionViewState.layer.addLayer(p);
      if (p.bringToFront) p.bringToFront();
    });
  }

  function toggleRegionVisibility(id) {
    if (!id) return;
    if (regionViewState.hidden[id]) delete regionViewState.hidden[id];
    else regionViewState.hidden[id] = true;
    saveHiddenRegions();
    syncRegionPolygons();
    if (regionViewState.payload) renderRegionsList(regionViewState.payload);
    // The FortiGates inside follow their region, and the view re-fits to
    // whatever is still on the map.
    applySiteVisibility({ fit: true });
    var eye = document.querySelector('.map-regions-eye[data-region-eye="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]');
    if (eye) eye.focus();
  }

  // ---- Drag-to-nest (edit mode) ---------------------------------------------
  // Dragging a row onto another nests it under that region, which re-levels
  // the tree. Geometry stays the authority: only a region whose polygon
  // CONTAINS the dragged one accepts the drop (the server re-checks, 400
  // otherwise), so this picks between real containers — e.g. a state inside
  // both a sub-region and its division. Dropping it back on its smallest
  // container returns it to automatic nesting. Saved immediately, like a
  // rename; the check mark only saves shapes.
  var regionNestDrag = { id: null, overId: null };

  function wireRegionsListDnD() {
    var el = document.getElementById("map-regions-list");
    if (!el || el._polarisDnD) return;
    el._polarisDnD = true;
    function rowOf(ev) {
      var t = ev.target && ev.target.closest ? ev.target.closest(".map-regions-row[data-region-id]") : null;
      return t && el.contains(t) ? t : null;
    }
    function clearMarks() {
      el.querySelectorAll(".map-regions-drop-ok, .map-regions-drop-no").forEach(function (n) {
        n.classList.remove("map-regions-drop-ok", "map-regions-drop-no");
      });
    }
    el.addEventListener("dragstart", function (ev) {
      var row = rowOf(ev);
      if (!row || !regionState.editing) return;
      regionNestDrag.id = row.getAttribute("data-region-id");
      regionNestDrag.overId = null;
      row.classList.add("map-regions-dragging");
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "move";
        try { ev.dataTransfer.setData("text/plain", regionNestDrag.id); } catch (e) { /* some browsers refuse custom data */ }
      }
    });
    el.addEventListener("dragover", function (ev) {
      if (!regionNestDrag.id) return;
      var row = rowOf(ev);
      var targetId = row ? row.getAttribute("data-region-id") : null;
      var verdict = targetId && window.PolarisRegionTree
        ? window.PolarisRegionTree.canNestUnder(regionState.listPayload, regionNestDrag.id, targetId)
        : { ok: false, reason: "" };
      if (verdict.ok) {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
      }
      if (targetId === regionNestDrag.overId) return;
      regionNestDrag.overId = targetId;
      clearMarks();
      if (row && targetId !== regionNestDrag.id) row.classList.add(verdict.ok ? "map-regions-drop-ok" : "map-regions-drop-no");
      if (verdict.reason) setStatus(verdict.reason);
      else if (verdict.ok) setStatus("Drop to nest it here.");
    });
    el.addEventListener("drop", function (ev) {
      var row = rowOf(ev);
      var childId = regionNestDrag.id;
      var targetId = row ? row.getAttribute("data-region-id") : null;
      if (!childId || !targetId || !window.PolarisRegionTree) return;
      var verdict = window.PolarisRegionTree.canNestUnder(regionState.listPayload, childId, targetId);
      if (!verdict.ok) return;
      ev.preventDefault();
      nestRegionUnder(childId, targetId);
    });
    el.addEventListener("dragend", function () {
      regionNestDrag.id = null;
      regionNestDrag.overId = null;
      clearMarks();
      el.querySelectorAll(".map-regions-dragging").forEach(function (n) { n.classList.remove("map-regions-dragging"); });
    });
  }

  async function nestRegionUnder(childId, targetId) {
    var regions = (regionState.listPayload && regionState.listPayload.regions) || [];
    var child = regions.find(function (r) { return r.id === childId; });
    var target = regions.find(function (r) { return r.id === targetId; });
    var automatic = child && Array.isArray(child.containerIds) && child.containerIds[0] === targetId;
    try {
      await api.mapRegions.setNesting(childId, automatic ? null : targetId);
      // Levels can move all the way up the tree; the read-only overlay's
      // memoized payload is stale too.
      regionViewState.payload = null;
      await renderEditRegionsList();
      var fresh = (regionState.listPayload && regionState.listPayload.regions || []).find(function (r) { return r.id === childId; });
      setStatus('"' + (child ? child.name : "Region") + '" nested under "' + (target ? target.name : "") + '"' +
        (fresh ? " — now L" + (fresh.level == null ? 1 : fresh.level) : "") + ".");
    } catch (err) {
      showToast("Failed to nest region: " + (err && err.message ? err.message : err), "error");
    }
  }

  function wireShowRegions() {
    var btn = buildRegionsPanel();
    if (!btn) return;
    if (window.PolarisRegionTree && typeof window.PolarisRegionTree.attachTreeTooltip === "function") {
      // Reuses the topology edge tooltip, which is already body-mounted (so
      // modal overflow can't clip it), viewport-edge aware and in this IIFE.
      window.PolarisRegionTree.attachTreeTooltip(btn, loadRegionOverlay, {
        show: showEdgeTooltip,
        move: moveEdgeTooltip,
        hide: hideEdgeTooltip
      });
    }
  }

  // Memoized per page visit. Cleared when edit mode exits, since a polygon
  // edit can have changed every level in the tree.
  async function loadRegionOverlay() {
    if (regionViewState.payload) return regionViewState.payload;
    var data = await api.mapRegions.overlay();
    regionViewState.payload = data || { regions: [], roots: [], maxLevel: 0, warnings: [] };
    return regionViewState.payload;
  }

  // Keeps the Regions panel open while the overlay shows and folded while it
  // doesn't (an edit-mode handover hides the overlay, so it folds the panel).
  function setShowRegionsButton(showing) {
    if (regionsPanelApi) regionsPanelApi.setExpanded(!!showing);
  }

  async function showRegionOverlay() {
    if (regionState.editing) return; // edit mode owns the polygons
    var payload = await loadRegionOverlay();
    var regions = (payload && Array.isArray(payload.regions)) ? payload.regions : [];
    if (regions.length === 0) {
      // The panel stays open to say so; there is nothing to draw.
      renderRegionsList(payload);
      setStatus("No regions are defined yet.");
      return;
    }
    regionViewState.layer = L.featureGroup().addTo(map);
    regionViewState.polys = {};
    var ordered = window.PolarisRegionTree
      ? window.PolarisRegionTree.paintOrder(payload)
      : regions;
    renderRegionsList(payload);
    var eff = regionEffectiveHidden();
    for (var i = 0; i < ordered.length; i++) {
      addReadOnlyRegionPolygon(ordered[i], payload.maxLevel, eff);
    }
    regionViewState.showing = true;
    setShowRegionsButton(true);
    setStatus(window.PolarisRegionTree ? window.PolarisRegionTree.summaryLine(payload) : "");
  }

  // Read-only twin of addRegionPolygon. Shares applyRegionColor and nothing
  // else — in particular no click handler that could open the rename / delete
  // popup, and no vertex handles.
  function addReadOnlyRegionPolygon(region, maxLevel, effHidden) {
    if (!region || !Array.isArray(region.polygon) || region.polygon.length < 3) return;
    var style = window.PolarisRegionTree
      ? window.PolarisRegionTree.overlayStyle(region.level, maxLevel)
      : { weight: 2, fillOpacity: 0.06, labelPermanent: false, dashArray: null };
    var poly = L.polygon(region.polygon, {
      className: "map-region-polygon map-region-polygon-readonly",
      weight: style.weight,
      fillOpacity: style.fillOpacity,
      dashArray: style.dashArray || null
      // Left INTERACTIVE (Leaflet's default) so the per-region hover label
      // below actually fires — a non-interactive layer never gets mouseover, so
      // every region would have needed a permanent label instead. Site markers
      // still win any click: they live in Leaflet's markerPane, which sits
      // above the overlayPane these polygons are drawn in. No click handler is
      // attached here, so a click on bare polygon does nothing.
    });
    applyRegionColor(poly, region.color);
    var label = escapeHtml(region.name) + " (L" + (region.level == null ? 1 : region.level) + ")";
    // Only the outermost ring of a nested set gets a permanent label; labelling
    // every ring at every depth is unreadable.
    poly.bindTooltip(label, {
      permanent: !!style.labelPermanent,
      direction: "center",
      className: "map-region-label"
    });
    regionViewState.polys[region.id] = poly;
    if (!(effHidden || regionViewState.hidden)[region.id]) regionViewState.layer.addLayer(poly);
  }

  function hideRegionOverlay() {
    if (regionViewState.layer) { map.removeLayer(regionViewState.layer); regionViewState.layer = null; }
    regionViewState.polys = {};
    regionViewState.showing = false;
    setShowRegionsButton(false);
  }

  // Swap the Regions panel's header between view (pencil, × hides) and edit
  // (check mark saves, undo / redo, × discards). Single helper so the
  // visibility rule lives in one place.
  function setEditModeButtons(editing) {
    var editBtn = document.getElementById("map-edit-regions");
    var saveBtn = document.getElementById("map-save-regions");
    var undoBtn = document.getElementById("map-undo-region");
    var redoBtn = document.getElementById("map-redo-region");
    if (editBtn) editBtn.hidden = editing;
    if (saveBtn) saveBtn.hidden = !editing;
    if (undoBtn) undoBtn.hidden = !editing;
    if (redoBtn) redoBtn.hidden = !editing;
    var panel = editBtn && editBtn.closest(".map-regions-panel");
    var close = panel && panel.querySelector(".legend-toggle-close");
    if (close) {
      var label = editing ? "Discard changes" : "Hide regions";
      close.title = label;
      close.setAttribute("aria-label", label);
    }
    if (panel) panel.classList.toggle("map-regions-editing", !!editing);
    updateUndoRedoButtons();
  }

  async function enterRegionEditMode() {
    if (regionState.editing) return;
    // Hand the polygons over from the read-only overlay. Two stacked layers
    // would double-render every region, and the read-only ones sitting on top
    // would swallow the clicks that open the rename / delete popup.
    regionViewState.wasShowing = regionViewState.showing;
    if (regionViewState.showing) hideRegionOverlay();
    var showBtn = document.getElementById("map-show-regions");
    if (showBtn) {
      showBtn.disabled = true;
      showBtn.title = "Regions are shown while you are editing them";
    }
    regionState.editing = true;
    regionState.polygonsByRegionId = {};
    regionState.undo = [];
    regionState.redo = [];
    regionState.layer = L.featureGroup().addTo(map);
    // The panel stays open while editing: its header holds save / undo /
    // redo / discard.
    if (regionsPanelApi) regionsPanelApi.setExpanded(true);

    var regions = [];
    try {
      regions = await api.mapRegions.list();
    } catch (e) {
      regionState.editing = false;
      if (regionState.layer) { map.removeLayer(regionState.layer); regionState.layer = null; }
      if (showBtn) { showBtn.disabled = false; showBtn.title = ""; }
      if (regionViewState.wasShowing) {
        regionViewState.wasShowing = false;
        showRegionOverlay().catch(function () { /* the Regions button can retry */ });
      } else if (regionsPanelApi) {
        regionsPanelApi.setExpanded(false);
      }
      throw e;
    }
    if (Array.isArray(regions)) {
      for (var i = 0; i < regions.length; i++) addRegionPolygon(regions[i]);
      restackRegionPolygons();
    }

    regionState.drawControl = new L.Control.Draw({
      position: "topright",
      draw: {
        polygon: { allowIntersection: false, showArea: false, shapeOptions: { className: "map-region-polygon" } },
        polyline: false, rectangle: false, circle: false, marker: false, circlemarker: false
      }
      // No `edit` config — vertex editing is always on per polygon (see
      // enablePolygonVertexEdit). Delete stays in the polygon-click popup.
    });
    map.addControl(regionState.drawControl);

    map.on(L.Draw.Event.CREATED, onRegionCreated);
    map.on(L.Draw.Event.DRAWSTART, onRegionDrawStart);
    map.on(L.Draw.Event.DRAWSTOP, onRegionDrawStop);

    setEditModeButtons(true);
    renderEditRegionsList();
    setStatus("Editing regions: draw a polygon, drag any vertex to reshape (undo / redo in the Regions panel, or Ctrl+Z / Ctrl+Y), click an existing region to rename/delete, or right-click-drag to pan. Click the check mark to save or × to discard.");
  }

  function onRegionDrawStart() { regionState.drawing = true; }
  function onRegionDrawStop() { regionState.drawing = false; }

  // Walk every region polygon in edit mode and PUT the ones whose vertices
  // were dragged this session. On all-success, exit edit mode. On any
  // failure, surface the count, keep the failed polygons marked dirty, and
  // leave the operator in edit mode so they can retry. Polygons whose
  // drag-end shape matches the loaded shape (no net change) are skipped.
  async function saveAndExitRegionEditMode() {
    var dirty = [];
    for (var rid in regionState.polygonsByRegionId) {
      var p = regionState.polygonsByRegionId[rid];
      if (p && p._polarisDirty) dirty.push(p);
    }
    if (dirty.length === 0) {
      // No polygon edits, but the save click still reviews: it's the
      // operator's assertion that the drawn geography is the truth, and the
      // review is what strips stale region tags off gates that MOVED (their
      // pin changed rather than any polygon).
      teardownRegionEditMode();
      setStatus("Reviewing region tags…");
      var reviewOnly = await reviewRegionTags();
      setStatus(reviewOnly);
      return;
    }
    setStatus("Saving " + dirty.length + " region change" + (dirty.length === 1 ? "" : "s") + "…");
    var failures = 0;
    // SEQUENTIAL, not Promise.all. Every region write is a read-modify-write of
    // the whole mapRegions blob, so the server serializes them on an advisory
    // lock anyway (see withRegionBlobLock) — firing them concurrently just
    // parks N requests on that lock, each holding a DB connection while it
    // waits, which at a couple of dozen dragged polygons can starve the pool
    // for everything else. Wall-clock is essentially the same because the work
    // was already serial; what changes is that we stop holding the connections.
    //
    // It also makes the order deterministic and lets a failure be attributed to
    // the polygon that caused it.
    for (var di = 0; di < dirty.length; di++) {
      var poly = dirty[di];
      var pairs = polygonLatLngsToPairs(poly);
      try {
        await api.mapRegions.update(poly._polarisRegionId, { polygon: pairs });
        poly._polarisSavedPolygon = pairs;
        poly._polarisDirty = false;
      } catch (err) {
        failures++;
        // Per-polygon alert so the operator knows exactly which one failed.
        showToast("Failed to save region \"" + (poly._polarisRegionName || "") + "\": " + (err && err.message ? err.message : err), "error");
      }
    }
    if (failures > 0) {
      setStatus(failures + " region" + (failures === 1 ? "" : "s") + " failed to save — still in edit mode; click the check mark to retry or × to discard.");
      return;
    }
    teardownRegionEditMode();
    setStatus(dirty.length + " region" + (dirty.length === 1 ? "" : "s") + " saved. Reviewing region tags…");
    var review = await reviewRegionTags();
    setStatus(dirty.length + " region" + (dirty.length === 1 ? "" : "s") + " saved." + (review ? " " + review : ""));
  }

  // POST /map/regions/reconcile — every Save Regions click reviews region tags
  // fleet-wide: the provenance-bounded reconcile (re-add members, strip tracked
  // drift) plus the gate pass that removes region tags from pinned FortiGates
  // no longer inside the named polygon. Non-fatal by design: the polygon PUTs
  // above already landed, so a review failure downgrades to a toast instead of
  // keeping the operator in edit mode. Returns the status-line summary ("" when
  // nothing changed or the call failed).
  async function reviewRegionTags() {
    try {
      var s = await api.mapRegions.reconcile();
      if (!s) return "";
      var bits = [];
      if (s.assetsTouched > 0)  bits.push("assets +" + s.added + "/−" + s.removed);
      if (s.subnetsTouched > 0) bits.push("networks +" + s.subnetsAdded + "/−" + s.subnetsRemoved);
      if (s.firewallTagsStripped > 0) {
        bits.push(s.firewallTagsStripped + " stale gate tag" + (s.firewallTagsStripped === 1 ? "" : "s") + " removed");
      }
      return bits.length > 0 ? "Region tags reviewed: " + bits.join(", ") + "." : "";
    } catch (err) {
      showToast("Region tag review failed — " + (err && err.message ? err.message : err), "error");
      return "";
    }
  }

  // Revert every dirty polygon to the shape it had when edit mode opened
  // (or to the shape from the last successful save during this session).
  // Doesn't touch polygons created or deleted this session — those went
  // through their own explicit PUT/DELETE and aren't tracked here.
  function discardAndExitRegionEditMode() {
    var reverted = 0;
    for (var rid in regionState.polygonsByRegionId) {
      var p = regionState.polygonsByRegionId[rid];
      if (!p || !p._polarisDirty) continue;
      if (Array.isArray(p._polarisSavedPolygon)) {
        p.setLatLngs(p._polarisSavedPolygon);
        // Re-enable editing to refresh the marker positions; without this,
        // the vertex handles still sit at the dragged locations even though
        // the polygon outline snapped back.
        if (p.editing) { p.editing.disable(); p.editing.enable(); }
        setTimeout((function (pp) { return function () { colorEditMarkers(pp); }; })(p), 0);
      }
      p._polarisDirty = false;
      reverted++;
    }
    teardownRegionEditMode();
    setStatus(reverted > 0 ? reverted + " region change" + (reverted === 1 ? "" : "s") + " discarded." : "");
  }

  // Tear-down only — shared by both save and discard paths. No network I/O
  // happens here.
  function teardownRegionEditMode() {
    regionState.editing = false;
    regionState.drawing = false;
    map.off(L.Draw.Event.CREATED, onRegionCreated);
    map.off(L.Draw.Event.DRAWSTART, onRegionDrawStart);
    map.off(L.Draw.Event.DRAWSTOP, onRegionDrawStop);
    if (regionState.drawControl) { map.removeControl(regionState.drawControl); regionState.drawControl = null; }
    if (regionState.layer) { map.removeLayer(regionState.layer); regionState.layer = null; }
    regionState.polygonsByRegionId = {};
    regionState.undo = [];
    regionState.redo = [];
    setEditModeButtons(false);

    // Hand the polygons back. The memoized payload is DROPPED rather than
    // reused: an edit in this session can have changed the nesting, and
    // therefore every level in the tree.
    var showBtn = document.getElementById("map-show-regions");
    if (showBtn) { showBtn.disabled = false; showBtn.title = ""; }
    regionViewState.payload = null;
    if (regionViewState.wasShowing) {
      regionViewState.wasShowing = false;
      showRegionOverlay().catch(function () { /* the toolbar button can retry */ });
    } else if (regionsPanelApi) {
      regionsPanelApi.setExpanded(false);
    }
    // A reshape, nest or delete can move FortiGates into or out of a hidden
    // region; re-judge them against the fresh geometry without moving the view.
    ensureRegionPayloadForSites().then(function () { applySiteVisibility({ fit: false }); });
  }

  function addRegionPolygon(region) {
    if (!region || !Array.isArray(region.polygon) || region.polygon.length < 3) return;
    var poly = L.polygon(region.polygon, { className: "map-region-polygon" });
    poly._polarisRegionId = region.id;
    poly._polarisRegionName = region.name;
    poly._polarisRegionColor = region.color || null;
    applyRegionColor(poly, region.color);
    poly.bindTooltip(escapeHtml(region.name), { permanent: true, direction: "center", className: "map-region-label" });
    poly.on("click", function () { openRegionActionsPopup(poly); });
    regionState.layer.addLayer(poly);
    regionState.polygonsByRegionId[region.id] = poly;
    enablePolygonVertexEdit(poly);
  }

  // Apply the region's color to the polygon stroke + fill. The CSS class
  // map-region-polygon still owns stroke width / opacities; this overrides
  // only the hue. Falls through to the CSS default (accent) when color is
  // missing — that path exists for legacy regions that haven't been rewritten
  // yet, though the backend back-fills a random palette pick at load time.
  function applyRegionColor(poly, color) {
    if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return;
    poly.setStyle({ color: color, fillColor: color });
  }

  // Turns on leaflet-draw's per-polygon vertex/midpoint handles immediately
  // (no Edit-toolbar round-trip). Every vertex drag fires `editvertex` on the
  // polygon, which only marks it DIRTY — there is no autosave. Saving is
  // explicit (Save Regions writes every dirty polygon; Discard Changes reverts
  // them to _polarisSavedPolygon), which is what keeps a half-dragged shape
  // from reaching the server.
  function enablePolygonVertexEdit(poly) {
    if (!poly || !poly.editing) return;
    poly.editing.enable();
    // Recolor the freshly-created vertex/midpoint markers to match the
    // polygon's hue. Deferred one tick so leaflet-draw has finished mounting
    // the markers into the marker pane.
    setTimeout(function () { colorEditMarkers(poly); }, 0);
    // Capture the loaded shape so Discard Changes can revert in-place. Any
    // editvertex fired afterward marks the polygon dirty so the Save / Discard
    // paths know which ones need attention; clean polygons are skipped.
    poly._polarisSavedPolygon = polygonLatLngsToPairs(poly);
    poly._polarisLastPairs = poly._polarisSavedPolygon;
    poly._polarisDirty = false;
    // leaflet-draw 1.0.4 fires plain "edit" on the polygon at each vertex
     // drag-end / midpoint-drag-conversion / vertex-deletion. The map gets
     // "draw:editvertex" (constant L.Draw.Event.EDITVERTEX) — that name does
     // NOT fire on the polygon itself, so this listener must be "edit".
    poly.on("edit", function () {
      // Midpoint-drag→vertex conversions add fresh markers; vertex deletions
      // remove them. Either way, re-color so the dot set always matches the
      // region. Deferred so the marker DOM is settled when we walk it.
      setTimeout(function () { colorEditMarkers(poly); }, 0);
      var after = polygonLatLngsToPairs(poly);
      if (!samePairs(after, poly._polarisLastPairs)) {
        regionState.undo.push({ id: poly._polarisRegionId, before: poly._polarisLastPairs, after: after });
        regionState.redo = [];
        poly._polarisLastPairs = after;
        updateUndoRedoButtons();
      }
      poly._polarisDirty = !samePairs(after, poly._polarisSavedPolygon);
      // A reshape can make this polygon swallow, or slip inside, another.
      restackRegionPolygons();
    });
  }

  // Edit mode stacks polygons by AREA, largest at the back, so a region inside
  // another (the lower L#) always sits on top and takes the click that opens
  // its rename / delete popup. Leaflet's default is insertion order, which put
  // a division drawn after its states over all of them. Re-run on load, after
  // a new polygon and after every reshape; "Send to Bottom Layer" still
  // overrides it for overlapping (not nested) regions until the next restack.
  function restackRegionPolygons() {
    var polys = [];
    for (var rid in regionState.polygonsByRegionId) {
      var p = regionState.polygonsByRegionId[rid];
      if (p && typeof p.bringToFront === "function") {
        var area = window.PolarisRegionTree ? window.PolarisRegionTree.polygonArea(polygonLatLngsToPairs(p)) : 0;
        polys.push({ poly: p, area: area });
      }
    }
    polys.sort(function (a, b) { return b.area - a.area; });
    for (var i = 0; i < polys.length; i++) polys[i].poly.bringToFront();
  }

  // Per-polygon vertex/midpoint marker recoloring. leaflet-draw mounts each
  // marker into the shared marker pane (siblings, not children of the polygon
  // path), so we can't reach them with a CSS-variable trick — walking the
  // handler's internal `_markerGroup` and setting borderColor inline is the
  // only stable hook. The base shape stays from the .leaflet-editing-icon
  // CSS class; we only override the ring hue.
  function colorEditMarkers(poly) {
    if (!poly || !poly.editing) return;
    var color = poly._polarisRegionColor;
    if (!color) return;
    var handlers = poly.editing._verticesHandlers || [];
    for (var h = 0; h < handlers.length; h++) {
      var group = handlers[h] && handlers[h]._markerGroup;
      if (!group || typeof group.eachLayer !== "function") continue;
      group.eachLayer(function (m) {
        if (m && m._icon) m._icon.style.borderColor = color;
      });
    }
  }

  function polygonLatLngsToPairs(poly) {
    // L.Polygon.getLatLngs() returns nested rings for multi-rings; we only
    // create simple polygons here, so pull the first ring out.
    var rings = poly.getLatLngs();
    var ring = Array.isArray(rings) && rings.length > 0 && Array.isArray(rings[0]) ? rings[0] : rings;
    var pairs = [];
    for (var i = 0; i < ring.length; i++) {
      var ll = ring[i];
      pairs.push([ll.lat, ll.lng]);
    }
    return pairs;
  }

  async function onRegionCreated(e) {
    var layer = e.layer;
    var pairs = polygonLatLngsToPairs(layer);
    var details = await promptRegionDetails("Name this region", "", randomRegionColor());
    if (!details) return; // cancelled
    try {
      var saved = await api.mapRegions.create(details.name, pairs, details.color);
      // Replace the temporary draw layer with our managed L.polygon so
      // it picks up the styled className + click handler.
      addRegionPolygon(saved);
      restackRegionPolygons();
      renderEditRegionsList();
      setStatus("Region \"" + saved.name + "\" saved.");
    } catch (err) {
      showToast("Failed to save region: " + (err && err.message ? err.message : err), "error");
    }
  }

  // Palette mirrors src/services/mapRegionService.ts TAG_COLOR_PALETTE so the
  // initial picker swatch matches the backend's random pick when an operator
  // saves without changing the color.
  var REGION_COLOR_PALETTE = [
    "#4fc3f7", "#4ade80", "#f59e0b", "#f472b6", "#a78bfa",
    "#fb923c", "#38bdf8", "#34d399", "#e879f9", "#facc15",
    "#f87171", "#2dd4bf", "#818cf8", "#c084fc",
  ];
  function randomRegionColor() {
    return REGION_COLOR_PALETTE[Math.floor(Math.random() * REGION_COLOR_PALETTE.length)];
  }

  function openRegionActionsPopup(poly) {
    if (!regionState.editing) return;
    var id = poly._polarisRegionId;
    var name = poly._polarisRegionName || "";
    var color = poly._polarisRegionColor || "";
    var swatch = color
      ? '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + escapeHtml(color) + ';margin-right:6px;vertical-align:middle"></span>'
      : "";
    var html =
      '<div style="display:flex;flex-direction:column;gap:6px;min-width:180px">' +
        '<div style="font-weight:600">' + swatch + escapeHtml(name) + '</div>' +
        '<button type="button" class="btn btn-secondary" data-region-rename="' + escapeHtml(id) + '">Rename</button>' +
        '<button type="button" class="btn btn-secondary" data-region-recolor="' + escapeHtml(id) + '">Change color</button>' +
        '<button type="button" class="btn btn-secondary" data-region-back="' + escapeHtml(id) + '" title="Send this polygon behind the others so an overlapping region underneath can be clicked. Resets on page reload.">Send to Bottom Layer</button>' +
        '<button type="button" class="btn btn-danger" data-region-delete="' + escapeHtml(id) + '">Delete</button>' +
      '</div>';
    var popup = L.popup({ closeButton: true, autoClose: true }).setLatLng(poly.getBounds().getCenter()).setContent(html).openOn(map);
    setTimeout(function () {
      var renameBtn = document.querySelector('[data-region-rename="' + id + '"]');
      var recolorBtn = document.querySelector('[data-region-recolor="' + id + '"]');
      var backBtn = document.querySelector('[data-region-back="' + id + '"]');
      var deleteBtn = document.querySelector('[data-region-delete="' + id + '"]');
      if (renameBtn) renameBtn.addEventListener("click", function () { map.closePopup(popup); renameRegion(id, name); });
      if (recolorBtn) recolorBtn.addEventListener("click", function () { map.closePopup(popup); recolorRegion(id, name, color); });
      if (backBtn) backBtn.addEventListener("click", function () { map.closePopup(popup); sendRegionToBack(id, name); });
      if (deleteBtn) deleteBtn.addEventListener("click", function () { map.closePopup(popup); deleteRegion(id, name); });
    }, 0);
  }

  // Per-session layer-order override. Polygons drawn later naturally sit on
  // top of earlier ones, which hides an inner region beneath a larger outer
  // one. "Send to Bottom Layer" pushes this polygon behind every other layer
  // in the region featureGroup so the operator can click the previously-
  // obscured polygon. Not persisted — resets on page reload, since the
  // saved region order on the server is just insertion order.
  function sendRegionToBack(id, name) {
    var poly = regionState.polygonsByRegionId[id];
    if (!poly || typeof poly.bringToBack !== "function") return;
    poly.bringToBack();
    setStatus("Region \"" + name + "\" sent to bottom layer.");
  }

  async function recolorRegion(id, name, currentColor) {
    var next = await promptRegionColor("Change color for \"" + name + "\"", currentColor || randomRegionColor());
    if (!next || next === currentColor) return;
    try {
      var updated = await api.mapRegions.update(id, { color: next });
      var poly = regionState.polygonsByRegionId[id];
      if (poly) {
        poly._polarisRegionColor = updated.color;
        applyRegionColor(poly, updated.color);
        colorEditMarkers(poly);
      }
      renderEditRegionsList();
      setStatus("Region \"" + name + "\" recolored.");
    } catch (err) {
      showToast("Failed to recolor region: " + (err && err.message ? err.message : err), "error");
    }
  }

  async function renameRegion(id, currentName) {
    var next = await promptRegionName("Rename region", currentName);
    if (!next || next === currentName) return;
    try {
      var updated = await api.mapRegions.update(id, { name: next });
      var poly = regionState.polygonsByRegionId[id];
      if (poly) {
        poly._polarisRegionName = updated.name;
        if (poly.getTooltip()) poly.setTooltipContent(escapeHtml(updated.name));
      }
      renderEditRegionsList();
      setStatus("Region renamed to \"" + updated.name + "\".");
    } catch (err) {
      showToast("Failed to rename region: " + (err && err.message ? err.message : err), "error");
    }
  }

  async function deleteRegion(id, name) {
    var ok = await showConfirm('Delete region "' + name + '"? The "region:' + name + '" tag will be removed from every asset that carries it.');
    if (!ok) return;
    try {
      await api.mapRegions.delete(id);
      var poly = regionState.polygonsByRegionId[id];
      if (poly && regionState.layer) regionState.layer.removeLayer(poly);
      delete regionState.polygonsByRegionId[id];
      renderEditRegionsList();
      setStatus("Region \"" + name + "\" deleted.");
    } catch (err) {
      showToast("Failed to delete region: " + (err && err.message ? err.message : err), "error");
    }
  }

  // Rename-only prompt. Resolves to the trimmed name or null if cancelled.
  function promptRegionName(title, initial) {
    return new Promise(function (resolve) {
      var bodyHtml =
        '<label style="display:block;margin-bottom:6px;font-size:0.9rem">Region name</label>' +
        '<input type="text" id="region-name-input" maxlength="64" value="' + escapeHtml(initial || "") + '" ' +
          'style="width:100%;padding:6px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);color:var(--color-text-primary)">' +
        '<p style="margin-top:8px;font-size:0.8rem;color:var(--color-text-tertiary)">Saved as the tag <code>region:&lt;name&gt;</code>.</p>';
      var footer =
        '<button type="button" class="btn btn-secondary" id="region-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="region-save">Save</button>';
      var resolved = false;
      function finish(value) {
        if (resolved) return;
        resolved = true;
        if (typeof closeModal === "function") closeModal();
        resolve(value);
      }
      if (typeof openModal !== "function") {
        var v = window.prompt(title + ":", initial || "");
        return resolve(v && v.trim() ? v.trim() : null);
      }
      openModal(title, bodyHtml, footer);
      setTimeout(function () {
        var input = document.getElementById("region-name-input");
        if (input) { input.focus(); input.select(); }
        var cancel = document.getElementById("region-cancel");
        var save = document.getElementById("region-save");
        if (cancel) cancel.addEventListener("click", function () { finish(null); });
        if (save) save.addEventListener("click", function () {
          var v = input ? input.value.trim() : "";
          finish(v || null);
        });
        if (input) input.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); var v = input.value.trim(); finish(v || null); }
          if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
        });
      }, 0);
    });
  }

  // Create-time prompt — collects name AND color. Resolves to {name, color}
  // or null if cancelled. The color picker is a palette swatch strip plus a
  // free-form hex input; the initial value is the caller-supplied random
  // palette pick so the operator can save without touching it.
  function promptRegionDetails(title, initialName, initialColor) {
    return new Promise(function (resolve) {
      var swatches = REGION_COLOR_PALETTE.map(function (c) {
        var selected = c.toLowerCase() === (initialColor || "").toLowerCase() ? " region-swatch-selected" : "";
        return '<button type="button" class="region-swatch' + selected + '" data-color="' + escapeHtml(c) + '" ' +
          'style="width:24px;height:24px;border-radius:50%;border:2px solid var(--color-border);background:' + escapeHtml(c) + ';cursor:pointer;padding:0"></button>';
      }).join("");
      var bodyHtml =
        '<label style="display:block;margin-bottom:6px;font-size:0.9rem">Region name</label>' +
        '<input type="text" id="region-name-input" maxlength="64" value="' + escapeHtml(initialName || "") + '" ' +
          'style="width:100%;padding:6px 8px;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);color:var(--color-text-primary)">' +
        '<label style="display:block;margin:14px 0 6px;font-size:0.9rem">Color</label>' +
        '<div id="region-swatches" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' + swatches + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input type="color" id="region-color-input" value="' + escapeHtml(initialColor || "#4fc3f7") + '" style="width:48px;height:32px;padding:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:transparent;cursor:pointer">' +
          '<span id="region-color-hex" style="font-family:monospace;color:var(--color-text-secondary)">' + escapeHtml(initialColor || "#4fc3f7") + '</span>' +
        '</div>' +
        '<p style="margin-top:12px;font-size:0.8rem;color:var(--color-text-tertiary)">Saved as the tag <code>region:&lt;name&gt;</code>. Color is chosen at random by default.</p>';
      var footer =
        '<button type="button" class="btn btn-secondary" id="region-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="region-save">Save</button>';
      var resolved = false;
      function finish(value) {
        if (resolved) return;
        resolved = true;
        if (typeof closeModal === "function") closeModal();
        resolve(value);
      }
      if (typeof openModal !== "function") {
        var v = window.prompt(title + " (name):", initialName || "");
        if (!v || !v.trim()) return resolve(null);
        return resolve({ name: v.trim(), color: initialColor || "#4fc3f7" });
      }
      openModal(title, bodyHtml, footer);
      setTimeout(function () {
        var input = document.getElementById("region-name-input");
        var colorInput = document.getElementById("region-color-input");
        var hexLabel = document.getElementById("region-color-hex");
        var cancel = document.getElementById("region-cancel");
        var save = document.getElementById("region-save");
        if (input) { input.focus(); input.select(); }
        function setColor(c) {
          if (!c) return;
          if (colorInput) colorInput.value = c;
          if (hexLabel) hexLabel.textContent = c.toLowerCase();
          var swatchEls = document.querySelectorAll("#region-swatches .region-swatch");
          for (var i = 0; i < swatchEls.length; i++) {
            var el = swatchEls[i];
            if ((el.getAttribute("data-color") || "").toLowerCase() === c.toLowerCase()) el.classList.add("region-swatch-selected");
            else el.classList.remove("region-swatch-selected");
          }
        }
        var swatchEls = document.querySelectorAll("#region-swatches .region-swatch");
        for (var i = 0; i < swatchEls.length; i++) {
          swatchEls[i].addEventListener("click", function (ev) { setColor(ev.currentTarget.getAttribute("data-color")); });
        }
        if (colorInput) colorInput.addEventListener("input", function () { setColor(colorInput.value); });
        function commit() {
          var name = input ? input.value.trim() : "";
          if (!name) { finish(null); return; }
          var color = colorInput ? colorInput.value : initialColor;
          finish({ name: name, color: color });
        }
        if (cancel) cancel.addEventListener("click", function () { finish(null); });
        if (save) save.addEventListener("click", commit);
        if (input) input.addEventListener("keydown", function (ev) {
          if (ev.key === "Enter") { ev.preventDefault(); commit(); }
          if (ev.key === "Escape") { ev.preventDefault(); finish(null); }
        });
      }, 0);
    });
  }

  // Color-only prompt for the "Change color" popup action. Resolves to a
  // hex string or null if cancelled.
  function promptRegionColor(title, initialColor) {
    return new Promise(function (resolve) {
      var swatches = REGION_COLOR_PALETTE.map(function (c) {
        var selected = c.toLowerCase() === (initialColor || "").toLowerCase() ? " region-swatch-selected" : "";
        return '<button type="button" class="region-swatch' + selected + '" data-color="' + escapeHtml(c) + '" ' +
          'style="width:24px;height:24px;border-radius:50%;border:2px solid var(--color-border);background:' + escapeHtml(c) + ';cursor:pointer;padding:0"></button>';
      }).join("");
      var bodyHtml =
        '<div id="region-swatches" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' + swatches + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<input type="color" id="region-color-input" value="' + escapeHtml(initialColor || "#4fc3f7") + '" style="width:48px;height:32px;padding:0;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:transparent;cursor:pointer">' +
          '<span id="region-color-hex" style="font-family:monospace;color:var(--color-text-secondary)">' + escapeHtml(initialColor || "#4fc3f7") + '</span>' +
        '</div>';
      var footer =
        '<button type="button" class="btn btn-secondary" id="region-cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" id="region-save">Save</button>';
      var resolved = false;
      function finish(value) {
        if (resolved) return;
        resolved = true;
        if (typeof closeModal === "function") closeModal();
        resolve(value);
      }
      if (typeof openModal !== "function") {
        var v = window.prompt(title + " (hex color like #4fc3f7):", initialColor || "");
        if (!v || !/^#[0-9a-fA-F]{6}$/.test(v.trim())) return resolve(null);
        return resolve(v.trim().toLowerCase());
      }
      openModal(title, bodyHtml, footer);
      setTimeout(function () {
        var colorInput = document.getElementById("region-color-input");
        var hexLabel = document.getElementById("region-color-hex");
        var cancel = document.getElementById("region-cancel");
        var save = document.getElementById("region-save");
        function setColor(c) {
          if (!c) return;
          if (colorInput) colorInput.value = c;
          if (hexLabel) hexLabel.textContent = c.toLowerCase();
          var swatchEls = document.querySelectorAll("#region-swatches .region-swatch");
          for (var i = 0; i < swatchEls.length; i++) {
            var el = swatchEls[i];
            if ((el.getAttribute("data-color") || "").toLowerCase() === c.toLowerCase()) el.classList.add("region-swatch-selected");
            else el.classList.remove("region-swatch-selected");
          }
        }
        var swatchEls = document.querySelectorAll("#region-swatches .region-swatch");
        for (var i = 0; i < swatchEls.length; i++) {
          swatchEls[i].addEventListener("click", function (ev) { setColor(ev.currentTarget.getAttribute("data-color")); });
        }
        if (colorInput) colorInput.addEventListener("input", function () { setColor(colorInput.value); });
        if (cancel) cancel.addEventListener("click", function () { finish(null); });
        if (save) save.addEventListener("click", function () {
          var c = colorInput ? colorInput.value : initialColor;
          finish(c || null);
        });
      }, 0);
    });
  }
})();
