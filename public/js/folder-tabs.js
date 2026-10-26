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

// ─── Strip scrolling (‹ › and the wheel) ────────────────────────────────────
// A strip longer than the room the row's controls leave it scrolls sideways
// rather than pushing them (styles.css, .table-head-row > .table-tabs). A
// scrollbar alone hid that there were more tabs, so the strip gets a ‹ › pair
// right after it, shown only while it overflows, each end disabled when there
// is nothing further that way; and a vertical wheel over the strip scrolls it
// sideways. The pair sits AFTER the strip, not either side of it: the folder
// card pulls the strip left over its own shadow room (negative margin), which
// would lie over a button placed before it.
var STRIP_STEP = 0.6;   // one click scrolls this share of the visible strip

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
    var by = Math.max(40, strip.clientWidth * STRIP_STEP) * Number(b.getAttribute("data-dir"));
    try { strip.scrollBy({ left: by, behavior: "smooth" }); }
    catch (_) { strip.scrollLeft += by; }
  });
  strip.insertAdjacentElement("afterend", nav);
  return nav;
}

// Show / hide the pair and set each end's disabled state. A class flip that
// changes nothing writes nothing, and `disabled` is outside the observer's
// attribute filter, so this cannot re-trigger the sync that runs it.
function _syncStripNav(row, strip) {
  var nav = row.querySelector(":scope > .table-tabs-nav");
  if (!nav) return;
  var max = strip.scrollWidth - strip.clientWidth;
  var overflowing = max > 1 && strip.getClientRects().length > 0;
  if (nav.classList.contains("is-idle") === overflowing) nav.classList.toggle("is-idle", !overflowing);
  var prev = nav.querySelector('[data-dir="-1"]');
  var next = nav.querySelector('[data-dir="1"]');
  var atStart = strip.scrollLeft <= 1;
  var atEnd = strip.scrollLeft >= max - 1;
  if (prev.disabled !== atStart) prev.disabled = atStart;
  if (next.disabled !== atEnd) next.disabled = atEnd;
}

// A vertical wheel (or a trackpad's vertical swipe) over an overflowing strip
// scrolls it sideways. A mostly-horizontal gesture is left to the browser,
// which already scrolls the strip natively.
function _wireStripWheel(strip) {
  strip.addEventListener("wheel", function (e) {
    if (strip.scrollWidth - strip.clientWidth <= 1) return;
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
    var d = e.deltaY;
    if (e.deltaMode === 1) d *= 16;                       // lines
    else if (e.deltaMode === 2) d *= strip.clientWidth;   // pages
    strip.scrollLeft += d;
    e.preventDefault();
  }, { passive: false });
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
      _wireStripWheel(strip);
      strip.addEventListener("scroll", sync, { passive: true });
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
