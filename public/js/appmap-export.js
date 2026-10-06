// public/js/appmap-export.js — Application Map → PDF.
//
// The map is NOT rasterised. buildScene() reads the drawn graph out of the live
// Cytoscape instance (box geometry, edge curves, labels, colours) into a
// neutral model-space "scene", and the PDF writer draws that scene as vectors:
// print stays sharp at any size, the text is real text, and — the point of the
// exercise — the printed size of every label is under our control.
//
// Minimum printed text size. The scale is chosen so the SMALLEST label on the
// map (the 9px edge port labels) prints at no less than the operator's chosen
// minimum (default MIN_PRINT_PT). A map that cannot fit one sheet at that scale
// is split into overlapping sections across several sheets, preceded by an
// overview page that shows the whole map with the section grid on it. The
// overview carries NO map labels — at fit-to-page scale they would print below
// the minimum, and an unreadable label is worse than none.
//
// Colours come from appmapStylesheet("light") via PolarisAppMap.exportContext()
// — paper is white whatever theme the operator is looking at, and reading the
// stylesheet (rather than copying its values here) keeps the two in step.
//
// Depends on: window.PolarisAppMap (appmap.js), window.jspdf (vendor),
// openModal / closeModal / showToast / currentUsername (app.js).

(function () {
  "use strict";

  // 7pt: 6pt is the usual floor for small print and office laser printers
  // smear monospace digits there; one point above it keeps "tcp/1433" legible.
  var MIN_PRINT_PT = 7;
  var MIN_PT_CHOICES = [7, 8, 9, 10, 12];
  // Sizes in points (1/72 in), portrait width × height.
  var PAPER = {
    letter:  { label: "Letter (8.5 × 11 in)",  w: 612,    h: 792 },
    legal:   { label: "Legal (8.5 × 14 in)",   w: 612,    h: 1008 },
    tabloid: { label: "Tabloid (11 × 17 in)",  w: 792,    h: 1224 },
    a4:      { label: "A4 (210 × 297 mm)",     w: 595.28, h: 841.89 },
    a3:      { label: "A3 (297 × 420 mm)",     w: 841.89, h: 1190.55 },
  };
  var MARGIN = 28;          // pt, every edge of the sheet
  var OVERLAP = 24;         // pt shared by neighbouring sections, for taping up
  var MAX_SCALE = 1.5;      // never blow a small map up past 1.5 pt per px
  var LOTS_OF_PAGES = 30;   // past this the dialog suggests narrowing the map first

  // ─── Pure helpers (exposed for tests) ───────────────────────────────

  // "#rrggbb" + alpha over white → "#rrggbb". Paper has no alpha channel worth
  // trusting across printers, so translucency is resolved here.
  function mixWithWhite(hex, alpha) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return "#999999";
    var n = parseInt(m[1], 16);
    var ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      var v = Math.round(c * alpha + 255 * (1 - alpha));
      return ("0" + v.toString(16)).slice(-2);
    });
    return "#" + ch.join("");
  }

  // Section name for a tile: rows are letters, columns numbers ("B3").
  function sectionName(row, col) {
    var s = "", r = row;
    do { s = String.fromCharCode(65 + (r % 26)) + s; r = Math.floor(r / 26) - 1; } while (r >= 0);
    return s + (col + 1);
  }

  // How many sheets, at what scale. `gw`/`gh` are the drawing's size in model
  // px; `contentW`/`contentH` the printable area per sheet in pt. The scale is
  // the largest that fits one sheet, unless that would print the smallest
  // label below `minPt` — then it is pinned at exactly the minimum and the
  // drawing is cut into sections that overlap by `overlap` pt.
  // Returns { scale, cols, rows, single, offsetX, offsetY, stepX, stepY } with
  // offsets/steps in model px (where section (r, c) starts).
  function planPages(gw, gh, minFontPx, minPt, contentW, contentH, overlap, maxScale) {
    gw = Math.max(1, gw); gh = Math.max(1, gh);
    var sMin = minPt / Math.max(1, minFontPx);
    var sFit = Math.min(contentW / gw, contentH / gh);
    if (sFit >= sMin) {
      var s = Math.min(sFit, maxScale || MAX_SCALE);
      return {
        scale: s, cols: 1, rows: 1, single: true,
        // Centre the drawing on the sheet.
        offsetX: -(contentW / s - gw) / 2, offsetY: -(contentH / s - gh) / 2,
        stepX: 0, stepY: 0,
      };
    }
    var pw = gw * sMin, ph = gh * sMin;
    var cols = pw <= contentW ? 1 : Math.ceil((pw - overlap) / (contentW - overlap));
    var rows = ph <= contentH ? 1 : Math.ceil((ph - overlap) / (contentH - overlap));
    return {
      scale: sMin, cols: cols, rows: rows, single: false,
      // A map one section wide (or tall) is centred across the sheet in that
      // direction rather than hugging the left (or top) margin.
      offsetX: cols === 1 ? -(contentW / sMin - gw) / 2 : 0,
      offsetY: rows === 1 ? -(contentH / sMin - gh) / 2 : 0,
      stepX: (contentW - overlap) / sMin, stepY: (contentH - overlap) / sMin,
    };
  }

  // Which sections have anything in them. A sprawling layout leaves whole
  // sections of blank paper between clusters; those are not printed (the
  // overview's grid still shows where the printed ones sit). `rects` are
  // model-px extents {x1,y1,x2,y2}; section (r, c) covers
  // [x0 + c*stepX, x0 + c*stepX + secW] × [y0 + r*stepY, ...].
  // Returns [{row, col}] in reading order.
  function occupiedSections(rows, cols, x0, y0, stepX, stepY, secW, secH, rects) {
    var hit = {};
    function range(lo, hi, origin, step, span, n) {
      if (n === 1 || !step) return [0, 0];
      var a = Math.max(0, Math.ceil((lo - span - origin) / step));
      var b = Math.min(n - 1, Math.floor((hi - origin) / step));
      return [a, b];
    }
    (rects || []).forEach(function (rc) {
      var cr = range(rc.x1, rc.x2, x0, stepX, secW, cols);
      var rr = range(rc.y1, rc.y2, y0, stepY, secH, rows);
      for (var r = rr[0]; r <= rr[1]; r++) for (var c = cr[0]; c <= cr[1]; c++) hit[r + "," + c] = true;
    });
    var out = [];
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) if (hit[r + "," + c]) out.push({ row: r, col: c });
    return out;
  }

  // Model-px extent of everything a scene draws, labels included, as rects.
  function sceneRects(scene) {
    var out = [];
    scene.boxes.concat(scene.children).forEach(function (b) {
      var lines = b.label.length * b.fontPx * 1.2;
      out.push({
        x1: b.x1, x2: b.x2,
        y1: b.labelPos === "top" ? b.y1 - 6 - lines : b.y1,
        y2: b.labelPos === "below" ? b.y2 + (b.labelGap || 5) + lines : b.y2,
      });
    });
    scene.edges.forEach(function (e) {
      var xs = [], ys = [];
      e.path.forEach(function (p) {
        xs.push(p.x); ys.push(p.y);
        if (p.type === "Q") { xs.push(p.cx); ys.push(p.cy); }
      });
      out.push({ x1: Math.min.apply(null, xs), y1: Math.min.apply(null, ys), x2: Math.max.apply(null, xs), y2: Math.max.apply(null, ys) });
    });
    return out;
  }

  // Quadratic Bézier → the cubic control points jsPDF draws.
  function quadToCubic(p0, q, p2) {
    return [
      { x: p0.x + (2 / 3) * (q.x - p0.x), y: p0.y + (2 / 3) * (q.y - p0.y) },
      { x: p2.x + (2 / 3) * (q.x - p2.x), y: p2.y + (2 / 3) * (q.y - p2.y) },
    ];
  }

  // An edge's path as [{type:"M"|"L"|"Q", ...}] in model px, from what
  // Cytoscape actually drew. Bezier edges with several control points are a
  // chain of quadratics joined at the midpoints between control points — the
  // same construction Cytoscape renders.
  function edgePath(src, tgt, ctrl, segs) {
    var path = [{ type: "M", x: src.x, y: src.y }];
    if (ctrl && ctrl.length) {
      for (var i = 0; i < ctrl.length; i++) {
        var end = i === ctrl.length - 1 ? tgt
          : { x: (ctrl[i].x + ctrl[i + 1].x) / 2, y: (ctrl[i].y + ctrl[i + 1].y) / 2 };
        path.push({ type: "Q", cx: ctrl[i].x, cy: ctrl[i].y, x: end.x, y: end.y });
      }
    } else if (segs && segs.length) {
      segs.forEach(function (p) { path.push({ type: "L", x: p.x, y: p.y }); });
      path.push({ type: "L", x: tgt.x, y: tgt.y });
    } else {
      path.push({ type: "L", x: tgt.x, y: tgt.y });
    }
    return path;
  }

  // ─── Scene (live graph → neutral drawing model) ─────────────────────

  function sheetStyle(sheet, selectorPrefix) {
    for (var i = 0; i < sheet.length; i++) {
      if (sheet[i].selector.indexOf(selectorPrefix) === 0) return sheet[i].style;
    }
    return {};
  }

  function px(v, dflt) {
    var n = parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  function labelLines(s) {
    return String(s || "").split("\n").filter(function (l) { return l.length; });
  }

  // PURE given a cy-like object (exposed for tests through a stub).
  function buildScene(cy, sheet, neutral) {
    var sAsset = sheetStyle(sheet, 'node[kind="asset"]');
    var sProc = sheetStyle(sheet, 'node[kind="process"]');
    var sSvc = sheetStyle(sheet, 'node[kind="service"]');
    var sUnk = sheetStyle(sheet, 'node[kind="unknown-ip"]');
    var sEdge = sheetStyle(sheet, "edge");
    var sEdgeProc = sheetStyle(sheet, 'edge[kind="process"]');

    var scene = { boxes: [], children: [], edges: [], minFontPx: Infinity, bbox: null };
    function font(f) { if (f < scene.minFontPx) scene.minFontPx = f; return f; }

    cy.nodes().forEach(function (n) {
      var kind = n.data("kind");
      var bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
      var label = labelLines(n.data("label"));
      if (kind === "asset") {
        scene.boxes.push({
          kind: kind, shape: "round", x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2,
          fill: mixWithWhite(sAsset["background-color"], px(sAsset["background-opacity"], 0.1)),
          stroke: sAsset["border-color"], strokeWidth: px(sAsset["border-width"], 1.5), dashed: false,
          label: label, labelPos: "top", font: "sans", bold: true,
          fontPx: label.length ? font(px(sAsset["font-size"], 12)) : 12, textColor: sAsset.color,
        });
      } else if (kind === "process" || kind === "service") {
        var st = kind === "process" ? sProc : sSvc;
        scene.children.push({
          kind: kind, shape: "round", x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2,
          fill: st["background-color"], stroke: st["border-color"], strokeWidth: px(st["border-width"], 1.5),
          dashed: false, label: label, labelPos: "center", font: "mono", bold: false,
          fontPx: label.length ? font(px(st["font-size"], 11)) : 11, textColor: st.color,
        });
      } else {
        scene.children.push({
          kind: kind, shape: "ellipse", x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2,
          fill: sUnk["background-color"], stroke: sUnk["border-color"], strokeWidth: px(sUnk["border-width"], 1.5),
          dashed: true, label: label, labelPos: "below", font: "mono", bold: false,
          fontPx: label.length ? font(px(sUnk["font-size"], 10)) : 10, textColor: sUnk.color,
          labelGap: px(sUnk["text-margin-y"], 5),
        });
      }
    });

    cy.edges().forEach(function (e) {
      var kind = e.data("kind");
      var src = e.sourceEndpoint(), tgt = e.targetEndpoint();
      if (!src || !tgt || !isFinite(src.x) || !isFinite(tgt.x)) return;
      var ctrl = typeof e.controlPoints === "function" ? e.controlPoints() : null;
      var segs = typeof e.segmentPoints === "function" ? e.segmentPoints() : null;
      var stale = e.data("stale") === 1;
      var color = e.data("pcolor") || neutral;
      var label = labelLines(e.data("label"));
      var last = ctrl && ctrl.length ? ctrl[ctrl.length - 1] : (segs && segs.length ? segs[segs.length - 1] : src);
      scene.edges.push({
        kind: kind,
        path: edgePath(src, tgt, ctrl, segs),
        // Arrow direction: from the last control point into the target.
        arrowFrom: { x: last.x, y: last.y }, arrowTo: { x: tgt.x, y: tgt.y },
        color: stale ? mixWithWhite(color, 0.35) : color,
        width: kind === "process" ? px(sEdgeProc.width, 2.6) : px(sEdge.width, 1.8),
        dashed: kind === "external" || kind === "external-inbound",
        label: label, mid: e.midpoint(),
        fontPx: label.length ? font(px(sEdge["font-size"], 9)) : 9,
        textColor: stale ? mixWithWhite(sEdge.color || "#1a1a1a", 0.5) : (sEdge.color || "#1a1a1a"),
      });
    });

    // Labels included, so an asset name above the top row or an external IP
    // under the bottom row is inside the printed area.
    var bb = cy.elements().boundingBox({ includeLabels: true, includeOverlays: false });
    scene.bbox = { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, w: bb.w, h: bb.h };
    if (!isFinite(scene.minFontPx)) scene.minFontPx = 9;
    return scene;
  }

  // ─── PDF writer ─────────────────────────────────────────────────────

  function appName() {
    return (typeof _branding !== "undefined" && _branding && _branding.appName) ? _branding.appName : "Polaris";
  }

  var PILL_LABELS = { proto: "proto", port: "port", asset: "host", type: "type", process: "process", service: "service", external: "external", text: "text" };

  function describeFilters(ctx) {
    var parts = [];
    if (ctx.pills.length) {
      parts.push("Filters: " + ctx.pills.map(function (p) { return (PILL_LABELS[p.kind] || p.kind) + ": " + p.value; }).join(", "));
    }
    if (ctx.hiddenPorts.length) {
      parts.push("Hidden ports: " + ctx.hiddenPorts.map(function (k) { return k === "other" ? "Other" : k; }).join(", "));
    }
    if (ctx.hideExternal) parts.push("External hidden");
    if (ctx.hideWorkstations) parts.push("Workstations hidden");
    return parts.join("  |  ");
  }

  // The Ports key as flowed items, for the band at the foot of every sheet.
  // Hidden rows are not on the sheet, so they are not in the key either.
  function keyItems(ctx) {
    var items = [];
    var legend = ctx.legend;
    if (legend) {
      legend.rows.forEach(function (r) {
        if (r.hidden) return;
        var svc = ctx.portServiceName(r.key);
        items.push({ color: r.color || ctx.neutralEdgeColor, text: r.key + (svc ? " " + svc : ""), dashed: false });
      });
      if (legend.other.count && !legend.other.hidden) items.push({ color: ctx.neutralEdgeColor, text: "Other", dashed: false });
    }
    items.push({ color: "#555555", text: "dashed = external", dashed: true });
    items.push({ color: "#555555", text: "heavy = process to process", dashed: false, heavy: true });
    return items;
  }

  // Lays the key out across `width` pt; returns { lines: [[{item, x}]], height }.
  function layoutKey(doc, items, width, fontPt) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(fontPt);
    var SW = 16, GAP = 5, SEP = 12;
    var lines = [[]], x = 0;
    items.forEach(function (it) {
      var w = SW + GAP + doc.getTextWidth(it.text);
      if (x > 0 && x + w > width) { lines.push([]); x = 0; }
      lines[lines.length - 1].push({ item: it, x: x });
      x += w + SEP;
    });
    var lh = fontPt * 1.35;
    return { lines: lines, lineHeight: lh, height: lines.length * lh, swatch: SW, gap: GAP };
  }

  function sheetSize(paperKey, orientation) {
    var p = PAPER[paperKey] || PAPER.letter;
    return orientation === "portrait" ? { w: p.w, h: p.h } : { w: p.h, h: p.w };
  }

  // Everything the writer and the dialog's summary need, for one
  // paper/orientation/minimum choice. `orientation: "auto"` tries both and
  // keeps the one with fewer sheets (landscape on a tie — maps run wide).
  function layoutFor(ctx, scene, opts) {
    if (opts.orientation === "auto") {
      var land = layoutFor(ctx, scene, Object.assign({}, opts, { orientation: "landscape" }));
      var port = layoutFor(ctx, scene, Object.assign({}, opts, { orientation: "portrait" }));
      return port.sheets < land.sheets ? port : land;
    }
    var jsPDF = window.jspdf.jsPDF;
    var size = sheetSize(opts.paper, opts.orientation);
    var doc = new jsPDF({ orientation: opts.orientation, unit: "pt", format: [Math.min(size.w, size.h), Math.max(size.w, size.h)] });
    var textPt = Math.max(8, opts.minPt);
    var contentW = size.w - 2 * MARGIN;
    var key = layoutKey(doc, keyItems(ctx), contentW, textPt);
    var filters = describeFilters(ctx);
    var headerH = (Math.max(13, opts.minPt + 4)) + 6 + textPt * 1.35 * (filters ? 2 : 1) + 8;
    var footerH = textPt + 6;
    var contentTop = MARGIN + headerH;
    var contentH = size.h - contentTop - MARGIN - footerH - key.height - 8;
    var plan = planPages(scene.bbox.w, scene.bbox.h, scene.minFontPx, opts.minPt, contentW, contentH, OVERLAP, MAX_SCALE);
    var sections = plan.single ? [{ row: 0, col: 0 }] : occupiedSections(
      plan.rows, plan.cols, scene.bbox.x1 + plan.offsetX, scene.bbox.y1 + plan.offsetY,
      plan.stepX, plan.stepY, contentW / plan.scale, contentH / plan.scale, sceneRects(scene));
    return {
      orientation: opts.orientation, paper: opts.paper, minPt: opts.minPt, size: size,
      textPt: textPt, key: key, filters: filters, headerH: headerH,
      content: { x: MARGIN, y: contentTop, w: contentW, h: contentH },
      plan: plan,
      sections: sections,
      sheets: plan.single ? 1 : sections.length + 1,
    };
  }

  function setColor(doc, kind, hex) {
    if (kind === "draw") doc.setDrawColor(hex);
    else if (kind === "fill") doc.setFillColor(hex);
    else doc.setTextColor(hex);
  }

  // Draws the scene into `area` (pt) with model point (ox, oy) at its
  // top-left and `s` pt per model px. withText=false is the overview.
  function drawScene(doc, scene, area, ox, oy, s, withText) {
    function X(x) { return area.x + (x - ox) * s; }
    function Y(y) { return area.y + (y - oy) * s; }
    // Model-space window of this area, padded so a curve leaving the sheet
    // is still drawn up to the clip edge.
    var pad = 40;
    var wx1 = ox - pad, wy1 = oy - pad, wx2 = ox + area.w / s + pad, wy2 = oy + area.h / s + pad;
    function boxVisible(b) { return b.x2 >= wx1 && b.x1 <= wx2 && b.y2 >= wy1 && b.y1 <= wy2; }
    function edgeVisible(e) {
      var xs = e.path.map(function (p) { return p.x; }).concat(e.path.filter(function (p) { return p.type === "Q"; }).map(function (p) { return p.cx; }));
      var ys = e.path.map(function (p) { return p.y; }).concat(e.path.filter(function (p) { return p.type === "Q"; }).map(function (p) { return p.cy; }));
      return Math.max.apply(null, xs) >= wx1 && Math.min.apply(null, xs) <= wx2 &&
             Math.max.apply(null, ys) >= wy1 && Math.min.apply(null, ys) <= wy2;
    }

    doc.saveGraphicsState();
    doc.rect(area.x, area.y, area.w, area.h, null);
    doc.clip();
    doc.discardPath();

    function drawBox(b) {
      setColor(doc, "fill", b.fill);
      setColor(doc, "draw", b.stroke);
      doc.setLineWidth(Math.max(0.4, b.strokeWidth * s));
      doc.setLineDashPattern(b.dashed ? [3, 2] : [], 0);
      var w = (b.x2 - b.x1) * s, h = (b.y2 - b.y1) * s;
      if (b.shape === "ellipse") doc.ellipse(X((b.x1 + b.x2) / 2), Y((b.y1 + b.y2) / 2), w / 2, h / 2, "FD");
      else { var r = Math.min(6 * s, w / 4, h / 4); doc.roundedRect(X(b.x1), Y(b.y1), w, h, r, r, "FD"); }
      doc.setLineDashPattern([], 0);
    }

    function drawBoxLabel(b) {
      if (!b.label.length) return;
      var pt = b.fontPx * s;
      doc.setFont(b.font === "mono" ? "courier" : "helvetica", b.bold ? "bold" : "normal");
      doc.setFontSize(pt);
      setColor(doc, "text", b.textColor || "#1a1a1a");
      var lh = pt * 1.15, cx = X((b.x1 + b.x2) / 2);
      var y0;
      if (b.labelPos === "top") y0 = Y(b.y1) - 6 * s - (b.label.length - 1) * lh - pt * 0.25;
      else if (b.labelPos === "below") y0 = Y(b.y2) + (b.labelGap || 5) * s + pt * 0.8;
      else y0 = Y((b.y1 + b.y2) / 2) - (b.label.length - 1) * lh / 2 + pt * 0.35;
      b.label.forEach(function (line, i) { doc.text(line, cx, y0 + i * lh, { align: "center" }); });
    }

    function drawEdge(e) {
      setColor(doc, "draw", e.color);
      setColor(doc, "fill", e.color);
      doc.setLineWidth(Math.max(0.5, e.width * s));
      doc.setLineDashPattern(e.dashed ? [4 * s + 1, 3 * s + 1] : [], 0);
      var cur = { x: e.path[0].x, y: e.path[0].y };
      var ops = [];
      for (var i = 1; i < e.path.length; i++) {
        var p = e.path[i];
        if (p.type === "Q") {
          var c = quadToCubic(cur, { x: p.cx, y: p.cy }, p);
          ops.push([(c[0].x - cur.x) * s, (c[0].y - cur.y) * s, (c[1].x - cur.x) * s, (c[1].y - cur.y) * s, (p.x - cur.x) * s, (p.y - cur.y) * s]);
        } else {
          ops.push([(p.x - cur.x) * s, (p.y - cur.y) * s]);
        }
        cur = { x: p.x, y: p.y };
      }
      doc.lines(ops, X(e.path[0].x), Y(e.path[0].y), [1, 1], "S", false);
      doc.setLineDashPattern([], 0);
      // Arrowhead, tip on the target endpoint.
      var dx = e.arrowTo.x - e.arrowFrom.x, dy = e.arrowTo.y - e.arrowFrom.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len;
      var L = Math.max(6, e.width * 3.6) * s, W = L * 0.55;
      var tx = X(e.arrowTo.x), ty = Y(e.arrowTo.y);
      var bx = tx - ux * L, by = ty - uy * L;
      doc.triangle(tx, ty, bx - uy * W, by + ux * W, bx + uy * W, by - ux * W, "F");
    }

    function drawEdgeLabel(e) {
      if (!e.label.length) return;
      var pt = e.fontPx * s;
      doc.setFont("courier", "normal");
      doc.setFontSize(pt);
      var lh = pt * 1.15, padX = 2 * s + 0.5;
      var w = Math.max.apply(null, e.label.map(function (l) { return doc.getTextWidth(l); })) + 2 * padX;
      var h = e.label.length * lh + padX;
      var cx = X(e.mid.x), cy = Y(e.mid.y);
      doc.setFillColor("#ffffff");
      doc.rect(cx - w / 2, cy - h / 2, w, h, "F");
      setColor(doc, "text", e.textColor);
      var y0 = cy - h / 2 + padX / 2 + pt * 0.85;
      e.label.forEach(function (line, i) { doc.text(line, cx, y0 + i * lh, { align: "center" }); });
    }

    // Paint order matches the canvas: asset boxes, edges, child boxes, then
    // every label on top so no line ever crosses a word.
    var boxes = scene.boxes.filter(boxVisible);
    var children = scene.children.filter(boxVisible);
    var edges = scene.edges.filter(edgeVisible);
    boxes.forEach(drawBox);
    edges.forEach(drawEdge);
    children.forEach(drawBox);
    if (withText) {
      edges.forEach(drawEdgeLabel);
      boxes.forEach(drawBoxLabel);
      children.forEach(drawBoxLabel);
    }
    doc.restoreGraphicsState();
  }

  function drawKey(doc, L) {
    var key = L.key;
    var y = L.size.h - MARGIN - (L.textPt + 6) - key.height;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.textPt);
    key.lines.forEach(function (line, li) {
      var ly = y + li * key.lineHeight + key.lineHeight * 0.7;
      line.forEach(function (cell) {
        var x = MARGIN + cell.x;
        setColor(doc, "draw", cell.item.color);
        doc.setLineWidth(cell.item.heavy ? 2.6 : 1.8);
        doc.setLineDashPattern(cell.item.dashed ? [3, 2] : [], 0);
        doc.line(x, ly - L.textPt * 0.3, x + key.swatch, ly - L.textPt * 0.3);
        doc.setLineDashPattern([], 0);
        setColor(doc, "text", "#333333");
        doc.text(cell.item.text, x + key.swatch + key.gap, ly);
      });
    });
  }

  function drawChrome(doc, L, ctx, pageLabel, pageNo, pageCount, timestamp) {
    var titlePt = Math.max(13, L.minPt + 4);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(titlePt);
    setColor(doc, "text", "#282828");
    doc.text(appName() + " — Application Map", MARGIN, MARGIN + titlePt * 0.8);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.textPt);
    setColor(doc, "text", "#787878");
    var y = MARGIN + titlePt + 6;
    var line1 = "Generated: " + timestamp + (ctx.seenWithin ? "  |  Seen within: " + ctx.seenWithin : "") +
      (ctx.status ? "  |  " + ctx.status : "");
    doc.text(fitLine(doc, line1, L.content.w), MARGIN, y + L.textPt * 0.8);
    if (L.filters) doc.text(fitLine(doc, L.filters, L.content.w), MARGIN, y + L.textPt * 0.8 + L.textPt * 1.35);
    drawKey(doc, L);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.textPt);
    setColor(doc, "text", "#969696");
    doc.text("Page " + pageNo + " of " + pageCount + (pageLabel ? "  |  " + pageLabel : "") + "  |  " + appName() + " Application Map",
      L.size.w / 2, L.size.h - MARGIN + 4, { align: "center" });
  }

  // One line, ellipsised to `width` — the header never wraps into the map.
  function fitLine(doc, text, width) {
    if (doc.getTextWidth(text) <= width) return text;
    var t = text;
    while (t.length > 1 && doc.getTextWidth(t + "…") > width) t = t.slice(0, -1);
    return t + "…";
  }

  function writePdf(ctx, scene, L) {
    var jsPDF = window.jspdf.jsPDF;
    var size = L.size;
    var doc = new jsPDF({ orientation: L.orientation, unit: "pt", format: [Math.min(size.w, size.h), Math.max(size.w, size.h)] });
    var now = new Date();
    var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();
    var plan = L.plan, area = L.content, bb = scene.bbox;
    var pageNo = 1;

    if (plan.single) {
      drawScene(doc, scene, area, bb.x1 + plan.offsetX, bb.y1 + plan.offsetY, plan.scale, true);
      drawChrome(doc, L, ctx, "", 1, 1, timestamp);
    } else {
      // Overview: the whole map fitted to the sheet with the section grid on
      // top. No map text — at this scale it would print below the minimum.
      var sFit = Math.min(area.w / bb.w, area.h / bb.h);
      var oox = bb.x1 - (area.w / sFit - bb.w) / 2, ooy = bb.y1 - (area.h / sFit - bb.h) / 2;
      drawScene(doc, scene, area, oox, ooy, sFit, false);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(Math.max(10, L.minPt + 2));
      // Where section (r, c) starts, in model px — one helper, so the grid on
      // the overview and the section pages themselves cannot disagree.
      var secX = function (c) { return bb.x1 + plan.offsetX + c * plan.stepX; };
      var secY = function (r) { return bb.y1 + plan.offsetY + r * plan.stepY; };
      var secW = area.w / plan.scale, secH = area.h / plan.scale;
      // Only the sections that print get a cell; a blank stretch of the
      // drawing has no page, so it has no box on the overview either.
      L.sections.forEach(function (sec) {
          var r0 = sec.row, c0 = sec.col;
          // The grid cell, clipped to the drawing so the outer cells do not
          // run off into empty paper.
          var mx1 = Math.max(bb.x1, secX(c0)), mx2 = Math.min(bb.x2, secX(c0) + secW);
          var my1 = Math.max(bb.y1, secY(r0)), my2 = Math.min(bb.y2, secY(r0) + secH);
          var gx = area.x + (mx1 - oox) * sFit, gy = area.y + (my1 - ooy) * sFit;
          var gw = (mx2 - mx1) * sFit, gh = (my2 - my1) * sFit;
          doc.setDrawColor("#0288d1");
          doc.setLineWidth(0.8);
          doc.setLineDashPattern([4, 3], 0);
          doc.rect(gx, gy, gw, gh, "S");
          doc.setLineDashPattern([], 0);
          setColor(doc, "text", "#0288d1");
          doc.text(sectionName(r0, c0), gx + 4, gy + Math.max(10, L.minPt + 2));
      });
      var total = L.sections.length + 1;
      drawChrome(doc, L, ctx, "Overview — the map's labels are on the section pages that follow", pageNo, total, timestamp);
      L.sections.forEach(function (sec) {
        doc.addPage([Math.min(size.w, size.h), Math.max(size.w, size.h)], L.orientation);
        pageNo++;
        drawScene(doc, scene, area, secX(sec.col), secY(sec.row), plan.scale, true);
        drawChrome(doc, L, ctx,
          "Section " + sectionName(sec.row, sec.col) + " (row " + sectionName(sec.row, 0).replace(/\d+$/, "") +
            " of " + sectionName(plan.rows - 1, 0).replace(/\d+$/, "") + ", column " + (sec.col + 1) + " of " + plan.cols + ")",
          pageNo, total, timestamp);
      });
    }
    doc.save("polaris-application-map-" + now.toISOString().slice(0, 10) + ".pdf");
  }

  // ─── Dialog ─────────────────────────────────────────────────────────

  function optsKey() {
    var u = (typeof currentUsername !== "undefined" && currentUsername) ? currentUsername : "";
    return u ? "polaris-prefs-appmap-export-" + u : "";
  }

  function readOpts() {
    var o = { paper: "letter", orientation: "auto", minPt: MIN_PRINT_PT };
    try {
      var raw = JSON.parse(localStorage.getItem(optsKey()) || "null");
      if (raw && PAPER[raw.paper]) o.paper = raw.paper;
      if (raw && ["auto", "landscape", "portrait"].indexOf(raw.orientation) >= 0) o.orientation = raw.orientation;
      if (raw && MIN_PT_CHOICES.indexOf(raw.minPt) >= 0) o.minPt = raw.minPt;
    } catch (e) { /* private mode — defaults */ }
    return o;
  }

  function saveOpts(o) {
    var k = optsKey();
    if (!k) return;
    try { localStorage.setItem(k, JSON.stringify(o)); } catch (e) { /* best-effort */ }
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function summaryText(L, scene) {
    var paper = (PAPER[L.paper] || PAPER.letter).label.replace(/ \(.*/, "");
    var smallest = (L.plan.scale * scene.minFontPx).toFixed(1).replace(/\.0$/, "");
    if (L.plan.single) {
      return "Fits on one " + paper + " " + L.orientation + " sheet. Smallest text prints at about " + smallest + " pt.";
    }
    var grid = L.plan.rows * L.plan.cols, n = L.sections.length;
    var text = "Too big for one sheet at " + L.minPt + " pt: prints as " + n + " section page" + (n === 1 ? "" : "s") +
      " plus an overview page, " + paper + " " + L.orientation + " (a " + L.plan.rows + " × " + L.plan.cols + " grid" +
      (n < grid ? "; " + (grid - n) + " empty section" + (grid - n === 1 ? " is" : "s are") + " skipped" : "") +
      "). Neighbouring sections overlap slightly so they can be taped together. A larger paper size means fewer pages.";
    if (n > LOTS_OF_PAGES) {
      text += " That is a lot of paper — narrowing the map with filters or hidden ports first prints only what you need.";
    }
    return text;
  }

  function openExportDialog() {
    var ctx = window.PolarisAppMap && window.PolarisAppMap.exportContext();
    if (!ctx || !ctx.cy || ctx.cy.nodes().length === 0) {
      showToast("Nothing on the map to export", "error");
      return;
    }
    if (!window.jspdf || !window.jspdf.jsPDF) {
      showToast("PDF library not loaded. Reload the page and try again.", "error");
      return;
    }
    var scene = buildScene(ctx.cy, ctx.stylesheet, ctx.neutralEdgeColor);
    var o = readOpts();
    function options(list, cur) {
      return list.map(function (v) {
        return '<option value="' + esc(v.value) + '"' + (String(v.value) === String(cur) ? " selected" : "") + ">" + esc(v.label) + "</option>";
      }).join("");
    }
    var body =
      '<div class="form-group"><label for="appmap-export-paper">Paper size</label>' +
        '<select id="appmap-export-paper">' + options(Object.keys(PAPER).map(function (k) { return { value: k, label: PAPER[k].label }; }), o.paper) + "</select></div>" +
      '<div class="form-group"><label for="appmap-export-orientation">Orientation</label>' +
        '<select id="appmap-export-orientation">' + options([
          { value: "auto", label: "Automatic (fewest pages)" },
          { value: "landscape", label: "Landscape" },
          { value: "portrait", label: "Portrait" },
        ], o.orientation) + "</select></div>" +
      '<div class="form-group"><label for="appmap-export-minpt">Minimum text size</label>' +
        '<select id="appmap-export-minpt">' + options(MIN_PT_CHOICES.map(function (v) {
          return { value: v, label: v + " pt" + (v === MIN_PRINT_PT ? " (smallest readable)" : "") };
        }), o.minPt) + "</select>" +
        '<div class="hint">Nothing on the printed map is smaller than this. A map that cannot fit one sheet at this size is split across several.</div></div>' +
      '<div class="appmap-export-summary" id="appmap-export-summary" role="status"></div>' +
      '<div class="form-group"><div class="hint">Exports what is on screen now: the current filters, hidden ports and node positions.</div></div>';
    var footer =
      '<button type="button" class="btn btn-secondary" id="appmap-export-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary" id="appmap-export-go">Export PDF</button>';
    openModal("Export Application Map", body, footer);

    var current = null;
    function read() {
      return {
        paper: document.getElementById("appmap-export-paper").value,
        orientation: document.getElementById("appmap-export-orientation").value,
        minPt: Number(document.getElementById("appmap-export-minpt").value),
      };
    }
    function refresh() {
      current = layoutFor(ctx, scene, read());
      document.getElementById("appmap-export-summary").textContent = summaryText(current, scene);
    }
    ["appmap-export-paper", "appmap-export-orientation", "appmap-export-minpt"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", refresh);
    });
    document.getElementById("appmap-export-cancel").addEventListener("click", closeModal);
    document.getElementById("appmap-export-go").addEventListener("click", function () {
      var picked = read();
      saveOpts(picked);
      try {
        writePdf(ctx, scene, current || layoutFor(ctx, scene, picked));
        closeModal();
        showToast("Application Map exported");
      } catch (err) {
        showToast("Export failed: " + (err && err.message ? err.message : String(err)), "error");
      }
    });
    refresh();
  }

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("appmap-export");
    if (btn) btn.addEventListener("click", openExportDialog);
  });

  window.PolarisAppMapExport = {
    MIN_PRINT_PT: MIN_PRINT_PT,
    PAPER: PAPER,
    planPages: planPages,
    occupiedSections: occupiedSections,
    sectionName: sectionName,
    mixWithWhite: mixWithWhite,
    quadToCubic: quadToCubic,
    edgePath: edgePath,
    buildScene: buildScene,
    open: openExportDialog,
  };
})();
