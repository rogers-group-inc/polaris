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
 * a dashed outline); a half-depth one only its own. The server re-checks the
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
  // Is [startU, startU + heightU) on the faces `cand` occupies free in its
  // rack, ignoring the placement `ignoreId`?
  function fits(placements, racks, cand, ignoreId) {
    var rack = null;
    racks.forEach(function (r) { if (r.id === cand.rackId) rack = r; });
    if (!rack) return false;
    if (cand.startU < 1 || cand.heightU < 1 || cand.startU + cand.heightU - 1 > rack.units) return false;
    var mine = faces(cand);
    return !placements.some(function (p) {
      if (p.id === ignoreId || p.rackId !== cand.rackId) return false;
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
      history: { entries: [], index: -1 },
    };
    state.racks.sort(function (a, b) { return a.order - b.order; });
    state.racks.forEach(function (r) { if (r.face !== "rear") r.face = "front"; });

    var nodeById = {};
    if (R) {
      R.buildTopologyElements(data, { shownTypes: ctx.shownTypes }).forEach(function (el) {
        if (!el.data.source) nodeById[el.data.id] = el.data;
      });
    }

    host.innerHTML = '<div class="topo-rack-strip" tabindex="-1"></div>';
    var strip = host.firstChild;

    // "rear" is the stored value; the screen says Back.
    function faceWord(f) { return f === "rear" ? "Back" : "Front"; }
    function rackById(id) { return state.racks.filter(function (r) { return r.id === id; })[0] || null; }
    function assetOf(p) { return p.kind === "asset" ? nodeById[p.assetId] : null; }

    // ── Drawing ─────────────────────────────────────────────────────────
    function draw() {
      var html = state.racks.map(rackHtml).join("");
      if (state.editing) {
        html += '<button type="button" class="topo-rack-add btn btn-secondary" data-rack-add>' +
          '<span class="topo-rack-add-plus" aria-hidden="true">+</span>Add rack<span class="hint" style="margin:0">' + DEFAULT_UNITS + 'U</span></button>';
      }
      if (!state.racks.length && !state.editing) {
        html = '<div class="empty-state topology-mode-empty">No racks yet. Edit the map to add one.</div>';
      }
      strip.innerHTML = html;
    }
    function rackHtml(r) {
      var bayH = r.units * U_PX;
      var rail = "";
      for (var u = r.units; u >= 1; u--) rail += '<span>' + u + '</span>';
      var blocks = state.placements.filter(function (p) { return p.rackId === r.id; }).map(function (p) {
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
          (ed && !first ? '<button type="button" class="btn-icon topo-rack-delete" data-rack-delete="' + esc(r.id) + '" title="Delete this rack" aria-label="Delete ' + esc(r.name) + '">×</button>' : '') +
        '</header>' +
        '<div class="topo-rack-body">' +
          '<div class="topo-rack-rail" aria-hidden="true">' + rail + '</div>' +
          '<div class="topo-rack-bay" data-rack-bay="' + esc(r.id) + '" style="height:' + bayH + 'px">' + blocks + '</div>' +
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
      var color = d && d.nodeColor ? d.nodeColor : null;
      return '<div class="' + cls + '" data-blk="' + esc(p.id) + '" style="top:' + top + 'px;height:' + h + 'px' +
        (color && !ghost && p.kind === "asset" ? ";border-color:" + esc(color) : "") + '">' +
        (state.editing && !ghost ? '<span class="topo-rack-grip-top" data-blk-edge="top" aria-hidden="true"></span>' : '') +
        '<span class="topo-rack-blk-name">' + esc(name) + '</span><span class="topo-rack-blk-meta">' + esc(meta) + '</span>' +
        (state.editing && !ghost ? '<span class="topo-rack-grip-bottom" data-blk-edge="bottom" aria-hidden="true"></span>' : '') +
      '</div>';
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
    strip.addEventListener("dragover", function (e) {
      if (!state.editing) return;
      var types = e.dataTransfer && e.dataTransfer.types;
      if (types && Array.prototype.indexOf.call(types, DRAG_MIME) !== -1 && bayAt(e.clientX, e.clientY)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    strip.addEventListener("drop", function (e) {
      if (!state.editing) return;
      var token = e.dataTransfer && e.dataTransfer.getData(DRAG_MIME);
      var bay = bayAt(e.clientX, e.clientY);
      if (!token || !bay) return;
      e.preventDefault();
      var rack = rackById(bay.getAttribute("data-rack-bay"));
      if (!rack) return;
      var isCable = token === CABLE_TOKEN;
      var isThird = token === THIRD_PARTY_TOKEN;
      if (!isCable && !isThird && state.placements.some(function (p) { return p.assetId === token; })) {
        ctx.toast("That device is already racked in this view", "error");
        return;
      }
      var fullDepth = !isCable;
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
      if (!p) return;
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
      var del = e.target.closest("[data-rack-delete]");
      if (del) { deleteRack(rackById(del.getAttribute("data-rack-delete"))); return; }
      if (e.target.closest("[data-rack-add]")) {
        if (!state.editing) return;
        state.racks.push({ id: newId("rack"), name: "Rack " + (state.racks.length + 1), units: DEFAULT_UNITS, order: state.racks.length, face: "front" });
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
      var blkEl = e.target.closest("[data-blk]");
      if (!blkEl || !state.editing || typeof showRowMenu !== "function") return;
      e.preventDefault();
      var p = state.placements.filter(function (x) { return x.id === blkEl.getAttribute("data-blk"); })[0];
      if (!p) return;
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
          var stranded = state.placements.filter(function (p) { return p.rackId === r.id && p.startU + p.heightU - 1 > units; });
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
      if (!r || !state.editing || state.racks.indexOf(r) <= 0) return;
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
    function snapshot() { return JSON.stringify({ racks: state.racks, placements: state.placements }); }
    function stage() {
      ctx.stageViewPatch({ racks: state.racks, rackPlacements: state.placements });
    }
    function changed() {
      stage();
      var h = state.history;
      h.entries = h.entries.slice(0, h.index + 1);
      h.entries.push(snapshot());
      if (h.entries.length > HISTORY_MAX) h.entries.shift();
      h.index = h.entries.length - 1;
      draw();
      ctx.refreshSidebar();
      ctx.historyChanged();
    }
    function applySnapshot(s) {
      var o = JSON.parse(s);
      state.racks = o.racks;
      state.placements = o.placements;
      stage();
      draw();
      ctx.refreshSidebar();
      ctx.historyChanged();
    }

    function setEditing(on) {
      state.editing = !!on;
      host.classList.toggle("is-editing", !!on);
      if (on) {
        state.history = { entries: [snapshot()], index: 0 };
        ctx.historyChanged();
      }
      draw();
    }

    function sidebarHtml() {
      var racked = {};
      state.placements.forEach(function (p) { if (p.assetId) racked[p.assetId] = p; });
      var ids = Object.keys(nodeById);
      var free = ids.filter(function (id) { return !racked[id]; });
      var on = ids.filter(function (id) { return racked[id]; });
      function where(p) {
        var r = rackById(p.rackId);
        var top = p.startU + p.heightU - 1;
        return (r ? r.name : "?") + " · U" + (p.heightU > 1 ? p.startU + "–" + top : p.startU);
      }
      var drag = state.editing;
      var cable = '<li class="topo-phys-row topo-rack-cable-row"' + (drag ? ' draggable="true" data-place-asset="' + CABLE_TOKEN + '"' : '') + '>' +
        '<span class="topo-phys-grip" aria-hidden="true">⋮⋮</span><span class="topo-rack-cable-swatch" aria-hidden="true"></span>' +
        '<span class="topo-phys-row-name">Cable management</span><span class="meta">placeholder</span></li>' +
        '<li class="topo-phys-row topo-rack-cable-row"' + (drag ? ' draggable="true" data-place-asset="' + THIRD_PARTY_TOKEN + '"' : '') + '>' +
        '<span class="topo-phys-grip" aria-hidden="true">⋮⋮</span><span class="topo-rack-third-swatch" aria-hidden="true"></span>' +
        '<span class="topo-phys-row-name">Third party</span><span class="meta">named</span></li>';
      var freeRows = free.map(function (id) {
        var d = nodeById[id];
        var t = R ? R.nodeAssetType(d) : "";
        return '<li class="topo-phys-row"' + (drag ? ' draggable="true" data-place-asset="' + esc(id) + '"' : '') + '>' +
          '<span class="topo-phys-grip" aria-hidden="true">⋮⋮</span><span class="topo-phys-row-name">' + esc(d.label || id) + '</span>' +
          '<span class="meta">' + esc(TYPE_INITIALS[t] ? String(t).replace(/_/g, " ") : (t || "")) + '</span></li>';
      }).join("");
      var onRows = on.map(function (id) {
        var d = nodeById[id];
        return '<li class="topo-phys-row is-placed"><span class="topo-phys-grip" aria-hidden="true">✓</span>' +
          '<span class="topo-phys-row-name">' + esc(d.label || id) + '</span><span class="meta">' + esc(where(racked[id])) + '</span></li>';
      }).join("");
      var hint = drag
        ? "Drag a device, Cable management or Third party onto a rack; double-click a Third party block to name it. Racking a device does not change its description."
        : "Edit the map to rack devices.";
      return (drag ? '<div class="topology-section topo-phys-side"><h5>Rack items</h5><ul>' + cable + '</ul></div>' : '') +
        '<div class="topology-section topo-phys-side"><h5>Not racked (' + free.length + ')</h5>' +
        '<p class="topology-type-hint" style="margin:0 0 6px">' + esc(hint) + '</p><ul>' +
        (freeRows || '<li class="muted">Every shown device is racked.</li>') + '</ul></div>' +
        '<div class="topology-section topo-phys-side"><h5>Racked (' + on.length + ')</h5><ul>' +
        (onRows || '<li class="muted">Nothing racked yet.</li>') + '</ul></div>';
    }
    function wireSidebar(pane) {
      if (!pane) return;
      pane.querySelectorAll("[data-place-asset]").forEach(function (li) {
        li.addEventListener("dragstart", function (e) {
          e.dataTransfer.setData(DRAG_MIME, li.getAttribute("data-place-asset"));
          e.dataTransfer.effectAllowed = "move";
        });
      });
    }

    setEditing(state.editing);

    return {
      mode: "rack",
      setEditing: setEditing,
      sidebarHtml: sidebarHtml,
      wireSidebar: wireSidebar,
      cornerButtons: function () { return []; },
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
    U_PX: U_PX,
  };
})();
