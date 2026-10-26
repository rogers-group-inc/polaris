/**
 * public/js/folder-tabs.js — folder tabs and the folder card (styles.css
 * "Table head row" / "Folder CARD"; polaris-ui-canon → canon-tables-lists.md).
 *
 * Its own file, not part of app.js, because the /dash wallboard (dash.html)
 * boots with dash-boot.js instead of app.js and has the same tabs and card.
 * Self-wiring: every .table-head-row and .folder-card-scroll on the page is
 * wired on DOMContentLoaded; nothing calls in.
 */

// ─── Folder tabs (.table-head-row) ───────────────────────────────────────────
// The head row draws the table's top rule as a background line with a gap
// under the active tab, which the tab's neck fills (styles.css, "Table head
// row"). This measures that gap — the active tab's span plus the fillet radius
// each side, in px from the row's left edge — and shows only the control
// clusters whose data-head-for names the active tab's data-tab. Wired once per
// row; a MutationObserver re-runs it on any tab switch, re-render, rename or
// show/hide, so no page script has to call it.
function syncFolderTabs(row) {
  // A folder CARD's tabs carry the card's frosted glass on one masked layer
  // per tab (.tab-glass, styles.css), shown on the active one. Ensured on
  // every sync, not once: the Assets strip rewrites a tab's contents on each
  // render, which drops the layer. Inserting it re-fires the observer once;
  // the next pass finds every tab already carrying one and changes nothing.
  if (row.classList.contains("folder-head-card")) {
    row.querySelectorAll(".page-tab, .table-tab, .dashboard-tab").forEach(function (t) {
      if (t.querySelector(":scope > .tab-glass")) return;
      var g = document.createElement("span");
      g.className = "tab-glass";
      g.setAttribute("aria-hidden", "true");
      t.insertBefore(g, t.firstChild);
    });
  }
  var tab = null;
  row.querySelectorAll(".table-tab.active, .page-tab.active, .dashboard-tab.active").forEach(function (t) {
    if (!tab && t.getClientRects().length) tab = t;
  });
  // The gap opens only under an active tab the strip window actually draws,
  // and only across the part inside its area: a tab slid out of view is
  // `visibility: hidden` but keeps its box, out past the area under the
  // controls, and the card opened its edge and cut its cast there (operator
  // report 2026-10-26). `tab` itself still names the active tab for the
  // data-head-for clusters below, in view or not.
  var gapTab = tab && tab.style.visibility !== "hidden" ? tab : null;
  var tr = gapTab ? _clipToArea(row, gapTab.getBoundingClientRect()) : null;
  // The same gap is written twice: on the row (whose rule it opens) and on
  // the visible .folder-body after it, measured from the BODY's left edge —
  // a folder card draws its own top edge and ring cast and opens both there.
  var body = null;
  document.querySelectorAll(".folder-body").forEach(function (b) {
    if (!body && b.getClientRects().length &&
        (row.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) body = b;
  });
  var fr = tr ? (parseFloat(getComputedStyle(row).getPropertyValue("--folder-r")) || 0) : 0;
  _writeFolderGap(row, tr, fr);
  if (body) {
    _writeFolderGap(body, tr, fr);
    if (row.classList.contains("folder-head-card")) _writeFolderStrip(row, body);
  }
  var activeName = tab ? tab.getAttribute("data-tab") : null;
  row.querySelectorAll("[data-head-for]").forEach(function (el) {
    el.classList.toggle("head-off", el.getAttribute("data-head-for") !== activeName);
  });
}

// The fixed area the strip window slides its tabs in, as a {left, right}
// screen span — the list box less the shadow padding _maskArea puts round it
// — or null while the window is off.
function _windowArea(row) {
  var strip = row.querySelector(":scope > :is(.page-tabs, .table-tabs, .dashboard-tabs)");
  var win = strip && strip.__tabWin;
  if (!win || !(win.max > 0.5) || !win.box || win.box === strip) return null;
  var r = win.box.getBoundingClientRect();
  return { left: r.left + STRIP_SHADOW_PX, right: r.right - STRIP_SHADOW_PX };
}

// A tab's span clipped to that area (unchanged while the window is off);
// null when nothing of it is inside.
function _clipToArea(row, rc) {
  var area = _windowArea(row);
  if (!area) return rc;
  var left = Math.max(rc.left, area.left), right = Math.min(rc.right, area.right);
  return right > left ? { left: left, right: right } : null;
}

// --folder-gap-l/-r on `el`: the active tab's span plus the fillet radius each
// side, in px from el's left edge, clamped to el so a tab scrolled partly out
// of the strip can't open the edge past el's own sides. Written only on
// change: the observer in wireFolderTabs() watches the row's attributes, and
// an unconditional write would re-trigger it forever.
function _writeFolderGap(el, tr, fr) {
  var l = "", r = "";
  if (tr) {
    var er = el.getBoundingClientRect();
    var lo = Math.max(0, tr.left - er.left - fr);
    var hi = Math.min(er.width, tr.right - er.left + fr);
    if (hi > lo) { l = lo + "px"; r = hi + "px"; }
  }
  if (el.style.getPropertyValue("--folder-gap-l") !== l) {
    if (l) el.style.setProperty("--folder-gap-l", l); else el.style.removeProperty("--folder-gap-l");
  }
  if (el.style.getPropertyValue("--folder-gap-r") !== r) {
    if (r) el.style.setProperty("--folder-gap-r", r); else el.style.removeProperty("--folder-gap-r");
  }
}

// --folder-strip-l/-r on a folder card: the span its tabs occupy — the first
// visible tab's left to the last tab's (or the + button's) right, clipped to
// the strip's visible box (it scrolls sideways) and to the card — in px from
// the card's left edge. The card's ring cast is cut out above its top edge
// across this span, so it never lies over the translucent inactive tabs
// (styles.css, .folder-card::before). Written only on change, as above.
function _writeFolderStrip(row, body) {
  var strip = row.querySelector(":scope > :is(.page-tabs, .table-tabs, .dashboard-tabs)");
  var l = "", r = "";
  if (strip) {
    var lo = Infinity, hi = -Infinity;
    // While the strip window slides the tabs (below), a tab crossing the
    // fixed area's edge is masked out past it: only the part INSIDE the area
    // is a tab over the card. Counting the whole box ran the cut-out on past
    // the visible tabs, under the controls, and the card lost its top cast
    // there.
    var area = _windowArea(row);
    strip.querySelectorAll(".page-tab, .table-tab, .dashboard-tab, .table-tab-add").forEach(function (t) {
      var rc = t.getBoundingClientRect();
      if (!rc.width || t.style.visibility === "hidden") return;   // hidden by the window
      var left = rc.left, right = rc.right;
      if (area && !t.classList.contains("table-tab-add")) {
        left = Math.max(left, area.left);
        right = Math.min(right, area.right);
        if (right <= left) return;
      }
      if (left < lo) lo = left;
      if (right > hi) hi = right;
    });
    if (hi > lo) {
      var sr = strip.getBoundingClientRect();
      var er = body.getBoundingClientRect();
      lo = Math.max(lo, sr.left);
      hi = Math.min(hi, sr.right);
      lo = Math.max(0, lo - er.left);
      hi = Math.min(er.width, hi - er.left);
      if (hi > lo) { l = lo + "px"; r = hi + "px"; }
    }
  }
  if (body.style.getPropertyValue("--folder-strip-l") !== l) {
    if (l) body.style.setProperty("--folder-strip-l", l); else body.style.removeProperty("--folder-strip-l");
  }
  if (body.style.getPropertyValue("--folder-strip-r") !== r) {
    if (r) body.style.setProperty("--folder-strip-r", r); else body.style.removeProperty("--folder-strip-r");
  }
}

// ─── Strip window (the wheel) ──────────────────────────────────────
// A strip longer than the room the row's controls leave it never pushes them
// and never scrolls natively (that showed tabs in the strip's shadow padding,
// past the card's edges, under a scrollbar). While the tabs overflow, the box
// holding them (the list wrapper) is pinned to the ROOM — a fixed area, so
// the + after it and the controls after the strip hold still — and the row of
// tabs, every one at its natural width, SLIDES inside it: `pos` px of the row
// are past the area's left edge (a `translate` on each tab). A tab crossing
// an edge is cut there and FADES AS A WHOLE, its opacity the share of it
// still inside (operator request 2026-10-26, after straight, slanted and
// card-anchored gradient fades were each tried and dropped); one wholly
// outside is `visibility: hidden`, neither drawn nor hit. Tabs never squeeze
// or grow (a squeezing window was tried first and rejected).
//
// One step — a wheel notch — slides by one tab, whatever its length: to the
// row's next or previous tab start on the area's left edge, clamped so the
// last tab ends flush with the right edge (`max`).
// Switching to a tab partly or wholly outside slides it fully in. State is
// `strip.__tabWin`: the measured tabs ({el, s, w}: start and natural width,
// gaps included in s), the gap, the room, `pos`, `max`, the list box.
var TAB_SEL = ".table-tab, .page-tab, .dashboard-tab";
var STRIP_GLIDE_MS = 180;
var STRIP_WHEEL_NOTCH = 50;   // px of pixel-mode wheel delta that make one step

function _setStyle(el, prop, val) {
  if (el.style[prop] !== val) el.style[prop] = val;
}

// A tab the window draws: shown, not hidden by the page or by the window.
function _isShown(el) {
  return el.getClientRects().length > 0 && el.style.visibility !== "hidden";
}

function _winState(strip) {
  return strip.__tabWin || (strip.__tabWin = { pos: 0, max: 0, items: [], gap: 0, room: 0, active: null, anim: null, wheel: 0 });
}

// Natural widths and the room. Tab widths do not depend on the window (it
// only translates, masks and hides), so nothing is lifted to measure them.
// A tab the page itself hides (zero width) is left out of the row.
function _measureStrip(strip) {
  var st = _winState(strip);
  var tabs = Array.prototype.slice.call(strip.querySelectorAll(TAB_SEL));
  var box = tabs.length ? tabs[0].parentElement : strip;
  st.strip = strip;
  st.box = box;
  st.gap = parseFloat(getComputedStyle(box).columnGap) || 0;
  st.items = [];
  var x = 0;
  tabs.forEach(function (t) {
    var w = t.getBoundingClientRect().width;
    // A tab the window hid keeps its width (visibility keeps layout); 0 means
    // the page hid it.
    if (!w) return;
    st.items.push({ el: t, s: x, w: w });
    x += w + st.gap;
  });
  st.total = st.items.length ? x - st.gap : 0;
  // The room: the strip's content box, less everything in it that is not
  // the tab box (the + button) and their gaps.
  var scs = getComputedStyle(strip);
  var room = strip.clientWidth - (parseFloat(scs.paddingLeft) || 0) - (parseFloat(scs.paddingRight) || 0);
  var sgap = parseFloat(scs.columnGap) || 0;
  if (box !== strip) {
    Array.prototype.forEach.call(strip.children, function (c) {
      if (c === box || !c.getClientRects().length) return;
      room -= c.getBoundingClientRect().width + sgap;
    });
  }
  st.room = Math.max(0, room);
  st.max = Math.max(0, st.total - st.room);
  return st;
}

function _clampPos(st) {
  if (st.pos > st.max) st.pos = st.max;
  if (st.pos < 0) st.pos = 0;
}

// Draw the window at st.pos: pin the box, shift every tab, and cut, fade or
// hide the ones at the edges.
//
// The CUT is one mask on the tab box, a solid block, never a gradient: a
// mask clips everything outside its box, and a per-tab mask cut each tab's
// drop shadow off square. The box is padded out by STRIP_SHADOW_PX on every
// side (cancelled by an equal negative margin, so nothing moves) to take in
// the tabs' shadows, the active neck and its card-cast ring, and the block
// covers it top to bottom; sideways it stops at the area's edge on a side
// with more of the row past it, and runs out to the padding's edge on a
// side without, so the end tab keeps its shadow.
var STRIP_SHADOW_PX = 32;

function _maskArea(box, on, cutL, cutR, R) {
  var E = STRIP_SHADOW_PX;
  // content-box: the pinned width is the AREA; the padding sits outside it.
  _setStyle(box, "boxSizing", on ? "content-box" : "");
  _setStyle(box, "padding", on ? E + "px" : "");
  _setStyle(box, "margin", on ? -E + "px" : "");
  var img = "", size = "", posn = "", rep = "";
  if (on && (cutL || cutR)) {
    var x0 = cutL ? E : 0, x1 = cutR ? E + R : R + 2 * E;
    img = "linear-gradient(#000, #000)";
    size = (x1 - x0).toFixed(1) + "px 100%";
    posn = x0 + "px 0px";
    rep = "no-repeat";
  }
  _setStyle(box, "maskImage", img);
  _setStyle(box, "webkitMaskImage", img);
  _setStyle(box, "maskSize", size);
  _setStyle(box, "webkitMaskSize", size);
  _setStyle(box, "maskPosition", posn);
  _setStyle(box, "webkitMaskPosition", posn);
  _setStyle(box, "maskRepeat", rep);
  _setStyle(box, "webkitMaskRepeat", rep);
}

function _layoutStrip(strip) {
  var st = strip.__tabWin;
  if (!st) return;
  var on = st.max > 0.5;
  var box = st.box;
  var R = st.room;
  if (box && box !== strip) {
    _setStyle(box, "width", on ? R.toFixed(1) + "px" : "");
    _setStyle(box, "flexShrink", on ? "0" : "");
    _maskArea(box, on, on && st.pos > 0.5, on && st.pos < st.max - 0.5, R);
  }
  st.items.forEach(function (it) {
    var el = it.el;
    if (!on) {
      _setStyle(el, "translate", "");
      _setStyle(el, "visibility", "");
      _setStyle(el, "opacity", "");
      return;
    }
    // A tab being dragged carries its own translate (_wireTabDrag).
    if (!el.classList.contains("is-dragging")) _setStyle(el, "translate", (-st.pos).toFixed(1) + "px 0");
    var left = it.s - st.pos, right = left + it.w;
    var inside = Math.min(right, R) - Math.max(left, 0);
    _setStyle(el, "visibility", inside <= 0.5 ? "hidden" : "");
    // A tab the edge cuts fades as a whole: its opacity is the share of it
    // still inside, so it dims as it leaves and brightens as it arrives.
    _setStyle(el, "opacity", inside > 0.5 && inside < it.w - 0.5 ? (inside / it.w).toFixed(3) : "");
  });
}

function _bringIntoView(st, i) {
  var it = st.items[i];
  if (!it) return;
  if (it.s < st.pos) st.pos = it.s;
  else if (it.s + it.w > st.pos + st.room) st.pos = it.s + it.w - st.room;
  _clampPos(st);
}

// Measure, lay out, and bring the active tab fully into view when it changed
// OR when the room or the tabs' widths did: the row's other controls render
// after the strip on page load and take room from it, which dropped an active
// tab brought in a moment earlier back out of view. A pass that changes
// neither leaves the window where the operator moved it. A HELD tab
// (PolarisFolderTabs.hold: one being dragged to a new place) is kept in view
// on every pass, so carrying it past an edge slides the row with it.
function _refreshStrip(strip) {
  var st = _measureStrip(strip);
  // A re-measure mid-glide lands the glide where it was going, not part-way.
  if (st.anim) { cancelAnimationFrame(st.anim); st.anim = null; st.pos = st.animTo; }
  _clampPos(st);
  var ai = -1, hi = -1;
  st.items.forEach(function (it, k) {
    if (ai < 0 && it.el.classList.contains("active")) ai = k;
    if (it.el === st.held) hi = k;
  });
  var act = ai >= 0 ? st.items[ai].el : null;
  var sig = Math.round(st.room) + ":" + st.items.map(function (it) { return Math.round(it.w); }).join(",");
  if (hi >= 0) _bringIntoView(st, hi);
  else if (act && (act !== st.active || sig !== st.sig)) _bringIntoView(st, ai);
  st.active = act;
  st.sig = sig;
  _layoutStrip(strip);
}

function _holdTab(strip, el) {
  if (!strip) return;
  _winState(strip).held = el || null;
}

// ─── Drag a tab to a new place ──────────────────────────────────────────────
// Shared by every strip whose tabs the operator orders (the Assets views,
// assets-tabs.js; the dashboards, dashboard.js), in and out of edit mode.
// Press a tab and move it more than TAB_DRAG_SLOP px: it lifts
// (.is-dragging, the list .is-reordering) and follows the pointer on the
// `translate` property — which composes with the inactive tabs' translateY
// drop instead of replacing it — and it is moved in the DOM past each visible
// neighbour whose centre it crosses, so the others close up around it. Held
// against the list's end it steps one more place past the tabs out of view
// every TAB_DRAG_EDGE_MS, and _holdTab keeps it in the strip's run as it goes.
// Below the slop a press is still a click or half a double-click. The drop
// hands the page the new order of ids (opts.onDrop(ids, moved)); the click
// that ends a drag is swallowed, so dropping never switches tabs. Pointer
// events go on the document, not pointer capture: moving the element in the
// DOM drops a capture. Wired once per list, by delegation, so a page that
// re-renders its tabs keeps it.
//
// opts: { tabSel, idAttr, canStart(tabEl, target) -> bool, onDrop(ids, moved) }
var TAB_DRAG_SLOP = 5;
var TAB_DRAG_EDGE_MS = 300;

function _wireTabDrag(strip, list, opts) {
  if (!list || list.__polarisTabDrag) return;
  list.__polarisTabDrag = true;
  var drag = null;
  var swallowClick = false;
  var tabs = function () {
    return Array.prototype.filter.call(list.children, function (c) { return c.matches(opts.tabSel); });
  };

  function visibleSiblings(el) {
    return tabs().filter(function (t) { return t !== el && _isShown(t); });
  }

  function follow(x) {
    var nl = drag.el.getBoundingClientRect().left - drag.dx;   // where it sits untranslated
    drag.dx = x - drag.grab - nl;
    drag.el.style.translate = drag.dx.toFixed(1) + "px 0";
  }

  function place(x) {
    var el = drag.el;
    var w = el.getBoundingClientRect().width;
    var centre = x - drag.grab + w / 2;
    var sibs = visibleSiblings(el);
    var before = null;
    for (var i = 0; i < sibs.length; i++) {
      var r = sibs[i].getBoundingClientRect();
      if (r.left + r.width / 2 > centre) { before = sibs[i]; break; }
    }
    var ref = before || (sibs.length ? sibs[sibs.length - 1].nextElementSibling : null);
    if (ref !== el && el.nextElementSibling !== ref && !(ref === null && !el.nextElementSibling)) {
      list.insertBefore(el, ref);
    }
    follow(x);
  }

  // Held at an end: one more place past the tabs out of view that way.
  function edgeStep() {
    if (!drag) return;
    var all = tabs().filter(_isShown);
    if (!all.length) return;
    var lo = all[0].getBoundingClientRect().left;
    var hi = all[all.length - 1].getBoundingClientRect().right;
    var dir = drag.x > hi - 12 ? 1 : drag.x < lo + 12 ? -1 : 0;
    if (!dir) return;
    var ts = tabs();
    var i = ts.indexOf(drag.el);
    var n = ts[i + dir];
    if (!n) return;
    if (dir > 0) list.insertBefore(drag.el, n.nextElementSibling); else list.insertBefore(drag.el, n);
    requestAnimationFrame(function () { if (drag) follow(drag.x); });
  }

  function onMove(e) {
    if (!drag) return;
    drag.x = e.clientX;
    if (!drag.live) {
      if (Math.abs(e.clientX - drag.x0) < TAB_DRAG_SLOP) return;
      drag.live = true;
      drag.el.classList.add("is-dragging");
      list.classList.add("is-reordering");
      _holdTab(strip, drag.el);
      drag.timer = setInterval(edgeStep, TAB_DRAG_EDGE_MS);
    }
    e.preventDefault();
    place(e.clientX);
  }

  function onUp() {
    if (!drag) return;
    var d = drag;
    drag = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onUp);
    if (!d.live) return;
    clearInterval(d.timer);
    d.el.style.translate = "";
    d.el.classList.remove("is-dragging");
    list.classList.remove("is-reordering");
    _holdTab(strip, null);
    swallowClick = true;
    setTimeout(function () { swallowClick = false; }, 0);
    var ids = tabs().map(function (t) { return t.getAttribute(opts.idAttr); });
    opts.onDrop(ids, ids.indexOf(d.id) !== d.from);
  }

  list.addEventListener("pointerdown", function (e) {
    if (e.button !== 0 || drag) return;
    var el = e.target.closest && e.target.closest(opts.tabSel);
    if (!el || el.parentElement !== list) return;
    if (e.target.closest("button, input, textarea, select")) return;
    if (opts.canStart && !opts.canStart(el, e.target)) return;
    var id = el.getAttribute(opts.idAttr);
    drag = {
      el: el, id: id, from: tabs().indexOf(el),
      x0: e.clientX, x: e.clientX, grab: e.clientX - el.getBoundingClientRect().left,
      // The window slides tabs on the same `translate` (_layoutStrip): start
      // from the offset already on it, or a slid tab jumps when lifted.
      dx: parseFloat(el.style.translate) || 0, live: false, timer: null,
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });

  list.addEventListener("click", function (e) {
    if (swallowClick) { e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);
}

// The seam page tab scripts use: hold(strip, tab) keeps `tab` in the run
// until hold(strip, null); wireDrag(strip, list, opts) — above.
window.PolarisFolderTabs = {
  hold: _holdTab,
  wireDrag: _wireTabDrag,
};

// One step: the row slides by one tab, whatever its length. Resting places
// put a tab's start ON the area's left edge — where the first tab sits —
// and the tab before it fades out in the F px past that edge; clamped to
// [0, max]. › moves to the next tab start, ‹ to
// the previous one. Eased over STRIP_GLIDE_MS; a step that lands mid-glide
// starts from where the glide was headed.
function _stepTarget(st, dir) {
  var cur = 0;
  st.items.forEach(function (it, k) { if (it.s <= st.pos + 0.5) cur = k; });
  if (dir > 0) {
    if (st.pos >= st.max - 0.5) return st.pos;
    var n = st.items[cur + 1];
    return n ? Math.min(st.max, n.s) : st.max;
  }
  if (st.pos <= 0.5) return 0;
  var c = st.items[cur];
  if (c && st.pos > c.s + 0.5) return c.s;
  var p = st.items[cur - 1];
  return p ? p.s : 0;
}

function _stepStrip(strip, dir, done) {
  var st = strip.__tabWin;
  if (!st) return;
  // A step that lands mid-glide first FINISHES that glide — draws its end —
  // or a notch at the row's end (nothing further to glide to) left the
  // tabs frozen part-way, the end tab still cut and its edge still fading.
  if (st.anim) { cancelAnimationFrame(st.anim); st.anim = null; st.pos = st.animTo; _layoutStrip(strip); }
  var to = _stepTarget(st, dir);
  if (Math.abs(to - st.pos) < 0.5) return;
  var from = st.pos;
  st.animTo = to;
  var finish = function () {
    st.anim = null;
    st.pos = to;
    _layoutStrip(strip);
    if (done) done();
  };
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || typeof requestAnimationFrame !== "function") { finish(); return; }
  var t0 = null;
  var frame = function (now) {
    if (t0 === null) t0 = now;
    var p = Math.min(1, (now - t0) / STRIP_GLIDE_MS);
    if (p >= 1) { finish(); return; }
    st.pos = from + (to - from) * (1 - Math.pow(1 - p, 3));   // ease-out
    _layoutStrip(strip);
    st.anim = requestAnimationFrame(frame);
  };
  st.anim = requestAnimationFrame(frame);
}

// A wheel over the strip steps it one tab per notch, by its larger delta (a
// mouse wheel's vertical one, or a trackpad's sideways swipe). A line-mode
// event (Firefox) is a notch by itself; pixel-mode deltas accumulate, so a
// trackpad's stream of small ones steps once per STRIP_WHEEL_NOTCH.
function _wireStripWheel(row, strip) {
  strip.addEventListener("wheel", function (e) {
    var st = strip.__tabWin;
    if (!st || st.max <= 0.5) return;
    e.preventDefault();
    var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    var dir = 0;
    if (e.deltaMode !== 0) {
      dir = d > 0 ? 1 : -1;
      st.wheel = 0;
    } else {
      if ((st.wheel > 0) !== (d > 0)) st.wheel = 0;   // a reversal starts over
      st.wheel += d;
      if (Math.abs(st.wheel) >= STRIP_WHEEL_NOTCH) {
        dir = st.wheel > 0 ? 1 : -1;
        st.wheel = 0;
      }
    }
    if (dir) _stepStrip(strip, dir);
  }, { passive: false });
}

// The strip re-measures when its tabs change (added, closed, renamed,
// switched, the page showing or hiding one) — its OWN observer, which leaves
// out `style`, so the window's own writes never re-trigger it — and when its room
// changes size. Coalesced to one pass per frame.
function _wireStripWindow(row, strip, after) {
  var queued = false;
  var run = function () {
    queued = false;
    _refreshStrip(strip);
    after();
  };
  var schedule = function () {
    if (queued) return;
    queued = true;
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  };
  _wireStripWheel(row, strip);
  // The strip clips (overflow: hidden) but is never scrolled: the window
  // translates its tabs instead. A browser can still scroll a clipped box —
  // to show a focused tab — which would shift every tab under the window's
  // feet; put it straight back.
  strip.addEventListener("scroll", function () { if (strip.scrollLeft) strip.scrollLeft = 0; }, { passive: true });
  if (typeof MutationObserver === "function") {
    new MutationObserver(schedule).observe(strip, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "hidden"],
    });
  }
  window.addEventListener("resize", schedule);
  if (typeof ResizeObserver === "function") new ResizeObserver(schedule).observe(strip);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule);
  _refreshStrip(strip);
}

function wireFolderTabs() {
  document.querySelectorAll(".table-head-row").forEach(function (row) {
    if (row.__polarisFolderWired) return;
    row.__polarisFolderWired = true;
    var strip = row.querySelector(".table-tabs, .page-tabs, .dashboard-tabs");
    var sync = function () { syncFolderTabs(row); };
    if (strip) _wireStripWindow(row, strip, sync);
    window.addEventListener("resize", sync);
    if (typeof ResizeObserver === "function") {
      var ro = new ResizeObserver(sync);
      ro.observe(row);
      if (strip) ro.observe(strip);
    }
    if (typeof MutationObserver === "function") {
      new MutationObserver(sync).observe(row, {
        subtree: true, childList: true, attributes: true, attributeFilter: ["class", "style"],
      });
    }
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sync);
    sync();
  });
}
// A folder card's scroller fades its contents into an edge only while there
// is more past that edge (styles.css, .folder-card-scroll). Re-checked on
// scroll and whenever the scroller or a panel in it changes size — a tab
// switch or a lazily loaded tab body changes the scroll height without
// scrolling.
function wireFolderScrollFades() {
  document.querySelectorAll(".folder-card-scroll").forEach(function (el) {
    if (el.__polarisFadeWired) return;
    el.__polarisFadeWired = true;
    var update = function () {
      el.classList.toggle("fade-top", el.scrollTop > 1);
      el.classList.toggle("fade-bottom", el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    el.addEventListener("scroll", update, { passive: true });
    if (typeof ResizeObserver === "function") {
      var ro = new ResizeObserver(update);
      ro.observe(el);
      Array.prototype.forEach.call(el.children, function (c) { ro.observe(c); });
    }
    update();
  });
}

function wireFolderSurfaces() {
  wireFolderTabs();
  wireFolderScrollFades();
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireFolderSurfaces);
else wireFolderSurfaces();
