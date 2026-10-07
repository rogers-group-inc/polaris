// public/js/graph-export.js — export a Cytoscape graph as PDF or Visio.
//
// Shared by the Application Map (appmap-export.js), the Device Map's site
// topology (map.js) and the traceroute path map (assets.js — the asset
// slide-over's Paths tab and Path Monitor → Results). Each page hands over an
// export CONTEXT — its live cy and its stylesheet in the daylight palette, OR
// a ready-made scene (a graph that is not Cytoscape draws its own) — plus a
// title, a line or two saying what narrowed the view, and the items of its
// key, and opens the Export menu (Screenshot / PDF / Visio) with openMenu().
//
// Nothing is rasterised. sceneFromCy() reads what Cytoscape actually drew —
// node shapes and boxes, edge routes (bezier control points, taxi and segment
// bends), arrowheads, labels, icons, colours, dashes — from each element's
// COMPUTED style into a neutral model-space "scene", after briefly swapping
// in the daylight stylesheet (paper is white whatever theme is on screen).
// The PDF and Visio writers draw that scene; neither knows which map it came
// from.
//
// PDF: minimum printed text size. The scale is chosen so the SMALLEST label in
// the scene prints at no less than the operator's minimum (default
// MIN_PRINT_PT). A graph that cannot fit one sheet at that scale is cut into
// overlapping sections (empty ones skipped) after an overview page showing the
// whole graph with the section grid. The overview carries NO graph text — at
// fit-to-page scale it would print below the minimum, and an unreadable label
// is worse than none.
//
// Visio: one page sized to the graph at 1 model px = 1 pt, every node and
// connection its own editable shape. Deliberately conservative: connections
// are 2-D line shapes (not glued 1-D connectors), text takes Visio's default
// font, and device icons are left out. The title, the header lines and the key
// go on the page as text and swatch shapes above and below the drawing
// (withHeaderAndKey), as the PDF prints them. The package itself is the shape
// Visio for the web accepts — see vsdxDocumentXml.
//
// Depends on: window.jspdf (vendor), cytoscape (the cy handed in),
// openModal / closeModal / showToast / showRowMenu / currentUsername (app.js).

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
  var MAX_SCALE = 1.5;      // never blow a small graph up past 1.5 pt per px
  var LOTS_OF_PAGES = 30;   // past this the dialog suggests narrowing the view first

  // ─── Pure helpers (exposed for tests) ───────────────────────────────

  function hex2(n) { return ("0" + Math.max(0, Math.min(255, Math.round(n))).toString(16)).slice(-2); }

  // Cytoscape colour value ([r,g,b] or "#rrggbb") → "#rrggbb".
  function toHex(v) {
    if (Array.isArray(v)) return "#" + hex2(v[0]) + hex2(v[1]) + hex2(v[2]);
    var m = /^#?([0-9a-f]{6})$/i.exec(String(v || "").trim());
    if (m) return "#" + m[1].toLowerCase();
    var s = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(String(v || "").trim());
    if (s) return ("#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase();
    return null;
  }

  // "#rrggbb" + alpha over white → "#rrggbb". Paper has no alpha channel worth
  // trusting across printers (or Visio), so translucency is resolved here.
  function mixWithWhite(hex, alpha) {
    var h = toHex(hex);
    if (!h) return "#999999";
    var n = parseInt(h.slice(1), 16);
    return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(function (c) {
      return hex2(c * alpha + 255 * (1 - alpha));
    }).join("");
  }

  // Section name for a tile: rows are letters, columns numbers ("B3").
  function sectionName(row, col) {
    return rowName(row) + (col + 1);
  }

  function rowName(row) {
    var s = "", r = row;
    do { s = String.fromCharCode(65 + (r % 26)) + s; r = Math.floor(r / 26) - 1; } while (r >= 0);
    return s;
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
      // A graph one section wide (or tall) is centred across the sheet in that
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
  // same construction Cytoscape renders. Segment / taxi bends are straight runs.
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

  // The point an arrowhead points AWAY from: for the target end, the last
  // segment's control point (a curve) or its start (a straight run); for the
  // source end, the first segment's control point or its end.
  function arrowFrom(path, atTarget) {
    if (atTarget) {
      var last = path[path.length - 1];
      if (last.type === "Q") return { x: last.cx, y: last.cy };
      var prev = path[path.length - 2];
      return { x: prev.x, y: prev.y };
    }
    var first = path[1];
    return first.type === "Q" ? { x: first.cx, y: first.cy } : { x: first.x, y: first.y };
  }

  // jsPDF's built-in fonts are WinAnsi (Windows-1252): Latin-1 plus a few
  // typographic extras. Anything else prints as garbage and letter-spaces the
  // rest of the run — "port1 ↔ port49" came out as "p o r t 1 !” ...". Arrows
  // become ASCII, anything else outside the set becomes "?". PDF only: the
  // Visio package is UTF-8 and keeps the real characters.
  var PDF_TEXT_MAP = { "↔": "<->", "⇄": "<->", "→": "->", "←": "<-", "⇒": "=>", "≤": "<=", "≥": ">=", "✓": "v", "✗": "x" };
  var WINANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
  function pdfText(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], code = s.charCodeAt(i);
      if (PDF_TEXT_MAP[ch]) out += PDF_TEXT_MAP[ch];
      else if (code < 0x100 || WINANSI_EXTRA.indexOf(ch) >= 0) out += ch;
      else if (code >= 0xd800 && code <= 0xdbff) { out += "?"; i++; }  // surrogate pair = one character
      else out += "?";
    }
    return out;
  }

  // Corner points of the polygonal node shapes Cytoscape offers that are not a
  // rectangle or ellipse, as fractions of the box (0..1, y down).
  var POLYGONS = {
    diamond: [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
    "round-diamond": [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]],
    triangle: [[0.5, 0], [1, 1], [0, 1]],
    "round-triangle": [[0.5, 0], [1, 1], [0, 1]],
    hexagon: [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
    "round-hexagon": [[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]],
    octagon: [[0.3, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0.3, 1], [0, 0.7], [0, 0.3]],
    "round-octagon": [[0.3, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0.3, 1], [0, 0.7], [0, 0.3]],
  };

  // Every drawn shape is one of three kinds for the writers.
  function shapeKind(cyShape) {
    if (cyShape === "ellipse") return "ellipse";
    if (POLYGONS[cyShape]) return "polygon";
    if (/round|cut|barrel/.test(cyShape || "")) return "round";
    return "rect";
  }

  // ─── Scene (live graph → neutral drawing model) ─────────────────────

  function ps(ele, name) {
    try { return ele.pstyle(name); } catch (e) { return null; }
  }
  function psNum(ele, name, dflt) {
    var p = ps(ele, name);
    if (!p) return dflt;
    var v = p.pfValue != null ? p.pfValue : p.value;
    v = Array.isArray(v) ? v[0] : v;
    var n = parseFloat(v);
    return isFinite(n) ? n : dflt;
  }
  function psStr(ele, name, dflt) {
    var p = ps(ele, name);
    if (!p) return dflt;
    var v = p.strValue != null ? p.strValue : p.value;
    return v == null ? dflt : String(v);
  }
  function psColor(ele, name) {
    var p = ps(ele, name);
    return p ? toHex(p.value) : null;
  }

  function labelOf(ele, isEdge) {
    var text = psStr(ele, "label", "");
    if (!text || text === "none") return null;
    // `lines` is what the Visio package writes (UTF-8); `pdfLines` what the
    // PDF's WinAnsi fonts can print.
    var lines = text.split("\n").filter(function (l) { return l.length; });
    if (!lines.length) return null;
    var weight = psStr(ele, "font-weight", "normal");
    var opacity = psNum(ele, "text-opacity", 1) * (ele.effectiveOpacity ? ele.effectiveOpacity() : 1);
    var bgOpacity = psNum(ele, "text-background-opacity", 0);
    return {
      lines: lines,
      pdfLines: lines.map(pdfText),
      fontPx: psNum(ele, "font-size", isEdge ? 9 : 12),
      mono: /mono|courier/i.test(psStr(ele, "font-family", "")),
      bold: weight === "bold" || parseInt(weight, 10) >= 600,
      italic: psStr(ele, "font-style", "normal") === "italic",
      color: mixWithWhite(psColor(ele, "color") || "#1a1a1a", Math.max(0.15, opacity)),
      bg: bgOpacity > 0 ? mixWithWhite(psColor(ele, "text-background-color") || "#ffffff", bgOpacity) : null,
      valign: psStr(ele, "text-valign", "center"),
      halign: psStr(ele, "text-halign", "center"),
      mx: psNum(ele, "text-margin-x", 0),
      my: psNum(ele, "text-margin-y", 0),
    };
  }

  // Reads the drawn graph into a scene. `lightSheet` (a stylesheet JSON array)
  // is applied for the read and the original restored afterwards — both in the
  // same task, so the screen never paints the swap.
  function sceneFromCy(cy, lightSheet) {
    var restore = null;
    if (lightSheet) {
      restore = cy.style().json();
      cy.style().fromJson(lightSheet).update();
    }
    try {
      return readScene(cy);
    } finally {
      if (restore) cy.style().fromJson(restore).update();
    }
  }

  function readScene(cy) {
    var scene = { under: [], parents: [], edges: [], nodes: [], minFontPx: Infinity, bbox: null, icons: [] };
    var seenIcon = {};
    function noteFont(lbl) { if (lbl && lbl.fontPx < scene.minFontPx) scene.minFontPx = lbl.fontPx; }

    cy.nodes().forEach(function (n) {
      if (!n.visible() || psStr(n, "display", "element") === "none") return;
      var op = n.effectiveOpacity ? n.effectiveOpacity() : 1;
      if (op <= 0.01) return;
      var bb = n.boundingBox({ includeLabels: false, includeOverlays: false });
      var bw = psNum(n, "border-width", 0);
      var cyShape = psStr(n, "shape", "ellipse");
      var fillA = psNum(n, "background-opacity", 1) * op;
      var bordA = psNum(n, "border-opacity", 1) * op;
      var label = labelOf(n, false);
      noteFont(label);
      var icon = null;
      var img = psStr(n, "background-image", "");
      if (img && img !== "none") {
        icon = { url: img.split(",")[0].trim(), opacity: psNum(n, "background-image-opacity", 1) * op };
        if (!seenIcon[icon.url]) { seenIcon[icon.url] = true; scene.icons.push(icon.url); }
      }
      var item = {
        shape: shapeKind(cyShape), polygon: POLYGONS[cyShape] || null,
        x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2,
        fill: fillA > 0.01 ? mixWithWhite(psColor(n, "background-color") || "#999999", fillA) : null,
        stroke: bw > 0 && bordA > 0.01 ? mixWithWhite(psColor(n, "border-color") || "#000000", bordA) : null,
        strokeWidth: bw, strokeStyle: psStr(n, "border-style", "solid"),
        icon: icon, label: label,
        z: psNum(n, "z-index", 0),
      };
      if (psStr(n, "z-compound-depth", "auto") === "bottom") scene.under.push(item);
      else if (n.isParent && n.isParent()) scene.parents.push(item);
      else scene.nodes.push(item);
    });

    cy.edges().forEach(function (e) {
      if (!e.visible() || psStr(e, "display", "element") === "none") return;
      var op = (e.effectiveOpacity ? e.effectiveOpacity() : 1) * psNum(e, "line-opacity", 1);
      if (op <= 0.01) return;
      var src = e.sourceEndpoint(), tgt = e.targetEndpoint();
      if (!src || !tgt || !isFinite(src.x) || !isFinite(tgt.x)) return;
      var cs = psStr(e, "curve-style", "bezier");
      var ctrl = null, segs = null;
      if (cs === "bezier" || cs === "unbundled-bezier") ctrl = e.controlPoints ? e.controlPoints() : null;
      else if (/segments|taxi/.test(cs)) segs = e.segmentPoints ? e.segmentPoints() : null;
      var path = edgePath(src, tgt, ctrl, segs);
      var color = mixWithWhite(psColor(e, "line-color") || "#999999", op);
      var label = labelOf(e, true);
      noteFont(label);
      var tShape = psStr(e, "target-arrow-shape", "none"), sShape = psStr(e, "source-arrow-shape", "none");
      var scale = psNum(e, "arrow-scale", 1);
      scene.edges.push({
        path: path,
        color: color,
        width: psNum(e, "width", 1.5),
        style: psStr(e, "line-style", "solid"),
        arrowTarget: tShape !== "none"
          ? { from: arrowFrom(path, true), to: tgt, color: mixWithWhite(psColor(e, "target-arrow-color") || color, op), scale: scale }
          : null,
        arrowSource: sShape !== "none"
          ? { from: arrowFrom(path, false), to: src, color: mixWithWhite(psColor(e, "source-arrow-color") || color, op), scale: scale }
          : null,
        label: label,
        mid: e.midpoint(),
        z: psNum(e, "z-index", 0),
      });
    });

    function byZ(a, b) { return a.z - b.z; }
    scene.under.sort(byZ); scene.parents.sort(byZ); scene.edges.sort(byZ); scene.nodes.sort(byZ);
    // Labels included, so a name above the top row or below the bottom one is
    // inside the printed area.
    var bb = cy.elements(":visible").boundingBox({ includeLabels: true, includeOverlays: false });
    scene.bbox = { x1: bb.x1, y1: bb.y1, x2: bb.x2, y2: bb.y2, w: bb.w, h: bb.h };
    if (!isFinite(scene.minFontPx)) scene.minFontPx = 9;
    return scene;
  }

  function allBoxes(scene) { return scene.under.concat(scene.parents, scene.nodes); }

  // Where a node label's text block sits, in model px: the centre x and the
  // top y of the block, given Cytoscape's valign/halign/margin semantics.
  function nodeLabelBlock(b, lbl, lineH) {
    var h = lbl.lines.length * lineH;
    var cx = (b.x1 + b.x2) / 2, cy = (b.y1 + b.y2) / 2;
    var top;
    if (lbl.valign === "top") top = b.y1 - h + lbl.my;
    else if (lbl.valign === "bottom") top = b.y2 + lbl.my;
    else top = cy - h / 2 + lbl.my;
    var align = "center", x = cx + lbl.mx;
    if (lbl.halign === "left") { align = "right"; x = b.x1 + lbl.mx; }
    else if (lbl.halign === "right") { align = "left"; x = b.x2 + lbl.mx; }
    return { x: x, top: top, h: h, align: align };
  }

  // Model-px extent of everything a scene draws, labels included, as rects.
  function sceneRects(scene) {
    var out = [];
    allBoxes(scene).forEach(function (b) {
      var r = { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 };
      if (b.label) {
        var blk = nodeLabelBlock(b, b.label, b.label.fontPx * 1.2);
        r.y1 = Math.min(r.y1, blk.top); r.y2 = Math.max(r.y2, blk.top + blk.h);
      }
      out.push(r);
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

  // ─── Icons (PDF only) ───────────────────────────────────────────────

  // url → { dataUrl, w, h } | null. Icons are same-origin; anything that will
  // not load or paint is simply left out of the export.
  function loadIcons(urls) {
    var out = {};
    return Promise.all(urls.map(function (url) {
      return new Promise(function (resolve) {
        var img = new Image();
        var done = function (v) { out[url] = v; resolve(); };
        img.onload = function () {
          try {
            var w = img.naturalWidth || 128, h = img.naturalHeight || 128;
            var k = 256 / Math.max(w, h);
            var c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            done({ dataUrl: c.toDataURL("image/png"), w: c.width, h: c.height });
          } catch (e) { done(null); }
        };
        img.onerror = function () { done(null); };
        setTimeout(function () { if (!(url in out)) done(null); }, 5000);
        img.src = url;
      });
    })).then(function () { return out; });
  }

  // ─── PDF writer ─────────────────────────────────────────────────────

  function appName() {
    return (typeof _branding !== "undefined" && _branding && _branding.appName) ? _branding.appName : "Polaris";
  }

  // Lays the key out across `width` pt; returns { lines: [[{item, x}]], height }.
  function layoutKey(doc, items, width, fontPt) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(fontPt);
    var SW = 16, GAP = 5, SEP = 12;
    var lines = [[]], x = 0;
    (items || []).forEach(function (it) {
      var w = SW + GAP + doc.getTextWidth(pdfText(it.text));
      if (x > 0 && x + w > width) { lines.push([]); x = 0; }
      lines[lines.length - 1].push({ item: it, x: x });
      x += w + SEP;
    });
    var lh = fontPt * 1.35;
    var n = (items || []).length ? lines.length : 0;
    return { lines: n ? lines : [], lineHeight: lh, height: n * lh, swatch: SW, gap: GAP };
  }

  function sheetSize(paperKey, orientation) {
    var p = PAPER[paperKey] || PAPER.letter;
    return orientation === "portrait" ? { w: p.w, h: p.h } : { w: p.h, h: p.w };
  }

  function newDoc(orientation, size) {
    return new window.jspdf.jsPDF({ orientation: orientation, unit: "pt", format: [Math.min(size.w, size.h), Math.max(size.w, size.h)] });
  }

  // Everything the writer and the dialog's summary need, for one
  // paper/orientation/minimum choice. `orientation: "auto"` tries both and
  // keeps the one with fewer sheets (landscape on a tie — graphs run wide).
  function layoutFor(ctx, scene, opts) {
    if (opts.orientation === "auto") {
      var land = layoutFor(ctx, scene, Object.assign({}, opts, { orientation: "landscape" }));
      var port = layoutFor(ctx, scene, Object.assign({}, opts, { orientation: "portrait" }));
      return port.sheets < land.sheets ? port : land;
    }
    var size = sheetSize(opts.paper, opts.orientation);
    var doc = newDoc(opts.orientation, size);
    var textPt = Math.max(8, opts.minPt);
    var contentW = size.w - 2 * MARGIN;
    var key = layoutKey(doc, ctx.keyItems, contentW, textPt);
    var meta = (ctx.metaLines || []).filter(Boolean).slice(0, 2);
    var titlePt = Math.max(13, opts.minPt + 4);
    var headerH = titlePt + 6 + textPt * 1.35 * Math.max(1, meta.length + 1) + 6;
    var footerH = textPt + 6;
    var contentTop = MARGIN + headerH;
    var contentH = size.h - contentTop - MARGIN - footerH - key.height - 8;
    var plan = planPages(scene.bbox.w, scene.bbox.h, scene.minFontPx, opts.minPt, contentW, contentH, OVERLAP, MAX_SCALE);
    var sections = plan.single ? [{ row: 0, col: 0 }] : occupiedSections(
      plan.rows, plan.cols, scene.bbox.x1 + plan.offsetX, scene.bbox.y1 + plan.offsetY,
      plan.stepX, plan.stepY, contentW / plan.scale, contentH / plan.scale, sceneRects(scene));
    return {
      orientation: opts.orientation, paper: opts.paper, minPt: opts.minPt, size: size,
      textPt: textPt, titlePt: titlePt, key: key, meta: meta, headerH: headerH,
      content: { x: MARGIN, y: contentTop, w: contentW, h: contentH },
      plan: plan, sections: sections,
      sheets: plan.single ? 1 : sections.length + 1,
    };
  }

  function dashFor(style, s, width) {
    var w = Math.max(0.5, width * s);
    if (style === "dashed") return [Math.max(3, 6 * s), Math.max(2, 4 * s)];
    if (style === "dotted") return [w, Math.max(1.5, 3 * s)];
    return [];
  }

  // Draws the scene into `area` (pt) with model point (ox, oy) at its
  // top-left and `s` pt per model px. withText=false is the overview.
  function drawScene(doc, scene, area, ox, oy, s, withText, icons) {
    function X(x) { return area.x + (x - ox) * s; }
    function Y(y) { return area.y + (y - oy) * s; }
    // Model-space window of this area, padded so a shape or curve leaving the
    // sheet is still drawn up to the clip edge.
    var pad = 60;
    var wx1 = ox - pad, wy1 = oy - pad, wx2 = ox + area.w / s + pad, wy2 = oy + area.h / s + pad;
    function boxVisible(b) {
      var top = b.y1 - (b.label ? b.label.fontPx * 3 : 0), bot = b.y2 + (b.label ? b.label.fontPx * 3 : 0);
      return b.x2 >= wx1 && b.x1 <= wx2 && bot >= wy1 && top <= wy2;
    }
    function edgeVisible(e) {
      var xs = [], ys = [];
      e.path.forEach(function (p) { xs.push(p.x); ys.push(p.y); if (p.type === "Q") { xs.push(p.cx); ys.push(p.cy); } });
      return Math.max.apply(null, xs) >= wx1 && Math.min.apply(null, xs) <= wx2 &&
             Math.max.apply(null, ys) >= wy1 && Math.min.apply(null, ys) <= wy2;
    }

    doc.saveGraphicsState();
    doc.rect(area.x, area.y, area.w, area.h, null);
    doc.clip();
    doc.discardPath();

    function drawBox(b) {
      var style = b.fill && b.stroke ? "FD" : b.fill ? "F" : b.stroke ? "S" : null;
      // A border draws OUTWARD in Cytoscape and the bounding box includes it;
      // the PDF stroke is centred on the path, so inset the path by half.
      var half = b.stroke ? b.strokeWidth / 2 : 0;
      var x1 = b.x1 + half, y1 = b.y1 + half, x2 = b.x2 - half, y2 = b.y2 - half;
      var w = Math.max(0.1, (x2 - x1) * s), h = Math.max(0.1, (y2 - y1) * s);
      if (style) {
        if (b.fill) doc.setFillColor(b.fill);
        if (b.stroke) {
          doc.setDrawColor(b.stroke);
          doc.setLineWidth(Math.max(0.4, b.strokeWidth * s));
          doc.setLineDashPattern(dashFor(b.strokeStyle, s, b.strokeWidth), 0);
        }
        if (b.shape === "ellipse") {
          doc.ellipse(X((x1 + x2) / 2), Y((y1 + y2) / 2), w / 2, h / 2, style);
        } else if (b.shape === "polygon") {
          var pts = b.polygon.map(function (p) { return [X(x1) + p[0] * w, Y(y1) + p[1] * h]; });
          var rel = [];
          for (var i = 1; i < pts.length; i++) rel.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
          doc.lines(rel, pts[0][0], pts[0][1], [1, 1], style, true);
        } else if (b.shape === "round") {
          var r = Math.min(8 * s, w / 4, h / 4);
          doc.roundedRect(X(x1), Y(y1), w, h, r, r, style);
        } else {
          doc.rect(X(x1), Y(y1), w, h, style);
        }
        doc.setLineDashPattern([], 0);
      }
      if (b.icon && icons && icons[b.icon.url]) {
        // Inside the border, fitted ("contain") and centred, as Cytoscape draws it.
        var ic = icons[b.icon.url];
        var bw = b.strokeWidth || 0;
        var iw = (b.x2 - b.x1 - 2 * bw) * s, ih = (b.y2 - b.y1 - 2 * bw) * s;
        if (b.shape === "ellipse") { iw *= 0.92; ih *= 0.92; }
        var k = Math.min(iw / ic.w, ih / ic.h);
        var dw = ic.w * k, dh = ic.h * k;
        var cx = X((b.x1 + b.x2) / 2), cy = Y((b.y1 + b.y2) / 2);
        var gs = b.icon.opacity < 0.99 && doc.GState ? true : false;
        if (gs) { doc.saveGraphicsState(); doc.setGState(new doc.GState({ opacity: b.icon.opacity })); }
        try { doc.addImage(ic.dataUrl, "PNG", cx - dw / 2, cy - dh / 2, dw, dh, b.icon.url); } catch (e) { /* skip */ }
        if (gs) doc.restoreGraphicsState();
      }
    }

    function setFont(lbl, pt) {
      var style = lbl.bold && lbl.italic ? "bolditalic" : lbl.bold ? "bold" : lbl.italic ? "italic" : "normal";
      doc.setFont(lbl.mono ? "courier" : "helvetica", style);
      doc.setFontSize(pt);
    }

    function drawBoxLabel(b) {
      var lbl = b.label;
      if (!lbl) return;
      var pt = lbl.fontPx * s, lh = lbl.fontPx * 1.15;
      var blk = nodeLabelBlock(b, lbl, lh);
      setFont(lbl, pt);
      if (lbl.bg) {
        var tw = Math.max.apply(null, lbl.pdfLines.map(function (l) { return doc.getTextWidth(l); }));
        var bx = blk.align === "center" ? X(blk.x) - tw / 2 : blk.align === "right" ? X(blk.x) - tw : X(blk.x);
        doc.setFillColor(lbl.bg);
        doc.rect(bx - 1.5, Y(blk.top), tw + 3, blk.h * s, "F");
      }
      doc.setTextColor(lbl.color);
      lbl.pdfLines.forEach(function (line, i) {
        doc.text(line, X(blk.x), Y(blk.top + i * lh) + pt * 0.82, { align: blk.align });
      });
    }

    function arrow(a, width) {
      var dx = a.to.x - a.from.x, dy = a.to.y - a.from.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      var ux = dx / len, uy = dy / len;
      var L = Math.max(6, width * 3.6) * (a.scale || 1) * s, W = L * 0.55;
      var tx = X(a.to.x), ty = Y(a.to.y);
      var bx = tx - ux * L, by = ty - uy * L;
      doc.setFillColor(a.color);
      doc.triangle(tx, ty, bx - uy * W, by + ux * W, bx + uy * W, by - ux * W, "F");
    }

    function drawEdge(e) {
      doc.setDrawColor(e.color);
      doc.setLineWidth(Math.max(0.5, e.width * s));
      doc.setLineDashPattern(dashFor(e.style, s, e.width), 0);
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
      if (e.arrowTarget) arrow(e.arrowTarget, e.width);
      if (e.arrowSource) arrow(e.arrowSource, e.width);
    }

    function drawEdgeLabel(e) {
      var lbl = e.label;
      if (!lbl) return;
      var pt = lbl.fontPx * s;
      setFont(lbl, pt);
      var lh = pt * 1.15, padX = 2 * s + 0.5;
      var w = Math.max.apply(null, lbl.pdfLines.map(function (l) { return doc.getTextWidth(l); })) + 2 * padX;
      var h = lbl.lines.length * lh + padX;
      var cx = X(e.mid.x + lbl.mx), cy = Y(e.mid.y + lbl.my);
      // Horizontal on paper even where the screen autorotates: a printed label
      // is read without turning the sheet.
      doc.setFillColor(lbl.bg || "#ffffff");
      doc.rect(cx - w / 2, cy - h / 2, w, h, "F");
      doc.setTextColor(lbl.color);
      var y0 = cy - h / 2 + padX / 2 + pt * 0.85;
      lbl.pdfLines.forEach(function (line, i) { doc.text(line, cx, y0 + i * lh, { align: "center" }); });
    }

    // Paint order matches the canvas, where each element's label is drawn
    // with the element: hulls under everything, compound parents, edges with
    // their labels, then nodes with theirs. So an edge label that runs behind
    // a node is hidden by it on paper exactly as on screen, and no node label
    // is ever crossed by a line.
    var under = scene.under.filter(boxVisible), parents = scene.parents.filter(boxVisible);
    var edges = scene.edges.filter(edgeVisible), nodes = scene.nodes.filter(boxVisible);
    under.forEach(drawBox);
    if (withText) under.forEach(drawBoxLabel);
    parents.forEach(drawBox);
    if (withText) parents.forEach(drawBoxLabel);
    edges.forEach(drawEdge);
    if (withText) edges.forEach(drawEdgeLabel);
    nodes.forEach(drawBox);
    if (withText) nodes.forEach(drawBoxLabel);
    doc.restoreGraphicsState();
  }

  function drawKey(doc, L) {
    var key = L.key;
    if (!key.lines.length) return;
    var y = L.size.h - MARGIN - (L.textPt + 6) - key.height;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.textPt);
    key.lines.forEach(function (line, li) {
      var ly = y + li * key.lineHeight + key.lineHeight * 0.7;
      line.forEach(function (cell) {
        var x = MARGIN + cell.x, it = cell.item, mid = ly - L.textPt * 0.3;
        if (it.kind === "box" || it.kind === "dot") {
          doc.setFillColor(it.fill || it.color);
          doc.setDrawColor(it.color);
          doc.setLineWidth(1);
          doc.setLineDashPattern(it.dashed ? [2, 1.5] : [], 0);
          if (it.kind === "dot") doc.circle(x + key.swatch / 2, mid, L.textPt * 0.42, "FD");
          else doc.roundedRect(x + 2, mid - L.textPt * 0.4, key.swatch - 4, L.textPt * 0.8, 1.5, 1.5, it.fill ? "FD" : "S");
        } else {
          doc.setDrawColor(it.color);
          doc.setLineWidth(it.heavy ? 2.6 : 1.8);
          doc.setLineDashPattern(it.dashed ? [3, 2] : [], 0);
          doc.line(x, mid, x + key.swatch, mid);
        }
        doc.setLineDashPattern([], 0);
        doc.setTextColor("#333333");
        doc.text(pdfText(it.text), x + key.swatch + key.gap, ly);
      });
    });
  }

  // One line, WinAnsi-safe and ellipsised to `width` — the header never wraps
  // into the graph. Every header / footer string goes through here.
  function fitLine(doc, text, width) {
    text = pdfText(text);
    if (doc.getTextWidth(text) <= width) return text;
    var t = text;
    while (t.length > 1 && doc.getTextWidth(t + "…") > width) t = t.slice(0, -1);
    return t + "…";
  }

  function drawChrome(doc, L, ctx, pageLabel, pageNo, pageCount, timestamp) {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(L.titlePt);
    doc.setTextColor("#282828");
    doc.text(fitLine(doc, appName() + " — " + ctx.title, L.content.w), MARGIN, MARGIN + L.titlePt * 0.8);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.textPt);
    doc.setTextColor("#787878");
    var y = MARGIN + L.titlePt + 6 + L.textPt * 0.8;
    var lines = ["Generated: " + timestamp].concat(L.meta);
    lines.forEach(function (t, i) { doc.text(fitLine(doc, t, L.content.w), MARGIN, y + i * L.textPt * 1.35); });
    drawKey(doc, L);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(L.textPt);
    doc.setTextColor("#969696");
    doc.text(fitLine(doc, "Page " + pageNo + " of " + pageCount + (pageLabel ? "  |  " + pageLabel : "") + "  |  " + appName() + " " + ctx.title, L.content.w),
      L.size.w / 2, L.size.h - MARGIN + 4, { align: "center" });
  }

  function writePdf(ctx, scene, L, icons) {
    var size = L.size;
    var doc = newDoc(L.orientation, size);
    var now = new Date();
    var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();
    var plan = L.plan, area = L.content, bb = scene.bbox;
    var pageNo = 1;

    if (plan.single) {
      drawScene(doc, scene, area, bb.x1 + plan.offsetX, bb.y1 + plan.offsetY, plan.scale, true, icons);
      drawChrome(doc, L, ctx, "", 1, 1, timestamp);
    } else {
      // Overview: the whole graph fitted to the sheet with the section grid on
      // top. No graph text — at this scale it would print below the minimum.
      var sFit = Math.min(area.w / bb.w, area.h / bb.h);
      var oox = bb.x1 - (area.w / sFit - bb.w) / 2, ooy = bb.y1 - (area.h / sFit - bb.h) / 2;
      drawScene(doc, scene, area, oox, ooy, sFit, false, icons);
      var gridPt = Math.max(10, L.minPt + 2);
      doc.setFont("helvetica", "bold");
      doc.setFontSize(gridPt);
      // Where section (r, c) starts, in model px — one helper, so the grid on
      // the overview and the section pages themselves cannot disagree.
      var secX = function (c) { return bb.x1 + plan.offsetX + c * plan.stepX; };
      var secY = function (r) { return bb.y1 + plan.offsetY + r * plan.stepY; };
      var secW = area.w / plan.scale, secH = area.h / plan.scale;
      // Only printed sections get a cell, clipped to the drawing so the outer
      // cells do not run off into empty paper.
      L.sections.forEach(function (sec) {
        var mx1 = Math.max(bb.x1, secX(sec.col)), mx2 = Math.min(bb.x2, secX(sec.col) + secW);
        var my1 = Math.max(bb.y1, secY(sec.row)), my2 = Math.min(bb.y2, secY(sec.row) + secH);
        var gx = area.x + (mx1 - oox) * sFit, gy = area.y + (my1 - ooy) * sFit;
        doc.setDrawColor("#0288d1");
        doc.setLineWidth(0.8);
        doc.setLineDashPattern([4, 3], 0);
        doc.rect(gx, gy, (mx2 - mx1) * sFit, (my2 - my1) * sFit, "S");
        doc.setLineDashPattern([], 0);
        doc.setTextColor("#0288d1");
        doc.text(sectionName(sec.row, sec.col), gx + 4, gy + gridPt);
      });
      var total = L.sections.length + 1;
      drawChrome(doc, L, ctx, "Overview — the labels are on the section pages that follow", pageNo, total, timestamp);
      L.sections.forEach(function (sec) {
        doc.addPage([Math.min(size.w, size.h), Math.max(size.w, size.h)], L.orientation);
        pageNo++;
        drawScene(doc, scene, area, secX(sec.col), secY(sec.row), plan.scale, true, icons);
        drawChrome(doc, L, ctx,
          "Section " + sectionName(sec.row, sec.col) + " (row " + rowName(sec.row) + " of " + rowName(plan.rows - 1) +
            ", column " + (sec.col + 1) + " of " + plan.cols + ")",
          pageNo, total, timestamp);
      });
    }
    doc.save(ctx.fileBase + "-" + now.toISOString().slice(0, 10) + ".pdf");
  }

  // ─── Visio (.vsdx) writer ───────────────────────────────────────────

  var PT_IN = 1 / 72;       // inches per model px (1 px = 1 pt)
  var VSDX_MARGIN_IN = 0.5;

  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function utf8(s) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s);
    var bin = unescape(encodeURIComponent(s)), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  // PURE (exposed for tests): [{name, data: string|Uint8Array}] → a zip with
  // every entry STORED (no compression — XML this size needs none, and a
  // stored zip is a few dozen lines with nothing to get subtly wrong).
  function zipStore(files, date) {
    var d = date || new Date();
    var dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    var dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    var parts = [], central = [], offset = 0;
    function u16(v) { return [v & 255, (v >>> 8) & 255]; }
    function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function (f) {
      var name = utf8(f.name);
      var data = typeof f.data === "string" ? utf8(f.data) : f.data;
      var crc = crc32(data);
      var common = [].concat(u16(20), u16(0x0800), u16(0), u16(dosTime), u16(dosDate), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0));
      var local = new Uint8Array([].concat(u32(0x04034b50), common));
      parts.push(local, name, data);
      central.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(offset))), name);
      offset += local.length + name.length + data.length;
    });
    var cdSize = central.reduce(function (n, p) { return n + p.length; }, 0);
    var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)));
    var all = parts.concat(central, [end]);
    var total = all.reduce(function (n, p) { return n + p.length; }, 0);
    var out = new Uint8Array(total), at = 0;
    all.forEach(function (p) { out.set(p, at); at += p.length; });
    return out;
  }

  function xmlEsc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }

  function num(v) { return (Math.round(v * 1e6) / 1e6).toString(); }

  function cell(n, v, u) { return '<Cell N="' + n + '" V="' + v + '"' + (u ? ' U="' + u + '"' : "") + "/>"; }

  // Quadratic sampled to a polyline (Visio's NURBSTo is not worth the risk).
  function sampleQuad(p0, q, p2, n) {
    var pts = [];
    for (var i = 1; i <= n; i++) {
      var t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      pts.push({ x: a * p0.x + b * q.x + c * p2.x, y: a * p0.y + b * q.y + c * p2.y });
    }
    return pts;
  }

  function visioPattern(style) { return style === "dashed" ? 2 : style === "dotted" ? 3 : 1; }

  // PURE (exposed for tests): scene → the page XML plus its size in inches.
  function vsdxPageXml(scene) {
    var bb = scene.bbox;
    var pageW = bb.w * PT_IN + 2 * VSDX_MARGIN_IN, pageH = bb.h * PT_IN + 2 * VSDX_MARGIN_IN;
    // Visio's y axis points up from the bottom of the page.
    function PX(x) { return VSDX_MARGIN_IN + (x - bb.x1) * PT_IN; }
    function PY(y) { return pageH - VSDX_MARGIN_IN - (y - bb.y1) * PT_IN; }
    var id = 0, shapes = [];

    // Visio centres a paragraph by default (the No Style sheet). A label with
    // textAlign "left" — the header and key text withHeaderAndKey adds, whose
    // boxes are sized from an estimate of the text — starts at its box's left
    // edge instead, so it sits against its swatch whatever the real width.
    function charSection(lbl) {
      return '<Section N="Character"><Row IX="0">' + cell("Size", num(lbl.fontPx * PT_IN), "PT") +
        cell("Color", lbl.color || "#1a1a1a") + cell("Style", (lbl.bold ? 1 : 0) | (lbl.italic ? 2 : 0)) + "</Row></Section>" +
        (lbl.textAlign === "left" ? '<Section N="Paragraph"><Row IX="0">' + cell("HorzAlign", 0) + "</Row></Section>" : "");
    }

    function geomRows(pts, x0, y0) {
      return pts.map(function (q, k) {
        return '<Row T="' + (k === 0 ? "MoveTo" : "LineTo") + '" IX="' + (k + 1) + '">' +
          cell("X", num(PX(q.x) - x0)) + cell("Y", num(PY(q.y) - y0)) + "</Row>";
      }).join("");
    }

    function box(b) {
      var x1 = PX(b.x1), x2 = PX(b.x2), yTop = PY(b.y1), yBot = PY(b.y2);
      var w = Math.max(0.01, x2 - x1), h = Math.max(0.01, yTop - yBot);
      var lbl = b.label, txt = "";
      if (lbl) {
        // Text block where Cytoscape puts the label, in shape-local inches.
        var lh = lbl.fontPx * 1.2;
        var blk = nodeLabelBlock(b, lbl, lh);
        var tw = Math.max(w, Math.max.apply(null, lbl.lines.map(function (l) { return l.length; })) * lbl.fontPx * 0.62 * PT_IN + 0.1);
        var th = blk.h * PT_IN;
        var tcx = lbl.textAlign === "left" ? tw / 2
          : PX(blk.align === "center" ? blk.x : blk.align === "right" ? blk.x - (tw / PT_IN) / 2 : blk.x + (tw / PT_IN) / 2) - x1;
        var tcy = PY(blk.top + blk.h / 2) - yBot;
        txt = cell("TxtPinX", num(tcx)) + cell("TxtPinY", num(tcy)) + cell("TxtWidth", num(tw)) + cell("TxtHeight", num(th)) +
          cell("TxtLocPinX", num(tw / 2)) + cell("TxtLocPinY", num(th / 2)) +
          (lbl.bg ? cell("TextBkgnd", lbl.bg) : "");
      }
      var noFill = b.fill ? 0 : 1, noLine = b.stroke ? 0 : 1;
      var geom;
      if (b.shape === "ellipse") {
        geom = '<Section N="Geometry" IX="0">' + cell("NoFill", noFill) + cell("NoLine", noLine) +
          '<Row T="Ellipse" IX="1">' + cell("X", num(w / 2)) + cell("Y", num(h / 2)) + cell("A", num(w)) + cell("B", num(h / 2)) +
          cell("C", num(w / 2)) + cell("D", num(h)) + "</Row></Section>";
      } else {
        var poly = b.shape === "polygon" ? b.polygon : [[0, 0], [1, 0], [1, 1], [0, 1]];
        var pts = poly.concat([poly[0]]);
        geom = '<Section N="Geometry" IX="0">' + cell("NoFill", noFill) + cell("NoLine", noLine) +
          pts.map(function (p, k) {
            return '<Row T="' + (k === 0 ? "MoveTo" : "LineTo") + '" IX="' + (k + 1) + '">' +
              cell("X", num(p[0] * w)) + cell("Y", num((1 - p[1]) * h)) + "</Row>";
          }).join("") + "</Section>";
      }
      id++;
      shapes.push('<Shape ID="' + id + '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
        cell("PinX", num(x1 + w / 2)) + cell("PinY", num(yBot + h / 2)) + cell("Width", num(w)) + cell("Height", num(h)) +
        cell("LocPinX", num(w / 2)) + cell("LocPinY", num(h / 2)) +
        cell("LineWeight", num(Math.max(0.5, b.strokeWidth || 0) * PT_IN)) + cell("LineColor", b.stroke || "#000000") +
        cell("LinePattern", b.stroke ? visioPattern(b.strokeStyle) : 0) +
        cell("FillForegnd", b.fill || "#FFFFFF") + cell("FillPattern", b.fill ? 1 : 0) +
        (b.shape === "round" ? cell("Rounding", num(Math.min(8 * PT_IN, w / 4, h / 4))) : "") +
        txt + (lbl ? charSection(lbl) : "") + geom +
        (lbl ? "<Text>" + xmlEsc(lbl.lines.join("\n")) + "</Text>" : "") +
        "</Shape>");
    }

    function arrowPts(a, width) {
      var dx = a.to.x - a.from.x, dy = a.to.y - a.from.y;
      var len = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / len, uy = dy / len;
      var L = Math.max(6, width * 3.6) * (a.scale || 1), W = L * 0.55;
      var base = { x: a.to.x - ux * L, y: a.to.y - uy * L };
      return [a.to, { x: base.x - uy * W, y: base.y + ux * W }, { x: base.x + uy * W, y: base.y - ux * W }, a.to];
    }

    function edge(e) {
      // Model-space polyline of the drawn route.
      var pts = [{ x: e.path[0].x, y: e.path[0].y }], cur = pts[0];
      for (var i = 1; i < e.path.length; i++) {
        var p = e.path[i];
        if (p.type === "Q") pts = pts.concat(sampleQuad(cur, { x: p.cx, y: p.cy }, p, 12));
        else pts.push({ x: p.x, y: p.y });
        cur = { x: p.x, y: p.y };
      }
      var heads = [];
      if (e.arrowTarget) heads.push(arrowPts(e.arrowTarget, e.width));
      if (e.arrowSource) heads.push(arrowPts(e.arrowSource, e.width));
      var all = pts.concat.apply(pts, heads).concat([{ x: e.mid.x, y: e.mid.y }]);
      var minX = Math.min.apply(null, all.map(function (q) { return q.x; }));
      var maxX = Math.max.apply(null, all.map(function (q) { return q.x; }));
      var minY = Math.min.apply(null, all.map(function (q) { return q.y; }));
      var maxY = Math.max.apply(null, all.map(function (q) { return q.y; }));
      var x0 = PX(minX), y0 = PY(maxY);                     // local origin = lower-left
      var w = Math.max(0.01, (maxX - minX) * PT_IN), h = Math.max(0.01, (maxY - minY) * PT_IN);
      var lbl = e.label, txt = "";
      if (lbl) {
        var th = lbl.lines.length * lbl.fontPx * 1.25 * PT_IN;
        var tw = Math.max.apply(null, lbl.lines.map(function (l) { return l.length; })) * lbl.fontPx * 0.62 * PT_IN + 4 * PT_IN;
        txt = cell("TxtPinX", num(PX(e.mid.x + lbl.mx) - x0)) + cell("TxtPinY", num(PY(e.mid.y + lbl.my) - y0)) +
          cell("TxtWidth", num(tw)) + cell("TxtHeight", num(th)) +
          cell("TxtLocPinX", num(tw / 2)) + cell("TxtLocPinY", num(th / 2)) + cell("TextBkgnd", lbl.bg || "#FFFFFF");
      }
      var arrowColor = (e.arrowTarget || e.arrowSource || {}).color || e.color;
      id++;
      shapes.push('<Shape ID="' + id + '" Type="Shape" LineStyle="0" FillStyle="0" TextStyle="0">' +
        cell("PinX", num(x0 + w / 2)) + cell("PinY", num(y0 + h / 2)) + cell("Width", num(w)) + cell("Height", num(h)) +
        cell("LocPinX", num(w / 2)) + cell("LocPinY", num(h / 2)) +
        cell("LineWeight", num(e.width * PT_IN)) + cell("LineColor", e.color) + cell("LinePattern", visioPattern(e.style)) +
        cell("FillForegnd", arrowColor) + cell("FillPattern", 1) +
        txt + (lbl ? charSection(lbl) : "") +
        '<Section N="Geometry" IX="0">' + cell("NoFill", 1) + cell("NoLine", 0) + geomRows(pts, x0, y0) + "</Section>" +
        heads.map(function (tri, k) {
          return '<Section N="Geometry" IX="' + (k + 1) + '">' + cell("NoFill", 0) + cell("NoLine", 1) + geomRows(tri, x0, y0) + "</Section>";
        }).join("") +
        (lbl ? "<Text>" + xmlEsc(lbl.lines.join("\n")) + "</Text>" : "") +
        "</Shape>");
    }

    // Z-order as on screen.
    scene.under.forEach(box);
    scene.parents.forEach(box);
    scene.edges.forEach(edge);
    scene.nodes.forEach(box);
    var xml = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n' +
      '<PageContents xmlns="http://schemas.microsoft.com/office/visio/2012/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xml:space="preserve">' +
      "<Shapes>" + shapes.join("") + "</Shapes></PageContents>";
    return { xml: xml, pageW: pageW, pageH: pageH, shapeCount: id };
  }

  // The document part. Visio for the web refuses a package ("the file format
  // is invalid or has become corrupted") that desktop Visio would only repair,
  // so this mirrors a skeleton known to open there: a font table, a "No Style"
  // stylesheet that sets every line / fill / text cell and section a shape can
  // inherit, and a DocumentSheet.
  function vsdxDocumentXml(NS) {
    function row(cells) { return '<Row IX="0">' + cells + "</Row>"; }
    var noStyle =
      cell("EnableLineProps", 1) + cell("EnableFillProps", 1) + cell("EnableTextProps", 1) + cell("HideForApply", 0) +
      cell("LineWeight", num(PT_IN)) + cell("LineColor", "#000000") + cell("LinePattern", 1) + cell("Rounding", 0) +
      cell("EndArrowSize", 2) + cell("BeginArrow", 0) + cell("EndArrow", 0) + cell("LineCap", 0) + cell("BeginArrowSize", 2) +
      cell("LineColorTrans", 0) + cell("CompoundType", 0) +
      cell("FillForegnd", "#FFFFFF") + cell("FillBkgnd", "#FFFFFF") + cell("FillPattern", 1) +
      cell("ShdwForegnd", "#000000") + cell("ShdwPattern", 0) + cell("FillForegndTrans", 0) + cell("FillBkgndTrans", 0) +
      cell("ShdwForegndTrans", 0) + cell("ShapeShdwType", 0) + cell("ShapeShdwOffsetX", 0) + cell("ShapeShdwOffsetY", 0) +
      cell("ShapeShdwObliqueAngle", 0) + cell("ShapeShdwScaleFactor", 1) + cell("ShapeShdwBlur", 0) + cell("ShapeShdwShow", 0) +
      cell("LeftMargin", 0) + cell("RightMargin", 0) + cell("TopMargin", 0) + cell("BottomMargin", 0) +
      cell("VerticalAlign", 1) + cell("TextBkgnd", 0) + cell("DefaultTabStop", 0.5) + cell("TextDirection", 0) + cell("TextBkgndTrans", 0) +
      '<Section N="Character">' + row(cell("Font", "Calibri") + cell("Color", "#000000") + cell("Style", 0) + cell("Case", 0) +
        cell("Pos", 0) + cell("FontScale", 1) + cell("Size", num(10 * PT_IN), "PT") + cell("DblUnderline", 0) + cell("Overline", 0) +
        cell("Strikethru", 0) + cell("DoubleStrikethrough", 0) + cell("Letterspace", 0) + cell("ColorTrans", 0) +
        cell("AsianFont", 0) + cell("ComplexScriptFont", 0) + cell("ComplexScriptSize", -1) + cell("LangID", "en-US")) + "</Section>" +
      '<Section N="Paragraph">' + row(cell("IndFirst", 0) + cell("IndLeft", 0) + cell("IndRight", 0) + cell("SpLine", -1.2) +
        cell("SpBefore", 0) + cell("SpAfter", 0) + cell("HorzAlign", 1) + cell("Bullet", 0) + cell("BulletStr", "") +
        cell("BulletFont", 0) + cell("BulletFontSize", -1) + cell("TextPosAfterBullet", 0) + cell("Flags", 0)) + "</Section>" +
      '<Section N="Tabs"><Row IX="0"/></Section>';
    return "<VisioDocument " + NS + ">" +
      '<DocumentSettings TopPage="0" DefaultTextStyle="0" DefaultLineStyle="0" DefaultFillStyle="0" DefaultGuideStyle="0">' +
      "<GlueSettings>9</GlueSettings><SnapSettings>65847</SnapSettings><SnapExtensions>34</SnapExtensions><SnapAngles/>" +
      "<DynamicGridEnabled>1</DynamicGridEnabled><ProtectStyles>0</ProtectStyles><ProtectShapes>0</ProtectShapes>" +
      "<ProtectMasters>0</ProtectMasters><ProtectBkgnds>0</ProtectBkgnds></DocumentSettings>" +
      '<FaceNames><FaceName NameU="Calibri" UnicodeRanges="-536859905 -1073732485 9 0" CharSets="536871423 0" Panose="2 15 5 2 2 2 4 3 2 4" Flags="325"/></FaceNames>' +
      '<StyleSheets><StyleSheet ID="0" NameU="No Style" IsCustomNameU="1" Name="No Style" IsCustomName="1">' + noStyle + "</StyleSheet></StyleSheets>" +
      '<DocumentSheet NameU="TheDoc" IsCustomNameU="1" Name="TheDoc" IsCustomName="1" LineStyle="0" FillStyle="0" TextStyle="0">' +
      cell("OutputFormat", 0) + cell("LockPreview", 0) + cell("AddMarkup", 0) + cell("ViewMarkup", 0) +
      cell("PreviewQuality", 0) + cell("PreviewScope", 0) + cell("DocLangID", "en-US") + "</DocumentSheet>" +
      "</VisioDocument>";
  }

  // PURE (exposed for tests): every part of the .vsdx package.
  function vsdxParts(scene, title, pageName) {
    var page = vsdxPageXml(scene);
    var NS = 'xmlns="http://schemas.microsoft.com/office/visio/2012/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xml:space="preserve"';
    var head = '<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n';
    var REL = "http://schemas.openxmlformats.org/package/2006/relationships";
    var pn = xmlEsc(pageName || "Page-1");
    return [
      { name: "[Content_Types].xml", data: head +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/visio/document.xml" ContentType="application/vnd.ms-visio.drawing.main+xml"/>' +
        '<Override PartName="/visio/pages/pages.xml" ContentType="application/vnd.ms-visio.pages+xml"/>' +
        '<Override PartName="/visio/pages/page1.xml" ContentType="application/vnd.ms-visio.page+xml"/>' +
        '<Override PartName="/visio/windows.xml" ContentType="application/vnd.ms-visio.windows+xml"/>' +
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
        "</Types>" },
      { name: "_rels/.rels", data: head + '<Relationships xmlns="' + REL + '">' +
        '<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/document" Target="visio/document.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
        "</Relationships>" },
      { name: "docProps/core.xml", data: head +
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
        'xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
        "<dc:title>" + xmlEsc(title) + "</dc:title><dc:creator>" + xmlEsc(appName()) + "</dc:creator>" +
        '<dcterms:created xsi:type="dcterms:W3CDTF">' + new Date().toISOString().replace(/\.\d+Z$/, "Z") + "</dcterms:created>" +
        "</cp:coreProperties>" },
      { name: "docProps/app.xml", data: head +
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">' +
        "<Application>Microsoft Visio</Application><AppVersion>15.0000</AppVersion></Properties>" },
      { name: "visio/document.xml", data: head + vsdxDocumentXml(NS) },
      { name: "visio/_rels/document.xml.rels", data: head + '<Relationships xmlns="' + REL + '">' +
        '<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/pages" Target="pages/pages.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.microsoft.com/visio/2010/relationships/windows" Target="windows.xml"/>' +
        "</Relationships>" },
      { name: "visio/windows.xml", data: head + '<Windows ClientWidth="0" ClientHeight="0" ' + NS + "/>" },
      { name: "visio/pages/pages.xml", data: head + "<Pages " + NS + ">" +
        '<Page ID="0" NameU="' + pn + '" Name="' + pn + '"><PageSheet>' +
        cell("PageWidth", num(page.pageW)) + cell("PageHeight", num(page.pageH)) +
        cell("PageScale", 1) + cell("DrawingScale", 1) + cell("DrawingSizeType", 0) + cell("DrawingScaleType", 0) +
        '</PageSheet><Rel r:id="rId1"/></Page></Pages>' },
      { name: "visio/pages/_rels/pages.xml.rels", data: head + '<Relationships xmlns="' + REL + '">' +
        '<Relationship Id="rId1" Type="http://schemas.microsoft.com/visio/2010/relationships/page" Target="page1.xml"/>' +
        "</Relationships>" },
      { name: "visio/pages/page1.xml", data: page.xml },
    ];
  }

  function download(bytes, mime, filename) {
    var blob = new Blob([bytes], { type: mime });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
  }

  // ─── Entry points ───────────────────────────────────────────────────

  function optsKey() {
    var u = (typeof currentUsername !== "undefined" && currentUsername) ? currentUsername : "";
    return u ? "polaris-prefs-graph-export-" + u : "";
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

  function summaryText(L, scene, noun) {
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
      text += " That is a lot of paper — narrowing the " + noun + " first prints only what you need.";
    }
    return text;
  }

  // ctx: { cy, lightStylesheet | scene, title, fileBase, noun, metaLines,
  //        keyItems, scopeNote } — see the header comment.
  function checkCtx(ctx) {
    var empty = !ctx || (ctx.scene ? !ctx.scene.nodes.length : !ctx.cy || ctx.cy.nodes(":visible").length === 0);
    if (empty) {
      showToast("Nothing to export", "error");
      return false;
    }
    return true;
  }

  // A page that draws its own graph hands the scene over already built.
  function sceneOf(ctx) { return ctx.scene || sceneFromCy(ctx.cy, ctx.lightStylesheet); }

  function openPdfDialog(ctx) {
    if (!checkCtx(ctx)) return;
    if (!window.jspdf || !window.jspdf.jsPDF) {
      showToast("PDF library not loaded. Reload the page and try again.", "error");
      return;
    }
    var scene = sceneOf(ctx);
    var o = readOpts();
    function options(list, cur) {
      return list.map(function (v) {
        return '<option value="' + esc(v.value) + '"' + (String(v.value) === String(cur) ? " selected" : "") + ">" + esc(v.label) + "</option>";
      }).join("");
    }
    var body =
      '<div class="form-group"><label for="graph-export-paper">Paper size</label>' +
        '<select id="graph-export-paper">' + options(Object.keys(PAPER).map(function (k) { return { value: k, label: PAPER[k].label }; }), o.paper) + "</select></div>" +
      '<div class="form-group"><label for="graph-export-orientation">Orientation</label>' +
        '<select id="graph-export-orientation">' + options([
          { value: "auto", label: "Automatic (fewest pages)" },
          { value: "landscape", label: "Landscape" },
          { value: "portrait", label: "Portrait" },
        ], o.orientation) + "</select></div>" +
      '<div class="form-group"><label for="graph-export-minpt">Minimum text size</label>' +
        '<select id="graph-export-minpt">' + options(MIN_PT_CHOICES.map(function (v) {
          return { value: v, label: v + " pt" + (v === MIN_PRINT_PT ? " (smallest readable)" : "") };
        }), o.minPt) + "</select>" +
        '<div class="hint">Nothing on the printed ' + esc(ctx.noun) + " is smaller than this. One that cannot fit a sheet at this size is split across several.</div></div>" +
      '<div class="graph-export-summary" id="graph-export-summary" role="status"></div>' +
      (ctx.scopeNote ? '<div class="form-group"><div class="hint">' + esc(ctx.scopeNote) + "</div></div>" : "");
    var footer =
      '<button type="button" class="btn btn-secondary" id="graph-export-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-primary" id="graph-export-go">Export PDF</button>';
    openModal("Export " + ctx.title + " as PDF", body, footer);

    var current = null;
    function read() {
      return {
        paper: document.getElementById("graph-export-paper").value,
        orientation: document.getElementById("graph-export-orientation").value,
        minPt: Number(document.getElementById("graph-export-minpt").value),
      };
    }
    function refresh() {
      current = layoutFor(ctx, scene, read());
      document.getElementById("graph-export-summary").textContent = summaryText(current, scene, ctx.noun);
    }
    ["graph-export-paper", "graph-export-orientation", "graph-export-minpt"].forEach(function (id) {
      document.getElementById(id).addEventListener("change", refresh);
    });
    document.getElementById("graph-export-cancel").addEventListener("click", closeModal);
    var go = document.getElementById("graph-export-go");
    go.addEventListener("click", function () {
      var picked = read();
      saveOpts(picked);
      go.disabled = true;
      go.textContent = "Exporting…";
      loadIcons(scene.icons).then(function (icons) {
        writePdf(ctx, scene, current || layoutFor(ctx, scene, picked), icons);
        closeModal();
        showToast(ctx.title + " exported as PDF");
      }).catch(function (err) {
        go.disabled = false;
        go.textContent = "Export PDF";
        showToast("Export failed: " + (err && err.message ? err.message : String(err)), "error");
      });
    });
    refresh();
  }

  // PURE (exposed for tests): a copy of `scene` with the title and header
  // lines above the drawing and the key below it, as ordinary shapes — the
  // Visio page's equivalent of the PDF's header and key (the PDF draws those
  // itself, so it never uses this). Model px are points on the Visio page.
  // Text widths are estimated (0.62 em per character, the Visio writer's own
  // estimate), so each key label's box is about as wide as its text.
  function withHeaderAndKey(scene, ctx) {
    var b = scene.bbox, out = {
      under: scene.under.slice(), parents: scene.parents.slice(), edges: scene.edges.slice(), nodes: scene.nodes.slice(),
      minFontPx: scene.minFontPx, icons: scene.icons, bbox: null,
    };
    var KEY_PX = 9, TITLE_PX = 14, CHAR_EM = 0.62;
    var width = Math.max(b.w, 360);
    function textBox(text, x, yMid, fontPx, color, bold) {
      var w = Math.max(4, text.length * fontPx * CHAR_EM), h = fontPx * 1.3;
      out.nodes.push({ shape: "rect", polygon: null, x1: x, y1: yMid - h / 2, x2: x + w, y2: yMid + h / 2, fill: null, stroke: null,
        strokeWidth: 0, strokeStyle: "solid", icon: null, z: 0,
        label: { lines: [text], pdfLines: [pdfText(text)], fontPx: fontPx, mono: false, bold: !!bold, italic: false, color: color,
          bg: null, valign: "center", halign: "center", mx: 0, my: 0, textAlign: "left" } });
      return w;
    }
    // Header: title, then up to two lines of what narrowed the view.
    var lines = [{ text: ctx.title ? appName() + " — " + ctx.title : "", px: TITLE_PX, color: "#1a1a1a", bold: true }]
      .concat((ctx.metaLines || []).filter(Boolean).slice(0, 2).map(function (t) { return { text: t, px: KEY_PX, color: "#555555" }; }))
      .filter(function (l) { return l.text; });
    var headH = lines.reduce(function (n, l) { return n + l.px * 1.5; }, 0);
    var y = b.y1 - headH - (lines.length ? 16 : 0);
    var top = y;
    lines.forEach(function (l) { textBox(l.text, b.x1, y + l.px * 0.75, l.px, l.color, l.bold); y += l.px * 1.5; });
    // Key: swatch + label, wrapping at the drawing's width.
    var SW = 16, GAP = 5, SEP = 14, rowH = KEY_PX * 1.8;
    var x = 0, ky = b.y2 + 18, bottom = b.y2;
    (ctx.keyItems || []).forEach(function (it) {
      var tw = it.text.length * KEY_PX * CHAR_EM;
      if (x > 0 && x + SW + GAP + tw > width) { x = 0; ky += rowH; }
      var sx = b.x1 + x, mid = ky + rowH / 2;
      if (it.kind === "dot" || it.kind === "box") {
        var r = KEY_PX * 0.42;
        out.nodes.push({ shape: it.kind === "dot" ? "ellipse" : "round", polygon: null,
          x1: it.kind === "dot" ? sx + SW / 2 - r : sx + 2, y1: mid - r, x2: it.kind === "dot" ? sx + SW / 2 + r : sx + SW - 2, y2: mid + r,
          fill: it.fill || it.color, stroke: it.color, strokeWidth: 1, strokeStyle: it.dashed ? "dashed" : "solid", icon: null, label: null, z: 0 });
      } else {
        out.edges.push({ path: [{ type: "M", x: sx, y: mid }, { type: "L", x: sx + SW, y: mid }], color: it.color,
          width: it.heavy ? 2.6 : 1.8, style: it.dashed ? "dashed" : "solid", arrowTarget: null, arrowSource: null, label: null,
          mid: { x: sx + SW / 2, y: mid }, z: 0 });
      }
      textBox(it.text, sx + SW + GAP, mid, KEY_PX, "#333333");
      x += SW + GAP + tw + SEP;
      bottom = ky + rowH;
    });
    var right = b.x1 + width;
    out.nodes.forEach(function (n) { if (n.x2 > right) right = n.x2; });
    out.bbox = { x1: b.x1, y1: Math.min(b.y1, top), x2: Math.max(b.x2, right), y2: bottom };
    out.bbox.w = out.bbox.x2 - out.bbox.x1; out.bbox.h = out.bbox.y2 - out.bbox.y1;
    out.minFontPx = Math.min(scene.minFontPx, KEY_PX);
    return out;
  }

  function exportVisio(ctx) {
    if (!checkCtx(ctx)) return;
    try {
      var scene = withHeaderAndKey(sceneOf(ctx), ctx);
      var bytes = zipStore(vsdxParts(scene, appName() + " " + ctx.title, ctx.title));
      download(bytes, "application/vnd.ms-visio.drawing", ctx.fileBase + "-" + new Date().toISOString().slice(0, 10) + ".vsdx");
      showToast(ctx.title + " exported for Visio");
    } catch (err) {
      showToast("Export failed: " + (err && err.message ? err.message : String(err)), "error");
    }
  }

  var ICON_CAMERA = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';
  var ICON_DOC = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';
  var ICON_SHAPES = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><path d="M10 6.5h4a2 2 0 0 1 2 2V14"/></svg>';

  // The Export menu. `getCtx` is called per choice so the export reflects the
  // graph at the moment of the click, not when the menu opened.
  function openMenu(anchor, getCtx, opts) {
    opts = opts || {};
    var items = [];
    if (opts.screenshot) items.push({ label: opts.screenshotLabel || "Copy screenshot", icon: ICON_CAMERA, onSelect: opts.screenshot });
    items.push({ label: "Export PDF…", icon: ICON_DOC, onSelect: function () { openPdfDialog(getCtx()); } });
    items.push({ label: "Export to Visio (.vsdx)", icon: ICON_SHAPES, onSelect: function () { exportVisio(getCtx()); } });
    showRowMenu(anchor, items, { align: "end", label: "Export" });
  }

  window.PolarisGraphExport = {
    MIN_PRINT_PT: MIN_PRINT_PT,
    PAPER: PAPER,
    // pure, for tests
    toHex: toHex,
    mixWithWhite: mixWithWhite,
    sectionName: sectionName,
    planPages: planPages,
    occupiedSections: occupiedSections,
    quadToCubic: quadToCubic,
    edgePath: edgePath,
    arrowFrom: arrowFrom,
    pdfText: pdfText,
    shapeKind: shapeKind,
    nodeLabelBlock: nodeLabelBlock,
    crc32: crc32,
    zipStore: zipStore,
    vsdxPageXml: vsdxPageXml,
    vsdxParts: vsdxParts,
    withHeaderAndKey: withHeaderAndKey,
    // live
    sceneFromCy: sceneFromCy,
    openMenu: openMenu,
    openPdfDialog: openPdfDialog,
    exportVisio: exportVisio,
  };
})();
