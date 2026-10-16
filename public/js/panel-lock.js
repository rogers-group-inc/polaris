/**
 * public/js/panel-lock.js — the panel lock and the off-click close flash.
 *
 * Moved out of app.js so the /dash wallboard (dash.html boots with
 * dash-boot.js, not app.js) gets the same lock and bloom on its Add Widgets
 * slide-over. Classic script: its top-level vars and functions are globals,
 * so app.js and page scripts call them exactly as before. Loaded BEFORE
 * app.js on every page that loads app.js, and on dash.html.
 */

// Escalating "use the X" hint: each off-modal click flashes the close button
// brighter than the last, with a radial bloom that grows in quarter-size
// increments. Resets after 1s of no off-clicks (or on close). Shared by every
// modal overlay (IPAM modals via openModal + the Device Map topology modal in
// map.js), so it's a global helper keyed off whichever close button is passed.
var _modalFlashLevel = 0;
var _modalFlashResetTimer = null;

// Flash the given modal close button + bloom one escalation step. closeBtn is
// the ".modal-close" / equivalent X element of the overlay the user clicked off.
function flashModalCloseBtn(closeBtn) {
  if (!closeBtn) return;
  // Each subsequent off-click ramps brighter (capped); decays 1s after the
  // last click, so a pause resets the escalation back to the start.
  var lvl = (_modalFlashLevel = Math.min(_modalFlashLevel + 1, 8));
  if (_modalFlashResetTimer) clearTimeout(_modalFlashResetTimer);
  _modalFlashResetTimer = setTimeout(function () { _modalFlashLevel = 0; }, 1000);
  // Drive the transition inline (matched to the bloom's 0.45s ease-out below)
  // so the X glow and the radial bloom fade in/out together. Inline so it
  // applies to both the modal .modal-close and the slide-over .btn-icon, and
  // survives the class removal in the reset so the fade-OUT is also 0.45s
  // instead of snapping back via the base .modal-close 0.15s transition.
  closeBtn.style.transition =
    "color 0.45s ease-out, background 0.45s ease-out, transform 0.45s ease-out," +
    "filter 0.45s ease-out, text-shadow 0.45s ease-out";
  closeBtn.style.background = "rgba(255,77,109," + Math.min(0.25 + lvl * 0.09, 0.95) + ")";
  closeBtn.style.filter = "brightness(" + (1 + lvl * 0.18) + ")";
  closeBtn.style.textShadow = "0 0 " + (lvl * 3) + "px rgba(255,77,109,0.9)";
  closeBtn.classList.add("flash");
  // Singleton bloom on <body>: position:fixed + high z-index so it paints over
  // any modal and spills past the corner unclipped, regardless of which overlay
  // owns the X. Styles are inline (not a CSS class) so a stale cached
  // stylesheet can't render it invisible.
  var bloom = document.getElementById("modal-close-bloom");
  if (!bloom) {
    bloom = document.createElement("div");
    bloom.id = "modal-close-bloom";
    bloom.style.cssText =
      "position:fixed;border-radius:50%;pointer-events:none;opacity:0;z-index:100000;" +
      "transform:translate(-50%,-50%);mix-blend-mode:screen;" +
      "background:radial-gradient(circle,rgba(255,77,109,0.85) 0%,rgba(255,77,109,0.6) 32%,rgba(255,77,109,0) 70%);" +
      "transition:opacity 0.45s ease-out,width 0.08s,height 0.08s;";
  }
  // A fullscreened element renders in the browser's top layer, which paints
  // over body-level fixed elements. Re-home the bloom into whatever is
  // fullscreen (else body) so it still shows over the topology modal there;
  // a position:fixed child of the top-layer element renders in the top layer.
  // `screen` can only lighten, so over a light theme's cream it all but
  // vanishes; there it multiplies instead, which tints the page red.
  var light = getComputedStyle(document.documentElement).colorScheme === "light";
  bloom.style.mixBlendMode = light ? "multiply" : "screen";
  var bloomHost = document.fullscreenElement || document.body;
  if (bloom.parentNode !== bloomHost) bloomHost.appendChild(bloom);
  // No bloom on the first off-click; from the 2nd on it starts at 1/4 the full
  // size and grows by quarter increments to full by the 5th.
  var steps = Math.min(lvl - 1, 4); // 0..4
  if (steps <= 0) {
    bloom.style.opacity = "0";
  } else {
    var r = closeBtn.getBoundingClientRect();
    var size = 280 * steps / 4; // 70px → 280px in quarter steps
    bloom.style.left = (r.left + r.width / 2) + "px";
    bloom.style.top = (r.top + r.height / 2) + "px";
    bloom.style.width = size + "px";
    bloom.style.height = size + "px";
    bloom.style.opacity = String(0.35 + steps * 0.15); // 0.5 → 0.95
  }
  setTimeout(function () {
    closeBtn.classList.remove("flash");
    closeBtn.style.background = "";
    closeBtn.style.filter = "";
    closeBtn.style.textShadow = "";
    bloom.style.opacity = "0";
    // Let the 0.45s fade-out run, then drop the inline transition so the
    // button's normal hover snaps back to the base .modal-close 0.15s timing.
    setTimeout(function () { closeBtn.style.transition = ""; }, 460);
  }, 600);
}

// ─── Panel lock (per-user, app-wide) ────────────────────────────────────────
//
// A lock toggle next to the X on every modal and slide-over. Locking is global
// per type — one switch governs ALL modals, another ALL slide-overs — and is
// saved per user in localStorage. When locked, clicking the backdrop (off the
// panel) does NOT dismiss it; when unlocked, an off-click closes it (the
// default). The X and Escape always close regardless of lock.
//
// Modals route through openModal (handled inline below). Slide-overs each wire
// their own backdrop-close handler, so a capture-phase document listener blocks
// that close when locked instead of editing every panel. Lock buttons are
// injected generically by a MutationObserver, so new panels get one for free.
//
// State lives on `window`, NOT in file scope: app.js can be evaluated more than
// once on a page, and a fresh file-scope object would silently reset the lock
// while the buttons already injected into the DOM kept claiming the old state.
// Re-using the existing object makes a re-evaluation a no-op instead.
window.__polarisPanelLock = window.__polarisPanelLock ||
  { state: { modal: false, slideover: false }, user: "anon", wired: false };
var _panelLockStore = window.__polarisPanelLock;

function _panelLockKey() { return "polaris.panellock." + _panelLockStore.user; }

function _loadPanelLock() {
  var st = _panelLockStore.state;
  try {
    var v = JSON.parse(localStorage.getItem(_panelLockKey()) || "null");
    st.modal = !!(v && v.modal);
    st.slideover = !!(v && v.slideover);
  } catch (_) { st.modal = false; st.slideover = false; }
  _syncAllLockButtons();
}

function _savePanelLock() {
  try { localStorage.setItem(_panelLockKey(), JSON.stringify(_panelLockStore.state)); } catch (_) {}
}

function _togglePanelLock(type) {
  _panelLockStore.state[type] = !_panelLockStore.state[type];
  _savePanelLock();
  _syncAllLockButtons(type);
}

// Read-only accessor for page code that has to honor the lock beyond the
// backdrop-click rule — e.g. the asset slide-over's Edit button, which
// normally closes the panel before opening the edit modal and must not when
// the operator has pinned the panel open.
function isPanelLocked(type) { return !!_panelLockStore.state[type]; }
window.isPanelLocked = isPanelLocked;

function _lockBtnSvg(locked) {
  var attrs = 'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var body = locked
    ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
    : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>';
  return '<svg ' + attrs + '>' + body + '</svg>';
}

function _syncLockButton(btn) {
  if (!btn) return;
  var type = btn.getAttribute("data-lock-type");
  var locked = !!_panelLockStore.state[type];
  var noun = type === "modal" ? "dialogs" : "panels";
  btn.innerHTML = _lockBtnSvg(locked);
  btn.classList.toggle("locked", locked);
  btn.style.color = locked ? "var(--color-accent)" : "";
  btn.setAttribute("aria-pressed", locked ? "true" : "false");
  btn.setAttribute("aria-label", locked ? ("Unlock " + noun) : ("Lock " + noun));
  btn.title = locked
    ? ("Locked — clicking outside won’t close " + noun + ". Saved for your account. Click to unlock.")
    : ("Unlocked — clicking outside closes it. Click to lock all " + noun + " (saved for your account).");
}

function _syncAllLockButtons(type) {
  var sel = ".panel-lock-btn" + (type ? '[data-lock-type="' + type + '"]' : "");
  document.querySelectorAll(sel).forEach(_syncLockButton);
}

// Insert a lock button immediately before the close (X) button in a panel
// header. Idempotent — re-running skips headers that already have one.
function _ensureLockButton(headerEl, type) {
  if (!headerEl || headerEl.querySelector(".panel-lock-btn")) return;
  var closeBtn = type === "modal"
    ? headerEl.querySelector(".modal-close")
    : headerEl.querySelector(".btn-icon");
  if (!closeBtn) return;
  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-icon panel-lock-btn";
  btn.setAttribute("data-lock-type", type);
  // Headers are flex with space-between; margin-left:auto absorbs the free
  // space so the lock sits flush against the X instead of centered.
  btn.style.marginLeft = "auto";
  btn.addEventListener("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    _togglePanelLock(type);
  });
  closeBtn.parentNode.insertBefore(btn, closeBtn);
  _syncLockButton(btn);
}

function _injectPanelLockButtons() {
  document.querySelectorAll(".slideover .slideover-header-top").forEach(function (h) {
    _ensureLockButton(h, "slideover");
  });
  var mh = document.querySelector("#modal-overlay .modal-header");
  if (mh) _ensureLockButton(mh, "modal");
}

// Wire the observer (injects lock buttons into newly-created panels) + the
// capture-phase backdrop guard for slide-overs, then load the saved preference.
//
// Safe to call repeatedly AND safe to call late: the listeners are wired once,
// everything else re-syncs. Call it from the SAME ready path that waits for the
// rest of the runtime — running before the scripts resolve leaves the observer
// unwired and keys the preference to `anon` instead of the username.
//
//   initPanelLock({ user: currentUsername })
function initPanelLock(opts) {
  if (opts && opts.user) _panelLockStore.user = opts.user;
  _loadPanelLock();
  if (_panelLockStore.wired) { _injectPanelLockButtons(); return; }
  _panelLockStore.wired = true;

  // Block slide-over backdrop-close when locked. Capture phase runs before the
  // panel's own (bubbling) overlay handler, so stopping propagation here keeps
  // it open. e.target is the overlay itself only on a genuine backdrop click.
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (t && t.classList && t.classList.contains("slideover-overlay") && _panelLockStore.state.slideover) {
      e.stopPropagation();
      // Same glow/bloom the modal X gives on an off-click while locked — flash
      // this slide-over's close button (the btn-icon that isn't the lock).
      var closeBtn = t.querySelector(".slideover-header-top .btn-icon:not(.panel-lock-btn)");
      flashModalCloseBtn(closeBtn);
    }
  }, true);

  if (window.MutationObserver) {
    var obs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (n.nodeType !== 1) continue;
          var isOverlay = n.classList && (n.classList.contains("slideover-overlay") || n.classList.contains("modal-overlay"));
          if (isOverlay || (n.querySelector && n.querySelector(".slideover-overlay, .modal-overlay"))) {
            _injectPanelLockButtons();
            return;
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }
  _injectPanelLockButtons();
}
if (typeof window !== "undefined") window.initPanelLock = initPanelLock;
