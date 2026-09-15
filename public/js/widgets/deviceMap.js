/**
 * widgets/deviceMap.js — the Device Map, as a placeable dashboard widget.
 *
 * A faithful embed of the Device Map page (public/js/map.js): FortiGate assets
 * plotted on a theme-aware Leaflet basemap as monitor-health-colored `.fg-marker`
 * dots that roll up into `.fg-cluster` bubbles (worst child health, not child
 * count). Hover names the gate + its monitor line; clicking a marker jumps to the
 * full Device Map page opened on that site's topology (`/map.html#site=…&topology=1`)
 * — except on the /dash wallboard, which is a read-only kiosk with no navigation,
 * where the click just surfaces a details popup.
 *
 * Reuses the bundled Leaflet + markercluster stack (loaded by index.html AND
 * dash.html) and the shared `.fg-marker` / `.fg-cluster` / `.sitemap-*` CSS in
 * styles.css, plus the existing GET /map/sites endpoint (mounted on both the main
 * API and the dash listener) — no new backend. Per-instance map + layers + the
 * refresh timer + ResizeObserver live in the render closure and are torn down in
 * ctx.onUnmount (Leaflet throws "Map container is already initialized" if a
 * container is reused without map.remove()).
 */

(function () {
  var _iconPathSet = false;

  function isDash() { return typeof window !== "undefined" && window.POLARIS_DASH_LOCAL === true; }

  // Monitor-health → CSS class, mirroring monitorClass() in map.js. Dependency
  // suppression takes precedence only while the probe itself isn't down (the
  // device is reachable via a redundant path); a real down probe still paints red.
  function monitorClass(site) {
    if (!site.monitored) return "monitor-unmonitored";
    if (site.dependencySuppressed && site.monitorHealth !== "down") return "monitor-dep-down";
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

  function monitorLine(site) {
    if (!site.monitored) return "Unmonitored";
    var samples = site.monitorRecentSamples || 0, failures = site.monitorRecentFailures || 0;
    if (site.dependencySuppressed && site.monitorHealth !== "down") {
      var layer = (site.dependencyLayer != null) ? " (Layer " + site.dependencyLayer + ")" : "";
      return "Dependency down — upstream parent offline" + layer;
    }
    switch (site.monitorHealth) {
      case "up":       return "Up — last " + samples + " samples ok";
      case "degraded": return "Packet loss — " + failures + "/" + samples + " recent samples failed";
      case "down":     return "Down — " + failures + "/" + samples + " samples failed";
      default:         return "Monitored — no samples yet";
    }
  }

  function hasIssue(site) {
    return site.monitored && !site.dependencySuppressed && (site.monitorHealth === "down" || site.monitorHealth === "degraded");
  }

  // Cluster bubble color = worst monitor health among children (not the count),
  // mirroring clusterIcon() in map.js.
  function clusterIcon(cluster) {
    var children = cluster.getAllChildMarkers();
    var sawMonitored = false, sawDepDown = false, worst = "up";
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      if (s.monitorHealth === "down") { worst = "down"; break; }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
      if (s.dependencySuppressed && s.monitorHealth !== "down") sawDepDown = true;
    }
    var cls;
    if (!sawMonitored)       cls = "monitor-unmonitored";
    else if (worst !== "up") cls = "monitor-" + worst;
    else if (sawDepDown)     cls = "monitor-dep-down";
    else                     cls = "monitor-up";
    return L.divIcon({
      html: '<div class="fg-cluster ' + cls + '"><span>' + cluster.getChildCount() + "</span></div>",
      className: "",
      iconSize: [40, 40],
    });
  }

  // Per-user map theme, independent of the app theme (matches the map page's
  // toolbar toggle idiom): "light" | "dark", defaulting to the app theme.
  function themePref() {
    try {
      var v = localStorage.getItem("polaris-devicemap-theme");
      if (v === "light" || v === "dark") return v;
    } catch (_) {}
    // The app theme's FAMILY: this picks one of two basemaps, and an id
    // comparison misses every daylight theme but the retired `light`.
    return (typeof isLightTheme === "function" && isLightTheme()) ? "light" : "dark";
  }

  PolarisWidgets.register({
    type: "deviceMap",
    category: "NOC",
    label: "Device Map",
    description: "Geographic map of FortiGates — monitor-health dots + clustering, click through to topology.",
    defaultSize: { width: 6, height: 2 },
    minSize: { width: 4, height: 1 },
    defaultConfig: { issuesOnly: false, regionScope: "mine" },
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

      // zoomSnap 0.25 lets fitBounds land on fractional zoom levels (integer
      // snap rounds DOWN a whole level and strands the fleet in a corner);
      // wheelPxPerZoomLevel doubled from Leaflet's 60 default = gentler scroll.
      var map = L.map(mapDiv, {
        worldCopyJump: true, center: [39.5, -95], zoom: 4,
        zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 120,
        attributionControl: true, zoomControl: true,
      });

      // Home/reset control under the +/− buttons: refit all sites.
      var homeBounds = null;
      function goHome() { if (homeBounds) map.fitBounds(homeBounds, { maxZoom: 12 }); }
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

      // Theme-aware basemap: OpenStreetMap in both themes, matching the Device
      // Map page (CARTO's Dark Matter served the dark half until CARTO began
      // requiring an API key). The .sitemap-dark class darkens the tile pane so
      // the health dots stay legible on dark.
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

      var markerCluster = L.markerClusterGroup({
        showCoverageOnHover: false,
        maxClusterRadius: 40,
        disableClusteringAtZoom: 11,
        spiderfyOnMaxZoom: true,
        iconCreateFunction: clusterIcon,
      });
      map.addLayer(markerCluster);

      function makeMarker(site) {
        var label = escapeHtml((site.hostname || "FG").slice(0, 3).toUpperCase());
        var marker = L.marker([site.latitude, site.longitude], {
          icon: L.divIcon({
            className: "",
            html: '<div class="fg-marker ' + monitorClass(site) + '" aria-hidden="true">' + label + "</div>",
            iconSize: [34, 34], iconAnchor: [17, 17],
          }),
          title: site.hostname || "",
        });
        marker._site = site;   // clusterIcon() rolls up health across children
        var HP = window.POLARIS_HEALTH_COLORS;
        var color = { "monitor-up": HP.up, "monitor-degraded": HP.degraded, "monitor-down": HP.down, "monitor-dep-down": HP.depDown, "monitor-unmonitored": HP.unmonitored, "monitor-passive": HP.passive, "monitor-unknown": HP.unknown }[monitorClass(site)] || HP.unknown;
        var name = escapeHtml(site.hostname || "(unnamed)");
        marker.bindTooltip(
          "<strong>" + name + "</strong>" +
          (site.model ? '<br><span style="opacity:.8">' + escapeHtml(site.model) + "</span>" : "") +
          '<br><span style="opacity:.8">' + escapeHtml(monitorLine(site)) + "</span>" +
          (site.subnetCount ? "<br>" + site.subnetCount + " subnet" + (site.subnetCount === 1 ? "" : "s") : ""),
          { direction: "top", offset: [0, -14] }
        );
        // On the dashboard, clicking a gate opens the full Device Map page on
        // its topology — the widget can't host the Cytoscape modal (its vendor
        // scripts aren't loaded here). On the /dash kiosk there's no navigation,
        // so bind a details popup with a status line instead.
        if (isDash()) {
          marker.bindPopup(
            '<div class="sitemap-popup-title" style="color:' + color + '">' + name + "</div>" +
            (site.model ? '<div class="sitemap-popup-row">' + escapeHtml(site.model) + "</div>" : "") +
            (site.ipAddress ? '<div class="sitemap-popup-row"><span>IP</span><code>' + escapeHtml(site.ipAddress) + "</code></div>" : "") +
            '<div class="sitemap-popup-row">' + escapeHtml(monitorLine(site)) + "</div>" +
            (site.subnetCount ? '<div class="sitemap-popup-row">' + site.subnetCount + " subnet" + (site.subnetCount === 1 ? "" : "s") + "</div>" : ""),
            { maxWidth: 280 }
          );
        } else {
          marker.on("click", function () {
            window.location.href = "/map.html#site=" + encodeURIComponent(site.id) + "&topology=1";
          });
        }
        return marker;
      }

      function buildMarkers(sites) {
        markerCluster.clearLayers();
        var rows = (sites || []).filter(function (s) { return s.latitude != null && s.longitude != null; });
        if (config && config.issuesOnly) rows = rows.filter(hasIssue);
        var latlngs = [];
        rows.forEach(function (s) {
          markerCluster.addLayer(makeMarker(s));
          latlngs.push([s.latitude, s.longitude]);
        });
        if (latlngs.length) homeBounds = L.latLngBounds(latlngs).pad(0.05);
      }
      buildMarkers(data);
      goHome();

      // ── Overlay controls: legend (bottom-left) + theme/fullscreen (top-right) ──
      var controls = document.createElement("div");
      controls.className = "sitemap-controls";
      controls.innerHTML =
        '<div class="sitemap-legend">' +
          '<span><i style="background:#2e7d32"></i>Up</span>' +
          '<span><i style="background:#f9a825"></i>Warn</span>' +
          '<span><i style="background:#c62828"></i>Down</span>' +
          '<span><i style="background:#607d8b"></i>Dep down</span>' +
          '<span><i style="background:#757575"></i>Unmonitored</span>' +
        '</div>' +
        '<div class="sitemap-wx">' +
          '<button type="button" data-k="theme" title="Toggle map theme"></button>' +
          '<button type="button" data-k="full" title="Fullscreen (Esc to exit)">⛶</button>' +
        '</div>';
      el.appendChild(controls);
      var btnTheme = controls.querySelector('[data-k="theme"]');
      var btnFull = controls.querySelector('[data-k="full"]');
      L.DomEvent.disableClickPropagation(controls);
      function paintTheme() { btnTheme.textContent = mapTheme === "dark" ? "☀" : "🌙"; }
      btnTheme.addEventListener("click", function () {
        mapTheme = mapTheme === "dark" ? "light" : "dark";
        try { localStorage.setItem("polaris-devicemap-theme", mapTheme); } catch (_) {}
        applyBasemap();
        paintTheme();
      });
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
      paintTheme();

      // ── Resize + 60s refresh + teardown ──────────────────────────────────
      var raf = null;
      var ro = new ResizeObserver(function () {
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(function () { try { map.invalidateSize(); } catch (_) {} });
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
        document.removeEventListener("keydown", onKeydown);
        try { ro.disconnect(); } catch (_) {}
        if (raf) cancelAnimationFrame(raf);
        try { if (controls.parentNode) controls.parentNode.removeChild(controls); } catch (_) {}
        try { map.remove(); } catch (_) {}
        el.classList.remove("sitemap-body", "sitemap-dark", "sitemap-fullscreen");
      });
    },

    renderPreview: function (el) {
      el.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:120px;flex-direction:column;gap:6px;color:var(--color-text-secondary)">' +
        '<div style="font-size:2rem">🛰️</div><div style="font-size:0.82rem">Device map · FortiGate health dots + clustering</div></div>';
    },

    renderConfig: function (el, config, onChange) {
      el.innerHTML =
        '<label style="display:flex;gap:6px;align-items:center;font-size:0.85rem;margin:3px 0">' +
          '<input type="checkbox" data-k="issuesOnly"' + (config.issuesOnly ? " checked" : "") + "> Show only gates with issues" +
        "</label>";
      el.querySelector('[data-k="issuesOnly"]').addEventListener("change", function (e) { onChange("issuesOnly", e.target.checked); });
      PolarisWidgets.renderNocFilterConfig(el, config, onChange, false);
    },
  });
})();
