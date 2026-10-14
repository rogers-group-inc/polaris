/**
 * public/js/pinned-tls-certs.js — the Pinned TLS certificates table (business
 * rule 113), shared by Server Settings → Web Server and the Windows SSH
 * Deployment card on Integrations.
 *
 * window.PolarisPinnedTlsCerts.mount(containerEl) renders every pin Polaris
 * holds — WinRM listeners, devices it upgrades, and since rule 113(e) every
 * FortiGate / FortiManager it talks to with SSL verification off. A pin whose
 * server now presents a DIFFERENT certificate is listed first with both
 * SHA-256 fingerprints and "Trust new certificate", which pins exactly the
 * certificate shown (rule 113(f)); Delete stays for a host that was rebuilt
 * and should simply be re-pinned on its next connection.
 *
 * Needs api.js and app.js (escapeHtml, showToast, showConfirm, permAtLeast).
 */
(function () {
  "use strict";

  function fmt(fp) {
    var hex = String(fp || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
    return hex.replace(/(..)(?=.)/g, "$1:");
  }

  function date(d) {
    return d ? new Date(d).toLocaleDateString() : "—";
  }

  function render(container, rows) {
    if (!rows || !rows.length) {
      container.innerHTML = '<p class="empty-state" style="padding:0.5rem 0;margin:0">No certificates pinned yet. ' +
        'A pin appears the first time Polaris sends a password or token to a server without verifying a CA: a WinRM ' +
        'listener, a device it upgrades, or a FortiGate / FortiManager with SSL verification off.</p>';
      return;
    }
    var canManage = typeof permAtLeast === "function" && permAtLeast("serverSettingsSystem", "write");
    var body = rows.map(function (r) {
      var changed = !!r.pendingFingerprint;
      var fpCell = changed
        ? '<div><span style="color:var(--color-text-secondary)">Pinned</span> <code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(fmt(r.fingerprint)) + '</code></div>' +
          '<div><span style="color:var(--color-danger, #c0392b);font-weight:600">Now presents</span> <code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(fmt(r.pendingFingerprint)) + '</code>' +
            (r.pendingSubject ? ' <span style="color:var(--color-text-secondary)">(' + escapeHtml(r.pendingSubject) + ')</span>' : '') +
            ' <span style="color:var(--color-text-secondary)">since ' + escapeHtml(date(r.pendingSeenAt)) + '</span></div>'
        : '<code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(fmt(r.fingerprint)) + '</code>';
      var actions = "";
      if (canManage) {
        if (changed) {
          actions += '<button class="btn btn-sm btn-primary" data-pin-trust="' + escapeHtml(r.id) + '" data-pin-fp="' + escapeHtml(r.pendingFingerprint) +
            '" data-pin-host="' + escapeHtml(r.host + ":" + r.port) + '">Trust new certificate</button> ';
        }
        actions += '<button class="btn btn-sm btn-secondary" data-pin-del="' + escapeHtml(r.id) + '" data-pin-host="' + escapeHtml(r.host + ":" + r.port) + '">Delete</button>';
      }
      return '<tr' + (changed ? ' style="background:var(--color-bg-warning, rgba(231,76,60,0.08))"' : '') + '>' +
        '<td class="mono">' + escapeHtml(r.host) + ":" + escapeHtml(String(r.port)) +
          (changed ? '<div><span class="badge badge-danger">Certificate changed</span></div>' : '') + '</td>' +
        '<td>' + escapeHtml(r.subject || "—") + '</td>' +
        '<td>' + fpCell + '</td>' +
        '<td>' + escapeHtml(date(r.firstSeen)) + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' + actions + '</td>' +
      '</tr>';
    }).join("");
    container.innerHTML =
      '<table class="data-table"><thead><tr>' +
        '<th>Host</th><th>Subject</th><th>SHA-256</th><th>First seen</th><th></th>' +
      '</tr></thead><tbody>' + body + '</tbody></table>';

    Array.prototype.forEach.call(container.querySelectorAll("[data-pin-trust]"), function (btn) {
      btn.addEventListener("click", function () {
        var hostPort = btn.getAttribute("data-pin-host");
        var fp = btn.getAttribute("data-pin-fp");
        showConfirm(
          "Trust the new certificate of " + hostPort + "?\n\nSHA-256 " + fmt(fp) + "\n\n" +
          "Check it against the server first (on a FortiGate: System → Certificates, or `openssl s_client -connect " + hostPort + "`). " +
          "From now on Polaris sends its password or token only to this certificate."
        ).then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          api.serverSettings.tlsCertPinTrust(btn.getAttribute("data-pin-trust"), fp)
            .then(function () { showToast("Trusted the new certificate of " + hostPort, "success"); load(container); })
            .catch(function (err) { btn.disabled = false; showToast((err && err.message) || "Could not trust the certificate", "error"); });
        });
      });
    });
    Array.prototype.forEach.call(container.querySelectorAll("[data-pin-del]"), function (btn) {
      btn.addEventListener("click", function () {
        var hostPort = btn.getAttribute("data-pin-host");
        showConfirm(
          "Delete the pinned TLS certificate for " + hostPort + "?\n\n" +
          "The next connection will trust and pin whatever certificate answers. To accept a certificate you have " +
          "already compared, use Trust new certificate instead."
        ).then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          api.serverSettings.tlsCertPinDelete(btn.getAttribute("data-pin-del"))
            .then(function () { showToast("Pin deleted", "success"); load(container); })
            .catch(function (err) { btn.disabled = false; showToast((err && err.message) || "Could not delete the pin", "error"); });
        });
      });
    });
  }

  function load(container) {
    if (!container) return;
    api.serverSettings.tlsCertPinsList()
      .then(function (r) { render(container, r && r.certPins); })
      .catch(function (err) {
        container.innerHTML = '<p class="empty-state" style="padding:0.5rem 0;margin:0">Could not load pinned certificates: ' +
          escapeHtml((err && err.message) || "unknown error") + "</p>";
      });
  }

  window.PolarisPinnedTlsCerts = { mount: load, formatFingerprint: fmt };
})();
