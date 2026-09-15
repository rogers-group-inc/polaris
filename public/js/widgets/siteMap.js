/**
 * widgets/siteMap.js — SolarWinds-NOC-style geographic site map.
 *
 * Status DOTS (green/amber/red/purple/grey circle markers) colored by monitor
 * health (purple = in a maintenance window — planned downtime, never red),
 * with a pulsing white-ringed dot for down sites, click popups, and hover
 * name tooltips. Sites sharing the same coordinates (several gates geocoded to
 * one address) collapse into a single STACK dot with a count badge; clicking it
 * explodes the stack spiderfy-style — each site fans out on a dashed connector
 * leg so every gate is visible and clickable. Down sites never join a stack
 * (their pulse ring + permanent draggable label must stay individually visible). Plus a WEATHER overlay matching the NOC wall display:
 * animated RainViewer precipitation radar + Open-Meteo current-temperature
 * labels, with °F / RADAR / LOOP toggles and a radar timestamp. A darkened
 * basemap (CSS filter on the tile pane) keeps the dots and radar legible.
 *
 * Reuses the bundled Leaflet stack + the existing GET /map/sites endpoint.
 * Per-instance: map, layers, weather state, and every timer live in the
 * render closure and are torn down in ctx.onUnmount (Leaflet throws
 * "Map container is already initialized" if a container is reused without
 * map.remove()).
 *
 * Weather transport is PROXY-FIRST with CDN FALLBACK: each radar refresh
 * first asks the Polaris weather proxy (/weather/frames + /weather/radar
 * tiles — server-side cached, works from egress-restricted wallboard VLANs),
 * and falls back to fetching api.rainviewer.com / tilecache.rainviewer.com
 * directly when the proxy fails (both hosts stay whitelisted in the CSP for
 * exactly this). Fall-forward is automatic: the proxy is re-tried on every
 * refresh cycle, and while on CDN fallback the refresh shortens to ~10 min;
 * a mid-cycle proxy outage (index answered, tiles erroring) trips an
 * immediate CDN reload after 5 tile errors. Temperature lookups take the
 * same per-cell proxy-then-Open-Meteo path. The RADAR button's hover
 * tooltip names the transport currently in use. Degrades silently offline.
 */

(function () {
  var _iconPathSet = false;

  // SolarWinds status palette. "maint" matches the assets-page purple
  // maintenance pill (rgba(149,117,205) base).
  var COLOR = { up: "#00c853", degraded: "#ffd600", down: "#ff1744", unknown: "#757575", dep: "#607d8b", maint: "#9575cd" };

  function healthKey(site) {
    // A maintenance window is planned downtime: the scheduler pauses polling
    // and freezes monitorStatus at whatever it was on entry (possibly "down"),
    // so paint purple — never red — while status="maintenance". Checked first
    // so it also wins over dependency suppression and the unmonitored grey.
    if (site.status === "maintenance") return "maint";
    if (!site.monitored) return "unknown";
    // Dependency-suppressed sites are out of the Down Assets widget by default,
    // so never paint them red here — show the distinct "dep" color instead, even
    // when the suppressed device's own status is down. Keeps the map's red dots
    // in lockstep with Down Assets / Status Summary. (Down Assets can be toggled
    // to include suppressed rows; it badges them, so the two still agree.)
    if (site.dependencySuppressed) return "dep";
    switch (site.monitorHealth) {
      case "up": return "up";
      case "degraded": return "degraded";
      case "down": return "down";
      default: return "unknown";
    }
  }
  function statusColor(site) { return COLOR[healthKey(site)] || COLOR.unknown; }
  function inMaintenance(site) { return site.status === "maintenance"; }
  function isDown(site) { return site.monitored && !site.dependencySuppressed && !inMaintenance(site) && site.monitorHealth === "down"; }
  function hasIssue(site) { return site.monitored && !site.dependencySuppressed && !inMaintenance(site) && (site.monitorHealth === "down" || site.monitorHealth === "degraded"); }

  function monitorLine(site) {
    if (inMaintenance(site)) return "Maintenance window — monitoring and notifications paused";
    if (!site.monitored) return "Unmonitored";
    var samples = site.monitorRecentSamples || 0, failures = site.monitorRecentFailures || 0;
    if (site.dependencySuppressed) return "Dependency down — upstream parent offline";
    switch (site.monitorHealth) {
      case "up": return "Up — last " + samples + " samples ok";
      case "degraded": return "Packet loss — " + failures + "/" + samples + " recent samples failed";
      case "down": return "Down — " + failures + "/" + samples + " samples failed";
      default: return "Monitored — no samples yet";
    }
  }

  // ── localStorage-persisted toggles (global, like the NOC kiosk) ──
  function wxPref(key, def) {
    try { var v = localStorage.getItem("polaris-sitemap-" + key); return v == null ? def : v === "true"; }
    catch (_) { return def; }
  }
  function setWxPref(key, val) { try { localStorage.setItem("polaris-sitemap-" + key, String(val)); } catch (_) {} }
  // Map theme is independent of the weather toggles: "light" | "dark",
  // defaulting to the app theme when the operator hasn't picked one.
  function themePref() {
    try {
      var v = localStorage.getItem("polaris-sitemap-theme");
      if (v === "light" || v === "dark") return v;
    } catch (_) {}
    // The app theme's FAMILY: this picks one of two basemaps, and an id
    // comparison misses every daylight theme but the retired `light`.
    return (typeof isLightTheme === "function" && isLightTheme()) ? "light" : "dark";
  }

  PolarisWidgets.register({
    type: "siteMap",
    category: "NOC",
    label: "Status Map",
    description: "Geographic map of monitored sites — status dots + live weather radar.",
    defaultSize: { width: 6, height: 2 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { issuesOnly: false, regionScope: "mine" },
    // Gated on deviceMap, not assets: this widget's only data source is
    // GET /map/sites, which carries a deviceMap=read floor. Declaring
    // assets=read here would leave the widget visible to a deviceMap=none
    // role and render it permanently empty (fetchData swallows the 403).
    requiredPermission: { key: "deviceMap", level: "read" },

    fetchData: function (config) {
      return PolarisWidgets.getMapSites(PolarisWidgets.regionNamesForConfig(config)).catch(function () { return []; });
    },

    renderInstance: function (el, config, data, ctx) {
      if (typeof L === "undefined") { el.innerHTML = '<p class="empty-state">Map library unavailable</p>'; return; }
      if (!_iconPathSet) { L.Icon.Default.imagePath = "/css/vendor/leaflet/images/"; _iconPathSet = true; }

      el.classList.add("sitemap-body");
      el.style.position = "relative";
      var mapDiv = document.createElement("div");
      mapDiv.style.cssText = "position:absolute;inset:0";
      el.appendChild(mapDiv);

      // wheelPxPerZoomLevel doubled from Leaflet's 60 default so the scroll
      // wheel zooms half the distance per notch (gentler than the default).
      // zoomSnap 0.25 lets fitBounds land on fractional zoom levels — with the
      // default integer snap the initial fit rounds DOWN a whole level and can
      // leave a huge margin between the outermost dots and the widget edge.
      var map = L.map(mapDiv, { worldCopyJump: true, center: [39.5, -95], zoom: 4, zoomSnap: 0.25, attributionControl: true, zoomControl: true, wheelPxPerZoomLevel: 120 });

      // Home/reset control under the +/− buttons: returns to the initial
      // fit-all-sites view (bounds refreshed with the marker data each cycle).
      var homeBounds = null;
      function goHome() { if (homeBounds) map.fitBounds(homeBounds, { maxZoom: 10 }); }
      var HomeControl = L.Control.extend({
        options: { position: "topleft" },
        onAdd: function () {
          var div = L.DomUtil.create("div", "leaflet-bar");
          var a = L.DomUtil.create("a", "sitemap-home", div);
          a.href = "#"; a.title = "Reset view"; a.setAttribute("role", "button"); a.innerHTML = "⌂";
          L.DomEvent.on(a, "click", function (e) { L.DomEvent.stop(e); goHome(); });
          return div;
        },
      });
      map.addControl(new HomeControl());

      // Theme-aware basemap: OpenStreetMap in both themes (CARTO's Dark Matter
      // and Positron served both halves until CARTO began requiring an API key).
      // The .sitemap-dark class drives the basemap darkening filter (CSS), so
      // dots/radar stay legible on dark; light theme renders the map normally.
      var mapTheme = themePref();
      var basemap = null;
      function applyBasemap() {
        if (basemap) { map.removeLayer(basemap); basemap = null; }
        var dark = mapTheme === "dark";
        // Single-host tile URL. The OSM tile usage policy permits only
        // https://tile.openstreetmap.org/{z}/{x}/{y}.png — the older {s} a/b/c
        // subdomain form spreads one viewport over three hosts instead of one
        // multiplexed HTTP/2 connection, and reads to their operators as a
        // policy violation: tiles come back as the "Access blocked" image.
        basemap = L.tileLayer(
          "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
          { maxZoom: 19, attribution: "© OpenStreetMap contributors" }
        ).addTo(map);
        el.classList.toggle("sitemap-dark", dark);
      }
      applyBasemap();

      var markersLayer = L.layerGroup().addTo(map);
      // Weather tiles ride a custom pane ABOVE the base tiles but OUTSIDE the
      // .leaflet-tile-pane CSS darkening filter, so radar stays vivid.
      var wxPane = map.createPane("sitemapWeather");
      wxPane.style.zIndex = 450;
      wxPane.style.pointerEvents = "none";

      // Leader lines: a dashed connector from each down site's (draggable)
      // label back to its red dot, so a label pulled aside still shows which
      // dot it belongs to. Drawn in container coords in an overlay SVG and
      // recomputed on pan/zoom/resize and live while a label is dragged.
      var SVGNS = "http://www.w3.org/2000/svg";
      var leaderSvg = document.createElementNS(SVGNS, "svg");
      leaderSvg.setAttribute("class", "sitemap-leaders");
      leaderSvg.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:640;overflow:visible";
      mapDiv.appendChild(leaderSvg);
      var downMarkers = [];
      function updateLeaders() {
        while (leaderSvg.firstChild) leaderSvg.removeChild(leaderSvg.firstChild);
        var mr = mapDiv.getBoundingClientRect();
        downMarkers.forEach(function (m) {
          var tt = m.getTooltip(); if (!tt) return;
          var tEl = tt.getElement(); if (!tEl) return;
          var p = map.latLngToContainerPoint(m.getLatLng());
          var tr = tEl.getBoundingClientRect();
          var tx = tr.left - mr.left + tr.width / 2;   // label bottom-centre (its tail point)
          var ty = tr.bottom - mr.top - 1;
          var line = document.createElementNS(SVGNS, "line");
          line.setAttribute("x1", p.x); line.setAttribute("y1", p.y);
          line.setAttribute("x2", tx); line.setAttribute("y2", ty);
          line.setAttribute("stroke", "#ff1744");
          line.setAttribute("stroke-width", "1.5");
          line.setAttribute("stroke-dasharray", "3 3");
          line.setAttribute("opacity", "0.9");
          leaderSvg.appendChild(line);
        });
      }
      map.on("move zoomend viewreset resize", updateLeaders);

      // ── Markers (status dots + pulse) ──────────────────────────────────
      var markerRefs = [];
      // Per-site dragged tooltip offsets, persisted across the 60s refresh so a
      // label the operator pulled apart stays where they put it.
      var draggedOffsets = {};

      // Make a down site's permanent tooltip draggable (like the NOC wall
      // display) so overlapping red labels can be separated. Mirrors the
      // reference attachTooltipDrag: mousedown on the tooltip disables map pan,
      // mousemove rewrites the tooltip offset, mouseup re-enables pan.
      function attachTooltipDrag(circle, key) {
        var tt = circle.getTooltip(); if (!tt) return;
        var tEl = tt.getElement(); if (!tEl) return;
        L.DomEvent.disableClickPropagation(tEl);
        L.DomEvent.on(tEl, "mousedown", function (e) {
          L.DomEvent.stop(e);
          map.dragging.disable();
          tEl.classList.add("dragging");
          var startX = e.clientX, startY = e.clientY;
          var base = (tt.options.offset || [0, 0]).slice();
          function onMove(ev) {
            var off = [base[0] + (ev.clientX - startX), base[1] + (ev.clientY - startY)];
            tt.options.offset = off; tt.update(); draggedOffsets[key] = off; updateLeaders();
          }
          function onUp() {
            map.dragging.enable();
            tEl.classList.remove("dragging");
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
          }
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });
      }

      // Auto de-overlap the permanent DOWN labels: each label greedily takes
      // the first free slot on a ladder of candidate offsets (straight up a
      // row at a time, then nudged right/left), so clustered outages read as
      // a stack of labels instead of a pile. Operator-dragged labels are
      // never moved — they participate as fixed obstacles. Leader lines
      // (updateLeaders) keep displaced labels visually tied to their dots.
      function labelRect(p, off, w, h) {
        // direction:"top" anchors the label's bottom-centre at point+offset.
        var cx = p.x + off[0], bottom = p.y + off[1];
        return { l: cx - w / 2 - 3, r: cx + w / 2 + 3, t: bottom - h - 3, b: bottom + 3 };
      }
      function rectsIntersect(a, b) { return a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t; }
      function layoutDownLabels() {
        var placed = [], entries = [];
        downMarkers.forEach(function (m) {
          var tt = m.getTooltip(); if (!tt) return;
          var tEl = tt.getElement(); if (!tEl) return;
          var p = map.latLngToContainerPoint(m.getLatLng());
          var w = tEl.offsetWidth, h = tEl.offsetHeight;
          if (m._siteId && draggedOffsets[m._siteId]) placed.push(labelRect(p, tt.options.offset || [0, -10], w, h));
          else entries.push({ tt: tt, p: p, w: w, h: h });
        });
        if (!entries.length) { updateLeaders(); return; }
        entries.sort(function (a, b) { return a.p.x - b.p.x || a.p.y - b.p.y; });
        entries.forEach(function (e) {
          var chosen = null;
          for (var lvl = 0; lvl < 10 && !chosen; lvl++) {
            var dy = -10 - lvl * (e.h + 4);
            var cands = [[0, dy], [Math.round(e.w * 0.6), dy], [-Math.round(e.w * 0.6), dy]];
            for (var i = 0; i < cands.length; i++) {
              var r = labelRect(e.p, cands[i], e.w, e.h);
              var hit = false;
              for (var j = 0; j < placed.length; j++) { if (rectsIntersect(r, placed[j])) { hit = true; break; } }
              if (!hit) { chosen = cands[i]; placed.push(r); break; }
            }
          }
          if (!chosen) { chosen = [0, -10]; placed.push(labelRect(e.p, chosen, e.w, e.h)); }
          e.tt.options.offset = chosen;
          e.tt.update();
        });
        updateLeaders();
      }
      map.on("zoomend", layoutDownLabels);

      // isLeg = the dot is an exploded-stack leg: it sits at a fanned-out
      // latlng (not the site's true position) and must not bubble clicks to
      // the map, or the map-click collapse handler would fire on it.
      function addSiteDot(s, latlng, isLeg) {
        var color = statusColor(s), down = isDown(s);
        if (down) {
          L.marker(latlng, {
            interactive: false,
            icon: L.divIcon({ className: "", html: '<div class="sitemap-pulse"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
          }).addTo(markersLayer);
        }
        var dot = L.circleMarker(latlng, {
          radius: down ? 7 : 6,
          fillColor: color, fillOpacity: down ? 1 : 0.85,
          color: down ? "#fff" : color, weight: down ? 2 : 1, opacity: down ? 1 : 0.6,
          bubblingMouseEvents: !isLeg,
        });
        var name = escapeHtml(s.hostname || "(unnamed)");
        dot.bindPopup(
          '<div class="sitemap-popup-title" style="color:' + color + '">' + name + "</div>" +
          (s.model ? '<div class="sitemap-popup-row">' + escapeHtml(s.model) + "</div>" : "") +
          (s.ipAddress ? '<div class="sitemap-popup-row"><span>IP</span><code>' + escapeHtml(s.ipAddress) + "</code></div>" : "") +
          '<div class="sitemap-popup-row">' + escapeHtml(monitorLine(s)) + "</div>" +
          (s.subnetCount ? '<div class="sitemap-popup-row">' + s.subnetCount + " subnet" + (s.subnetCount === 1 ? "" : "s") + "</div>" : "") +
          '<a class="sitemap-popup-link" href="/map.html#site=' + encodeURIComponent(s.id) + '&topology=1">Open device map →</a>',
          { maxWidth: 280 }
        );
        // Down sites get a PERMANENT, DRAGGABLE red tooltip (always visible,
        // naming the down device) so the outage is readable at a glance and
        // overlapping labels can be pulled apart; healthy sites show the name
        // on hover only. Reuse any offset the operator dragged it to.
        var offset = (down && draggedOffsets[s.id]) ? draggedOffsets[s.id] : [0, down ? -10 : -8];
        dot.bindTooltip(
          down ? (name + " — DOWN") : name,
          {
            permanent: down,
            direction: "top",
            offset: offset,
            className: down ? "sitemap-tip sitemap-tip-down" : "sitemap-tip",
            opacity: 1,
          }
        );
        if (down) dot.on("tooltipopen", function () { attachTooltipDrag(dot, s.id); });
        dot.addTo(markersLayer);
        if (down) { dot._siteId = s.id; downMarkers.push(dot); }
        return dot;
      }

      // ── Stacked-site explode (spiderfy) ────────────────────────────────
      // Sites sharing coordinates render as ONE anchor dot (worst-status
      // color + count badge). Clicking it fans the members out on dashed
      // connector legs so each gate gets its own clickable dot. Collapses on
      // map click or re-click of the anchor; zoom collapses then re-expands
      // (leg positions are pixel-radius fans, so they must be recomputed).
      var stacks = {};           // coordKey -> { center, sites }
      var expandedKey = null;    // survives the 60s rebuild + zoom
      var expandedLayers = [];
      function collapseStack(keepKey) {
        expandedLayers.forEach(function (l) { markersLayer.removeLayer(l); });
        expandedLayers = [];
        if (!keepKey) expandedKey = null;
      }
      function expandStack(key) {
        var st = stacks[key]; if (!st) { expandedKey = null; return; }
        expandedKey = key;
        var n = st.sites.length;
        var centerPt = map.latLngToLayerPoint(st.center);
        st.sites.forEach(function (s, i) {
          // ≤10 legs: single ring sized to the count. Beyond that, a spiral
          // (8 legs per turn, radius growing per leg) so legs never overlap.
          var a, r;
          if (n <= 10) { a = (2 * Math.PI * i) / n - Math.PI / 2; r = 22 + n * 2; }
          else { a = (2 * Math.PI / 8) * i - Math.PI / 2; r = 24 + 3.2 * i; }
          var ll = map.layerPointToLatLng(centerPt.add([r * Math.cos(a), r * Math.sin(a)]));
          var line = L.polyline([st.center, ll], { color: "#9aa4b2", weight: 1, dashArray: "3 3", opacity: 0.8, interactive: false });
          line.addTo(markersLayer);
          expandedLayers.push(line);
          expandedLayers.push(addSiteDot(s, ll, true));
        });
        // Re-assert down dots above the freshly-added legs/connectors.
        downMarkers.forEach(function (m) { m.bringToFront(); });
      }
      function stackColor(sitesArr) {
        var rank = { degraded: 4, unknown: 3, dep: 2, maint: 1, up: 0 };
        var worst = "up";
        sitesArr.forEach(function (s) {
          var k = healthKey(s);
          if ((rank[k] || 0) > (rank[worst] || 0)) worst = k;
        });
        return COLOR[worst];
      }
      function addStack(key, sitesArr) {
        var center = [sitesArr[0].latitude, sitesArr[0].longitude];
        stacks[key] = { center: center, sites: sitesArr };
        var anchor = L.circleMarker(center, {
          radius: 9, fillColor: stackColor(sitesArr), fillOpacity: 0.9,
          color: "#fff", weight: 1.5, opacity: 0.9,
          bubblingMouseEvents: false,
        });
        anchor.bindTooltip(sitesArr.length + " sites — click to expand", { direction: "top", offset: [0, -10], className: "sitemap-tip", opacity: 1 });
        anchor.on("click", function () {
          var was = expandedKey === key;
          collapseStack();
          if (!was) expandStack(key);
        });
        anchor.addTo(markersLayer);
        L.marker(center, {
          interactive: false,
          icon: L.divIcon({ className: "", html: '<div class="sitemap-stack-count">' + sitesArr.length + "</div>", iconSize: [18, 18], iconAnchor: [9, 9] }),
        }).addTo(markersLayer);
      }
      map.on("click", function () { collapseStack(); });
      map.on("zoomstart", function () { collapseStack(true); });
      map.on("zoomend", function () { if (expandedKey) expandStack(expandedKey); });

      function buildMarkers(sites) {
        collapseStack(true);
        markersLayer.clearLayers();
        markerRefs = [];
        downMarkers = [];
        stacks = {};
        var rows = (sites || []).filter(function (s) { return s.latitude != null && s.longitude != null; });
        if (config && config.issuesOnly) rows = rows.filter(hasIssue);
        var latlngs = [];
        var groups = {};
        rows.forEach(function (s) {
          markerRefs.push({ lat: s.latitude, lng: s.longitude });
          latlngs.push([s.latitude, s.longitude]);
          // Down sites always render individually (pulse ring + permanent
          // draggable label must stay visible); only healthy/degraded/unknown
          // dots at identical coordinates group into a stack.
          if (isDown(s)) { addSiteDot(s, [s.latitude, s.longitude], false); return; }
          var key = s.latitude.toFixed(5) + "," + s.longitude.toFixed(5);
          (groups[key] = groups[key] || []).push(s);
        });
        Object.keys(groups).forEach(function (key) {
          var g = groups[key];
          if (g.length === 1) addSiteDot(g[0], [g[0].latitude, g[0].longitude], false);
          else addStack(key, g);
        });
        // A stack the operator had exploded stays exploded across the refresh.
        if (expandedKey) expandStack(expandedKey);
        // Down sites paint ABOVE everything else: Leaflet stacks vector
        // markers in add-order, so a healthy dot / stack anchor / exploded leg
        // added later would otherwise cover a co-located red down dot.
        downMarkers.forEach(function (m) { m.bringToFront(); });
        // Keep the reset-view bounds current with the data (without moving the
        // map — only the initial render and the ⌂ button actually fit).
        if (latlngs.length) homeBounds = L.latLngBounds(latlngs).pad(0.04);
        requestAnimationFrame(layoutDownLabels);
        return latlngs;
      }
      buildMarkers(data);
      goHome();

      // ── Weather overlay ────────────────────────────────────────────────
      var WX_API_BASE = window.__polarisApiBase || "/api/v1";
      var tempEnabled = wxPref("wx-temp", true);
      var radarEnabled = wxPref("wx-radar", true);
      var radarAnimate = wxPref("wx-animate", true);
      var tempLayer = null, tempTimer = null;
      var radarFrames = [], radarTimes = [], radarIdx = 0, radarTimer = null, radarAnimTimer = null;
      var RADAR_FRAME_MS = 500, RADAR_LOOP_PAUSE_MS = 1800, RADAR_OPACITY = 0.6;
      // Which transport the CURRENT radar frames came from: "proxy" (Polaris
      // weather proxy) | "cdn" (direct RainViewer fallback) | null (off /
      // not loaded yet). Drives the RADAR button's hover tooltip and the
      // shortened fall-forward retry while on the CDN.
      var wxSource = null;
      // Set by the mid-cycle tile-error trip: the next loadRadar() skips the
      // proxy and goes straight to the CDN (the proxy answered the frame
      // index but its tiles are failing). One-shot — the cycle after that
      // tries the proxy again.
      var skipProxyNextLoad = false;
      var CDN_RETRY_MS = 10 * 60 * 1000;

      function wxRefreshMs() { var h = new Date().getHours(); return (h >= 8 && h < 17) ? 30 * 60 * 1000 : 2 * 60 * 60 * 1000; }
      // Fall-forward: while on the CDN fallback, retry the proxy sooner than
      // the normal refresh so a recovered proxy is picked up within minutes.
      function radarRefreshDelay() { return wxSource === "cdn" ? Math.min(wxRefreshMs(), CDN_RETRY_MS) : wxRefreshMs(); }

      // Per-cell temperature: proxy first, direct Open-Meteo on failure.
      function fetchCellTemp(c) {
        return fetch(WX_API_BASE + "/weather/temp?lat=" + c.lat + "&lng=" + c.lng)
          .then(function (r) {
            if (!r.ok) throw new Error("proxy " + r.status);
            return r.json();
          })
          .then(function (d) { return d.temperature; })
          .catch(function () {
            return fetch("https://api.open-meteo.com/v1/forecast?latitude=" + c.lat + "&longitude=" + c.lng + "&current=temperature_2m&temperature_unit=fahrenheit&forecast_days=1")
              .then(function (r) { return r.json(); })
              .then(function (d) { return d && d.current && d.current.temperature_2m; });
          });
      }

      function loadTemps() {
        if (!tempEnabled) return;
        if (tempLayer) { map.removeLayer(tempLayer); tempLayer = null; }
        tempLayer = L.layerGroup().addTo(map);
        var grid = {};
        markerRefs.forEach(function (r) {
          var key = Math.round(r.lat / 1.5) + "," + Math.round(r.lng / 1.5);
          if (!grid[key]) grid[key] = { lat: r.lat, lng: r.lng };
        });
        var cells = Object.keys(grid).map(function (k) { return grid[k]; });
        cells.forEach(function (c) {
          fetchCellTemp(c)
            .then(function (t) {
              if (t == null || !tempLayer) return;
              L.marker([c.lat, c.lng], {
                interactive: false, pane: "sitemapWeather",
                icon: L.divIcon({ className: "", html: '<div class="sitemap-temp">' + Math.round(t) + "°F</div>", iconAnchor: [-8, 8] }),
              }).addTo(tempLayer);
            }).catch(function () {});
        });
        clearTimeout(tempTimer);
        tempTimer = setTimeout(loadTemps, wxRefreshMs());
      }

      function clearRadar() {
        radarFrames.forEach(function (l) { map.removeLayer(l); });
        radarFrames = []; radarTimes = [];
        clearTimeout(radarAnimTimer); radarAnimTimer = null;
      }
      // specs: [{ time, url }] (a Leaflet tile-URL template per frame).
      // Swap-in order matches the old code: build+add the new layers, THEN
      // clearRadar() removes the previous cycle's (radarFrames still holds
      // the old array until reassigned below).
      function applyRadarFrames(specs, source) {
        var frames = [], times = [], tileErrors = 0;
        specs.forEach(function (f) {
          var layer = L.tileLayer(f.url, { opacity: 0, maxNativeZoom: 7, maxZoom: 18, pane: "sitemapWeather" });
          if (source === "proxy") {
            layer.on("tileerror", function () {
              // Mid-cycle proxy failure (the index answered but tiles are
              // erroring): flip this cycle to the CDN immediately instead of
              // animating holes. Exact-match so the reload fires once, and
              // only while THIS cycle's layers are still current — Leaflet
              // can fire tileerror on aborted loads when a new cycle swaps
              // the old layers out.
              tileErrors++;
              if (tileErrors === 5 && radarFrames === frames) {
                skipProxyNextLoad = true;
                clearTimeout(radarTimer);
                loadRadar();
              }
            });
          }
          layer.addTo(map);
          frames.push(layer);
          times.push(f.time);
        });
        clearRadar();
        radarFrames = frames; radarTimes = times;
        wxSource = source;
        paintBtns();
        applyRadarMode();
        clearTimeout(radarTimer);
        radarTimer = setTimeout(loadRadar, radarRefreshDelay());
      }
      function loadRadar() {
        if (!radarEnabled) return;
        var viaProxy = !skipProxyNextLoad;
        skipProxyNextLoad = false;
        var attempt = viaProxy
          ? fetch(WX_API_BASE + "/weather/frames")
              .then(function (r) {
                if (!r.ok) throw new Error("proxy " + r.status);
                return r.json();
              })
              .then(function (d) {
                applyRadarFrames((d.frames || []).map(function (f) {
                  return { time: f.time, url: WX_API_BASE + "/weather/radar/" + f.id + "/{z}/{x}/{y}" };
                }), "proxy");
              })
          : Promise.reject(new Error("proxy tiles erroring"));
        attempt
          .catch(function () {
            return fetch("https://api.rainviewer.com/public/weather-maps.json")
              .then(function (r) { return r.json(); })
              .then(function (d) {
                applyRadarFrames(((d.radar && d.radar.past) || []).map(function (f) {
                  return { time: f.time, url: d.host + f.path + "/256/{z}/{x}/{y}/6/1_1.png" };
                }), "cdn");
              });
          })
          .catch(function () {});
      }
      function applyRadarMode() {
        clearTimeout(radarAnimTimer); radarAnimTimer = null;
        if (!radarFrames.length) return;
        if (radarAnimate) { radarIdx = 0; stepRadar(); }
        else {
          var last = radarFrames.length - 1;
          radarFrames.forEach(function (l, i) { l.setOpacity(i === last ? RADAR_OPACITY : 0); });
          updateClock(radarTimes[last]);
        }
      }
      function stepRadar() {
        if (!radarFrames.length) return;
        radarFrames.forEach(function (l, i) { l.setOpacity(i === radarIdx ? RADAR_OPACITY : 0); });
        updateClock(radarTimes[radarIdx]);
        var isLast = radarIdx === radarFrames.length - 1;
        radarIdx = (radarIdx + 1) % radarFrames.length;
        radarAnimTimer = setTimeout(stepRadar, isLast ? RADAR_LOOP_PAUSE_MS : RADAR_FRAME_MS);
      }
      function updateClock(unixSec) {
        if (clockEl == null || unixSec == null) return;
        var d = new Date(unixSec * 1000);
        clockEl.textContent = "RADAR " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: true });
        clockEl.style.display = radarEnabled ? "block" : "none";
      }

      // ── Overlay controls (legend + weather toggles + radar clock) ───────
      var controls = document.createElement("div");
      controls.className = "sitemap-controls";
      controls.innerHTML =
        '<div class="sitemap-legend">' +
          '<span><i style="background:' + COLOR.up + '"></i>Up</span>' +
          '<span><i style="background:' + COLOR.degraded + '"></i>Warn</span>' +
          '<span><i style="background:' + COLOR.down + '"></i>Down</span>' +
          '<span><i style="background:' + COLOR.maint + '"></i>Maint</span>' +
          '<span><i style="background:' + COLOR.unknown + '"></i>Unknown</span>' +
        '</div>' +
        '<div class="sitemap-wx">' +
          '<button type="button" data-wx="theme" title="Toggle map theme"></button>' +
          '<button type="button" data-wx="temp">°F</button>' +
          '<button type="button" data-wx="radar">RADAR</button>' +
          '<button type="button" data-wx="animate">▶ LOOP</button>' +
          '<button type="button" data-wx="full" title="Fullscreen (Esc to exit)">⛶</button>' +
        '</div>' +
        '<div class="sitemap-radar-clock"></div>';
      el.appendChild(controls);
      var clockEl = controls.querySelector(".sitemap-radar-clock");
      var btnTheme = controls.querySelector('[data-wx="theme"]');
      var btnTemp = controls.querySelector('[data-wx="temp"]');
      var btnRadar = controls.querySelector('[data-wx="radar"]');
      var btnAnim = controls.querySelector('[data-wx="animate"]');
      var btnFull = controls.querySelector('[data-wx="full"]');
      // Hover tooltip on the RADAR button naming the transport in use —
      // "proxy" = the Polaris server's /weather endpoints, "cdn" = direct
      // RainViewer fallback (proxy unavailable; re-tried automatically).
      function radarSourceTitle() {
        if (!radarEnabled) return "Radar off";
        if (wxSource === "proxy") return "Radar source: Polaris server (proxied)";
        if (wxSource === "cdn") return "Radar source: RainViewer CDN (direct) — Polaris proxy unavailable, retrying automatically";
        return "Radar source: loading…";
      }
      function paintBtns() {
        // Show the icon for the theme you'd switch TO (sun = go light), mirroring the app toggle.
        btnTheme.textContent = mapTheme === "dark" ? "☀" : "🌙";
        btnTemp.classList.toggle("active", tempEnabled);
        btnRadar.classList.toggle("active", radarEnabled);
        btnRadar.title = radarSourceTitle();
        btnAnim.classList.toggle("active", radarAnimate);
        clockEl.style.display = radarEnabled ? "block" : "none";
      }
      // Stop map drag when interacting with the controls.
      L.DomEvent.disableClickPropagation(controls);
      btnTheme.addEventListener("click", function () {
        mapTheme = mapTheme === "dark" ? "light" : "dark";
        try { localStorage.setItem("polaris-sitemap-theme", mapTheme); } catch (_) {}
        applyBasemap();
        paintBtns();
      });
      // Fullscreen: the widget body goes position:fixed inset:0 (CSS class).
      // invalidateSize after the layout change so Leaflet repaints at the new
      // size (the ResizeObserver also catches it). Esc exits.
      function setFullscreen(on) {
        el.classList.toggle("sitemap-fullscreen", on);
        btnFull.innerHTML = on ? "✖" : "⛶";
        btnFull.classList.toggle("active", on);
        // Re-home after the layout change (and invalidateSize) so the fleet
        // refits to the new viewport instead of keeping the old framing.
        setTimeout(function () { try { map.invalidateSize(); } catch (_) {} goHome(); }, 60);
      }
      btnFull.addEventListener("click", function () { setFullscreen(!el.classList.contains("sitemap-fullscreen")); });
      function onKeydown(e) { if (e.key === "Escape" && el.classList.contains("sitemap-fullscreen")) setFullscreen(false); }
      document.addEventListener("keydown", onKeydown);
      btnTemp.addEventListener("click", function () {
        tempEnabled = !tempEnabled; setWxPref("wx-temp", tempEnabled); paintBtns();
        if (tempEnabled) loadTemps();
        else { if (tempLayer) { map.removeLayer(tempLayer); tempLayer = null; } clearTimeout(tempTimer); }
      });
      btnRadar.addEventListener("click", function () {
        radarEnabled = !radarEnabled; setWxPref("wx-radar", radarEnabled);
        // Toggling off forgets the transport; toggling back on re-tries the
        // proxy first (manual fall-forward).
        wxSource = null; skipProxyNextLoad = false;
        paintBtns();
        if (radarEnabled) loadRadar();
        else { clearRadar(); clearTimeout(radarTimer); clockEl.textContent = ""; }
      });
      btnAnim.addEventListener("click", function () {
        radarAnimate = !radarAnimate; setWxPref("wx-animate", radarAnimate); paintBtns();
        if (radarEnabled) applyRadarMode();
      });
      paintBtns();
      if (tempEnabled) loadTemps();
      if (radarEnabled) loadRadar();

      // ── Resize + refresh + teardown ─────────────────────────────────────
      var raf = null;
      var ro = new ResizeObserver(function () {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () { map.invalidateSize(); });
      });
      ro.observe(el);

      var siteTimer = setInterval(function () {
        // A backgrounded window has nobody watching the map; the shared memo
        // already collapses concurrent instances into one request.
        if (document.hidden) return;
        PolarisWidgets.getMapSites(PolarisWidgets.regionNamesForConfig(config)).then(function (sites) { buildMarkers(sites); }).catch(function () {});
      }, PolarisWidgets.REFRESH.slow);

      ctx.onUnmount(function () {
        clearInterval(siteTimer);
        clearTimeout(tempTimer); clearTimeout(radarTimer); clearTimeout(radarAnimTimer);
        document.removeEventListener("keydown", onKeydown);
        try { ro.disconnect(); } catch (_) {}
        if (raf) cancelAnimationFrame(raf);
        try { if (controls.parentNode) controls.parentNode.removeChild(controls); } catch (_) {}
        try { map.remove(); } catch (_) {}
        el.classList.remove("sitemap-body", "sitemap-fullscreen");
      });
    },

    renderPreview: function (el) {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;flex-direction:column;gap:6px;color:var(--color-text-secondary)">' +
        '<div style="font-size:2rem">🗺️</div><div style="font-size:0.82rem">Status map · status dots + weather radar</div></div>';
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;margin:3px 0">' +
          '<input type="checkbox" data-k="issuesOnly"' + (config.issuesOnly ? " checked" : "") + '> Show only sites with issues' +
        '</label>';
      el.querySelector('[data-k="issuesOnly"]').addEventListener("change", function (e) { onChange("issuesOnly", e.target.checked); });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, false);
    },
  });
})();
