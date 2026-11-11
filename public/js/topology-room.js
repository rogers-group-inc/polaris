/**
 * public/js/topology-room.js — the Device Map topology's ROOM mode (business
 * rules 147, 150, 151, 156): one room's racks and junction boxes side by side.
 *
 *   window.PolarisTopologyRoom.render(host, ctx) → instance
 *
 * A Room view stands for one room (r:). It holds racks (drawn by
 * topology-rack.js: rack elevations in U) and junction boxes (drawn by
 * topology-wall.js: boards in inches; a wall is just a big junction box with
 * no door). A rack can never sit in a junction box. This module mounts both
 * parts in one strip and joins them into one canvas for map.js:
 *   - one Device List, saying where each device is (a rack and U, or a box);
 *   - a device is in ONE place: a part refuses a drop of a device the other
 *     part holds (ctx.placedElsewhere);
 *   - one undo / redo order across both parts (ctx.historyPushed);
 *   - a racked device stages the room plus `ra:<rack>`, a boxed one the room
 *     plus `jb:<box>` (rule 148(a): only those levels change).
 *
 * map.js owns the edit session; each part stages its own fields
 * (racks / rackPlacements, walls / wallPlacements) through ctx.stageViewPatch.
 */
(function () {
  "use strict";

  var DRAG_MIME = "application/x-polaris-asset";
  var CABLE_TOKEN = "__cable_management__";
  var THIRD_PARTY_TOKEN = "__third_party__";

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s))
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }

  /**
   * One undo order across parts: each part's change pushes its name; undo
   * pops the last name and undoes that part, redo replays in reverse.
   */
  function makeHistory() {
    var done = [], undone = [];
    return {
      pushed: function (name) { done.push(name); undone = []; },
      reset: function () { done = []; undone = []; },
      canUndo: function () { return done.length > 0; },
      canRedo: function () { return undone.length > 0; },
      undo: function () { var n = done.pop(); if (n) undone.push(n); return n || null; },
      redo: function () { var n = undone.pop(); if (n) done.push(n); return n || null; },
    };
  }

  function render(host, ctx) {
    var R = window.PolarisTopologyRender;
    var Rack = window.PolarisTopologyRack;
    var Box = window.PolarisTopologyWall;
    var data = ctx.data || {};
    var view = ctx.view || {};
    var editing = !!ctx.editing;
    var listFilter = "";
    var history = makeHistory();

    host.innerHTML =
      '<div class="topo-room-strip" tabindex="-1">' +
        '<div class="topo-room-part" data-room-part="rack"></div>' +
        '<div class="topo-room-part" data-room-part="box"></div>' +
        '<div class="empty-state topology-mode-empty topo-room-empty" hidden>No racks or junction boxes yet. Edit the map to add them.</div>' +
      '</div>';
    var strip = host.firstChild;
    var emptyEl = strip.querySelector(".topo-room-empty");

    var parts = {};
    function partCtx(name) {
      var other = name === "rack" ? "box" : "rack";
      return Object.assign({}, ctx, {
        editing: editing,
        historyPushed: function () { history.pushed(name); },
        historyChanged: function () { ctx.historyChanged(); paintEmpty(); },
        placedElsewhere: function (assetId) {
          var o = parts[other];
          return o && o.whereIs ? o.whereIs(assetId) : null;
        },
      });
    }
    parts.rack = Rack ? Rack.render(strip.querySelector('[data-room-part="rack"]'), partCtx("rack")) : null;
    parts.box = Box ? Box.render(strip.querySelector('[data-room-part="box"]'), partCtx("box")) : null;
    function each(fn) { ["rack", "box"].forEach(function (n) { if (parts[n]) fn(parts[n], n); }); }
    function paintEmpty() {
      var empty = !editing && (!parts.rack || parts.rack.isEmpty()) && (!parts.box || parts.box.isEmpty());
      emptyEl.hidden = !empty;
    }
    paintEmpty();

    // Devices that can be placed: the same element set as the other modes.
    var nodeById = {};
    (R ? R.buildTopologyElements(data, { shownTypes: ctx.shownTypes }) : []).forEach(function (el) {
      var d = el.data;
      if (!d || d.source || d.isLocGroup || d.isPortal) return;
      if (d.role === "lldp" || d.role === "fcport" || d.role === "wireless-station" || d.role === "remote-asset") return;
      nodeById[d.id] = d;
    });
    function whereIs(id) {
      var w = null;
      each(function (p) { if (!w && p.whereIs) w = p.whereIs(id); });
      return w;
    }

    function sidebarHtml() {
      var DL = window.PolarisTopologyDeviceList;
      var selectedId = ctx.selectedId ? ctx.selectedId() : null;
      function itemRow(token, swatch, name) {
        return '<li class="topo-device-row topo-rack-item-row"' + (editing ? ' draggable="true" data-place-asset="' + token + '"' : '') + '>' +
          '<span class="' + swatch + '" aria-hidden="true"></span><span class="topo-device-name">' + name + '</span></li>';
      }
      var items = '<div class="topology-section topo-rack-items"><h5>Room items</h5><ul>' +
        itemRow(CABLE_TOKEN, "topo-rack-cable-swatch", "Cable management") +
        itemRow(THIRD_PARTY_TOKEN, "topo-rack-third-swatch", "Third party") +
        '</ul><p class="topology-type-hint" style="margin:6px 0 0">Drag onto a rack or a junction box.</p></div>';
      var region = view.region || null;
      var regionNote = region
        ? '<p class="topology-type-hint" style="margin:0 0 8px">This view stands for <code>' + esc(["area", "building", "floor", "room"].filter(function (k) { return region[k]; }).map(function (k) {
            return ({ area: "a", building: "b", floor: "f", room: "r" })[k] + ":" + region[k];
          }).join(" ")) + '</code>. A device in a rack also takes <code>ra:</code> that rack, one in a junction box <code>jb:</code> that box, when you save.</p>'
        : '<p class="topology-type-hint" style="margin:0 0 8px">This view stands for no room, so placing a device changes no description. Pick a room in View settings.</p>';
      var rows = Object.keys(nodeById).map(function (id) {
        var d = nodeById[id];
        var t = R ? R.nodeAssetType(d) : "";
        var w = whereIs(id);
        return { id: id, label: d.label || id, inUse: !!w, meta: w || String(t || "").replace(/_/g, " ") };
      }).sort(function (a, b) { return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: "base" }); });
      return (editing ? items : "") + regionNote + (DL ? DL.html({
        title: "Device List",
        hint: editing ? "Drag a device onto a rack or a junction box." : "Edit the map to place devices.",
        rows: rows, editing: editing, filter: listFilter, selectedId: selectedId, removeLabel: "Remove from the room",
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
          if (!editing) return;
          each(function (p) { if (p.removeAsset) p.removeAsset(id); });
        },
        onSelect: function (id) {
          if (typeof ctx.selectAsset === "function") ctx.selectAsset(id);
          var el = strip.querySelector(".is-selected");
          if (el && el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" });
        },
      });
    }

    return {
      mode: "room",
      setEditing: function (on) {
        editing = !!on;
        host.classList.toggle("is-editing", editing);
        history.reset();
        each(function (p) { p.setEditing(editing); });
        paintEmpty();
        ctx.historyChanged();
      },
      sidebarHtml: sidebarHtml,
      wireSidebar: wireSidebar,
      placedIds: function () {
        var o = {};
        each(function (p) { Object.assign(o, p.placedIds()); });
        return o;
      },
      setSelected: function (id) { each(function (p) { p.setSelected(id); }); },
      deleteSelected: function () {
        var done = false;
        each(function (p) { if (!done && p.deleteSelected) done = p.deleteSelected(); });
        return done;
      },
      cornerButtons: function () {
        var out = [];
        each(function (p) { if (p.cornerButtons) out = out.concat(p.cornerButtons()); });
        return out;
      },
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undo: function () { var n = history.undo(); if (n && parts[n]) parts[n].undo(); ctx.historyChanged(); },
      redo: function () { var n = history.redo(); if (n && parts[n]) parts[n].redo(); ctx.historyChanged(); },
      captureElement: function () { return strip; },
      destroy: function () { each(function (p) { if (p.destroy) p.destroy(); }); strip.innerHTML = ""; },
    };
  }

  window.PolarisTopologyRoom = { render: render, _makeHistory: makeHistory };
})();
