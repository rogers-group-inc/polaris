/**
 * public/js/region-tree.js
 *
 * Everything decidable about the Device Map's region surfaces: the containment
 * tree HTML for the hover tooltip and for the Regions panel's list, the
 * drag-to-nest drop rule (business rule 121), the overlay paint order (by
 * area) and per-level styling, and the hover wiring itself.
 *
 * Lives here rather than in map.js because that file is one 3000-line IIFE with
 * no exports and hard Leaflet + Cytoscape dependencies — anything put in it is
 * permanently untestable. map.js keeps only the glue that genuinely needs a
 * map: creating layers, drawing polygons, fetching. Same split, and the same
 * browser-IIFE conventions, as `region-pills.js`.
 *
 * A failed payload is a fallback state, never an error: every function accepts
 * null/malformed input and returns something renderable.
 */
(function () {
  /**
   * A 200-region tooltip inside a 420px box would paint a full-screen wall, so
   * the tree stops here and says how many it left out.
   */
  var MAX_TOOLTIP_NODES = 60;

  function esc(s) {
    return typeof window.escapeHtml === "function" ? window.escapeHtml(String(s == null ? "" : s)) : String(s == null ? "" : s);
  }

  function regionsOf(payload) {
    return payload && Array.isArray(payload.regions) ? payload.regions : [];
  }

  /** "4 top-level regions · 3 levels", or a stated empty. */
  function summaryLine(payload) {
    var regions = regionsOf(payload);
    if (regions.length === 0) return "No regions are defined yet.";
    var roots = payload && Array.isArray(payload.roots) ? payload.roots.length : regions.filter(function (r) { return !r.parentId; }).length;
    var levels = payload && typeof payload.maxLevel === "number" ? payload.maxLevel : 1;
    return (
      regions.length + " region" + (regions.length === 1 ? "" : "s") + " · " +
      roots + " top-level · " +
      levels + " level" + (levels === 1 ? "" : "s")
    );
  }

  /** Direct children of `id` (or the roots when `id` is null), name-sorted. */
  function childrenOf(payload, id) {
    var regions = regionsOf(payload);
    return regions
      .filter(function (r) { return (r.parentId || null) === (id || null); })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  }

  /**
   * Nested <div>s where DOM order IS the tree — the condition-builder's
   * .scg-group/.scg-children shape. Depth here is unbounded (levels are derived
   * from however many polygons an operator nested), so one padding rule beats
   * the N generated depth classes the dependency tree uses.
   */
  function buildTreeHtml(payload, opts) {
    var options = opts || {};
    var cap = typeof options.maxNodes === "number" ? options.maxNodes : MAX_TOOLTIP_NODES;
    var regions = regionsOf(payload);
    if (regions.length === 0) {
      return '<div class="rtree-empty">No regions are defined yet — draw them on the Device Map.</div>';
    }

    var emitted = 0;

    function rowsFor(parentId) {
      var kids = childrenOf(payload, parentId);
      var out = "";
      for (var i = 0; i < kids.length; i++) {
        if (emitted >= cap) break;
        var r = kids[i];
        emitted++;
        var swatch = /^#[0-9a-fA-F]{6}$/.test(String(r.color || ""))
          ? '<span class="rtree-dot" style="background:' + esc(r.color) + '"></span>'
          : '<span class="rtree-dot"></span>';
        var count = Array.isArray(r.childIds) && r.childIds.length > 0
          ? ' <span class="rtree-count">' + r.childIds.length + " inside</span>"
          : "";
        out +=
          '<div class="rtree-row">' +
          swatch +
          '<span class="rtree-level-badge">L' + esc(r.level == null ? 1 : r.level) + "</span>" +
          '<span class="rtree-name">' + esc(r.name) + "</span>" +
          count +
          "</div>";
        var nested = rowsFor(r.id);
        if (nested) out += '<div class="rtree-children">' + nested + "</div>";
      }
      return out;
    }

    var body = rowsFor(null);
    var hidden = regions.length - emitted;
    var more = hidden > 0 ? '<div class="rtree-more">+' + hidden + " more not shown</div>" : "";
    return '<div class="rtree">' + body + more + "</div>";
  }

  /**
   * Overlap / duplicate / approximate findings, if any. These are the states
   * where an operator's drawing does not nest the way they probably intended,
   * and the tooltip is the only place they would ever see them.
   */
  function warningsHtml(payload) {
    var warnings = payload && Array.isArray(payload.warnings) ? payload.warnings : [];
    if (warnings.length === 0) return "";
    var names = {};
    regionsOf(payload).forEach(function (r) { names[r.id] = r.name; });
    var interesting = warnings.filter(function (w) {
      return w && (w.kind === "overlap" || w.kind === "duplicate" || w.kind === "approximate" || w.kind === "cap-exceeded" || w.kind === "self-intersecting");
    });
    if (interesting.length === 0) return "";
    var rows = interesting.slice(0, 5).map(function (w) {
      var who = names[w.regionId] || w.regionId || "";
      var other = w.otherRegionId ? names[w.otherRegionId] || w.otherRegionId : "";
      var subject = other ? esc(who) + " / " + esc(other) : esc(who);
      return '<div class="rtree-warn-row">' + esc(w.kind) + (subject ? ": " + subject : "") + "</div>";
    });
    var extra = interesting.length > 5 ? '<div class="rtree-warn-row">+' + (interesting.length - 5) + " more</div>" : "";
    return '<div class="rtree-warn">' + rows.join("") + extra + "</div>";
  }

  /**
   * Shoelace area of a [[lat, lng], ...] ring, in square degrees. Only ever
   * compared with another region's, so the projection does not matter: a ring
   * strictly inside another always has the smaller area.
   */
  function polygonArea(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return 0;
    var sum = 0;
    for (var i = 0; i < polygon.length; i++) {
      var a = polygon[i];
      var b = polygon[(i + 1) % polygon.length];
      if (!Array.isArray(a) || !Array.isArray(b)) return 0;
      sum += Number(a[1]) * Number(b[0]) - Number(b[1]) * Number(a[0]);
    }
    var area = Math.abs(sum) / 2;
    return isFinite(area) ? area : 0;
  }

  /**
   * Largest first, so a container paints UNDER every region inside it and the
   * inner region (the lower L#) stays the thing you can click. By AREA when
   * every region has a polygon, not by depth: a region an operator nested
   * straight under its division (drag-to-nest) shares a depth with the state
   * polygon it sits inside, and a depth-then-name order could paint that state
   * over it. Falls back to depth when a payload carries no geometry.
   */
  function paintOrder(payload) {
    var regions = regionsOf(payload).slice();
    var areas = {};
    var useArea = regions.length > 0;
    regions.forEach(function (r) {
      areas[r.id] = polygonArea(r.polygon);
      if (!(areas[r.id] > 0)) useArea = false;
    });
    return regions.sort(function (a, b) {
      if (useArea && areas[a.id] !== areas[b.id]) return areas[b.id] - areas[a.id];
      var da = typeof a.depth === "number" ? a.depth : 0;
      var db = typeof b.depth === "number" ? b.depth : 0;
      if (da !== db) return da - db;
      return String(a.name).localeCompare(String(b.name));
    });
  }

  /**
   * The Regions panel's list: the containment tree as nested rows (indent +
   * guide line per level), each with its colour, name and L#. Unlike the
   * tooltip tree there is no node cap — the panel scrolls.
   *
   * `opts.draggable` (edit mode) makes each row a drag source and drop target
   * for drag-to-nest; `canNestUnder` decides which drops are allowed.
   *
   * `opts.visibility` (view mode) gives each row an eye button
   * (`.map-regions-eye`, `data-region-eye="<id>"`) that shows / hides that one
   * region's polygon; `opts.hidden` is the `{id: true}` set currently hidden,
   * whose rows dim and whose eye is struck through. Hiding cascades
   * (`effectiveHidden`): rows nested under a hidden region dim too, and their
   * eye is struck and disabled until the container is shown again.
   */
  var EYE_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true">' +
      '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var EYE_OFF_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="13" height="13" aria-hidden="true">' +
      '<path d="M9.9 4.2A10.6 10.6 0 0 1 12 4c6.5 0 10 8 10 8a17.6 17.6 0 0 1-2.2 3.2"/>' +
      '<path d="M6.6 6.6C3.6 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>' +
      '<path d="M14.1 14.2a3 3 0 0 1-4.2-4.3"/><line x1="2" y1="2" x2="22" y2="22"/></svg>';

  // `inheritedFrom` (a name) marks a row hidden only because a region it sits
  // inside is hidden: its eye is struck and disabled, since showing it on its
  // own would contradict the hidden container.
  function eyeButtonHtml(r, hidden, inheritedFrom) {
    var name = String(r.name == null ? "" : r.name);
    var label = inheritedFrom != null
      ? name + " is hidden with " + inheritedFrom
      : (hidden ? "Show " : "Hide ") + name;
    return '<button type="button" class="map-regions-eye" data-region-eye="' + esc(r.id) + '"' +
      ' aria-pressed="' + (hidden ? "false" : "true") + '"' + (inheritedFrom != null ? " disabled" : "") +
      ' title="' + esc(label) + '" aria-label="' + esc(label) + '">' +
      (hidden ? EYE_OFF_ICON : EYE_ICON) + "</button>";
  }

  function eyeStateOf(r, effHidden, nameById) {
    var hider = effHidden[r.id];
    if (!hider) return { hidden: false, inheritedFrom: null };
    return { hidden: true, inheritedFrom: hider === r.id ? null : (nameById[hider] == null ? "" : String(nameById[hider])) };
  }

  /**
   * The regions a viewer's hidden set actually hides: every region they hid
   * plus everything nested under one (hiding an L2 hides the L1s inside it).
   * Returns `{regionId: hiderId}` — the hiderId is the region itself when the
   * viewer hid it, else the nearest hidden ancestor, so a row can say what it
   * is hidden with. Ids in `hidden` that match no region are ignored.
   */
  function effectiveHidden(payload, hidden) {
    var set = hidden && typeof hidden === "object" ? hidden : {};
    var byId = {};
    regionsOf(payload).forEach(function (r) { byId[r.id] = r; });
    var out = {};
    Object.keys(byId).forEach(function (id) {
      var cur = byId[id];
      var steps = 0;
      while (cur && steps++ < 64) {
        if (set[cur.id]) { out[id] = cur.id; return; }
        cur = cur.parentId ? byId[cur.parentId] : null;
      }
    });
    return out;
  }

  /** Ray-casting test of a point against a [[lat, lng], ...] ring. */
  function pointInPolygon(lat, lng, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return false;
    var y = Number(lat), x = Number(lng);
    if (!isFinite(x) || !isFinite(y)) return false;
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var yi = Number(polygon[i][0]), xi = Number(polygon[i][1]);
      var yj = Number(polygon[j][0]), xj = Number(polygon[j][1]);
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  /**
   * A `(lat, lng) -> boolean` test answering "is this point inside a region
   * the viewer has hidden?", or null when nothing is hidden (callers then
   * skip filtering altogether). Each hidden polygon carries a bounding box so
   * a 2000-site fleet pays a ring walk only for points near it.
   */
  function hiddenPointTest(payload, hidden) {
    var eff = effectiveHidden(payload, hidden);
    var rings = [];
    regionsOf(payload).forEach(function (r) {
      if (!eff[r.id] || !Array.isArray(r.polygon) || r.polygon.length < 3) return;
      var box = { minLat: Infinity, maxLat: -Infinity, minLng: Infinity, maxLng: -Infinity };
      r.polygon.forEach(function (p) {
        var la = Number(p[0]), ln = Number(p[1]);
        if (la < box.minLat) box.minLat = la;
        if (la > box.maxLat) box.maxLat = la;
        if (ln < box.minLng) box.minLng = ln;
        if (ln > box.maxLng) box.maxLng = ln;
      });
      rings.push({ polygon: r.polygon, box: box });
    });
    if (rings.length === 0) return null;
    return function (lat, lng) {
      var la = Number(lat), ln = Number(lng);
      for (var i = 0; i < rings.length; i++) {
        var b = rings[i].box;
        if (la < b.minLat || la > b.maxLat || ln < b.minLng || ln > b.maxLng) continue;
        if (pointInPolygon(la, ln, rings[i].polygon)) return true;
      }
      return false;
    };
  }

  function buildPanelTreeHtml(payload, opts) {
    var options = opts || {};
    var hiddenSet = options.hidden && typeof options.hidden === "object" ? options.hidden : {};
    var effHidden = options.visibility ? effectiveHidden(payload, hiddenSet) : {};
    var regions = regionsOf(payload);
    var nameById = {};
    regions.forEach(function (r) { nameById[r.id] = r.name; });
    if (regions.length === 0) {
      return '<span class="map-regions-empty">' + esc(options.emptyText || "No regions are defined yet.") + "</span>";
    }
    var seen = {};
    function rowsFor(parentId, depth) {
      var kids = childrenOf(payload, parentId);
      var out = "";
      for (var i = 0; i < kids.length; i++) {
        var r = kids[i];
        if (seen[r.id]) continue; // a malformed payload with a cycle
        seen[r.id] = true;
        var color = /^#[0-9a-fA-F]{6}$/.test(String(r.color || "")) ? ' style="background:' + esc(r.color) + '"' : "";
        // The overlay payload says so outright; the decorated list carries the
        // stored pick, which is in force when it IS the parent.
        var chosen = !!r.nestChosen || (!!r.nestUnderId && r.nestUnderId === r.parentId);
        var title = chosen ? ' title="Nested here by hand — drop it on another region that contains it to move it"' : "";
        var eye = eyeStateOf(r, effHidden, nameById);
        out +=
          '<div class="map-regions-node">' +
            '<div class="map-regions-row' + (chosen ? " map-regions-row-chosen" : "") + (eye.hidden ? " map-regions-row-hidden" : "") +
              '" data-region-id="' + esc(r.id) + '"' +
              (options.draggable ? ' draggable="true"' : "") + title + ">" +
              (options.visibility ? eyeButtonHtml(r, eye.hidden, eye.inheritedFrom) : "") +
              '<i class="map-region-swatch"' + color + ' aria-hidden="true"></i>' +
              '<span class="map-regions-row-name">' + esc(r.name) + "</span>" +
              "<em>L" + esc(r.level == null ? 1 : r.level) + "</em>" +
            "</div>";
        var nested = depth < 32 ? rowsFor(r.id, depth + 1) : "";
        if (nested) out += '<div class="map-regions-children">' + nested + "</div>";
        out += "</div>";
      }
      return out;
    }
    var body = rowsFor(null, 0);
    // Anything a malformed payload left unreachable from a root still lists.
    regions.forEach(function (r) {
      if (!seen[r.id]) {
        seen[r.id] = true;
        var eye = eyeStateOf(r, effHidden, nameById);
        body += '<div class="map-regions-node"><div class="map-regions-row' + (eye.hidden ? " map-regions-row-hidden" : "") +
          '" data-region-id="' + esc(r.id) + '">' +
          (options.visibility ? eyeButtonHtml(r, eye.hidden, eye.inheritedFrom) : "") +
          '<span class="map-regions-row-name">' + esc(r.name) + "</span><em>L" + esc(r.level == null ? 1 : r.level) + "</em></div></div>";
      }
    });
    return body;
  }

  /**
   * May `childId` be nested under `targetId`? Only when the target's polygon
   * contains it (the server's containerIds — geometry stays the authority) and
   * it is not already the parent. Returns {ok, reason}.
   */
  function canNestUnder(payload, childId, targetId) {
    var byId = {};
    regionsOf(payload).forEach(function (r) { byId[r.id] = r; });
    var child = byId[childId];
    var target = byId[targetId];
    if (!child || !target) return { ok: false, reason: "That region is no longer on the map." };
    if (childId === targetId) return { ok: false, reason: "" };
    if ((child.parentId || null) === targetId) {
      return { ok: false, reason: '"' + child.name + '" is already nested under "' + target.name + '".' };
    }
    var containers = Array.isArray(child.containerIds) ? child.containerIds : [];
    if (containers.indexOf(targetId) === -1) {
      return {
        ok: false,
        reason: '"' + child.name + '" is not inside "' + target.name + '" on the map, so it cannot be nested under it. Reshape the polygons first.',
      };
    }
    return { ok: true, reason: "" };
  }

  /**
   * Read-only polygon styling per level. Fill opacity stays low because nesting
   * STACKS it — three concentric regions at 0.18 would read as one opaque blob
   * and hide the map underneath. Only top-level regions get a permanent label;
   * labelling every ring at every depth is unreadable.
   */
  function overlayStyle(level, maxLevel) {
    var lv = typeof level === "number" ? level : 1;
    var top = typeof maxLevel === "number" && maxLevel > 0 ? maxLevel : 1;
    return {
      weight: lv >= top ? 3 : 2,
      fillOpacity: 0.06,
      dashArray: lv >= top && top > 1 ? null : "4 3",
      labelPermanent: lv >= top && top > 1,
    };
  }

  /**
   * Hover wiring for a toolbar button. `getPayload` is an async loader,
   * `tip` is the injected {show, move, hide} tooltip surface — passed in rather
   * than reached for, so this is drivable from a test with no Leaflet and no
   * real tooltip element.
   */
  function attachTreeTooltip(button, getPayload, tip) {
    if (!button || !tip) return;
    var token = 0;
    var open = false;

    function render(payload) {
      return (
        '<div class="rtree-tip">' +
        '<div class="rtree-summary">' + esc(summaryLine(payload)) + "</div>" +
        buildTreeHtml(payload) +
        warningsHtml(payload) +
        "</div>"
      );
    }

    function enter(ev) {
      open = true;
      var mine = ++token;
      var x = ev && typeof ev.clientX === "number" ? ev.clientX : 0;
      var y = ev && typeof ev.clientY === "number" ? ev.clientY : 0;
      tip.show('<div class="rtree-tip"><div class="rtree-summary">Loading regions…</div></div>', x, y);
      Promise.resolve()
        .then(getPayload)
        .then(function (payload) {
          // Discard a fetch that resolved AFTER the pointer left, or a slow API
          // leaves a tooltip stuck on screen with nothing to dismiss it.
          if (!open || mine !== token) return;
          tip.show(render(payload), x, y);
        })
        .catch(function () {
          if (!open || mine !== token) return;
          tip.show('<div class="rtree-tip"><div class="rtree-summary">Regions could not be loaded.</div></div>', x, y);
        });
    }

    function move(ev) {
      if (!open) return;
      tip.move(ev && typeof ev.clientX === "number" ? ev.clientX : 0, ev && typeof ev.clientY === "number" ? ev.clientY : 0);
    }

    function leave() {
      open = false;
      token++;
      tip.hide();
    }

    button.addEventListener("mouseenter", enter);
    button.addEventListener("mousemove", move);
    button.addEventListener("mouseleave", leave);
    // Keyboard reach: the tree is information, not decoration.
    button.addEventListener("focus", enter);
    button.addEventListener("blur", leave);
  }

  window.PolarisRegionTree = {
    MAX_TOOLTIP_NODES: MAX_TOOLTIP_NODES,
    summaryLine: summaryLine,
    childrenOf: childrenOf,
    buildTreeHtml: buildTreeHtml,
    warningsHtml: warningsHtml,
    paintOrder: paintOrder,
    polygonArea: polygonArea,
    buildPanelTreeHtml: buildPanelTreeHtml,
    effectiveHidden: effectiveHidden,
    pointInPolygon: pointInPolygon,
    hiddenPointTest: hiddenPointTest,
    canNestUnder: canNestUnder,
    overlayStyle: overlayStyle,
    attachTreeTooltip: attachTreeTooltip,
  };
})();
