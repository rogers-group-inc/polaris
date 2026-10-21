/**
 * public/js/pinned-tls-certs.js — Pinned server identities (business rule
 * 113), shared by Server Settings → Web Server and the Windows SSH Deployment
 * card on Integrations. One surface for both kinds of pin: the TLS
 * certificates and the SSH host keys Polaris trusted on first use.
 *
 * window.PolarisPinnedTlsCerts.mount(containerEl) renders a one-line summary
 * (how many certificates and host keys are pinned, how many certificates
 * changed) and a "View pinned identities" button. The button opens a
 * slide-over listing every pin Polaris holds — WinRM listeners, devices it
 * upgrades, every FortiGate / FortiManager it talks to with SSL verification
 * off (rule 113(e)), and every host it reached over SSH — each with the
 * asset(s) at that address as links that open the asset panel in place, the
 * integration(s) that dial it (TLS), its subject or key type, fingerprint and
 * dates. One filter bar in the header narrows the cards: a search field and a
 * kind selector (client-side).
 *
 * A certificate whose server now presents a DIFFERENT one is listed first with
 * both SHA-256 fingerprints and "Trust new certificate", which pins exactly the
 * certificate shown (rule 113(f)); Delete stays, on both kinds, for a host
 * that was rebuilt and should simply be re-pinned on its next connection. An
 * SSH host key that changes is refused outright — there is no pending key to
 * trust, only the pin to delete.
 *
 * The pins held in a decommissioned agent host's archive (business rule 123)
 * are listed last, read-only, with an "Archived" badge and the asset they
 * belong to; the kind menu's Archived shows only those. They go back when the
 * asset is reactivated, never from here.
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

  function errText(err) {
    return (err && err.message) || "unknown error";
  }

  // Both lists in one go. A failure of one still shows the other, with the
  // failure named, rather than blanking the whole surface.
  function loadPins() {
    return Promise.all([
      api.serverSettings.tlsCertPinsList().then(function (r) { return { rows: (r && r.certPins) || [] }; },
        function (err) { return { rows: [], error: err }; }),
      api.serverSettings.sshHostKeysList().then(function (r) { return { rows: (r && r.hostKeys) || [] }; },
        function (err) { return { rows: [], error: err }; }),
      // Rule 123's archives: shown, never acted on, so a failure is quiet.
      api.serverSettings.archivedHostPinsList().then(function (r) { return { rows: (r && r.archivedPins) || [] }; },
        function () { return { rows: [] }; }),
    ]).then(function (res) {
      return { tls: res[0].rows, ssh: res[1].rows, archived: res[2].rows, tlsError: res[0].error, sshError: res[1].error };
    });
  }

  // ─── Summary + button (what a host page mounts) ──────────────────────────

  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  function renderSummary(container, data) {
    var tls = data.tls.length;
    var ssh = data.ssh.length;
    var archived = (data.archived || []).length;
    var changed = data.tls.filter(function (r) { return !!r.pendingFingerprint; }).length;
    var text = tls + ssh + archived === 0
      ? "Nothing pinned yet. A pin appears the first time Polaris connects to a host over SSH, or sends a password or " +
        "token to a server without verifying a CA: a WinRM listener, a device it upgrades, or a FortiGate / FortiManager " +
        "with SSL verification off."
      : "Pinned: " + plural(tls, "certificate") + " · " + plural(ssh, "SSH host key") +
        (archived ? " · " + archived + " archived" : "") + ".";
    var failed = [data.tlsError && "certificates", data.sshError && "SSH host keys"].filter(Boolean);
    container.innerHTML =
      '<div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">' + escapeHtml(text) + "</span>" +
        (changed ? '<span class="badge badge-conflict">' + changed + " changed</span>" : "") +
        (tls + ssh + archived ? '<button type="button" class="btn btn-sm btn-secondary" data-tls-pins-open>View pinned identities</button>' : "") +
      "</div>" +
      (failed.length
        ? '<p class="empty-state" style="padding:0.35rem 0 0;margin:0">Could not load pinned ' + failed.join(" or ") + ": " +
            escapeHtml(errText(data.tlsError || data.sshError)) + "</p>"
        : "");
    var btn = container.querySelector("[data-tls-pins-open]");
    if (btn) btn.addEventListener("click", function () { open(btn); });
  }

  function loadSummary(container) {
    if (!container) return;
    loadPins().then(function (data) { renderSummary(container, data); });
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
            '<button class="btn-icon" id="tls-pins-close" title="Close" aria-label="Close pinned server identities">&times;</button>' +
          "</div>" +
          '<div class="slideover-meta" id="tls-pins-meta"></div>' +
          // In the header, not the body, so it stays put while the cards
          // scroll. A plain flex row rather than .filter-bar: that is the
          // page-level sticky bar and reads as a slab inside a slide-over.
          '<div id="tls-pins-filters" style="display:flex;gap:6px;margin-top:0.6rem">' +
            '<input type="text" data-pin-filter="q" placeholder="Filter by IP, hostname, thumbprint, subject or key type" ' +
              'aria-label="Filter pinned identities" autocomplete="off" spellcheck="false" ' +
              'style="flex:1 1 auto;min-width:0;padding:0.3rem 0.55rem;font-size:0.8rem">' +
            '<select data-pin-filter="kind" aria-label="Kind of pin" style="flex:0 0 auto;padding:0.3rem 0.55rem;font-size:0.8rem">' +
              '<option value="">All kinds</option>' +
              '<option value="tls">TLS certificates</option>' +
              '<option value="ssh">SSH host keys</option>' +
              '<option value="archived">Archived (decommissioned)</option>' +
            "</select>" +
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
    var filters = document.getElementById("tls-pins-filters");
    filters.addEventListener("input", function () { renderPanel(lastData); });
    filters.addEventListener("change", function () { renderPanel(lastData); });
    return overlay;
  }

  // ─── Filtering ───────────────────────────────────────────────────────────
  // One search field. A value made only of hex digits and the separators a
  // thumbprint is copied with (colons, spaces, dashes) — as openssl or
  // Windows' certificate dialog prints it — matches a certificate's pinned or
  // now-presented SHA-256 with those ignored. Otherwise the value is split on
  // whitespace and every word must appear (case-insensitive) somewhere on the
  // card: address, port, asset hostname or IP, integration, subject, key type
  // or fingerprint — so "10.0 ssh-ed25519" narrows by both. The kind menu's
  // TLS / SSH take archived pins of that kind too; Archived takes only those.

  var lastData = { tls: [], ssh: [], archived: [] };

  function filterValues() {
    var q = document.querySelector('#tls-pins-filters [data-pin-filter="q"]');
    var kind = document.querySelector('#tls-pins-filters [data-pin-filter="kind"]');
    return { q: q ? q.value.trim().toLowerCase() : "", kind: kind ? kind.value : "" };
  }

  function hexOnly(s) {
    return String(s || "").replace(/[^0-9a-f]/gi, "").toLowerCase();
  }

  function haystack(r) {
    var parts = [r.host, r.host + ":" + r.port, r.subject, r.pendingSubject, r.keyType, r.fingerprint, r.pendingFingerprint,
      r.kind === "ssh" ? "ssh host key" : "tls certificate", r.archived ? "archived decommissioned" : ""];
    if (r.asset) parts.push(r.asset.hostname, r.asset.ipAddress);
    (r.assets || []).forEach(function (a) { parts.push(a.hostname, a.ipAddress); });
    (r.integrations || []).forEach(function (i) { parts.push(i.name); });
    return parts.filter(Boolean).join(" ").toLowerCase();
  }

  function matches(r, q) {
    var hex = hexOnly(q);
    if (hex.length >= 4 && /^[0-9a-f:\s-]+$/.test(q) &&
        (hexOnly(r.fingerprint).indexOf(hex) >= 0 || hexOnly(r.pendingFingerprint).indexOf(hex) >= 0)) return true;
    var hay = haystack(r);
    return q.split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  // Changed certificates first (what an administrator opened this for), then
  // by address so a host's certificate and host key sit together, and the
  // archived ones (which nothing dials any more) last.
  function combined(data) {
    var all = data.tls.map(function (r) { return Object.assign({ kind: "tls" }, r); })
      .concat(data.ssh.map(function (r) { return Object.assign({ kind: "ssh" }, r); }))
      .concat((data.archived || []).map(function (r) { return Object.assign({}, r, { archived: true }); }));
    function rank(r) { return r.pendingFingerprint ? 0 : r.archived ? 2 : 1; }
    return all.sort(function (a, b) {
      var ca = rank(a);
      var cb = rank(b);
      if (ca !== cb) return ca - cb;
      var h = String(a.host).localeCompare(String(b.host), undefined, { numeric: true });
      if (h) return h;
      if (a.kind !== b.kind) return a.kind === "tls" ? -1 : 1;
      return a.port - b.port;
    });
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
    loadPins().then(renderPanel);
  }

  function assetLinks(r) {
    if (!r.assets || !r.assets.length) return '<span style="color:var(--color-text-tertiary)">No asset at this address</span>';
    return r.assets.map(function (a) {
      var name = a.hostname || a.ipAddress || "Asset";
      return '<a href="/assets.html#view=asset:' + encodeURIComponent(a.id) + '">' + escapeHtml(name) + "</a>" +
        (a.hostname && a.ipAddress ? ' <span style="color:var(--color-text-tertiary)">' + escapeHtml(a.ipAddress) + "</span>" : "");
    }).join("<br>");
  }

  function cardShell(r, changed, cls, kindLabel, badgeHtml, rowsHtml, actions) {
    return '<div class="pin-card ' + cls + '" style="border:1px solid ' + (changed ? "var(--color-danger, #c0392b)" : "var(--color-border)") +
        ';border-radius:var(--radius-md, 8px);padding:0.75rem 0.9rem;margin-bottom:0.75rem">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.35rem">' +
        '<span><span class="mono" style="font-weight:600">' + escapeHtml(r.host + ":" + r.port) + "</span>" +
          ' <span style="color:var(--color-text-secondary);font-size:0.8rem">' + kindLabel + "</span></span>" +
        badgeHtml +
      "</div>" +
      rowsHtml +
      (actions ? '<div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:0.5rem">' + actions + "</div>" : "") +
    "</div>";
  }

  function tlsCard(r, canManage) {
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
    return cardShell(r, changed, "tls-pin-card", "TLS certificate",
      changed ? '<span class="badge badge-conflict">Certificate changed</span>' : '<span class="badge badge-active">Pinned</span>',
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
      row("Last seen", escapeHtml(when(r.lastSeen))),
      actions);
  }

  function sshCard(r, canManage) {
    var actions = canManage
      ? '<button type="button" class="btn btn-sm btn-secondary" data-ssh-del="' + escapeHtml(r.id) + '" data-pin-host="' +
          escapeHtml(r.host + ":" + r.port) + '">Delete</button>'
      : "";
    return cardShell(r, false, "ssh-pin-card", "SSH host key", '<span class="badge badge-active">Pinned</span>',
      row("Asset", assetLinks(r)) +
      row("Key type", escapeHtml(r.keyType || "—")) +
      // Already the `ssh-keygen -lf` form (SHA256:<base64>), so shown as is.
      row("Fingerprint", '<code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(r.fingerprint || "—") + "</code>", true) +
      row("First seen", escapeHtml(when(r.firstSeen))) +
      row("Last seen", escapeHtml(when(r.lastSeen))),
      actions);
  }

  // Rule 123: a decommissioned agent host's pin, held off the live tables.
  // Read-only — it goes back only when the asset is reactivated or its agent's
  // check-in conflict is accepted, so Delete / Trust would bypass the rule.
  function archivedCard(r) {
    var a = r.asset || {};
    var assetHtml = a.id
      ? '<a href="/assets.html#view=asset:' + encodeURIComponent(a.id) + '">' + escapeHtml(a.hostname || a.ipAddress || "Asset") + "</a>" +
        (a.hostname && a.ipAddress ? ' <span style="color:var(--color-text-tertiary)">' + escapeHtml(a.ipAddress) + "</span>" : "")
      : '<span style="color:var(--color-text-tertiary)">—</span>';
    var fp = r.kind === "ssh" ? r.fingerprint : fmt(r.fingerprint);
    return cardShell(r, false, "archived-pin-card", r.kind === "ssh" ? "SSH host key" : "TLS certificate",
      '<span class="badge badge-maintenance">Archived</span>',
      row("Asset", assetHtml) +
      (r.kind === "ssh" ? row("Key type", escapeHtml(r.keyType || "—")) : row("Subject", escapeHtml(r.subject || "—"))) +
      row(r.kind === "ssh" ? "Fingerprint" : "SHA-256", '<code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(fp || "—") + "</code>", true) +
      row("Archived", escapeHtml(when(r.archivedAt)) + ' <span style="color:var(--color-text-secondary)">on decommission &mdash; restored when the asset is reactivated</span>') +
      row("First seen", escapeHtml(when(r.firstSeen))),
      "");
  }

  function renderPanel(data) {
    var body = document.getElementById("tls-pins-body");
    var meta = document.getElementById("tls-pins-meta");
    if (!body) return;
    lastData = data = data || { tls: [], ssh: [], archived: [] };
    var rows = combined(data);
    var changed = data.tls.filter(function (r) { return !!r.pendingFingerprint; }).length;
    var archivedCount = (data.archived || []).length;
    var f = filterValues();
    var filtering = !!(f.q || f.kind);
    var shown = !filtering ? rows : rows.filter(function (r) {
      var kindOk = !f.kind || (f.kind === "archived" ? !!r.archived : r.kind === f.kind);
      return kindOk && (!f.q || matches(r, f.q));
    });
    meta.innerHTML = '<span style="color:var(--color-text-secondary);font-size:0.85rem">' +
      (filtering ? shown.length + " of " : "") + rows.length + " pinned" +
      (changed ? " · " + changed + " changed" : "") +
      (archivedCount ? " · " + archivedCount + " archived" : "") + "</span>";
    var failed = [data.tlsError && "certificates", data.sshError && "SSH host keys"].filter(Boolean);
    var failHtml = failed.length
      ? '<p class="empty-state" style="padding:1rem 1.25rem 0;margin:0">Could not load pinned ' + failed.join(" or ") + ": " +
          escapeHtml(errText(data.tlsError || data.sshError)) + "</p>"
      : "";
    if (!rows.length) {
      body.innerHTML = failHtml + (failed.length === 2 ? "" : '<p class="empty-state" style="padding:1rem 1.25rem">Nothing pinned yet.</p>');
      return;
    }
    if (!shown.length) {
      body.innerHTML = failHtml + '<p class="empty-state" style="padding:1rem 1.25rem">No pinned identity matches the filter.</p>';
      return;
    }
    var canManage = typeof permAtLeast === "function" && permAtLeast("serverSettingsSystem", "write");
    body.innerHTML = failHtml + '<div style="padding:1rem 1.25rem">' + shown.map(function (r) {
      if (r.archived) return archivedCard(r);
      return r.kind === "ssh" ? sshCard(r, canManage) : tlsCard(r, canManage);
    }).join("") + "</div>";
  }

  function afterChange(message) {
    showToast(message, "success");
    loadPanel();
    refreshSummaries();
  }

  function onBodyClick(e) {
    var trust = e.target.closest ? e.target.closest("[data-pin-trust]") : null;
    var del = e.target.closest ? e.target.closest("[data-pin-del]") : null;
    var sshDel = e.target.closest ? e.target.closest("[data-ssh-del]") : null;
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
          .then(function () { afterChange("Trusted the new certificate of " + hostPort); })
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
          .then(function () { afterChange("Pin deleted"); })
          .catch(function (err) { del.disabled = false; showToast((err && err.message) || "Could not delete the pin", "error"); });
      });
    } else if (sshDel) {
      var sh = sshDel.getAttribute("data-pin-host");
      showConfirm(
        "Delete the pinned SSH host key for " + sh + "?\n\n" +
        "The next connection to this host will trust and pin whatever answers. Only do this if you know the host " +
        "was legitimately rebuilt or re-keyed — otherwise you would be accepting an impersonator."
      ).then(function (ok) {
        if (!ok) return;
        sshDel.disabled = true;
        api.serverSettings.sshHostKeyDelete(sshDel.getAttribute("data-ssh-del"))
          .then(function () { afterChange("Pin deleted"); })
          .catch(function (err) { sshDel.disabled = false; showToast((err && err.message) || "Could not delete the pin", "error"); });
      });
    }
  }

  window.PolarisPinnedTlsCerts = { mount: mount, open: open, formatFingerprint: fmt };
})();
