/**
 * public/js/topology-edge-editor.js — operator-drawn connection paths on the
 * Device Map topology graph (map.js). Global: PolarisTopologyEdgeEditor.
 *
 * What the operator can do:
 *   • Drag any part of a connection line → a new BEND POINT appears under
 *     the pointer, selected, and follows the drag. Bends are absolute model
 *     coordinates: moving one end of the line leaves them where they are,
 *     moving BOTH ends together (a multi-select drag, a group-box drag)
 *     carries them along so the path keeps its shape.
 *   • Click a line → its handles show: every bend, plus one END POINT on
 *     each device. An end point slides around the device's outline (it can
 *     never leave it, so the line never disconnects) and the line attaches
 *     there instead of at the centre-aimed default. Stored as a direction
 *     from the device's centre, so it follows the device and its size.
 *   • Select a handle + Delete → a bend is removed; an end point returns to
 *     automatic. A line with no bends and no end points left is back to its
 *     solver/router geometry.
 *
 * Persistence rides the layout blob map.js already saves ({ id: {x, y} },
 * server TopologyLayout row + localStorage, per view): each bend is an entry
 * `edgepath:<pathKey>:b<n>` holding its {x, y}; each end point is
 * `edgepath:<pathKey>:s` / `:t` holding the unit direction {x, y}. Save,
 * Reset to last save and Reset to baseline therefore cover paths with no
 * code of their own. `pathKey` is the edge's kind + source + target (+ "#n"
 * for a parallel link) — NOT the element id, which is a payload index
 * ("e7") and shifts whenever the topology changes.
 *
 * The handles are synthetic nodes (`isEdgeHandle`), added only while their
 * line (or one of its handles) is selected. Like hulls and portals they are
 * never persisted as nodes, never an asset, never snapped, never exported.
 */
(function () {
  "use strict";

  var KEY_PREFIX = "edgepath:";
  // Bends per line — far beyond any hand-drawn path, small enough that one
  // runaway line cannot push the layout blob past its server node cap.
  var MAX_BENDS = 24;
  // The server refuses a blob key longer than 300 characters (and with it
  // the whole save), so a path whose key would exceed this is not persisted.
  var MAX_BLOB_KEY = 290;
  // Pointer travel (model px) before a press on a line becomes a new bend —
  // a plain click selects the line instead.
  var DRAG_THRESHOLD = 4;
  var PATH_STYLE_PROPS = "curve-style segment-weights segment-distances edge-distances source-endpoint target-endpoint";

  // ── Pure helpers (unit-tested) ──────────────────────────────────────────

  // The kind half of a path key. Element ids are "<kind><index>" ("e7",
  // "le3", "ie0", "me2", "br1"), optionally rewired by a location view
  // ("portal-e7"); mesh ids ("mesh-<ap>-<station>") are already stable.
  function edgeKind(id) {
    var s = String(id || "").replace(/^portal-/, "");
    var m = /^([a-z]+)\d+$/.exec(s);
    return m ? m[1] : s;
  }

  // Stable keys for a list of edge data objects ({ id, source, target }),
  // in order. Parallel links of one kind between one pair get "#1", "#2"…
  // after the first, by their order in the list.
  function assignPathKeys(edges) {
    var seen = {};
    return (edges || []).map(function (d) {
      var base = edgeKind(d.id) + "|" + d.source + "|" + d.target;
      var n = seen[base] || 0;
      seen[base] = n + 1;
      return n ? base + "#" + n : base;
    });
  }

  function _finitePoint(p) {
    return !!(p && typeof p.x === "number" && typeof p.y === "number" && isFinite(p.x) && isFinite(p.y));
  }
  function _unit(x, y) {
    var len = Math.sqrt(x * x + y * y);
    if (!(len > 1e-9)) return null;
    return { x: x / len, y: y / len };
  }

  // Layout blob → { pathKey: { bends: [{x,y}], s: {x,y}|null, t: {x,y}|null } }.
  // Non-path entries (node positions) are ignored; bends are ordered by n.
  function parsePaths(positions) {
    var out = {};
    if (!positions || typeof positions !== "object") return out;
    var bendIdx = {};
    Object.keys(positions).forEach(function (k) {
      if (k.indexOf(KEY_PREFIX) !== 0) return;
      var cut = k.lastIndexOf(":");
      if (cut <= KEY_PREFIX.length) return;
      var key = k.slice(KEY_PREFIX.length, cut);
      var part = k.slice(cut + 1);
      var p = positions[k];
      if (!_finitePoint(p)) return;
      var path = out[key] || (out[key] = { bends: [], s: null, t: null });
      if (part === "s" || part === "t") {
        var u = _unit(p.x, p.y);
        if (u) path[part] = u;
        return;
      }
      var m = /^b(\d+)$/.exec(part);
      if (!m) return;
      (bendIdx[key] = bendIdx[key] || []).push({ n: parseInt(m[1], 10), x: p.x, y: p.y });
    });
    Object.keys(bendIdx).forEach(function (key) {
      out[key].bends = bendIdx[key]
        .sort(function (a, b) { return a.n - b.n; })
        .slice(0, MAX_BENDS)
        .map(function (b) { return { x: b.x, y: b.y }; });
    });
    Object.keys(out).forEach(function (key) {
      if (isEmptyPath(out[key])) delete out[key];
    });
    return out;
  }

  function isEmptyPath(path) {
    return !path || ((!path.bends || path.bends.length === 0) && !path.s && !path.t);
  }

  // Paths → layout blob entries. `onlyKeys` (optional) limits the output to
  // the lines actually on the canvas, so a path whose line left the topology
  // ages out on the next save exactly like a departed node's position.
  function serializePaths(paths, onlyKeys) {
    var out = {};
    Object.keys(paths || {}).forEach(function (key) {
      if (onlyKeys && !onlyKeys[key]) return;
      var path = paths[key];
      if (isEmptyPath(path)) return;
      var base = KEY_PREFIX + key + ":";
      if ((base + "b" + MAX_BENDS).length > MAX_BLOB_KEY) return;
      (path.bends || []).slice(0, MAX_BENDS).forEach(function (b, i) {
        if (_finitePoint(b)) out[base + "b" + i] = { x: b.x, y: b.y };
      });
      if (path.s) out[base + "s"] = { x: path.s.x, y: path.s.y };
      if (path.t) out[base + "t"] = { x: path.t.x, y: path.t.y };
    });
    return out;
  }

  // Where a ray from a node's centre in direction `dir` (a unit vector)
  // leaves its outline, as an offset from the centre. `w`/`h` are the
  // node's outer size; the shape is its Cytoscape `shape`.
  function perimeterOffset(shape, w, h, dir) {
    var rx = Math.max(w, 1) / 2;
    var ry = Math.max(h, 1) / 2;
    var c = dir.x, s = dir.y;
    var ac = Math.abs(c), as = Math.abs(s);
    var t;
    if (/rectangle|tag|barrel|cutrectangle/.test(shape)) {
      t = Math.min(ac > 1e-9 ? rx / ac : Infinity, as > 1e-9 ? ry / as : Infinity);
    } else if (/diamond/.test(shape)) {
      t = 1 / (ac / rx + as / ry);
    } else {
      // ellipse and everything rounder than a box
      t = 1 / Math.sqrt((c * c) / (rx * rx) + (s * s) / (ry * ry));
    }
    return { x: c * t, y: s * t };
  }

  // Cytoscape `segments` geometry through absolute bend points: each bend
  // projected onto the source→target centre line as a weight (0..1 along)
  // and a signed perpendicular distance — the same projection
  // routeInterGroupEdges uses, with edge-distances: node-position. Null when
  // the two centres coincide (no line to project onto).
  function segmentGeometry(S, T, bends) {
    var dx = T.x - S.x;
    var dy = T.y - S.y;
    var len2 = dx * dx + dy * dy;
    if (len2 < 1) return null;
    var norm = Math.sqrt(len2);
    var weights = [];
    var distances = [];
    bends.forEach(function (p) {
      var px = p.x - S.x;
      var py = p.y - S.y;
      weights.push(Number(((px * dx + py * dy) / len2).toFixed(4)));
      distances.push(Number(((py * dx - px * dy) / norm).toFixed(1)));
    });
    return { weights: weights, distances: distances };
  }

  function _distToSegment(p, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    var len2 = dx * dx + dy * dy;
    var f = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    f = Math.max(0, Math.min(1, f));
    var qx = a.x + dx * f - p.x, qy = a.y + dy * f - p.y;
    return Math.sqrt(qx * qx + qy * qy);
  }

  // Index a new bend at P takes in `bends`: the leg of the drawn polyline
  // S → bends… → T nearest P, so a point dragged out of the middle of the
  // second leg lands between the first and second bends.
  function insertIndex(S, T, bends, P) {
    var pts = [S].concat(bends || [], [T]);
    var best = 0;
    var bestD = Infinity;
    for (var i = 0; i + 1 < pts.length; i++) {
      var d = _distToSegment(P, pts[i], pts[i + 1]);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Bends after a drag: moved with the line when both ends travelled the
  // same distance (the whole line was carried), left in place otherwise.
  function carriedBends(bends0, dS, dT) {
    var together = Math.abs(dS.x - dT.x) < 0.5 && Math.abs(dS.y - dT.y) < 0.5;
    if (!together || (Math.abs(dS.x) < 1e-6 && Math.abs(dS.y) < 1e-6)) {
      return bends0.map(function (b) { return { x: b.x, y: b.y }; });
    }
    return bends0.map(function (b) { return { x: b.x + dS.x, y: b.y + dS.y }; });
  }

  // ── The editor (Cytoscape wiring) ───────────────────────────────────────

  // attach(cy, opts) → controller. opts:
  //   positions    the view's loaded layout blob (bend / end-point entries
  //                are read out of it; node entries ignored)
  //   isSuspended  () → true while edits must not apply (the connection-path
  //                overlay parks nodes in a temporary chain)
  //   onChange     () → called after an edit settles — the host marks the
  //                layout dirty and saves
  //   onGeometryReset (edges) → a line went back to automatic; the host
  //                re-runs its router so the line gets its routed shape back
  function attach(cy, opts) {
    opts = opts || {};
    var paths = parsePaths(opts.positions);
    var edgeByKey = {};
    var suspended = false;
    var syncing = false;
    var pointer = null;     // last core pointer position (model coords)
    var snapshot = null;    // per-line state at the start of a device drag
    var pending = null;     // a press on a line not yet past the threshold
    var creating = null;    // the bend being created by the current press
    var handlesFor = {};    // pathKey → true while its handles are on canvas

    var edgeData = cy.edges().map(function (e) {
      return { id: e.id(), source: e.data("source"), target: e.data("target") };
    });
    var keys = assignPathKeys(edgeData);
    cy.edges().forEach(function (e, i) {
      e.data("pathKey", keys[i]);
      edgeByKey[keys[i]] = e;
    });

    function isSuspended() {
      return suspended || (typeof opts.isSuspended === "function" && opts.isSuspended());
    }
    function changed() {
      if (typeof opts.onChange === "function") opts.onChange();
    }

    function endpointPos(node, dir) {
      var c = node.position();
      var off = perimeterOffset(node.style("shape"), node.outerWidth(), node.outerHeight(), dir);
      return { x: c.x + off.x, y: c.y + off.y, off: off };
    }

    // Draw one line from its path (or hand it back to the stylesheet / router).
    function applyEdge(e) {
      var key = e.data("pathKey");
      var path = key ? paths[key] : null;
      if (isSuspended() || isEmptyPath(path)) {
        if (e.data("customPath")) {
          e.removeStyle(PATH_STYLE_PROPS);
          e.data("customPath", 0);
          return true; // geometry handed back
        }
        return false;
      }
      var style = {};
      var S = e.source().position();
      var T = e.target().position();
      var geo = path.bends.length ? segmentGeometry(S, T, path.bends) : null;
      if (geo) {
        style["curve-style"] = "segments";
        style["segment-weights"] = geo.weights.join(" ");
        style["segment-distances"] = geo.distances.join(" ");
        style["edge-distances"] = "node-position";
      } else {
        style["curve-style"] = "straight";
      }
      if (path.s) {
        var so = endpointPos(e.source(), path.s).off;
        style["source-endpoint"] = so.x.toFixed(1) + "px " + so.y.toFixed(1) + "px";
      } else {
        style["source-endpoint"] = "outside-to-node";
      }
      if (path.t) {
        var to = endpointPos(e.target(), path.t).off;
        style["target-endpoint"] = to.x.toFixed(1) + "px " + to.y.toFixed(1) + "px";
      } else {
        style["target-endpoint"] = "outside-to-node";
      }
      e.data("customPath", 1);
      e.style(style);
      return false;
    }
    function applyAll() {
      var reset = [];
      cy.batch(function () {
        cy.edges().forEach(function (e) { if (applyEdge(e)) reset.push(e); });
      });
      if (reset.length && typeof opts.onGeometryReset === "function") opts.onGeometryReset(reset);
    }
    function applyKey(key) {
      var e = edgeByKey[key];
      if (!e || e.removed()) return;
      if (applyEdge(e) && typeof opts.onGeometryReset === "function") opts.onGeometryReset([e]);
    }

    // ── Handles ──
    function handleId(key, part) { return "edgehandle:" + key + ":" + part; }

    // Where each of a line's handles sits right now.
    function handleSpecs(key) {
      var e = edgeByKey[key];
      if (!e || e.removed()) return [];
      var path = paths[key] || { bends: [], s: null, t: null };
      var specs = [];
      var src = e.source(), tgt = e.target();
      var S = src.position(), T = tgt.position();
      // An automatic end shows where the line leaves the device today —
      // aimed at its nearest bend, or at the far device; dragging it is what
      // pins it.
      var sAim = path.bends.length ? path.bends[0] : T;
      var tAim = path.bends.length ? path.bends[path.bends.length - 1] : S;
      var sDir = path.s || _unit(sAim.x - S.x, sAim.y - S.y) || { x: 1, y: 0 };
      var tDir = path.t || _unit(tAim.x - T.x, tAim.y - T.y) || { x: -1, y: 0 };
      var sp = endpointPos(src, sDir);
      var tp = endpointPos(tgt, tDir);
      specs.push({ id: handleId(key, "s"), kind: "source", index: -1, x: sp.x, y: sp.y });
      path.bends.forEach(function (b, i) {
        specs.push({ id: handleId(key, "b" + i), kind: "bend", index: i, x: b.x, y: b.y });
      });
      specs.push({ id: handleId(key, "t"), kind: "target", index: -1, x: tp.x, y: tp.y });
      return specs;
    }

    function activeKeys() {
      var want = {};
      cy.edges(":selected").forEach(function (e) {
        var k = e.data("pathKey");
        if (k) want[k] = true;
      });
      cy.nodes("[isEdgeHandle]:selected").forEach(function (n) { want[n.data("pathKey")] = true; });
      if (creating) want[creating.key] = true;
      return want;
    }

    // Diff the handles on canvas against the lines that want them: add the
    // missing, drop the stale, move the rest. Never a full rebuild — that
    // would unselect (and un-grab) the handle the operator is holding.
    function syncHandles() {
      var want = isSuspended() ? {} : activeKeys();
      syncing = true;
      try {
        cy.batch(function () {
          var keep = {};
          Object.keys(want).forEach(function (key) {
            handleSpecs(key).forEach(function (sp) {
              keep[sp.id] = true;
              var n = cy.getElementById(sp.id);
              if (n.length === 0) {
                cy.add({
                  group: "nodes",
                  data: {
                    id: sp.id, label: "", isEdgeHandle: 1, noExport: 1,
                    pathKey: key, handleKind: sp.kind, bendIndex: sp.index,
                  },
                  position: { x: sp.x, y: sp.y },
                });
              } else {
                n.data({ handleKind: sp.kind, bendIndex: sp.index });
                if (!n.grabbed()) n.position({ x: sp.x, y: sp.y });
              }
            });
          });
          cy.nodes("[isEdgeHandle]").forEach(function (n) {
            if (!keep[n.id()]) cy.remove(n);
          });
          handlesFor = want;
        });
      } finally {
        syncing = false;
      }
    }
    var syncQueued = false;
    function queueSyncHandles() {
      if (syncQueued) return;
      syncQueued = true;
      setTimeout(function () {
        syncQueued = false;
        if (!cy.destroyed()) syncHandles();
      }, 0);
    }

    function pathFor(key) {
      return paths[key] || (paths[key] = { bends: [], s: null, t: null });
    }

    // First edit of a line keeps the shape it was drawn with: its current
    // corners (a fan-out L, a routed inter-group polyline) become bends, so
    // grabbing a line never makes it jump straight.
    function seedFromRendered(key) {
      var path = pathFor(key);
      if (!isEmptyPath(path)) return path;
      var e = edgeByKey[key];
      var cs = e.style("curve-style");
      if ((cs === "taxi" || cs === "segments") && e.segmentPoints) {
        (e.segmentPoints() || []).slice(0, MAX_BENDS).forEach(function (p) {
          if (_finitePoint(p)) path.bends.push({ x: p.x, y: p.y });
        });
      }
      return path;
    }

    // ── Events ──
    cy.on("tapstart mousedown", function (evt) {
      if (evt.position) pointer = { x: evt.position.x, y: evt.position.y };
    });
    cy.on("tapdrag mousemove", function (evt) {
      if (evt.position) pointer = { x: evt.position.x, y: evt.position.y };
    });

    // Press on a line: maybe the start of a new bend.
    cy.on("tapstart", "edge", function (evt) {
      if (isSuspended()) return;
      var oe = evt.originalEvent;
      if (oe && (oe.ctrlKey || oe.shiftKey || (typeof oe.button === "number" && oe.button !== 0))) return;
      var key = evt.target.data("pathKey");
      if (!key || !evt.position) return;
      pending = {
        key: key, x: evt.position.x, y: evt.position.y,
        panning: cy.userPanningEnabled(), boxSelect: cy.boxSelectionEnabled(),
      };
      cy.userPanningEnabled(false);
      cy.boxSelectionEnabled(false);
    });
    cy.on("tapdrag", function (evt) {
      if (!evt.position) return;
      var P = evt.position;
      if (pending && !creating) {
        if (Math.abs(P.x - pending.x) < DRAG_THRESHOLD && Math.abs(P.y - pending.y) < DRAG_THRESHOLD) return;
        var key = pending.key;
        var e = edgeByKey[key];
        if (!e || e.removed()) { pending = null; return; }
        var path = seedFromRendered(key);
        if (path.bends.length >= MAX_BENDS) return;
        var at = insertIndex(e.source().position(), e.target().position(), path.bends, { x: pending.x, y: pending.y });
        path.bends.splice(at, 0, { x: P.x, y: P.y });
        creating = { key: key, index: at };
        applyKey(key);
        syncHandles();
        // The new point is the selection: its line stays selected (so the
        // handles stay up) and every other line and handle lets go.
        selectOnlyLine(e);
        cy.nodes("[isEdgeHandle]:selected").unselect();
        cy.getElementById(handleId(key, "b" + at)).select();
        return;
      }
      if (creating) {
        var cp = paths[creating.key];
        if (!cp || !cp.bends[creating.index]) return;
        cp.bends[creating.index] = { x: P.x, y: P.y };
        applyKey(creating.key);
        syncing = true;
        try { cy.getElementById(handleId(creating.key, "b" + creating.index)).position({ x: P.x, y: P.y }); }
        finally { syncing = false; }
      }
    });
    function endPress() {
      if (!pending) return;
      cy.userPanningEnabled(pending.panning);
      cy.boxSelectionEnabled(pending.boxSelect);
      var made = !!creating;
      pending = null;
      creating = null;
      if (made) changed();
    }
    cy.on("tapend", endPress);
    // A press that ends off the canvas never reaches Cytoscape's tapend.
    function onWindowUp() { if (pending) endPress(); }
    window.addEventListener("mouseup", onWindowUp);
    cy.on("destroy", function () { window.removeEventListener("mouseup", onWindowUp); });

    // A new bend is the whole selection — the same rule a plain click
    // follows on the host graph (selectionType "single"): everything else
    // lets go, and only its line stays selected so the handles stay up.
    function selectOnlyLine(e) {
      cy.elements(":selected").not(e).unselect();
      e.select();
    }

    cy.on("select unselect", queueSyncHandles);
    // A shift-drag box-select gathers devices (and the links between them);
    // a handle swept up with them would be a point the next Delete removes
    // without the operator ever having picked it.
    cy.on("boxselect", "node[isEdgeHandle]", function (evt) { evt.target.unselect(); });

    // Device drags: remember where every customised line's ends and bends
    // were, so a line carried whole moves its bends with it.
    cy.on("grab", "node", function () {
      if (snapshot) return; // one per gesture (grab fires for each moved node)
      snapshot = {};
      Object.keys(paths).forEach(function (key) {
        var e = edgeByKey[key];
        if (!e || e.removed() || isEmptyPath(paths[key])) return;
        var S = e.source().position(), T = e.target().position();
        snapshot[key] = {
          S: { x: S.x, y: S.y }, T: { x: T.x, y: T.y },
          bends: paths[key].bends.map(function (b) { return { x: b.x, y: b.y }; }),
        };
      });
    });
    cy.on("free", "node", function () {
      // Kept through this tick: map.js snaps released nodes to the grid in
      // its dragfree handler, and that move belongs to the same gesture.
      setTimeout(function () { snapshot = null; }, 0);
    });

    cy.on("position", "node", function (evt) {
      if (syncing) return;
      var n = evt.target;
      if (n.data("isEdgeHandle")) { onHandleMoved(n); return; }
      if (n.data("isLocGroup")) return;
      var touched = {};
      n.connectedEdges().forEach(function (e) {
        var key = e.data("pathKey");
        if (!key) return;
        // Any line showing handles follows — an automatic line's end rings
        // sit on the device outline too, and were left behind when only
        // drawn lines were tracked here (a box drag moving its devices).
        if (handlesFor[key]) touched[key] = true;
        if (isEmptyPath(paths[key])) return;
        var snap = snapshot && snapshot[key];
        if (snap) {
          var S = e.source().position(), T = e.target().position();
          paths[key].bends = carriedBends(
            snap.bends,
            { x: S.x - snap.S.x, y: S.y - snap.S.y },
            { x: T.x - snap.T.x, y: T.y - snap.T.y }
          );
        }
        applyEdge(e);
        touched[key] = true;
      });
      // Handles of the lines this device carries follow it (end points ride
      // its outline; carried bends ride the line).
      if (Object.keys(touched).some(function (k) { return handlesFor[k]; })) queueSyncHandles();
    });

    function onHandleMoved(h) {
      var key = h.data("pathKey");
      var e = edgeByKey[key];
      if (!e || e.removed()) return;
      var kind = h.data("handleKind");
      var path = pathFor(key);
      if (kind === "bend") {
        var i = h.data("bendIndex");
        if (!path.bends[i]) return;
        var p = h.position();
        path.bends[i] = { x: p.x, y: p.y };
        applyKey(key);
        return;
      }
      var owner = kind === "source" ? e.source() : e.target();
      // Carried along with its device (both selected) → its direction holds.
      if (owner.grabbed()) return;
      var c = owner.position();
      var at = h.grabbed() && pointer ? pointer : h.position();
      var dir = _unit(at.x - c.x, at.y - c.y);
      if (!dir) return;
      if (isEmptyPath(path)) seedFromRendered(key);
      path[kind === "source" ? "s" : "t"] = dir;
      applyKey(key);
      // Pin the handle to the outline: it slides around the device, it
      // never comes away from it.
      var on = endpointPos(owner, dir);
      syncing = true;
      try { h.position({ x: on.x, y: on.y }); } finally { syncing = false; }
    }

    // ── Controller ──
    applyAll();

    return {
      // Blob entries for every customised line on the canvas.
      serialize: function () {
        var present = {};
        Object.keys(edgeByKey).forEach(function (k) {
          if (!edgeByKey[k].removed()) present[k] = true;
        });
        return serializePaths(paths, present);
      },
      // Delete the selected handles: bends go, end points return to
      // automatic. True when anything was removed (the caller then swallows
      // the key press).
      deleteSelected: function () {
        if (isSuspended()) return false;
        var sel = cy.nodes("[isEdgeHandle]:selected");
        if (sel.length === 0) return false;
        var drop = {};
        sel.forEach(function (h) {
          var key = h.data("pathKey");
          var path = paths[key];
          if (!path) return;
          var kind = h.data("handleKind");
          if (kind === "bend") (drop[key] = drop[key] || []).push(h.data("bendIndex"));
          else path[kind === "source" ? "s" : "t"] = null;
          drop[key] = drop[key] || [];
        });
        Object.keys(drop).forEach(function (key) {
          var path = paths[key];
          drop[key].sort(function (a, b) { return b - a; }).forEach(function (i) { path.bends.splice(i, 1); });
          if (isEmptyPath(path)) delete paths[key];
          applyKey(key);
        });
        sel.unselect();
        syncHandles();
        changed();
        return true;
      },
      // The connection-path overlay moves nodes into a temporary chain:
      // custom geometry steps aside while it is up and returns after.
      setSuspended: function (on) {
        suspended = !!on;
        applyAll();
        syncHandles();
      },
      hasCustomPath: function (key) { return !isEmptyPath(paths[key]); },
    };
  }

  window.PolarisTopologyEdgeEditor = {
    KEY_PREFIX: KEY_PREFIX,
    MAX_BENDS: MAX_BENDS,
    edgeKind: edgeKind,
    assignPathKeys: assignPathKeys,
    parsePaths: parsePaths,
    serializePaths: serializePaths,
    isEmptyPath: isEmptyPath,
    perimeterOffset: perimeterOffset,
    segmentGeometry: segmentGeometry,
    insertIndex: insertIndex,
    carriedBends: carriedBends,
    attach: attach,
  };
})();
