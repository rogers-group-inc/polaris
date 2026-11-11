/**
 * public/js/topology-wall.js — the Device Map topology's WALL mode (business
 * rules 147, 150, 151): walls a view's devices are mounted on, a closet
 * backboard, a pegboard, a junction box's backplate.
 *
 *   window.PolarisTopologyWall.render(host, ctx) → instance
 *
 * Walls stand side by side, measured in inches and drawn as pegboard (a hole
 * every inch). Everything mounted is a POLYGON whose corners sit on whole
 * inches; in edit mode:
 *   - drag a device, Cable management, Third party or Rack from the details
 *     pane onto a wall (a Rack first asks for its size in U and which Rack
 *     view it opens);
 *   - drag an item to move it, drag a corner to reshape it, drag the + on an
 *     edge to add a corner, right-click a corner to remove it;
 *   - two items never share a 1-inch cell (cellsOf / overlaps — the same rule
 *     as src/utils/wallGeometry.ts): a move or reshape that would overlap
 *     snaps back and names what it hit;
 *   - a wall's header: double-click the name or the size to change them; ×
 *     deletes any wall after the first; Add wall appends one.
 * A view mapped to a region (rule 150) stages that region's codes for each
 * device mounted on it; nothing else here changes a description.
 *
 * map.js owns the edit session; this module stages `walls` and
 * `wallPlacements` through ctx.stageViewPatch.
 */
(function () {
  "use strict";

  var DRAG_MIME = "application/x-polaris-asset";
  var CABLE_TOKEN = "__cable_management__";
  var THIRD_PARTY_TOKEN = "__third_party__";
  var RACK_TOKEN = "__rack__";
  var DEFAULT_W = 96, DEFAULT_H = 48;
  var MIN_SIDE = 4, MAX_SIDE = 600;
  var HISTORY_MAX = 100;
  var SCALES = [3, 4, 5, 6, 8, 10, 12, 16];
  var RACK_WIDTH_IN = 24;
  var CODE_KEYS = ["area", "building", "floor", "room", "rack", "junctionBox"];

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s))
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }
  function newId(prefix) {
    var s = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return prefix + "-" + s;
  }

  // ── Geometry (pure; mirrors src/utils/wallGeometry.ts) ───────────────────
  function pointInPolygon(x, y, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function cellsOf(ring) {
    var out = {};
    if (!ring || ring.length < 3) return out;
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    ring.forEach(function (p) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); });
    for (var cy = Math.floor(minY); cy < Math.ceil(maxY); cy++) {
      for (var cx = Math.floor(minX); cx < Math.ceil(maxX); cx++) {
        if (pointInPolygon(cx + 0.5, cy + 0.5, ring)) out[cx + "," + cy] = true;
      }
    }
    return out;
  }
  function doubleArea(ring) {
    var s = 0;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    return s;
  }
  // The first item on the same wall that `candidate` would overlap, or null.
  function overlaps(placements, candidate, ignoreId) {
    var mine = cellsOf(candidate.points);
    var keys = Object.keys(mine);
    for (var i = 0; i < placements.length; i++) {
      var q = placements[i];
      if (q.id === ignoreId || q.wallId !== candidate.wallId) continue;
      for (var k = 0; k < keys.length; k++) {
        var parts = keys[k].split(",");
        if (pointInPolygon(Number(parts[0]) + 0.5, Number(parts[1]) + 0.5, q.points)) return q;
      }
    }
    return null;
  }
  function rect(x, y, w, h) { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; }
  function bbox(points) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    points.forEach(function (p) { b.x0 = Math.min(b.x0, p[0]); b.y0 = Math.min(b.y0, p[1]); b.x1 = Math.max(b.x1, p[0]); b.y1 = Math.max(b.y1, p[1]); });
    return b;
  }
  function insideWall(points, wall) {
    return points.every(function (p) { return p[0] >= 0 && p[1] >= 0 && p[0] <= wall.width && p[1] <= wall.height; });
  }
  // A free spot for a w×h rectangle on the wall nearest (x, y), or null.
  function nearestFreeSpot(placements, wall, x, y, w, h) {
    if (w > wall.width || h > wall.height) return null;
    var best = null, bestD = Infinity;
    var maxR = Math.max(wall.width, wall.height);
    for (var r = 0; r <= maxR && !best; r++) {
      for (var dx = -r; dx <= r; dx++) {
        for (var dy = -r; dy <= r; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          var px = x + dx, py = y + dy;
          if (px < 0 || py < 0 || px + w > wall.width || py + h > wall.height) continue;
          var cand = { wallId: wall.id, points: rect(px, py, w, h) };
          if (overlaps(placements, cand, null)) continue;
          var d = dx * dx + dy * dy;
          if (d < bestD) { bestD = d; best = { x: px, y: py }; }
        }
      }
    }
    return best;
  }
  /** A wall rack's footprint: 24 in wide, 1.75 in per U plus a 3 in frame. */
  function rackFootprint(units) { return { w: RACK_WIDTH_IN, h: Math.ceil(units * 1.75 + 3) }; }

  function render(host, ctx) {
    // Read at render time: topology-render.js loads after the mode canvases.
    var R = window.PolarisTopologyRender;
    var data = ctx.data || {};
    var view = ctx.view || {};
    var staged = (ctx.stagedViewPatch && ctx.stagedViewPatch()) || {};
    var state = {
      editing: !!ctx.editing,
      walls: JSON.parse(JSON.stringify(staged.walls || view.walls || [])),
      placements: JSON.parse(JSON.stringify(staged.wallPlacements || view.wallPlacements || [])),
      history: { entries: [], index: -1 },
    };
    var scale = 6;
    var selectedId = ctx.selectedId ? ctx.selectedId() : null; // an ASSET id
    var selectedItem = null;                                      // a placement id (any kind)
    var listFilter = "";
    var gesture = null;

    // Devices that can be mounted: the same element set as the other modes.
    var nodeById = {};
    var locById = {};
    (R ? R.buildTopologyElements(data, { shownTypes: ctx.shownTypes }) : []).forEach(function (el) {
      var d = el.data;
      if (!d || d.source || d.isLocGroup || d.isPortal) return;
      if (d.role === "lldp" || d.role === "wireless-station" || d.role === "remote-asset") return;
      nodeById[d.id] = d;
    });
    [data.fortigate].concat(data.switches || [], data.aps || [], data.endpoints || []).forEach(function (x) {
      if (x && x.id) locById[x.id] = x.location || null;
    });

    host.innerHTML = '<div class="topo-wall-strip"></div>';
    var strip = host.firstChild;

    function wallById(id) { return state.walls.filter(function (w) { return w.id === id; })[0] || null; }
    function itemById(id) { return state.placements.filter(function (p) { return p.id === id; })[0] || null; }
    function assetOf(p) { return p.kind === "asset" ? nodeById[p.assetId] : null; }
    function itemName(p) {
      if (p.kind === "cableManagement") return "Cable management";
      if (p.kind === "thirdParty" || p.kind === "rack") return p.label || (p.kind === "rack" ? "Rack" : "Third party");
      var d = assetOf(p);
      return d ? (d.label || p.assetId) : "Device not shown";
    }

    // ── Drawing ─────────────────────────────────────────────────────────
    function draw() {
      var html = state.walls.map(wallHtml).join("");
      if (state.editing) {
        html += '<button type="button" class="topo-rack-add btn btn-secondary" data-wall-add>' +
          '<span class="topo-rack-add-plus" aria-hidden="true">+</span>Add junction box<span class="hint" style="margin:0">' + DEFAULT_W + ' × ' + DEFAULT_H + ' in</span></button>';
      }
      strip.innerHTML = html;
    }
    function wallHtml(w, idx) {
      var ed = state.editing;
      var W = w.width * scale, H = w.height * scale;
      var items = state.placements.filter(function (p) { return p.wallId === w.id; }).map(itemSvg).join("");
      var hole = Math.max(0.9, scale * 0.16);
      return '<section class="topo-wall" data-wall="' + esc(w.id) + '">' +
        '<header class="topo-wall-head">' +
          '<span class="topo-rack-name"' + (ed ? ' data-wall-rename="' + esc(w.id) + '" title="Double-click to rename"' : '') + '>' + esc(w.name) + '</span>' +
          '<span class="topo-rack-units"' + (ed ? ' data-wall-resize="' + esc(w.id) + '" title="Double-click to change the size"' : '') + '>' + w.width + ' × ' + w.height + ' in</span>' +
          (ed ? '<button type="button" class="btn-icon topo-rack-delete" data-wall-delete="' + esc(w.id) + '" aria-label="Delete ' + esc(w.name) + '">×</button>' : '') +
        '</header>' +
        '<svg class="topo-wall-board" data-wall-board="' + esc(w.id) + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + w.width + ' ' + w.height + '" role="img" aria-label="' + esc(w.name) + '">' +
          '<defs><pattern id="pg-' + esc(w.id) + '" width="1" height="1" patternUnits="userSpaceOnUse"><circle cx="0.5" cy="0.5" r="' + (hole / scale) + '" class="topo-wall-hole"></circle></pattern></defs>' +
          '<rect x="0" y="0" width="' + w.width + '" height="' + w.height + '" class="topo-wall-ground"></rect>' +
          '<rect x="0" y="0" width="' + w.width + '" height="' + w.height + '" fill="url(#pg-' + esc(w.id) + ')"></rect>' +
          items +
          '<g data-handles="' + esc(w.id) + '"></g>' +
        '</svg>' +
      '</section>';
    }
    function itemSvg(p) {
      var d = assetOf(p);
      var b = bbox(p.points);
      var cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
      var cls = "topo-wall-item is-" + p.kind + (p.id === selectedItem ? " is-selected" : "");
      var stroke = p.kind === "asset" && d && d.nodeColor ? ' style="stroke:' + esc(d.nodeColor) + '"' : "";
      var pts = p.points.map(function (q) { return q[0] + "," + q[1]; }).join(" ");
      var name = itemName(p);
      var sub = p.kind === "rack" ? p.units + "U" + (p.linkedViewId ? " · " + linkedName(p.linkedViewId) : "")
        : p.kind === "thirdParty" ? "third party" : "";
      // A tall, narrow item (a cable duct) reads its label sideways.
      var bw = b.x1 - b.x0, bh = b.y1 - b.y0;
      var sideways = bh > bw * 1.8 && bw < 8;
      var span = sideways ? bh : bw;
      // Label size in inches: as large as 3 in, shrunk until the longest line
      // fits inside the shape (about 0.6 em per character).
      var longest = Math.max(name.length, Math.ceil(sub.length * 0.8), 4);
      var fs = Math.max(0.9, Math.min(3, (span * 0.9) / (longest * 0.6), (sideways ? bw : bh) / (sub ? 2.6 : 1.6)));
      var icon = d && d.iconUrl && !sideways && bh >= fs * 4.5
        ? '<image href="' + esc(d.iconUrl) + '" x="' + (cx - fs * 1.1) + '" y="' + (cy - fs * 2.6) + '" width="' + (fs * 2.2) + '" height="' + (fs * 2.2) + '" preserveAspectRatio="xMidYMid meet"></image>'
        : "";
      var turn = sideways ? ' transform="rotate(-90 ' + cx + ' ' + cy + ')"' : "";
      return '<g class="' + cls + '" data-item="' + esc(p.id) + '"><title>' + esc(name + (sub ? " — " + sub : "")) + '</title>' +
        '<polygon points="' + pts + '"' + stroke + '></polygon>' +
        icon +
        '<g' + turn + '>' +
          '<text x="' + cx + '" y="' + (cy + (icon ? fs * 0.9 : sub ? -fs * 0.15 : fs * 0.35)) + '" font-size="' + fs + '" text-anchor="middle">' + esc(name) + '</text>' +
          (sub ? '<text class="topo-wall-sub" x="' + cx + '" y="' + (cy + (icon ? fs * 2.1 : fs * 1.05)) + '" font-size="' + (fs * 0.8) + '" text-anchor="middle">' + esc(sub) + '</text>' : "") +
        '</g>' +
      '</g>';
    }
    function linkedName(viewId) {
      var v = (ctx.listViews ? ctx.listViews() : []).filter(function (x) { return x.id === viewId; })[0];
      return v ? "→ " + v.name : "→ (view removed)";
    }
    // Corner and edge handles of the selected item, edit mode only.
    function drawHandles() {
      Array.prototype.forEach.call(strip.querySelectorAll("[data-handles]"), function (g) { g.innerHTML = ""; });
      var p = selectedItem && itemById(selectedItem);
      if (!p || !state.editing) return;
      var g = strip.querySelector('[data-handles="' + p.wallId + '"]');
      if (!g) return;
      var r = Math.max(0.7, 5 / scale);
      var html = "";
      p.points.forEach(function (q, i) {
        var n = p.points[(i + 1) % p.points.length];
        var mx = (q[0] + n[0]) / 2, my = (q[1] + n[1]) / 2;
        html += '<circle class="topo-wall-mid" data-mid="' + i + '" cx="' + mx + '" cy="' + my + '" r="' + (r * 0.8) + '"><title>Drag to add a corner</title></circle>';
      });
      p.points.forEach(function (q, i) {
        html += '<rect class="topo-wall-corner" data-corner="' + i + '" x="' + (q[0] - r) + '" y="' + (q[1] - r) + '" width="' + (2 * r) + '" height="' + (2 * r) + '"><title>Drag to reshape; right-click to remove this corner</title></rect>';
      });
      g.innerHTML = html;
    }
    function redraw() { draw(); drawHandles(); }

    // ── Staging + history ───────────────────────────────────────────────
    function snapshot() { return JSON.stringify({ walls: state.walls, placements: state.placements }); }
    function stage() {
      ctx.stageViewPatch({ walls: state.walls, wallPlacements: state.placements });
      restageCodes();
    }
    function changed() {
      stage();
      if (ctx.historyPushed) ctx.historyPushed();
      var h = state.history;
      h.entries = h.entries.slice(0, h.index + 1);
      h.entries.push(snapshot());
      if (h.entries.length > HISTORY_MAX) h.entries.shift();
      h.index = h.entries.length - 1;
      redraw();
      ctx.refreshSidebar();
      ctx.historyChanged();
    }
    function applySnapshot(s) {
      var o = JSON.parse(s);
      state.walls = o.walls;
      state.placements = o.placements;
      if (selectedItem && !itemById(selectedItem)) selectedItem = null;
      stage();
      redraw();
      ctx.refreshSidebar();
      ctx.historyChanged();
    }
    // Rule 150 (Room view): a device in a junction box takes the view's room plus
    // that junction box's name; rule 148(a): only the levels set here change.
    var region = view.region || null;
    var stagedAssets = {};
    function restageCodes() {
      if (!region || !ctx.stageLocationCode) return;
      var now = {};
      state.placements.forEach(function (p) {
        if (p.kind !== "asset" || !p.assetId) return;
        now[p.assetId] = true;
        var cur = locById[p.assetId] || null;
        var want = Object.assign({}, region);
        want.junctionBox = (wallById(p.wallId) || {}).name || null;
        want.rack = null;
        var levels = CODE_KEYS.slice(0, 4).filter(function (k) { return String(region[k] || "").trim(); }).concat(["junctionBox", "rack"]);
        var same = levels.every(function (k) { return String(want[k] || "").trim().toLowerCase() === String((cur && cur[k]) || "").trim().toLowerCase(); });
        if (!want.junctionBox || same) { ctx.stageLocationCode(p.assetId, null); return; }
        var d = nodeById[p.assetId];
        ctx.stageLocationCode(p.assetId, want, { name: d ? d.label : p.assetId, from: cur || {}, levels: levels });
      });
      Object.keys(stagedAssets).forEach(function (id) { if (!now[id]) ctx.stageLocationCode(id, null); });
      stagedAssets = now;
    }

    // ── Pointer → wall inches ──────────────────────────────────────────
    function boardAt(clientX, clientY) {
      var el = document.elementFromPoint(clientX, clientY);
      return el && el.closest ? el.closest("[data-wall-board]") : null;
    }
    function inchesIn(board, clientX, clientY) {
      var r = board.getBoundingClientRect();
      var w = wallById(board.getAttribute("data-wall-board"));
      return { x: (clientX - r.left) / r.width * w.width, y: (clientY - r.top) / r.height * w.height };
    }

    // ── Drop from the details pane ─────────────────────────────────────
    strip.addEventListener("dragover", function (e) {
      if (!state.editing) return;
      if (boardAt(e.clientX, e.clientY)) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; }
    });
    strip.addEventListener("drop", function (e) {
      if (!state.editing) return;
      var token = e.dataTransfer && e.dataTransfer.getData(DRAG_MIME);
      var board = boardAt(e.clientX, e.clientY);
      if (!token || !board) return;
      e.preventDefault();
      var wall = wallById(board.getAttribute("data-wall-board"));
      var at = inchesIn(board, e.clientX, e.clientY);
      if (token === RACK_TOKEN) {
        askForRack(function (spec) { mount(wall, at, spec); }, null, function (fp) {
          // Checked BEFORE a new Rack view is created, so a rack that can't
          // be mounted never leaves a view behind.
          return !!nearestFreeSpot(state.placements, wall, Math.max(0, Math.round(at.x - fp.w / 2)), Math.max(0, Math.round(at.y - fp.h / 2)), fp.w, fp.h);
        });
        return;
      }
      if (token !== CABLE_TOKEN && token !== THIRD_PARTY_TOKEN && state.placements.some(function (p) { return p.assetId === token; })) {
        ctx.toast("That device is already in a junction box in this view", "error");
        return;
      }
      // A device is in one place in a room: a rack or a junction box.
      var elsewhere = token !== CABLE_TOKEN && token !== THIRD_PARTY_TOKEN && ctx.placedElsewhere ? ctx.placedElsewhere(token) : null;
      if (elsewhere) { ctx.toast("That device is already in " + elsewhere + ": remove it there first", "error"); return; }
      if (token === CABLE_TOKEN) mount(wall, at, { kind: "cableManagement", w: 3, h: 24 });
      else if (token === THIRD_PARTY_TOKEN) mount(wall, at, { kind: "thirdParty", w: 12, h: 8, label: "Third party", rename: true });
      else mount(wall, at, { kind: "asset", assetId: token, w: 12, h: 8 });
    });
    function mount(wall, at, spec) {
      var x = Math.round(at.x - spec.w / 2), y = Math.round(at.y - spec.h / 2);
      var spot = nearestFreeSpot(state.placements, wall, Math.max(0, x), Math.max(0, y), spec.w, spec.h);
      if (!spot) { ctx.toast(wall.name + " has no free " + spec.w + " × " + spec.h + " in space for that", "error"); return; }
      var p = {
        id: newId(spec.kind === "asset" ? "wp" : spec.kind === "rack" ? "wr" : spec.kind === "cableManagement" ? "wc" : "wt"),
        kind: spec.kind,
        assetId: spec.kind === "asset" ? spec.assetId : null,
        label: spec.kind === "thirdParty" || spec.kind === "rack" ? spec.label : null,
        wallId: wall.id,
        points: rect(spot.x, spot.y, spec.w, spec.h),
        units: spec.kind === "rack" ? spec.units : null,
        linkedViewId: spec.kind === "rack" ? spec.linkedViewId || null : null,
      };
      state.placements.push(p);
      selectedItem = p.id;
      if (p.assetId) select(p.assetId, true);
      changed();
      if (spec.rename) renameItem(p);
    }

    // ── Gestures: move, corner drag, add corner ─────────────────────────
    strip.addEventListener("pointerdown", function (e) {
      if (!state.editing || e.button !== 0) return;
      var corner = e.target.closest("[data-corner]");
      var mid = e.target.closest("[data-mid]");
      var itemEl = e.target.closest("[data-item]");
      var p = null, kind = null, index = -1;
      if (corner || mid) {
        p = itemById(selectedItem);
        if (!p) return;
        if (mid) {
          index = Number(mid.getAttribute("data-mid")) + 1;
          var a = p.points[index - 1], b = p.points[index % p.points.length];
          p.points.splice(index, 0, [Math.round((a[0] + b[0]) / 2), Math.round((a[1] + b[1]) / 2)]);
        } else index = Number(corner.getAttribute("data-corner"));
        kind = "corner";
      } else if (itemEl) {
        p = itemById(itemEl.getAttribute("data-item"));
        kind = "move";
      }
      if (!p) return;
      e.preventDefault();
      var board = strip.querySelector('[data-wall-board="' + p.wallId + '"]');
      gesture = { kind: kind, p: p, index: index, orig: JSON.parse(JSON.stringify(p.points)), start: inchesIn(board, e.clientX, e.clientY),
        moved: false, pointerId: e.pointerId, addedCorner: !!mid };
    });
    strip.addEventListener("pointermove", function (e) {
      if (!gesture) return;
      var g = gesture;
      // Re-found each move: a redraw replaces the board, and a detached one
      // measures 0 × 0 (every inch would be Infinity).
      var board = strip.querySelector('[data-wall-board="' + g.p.wallId + '"]');
      if (!board) return;
      var at = inchesIn(board, e.clientX, e.clientY);
      var dx = Math.round(at.x - g.start.x), dy = Math.round(at.y - g.start.y);
      if (!g.moved && (Math.abs(at.x - g.start.x) > 0.6 || Math.abs(at.y - g.start.y) > 0.6)) {
        g.moved = true;
        try { strip.setPointerCapture(g.pointerId); } catch (_) { /* gone */ }
      }
      if (!g.moved) return;
      var wall = wallById(g.p.wallId);
      if (g.kind === "move") {
        var b = bbox(g.orig);
        dx = Math.max(-b.x0, Math.min(wall.width - b.x1, dx));
        dy = Math.max(-b.y0, Math.min(wall.height - b.y1, dy));
        g.p.points = g.orig.map(function (q) { return [q[0] + dx, q[1] + dy]; });
      } else {
        var o = g.orig[g.index];
        var nx = Math.max(0, Math.min(wall.width, o[0] + dx)), ny = Math.max(0, Math.min(wall.height, o[1] + dy));
        g.p.points = g.orig.map(function (q, i) { return i === g.index ? [nx, ny] : q; });
      }
      var hit = overlaps(state.placements, g.p, g.p.id);
      redraw();
      var el = strip.querySelector('[data-item="' + g.p.id + '"]');
      if (el) el.classList.toggle("is-refused", !!hit);
    });
    function endGesture() {
      if (!gesture) return;
      var g = gesture;
      gesture = null;
      if (!g.moved) {
        if (g.addedCorner) { g.p.points = g.orig; }
        selectItem(g.p);
        return;
      }
      var hit = overlaps(state.placements, g.p, g.p.id);
      var flat = doubleArea(g.p.points) === 0;
      if (hit || flat || !insideWall(g.p.points, wallById(g.p.wallId))) {
        g.p.points = g.orig;
        if (g.addedCorner) g.p.points = g.orig.filter(function (_, i) { return i !== g.index; });
        redraw();
        ctx.toast(hit ? "Overlaps " + itemName(hit) + " — put back where it was" : "That shape has no area — put back", "error");
        return;
      }
      changed();
    }
    strip.addEventListener("pointerup", endGesture);
    strip.addEventListener("pointercancel", endGesture);

    function selectItem(p) {
      selectedItem = p ? p.id : null;
      if (p && p.assetId) select(p.assetId, true); else if (selectedId) select(null, true);
      redraw();
    }
    function select(assetId, quiet) {
      selectedId = assetId || null;
      if (!quiet) redraw();
      if (typeof ctx.selectAsset === "function") ctx.selectAsset(selectedId);
    }

    // ── Clicks: walls, menus ────────────────────────────────────────────
    strip.addEventListener("click", function (e) {
      if (e.target.closest("[data-wall-add]")) {
        if (!state.editing) return;
        state.walls.push({ id: newId("wall"), name: "JB " + (state.walls.length + 1), width: DEFAULT_W, height: DEFAULT_H, order: state.walls.length });
        changed();
        strip.scrollLeft = strip.scrollWidth;
        return;
      }
      var del = e.target.closest("[data-wall-delete]");
      if (del) { deleteWall(wallById(del.getAttribute("data-wall-delete"))); return; }
      var itemEl = e.target.closest("[data-item]");
      if (itemEl && !state.editing) { selectItem(itemById(itemEl.getAttribute("data-item"))); return; }
      if (!itemEl && !e.target.closest("[data-corner], [data-mid], button, header") && (selectedItem || selectedId)) {
        selectedItem = null;
        select(null);
      }
    });
    strip.addEventListener("dblclick", function (e) {
      var itemEl = e.target.closest("[data-item]");
      if (itemEl) {
        var p = itemById(itemEl.getAttribute("data-item"));
        if (!p) return;
        if (p.kind === "asset") ctx.openAsset(p.assetId);
        else if (p.kind === "rack" && p.linkedViewId && !state.editing && ctx.openView) ctx.openView(p.linkedViewId);
        else if ((p.kind === "thirdParty" || p.kind === "rack") && state.editing) renameItem(p);
        return;
      }
      if (!state.editing) return;
      var nm = e.target.closest("[data-wall-rename]");
      if (nm) { editWall(wallById(nm.getAttribute("data-wall-rename")), "name"); return; }
      var sz = e.target.closest("[data-wall-resize]");
      if (sz) editWall(wallById(sz.getAttribute("data-wall-resize")), "size");
    });
    strip.addEventListener("contextmenu", function (e) {
      if (!state.editing) return;
      var corner = e.target.closest("[data-corner]");
      var p = selectedItem && itemById(selectedItem);
      if (corner && p) {
        e.preventDefault();
        if (p.points.length <= 3) { ctx.toast("A shape needs at least three corners", "error"); return; }
        var i = Number(corner.getAttribute("data-corner"));
        var next = p.points.filter(function (_, k) { return k !== i; });
        var cand = { wallId: p.wallId, points: next };
        if (doubleArea(next) === 0 || overlaps(state.placements, cand, p.id)) { ctx.toast("Removing that corner would overlap or flatten the shape", "error"); return; }
        p.points = next;
        changed();
        return;
      }
      var itemEl = e.target.closest("[data-item]");
      if (!itemEl || typeof showRowMenu !== "function") return;
      e.preventDefault();
      var it = itemById(itemEl.getAttribute("data-item"));
      if (!it) return;
      selectItem(it);
      var items = [{ heading: itemName(it) }];
      if (it.kind === "asset") items.push({ label: "Open", onSelect: function () { ctx.openAsset(it.assetId); } });
      if (it.kind === "thirdParty" || it.kind === "rack") items.push({ label: "Rename", onSelect: function () { renameItem(it); } });
      if (it.kind === "rack") {
        items.push({ label: "Change size", onSelect: function () { askForRack(function (spec) { resizeRack(it, spec); }, it); } });
        if (it.linkedViewId && ctx.openView) items.push({ label: "Open the linked Rack view", title: "Save or close the wall first", disabled: state.editing, onSelect: function () { ctx.openView(it.linkedViewId); } });
      }
      items.push({ label: "Remove", danger: true, onSelect: function () { removeItem(it.id); } });
      showRowMenu(itemEl, items, { menuAt: { x: e.clientX, y: e.clientY }, label: "Junction box item" });
    });

    function removeItem(id) {
      state.placements = state.placements.filter(function (p) { return p.id !== id; });
      if (selectedItem === id) selectedItem = null;
      changed();
    }

    // ── Dialogs ─────────────────────────────────────────────────────────
    function simpleDialog(title, bodyHtml, onApply, focusSel) {
      if (typeof buildOverlay !== "function") return;
      var footer = '<button type="button" class="btn btn-secondary" data-wd="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-wd="ok">Apply</button>';
      var dlg = buildOverlay(1100, title, bodyHtml, footer);
      function apply() { if (onApply(dlg.overlay) !== false) dlg.close(); }
      dlg.overlay.querySelector('[data-wd="cancel"]').addEventListener("click", dlg.close);
      dlg.overlay.querySelector('[data-wd="ok"]').addEventListener("click", apply);
      dlg.overlay.addEventListener("keydown", function (e) { if (e.key === "Enter" && e.target.tagName === "INPUT") { e.preventDefault(); apply(); } });
      setTimeout(function () { var f = dlg.overlay.querySelector(focusSel || "input"); if (f) { f.focus(); if (f.select) f.select(); } }, 0);
      return dlg;
    }
    function renameItem(p) {
      simpleDialog(p.kind === "rack" ? "Name this rack" : "Name this item",
        '<div class="form-group"><label for="tw-name">Name</label><input id="tw-name" type="text" maxlength="64" value="' + esc(p.label || "") + '"></div>',
        function (root) {
          var v = root.querySelector("#tw-name").value.trim().replace(/\s+/g, " ");
          if (!v) { ctx.toast("Give it a name", "error"); return false; }
          p.label = v.slice(0, 64);
          changed();
        });
    }
    function editWall(w, field) {
      if (!w) return;
      if (field === "name") {
        simpleDialog("Rename junction box", '<div class="form-group"><label for="tw-wn">Name</label><input id="tw-wn" type="text" maxlength="60" value="' + esc(w.name) + '"></div>',
          function (root) {
            var v = root.querySelector("#tw-wn").value.trim();
            if (!v) { ctx.toast("Give the junction box a name", "error"); return false; }
            w.name = v;
            changed();
          });
        return;
      }
      simpleDialog("Junction box size",
        '<div class="form-group"><label>Size</label><div style="display:flex;align-items:center;gap:8px">' +
        '<input id="tw-ww" type="number" min="' + MIN_SIDE + '" max="' + MAX_SIDE + '" value="' + w.width + '" style="width:6rem" aria-label="Width (in)"><span>×</span>' +
        '<input id="tw-wh" type="number" min="' + MIN_SIDE + '" max="' + MAX_SIDE + '" value="' + w.height + '" style="width:6rem" aria-label="Height (in)"><span>in</span></div>' +
        '<div class="hint">A junction box can’t shrink below something mounted in it. A wall is just a big one.</div></div>',
        function (root) {
          var nw = Number(root.querySelector("#tw-ww").value), nh = Number(root.querySelector("#tw-wh").value);
          if (!Number.isInteger(nw) || !Number.isInteger(nh) || nw < MIN_SIDE || nh < MIN_SIDE || nw > MAX_SIDE || nh > MAX_SIDE) {
            ctx.toast("Each side must be " + MIN_SIDE + " to " + MAX_SIDE + " in", "error"); return false;
          }
          var stranded = state.placements.filter(function (p) { return p.wallId === w.id && !insideWall(p.points, { width: nw, height: nh }); });
          if (stranded.length) { ctx.toast("Move " + stranded.slice(0, 3).map(itemName).join(", ") + " first", "error"); return false; }
          w.width = nw; w.height = nh;
          changed();
        });
    }
    async function deleteWall(w) {
      if (!w || !state.editing || state.walls.indexOf(w) < 0) return;
      var n = state.placements.filter(function (p) { return p.wallId === w.id; }).length;
      if (n) {
        var ok = typeof showConfirm === "function" ? await showConfirm('Delete "' + w.name + '" and the ' + n + " item" + (n === 1 ? "" : "s") + " in it?") : false;
        if (!ok) return;
      }
      state.walls = state.walls.filter(function (x) { return x.id !== w.id; });
      state.walls.forEach(function (x, i) { x.order = i; });
      state.placements = state.placements.filter(function (p) { return p.wallId !== w.id; });
      changed();
    }
    // Dropping a Rack: its size in U, then which Rack view it opens.
    function askForRack(done, existing, roomFor) {
      if (typeof buildOverlay !== "function") return;
      var rackViews = (ctx.listViews ? ctx.listViews() : []).filter(function (v) { return v.mode === "rack"; });
      var units = existing ? existing.units : 12;
      var body =
        '<div class="form-group"><label for="tw-ru">Size (U)</label><input id="tw-ru" type="number" min="1" max="60" value="' + units + '" style="width:7rem">' +
          '<div class="hint">1 to 60U. On the wall it takes about 24 in wide and 1.75 in per U plus the frame.</div></div>' +
        (existing ? "" :
        '<fieldset style="margin:0;padding:0;border:0;display:flex;flex-direction:column;gap:10px"><legend style="font-weight:600;margin-bottom:6px">Rack view</legend>' +
          '<label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="tw-link" value="existing"' + (rackViews.length ? " checked" : " disabled") + '>' +
            '<span style="display:flex;flex-direction:column;gap:6px;flex:1"><strong>Use a saved Rack view</strong>' +
            '<select id="tw-rv"' + (rackViews.length ? "" : " disabled") + '>' + (rackViews.map(function (v) { return '<option value="' + esc(v.id) + '">' + esc(v.name) + '</option>'; }).join("") || '<option>No Rack views yet</option>') + '</select>' +
            '<span class="hint" style="margin:0">Double-clicking the rack on the wall opens that view.</span></span></label>' +
          '<label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="tw-link" value="new"' + (rackViews.length ? "" : " checked") + '>' +
            '<span style="display:flex;flex-direction:column;gap:6px;flex:1"><strong>Create a new Rack view</strong>' +
            '<input id="tw-rn" type="text" maxlength="80" placeholder="Name, e.g. MDF wall rack">' +
            '<span class="hint" style="margin:0">Created now, with one rack of this size; it is there even if you close this wall without saving.</span></span></label>' +
          '<label style="display:flex;gap:8px;align-items:flex-start"><input type="radio" name="tw-link" value="none">' +
            '<span><strong>Don’t link it to a view</strong><span class="hint" style="display:block;margin:0">Just a rack-sized space on the wall.</span></span></label>' +
        '</fieldset>');
      var footer = '<button type="button" class="btn btn-secondary" data-wd="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-wd="ok">' + (existing ? "Apply" : "Place rack") + '</button>';
      var dlg = buildOverlay(1100, existing ? "Rack size" : "Add a rack to the wall", body, footer);
      dlg.overlay.querySelector('[data-wd="cancel"]').addEventListener("click", dlg.close);
      dlg.overlay.querySelector('[data-wd="ok"]').addEventListener("click", async function () {
        var u = Number(dlg.overlay.querySelector("#tw-ru").value);
        if (!Number.isInteger(u) || u < 1 || u > 60) { ctx.toast("The size must be 1 to 60U", "error"); return; }
        var fp = rackFootprint(u);
        if (existing) { dlg.close(); done({ units: u, w: fp.w, h: fp.h }); return; }
        if (roomFor && !roomFor(fp)) { ctx.toast("There is no free " + fp.w + " × " + fp.h + " in space on this wall for a " + u + "U rack", "error"); return; }
        var how = (dlg.overlay.querySelector('input[name="tw-link"]:checked') || {}).value;
        var linkedViewId = null, label = "Rack";
        if (how === "existing") {
          linkedViewId = dlg.overlay.querySelector("#tw-rv").value;
          var lv = rackViews.filter(function (v) { return v.id === linkedViewId; })[0];
          label = lv ? lv.name : label;
        } else if (how === "new") {
          var nm = dlg.overlay.querySelector("#tw-rn").value.trim();
          if (!nm) { ctx.toast("Name the new Rack view", "error"); return; }
          try {
            var created = await ctx.createView({ name: nm, mode: "rack", rackUnits: u, region: region || undefined });
            linkedViewId = created.id;
            label = created.name;
          } catch (err) {
            ctx.toast("Rack view not created — " + (err && err.message ? err.message : String(err)), "error");
            return;
          }
        }
        dlg.close();
        done({ kind: "rack", units: u, w: fp.w, h: fp.h, label: label, linkedViewId: linkedViewId });
      });
    }
    function resizeRack(p, spec) {
      var b = bbox(p.points);
      var next = rect(b.x0, b.y0, spec.w, spec.h);
      var wall = wallById(p.wallId);
      var cand = { wallId: p.wallId, points: next };
      if (!insideWall(next, wall) || overlaps(state.placements, cand, p.id)) { ctx.toast("A " + spec.units + "U rack doesn't fit there", "error"); return; }
      p.points = next;
      p.units = spec.units;
      changed();
    }

    // ── Details pane ────────────────────────────────────────────────────
    function sidebarHtml() {
      var DL = window.PolarisTopologyDeviceList;
      var mounted = {};
      state.placements.forEach(function (p) { if (p.assetId) mounted[p.assetId] = p; });
      var drag = state.editing;
      function itemRow(token, swatch, name) {
        return '<li class="topo-device-row topo-rack-item-row"' + (drag ? ' draggable="true" data-place-asset="' + token + '"' : '') + '>' +
          '<span class="' + swatch + '" aria-hidden="true"></span><span class="topo-device-name">' + name + '</span></li>';
      }
      var items = '<div class="topology-section topo-rack-items"><h5>Wall items</h5><ul>' +
        itemRow(CABLE_TOKEN, "topo-rack-cable-swatch", "Cable management") +
        itemRow(THIRD_PARTY_TOKEN, "topo-rack-third-swatch", "Third party") +
        itemRow(RACK_TOKEN, "topo-wall-rack-swatch", "Rack") +
        '</ul></div>';
      var rows = Object.keys(nodeById).map(function (id) {
        var d = nodeById[id];
        var t = R ? R.nodeAssetType(d) : "";
        var w = mounted[id] ? wallById(mounted[id].wallId) : null;
        return { id: id, label: d.label || id, inUse: !!mounted[id], meta: w ? w.name : String(t || "").replace(/_/g, " ") };
      }).sort(function (a, b) { return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: "base" }); });
      var regionNote = region
        ? '<p class="topology-type-hint" style="margin:0 0 8px">This view stands for <code>' + esc(CODE_KEYS.filter(function (k) { return region[k]; }).map(function (k) {
            return ({ area: "a", building: "b", floor: "f", room: "r", rack: "ra", junctionBox: "jb" })[k] + ":" + region[k];
          }).join(" ")) + '</code>: a device mounted here takes those codes when you save.</p>'
        : "";
      return (drag ? items : "") + regionNote + (DL ? DL.html({
        title: "Device List",
        hint: drag ? "Drag device from list to a wall." : "Edit the map to mount devices.",
        rows: rows, editing: drag, filter: listFilter, selectedId: selectedId, removeLabel: "Remove from the wall",
      }) : "");
    }
    function wireSidebar(pane) {
      if (!pane) return;
      pane.querySelectorAll(".topo-rack-items [data-place-asset]").forEach(function (li) {
        li.addEventListener("dragstart", function (e) {
          e.dataTransfer.setData(DRAG_MIME, li.getAttribute("data-place-asset"));
          e.dataTransfer.effectAllowed = "move";
        });
      });
      var DL = window.PolarisTopologyDeviceList;
      if (!DL) return;
      DL.wire(pane, {
        dragMime: DRAG_MIME,
        onFilter: function (f) { listFilter = f; },
        onRemove: function (id) {
          if (!state.editing) return;
          var p = state.placements.filter(function (x) { return x.assetId === id; })[0];
          if (p) removeItem(p.id);
        },
        onSelect: function (id) {
          var p = state.placements.filter(function (x) { return x.assetId === id; })[0];
          if (p) { selectItem(p); var el = strip.querySelector('[data-item="' + p.id + '"]'); if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" }); }
          else select(id);
        },
      });
    }

    function setEditing(on) {
      state.editing = !!on;
      host.classList.toggle("is-editing", !!on);
      if (on) { state.history = { entries: [snapshot()], index: 0 }; ctx.historyChanged(); restageCodes(); }
      redraw();
    }
    function zoom(dir) {
      var i = SCALES.indexOf(scale);
      var next = SCALES[Math.max(0, Math.min(SCALES.length - 1, (i < 0 ? 3 : i) + dir))];
      if (next === scale) return;
      scale = next;
      redraw();
    }

    if (selectedId) {
      var pre = state.placements.filter(function (p) { return p.assetId === selectedId; })[0];
      if (pre) selectedItem = pre.id;
    }
    setEditing(state.editing);

    return {
      mode: "wall",
      setEditing: setEditing,
      sidebarHtml: sidebarHtml,
      wireSidebar: wireSidebar,
      placedIds: function () { var o = {}; state.placements.forEach(function (p) { if (p.assetId) o[p.assetId] = true; }); return o; },
      setSelected: function (id) {
        selectedId = id || null;
        var p = id ? state.placements.filter(function (x) { return x.assetId === id; })[0] : null;
        selectedItem = p ? p.id : null;
        redraw();
      },
      // The Delete key (map.js): the selected item comes off the wall.
      deleteSelected: function () {
        if (!state.editing || !selectedItem || !itemById(selectedItem)) return false;
        var id = selectedItem;
        selectedItem = null;
        if (selectedId) select(null, true);
        removeItem(id);
        return true;
      },
      // The Room canvas (topology-room.js): one Device List for both parts.
      whereIs: function (assetId) {
        var p = state.placements.filter(function (x) { return x.assetId === assetId; })[0];
        var w = p ? wallById(p.wallId) : null;
        return p ? (w ? w.name : "?") : null;
      },
      removeAsset: function (assetId) {
        if (!state.editing || !state.placements.some(function (p) { return p.assetId === assetId; })) return false;
        state.placements = state.placements.filter(function (p) { return p.assetId !== assetId; });
        changed();
        return true;
      },
      isEmpty: function () { return !state.walls.length; },
      cornerButtons: function () {
        return [
          { id: "topology-wall-zoom-in", label: "Zoom in", tip: "Draw the junction boxes larger", icon: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>', onClick: function () { zoom(1); } },
          { id: "topology-wall-zoom-out", label: "Zoom out", tip: "Draw the junction boxes smaller", icon: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>', onClick: function () { zoom(-1); } },
        ];
      },
      canUndo: function () { return state.history.index > 0; },
      canRedo: function () { return state.history.index < state.history.entries.length - 1; },
      undo: function () { if (state.history.index > 0) { state.history.index--; applySnapshot(state.history.entries[state.history.index]); } },
      redo: function () {
        if (state.history.index < state.history.entries.length - 1) { state.history.index++; applySnapshot(state.history.entries[state.history.index]); }
      },
      captureElement: function () { return strip; },
      destroy: function () { strip.innerHTML = ""; },
    };
  }

  window.PolarisTopologyWall = {
    render: render,
    // Pure helpers, exported for tests.
    _cellsOf: cellsOf,
    _overlaps: overlaps,
    _nearestFreeSpot: nearestFreeSpot,
    _rackFootprint: rackFootprint,
    _doubleArea: doubleArea,
  };
})();
