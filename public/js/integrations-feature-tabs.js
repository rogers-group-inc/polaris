/**
 * public/js/integrations-feature-tabs.js — the FortiManager / FortiGate
 * feature tabs (DHCP Push with its stale-detection and infrastructure
 * toggles, SD-WAN, Quarantine Push, Description Sync), the Entra / Arc
 * Script Publishing tabs and the Entra / AD Directory tab.
 *
 * Split out of integrations.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals. Loads AFTER
 * integrations.js — tests/unit/integrationsSplit.test.ts holds the order.
 */

// DHCP Push tab body. Renders the master toggle plus mode-aware guidance:
// when useProxy is on the call lands on the FortiGate via FMG's REST proxy
// in real time; when it's off it goes direct to the FortiGate's REST API
// using fortigateApiUser/fortigateApiToken on the Monitoring tab (FortiGate subtab). The toggle
// gates both halves of the Polaris → FortiGate DHCP write path:
//   1. Manual reservation creates → POST /cmdb/system.dhcp/server/<id>/
//      reserved-address. Verified on read-back; failures abort the create.
//   2. Freeing a discovered dhcp_lease row → POST /monitor/system/dhcp/
//      dhcp/revoke { ip: [ip] }. Best-effort; device failure does not block the
//      Polaris release.
//
// `pushReservations` is the current toggle value; `useProxy` is the current
// transport setting on the General tab (we read it at render time only).
// `arpPresenceSweep` is the read-only ARP presence-sweep toggle rendered as
// its own Stale Detection section at the bottom of the tab (stored in
// integration.config.arpPresenceSweep, read on save by
// _readArpPresenceSweepToggle()).
function reservationPushFormHTML(pushReservations, useProxy, arpPresenceSweep, autoReserveFortinetInfra, adoptDiscoveredMac, type) {
  var checked = pushReservations === true ? "checked" : "";
  var arpChecked = arpPresenceSweep === true ? "checked" : "";
  // Meaningless without the transport gate above it, so they render nested and
  // disabled until that box is ticked. The server re-checks anyway — the client
  // state is a convenience, not the enforcement.
  var autoChecked = autoReserveFortinetInfra === true ? "checked" : "";
  var autoDisabled = pushReservations === true ? "" : " disabled";
  var adoptChecked = adoptDiscoveredMac === true ? "checked" : "";
  var isStandalone = type === "fortigate";
  var modeLabel = isStandalone
    ? "Direct to the FortiGate"
    : (useProxy === false)
      ? "Direct to each FortiGate"
      : "Proxy through FortiManager to each FortiGate";
  var modeBody = isStandalone
    ? "DHCP writes go straight to this FortiGate's REST API using the API token on the General tab. Each call lands on the running config in real time."
    : (useProxy === false)
      ? "DHCP writes go to each FortiGate's REST API using the per-device API token on the Monitoring tab (FortiGate subtab). FortiManager is bypassed entirely. Each call lands on the running config in real time."
      : "DHCP writes go through FortiManager's <code>/sys/proxy/json</code> endpoint, which forwards the call to the target FortiGate using FortiManager's stored device credentials. Each call lands on the running config in real time; FortiManager will see the change on its next config sync.";
  var permsHtml = isStandalone
    ? _fortigateAccessProfileHTML(
        "DHCP reservations",
        ['<strong>Network</strong> &rarr; Custom &rarr; <strong>Configuration</strong> &rarr; Read-Write &nbsp;<span style="color:var(--color-text-tertiary)">&larr; the group the <code>system.dhcp.server</code> configuration tree belongs to</span>'],
        "/api/v2/cmdb/system/dhcp/server",
      )
    : (sectionHeading("Required FortiManager Admin Profile") +
      '<p class="hint" style="margin:0 0 0.75rem 0">The following permission changes are needed on the FortiManager admin profile Polaris uses:</p>' +
      '<ul class="hint" style="margin:0 0 0.75rem 1.2rem;padding:0">' +
        '<li><strong>Device Manager</strong> &rarr; Read-Write</li>' +
        '<li style="margin-left:1.2rem"><strong>Manage Device Configurations</strong> &rarr; Read-Write &nbsp;<span style="color:var(--color-text-tertiary)">&larr; the actual gate</span></li>' +
        '<li>All other Device Manager sub-items &mdash; leave at Read-Only or None</li>' +
        '<li><strong>Policy &amp; Objects</strong> &mdash; leave at Read-Only or None</li>' +
        '<li style="margin-left:1.2rem"><strong>Install Policy Package or Device Configuration</strong> &rarr; None &nbsp;<span style="color:var(--color-text-tertiary)">&larr; Polaris never triggers installs</span></li>' +
      '</ul>' +
      calloutHTML("warning", "Blast radius", "FortiManager admin profiles do not have a per-object permission for DHCP reservations. <strong>Manage Device Configurations</strong> grants write access to every CMDB tree on every FortiGate in this ADOM. A compromised Polaris API token could in principle modify other device-level config &mdash; interfaces, routing, other DHCP scopes &mdash; not just the reservations Polaris pushes. Treat the API token as a privileged credential and rotate on the same cadence as your other admin secrets.") +
      calloutHTML("tip", "Tighter scope alternative", "For tighter scope, switch to direct mode (tick <em>Direct Polling</em> on the Monitoring tab&rsquo;s FortiGate subtab) and configure a per-FortiGate REST API admin with <strong>Network &rarr; Custom &rarr; Configuration</strong> set to Read/Write. This scopes write access to one FortiGate's network-configuration bucket instead of every CMDB tree on every device in the ADOM."));
  return '<section style="margin-bottom:1.5rem">' +
      sectionHeading("DHCP Push") +
      '<p class="hint" style="margin:0 0 0.75rem 0">When enabled, two DHCP writes flow from Polaris back to the originating FortiGate on subnets discovered by this integration.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<input type="checkbox" id="f-pushReservations" ' + checked + ' onchange="syncAutoReserveInfraEnabled()" style="width:auto">' +
        '<label for="f-pushReservations" style="margin:0">Write Polaris DHCP changes back to FortiGate</label>' +
      '</div>' +
      '<ul class="hint" style="margin:0.25rem 0 0 1.2rem;padding:0">' +
        '<li><strong>Reservation create.</strong> Every manual IP reservation is written to the FortiGate at create time as a <code>reserved-address</code> entry. The Polaris reservation only commits if the device write succeeds and the entry verifies on read-back; any failure aborts the create.</li>' +
        '<li><strong>DHCP lease revoke.</strong> Freeing a discovered <code>dhcp_lease</code> row tells the FortiGate to forget the current lease via <code>dhcp/revoke</code>. Best-effort &mdash; a device-side failure is logged as a warning but does not block the Polaris release. The same client can still DHCP-acquire the IP back on its next request; this is "expire now," not a block.</li>' +
      '</ul>' +
      '<div class="form-group" style="display:flex;align-items:flex-start;gap:8px;margin:1rem 0 0.5rem;padding-left:1.2rem;border-left:2px solid var(--color-border)">' +
        '<input type="checkbox" id="f-autoReserveFortinetInfra" ' + autoChecked + autoDisabled + ' style="width:auto;margin-top:3px">' +
        '<label for="f-autoReserveFortinetInfra" style="margin:0">Also reserve discovered FortiSwitch and FortiAP addresses on their gate' +
          (pushReservations === true ? '' : ' <span style="color:var(--color-text-tertiary)">(requires the setting above)</span>') +
        '</label>' +
      '</div>' +
      '<ul class="hint" style="margin:0.25rem 0 0 2.4rem;padding:0">' +
        '<li><strong>What it does.</strong> Each discovery cycle, managed FortiSwitches and FortiAPs that hold their address by dynamic lease get a real <code>reserved-address</code> entry written on their own FortiGate, pinning the address they already use. Nothing else is touched: only devices this integration discovered, only where Polaris learned the MAC from the gate\'s own lease table, and only addresses the device is already holding &mdash; so the DHCP pool\'s occupancy does not change.</li>' +
        '<li><strong>Paced, not a fan-out.</strong> A bounded number of entries are written per discovery cycle and the rest are picked up on later cycles. Each write is verified by reading it back, and a device that refuses is left alone and logged rather than retried into the ground.</li>' +
        '<li><strong>Reversible.</strong> Decommissioning or deleting a switch/AP removes its entry from the gate. Turning this off stops new entries; it does not remove ones already written &mdash; release those reservations to do that.</li>' +
      '</ul>' +
      '<div class="form-group" style="display:flex;align-items:flex-start;gap:8px;margin:1rem 0 0.5rem;padding-left:1.2rem;border-left:2px solid var(--color-border)">' +
        '<input type="checkbox" id="f-adoptDiscoveredMac" ' + adoptChecked + autoDisabled + ' style="width:auto;margin-top:3px">' +
        '<label for="f-adoptDiscoveredMac" style="margin:0">Replace a placeholder MAC with the real device\'s MAC once one appears' +
          (pushReservations === true ? '' : ' <span style="color:var(--color-text-tertiary)">(requires the setting above)</span>') +
        '</label>' +
      '</div>' +
      '<ul class="hint" style="margin:0.25rem 0 0 2.4rem;padding:0">' +
        '<li><strong>The problem it fixes.</strong> Reserving an IP for a device that isn\'t racked yet needs a MAC before there is a device to supply one, so Polaris generates a placeholder. That entry matches nothing: when the device finally arrives it asks for DHCP with its real MAC, misses the reservation and takes a pool address instead. The reservation looks correct on both sides and silently does nothing.</li>' +
        '<li><strong>What it does.</strong> When discovery sees a real device answering at that reserved IP &mdash; in the gate\'s ARP table or its device inventory &mdash; the reservation takes that device\'s MAC and the corrected entry is written back to the gate and verified by read-back. Every change is audited with both MACs and which source saw it.</li>' +
        '<li><strong>Only placeholders.</strong> A MAC is only replaced when it matches the placeholder prefix set under Server Settings &rarr; Identification. A MAC an operator typed is never touched, whatever discovery saw. Paced like the setting above, and a gate that refuses a write is recorded as "Push failed" rather than retried every cycle.</li>' +
        '<li><strong>It rewrites the entry\'s description.</strong> Updating the reserved-address entry rewrites its description from Polaris\'s hostname/notes, so a description typed by hand on the FortiGate is replaced.</li>' +
      '</ul>' +
      calloutHTML("warning", "This writes DHCP configuration automatically", "Every other Polaris DHCP write is something an operator asked for on a specific IP. These two run on a schedule across the fleet. Enable them on one integration and check the result on a single gate before relying on them, and have someone who owns the network sign off &mdash; particularly for FortiLink pools, which the FortiGate manages itself.") +
    '</section>' +
    formDivider() +
    '<section style="margin-bottom:1.5rem">' +
      sectionHeading("Push Transport") +
      '<p class="hint" style="margin:0 0 0.25rem 0">Current setting: <strong style="color:var(--color-text-primary)">' + escapeHtml(modeLabel) + '</strong></p>' +
      '<p class="hint" style="margin:0">' + modeBody + '</p>' +
    '</section>' +
    formDivider() +
    '<section>' +
      permsHtml +
    '</section>' +
    formDivider() +
    '<section>' +
      sectionHeading("Stale Detection — ARP Presence Sweep") +
      '<p class="hint" style="margin:0 0 0.75rem 0">Improves stale-reservation detection for devices that never pull a lease (statically configured) or don\'t answer ping. Read-only on the device &mdash; nothing is written to the FortiGate.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<input type="checkbox" id="f-arpPresenceSweep" ' + arpChecked + ' style="width:auto">' +
        '<label for="f-arpPresenceSweep" style="margin:0">Probe reserved IPs before reading the ARP table</label>' +
      '</div>' +
      '<ul class="hint" style="margin:0.25rem 0 0 1.2rem;padding:0">' +
        '<li><strong>How it works.</strong> Right before each discovery cycle reads a FortiGate\'s ARP table, Polaris sends one fire-and-forget UDP packet to every active DHCP-reservation IP on that gate\'s subnets. Delivering the packet forces the FortiGate to ARP-resolve the target, and any live device answers ARP &mdash; even when it firewalls ICMP. A resolved entry matching the reserved MAC stamps the reservation as seen, keeping it out of the stale Alerts list.</li>' +
        '<li><strong>Reach &amp; policy.</strong> Only effective where Polaris can route to the subnet and firewall policy permits the traffic (UDP to port 33434). Where it can\'t, the sweep silently does nothing &mdash; a missing ARP entry is never treated as proof a device is gone.</li>' +
        '<li><strong>Visibility.</strong> The sweep is a small paced packet burst per gate, per discovery cycle. If you run IDS/IPS sensors on these segments, expect it to appear as a light scan from the Polaris host and allowlist accordingly.</li>' +
      '</ul>' +
    '</section>';
}

// Read the ARP presence-sweep toggle out of the DHCP Push tab. Returns
// undefined when the tab didn't render (non-FMG/FortiGate types) so the
// caller leaves the config field alone.
function _readArpPresenceSweepToggle() {
  var el = document.getElementById("f-arpPresenceSweep");
  if (!el) return undefined;
  return !!el.checked;
}

// Read the toggle's current value out of the Reservation Push tab. Returns
// undefined when the tab didn't render (non-FMG integration types) so the
// caller can leave the existing config alone.
function _readPushReservationsToggle() {
  var el = document.getElementById("f-pushReservations");
  if (!el) return undefined;
  return !!el.checked;
}

// Enable/disable BOTH nested DHCP-push children as the master is toggled.
// Global because it's wired as an inline onchange (the modal builds its tabs as
// HTML strings, and this file is a classic script — same idiom as the inline
// onclick="closeModal()" used by every modal footer). Unticking the master also
// clears each child so the disabled state and the value agree.
//
// Kept under its historical name: it's referenced from an inline onchange="…"
// string, so renaming it means renaming that too, and any stale copy of the
// markup would silently stop syncing.
function syncAutoReserveInfraEnabled() {
  var master = document.getElementById("f-pushReservations");
  if (!master) return;
  ["f-autoReserveFortinetInfra", "f-adoptDiscoveredMac"].forEach(function (id) {
    var child = document.getElementById(id);
    if (!child) return;
    child.disabled = !master.checked;
    if (!master.checked) child.checked = false;
  });
}

// Read the auto-reserve toggle out of the DHCP Push tab. Returns undefined when
// the tab didn't render. Forced false when the DHCP-push master is off, so an
// operator who unticks the parent can't leave a stale true behind in config —
// the server also refuses to act on it in that state.
function _readAutoReserveInfraToggle() {
  var el = document.getElementById("f-autoReserveFortinetInfra");
  if (!el) return undefined;
  var master = document.getElementById("f-pushReservations");
  if (master && !master.checked) return false;
  return !!el.checked;
}

// Same contract as _readAutoReserveInfraToggle, for the placeholder-MAC
// adoption toggle.
function _readAdoptDiscoveredMacToggle() {
  var el = document.getElementById("f-adoptDiscoveredMac");
  if (!el) return undefined;
  var master = document.getElementById("f-pushReservations");
  if (master && !master.checked) return false;
  return !!el.checked;
}

// SD-WAN tab body. Master toggle (config.pullSdwan) plus the stream's own
// polling interval (config.sdwanIntervalSeconds, default 60s). When enabled,
// FortiGates owned by this integration are polled for SD-WAN Performance SLA
// health-check metrics + service-rule member selection on that interval, which
// surface on the asset's SD-WAN tab. FortiOS-only; read-only on the device.
var SDWAN_INTERVAL_DEFAULT = 60;
function sdwanFormHTML(pullSdwan, intervalSec) {
  var checked = pullSdwan === true ? "checked" : "";
  var interval = Number(intervalSec) >= 60 ? Math.floor(Number(intervalSec)) : SDWAN_INTERVAL_DEFAULT;
  return '<section style="margin-bottom:1.5rem">' +
      sectionHeading("SD-WAN Monitoring") +
      '<p class="hint" style="margin:0 0 0.75rem 0">When enabled, Polaris polls each FortiGate for SD-WAN data on the interval below and shows it on the asset\'s <strong>SD-WAN</strong> tab. Read-only &mdash; nothing is written back to the device.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<input type="checkbox" id="f-pullSdwan" ' + checked + ' style="width:auto">' +
        '<label for="f-pullSdwan" style="margin:0">Pull SD-WAN Performance SLA + rule selection</label>' +
      '</div>' +
      '<div class="form-group"><label for="f-sdwanInterval">Polling Interval</label>' +
        '<div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-sdwanInterval" value="' + interval + '" min="60" max="86400" step="1" style="width:100px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">seconds</span></div>' +
        '<p class="hint">How often each FortiGate is asked for its SD-WAN health-checks and rule selection (60&ndash;86400 seconds; default 60). Independent of the interface polling interval. A shorter interval also shortens SD-WAN alert holds counted in polls.</p>' +
      '</div>' +
      '<ul class="hint" style="margin:0.25rem 0 0 1.2rem;padding:0">' +
        '<li><strong>Performance SLA health-checks.</strong> Per WAN-member latency, jitter and packet-loss from <code>/api/v2/monitor/virtual-wan/health-check</code>, charted over time.</li>' +
        '<li><strong>SD-WAN rules.</strong> Each service rule\'s configured members (priority order) and which member is currently selected, from <code>/api/v2/cmdb/system/sdwan</code>, with a selection-history timeline. The active member is inferred from health-check state when FortiOS doesn\'t expose it directly.</li>' +
      '</ul>' +
    '</section>' +
    formDivider() +
    '<section>' +
      sectionHeading("Required Read Access") +
      '<p class="hint" style="margin:0">The API token needs read access to <strong>System &rarr; SD-WAN</strong> (CMDB) and the SD-WAN monitor endpoints. No write access is required &mdash; this stream never modifies device configuration. FortiGates without SD-WAN configured simply report no data and the tab stays hidden.</p>' +
    '</section>';
}

// Read the SD-WAN toggle out of its tab. Returns undefined when the tab didn't
// render (non-FortiGate/FMG types) so the caller leaves the config alone.
function _readPullSdwanToggle() {
  var el = document.getElementById("f-pullSdwan");
  if (!el) return undefined;
  return !!el.checked;
}

// Read the SD-WAN polling interval. undefined when the tab didn't render; an
// out-of-range or blank entry is clamped to 60..86400 (blank = the default)
// rather than refused, matching how the monitor reads the stored value.
function _readSdwanInterval() {
  var el = document.getElementById("f-sdwanInterval");
  if (!el) return undefined;
  var n = Math.floor(Number(el.value));
  if (!isFinite(n) || n <= 0) return SDWAN_INTERVAL_DEFAULT;
  return Math.max(60, Math.min(86400, n));
}

// ─── Script Publishing tab (Entra ID) ──────────────────────────────────────
//
// The one WRITE capability on this integration. Everything else Entra does is
// read-only discovery, so the tab leads with what the operator has to change
// in Azure and what it costs them — not with the checkbox.
function scriptPublishingFormHTML(publishToIntune) {
  return '<section style="margin-bottom:1.5rem">' +
      sectionHeading("Publish deployment scripts to Intune") +
      '<p class="hint" style="margin:0 0 0.75rem 0">' +
        'Lets Polaris upload the Windows SSH onboarding scripts (Integrations &rarr; Polaris Agent &rarr; ' +
        'SSH Deployment) to Intune as a <strong>Remediation</strong>, instead of you downloading them and ' +
        'creating the policy by hand. Re-publishing updates the same policy rather than creating a second one.' +
      '</p>' +
      checkboxRow("f-publishToIntune", "Allow Polaris to publish scripts to Intune", publishToIntune === true) +
      formDivider() +
      sectionHeading("Required in Azure before this works") +
        '<ol class="hint" style="margin:0 0 0.5rem 0;padding-left:1.2rem">' +
          '<li>Open this app registration in <strong>Entra ID &rarr; App registrations &rarr; API permissions</strong>.</li>' +
          '<li>Add the <strong>Microsoft Graph &rarr; Application permission</strong> ' +
            '<code>DeviceManagementScripts.ReadWrite.All</code> &mdash; this is the scope Graph ' +
            'enforces on Remediations (<code>deviceHealthScripts</code>). Some tenants answer on an ' +
            'API version that asks for <code>DeviceManagementConfiguration.ReadWrite.All</code> ' +
            'instead; if publishing fails, the 403 names the scope that tenant wants &mdash; add that one.</li>' +
          '<li><strong>Grant admin consent</strong> for the tenant &mdash; application permissions do not work without it.</li>' +
        '</ol>' +
        '<p class="hint" style="margin:0">' +
          'Discovery keeps working on the read permissions it already has; this is additive. ' +
          'A newly granted permission reaches Polaris on its next access token, which it caches for up to ' +
          'an hour &mdash; a publish that fails right after the grant is retried automatically on a fresh ' +
          'token, so try it once more before assuming the grant did not take.' +
        '</p>' +
      calloutHTML("warning", "What you are granting",
        'This upgrades the credential from &ldquo;reads your device ' +
        'inventory&rdquo; to &ldquo;creates device-management policy across the tenant&rdquo;, and an application ' +
        'permission carries no user context &mdash; it acts tenant-wide. ' +
        '<strong>Polaris never assigns the policy.</strong> It is uploaded targeting nothing, because the script ' +
        'grants administrative SSH access to every device it eventually runs on; choosing those devices stays a ' +
        'human decision you make in the Intune console after reading the script.') +
    '</section>';
}

// Returns undefined when the tab didn't render, so saving from another tab
// leaves the stored value alone (same contract as _readPullSdwanToggle).
function _readPublishToIntuneToggle() {
  var el = document.getElementById("f-publishToIntune");
  if (!el) return undefined;
  return !!el.checked;
}

// ─── Script Publishing tab (Azure Arc) ─────────────────────────────────────
//
// The Arc twin of the Entra tab, but the warning is stronger and different:
// an Intune Remediation is inert until assigned, whereas an Arc run command
// EXECUTES on creation. There is no unassigned state to hand a reviewer, so
// the tab has to be explicit that enabling this means Polaris can run code as
// root/SYSTEM on machines you pick.
function arcScriptPublishingFormHTML(allowRunCommand) {
  return '<section style="margin-bottom:1.5rem">' +
      sectionHeading("Run deployment scripts on Arc machines") +
      '<p class="hint" style="margin:0 0 0.75rem 0">' +
        'Lets Polaris run the SSH onboarding script (Integrations &rarr; Polaris Agent &rarr; SSH Deployment) ' +
        'directly on Arc-connected machines via <strong>Run Command</strong>. This is how Linux and Windows ' +
        'Server get onboarded &mdash; Intune deploys scripts to neither.' +
      '</p>' +
      checkboxRow("f-allowRunCommand", "Allow Polaris to run deployment scripts", allowRunCommand === true) +
      formDivider() +
      sectionHeading("Required in Azure before this works") +
        '<ol class="hint" style="margin:0 0 0.5rem 0;padding-left:1.2rem">' +
          '<li>Discovery needs only <strong>Reader</strong>. Running scripts additionally needs all three of ' +
            '<code>Microsoft.HybridCompute/machines/read</code>, ' +
            '<code>Microsoft.HybridCompute/machines/runCommands/write</code> and ' +
            '<code>Microsoft.HybridCompute/machines/runCommands/read</code>. ' +
            'The last one is easy to miss and reads back the exit code and output &mdash; without it the script ' +
            'dispatches but no result ever comes back.</li>' +
          '<li>A <strong>custom role</strong> with exactly those three actions is the least-privilege option. The ' +
            'built-in <strong>Azure Connected Machine Resource Administrator</strong> also covers them, but it can ' +
            'additionally modify and delete Arc machine resources.</li>' +
          '<li>Assign it to this service principal at the <strong>subscription or resource-group scope</strong> ' +
            'covering the machines you intend to onboard. The principal is the app\'s entry under ' +
            '<strong>Entra ID &rarr; Enterprise applications</strong> &mdash; search by <strong>Application (client) ID</strong>. ' +
            '<strong>Keep the existing Reader assignment</strong>; Azure roles are additive and discovery still needs it.</li>' +
          '<li>Allow a few minutes for the assignment to propagate. A 403 immediately after assigning usually means ' +
            '&ldquo;not yet&rdquo;, not &ldquo;wrong role&rdquo; &mdash; re-check only if it persists.</li>' +
        '</ol>' +
        '<p class="hint" style="margin:0">' +
          'Note this is an <strong>Azure RBAC role assignment</strong>, not a Graph API permission &mdash; a ' +
          'different mechanism from the Entra/Intune side, and a common point of confusion.' +
        '</p>' +
      calloutHTML("warning", "A run command executes immediately",
        'Unlike an Intune Remediation there is no unassigned ' +
        'state to review first &mdash; creating one runs the script as root/SYSTEM on that machine. Polaris will ' +
        'only ever target machines you explicitly select, and asks for confirmation with the count, but the ' +
        'selection you make IS the review step. The script grants administrative SSH access to every machine it ' +
        'runs on.') +
    '</section>';
}

function _readAllowRunCommandToggle() {
  var el = document.getElementById("f-allowRunCommand");
  if (!el) return undefined;
  return !!el.checked;
}

// Read the FortiLink-LLDP-exclusion toggle out of the Monitoring tab's LLDP
// subtab. Returns undefined when the checkbox didn't render (non-FortiGate/FMG
// types) so the caller leaves the config field alone.
function _readExcludeFortilinkLldpToggle() {
  var el = document.getElementById("f-excludeFortilinkLldp");
  if (!el) return undefined;
  return !!el.checked;
}

// Read the presence-verification toggle from the AD/Entra Monitoring tab.
// Returns undefined when the checkbox didn't render (other integration types)
// so the caller leaves the config field alone.
function _readVerifyPresenceToggle() {
  var el = document.getElementById("f-verifyPresence");
  if (!el) return undefined;
  return !!el.checked;
}

// Read the address-book directory-search toggle (AD/Entra Monitoring tab).
// undefined when the checkbox didn't render, so the caller leaves the config
// field alone for other integration types.
function _readDirectorySearchToggle() {
  var el = document.getElementById("f-enableDirectorySearch");
  if (!el) return undefined;
  return !!el.checked;
}


// ─── Directory tab (AD / Entra only) ────────────────────────────────────────
//
// Both address-book directory controls live here, together, because they are
// one subject with one crucial difference between them: SEARCH reads the
// directory live and stores nothing; SYNC stores the roster. Putting them side
// by side is what makes that contrast legible — it used to be implied by
// distance, with the search toggle sitting under the Monitoring tab's
// "per-class polling, cadences and credentials" header, which it is not.

function directoryFormHTML(integrationType, cfg) {
  var c = cfg || {};
  var sync = c.directorySync || {};
  var isEntra = integrationType === "entraid";

  var perms = isEntra
    ? "Requires the Graph application permissions <strong>User.Read.All</strong>, <strong>Group.Read.All</strong> and <strong>OrgContact.Read.All</strong> (or <strong>Directory.Read.All</strong>), admin-consented on the app registration — device discovery alone does not grant them."
    : "Requires the bind account to have read access to user, group and contact objects under the base DN — device discovery only reads computer objects.";

  // Said plainly, because it is the decision an operator is actually making.
  var piiWarning = calloutHTML(
    "warning",
    "Switching this on stores your directory in Polaris",
    "Every matching person's name, email address, job title, department and phone number is written to the " +
    "Polaris database and is included in <strong>every backup</strong>, including off-host copies. Entries are " +
    "visible only to roles holding <strong>Automation Management</strong> access. Someone who leaves the directory " +
    "is removed here on the next discovery run. Granting the directory permissions above, and accepting this " +
    "retention, should be reviewed by whoever owns your directory.",
  );

  var mailboxNote = isEntra
    ? calloutHTML(
        "note",
        "Microsoft Graph cannot identify shared mailboxes",
        "Graph reports no mailbox type for a user without a separate per-person request, which would mean one " +
        "extra call for every entry on every run. Shared, room and equipment mailboxes are therefore <strong>not</strong> " +
        "excluded automatically here — use the name or domain exclusions below for them. (The Active Directory " +
        "integration can exclude them properly, from the Exchange schema.)",
      )
    : "";

  function checkbox(id, label, on, hint) {
    return '<div class="form-group" style="display:flex;align-items:flex-start;gap:8px;margin:0 0 0.75rem 0">' +
        '<input type="checkbox" id="' + id + '" ' + (on ? "checked" : "") + ' style="width:auto;margin-top:3px">' +
        '<div><label for="' + id + '" style="margin:0">' + label + '</label>' +
        (hint ? '<p class="hint" style="margin:0.15rem 0 0 0">' + hint + '</p>' : "") + '</div>' +
      '</div>';
  }

  function listField(id, label, value, hint) {
    return '<div class="form-group">' +
        '<label for="' + id + '">' + label + '</label>' +
        '<textarea id="' + id + '" rows="2" placeholder="One per line">' +
          escapeHtml((value || []).join("\n")) +
        '</textarea>' +
        '<p class="hint" style="margin:0.15rem 0 0 0">' + hint + '</p>' +
      '</div>';
  }

  var ouFields = isEntra ? "" : (
    listField("f-ds-ouInclude", "Only these OUs", sync.ouInclude,
      "Distinguished-name patterns, <code>*</code> matches anything — e.g. <code>*OU=Staff,DC=corp,DC=example</code>. " +
      "When set, everything outside them is excluded and the exclusion list below is ignored.") +
    listField("f-ds-ouExclude", "Exclude these OUs", sync.ouExclude,
      "Same pattern syntax. Used only when no include list is set.")
  );

  return '<section>' +
      '<p class="hint" style="margin:0 0 0.85rem 0">' +
        "How this directory feeds the Polaris address book. " + perms +
      '</p>' +

      sectionHeading("Look up people as you type") +
      checkbox("f-enableDirectorySearch", "Search this directory from the address book",
        c.enableDirectorySearch === true,
        "Lets the automation recipient picker look up people, distribution lists and org contacts as an operator " +
        "types. Results are <strong>live and never stored</strong> — only an address someone actually picks is saved.") +

      sectionHeading("Keep the address book in step with the directory") +
      checkbox("f-enableDirectorySync", "Sync this directory into the address book",
        c.enableDirectorySync === true,
        "Runs at the end of every discovery for this integration. Adds a contact for each person who matches, " +
        "keeps their details current, and removes them when they leave the directory. Contacts you added by " +
        "hand are never touched.") +
      piiWarning +

      '<div id="intg-ds-detail" style="' + (c.enableDirectorySync === true ? "" : "display:none") + ';margin-top:1rem">' +
        mailboxNote +
        checkbox("f-ds-excludeDisabled", "Skip disabled accounts", sync.excludeDisabled !== false, "") +
        checkbox("f-ds-excludeSharedMailboxes", "Skip shared, room and equipment mailboxes",
          sync.excludeSharedMailboxes !== false,
          isEntra ? "Has no effect on Entra ID — see the note above." : "Read from the Exchange schema where it is present.") +
        checkbox("f-ds-includeGroups", "Include distribution lists", sync.includeGroups !== false,
          "Mail-enabled groups, so an alert can go to a team rather than a person.") +
        checkbox("f-ds-includeOrgContacts", "Include external org contacts", sync.includeOrgContacts === true,
          "Off by default — these are people outside your organization.") +
        ouFields +
        listField("f-ds-domainInclude", "Only these email domains", sync.domainInclude,
          "One domain per line, e.g. <code>example.com</code>. When set, the exclusion list below is ignored.") +
        listField("f-ds-domainExclude", "Exclude these email domains", sync.domainExclude,
          "Used only when no include list is set.") +
        listField("f-ds-nameExclude", "Exclude by name or address", sync.nameExclude,
          "Patterns matched against the display name AND the address, <code>*</code> matches anything — " +
          "e.g. <code>svc-*</code> or <code>noreply@*</code>. This is where shared and no-reply mailboxes go.") +
        listField("f-ds-groupExclude", "Exclude members of these groups", sync.groupExclude,
          isEntra ? "Group object IDs." : "Group distinguished names.") +
        '<div class="form-group">' +
          '<label for="f-ds-maxEntries">Maximum entries per run</label>' +
          '<input type="number" id="f-ds-maxEntries" min="1" max="50000" value="' + (Number(sync.maxEntries) || 20000) + '">' +
          '<p class="hint" style="margin:0.15rem 0 0 0">A safety stop, not a target. If a run hits it, the run says so.</p>' +
        '</div>' +
      '</div>' +
    '</section>';
}

// Reveal the exclusion panel with the toggle. Wired alongside the modal tabs,
// so it applies to both the add and edit flows.
function _wireDirectorySyncToggle() {
  var cb = document.getElementById("f-enableDirectorySync");
  var panel = document.getElementById("intg-ds-detail");
  if (!cb || !panel) return;
  cb.addEventListener("change", function () {
    panel.style.display = cb.checked ? "" : "none";
  });
}

// Read the Directory tab back. Returns undefined when the tab didn't render,
// so the caller leaves the config alone for other integration types.
function _readDirectorySyncConfig() {
  var cb = document.getElementById("f-enableDirectorySync");
  if (!cb) return undefined;
  function lines(id) {
    var el = document.getElementById(id);
    if (!el) return [];
    return String(el.value || "").split(/\r?\n/).map(function (x) { return x.trim(); })
      .filter(function (x) { return x !== ""; });
  }
  function checked(id, dflt) {
    var el = document.getElementById(id);
    return el ? !!el.checked : dflt;
  }
  var cap = parseInt(String((document.getElementById("f-ds-maxEntries") || {}).value || ""), 10);
  return {
    enabled: !!cb.checked,
    filter: {
      excludeDisabled: checked("f-ds-excludeDisabled", true),
      excludeSharedMailboxes: checked("f-ds-excludeSharedMailboxes", true),
      includeGroups: checked("f-ds-includeGroups", true),
      includeOrgContacts: checked("f-ds-includeOrgContacts", false),
      ouInclude: lines("f-ds-ouInclude"),
      ouExclude: lines("f-ds-ouExclude"),
      domainInclude: lines("f-ds-domainInclude"),
      domainExclude: lines("f-ds-domainExclude"),
      nameExclude: lines("f-ds-nameExclude"),
      groupExclude: lines("f-ds-groupExclude"),
      maxEntries: isFinite(cap) && cap > 0 ? cap : 20000,
    },
  };
}

// Required-permission copy for a write that goes DIRECT to a FortiGate's REST
// API. A standalone FortiGate integration has no other transport — there is no
// FortiManager in front of it, so `buildTransportForIntegration` always hands
// back a direct-fortigate transport — and the FMG copy the three push tabs
// otherwise render names FortiManager's admin profile, which on an install with
// no FortiManager points the operator at a device that isn't there. What
// actually authorizes the write is the FortiOS REST-API admin's access profile
// on the gate itself.
//
// `verifyPath` is the CMDB tree the feature writes, so the grant is provable
// with one read from the integration's Query API tab instead of being
// discovered as a failed push. Shared by all three tabs so a fourth caller
// can't reintroduce a two-transport assumption.
//
// `fleet` = FMG "bypass the proxy" direct mode: the same FortiOS grant, but on
// every managed gate's REST API admin (the per-device token on the Settings
// tab) rather than one gate's General-tab token.
function _fortigateAccessProfileHTML(noun, grants, verifyPath, fleet) {
  var rows = "";
  for (var i = 0; i < grants.length; i++) rows += '<li>' + grants[i] + '</li>';
  var intro = fleet
    ? 'Polaris writes ' + noun + ' straight to each FortiGate\'s REST API using the per-device API token on the Monitoring tab (FortiGate subtab) &mdash; FortiManager is not in the path. That REST API admin, on every managed FortiGate, needs an access profile granting:'
    : 'Polaris writes ' + noun + ' straight to this FortiGate\'s REST API using the API token on the General tab. That token\'s REST API admin needs an access profile granting:';
  var verifyWhere = fleet
    ? ' to one of the FortiGates, authenticated with that token. '
    : ' from this integration\'s Query API tab. ';
  return sectionHeading("Required FortiGate Access Profile") +
    '<p class="hint" style="margin:0 0 0.75rem 0">' + intro + '</p>' +
    '<ul class="hint" style="margin:0 0 0.75rem 1.2rem;padding:0">' + rows + '</ul>' +
    calloutHTML("tip", "Verify the grant before you need it",
      'Send <code>GET ' + escapeHtml(verifyPath) + '</code>' + verifyWhere +
      '<strong>200</strong> means the profile and the vdom are both right; <strong>403</strong> means the profile ' +
      'does not cover this tree, or the Polaris host sits outside the admin\'s <em>trusthost</em>; ' +
      '<strong>404</strong> means this FortiOS build does not expose it. Add <code>action=schema</code> as a ' +
      'query parameter and the gate returns the table\'s own definition &mdash; every field with its ' +
      'size, plus the <code>access_group</code> naming the profile group above. That is the authority for this ' +
      'build, not this page.') +
    calloutHTML("warning", "Scope the token",
      "Grant only the groups above and set the REST API admin's <strong>trusthost</strong> to the Polaris host's " +
      "address. A FortiOS access profile is per-group, not per-object, so Read-Write on a group covers every " +
      "configuration tree inside it. Treat the token as a privileged credential and rotate it on the same " +
      "cadence as your other admin secrets.");
}

// Quarantine Push tab body. Renders the master toggle plus transport-mode
// guidance. When enabled, quarantining an asset pushes MAC-based
// address-group entries to every FortiGate sighted by this integration.
// `pushQuarantine` is the current toggle value; `useProxy` drives the
// transport mode label.
function quarantinePushFormHTML(pushQuarantine, useProxy, type) {
  var checked = pushQuarantine === true ? "checked" : "";
  var isStandalone = type === "fortigate";
  var modeLabel = isStandalone
    ? "Direct to the FortiGate"
    : (useProxy === false)
      ? "Direct to each FortiGate"
      : "Proxy through FortiManager to each FortiGate";
  var modeBody = isStandalone
    ? "Quarantine entries are written straight to this FortiGate's REST API using the API token on the General tab."
    : (useProxy === false)
      ? "Quarantine entries are written to each FortiGate's REST API using the per-device API token on the Monitoring tab (FortiGate subtab)."
      : "Quarantine entries are written through FortiManager's <code>/sys/proxy/json</code> endpoint, which forwards the call to the target FortiGate using FortiManager's stored device credentials.";
  var permsHtml = isStandalone
    ? _fortigateAccessProfileHTML(
        "quarantine entries",
        ['<strong>WiFi &amp; Switch Controller</strong> &rarr; Read-Write &nbsp;<span style="color:var(--color-text-tertiary)">&larr; <code>user.quarantine</code> reports <code>access_group: wifi</code>, which is this group &mdash; not User &amp; Device, where the tree\'s name suggests it would live</span>'],
        "/api/v2/cmdb/user/quarantine/targets",
      )
    : (sectionHeading("Required FortiManager Admin Profile") +
      '<p class="hint" style="margin:0 0 0.75rem 0">The following permission changes are needed on the FortiManager admin profile Polaris uses:</p>' +
      '<ul class="hint" style="margin:0 0 0.75rem 1.2rem;padding:0">' +
        '<li><strong>Device Manager</strong> &rarr; Read-Write</li>' +
        '<li style="margin-left:1.2rem"><strong>Manage Device Configurations</strong> &rarr; Read-Write</li>' +
        '<li>All other Device Manager sub-items &mdash; leave at Read-Only or None</li>' +
      '</ul>' +
      calloutHTML("warning", "Blast radius", "FortiManager admin profiles do not have a per-object permission for quarantine. <strong>Manage Device Configurations</strong> grants write access to every CMDB tree on every FortiGate in this ADOM. Treat the API token as a privileged credential and rotate on the same cadence as your other admin secrets."));
  return '<section style="margin-bottom:1.5rem">' +
      sectionHeading("Quarantine Push") +
      '<p class="hint" style="margin:0 0 0.75rem 0">When enabled, quarantining an asset writes its MAC addresses into the FortiGate&rsquo;s quarantine table (<code>user.quarantine</code>) on every device that has recently sighted it, with traffic dropping enabled &mdash; which is the part that actually blocks the device. Releasing quarantine removes the entry again. The gate&rsquo;s own quarantine entries are left untouched.</p>' +
      '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
        '<input type="checkbox" id="f-pushQuarantine" ' + checked + ' style="width:auto">' +
        '<label for="f-pushQuarantine" style="margin:0">Push asset quarantine entries from Polaris back to FortiGate</label>' +
      '</div>' +
    '</section>' +
    formDivider() +
    '<section style="margin-bottom:1.5rem">' +
      sectionHeading("Push Transport") +
      '<p class="hint" style="margin:0 0 0.25rem 0">Current setting: <strong style="color:var(--color-text-primary)">' + escapeHtml(modeLabel) + '</strong></p>' +
      '<p class="hint" style="margin:0">' + modeBody + '</p>' +
    '</section>' +
    formDivider() +
    '<section>' +
      permsHtml +
    '</section>';
}

// Read the quarantine push toggle. Returns undefined when the tab didn't render.
function _readPushQuarantineToggle() {
  var el = document.getElementById("f-pushQuarantine");
  if (!el) return undefined;
  return !!el.checked;
}

// Label for the FMG central-management detail rows (integration list, after
// the FMG Proxy row). `cm` = config.centralManagement, stamped by discovery
// (detectCentralManagement); absent until the first discovery after upgrade.
function _centralMgmtLabel(cm, key, countKey, noun) {
  if (!cm || typeof cm[key] !== "boolean") return "Unknown (detected at next discovery)";
  if (!cm[key]) return "Disabled (per-device — descriptions write to the device DB)";
  // Count only when the ADOM object table holds rows — AP rows normally live
  // in each controller's device DB, so 0 here is expected, not meaningful.
  var count = typeof cm[countKey] === "number" && cm[countKey] > 0 ? cm[countKey] : null;
  return "Enabled" + (count !== null ? " (" + count + " " + noun + (count === 1 ? "" : "s") + ")" : "") + " — description pushes mirror to FortiManager";
}

// Per-device-class Description Sync toggles, resolved the way the server does
// (src/utils/descriptionSyncFlags.ts): a class whose key was never written
// inherits the legacy `syncDescriptions` master toggle.
var DESCRIPTION_SYNC_KEYS = {
  fortigate:   "syncFortigateDescriptions",
  fortiswitch: "syncSwitchDescriptions",
  fortiap:     "syncApDescriptions",
};
function _descriptionSyncFlags(config) {
  var cfg = config || {};
  var legacy = cfg.syncDescriptions === true;
  var out = {};
  Object.keys(DESCRIPTION_SYNC_KEYS).forEach(function (role) {
    var v = cfg[DESCRIPTION_SYNC_KEYS[role]];
    out[role] = typeof v === "boolean" ? v : legacy;
  });
  return out;
}

// Description Sync tab body. One toggle per device class — FortiGates,
// FortiSwitches, FortiAPs (see _descriptionSyncFlags). Polaris-primary: a
// non-empty Polaris value wins, an empty one adopts the device value. `flags`
// is the resolved {fortigate, fortiswitch, fortiap}; `useProxy` drives the
// transport-mode label.
function descriptionSyncFormHTML(flags, useProxy, type) {
  flags = flags || {};
  // Three transports, not two. FMG proxy and FMG "bypass the proxy" direct mode
  // both sit behind a FortiManager; a standalone FortiGate has none at all
  // (buildTransportForIntegration always returns a direct-fortigate transport
  // for the type), so naming one anywhere on this tab points the operator at a
  // device the install does not have.
  var isStandalone = type === "fortigate";
  var modeLabel = isStandalone
    ? "Direct to the FortiGate"
    : (useProxy === false)
      ? "Direct to each FortiGate"
      : "Proxy through FortiManager to each FortiGate";
  var modeBody = isStandalone
    ? "Description writes go straight to this FortiGate's REST API using the API token on the General tab."
    : (useProxy === false)
      ? "Description writes go to each FortiGate's REST API using the per-device API token on the Monitoring tab (FortiGate subtab). FortiManager is bypassed entirely."
      : "Description writes go through FortiManager's <code>/sys/proxy/json</code> endpoint, which forwards the call to the target FortiGate using FortiManager's stored device credentials.";
  // Not FMG copy — Polaris-is-primary holds on every transport — so this rides
  // both branches, naming only the devices this integration writes to.
  var overwriteCallout = calloutHTML("warning", "Polaris overwrites device-side edits", "A description set in Polaris is authoritative: it is pushed on save and re-pushed whenever the device drifts, so a description edited directly on " + (isStandalone ? "the FortiGate" : "a FortiGate / in FortiManager") + " will be overwritten on the next cycle (audited). To take a device-side value into Polaris instead, clear the Polaris description — the next discovery adopts it.");
  // Describes a mirror into FortiManager's own AP / FortiSwitch database. There
  // is no such database without a FortiManager.
  var fmgMirrorBullet = isStandalone ? "" :
        '<li><strong>FMG central management.</strong> When this ADOM centrally manages FortiAPs or FortiSwitches (detected at each discovery; shown on the integration card), pushes for that class are also mirrored into FortiManager\'s AP Manager / FortiSwitch Manager database so a later install doesn\'t revert them. Polaris never triggers an install.</li>';
  // Direct writes (standalone, or FMG bypassing the proxy) are authorized by
  // the FortiOS access profile on the gate. The FortiGate alias lives in
  // system/global, which FortiOS files under the System group, not Network —
  // without System Read-Write the alias PUT is refused while interface
  // descriptions (Network) still go through, so the feature looks half-working.
  var fgtGrants = [
    '<strong>System</strong> &rarr; Read-Write &nbsp;<span style="color:var(--color-text-tertiary)">&larr; the FortiGate alias (<code>system/global</code>) &mdash; required, description sync fails without it</span>',
    '<strong>Network</strong> &rarr; Custom &rarr; <strong>Configuration</strong> &rarr; Read-Write &nbsp;<span style="color:var(--color-text-tertiary)">&larr; interface descriptions</span>',
    '<strong>WiFi &amp; Switch Controller</strong> &rarr; Read-Write &nbsp;<span style="color:var(--color-text-tertiary)">&larr; only if this gate manages FortiSwitches / FortiAPs</span>',
  ];
  var systemGroupCallout = calloutHTML("warning", "System Read-Write is broad", "The System group also covers administrators, access profiles and global settings. FortiOS has no narrower grant that reaches the alias, so treat this token as an admin-grade credential.");
  var fmgProfileHtml = function (heading, intro) {
    return sectionHeading(heading) +
      '<p class="hint" style="margin:0 0 0.75rem 0">' + intro + '</p>' +
      '<ul class="hint" style="margin:0 0 0.75rem 1.2rem;padding:0">' +
      '<li><strong>Device Manager</strong> &rarr; Read-Write</li>' +
      '<li style="margin-left:1.2rem"><strong>Manage Device Configurations</strong> &rarr; Read-Write</li>' +
      '<li>All other Device Manager sub-items &mdash; leave at Read-Only or None</li>' +
      '</ul>' +
      calloutHTML("warning", "Blast radius", "FortiManager admin profiles do not have a per-object permission for descriptions. <strong>Manage Device Configurations</strong> grants write access to every CMDB tree on every FortiGate in this ADOM. Treat the API token as a privileged credential and rotate on the same cadence as your other admin secrets.");
  };
  var permsHtml = isStandalone
    ? _fortigateAccessProfileHTML("descriptions", fgtGrants, "/api/v2/cmdb/system/global") + systemGroupCallout + overwriteCallout
    : (useProxy === false)
      // Direct mode: the device writes never touch FortiManager, but the
      // central-management mirror is still an FMG JSON-RPC call.
      ? _fortigateAccessProfileHTML("descriptions", fgtGrants, "/api/v2/cmdb/system/global", true) + systemGroupCallout +
        formDivider() +
        fmgProfileHtml("Required FortiManager Admin Profile (central-management mirror only)", "Only needed when this ADOM centrally manages FortiAPs or FortiSwitches: Polaris mirrors those pushes into FortiManager's own database over its API, which needs these permissions on the FortiManager admin profile Polaris uses:") +
        overwriteCallout
      : fmgProfileHtml("Required FortiManager Admin Profile", "The following permission changes are needed on the FortiManager admin profile Polaris uses:") + overwriteCallout;
  return '<section style="margin-bottom:1.5rem">' +
      sectionHeading("Description Sync") +
      '<p class="hint" style="margin:0 0 0.75rem 0"><strong style="color:var(--color-text-primary)">Polaris is primary.</strong> A value in Polaris always wins: it pushes to the device on save and re-asserts on every discovery cycle — device-side edits are overwritten (every change is audited). An empty Polaris field adopts the device\'s value instead.</p>' +
      _descriptionSyncToggleRow("fortigate", flags.fortigate, "Sync FortiGate descriptions", "the FortiGate alias and interface comments") +
      _descriptionSyncToggleRow("fortiswitch", flags.fortiswitch, "Sync FortiSwitch descriptions", "managed switch descriptions and port descriptions") +
      _descriptionSyncToggleRow("fortiap", flags.fortiap, "Sync FortiAP descriptions", "the managed access point location field") +
      (isStandalone ? "" : calloutHTML("warning", "FortiAP descriptions through FortiManager: use with caution",
        "FortiManager access point description sync is not implemented well. AP Manager keeps its own copy of each AP's location, and Polaris only mirrors into it when central AP management is detected &mdash; a FortiManager install can still revert or overwrite what Polaris pushed. Try it on a few APs before turning it on for a whole ADOM.")) +
      '<ul class="hint" style="margin:0.25rem 0 0 1.2rem;padding:0">' +
        '<li><strong>Interface comments.</strong> The Interface Comments box on an asset\'s interface panel writes to the FortiGate\'s <code>system/interface</code> description (or the FortiSwitch port description via the parent controller). Clearing a comment in Polaris leaves the device value in place.</li>' +
        '<li><strong>Device descriptions.</strong> An asset\'s Description field writes to the FortiGate alias, FortiSwitch description, or FortiAP location' + (isStandalone ? "" : " (the field FortiManager's AP Manager shows)") + '. An empty Polaris Description is seeded from the device on the next discovery.</li>' +
        '<li><strong>When it runs.</strong> Immediately on save, plus a reconcile on every discovery cycle that re-pushes after transient failures, re-asserts Polaris values over device-side edits, and seeds empty Polaris fields from the device.</li>' +
        fmgMirrorBullet +
      '</ul>' +
    '</section>' +
    formDivider() +
    '<section style="margin-bottom:1.5rem">' +
      sectionHeading("Push Transport") +
      '<p class="hint" style="margin:0 0 0.25rem 0">Current setting: <strong style="color:var(--color-text-primary)">' + escapeHtml(modeLabel) + '</strong></p>' +
      '<p class="hint" style="margin:0">' + modeBody + '</p>' +
    '</section>' +
    formDivider() +
    '<section>' +
      permsHtml +
    '</section>';
}

function _descriptionSyncToggleRow(role, on, label, what) {
  var id = "f-" + DESCRIPTION_SYNC_KEYS[role];
  return '<div class="form-group" style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
    '<input type="checkbox" id="' + id + '" ' + (on === true ? "checked" : "") + ' style="width:auto" onchange="onSyncDescriptionsToggle(this, ' + jsArg(role) + ')">' +
    '<label for="' + id + '" style="margin:0">' + escapeHtml(label) +
      ' <span style="color:var(--color-text-tertiary)">&mdash; ' + escapeHtml(what) + '</span></label>' +
  '</div>';
}

// Read the three description sync toggles as config keys. Returns undefined
// when the tab didn't render. The legacy `syncDescriptions` key is written as
// "any class on" so API readers of the old key still see a truthful value; the
// per-class keys are always written, so the legacy fallback never applies to
// an integration saved from this form.
function _readSyncDescriptionsToggles() {
  var out = {};
  var any = false;
  var rendered = false;
  Object.keys(DESCRIPTION_SYNC_KEYS).forEach(function (role) {
    var key = DESCRIPTION_SYNC_KEYS[role];
    var el = document.getElementById("f-" + key);
    if (!el) return;
    rendered = true;
    out[key] = !!el.checked;
    if (el.checked) any = true;
  });
  if (!rendered) return undefined;
  out.syncDescriptions = any;
  return out;
}

// Device-side field length per class, for the enable confirm below. Keep in
// lockstep with DESCRIPTION_CAPS in descriptionSyncService.ts.
var DESCRIPTION_SYNC_CAP_COPY = {
  fortigate:   "FortiOS limits the FortiGate alias to 35 characters (interface comments allow 255).",
  fortiswitch: "FortiOS limits the FortiSwitch description and port descriptions to 63 characters.",
  fortiap:     "FortiOS limits the FortiAP location field to 35 characters.",
};
var DESCRIPTION_SYNC_NOUN = { fortigate: "FortiGate", fortiswitch: "FortiSwitch", fortiap: "FortiAP" };

// Fires the moment the operator flips a Description Sync toggle ON: confirm
// that class's field-length caveat before letting the box stay checked.
// Declining reverts the toggle. No-op on un-check. showConfirm (app.js) stacks
// its own overlay above the open integration modal, so the edit form's DOM
// survives.
function onSyncDescriptionsToggle(el, role) {
  if (!el || !el.checked) return;
  var noun = DESCRIPTION_SYNC_NOUN[role] || "device";
  showConfirm(
    "Enable " + noun + " Description Sync?\n\n" +
    (DESCRIPTION_SYNC_CAP_COPY[role] || "Device description fields are short.") + "\n\n" +
    "Polaris does not shorten what you type — it keeps the full description " +
    "and warns on the asset's Description field when the value is longer than " +
    "the device allows. The push truncates it to fit."
  ).then(function (ok) {
    if (!ok) el.checked = false;
  });
}

