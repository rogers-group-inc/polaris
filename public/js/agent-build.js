// ─── Polaris Agent build card ──────────────────────────────────────────────
//
// Standalone module loaded by integrations.html. Renders the agent build
// inventory + Build button + progress strip + auto-build toggle + server-URL
// stamp + installed-agents summary + bulk Upgrade-all into a container with
// id="agent-build-body". The container is created and mounted by
// integrations.js when the "Polaris Agents" sub-tab is activated.
//
// Three states for the card body:
//   1. No manifest on disk           → "No binaries built yet" + Build button.
//   2. Manifest present, build idle  → inventory grid + Build button + version
//                                      drift hint when agent/VERSION moved.
//   3. Build in flight               → progress strip (poll every 2 s).
//
// On mount, we fetch /inventory AND /build/current in parallel. If a build
// is currently running, we immediately render the progress strip and start
// polling — this rehydrates an operator's view when they switched away
// mid-build.
//
// Dependencies (all globals from app.js or api.js):
//   - api.serverSettings.* (agentInventory / agentBuildCurrent / agentBuildStatus
//     / agentBuildStart / agentBuildCancel / agentPrune / agentServerUrlSet /
//     agentAutoBuildSettingGet / agentAutoBuildSettingSet / agentInstalledSummary
//     / agentUpgradeAll)
//   - escapeHtml, showToast, showConfirm

(function () {
  "use strict";

  var _agentBuildPollTimer = null;
  var _installedSummaryPollTimer = null;
  var _agentListPollTimer = null;

  // Lightweight time formatters local to this module so it stays self-
  // contained — the server-settings.js page has richer formatters (with
  // TZ override) but integrations.html doesn't need that complexity.
  function _formatLocalDateTime(iso) {
    try { return new Date(iso).toLocaleString(); }
    catch (_) { return iso || "—"; }
  }
  // Relative time + byte size come from the api.js canonical helpers
  // (2026-08 audit): _timeAgo previously capped at hours ("36h ago"), and
  // _humanBytes used KiB/MiB labels unlike every other surface.
  var _timeAgo = timeAgo;
  var _humanBytes = formatBytes;
  function _formatElapsed(ms) {
    if (ms < 1000) return ms + " ms";
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + "." + Math.floor((ms % 1000) / 100) + " s";
    var m = Math.floor(s / 60);
    return m + "m " + (s % 60) + "s";
  }

  // Compute the SHA-256 fingerprint of an X.509 cert PEM file's DER bytes,
  // returning "sha256:<lowercase-hex>". Matches what the server's
  // certInfo.getServerCertFingerprint() returns byte-for-byte (server hashes
  // x509.raw — that IS the DER). Used by the Cert pin rotation pane's
  // Generate button so operators can fill the pin input from a local
  // .pem/.crt/.cer without copy-pasting from openssl output.
  //
  // Client-side only: the file is read via FileReader and hashed via
  // window.crypto.subtle.digest. Never uploaded.
  //
  // PEM parsing: handles multi-cert chains by picking the FIRST CERTIFICATE
  // block (the leaf is conventionally first; if your file orders it
  // differently, paste the leaf separately). Ignores PRIVATE KEY blocks if
  // the operator accidentally points at a combined cert+key file.
  function _computeCertPinFromPemFile(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () { reject(new Error("Could not read file")); };
      reader.onload = function () {
        try {
          var text = String(reader.result || "");
          var match = text.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
          if (!match) {
            reject(new Error("No CERTIFICATE block found — is this a PEM file?"));
            return;
          }
          var b64 = match[1].replace(/\s+/g, "");
          var binary;
          try { binary = atob(b64); }
          catch (_) { reject(new Error("Cert body is not valid base64")); return; }
          var der = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
          window.crypto.subtle.digest("SHA-256", der).then(function (hashBuf) {
            var bytes = new Uint8Array(hashBuf);
            var hex = "";
            for (var j = 0; j < bytes.length; j++) {
              var h = bytes[j].toString(16);
              hex += h.length === 1 ? "0" + h : h;
            }
            resolve("sha256:" + hex);
          }).catch(function (e) {
            reject(new Error("SHA-256 failed: " + (e && e.message || e)));
          });
        } catch (e) {
          reject(e);
        }
      };
      reader.readAsText(file);
    });
  }

  function initAgentBuildCard() {
    Promise.all([
      api.serverSettings.agentInventory().catch(function () { return null; }),
      api.serverSettings.agentBuildCurrent().catch(function () { return { current: null, queue: [] }; }),
    ]).then(function (results) {
      var inv     = results[0];
      var current = results[1] && results[1].current;
      var queue   = (results[1] && results[1].queue) || [];
      if (current && current.phase !== "complete" && current.phase !== "failed") {
        renderAgentBuildProgress(current, queue);
        startAgentBuildPoll(current.buildId);
      } else {
        renderAgentBuildInventory(inv);
      }
    });
  }

  function renderAgentBuildInventory(inv) {
    var body = document.getElementById("agent-build-body");
    if (!body) return;
    if (!inv) {
      body.innerHTML = '<p class="empty-state" style="padding:1rem 0">Failed to load agent build inventory.</p>';
      return;
    }

    // Go-detection: when Go isn't installed, gate the whole Build pathway
    // with a yellow notice. Inventory grid still renders (operators may
    // have staged binaries from a separate build host).
    // "Too old" is reported separately from "not installed": they need
    // different actions, and the old copy sent an operator with Go 1.21 off
    // to install a toolchain they already had.
    // No literal fallback: a hardcoded floor here outlived three toolchain
    // moves and told operators to install a Go the preflight then refused.
    // The server owns the number (GO_MINIMUM); if it is missing from the
    // payload, say "Go" without one rather than a stale one.
    var goMin = inv.goMinimum || "";
    var goMinTxt = goMin ? " " + escapeHtml(goMin) + "+" : "";
    var goNotice = "";
    if (!inv.goAvailable || inv.goTooOld) {
      goNotice =
        '<div style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(255,160,40,0.08);' +
          'border-left:3px solid var(--color-warning);border-radius:4px;font-size:0.82rem;color:var(--color-warning)">' +
          (inv.goTooOld
            ? '⚠ Go ' + escapeHtml(inv.goVersion || "") + ' is installed, but building the agent requires Go' +
              goMinTxt + '. Upgrade the toolchain on this host and reload.'
            : '⚠ Go is not installed on this Polaris server. Install Go' + goMinTxt + ' on the host (see ' +
              '<code>docs/INSTALL.md</code> → "Optional: Polaris Agent") and reload to enable the Build button.') +
        '</div>';
    }

    // Version-drift hint: manifest's currentVersion lags getAgentVersion().
    var drift = "";
    if (inv.manifest && inv.manifest.currentVersion !== inv.agentSourceVersion) {
      drift =
        '<div style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(80,150,255,0.08);' +
          'border-left:3px solid var(--color-accent);border-radius:4px;font-size:0.82rem">' +
          'Agent source has moved to <strong>v' + escapeHtml(inv.agentSourceVersion) + '</strong>; built binaries are still ' +
          '<strong>v' + escapeHtml(inv.manifest.currentVersion) + '</strong>. Click Build to refresh.' +
        '</div>';
    } else if (!inv.manifest) {
      drift =
        '<div style="margin-bottom:0.75rem;padding:0.5rem 0.75rem;background:rgba(80,150,255,0.08);' +
          'border-left:3px solid var(--color-accent);border-radius:4px;font-size:0.82rem">' +
          'No agent binaries built yet. Click Build to produce <strong>v' + escapeHtml(inv.agentSourceVersion) + '</strong>.' +
        '</div>';
    }

    var rows = inv.files.map(function (f) {
      var key  = f.platform + "-" + f.arch;
      var size = f.present && f.sizeBytes != null ? _humanBytes(f.sizeBytes) : "—";
      var when = f.present && f.mtime ? _formatLocalDateTime(f.mtime) : "—";
      var mark = f.present
        ? '<span style="color:var(--color-success)">✓</span>'
        : '<span style="color:var(--color-text-tertiary)">—</span>';
      return '<tr>' +
        '<td style="padding:4px 8px"><code>' + escapeHtml(key) + '</code></td>' +
        '<td style="padding:4px 8px;text-align:right">' + escapeHtml(size) + '</td>' +
        '<td style="padding:4px 8px;font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(when) + '</td>' +
        '<td style="padding:4px 8px;text-align:center">' + mark + '</td>' +
        '</tr>';
    }).join("");

    var buildBtn = inv.goAvailable && !inv.goTooOld
      ? '<button class="btn btn-primary" id="btn-agent-build">Build agent binaries (v' + escapeHtml(inv.agentSourceVersion) + ')</button>'
      : '<button class="btn btn-primary" disabled title="' +
        (inv.goTooOld
          ? 'Go ' + escapeHtml(inv.goVersion || "") + ' is too old — upgrade to Go' + goMinTxt + ' to enable'
          : 'Install Go' + goMinTxt + ' on the server to enable') +
        '">Build agent binaries</button>';

    var goVerLine = inv.goAvailable && inv.goVersion
      ? '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.5rem 0 0">Toolchain: ' + escapeHtml(inv.goVersion) + '</p>'
      : '';

    var oldVersions = inv.oldVersions || [];
    var cleanupLine = "";
    if (oldVersions.length > 0) {
      var totalBytes = oldVersions.reduce(function (s, v) { return s + (v.bytes || 0); }, 0);
      cleanupLine =
        '<div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--color-border);' +
            'display:flex;align-items:center;gap:0.5rem;font-size:0.85rem">' +
          '<span style="color:var(--color-text-secondary);flex:1">' +
            oldVersions.length + ' old version' + (oldVersions.length > 1 ? "s" : "") +
            ' on disk (up to ' + escapeHtml(_humanBytes(totalBytes)) + ')' +
          '</span>' +
          '<button class="btn btn-secondary" id="btn-agent-prune" style="padding:4px 12px;font-size:0.8rem">Clean up</button>' +
        '</div>';
    }

    // Server-URL row: input pre-filled with the effective URL the agent
    // would dial right now. The cert-derived default sits underneath as
    // a hint so the operator can see what they'd inherit if they cleared
    // the override.
    var srvUrl = inv.serverUrl || { effective: "", override: null, derived: "" };
    var srvUrlVal = srvUrl.override != null ? srvUrl.override : (srvUrl.derived || srvUrl.effective || "");
    var srvUrlHint = srvUrl.override != null
      ? 'Override active. Cert-derived default would be: <code>' + escapeHtml(srvUrl.derived || "—") + '</code>'
      : 'Derived from the HTTPS certificate. Edit to override.';
    var serverUrlRow =
      '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);font-size:0.85rem">' +
        '<label for="agent-server-url-input" style="display:block;margin-bottom:0.3rem;color:var(--color-text-secondary)">' +
          'Server URL stamped into agent.conf' +
          (srvUrl.override != null
            ? ' <span style="font-size:0.72rem;color:var(--color-accent);font-weight:600;margin-left:0.4rem">OVERRIDE</span>'
            : "") +
        '</label>' +
        '<div style="display:flex;gap:0.5rem;align-items:center">' +
          '<input type="text" id="agent-server-url-input" value="' + escapeHtml(srvUrlVal) + '" ' +
            'placeholder="' + escapeHtml(srvUrl.derived || "https://your-host:443") + '" ' +
            'style="flex:1;padding:5px 8px;font-family:var(--font-mono, monospace);font-size:0.85rem">' +
          '<button class="btn btn-secondary" id="btn-agent-server-url-save" style="padding:4px 14px;font-size:0.8rem">Save</button>' +
        '</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0">' + srvUrlHint + '</p>' +
      '</div>';

    var autoUpgradeRow =
      '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);' +
          'display:flex;align-items:center;gap:8px;font-size:0.85rem">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">' +
          '<input type="checkbox" id="agent-auto-upgrade-toggle" style="width:15px;height:15px;flex-shrink:0">' +
          '<span>Auto-upgrade installed agents when a new build is available</span>' +
        '</label>' +
      '</div>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0 23px">' +
        'After every successful build, fans out the new binary to every active agent whose version lags. ' +
        'Each host briefly bounces its agent service; bearer + cert pin survive. Default off — leave disabled if you want ' +
        'every fleet-wide upgrade to be human-initiated.' +
      '</p>';

    // Cert-pin rotation slot. Populated async by renderAgentCertPinRotation()
    // after the main inventory renders — it queries the fleet-wide pin summary
    // separately so a slow query doesn't block the rest of the card.
    var certPinRotationSlot =
      '<div id="agent-cert-pin-rotation" style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);font-size:0.85rem">' +
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Cert pin rotation</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 0.5rem 0">Loading pin set...</p>' +
      '</div>';

    // Code-signing slot. Populated async by renderAgentCodeSigning() —
    // same separate-fetch pattern as the cert-pin pane above.
    var codeSigningSlot =
      '<div id="agent-code-signing" style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);font-size:0.85rem">' +
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Code signing (internal CA)</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 0.5rem 0">Loading signing config...</p>' +
      '</div>';

    var installedSummarySlot = '<div id="agent-installed-summary"></div>';

    // "Installed agents" entry point — opens the fleet slide-in listing every
    // host with the agent installed (version + architecture + per-host
    // reinstall / upgrade / remove). Always shown; the slide-in renders an
    // empty state when no agents are installed yet.
    var installedListRow =
      '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);' +
          'display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap">' +
        '<button class="btn btn-secondary" id="btn-agent-installed-list" style="padding:4px 14px;font-size:0.85rem">Installed agents</button>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary);flex:1;min-width:220px">' +
          'View every host with the agent installed — version, architecture, and per-host reinstall / upgrade / remove.' +
        '</span>' +
      '</div>';

    body.innerHTML =
      goNotice +
      drift +
      '<table style="width:100%;border-collapse:collapse;margin-bottom:0.75rem;font-size:0.85rem">' +
        '<thead><tr style="border-bottom:1px solid var(--color-border)">' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Platform</th>' +
          '<th style="padding:4px 8px;text-align:right;font-weight:600;color:var(--color-text-secondary)">Size</th>' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Built</th>' +
          '<th style="padding:4px 8px;text-align:center;font-weight:600;color:var(--color-text-secondary)">Present</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
      '<div>' + buildBtn + '</div>' +
      goVerLine +
      installedSummarySlot +
      installedListRow +
      cleanupLine +
      serverUrlRow +
      autoUpgradeRow +
      certPinRotationSlot +
      codeSigningSlot;

    var btn = document.getElementById("btn-agent-build");
    if (btn) btn.addEventListener("click", onAgentBuildClick);
    var installedListBtn = document.getElementById("btn-agent-installed-list");
    if (installedListBtn) installedListBtn.addEventListener("click", openInstalledAgentsPanel);
    var pruneBtn = document.getElementById("btn-agent-prune");
    if (pruneBtn) pruneBtn.addEventListener("click", onAgentPruneClick);

    var srvSaveBtn = document.getElementById("btn-agent-server-url-save");
    var srvInput   = document.getElementById("agent-server-url-input");
    if (srvSaveBtn && srvInput) {
      srvSaveBtn.addEventListener("click", function () {
        var raw = (srvInput.value || "").trim();
        var sendVal = raw === "" ? "" : raw;
        srvSaveBtn.disabled = true;
        api.serverSettings.agentServerUrlSet(sendVal).then(function () {
          showToast(sendVal ? "Agent server URL updated" : "Agent server URL override cleared", "success");
          api.serverSettings.agentInventory().then(renderAgentBuildInventory);
        }).catch(function (err) {
          showToast("Failed: " + err.message, "error");
          srvSaveBtn.disabled = false;
        });
      });
    }

    var autoUpgradeToggle = document.getElementById("agent-auto-upgrade-toggle");
    if (autoUpgradeToggle) {
      api.serverSettings.agentAutoUpgradeSettingGet().then(function (s) {
        autoUpgradeToggle.checked = s.enabled === true;
      }).catch(function () {
        autoUpgradeToggle.checked = false;
      });
      autoUpgradeToggle.addEventListener("change", function () {
        api.serverSettings.agentAutoUpgradeSettingSet(autoUpgradeToggle.checked).catch(function (err) {
          showToast("Failed to save setting: " + err.message, "error");
          autoUpgradeToggle.checked = !autoUpgradeToggle.checked;
        });
      });
    }

    // Installed-summary slot + live upgrade-all status panel.
    // refreshInstalledSummary populates the slot from the latest
    // /agents/installed-summary response. When there are agents
    // currently upgrading (installStatus="upgrading") OR upgrade_failed
    // rows that haven't been acknowledged, the panel auto-polls every
    // 2.5 s. The poll loop reconstructs status from DB state, so the
    // panel survives page reloads / tab switches mid-upgrade.
    refreshInstalledSummary();

    // Cert pin rotation pane. Loaded async; failure leaves the slot showing
    // a one-line error so operators know to refresh.
    renderAgentCertPinRotation();

    // Code-signing pane — same async-slot pattern.
    renderAgentCodeSigning();
  }

  // Populate the #agent-installed-summary slot with the latest counts
  // from /agents/installed-summary and bind the Upgrade-all button.
  // When `upgrading > 0` (an upgrade-all is fanning out in real time)
  // OR `upgradeFailed > 0` (operator needs to see the failures), keep
  // polling on a 2.5 s tick so the counts tick down live. When neither
  // is true the timer is stopped — no background work after the panel
  // settles.
  function refreshInstalledSummary() {
    api.serverSettings.agentInstalledSummary().then(function (s) {
      var slot = document.getElementById("agent-installed-summary");
      if (!slot) return;
      slot.innerHTML = _renderInstalledSummaryHTML(s);
      _wireInstalledSummary(s);
      // Schedule the next poll if there's still in-flight work.
      var stillBusy = (s.upgrading && s.upgrading > 0) || (s.upgradeFailed && s.upgradeFailed > 0);
      if (_installedSummaryPollTimer) {
        clearTimeout(_installedSummaryPollTimer);
        _installedSummaryPollTimer = null;
      }
      if (stillBusy) {
        _installedSummaryPollTimer = setTimeout(refreshInstalledSummary, 2500);
      }
    }).catch(function () { /* leave whatever was there */ });
  }

  function _renderInstalledSummaryHTML(s) {
    if (!s || !s.totalActive) {
      // No installed agents at all — drop the panel entirely.
      return "";
    }
    // Active upgrade-all in flight: render the live status panel with
    // counts of upgrading / failed / current. Operators reload-safe.
    if (s.upgrading > 0 || s.upgradeFailed > 0 || s.outOfDate > 0) {
      var parts = [];
      if (s.upgrading > 0) {
        parts.push(
          '<span style="color:var(--color-accent)"><strong>' + s.upgrading + '</strong> upgrading</span>'
        );
      }
      var current = s.byVersion && s.currentVersion ? (s.byVersion[s.currentVersion] || 0) : 0;
      if (current > 0 && s.currentVersion) {
        parts.push(
          '<span style="color:var(--color-success)"><strong>' + current + '</strong> on v' +
          escapeHtml(s.currentVersion) + '</span>'
        );
      }
      if (s.outOfDate > 0) {
        parts.push(
          '<span style="color:var(--color-text-secondary)"><strong>' + s.outOfDate + '</strong> out-of-date</span>'
        );
      }
      if (s.upgradeFailed > 0) {
        parts.push(
          '<span style="color:var(--color-danger)"><strong>' + s.upgradeFailed + '</strong> failed</span>'
        );
      }
      var statusLine = parts.join(' <span style="color:var(--color-text-tertiary)">·</span> ');

      // Upgrade-all button: visible only when there's stale work AND
      // nothing currently upgrading (so a second click doesn't fan out
      // a duplicate batch on top of one already running). Disabled when
      // no current manifest version.
      var upgradeBtn = "";
      if (s.outOfDate > 0 && (s.upgrading || 0) === 0) {
        upgradeBtn =
          '<button class="btn btn-secondary" id="btn-agent-upgrade-all" style="padding:4px 12px;font-size:0.8rem">' +
            'Upgrade all' +
          '</button>';
      } else if (s.upgrading > 0) {
        upgradeBtn =
          '<button class="btn btn-secondary" disabled style="padding:4px 12px;font-size:0.8rem;opacity:0.6">' +
            'Upgrading…' +
          '</button>';
      }
      // Acknowledge-failed button: clears the failure noise from the
      // panel. (Failed rows stay on the asset's Polaris Agent panel —
      // this just dismisses the aggregate counter on the build card.)
      var ackBtn = "";
      if (s.upgradeFailed > 0 && (s.upgrading || 0) === 0) {
        ackBtn =
          ' <button class="btn-icon" id="btn-agent-upgrade-failed-ack" style="padding:2px 8px;font-size:0.75rem" ' +
            'title="Dismiss the failed-counter. Per-asset failures remain visible on each asset\'s Polaris Agent panel.">' +
            '×' +
          '</button>';
      }
      return (
        '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border);' +
            'display:flex;align-items:center;gap:0.5rem;font-size:0.85rem">' +
          '<span style="flex:1">' + statusLine + ackBtn + '</span>' +
          upgradeBtn +
        '</div>'
      );
    }
    // Steady state — everything on the current version.
    return (
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.5rem 0 0">' +
        s.totalActive + ' installed agent' + (s.totalActive > 1 ? "s" : "") +
        ' running v' + escapeHtml(s.currentVersion || "?") + ' (current).' +
      '</p>'
    );
  }

  function _wireInstalledSummary(s) {
    var btn = document.getElementById("btn-agent-upgrade-all");
    if (btn) {
      btn.addEventListener("click", function () {
        showConfirm(
          "Push the new agent binary to all " + s.outOfDate + " out-of-date host" + (s.outOfDate > 1 ? "s" : "") + "?\n\n" +
          "Each host briefly bounces its agent service while the binary is replaced. " +
          "Bearers and cert pins are preserved — no re-enrollment required."
        ).then(function (ok) {
          if (!ok) return;
          btn.disabled = true;
          api.serverSettings.agentUpgradeAll().then(function (r) {
            showToast("Queued " + r.queued + " of " + r.eligible + " upgrade(s)", "success");
            // Kick the live poll immediately so the status panel shows
            // upgrading=N right away rather than waiting for a manual refresh.
            refreshInstalledSummary();
          }).catch(function (err) {
            showToast("Upgrade-all failed: " + err.message, "error");
            btn.disabled = false;
          });
        });
      });
    }
    var ackBtn = document.getElementById("btn-agent-upgrade-failed-ack");
    if (ackBtn) {
      ackBtn.addEventListener("click", function () {
        // Local-only dismissal: hide the counter for this card session.
        // Per-asset failure rows live on the asset's Polaris Agent panel
        // and persist until the operator retries or force-removes.
        var slot = document.getElementById("agent-installed-summary");
        if (slot) {
          var ackSummary = Object.assign({}, s, { upgradeFailed: 0 });
          slot.innerHTML = _renderInstalledSummaryHTML(ackSummary);
          _wireInstalledSummary(ackSummary);
        }
      });
    }
  }

  // Renders the Cert pin rotation pane in the slot reserved by
  // renderAgentBuildInventory. Fetches /agents/cert-pins/summary, builds one
  // row per distinct pin with canonical/staged counts and a Retire button,
  // plus a "Stage a new pin" input + button. Phase 2 dual-pin / [[prod-cert-rotation]].
  function renderAgentCertPinRotation() {
    var slot = document.getElementById("agent-cert-pin-rotation");
    if (!slot) return;
    api.serverSettings.agentCertPinsSummary().then(function (s) {
      var pins = s.pins || [];
      var totalActive = s.totalActiveAgents || 0;
      var rowsHtml = "";
      if (totalActive === 0) {
        rowsHtml =
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0.5rem">' +
            'No active agents — staged or retired pins have nothing to apply against until an agent enrolls.' +
          '</p>';
      } else if (pins.length === 0) {
        rowsHtml =
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0.5rem">' +
            'No pins observed across the active fleet — unexpected; check journalctl on the web role.' +
          '</p>';
      } else {
        rowsHtml =
          '<table style="width:100%;border-collapse:collapse;margin:0.3rem 0 0.5rem;font-size:0.8rem">' +
            '<thead><tr style="border-bottom:1px solid var(--color-border)">' +
              '<th style="padding:3px 6px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Pin (SHA-256)</th>' +
              '<th style="padding:3px 6px;text-align:right;font-weight:600;color:var(--color-text-secondary)">Canonical</th>' +
              '<th style="padding:3px 6px;text-align:right;font-weight:600;color:var(--color-text-secondary)">Staged</th>' +
              '<th style="padding:3px 6px;text-align:right;font-weight:600;color:var(--color-text-secondary)"></th>' +
            '</tr></thead><tbody>' +
            pins.map(function (p) {
              // Truncate the pin display — full sha256 is 71 chars including
              // the "sha256:" prefix, too wide for the card.
              var disp = (p.pin || "").slice(0, 19) + "..." + (p.pin || "").slice(-6);
              return '<tr style="border-bottom:1px solid var(--color-border-light, var(--color-border))">' +
                '<td style="padding:3px 6px;font-family:var(--font-mono, monospace);font-size:0.75rem" title="' + escapeHtml(p.pin) + '">' +
                  escapeHtml(disp) +
                '</td>' +
                '<td style="padding:3px 6px;text-align:right">' + (p.canonical || 0) + '</td>' +
                '<td style="padding:3px 6px;text-align:right">' + (p.staged || 0) + '</td>' +
                '<td style="padding:3px 6px;text-align:right">' +
                  '<button class="btn btn-sm btn-secondary" data-retire-pin="' + escapeHtml(p.pin) + '" style="padding:2px 8px;font-size:0.75rem">Retire</button>' +
                '</td>' +
              '</tr>';
            }).join("") +
          '</tbody></table>';
      }

      slot.innerHTML =
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Cert pin rotation</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 0.5rem 0">' +
          'Stage a new pin BEFORE rotating the server cert; agents trust both old and new during the window. ' +
          'After every agent has heartbeated post-rotation, retire the old pin. ' +
          'Total active agents: <strong>' + totalActive + '</strong>' +
        '</p>' +
        rowsHtml +
        '<div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.3rem">' +
          '<input type="text" id="agent-cert-pin-stage-input" ' +
            'placeholder="sha256:abc123...64hex" ' +
            'style="flex:1;padding:5px 8px;font-family:var(--font-mono, monospace);font-size:0.8rem">' +
          // Hidden file input — triggered by the "from file" link below.
          // Client-side SHA-256 via window.crypto.subtle; the file never
          // leaves the browser.
          '<input type="file" id="agent-cert-pin-file-input" accept=".pem,.crt,.cer" style="display:none">' +
          '<button class="btn btn-secondary" id="btn-agent-cert-pin-generate" style="padding:4px 14px;font-size:0.8rem" ' +
            'title="Fill with the SHA-256 of the cert Polaris is currently serving">Generate</button>' +
          '<button class="btn btn-secondary" id="btn-agent-cert-pin-stage" style="padding:4px 14px;font-size:0.8rem">Stage</button>' +
        '</div>' +
        '<p style="font-size:0.75rem;color:var(--color-text-tertiary);margin:0.3rem 0 0">' +
          'Generate fills the SHA-256 of the cert Polaris is currently serving. ' +
          'To stage a DIFFERENT cert\'s pin (typical pre-rotation flow), ' +
          '<a href="#" id="link-agent-cert-pin-from-file" style="color:var(--color-accent);text-decoration:underline;cursor:pointer">compute it from a local .pem file</a> ' +
          '(client-side; the file is not uploaded). ' +
          'Each agent re-saves agent.conf + restarts via systemd on next /config tick when the pin set changes.' +
        '</p>';

      var stageBtn = document.getElementById("btn-agent-cert-pin-stage");
      var stageIn  = document.getElementById("agent-cert-pin-stage-input");
      var genBtn   = document.getElementById("btn-agent-cert-pin-generate");
      var fileIn   = document.getElementById("agent-cert-pin-file-input");
      if (stageBtn && stageIn) {
        stageBtn.addEventListener("click", function () {
          var pin = (stageIn.value || "").trim().toLowerCase();
          if (!/^sha256:[0-9a-f]{64}$/.test(pin)) {
            showToast("Pin must be sha256:<64 hex chars>", "error");
            return;
          }
          stageBtn.disabled = true;
          api.serverSettings.agentCertPinBulkAdd(pin).then(function (r) {
            showToast("Staged pin on " + r.added + " agent(s) (" + r.alreadyPresent + " already had it)", "success");
            stageIn.value = "";
            renderAgentCertPinRotation();
          }).catch(function (err) {
            showToast("Stage failed: " + err.message, "error");
          }).finally(function () {
            stageBtn.disabled = false;
          });
        });
      }
      // Generate → one-click: fetch the fingerprint of the cert Polaris is
      // currently serving (Node-HTTPS: in-memory PEM; proxy mode: file on
      // disk) via GET /server-settings/https and drop it into the input.
      // This is the operator-most-common path — staging the OLD pin before
      // rotating, or staging a pin to re-pin after an out-of-order rotation.
      if (genBtn && stageIn) {
        genBtn.addEventListener("click", function () {
          genBtn.disabled = true;
          api.serverSettings.getHttps().then(function (h) {
            if (!h || !h.fingerprint) {
              showToast("No cert fingerprint available — is HTTPS running?", "error");
              return;
            }
            stageIn.value = h.fingerprint;
            showToast("Filled with current cert pin", "success");
          }).catch(function (err) {
            showToast("Generate failed: " + err.message, "error");
          }).finally(function () {
            genBtn.disabled = false;
          });
        });
      }
      // "Compute from .pem file" link → file picker → client-side SHA-256.
      // For staging a DIFFERENT cert's pin (typical pre-rotation flow when
      // the new cert hasn't been activated yet). File never leaves the browser.
      var fromFileLink = document.getElementById("link-agent-cert-pin-from-file");
      if (fromFileLink && fileIn && stageIn) {
        fromFileLink.addEventListener("click", function (e) {
          e.preventDefault();
          fileIn.click();
        });
        fileIn.addEventListener("change", function () {
          var f = fileIn.files && fileIn.files[0];
          if (!f) return;
          _computeCertPinFromPemFile(f).then(function (pin) {
            stageIn.value = pin;
            showToast("Computed pin: " + pin.slice(0, 19) + "..." + pin.slice(-6), "success");
          }).catch(function (err) {
            showToast("Could not parse cert: " + err.message, "error");
          }).finally(function () {
            // Clear so picking the same file twice still fires change.
            fileIn.value = "";
          });
        });
      }

      var retireBtns = slot.querySelectorAll("button[data-retire-pin]");
      retireBtns.forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var pin = btn.getAttribute("data-retire-pin");
          if (!pin) return;
          var disp = pin.slice(0, 19) + "..." + pin.slice(-6);
          if (!(await showConfirm("Retire pin " + disp + " from every active agent? Skipped on any agent where this would be the last pin."))) {
            return;
          }
          btn.disabled = true;
          api.serverSettings.agentCertPinBulkRemove(pin).then(function (r) {
            var msg = "Retired pin from " + r.removed + " agent(s)";
            if (r.lastPinSkipped > 0) msg += " (" + r.lastPinSkipped + " skipped: would have been last pin)";
            showToast(msg, "success");
            renderAgentCertPinRotation();
          }).catch(function (err) {
            showToast("Retire failed: " + err.message, "error");
            btn.disabled = false;
          });
        });
      });
    }).catch(function (err) {
      slot.innerHTML =
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Cert pin rotation</div>' +
        '<p style="font-size:0.78rem;color:var(--color-warning);margin:0.3rem 0">' +
          'Failed to load: ' + escapeHtml(err.message) +
        '</p>';
    });
  }

  // Renders the Code signing pane (internal-CA PKCS#12) in the slot
  // reserved by renderAgentBuildInventory. Windows binaries only; runs as a
  // post-build step (FAIL-OPEN — a failure warns + ships unsigned, never
  // blocks the build). The keystore password follows the mask convention: the
  // server echoes bullets when one is stored; leaving the field untouched
  // (or blank) on Save preserves it.
  function renderAgentCodeSigning() {
    var slot = document.getElementById("agent-code-signing");
    if (!slot) return;
    api.serverSettings.agentSigningGet().then(function (r) {
      var cfg   = r.config || {};
      var avail = r.availability || {};

      var statusLine;
      if (!cfg.enabled) {
        statusLine = '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0.5rem">Disabled — Windows agent binaries ship unsigned.</p>';
      } else if (avail.ok) {
        statusLine =
          '<p style="font-size:0.78rem;color:var(--color-success);margin:0.3rem 0 0.5rem">' +
            '✓ Ready — ' + escapeHtml(avail.javaVersion || "java") + ', jsign at <code>' + escapeHtml(avail.jarPath || "?") + '</code>. ' +
            'Windows binaries are signed on every build.' +
          '</p>';
      } else {
        statusLine =
          '<p style="font-size:0.78rem;color:var(--color-warning);margin:0.3rem 0 0.5rem">' +
            '⚠ ' + escapeHtml(avail.error || "Signing is not ready") +
            ' — builds will complete but ship UNSIGNED Windows binaries until this is fixed.' +
          '</p>';
      }

      // Installed-certificate summary. Worth its own block because the expiry
      // is one of the failure modes that otherwise arrives silently: the cert
      // lapses, builds keep succeeding, and the binaries just stop being
      // signed. The fingerprint is here because it's the value an operator
      // pastes into a Defender indicator.
      var certBlock = "";
      var ci = r.certInfo;
      if (ci) {
        var expiryTxt = escapeHtml(ci.validUntilRaw || "unknown");
        var expiryColor = "var(--color-text-secondary)";
        if (typeof ci.daysRemaining === "number") {
          if (ci.daysRemaining < 0) {
            expiryTxt += " — EXPIRED";
            expiryColor = "var(--color-danger)";
          } else {
            expiryTxt += " (" + ci.daysRemaining + " day" + (ci.daysRemaining === 1 ? "" : "s") + ")";
            if (ci.daysRemaining < 30) expiryColor = "var(--color-warning)";
          }
        }
        function ciRow(label, value, color) {
          if (!value) return "";
          return '<div style="display:flex;gap:0.5rem;margin-top:0.15rem">' +
            '<span style="width:150px;flex-shrink:0;color:var(--color-text-tertiary)">' + label + '</span>' +
            '<span style="flex:1;word-break:break-all' + (color ? ";color:" + color : "") + '">' + value + '</span>' +
          '</div>';
        }
        certBlock =
          '<div style="margin-top:0.5rem;padding:0.5rem;border:1px solid var(--color-border);border-radius:4px;font-size:0.78rem">' +
            '<div style="color:var(--color-text-secondary);margin-bottom:0.25rem">Installed certificate</div>' +
            ciRow("Subject", escapeHtml(ci.subject || "")) +
            ciRow("Issuer", escapeHtml(ci.issuer || "")) +
            ciRow("Expires", expiryTxt, expiryColor) +
            ciRow("SHA-256", escapeHtml(ci.fingerprintSha256 || "")) +
            ciRow("Aliases", escapeHtml((ci.aliases || []).join(", "))) +
            (ci.hasPrivateKey === false
              ? '<div style="color:var(--color-danger);margin-top:0.25rem">⚠ No private key in this keystore — it cannot sign.</div>'
              : "") +
          '</div>';
      }

      function inputRow(id, label, value, placeholder, type) {
        return '<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.35rem">' +
          '<label for="' + id + '" style="width:150px;flex-shrink:0;font-size:0.78rem;color:var(--color-text-secondary)">' + label + '</label>' +
          '<input type="' + (type || "text") + '" id="' + id + '" value="' + escapeHtml(value || "") + '" ' +
            'placeholder="' + escapeHtml(placeholder || "") + '" autocomplete="off" ' +
            'style="flex:1;padding:4px 8px;font-family:var(--font-mono, monospace);font-size:0.8rem">' +
        '</div>';
      }

      slot.innerHTML =
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Code signing (internal CA)</div>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 0.3rem 0">' +
          'Signs the two Windows agent binaries after every build with your internal CA, so Defender can be ' +
          'told to trust them by publisher instead of re-evaluating a new file hash every build. ' +
          'Requires Java' + (avail.javaMinimum ? ' ' + escapeHtml(avail.javaMinimum) + '+' : '') + ' and the jsign jar on this Polaris server, plus a PKCS#12 keystore holding an ' +
          'internal-CA code-signing certificate (see <code>docs/INSTALL.md</code> → "Optional: Code signing").' +
        '</p>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0 0 0.3rem 0">' +
          'Only machines that trust your internal root see a valid signature — unmanaged hosts will see an ' +
          'UNTRUSTED one.' +
        '</p>' +
        statusLine +
        certBlock +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;font-size:0.85rem;margin-top:0.3rem">' +
          '<input type="checkbox" id="agent-signing-enabled" style="width:15px;height:15px;flex-shrink:0"' + (cfg.enabled ? " checked" : "") + '>' +
          '<span>Sign Windows agent binaries on build</span>' +
        '</label>' +
        inputRow("agent-signing-keystore", "Keystore (.pfx) path", cfg.keystorePath, "/opt/polaris/tools/codesign.pfx") +
        inputRow("agent-signing-password", "Keystore password",    cfg.keystorePassword, cfg.keystorePasswordSet ? "unchanged" : "keystore password", "password") +
        inputRow("agent-signing-alias",    "Key alias",            cfg.alias,        "optional — only for a multi-entry keystore") +
        inputRow("agent-signing-tsa",      "Timestamp URL",        cfg.tsaUrl,       "http://timestamp.digicert.com") +
        inputRow("agent-signing-jar",      "jsign jar path",       cfg.jsignJarPath, avail.jarPath || "auto-detect (tools/jsign.jar)") +
        // Upload path: the alternative to placing the .pfx over SSH, and the
        // one that matters on renewal. The file and its password go up
        // together and are validated BEFORE replacing whatever is installed,
        // so a wrong password can't leave signing broken.
        '<div style="margin-top:0.6rem;padding-top:0.5rem;border-top:1px dashed var(--color-border)">' +
          '<div style="color:var(--color-text-secondary);font-size:0.8rem;margin-bottom:0.25rem">' +
            'Upload keystore' +
          '</div>' +
          '<p style="font-size:0.75rem;color:var(--color-text-tertiary);margin:0 0 0.35rem 0">' +
            'A PKCS#12 (<code>.pfx</code>/<code>.p12</code>) exported <strong>with its private key</strong>. ' +
            'Stored at <code>' + escapeHtml(r.managedKeystorePath || "") + '</code> (not web-accessible) and ' +
            'the path above is set for you. Validated before it replaces anything.' +
          '</p>' +
          '<div style="display:flex;align-items:center;gap:0.5rem;margin-top:0.35rem">' +
            '<label for="agent-signing-file" style="width:150px;flex-shrink:0;font-size:0.78rem;color:var(--color-text-secondary)">Keystore file</label>' +
            '<input type="file" id="agent-signing-file" accept=".pfx,.p12,application/x-pkcs12" ' +
              'style="flex:1;font-size:0.78rem">' +
          '</div>' +
          inputRow("agent-signing-uploadpw", "Password for file", "", "password protecting the .pfx", "password") +
          '<div style="display:flex;gap:0.5rem;margin-top:0.5rem;align-items:center">' +
            '<button class="btn btn-secondary" id="btn-agent-signing-upload" style="padding:4px 14px;font-size:0.8rem">Upload</button>' +
            (r.keystoreManaged
              ? '<button class="btn btn-secondary" id="btn-agent-signing-delkeystore" style="padding:4px 14px;font-size:0.8rem">Delete keystore</button>'
              : "") +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:0.5rem;margin-top:0.6rem">' +
          '<button class="btn btn-secondary" id="btn-agent-signing-save" style="padding:4px 14px;font-size:0.8rem">Save</button>' +
          '<button class="btn btn-secondary" id="btn-agent-signing-test" style="padding:4px 14px;font-size:0.8rem" ' +
            'title="Checks Java + jsign and opens the keystore with the saved password (no TSA call)">Test</button>' +
        '</div>';

      var saveBtn = document.getElementById("btn-agent-signing-save");
      if (saveBtn) {
        saveBtn.addEventListener("click", function () {
          var body = {
            enabled:          !!document.getElementById("agent-signing-enabled").checked,
            keystorePath:     (document.getElementById("agent-signing-keystore").value || "").trim(),
            // Mask echo / blank both mean "keep the stored password" server-side.
            keystorePassword: document.getElementById("agent-signing-password").value || "",
            alias:            (document.getElementById("agent-signing-alias").value || "").trim(),
            tsaUrl:           (document.getElementById("agent-signing-tsa").value || "").trim(),
            jsignJarPath:     (document.getElementById("agent-signing-jar").value || "").trim(),
          };
          saveBtn.disabled = true;
          api.serverSettings.agentSigningSet(body).then(function () {
            showToast("Code-signing settings saved", "success");
            renderAgentCodeSigning();
          }).catch(function (err) {
            showToast("Save failed: " + err.message, "error");
            saveBtn.disabled = false;
          });
        });
      }

      var uploadBtn = document.getElementById("btn-agent-signing-upload");
      if (uploadBtn) {
        uploadBtn.addEventListener("click", function () {
          var fileInput = document.getElementById("agent-signing-file");
          var pwInput   = document.getElementById("agent-signing-uploadpw");
          var file = fileInput && fileInput.files && fileInput.files[0];
          if (!file) { showToast("Choose a .pfx or .p12 file first", "error"); return; }
          // Required client-side too, but the server validates regardless —
          // it's what proves the password actually opens the keystore.
          if (!pwInput || !pwInput.value) { showToast("Enter the password protecting the file", "error"); return; }

          uploadBtn.disabled = true;
          api.serverSettings.agentSigningUploadKeystore(file, pwInput.value).then(function (res) {
            // An unverified install is a real outcome, not a failure: keytool
            // was missing, so the password is untested. Say which happened.
            if (res && res.verified === false) {
              showToast(res.warning || "Keystore stored, but the password could not be verified", "warning");
            } else {
              showToast("Keystore installed and verified", "success");
            }
            pwInput.value = "";
            if (fileInput) fileInput.value = "";
            renderAgentCodeSigning();
          }).catch(function (err) {
            showToast("Upload failed: " + err.message, "error");
            uploadBtn.disabled = false;
          });
        });
      }

      var delKsBtn = document.getElementById("btn-agent-signing-delkeystore");
      if (delKsBtn) {
        delKsBtn.addEventListener("click", function () {
          // Confirm: this is the key that signs every agent binary, and builds
          // silently ship unsigned once it's gone (fail-open).
          showConfirm(
            "Delete the signing keystore?\n\n" +
            "The stored certificate and its password are removed. Agent builds will keep succeeding but will " +
            "ship UNSIGNED Windows binaries until a keystore is installed again."
          ).then(function (ok) {
            if (!ok) return;
            delKsBtn.disabled = true;
            api.serverSettings.agentSigningDeleteKeystore().then(function () {
              showToast("Keystore deleted — builds will ship unsigned", "warning");
              renderAgentCodeSigning();
            }).catch(function (err) {
              showToast("Delete failed: " + err.message, "error");
              delKsBtn.disabled = false;
            });
          });
        });
      }

      var testBtn = document.getElementById("btn-agent-signing-test");
      if (testBtn) {
        testBtn.addEventListener("click", function () {
          testBtn.disabled = true;
          api.serverSettings.agentSigningTest().then(function (t) {
            showToast(t.message, t.ok ? "success" : "error");
          }).catch(function (err) {
            showToast("Test failed: " + err.message, "error");
          }).finally(function () {
            testBtn.disabled = false;
          });
        });
      }
    }).catch(function (err) {
      slot.innerHTML =
        '<div style="color:var(--color-text-secondary);margin-bottom:0.3rem">Code signing (internal CA)</div>' +
        '<p style="font-size:0.78rem;color:var(--color-warning);margin:0.3rem 0">' +
          'Failed to load: ' + escapeHtml(err.message) +
        '</p>';
    });
  }

  function onAgentPruneClick() {
    api.serverSettings.agentPrune().then(function (r) {
      var n = (r.removed || []).length;
      if (n === 0) {
        showToast(_pruneNothingMessage(r), "info");
      } else {
        var bytes = r.removed.reduce(function (s, e) { return s + (e.bytes || 0); }, 0);
        showToast("Removed " + n + " old version" + (n > 1 ? "s" : "") + " (" + _humanBytes(bytes) + " freed)", "success");
      }
      api.serverSettings.agentInventory().then(renderAgentBuildInventory);
    }).catch(function (err) {
      showToast("Clean up failed: " + err.message, "error");
    });
  }

  // Build a specific "nothing to prune" message from the per-version
  // protection reasons. Replaces the older lump-sum text that always
  // mentioned both "in use" and "keep-last-N" even when only one applied.
  function _pruneNothingMessage(r) {
    var prot = r.protected || [];
    var keep = r.keepLastN != null ? r.keepLastN : 3;
    if (prot.length === 0) {
      return "Nothing to clean up — no version directories found.";
    }
    var byReason = { "in-use": [], "current": [], "keep-last-n": [] };
    for (var i = 0; i < prot.length; i++) {
      var p = prot[i];
      if (byReason[p.reason]) byReason[p.reason].push(p.version);
    }
    var parts = [];
    if (byReason["in-use"].length) {
      parts.push(byReason["in-use"].length + " in use by live agent(s) (v" + byReason["in-use"].join(", v") + ")");
    }
    if (byReason["current"].length) {
      parts.push("v" + byReason["current"][0] + " is the current build");
    }
    if (byReason["keep-last-n"].length) {
      parts.push(byReason["keep-last-n"].length + " within keep-last-" + keep +
        " (v" + byReason["keep-last-n"].join(", v") + ")");
    }
    var why = parts.join("; ");
    var hint = byReason["keep-last-n"].length && !byReason["in-use"].length
      ? " Lower POLARIS_AGENT_KEEP_VERSIONS in .env to free older versions."
      : "";
    return "Nothing to clean up — " + why + "." + hint;
  }

  function onAgentBuildClick() {
    api.serverSettings.agentBuildStart().then(function (r) {
      var phase = r.queuePosition === 0 ? "preparing" : "queued";
      renderAgentBuildProgress({
        buildId:   r.buildId,
        version:   r.version,
        phase:     phase,
        steps:     [],
        queuedAt:  new Date().toISOString(),
        startedAt: r.queuePosition === 0 ? new Date().toISOString() : null,
      }, []);
      if (r.queuePosition > 0) {
        showToast("Build queued (position " + r.queuePosition + ")", "info");
      }
      startAgentBuildPoll(r.buildId);
    }).catch(function (err) {
      showToast("Build failed to start: " + err.message, "error");
    });
  }

  function startAgentBuildPoll(buildId) {
    if (_agentBuildPollTimer) clearTimeout(_agentBuildPollTimer);
    var tick = function () {
      Promise.all([
        api.serverSettings.agentBuildStatus(buildId),
        api.serverSettings.agentBuildCurrent().catch(function () { return { current: null, queue: [] }; }),
      ]).then(function (results) {
        var state   = results[0];
        var current = results[1] && results[1].current;
        var queue   = (results[1] && results[1].queue) || [];
        var primary = (state.phase === "queued" && current) ? current : state;
        var queueWithoutPrimary = queue.filter(function (q) { return q.buildId !== primary.buildId; });
        renderAgentBuildProgress(primary, queueWithoutPrimary);
        if (state.phase === "complete" || state.phase === "failed") {
          _agentBuildPollTimer = null;
          api.serverSettings.agentInventory().then(function (inv) {
            renderAgentBuildInventory(inv);
            if (state.phase === "complete") {
              showToast("Built agent binaries v" + state.version, "success");
            } else {
              showToast("Build failed: " + (state.error || "unknown error"), "error");
            }
          });
          return;
        }
        _agentBuildPollTimer = setTimeout(tick, 2000);
      }).catch(function () {
        _agentBuildPollTimer = setTimeout(tick, 5000);
      });
    };
    _agentBuildPollTimer = setTimeout(tick, 200);
  }

  function renderAgentBuildProgress(state, queue) {
    var body = document.getElementById("agent-build-body");
    if (!body) return;

    var elapsedAnchor = state.startedAt || state.queuedAt;
    var elapsedMs = elapsedAnchor ? Date.now() - new Date(elapsedAnchor).getTime() : 0;
    var elapsedTxt = _formatElapsed(elapsedMs);

    var stepsHtml = (state.steps || []).map(function (s) {
      var icon, color;
      if (s.status === "success")      { icon = "✓"; color = "var(--color-success)"; }
      else if (s.status === "failed")  { icon = "✗"; color = "var(--color-danger)"; }
      else if (s.status === "running") { icon = "▸"; color = "var(--color-accent)"; }
      else                              { icon = "○"; color = "var(--color-text-tertiary)"; }
      var dur = s.elapsedMs != null ? _formatElapsed(s.elapsedMs) : (s.status === "running" ? "running" : "pending");
      return '<tr>' +
        '<td style="padding:3px 8px;color:' + color + '">' + icon + '</td>' +
        '<td style="padding:3px 8px"><code>' + escapeHtml(s.platform) + '-' + escapeHtml(s.arch) + '</code></td>' +
        '<td style="padding:3px 8px;text-align:right;font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(dur) + '</td>' +
        (s.error
          ? '<td style="padding:3px 8px;font-family:monospace;font-size:0.75rem;color:var(--color-danger)">' + escapeHtml(s.error) + '</td>'
          : '<td></td>') +
        '</tr>';
    }).join("");

    var isFinished  = state.phase === "complete" || state.phase === "failed" || state.phase === "cancelled";
    var cancelBtn   = isFinished
      ? ""
      : ' <button class="btn-icon agent-build-cancel" data-build-id="' + escapeHtml(state.buildId) +
          '" title="Cancel" style="margin-left:0.5rem;padding:1px 8px;font-size:0.75rem">×</button>';

    var label;
    if (state.phase === "complete") {
      label = '<strong style="color:var(--color-success)">Built v' + escapeHtml(state.version) + '</strong>';
    } else if (state.phase === "failed") {
      label = '<strong style="color:var(--color-danger)">Build failed</strong>';
    } else if (state.phase === "cancelled") {
      label = '<strong style="color:var(--color-warning)">Build cancelled</strong>';
    } else if (state.phase === "queued") {
      label = '<strong>Queued: v' + escapeHtml(state.version) + '</strong> · waiting · ' + escapeHtml(elapsedTxt) + cancelBtn;
    } else if (state.phase === "signing") {
      label = '<strong>Signing Windows binaries v' + escapeHtml(state.version) + '</strong> · ' + escapeHtml(elapsedTxt) + ' elapsed' + cancelBtn;
    } else {
      label = '<strong>Building agent binaries v' + escapeHtml(state.version) + '</strong> · ' + escapeHtml(elapsedTxt) + ' elapsed' + cancelBtn;
    }

    var queueHtml = "";
    if (queue && queue.length > 0) {
      queueHtml =
        '<div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--color-border)">' +
          '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:0.3rem">Queued (' + queue.length + ')</div>' +
          queue.map(function (q) {
            return '<div style="font-size:0.78rem;color:var(--color-text-tertiary);padding:2px 0;display:flex;align-items:center;gap:6px">' +
              '<span style="flex:1">• v' + escapeHtml(q.version) + ' — queued by ' + escapeHtml(q.actor) +
                (q.queuedAt ? ' (' + escapeHtml(_timeAgo(q.queuedAt)) + ')' : "") +
              '</span>' +
              '<button class="btn-icon agent-build-cancel" data-build-id="' + escapeHtml(q.buildId) +
                '" title="Cancel" style="padding:1px 8px;font-size:0.75rem">×</button>' +
            '</div>';
          }).join("") +
        '</div>';
    }

    body.innerHTML =
      '<div style="margin-bottom:0.5rem">' + label + '</div>' +
      (stepsHtml
        ? '<table style="width:100%;border-collapse:collapse;font-size:0.85rem"><tbody>' + stepsHtml + '</tbody></table>'
        : "") +
      (state.error
        ? '<div style="margin-top:0.5rem;padding:0.5rem 0.75rem;background:rgba(255,80,80,0.08);' +
            'border-left:3px solid var(--color-danger);border-radius:4px;font-family:monospace;font-size:0.78rem;' +
            'color:var(--color-danger);white-space:pre-wrap;word-break:break-word">' + escapeHtml(state.error) + '</div>'
        : "") +
      queueHtml;

    body.querySelectorAll(".agent-build-cancel").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var id = btn.getAttribute("data-build-id");
        if (!id) return;
        showConfirm("Cancel this build? Any partial binaries will remain on disk but unused.").then(function (ok) {
          if (!ok) return;
          api.serverSettings.agentBuildCancel(id).then(function () {
            showToast("Build cancelled", "info");
            api.serverSettings.agentBuildCurrent().then(function (snap) {
              var cur = snap && snap.current;
              if (cur && cur.phase !== "complete" && cur.phase !== "failed" && cur.phase !== "cancelled") {
                renderAgentBuildProgress(cur, (snap.queue || []).filter(function (q) { return q.buildId !== cur.buildId; }));
              } else {
                api.serverSettings.agentInventory().then(renderAgentBuildInventory);
              }
            });
          }).catch(function (err) {
            showToast("Cancel failed: " + err.message, "error");
          });
        });
      });
    });
  }

  // ─── Installed agents slide-in ────────────────────────────────────────────
  //
  // Fleet view of every host with the agent installed, opened from the
  // "Installed agents" button on the Polaris Agents tab. One row per
  // ManagedAgent (architecture, version, status, last-seen) with per-host
  // Reinstall / Upgrade / Remove actions. Modeled on the asset-details
  // slide-over (slideover-* classes + initSlideoverResize from app.js).
  // The mutating actions call the per-asset /assets/:id/agent/* routes
  // (assets:write); the list itself is a serverSettings read.

  // In-progress statuses that warrant a live re-poll while the panel is open.
  var _AGENT_BUSY_STATUSES = {
    pending: 1, uploading: 1, enrolling: 1, upgrading: 1, uninstalling: 1,
  };

  function _agentStatusBadge(status) {
    var color, label = status || "unknown";
    switch (status) {
      case "active":            color = "var(--color-success)"; break;
      case "failed":
      case "upgrade_failed":
      case "uninstall_failed":  color = "var(--color-danger)"; break;
      case "revoked":           color = "var(--color-warning)"; break;
      case "pending":
      case "uploading":
      case "enrolling":
      case "upgrading":
      case "uninstalling":      color = "var(--color-accent)"; break;
      default:                  color = "var(--color-text-tertiary)";
    }
    return '<span style="color:' + color + ';font-weight:600">' + escapeHtml(label) + '</span>';
  }

  // Privilege cell for the installed-agents table. The tier is Linux-only —
  // Windows agents always run as LocalSystem and macOS LaunchDaemons as root,
  // so those render as fixed informational text.
  //
  // For the ptrace tier the cell renders the VERIFIED state when the agent has
  // reported its effective capabilities (`caps`, decoded server-side from the
  // heartbeat CapEff; agent ≥0.17.1) — `privilegeTier` alone is only what the
  // operator requested at install kickoff, and a unit written by a
  // pre-CAP_DAC_READ_SEARCH server grants less than the tier promises while
  // collecting zero Application Map connections. Three states:
  //   caps has the pair      → healthy (amber — it's still an elevated grant)
  //   caps lacks DAC_READ    → stale unit (red, reinstall)
  //   caps null              → unverified (amber; old binary or no heartbeat yet)
  // Legacy `root` rows are flagged danger so operators reinstall them down.
  function _agentPrivilegeCell(a) {
    var tertiary = function (t) {
      return '<span style="color:var(--color-text-tertiary);font-size:0.78rem">' + escapeHtml(t) + '</span>';
    };
    if (a.osPlatform === "windows") return tertiary("LocalSystem");
    if (a.osPlatform === "darwin")  return tertiary("root (daemon)");
    if (a.privilegeTier === "ptrace") {
      if (a.caps && a.caps.sysPtrace && a.caps.dacReadSearch) {
        return '<span style="color:var(--color-warning);font-weight:600;font-size:0.78rem" ' +
          'title="Verified from the agent’s reported effective capabilities: CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH, the pair required to attribute Application Map connections to processes. These capabilities also let the agent read any process’s memory and any file on the host.">PTRACE + DAC_READ ✓</span>';
      }
      if (a.caps) {
        return '<span style="color:var(--color-danger);font-weight:600;font-size:0.78rem" ' +
          'title="The agent reports it is missing ' + (a.caps.sysPtrace ? 'CAP_DAC_READ_SEARCH' : 'the ptrace-tier capabilities') + ' — its systemd unit predates the CAP_DAC_READ_SEARCH fix, so it collects NO Application Map connections. Reinstall to rewrite the unit with the full pair.">CAP_SYS_PTRACE — stale, reinstall</span>';
      }
      return '<span style="color:var(--color-warning);font-weight:600;font-size:0.78rem" ' +
        'title="Requested tier: CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH. Not yet verified — the agent hasn’t reported its effective capabilities (needs agent ≥0.17.1 and a heartbeat). If it was installed before the CAP_DAC_READ_SEARCH fix it collects no connections until reinstalled.">CAP_SYS_PTRACE (unverified)</span>';
    }
    if (a.privilegeTier === "root") {
      return '<span style="color:var(--color-danger);font-weight:600;font-size:0.78rem" ' +
        'title="Legacy full-root install from before the Satellite-posture change. Reinstall to downgrade it to unprivileged or the ptrace tier.">root (legacy)</span>';
    }
    return tertiary("unprivileged");
  }

  function _ensureInstalledAgentsPanelDOM() {
    var overlay = document.getElementById("agent-list-panel-overlay");
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.className = "slideover-overlay";
    overlay.id = "agent-list-panel-overlay";
    overlay.innerHTML =
      '<div class="slideover" id="agent-list-panel">' +
        '<div class="slideover-resize-handle"></div>' +
        '<div class="slideover-header">' +
          '<div class="slideover-header-top">' +
            '<h3>Installed Polaris Agents</h3>' +
            '<button class="btn-icon" id="agent-list-panel-close" title="Close">×</button>' +
          '</div>' +
          '<div class="slideover-meta" id="agent-list-panel-meta"></div>' +
        '</div>' +
        '<div class="slideover-body" id="agent-list-panel-body" style="padding:1rem">' +
          '<p class="empty-state">Loading...</p>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Backdrop click closes (click on the overlay itself, not the panel).
    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) closeInstalledAgentsPanel();
    });
    var closeBtn = document.getElementById("agent-list-panel-close");
    if (closeBtn) closeBtn.addEventListener("click", closeInstalledAgentsPanel);

    if (typeof initSlideoverResize === "function") {
      initSlideoverResize(document.getElementById("agent-list-panel"), "polaris.panel.width.agentlist");
    }
    return overlay;
  }

  function openInstalledAgentsPanel() {
    var overlay = _ensureInstalledAgentsPanelDOM();
    revealOverlay(overlay);
    refreshInstalledAgentsPanel();
  }

  function closeInstalledAgentsPanel() {
    var overlay = document.getElementById("agent-list-panel-overlay");
    if (overlay) overlay.classList.remove("open");
    if (_agentListPollTimer) { clearTimeout(_agentListPollTimer); _agentListPollTimer = null; }
  }

  function _panelIsOpen() {
    var overlay = document.getElementById("agent-list-panel-overlay");
    return overlay && overlay.classList.contains("open");
  }

  function refreshInstalledAgentsPanel() {
    api.serverSettings.agentInstalledList().then(function (data) {
      if (!_panelIsOpen()) return;
      _renderInstalledAgentsPanel(data);
      // Live re-poll while any install/upgrade/uninstall is mid-flight, so
      // the status column ticks through pending → active without a manual
      // refresh. Stops once everything settles.
      if (_agentListPollTimer) { clearTimeout(_agentListPollTimer); _agentListPollTimer = null; }
      var busy = (data.agents || []).some(function (a) { return _AGENT_BUSY_STATUSES[a.installStatus]; });
      if (busy) _agentListPollTimer = setTimeout(refreshInstalledAgentsPanel, 3000);
    }).catch(function (err) {
      var body = document.getElementById("agent-list-panel-body");
      if (body) body.innerHTML = '<p class="empty-state" style="color:var(--color-danger)">Failed to load: ' + escapeHtml(err.message) + '</p>';
    });
  }

  function _renderInstalledAgentsPanel(data) {
    var meta = document.getElementById("agent-list-panel-meta");
    var body = document.getElementById("agent-list-panel-body");
    if (!body) return;
    var agents  = data.agents || [];
    var current = data.currentVersion;

    if (meta) {
      // Elevated = anything above the hardened unprivileged unit. Surfaced as a
      // header count so "how many hosts did we grant ptrace to?" is answerable
      // without scanning the table. Stale = ptrace-tier agents whose REPORTED
      // capabilities lack CAP_DAC_READ_SEARCH (unit predates the DAC fix —
      // collecting nothing); called out separately so a broken fleet is
      // impossible to miss.
      var elevated = 0, stale = 0;
      agents.forEach(function (a) {
        if (a.osPlatform !== "linux") return;
        if (a.privilegeTier === "ptrace" || a.privilegeTier === "root") elevated++;
        if (a.privilegeTier === "ptrace" && a.caps && !(a.caps.sysPtrace && a.caps.dacReadSearch)) stale++;
      });
      meta.innerHTML =
        agents.length + ' installed agent' + (agents.length === 1 ? "" : "s") +
        (current ? ' · current build <strong>v' + escapeHtml(current) + '</strong>' : ' · no build on disk') +
        (elevated
          ? ' · <span style="color:var(--color-warning);font-weight:600">' + elevated + ' with ptrace tier</span>'
          : "") +
        (stale
          ? ' · <span style="color:var(--color-danger);font-weight:600">' + stale + ' on a stale unit — reinstall</span>'
          : "");
    }

    if (agents.length === 0) {
      body.innerHTML =
        '<p class="empty-state">No agents installed yet. Deploy the agent from an asset\'s details modal ' +
        '(Install Agent) or via the assets page bulk bar (Deploy Agent).</p>';
      return;
    }

    var canManage = (typeof canManageAssets === "function") ? canManageAssets() : true;

    var rows = agents.map(function (a) {
      var host = a.hostname || a.ipAddress || a.assetId;
      var hostSub = (a.hostname && a.ipAddress) ? a.ipAddress : "";
      var verCell = a.agentVersion
        ? '<code>v' + escapeHtml(a.agentVersion) + '</code>' +
            (a.outOfDate
              ? ' <span style="color:var(--color-warning);font-size:0.72rem;font-weight:600">out-of-date</span>'
              : "")
        : '<span style="color:var(--color-text-tertiary)">—</span>';
      var lastSeen = a.lastSeenAt ? _timeAgo(a.lastSeenAt) : "—";

      var actions = "";
      if (canManage) {
        var btns = [];
        // Upgrade — meaningful for any lagging agent the server will accept an
        // upgrade for. `outOfDate` already encodes that (it gates on the same
        // upgradeable-status set the route does), so a host whose last upgrade
        // failed gets the button back instead of needing a reinstall.
        if (a.outOfDate) {
          var upLabel = a.installStatus === "upgrade_failed" ? "Retry upgrade" : "Upgrade";
          btns.push('<button class="btn btn-secondary agent-act" data-act="upgrade" data-id="' + escapeHtml(a.assetId) +
            '" style="padding:2px 8px;font-size:0.75rem">' + upLabel + '</button>');
        }
        // Reinstall — needs the stored install credential. Carries the OS +
        // current privilege tier so the Linux reinstall dialog can offer the
        // CAP_SYS_PTRACE toggle (pre-checked when the agent is on the ptrace
        // tier). A legacy "root" agent pre-checks it too, since reinstalling
        // downgrades it to unprivileged/ptrace.
        var reAttr = a.hasInstallCredential ? "" : ' disabled title="No install credential on file — force-remove and install fresh"';
        var curPtrace = (a.privilegeTier === "ptrace" || a.privilegeTier === "root") ? "1" : "0";
        btns.push('<button class="btn btn-secondary agent-act" data-act="reinstall" data-id="' + escapeHtml(a.assetId) +
          '" data-os="' + escapeHtml(a.osPlatform || "") + '" data-ptrace="' + curPtrace + '"' +
          reAttr + ' style="padding:2px 8px;font-size:0.75rem">Reinstall</button>');
        // Remove (graceful) + Force remove.
        btns.push('<button class="btn btn-secondary agent-act" data-act="remove" data-id="' + escapeHtml(a.assetId) +
          '" style="padding:2px 8px;font-size:0.75rem">Remove</button>');
        btns.push('<button class="btn-icon agent-act" data-act="force-remove" data-id="' + escapeHtml(a.assetId) +
          '" title="Force-remove: revoke the bearer and drop the local record without contacting the host (orphan binary stays on disk)" ' +
          'style="padding:2px 8px;font-size:0.72rem;color:var(--color-danger)">Force ×</button>');
        actions = '<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">' + btns.join("") + '</div>';
      } else {
        actions = '<span style="color:var(--color-text-tertiary);font-size:0.75rem">read-only</span>';
      }

      var errRow = a.installError
        ? '<tr><td colspan="7" style="padding:0 8px 6px;font-family:monospace;font-size:0.72rem;color:var(--color-danger);' +
            'white-space:pre-wrap;word-break:break-word">' + escapeHtml(a.installError) + '</td></tr>'
        : "";

      // Host cell is click-through to the asset details slide-in (see the
      // delegated handler below). Accent colour + role/tabindex mirror the
      // credential-usage slide-in's asset rows in server-settings.js.
      return '<tr style="border-bottom:1px solid var(--color-border-light, var(--color-border))">' +
          '<td style="padding:6px 8px">' +
            '<div data-asset-id="' + escapeHtml(a.assetId) + '" role="button" tabindex="0" ' +
              'title="Open asset details" ' +
              'style="color:var(--color-accent);cursor:pointer">' + escapeHtml(host) + '</div>' +
            (hostSub ? '<div style="font-size:0.72rem;color:var(--color-text-tertiary)">' + escapeHtml(hostSub) + '</div>' : "") +
          '</td>' +
          '<td style="padding:6px 8px"><code>' + escapeHtml(a.osPlatform) + '</code> / <code>' + escapeHtml(a.arch) + '</code></td>' +
          '<td style="padding:6px 8px;white-space:nowrap">' + _agentPrivilegeCell(a) + '</td>' +
          '<td style="padding:6px 8px">' + verCell + '</td>' +
          '<td style="padding:6px 8px">' + _agentStatusBadge(a.installStatus) + '</td>' +
          '<td style="padding:6px 8px;font-size:0.78rem;color:var(--color-text-tertiary);white-space:nowrap">' + escapeHtml(lastSeen) + '</td>' +
          '<td style="padding:6px 8px;text-align:right">' + actions + '</td>' +
        '</tr>' + errRow;
    }).join("");

    body.innerHTML =
      '<table style="width:100%;border-collapse:collapse;font-size:0.85rem">' +
        '<thead><tr style="border-bottom:1px solid var(--color-border)">' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Host</th>' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">OS / Arch</th>' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Privilege</th>' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Version</th>' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Status</th>' +
          '<th style="padding:4px 8px;text-align:left;font-weight:600;color:var(--color-text-secondary)">Last seen</th>' +
          '<th style="padding:4px 8px;text-align:right;font-weight:600;color:var(--color-text-secondary)">Actions</th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>';

    body.querySelectorAll("button.agent-act").forEach(function (btn) {
      btn.addEventListener("click", function () {
        _onInstalledAgentAction(btn.getAttribute("data-act"), btn.getAttribute("data-id"), btn);
      });
    });
    _wireInstalledAgentHostLinks(body);
  }

  // Host-cell click-through → asset details. Delegated on the panel body (which
  // re-renders on every poll tick) and bound once via a flag, so the 3s busy
  // re-render doesn't stack duplicate listeners.
  //
  // In-place when the canonical asset slide-over is on the page (assets.js
  // defines openViewModal and appends to <body>, so it stacks over this panel);
  // otherwise the #view=asset:<id> deep link app.js processSearchHash() opens on
  // load — the same hand-off the Server Settings credential-usage slide-in uses,
  // and the reason integrations.html doesn't have to pull in all of assets.js.
  function _wireInstalledAgentHostLinks(body) {
    if (!body || body._agentHostLinksBound) return;
    body._agentHostLinksBound = true;
    function open(target) {
      var el = target && target.closest ? target.closest("[data-asset-id]") : null;
      if (!el) return;
      var assetId = el.getAttribute("data-asset-id");
      if (!assetId) return;
      if (typeof openViewModal === "function") {
        openViewModal(assetId);
      } else {
        window.location.href = "/assets.html#view=asset:" + encodeURIComponent(assetId);
      }
    }
    body.addEventListener("click", function (e) { open(e.target); });
    body.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      if (!e.target || !e.target.hasAttribute || !e.target.hasAttribute("data-asset-id")) return;
      e.preventDefault();   // Space would scroll the panel
      open(e.target);
    });
  }

  function _onInstalledAgentAction(act, assetId, btn) {
    if (!assetId) return;
    var run;

    if (act === "upgrade") {
      run = showConfirm("Upgrade this agent to the current build?\n\nThe host briefly bounces its agent service while the binary is replaced. Bearer + cert pin are preserved.")
        .then(function (ok) { if (!ok) return null; return api.assets.upgradeAgent(assetId); });
    } else if (act === "reinstall") {
      var os = btn ? btn.getAttribute("data-os") : "";
      var curPtrace = !!(btn && btn.getAttribute("data-ptrace") === "1");
      if (os === "linux") {
        // Linux reinstall can also change the privilege tier — offer the
        // CAP_SYS_PTRACE toggle (pre-checked to the current state). A legacy
        // root agent lands here pre-checked and downgrades to unprivileged/ptrace.
        var formHtml =
          '<p style="color:var(--color-text-secondary);margin-top:0">Re-pushes the binary + agent.conf and re-runs the installer using the stored install credential. The old bearer is revoked and a fresh one issued on re-enroll.</p>' +
          '<div class="form-group">' +
            '<label style="display:flex;align-items:center;gap:0.5rem;font-weight:normal;cursor:pointer">' +
              '<input type="checkbox" id="reinstall-run-as-root"' + (curPtrace ? ' checked' : '') + '> Grant CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH (for Application Map connection mapping)' +
            '</label>' +
            '<p class="hint" style="color:var(--color-warning)">Leave unchecked to reinstall fully unprivileged (recommended). Checking this grants the capability pair the agent needs to attribute connections to processes — without full root. These capabilities also let the agent read any process’s memory and any file on the host (a credential-theft risk).</p>' +
          '</div>';
        var wantPtrace = curPtrace;
        var fp = showFormModal("Reinstall agent on this host", formHtml, "Reinstall");
        var rcb = document.getElementById("reinstall-run-as-root");
        if (rcb) rcb.addEventListener("change", function () { wantPtrace = rcb.checked; });
        run = fp.then(function (ok) { if (!ok) return null; return api.assets.reinstallAgent(assetId, { privilegeTier: wantPtrace ? "ptrace" : "unprivileged" }); });
      } else {
        run = showConfirm("Reinstall the agent on this host?\n\nRe-pushes the binary + agent.conf and re-runs the installer using the stored install credential. The old bearer is revoked and a fresh one issued on re-enroll.")
          .then(function (ok) { if (!ok) return null; return api.assets.reinstallAgent(assetId); });
      }
    } else if (act === "remove") {
      run = showConfirm("Remove the agent from this host?\n\nRevokes the bearer immediately, then remotely uninstalls the service + binary using the stored install credential.")
        .then(function (ok) { if (!ok) return null; return api.assets.deleteAgent(assetId, { force: false }); });
    } else if (act === "force-remove") {
      run = showConfirm("Force-remove this agent?\n\nRevokes the bearer and drops the local record WITHOUT contacting the host. The agent binary stays on disk on the remote machine (its bearer is dead, so it can no longer talk to Polaris). Use this when the host is unreachable.")
        .then(function (ok) { if (!ok) return null; return api.assets.deleteAgent(assetId, { force: true }); });
    } else {
      return;
    }

    if (btn) btn.disabled = true;
    run.then(function (res) {
      if (res === null) { if (btn) btn.disabled = false; return; } // cancelled
      var verb = act === "upgrade" ? "Upgrade" : act === "reinstall" ? "Reinstall" : "Removal";
      showToast(verb + " started", "success");
      refreshInstalledAgentsPanel();
    }).catch(function (err) {
      showToast((err && err.message) ? err.message : "Action failed", "error");
      if (btn) btn.disabled = false;
    });
  }

  // Public surface — integrations.js calls initAgentBuildCard() when the
  // Polaris Agents sub-tab is activated. The card body lives at
  // #agent-build-body which the tab markup creates.
  window.PolarisAgentBuild = {
    init: initAgentBuildCard,
  };
})();
