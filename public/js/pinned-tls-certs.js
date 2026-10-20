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
 * the integration(s) that dial it, its subject, fingerprint and dates. A
 * filter row in the header narrows the cards by IP, hostname, thumbprint and
 * subject (client-side; every filled field must match).
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
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">' + escapeHtml(text) + "</span>" +
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
          // In the header, not the body, so it stays put while the cards
          // scroll. A plain grid rather than .filter-bar: that is the
          // page-level sticky bar and reads as a slab inside a slide-over.
          '<div id="tls-pins-filters" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;margin-top:0.6rem">' +
            filterInput("ip", "IP address") +
            filterInput("hostname", "Hostname") +
            filterInput("thumbprint", "Thumbprint") +
            filterInput("subject", "Subject") +
          "</div>" +
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
    document.getElementById("tls-pins-filters").addEventListener("input", function () { renderPanel(lastRows); });
    return overlay;
  }

  function filterInput(key, label) {
    return '<input type="text" data-pin-filter="' + key + '" placeholder="' + label + '" aria-label="Filter by ' +
      label.toLowerCase() + '" autocomplete="off" spellcheck="false" style="padding:0.3rem 0.55rem;font-size:0.8rem">';
  }

  // ─── Filtering ───────────────────────────────────────────────────────────
  // Every non-empty field must match (AND); each is a case-insensitive
  // substring. IP looks at the pinned host and every asset address at it;
  // Hostname at the asset hostnames and a pinned host that is a name, not an
  // address; Thumbprint at both the pinned and the now-presented SHA-256 with
  // colons, spaces and case ignored, so a value pasted from openssl or
  // Windows' certificate dialog matches; Subject at both subjects.

  var lastRows = [];

  function filterValues() {
    var out = {};
    var inputs = document.querySelectorAll("#tls-pins-filters [data-pin-filter]");
    for (var i = 0; i < inputs.length; i++) {
      var v = inputs[i].value.trim().toLowerCase();
      if (v) out[inputs[i].getAttribute("data-pin-filter")] = v;
    }
    return out;
  }

  function isIpLiteral(s) {
    return /^[0-9.]+$/.test(s) || s.indexOf(":") >= 0;
  }

  function hexOnly(s) {
    return String(s || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  }

  function contains(hay, needle) {
    return String(hay || "").toLowerCase().indexOf(needle) >= 0;
  }

  function matches(r, f) {
    var assets = r.assets || [];
    if (f.ip && !contains(r.host, f.ip) &&
        !assets.some(function (a) { return contains(a.ipAddress, f.ip); })) return false;
    if (f.hostname && !(!isIpLiteral(String(r.host || "")) && contains(r.host, f.hostname)) &&
        !assets.some(function (a) { return contains(a.hostname, f.hostname); })) return false;
    if (f.thumbprint) {
      var want = hexOnly(f.thumbprint);
      if (!want || (hexOnly(r.fingerprint).indexOf(want) < 0 && hexOnly(r.pendingFingerprint).indexOf(want) < 0)) return false;
    }
    if (f.subject && !contains(r.subject, f.subject) && !contains(r.pendingSubject, f.subject)) return false;
    return true;
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
    lastRows = rows;
    var changed = rows.filter(function (r) { return !!r.pendingFingerprint; }).length;
    var f = filterValues();
    var filtering = Object.keys(f).length > 0;
    var shown = filtering ? rows.filter(function (r) { return matches(r, f); }) : rows;
    meta.innerHTML = '<span style="color:var(--color-text-secondary);font-size:0.85rem">' +
      (filtering ? shown.length + " of " : "") + rows.length + " pinned" +
      (changed ? " · " + changed + " changed" : "") + "</span>";
    if (!rows.length) {
      body.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">No certificates pinned yet.</p>';
      return;
    }
    if (!shown.length) {
      body.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">No pinned certificate matches the filter.</p>';
      return;
    }
    var canManage = typeof permAtLeast === "function" && permAtLeast("serverSettingsSystem", "write");
    // Changed certificates come first from the server: they are what an
    // administrator opened this for.
    body.innerHTML = '<div style="padding:1rem 1.25rem">' + shown.map(function (r) { return pinCard(r, canManage); }).join("") + "</div>";
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
