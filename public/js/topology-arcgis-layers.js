/**
 * public/js/topology-arcgis-layers.js — ArcGIS feature layers on the Device
 * Map topology's Topology canvas (business rule 188), read only.
 *
 *   window.PolarisTopologyArcgisLayers.create(opts) → layer
 *
 * Polaris never writes to ArcGIS. An ArcGIS integration lists the feature
 * layers it reads. Rule 188(c): a Topology view draws every layer whose area
 * covers the map in view (a layer with no known area counts as everywhere),
 * and stores only what it HIDES — a layer, or one of a by-type layer's types
 * (rule 188(b)) — in the eye menu's "ArcGIS layers" section (topology-physical.js
 * draws it from `layerList` / `notHere` / `brokenCount`), so a layer or type
 * added later shows by itself. Pointing at a feature says what it is (its
 * type, its label, its layer). Features are asked
 * for as the map moves (the server holds the ArcGIS token and answers only
 * the features inside the viewport), drawn on floor 0's ground over the map
 * or satellite — never over an uploaded plan, whose coordinates are not
 * latitude / longitude. A click opens a card with the layer's chosen fields.
 *
 * Rule 188(a): it also holds which ArcGIS LINES each device link rides
 * (`links`, path key → ordered references `<layerId>/<featureId>`). The canvas
 * routes the link through them (cable-run-geometry.js), asks `hitRun` while a
 * link is dragged, and calls `setLinkRuns`; the change is staged through
 * `stageLinks` and sent when the edit session commits. A line that is no
 * longer in ArcGIS is skipped: the link goes straight again and the Map
 * layers card says how many connections lost one.
 *
 * opts: {
 *   L, map(), pane() → {name, renderer}, editing(), visible(),
 *   fetchLayers() → Promise<{layers}>, fetchFeatures(layerId, params) → Promise<{features, truncated}>,
 *   fetchLinks() → Promise<{links}>, hidden() → keys, setHidden(keys), canSaveShown(), onCoverChange(),
 *   stageLinks(changes), onRoutesChanged(), describeLink(pathKey), onChange(), toast(msg, kind),
 * }
 */
(function () {
  "use strict";

  var EARTH_RADIUS_M = 6371008.8;
  var LABEL_ZOOM = 17;
  var MAX_LABELS = 200;
  var MOVE_DEBOUNCE_MS = 250;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  /** Ground length in metres, 2D. */
  function lengthM(points) {
    var total = 0;
    for (var i = 1; i < points.length; i++) {
      var p1 = points[i - 1], p2 = points[i];
      var f1 = p1[1] * Math.PI / 180, f2 = p2[1] * Math.PI / 180;
      var df = f2 - f1, dl = (p2[0] - p1[0]) * Math.PI / 180;
      var a = Math.pow(Math.sin(df / 2), 2) + Math.cos(f1) * Math.cos(f2) * Math.pow(Math.sin(dl / 2), 2);
      total += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
    }
    return total;
  }
  function lengthText(m) { return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m"; }

  /**
   * Which links' routes one edit session changed: `{ pathKey: refs }`, an
   * empty list for a link made straight again (rule 188(a)).
   */
  function diffLinks(loaded, current) {
    var out = {};
    var keys = {};
    Object.keys(loaded || {}).forEach(function (k) { keys[k] = true; });
    Object.keys(current || {}).forEach(function (k) { keys[k] = true; });
    Object.keys(keys).forEach(function (k) {
      var a = (loaded && loaded[k]) || [], b = (current && current[k]) || [];
      if (JSON.stringify(a) !== JSON.stringify(b)) out[k] = b.slice();
    });
    return out;
  }

  /** A line feature's paths joined into one polyline (multi-part lines are rare). */
  function featurePoints(f) {
    var out = [];
    (f.g || []).forEach(function (path) { path.forEach(function (p) { out.push([p[0], p[1]]); }); });
    return out;
  }

  /** A feature reference: `<layerId>/<featureId>`. */
  function refOf(layerId, featureId) { return layerId + "/" + featureId; }
  function splitRef(ref) {
    var at = ref.indexOf("/");
    return at < 0 ? null : { layerId: ref.slice(0, at), featureId: ref.slice(at + 1) };
  }

  function create(opts) {
    var L = opts.L;
    var layers = [];             // configured layers (no URLs, no tokens)
    var byLayer = {};            // layerId → { ref → feature } in view
    var pinned = {};             // ref → feature fetched by id (routed links outside the view)
    var missing = {};            // ref → true: asked for by id and not found
    var truncated = {};          // layerId → true when the viewport held more than the server sent
    var loadedLinks = {};        // path key → refs, as the server last answered
    var links = {};              // working copy
    var targetKey = null;        // the line a dragged link is over (highlighted)
    var group = null;
    var shapes = {};             // ref → L.polyline (lines only)
    var drawnOn = null;
    var legend = null;
    var moveTimer = null;
    var reqSeq = 0;
    var typeIndex = {};          // layerId → { String(value) → type entry } (by-type layers)
    var coverSig = "";           // the covering layers last reported (onCoverChange)
    var shapeWidth = {};         // ref → the line's own width (highlight restores it)

    function layerById(id) { for (var i = 0; i < layers.length; i++) if (layers[i].id === id) return layers[i]; return null; }
    function hiddenSet() {
      var h = {};
      (opts.hidden ? opts.hidden() || [] : []).forEach(function (k) { h[k] = true; });
      return h;
    }
    function isHidden(id) { return !!hiddenSet()[id]; }
    /** Rule 188(c): does a layer's area overlap the map in view? No known area = everywhere. */
    function covers(l, b) {
      if (!b || !Array.isArray(l.extent) || l.extent.length !== 4) return true;
      return !(l.extent[2] < b.getWest() || l.extent[0] > b.getEast() || l.extent[3] < b.getSouth() || l.extent[1] > b.getNorth());
    }
    function covering() {
      var map = opts.map();
      var b = map ? map.getBounds() : null;
      return layers.filter(function (l) { return covers(l, b); });
    }
    /** The layers drawn now: covering the map and not hidden by the view. */
    function shownIds() {
      var h = hiddenSet();
      return covering().filter(function (l) { return !h[l.id]; }).map(function (l) { return l.id; });
    }
    function isShown(id) { return shownIds().indexOf(id) !== -1; }

    // ── Types (rule 188(b)) ──────────────────────────────────────────────
    function indexTypes() {
      typeIndex = {};
      layers.forEach(function (l) {
        if (!l.types) return;
        var m = {};
        (l.types.values || []).forEach(function (v) { m[String(v.value)] = v; });
        typeIndex[l.id] = m;
      });
    }
    /** The listed type a feature's value belongs to, or null for the other-types bucket. */
    function typeOf(l, ft) {
      var m = typeIndex[l.id];
      return m && ft.t !== null && ft.t !== undefined ? m[String(ft.t)] || null : null;
    }
    function typeKey(l, entry) { return entry ? l.id + ":" + String(entry.value) : l.id + "#other"; }
    function featureShown(l, ft, h) {
      if (!l.types) return true;
      var e = typeOf(l, ft);
      if (!e && !(l.types.other && l.types.other.on)) return false;
      return !(h || hiddenSet())[typeKey(l, e)];
    }
    /** A by-type feature's own style, or null for a layer drawn in one style. */
    function typeStyle(l, ft) {
      if (!l.types) return null;
      var e = typeOf(l, ft);
      return e ? e.style : l.types.other.style;
    }
    /** The types a by-type layer can draw: its ticked types, then the other bucket when it is ticked. */
    function typeRows(l) {
      if (!l.types) return [];
      var rows = (l.types.values || []).map(function (v) { return { key: typeKey(l, v), label: v.label || String(v.value), style: v.style }; });
      if (l.types.other && l.types.other.on) rows.push({ key: typeKey(l, null), label: "Other types", style: l.types.other.style });
      return rows;
    }
    function feature(ref) {
      var r = splitRef(ref);
      if (!r) return null;
      return (byLayer[r.layerId] && byLayer[r.layerId][ref]) || pinned[ref] || null;
    }
    function cloneLinks(o) {
      var out = {};
      Object.keys(o || {}).forEach(function (k) { if (o[k] && o[k].length) out[k] = o[k].slice(); });
      return out;
    }
    function stage() { if (opts.stageLinks) opts.stageLinks(diffLinks(loadedLinks, links)); }
    function routesChanged() { if (opts.onRoutesChanged) opts.onRoutesChanged(); }

    // ── Loading ─────────────────────────────────────────────────────────
    function load() {
      return Promise.all([
        opts.fetchLayers().catch(function () { return { layers: [] }; }),
        opts.fetchLinks().catch(function () { return { links: {} }; }),
      ]).then(function (res) {
        layers = (res[0] && res[0].layers) || [];
        indexTypes();
        loadedLinks = cloneLinks(res[1] && res[1].links);
        links = cloneLinks(loadedLinks);
        missing = {};
        return refresh();
      });
    }

    /** Fetch every shown layer's features in view, then any routed line still unknown. */
    function refresh() {
      var map = opts.map();
      if (!map || !opts.visible()) { draw(); return Promise.resolve(); }
      var b = map.getBounds();
      var bbox = [Math.max(-180, b.getWest()), Math.max(-90, b.getSouth()), Math.min(180, b.getEast()), Math.min(90, b.getNorth())]
        .map(function (v) { return v.toFixed(6); }).join(",");
      var zoom = Math.round(map.getZoom());
      var seq = ++reqSeq;
      var ids = shownIds();
      return Promise.all(ids.map(function (id) {
        return opts.fetchFeatures(id, { bbox: bbox, zoom: String(zoom) }).then(function (res) {
          return { id: id, res: res };
        }, function (err) {
          return { id: id, err: err };
        });
      })).then(function (results) {
        if (seq !== reqSeq) return null;
        var failed = [];
        byLayer = {};
        truncated = {};
        results.forEach(function (r) {
          if (r.err) { failed.push(layerById(r.id) ? layerById(r.id).title : r.id); return; }
          var m = {};
          ((r.res && r.res.features) || []).forEach(function (f) { m[refOf(r.id, f.id)] = f; });
          byLayer[r.id] = m;
          if (r.res && r.res.truncated) truncated[r.id] = true;
        });
        if (failed.length) opts.toast("ArcGIS did not answer for " + failed.join(", "), "error");
        return fetchRouted();
      }).then(function () {
        draw();
        routesChanged();
        var sig = covering().map(function (l) { return l.id; }).join(",");
        if (sig !== coverSig) { coverSig = sig; if (opts.onCoverChange) opts.onCoverChange(); }
      });
    }

    /** Routed lines not in view are fetched by id, so every routed link can be drawn. */
    function fetchRouted() {
      var want = {};
      Object.keys(links).forEach(function (k) {
        links[k].forEach(function (ref) {
          if (feature(ref) || missing[ref]) return;
          var r = splitRef(ref);
          if (!r || !layerById(r.layerId)) return;
          (want[r.layerId] = want[r.layerId] || []).push(r.featureId);
        });
      });
      return Promise.all(Object.keys(want).map(function (layerId) {
        var ids = want[layerId].slice(0, 50);
        return opts.fetchFeatures(layerId, { ids: ids.join(",") }).then(function (res) {
          var found = {};
          ((res && res.features) || []).forEach(function (f) { pinned[refOf(layerId, f.id)] = f; found[f.id] = true; });
          ids.forEach(function (id) { if (!found[id]) missing[refOf(layerId, id)] = true; });
        }, function () { /* ArcGIS unreachable: try again on the next move */ });
      }));
    }

    function onMove() {
      if (moveTimer) clearTimeout(moveTimer);
      moveTimer = setTimeout(function () { moveTimer = null; refresh(); }, MOVE_DEBOUNCE_MS);
    }

    // ── Drawing ─────────────────────────────────────────────────────────
    function classes(l, extra) {
      return "topo-arc topo-arc-" + l.geometry + " topo-arc-c-" + ((l.style && l.style.color) || "accent") + (extra ? " " + extra : "");
    }
    function dashOf(l) {
      var d = l.style && l.style.dash;
      return d === "dashed" ? "10 7" : d === "dotted" ? "2 6" : null;
    }
    function widthOf(l) { return Math.max(1, Math.min(8, (l.style && l.style.width) || 3)); }
    var DASH = { dashed: "10 7", dotted: "2 6" };
    /** A by-type feature's colour rides `--arc` on its own element (any #rrggbb, rule 188(b)). */
    function paintTyped(shape, color) {
      shape.on("add", function () {
        var el = shape.getElement && shape.getElement();
        if (el && /^#[0-9a-f]{6}$/i.test(color)) el.style.setProperty("--arc", color);
      });
    }

    function draw() {
      var map = opts.map();
      if (!map) return;
      if (drawnOn !== map) {
        if (drawnOn) drawnOn.off("moveend", onMove);
        group = null; legend = null; drawnOn = map;
        map.on("moveend", onMove);
      }
      if (group) group.clearLayers(); else group = L.layerGroup().addTo(map);
      shapes = {};
      shapeWidth = {};
      var hidden = hiddenSet();
      paintLegend();
      if (!opts.visible()) return;
      var f = opts.pane();
      var labels = 0;
      var showLabels = map.getZoom() >= LABEL_ZOOM;
      shownIds().forEach(function (id) {
        var l = layerById(id);
        var feats = byLayer[id] || {};
        // A viewer may keep a layer's labels hover-only (the eye button).
        var labelsOn = !opts.labelsShown || opts.labelsShown(id);
        Object.keys(feats).forEach(function (ref) {
          var ft = feats[ref];
          if (!featureShown(l, ft, hidden)) return;
          var ts = typeStyle(l, ft);
          var w = ts ? Math.max(1, Math.min(8, ts.width || 3)) : widthOf(l);
          var dash = ts ? DASH[ts.dash] || null : dashOf(l);
          var cls = ts ? "topo-arc topo-arc-" + l.geometry + " topo-arc-typed" : classes(l);
          var shape;
          if (l.geometry === "point") {
            shape = L.circleMarker(L.latLng(ft.g[0][0][1], ft.g[0][0][0]), {
              pane: f.name, renderer: f.renderer, radius: 2 + w, weight: 1.5, className: cls,
            });
          } else if (l.geometry === "area") {
            shape = L.polygon(ft.g.map(function (ring) { return ring.map(function (p) { return L.latLng(p[1], p[0]); }); }), {
              pane: f.name, renderer: f.renderer, weight: w, dashArray: dash, className: cls,
            });
          } else {
            var on = ref === targetKey;
            shape = L.polyline(ft.g.map(function (path) { return path.map(function (p) { return L.latLng(p[1], p[0]); }); }), {
              pane: f.name, renderer: f.renderer, weight: on ? w + 8 : w, dashArray: dash,
              className: cls + (on ? " is-target" : ""), lineCap: "round", lineJoin: "round",
            });
            shapes[ref] = shape;
            shapeWidth[ref] = w;
          }
          if (ts) paintTyped(shape, ts.color);
          shape.on("click", function (e) {
            if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
            openCard(l, ft, ref, e.latlng);
          });
          if (showLabels && labelsOn && ft.label && labels < MAX_LABELS && l.geometry !== "area") {
            labels++;
            shape.bindTooltip(esc(ft.label), { permanent: true, direction: "center", className: "topo-arc-label", opacity: 1 });
          }
          wireHover(shape, l, ft);
          group.addLayer(shape);
        });
      });
    }

    // ── Pointing at a feature says what it is ───────────────────────────
    // One floating tooltip, apart from the permanent label a line may carry
    // when zoomed in (Leaflet gives a shape one bound tooltip).
    var hoverTip = null;
    function hoverHtml(l, ft) {
      var te = l.types ? typeOf(l, ft) : null;
      var kind = l.types ? (te ? te.label || String(te.value) : "Other types") : l.title;
      var ts = typeStyle(l, ft);
      return '<div class="topo-arc-hover">' +
        '<div class="topo-arc-legend-row">' + (ts ? typeSwatch(ts) : swatch(l)) + '<strong>' + esc(kind) + '</strong></div>' +
        (ft.label ? '<div>' + esc(ft.label) + '</div>' : '') +
        (l.types ? '<div class="hint">' + esc(l.title) + '</div>' : '') + '</div>';
    }
    function wireHover(shape, l, ft) {
      shape.on("mouseover", function (e) {
        var map = opts.map();
        if (!map) return;
        if (hoverTip) map.closeTooltip(hoverTip);
        hoverTip = L.tooltip({ direction: "top", offset: [0, -10], className: "topo-arc-hover-tip", opacity: 1 })
          .setLatLng(e.latlng).setContent(hoverHtml(l, ft));
        map.openTooltip(hoverTip);
      });
      shape.on("mousemove", function (e) { if (hoverTip) hoverTip.setLatLng(e.latlng); });
      shape.on("mouseout", function () {
        var map = opts.map();
        if (hoverTip && map) map.closeTooltip(hoverTip);
        hoverTip = null;
      });
    }

    // ── The feature card ────────────────────────────────────────────────
    function ridersOf(ref) { return Object.keys(links).filter(function (k) { return links[k].indexOf(ref) !== -1; }); }
    function cardHtml(l, ft, ref) {
      var rows = (l.popupFields || []).map(function (p) {
        var v = ft.attrs ? ft.attrs[p.name] : null;
        return '<span class="hint">' + esc(p.alias || p.name) + '</span><span>' + (v === null || v === undefined || v === "" ? "—" : esc(v)) + '</span>';
      });
      if (l.geometry === "line") rows.push('<span class="hint">Length</span><span class="mono">' + lengthText(lengthM(featurePoints(ft))) + '</span>');
      var riders = l.geometry === "line" ? ridersOf(ref) : [];
      var ts = typeStyle(l, ft);
      var te = l.types ? typeOf(l, ft) : null;
      return '<div class="topo-arc-card">' +
        '<strong>' + esc(ft.label || l.title) + '</strong>' +
        (ts ? '<div class="topo-arc-legend-row">' + typeSwatch(ts) + '<span>' + esc(te ? te.label || String(te.value) : "Other types") + '</span></div>' : '') +
        '<div class="hint">' + esc(l.title) + ' · from ArcGIS, read only</div>' +
        (rows.length ? '<div class="topo-arc-card-fields">' + rows.join("") + '</div>' : '') +
        (riders.length ? '<div class="topo-arc-card-riders"><div class="hint">Connections on this line</div>' +
          riders.map(function (k) { return '<div>' + esc(opts.describeLink ? opts.describeLink(k) : k) + '</div>'; }).join("") + '</div>' : '') +
        (l.itemUrl ? '<a href="' + esc(l.itemUrl) + '" target="_blank" rel="noopener noreferrer">Open in ArcGIS</a>' : '') +
        '</div>';
    }
    function openCard(l, ft, ref, latlng) {
      var map = opts.map();
      if (!map) return;
      L.popup({ className: "topo-arc-popup", maxWidth: 300, autoPan: true })
        .setLatLng(latlng).setContent(cardHtml(l, ft, ref)).openOn(map);
    }

    // ── Legend (bottom left, while any layer is shown) ──────────────────
    /**
     * The map's Legend panel gets an "ArcGIS layers" section (opts.paintLegend,
     * map.js): each shown layer, a by-type layer's drawn types under its name.
     * A host without that hook gets a small Leaflet legend in the corner.
     */
    function legendSectionHtml(ids) {
      var h = hiddenSet();
      function row(sw, label, cls, part) {
        return '<div class="topology-legend-row' + (cls ? " " + cls : "") + '">' + (sw ? '<span class="topology-legend-swatch">' + sw + '</span>' : '') +
          '<span class="topology-legend-label">' + esc(label) + '</span>' + (part || '') + '</div>';
      }
      return '<div class="topology-legend-section"><div class="topology-legend-section-title">ArcGIS layers</div>' + ids.map(function (id) {
        var l = layerById(id);
        var part = truncated[id] ? ' <span class="hint" title="More features in view than one answer carries — zoom in">(partial)</span>' : '';
        if (!l.types) return row(swatch(l), l.title, "", part);
        return row("", l.title, "topo-arc-legend-layer", part) + typeRows(l).filter(function (r) { return !h[r.key]; }).map(function (r) {
          return row(typeSwatch(r.style), r.label, "is-type");
        }).join("");
      }).join("") + '</div>';
    }
    function paintLegend() {
      var map = opts.map();
      var ids = opts.visible() ? shownIds() : [];
      if (opts.paintLegend) { opts.paintLegend(map && ids.length ? legendSectionHtml(ids) : ""); return; }
      if (legend) { legend.remove(); legend = null; }
      if (!map || !ids.length) return;
      var Ctl = L.Control.extend({
        options: { position: "bottomleft" },
        onAdd: function () {
          var el = L.DomUtil.create("div", "topo-arc-legend leaflet-bar");
          L.DomEvent.disableClickPropagation(el);
          var h = hiddenSet();
          el.innerHTML = '<div class="topo-arc-legend-title">ArcGIS layers</div>' + ids.map(function (id) {
            var l = layerById(id);
            var part = truncated[id] ? ' <span class="hint" title="More features in view than one answer carries — zoom in">(partial)</span>' : '';
            if (!l.types) return '<div class="topo-arc-legend-row">' + swatch(l) + esc(l.title) + part + '</div>';
            // Rule 188(b): the layer's name, then each type it draws here.
            return '<div class="topo-arc-legend-row topo-arc-legend-layer">' + esc(l.title) + part + '</div>' +
              typeRows(l).filter(function (r) { return !h[r.key]; }).map(function (r) {
                return '<div class="topo-arc-legend-row is-type">' + typeSwatch(r.style) + esc(r.label) + '</div>';
              }).join("");
          }).join("");
          return el;
        },
      });
      legend = new Ctl().addTo(map);
    }
    /** A type's line sample, in its own colour (inline: any #rrggbb). */
    function typeSwatch(st) {
      var c = st && /^#[0-9a-f]{6}$/i.test(st.color) ? st.color : "#9aa0a6";
      var dash = st && DASH[st.dash];
      return '<svg width="28" height="10" aria-hidden="true"><line x1="2" y1="5" x2="26" y2="5" stroke="' + c + '" stroke-linecap="round" stroke-width="' +
        Math.min(4, (st && st.width) || 3) + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '></line></svg>';
    }
    function swatch(l) {
      if (l.geometry === "point") {
        return '<svg width="28" height="10" aria-hidden="true"><circle cx="14" cy="5" r="4" class="' + classes(l) + '"></circle></svg>';
      }
      var dash = dashOf(l);
      return '<svg width="28" height="10" aria-hidden="true"><line x1="2" y1="5" x2="26" y2="5" class="' + classes(l) + '" stroke-width="' + Math.min(4, widthOf(l)) + '"' +
        (dash ? ' stroke-dasharray="' + dash + '"' : '') + '></line></svg>';
    }

    // ── The Map layers card (details pane) ──────────────────────────────
    function brokenRoutes() {
      var h = hiddenSet();
      return Object.keys(links).filter(function (k) {
        return links[k].some(function (ref) {
          var r = splitRef(ref);
          var l = r && layerById(r.layerId);
          if (missing[ref] || !l || h[l.id]) return true;
          var ft = feature(ref);
          return !!(ft && !featureShown(l, ft, h));
        });
      }).length;
    }

    /**
     * Hide or show one layer (`<layerId>`) or type (`<layerId>:<value>`,
     * `<layerId>#other`). A layer coming back needs its features fetched; a
     * type only needs a redraw — its features are already here.
     */
    function setHidden(key, hide) {
      var next = (opts.hidden ? opts.hidden() || [] : []).filter(function (k) { return k !== key; });
      if (hide) next.push(key);
      opts.setHidden(next);
      if (key.indexOf(":") === -1 && key.indexOf("#") === -1) refresh();
      else { draw(); routesChanged(); }
    }

    // ── Links routed through lines (rule 188(a)) ────────────────────────
    function asRun(ref) {
      var ft = feature(ref);
      if (!ft) return null;
      var r = splitRef(ref);
      var l = r && layerById(r.layerId);
      if (!l || l.geometry !== "line" || isHidden(l.id) || !featureShown(l, ft)) return null;
      var pts = featurePoints(ft);
      return pts.length >= 2 ? { id: ref, key: ref, points: pts } : null;
    }
    /** The lines a link rides, in its stored order (lines not drawable now are skipped). */
    function linkRuns(pk) {
      if (!opts.visible()) return [];
      return (links[pk] || []).map(asRun).filter(Boolean);
    }
    function setLinkRuns(pk, refs) {
      var clean = [];
      (refs || []).forEach(function (ref) { if (ref && clean.indexOf(ref) === -1) clean.push(ref); });
      if (JSON.stringify(clean) === JSON.stringify(links[pk] || [])) return false;
      if (clean.length) links[pk] = clean; else delete links[pk];
      stage();
      if (opts.onChange) opts.onChange();
      routesChanged();
      return true;
    }
    /** The shown ArcGIS line under a screen point (within `px`), nearest first: { key, id, run } or null. */
    function hitRun(cp, px) {
      var map = opts.map();
      if (!map || !opts.visible()) return null;
      var best = null;
      shownIds().forEach(function (id) {
        var l = layerById(id);
        if (l.geometry !== "line") return;
        var feats = byLayer[id] || {};
        var h = hiddenSet();
        Object.keys(feats).forEach(function (ref) {
          if (!featureShown(l, feats[ref], h)) return;
          feats[ref].g.forEach(function (path) {
            var pts = path.map(function (p) { return map.latLngToContainerPoint(L.latLng(p[1], p[0])); });
            for (var i = 0; i < pts.length - 1; i++) {
              var a = pts[i], b = pts[i + 1];
              var dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
              var t = len2 > 0 ? Math.max(0, Math.min(1, ((cp.x - a.x) * dx + (cp.y - a.y) * dy) / len2)) : 0;
              var x = a.x + t * dx - cp.x, y = a.y + t * dy - cp.y;
              var d = Math.sqrt(x * x + y * y);
              if (d <= px && (!best || d < best.d)) best = { d: d, ref: ref };
            }
          });
        });
      });
      if (!best) return null;
      return { key: best.ref, id: best.ref, run: asRun(best.ref) };
    }
    /** Light up the line a dragged link would join (null clears). */
    function highlight(ref) {
      if (ref === targetKey) return;
      var prev = targetKey;
      targetKey = ref || null;
      [prev, targetKey].forEach(function (x) {
        var line = x && shapes[x];
        var r = x && splitRef(x);
        var l = r && layerById(r.layerId);
        if (!line || !l) return;
        var on = x === targetKey;
        var w = shapeWidth[x] || widthOf(l);
        line.setStyle({ weight: on ? w + 8 : w });
        var el = line.getElement && line.getElement();
        var cls = l.types ? "topo-arc topo-arc-line topo-arc-typed" : classes(l);
        if (el) el.setAttribute("class", cls + (on ? " is-target" : "") + " leaflet-interactive");
      });
    }

    return {
      load: load,
      refresh: refresh,
      draw: draw,
      // Undo / redo: the canvas's history carries the working copy of the links.
      snapshot: function () { return { links: cloneLinks(links) }; },
      restore: function (snap) {
        links = cloneLinks(snap && !Array.isArray(snap) ? snap.links : {});
        stage();
        draw();
        routesChanged();
      },
      linkRuns: linkRuns,
      linkRunIds: function (pk) { return (links[pk] || []).slice(); },
      setLinkRuns: setLinkRuns,
      hitRun: hitRun,
      highlight: highlight,
      visible: function () { return opts.visible(); },
      // The eye button's list: the layers covering the map (rule 188(c)).
      // Each type of a by-type layer comes with its own hide key and sample (rule 188(b)).
      layerList: function () {
        var h = hiddenSet();
        return covering().map(function (l) {
          return {
            id: l.id, title: l.title, swatch: l.types ? "" : swatch(l), shown: !h[l.id], hasLabels: l.geometry !== "area",
            types: typeRows(l).map(function (r) { return { key: r.key, label: r.label, swatch: typeSwatch(r.style), shown: !h[r.key] }; }),
          };
        });
      },
      // The configured layers that cover somewhere else (the eye menu's "Not here").
      notHere: function () {
        var here = covering();
        return layers.filter(function (l) { return here.indexOf(l) === -1; }).map(function (l) { return l.title; });
      },
      // Connections drawn straight because their line is hidden, filtered out or gone (rule 188(a)).
      brokenCount: function () { return brokenRoutes(); },
      setHidden: setHidden,
      setEditing: function () { draw(); },
      destroy: function () {
        if (moveTimer) clearTimeout(moveTimer);
        if (drawnOn) drawnOn.off("moveend", onMove);
        if (legend) { legend.remove(); legend = null; }
        if (opts.paintLegend) opts.paintLegend("");
        if (group) { group.clearLayers(); group = null; }
      },
    };
  }

  window.PolarisTopologyArcgisLayers = {
    create: create,
    // Pure helpers, exported for tests.
    _diffLinks: diffLinks,
    _lengthM: lengthM,
    _featurePoints: featurePoints,
    _splitRef: splitRef,
  };
})();
