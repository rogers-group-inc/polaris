/**
 * public/js/app-modals.js — Modals: tracked PDF export, the shared #modal-overlay (openModal /
 * closeModal) with its focus trap, read-only lock and stepped-footer keys,
 * the panel lock, modal tabs and form parts, the location-code diagram, the
 * standard integration dialog, the row context menu, the stacked overlay and
 * the confirm / choice / prompt / form dialogs.
 *
 * Part of the app.js shell (CQ-F051): plain browser scripts sharing page
 * globals, loaded on every app page in APP_FILES order (app.js first,
 * app-boot.js last). See tests/unit/appSplit.test.ts.
 */

// ─── Tracked PDF Export ─────────────────────────────────────────────────────
// Wraps a PDF export workflow in the query status tracker so it appears in the
// sidebar with an abort button.  `fn` receives an AbortSignal and must throw or
// return early when the signal fires.

async function trackedPdfExport(label, fn) {
  var controller = new AbortController();
  var qid = _registerQuery(label, controller);
  try {
    await fn(controller.signal);
  } catch (err) {
    if (err.name === "AbortError" || controller.signal.aborted) {
      showToast("PDF export aborted", "error");
    } else {
      console.error("Export error:", err);
      showToast("Export failed: " + (err.message || "Unknown error"), "error");
    }
  } finally {
    _unregisterQuery(qid);
  }
}

// ─── CSV export + Toasts ────────────────────────────────────────────────────
// downloadCsv/_csvRow and getToastContainer/showToast are canonical in
// api.js (loaded before this file on every page, incl. dash/mobile) since
// the 2026-08 audit — the dash-boot forks are gone.


// ─── Modal ────────────────────────────────────────────────────────────────────

var _modalDrag = { active: false, startX: 0, startY: 0, offsetX: 0, offsetY: 0 };

// The off-click close-button flash (flashModalCloseBtn and its escalation
// state) lives in public/js/panel-lock.js, loaded before this file.

// ─── Modal accessibility (focus trap + restore + Escape) ──────────────────────
// Shared helpers so every openModal / showConfirm caller gets dialog semantics,
// a Tab focus-trap, Escape-to-close, and focus restoration for free.
function _focusableIn(container) {
  var sel = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.prototype.slice.call(container.querySelectorAll(sel))
    .filter(function (el) { return el.offsetParent !== null; });
}
// Trap Tab within `container`; call `onEscape` on Escape. Returns a teardown fn.
function _trapFocus(container, onEscape) {
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); onEscape(); return; }
    if (e.key !== "Tab") return;
    var f = _focusableIn(container);
    if (!f.length) { e.preventDefault(); container.focus(); return; }
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  document.addEventListener("keydown", onKey, true);
  return function () { document.removeEventListener("keydown", onKey, true); };
}
function _focusFirstIn(container) {
  var f = _focusableIn(container);
  if (f.length) f[0].focus(); else container.focus();
}
var _modalReturnFocus = null;  // element refocused when the shared modal closes
var _modalKeyTeardown = null;  // active focus-trap teardown for the shared modal
var _modalStepKeyTeardown = null; // active stepper-key teardown for the shared modal
var _modalReadOnlyTeardown = null; // active read-only lock on the shared modal (openModal options.readOnly)

/**
 * Lock the shared modal's body for VIEWING: every field is disabled, every
 * body button is hidden (styles.css → .modal.modal-readonly) except those
 * marked `data-ro-keep` (fold chevrons, View code, Export), and drags are
 * refused. A MutationObserver re-applies it to whatever the dialog renders
 * later — a wizard builds steps on entry and re-renders rows — so the lock
 * cannot be outrun by content that did not exist when the modal opened.
 * Returns the teardown; openModal / closeModal call it.
 */
function _lockModalReadOnly(modal) {
  var body = modal.querySelector(".modal-body");
  modal.classList.add("modal-readonly");
  function lock(root) {
    if (!root || !root.querySelectorAll) return;
    var fields = root.matches && root.matches("input, select, textarea") ? [root] : [];
    root.querySelectorAll("input, select, textarea").forEach(function (el) { fields.push(el); });
    fields.forEach(function (el) {
      // Only when it is not already: re-setting an attribute queues another
      // mutation record, and the observer below would chase its own tail.
      if (el.hasAttribute("data-ro-keep") || el.disabled) return;
      el.disabled = true;
    });
    root.querySelectorAll('[contenteditable]:not([contenteditable="false"])').forEach(function (el) { el.setAttribute("contenteditable", "false"); });
    var drags = root.getAttribute && root.getAttribute("draggable") === "true" ? [root] : [];
    root.querySelectorAll('[draggable="true"]').forEach(function (el) { drags.push(el); });
    drags.forEach(function (el) { el.setAttribute("draggable", "false"); });
  }
  lock(body);
  // Added nodes AND re-enabled fields: the dialog's own sync code flips
  // `.disabled` by property as it reacts to state (a wizard toggles a checkbox
  // on when its trigger qualifies), which removes the attribute.
  var obs = new MutationObserver(function (records) {
    records.forEach(function (r) {
      if (r.type === "attributes") { lock(r.target); return; }
      r.addedNodes.forEach(function (n) { if (n.nodeType === 1) lock(n); });
    });
  });
  obs.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "draggable"] });
  function refuse(e) { e.preventDefault(); e.stopPropagation(); }
  body.addEventListener("dragstart", refuse, true);
  body.addEventListener("drop", refuse, true);
  return function () {
    obs.disconnect();
    body.removeEventListener("dragstart", refuse, true);
    body.removeEventListener("drop", refuse, true);
    modal.classList.remove("modal-readonly");
  };
}

// ─── Stepped-modal keyboard navigation ────────────────────────────────────────
//
// Every wizard footer is `Cancel · ← Back · Next → · Save`, with only the
// buttons that apply to the current step on screen (each toggled through an
// inline `style.display` by the wizard's own syncFooter). `wireModalStepKeys`
// puts the keyboard on that footer so a six-step form can be walked without
// reaching for the mouse:
//
//   → / ←   click Next / Back, whenever that button is showing
//   Enter   Next while Next is showing; the submit button only once it is not
//
// Enter is deliberately NOT "submit the dialog". On a stepped form the primary
// button under the operator's eye is Next, so Enter on step 2 has to mean step
// 3 — an Enter that instead saved a form the operator hadn't finished would
// create half-built automations, and the wizards keep every later step's
// validation for when it is reached.
//
// Registered against openModal's ONE shared #modal-overlay, which is why the
// teardown hangs off the same two places `_modalKeyTeardown` does: a wizard
// never has to remember to unwire on close, and the next modal to use that
// overlay — a plain form with a single Save — cannot inherit these keys.
function wireModalStepKeys(opts) {
  if (_modalStepKeyTeardown) { _modalStepKeyTeardown(); _modalStepKeyTeardown = null; }
  function onKey(e) {
    if (e.key !== "Enter" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    // A field-level handler that already acted owns the key: both wizard
    // typeaheads preventDefault on Enter while a suggestion is highlighted.
    if (e.defaultPrevented || e.repeat) return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    // Only keys typed inside the shared modal. A dialog stacked OVER the
    // wizard (the code editor, the address book, a showConfirm) builds its own
    // overlay, so this leaves that layer's Enter alone.
    var t = e.target;
    if (!t || !t.closest || !t.closest("#modal-overlay")) return;
    var tag = (t.tagName || "").toUpperCase();
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      // Arrows belong to the caret in a text field and to the options of a
      // select; the footer only hears them from elsewhere in the dialog.
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable) return;
      var move = _stepKeyBtn(e.key === "ArrowRight" ? opts.next : opts.back);
      if (!move) return;
      e.preventDefault();
      move.click();
      _focusVisibleStepPanel(move);
      return;
    }
    // Enter: a textarea keeps it for newlines, and a focused button or link
    // keeps its own activation (Tab to Back, press Enter, and you go back).
    if (tag === "TEXTAREA" || t.closest("button, a[href]")) return;
    var next = _stepKeyBtn(opts.next);
    var btn = next || _stepKeyBtn(opts.submit);
    if (!btn) return;
    e.preventDefault();
    btn.click();
    if (next) _focusVisibleStepPanel(next);
  }
  document.addEventListener("keydown", onKey);
  _modalStepKeyTeardown = function () { document.removeEventListener("keydown", onKey); };
  return _modalStepKeyTeardown;
}

// A footer button that is on screen and clickable, by id or element. Visibility
// is read off the inline `display` those footers toggle — deliberately NOT
// `offsetParent === null` the way `_focusableIn` does it, because happy-dom has
// no layout engine and that test would call every button hidden, making the DOM
// tests vacuous.
function _stepKeyBtn(ref) {
  var el = typeof ref === "string" ? document.getElementById(ref) : ref;
  if (!el || el.disabled || el.hidden) return null;
  if (el.isConnected === false) return null;
  if (el.style && el.style.display === "none") return null;
  return el;
}

// Move focus into the step that just became visible, so the next keystroke
// isn't typed into a field on the step the operator has left (a hidden field
// keeps focus, swallows the arrows, and reads as a dead keyboard). Falls back
// to the button that did the moving, which keeps Enter and the arrows live.
function _focusVisibleStepPanel(fallback) {
  var overlay = document.getElementById("modal-overlay");
  var panel = overlay && overlay.querySelector(".step-panel.visible");
  var f = panel ? _focusableIn(panel) : [];
  if (f.length) { try { f[0].focus(); return; } catch (_) { /* element gone */ } }
  if (fallback && typeof fallback.focus === "function") {
    try { fallback.focus(); } catch (_) { /* element gone */ }
  }
}
if (typeof window !== "undefined") window.wireModalStepKeys = wireModalStepKeys;

// ─── Panel lock ─────────────────────────────────────────────────────────────
// Lives in public/js/panel-lock.js (loaded before this file on every page,
// and on the /dash wallboard, which has no app.js): initPanelLock,
// isPanelLocked, _ensureLockButton, _injectPanelLockButtons.

// ─── Modal tabs + form parts ────────────────────────────────────────────────
//
// A tall config form stays ONE modal with tabs — never a wizard, never a new
// page. These two are the canonical pair; assets.js and integrations.js each
// grew a byte-identical private copy, and both now delegate here.
//
// tabs: [{ key, label, html }] — panel ids are `<prefix>-tab-<key>`.
//
// Keep field ids UNIQUE ACROSS TABS so one read pass collects the whole form:
// a per-tab read silently drops whatever the operator never opened.

function tabbedBodyHTML(prefix, tabs) {
  return '<div class="page-tabs" id="' + prefix + '-tabs" style="margin-bottom:1rem">' +
      tabs.map(function (t, i) {
        return '<button type="button" class="page-tab' + (i === 0 ? " active" : "") +
          '" data-tab="' + escapeHtml(t.key) + '">' + escapeHtml(t.label) + "</button>";
      }).join("") +
    "</div>" +
    tabs.map(function (t, i) {
      return '<div class="page-tab-panel' + (i === 0 ? " active" : "") +
        '" id="' + prefix + "-tab-" + escapeHtml(t.key) + '">' + t.html + "</div>";
    }).join("");
}

function wireModalTabs(prefix) {
  var tabs = document.querySelectorAll("#" + prefix + "-tabs .page-tab");
  Array.prototype.forEach.call(tabs, function (btn) {
    btn.addEventListener("click", function () {
      Array.prototype.forEach.call(tabs, function (b) { b.classList.remove("active"); });
      Array.prototype.forEach.call(
        document.querySelectorAll('[id^="' + prefix + '-tab-"]'),
        function (p) { p.classList.remove("active"); },
      );
      btn.classList.add("active");
      var panel = document.getElementById(prefix + "-tab-" + btn.getAttribute("data-tab"));
      if (panel) panel.classList.add("active");
    });
  });
}

// Form section parts. Config modals build their sections from these rather
// than hand-rolling the same markup, so they read as one design language.
//   sectionHeading("Connection Settings")  → uppercase tertiary label
//   formDivider()                          → 1px rule between groups
//   infoBox("<html>")                      → accent-tinted informational block
//   checkboxRow(id, label, checked)        → 'auto'-width box + label on a line
//   calloutHTML(variant, title, bodyHtml)  → left-accent emphasis callout

function sectionHeading(text) {
  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;' +
    'color:var(--color-text-tertiary);margin-bottom:0.75rem">' + escapeHtml(text) + "</p>";
}

function formDivider() {
  return '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">';
}

// Compatibility / scope constraints stated UP FRONT — versions, on-prem vs
// cloud, what the integration will and won't reach. Bold the specific values.
function infoBox(html) {
  return '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);' +
    'border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);' +
    'border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:1rem;font-size:0.82rem;' +
    'color:var(--color-text-secondary);line-height:1.5">' + html + "</div>";
}

function checkboxRow(id, label, checked) {
  return '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="' + escapeHtml(id) + '"' + (checked ? " checked" : "") +
        ' style="width:auto">' +
      '<label for="' + escapeHtml(id) + '" style="margin:0">' + escapeHtml(label) + "</label>" +
    "</div>";
}

// Every highlighted note (security blast-radius warnings, tip/alternative
// boxes, permission requirements) renders through this one helper. `variant`
// selects the accent from real theme tokens (so it adapts across themes); the
// faint tint is derived from that same token via color-mix. `title` is the bold
// lead row (icon prepended automatically); `bodyHtml` is raw HTML as hint text.
var CALLOUT_VARIANTS = {
  warning: { color: "var(--color-warning)", icon: "&#9888;" },        // warning sign — security / silent-failure caveats
  tip:     { color: "var(--color-accent)", icon: "&#128161;" },       // light bulb — alternatives / suggestions
  note:    { color: "var(--color-text-secondary)", icon: "" },        // neutral informational
};
function calloutHTML(variant, title, bodyHtml) {
  var v = CALLOUT_VARIANTS[variant] || CALLOUT_VARIANTS.note;
  return '<div style="border-left:3px solid ' + v.color + ';' +
      'background:color-mix(in srgb, ' + v.color + ' 9%, transparent);' +
      'border-radius:0 var(--radius-sm) var(--radius-sm) 0;padding:0.6rem 0.8rem;margin-top:0.75rem">' +
      (title
        ? '<p style="margin:0 0 0.4rem 0;font-weight:600;color:' + v.color + '">' +
            (v.icon ? v.icon + " " : "") + title + '</p>'
        : '') +
      '<p class="hint" style="margin:0">' + bodyHtml + '</p>' +
    '</div>';
}

// ─── Location-code nesting diagram ──────────────────────────────────────────
// How the a:/b:/f:/r:/jb: description codes nest on the Device Map: each tier
// is a box inside the one above it, drawn in that tier's hull colour and
// border style. Shown under the grouping-shortcut hint wherever a description
// is edited (the Device Map's right-click editor, the asset Edit form). The
// colours MIRROR LOC_GROUP_KINDS in topology-render.js (dark = color, daylight
// = colorLight) — that file is not loaded on every page that edits a
// description; tests/unit/locationDiagram.test.ts holds the two equal.
var LOC_DIAGRAM_TIERS = [
  { code: "a",  name: "Area",         example: "Mine",         color: "#f472b6", colorLight: "#be185d", dash: "solid" },
  { code: "b",  name: "Building",     example: "Shop",         color: "#4fc3f7", colorLight: "#0369a1", dash: "solid" },
  { code: "f",  name: "Floor",        example: "2",            color: "#a78bfa", colorLight: "#6d28d9", dash: "dashed" },
  { code: "r",  name: "Room",         example: "North Closet", color: "#4ade80", colorLight: "#15803d", dash: "solid" },
  { code: "jb", name: "Junction box", example: "112-305",      color: "#f59e0b", colorLight: "#b45309", dash: "dashed" },
];
function locationCodesDiagramHTML() {
  var light = typeof isLightTheme === "function" && isLightTheme();
  var inner = '<div class="loc-diagram-device"><span class="loc-diagram-dot"></span>this device</div>';
  for (var i = LOC_DIAGRAM_TIERS.length - 1; i >= 0; i--) {
    var t = LOC_DIAGRAM_TIERS[i];
    inner =
      '<div class="loc-diagram-box" style="--loc-c:' + (light ? t.colorLight : t.color) + ';border-style:' + t.dash + '">' +
        '<div class="loc-diagram-label"><code>' + t.code + ':' + t.example + '</code> ' + t.name + '</div>' +
        inner +
      '</div>';
  }
  return '<div class="loc-diagram" role="img" aria-label="Area contains building, building contains floor, floor contains room, room contains junction box">' +
      inner +
    '</div>' +
    '<div class="loc-diagram-caption">Each code draws a box inside the one above it. Skip any level you ' +
      'don\u2019t need \u2014 <code>b:Shop f:2</code> puts a device in Floor 2 of Shop with no area, room or junction box.</div>';
}

// ─── Integration modal (the standard shape) ─────────────────────────────────
//
// Every "connect us to another system" dialog is the SAME dialog. Polaris grew
// seven of them by hand (FortiManager, FortiGate, Active Directory, Entra ID,
// Windows Server, vCenter, Azure Arc) and they drifted: two tab
// implementations, footers in different orders, and per-type required-field
// chains copy-pasted with different rules. This is the one shape:
//
//   title    "<Action> <Product> Integration" — never a bare "Add Integration"
//            or "Edit Integration", because the operator picked a product to
//            get here and the title should confirm it.
//   body     General tab first (identity + connection), Monitoring second where
//            it exists, then feature tabs. One tab per concern; a concern with
//            three fields is a section inside General, not a tab of its own.
//   footer   Test Connection · Cancel · Create/Save Changes. Test is a
//            secondary on the LEFT: it is the rehearsal, not the commitment.
//   test     gated on the fields the request actually needs, and the toast
//            NAMES what is missing — never fire a request you know will fail
//            and report the server's error as if it were news.
//
// Saving is deliberately NEVER blocked on a passing test: an operator
// configuring ahead of a firewall change has a legitimate reason to save
// something that cannot connect yet. `onSave` receives `{ tested }` if it wants
// to act on it. Both buttons disable and relabel while in flight — these calls
// reach a remote system and can take seconds.
//
// Unlike the UI kit's version this does NOT scrape the form for you: Polaris's
// per-type config readers (_formConfigForType and the per-class block readers)
// handle nested blocks, arrays and keep-current secrets, so `onTest`/`onSave`
// read the form themselves and this owns only the shell.
//
//   openIntegrationModal({
//     product: "FortiManager", action: "Add",
//     prefix: "intg-edit",
//     tabs: [{key,label,html}, …],          // or `html` for a single-pane form
//     requires: [["f-host","host"], ["f-apiToken","API token"]],
//     onWire:  function () {…},             // per-type wiring, runs after open
//     onTest:  function () {…},             // return {ok} or throw
//     onSave:  function (ctx) {…},          // ctx.tested; throw to stay open
//   })
function openIntegrationModal(cfg) {
  var prefix = cfg.prefix || "intg";
  var action = cfg.action || "Add";
  var tabs = cfg.tabs || null;
  var body = tabs ? tabbedBodyHTML(prefix, tabs) : (cfg.html || "");
  var saveLabel = cfg.saveLabel || (action === "Edit" ? "Save Changes" : "Create");
  var busyLabel = cfg.busyLabel || (action === "Edit" ? "Saving…" : "Creating…");
  var footer =
    '<button class="btn btn-secondary" id="' + prefix + '-test">Test Connection</button>' +
    '<button class="btn btn-secondary" id="' + prefix + '-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="' + prefix + '-save">' + escapeHtml(saveLabel) + "</button>";

  openModal(action + " " + cfg.product + " Integration", body, footer, { wide: true });
  if (tabs) wireModalTabs(prefix);
  if (cfg.onWire) cfg.onWire();

  // Names the missing fields rather than saying "fill in the form": the whole
  // point of testing before saving is to find out what is wrong.
  function missingFields() {
    var missing = [];
    (cfg.requires || []).forEach(function (pair) {
      var el = document.getElementById(pair[0]);
      if (el && !String(el.value || "").trim()) missing.push(pair[1] || pair[0]);
    });
    return missing;
  }

  function busy(btn, label, fn) {
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    return Promise.resolve().then(fn).catch(function (err) {
      if (err && err.name === "AbortError") showToast("Aborted", "error");
      else showToast((err && err.message) || "Request failed", "error");
    }).then(function () {
      btn.disabled = false;
      btn.textContent = original;
    });
  }

  var tested = false;
  var testBtn = document.getElementById(prefix + "-test");
  var saveBtn = document.getElementById(prefix + "-save");
  var cancelBtn = document.getElementById(prefix + "-cancel");

  if (testBtn) testBtn.addEventListener("click", function () {
    var missing = missingFields();
    if (missing.length) {
      showToast("Fill in " + missing.join(", ") + " first", "error");
      return;
    }
    if (!cfg.onTest) return;
    busy(testBtn, "Testing…", function () {
      return Promise.resolve(cfg.onTest()).then(function (result) {
        tested = !!(result && result.ok);
      });
    });
  });

  if (saveBtn) saveBtn.addEventListener("click", function () {
    if (!cfg.onSave) return;
    busy(saveBtn, busyLabel, function () {
      return Promise.resolve(cfg.onSave({ tested: tested }));
    });
  });

  // A wired listener, not an inline onclick="closeModal()" — the footer is
  // built here, so its handlers belong here too.
  if (cancelBtn) cancelBtn.addEventListener("click", function () {
    if (cfg.onCancel) cfg.onCancel();
    closeModal();
  });

  return { wasTested: function () { return tested; } };
}

function openModal(title, bodyHTML, footerHTML, options) {
  let overlay = document.getElementById("modal-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "modal-overlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" tabindex="-1"><div class="modal-header"><h3 id="modal-title"></h3><button class="btn-icon modal-close" aria-label="Close dialog">&times;</button></div><div class="modal-body"></div><div class="modal-footer"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        // Locked → keep the dialog open (flash the X as a hint); unlocked →
        // an off-click dismisses it. See "Panel lock" above.
        if (typeof isPanelLocked === "function" && isPanelLocked("modal")) {
          flashModalCloseBtn(overlay.querySelector(".modal-close"));
        } else {
          closeModal();
        }
      }
    });
    overlay.querySelector(".modal-close").addEventListener("click", closeModal);
    var modalEl = overlay.querySelector(".modal");
    var headerEl = overlay.querySelector(".modal-header");
    // The move cursor rides on the wiring, not on .modal-header itself: a
    // modal that builds its own overlay gets no drag handler, and a bare CSS
    // rule was advertising one to every such dialog (the Device Map topology
    // modal most visibly). If you wire drag on another header, set this there.
    headerEl.classList.add("is-draggable");
    headerEl.addEventListener("mousedown", function (e) {
      if (e.target.closest(".modal-close") || e.target.closest(".panel-lock-btn")) return;
      _modalDrag.active = true;
      _modalDrag.startX = e.clientX - _modalDrag.offsetX;
      _modalDrag.startY = e.clientY - _modalDrag.offsetY;
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!_modalDrag.active) return;
      _modalDrag.offsetX = e.clientX - _modalDrag.startX;
      _modalDrag.offsetY = e.clientY - _modalDrag.startY;
      modalEl.style.transform = "translate(" + _modalDrag.offsetX + "px, " + _modalDrag.offsetY + "px)";
    });
    document.addEventListener("mouseup", function () {
      if (_modalDrag.active) {
        _modalDrag.active = false;
        document.body.style.userSelect = "";
      }
    });
  }
  var modal = overlay.querySelector(".modal");
  _modalDrag.offsetX = 0;
  _modalDrag.offsetY = 0;
  modal.style.transform = "";
  modal.classList.remove("modal-wide", "modal-large", "modal-xl", "modal-stepper");
  if (options && options.wide) modal.classList.add("modal-wide");
  if (options && options.stepper) modal.classList.add("modal-stepper");
  if (options && options.large) modal.classList.add("modal-large");
  if (options && options.xl) modal.classList.add("modal-xl");
  if (_modalReadOnlyTeardown) { _modalReadOnlyTeardown(); _modalReadOnlyTeardown = null; }
  overlay.querySelector(".modal-header h3").textContent = title;
  overlay.querySelector(".modal-body").innerHTML = bodyHTML;
  overlay.querySelector(".modal-footer").innerHTML = footerHTML || "";
  // A view-only dialog (e.g. an automation opened by a role without write).
  if (options && options.readOnly) _modalReadOnlyTeardown = _lockModalReadOnly(modal);
  var slideoverOpen = !!document.querySelector(".slideover-overlay.open");
  overlay.classList.toggle("above-slideover", slideoverOpen);
  if (typeof initPanelLock === "function") {
    initPanelLock();
    _injectPanelLockButtons();
  }
  // Remember what had focus so closeModal can restore it; trap Tab + Escape
  // inside the dialog while it's open.
  _modalReturnFocus = document.activeElement;
  if (_modalKeyTeardown) { _modalKeyTeardown(); }
  _modalKeyTeardown = _trapFocus(modal, closeModal);
  // The previous occupant of this overlay may have been a wizard; its stepper
  // keys must not survive into a dialog whose footer means something else.
  if (_modalStepKeyTeardown) { _modalStepKeyTeardown(); _modalStepKeyTeardown = null; }
  // rAF so the transition has a start state to animate from — but rAF does
  // NOT fire in a hidden tab, which would leave the dialog built and invisible
  // until the tab is next looked at. The timeout is the floor; `reveal` is
  // idempotent so whichever fires first wins.
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    overlay.classList.add("open");
    _focusFirstIn(modal);
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);
}

function closeModal() {
  var overlay = document.getElementById("modal-overlay");
  if (overlay) {
    overlay.classList.remove("open");
    overlay.classList.remove("above-slideover");
  }
  if (_modalKeyTeardown) { _modalKeyTeardown(); _modalKeyTeardown = null; }
  if (_modalStepKeyTeardown) { _modalStepKeyTeardown(); _modalStepKeyTeardown = null; }
  if (_modalReadOnlyTeardown) { _modalReadOnlyTeardown(); _modalReadOnlyTeardown = null; }
  if (_modalReturnFocus && typeof _modalReturnFocus.focus === "function") {
    try { _modalReturnFocus.focus(); } catch (_) { /* element gone */ }
  }
  _modalReturnFocus = null;
  if (typeof _modalFlashResetTimer !== "undefined" && _modalFlashResetTimer) clearTimeout(_modalFlashResetTimer);
  if (typeof _modalFlashLevel !== "undefined") _modalFlashLevel = 0;
}

// ─── Row context menu ─────────────────────────────────────────────────────────
//
// The list pages put their per-row verbs behind the row's NAME rather than an
// Actions column of buttons: one affordance, no column competing with the data
// for horizontal space, and room to add a verb without re-cutting the layout.
//
// Why this is `position: fixed` on <body> rather than the existing
// `.btn-dropdown-menu` pattern (which is absolute inside a positioned wrapper):
// every list table scrolls inside `.table-wrapper-sticky`, so an absolutely
// positioned menu in a <td> is clipped by that overflow the moment it's taller
// than the remaining rows. Fixed + body-mounted escapes the clip; the cost is
// that the menu must close on scroll, since it can no longer follow its anchor.
//
// items: [{ label, onSelect, danger?, disabled?, title?, primary? } | { separator: true }]
//
// Left click OPENS, right click shows the menu. An item marked `primary: true`
// is what a plain click (or Enter on the focused trigger) does: showRowMenu
// runs it straight away instead of drawing the menu. A right click — or the
// keyboard's Menu key / Shift+F10, which fire the same `contextmenu` event — on
// a `.row-menu-trigger` or `[data-row-menu]` element replays the click with the
// menu forced (_rowMenuForced), so every call site's own click handler builds
// the items exactly as before and the menu opens at the pointer. A menu with no
// primary item (the account menu, Export, a user row — nothing to "open") shows
// on either button. A caller that builds its items asynchronously reads
// rowMenuGesture() synchronously in its click handler and passes the result as
// `opts.menuAt`, because the forced flag only lives for the replayed click.
//
// A `<tr data-row-menu-row>` widens the right-click target to the whole row:
// a right click anywhere on it replays the click on the row's own trigger, so
// the menu is the same one the name gives. Fields and real links inside the
// row keep the browser's menu (copy / paste, open in a new tab). In a
// selectable table it also selects the row first unless it already is
// (_rowSelectForMenu), so the menu can offer verbs over the selection.
//
// The same `<tr data-row-menu-row>` makes a DOUBLE click anywhere on the row
// replay a plain click on its trigger — the row's primary verb (Open), or,
// for a row with no primary (a Users-page user), its menu. A double click on
// the trigger itself is left alone (its first click already opened the row),
// as is one on a field, a button, a label or a link inside the row.
var _rowMenuTeardown = null;
var _rowMenuForced = null;

/**
 * Is the click being handled right now a request for the MENU (a right click
 * replayed by the contextmenu listener)? Returns the pointer position to open
 * it at ({ x, y }, or { x: null } for a keyboard Menu key), else null.
 */
function rowMenuGesture() {
  return _rowMenuForced;
}

if (typeof document !== "undefined" && document.addEventListener) {
  document.addEventListener("contextmenu", function (e) {
    if (e.defaultPrevented || e.shiftKey) return; // Shift+right-click keeps the browser's own menu
    var t = e.target;
    var trigger = t && typeof t.closest === "function" ? t.closest(".row-menu-trigger, [data-row-menu]") : null;
    if (!trigger) {
      var row = t && typeof t.closest === "function" ? t.closest("tr[data-row-menu-row]") : null;
      if (!row || t.closest('input, textarea, select, [contenteditable], a[href]:not([href="#"])')) return;
      trigger = row.querySelector(".row-menu-trigger, [data-row-menu]");
      if (!trigger) return;
      t = trigger;
    }
    e.preventDefault();
    var menuRow = trigger.closest("tr[data-row-menu-row]");
    if (menuRow) _rowSelectForMenu(menuRow);
    // A keyboard-raised contextmenu reports (0, 0); anchor under the trigger then.
    var fromPointer = e.clientX || e.clientY;
    _rowMenuForced = fromPointer ? { x: e.clientX, y: e.clientY } : { x: null, y: null };
    try {
      t.dispatchEvent(new window.MouseEvent("click", {
        bubbles: true, cancelable: true, view: window,
        clientX: e.clientX, clientY: e.clientY,
      }));
    } finally {
      _rowMenuForced = null;
    }
  });

  document.addEventListener("dblclick", function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var t = e.target;
    var row = t && typeof t.closest === "function" ? t.closest("tr[data-row-menu-row]") : null;
    if (!row) return;
    // Any link, the in-page "#" ones included: its own click already went somewhere.
    if (t.closest(".row-menu-trigger, [data-row-menu], button, input, textarea, select, label, [contenteditable], a")) return;
    var trigger = row.querySelector(".row-menu-trigger, [data-row-menu]");
    if (!trigger) return;
    // A double click also selects the word under the pointer; drop it.
    try { window.getSelection().removeAllRanges(); } catch (_) { /* no selection API */ }
    trigger.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  });
}

/** Close whatever row menu is open. Safe to call when none is. */
function closeRowMenu(opts) {
  if (_rowMenuTeardown) _rowMenuTeardown(opts || {});
}

// `.row-context-menu`'s z-index in styles.css. Duplicated here because the
// lift below has to know when it would be a DEMOTION; keep the two in step.
var ROW_MENU_BASE_Z = 900;

// Stamped on the anchor for as long as its menu is open, and removed on every
// close path. The contract it publishes: "a position:fixed menu is pinned to
// this element — do not move it." Anything that scrolls or animates a
// container on its own initiative reads it and holds: the dashboard's NOC
// auto-scroll (dashboard.js → startAutoScroll) pauses the widget body that
// holds a stamped row, because one 1px creep tick fires the scroll handler
// below, which closes the menu the operator was still reaching for. The hover
// pause cannot cover that case — the menu is mounted on <body>, so moving the
// pointer onto it is a mouseleave from the widget.
var ROW_MENU_OPEN_ATTR = "data-rowmenu-open";

/**
 * The z-index a row menu needs to clear the layer its ANCHOR sits in: the
 * greatest z-index on the anchor's ancestors, plus one. Returns 0 when nothing
 * above the CSS base (900) is in play, so a plain list-page menu keeps the
 * stylesheet's value and stays under the modal overlay it usually opens.
 *
 * Reads computed style rather than a list of known overlay classes: the layers
 * a menu can be opened from already number half a dozen (modal 1000,
 * slide-over 1050, above-slideover modal 1075, monitor-confirm 1100,
 * sf-multi-popover 1200, address-book picker 1300 / its editor 1320) and a
 * hardcoded bump would be wrong for the next one either way.
 */
function _rowMenuLayer(anchor) {
  var max = 0;
  for (var el = anchor; el && el !== document.body; el = el.parentElement) {
    var z = parseInt(window.getComputedStyle(el).zIndex, 10);
    if (!isNaN(z) && z > max) max = z;
  }
  return max >= ROW_MENU_BASE_Z ? max + 1 : 0;
}

function showRowMenu(anchor, items, opts) {
  if (!anchor || !items || !items.length) return;
  var at = (opts && opts.menuAt) || _rowMenuForced;
  // A plain click runs the primary verb instead of showing the menu.
  if (!at) {
    var primary = items.find(function (it) { return it && it.primary && !it.disabled && typeof it.onSelect === "function"; });
    if (primary) {
      closeRowMenu({ silent: true });
      try { primary.onSelect(); } catch (err) { if (typeof showToast === "function") showToast((err && err.message) || "Action failed", "error"); }
      return;
    }
  }
  // A second click on the same anchor toggles rather than stacking menus — a
  // left click only; a second right click re-opens the menu at the new point.
  var reopening = !at && _rowMenuTeardown && _rowMenuTeardown.anchor === anchor;
  closeRowMenu({ silent: true });
  if (reopening) return;

  var menu = document.createElement("div");
  menu.className = "btn-dropdown-menu row-context-menu open";
  menu.setAttribute("role", "menu");
  if (opts && opts.label) menu.setAttribute("aria-label", opts.label);

  var buttons = [];
  items.forEach(function (it) {
    if (!it) return;
    if (it.separator) {
      var hr = document.createElement("div");
      hr.className = "dropdown-divider";
      menu.appendChild(hr);
      return;
    }
    if (it.heading) {
      var h = document.createElement("div");
      h.className = "dropdown-heading";
      h.textContent = it.heading;
      menu.appendChild(h);
      return;
    }
    var b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitem");
    // `icon` is developer-supplied SVG markup (ICONS), never user
    // data, so innerHTML is safe here; the label stays textContent regardless.
    if (it.icon) {
      b.innerHTML = it.icon;
      var lbl = document.createElement("span");
      lbl.textContent = it.label;
      b.appendChild(lbl);
      b.className = "has-icon" + (it.danger ? " danger" : "");
    } else {
      b.textContent = it.label;
      if (it.danger) b.className = "danger";
    }
    if (it.title) b.title = it.title;
    if (it.disabled) {
      b.disabled = true;
    } else {
      b.addEventListener("click", function () {
        // Close BEFORE the handler runs: most of these open a modal or a
        // slide-over, and a lingering fixed menu would float over it.
        closeRowMenu();
        try { it.onSelect(); } catch (err) { if (typeof showToast === "function") showToast((err && err.message) || "Action failed", "error"); }
      });
      buttons.push(b);
    }
    menu.appendChild(b);
  });
  if (!buttons.length && !menu.childNodes.length) return;

  // The menu is body-mounted and `position: fixed`, so its stacking is decided
  // against the other BODY-level layers — not against the surface the row is
  // on. At the CSS base (900) that is right for a list page (above the sticky
  // header, below the modal a verb opens) and wrong everywhere else: a menu
  // opened from INSIDE a slide-over (overlay 1050) or a modal (1000 / 1075)
  // rendered behind the very panel that owns the row, which is how the asset
  // details General tab's upstream rows shipped in 2026-09. Lift it to just
  // above its anchor's own layer.
  var layer = _rowMenuLayer(anchor);
  if (layer) menu.style.zIndex = String(layer);

  document.body.appendChild(menu);

  // Position under the anchor, flipped when it would leave the viewport.
  var r = anchor.getBoundingClientRect();
  var mw = menu.offsetWidth;
  var mh = menu.offsetHeight;
  var pad = 6;
  // Opened by a right click: at the pointer, as a context menu sits.
  if (at && at.x != null) r = { top: at.y, bottom: at.y, left: at.x, right: at.x };
  var top = r.bottom + 4;
  if (top + mh > window.innerHeight - pad) {
    var above = r.top - 4 - mh;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - pad - mh);
  }
  // Left-aligned to the anchor by default; `align:"end"` right-aligns it, which
  // is what a trigger sitting at the right edge of the page header wants.
  var left = (opts && opts.align === "end") ? r.right - mw : r.left;
  if (left + mw > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - pad - mw);
  if (left < pad) left = pad;
  menu.style.top = top + "px";
  menu.style.left = left + "px";

  // ── Dismissal + keyboard ────────────────────────────────────────────────
  function onDocPointerDown(e) {
    // `contains` on the anchor, not identity: a trigger with child elements
    // (the account badge's avatar / name / caret) would otherwise close here
    // on pointerdown and immediately re-open on the click, so a second click
    // could never dismiss it.
    if (!menu.contains(e.target) && !anchor.contains(e.target)) closeRowMenu();
  }
  function onKeyDown(e) {
    if (e.key === "Escape") { e.stopPropagation(); closeRowMenu(); return; }
    if (e.key === "Tab") { closeRowMenu(); return; }
    if (!buttons.length) return;
    var idx = buttons.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      var next = e.key === "ArrowDown"
        ? (idx < 0 ? 0 : (idx + 1) % buttons.length)
        : (idx <= 0 ? buttons.length - 1 : idx - 1);
      buttons[next].focus();
    } else if (e.key === "Home") { e.preventDefault(); buttons[0].focus(); }
    else if (e.key === "End") { e.preventDefault(); buttons[buttons.length - 1].focus(); }
  }
  // Capture-phase scroll so a scroll inside the table wrapper closes it too —
  // the menu is fixed and cannot track its anchor. But only a scroll that
  // MOVED the anchor is a reason to close: the dashboard's NOC auto-scroll
  // creeps every overflowing widget body by a pixel every 80ms, and closing on
  // those made the account menu flash open and vanish on that page. A scroll in
  // a container that doesn't hold the anchor leaves the menu correctly placed.
  function onScroll(e) {
    var t = e && e.target;
    // Document-level scroll (target is the Document node) moves everything.
    if (!t || t.nodeType === 9 || typeof t.contains !== "function") { closeRowMenu(); return; }
    if (t.contains(anchor)) closeRowMenu();
  }
  function onScrollOrResize() { closeRowMenu(); }

  document.addEventListener("pointerdown", onDocPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScrollOrResize);

  _rowMenuTeardown = function (o) {
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScrollOrResize);
    if (menu.parentNode) menu.parentNode.removeChild(menu);
    _rowMenuTeardown = null;
    if (anchor) {
      anchor.setAttribute("aria-expanded", "false");
      anchor.removeAttribute(ROW_MENU_OPEN_ATTR);
    }
    // Hand focus back so keyboard users don't land at the top of the document —
    // except when another affordance is about to claim it (silent close).
    if (!(o && o.silent) && typeof anchor.focus === "function") {
      try { anchor.focus(); } catch (_) { /* row re-rendered */ }
    }
  };
  _rowMenuTeardown.anchor = anchor;

  anchor.setAttribute("aria-expanded", "true");
  anchor.setAttribute(ROW_MENU_OPEN_ATTR, "");
  // A right click focuses the MENU, not its first item: Chrome draws a focus
  // ring on a programmatically focused item whenever the last input was a key
  // — and Ctrl+click to build a selection is one — so the first item came up
  // boxed. The capture-phase arrow handler above still works from here, and
  // the first ↓ lands on the first item. A keyboard-raised menu (Menu key,
  // Shift+F10: at.x null) and a plain click's menu keep the item focus.
  if (at && at.x != null) {
    menu.tabIndex = -1;
    try { menu.focus({ preventScroll: true }); } catch (_) { menu.focus(); }
  } else if (buttons.length) {
    buttons[0].focus();
  }
}

if (typeof window !== "undefined") {
  window.showRowMenu = showRowMenu;
  window.closeRowMenu = closeRowMenu;
  window.rowMenuGesture = rowMenuGesture;
}

// ─── Stacked Overlay (a dialog above an open modal) ───────────────────────────

/**
 * Build a dismissible overlay ABOVE any open modal — the stacked-modal pattern.
 * Returns { overlay, dialog, close }; `onClose` fires for backdrop click,
 * Escape and the close button.
 *
 * Why this exists rather than calling openModal: openModal creates and then
 * REUSES one shared #modal-overlay, overwriting its .modal-body innerHTML — so
 * calling it from inside an open modal destroys that modal's form DOM and loses
 * whatever the operator had typed. Layer rungs: 1300 over a base modal, 1320
 * when a third layer must sit over the second.
 *
 * Lives here (rather than in the file that first needed it) because every
 * dependency is in app.js and app.js loads on every page: the automations code
 * editor opens from the wizard, which loads on five pages, only one of which
 * loads the address book.
 */
function buildOverlay(z, title, bodyHtml, footerHtml, onClose, wide) {
  var overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.style.zIndex = String(z);
  overlay.innerHTML =
    '<div class="modal' + (wide ? " modal-large" : " modal-wide") + '" role="dialog" aria-modal="true" tabindex="-1">' +
      '<div class="modal-header"><h3>' + escapeHtml(title) + '</h3>' +
        '<button class="btn-icon modal-close" type="button" aria-label="Close dialog">&times;</button></div>' +
      '<div class="modal-body">' + bodyHtml + '</div>' +
      '<div class="modal-footer">' + footerHtml + '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  var dialog = overlay.querySelector(".modal");
  var prevFocus = document.activeElement;
  var closed = false;
  var teardownTrap = _trapFocus(dialog, function () { close(); });

  function close() {
    if (closed) return;
    closed = true;
    teardownTrap();
    overlay.classList.remove("open");
    // Remove on transition end, with a timer fallback for reduced-motion.
    overlay.addEventListener("transitionend", function () {
      if (overlay.parentNode) overlay.remove();
    }, { once: true });
    setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
    if (prevFocus && typeof prevFocus.focus === "function") { try { prevFocus.focus(); } catch (_) {} }
    if (onClose) onClose();
  }

  // Panel lock: one global switch governs EVERY modal, so these stacked
  // overlays take the same toggle app.js injects into the shared #modal-overlay
  // (its MutationObserver only looks at that one element, hence the direct
  // call) and honor it the same way — an off-click while locked flashes the X
  // + bloom instead of dismissing. Guarded so the module still works on a page
  // that somehow loads without app.js.
  var closeBtn = overlay.querySelector(".modal-close");
  if (typeof _ensureLockButton === "function") {
    _ensureLockButton(overlay.querySelector(".modal-header"), "modal");
  }
  closeBtn.addEventListener("click", close);
  overlay.addEventListener("click", function (ev) {
    if (ev.target !== overlay) return;
    if (typeof isPanelLocked === "function" && isPanelLocked("modal")) {
      if (typeof flashModalCloseBtn === "function") flashModalCloseBtn(closeBtn);
      return;
    }
    close();
  });
  // See openModal: rAF alone never fires in a hidden tab.
  var opened = false;
  var reveal = function () {
    if (opened) return;
    opened = true;
    overlay.classList.add("open");
    _focusFirstIn(dialog);
  };
  requestAnimationFrame(reveal);
  setTimeout(reveal, 50);

  return { overlay: overlay, dialog: dialog, close: close };
}

// ─── Confirm Dialog ───────────────────────────────────────────────────────────

function showConfirm(message) {
  return new Promise(function (resolve) {
    // Build a dedicated overlay rather than reusing openModal's single shared
    // #modal-overlay. openModal overwrites that element's body/footer innerHTML,
    // so calling it while another modal is open (e.g. the Edit Integration
    // auto-monitor guards) would destroy that modal's form DOM. A standalone
    // overlay at a higher z-index STACKS above any open modal, leaving its
    // markup intact so a save flow can still read the form after the confirm
    // resolves. white-space:pre-wrap preserves \n line breaks in the message.
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1300";
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-label="Confirm" tabindex="-1">' +
        '<div class="modal-header"><h3>Confirm</h3></div>' +
        '<div class="modal-body"><p style="font-size:0.9rem;color:var(--color-text-secondary);white-space:pre-wrap"></p></div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" data-confirm="cancel">Cancel</button>' +
          '<button class="btn btn-danger" data-confirm="ok">Confirm</button>' +
        '</div>' +
      '</div>';
    overlay.querySelector(".modal-body p").textContent = message;
    document.body.appendChild(overlay);
    var dialog = overlay.querySelector(".modal");
    var cancelBtn = overlay.querySelector('[data-confirm="cancel"]');
    var okBtn = overlay.querySelector('[data-confirm="ok"]');
    var prevFocus = document.activeElement;
    var settled = false;
    var teardownTrap = _trapFocus(dialog, function () { done(false); });
    function done(val) {
      if (settled) return;
      settled = true;
      teardownTrap();
      overlay.classList.remove("open");
      overlay.addEventListener("transitionend", function () {
        if (overlay.parentNode) overlay.remove();
      }, { once: true });
      // Fallback in case the transition doesn't fire (reduced-motion, etc.).
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      if (prevFocus && typeof prevFocus.focus === "function") {
        try { prevFocus.focus(); } catch (_) { /* element gone */ }
      }
      resolve(val);
    }
    cancelBtn.onclick = function () { done(false); };
    okBtn.onclick = function () { done(true); };
    // Keyboard: Enter confirms, Escape cancels (`_trapFocus` wires Escape).
    // Confirm also TAKES focus on open, so the default action is the one the
    // operator can see is default — but Enter is handled here rather than left
    // to the focused button, so it still confirms if anything on the page has
    // stolen focus back.
    //
    // Two things this must not do. An operator who Tabs to Cancel and presses
    // Enter cancels: that key belongs to the button they chose. And an
    // auto-REPEATING Enter is swallowed outright, because these dialogs open
    // from row menus whose items are themselves activated with Enter — the
    // repeat of that same keypress lands on a button that appeared mid-press,
    // and a held key must never confirm a destructive act nobody has read.
    dialog.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      if (e.repeat) { e.preventDefault(); return; }
      if (e.target === cancelBtn) return;
      e.preventDefault();
      done(true);
    });
    // See openModal: rAF alone never fires in a hidden tab.
    var shown = false;
    var reveal = function () {
      if (shown) return;
      shown = true;
      overlay.classList.add("open");
      try { okBtn.focus(); } catch (_) { _focusFirstIn(dialog); }
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 50);
  });
}

/**
 * showConfirm's sibling for a question with MORE than two answers: resolves to
 * the chosen choice's `id`, or `null` if the operator cancelled (Escape,
 * backdrop, or the Cancel button).
 *
 * Exists because showConfirm is binary by contract — Confirm or Cancel — and
 * some decisions genuinely have a third answer that is not "no". The first use
 * is the asset form's duplicate-address dialog (business rule 40(i)): save and
 * submit the collision for conflict review, or save and go straight to the
 * merge review, or cancel. Two stacked confirms would ask the same question
 * twice; a checkbox would hide the more consequential path behind a default.
 *
 * Same overlay discipline as showConfirm — a standalone element at z-index
 * 1300 that STACKS over an open modal without touching its DOM, so a save flow
 * can still read the form after this resolves. Keyboard: Escape cancels via
 * `_trapFocus`; Enter activates the FOCUSED button and nothing else — with
 * three or more answers there is no default an operator can be assumed to
 * have read, so unlike showConfirm this never confirms on a stray Enter, and
 * a held (auto-repeating) Enter is swallowed for the same reason it is there.
 *
 * opts: { title, choices: [{ id, label, kind: "primary" | "secondary" | "danger" }],
 *         cancelLabel }
 * Choices render in order; the first receives focus on open.
 */
function showChoice(message, opts) {
  opts = opts || {};
  var choices = Array.isArray(opts.choices) ? opts.choices.filter(function (c) { return c && c.id; }) : [];
  return new Promise(function (resolve) {
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1300";
    var title = opts.title || "Choose";
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" tabindex="-1">' +
        '<div class="modal-header"><h3></h3></div>' +
        '<div class="modal-body"><p style="font-size:0.9rem;color:var(--color-text-secondary);white-space:pre-wrap"></p></div>' +
        '<div class="modal-footer" style="flex-wrap:wrap;gap:0.5rem">' +
          '<button class="btn btn-secondary" data-choice="cancel"></button>' +
        '</div>' +
      '</div>';
    var dialog = overlay.querySelector(".modal");
    dialog.setAttribute("aria-label", title);
    dialog.querySelector(".modal-header h3").textContent = title;
    // textContent throughout: the message interpolates hostnames straight
    // from the database.
    overlay.querySelector(".modal-body p").textContent = message || "";
    var footer = overlay.querySelector(".modal-footer");
    var cancelBtn = overlay.querySelector('[data-choice="cancel"]');
    cancelBtn.textContent = opts.cancelLabel || "Cancel";
    var firstBtn = null;
    choices.forEach(function (c) {
      var b = document.createElement("button");
      b.className = "btn " + (c.kind === "danger" ? "btn-danger" : c.kind === "secondary" ? "btn-secondary" : "btn-primary");
      b.setAttribute("data-choice", String(c.id));
      b.textContent = c.label || String(c.id);
      b.onclick = function () { done(String(c.id)); };
      footer.appendChild(b);
      if (!firstBtn) firstBtn = b;
    });

    document.body.appendChild(overlay);
    var prevFocus = document.activeElement;
    var settled = false;
    var teardownTrap = _trapFocus(dialog, function () { done(null); });
    function done(val) {
      if (settled) return;
      settled = true;
      teardownTrap();
      overlay.classList.remove("open");
      overlay.addEventListener("transitionend", function () {
        if (overlay.parentNode) overlay.remove();
      }, { once: true });
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      if (prevFocus && typeof prevFocus.focus === "function") {
        try { prevFocus.focus(); } catch (_) { /* element gone */ }
      }
      resolve(val);
    }
    cancelBtn.onclick = function () { done(null); };
    // A held Enter must not pick an answer nobody has read (see showConfirm).
    // A deliberate Enter falls through to the focused button's own click.
    dialog.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.repeat) e.preventDefault();
    });
    var shown = false;
    var reveal = function () {
      if (shown) return;
      shown = true;
      overlay.classList.add("open");
      try { (firstBtn || cancelBtn).focus(); } catch (_) { _focusFirstIn(dialog); }
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 50);
  });
}

/**
 * showConfirm's sibling for the case where the operator has to TYPE something:
 * resolves to the entered string, or `null` if they cancelled.
 *
 * `null` vs `""` is the whole contract, and callers depend on it — an empty
 * string is a deliberate "no reason given" on an optional field, while null
 * means "don't do this at all". It matches `window.prompt`'s semantics, which is
 * what this replaces: prompt() is styled by the browser, unreachable in the
 * mobile PWA, and suppressed outright by some browsers (and by Chrome in
 * cross-origin iframes), so an operator could be left unable to complete an
 * action with no visible reason why.
 *
 * opts: { title, label, placeholder, value, okLabel, danger, required,
 *         requiredMessage, multiline, maxLength, help,
 *         password (masked input, value not trimmed) }
 */
function showPrompt(message, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    // Standalone overlay at the same z-index as showConfirm, for the same
    // reason: it must stack over an open modal without destroying its DOM.
    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1300";
    var title = opts.title || "Enter a value";
    var field = opts.multiline
      ? '<textarea id="prompt-input" rows="3" style="width:100%;resize:vertical"></textarea>'
      : (opts.password
        ? '<input type="password" id="prompt-input" autocomplete="current-password" style="width:100%">'
        : '<input type="text" id="prompt-input" style="width:100%">');
    overlay.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" tabindex="-1">' +
        '<div class="modal-header"><h3></h3></div>' +
        '<div class="modal-body">' +
          '<p class="prompt-message" style="font-size:0.9rem;color:var(--color-text-secondary);white-space:pre-wrap;margin:0 0 0.75rem"></p>' +
          '<div class="form-group" style="margin-bottom:0">' +
            '<label for="prompt-input" class="prompt-label"></label>' +
            field +
            '<p class="hint prompt-help" style="margin:0.35rem 0 0;display:none"></p>' +
            '<p class="prompt-error" style="margin:0.35rem 0 0;font-size:0.82rem;color:var(--color-danger);display:none"></p>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" data-prompt="cancel">Cancel</button>' +
          '<button class="btn" data-prompt="ok"></button>' +
        '</div>' +
      '</div>';

    var dialog = overlay.querySelector(".modal");
    dialog.setAttribute("aria-label", title);
    dialog.querySelector(".modal-header h3").textContent = title;
    // textContent throughout: every one of these is caller-supplied copy, and
    // some callers interpolate a hostname straight from discovery.
    var msgEl = overlay.querySelector(".prompt-message");
    if (message) msgEl.textContent = message; else msgEl.style.display = "none";
    var labelEl = overlay.querySelector(".prompt-label");
    if (opts.label) labelEl.textContent = opts.label; else labelEl.style.display = "none";
    if (opts.help) {
      var helpEl = overlay.querySelector(".prompt-help");
      helpEl.textContent = opts.help;
      helpEl.style.display = "";
    }
    var input = overlay.querySelector("#prompt-input");
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.value) input.value = opts.value;
    if (opts.maxLength) input.maxLength = opts.maxLength;
    var okBtn = overlay.querySelector('[data-prompt="ok"]');
    okBtn.textContent = opts.okLabel || "OK";
    okBtn.classList.add(opts.danger ? "btn-danger" : "btn-primary");

    document.body.appendChild(overlay);
    var prevFocus = document.activeElement;
    // Escape / backdrop resolve null — cancelling must never read as "".
    var teardownTrap = _trapFocus(dialog, function () { done(null); });

    function done(val) {
      teardownTrap();
      overlay.classList.remove("open");
      overlay.addEventListener("transitionend", function () {
        if (overlay.parentNode) overlay.remove();
      }, { once: true });
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      if (prevFocus && typeof prevFocus.focus === "function") {
        try { prevFocus.focus(); } catch (_) { /* element gone */ }
      }
      resolve(val);
    }

    var errEl = overlay.querySelector(".prompt-error");
    function submit() {
      // A password is taken exactly as typed: trimming it would change it.
      var v = opts.password ? input.value : input.value.trim();
      if (opts.required && !v) {
        // Don't resolve — an empty required field is a correction, not a cancel.
        // Say so: a red border alone reads as a button that did nothing, which
        // is exactly how "I clicked Acknowledge and nothing happened" starts.
        input.focus();
        input.classList.add("input-error");
        errEl.textContent = opts.requiredMessage || "This can't be left blank.";
        errEl.style.display = "";
        return;
      }
      done(v);
    }

    overlay.querySelector('[data-prompt="cancel"]').onclick = function () { done(null); };
    okBtn.onclick = submit;
    input.addEventListener("input", function () {
      input.classList.remove("input-error");
      errEl.style.display = "none";
    });
    // Enter submits a single-line field; a textarea keeps Enter for newlines.
    if (!opts.multiline) {
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); submit(); }
      });
    }

    // See openModal: rAF alone never fires in a hidden tab.
    var shown = false;
    var reveal = function () {
      if (shown) return;
      shown = true;
      overlay.classList.add("open");
      try { input.focus(); } catch (_) { _focusFirstIn(dialog); }
    };
    requestAnimationFrame(reveal);
    setTimeout(reveal, 50);
  });
}
if (typeof window !== "undefined") window.showPrompt = showPrompt;

function showFormModal(title, formHTML, confirmLabel) {
  return new Promise(function (resolve) {
    var footer = '<button class="btn btn-secondary" id="form-modal-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="form-modal-ok">' + escapeHtml(confirmLabel || "OK") + '</button>';
    openModal(title, formHTML, footer);
    document.getElementById("form-modal-cancel").onclick = function () { closeModal(); resolve(false); };
    document.getElementById("form-modal-ok").onclick = function () { closeModal(); resolve(true); };
  });
}
