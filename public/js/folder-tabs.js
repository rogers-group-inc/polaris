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

function wireFolderTabs() {
  document.querySelectorAll(".table-head-row").forEach(function (row) {
    if (row.__polarisFolderWired) return;
    row.__polarisFolderWired = true;
    var sync = function () { syncFolderTabs(row); };
    var strip = row.querySelector(".table-tabs, .page-tabs, .dashboard-tabs");
    if (strip) strip.addEventListener("scroll", sync, { passive: true });
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
