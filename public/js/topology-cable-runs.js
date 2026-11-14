/**
 * public/js/topology-cable-runs.js — cable runs on the Device Map topology's
 * Topology canvas (business rule 184).
 *
 *   window.PolarisTopologyCableRuns.create(opts) → layer
 *
 * A cable run is a fiber or ethernet route at the site: a POLE run along
 * electric or telephone poles, drawn here by hand (every bend is a pole), or
 * a TRENCH imported from a survey file (its points are locked on the map).
 * Runs belong to the site, not the view, and draw on floor 0 over the map or
 * satellite ground only — never over an uploaded plan image, whose
 * coordinates are not latitude / longitude.
 *
 * Placement is colour (trench / electric pole / telephone pole) and medium is
 * line style (fiber solid, ethernet dashed); the legend always names both, so
 * colour is never the only cue. Colours come from CSS classes (map.css
 * `.topo-run-*`): an SVG presentation attribute cannot read a CSS variable.
 *
 * Like the canvas it lives on, this module never writes to the server: it
 * stages the session's run edits through `opts.stage(edits)` and map.js sends
 * them when the session commits (tick / Save) or drops them (close).
 *
 * opts: {
 *   L, map(), pane() → {name, renderer}, editing(), visible(), canEdit(),
 *   fetch() → Promise<{runs, links, canEditRuns}>, stage(edits), onChange(),
 *   toast(msg, kind),
 *   stageLinks(changes)?, onRoutesChanged()?, describeLink(pathKey)?,
 * }
 *
 * Rule 184(a): it also holds which runs each device link rides (`links`,
 * path key → ordered run ids). The canvas routes the link through them
 * (cable-run-geometry.js), asks `hitRun` while a link is dragged, and calls
 * `setLinkRuns`; the change is staged through `stageLinks` and sent on commit
 * like the runs. A run removed here leaves every link that rode it.
 */
(function () {
  "use strict";

  var PLACEMENTS = [
    { value: "electric_pole",  label: "Electric pole" },
    { value: "telephone_pole", label: "Telephone pole" },
    { value: "trench",         label: "Trench" },
  ];
  var MEDIA = [{ value: "fiber", label: "Fiber" }, { value: "ethernet", label: "Ethernet" }];
  var SYNC = {
    off:     null,
    pending: { cls: "badge-expired",  text: "Pending" },
    synced:  { cls: "badge-active",   text: "Synced" },
    failed:  { cls: "badge-conflict", text: "Failed" },
  };
  var EARTH_RADIUS_M = 6371008.8;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function labelOf(list, v) { for (var i = 0; i < list.length; i++) if (list[i].value === v) return list[i].label; return v; }

  /** Ground length in metres, 2D (mirrors cableRunService.runLengthM). */
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
   * What one edit session changed, as the PUT /cable-runs body: every run
   * that is new or differs from what was loaded, and every loaded run gone.
   */
  function diffRuns(loaded, current) {
    var before = {};
    loaded.forEach(function (r) { before[r.id] = r; });
    var upserts = [];
    var seen = {};
    current.forEach(function (r) {
      var body = { name: r.name || "", medium: r.medium, placement: r.placement, points: r.points, notes: r.notes || "" };
      if (r.id && before[r.id]) {
        seen[r.id] = true;
        var b = before[r.id];
        var same = b.name === body.name && b.medium === body.medium && b.placement === body.placement &&
          (b.notes || "") === body.notes && JSON.stringify(b.points) === JSON.stringify(body.points);
        if (!same) upserts.push(Object.assign({ id: r.id }, body));
      } else {
        upserts.push(body);
      }
    });
    var deletes = loaded.filter(function (r) { return !seen[r.id]; }).map(function (r) { return r.id; });
    return { upserts: upserts, deletes: deletes };
  }

  /**
   * Which links' routes one edit session changed: `{ pathKey: runIds }`, an
   * empty list for a link made straight again (rule 184(a)).
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

  function create(opts) {
    var L = opts.L;
    var loaded = [];            // as the server last answered
    var runs = [];              // working copy: { key, id?, name, medium, placement, points, notes, source, … }
    var canEditRuns = false;
    var selectedKey = null;
    var group = null;
    var shapes = {};            // key → L.polyline
    var drawHandler = null;
    var loadedLinks = {};       // path key → run ids, as the server last answered
    var links = {};             // working copy
    var targetKey = null;       // the run a dragged link is over (highlighted)
    var panel = null;           // L.Control
    var legend = null;          // L.Control
    var seq = 0;

    function key(r) { return r.key || (r.key = r.id || ("new-" + (++seq))); }
    function editable() { return opts.editing() && canEditRuns && opts.visible(); }
    function find(k) { for (var i = 0; i < runs.length; i++) if (key(runs[i]) === k) return runs[i]; return null; }
    function stage() {
      opts.stage(diffRuns(loaded, runs));
      if (opts.stageLinks) opts.stageLinks(diffLinks(loadedLinks, links));
    }
    function routesChanged() { if (opts.onRoutesChanged) opts.onRoutesChanged(); }
    function changedRuns() {
      stage();
      if (opts.onChange) opts.onChange();
      routesChanged();
    }
    function cloneLinks(o) {
      var out = {};
      Object.keys(o || {}).forEach(function (k) { if (o[k] && o[k].length) out[k] = o[k].slice(); });
      return out;
    }

    function load() {
      return opts.fetch().then(function (res) {
        loaded = (res && res.runs) || [];
        canEditRuns = !!(res && res.canEditRuns);
        runs = loaded.map(function (r) { return Object.assign({}, r, { points: r.points.map(function (p) { return p.slice(); }) }); });
        loadedLinks = cloneLinks(res && res.links);
        links = cloneLinks(loadedLinks);
        draw();
        routesChanged();
        return res;
      }, function () {
        loaded = []; runs = []; loadedLinks = {}; links = {}; canEditRuns = false; draw();
        routesChanged();
      });
    }

    // ── Drawing ─────────────────────────────────────────────────────────
    function latlngsOf(r) { return r.points.map(function (p) { return L.latLng(p[1], p[0]); }); }
    function classOf(r, selected) {
      return "topo-run topo-run-" + r.placement + (r.medium === "ethernet" ? " topo-run-ethernet" : "") +
        (selected ? " topo-run-selected" : "");
    }
    var drawnOn = null;        // the Leaflet map the layer, panel and legend live on
    function draw() {
      var map = opts.map();
      if (!map) return;
      // The canvas rebuilds its map when the background changes: start over on the new one.
      if (drawnOn !== map) { group = null; panel = null; legend = null; drawnOn = map; }
      if (group) group.clearLayers(); else group = L.layerGroup().addTo(map);
      shapes = {};
      paintLegend();
      if (!opts.visible()) { paintPanel(); return; }
      var f = opts.pane();
      runs.forEach(function (r) {
        var k = key(r);
        var sel = k === selectedKey;
        var line = L.polyline(latlngsOf(r), {
          pane: f.name, renderer: f.renderer, className: classOf(r, sel || k === targetKey),
          weight: k === targetKey ? 12 : sel ? 6 : 4, dashArray: r.medium === "ethernet" ? "10 7" : null,
          lineCap: "round", lineJoin: "round", interactive: true, bubblingMouseEvents: false,
        });
        line.on("click", function (e) { if (e.originalEvent) L.DomEvent.stop(e.originalEvent); select(k); });
        line.bindTooltip(esc((r.name || labelOf(PLACEMENTS, r.placement) + " run")) + " · " + lengthText(lengthM(r.points)), { sticky: true, direction: "top" });
        group.addLayer(line);
        shapes[k] = line;
        // A pole run's bends are its poles: a small mark at each.
        if (r.placement !== "trench") {
          r.points.forEach(function (p) {
            group.addLayer(L.circleMarker(L.latLng(p[1], p[0]), {
              pane: f.name, renderer: f.renderer, radius: 3, weight: 1.5,
              className: "topo-run-pole", interactive: false,
            }));
          });
        }
        if (sel && editable() && r.source !== "crd" && line.editing) {
          line.editing.enable();
          line.on("edit", function () {
            r.points = line.getLatLngs().map(function (ll) { return [round7(ll.lng), round7(ll.lat)]; });
            changedRuns();
            paintPanel();
          });
        }
      });
      paintPanel();
    }
    function round7(v) { return Math.round(v * 1e7) / 1e7; }

    function select(k) {
      selectedKey = k && find(k) ? k : null;
      draw();
    }

    function startDraw() {
      if (!editable()) return;
      if (!L.Draw || !L.Draw.Polyline) { opts.toast("The drawing tools did not load", "error"); return; }
      cancelDraw();
      var map = opts.map();
      drawHandler = new L.Draw.Polyline(map, {
        shapeOptions: { className: "topo-run topo-run-electric_pole", weight: 4, opacity: 1 },
        showLength: true, metric: true,
      });
      map.once(L.Draw.Event.CREATED, function (e) {
        drawHandler = null;
        var pts = e.layer.getLatLngs().map(function (ll) { return [round7(ll.lng), round7(ll.lat)]; });
        if (pts.length < 2) return;
        var r = { name: "", medium: "fiber", placement: "electric_pole", points: pts, notes: "", source: "drawn", syncStatus: "off" };
        runs.push(r);
        selectedKey = key(r);
        changedRuns();
        draw();
      });
      drawHandler.enable();
      opts.toast("Drawing a pole run — click each pole, double-click the last one to finish, Esc cancels");
    }
    function cancelDraw() {
      if (drawHandler) { try { drawHandler.disable(); } catch (e) { /* already off */ } drawHandler = null; }
    }

    function removeSelected() {
      if (!editable() || !selectedKey) return false;
      var gone = find(selectedKey);
      if (gone && gone.id) dropRunFromLinks(gone.id);
      runs = runs.filter(function (r) { return key(r) !== selectedKey; });
      selectedKey = null;
      changedRuns();
      draw();
      return true;
    }

    // ── Links routed through runs (rule 184(a)) ─────────────────────────
    function dropRunFromLinks(id) {
      Object.keys(links).forEach(function (k) {
        var left = links[k].filter(function (x) { return x !== id; });
        if (left.length) links[k] = left; else delete links[k];
      });
    }
    function byId(id) { for (var i = 0; i < runs.length; i++) if (runs[i].id === id) return runs[i]; return null; }
    /** The runs a link rides, in its stored order (runs no longer here are skipped). */
    function linkRuns(pk) {
      if (!opts.visible()) return [];
      return (links[pk] || []).map(byId).filter(function (r) { return r && r.points && r.points.length >= 2; });
    }
    function setLinkRuns(pk, ids) {
      var clean = [];
      (ids || []).forEach(function (id) { if (id && clean.indexOf(id) === -1 && byId(id)) clean.push(id); });
      if (JSON.stringify(clean) === JSON.stringify(links[pk] || [])) return false;
      if (clean.length) links[pk] = clean; else delete links[pk];
      stage();
      if (opts.onChange) opts.onChange();
      routesChanged();
      paintPanel();
      return true;
    }
    /** The run under a screen point (within `px`), nearest first: { key, id, run } or null. */
    function hitRun(cp, px) {
      var map = opts.map();
      if (!map || !opts.visible()) return null;
      var best = null;
      runs.forEach(function (r) {
        var pts = r.points.map(function (p) { return map.latLngToContainerPoint(L.latLng(p[1], p[0])); });
        for (var i = 0; i < pts.length - 1; i++) {
          var a = pts[i], b = pts[i + 1];
          var dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
          var t = len2 > 0 ? Math.max(0, Math.min(1, ((cp.x - a.x) * dx + (cp.y - a.y) * dy) / len2)) : 0;
          var x = a.x + t * dx - cp.x, y = a.y + t * dy - cp.y;
          var d = Math.sqrt(x * x + y * y);
          if (d <= px && (!best || d < best.d)) best = { d: d, key: key(r), id: r.id || null, run: r };
        }
      });
      return best ? { key: best.key, id: best.id, run: best.run } : null;
    }
    /** Light up the run a dragged link would join (null clears). */
    function highlight(k) {
      if (k === targetKey) return;
      var prev = targetKey;
      targetKey = k || null;
      [prev, targetKey].forEach(function (x) {
        var line = x && shapes[x];
        var r = x && find(x);
        if (!line || !r) return;
        var on = x === targetKey;
        line.setStyle({ weight: on ? 12 : x === selectedKey ? 6 : 4 });
        var el = line.getElement && line.getElement();
        if (el) el.setAttribute("class", classOf(r, on || x === selectedKey) + " leaflet-interactive");
      });
    }
    function linksOn(id) {
      return Object.keys(links).filter(function (k) { return links[k].indexOf(id) !== -1; });
    }

    // ── The run panel (top right) ───────────────────────────────────────
    function seg(name, list, value, disabledValues, locked) {
      return '<div class="topo-run-seg" role="group">' + list.map(function (o) {
        var off = locked || (disabledValues || []).indexOf(o.value) !== -1;
        return '<button type="button" class="btn btn-sm ' + (o.value === value ? "btn-primary" : "btn-secondary") + '" data-run-' + name + '="' + o.value + '"' +
          (off ? " disabled" : "") + '>' + esc(o.label) + '</button>';
      }).join("") + '</div>';
    }
    function panelHtml(r) {
      var can = editable();
      var surveyed = r.source === "crd";
      var m = lengthM(r.points);
      var sync = SYNC[r.syncStatus] || null;
      return '<div class="topo-run-panel-head"><h4>Cable run</h4>' +
          '<button type="button" class="btn-icon" data-run-close aria-label="Close">×</button></div>' +
        '<div class="form-group"><label for="topo-run-name">Name</label>' +
          '<input id="topo-run-name" type="text" maxlength="120" value="' + esc(r.name) + '"' + (can ? "" : " disabled") + ' placeholder="e.g. Yard road pole line"></div>' +
        '<div class="form-group"><label>Medium</label>' + seg("medium", MEDIA, r.medium, [], !can) + '</div>' +
        '<div class="form-group"><label>Placement</label>' +
          seg("placement", PLACEMENTS, r.placement, surveyed ? ["electric_pole", "telephone_pole"] : ["trench"], !can) +
          '<p class="hint">' + (surveyed
            ? "Surveyed from " + esc(r.sourceFile || "a survey file") + " — its points are locked."
            : "Each bend in the line is a pole. Trenches are imported from a survey file.") + '</p></div>' +
        '<div class="topo-run-facts"><div><span class="hint">Length</span><span class="mono">' + lengthText(m) + '</span></div>' +
          (r.placement !== "trench" ? '<div><span class="hint">Poles</span><span class="mono">' + r.points.length + '</span></div>' : '') + '</div>' +
        '<div class="form-group"><label for="topo-run-notes">Notes</label>' +
          '<textarea id="topo-run-notes" rows="2" maxlength="2000"' + (can ? "" : " disabled") + '>' + esc(r.notes) + '</textarea></div>' +
        ridersHtml(r) +
        (sync ? '<div class="topo-run-sync"><span class="badge ' + sync.cls + '">' + sync.text + '</span>' +
          (r.arcgisObjectId != null ? ' <span class="mono hint">OBJECTID ' + esc(r.arcgisObjectId) + '</span>' : '') +
          (r.syncError ? '<p class="hint" style="color:var(--color-danger)">' + esc(r.syncError) + '</p>' : '') + '</div>' : '') +
        (can ? '<p class="hint">Changes are kept when you save the view' + (r.syncStatus && r.syncStatus !== "off" ? ", then sent to ArcGIS." : ".") + '</p>' +
          '<button type="button" class="btn btn-sm btn-danger" data-run-delete>Delete run</button>' : '');
    }
    function ridersHtml(r) {
      var on = r.id ? linksOn(r.id) : [];
      if (!on.length) return "";
      return '<div class="form-group"><label>Links on this run</label><ul class="topo-run-riders">' +
        on.map(function (k) { return '<li>' + esc(opts.describeLink ? opts.describeLink(k) : k) + '</li>'; }).join("") +
        '</ul><p class="hint">Kept in Polaris — not sent to ArcGIS.</p></div>';
    }
    function paintPanel() {
      var map = opts.map();
      var r = selectedKey ? find(selectedKey) : null;
      if (!map || !r || !opts.visible()) { if (panel) { panel.remove(); panel = null; } return; }
      if (!panel) {
        var Ctl = L.Control.extend({
          options: { position: "topright" },
          onAdd: function () {
            var el = L.DomUtil.create("div", "topo-run-panel leaflet-bar");
            L.DomEvent.disableClickPropagation(el);
            L.DomEvent.disableScrollPropagation(el);
            return el;
          },
        });
        panel = new Ctl().addTo(map);
      }
      var el = panel.getContainer();
      el.innerHTML = panelHtml(r);
      wirePanel(el, r);
    }
    function wirePanel(el, r) {
      var close = el.querySelector("[data-run-close]");
      if (close) close.addEventListener("click", function () { select(null); });
      var name = el.querySelector("#topo-run-name");
      if (name) name.addEventListener("change", function () { r.name = name.value.trim(); changedRuns(); draw(); });
      var notes = el.querySelector("#topo-run-notes");
      if (notes) notes.addEventListener("change", function () { r.notes = notes.value.trim(); changedRuns(); });
      Array.prototype.forEach.call(el.querySelectorAll("[data-run-medium]"), function (b) {
        b.addEventListener("click", function () { r.medium = b.getAttribute("data-run-medium"); changedRuns(); draw(); });
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-run-placement]"), function (b) {
        b.addEventListener("click", function () { r.placement = b.getAttribute("data-run-placement"); changedRuns(); draw(); });
      });
      var del = el.querySelector("[data-run-delete]");
      if (del) del.addEventListener("click", removeSelected);
    }

    // ── Legend (bottom left, while any run is shown) ────────────────────
    function paintLegend() {
      var map = opts.map();
      var show = map && opts.visible() && runs.length > 0;
      if (!show) { if (legend) { legend.remove(); legend = null; } return; }
      if (legend) return;
      var Ctl = L.Control.extend({
        options: { position: "bottomleft" },
        onAdd: function () {
          var el = L.DomUtil.create("div", "topo-run-legend leaflet-bar");
          L.DomEvent.disableClickPropagation(el);
          function row(cls, label, dashed) {
            return '<div class="topo-run-legend-row"><svg width="28" height="8" aria-hidden="true"><line x1="1" y1="4" x2="27" y2="4" class="' + cls + '"' +
              (dashed ? ' stroke-dasharray="6 4"' : '') + '></line></svg>' + label + '</div>';
          }
          el.innerHTML = '<div class="topo-run-legend-title">Cable runs</div>' +
            row("topo-run-trench", "Trench") + row("topo-run-electric_pole", "Electric pole") + row("topo-run-telephone_pole", "Telephone pole") +
            '<div class="topo-run-legend-rule"></div>' +
            row("topo-run-medium", "Fiber") + row("topo-run-medium", "Ethernet", true);
          return el;
        },
      });
      legend = new Ctl().addTo(map);
    }

    return {
      load: load,
      draw: draw,
      startDraw: startDraw,
      cancelDraw: cancelDraw,
      canEdit: function () { return canEditRuns; },
      selected: function () { return selectedKey; },
      select: select,
      removeSelected: removeSelected,
      // Undo / redo: the canvas's history carries the working copy.
      snapshot: function () {
        return { runs: runs.map(function (r) { return Object.assign({}, r); }), links: cloneLinks(links) };
      },
      restore: function (snap) {
        var list = Array.isArray(snap) ? snap : (snap && snap.runs) || [];
        runs = list.map(function (r) { return Object.assign({}, r); });
        if (snap && !Array.isArray(snap)) links = cloneLinks(snap.links);
        if (selectedKey && !find(selectedKey)) selectedKey = null;
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
      setEditing: function (on) {
        if (!on) cancelDraw();
        draw();
      },
      destroy: function () {
        cancelDraw();
        if (panel) { panel.remove(); panel = null; }
        if (legend) { legend.remove(); legend = null; }
        if (group) { group.clearLayers(); group = null; }
      },
    };
  }

  window.PolarisTopologyCableRuns = {
    create: create,
    // Pure helpers, exported for tests.
    _diffRuns: diffRuns,
    _diffLinks: diffLinks,
    _lengthM: lengthM,
  };
})();
