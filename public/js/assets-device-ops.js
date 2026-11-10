/**
 * public/js/assets-device-ops.js — acting on a device: the Polaris Agent sub-panel (install, upgrade,
 * uninstall), the firmware card and scheduled upgrades (business rules 87,
 * 93), and reboot now / booked (business rule 115).
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Polaris Agent sub-panel (System tab) ─────────────────────────────────
//
// Renders only when the operator has expressed agent-intent: either an
// agent is already installed, OR at least one per-asset *Polling column
// is "agent". Otherwise hidden — we don't want an "Install Agent" CTA
// on every Linux/Windows asset for operators who haven't opted in.
//
// The panel's three states map to ManagedAgent.installStatus values:
//   - No row at all                      → "Install Agent" button + cred picker.
//   - pending / uploading / enrolling    → spinner + status text + Force-Remove (admin).
//   - active                             → version + last-seen + WS state + Uninstall.
//   - failed / uninstall_failed          → red banner + error text + Retry / Force-Remove.
//   - revoked                            → "bearer revoked" notice + Force-Remove (admin).
//
// We poll GET /:id/agent every 3s while the row's state is one of the
// transient install/uninstall ones, then stop. The poll is tied to a
// data-asset-id sentinel on the panel so it auto-cancels when the modal
// is closed.

function _agentStatusLabel(s) {
  switch (s) {
    case "pending":          return "Pending — install queued";
    case "uploading":        return "Uploading binary";
    case "enrolling":        return "Awaiting enrollment";
    case "active":           return "Active";
    case "failed":           return "Install failed";
    case "upgrading":        return "Upgrading";
    case "upgrade_failed":   return "Upgrade failed";
    case "uninstalling":     return "Uninstalling";
    case "uninstall_failed": return "Uninstall failed";
    case "revoked":          return "Revoked (bearer killed)";
    default:                 return s || "—";
  }
}

// The SAME mapping as agent-build.js → _agentStatusBadge (the Agents settings
// page): a status reads the same colour wherever it is shown (CQ-F021 — an
// upgrade_failed agent read red there and grey here). tests/unit/
// agentStatusColorParity.test.ts fails if the two drift apart.
function _agentStatusColor(s) {
  switch (s) {
    case "active":            return "var(--color-success)";
    case "failed":
    case "upgrade_failed":
    case "uninstall_failed":  return "var(--color-danger)";
    case "revoked":           return "var(--color-warning)";
    case "pending":
    case "uploading":
    case "enrolling":
    case "upgrading":
    case "uninstalling":      return "var(--color-accent)";
    default:                  return "var(--color-text-tertiary)";
  }
}

// Asset-source kinds the agent can be installed on — mirrors the "agent"
// entries in COMPATIBILITY (src/utils/pollingCompatibility.ts), which is what
// the install service actually enforces (`isPollingMethodCompatible(kind,
// "agent")`). vCenter is in the set on purpose: a vCenter-discovered VM is an
// ordinary guest OS and the bulk-deploy path has always accepted one. The two
// Fortinet sources are not — a FortiGate/FortiSwitch/FortiAP runs FortiOS and
// has nowhere to put a Go binary.
var _AGENT_INSTALLABLE_SOURCES = [
  "manual", "activedirectory", "entraid", "windowsserver", "azurearc", "vcenter",
  // A VM on an Unraid / TrueNAS host or a Proxmox node is a guest OS like a
  // vCenter VM; the host and its containers are refused below by type.
  "unraid", "truenas", "proxmox",
  // A Generic API record can be any device; a server or workstation it lists
  // takes the agent like a manually added one.
  "genericapi",
];

// True when an install could actually succeed on this asset: compatible
// source, and not an ESXi host (POST /assets/:id/agent/install 400s on
// `assetType === "hypervisor"`, and the bulk path skips it).
function _assetSupportsAgentInstall(a) {
  if (!a || a.assetType === "hypervisor" || a.assetType === "container") return false;
  var kind = (a.discoveredByIntegration && a.discoveredByIntegration.type) || "manual";
  // An integration type this build doesn't know reads as "manual" server-side
  // (assetSourceKindFromIntegrationType's default) — match that rather than
  // withholding the button on a source we simply can't name.
  if (!_POLLING_COMPAT[kind]) kind = "manual";
  return _AGENT_INSTALLABLE_SOURCES.indexOf(kind) >= 0;
}

// Asset types that are agent targets by nature: an operator looking at a
// server or a workstation should be able to deploy from the asset itself
// rather than having to pick "Polaris Agent" in a polling dropdown first, or
// go find the bulk-deploy path. Every other type (firewall, switch, AP,
// printer, hypervisor — the install service refuses ESXi outright) still has
// to opt in through a polling method.
var _AGENT_OFFERED_ASSET_TYPES = ["server", "workstation"];

// Decide whether the panel should render at all for this asset.
function _assetHasAgentIntent(a, agent) {
  if (agent) return true;
  if (!a) return false;
  if (a.responseTimePolling === "agent" ||
      a.cpuMemoryPolling    === "agent" ||
      a.interfacesPolling   === "agent" ||
      a.lldpPolling         === "agent" ||
      a.storagePolling      === "agent") return true;
  // Deploy-from-here offer. Needs an id (the install service installs onto an
  // existing row) and a source the agent is compatible with, or the button
  // would open a modal whose Install can only 400.
  return !!a.id && _AGENT_OFFERED_ASSET_TYPES.indexOf(a.assetType) >= 0 &&
         _assetSupportsAgentInstall(a);
}

function assetAgentSubpanelHTML(a, agent) {
  if (!_assetHasAgentIntent(a, agent)) return "";

  var headerBadge = agent
    ? '<span style="font-size:0.75rem;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);color:' +
        _agentStatusColor(agent.installStatus) + '">' +
        escapeHtml(_agentStatusLabel(agent.installStatus)) + '</span>'
    : '';

  var inFlight = agent && (
    agent.installStatus === "pending"      ||
    agent.installStatus === "uploading"    ||
    agent.installStatus === "enrolling"    ||
    agent.installStatus === "uninstalling"
  );

  var body;
  if (!agent) {
    // No row yet — operator opted in via a polling-method dropdown but
    // hasn't kicked off the install. Single big CTA.
    // Two ways to land here, and they need different copy: the operator
    // picked "Polaris Agent" in a polling dropdown (and is waiting for the
    // install they implied), or this is simply a server / workstation and we
    // are offering the deploy where they are already standing.
    var pickedAgentMethod =
      a.responseTimePolling === "agent" || a.cpuMemoryPolling  === "agent" ||
      a.interfacesPolling   === "agent" || a.lldpPolling       === "agent" ||
      a.storagePolling      === "agent";
    body =
      '<p style="color:var(--color-text-secondary);margin:0 0 0.75rem">' +
        (pickedAgentMethod
          ? 'You picked "Polaris Agent" as a polling method but no agent is installed yet. ' +
            'Click below to push the agent to this host via a stored SSH or WinRM credential.'
          : 'No agent is installed on this host. The agent pushes CPU, memory, interface, ' +
            'storage and process data back to Polaris directly — no per-stream credential ' +
            'polling. Click below to push it via a stored SSH or WinRM credential.') +
      '</p>' +
      // Deploying is `assets=fullwrite` (canDeployAgent) — a notch above the
      // rest of this page. Withhold the button rather than let the click 403.
      (canDeployAgent()
        ? '<button type="button" class="btn btn-primary" id="btn-agent-install" data-asset-id="' + escapeHtml(a.id) + '">Install Agent…</button>'
        : '<p class="hint" style="margin:0">Deploying the agent needs Full Read-Write on Assets — ask an administrator.</p>');
  } else {
    // Row exists — show the diagnostic strip + action buttons relevant to
    // the current state. We render the strip uniformly regardless of state
    // so a transitioning row doesn't make UI elements jump.
    var versionRow = agent.agentVersion
      ? '<div>Version: <strong>' + escapeHtml(agent.agentVersion) + '</strong></div>'
      : '<div style="color:var(--color-text-tertiary)">Version: not yet reported</div>';
    var platformRow = '<div>Platform: <strong>' + escapeHtml(agent.osPlatform) + '/' + escapeHtml(agent.arch) + '</strong></div>';
    var lastSeenRow = agent.lastSeenAt
      ? '<div>Last seen: <strong>' + escapeHtml(timeAgo(agent.lastSeenAt)) + '</strong>' +
        ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(formatDateTime(agent.lastSeenAt)) + ')</span></div>'
      : '<div style="color:var(--color-text-tertiary)">Last seen: never</div>';
    // WS state heuristic: connected if wsConnectedAt > wsDisconnectedAt (or
    // disconnect is null). Not perfectly authoritative but cheap and right
    // 99% of the time; the server's `agentChannelService.isAttached` is
    // the source of truth but isn't exposed on this endpoint.
    var wsConnected = agent.wsConnectedAt &&
      (!agent.wsDisconnectedAt || new Date(agent.wsConnectedAt) > new Date(agent.wsDisconnectedAt));
    var wsRow = '<div>WebSocket: <strong style="color:' + (wsConnected ? 'var(--color-success)' : 'var(--color-text-secondary)') + '">' +
      (wsConnected ? 'Connected' : 'Disconnected') + '</strong></div>';

    // Privilege level the agent runs at. Windows = LocalSystem, macOS = root
    // (LaunchDaemon), Linux = one of the privilege tiers. For the ptrace tier
    // the row renders the VERIFIED state when the agent has reported its
    // effective capabilities (`caps`, agent ≥0.17.1) — a unit written before
    // the CAP_DAC_READ_SEARCH fix grants less than the tier promises and
    // collects no Application Map connections (see _agentPrivilegeCell in
    // agent-build.js, same three-state logic).
    var privLabel, privColor;
    if (agent.osPlatform === "windows") { privLabel = "LocalSystem"; privColor = ""; }
    else if (agent.osPlatform === "darwin") { privLabel = "Root"; privColor = "var(--color-warning)"; }
    else if (agent.privilegeTier === "root") { privLabel = "Root (legacy — reinstall to update)"; privColor = "var(--color-warning)"; }
    else if (agent.privilegeTier === "ptrace") {
      if (agent.caps && agent.caps.sysPtrace && agent.caps.dacReadSearch) {
        privLabel = "CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH ✓ (connection mapping)"; privColor = "var(--color-warning)";
      } else if (agent.caps) {
        privLabel = "CAP_SYS_PTRACE only — stale unit, reinstall (collects no connections)"; privColor = "var(--color-danger)";
      } else {
        privLabel = "CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH (unverified — awaiting agent report)"; privColor = "var(--color-warning)";
      }
    }
    else { privLabel = "Unprivileged"; privColor = ""; }
    var privRow = '<div>Privileges: <strong' + (privColor ? ' style="color:' + privColor + '"' : '') + '>' + privLabel + '</strong></div>';
    var rebootRow = _agentRebootRowHTML(agent);

    var errBlock = agent.installError
      ? '<div style="margin:0.5rem 0;padding:0.5rem 0.75rem;background:rgba(255,80,80,0.08);' +
        'border-left:3px solid var(--color-danger);border-radius:4px;font-family:monospace;font-size:0.8rem;' +
        'color:var(--color-danger);white-space:pre-wrap;word-break:break-word">' +
        escapeHtml(agent.installError) + '</div>'
      : '';

    var actions = '';
    if (agent.installStatus === "active") {
      // Upgrade is always shown on active agents. If the agent is already
      // at manifest.currentVersion the route 409s with a clear message;
      // we'd need a separate /inventory fetch to gate this client-side
      // and the round-trip isn't worth it for a button operators rarely
      // click on a current agent.
      actions =
        '<button type="button" class="btn btn-secondary" id="btn-agent-upgrade" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Upgrade…</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-uninstall" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Uninstall</button>';
    } else if (agent.installStatus === "failed") {
      // Retry uses the credential + os/arch stored on the row, so the
      // operator doesn't have to re-pick them in a modal. When the row
      // has no installCredentialId on file (credential was deleted),
      // fall back to the full install modal so they can choose a new one.
      var retryId = agent.installCredentialId ? "btn-agent-install-retry" : "btn-agent-install";
      actions =
        '<button type="button" class="btn btn-primary" id="' + retryId + '" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Retry Install…</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    } else if (agent.installStatus === "upgrade_failed") {
      actions =
        '<button type="button" class="btn btn-primary" id="btn-agent-upgrade" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Retry Upgrade</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-uninstall" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Uninstall</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    } else if (agent.installStatus === "uninstall_failed") {
      actions =
        '<button type="button" class="btn btn-secondary" id="btn-agent-uninstall" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Retry Uninstall</button>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    } else if (agent.installStatus === "revoked") {
      actions =
        '<button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    } else if (inFlight) {
      // Operator can always bail out via force-remove while a transient
      // state is in flight. The async work continues server-side; force-
      // remove just drops the local row.
      actions =
        '<span style="color:var(--color-text-tertiary);font-size:0.85rem">Working…</span>' +
        ' <button type="button" class="btn btn-secondary" id="btn-agent-force-remove" data-managed-agent-id="' + escapeHtml(agent.id) + '" data-asset-id="' + escapeHtml(a.id) + '">Force Remove</button>';
    }

    // Every verb in `actions` pushes, replaces or removes the agent on the
    // host, so the whole strip is behind canDeployAgent(). The diagnostic
    // rows above stay visible at `assets=read` — seeing what is installed is
    // not the same grant as changing it.
    if (!canDeployAgent()) actions = '';

    body =
      errBlock +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem 1.25rem;margin:0.5rem 0">' +
        versionRow + platformRow + lastSeenRow + wsRow + privRow + rebootRow +
      '</div>' +
      (actions
        ? '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem">' + actions + '</div>'
        : '');
  }

  return '<div id="asset-agent-panel" data-asset-id="' + escapeHtml(a.id) + '" style="margin:0 0 1.5rem;padding:1rem;border:1px solid var(--color-border);border-radius:6px;background:var(--color-bg-primary);box-shadow:var(--shadow-card)">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:0.5rem">' +
      '<h4 style="margin:0;display:flex;align-items:baseline;gap:0.5rem">Polaris Agent ' + headerBadge + '</h4>' +
    '</div>' +
    body +
  '</div>';
}

// Install-progress poll handle (one per modal open). Keyed on assetId so
// reopening the same modal doesn't double-poll.
var _agentPollAssetId = null;

function _isTransientAgentState(s) {
  return s === "pending" || s === "uploading" || s === "enrolling" ||
         s === "uninstalling" || s === "upgrading";
}

function _wireAgentSubpanel(a, agent) {
  var panel = document.getElementById("asset-agent-panel");
  if (!panel) return;

  var installBtn = document.getElementById("btn-agent-install");
  if (installBtn) {
    installBtn.addEventListener("click", function () { _openInstallAgentModal(a); });
  }

  var retryBtn = document.getElementById("btn-agent-install-retry");
  if (retryBtn) {
    retryBtn.addEventListener("click", function () {
      _confirmRetryInstallAgent(a, agent);
    });
  }

  var uninstallBtn = document.getElementById("btn-agent-uninstall");
  if (uninstallBtn) {
    uninstallBtn.addEventListener("click", function () {
      _confirmUninstallAgent(a, /* force */ false);
    });
  }

  var forceBtn = document.getElementById("btn-agent-force-remove");
  if (forceBtn) {
    forceBtn.addEventListener("click", function () {
      _confirmUninstallAgent(a, /* force */ true);
    });
  }

  var rebootToggle = document.getElementById("btn-agent-reboot-toggle");
  if (rebootToggle) {
    rebootToggle.addEventListener("click", function () { _toggleAgentReboot(a, agent, rebootToggle); });
  }

  var upgradeBtn = document.getElementById("btn-agent-upgrade");
  if (upgradeBtn) {
    upgradeBtn.addEventListener("click", function () {
      _confirmUpgradeAgent(a, agent);
    });
  }

  // Start the progress poll if the row is in a transient state. Stops
  // automatically when state stabilizes or the modal closes (we re-check
  // that the panel sentinel is still in the DOM each tick).
  if (agent && _isTransientAgentState(agent.installStatus)) {
    _startAgentPoll(a);
  }
}

function _confirmRetryInstallAgent(a, agent) {
  // Retry reuses the credential + os/arch stored on the row at the
  // original install — no modal. Shows a confirm so a misclick can
  // back out, since this will re-attempt SSH/WinRM against the host.
  var prompt =
    "Retry the Polaris Agent install on " + (a.hostname || a.ipAddress || "this asset") + "?\n\n" +
    "Polaris will reconnect over " + (agent && agent.osPlatform === "windows" ? "WinRM" : "SSH") +
    " using the same credential as the previous attempt, re-upload the agent binary, and run the installer.";
  showConfirm(prompt).then(function (ok) {
    if (!ok) return;
    api.assets.retryInstallAgent(a.id).then(function () {
      showToast("Retry started — watch progress in the Agent panel", "success");
      api.assets.agent(a.id).then(function (ag) {
        _rerenderAgentSubpanel(a, ag);
      });
    }).catch(function (err) {
      showToast("Retry failed: " + err.message, "error");
    });
  });
}

function _confirmUpgradeAgent(a, agent) {
  // Upgrade reuses the credential stored at install time; no new modal
  // needed. We do show a confirm so an operator who reflexively clicked
  // can back out (the upgrade WILL bounce the agent service briefly).
  var prompt =
    "Upgrade the Polaris Agent on " + (a.hostname || a.ipAddress || "this asset") + "?\n\n" +
    "Polaris will SSH/WinRM into the host using the install credential, " +
    "stop the agent service, replace the binary, and restart. The agent's " +
    "bearer and cert pin are preserved — no re-enrollment required. The " +
    "agent will be offline for ~2 seconds while the service restarts.";
  showConfirm(prompt).then(function (ok) {
    if (!ok) return;
    api.assets.upgradeAgent(a.id, {}).then(function (r) {
      showToast("Upgrade started — v" + (r.fromVersion || "?") + " → v" + r.toVersion, "success");
      api.assets.agent(a.id).then(function (ag) {
        _rerenderAgentSubpanel(a, ag);
      });
    }).catch(function (err) {
      showToast("Upgrade failed: " + err.message, "error");
    });
  });
}

function _startAgentPoll(a) {
  if (_agentPollAssetId === a.id) return; // already polling
  _agentPollAssetId = a.id;
  var tick = function () {
    // Bail if the modal closed or the user navigated away.
    var stillOpen = document.getElementById("asset-agent-panel");
    if (!stillOpen || stillOpen.getAttribute("data-asset-id") !== a.id) {
      _agentPollAssetId = null;
      return;
    }
    api.assets.agent(a.id).then(function (agent) {
      // Re-check we're still rendering the same asset.
      var stillOpen2 = document.getElementById("asset-agent-panel");
      if (!stillOpen2 || stillOpen2.getAttribute("data-asset-id") !== a.id) {
        _agentPollAssetId = null;
        return;
      }
      _rerenderAgentSubpanel(a, agent);
      if (agent && _isTransientAgentState(agent.installStatus)) {
        setTimeout(tick, 3000);
      } else {
        _agentPollAssetId = null;
      }
    }).catch(function () {
      // Network blip — try again on the next tick.
      setTimeout(tick, 5000);
    });
  };
  setTimeout(tick, 3000);
}

function _rerenderAgentSubpanel(a, agent) {
  var mount = document.getElementById("asset-agent-panel-mount");
  if (!mount) return;
  mount.innerHTML = assetAgentSubpanelHTML(a, agent);
  _wireAgentSubpanel(a, agent);
}

// ─── Firmware card (business rule 87) ────────────────────────────────────────
// A card on the System tab under the Polaris Agent card, for switches and
// access points: what the Repository can offer this device, the approval
// dialog that names the exact image before anything is pushed, live progress
// polled from the run row while a flash is in flight, and the run history.
// The server owns every state word and reason (`fw.state`, `fw.reason`); the
// card never regexes a sentence to decide what to draw.

function _assetFirmwareEligible(a) {
  return !!a && (a.assetType === "switch" || a.assetType === "access_point" || a.assetType === "firewall");
}

var _FW_STAGE_LABELS = {
  preflight:  "Signing in",
  staging:    "Uploading image",
  compat:     "Checking compatibility",
  deploying:  "Deploying",
  rebooting:  "Rebooting",
  verifying:  "Verifying new version",
  recovering: "Waiting for monitoring to answer",
};

function _fwBadge(text, color) {
  return '<span style="font-size:0.75rem;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);color:' + color + '">' + escapeHtml(text) + '</span>';
}

function _fwImageLine(img) {
  if (!img) return "";
  return '<strong>' + escapeHtml(img.versionLabel) + '</strong>' +
    (img.platform ? ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(img.platform) + ')</span>' : '');
}

function _fwRunResultHTML(run) {
  if (!run) return "";
  var when = run.finishedAt ? timeAgo(run.finishedAt) : (run.startedAt ? timeAgo(run.startedAt) : "");
  if (run.status === "succeeded") {
    return '<div style="font-size:0.85rem;color:var(--color-success);margin:0.4rem 0">' +
      (run.result === "already-current" ? "Already at " : "Upgraded to ") + escapeHtml(run.verifiedVersion || run.toVersion) + ', ' + escapeHtml(when) + '</div>';
  }
  if (run.status === "unverified") {
    return '<div style="font-size:0.85rem;color:var(--color-warning);margin:0.4rem 0">The device rebooted but Polaris couldn’t confirm the version — check it on the device. ' +
      (run.error ? '<span style="color:var(--color-text-secondary)">' + escapeHtml(run.error) + '</span>' : '') + '</div>';
  }
  if (run.status === "failed") {
    return '<div style="margin:0.5rem 0;padding:0.5rem 0.75rem;background:rgba(255,80,80,0.08);' +
      'border-left:3px solid var(--color-danger);border-radius:4px;font-family:monospace;font-size:0.8rem;' +
      'color:var(--color-danger);white-space:pre-wrap;word-break:break-word">' +
      'Upgrade to ' + escapeHtml(run.toVersion) + ' failed' + (run.stage ? ' at ' + escapeHtml(_FW_STAGE_LABELS[run.stage] || run.stage).toLowerCase() : '') + ': ' +
      escapeHtml(run.error || "unknown error") + '</div>';
  }
  return "";
}

function _fwStageRow(label, pct, state) {
  var cls = "fw-stage" + (state ? " " + state : "");
  // A step with no percentage (reboot, verify, the monitoring wait) slides
  // while it runs and reads FULL once done — an empty track under a finished
  // step looked like one that never ran.
  var bar = pct === null
    ? (state === "is-done"
        ? '<span class="fw-progress"><span class="fw-progress-fill" style="width:100%"></span></span>'
        : '<span class="fw-progress' + (state === "is-active" ? " is-indeterminate" : "") + '"><span class="fw-progress-fill"></span></span>')
    : '<span class="fw-progress"><span class="fw-progress-fill" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></span></span>';
  return '<div class="' + cls + '"><span class="fw-stage-label">' + escapeHtml(label) + '</span>' + bar +
    '<span class="fw-stage-pct">' + (pct === null ? '' : Math.round(pct) + '%') + '</span></div>';
}

function _fwProgressHTML(run) {
  var p = (run && run.progress) || {};
  var stage = run && run.stage;
  var order = ["preflight", "staging", "compat", "deploying", "rebooting", "verifying", "recovering"];
  var idx = order.indexOf(stage);
  var rows = "";
  // The switch reports percentages for erase / write / verify while deploying.
  var hasPct = typeof p.erase === "number" || typeof p.write === "number" || typeof p.verify === "number";
  if (hasPct) {
    var eraseDone = (p.erase || 0) >= 100;
    var writeDone = (p.write || 0) >= 100;
    rows += _fwStageRow("Erasing flash", p.erase || 0, eraseDone ? "is-done" : "is-active");
    rows += _fwStageRow("Writing image", p.write || 0, writeDone ? "is-done" : (eraseDone ? "is-active" : ""));
    rows += _fwStageRow("Verifying image", p.verify || 0, (p.verify || 0) >= 100 ? "is-done" : (writeDone ? "is-active" : ""));
  }
  if (idx >= order.indexOf("rebooting")) rows += _fwStageRow("Rebooting", null, stage === "rebooting" ? "is-active" : "is-done");
  if (idx >= order.indexOf("verifying")) rows += _fwStageRow("Verifying new version", null, stage === "verifying" ? "is-active" : "is-done");
  // The device answered its web UI; the maintenance window stays open until
  // Polaris's own monitoring probe answers too (the runner's last stage).
  if (idx >= order.indexOf("recovering")) rows += _fwStageRow("Waiting for monitoring to answer", null, "is-active");
  // No "step N of M": the switch's counter sat at 6/40 for an entire flash on
  // prod (and in fortiupgrade's capture) — it only ever misled.
  var step = '';
  return '<div id="asset-fw-progress">' +
    '<div style="font-size:0.85rem;margin:0.3rem 0 0.5rem">Stage: <strong>' + escapeHtml(_FW_STAGE_LABELS[stage] || stage || "starting") + '</strong>' + escapeHtml(step) +
      (run && run.startedAt ? ' <span style="color:var(--color-text-tertiary)">· started ' + escapeHtml(timeAgo(run.startedAt)) + '</span>' : '') + '</div>' +
    rows +
    '<p class="hint" style="margin:0.5rem 0 0">Do not power-cycle the device while it is flashing. Polaris holds its alerts until the run finishes.</p>' +
  '</div>';
}

function _fwRunHistoryHTML(a) {
  return '<div style="margin-top:0.6rem">' +
    '<button type="button" class="btn btn-link btn-sm" id="btn-fw-history" style="padding:0">Run history ▸</button>' +
    '<div id="asset-fw-history" style="display:none;margin-top:0.4rem"></div>' +
  '</div>';
}

/** "HUB1-a (primary), HUB1-b": an HA cluster's members as the card names them (rule 129). */
function _fwClusterMembersText(cluster) {
  return (cluster.members || []).map(function (m) {
    return (m.hostname || m.serial) + (m.role === "primary" ? " (primary)" : "");
  }).join(", ");
}

/** The standby of an HA cluster: the cluster is upgraded from its primary's card (rule 129). */
function _fwClusterMemberHTML(fw) {
  var p = fw.clusterPrimary;
  var link = p
    ? ' <a href="#" class="fw-open-cluster-primary" data-asset-id="' + escapeHtml(p.assetId) + '">Open ' + escapeHtml(p.hostname || "the primary") + '</a>'
    : '';
  var html = '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0">' + escapeHtml(fw.reason || "") + link + '</p>';
  if (fw.activeRun) {
    html += '<div style="font-size:0.85rem;margin-top:0.5rem">The cluster is upgrading now: ' + escapeHtml(fw.activeRun.fromVersion || "?") + ' → ' + escapeHtml(fw.activeRun.toVersion) + '</div>' + _fwProgressHTML(fw.activeRun);
  }
  return html;
}

function assetFirmwarePanelHTML(a, fw) {
  if (!fw || !_assetFirmwareEligible(a)) return "";
  var badge = "";
  var body = "";
  // Whoever may edit an asset may upgrade it (operator decision, 2026-09-26).
  var canFlash = typeof permAtLeast === "function" && permAtLeast("assets", "write");
  var repoLink = (typeof permAtLeast === "function" && permAtLeast("firmware", "read"))
    ? ' <a href="/server-settings.html?tab=firmware">Open the Repository</a>'
    : '';
  if (fw.error) {
    body = '<p style="color:var(--color-text-tertiary);font-size:0.85rem;margin:0">Couldn’t read upgrade status: ' + escapeHtml(fw.error) + '</p>';
  } else if (fw.state === "running" && fw.activeRun) {
    badge = _fwBadge("Upgrading", "var(--color-warning)");
    body = '<div style="font-size:0.85rem">' + escapeHtml(fw.activeRun.fromVersion || fw.current || "?") + ' → ' + escapeHtml(fw.activeRun.toVersion) + '</div>' + _fwProgressHTML(fw.activeRun);
  } else if (fw.state === "cluster-member") {
    badge = fw.activeRun ? _fwBadge("Cluster upgrading", "var(--color-warning)") : _fwBadge("HA secondary", "var(--color-text-tertiary)");
    body = _fwClusterMemberHTML(fw);
  } else if (fw.state === "unsupported") {
    badge = _fwBadge("Not supported", "var(--color-text-tertiary)");
    body = '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0">' + escapeHtml(fw.reason || "") + '</p>';
  } else if (fw.state === "up-to-date") {
    badge = _fwBadge("Current", "var(--color-success)");
    body = '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0">Running ' + escapeHtml(fw.current || "?") + '. ' + escapeHtml(fw.reason || "") + '</p>';
  } else if (fw.state === "pending-discovery") {
    badge = _fwBadge("Flashed", "var(--color-success)");
    body = '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0">' + escapeHtml(fw.reason || "") + '</p>';
  } else if (fw.state === "no-image" || fw.state === "no-serial" || fw.state === "no-version") {
    badge = _fwBadge("No image", "var(--color-text-tertiary)");
    body = '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0">' + escapeHtml(fw.reason || "") + repoLink + '</p>';
  } else if (fw.state === "no-credential") {
    badge = _fwBadge("No login bound", "var(--color-warning)");
    body = '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0">' + escapeHtml(fw.reason || "") + repoLink + '</p>';
  } else if (fw.state === "blocked") {
    badge = _fwBadge("Blocked", "var(--color-text-tertiary)");
    body = '<p style="color:var(--color-text-secondary);font-size:0.85rem;margin:0">' + escapeHtml(fw.reason || "") + '</p>';
    // Blocked is about NOW (down, suppressed…); a booking re-takes every gate
    // when it fires (rule 93), so the dialog opens with "Schedule for later"
    // ticked and locked.
    if (canFlash && fw.image && !fw.schedule) {
      body += '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem"><button type="button" class="btn btn-secondary" id="btn-fw-upgrade">Upgrade firmware to ' + escapeHtml(fw.image.versionLabel) + '…</button></div>';
    }
  } else if (fw.state === "available" && fw.image) {
    badge = _fwBadge("Upgrade available", "var(--color-accent)");
    body =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.4rem 1.25rem;margin:0.5rem 0;font-size:0.85rem">' +
        '<div>Current: <strong>' + escapeHtml(fw.current || "?") + '</strong></div>' +
        '<div>Available: ' + _fwImageLine(fw.image) + '</div>' +
        '<div>Model image: <strong>' + escapeHtml(fw.image.model) + '</strong> · ' + escapeHtml(fw.image.role) + '</div>' +
        '<div>Login: <strong>' + escapeHtml(fw.credential ? fw.credential.credentialName : "—") + '</strong>' +
          (fw.credential ? ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(fw.credential.scope) + ' binding)</span>' : '') + '</div>' +
        (fw.backupImage ? '<div style="grid-column:1 / -1;color:var(--color-text-secondary)">Also eligible: ' + _fwImageLine(fw.backupImage) + ' (the model’s backup)</div>' : '') +
        (fw.cluster ? '<div style="grid-column:1 / -1;color:var(--color-text-secondary)">HA cluster (' + escapeHtml(fw.cluster.mode) + '): upgrades every member — ' + escapeHtml(_fwClusterMembersText(fw.cluster)) + '</div>' : '') +
      '</div>' +
      (canFlash
        ? '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.5rem"><button type="button" class="btn btn-primary" id="btn-fw-upgrade">Upgrade firmware to ' + escapeHtml(fw.image.versionLabel) + '…</button></div>'
        : '<p class="hint" style="margin:0">Starting an upgrade needs Read-Write on Assets — ask an administrator.</p>');
  }
  if (!fw.error && fw.schedule) body += _fwScheduleHTML(fw.schedule, canFlash);
  if (!fw.error && fw.group) body += _fwGroupNoteHTML(fw.group);
  if (!fw.error && fw.state !== "running" && fw.lastRun) body += _fwRunResultHTML(fw.lastRun);
  return '<div id="asset-firmware-panel" data-asset-id="' + escapeHtml(a.id) + '" style="margin:0 0 1.5rem;padding:1rem;border:1px solid var(--color-border);border-radius:6px;background:var(--color-bg-primary);box-shadow:var(--shadow-card)">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;margin-bottom:0.5rem">' +
      '<h4 style="margin:0;display:flex;align-items:baseline;gap:0.5rem">Firmware ' + badge + '</h4>' +
    '</div>' +
    body +
    (fw.error ? '' : _fwRunHistoryHTML(a)) +
  '</div>';
}

/**
 * The device is in a pending / running GROUP upgrade (rule 122): the group
 * flashes it, so the card says so and links to the group instead of offering
 * a single-device booking beside it.
 */
function _fwGroupNoteHTML(group) {
  var running = group.status === "running";
  return '<div class="fw-group-note" style="margin-top:0.6rem;padding:0.5rem 0.75rem;border:1px solid var(--color-border);border-radius:6px;font-size:0.85rem;display:flex;justify-content:space-between;align-items:center;gap:0.75rem;flex-wrap:wrap">' +
    '<span>Part of a group upgrade on <strong>' + escapeHtml(group.gateName) + '</strong> — ' +
      (running ? 'running now' : 'scheduled for ' + escapeHtml(_fwWhenText(group.scheduledFor))) +
      (group.memberState && group.memberState !== "planned" ? ' (this device: ' + escapeHtml(group.memberState) + ')' : '') + '.</span>' +
    '<button type="button" class="btn btn-sm btn-secondary" id="btn-fw-group-open" data-group-id="' + escapeHtml(group.id) + '">View group upgrade</button>' +
  '</div>';
}

function _fwApprovalBlockHTML(img, checked, withRadio) {
  var id = "fw-approve-" + img.id;
  return '<label class="fw-approve-block' + (checked ? " is-selected" : "") + '" for="' + id + '" style="display:block;cursor:' + (withRadio ? "pointer" : "default") + '">' +
    (withRadio
      ? '<input type="radio" name="fw-approve-image" id="' + id + '" value="' + escapeHtml(img.id) + '" data-version="' + escapeHtml(img.versionLabel) + '"' + (checked ? " checked" : "") + '> '
      : '<input type="radio" name="fw-approve-image" id="' + id + '" value="' + escapeHtml(img.id) + '" data-version="' + escapeHtml(img.versionLabel) + '" checked style="display:none">') +
    '<strong>' + escapeHtml(img.versionLabel) + '</strong> · ' + escapeHtml(img.role === "backup" ? "the model’s backup image" : "the model’s primary image") +
    '<dl>' +
      '<dt>Platform</dt><dd>' + escapeHtml(img.platform || "unknown") + '</dd>' +
      '<dt>File</dt><dd>' + escapeHtml(img.filename) + ' (' + escapeHtml(typeof formatBytes === "function" ? formatBytes(img.sizeBytes) : img.sizeBytes + " bytes") + ')</dd>' +
      '<dt>SHA-256</dt><dd><code>' + escapeHtml(img.sha256) + '</code></dd>' +
      '<dt>Filed under</dt><dd>' + escapeHtml(img.manufacturer) + ' › ' + escapeHtml(img.assetType === "access_point" ? "access point" : img.assetType) + ' › ' + escapeHtml(img.model) + '</dd>' +
      '<dt>Uploaded</dt><dd>' + escapeHtml(img.uploadedBy || "—") + (img.uploadedAt ? ', ' + escapeHtml(formatDateTime(img.uploadedAt)) : '') + '</dd>' +
    '</dl>' +
  '</label>';
}

/**
 * The upgrade dialog's body — pure, so the DOM test can render it. ONE dialog
 * for a flash now and a flash later (business rule 93): the image is approved
 * by name either way, and a "Schedule for later" box reveals the time and the
 * results recipients. `opts.mode`:
 *   "choose"        — the default: upgrade now, or tick the box to schedule.
 *   "schedule-only" — the device cannot be flashed right now (blocked); the
 *                     box is ticked and locked, because later is the only way.
 *   "change"        — editing a pending booking: the schedule fields only.
 * A device that already has a pending booking is not offered a second one —
 * the box is replaced by a pointer to the booking on the card.
 */
function _fwApprovalModalHTML(a, fw, opts) {
  opts = opts || {};
  var mode = opts.mode || "choose";
  var existing = opts.existing || null;
  var withRadio = !!(fw.image && fw.backupImage);
  var imagePart;
  if (fw.image) {
    imagePart =
      '<p style="font-size:0.85rem;margin:0 0 0.4rem"><strong>Firmware to push</strong>' +
        (withRadio ? ' <span style="color:var(--color-text-secondary)">— the primary image is offered by default; the backup is this model’s previous image.</span>' : '') + '</p>' +
      _fwApprovalBlockHTML(fw.image, true, withRadio) +
      (withRadio ? _fwApprovalBlockHTML(fw.backupImage, false, true) : '') +
      '<div class="alert alert-warning" style="padding:0.6rem 0.75rem;border-radius:6px;background:rgba(214,137,16,0.12);border:1px solid var(--color-warning,#d68910);font-size:0.82rem;margin:0.5rem 0 0.75rem">' +
        (fw.cluster
          ? '<strong>This upgrades the whole HA cluster</strong> (' + escapeHtml(_fwClusterMembersText(fw.cluster)) + '). FortiOS upgrades the secondary first, fails over to it, then reboots this primary — two reboots, about 10 minutes. ' +
            'Traffic moves to the other member while each one reboots, but every member is held in maintenance for the whole run. '
          : '') +
        (a.assetType === "firewall"
          ? (fw.cluster ? '' : 'The FortiGate reboots during the upgrade and will be unreachable for several minutes — every network, tunnel and device behind it goes with it. ') +
            'Follow Fortinet’s supported upgrade path: Polaris checks that the image is newer and fits this platform, not that the jump from the running version is a supported one. '
          : 'The device reboots during the upgrade and will be unreachable for a few minutes — everything behind a switch goes with it. ') +
        'Polaris holds its alerts for this device while it works on it. A flash that fails partway can leave a device unbootable; do not power-cycle it while it is writing.' +
      '</div>' +
      '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:pointer">' +
        '<input type="checkbox" id="fw-approve-ack"> I have checked the version and platform above' +
      '</label>';
  } else {
    // Changing a booking when nothing is offered right now (e.g. already
    // current): it keeps its image; only its time and recipients can change.
    imagePart = '<p style="font-size:0.85rem;margin:0 0 0.6rem"><strong>Firmware to push:</strong> ' + escapeHtml(existing ? existing.toVersion : "—") +
      ' <span style="color:var(--color-text-secondary)">(as booked — the Repository offers nothing else for this device right now)</span></p>';
  }

  var schedulePart;
  if (mode === "change") {
    schedulePart = '<div id="fw-sched-fields" style="margin-top:0.9rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' + _fwScheduleFieldsHTML(fw, existing, opts.defaults) + '</div>' +
      _fwNotifyHTML(opts.defaults, true, existing);
  } else if (fw.group) {
    schedulePart = '<p class="hint" style="margin:0.75rem 0 0">This device is in a group upgrade on ' + escapeHtml(fw.group.gateName) +
      ' (' + escapeHtml(fw.group.status === "running" ? "running now" : _fwWhenText(fw.group.scheduledFor)) + ') — scheduling it is done by the group.</p>' +
      (fw.image ? _fwNotifyHTML(opts.defaults, false) : '');
  } else if (fw.schedule) {
    schedulePart = '<p class="hint" style="margin:0.75rem 0 0">An upgrade to ' + escapeHtml(fw.schedule.toVersion) + ' is already scheduled for ' + escapeHtml(_fwWhenText(fw.schedule.scheduledFor)) + ' — change or cancel it on the Firmware card.</p>' +
      (fw.image ? _fwNotifyHTML(opts.defaults, false) : '');
  } else {
    var locked = mode === "schedule-only";
    schedulePart =
      '<div style="margin-top:0.9rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
        '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:' + (locked ? "default" : "pointer") + '">' +
          '<input type="checkbox" id="fw-approve-schedule"' + (locked ? " checked disabled" : "") + '> Schedule for later' +
        '</label>' +
        (locked
          ? '<p class="hint" style="margin:0.25rem 0 0">This device cannot be upgraded right now' + (fw.reason ? ' — ' + escapeHtml(fw.reason) : '') + ' It can be scheduled: every check runs again when the upgrade is due.</p>'
          : '') +
        '<div id="fw-sched-fields" style="margin-top:0.6rem' + (locked ? '' : ';display:none') + '">' + _fwScheduleFieldsHTML(fw, null, opts.defaults, { emails: false }) + '</div>' +
        _fwNotifyHTML(opts.defaults, locked) +
      '</div>';
  }

  return '<div class="fw-approve-block">' +
      '<strong>Device</strong>' +
      '<dl>' +
        '<dt>Host</dt><dd>' + escapeHtml(a.hostname || "—") + (a.ipAddress ? ' (' + escapeHtml(a.ipAddress) + ')' : '') + '</dd>' +
        '<dt>Serial</dt><dd>' + escapeHtml(a.serialNumber || "—") + '</dd>' +
        '<dt>Running</dt><dd>' + escapeHtml(fw.current || "unknown") + '</dd>' +
        '<dt>Login</dt><dd>' + escapeHtml(fw.credential ? fw.credential.credentialName : "—") + (fw.credential ? ' (' + escapeHtml(fw.credential.scope) + ' binding)' : '') + '</dd>' +
      '</dl>' +
    '</div>' +
    imagePart +
    schedulePart;
}

/**
 * The time a booking runs at. `existing` pre-fills it when a booking is being
 * changed; otherwise the next whole hour. Who hears about it is the "Email
 * notifications" block (`_fwNotifyHTML`), shared with a flash now.
 */
function _fwScheduleFieldsHTML(fw, existing) {
  var when = existing ? new Date(existing.scheduledFor) : (function () { var d = new Date(Date.now() + 60 * 60000); d.setMinutes(0, 0, 0); return d; })();
  var min = _fwLocalInputValue(new Date(Date.now() + 2 * 60000));
  var zone = _fwBrowserZone();
  var warn = (fw.blockers && fw.blockers.length)
    ? '<div class="hint" style="margin:0 0 0.6rem;color:var(--color-warning)">Right now ' + escapeHtml(fw.blockers.join("; ")) + '. That is checked again when the upgrade is due — if it still holds then, the upgrade is not started and the recipients are told why.</div>'
    : '';
  return warn +
    '<div class="form-group">' +
      '<label for="fw-sched-when">Run at</label>' +
      '<input type="datetime-local" id="fw-sched-when" min="' + escapeHtml(min) + '" value="' + escapeHtml(_fwLocalInputValue(when)) + '">' +
      '<p class="hint" style="margin:0.25rem 0 0">Your time' + (zone ? ' (' + escapeHtml(zone) + ')' : '') + '. If Polaris is not running at that time and only gets to it more than 15 minutes late, the upgrade is not started. If an upgrade on a related device is still running, this one waits up to 2 hours for it.</p>' +
    '</div>';
}

var _FW_NOTIFY_HINT_NOW = "Emailed when the upgrade starts and when it finishes — succeeded or failed. Roles, regions and the device’s own recipients are worked out when each email is sent.";
var _FW_NOTIFY_HINT_SCHEDULED = "Emailed when it is scheduled, when it starts and when it finishes — succeeded or failed — or if it cannot be started. A scheduled upgrade always emails someone. Roles, regions and the device’s own recipients are worked out when each email is sent.";

/**
 * The notify editor for this dialog — the automations' To / Cc / Bcc picker
 * plus the email channels (public/js/recipient-picker.js). Built the same way
 * to render and to wire / read, so the pure HTML function and the opener agree.
 * `existing` = the booking being changed (its own recipients), else the
 * operator's remembered ones from `defaults`.
 */
function _fwNotifyEditor(defaults, existing) {
  if (!window.PolarisRecipientPicker || !PolarisRecipientPicker.notifyEditor) return null;
  return PolarisRecipientPicker.notifyEditor({
    prefix: "fw",
    defaults: defaults || {},
    spec: existing ? PolarisRecipientPicker.bookingNotifySpec(existing) : null,
    withBook: !!(window.PolarisAddressBook && typeof permAtLeast === "function" && permAtLeast("contacts", "read")),
  });
}

/**
 * "Email notifications" (rule 93): off by default for a flash now — ticking it
 * emails the recipients when the flash starts and when it ends; always on, and
 * locked, while "Schedule for later" is ticked (and when changing a booking),
 * because a booking must email someone. Pre-filled with what the operator used
 * last time, else themselves.
 */
function _fwNotifyHTML(defaults, locked, existing) {
  var ed = _fwNotifyEditor(defaults, existing);
  return '<div style="margin-top:0.75rem">' +
      '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:' + (locked ? "default" : "pointer") + '">' +
        '<input type="checkbox" id="fw-approve-notify"' + (locked ? " checked disabled" : "") + '> Email notifications' +
      '</label>' +
      '<div id="fw-notify-fields" style="margin-top:0.6rem' + (locked ? '' : ';display:none') + '">' +
        (ed ? ed.html() : '') +
        '<p class="hint" id="fw-notify-hint" style="margin:0.35rem 0 0">' + escapeHtml(locked ? _FW_NOTIFY_HINT_SCHEDULED : _FW_NOTIFY_HINT_NOW) + '</p>' +
      '</div>' +
    '</div>';
}

function _fwSelectedApproval() {
  var r = document.querySelector('input[name="fw-approve-image"]:checked');
  return r ? { imageId: r.value, version: r.getAttribute("data-version") } : null;
}

/**
 * Open the upgrade dialog. `existing` = change that pending booking. A device
 * in the `blocked` state opens with scheduling ticked and locked: its gates
 * refuse a flash now, and a booking re-takes them when it is due.
 */
async function _openFirmwareApprovalModal(a, fw, existing) {
  var mode = existing ? "change" : (fw.state === "blocked" ? "schedule-only" : "choose");
  // What the notify editor opens with — the operator's last recipients (else
  // themselves) and the picker's catalogue: regions, roles, tags, users and the
  // email channels (rule 93). Needed when changing a booking too.
  var defaults = null;
  try { defaults = await api.assets.firmwareScheduleDefaults(a.id); } catch (e) { defaults = null; }
  var title = (existing ? "Change scheduled upgrade — " : "Firmware upgrade — ") + (a.hostname || a.ipAddress || "device");
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-fw-approve" disabled></button>';
  openModal(title, _fwApprovalModalHTML(a, fw, { mode: mode, existing: existing, defaults: defaults }), footer);

  var ack = document.getElementById("fw-approve-ack");
  var btn = document.getElementById("btn-fw-approve");
  var later = document.getElementById("fw-approve-schedule");
  var fields = document.getElementById("fw-sched-fields");
  var whenEl = document.getElementById("fw-sched-when");
  var notify = document.getElementById("fw-approve-notify");
  var notifyFields = document.getElementById("fw-notify-fields");
  var notifyHint = document.getElementById("fw-notify-hint");
  var editor = _fwNotifyEditor(defaults, existing);
  if (editor && notifyFields) editor.wire(notifyFields, function () { sync(); });
  // Changing a booking pre-selects the image it was approved with, and that
  // approval stands — the box is ticked; picking another image unticks it.
  var bookedImage = existing ? existing.imageId : null;
  if (bookedImage) {
    var pre = document.getElementById("fw-approve-" + bookedImage);
    if (pre) { pre.checked = true; if (ack) ack.checked = true; }
  }
  function scheduling() { return mode === "change" || !!(later && later.checked); }
  // A booking always emails someone, so scheduling ticks and locks the box;
  // unticking "Schedule for later" puts back what the operator had chosen.
  var notifyChoice = notify ? notify.checked : false;
  if (notify) notify.addEventListener("change", function () { notifyChoice = notify.checked; });
  function emailing() { return scheduling() || !!(notify && notify.checked); }
  function sync(ev) {
    var sel = fw.image ? _fwSelectedApproval() : null;
    if (ev && ev.target && ev.target.name === "fw-approve-image" && ack && sel && sel.imageId !== bookedImage) ack.checked = false;
    if (fields && later) fields.style.display = later.checked ? "" : "none";
    if (notify && mode !== "schedule-only") {
      notify.disabled = scheduling();
      notify.checked = scheduling() || notifyChoice;
    }
    if (notifyFields) notifyFields.style.display = emailing() ? "" : "none";
    if (notifyHint && notify) notifyHint.textContent = scheduling() ? _FW_NOTIFY_HINT_SCHEDULED : _FW_NOTIFY_HINT_NOW;
    var imageOk = !fw.image || !!(ack && ack.checked && sel);
    var emailsOk = !emailing() || !!(editor && notifyFields && editor.ready(notifyFields));
    var version = sel ? sel.version : (existing ? existing.toVersion : "");
    if (scheduling()) {
      btn.textContent = existing ? "Save changes" : "Schedule upgrade to " + version;
      btn.disabled = !(imageOk && whenEl && whenEl.value && emailsOk);
    } else {
      btn.textContent = "Approve and upgrade to " + version;
      btn.disabled = !(imageOk && emailsOk);
    }
    document.querySelectorAll(".fw-approve-block").forEach(function (b) {
      var r = b.querySelector('input[name="fw-approve-image"]');
      if (r) b.classList.toggle("is-selected", r.checked);
    });
  }
  if (ack) ack.addEventListener("change", sync);
  if (later) later.addEventListener("change", sync);
  if (notify) notify.addEventListener("change", sync);
  if (whenEl) whenEl.addEventListener("input", sync);
  document.querySelectorAll('input[name="fw-approve-image"]').forEach(function (r) { r.addEventListener("change", sync); });

  btn.addEventListener("click", function () {
    var sel = fw.image ? _fwSelectedApproval() : null;
    var call, done;
    if (scheduling()) {
      var when = new Date(whenEl.value); // datetime-local parses as the browser's local time
      if (isNaN(when.getTime())) { showToast("Pick a date and time", "error"); return; }
      var body = { scheduledFor: when.toISOString(), notify: editor.read(notifyFields) };
      if (sel && (!existing || sel.imageId !== existing.imageId)) body.imageId = sel.imageId;
      call = existing ? api.assets.updateFirmwareSchedule(a.id, existing.id, body) : api.assets.scheduleFirmwareUpgrade(a.id, body);
      done = existing ? "Scheduled upgrade changed" : "Upgrade scheduled for " + formatDateTime(when);
    } else {
      if (!sel) return;
      var startBody = { imageId: sel.imageId };
      if (emailing() && editor) startBody.notify = editor.read(notifyFields);
      call = api.assets.startFirmwareUpgrade(a.id, startBody);
      done = startBody.notify ? "Upgrade started — notifications are on" : "Upgrade started";
    }
    btn.disabled = true;
    call.then(function () {
      closeModal();
      showToast(done, "success");
      // The nav bar's operations panel shows the flash now, not after its idle poll (rule 138).
      if (!scheduling() && typeof window._pollFirmwareRuns === "function") window._pollFirmwareRuns();
      return api.assets.firmwareUpgrade(a.id).then(function (next) { _rerenderFirmwarePanel(a, next); });
    }).catch(function (err) {
      btn.disabled = false;
      showToast((err && err.message) || (scheduling() ? "Could not save the schedule" : "Could not start the upgrade"), "error");
    });
  });
  sync();
}

// ─── Scheduled upgrades (business rule 93) ───────────────────────────────────
// A flash booked for later is made in the upgrade dialog itself ("Schedule for
// later"); the card shows the pending booking with Change… (the same dialog in
// "change" mode) and Cancel. Every gate is re-taken when the booking fires.

/** "YYYY-MM-DDTHH:MM" in the browser's zone — a datetime-local input's value. */
function _fwLocalInputValue(d) {
  return PolarisAssetShared.fwLocalInputValue(d);
}

function _fwBrowserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (e) { return ""; }
}

/** "Tue, Oct 7, 2026, 2:00 AM CDT (in 9 h)" — the booking as the reader's clock shows it. */
function _fwWhenText(iso) {
  return PolarisAssetShared.fwWhenText(iso);
}

function _fwScheduleHTML(sched, canFlash) {
  return '<div id="asset-fw-schedule" style="margin:0.6rem 0 0.2rem;padding:0.55rem 0.75rem;border:1px solid var(--color-border);border-left:3px solid var(--color-accent);border-radius:4px;font-size:0.85rem">' +
    '<div><strong>Scheduled:</strong> upgrade to <strong>' + escapeHtml(sched.toVersion) + '</strong> at ' + escapeHtml(_fwWhenText(sched.scheduledFor)) + '</div>' +
    '<div style="color:var(--color-text-secondary);margin-top:0.2rem">Start and results emailed to ' + escapeHtml((sched.notifyEmails || []).join(", ")) +
      ' · booked by ' + escapeHtml(sched.createdBy || "—") + '</div>' +
    (sched.error
      ? '<div style="color:var(--color-warning);margin-top:0.2rem">Waiting: ' + escapeHtml(sched.error) + '</div>'
      : '') +
    (canFlash
      ? '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-top:0.45rem">' +
          '<button type="button" class="btn btn-sm btn-secondary" id="btn-fw-schedule-edit">Change…</button>' +
          '<button type="button" class="btn btn-sm btn-danger" id="btn-fw-schedule-cancel">Cancel scheduled upgrade</button>' +
        '</div>'
      : '') +
  '</div>';
}

function _fwParseEmails(text) {
  return PolarisAssetShared.fwParseEmails(text);
}

async function _cancelFirmwareSchedule(a, sched) {
  var ok = await showConfirm("Cancel the upgrade to " + sched.toVersion + " scheduled for " + _fwWhenText(sched.scheduledFor) + "?\nNothing is sent to the device and no email goes out.");
  if (!ok) return;
  try {
    await api.assets.cancelFirmwareSchedule(a.id, sched.id);
    showToast("Scheduled upgrade cancelled", "success");
  } catch (err) {
    showToast((err && err.message) || "Could not cancel the scheduled upgrade", "error");
  }
  try { _rerenderFirmwarePanel(a, await api.assets.firmwareUpgrade(a.id)); } catch (e) { /* next open re-reads */ }
}

async function _loadFirmwareHistory(a) {
  var box = document.getElementById("asset-fw-history");
  if (!box) return;
  box.innerHTML = '<p class="hint" style="margin:0">Loading…</p>';
  try {
    var res = await api.assets.firmwareUpgradeRuns(a.id);
    var runs = (res && res.runs) || [];
    if (runs.length === 0) { box.innerHTML = '<p class="hint" style="margin:0">No upgrade runs for this device.</p>'; return; }
    var rows = runs.map(function (r) {
      var dur = (r.startedAt && r.finishedAt) ? Math.round((new Date(r.finishedAt) - new Date(r.startedAt)) / 1000) + " s" : "";
      var color = r.status === "succeeded" ? "var(--color-success)" : r.status === "failed" ? "var(--color-danger)" : r.status === "unverified" ? "var(--color-warning)" : "var(--color-text-secondary)";
      return '<tr>' +
        '<td title="' + escapeHtml(r.startedAt ? formatDateTime(r.startedAt) : "") + '">' + escapeHtml(r.startedAt ? timeAgo(r.startedAt) : "") + '</td>' +
        '<td>' + escapeHtml(r.fromVersion || "?") + ' → ' + escapeHtml(r.toVersion) + '</td>' +
        '<td><span style="color:' + color + '">' + escapeHtml(r.status) + '</span></td>' +
        '<td>' + escapeHtml(dur) + '</td>' +
        '<td style="text-align:right"><button type="button" class="btn btn-sm btn-secondary fw-history-view" data-id="' + escapeHtml(r.id) + '">View log</button></td>' +
      '</tr>';
    }).join("");
    box.innerHTML = '<table class="data-table" style="font-size:0.82rem"><thead><tr><th>Started</th><th>Version</th><th>Result</th><th>Duration</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>';
    box.querySelectorAll(".fw-history-view").forEach(function (b) {
      b.addEventListener("click", function () { _openFwRunLogModal(a.id, b.getAttribute("data-id")); });
    });
  } catch (err) {
    box.innerHTML = '<p class="hint" style="margin:0;color:var(--color-danger)">' + escapeHtml((err && err.message) || "Could not load run history") + '</p>';
  }
}

// The per-asset run read (assets:read), not the Repository's (firmware:read):
// a role that may flash a device need not hold the Repository key.
async function _openFwRunLogModal(assetId, runId) {
  try {
    var res = await api.assets.firmwareUpgradeRun(assetId, runId);
    var run = res.run;
    var lines = (run.log || []).map(function (l) { return "[" + l.t + "] " + (l.level || "info").toUpperCase() + " " + l.msg; }).join("\n");
    openModal("Firmware upgrade — " + run.toVersion,
      '<p style="margin-bottom:0.5rem"><strong>' + escapeHtml(run.status) + '</strong>' + (run.error ? ' — ' + escapeHtml(run.error) : '') + '</p>' +
      '<pre style="max-height:60vh;overflow:auto;font-size:0.76rem;white-space:pre-wrap">' + escapeHtml(lines || "(no log lines)") + '</pre>',
      '<button class="btn btn-secondary" onclick="closeModal()">Close</button>');
  } catch (err) {
    showToast((err && err.message) || "Could not load the run", "error");
  }
}

async function _openRebootRunLogModal(assetId, runId) {
  try {
    var res = await api.assets.rebootRun(assetId, runId);
    var run = res.run;
    var lines = (run.log || []).map(function (l) { return "[" + l.t + "] " + (l.level || "info").toUpperCase() + " " + l.msg; }).join("\n");
    openModal("Reboot — " + (run.authority || run.method || ""),
      '<p style="margin-bottom:0.5rem"><strong>' + escapeHtml(run.status) + '</strong>' + (run.error ? ' — ' + escapeHtml(run.error) : '') + '</p>' +
      (run.note ? '<p style="margin-bottom:0.5rem;font-size:0.85rem"><span style="color:var(--color-text-secondary)">Reason:</span> ' + escapeHtml(run.note) + '</p>' : '') +
      '<pre style="max-height:60vh;overflow:auto;font-size:0.76rem;white-space:pre-wrap">' + escapeHtml(lines || "(no log lines)") + '</pre>',
      '<button class="btn btn-secondary" onclick="closeModal()">Close</button>');
  } catch (err) {
    showToast((err && err.message) || "Could not load the run", "error");
  }
}

/**
 * A reboot or firmware item clicked on the operations calendar (Events →
 * Calendar, ops-calendar.js) opens THIS asset's own dialog for it: a booking
 * still pending opens the Reboot… / firmware dialog in change mode (move it,
 * change recipients, cancel), a run opens its log, and anything else — a
 * cancelled, missed or refused booking — leaves the operator on the System
 * tab, where the asset's reboot and firmware state is. `ob` is
 * {kind: "reboot"|"firmware", scheduleId, runId, status}.
 */
async function _openBookingFromCalendar(a, ob) {
  var sysTab = document.querySelector('#asset-view-tabs .page-tab[data-tab="system"]');
  if (sysTab) sysTab.click();
  // A group firmware upgrade (rule 122) is drawn on its FortiGate; it opens
  // the group's own progress, not one device's booking.
  if (ob.groupId) { _openFirmwareGroupDetail(ob.groupId); return; }
  var pending = ob.status === "pending" && ob.scheduleId;
  try {
    if (ob.kind === "reboot") {
      if (pending) {
        var rb = await api.assets.reboot(a.id);
        if (rb.schedule && rb.schedule.id === ob.scheduleId) {
          if (_canEditAsset(a)) _openRebootModal(a, rb, rb.schedule);
          return;
        }
        showToast("That reboot is no longer booked — it has started, been changed or been cancelled", "info");
        return;
      }
      if (ob.runId) _openRebootRunLogModal(a.id, ob.runId);
      return;
    }
    if (ob.kind === "firmware") {
      if (pending) {
        var fw = await api.assets.firmwareUpgrade(a.id);
        if (fw.schedule && fw.schedule.id === ob.scheduleId) {
          if (_canEditAsset(a)) _openFirmwareApprovalModal(a, fw, fw.schedule);
          return;
        }
        showToast("That upgrade is no longer booked — it has started, been changed or been cancelled", "info");
        return;
      }
      if (ob.runId) _openFwRunLogModal(a.id, ob.runId);
    }
  } catch (err) {
    showToast((err && err.message) || "Could not open the booking", "error");
  }
}

/**
 * The group detail lives in assets-firmware-group.js, which only the Assets
 * page loads; elsewhere (the asset panel opened from global search) load it
 * on demand.
 */
function _openFirmwareGroupDetail(groupId) {
  if (window.PolarisFirmwareGroup) { window.PolarisFirmwareGroup.openDetail(groupId); return; }
  var s = document.createElement("script");
  s.src = "/js/assets-firmware-group.js";
  s.onload = function () { if (window.PolarisFirmwareGroup) window.PolarisFirmwareGroup.openDetail(groupId); };
  document.head.appendChild(s);
}

function _wireFirmwarePanel(a, fw) {
  var primaryLink = document.querySelector("#asset-firmware-panel .fw-open-cluster-primary");
  if (primaryLink) primaryLink.addEventListener("click", function (e) {
    e.preventDefault();
    openViewModal(primaryLink.getAttribute("data-asset-id"));
  });
  var up = document.getElementById("btn-fw-upgrade");
  if (up) up.addEventListener("click", function () { _openFirmwareApprovalModal(a, fw); });
  var schEdit = document.getElementById("btn-fw-schedule-edit");
  if (schEdit && fw.schedule) schEdit.addEventListener("click", function () { _openFirmwareApprovalModal(a, fw, fw.schedule); });
  var schCancel = document.getElementById("btn-fw-schedule-cancel");
  if (schCancel && fw.schedule) schCancel.addEventListener("click", function () { _cancelFirmwareSchedule(a, fw.schedule); });
  var grp = document.getElementById("btn-fw-group-open");
  if (grp && fw.group) grp.addEventListener("click", function () { _openFirmwareGroupDetail(fw.group.id); });
  var hist = document.getElementById("btn-fw-history");
  if (hist) {
    hist.addEventListener("click", function () {
      var box = document.getElementById("asset-fw-history");
      if (!box) return;
      var open = box.style.display !== "none";
      box.style.display = open ? "none" : "";
      hist.textContent = open ? "Run history ▸" : "Run history ▾";
      if (!open && !box.__loaded) { box.__loaded = true; _loadFirmwareHistory(a); }
    });
  }
  // An HA secondary's card shows its PRIMARY's run (rule 129): poll it through
  // the asset that owns it, which is the only route that serves it.
  if (fw && fw.activeRun && fw.activeRun.id) _startFirmwarePoll(a, fw.activeRun.id, fw.activeRun.assetId);
}

function _rerenderFirmwarePanel(a, fw) {
  var mount = document.getElementById("asset-firmware-panel-mount");
  if (!mount) return;
  mount.innerHTML = assetFirmwarePanelHTML(a, fw);
  _wireFirmwarePanel(a, fw);
  _scheduleFirmwareRefresh(a, fw);
}

// While the card is on screen it re-reads its status every 10 minutes, so a
// device upgraded elsewhere (or one whose record caught up after a flash)
// stops offering a stale upgrade without a Refresh. One timer for the page:
// a re-render or another asset's card replaces it, and the tick stops when
// the card is gone or shows another asset. A hidden tab, a run poll that owns
// the card, or an unchanged answer just waits another interval rather than
// redrawing, so an expanded Run history stays open.
var FW_REFRESH_MS = 10 * 60 * 1000;
var _fwRefreshTimer = null;

function _scheduleFirmwareRefresh(a, fw) {
  if (_fwRefreshTimer) clearTimeout(_fwRefreshTimer);
  _fwRefreshTimer = null;
  if (!document.getElementById("asset-firmware-panel")) return;
  var sig = JSON.stringify(fw || null);
  _fwRefreshTimer = setTimeout(function () {
    _fwRefreshTimer = null;
    var panel = document.getElementById("asset-firmware-panel");
    if (!panel || panel.getAttribute("data-asset-id") !== a.id) return;
    if (document.hidden || _fwPollKey) { _scheduleFirmwareRefresh(a, fw); return; }
    api.assets.firmwareUpgrade(a.id).then(function (next) {
      var panel2 = document.getElementById("asset-firmware-panel");
      if (!panel2 || panel2.getAttribute("data-asset-id") !== a.id || _fwPollKey) return;
      if (JSON.stringify(next || null) === sig) { _scheduleFirmwareRefresh(a, next); return; }
      _rerenderFirmwarePanel(a, next);
    }).catch(function () { _scheduleFirmwareRefresh(a, fw); });
  }, FW_REFRESH_MS);
}

// One poll per (asset, run): the sentinel is the panel itself — the tick
// bails when it is gone or shows another asset, exactly like _startAgentPoll.
var _fwPollKey = null;

function _startFirmwarePoll(a, runId, runAssetId) {
  var key = a.id + ":" + runId;
  var runOwner = runAssetId || a.id;
  if (_fwPollKey === key) return;
  _fwPollKey = key;
  var tick = function () {
    var panel = document.getElementById("asset-firmware-panel");
    if (!panel || panel.getAttribute("data-asset-id") !== a.id || _fwPollKey !== key) { if (_fwPollKey === key) _fwPollKey = null; return; }
    api.assets.firmwareUpgradeRun(runOwner, runId).then(function (res) {
      var run = res && res.run;
      var panel2 = document.getElementById("asset-firmware-panel");
      if (!panel2 || panel2.getAttribute("data-asset-id") !== a.id || _fwPollKey !== key) { if (_fwPollKey === key) _fwPollKey = null; return; }
      if (run && (run.status === "queued" || run.status === "running")) {
        var box = document.getElementById("asset-fw-progress");
        if (box) box.outerHTML = _fwProgressHTML(run);
        setTimeout(tick, 3000);
        return;
      }
      _fwPollKey = null;
      // Terminal: re-read availability and redraw the whole card.
      api.assets.firmwareUpgrade(a.id).then(function (next) { _rerenderFirmwarePanel(a, next); }).catch(function () { /* next open re-reads */ });
    }).catch(function () {
      setTimeout(tick, 5000);
    });
  };
  setTimeout(tick, 3000);
}

function _openInstallAgentModal(a) {
  // OS pre-fill: best-effort from Asset.os. Treat empty / unknown as
  // Linux since that's the most common case operators install agents on;
  // they can flip the dropdown if wrong.
  var inferredOs = "linux";
  var osText = (a.os || "").toLowerCase();
  if (osText.indexOf("windows") >= 0)            inferredOs = "windows";
  else if (osText.indexOf("mac") >= 0 ||
           osText.indexOf("darwin") >= 0)         inferredOs = "darwin";

  // Load credentials + the install-method catalog so both pickers are
  // populated on open. Filter creds to ssh + winrm types — restapi/snmp
  // credentials aren't relevant here.
  Promise.all([_ensureCredentials(), _ensureAgentInstallScripts()]).then(function () {
    var sshOpts   = (_credentialCache.list || []).filter(function (c) { return c.type === "ssh"; });
    var winrmOpts = (_credentialCache.list || []).filter(function (c) { return c.type === "winrm"; });
    function credOptions(list) {
      if (list.length === 0) {
        return '<option value="">— No credentials of this type —</option>';
      }
      return '<option value="">— Select credential —</option>' +
        list.map(function (c) {
          return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>';
        }).join("");
    }

    var modalBody =
      '<p style="color:var(--color-text-secondary)">Polaris will SSH or WinRM into the host using the chosen credential, upload the agent binary, and register it as a system service. Status updates appear in the Agent panel while the install runs.</p>' +
      '<div class="form-group" style="margin-top:0.75rem">' +
        '<label for="agent-install-os">Operating system</label>' +
        '<select id="agent-install-os">' +
          '<option value="linux"' +   (inferredOs === "linux" ? " selected" : "") +   '>Linux</option>' +
          '<option value="darwin"' +  (inferredOs === "darwin" ? " selected" : "") +  '>macOS</option>' +
          '<option value="windows"' + (inferredOs === "windows" ? " selected" : "") + '>Windows</option>' +
        '</select>' +
        (a.os ? '' : '<p class="hint" style="color:var(--color-warning)">Asset OS is unknown — confirm the choice above before installing.</p>') +
      '</div>' +
      '<div class="form-group">' +
        '<label for="agent-install-arch">CPU architecture</label>' +
        '<select id="agent-install-arch">' +
          '<option value="amd64" selected>amd64 (x86_64)</option>' +
          '<option value="arm64">arm64</option>' +
        '</select>' +
        '<p class="hint">Pick arm64 only for actually-ARM hosts (Apple Silicon, Raspberry Pi, AWS Graviton, etc.). Most x86 servers and most older Windows hosts are amd64.</p>' +
      '</div>' +
      '<div class="form-group" id="agent-install-script-wrap">' +
        '<label for="agent-install-script">Install method</label>' +
        '<select id="agent-install-script">' + _agentScriptOptionsFor(inferredOs) + '</select>' +
        '<p class="hint" id="agent-install-script-hint"></p>' +
      '</div>' +
      // Privilege tier — Linux only (Windows agents run as LocalSystem; macOS
      // LaunchDaemons run as root). Shown/hidden by refreshCredRows.
      '<div class="form-group" id="agent-install-root-wrap">' +
        '<label style="display:flex;align-items:center;gap:0.5rem;font-weight:normal;cursor:pointer">' +
          '<input type="checkbox" id="agent-install-run-as-root"> Grant CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH (for Application Map connection mapping)' +
        '</label>' +
        '<p class="hint" style="color:var(--color-warning)">Leave unchecked to run the agent fully unprivileged (recommended). Checking this grants the agent the <strong>CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH</strong> capability pair it needs to attribute network connections to processes for the Application Map — without full root. Note: these capabilities also let the agent read any process’s memory and any file on the host (a credential-theft risk), so enable them only on hosts where you want the service/connection map.</p>' +
      '</div>' +
      _agentRebootOptInHTML("agent-install-allow-reboot", false) +
      '<div class="form-group" id="agent-install-transport-wrap" style="display:none">' +
        '<label>Transport</label>' +
        '<div style="display:flex;gap:1rem;align-items:center;padding:0.25rem 0">' +
          '<label style="display:flex;align-items:center;gap:0.35rem;font-weight:normal;cursor:pointer">' +
            '<input type="radio" name="agent-install-transport" value="ssh" checked> SSH' +
          '</label>' +
          '<label style="display:flex;align-items:center;gap:0.35rem;font-weight:normal;cursor:pointer">' +
            '<input type="radio" name="agent-install-transport" value="winrm"> WinRM' +
          '</label>' +
        '</div>' +
        '<p class="hint" id="agent-install-transport-hint">SSH requires OpenSSH Server enabled on the Windows host. The credential needs admin rights to register the polaris-agent Windows Service.</p>' +
      '</div>' +
      '<div class="form-group" id="agent-install-cred-ssh-wrap">' +
        '<label for="agent-install-cred-ssh">SSH credential</label>' +
        '<select id="agent-install-cred-ssh">' + credOptions(sshOpts) + '</select>' +
      '</div>' +
      '<div class="form-group" id="agent-install-cred-winrm-wrap">' +
        '<label for="agent-install-cred-winrm">WinRM credential</label>' +
        '<select id="agent-install-cred-winrm">' + credOptions(winrmOpts) + '</select>' +
        '<p class="hint">The credential needs admin rights on the target host (the installer creates a Windows Service and writes under <code>%ProgramFiles%\\Polaris\\Agent\\</code>).</p>' +
      '</div>';

    // Match the canonical modal pattern (polaris-ui-canon → Modal): build the
    // body + a footer string + use openModal directly, then bind the
    // primary button's onclick. showFormModal is the right helper-of-
    // last-resort for plain OK/Cancel forms, but we need to KEEP the
    // modal open on validation failure (no credential picked) without
    // dismissing it on every click, which showFormModal doesn't allow.
    var modalTitle = "Install Polaris Agent on " + (a.hostname || a.ipAddress || "this asset");
    var footerHTML =
      '<button class="btn btn-secondary" id="btn-agent-install-cancel">Cancel</button>' +
      '<button class="btn btn-primary"   id="btn-agent-install-go">Install</button>';
    openModal(modalTitle, modalBody, footerHTML);

    // Toggle credential row visibility based on OS + transport pickers.
    // On Windows, both transports are available and the radio group decides
    // which credential picker is active. On Linux/macOS the transport row is
    // hidden and SSH is the only choice.
    function selectedTransport() {
      var checked = document.querySelector('input[name="agent-install-transport"]:checked');
      return checked ? checked.value : "ssh";
    }
    // Keep the install-method picker + its description in sync with the OS.
    function refreshScriptRow() {
      var os = document.getElementById("agent-install-os").value;
      var sel  = document.getElementById("agent-install-script");
      var wrap = document.getElementById("agent-install-script-wrap");
      var hint = document.getElementById("agent-install-script-hint");
      var opts = _agentScriptOptionsFor(os);
      sel.innerHTML = opts;
      // Nothing to pick (single vetted variant per OS today, or catalog
      // failed to load) — hide the row and let the server apply the default.
      wrap.style.display = (opts === "") ? "none" : "block";
      var chosen = (_agentInstallScriptsCache.list || []).filter(function (s) { return s.id === sel.value; })[0];
      hint.textContent = chosen ? chosen.description : "";
    }
    document.getElementById("agent-install-script").addEventListener("change", refreshScriptRow);

    function refreshCredRows() {
      var os = document.getElementById("agent-install-os").value;
      var transportWrap = document.getElementById("agent-install-transport-wrap");
      var sshWrap   = document.getElementById("agent-install-cred-ssh-wrap");
      var winrmWrap = document.getElementById("agent-install-cred-winrm-wrap");
      var hint      = document.getElementById("agent-install-transport-hint");

      refreshScriptRow();

      // Root install is a Linux-only concept; hide it (and reset it) otherwise.
      var rootWrap = document.getElementById("agent-install-root-wrap");
      if (rootWrap) {
        rootWrap.style.display = (os === "linux") ? "block" : "none";
        if (os !== "linux") {
          var rootCb = document.getElementById("agent-install-run-as-root");
          if (rootCb) rootCb.checked = false;
        }
      }

      if (os === "windows") {
        transportWrap.style.display = "block";
        var t = selectedTransport();
        sshWrap.style.display   = (t === "ssh")   ? "block" : "none";
        winrmWrap.style.display = (t === "winrm") ? "block" : "none";
        hint.textContent = (t === "ssh")
          ? "SSH requires OpenSSH Server enabled on the Windows host. The credential needs admin rights to register the polaris-agent Windows Service."
          : "WinRM must be enabled and reachable on port 5986 (HTTPS) or 5985 (HTTP).";
      } else {
        transportWrap.style.display = "none";
        sshWrap.style.display   = "block";
        winrmWrap.style.display = "none";
      }
    }
    document.getElementById("agent-install-os").addEventListener("change", refreshCredRows);
    Array.prototype.forEach.call(
      document.querySelectorAll('input[name="agent-install-transport"]'),
      function (el) { el.addEventListener("change", refreshCredRows); }
    );
    refreshCredRows();

    document.getElementById("btn-agent-install-cancel").onclick = closeModal;
    document.getElementById("btn-agent-install-go").onclick = async function () {
      var osSel     = document.getElementById("agent-install-os");
      var archSel   = document.getElementById("agent-install-arch");
      var scriptSel = document.getElementById("agent-install-script");
      var rootCb    = document.getElementById("agent-install-run-as-root");
      var sshSel    = document.getElementById("agent-install-cred-ssh");
      var winrmSel  = document.getElementById("agent-install-cred-winrm");
      var os = osSel.value;
      var transport = (os === "windows") ? selectedTransport() : "ssh";
      var credentialId = (transport === "winrm") ? winrmSel.value : sshSel.value;
      if (!credentialId) {
        showToast("Pick a credential first", "error");
        return; // keep modal open
      }
      var wantPtrace = os === "linux" && !!(rootCb && rootCb.checked);
      // Granting the ptrace-tier capability pair is a meaningful privilege —
      // make the operator confirm.
      if (wantPtrace) {
        var ok = await showConfirm(
          "Grant the Polaris Agent CAP_SYS_PTRACE + CAP_DAC_READ_SEARCH on this host?\n\n" +
          "This capability pair lets the agent attribute network connections to processes " +
          "for the Application Map — without full root. Note that it also lets the " +
          "agent read any process's memory and any file on the host (a credential-theft risk).\n\n" +
          "Only do this on hosts where you want the service/connection map."
        );
        if (!ok) return; // keep modal open
      }
      var body = {
        credentialId: credentialId,
        osPlatform:   os,
        arch:         archSel.value,
        transport:    transport,
      };
      // Only send scriptId when the picker is visible + has a value (empty
      // catalog / hidden row → let the server apply the per-OS default).
      if (scriptSel && scriptSel.value) body.scriptId = scriptSel.value;
      if (wantPtrace) body.privilegeTier = "ptrace";
      var rebootCb = document.getElementById("agent-install-allow-reboot");
      if (rebootCb && rebootCb.checked) body.allowReboot = true;
      api.assets.installAgent(a.id, body).then(function (r) {
        showToast("Install started — watch progress on the System tab", "success");
        closeModal();
        // Auto-open the asset details modal on the System tab so the
        // operator sees the live install-progress strip without having
        // to navigate. openViewModal renders the Agent sub-panel as part
        // of its body, and the sub-panel's poll loop starts on its own
        // when installStatus is in a transient state. Works regardless
        // of entry point (asset list click, edit modal install button,
        // or the details-modal install button reopening on the same
        // panel — idempotent re-render in that case).
        openViewModal(a.id).then(function () {
          var sysBtn = document.querySelector('#asset-view-tabs [data-tab="system"]');
          if (sysBtn && !sysBtn.classList.contains("active")) sysBtn.click();
        }).catch(function () { /* openViewModal already surfaces its own errors */ });
      }).catch(function (err) {
        showToast("Install failed: " + err.message, "error");
      });
    };
  });
}

function _confirmUninstallAgent(a, force) {
  // showConfirm returns a Promise<boolean>; never use window.confirm
  // (per polaris-ui-canon → Modal canonical pattern).
  var prompt = force
    ? "Force-remove drops the local ManagedAgent row immediately without contacting the host. The agent's bearer has already been revoked, but the binary + service will remain on the host as an orphan — you'll need to clean those up manually. Continue?"
    : "Polaris will SSH into the host using the credential stored at install time, stop the agent, and remove the binary + service. The local row will be hard-deleted on success.";
  showConfirm(prompt).then(function (ok) {
    if (!ok) return;
    api.assets.deleteAgent(a.id, { force: !!force }).then(function () {
      showToast(force ? "Agent force-removed" : "Uninstall started", "success");
      api.assets.agent(a.id).then(function (agent) {
        _rerenderAgentSubpanel(a, agent);
      });
    }).catch(function (err) {
      showToast("Uninstall failed: " + err.message, "error");
    });
  });
}

// "Discover Now" — discovery scoped to this one asset. Replaced Poll Now in
// the Status row, and absorbed the old "Re-discover" button.
//
// Shown to operators with assets:write (the route's gate — a discovery mutates
// inventory, unlike the read-only probe Poll Now used to run). Enabled for the
// Fortinet family (a FortiGate scopes a run to itself; a FortiSwitch/FortiAP
// scopes one to its CONTROLLER gate, since a switch is only ever discovered as
// a by-product of its controller's pass) and for directory-discovered assets
// (Entra/Intune by deviceId, AD by objectGUID). vCenter and Arc assets render
// the button DISABLED with the reason in its title rather than hidden — an
// absent control reads as a permission problem, which is the wrong guess.
//
// The server re-resolves all of this (assetDiscoveryScope.ts) and is the
// authority; this function only decides what to render. In particular it does
// not try to prove a switch's controller is in Polaris — the route answers
// that with a clear 400.
// ─── Reboot (business rule 115) ──────────────────────────────────────────────
// The header's Reboot button, right of Discover Now. Rendered as an empty slot
// with the header (_assetHeaderVerbsHTML) and filled once GET /assets/:id/reboot answers, so the panel never waits on it
// (and the openViewModal fetch wave is untouched). The SERVER decides what may
// reboot the asset — a credential's or integration's Allow reboots, an agent
// host's opt-in — and says why not; the button only shows it. One dialog for
// now and later, like the firmware approval dialog it is modelled on.

/** States a booking can still be made from: the device cannot reboot NOW, but every gate is taken again when it fires. */
var _REBOOT_SCHEDULABLE = { available: true, blocked: true, "agent-offline": true };

function _assetRebootSlotHTML(a) {
  if (!a || typeof permAtLeast !== "function" || !permAtLeast("assets", "read")) return "";
  return '<span id="asset-reboot-wrap" data-asset-id="' + escapeHtml(a.id) + '" style="display:inline-flex;align-items:center;gap:6px"></span>';
}

/** The panel header's device verbs, right of the hostname: Discover Now, then Reboot. */
function _assetHeaderVerbsHTML(a) {
  return _assetDiscoverNowBtnHTML(a) + _assetRebootSlotHTML(a);
}

/** "fortinet" path or "agent" path, as one sentence for the dialog. Pure. */
function _rebootMethodText(rb) {
  switch (rb && rb.method) {
    case "controller-switch": return "Restarted through its FortiGate " + ((rb.via && rb.via.label) || "") + " (managed FortiSwitch restart)";
    case "controller-ap":     return "Restarted through its FortiGate " + ((rb.via && rb.via.label) || "") + " (managed FortiAP restart)";
    case "fortigate-rest":    return "The FortiGate's REST API";
    case "fortigate-ssh":     return "The FortiGate's SSH CLI";
    case "device-ssh":        return "The device's own SSH CLI";
    case "agent":             return "The Polaris Agent on the host";
    default:                  return "—";
  }
}

/** The header's reboot control for one availability answer. Pure, so the DOM test can render it. */
function _rebootControlHTML(a, rb) {
  // Rule 141 (e): rebooting is an assets:write verb on THIS device.
  if (!rb || rb.state === "unsupported") return "";
  var canAct = _canEditAsset(a);
  var run = rb.activeRun;
  var parts = [];
  if (run) {
    parts.push('<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-reboot" disabled title="' +
      escapeHtml("Reboot in progress (" + (run.stage || run.status) + ") — signed by " + (run.authority || "?")) + '">Rebooting…</button>');
  } else {
    var schedulable = !!_REBOOT_SCHEDULABLE[rb.state];
    var disabledWhy = !canAct ? "Rebooting needs Read-Write on Assets." : (!rb.available && !schedulable ? (rb.reason || "Not available") : "");
    var title = disabledWhy || (rb.available
      ? "Reboot this device now or schedule it — signed by " + (rb.authority || "?")
      : (rb.reason || "") + " It can still be scheduled.");
    parts.push('<button type="button" class="btn btn-sm btn-secondary" id="btn-asset-reboot"' + (disabledWhy ? " disabled" : "") +
      ' title="' + escapeHtml(title) + '">Reboot</button>');
  }
  if (rb.schedule) {
    parts.push('<button type="button" class="badge" id="btn-asset-reboot-scheduled" style="cursor:' + (canAct ? "pointer" : "default") +
      ';border:1px solid var(--color-border);background:transparent;color:var(--color-text-secondary)" title="' +
      escapeHtml("Emails to " + (rb.schedule.notifyEmails || []).join(", ") + " · booked by " + (rb.schedule.createdBy || "—") +
        (rb.schedule.note ? " · reason: " + rb.schedule.note : "") +
        (rb.schedule.error ? " · waiting: " + rb.schedule.error : "") + (canAct ? " — click to change or cancel" : "")) + '">' +
      'Reboot scheduled ' + escapeHtml(_fwWhenText(rb.schedule.scheduledFor)) + '</button>');
  }
  return parts.join("");
}

var _rebootPollKey = null;

async function _loadAssetRebootControl(a) {
  var wrap = document.getElementById("asset-reboot-wrap");
  if (!wrap || wrap.getAttribute("data-asset-id") !== a.id) return;
  var rb;
  try { rb = await api.assets.reboot(a.id); } catch (e) { return; }
  wrap = document.getElementById("asset-reboot-wrap");
  if (!wrap || wrap.getAttribute("data-asset-id") !== a.id) return;
  wrap.innerHTML = _rebootControlHTML(a, rb);
  var btn = document.getElementById("btn-asset-reboot");
  if (btn && !btn.disabled) btn.addEventListener("click", function () { _openRebootModal(a, rb, null); });
  var chip = document.getElementById("btn-asset-reboot-scheduled");
  if (chip && rb.schedule && _canEditAsset(a)) {
    chip.addEventListener("click", function () { _openRebootModal(a, rb, rb.schedule); });
  }
  if (rb.activeRun) _startRebootPoll(a, rb.activeRun.id);
}

/**
 * The time half of the dialog (the firmware booking's field, worded for a
 * reboot). Pure. Who hears about it is the "Email notifications" block
 * (`_rebootNotifyHTML`), shared with a reboot now.
 */
function _rebootScheduleFieldsHTML(existing, defaults, warn) {
  var when = existing ? new Date(existing.scheduledFor) : (function () { var d = new Date(Date.now() + 60 * 60000); d.setMinutes(0, 0, 0); return d; })();
  var min = _fwLocalInputValue(new Date(Date.now() + 2 * 60000));
  var zone = _fwBrowserZone();
  return (warn ? '<div class="hint" style="margin:0 0 0.6rem;color:var(--color-warning)">Right now: ' + escapeHtml(warn) + ' That is checked again when the reboot is due — if it still holds then, nothing is sent and the recipients are told why.</div>' : '') +
    '<div class="form-group">' +
      '<label for="rb-sched-when">Reboot at</label>' +
      '<input type="datetime-local" id="rb-sched-when" min="' + escapeHtml(min) + '" value="' + escapeHtml(_fwLocalInputValue(when)) + '">' +
      '<p class="hint" style="margin:0.25rem 0 0">Your time' + (zone ? ' (' + escapeHtml(zone) + ')' : '') + '. If Polaris is not running at that time and only gets to it more than 15 minutes late, the reboot is not sent.</p>' +
    '</div>';
}

var _RB_NOTIFY_HINT_NOW = "Emailed when the reboot is sent and when the device is back — or did not come back. Roles, regions and the device’s own recipients are worked out when each email is sent.";
var _RB_NOTIFY_HINT_SCHEDULED = "Emailed when it is scheduled, when it starts and when it finishes — succeeded or failed — or if it cannot be started. A scheduled reboot always emails someone. Roles, regions and the device’s own recipients are worked out when each email is sent.";

/** The reboot dialog's notify editor — the firmware dialog's, prefixed "rb" (see `_fwNotifyEditor`). */
function _rebootNotifyEditor(defaults, existing) {
  if (!window.PolarisRecipientPicker || !PolarisRecipientPicker.notifyEditor) return null;
  return PolarisRecipientPicker.notifyEditor({
    prefix: "rb",
    defaults: defaults || {},
    spec: existing ? PolarisRecipientPicker.bookingNotifySpec(existing) : null,
    withBook: !!(window.PolarisAddressBook && typeof permAtLeast === "function" && permAtLeast("contacts", "read")),
  });
}

/**
 * "Email notifications" for a reboot: off by default for a reboot now (emails
 * when it is sent and when it ends); ticked and locked while "Schedule for
 * later" is, and when changing a booking, because a booking always emails
 * someone. Pure.
 */
function _rebootNotifyHTML(defaults, locked, existing) {
  var ed = _rebootNotifyEditor(defaults, existing);
  return '<div style="margin-top:0.75rem">' +
      '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:' + (locked ? "default" : "pointer") + '">' +
        '<input type="checkbox" id="rb-notify"' + (locked ? " checked disabled" : "") + '> Email notifications' +
      '</label>' +
      '<div id="rb-notify-fields" style="margin-top:0.6rem' + (locked ? '' : ';display:none') + '">' +
        (ed ? ed.html() : '') +
        '<p class="hint" id="rb-notify-hint" style="margin:0.35rem 0 0">' + escapeHtml(locked ? _RB_NOTIFY_HINT_SCHEDULED : _RB_NOTIFY_HINT_NOW) + '</p>' +
      '</div>' +
    '</div>';
}

/**
 * Why the device is being rebooted (business rule 115(d)). Required while the
 * install's rebootConfig.requireNote is on — `rb.noteRequired`, read from
 * GET /assets/:id/reboot so an assets:write user sees it without Server
 * Settings access; the server refuses a blank one either way. Pure.
 */
function _rebootNoteFieldHTML(rb, value) {
  var required = !!(rb && rb.noteRequired);
  return '<div class="form-group" style="margin:0.75rem 0 0">' +
      '<label for="rb-note">Reason' + (required ? ' <span style="color:var(--color-danger)">*</span>' : ' <span style="color:var(--color-text-tertiary);font-weight:normal">(optional)</span>') + '</label>' +
      '<input type="text" id="rb-note" maxlength="500" placeholder="Why is this device being rebooted?" value="' + escapeHtml(value || "") + '">' +
      '<p class="hint" style="margin:0.25rem 0 0">Recorded on the device’s Events and, for a scheduled reboot, in its results email.' + (required ? ' This install requires a reason for every reboot.' : '') + '</p>' +
    '</div>';
}

/**
 * The reboot dialog's body. Pure. `opts.mode`:
 *   "choose"        — reboot now, or tick the box to schedule.
 *   "schedule-only" — the device cannot reboot right now (blocked / agent offline); the box is ticked and locked.
 *   "change"        — editing a pending booking: the schedule fields only.
 */
function _rebootModalHTML(a, rb, opts) {
  opts = opts || {};
  var mode = opts.mode || "choose";
  var existing = opts.existing || null;
  var t = a.assetType;
  var warning = rb.kind === "agent"
    ? "The host restarts: every service on it stops and anyone signed in loses unsaved work" + (/windows/i.test(a.os || "") ? " (open applications are closed without asking)" : "") + ". It is unreachable until it boots."
    : t === "firewall"
      ? "The FortiGate restarts and is unreachable for several minutes — every network, tunnel, VPN user and device behind it goes down with it."
      : t === "switch"
        ? "The FortiSwitch restarts — every port on it, and everything connected through it, drops for a few minutes."
        : "The FortiAP restarts — its wireless clients disconnect for a few minutes.";
  var last = rb.lastRun
    ? '<dt>Last reboot</dt><dd>' + escapeHtml(rb.lastRun.status) + ' · ' + escapeHtml(timeAgo(rb.lastRun.startedAt)) + ' by ' + escapeHtml(rb.lastRun.startedBy) +
        (rb.lastRun.note ? ' — ' + escapeHtml(rb.lastRun.note) : '') + '</dd>'
    : '';
  var device =
    '<div class="fw-approve-block"><strong>Device</strong><dl>' +
      '<dt>Host</dt><dd>' + escapeHtml(a.hostname || "—") + (a.ipAddress ? ' (' + escapeHtml(a.ipAddress) + ')' : '') + '</dd>' +
      (a.serialNumber ? '<dt>Serial</dt><dd>' + escapeHtml(a.serialNumber) + '</dd>' : '') +
      '<dt>Sent by</dt><dd>' + escapeHtml(_rebootMethodText(rb)) + '</dd>' +
      '<dt>Signed by</dt><dd>' + escapeHtml(rb.authority || "—") + '</dd>' +
      last +
    '</dl></div>';
  if (mode === "change") {
    return device + _rebootNoteFieldHTML(rb, existing && existing.note) +
      '<div id="rb-sched-fields" style="margin-top:0.9rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' + _rebootScheduleFieldsHTML(existing, opts.defaults, null) + '</div>' +
      _rebootNotifyHTML(opts.defaults, true, existing);
  }
  var warnBox =
    '<div class="alert alert-warning" style="padding:0.6rem 0.75rem;border-radius:6px;background:rgba(214,137,16,0.12);border:1px solid var(--color-warning,#d68910);font-size:0.82rem;margin:0.5rem 0 0.75rem">' +
      escapeHtml(warning) + ' Polaris holds its alerts for this device while it reboots and records the reboot on the device’s Events.' +
    '</div>' +
    '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:pointer">' +
      '<input type="checkbox" id="rb-ack"> I understand this device will go down' +
    '</label>';
  var schedulePart;
  if (rb.schedule) {
    schedulePart = '<p class="hint" style="margin:0.75rem 0 0">A reboot is already scheduled for ' + escapeHtml(_fwWhenText(rb.schedule.scheduledFor)) + ' — change or cancel it from the chip beside the button.</p>' +
      _rebootNotifyHTML(opts.defaults, false);
  } else {
    var locked = mode === "schedule-only";
    schedulePart =
      '<div style="margin-top:0.9rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
        '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:' + (locked ? "default" : "pointer") + '">' +
          '<input type="checkbox" id="rb-schedule"' + (locked ? " checked disabled" : "") + '> Schedule for later' +
        '</label>' +
        '<div id="rb-sched-fields" style="margin-top:0.6rem' + (locked ? '' : ';display:none') + '">' + _rebootScheduleFieldsHTML(null, opts.defaults, locked ? rb.reason : null) + '</div>' +
        _rebootNotifyHTML(opts.defaults, locked) +
      '</div>';
  }
  return device + warnBox + _rebootNoteFieldHTML(rb, "") + schedulePart;
}

async function _openRebootModal(a, rb, existing) {
  var mode = existing ? "change" : (rb.available ? "choose" : "schedule-only");
  // What the notify editor opens with — the operator's last reboot recipients
  // (else themselves) and the picker's catalogue, incl. the email channels.
  var defaults = null;
  try { defaults = await api.assets.rebootScheduleDefaults(a.id); } catch (e) { defaults = null; }
  var name = a.hostname || a.ipAddress || "device";
  var title = existing ? "Change scheduled reboot — " + name : "Reboot — " + name;
  var footer =
    (existing ? '<button class="btn btn-danger" id="btn-rb-cancel-booking" style="margin-right:auto">Cancel scheduled reboot</button>' : '') +
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>' +
    '<button class="btn btn-primary" id="btn-rb-go" disabled></button>';
  openModal(title, _rebootModalHTML(a, rb, { mode: mode, existing: existing, defaults: defaults }), footer);

  var ack = document.getElementById("rb-ack");
  var later = document.getElementById("rb-schedule");
  var fields = document.getElementById("rb-sched-fields");
  var whenEl = document.getElementById("rb-sched-when");
  var noteEl = document.getElementById("rb-note");
  var btn = document.getElementById("btn-rb-go");
  var notify = document.getElementById("rb-notify");
  var notifyFields = document.getElementById("rb-notify-fields");
  var notifyHint = document.getElementById("rb-notify-hint");
  var editor = _rebootNotifyEditor(defaults, existing);
  if (editor && notifyFields) editor.wire(notifyFields, function () { sync(); });
  function scheduling() { return mode === "change" || !!(later && later.checked); }
  // A booking always emails someone: scheduling ticks and locks the box, and
  // unticking "Schedule for later" puts back the operator's own choice.
  var notifyChoice = notify ? notify.checked : false;
  if (notify) notify.addEventListener("change", function () { notifyChoice = notify.checked; });
  function emailing() { return scheduling() || !!(notify && notify.checked); }
  function noteValue() { return noteEl ? noteEl.value.trim() : ""; }
  function sync() {
    if (fields && later) fields.style.display = later.checked ? "" : "none";
    if (notify && mode !== "schedule-only") {
      notify.disabled = scheduling();
      notify.checked = scheduling() || notifyChoice;
    }
    if (notifyFields) notifyFields.style.display = emailing() ? "" : "none";
    if (notifyHint && notify) notifyHint.textContent = scheduling() ? _RB_NOTIFY_HINT_SCHEDULED : _RB_NOTIFY_HINT_NOW;
    var acked = (mode === "change" || !!(ack && ack.checked)) && (!rb.noteRequired || noteValue() !== "");
    var emailsOk = !emailing() || !!(editor && notifyFields && editor.ready(notifyFields));
    if (scheduling()) {
      btn.textContent = existing ? "Save changes" : "Schedule reboot";
      btn.disabled = !(acked && whenEl && whenEl.value && emailsOk);
    } else {
      btn.textContent = "Reboot now";
      btn.disabled = !acked || !rb.available || !emailsOk;
    }
  }
  [ack, later, notify].forEach(function (el) { if (el) el.addEventListener("change", sync); });
  [whenEl, noteEl].forEach(function (el) { if (el) el.addEventListener("input", sync); });

  var cancelBooking = document.getElementById("btn-rb-cancel-booking");
  if (cancelBooking) {
    cancelBooking.addEventListener("click", async function () {
      var ok = await showConfirm("Cancel the reboot scheduled for " + _fwWhenText(existing.scheduledFor) + "?\nNothing is sent to the device and no email goes out.");
      if (!ok) return;
      try {
        await api.assets.cancelRebootSchedule(a.id, existing.id);
        closeModal();
        showToast("Scheduled reboot cancelled", "success");
      } catch (err) {
        showToast((err && err.message) || "Could not cancel the scheduled reboot", "error");
      }
      _loadAssetRebootControl(a);
    });
  }

  btn.addEventListener("click", function () {
    var call, done;
    if (scheduling()) {
      var when = new Date(whenEl.value); // datetime-local parses as the browser's local time
      if (isNaN(when.getTime())) { showToast("Pick a date and time", "error"); return; }
      var body = { scheduledFor: when.toISOString(), notify: editor.read(notifyFields), note: noteValue() || null };
      call = existing ? api.assets.updateRebootSchedule(a.id, existing.id, body) : api.assets.scheduleReboot(a.id, body);
      done = existing ? "Scheduled reboot changed" : "Reboot scheduled for " + formatDateTime(when);
    } else {
      var nowBody = noteValue() ? { note: noteValue() } : {};
      if (emailing() && editor) nowBody.notify = editor.read(notifyFields);
      call = api.assets.startReboot(a.id, nowBody);
      done = "Reboot sent — Polaris is watching for the device to come back" + (nowBody.notify ? "; notifications are on" : "");
    }
    btn.disabled = true;
    call.then(function () {
      closeModal();
      showToast(done, "success");
      _loadAssetRebootControl(a);
    }).catch(function (err) {
      btn.disabled = false;
      showToast((err && err.message) || (scheduling() ? "Could not save the schedule" : "Could not start the reboot"), "error");
    });
  });
  sync();
}

/** Watch a live reboot until it ends, then say how it went and redraw the control. One poll per (asset, run). */
function _startRebootPoll(a, runId) {
  var key = a.id + ":" + runId;
  if (_rebootPollKey === key) return;
  _rebootPollKey = key;
  var tick = function () {
    var wrap = document.getElementById("asset-reboot-wrap");
    if (!wrap || wrap.getAttribute("data-asset-id") !== a.id || _rebootPollKey !== key) { if (_rebootPollKey === key) _rebootPollKey = null; return; }
    api.assets.rebootRun(a.id, runId).then(function (res) {
      var run = res && res.run;
      if (_rebootPollKey !== key) return;
      if (run && (run.status === "queued" || run.status === "sending" || run.status === "rebooting")) {
        var b = document.getElementById("btn-asset-reboot");
        if (b) b.title = "Reboot in progress (" + (run.stage || run.status) + ") — signed by " + (run.authority || "?");
        setTimeout(tick, 5000);
        return;
      }
      _rebootPollKey = null;
      if (run) {
        var kind = run.status === "succeeded" ? "success" : run.status === "unverified" ? "warning" : "error";
        showToast("Reboot of " + (a.hostname || a.ipAddress || "the device") + " " + run.status + (run.error ? ": " + run.error : ""), kind);
      }
      _loadAssetRebootControl(a);
    }).catch(function () { setTimeout(tick, 10000); });
  };
  setTimeout(tick, 3000);
}

/** The deploy dialogs' opt-in box (single + bulk). Pure. */
function _agentRebootOptInHTML(id, bulk) {
  return '<div class="form-group">' +
    '<label style="display:flex;align-items:center;gap:0.5rem;font-weight:normal;cursor:pointer">' +
      '<input type="checkbox" id="' + id + '"> Allow Polaris to reboot ' + (bulk ? 'these hosts' : 'this host') +
    '</label>' +
    '<p class="hint">Off by default. Turning it on lets the asset’s <strong>Reboot</strong> button (and a scheduled reboot) restart ' + (bulk ? 'each host' : 'the host') +
      ' through the agent. On Linux it installs a polkit rule that lets the unprivileged agent ask systemd-logind to reboot — nothing else about the agent’s privileges changes. It can be turned on or off later from the agent card.</p>' +
  '</div>';
}

/** The agent card's "Reboots" row + its Enable / Disable control. Pure. */
function _agentRebootRowHTML(agent) {
  var label, color = "";
  if (!agent.rebootEnabled) { label = "Disabled"; }
  else if (agent.rebootCapable === true) { label = "Enabled ✓"; color = "var(--color-success)"; }
  else if (agent.rebootCapable === false) { label = "Enabled — the host refuses (turn off and on again to repair)"; color = "var(--color-danger)"; }
  else { label = "Enabled — waiting for the agent to confirm"; color = "var(--color-warning)"; }
  var toggleable = agent.installStatus === "active" || agent.installStatus === "enrolling" || agent.installStatus === "upgrade_failed";
  var btn = (toggleable && typeof canDeployAgent === "function" && canDeployAgent())
    ? ' <button type="button" class="btn btn-sm btn-secondary" id="btn-agent-reboot-toggle" data-enable="' + (agent.rebootEnabled ? "0" : "1") + '" style="margin-left:0.4rem;padding:1px 8px">' +
        (agent.rebootEnabled ? "Disable" : "Enable…") + '</button>'
    : '';
  return '<div>Reboots: <strong' + (color ? ' style="color:' + color + '"' : '') + '>' + escapeHtml(label) + '</strong>' + btn + '</div>';
}

async function _toggleAgentReboot(a, agent, btn) {
  var enable = btn.getAttribute("data-enable") === "1";
  var ok = await showConfirm(enable
    ? "Allow Polaris to reboot this host?\n\nPolaris signs in with the agent's install credential and " +
      (agent.osPlatform === "linux" ? "installs a polkit rule letting the unprivileged agent ask systemd-logind to reboot, plus a root-owned marker file." : "writes a marker file the agent requires before it will reboot the host.") +
      " Anyone with Read-Write on Assets can then reboot it from the Reboot button."
    : "Stop Polaris from rebooting this host?\n\nPolaris stops sending reboots at once, and removes the host-side permission over the agent's install credential.");
  if (!ok) return;
  btn.disabled = true;
  btn.textContent = enable ? "Enabling…" : "Disabling…";
  try {
    var res = await api.assets.setAgentReboot(a.id, enable);
    if (res && res.hostError) showToast("Reboots disabled — but the host-side permission could not be removed: " + res.hostError, "warning");
    else showToast(enable ? "Reboots enabled — the agent confirms on its next heartbeat" : "Reboots disabled", "success");
  } catch (err) {
    showToast((err && err.message) || "Could not change reboots", "error");
  }
  openViewModal(a.id);
}
