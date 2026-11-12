/**
 * public/js/assets-form.js — the Add / Edit asset form: the asset form fields and their checks, the
 * tabbed modal scaffolding, the Monitoring and Maintenance edit tabs with
 * the per-stream credential picker and overrides, and the Monitoring
 * Settings modal (bulkSetMonitoring).
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// Second line under a PINNED hostname: what discovery still calls the device.
// `hostnameOverride` makes the operator's value the effective hostname, so the
// discovered name lives nowhere on the asset row — the list endpoint projects it
// from the AssetSource blobs as `hostnameDiscovered` for pinned rows only. Empty
// when nothing is pinned, when no source has a hostname opinion (a manually
// created asset has no original), or when discovery happens to agree with the
// pin — a duplicate line would say nothing.
// ─── Active-alert indicator ──────────────────────────────────────────────────
//
// `assetAlertStrobeColor`, `_alertSevRank` and `assetAlertDotHTML` MOVED to
// public/js/app.js — the global search dropdown needed the same dot, and it
// renders on every page, half of which never load this file. They are globals
// there and callable from here unchanged; `_paintAssetAlertsTabStrobe` below
// stays, being about this file's own slide-over.

/**
 * The slide-over's Alerts TAB, strobing in the same colour for the same reason.
 *
 * Driven from the alerts the tab itself just loaded rather than from a second
 * payload — so it is right the moment the tab renders, and re-running the
 * loader after an acknowledge or a clear settles it with no page refresh. An
 * EMPTY list clears the marking, which is the state that matters most: the last
 * alert being cleared has to stop the strobe, not leave it running until the
 * panel is closed.
 */
function _paintAssetAlertsTabStrobe(alerts) {
  var tab = document.querySelector('#asset-view-tabs .page-tab[data-tab="notifications"]');
  if (!tab) return;
  var worst = null;
  var unacked = 0;
  (alerts || []).forEach(function (n) {
    if (!n.acknowledged) unacked += 1;
    if (!worst || _alertSevRank(n.severity) > _alertSevRank(worst)) worst = n.severity;
  });
  tab.classList.toggle("alert-strobe", !!worst);
  tab.classList.toggle("is-handled", !!worst && unacked === 0);
  if (worst) tab.style.setProperty("--strobe-color", assetAlertStrobeColor(worst));
  else tab.style.removeProperty("--strobe-color");
}

function hostnameOriginalLineHTML(asset) {
  if (!asset.hostnameOverride) return "";
  var orig = asset.hostnameDiscovered;
  if (!orig || orig === asset.hostname) return "";
  return '<br><span class="hostname-original" title="Hostname manually overridden. ' +
    'Discovery reports this device as &quot;' + escapeHtml(orig) + '&quot; — clear the Hostname ' +
    'field in Edit to resume the discovered value.">' + escapeHtml(orig) + '</span>';
}

function ipCellHTML(asset) {
  var primary = asset.ipAddress;
  var ips = Array.isArray(asset.associatedIps) ? asset.associatedIps : [];
  if (!primary && ips.length === 0) {
    // HA standby FortiGate: Asset.ipAddress is deliberately null (the cluster
    // IP routes only to the active member), but the shared cluster IP is
    // stamped as display metadata — show it dimmed with a "(cluster)" marker
    // so the row isn't a bare dash. Copy still copies the raw IP.
    var haInfo = assetHaInfo(asset);
    if (haInfo && haInfo.role === "secondary" && haInfo.clusterIp) {
      return '<span class="copy-cell" style="color:var(--color-text-secondary)" ' +
        'title="Cluster IP — routes to the active (primary) HA member. Click to copy" data-copy="' +
        escapeHtml(haInfo.clusterIp) + '">' + escapeHtml(haInfo.clusterIp) +
        ' <span style="font-size:0.75em">(cluster)</span></span>';
    }
    return '-';
  }
  // Rule 103: the list carries { score, band } per address — a plain chip
  // whose title names it (the IP's own +N hover can't hold a nested one).
  if (ips.length === 0) {
    return '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(primary) + '">' + escapeHtml(primary) + '</span>' +
      addressConfidenceChipHTML(asset, primary, { plain: true });
  }

  var displayIp = primary || ips[0].ip;
  var tooltipRows = ips.map(function (entry) {
    var metaBits = [];
    if (entry.ptrName) metaBits.push('<span class="mac-tooltip-subnet">' + escapeHtml(entry.ptrName) + '</span>');
    if (entry.interfaceName) metaBits.push('<span class="mac-tooltip-subnet">' + escapeHtml(entry.interfaceName) + '</span>');
    var sourceLine = (entry.source ? escapeHtml(formatAddressSource(entry.source)) : '') +
      (entry.device ? ' &middot; ' + escapeHtml(entry.device) : '') +
      (entry.lastSeen ? ' &middot; ' + formatDate(entry.lastSeen) : '');
    return '<div class="mac-tooltip-row">' +
      '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(entry.ip) + '">' + escapeHtml(entry.ip) + '</span>' +
      addressConfidenceChipHTML(asset, entry.ip, { plain: true }) +
      '<span class="mac-tooltip-meta">' +
        metaBits.join('') +
        '<span class="mac-tooltip-source">' + sourceLine + '</span>' +
      '</span>' +
    '</div>';
  }).join("");

  return '<span class="mac-hover-trigger">' +
    '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(displayIp) + '">' + escapeHtml(displayIp) + '</span>' +
    addressConfidenceChipHTML(asset, displayIp, { plain: true }) +
    '<span class="mac-badge-count">+' + ips.length + '</span>' +
    '<div class="mac-tooltip">' +
      '<div class="mac-tooltip-header">Associated IPs</div>' +
      tooltipRows +
    '</div>' +
  '</span>';
}

function macCellHTML(asset) {
  var macs = asset.macAddresses || [];
  var primary = asset.macAddress;
  if (!primary && macs.length === 0) return '-';

  var displayMac = primary || (macs.length > 0 ? macEntryText(macs[0]) : "-");
  if (macs.length <= 1) return '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(displayMac) + '">' + escapeHtml(displayMac) + '</span>';

  // Gated on the SAME grant the endpoint checks (assets:write, i.e. the
  // assets-admin role), not on subnets:fullwrite as it was: an asset
  // administrator is exactly who corrects a wrong MAC association, and the
  // mismatch meant the one role that could call DELETE /assets/:id/macs/:mac
  // never saw the button that calls it.
  var canDelete = canManageAssets();

  // Multiple MACs — show primary with hover tooltip
  var tooltipRows = macs.map(function (m) {
    var isLatest = m.mac === displayMac || macEntryText(m) === displayMac;
    var count = macEntryCount(m);
    var sourceLine = (count > 1 ? count + ' MACs &middot; ' : '') +
      escapeHtml(m.source || "") + (m.lastSeen ? ' &middot; ' + formatDate(m.lastSeen) : '');
    var subnetLine = '';
    if (m.subnetName || m.subnetCidr) {
      subnetLine = '<span class="mac-tooltip-subnet">';
      if (m.subnetName) subnetLine += escapeHtml(m.subnetName);
      if (m.subnetCidr) {
        subnetLine += (m.subnetName ? ' ' : '') +
          '<span class="mac-tooltip-cidr">' + escapeHtml(m.subnetCidr) + '</span>';
      }
      subnetLine += '</span>';
    }
    var deviceLine = m.device
      ? '<span class="mac-tooltip-subnet">' + escapeHtml(m.device) + '</span>'
      : '';
    var deleteBtn = canDelete
      ? '<button type="button" class="mac-tooltip-delete" title="Remove this MAC from the asset" data-asset-id="' +
          escapeHtml(asset.id) + '" data-mac="' + escapeHtml(m.mac) + '">&times;</button>'
      : '';
    return '<div class="mac-tooltip-row' + (isLatest ? ' mac-tooltip-latest' : '') + '">' +
      '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(macEntryText(m)) + '">' + escapeHtml(macEntryText(m)) + '</span>' +
      '<span class="mac-tooltip-meta">' +
        subnetLine +
        deviceLine +
        '<span class="mac-tooltip-source">' + sourceLine + '</span>' +
      '</span>' +
      deleteBtn +
    '</div>';
  }).join("");

  return '<span class="mac-hover-trigger">' +
    '<span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(displayMac) + '">' + escapeHtml(displayMac) + '</span>' +
    '<span class="mac-badge-count">' + macs.length + '</span>' +
    '<div class="mac-tooltip">' +
      '<div class="mac-tooltip-header">Associated MACs</div>' +
      tooltipRows +
    '</div>' +
  '</span>';
}

function assetFormHTML(defaults) {
  var d = defaults || {};
  // The device-side cap this asset's Description pushes into, when it pushes
  // at all (see descriptionDeviceTarget). Polaris does NOT cap the input to
  // it — the Polaris value is authoritative and may legitimately carry more
  // location codes than the short device field holds. Instead the field warns
  // live once the value would be truncated on push.
  var descTarget = descriptionDeviceTarget(d);
  var identitySection = d._editing
    ? '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
        // Hostname is editable on edit as an operator override (coordinate-pin
        // pattern): a changed value pins hostnameOverride server-side so
        // discovery can no longer rewrite it; clearing the field releases the
        // pin and reverts to the discovery-projected hostname.
        '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(d.hostname || "") + '" placeholder="e.g. server-01">' +
          (d.hostnameOverride
            ? '<p class="hint">Manually overridden — clear the field to resume the discovered hostname.</p>'
            : (d.discoveredByIntegrationId ? '<p class="hint">Discovered — saving a change pins it as a manual override.</p>' : '')) +
        '</div>' +
        '<div class="form-group"><label>DNS Name</label><div class="form-value">' + escapeHtml(d.dnsName || "-") + '</div></div>' +
        // IP Address is editable on edit as an operator override, like
        // Hostname — but discovery gets a vote: a later discovery write
        // reporting the SAME address releases the pin automatically; a
        // DIFFERENT address keeps the pin and raises a conflict to resolve
        // on the Events → Conflicts tab. data-override-field tells
        // getAssetFormData to always send the value (including "" to clear).
        '<div class="form-group"><label>IP Address</label><input type="text" id="f-ipAddress" data-override-field="1" value="' + escapeHtml(d.ipAddress || "") + '" placeholder="' + (d.ipBlankPinned ? "no address (cleared)" : "e.g. 10.0.1.50") + '">' +
          (d.ipBlankPinned
            ? '<p class="hint">Manually cleared — discovery will not put an address back; one it reports raises a conflict. Type an address to set one.</p>'
            : d.ipOverride
            ? '<p class="hint">Manually overridden. If discovery reports this same address the override releases itself; a different discovered address raises a conflict. Clearing the field leaves the asset with no address.</p>'
            : (d.discoveredByIntegrationId ? '<p class="hint">Discovered — saving a change pins it as a manual override (a matching discovery releases it; a differing one raises a conflict). Clearing it leaves the asset with no address.</p>' : '')) +
          // Revert: the one way back from either pin to what discovery says.
          ((d.ipBlankPinned || d.ipOverride)
            ? '<p class="hint" id="f-ipRevert-wrap" style="margin-top:0.25rem"><a href="#" id="f-ipRevert">Revert to discovered IP</a></p>'
            : '') +
        '</div>' +
        '<div class="form-group" style="grid-column:1 / -1"><label>Serial Number</label><input type="text" id="f-serialNumber" value="' + escapeHtml(d.serialNumber || "") + '" placeholder="e.g. SN-DELL-001"></div>' +
      '</div>'
    : '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
        '<div class="form-group"><label>Hostname</label><input type="text" id="f-hostname" value="' + escapeHtml(d.hostname || "") + '" placeholder="e.g. server-01"></div>' +
        '<div class="form-group"><label>DNS Name</label><input type="text" id="f-dnsName" value="' + escapeHtml(d.dnsName || "") + '" placeholder="e.g. server-01.corp.local"></div>' +
        '<div class="form-group"><label>IP Address</label><input type="text" id="f-ipAddress" value="' + escapeHtml(d.ipAddress || "") + '" placeholder="e.g. 10.0.1.50"></div>' +
        '<div class="form-group"><label>MAC Address</label><input type="text" id="f-macAddress" value="' + escapeHtml(d.macAddress || "") + '" placeholder="e.g. 00:1A:2B:3C:4D:5E"></div>' +
        // IP cross-reference (assets-ipcontext.js), create-only: a manually
        // added asset has no discovery behind it, so the containing network,
        // the lease/reservation on the address and the gate it sits behind are
        // all facts the form would otherwise never surface. Full grid width —
        // it sits under the IP/MAC row and can fill both. Placed after MAC so
        // that row stays intact. Guarded: a page that didn't load the module
        // renders the form exactly as before.
        '<div style="grid-column:1 / -1">' +
          (window.PolarisIpContext ? window.PolarisIpContext.panelHTML("f-ip-context") : "") +
        '</div>' +
        '<div class="form-group"><label>Serial Number</label><input type="text" id="f-serialNumber" value="' + escapeHtml(d.serialNumber || "") + '" placeholder="e.g. SN-DELL-001"></div>' +
      '</div>';
  return identitySection +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Asset Details</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Asset Tag</label><input type="text" id="f-assetTag" value="' + escapeHtml(d.assetTag || "") + '" placeholder="e.g. ACME-00421"></div>' +
    '<div class="form-group"><label>Manufacturer</label><input type="text" id="f-manufacturer" value="' + escapeHtml(d.manufacturer || "") + '" placeholder="e.g. Dell, Cisco, HP"></div>' +
    '<div class="form-group"><label>Model</label><input type="text" id="f-model" value="' + escapeHtml(d.model || "") + '" placeholder="e.g. PowerEdge R740"></div>' +
    '<div class="form-group"><label>Type' + (isAssetTypeLocked(d) ? ' <span style="font-weight:normal;color:var(--color-text-tertiary);font-size:0.75rem">(locked — discovered by integration)</span>' : '') + '</label><select id="f-assetType"' + (isAssetTypeLocked(d) ? ' disabled' : '') + '>' +
      assetTypeOptionsHTML(d.assetType) +
    '</select></div>' +
    '<div class="form-group"><label>Status</label><select id="f-status">' +
      '<option value="storage"' + (d.status === "storage" ? " selected" : "") + '>Storage</option>' +
      '<option value="active"' + (d.status === "active" || !d.status ? " selected" : "") + '>Active</option>' +
      '<option value="maintenance"' + (d.status === "maintenance" ? " selected" : "") + '>Maintenance</option>' +
      '<option value="decommissioned"' + (d.status === "decommissioned" ? " selected" : "") + '>Decommissioned</option>' +
      '<option value="disabled"' + (d.status === "disabled" ? " selected" : "") + '>Disabled</option>' +
    '</select></div>' +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Location & Ownership</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
    // Location prefills from the SNMP sysLocation when the operator hasn't
    // set one — visible in the field before saving; Save adopts it as the
    // operator-set location. Provenance hint shows which value seeded it.
    '<div class="form-group"><label>Location</label><input type="text" id="f-location" value="' + escapeHtml(d.location || d.snmpLocation || "") + '" placeholder="e.g. DC1 Rack A3">' +
      (!d.location && d.snmpLocation ? '<p class="hint">Pre-filled from SNMP sysLocation — Save to adopt it.</p>' : '') +
      (d.learnedLocation ? '<p class="hint">Learned: ' + escapeHtml(d.learnedLocation) + '</p>' : '') + '</div>' +
    '<div class="form-group"><label>Department</label><input type="text" id="f-department" value="' + escapeHtml(d.department || "") + '" placeholder="e.g. Infrastructure"></div>' +
    '<div class="form-group"><label>Assigned To</label><input type="text" id="f-assignedTo" value="' + escapeHtml(d.assignedTo || "") + '" placeholder="e.g. platform-team"></div>' +
    '<div class="form-group"><label>Operating System</label><input type="text" id="f-os" value="' + escapeHtml(d.os || "") + '" placeholder="e.g. RHEL 9, Windows Server 2022"></div>' +
    '<div class="form-group"><label>Latitude</label><input type="number" step="any" min="-90" max="90" id="f-latitude" value="' + (d.latitude != null ? String(d.latitude) : "") + '" placeholder="e.g. 40.7128"></div>' +
    '<div class="form-group"><label>Longitude</label><input type="number" step="any" min="-180" max="180" id="f-longitude" value="' + (d.longitude != null ? String(d.longitude) : "") + '" placeholder="e.g. -74.0060"></div>' +
    (d.coordSource === "manual"
      ? '<p class="hint" style="grid-column:1 / -1;margin-top:-0.5rem">Coordinates are manually pinned — clear both fields to resume discovered values.</p>'
      : (d.latitude != null
        ? '<p class="hint" style="grid-column:1 / -1;margin-top:-0.5rem">Coordinates were discovered from the device — saving a change pins them as manual.</p>'
        : '')) +
  '</div>' +
  '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
  '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Procurement</p>' +
  '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:0 16px">' +
    '<div class="form-group"><label>Acquired</label><input type="date" id="f-acquiredAt" value="' + dateInputVal(d.acquiredAt) + '"></div>' +
    '<div class="form-group"><label>Warranty Expires</label><input type="date" id="f-warrantyExpiry" value="' + dateInputVal(d.warrantyExpiry) + '"></div>' +
    '<div class="form-group"><label>Purchase Order</label><input type="text" id="f-purchaseOrder" value="' + escapeHtml(d.purchaseOrder || "") + '" placeholder="PO-12345"></div>' +
  '</div>' +
  '<div class="form-group"><label>Description</label><input type="text" id="f-description" maxlength="255" value="' + escapeHtml(d.description || "") + '" placeholder="e.g. b:Shop f:2 r:North Closet jb:112-305">' +
    '<p class="hint">Device Map grouping codes: <code>a:</code>area &nbsp;<code>b:</code>building &nbsp;<code>f:</code>floor &nbsp;<code>r:</code>room &nbsp;<code>ra:</code>rack &nbsp;<code>jb:</code>junction box — e.g. <code>a:Mine b:Shop f:2 r:North Closet ra:R2 jb:112-305</code>. Values may contain spaces; each runs until the next code. Codes here (falling back to the device-side description) group this device into building/floor/room shapes and floor views on the topology map.</p>' +
    (typeof locationCodesDiagramHTML === "function" ? '<div class="hint">' + locationCodesDiagramHTML() + '</div>' : '') +
    '<p class="hint">On Fortinet assets with Description Sync enabled, this writes to the device (FortiGate alias / FortiSwitch description / FortiAP location) — Polaris is primary: a value here always wins and pushes to the device. Leave empty to adopt the device\'s value.</p>' +
    descriptionCapWarningHTML(descTarget, "f-description-cap-warn") + '</div>' +
  '<div class="form-group"><label>Notes</label><textarea id="f-notes" rows="2" placeholder="Optional notes">' + escapeHtml(d.notes || "") + '</textarea></div>' +
  tagFieldHTML(d.tags || []);
}

// ── Device-side description caps (warn, never limit) ────────────────────────
// Asset.description pushes to a short device field on some Fortinet roles, and
// FortiOS/FortiManager truncate what doesn't fit (capDescriptionForTarget in
// src/services/descriptionSyncService.ts). Polaris deliberately does NOT cap
// the operator's input to match — the Polaris value is primary and may carry
// more location codes than the device field holds — so the edit surfaces warn
// live instead, and only when the originating integration actually syncs
// descriptions to the device. Keep these numbers in lockstep with
// DESCRIPTION_CAPS. (FortiSwitch `description` is capped at 63 device-side but
// carries no warning here — 63 is roomy enough that nobody has hit it.)
var DESCRIPTION_DEVICE_TARGETS = {
  access_point: { cap: 35, device: "FortiAP",   field: "location" },
  firewall:     { cap: 35, device: "FortiGate", field: "alias" },
};

// The device target this asset's Description would be truncated into, or null
// when nothing pushes (non-Fortinet role, or Description Sync off).
function descriptionDeviceTarget(asset) {
  if (!asset || !asset.discoveredByIntegration) return null;
  if (asset.discoveredByIntegration.syncDescriptions !== true) return null;
  return DESCRIPTION_DEVICE_TARGETS[asset.assetType] || null;
}

// Hidden warning paragraph for a Description field; wireDescriptionCapWarning
// fills and reveals it. Renders nothing when the asset has no device target.
function descriptionCapWarningHTML(target, id) {
  if (!target) return "";
  return '<p class="hint" id="' + id + '" data-cap="' + target.cap +
    '" data-device="' + escapeHtml(target.device) + '" data-field="' + escapeHtml(target.field) +
    '" style="display:none;color:var(--color-warning,#b45309)"></p>';
}

// Show the warning whenever the typed value exceeds the device cap, live. Runs
// once on wire-up too, so a pre-existing over-length description warns on open
// rather than only after an edit.
function wireDescriptionCapWarning(inputId, warnId) {
  var input = document.getElementById(inputId);
  var warn = document.getElementById(warnId);
  if (!input || !warn) return;
  var cap = parseInt(warn.getAttribute("data-cap") || "", 10);
  if (!(cap > 0)) return;
  var device = warn.getAttribute("data-device") || "device";
  var field = warn.getAttribute("data-field") || "description";
  function update() {
    var len = input.value.length;
    if (len <= cap) { warn.style.display = "none"; return; }
    warn.innerHTML = "Over the device limit — FortiManager/FortiGate caps the " +
      escapeHtml(device) + " <code>" + escapeHtml(field) + "</code> field at " + cap +
      " characters, so this description (" + len + " characters) is cut off at " + cap +
      " when it's written to the device. Polaris keeps the full text: <code>" +
      escapeHtml(input.value.slice(0, cap)) + "</code> is what the device gets.";
    warn.style.display = "";
  }
  input.addEventListener("input", update);
  update();
}

// Read the Description field, trimmed to the input's own maxlength. maxlength
// prevents over-typing but doesn't shorten a longer value assigned via the
// value attribute, so slice defensively (the server's Zod schema caps at 255).
function descriptionFieldValue() {
  var el = document.getElementById("f-description");
  if (!el) return "";
  var v = el.value;
  var max = parseInt(el.getAttribute("maxlength") || "", 10);
  return (max > 0 && v.length > max) ? v.slice(0, max) : v;
}

// Business rule 40(i): before a save puts an asset on an address, ask the
// server who else is there. Resolves { proceed, mergeWith }: `proceed=false`
// means the operator cancelled; `mergeWith` names the one current holder to
// open the merge review against after the save lands (only offered when the
// server says the caller may merge, and only when there is exactly ONE
// current holder — with several, "merge with which one" is the conflict
// card's question, not a dialog button's).
//
// The save itself is what raises the conflict card (the route re-evaluates the
// address and returns `ipConflict`); this dialog exists so the person about to
// cause the collision is told BEFORE it lands and can choose the path. A failed
// check never blocks the save — the sweep re-derives the answer within ten
// minutes, and a pre-flight that could refuse a save on a network blip would be
// worse than no pre-flight.
async function _preflightDuplicateIp(ip, excludeAssetId, formData) {
  ip = (ip || "").trim();
  if (!ip) return { proceed: true, mergeWith: null };
  var check;
  try {
    check = await api.assets.ipCheck({
      ip: ip,
      excludeAssetId: excludeAssetId || undefined,
      assetType: (formData && formData.assetType) || undefined,
      macAddress: (formData && formData.macAddress) || undefined,
    });
  } catch (_) {
    return { proceed: true, mergeWith: null };
  }
  if (!check || !check.wouldConflict || !Array.isArray(check.holders) || !check.holders.length) {
    return { proceed: true, mergeWith: null };
  }
  var current = check.holders.filter(function (h) { return h.claimCurrent; });
  var describe = function (h) {
    var bits = [h.hostname || h.assetId, h.assetType || "unknown type", h.status || ""];
    var seen = h.ipLastSeen || h.lastSeen;
    if (h.pinned) bits.push("address pinned by an operator");
    else if (seen && typeof timeAgo === "function") bits.push("address confirmed " + timeAgo(seen));
    return "  • " + bits.filter(Boolean).join(" · ");
  };
  var msg = [
    ip + " is already recorded on " + (current.length === 1 ? "another asset:" : current.length + " other assets:"),
    current.map(describe).join("\n"),
    "",
    "Saving keeps your address and raises a Duplicate IP conflict for review — two devices on one " +
      "address is a fault, and the conflict card is where it gets resolved (move one of them, or merge " +
      "them if they are the same device).",
  ].join("\n");
  var choices = [{ id: "review", label: "Save & submit for conflict review", kind: "primary" }];
  if (check.canMerge && current.length === 1) {
    msg += "\n\nIf this IS the same device recorded twice, you can go straight to the merge review instead.";
    choices.push({
      id: "merge",
      label: "Save & review merge with " + (current[0].hostname || "the other asset"),
      kind: "secondary",
    });
  }
  var picked = typeof showChoice === "function"
    ? await showChoice(msg, { title: "Address already in use", choices: choices })
    : (window.confirm(msg) ? "review" : null);
  if (!picked) return { proceed: false, mergeWith: null };
  return { proceed: true, mergeWith: picked === "merge" ? current[0].assetId : null };
}

function getAssetFormData() {
  var acq = document.getElementById("f-acquiredAt").value;
  var war = document.getElementById("f-warrantyExpiry").value;
  var data = {
    assetTag:      val("f-assetTag") || undefined,
    manufacturer:  val("f-manufacturer") || undefined,
    model:         val("f-model") || undefined,
    assetType:     document.getElementById("f-assetType").value,
    status:        document.getElementById("f-status").value,
    // Always sent (including "") — an emptied Location clears to null
    // server-side so the display falls back to the learned location. Folding
    // "" to undefined dropped the key and the old value silently survived.
    location:      val("f-location"),
    department:    val("f-department") || undefined,
    assignedTo:    val("f-assignedTo") || undefined,
    os:            val("f-os") || undefined,
    acquiredAt:    acq ? new Date(acq).toISOString() : undefined,
    warrantyExpiry:war ? new Date(war).toISOString() : undefined,
    purchaseOrder: val("f-purchaseOrder") || undefined,
    // Always sent (including "") — an emptied Notes box clears to null
    // server-side (notes are operator-only; erasing them must stick).
    notes:         val("f-notes"),
    // Always sent (including "") — an emptied Description clears to null
    // server-side so the device value can re-seed it (description sync). Sent
    // in full even when it outruns a short device field (FortiAP `location` /
    // FortiGate `alias`): the Polaris value is primary and the push truncates.
    description:   descriptionFieldValue(),
    tags:          getTagFieldValue(),
  };
  // Coordinates travel as a pair: both blank → null (clear the manual pin /
  // leave unset), both filled → numbers. A half-filled pair aborts the save
  // with a toast (the save handlers catch and surface thrown errors).
  var latRaw = document.getElementById("f-latitude").value.trim();
  var lngRaw = document.getElementById("f-longitude").value.trim();
  if (!latRaw && !lngRaw) {
    data.latitude = null;
    data.longitude = null;
  } else {
    var lat = parseFloat(latRaw);
    var lng = parseFloat(lngRaw);
    if (!isFinite(lat) || !isFinite(lng)) {
      throw new Error("Latitude and longitude must both be set, or both left blank");
    }
    data.latitude = lat;
    data.longitude = lng;
  }
  // These fields are only editable on create, not edit — except hostname and
  // IP address, which are editable on edit as operator overrides. Hostname
  // always sends (including "") so a blanked field clears the override
  // server-side; on create the server treats "" as not-provided. The IP
  // input carries data-override-field only in edit mode (create keeps the
  // omit-when-empty behavior, since the create schema rejects "").
  if (document.getElementById("f-hostname"))     data.hostname     = val("f-hostname");
  if (document.getElementById("f-dnsName"))      data.dnsName      = val("f-dnsName") || undefined;
  var ipEl = document.getElementById("f-ipAddress");
  if (ipEl) data.ipAddress = ipEl.hasAttribute("data-override-field") ? val("f-ipAddress") : (val("f-ipAddress") || undefined);
  // "Revert to discovered IP" was clicked: release the pin (address or
  // blank) and take discovery's address. Wins over the field server-side.
  if (ipEl && ipEl.getAttribute("data-ip-revert") === "1") data.ipRevertToDiscovered = true;
  if (document.getElementById("f-macAddress"))   data.macAddress   = val("f-macAddress") || undefined;
  if (document.getElementById("f-serialNumber")) data.serialNumber = val("f-serialNumber") || undefined;

  // Monitoring fields (only present when the Monitoring tab is rendered)
  var mon = document.getElementById("f-monitored");
  if (mon) {
    data.monitored = mon.checked;
    // monitorCredentialId is NOT sent from this modal. It is discovery-owned:
    // buildClassMonitorStamp stamps the integration's per-class SNMP/SSH
    // credential onto managed switches/APs, and the stream dispatchers use it
    // as the asset-default credential. A previous "clear stale value" write
    // here (`monitorCredentialId: null` on every save) silently wiped that
    // stamp whenever an operator edited ANY field on the asset, downgrading
    // its SNMP streams to the integration's top-level credential — usually
    // the FortiGate's, which FortiLink switches don't answer — until the
    // next discovery cycle restamped it.
    var ivEl = document.getElementById("f-monitorInterval");
    if (ivEl) {
      var iv = parseInt(ivEl.value, 10);
      data.monitorIntervalSec = Number.isFinite(iv) && iv >= 5 ? iv : null;
    }
    var ptEl = document.getElementById("f-probeTimeoutMs");
    if (ptEl) {
      // Empty string = inherit (null). Out-of-range values get clamped by Zod
      // server-side, but be defensive here too — null on bad input.
      var ptRaw = ptEl.value === "" ? null : parseInt(ptEl.value, 10);
      data.probeTimeoutMs = (Number.isFinite(ptRaw) && ptRaw >= 100 && ptRaw <= 60000) ? ptRaw : null;
    }
    var telTimeoutEl = document.getElementById("f-cpuMemoryTimeoutMs");
    if (telTimeoutEl) {
      var telRaw = telTimeoutEl.value === "" ? null : parseInt(telTimeoutEl.value, 10);
      data.cpuMemoryTimeoutMs = (Number.isFinite(telRaw) && telRaw >= 1000 && telRaw <= 120000) ? telRaw : null;
    }
    var tempTimeoutEl = document.getElementById("f-temperatureTimeoutMs");
    if (tempTimeoutEl) {
      var tempRaw = tempTimeoutEl.value === "" ? null : parseInt(tempTimeoutEl.value, 10);
      data.temperatureTimeoutMs = (Number.isFinite(tempRaw) && tempRaw >= 1000 && tempRaw <= 120000) ? tempRaw : null;
    }
    var sysTimeoutEl = document.getElementById("f-systemInfoTimeoutMs");
    if (sysTimeoutEl) {
      var sysRaw = sysTimeoutEl.value === "" ? null : parseInt(sysTimeoutEl.value, 10);
      data.systemInfoTimeoutMs = (Number.isFinite(sysRaw) && sysRaw >= 1000 && sysRaw <= 120000) ? sysRaw : null;
    }
    // Per-stream polling-method overrides. Each select returns null
    // (= inherit) or one of "rest_api"/"snmp"/"winrm"/"ssh"/"icmp".
    var polling = _polarisReadPollingFourStream("f-");
    // Each field only when its select was drawn: a container's modal omits
    // the Hardware Sensors / LLDP / Storage tabs, and a missing select reads
    // as null — which would wipe a stored value nobody was shown.
    if (document.getElementById("f-responseTimePolling")) {
      [["responseTimePolling", "f-responseTimePolling"], ["cpuMemoryPolling", "f-cpuMemoryPolling"],
       ["temperaturePolling", "f-temperaturePolling"], ["interfacesPolling", "f-interfacesPolling"],
       ["lldpPolling", "f-lldpPolling"], ["storagePolling", "f-storagePolling"]].forEach(function (p) {
        if (document.getElementById(p[1])) data[p[0]] = polling[p[0]];
      });
    }
    // HTTP-check path override. Sent whenever the input exists — including when
    // it is hidden and blank, which is how switching AWAY from the http method
    // clears a stale override instead of leaving a path attached to an asset
    // that no longer runs an HTTP check. The route trims "" to null.
    var httpPathEl = document.getElementById("f-httpCheckPath");
    if (httpPathEl) data.httpCheckPath = httpPathEl.value.trim() || null;
    // Per-stream credential overrides. Empty string → null (source default).
    // refreshStreamCred populates and shows a picker whenever the row stores a
    // credential, even on "Inherit", so .value is what the operator sees and
    // "Source default" clears it. The data-current-id fallback only covers a
    // picker that was never populated (nothing stored, or refresh not run).
    // A deliberate method change clears data-current-id first (see the change
    // handler), so switching methods still drops a stale credential.
    function credVal(el) {
      if (!el) return undefined;
      if (el.options.length === 0) return el.getAttribute("data-current-id") || null;
      return el.value || null;
    }
    var rtCredEl   = document.getElementById("f-responseTimeCredential");
    var telCredEl  = document.getElementById("f-cpuMemoryCredential");
    var tempCredEl = document.getElementById("f-temperatureCredential");
    var ifCredEl   = document.getElementById("f-interfacesCredential");
    var lldpCredEl = document.getElementById("f-lldpCredential");
    data.responseTimeCredentialId = credVal(rtCredEl);
    data.cpuMemoryCredentialId    = credVal(telCredEl);
    data.temperatureCredentialId  = credVal(tempCredEl);
    data.interfacesCredentialId   = credVal(ifCredEl);
    data.lldpCredentialId         = credVal(lldpCredEl);
    // No per-stream MIB: the pins are retired (business rule 170).
  }
  return data;
}

// ─── Tabbed asset modal scaffolding ────────────────────────────────────────

function assetMonitoringFormHTML(asset, managedAgent) {
  var interval = asset && asset.monitorIntervalSec != null ? asset.monitorIntervalSec : "";
  var probeTimeout = asset && asset.probeTimeoutMs != null ? asset.probeTimeoutMs : "";
  var telemetryTimeout   = asset && asset.cpuMemoryTimeoutMs   != null ? asset.cpuMemoryTimeoutMs   : "";
  var temperatureTimeout = asset && asset.temperatureTimeoutMs != null ? asset.temperatureTimeoutMs : "";
  var systemInfoTimeout  = asset && asset.systemInfoTimeoutMs  != null ? asset.systemInfoTimeoutMs  : "";
  var monitored = asset && asset.monitored ? " checked" : "";
  // Asset id is needed to fetch effective settings + populate the Asset
  // Overrides button — empty on the create flow.
  var assetIdAttr = (asset && asset.id) ? ' data-asset-id="' + escapeHtml(asset.id) + '"' : "";

  // Per-stream polling-method overrides. Compat-aware — methods that don't
  // apply to this asset's source are hidden inside the helper. Always
  // visible when monitoring is enabled (every asset has at least the
  // response-time stream); the resolver labels each "Inherit" option with
  // the source default (REST API / ICMP / Not delivered).
  var integrationType = (asset && asset.discoveredByIntegration && asset.discoveredByIntegration.type) || null;
  var assetSourceKind = integrationType || "manual";
  if (!_POLLING_COMPAT[assetSourceKind]) assetSourceKind = "manual";
  var pollingCurrent = {
    responseTimePolling: asset && asset.responseTimePolling,
    cpuMemoryPolling:    asset && asset.cpuMemoryPolling,
    temperaturePolling:  asset && asset.temperaturePolling,
    interfacesPolling:   asset && asset.interfacesPolling,
    lldpPolling:         asset && asset.lldpPolling,
    storagePolling:      asset && asset.storagePolling,
  };
  // Per-stream credential IDs (null = use source default at runtime).
  var rtCredId   = (asset && asset.responseTimeCredentialId)  || "";
  var telCredId  = (asset && asset.cpuMemoryCredentialId)     || "";
  var tempCredId = (asset && asset.temperatureCredentialId)   || "";
  var ifCredId   = (asset && asset.interfacesCredentialId)    || "";
  var lldpCredId = (asset && asset.lldpCredentialId)          || "";

  // Per-asset HTTP-check path override, plus the selected credential's own path
  // for the input's placeholder. The hint is best-effort: the credential list is
  // cached for the picker anyway, and if the id isn't in it (a class-tier
  // credential, or a cache that hasn't loaded) the placeholder falls back to "/"
  // rather than the modal blocking on a fetch to caption one field.
  var httpCheckPath = (asset && asset.httpCheckPath) || "";
  // The placeholder used to show the selected credential's own path. The check
  // definition no longer lives on a credential, and the widget that owns the
  // path is chosen by manufacturer + model rather than by anything on this
  // form, so there is nothing cheap to caption it with — "/" is the honest
  // fallback rather than a value copied from the wrong place.
  var httpCredPathHint = "";

  // Per-stream subtab body: polling-method dropdown (with credential + MIB
  // sub-rows beneath that show/hide based on selected method), then a per-
  // stream cadence + timeout block, then on Response Time only the failure
  // threshold. Preserves the legacy DOM ids the save reader in
  // extractAssetEditData() reads (`f-responseTimePolling` /
  // `f-responseTimeCredential` / `f-responseTimeMib` / `f-monitorInterval` /
  // `f-probeTimeoutMs` / etc.). LLDP + Storage subtabs share the system-info
  // cadence + timeout with the Interfaces subtab — the input lives in
  // Interfaces and the LLDP/Storage subtabs render a hint pointing operators
  // there (Asset row only carries 4 cadence columns: monitorIntervalSec,
  // cpuMemoryIntervalSec, temperatureIntervalSec, systemInfoIntervalSec).
  //
  // "icmp" and "disabled" never need a credential; "agent" doesn't either —
  // the Polaris Agent's own per-asset bearer (issued at install time) is
  // implicit and never picked from the credential store.
  function streamPollingBlock(streamName, pollingId, credSelectId, mibSelectId, currentPoll, currentCredId) {
    var needsCred = currentPoll && currentPoll !== "icmp" && currentPoll !== "disabled" && currentPoll !== "agent" && currentPoll !== "genericapi";
    var isSnmp    = currentPoll === "snmp";
    var credDisplay = needsCred ? "flex" : "none";
    // What the stream reads over SNMP, said not chosen (business rule 170):
    // filled in by _populateAssetMonitorTierBadges once the effective-settings
    // read names the covering manufacturer profile. Storage has no line —
    // HOST-RESOURCES-MIB + the profile's disk fallback, nothing to say per row.
    var mibSubRow = mibSelectId
      ? _streamMibUsesRowHTML(pollingId + "-mib-wrap", mibSelectId, streamName, undefined, true, isSnmp)
      : '';
    return '<div class="form-group"><label>Polling method</label>' +
        _polarisPollingDropdownHTML(pollingId, assetSourceKind, streamName, currentPoll) +
        '<p class="hint">Select the protocol Polaris uses for this stream. "Inherit" falls through to the resolved class / integration / manual / source-default tiers.</p>' +
      '</div>' +
      '<div class="form-group" id="' + pollingId + '-cred-wrap" style="display:' + credDisplay + ';align-items:center;gap:0.5rem;margin-top:0.5rem">' +
        '<label style="margin:0;font-size:0.85rem;color:var(--color-text-secondary);min-width:90px">Credential</label>' +
        '<select id="' + credSelectId + '" data-current-id="' + escapeHtml(currentCredId) + '" style="flex:1"></select>' +
      '</div>' +
      '<p class="hint" id="' + pollingId + '-cred-hint" style="display:none">This stream stores a credential. It is still used whenever the inherited method takes that credential type. Choose "Source default" to clear it.</p>' +
      mibSubRow;
  }

  // Each interval/timeout input keeps its legacy DOM id + tier-badge span id
  // so _populateAssetMonitorTierBadges() and the save reader keep working
  // unchanged.
  function intervalInput(id, label, value, min, max, hint) {
    return '<div class="form-group">' +
      '<label>' + escapeHtml(label) + ' <span class="tier-badge" id="' + id + '-tier" style="margin-left:0.5rem;font-size:0.78rem;font-weight:normal;color:var(--color-text-tertiary)"></span></label>' +
      '<input type="number" id="' + id + '" min="' + min + '" max="' + max + '" value="' + escapeHtml(String(value)) + '" placeholder="leave blank to inherit" style="max-width:240px">' +
      (hint ? '<p class="hint">' + hint + '</p>' : '') +
    '</div>';
  }
  function probeTimeoutInput() {
    return '<div class="form-group">' +
      '<label>Probe Timeout Override (ms) <span class="tier-badge" id="f-probeTimeoutMs-tier" style="margin-left:0.5rem;font-size:0.78rem;font-weight:normal;color:var(--color-text-tertiary)"></span></label>' +
      '<input type="number" id="f-probeTimeoutMs" min="100" max="60000" value="' + escapeHtml(String(probeTimeout)) + '" placeholder="leave blank to inherit" style="max-width:240px">' +
      '<p class="hint" id="f-probeTimeoutMs-warn" style="display:none;color:var(--color-warning)">⚠ Below 500 ms — probes will likely false-fail under healthy network conditions.</p>' +
      '<p class="hint">Range 100..60000 ms; default is 5000 ms. Inherits from the resolved tier when blank.</p>' +
    '</div>';
  }
  function declaringDownHint() {
    // How many missed polls make this device Down is the covering
    // down-detection automation's number (business rule 36), so the old
    // "edit it at the tier where it lives" pointer would now send operators to
    // a field that no longer exists. Filled in asynchronously by
    // _populateAssetMonitorTierBadges, which is the one place that already has
    // the per-asset answer — and which names the automation, since "3 missed
    // polls" without saying WHOSE 3 is the question this panel exists to
    // answer.
    return '<div class="form-group">' +
      '<label>Declaring Down</label>' +
      '<p class="hint" id="f-down-detection">Resolving…</p>' +
    '</div>';
  }

  // Subtab body builders — one per stream. LLDP + Storage share systemInfo
  // cadence with Interfaces at the asset tier (Asset row has no separate
  // lldpIntervalSec / storageIntervalSec columns); their subtabs link to
  // Interfaces for those inputs.
  // Per-asset request-path override for HTTP-check WIDGETS. The "http" polling
  // method it was built for is gone (2026-08) — the check now lives on a
  // manufacturer custom widget — but the escape hatch it provides is still
  // wanted: model targeting covers "this model answers elsewhere", and this
  // covers the single device that does. It is therefore always visible rather
  // than gated on a polling method, since no stream setting implies it any more.
  // Blank means "no override", which the hint says explicitly — an empty box
  // next to a URL-ish placeholder otherwise reads as "requests /".
  function httpPathInput() {
    return '<div class="form-group" id="f-httpCheckPath-wrap" style="margin-top:0.5rem">' +
      '<label>HTTP check path override</label>' +
      '<input type="text" id="f-httpCheckPath" maxlength="1024" value="' + escapeHtml(httpCheckPath) + '" placeholder="' + escapeHtml(httpCredPathHint || "/") + '" style="max-width:360px">' +
      '<p class="hint">Overrides the path used by any HTTP-check widget on this device\'s manufacturer profile, for a device whose health endpoint sits somewhere else. Leave blank to use the widget\'s own path.</p>' +
    '</div>';
  }
  function bodyResponseTime() {
    return streamPollingBlock("responseTime", "f-responseTimePolling", "f-responseTimeCredential", "f-responseTimeMib", pollingCurrent.responseTimePolling, rtCredId) +
      httpPathInput() +
      intervalInput("f-monitorInterval", "Poll Interval Override (seconds)", interval, 5, 86400, "Minimum 5 seconds. Inherits from the resolved tier when blank.") +
      probeTimeoutInput() +
      declaringDownHint();
  }
  function bodyCpuMemory() {
    return streamPollingBlock("telemetry", "f-cpuMemoryPolling", "f-cpuMemoryCredential", "f-telemetryMib", pollingCurrent.cpuMemoryPolling, telCredId) +
      intervalInput("f-cpuMemoryTimeoutMs", "CPU/Memory Timeout Override (ms)", telemetryTimeout, 1000, 120000, "Per-request timeout for the CPU/memory collector (FortiOS REST + SNMP). Range 1000..120000 ms; default 10000 ms. Inherits when blank.");
  }
  function bodyTemperature() {
    return streamPollingBlock("temperature", "f-temperaturePolling", "f-temperatureCredential", "f-temperatureMib", pollingCurrent.temperaturePolling, tempCredId) +
      intervalInput("f-temperatureTimeoutMs", "Hardware Sensor Timeout Override (ms)", temperatureTimeout, 1000, 120000, "Per-request timeout for the hardware-sensor collector (FortiOS sensor-info / SNMP fgHwSensorTable / ENTITY-SENSOR-MIB). Range 1000..120000 ms; default 10000 ms. Inherits when blank.");
  }
  function bodyInterfaces() {
    return streamPollingBlock("interfaces", "f-interfacesPolling", "f-interfacesCredential", "f-interfacesMib", pollingCurrent.interfacesPolling, ifCredId) +
      intervalInput("f-systemInfoTimeoutMs", "System Info Timeout Override (ms)", systemInfoTimeout, 1000, 120000, "Per-request timeout for the interface / storage / LLDP collector. Range 1000..120000 ms; default 10000 ms. Inherits when blank.");
  }
  function bodyStorage() {
    return streamPollingBlock("storage", "f-storagePolling", "f-storageCredential", null, pollingCurrent.storagePolling, "") +
      '<p class="hint" style="margin:0.5rem 0 0;padding:0.5rem 0.65rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);color:var(--color-text-secondary)">Cadence + timeout for this stream are shared with the <strong>Interfaces</strong> subtab at the per-asset tier — edit them there.</p>';
  }
  function bodyLldp() {
    return streamPollingBlock("lldp", "f-lldpPolling", "f-lldpCredential", "f-lldpMib", pollingCurrent.lldpPolling, lldpCredId) +
      '<p class="hint" style="margin:0.5rem 0 0;padding:0.5rem 0.65rem;background:var(--color-bg-tertiary);border-radius:var(--radius-sm);color:var(--color-text-secondary)">Cadence + timeout for this stream are shared with the <strong>Interfaces</strong> subtab at the per-asset tier — edit them there.</p>';
  }

  var streamTabs = [
    { key: "responseTime", label: "Response Time", html: bodyResponseTime() },
    { key: "cpuMemory",    label: "CPU/Memory",    html: bodyCpuMemory()    },
    { key: "temperature",  label: "Hardware Sensors", html: bodyTemperature()  },
    { key: "interfaces",   label: "Interfaces",    html: bodyInterfaces()   },
    { key: "lldp",         label: "LLDP",          html: bodyLldp()         },
    { key: "storage",      label: "Storage",       html: bodyStorage()      },
  ].filter(function (t) {
    // A container / App has no sensors, disks or LLDP of its own; offering a
    // method for them would only collect nothing.
    return !(asset && asset.assetType === "container") ||
      (t.key !== "temperature" && t.key !== "lldp" && t.key !== "storage");
  });

  // tabbedBodyHTML + wireModalTabs are the shared globals from
  // integrations.js (loaded before assets.js on assets.html). The tab key
  // namespaces the strip so it doesn't collide with the Integration modal's
  // stream-tab strips when both pages share a session.
  var transportBlockHtml =
    '<div id="f-transport-wrap" style="margin-top:0.5rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
      '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin:0.5rem 0 0.5rem 0">Polling Methods</p>' +
      tabbedBodyHTML("asset-mon-streams", streamTabs) +
      '<p class="hint" style="margin-top:0.5rem">Per-asset overrides win over class / integration / source-default tiers. When a method needs a credential, "Source default" lets the asset inherit the integration\'s configured credential at runtime.</p>' +
    '</div>';

  // ─── Polaris Agent block ───────────────────────────────────────────
  //
  // Three states:
  //   - No agent + source supports agent  → "Install Polaris Agent…" button
  //   - Agent in flight (pending/uploading/enrolling/upgrading/uninstalling)
  //                                       → status pill + read-only banner
  //   - Agent active                      → status pill + Upgrade / Uninstall
  //
  // When the agent is active OR in flight, the Polling Methods section
  // is suppressed — the agent owns all four streams. The four *Polling
  // fields on the Asset are stamped to "agent" server-side at enrollment
  // time so the periodic puller cleanly no-ops; clicking Save on this
  // modal does NOT overwrite them (the form ignores the dropdowns when
  // the polling section is hidden).
  // Same set the System tab's agent panel offers from, and the same one the
  // install service enforces — vCenter guests included (see
  // _AGENT_INSTALLABLE_SOURCES).
  var sourceSupportsAgent = _assetSupportsAgentInstall(asset);
  var agentInFlight = managedAgent && (
    managedAgent.installStatus === "pending"      ||
    managedAgent.installStatus === "uploading"    ||
    managedAgent.installStatus === "enrolling"    ||
    managedAgent.installStatus === "upgrading"    ||
    managedAgent.installStatus === "uninstalling"
  );
  var agentActive = managedAgent && managedAgent.installStatus === "active";
  var agentBlockHtml = "";
  if (agentActive) {
    agentBlockHtml =
      '<div class="form-group" style="margin-top:1rem;padding:1rem;border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface)">' +
        '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">' +
          '<strong>Polaris Agent</strong>' +
          '<span style="font-size:0.75rem;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);color:var(--color-success)">Active</span>' +
        '</div>' +
        '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0 0 0.5rem">' +
          'Agent v' + escapeHtml(managedAgent.agentVersion || "?") + ' is installed on this host and owns all four monitoring streams. ' +
          'The polling-methods section is hidden — the agent pushes samples directly. Manage the agent from the asset details modal → System tab.' +
        '</p>' +
        '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">' +
          'Platform: ' + escapeHtml(managedAgent.osPlatform || "?") + '/' + escapeHtml(managedAgent.arch || "?") +
          (managedAgent.lastSeenAt ? ' · Last seen: ' + escapeHtml(formatDateTime(managedAgent.lastSeenAt)) : '') +
        '</div>' +
      '</div>';
  } else if (agentInFlight) {
    agentBlockHtml =
      '<div class="form-group" style="margin-top:1rem;padding:1rem;border:1px solid var(--color-border);border-radius:6px;background:var(--color-surface)">' +
        '<div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.5rem">' +
          '<strong>Polaris Agent</strong>' +
          '<span style="font-size:0.75rem;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,0.06);color:var(--color-text-secondary)">' +
            escapeHtml(_agentStatusLabel(managedAgent.installStatus)) + '</span>' +
        '</div>' +
        '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0">' +
          'An install or uninstall is in flight. Watch progress on the asset details modal → System tab.' +
        '</p>' +
      '</div>';
  } else if (sourceSupportsAgent && asset && asset.id) {
    // No agent installed yet + asset already exists (we have an id to
    // install on). On the CREATE flow asset.id is undefined; we hide
    // the button there because the install service needs the row to
    // exist first.
    agentBlockHtml =
      '<div class="form-group" style="margin-top:1rem;padding:1rem;border:1px dashed var(--color-border);border-radius:6px;background:var(--color-surface)">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.75rem;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:0">' +
            '<strong>Polaris Agent</strong>' +
            '<p class="hint" style="margin:0.25rem 0 0">Install a lightweight agent on this host. The agent pushes monitoring samples back to Polaris directly and replaces the polling-methods section below entirely.</p>' +
          '</div>' +
          '<button type="button" class="btn btn-secondary" id="btn-edit-modal-install-agent" data-asset-id="' + escapeHtml(asset.id) + '">Install Polaris Agent…</button>' +
        '</div>' +
      '</div>';
  }

  // Hide the polling-methods section entirely when an agent is active
  // or in flight. Otherwise the operator could pick a method that gets
  // ignored at resolution time + see misleading dropdown state.
  var transportBlockShown = !(agentActive || agentInFlight);

  return (
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-monitored"' + monitored + '>' +
        '<span>Enable monitoring for this asset</span>' +
      '</label>' +
      '<p class="hint">A successful probe means the credential authenticated. Probes write a sample row each cycle; failed probes count as packet loss.</p>' +
      // Shown (and the checkbox disabled) while the General tab's Status is one
      // of the four that cannot be monitored. Driven live off #f-status by
      // _wireMonitorEditTab, because the operator can fix the status in this
      // same modal — a static disable would strand them on a tab that never
      // re-enables.
      '<p class="hint" id="f-monitored-blocked" style="display:none;color:var(--color-warning)"></p>' +
    '</div>' +
    agentBlockHtml +
    (transportBlockShown ? transportBlockHtml : '') +
    '<div class="form-group" id="f-asset-overrides-wrap"' + assetIdAttr + ' style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--color-border);display:none">' +
      '<button type="button" class="btn btn-secondary" id="btn-asset-overrides-list">Show other asset overrides under this scope</button>' +
      '<p class="hint" id="f-asset-overrides-hint">Lists every asset under the same (class, asset source) scope that has its own per-asset overrides.</p>' +
    '</div>'
  );
}

// Maintenance tab of the edit modal (edit mode only — the actions realize as
// a one-shot schedule against an existing asset). Shows current windows +
// covering schedules (lazily loaded in _wireMaintenanceEditSection) and, for
// maintenanceManagement holders, an ad-hoc "enter maintenance until…" action.
function assetMaintenanceFormHTML(asset) {
  if (!asset || !asset.id) return "";
  // Two independent reasons the ad-hoc control can't be offered, each with
  // its OWN message — conflating them told admins on the map/dashboard pages
  // they lacked a permission they had. (1) the RBAC key; (2) assets-maintenance.js,
  // which every page carrying the asset modal now loads, but rendering the
  // control without it is how a save reported "maintenance mode active"
  // while creating nothing.
  var mayMaint = typeof canManageMaintenance === "function" && canManageMaintenance();
  // Rule 141 (e): the role may hold the key and still not reach THIS device.
  var reachMaint = mayMaint && _canMaintainAsset(asset);
  var canMaint = reachMaint && typeof window.maintCreateAdhoc === "function";
  var unmonitored = asset.monitored === false;
  return (
    '<div class="form-group" id="f-maint-wrap">' +
      '<div id="f-maint-info" class="hint" style="margin:0 0 0.5rem">Loading maintenance info…</div>' +
      (canMaint
        ? (unmonitored
            ? '<p class="hint" id="f-maint-unmonitored" style="color:var(--color-warning)">' +
                'This asset isn’t monitored, so it can’t enter maintenance — there is no polling to pause. ' +
                'Enable monitoring on the Monitoring tab first.</p>'
            : "") +
          '<label for="f-maint-enter" style="display:flex;align-items:center;gap:8px;cursor:pointer;width:fit-content">' +
            '<input type="checkbox" id="f-maint-enter" style="width:auto">' +
            '<span>Enter maintenance mode until</span>' +
          '</label>' +
          // Deliberately OUTSIDE the label and never `disabled`: a disabled
          // control inside the label swallowed clicks (so the field looked
          // dead), and a filled date now speaks for itself — it ticks the
          // checkbox rather than being ignored at save time.
          '<div style="display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap">' +
            '<input type="datetime-local" id="f-maint-until" style="width:auto">' +
            '<button type="button" class="btn btn-secondary btn-sm" id="f-maint-clear">Clear</button>' +
          '</div>' +
          '<div id="f-maint-error" class="hint" style="display:none;color:var(--color-danger);margin-top:4px"></div>' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-top:6px;width:fit-content" title="Devices behind this asset go into dependency suppression (notifications paused) for the window. Uncheck when they stay reachable and should keep alerting.">' +
            '<input type="checkbox" id="f-maint-suppress" checked style="width:auto">' +
            '<span>Mark dependent devices as down</span>' +
          '</label>' +
          '<p class="hint" id="f-maint-tz">Creates a one-time maintenance schedule for this asset starting now (listed under Assets &rarr; Maintenance). Polling and notifications pause until the end time. Both the date AND the time are required, in the Polaris server&rsquo;s timezone.</p>'
        : reachMaint
          ? '<p class="hint">Maintenance scheduling isn’t loaded on this page — use Assets &rarr; Maintenance.</p>'
          : mayMaint
            ? '<p class="hint">You can put only the devices you added, or that carry one of your tags, into maintenance.</p>'
            : '<p class="hint">You don’t have permission to change maintenance windows.</p>') +
    '</div>'
  );
}

/**
 * Read the Maintenance tab's ad-hoc request at save time.
 *
 * Returns {requested, until, suppressChildren, error}. `error` is a string the
 * caller must surface — an operator who ticked the box or typed a date and got
 * a plain "Asset updated" had no way to tell the request had been dropped, so
 * every rejection path here is loud.
 */
function _readAdhocMaintenanceRequest() {
  var chk = document.getElementById("f-maint-enter");
  var untilEl = document.getElementById("f-maint-until");
  if (!chk || !untilEl) return { requested: false };
  var raw = String(untilEl.value || "").trim();
  if (!chk.checked && !raw) return { requested: false };
  var suppressEl = document.getElementById("f-maint-suppress");
  // No nowMs: the validator judges "in the past" against the SERVER's clock,
  // which is the clock the value is read in.
  var check = typeof window.maintValidateAdhocEnd === "function"
    ? window.maintValidateAdhocEnd(raw)
    : { ok: !!raw, value: raw, error: "Pick the date and time maintenance should end." };
  if (!check.ok) return { requested: true, error: check.error };
  return {
    requested: true,
    until: check.value,
    suppressChildren: !suppressEl || suppressEl.checked,
  };
}

/** Show/clear the inline error under the ad-hoc end-time field. */
function _setMaintFormError(msg) {
  var el = document.getElementById("f-maint-error");
  if (!el) return;
  el.textContent = msg || "";
  el.style.display = msg ? "" : "none";
  if (msg) {
    var untilEl = document.getElementById("f-maint-until");
    var tabBtn = document.querySelector('#asset-edit-tabs .page-tab[data-tab="maintenance"]');
    if (tabBtn) tabBtn.click();
    if (untilEl) untilEl.focus();
  }
}

// Maintenance tab of the edit modal: current windows + covering schedules
// (from /assets/:id/maintenance-info), and the ad-hoc enter-until checkbox.
// Best-effort — a load failure just leaves the hint.
function _wireMaintenanceEditSection(asset) {
  var infoEl = document.getElementById("f-maint-info");
  if (!infoEl || !asset || !asset.id) return;

  var enterChk = document.getElementById("f-maint-enter");
  var untilEl = document.getElementById("f-maint-until");
  var clearBtn = document.getElementById("f-maint-clear");

  // Name the server's zone + current time beside the picker. Kicked here rather
  // than at page load because this is the first surface that needs it; the skew
  // is cached module-side, so the popover path picks it up for free afterwards.
  if (typeof window.maintLoadServerClock === "function") {
    window.maintLoadServerClock().then(function () {
      var tzEl = document.getElementById("f-maint-tz");
      var label = typeof window.maintServerClockLabel === "function"
        ? window.maintServerClockLabel() : "";
      if (tzEl && label) tzEl.innerHTML += ' <strong>' + escapeHtml(label) + '</strong>.';
    });
  }
  if (enterChk && untilEl) {
    // Ticking the box seeds a valid default (now + 2h) so the common case is
    // one click; clearing the box clears the date so the two controls can
    // never disagree about whether a window was requested.
    enterChk.addEventListener("change", function () {
      if (enterChk.checked) {
        if (!untilEl.value && typeof window.maintLocalIso === "function") {
          // Server clock, not the browser's — the value is read as the server's
          // wall clock (see maintValidateAdhocEnd).
          var seedMs = typeof window.maintServerNow === "function"
            ? window.maintServerNow().getTime() : Date.now();
          untilEl.value = window.maintLocalIso(new Date(seedMs + 2 * 60 * 60 * 1000));
        }
      } else {
        untilEl.value = "";
      }
      _setMaintFormError("");
    });
    // Typing/picking an end time IS the request — the date field no longer
    // needs the checkbox ticked first to be taken seriously.
    ["input", "change"].forEach(function (evt) {
      untilEl.addEventListener(evt, function () {
        if (untilEl.value) enterChk.checked = true;
        _setMaintFormError("");
      });
    });
    if (clearBtn) {
      clearBtn.addEventListener("click", function () {
        untilEl.value = "";
        enterChk.checked = false;
        _setMaintFormError("");
      });
    }
  }

  _loadMaintenanceEditInfo(asset);
}

/**
 * (Re)render the Maintenance tab's info block: the open windows, then one row
 * per covering schedule carrying its own actions. Called on open and again
 * after every action, so a removal that deleted the schedule simply comes back
 * with the row gone.
 */
function _loadMaintenanceEditInfo(asset, opts) {
  var infoEl = document.getElementById("f-maint-info");
  if (!infoEl) return;
  api.assets.maintenanceInfo(asset.id).then(function (info) {
    infoEl.innerHTML = _maintenanceInfoHTML(info);
    _wireMaintenanceScheduleActions(asset, infoEl);
    if (opts && opts.afterAction) _syncStatusSelectTo(info.status);
  }).catch(function () {
    infoEl.textContent = "Maintenance info unavailable.";
  });
}

/**
 * Re-point the General tab's Status dropdown at the asset's real status after
 * an action on this tab moved it. The dropdown was filled when the modal
 * opened; ending a window restores the parked status underneath it, and a Save
 * carrying the stale "maintenance" would park the device BY HAND — the one
 * state the scheduler never takes back (there is no window left to close).
 * Only the value, never the options: an unknown status means the server knows
 * something this build's list doesn't, and blanking the field is worse.
 */
function _syncStatusSelectTo(status) {
  var sel = document.getElementById("f-status");
  if (!sel || !status || sel.value === status) return;
  var hasOption = Array.prototype.some.call(sel.options, function (o) { return o.value === status; });
  if (hasOption) sel.value = status;
}

/** Markup for the info block — open windows, then the covering-schedule rows. */
function _maintenanceInfoHTML(info) {
  var canManage = typeof canManageMaintenance === "function" && canManageMaintenance();
  var lines = [];
  (info.openWindows || []).forEach(function (w) {
    lines.push("<div><strong>In maintenance now</strong> — " + escapeHtml(w.scheduleName) +
      (w.until ? " (until ~" + escapeHtml(formatDateTime(w.until)) + ")" : "") + "</div>");
  });
  (info.schedules || []).forEach(function (s) {
    var when = s.activeNow
      ? "active now"
      : (s.nextStart ? "next: " + formatDateTime(s.nextStart) : "no upcoming window");
    var actions = "";
    if (canManage) {
      // Rule 141 (e): Remove needs THIS device in reach (info.canMaintain),
      // Delete the whole window (s.canEdit). A payload without the flags
      // (an older server) is treated as reachable — the server decides.
      var mayRemove = info.canMaintain !== false;
      var mayDelete = s.canEdit !== false;
      // A filter-matched asset has no per-asset removal: dropping it from the
      // device list leaves the filter matching it and the next reconcile puts
      // it straight back. Say that where the button would have been rather
      // than shipping a button that lies (the server refuses it too).
      if (!s.removable) {
        actions += '<span class="hint" style="margin:0">Matched by this schedule’s filter — edit the filter to exclude it</span>';
      } else if (mayRemove) {
        actions += '<button type="button" class="btn btn-secondary btn-sm" data-maint-act="remove" ' +
            'data-schedule-id="' + escapeHtml(s.id) + '" data-schedule-name="' + escapeHtml(s.name) + '"' +
            (s.lastTarget ? ' data-last-target="true"' : "") + '>Remove this asset</button>';
      }
      if (mayDelete) {
        actions += '<button type="button" class="btn btn-danger btn-sm" data-maint-act="delete" ' +
          'data-schedule-id="' + escapeHtml(s.id) + '" data-schedule-name="' + escapeHtml(s.name) + '">Delete schedule</button>';
      } else if (!mayRemove || !s.removable) {
        actions += '<span class="hint" style="margin:0" title="Not created by you, on devices you did not add and that carry none of your tags">Not yours to change</span>';
      }
    }
    lines.push(
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0">' +
        '<span style="flex:1 1 220px;min-width:0">Covered by schedule: <strong>' + escapeHtml(s.name) + '</strong>' +
          (s.enabled ? "" : " (disabled)") + " — " + escapeHtml(when) + '</span>' +
        actions +
      '</div>');
  });
  return lines.length ? lines.join("") : "Not covered by any maintenance schedule.";
}

/**
 * Wire the per-schedule buttons, delegated on the info block. Only its
 * innerHTML is replaced on a reload, so the element outlives every render and
 * the listener is attached ONCE — re-attaching per reload is how one click
 * ends up firing a confirm (and a delete) for every reload that came before.
 */
function _wireMaintenanceScheduleActions(asset, infoEl) {
  if (infoEl.dataset.maintWired === "1") return;
  infoEl.dataset.maintWired = "1";
  infoEl.addEventListener("click", function (ev) {
    var btn = ev.target.closest ? ev.target.closest("[data-maint-act]") : null;
    if (!btn || !infoEl.contains(btn)) return;
    ev.preventDefault();
    var act = btn.getAttribute("data-maint-act");
    var id = btn.getAttribute("data-schedule-id");
    var name = btn.getAttribute("data-schedule-name") || "this schedule";
    var lastTarget = btn.getAttribute("data-last-target") === "true";

    var msg = act === "delete"
      ? 'Delete the maintenance schedule "' + name + '"?\n\n' +
        "Every device it covers leaves maintenance and resumes monitoring. This cannot be undone."
      : lastTarget
        ? 'Remove this asset from "' + name + '"?\n\n' +
          "It is the only device on that schedule, so the schedule is deleted with it. " +
          "Monitoring and notifications resume immediately."
        : 'Remove this asset from "' + name + '"?\n\n' +
          "The schedule keeps running for its other devices. Monitoring and notifications " +
          "resume for this asset immediately.";

    showConfirm(msg).then(function (ok) {
      if (!ok) return;
      infoEl.querySelectorAll("[data-maint-act]").forEach(function (b) { b.disabled = true; });
      var p = act === "delete"
        ? api.maintenanceSchedules.delete(id).then(function () {
            showToast('Maintenance schedule "' + name + '" deleted');
          })
        : api.maintenanceSchedules.removeAsset(id, asset.id).then(function (res) {
            showToast(res && res.scheduleDeleted
              ? 'Asset removed — schedule "' + name + '" deleted (it had no other devices)'
              : 'Asset removed from "' + name + '"');
          });
      p.catch(function (err) {
        showToast((err && err.message) || "Failed to update the maintenance schedule", "error");
      }).then(function () {
        // Reload either way: a refusal is usually a stale tab, and the fresh
        // read is what tells the operator what is actually true now.
        _loadMaintenanceEditInfo(asset, { afterAction: true });
        if (typeof loadAssets === "function") loadAssets();
      });
    });
  });
}

// Options for a per-stream credential picker over the cached credential list.
// The rules (a STORED credential is always an option, named, whatever the
// method's type) live in _credentialOptionsHTML in polling-methods.js, shared
// with the phone's Monitoring sheet; _credTypeForPolling lives there too.
function _credentialOptionsForStream(selectedId, credType) {
  return _credentialOptionsHTML(_credentialCache.list, selectedId, credType);
}

async function _wireMonitorEditTab(asset) {
  // Before the credential fetch, not after: the Maintenance tab is a sibling
  // panel that's clickable the moment the modal paints, and its listeners
  // must not wait on an unrelated network round-trip.
  _wireMaintenanceEditSection(asset);
  await _ensureCredentials();
  var monChk = document.getElementById("f-monitored");
  // Status gate (business rule 10): decommissioned / disabled / storage /
  // quarantined assets are not polled, so the checkbox is disabled — and
  // cleared, so a save can't post a value the API would refuse — while the
  // Status select sits on one of them. Re-evaluated on every status change
  // rather than once at paint: Status lives on the General tab of this same
  // modal, so the operator can make monitoring legal without leaving the form.
  var statusEl = document.getElementById("f-status");
  var monBlockedEl = document.getElementById("f-monitored-blocked");
  function refreshMonitorableGate() {
    if (!monChk) return;
    var st = statusEl ? statusEl.value : (asset && asset.status);
    var ok = statusAllowsMonitoring(st);
    monChk.disabled = !ok;
    if (!ok) monChk.checked = false;
    if (monBlockedEl) {
      monBlockedEl.style.display = ok ? "none" : "";
      monBlockedEl.textContent = ok
        ? ""
        : "A " + st + " asset is not polled. Set Status to something else on the General tab to enable monitoring.";
    }
    // Let the rest of the tab (interval / timeout / transport block) react to
    // a checkbox this gate just cleared.
    monChk.dispatchEvent(new Event("change"));
  }
  if (statusEl) statusEl.addEventListener("change", refreshMonitorableGate);
  var intervalEl = document.getElementById("f-monitorInterval");
  var probeTimeoutEl = document.getElementById("f-probeTimeoutMs");
  var probeTimeoutWarn = document.getElementById("f-probeTimeoutMs-warn");

  var transportWrap = document.getElementById("f-transport-wrap");

  // Wire the per-stream subtab strip inside the Polling Methods block so
  // clicking a stream tab actually swaps the body. wireModalTabs is a
  // global helper from integrations.js (loaded before assets.js on every
  // page that needs the asset modal).
  if (transportWrap && typeof wireModalTabs === "function") {
    wireModalTabs("asset-mon-streams");
  }

  // Per-stream selects and their corresponding polling selects. Storage has
  // no MIB picker (HOST-RESOURCES-MIB + vendor fallback covers it without
  // operator input), so mibId is null and the wiring helper below skips the
  // MIB-show/hide step for that row.
  var streamDefs = [
    { pollId: "f-responseTimePolling", credId: "f-responseTimeCredential", mibId: "f-responseTimeMib" },
    { pollId: "f-cpuMemoryPolling",    credId: "f-cpuMemoryCredential",    mibId: "f-telemetryMib"    },
    { pollId: "f-temperaturePolling",  credId: "f-temperatureCredential",  mibId: "f-temperatureMib"  },
    { pollId: "f-interfacesPolling",   credId: "f-interfacesCredential",   mibId: "f-interfacesMib"   },
    { pollId: "f-storagePolling",      credId: "f-storageCredential",      mibId: null                },
    { pollId: "f-lldpPolling",         credId: "f-lldpCredential",         mibId: "f-lldpMib"         },
  ];

  function refreshStreamCred(streamDef) {
    var pollEl    = document.getElementById(streamDef.pollId);
    var credEl    = document.getElementById(streamDef.credId);
    var credWrap  = document.getElementById(streamDef.pollId + "-cred-wrap");
    var mibWrap   = document.getElementById(streamDef.pollId + "-mib-wrap");
    if (!pollEl) return;
    var method   = pollEl.value || null;
    var credType = _credTypeForPolling(method);
    if (credEl && credWrap) {
      var current = credEl.getAttribute("data-current-id") || "";
      var credHint = document.getElementById(streamDef.pollId + "-cred-hint");
      if (credType || current) {
        // A method with no credential type of its own ("Inherit", ICMP, Agent,
        // Disabled) still shows the picker when the row STORES a credential:
        // the dispatchers apply it whenever the resolved method takes that
        // type, so hiding it hid a live setting. "Source default" clears it.
        credEl.innerHTML = _credentialOptionsForStream(current, credType);
        credWrap.style.display = "flex";
      } else {
        credEl.innerHTML = "";
        credWrap.style.display = "none";
      }
      if (credHint) credHint.style.display = (!credType && current) ? "" : "none";
    }
    // MIB sub-row appears only when the stream is set to SNMP. Streams that
    // don't carry a MIB picker (storage) have no wrap div to toggle.
    if (mibWrap && streamDef.mibId) mibWrap.style.display = (method === "snmp") ? "flex" : "none";
  }

  function refresh() {
    var enabled = !!(monChk && monChk.checked);
    if (intervalEl) intervalEl.disabled = !enabled;
    if (probeTimeoutEl) probeTimeoutEl.disabled = !enabled;
    if (transportWrap) {
      transportWrap.style.display = enabled ? "block" : "none";
    }
    // Populate / show-hide per-stream credential and MIB pickers.
    streamDefs.forEach(refreshStreamCred);
  }
  if (monChk) monChk.addEventListener("change", refresh);

  // Wire per-stream polling dropdowns so credential and MIB sub-rows update on change.
  streamDefs.forEach(function (sd) {
    var pollEl = document.getElementById(sd.pollId);
    if (pollEl) {
      pollEl.addEventListener("change", function () {
        // Clear the stored "current" so switching methods doesn't carry over
        // a credential from a different type.
        var credEl = document.getElementById(sd.credId);
        if (credEl) credEl.setAttribute("data-current-id", "");
        refreshStreamCred(sd);
      });
    }
  });

  refresh();
  // After refresh() so the gate's dispatched change event lands on a wired
  // listener rather than being swallowed.
  refreshMonitorableGate();

  // Soft warning when probe timeout drops below 500 ms — Zod still allows
  // 100, but at that range probes false-fail under healthy network conditions.
  function checkProbeTimeoutWarn() {
    if (!probeTimeoutEl || !probeTimeoutWarn) return;
    var v = parseInt(probeTimeoutEl.value, 10);
    var show = Number.isFinite(v) && v > 0 && v < 500;
    probeTimeoutWarn.style.display = show ? "block" : "none";
  }
  if (probeTimeoutEl) {
    probeTimeoutEl.addEventListener("input", checkProbeTimeoutWarn);
    checkProbeTimeoutWarn();
  }

  // Tier badges + Asset Overrides button — only meaningful on edit (existing
  // asset). The create flow has no asset id and skips both.
  if (asset && asset.id) {
    _populateAssetMonitorTierBadges(asset);
    _wireAssetOverridesButton(asset);
  }
}

/**
 * Fetches the per-asset effective monitor settings and stamps a small
 * "(from class override: 60s)" badge next to each cadence/timeout label.
 * Best-effort — failure leaves the badges blank.
 */
/**
 * Name the automation that decides this device is Down, and the count it asks
 * for — plus the resulting wall-clock time, using this asset's OWN resolved
 * interval and timeout (which is why this lives beside the tier-badge walk:
 * that fetch already has both halves).
 *
 * Three states, and the passive one is the reason this isn't just a number:
 * a device no automation covers is never declared Down at all, and printing a
 * threshold for it would be a lie.
 */
function _paintDownDetectionHint(eff, asset) {
  var el = document.getElementById("f-down-detection");
  if (!el) return;
  var dd = eff && eff.downDetection;
  if (!dd) { el.textContent = "Could not resolve which automation decides Down for this device."; return; }
  if (dd.passive) {
    el.innerHTML = "<strong>Passive</strong> — no down-detection automation covers this device. " +
      "Polaris records its polls but will never declare it Missed or Down. " +
      '<a href="/automations.html">Manage down detection &rarr;</a>';
    return;
  }
  var calc = window.PolarisMonitorDownAfter && window.PolarisMonitorDownAfter.calc;
  var resolved = eff.resolved || {};
  var txt = "Down after <strong>" + dd.missedPolls + " missed poll" + (dd.missedPolls === 1 ? "" : "s") + "</strong>";
  if (calc) {
    var c = calc(dd.missedPolls, resolved.intervalSeconds, resolved.probeTimeoutMs, dd.recoveryPolls);
    txt += " ≈ " + window.PolarisMonitorDownAfter.human(c.realSec) +
      " at this device's " + c.interval + "s poll interval";
  }
  if (dd.automationName) txt += ", set by <strong>" + escapeHtml(dd.automationName) + "</strong>";
  txt += ".";
  // The way back is the same automation's answer, so it belongs in the same
  // sentence — an operator who set "5 received polls" is otherwise left to
  // discover on the strip that Up takes longer than Down did.
  if (dd.recoveryPolls > dd.missedPolls) {
    txt += " Back to Up after <strong>" + dd.recoveryPolls + " received polls</strong>.";
  }
  if (dd.conflict) {
    txt += " <span style=\"color:var(--color-warning)\">Another equally-specific automation asks for " +
      dd.conflict.counts.filter(function (n) { return n !== dd.conflict.chosen; }).join(" / ") +
      " — Polaris uses the smaller count. Narrow one of the two device filters to make the choice explicit.</span>";
  }
  el.innerHTML = txt;
}
async function _populateAssetMonitorTierBadges(asset) {
  var eff;
  try { eff = await api.assets.effectiveMonitorSettings(asset.id); } catch (e) { return; }
  if (!eff || !eff.provenance || !eff.resolved) return;
  // Cache resolved settings so stale-banner slots can re-evaluate against the
  // class/integration tier the sync render couldn't see, and fire that
  // re-evaluation immediately for any slots already in the DOM.
  _effectiveResolvedByAssetId.set(asset.id, eff.resolved);
  _updateStaleBannersFromEffective(asset.id, asset);

  _paintDownDetectionHint(eff, asset);
  _paintStreamMibUses(document, eff.manufacturerProfile || null);

  function tierLabel(tier) {
    if (tier === "asset")       return null; // own override — no badge needed; the input itself IS the value
    if (tier === "class")       return "from class override";
    if (tier === "integration") return "from integration tier";
    if (tier === "manual")      return "from manual tier";
    return null;
  }
  function setBadge(spanId, fieldKey, suffix) {
    var span = document.getElementById(spanId);
    if (!span) return;
    var prov  = eff.provenance[fieldKey];
    var label = tierLabel(prov);
    if (!label) {
      // "asset" (per-asset override is set) — no inherited badge to show.
      // Clear the span in case a stale value is hanging around.
      span.textContent = "";
      return;
    }
    span.textContent = "(" + label + ": " + eff.resolved[fieldKey] + (suffix || "") + ")";
  }
  setBadge("f-monitorInterval-tier",       "intervalSeconds",       " s");
  setBadge("f-probeTimeoutMs-tier",        "probeTimeoutMs",        " ms");
  setBadge("f-cpuMemoryTimeoutMs-tier",    "cpuMemoryTimeoutMs",    " ms");
  setBadge("f-temperatureTimeoutMs-tier",  "temperatureTimeoutMs",  " ms");
  setBadge("f-systemInfoTimeoutMs-tier",   "systemInfoTimeoutMs",   " ms");

  // Update each polling dropdown's "Inherit" option to show what selecting
  // Inherit would actually resolve to and which tier it comes from, instead
  // of the hardcoded source default. Prefers the server's `inheritPolling`
  // block — the resolution WITHOUT the per-asset tier — so the preview is
  // correct even when the asset currently carries its own override (the
  // previous provenance!=="asset" guard left the label stuck on the static
  // source-default text in that state, which read as "the integration option
  // is gone" whenever an operator had set a per-asset method). Falls back to
  // the final resolved value for pre-upgrade servers that don't send it.
  function updatePollingInheritLabel(selectId, fieldKey) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    var hasPreview = eff.inheritPolling && eff.inheritPolling.provenance && (fieldKey in eff.inheritPolling.provenance);
    var prov = hasPreview ? eff.inheritPolling.provenance[fieldKey] : eff.provenance[fieldKey];
    // "default" = no tier sets a compatible method; the hardcoded
    // "Source default: X" label the HTML was built with is already right.
    if (!prov || prov === "asset" || prov === "default") return;
    var resolved = hasPreview ? eff.inheritPolling.values[fieldKey] : eff.resolved[fieldKey];
    var inheritOpt = sel.querySelector('option[value=""]');
    if (!inheritOpt) return;
    if (!resolved) {
      // No explicit method set at any tier — source default applies at runtime.
      // Leave the hardcoded "Source default: X" label the HTML was built with.
      return;
    }
    var methodLabel = _POLLING_LABELS[resolved] || resolved;
    var integName = asset && asset.discoveredByIntegration && asset.discoveredByIntegration.name;
    var tierStr = prov === "integration" && integName
      ? integName
      : { "class": "class override", "integration": "integration tier", "manual": "manual tier" }[prov] || prov;
    inheritOpt.textContent = "Inherit (" + tierStr + ": " + methodLabel + ")";
  }
  updatePollingInheritLabel("f-responseTimePolling", "responseTimePolling");
  updatePollingInheritLabel("f-cpuMemoryPolling",    "cpuMemoryPolling");
  updatePollingInheritLabel("f-temperaturePolling",  "temperaturePolling");
  updatePollingInheritLabel("f-interfacesPolling",   "interfacesPolling");
  updatePollingInheritLabel("f-lldpPolling",         "lldpPolling");
  updatePollingInheritLabel("f-storagePolling",      "storagePolling");
}

/**
 * Reveal + wire the "Show other asset overrides" button. Click opens a
 * slide-over modal listing assets under the same (assetType, integrationId)
 * scope that have at least one per-asset override set.
 */
function _wireAssetOverridesButton(asset) {
  var wrap = document.getElementById("f-asset-overrides-wrap");
  var btn  = document.getElementById("btn-asset-overrides-list");
  if (!wrap || !btn) return;
  wrap.style.display = "block";
  btn.addEventListener("click", function () {
    _openAssetOverridesSlideover({
      integrationId: asset.discoveredByIntegrationId || null,
      assetType:     asset.assetType,
      thisAssetId:   asset.id,
      sourceLabel:   asset.discoveredByIntegration ? asset.discoveredByIntegration.name : "Manual",
    });
  });
}

async function _openAssetOverridesSlideover(scope) {
  var classLabel = ASSET_TYPE_LABELS[scope.assetType] || scope.assetType;
  var titleScope = classLabel + " @ " + (scope.sourceLabel || "Manual");
  openModal(
    "Asset Overrides — " + titleScope,
    '<div class="empty-state" style="padding:2rem 0">Loading…</div>',
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>'
  );
  var rows;
  try {
    rows = await api.monitorSettings.assetOverrides({
      integrationId: scope.integrationId,
      assetType:     scope.assetType,
    });
  } catch (err) {
    var bodyEl = document.querySelector("#modal-overlay .modal-body");
    if (bodyEl) bodyEl.innerHTML = '<div class="empty-state" style="padding:2rem 0;color:var(--color-danger)">Failed to load: ' + escapeHtml(err.message || "unknown error") + '</div>';
    return;
  }
  // Exclude the asset whose modal is being viewed — the operator's already
  // looking at it. Showing it again would just be visual noise.
  var others = (rows || []).filter(function (r) { return r.id !== scope.thisAssetId; });
  var bodyEl = document.querySelector("#modal-overlay .modal-body");
  if (!bodyEl) return;
  if (others.length === 0) {
    bodyEl.innerHTML = '<div class="empty-state" style="padding:2rem 0">No other ' +
      escapeHtml(classLabel.toLowerCase()) +
      ' assets under this source have per-asset overrides.</div>';
    return;
  }
  bodyEl.innerHTML = '<p class="hint" style="margin-bottom:0.75rem">Other ' +
    escapeHtml(classLabel.toLowerCase()) +
    ' assets discovered by ' + escapeHtml(scope.sourceLabel || "Manual") +
    ' that have at least one per-asset monitor override. Click a row to open the asset.</p>' +
    '<table style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Hostname</th>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">IP</th>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Overrides</th>' +
      '</tr></thead>' +
      '<tbody>' +
      others.map(function (a) {
        var bits = [];
        if (a.monitorIntervalSec     != null) bits.push("interval=" + a.monitorIntervalSec + "s");
        if (a.cpuMemoryIntervalSec   != null) bits.push("cpu-mem=" + a.cpuMemoryIntervalSec + "s");
        if (a.temperatureIntervalSec != null) bits.push("temp=" + a.temperatureIntervalSec + "s");
        if (a.systemInfoIntervalSec  != null) bits.push("sysinfo=" + a.systemInfoIntervalSec + "s");
        if (a.probeTimeoutMs         != null) bits.push("probe-timeout=" + a.probeTimeoutMs + "ms");
        if (a.cpuMemoryTimeoutMs     != null) bits.push("cpu-mem-timeout=" + a.cpuMemoryTimeoutMs + "ms");
        if (a.temperatureTimeoutMs   != null) bits.push("temp-timeout=" + a.temperatureTimeoutMs + "ms");
        if (a.systemInfoTimeoutMs    != null) bits.push("sysinfo-timeout=" + a.systemInfoTimeoutMs + "ms");
        // The streams added after this list was written — every column
        // monitorSettingsService.ASSET_OVERRIDE_COLUMNS returns, so an asset
        // listed for one of them never shows an empty summary.
        if (a.lldpIntervalSec        != null) bits.push("lldp=" + a.lldpIntervalSec + "s");
        if (a.storageIntervalSec     != null) bits.push("storage=" + a.storageIntervalSec + "s");
        if (a.processesIntervalSec   != null) bits.push("processes=" + a.processesIntervalSec + "s");
        if (a.eventLogIntervalSec    != null) bits.push("event-log=" + a.eventLogIntervalSec + "s");
        if (a.customWidgetIntervalSec != null) bits.push("custom-widget=" + a.customWidgetIntervalSec + "s");
        if (a.processesTimeoutMs     != null) bits.push("processes-timeout=" + a.processesTimeoutMs + "ms");
        if (a.eventLogTimeoutMs      != null) bits.push("event-log-timeout=" + a.eventLogTimeoutMs + "ms");
        [["responseTimePolling", "response"], ["cpuMemoryPolling", "cpu-mem"], ["temperaturePolling", "temp"],
         ["interfacesPolling", "interfaces"], ["lldpPolling", "lldp"], ["storagePolling", "storage"],
         ["processesPolling", "processes"], ["eventLogPolling", "event-log"]].forEach(function (p) {
          if (a[p[0]] != null) bits.push(p[1] + " via " + a[p[0]]);
        });
        return '<tr style="cursor:pointer" data-asset-link="' + escapeHtml(a.id) + '">' +
          '<td style="padding:6px 8px"><a href="#" onclick="return false">' + escapeHtml(a.hostname || "(no hostname)") + '</a></td>' +
          '<td style="padding:6px 8px;font-family:var(--font-mono)">' + escapeHtml(a.ipAddress || "-") + '</td>' +
          '<td style="padding:6px 8px;font-size:0.78rem;color:var(--color-text-tertiary)">' + escapeHtml(bits.join(", ")) + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody>' +
    '</table>';
  bodyEl.querySelectorAll("[data-asset-link]").forEach(function (row) {
    row.addEventListener("click", function () {
      var id = row.getAttribute("data-asset-link");
      closeModal();
      // Defer one tick so the close animation doesn't fight the open below.
      setTimeout(function () { openViewModal(id); }, 100);
    });
  });
}

/**
 * Wire the Add Asset form's IP cross-reference panel (assets-ipcontext.js).
 *
 * The module owns the lookup and the rendering; this supplies the two hooks
 * that need to know the form — what the operator has already typed (so a
 * suggestion never overwrites it) and how to write an accepted one back.
 * Coordinates arrive as a pair or not at all, which is what getAssetFormData
 * demands of them.
 */
function _wireIpContextPanel() {
  if (!window.PolarisIpContext) return;
  window.PolarisIpContext.mount({
    inputId: "f-ipAddress",
    panelId: "f-ip-context",
    readForm: function () {
      return {
        hostname:   val("f-hostname"),
        macAddress: val("f-macAddress"),
        location:   val("f-location"),
        latitude:   val("f-latitude"),
        longitude:  val("f-longitude"),
      };
    },
    applyValues: function (values) {
      Object.keys(values).forEach(function (key) {
        var el = document.getElementById("f-" + key);
        if (el) el.value = values[key];
      });
    },
  });
}

async function openCreateModal() {
  await _ensureTagCache();
  var body = tabbedBodyHTML("asset-edit", [
    { key: "general",    label: "General",    html: assetFormHTML({}) },
    { key: "monitoring", label: "Monitoring", html: assetMonitoringFormHTML({}) },
  ]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create Asset</button>';
  openModal("Add Asset", body, footer);
  wireModalTabs("asset-edit");
  wireDescriptionCapWarning("f-description", "f-description-cap-warn");
  wireTagPicker();
  _wireMonitorEditTab({});
  _wireIpContextPanel();
  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var formData = getAssetFormData();
      // Rule 40(i): a typed address that another asset already holds is a
      // collision the operator should hear about before, not after, the save.
      var pre = await _preflightDuplicateIp(formData.ipAddress, null, formData);
      if (!pre.proceed) return;
      var created = await api.assets.create(formData);
      closeModal();
      showToast(created && created.ipConflict
        ? "Asset created — duplicate IP submitted for conflict review"
        : "Asset created");
      loadAssets();
      if (pre.mergeWith && created && created.id && typeof openAssetMergeModal === "function") {
        openAssetMergeModal(created.id, pre.mergeWith, { onMerged: loadAssets });
      }
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// "Revert to discovered IP" under a pinned IP field. Marks the field so
// getAssetFormData sends ipRevertToDiscovered; the address itself is decided
// server-side on save (the projection), so the field shows a placeholder
// until then. Typing an address afterwards cancels the revert.
function _wireIpRevertLink() {
  var link = document.getElementById("f-ipRevert");
  var input = document.getElementById("f-ipAddress");
  if (!link || !input) return;
  link.addEventListener("click", function (e) {
    e.preventDefault();
    input.setAttribute("data-ip-revert", "1");
    input.value = "";
    input.placeholder = "discovered address — applied on save";
    link.parentNode.textContent = "Will revert to the discovered address on save.";
  });
  input.addEventListener("input", function () {
    if (input.value.trim() !== "") input.removeAttribute("data-ip-revert");
  });
}

async function openEditModal(id, opts) {
  opts = opts || {};
  try {
    // Fetch in parallel: asset, tag cache, and the agent state. The
    // Monitoring tab branches on whether an agent is installed (active
    // or in-flight) — when one is, we hide the per-stream polling
    // dropdowns and show a status block instead, since the agent owns
    // all four streams. api.assets.agent resolves to null on 404.
    var results = await Promise.all([
      api.assets.get(id),
      _ensureTagCache(),
      api.assets.agent(id).catch(function () { return null; }),
    ]);
    var asset = results[0];
    var managedAgent = results[2];
    asset._editing = true;
    var editTabs = [
      { key: "general",    label: "General",    html: assetFormHTML(asset) },
      { key: "monitoring", label: "Monitoring", html: assetMonitoringFormHTML(asset, managedAgent) },
    ];
    // Maintenance is edit-only (the ad-hoc window realizes as a one-shot
    // schedule against an existing asset), so it never appears on create.
    if (asset.id) {
      editTabs.push({ key: "maintenance", label: "Maintenance", html: assetMaintenanceFormHTML(asset) });
    }
    var body = tabbedBodyHTML("asset-edit", editTabs);
    // Delete sits on the far left of the footer (margin-right:auto), well away
    // from Save, and only for an existing asset the operator may manage — the
    // same gate the row menu's Delete carries, since DELETE /assets/:id is
    // assets:write server-side.
    var footer = (asset.id && _canEditAsset(asset)
        ? '<button class="btn btn-danger" id="btn-delete-asset" style="margin-right:auto">Delete Asset</button>'
        : '') +
      '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    var title = "Edit Asset" + (asset.hostname ? " — " + asset.hostname : "");
    openModal(title, body, footer, { wide: true });
    wireModalTabs("asset-edit");
    // Open on a caller-requested tab (e.g. the System-tab "Unmonitored" pill
    // deep-links here to Monitoring). Falls back to the default first tab.
    if (opts.tab) {
      var tabBtn = document.querySelector('#asset-edit-tabs .page-tab[data-tab="' + opts.tab + '"]');
      if (tabBtn) tabBtn.click();
    }
    wireDescriptionCapWarning("f-description", "f-description-cap-warn");
    wireTagPicker();
    _wireIpRevertLink();
    _wireMonitorEditTab(asset);

    // Wire the "Install Polaris Agent…" button when present (no agent
    // installed + source supports agent). Reuses the same install modal
    // the asset details panel surfaces, so the operator flow is
    // consistent regardless of entry point. Closes this edit modal
    // before opening the install modal so the operator doesn't end up
    // with stacked modals; their unsaved changes would be lost, but
    // the install flow is the meaningful work here.
    var editInstallBtn = document.getElementById("btn-edit-modal-install-agent");
    if (editInstallBtn) {
      editInstallBtn.addEventListener("click", function () {
        closeModal();
        _openInstallAgentModal(asset);
      });
    }
    // Delete from inside the edit modal. showConfirm builds its own overlay at a
    // higher z-index, so this modal's form DOM survives a cancel and the
    // operator lands back on their unsaved edits. On confirm the edit modal
    // closes, and so does the details panel behind it when it is showing the
    // asset we just removed — leaving it open would show a record that no
    // longer exists and its refresh timers would 404 on the next tick.
    var deleteBtn = document.getElementById("btn-delete-asset");
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async function () {
        var btn = this;
        // Rule 163: warns, and offers an uninstall first, when this device has
        // the Polaris Agent. Its dialogs stack over this modal, as showConfirm
        // does, so a cancel still lands back on the unsaved edits.
        var go = await confirmAssetDeletion([id], 'Delete asset "' + (asset.hostname || "-") + '"? This cannot be undone.');
        if (!go || !go.length) return;
        btn.disabled = true;
        try {
          await api.assets.delete(id);
          closeModal();
          if (_isCurrentAsset(id)) closeAssetPanel();
          showToast("Asset deleted");
          loadAssets();
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          btn.disabled = false;
        }
      });
    }

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        // Read the Maintenance tab's ad-hoc request BEFORE the update, and
        // reject an incomplete one up front — a half-filled datetime-local
        // reads as "" and used to be silently dropped after a successful
        // save, which is exactly what "it didn't save the maintenance mode"
        // looked like from the operator's side.
        var maint = _readAdhocMaintenanceRequest();
        if (maint.error) { _setMaintFormError(maint.error); throw new Error(maint.error); }
        _setMaintFormError("");
        var formData = getAssetFormData();
        // Rule 40(i): only a CHANGED address is a new claim worth asking
        // about — re-saving the form with the same IP is not.
        var ipChanged = typeof formData.ipAddress === "string" &&
          formData.ipAddress.trim() !== "" &&
          formData.ipAddress.trim() !== (asset.ipAddress || "");
        var pre = ipChanged
          ? await _preflightDuplicateIp(formData.ipAddress, id, formData)
          : { proceed: true, mergeWith: null };
        if (!pre.proceed) return;
        // Rule 103: a typed address is scored (and pinged from the server)
        // before it is pinned; below the warn line the operator is asked.
        if (ipChanged && !(await _confirmAddressConfidence(id, formData.ipAddress.trim(), { probe: true }))) return;
        // Rule 123: decommissioning an agent host archives its pinned SSH
        // thumbprint / TLS certificate — say so before it happens.
        if (formData.status === "decommissioned" && asset.status !== "decommissioned") {
          var pinNotice = await _fetchDecommissionPinNotice([id]);
          if (pinNotice && !(await showConfirm("Decommission " + (asset.hostname ? '"' + asset.hostname + '"' : "this asset") + "?\n\n" + pinNotice))) return;
        }
        var updated = await api.assets.update(id, formData);
        // Rule 150: a description naming a new room / rack / junction box
        // offers a Wall or Rack view for it (after the save, never blocking it).
        if (typeof formData.description === "string" && formData.description !== (asset.description || "") &&
            typeof _loadPanelScript === "function") {
          var descBefore = asset.description || "", descAfter = formData.description;
          _loadPanelScript("/js/region-view-prompt.js").then(function () {
            if (window.PolarisRegionViewPrompt) {
              window.PolarisRegionViewPrompt.afterSave({ assetId: id, before: descBefore, after: descAfter, assetName: asset.hostname });
            }
          }).catch(function () { /* the prompt is optional */ });
        }
        var maintApplied = false;
        if (maint.requested) {
          if (typeof window.maintCreateAdhoc !== "function") {
            throw new Error("Maintenance scheduling isn’t available on this page — use Assets → Maintenance.");
          }
          await window.maintCreateAdhoc(id, asset.hostname, maint.until,
            { suppressChildren: maint.suppressChildren });
          // The schedule can exist without the asset entering maintenance —
          // targets are intersected with monitored=true server-side. Say so
          // rather than claiming a window that isn't open.
          maintApplied = await api.assets.maintenanceInfo(id)
            .then(function (info) { return !!(info && info.inMaintenance); })
            .catch(function () { return true; });
        }
        closeModal();
        if (maint.requested && maintApplied) showToast("Asset updated — maintenance mode active");
        else if (maint.requested) {
          showToast("Asset updated and schedule created, but the asset did not enter maintenance " +
            "(only monitored assets can).", "error");
        } else showToast(updated && updated.ipConflict
          ? "Asset updated — duplicate IP submitted for conflict review"
          : "Asset updated");
        loadAssets();
        if (pre.mergeWith && typeof openAssetMergeModal === "function") {
          // The operator chose the merge review over the conflict card: open
          // it now, over the list, instead of re-rendering the details panel
          // for a record they are about to fold into another one.
          if (_isCurrentAsset(id)) closeAssetPanel();
          openAssetMergeModal(id, pre.mergeWith, { onMerged: loadAssets });
        } else if (_isCurrentAsset(id)) {
          // The details panel stays open behind this modal (neither the
          // panel's Edit button nor the monitoring-pill path closes it) —
          // re-render it so it doesn't sit on the pre-save values.
          openViewModal(id);
        }
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Monitoring (bulk + credential picker helpers) ─────────────────────────

var _credentialCache = { loaded: false, list: [] };

async function _ensureCredentials(force) {
  if (_credentialCache.loaded && !force) return _credentialCache.list;
  try {
    _credentialCache.list = await api.credentials.list();
    _credentialCache.loaded = true;
  } catch (_) {
    _credentialCache.list = [];
  }
  return _credentialCache.list;
}

// Curated install-method catalog (agentInstallScripts). Loaded once and cached
// for the deploy modals' OS-locked "Install method" picker.
var _agentInstallScriptsCache = { loaded: false, list: [] };

async function _ensureAgentInstallScripts(force) {
  if (_agentInstallScriptsCache.loaded && !force) return _agentInstallScriptsCache.list;
  try {
    var r = await api.assets.agentInstallScripts();
    _agentInstallScriptsCache.list = (r && r.scripts) || [];
    _agentInstallScriptsCache.loaded = true;
  } catch (_) {
    _agentInstallScriptsCache.list = [];
  }
  return _agentInstallScriptsCache.list;
}

// <option> HTML for the install-method variants available on a given OS.
// The per-OS default is pre-selected. Returns "" when the catalog is empty
// (network failure) — callers hide the picker and fall back to the default.
function _agentScriptOptionsFor(os) {
  var list = (_agentInstallScriptsCache.list || []).filter(function (s) { return s.osPlatform === os; });
  if (list.length === 0) return "";
  return list.map(function (s) {
    return '<option value="' + escapeHtml(s.id) + '"' + (s.isDefault ? " selected" : "") + '>' + escapeHtml(s.label) + '</option>';
  }).join("");
}

// True when an OS has more than one install-method variant (i.e. there's an
// actual choice to present). Bulk deploy uses this to avoid rendering a
// single-option select per OS in the common (one-variant) case.
function _agentScriptHasChoicesFor(os) {
  return (_agentInstallScriptsCache.list || []).filter(function (s) { return s.osPlatform === os; }).length > 1;
}

// ─── Monitoring Settings Modal ──────────────────────────────────────────────
// Opened from the "Monitoring Settings" button in the Assets page header.
// Two sections, both admin/assetsadmin only:
//
//   1. Manual Monitoring tier — settings for orphan / manually-created assets.
//      One form with the eight tier-3 fields. Save via
//      PUT /api/v1/monitor-settings/manual.
//
//   2. Class Overrides — list of (assetType + asset source) override rows.
//      Add / Edit / Delete. The integration tier (per-integration settings)
//      lives on the Integrations page and is edited from each integration's
//      Monitoring tab — it's intentionally NOT in this modal.
//
// All resolver caches invalidate server-side on every write.

var MON_TIER_DEFAULTS = {
  intervalSeconds:           60,
  // Dormant since 2026-08-19 (the fast-confirm re-probe was removed; in-run
  // resolution is the ICMP loss sampler's job and feeds packet loss only). Kept
  // to mirror the server's floor so a stored value still renders as inherited.
  fastConfirmIntervalSec:    10,
  probeTimeoutMs:            5000,
  cpuMemoryTimeoutMs:        10000,
  temperatureTimeoutMs:      10000,
  systemInfoTimeoutMs:       10000,
  cpuMemoryIntervalSeconds:  60,
  temperatureIntervalSeconds: 60,
  systemInfoIntervalSeconds: 600,
};

// Polling-method helpers (_POLLING_LABELS / _POLLING_COMPAT /
// _polarisPollingFourStreamHTML / _polarisReadPollingFourStream) are
// defined in integrations.js (loaded before this file on both
// integrations.html and assets.html), exposed globally on `window`.

var _monsetIntegrations  = [];   // for the source picker on add/edit
var _monsetOverrides     = [];   // class override rows currently rendered
var _monsetManualValues  = null; // last-fetched manual-tier settings (or null = not yet seeded)
var _monsetLifecycle     = { inactivityMonths: 0, historyRetentionDays: 0 }; // Asset Lifecycle section values
// Sources section: { order, integrationPrefix, contributors[] } from
// GET /assets/source-priority. `contributors` arrives in the operator's order,
// so the list renders straight through; dragging rewrites the array in place
// and Save posts the resulting `order`.
var _monsetSourcePriority = null;

async function openMonitoringSettingsModal() {
  // Loading shell first so the operator sees instant feedback. Replaced by
  // _monsetRender() below once the parallel fetches resolve.
  openModal(
    "Settings",
    '<div class="empty-state" style="padding:2rem 0">Loading…</div>',
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>',
    { wide: true }
  );
  try {
    var results = await Promise.all([
      api.monitorSettings.getManual().catch(function () { return null; }),
      api.monitorSettings.listClassOverrides({}).catch(function () { return []; }),
      api.integrations.list().catch(function () { return []; }),
      _ensureCredentials(),
      api.events.getAssetDecommissionSettings().catch(function () { return null; }),
      api.assets.getHistorySettings().catch(function () { return null; }),
      api.assets.getSourcePriority().catch(function () { return null; }),
    ]);
    _monsetManualValues = results[0] || Object.assign({}, MON_TIER_DEFAULTS);
    _monsetOverrides    = Array.isArray(results[1]) ? results[1] : [];
    var intgResp        = results[2];
    _monsetIntegrations = (intgResp && (intgResp.integrations || intgResp)) || [];
    var decom = results[4], hist = results[5];
    var m = decom ? Number(decom.inactivityMonths) : NaN;
    var d = hist ? Number(hist.retentionDays) : NaN;
    _monsetLifecycle = {
      inactivityMonths:     Number.isFinite(m) && m >= 0 ? Math.floor(m) : 0,
      historyRetentionDays: Number.isFinite(d) && d >= 0 ? Math.floor(d) : 0,
    };
    // null (fetch failed / older server) hides the Sources section rather than
    // rendering an empty list the operator could "save" as an empty order.
    var sp = results[6];
    _monsetSourcePriority = (sp && Array.isArray(sp.contributors) && sp.contributors.length) ? sp : null;
  } catch (err) {
    showToast(err.message || "Failed to load settings", "error");
    return;
  }
  _monsetRender();
}

function _monsetRender() {
  var lifecycleBody = _monsetLifecycleSectionHTML(_monsetLifecycle);
  var sourcesBody   = _monsetSourcesSectionHTML(_monsetSourcePriority);
  var manualBody    = _monsetManualSectionHTML(_monsetManualValues);
  var overridesBody = _monsetOverridesSectionHTML(_monsetOverrides);
  // Mass Pinning renders as a section like the rest ("" when its module didn't
  // load, which drops the section and its rule the same way an absent Sources
  // payload does).
  var massPinBody   = window.PolarisMassPin ? window.PolarisMassPin.sectionHTML() : "";
  var hr = '<hr style="margin:1.5rem 0;border:none;border-top:1px solid var(--color-border)">';
  var body = lifecycleBody + (sourcesBody ? hr + sourcesBody : "") + hr + manualBody + hr + overridesBody +
    (massPinBody ? hr + massPinBody : "");
  openModal(
    "Settings",
    body,
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>',
    { wide: true }
  );
  document.getElementById("btn-monset-save-lifecycle").addEventListener("click", _monsetSaveLifecycle);
  if (sourcesBody) _monsetWireSources();
  // Mass Pinning mounts its own condition builder + fetches its vocabulary;
  // idempotent per render via a dataset stamp that dies with the section DOM.
  if (massPinBody) window.PolarisMassPin.init();

  // Wire the Manual Monitoring stream-subtab tab strip so clicking a stream
  // tab activates its panel. Same shared helper the integration Monitoring
  // tab uses. Safe to call before the listeners below — they don't depend
  // on tab state.
  if (typeof wireModalTabs === "function") {
    wireModalTabs("monset-manual-streams");
  }
  // Reactive per-stream credential rows: each stream's polling-method
  // dropdown reveals the matching snmp/ssh/winrm credential row. Helper
  // lives in integrations.js (loaded before assets.js on assets.html).
  if (typeof _wireStreamCredentialPickerVisibility === "function") {
    _wireStreamCredentialPickerVisibility(document);
  }
  document.getElementById("btn-monset-save-manual").addEventListener("click", _monsetSaveManual);
  document.getElementById("btn-monset-add-override").addEventListener("click", function () {
    _monsetOpenOverrideEditor(null);
  });
  // Per-row edit/delete buttons. Reattach each render since the table HTML
  // is rebuilt above.
  var tbody = document.getElementById("monset-overrides-tbody");
  if (tbody) {
    tbody.querySelectorAll("[data-edit-override]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id  = btn.getAttribute("data-edit-override");
        var row = _monsetOverrides.find(function (o) { return o.id === id; });
        if (row) _monsetOpenOverrideEditor(row);
      });
    });
    tbody.querySelectorAll("[data-delete-override]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id  = btn.getAttribute("data-delete-override");
        var row = _monsetOverrides.find(function (o) { return o.id === id; });
        var label = row
          ? ((ASSET_TYPE_LABELS[row.assetType] || row.assetType) + " @ " + (row.integration ? row.integration.name : "Manual"))
          : "this override";
        var ok = await showConfirm("Delete class override for " + label + "?");
        if (!ok) return;
        try {
          await api.monitorSettings.deleteClassOverride(id);
          _monsetOverrides = _monsetOverrides.filter(function (o) { return o.id !== id; });
          _monsetRender();
          showToast("Override deleted");
        } catch (err) {
          showToast(err.message || "Failed to delete override", "error");
        }
      });
    });
  }
}

// Asset Lifecycle section of the merged Settings modal — the two fields that
// used to be the standalone "Asset Settings" modal.
function _monsetLifecycleSectionHTML(v) {
  return (
    '<h4 style="margin:0 0 0.75rem">Asset Lifecycle</h4>' +
    '<div class="form-group">' +
      '<label>Auto-Decommission Threshold (months)</label>' +
      '<input type="number" id="f-assets-inactivity-months" value="' + escapeHtml(String(v.inactivityMonths)) + '" min="0" max="120" style="max-width:120px">' +
      '<p class="hint">Assets whose <strong>Last Seen</strong> date is older than this many months are automatically moved to <strong>decommissioned</strong> status. ' +
        'Set to <strong>0</strong> to disable. The job runs every 24 hours. Assets in a maintenance window are never auto-decommissioned.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IP History Retention (days)</label>' +
      '<input type="number" id="f-assets-history-retention" value="' + escapeHtml(String(v.historyRetentionDays)) + '" min="0" max="3650" style="max-width:120px">' +
      '<p class="hint">IP address history older than this many days is removed. ' +
        'Set to <strong>0</strong> to disable retention limits and keep history indefinitely.</p>' +
    '</div>' +
    '<button class="btn btn-primary btn-sm" id="btn-monset-save-lifecycle">Save Lifecycle Settings</button>'
  );
}

// ── Sources section of the merged Settings modal ───────────────────────────
//
// The Assets table's "Sources" column shows `location || learnedLocation` —
// where an asset was learned. An asset known to several discovery sources at
// once (domain-joined AND Intune-enrolled AND sighted behind a FortiGate) has
// several competing answers, and which one an operator wants to read is a site
// convention. This list is that decision: drag to reorder, top wins.
//
// Labels + "what this contributes" hints come from the server's catalogue
// (utils/assetSourceLocation.ts) rather than being duplicated here, so adding a
// source kind server-side lights it up in this list with no client change.
function _monsetSourcesSectionHTML(sp) {
  if (!sp) return "";
  var rows = sp.contributors.map(function (c, i) {
    return _monsetSourceRowHTML(c, i);
  }).join("");
  return (
    '<h4 style="margin:0 0 0.35rem">Sources</h4>' +
    '<p class="hint" style="margin:0 0 0.75rem">The <strong>Sources</strong> column on the assets table shows where a device was learned. ' +
      'When a device is known to more than one discovery source, the highest source in this list that has something to say wins — ' +
      'drag to reorder. A device\'s own <strong>Location</strong> field, when an operator has set one, always outranks all of these.</p>' +
    '<div id="monset-src-list" class="monset-src-list">' + rows + '</div>' +
    '<label style="display:flex;align-items:flex-start;gap:0.5rem;margin:0.85rem 0 0.25rem;cursor:pointer">' +
      '<input type="checkbox" id="f-monset-src-prefix"' + (sp.integrationPrefix ? " checked" : "") + ' style="margin-top:0.2rem">' +
      '<span>Prefix FortiGate names with the integration that manages them' +
        '<span class="hint" style="display:block">Renders as <code class="mono">FortiManager-Prod:ACME-FW-ASHFIELD</code> instead of ' +
        '<code class="mono">ACME-FW-ASHFIELD</code>. Useful when several FortiManagers manage gates with overlapping names. ' +
        'Applies to FortiSwitch, FortiAP and FortiGate-sighted endpoints; devices discovered before this setting existed keep the bare name until their next discovery run.</span>' +
      '</span>' +
    '</label>' +
    '<button class="btn btn-primary btn-sm" id="btn-monset-save-sources" style="margin-top:0.5rem">Save Source Priority</button>' +
    '<p class="hint" style="margin:0.5rem 0 0">Takes effect on each integration\'s next discovery run — that\'s when a device\'s learned location is rewritten.</p>'
  );
}

function _monsetSourceRowHTML(c, i) {
  return (
    '<div class="monset-src-row" draggable="true" data-kind="' + escapeHtml(c.kind) + '">' +
      '<span class="aw-grip" title="Drag to reorder">⠿</span>' +
      '<span class="monset-src-rank">' + (i + 1) + '</span>' +
      '<span class="monset-src-body">' +
        '<span class="monset-src-label">' + escapeHtml(c.label) + '</span>' +
        '<span class="hint monset-src-desc">' + escapeHtml(c.describe || "") + '</span>' +
      '</span>' +
    '</div>'
  );
}

// Re-stamp the visible rank numbers after a drop. The DOM order is the source
// of truth for what Save posts — nothing is mirrored into _monsetSourcePriority
// until then, so a cancelled edit can't leave the cached copy half-updated.
function _monsetRenumberSources() {
  var list = document.getElementById("monset-src-list");
  if (!list) return;
  var rows = list.querySelectorAll(".monset-src-row");
  for (var i = 0; i < rows.length; i++) {
    var rank = rows[i].querySelector(".monset-src-rank");
    if (rank) rank.textContent = String(i + 1);
  }
}

// Vertical list reorder. Same grip + before/after edge-cue idiom as the column
// chooser (.sf-col-grip) and the automations condition builder (.aw-grip);
// simpler than either because this list is flat — no nesting, no drop-into.
function _monsetWireSources() {
  var list = document.getElementById("monset-src-list");
  if (!list) return;
  var dragEl = null;

  var clearCues = function () {
    list.querySelectorAll(".aw-drop-before, .aw-drop-after").forEach(function (el) {
      el.classList.remove("aw-drop-before", "aw-drop-after");
    });
  };

  list.addEventListener("dragstart", function (e) {
    var row = e.target.closest && e.target.closest(".monset-src-row");
    if (!row || !list.contains(row)) return;
    dragEl = row;
    row.classList.add("sf-col-dragging");
    try { e.dataTransfer.setData("text/plain", ""); e.dataTransfer.effectAllowed = "move"; } catch (_e) {}
  });

  list.addEventListener("dragover", function (e) {
    if (!dragEl) return;
    var over = e.target.closest && e.target.closest(".monset-src-row");
    if (!over || over === dragEl || !list.contains(over)) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = "move"; } catch (_e) {}
    var rect = over.getBoundingClientRect();
    var after = e.clientY > rect.top + rect.height / 2;
    clearCues();
    over.classList.add(after ? "aw-drop-after" : "aw-drop-before");
  });

  list.addEventListener("drop", function (e) {
    if (!dragEl) return;
    var over = e.target.closest && e.target.closest(".monset-src-row");
    if (!over || over === dragEl || !list.contains(over)) return;
    e.preventDefault();
    var rect = over.getBoundingClientRect();
    var after = e.clientY > rect.top + rect.height / 2;
    over.parentNode.insertBefore(dragEl, after ? over.nextSibling : over);
    clearCues();
    _monsetRenumberSources();
  });

  list.addEventListener("dragend", function () {
    if (dragEl) dragEl.classList.remove("sf-col-dragging");
    dragEl = null;
    clearCues();
  });

  var saveBtn = document.getElementById("btn-monset-save-sources");
  if (saveBtn) saveBtn.addEventListener("click", _monsetSaveSources);
}

async function _monsetSaveSources() {
  var btn = document.getElementById("btn-monset-save-sources");
  var list = document.getElementById("monset-src-list");
  if (!list) return;
  var order = Array.prototype.map.call(list.querySelectorAll(".monset-src-row"), function (row) {
    return row.getAttribute("data-kind");
  });
  var prefixEl = document.getElementById("f-monset-src-prefix");
  if (btn) btn.disabled = true;
  try {
    _monsetSourcePriority = await api.assets.updateSourcePriority({
      order: order,
      integrationPrefix: !!(prefixEl && prefixEl.checked),
    });
    showToast("Source priority saved — applies on each integration's next discovery run");
  } catch (err) {
    showToast(err.message || "Failed to save source priority", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function _monsetSaveLifecycle() {
  var btn = document.getElementById("btn-monset-save-lifecycle");
  if (btn) btn.disabled = true;
  try {
    var v = parseInt(document.getElementById("f-assets-inactivity-months").value, 10);
    var r = parseInt(document.getElementById("f-assets-history-retention").value, 10);
    _monsetLifecycle = {
      inactivityMonths:     Number.isFinite(v) && v >= 0 ? v : 0,
      historyRetentionDays: Number.isFinite(r) && r >= 0 ? r : 0,
    };
    await Promise.all([
      api.events.updateAssetDecommissionSettings({ inactivityMonths: _monsetLifecycle.inactivityMonths }),
      api.assets.updateHistorySettings({ retentionDays: _monsetLifecycle.historyRetentionDays }),
    ]);
    showToast("Asset lifecycle settings saved");
  } catch (err) {
    showToast(err.message || "Failed to save lifecycle settings", "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _monsetManualSectionHTML(v) {
  var values = v || MON_TIER_DEFAULTS;
  // Manual Monitoring is the bottom of the resolver hierarchy — there's
  // nothing to inherit from. Stamp sensible per-stream polling defaults
  // when the loaded tier doesn't already carry an explicit value:
  // Response Time → ICMP, every other stream → Disabled. Operators flip
  // streams on per-asset as needed. Explicit operator picks on a saved
  // Manual tier survive — we only fill nulls.
  var seeded = Object.assign({}, values);
  if (seeded.responseTimePolling == null) seeded.responseTimePolling = "icmp";
  if (seeded.cpuMemoryPolling    == null) seeded.cpuMemoryPolling    = "disabled";
  if (seeded.temperaturePolling  == null) seeded.temperaturePolling  = "disabled";
  if (seeded.interfacesPolling   == null) seeded.interfacesPolling   = "disabled";
  if (seeded.lldpPolling         == null) seeded.lldpPolling         = "disabled";
  if (seeded.storagePolling      == null) seeded.storagePolling      = "disabled";
  // Manual tier uses the same per-stream subtab layout the integration
  // Monitoring tab uses — Response Time / CPU+Memory / Temperature /
  // Interfaces / LLDP / Storage. No outer class strip (Manual has no per-
  // class breakdown). DOM id prefix `f-manual-mon-` namespaces every input
  // so it doesn't collide with the integration modal's `f-mon-` ids.
  // showInherit:false suppresses the misleading "Inherit" option in every
  // polling dropdown (Manual is the bottom of the resolver). showMib:false
  // drops the per-stream MIB picker here — Manual tier doesn't expose it
  // for this iteration; MIBs are picked at the asset tier instead.
  // _classStreamSubtabHTML and _streamsForClass are global function
  // declarations in integrations.js; tabbedBodyHTML / wireModalTabs are in app.js
  // (loaded before this file on assets.html), so they're directly callable.
  var creds = (typeof _credentialCache !== "undefined" && _credentialCache && Array.isArray(_credentialCache.list))
    ? _credentialCache.list
    : [];
  var streams = (typeof _streamsForClass === "function") ? _streamsForClass("manual") : [];
  var streamTabs = streams.map(function (stream) {
    return {
      key:   stream.key,
      label: stream.label,
      html:  _classStreamSubtabHTML("f-manual-mon-", "manual", "manual", stream, seeded, creds, false, {
        showInherit: false,
        showMib:     false,
      }),
    };
  });
  return '<div class="monset-section">' +
    '<h3 style="margin-bottom:0.25rem">Manual Monitoring</h3>' +
    '<p class="hint" style="margin:0 0 1rem 0;color:var(--color-text-tertiary)">Settings applied to assets without an integration source — manually-created assets, or assets whose origin integration was deleted.</p>' +
    tabbedBodyHTML("monset-manual-streams", streamTabs) +
    '<p class="hint" style="margin:0.5rem 0 0.5rem 0;color:var(--color-text-tertiary)">Manual tier accepts any method — operator picks per stream and supplies a credential at the asset level (or relies on ICMP).</p>' +
    '<p class="hint" style="margin:0 0 0.75rem 0;font-size:0.78rem">Sample retention is a global setting. Edit it in <a href="/server-settings.html?tab=retention">Server Settings → Retention</a>.</p>' +
    '<div style="margin-top:1rem;text-align:right">' +
      '<button class="btn btn-primary" id="btn-monset-save-manual">Save Manual Tier</button>' +
    '</div>' +
  '</div>';
}

function _monsetReadField(id, fallback) {
  var el = document.getElementById(id);
  if (!el || el.value === "") return fallback;
  var n = parseInt(el.value, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function _monsetSaveManual() {
  var btn = document.getElementById("btn-monset-save-manual");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Saving…";
  // Stream-subtab layout uses id prefix `f-manual-mon-` for numeric inputs
  // (cadences + timeouts + failure threshold) and `f-manual-mon-tier-` for
  // polling-method + MIB selects, mirroring the integration Monitoring tab's
  // _classStreamSubtabHTML(isPrimary=false) shape.
  var body = {
    intervalSeconds:           _monsetReadField("f-manual-mon-intervalSeconds",           MON_TIER_DEFAULTS.intervalSeconds),
    // Fast-confirm re-probe cadence (business rule 30). The input itself is
    // rendered by the SHARED _classStreamSubtabHTML from integrations.js, so the
    // manual tier picks it up with no markup of its own.
    probeTimeoutMs:            _monsetReadField("f-manual-mon-probeTimeoutMs",            MON_TIER_DEFAULTS.probeTimeoutMs),
    cpuMemoryTimeoutMs:        _monsetReadField("f-manual-mon-cpuMemoryTimeoutMs",        MON_TIER_DEFAULTS.cpuMemoryTimeoutMs),
    temperatureTimeoutMs:      _monsetReadField("f-manual-mon-temperatureTimeoutMs",      MON_TIER_DEFAULTS.temperatureTimeoutMs),
    systemInfoTimeoutMs:       _monsetReadField("f-manual-mon-systemInfoTimeoutMs",       MON_TIER_DEFAULTS.systemInfoTimeoutMs),
    cpuMemoryIntervalSeconds:  _monsetReadField("f-manual-mon-cpuMemoryIntervalSeconds",  MON_TIER_DEFAULTS.cpuMemoryIntervalSeconds),
    temperatureIntervalSeconds: _monsetReadField("f-manual-mon-temperatureIntervalSeconds", MON_TIER_DEFAULTS.temperatureIntervalSeconds),
    systemInfoIntervalSeconds: _monsetReadField("f-manual-mon-systemInfoIntervalSeconds", MON_TIER_DEFAULTS.systemInfoIntervalSeconds),
    // Phase 1 LLDP + Storage cadences. Persisted but inert today — see the
    // matching comment in integrations.js _readIntegrationCadenceForm.
    lldpIntervalSeconds:       _monsetReadField("f-manual-mon-lldpIntervalSeconds",       null),
    lldpTimeoutMs:             _monsetReadField("f-manual-mon-lldpTimeoutMs",             null),
    storageIntervalSeconds:    _monsetReadField("f-manual-mon-storageIntervalSeconds",    null),
    storageTimeoutMs:          _monsetReadField("f-manual-mon-storageTimeoutMs",          null),
  };
  Object.assign(body, _polarisReadPollingFourStream("f-manual-mon-tier-"));
  try {
    var saved = await api.monitorSettings.setManual(body);
    _monsetManualValues = saved || body;
    showToast("Manual monitoring settings saved");
  } catch (err) {
    showToast(err.message || "Failed to save manual settings", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Manual Tier";
  }
}

function _monsetOverridesSectionHTML(rows) {
  // Phase 2 (post-migration): Class Overrides surface is manual-scope-only.
  // Per-class settings for integration-discovered assets are configured on
  // each integration's Monitoring tab via the per-class streams blocks.
  // The Phase 2 migration job folded any historical integration-scoped
  // rows into the integration streams blocks and deleted them, so the
  // integrationId !== null filter here is defense-in-depth — the GET/POST
  // endpoints now reject integration-scoped writes outright (400).
  var manualRows = (rows || []).filter(function (o) { return !o.integrationId; });
  var rowHTML = manualRows.length === 0
    ? '<tr><td colspan="2" class="empty-state" style="text-align:center;padding:1rem">No manual-scope class overrides configured.</td></tr>'
    : manualRows.map(function (o) {
        var classLabel = ASSET_TYPE_LABELS[o.assetType] || o.assetType;
        return '<tr>' +
          '<td>' + escapeHtml(classLabel) + '</td>' +
          '<td class="actions" style="white-space:nowrap">' +
            '<button class="btn btn-sm btn-secondary" data-edit-override="' + escapeHtml(o.id) + '">Edit</button> ' +
            '<button class="btn btn-sm btn-danger"    data-delete-override="' + escapeHtml(o.id) + '">Delete</button>' +
          '</td>' +
        '</tr>';
      }).join("");
  return '<div class="monset-section">' +
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.25rem">' +
      '<h3 style="margin:0">Class Overrides</h3>' +
      '<button class="btn btn-primary" id="btn-monset-add-override">+ Add Override</button>' +
    '</div>' +
    '<div style="margin:0.25rem 0 0.5rem 0;padding:0.5rem 0.75rem;background:var(--color-bg-tertiary);border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-secondary);font-size:0.85rem">' +
      '<strong>Manual scope only — assets without an integration source.</strong>' +
    '</div>' +
    '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-text-tertiary)">Per-class settings for integration-discovered assets are configured on each integration\'s Monitoring tab. Use this section for manually-added assets organized by asset type.</p>' +
    '<table class="data-table" style="width:100%;border-collapse:collapse">' +
      '<thead><tr>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Class</th>' +
        '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--color-border)">Actions</th>' +
      '</tr></thead>' +
      '<tbody id="monset-overrides-tbody">' + rowHTML + '</tbody>' +
    '</table>' +
  '</div>';
}

function _monsetOpenOverrideEditor(existing) {
  var isEdit = !!existing;
  var classOpts = Object.keys(ASSET_TYPE_LABELS).map(function (key) {
    var sel = (existing && existing.assetType === key) ? " selected" : "";
    return '<option value="' + escapeHtml(key) + '"' + sel + '>' + escapeHtml(ASSET_TYPE_LABELS[key]) + '</option>';
  }).join("");
  var v = existing || Object.assign({}, MON_TIER_DEFAULTS);
  // Phase 1 Class Overrides is manual-scope only — the source picker is now
  // a static banner. Editing legacy integration-scoped rows would not work
  // here either; the filter in _monsetOverridesSectionHTML hides them from
  // the list, but defense-in-depth: if an operator somehow opens an
  // integration-scoped row via the edit pathway we still render the editor
  // (preserves manual editability of the cadence/timeout fields) — the
  // save handler still posts to the same row id.
  //
  // Stream-subtab layout — Response Time / CPU+Memory / Temperature /
  // Interfaces / LLDP / Storage — matches the canonical design in
  // polaris-ui-canon ("Polling methods section"). Reuses `_classStreamSubtabHTML`
  // with `isPrimary=false` + prefix `monset-ov-` so generated input ids
  // follow the same convention Manual Monitoring uses (polling/MIB selects
  // at `monset-ov-tier-<pollField>` / `monset-ov-tier-<streamKey>Mib`;
  // numeric inputs at `monset-ov-<field>`). showInherit:true — class
  // overrides legitimately defer to the integration / manual tier below.
  // showMib:true — per-stream MIB pickers are meaningful at this tier.
  var initialSourceKind = "manual";
  var creds = (_credentialCache && _credentialCache.list) ? _credentialCache.list : [];
  var streams = (typeof _streamsForClass === "function") ? _streamsForClass("manual") : [];
  var streamTabs = streams.map(function (stream) {
    return {
      key:   stream.key,
      label: stream.label,
      html:  _classStreamSubtabHTML("monset-ov-", initialSourceKind, "manual", stream, v, creds, false, {
        showInherit: true,
        showMib:     true,
      }),
    };
  });
  var body =
    '<div class="form-group"><label for="monset-ov-class">Class</label>' +
      '<select id="monset-ov-class"' + (isEdit ? " disabled" : "") + '>' + classOpts + '</select>' +
    '</div>' +
    '<div style="margin:0.25rem 0 0.75rem 0;padding:0.5rem 0.75rem;background:var(--color-bg-tertiary);border:1px solid var(--color-border);border-radius:var(--radius-sm);color:var(--color-text-secondary);font-size:0.85rem">' +
      '<strong>Manual scope only — assets without an integration source.</strong>' +
    '</div>' +
    (isEdit ? '<p class="hint" style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.25rem 0 0.75rem 0">Class is fixed for an existing override; delete and re-create to change it.</p>' : '') +
    '<div id="monset-ov-direct-poll-warning"></div>' +
    '<p class="hint" style="margin:0.5rem 0 0.75rem 0;color:var(--color-text-tertiary)">Leave a field blank to inherit from the source\'s tier.</p>' +
    tabbedBodyHTML("monset-ov-streams", streamTabs) +
    '<p class="hint" style="margin:0.5rem 0 0 0;font-size:0.78rem">Sample retention is a global setting. Edit it in <a href="/server-settings.html?tab=retention">Server Settings → Retention</a>.</p>';
  var footer = '<button class="btn btn-secondary" id="btn-monset-ov-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-monset-ov-save">' + (isEdit ? "Save Changes" : "Create Override") + '</button>';
  openModal(isEdit ? "Edit Class Override" : "Add Class Override", body, footer);
  if (typeof wireModalTabs === "function") wireModalTabs("monset-ov-streams");
  document.getElementById("btn-monset-ov-cancel").addEventListener("click", _monsetRender);
  document.getElementById("btn-monset-ov-save").addEventListener("click", function () {
    _monsetSaveOverride(existing);
  });

  // Wire per-stream polling dropdowns to show/hide the credential + MIB
  // sub-rows rendered by _classStreamSubtabHTML. Sub-row visibility rules:
  //   - credential row for a credtype shows when the picked method needs that
  //     credtype (snmp → snmp credrow, ssh → ssh credrow, winrm → winrm
  //     credrow; rest_api / icmp / disabled → no
  //     credrow)
  //   - MIB row shows when picked method is snmp
  var STREAMS_FULL = ["responseTime", "cpuMemory", "temperature", "interfaces", "lldp", "storage"];
  function _credtypeForMethod(method) {
    if (method === "snmp")  return "snmp";
    if (method === "ssh")   return "ssh";
    if (method === "winrm") return "winrm";
    return null;
  }
  function _ovPollFieldFor(streamKey) {
    return streamKey === "cpuMemory" ? "cpuMemoryPolling"
      : streamKey === "responseTime" ? "responseTimePolling"
      : streamKey + "Polling";
  }
  function _ovMibStreamKeyFor(streamKey) {
    // Mirror _ALL_STREAMS in integrations.js: cpuMemory uses telemetry MIB.
    if (streamKey === "cpuMemory") return "telemetry";
    return streamKey;
  }
  function _refreshOvStreamSubRows() {
    STREAMS_FULL.forEach(function (streamKey) {
      var pollId = "monset-ov-tier-" + _ovPollFieldFor(streamKey);
      var pollEl = document.getElementById(pollId);
      var method = pollEl ? pollEl.value : "";
      // Per-credtype rows are siblings: <pollId>-credrow-<credtype>
      ["snmp", "ssh", "winrm"].forEach(function (credType) {
        var row = document.getElementById(pollId + "-credrow-" + credType);
        if (!row) return;
        row.style.display = (_credtypeForMethod(method) === credType) ? "" : "none";
      });
      // MIB row id from _classStreamSubtabHTML: <prefix>tier-<mibStreamKey>-mib-wrap
      var mibStreamKey = _ovMibStreamKeyFor(streamKey);
      var mibWrap = document.getElementById("monset-ov-tier-" + mibStreamKey + "-mib-wrap");
      if (mibWrap) mibWrap.style.display = (method === "snmp") ? "" : "none";
    });
  }
  _refreshOvStreamSubRows();
  STREAMS_FULL.forEach(function (streamKey) {
    var pollEl = document.getElementById("monset-ov-tier-" + _ovPollFieldFor(streamKey));
    if (pollEl) pollEl.addEventListener("change", _refreshOvStreamSubRows);
  });

  // Pre-select per-stream credentials from the loaded override. _classStreamSubtabHTML
  // doesn't pre-select credentials because the integration modal's per-credtype
  // credential pickers are placeholders today; the class override row carries
  // real per-stream credential ids that we want reflected in the UI.
  var _OV_CRED_FIELDS = {
    responseTime: "responseTimeCredentialId",
    cpuMemory:    "cpuMemoryCredentialId",
    temperature:  "temperatureCredentialId",
    interfaces:   "interfacesCredentialId",
    lldp:         "lldpCredentialId",
  };
  Object.keys(_OV_CRED_FIELDS).forEach(function (streamKey) {
    var credId = v[_OV_CRED_FIELDS[streamKey]];
    if (!credId) return;
    var method = (v[_ovPollFieldFor(streamKey)] || "").toString();
    var credType = (method === "snmp") ? "snmp" : (method === "ssh") ? "ssh" : (method === "winrm") ? "winrm" : null;
    if (!credType) return;
    var sel = document.getElementById("monset-ov-tier-" + _ovPollFieldFor(streamKey) + "-cred-" + credType);
    if (sel) sel.value = credId;
  });

  // Class Overrides is manual-scope only now — there is no source picker to
  // wire, and the direct-poll warning (which only applies to FMG/FortiGate
  // integration-scoped switch/AP overrides) no longer fires from this surface.
  // The wrap div is left in place to avoid disturbing the surrounding DOM
  // layout; it stays empty in Phase 1 and is removed entirely when Phase 2
  // lands the backend narrowing.
}

async function _monsetSaveOverride(existing) {
  var btn = document.getElementById("btn-monset-ov-save");
  if (!btn) return;
  var prevText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";

  // Collect optional override fields. null = inherit from below.
  function readOptional(id) {
    var el = document.getElementById(id);
    if (!el || el.value === "") return null;
    var n = parseInt(el.value, 10);
    return Number.isFinite(n) ? n : null;
  }
  // Numeric inputs live at `monset-ov-<field>` (isPrimary=false in
  // _classStreamSubtabHTML uses `idPrefix + idSuffix` directly for the
  // numeric inputs — see numInput() inside that helper).
  var fields = {
    intervalSeconds:           readOptional("monset-ov-intervalSeconds"),
    probeTimeoutMs:            readOptional("monset-ov-probeTimeoutMs"),
    cpuMemoryTimeoutMs:        readOptional("monset-ov-cpuMemoryTimeoutMs"),
    temperatureTimeoutMs:      readOptional("monset-ov-temperatureTimeoutMs"),
    systemInfoTimeoutMs:       readOptional("monset-ov-systemInfoTimeoutMs"),
    cpuMemoryIntervalSeconds:  readOptional("monset-ov-cpuMemoryIntervalSeconds"),
    temperatureIntervalSeconds: readOptional("monset-ov-temperatureIntervalSeconds"),
    systemInfoIntervalSeconds: readOptional("monset-ov-systemInfoIntervalSeconds"),
  };
  // Polling-method selects use the `monset-ov-tier-` prefix (matches
  // the Manual Monitoring section's `f-manual-mon-tier-` convention).
  Object.assign(fields, _polarisReadPollingFourStream("monset-ov-tier-"));
  // Per-stream credentials: _classStreamSubtabHTML renders one select per
  // (stream × credtype) at `<pollId>-cred-<credtype>`. Pick the credential
  // matching the stream's chosen polling method; "Inherit / none" (empty)
  // also maps to null. The backend column is per-stream
  // (responseTimeCredentialId / cpuMemoryCredentialId / ...).
  var _OV_STREAM_TO_FIELDS = {
    responseTime: { pollField: "responseTimePolling", credField: "responseTimeCredentialId" },
    cpuMemory:    { pollField: "cpuMemoryPolling",    credField: "cpuMemoryCredentialId"    },
    temperature:  { pollField: "temperaturePolling",  credField: "temperatureCredentialId"  },
    interfaces:   { pollField: "interfacesPolling",   credField: "interfacesCredentialId"   },
    lldp:         { pollField: "lldpPolling",         credField: "lldpCredentialId"         },
    // Storage stream has no dedicated per-stream credential column on
    // MonitorClassOverride — the SNMP storage walk reuses whichever
    // credential the interfaces stream resolved.
  };
  Object.keys(_OV_STREAM_TO_FIELDS).forEach(function (streamKey) {
    var f = _OV_STREAM_TO_FIELDS[streamKey];
    var pollEl = document.getElementById("monset-ov-tier-" + f.pollField);
    var method = pollEl ? pollEl.value : "";
    var credType = (method === "snmp") ? "snmp"
      : (method === "ssh") ? "ssh"
      : (method === "winrm") ? "winrm"
      : null;
    if (!credType) {
      fields[f.credField] = null;
      return;
    }
    var credEl = document.getElementById("monset-ov-tier-" + f.pollField + "-cred-" + credType);
    fields[f.credField] = credEl ? (credEl.value || null) : null;
  });
  try {
    if (existing) {
      var updated = await api.monitorSettings.updateClassOverride(existing.id, fields);
      var idx = _monsetOverrides.findIndex(function (o) { return o.id === existing.id; });
      if (idx >= 0) _monsetOverrides[idx] = updated;
      showToast("Class override updated");
    } else {
      var assetType = document.getElementById("monset-ov-class").value;
      // Phase 1 narrowing: every new override is manual-scope.
      // Per-integration overrides are configured on each integration's
      // Monitoring tab.
      var created = await api.monitorSettings.createClassOverride(
        Object.assign({ assetType: assetType, integrationId: null }, fields)
      );
      _monsetOverrides.push(created);
      showToast("Class override created");
    }
    _monsetRender();
  } catch (err) {
    showToast(err.message || "Failed to save override", "error");
    btn.disabled    = false;
    btn.textContent = prevText;
  }
}

// One-click bulk monitoring toggle. The polling method comes from the
// resolver (per-asset overrides set via PUT, class overrides, integration
// tier, source default) — this endpoint just flips `monitored` on the
// selected rows. Per-asset polling adjustments are made through the asset
// edit modal's Monitoring tab.
async function bulkSetMonitoring(monitored) {
  var ids = Array.from(_assetsSelected);
  if (!ids.length) return;
  var btn = document.getElementById("assets-bulk-monitor-btn");
  if (btn) btn.disabled = true;
  var payload = monitored
    ? { ids: ids, monitored: true,  monitorCredentialId: null }
    : { ids: ids, monitored: false };
  try {
    var result = await api.assets.bulkMonitor(payload);
    var verb = monitored ? "Enabled" : "Disabled";
    var msg = verb + " monitoring on " + result.updated + " asset" + (result.updated !== 1 ? "s" : "");
    if (result.errors && result.errors.length) {
      // Name the reason, not just the count: the usual cause is a status that
      // can't be monitored (decommissioned / disabled / storage / quarantined),
      // and "3 skipped" on its own reads as a bug.
      var why = result.errors[0] && result.errors[0].error;
      showToast(msg + " — " + result.errors.length + " skipped" + (why ? " (" + why + ")" : ""), "error");
    } else {
      showToast(msg);
    }
    _assetsSelected.clear();
    loadAssets();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (btn) btn.disabled = false;
  }
}
