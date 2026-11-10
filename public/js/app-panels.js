/**
 * public/js/app-panels.js — Slide-overs on any page: revealOverlay, the on-demand panel script bundles
 * and PolarisPanels, the slide-over stacking rule, buildSlideover, the panel
 * deep links, the floating AI assistant's boot, and slide-over resize.
 *
 * Part of the app.js shell (CQ-F051): plain browser scripts sharing page
 * globals, loaded on every app page in APP_FILES order (app.js first,
 * app-boot.js last). See tests/unit/appSplit.test.ts.
 */

/**
 * Reveal an overlay that animates in: add `.open` on the next animation frame
 * so the transition has a start state, with a timeout floor because
 * requestAnimationFrame does NOT fire in a hidden tab — a panel opened in a
 * background tab would otherwise be built and never shown, staying invisible
 * until the tab is next looked at. Idempotent: whichever fires first wins.
 *
 * `after` runs once, immediately after the class lands (focus, sizing).
 */
function revealOverlay(el, after) {
  if (!el) return;
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    el.classList.add("open");
    if (typeof after === "function") after();
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);
}
if (typeof window !== "undefined") window.revealOverlay = revealOverlay;

// ─── Slide-overs from any page ──────────────────────────────────────────────
//
// The asset, network (IP) and block slide-overs each live in their own script
// (assets.js, ip-panel.js, block-panel.js) and used to be reachable only on
// the pages that load them; everywhere else a click-through navigated to the
// panel's home page with a #view= hash and the operator lost their place.
// PolarisPanels loads a panel's scripts on demand — in order, once, skipping
// any the page already carries — then opens it in place, so every page can
// pivot into any record without paying for assets.js up front. CSP permits
// it: the files are same-origin, which `script-src 'self'` covers regardless
// of how the <script> element reaches the document.
//
// Each bundle is the SAME ordered list the panel's home page loads statically
// (index.html / map.html / ipam.html carry the commented versions) — keep
// them in step when a panel grows a dependency. A file's DOMContentLoaded
// page-init never runs when it lands late, which is exactly the off-page case
// those handlers already guard for.
var _PANEL_SCRIPT_BUNDLES = {
  asset: [
    "/js/vendor/jspdf.umd.min.js",
    "/js/vendor/jspdf.plugin.autotable.min.js",
    "/js/vendor/html-to-image.min.js",
    "/js/table-sf.js",
    "/js/favorites.js",
    "/js/polling-methods.js",
    "/js/integrations.js",
    "/js/integrations-feature-tabs.js",
    "/js/integrations-monitoring.js",
    "/js/integrations-forms.js",
    "/js/integrations-generic-api.js",
    "/js/integrations-query.js",
    "/js/temp-unit.js",
    "/js/chart-severity.js",
    "/js/monitor-states.js",
    "/js/monitor-down-after.js",
    "/js/asset-merge-modal.js",
    "/js/chart-shared.js",
    "/js/asset-shared.js",
    "/js/assets.js",
    "/js/condition-builder.js",
    "/js/automations-address-book.js",
    "/js/recipient-picker.js",
    "/js/automations-wizard.js",
    "/js/automations-portability.js",
    "/js/recurrence-editor.js",
    "/js/assets-maintenance.js",
  ],
  network: ["/js/table-sf.js", "/js/placeholder-mac.js", "/js/reservation-notes.js", "/js/ip-panel.js"],
  block: ["/js/block-panel.js"],
};
// The global each bundle must leave behind — also the "already here" test, so
// a page that loads a panel statically never fetches a byte.
var _PANEL_OPENERS = { asset: "openViewModal", network: "openIpPanel", block: "openBlockPanel" };
var _panelScriptLoads = {};   // src → Promise; a script is requested once per page

function _loadPanelScript(src) {
  if (_panelScriptLoads[src]) return _panelScriptLoads[src];
  if (document.querySelector('script[src="' + src + '"]')) {
    _panelScriptLoads[src] = Promise.resolve();
    return _panelScriptLoads[src];
  }
  _panelScriptLoads[src] = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = src;
    s.async = false;
    s.onload = function () { resolve(); };
    s.onerror = function () {
      delete _panelScriptLoads[src];   // let a later open retry after a blip
      reject(new Error("Failed to load " + src));
    };
    document.body.appendChild(s);
  });
  return _panelScriptLoads[src];
}

// Resolves once `kind`'s opener is callable. Sequential on purpose: the files
// declare globals the next one reads at evaluation time.
function ensurePanelScripts(kind) {
  var opener = _PANEL_OPENERS[kind];
  var list = _PANEL_SCRIPT_BUNDLES[kind];
  if (!opener || !list) return Promise.reject(new Error("Unknown panel: " + kind));
  if (typeof window[opener] === "function") return Promise.resolve();
  return list.reduce(function (p, src) {
    return p.then(function () { return _loadPanelScript(src); });
  }, Promise.resolve()).then(function () {
    if (typeof window[opener] !== "function") throw new Error(opener + " is not defined after loading the " + kind + " panel");
  });
}

// The components of a GROUPED alert (business rule 75), in a modal — the row
// menu verb on the Active Alerts widget and the asset Alerts tab. Loaded on
// first use, like a panel bundle: two surfaces on different pages open it and
// neither page should carry it for the operators who never click it.
// `alertOrId` is a row already holding `members` (no fetch) or an alert id.
function openAlertMembers(alertOrId, opts) {
  return _loadPanelScript("/js/alert-members-modal.js").then(function () {
    return window.PolarisAlertMembers.open(alertOrId, opts);
  }).catch(function (err) {
    if (typeof showToast === "function") showToast((err && err.message) || "Couldn't open the alert's components", "error");
  });
}

// ─── The floating AI assistant (business rule 95) ──────────────────────────
// Desktop app pages only (the ones with a #sidebar — not login, the ack page,
// the Dash wallboard or the phone SPA). Nothing is fetched for a role without
// `assistant` read, and nothing is loaded until GET /assistant/status says an
// llm integration is enabled — an install without one pays one small request
// per page and never sees a button. The CSS and two scripts come in through
// the same once-per-page loader the slide-over bundles use.
//
// The widget's files are linked statically by every app page (before app.js)
// and drawn from cache before first paint (PolarisAssistant.earlyMount, at
// the end of this file) so a page change does not blink it. This is the
// authoritative check that follows: it confirms or removes what was drawn.
function _bootAssistant() {
  if (!document.getElementById("sidebar")) return;
  var drop = function () { if (window.PolarisAssistant) window.PolarisAssistant.unmount(); };
  if (typeof permAtLeast !== "function" || !permAtLeast("assistant", "read")) { drop(); return; }
  if (!window.api || !api.assistant) return;
  api.assistant.status().then(function (status) {
    if (!status || !status.enabled) { drop(); return; }
    if (!document.querySelector('link[href="/css/assistant.css"]')) {
      var link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "/css/assistant.css";
      document.head.appendChild(link);
    }
    return _loadPanelScript("/js/assistant-markdown.js")
      .then(function () { return _loadPanelScript("/js/assistant.js"); })
      .then(function () { if (window.PolarisAssistant) window.PolarisAssistant.mount(status); });
  }).catch(function () { /* the assistant is optional; never break a page over it */ });
}

// When the scripts cannot be loaded (a proxy that blocks a file, a half-
// deployed update) the deep link is still the right answer — it is what every
// caller did before the panel could open in place.
function _panelFallbackNavigate(href) {
  window.location.href = href;
  return false;
}

// Deep-link hash the network slide-over is reachable by on /ipam.html. Two
// forms because two readers exist: subnets.js applyHashFilters takes
// subnet= (+ focusReservation=), processSearchHash takes ip=<sid>@<ip>.
function networkPanelHash(subnetId, opts) {
  var o = opts || {};
  if (o.focusIp) return "#tab=networks&ip=" + encodeURIComponent(subnetId) + "@" + encodeURIComponent(o.focusIp);
  return "#tab=networks&subnet=" + encodeURIComponent(subnetId) +
    (o.focusReservationId ? "&focusReservation=" + encodeURIComponent(o.focusReservationId) : "");
}

var PolarisPanels = {
  ensure: ensurePanelScripts,

  // Asset details (openViewModal in assets.js). opts.tab lands on a tab.
  // Resolves true when the panel opened in place, false when it could not
  // (the Dash wallboard has no session, so a panel there would only 401 —
  // the click stays a no-op, as it always was).
  openAsset: function (id, opts) {
    if (!id || window.POLARIS_DASH_LOCAL) return Promise.resolve(false);
    var href = "/assets.html#view=asset:" + encodeURIComponent(id) +
      (opts && opts.tab ? "&tab=" + encodeURIComponent(opts.tab) : "");
    return ensurePanelScripts("asset").then(function () {
      window.openViewModal(id, opts || undefined);
      return true;
    }, function () { return _panelFallbackNavigate(href); });
  },

  // Network slide-over (openIpPanel in ip-panel.js) — the reservation table
  // of one subnet. opts: focusIp / focusReservationId scroll to a row;
  // subnetCidr lets the panel land on the right page of a large subnet
  // without a second fetch, and is looked up here when focusIp is given
  // without it.
  openNetwork: function (subnetId, opts) {
    if (!subnetId || window.POLARIS_DASH_LOCAL) return Promise.resolve(false);
    var o = Object.assign({}, opts || {});
    var href = "/ipam.html" + networkPanelHash(subnetId, o);
    return ensurePanelScripts("network").then(function () {
      var cidrP = (o.focusIp && !o.subnetCidr && typeof api !== "undefined" && api.subnets && typeof api.subnets.get === "function")
        ? api.subnets.get(subnetId).then(function (s) { if (s && s.cidr) o.subnetCidr = s.cidr; }, function () {})
        : Promise.resolve();
      return cidrP.then(function () {
        window.openIpPanel(subnetId, Object.keys(o).length ? o : undefined);
        return true;
      });
    }, function () { return _panelFallbackNavigate(href); });
  },

  // Block drill-in (openBlockPanel in block-panel.js) — the networks inside
  // one block.
  openBlock: function (blockId) {
    if (!blockId || window.POLARIS_DASH_LOCAL) return Promise.resolve(false);
    var href = "/ipam.html#tab=blocks&view=block:" + encodeURIComponent(blockId);
    return ensurePanelScripts("block").then(function () {
      window.openBlockPanel(blockId);
      return true;
    }, function () { return _panelFallbackNavigate(href); });
  },
};
if (typeof window !== "undefined") window.PolarisPanels = PolarisPanels;

// True when `overlayEl` is the slide-over the operator is looking at: it is
// open, no other slide-over was opened after it (every .slideover-overlay is
// z-index 1050, so the later one in the DOM paints on top — see
// raiseSlideover; that is why no slide-over may carry a z-index of its own),
// and no modal is stacked over it. Escape and keyboard
// chords gate on this, so a key meant for the top panel never closes the one
// underneath.
function isTopmostSlideover(overlayEl) {
  if (!overlayEl || !overlayEl.classList || !overlayEl.classList.contains("open")) return false;
  var mo = document.getElementById("modal-overlay");
  if (mo && mo.classList.contains("open")) return false;
  var open = document.querySelectorAll(".slideover-overlay.open");
  return open.length > 0 && open[open.length - 1] === overlayEl;
}
if (typeof window !== "undefined") window.isTopmostSlideover = isTopmostSlideover;

// Escape closes `overlayEl`'s slide-over when it is the topmost layer — the
// one Escape handler every slide-over uses. Exactly one open slide-over is
// topmost when the key lands, so exactly one handler matches; it then stops
// the event, because once it has closed, the panel beneath IS topmost and a
// handler registered after this one would close that too — one keypress,
// two panels gone. Handlers registered earlier already ran and declined.
//
// `overlayEl` may also be a FUNCTION returning the overlay, for a panel that
// re-renders its overlay element on every open (the Users page's role panel):
// wired once, it finds whichever element is current when the key lands,
// instead of leaving a listener behind per open.
function wireSlideoverEscape(overlayEl, close) {
  if (!overlayEl || typeof close !== "function") return;
  var current = typeof overlayEl === "function" ? overlayEl : function () { return overlayEl; };
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (!isTopmostSlideover(current())) return;
    e.stopImmediatePropagation();
    close();
  });
}
if (typeof window !== "undefined") window.wireSlideoverEscape = wireSlideoverEscape;

// Move a CLOSED slide-over overlay to the end of <body> before it opens, so it
// paints over every slide-over already open. The overlays are created once and
// kept, so DOM order is first-open order, not open order: a network panel
// opened early in a session and then re-opened from inside the asset panel
// would otherwise slide in BEHIND the panel that asked for it. A no-op for an
// open overlay (a panel pivoting in place must not be re-inserted under its
// own nested drilldowns) and for one with no slide-over after it.
function raiseSlideover(overlayEl) {
  if (!overlayEl || overlayEl.parentNode !== document.body) return;
  if (!overlayEl.classList.contains("slideover-overlay") || overlayEl.classList.contains("open")) return;
  var later = overlayEl.nextElementSibling;
  while (later) {
    if (later.classList && later.classList.contains("slideover-overlay")) { document.body.appendChild(overlayEl); return; }
    later = later.nextElementSibling;
  }
}
if (typeof window !== "undefined") window.raiseSlideover = raiseSlideover;

// Build a slide-over's skeleton, append it to <body> and wire it — the one
// factory every JS-built slide-over uses (CQ-F025). It produces:
//
//   div.slideover-overlay#<prefix>-overlay > div.slideover#<id> >
//     .slideover-resize-handle
//     .slideover-header > .slideover-header-top (h3 + close button.btn-icon),
//                         .slideover-meta, then opts.headerHTML
//     .slideover-body
//     .slideover-footer (only when opts.footer is given)
//
// and wires backdrop click (target equality), the close button, Escape
// (wireSlideoverEscape — topmost only) and the resize bar/grip
// (initSlideoverResize, when opts.resizeKey is set). Callers keep their own
// "already built?" check, so a panel stays lazily built on first open.
//
// opts:
//   id           the .slideover's id (required)
//   prefix       base for every other id (default: id) — overlay <prefix>-overlay,
//                title -title, close -close, meta -meta, body -body, footer -footer;
//                pass an explicit xxxId to override one, or null to omit it
//   overlayClass extra class on the overlay (e.g. "slideover-nested")
//   panelStyle   inline style on the .slideover
//   dialog       true → role="dialog" aria-labelledby=<titleId> tabindex="-1"
//   title        the <h3>'s inner HTML (the caller escapes it)
//   titleLead    true → wrap the <h3> in .slideover-header-lead
//   closeTitle   the close button's title (default "Close"; null omits it)
//   closeLabel   the close button's aria-label (default none)
//   meta         false omits the .slideover-meta row (default true)
//   headerHTML   markup after the meta row, inside .slideover-header
//   bodyHTML / bodyStyle   the body's initial content / inline style
//   footer       true → an empty .slideover-footer; a string → its inner HTML
//   close        what backdrop / close button / Escape call (default: remove
//                .open, then opts.onClose)
//   onClose      cleanup after the default close
//   resizeKey    localStorage key for initSlideoverResize ("polaris.panel.width.<name>")
//
// Returns { overlay, panel, body, footer, open(after), close() }: open raises
// the overlay over any open slide-over (DOM order is stacking order) and
// reveals it; `after` runs once it is revealed.
function buildSlideover(opts) {
  opts = opts || {};
  var prefix = opts.prefix || opts.id;
  var idOf = function (key, suffix) {
    var v = opts[key];
    if (v === null) return null;
    return v !== undefined ? v : prefix + "-" + suffix;
  };
  var attr = function (name, value) {
    return value == null ? "" : " " + name + '="' + String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"';
  };
  var titleId = idOf("titleId", "title");
  var bodyId = idOf("bodyId", "body");
  var footerId = idOf("footerId", "footer");
  var closeId = idOf("closeId", "close");

  var overlay = document.createElement("div");
  overlay.id = idOf("overlayId", "overlay");
  overlay.className = "slideover-overlay" + (opts.overlayClass ? " " + opts.overlayClass : "");
  var h3 = "<h3" + attr("id", titleId) + ">" + (opts.title || "") + "</h3>";
  overlay.innerHTML =
    '<div class="slideover"' + attr("id", opts.id) +
      (opts.dialog ? ' role="dialog"' + attr("aria-labelledby", titleId) + ' tabindex="-1"' : "") +
      attr("style", opts.panelStyle) + ">" +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          (opts.titleLead ? '<div class="slideover-header-lead">' + h3 + "</div>" : h3) +
          '<button class="btn-icon"' + attr("id", closeId) +
            attr("title", opts.closeTitle === undefined ? "Close" : opts.closeTitle) +
            attr("aria-label", opts.closeLabel) + ">&times;</button>" +
        "</div>" +
        (opts.meta === false ? "" : '<div class="slideover-meta"' + attr("id", idOf("metaId", "meta")) + "></div>") +
        (opts.headerHTML || "") +
      "</div>" +
      '<div class="slideover-body"' + attr("id", bodyId) + attr("style", opts.bodyStyle) + ">" + (opts.bodyHTML || "") + "</div>" +
      (opts.footer
        ? '<div class="slideover-footer"' + attr("id", footerId) + ">" + (typeof opts.footer === "string" ? opts.footer : "") + "</div>"
        : "") +
    "</div>";
  document.body.appendChild(overlay);

  var panel = overlay.firstChild;
  var close = typeof opts.close === "function" ? opts.close : function () {
    overlay.classList.remove("open");
    if (typeof opts.onClose === "function") opts.onClose();
  };
  overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
  var closeBtn = panel.querySelector(".slideover-header-top > .btn-icon");
  if (closeBtn) closeBtn.addEventListener("click", function () { close(); });
  if (typeof wireSlideoverEscape === "function") wireSlideoverEscape(overlay, close);
  if (opts.resizeKey && typeof initSlideoverResize === "function") initSlideoverResize(panel, opts.resizeKey);

  return {
    overlay: overlay,
    panel: panel,
    body: panel.querySelector(".slideover-body"),
    footer: panel.querySelector(".slideover-footer"),
    open: function (after) {
      if (typeof raiseSlideover === "function") raiseSlideover(overlay);
      revealOverlay(overlay, after);
    },
    close: close,
  };
}
if (typeof window !== "undefined") window.buildSlideover = buildSlideover;

// Any <a href="/assets.html#view=asset:<id>[&tab=<key>]"> — the deep link the
// dashboard widgets, the Events page's conflict cards and the alert email all
// emit — opens the asset panel in place on a plain left click. Modifier and
// middle clicks keep the href so "open in a new tab" still works, an explicit
// target does too, and a listener that already handled the click (the Down
// Assets widget's acknowledge menu calls preventDefault) is left alone.
// Guarded against app.js being evaluated twice.
function _wirePanelDeepLinks() {
  if (typeof document === "undefined" || window.__polarisPanelLinksWired) return;
  window.__polarisPanelLinksWired = true;
  document.addEventListener("click", function (e) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href^="/assets.html#view=asset:"]') : null;
    if (!a) return;
    var tgt = a.getAttribute("target");
    if (tgt && tgt !== "_self") return;
    var m = /#view=asset:([^&]+)(?:&tab=([^&]+))?/.exec(a.getAttribute("href") || "");
    if (!m) return;
    e.preventDefault();
    PolarisPanels.openAsset(decodeURIComponent(m[1]), m[2] ? { tab: decodeURIComponent(m[2]) } : undefined);
  });
}
_wirePanelDeepLinks();

// ─── Slide-over resize ────────────────────────────────────────────────────────

function initSlideoverResize(panelEl, storageKey) {
  var handle = panelEl.querySelector(".slideover-resize-handle");
  if (!handle) return;

  var stored = 0;
  try { stored = parseInt(localStorage.getItem(storageKey) || "0", 10); } catch (_) {}
  if (stored >= 380) panelEl.style.width = stored + "px";

  var minW = 380;
  function maxW() { return Math.round(window.innerWidth * 0.9); }

  // The grip: a chip centred on the bar, the slide-over's twin of the Device
  // Map topology pane's edge arrow. Dragging it resizes like the bar; a click
  // without a drag toggles the panel between its own width and the widest it
  // goes, and back. The expanded width is not saved — the stored width stays
  // the operator's dragged one.
  var grip = handle.querySelector(".slideover-resize-grip");
  if (!grip) {
    grip = document.createElement("button");
    grip.type = "button";
    grip.className = "slideover-resize-grip";
    grip.innerHTML = '<span class="slideover-resize-grip-arrow" aria-hidden="true"></span>';
    handle.appendChild(grip);
  }
  function syncGrip() {
    var expanded = panelEl.classList.contains("slideover-expanded");
    grip.title = expanded ? "Restore width (drag to resize)" : "Widen (drag to resize)";
    grip.setAttribute("aria-label", expanded ? "Restore panel width" : "Widen panel");
    grip.setAttribute("aria-pressed", expanded ? "true" : "false");
  }
  syncGrip();

  var moved = false;
  grip.addEventListener("click", function (e) {
    e.stopPropagation();
    if (moved) return;   // the end of a drag, not a click
    if (panelEl.classList.contains("slideover-expanded")) {
      panelEl.classList.remove("slideover-expanded");
      panelEl.style.width = panelEl.dataset.widthBeforeExpand || "";
    } else {
      panelEl.dataset.widthBeforeExpand = panelEl.style.width || "";
      panelEl.classList.add("slideover-expanded");
      panelEl.style.width = maxW() + "px";
    }
    syncGrip();
  });

  handle.addEventListener("mousedown", function (e) {
    e.preventDefault();
    handle.classList.add("dragging");
    var panelRight = panelEl.getBoundingClientRect().right;
    var startX = e.clientX;
    var limit = maxW();
    moved = false;

    function onMove(e) {
      if (Math.abs(e.clientX - startX) > 3) moved = true;
      if (!moved) return;
      var w = Math.max(minW, Math.min(limit, Math.round(panelRight - e.clientX)));
      panelEl.style.width = w + "px";
    }

    function onUp(e) {
      handle.classList.remove("dragging");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      if (!moved) return;
      // A drag ends the expanded state: the panel is now the width dragged to.
      panelEl.classList.remove("slideover-expanded");
      syncGrip();
      var w = Math.max(minW, Math.min(limit, Math.round(panelRight - e.clientX)));
      try { localStorage.setItem(storageKey, w); } catch (_) {}
      // Grace period. A fast drag outruns the repaint, so the button often
      // comes up over the dimmed backdrop rather than the bar. The browser
      // then sends a click to the nearest element under both the press and the
      // release — the overlay — and every slide-over closes on an overlay
      // click. Swallow clicks for a moment after a drag so letting go never
      // closes the panel.
      var until = Date.now() + 400;
      function swallow(ev) {
        if (Date.now() > until) { window.removeEventListener("click", swallow, true); return; }
        ev.stopPropagation();
        ev.preventDefault();
        window.removeEventListener("click", swallow, true);
      }
      window.addEventListener("click", swallow, true);
      setTimeout(function () { window.removeEventListener("click", swallow, true); }, 450);
    }

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
