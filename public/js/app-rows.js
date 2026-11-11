/**
 * public/js/app-rows.js — Tables: row selection (click, drag, Shift / Ctrl, Ctrl+A, the keyboard),
 * sticky table wrappers, pagination, the shared formatters and status badge,
 * and the subnet utilization cell.
 *
 * Part of the app.js shell (CQ-F051): plain browser scripts sharing page
 * globals, loaded on every app page in APP_FILES order (app.js first,
 * app-boot.js last). See tests/unit/appSplit.test.ts.
 */

/**
 * Keep `tr.selected` in step with the row checkboxes under `scope` (a tbody,
 * a table, or anything containing them).
 *
 * The class is what pairs the bulk bar's count with WHICH rows it means — a
 * checkbox alone is a poor cue on a wide table where the checkbox column has
 * scrolled out of view. Call it after any wholesale tbody re-render and after
 * a select-all: assigning `.checked` in script does NOT fire a change event,
 * so the delegated listener below never sees those.
 */
function syncSelectedRows(scope) {
  var root = scope || document;
  root.querySelectorAll(".cb-col input[type=checkbox]").forEach(function (cb) {
    var tr = cb.closest("tr");
    if (tr) tr.classList.toggle("selected", cb.checked);
  });
}
if (typeof window !== "undefined") window.syncSelectedRows = syncSelectedRows;

// One delegated listener covers every list page's single-row clicks, so a page
// only has to call syncSelectedRows for the two cases this can't see.
document.addEventListener("change", function (e) {
  var cb = e.target;
  if (!cb || cb.type !== "checkbox") return;
  var cell = cb.closest && cb.closest("td.cb-col");
  if (!cell) return;
  var tr = cell.closest("tr");
  if (tr) tr.classList.toggle("selected", cb.checked);
});

// ─── Row selection: click, drag, Shift+click, Ctrl+click ────────────────────
// Every list table whose rows carry a `td.cb-col` checkbox is selected by
// clicking the ROW, the way a file explorer selects files: click = this row
// only, Ctrl/⌘+click = toggle, Shift+click = range from the last click,
// click-and-drag = range (Ctrl+drag adds to what was already selected),
// Ctrl/⌘+A = every row of the table last clicked. The checkbox column is
// hidden (styles.css, table-sf.js) but the boxes stay as the state carrier:
// this controller sets them and fires a bubbling `change`, so each page's own
// change listener — the selection Set, the bulk bar, `tr.selected` above —
// keeps working without knowing how the row was picked.
//
// A plain click or plain drag REPLACES the selection, and a page whose
// selection outlives the visible rows (the Assets list keeps picks across
// pages) hears `polaris:rowselect-clear` on the tbody first, so it can drop
// the off-page ones too.
var ROW_SELECT_SKIP = "a, button, input, select, textarea, label, summary, [contenteditable], " +
  "[role=button], .row-menu-trigger, [data-row-menu], .fav-star, .copy-on-click, [data-no-row-select]";
var _rowSel = null;          // the gesture in progress
var _rowSelLastTbody = null; // Ctrl+A's target
var _rowSelAnchor = null;    // Shift+click's start row

// A `<tr data-row-menu-row>` with no checkbox (a table with no bulk verbs: the
// Users, Automations, IPAM and Path Monitor lists) is selectable too — the
// standard table gestures are click selects, click the name opens, double
// click opens, right click is the menu. Its stand-in box keeps the state on
// `tr.selected` itself, so every gesture below works without knowing which
// kind of row it has.
function _rowClassBox(tr) {
  if (!tr._rowSelBox) {
    tr._rowSelBox = {
      disabled: false,
      get checked() { return tr.classList.contains("selected"); },
      set checked(on) { tr.classList.toggle("selected", !!on); },
      dispatchEvent: function () { return true; },
    };
  }
  return tr._rowSelBox;
}
function _rowSelectBox(tr) {
  if (!tr || !tr.cells) return null;
  for (var i = 0; i < tr.cells.length; i++) {
    if (!tr.cells[i].classList.contains("cb-col")) continue;
    var cb = tr.cells[i].querySelector("input[type=checkbox]");
    return cb && !cb.disabled ? cb : null;
  }
  return tr.hasAttribute && tr.hasAttribute("data-row-menu-row") ? _rowClassBox(tr) : null;
}
// Every tbody holding a selected row, of either kind.
var ROW_SELECT_CHECKED = "td.cb-col input[type=checkbox]:checked, tr[data-row-menu-row].selected";
function _rowSelectRows(tbody) {
  return Array.prototype.filter.call(tbody.children, function (tr) {
    return tr.tagName === "TR" && tr.style.display !== "none" && _rowSelectBox(tr);
  });
}
function _rowSelectSet(tr, on) {
  var cb = _rowSelectBox(tr);
  if (!cb || cb.checked === on) return;
  cb.checked = on;
  cb.dispatchEvent(new window.Event("change", { bubbles: true }));
}
function _rowSelectClearOthers(tbody, keep) {
  tbody.dispatchEvent(new window.CustomEvent("polaris:rowselect-clear", { bubbles: true }));
  _rowSelectRows(tbody).forEach(function (tr) { if (tr !== keep) _rowSelectSet(tr, false); });
}
// A right click on a row that is not selected makes it the selection, as a file
// explorer does, so a row menu acting on "the selection" acts on the row that
// was clicked; a right click on a selected row keeps the whole selection.
function _rowSelectForMenu(tr) {
  var cb = _rowSelectBox(tr);
  if (!cb || cb.checked || !tr.parentNode || tr.parentNode.tagName !== "TBODY") return;
  _rowSelLastTbody = tr.parentNode;
  _rowSelAnchor = tr;
  _rowSelCursor = null;
  _rowSelectClearOthers(tr.parentNode, tr);
  _rowSelectSet(tr, true);
}
// Rows between the anchor and `cur` take `state`; the rest go back to what they
// were when the gesture began (additive) or off (replacing).
function _rowSelectApplyRange(g, cur) {
  var rows = _rowSelectRows(g.tbody);
  var a = rows.indexOf(g.anchor), b = rows.indexOf(cur);
  if (a < 0 || b < 0) return;
  var lo = Math.min(a, b), hi = Math.max(a, b);
  rows.forEach(function (tr, i) {
    if (i >= lo && i <= hi) _rowSelectSet(tr, g.state);
    else _rowSelectSet(tr, g.additive ? g.base.has(tr) : false);
  });
}
function _rowSelectScroller(el) {
  for (var n = el.parentElement; n && n !== document.body; n = n.parentElement) {
    var oy = window.getComputedStyle(n).overflowY;
    if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
  }
  return document.scrollingElement || document.documentElement;
}
function _rowSelectRowOf(g, el) {
  var tr = el && el.closest ? el.closest("tr") : null;
  return tr && tr.parentNode === g.tbody && _rowSelectBox(tr) ? tr : null;
}
function _rowSelectRowAt(g, x, y) {
  return _rowSelectRowOf(g, document.elementFromPoint(x, y));
}
// Holding the pointer near the top or bottom edge of the scrolling box keeps
// the drag going past what is on screen.
function _rowSelectAutoScroll() {
  var g = _rowSel;
  if (!g || !g.dragging) return;
  var box = g.scroller.getBoundingClientRect();
  var top = Math.max(box.top, 0), bottom = Math.min(box.bottom, window.innerHeight);
  var EDGE = 32, step = 0;
  if (g.y < top + EDGE) step = -Math.ceil((top + EDGE - g.y) / 3);
  else if (g.y > bottom - EDGE) step = Math.ceil((g.y - (bottom - EDGE)) / 3);
  if (step) {
    g.scroller.scrollTop += step;
    var tr = _rowSelectRowAt(g, g.x, Math.min(Math.max(g.y, top + 2), bottom - 2));
    if (tr && tr !== g.last) { g.last = tr; _rowSelectApplyRange(g, tr); }
  }
  g.raf = window.requestAnimationFrame(_rowSelectAutoScroll);
}

// Clicking off a table clears its selection. "Off" excludes what acts ON the
// selection (the bulk bar, its menus, the page buttons — the Assets list keeps
// picks across pages) and anything floating over the page (a dialog, a menu, a
// slide-over) unless the table itself lives in it, so the Alerts tab's picks
// clear on a click elsewhere in the asset panel while the Assets list's survive
// a confirm dialog. A press on a scrollbar is not a click off either.
var ROW_SELECT_KEEP = ".bulk-bar, #pagination, .pagination, .slideover-pagination, .page-controls, [data-keep-selection]";
var ROW_SELECT_FLOATING = "#modal-overlay, .modal-overlay, .slideover, .slideover-overlay, [role=dialog], [role=menu], " +
  ".row-context-menu, .sf-multi-popover, .toast-container";
function _rowSelectOnScrollbar(t, e) {
  if (!t.getBoundingClientRect || !(t.clientWidth || t.clientHeight)) return false;
  var r = t.getBoundingClientRect();
  return e.clientX >= r.left + t.clientLeft + t.clientWidth || e.clientY >= r.top + t.clientTop + t.clientHeight;
}
function _rowSelectClickOff(t, e) {
  if (t.closest(ROW_SELECT_KEEP) || _rowSelectOnScrollbar(t, e)) return;
  var tbodies = [];
  document.querySelectorAll(ROW_SELECT_CHECKED).forEach(function (cb) {
    var tb = cb.closest("tbody");
    if (tb && tbodies.indexOf(tb) < 0) tbodies.push(tb);
  });
  // Also the table last clicked, so a page holding picks only on other pages
  // (nothing checked on screen) still hears the clear.
  if (_rowSelLastTbody && _rowSelLastTbody.isConnected && tbodies.indexOf(_rowSelLastTbody) < 0) tbodies.push(_rowSelLastTbody);
  var floating = t.closest(ROW_SELECT_FLOATING);
  tbodies.forEach(function (tb) {
    var table = tb.closest("table") || tb;
    if (table.contains(t)) return;
    if (floating && !floating.contains(tb)) return;
    _rowSelectClearOthers(tb, null);
    if (_rowSelAnchor && _rowSelAnchor.parentNode === tb) _rowSelAnchor = null;
  });
}

document.addEventListener("mousedown", function (e) {
  if (e.button !== 0) return;
  var t = e.target;
  if (!t || !t.closest) return;
  _rowSelectClickOff(t, e);
  var tr = t.closest("tr");
  if (!tr || !tr.parentNode || tr.parentNode.tagName !== "TBODY" || !_rowSelectBox(tr)) return;
  var skip = t.closest(ROW_SELECT_SKIP);
  if (skip && tr.contains(skip)) return;
  var tbody = tr.parentNode;
  _rowSelLastTbody = tbody;
  var ctrl = e.ctrlKey || e.metaKey;
  var anchorOk = _rowSelAnchor && _rowSelAnchor.parentNode === tbody && _rowSelectBox(_rowSelAnchor);
  if (e.shiftKey) {
    // Shift+click: no drag, no text selection, anchor stays put.
    e.preventDefault();
    var anchor = anchorOk ? _rowSelAnchor : tr;
    if (!ctrl) tbody.dispatchEvent(new window.CustomEvent("polaris:rowselect-clear", { bubbles: true }));
    _rowSelectApplyRange({ tbody: tbody, anchor: anchor, state: true, additive: ctrl,
      base: new Set(_rowSelectRows(tbody).filter(function (r) { return _rowSelectBox(r).checked; })) }, tr);
    return;
  }
  var base = new Set(_rowSelectRows(tbody).filter(function (r) { return _rowSelectBox(r).checked; }));
  _rowSelAnchor = tr;
  _rowSelCursor = null;
  _rowSel = {
    tbody: tbody, anchor: tr, last: tr, additive: ctrl, base: base,
    // Ctrl paints the clicked row's NEW state across the drag; a plain drag selects.
    state: ctrl ? !_rowSelectBox(tr).checked : true,
    ctrl: ctrl, dragging: false, x: e.clientX, y: e.clientY, raf: 0,
    scroller: _rowSelectScroller(tbody),
  };
  if (ctrl) {
    // Ctrl+click acts on press, so Ctrl+drag starts from a settled row.
    e.preventDefault();
    _rowSelectSet(tr, _rowSel.state);
  }
});

document.addEventListener("mousemove", function (e) {
  var g = _rowSel;
  if (!g) return;
  if (!(e.buttons & 1)) { _rowSelectEnd(true); return; }
  g.x = e.clientX; g.y = e.clientY;
  var tr = _rowSelectRowOf(g, e.target);
  if (!g.dragging) {
    // A drag inside one row is left alone (it may be selecting text in a cell);
    // it becomes a row drag the moment it reaches another row.
    if (!tr || tr === g.anchor) return;
    g.dragging = true;
    document.body.classList.add("row-select-dragging");
    try { window.getSelection().removeAllRanges(); } catch (_) { /* no selection API */ }
    if (!g.additive) g.tbody.dispatchEvent(new window.CustomEvent("polaris:rowselect-clear", { bubbles: true }));
    g.raf = window.requestAnimationFrame(_rowSelectAutoScroll);
  }
  if (tr && tr !== g.last) { g.last = tr; _rowSelectApplyRange(g, tr); }
});

function _rowSelectEnd(aborted, repeat) {
  var g = _rowSel;
  if (!g) return;
  _rowSel = null;
  if (g.raf) window.cancelAnimationFrame(g.raf);
  document.body.classList.remove("row-select-dragging");
  if (aborted || g.dragging || g.ctrl) return;
  // A plain click. Text the operator just highlighted inside the row is a copy,
  // not a pick.
  var sel = window.getSelection && window.getSelection();
  if (sel && !sel.isCollapsed && g.anchor.contains(sel.anchorNode)) return;
  var cb = _rowSelectBox(g.anchor);
  if (!cb) return;
  var onlyThis = cb.checked && g.base.size === 1;
  _rowSelectClearOthers(g.tbody, g.anchor);
  // Clicking the one selected row again deselects it — a table has no empty
  // space to click to clear a single pick. Not the second click of a double
  // click, though: that opens the row, and it should stay selected.
  _rowSelectSet(g.anchor, repeat || !onlyThis);
}
document.addEventListener("mouseup", function (e) { if (e.button === 0) _rowSelectEnd(false, e.detail > 1); });
window.addEventListener("blur", function () { _rowSelectEnd(true); });

// The keyboard. Ctrl/⌘+A selects every row of the table; with a selection on
// screen, Esc clears it, ↑ / ↓ move it one row (Shift+↑ / ↓ extend it from the
// anchor, as Shift+click does), and Enter does a left click on the one
// selected row's name — its `primary` verb, Open. None of them act while
// focus is in a field, or through a dialog, a menu or a slide-over that does
// not hold the table: whatever is on top owns the keyboard.
var _rowSelCursor = null;    // the row ↑ / ↓ last moved to (Shift moves it, not the anchor)

function _rowSelectKeyTbody(e) {
  var t = e.target;
  if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return null;
  var tbody = _rowSelLastTbody;
  // No table clicked yet (or it is gone): the one table that holds a selected
  // row is the target, so one asset selected + Ctrl+A selects the page however
  // that asset came to be selected. Two tables holding picks is ambiguous.
  if (!tbody || !tbody.isConnected || !tbody.offsetParent) {
    var holding = [];
    document.querySelectorAll(ROW_SELECT_CHECKED).forEach(function (cb) {
      var tb = cb.closest("tbody");
      if (tb && tb.offsetParent && holding.indexOf(tb) < 0) holding.push(tb);
    });
    tbody = holding.length === 1 ? holding[0] : null;
  }
  if (!tbody) return null;
  var modal = document.querySelector("#modal-overlay.open, .modal-overlay.open");
  if (modal && !modal.contains(tbody)) return null;
  var panels = document.querySelectorAll(".slideover-overlay.open");
  if (panels.length && !panels[panels.length - 1].contains(tbody)) return null;
  if (document.querySelector(".row-context-menu, .btn-dropdown-menu.open")) return null;
  return tbody;
}

document.addEventListener("keydown", function (e) {
  if (e.defaultPrevented || e.altKey) return;
  var key = e.key;
  var ctrl = e.ctrlKey || e.metaKey;
  var selectAll = ctrl && !e.shiftKey && (key === "a" || key === "A");
  var arrow = !ctrl && (key === "ArrowDown" || key === "ArrowUp");
  var plain = !ctrl && !e.shiftKey;
  if (!selectAll && !arrow && !(plain && (key === "Escape" || key === "Enter"))) return;
  var tbody = _rowSelectKeyTbody(e);
  if (!tbody) return;
  var rows = _rowSelectRows(tbody);
  if (!rows.length) return;
  if (selectAll) {
    e.preventDefault();
    rows.forEach(function (tr) { _rowSelectSet(tr, true); });
    return;
  }
  // The rest act only on a selection that is on screen, so an arrow key on a
  // page whose table holds nothing still scrolls the page.
  var picked = rows.filter(function (tr) { return _rowSelectBox(tr).checked; });
  if (!picked.length) return;
  if (key === "Escape") {
    // Before the slide-over's own Escape (it skips a prevented event): the
    // first Esc drops the picks in a table inside a panel, the next closes it.
    e.preventDefault();
    _rowSelectClearOthers(tbody, null);
    _rowSelAnchor = _rowSelCursor = null;
    return;
  }
  if (key === "Enter") {
    // A focused button or link already answers Enter natively.
    if (e.target && e.target.closest && e.target.closest("a, button, summary, [role=button]")) return;
    if (picked.length !== 1) return;
    var trigger = picked[0].querySelector(".row-menu-trigger, [data-row-menu]");
    if (!trigger) return;
    e.preventDefault();
    trigger.click();
    return;
  }
  // ↑ / ↓ from the cursor (the row last moved to), else the anchor, else the
  // nearest end of the selection.
  var down = key === "ArrowDown";
  var from = [_rowSelCursor, _rowSelAnchor].filter(function (r) {
    return r && r.parentNode === tbody && rows.indexOf(r) >= 0;
  })[0] || (down ? picked[picked.length - 1] : picked[0]);
  var next = rows[rows.indexOf(from) + (down ? 1 : -1)];
  e.preventDefault();
  if (!next) return;
  if (e.shiftKey) {
    var anchor = _rowSelAnchor && _rowSelAnchor.parentNode === tbody && rows.indexOf(_rowSelAnchor) >= 0 ? _rowSelAnchor : from;
    _rowSelAnchor = anchor;
    tbody.dispatchEvent(new window.CustomEvent("polaris:rowselect-clear", { bubbles: true }));
    _rowSelectApplyRange({ tbody: tbody, anchor: anchor, state: true, additive: false }, next);
  } else {
    _rowSelectClearOthers(tbody, next);
    _rowSelectSet(next, true);
    _rowSelAnchor = next;
  }
  _rowSelCursor = next;
  _rowSelLastTbody = tbody;
  if (typeof next.scrollIntoView === "function") next.scrollIntoView({ block: "nearest" });
});

// ─── Pagination Helper ───────────────────────────────────────────────────────

/**
 * Render page-size selector + numbered page buttons into a container.
 * @param {string}   containerId   - ID of the pagination div
 * @param {number}   total         - Total number of items
 * @param {number}   pageSize      - Current page size
 * @param {number}   currentPage   - Current 1-based page number
 * @param {function} onPageChange  - Called with new page number (1-based)
 * @param {function} onSizeChange  - Called with new page size
 */
/**
 * Bound every .table-wrapper-sticky on the page to the viewport so vertical
 * scrolling happens INSIDE the wrapper: the sticky thead (styles.css) pins to
 * its top edge, and everything above — bulk bar, top pagination — stays put
 * because the page itself no longer needs to scroll. The reserve leaves room
 * for the bottom pagination row below the wrapper. max-height (not height) so
 * short result sets keep a short table. Called from renderPageControls /
 * clearPageControls (so it re-measures after every list render — the empty
 * top pagination row grows when controls first appear, shifting the wrapper's
 * document-space top) and on window resize; pages with their own pagination
 * renderer (Events) call it directly. No-op on pages without the class.
 */
function sizeStickyTableWrappers() {
  document.querySelectorAll(".table-wrapper-sticky").forEach(function (w) {
    // Inside a folder card the wrapper is sized by the card's flex column
    // (styles.css "Folder CARD"), not by the viewport.
    if (w.closest(".folder-card")) { w.style.maxHeight = ""; return; }
    var docTop = w.getBoundingClientRect().top + window.scrollY;
    var h = window.innerHeight - docTop - 72;
    w.style.maxHeight = Math.max(260, Math.round(h)) + "px";
  });
}
window.addEventListener("resize", sizeStickyTableWrappers);

/**
 * Clear both the bottom and optional top pagination containers.
 */
function clearPageControls(containerId) {
  var mainEl = document.getElementById(containerId);
  if (mainEl) mainEl.innerHTML = "";
  var topEl = document.getElementById(containerId + "-top");
  if (topEl) topEl.innerHTML = "";
  sizeStickyTableWrappers();
}

function renderPageControls(containerId, total, pageSize, currentPage, onPageChange, onSizeChange, opts) {
  var containers = [];
  var mainEl = document.getElementById(containerId);
  if (mainEl) containers.push(mainEl);
  var topEl = document.getElementById(containerId + "-top");
  if (topEl) containers.push(topEl);
  if (containers.length === 0) return;

  var totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Page number buttons
  var pageButtons = "";
  var startPage = Math.max(1, currentPage - 2);
  var endPage = Math.min(totalPages, startPage + 4);
  if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

  if (startPage > 1) {
    pageButtons += '<button class="btn btn-secondary btn-sm pg-btn" data-page="1">1</button>';
    if (startPage > 2) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
  }
  for (var p = startPage; p <= endPage; p++) {
    if (p === currentPage) {
      pageButtons += '<button class="btn btn-primary btn-sm pg-btn" data-page="' + p + '" disabled>' + p + '</button>';
    } else {
      pageButtons += '<button class="btn btn-secondary btn-sm pg-btn" data-page="' + p + '">' + p + '</button>';
    }
  }
  if (endPage < totalPages) {
    if (endPage < totalPages - 1) pageButtons += '<span style="color:var(--color-text-tertiary)">...</span>';
    pageButtons += '<button class="btn btn-secondary btn-sm pg-btn" data-page="' + totalPages + '">' + totalPages + '</button>';
  }

  var navHtml =
    '<button class="btn btn-secondary btn-sm pg-prev" ' + (currentPage <= 1 ? 'disabled' : '') + '>&laquo; Prev</button>' +
    pageButtons +
    '<button class="btn btn-secondary btn-sm pg-next" ' + (currentPage >= totalPages ? 'disabled' : '') + '>Next &raquo;</button>' +
    // nowrap: at narrow widths this label would otherwise break between the
    // number and the word, which reads as two separate facts.
    // opts.itemLabel names what is counted ("events" on the two event logs).
    '<span style="font-size:0.82rem;color:var(--color-text-tertiary);margin-left:8px;white-space:nowrap">' + total + ' ' + ((opts && opts.itemLabel) || 'items') + '</span>';

  // Standard list-controls row: a 3-column grid keeps the page navigation
  // centered across the full width regardless of the right cluster's size.
  // Left cell empty, center = pagination, right cell = action buttons + the
  // page-size ("Show N") selector (rendered when onSizeChange is supplied).
  // Replaces the older absolute-positioned action-button cluster. Documented
  // in polaris-ui-canon → "Paginated list controls row".
  var pageSizes = (opts && opts.pageSizes) || [15, 25, 50, 100];
  var hasTop = !!topEl; // render the size selector only once (top row when present)
  // opts.topNav === false: the top row carries only the right cluster (action
  // buttons + "Show N") and no page navigation — the page buttons stay in the
  // bottom row. Implied when the -top row sits in a .table-head-row, where it
  // shares a line with the tab strip (Assets, Automations, IPAM).
  var topNav = !(opts && opts.topNav === false) &&
    !(topEl && topEl.closest && topEl.closest(".table-head-row"));

  containers.forEach(function (container) {
    if (container === topEl && !topNav) {
      container.style.display = "flex";
      container.style.margin = "";
      container.style.gridTemplateColumns = "";
      container.innerHTML =
        '<div class="pg-right" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end"></div>';
      _fillPageControlsRight(container.querySelector(".pg-right"), true);
      return;
    }
    container.style.display = "grid";
    // Breathing room against the table: the top row sits above the wrapper and
    // the bottom row below it, and flush against the border both read as table
    // chrome rather than as controls FOR the table.
    container.style.margin = (container === topEl) ? "0 0 10px" : "10px 0 0";
    // minmax(0,1fr) rather than 1fr: a 1fr track refuses to shrink below its
    // content, so on a narrow table the side columns push into the centered
    // nav instead of letting it wrap.
    container.style.gridTemplateColumns = "minmax(0,1fr) auto minmax(0,1fr)";
    container.style.alignItems = "center";
    container.style.gap = "12px";
    container.style.position = "";
    container.innerHTML =
      '<span></span>' +
      '<div class="pg-center" style="display:flex;align-items:center;gap:12px;justify-content:center;flex-wrap:wrap">' + navHtml + '</div>' +
      '<div class="pg-right" style="display:flex;align-items:center;gap:6px;justify-self:end;flex-wrap:wrap;justify-content:flex-end"></div>';

    container.querySelector('.pg-prev').addEventListener("click", function () {
      if (currentPage > 1) onPageChange(currentPage - 1);
    });
    container.querySelector('.pg-next').addEventListener("click", function () {
      if (currentPage < totalPages) onPageChange(currentPage + 1);
    });
    container.querySelectorAll(".pg-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        onPageChange(parseInt(btn.getAttribute("data-page"), 10));
      });
    });

    // When the top row lives in a tab row (topNav off) it already carries the
    // action buttons, so the bottom row is page navigation only — Refresh /
    // Clear Filters are not repeated at the foot of the page.
    _fillPageControlsRight(container.querySelector('.pg-right'), !hasTop || container === topEl, topNav || container === topEl);
  });
  sizeStickyTableWrappers();

  function _fillPageControlsRight(right, withSize, withButtons) {
    if (withButtons !== false && opts && opts.actionButtons && opts.actionButtons.length) {
      opts.actionButtons.forEach(function (cfg) {
        // { el }: a page's OWN button (its primary Add), moved into the row at
        // this position on every render — its listeners, menu and permission
        // gating (display set by the page) travel with the element. Only in a
        // tab row (.table-head-row); elsewhere the button stays where the page
        // put it (the standalone blocks / subnets pages).
        if (cfg.el) {
          if (right.closest(".table-head-row")) right.appendChild(cfg.el);
          return;
        }
        var btn = document.createElement("button");
        btn.className = "btn btn-secondary btn-sm" + (cfg.className ? " " + cfg.className : "");
        btn.textContent = cfg.label;
        // Optional: a button whose label changes with context (Assets' Clear
        // Filters / Reset Filter) says which one it is here.
        if (cfg.title) btn.title = cfg.title;
        btn.addEventListener("click", cfg.onClick);
        right.appendChild(btn);
      });
    }
    if (typeof onSizeChange === "function" && withSize) {
      // No "Show" label: each option says what it is ("25 / page").
      var sel = document.createElement("select");
      sel.className = "page-size-select";
      sel.style.width = "auto";
      sel.setAttribute("aria-label", "Rows per page");
      pageSizes.forEach(function (s) {
        var o = document.createElement("option");
        o.value = String(s); o.textContent = s + " / page";
        if (s === pageSize) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { onSizeChange(parseInt(sel.value, 10) || pageSize); });
      right.appendChild(sel);
    }
  }
}

// Folder tabs + the folder card's scroll fades live in public/js/folder-tabs.js
// (loaded on every page with a .table-head-row or a .folder-card, including the
// /dash wallboard, which does not load this file).

// ─── Helpers ──────────────────────────────────────────────────────────────────

// escapeHtml is the canonical global from api.js (loaded first on every page).

function formatDate(dateStr) {
  if (!dateStr) return "-";
  var d = new Date(dateStr);
  var base = { month: "short", day: "numeric", year: "numeric" };
  try {
    return d.toLocaleDateString(undefined, Object.assign({}, base, timeZoneOpts()));
  } catch (_) {
    // A stored zone this browser's ICU can't apply — the browser's own beats
    // rendering nothing.
    return d.toLocaleDateString(undefined, base);
  }
}

// Compact device-uptime duration: "42d 6h" / "6h 12m" / "12m" / "<1m".
// Shows the two most-significant non-zero units. Mirror of the server-side
// formatUptime in src/utils/uptime.ts. Returns "—" for null/invalid input.
function formatUptime(seconds) {
  if (seconds == null || !isFinite(seconds) || seconds < 0) return "—";
  var s = Math.floor(seconds);
  if (s < 60) return "<1m";
  var days = Math.floor(s / 86400);
  var hours = Math.floor((s % 86400) / 3600);
  var mins = Math.floor((s % 3600) / 60);
  if (days > 0) return hours > 0 ? days + "d " + hours + "h" : days + "d";
  if (hours > 0) return mins > 0 ? hours + "h " + mins + "m" : hours + "h";
  return mins + "m";
}

function statusBadge(status) {
  return '<span class="badge badge-' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>';
}

// ─── Subnet utilization cell ─────────────────────────────────────────────────
// How full a network is, as the canonical utilization bar (.util-row /
// -bar-track / -bar-fill) plus a right-aligned figure. Lives here rather than
// in subnets.js because three surfaces on three pages draw the same reading and
// must not drift: the IPAM → Networks list (ipam.html + the legacy
// subnets.html), the block drill-in panel (block-panel.js on ipam.html +
// blocks.html), and — by sharing its colour bands — the Block utilization
// dashboard widget. app.js is the only script all of those load.
//
// The bands are the Block utilization widget's verbatim (widgets/
// blockUtilization.js): > 75% red, > 50% amber, otherwise the accent blue. A
// network reading amber on the dashboard and blue on the list reads as a bug in
// one of the two.
function subnetUtilBarColor(pct) {
  return pct > 75 ? "#ff1744" : pct > 50 ? "#ffd600" : "#4fc3f7";
}

/**
 * @param {number|null} pct    utilizationPercent off the subnet row (null = no denominator)
 * @param {number|null} used   active reservations holding an address
 * @param {number|null} usable usable host addresses in the CIDR
 */
// `title` (optional) replaces the hover text — the IP Blocks list uses the
// same bar for address space carved into networks, not hosts reserved.
function subnetUtilCellHTML(pct, used, usable, title) {
  // No denominator (IPv6, or a CIDR the server could not measure) is a muted
  // em dash, never a 0%-wide bar — an empty bar is a positive claim that the
  // network is empty.
  if (pct == null) return '<span style="color:var(--color-text-tertiary)">&mdash;</span>';
  // A reservation sitting on the network or broadcast address can push the
  // numerator past the usable count; the bar clamps, the tooltip doesn't.
  var w = Math.max(0, Math.min(100, pct));
  if (!title) title = used != null && usable != null
    ? used + " of " + usable + " usable addresses reserved (" + pct + "%)"
    : pct + "% of usable addresses reserved";
  // A /24 with one address taken is 0.4%, and "0%" beside a bar reads as an
  // empty network — which is exactly the claim the em-dash rule above exists to
  // avoid. Anything occupied but under half a percent says "<1%" instead.
  var label = pct > 0 && Math.round(pct) === 0 ? "&lt;1%" : Math.round(pct) + "%";
  return '<div class="util-row" title="' + escapeHtml(title) + '">' +
    '<div class="util-bar-track"><div class="util-bar-fill" style="width:' + w + '%;background:' + subnetUtilBarColor(w) + '"></div></div>' +
    '<span style="width:34px;flex:0 0 auto;text-align:right;font-size:0.78rem;color:var(--color-text-secondary)">' + label + '</span>' +
  '</div>';
}

// Trimmed value of an input by id — THE copy (was five identical top-level
// copies across page scripts, shadowing each other on co-loaded pages).
function val(id) { return document.getElementById(id).value.trim(); }
