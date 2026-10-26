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
 *   • Advanced line editing (host's isAdvanced): every point also shows its
 *     WINGS, Photoshop path-tool style — two on a bend, one on each end.
 *     Dragging one curves the line (sampled cubic Béziers on a fine
 *     `segments` polyline); a bend's other wing stays collinear unless Alt
 *     is held. Delete on a wing returns its point to a sharp corner.
 *   • Snap line points (host's snapPoint): a dragged bend lands on the host's
 *     fine grid.
 * Editing at all needs the host's isEditable (the map's Edit mode).
 *
 * Persistence rides the layout blob map.js already saves ({ id: {x, y} },
 * server TopologyLayout row + localStorage, per view): each bend is an entry
 * `edgepath:<pathKey>:b<n>` holding its {x, y} (its wings `b<n>i` / `b<n>o`
 * as offsets from it); each end point is `edgepath:<pathKey>:s` / `:t`
 * holding the unit direction {x, y} (its wing `sw` / `tw`). Save,
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

  function _emptyPath() {
    return { bends: [], s: null, t: null, sw: null, tw: null };
  }

  // Layout blob → { pathKey: { bends, s, t, sw, tw } }:
  //   bends  [{ x, y, in?, out? }] — absolute anchor points; `in` / `out`
  //          are the anchor's curve WINGS (advanced line editing), stored as
  //          offsets from the anchor so they travel with it
  //   s / t  the end points' unit directions from their device's centre
  //   sw/tw  each end point's single wing, an offset from the end point
  // Blob parts: b<n>, b<n>i, b<n>o, s, t, sw, tw. Non-path entries (node
  // positions) are ignored; bends are ordered by n. A wing on a bend that
  // isn't there is dropped.
  function parsePaths(positions) {
    var out = {};
    if (!positions || typeof positions !== "object") return out;
    var bendIdx = {};
    var wingIdx = {};
    Object.keys(positions).forEach(function (k) {
      if (k.indexOf(KEY_PREFIX) !== 0) return;
      var cut = k.lastIndexOf(":");
      if (cut <= KEY_PREFIX.length) return;
      var key = k.slice(KEY_PREFIX.length, cut);
      var part = k.slice(cut + 1);
      var p = positions[k];
      if (!_finitePoint(p)) return;
      var path = out[key] || (out[key] = _emptyPath());
      if (part === "s" || part === "t") {
        var u = _unit(p.x, p.y);
        if (u) path[part] = u;
        return;
      }
      if (part === "sw" || part === "tw") {
        path[part] = { x: p.x, y: p.y };
        return;
      }
      var m = /^b(\d+)([io])?$/.exec(part);
      if (!m) return;
      var n = parseInt(m[1], 10);
      if (m[2]) {
        ((wingIdx[key] = wingIdx[key] || {})[n] = wingIdx[key][n] || {})[m[2] === "i" ? "in" : "out"] = { x: p.x, y: p.y };
        return;
      }
      (bendIdx[key] = bendIdx[key] || []).push({ n: n, x: p.x, y: p.y });
    });
    Object.keys(bendIdx).forEach(function (key) {
      var wings = wingIdx[key] || {};
      out[key].bends = bendIdx[key]
        .sort(function (a, b) { return a.n - b.n; })
        .slice(0, MAX_BENDS)
        .map(function (b) {
          var o = { x: b.x, y: b.y };
          var w = wings[b.n];
          if (w && w.in) o.in = w.in;
          if (w && w.out) o.out = w.out;
          return o;
        });
    });
    Object.keys(out).forEach(function (key) {
      if (isEmptyPath(out[key])) delete out[key];
    });
    return out;
  }

  function isEmptyPath(path) {
    return !path || ((!path.bends || path.bends.length === 0) && !path.s && !path.t && !path.sw && !path.tw);
  }

  // True when any part of the path is curved (a wing anywhere).
  function isCurvedPath(path) {
    if (!path) return false;
    if (path.sw || path.tw) return true;
    return (path.bends || []).some(function (b) { return !!(b.in || b.out); });
  }

  // Cubic Bézier samples through the anchors — the drawn shape of a curved
  // path. `anchors` is [{ x, y, in?, out? }] from the start point to the end
  // point (wings as offsets); a span with no wing on either side is a
  // straight leg (just its end anchor). Returns the points AFTER the start
  // and BEFORE the end — the interior of the polyline Cytoscape draws.
  function sampleCurve(anchors, perSpan) {
    var n = perSpan || 12;
    var pts = [];
    for (var i = 0; i + 1 < anchors.length; i++) {
      var A = anchors[i], B = anchors[i + 1];
      var last = i + 2 === anchors.length;
      if (!A.out && !B.in) {
        if (!last) pts.push({ x: B.x, y: B.y });
        continue;
      }
      var c1 = { x: A.x + (A.out ? A.out.x : 0), y: A.y + (A.out ? A.out.y : 0) };
      var c2 = { x: B.x + (B.in ? B.in.x : 0), y: B.y + (B.in ? B.in.y : 0) };
      for (var k = 1; k <= n; k++) {
        if (last && k === n) break; // the end point itself is the target endpoint
        var t = k / n, u = 1 - t;
        pts.push({
          x: u * u * u * A.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * B.x,
          y: u * u * u * A.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * B.y,
        });
      }
    }
    return pts;
  }

  // A point's wings after one was dragged to `dragged` (an offset): the
  // other side stays collinear and keeps its own length — Photoshop's smooth
  // point — unless `independent` (Alt held), when it is left as it was.
  // `otherLen` is the opposite wing's current length (0 = mirror the drag).
  function mirroredWing(dragged, otherLen, independent, other) {
    if (independent) return other || null;
    var len = Math.sqrt(dragged.x * dragged.x + dragged.y * dragged.y);
    if (!(len > 1e-6)) return other || null;
    var L = otherLen > 0 ? otherLen : len;
    return { x: -dragged.x / len * L, y: -dragged.y / len * L };
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
      if ((base + "b" + MAX_BENDS + "o").length > MAX_BLOB_KEY) return;
      (path.bends || []).slice(0, MAX_BENDS).forEach(function (b, i) {
        if (!_finitePoint(b)) return;
        out[base + "b" + i] = { x: b.x, y: b.y };
        if (_finitePoint(b.in)) out[base + "b" + i + "i"] = { x: b.in.x, y: b.in.y };
        if (_finitePoint(b.out)) out[base + "b" + i + "o"] = { x: b.out.x, y: b.out.y };
      });
      if (path.s) out[base + "s"] = { x: path.s.x, y: path.s.y };
      if (path.t) out[base + "t"] = { x: path.t.x, y: path.t.y };
      if (_finitePoint(path.sw)) out[base + "sw"] = { x: path.sw.x, y: path.sw.y };
      if (_finitePoint(path.tw)) out[base + "tw"] = { x: path.tw.x, y: path.tw.y };
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
  // Wings are offsets, so they ride along with their anchor untouched.
  function carriedBends(bends0, dS, dT) {
    var together = Math.abs(dS.x - dT.x) < 0.5 && Math.abs(dS.y - dT.y) < 0.5;
    var move = together && !(Math.abs(dS.x) < 1e-6 && Math.abs(dS.y) < 1e-6);
    return bends0.map(function (b) {
      var o = move ? { x: b.x + dS.x, y: b.y + dS.y } : { x: b.x, y: b.y };
      if (b.in) o.in = { x: b.in.x, y: b.in.y };
      if (b.out) o.out = { x: b.out.x, y: b.out.y };
      return o;
    });
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
  //   isEditable   () → false while the map is view-only (map.js edit mode
  //                off): drawn paths still DRAW, but no bend is created, no
  //                handle shows and Delete removes nothing. Omitted = editable.
  //                Call refresh() after it flips so the handles follow.
  //   isAdvanced   () → true for advanced line editing: every point also
  //                shows its curve wings (two on a bend, one on an end point),
  //                Photoshop path-tool style. Curves DRAW either way. Call
  //                refresh() after it flips.
  //   snapPoint    (p) → the point a dragged bend should land on (the host's
  //                fine grid while "snap line points" is on), or p unchanged.
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
    var altHeld = false;    // Alt during the current drag: wings move independently

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
    function isEditable() {
      return typeof opts.isEditable !== "function" || !!opts.isEditable();
    }
    function isAdvanced() {
      return typeof opts.isAdvanced === "function" && !!opts.isAdvanced();
    }
    function snap(p) {
      var s = typeof opts.snapPoint === "function" ? opts.snapPoint(p) : null;
      return _finitePoint(s) ? { x: s.x, y: s.y } : { x: p.x, y: p.y };
    }
    function changed() {
      if (typeof opts.onChange === "function") opts.onChange();
    }

    function endpointPos(node, dir) {
      var c = node.position();
      var off = perimeterOffset(node.style("shape"), node.outerWidth(), node.outerHeight(), dir);
      return { x: c.x + off.x, y: c.y + off.y, off: off };
    }

    // Where a line meets each device right now: the pinned direction, or
    // aimed at its nearest bend / the far device. { s, t } attach points.
    function attachPoints(e, path) {
      var src = e.source(), tgt = e.target();
      var S = src.position(), T = tgt.position();
      var sAim = path.bends.length ? path.bends[0] : T;
      var tAim = path.bends.length ? path.bends[path.bends.length - 1] : S;
      var sDir = path.s || _unit(sAim.x - S.x, sAim.y - S.y) || { x: 1, y: 0 };
      var tDir = path.t || _unit(tAim.x - T.x, tAim.y - T.y) || { x: -1, y: 0 };
      return { s: endpointPos(src, sDir), t: endpointPos(tgt, tDir) };
    }

    // Draw one line from its path (or hand it back to the stylesheet / router).
    function applyEdge(e) {
      var key = e.data("pathKey");
      var path = key ? paths[key] : null;
      if (isSuspended() || isEmptyPath(path)) {
        if (e.data("customPath")) {
          e.removeStyle(PATH_STYLE_PROPS);
          e.data({ customPath: 0, curvedPath: 0 });
          return true; // geometry handed back
        }
        return false;
      }
      var style = {};
      var S = e.source().position();
      var T = e.target().position();
      if (isCurvedPath(path)) {
        // Curves: sampled cubic Béziers through the anchors, drawn as a fine
        // polyline between explicit end points (Cytoscape has no cubic path).
        var ap = attachPoints(e, path);
        var anchors = [{ x: ap.s.x, y: ap.s.y, out: path.sw }]
          .concat(path.bends, [{ x: ap.t.x, y: ap.t.y, in: path.tw }]);
        var cgeo = segmentGeometry(S, T, sampleCurve(anchors, 12));
        if (cgeo && cgeo.weights.length) {
          style["curve-style"] = "segments";
          style["segment-weights"] = cgeo.weights.join(" ");
          style["segment-distances"] = cgeo.distances.join(" ");
          style["edge-distances"] = "node-position";
        } else {
          style["curve-style"] = "straight";
        }
        style["source-endpoint"] = ap.s.off.x.toFixed(1) + "px " + ap.s.off.y.toFixed(1) + "px";
        style["target-endpoint"] = ap.t.off.x.toFixed(1) + "px " + ap.t.off.y.toFixed(1) + "px";
        // topology-render's bent-label placement walks legs; a curve has
        // dozens of tiny ones, so its label stays Cytoscape's own.
        e.data({ customPath: 1, curvedPath: 1 });
        e.style(style);
        return false;
      }
      e.data("curvedPath", 0);
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

    // Where each of a line's handles sits right now. An automatic end shows
    // where the line leaves the device today; dragging it is what pins it.
    // In advanced mode every point also gets its wings: a set wing where it
    // is, an unset one at a REST position along the line (rest: true —
    // drawn hollow; the curve ignores it until it is dragged).
    function handleSpecs(key) {
      var e = edgeByKey[key];
      if (!e || e.removed()) return [];
      var path = paths[key] || _emptyPath();
      var specs = [];
      var ap = attachPoints(e, path);
      var sp = ap.s, tp = ap.t;
      specs.push({ id: handleId(key, "s"), kind: "source", index: -1, x: sp.x, y: sp.y });
      path.bends.forEach(function (b, i) {
        specs.push({ id: handleId(key, "b" + i), kind: "bend", index: i, x: b.x, y: b.y });
      });
      specs.push({ id: handleId(key, "t"), kind: "target", index: -1, x: tp.x, y: tp.y });
      if (!isAdvanced()) return specs;

      var chain = [sp].concat(path.bends, [tp]);
      function dist(a, b) { return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)); }
      function restLen(a, b, c) {
        var d = Math.min(a ? dist(a, b) : Infinity, c ? dist(b, c) : Infinity);
        return Math.max(14, Math.min(40, (isFinite(d) ? d : 60) * 0.3));
      }
      function wing(anchorPart, side, index, anchor, set, restDir, len) {
        var off = set || { x: restDir.x * len, y: restDir.y * len };
        specs.push({
          id: handleId(key, side === "s" || side === "t" ? side + "w" : "b" + index + (side === "in" ? "i" : "o")),
          kind: "wing", index: index, side: side, rest: !set,
          anchorId: handleId(key, anchorPart),
          x: anchor.x + off.x, y: anchor.y + off.y,
        });
      }
      // End points: one wing each, resting along the line toward the next point.
      var sOut = _unit(chain[1].x - sp.x, chain[1].y - sp.y) || { x: 1, y: 0 };
      wing("s", "s", -1, sp, path.sw, sOut, restLen(null, sp, chain[1]));
      path.bends.forEach(function (b, i) {
        var prev = chain[i], next = chain[i + 2];
        var tan = _unit(next.x - prev.x, next.y - prev.y) || { x: 1, y: 0 };
        var len = restLen(prev, b, next);
        wing("b" + i, "in", i, b, b.in, { x: -tan.x, y: -tan.y }, len);
        wing("b" + i, "out", i, b, b.out, tan, len);
      });
      var tIn = _unit(chain[chain.length - 2].x - tp.x, chain[chain.length - 2].y - tp.y) || { x: -1, y: 0 };
      wing("t", "t", -1, tp, path.tw, tIn, restLen(chain[chain.length - 2], tp, null));
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
      var want = isSuspended() || !isEditable() ? {} : activeKeys();
      syncing = true;
      try {
        cy.batch(function () {
          var keep = {};
          var lines = [];
          Object.keys(want).forEach(function (key) {
            handleSpecs(key).forEach(function (sp) {
              keep[sp.id] = true;
              var n = cy.getElementById(sp.id);
              var data = {
                handleKind: sp.kind, bendIndex: sp.index,
                wingSide: sp.side || "", wingRest: sp.rest ? 1 : 0,
              };
              if (n.length === 0) {
                cy.add({
                  group: "nodes",
                  data: Object.assign({ id: sp.id, label: "", isEdgeHandle: 1, noExport: 1, pathKey: key }, data),
                  position: { x: sp.x, y: sp.y },
                });
              } else {
                n.data(data);
                if (!n.grabbed()) n.position({ x: sp.x, y: sp.y });
              }
              if (sp.anchorId) lines.push({ id: "edgehandle-line:" + sp.id, source: sp.anchorId, target: sp.id });
            });
          });
          cy.nodes("[isEdgeHandle]").forEach(function (n) {
            if (!keep[n.id()]) cy.remove(n);
          });
          // The thin line from each point to its wing (Photoshop's handle
          // bar). Synthetic edges: no path key, never exported.
          var keepLine = {};
          lines.forEach(function (l) {
            keepLine[l.id] = true;
            if (cy.getElementById(l.id).length) return;
            if (!cy.getElementById(l.source).length || !cy.getElementById(l.target).length) return;
            cy.add({ group: "edges", data: { id: l.id, source: l.source, target: l.target, isEdgeHandleLine: 1, noExport: 1, label: "" } });
          });
          cy.edges("[isEdgeHandleLine]").forEach(function (l) {
            if (!keepLine[l.id()]) cy.remove(l);
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
      return paths[key] || (paths[key] = _emptyPath());
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
      if (evt.originalEvent) altHeld = !!evt.originalEvent.altKey;
    });

    // Press on a line: maybe the start of a new bend.
    cy.on("tapstart", "edge", function (evt) {
      if (isSuspended() || !isEditable()) return;
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
        path.bends.splice(at, 0, snap(P));
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
        var sP = snap(P);
        cp.bends[creating.index].x = sP.x;
        cp.bends[creating.index].y = sP.y;
        applyKey(creating.key);
        if (isAdvanced()) { syncHandles(); return; } // its wings follow
        syncing = true;
        try { cy.getElementById(handleId(creating.key, "b" + creating.index)).position(sP); }
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
          bends: carriedBends(paths[key].bends, { x: 0, y: 0 }, { x: 0, y: 0 }), // a copy, wings kept
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
        // Carried by a selected-set drag the point follows exactly; dragged
        // on its own it lands on the fine grid while point snapping is on.
        var sp = h.grabbed() ? snap(p) : { x: p.x, y: p.y };
        path.bends[i].x = sp.x; // mutate: its wings (offsets) stay attached
        path.bends[i].y = sp.y;
        applyKey(key);
        if (sp.x !== p.x || sp.y !== p.y) {
          syncing = true;
          try { h.position(sp); } finally { syncing = false; }
        }
        if (isAdvanced()) syncHandles(); // wings and their bars ride along
        return;
      }
      if (kind === "wing") { onWingMoved(h, e, key, path); return; }
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
      if (isAdvanced()) syncHandles(); // the end's wing moves with it
    }

    // A wing dragged: its offset from the point becomes real (the point
    // turns smooth), and on a bend the opposite wing stays collinear and
    // keeps its length — unless Alt is held, which moves this wing alone.
    // Dragging a resting wing of a straight point curves it; its partner
    // mirrors the drag at the same length.
    function onWingMoved(h, e, key, path) {
      if (!h.grabbed()) return; // only an operator's drag edits a wing
      var side = h.data("wingSide");
      var p = h.position();
      if (side === "s" || side === "t") {
        if (isEmptyPath(path)) seedFromRendered(key);
        var ap = attachPoints(e, path);
        var a = side === "s" ? ap.s : ap.t;
        path[side + "w"] = { x: p.x - a.x, y: p.y - a.y };
      } else {
        var b = path.bends[h.data("bendIndex")];
        if (!b) return;
        var other = side === "in" ? "out" : "in";
        var off = { x: p.x - b.x, y: p.y - b.y };
        var otherLen = b[other] ? Math.sqrt(b[other].x * b[other].x + b[other].y * b[other].y) : 0;
        b[side] = off;
        var mirrored = mirroredWing(off, otherLen, altHeld, b[other]);
        if (mirrored) b[other] = mirrored;
        else delete b[other];
      }
      applyKey(key);
      syncHandles(); // the partner wing and the bars follow
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
      // Delete the selected handles: bends go (with their wings), end points
      // return to automatic (direction and wing), and a wing puts its point
      // back to a sharp corner (both wings of a bend). True when anything was
      // removed (the caller then swallows the key press).
      deleteSelected: function () {
        if (isSuspended() || !isEditable()) return false;
        var sel = cy.nodes("[isEdgeHandle]:selected");
        if (sel.length === 0) return false;
        var drop = {};
        sel.forEach(function (h) {
          var key = h.data("pathKey");
          var path = paths[key];
          if (!path) return;
          var kind = h.data("handleKind");
          var side = h.data("wingSide");
          if (kind === "bend") (drop[key] = drop[key] || []).push(h.data("bendIndex"));
          else if (kind === "wing" && (side === "s" || side === "t")) path[side + "w"] = null;
          else if (kind === "wing") {
            var b = path.bends[h.data("bendIndex")];
            if (b) { delete b.in; delete b.out; }
          } else {
            var end = kind === "source" ? "s" : "t";
            path[end] = null;
            path[end + "w"] = null;
          }
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
      // Re-state the handles after the host's isEditable() answer changed.
      refresh: function () { syncHandles(); },
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
    isCurvedPath: isCurvedPath,
    sampleCurve: sampleCurve,
    mirroredWing: mirroredWing,
    perimeterOffset: perimeterOffset,
    segmentGeometry: segmentGeometry,
    insertIndex: insertIndex,
    carriedBends: carriedBends,
    attach: attach,
  };
})();
