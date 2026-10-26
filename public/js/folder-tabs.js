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
// is a WINDOW onto the row of tabs at their natural widths, exactly as wide as
// the room it has. A tab wholly inside the window is drawn as it is; a tab the
// window's edge cuts is SQUEEZED to the part inside (width, padding, clipped
// label), and one wholly outside is not drawn. So as the window moves right,
// the left-most tab narrows to nothing while the next one on the right grows
// from nothing. State is `strip.__tabWin`: the measured tabs ({el, s, w}: start
// and natural width, gaps included in s), their total, the room, and `pos`,
// the window's left edge on that row.
//
// The ‹ › pair moves one tab per click (the next tab that way, brought fully
// in); a wheel over the strip moves the window by its delta; and switching to
// a tab the window cuts brings it fully in. The pair sits AFTER the strip, not
// either side of it: the folder card pulls the strip left over its own shadow
// room (negative margin), which would lie over a button placed before it.
var TAB_SEL = ".table-tab, .page-tab, .dashboard-tab";
var STRIP_GLIDE_MS = 180;

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

// Natural widths, measured with every squeeze lifted. A tab the page itself
// hides (zero width with nothing of ours on it) is left out of the row.
function _measureStrip(strip) {
  var st = strip.__tabWin || (strip.__tabWin = { pos: 0, items: [], total: 0, room: 0, active: null });
  var tabs = Array.prototype.slice.call(strip.querySelectorAll(TAB_SEL));
  tabs.forEach(_unsqueeze);
  var items = [];
  var x = 0;
  var box = tabs.length ? tabs[0].parentElement : strip;
  var gap = parseFloat(getComputedStyle(box).columnGap) || 0;
  tabs.forEach(function (t) {
    var w = t.getBoundingClientRect().width;
    if (!w) return;
    var cs = getComputedStyle(t);
    items.push({ el: t, s: x, w: w, pl: parseFloat(cs.paddingLeft) || 0, pr: parseFloat(cs.paddingRight) || 0 });
    x += w + gap;
  });
  st.items = items;
  st.total = items.length ? x - gap : 0;
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
    room -= c.getBoundingClientRect().width + gap;
  });
  st.room = Math.max(0, room);
  return st;
}

function _layoutStrip(strip) {
  var st = strip.__tabWin;
  if (!st) return;
  var max = Math.max(0, st.total - st.room);
  if (st.pos > max) st.pos = max;
  if (st.pos < 0) st.pos = 0;
  var lo = st.pos, hi = st.pos + st.room;
  st.items.forEach(function (it) {
    if (max <= 0.5) { _unsqueeze(it.el); return; }
    var v = Math.min(it.s + it.w, hi) - Math.max(it.s, lo);
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
  });
}

// Measure, lay out, and — when the active tab changed — bring it fully in.
function _refreshStrip(strip) {
  var st = _measureStrip(strip);
  var act = null;
  st.items.forEach(function (it) { if (!act && it.el.classList.contains("active")) act = it; });
  if (act && act.el !== st.active) {
    if (act.s < st.pos) st.pos = act.s;
    else if (act.s + act.w > st.pos + st.room) st.pos = act.s + act.w - st.room;
  }
  st.active = act ? act.el : null;
  _layoutStrip(strip);
}

function _glideStrip(strip, to) {
  var st = strip.__tabWin;
  if (!st) return;
  var from = st.pos;
  if (st.anim) cancelAnimationFrame(st.anim);
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || typeof requestAnimationFrame !== "function") {
    st.pos = to;
    _layoutStrip(strip);
    return;
  }
  var t0 = null;
  var step = function (now) {
    if (t0 === null) t0 = now;
    var p = Math.min(1, (now - t0) / STRIP_GLIDE_MS);
    var e = 1 - Math.pow(1 - p, 3);   // ease-out
    st.pos = from + (to - from) * e;
    _layoutStrip(strip);
    st.anim = p < 1 ? requestAnimationFrame(step) : null;
  };
  st.anim = requestAnimationFrame(step);
}

// One tab per click: the next tab past the window's edge that way, brought
// fully in.
function _stripStepTarget(strip, dir) {
  var st = strip.__tabWin;
  var i;
  if (dir > 0) {
    for (i = 0; i < st.items.length; i++) {
      var it = st.items[i];
      if (it.s + it.w > st.pos + st.room + 0.5) return it.s + it.w - st.room;
    }
    return st.total - st.room;
  }
  for (i = st.items.length - 1; i >= 0; i--) {
    if (st.items[i].s < st.pos - 0.5) return st.items[i].s;
  }
  return 0;
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
    if (!b || b.disabled || !strip.__tabWin) return;
    _glideStrip(strip, _stripStepTarget(strip, Number(b.getAttribute("data-dir"))));
  });
  strip.insertAdjacentElement("afterend", nav);
  return nav;
}

// Show / hide the pair and set each end's disabled state from the window. A
// class flip that changes nothing writes nothing, and `disabled` is outside
// the row observer's attribute filter, so this cannot re-trigger the sync
// that runs it.
function _syncStripNav(row, strip) {
  var nav = row.querySelector(":scope > .table-tabs-nav");
  var st = strip.__tabWin;
  if (!nav || !st) return;
  var max = st.total - st.room;
  var overflowing = max > 0.5 && strip.getClientRects().length > 0;
  if (nav.classList.contains("is-idle") === overflowing) nav.classList.toggle("is-idle", !overflowing);
  var prev = nav.querySelector('[data-dir="-1"]');
  var next = nav.querySelector('[data-dir="1"]');
  var atStart = st.pos <= 0.5;
  var atEnd = st.pos >= max - 0.5;
  if (prev.disabled !== atStart) prev.disabled = atStart;
  if (next.disabled !== atEnd) next.disabled = atEnd;
}

// A wheel over the strip moves the window by its larger delta — a mouse
// wheel's vertical one, or a trackpad's sideways swipe.
function _wireStripWheel(strip) {
  strip.addEventListener("wheel", function (e) {
    var st = strip.__tabWin;
    if (!st || st.total - st.room <= 0.5) return;
    var d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (!d) return;
    if (e.deltaMode === 1) d *= 16;                  // lines
    else if (e.deltaMode === 2) d *= st.room;        // pages
    if (st.anim) { cancelAnimationFrame(st.anim); st.anim = null; }
    st.pos += d;
    _layoutStrip(strip);
    e.preventDefault();
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
  _wireStripWheel(strip);
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
