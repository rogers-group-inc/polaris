/**
 * public/js/topology-rack.js — the Device Map topology's RACK mode (business
 * rules 147, 149): rack elevations for one saved view.
 *
 *   window.PolarisTopologyRack.render(host, ctx) → instance
 *
 * Racks stand side by side, U1 at the bottom of each rail. In edit mode:
 *   - a device dragged from the details pane lands as a 1U block at the U
 *     under the pointer (or the nearest free U); "Cable management" is a
 *     placeholder item that can be dragged in any number of times;
 *   - a block's top / bottom edge resizes it and its body moves it, both a
 *     U at a time, stopping at a neighbour or the end of the rack;
 *   - a rack's header drags it among the racks; double-click its name to
 *     rename it and its "42U" to resize it; the Front / Back button turns it
 *     round; every rack after the first has an × to delete it; Add rack
 *     appends a 42U rack;
 *   - right-click a block: other face, half / full depth, remove.
 * A full-depth item occupies its U on both faces (the other face shows it as
 * a dashed outline); a half-depth one only its own.
 *
 * Cabling (business rule 179): every rack has a vertical cable manager on
 * each side and a trough on top unless its header menu turns one off; a
 * device or Third party box dropped beside a rack stands there full height
 * (a vertical PDU), outside the manager, using no U, two per side at most.
 * The links Layer 2 draws between devices shown here are routed sideways
 * into the nearer manager, up to the trough, along it and down into the
 * other device (automatic), or through the corners the operator dragged
 * (`cableRoutes`, keyed by Layer 2's edge path key, in strip pixels; a
 * route whose ends have moved falls back to automatic). Hover shows Layer
 * 2's link card; editing works as on Layer 2. The server re-checks the
 * same rules (topologyViewService → sanitizeRackPlacements). Racking a device
 * never changes its location codes.
 *
 * map.js owns the edit session; this module stages `racks` and
 * `rackPlacements` through ctx.stageViewPatch only.
 */
(function () {
  "use strict";

  var U_PX = 20;             // one rack unit on screen (must match map.css .topo-rack-rail span / .topo-rack-bay)
  var DEFAULT_UNITS = 42;
  var MAX_UNITS = 60;
  var HISTORY_MAX = 100;
  var DRAG_MIME = "application/x-polaris-asset";
  var CABLE_TOKEN = "__cable_management__";
  var THIRD_PARTY_TOKEN = "__third_party__";
  var THIRD_PARTY_LABEL = "Third party";
  var MAX_LABEL_LEN = 64;     // sanitizeRackPlacements' MAX_RACK_LABEL_LEN
  var TYPE_INITIALS = { firewall: "FW", switch: "SW", access_point: "AP", router: "RT", server: "SV", workstation: "PC", printer: "PR" };
  var SIDE_SLOTS = 2;          // items beside a rack, per side (rule 179; the server's MAX_SIDE_SLOTS)
  var SVG_NS = "http://www.w3.org/2000/svg";
  var MAX_BENDS = 24;

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s))
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }
  function newId(prefix) {
    var s = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID().replace(/-/g, "").slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return prefix + "-" + s;
  }

  // ── Occupancy (pure) ─────────────────────────────────────────────────────
  function faces(p) { return p.fullDepth ? ["front", "rear"] : [p.face]; }
  function isSide(p) { return !!p && p.mount === "side"; }
  function managersOf(r) {
    var m = (r && r.cableManagers) || {};
    return { left: m.left !== false, right: m.right !== false, trough: m.trough !== false };
  }
  function opposite(side) { return side === "left" ? "right" : "left"; }

  // ── Cable routing (pure; rule 179) ─────────────────────────────────────
  // Geometry is in strip pixels. A rack: { index, head:{y0}, trough:{x0,x1,y0,y1}|null,
  // vcm:{left:{x0,x1}|null, right:{x0,x1}|null}, body:{x0,x1} } with SCREEN sides.
  // An end: { x0, x1, y0, y1, rackId, mgr: "left"|"right" (forced for a side item) }.
  function makeLanes() { return { mgr: {}, trough: 0, top: 0, port: {} }; }
  function laneX(rack, side, lanes, rackId) {
    var key = rackId + "|" + side;
    var n = lanes.mgr[key] = (lanes.mgr[key] || 0) + 1;
    var m = rack.vcm[side];
    if (m) {
      var k = Math.max(1, Math.floor((m.x1 - m.x0 - 10) / 4) + 1);
      return m.x0 + 5 + ((n - 1) % k) * 4;
    }
    // No manager on that side: just outside the rack.
    return side === "left" ? rack.body.x0 - 6 - ((n - 1) % 4) * 3 : rack.body.x1 + 6 + ((n - 1) % 4) * 3;
  }
  function portY(end, lanes, key) {
    var n = lanes.port[key] = (lanes.port[key] || 0) + 1;
    var offs = [0, -4, 4, -8, 8, -12, 12];
    var cy = (end.y0 + end.y1) / 2 + offs[(n - 1) % offs.length];
    return Math.max(end.y0 + 3, Math.min(end.y1 - 3, cy));
  }
  // The manager each end runs in: a side item's own; else the one facing
  // the other end's rack (any, in the same rack), falling back to the
  // other side when that one is off.
  function pickManager(end, rack, otherRack) {
    if (end.mgr) return end.mgr;
    var want = !otherRack || otherRack === rack ? "right" : (otherRack.index > rack.index ? "right" : "left");
    if (rack.vcm[want]) return want;
    if (rack.vcm[opposite(want)]) return opposite(want);
    return want;
  }
  function autoRoute(a, b, racks, lanes, key) {
    var ra = racks[a.rackId], rb = racks[b.rackId];
    if (!ra || !rb) return null;
    var ma = pickManager(a, ra, rb);
    var mb = a.rackId === b.rackId && !b.mgr ? ma : pickManager(b, rb, ra);
    // A rack item leaves on its side facing the manager; a side item on the side facing the rack.
    var exA = a.mgr ? (ma === "left" ? a.x1 : a.x0) : (ma === "left" ? a.x0 : a.x1);
    var exB = b.mgr ? (mb === "left" ? b.x1 : b.x0) : (mb === "left" ? b.x0 : b.x1);
    var ya = portY(a, lanes, key + "|a"), yb = portY(b, lanes, key + "|b");
    var xa = laneX(ra, ma, lanes, a.rackId);
    if (a.rackId === b.rackId && ma === mb) return [[exA, ya], [xa, ya], [xa, yb], [exB, yb]];
    var xb = laneX(rb, mb, lanes, b.rackId);
    var ty;
    if (ra.trough && rb.trough) {
      var tk = Math.max(1, Math.floor((ra.trough.y1 - ra.trough.y0 - 6) / 3) + 1);
      ty = ra.trough.y0 + 4 + (lanes.trough++ % tk) * 3;
    } else {
      ty = Math.min(ra.head.y0, rb.head.y0) - 6 - (lanes.top++ % 6) * 3;
    }
    return [[exA, ya], [xa, ya], [xa, ty], [xb, ty], [xb, yb], [exB, yb]];
  }
  // Where an end stands now: what a saved route remembers, so a route whose
  // devices moved (another U, another rack, a rack reordered) is not reused.
  function endSig(end) {
    return end.rackId + ":" + Math.round(end.x0) + ":" + Math.round(end.y0) + ":" + Math.round(end.y1);
  }
  // A saved end: a side of the device and how far down it.
  function endPoint(end, at) {
    var x = at.side === "left" ? end.x0 : end.x1;
    return [x, end.y0 + Math.max(0, Math.min(1, at.f)) * (end.y1 - end.y0)];
  }
  function nearestEnd(end, px, py) {
    var side = px < (end.x0 + end.x1) / 2 ? "left" : "right";
    var h = end.y1 - end.y0;
    return { side: side, f: h > 0 ? Math.max(0, Math.min(1, (py - end.y0) / h)) : 0.5 };
  }
  // The bend a drag at P inserts before: the segment of the polyline nearest P.
  function insertAt(pts, P) {
    var best = 0, bestD = Infinity;
    for (var i = 0; i < pts.length - 1; i++) {
      var A = pts[i], B = pts[i + 1];
      var dx = B[0] - A[0], dy = B[1] - A[1], L2 = dx * dx + dy * dy;
      var t = L2 ? Math.max(0, Math.min(1, ((P[0] - A[0]) * dx + (P[1] - A[1]) * dy) / L2)) : 0;
      var ex = A[0] + t * dx - P[0], ey = A[1] + t * dy - P[1];
      var d = ex * ex + ey * ey;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best; // bends index = segment index (bend i sits between pts[i] and pts[i+1])
  }
  // Is [startU, startU + heightU) on the faces `cand` occupies free in its
  // rack, ignoring the placement `ignoreId`?
  function fits(placements, racks, cand, ignoreId) {
    var rack = null;
    racks.forEach(function (r) { if (r.id === cand.rackId) rack = r; });
    if (!rack) return false;
    if (cand.startU < 1 || cand.heightU < 1 || cand.startU + cand.heightU - 1 > rack.units) return false;
    var mine = faces(cand);
    return !placements.some(function (p) {
      if (p.id === ignoreId || p.rackId !== cand.rackId || isSide(p)) return false;
      var shared = faces(p).some(function (f) { return mine.indexOf(f) !== -1; });
      if (!shared) return false;
      return p.startU < cand.startU + cand.heightU && cand.startU < p.startU + p.heightU;
    });
  }
  // The free 1U slot nearest `wantU` on that rack face, or null.
  function nearestFreeU(placements, racks, rackId, face, wantU, heightU, fullDepth, ignoreId) {
    var rack = null;
    racks.forEach(function (r) { if (r.id === rackId) rack = r; });
    if (!rack) return null;
    var h = heightU || 1;
    for (var d = 0; d <= rack.units; d++) {
      var tries = d === 0 ? [wantU] : [wantU + d, wantU - d];
      for (var i = 0; i < tries.length; i++) {
        var u = tries[i];
        if (fits(placements, racks, { rackId: rackId, face: face, startU: u, heightU: h, fullDepth: fullDepth }, ignoreId)) return u;
      }
    }
    return null;
  }

  function render(host, ctx) {
    var R = window.PolarisTopologyRender;
    var data = ctx.data || {};
    var view = ctx.view || {};
    var staged = ctx.stagedViewPatch() || {};
    var state = {
      editing: !!ctx.editing,
      racks: JSON.parse(JSON.stringify(staged.racks || view.racks || [])),
      placements: JSON.parse(JSON.stringify(staged.rackPlacements || view.rackPlacements || [])),
      routes: JSON.parse(JSON.stringify(staged.cableRoutes || view.cableRoutes || {})),
      history: { entries: [], index: -1 },
    };
    state.racks.sort(function (a, b) { return a.order - b.order; });
    state.racks.forEach(function (r) { if (r.face !== "rear") r.face = "front"; r.cableManagers = managersOf(r); });
    state.placements.forEach(function (p) {
      if (p.mount !== "side") { p.mount = "rack"; p.side = null; p.slot = null; }
    });

    var nodeById = {};
    var edges = [];
    if (R) {
      R.buildTopologyElements(data, { shownTypes: ctx.shownTypes }).forEach(function (el) {
        if (!el.data.source) nodeById[el.data.id] = el.data;
        else edges.push(el.data);
      });
    }
    var EE = window.PolarisTopologyEdgeEditor || null;
    var pathKeyById = {};
    if (EE) EE.assignPathKeys(edges).forEach(function (k, i) { pathKeyById[edges[i].id] = k; });
    function family() { return typeof isLightTheme === "function" && isLightTheme() ? "light" : "dark"; }

    host.innerHTML = '<div class="topo-rack-strip" tabindex="-1"></div>';
    var strip = host.firstChild;

    // "rear" is the stored value; the screen says Back.
    function faceWord(f) { return f === "rear" ? "Back" : "Front"; }
    function rackById(id) { return state.racks.filter(function (r) { return r.id === id; })[0] || null; }
    function assetOf(p) { return p.kind === "asset" ? nodeById[p.assetId] : null; }

    var listFilter = "";        // the Device List's filter text, kept across pane redraws
    var selectedId = ctx.selectedId ? ctx.selectedId() : null;
    // The selected device: its block is ringed and map.js fills the details
    // pane's info card with it.
    // Classes only, never draw(): a redraw between the two clicks of a
    // double-click would swallow the dblclick (open / rename).
    function paintSelected() {
      Array.prototype.forEach.call(strip.querySelectorAll("[data-blk]"), function (el) {
        var p = state.placements.filter(function (x) { return x.id === el.getAttribute("data-blk"); })[0];
        el.classList.toggle("is-selected", !!(p && p.assetId && p.assetId === selectedId));
      });
    }
    function select(id) {
      selectedId = id || null;
      paintSelected();
      if (typeof ctx.selectAsset === "function") ctx.selectAsset(selectedId);
    }

    // ── Drawing ─────────────────────────────────────────────────────────
    function draw() {
      var html = state.racks.map(rackHtml).join("");
      if (state.editing) {
        html += '<button type="button" class="topo-rack-add btn btn-secondary" data-rack-add>' +
          '<span class="topo-rack-add-plus" aria-hidden="true">+</span>Add rack<span class="hint" style="margin:0">' + DEFAULT_UNITS + 'U</span></button>';
      }
      strip.innerHTML = html;
      drawCables();
      // The first draw can come before the strip is laid out: route again on the next frame.
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(function () { if (!cableGesture && strip.isConnected) drawCables(); });
    }
    // A rack's left and right as SEEN: on its back the rack's left is on the right.
    function screenSide(r, side) { return r.face === "rear" ? opposite(side) : side; }
    function sideHtml(r, scr) {
      var stored = screenSide(r, scr);
      var h = r.units * U_PX + 2;
      var items = state.placements.filter(function (p) { return isSide(p) && p.rackId === r.id && p.side === stored; });
      var cells = [];
      for (var slot = 0; slot < SIDE_SLOTS; slot++) {
        var p = items.filter(function (x) { return x.slot === slot; })[0];
        if (p) {
          var d = assetOf(p);
          var name = p.kind === "thirdParty" ? (p.label || THIRD_PARTY_LABEL) : d ? (d.label || p.assetId) : "Device not shown";
          var color = d && d.nodeColor ? d.nodeColor : null;
          cells.push('<div class="topo-rack-side-item' + (p.kind === "thirdParty" ? " is-third-party" : "") +
            (p.assetId && p.assetId === selectedId ? " is-selected" : "") + '" data-blk="' + esc(p.id) + '" style="height:' + h + 'px' +
            (color && p.kind === "asset" ? ";border-color:" + esc(color) : "") + '" title="' + esc(name) + ' — beside the rack">' +
            '<span>' + esc(name) + '</span></div>');
        } else if (state.editing) {
          cells.push('<div class="topo-rack-side-slot" data-side-zone="' + esc(r.id + "|" + stored + "|" + slot) + '" style="height:' + h + 'px" title="Drop a device here to stand it beside the rack"></div>');
        } else {
          cells.push('<div class="topo-rack-side-slot is-empty" style="height:' + h + 'px" aria-hidden="true"></div>');
        }
      }
      // Slot 0 stands next to the cable manager: outermost first on the left.
      // Both places are always laid out (empty ones blank when viewing), so
      // nothing moves between viewing and editing and a saved route stays put.
      if (scr === "left") cells.reverse();
      return '<div class="topo-rack-side" data-side="' + scr + '">' + cells.join("") + '</div>';
    }
    function rackHtml(r) {
      var bayH = r.units * U_PX;
      var rail = "";
      for (var u = r.units; u >= 1; u--) rail += '<span>' + u + '</span>';
      var cm = managersOf(r);
      var mgrL = cm[screenSide(r, "left")], mgrR = cm[screenSide(r, "right")];
      var blocks = state.placements.filter(function (p) { return p.rackId === r.id && !isSide(p); }).map(function (p) {
        var onFace = p.face === r.face;
        if (!onFace && !p.fullDepth) return "";
        return blockHtml(p, r, !onFace);
      }).join("");
      var first = state.racks.indexOf(r) === 0;
      var ed = state.editing;
      return '<section class="topo-rack" data-rack="' + esc(r.id) + '">' +
        '<header class="topo-rack-head"' + (ed ? ' data-rack-grip="' + esc(r.id) + '" title="Drag to move this rack"' : '') + '>' +
          '<span class="topo-rack-name"' + (ed ? ' data-rack-rename="' + esc(r.id) + '" title="Double-click to rename"' : '') + '>' + esc(r.name) + '</span>' +
          '<span class="topo-rack-units"' + (ed ? ' data-rack-resize="' + esc(r.id) + '" title="Double-click to change the size"' : '') + '>' + r.units + 'U</span>' +
          // The face button names the face on show; a click turns the rack round.
          '<button type="button" class="btn btn-secondary btn-sm topo-rack-face" data-rack-rotate="' + esc(r.id) + '" title="Show the ' +
            (r.face === "rear" ? "front" : "back") + ' of the rack">' + faceWord(r.face) + '</button>' +
          (ed ? '<button type="button" class="btn-icon topo-rack-delete" data-rack-delete="' + esc(r.id) + '" title="Delete this rack" aria-label="Delete ' + esc(r.name) + '">×</button>' : '') +
        '</header>' +
        '<div class="topo-rack-frame">' +
          sideHtml(r, "left") +
          '<div class="topo-rack-core">' +
            // A part turned off keeps its space (blank), so the rack never moves.
            (cm.trough ? '<div class="topo-rack-trough" data-trough="' + esc(r.id) + '" title="Cable trough"></div>' : '<div class="topo-rack-trough is-off" aria-hidden="true"></div>') +
            '<div class="topo-rack-mid">' +
              (mgrL ? '<div class="topo-rack-vcm" data-vcm="' + esc(r.id) + '|left" title="Vertical cable manager"></div>' : '<div class="topo-rack-vcm is-off" aria-hidden="true"></div>') +
              '<div class="topo-rack-body" data-rack-body="' + esc(r.id) + '">' +
                '<div class="topo-rack-rail" aria-hidden="true">' + rail + '</div>' +
                '<div class="topo-rack-bay" data-rack-bay="' + esc(r.id) + '" style="height:' + bayH + 'px">' + blocks + '</div>' +
              '</div>' +
              (mgrR ? '<div class="topo-rack-vcm" data-vcm="' + esc(r.id) + '|right" title="Vertical cable manager"></div>' : '<div class="topo-rack-vcm is-off" aria-hidden="true"></div>') +
            '</div>' +
          '</div>' +
          sideHtml(r, "right") +
        '</div>' +
      '</section>';
    }
    function blockHtml(p, r, ghost) {
      var top = (r.units - (p.startU + p.heightU - 1)) * U_PX;
      var h = p.heightU * U_PX;
      var d = assetOf(p);
      var name, meta, cls = "topo-rack-blk";
      if (p.kind === "cableManagement") {
        name = "Cable management";
        meta = p.heightU + "U";
        cls += " is-cable";
      } else if (p.kind === "thirdParty") {
        name = p.label || THIRD_PARTY_LABEL;
        meta = "third party · " + p.heightU + "U" + (p.fullDepth ? "" : " · half depth");
        cls += " is-third-party";
      } else {
        name = d ? (d.label || p.assetId) : "Device not shown";
        var t = d && R ? R.nodeAssetType(d) : "";
        meta = (t ? String(t).replace(/_/g, " ") + " · " : "") + p.heightU + "U" + (p.fullDepth ? "" : " · half depth");
      }
      if (ghost) { cls += " is-ghost"; name = name + " (" + faceWord(p.face).toLowerCase() + ")"; }
      if (p.assetId && p.assetId === selectedId) cls += " is-selected";
      var color = d && d.nodeColor ? d.nodeColor : null;
      return '<div class="' + cls + '" data-blk="' + esc(p.id) + '" style="top:' + top + 'px;height:' + h + 'px' +
        (color && !ghost && p.kind === "asset" ? ";border-color:" + esc(color) : "") + '">' +
        (state.editing && !ghost ? '<span class="topo-rack-grip-top" data-blk-edge="top" aria-hidden="true"></span>' : '') +
        // The device's icon (Server Settings → Customization), left of its name.
        (d && d.iconUrl && !ghost ? '<img class="topo-rack-blk-icon" src="' + esc(d.iconUrl) + '" alt="" aria-hidden="true">' : '') +
        '<span class="topo-rack-blk-name">' + esc(name) + '</span><span class="topo-rack-blk-meta">' + esc(meta) + '</span>' +
        (state.editing && !ghost ? '<span class="topo-rack-grip-bottom" data-blk-edge="bottom" aria-hidden="true"></span>' : '') +
      '</div>';
    }

    // ── Cables (rule 179) ───────────────────────────────────────────────
    var cables = {};        // pathKey → { e, pts, auto, a, b, sig }
    var cableSel = null;    // { pk, handle: null | "s" | "t" | bend index }
    var cableGesture = null;
    function rel(el) {
      var sb = strip.getBoundingClientRect(), b = el.getBoundingClientRect();
      var dx = strip.scrollLeft - sb.left, dy = strip.scrollTop - sb.top;
      return { x0: b.left + dx, x1: b.right + dx, y0: b.top + dy, y1: b.bottom + dy };
    }
    function stripPoint(clientX, clientY) {
      var sb = strip.getBoundingClientRect();
      return [clientX - sb.left + strip.scrollLeft, clientY - sb.top + strip.scrollTop];
    }
    // Every rack's and every shown device's box, in strip pixels.
    function geometry() {
      var racks = {}, ends = {};
      state.racks.forEach(function (r, i) {
        var sec = strip.querySelector('[data-rack="' + cssId(r.id) + '"]');
        if (!sec) return;
        var head = sec.querySelector(".topo-rack-head"), body = sec.querySelector("[data-rack-body]");
        var tr = sec.querySelector("[data-trough]");
        var l = sec.querySelector('[data-vcm$="|left"]'), rr = sec.querySelector('[data-vcm$="|right"]');
        racks[r.id] = { index: i, head: rel(head), body: rel(body), trough: tr ? rel(tr) : null, vcm: { left: l ? rel(l) : null, right: rr ? rel(rr) : null } };
      });
      state.placements.forEach(function (p) {
        if (p.kind !== "asset" || !p.assetId) return;
        var el = strip.querySelector('[data-blk="' + cssId(p.id) + '"]:not(.is-ghost)');
        if (!el) return;
        var g = rel(el);
        g.rackId = p.rackId;
        if (isSide(p)) {
          var r = rackById(p.rackId);
          g.mgr = r ? screenSide(r, p.side) : p.side; // a side item runs in the manager on its own side
        }
        ends[p.assetId] = g;
      });
      return { racks: racks, ends: ends };
    }
    function cssId(id) { return String(id).replace(/["\\]/g, "\\$&"); }
    var staleRoutes = [];
    function drawCables() {
      var old = strip.querySelector(".topo-cable-layer");
      if (old) old.remove();
      strip.querySelectorAll(".topo-cable-handle").forEach(function (h) { h.remove(); });
      cables = {};
      staleRoutes = [];
      if (!R || !edges.length) return;
      var geo = geometry();
      var svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "topo-cable-layer");
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("width", String(strip.scrollWidth));
      svg.setAttribute("height", String(strip.scrollHeight));
      // The overhead bridge between neighbouring troughs.
      for (var i = 0; i + 1 < state.racks.length; i++) {
        var ga = geo.racks[state.racks[i].id], gb = geo.racks[state.racks[i + 1].id];
        if (!ga || !gb || !ga.trough || !gb.trough || gb.trough.x0 <= ga.trough.x1) continue;
        var br = document.createElementNS(SVG_NS, "rect");
        br.setAttribute("class", "topo-cable-bridge");
        br.setAttribute("x", String(ga.trough.x1));
        br.setAttribute("y", String(ga.trough.y0 + 3));
        br.setAttribute("width", String(gb.trough.x0 - ga.trough.x1));
        br.setAttribute("height", String(Math.max(4, ga.trough.y1 - ga.trough.y0 - 6)));
        svg.appendChild(br);
      }
      var lanes = makeLanes();
      edges.forEach(function (e) {
        var a = geo.ends[e.source], b = geo.ends[e.target], pk = pathKeyById[e.id];
        if (!a || !b || !pk) return;
        var sig = endSig(a) + "|" + endSig(b);
        var saved = state.routes[pk];
        var pts, auto = true;
        if (saved && saved.sig === sig) {
          var autoPts = autoRoute(a, b, geo.racks, lanes, pk);
          var s = saved.s ? endPoint(a, saved.s) : autoPts[0];
          var t = saved.t ? endPoint(b, saved.t) : autoPts[autoPts.length - 1];
          pts = [s].concat(saved.bends.map(function (q) { return [q[0], q[1]]; }), [t]);
          auto = false;
        } else {
          if (saved) staleRoutes.push(pk);
          pts = autoRoute(a, b, geo.racks, lanes, pk);
        }
        if (!pts) return;
        cables[pk] = { e: e, pts: pts, auto: auto, a: a, b: b, sig: sig };
        var st = R.edgeLineStyle(e, family());
        var on = cableSel && cableSel.pk === pk;
        var line = document.createElementNS(SVG_NS, "polyline");
        line.setAttribute("class", "topo-cable" + (on ? " is-selected" : ""));
        line.setAttribute("points", pts.map(function (q) { return q[0] + "," + q[1]; }).join(" "));
        line.setAttribute("stroke", st.color);
        line.setAttribute("stroke-width", String(on ? st.width + 2 : st.width));
        if (st.dash) line.setAttribute("stroke-dasharray", st.dash);
        svg.appendChild(line);
        var hit = document.createElementNS(SVG_NS, "polyline");
        hit.setAttribute("class", "topo-cable-hit");
        hit.setAttribute("points", line.getAttribute("points"));
        hit.setAttribute("data-cable", pk);
        svg.appendChild(hit);
      });
      strip.appendChild(svg);
      drawCableHandles();
    }
    // The selected cable's ends (round) and corners (square), edit mode only.
    function drawCableHandles() {
      strip.querySelectorAll(".topo-cable-handle").forEach(function (h) { h.remove(); });
      if (!cableSel || !state.editing) return;
      var c = cables[cableSel.pk];
      if (!c) { cableSel = null; return; }
      c.pts.forEach(function (q, i) {
        var part = i === 0 ? "s" : i === c.pts.length - 1 ? "t" : i - 1;
        var end = part === "s" || part === "t";
        // An automatic route's corners are offered too: dragging one keeps the route.
        var h = document.createElement("div");
        h.className = "topo-link-handle topo-cable-handle" + (end ? " is-end" : "") + (cableSel.handle === part ? " is-selected" : "");
        h.style.left = q[0] + "px";
        h.style.top = q[1] + "px";
        h.setAttribute("data-cable-handle", String(part));
        strip.appendChild(h);
      });
    }
    // The route as it stands, made editable: its corners become stored bends.
    function routeOf(pk) {
      var c = cables[pk];
      var saved = state.routes[pk];
      if (saved && saved.sig === c.sig) return saved;
      var r = { bends: c.pts.slice(1, -1).map(function (q) { return [q[0], q[1]]; }), sig: c.sig };
      state.routes[pk] = r;
      return r;
    }
    var tipCy = { getElementById: function (id) { return { data: function (k) { return (nodeById[id] || {})[k]; } }; } };
    strip.addEventListener("pointerover", function (e) {
      var hit = e.target.closest && e.target.closest("[data-cable]");
      if (!hit || cableGesture || !ctx.linkTip) return;
      var c = cables[hit.getAttribute("data-cable")];
      var html = c && R.edgeTooltipHtml ? R.edgeTooltipHtml(tipCy, { data: function (k) { return c.e[k]; } }) : null;
      if (html) ctx.linkTip.show(html, e.clientX, e.clientY);
    });
    strip.addEventListener("pointermove", function (e) {
      if (ctx.linkTip && e.target.closest && e.target.closest("[data-cable]") && !cableGesture) ctx.linkTip.move(e.clientX, e.clientY);
    });
    strip.addEventListener("pointerout", function (e) {
      if (ctx.linkTip && e.target.closest && e.target.closest("[data-cable]")) ctx.linkTip.hide();
    });
    // Press a cable (edit mode): a drag adds a corner under the pointer and
    // moves it; a click selects the cable. Press a handle: drag it.
    strip.addEventListener("pointerdown", function (e) {
      if (!state.editing || e.button !== 0) return;
      var hit = e.target.closest && e.target.closest("[data-cable]");
      var handle = e.target.closest && e.target.closest("[data-cable-handle]");
      if (!hit && !handle) return;
      e.preventDefault();
      e.stopPropagation();
      if (ctx.linkTip) ctx.linkTip.hide();
      var pk = hit ? hit.getAttribute("data-cable") : cableSel && cableSel.pk;
      if (!pk || !cables[pk]) return;
      var part = handle ? handle.getAttribute("data-cable-handle") : null;
      if (part !== null && part !== "s" && part !== "t") part = Number(part);
      cableGesture = { pk: pk, part: part, start: stripPoint(e.clientX, e.clientY), moved: false, before: JSON.stringify(state.routes[pk] || null) };
      if (handle) { cableSel = { pk: pk, handle: part }; drawCableHandles(); }
      window.addEventListener("pointermove", onCableMove, true);
      window.addEventListener("pointerup", onCableUp, true);
    }, true);
    function onCableMove(e) {
      var g = cableGesture;
      if (!g) return;
      var P = stripPoint(e.clientX, e.clientY);
      if (!g.moved) {
        if (Math.abs(P[0] - g.start[0]) + Math.abs(P[1] - g.start[1]) < 4) return;
        g.moved = true;
        var r = routeOf(g.pk);
        if (g.part === null) {
          if (r.bends.length >= MAX_BENDS) return;
          var c = cables[g.pk];
          var idx = insertAt(c.pts, g.start);
          r.bends.splice(idx, 0, [g.start[0], g.start[1]]);
          g.part = idx;
        }
        cableSel = { pk: g.pk, handle: g.part };
      }
      var route = state.routes[g.pk], cb = cables[g.pk];
      if (!route || !cb) return;
      if (g.part === "s") route.s = nearestEnd(cb.a, P[0], P[1]);
      else if (g.part === "t") route.t = nearestEnd(cb.b, P[0], P[1]);
      else route.bends[g.part] = [Math.round(P[0]), Math.round(P[1])];
      drawCables();
    }
    function onCableUp() {
      window.removeEventListener("pointermove", onCableMove, true);
      window.removeEventListener("pointerup", onCableUp, true);
      var g = cableGesture;
      cableGesture = null;
      if (!g) return;
      // The click after the release must not reach the strip (it clears the selection).
      var eat = function (ce) { ce.stopPropagation(); ce.preventDefault(); };
      window.addEventListener("click", eat, true);
      setTimeout(function () { window.removeEventListener("click", eat, true); }, 0);
      if (!g.moved) {
        cableSel = { pk: g.pk, handle: typeof g.part === "number" || g.part === "s" || g.part === "t" ? g.part : null };
        drawCables();
        return;
      }
      changed();
    }
    // Delete on a selected corner removes it; on an end, the end goes back to automatic.
    function deleteCableHandle() {
      if (!state.editing || !cableSel || cableSel.handle === null || cableSel.handle === undefined) return false;
      var r = state.routes[cableSel.pk];
      if (!r) { cableSel.handle = null; drawCables(); return true; }
      if (cableSel.handle === "s" || cableSel.handle === "t") delete r[cableSel.handle];
      else r.bends.splice(cableSel.handle, 1);
      cableSel.handle = null;
      changed();
      return true;
    }
    function resetRoutes(keys) {
      var n = 0;
      keys.forEach(function (k) { if (state.routes[k]) { delete state.routes[k]; n++; } });
      if (n) changed(); else drawCables();
    }

    // ── Geometry helpers ────────────────────────────────────────────────
    // The U under a client y inside a rack's bay (clamped to the rack).
    function uAt(bay, rack, clientY) {
      var box = bay.getBoundingClientRect();
      var fromTop = Math.floor((clientY - box.top) / U_PX);
      var u = rack.units - fromTop;
      return Math.max(1, Math.min(rack.units, u));
    }
    function bayAt(clientX, clientY) {
      var el = document.elementFromPoint(clientX, clientY);
      var bay = el && el.closest ? el.closest("[data-rack-bay]") : null;
      if (!bay || !strip.contains(bay)) return null;
      return bay;
    }

    // ── Drop from the details pane ──────────────────────────────────────
    function sideZoneAt(clientX, clientY) {
      var el = document.elementFromPoint(clientX, clientY);
      var z = el && el.closest ? el.closest("[data-side-zone]") : null;
      return z && strip.contains(z) ? z : null;
    }
    var dropHint = null;
    function markDrop(z) {
      if (dropHint && dropHint !== z) dropHint.classList.remove("is-drop");
      dropHint = z;
      if (z) z.classList.add("is-drop");
    }
    strip.addEventListener("dragover", function (e) {
      if (!state.editing) return;
      var types = e.dataTransfer && e.dataTransfer.types;
      if (!types || Array.prototype.indexOf.call(types, DRAG_MIME) === -1) return;
      var zone = sideZoneAt(e.clientX, e.clientY);
      markDrop(zone);
      if (zone || bayAt(e.clientX, e.clientY)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    strip.addEventListener("dragleave", function (e) { if (!strip.contains(e.relatedTarget)) markDrop(null); });
    strip.addEventListener("drop", function (e) {
      if (!state.editing) return;
      markDrop(null);
      var token = e.dataTransfer && e.dataTransfer.getData(DRAG_MIME);
      var zone = sideZoneAt(e.clientX, e.clientY);
      var bay = zone ? null : bayAt(e.clientX, e.clientY);
      if (!token || (!bay && !zone)) return;
      e.preventDefault();
      var rack = rackById(zone ? zone.getAttribute("data-side-zone").split("|")[0] : bay.getAttribute("data-rack-bay"));
      if (!rack) return;
      var isCable = token === CABLE_TOKEN;
      var isThird = token === THIRD_PARTY_TOKEN;
      if (!isCable && !isThird && state.placements.some(function (p) { return p.assetId === token; })) {
        ctx.toast("That device is already racked in this view", "error");
        return;
      }
      // A device is in one place in a room: a rack or a junction box.
      var elsewhere = !isCable && !isThird && ctx.placedElsewhere ? ctx.placedElsewhere(token) : null;
      if (elsewhere) { ctx.toast("That device is already in " + elsewhere + ": remove it there first", "error"); return; }
      // Rule 179: beside the rack, outside its cable manager, using no U.
      if (zone) {
        if (isCable) { ctx.toast("Cable management goes in the rack", "error"); return; }
        var zp = zone.getAttribute("data-side-zone").split("|");
        var beside = {
          id: newId(isThird ? "tp" : "rp"),
          kind: isThird ? "thirdParty" : "asset",
          assetId: isThird ? null : token,
          label: isThird ? THIRD_PARTY_LABEL : null,
          rackId: rack.id, face: rack.face, startU: 1, heightU: 1, fullDepth: false,
          mount: "side", side: zp[1], slot: Number(zp[2]),
        };
        state.placements.push(beside);
        changed();
        if (isThird) renameThirdParty(beside);
        return;
      }
      // Half depth by default (operator request 2026-11-10): a device racked
      // on the front leaves the same U free on the back. Full depth is the
      // right-click opt-in for gear that fills the rack.
      var fullDepth = false;
      var u = nearestFreeU(state.placements, state.racks, rack.id, rack.face, uAt(bay, rack, e.clientY), 1, fullDepth, null);
      if (u == null) { ctx.toast(rack.name + " has no free U", "error"); return; }
      var placed = {
        id: newId(isCable ? "cm" : isThird ? "tp" : "rp"),
        kind: isCable ? "cableManagement" : isThird ? "thirdParty" : "asset",
        assetId: isCable || isThird ? null : token,
        label: isThird ? THIRD_PARTY_LABEL : null,
        rackId: rack.id,
        face: rack.face,
        startU: u,
        heightU: 1,
        fullDepth: fullDepth,
        mount: "rack",
        side: null,
        slot: null,
      };
      state.placements.push(placed);
      changed();
      // A third-party box is named on the spot: the placeholder name says nothing.
      if (isThird) renameThirdParty(placed);
    });

    // ── Pointer gestures: block move / resize, rack reorder ─────────────
    var gesture = null;
    strip.addEventListener("pointerdown", function (e) {
      if (!state.editing || e.button !== 0) return;
      var grip = e.target.closest("[data-rack-grip]");
      if (grip && !e.target.closest("button")) {
        startRackDrag(e, grip.getAttribute("data-rack-grip"));
        return;
      }
      var blkEl = e.target.closest("[data-blk]");
      if (!blkEl || blkEl.classList.contains("is-ghost")) return;
      var p = state.placements.filter(function (x) { return x.id === blkEl.getAttribute("data-blk"); })[0];
      if (!p || isSide(p)) return;
      var edge = e.target.getAttribute("data-blk-edge");
      e.preventDefault();
      // Captured on the first real move (as the rack drag is): an early
      // capture retargets a block's dblclick (open / rename) to the strip.
      gesture = { kind: edge ? "resize-" + edge : "move", p: p, orig: Object.assign({}, p), el: blkEl, moved: false, startY: e.clientY, pointerId: e.pointerId };
    });
    strip.addEventListener("pointermove", function (e) {
      if (!gesture) return;
      if (gesture.kind === "rack") { moveRackDrag(e); return; }
      var p = gesture.p, o = gesture.orig;
      if (!gesture.moved && Math.abs(e.clientY - gesture.startY) > 3) {
        gesture.moved = true;
        try { strip.setPointerCapture(gesture.pointerId); } catch (_) { /* pointer already gone */ }
      }
      if (!gesture.moved) return;
      var next;
      if (gesture.kind === "move") {
        var bay = bayAt(e.clientX, e.clientY);
        if (!bay) return;
        var rack = rackById(bay.getAttribute("data-rack-bay"));
        // Grab offset: keep the U under the pointer where it was grabbed.
        if (gesture.grabOffset == null) {
          var origRack = rackById(o.rackId);
          var origBay = strip.querySelector('[data-rack-bay="' + o.rackId + '"]');
          gesture.grabOffset = origBay && origRack ? uAt(origBay, origRack, gesture.startY) - o.startU : 0;
        }
        var start = uAt(bay, rack, e.clientY) - gesture.grabOffset;
        start = Math.max(1, Math.min(rack.units - o.heightU + 1, start));
        next = { rackId: rack.id, face: rack.id === o.rackId ? o.face : rack.face, startU: start, heightU: o.heightU, fullDepth: o.fullDepth };
      } else {
        var rk = rackById(o.rackId);
        var bayEl = strip.querySelector('[data-rack-bay="' + o.rackId + '"]');
        if (!rk || !bayEl) return;
        var u = uAt(bayEl, rk, e.clientY);
        var top = o.startU + o.heightU - 1;
        if (gesture.kind === "resize-top") {
          var newTop = Math.max(o.startU, u);
          next = { rackId: o.rackId, face: o.face, startU: o.startU, heightU: newTop - o.startU + 1, fullDepth: o.fullDepth };
        } else {
          var newStart = Math.min(top, u);
          next = { rackId: o.rackId, face: o.face, startU: newStart, heightU: top - newStart + 1, fullDepth: o.fullDepth };
        }
      }
      if (!fits(state.placements, state.racks, next, p.id)) return; // stops at a neighbour
      if (next.rackId === p.rackId && next.startU === p.startU && next.heightU === p.heightU) return;
      p.rackId = next.rackId; p.face = next.face; p.startU = next.startU; p.heightU = next.heightU;
      draw();
    });
    function endGesture(e) {
      if (!gesture) return;
      var g = gesture;
      gesture = null;
      try { strip.releasePointerCapture(e.pointerId); } catch (x) { /* already released */ }
      if (g.kind === "rack") { if (g.moved) endRackDrag(); return; } // a click is not a move: no redraw, no undo step
      var p = g.p, o = g.orig;
      if (p.rackId !== o.rackId || p.startU !== o.startU || p.heightU !== o.heightU || p.face !== o.face) changed();
    }
    strip.addEventListener("pointerup", endGesture);
    strip.addEventListener("pointercancel", endGesture);

    function startRackDrag(e, rackId) {
      e.preventDefault();
      // The pointer is captured and the rack dimmed only once it MOVES: an
      // early capture retargeted the header's dblclick to the strip, so a
      // double-click on the name / "42U" never reached them.
      gesture = { kind: "rack", rackId: rackId, startX: e.clientX, moved: false, pointerId: e.pointerId, order: state.racks.map(function (r) { return r.id; }) };
    }
    function moveRackDrag(e) {
      if (!gesture.moved && Math.abs(e.clientX - gesture.startX) > 4) {
        gesture.moved = true;
        try { strip.setPointerCapture(gesture.pointerId); } catch (_) { /* pointer already gone */ }
        var sec0 = strip.querySelector('[data-rack="' + gesture.rackId + '"]');
        if (sec0) sec0.classList.add("is-dragging");
      }
      if (!gesture.moved) return;
      // The rack's new slot: count the OTHER racks whose centre is left of the pointer.
      var others = state.racks.filter(function (r) { return r.id !== gesture.rackId; });
      var slot = 0;
      others.forEach(function (r) {
        var sec = strip.querySelector('[data-rack="' + r.id + '"]');
        if (!sec) return;
        var b = sec.getBoundingClientRect();
        if (e.clientX > b.left + b.width / 2) slot++;
      });
      var moving = rackById(gesture.rackId);
      var next = others.slice(0, slot).concat([moving], others.slice(slot));
      if (next.map(function (r) { return r.id; }).join() === state.racks.map(function (r) { return r.id; }).join()) return;
      state.racks = next;
      state.racks.forEach(function (r, i) { r.order = i; });
      draw();
      var sec2 = strip.querySelector('[data-rack="' + gesture.rackId + '"]');
      if (sec2) sec2.classList.add("is-dragging");
    }
    function endRackDrag() {
      var sec = strip.querySelector(".topo-rack.is-dragging");
      if (sec) sec.classList.remove("is-dragging");
      changed();
    }

    // ── Clicks: rotate, add, edit rack, open, block menu ────────────────
    strip.addEventListener("click", function (e) {
      var rot = e.target.closest("[data-rack-rotate]");
      if (rot) {
        var r = rackById(rot.getAttribute("data-rack-rotate"));
        if (!r) return;
        r.face = r.face === "rear" ? "front" : "rear";
        // Rotating while viewing is just a look; while editing it is saved.
        if (state.editing) changed(); else draw();
        return;
      }
      var blkSel = e.target.closest("[data-blk]");
      if (blkSel) {
        var bp = state.placements.filter(function (x) { return x.id === blkSel.getAttribute("data-blk"); })[0];
        if (bp && bp.assetId && bp.assetId !== selectedId) select(bp.assetId);
        return;
      }
      if (!e.target.closest("button, [data-rack-grip], [data-cable], [data-cable-handle]") && cableSel) { cableSel = null; drawCables(); }
      if (!e.target.closest("button, [data-rack-grip]") && selectedId) { select(null); return; }
      var del = e.target.closest("[data-rack-delete]");
      if (del) { deleteRack(rackById(del.getAttribute("data-rack-delete"))); return; }
      if (e.target.closest("[data-rack-add]")) {
        if (!state.editing) return;
        state.racks.push({ id: newId("rack"), name: "Rack " + (state.racks.length + 1), units: DEFAULT_UNITS, order: state.racks.length, face: "front",
          cableManagers: { left: true, right: true, trough: true } });
        changed();
        strip.scrollLeft = strip.scrollWidth;
      }
    });
    strip.addEventListener("dblclick", function (e) {
      var blkEl = e.target.closest("[data-blk]");
      if (blkEl) {
        var p = state.placements.filter(function (x) { return x.id === blkEl.getAttribute("data-blk"); })[0];
        if (p && p.kind === "asset") ctx.openAsset(p.assetId);
        else if (p && p.kind === "thirdParty" && state.editing) renameThirdParty(p);
        return;
      }
      if (!state.editing) return;
      var nm = e.target.closest("[data-rack-rename]");
      if (nm) { editRack(rackById(nm.getAttribute("data-rack-rename")), "name"); return; }
      var sz = e.target.closest("[data-rack-resize]");
      if (sz) editRack(rackById(sz.getAttribute("data-rack-resize")), "units");
    });
    strip.addEventListener("contextmenu", function (e) {
      if (!state.editing || typeof showRowMenu !== "function") return;
      var hitEl = e.target.closest("[data-cable]");
      if (hitEl) {
        e.preventDefault();
        var ck = hitEl.getAttribute("data-cable");
        showRowMenu(hitEl, [
          { heading: "Cable" },
          { label: "Reset route", disabled: !state.routes[ck], title: state.routes[ck] ? "Route it automatically again" : "It is routed automatically",
            onSelect: function () { resetRoutes([ck]); } },
        ], { menuAt: { x: e.clientX, y: e.clientY }, label: "Cable" });
        return;
      }
      var head = e.target.closest("[data-rack-grip]");
      if (head && !e.target.closest("button")) {
        e.preventDefault();
        var hr = rackById(head.getAttribute("data-rack-grip"));
        if (!hr) return;
        var cm = managersOf(hr);
        var toggle = function (k) {
          return function () { hr.cableManagers = Object.assign(managersOf(hr), {}); hr.cableManagers[k] = !cm[k]; changed(); };
        };
        var mine = Object.keys(cables).filter(function (k) { return cables[k].a.rackId === hr.id || cables[k].b.rackId === hr.id; });
        showRowMenu(head, [
          { heading: hr.name },
          { label: (cm.left ? "✓ " : "") + "Left cable manager", title: "Seen from the front", onSelect: toggle("left") },
          { label: (cm.right ? "✓ " : "") + "Right cable manager", title: "Seen from the front", onSelect: toggle("right") },
          { label: (cm.trough ? "✓ " : "") + "Top trough", onSelect: toggle("trough") },
          { label: "Reset cable routes", disabled: !mine.some(function (k) { return state.routes[k]; }), title: "Route this rack's cables automatically again",
            onSelect: function () { resetRoutes(mine); } },
        ], { menuAt: { x: e.clientX, y: e.clientY }, label: "Rack" });
        return;
      }
      var blkEl = e.target.closest("[data-blk]");
      if (!blkEl) return;
      e.preventDefault();
      var p = state.placements.filter(function (x) { return x.id === blkEl.getAttribute("data-blk"); })[0];
      if (!p) return;
      if (isSide(p)) {
        var sd = assetOf(p);
        var otherSide = opposite(p.side);
        var free = [0, 1].filter(function (s) {
          return !state.placements.some(function (x) { return isSide(x) && x.rackId === p.rackId && x.side === otherSide && x.slot === s; });
        });
        var sideItems = [{ heading: p.kind === "thirdParty" ? (p.label || THIRD_PARTY_LABEL) : (sd ? sd.label : "Device") }];
        if (p.kind === "asset") sideItems.push({ label: "Open", onSelect: function () { ctx.openAsset(p.assetId); } });
        if (p.kind === "thirdParty") sideItems.push({ label: "Rename", onSelect: function () { renameThirdParty(p); } });
        sideItems.push({ label: "Move to the other side", disabled: !free.length, title: free.length ? "" : "Both places on that side are taken",
          onSelect: function () { p.side = otherSide; p.slot = free[0]; changed(); } });
        sideItems.push({ label: "Remove", danger: true, onSelect: function () {
          state.placements = state.placements.filter(function (x) { return x.id !== p.id; });
          changed();
        } });
        showRowMenu(blkEl, sideItems, { menuAt: { x: e.clientX, y: e.clientY }, label: "Item beside the rack" });
        return;
      }
      var other = p.face === "front" ? "rear" : "front";
      var toOther = Object.assign({}, p, { face: other });
      var toggled = Object.assign({}, p, { fullDepth: !p.fullDepth });
      var d = assetOf(p);
      var items = [{ heading: p.kind === "cableManagement" ? "Cable management" : p.kind === "thirdParty" ? (p.label || THIRD_PARTY_LABEL) : (d ? d.label : "Device") }];
      if (p.kind === "asset") items.push({ label: "Open", onSelect: function () { ctx.openAsset(p.assetId); } });
      if (p.kind === "thirdParty") items.push({ label: "Rename", onSelect: function () { renameThirdParty(p); } });
      items.push({
        label: "Move to the " + faceWord(other).toLowerCase(), disabled: !fits(state.placements, state.racks, toOther, p.id),
        title: fits(state.placements, state.racks, toOther, p.id) ? "" : "That U is taken on the " + faceWord(other).toLowerCase(),
        onSelect: function () { p.face = other; changed(); },
      });
      items.push({
        label: p.fullDepth ? "Make half depth" : "Make full depth",
        disabled: !fits(state.placements, state.racks, toggled, p.id),
        title: p.fullDepth ? "Only this face is occupied — the other face's U is free" : "Occupies both faces",
        onSelect: function () { p.fullDepth = !p.fullDepth; changed(); },
      });
      items.push({ label: p.kind === "asset" ? "Remove from rack" : "Remove", danger: true, onSelect: function () {
        state.placements = state.placements.filter(function (x) { return x.id !== p.id; });
        changed();
      } });
      showRowMenu(blkEl, items, { menuAt: { x: e.clientX, y: e.clientY }, label: "Rack item" });
    });

    function renameThirdParty(p) {
      if (!p || !state.editing || typeof buildOverlay !== "function") return;
      var body =
        '<div class="form-group"><label for="topo-tp-name">Name</label>' +
        '<input id="topo-tp-name" type="text" maxlength="' + MAX_LABEL_LEN + '" value="' + esc(p.label || THIRD_PARTY_LABEL) + '">' +
        '<div class="hint">Equipment Polaris does not monitor, e.g. "ISP router" or "Patch panel A". Up to ' + MAX_LABEL_LEN + ' characters.</div></div>';
      var footer =
        '<button type="button" class="btn btn-secondary" data-tp="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-tp="ok">Apply</button>';
      var dlg = buildOverlay(1100, "Name this rack item", body, footer);
      var input = dlg.overlay.querySelector("#topo-tp-name");
      function apply() {
        var name = input.value.trim().replace(/\s+/g, " ");
        if (!name) { ctx.toast("Give it a name", "error"); return; }
        p.label = name.slice(0, MAX_LABEL_LEN);
        dlg.close();
        changed();
      }
      dlg.overlay.querySelector('[data-tp="cancel"]').addEventListener("click", dlg.close);
      dlg.overlay.querySelector('[data-tp="ok"]').addEventListener("click", apply);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); apply(); } });
      setTimeout(function () { try { input.focus(); input.select(); } catch (_) { /* closed */ } }, 0);
    }

    // Double-click on a rack's name (field "name") or its size ("units").
    function editRack(r, field) {
      if (!r || typeof buildOverlay !== "function") return;
      var isName = field !== "units";
      var body = isName
        ? '<div class="form-group"><label for="topo-rk-name">Name</label><input id="topo-rk-name" type="text" maxlength="60" value="' + esc(r.name) + '"></div>'
        : '<div class="form-group"><label for="topo-rk-units">Size (U)</label><input id="topo-rk-units" type="number" min="1" max="' + MAX_UNITS + '" value="' + r.units + '">' +
          '<div class="hint">1 to ' + MAX_UNITS + 'U. A rack can’t shrink below a racked item.</div></div>';
      var footer =
        '<button type="button" class="btn btn-secondary" data-rk="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-rk="ok">Apply</button>';
      var dlg = buildOverlay(1100, isName ? "Rename rack" : "Rack size", body, footer);
      var input = dlg.overlay.querySelector(isName ? "#topo-rk-name" : "#topo-rk-units");
      function apply() {
        if (isName) {
          var name = input.value.trim();
          if (!name) { ctx.toast("Give the rack a name", "error"); return; }
          r.name = name;
        } else {
          var units = Number(input.value);
          if (!Number.isInteger(units) || units < 1 || units > MAX_UNITS) { ctx.toast("The size must be 1 to " + MAX_UNITS + "U", "error"); return; }
          var stranded = state.placements.filter(function (p) { return p.rackId === r.id && !isSide(p) && p.startU + p.heightU - 1 > units; });
          if (stranded.length) {
            var names = stranded.slice(0, 3).map(itemName);
            ctx.toast("Move " + names.join(", ") + (stranded.length > 3 ? " and " + (stranded.length - 3) + " more" : "") + " below U" + (units + 1) + " first", "error");
            return;
          }
          r.units = units;
        }
        dlg.close();
        changed();
      }
      dlg.overlay.querySelector('[data-rk="cancel"]').addEventListener("click", dlg.close);
      dlg.overlay.querySelector('[data-rk="ok"]').addEventListener("click", apply);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); apply(); } });
      setTimeout(function () { try { input.focus(); input.select(); } catch (_) { /* closed */ } }, 0);
    }
    function itemName(p) {
      var d = assetOf(p);
      return p.kind === "cableManagement" ? "cable management" : p.kind === "thirdParty" ? (p.label || THIRD_PARTY_LABEL) : (d ? d.label : "a device");
    }
    // The × on every rack after the first. An empty rack goes at once; one
    // holding items asks first, naming how many go with it.
    async function deleteRack(r) {
      if (!r || !state.editing || state.racks.indexOf(r) < 0) return;
      var n = state.placements.filter(function (p) { return p.rackId === r.id; }).length;
      if (n) {
        var ok = typeof showConfirm === "function"
          ? await showConfirm('Delete "' + r.name + '" and the ' + n + " item" + (n === 1 ? "" : "s") + " in it?")
          : false;
        if (!ok) return;
      }
      state.racks = state.racks.filter(function (x) { return x.id !== r.id; });
      state.racks.forEach(function (x, i) { x.order = i; });
      state.placements = state.placements.filter(function (p) { return p.rackId !== r.id; });
      changed();
    }

    // ── Staging + history ───────────────────────────────────────────────
    function snapshot() { return JSON.stringify({ racks: state.racks, placements: state.placements, routes: state.routes }); }
    function stage() {
      ctx.stageViewPatch({ racks: state.racks, rackPlacements: state.placements, cableRoutes: state.routes });
      restageCodes();
    }
    var CODE_KEYS = ["area", "building", "floor", "room"];
    var locById = {};
    [data.fortigate].concat(data.switches || [], data.aps || [], data.endpoints || []).forEach(function (x) {
      if (x && x.id) locById[x.id] = x.location || null;
    });
    // Rule 150 (Room view): a device in a rack takes the view's room plus
    // that rack's name; rule 148(a): only the levels set here change.
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
        want.rack = (rackById(p.rackId) || {}).name || null;
        want.junctionBox = null;
        var levels = CODE_KEYS.filter(function (k) { return String(region[k] || "").trim(); }).concat(["rack", "junctionBox"]);
        var same = levels.every(function (k) { return String(want[k] || "").trim().toLowerCase() === String((cur && cur[k]) || "").trim().toLowerCase(); });
        if (!want.rack || same) { ctx.stageLocationCode(p.assetId, null); return; }
        var d = nodeById[p.assetId];
        ctx.stageLocationCode(p.assetId, want, { name: d ? d.label : p.assetId, from: cur || {}, levels: levels });
      });
      Object.keys(stagedAssets).forEach(function (id) { if (!now[id]) ctx.stageLocationCode(id, null); });
      stagedAssets = now;
    }
    function changed() {
      // Drawn first: a route whose devices moved is found stale and dropped.
      draw();
      staleRoutes.forEach(function (k) { delete state.routes[k]; });
      staleRoutes = [];
      stage();
      if (ctx.historyPushed) ctx.historyPushed();
      var h = state.history;
      h.entries = h.entries.slice(0, h.index + 1);
      h.entries.push(snapshot());
      if (h.entries.length > HISTORY_MAX) h.entries.shift();
      h.index = h.entries.length - 1;
      ctx.refreshSidebar();
      ctx.historyChanged();
    }
    function applySnapshot(s) {
      var o = JSON.parse(s);
      state.racks = o.racks;
      state.placements = o.placements;
      state.routes = o.routes || {};
      stage();
      draw();
      ctx.refreshSidebar();
      ctx.historyChanged();
    }

    function setEditing(on) {
      state.editing = !!on;
      if (!on) cableSel = null;
      host.classList.toggle("is-editing", !!on);
      if (on) {
        state.history = { entries: [snapshot()], index: 0 };
        ctx.historyChanged();
        // Devices already racked here owe the region's codes too (rule 150).
        restageCodes();
      }
      draw();
    }

    function sidebarHtml() {
      var DL = window.PolarisTopologyDeviceList;
      var racked = {};
      state.placements.forEach(function (p) { if (p.assetId) racked[p.assetId] = p; });
      function where(p) {
        var r = rackById(p.rackId);
        if (isSide(p)) return (r ? r.name : "?") + " · " + p.side + " side";
        var top = p.startU + p.heightU - 1;
        return (r ? r.name : "?") + " · U" + (p.heightU > 1 ? p.startU + "–" + top : p.startU);
      }
      var drag = state.editing;
      var items = '<div class="topology-section topo-rack-items"><h5>Rack items</h5><ul>' +
        '<li class="topo-device-row topo-rack-item-row"' + (drag ? ' draggable="true" data-place-asset="' + CABLE_TOKEN + '"' : '') + '>' +
          '<span class="topo-rack-cable-swatch" aria-hidden="true"></span><span class="topo-device-name">Cable management</span></li>' +
        '<li class="topo-device-row topo-rack-item-row"' + (drag ? ' draggable="true" data-place-asset="' + THIRD_PARTY_TOKEN + '"' : '') + '>' +
          '<span class="topo-rack-third-swatch" aria-hidden="true"></span><span class="topo-device-name">Third party</span></li>' +
        '</ul></div>';
      var rows = Object.keys(nodeById).map(function (id) {
        var d = nodeById[id];
        var t = R ? R.nodeAssetType(d) : "";
        return { id: id, label: d.label || id, inUse: !!racked[id],
          meta: racked[id] ? where(racked[id]) : String(t || "").replace(/_/g, " ") };
      }).sort(function (a, b) {
        return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: "base" });
      });
      var list = DL ? DL.html({
        title: "Device List",
        hint: drag ? "Drag device from list to a rack." : "Edit the map to rack devices.",
        rows: rows,
        editing: drag,
        filter: listFilter,
        selectedId: selectedId,
        removeLabel: "Remove from the rack",
      }) : "";
      return (drag ? items : "") + list;
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
          state.placements = state.placements.filter(function (p) { return p.assetId !== id; });
          changed();
        },
        onSelect: function (id) {
          select(id);
          var el = strip.querySelector(".topo-rack-blk.is-selected");
          if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" });
        },
      });
    }

    setEditing(state.editing);

    return {
      mode: "rack",
      setEditing: setEditing,
      sidebarHtml: sidebarHtml,
      wireSidebar: wireSidebar,
      // The devices in a rack — map.js lists only these under the info card.
      placedIds: function () { var o = {}; state.placements.forEach(function (p) { if (p.assetId) o[p.assetId] = true; }); return o; },
      setSelected: function (id) { selectedId = id || null; paintSelected(); },
      // The Delete key (map.js): the selected racked device leaves the rack.
      deleteSelected: function () {
        if (deleteCableHandle()) return true;
        if (!state.editing || !selectedId) return false;
        var id = selectedId;
        if (!state.placements.some(function (p) { return p.assetId === id; })) return false;
        select(null);
        state.placements = state.placements.filter(function (p) { return p.assetId !== id; });
        changed();
        return true;
      },
      cornerButtons: function () { return []; },
      // The Room canvas (topology-room.js): one Device List for both parts.
      whereIs: function (assetId) {
        var p = state.placements.filter(function (x) { return x.assetId === assetId; })[0];
        if (!p) return null;
        var r = rackById(p.rackId);
        if (isSide(p)) return (r ? r.name : "?") + " · " + p.side + " side";
        var top = p.startU + p.heightU - 1;
        return (r ? r.name : "?") + " · U" + (p.heightU > 1 ? p.startU + "–" + top : p.startU);
      },
      removeAsset: function (assetId) {
        if (!state.editing || !state.placements.some(function (p) { return p.assetId === assetId; })) return false;
        state.placements = state.placements.filter(function (p) { return p.assetId !== assetId; });
        changed();
        return true;
      },
      isEmpty: function () { return !state.racks.length; },
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

  window.PolarisTopologyRack = {
    render: render,
    // Pure helpers, exported for tests.
    _fits: fits,
    _nearestFreeU: nearestFreeU,
    _autoRoute: autoRoute,
    _makeLanes: makeLanes,
    _insertAt: insertAt,
    _nearestEnd: nearestEnd,
    _endPoint: endPoint,
    U_PX: U_PX,
  };
})();
