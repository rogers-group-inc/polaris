// public/js/mobile/map-tab.js — Device Map tab.
//
// Lazy-loads Leaflet + markercluster on first render (~150KB total) so the
// payload stays light for users who never open the Map. Plots every
// firewall asset returned by /map/sites with health-coded markers and pops
// a bottom sheet on tap. The same module backs the `site/<id>` detail
// route — that path renders the map and pre-opens the sheet for the named
// site so deep-links from search work.
//
// Mobile-specific decisions vs desktop map.js:
//   - The site sheet's "View topology" button hands off to the
//     `topology/<siteId>` detail route, which lazy-loads Cytoscape inline
//     and renders a top-to-bottom graph fullscreen — no more bouncing to
//     the desktop page.
//   - Pin tap opens the sheet locally without changing the URL — keeps
//     re-renders cheap. The sheet's close button just closes; deep-links
//     from search are still URL-driven via the `site` route.
//   - No theme toggle (mobile inherits the app's overall dark theme).
//   - User-location pin: a stick figure with a yellow hardhat, driven by
//     navigator.geolocation.watchPosition. Walking animation plays when
//     the figure is actually moving (browser-reported speed first, with a
//     haversine fallback that gates on the GPS accuracy radius so jitter
//     doesn't trigger phantom strides while standing still).

(function () {
  // Module-level state. Reused across renders so back-and-forth between
  // Map and other tabs doesn't re-fetch sites every time.
  var _map = null;
  var _markerCluster = null;
  var _markersById = Object.create(null);
  var _sites = [];
  var _leafletPromise = null;

  // User-location state. _watchId is the active Geolocation watch handle;
  // _userMarker / _userAccuracyRing are the on-map Leaflet objects;
  // _lastFix tracks the previous position so we can compute speed for the
  // walking-animation gate.
  var _watchId = null;
  var _userMarker = null;
  var _userAccuracyRing = null;
  var _lastFix = null; // { lat, lng, t }

  // Active basemap tile layer (so we can swap it in place when the user
  // toggles theme without re-initializing the whole map). The
  // MutationObserver below the initMap call handles the swap.
  var _basemapLayer = null;
  var _themeObserver = null;

  // Inline SVG for the user-location pin. Stick figure with a construction-
  // yellow hardhat. Limbs are individual <line> elements so CSS keyframes
  // can rotate them around shoulder/hip pivots when the .walking class is
  // toggled on. Kept module-local — no external file fetch.
  var STICK_FIGURE_SVG = ''
    + '<svg viewBox="0 0 40 56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    +   '<circle class="stroke head" cx="20" cy="18" r="5"/>'
    +   '<line class="stroke spine" x1="20" y1="23" x2="20" y2="36"/>'
    +   '<line class="stroke arm arm-l" x1="20" y1="26" x2="11" y2="36"/>'
    +   '<line class="stroke arm arm-r" x1="20" y1="26" x2="29" y2="36"/>'
    +   '<line class="stroke leg leg-l" x1="20" y1="36" x2="11" y2="52"/>'
    +   '<line class="stroke leg leg-r" x1="20" y1="36" x2="29" y2="52"/>'
    +   '<rect class="hat" x="8" y="13.5" width="24" height="2" rx="1"/>'
    +   '<path class="hat" d="M 12,13.5 A 8,8 0 0 1 28,13.5 Z"/>'
    +   '<line class="hat-stripe" x1="17" y1="7" x2="17" y2="12"/>'
    +   '<line class="hat-stripe" x1="23" y1="7" x2="23" y2="12"/>'
    + '</svg>';

  // ─── Lazy loaders ──────────────────────────────────────────────────────
  function _addLink(href) {
    if (document.querySelector('link[href="' + href + '"]')) return;
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }
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
  function loadLeaflet() {
    if (window.L && window.L.markerClusterGroup) return Promise.resolve(window.L);
    if (_leafletPromise) return _leafletPromise;
    _leafletPromise = (async function () {
      _addLink("/css/vendor/leaflet/leaflet.css");
      _addLink("/css/vendor/leaflet/MarkerCluster.css");
      _addLink("/css/vendor/leaflet/MarkerCluster.Default.css");
      await _loadScript("/js/vendor/leaflet/leaflet.js");
      await _loadScript("/js/vendor/leaflet/leaflet.markercluster.js");
      return window.L;
    })();
    return _leafletPromise;
  }

  // ─── Tab spec ──────────────────────────────────────────────────────────
  var Map = {
    title: "Device Map",
    icon: "#i-map",
    renderTopbar: function () {
      // No top app bar — the shell's persistent searchbar sits above the
      // map. Empty topbar slot lets the map take the full body height.
      return "";
    },
    render: function (body, ctx) {
      // Bare-minimum DOM the first time we render this tab. Subsequent
      // renders reuse it.
      // No floating search pill — the shell's persistent searchbar
      // (#search-slot) sits above the map on this tab and already routes
      // to the Search tab, so a map-local search would be redundant.
      body.innerHTML = ''
        + '<div class="map-screen">'
        + '  <div id="map-container"></div>'
        + '  <div class="map-fab-pos">'
        + '    <button class="fab" id="map-recenter" aria-label="Recenter on me"><svg viewBox="0 0 24 24"><use href="#i-target"/></svg></button>'
        + '  </div>'
        + '  <div id="map-status" style="position:absolute;bottom:88px;left:16px;right:16px;text-align:center;color:var(--md-on-surface-variant);font-size:13px;letter-spacing:.25px;pointer-events:none;"></div>'
        + '</div>';

      document.getElementById("map-recenter").addEventListener("click", recenterOnUser);

      var preselectId = (ctx && ctx.preselectSiteId) || null;

      setStatus("Loading…");
      loadLeaflet().then(function () {
        // Always re-init when render runs — DOM is fresh per route change,
        // so prior Leaflet instances no longer have valid container refs.
        initMap();
        return loadSites();
      }).then(function () {
        setStatus("");
        // Auto-start the user-location watch when geolocation permission
        // was already granted on a prior visit. Permissions API is
        // best-effort — Safari historically lacked support, but modern
        // versions (iOS 16+) do, and the catch falls through quietly when
        // the API isn't there.
        maybeAutoStartUserWatch();
        if (preselectId) {
          var site = _sites.find(function (s) { return s.id === preselectId; });
          if (site) {
            focusSite(site);
            // Defer so flyTo animation kicks in before the sheet covers
            // the lower half of the screen.
            setTimeout(function () { openSiteSheet(site); }, 400);
          } else {
            PolarisTabs.showSnackbar("Site not found on map — it may have no coordinates yet.", { error: true });
          }
        }
      }).catch(function (err) {
        setStatus("Failed to load map: " + (err && err.message ? err.message : err));
      });
    },
  };

  // Stop the Geolocation watch whenever the operator navigates away from
  // the Map tab (or from the `site/<id>` deep-link that reuses it). Hooks
  // hashchange directly so we don't have to extend the router or
  // monkey-patch app.js.
  window.addEventListener("hashchange", function () {
    var hash = (window.location.hash || "").replace(/^#/, "");
    var name = hash.split("/")[0];
    if (name !== "map" && name !== "site") stopUserLocationWatch();
  });

  function setStatus(msg) {
    var el = document.getElementById("map-status");
    if (el) el.textContent = msg || "";
  }

  function initMap() {
    var L = window.L;
    L.Icon.Default.imagePath = "/css/vendor/leaflet/images/";

    _map = L.map("map-container", {
      worldCopyJump: true,
      center: [39.5, -95],
      zoom: 4,
      zoomControl: false, // pinch + the recenter FAB are enough on phones
    });

    applyBasemapTheme();

    // Toggle theme via More tab → Appearance flips data-theme on <html>.
    // Observe and swap tiles in place so the user doesn't have to leave
    // and re-enter the Map tab to see the new basemap.
    if (_themeObserver) { try { _themeObserver.disconnect(); } catch (e) {} }
    _themeObserver = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        if (muts[i].attributeName === "data-theme") { applyBasemapTheme(); break; }
      }
    });
    _themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    _markerCluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      iconCreateFunction: clusterIcon,
    });
    _map.addLayer(_markerCluster);
  }

  // Theme-aware basemap. Mirrors desktop map.js's tile choice — OpenStreetMap
  // in both themes, with dark produced by CSS-filtering the tile pane
  // (.polaris-basemap-dark). CARTO's Dark Matter served the dark half until
  // CARTO started requiring an API key on its basemap CDN. Swaps the layer in
  // place so an open-map theme toggle doesn't leak the previous tile layer.
  function applyBasemapTheme() {
    if (!_map) return;
    var L = window.L;
    var isDark = (window.PolarisTheme ? PolarisTheme.get() : "dark") === "dark";
    // Single-host tile URL. The OSM tile usage policy permits only
    // https://tile.openstreetmap.org/{z}/{x}/{y}.png — the older {s} a/b/c
    // subdomain form spreads one viewport over three hosts instead of one
    // multiplexed HTTP/2 connection, and reads to their operators as a
    // policy violation: tiles come back as the "Access blocked" image.
    var url = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
    var attribution = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
    if (_basemapLayer) {
      try { _map.removeLayer(_basemapLayer); } catch (e) {}
    }
    _basemapLayer = L.tileLayer(url, { maxZoom: 19, attribution: attribution }).addTo(_map);
    _map.getContainer().classList.toggle("polaris-basemap-dark", isDark);
  }

  function clusterIcon(cluster) {
    var L = window.L;
    var children = cluster.getAllChildMarkers();
    var sawMonitored = false;
    var sawMaint = false;
    var worst = "up";
    for (var i = 0; i < children.length; i++) {
      var s = children[i]._site;
      if (!s || !s.monitored) continue;
      sawMonitored = true;
      // Maintenance isn't an outage (frozen health) — surfaces only when
      // nothing worse is present. Mirrors the desktop map cluster rollup.
      if (s.status === "maintenance") { sawMaint = true; continue; }
      if (s.monitorHealth === "down") { worst = "down"; break; }
      if (s.monitorHealth === "degraded" && worst !== "down") worst = "degraded";
    }
    var cls = !sawMonitored
      ? "monitor-unmonitored"
      : (worst !== "up" ? "monitor-" + worst : (sawMaint ? "monitor-maintenance" : "monitor-up"));
    var count = cluster.getChildCount();
    return L.divIcon({
      html: '<div class="fg-cluster ' + cls + '"><span>' + count + "</span></div>",
      className: "",
      iconSize: [40, 40],
    });
  }

  function loadSites() {
    return api.map.sites().then(function (sites) {
      _sites = Array.isArray(sites) ? sites : [];
      _markerCluster.clearLayers();
      _markersById = Object.create(null);

      if (_sites.length === 0) {
        setStatus("No FortiGates with coordinates yet.");
        return _sites;
      }

      var L = window.L;
      var latlngs = [];
      _sites.forEach(function (s) {
        if (s.latitude == null || s.longitude == null) return;
        var m = makeMarker(s);
        _markerCluster.addLayer(m);
        _markersById[s.id] = m;
        latlngs.push([s.latitude, s.longitude]);
      });
      if (latlngs.length > 0) {
        _map.fitBounds(L.latLngBounds(latlngs).pad(0.05), { maxZoom: 12 });
      }
      return _sites;
    });
  }

  function monitorClass(site) {
    if (site.status === "maintenance") return "monitor-maintenance";
    if (!site.monitored) return "monitor-unmonitored";
    switch (site.monitorHealth) {
      case "up":       return "monitor-up";
      case "degraded": return "monitor-degraded";
      case "down":     return "monitor-down";
      default:         return "monitor-unknown";
    }
  }

  function makeMarker(site) {
    var L = window.L;
    var label = (site.hostname || "FG").slice(0, 3).toUpperCase();
    var icon = L.divIcon({
      className: "",
      html: '<div class="fg-marker ' + monitorClass(site) + '" aria-hidden="true">' + escapeHtml(label) + "</div>",
      iconSize: [34, 34],
      iconAnchor: [17, 17],
    });
    // Stack maintenance gates beneath live gates where markers overlap (see
    // the desktop map makeMarker note).
    var marker = L.marker([site.latitude, site.longitude], {
      icon: icon,
      zIndexOffset: site.status === "maintenance" ? -1000 : 0,
    });
    marker._site = site;
    marker.on("click", function () { openSiteSheet(site); });
    return marker;
  }

  function focusSite(site) {
    if (!site || site.latitude == null || site.longitude == null) return;
    _map.flyTo([site.latitude, site.longitude], 13, { duration: 0.6 });
  }

  function recenterOnUser() {
    if (!navigator.geolocation) {
      PolarisTabs.showSnackbar("Location not available on this device.");
      return;
    }
    navigator.geolocation.getCurrentPosition(function (pos) {
      _map.flyTo([pos.coords.latitude, pos.coords.longitude], 11, { duration: 0.6 });
      // Permission was either already granted or just granted via the
      // browser prompt — start watching so the pin tracks the operator
      // as they walk around the site.
      handleFix(pos);
      startUserLocationWatch();
    }, function (err) {
      var msg = "Couldn't get your location";
      if (err && err.code === err.PERMISSION_DENIED) msg = "Location permission denied";
      PolarisTabs.showSnackbar(msg, { error: true });
    }, { timeout: 6000, enableHighAccuracy: true });
  }

  // ─── User-location pin (stick figure with hardhat) ─────────────────────
  // Triggered automatically when geolocation permission was already
  // granted on a prior visit, or on the first successful recenter tap.
  // Uses watchPosition with high accuracy + short maximumAge so the
  // walking-animation gate stays responsive — cadence-throttled fixes
  // would otherwise lock the figure into "still" while the operator is
  // actively moving around the site.
  function maybeAutoStartUserWatch() {
    if (!navigator.geolocation) return;
    if (!navigator.permissions || typeof navigator.permissions.query !== "function") return;
    try {
      navigator.permissions.query({ name: "geolocation" }).then(function (status) {
        if (status && status.state === "granted") startUserLocationWatch();
      }).catch(function () { /* unsupported in some browsers — silent */ });
    } catch (e) { /* Safari before iOS 16 — silent */ }
  }

  function startUserLocationWatch() {
    if (_watchId != null || !navigator.geolocation) return;
    try {
      _watchId = navigator.geolocation.watchPosition(
        function (pos) { handleFix(pos); },
        function () { /* permission revoked or transient — keep silent */ },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
      );
    } catch (e) { /* very old browsers — silent */ }
  }

  function stopUserLocationWatch() {
    if (_watchId != null) {
      try { navigator.geolocation.clearWatch(_watchId); } catch (e) {}
      _watchId = null;
    }
    _lastFix = null;
    if (_userMarker && _map) {
      try { _map.removeLayer(_userMarker); } catch (e) {}
      _userMarker = null;
    }
    if (_userAccuracyRing && _map) {
      try { _map.removeLayer(_userAccuracyRing); } catch (e) {}
      _userAccuracyRing = null;
    }
  }

  // Decide whether the figure is walking, then update the marker. Movement
  // is determined from browser-reported speed when the platform supplies
  // it (Geolocation API surfaces m/s for many devices), or from haversine
  // distance vs. dt with a jitter gate that requires the displacement to
  // exceed both 3 meters AND the reported GPS accuracy radius. Without
  // the accuracy gate, a phone sitting still on a desk can register
  // "moving" because consecutive fixes can land 5–15m apart from noise.
  function handleFix(pos) {
    var lat = pos.coords.latitude;
    var lng = pos.coords.longitude;
    var t   = pos.timestamp || Date.now();
    var moving = false;

    if (typeof pos.coords.speed === "number" && !isNaN(pos.coords.speed)) {
      moving = pos.coords.speed > 0.4; // ~1.4 km/h — slower than a casual walk
    } else if (_lastFix) {
      var dMeters = haversineMeters(_lastFix.lat, _lastFix.lng, lat, lng);
      var dtSec   = Math.max(0.5, (t - _lastFix.t) / 1000);
      var speed   = dMeters / dtSec;
      moving = speed > 0.4 && dMeters > Math.max(3, pos.coords.accuracy || 0);
    }
    _lastFix = { lat: lat, lng: lng, t: t };
    updateUserMarker(lat, lng, pos.coords.accuracy, moving);
  }

  function haversineMeters(lat1, lng1, lat2, lng2) {
    var R = 6371000;
    var toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad;
    var dLng = (lng2 - lng1) * toRad;
    var s1 = Math.sin(dLat / 2);
    var s2 = Math.sin(dLng / 2);
    var a = s1 * s1 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * s2 * s2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function updateUserMarker(lat, lng, accuracy, moving) {
    if (!_map) return;
    var L = window.L;
    if (!_userMarker) {
      var icon = L.divIcon({
        className: "",
        html: '<div class="user-pin' + (moving ? " walking" : "") + '">' + STICK_FIGURE_SVG + "</div>",
        iconSize: [40, 56],
        iconAnchor: [20, 52],
      });
      _userMarker = L.marker([lat, lng], {
        icon: icon,
        interactive: false,
        keyboard: false,
        zIndexOffset: 1000,
      }).addTo(_map);
    } else {
      _userMarker.setLatLng([lat, lng]);
      var el = _userMarker.getElement();
      if (el) {
        var inner = el.querySelector(".user-pin");
        if (inner) inner.classList.toggle("walking", !!moving);
      }
    }

    if (accuracy && accuracy > 0) {
      if (!_userAccuracyRing) {
        _userAccuracyRing = L.circle([lat, lng], {
          radius: accuracy,
          color: "#fbbf24",
          weight: 1,
          opacity: 0.5,
          fillOpacity: 0.08,
          interactive: false,
        }).addTo(_map);
      } else {
        _userAccuracyRing.setLatLng([lat, lng]);
        _userAccuracyRing.setRadius(accuracy);
      }
    }
  }

  // ─── Site bottom sheet ─────────────────────────────────────────────────
  // Single instance — opening a new one supersedes any open sheet.
  function openSiteSheet(site) {
    closeSiteSheet();
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "map-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "map-sheet";

    var subnetLine = site.subnetCount
      ? site.subnetCount + " network" + (site.subnetCount === 1 ? "" : "s")
      : "no networks discovered yet";
    var monitorPill = renderMonitorPill(site);
    var siteParts = [];
    if (site.model) siteParts.push(escapeHtml(site.model));
    if (site.ipAddress) siteParts.push('<span class="mono">' + escapeHtml(site.ipAddress) + '</span>');
    if (site.serialNumber) siteParts.push('<span class="mono">' + escapeHtml(site.serialNumber) + '</span>');

    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:8px;">'
      + '  <div style="min-width:0;">'
      + '    <h3 class="sheet-title" style="margin:0 0 4px;">' + escapeHtml(site.hostname || "FortiGate") + '</h3>'
      + '    <div class="muted" style="font-size:13px;letter-spacing:.25px;">' + siteParts.join(" · ") + '</div>'
      + '  </div>'
      + '  <button class="icon-btn" id="map-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div style="display:flex;gap:8px;margin:12px 0 16px;flex-wrap:wrap;align-items:center;">'
      + '  ' + monitorPill
      + '  <span class="muted" style="font-size:12px;">' + escapeHtml(subnetLine) + '</span>'
      + '</div>'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;">'
      + '  <button class="btn btn-filled" id="map-sheet-topology"><svg viewBox="0 0 24 24"><use href="#i-router"/></svg>View topology</button>'
      + '  <button class="btn btn-tonal" id="map-sheet-asset"><svg viewBox="0 0 24 24"><use href="#i-server"/></svg>View asset</button>'
      + '</div>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeSiteSheet);
    document.getElementById("map-sheet-close").addEventListener("click", closeSiteSheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeSiteSheet);
    document.getElementById("map-sheet-asset").addEventListener("click", function () {
      closeSiteSheet();
      if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(site.id);
      else PolarisRouter.go("asset/" + site.id);
    });
    document.getElementById("map-sheet-topology").addEventListener("click", function () {
      closeSiteSheet();
      PolarisRouter.go("topology/" + site.id);
    });
  }

  function closeSiteSheet() {
    var s = document.getElementById("map-sheet");
    var sc = document.getElementById("map-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();

    // If the URL still names a site (we got here via #site/<id>), normalize
    // it to plain #map so refresh lands without the sheet — but bypass the
    // router so we don't trigger a full Leaflet re-init. Manually update
    // the navbar active state since we sidestepped routeChanged.
    var cur = PolarisRouter.current();
    if (cur && cur.name === "site") {
      var url = window.location.pathname + window.location.search + "#map";
      window.history.replaceState(null, "", url);
      var appEl = document.getElementById("app");
      if (appEl) appEl.dataset.tab = "map";
      var nav = document.getElementById("navbar");
      if (nav) nav.querySelectorAll(".nav-item").forEach(function (b) {
        b.classList.toggle("active", b.dataset.tab === "map");
      });
    }
  }

  function renderMonitorPill(site) {
    if (site.status === "maintenance") return '<span class="status-pill maint"><span class="dot maint"></span>Maintenance</span>';
    if (!site.monitored) return '<span class="status-pill unk">Unmonitored</span>';
    var samples = site.monitorRecentSamples || 0;
    var failures = site.monitorRecentFailures || 0;
    switch (site.monitorHealth) {
      case "up":       return '<span class="status-pill up"><span class="dot up"></span>Up — ' + samples + '/' + samples + ' ok</span>';
      case "degraded": return '<span class="status-pill warn"><span class="dot warn"></span>Packet loss — ' + failures + '/' + samples + ' failed</span>';
      case "down":     return '<span class="status-pill down"><span class="dot down"></span>Down — ' + failures + '/' + samples + ' failed</span>';
      default:         return '<span class="status-pill unk"><span class="dot unk"></span>Monitored — no samples yet</span>';
    }
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  // ─── Public surface ────────────────────────────────────────────────────
  // The tab registry in tabs.js reads from PolarisMapTab.spec; details.js's
  // Site renderer delegates to PolarisMapTab.renderForSite which reuses
  // the same render() but pre-opens the sheet.
  window.PolarisMapTab = {
    spec: Map,
    renderForSite: function (body, ctx) {
      var siteId = (ctx.route && ctx.route.parts && ctx.route.parts[0]) || null;
      Map.render(body, { user: ctx.user, route: ctx.route, preselectSiteId: siteId });
    },
    closeSheet: closeSiteSheet,
  };
})();
