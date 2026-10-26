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
  // The same gap is written twice: on the row (whose rule it opens) and on
  // the visible .folder-body after it, measured from the BODY's left edge —
  // a folder card draws its own top edge and ring cast and opens both there.
  var body = null;
  document.querySelectorAll(".folder-body").forEach(function (b) {
    if (!body && b.getClientRects().length &&
        (row.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) body = b;
  });
  var tr = tab ? tab.getBoundingClientRect() : null;
  var fr = tab ? (parseFloat(getComputedStyle(row).getPropertyValue("--folder-r")) || 0) : 0;
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
    strip.querySelectorAll(".page-tab, .table-tab, .dashboard-tab, .table-tab-add").forEach(function (t) {
      var rc = t.getBoundingClientRect();
      if (!rc.width) return;
      if (rc.left < lo) lo = rc.left;
      if (rc.right > hi) hi = rc.right;
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

// ─── Strip window (‹ › and the wheel) ──────────────────────────────────────
// A strip longer than the room the row's controls leave it never pushes them
// and never scrolls natively: native scrolling showed tabs in the strip's
// shadow padding, past the card's edges, under a scrollbar. Instead the strip
// shows a run of WHOLE tabs that fits its room, starting at `first`, and
// draws none of the rest — so no tab is ever cut to a sliver at either end.
// One step (a ‹ › click, a wheel notch) moves `first` by one tab, whatever
// that tab's length: the tab leaving shrinks to nothing while the one arriving
// grows from nothing (a squeeze — inline width, padding scaled, clipped label
// — eased over STRIP_GLIDE_MS). Switching to a tab outside the run brings it
// in. State is `strip.__tabWin`: the measured tabs ({el, w, pl, pr}), the gap
// between them, the room, `first`, and `maxFirst` (the first index from which
// every remaining tab fits — the run's end).
//
// The ‹ › pair sits AFTER the strip, not either side of it: the folder card
// pulls the strip left over its own shadow room (negative margin), which
// would lie over a button placed before it.
var TAB_SEL = ".table-tab, .page-tab, .dashboard-tab";
var STRIP_GLIDE_MS = 180;
var STRIP_WHEEL_NOTCH = 50;   // px of pixel-mode wheel delta that make one step

function _setStyle(el, prop, val) {
  if (el.style[prop] !== val) el.style[prop] = val;
}

function _unsqueeze(el) {
  _setStyle(el, "display", "");
  _setStyle(el, "width", "");
  _setStyle(el, "minWidth", "");
  _setStyle(el, "boxSizing", "");
  _setStyle(el, "overflow", "");
  _setStyle(el, "paddingLeft", "");
  _setStyle(el, "paddingRight", "");
}

// Draw one tab at width v: whole, squeezed, or not at all.
function _drawTab(it, v) {
  if (v >= it.w - 0.5) { _unsqueeze(it.el); return; }
  if (v <= 0.5) { _setStyle(it.el, "display", "none"); return; }
  var k = v / it.w;
  _setStyle(it.el, "display", "");
  _setStyle(it.el, "boxSizing", "border-box");
  _setStyle(it.el, "minWidth", "0");
  _setStyle(it.el, "overflow", "hidden");
  _setStyle(it.el, "width", v.toFixed(1) + "px");
  _setStyle(it.el, "paddingLeft", (it.pl * k).toFixed(1) + "px");
  _setStyle(it.el, "paddingRight", (it.pr * k).toFixed(1) + "px");
}

// Natural widths, measured with every squeeze lifted. A tab the page itself
// hides (zero width with nothing of ours on it) is left out of the run.
function _measureStrip(strip) {
  var st = strip.__tabWin || (strip.__tabWin = { first: 0, maxFirst: 0, items: [], gap: 0, room: 0, active: null, anim: null, wheel: 0 });
  if (st.anim) { cancelAnimationFrame(st.anim); st.anim = null; }
  var tabs = Array.prototype.slice.call(strip.querySelectorAll(TAB_SEL));
  tabs.forEach(_unsqueeze);
  var box = tabs.length ? tabs[0].parentElement : strip;
  st.gap = parseFloat(getComputedStyle(box).columnGap) || 0;
  st.items = [];
  tabs.forEach(function (t) {
    var w = t.getBoundingClientRect().width;
    if (!w) return;
    var cs = getComputedStyle(t);
    st.items.push({ el: t, w: w, pl: parseFloat(cs.paddingLeft) || 0, pr: parseFloat(cs.paddingRight) || 0 });
  });
  // The room: the strip's content box, less everything in it that is not a
  // tab (the + button, and the list wrapper's siblings) and their gaps.
  var scs = getComputedStyle(strip);
  var room = strip.clientWidth - (parseFloat(scs.paddingLeft) || 0) - (parseFloat(scs.paddingRight) || 0);
  var sgap = parseFloat(scs.columnGap) || 0;
  if (box !== strip) {
    Array.prototype.forEach.call(strip.children, function (c) {
      if (c === box || !c.getClientRects().length) return;
      room -= c.getBoundingClientRect().width + sgap;
    });
  }
  Array.prototype.forEach.call(box.children, function (c) {
    if (c.matches(TAB_SEL) || !c.getClientRects().length) return;
    room -= c.getBoundingClientRect().width + st.gap;
  });
  st.room = Math.max(0, room);
  // maxFirst: walk back from the last tab while the tail still fits.
  var used = 0, f = st.items.length;
  while (f > 0) {
    var need = st.items[f - 1].w + (f < st.items.length ? st.gap : 0);
    if (used + need > st.room + 0.5) break;
    used += need;
    f--;
  }
  st.maxFirst = Math.min(f, Math.max(0, st.items.length - 1));
  return st;
}

// Widths of the run that starts at `first`: whole tabs while they fit, the
// rest 0. A first tab wider than the whole room is squeezed to the room
// rather than leaving the strip empty.
function _runWidths(st, first) {
  var out = st.items.map(function () { return 0; });
  var used = 0;
  for (var k = first; k < st.items.length; k++) {
    var need = st.items[k].w + (k > first ? st.gap : 0);
    if (used + need > st.room + 0.5) {
      if (k === first) out[k] = st.room;
      break;
    }
    out[k] = st.items[k].w;
    used += need;
  }
  return out;
}

// The index of the last tab the run starting at `first` holds whole.
function _runLast(st, first) {
  var w = _runWidths(st, first);
  var last = first;
  for (var k = first; k < w.length; k++) if (w[k] > 0) last = k;
  return last;
}

function _layoutStrip(strip) {
  var st = strip.__tabWin;
  if (!st) return;
  var w = _runWidths(st, st.first);
  st.items.forEach(function (it, k) { _drawTab(it, w[k]); });
}

function _clampFirst(st) {
  if (st.first > st.maxFirst) st.first = st.maxFirst;
  if (st.first < 0) st.first = 0;
}

function _bringIntoRun(st, i) {
  if (i < st.first) st.first = i;
  else while (st.first < i && _runLast(st, st.first) < i) st.first++;
  _clampFirst(st);
}

// Measure, lay out, and bring the active tab into the run when it changed OR
// when the room or the tabs' widths did: the row's other controls render
// after the strip on page load and take room from it, which dropped an active
// tab brought in a moment earlier back out of the run. A pass that changes
// neither leaves the run where the operator stepped it. A HELD tab
// (PolarisFolderTabs.hold: one being dragged to a new place) is kept in the
// run on every pass, so moving it past the run's end shifts the run with it.
function _refreshStrip(strip) {
  var st = _measureStrip(strip);
  _clampFirst(st);
  var ai = -1, hi = -1;
  st.items.forEach(function (it, k) {
    if (ai < 0 && it.el.classList.contains("active")) ai = k;
    if (it.el === st.held) hi = k;
  });
  var act = ai >= 0 ? st.items[ai].el : null;
  var sig = Math.round(st.room) + ":" + st.items.map(function (it) { return Math.round(it.w); }).join(",");
  if (hi >= 0) _bringIntoRun(st, hi);
  else if (act && (act !== st.active || sig !== st.sig)) _bringIntoRun(st, ai);
  st.active = act;
  st.sig = sig;
  _layoutStrip(strip);
}

function _holdTab(strip, el) {
  if (!strip) return;
  var st = strip.__tabWin || (strip.__tabWin = { first: 0, maxFirst: 0, items: [], gap: 0, room: 0, active: null, anim: null, wheel: 0 });
  st.held = el || null;
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
    return tabs().filter(function (t) { return t !== el && t.getClientRects().length > 0; });
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
    var all = tabs().filter(function (t) { return t.getClientRects().length > 0; });
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
      dx: 0, live: false, timer: null,
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

// One step: `first` moves by one tab, the leaving tab shrinking and the
// arriving one growing. A step that lands mid-glide finishes that glide first.
function _stepStrip(strip, dir, done) {
  var st = strip.__tabWin;
  if (!st) return;
  var to = Math.max(0, Math.min(st.maxFirst, st.first + dir));
  if (to === st.first) return;
  if (st.anim) { cancelAnimationFrame(st.anim); st.anim = null; _layoutStrip(strip); }
  var from = _runWidths(st, st.first);
  st.first = to;
  var dest = _runWidths(st, st.first);
  var finish = function () {
    st.anim = null;
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
    var e = 1 - Math.pow(1 - p, 3);   // ease-out
    st.items.forEach(function (it, k) { _drawTab(it, from[k] + (dest[k] - from[k]) * e); });
    st.anim = requestAnimationFrame(frame);
  };
  st.anim = requestAnimationFrame(frame);
  if (done) done();
}

function _ensureStripNav(row, strip) {
  var nav = row.querySelector(":scope > .table-tabs-nav");
  if (nav) return nav;
  nav = document.createElement("div");
  nav.className = "table-head-controls table-tabs-nav is-idle";
  nav.innerHTML =
    '<button type="button" class="btn btn-secondary btn-sm btn-icon-only" data-dir="-1" aria-label="Scroll tabs left" title="Scroll tabs left">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>' +
    '<button type="button" class="btn btn-secondary btn-sm btn-icon-only" data-dir="1" aria-label="Scroll tabs right" title="Scroll tabs right">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></button>';
  nav.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button[data-dir]");
    if (!b || b.disabled) return;
    _stepStrip(strip, Number(b.getAttribute("data-dir")), function () { _syncStripNav(row, strip); });
  });
  strip.insertAdjacentElement("afterend", nav);
  return nav;
}

// Show / hide the pair and set each end's disabled state. A class flip that
// changes nothing writes nothing, and `disabled` is outside the row
// observer's attribute filter, so this cannot re-trigger the sync that runs it.
function _syncStripNav(row, strip) {
  var nav = row.querySelector(":scope > .table-tabs-nav");
  var st = strip.__tabWin;
  if (!nav || !st) return;
  var overflowing = st.maxFirst > 0 && strip.getClientRects().length > 0;
  if (nav.classList.contains("is-idle") === overflowing) nav.classList.toggle("is-idle", !overflowing);
  var prev = nav.querySelector('[data-dir="-1"]');
  var next = nav.querySelector('[data-dir="1"]');
  var atStart = st.first <= 0;
  var atEnd = st.first >= st.maxFirst;
  if (prev.disabled !== atStart) prev.disabled = atStart;
  if (next.disabled !== atEnd) next.disabled = atEnd;
}

// A wheel over the strip steps it one tab per notch, by its larger delta (a
// mouse wheel's vertical one, or a trackpad's sideways swipe). A line-mode
// event (Firefox) is a notch by itself; pixel-mode deltas accumulate, so a
// trackpad's stream of small ones steps once per STRIP_WHEEL_NOTCH.
function _wireStripWheel(row, strip) {
  strip.addEventListener("wheel", function (e) {
    var st = strip.__tabWin;
    if (!st || st.maxFirst <= 0) return;
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
    if (dir) _stepStrip(strip, dir, function () { _syncStripNav(row, strip); });
  }, { passive: false });
}

// The strip re-measures when its tabs change (added, closed, renamed,
// switched, the page showing or hiding one) — its OWN observer, which leaves
// out `style`, so the squeeze writes never re-trigger it — and when its room
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
    var sync = function () {
      syncFolderTabs(row);
      if (strip) _syncStripNav(row, strip);
    };
    if (strip) {
      _ensureStripNav(row, strip);
      _wireStripWindow(row, strip, sync);
    }
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
