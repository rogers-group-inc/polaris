/**
 * public/js/pinned-tls-certs.js — Pinned server identities (business rule
 * 113), shared by Server Settings → Web Server and the Windows SSH Deployment
 * card on Integrations.
 *
 * window.PolarisPinnedTlsCerts.mount(containerEl) renders a one-line summary
 * (how many certificates are pinned, how many changed) and a "View pinned
 * certificates" button. The button opens a slide-over listing every pin Polaris
 * holds — WinRM listeners, devices it upgrades, and every FortiGate /
 * FortiManager it talks to with SSL verification off (rule 113(e)) — each with
 * the asset(s) at that address as links that open the asset panel in place,
 * the integration(s) that dial it, its subject, fingerprint and dates.
 *
 * A pin whose server now presents a DIFFERENT certificate is listed first with
 * both SHA-256 fingerprints and "Trust new certificate", which pins exactly the
 * certificate shown (rule 113(f)); Delete stays for a host that was rebuilt and
 * should simply be re-pinned on its next connection.
 *
 * Needs api.js and app.js (escapeHtml, showToast, showConfirm, permAtLeast,
 * raiseSlideover, wireSlideoverEscape, initSlideoverResize).
 */
(function () {
  "use strict";

  var OVERLAY_ID = "tls-pins-overlay";
  var mounted = [];   // summary containers to refresh after a trust / delete

  function fmt(fp) {
    var hex = String(fp || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
    return hex.replace(/(..)(?=.)/g, "$1:");
  }

  function when(d) {
    return d ? new Date(d).toLocaleString() : "—";
  }

  function row(label, valueHtml, stacked) {
    return '<div class="detail-row' + (stacked ? " stacked" : "") + '"><span class="detail-label">' + escapeHtml(label) +
      '</span><span class="detail-value">' + valueHtml + "</span></div>";
  }

  // ─── Summary + button (what a host page mounts) ──────────────────────────

  function renderSummary(container, rows) {
    var total = rows ? rows.length : 0;
    var changed = (rows || []).filter(function (r) { return !!r.pendingFingerprint; }).length;
    var text = total === 0
      ? "No certificates pinned yet. A pin appears the first time Polaris sends a password or token to a server without " +
        "verifying a CA: a WinRM listener, a device it upgrades, or a FortiGate / FortiManager with SSL verification off."
      : total + " pinned certificate" + (total === 1 ? "" : "s") + ".";
    container.innerHTML =
      '<div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">' +
        '<span style="color:var(--color-text-secondary)">' + escapeHtml(text) + "</span>" +
        (changed ? '<span class="badge badge-conflict">' + changed + " changed</span>" : "") +
        (total ? '<button type="button" class="btn btn-sm btn-secondary" data-tls-pins-open>View pinned certificates</button>' : "") +
      "</div>";
    var btn = container.querySelector("[data-tls-pins-open]");
    if (btn) btn.addEventListener("click", function () { open(btn); });
  }

  function loadSummary(container) {
    if (!container) return;
    api.serverSettings.tlsCertPinsList()
      .then(function (r) { renderSummary(container, r && r.certPins); })
      .catch(function (err) {
        container.innerHTML = '<p class="empty-state" style="padding:0.5rem 0;margin:0">Could not load pinned certificates: ' +
          escapeHtml((err && err.message) || "unknown error") + "</p>";
      });
  }

  function mount(container) {
    if (!container) return;
    if (mounted.indexOf(container) < 0) mounted.push(container);
    loadSummary(container);
  }

  function refreshSummaries() {
    mounted = mounted.filter(function (c) { return document.body.contains(c); });
    mounted.forEach(loadSummary);
  }

  // ─── The slide-over ──────────────────────────────────────────────────────

  var returnFocus = null;

  function ensurePanel() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.className = "slideover-overlay";
    overlay.innerHTML =
      '<div class="slideover" id="tls-pins-panel" role="dialog" aria-labelledby="tls-pins-title" tabindex="-1">' +
        '<div class="slideover-resize-handle"></div>' +
        '<div class="slideover-header">' +
          '<div class="slideover-header-top">' +
            '<div class="slideover-header-lead"><h3 id="tls-pins-title">Pinned server identities</h3></div>' +
            '<button class="btn-icon" id="tls-pins-close" title="Close" aria-label="Close pinned certificates">&times;</button>' +
          "</div>" +
          '<div class="slideover-meta" id="tls-pins-meta"></div>' +
        "</div>" +
        '<div class="slideover-body" id="tls-pins-body"><p class="empty-state" style="padding:1rem 1.25rem">Loading...</p></div>' +
        '<div class="slideover-footer"><button type="button" class="btn btn-secondary" id="tls-pins-done">Close</button></div>' +
      "</div>";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", function (e) { if (e.target === overlay) close(); });
    document.getElementById("tls-pins-close").addEventListener("click", close);
    document.getElementById("tls-pins-done").addEventListener("click", close);
    if (typeof wireSlideoverEscape === "function") wireSlideoverEscape(overlay, close);
    if (typeof initSlideoverResize === "function") initSlideoverResize(document.getElementById("tls-pins-panel"), "polaris.panel.width.tlsPins");
    document.getElementById("tls-pins-body").addEventListener("click", onBodyClick);
    return overlay;
  }

  function open(trigger) {
    var overlay = ensurePanel();
    returnFocus = trigger || document.activeElement;
    if (typeof raiseSlideover === "function") raiseSlideover(overlay);
    overlay.classList.add("open");
    loadPanel();
  }

  function close() {
    var overlay = document.getElementById(OVERLAY_ID);
    if (overlay) overlay.classList.remove("open");
    if (returnFocus && typeof returnFocus.focus === "function") {
      try { returnFocus.focus(); } catch (_) { /* gone */ }
    }
    returnFocus = null;
  }

  function loadPanel() {
    var body = document.getElementById("tls-pins-body");
    api.serverSettings.tlsCertPinsList()
      .then(function (r) { renderPanel(r && r.certPins); })
      .catch(function (err) {
        body.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Could not load pinned certificates: ' +
          escapeHtml((err && err.message) || "unknown error") + "</p>";
      });
  }

  function assetLinks(r) {
    if (!r.assets || !r.assets.length) return '<span style="color:var(--color-text-tertiary)">No asset at this address</span>';
    return r.assets.map(function (a) {
      var name = a.hostname || a.ipAddress || "Asset";
      return '<a href="/assets.html#view=asset:' + encodeURIComponent(a.id) + '">' + escapeHtml(name) + "</a>" +
        (a.hostname && a.ipAddress ? ' <span style="color:var(--color-text-tertiary)">' + escapeHtml(a.ipAddress) + "</span>" : "");
    }).join("<br>");
  }

  function pinCard(r, canManage) {
    var changed = !!r.pendingFingerprint;
    var hostPort = r.host + ":" + r.port;
    var actions = "";
    if (canManage) {
      if (changed) {
        actions += '<button type="button" class="btn btn-sm btn-primary" data-pin-trust="' + escapeHtml(r.id) + '" data-pin-fp="' +
          escapeHtml(r.pendingFingerprint) + '" data-pin-host="' + escapeHtml(hostPort) + '">Trust new certificate</button> ';
      }
      actions += '<button type="button" class="btn btn-sm btn-secondary" data-pin-del="' + escapeHtml(r.id) + '" data-pin-host="' +
        escapeHtml(hostPort) + '">Delete</button>';
    }
    return '<div class="tls-pin-card" style="border:1px solid ' + (changed ? "var(--color-danger, #c0392b)" : "var(--color-border)") +
        ';border-radius:var(--radius-md, 8px);padding:0.75rem 0.9rem;margin-bottom:0.75rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.35rem">' +
        '<span class="mono" style="font-weight:600">' + escapeHtml(hostPort) + "</span>" +
        (changed ? '<span class="badge badge-conflict">Certificate changed</span>' : '<span class="badge badge-active">Pinned</span>') +
      "</div>" +
      row("Asset", assetLinks(r)) +
      (r.integrations && r.integrations.length
        ? row("Integration", r.integrations.map(function (i) { return escapeHtml(i.name); }).join(", "))
        : "") +
      row("Subject", escapeHtml(r.subject || "—")) +
      row(changed ? "Pinned SHA-256" : "SHA-256", '<code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(fmt(r.fingerprint)) + "</code>", true) +
      (changed
        ? row("Now presents", '<code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(fmt(r.pendingFingerprint)) + "</code>" +
            (r.pendingSubject ? ' <span style="color:var(--color-text-secondary)">(' + escapeHtml(r.pendingSubject) + ")</span>" : "") +
            ' <span style="color:var(--color-text-secondary)">since ' + escapeHtml(when(r.pendingSeenAt)) + "</span>", true)
        : "") +
      row("First seen", escapeHtml(when(r.firstSeen))) +
      row("Last seen", escapeHtml(when(r.lastSeen))) +
      (actions ? '<div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.5rem">' + actions + "</div>" : "") +
    "</div>";
  }

  function renderPanel(rows) {
    var body = document.getElementById("tls-pins-body");
    var meta = document.getElementById("tls-pins-meta");
    rows = rows || [];
    var changed = rows.filter(function (r) { return !!r.pendingFingerprint; }).length;
    meta.innerHTML = '<span style="color:var(--color-text-secondary);font-size:0.85rem">' + rows.length + " pinned" +
      (changed ? " · " + changed + " changed" : "") + "</span>";
    if (!rows.length) {
      body.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">No certificates pinned yet.</p>';
      return;
    }
    var canManage = typeof permAtLeast === "function" && permAtLeast("serverSettingsSystem", "write");
    // Changed certificates come first from the server: they are what an
    // administrator opened this for.
    body.innerHTML = '<div style="padding:1rem 1.25rem">' + rows.map(function (r) { return pinCard(r, canManage); }).join("") + "</div>";
  }

  function onBodyClick(e) {
    var trust = e.target.closest ? e.target.closest("[data-pin-trust]") : null;
    var del = e.target.closest ? e.target.closest("[data-pin-del]") : null;
    if (trust) {
      var hostPort = trust.getAttribute("data-pin-host");
      var fp = trust.getAttribute("data-pin-fp");
      showConfirm(
        "Trust the new certificate of " + hostPort + "?\n\nSHA-256 " + fmt(fp) + "\n\n" +
        "Check it against the server first (on a FortiGate: System → Certificates, or `openssl s_client -connect " + hostPort + "`). " +
        "From now on Polaris sends its password or token only to this certificate."
      ).then(function (ok) {
        if (!ok) return;
        trust.disabled = true;
        api.serverSettings.tlsCertPinTrust(trust.getAttribute("data-pin-trust"), fp)
          .then(function () { showToast("Trusted the new certificate of " + hostPort, "success"); loadPanel(); refreshSummaries(); })
          .catch(function (err) { trust.disabled = false; showToast((err && err.message) || "Could not trust the certificate", "error"); });
      });
    } else if (del) {
      var hp = del.getAttribute("data-pin-host");
      showConfirm(
        "Delete the pinned TLS certificate for " + hp + "?\n\n" +
        "The next connection will trust and pin whatever certificate answers. To accept a certificate you have " +
        "already compared, use Trust new certificate instead."
      ).then(function (ok) {
        if (!ok) return;
        del.disabled = true;
        api.serverSettings.tlsCertPinDelete(del.getAttribute("data-pin-del"))
          .then(function () { showToast("Pin deleted", "success"); loadPanel(); refreshSummaries(); })
          .catch(function (err) { del.disabled = false; showToast((err && err.message) || "Could not delete the pin", "error"); });
      });
    }
  }

  window.PolarisPinnedTlsCerts = { mount: mount, open: open, formatFingerprint: fmt };
})();
