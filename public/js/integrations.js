/**
 * public/js/integrations.js — Integrations management page.
 *
 * This is the CORE of the page: the shared polling-form readers, the
 * DOMContentLoaded boot, the integration list + Discover buttons, the
 * integration type registry (_INTEGRATION_PRODUCTS / _INTEGRATION_REQUIRED_FIELDS
 * / _NON_FORTINET_TABBED / _integrationTabs / _productForType), the Add / Edit
 * modal flows (_intgEditFormSpec, _testExistingIntegration, _saveIntegration)
 * and the Test / Discover / Delete / conflict verbs. The rest lives in plain
 * browser scripts split out of this file (CQ-F051), loaded right AFTER this
 * one, in this order, by every page that carries it (and app.js's asset panel
 * bundle):
 *   integrations-feature-tabs.js  DHCP Push, SD-WAN, Script Publishing,
 *                                 Directory, Quarantine Push, Description Sync
 *   integrations-monitoring.js    the Monitoring tab: class subtabs, auto-monitor
 *                                 cards, Geographic Location, monitor settings
 *                                 form + its wiring and readers
 *   integrations-forms.js         per-type General / Filters forms and
 *                                 get<Type>FormConfig readers, the AI Assistant
 *                                 (llm) model picker
 *   integrations-generic-api.js   the Generic API builder (business rule 100)
 *   integrations-query.js         the Query API consoles + saved-query presets
 * They share globals with no module system, so a top-level statement that
 * RUNS at load may only reference what an earlier script defined.
 * tests/unit/integrationsSplit.test.ts holds the pages, the order and the
 * function inventory; tests/unit/_integrationsSource.ts reads the split as one
 * source for tests that slice functions by name.
 */

// The polling-method vocabulary (labels, source compatibility, per-stream
// gates, the polling <select>, the MIB pickers) lives in
// public/js/polling-methods.js, loaded before this file on every page that
// carries it — and on mobile.html, whose asset Monitoring sheet draws the
// same dropdowns. Only the integration-form-specific reader stays here.

// Live read of the connection form. `f-useDirect` checked = bypass. A stored
// token renders as a placeholder with an empty value, so the placeholder counts
// as "a token exists".
function _fmgFortiosRestUnavailable(integrationType) {
  if (integrationType !== "fortimanager") return false;
  var directEl = document.getElementById("f-useDirect");
  if (directEl && directEl.checked) return false;
  var tokEl = document.getElementById("f-fortigateApiToken");
  if (!tokEl) return false;
  var typed = (tokEl.value || "").trim();
  var stored = (tokEl.getAttribute("placeholder") || "").trim();
  var hasStoredToken = stored && stored !== "Bearer token";
  return !typed && !hasStoredToken;
}

// Renders the four-stream polling block (response-time, telemetry, interfaces,
// lldp) for a given source kind. Used by the integration Monitoring tab, the
// class override editor, and the asset edit modal.
//
// opts.showCredRows — emit a per-stream credential sub-row (class override tier)
// opts.credentials  — array of {id,name,type} for the credential sub-row
// opts.credValues   — object with {responseTimeCredentialId, ...} current values
function _polarisPollingFourStreamHTML(idPrefix, source, current, opts) {
  current = current || {};
  opts    = opts    || {};
  var showCredRows = !!opts.showCredRows;
  var credentials  = opts.credentials || [];
  var credValues   = opts.credValues  || {};

  var streams = [
    { key: "responseTime",  label: "Response time",  pollField: "responseTimePolling",  credField: "responseTimeCredentialId",  mibField: "responseTimeMibId"  },
    { key: "telemetry",     label: "CPU/Memory",     pollField: "cpuMemoryPolling",     credField: "cpuMemoryCredentialId",     mibField: "cpuMemoryMibId"     },
    { key: "temperature",   label: "Hardware Sensors", pollField: "temperaturePolling",   credField: "temperatureCredentialId",   mibField: "temperatureMibId"  },
    { key: "interfaces",    label: "Interfaces",     pollField: "interfacesPolling",    credField: "interfacesCredentialId",    mibField: "interfacesMibId"    },
    { key: "storage",       label: "Storage",        pollField: "storagePolling",       credField: "storageCredentialId",       mibField: null,                  noMib: true },
    { key: "lldp",          label: "LLDP neighbors", pollField: "lldpPolling",          credField: "lldpCredentialId",          mibField: "lldpMibId"          },
  ];

  var rows = "";
  streams.forEach(function (s) {
    var pollIsSnmp = (current[s.pollField] === "snmp");

    // Optional per-stream credential sub-row (class override tier). Storage
    // has no dedicated per-stream credential column — the SNMP storage walk
    // reuses whichever credential the interfaces stream resolved (the same
    // session pulls hrStorageTable alongside ifTable), so skip the row.
    var credSubRow = "";
    if (showCredRows && !s.noMib) {
      var currentCredId = credValues[s.credField] || "";
      var credOpts = '<option value="">— Inherit (use integration credential) —</option>';
      credentials.forEach(function (c) {
        if (c.type !== "snmp") return;
        credOpts += '<option value="' + escapeHtml(c.id) + '"' + (currentCredId === c.id ? " selected" : "") + '>' + escapeHtml(c.name) + '</option>';
      });
      credSubRow = '<div id="' + idPrefix + s.key + '-cred-wrap" style="display:' + (pollIsSnmp ? "flex" : "none") + ';grid-column:2;align-items:center;gap:0.5rem;margin-top:0.25rem">' +
        '<label style="margin:0;font-size:0.85rem;color:var(--color-text-secondary)">Credential</label>' +
        '<select id="' + idPrefix + s.key + 'Cred" style="flex:1">' + credOpts + '</select>' +
      '</div>';
    }

    var labelHtml = '<label style="margin:0">' + escapeHtml(s.label) +
      (s.note ? '<div style="font-size:0.72rem;font-weight:normal;color:var(--color-text-tertiary);margin-top:2px">' + escapeHtml(s.note) + '</div>' : '') +
      '</label>';
    rows += labelHtml +
      _polarisPollingDropdownHTML(idPrefix + s.pollField, source, s.key, current[s.pollField]) +
      credSubRow;
  });

  return '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0.5rem 0 0.5rem 0">Polling Methods</p>' +
    '<div style="display:grid;grid-template-columns:200px 1fr;gap:0.5rem 1rem;align-items:center;margin-bottom:0.75rem">' +
      rows +
    '</div>';
}

function _polarisReadPollingFourStream(idPrefix) {
  return {
    responseTimePolling: _polarisReadPollingDropdown(idPrefix + "responseTimePolling"),
    cpuMemoryPolling:    _polarisReadPollingDropdown(idPrefix + "cpuMemoryPolling"),
    temperaturePolling:  _polarisReadPollingDropdown(idPrefix + "temperaturePolling"),
    interfacesPolling:   _polarisReadPollingDropdown(idPrefix + "interfacesPolling"),
    lldpPolling:         _polarisReadPollingDropdown(idPrefix + "lldpPolling"),
    storagePolling:      _polarisReadPollingDropdown(idPrefix + "storagePolling"),
    processesPolling:    _polarisReadPollingDropdown(idPrefix + "processesPolling"),
    eventLogPolling:     _polarisReadPollingDropdown(idPrefix + "eventLogPolling"),
  };
}

document.addEventListener("DOMContentLoaded", function () {
  // Guard: this file is also loaded on assets.html for its monitoring form
  // helpers; only run the integrations-page init when the list element exists.
  if (!document.getElementById("integrations-list")) return;
  loadIntegrations();
  document.getElementById("btn-add-integration").addEventListener("click", showTypePicker);

  // Tab switching: Integrations (default) ↔ Polaris Agents. Agents tab lazy-
  // mounts the agent-build card on first activation; the + Add Integration
  // button in the page header is hidden while the Agents tab is active so
  // it doesn't suggest the button applies to agents (the agent install flow
  // lives on each asset's details modal).
  var _agentsTabLoaded = false;
  var addBtn = document.getElementById("btn-add-integration");
  document.querySelectorAll("#integration-tabs .page-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      document.querySelectorAll("#integration-tabs .page-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".page-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      var panel = document.getElementById("tab-" + target);
      if (panel) panel.classList.add("active");
      if (addBtn) addBtn.style.display = (target === "integrations") ? "" : "none";
      if (target === "agents" && !_agentsTabLoaded) {
        _agentsTabLoaded = true;
        // Discovery rules card first (it sits above the agent card), then the
        // agent-build card — both render into their own static containers.
        if (window.PolarisDiscoveryRules && window.PolarisDiscoveryRules.init) {
          window.PolarisDiscoveryRules.init();
        }
        if (window.PolarisAgentBuild && window.PolarisAgentBuild.init) {
          window.PolarisAgentBuild.init();
        }
        // Windows SSH deployment card sits below the build card — build the
        // binary first, then prepare hosts to receive it. Hides itself when
        // the caller lacks serverSettingsSystem.
        if (window.PolarisAgentSshOnboarding && window.PolarisAgentSshOnboarding.init) {
          window.PolarisAgentSshOnboarding.init();
        }
      }
    });
  });
});

// Kick off the direct-transport sanity check after a successful FMG test and
// surface its result as its own toast. Intentionally fire-and-forget so the
// FMG success toast isn't delayed by the FortiGate probe, which can be slow
// if the randomly chosen gate is unreachable.
function _runFortigateSampleProbe(runner) {
  runner()
    .then(function (r) {
      showToast(r.message, r.ok ? "success" : "error");
      loadIntegrations();
    })
    .catch(function (err) {
      if (err && err.name === "AbortError") return;
      showToast("Random FortiGate test failed: " + (err && err.message ? err.message : "unknown error"), "error");
    });
}

// After a fresh integration of a subnet-producing type is created, warn the
// operator if no IP blocks are defined yet. Discovery skips every DHCP scope
// without a matching parent block (`syncDhcpSubnets` logs them as "no matching
// parent block"), so without a block the integration is effectively a no-op.
// Asset-only integrations (Entra/AD) don't need blocks — they're skipped here.
async function _warnIfNoBlocksForIntegrationType(integrationType, integrationName) {
  var producesSubnets =
    integrationType === "fortimanager" ||
    integrationType === "fortigate" ||
    integrationType === "windowsserver";
  if (!producesSubnets) return;
  var blocks;
  try {
    var resp = await api.blocks.list();
    blocks = Array.isArray(resp) ? resp : (resp && resp.blocks) || [];
  } catch (e) {
    return; // Best-effort; don't block the create flow on a list-blocks failure
  }
  if (blocks.length > 0) return;
  var name = escapeHtml(integrationName || "this integration");
  var body =
    '<p style="font-size:0.95rem;color:var(--color-text-primary);margin-bottom:0.75rem">' +
    'No IP blocks are defined yet.</p>' +
    '<p style="font-size:0.88rem;color:var(--color-text-secondary);line-height:1.5;margin-bottom:0.75rem">' +
    'When ' + name + ' runs discovery, every DHCP scope it finds needs a parent IP block to land in. ' +
    'Without at least one block, all discovered subnets will be skipped and no endpoint reservations will be tracked.' +
    '</p>' +
    '<p style="font-size:0.88rem;color:var(--color-text-secondary);line-height:1.5">' +
    'Add the IP space your organization owns under <strong>IP Blocks</strong> before running discovery.' +
    '</p>';
  var footer =
    '<button class="btn btn-secondary" id="noblocks-dismiss">Got it</button>' +
    '<button class="btn btn-primary" id="noblocks-go">Add IP Block</button>';
  openModal("IP Blocks Required", body, footer);
  var dismiss = document.getElementById("noblocks-dismiss");
  var go = document.getElementById("noblocks-go");
  if (dismiss) dismiss.onclick = function () { closeModal(); };
  if (go) go.onclick = function () { closeModal(); window.location.href = "/blocks.html"; };
}

// Toggle FMG integration form between proxy and direct modes.
// `useDirect=true` means bypass FMG and query each FortiGate directly;
// the on-disk integration field stays `useProxy` (true=proxy) — only the
// UI semantics are inverted.
//
// Toggles ONLY the direct-mode-only knob (parallelism). It used to show/hide
// the FortiGate credentials block too; those stay visible in both transports
// now, because a proxy-mode integration still needs them for any stream set to
// REST API.
//
// The "more than 10 FortiGates" figure in the parallelism hint is the SAME
// number as FMG_PROXY_GATE_ADVISORY_THRESHOLD in
// src/services/integrationHealthService.ts, which drives the sidebar advisory.
// Change both together — two numbers for one decision is worse than either.
function _fmgToggleDirectMode(useDirect) {
  var directBlock = document.getElementById("f-direct-mode-block");
  var parallelInput = document.getElementById("f-discoveryParallelism");
  if (directBlock) directBlock.style.display = useDirect ? "" : "none";
  // Force parallelism back to 1 when collapsing so getFormConfig
  // doesn't ship a stale direct-mode value with proxy mode.
  if (parallelInput && !useDirect) parallelInput.value = 1;
}

function _discoverBtnHTML(id, name, discovery, disabled) {
  if (discovery) {
    var isSlow = discovery.slow || (discovery.slowDevices && discovery.slowDevices.length > 0);
    var style = isSlow
      ? 'background:color-mix(in srgb, var(--color-warning) 12%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 35%, transparent);color:var(--color-warning)'
      : 'background:color-mix(in srgb, var(--color-accent) 10%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 25%, transparent);color:var(--color-accent)';
    // Scoped single-FortiGate re-discovery names the device so the card
    // makes clear this isn't a full sweep.
    var label = isSlow ? 'Discovering — slow'
      : (discovery.scopeDeviceName ? 'Discovering ' + escapeHtml(discovery.scopeDeviceName) + '…' : 'Discovering…');
    var title = isSlow ? ' title="This discovery is running longer than normal"' : '';
    // Aborting a running discovery/query is admin-only (integrations:fullwrite);
    // mirrors the server-side guard on DELETE /:id/discover so non-admins don't
    // see a button that would 403.
    var abortBtn = permAtLeast("integrations", "fullwrite")
      ? '<button class="query-abort-btn" style="margin-left:2px" onclick="abortIntegrationDiscovery(' + jsArg(id) + ',' + jsArg(name) + ')" title="Abort">&#x2715;</button>'
      : '';
    return '<span' + title + ' style="display:inline-flex;align-items:center;gap:6px;font-size:0.78rem;padding:0.3rem 0.6rem;border-radius:var(--radius-md);font-weight:500;' + style + '">' +
      '<span class="query-spinner"></span>' +
      '<span>' + label + '</span>' +
      abortBtn +
    '</span>';
  }
  return '<button class="btn btn-sm btn-primary" onclick="runDiscovery(' + jsArg(id) + ')"' +
    (disabled ? ' disabled title="Run a successful test first"' : '') + '>Discover</button>';
}

function _updateDiscoverButtons(discoveries) {
  discoveries = discoveries || [];
  document.querySelectorAll("[id^='discover-wrap-']").forEach(function (wrap) {
    var id = wrap.id.slice("discover-wrap-".length);
    var name = (wrap.closest(".integration-card") || document).querySelector("strong");
    name = name ? name.textContent : "";
    var disabled = wrap.getAttribute("data-disabled") === "1";
    var discovery = discoveries.find(function (d) { return d.id === id; }) || null;
    wrap.innerHTML = _discoverBtnHTML(id, name, discovery, disabled);
  });
}

async function loadIntegrations() {
  var container = document.getElementById("integrations-list");
  window._onDiscoveriesChanged = _updateDiscoverButtons;
  try {
    var result = await api.integrations.list();
    var integrations = result.integrations || result;
    if (integrations.length === 0) {
      container.innerHTML = '<div class="empty-state-card"><p>No integrations configured.</p><p style="color:var(--color-text-tertiary);font-size:0.85rem;margin-top:0.5rem">Add a FortiManager, FortiGate, Windows Server, Microsoft Entra ID, Active Directory, VMware vCenter, Azure Arc, Unraid, TrueNAS SCALE, or Proxmox VE connection — or a Generic API for anything else that lists devices — to get started — or an AI Assistant to turn on the AI assistant.</p></div>';
      return;
    }
    var activeDiscoveries = (window._getServerDiscoveries && window._getServerDiscoveries()) || [];
    container.innerHTML = integrations.map(function (intg) {
      var config = intg.config || {};
      var statusDot = intg.lastTestOk === true ? "dot-ok" : intg.lastTestOk === false ? "dot-fail" : "dot-unknown";
      var statusText = intg.lastTestOk === true ? "Connected" : intg.lastTestOk === false ? "Failed" : "Not tested";
      var typeBadge =
        intg.type === "windowsserver" ? "Windows Server" :
        intg.type === "fortigate" ? "FortiGate" :
        intg.type === "entraid" ? "Entra ID" :
        intg.type === "activedirectory" ? "Active Directory" :
        intg.type === "vcenter" ? "vCenter" :
        intg.type === "azurearc" ? "Azure Arc" :
        intg.type === "unraid" ? "Unraid" :
        intg.type === "truenas" ? "TrueNAS SCALE" :
        intg.type === "proxmox" ? "Proxmox VE" :
        intg.type === "genericapi" ? "Generic API" :
        intg.type === "llm" ? "AI Assistant" :
        "FortiManager";
      // The AI Assistant integration discovers nothing: no Discover button and no
      // auto-discovery rows on its card.
      var isLlm = intg.type === "llm";

      function filterRow(baseLabel, include, exclude) {
        include = include || []; exclude = exclude || [];
        var label = include.length > 0 ? baseLabel + ' Include' : baseLabel + ' Exclude';
        var list = include.length > 0 ? include : exclude;
        var value = list.length > 0 ? escapeHtml(list.join(", ")) : '<span style="color:var(--color-text-tertiary)">None</span>';
        return '<div class="detail-row"><span class="detail-label">' + label + '</span><span class="detail-value">' + value + '</span></div>';
      }
      var defaultPort =
        (intg.type === "unraid" || intg.type === "truenas") && config.useTls === false ? 80 :
        intg.type === "windowsserver" ? (config.useSsl === false ? 5985 : 5986) :
        intg.type === "activedirectory" ? (config.useLdaps === false ? 389 : 636) :
        intg.type === "proxmox" ? 8006 :
        443;

      var detailRows;
      if (isLlm) {
        var llmAzure = config.provider === "azure";
        var llmEndpoint = llmAzure ? _llmAzureEndpointText(config)
          : (config.useHttps ? "https" : "http") + "://" + (config.host || "-") + ":" + (config.port || 11434) + (config.basePath || "");
        detailRows =
          '<div class="detail-row"><span class="detail-label">Assistant Name</span><span class="detail-value">' + escapeHtml(config.displayName || "Assistant") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Provider</span><span class="detail-value">' + (llmAzure ? "Azure AI Foundry" + (config.azureApiShape === "anthropic" ? " (Claude)" : config.azureApiShape === "deployments" ? " (deployments API " + escapeHtml(config.azureApiVersion || "") + ")" : " (v1 API)") : "Local / OpenAI-compatible") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Endpoint</span><span class="detail-value mono">' + escapeHtml(llmEndpoint) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">' + (llmAzure ? "Deployment" : "Model") + '</span><span class="detail-value mono">' + (config.model ? escapeHtml(config.model) : '<span style="color:var(--color-text-tertiary)">Auto (the server\'s first tool-calling model)</span>') + '</span></div>' +
          (llmAzure && config.azureAuth === "entra"
            ? '<div class="detail-row"><span class="detail-label">Authentication</span><span class="detail-value">Entra ID app <span class="mono">' + escapeHtml(config.clientId || "") + '</span>' + (config.clientSecret ? "" : ' <span style="color:var(--color-warning)">(no secret)</span>') + '</span></div>'
            : '<div class="detail-row"><span class="detail-label">API Key</span><span class="detail-value">' + (config.apiToken ? "Set" : '<span style="color:var(--color-text-tertiary)">None</span>') + '</span></div>') +
          (config.useHttps ? '<div class="detail-row"><span class="detail-label">Verify TLS</span><span class="detail-value">' + (config.verifySsl !== false ? "Yes" : "No") + '</span></div>' : '') +
          '<div class="detail-row"><span class="detail-label">Tool Calling</span><span class="detail-value">' + _llmToolCheckHTML(config.toolCheck) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Lookups</span><span class="detail-value">Up to ' + (config.maxToolRounds || 6) + ' rounds, ' + (config.maxRowsPerTool || 200) + ' rows each · ' + Math.round((config.contextWindow || 8192) / 1024) + 'K-token window</span></div>' +
          '<div class="detail-row"><span class="detail-label">API Access Role</span><span class="detail-value">' + (config.roleName ? escapeHtml(config.roleName) + ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(read-only)</span>' : '<span style="color:var(--color-text-tertiary)">—</span>') + '</span></div>';
      } else if (intg.type === "activedirectory") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Protocol</span><span class="detail-value">' + (config.useLdaps === false ? "LDAP" : "LDAPS") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Bind DN</span><span class="detail-value mono">' + escapeHtml(config.bindDn || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Base DN</span><span class="detail-value mono">' + escapeHtml(config.baseDn || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Search Scope</span><span class="detail-value">' + escapeHtml(config.searchScope || "sub") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Verify TLS</span><span class="detail-value">' + (config.verifyTls ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Include Disabled</span><span class="detail-value">' + (config.includeDisabled === false ? "No (skipped)" : "Yes (as disabled)") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Decommission Missing</span><span class="detail-value">' + (config.decommissionMissing === true ? "Yes" : "No") + '</span></div>' +
          filterRow("OUs", config.ouInclude, config.ouExclude);
      } else if (intg.type === "entraid") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Tenant ID</span><span class="detail-value mono">' + escapeHtml(config.tenantId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Client ID</span><span class="detail-value mono">' + escapeHtml(config.clientId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Intune Sync</span><span class="detail-value">' + (config.enableIntune ? "Enabled" : "Disabled") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Include Disabled</span><span class="detail-value">' + (config.includeDisabled === false ? "No (skipped)" : "Yes (as disabled)") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Decommission Missing</span><span class="detail-value">' + (config.decommissionMissing === true ? "Yes" : "No") + '</span></div>' +
          filterRow("Devices", config.deviceInclude, config.deviceExclude);
      } else if (intg.type === "azurearc") {
        var arcSubs = config.subscriptionInclude || [];
        var arcExtraList = [];
        if (config.enableVmInstances) arcExtraList.push("VMware / SCVMM");
        if (config.enableSqlServer) arcExtraList.push("SQL Server");
        if (config.enableKubernetes) arcExtraList.push("Kubernetes");
        var arcExtras = arcExtraList.length > 0 ? arcExtraList.join(", ") : "None";
        var arcSubsValue = arcSubs.length > 0
          ? escapeHtml(String(arcSubs.length) + " subscription" + (arcSubs.length === 1 ? "" : "s"))
          : '<span style="color:var(--color-text-tertiary)">All visible to the app registration</span>';
        detailRows =
          '<div class="detail-row"><span class="detail-label">Tenant ID</span><span class="detail-value mono">' + escapeHtml(config.tenantId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Client ID</span><span class="detail-value mono">' + escapeHtml(config.clientId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Subscriptions</span><span class="detail-value">' + arcSubsValue + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Query Mode</span><span class="detail-value">' + (config.useResourceGraph === false ? "Per-subscription list" : "Resource Graph") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Include Disconnected</span><span class="detail-value">' + (config.includeDisconnected === false ? "No (skipped)" : "Yes") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Extra Resources</span><span class="detail-value">' + escapeHtml(arcExtras) + '</span></div>' +
          filterRow("Resource Groups", config.resourceGroupInclude, config.resourceGroupExclude) +
          filterRow("Machines", config.deviceInclude, config.deviceExclude) +
          filterRow("Tags", config.tagInclude, config.tagExclude) +
          '<div class="detail-row"><span class="detail-label">Import Azure Tags</span><span class="detail-value">' + (config.importAzureTags === true
            ? ((config.azureTagKeys || []).length > 0 ? escapeHtml((config.azureTagKeys || []).join(", ")) : "All keys")
            : "No") + '</span></div>';
      } else if (intg.type === "windowsserver") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Username</span><span class="detail-value">' + escapeHtml(config.username || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Domain</span><span class="detail-value">' + escapeHtml(config.domain || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Use SSL</span><span class="detail-value">' + (config.useSsl ? "Yes" : "No") + '</span></div>' +
          filterRow("DHCP", config.dhcpInclude, config.dhcpExclude);
      } else if (intg.type === "vcenter") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Username</span><span class="detail-value">' + escapeHtml(config.username || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Verify TLS</span><span class="detail-value">' + (config.verifyTls !== false ? "Yes" : "No") + '</span></div>' +
          filterRow("VMs", config.vmInclude, config.vmExclude);
      } else if (intg.type === "genericapi") {
        var gaAuthLabels = { none: "None", bearer: "Bearer token", header: "API key (header)", query: "API key (query string)", basic: "Basic", oauth2: "OAuth 2.0" };
        var gaPg = (config.pagination && config.pagination.mode) || "none";
        var gaIdLabels = { id: "Record ID", serialNumber: "Serial number", macAddress: "MAC address", hostname: "Hostname" };
        var gaEndpoint = (config.useHttps === false ? "http" : "https") + "://" + (config.host || "-") + (config.port ? ":" + config.port : "") + (config.path || "/");
        detailRows =
          '<div class="detail-row"><span class="detail-label">Endpoint</span><span class="detail-value mono">' + escapeHtml((config.method || "GET") + " " + gaEndpoint) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Authentication</span><span class="detail-value">' + escapeHtml(gaAuthLabels[config.authType || "none"] || config.authType) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Records Path</span><span class="detail-value mono">' + (config.recordsPath ? escapeHtml(config.recordsPath) : '<span style="color:var(--color-text-tertiary)">(response root)</span>') + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Pagination</span><span class="detail-value">' + escapeHtml(gaPg === "none" ? "None" : gaPg) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Identity</span><span class="detail-value">' + escapeHtml(gaIdLabels[config.identityField || "id"] || config.identityField) +
            ((config.fieldMap || {})[config.identityField || "id"] ? ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(config.fieldMap[config.identityField || "id"]) + ')</span>' : '') + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Decommission Missing</span><span class="detail-value">' + (config.decommissionMissing === true ? "Yes" : "No") + '</span></div>' +
          filterRow("Devices", config.deviceInclude, config.deviceExclude);
      } else if (intg.type === "unraid" || intg.type === "truenas") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Protocol</span><span class="detail-value">' + (config.useTls === false ? "HTTP (no TLS)" : "HTTPS") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Verify TLS</span><span class="detail-value">' + (config.useTls === false ? "—" : config.verifyTls !== false ? "Yes" : "No") + '</span></div>' +
          filterRow("VMs", config.vmInclude, config.vmExclude) +
          filterRow(intg.type === "truenas" ? "Apps" : "Containers", config.containerInclude, config.containerExclude);
      } else if (intg.type === "proxmox") {
        var pveFallbacks = config.fallbackHosts || [];
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Fallback Nodes</span><span class="detail-value mono">' + (pveFallbacks.length > 0 ? escapeHtml(pveFallbacks.join(", ")) : '<span style="color:var(--color-text-tertiary)">None</span>') + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API Token</span><span class="detail-value mono">' + escapeHtml(config.apiTokenId || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Verify TLS</span><span class="detail-value">' + (config.verifyTls !== false ? "Yes" : "No") + '</span></div>' +
          filterRow("VMs", config.vmInclude, config.vmExclude) +
          filterRow("Containers", config.containerInclude, config.containerExclude);
      } else if (intg.type === "fortigate") {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API User</span><span class="detail-value">' + escapeHtml(config.apiUser || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">VDOM</span><span class="detail-value">' + escapeHtml(config.vdom || "root") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">SSL Verify</span><span class="detail-value">' + (config.verifySsl ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Mgmt Interface</span><span class="detail-value mono">' + escapeHtml(config.mgmtInterface || "-") + '</span></div>' +
          filterRow("DHCP", config.dhcpInclude, config.dhcpExclude) +
          filterRow("Interface", config.interfaceInclude, config.interfaceExclude) +
          filterRow("Inventory", config.inventoryIncludeInterfaces, config.inventoryExcludeInterfaces);
      } else {
        detailRows =
          '<div class="detail-row"><span class="detail-label">Host</span><span class="detail-value mono">' + escapeHtml(config.host || "-") + ':' + (config.port || defaultPort) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">API User</span><span class="detail-value">' + escapeHtml(config.apiUser || "-") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">ADOM</span><span class="detail-value">' + escapeHtml(config.adom || "root") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">SSL Verify</span><span class="detail-value">' + (config.verifySsl ? "Yes" : "No") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">FMG Proxy</span><span class="detail-value">' + (config.useProxy === false ? "Disabled (direct)" : "Enabled") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Central Mgmt (APs)</span><span class="detail-value">' + _centralMgmtLabel(config.centralManagement, "wtp", "wtpCount", "AP") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Central Mgmt (Switches)</span><span class="detail-value">' + _centralMgmtLabel(config.centralManagement, "fsw", "fswCount", "switch") + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Mgmt Interface</span><span class="detail-value mono">' + escapeHtml(config.mgmtInterface || "-") + '</span></div>' +
          filterRow("FortiGates", config.deviceInclude, config.deviceExclude) +
          filterRow("DHCP", config.dhcpInclude, config.dhcpExclude) +
          filterRow("Inventory", config.inventoryIncludeInterfaces, config.inventoryExcludeInterfaces);
      }

      var nextDiscoveryText;
      if (!intg.enabled) {
        nextDiscoveryText = '<span style="color:var(--color-text-tertiary)">Integration disabled</span>';
      } else if (!intg.lastTestOk) {
        nextDiscoveryText = '<span style="color:var(--color-text-tertiary)">—</span>';
      } else if (intg.autoDiscover === false) {
        nextDiscoveryText = '<span style="color:var(--color-text-tertiary)">—</span>';
      } else {
        var intervalMs = (intg.pollInterval || 4) * 3600000;
        var nextRunMs = intg.lastDiscoveryAt ? new Date(intg.lastDiscoveryAt).getTime() + intervalMs : Date.now();
        nextDiscoveryText = escapeHtml(new Date(nextRunMs).toLocaleString(undefined, Object.assign({ month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }, timeZoneOpts())));
      }

      // "Avg Discovery Time" row — surfaces the rolling baseline from
      // discoveryDurationService so operators can size pollInterval against
      // observed run length. Hidden until enough samples have been collected
      // (matches the slow-detection MIN_SAMPLES floor on the backend).
      var avgRow = "";
      var bl = intg.discoveryBaseline;
      if (bl && bl.sampleCount >= 3 && bl.avgMs > 0) {
        var avgMs = bl.avgMs;
        var s = Math.floor(avgMs / 1000);
        var avgText;
        if (s < 60) avgText = s + "s";
        else if (s < 3600) avgText = Math.floor(s / 60) + "m " + ((s % 60) < 10 ? "0" : "") + (s % 60) + "s";
        else avgText = Math.floor(s / 3600) + "h " + (Math.floor(s / 60) % 60) + "m";
        var intervalMsForAvg = (intg.pollInterval || 4) * 3600000;
        var autoOn = intg.enabled && intg.lastTestOk && intg.autoDiscover !== false;
        var nearOverlap = autoOn && avgMs > intervalMsForAvg * 0.75;
        var valueStyle = nearOverlap ? ' style="color:var(--color-warning)"' : "";
        var tooltip = nearOverlap
          ? ' title="Average run time is approaching the auto-discovery interval. Consecutive runs may begin overlapping — consider lengthening the interval."'
          : "";
        avgRow = '<div class="detail-row"' + tooltip + '><span class="detail-label">Avg Discovery Time</span><span class="detail-value"' + valueStyle + '>' + escapeHtml(avgText) + ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(last ' + bl.sampleCount + ' run' + (bl.sampleCount === 1 ? '' : 's') + ')</span></span></div>';
      }

      var isFmgDirect = intg.type === "fortimanager" && config.useProxy === false;
      return '<div class="integration-card"' + (isFmgDirect ? ' data-fmg-direct="1"' : '') + '>' +
        '<div class="integration-card-header">' +
          '<div class="integration-card-header-top integration-card-header-top--centered">' +
            '<div class="integration-card-title">' +
              '<span class="integration-type-badge">' + typeBadge + '</span>' +
              '<strong>' + escapeHtml(intg.name) + '</strong>' +
              '<span class="integration-status ' + statusDot + '">' + statusText + '</span>' +
            '</div>' +
            '<div class="integration-card-enabled">' +
              (intg.enabled ? '<span class="badge badge-active">Enabled</span>' : '<span class="badge badge-deprecated">Disabled</span>') +
            '</div>' +
            (isLlm ? '' :
            '<div class="integration-card-discover" id="discover-wrap-' + intg.id + '" data-disabled="' + (intg.lastTestOk !== true ? '1' : '0') + '">' +
              _discoverBtnHTML(intg.id, intg.name, activeDiscoveries.find(function(d){ return d.id === intg.id; }) || null, intg.lastTestOk !== true) +
            '</div>') +
          '</div>' +
          '<div class="integration-card-actions">' +
            (intg.type === "fortimanager" ? '<button class="btn btn-sm btn-secondary" onclick="openApiQueryModal(' + jsArg(intg.id) + ', ' + jsArg(config.adom || 'root') + ', ' + (config.useProxy !== false ? 'true' : 'false') + ')">Query API</button>' : '') +
            (intg.type === "fortigate" ? '<button class="btn btn-sm btn-secondary" onclick="openFgtApiQueryModal(' + jsArg(intg.id) + ', ' + jsArg(config.vdom || 'root') + ')">Query API</button>' : '') +
            (intg.type === "entraid" ? '<button class="btn btn-sm btn-secondary" onclick="openEntraApiQueryModal(' + jsArg(intg.id) + ')">Query API</button>' : '') +
            (intg.type === "azurearc" ? '<button class="btn btn-sm btn-secondary" onclick="openArcApiQueryModal(' + jsArg(intg.id) + ')">Query API</button>' : '') +
            (intg.type === "activedirectory" ? '<button class="btn btn-sm btn-secondary" onclick="openAdApiQueryModal(' + jsArg(intg.id) + ')">Query API</button>' : '') +
            (intg.type === "vcenter" ? '<button class="btn btn-sm btn-secondary" onclick="openVcenterApiQueryModal(' + jsArg(intg.id) + ')">Query API</button>' : '') +
            (_isWorkloadType(intg.type) ? '<button class="btn btn-sm btn-secondary" onclick="openWorkloadApiQueryModal(' + jsArg(intg.id) + ', ' + jsArg(intg.type) + ')">Query API</button>' : '') +
            (isLlm && config.roleName && permAtLeast("apiTokens", "write") ? '<button class="btn btn-sm btn-secondary" onclick="regenerateLlmToken(' + jsArg(intg.id) + ', this)">Regenerate Token</button>' : '') +
            '<button class="btn btn-sm btn-secondary" onclick="testConnection(' + jsArg(intg.id) + ', this)">Test Connection</button>' +
            '<button class="btn btn-sm btn-secondary" onclick="openIntegrationEditModal(' + jsArg(intg.id) + ')">Edit</button>' +
            '<button class="btn btn-sm btn-danger" onclick="confirmDeleteIntegration(' + jsArg(intg.id) + ', ' + jsArg(intg.name) + ')">Delete</button>' +
          '</div>' +
        '</div>' +
        '<div class="integration-card-details">' +
          detailRows +
          (isLlm ? '' :
          '<div class="detail-row"><span class="detail-label">Auto-Discovery</span><span class="detail-value">' + (!intg.lastTestOk ? '<span style="color:var(--color-text-tertiary)">Disabled until a successful connection test</span>' : intg.autoDiscover === false ? '<span style="color:var(--color-text-tertiary)">Disabled</span>' : 'Every ' + (intg.pollInterval || 4) + ' hour' + ((intg.pollInterval || 4) === 1 ? '' : 's')) + '</span></div>' +
          '<div class="detail-row"><span class="detail-label">Next Auto-Discovery</span><span class="detail-value">' + nextDiscoveryText + '</span></div>' +
          avgRow) +
        '</div>' +
      '</div>';
    }).join("");
  } catch (err) {
    container.innerHTML = '<p class="empty-state">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

// The tab helpers (tabbedBodyHTML / wireModalTabs), the form-section parts
// (sectionHeading / formDivider / infoBox / checkboxRow) and calloutHTML are
// shared globals in app.js. This file used to carry a private copy of the tab
// pair, byte-identical to assets.js's — the two drifting apart is exactly what
// the shared pair exists to prevent. Field ids stay `f-...` across tabs so one
// read pass collects the whole form.

function showTypePicker() {
  var body =
    '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Select the type of integration to add:</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
      '<button class="btn btn-secondary" id="pick-fmg" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>FortiManager</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Multi-FortiGate via JSON-RPC</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-fgt" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>FortiGate</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Standalone FortiGate via REST</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-win" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>Windows Server</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">DHCP scopes via WinRM</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-entra" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>Microsoft Entra ID</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Devices via Microsoft Graph</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-ad" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>Active Directory</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">On-prem computer objects via LDAP</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-vc" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>VMware vCenter</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">VMs, ESXi hosts &amp; datastores via REST</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-arc" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>Azure Arc</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Arc-enabled servers via Azure Resource Manager</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-unraid" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>Unraid</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Host, VMs &amp; Docker containers via the Unraid API</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-truenas" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>TrueNAS SCALE</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Host, VMs &amp; Apps via the JSON-RPC API</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-proxmox" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>Proxmox VE</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Cluster nodes, VMs &amp; LXC containers via the REST API</span>' +
      '<button class="btn btn-secondary" id="pick-generic" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>Generic API</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Any REST API that lists devices as JSON</span>' +
      '</button>' +
      '<button class="btn btn-secondary" id="pick-llm" style="padding:1.2rem;font-size:0.95rem;display:flex;flex-direction:column;align-items:center;gap:6px;white-space:normal;text-align:center">' +
        '<strong>AI Assistant</strong>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">AI assistant via an OpenAI-compatible model server or Azure AI Foundry</span>' +
      '</button>' +
    '</div>';
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>';
  openModal("Add Integration", body, footer, { wide: true });
  document.getElementById("pick-fmg").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("fortimanager"); });
  document.getElementById("pick-fgt").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("fortigate"); });
  document.getElementById("pick-win").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("windowsserver"); });
  document.getElementById("pick-entra").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("entraid"); });
  document.getElementById("pick-ad").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("activedirectory"); });
  document.getElementById("pick-vc").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("vcenter"); });
  document.getElementById("pick-arc").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("azurearc"); });
  document.getElementById("pick-unraid").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("unraid"); });
  document.getElementById("pick-truenas").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("truenas"); });
  document.getElementById("pick-proxmox").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("proxmox"); });
  document.getElementById("pick-generic").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("genericapi"); });
  document.getElementById("pick-llm").addEventListener("click", function () { closeModal(); openIntegrationCreateModal("llm"); });
}

function _formHTMLForType(type, defaults) {
  if (type === "llm") return llmFormHTML(defaults);
  if (type === "genericapi") return genericApiGeneralHTML(defaults);
  if (type === "windowsserver") return windowsServerFormHTML(defaults);
  if (type === "fortigate") return fortiGateFormHTML(defaults);
  if (type === "entraid") return entraIdFormHTML(defaults);
  if (type === "activedirectory") return activeDirectoryFormHTML(defaults);
  if (type === "vcenter") return vcenterFormHTML(defaults);
  if (type === "azurearc") return azureArcFormHTML(defaults);
  if (type === "unraid" || type === "truenas") return workloadFormHTML(type, defaults);
  if (type === "proxmox") return proxmoxFormHTML(defaults);
  return fortiManagerFormHTML(defaults);
}

function _formConfigForType(type) {
  if (type === "llm") return getLlmFormConfig();
  if (type === "genericapi") return getGenericApiFormConfig();
  if (type === "windowsserver") return getWinFormConfig();
  if (type === "fortigate") return getFgtFormConfig();
  if (type === "entraid") return getEntraFormConfig();
  if (type === "activedirectory") return getAdFormConfig();
  if (type === "vcenter") return getVcenterFormConfig();
  if (type === "azurearc") return getArcFormConfig();
  if (type === "unraid" || type === "truenas") return getWorkloadFormConfig();
  if (type === "proxmox") return getProxmoxFormConfig();
  return getFormConfig();
}

// Reads the SNMP override picker (FMG/FortiGate Monitoring tab). Returns the
// chosen credential id, an empty string to explicitly clear it, or undefined
// when the picker isn't on screen — caller decides whether to merge.
function _readMonitorCredentialId() {
  var el = document.getElementById("f-mon-credential");
  if (!el) return undefined;
  return el.value || "";
}

// Reads the SSH override picker. Same semantics as _readMonitorCredentialId
// but for the parallel SSH credential row in integrationMonitorOverrideHTML.
function _readSshCredentialId() {
  var el = document.getElementById("f-mon-credential-ssh");
  if (!el) return undefined;
  return el.value || "";
}

// ─── The one shape, for all seven integration types ────────────────────────
//
// Product name, required-field list and tab set live HERE rather than being
// re-derived inside the Add and Edit flows. The two flows used to build two
// separate tab arrays, so a tab added to one silently missed the other (the
// old code carried a comment warning about exactly that), and the per-type
// required-field checks were copy-pasted chains that had already drifted
// apart. The modal shell itself is openIntegrationModal in app.js.

var _INTEGRATION_PRODUCTS = {
  fortimanager:    "FortiManager",
  fortigate:       "FortiGate",
  activedirectory: "Active Directory",
  entraid:         "Entra ID",
  windowsserver:   "Windows Server",
  vcenter:         "vCenter",
  azurearc:        "Azure Arc",
  unraid:          "Unraid",
  truenas:         "TrueNAS SCALE",
  proxmox:         "Proxmox VE",
  genericapi:      "Generic API",
  llm:             "AI Assistant",
};

/** The product an operator picked to get here. Unknown types fall back to the
 *  historical default so a new type can never render a blank title. */
function _productForType(type) {
  return _INTEGRATION_PRODUCTS[type] || "FortiManager";
}

// What a Test Connection request actually needs, as [fieldId, label] so the
// toast can NAME what is missing instead of firing a doomed request and
// reporting the server's error as if it were news.
//
// `secret: true` entries are dropped on the EDIT flow: a stored secret renders
// as a blank "leave blank to keep current" field there, and requiring it would
// block a legitimate test of an unchanged credential.
var _INTEGRATION_REQUIRED_FIELDS = {
  // Subscriptions are deliberately NOT required for Entra / Arc — empty means
  // "every subscription this app can see", which is a legitimate config and a
  // useful first test.
  entraid: [
    ["f-tenantId", "tenant ID"], ["f-clientId", "client ID"],
    ["f-clientSecret", "client secret", true],
  ],
  azurearc: [
    ["f-tenantId", "tenant ID"], ["f-clientId", "client ID"],
    ["f-clientSecret", "client secret", true],
  ],
  activedirectory: [
    ["f-host", "host"], ["f-bindDn", "bind DN"],
    ["f-bindPassword", "bind password", true], ["f-baseDn", "base DN"],
  ],
  windowsserver: [["f-host", "host"], ["f-username", "username"]],
  vcenter: [
    ["f-host", "host"], ["f-username", "username"],
    ["f-password", "password", true],
  ],
  fortimanager: [["f-host", "host"], ["f-apiToken", "API token", true]],
  fortigate:    [["f-host", "host"], ["f-apiToken", "API token", true]],
  unraid:       [["f-host", "host"], ["f-apiToken", "API key", true]],
  truenas:      [["f-host", "host"], ["f-apiToken", "API key", true]],
  proxmox:      [["f-host", "node address"], ["f-apiTokenId", "API token ID"], ["f-apiToken", "API token secret", true]],
  // The API key is optional (Ollama / LM Studio need none), and a blank Model
  // means the server's default pick, so only the host is required.
  llm:          [["f-host", "host"]],
  // The identity path is required too, but which input holds it depends on
  // the identity picker — the server names it if it is missing.
  genericapi:   [["f-host", "host"]],
};

function _integrationRequires(type, mode) {
  var all = _INTEGRATION_REQUIRED_FIELDS[type] || _INTEGRATION_REQUIRED_FIELDS.fortimanager;
  return all.filter(function (f) { return mode !== "edit" || !f[2]; })
    .map(function (f) { return [f[0], f[1]]; });
}

// The five non-Fortinet types that carry a Monitoring tab. A type in neither
// this list nor the Fortinet pair gets the flat, untabbed form.
var _NON_FORTINET_TABBED = ["activedirectory", "entraid", "windowsserver", "vcenter", "azurearc", "unraid", "truenas", "proxmox"];

/**
 * The tab set for one integration type, in order, for BOTH flows.
 *
 * ctx: {
 *   type, mode: "create"|"edit",
 *   id, name, pollInterval,       // null / "" / undefined on create
 *   config,                       // {} on create
 *   defaults,                     // the general/filters seed blob
 *   generalHtml,                  // non-Fortinet types supply their own
 *   monSettings, creds,
 * }
 *
 * Create is the same shape as Edit with an empty stored config, which is why
 * one builder serves both — every per-tab value below reads out of `config`
 * and degrades to the off/default state when it is empty.
 */
function _integrationTabs(ctx) {
  var type = ctx.type;
  var config = ctx.config || {};
  var defaults = ctx.defaults || {};
  var isFmg = type === "fortimanager";
  var isFgt = type === "fortigate";
  var isAd = type === "activedirectory";
  var isEntra = type === "entraid";
  var isVc = type === "vcenter";
  var isArc = type === "azurearc";

  if (isFmg || isFgt) {
    // `useProxy` is meaningful only for FMG. A standalone FortiGate is neither
    // proxy nor FMG's "bypass the proxy" direct mode — it has no FortiManager in
    // front of it at all — so the three push tabs take `type` as well and render
    // a FortiManager-free third copy for it. Passing `true` here rendered the
    // PROXY text plus a "Required FortiManager Admin Profile" section on an
    // install with no FortiManager, sending operators to grant Device Manager
    // Read-Write on a device that isn't there while the FortiOS access profile
    // that actually authorizes the write went unmentioned.
    var pushUseProxy = isFmg ? (config.useProxy !== false) : false;
    var fgCfg = config.fortigateMonitor || {};
    var tabs = [
      {
        key: "general", label: "General",
        html: isFmg ? fortiManagerGeneralHTML(defaults) : fortiGateGeneralHTML(defaults),
      },
      {
        key: "filters", label: "Filters",
        html: isFmg ? fortiManagerFiltersHTML(defaults) : fortiGateFiltersHTML(defaults),
      },
      {
        key: "monitoring", label: "Monitoring",
        html: monitorSettingsFormHTML(ctx.monSettings || {}, {
          snmpCredentials:      ctx.creds || [],
          monitorCredentialId:  config.monitorCredentialId || null,
          sshCredentialId:      config.sshCredentialId     || null,
          fortigateMonitor:     config.fortigateMonitor    || null,
          fortiswitchMonitor:   config.fortiswitchMonitor  || null,
          fortiapMonitor:       config.fortiapMonitor      || null,
          excludeFortilinkLldp: config.excludeFortilinkLldp === true,
          integrationId:        ctx.id || null,
          integrationType:      type,
          integrationName:      ctx.name || "",
          pollInterval:         ctx.pollInterval,
          // The relocated useDirect toggle + direct-mode credentials block
          // lives inside the FortiGate class subtab. Only `useProxy === false`
          // is read out of it, so the create flow's seed blob is equivalent to
          // the empty object it used to pass.
          fmgDefaults:          defaults,
        }),
      },
      {
        key: "push", label: "DHCP Push",
        html: reservationPushFormHTML(
          config.pushReservations === true, pushUseProxy,
          config.arpPresenceSweep === true, config.autoReserveFortinetInfra === true,
          config.adoptDiscoveredMac === true, type,
        ),
      },
      {
        key: "quarantine-push", label: "Quarantine Push",
        html: quarantinePushFormHTML(config.pushQuarantine === true, pushUseProxy, type),
      },
      {
        key: "description-sync", label: "Description Sync",
        html: descriptionSyncFormHTML(_descriptionSyncFlags(config), pushUseProxy, type),
      },
      { key: "sdwan", label: "SD‑WAN", html: sdwanFormHTML(config.pullSdwan === true, config.sdwanIntervalSeconds) },
      {
        // Carries the pull-from-SNMP and push-geocoded-coords toggles that used
        // to sit inside Monitoring → FortiGate. DOM ids preserved so the save
        // path (`_readFortigateMonitorBlock`) keeps finding them.
        key: "geographicLocation", label: "Geographic Location",
        html: geographicLocationFormHTML(
          fgCfg.pullSnmpLocation === true,
          fgCfg.useSnmpLocationCoords === true,
          fgCfg.pushGeocodedCoords === true,
          fgCfg.latitudeMetavar || "Latitude",
          fgCfg.longitudeMetavar || "Longitude",
          fgCfg.addressMetavar || "",
          type,
        ),
      },
    ];
    return tabs;
  }

  if (type === "genericapi") {
    var gaTabs = [
      { key: "general", label: "General", html: ctx.generalHtml },
      { key: "mapping", label: "Records & Mapping", html: genericApiMappingHTML(Object.assign({}, defaults, config)) },
      { key: "monitoring", label: "Monitoring", html: genericApiMonitoringHTML(Object.assign({}, defaults, config)) },
      { key: "network", label: "Network", html: genericApiNetworkHTML(Object.assign({}, defaults, config)) },
      { key: "preview", label: "Preview", html: genericApiPreviewHTML() },
    ];
    // The JSON tab needs genericapi-portability.js (loaded by integrations.html);
    // a page without it simply has no JSON tab.
    if (window.PolarisGenericApiPortability) gaTabs.push({ key: "json", label: "JSON", html: genericApiJsonHTML() });
    return gaTabs;
  }

  if (_NON_FORTINET_TABBED.indexOf(type) === -1) return null;   // flat form only

  // AD / Entra / Windows Server / vCenter / Azure Arc: the type's own flat form
  // becomes the General tab, with Monitoring alongside it and the feature tabs
  // after. Monitoring here is the same tab minus the Discovery Defaults section
  // (those concerns are Fortinet-only).
  var nonFortinet = [
    { key: "general", label: "General", html: ctx.generalHtml },
    {
      key: "monitoring", label: "Monitoring",
      html: monitorSettingsFormHTML(ctx.monSettings || {}, {
        integrationId:      ctx.id || null,
        integrationType:    type,
        integrationName:    ctx.name || "",
        pollInterval:       ctx.pollInterval,
        snmpCredentials:    ctx.creds || [],
        // Per-class blocks so the subtabs render their saved stream values.
        // Freshly seeded by the migration job; a pre-migration install sees an
        // empty object → overlay no-ops → the flat baseline shows through.
        workstationMonitor: config.workstationMonitor || null,
        serverMonitor:      config.serverMonitor      || null,
        vmMonitor:          config.vmMonitor          || null,
        hostMonitor:        config.hostMonitor        || null,
        k8sMonitor:         config.k8sMonitor         || null,
        containerMonitor:   config.containerMonitor   || null,
        verifyPresence:     config.verifyPresence,
      }),
    },
  ];
  // The address-book directory tab (live search + scheduled sync).
  if (isAd || isEntra) {
    nonFortinet.push({ key: "directory", label: "Directory", html: directoryFormHTML(type, config) });
  }
  // The SSH-onboarding script publishing opt-in — one per provider.
  if (isEntra) {
    nonFortinet.push({
      key: "scriptpub", label: "Script Publishing",
      html: scriptPublishingFormHTML(config.publishToIntune === true),
    });
  }
  if (isArc) {
    nonFortinet.push({
      key: "scriptpub", label: "Script Publishing",
      html: arcScriptPublishingFormHTML(config.allowRunCommand === true),
    });
  }
  return nonFortinet;
}

/** The per-type wiring both flows run after the modal is in the DOM. */
function _wireIntegrationModal(type, id) {
  if (type === "llm") { _wireLlmForm(id); return; }
  if (type === "genericapi") { _wireGenericApiForm(id); return; }
  var isFmgOrFgt = (type === "fortimanager" || type === "fortigate");
  if (isFmgOrFgt) {
    _wireMonitoringTabSubtabs(type);
    wireAutoMonitorCards(id || null);
    _wireProbeTimeoutWarning();
    _wireCredentialPickerVisibility();
    return;
  }
  if (_NON_FORTINET_TABBED.indexOf(type) === -1) return;   // flat form, nothing to wire
  _wireDirectorySyncToggle();
  _wireMonitoringTabSubtabs(type);
  if (type === "activedirectory" || type === "entraid" || type === "azurearc") {
    wireWorkstationServerCards(id || null);
  }
  if (type === "vcenter") wireVcenterCards(id || null);
  _wireProbeTimeoutWarning();
}


async function openIntegrationCreateModal(type) {
  type = type || "fortimanager";
  var isFmg = type === "fortimanager";
  var isFgt = type === "fortigate";
  var isAd  = type === "activedirectory";
  var isEntra = type === "entraid";
  var isWin = type === "windowsserver";
  var isVc = type === "vcenter";
  var isArc = type === "azurearc";
  var isWl = _isWorkloadType(type);
  var isFmgOrFgt = isFmg || isFgt;

  // Every type with a Monitoring tab seeds it from the MANUAL tier — the
  // closest equivalent to "fleet defaults" until the operator saves the new
  // integration's own tier, which happens right after create below.
  var monSettings = {};
  var creds = [];
  if (isFmgOrFgt || isAd || isEntra || isWin || isVc || isArc || isWl) {
    try { monSettings = (await api.monitorSettings.getManual()) || {}; }
    catch (e) { /* fall back to the form's own defaults */ }
  }
  // Credential pickers: the SNMP/SSH pickers on the Fortinet Monitoring tab,
  // and the agent auto-deploy SSH/WinRM pickers on the AD/Entra/vCenter/Arc
  // class cards.
  if (isFmgOrFgt || isVc || isArc || isAd || isEntra) {
    try { var credResp = await api.credentials.list(); creds = Array.isArray(credResp) ? credResp : []; }
    catch (e) { /* pickers just render their defaults */ }
  }

  // Seed TLS-verify ON for NEW integrations so the checkbox renders checked,
  // matching the verify-by-default backend schema (2026-06-03 review, M1). The
  // edit flow passes the stored config, so existing rows are unaffected.
  var createDefaults = isFmg ? { verifySsl: true, fortigateVerifySsl: true }
    : isFgt ? { verifySsl: true }
    : (isAd || isVc) ? { verifyTls: true }
    : type === "proxmox" ? { verifyTls: true }
    : isWl ? { verifyTls: true, useTls: true }
    : type === "genericapi" ? { useHttps: true, verifySsl: true } : {};

  // The Fortinet pair build their General tab from their own split
  // general/filters helpers, so this is only consulted by the other five —
  // and by the flat, untabbed fallback below.
  var generalHtml = isFmgOrFgt ? "" : _formHTMLForType(type, createDefaults);

  var tabs = _integrationTabs({
    type: type, mode: "create",
    id: null, name: "", pollInterval: undefined,
    config: {},                       // nothing stored yet — every tab renders its off/default state
    defaults: createDefaults,
    generalHtml: generalHtml,
    monSettings: monSettings,
    creds: creds,
  });

  // Tracks whether the pre-save Test Connection succeeded against the current
  // form data — inherited onto the new integration after Create so the Discover
  // button isn't gated on a redundant re-test. openIntegrationModal owns the
  // flag and hands it to onSave.
  openIntegrationModal({
    product: _productForType(type),
    action: "Add",
    prefix: "intg-edit",
    tabs: tabs,
    html: tabs ? null : generalHtml,
    requires: _integrationRequires(type, "create"),
    onWire: function () { _wireIntegrationModal(type, null); },
    onTest: function () { return _testNewIntegration(type); },
    onSave: function (ctx) { return _createIntegration(type, ctx.tested); },
  });
}

/** Test Connection for the Add flow. Throws to let the modal shell toast it. */
async function _testNewIntegration(type) {
  var result = await api.integrations.testNew({
    type: type,
    name: val("f-name") || "Test",
    config: _formConfigForType(type),
  });
  showToast(result.message, result.ok ? "success" : "error");
  if (type === "llm" && result.models) _renderLlmModelPicker(result.models, null);
  return result;
}

/** The Create button's work. `tested` says whether Test Connection passed on
 *  the current form, which lets a successful create inherit that result. */
async function _createIntegration(type, tested) {
  var isFmg = type === "fortimanager";
  var isFgt = type === "fortigate";
  var isAd  = type === "activedirectory";
  var isEntra = type === "entraid";
  var isWin = type === "windowsserver";
  var isVc = type === "vcenter";
  var isArc = type === "azurearc";
  var isWl = _isWorkloadType(type);
  var autoDiscoverEl = document.getElementById("f-autoDiscover");
  var createConfig = _formConfigForType(type);
  if (isWl) {
    // Reduced class blocks (addAsMonitored + streams). Host is the primary
    // subtab, so its streams carry the legacy primary ids.
    var wlHostNew = _readWorkstationServerMonitorBlock("f-mon-wlhost-", { klass: "wlhosts",    isPrimary: true });
    var wlVmNew   = _readWorkstationServerMonitorBlock("f-mon-wlvm-",   { klass: "wlvms",      isPrimary: false });
    var wlCtrNew  = _readWorkstationServerMonitorBlock("f-mon-ctr-",    { klass: "containers", isPrimary: false });
    if (wlHostNew) createConfig.hostMonitor      = wlHostNew;
    if (wlVmNew)   createConfig.vmMonitor        = wlVmNew;
    if (wlCtrNew)  createConfig.containerMonitor = wlCtrNew;
  }
  if (isFmg || isFgt) {
    var credId = _readMonitorCredentialId();
    if (credId) createConfig.monitorCredentialId = credId;
    var sshCredId = _readSshCredentialId();
    if (sshCredId) createConfig.sshCredentialId = sshCredId;
    // Per-stream polling methods are part of the integration tier
    // settings now (Cadence & Retention section); they're written to
    // Integration.config.monitorSettings.polling by the
    // /monitor-settings/integration/:id PUT after the integration is
    // created — no inline fields needed on create.
    var fgBlockNew = _readFortigateMonitorBlock("f-mon-fortigate-",   { klass: "fortigate",   isPrimary: true });
    var swBlockNew = _readClassMonitorBlock("f-mon-fortiswitch-",     { klass: "fortiswitch", isPrimary: false });
    var apBlockNew = _readClassMonitorBlock("f-mon-fortiap-",         { klass: "fortiap",     isPrimary: false, includeStorage: false });
    if (fgBlockNew) createConfig.fortigateMonitor   = fgBlockNew;
    if (swBlockNew) createConfig.fortiswitchMonitor = swBlockNew;
    if (apBlockNew) createConfig.fortiapMonitor     = apBlockNew;
  }
  if (isAd || isEntra || isWin || isArc) {
    // AD / Entra / Windows Server per-class blocks. Workstations is the
    // primary class subtab (legacy `f-mon-*` IDs); Servers is secondary
    // (namespaced `f-mon-classecho-servers-*`). _CLASS_SUBTAB_SPECS
    // uses plural class keys; backend Zod schema names them singularly.
    var wsBlockNew = _readWorkstationServerMonitorBlock("f-mon-workstation-", { klass: "workstations", isPrimary: true });
    var srvBlockNew = _readWorkstationServerMonitorBlock("f-mon-server-",     { klass: "servers",      isPrimary: false });
    if (wsBlockNew)  createConfig.workstationMonitor = wsBlockNew;
    if (srvBlockNew) createConfig.serverMonitor      = srvBlockNew;
    if (isArc) {
      // Reduced cluster block (addAsMonitored + streams only). Read with
      // the same reader vCenter's ESXi hosts use — Zod strips the extra
      // null fields the reduced schema doesn't carry.
      var k8sBlockNew = _readWorkstationServerMonitorBlock("f-mon-clusters-", { klass: "clusters", isPrimary: false });
      if (k8sBlockNew) createConfig.k8sMonitor = k8sBlockNew;
    }
    var verifyPresenceNew = _readVerifyPresenceToggle();
    if (verifyPresenceNew !== undefined) createConfig.verifyPresence = verifyPresenceNew;
    var dirSearchNew = _readDirectorySearchToggle();
    if (dirSearchNew !== undefined) createConfig.enableDirectorySearch = dirSearchNew;
    // The Directory tab is one control set: the sync toggle and its
    // exclusions are read together, so a saved filter can never belong to
    // a toggle that was not saved with it.
    var dirSyncNew = _readDirectorySyncConfig();
    if (dirSyncNew !== undefined) {
      createConfig.enableDirectorySync = dirSyncNew.enabled;
      createConfig.directorySync = dirSyncNew.filter;
    }
  }
  if (isVc) {
    // vCenter per-class blocks: VMs primary (full workstation-style
    // reader — the host block's extra null fields are stripped by Zod).
    var vmBlockNew   = _readWorkstationServerMonitorBlock("f-mon-vm-",   { klass: "vms",   isPrimary: true });
    var hostBlockNew = _readWorkstationServerMonitorBlock("f-mon-host-", { klass: "hosts", isPrimary: false });
    if (vmBlockNew)   createConfig.vmMonitor   = vmBlockNew;
    if (hostBlockNew) createConfig.hostMonitor = hostBlockNew;
    var vcVerifyPresenceNew = _readVerifyPresenceToggle();
    if (vcVerifyPresenceNew !== undefined) createConfig.verifyPresence = vcVerifyPresenceNew;
  }
  if (isFmg || isFgt) {
    var pushToggleNew = _readPushReservationsToggle();
    if (pushToggleNew !== undefined) createConfig.pushReservations = pushToggleNew;
    var arpSweepToggleNew = _readArpPresenceSweepToggle();
    if (arpSweepToggleNew !== undefined) createConfig.arpPresenceSweep = arpSweepToggleNew;
    var autoReserveInfraNew = _readAutoReserveInfraToggle();
    if (autoReserveInfraNew !== undefined) createConfig.autoReserveFortinetInfra = autoReserveInfraNew;
    var adoptMacNew = _readAdoptDiscoveredMacToggle();
    if (adoptMacNew !== undefined) createConfig.adoptDiscoveredMac = adoptMacNew;
    var quarantinePushToggleNew = _readPushQuarantineToggle();
    if (quarantinePushToggleNew !== undefined) createConfig.pushQuarantine = quarantinePushToggleNew;
    var syncDescriptionsNew = _readSyncDescriptionsToggles();
    if (syncDescriptionsNew !== undefined) Object.assign(createConfig, syncDescriptionsNew);
    var sdwanToggleNew = _readPullSdwanToggle();
    if (sdwanToggleNew !== undefined) createConfig.pullSdwan = sdwanToggleNew;
    var sdwanIntervalNew = _readSdwanInterval();
    if (sdwanIntervalNew !== undefined) createConfig.sdwanIntervalSeconds = sdwanIntervalNew;
    var excludeFortilinkLldpNew = _readExcludeFortilinkLldpToggle();
    if (excludeFortilinkLldpNew !== undefined) createConfig.excludeFortilinkLldp = excludeFortilinkLldpNew;
  }
  if (isEntra) {
    var publishToIntuneNew = _readPublishToIntuneToggle();
    if (publishToIntuneNew !== undefined) createConfig.publishToIntune = publishToIntuneNew;
  }
  if (isArc) {
    var allowRunCommandNew = _readAllowRunCommandToggle();
    if (allowRunCommandNew !== undefined) createConfig.allowRunCommand = allowRunCommandNew;
  }
  var input = {
    type: type,
    name: val("f-name"),
    config: createConfig,
    enabled: document.getElementById("f-enabled").checked,
    autoDiscover: autoDiscoverEl ? autoDiscoverEl.checked : true,
    pollInterval: parseInt(document.getElementById("f-pollInterval").value, 10) || 4,
  };
  var result = await api.integrations.create(input);
  // Save the new integration's tier-3 monitor settings if the Monitoring
  // tab was rendered. Failures here aren't fatal — the integration is
  // already created; operator can edit and resave.
  if ((isFmg || isFgt || isAd || isEntra || isWin || isVc || isArc || isWl) && result && result.id) {
    try { await api.monitorSettings.setIntegration(result.id, getMonitorSettingsFromForm()); }
    catch (e) { showToast("Integration created, but monitor settings couldn\'t be saved: " + (e.message || "unknown error"), "error"); }
  }
  if (type === "llm") await _saveLlmRetention();
  closeModal();
  showToast("Integration created");
  loadIntegrations();
  // If the user successfully tested the connection in the modal, inherit
  // that result onto the new integration so the Discover button is
  // immediately enabled instead of gated on a redundant re-test.
  if (tested && result && result.id) {
    api.integrations.test(result.id, input.name)
      .then(function () { loadIntegrations(); })
      .catch(function () { /* user can retry from the card */ });
  }
  if (result && result.llmAccess) {
    // The LLM server's API token exists only in this response (rule 95(f)).
    _showLlmAccessModal(result.llmAccess, input.name);
    _autoCheckLlmTools(result.id, input.name);
  } else if (result && result.conflicts && result.conflicts.length) {
    showConflictModal(result.id, result.conflicts);
  } else {
    // Conflict modal owns the screen when it renders, so skip the
    // no-blocks warning in that case — operators see it on the next
    // create or after the conflict modal closes.
    await _warnIfNoBlocksForIntegrationType(type, input.name);
  }
}

// Edit-modal orchestrator (split 2026-08): per-type form spec, tab assembly,
// then the test-connection and save phases — bodies extracted verbatim.
async function openIntegrationEditModal(id) {
  try {
    var intg = await api.integrations.get(id);
    var config = intg.config || {};
    var type = intg.type;
    var spec = _intgEditFormSpec(intg, config);
    var formGetter = spec.formGetter;

    // FMG + FortiGate get the full Monitoring tab (Cadence + Discovery
    // Defaults + Class Overrides). AD / Entra / WindowsServer / vCenter /
    // Azure Arc get the same tab minus the Discovery Defaults section (those
    // concerns are Fortinet-only). All tier-3 settings are per-integration —
    // this tab edits THIS integration's settings only; the manual tier and the
    // cross-source class overrides live on the Assets page's Monitoring
    // Settings modal.
    var monSettings = {};
    try {
      var resp = await api.monitorSettings.getIntegration(id);
      // The tier can be null on an integration whose tier-3 has never been
      // saved — the form then falls back to its own defaults.
      if (resp && resp.settings) monSettings = resp.settings;
    } catch (e) { /* fall back to the form's own defaults */ }

    var creds = [];
    try { var credResp = await api.credentials.list(); creds = Array.isArray(credResp) ? credResp : []; }
    catch (e) { /* pickers just render their defaults */ }

    var tabs = _integrationTabs({
      type: type, mode: "edit",
      id: id, name: intg.name, pollInterval: intg.pollInterval,
      config: config,
      defaults: spec.defaults,
      generalHtml: spec.body,
      monSettings: monSettings,
      creds: creds,
    });

    openIntegrationModal({
      product: _productForType(type),
      action: "Edit",
      prefix: "intg-edit",
      tabs: tabs,
      html: tabs ? null : spec.body,
      // Secrets are excluded on edit: a stored one renders blank ("leave blank
      // to keep current"), so requiring it would refuse to test a credential
      // the operator has no reason to retype.
      requires: _integrationRequires(type, "edit"),
      onWire: function () { _wireIntegrationModal(type, id); },
      onTest: function () { return _testExistingIntegration(id, intg); },
      onSave: function () { return _saveIntegration(id, intg, formGetter); },
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Per-type edit-form defaults + body HTML + the form-config getter that
// strips blank keep-current secrets before a PUT.
function _intgEditFormSpec(intg, config) {
    var isWin = intg.type === "windowsserver";
    var isFgt = intg.type === "fortigate";
    var isEntra = intg.type === "entraid";
    var isAd = intg.type === "activedirectory";
    var isVc = intg.type === "vcenter";
    var isArc = intg.type === "azurearc";
    var isWl = _isWorkloadType(intg.type);
    var body, formGetter;

    if (intg.type === "llm") {
      var defaults = {
        name: intg.name,
        displayName: config.displayName,
        host: config.host,
        port: config.port,
        basePath: config.basePath,
        useHttps: config.useHttps === true,
        verifySsl: config.verifySsl !== false,
        apiTokenPlaceholder: config.apiToken ? "Leave blank to keep the current key" : "Optional — only if the server requires one",
        model: config.model,
        allowLoopback: config.allowLoopback === true,
        provider: config.provider === "azure" ? "azure" : "openai",
        azureApiShape: config.azureApiShape,
        azureApiVersion: config.azureApiVersion,
        azureAuth: config.azureAuth,
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecretPlaceholder: config.clientSecret ? "Leave blank to keep the current secret" : "The app registration's client secret",
        azureScope: config.azureScope,
        omitTemperature: config.omitTemperature === true,
        acceptsImages: typeof config.acceptsImages === "boolean" ? config.acceptsImages : undefined,
        temperature: config.temperature,
        maxToolRounds: config.maxToolRounds,
        maxRowsPerTool: config.maxRowsPerTool,
        contextMessages: config.contextMessages,
        contextWindow: config.contextWindow,
        idleResetMinutes: config.idleResetMinutes,
        requestTimeoutMs: config.requestTimeoutMs,
        systemPromptExtra: config.systemPromptExtra,
        roleName: config.roleName,
        enabled: intg.enabled,
        pollInterval: intg.pollInterval,
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = llmFormHTML(defaults);
      formGetter = function () {
        var fc = getLlmFormConfig();
        if (!fc.apiToken) delete fc.apiToken;
        if (!fc.clientSecret) delete fc.clientSecret;
        return fc;
      };
      return { body: body, formGetter: formGetter, defaults: defaults };
    }

    if (intg.type === "genericapi") {
      // Every stored key rides into the defaults (the mapping tab reads the
      // same blob via _integrationTabs), secrets as "is one stored" flags.
      var gaDefaults = Object.assign({}, config, {
        name: intg.name,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        hasApiToken: !!config.apiToken,
        hasPassword: !!config.password,
        hasClientSecret: !!config.clientSecret,
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      });
      delete gaDefaults.apiToken; delete gaDefaults.password; delete gaDefaults.clientSecret;
      return {
        body: genericApiGeneralHTML(gaDefaults),
        defaults: gaDefaults,
        formGetter: function () {
          var fc = getGenericApiFormConfig();
          if (!fc.apiToken) delete fc.apiToken;
          if (!fc.password) delete fc.password;
          if (!fc.clientSecret) delete fc.clientSecret;
          return fc;
        },
      };
    }

    if (isWl) {
      // All four places a field must land (schema, service, form + reader,
      // these defaults) carry every key below — round-trip Add → Save → Edit.
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        useTls: config.useTls !== false,
        verifyTls: config.verifyTls !== false,
        apiTokenPlaceholder: "Leave blank to keep current key",
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        vmInclude: config.vmInclude || [],
        vmExclude: config.vmExclude || [],
        containerInclude: config.containerInclude || [],
        containerExclude: config.containerExclude || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      if (intg.type === "proxmox") {
        delete defaults.useTls;
        defaults.fallbackHosts = config.fallbackHosts || [];
        defaults.apiTokenId = config.apiTokenId || "";
        defaults.apiTokenPlaceholder = "Leave blank to keep current secret";
        body = proxmoxFormHTML(defaults);
      } else {
        body = workloadFormHTML(intg.type, defaults);
      }
      formGetter = function () {
        var fc = intg.type === "proxmox" ? getProxmoxFormConfig() : getWorkloadFormConfig();
        if (!fc.apiToken) delete fc.apiToken;
        return fc;
      };
    } else if (isVc) {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        verifyTls: config.verifyTls !== false,
        username: config.username,
        password: "",
        passwordPlaceholder: "Leave blank to keep current password",
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        vmInclude: config.vmInclude || [],
        vmExclude: config.vmExclude || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = vcenterFormHTML(defaults);
      formGetter = function () {
        var fc = getVcenterFormConfig();
        if (!fc.password) delete fc.password;
        return fc;
      };
    } else if (isAd) {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        useLdaps: config.useLdaps !== false,
        verifyTls: config.verifyTls,
        bindDn: config.bindDn,
        bindPassword: "",
        bindPasswordPlaceholder: "Leave blank to keep current password",
        baseDn: config.baseDn,
        searchScope: config.searchScope || "sub",
        includeDisabled: config.includeDisabled !== false,
        decommissionMissing: config.decommissionMissing === true,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        ouInclude: config.ouInclude || [],
        ouExclude: config.ouExclude || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = activeDirectoryFormHTML(defaults);
      formGetter = function () {
        var fc = getAdFormConfig();
        if (!fc.bindPassword) delete fc.bindPassword;
        return fc;
      };
    } else if (isEntra) {
      var defaults = {
        name: intg.name,
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: "",
        clientSecretPlaceholder: "Leave blank to keep current secret",
        enableIntune: config.enableIntune,
        pullSoftware: config.pullSoftware === true,
        includeDisabled: config.includeDisabled !== false,
        decommissionMissing: config.decommissionMissing === true,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        deviceInclude: config.deviceInclude || [],
        deviceExclude: config.deviceExclude || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = entraIdFormHTML(defaults);
      formGetter = function () {
        var fc = getEntraFormConfig();
        if (!fc.clientSecret) delete fc.clientSecret;
        return fc;
      };
    } else if (isArc) {
      var defaults = {
        name: intg.name,
        tenantId: config.tenantId,
        clientId: config.clientId,
        clientSecret: "",
        clientSecretPlaceholder: "Leave blank to keep current secret",
        subscriptionInclude: config.subscriptionInclude || [],
        useResourceGraph: config.useResourceGraph !== false,
        includeDisconnected: config.includeDisconnected !== false,
        fetchNetworkProfile: config.fetchNetworkProfile === true,
        enableVmInstances: config.enableVmInstances === true,
        enableSqlServer: config.enableSqlServer === true,
        enableKubernetes: config.enableKubernetes === true,
        importAzureTags: config.importAzureTags === true,
        azureTagKeys: config.azureTagKeys || [],
        pullSoftware: config.pullSoftware === true,
        logAnalyticsWorkspaceIds: config.logAnalyticsWorkspaceIds || [],
        resourceGroupInclude: config.resourceGroupInclude || [],
        resourceGroupExclude: config.resourceGroupExclude || [],
        deviceInclude: config.deviceInclude || [],
        deviceExclude: config.deviceExclude || [],
        tagInclude: config.tagInclude || [],
        tagExclude: config.tagExclude || [],
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
        // Read by the General tab's read-only/writes-to-Azure callout. Without
        // it that tab tells the operator "Reader is sufficient, don't grant
        // anything broader" while the Script Publishing tab tells them to grant
        // run-command rights — the two tabs of one modal contradicting.
        allowRunCommand: config.allowRunCommand === true,
      };
      body = azureArcFormHTML(defaults);
      formGetter = function () {
        var fc = getArcFormConfig();
        if (!fc.clientSecret) delete fc.clientSecret;
        return fc;
      };
    } else if (isWin) {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        username: config.username,
        password: "",
        passwordPlaceholder: "Leave blank to keep current password",
        useSsl: config.useSsl,
        domain: config.domain,
        enabled: intg.enabled,
        pollInterval: intg.pollInterval,
        dhcpInclude: config.dhcpInclude || [],
        dhcpExclude: config.dhcpExclude || [],
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = windowsServerFormHTML(defaults);
      formGetter = function () {
        var fc = getWinFormConfig();
        if (!fc.password) delete fc.password;
        return fc;
      };
    } else if (isFgt) {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        apiUser: config.apiUser,
        apiToken: "",
        apiTokenPlaceholder: "Leave blank to keep current token",
        vdom: config.vdom,
        verifySsl: config.verifySsl,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        mgmtInterface: config.mgmtInterface,
        dhcpInclude: config.dhcpInclude || [],
        dhcpExclude: config.dhcpExclude || [],
        interfaceInclude: config.interfaceInclude || [],
        interfaceExclude: config.interfaceExclude || [],
        inventoryIncludeInterfaces: config.inventoryIncludeInterfaces || [],
        inventoryExcludeInterfaces: config.inventoryExcludeInterfaces || [],
        allowReboot: config.allowReboot === true,
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = fortiGateFormHTML(defaults);
      formGetter = function () {
        var fc = getFgtFormConfig();
        if (!fc.apiToken) delete fc.apiToken;
        return fc;
      };
    } else {
      var defaults = {
        name: intg.name,
        host: config.host,
        port: config.port,
        apiUser: config.apiUser,
        apiToken: "",
        apiTokenPlaceholder: "Leave blank to keep current token",
        adom: config.adom,
        verifySsl: config.verifySsl,
        enabled: intg.enabled,
        autoDiscover: intg.autoDiscover !== false,
        pollInterval: intg.pollInterval,
        mgmtInterface: config.mgmtInterface,
        interfaceInclude: config.interfaceInclude || [],
        interfaceExclude: config.interfaceExclude || [],
        dhcpInclude: config.dhcpInclude || [],
        dhcpExclude: config.dhcpExclude || [],
        inventoryIncludeInterfaces: config.inventoryIncludeInterfaces || [],
        inventoryExcludeInterfaces: config.inventoryExcludeInterfaces || [],
        deviceInclude: config.deviceInclude || [],
        deviceExclude: config.deviceExclude || [],
        discoveryParallelism: config.discoveryParallelism,
        useProxy: config.useProxy !== false,
        fortigateApiUser: config.fortigateApiUser,
        fortigateApiToken: "",
        fortigateApiTokenPlaceholder: "Leave blank to keep current token",
        fortigateVerifySsl: config.fortigateVerifySsl === true,
        allowReboot: config.allowReboot === true,
        verboseLogging: config.verboseLogging === true,
        verboseLoggingEnabledAt: config.verboseLoggingEnabledAt,
      };
      body = fortiManagerFormHTML(defaults);
      formGetter = function () {
        var fc = getFormConfig();
        if (!fc.apiToken) delete fc.apiToken;
        if (!fc.fortigateApiToken) delete fc.fortigateApiToken;
        return fc;
      };
    }
    // `defaults` rides along because _integrationTabs re-renders the FMG /
    // FortiGate General + Filters tabs from it and forwards the blob into the
    // Monitoring tab as `fmgDefaults`. It was function-local when this spec was
    // split out of openIntegrationEditModal, which left those call sites referencing a
    // free variable — a ReferenceError on every FMG / FortiGate edit.
    return { body: body, formGetter: formGetter, defaults: defaults };
}

/**
 * Test Connection for the Edit flow — posts the current (unsaved) form config;
 * on an FMG in bypass mode it also verifies the direct-FortiGate path.
 *
 * A plain async function: openIntegrationModal owns the button's
 * disabled/relabel state and turns a throw into a toast.
 */
async function _testExistingIntegration(id, intg) {
  var isWin = intg.type === "windowsserver";
  var isEntra = intg.type === "entraid";
  var isAd = intg.type === "activedirectory";
  var isVc = intg.type === "vcenter";
  var isArc = intg.type === "azurearc";
  var formConfig = _formConfigForType(intg.type);
  // Strip blank secrets so the server fills them in from the stored config.
  if (intg.type === "genericapi") {
    if (!formConfig.apiToken) delete formConfig.apiToken;
    if (!formConfig.password) delete formConfig.password;
    if (!formConfig.clientSecret) delete formConfig.clientSecret;
  } else if (isWin || isVc) { if (!formConfig.password) delete formConfig.password; }
  else if (isEntra || isArc) { if (!formConfig.clientSecret) delete formConfig.clientSecret; }
  else if (isAd) { if (!formConfig.bindPassword) delete formConfig.bindPassword; }
  else {
    if (!formConfig.apiToken) delete formConfig.apiToken;
    if (!formConfig.fortigateApiToken) delete formConfig.fortigateApiToken;
  }
  var result = await api.integrations.testNew({
    id: id,
    type: intg.type,
    name: val("f-name") || intg.name,
    config: formConfig,
  });
  showToast(result.message, result.ok ? "success" : "error");
  if (intg.type === "llm" && result.models) _renderLlmModelPicker(result.models, id);
  if (result.ok) loadIntegrations();
  // Direct-transport sanity check: run asynchronously so the FMG toast appears
  // immediately rather than waiting on the FortiGate probe (which can take 10s
  // if the random gate is unreachable).
  if (result.ok && intg.type === "fortimanager" && formConfig && formConfig.useProxy === false) {
    var probeBody = {
      id: id,
      type: intg.type,
      name: val("f-name") || intg.name,
      config: formConfig,
    };
    _runFortigateSampleProbe(function () { return api.integrations.testFortigateSampleNew(probeBody); });
  }
  return result;
}

// Save phase for the Edit flow: buildEditConfig (form read, no persist) +
// commitSave (the PUT + monitor-settings PUT) + the Auto-Monitor
// capacity-warning confirm that must run BEFORE anything persists.
//
// A plain async function — openIntegrationModal owns the button's
// disabled/relabel state and turns a throw into a toast.
async function _saveIntegration(id, intg, formGetter) {
    var isWin = intg.type === "windowsserver";
    var isFgt = intg.type === "fortigate";
    var isEntra = intg.type === "entraid";
    var isAd = intg.type === "activedirectory";
    var isVc = intg.type === "vcenter";
    var isArc = intg.type === "azurearc";
    var isWl = _isWorkloadType(intg.type);
    var isFmgOrFgt =(intg.type === "fortimanager" || intg.type === "fortigate");
    // Reads the form into an editConfig WITHOUT persisting it. Split from
    // commitSave so the Auto-Monitor capacity-warning confirm can run BEFORE
    // the PUT — previously the integration was already saved by the time the
    // confirm appeared, so cancelling it still left the change persisted.
    function buildEditConfig() {
      var autoDiscoverEl = document.getElementById("f-autoDiscover");
      var editConfig = formGetter();
      if (isFmgOrFgt) {
        // Always send the picker value so an explicit clear round-trips.
        // Empty string is normalized to null on the server.
        editConfig.monitorCredentialId = _readMonitorCredentialId() || null;
        editConfig.sshCredentialId     = _readSshCredentialId()     || null;
        // Per-stream polling methods are persisted via the
        // /monitor-settings/integration/:id PUT below — they live in
        // Integration.config.monitorSettings.polling now.
        // Per-class FortiGate / FortiSwitch / FortiAP blocks. The reader
        // returns null when its subtab didn't render — in that case leave
        // the existing config alone rather than wiping it.
        // Phase 2: each class subtab carries its own per-stream config. The
        // FortiGate subtab is the primary (uses legacy IDs); FortiSwitch and
        // FortiAP are secondary subtabs whose IDs are namespaced under
        // `f-mon-classecho-<klass>-`. FortiAP omits storage.
        var fgBlock = _readFortigateMonitorBlock("f-mon-fortigate-",   { klass: "fortigate",   isPrimary: true });
        var swBlock = _readClassMonitorBlock("f-mon-fortiswitch-",     { klass: "fortiswitch", isPrimary: false });
        var apBlock = _readClassMonitorBlock("f-mon-fortiap-",         { klass: "fortiap",     isPrimary: false, includeStorage: false });
        if (fgBlock) editConfig.fortigateMonitor   = fgBlock;
        if (swBlock) editConfig.fortiswitchMonitor = swBlock;
        if (apBlock) editConfig.fortiapMonitor     = apBlock;
        // FMG and standalone FortiGate share the DHCP Push + Quarantine Push
        // tabs. Readers return undefined when the tabs didn't render (e.g.
        // future integration type that doesn't expose them); leave unchanged.
        var pushToggle = _readPushReservationsToggle();
        if (pushToggle !== undefined) editConfig.pushReservations = pushToggle;
        var arpSweepToggle = _readArpPresenceSweepToggle();
        if (arpSweepToggle !== undefined) editConfig.arpPresenceSweep = arpSweepToggle;
        var autoReserveInfraEdit = _readAutoReserveInfraToggle();
        if (autoReserveInfraEdit !== undefined) editConfig.autoReserveFortinetInfra = autoReserveInfraEdit;
        var adoptMacEdit = _readAdoptDiscoveredMacToggle();
        if (adoptMacEdit !== undefined) editConfig.adoptDiscoveredMac = adoptMacEdit;
        var quarantinePushToggle = _readPushQuarantineToggle();
        if (quarantinePushToggle !== undefined) editConfig.pushQuarantine = quarantinePushToggle;
        var syncDescriptionsEdit = _readSyncDescriptionsToggles();
        if (syncDescriptionsEdit !== undefined) Object.assign(editConfig, syncDescriptionsEdit);
        var sdwanToggle = _readPullSdwanToggle();
        if (sdwanToggle !== undefined) editConfig.pullSdwan = sdwanToggle;
        var sdwanInterval = _readSdwanInterval();
        if (sdwanInterval !== undefined) editConfig.sdwanIntervalSeconds = sdwanInterval;
        var excludeFortilinkLldpEdit = _readExcludeFortilinkLldpToggle();
        if (excludeFortilinkLldpEdit !== undefined) editConfig.excludeFortilinkLldp = excludeFortilinkLldpEdit;
      }
      if (isEntra) {
        var publishToIntuneEdit = _readPublishToIntuneToggle();
        if (publishToIntuneEdit !== undefined) editConfig.publishToIntune = publishToIntuneEdit;
      }
      if (isArc) {
        var allowRunCommandEdit = _readAllowRunCommandToggle();
        if (allowRunCommandEdit !== undefined) editConfig.allowRunCommand = allowRunCommandEdit;
      }
      if (isAd || isEntra || isWin || isArc) {
        // AD / Entra / Windows Server per-class blocks. Workstations is the
        // primary class subtab (legacy `f-mon-*` IDs); Servers is secondary
        // (namespaced `f-mon-classecho-servers-*`). Class keys are plural in
        // _CLASS_SUBTAB_SPECS to match the human-facing tab labels; backend
        // schema names them singularly. Readers return null when the subtab
        // didn't render — leave existing config alone.
        var wsBlock  = _readWorkstationServerMonitorBlock("f-mon-workstation-", { klass: "workstations", isPrimary: true });
        var srvBlock = _readWorkstationServerMonitorBlock("f-mon-server-",      { klass: "servers",      isPrimary: false });
        if (isArc) {
          var k8sBlock = _readWorkstationServerMonitorBlock("f-mon-clusters-", { klass: "clusters", isPrimary: false });
          if (k8sBlock) editConfig.k8sMonitor = k8sBlock;
        }
        if (wsBlock)  editConfig.workstationMonitor = wsBlock;
        if (srvBlock) editConfig.serverMonitor      = srvBlock;
        var verifyPresenceEdit = _readVerifyPresenceToggle();
        if (verifyPresenceEdit !== undefined) editConfig.verifyPresence = verifyPresenceEdit;
        var dirSearchEdit = _readDirectorySearchToggle();
        if (dirSearchEdit !== undefined) editConfig.enableDirectorySearch = dirSearchEdit;
        // The Directory tab is one control set: the sync toggle and its
        // exclusions are read together, so a saved filter can never belong to
        // a toggle that was not saved with it.
        var dirSyncEdit = _readDirectorySyncConfig();
        if (dirSyncEdit !== undefined) {
          editConfig.enableDirectorySync = dirSyncEdit.enabled;
          editConfig.directorySync = dirSyncEdit.filter;
        }
      }
      if (isVc) {
        // vCenter per-class blocks: VMs primary. The host block's extra
        // null fields (auto-monitor / agent-deploy) are stripped by Zod.
        var vmBlock   = _readWorkstationServerMonitorBlock("f-mon-vm-",   { klass: "vms",   isPrimary: true });
        var hostBlock = _readWorkstationServerMonitorBlock("f-mon-host-", { klass: "hosts", isPrimary: false });
        if (vmBlock)   editConfig.vmMonitor   = vmBlock;
        if (hostBlock) editConfig.hostMonitor = hostBlock;
        var vcVerifyPresenceEdit = _readVerifyPresenceToggle();
        if (vcVerifyPresenceEdit !== undefined) editConfig.verifyPresence = vcVerifyPresenceEdit;
      }
      if (isWl) {
        var wlHost = _readWorkstationServerMonitorBlock("f-mon-wlhost-", { klass: "wlhosts",    isPrimary: true });
        var wlVm   = _readWorkstationServerMonitorBlock("f-mon-wlvm-",   { klass: "wlvms",      isPrimary: false });
        var wlCtr  = _readWorkstationServerMonitorBlock("f-mon-ctr-",    { klass: "containers", isPrimary: false });
        if (wlHost) editConfig.hostMonitor      = wlHost;
        if (wlVm)   editConfig.vmMonitor        = wlVm;
        if (wlCtr)  editConfig.containerMonitor = wlCtr;
      }
      return { editConfig: editConfig, autoDiscoverEl: autoDiscoverEl };
    }

    // PUTs a previously-built editConfig (from buildEditConfig) plus the
    // integration-tier monitor settings, and returns the result so the caller
    // can drive the auto-monitor apply pass for any class with a non-null
    // selection.
    async function commitSave(built) {
      var input = {
        name: val("f-name"),
        config: built.editConfig,
        enabled: document.getElementById("f-enabled").checked,
        autoDiscover: built.autoDiscoverEl ? built.autoDiscoverEl.checked : true,
        pollInterval: parseInt(document.getElementById("f-pollInterval").value, 10) || 4,
      };
      var result = await api.integrations.update(id, input);
      // Persist the integration-tier monitor settings for any integration
      // type that renders a Monitoring tab. Failures here aren't fatal —
      // the integration update itself already landed.
      if (isFmgOrFgt || isAd || isEntra || isWin || isVc || isArc || isWl) {
        try { await api.monitorSettings.setIntegration(id, getMonitorSettingsFromForm()); }
        catch (e) { showToast("Integration updated, but monitor settings couldn\'t be saved: " + (e.message || "unknown error"), "error"); }
      }
      return { result: result, editConfig: built.editConfig };
    }

    // Auto-Monitor confirm gate (FortiGate/Switch/AP only) — preflight
    // the operator's proposed addAsMonitored toggle states and ask for
    // confirmation when disabling would sweep monitoring off existing
    // assets. Read from the hidden checkboxes (the visible buttons
    // toggle these via _wireAutoMonitoringButtons). Aborts the save
    // without re-enabling the button if the operator declines, so the
    // finally block at the end resets state cleanly.
    if (isFmgOrFgt) {
      var proposed = {};
      var fgEl = document.getElementById("f-mon-fortigate-addAsMonitored");
      var swEl = document.getElementById("f-mon-fortiswitch-addAsMonitored");
      var apEl = document.getElementById("f-mon-fortiap-addAsMonitored");
      if (fgEl) proposed.firewall     = fgEl.checked === true;
      if (swEl) proposed["switch"]    = swEl.checked === true;
      if (apEl) proposed.access_point = apEl.checked === true;
      try {
        var pre = await api.integrations.autoMonitorAssetsPreflight(id, proposed);
        var disablingClasses = [];
        ["firewall", "switch", "access_point"].forEach(function (k) {
          var c = pre && pre.classes && pre.classes[k];
          if (c && c.wouldDisable > 0) {
            disablingClasses.push({ k: k, wouldDisable: c.wouldDisable, overridden: c.overridden });
          }
        });
        if (disablingClasses.length > 0) {
          var humanClass = { firewall: "FortiGate", "switch": "FortiSwitch", access_point: "FortiAP" };
          var lines = disablingClasses.map(function (d) {
            var protectedNote = d.overridden > 0 ? " (" + d.overridden + " protected by per-asset override)" : "";
            return "  • " + humanClass[d.k] + ": " + d.wouldDisable + " asset(s) will stop being monitored" + protectedNote;
          });
          var ok = await showConfirm(
            "Disabling Auto-Monitoring will sweep monitoring OFF for previously-discovered assets:\n\n" +
            lines.join("\n") + "\n\n" +
            "Per-asset overrides are preserved. Continue?"
          );
          if (!ok) return;
        }
      } catch (preflightErr) {
        // Preflight failure shouldn't block the save — log it and proceed.
        // The backend save itself will still apply correctly.
        if (window.console) console.warn("Auto-Monitor preflight failed:", preflightErr);
      }
    }

    // Build the editConfig from the form, but DON'T save yet — the
    // Auto-Monitor capacity-warning confirm has to gate the PUT so that
    // cancelling it leaves the integration unsaved and the edit modal open.
    var built = buildEditConfig();
    var classes = isFmgOrFgt ? [
      ["fortigate",   built.editConfig.fortigateMonitor],
      ["fortiswitch", built.editConfig.fortiswitchMonitor],
      ["fortiap",     built.editConfig.fortiapMonitor],
    ] : [];

    // Fire apply only for per-class blocks whose autoMonitorInterfaces
    // selection actually changed during this modal session. Saving for
    // an unrelated reason (API token rotation, name change, monitoring
    // tier edit) used to re-fire apply for every block that had ANY
    // selection — expensive on big fleets and surprising to operators.
    // Baseline = saved selection stashed at modal-open by
    // _autoMonitorInterfacesHTML; proposed = whatever editConfig holds
    // (what we're about to PUT). Equality goes through _amonCanonicalize so
    // array reordering / null-vs-empty-object don't read as a change.
    var classToBaselinePrefix = {
      fortigate:   "f-mon-fortigate-amon-",
      fortiswitch: "f-mon-fortiswitch-amon-",
      fortiap:     "f-mon-fortiap-amon-",
    };
    var activeApplies = classes.filter(function (entry) {
      if (!(entry[1] && entry[1].autoMonitorInterfaces)) return false;
      var prefix = classToBaselinePrefix[entry[0]];
      var baseline = prefix ? window["__autoMon_savedSelection_" + prefix] : null;
      return _amonCanonicalize(baseline) !== _amonCanonicalize(entry[1].autoMonitorInterfaces);
    });

    // Capacity guard: warn BEFORE saving when the changed selections would
    // pin a large number of interfaces. We sniff the cached count from each
    // preview block; missing/stale values just skip the warning. Scoped to
    // the blocks that ARE changing — a class whose selection didn't change
    // this session shouldn't contribute to the estimate. Cancelling here
    // returns to the edit modal with NOTHING saved (the finally block
    // re-enables the Save button).
    if (activeApplies.length > 0) {
      var changedPrefixes = activeApplies
        .map(function (e) { return classToBaselinePrefix[e[0]]; })
        .filter(Boolean);
      var totalEstimate = 0;
      changedPrefixes.forEach(function (p) {
        var el = document.getElementById(p + "preview");
        var n = el && el.dataset && parseInt(el.dataset.interfaceCount || "0", 10);
        if (Number.isFinite(n)) totalEstimate += n;
      });
      if (totalEstimate > AUTO_MONITOR_INTERFACE_WARN_THRESHOLD) {
        var ok = await showConfirm(
          "Auto-Monitor will pin approximately " + totalEstimate + " interfaces across the discovered devices.\n\n" +
          "Each pin gets scraped on the response-time cadence (default 60s). Large pin counts add load to the database and to the monitored devices.\n\n" +
          "Continue saving and applying now?"
        );
        if (!ok) {
          showToast("Cancelled — nothing saved");
          return;
        }
      }
    }

    // Confirm cleared (or wasn't needed) — persist now.
    var saved = await commitSave(built);

    if (activeApplies.length > 0) {
      // Kick each per-class apply. The endpoint now returns 202 immediately
      // and resolves the selection against the fleet in the BACKGROUND —
      // on big fleets the resolve is a multi-second-to-minutes query, so
      // awaiting it here used to wedge the modal on "Applying..." for
      // minutes. The apply is additive + idempotent and also re-runs on the
      // next discovery, so we just confirm it started.
      var applyResults = await Promise.all(activeApplies.map(function (entry) {
        return api.integrations.interfaceAggregateApply(id, entry[0]).then(
          function () { return { ok: true,  klass: entry[0] }; },
          function (err) { return { ok: false, klass: entry[0], err: err }; },
        );
      }));
      var failures = [];
      for (var c = 0; c < applyResults.length; c++) {
        if (!applyResults[c].ok) failures.push(applyResults[c].klass + ": " + (applyResults[c].err.message || "failed"));
      }
      closeModal();
      if (failures.length === 0) {
        showToast("Integration updated · auto-monitor is applying in the background", "success");
      } else {
        showToast("Saved, but apply couldn't start — " + failures.join("; "), "error");
      }
    } else {
      if (intg.type === "llm") await _saveLlmRetention();
      closeModal();
      showToast("Integration updated");
      if (intg.type === "llm") _autoCheckLlmTools(id, intg.name);
    }
    loadIntegrations();
    if (saved.result && saved.result.conflicts && saved.result.conflicts.length) {
      showConflictModal(saved.result.id || id, saved.result.conflicts);
    }
}

async function testConnection(id, btn) {
  btn.disabled = true;
  btn.textContent = "Testing...";
  var card = btn.closest(".integration-card");
  var name = card.querySelector("strong").textContent;
  var isFmgDirect = card.getAttribute("data-fmg-direct") === "1";
  try {
    var result = await api.integrations.test(id, name);
    showToast(result.message, result.ok ? "success" : "error");
    loadIntegrations();
    if (result.ok && isFmgDirect) {
      _runFortigateSampleProbe(function () { return api.integrations.testFortigateSample(id); });
    }
  } catch (err) {
    if (err.name === "AbortError") { showToast("Test aborted", "error"); }
    else { showToast(err.message, "error"); }
  } finally {
    btn.disabled = false;
    btn.textContent = "Test Connection";
  }
}

async function runDiscovery(id) {
  var wrap = document.getElementById("discover-wrap-" + id);
  var name = wrap ? ((wrap.closest(".integration-card") || document).querySelector("strong") || {}).textContent || "" : "";
  // Flip button immediately; the server poll will keep it in sync
  if (wrap) wrap.innerHTML = _discoverBtnHTML(id, name, { id: id, name: name, currentDevice: null }, false);
  try {
    await api.integrations.discover(id, name);
    // Immediately refresh the server discoveries list so the sidebar popup
    // transitions seamlessly from the tracked POST to the running discovery
    // entry without the up-to-4-second gap from the normal polling interval.
    if (window._pollDiscoveries) window._pollDiscoveries();
    showToast("Discovery started — running in the background. Results will appear shortly.", "success");
    [15000, 45000, 120000].forEach(function (delay) {
      setTimeout(function () {
        if (document.getElementById("integrations-list")) loadIntegrations();
      }, delay);
    });
  } catch (err) {
    // Restore button on error (poll will also correct it on next tick)
    var disabled = wrap ? wrap.getAttribute("data-disabled") === "1" : false;
    if (wrap) wrap.innerHTML = _discoverBtnHTML(id, name, false, disabled);
    if (err.name === "AbortError") { showToast("Discovery aborted", "error"); }
    else { showToast(err.message, "error"); }
  }
}

async function abortIntegrationDiscovery(id, name) {
  var ok = await showConfirm('Abort discovery of "' + name + '"?');
  if (!ok) return;
  try { await api.integrations.abortDiscover(id); } catch (_) {}
}

// ─── Delete (business rule 160) ──────────────────────────────────────────────
// Deleting an integration keeps what it discovered — the inventory is not the
// integration's to take with it — but detaches it: that integration's source
// data, tags and placement links go, so the records stand as plain manual ones.
// The dialog says how much that is before it happens, offers to decommission
// the assets nothing else reports, and says plainly that DHCP entries pushed
// to a device stay there.

function _plural(n, one, many) { return n + " " + (n === 1 ? one : many); }

/**
 * The body of the Delete Integration dialog from a delete-preview. An
 * integration that discovered nothing gets the one-line question it always had.
 */
function _integrationDeleteBodyHTML(name, p) {
  var html = '<p style="margin:0">Delete integration <strong>' + escapeHtml(name) + "</strong>? This cannot be undone.</p>";
  var lines = [];
  if (p.sourcedAssets > 0) {
    lines.push("<li>" + _plural(p.sourcedAssets, "asset it discovered is", "assets it discovered are") +
      " <strong>kept</strong>. What this integration reported about " + (p.sourcedAssets === 1 ? "it" : "them") +
      " is removed, so " + (p.sourcedAssets === 1 ? "it stops" : "they stop") + " being updated from it.</li>");
  }
  if (p.networks > 0) lines.push("<li>" + _plural(p.networks, "network it discovered is", "networks it discovered are") + " kept as " + (p.networks === 1 ? "a manual network" : "manual networks") + ".</li>");
  if (p.azureTaggedAssets > 0) lines.push("<li>The <code>azure:</code> tags on " + _plural(p.azureTaggedAssets, "asset", "assets") + " are removed.</li>");
  if (p.pushedReservations > 0) {
    lines.push("<li><strong>" + _plural(p.pushedReservations, "DHCP reservation", "DHCP reservations") + " it pushed " +
      (p.pushedReservations === 1 ? "stays" : "stay") + " on the device.</strong> Polaris will not be able to change or remove " +
      (p.pushedReservations === 1 ? "it" : "them") + " afterwards; each one is listed in Events.</li>");
  }
  if (lines.length) {
    html += '<ul style="margin:0.75rem 0 0;padding-left:1.1rem;font-size:0.85rem;color:var(--color-text-secondary);line-height:1.5">' + lines.join("") + "</ul>";
  }
  if (p.soleSourceAssets > 0) {
    var monitored = p.soleSourceMonitored > 0
      ? " " + _plural(p.soleSourceMonitored, "of them is monitored now and will stop being polled.", "of them are monitored now and will stop being polled.")
      : "";
    html += '<div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
      '<label for="idel-decom" style="display:flex;gap:0.5rem;align-items:flex-start;font-size:0.9rem;' + (p.canDecommission ? "cursor:pointer" : "opacity:0.65") + '"' +
        (p.canDecommission ? "" : ' title="Decommissioning needs Full Read-Write on Assets"') + ">" +
        '<input type="checkbox" id="idel-decom" style="width:auto;margin-top:0.15rem"' + (p.canDecommission ? "" : " disabled") + ">" +
        "<span>Also <strong>decommission</strong> the " + _plural(p.soleSourceAssets, "asset", "assets") + " that no other source reports</span>" +
      "</label>" +
      '<p class="hint" style="margin:0.35rem 0 0 1.6rem">Left unticked, ' + (p.soleSourceAssets === 1 ? "it stays" : "they stay") +
        " active with nothing updating " + (p.soleSourceAssets === 1 ? "it" : "them") + "." + monitored +
        (p.canDecommission ? "" : " You need Full Read-Write on Assets to decommission them here.") + "</p>" +
    "</div>";
  }
  return html;
}

async function confirmDeleteIntegration(id, name) {
  var preview = null;
  try { preview = await api.integrations.deletePreview(id); } catch (_err) { /* the numbers are a courtesy */ }
  var nothingToSay = !preview || (!preview.sourcedAssets && !preview.networks && !preview.pushedReservations && !preview.azureTaggedAssets);
  if (nothingToSay) {
    var yes = await showConfirm('Delete integration "' + name + '"? This cannot be undone.');
    if (!yes) return;
    try {
      await api.integrations.delete(id);
      showToast("Integration deleted");
      loadIntegrations();
    } catch (err) {
      showToast(err.message, "error");
    }
    return;
  }
  openModal("Delete integration", _integrationDeleteBodyHTML(name, preview),
    '<button class="btn btn-secondary" id="idel-cancel">Cancel</button><button class="btn btn-danger" id="idel-ok">Delete integration</button>');
  document.getElementById("idel-cancel").addEventListener("click", closeModal);
  var ok = document.getElementById("idel-ok");
  ok.addEventListener("click", async function () {
    var box = document.getElementById("idel-decom");
    var decommission = !!(box && box.checked);
    ok.disabled = true;
    try {
      await api.integrations.delete(id, { decommission: decommission });
      closeModal();
      showToast("Integration deleted" + (decommission ? "; " + _plural(preview.soleSourceAssets, "asset", "assets") + " decommissioned" : ""));
      loadIntegrations();
    } catch (err) {
      showToast(err.message || "Could not delete the integration", "error");
      ok.disabled = false;
    }
  });
}

function showConflictModal(integrationId, conflicts) {
  var admin = canManageNetworks();
  var resConflicts = conflicts.filter(function (c) { return c.type === "reservation"; });
  if (!resConflicts.length) return;

  var body = admin
    ? '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">An existing reservation was found for this IP. Select which fields to overwrite.</p>'
    : '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">An existing reservation was found for this IP. Contact an administrator to resolve the conflict.</p>';

  var fieldLabels = {
    ipAddress: "IP Address", hostname: "Hostname", owner: "Owner",
    projectRef: "Project Ref", notes: "Notes", status: "Status",
    subnetCidr: "Network",
  };
  var editableFields = ["hostname", "owner", "projectRef", "notes", "status"];

  resConflicts.forEach(function (c) {
    var fields = ["ipAddress", "hostname", "owner", "projectRef", "notes", "status"];

    body += '<div style="margin-bottom:1rem">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.5rem">Reservation Conflict</p>' +
      '<div class="conflict-table"><table><thead><tr>';
    if (admin) body += '<th style="width:36px"></th>';
    body += '<th>Field</th><th>Existing</th><th>New</th></tr></thead><tbody>';

    fields.forEach(function (f) {
      var existVal = c.existing[f] != null ? String(c.existing[f]) : "-";
      var newVal = c.proposed[f] != null ? String(c.proposed[f]) : "-";
      var changed = existVal !== newVal;
      var canCheck = admin && changed && editableFields.indexOf(f) !== -1;
      body += '<tr' + (changed ? ' class="conflict-changed"' : '') + '>';
      if (admin) {
        body += '<td style="text-align:center">';
        if (canCheck) {
          body += '<input type="checkbox" class="conflict-cb" data-field="' + f + '" checked>';
        }
        body += '</td>';
      }
      body += '<td class="conflict-field">' + escapeHtml(fieldLabels[f] || f) + '</td>' +
        '<td>' + escapeHtml(existVal) + '</td>' +
        '<td>' + (changed ? '<strong>' + escapeHtml(newVal) + '</strong>' : escapeHtml(newVal)) + '</td>' +
        '</tr>';
    });

    body += '</tbody></table></div></div>';
  });

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Keep Existing</button>';
  if (admin) {
    footer += '<button class="btn btn-danger" id="btn-overwrite">Overwrite Selected</button>';
  }

  openModal("Reservation Conflict Detected", body, footer);

  if (admin) {
    document.getElementById("btn-overwrite").addEventListener("click", async function () {
      var btn = this;
      var checked = document.querySelectorAll(".conflict-cb:checked");
      var selectedFields = [];
      checked.forEach(function (cb) { selectedFields.push(cb.getAttribute("data-field")); });
      if (!selectedFields.length) {
        showToast("Select at least one field to overwrite", "error");
        return;
      }
      btn.disabled = true;
      btn.textContent = "Overwriting...";
      try {
        await api.integrations.register(integrationId, { fields: selectedFields });
        closeModal();
        showToast("Selected fields overwritten");
        loadIntegrations();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "Overwrite Selected";
      }
    });
  }
}

// val() is the app.js canonical (2026-08 audit — five identical top-level copies shadowed each other on co-loaded pages).

