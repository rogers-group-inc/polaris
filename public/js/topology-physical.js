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
    { field: "junctionBox", key: "jb", kind: "jb", word: "Junction box" },
  ];
  var TYPE_INITIALS = { firewall: "FW", switch: "SW", access_point: "AP", router: "RT", server: "SV", workstation: "PC", printer: "PR" };

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s))
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }
  function emptyCodes() { return { area: null, building: null, floor: null, room: null, junctionBox: null }; }
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
      background: staged.background !== undefined ? staged.background : (view.background || null),
      polygons: (staged.polygons || view.polygons || []).map(function (p) {
        return { id: p.id, codes: normCodes(p.codes), points: p.points.map(function (q) { return [q[0], q[1]]; }) };
      }),
      placements: Object.assign({}, ctx.loadPlacements() || {}),
      history: { entries: [], index: -1 },
    };

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
    var polygonLayer = null, linkLayer = null, markerLayer = null;
    var markers = {};       // nodeId → L.marker
    var linkLines = {};     // edge id → L.polyline
    var polygonShapes = {}; // polygon id → L.polygon
    var drawHandler = null;
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
            if (b) setLayer(b.getAttribute("data-layer"));
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
    function setLayer(layer) {
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

    function buildMap() {
      if (map) { map.remove(); map = null; }
      baseLayer = null; layerSwitch = null;
      markers = {}; linkLines = {}; polygonShapes = {};
      var bg = state.background;
      if (bg && bg.kind === "image") {
        map = L.map(mapEl, { crs: L.CRS.Simple, minZoom: -5, maxZoom: 5, zoomSnap: 0.25, attributionControl: false });
        var m = Math.max(bg.width || 1, bg.height || 1);
        var w = IMAGE_EXTENT * (bg.width || 1) / m;
        var h = IMAGE_EXTENT * (bg.height || 1) / m;
        var bounds = [[0, 0], [h, w]];
        L.imageOverlay(ctx.backgroundUrl(bg.imageId), bounds).addTo(map);
        map.fitBounds(bounds, { padding: [20, 20] });
        map.setMaxBounds(L.latLngBounds([[-h, -w], [2 * h, 2 * w]]));
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
      polygonLayer = L.featureGroup().addTo(map);
      linkLayer = L.layerGroup().addTo(map);
      markerLayer = L.layerGroup().addTo(map);
      drawPolygons();
      drawMarkers();
      drawLinks();
      wireDrop();
    }

    // ── Polygons ────────────────────────────────────────────────────────
    function polygonColor(p) {
      var f = deepestField(p.codes);
      return R.locGroupColor(f ? f.kind : "building", family());
    }
    function drawPolygons() {
      polygonLayer.clearLayers();
      polygonShapes = {};
      state.polygons.forEach(function (p) {
        var color = polygonColor(p);
        var dashed = (deepestField(p.codes) || {}).kind === "floor" || (deepestField(p.codes) || {}).kind === "jb";
        var shape = L.polygon(p.points.map(function (q) { return [q[1], q[0]]; }), {
          color: color, weight: 2, fillColor: color, fillOpacity: 0.12, dashArray: dashed ? "6 4" : null,
        });
        shape.bindTooltip(esc(groupName(p.codes)) + ' <span class="topo-phys-codes">' + esc(codesLabel(p.codes)) + '</span>',
          { permanent: true, direction: "center", className: "topo-phys-polygon-label" });
        shape.on("click", function (e) {
          if (!state.editing) return;
          L.DomEvent.stopPropagation(e);
          openPolygonMenu(p, e.originalEvent, shape.getElement());
        });
        shape.addTo(polygonLayer);
        polygonShapes[p.id] = shape;
      });
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
        p.points = ring.map(function (ll) { return [ll.lng, ll.lat]; });
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
          var ring = (e.layer.getLatLngs()[0] || []).map(function (ll) { return [ll.lng, ll.lat]; });
          drawHandler = null;
          if (ring.length < 3) return;
          state.polygons.push({ id: newId("poly"), codes: codes, points: ring });
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
      var groups = groupsFromData(data);
      state.polygons.forEach(function (p) {
        if (!groups.some(function (g) { return codesEqual(g, p.codes); })) groups.push(normCodes(p.codes));
      });
      groups.sort(function (a, b) { return codesKey(a).localeCompare(codesKey(b)); });
      var drawn = {};
      state.polygons.forEach(function (p) { drawn[codesKey(p.codes)] = true; });
      var rows = groups.map(function (g, i) {
        var f = deepestField(g);
        var color = R.locGroupColor(f ? f.kind : "building", family());
        var checked = current ? codesEqual(current, g) : i === 0;
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
        '<p class="hint" style="margin:0 0 8px">Groups come from the location codes in device descriptions (the Layer 2 boxes). A device dropped inside the polygon takes these codes when you save.</p>' +
        '<div class="topo-phys-groups">' + (rows || '<p class="hint">No device has location codes yet — make a new group below.</p>') + '</div>' +
        '<label class="topo-phys-group topo-phys-group-new"><input type="radio" name="topo-pg" value="new"' + (groups.length ? "" : " checked") + '> <strong>New group</strong></label>' +
        '<div class="topo-phys-new" style="display:grid;grid-template-columns:150px 1fr;gap:8px;margin-top:6px">' +
          '<select id="topo-pg-kind" aria-label="Kind">' + CODE_FIELDS.map(function (f) { return '<option value="' + f.field + '">' + f.word + '</option>'; }).join("") + '</select>' +
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
          if (/(?:^|\s)(?:jb|a|b|f|r):/i.test(name)) { ctx.toast("A group name can't contain another location code", "error"); return; }
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
    function drawMarkers() {
      markerLayer.clearLayers();
      markers = {};
      Object.keys(state.placements).forEach(function (id) {
        if (!nodeById[id]) return;
        addMarker(id);
      });
    }
    function addMarker(id) {
      var d = nodeById[id];
      var p = state.placements[id];
      if (!d || !p) return;
      var m = L.marker([p.y, p.x], {
        icon: L.divIcon({ className: "topo-phys-marker", html: iconHtml(d), iconSize: [34, 34], iconAnchor: [17, 17] }),
        draggable: state.editing,
        keyboard: false,
        title: d.label || "",
      });
      m.on("drag", function () { var ll = m.getLatLng(); state.placements[id] = { x: ll.lng, y: ll.lat }; drawLinksFor(id); });
      m.on("dragend", function () {
        var ll = m.getLatLng();
        state.placements[id] = { x: ll.lng, y: ll.lat };
        changed("placements");
        stageCodesFor(id);
        drawLinksFor(id);
      });
      m.on("dblclick", function () { ctx.openAsset(d.assetId || id); });
      m.on("contextmenu", function (e) {
        if (!state.editing || typeof showRowMenu !== "function") return;
        showRowMenu(m.getElement() || e.originalEvent.target, [
          { heading: d.label || "Device" },
          { label: "Open", onSelect: function () { ctx.openAsset(d.assetId || id); } },
          { label: "Remove from map", danger: true, onSelect: function () { removePlacement(id); } },
        ], { menuAt: { x: e.originalEvent.clientX, y: e.originalEvent.clientY }, label: "Device", overMap: true });
      });
      m.addTo(markerLayer);
      markers[id] = m;
    }
    function place(id, latlng) {
      if (!state.editing || !nodeById[id]) return;
      state.placements[id] = { x: latlng.lng, y: latlng.lat };
      if (markers[id]) markers[id].setLatLng(latlng); else addMarker(id);
      changed("placements");
      stageCodesFor(id);
      drawLinksFor(id);
      ctx.refreshSidebar();
    }
    // Removing a placement never touches codes (rule 148) — but a change
    // this session staged for it no longer has a drop behind it.
    function removePlacement(id) {
      delete state.placements[id];
      if (markers[id]) { markerLayer.removeLayer(markers[id]); delete markers[id]; }
      ctx.stageLocationCode(nodeById[id] ? (nodeById[id].assetId || id) : id, null);
      changed("placements");
      drawLinksFor(id);
      ctx.refreshSidebar();
    }
    // Rule 148: inside a polygon → that group's codes (when they differ);
    // outside every polygon → nothing staged for this device.
    function stageCodesFor(id) {
      var d = nodeById[id];
      var p = state.placements[id];
      if (!d || !p) return;
      var assetId = d.assetId || id;
      var poly = innermostPolygon(state.polygons, [p.x, p.y]);
      if (!poly || codesEqual(poly.codes, currentCodes[id])) { ctx.stageLocationCode(assetId, null); return; }
      ctx.stageLocationCode(assetId, normCodes(poly.codes), {
        name: d.label || assetId,
        from: currentCodes[id] || emptyCodes(),
      });
    }
    function restageAllCodes() { Object.keys(state.placements).forEach(stageCodesFor); }

    // ── Links ───────────────────────────────────────────────────────────
    function lineFor(e) {
      var a = state.placements[e.source], b = state.placements[e.target];
      if (!a || !b || !nodeById[e.source] || !nodeById[e.target]) return null;
      var st = R.edgeLineStyle(e, family());
      var line = L.polyline([[a.y, a.x], [b.y, b.x]], { color: st.color, weight: st.width, dashArray: st.dash, interactive: true });
      var tip = (e.label ? esc(e.label) : "") + (e.reason ? '<div class="topo-phys-tip">' + esc(e.reason) + '</div>' : "");
      if (tip) line.bindTooltip(tip, { sticky: true });
      return line;
    }
    function drawLinks() {
      linkLayer.clearLayers();
      linkLines = {};
      edges.forEach(function (e) {
        var line = lineFor(e);
        if (line) { line.addTo(linkLayer); linkLines[e.id] = line; }
      });
    }
    function drawLinksFor(id) {
      (edgesByNode[id] || []).forEach(function (e) {
        if (linkLines[e.id]) { linkLayer.removeLayer(linkLines[e.id]); delete linkLines[e.id]; }
        var line = lineFor(e);
        if (line) { line.addTo(linkLayer); linkLines[e.id] = line; }
      });
    }

    // ── Drag in from the details pane ───────────────────────────────────
    function wireDrop() {
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
    function hasDrawing() { return state.polygons.length > 0 || Object.keys(state.placements).length > 0; }
    async function confirmClear(kindWord) {
      if (!hasDrawing()) return true;
      return typeof showConfirm === "function"
        ? showConfirm("Changing to " + kindWord + " clears the polygons and device placements drawn on the current background. Continue?")
        : false;
    }
    function clearDrawing() {
      Object.keys(state.placements).forEach(function (id) { ctx.stageLocationCode(nodeById[id] ? (nodeById[id].assetId || id) : id, null); });
      state.placements = {};
      state.polygons = [];
    }
    function openBackgroundMenu(anchor) {
      if (!state.editing || typeof showRowMenu !== "function") return;
      // One corner popover at a time: the menu drawn over the open Mouse
      // controls panel read as two-tone glass.
      if (typeof ctx.closePopovers === "function") ctx.closePopovers();
      var bg = state.background;
      var isImage = bg && bg.kind === "image";
      showRowMenu(anchor, [
        { heading: "Background" },
        { label: (isImage ? "" : "✓ ") + "OpenStreetMap", onSelect: async function () {
          if (!isImage) return;
          if (!(await confirmClear("the map"))) return;
          clearDrawing();
          state.background = null;
          changed("background", "polygons", "placements");
          buildMap();
          ctx.refreshSidebar();
        } },
        { label: isImage ? "Replace image" : "Upload image", onSelect: function () { chooseImage(); } },
      ], { label: "Background", align: "end", overMap: true });
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
          changed("background", "polygons", "placements");
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
      return JSON.stringify({ background: state.background, polygons: state.polygons, placements: state.placements });
    }
    function stageAll(fields) {
      fields.forEach(function (f) {
        if (f === "polygons") ctx.stageViewPatch({ polygons: state.polygons });
        if (f === "background") ctx.stageViewPatch({ background: state.background });
        if (f === "placements") ctx.stagePlacements(Object.assign({}, state.placements));
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
    }
    function applySnapshot(s) {
      var o = JSON.parse(s);
      var bgChanged = JSON.stringify(o.background) !== JSON.stringify(state.background);
      state.background = o.background;
      state.polygons = o.polygons;
      state.placements = o.placements;
      stageAll(["background", "polygons", "placements"]);
      if (bgChanged) buildMap(); else { drawPolygons(); drawMarkers(); drawLinks(); }
      restageAllCodes();
      ctx.refreshSidebar();
      ctx.historyChanged();
    }
    function resetHistory() {
      state.history = { entries: [snapshot()], index: 0 };
      ctx.historyChanged();
    }

    function setEditing(on) {
      state.editing = !!on;
      if (viewLayer) { viewLayer = null; applyBaseLayer(); }
      Object.keys(markers).forEach(function (id) {
        var m = markers[id];
        if (m.dragging) { if (on) m.dragging.enable(); else m.dragging.disable(); }
      });
      if (!on && drawHandler) { try { drawHandler.disable(); } catch (e) {} drawHandler = null; }
      host.classList.toggle("is-editing", !!on);
      if (on) resetHistory();
    }

    // The details pane: what can be dragged on and what is already placed.
    function sidebarHtml() {
      var ids = Object.keys(nodeById);
      var placed = ids.filter(function (id) { return state.placements[id]; });
      var free = ids.filter(function (id) { return !state.placements[id]; });
      function row(id, isPlaced) {
        var d = nodeById[id];
        var t = R.nodeAssetType(d) || "";
        var codes = currentCodes[id];
        var meta = hasCodes(codes) ? codesLabel(codes) : (TYPE_INITIALS[t] ? t.replace(/_/g, " ") : t);
        return '<li class="topo-phys-row' + (isPlaced ? " is-placed" : "") + '"' +
          (!isPlaced && state.editing ? ' draggable="true" data-place-asset="' + esc(id) + '"' : "") + '>' +
          '<span class="topo-phys-grip" aria-hidden="true">' + (isPlaced ? "✓" : "⋮⋮") + '</span>' +
          '<span class="topo-phys-row-name">' + esc(d.label || id) + '</span>' +
          '<span class="meta">' + esc(meta) + '</span></li>';
      }
      var hint = state.editing
        ? "Drag a device onto the map. Inside a group polygon it takes that group's location codes when you save; outside every polygon its codes are left as they are."
        : "Edit the map to place devices.";
      return '<div class="topology-section topo-phys-side"><h5>Not placed (' + free.length + ')</h5>' +
        '<p class="topology-type-hint" style="margin:0 0 6px">' + esc(hint) + '</p>' +
        '<ul>' + (free.map(function (id) { return row(id, false); }).join("") || '<li class="muted">Every shown device is placed.</li>') + '</ul></div>' +
        '<div class="topology-section topo-phys-side"><h5>Placed (' + placed.length + ')</h5><ul>' +
        (placed.map(function (id) { return row(id, true); }).join("") || '<li class="muted">Nothing placed yet.</li>') + '</ul></div>';
    }
    // Wire the pane's drag rows (map.js re-renders the pane, then calls this).
    function wireSidebar(pane) {
      if (!pane) return;
      pane.querySelectorAll("[data-place-asset]").forEach(function (li) {
        li.addEventListener("dragstart", function (e) {
          e.dataTransfer.setData(DRAG_MIME, li.getAttribute("data-place-asset"));
          e.dataTransfer.effectAllowed = "move";
        });
      });
    }

    function onKey(e) {
      if (e.key === "Escape" && drawHandler) { try { drawHandler.disable(); } catch (x) {} drawHandler = null; }
    }
    document.addEventListener("keydown", onKey);

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
    _groupsFromData: groupsFromData,
    _codesLabel: codesLabel,
    _codesEqual: codesEqual,
  };
})();
