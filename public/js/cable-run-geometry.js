/**
 * public/js/cable-run-geometry.js — the geometry of a device link routed
 * through cable runs (business rule 184(a)).
 *
 *   window.PolarisCableRunGeometry.route(S, T, runs) → [[lng, lat], ...]
 *
 * A link between devices S and T that rides one or more runs leaves S, joins
 * the first run at its point nearest S, follows it, crosses to the next run
 * where the two come closest, … and leaves the last run at its point nearest
 * T. Points are WGS84 `[lng, lat]` (a run's z is ignored here); distances are
 * measured in Web Mercator metres, which keeps "nearest" and "closest" true
 * to what the operator sees on the map. Pure functions, no DOM, no Leaflet.
 */
(function () {
  "use strict";

  var R = 6378137;
  var MAX_LAT = 85.05112878;

  function project(p) {
    var lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, p[1]));
    var s = Math.sin(lat * Math.PI / 180);
    return { x: R * p[0] * Math.PI / 180, y: R * Math.log((1 + s) / (1 - s)) / 2 };
  }
  function unproject(q) {
    return [q.x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(q.y / R)) - Math.PI / 2) * 180 / Math.PI];
  }

  /**
   * Where on a polyline lies nearest point `p`.
   * → { at, dist, point } — `at` is the fractional vertex position
   *   (segment index + t along it), `point` the [lng, lat] there.
   */
  function nearest(line, p) {
    var q = project(p);
    var best = null;
    for (var i = 0; i < line.length - 1; i++) {
      var a = project(line[i]), b = project(line[i + 1]);
      var dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      var x = a.x + t * dx, y = a.y + t * dy;
      var d = Math.sqrt((q.x - x) * (q.x - x) + (q.y - y) * (q.y - y));
      if (!best || d < best.dist) best = { at: i + t, dist: d, xy: { x: x, y: y } };
    }
    if (!best) {
      if (!line.length) return null;
      var o = project(line[0]);
      return { at: 0, dist: Math.sqrt((o.x - q.x) * (o.x - q.x) + (o.y - q.y) * (o.y - q.y)), point: line[0].slice(0, 2) };
    }
    return { at: best.at, dist: best.dist, point: unproject(best.xy) };
  }

  function pointAt(line, at) {
    var i = Math.min(Math.floor(at), line.length - 2);
    if (i < 0) return line[0].slice(0, 2);
    var t = at - i;
    var a = project(line[i]), b = project(line[i + 1]);
    return unproject({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) });
  }

  /** The part of a polyline from position `from` to position `to`, either direction. */
  function subPath(line, from, to) {
    var out = [pointAt(line, from)];
    var i;
    if (to >= from) {
      for (i = Math.floor(from) + 1; i < to; i++) out.push(line[i].slice(0, 2));
    } else {
      for (i = Math.ceil(from) - 1; i > to; i--) out.push(line[i].slice(0, 2));
    }
    out.push(pointAt(line, to));
    return out;
  }

  /**
   * Where two runs come closest: { a, b } positions on each. Checked from
   * every vertex of each onto the other, which finds the true minimum unless
   * the two lines cross mid-segment (then a vertex beside the crossing wins,
   * close enough for a drawing).
   */
  function closestPair(lineA, lineB) {
    var best = null;
    lineB.forEach(function (p, j) {
      var n = nearest(lineA, p);
      if (n && (!best || n.dist < best.dist)) best = { a: n.at, b: j, dist: n.dist };
    });
    lineA.forEach(function (p, i) {
      var n = nearest(lineB, p);
      if (n && (!best || n.dist < best.dist)) best = { a: i, b: n.at, dist: n.dist };
    });
    return best || { a: 0, b: 0, dist: 0 };
  }

  /** The device-to-device order of a link's runs: by where each run is nearest S, along S → T. */
  function orderRuns(S, T, runs) {
    var s = project(S), t = project(T);
    var dx = t.x - s.x, dy = t.y - s.y, len2 = dx * dx + dy * dy;
    return runs.map(function (r, i) {
      var n = nearest(r.points, S);
      var m = nearest(r.points, T);
      var u = function (pt) { if (!pt || !(len2 > 0)) return 0; var q = project(pt); return ((q.x - s.x) * dx + (q.y - s.y) * dy) / len2; };
      return { r: r, key: (u(n && n.point) + u(m && m.point)) / 2, i: i };
    }).sort(function (a, b) { return a.key - b.key || a.i - b.i; }).map(function (x) { return x.r; });
  }

  /**
   * The routed line from S to T through `runs` (each `{ points }`, already
   * in order — see orderRuns), S and T included. Runs with fewer than two
   * points are skipped; with none left the line is straight.
   */
  function route(S, T, runs) {
    var lines = (runs || []).map(function (r) { return r.points; }).filter(function (p) { return p && p.length >= 2; });
    if (!lines.length) return [S.slice(0, 2), T.slice(0, 2)];
    var out = [S.slice(0, 2)];
    var entry = nearest(lines[0], S).at;
    for (var i = 0; i < lines.length; i++) {
      var exit, nextEntry = null;
      if (i === lines.length - 1) {
        exit = nearest(lines[i], T).at;
      } else {
        var pair = closestPair(lines[i], lines[i + 1]);
        exit = pair.a;
        nextEntry = pair.b;
      }
      subPath(lines[i], entry, exit).forEach(function (p) { out.push(p); });
      entry = nextEntry;
    }
    out.push(T.slice(0, 2));
    // Drop repeats (a join exactly on a vertex).
    return out.filter(function (p, k) { return k === 0 || p[0] !== out[k - 1][0] || p[1] !== out[k - 1][1]; });
  }

  /** The midpoint (by vertex position) of the stretch a link rides on one run — where its handle sits. */
  function rideMidpoint(S, T, ordered, index) {
    var lines = ordered.map(function (r) { return r.points; });
    var line = lines[index];
    if (!line || line.length < 2) return null;
    var entry = index === 0 ? nearest(line, S).at : closestPair(lines[index - 1], line).b;
    var exit = index === lines.length - 1 ? nearest(line, T).at : closestPair(line, lines[index + 1]).a;
    return pointAt(line, (entry + exit) / 2);
  }

  window.PolarisCableRunGeometry = {
    route: route,
    orderRuns: orderRuns,
    rideMidpoint: rideMidpoint,
    nearest: nearest,
    subPath: subPath,
    closestPair: closestPair,
  };
})();
