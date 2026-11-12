/**
 * public/js/topology-physical.js — the Device Map topology's TOPOLOGY mode
 * (business rules 147-148): a physical canvas for one saved view.
 *
 *   window.PolarisTopologyPhysical.render(host, ctx) → instance
 *
 * The canvas is a Leaflet map: an OpenStreetMap basemap (the single tile host
 * every map surface uses), or an uploaded floor plan on `L.CRS.Simple`, its
 * natural width × height scaled to a fixed extent so any resolution behaves
 * the same (no grid, no snapping). On it:
 *   - group POLYGONS, each standing for one location group (its a:/b:/f:/r:/jb:
 *     codes, kept in display casing), drawn with leaflet-draw after the
 *     operator picks the group;
 *   - PLACED devices, dragged in from the details pane (nothing is placed by
 *     default); a device dropped inside a polygon stages that group's codes
 *     for its description (the innermost polygon wins), and one dropped
 *     outside every polygon stages nothing (rule 148);
 *   - LINKS between placed devices, drawn automatically from the same edge
 *     set and colours as the Layer 2 graph.
 *
 * map.js owns the edit session; this module only stages through `ctx`
 * (stageViewPatch / stagePlacements / stageLocationCode) and never writes to
 * the server itself, except the background image upload (which does not
 * change the view until the session commits).
 */
(function () {
  "use strict";

  var IMAGE_EXTENT = 1000;    // the long side of an uploaded image, in map units
  var DEFAULT_OSM_ZOOM = 19;  // a site, not a city (operator: "zoomed in much further")
  var OSM_NATIVE_MAX = 19;    // tile.openstreetmap.org's deepest tiles
  var OSM_MAX_ZOOM = 22;      // overzoom past the tiles for indoor placement
  // The optional satellite basemap (Server Settings → Customization), proxied
  // through Polaris so the CSP keeps its one tile host. Asked once per page;
  // null until the answer arrives.
  var SATELLITE_TILE_URL = "/api/v1/map/satellite/{z}/{x}/{y}";
  var _satelliteStatus = null;
  var _satellitePending = null;
  function loadSatelliteStatus() {
    if (_satelliteStatus) return Promise.resolve(_satelliteStatus);
    if (!_satellitePending) {
      _satellitePending = (typeof api !== "undefined" && api.map && api.map.satellite ? api.map.satellite() : Promise.reject(new Error("no api")))
        .then(function (s) { _satelliteStatus = s || { available: false }; return _satelliteStatus; },
              function () { _satelliteStatus = { available: false }; return _satelliteStatus; });
    }
    return _satellitePending;
  }
  var HISTORY_MAX = 100;
  var DRAG_MIME = "application/x-polaris-asset";

  var CODE_FIELDS = [
    { field: "area", key: "a", kind: "area", word: "Area" },
    { field: "building", key: "b", kind: "building", word: "Building" },
    { field: "floor", key: "f", kind: "floor", word: "Floor" },
    { field: "room", key: "r", kind: "room", word: "Room" },
    { field: "rack", key: "ra", kind: "ra", word: "Rack" },
    { field: "junctionBox", key: "jb", kind: "jb", word: "Junction box" },
  ];
  // A Topology view's polygons stand for areas, buildings and floors only
  // (operator decision 2026-11-11): rooms, racks and junction boxes are the
  // Rack and Wall views' business, so a polygon never sets them.
  var POLY_FIELDS = CODE_FIELDS.slice(0, 3);
  function polyCodes(c) {
    var n = normCodes(c);
    var out = emptyCodes();
    POLY_FIELDS.forEach(function (f) { out[f.field] = n[f.field]; });
    return out;
  }
  function polyHasCodes(c) { var n = polyCodes(c); return POLY_FIELDS.some(function (f) { return n[f.field] !== null; }); }
  // ── Stacked floors (rules 152, 168) ─────────────────────────────────
  // A floor's plan image sits on the ground (floor 0's background) by
  // {cx, cy, sx, sy, rot}: its centre in GROUND units, ground units per plan
  // unit on each axis, and a rotation in degrees. Ground units are map units
  // on an image ground and EPSG:3857 metres on OpenStreetMap — both planar,
  // y up. A floor's devices and polygons are stored in its PLAN's units, so
  // moving, stretching or rotating the plan carries them with it.
  function planExtent(bg) {
    var m = Math.max(bg.width || 1, bg.height || 1);
    return { w: IMAGE_EXTENT * (bg.width || 1) / m, h: IMAGE_EXTENT * (bg.height || 1) / m };
  }
  function planToGround(plan, ext, x, y) {
    var dx = (x - ext.w / 2) * plan.sx, dy = (y - ext.h / 2) * plan.sy;
    var a = plan.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    return [plan.cx + dx * c - dy * sn, plan.cy + dx * sn + dy * c];
  }
  function groundToPlan(plan, ext, gx, gy) {
    var a = -plan.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    var dx = gx - plan.cx, dy = gy - plan.cy;
    return [(dx * c - dy * sn) / plan.sx + ext.w / 2, (dx * sn + dy * c) / plan.sy + ext.h / 2];
  }
  // How a floor looks from the floor being viewed (d = its level − the
  // viewed one): itself at 100 %, one up 10 %, two up 2 %, anything higher or
  // lower hidden; floors above drawn 25 % bigger per floor, below 25 % smaller.
  var FLOOR_OPACITY = { 0: 1, 1: 0.10, 2: 0.02 };
  function floorLook(d) {
    return {
      opacity: d >= 0 && FLOOR_OPACITY[d] !== undefined ? FLOOR_OPACITY[d] : 0,
      scale: d > 0 ? Math.pow(1.25, d) : d < 0 ? Math.pow(0.75, -d) : 1,
    };
  }
  // A link between floors fades from one end's opacity to the other's.
  function fadeSteps(a, b, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(a + (b - a) * (i + 0.5) / n);
    return out;
  }
  var FADE_MS = 300;
  var TYPE_INITIALS = { firewall: "FW", switch: "SW", access_point: "AP", router: "RT", server: "SV", workstation: "PC", printer: "PR" };

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s))
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }
  function emptyCodes() { return { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null }; }
  function normCodes(c) {
    var out = emptyCodes();
    if (!c) return out;
    CODE_FIELDS.forEach(function (f) {
      var v = c[f.field];
      if (v != null && String(v).trim() !== "") out[f.field] = String(v).trim().replace(/\s+/g, " ");
    });
    return out;
  }
  function codesKey(c) {
    var n = normCodes(c);
    return CODE_FIELDS.map(function (f) { return (n[f.field] || "").toLowerCase(); }).join("|");
  }
  function codesEqual(a, b) { return codesKey(a) === codesKey(b); }
  function hasCodes(c) { var n = normCodes(c); return CODE_FIELDS.some(function (f) { return n[f.field] !== null; }); }
  function codesLabel(c) {
    var n = normCodes(c);
    var parts = CODE_FIELDS.filter(function (f) { return n[f.field] !== null; }).map(function (f) { return f.key + ":" + n[f.field]; });
    return parts.length ? parts.join(" ") : "no codes";
  }
  // The innermost level a set of codes names — what a polygon is "for".
  function deepestField(c) {
    var n = normCodes(c);
    var hit = null;
    CODE_FIELDS.forEach(function (f) { if (n[f.field] !== null) hit = f; });
    return hit;
  }
  function groupName(c) {
    var f = deepestField(c);
    return f ? f.word + " " + normCodes(c)[f.field] : "No group";
  }

  // ── Geometry (pure) ──────────────────────────────────────────────────────
  // Points are [x, y]: x = longitude / image x, y = latitude / image y.
  function pointInRing(pt, ring) {
    var x = pt[0], y = pt[1], inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function ringArea(ring) {
    var a = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    return Math.abs(a / 2);
  }
  // Convex hull (monotone chain) of [x, y] points, counter-clockwise.
  function convexHull(points) {
    var pts = points.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (pts.length < 3) return pts;
    function cross(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lower = [], upper = [];
    pts.forEach(function (p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); });
    for (var i = pts.length - 1; i >= 0; i--) {
      var p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
      upper.push(p);
    }
    upper.pop(); lower.pop();
    return lower.concat(upper);
  }
  // A rounded outline around points: the hull of a circle of radius r around
  // each one, so one device still gets a ring and two get a capsule.
  function roundedHull(points, r, steps) {
    var n = steps || 16, ring = [];
    points.forEach(function (p) {
      for (var i = 0; i < n; i++) {
        var a = 2 * Math.PI * i / n;
        ring.push([p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)]);
      }
    });
    return convexHull(ring);
  }
  // The smallest polygon containing the point — the group a drop lands in.
  function innermostPolygon(polygons, pt) {
    var best = null, bestArea = Infinity;
    (polygons || []).forEach(function (p) {
      if (!p || !Array.isArray(p.points) || p.points.length < 3) return;
      if (!pointInRing(pt, p.points)) return;
      var a = ringArea(p.points);
      if (a < bestArea) { best = p; bestArea = a; }
    });
    return best;
  }

  // Every location group the site's devices already name, as code chains
  // (each prefix of a device's chain is a group of its own), outermost first.
  function groupsFromData(data) {
    var seen = {};
    var out = [];
    function addChain(loc) {
      var n = normCodes(loc);
      var chain = emptyCodes();
      CODE_FIELDS.forEach(function (f) {
        if (n[f.field] === null) return;
        chain = Object.assign({}, chain);
        chain[f.field] = n[f.field];
        var k = codesKey(chain);
        if (!seen[k]) { seen[k] = true; out.push(chain); }
      });
    }
    if (!data) return out;
    if (data.fortigate) addChain(data.fortigate.location);
    (data.switches || []).forEach(function (s) { addChain(s.location); });
    (data.aps || []).forEach(function (a) { addChain(a.location); });
    (data.endpoints || []).forEach(function (e) { addChain(e.location); });
    return out.sort(function (a, b) { return codesKey(a).localeCompare(codesKey(b)); });
  }
  function groupDepth(c) {
    var d = -1;
    var n = normCodes(c);
    CODE_FIELDS.forEach(function (f, i) { if (n[f.field] !== null) d = i; });
    return d;
  }

  function newId(prefix) {
    var s = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return prefix + "-" + s;
  }

  // ── The canvas ───────────────────────────────────────────────────────────
  function render(host, ctx) {
    var L = window.L;
    var R = window.PolarisTopologyRender;
    if (!L || !R) {
      host.innerHTML = '<div class="empty-state topology-mode-empty">The map library did not load.</div>';
      return { destroy: function () {} };
    }
    var data = ctx.data || {};
    var view = ctx.view || {};
    var staged = ctx.stagedViewPatch() || {};
    var state = {
      editing: !!ctx.editing,
      polygons: (staged.polygons || view.polygons || []).map(function (p) {
        return { id: p.id, codes: normCodes(p.codes), points: p.points.map(function (q) { return [q[0], q[1]]; }), layer: p.layer || 0 };
      }),
      // Floor layers (rule 152): layer 0 is the view itself; the others are
      // listed with their floor name and their own background.
      layers: JSON.parse(JSON.stringify(staged.layers || view.layers || [])),
      layer: 0,
      history: { entries: [], index: -1 },
    };
    // Floor 0's background is the GROUND (map, satellite or a site plan),
    // always drawn at 100 % under every floor; a floor's own background is a
    // plan image placed on it (layer.background + layer.plan).
    var background0 = staged.background !== undefined ? staged.background : (view.background || null);
    function layerObj(level) { return state.layers.filter(function (l) { return l.level === level; })[0] || null; }
    Object.defineProperty(state, "background", {
      get: function () { return background0; },
      set: function (v) { background0 = v; },
    });
    // Placements per layer, loaded the first time a layer is shown.
    var byLayer = {};
    function placementsOf(level) {
      if (!byLayer[level]) byLayer[level] = Object.assign({}, ctx.loadPlacements(level) || {});
      return byLayer[level];
    }
    state.layers.forEach(function (l) { placementsOf(l.level); });
    placementsOf(0);
    Object.defineProperty(state, "placements", {
      get: function () { return placementsOf(state.layer); },
      set: function (v) { byLayer[state.layer] = v; },
    });
    function layerPolys() { return state.polygons.filter(function (p) { return (p.layer || 0) === state.layer; }); }
    // The layer a device is placed on, or null.
    function layerOfDevice(id) {
      var found = null;
      Object.keys(byLayer).forEach(function (k) { if (byLayer[k][id] && found === null) found = Number(k); });
      return found;
    }

    // Nodes and links from the same builder as the Layer 2 graph, so a
    // switched-on endpoint type and every link class match (rule 147).
    var elements = R.buildTopologyElements(data, { shownTypes: ctx.shownTypes });
    var nodeById = {};
    var edges = [];
    elements.forEach(function (el) {
      var d = el.data;
      if (d.source) edges.push(d); else nodeById[d.id] = d;
    });
    var edgesByNode = {};
    edges.forEach(function (e) {
      (edgesByNode[e.source] = edgesByNode[e.source] || []).push(e);
      (edgesByNode[e.target] = edgesByNode[e.target] || []).push(e);
    });
    // Each device's current codes in display casing (the payload's location).
    var currentCodes = {};
    function note(n) { if (n && n.id) currentCodes[n.id] = normCodes(n.location); }
    note(data.fortigate);
    (data.switches || []).forEach(note);
    (data.aps || []).forEach(note);
    (data.endpoints || []).forEach(note);
    // Placements of devices no longer drawn (a type switched off, a device
    // retired) are kept in the blob but not shown.

    host.innerHTML = '<div class="topo-phys-map"></div>';
    var mapEl = host.firstChild;
    var map = null;
    var markers = {};       // nodeId → L.marker
    var linkLines = {};     // edge id → L.polyline
    var polygonShapes = {}; // polygon id → L.polygon
    var drawHandler = null;
    var listFilter = "";        // the Device List's filter text, kept across pane redraws
    var selectedId = ctx.selectedId ? ctx.selectedId() : null;
    var baseLayer = null;
    var layerSwitch = null;
    var satelliteErrorShown = false;
    // While VIEWING, Map / Satellite is just a look (like a rack's Front /
    // Back); while editing it is staged into the view's background.
    var viewLayer = null;

    function family() { return typeof isLightTheme === "function" && isLightTheme() ? "light" : "dark"; }

    // Which basemap the map shows: the view's saved choice, a viewer's
    // transient pick over it, and plain Map whenever satellite is not
    // (or no longer) configured.
    function currentLayer() {
      var bg = state.background;
      var want = viewLayer || (bg && bg.kind === "osm" && bg.layer === "satellite" ? "satellite" : "map");
      return want === "satellite" && _satelliteStatus && _satelliteStatus.available ? "satellite" : "map";
    }
    function applyBaseLayer() {
      if (!map) return;
      if (baseLayer) { map.removeLayer(baseLayer); baseLayer = null; }
      if (currentLayer() === "satellite") {
        baseLayer = L.tileLayer(SATELLITE_TILE_URL, {
          maxNativeZoom: _satelliteStatus.maxNativeZoom || OSM_NATIVE_MAX,
          maxZoom: OSM_MAX_ZOOM,
          attribution: esc(_satelliteStatus.attribution || ""),
        });
        baseLayer.on("tileerror", function () {
          if (satelliteErrorShown) return;
          satelliteErrorShown = true;
          ctx.toast("Some satellite tiles did not load — the imagery provider may be refusing them (Server Settings → Customization → Test)", "error");
        });
      } else {
        baseLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxNativeZoom: OSM_NATIVE_MAX,
          maxZoom: OSM_MAX_ZOOM,
          crossOrigin: "anonymous",
          attribution: "© <a href=\"https://www.openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
        });
      }
      baseLayer.addTo(map);
      baseLayer.bringToBack();
      mapEl.classList.toggle("is-satellite", currentLayer() === "satellite");
      paintLayerSwitch();
    }
    // The Map | Satellite switch, under the zoom bar (bottom-left is the
    // legend button's corner), only when an
    // operator configured satellite imagery and the view is not an image.
    function addLayerSwitch() {
      if (!map || layerSwitch || (state.background && state.background.kind === "image")) return;
      var Ctl = L.Control.extend({
        options: { position: "topleft" },
        onAdd: function () {
          var el = L.DomUtil.create("div", "topo-phys-layer-switch");
          el.setAttribute("role", "group");
          el.setAttribute("aria-label", "Basemap");
          el.innerHTML =
            '<button type="button" data-layer="map">Map</button>' +
            '<button type="button" data-layer="satellite">Satellite</button>';
          L.DomEvent.disableClickPropagation(el);
          L.DomEvent.disableScrollPropagation(el);
          el.addEventListener("click", function (e) {
            var b = e.target.closest("[data-layer]");
            if (b) setBaseMap(b.getAttribute("data-layer"));
          });
          return el;
        },
      });
      layerSwitch = new Ctl();
      layerSwitch.addTo(map);
      paintLayerSwitch();
    }
    function paintLayerSwitch() {
      var el = layerSwitch && layerSwitch.getContainer ? layerSwitch.getContainer() : null;
      if (!el) return;
      var on = currentLayer();
      Array.prototype.forEach.call(el.querySelectorAll("[data-layer]"), function (b) {
        var is = b.getAttribute("data-layer") === on;
        b.classList.toggle("is-on", is);
        b.setAttribute("aria-pressed", is ? "true" : "false");
      });
    }
    // Map | Satellite. Named apart from the floor switcher: when both were
    // `setLayer`, the floor one replaced this and the switch did nothing.
    function setBaseMap(layer) {
      if (layer !== "map" && layer !== "satellite") return;
      if (state.editing) {
        // Staged with the framing the operator sees, like Done editing does.
        var c = map.getCenter();
        state.background = { kind: "osm", center: [Number(c.lat.toFixed(7)), Number(c.lng.toFixed(7))], zoom: map.getZoom(), layer: layer };
        viewLayer = null;
        changed("background");
      } else {
        viewLayer = layer;
      }
      applyBaseLayer();
    }

    function imageGround() { return !!(background0 && background0.kind === "image"); }
    function toGround(ll) {
      if (imageGround()) return [ll.lng, ll.lat];
      var p = L.CRS.EPSG3857.project(ll);
      return [p.x, p.y];
    }
    function fromGround(g) {
      if (imageGround()) return L.latLng(g[1], g[0]);
      return L.CRS.EPSG3857.unproject(L.point(g[0], g[1]));
    }
    // A plan with no saved placement: on an image ground it lands where the
    // old per-floor image drew (same units); on the map, centred on the site.
    function defaultPlan(ext) {
      if (imageGround()) return { cx: ext.w / 2, cy: ext.h / 2, sx: 1, sy: 1, rot: 0 };
      var fg = data.fortigate || {};
      var b = background0 && background0.kind === "osm" && Array.isArray(background0.center) ? background0.center : null;
      var c = fg.latitude != null && fg.longitude != null ? [fg.latitude, fg.longitude] : b || (map ? [map.getCenter().lat, map.getCenter().lng] : [0, 0]);
      var g = toGround(L.latLng(c[0], c[1]));
      return { cx: g[0], cy: g[1], sx: 0.1, sy: 0.1, rot: 0 };
    }
    // A plan sized to most of what is on screen, centred there (a new upload).
    function framedPlan(ext) {
      if (!map) return defaultPlan(ext);
      var b = map.getBounds();
      var w = Math.abs(toGround(b.getNorthEast())[0] - toGround(b.getSouthWest())[0]) * 0.6;
      var c = toGround(map.getCenter());
      var k = w / ext.w;
      return { cx: c[0], cy: c[1], sx: k, sy: k, rot: 0 };
    }
    function floorPlan(level) {
      if (level === 0) return null;
      var l = layerObj(level);
      var bg = l && l.background;
      if (!bg || bg.kind !== "image") return null;
      var ext = planExtent(bg);
      return { layer: l, bg: bg, ext: ext, plan: l.plan || defaultPlan(ext) };
    }
    function localToLatLng(level, x, y) {
      var fp = floorPlan(level);
      if (!fp) return L.latLng(y, x);
      return fromGround(planToGround(fp.plan, fp.ext, x, y));
    }
    function latLngToLocal(level, ll) {
      var fp = floorPlan(level);
      if (!fp) return { x: ll.lng, y: ll.lat };
      var g = toGround(ll);
      var q = groundToPlan(fp.plan, fp.ext, g[0], g[1]);
      return { x: q[0], y: q[1] };
    }

    // One Leaflet pane per floor: its plan, polygons, devices and links, so
    // the floor fades and scales as one (applyFloorLook). Higher floors on top.
    var floorPanes = {};
    var crossGroup = null, crossRenderer = null;
    var dropWired = false;
    function paneName(level) { return "floor_" + (level < 0 ? "m" + (-level) : level); }
    function floorPane(level) {
      if (floorPanes[level]) return floorPanes[level];
      var name = paneName(level);
      var pane = map.getPane(name) || map.createPane(name);
      pane.style.zIndex = String(410 + level + 20);
      pane.classList.add("topo-floor-pane");
      floorPanes[level] = { name: name, pane: pane, renderer: L.svg({ pane: name, padding: 1 }), group: L.layerGroup().addTo(map) };
      return floorPanes[level];
    }
    function dropLayer(layer) {
      if (!layer) return;
      Object.keys(floorPanes).forEach(function (k) { if (floorPanes[k].group.hasLayer(layer)) floorPanes[k].group.removeLayer(layer); });
    }
    // A floor's plan image, drawn with a CSS matrix from three of its corners
    // so it can be moved, stretched and rotated on the ground.
    var PlanOverlay = L.Layer.extend({
      initialize: function (url, fp, pane) { this._url = url; this._fp = fp; L.setOptions(this, { pane: pane }); },
      onAdd: function (m) {
        var img = this._img = L.DomUtil.create("img", "topo-floor-plan leaflet-zoom-hide");
        img.alt = "";
        img.draggable = false;
        img.src = this._url;
        this.getPane().appendChild(img);
        m.on("zoomend viewreset", this._update, this);
        this._update();
      },
      onRemove: function (m) { L.DomUtil.remove(this._img); m.off("zoomend viewreset", this._update, this); },
      _update: function () {
        var fp = this._fp, e = fp.ext;
        var iw = fp.bg.width || 1, ih = fp.bg.height || 1;
        var A = map.latLngToLayerPoint(fromGround(planToGround(fp.plan, e, 0, e.h)));
        var B = map.latLngToLayerPoint(fromGround(planToGround(fp.plan, e, e.w, e.h)));
        var C = map.latLngToLayerPoint(fromGround(planToGround(fp.plan, e, 0, 0)));
        var st = this._img.style;
        st.position = "absolute"; st.left = "0"; st.top = "0";
        st.width = iw + "px"; st.height = ih + "px";
        st.transformOrigin = "0 0";
        st.transform = "matrix(" + [(B.x - A.x) / iw, (B.y - A.y) / iw, (C.x - A.x) / ih, (C.y - A.y) / ih, A.x, A.y].join(",") + ")";
      },
    });

    function buildMap() {
      if (map) { map.remove(); map = null; }
      baseLayer = null; layerSwitch = null;
      floorPanes = {}; crossGroup = null;
      markers = {}; linkLines = {}; polygonShapes = {};
      var bg = background0;
      if (bg && bg.kind === "image") {
        map = L.map(mapEl, { crs: L.CRS.Simple, minZoom: -5, maxZoom: 5, zoomSnap: 0.25, attributionControl: false });
        var ext = planExtent(bg);
        var bounds = [[0, 0], [ext.h, ext.w]];
        L.imageOverlay(ctx.backgroundUrl(bg.imageId), bounds).addTo(map);
        map.fitBounds(bounds, { padding: [20, 20] });
        map.setMaxBounds(L.latLngBounds([[-ext.h, -ext.w], [2 * ext.h, 2 * ext.w]]));
      } else {
        map = L.map(mapEl, { maxZoom: OSM_MAX_ZOOM, zoomSnap: 0.5 });
        applyBaseLayer();
        loadSatelliteStatus().then(function (s) { if (map && s.available) { applyBaseLayer(); addLayerSwitch(); } });
        var center = bg && bg.kind === "osm" && Array.isArray(bg.center) ? bg.center : null;
        var fg = data.fortigate || {};
        if (!center && fg.latitude != null && fg.longitude != null) center = [fg.latitude, fg.longitude];
        if (center) {
          map.setView(center, bg && bg.kind === "osm" ? bg.zoom : DEFAULT_OSM_ZOOM);
        } else {
          map.setView([20, 0], 2);
          ctx.toast("This site has no coordinates — pan and zoom to it, then Done editing to keep that view");
        }
      }
      map.on("click", function () {
        if (linkSel) { linkSel = null; clearHandles(); }
        if (!drawHandler && !adjust && selectedId) select(null);
      });
      var cp = map.createPane("floor_links");
      cp.style.zIndex = "650";
      cp.style.pointerEvents = "none";
      crossRenderer = L.svg({ pane: "floor_links", padding: 1 });
      crossGroup = L.layerGroup().addTo(map);
      // Parallax: the floors scale about the middle of the screen, so a pan
      // moves the bigger floors above faster than the ground.
      map.on("move zoomend", function () { applyOrigins(); drawCrossLinks(); });
      // Room outlines are padded in pixels: redraw them for the new zoom.
      map.on("zoomend", function () { if (!adjust) { allLevels().forEach(drawFloor); paintSelected(); } });
      drawAll();
      wireDrop();
    }

    function allLevels() {
      var seen = {};
      levels().forEach(function (l) { seen[l] = true; });
      Object.keys(byLayer).forEach(function (k) { seen[Number(k)] = true; });
      return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
    }
    function drawAll() {
      if (!map) return;
      Object.keys(floorPanes).forEach(function (k) { floorPanes[k].group.clearLayers(); });
      markers = {}; linkLines = {}; polygonShapes = {};
      allLevels().forEach(drawFloor);
      applyFloorLook(false);
      drawCrossLinks();
      paintSelected();
      paintCenter();
    }
    function drawFloor(level) {
      var f = floorPane(level);
      f.group.clearLayers();
      var fp = floorPlan(level);
      if (fp) f.group.addLayer(new PlanOverlay(ctx.backgroundUrl(fp.bg.imageId), fp, f.name));
      // Drawn polygons and room outlines, largest first, so a smaller one
      // (a room inside a building, a polygon inside another) is on top.
      var shapes = [];
      state.polygons.filter(function (p) { return (p.layer || 0) === level; }).forEach(function (p) {
        var lls = p.points.map(function (q) { return localToLatLng(level, q[0], q[1]); });
        shapes.push({ area: screenArea(lls), draw: function () { drawPolygon(p, level, f); } });
      });
      roomHulls(level).forEach(function (h) {
        shapes.push({ area: screenArea(h.latlngs), draw: function () { drawRoomHull(h, f); } });
      });
      shapes.sort(function (a, b) { return b.area - a.area; }).forEach(function (sh) { sh.draw(); });
      Object.keys(placementsOf(level)).forEach(function (id) { if (nodeById[id]) addMarker(id, level); });
      edges.forEach(function (e) {
        if (layerOfDevice(e.source) === level && layerOfDevice(e.target) === level) addLine(e, level);
      });
    }

    function screenArea(lls) {
      if (!map || !lls.length) return 0;
      return ringArea(lls.map(function (ll) { var c = map.latLngToContainerPoint(ll); return [c.x, c.y]; }));
    }
    // Room outlines: the devices placed on a floor whose codes name the same
    // room (area / building / floor / room) get one outline around them,
    // derived on every draw: never stored, never a click target, never a
    // code write (rule 148 is the drawn polygons' job). Padded in screen
    // pixels, so the map redraws them on zoom.
    var HULL_PAD_PX = 30;
    function roomHulls(level) {
      if (!map) return [];
      var groups = {};
      Object.keys(placementsOf(level)).forEach(function (id) {
        var c = currentCodes[id], m = nodeById[id], p = placementsOf(level)[id];
        if (!m || !p || !c || !c.room) return;
        var key = ["area", "building", "floor", "room"].map(function (k) { return String(c[k] || "").toLowerCase(); }).join("|");
        var g = groups[key] || (groups[key] = { key: key, name: c.room, pts: [] });
        var cp = map.latLngToContainerPoint(localToLatLng(level, p.x, p.y));
        g.pts.push([cp.x, cp.y]);
      });
      return Object.keys(groups).map(function (k) {
        var g = groups[k];
        var ring = roundedHull(g.pts, HULL_PAD_PX);
        return { key: g.key, name: g.name, latlngs: ring.map(function (q) { return map.containerPointToLatLng(L.point(q[0], q[1])); }) };
      });
    }
    function drawRoomHull(h, f) {
      var color = R.locGroupColor("room", family());
      f.group.addLayer(L.polygon(h.latlngs, {
        color: color, weight: 1.5, dashArray: "4 4", fillColor: color, fillOpacity: 0.07,
        interactive: false, pane: f.name, renderer: f.renderer, className: "topo-room-hull",
      }));
      // The room's name at its top edge.
      var top = h.latlngs.reduce(function (a, b) { return map.latLngToContainerPoint(b).y < map.latLngToContainerPoint(a).y ? b : a; });
      f.group.addLayer(L.marker(top, {
        pane: f.name, interactive: false, keyboard: false,
        icon: L.divIcon({ className: "topo-room-hull-label", html: '<span style="border-color:' + esc(color) + '">' + esc(h.name) + "</span>", iconSize: null, iconAnchor: [0, 0] }),
      }));
    }

    // Each floor's opacity and scale (floorLook), eased when the floor
    // changes; only the floor being viewed takes clicks.
    var trans = null;
    function easeInOut(k) { return k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2; }
    function lookNow(level) {
      var to = floorLook(level - state.layer);
      if (!trans) return to;
      var k = easeInOut(Math.min(1, (performance.now() - trans.t0) / FADE_MS));
      var fr = floorLook(level - trans.from);
      return { opacity: fr.opacity + (to.opacity - fr.opacity) * k, scale: fr.scale + (to.scale - fr.scale) * k };
    }
    function screenOrigin() {
      var size = map.getSize();
      return map.containerPointToLayerPoint(L.point(size.x / 2, size.y / 2));
    }
    function applyOrigins() {
      if (!map) return;
      var o = screenOrigin();
      Object.keys(floorPanes).forEach(function (k) { floorPanes[k].pane.style.transformOrigin = o.x + "px " + o.y + "px"; });
    }
    function applyFloorLook(animate) {
      if (!map) return;
      var o = screenOrigin();
      Object.keys(floorPanes).forEach(function (k) {
        var level = Number(k), f = floorPanes[k], look = floorLook(level - state.layer), st = f.pane.style;
        st.transition = animate ? "opacity " + FADE_MS + "ms ease-in-out, transform " + FADE_MS + "ms ease-in-out" : "none";
        st.transformOrigin = o.x + "px " + o.y + "px";
        st.transform = "scale(" + look.scale + ")";
        st.opacity = String(look.opacity);
        f.pane.classList.toggle("is-faint", level !== state.layer);
      });
    }
    function visualLatLng(level, ll) {
      var sc = lookNow(level).scale;
      if (sc === 1) return ll;
      var size = map.getSize(), c = L.point(size.x / 2, size.y / 2);
      var cp = map.latLngToContainerPoint(ll);
      return map.containerPointToLatLng(c.add(cp.subtract(c).multiplyBy(sc)));
    }
    // Links between floors: from each end's drawn position, fading from one
    // end's opacity to the other's (operator request 2026-11-12).
    function drawCrossLinks() {
      if (!crossGroup || !map) return;
      crossGroup.clearLayers();
      edges.forEach(function (e) {
        var la = layerOfDevice(e.source), lb = layerOfDevice(e.target);
        if (la === null || lb === null || la === lb || !nodeById[e.source] || !nodeById[e.target]) return;
        var oa = lookNow(la).opacity, ob = lookNow(lb).opacity;
        if (oa < 0.005 && ob < 0.005) return;
        var pa = placementsOf(la)[e.source], pb = placementsOf(lb)[e.target];
        var A = map.latLngToContainerPoint(visualLatLng(la, localToLatLng(la, pa.x, pa.y)));
        var B = map.latLngToContainerPoint(visualLatLng(lb, localToLatLng(lb, pb.x, pb.y)));
        var st = R.edgeLineStyle(e, family());
        var N = 12, ops = fadeSteps(oa, ob, N);
        for (var i = 0; i < N; i++) {
          var p0 = A.add(B.subtract(A).multiplyBy(i / N)), p1 = A.add(B.subtract(A).multiplyBy((i + 1) / N));
          var seg = L.polyline([map.containerPointToLatLng(p0), map.containerPointToLatLng(p1)], {
            color: st.color, weight: st.width, opacity: ops[i], dashArray: st.dash, interactive: ops[i] > 0.05,
            pane: "floor_links", renderer: crossRenderer, lineCap: "butt", baseWeight: st.width,
          }).addTo(crossGroup);
          if (ops[i] > 0.05) wireLinkTip(seg, e);
        }
      });
    }
    function tickCross() {
      drawCrossLinks();
      if (trans && performance.now() - trans.t0 < FADE_MS + 20) { requestAnimationFrame(tickCross); return; }
      trans = null;
      drawCrossLinks();
    }
    // The centre the floors scale about, marked while the view has floors.
    var centerMark = document.createElement("div");
    centerMark.className = "topo-floor-center";
    centerMark.setAttribute("aria-hidden", "true");
    function paintCenter() { centerMark.hidden = !state.layers.length; }

    // ── Polygons ────────────────────────────────────────────────────────
    function polygonColor(p) {
      var f = deepestField(p.codes);
      return R.locGroupColor(f ? f.kind : "building", family());
    }
    function drawPolygons() { drawAll(); }
    function drawPolygon(p, level, f) {
      var color = polygonColor(p);
      var dashed = (deepestField(p.codes) || {}).kind === "floor" || (deepestField(p.codes) || {}).kind === "jb";
      var shape = L.polygon(p.points.map(function (q) { return localToLatLng(level, q[0], q[1]); }), {
        color: color, weight: 2, fillColor: color, fillOpacity: 0.12, dashArray: dashed ? "6 4" : null,
        pane: f.name, renderer: f.renderer,
      });
      shape.bindTooltip(esc(groupName(p.codes)) + ' <span class="topo-phys-codes">' + esc(codesLabel(p.codes)) + '</span>',
        { permanent: true, direction: "center", className: "topo-phys-polygon-label", pane: f.name });
      shape.on("click", function (e) {
        if (!state.editing || level !== state.layer || adjust) return;
        L.DomEvent.stopPropagation(e);
        openPolygonMenu(p, e.originalEvent, shape.getElement());
      });
      f.group.addLayer(shape);
      polygonShapes[p.id] = shape;
    }
    // The menu is anchored to the shape / marker element, never to mapEl:
    // showRowMenu ignores a pointerdown INSIDE its anchor, so a mapEl anchor
    // meant a click anywhere on the map could never dismiss the menu.
    function openPolygonMenu(p, ev, anchorEl) {
      if (typeof showRowMenu !== "function") return;
      showRowMenu(anchorEl || ev.target, [
        { heading: groupName(p.codes) },
        { label: "Reshape", onSelect: function () { reshapePolygon(p); } },
        { label: "Change group", onSelect: function () { pickGroup(function (codes) { p.codes = codes; changed("polygons"); drawPolygons(); restageAllCodes(); }, p.codes); } },
        { label: "Delete polygon", danger: true, onSelect: function () {
          state.polygons = state.polygons.filter(function (q) { return q.id !== p.id; });
          changed("polygons"); drawPolygons(); restageAllCodes();
        } },
      ], { menuAt: { x: ev.clientX, y: ev.clientY }, label: "Polygon", overMap: true });
    }
    function reshapePolygon(p) {
      var shape = polygonShapes[p.id];
      if (!shape || !shape.editing) { ctx.toast("Reshaping needs the drawing tools", "error"); return; }
      shape.editing.enable();
      ctx.toast("Drag the corner points; click the map outside the polygon when done");
      var finish = function () {
        map.off("click", finish);
        shape.editing.disable();
        var ring = shape.getLatLngs()[0] || [];
        p.points = ring.map(function (ll) { var q = latLngToLocal(state.layer, ll); return [q.x, q.y]; });
        changed("polygons");
        drawPolygons();
        restageAllCodes();
      };
      setTimeout(function () { map.on("click", finish); }, 0);
    }
    function startDrawing() {
      if (!state.editing) return;
      if (!L.Draw || !L.Draw.Polygon) { ctx.toast("The drawing tools did not load", "error"); return; }
      pickGroup(function (codes) {
        if (drawHandler) { try { drawHandler.disable(); } catch (e) {} }
        var color = polygonColor({ codes: codes });
        drawHandler = new L.Draw.Polygon(map, { shapeOptions: { color: color, weight: 2, fillOpacity: 0.12 }, showArea: false, allowIntersection: false });
        map.once(L.Draw.Event.CREATED, function (e) {
          var ring = (e.layer.getLatLngs()[0] || []).map(function (ll) { var q = latLngToLocal(state.layer, ll); return [q.x, q.y]; });
          drawHandler = null;
          if (ring.length < 3) return;
          state.polygons.push({ id: newId("poly"), codes: codes, points: ring, layer: state.layer });
          changed("polygons");
          drawPolygons();
          restageAllCodes();
        });
        drawHandler.enable();
        ctx.toast("Drawing " + groupName(codes) + " — click to add points, click the first point to close, Esc cancels");
      });
    }

    // The "Draw polygon for which group?" dialog: the groups the site's
    // descriptions already name, plus a new group inside any of them.
    function pickGroup(onPick, current) {
      if (typeof buildOverlay !== "function") return;
      // Areas, buildings and floors only: each group cut back to those levels.
      var groups = [];
      groupsFromData(data).concat(state.polygons.map(function (p) { return p.codes; })).forEach(function (g) {
        var c = polyCodes(g);
        if (polyHasCodes(c) && !groups.some(function (x) { return codesEqual(x, c); })) groups.push(c);
      });
      groups.sort(function (a, b) { return codesKey(a).localeCompare(codesKey(b)); });
      var drawn = {};
      layerPolys().forEach(function (p) { drawn[codesKey(p.codes)] = true; });
      var rows = groups.map(function (g, i) {
        var f = deepestField(g);
        var color = R.locGroupColor(f ? f.kind : "building", family());
        var checked = current ? codesEqual(polyCodes(current), g) : i === 0;
        return '<label class="topo-phys-group" style="margin-left:' + (groupDepth(g) * 18) + 'px">' +
          '<input type="radio" name="topo-pg" value="' + i + '"' + (checked ? " checked" : "") + '>' +
          '<span class="topo-phys-swatch" style="background:' + color + '"></span>' +
          '<span>' + esc(groupName(g)) + '</span>' +
          (drawn[codesKey(g)] ? ' <span class="badge badge-readonly">drawn</span>' : '') +
          '<span class="topo-phys-codes">' + esc(codesLabel(g)) + '</span></label>';
      }).join("");
      var parentOptions = '<option value="-1">Nothing — a group of its own</option>' + groups.map(function (g, i) {
        return '<option value="' + i + '">' + esc(codesLabel(g)) + '</option>';
      }).join("");
      var body =
        '<p class="hint" style="margin:0 0 8px">Areas, buildings and floors from the location codes in device descriptions. A device dropped inside the polygon takes these codes when you save; its room, rack and junction box stay as they are.</p>' +
        '<div class="topo-phys-groups">' + (rows || '<p class="hint">No device has location codes yet — make a new group below.</p>') + '</div>' +
        '<label class="topo-phys-group topo-phys-group-new"><input type="radio" name="topo-pg" value="new"' + (groups.length ? "" : " checked") + '> <strong>New group</strong></label>' +
        '<div class="topo-phys-new" style="display:grid;grid-template-columns:150px 1fr;gap:8px;margin-top:6px">' +
          '<select id="topo-pg-kind" aria-label="Kind">' + POLY_FIELDS.filter(function (f) { return state.layer === 0 || f.field !== "floor"; }).map(function (f) { return '<option value="' + f.field + '">' + f.word + '</option>'; }).join("") + '</select>' +
          '<input id="topo-pg-name" type="text" maxlength="64" placeholder="Name, e.g. Shipping" aria-label="Name">' +
          '<label for="topo-pg-parent" style="align-self:center;font-size:0.82rem">Part of</label>' +
          '<select id="topo-pg-parent">' + parentOptions + '</select>' +
          '<p class="hint" style="grid-column:1 / -1;margin:0">The group this one sits within. A Floor "2" that is part of <code>b:Plant</code> gives a device <code>b:Plant f:2</code>; with Nothing it gets only <code>f:2</code>.</p>' +
        '</div>';
      var footer = '<button type="button" class="btn btn-secondary" data-pg="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-pg="ok">' + (current ? "Use this group" : "Start drawing") + '</button>';
      var dlg = buildOverlay(1100, current ? "Change the polygon's group" : "Draw polygon for which group?", body, footer);
      dlg.overlay.querySelector('[data-pg="cancel"]').addEventListener("click", dlg.close);
      dlg.overlay.querySelector("#topo-pg-name").addEventListener("input", function () {
        var nw = dlg.overlay.querySelector('input[name="topo-pg"][value="new"]');
        if (nw) nw.checked = true;
      });
      dlg.overlay.querySelector('[data-pg="ok"]').addEventListener("click", function () {
        var pick = dlg.overlay.querySelector('input[name="topo-pg"]:checked');
        if (!pick) return;
        var codes;
        if (pick.value === "new") {
          var field = dlg.overlay.querySelector("#topo-pg-kind").value;
          var name = dlg.overlay.querySelector("#topo-pg-name").value.trim().replace(/\s+/g, " ");
          var parentIdx = Number(dlg.overlay.querySelector("#topo-pg-parent").value);
          if (!name) { ctx.toast("Give the new group a name", "error"); return; }
          if (field === "floor" && !/^-?\d{1,2}$/.test(name)) { ctx.toast("A floor is a number: 0 is the ground, -1 below it, 1 above", "error"); return; }
          if (/(?:^|\s)(?:jb|ra|a|b|f|r):/i.test(name)) { ctx.toast("A group name can't contain another location code", "error"); return; }
          var parent = parentIdx >= 0 ? normCodes(groups[parentIdx]) : emptyCodes();
          var fieldIdx = CODE_FIELDS.findIndex(function (f) { return f.field === field; });
          if (fieldIdx <= groupDepth(parent)) {
            ctx.toast("A " + CODE_FIELDS[fieldIdx].word.toLowerCase() + " can't sit inside " + groupName(parent), "error");
            return;
          }
          codes = Object.assign({}, parent);
          codes[field] = name;
        } else {
          codes = normCodes(groups[Number(pick.value)]);
        }
        dlg.close();
        onPick(codes);
      });
    }

    // ── Devices ─────────────────────────────────────────────────────────
    function nodeColor(d) { return d.nodeColor || "#64748b"; }
    function iconHtml(d) {
      var t = R.nodeAssetType(d) || "";
      var inner = d.iconUrl ? '<img src="' + esc(d.iconUrl) + '" alt="">'
        : '<span>' + esc(TYPE_INITIALS[t] || String(t || "?").slice(0, 2).toUpperCase()) + '</span>';
      return '<div class="topo-phys-node" style="border-color:' + esc(nodeColor(d)) + '">' + inner + '</div>' +
        '<div class="topo-phys-name">' + esc(d.label || d.id) + '</div>';
    }
    function drawMarkers() { drawAll(); }
    function addMarker(id, level) {
      var d = nodeById[id];
      var p = placementsOf(level)[id];
      if (!d || !p) return;
      var f = floorPane(level);
      var m = L.marker(localToLatLng(level, p.x, p.y), {
        icon: L.divIcon({ className: "topo-phys-marker", html: iconHtml(d), iconSize: [34, 34], iconAnchor: [17, 17] }),
        draggable: state.editing && level === state.layer,
        keyboard: false,
        title: d.label || "",
        pane: f.name,
      });
      m.on("drag", function () { placementsOf(level)[id] = latLngToLocal(level, m.getLatLng()); drawLinksFor(id); });
      m.on("dragend", function () {
        placementsOf(level)[id] = latLngToLocal(level, m.getLatLng());
        changed("placements");
        stageCodesFor(id);
        // The room outlines follow (this redraws the floor, the marker included).
        setTimeout(function () { drawFloor(level); drawCrossLinks(); paintSelected(); }, 0);
      });
      m.on("click", function () { select(id); });
      m.on("dblclick", function () { ctx.openAsset(d.assetId || id); });
      m.on("contextmenu", function (e) {
        if (!state.editing || level !== state.layer || typeof showRowMenu !== "function") return;
        showRowMenu(m.getElement() || e.originalEvent.target, [
          { heading: d.label || "Device" },
          { label: "Open", onSelect: function () { ctx.openAsset(d.assetId || id); } },
          { label: "Remove from map", danger: true, onSelect: function () { removePlacement(id); } },
        ], { menuAt: { x: e.originalEvent.clientX, y: e.originalEvent.clientY }, label: "Device", overMap: true });
      });
      f.group.addLayer(m);
      markers[id] = m;
      paintSelected();
    }
    function place(id, latlng) {
      if (!state.editing || !nodeById[id]) return;
      // A device is on one layer at a time (rule 152): placing it here takes
      // it off any other layer.
      Object.keys(byLayer).forEach(function (k) {
        if (Number(k) !== state.layer && byLayer[k][id]) {
          delete byLayer[k][id];
          ctx.stagePlacements(Object.assign({}, byLayer[k]), Number(k));
        }
      });
      state.placements[id] = latLngToLocal(state.layer, latlng);
      if (markers[id]) { dropLayer(markers[id]); delete markers[id]; }
      Object.keys(floorPanes).forEach(function (k) { if (Number(k) !== state.layer) drawFloor(Number(k)); });
      drawFloor(state.layer);
      changed("placements");
      stageCodesFor(id);
      drawLinksFor(id);
      ctx.refreshSidebar();
    }
    // Removing a placement never touches codes (rule 148) — but a change
    // this session staged for it no longer has a drop behind it.
    // The selected device: its marker is ringed and map.js fills the details
    // pane's info card with it. A click on the map's background clears it.
    function select(id) {
      selectedId = id || null;
      paintSelected();
      if (typeof ctx.selectAsset === "function") ctx.selectAsset(selectedId);
    }
    function paintSelected() {
      Object.keys(markers).forEach(function (mid) {
        var el = markers[mid].getElement && markers[mid].getElement();
        if (el) el.classList.toggle("is-selected", mid === selectedId);
      });
    }

    function removePlacement(id) {
      delete state.placements[id];
      if (markers[id]) { dropLayer(markers[id]); delete markers[id]; }
      ctx.stageLocationCode(nodeById[id] ? (nodeById[id].assetId || id) : id, null);
      changed("placements");
      drawFloor(state.layer);
      drawLinksFor(id);
      ctx.refreshSidebar();
    }
    // Rule 148: inside a polygon → that group's area / building / floor
    // (rule 148(a): only the levels the polygon sets; the room, rack and
    // junction box are never touched); outside every polygon → nothing.
    function stageCodesFor(id) {
      var d = nodeById[id];
      var p = state.placements[id];
      if (!d || !p) return;
      var assetId = d.assetId || id;
      var poly = innermostPolygon(layerPolys(), [p.x, p.y]);
      var want = poly ? polyCodes(poly.codes) : emptyCodes();
      // Rule 152 / 168: a floor layer gives its floor NUMBER; floor 0 (the
      // ground) gives none and clears an old one.
      want.floor = state.layer !== 0 ? String(state.layer) : null;
      var levels = POLY_FIELDS.map(function (f) { return f.field; }).filter(function (k) { return want[k] !== null || k === "floor"; });
      var cur = normCodes(currentCodes[id]);
      var same = levels.every(function (k) { return String(want[k] || "").toLowerCase() === String(cur[k] || "").toLowerCase(); });
      if (!levels.length || same) { ctx.stageLocationCode(assetId, null); return; }
      ctx.stageLocationCode(assetId, want, {
        name: d.label || assetId,
        from: currentCodes[id] || emptyCodes(),
        levels: levels,
      });
    }
    function restageAllCodes() { Object.keys(state.placements).forEach(stageCodesFor); }

    // ── Links ───────────────────────────────────────────────────────────
    // ── Links: Layer 2's hover tooltip, and its bends and end points ────
    // A link's hover card is Layer 2's (topology-render.js → edgeTooltipHtml),
    // fed through a two-method adapter so it reads the same element data.
    var EE = window.PolarisTopologyEdgeEditor || null;
    var pathKeyById = {};
    if (EE) EE.assignPathKeys(edges).forEach(function (k, i) { pathKeyById[edges[i].id] = k; });
    var tipCy = { getElementById: function (id) { return { data: function (k) { return (nodeById[id] || {})[k]; } }; } };
    function linkTipHtml(e) {
      return R.edgeTooltipHtml ? R.edgeTooltipHtml(tipCy, { data: function (k) { return e[k]; } }) : null;
    }
    function wireLinkTip(line, e) {
      line.on("mouseover", function (ev) {
        var html = linkTipHtml(e);
        if (!html || !ctx.linkTip) return;
        line.setStyle({ weight: (line.options.baseWeight || 2) + 2 });
        ctx.linkTip.show(html, ev.originalEvent.clientX, ev.originalEvent.clientY);
      });
      line.on("mousemove", function (ev) { if (ctx.linkTip) ctx.linkTip.move(ev.originalEvent.clientX, ev.originalEvent.clientY); });
      line.on("mouseout", function () { line.setStyle({ weight: line.options.baseWeight || 2 }); if (ctx.linkTip) ctx.linkTip.hide(); });
    }
    // A floor's hand-drawn paths live in that floor's placement blob under
    // Layer 2's own keys (edgepath:<pathKey>:b<n> / :s / :t): bends in the
    // floor's plan units, end points as a unit direction on screen.
    var END_PX = 17;
    function pathsOf(level) { return EE ? EE.parsePaths(placementsOf(level)) : {}; }
    function savePaths(level, paths) {
      var pl = placementsOf(level);
      Object.keys(pl).forEach(function (k) { if (k.indexOf("edgepath:") === 0) delete pl[k]; });
      Object.assign(pl, EE.serializePaths(paths));
      changed("placements");
    }
    // An end point sits on a ring round its device: along the stored
    // direction, or (automatic) facing the next point of the line.
    function endLatLng(center, dir, toward) {
      var c = map.latLngToContainerPoint(center);
      if (!dir) {
        var t = map.latLngToContainerPoint(toward);
        var dx = t.x - c.x, dy = t.y - c.y, len = Math.sqrt(dx * dx + dy * dy);
        if (len < 1e-6) return center;
        dir = { x: dx / len, y: dy / len };
      }
      return map.containerPointToLatLng(L.point(c.x + dir.x * END_PX, c.y + dir.y * END_PX));
    }
    function linePoints(e, level, path) {
      var a = placementsOf(level)[e.source], b = placementsOf(level)[e.target];
      var S = localToLatLng(level, a.x, a.y), T = localToLatLng(level, b.x, b.y);
      var mid = ((path && path.bends) || []).map(function (q) { return localToLatLng(level, q.x, q.y); });
      return [endLatLng(S, path && path.s, mid.length ? mid[0] : T)].concat(mid, [endLatLng(T, path && path.t, mid.length ? mid[mid.length - 1] : S)]);
    }
    var linkSel = null;      // { id, level, handle: "b<n>" | "s" | "t" | null }
    var handleLayers = [];
    function addLine(e, level) {
      var a = placementsOf(level)[e.source], b = placementsOf(level)[e.target];
      if (!a || !b || !nodeById[e.source] || !nodeById[e.target]) return;
      var f = floorPane(level);
      var st = R.edgeLineStyle(e, family());
      var pk = pathKeyById[e.id];
      var line = L.polyline(linePoints(e, level, pk ? pathsOf(level)[pk] : null), {
        color: st.color, weight: st.width, dashArray: st.dash, interactive: true, pane: f.name, renderer: f.renderer,
        baseWeight: st.width,
      });
      wireLinkTip(line, e);
      line.on("mousedown", function (ev) { onLinePress(ev, e, level); });
      line.on("click", function (ev) {
        if (!state.editing || level !== state.layer || adjust || !pk) return;
        L.DomEvent.stopPropagation(ev); // not a background click
        linkSel = { id: e.id, level: level, handle: null };
        drawHandles();
      });
      f.group.addLayer(line);
      linkLines[e.id] = line;
      if (linkSel && linkSel.id === e.id) drawHandles();
    }
    // Press a line in edit mode: a drag past a few pixels drops a new bend
    // under the pointer and moves it; a plain click selects the line and
    // shows its handles (Layer 2's gestures).
    function onLinePress(ev, e, level) {
      if (!state.editing || level !== state.layer || adjust || !EE || ev.originalEvent.button !== 0) return;
      var pk = pathKeyById[e.id];
      if (!pk) return;
      L.DomEvent.stop(ev.originalEvent);
      map.dragging.disable();
      var start = map.mouseEventToContainerPoint(ev.originalEvent);
      var bendAt = null;
      var paths = pathsOf(level);
      function onMove(mv) {
        var cp = map.mouseEventToContainerPoint(mv);
        if (bendAt === null) {
          if (cp.distanceTo(start) < 4) return;
          var path = paths[pk] || (paths[pk] = { bends: [] });
          path.bends = path.bends || [];
          if (path.bends.length >= EE.MAX_BENDS) return;
          var pts = linePoints(e, level, path).map(function (ll) { var c = map.latLngToContainerPoint(ll); return { x: c.x, y: c.y }; });
          bendAt = EE.insertIndex(pts[0], pts[pts.length - 1], pts.slice(1, -1), { x: start.x, y: start.y });
          path.bends.splice(bendAt, 0, latLngToLocal(level, map.containerPointToLatLng(start)));
          linkSel = { id: e.id, level: level, handle: "b" + bendAt };
        }
        paths[pk].bends[bendAt] = latLngToLocal(level, map.containerPointToLatLng(cp));
        linkLines[e.id].setLatLngs(linePoints(e, level, paths[pk]));
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        map.dragging.enable();
        if (bendAt === null) return; // a plain click: the line's click handler selects it
        // The click the browser fires after this release would reach the
        // map's background click and drop the selection: swallow it.
        var eat = function (ce) { ce.stopPropagation(); ce.preventDefault(); };
        window.addEventListener("click", eat, true);
        setTimeout(function () { window.removeEventListener("click", eat, true); }, 0);
        savePaths(level, paths);
        drawHandles();
      }
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
    }
    // The selected line's handles: every bend (drag to move) and one end
    // point on each device (drag round the device to attach the line there).
    function clearHandles() { handleLayers.forEach(function (x) { x.remove(); }); handleLayers = []; }
    function drawHandles() {
      clearHandles();
      if (!linkSel || !state.editing || linkSel.level !== state.layer || !map) return;
      var e = edges.filter(function (x) { return x.id === linkSel.id; })[0];
      var pk = e && pathKeyById[e.id];
      if (!e || !pk || !linkLines[e.id]) { linkSel = null; return; }
      var level = linkSel.level, paths = pathsOf(level), path = paths[pk] || { bends: [] };
      var pts = linePoints(e, level, path);
      function handle(ll, part, round) {
        var on = linkSel.handle === part;
        var m = L.marker(ll, {
          draggable: true, keyboard: false, pane: "floor_links",
          icon: L.divIcon({ className: "topo-link-handle" + (round ? " is-end" : "") + (on ? " is-selected" : ""), iconSize: [12, 12], iconAnchor: [6, 6] }),
        });
        m.on("click", function (ev) { L.DomEvent.stop(ev); linkSel.handle = part; drawHandles(); });
        m.on("dragstart", function () { linkSel.handle = part; });
        m.on("drag", function () {
          var p = paths[pk] || (paths[pk] = { bends: [] });
          if (round) {
            var who = part === "s" ? e.source : e.target;
            var q = placementsOf(level)[who];
            var c = map.latLngToContainerPoint(localToLatLng(level, q.x, q.y));
            var at = map.latLngToContainerPoint(m.getLatLng());
            var dx = at.x - c.x, dy = at.y - c.y, len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1e-6) return;
            p[part] = { x: dx / len, y: dy / len };
            m.setLatLng(endLatLng(localToLatLng(level, q.x, q.y), p[part]));
          } else {
            p.bends[Number(part.slice(1))] = latLngToLocal(level, m.getLatLng());
          }
          linkLines[e.id].setLatLngs(linePoints(e, level, p));
        });
        m.on("dragend", function () { savePaths(level, paths); drawHandles(); });
        m.addTo(map);
        handleLayers.push(m);
      }
      handle(pts[0], "s", true);
      (path.bends || []).forEach(function (b, i) { handle(pts[i + 1], "b" + i, false); });
      handle(pts[pts.length - 1], "t", true);
    }
    // Delete on a selected handle: a bend goes; an end point returns to automatic.
    function deleteSelectedHandle() {
      if (!linkSel || !linkSel.handle || !state.editing) return false;
      var e = edges.filter(function (x) { return x.id === linkSel.id; })[0];
      var pk = e && pathKeyById[e.id];
      if (!pk) return false;
      var paths = pathsOf(linkSel.level), path = paths[pk];
      if (!path) return false;
      if (linkSel.handle === "s" || linkSel.handle === "t") delete path[linkSel.handle];
      else path.bends.splice(Number(linkSel.handle.slice(1)), 1);
      linkSel.handle = null;
      savePaths(linkSel.level, paths);
      drawLinksFor(e.source);
      drawHandles();
      return true;
    }
    function drawLinks() { drawAll(); }
    function drawLinksFor(id) {
      (edgesByNode[id] || []).forEach(function (e) {
        if (linkLines[e.id]) { dropLayer(linkLines[e.id]); delete linkLines[e.id]; }
        var la = layerOfDevice(e.source), lb = layerOfDevice(e.target);
        if (la !== null && la === lb) addLine(e, la);
      });
      drawCrossLinks();
    }

    // ── Drag in from the details pane ───────────────────────────────────
    function wireDrop() {
      if (dropWired) return;
      dropWired = true;
      mapEl.addEventListener("dragover", function (e) {
        if (!state.editing) return;
        var types = e.dataTransfer && e.dataTransfer.types;
        if (types && Array.prototype.indexOf.call(types, DRAG_MIME) !== -1) {
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }
      });
      mapEl.addEventListener("drop", function (e) {
        if (!state.editing) return;
        var id = e.dataTransfer && e.dataTransfer.getData(DRAG_MIME);
        if (!id) return;
        e.preventDefault();
        place(id, map.mouseEventToLatLng(e));
      });
    }

    // ── Background ──────────────────────────────────────────────────────
    function hasDrawing() { return layerPolys().length > 0 || Object.keys(state.placements).length > 0; }
    async function confirmClear(kindWord) {
      if (!hasDrawing()) return true;
      return typeof showConfirm === "function"
        ? showConfirm("Changing to " + kindWord + " clears the polygons and device placements drawn on the current background. Continue?")
        : false;
    }
    function clearDrawing() {
      Object.keys(state.placements).forEach(function (id) { ctx.stageLocationCode(nodeById[id] ? (nodeById[id].assetId || id) : id, null); });
      state.placements = {};
      state.polygons = state.polygons.filter(function (q) { return (q.layer || 0) !== state.layer; });
    }
    function openBackgroundMenu(anchor) {
      if (!state.editing || typeof showRowMenu !== "function") return;
      // One corner popover at a time: the menu drawn over the open Mouse
      // controls panel read as two-tone glass.
      if (typeof ctx.closePopovers === "function") ctx.closePopovers();
      if (state.layer !== 0) { openPlanMenu(anchor); return; }
      var bg = state.background;
      var isImage = bg && bg.kind === "image";
      showRowMenu(anchor, [
        { heading: "Ground (floor 0)" },
        { label: (isImage ? "" : "✓ ") + "OpenStreetMap", onSelect: async function () {
          if (!isImage) return;
          if (!(await confirmClear("the map"))) return;
          clearDrawing();
          state.background = null;
          dropPlans();
          changed("background", "polygons", "placements", "layers");
          buildMap();
          ctx.refreshSidebar();
        } },
        { label: isImage ? "Replace site plan" : "Upload site plan", onSelect: function () { chooseImage(); } },
      ], { label: "Background", align: "end", overMap: true });
    }
    // The floors' plans sit in ground units; a new ground starts them again
    // at their default place (their devices follow, staying on their plans).
    function dropPlans() { state.layers.forEach(function (l) { delete l.plan; }); }
    // A floor's plan: upload / replace, adjust (move, stretch, rotate), remove.
    function openPlanMenu(anchor) {
      var level = state.layer;
      var fp = floorPlan(level);
      var items = [{ heading: layerName(level) + " plan" },
        { label: fp ? "Replace floor plan" : "Upload floor plan", onSelect: function () { choosePlan(level); } }];
      if (fp) {
        items.push({ label: "Adjust floor plan", onSelect: startAdjust });
        items.push({ label: "Remove floor plan", danger: true, onSelect: function () { setPlan(level, null, null); } });
      }
      showRowMenu(anchor, items, { label: "Floor plan", align: "end", overMap: true });
    }
    // Changing a floor's plan keeps every device and polygon on it where it
    // is on the map: their plan coordinates are re-expressed in the new plan.
    function setPlan(level, background, plan) {
      var l = layerObj(level);
      if (!l) return;
      var pl = placementsOf(level);
      var spots = {};
      Object.keys(pl).forEach(function (id) {
        if (/^edgepath:.*:[st]$/.test(id)) return; // an end point is a direction, not a place
        spots[id] = localToLatLng(level, pl[id].x, pl[id].y);
      });
      var rings = {};
      state.polygons.forEach(function (p) {
        if ((p.layer || 0) === level) rings[p.id] = p.points.map(function (q) { return localToLatLng(level, q[0], q[1]); });
      });
      l.background = background;
      if (plan) l.plan = plan; else delete l.plan;
      Object.keys(spots).forEach(function (id) { pl[id] = latLngToLocal(level, spots[id]); });
      state.polygons.forEach(function (p) {
        if (rings[p.id]) p.points = rings[p.id].map(function (ll) { var q = latLngToLocal(level, ll); return [q.x, q.y]; });
      });
      changed("layers", "polygons", "placements");
      drawAll();
    }
    function choosePlan(level) {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp";
      input.addEventListener("change", async function () {
        var file = input.files && input.files[0];
        if (!file) return;
        ctx.toast("Uploading the floor plan…");
        try {
          var img = await ctx.uploadBackground(file);
          if (!img || !img.id) throw new Error("no image returned");
          var bg = { kind: "image", imageId: img.id, width: img.width, height: img.height };
          var old = floorPlan(level);
          // A replacement keeps the old plan's place and size; a first plan
          // is framed to the screen.
          var plan = old ? Object.assign({}, old.plan) : framedPlan(planExtent(bg));
          if (old) { var oe = old.ext, ne = planExtent(bg); plan.sx = plan.sx * oe.w / ne.w; plan.sy = plan.sy * oe.h / ne.h; }
          setPlan(level, bg, plan);
          ctx.toast("Floor plan uploaded — Adjust floor plan to line it up; it is saved with the view when you save");
        } catch (err) {
          ctx.toast("Floor plan not uploaded — " + (err && err.message ? err.message : String(err)), "error");
        }
      });
      input.click();
    }

    // ── Adjusting a floor's plan ────────────────────────────────────────
    // Drag = move; drag a corner = stretch freely; Ctrl + corner = keep its
    // shape; Alt + drag = rotate. Done or Esc finishes.
    var adjust = null;
    function planCorners(fp) {
      return [[0, 0], [fp.ext.w, 0], [fp.ext.w, fp.ext.h], [0, fp.ext.h]].map(function (q) {
        return fromGround(planToGround(fp.plan, fp.ext, q[0], q[1]));
      });
    }
    function startAdjust() {
      var fp = floorPlan(state.layer);
      if (!fp || !state.editing || !map) return;
      if (!fp.layer.plan) fp.layer.plan = Object.assign({}, fp.plan);
      adjust = { level: state.layer, bar: document.createElement("div"), shapes: [] };
      adjust.bar.className = "topo-plan-bar";
      adjust.bar.innerHTML = '<strong>Adjusting ' + esc(layerName(state.layer)) + "'s plan</strong>" +
        '<span class="hint" style="margin:0">Drag to move · drag a corner to stretch · Ctrl + corner keeps the shape · Alt + drag rotates</span>' +
        '<button type="button" class="btn btn-secondary btn-sm" data-plan="reset">Reset</button>' +
        '<button type="button" class="btn btn-primary btn-sm" data-plan="done">Done</button>';
      host.appendChild(adjust.bar);
      adjust.bar.addEventListener("click", function (e) {
        if (e.target.closest('[data-plan="done"]')) endAdjust();
        else if (e.target.closest('[data-plan="reset"]')) {
          var l = layerObj(adjust.level);
          if (!l) return;
          l.plan = framedPlan(planExtent(l.background));
          changed("layers");
          drawFloor(adjust.level); drawCrossLinks(); drawAdjustShapes();
        }
      });
      map.dragging.disable();
      map.doubleClickZoom.disable();
      mapEl.addEventListener("pointerdown", onAdjustDown, true);
      host.classList.add("is-adjusting");
      drawAdjustShapes();
    }
    function endAdjust() {
      if (!adjust) return;
      mapEl.removeEventListener("pointerdown", onAdjustDown, true);
      adjust.shapes.forEach(function (x) { x.remove(); });
      if (adjust.bar.parentNode) adjust.bar.parentNode.removeChild(adjust.bar);
      host.classList.remove("is-adjusting");
      adjust = null;
      if (map) { map.dragging.enable(); map.doubleClickZoom.enable(); }
    }
    function drawAdjustShapes() {
      if (!adjust) return;
      adjust.shapes.forEach(function (x) { x.remove(); });
      var fp = floorPlan(adjust.level);
      if (!fp) { endAdjust(); return; }
      var corners = planCorners(fp);
      var accent = "#38bdf8";
      adjust.shapes = [L.polygon(corners, { color: accent, weight: 2, dashArray: "6 4", fill: false, interactive: false, pane: "floor_links", renderer: crossRenderer }).addTo(map)]
        .concat(corners.map(function (ll) {
          return L.circleMarker(ll, { radius: 6, color: accent, weight: 2, fillColor: "#ffffff", fillOpacity: 1, interactive: false, pane: "floor_links", renderer: crossRenderer }).addTo(map);
        }));
    }
    function onAdjustDown(e) {
      if (!adjust || e.button !== 0 || e.target.closest(".topo-plan-bar, .leaflet-control")) return;
      var fp = floorPlan(adjust.level);
      if (!fp) return;
      var l = fp.layer;
      var cp = map.mouseEventToContainerPoint(e);
      var corners = planCorners(fp).map(function (ll) { return map.latLngToContainerPoint(ll); });
      var ci = -1;
      corners.forEach(function (c, i) { if (ci < 0 && c.distanceTo(cp) < 12) ci = i; });
      var ring = corners.map(function (c) { return [c.x, c.y]; });
      var mode = e.altKey ? "rotate" : ci >= 0 ? "scale" : pointInRing([cp.x, cp.y], ring) ? "move" : null;
      if (!mode) return;
      e.preventDefault();
      e.stopPropagation();
      var g0 = toGround(map.containerPointToLatLng(cp));
      var start = Object.assign({}, l.plan);
      var pending = false;
      function redraw() { pending = false; if (!adjust) return; drawFloor(adjust.level); drawCrossLinks(); drawAdjustShapes(); }
      function onMove(ev) {
        var g = toGround(map.containerPointToLatLng(map.mouseEventToContainerPoint(ev)));
        var p = l.plan;
        if (mode === "move") {
          p.cx = start.cx + g[0] - g0[0];
          p.cy = start.cy + g[1] - g0[1];
        } else if (mode === "rotate") {
          var a0 = Math.atan2(g0[1] - start.cy, g0[0] - start.cx), a1 = Math.atan2(g[1] - start.cy, g[0] - start.cx);
          p.rot = start.rot + (a1 - a0) * 180 / Math.PI;
        } else {
          // Stretch about the centre, in the plan's own (rotated) axes.
          var a = -start.rot * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
          var dx = g[0] - start.cx, dy = g[1] - start.cy;
          var nsx = Math.max(Math.abs(dx * c - dy * sn) / (fp.ext.w / 2), 1e-6);
          var nsy = Math.max(Math.abs(dx * sn + dy * c) / (fp.ext.h / 2), 1e-6);
          if (ev.ctrlKey || ev.metaKey) {
            var r = (nsx / start.sx + nsy / start.sy) / 2;
            nsx = start.sx * r; nsy = start.sy * r;
          }
          p.sx = nsx; p.sy = nsy;
        }
        if (!pending) { pending = true; requestAnimationFrame(redraw); }
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
        changed("layers");
      }
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
    }
    function chooseImage() {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = "image/png,image/jpeg,image/webp";
      input.addEventListener("change", async function () {
        var file = input.files && input.files[0];
        if (!file) return;
        if (!(await confirmClear("an image"))) return;
        ctx.toast("Uploading the background…");
        try {
          var img = await ctx.uploadBackground(file);
          if (!img || !img.id) throw new Error("no image returned");
          clearDrawing();
          state.background = { kind: "image", imageId: img.id, width: img.width, height: img.height };
          dropPlans();
          changed("background", "polygons", "placements", "layers");
          buildMap();
          ctx.refreshSidebar();
          ctx.toast("Background uploaded — it is saved with the view when you save");
        } catch (err) {
          ctx.toast("Background not uploaded — " + (err && err.message ? err.message : String(err)), "error");
        }
      });
      input.click();
    }
    // The OSM view the operator framed becomes the view's background on
    // commit (operator request: "when they exit edit mode it saves the zoom
    // and coordinates").
    function captureOsmView() {
      if (!map || (state.background && state.background.kind === "image")) return;
      var c = map.getCenter();
      var cur = state.background;
      var layer = cur && cur.kind === "osm" && cur.layer === "satellite" ? "satellite" : "map";
      var next = { kind: "osm", center: [Number(c.lat.toFixed(7)), Number(c.lng.toFixed(7))], zoom: map.getZoom(), layer: layer };
      if (cur && cur.kind === "osm" && cur.zoom === next.zoom && cur.center[0] === next.center[0] && cur.center[1] === next.center[1] && (cur.layer || "map") === layer) return;
      state.background = next;
      ctx.stageViewPatch({ background: next });
    }

    // ── Staging + history ───────────────────────────────────────────────
    function snapshot() {
      return JSON.stringify({ background0: background0, layers: state.layers, polygons: state.polygons, byLayer: byLayer });
    }
    function stageAll(fields) {
      fields.forEach(function (f) {
        if (f === "polygons") ctx.stageViewPatch({ polygons: state.polygons });
        if (f === "background") ctx.stageViewPatch({ background: background0 });
        if (f === "layers") ctx.stageViewPatch({ layers: state.layers });
        if (f === "placements") ctx.stagePlacements(Object.assign({}, state.placements), state.layer);
        if (f === "allPlacements") Object.keys(byLayer).forEach(function (k) { ctx.stagePlacements(Object.assign({}, byLayer[k]), Number(k)); });
      });
    }
    function changed() {
      var fields = Array.prototype.slice.call(arguments);
      stageAll(fields);
      var h = state.history;
      h.entries = h.entries.slice(0, h.index + 1);
      h.entries.push(snapshot());
      if (h.entries.length > HISTORY_MAX) h.entries.shift();
      h.index = h.entries.length - 1;
      ctx.historyChanged();
      if (fields.indexOf("placements") !== -1) paintLayerCtl();
    }
    function applySnapshot(s) {
      var o = JSON.parse(s);
      var before = JSON.stringify(state.background);
      background0 = o.background0;
      state.layers = o.layers;
      state.polygons = o.polygons;
      byLayer = o.byLayer;
      if (state.layer !== 0 && !layerObj(state.layer)) state.layer = 0;
      ctx.stageViewPatch({ background: background0, layers: state.layers, polygons: state.polygons });
      stageAll(["allPlacements"]);
      paintLayerCtl();
      if (adjust) endAdjust();
      if (JSON.stringify(state.background) !== before) buildMap(); else drawAll();
      restageAllCodes();
      ctx.refreshSidebar();
      ctx.historyChanged();
    }
    function resetHistory() {
      state.history = { entries: [snapshot()], index: 0 };
      ctx.historyChanged();
    }

    function paintDragging() {
      Object.keys(markers).forEach(function (id) {
        var m = markers[id];
        if (!m.dragging) return;
        if (state.editing && layerOfDevice(id) === state.layer) m.dragging.enable(); else m.dragging.disable();
      });
    }
    function setEditing(on) {
      state.editing = !!on;
      if (viewLayer) { viewLayer = null; applyBaseLayer(); }
      paintDragging();
      if (!on && drawHandler) { try { drawHandler.disable(); } catch (e) {} drawHandler = null; }
      if (!on) { endAdjust(); linkSel = null; clearHandles(); }
      host.classList.toggle("is-editing", !!on);
      if (on) resetHistory();
      paintLayerCtl();
    }

    // The details pane: what can be dragged on and what is already placed.
    // ── Floor layers (rule 152) ─────────────────────────────────────────
    // Layer 0 is the flat view. + / − step through the listed layers; while
    // editing, stepping past the last one offers to add a layer there.
    var layerCtl = document.createElement("div");
    layerCtl.className = "topo-layer-ctl";
    layerCtl.setAttribute("role", "group");
    layerCtl.setAttribute("aria-label", "Floor layer");
    host.appendChild(layerCtl);
    function levels() { return [0].concat(state.layers.map(function (l) { return l.level; })).sort(function (a, b) { return a - b; }); }
    // Rule 168: a floor is its number; its name is a label ("-1 Basement").
    function layerName(level) { var l = layerObj(level); return level === 0 ? "Ground" : (l && l.name ? l.name : "Floor " + level); }
    function countOn(level) { return Object.keys(placementsOf(level)).filter(function (id) { return nodeById[id]; }).length; }
    function paintLayerCtl() {
      var lv = levels();
      var i = lv.indexOf(state.layer);
      var canUp = i < lv.length - 1 || state.editing;
      var canDown = i > 0 || state.editing;
      var n = countOn(state.layer);
      layerCtl.innerHTML =
        '<span class="topo-layer-cap">Floor</span>' +
        '<button type="button" class="btn btn-secondary btn-sm topo-layer-step" data-layer-step="1"' + (canUp ? "" : " disabled") + ' aria-label="Up a layer">+</button>' +
        '<span class="topo-layer-now" aria-live="polite"' + (state.editing && state.layer !== 0 ? ' title="Right-click to rename or delete this layer"' : "") + '>' +
          '<strong>' + state.layer + '</strong><span>' + esc(layerName(state.layer)) + '</span><span class="topo-layer-n">' + n + ' device' + (n === 1 ? "" : "s") + '</span></span>' +
        '<button type="button" class="btn btn-secondary btn-sm topo-layer-step" data-layer-step="-1"' + (canDown ? "" : " disabled") + ' aria-label="Down a layer">−</button>' +
        (state.layer !== 0 ? '<button type="button" class="btn btn-secondary btn-sm topo-layer-zero" data-layer-zero>Ground</button>' : "");
    }
    function setLayer(level) {
      if (level === state.layer) return;
      endAdjust();
      linkSel = null;
      clearHandles();
      var from = state.layer;
      state.layer = level;
      selectedId = null;
      if (map) {
        if (!floorPanes[level]) drawFloor(level);
        paintDragging();
        trans = { from: from, t0: performance.now() };
        applyFloorLook(true);
        requestAnimationFrame(tickCross);
      }
      paintLayerCtl();
      paintCenter();
      ctx.refreshSidebar();
    }
    layerCtl.addEventListener("click", function (e) {
      if (e.target.closest("[data-layer-zero]")) { setLayer(0); return; }
      var step = e.target.closest("[data-layer-step]");
      if (!step) return;
      var dir = Number(step.getAttribute("data-layer-step"));
      var lv = levels();
      var i = lv.indexOf(state.layer);
      var next = lv[i + dir];
      if (next !== undefined) { setLayer(next); return; }
      if (state.editing) addLayer(dir > 0 ? lv[lv.length - 1] + 1 : lv[0] - 1);
    });
    layerCtl.addEventListener("contextmenu", function (e) {
      if (!state.editing || state.layer === 0 || !e.target.closest(".topo-layer-now") || typeof showRowMenu !== "function") return;
      e.preventDefault();
      var level = state.layer;
      showRowMenu(e.target.closest(".topo-layer-now"), [
        { heading: layerName(level) },
        { label: "Rename", onSelect: function () { nameLayer(level, false); } },
        { label: "Delete layer", danger: true, onSelect: function () { deleteLayer(level); } },
      ], { menuAt: { x: e.clientX, y: e.clientY }, label: "Layer", overMap: true });
    });
    function addLayer(level) { nameLayer(level, true); }
    function nameLayer(level, isNew) {
      if (typeof buildOverlay !== "function") return;
      var l = layerObj(level);
      var body = '<div class="form-group"><label for="tl-name">Name (optional)</label>' +
        '<input id="tl-name" type="text" maxlength="64" placeholder="e.g. ' + (level < 0 ? "Basement" : "Mezzanine") + '" value="' + esc(isNew ? "" : (l ? l.name : "")) + '">' +
        '<div class="hint">Floor ' + level + '. A device placed on it gets <code>f:' + level + '</code> when you save; the name is only a label.</div></div>';
      var footer = '<button type="button" class="btn btn-secondary" data-tl="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-tl="ok">' + (isNew ? "Add layer" : "Apply") + '</button>';
      var dlg = buildOverlay(1100, isNew ? "Add layer " + level : "Rename layer " + level, body, footer);
      var input = dlg.overlay.querySelector("#tl-name");
      function apply() {
        var name = input.value.trim().replace(/\s+/g, " ");
        if (/(?:^|\s)(?:jb|ra|a|b|f|r):/i.test(name)) { ctx.toast("A floor name can't contain another location code", "error"); return; }
        var clash = name && state.layers.some(function (x) { return x.level !== level && (x.name || "").toLowerCase() === name.toLowerCase(); });
        if (clash) { ctx.toast("Another layer is already called " + name, "error"); return; }
        if (isNew) state.layers.push({ level: level, name: name, background: null });
        else if (l) l.name = name;
        state.layers.sort(function (a, b) { return a.level - b.level; });
        dlg.close();
        changed("layers");
        if (isNew) setLayer(level); else { paintLayerCtl(); Object.keys(state.placements).forEach(stageCodesFor); }
      }
      dlg.overlay.querySelector('[data-tl="cancel"]').addEventListener("click", dlg.close);
      dlg.overlay.querySelector('[data-tl="ok"]').addEventListener("click", apply);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); apply(); } });
      setTimeout(function () { try { input.focus(); input.select(); } catch (_) { /* closed */ } }, 0);
    }
    async function deleteLayer(level) {
      var n = countOn(level), polys = state.polygons.filter(function (q) { return (q.layer || 0) === level; }).length;
      var what = [n ? n + " placed device" + (n === 1 ? "" : "s") : "", polys ? polys + " polygon" + (polys === 1 ? "" : "s") : ""].filter(Boolean).join(" and ");
      var ok = typeof showConfirm === "function"
        ? await showConfirm("Delete " + layerName(level) + (what ? " and its " + what : "") + "? Codes already written to descriptions are not changed.")
        : false;
      if (!ok) return;
      Object.keys(placementsOf(level)).forEach(function (id) { ctx.stageLocationCode(nodeById[id] ? (nodeById[id].assetId || id) : id, null); });
      byLayer[level] = {};
      ctx.stagePlacements({}, level);
      state.polygons = state.polygons.filter(function (q) { return (q.layer || 0) !== level; });
      state.layers = state.layers.filter(function (x) { return x.level !== level; });
      state.layer = 0;
      changed("layers", "polygons");
      drawAll();
      paintLayerCtl();
      ctx.refreshSidebar();
    }

    // The details pane's Device List (topology-device-list.js): every shown
    // device, the ones on the map highlighted with an × to take them off.
    function sidebarHtml() {
      var DL = window.PolarisTopologyDeviceList;
      if (!DL) return "";
      var rows = Object.keys(nodeById).map(function (id) {
        var d = nodeById[id];
        var t = R.nodeAssetType(d) || "";
        var codes = currentCodes[id];
        var on = layerOfDevice(id);
        return {
          id: id,
          label: d.label || id,
          // A device on ANOTHER layer says which; selecting it goes there.
          meta: on !== null && on !== state.layer ? (on === 0 ? "floor 0 · ground" : "floor " + on + (layerObj(on) && layerObj(on).name ? " · " + layerObj(on).name : ""))
            : hasCodes(codes) ? codesLabel(codes) : String(t).replace(/_/g, " "),
          inUse: on === state.layer,
          title: on !== null && on !== state.layer ? "Placed on floor " + on : "",
        };
      }).sort(function (a, b) {
        return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: "base" });
      });
      return DL.html({
        title: "Device List",
        hint: state.editing ? "Drag device from list to map." : "Edit the map to place devices.",
        rows: rows,
        editing: state.editing,
        filter: listFilter,
        selectedId: selectedId,
        removeLabel: "Remove from the map",
      });
    }
    function wireSidebar(pane) {
      var DL = window.PolarisTopologyDeviceList;
      if (!pane || !DL) return;
      DL.wire(pane, {
        dragMime: DRAG_MIME,
        onFilter: function (f) { listFilter = f; },
        onRemove: function (id) { if (state.editing && state.placements[id]) removePlacement(id); },
        onSelect: function (id) {
          var on = layerOfDevice(id);
          if (on !== null && on !== state.layer) setLayer(on);
          select(id);
          // A placed device is brought into view; one not on the map just
          // fills the info card.
          if (markers[id] && map) map.panTo(markers[id].getLatLng());
        },
      });
    }

    function onKey(e) {
      if (e.key === "Escape" && drawHandler) { try { drawHandler.disable(); } catch (x) {} drawHandler = null; }
      if (e.key === "Escape" && adjust) endAdjust();
    }
    document.addEventListener("keydown", onKey);

    host.appendChild(centerMark);
    buildMap();
    setEditing(state.editing);
    // Leaflet measures its container on creation; the modal may still be
    // animating in.
    setTimeout(function () { if (map) map.invalidateSize(); }, 60);

    return {
      mode: "topology",
      setEditing: setEditing,
      sidebarHtml: sidebarHtml,
      wireSidebar: wireSidebar,
      // The devices on the map — map.js lists only these under the info card.
      placedIds: function () {
        var o = {};
        Object.keys(byLayer).forEach(function (k) { Object.keys(byLayer[k]).forEach(function (id) { if (id.indexOf("edgepath:") !== 0) o[id] = true; }); });
        return o;
      },
      setSelected: function (id) { selectedId = id || null; paintSelected(); },
      // The Delete key (map.js): the selected placed device comes off the map.
      deleteSelected: function () {
        if (deleteSelectedHandle()) return true;
        if (!state.editing || !selectedId || !state.placements[selectedId]) return false;
        var id = selectedId;
        select(null);
        removePlacement(id);
        return true;
      },
      beforeCommit: captureOsmView,
      cornerButtons: function () {
        return [
          { id: "topology-background", label: "Background", tip: "Choose the map or upload a floor-plan image",
            icon: '<polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/>',
            onClick: openBackgroundMenu, editOnly: true },
          { id: "topology-draw-polygon", label: "Draw polygon", tip: "Draw a polygon for a location group",
            icon: '<polygon points="12 2 22 9 18 21 6 21 2 9 12 2"/>', onClick: startDrawing, editOnly: true },
        ];
      },
      canUndo: function () { return state.history.index > 0; },
      canRedo: function () { return state.history.index < state.history.entries.length - 1; },
      undo: function () { if (state.history.index > 0) { state.history.index--; applySnapshot(state.history.entries[state.history.index]); } },
      redo: function () {
        if (state.history.index < state.history.entries.length - 1) { state.history.index++; applySnapshot(state.history.entries[state.history.index]); }
      },
      resize: function () { if (map) map.invalidateSize(); },
      captureElement: function () { return mapEl; },
      destroy: function () {
        endAdjust();
        document.removeEventListener("keydown", onKey);
        if (drawHandler) { try { drawHandler.disable(); } catch (e) {} }
        if (map) { map.remove(); map = null; }
      },
    };
  }

  window.PolarisTopologyPhysical = {
    render: render,
    // Pure helpers, exported for tests.
    _pointInRing: pointInRing,
    _innermostPolygon: innermostPolygon,
    _polyCodes: polyCodes,
    _planToGround: planToGround,
    _groundToPlan: groundToPlan,
    _floorLook: floorLook,
    _fadeSteps: fadeSteps,
    _convexHull: convexHull,
    _roundedHull: roundedHull,
    _groupsFromData: groupsFromData,
    _codesLabel: codesLabel,
    _codesEqual: codesEqual,
  };
})();
