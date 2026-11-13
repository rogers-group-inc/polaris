/**
 * public/js/integrations-forms.js — the per-type General / Filters
 * forms (<type>GeneralHTML / <type>FormHTML) and their get<Type>FormConfig
 * readers for every type but the Generic API, the shared Verbose logging and
 * Allow reboots blocks, and the AI Assistant (llm) model picker.
 *
 * Split out of integrations.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals. Loads AFTER
 * integrations.js — tests/unit/integrationsSplit.test.ts holds the order.
 */

// Shared "Verbose debug logging" checkbox appended to the General tab of
// every integration type. When ticked, the next discovery cycle + every
// monitor worker job published for assets owned by this integration emits
// step-by-step structured logs to journalctl. Auto-disables after 30 minutes.
function verboseLoggingFormHTML(defaults) {
  var d = defaults || {};
  var checked = d.verboseLogging === true ? "checked" : "";

  // When currently enabled with a known start time, show a countdown so the
  // operator knows when it will auto-disable.
  var expiryHint = "";
  if (d.verboseLogging === true && d.verboseLoggingEnabledAt) {
    var enabledAt = new Date(d.verboseLoggingEnabledAt);
    var expiresAt = new Date(enabledAt.getTime() + 30 * 60 * 1000);
    var remainingMs = expiresAt - Date.now();
    if (remainingMs > 0) {
      var remainingMin = Math.ceil(remainingMs / 60000);
      expiryHint = " <span style=\"color:var(--color-warning);font-size:0.78rem;font-weight:normal\">— auto-disables in " + remainingMin + " min</span>";
    } else {
      expiryHint = " <span style=\"color:var(--color-text-tertiary);font-size:0.78rem;font-weight:normal\">— auto-disabling shortly</span>";
    }
  }

  return formDivider() +
    "<p style=\"font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.5rem\">Debug</p>" +
    "<div style=\"display:flex;align-items:flex-start;gap:0.55rem\">" +
      "<input type=\"checkbox\" id=\"f-verboseLogging\" " + checked + " style=\"margin-top:3px\">" +
      "<label for=\"f-verboseLogging\" style=\"margin:0\">" +
        "<strong>Verbose debug logging</strong>" + expiryHint + "<br>" +
        "<span style=\"font-size:0.8rem;color:var(--color-text-secondary)\">" +
        "Emits step-by-step discovery, sync, and worker pickup/finish logs to " +
        "journalctl for this integration. High log volume — flip on for diagnosis, " +
        "flip off when done. Auto-disables after 30 minutes. " +
        "Effective on the next discovery cycle / monitor tick; no restart needed." +
        "</span>" +
      "</label>" +
    "</div>";
}

// Read the verbose-logging checkbox from any integration form. Returns
// `false` when the checkbox isn't on the page (defensive — keeps the
// config valid for older modals that may not include it yet).
function readVerboseLoggingFromForm() {
  var el = document.getElementById("f-verboseLogging");
  return el ? el.checked === true : false;
}

// "Allow reboots" (business rule 115) — on the General tab of the FortiManager
// and FortiGate dialogs, identical on both (the parity convention). Lets this
// integration's FortiOS API token reboot the FortiGates it discovered and
// restart their managed FortiSwitches / FortiAPs from an asset's Reboot
// button. Off by default; every flip is named on the integration's Event.
function allowRebootFormHTML(defaults) {
  var d = defaults || {};
  return formDivider() +
    sectionHeading("Device Actions") +
    '<div style="display:flex;align-items:flex-start;gap:0.55rem">' +
      '<input type="checkbox" id="f-allowReboot" ' + (d.allowReboot === true ? "checked" : "") + ' style="margin-top:3px">' +
      '<label for="f-allowReboot" style="margin:0">' +
        '<strong>Allow reboots</strong><br>' +
        '<span style="font-size:0.8rem;color:var(--color-text-secondary)">' +
        'Lets this integration’s API token reboot the FortiGates it discovered, and restart the FortiSwitches and FortiAPs those FortiGates manage, ' +
        'from an asset’s <strong>Reboot</strong> button — now or on a schedule — by anyone with Read-Write on Assets. FortiGate HA members are always refused. ' +
        'The token’s admin profile needs System read-write (and WiFi &amp; Switch read-write for switches and APs).' +
        '</span>' +
      '</label>' +
    '</div>';
}

function readAllowRebootFromForm() {
  var el = document.getElementById("f-allowReboot");
  return el ? el.checked === true : false;
}

function fortiManagerGeneralHTML(defaults) {
  var d = defaults || {};
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Production FortiManager"></div>' +
    infoBox('This integration is for <strong style="color:var(--color-text-primary)">on-premise FortiManager</strong> only (not FortiManager Cloud). Requires version <strong style="color:var(--color-text-primary)">7.4.7+</strong> or <strong style="color:var(--color-text-primary)">7.6.2+</strong>. Older versions do not support bearer token authentication.') +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. fmg.example.com"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 443) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group"><label>API User</label><input type="text" id="f-apiUser" value="' + escapeHtml(d.apiUser || "") + '" placeholder="e.g. api-admin"></div>' +
    '<div class="form-group"><label>API Token</label><input type="password" id="f-apiToken" value="' + (d.apiTokenPlaceholder ? "" : escapeHtml(d.apiToken || "")) + '" placeholder="' + (d.apiTokenPlaceholder || "Bearer token") + '"><p class="hint">Generate from FortiManager under System Settings &gt; Admin &gt; API Users</p></div>' +
    '<div class="form-group"><label>ADOM</label><input type="text" id="f-adom" value="' + escapeHtml(d.adom || "root") + '" placeholder="root"><p class="hint">Administrative Domain (leave as "root" for default)</p></div>' +
    '<div class="form-group"><label>Management Interface</label><input type="text" id="f-mgmtInterface" value="' + escapeHtml(d.mgmtInterface || "") + '" placeholder="e.g. port1, mgmt, loopback0"><p class="hint">Interface name used for FortiGate management traffic</p></div>' +
    checkboxRow("f-verifySsl", "Verify SSL certificate", d.verifySsl) +
    '<p class="hint" style="color:var(--color-warning)">Leave enabled. Disabling certificate verification lets a network attacker on the path intercept this connection and capture the API credentials. Disable only for a device with a self-signed certificate you cannot replace.</p>' +
    formDivider() +
    checkboxRow("f-enabled", "Enabled", d.enabled !== false) +
    checkboxRow("f-autoDiscover", "Enable auto-discovery", d.autoDiscover !== false) +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to automatically query for DHCP updates (1–24 hours)</p></div>' +
    allowRebootFormHTML(d) +
    verboseLoggingFormHTML(d);
}

function fortiManagerFiltersHTML(defaults) {
  var d = defaults || {};
  var ifaceInclude = d.interfaceInclude || [];
  var ifaceExclude = d.interfaceExclude || [];
  var ifaceMode = ifaceInclude.length > 0 ? "include" : "exclude";
  var ifaceList = ifaceMode === "include" ? ifaceInclude : ifaceExclude;
  var dhcpIncludeList = d.dhcpInclude || [];
  var dhcpExcludeList = d.dhcpExclude || [];
  var dhcpMode = dhcpIncludeList.length > 0 ? "include" : "exclude";
  var dhcpIfaces = dhcpMode === "include" ? dhcpIncludeList : dhcpExcludeList;
  var invMode = (d.inventoryIncludeInterfaces && d.inventoryIncludeInterfaces.length > 0) ? "include" : "exclude";
  var invIfaces = invMode === "include" ? (d.inventoryIncludeInterfaces || []) : (d.inventoryExcludeInterfaces || []);
  var devMode = (d.deviceInclude && d.deviceInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.deviceInclude || []) : (d.deviceExclude || []);
  return sectionHeading("FortiGate Device Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these managed FortiGates from all discovery queries</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="2" placeholder="One per line — e.g. FG-HQ-01&#10;FG-DC-*&#10;*-lab">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to query all managed FortiGates. Matched against device name or hostname. Wildcards supported: <code>FG-*</code>, <code>*-lab</code>, <code>*dc*</code></p>' +
    '</div>' +
    formDivider() +
    sectionHeading("DHCP Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-dhcpMode" style="width:auto">' +
          '<option value="include"' + (dhcpMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (dhcpMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces from DHCP server scope discovery</span>' +
      '</div>' +
      '<textarea id="f-dhcpInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(dhcpIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Applies to DHCP server scope discovery only. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Interface Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-ifaceMode" style="width:auto">' +
          '<option value="include"' + (ifaceMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (ifaceMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces from interface IP discovery</span>' +
      '</div>' +
      '<textarea id="f-ifaceInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(ifaceList.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Applies to interface IP reservations only. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Device Inventory") +
    '<div class="form-group"><label>Interface Filter</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-inventoryMode" style="width:auto">' +
          '<option value="exclude"' + (invMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
          '<option value="include"' + (invMode === "include" ? " selected" : "") + '>Include</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">devices seen on these interfaces from asset discovery</span>' +
      '</div>' +
      '<textarea id="f-inventoryInterfaces" rows="2" placeholder="One per line — e.g. lan&#10;wifi*&#10;*guest">' + escapeHtml(invIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Wildcards supported: <code>port*</code>, <code>*lan</code>, <code>*mgmt*</code></p>' +
    '</div>';
}

// Flat-form fallback for any caller that wants the full FMG form in a single
// string. The Add and Edit modals split it into General + Filters tabs and
// call the two helpers above directly.
function fortiManagerFormHTML(defaults) {
  return fortiManagerGeneralHTML(defaults) + fortiManagerFiltersHTML(defaults);
}

function getFormConfig() {
  var port = document.getElementById("f-port").value;
  var dhcpMode = document.getElementById("f-dhcpMode").value;
  var dhcpIfaces = linesToArray("f-dhcpInterfaces");
  var ifaceMode = document.getElementById("f-ifaceMode").value;
  var ifaceIfaces = linesToArray("f-ifaceInterfaces");
  var invMode = document.getElementById("f-inventoryMode").value;
  var invIfaces = linesToArray("f-inventoryInterfaces");
  var devMode = document.getElementById("f-deviceMode").value;
  var devNames = linesToArray("f-deviceNames");
  // UI checkbox is inverted vs. the on-disk field: checked = direct, unchecked = proxy.
  var useDirect = document.getElementById("f-useDirect").checked;
  var useProxy = !useDirect;
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 443,
    apiUser: val("f-apiUser"),
    apiToken: val("f-apiToken"),
    adom: val("f-adom") || "root",
    verifySsl: document.getElementById("f-verifySsl").checked,
    mgmtInterface: val("f-mgmtInterface") || "",
    dhcpInclude: dhcpMode === "include" ? dhcpIfaces : [],
    dhcpExclude: dhcpMode === "exclude" ? dhcpIfaces : [],
    interfaceInclude: ifaceMode === "include" ? ifaceIfaces : [],
    interfaceExclude: ifaceMode === "exclude" ? ifaceIfaces : [],
    inventoryExcludeInterfaces: invMode === "exclude" ? invIfaces : [],
    inventoryIncludeInterfaces: invMode === "include" ? invIfaces : [],
    deviceInclude: devMode === "include" ? devNames : [],
    deviceExclude: devMode === "exclude" ? devNames : [],
    discoveryParallelism: (function () { var v = parseInt(val("f-discoveryParallelism"), 10); return Number.isFinite(v) && v >= 1 && v <= 20 ? v : (useProxy ? 1 : 5); })(),
    useProxy: useProxy,
    fortigateApiUser: val("f-fortigateApiUser"),
    fortigateApiToken: val("f-fortigateApiToken"),
    fortigateVerifySsl: (function () { var el = document.getElementById("f-fortigateVerifySsl"); return el ? el.checked : false; })(),
    allowReboot: readAllowRebootFromForm(),
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

// Standalone FortiGate "General" tab — connection settings + name + auto-
// discovery scheduling. Mirrors `fortiManagerGeneralHTML`'s split: filters
// move to a separate tab so the modal layout matches FMG.
function fortiGateGeneralHTML(defaults) {
  var d = defaults || {};
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Branch Office FortiGate"></div>' +
    infoBox('This integration connects <strong style="color:var(--color-text-primary)">directly to a standalone FortiGate</strong> (not managed by FortiManager). Requires an API administrator token created under <strong style="color:var(--color-text-primary)">System &gt; Administrators &gt; REST API Admin</strong>.') +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. fortigate.example.com"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 443) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group"><label>API User</label><input type="text" id="f-apiUser" value="' + escapeHtml(d.apiUser || "") + '" placeholder="e.g. api-admin"></div>' +
    '<div class="form-group"><label>API Token</label><input type="password" id="f-apiToken" value="' + (d.apiTokenPlaceholder ? "" : escapeHtml(d.apiToken || "")) + '" placeholder="' + (d.apiTokenPlaceholder || "Bearer token") + '"><p class="hint">Generate under System &gt; Administrators &gt; Create New &gt; REST API Admin</p></div>' +
    '<div class="form-group"><label>VDOM</label><input type="text" id="f-vdom" value="' + escapeHtml(d.vdom || "root") + '" placeholder="root"><p class="hint">Virtual Domain (leave as "root" for default)</p></div>' +
    '<div class="form-group"><label>Management Interface</label><input type="text" id="f-mgmtInterface" value="' + escapeHtml(d.mgmtInterface || "") + '" placeholder="e.g. port1, mgmt, loopback0"><p class="hint">Interface name used for FortiGate management traffic</p></div>' +
    checkboxRow("f-verifySsl", "Verify SSL certificate", d.verifySsl) +
    '<p class="hint" style="color:var(--color-warning)">Leave enabled. Disabling certificate verification lets a network attacker on the path intercept this connection and capture the API credentials. Disable only for a device with a self-signed certificate you cannot replace.</p>' +
    formDivider() +
    checkboxRow("f-enabled", "Enabled", d.enabled !== false) +
    checkboxRow("f-autoDiscover", "Enable auto-discovery", d.autoDiscover !== false) +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to automatically query for DHCP updates (1–24 hours)</p></div>' +
    allowRebootFormHTML(d) +
    verboseLoggingFormHTML(d);
}

// Standalone FortiGate "Filters" tab — DHCP server scope, interface IP
// reservation, and device inventory filters. Mirrors `fortiManagerFiltersHTML`
// minus the FortiGate device-name filter (single-device integration).
function fortiGateFiltersHTML(defaults) {
  var d = defaults || {};
  var dhcpMode = (d.dhcpInclude && d.dhcpInclude.length > 0) ? "include" : "exclude";
  var dhcpIfaces = dhcpMode === "include" ? (d.dhcpInclude || []) : (d.dhcpExclude || []);
  var ifaceMode = (d.interfaceInclude && d.interfaceInclude.length > 0) ? "include" : "exclude";
  var ifaceList = ifaceMode === "include" ? (d.interfaceInclude || []) : (d.interfaceExclude || []);
  var invMode = (d.inventoryIncludeInterfaces && d.inventoryIncludeInterfaces.length > 0) ? "include" : "exclude";
  var invIfaces = invMode === "include" ? (d.inventoryIncludeInterfaces || []) : (d.inventoryExcludeInterfaces || []);
  return sectionHeading("DHCP Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-dhcpMode" style="width:auto">' +
          '<option value="include"' + (dhcpMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (dhcpMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces from DHCP server scope discovery</span>' +
      '</div>' +
      '<textarea id="f-dhcpInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(dhcpIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Applies to DHCP server scope discovery only. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Interface Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-ifaceMode" style="width:auto">' +
          '<option value="include"' + (ifaceMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (ifaceMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these interfaces from interface IP discovery</span>' +
      '</div>' +
      '<textarea id="f-ifaceInterfaces" rows="2" placeholder="One per line — e.g. port1&#10;internal*&#10;*wan">' + escapeHtml(ifaceList.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Applies to interface IP reservations only. Wildcards supported: <code>port*</code>, <code>*wan</code>, <code>*mgmt*</code></p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Device Inventory") +
    '<div class="form-group"><label>Interface Filter</label>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-inventoryMode" style="width:auto">' +
          '<option value="exclude"' + (invMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
          '<option value="include"' + (invMode === "include" ? " selected" : "") + '>Include</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">devices seen on these interfaces from asset discovery</span>' +
      '</div>' +
      '<textarea id="f-inventoryInterfaces" rows="2" placeholder="One per line — e.g. lan&#10;wifi*&#10;*guest">' + escapeHtml(invIfaces.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to include all interfaces. Wildcards supported: <code>port*</code>, <code>*lan</code>, <code>*mgmt*</code></p>' +
    '</div>';
}

// Flat-form fallback for any caller that wants the full FortiGate form in a
// single string. Add and Edit modals split it into General + Filters tabs and
// call the two helpers above directly (matches the FMG rendering pattern).
function fortiGateFormHTML(defaults) {
  return fortiGateGeneralHTML(defaults) + fortiGateFiltersHTML(defaults);
}

function getFgtFormConfig() {
  var port = document.getElementById("f-port").value;
  var dhcpMode = document.getElementById("f-dhcpMode").value;
  var dhcpIfaces = linesToArray("f-dhcpInterfaces");
  var ifaceMode = document.getElementById("f-ifaceMode").value;
  var ifaceIfaces = linesToArray("f-ifaceInterfaces");
  var invMode = document.getElementById("f-inventoryMode").value;
  var invIfaces = linesToArray("f-inventoryInterfaces");
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 443,
    apiUser: val("f-apiUser"),
    apiToken: val("f-apiToken"),
    vdom: val("f-vdom") || "root",
    verifySsl: document.getElementById("f-verifySsl").checked,
    mgmtInterface: val("f-mgmtInterface") || "",
    dhcpInclude: dhcpMode === "include" ? dhcpIfaces : [],
    dhcpExclude: dhcpMode === "exclude" ? dhcpIfaces : [],
    interfaceInclude: ifaceMode === "include" ? ifaceIfaces : [],
    interfaceExclude: ifaceMode === "exclude" ? ifaceIfaces : [],
    inventoryExcludeInterfaces: invMode === "exclude" ? invIfaces : [],
    inventoryIncludeInterfaces: invMode === "include" ? invIfaces : [],
    allowReboot: readAllowRebootFromForm(),
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function windowsServerFormHTML(defaults) {
  var d = defaults || {};
  // A new integration defaults to HTTPS (re-scan F81); an existing one keeps
  // what it was saved with.
  var sslChecked = d.useSsl !== false ? "checked" : "";
  var enabledChecked = d.enabled !== false ? "checked" : "";
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. DC1 DHCP Server"></div>' +
    infoBox('Connects to <strong style="color:var(--color-text-primary)">Windows Server DHCP</strong> via WinRM (PowerShell remoting). Requires WinRM enabled on the target server (port <strong style="color:var(--color-text-primary)">5985</strong> HTTP or <strong style="color:var(--color-text-primary)">5986</strong> HTTPS).') +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. dhcp-server.example.com"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || (d.useSsl === false ? 5985 : 5986)) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group"><label>Username *</label><input type="text" id="f-username" value="' + escapeHtml(d.username || "") + '" placeholder="e.g. Administrator"></div>' +
    '<div class="form-group"><label>Password *</label><input type="password" id="f-password" value="' + (d.passwordPlaceholder ? "" : escapeHtml(d.password || "")) + '" placeholder="' + (d.passwordPlaceholder || "Password") + '"></div>' +
    '<div class="form-group"><label>Domain</label><input type="text" id="f-domain" value="' + escapeHtml(d.domain || "") + '" placeholder="e.g. CORP (optional)"><p class="hint">Active Directory domain for authentication (leave empty for local accounts)</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-useSsl" ' + sslChecked + ' style="width:auto">' +
      '<label for="f-useSsl" style="margin:0">Use SSL (HTTPS / port 5986)</label>' +
      '<p class="hint" style="margin:4px 0 0 0">Recommended. Over HTTP (port 5985) WinRM sends this account\'s password as Basic auth in clear text on every discovery.</p>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 4) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to automatically query for DHCP updates (1–24 hours)</p></div>' +
    formDivider() +
    sectionHeading("DHCP Scope Filtering") +
    '<div class="form-group"><label>Include Scopes</label><textarea id="f-dhcpInclude" rows="2" placeholder="One per line — scope name or ID&#10;e.g. 10.0.1.0">' + escapeHtml((d.dhcpInclude || []).join("\n")) + '</textarea><p class="hint">Only sync these DHCP scopes (leave empty to sync all)</p></div>' +
    '<div class="form-group"><label>Exclude Scopes</label><textarea id="f-dhcpExclude" rows="2" placeholder="One per line — scope name or ID&#10;e.g. lab-scope">' + escapeHtml((d.dhcpExclude || []).join("\n")) + '</textarea><p class="hint">Skip these DHCP scopes when syncing</p></div>' +
    verboseLoggingFormHTML(d);
}

function getWinFormConfig() {
  var port = document.getElementById("f-port").value;
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 5985,
    username: val("f-username"),
    password: val("f-password"),
    useSsl: document.getElementById("f-useSsl").checked,
    domain: val("f-domain"),
    dhcpInclude: linesToArray("f-dhcpInclude"),
    dhcpExclude: linesToArray("f-dhcpExclude"),
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function entraIdFormHTML(defaults) {
  var d = defaults || {};
  var devMode = (d.deviceInclude && d.deviceInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.deviceInclude || []) : (d.deviceExclude || []);
  var intuneChecked = d.enableIntune ? "checked" : "";
  var pullSoftware = d.pullSoftware === true;
  var includeDisabled = d.includeDisabled !== false;
  var decommissionMissing = d.decommissionMissing === true;
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Corporate Entra ID"></div>' +
    infoBox('Connects to <strong style="color:var(--color-text-primary)">Microsoft Entra ID</strong> (Azure AD) via an app registration with client-credentials flow. Requires <strong style="color:var(--color-text-primary)">Device.Read.All</strong> (application); add <strong style="color:var(--color-text-primary)">DeviceManagementManagedDevices.Read.All</strong> if Intune sync is enabled, and <strong style="color:var(--color-text-primary)">User.Read.All</strong> + <strong style="color:var(--color-text-primary)">Group.Read.All</strong> + <strong style="color:var(--color-text-primary)">OrgContact.Read.All</strong> (or <strong style="color:var(--color-text-primary)">Directory.Read.All</strong>) if you enable address-book directory search on the Directory tab. Grant admin consent in the Azure portal.') +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div class="form-group"><label>Tenant ID *</label><input type="text" id="f-tenantId" value="' + escapeHtml(d.tenantId || "") + '" placeholder="e.g. 00000000-0000-0000-0000-000000000000"><p class="hint">Directory (tenant) ID from Azure portal &gt; Entra ID &gt; Overview</p></div>' +
    '<div class="form-group"><label>Client ID *</label><input type="text" id="f-clientId" value="' + escapeHtml(d.clientId || "") + '" placeholder="e.g. 00000000-0000-0000-0000-000000000000"><p class="hint">Application (client) ID from App Registrations &gt; Overview</p></div>' +
    '<div class="form-group"><label>Client Secret *</label><input type="password" id="f-clientSecret" value="' + (d.clientSecretPlaceholder ? "" : escapeHtml(d.clientSecret || "")) + '" placeholder="' + (d.clientSecretPlaceholder || "Secret value") + '"><p class="hint">Generate under App Registrations &gt; Certificates &amp; secrets &gt; New client secret (save the Value, not the ID)</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enableIntune" ' + intuneChecked + ' style="width:auto">' +
      '<label for="f-enableIntune" style="margin:0">Enable Intune device sync</label>' +
    '</div>' +
    '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-top:0.5rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">When on, overlays richer data (serial, MAC, model, primary user, compliance) from <code>/deviceManagement/managedDevices</code> onto Entra devices. Requires an Intune license and the extra Graph permission above.</div>' +
    checkboxRow("f-pullSoftware", "Read installed software (Intune detected apps)", pullSoftware) +
    '<p class="hint">Lists each Intune device\'s detected apps and versions on its <strong>Software</strong> tab. Needs Intune device sync on and no extra permission. A device is re-read only after it checks in with Intune again, and skipped while a Polaris Agent on it reports its own list. Intune lists unmanaged apps only on <em>corporate-owned</em> devices.</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-includeDisabled" ' + (includeDisabled ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-includeDisabled" style="margin:0">Include disabled devices (as <em>disabled</em>)</label>' +
    '</div>' +
    checkboxRow("f-decommissionMissing", "Decommission devices that leave Entra ID", decommissionMissing) +
    '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-top:0.5rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">When on, an asset <strong style="color:var(--color-text-primary)">this integration manages</strong> is set to <em>decommissioned</em> once its device record is deleted from the tenant or disabled there — other sources still describing it do not keep it active. Assets managed by another integration are never touched. A partial, cancelled or empty read, a change to the device filter, and any run that would decommission an implausibly large share of the fleet are all refused and logged instead.</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to automatically query Graph for device updates (1–24 hours)</p></div>' +
    formDivider() +
    sectionHeading("Device Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these devices by display name</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="2" placeholder="One per line — e.g. LAPTOP-*&#10;SRV-HQ-*&#10;*-lab">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to sync every device. Wildcards supported: <code>LAPTOP-*</code>, <code>*-lab</code>, <code>*pc*</code></p>' +
    '</div>' +
    verboseLoggingFormHTML(d);
}

function getEntraFormConfig() {
  var devMode = document.getElementById("f-deviceMode").value;
  var devNames = linesToArray("f-deviceNames");
  return {
    tenantId: val("f-tenantId"),
    clientId: val("f-clientId"),
    clientSecret: val("f-clientSecret"),
    enableIntune: document.getElementById("f-enableIntune").checked,
    pullSoftware: document.getElementById("f-pullSoftware").checked,
    includeDisabled: document.getElementById("f-includeDisabled").checked,
    decommissionMissing: document.getElementById("f-decommissionMissing").checked,
    deviceInclude: devMode === "include" ? devNames : [],
    deviceExclude: devMode === "exclude" ? devNames : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function activeDirectoryFormHTML(defaults) {
  var d = defaults || {};
  var useLdaps = d.useLdaps !== false;
  var verifyTls = !!d.verifyTls;
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  var scope = d.searchScope || "sub";
  var includeDisabled = d.includeDisabled !== false;
  var decommissionMissing = d.decommissionMissing === true;
  var devMode = (d.ouInclude && d.ouInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.ouInclude || []) : (d.ouExclude || []);
  var defaultPort = useLdaps ? 636 : 389;
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Corp AD — DC01"></div>' +
    infoBox('Connects to an <strong style="color:var(--color-text-primary)">on-premise Active Directory</strong> domain controller via LDAP simple bind. Produces assets only. Hybrid-joined devices are cross-linked to the Entra ID integration via on-prem SID, so the same device never appears twice.') +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. dc01.corp.local"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || defaultPort) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    checkboxRow("f-useLdaps", "Use LDAPS (TLS)", useLdaps) +
    checkboxRow("f-verifyTls", "Verify TLS certificate", verifyTls) +
    '<p class="hint" style="color:var(--color-warning)">Leave enabled. Disabling certificate verification lets a network attacker intercept the LDAPS connection and capture the bind credentials. Disable only for a domain controller with a self-signed certificate you cannot replace.</p>' +
    '<div class="form-group"><label>Bind DN *</label><input type="text" id="f-bindDn" value="' + escapeHtml(d.bindDn || "") + '" placeholder="e.g. CN=polaris-svc,OU=Service Accounts,DC=corp,DC=local"><p class="hint">Distinguished name of the bind account. A read-only domain user is sufficient.</p></div>' +
    '<div class="form-group"><label>Bind Password *</label><input type="password" id="f-bindPassword" value="' + (d.bindPasswordPlaceholder ? "" : escapeHtml(d.bindPassword || "")) + '" placeholder="' + (d.bindPasswordPlaceholder || "Password") + '"></div>' +
    '<div class="form-group"><label>Base DN *</label><input type="text" id="f-baseDn" value="' + escapeHtml(d.baseDn || "") + '" placeholder="e.g. DC=corp,DC=local"><p class="hint">Subtree to search for computer objects. Narrow this (e.g. <code>OU=Workstations,DC=corp,DC=local</code>) if you only want part of the directory.</p></div>' +
    '<div class="form-group"><label>Search Scope</label>' +
      '<select id="f-searchScope" style="width:auto">' +
        '<option value="sub"' + (scope === "sub" ? " selected" : "") + '>Subtree (recursive)</option>' +
        '<option value="one"' + (scope === "one" ? " selected" : "") + '>One level (immediate children only)</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-includeDisabled" ' + (includeDisabled ? "checked" : "") + ' style="width:auto">' +
      '<label for="f-includeDisabled" style="margin:0">Include disabled computer accounts (as <em>disabled</em>)</label>' +
    '</div>' +
    checkboxRow("f-decommissionMissing", "Decommission computers that leave the directory", decommissionMissing) +
    '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-top:0.5rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">When on, an asset <strong style="color:var(--color-text-primary)">this integration manages</strong> is set to <em>decommissioned</em> once its computer object is deleted from the directory or disabled there — other sources still describing it do not keep it active. Assets managed by another integration are never touched. A partial, cancelled or empty search, a change to the base DN scope or OU filter, and any run that would decommission an implausibly large share of the fleet are all refused and logged instead.</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to re-query AD for device updates (1–24 hours)</p></div>' +
    formDivider() +
    sectionHeading("OU Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these OUs (matched against distinguished name)</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="3" placeholder="One per line — e.g.&#10;*OU=Workstations*&#10;*OU=Servers,OU=HQ*">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to sync all computers under the base DN. Each line is matched against the computer\'s full distinguished name. Wildcards: <code>*OU=Workstations*</code>, <code>*OU=Servers,OU=HQ*</code></p>' +
    '</div>' +
    verboseLoggingFormHTML(d);
}

function getAdFormConfig() {
  var port = document.getElementById("f-port").value;
  var devMode = document.getElementById("f-deviceMode").value;
  var devNames = linesToArray("f-deviceNames");
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 636,
    useLdaps: document.getElementById("f-useLdaps").checked,
    verifyTls: document.getElementById("f-verifyTls").checked,
    bindDn: val("f-bindDn"),
    bindPassword: val("f-bindPassword"),
    baseDn: val("f-baseDn"),
    searchScope: document.getElementById("f-searchScope").value === "one" ? "one" : "sub",
    includeDisabled: document.getElementById("f-includeDisabled").checked,
    decommissionMissing: document.getElementById("f-decommissionMissing").checked,
    ouInclude: devMode === "include" ? devNames : [],
    ouExclude: devMode === "exclude" ? devNames : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function linesToArray(id) {
  return document.getElementById(id).value.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
}

// Azure Arc General tab.
//
// Arc gets a fuller setup block than the other types, on purpose: its two most
// common misconfigurations both fail SILENTLY. A missing Reader role returns a
// smaller machine roster rather than a 403 (Resource Graph only ever returns
// what the principal can already read), and an unregistered
// Microsoft.HybridCompute provider returns a bare 404. Neither is guessable
// from the error, so the steps + the two callouts below carry the operator
// through the Azure-side prerequisites before they hit Test Connection.
//
// Arc is also the first type with TWO independent filter axes (resource group
// AND Azure tags), so it deliberately does NOT reuse the shared
// f-deviceMode / f-deviceNames pair every single-axis type shares — each axis
// gets its own ids or the two clobber each other on read.
function azureArcFormHTML(defaults) {
  var d = defaults || {};
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  var argChecked = d.useResourceGraph !== false ? "checked" : "";
  var inclDisc = d.includeDisconnected !== false;
  var netProfile = d.fetchNetworkProfile === true;
  var vmInst = d.enableVmInstances === true;
  var sqlSrv = d.enableSqlServer === true;
  var k8s = d.enableKubernetes === true;
  var importTags = d.importAzureTags === true;
  var pullSoftware = d.pullSoftware === true;

  var rgMode = (d.resourceGroupInclude && d.resourceGroupInclude.length > 0) ? "include" : "exclude";
  var rgNames = rgMode === "include" ? (d.resourceGroupInclude || []) : (d.resourceGroupExclude || []);
  var devMode = (d.deviceInclude && d.deviceInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.deviceInclude || []) : (d.deviceExclude || []);
  var tagMode = (d.tagInclude && d.tagInclude.length > 0) ? "include" : "exclude";
  var tagLines = tagMode === "include" ? (d.tagInclude || []) : (d.tagExclude || []);

  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Azure Arc — Production"></div>' +
    infoBox('Connects to <strong style="color:var(--color-text-primary)">Azure Arc</strong> through an Entra app registration using the client-credentials flow against <strong style="color:var(--color-text-primary)">Azure Resource Manager</strong>. Discovers Arc-enabled servers (<code>Microsoft.HybridCompute/machines</code>) as assets — no subnets or reservations. Machines merge with assets already discovered by Entra ID, Active Directory and vCenter. <strong style="color:var(--color-text-primary)">No Microsoft Graph permissions are needed</strong> — this is an ARM-only integration, which is the step most often carried over by mistake from an Entra ID setup.') +
    formDivider() +
    sectionHeading("Azure Setup") +
    '<p class="hint" style="margin:0 0 0.5rem 0">Complete these in the Azure portal before testing the connection:</p>' +
    '<ul style="margin:0 0 0.75rem 1.2rem;padding:0;font-size:0.85rem;line-height:1.6">' +
      '<li>Register an application under <strong>Entra ID &rarr; App registrations</strong>, and copy its <strong>Directory (tenant) ID</strong> and <strong>Application (client) ID</strong>.</li>' +
      '<li>Under <strong>Certificates &amp; secrets &rarr; New client secret</strong>, create a secret and copy the <strong>Value</strong> (not the Secret ID — the Value is shown only once). ' +
        'Note its <strong>expiry date</strong> and set yourself a reminder: when it lapses, discovery stops with an authentication error that never mentions expiry.</li>' +
      '<li>Assign that app\'s service principal the <strong>Reader</strong> role &mdash; on the management group above your subscriptions for full coverage, or on each subscription individually. ' +
        'The service principal is the app\'s entry under <strong>Entra ID &rarr; Enterprise applications</strong>; when selecting it in <strong>Access control (IAM)</strong>, search by the <strong>Application (client) ID</strong> rather than the display name, which can collide.</li>' +
      '<li>Confirm the <strong><code>Microsoft.HybridCompute</code></strong> resource provider is registered in each subscription (<strong>Subscription &rarr; Settings &rarr; Resource providers</strong>).</li>' +
      '<li>Paste the three values below, then press <strong>Test Connection</strong> — it reports how many subscriptions this app can actually see.</li>' +
    '</ul>' +
    calloutHTML("warning", "Partial Reader means a partial roster",
      "Azure returns only the resources this app is allowed to read, so a missing role assignment yields <em>fewer machines</em> — never an access-denied error. If Test Connection reports fewer subscriptions than you expect, check the Reader assignment first; nothing else will tell you.") +
    (d.allowRunCommand === true
      ? calloutHTML("warning", "This integration can write to Azure",
          "Script publishing is <strong>on</strong>, so this is no longer a read-only integration: Polaris can create Run Commands, which execute as root/SYSTEM on machines you select. Discovery itself still needs only <strong>Reader</strong> — the additional role that grants execution is described on the <strong>Script Publishing</strong> tab. Turn that toggle off and Reader alone is sufficient again.")
      : calloutHTML("tip", "Read-only unless you enable script publishing",
          "As configured, Polaris only reads from Azure and <strong>Reader</strong> is sufficient — don't grant anything broader. The one exception is the <strong>Script Publishing</strong> tab: turning it on lets Polaris run the onboarding script on Arc machines, which needs an additional role and is described there.")) +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div class="form-group"><label>Tenant ID *</label><input type="text" id="f-tenantId" value="' + escapeHtml(d.tenantId || "") + '" placeholder="e.g. 00000000-0000-0000-0000-000000000000"><p class="hint">Directory (tenant) ID from Azure portal &gt; Entra ID &gt; Overview</p></div>' +
    '<div class="form-group"><label>Client ID *</label><input type="text" id="f-clientId" value="' + escapeHtml(d.clientId || "") + '" placeholder="e.g. 00000000-0000-0000-0000-000000000000"><p class="hint">Application (client) ID from App Registrations &gt; Overview</p></div>' +
    '<div class="form-group"><label>Client Secret *</label><input type="password" id="f-clientSecret" value="' + (d.clientSecretPlaceholder ? "" : escapeHtml(d.clientSecret || "")) + '" placeholder="' + (d.clientSecretPlaceholder || "Secret value") + '"><p class="hint">This is a separate secret from any Entra ID integration — reuse one app registration only if you have granted it both Graph and ARM access.</p></div>' +
    '<div class="form-group"><label>Subscriptions</label><textarea id="f-subscriptionIds" rows="3" placeholder="One subscription ID per line — e.g.&#10;00000000-0000-0000-0000-000000000000">' + escapeHtml((d.subscriptionInclude || []).join("\n")) + '</textarea><p class="hint">One subscription ID per line; the app needs the <strong>Reader</strong> role on each. Leave empty to discover every subscription the app can see — listing them explicitly keeps each run bounded and predictable.</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-useResourceGraph" ' + argChecked + ' style="width:auto">' +
      '<label for="f-useResourceGraph" style="margin:0">Query via Azure Resource Graph</label>' +
    '</div>' +
    '<p class="hint">One query covers every subscription instead of one call each — much lighter on a large tenant. Polaris falls back to a per-subscription list automatically if Resource Graph is unavailable. Resource Graph is an indexed snapshot that can trail Azure by a minute or two, which does not matter on a multi-hour discovery interval.</p>' +
    checkboxRow("f-includeDisconnected", "Include disconnected machines", inclDisc) +
    '<p class="hint">A <em>Disconnected</em> or <em>Expired</em> Arc agent means Azure stopped hearing from the host — a reachability signal, not a lifecycle one. Polaris keeps those machines as assets and tags them <code>arc-disconnected</code>; it never decommissions on this signal.</p>' +
    checkboxRow("f-arcDecommissionMissing", "Decommission machines that leave Azure Arc", d.decommissionMissing === true) +
    '<div style="background:color-mix(in srgb, var(--color-accent) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-accent) 20%, transparent);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-top:0.5rem;margin-bottom:1rem;font-size:0.82rem;color:var(--color-text-secondary);line-height:1.5">When on, an asset <strong style="color:var(--color-text-primary)">this integration manages</strong> is set to <em>decommissioned</em> once its machine or cluster resource is deleted from Azure — other sources still describing it do not keep it active — and its <code>azure:</code> tags are removed. A disconnected agent is never a reason. Assets managed by another integration are never touched. A partial, cancelled or empty read, a subscription that could not be read, a single-machine run, and any run that would decommission an implausibly large share of the fleet are all refused and logged instead.</div>' +
    checkboxRow("f-fetchNetworkProfile", "Fetch IP addresses for each machine", netProfile) +
    '<p class="hint" style="color:var(--color-warning)">Costs <strong>one extra Azure request per machine</strong> — on a large fleet that is thousands of calls per discovery run against a rate-limited API. Polaris caps the concurrency and stops the pass at a deadline (reporting what it skipped), but leave this off unless you actually need Arc-sourced IPs.</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to re-query Azure Resource Manager for Arc machine updates (1–24 hours)</p></div>' +
    formDivider() +
    sectionHeading("Additional Arc Resources") +
    '<p class="hint" style="margin:0 0 0.5rem 0">Each option below adds <strong>one</strong> extra Azure query per discovery run for the whole tenant &mdash; not one per machine. Neither creates new devices in Polaris; both attach detail to the Arc machines already discovered.</p>' +
    checkboxRow("f-enableVmInstances", "Collect Arc-enabled VMware / SCVMM placement", vmInst) +
    '<p class="hint">Records which virtualization platform each machine runs on, plus its vCenter/SCVMM identifiers. Also improves matching against an existing VMware vCenter integration: the reported <code>instanceUuid</code> is the exact key vCenter discovery uses, so machines merge onto their existing VM record instead of appearing twice.</p>' +
    checkboxRow("f-enableSqlServer", "Collect Arc-enabled SQL Server instances", sqlSrv) +
    '<p class="hint">Attaches each machine\'s SQL Server instances (edition, version, patch level, licence type) to that machine and tags it <code>arc-sql</code>. SQL instances are recorded as detail on the host &mdash; they never become separate devices.</p>' +
    checkboxRow("f-enableKubernetes", "Discover Arc-enabled Kubernetes clusters", k8s) +
    '<p class="hint" style="color:var(--color-warning)">Unlike the two options above, this one <strong>adds devices</strong>: each connected cluster becomes its own asset of type <em>Kubernetes Cluster</em>, with its own subtab on the Monitoring tab. A cluster is monitored as a single endpoint &mdash; no agent, no interfaces, no storage.</p>' +
    calloutHTML("note", "Requires Resource Graph",
      "Both options are read through Azure Resource Graph, which is what keeps them to one query each. If <em>Query via Azure Resource Graph</em> above is off &mdash; or Resource Graph is unavailable in your tenant &mdash; the discovery run skips this enrichment and says so in its log rather than falling back to a far more expensive per-machine read.") +
    formDivider() +
    sectionHeading("Resource Group Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-rgMode" style="width:auto">' +
          '<option value="include"' + (rgMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (rgMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these resource groups</span>' +
      '</div>' +
      '<textarea id="f-rgNames" rows="2" placeholder="One per line — e.g.&#10;rg-prod-*&#10;*-lab">' + escapeHtml(rgNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to sync machines in every resource group. Wildcards supported: <code>rg-prod-*</code>, <code>*-lab</code>, <code>*sql*</code></p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Machine Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these machines by name</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="2" placeholder="One per line — e.g.&#10;SRV-*&#10;*-lab">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Matched against the machine\'s Azure display name. Leave empty to sync every machine.</p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Tag Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-tagMode" style="width:auto">' +
          '<option value="include"' + (tagMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (tagMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">machines carrying these Azure tags</span>' +
      '</div>' +
      '<textarea id="f-tagFilters" rows="2" placeholder="One per line — key=value&#10;e.g. env=prod&#10;managedBy=*">' + escapeHtml(tagLines.join("\n")) + '</textarea>' +
      '<p class="hint">Each line is <code>key=value</code>; use <code>key=*</code> to match any value of that tag, and wildcards work on the value (<code>env=prod*</code>). <strong>Include</strong> keeps only machines matching at least one line; <strong>Exclude</strong> drops machines matching any. This filter decides which machines are discovered; to copy the tags themselves onto devices, use <em>Azure Tags</em> below.</p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Azure Tags") +
    checkboxRow("f-importAzureTags", "Add Azure tags to devices", importTags) +
    '<p class="hint">Each Azure resource tag becomes a Polaris tag named <code>azure:Key=Value</code> (e.g. <code>azure:DefenderPlan=P1</code>) on the machine or cluster that carries it. They show on the device and can be filtered and searched like any tag, but the tag picker never offers them, so nobody can put an Azure tag on a device that does not carry it in Azure. Polaris keeps them in step with Azure on every discovery run: a tag removed or changed in Azure is removed or changed here. Turn this off and the next run takes them all back off. Tags you add by hand are never touched.</p>' +
    '<div class="form-group"><label>Tag keys to add</label>' +
      '<textarea id="f-azureTagKeys" rows="2" placeholder="One key per line — e.g.&#10;DefenderPlan&#10;Environment&#10;Cost*">' + escapeHtml((d.azureTagKeys || []).join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to add every key. Listing the keys you care about keeps tags that differ on every machine (a creation date, an owner email) from filling the tag list. Matching ignores case; wildcards work (<code>Cost*</code>).</p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Installed Software") +
    checkboxRow("f-pullSoftware", "Read installed software from Change Tracking", pullSoftware) +
    '<p class="hint">Lists each Arc machine\'s installed programs and versions on its <strong>Software</strong> tab, read from the Log Analytics workspaces where <strong>Azure Change Tracking &amp; Inventory</strong> stores them (the <code>ConfigurationData</code> table). Change Tracking must already be enabled on the machines. Grant this app the <strong>Log Analytics Reader</strong> role on each workspace listed below &mdash; Reader on the subscription does not cover workspace data. An uninstalled program can stay listed for up to three days.</p>' +
    '<div class="form-group"><label>Log Analytics workspace IDs</label>' +
      '<textarea id="f-logAnalyticsWorkspaceIds" rows="2" placeholder="One workspace ID per line — e.g.&#10;00000000-0000-0000-0000-000000000000">' + escapeHtml((d.logAnalyticsWorkspaceIds || []).join("\n")) + '</textarea>' +
      '<p class="hint">The <strong>Workspace ID</strong> GUID from the workspace\'s Overview page (not its resource ID). Up to 20.</p>' +
    '</div>' +
    verboseLoggingFormHTML(d);
}

function getArcFormConfig() {
  var rgMode = document.getElementById("f-rgMode").value;
  var rgNames = linesToArray("f-rgNames");
  var devMode = document.getElementById("f-deviceMode").value;
  var devNames = linesToArray("f-deviceNames");
  var tagMode = document.getElementById("f-tagMode").value;
  var tagLines = linesToArray("f-tagFilters");
  return {
    tenantId: val("f-tenantId"),
    clientId: val("f-clientId"),
    clientSecret: val("f-clientSecret"),
    subscriptionInclude: linesToArray("f-subscriptionIds"),
    useResourceGraph: document.getElementById("f-useResourceGraph").checked,
    includeDisconnected: document.getElementById("f-includeDisconnected").checked,
    decommissionMissing: document.getElementById("f-arcDecommissionMissing").checked,
    fetchNetworkProfile: document.getElementById("f-fetchNetworkProfile").checked,
    enableVmInstances: document.getElementById("f-enableVmInstances").checked,
    enableSqlServer: document.getElementById("f-enableSqlServer").checked,
    enableKubernetes: document.getElementById("f-enableKubernetes").checked,
    importAzureTags: document.getElementById("f-importAzureTags").checked,
    azureTagKeys: linesToArray("f-azureTagKeys"),
    pullSoftware: document.getElementById("f-pullSoftware").checked,
    logAnalyticsWorkspaceIds: linesToArray("f-logAnalyticsWorkspaceIds"),
    resourceGroupInclude: rgMode === "include" ? rgNames : [],
    resourceGroupExclude: rgMode === "exclude" ? rgNames : [],
    deviceInclude: devMode === "include" ? devNames : [],
    deviceExclude: devMode === "exclude" ? devNames : [],
    tagInclude: tagMode === "include" ? tagLines : [],
    tagExclude: tagMode === "exclude" ? tagLines : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

// ─── AI Assistant integration (business rule 95) ─────────────────────────────
//
// A flat, untabbed form: the integration discovers nothing and monitors
// nothing — it is the model behind the floating assistant. Creating one also
// mints a read-only role + API token (shown once by _showLlmAccessModal).
// `f-pollInterval` is a hidden field only because the shared create / save
// paths read it for every type.
function llmFormHTML(defaults) {
  var d = defaults || {};
  var azure = d.provider === "azure";
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var timeoutSec = Math.round((d.requestTimeoutMs || 120000) / 1000);
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Ollama on gpu-01"></div>' +
    '<div class="form-group"><label>Assistant name</label><input type="text" id="f-displayName" maxlength="40" value="' + escapeHtml(d.displayName || "") + '" placeholder="Assistant"><p class="hint">What people see in the chat window — its title, the button\'s tooltip and the greeting. The model is told to answer to it too.</p></div>' +
    infoBox('Connects the <strong style="color:var(--color-text-primary)">AI assistant</strong> (the chat button in the bottom-right corner) to a model server. Any <strong style="color:var(--color-text-primary)">OpenAI-compatible</strong> endpoint you run works — Ollama, LM Studio, vLLM, the llama.cpp server, LocalAI or Open WebUI — or an <strong style="color:var(--color-text-primary)">Azure AI Foundry</strong> GPT deployment. Pick a model that supports <strong style="color:var(--color-text-primary)">tool calling</strong> (for example Qwen 2.5 / 3, Llama 3.1+ or Mistral Small), or the assistant can chat but cannot look anything up.') +
    calloutHTML("note", "Lookups use each person's own permissions",
      'When someone asks the assistant a question, Polaris runs every lookup with <strong>that person\'s</strong> role, so the assistant can never show them more than their role already allows. It is read-only: it cannot change, acknowledge or push anything.') +
    formDivider() +
    sectionHeading("Model Server") +
    // Provider (rule 95(j)): "openai" is any OpenAI-compatible server — the
    // default, and what every row made before Azure support is. "azure" is
    // Azure AI Foundry; _applyLlmProvider shows / hides the fields per choice.
    // Every field below is in the DOM for both providers and read by
    // getLlmFormConfig, so a hidden one is never stripped on save.
    '<div class="form-group"><label>Provider</label><select id="f-llmProvider">' +
      '<option value="openai"' + (azure ? "" : " selected") + '>Local / OpenAI-compatible (Ollama, LM Studio, vLLM…)</option>' +
      '<option value="azure"' + (azure ? " selected" : "") + '>Azure AI Foundry (Azure OpenAI deployment)</option>' +
    '</select></div>' +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label id="f-host-label">' + (azure ? "Endpoint *" : "Host / IP *") + '</label><input type="text" id="f-host" value="' + escapeHtml(azure ? _llmAzureEndpointText(d) : (d.host || "")) + '" placeholder="' + (azure ? "https://my-resource.openai.azure.com" : "e.g. 10.1.5.20 or llm.example.com") + '"></div>' +
      '<div class="form-group llm-openai-only"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 11434) + '" min="1" max="65535" style="width:100px"></div>' +
    '</div>' +
    '<div class="llm-openai-only">' +
      '<div class="form-group"><label>API path</label><input type="text" id="f-basePath" value="' + escapeHtml(d.basePath != null ? d.basePath : "/v1") + '" placeholder="/v1"><p class="hint"><code>/v1</code> for Ollama, LM Studio, vLLM and llama.cpp; <code>/api</code> for Open WebUI.</p></div>' +
      checkboxRow("f-useHttps", "Use HTTPS", d.useHttps === true) +
    '</div>' +
    checkboxRow("f-verifySsl", "Verify TLS certificate", d.verifySsl !== false) +
    '<div class="llm-azure-only">' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<div class="form-group"><label>API shape</label><select id="f-azureApiShape">' +
          '<option value="v1"' + (d.azureApiShape === "deployments" || d.azureApiShape === "anthropic" ? "" : " selected") + '>GPT — v1 (/openai/v1)</option>' +
          '<option value="deployments"' + (d.azureApiShape === "deployments" ? " selected" : "") + '>GPT — deployments (dated api-version)</option>' +
          '<option value="anthropic"' + (d.azureApiShape === "anthropic" ? " selected" : "") + '>Claude (Anthropic Messages API)</option>' +
        '</select></div>' +
        '<div class="form-group" id="f-azureApiVersion-group"><label>API version</label><input type="text" id="f-azureApiVersion" value="' + escapeHtml(d.azureApiVersion || "2024-10-21") + '" placeholder="2024-10-21"></div>' +
      '</div>' +
      '<div class="form-group"><label>Authentication</label><select id="f-azureAuth">' +
        '<option value="apiKey"' + (d.azureAuth === "entra" ? "" : " selected") + '>API key</option>' +
        '<option value="entra"' + (d.azureAuth === "entra" ? " selected" : "") + '>Entra ID app (service principal)</option>' +
      '</select></div>' +
      '<div class="llm-entra-only">' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
          '<div class="form-group"><label>Tenant ID *</label><input type="text" id="f-tenantId" value="' + escapeHtml(d.tenantId || "") + '" placeholder="Directory (tenant) ID"></div>' +
          '<div class="form-group"><label>Client ID *</label><input type="text" id="f-clientId" value="' + escapeHtml(d.clientId || "") + '" placeholder="Application (client) ID"></div>' +
        '</div>' +
        '<div class="form-group"><label>Client secret *</label><input type="password" id="f-clientSecret" value="" placeholder="' + escapeHtml(d.clientSecretPlaceholder || "The app registration's client secret") + '" autocomplete="new-password"><p class="hint">Stored encrypted. Give the app\'s service principal the <strong>Cognitive Services OpenAI User</strong> role on the Azure OpenAI / Foundry resource.</p></div>' +
        '<div class="form-group"><label>Token scope</label><input type="text" id="f-azureScope" value="' + escapeHtml(d.azureScope || "") + '" placeholder="Default for the API shape"><p class="hint">Advanced — leave blank for the default: <code>https://cognitiveservices.azure.com/.default</code> for GPT, <code>https://ai.azure.com/.default</code> for Claude.</p></div>' +
      '</div>' +
    '</div>' +
    '<div class="form-group" id="f-apiToken-group"><label id="f-apiToken-label">' + (azure ? "API key *" : "API key") + '</label><input type="password" id="f-apiToken" value="" placeholder="' + escapeHtml(d.apiTokenPlaceholder || "Optional — only if the server requires one") + '" autocomplete="new-password"><p class="hint" id="f-apiToken-hint">' + (azure ? "Stored encrypted. Key 1 or Key 2 from the resource's Keys and Endpoint page." : "Stored encrypted. Ollama and LM Studio need none by default.") + '</p></div>' +
    '<div class="form-group"><label id="f-model-label">' + (azure ? "Deployment name *" : "Model") + '</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="text" id="f-model" value="' + escapeHtml(d.model || "") + '" placeholder="' + (azure ? "The deployment name, not the model name" : "Blank = the server\'s first tool-calling model") + '" style="flex:1">' +
        '<select id="f-model-select" style="flex:1;display:none" aria-label="Model"></select>' +
        '<button type="button" class="btn btn-secondary btn-sm llm-openai-only" id="f-llm-load" style="white-space:nowrap">Load models</button>' +
      '</div>' +
      '<div id="f-llm-model-status" class="hint" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">Load the server\'s models (Test Connection does too) to pick one and see which support tool calling.</div>' +
    '</div>' +
    '<div class="form-group llm-azure-only" id="f-omitTemperature-group">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<input type="checkbox" id="f-omitTemperature"' + (d.omitTemperature === true ? " checked" : "") + ' style="width:auto">' +
        '<label for="f-omitTemperature" style="margin:0">Omit temperature (reasoning models such as o-series and gpt-5)</label>' +
      '</div>' +
      '<p class="hint">If a deployment refuses <code>temperature</code>, Polaris retries once without it anyway — tick this to skip that first attempt.</p>' +
    '</div>' +
    // Rule 95(l). Never saved yet (d.acceptsImages undefined) the box follows
    // the provider — on for a Claude deployment — until it is clicked
    // (_applyLlmProvider reads data-auto); once saved, it is what was saved.
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<input type="checkbox" id="f-acceptsImages"' +
          (typeof d.acceptsImages === "boolean"
            ? (d.acceptsImages ? " checked" : "")
            : ' data-auto="1"' + (azure && d.azureApiShape === "anthropic" ? " checked" : "")) +
          ' style="width:auto">' +
        '<label for="f-acceptsImages" style="margin:0">Accepts images (people can paste screenshots into the chat)</label>' +
      '</div>' +
      '<p class="hint">Tick only for a model that can read images — every Claude model, GPT-4o and later, or a vision model such as <code>qwen2.5vl</code> or <code>llama3.2-vision</code> on Ollama. A text-only model refuses them.</p>' +
    '</div>' +
    // Not checkboxRow(): the note must sit inside the same .form-group,
    // because `.hint` is only styled there (`.form-group .hint`).
    '<div class="form-group llm-openai-only">' +
      '<div style="display:flex;align-items:center;gap:8px">' +
        '<input type="checkbox" id="f-allowLoopback"' + (d.allowLoopback === true ? " checked" : "") + ' style="width:auto">' +
        '<label for="f-allowLoopback" style="margin:0">Allow loopback (the model server runs on this Polaris host)</label>' +
      '</div>' +
      '<p class="hint">Only <code>localhost</code> / <code>127.x</code> / <code>::1</code>. Leave off unless the server really is local — in a container, use the host\'s LAN address instead.</p>' +
    '</div>' +
    formDivider() +
    sectionHeading("Assistant Behaviour") +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<div class="form-group"><label>Temperature</label><input type="number" id="f-temperature" value="' + (d.temperature != null ? d.temperature : 0.2) + '" min="0" max="2" step="0.1"><p class="hint">Low keeps answers factual.</p></div>' +
      '<div class="form-group"><label>Lookup rounds per answer</label><input type="number" id="f-maxToolRounds" value="' + (d.maxToolRounds || 6) + '" min="1" max="12"></div>' +
      '<div class="form-group"><label>Rows per lookup</label><input type="number" id="f-maxRowsPerTool" value="' + (d.maxRowsPerTool || 200) + '" min="10" max="1000"><p class="hint">Reports go up to 5,000 regardless.</p></div>' +
      '<div class="form-group"><label>Messages of history sent</label><input type="number" id="f-contextMessages" value="' + (d.contextMessages || 20) + '" min="2" max="100"><p class="hint">At most — older ones are dropped first when they would not fit the context window.</p></div>' +
      '<div class="form-group"><label>Context window</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-contextWindow" value="' + (d.contextWindow || 8192) + '" min="2048" max="1000000" step="1024" style="width:110px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">tokens</span></div><p class="hint" id="f-contextWindow-hint">' + _llmContextWindowHint(azure) + '</p></div>' +
      '<div class="form-group"><label>Response timeout</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-requestTimeoutSec" value="' + timeoutSec + '" min="5" max="600" style="width:90px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">seconds idle</span></div></div>' +
      '<div class="form-group"><label>Start a fresh chat after</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-idleResetMinutes" value="' + (d.idleResetMinutes != null ? d.idleResetMinutes : 30) + '" min="0" max="1440" style="width:90px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">minutes idle</span></div><p class="hint">A conversation nobody has used for this long is saved and set aside; the chat opens fresh, and <code>/resume</code> or History brings it back. 0 = never.</p></div>' +
    '</div>' +
    '<div class="form-group"><label>Extra instructions</label><textarea id="f-systemPromptExtra" rows="3" maxlength="4000" placeholder="Optional — e.g. site naming conventions, who to escalate to">' + escapeHtml(d.systemPromptExtra || "") + '</textarea></div>' +
    // Not part of this integration's config: one server-wide setting (PUT
    // /assistant/settings), filled in by _wireLlmForm and saved by
    // _saveLlmRetention after the integration itself saves.
    '<div class="form-group"><label>Keep conversations for</label>' +
      '<div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-assistantRetentionDays" value="" min="1" max="3650" style="width:90px" disabled><span style="color:var(--color-text-tertiary);font-size:0.85rem">days</span></div>' +
      '<p class="hint" id="f-assistantRetentionHint">Applies to every assistant on this install. Each person\'s saved chats are deleted this long after their last message.</p>' +
    '</div>' +
    formDivider() +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<input type="hidden" id="f-pollInterval" value="' + (d.pollInterval || 12) + '">' +
    (d.roleName
      ? infoBox('API access for the model server: role <strong style="color:var(--color-text-primary)">' + escapeHtml(d.roleName) + '</strong> (read-only). Use <em>Regenerate Token</em> on the card to issue a new token.')
      : infoBox('Creating this integration also creates a <strong style="color:var(--color-text-primary)">read-only role</strong> and an <strong style="color:var(--color-text-primary)">API token</strong> the model server can use for its own lookups. The token is shown once. Needs Roles and API Tokens Read-Write.')) +
    verboseLoggingFormHTML(d);
}

function getLlmFormConfig() {
  function num(id, fallback) {
    var el = document.getElementById(id);
    var n = el ? parseFloat(el.value) : NaN;
    return isNaN(n) ? fallback : n;
  }
  var provider = val("f-llmProvider") === "azure" ? "azure" : "openai";
  var cfg = {
    provider: provider,
    displayName: val("f-displayName"),
    host: val("f-host"),
    port: Math.round(num("f-port", 11434)),
    basePath: val("f-basePath"),
    useHttps: document.getElementById("f-useHttps").checked,
    verifySsl: document.getElementById("f-verifySsl").checked,
    apiToken: val("f-apiToken"),
    model: val("f-model"),
    allowLoopback: document.getElementById("f-allowLoopback").checked,
    azureApiShape: val("f-azureApiShape") === "deployments" || val("f-azureApiShape") === "anthropic" ? val("f-azureApiShape") : "v1",
    azureApiVersion: val("f-azureApiVersion"),
    azureAuth: val("f-azureAuth") === "entra" ? "entra" : "apiKey",
    tenantId: val("f-tenantId"),
    clientId: val("f-clientId"),
    clientSecret: val("f-clientSecret"),
    azureScope: val("f-azureScope"),
    omitTemperature: document.getElementById("f-omitTemperature").checked,
    acceptsImages: document.getElementById("f-acceptsImages").checked,
    temperature: num("f-temperature", 0.2),
    maxToolRounds: Math.round(num("f-maxToolRounds", 6)),
    maxRowsPerTool: Math.round(num("f-maxRowsPerTool", 200)),
    contextMessages: Math.round(num("f-contextMessages", 20)),
    contextWindow: Math.round(num("f-contextWindow", 8192)),
    idleResetMinutes: Math.max(0, Math.min(1440, Math.round(num("f-idleResetMinutes", 30)))),
    requestTimeoutMs: Math.round(num("f-requestTimeoutSec", 120)) * 1000,
    systemPromptExtra: (document.getElementById("f-systemPromptExtra").value || "").trim(),
    verboseLogging: readVerboseLoggingFromForm(),
  };
  // Azure: the Endpoint box carries the whole URL in `host`; the server splits
  // it into host / port / scheme / prefix (normalizeLlmProviderInput), so the
  // hidden OpenAI-only port / path / HTTPS fields must not override it.
  if (provider === "azure") { delete cfg.port; delete cfg.basePath; delete cfg.useHttps; }
  return cfg;
}

/** An Azure llm config's endpoint as the URL the operator pasted (port shown only when not the scheme's default). */
function _llmAzureEndpointText(c) {
  if (!c || !c.host) return "";
  var https = c.useHttps !== false;
  var port = c.port && c.port !== (https ? 443 : 80) ? ":" + c.port : "";
  var host = String(c.host).indexOf(":") !== -1 ? "[" + c.host + "]" : c.host;
  return (https ? "https" : "http") + "://" + host + port + (c.basePath || "");
}

/** Show the fields of the chosen provider (and Azure auth mode / API shape), hide the rest. */
/**
 * The Context window field's hint, per provider. The window sizes every turn
 * on EVERY provider (assistantChatService.contextBudget) — left at the 8192
 * default on a hosted model, Polaris trims history and lookups as if the model
 * were small. Static markup, no operator text.
 */
function _llmContextWindowHint(azure) {
  return azure
    ? "Match the deployment's context window: Claude Haiku 5.5, Sonnet 5.5 and Opus 5.5 take <code>1000000</code>; most current GPT deployments 128000 or more. Polaris sizes each question to fit it — history is still capped by <em>Messages of history sent</em> and each lookup at 24,000 characters, so a large window does not mean a large bill."
    : "Match the model server. Ollama uses 4096 unless <code>OLLAMA_CONTEXT_LENGTH</code> raises it; 8192 or more leaves room for lookups.";
}

function _applyLlmProvider(id) {
  var azure = val("f-llmProvider") === "azure";
  var entra = val("f-azureAuth") === "entra";
  function show(el, on) { if (el) el.style.display = on ? "" : "none"; }
  document.querySelectorAll(".llm-openai-only").forEach(function (el) { show(el, !azure); });
  document.querySelectorAll(".llm-azure-only").forEach(function (el) { show(el, azure); });
  document.querySelectorAll(".llm-entra-only").forEach(function (el) { show(el, azure && entra); });
  show(document.getElementById("f-azureApiVersion-group"), azure && val("f-azureApiShape") === "deployments");
  // Claude never gets `temperature` (llmService.anthropicRound), so the box only applies to GPT shapes.
  show(document.getElementById("f-omitTemperature-group"), azure && val("f-azureApiShape") !== "anthropic");
  // An untouched, never-saved Accepts images box follows the provider (llmService.acceptsImages).
  var imgBox = document.getElementById("f-acceptsImages");
  if (imgBox && imgBox.getAttribute("data-auto") === "1") imgBox.checked = azure && val("f-azureApiShape") === "anthropic";
  show(document.getElementById("f-apiToken-group"), !(azure && entra));
  var set = function (elId, text) { var el = document.getElementById(elId); if (el) el.textContent = text; };
  set("f-host-label", azure ? "Endpoint *" : "Host / IP *");
  set("f-model-label", azure ? "Deployment name *" : "Model");
  set("f-apiToken-label", azure ? "API key *" : "API key");
  set("f-apiToken-hint", azure ? "Stored encrypted. Key 1 or Key 2 from the resource's Keys and Endpoint page." : "Stored encrypted. Ollama and LM Studio need none by default.");
  var ctxHint = document.getElementById("f-contextWindow-hint");
  if (ctxHint) ctxHint.innerHTML = _llmContextWindowHint(azure);
  var host = document.getElementById("f-host");
  if (host) host.placeholder = azure ? "https://my-resource.openai.azure.com" : "e.g. 10.1.5.20 or llm.example.com";
  var model = document.getElementById("f-model");
  var select = document.getElementById("f-model-select");
  if (model) model.placeholder = azure ? "The deployment name, not the model name" : "Blank = the server's first tool-calling model";
  if (azure) {
    // Foundry has no model list: a free-text deployment name, and the
    // tool-calling check runs against it directly.
    _llmModels = [];
    if (select) select.style.display = "none";
    if (model) model.style.display = "";
    _renderAzureModelStatus(id);
  } else {
    var st = document.getElementById("f-llm-model-status");
    if (st && !_llmModels.length) st.textContent = "Load the server's models (Test Connection does too) to pick one and see which support tool calling.";
  }
}

function _renderAzureModelStatus(id, verdict) {
  var status = document.getElementById("f-llm-model-status");
  if (!status) return;
  var html = verdict
    ? '<span style="color:' + (verdict === "yes" ? "var(--color-success)" : verdict === "no" ? "var(--color-warning)" : "var(--color-text-tertiary)") + '">' + escapeHtml(_llmToolLabel(verdict)) + ' (checked)</span>'
    : '<span>Use a GPT deployment that supports tool calling. Saving runs the check too.</span>';
  if (verdict !== "yes") html += '<button type="button" class="btn btn-secondary btn-sm" id="f-llm-probe">Check tool calling</button>';
  status.innerHTML = html;
  var probe = document.getElementById("f-llm-probe");
  if (probe) probe.addEventListener("click", function () {
    var dep = val("f-model");
    if (!dep) { showToast("Enter the deployment name first", "error"); return; }
    _probeLlmModel(dep, id);
  });
}

/**
 * The once-only reveal of the LLM server's API credentials — the same "save it
 * now" contract as Server Settings → API Tokens (_showRawTokenModal), plus the
 * base URL and role the model server needs to use them.
 */
function _showLlmAccessModal(access, integrationName) {
  var base = window.location.origin + (access.apiPath || "/api/v1");
  var block = function (label, value, id) {
    return '<div class="form-group"><label>' + escapeHtml(label) + '</label>' +
      '<div style="display:flex;gap:8px;align-items:stretch">' +
        '<div id="' + id + '" style="flex:1;background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;padding:0.55rem 0.7rem;font-family:var(--font-mono);font-size:0.85rem;word-break:break-all;user-select:all">' + escapeHtml(value) + '</div>' +
        '<button class="btn btn-secondary btn-sm" data-copy="' + id + '">Copy</button>' +
      '</div></div>';
  };
  var body =
    '<p style="margin:0 0 0.75rem">Give these to the model server for <strong>' + escapeHtml(integrationName) + '</strong> so it can look things up in Polaris itself (an Open WebUI tool, an MCP server, a script). The token is <strong>never shown again</strong>.</p>' +
    block("Polaris API base URL", base, "llm-acc-base") +
    block("API token (Authorization: Bearer …)", access.rawToken, "llm-acc-token") +
    '<p class="hint" style="margin-top:0.25rem">Bound to the read-only role <strong>' + escapeHtml(access.roleName) + '</strong> (token “' + escapeHtml(access.tokenName) + '”). The endpoints are documented at <a href="/api" target="_blank" rel="noopener">/api</a>. The in-app assistant does not need this — it answers with each user\'s own permissions.</p>' +
    calloutHTML("warning", "Treat it like a password",
      'Anyone holding this token can read your inventory, networks, alerts and events. Store it in the model server\'s secret store, not in a prompt or a shared file. Regenerate it from the integration card if it leaks.');
  openModal("AI Assistant API Access — Save Now", body,
    '<button class="btn btn-primary" onclick="closeModal()">I have saved it</button>', { wide: true });
  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var el = document.getElementById(btn.getAttribute("data-copy"));
      try {
        if (!(await copyTextToClipboard(el ? el.textContent : ""))) throw new Error("copy failed");
        showToast("Copied");
      } catch (_) {
        showToast("Copy failed — select the text manually", "error");
      }
    });
  });
}

async function regenerateLlmToken(id, btn) {
  // The name is read off the card rather than passed through the onclick
  // string, where a quote in it would break the handler.
  var card = btn && btn.closest ? btn.closest(".integration-card") : null;
  var strong = card ? card.querySelector(".integration-card-title strong") : null;
  var name = strong ? strong.textContent : "this integration";
  var ok = await showConfirm('Issue a new API token for "' + name + '"? The current token stops working immediately, so update the model server afterwards.');
  if (!ok) return;
  try {
    var access = await api.integrations.llmRegenerateToken(id);
    _showLlmAccessModal(access, name);
  } catch (err) {
    showToast(err.message || "Could not regenerate the token", "error");
  }
}

function vcenterFormHTML(defaults) {
  var d = defaults || {};
  var verifyTls = d.verifyTls !== false;
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  var devMode = (d.vmInclude && d.vmInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.vmInclude || []) : (d.vmExclude || []);
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Production vCenter"></div>' +
    infoBox('Connects to a <strong style="color:var(--color-text-primary)">VMware vCenter</strong> server (7.0U2+) and discovers virtual machines, ESXi hosts, and datastores. VMs merge with assets discovered by other integrations (matched by vNIC MAC / hostname); vCenter data wins over every source except the Polaris Agent. VMs gain a clickable link to their running host and a vMotion-safe host dependency.') +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. vcenter.corp.local"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + (d.port || 443) + '" min="1" max="65535" style="width:90px"></div>' +
    '</div>' +
    checkboxRow("f-verifyTls", "Verify TLS certificate", verifyTls) +
    '<p class="hint" style="color:var(--color-warning)">Leave enabled. Disabling certificate verification lets a network attacker intercept the connection and capture the vCenter credentials. Disable only for a vCenter with a self-signed certificate you cannot replace.</p>' +
    '<div class="form-group"><label>Username *</label><input type="text" id="f-username" value="' + escapeHtml(d.username || "") + '" placeholder="e.g. polaris-svc@vsphere.local"><p class="hint">A read-only vCenter account is sufficient — Polaris never writes to vCenter.</p></div>' +
    '<div class="form-group"><label>Password *</label><input type="password" id="f-password" value="' + (d.passwordPlaceholder ? "" : escapeHtml(d.password || "")) + '" placeholder="' + (d.passwordPlaceholder || "Password") + '"></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to re-query vCenter for inventory updates (1–24 hours)</p></div>' +
    formDivider() +
    sectionHeading("VM Filter") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto">' +
          '<option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these VMs (matched against the vCenter VM name)</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="3" placeholder="One per line — e.g.&#10;prod-*&#10;*-template">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
      '<p class="hint">Leave empty to sync every VM. Each line matches the vCenter-side VM name. Wildcards: <code>prod-*</code>, <code>*sql*</code>. ESXi hosts are never filtered.</p>' +
    '</div>' +
    verboseLoggingFormHTML(d);
}

// ─── Unraid / TrueNAS SCALE ─────────────────────────────────────────────────
// One form for both: they own the same three asset classes and differ only in
// transport (Unraid GraphQL vs TrueNAS JSON-RPC over WebSocket), which the
// copy below names. The key is stored under the sealed `apiToken` config key.
function workloadFormHTML(type, defaults) {
  var d = defaults || {};
  var isTn = type === "truenas";
  var product = isTn ? "TrueNAS SCALE" : "Unraid";
  var useTls = d.useTls !== false;
  var verifyTls = d.verifyTls !== false;
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  var vmMode = (d.vmInclude && d.vmInclude.length > 0) ? "include" : "exclude";
  var vmNames = vmMode === "include" ? (d.vmInclude || []) : (d.vmExclude || []);
  var ctrMode = (d.containerInclude && d.containerInclude.length > 0) ? "include" : "exclude";
  var ctrNames = ctrMode === "include" ? (d.containerInclude || []) : (d.containerExclude || []);
  var ctrWord = isTn ? "Apps" : "containers";
  var keyHint = isTn
    ? 'Created from the top-right user menu → <strong>My API Keys</strong>. A key carries the permissions of the user it belongs to — see the setup steps above.'
    : 'Created under <strong>Settings → Management Access → API Keys</strong>. See the setup steps above for the role and permissions.';
  // Step-by-step setup on the platform side, written against Unraid 7.3 and
  // TrueNAS SCALE 25.10. Menu paths move between releases — when they do,
  // update this AND docs/wiki/Integration-Unraid.md / Integration-TrueNAS.md.
  var setupSteps = isTn
    ? '<ol style="margin:0.25rem 0 0 1.1rem;padding:0">' +
        '<li><strong>Check the version</strong> — the dashboard&rsquo;s System Information card. Polaris needs TrueNAS SCALE <strong>25.04 or later</strong> (it uses the JSON-RPC WebSocket API, not the REST API removed in 26.04).</li>' +
        '<li><strong>Create a dedicated user</strong> — <em>Credentials → Users → Add</em>. Give it a username (e.g. <code>polaris</code>), under <em>Allow Access</em> choose <strong>TrueNAS Access</strong>, and set the <em>Administration Role</em> to <strong>Readonly Admin</strong>. No shell, no SMB, no sudo. Readonly Admin is enough for discovery and monitoring; for Polaris to start, stop, restart or update Apps and VMs the user needs <strong>Full Admin</strong> instead.</li>' +
        '<li><strong>Create the key</strong> — top-right user menu → <em>My API Keys</em> → <strong>Add</strong> (or <em>Credentials → Users</em>, select the user, <em>View API Keys</em>). Name it, pick the user from <em>Username</em>, and either leave it non-expiring or set <em>Expires On</em>.</li>' +
        '<li><strong>Copy the key now</strong> — TrueNAS shows it only once — and paste it below.</li>' +
        '<li><strong>Keep HTTPS on.</strong> TrueNAS revokes a key the first time it is sent over plain HTTP. If the web UI uses TrueNAS&rsquo;s default self-signed certificate, untick <em>Verify TLS certificate</em> or install a trusted certificate on TrueNAS.</li>' +
        '<li><strong>Test Connection</strong> should report the hostname, the version and how many Apps, VMs and pools it can see. &ldquo;Apps unreadable&rdquo; means the Apps service has no pool configured, or the user lacks read access.</li>' +
      '</ol>'
    : '<ol style="margin:0.25rem 0 0 1.1rem;padding:0">' +
        '<li><strong>Check the version</strong> — shown top-right of the web UI. Polaris needs <strong>Unraid 7.2 or later</strong>, where the API is built in (older releases need the Unraid Connect plugin).</li>' +
        '<li><strong>Create the key</strong> — <em>Settings → Management Access → API Keys</em> → create a key named e.g. <code>polaris</code>. For discovery and monitoring give it the <strong>VIEWER</strong> role (read-only).</li>' +
        '<li><strong>For workload actions</strong> (start / stop / restart / update), also grant the permissions <strong>DOCKER: UPDATE_ANY</strong> and <strong>VMS: UPDATE_ANY</strong> — or use the ADMIN role, which grants everything. Without them Polaris still monitors; the actions are refused by Unraid and logged.</li>' +
        '<li><strong>Copy the key</strong> and paste it below.</li>' +
        '<li><strong>HTTPS:</strong> <em>Settings → Management Access → Use SSL/TLS</em> decides the protocol. With <em>Strict</em> (a myunraid.net certificate) enter the myunraid.net hostname as the host so the certificate verifies; with a self-signed certificate untick <em>Verify TLS certificate</em>; with SSL off, untick <em>Use HTTPS</em>.</li>' +
        '<li><strong>Test Connection</strong> should report the hostname, the Unraid version and the container and VM counts. &ldquo;Containers unreadable&rdquo; means Docker is stopped (<em>Settings → Docker</em>) or the key lacks Docker read access; the same for VMs.</li>' +
      '</ol>' +
      '<p style="margin:0.4rem 0 0 0">To explore the API yourself, enable <em>Settings → Management Access → Developer Options → GraphQL Sandbox</em> and open <code>https://&lt;server&gt;/graphql</code>.</p>';
  function filterBlock(idMode, idNames, mode, names, what, matched, example) {
    return '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="' + idMode + '" style="width:auto">' +
          '<option value="include"' + (mode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (mode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these ' + what + ' (matched against ' + matched + ')</span>' +
      '</div>' +
      '<textarea id="' + idNames + '" rows="3" placeholder="One per line — e.g.&#10;' + example + '">' + escapeHtml(names.join("\n")) + '</textarea>' +
    '</div>';
  }
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. ' + (isTn ? "Storage NAS" : "Tower") + '"></div>' +
    infoBox('Connects to an <strong style="color:var(--color-text-primary)">' + product + '</strong> host and discovers the host, its virtual machines and its ' + ctrWord + ', each as an asset parented by the host. Their state, CPU and memory, the host&rsquo;s pools and disk temperatures are read from the host&rsquo;s own API on every monitor tick — nothing is installed on the host.') +
    calloutHTML("tip", "Set up " + product + " first", setupSteps) +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. ' + (isTn ? "truenas.lan" : "tower.lan") + '"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + escapeHtml(d.port ? String(d.port) : "") + '" min="1" max="65535" placeholder="' + (useTls ? "443" : "80") + '" style="width:90px"></div>' +
    '</div>' +
    checkboxRow("f-useTls", "Use HTTPS", useTls) +
    (isTn ? '<p class="hint" style="color:var(--color-warning)">Leave on. TrueNAS revokes an API key that is ever sent over plain HTTP.</p>' : '') +
    checkboxRow("f-verifyTls", "Verify TLS certificate", verifyTls) +
    '<p class="hint">Turn off only for a host with a self-signed certificate you cannot replace — it lets a network attacker capture the API key.</p>' +
    '<div class="form-group"><label>API Key *</label><input type="password" id="f-apiToken" value="" placeholder="' + escapeHtml(d.apiTokenPlaceholder || "API key") + '" autocomplete="off"><p class="hint">' + keyHint + '</p></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 1) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to look for new or removed VMs and ' + ctrWord + ' (1–24 hours). Their up/down state and usage are read every monitor tick regardless.</p></div>' +
    formDivider() +
    sectionHeading("Filters") +
    filterBlock("f-vmMode", "f-vmNames", vmMode, vmNames, "VMs", "the VM name", "win-*") +
    filterBlock("f-ctrMode", "f-ctrNames", ctrMode, ctrNames, ctrWord, isTn ? "the App name" : "the container name", "*-test") +
    '<p class="hint">Leave empty to sync everything. Wildcards: <code>plex*</code>, <code>*db*</code>. The host is never filtered. Narrowing a filter does not decommission what it drops — those assets simply stop updating.</p>' +
    verboseLoggingFormHTML(d);
}

function getWorkloadFormConfig() {
  var port = document.getElementById("f-port").value;
  var vmMode = document.getElementById("f-vmMode").value;
  var vmNames = linesToArray("f-vmNames");
  var ctrMode = document.getElementById("f-ctrMode").value;
  var ctrNames = linesToArray("f-ctrNames");
  var cfg = {
    host: val("f-host"),
    useTls: document.getElementById("f-useTls").checked,
    verifyTls: document.getElementById("f-verifyTls").checked,
    apiToken: val("f-apiToken"),
    vmInclude: vmMode === "include" ? vmNames : [],
    vmExclude: vmMode === "exclude" ? vmNames : [],
    containerInclude: ctrMode === "include" ? ctrNames : [],
    containerExclude: ctrMode === "exclude" ? ctrNames : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
  if (port) cfg.port = parseInt(port, 10);
  return cfg;
}

// ─── ArcGIS ─────────────────────────────────────────────────────────────────
// A portal sign-in (ArcGIS Online, Location Platform or ArcGIS Enterprise). It
// discovers nothing: it supplies satellite imagery to the Device Map and is
// where cable runs are written back. One credential block per sign-in method,
// shown by the method picker (_wireArcgisForm in integrations.js).

var ARCGIS_AUTH_MODES = [
  ["appCredentials", "OAuth app credentials (client ID + secret)"],
  ["apiKey",         "API key"],
  ["userPassword",   "Username and password (ArcGIS Enterprise)"],
  ["none",           "None (public World Imagery only)"],
];

function arcgisFormHTML(defaults) {
  var d = defaults || {};
  var mode = d.authMode || "apiKey";
  var enabledChecked = d.enabled !== false ? "checked" : "";
  function block(m, html) {
    return '<div data-arcgis-auth="' + m + '"' + (m === mode ? '' : ' hidden') + '>' + html + '</div>';
  }
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Corporate GIS"></div>' +
    infoBox('Connects Polaris to an <strong style="color:var(--color-text-primary)">ArcGIS</strong> portal — ArcGIS Online, ArcGIS Location Platform or your own ArcGIS Enterprise. It discovers no devices: it supplies satellite imagery to the Device Map and is where the cable runs drawn on the map are written.') +
    formDivider() +
    sectionHeading("Portal") +
    '<div class="form-group"><label>Portal URL</label><input type="text" id="f-portalUrl" value="' + escapeHtml(d.portalUrl || "") + '" placeholder="https://www.arcgis.com">' +
      '<p class="hint">Leave blank for ArcGIS Online and Location Platform. For ArcGIS Enterprise, give your portal, e.g. <code>https://gis.example.com/portal</code>.</p></div>' +
    '<div class="form-group"><label>Sign in with</label><select id="f-authMode">' +
      ARCGIS_AUTH_MODES.map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === mode ? ' selected' : '') + '>' + escapeHtml(o[1]) + '</option>';
      }).join("") +
    '</select></div>' +
    block("appCredentials",
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        '<div class="form-group"><label>Client ID</label><input type="text" id="f-clientId" value="' + escapeHtml(d.clientId || "") + '" autocomplete="off"></div>' +
        '<div class="form-group"><label>Client secret</label><input type="password" id="f-clientSecret" value="" placeholder="' + escapeHtml(d.clientSecretPlaceholder || "Client secret") + '" autocomplete="off"></div>' +
      '</div>' +
      '<p class="hint">From an OAuth 2.0 app (Content → New item → Developer credentials). Polaris exchanges it for a two-hour token and renews it as needed.</p>') +
    block("apiKey",
      '<div class="form-group"><label>API key</label><input type="password" id="f-apiToken" value="" placeholder="' + escapeHtml(d.apiTokenPlaceholder || "API key") + '" autocomplete="off">' +
      '<p class="hint">Grant it only the privileges Polaris uses: basemaps for imagery, and editing of the cable-run layer for write-back.</p></div>') +
    block("userPassword",
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +
        '<div class="form-group"><label>Username</label><input type="text" id="f-username" value="' + escapeHtml(d.username || "") + '" autocomplete="off"></div>' +
        '<div class="form-group"><label>Password</label><input type="password" id="f-password" value="" placeholder="' + escapeHtml(d.passwordPlaceholder || "Password") + '" autocomplete="off"></div>' +
      '</div>' +
      '<p class="hint">Use a dedicated account. Polaris signs in through the portal&rsquo;s generateToken endpoint.</p>') +
    block("none", '<p class="hint">No sign-in: only public services answer. Write-back needs a sign-in.</p>') +
    checkboxRow("f-verifySsl", "Verify TLS certificate", d.verifySsl !== false) +
    '<p class="hint">Turn off only for an Enterprise portal with a private certificate; Polaris then pins the certificate it first sees.</p>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<input type="hidden" id="f-pollInterval" value="' + (d.pollInterval || 12) + '">' +
    verboseLoggingFormHTML(d);
}

function getArcgisFormConfig() {
  var mode = document.getElementById("f-authMode").value;
  var cfg = {
    portalUrl: val("f-portalUrl"),
    authMode: mode,
    verifySsl: document.getElementById("f-verifySsl").checked,
    verboseLogging: readVerboseLoggingFromForm(),
  };
  // Only the chosen method's fields go out; the others keep what is stored.
  if (mode === "appCredentials") { cfg.clientId = val("f-clientId"); cfg.clientSecret = val("f-clientSecret"); }
  if (mode === "apiKey") cfg.apiToken = val("f-apiToken");
  if (mode === "userPassword") { cfg.username = val("f-username"); cfg.password = val("f-password"); }
  return cfg;
}

// ─── Proxmox VE ─────────────────────────────────────────────────────────────
// The workload classes with Proxmox's own transport: an API token (token ID +
// secret) and a list of node addresses — any node answers for the cluster. The
// setup steps and CLI were verified on Proxmox VE 9.2; when the GUI paths move,
// update this AND docs/wiki/Integration-Proxmox.md.
function proxmoxFormHTML(defaults) {
  var d = defaults || {};
  var verifyTls = d.verifyTls !== false;
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  var vmMode = (d.vmInclude && d.vmInclude.length > 0) ? "include" : "exclude";
  var vmNames = vmMode === "include" ? (d.vmInclude || []) : (d.vmExclude || []);
  var ctrMode = (d.containerInclude && d.containerInclude.length > 0) ? "include" : "exclude";
  var ctrNames = ctrMode === "include" ? (d.containerInclude || []) : (d.containerExclude || []);
  var setupSteps =
    '<ol style="margin:0.25rem 0 0 1.1rem;padding:0">' +
      '<li><strong>Create a user</strong> — <em>Datacenter → Permissions → Users → Add</em>: user name <code>polaris</code>, realm <strong>Proxmox VE authentication server</strong> (<code>pve</code>). No password is needed — Polaris signs in with a token.</li>' +
      '<li><strong>Grant read-only access</strong> — <em>Datacenter → Permissions → Add → User Permission</em>: path <code>/</code>, user <code>polaris@pve</code>, role <strong>PVEAuditor</strong>, <em>Propagate</em> ticked. PVEAuditor reads every node, guest and storage and can change nothing; Polaris starts and stops nothing on Proxmox.</li>' +
      '<li><strong>Create the token</strong> — <em>Datacenter → Permissions → API Tokens → Add</em>: user <code>polaris@pve</code>, token ID e.g. <code>monitor</code>, and <strong>untick Privilege Separation</strong> so the token inherits the user&rsquo;s PVEAuditor role (or leave it ticked and grant PVEAuditor on <code>/</code> to the token itself).</li>' +
      '<li><strong>Copy the secret now</strong> — Proxmox shows it only once. The token ID to enter below is the full <code>polaris@pve!monitor</code>.</li>' +
      '<li><strong>TLS:</strong> Proxmox ships a self-signed certificate on port 8006. Install a trusted one (<em>System → Certificates</em> on each node) or untick <em>Verify TLS certificate</em>.</li>' +
      '<li><strong>Test Connection</strong> should name the cluster, the Proxmox VE version and the node, VM and container counts. &ldquo;No nodes visible&rdquo; means the token has no role on <code>/</code>.</li>' +
    '</ol>' +
    '<p style="margin:0.4rem 0 0 0">The same from a node&rsquo;s shell:<br><code>pveum user add polaris@pve</code><br><code>pveum acl modify / --users polaris@pve --roles PVEAuditor</code><br><code>pveum user token add polaris@pve monitor --privsep 0</code></p>';
  function filterBlock(idMode, idNames, mode, names, what, matched, example) {
    return '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="' + idMode + '" style="width:auto">' +
          '<option value="include"' + (mode === "include" ? " selected" : "") + '>Include</option>' +
          '<option value="exclude"' + (mode === "exclude" ? " selected" : "") + '>Exclude</option>' +
        '</select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these ' + what + ' (matched against ' + matched + ')</span>' +
      '</div>' +
      '<textarea id="' + idNames + '" rows="3" placeholder="One per line — e.g.&#10;' + example + '">' + escapeHtml(names.join("\n")) + '</textarea>' +
    '</div>';
  }
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Proxmox cluster"></div>' +
    infoBox('Connects to a <strong style="color:var(--color-text-primary)">Proxmox VE</strong> cluster (or a standalone node) and discovers every node, its QEMU virtual machines and its LXC containers, each as an asset parented by the node it runs on — a guest that migrates moves with it. State, CPU, memory, network traffic and each node&rsquo;s storage and ZFS pools are read from the API on every monitor tick — nothing is installed anywhere.') +
    calloutHTML("tip", "Set up Proxmox VE first", setupSteps) +
    formDivider() +
    sectionHeading("Connection Settings") +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Node Address *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. pve1.lan"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + escapeHtml(d.port ? String(d.port) : "") + '" min="1" max="65535" placeholder="8006" style="width:90px"></div>' +
    '</div>' +
    '<div class="form-group"><label>Fallback Node Addresses</label><textarea id="f-fallbackHosts" rows="2" placeholder="One per line — e.g.&#10;pve2.lan&#10;pve3.lan">' + escapeHtml((d.fallbackHosts || []).join("\n")) + '</textarea>' +
      '<p class="hint">Any node answers for the whole cluster. These are tried in order when the address above does not answer, so the integration keeps working while that node is down — and reports it offline.</p></div>' +
    checkboxRow("f-verifyTls", "Verify TLS certificate", verifyTls) +
    '<p class="hint">Turn off only while the nodes still use Proxmox&rsquo;s self-signed certificate — it lets a network attacker capture the token.</p>' +
    '<div class="form-group"><label>API Token ID *</label><input type="text" id="f-apiTokenId" value="' + escapeHtml(d.apiTokenId || "") + '" placeholder="polaris@pve!monitor" autocomplete="off"><p class="hint">The full ID: <code>user@realm!tokenname</code>.</p></div>' +
    '<div class="form-group"><label>API Token Secret *</label><input type="password" id="f-apiToken" value="" placeholder="' + escapeHtml(d.apiTokenPlaceholder || "Token secret") + '" autocomplete="off"></div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 1) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div><p class="hint">How often to look for new, removed or migrated guests (1–24 hours). Their up/down state, usage and which node they run on are read every monitor tick regardless.</p></div>' +
    formDivider() +
    sectionHeading("Filters") +
    filterBlock("f-vmMode", "f-vmNames", vmMode, vmNames, "VMs", "the VM name", "win-*") +
    filterBlock("f-ctrMode", "f-ctrNames", ctrMode, ctrNames, "containers", "the container hostname", "*-test") +
    '<p class="hint">Leave empty to sync everything. Wildcards: <code>web*</code>, <code>*db*</code>. Nodes are never filtered, and templates are always skipped. Narrowing a filter does not decommission what it drops — those assets simply stop updating.</p>' +
    verboseLoggingFormHTML(d);
}

function getProxmoxFormConfig() {
  var port = document.getElementById("f-port").value;
  var vmMode = document.getElementById("f-vmMode").value;
  var vmNames = linesToArray("f-vmNames");
  var ctrMode = document.getElementById("f-ctrMode").value;
  var ctrNames = linesToArray("f-ctrNames");
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 8006,
    fallbackHosts: linesToArray("f-fallbackHosts"),
    verifyTls: document.getElementById("f-verifyTls").checked,
    apiTokenId: val("f-apiTokenId"),
    apiToken: val("f-apiToken"),
    vmInclude: vmMode === "include" ? vmNames : [],
    vmExclude: vmMode === "exclude" ? vmNames : [],
    containerInclude: ctrMode === "include" ? ctrNames : [],
    containerExclude: ctrMode === "exclude" ? ctrNames : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

function getVcenterFormConfig() {
  var port = document.getElementById("f-port").value;
  var devMode = document.getElementById("f-deviceMode").value;
  var devNames = linesToArray("f-deviceNames");
  return {
    host: val("f-host"),
    port: port ? parseInt(port, 10) : 443,
    verifyTls: document.getElementById("f-verifyTls").checked,
    username: val("f-username"),
    password: val("f-password"),
    vmInclude: devMode === "include" ? devNames : [],
    vmExclude: devMode === "exclude" ? devNames : [],
    verboseLogging: readVerboseLoggingFromForm(),
  };
}

// ─── AI Assistant model picker ──────────────────────────────────────────────────
//
// The server's models come from POST /integrations/test (llmService.listModels):
// each carries toolCalling "yes" | "no" | "unknown" — from Ollama's reported
// capabilities where the server is Ollama, otherwise unknown until the
// operator runs "Check tool calling" (one real request offering a dummy tool,
// POST /integrations/llm/probe-tools). `f-model` stays the field the form
// reads; the select just writes into it, and a server whose list cannot be
// read leaves the free-text box in place.

var _llmModels = [];

function _llmToolLabel(tc) {
  return tc === "yes" ? "✓ tool calling" : tc === "no" ? "✗ no tool calling" : "tool calling unverified";
}

/** The card's Tool Calling row: config.toolCheck, stamped by POST /:id/llm/check-tools. */
function _llmToolCheckHTML(check) {
  if (!check || !check.result) return '<span style="color:var(--color-text-tertiary)">Not checked yet — saves run the check</span>';
  var color = check.result === "yes" ? "var(--color-success)" : check.result === "no" ? "var(--color-warning)" : "var(--color-text-tertiary)";
  var word = check.result === "yes" ? "✓ Verified" : check.result === "no" ? "✗ Not supported — chat only, no lookups" : "Could not tell";
  return '<span style="color:' + color + '">' + escapeHtml(word) + '</span>' +
    ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + escapeHtml(check.model || "") + (check.at ? ", " + escapeHtml(timeAgo(check.at)) : "") + ')</span>';
}

function _renderLlmModelStatus(id) {
  var status = document.getElementById("f-llm-model-status");
  var input = document.getElementById("f-model");
  if (!status || !input) return;
  var chosen = input.value.trim();
  if (!_llmModels.length) return;
  var def = _llmModels.find(function (m) { return !m.embedding && m.toolCalling === "yes"; })
    || _llmModels.find(function (m) { return !m.embedding; });
  var m = chosen ? _llmModels.find(function (x) { return x.id === chosen; }) : def;
  var color = !m ? "var(--color-text-tertiary)" : m.toolCalling === "yes" ? "var(--color-success)" : m.toolCalling === "no" ? "var(--color-warning)" : "var(--color-text-tertiary)";
  var html = "";
  if (!m) {
    html = '<span>Not on the server\'s list.</span>';
  } else {
    html = '<span style="color:' + color + '">' + escapeHtml((chosen ? m.id : "Auto → " + m.id) + " — " + _llmToolLabel(m.toolCalling)) +
      (m.toolCallingSource === "ollama" ? " (reported by Ollama)" : m.toolCallingSource === "probe" ? " (checked)" : "") + '</span>';
    if (m.toolCalling === "no") html += '<span>The assistant can chat with it but cannot look anything up.</span>';
    if (m.toolCalling !== "yes") html += '<button type="button" class="btn btn-secondary btn-sm" id="f-llm-probe">Check tool calling</button>';
  }
  status.innerHTML = html;
  var probe = document.getElementById("f-llm-probe");
  if (probe && m) probe.addEventListener("click", function () { _probeLlmModel(m.id, id); });
}

function _renderLlmModelPicker(models, id) {
  _llmModels = Array.isArray(models) ? models : [];
  var input = document.getElementById("f-model");
  var select = document.getElementById("f-model-select");
  if (!input || !select) return;
  if (!_llmModels.length) {
    select.style.display = "none";
    input.style.display = "";
    var st = document.getElementById("f-llm-model-status");
    if (st) st.textContent = "The server listed no models — type the model name.";
    return;
  }
  var current = input.value.trim();
  var def = _llmModels.find(function (m) { return !m.embedding && m.toolCalling === "yes"; })
    || _llmModels.find(function (m) { return !m.embedding; });
  var opts = '<option value="">Auto — ' + escapeHtml(def ? def.id : "server default") + '</option>' +
    _llmModels.map(function (m) {
      return '<option value="' + escapeHtml(m.id) + '">' + escapeHtml(m.id + " — " + _llmToolLabel(m.toolCalling) + (m.embedding ? " (embedding)" : "")) + '</option>';
    }).join("");
  // A configured model the server no longer lists stays selectable, flagged.
  if (current && !_llmModels.some(function (m) { return m.id === current; })) {
    opts += '<option value="' + escapeHtml(current) + '">' + escapeHtml(current + " — not on the server") + '</option>';
  }
  select.innerHTML = opts;
  select.value = current;
  select.style.display = "";
  input.style.display = "none";
  select.onchange = function () {
    input.value = select.value;
    _renderLlmModelStatus(id);
  };
  _renderLlmModelStatus(id);
}

async function _loadLlmModels(id) {
  var btn = document.getElementById("f-llm-load");
  var status = document.getElementById("f-llm-model-status");
  if (!val("f-host")) { showToast("Enter the model server's host first", "error"); return; }
  if (btn) { btn.disabled = true; btn.textContent = "Loading…"; }
  try {
    var cfg = getLlmFormConfig();
    if (id && !cfg.apiToken) delete cfg.apiToken;
    if (id && !cfg.clientSecret) delete cfg.clientSecret;
    var result = await api.integrations.testNew({ id: id || undefined, type: "llm", name: val("f-name") || "Test", config: cfg });
    if (result.models) _renderLlmModelPicker(result.models, id);
    else if (status) status.textContent = result.message || "Could not list the server's models";
  } catch (err) {
    if (status) status.textContent = (err && err.message) || "Could not list the server's models";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Reload"; }
  }
}

async function _probeLlmModel(model, id) {
  var btn = document.getElementById("f-llm-probe");
  if (btn) { btn.disabled = true; btn.textContent = "Checking… (one model call)"; }
  try {
    var cfg = getLlmFormConfig();
    if (id && !cfg.apiToken) delete cfg.apiToken;
    if (id && !cfg.clientSecret) delete cfg.clientSecret;
    var r = await api.integrations.llmProbeTools({ config: cfg, model: model, id: id || undefined });
    if (cfg.provider === "azure") {
      _renderAzureModelStatus(id, r.toolCalling);
    } else {
      _llmModels.forEach(function (m) { if (m.id === model) { m.toolCalling = r.toolCalling; m.toolCallingSource = "probe"; } });
      _renderLlmModelPicker(_llmModels, id);
    }
    showToast(model + ": " + _llmToolLabel(r.toolCalling), r.toolCalling === "yes" ? "success" : "warning");
  } catch (err) {
    showToast((err && err.message) || "The tool-calling check failed", "error");
    if (btn) { btn.disabled = false; btn.textContent = "Check tool calling"; }
  }
}

function _wireLlmForm(id) {
  _llmModels = [];
  var btn = document.getElementById("f-llm-load");
  if (btn) btn.addEventListener("click", function () { _loadLlmModels(id); });
  ["f-llmProvider", "f-azureAuth", "f-azureApiShape"].forEach(function (elId) {
    var el = document.getElementById(elId);
    if (el) el.addEventListener("change", function () { _applyLlmProvider(id); });
  });
  // A click on Accepts images is the operator's answer: stop following the provider.
  var imgBox = document.getElementById("f-acceptsImages");
  if (imgBox) imgBox.addEventListener("change", function () { imgBox.removeAttribute("data-auto"); });
  _applyLlmProvider(id);
  // Editing a configured integration: show its server's models straight away
  // (an OpenAI-compatible server only — Azure Foundry has no model list).
  if (id && val("f-host") && val("f-llmProvider") !== "azure") _loadLlmModels(id);
  _loadLlmRetention();
}

// Conversation retention is one server-wide setting, not integration config:
// read from GET /assistant/status, written by PUT /assistant/settings (Server
// Settings → System write). Without that grant the field stays read-only.
var _llmRetentionLoaded = null;

async function _loadLlmRetention() {
  _llmRetentionLoaded = null;
  var input = document.getElementById("f-assistantRetentionDays");
  var hint = document.getElementById("f-assistantRetentionHint");
  if (!input) return;
  try {
    var st = await api.assistant.status();
    if (!document.body.contains(input)) return;
    _llmRetentionLoaded = st.retentionDays;
    input.value = st.retentionDays;
    var canEdit = permAtLeast("serverSettingsSystem", "write");
    input.disabled = !canEdit;
    if (!canEdit && hint) hint.textContent += " Changing it needs Server Settings → System Read-Write.";
  } catch (_) {
    // No assistant grant: leave the field blank and disabled.
    if (hint) hint.textContent = "Conversation retention could not be read with your role.";
  }
}

/** Save the retention field when it changed. Never fails the integration save. */
async function _saveLlmRetention() {
  var input = document.getElementById("f-assistantRetentionDays");
  if (!input || input.disabled || _llmRetentionLoaded == null) return;
  var days = parseInt(input.value, 10);
  if (!Number.isFinite(days) || days === _llmRetentionLoaded) return;
  try {
    await api.assistant.updateSettings({ retentionDays: days });
  } catch (e) {
    showToast("Integration saved, but conversation retention couldn\'t be: " + (e.message || "unknown error"), "error");
  }
}

/**
 * After a create / save: ask the model the integration will actually chat
 * with to call a dummy tool, and record the verdict on the card
 * (POST /integrations/:id/llm/check-tools). Runs in the background — a slow
 * model takes up to 90 s — and reports by toast.
 */
function _autoCheckLlmTools(id, name) {
  if (!id) return;
  api.integrations.llmCheckTools(id)
    .then(function (r) {
      var msg = (name ? name + ": " : "") + r.model + " — " + _llmToolLabel(r.result);
      showToast(msg, r.result === "yes" ? "success" : "warning");
      loadIntegrations();
    })
    .catch(function (e) {
      showToast((name ? name + ": " : "") + "tool-calling check failed — " + (e.message || "unknown error"), "warning");
    });
}

