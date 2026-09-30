// public/js/mobile/more-tab.js — More tab + its sub-pages.
//
// The More tab is two things: a menu of the rest of the app (Blocks /
// Alerts / Events / Profile), and a host for those
// sub-pages. The router emits `#more/<sub>` and we dispatch on
// route.parts[0] inside this module so the rest of app.js doesn't have
// to know about More's sub-routes.
//
// Sub-pages are deliberately read-only — networks live on desktop for
// editing. Reservation creation comes via Phase 8 (Reserve sheet).

(function () {
  // ─── Sub-pages registry ────────────────────────────────────────────────
  var SUB_PAGES = {};

  function registerSub(key, spec) { SUB_PAGES[key] = spec; }

  // ─── Helpers ───────────────────────────────────────────────────────────
  function backTopbar(title) {
    return ''
      + '<div class="m3-topbar">'
      + '  <div class="leading">'
      + '    <button class="icon-btn" data-back aria-label="Back"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  </div>'
      + '  <div class="title">' + escapeHtml(title) + '</div>'
      + '  <div class="trailing"></div>'
      + '</div>';
  }
  // Call this FIRST in a sub-page's render(), before the `return api…` that
  // kicks off its fetch — a call placed after that return is unreachable, which
  // is exactly how every sub-page's back chevron came to be inert. app.js
  // renders the topbar before calling render(), so the button is already in the
  // DOM at this point, and wiring it up front means back works while the list
  // is still loading and on the error path too.
  function wireBack() {
    var btn = document.querySelector("[data-back]");
    if (!btn) return;
    btn.addEventListener("click", function () { PolarisRouter.go("more"); });
  }
  // escapeHtml is the canonical global from api.js (loaded first on every page).
  // api.js timeAgo with the mobile guard for empty/unparseable timestamps.
  function formatTimeAgo(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return timeAgo(iso);
  }
  function loadingHtml() {
    return '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
  }
  function errorState(msg) {
    return ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Couldn’t load</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  // ─── Blocks sub-page ───────────────────────────────────────────────────
  registerSub("blocks", {
    renderTopbar: function () { return backTopbar("Blocks"); },
    render: function (body) {
      wireBack();
      body.innerHTML = loadingHtml();
      return api.blocks.list().then(function (blocks) {
        if (!Array.isArray(blocks) || blocks.length === 0) {
          body.innerHTML = '<div class="empty-state" style="padding-top:48px;"><div class="icon"><svg viewBox="0 0 24 24"><use href="#i-block"/></svg></div><div class="ttl">No blocks</div><div class="desc">No IP blocks have been created yet.</div></div>';
          return;
        }
        var html = "";
        blocks.forEach(function (b, i) {
          html += ''
            + '<button class="list-item two-line" data-id="' + escapeHtml(b.id) + '">'
            + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-block"/></svg></span>'
            + '  <div class="content">'
            + '    <div class="headline">' + escapeHtml(b.name || "(unnamed)") + '</div>'
            + '    <div class="supporting"><span class="mono">' + escapeHtml(b.cidr || "") + '</span>' + (b.description ? ' · ' + escapeHtml(b.description) : '') + '</div>'
            + '  </div>'
            + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
            + '</button>'
            + (i < blocks.length - 1 ? '<div class="list-divider"></div>' : '');
        });
        body.innerHTML = html;
        body.querySelectorAll(".list-item").forEach(function (row) {
          row.addEventListener("click", function () { PolarisRouter.go("block/" + row.dataset.id); });
        });
      }).catch(function (err) { body.innerHTML = errorState(err && err.message ? err.message : "error"); });
    },
  });

  // (The Networks sub-page that lived here is now the Networks tab —
  // networks-tab.js. app.js sends an old #more/subnets link there.)

  // ─── Events sub-page ───────────────────────────────────────────────────
  registerSub("events", {
    renderTopbar: function () { return backTopbar("Events"); },
    render: function (body) {
      wireBack();
      body.innerHTML = loadingHtml();
      return api.events.list({ limit: 100 }).then(function (resp) {
        var events = (resp && resp.events) || [];
        if (events.length === 0) {
          body.innerHTML = '<div class="empty-state" style="padding-top:48px;"><div class="icon"><svg viewBox="0 0 24 24"><use href="#i-event"/></svg></div><div class="ttl">No events</div><div class="desc">No events recorded in the retention window.</div></div>';
          return;
        }
        var html = "";
        events.forEach(function (e, i) {
          var leadCls = e.level === "error" ? "error" : (e.level === "warning" ? "warning" : "");
          var iconHref = e.level === "error" ? "#i-down-arrow" : (e.level === "warning" ? "#i-warn" : "#i-info");
          html += ''
            + '<button class="list-item three-line" data-rt="' + escapeHtml(e.resourceType || "") + '" data-rid="' + escapeHtml(e.resourceId || "") + '">'
            + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
            + '  <div class="content">'
            + '    <div class="headline">' + escapeHtml(prettyAction(e.action)) + (e.resourceName ? " · " + escapeHtml(e.resourceName) : "") + '</div>'
            + '    <div class="supporting" style="white-space:normal;">' + escapeHtml(e.message || "") + '</div>'
            + '    <div class="supporting mono" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:4px;">' + escapeHtml(formatTimeAgo(e.timestamp)) + (e.actor ? " · " + escapeHtml(e.actor) : "") + '</div>'
            + '  </div>'
            + '</button>'
            + (i < events.length - 1 ? '<div class="list-divider"></div>' : '');
        });
        body.innerHTML = html;
        body.querySelectorAll(".list-item").forEach(function (row) {
          row.addEventListener("click", function () {
            var rt = row.dataset.rt, rid = row.dataset.rid;
            if (!rid) return;
            if (rt === "asset") {
              if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(rid);
              else PolarisRouter.go("asset/" + rid);
            }
            else if (rt === "subnet") PolarisRouter.go("subnet/" + rid);
            else if (rt === "block")  PolarisRouter.go("block/" + rid);
            else PolarisTabs.showSnackbar("No mobile view for this event.");
          });
        });
      }).catch(function (err) { body.innerHTML = errorState(err && err.message ? err.message : "error"); });
    },
  });
  function prettyAction(action) {
    if (!action) return "Event";
    var s = action.replace(/\./g, " ").replace(/_/g, " ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  // ─── Alerts sub-page ───────────────────────────────────────────────────
  // The destination for every push notification enrolled from mobile
  // (PushSubscription.surface = "mobile" → /mobile.html#more/alerts). Without
  // this route the hash resolves to nothing and app.js's routeChanged bounces
  // unknown routes to #search — i.e. a push tap would land on an empty search
  // box. Acknowledging happens here too (alerts:write): the phone is where an
  // alert is usually READ, so making it desktop-only meant the person holding
  // the pager couldn't stop an escalation chain. Clearing stays on desktop —
  // it's the destructive half and needs fullwrite.
  var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
  function permAtLeast(user, key, level) {
    var have = (user && user.permissions && user.permissions[key]) || "none";
    return (_PERM_RANK[have] || 0) >= (_PERM_RANK[level] || 0);
  }

  registerSub("alerts", {
    renderTopbar: function () { return backTopbar("Alerts"); },
    render: function (body, ctx) {
      // wireBack() must run BEFORE the `return api…` below — a call after it is
      // unreachable, which is how every sub-page's back chevron came to be inert.
      wireBack();
      var canAck = permAtLeast(ctx && ctx.user, "alerts", "write");
      body.innerHTML = loadingHtml();
      return api.alerts.list({ limit: 100 }).then(function (resp) {
        var alerts = (resp && resp.notifications) || [];
        if (alerts.length === 0) {
          body.innerHTML = '<div class="empty-state" style="padding-top:48px;"><div class="icon"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg></div><div class="ttl">No active alerts</div><div class="desc">Nothing is firing right now.</div></div>';
          return;
        }
        var html = "";
        alerts.forEach(function (n, i) {
          var sev = n.severity || "info";
          var leadCls = sev === "critical" || sev === "error" ? "error" : (sev === "warning" ? "warning" : "");
          var iconHref = sev === "critical" || sev === "error" ? "#i-down-arrow" : (sev === "warning" ? "#i-warn" : "#i-info");
          var meta = formatTimeAgo(n.triggeredAt);
          if (n.acknowledged) meta += " · acknowledged" + (n.acknowledgedBy ? " by " + n.acknowledgedBy : "");
          // The Ack control is a sibling of the row button, not inside it —
          // nesting a <button> inside a <button> is invalid and swallows the
          // tap that opens the device.
          var showAck = canAck && !n.acknowledged;
          html += ''
            + '<div class="alert-row" style="display:flex;align-items:stretch;">'
            + '<button class="list-item three-line" style="flex:1;min-width:0;" data-aid="' + escapeHtml(n.assetId || "") + '">'
            + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
            + '  <div class="content">'
            + '    <div class="headline">' + escapeHtml(sev.toUpperCase()) + (n.assetHostname ? " · " + escapeHtml(n.assetHostname) : "") + '</div>'
            + '    <div class="supporting" style="white-space:normal;">' + escapeHtml(n.message || "") + '</div>'
            + '    <div class="supporting mono" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:4px;">' + escapeHtml(meta) + '</div>'
            + '  </div>'
            + '</button>'
            + (showAck
              ? '<button class="ack-btn" data-ack="' + escapeHtml(n.id) + '" aria-label="Acknowledge alert"'
                + (n.requireAckNote ? ' data-note-required="1"' : "")
                + ' style="flex:0 0 auto;align-self:center;margin-right:12px;padding:8px 12px;border-radius:20px;'
                + 'border:1px solid var(--md-outline);background:transparent;color:var(--md-primary);font:inherit;font-size:13px;">Ack</button>'
              : '')
            + '</div>'
            + (i < alerts.length - 1 ? '<div class="list-divider"></div>' : '');
        });
        body.innerHTML = html;
        body.querySelectorAll(".list-item").forEach(function (row) {
          row.addEventListener("click", function () {
            var aid = row.dataset.aid;
            // The alert may outlive its asset (assetId is nullable and the
            // hostname is snapshotted), so only navigate when there's one.
            if (!aid) return;
            if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(aid);
            else PolarisRouter.go("asset/" + aid);
          });
        });
        body.querySelectorAll("[data-ack]").forEach(function (btn) {
          btn.addEventListener("click", function (e) {
            e.stopPropagation();
            acknowledgeMobileAlert(btn, body, ctx);
          });
        });
      }).catch(function (err) { body.innerHTML = errorState(err && err.message ? err.message : "error"); });
    },
  });

  /* The acknowledge-note prompt lives in mobile/alerts.js, which the per-asset
   * alerts sheet needs too: an automation with `requireAckNote` is refused
   * server-side without one, and two copies of that sheet is two places for
   * the required-field rule to drift. Delegated rather than guarded — there is
   * deliberately no window.prompt fallback, since that is the exact dialog
   * some installed PWAs suppress (which is why this was a sheet to begin
   * with), and a silent no-op would read as a dead button.
   */
  function promptAckNoteSheet() {
    return PolarisMobileAlerts.promptAckNote(1);
  }

  // Acknowledge from the phone — one tap, unless the alert's automation
  // requires a note (see promptAckNoteSheet above).
  async function acknowledgeMobileAlert(btn, body, ctx) {
    var note;
    if (btn.dataset.noteRequired === "1") {
      note = await promptAckNoteSheet();
      if (note === null) return; // dismissed
    }
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = "…";
    api.alerts.acknowledge([btn.dataset.ack], note || undefined)
      .then(function () {
        if (window.PolarisTabs && PolarisTabs.showSnackbar) PolarisTabs.showSnackbar("Alert acknowledged");
        return SUB_PAGES.alerts.render(body, ctx);
      })
      .catch(function (err) {
        if (window.PolarisTabs && PolarisTabs.showSnackbar) {
          PolarisTabs.showSnackbar((err && err.message) || "Couldn't acknowledge", { error: true });
        }
        btn.disabled = false;
        btn.textContent = old;
      });
  }

  // ─── Add to Home Screen sub-page ───────────────────────────────────────
  registerSub("install", {
    renderTopbar: function () { return backTopbar("Add to Home Screen"); },
    render: function (body) {
      wireBack();
      var ios = window.PolarisInstall && PolarisInstall.isIos();
      var firefox = window.PolarisInstall && PolarisInstall.isFirefox();
      var steps;
      if (ios) {
        steps = ['Tap the <b>Share</b> button at the bottom of Safari.',
                 'Scroll down and tap <b>Add to Home Screen</b>.',
                 'Tap <b>Add</b>.',
                 'Open Polaris from your home screen — then come back to <b>More → Push notifications</b> to turn alerts on.'];
      } else if (firefox) {
        // Firefox can install, it just never implemented beforeinstallprompt,
        // so there's no button we can offer — only its own menu.
        steps = ['Open the Firefox menu (⋮).',
                 'Tap <b>Add to Home screen</b> (older builds) or <b>Install</b>.',
                 'Confirm.',
                 'Open Polaris from your home screen.'];
      } else {
        steps = ['Open your browser menu (⋮).',
                 'Tap <b>Install app</b> or <b>Add to Home screen</b>.',
                 'Confirm.',
                 'Open Polaris from your home screen.'];
      }

      var html = ''
        + '<div style="padding:24px 20px 8px;">'
        + '  <div class="ty-title-m" style="margin-bottom:8px;">Install Polaris</div>'
        + '  <div class="ty-body-m" style="color:var(--md-on-surface-variant);">Runs full screen, launches from your home screen, and can send you alert notifications.</div>'
        + '</div>';

      if (ios) {
        // Not a nicety on iOS: Apple grants Web Push only to an installed
        // home-screen web app, so this page IS the enrollment prerequisite.
        html += ''
          + '<div style="margin:8px 20px 4px;padding:12px 14px;border-radius:12px;background:var(--md-secondary-container);color:var(--md-on-secondary-container);" class="ty-body-m">'
          + '  On iPhone and iPad, notifications only work once Polaris is installed to the home screen. This is an Apple restriction.'
          + '</div>';
      }

      html += '<ol style="margin:12px 20px 24px;padding-left:20px;line-height:1.9;" class="ty-body-m">';
      steps.forEach(function (s) { html += '<li>' + s + '</li>'; });
      html += '</ol>';

      body.innerHTML = html;
    },
  });

  // ─── Menu (root More) ──────────────────────────────────────────────────
  function renderMenu(body, ctx) {
    var user = ctx.user || {};
    var displayName = user.displayName || user.username || "user";
    var role = user.role || "?";

    // The strip names the CURRENT theme; the art carries the rest of the
    // meaning, so there is no icon and no on/off state to derive.
    var themeName = (window.PolarisTheme && PolarisTheme.currentLabel) ? PolarisTheme.currentLabel() : "Nightfall";
    var standalone = !!(window.PolarisInstall && PolarisInstall.isStandalone());

    body.innerHTML = ''
      + '<div class="section-head">Network</div>'
      + menuRow("blocks", "i-block",   "Blocks",       "")

      + '<div class="section-head">Operations</div>'
      + menuRow("alerts", "i-bell", "Alerts", "Active alerts")
      + '<div class="list-divider"></div>'
      + menuRow("events", "i-event", "Events", "Audit log · last 7 days")

      // Hidden until wireNotifPrefRow() resolves the account's preference: the
      // row names a current setting, and naming the wrong one is worse than
      // showing nothing for a moment.
      + '<div class="section-head" id="push-section-head" style="display:none;">Notifications</div>'
      + '<button class="list-item two-line" id="push-toggle-row" style="display:none;">'
      + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg></span>'
      + '  <div class="content">'
      + '    <div class="headline">Notification preference</div>'
      + '    <div class="supporting" id="push-status-label">Checking…</div>'
      + '  </div>'
      + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
      + '</button>'

      + '<div class="section-head" id="install-section-head" style="display:none;">App</div>'
      + '<button class="list-item two-line" id="install-row" style="display:none;">'
      + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-desktop"/></svg></span>'
      + '  <div class="content">'
      + '    <div class="headline">Add to Home Screen</div>'
      + '    <div class="supporting" id="install-sub">Install Polaris on this phone</div>'
      + '  </div>'
      + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
      + '</button>'

      + '<div class="section-head">Appearance</div>'
      // The phone's counterpart to the desktop theme dial: one flat engraving
      // of the 24-hour clock that travels LEFT under a fixed marker. The art is
      // repeated THREE times on purpose — the track is anchored one strip width
      // left of the marker, so copies one and three cover the window on either
      // side at every position a leg can reach, and travelling off the end of
      // one copy lands on identical pixels in the next (which is what lets the
      // JS subtract a strip width unseen). Two copies leave bare surface beside
      // the art just before the seam is normalised away.
      + '<div class="theme-strip-row">'
      + '  <button class="theme-strip" id="theme-strip" type="button" aria-label="Time of day: ' + escapeHtml(themeName) + '. Tap to move through the day.">'
      + '    <span class="theme-strip-track">'
      + '      <img src="/img/brand/time-strip.png" alt="" draggable="false">'
      + '      <img src="/img/brand/time-strip.png" alt="" draggable="false">'
      + '      <img src="/img/brand/time-strip.png" alt="" draggable="false">'
      + '    </span>'
      + '    <span class="theme-strip-marker"></span>'
      + '  </button>'
      + '  <div class="theme-strip-caption">'
      // `.name` is what the CSS styles; `.theme-strip-name` is what
      // PolarisTheme.set repaints. It needs BOTH — the setter queries by class
      // so every strip on the page updates, and an id would match only one.
      + '    <span class="name theme-strip-name">' + escapeHtml(themeName) + '</span>'
      + '    <span class="hint">Tap to move through the day</span>'
      + '  </div>'
      + '</div>'

      + '<div class="section-head">Account</div>'
      + '<div class="list-item two-line">'
      + '  <span class="leading tertiary"><svg viewBox="0 0 24 24"><use href="#i-person"/></svg></span>'
      + '  <div class="content"><div class="headline">' + escapeHtml(displayName) + '</div><div class="supporting">' + escapeHtml(role) + '</div></div>'
      + '</div>'
      + '<div class="list-divider"></div>'
      // In an installed app, manifest scope "/" means this link would open the
      // full desktop layout INSIDE the standalone window — no address bar, no
      // back button, no way out. Hand it to the real browser instead.
      + '<a class="list-item two-line" href="/index.html?desktop=1"'
      + (standalone ? ' target="_blank" rel="noopener"' : '') + '>'
      + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-desktop"/></svg></span>'
      + '  <div class="content"><div class="headline">Desktop view</div><div class="supporting">Open the full app</div></div>'
      + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
      + '</a>'
      + '<div class="list-divider"></div>'
      + '<button class="list-item" id="sign-out-btn">'
      + '  <span class="leading error"><svg viewBox="0 0 24 24"><use href="#i-logout"/></svg></span>'
      + '  <div class="content"><div class="headline" style="color:var(--md-error);">Sign out</div></div>'
      + '</button>'
      + '<div style="text-align:center;padding:32px 0 24px;color:var(--md-on-surface-variant);font-size:11px;letter-spacing:.5px;" id="version-line">Polaris</div>';

    body.querySelectorAll("[data-sub]").forEach(function (row) {
      row.addEventListener("click", function () {
        PolarisRouter.go("more/" + row.dataset.sub);
      });
    });

    // The tap is handled by the delegated listener in mobile/app.js — wiring
    // one here as well would advance two themes per tap. All this tab owes the
    // strip is a seat: the More tab is built on demand, so the track enters the
    // DOM long after boot and has no position until something measures it.
    if (window.PolarisTheme && PolarisTheme.seatStrips) PolarisTheme.seatStrips();

    wireNotifPrefRow();
    wireInstallRow();

    document.getElementById("sign-out-btn").addEventListener("click", function () {
      // _csrfHeaders is the api.js canonical (carries the stale-Secure-cookie
      // detection this inline copy bypassed — 2026-08 audit).
      //
      // Mark the sign-out first: with "Skip login page" on, the login screen
      // redirects to SSO, and a silent (prompt=none) provider would sign the
      // operator straight back in. The marker buys one render of the local
      // form, matching the desktop, whose logout lands on the form-less
      // /signed-out.html.
      PolarisAuth.markSignedOut();
      fetch("/api/v1/auth/logout", { method: "POST", headers: _csrfHeaders() })
        .finally(function () { window.PolarisMobile.boot(); });
    });

    fetch("/api/v1/auth/me").then(function (r) { return r.ok ? r.json() : null; }).then(function (data) {
      if (!data || !data.version) return;
      var v = data.version;
      var tag = (typeof v === "string") ? v : (v.tag || (v.major + "." + v.minor + "." + v.patch));
      var el = document.getElementById("version-line");
      if (el) el.textContent = "Polaris " + tag;
    }).catch(function () {});
  }

  // ─── Push notifications row ────────────────────────────────────────────
  // Notification preference row.
  //
  // There is no push on/off switch here any more — enrollment is not a
  // decision, it is the consequence of one. The operator says how they want to
  // be alerted (Email / Push / both), the answer is stored on the ACCOUNT, and
  // this phone reconciles its own subscription to it. Which is what makes the
  // choice mean the same thing on every device they sign in on.
  //
  // The resolved push status is held in a closure so the sheet's buttons can
  // branch SYNCHRONOUSLY — awaiting status() inside the handler burns the
  // tap's transient user activation and Safari then refuses the permission
  // prompt (see the ordering comment in push.js).
  var PREF_LABELS = { email: "Email", push: "Push", any: "Email and push" };
  var PREF_ORDER = ["email", "push", "any"];

  function wireNotifPrefRow() {
    var head = document.getElementById("push-section-head");
    var row = document.getElementById("push-toggle-row");
    var label = document.getElementById("push-status-label");
    if (!head || !row || !label) return;

    var supported = !!(window.polarisPush && polarisPush.isSupported());
    var iosNeedsInstall = supported && window.PolarisInstall &&
      PolarisInstall.isIos() && !PolarisInstall.isStandalone();
    var state = null;
    var pref = null;
    var busy = false;

    function paint() {
      if (!pref) return;
      head.style.display = "";
      row.style.display = "";
      var line = PREF_LABELS[pref] || pref;
      // The second half of the line is about THIS phone, not the account: the
      // preference can be perfectly saved and still reach nothing here.
      if (pref !== "email") {
        if (iosNeedsInstall) line += " · Add to Home Screen to receive push here";
        else if (!supported) line += " · this browser can't receive push";
        else if (state && state.enabledOnServer === false) line += " · push isn't set up on this server";
        else if (state && state.permission === "denied") line += " · blocked in your browser settings";
        else if (state && !state.subscribed) line += " · tap to allow push on this phone";
      }
      label.textContent = line;
    }

    row.addEventListener("click", function () {
      if (busy || !pref) return;
      openPrefSheet();
    });

    function openPrefSheet() {
      var scrim = document.createElement("div");
      scrim.className = "scrim";
      var sheet = document.createElement("div");
      sheet.className = "sheet";
      // Only the SERVER having no Web Push channel makes the push options
      // pointless. An unsupported or blocked BROWSER does not: the preference
      // belongs to the account, and the operator's laptop may receive what
      // this phone can't.
      var pushOffered = !state || state.enabledOnServer !== false;
      sheet.innerHTML = ''
        + '<div class="sheet-handle"></div>'
        + '<h3 class="sheet-title" style="margin:0 0 4px;">Notify me by</h3>'
        + '<p style="margin:0 0 12px;color:var(--md-on-surface-variant);font-size:14px;">'
        + 'This applies to every device you sign in on. Choosing push enrolls them automatically.</p>'
        + PREF_ORDER.map(function (v) {
            var blocked = v !== "email" && !pushOffered;
            return '<button class="list-item" data-pref="' + v + '"'
              + (blocked ? ' disabled style="opacity:.5;"' : '') + '>'
              + '  <span class="leading">' + (v === pref ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '') + '</span>'
              + '  <div class="content"><div class="headline">' + PREF_LABELS[v] + '</div>'
              + (blocked ? '<div class="supporting">Web Push isn\'t configured on this server</div>' : '')
              + '</div>'
              + '</button>';
          }).join('')
        + '<div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px;">'
        + '  <button id="pref-cancel" style="padding:10px 16px;border-radius:20px;border:1px solid var(--md-outline);background:transparent;color:inherit;font:inherit;">Cancel</button>'
        + '</div>';
      document.body.appendChild(scrim);
      document.body.appendChild(sheet);
      function close() { scrim.remove(); sheet.remove(); }
      scrim.addEventListener("click", close);
      sheet.querySelector("#pref-cancel").addEventListener("click", close);
      Array.prototype.forEach.call(sheet.querySelectorAll("[data-pref]"), function (b) {
        b.addEventListener("click", function () {
          var next = b.getAttribute("data-pref");
          close();
          // Straight into choose() with the tap still counting as activation.
          choose(next);
        });
      });
    }

    function choose(next) {
      if (busy || next === pref) return;
      // iOS grants Web Push ONLY to an installed home-screen app. On iOS 16.4+
      // "PushManager" in window is true even in plain Safari, so isSupported()
      // passes and a naive flow would prompt and always throw. Send them to the
      // install page instead of saving a preference this phone can't honour.
      if (next !== "email" && iosNeedsInstall) {
        PolarisRouter.go("more/install");
        return;
      }
      busy = true;
      var wantPush = next !== "email";
      var needPrompt = wantPush && supported && state && state.permission !== "granted";
      // No await before enable() — see the note above.
      var enroll = needPrompt
        ? polarisPush.enable({ surface: "mobile" }).then(
            function () { return null; },
            function (err) { return (err && err.message) || "This browser refused push notifications."; })
        : Promise.resolve(null);

      enroll.then(function (enrollErr) {
        return api.push.setPreference(next).then(function () {
          pref = next;
          // Reconcile what the attempt left behind — in particular, choosing
          // Email must un-enroll this phone.
          return (supported ? polarisPush.syncToPreference(next, "mobile") : Promise.resolve(""))
            .then(function () {
              PolarisTabs.showSnackbar(enrollErr
                ? "Saved: " + PREF_LABELS[next] + ". " + enrollErr
                : "Notifications: " + PREF_LABELS[next]);
            });
        });
      }).catch(function (err) {
        PolarisTabs.showSnackbar((err && err.message) || "Couldn't save your notification preference");
      }).then(function () {
        busy = false;
        if (!supported) { paint(); return; }
        return polarisPush.status()
          .then(function (st) { state = st; paint(); })
          .catch(function () { paint(); });
      });
    }

    // Boot: read the account's choice, bring this phone into line with it
    // (silently — syncToPreference never prompts), then paint.
    //
    // Wrapped, not just .catch()ed: this runs INSIDE the More tab's render, so
    // a synchronous throw here (an api build without the endpoint, say) would
    // take the whole tab down with it — sign-out, theme and the nav rows
    // included. A notification preference is never worth that.
    Promise.resolve()
      .then(function () { return api.push.preference(); })
      .then(function (r) {
        pref = (r && r.preference) || "email";
        return supported ? polarisPush.syncToPreference(pref, "mobile") : null;
      })
      .catch(function () { pref = pref || "email"; })
      .then(function () {
        if (!supported) { paint(); return; }
        return polarisPush.status()
          .then(function (st) { state = st; paint(); })
          .catch(function () { paint(); });
      });
  }

  // ─── Add-to-Home-Screen row ────────────────────────────────────────────
  function wireInstallRow() {
    var head = document.getElementById("install-section-head");
    var row = document.getElementById("install-row");
    var sub = document.getElementById("install-sub");
    if (!head || !row || !sub || !window.PolarisInstall) return;

    function paint() {
      // Already installed — nothing to offer.
      if (PolarisInstall.isStandalone()) { head.style.display = "none"; row.style.display = "none"; return; }

      // Otherwise ALWAYS offer it. `canPrompt()` only tells us whether we can
      // trigger the install ourselves; a browser without beforeinstallprompt
      // (Firefox for Android, Safari) can still install from its own menu, so
      // hiding the row there left those users with no affordance at all.
      head.style.display = ""; row.style.display = "";
      sub.textContent = PolarisInstall.isIos()
        ? "Required for notifications on iPhone"
        : (PolarisInstall.canPrompt() ? "Install Polaris on this phone" : "How to install on this browser");
    }

    row.addEventListener("click", function () {
      // Native prompt when the browser gives us one; step-by-step instructions
      // for every browser that doesn't.
      if (!PolarisInstall.isIos() && PolarisInstall.canPrompt()) {
        PolarisInstall.prompt().then(function (outcome) {
          if (outcome === "accepted") PolarisTabs.showSnackbar("Polaris added to your home screen");
          paint();
        });
        return;
      }
      PolarisRouter.go("more/install");
    });

    // beforeinstallprompt can land AFTER this tab has painted.
    PolarisInstall.onChange(function () {
      if (document.getElementById("install-row") === row) paint();
    });
    paint();
  }

  function menuRow(sub, iconId, title, supporting) {
    var supLine = supporting ? '<div class="supporting">' + escapeHtml(supporting) + '</div>' : '';
    return ''
      + '<button class="list-item ' + (supporting ? "two-line" : "") + '" data-sub="' + sub + '">'
      + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#' + iconId + '"/></svg></span>'
      + '  <div class="content"><div class="headline">' + escapeHtml(title) + '</div>' + supLine + '</div>'
      + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>'
      + '</button>';
  }

  // ─── Tab spec ──────────────────────────────────────────────────────────
  var More = {
    title: "More",
    icon: "#i-more",
    renderTopbar: function (ctx) {
      var sub = ctx.route && ctx.route.parts && ctx.route.parts[0];
      var subSpec = sub && SUB_PAGES[sub];
      if (subSpec) return subSpec.renderTopbar(ctx);
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">More</div>'
        + '  <div class="trailing"></div>'
        + '</div>';
    },
    render: function (body, ctx) {
      var sub = ctx.route && ctx.route.parts && ctx.route.parts[0];
      var subSpec = sub && SUB_PAGES[sub];
      if (subSpec) return subSpec.render(body, ctx);
      return renderMenu(body, ctx);
    },
    // PTR only meaningful on the list sub-pages (blocks / events). The root menu is static and has nothing to refresh.
    enablesPullToRefresh: function (ctx) {
      var sub = ctx && ctx.route && ctx.route.parts && ctx.route.parts[0];
      return !!(sub && SUB_PAGES[sub]);
    },
    onPullToRefresh: function (ctx) {
      var sub = ctx && ctx.route && ctx.route.parts && ctx.route.parts[0];
      var subSpec = sub && SUB_PAGES[sub];
      if (!subSpec) return null;
      var body = document.getElementById("app-body");
      if (!body) return null;
      return subSpec.render(body, ctx);
    },
  };

  window.PolarisMoreTab = { spec: More };
})();
