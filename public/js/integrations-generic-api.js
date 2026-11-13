/**
 * public/js/integrations-generic-api.js — the Generic API builder
 * (business rule 100): its General / Records & Mapping / Monitoring /
 * Networks / Preview / JSON tabs, getGenericApiFormConfig and the form wiring.
 *
 * Split out of integrations.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals. Loads AFTER
 * integrations.js — tests/unit/integrationsSplit.test.ts holds the order.
 */

// ─── Generic API ("build your own", business rule 100) ─────────────────────────
//
// Five tabs, all in the DOM at once so getGenericApiFormConfig() reads the
// whole form in one pass: General (connection + authentication), Records &
// Mapping (where the list is, how to page it, which path fills which asset
// field, and the per-record detail queries), Monitoring (monitor queries for
// the "genericapi" polling method — NOT the shared monitorSettingsFormHTML tab:
// the type has no class to monitor by, rule 100(b), so the integration tier is
// derived from the queries instead), Preview (the first page, mapped — POST
// /integrations/generic-api/preview) and JSON (the form as a portable file:
// view, copy, export, import — genericapi-portability.js). Which assets are
// monitored stays the operator's choice per asset.

/** The asset fields a record can map onto, in form order — mirrors GENERIC_API_FIELDS (services/genericApiService.ts). */
var _GENERIC_API_FIELDS = [
  ["id",           "Record ID",        "id",               "A value unique to each record — the source's own id"],
  ["hostname",     "Hostname",         "name",             ""],
  ["ipAddress",    "IP address",       "ip_address",       "A list is fine; the first valid address is used"],
  ["macAddress",   "MAC address(es)",  "nics[*].mac",      "Every MAC the path reaches is kept"],
  ["serialNumber", "Serial number",    "serial",           "Placeholders (“Default string”, “To Be Filled By O.E.M.”) are ignored"],
  ["manufacturer", "Manufacturer",     "vendor",           ""],
  ["model",        "Model",            "model",            ""],
  ["os",           "Operating system", "os.name",          ""],
  ["osVersion",    "OS version",       "os.version",       ""],
  ["assetType",    "Asset type",       "type",             "The source's own word — translate it below"],
  ["location",     "Location",         "site.name",        "Shown in the Location column when nothing closer to a place has one"],
  ["latitude",     "Latitude",         "geo.lat",          "Used only as a valid pair with longitude; never moves coordinates typed on the asset"],
  ["longitude",    "Longitude",        "geo.lng",          ""],
  ["assetTag",     "Asset tag",        "asset_tag",        "Unique across assets — a tag another asset already has is left off"],
  ["department",   "Department",       "owner.department", ""],
  ["assignedTo",   "Assigned to",      "owner.email",      ""],
  ["description",  "Description",      "description",      "Not written on a device another integration owns"],
  ["tags",         "Tags",             "tags[*]",          "Every value the path reaches becomes a tag"],
  ["purchaseOrder","Purchase order",   "po_number",        ""],
  ["acquiredAt",   "Acquired",         "purchase_date",    "An ISO date, or epoch seconds / milliseconds"],
  ["warrantyExpiry","Warranty expiry", "warranty.end",     ""],
];

/** The fields after Location fill blanks, and change only what the feed itself wrote. */
var _GENERIC_API_FEED_FIELD_NOTE = "Asset tag, department, assigned to, description, purchase order and the dates are filled when the asset has none, and updated only while the asset still holds the value this feed wrote — an edit by you or another integration is never overwritten.";

var _GENERIC_API_ASSET_TYPES = ["server", "workstation", "switch", "router", "firewall", "access_point", "printer", "hypervisor", "container", "other"];

// The intended value also rides on data-value, and _wireGenericApiForm
// assigns it in JS — the renderBandCond rule: a parser that mis-applies
// `selected` (happy-dom does) must not be able to save the wrong option.
function _genericSelect(id, value, options) {
  return '<select id="' + id + '" data-ga-value="' + escapeHtml(value) + '">' + options.map(function (o) {
    return '<option value="' + escapeHtml(o[0]) + '"' + (o[0] === value ? " selected" : "") + '>' + escapeHtml(o[1]) + '</option>';
  }).join("") + '</select>';
}

function genericApiGeneralHTML(defaults) {
  var d = defaults || {};
  var enabledChecked = d.enabled !== false ? "checked" : "";
  var autoChecked = d.autoDiscover !== false ? "checked" : "";
  var useHttps = d.useHttps !== false;
  var auth = d.authType || "none";
  var headerLines = (d.headers || []).map(function (h) { return h.name + ": " + h.value; }).join("\n");
  var keep = function (has, what) { return has ? "Leave blank to keep the current " + what : ""; };
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(d.name || "") + '" placeholder="e.g. Facilities CMDB"></div>' +
    infoBox('Reads devices from <strong style="color:var(--color-text-primary)">any REST API that returns JSON</strong> — a CMDB, a vendor portal, a camera or printer management server, an internal inventory — and turns each record into an asset. You describe the request here, then on <strong style="color:var(--color-text-primary)">Records &amp; Mapping</strong> say where the list is and which field is which. <strong style="color:var(--color-text-primary)">Preview</strong> shows what discovery would write before anything is saved.') +
    calloutHTML("note", "What a feed can and cannot do",
      'Polaris only <strong>reads</strong> from the API. A record is an inventory entry, not proof the device is on the network — presence is checked separately, and the assets are monitored only when you choose to monitor them. A field a first-party source (Active Directory, vCenter, an agent…) also reports is taken from that source; the feed fills the gaps.') +
    formDivider() +
    sectionHeading("Request") +
    '<div style="display:grid;grid-template-columns:1fr auto;gap:8px">' +
      '<div class="form-group"><label>Host / IP *</label><input type="text" id="f-host" value="' + escapeHtml(d.host || "") + '" placeholder="e.g. cmdb.example.com"></div>' +
      '<div class="form-group"><label>Port</label><input type="number" id="f-port" value="' + escapeHtml(d.port ? String(d.port) : "") + '" min="1" max="65535" placeholder="' + (useHttps ? "443" : "80") + '" style="width:90px"></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px">' +
      '<div class="form-group"><label>Method</label>' + _genericSelect("f-gaMethod", d.method || "GET", [["GET", "GET"], ["POST", "POST"]]) + '</div>' +
      '<div class="form-group"><label>Request path</label><input type="text" id="f-gaPath" value="' + escapeHtml(d.path || "/") + '" placeholder="/api/v2/devices?status=active"><p class="hint">Path and query string on the host above. Paging parameters are added for you.</p></div>' +
    '</div>' +
    '<div class="form-group" id="f-gaBodyWrap"' + ((d.method || "GET") === "POST" ? "" : ' style="display:none"') + '><label>Request body (JSON)</label><textarea id="f-gaBody" rows="3" placeholder="{&quot;filter&quot;: {&quot;active&quot;: true}}">' + escapeHtml(d.body || "") + '</textarea></div>' +
    checkboxRow("f-useHttps", "Use HTTPS", useHttps) +
    checkboxRow("f-verifySsl", "Verify TLS certificate", d.verifySsl !== false) +
    '<div class="form-group"><label>Extra headers</label><textarea id="f-gaHeaders" rows="2" placeholder="One per line — e.g.&#10;X-Tenant: east">' + escapeHtml(headerLines) + '</textarea><p class="hint">Stored as typed, <strong>not</strong> encrypted — put a secret in Authentication below instead.</p></div>' +
    formDivider() +
    sectionHeading("Authentication") +
    '<div class="form-group"><label>Type</label>' + _genericSelect("f-gaAuthType", auth, [
      ["none", "None"], ["bearer", "Bearer token"], ["header", "API key in a header"],
      ["query", "API key in the query string"], ["basic", "Username and password (Basic)"], ["oauth2", "OAuth 2.0 client credentials"],
    ]) + '</div>' +
    '<div data-ga-auth="bearer header query"' + (["bearer", "header", "query"].indexOf(auth) === -1 ? ' style="display:none"' : '') + '>' +
      '<div class="form-group" data-ga-auth="header"' + (auth === "header" ? "" : ' style="display:none"') + '><label>Header name</label><input type="text" id="f-gaAuthHeaderName" value="' + escapeHtml(d.authHeaderName || "X-API-Key") + '"></div>' +
      '<div class="form-group" data-ga-auth="query"' + (auth === "query" ? "" : ' style="display:none"') + '><label>Parameter name</label><input type="text" id="f-gaAuthQueryParam" value="' + escapeHtml(d.authQueryParam || "api_key") + '"><p class="hint">A key in the URL can end up in the source’s access logs — prefer a header when the API allows it.</p></div>' +
      '<div class="form-group"><label>Token / key</label><input type="password" id="f-apiToken" value="" placeholder="' + escapeHtml(keep(d.hasApiToken, "token") || "Token or API key") + '" autocomplete="new-password"><p class="hint">Stored encrypted.</p></div>' +
    '</div>' +
    '<div data-ga-auth="basic"' + (auth === "basic" ? "" : ' style="display:none"') + '>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<div class="form-group"><label>Username</label><input type="text" id="f-gaUsername" value="' + escapeHtml(d.username || "") + '" autocomplete="off"></div>' +
        '<div class="form-group"><label>Password</label><input type="password" id="f-password" value="" placeholder="' + escapeHtml(keep(d.hasPassword, "password") || "Stored encrypted") + '" autocomplete="new-password"></div>' +
      '</div>' +
    '</div>' +
    '<div data-ga-auth="oauth2"' + (auth === "oauth2" ? "" : ' style="display:none"') + '>' +
      '<div class="form-group"><label>Token URL</label><input type="text" id="f-gaTokenUrl" value="' + escapeHtml(d.tokenUrl || "") + '" placeholder="https://login.example.com/oauth2/token"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
        '<div class="form-group"><label>Client ID</label><input type="text" id="f-gaClientId" value="' + escapeHtml(d.clientId || "") + '" autocomplete="off"></div>' +
        '<div class="form-group"><label>Client secret</label><input type="password" id="f-clientSecret" value="" placeholder="' + escapeHtml(keep(d.hasClientSecret, "secret") || "Stored encrypted") + '" autocomplete="new-password"></div>' +
      '</div>' +
      '<div class="form-group"><label>Scope</label><input type="text" id="f-gaScope" value="' + escapeHtml(d.scope || "") + '" placeholder="Optional"></div>' +
    '</div>' +
    formDivider() +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-enabled" ' + enabledChecked + ' style="width:auto">' +
      '<label for="f-enabled" style="margin:0">Enabled</label>' +
    '</div>' +
    '<div class="form-group" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="f-autoDiscover" ' + autoChecked + ' style="width:auto">' +
      '<label for="f-autoDiscover" style="margin:0">Enable auto-discovery</label>' +
    '</div>' +
    '<div class="form-group"><label>Auto-Discovery Interval</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-pollInterval" value="' + (d.pollInterval || 12) + '" min="1" max="24" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">hours</span></div></div>' +
    verboseLoggingFormHTML(d);
}

function genericApiMappingHTML(defaults) {
  var d = defaults || {};
  var pg = d.pagination || {};
  var mode = pg.mode || "none";
  var fm = d.fieldMap || {};
  var identity = d.identityField || "id";
  var devMode = (d.deviceInclude && d.deviceInclude.length > 0) ? "include" : "exclude";
  var devNames = devMode === "include" ? (d.deviceInclude || []) : (d.deviceExclude || []);
  var typeMapLines = Object.keys(d.assetTypeMap || {}).map(function (k) { return k + " = " + d.assetTypeMap[k]; }).join("\n");
  var showFor = function (modes) { return modes.indexOf(mode) === -1 ? ' style="display:none"' : ""; };
  var fieldRows = _GENERIC_API_FIELDS.map(function (f) {
    return '<div class="form-group" style="margin-bottom:0.5rem">' +
      '<label for="f-gaMap-' + f[0] + '">' + escapeHtml(f[1]) + '</label>' +
      '<input type="text" id="f-gaMap-' + f[0] + '" value="' + escapeHtml(fm[f[0]] || "") + '" placeholder="e.g. ' + escapeHtml(f[2]) + '">' +
      (f[3] ? '<p class="hint">' + escapeHtml(f[3]) + '</p>' : '') +
    '</div>';
  }).join("");
  return infoBox('Paths are written against <strong style="color:var(--color-text-primary)">one record</strong>: <code>name</code>, <code>os.version</code>, <code>nics[0].mac</code>, <code>nics[*].mac</code> (every NIC), <code>[\'serial number\']</code> (a key with a space). The <strong style="color:var(--color-text-primary)">Preview</strong> tab shows a real record to copy them from.') +
    checkboxRow("f-gaReadDevices", "Read devices (assets) from this API", d.readDevices !== false) +
    '<p class="hint">Turn off for an API that only holds address space — an external IPAM read on the Network tab. The request on General, the records and the mapping below are then not used.</p>' +
    sectionHeading("Records") +
    '<div class="form-group"><label>Records path</label><input type="text" id="f-gaRecordsPath" value="' + escapeHtml(d.recordsPath || "") + '" placeholder="e.g. data.devices — blank when the response IS the list"><p class="hint">Where the list of devices sits in each response.</p></div>' +
    '<div class="form-group"><label>Pagination</label>' + _genericSelect("f-gaPageMode", mode, [
      ["none", "None — one request returns everything"],
      ["page", "Page number (?page=1, 2, 3…)"],
      ["offset", "Offset (?offset=0, 100, 200…)"],
      ["cursor", "Cursor / next token in the response"],
      ["link", "Link header (rel=\"next\")"],
    ]) + '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<div class="form-group" data-ga-page="page offset"' + showFor(["page", "offset"]) + '><label>Page / offset parameter</label><input type="text" id="f-gaPageParam" value="' + escapeHtml(pg.pageParam || "") + '" placeholder="page or offset"></div>' +
      '<div class="form-group" data-ga-page="page"' + showFor(["page"]) + '><label>First page</label>' + _genericSelect("f-gaStartPage", String(pg.startPage != null ? pg.startPage : 1), [["1", "1"], ["0", "0"]]) + '</div>' +
      '<div class="form-group" data-ga-page="page offset"' + showFor(["page", "offset"]) + '><label>Page-size parameter</label><input type="text" id="f-gaSizeParam" value="' + escapeHtml(pg.sizeParam || "") + '" placeholder="e.g. per_page — optional"></div>' +
      '<div class="form-group" data-ga-page="page offset"' + showFor(["page", "offset"]) + '><label>Page size</label><input type="number" id="f-gaPageSize" value="' + (pg.pageSize || 100) + '" min="1" max="10000"></div>' +
      '<div class="form-group" data-ga-page="cursor"' + showFor(["cursor"]) + '><label>Next-cursor path</label><input type="text" id="f-gaCursorPath" value="' + escapeHtml(pg.cursorPath || "") + '" placeholder="e.g. meta.next_cursor or links.next"></div>' +
      '<div class="form-group" data-ga-page="cursor"' + showFor(["cursor"]) + '><label>Cursor parameter</label><input type="text" id="f-gaCursorParam" value="' + escapeHtml(pg.cursorParam || "") + '" placeholder="cursor"><p class="hint">Not used when the cursor is a full URL.</p></div>' +
      '<div class="form-group" data-ga-page="page offset cursor link"' + showFor(["page", "offset", "cursor", "link"]) + '><label>Max pages</label><input type="number" id="f-gaMaxPages" value="' + (pg.maxPages || 100) + '" min="1" max="1000"></div>' +
    '</div>' +
    '<p class="hint" data-ga-page="page offset"' + showFor(["page", "offset"]) + '>Without a page-size parameter Polaris keeps asking until a page comes back empty.</p>' +
    formDivider() +
    sectionHeading("Field mapping") +
    '<div class="form-group"><label>Identity — what keeps one record on one asset *</label>' + _genericSelect("f-gaIdentity", identity, [
      ["id", "Record ID"], ["serialNumber", "Serial number"], ["macAddress", "MAC address"], ["hostname", "Hostname"],
    ]) + '<p class="hint">Must be mapped below and stable between runs. A hostname is the weakest choice — it changes and repeats.</p></div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 12px">' + fieldRows + '</div>' +
    '<p class="hint">' + escapeHtml(_GENERIC_API_FEED_FIELD_NOTE) + '</p>' +
    formDivider() +
    sectionHeading("Detail queries") +
    '<p class="hint">A second request made <strong>once per record</strong>, for an API that lists devices briefly and keeps the detail (hardware, owner, warranty…) behind a per-device URL. Write <code>{{path}}</code> where a value from the record goes — <code>/api/devices/{{id}}/hardware</code> — and map fields against the detail response. A field mapped here wins over the same field above when it has a value. The record ID always comes from the list above.</p>' +
    '<div id="f-gaDetails">' + (d.detailQueries || []).map(_gaDetailQueryHTML).join("") + '</div>' +
    '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">' +
      '<button type="button" class="btn btn-secondary btn-sm" id="f-gaDetailAdd">Add detail query</button>' +
      '<label for="f-gaDetailConcurrency" style="margin:0;font-size:0.85rem;color:var(--color-text-secondary)">Requests at once</label>' +
      '<input type="number" id="f-gaDetailConcurrency" value="' + (d.detailConcurrency || 4) + '" min="1" max="16" style="width:70px">' +
    '</div>' +
    '<p class="hint">Each detail query costs one request per record per discovery run (at most 20,000 a run). A failed detail request costs that record only the fields it would have filled.</p>' +
    formDivider() +
    sectionHeading("Asset type & manufacturer") +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<div class="form-group"><label>Default asset type</label>' + _genericSelect("f-gaTypeDefault", d.assetTypeDefault || "other",
        _GENERIC_API_ASSET_TYPES.map(function (t) { return [t, t.replace("_", " ")]; })) + '<p class="hint">For a record with no type, or one Polaris does not know.</p></div>' +
      '<div class="form-group"><label>Default manufacturer</label><input type="text" id="f-gaManufacturer" value="' + escapeHtml(d.manufacturerDefault || "") + '" placeholder="e.g. Axis — optional"></div>' +
    '</div>' +
    '<div class="form-group"><label>Translate asset types</label><textarea id="f-gaTypeMap" rows="3" placeholder="One per line: source word = Polaris type&#10;Network Camera = other&#10;Core Switch = switch">' + escapeHtml(typeMapLines) + '</textarea><p class="hint">Matched without regard to case. A word not listed is used as-is when Polaris knows it (<code>server</code>, <code>printer</code>…), otherwise the default applies.</p></div>' +
    formDivider() +
    sectionHeading("Filters") +
    '<div class="form-group">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<select id="f-deviceMode" style="width:auto"><option value="include"' + (devMode === "include" ? " selected" : "") + '>Include</option><option value="exclude"' + (devMode === "exclude" ? " selected" : "") + '>Exclude</option></select>' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">these devices (matched against the mapped hostname)</span>' +
      '</div>' +
      '<textarea id="f-deviceNames" rows="3" placeholder="One per line — e.g.&#10;cam-*">' + escapeHtml(devNames.join("\n")) + '</textarea>' +
    '</div>' +
    formDivider() +
    sectionHeading("Lifecycle & limits") +
    checkboxRow("f-gaDecommission", "Decommission an asset when its record leaves the feed", d.decommissionMissing === true) +
    '<p class="hint">Only after a complete read, never when most records vanish at once, and never an asset another integration also owns. Off: the asset stays and simply stops updating.</p>' +
    checkboxRow("f-verifyPresence", "Verify network presence after each discovery", d.verifyPresence !== false) +
    '<p class="hint">A record is not proof a device is on the network; this checks (agent, monitor probe, then a ping) and sets Last Seen only on an answer.</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
      '<div class="form-group"><label>Max records</label><input type="number" id="f-gaMaxRecords" value="' + (d.maxRecords || 10000) + '" min="1" max="50000"></div>' +
      '<div class="form-group"><label>Request timeout</label><div style="display:flex;align-items:center;gap:8px"><input type="number" id="f-gaTimeoutSec" value="' + Math.round((d.requestTimeoutMs || 30000) / 1000) + '" min="1" max="120" style="width:80px"><span style="color:var(--color-text-tertiary);font-size:0.85rem">seconds</span></div></div>' +
    '</div>';
}

function genericApiPreviewHTML() {
  return '<p class="hint">Reads the <strong>first page</strong> with the settings on the other tabs — saved or not — and shows the first record as the API sent it, then the first rows as discovery would write them. Nothing is stored.</p>' +
    '<div style="display:flex;gap:8px;align-items:center;margin:0.75rem 0">' +
      '<button type="button" class="btn btn-secondary btn-sm" id="f-gaPreviewBtn">Run preview</button>' +
      '<span id="f-gaPreviewStatus" class="hint" style="margin:0"></span>' +
    '</div>' +
    '<div id="f-gaPreviewResult"></div>';
}

/** The fields a detail query may map — every field but the record ID (GENERIC_API_DETAIL_FIELDS). */
var _GENERIC_API_DETAIL_FIELDS = _GENERIC_API_FIELDS.map(function (f) { return f[0]; }).filter(function (k) { return k !== "id"; });

/**
 * One detail query's editor. Repeated blocks, so nothing in it carries an id —
 * _gaReadDetailQueries walks [data-ga-detail] instead. The field map is a
 * "field = path" textarea rather than twenty inputs per query.
 */
function _gaDetailQueryHTML(q) {
  q = q || {};
  var method = q.method === "POST" ? "POST" : "GET";
  var fm = q.fieldMap || {};
  var mapLines = Object.keys(fm).filter(function (k) { return fm[k]; }).map(function (k) { return k + " = " + fm[k]; }).join("\n");
  return '<div data-ga-detail style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:0.6rem">' +
    '<div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end">' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Name</label><input type="text" class="ga-detail-name" value="' + escapeHtml(q.name || "") + '" placeholder="e.g. Hardware"></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Method</label><select class="ga-detail-method" data-ga-value="' + method + '"><option value="GET"' + (method === "GET" ? " selected" : "") + '>GET</option><option value="POST"' + (method === "POST" ? " selected" : "") + '>POST</option></select></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><button type="button" class="btn btn-secondary btn-sm ga-detail-remove" title="Remove this detail query">Remove</button></div>' +
    '</div>' +
    '<div class="form-group" style="margin-bottom:0.5rem"><label>Path</label><input type="text" class="ga-detail-path" value="' + escapeHtml(q.path || "") + '" placeholder="/api/devices/{{id}}/hardware"></div>' +
    '<div class="form-group ga-detail-body-wrap" style="margin-bottom:0.5rem' + (method === "POST" ? "" : ";display:none") + '"><label>Request body (JSON)</label><textarea class="ga-detail-body" rows="2" placeholder="{&quot;deviceId&quot;: &quot;{{id}}&quot;}">' + escapeHtml(q.body || "") + '</textarea></div>' +
    '<div class="form-group" style="margin-bottom:0"><label>Fields from this response</label><textarea class="ga-detail-map" rows="3" placeholder="One per line: field = path&#10;serialNumber = hardware.serial&#10;warrantyExpiry = warranty.ends">' + escapeHtml(mapLines) + '</textarea>' +
      '<p class="hint ga-detail-map-hint">Fields: ' + escapeHtml(_GENERIC_API_DETAIL_FIELDS.join(", ")) + '</p></div>' +
  '</div>';
}

/** "field = path" lines → { fieldMap, unknown[] }. */
function _gaParseDetailMap(text) {
  var fieldMap = {};
  var unknown = [];
  String(text || "").split(/\r?\n/).forEach(function (line) {
    var s = line.trim();
    if (!s) return;
    var i = s.indexOf("=");
    var key = i > 0 ? s.slice(0, i).trim() : s;
    var path = i > 0 ? s.slice(i + 1).trim() : "";
    if (_GENERIC_API_DETAIL_FIELDS.indexOf(key) === -1 || !path) { unknown.push(s); return; }
    fieldMap[key] = path;
  });
  return { fieldMap: fieldMap, unknown: unknown };
}

function _gaReadDetailQueries() {
  var out = [];
  document.querySelectorAll("[data-ga-detail]").forEach(function (block) {
    var q = function (sel) { var el = block.querySelector(sel); return el ? String(el.value || "").trim() : ""; };
    var path = q(".ga-detail-path");
    var map = _gaParseDetailMap(q(".ga-detail-map")).fieldMap;
    if (!path && Object.keys(map).length === 0 && !q(".ga-detail-name")) return;   // an untouched blank block
    out.push({ name: q(".ga-detail-name"), method: q(".ga-detail-method") || "GET", path: path, body: q(".ga-detail-body"), fieldMap: map });
  });
  return out;
}

/** The unknown-field hint under a detail block's map, refreshed as the operator types. */
function _gaCheckDetailMap(block) {
  var hint = block.querySelector(".ga-detail-map-hint");
  var ta = block.querySelector(".ga-detail-map");
  if (!hint || !ta) return;
  var unknown = _gaParseDetailMap(ta.value).unknown;
  if (unknown.length) {
    hint.innerHTML = '<span style="color:var(--color-warning)">Not read: ' + escapeHtml(unknown.join(" · ")) + '</span> — each line is <code>field = path</code>, with a field from: ' + escapeHtml(_GENERIC_API_DETAIL_FIELDS.join(", "));
  } else {
    hint.textContent = "Fields: " + _GENERIC_API_DETAIL_FIELDS.join(", ");
  }
}

// ─── Generic API monitor queries (rule 100(i)) ─────────────────────────────────
//
// The Monitoring tab: requests that feed the monitor streams and custom widgets
// through the "genericapi" polling method (services/genericApiMonitorService.ts).
// Repeated blocks with no ids, like the detail queries — _gaReadMonitorQueries
// walks [data-ga-monitor], and one delegated listener set on #f-gaMonitors
// serves blocks added later or rebuilt by a JSON import.

/** Stream → [label, the map keys it takes (mirrors GENERIC_API_MONITOR_FIELDS), a list stream?]. */
var _GA_MONITOR_STREAMS = {
  responseTime: ["Response time (up / down)", ["up", "latencyMs", "uptimeSec"], false],
  cpuMemory:    ["CPU / memory",              ["cpuPct", "memPct", "memUsed", "memTotal", "memFree"], false],
  interfaces:   ["Interfaces",                ["name", "operStatus", "adminStatus", "speedBps", "speedMbps", "inOctets", "outOctets", "inErrors", "outErrors", "macAddress", "ipAddress", "ipv6Address", "description", "alias"], true],
  storage:      ["Storage",                   ["mountPath", "total", "used", "free"], true],
  temperature:  ["Temperature",               ["name", "celsius"], true],
  lldp:         ["LLDP neighbors",            ["localIfName", "chassisId", "portId", "portDescription", "systemName", "systemDescription", "managementIp"], true],
  widgets:      ["Custom widgets",            [], false],
};
var _GA_MONITOR_STREAM_ORDER = ["responseTime", "cpuMemory", "interfaces", "storage", "temperature", "lldp", "widgets"];

/** A placeholder map per stream — what a typical feed looks like. */
var _GA_MONITOR_MAP_EXAMPLES = {
  responseTime: "up = status\nlatencyMs = latency_ms",
  cpuMemory:    "cpuPct = cpu.percent\nmemUsed = memory.used\nmemTotal = memory.total",
  interfaces:   "name = name\noperStatus = link\ninOctets = rx_bytes\noutOctets = tx_bytes\nspeedMbps = speed",
  storage:      "mountPath = name\ntotal = size\nused = used",
  temperature:  "name = sensor\ncelsius = value",
  lldp:         "localIfName = local_port\nsystemName = neighbor.name\nportId = neighbor.port\nchassisId = neighbor.chassis",
  widgets:      "",
};

var _GA_WIDGET_FORMAT_HINT = 'gauge / line: <code>name | type | path | unit | min | max | warn at | above or below | critical at</code> (the last six optional; a level is reached at or above its value unless the side column says below, and a &quot;Custom widget level&quot; automation alerts on warning and critical). state: <code>name | state | path | values that mean OK</code> — anything else shows as an alarm.';

function _gaMonitorQueryHTML(q) {
  q = q || {};
  var stream = _GA_MONITOR_STREAMS[q.stream] ? q.stream : "responseTime";
  var scope = q.scope === "asset" ? "asset" : "fleet";
  var method = q.method === "POST" ? "POST" : "GET";
  var unit = q.byteUnit || "B";
  var map = q.map || {};
  var mapLines = Object.keys(map).filter(function (k) { return map[k]; }).map(function (k) { return k + " = " + map[k]; }).join("\n");
  var opt = function (v, label, cur) { return '<option value="' + v + '"' + (v === cur ? " selected" : "") + '>' + escapeHtml(label) + '</option>'; };
  return '<div data-ga-monitor style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:0.6rem">' +
    '<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:end">' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Name</label><input type="text" class="ga-mon-name" value="' + escapeHtml(q.name || "") + '" placeholder="e.g. Device status"></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Feeds</label><select class="ga-mon-stream" data-ga-value="' + stream + '">' +
        _GA_MONITOR_STREAM_ORDER.map(function (k) { return opt(k, _GA_MONITOR_STREAMS[k][0], stream); }).join("") + '</select></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Request</label><select class="ga-mon-scope" data-ga-value="' + scope + '">' +
        opt("fleet", "One for every asset", scope) + opt("asset", "One per asset", scope) + '</select></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><button type="button" class="btn btn-secondary btn-sm ga-mon-remove" title="Remove this monitor query">Remove</button></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px">' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Method</label><select class="ga-mon-method" data-ga-value="' + method + '">' + opt("GET", "GET", method) + opt("POST", "POST", method) + '</select></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Path</label><input type="text" class="ga-mon-path" value="' + escapeHtml(q.path || "") + '" placeholder="' + (scope === "asset" ? "/api/devices/{{identity}}/metrics" : "/api/metrics") + '"></div>' +
    '</div>' +
    '<div class="form-group ga-mon-body-wrap" style="margin-bottom:0.5rem' + (method === "POST" ? "" : ";display:none") + '"><label>Request body (JSON)</label><textarea class="ga-mon-body" rows="2">' + escapeHtml(q.body || "") + '</textarea></div>' +
    '<p class="hint ga-mon-asset-hint" style="margin-top:0' + (scope === "asset" ? "" : ";display:none") + '">Placeholders come from the asset’s record as discovery last mapped it: <code>{{identity}}</code>, <code>{{hostname}}</code>, <code>{{ip}}</code>, <code>{{serial}}</code>, <code>{{mac}}</code>. One request per asset per poll.</p>' +
    '<div class="ga-mon-fleet" style="display:' + (scope === "fleet" ? "grid" : "none") + ';grid-template-columns:1fr 1fr;gap:8px">' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Records path</label><input type="text" class="ga-mon-records" value="' + escapeHtml(q.recordsPath || "") + '" placeholder="e.g. data — blank when the response is the list"></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Identity path *</label><input type="text" class="ga-mon-match" value="' + escapeHtml(q.matchPath || "") + '" placeholder="e.g. device_id"><p class="hint">The value that matches the record’s identity on the Records &amp; Mapping tab.</p></div>' +
    '</div>' +
    '<div class="ga-mon-fleet-page" style="display:' + (scope === "fleet" ? "block" : "none") + '">' + _gaCheckbox("ga-mon-paginate", "Page through it like the inventory request", q.paginate === true) + '</div>' +
    '<div class="form-group ga-mon-items-wrap" style="margin-bottom:0.5rem' + (_GA_MONITOR_STREAMS[stream][2] ? "" : ";display:none") + '"><label>Rows path</label><input type="text" class="ga-mon-items" value="' + escapeHtml(q.itemsPath || "") + '" placeholder="e.g. interfaces — blank when the asset’s document is the list"></div>' +
    '<div class="form-group ga-mon-map-wrap" style="margin-bottom:0.5rem' + (stream === "widgets" ? ";display:none" : "") + '"><label>Fields</label><textarea class="ga-mon-map" rows="3" placeholder="' + escapeHtml("One per line: field = path\n" + _GA_MONITOR_MAP_EXAMPLES[stream]) + '">' + escapeHtml(mapLines) + '</textarea>' +
      '<p class="hint ga-mon-map-hint"></p></div>' +
    '<div class="form-group ga-mon-up-wrap" style="margin-bottom:0.5rem' + (stream === "responseTime" ? "" : ";display:none") + '"><label>Values that mean up</label><input type="text" class="ga-mon-up" value="' + escapeHtml((q.upValues || []).join(", ")) + '" placeholder="Blank: true, up, online, ok, running, 1, yes, active, healthy, connected, available"></div>' +
    '<div class="form-group ga-mon-unit-wrap" style="margin-bottom:0.5rem' + (stream === "cpuMemory" || stream === "storage" ? "" : ";display:none") + '"><label>Sizes are in</label><select class="ga-mon-unit" data-ga-value="' + escapeHtml(unit) + '">' +
      ["B", "KB", "MB", "GB", "TB"].map(function (u) { return opt(u, u === "B" ? "bytes" : u + " (1024-based)", unit); }).join("") + '</select></div>' +
    '<div class="form-group ga-mon-widgets-wrap" style="margin-bottom:0.5rem' + (stream === "widgets" ? "" : ";display:none") + '"><label>Widgets</label><textarea class="ga-mon-widgets" rows="3" placeholder="One per line: name | gauge, line or state | path | …&#10;Battery | gauge | battery.pct | % | 0 | 100 | 20 | below&#10;Toner | line | supplies.toner&#10;Door | state | door.status | closed, locked">' + escapeHtml(_gaFormatWidgetLines(q.widgets || [])) + '</textarea>' +
      '<p class="hint ga-mon-widgets-hint">' + _GA_WIDGET_FORMAT_HINT + '</p></div>' +
    '<div class="ga-mon-default-wrap"' + (stream === "widgets" ? ' style="display:none"' : "") + '>' + _gaCheckbox("ga-mon-default", "Use for this feed’s assets — the integration’s default polling method for this stream", q.useByDefault !== false) + '</div>' +
  '</div>';
}

/** A checkbox inside a repeated block — a class, never an id. */
function _gaCheckbox(cls, label, checked) {
  return '<label style="display:flex;align-items:center;gap:8px;font-size:0.85rem;margin:0 0 0.5rem 0;cursor:pointer"><input type="checkbox" class="' + cls + '" style="width:auto"' + (checked ? " checked" : "") + '>' + escapeHtml(label) + '</label>';
}

/** Widgets → "name | type | path | …" lines (the inverse of _gaParseWidgetLines). */
function _gaFormatWidgetLines(widgets) {
  return (widgets || []).map(function (w) {
    if (w.type === "state") {
      var ok = (w.stateMap && w.stateMap.mode === "notEquals" && Array.isArray(w.stateMap.values)) ? w.stateMap.values : [];
      return [w.name, "state", w.path].concat(ok.length ? [ok.join(", ")] : []).join(" | ");
    }
    var hasLevel = w.warningAt != null || w.criticalAt != null;
    var cols = [w.name, w.type, w.path, w.unit || "", w.min != null ? String(w.min) : "", w.max != null ? String(w.max) : "", w.warningAt != null ? String(w.warningAt) : "", hasLevel && w.warningWhen === "below" ? "below" : "", w.criticalAt != null ? String(w.criticalAt) : ""];
    while (cols.length > 3 && cols[cols.length - 1] === "") cols.pop();
    return cols.join(" | ");
  }).join("\n");
}

/**
 * "name | type | path | …" lines → { widgets, bad[] }. A state widget's OK
 * values become a notEquals StateMap (utils/stateProbes.ts): any other value is
 * the alarm side. With no OK values the state is the plain "non-zero is an
 * alarm" reading.
 */
function _gaParseWidgetLines(text) {
  var widgets = [];
  var bad = [];
  String(text || "").split(/\r?\n/).forEach(function (line) {
    var s = line.trim();
    if (!s) return;
    var c = s.split("|").map(function (x) { return x.trim(); });
    var type = (c[1] || "").toLowerCase();
    if (!c[0] || !c[2] || ["gauge", "line", "state"].indexOf(type) === -1) { bad.push(s); return; }
    var w = { name: c[0], type: type, path: c[2] };
    if (type === "state") {
      var ok = (c[3] || "").split(",").map(function (x) { return x.trim(); }).filter(Boolean);
      w.stateMap = ok.length
        ? { mode: "notEquals", values: ok, trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true }
        : { mode: "nonzero", values: [], trueLabel: "Alarm", falseLabel: "OK", trueIsProblem: true };
    } else {
      var num = function (v) { if (v === undefined || v === "") return undefined; var n = Number(v); return isFinite(n) ? n : NaN; };
      if (c[3]) w.unit = c[3];
      var mn = num(c[4]), mx = num(c[5]), wa = num(c[6]), ca = num(c[8]);
      if ([mn, mx, wa, ca].some(function (n) { return n !== undefined && isNaN(n); })) { bad.push(s); return; }
      if (mn !== undefined) w.min = mn;
      if (mx !== undefined) w.max = mx;
      if (wa !== undefined) w.warningAt = wa;
      // The critical level (business rule 181) — its own column after the side,
      // so a line written before it existed still parses the same.
      if (ca !== undefined) w.criticalAt = ca;
      // Which side of the levels is the problem: "above" (the default) or "below".
      var when = (c[7] || "").toLowerCase();
      if (when && when !== "above" && when !== "below") { bad.push(s); return; }
      if (when === "below" && (wa !== undefined || ca !== undefined)) w.warningWhen = "below";
      // Critical must lie beyond warning on the problem side, or a card would
      // read critical before warning.
      if (wa !== undefined && ca !== undefined && (w.warningWhen === "below" ? ca > wa : ca < wa)) { bad.push(s); return; }
    }
    widgets.push(w);
  });
  return { widgets: widgets, bad: bad };
}

/** "field = path" lines for one stream → { map, unknown[] }. */
function _gaParseMonitorMap(stream, text) {
  var keys = (_GA_MONITOR_STREAMS[stream] || _GA_MONITOR_STREAMS.widgets)[1];
  var map = {};
  var unknown = [];
  String(text || "").split(/\r?\n/).forEach(function (line) {
    var s = line.trim();
    if (!s) return;
    var i = s.indexOf("=");
    var key = i > 0 ? s.slice(0, i).trim() : s;
    var path = i > 0 ? s.slice(i + 1).trim() : "";
    if (keys.indexOf(key) === -1 || !path) { unknown.push(s); return; }
    map[key] = path;
  });
  return { map: map, unknown: unknown };
}

function _gaReadMonitorQueries() {
  var out = [];
  document.querySelectorAll("[data-ga-monitor]").forEach(function (block) {
    var v = function (sel) { var el = block.querySelector(sel); return el ? String(el.value || "").trim() : ""; };
    var on = function (sel) { var el = block.querySelector(sel); return !!(el && el.checked); };
    var stream = v(".ga-mon-stream") || "responseTime";
    var path = v(".ga-mon-path");
    var mapText = v(".ga-mon-map");
    var widgetText = v(".ga-mon-widgets");
    if (!path && !v(".ga-mon-name") && !mapText && !widgetText) return;   // an untouched blank block
    out.push({
      name: v(".ga-mon-name"),
      stream: stream,
      scope: v(".ga-mon-scope") === "asset" ? "asset" : "fleet",
      method: v(".ga-mon-method") || "GET",
      path: path,
      body: v(".ga-mon-body"),
      recordsPath: v(".ga-mon-records"),
      matchPath: v(".ga-mon-match"),
      paginate: on(".ga-mon-paginate"),
      itemsPath: v(".ga-mon-items"),
      map: stream === "widgets" ? {} : _gaParseMonitorMap(stream, mapText).map,
      upValues: v(".ga-mon-up").split(",").map(function (x) { return x.trim(); }).filter(Boolean),
      byteUnit: v(".ga-mon-unit") || "B",
      widgets: stream === "widgets" ? _gaParseWidgetLines(widgetText).widgets : [],
      useByDefault: on(".ga-mon-default"),
    });
  });
  return out;
}

/** Show the fields a block's stream / scope / method uses, and name the lines it cannot read. */
function _gaSyncMonitorBlock(block) {
  var v = function (sel) { var el = block.querySelector(sel); return el ? el.value : ""; };
  var show = function (sel, on, how) { var el = block.querySelector(sel); if (el) el.style.display = on ? (how || "") : "none"; };
  var stream = v(".ga-mon-stream") || "responseTime";
  var spec = _GA_MONITOR_STREAMS[stream] || _GA_MONITOR_STREAMS.responseTime;
  var fleet = v(".ga-mon-scope") !== "asset";
  show(".ga-mon-body-wrap", v(".ga-mon-method") === "POST");
  show(".ga-mon-fleet", fleet, "grid");
  show(".ga-mon-fleet-page", fleet, "block");
  show(".ga-mon-asset-hint", !fleet);
  show(".ga-mon-items-wrap", spec[2]);
  show(".ga-mon-map-wrap", stream !== "widgets");
  show(".ga-mon-up-wrap", stream === "responseTime");
  show(".ga-mon-unit-wrap", stream === "cpuMemory" || stream === "storage");
  show(".ga-mon-widgets-wrap", stream === "widgets");
  show(".ga-mon-default-wrap", stream !== "widgets");
  var mapTa = block.querySelector(".ga-mon-map");
  if (mapTa) mapTa.placeholder = "One per line: field = path\n" + (_GA_MONITOR_MAP_EXAMPLES[stream] || "");
  var pathEl = block.querySelector(".ga-mon-path");
  if (pathEl) pathEl.placeholder = fleet ? "/api/metrics" : "/api/devices/{{identity}}/metrics";
  var hint = block.querySelector(".ga-mon-map-hint");
  if (hint && mapTa) {
    var unknown = _gaParseMonitorMap(stream, mapTa.value).unknown;
    var fields = spec[1].join(", ");
    hint.innerHTML = unknown.length
      ? '<span style="color:var(--color-warning)">Not read: ' + escapeHtml(unknown.join(" · ")) + '</span> — each line is <code>field = path</code>, with a field from: ' + escapeHtml(fields)
      : "Fields: " + escapeHtml(fields) + (spec[2] ? " — read from each row." : ".");
  }
  var wHint = block.querySelector(".ga-mon-widgets-hint");
  var wTa = block.querySelector(".ga-mon-widgets");
  if (wHint && wTa) {
    var badW = _gaParseWidgetLines(wTa.value).bad;
    wHint.innerHTML = (badW.length ? '<span style="color:var(--color-warning)">Not read: ' + escapeHtml(badW.join(" · ")) + '</span> — ' : "") + _GA_WIDGET_FORMAT_HINT;
  }
}

function genericApiMonitoringHTML(defaults) {
  var d = defaults || {};
  return infoBox('Feed Polaris’s <strong style="color:var(--color-text-primary)">monitoring</strong> from this API: up / down, CPU and memory, interfaces, storage, temperatures, LLDP neighbors, and custom widgets on the asset page. Each query reads values for the assets this integration discovered, through the <strong style="color:var(--color-text-primary)">Generic API</strong> polling method.') +
    calloutHTML("note", "What a query decides",
      'A query never turns monitoring on: you still choose which assets are monitored. With <em>Use for this feed’s assets</em> ticked, the stream’s default polling method for this integration’s assets becomes Generic API; you can still pick another method per asset. If the API cannot be reached, a response-time probe is skipped rather than marking every asset down; an asset the API answers for without listing it is down.') +
    '<div id="f-gaMonitors">' + (d.monitorQueries || []).map(_gaMonitorQueryHTML).join("") + '</div>' +
    '<button type="button" class="btn btn-secondary btn-sm" id="f-gaMonitorAdd">Add monitor query</button>' +
    '<p class="hint" style="margin-top:0.75rem"><strong>One for every asset</strong> costs one request per poll for the whole fleet (cached for 30 seconds and shared by every asset and stream on it) — use it whenever the API can list everything at once. <strong>One per asset</strong> costs one request per asset per poll, at most the Records &amp; Mapping tab’s <em>Requests at once</em> in flight. Temperatures and custom widgets are read on the CPU / memory schedule, so they need a CPU / memory method on the asset.</p>';
}

// ─── Generic API network queries (rule 100(j)) ─────────────────────────────────
//
// The Network tab: address space read into IPAM — subnets, DHCP leases, DHCP
// reservations, and addresses allocated in another IPAM. Repeated blocks with
// no ids, the monitor-query shape: _gaReadNetworkQueries walks
// [data-ga-network], one delegated listener set on #f-gaNetworks.

/** Kind → [label, the map keys it takes (mirrors GENERIC_API_NETWORK_FIELDS), a placeholder map]. */
var _GA_NETWORK_KINDS = {
  subnets:      ["Subnets",           ["cidr", "network", "prefixLength", "netmask", "name", "vlan", "purpose"], "cidr = prefix\nname = description\nvlan = vlan.id"],
  leases:       ["DHCP leases",       ["ipAddress", "macAddress", "hostname", "expiresAt"], "ipAddress = ip\nmacAddress = mac\nhostname = client_name\nexpiresAt = ends"],
  reservations: ["DHCP reservations", ["ipAddress", "macAddress", "hostname"], "ipAddress = ip\nmacAddress = mac\nhostname = name"],
  assignments:  ["IP assignments",    ["ipAddress", "hostname", "macAddress", "owner", "notes"], "ipAddress = address\nhostname = dns_name\nowner = tenant.name\nnotes = description"],
};
var _GA_NETWORK_KIND_ORDER = ["subnets", "leases", "reservations", "assignments"];

function _gaNetworkQueryHTML(q) {
  q = q || {};
  var kind = _GA_NETWORK_KINDS[q.kind] ? q.kind : "subnets";
  var method = q.method === "POST" ? "POST" : "GET";
  var map = q.map || {};
  var mapLines = Object.keys(map).filter(function (k) { return map[k]; }).map(function (k) { return k + " = " + map[k]; }).join("\n");
  var opt = function (v, label, cur) { return '<option value="' + v + '"' + (v === cur ? " selected" : "") + '>' + escapeHtml(label) + '</option>'; };
  return '<div data-ga-network style="border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.6rem 0.75rem;margin-bottom:0.6rem">' +
    '<div style="display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:end">' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Name</label><input type="text" class="ga-net-name" value="' + escapeHtml(q.name || "") + '" placeholder="e.g. Prefixes"></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Reads</label><select class="ga-net-kind" data-ga-value="' + kind + '">' +
        _GA_NETWORK_KIND_ORDER.map(function (k) { return opt(k, _GA_NETWORK_KINDS[k][0], kind); }).join("") + '</select></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><button type="button" class="btn btn-secondary btn-sm ga-net-remove" title="Remove this network query">Remove</button></div>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px">' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Method</label><select class="ga-net-method" data-ga-value="' + method + '">' + opt("GET", "GET", method) + opt("POST", "POST", method) + '</select></div>' +
      '<div class="form-group" style="margin-bottom:0.5rem"><label>Path</label><input type="text" class="ga-net-path" value="' + escapeHtml(q.path || "") + '" placeholder="/api/ipam/prefixes"></div>' +
    '</div>' +
    '<div class="form-group ga-net-body-wrap" style="margin-bottom:0.5rem' + (method === "POST" ? "" : ";display:none") + '"><label>Request body (JSON)</label><textarea class="ga-net-body" rows="2">' + escapeHtml(q.body || "") + '</textarea></div>' +
    '<div class="form-group" style="margin-bottom:0.5rem"><label>Records path</label><input type="text" class="ga-net-records" value="' + escapeHtml(q.recordsPath || "") + '" placeholder="e.g. results — blank when the response is the list"></div>' +
    _gaCheckbox("ga-net-paginate", "Page through it like the inventory request", q.paginate === true) +
    '<div class="form-group" style="margin-bottom:0"><label>Fields</label><textarea class="ga-net-map" rows="3" placeholder="' + escapeHtml("One per line: field = path\n" + _GA_NETWORK_KINDS[kind][2]) + '">' + escapeHtml(mapLines) + '</textarea>' +
      '<p class="hint ga-net-map-hint"></p></div>' +
  '</div>';
}

/** "field = path" lines for one kind → { map, unknown[] }. */
function _gaParseNetworkMap(kind, text) {
  var keys = (_GA_NETWORK_KINDS[kind] || _GA_NETWORK_KINDS.subnets)[1];
  var map = {};
  var unknown = [];
  String(text || "").split(/\r?\n/).forEach(function (line) {
    var s = line.trim();
    if (!s) return;
    var i = s.indexOf("=");
    var key = i > 0 ? s.slice(0, i).trim() : s;
    var path = i > 0 ? s.slice(i + 1).trim() : "";
    if (keys.indexOf(key) === -1 || !path) { unknown.push(s); return; }
    map[key] = path;
  });
  return { map: map, unknown: unknown };
}

function _gaReadNetworkQueries() {
  var out = [];
  document.querySelectorAll("[data-ga-network]").forEach(function (block) {
    var v = function (sel) { var el = block.querySelector(sel); return el ? String(el.value || "").trim() : ""; };
    var kind = v(".ga-net-kind") || "subnets";
    var path = v(".ga-net-path");
    var mapText = v(".ga-net-map");
    if (!path && !v(".ga-net-name") && !mapText) return;   // an untouched blank block
    var pg = block.querySelector(".ga-net-paginate");
    out.push({
      name: v(".ga-net-name"),
      kind: kind,
      method: v(".ga-net-method") || "GET",
      path: path,
      body: v(".ga-net-body"),
      recordsPath: v(".ga-net-records"),
      paginate: !!(pg && pg.checked),
      map: _gaParseNetworkMap(kind, mapText).map,
    });
  });
  return out;
}

function _gaSyncNetworkBlock(block) {
  var kindEl = block.querySelector(".ga-net-kind");
  var kind = (kindEl && kindEl.value) || "subnets";
  var spec = _GA_NETWORK_KINDS[kind] || _GA_NETWORK_KINDS.subnets;
  var methodEl = block.querySelector(".ga-net-method");
  var bodyWrap = block.querySelector(".ga-net-body-wrap");
  if (bodyWrap) bodyWrap.style.display = methodEl && methodEl.value === "POST" ? "" : "none";
  var ta = block.querySelector(".ga-net-map");
  if (ta) ta.placeholder = "One per line: field = path\n" + spec[2];
  var hint = block.querySelector(".ga-net-map-hint");
  if (hint && ta) {
    var unknown = _gaParseNetworkMap(kind, ta.value).unknown;
    var fields = spec[1].join(", ");
    var req = kind === "subnets" ? " Map <code>cidr</code>, or <code>network</code> with <code>prefixLength</code> or <code>netmask</code>." : " <code>ipAddress</code> is required.";
    hint.innerHTML = unknown.length
      ? '<span style="color:var(--color-warning)">Not read: ' + escapeHtml(unknown.join(" · ")) + '</span> — each line is <code>field = path</code>, with a field from: ' + escapeHtml(fields)
      : "Fields: " + escapeHtml(fields) + "." + req;
  }
}

function genericApiNetworkHTML(defaults) {
  var d = defaults || {};
  return infoBox('Read <strong style="color:var(--color-text-primary)">address space</strong> from this API into IPAM: subnets, DHCP leases, DHCP reservations, and addresses allocated in another IPAM. Each query is read once per discovery run.') +
    calloutHTML("note", "What a feed can and cannot do to IPAM",
      'A subnet is created only inside an existing block, and never over an overlapping, excluded or retired network. A subnet another integration owns is never taken over, and nothing is written into it. A manual reservation is never overwritten — a difference becomes a conflict to review. Nothing is ever pushed to a device. Addresses are IPv4.') +
    '<div id="f-gaNetworks">' + (d.networkQueries || []).map(_gaNetworkQueryHTML).join("") + '</div>' +
    '<button type="button" class="btn btn-secondary btn-sm" id="f-gaNetworkAdd">Add network query</button>' +
    formDivider() +
    sectionHeading("When something leaves the feed") +
    checkboxRow("f-gaReleaseMissing", "Release a DHCP reservation or IP assignment the feed stops listing", d.releaseMissingAddresses !== false) +
    '<p class="hint">Only after a complete read, and never when most of them vanish at once. Leases are never released this way — they expire.</p>' +
    checkboxRow("f-gaDeprecateSubnets", "Deprecate a subnet the feed stops listing", d.deprecateMissingSubnets === true) +
    '<p class="hint">Off by default. Only subnets this integration owns, only after a complete read, never when most vanish at once.</p>' +
    '<p class="hint" style="margin-top:0.75rem">Addresses are written only into subnets this integration owns. When it reads no subnets of its own, the unowned subnet an address falls in is claimed (its name and purpose kept).</p>';
}

function genericApiJsonHTML() {
  return '<p class="hint">The settings on the other tabs as JSON — to read at a glance, keep as a backup, or share a mapping for a product with anyone else running Polaris. <strong>Tokens, passwords and client secrets are never included</strong>, nor the value of an extra header whose name looks like it holds a credential.</p>' +
    checkboxRow("f-gaJsonConnection", "Include host, port, username, client ID and token URL", false) +
    '<p class="hint">Leave this off to share publicly — those say where your systems are and who Polaris logs in as. Turn it on to move a configuration between your own installs.</p>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:0.5rem 0">' +
      '<button type="button" class="btn btn-secondary btn-sm" id="f-gaJsonRefresh" title="Rebuild the JSON from the other tabs">Refresh from form</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" id="f-gaJsonCopy">Copy</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" id="f-gaJsonExport">Export file</button>' +
      '<button type="button" class="btn btn-secondary btn-sm" id="f-gaJsonImport">Import file…</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="f-gaJsonApply" title="Fill the other tabs from the JSON below">Apply to form</button>' +
      '<input type="file" id="f-gaJsonFile" accept=".json,application/json" style="display:none">' +
    '</div>' +
    '<textarea id="f-gaJson" class="mono" rows="18" spellcheck="false" style="width:100%;font-size:0.78rem;white-space:pre"></textarea>' +
    '<p id="f-gaJsonStatus" class="hint" style="margin-top:0.4rem"></p>';
}

function _gaVal(id) {
  var el = document.getElementById(id);
  return el ? String(el.value || "").trim() : "";
}

function _gaInt(id, fallback) {
  var n = parseInt(_gaVal(id), 10);
  return isNaN(n) ? fallback : n;
}

function getGenericApiFormConfig() {
  // A header with no value is dropped rather than sent empty — an imported
  // file leaves a credential header's value blank for the operator to fill.
  var headers = linesToArray("f-gaHeaders").map(function (line) {
    var i = line.indexOf(":");
    return i > 0 ? { name: line.slice(0, i).trim(), value: line.slice(i + 1).trim() } : null;
  }).filter(function (h) { return h && h.value; });
  var typeMap = {};
  linesToArray("f-gaTypeMap").forEach(function (line) {
    var i = line.indexOf("=");
    if (i > 0) typeMap[line.slice(0, i).trim()] = line.slice(i + 1).trim().toLowerCase();
  });
  var fieldMap = {};
  _GENERIC_API_FIELDS.forEach(function (f) { var v = _gaVal("f-gaMap-" + f[0]); if (v) fieldMap[f[0]] = v; });
  var devMode = _gaVal("f-deviceMode");
  var devNames = linesToArray("f-deviceNames");
  var mode = _gaVal("f-gaPageMode") || "none";
  var cfg = {
    host: val("f-host"),
    useHttps: document.getElementById("f-useHttps").checked,
    verifySsl: document.getElementById("f-verifySsl").checked,
    method: _gaVal("f-gaMethod") || "GET",
    path: _gaVal("f-gaPath") || "/",
    body: (document.getElementById("f-gaBody").value || "").trim(),
    headers: headers,
    authType: _gaVal("f-gaAuthType") || "none",
    apiToken: val("f-apiToken"),
    authHeaderName: _gaVal("f-gaAuthHeaderName"),
    authQueryParam: _gaVal("f-gaAuthQueryParam"),
    username: _gaVal("f-gaUsername"),
    password: val("f-password"),
    tokenUrl: _gaVal("f-gaTokenUrl"),
    clientId: _gaVal("f-gaClientId"),
    clientSecret: val("f-clientSecret"),
    scope: _gaVal("f-gaScope"),
    pagination: {
      mode: mode,
      pageParam: _gaVal("f-gaPageParam"),
      sizeParam: _gaVal("f-gaSizeParam"),
      pageSize: _gaInt("f-gaPageSize", 100),
      startPage: _gaInt("f-gaStartPage", 1),
      cursorPath: _gaVal("f-gaCursorPath"),
      cursorParam: _gaVal("f-gaCursorParam"),
      maxPages: _gaInt("f-gaMaxPages", 100),
    },
    recordsPath: _gaVal("f-gaRecordsPath"),
    fieldMap: fieldMap,
    detailQueries: _gaReadDetailQueries(),
    monitorQueries: _gaReadMonitorQueries(),
    networkQueries: _gaReadNetworkQueries(),
    releaseMissingAddresses: (document.getElementById("f-gaReleaseMissing") || { checked: true }).checked,
    deprecateMissingSubnets: (document.getElementById("f-gaDeprecateSubnets") || { checked: false }).checked,
    readDevices: (document.getElementById("f-gaReadDevices") || { checked: true }).checked,
    detailConcurrency: _gaInt("f-gaDetailConcurrency", 4),
    identityField: _gaVal("f-gaIdentity") || "id",
    assetTypeDefault: _gaVal("f-gaTypeDefault") || "other",
    assetTypeMap: typeMap,
    manufacturerDefault: _gaVal("f-gaManufacturer"),
    deviceInclude: devMode === "include" ? devNames : [],
    deviceExclude: devMode === "exclude" ? devNames : [],
    decommissionMissing: document.getElementById("f-gaDecommission").checked,
    verifyPresence: document.getElementById("f-verifyPresence").checked,
    maxRecords: _gaInt("f-gaMaxRecords", 10000),
    requestTimeoutMs: _gaInt("f-gaTimeoutSec", 30) * 1000,
    verboseLogging: readVerboseLoggingFromForm(),
  };
  var port = _gaVal("f-port");
  if (port) cfg.port = parseInt(port, 10);
  return cfg;
}

/**
 * Fill the General and Records & Mapping tabs from a configuration — the
 * inverse of getGenericApiFormConfig, used by the JSON tab's Apply / Import.
 * Secrets are never written (the portability module strips them; the stored
 * ones stay behind their "leave blank to keep" fields). A connection detail
 * the configuration does not carry (a shared file leaves them out) keeps
 * whatever the form already holds; everything else is replaced, so the form
 * ends up saying exactly what the JSON says.
 */
function _gaFillForm(cfg) {
  cfg = cfg || {};
  var set = function (id, v) { var el = document.getElementById(id); if (el) el.value = v == null ? "" : String(v); };
  var setSel = function (id, v) { var el = document.getElementById(id); if (el) { el.value = String(v); el.setAttribute("data-ga-value", String(v)); } };
  var check = function (id, on) { var el = document.getElementById(id); if (el) el.checked = !!on; };
  var has = function (k) { return cfg[k] !== undefined && cfg[k] !== null && cfg[k] !== ""; };
  if (has("host")) { set("f-host", cfg.host); set("f-port", cfg.port || ""); }
  else if (has("port")) set("f-port", cfg.port);
  if (has("username")) set("f-gaUsername", cfg.username);
  if (has("clientId")) set("f-gaClientId", cfg.clientId);
  if (has("tokenUrl")) set("f-gaTokenUrl", cfg.tokenUrl);
  check("f-useHttps", cfg.useHttps !== false);
  check("f-verifySsl", cfg.verifySsl !== false);
  setSel("f-gaMethod", cfg.method === "POST" ? "POST" : "GET");
  set("f-gaPath", cfg.path || "/");
  set("f-gaBody", cfg.body || "");
  set("f-gaHeaders", (cfg.headers || []).map(function (h) { return h.name + ": " + (h.value || ""); }).join("\n"));
  setSel("f-gaAuthType", cfg.authType || "none");
  set("f-gaAuthHeaderName", cfg.authHeaderName || "X-API-Key");
  set("f-gaAuthQueryParam", cfg.authQueryParam || "api_key");
  set("f-gaScope", cfg.scope || "");
  var pg = cfg.pagination || {};
  setSel("f-gaPageMode", pg.mode || "none");
  set("f-gaPageParam", pg.pageParam || "");
  set("f-gaSizeParam", pg.sizeParam || "");
  set("f-gaPageSize", pg.pageSize || 100);
  setSel("f-gaStartPage", String(pg.startPage != null ? pg.startPage : 1));
  set("f-gaCursorPath", pg.cursorPath || "");
  set("f-gaCursorParam", pg.cursorParam || "");
  set("f-gaMaxPages", pg.maxPages || 100);
  set("f-gaRecordsPath", cfg.recordsPath || "");
  var fm = cfg.fieldMap || {};
  _GENERIC_API_FIELDS.forEach(function (f) { set("f-gaMap-" + f[0], fm[f[0]] || ""); });
  var details = document.getElementById("f-gaDetails");
  if (details) {
    details.innerHTML = (cfg.detailQueries || []).map(_gaDetailQueryHTML).join("");
    details.querySelectorAll("select[data-ga-value]").forEach(function (sel) { sel.value = sel.getAttribute("data-ga-value"); });
  }
  set("f-gaDetailConcurrency", cfg.detailConcurrency || 4);
  var networks = document.getElementById("f-gaNetworks");
  if (networks) {
    networks.innerHTML = (cfg.networkQueries || []).map(_gaNetworkQueryHTML).join("");
    networks.querySelectorAll("select[data-ga-value]").forEach(function (sel) { sel.value = sel.getAttribute("data-ga-value"); });
    networks.querySelectorAll("[data-ga-network]").forEach(_gaSyncNetworkBlock);
  }
  check("f-gaReleaseMissing", cfg.releaseMissingAddresses !== false);
  check("f-gaDeprecateSubnets", cfg.deprecateMissingSubnets === true);
  check("f-gaReadDevices", cfg.readDevices !== false);
  var monitors = document.getElementById("f-gaMonitors");
  if (monitors) {
    monitors.innerHTML = (cfg.monitorQueries || []).map(_gaMonitorQueryHTML).join("");
    monitors.querySelectorAll("select[data-ga-value]").forEach(function (sel) { sel.value = sel.getAttribute("data-ga-value"); });
    monitors.querySelectorAll("[data-ga-monitor]").forEach(_gaSyncMonitorBlock);
  }
  setSel("f-gaIdentity", cfg.identityField || "id");
  setSel("f-gaTypeDefault", cfg.assetTypeDefault || "other");
  set("f-gaManufacturer", cfg.manufacturerDefault || "");
  var tm = cfg.assetTypeMap || {};
  set("f-gaTypeMap", Object.keys(tm).map(function (k) { return k + " = " + tm[k]; }).join("\n"));
  var include = cfg.deviceInclude || [];
  var devMode = include.length > 0 ? "include" : "exclude";
  set("f-deviceMode", devMode);
  set("f-deviceNames", (devMode === "include" ? include : (cfg.deviceExclude || [])).join("\n"));
  check("f-gaDecommission", cfg.decommissionMissing === true);
  check("f-verifyPresence", cfg.verifyPresence !== false);
  set("f-gaMaxRecords", cfg.maxRecords || 10000);
  set("f-gaTimeoutSec", Math.round((cfg.requestTimeoutMs || 30000) / 1000));
  _gaSyncVisibility();
}

/** The JSON tab's text: the form as a portable file (or the bare form when the module is absent). */
function _gaJsonFromForm() {
  var P = window.PolarisGenericApiPortability;
  var cfg = getGenericApiFormConfig();
  var conn = document.getElementById("f-gaJsonConnection");
  var file = P
    ? P.buildExportFile(cfg, { name: val("f-name"), includeConnection: !!(conn && conn.checked) })
    : cfg;
  return file;
}

function _gaJsonStatus(msg, tone) {
  var el = document.getElementById("f-gaJsonStatus");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = tone === "error" ? "var(--color-danger)" : tone === "warning" ? "var(--color-warning)" : tone === "success" ? "var(--color-success)" : "";
}

function _gaRefreshJson() {
  var ta = document.getElementById("f-gaJson");
  if (!ta) return;
  ta.value = JSON.stringify(_gaJsonFromForm(), null, 2);
  ta.removeAttribute("data-dirty");
  _gaJsonStatus("");
}

/**
 * Apply JSON text (pasted, edited, or read from a file) to the form. Errors
 * stay on the JSON tab; nothing is saved until the operator saves the dialog.
 */
function _gaApplyJson(text, filename) {
  var P = window.PolarisGenericApiPortability;
  if (!P) return false;
  var parsed;
  try { parsed = P.parseImportFile(text, filename); }
  catch (err) { _gaJsonStatus((err && err.message) || "That JSON could not be read.", "error"); return false; }
  _gaFillForm(parsed.config);
  var nameEl = document.getElementById("f-name");
  if (nameEl && !nameEl.value.trim() && parsed.name) nameEl.value = parsed.name;
  _gaRefreshJson();
  var needs = (parsed.needs || []).map(function (n) {
    return n === "token" ? "the token / key" : n === "password" ? "the password" : n === "clientSecret" ? "the client secret"
      : n.indexOf("header:") === 0 ? "the " + n.slice(7) + " header's value" : n === "tokenUrl" ? "the token URL" : n === "clientId" ? "the client ID" : "the " + n;
  });
  var msg = "Applied to the form — check each tab, then save." + (needs.length ? " Still to fill in on General: " + needs.join(", ") + "." : "");
  if (parsed.problems && parsed.problems.length) msg += " " + parsed.problems.join(" ");
  _gaJsonStatus(msg, parsed.problems && parsed.problems.length ? "warning" : "success");
  return true;
}

function _wireGenericApiJsonTab() {
  var P = window.PolarisGenericApiPortability;
  var ta = document.getElementById("f-gaJson");
  if (!ta) return;
  ta.addEventListener("input", function () { ta.setAttribute("data-dirty", "1"); });
  // Opening the tab shows the form as it is now — unless the operator has
  // been editing the JSON, which a tab switch must not throw away.
  document.querySelectorAll('.page-tab[data-tab="json"]').forEach(function (btn) {
    btn.addEventListener("click", function () { if (!ta.hasAttribute("data-dirty")) _gaRefreshJson(); });
  });
  var on = function (id, fn) { var el = document.getElementById(id); if (el) el.addEventListener("click", fn); };
  on("f-gaJsonRefresh", _gaRefreshJson);
  var conn = document.getElementById("f-gaJsonConnection");
  if (conn) conn.addEventListener("change", _gaRefreshJson);
  on("f-gaJsonApply", function () { _gaApplyJson(ta.value, ""); });
  on("f-gaJsonCopy", function () {
    copyTextToClipboard(ta.value).then(function (ok) { showToast(ok !== false ? "JSON copied" : "Copy failed", ok !== false ? "success" : "error"); });
  });
  on("f-gaJsonExport", function () {
    if (ta.hasAttribute("data-dirty")) {
      // Export what the operator sees: their edited JSON, once it parses.
      try { JSON.parse(ta.value); } catch (_) { _gaJsonStatus("The JSON below isn't valid — fix it or Refresh from form before exporting.", "error"); return; }
    } else {
      _gaRefreshJson();
    }
    var file = JSON.parse(ta.value);
    if (P && file && file.config) {
      // An edited file is re-stripped too: the export rule is the code's, not the editor's.
      var conn2 = document.getElementById("f-gaJsonConnection");
      file.config = P.stripConfig(file.config, { includeConnection: !!(conn2 && conn2.checked) }).config;
    }
    downloadJson(file, P ? P.filenameForExport(val("f-name") || file.name) : "generic-api.json");
  });
  var fileInput = document.getElementById("f-gaJsonFile");
  on("f-gaJsonImport", function () { if (fileInput) fileInput.click(); });
  if (fileInput) {
    fileInput.addEventListener("change", function () {
      var f = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!f) return;
      if (P && f.size > P.MAX_IMPORT_BYTES) { _gaJsonStatus("That file is too large to be a Generic API configuration.", "error"); return; }
      f.text().then(function (text) {
        ta.value = text;
        _gaApplyJson(text, f.name);
      }).catch(function () { _gaJsonStatus("That file could not be read.", "error"); });
    });
  }
  _gaRefreshJson();
}

/** Show the fields that belong to the chosen auth type / pagination mode / method. */
function _gaSyncVisibility() {
  var auth = _gaVal("f-gaAuthType") || "none";
  document.querySelectorAll("[data-ga-auth]").forEach(function (el) {
    el.style.display = el.getAttribute("data-ga-auth").split(" ").indexOf(auth) === -1 ? "none" : "";
  });
  var mode = _gaVal("f-gaPageMode") || "none";
  document.querySelectorAll("[data-ga-page]").forEach(function (el) {
    el.style.display = el.getAttribute("data-ga-page").split(" ").indexOf(mode) === -1 ? "none" : "";
  });
  var bodyWrap = document.getElementById("f-gaBodyWrap");
  if (bodyWrap) bodyWrap.style.display = _gaVal("f-gaMethod") === "POST" ? "" : "none";
}

function _renderGenericApiPreview(result) {
  var box = document.getElementById("f-gaPreviewResult");
  if (!box) return;
  var cols = ["hostname", "ipAddress", "serialNumber", "manufacturer", "model", "assetType", "location"];
  var labels = { hostname: "Hostname", ipAddress: "IP", serialNumber: "Serial", manufacturer: "Manufacturer", model: "Model", assetType: "Type", location: "Location" };
  // The other mapped fields join the table only when some row carries one,
  // so a feed that maps none of them keeps the table narrow.
  var extra = [["assetTag", "Asset tag"], ["department", "Department"], ["assignedTo", "Assigned to"], ["description", "Description"],
    ["tags", "Tags"], ["purchaseOrder", "PO"], ["acquiredAt", "Acquired"], ["warrantyExpiry", "Warranty"], ["latitude", "Lat"], ["longitude", "Lng"]];
  extra.forEach(function (e) {
    var any = (result.rows || []).some(function (r) {
      var v = r.outcome.ok ? r.outcome.record[e[0]] : null;
      return Array.isArray(v) ? v.length > 0 : v != null && v !== "";
    });
    if (any) { cols.push(e[0]); labels[e[0]] = e[1]; }
  });
  var rows = (result.rows || []).map(function (r) {
    if (!r.outcome.ok) {
      return '<tr><td>' + (r.index + 1) + '</td><td colspan="' + (cols.length + 1) + '" style="color:var(--color-warning)">Skipped — ' + escapeHtml(r.outcome.reason) + '</td></tr>';
    }
    var rec = r.outcome.record;
    var detailFail = (r.detailFailures || []).length
      ? ' <span style="color:var(--color-warning)" title="' + escapeHtml(r.detailFailures.join("\n")) + '">(detail query failed)</span>'
      : "";
    return '<tr' + (r.filteredOut ? ' style="opacity:0.55" title="Filtered out by the device filter"' : '') + '><td>' + (r.index + 1) + '</td>' +
      '<td class="mono">' + escapeHtml(rec.identity) + detailFail + '</td>' +
      cols.map(function (c) {
        var v = rec[c];
        if (Array.isArray(v)) v = v.join(", ");
        if ((c === "acquiredAt" || c === "warrantyExpiry") && v) v = String(v).slice(0, 10);
        if (c === "assetType" && rec.rawAssetType && rec.rawAssetType.toLowerCase() !== v) v = (v || "—") + " (" + rec.rawAssetType + ")";
        return '<td>' + (v ? escapeHtml(String(v)) : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>';
      }).join("") + '</tr>';
  }).join("");
  var warnings = (result.warnings || []).length
    ? calloutHTML("warning", "Notes", '<ul style="margin:0;padding-left:1.1rem">' + result.warnings.map(function (w) { return '<li>' + escapeHtml(w) + '</li>'; }).join("") + '</ul>')
    : "";
  var sample = result.sampleRecord
    ? sectionHeading("First record, as the API sent it") +
      '<pre class="mono" style="max-height:220px;overflow:auto;font-size:0.78rem;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.6rem;white-space:pre-wrap;word-break:break-all">' +
        escapeHtml(JSON.stringify(result.sampleRecord, null, 2).slice(0, 8000)) + '</pre>'
    : "";
  // Each detail query's answer for the first record — the document its paths are written against.
  sample += (result.sampleDetails || []).map(function (d) {
    return sectionHeading("Detail query “" + d.name + "”" + (d.path ? " — " + d.path : "")) +
      (d.ok
        ? '<pre class="mono" style="max-height:220px;overflow:auto;font-size:0.78rem;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.6rem;white-space:pre-wrap;word-break:break-all">' +
            escapeHtml(JSON.stringify(d.response, null, 2).slice(0, 8000)) + '</pre>'
        : '<p class="hint" style="color:var(--color-warning)">' + escapeHtml(d.error || "Failed") + '</p>');
  }).join("");
  var table = rows
    ? sectionHeading("As discovery would write them") +
      '<div style="overflow:auto"><table class="data-table" style="font-size:0.8rem"><thead><tr><th>#</th><th>Identity</th>' +
        cols.map(function (c) { return '<th>' + labels[c] + '</th>'; }).join("") + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    : "";
  // Network queries (rule 100(j)): each query's first page as IPAM would read it.
  var network = (result.network || []).map(function (n) {
    var isSubnet = n.kind === "subnets";
    var head = isSubnet ? ["CIDR", "Name", "VLAN", "Purpose"] : ["Address", "MAC", "Hostname", n.kind === "leases" ? "Expires" : (n.kind === "assignments" ? "Owner" : "")];
    var body = (n.rows || []).map(function (r) {
      if (!r.outcome.ok) return '<tr><td>' + (r.index + 1) + '</td><td colspan="4" style="color:var(--color-warning)">Skipped — ' + escapeHtml(r.outcome.reason) + '</td></tr>';
      var v = r.outcome.value;
      var cells = isSubnet ? [v.cidr, v.name, v.vlan, v.purpose] : [v.ipAddress, v.macAddress, v.hostname, n.kind === "leases" ? (v.expiresAt ? String(v.expiresAt).slice(0, 16).replace("T", " ") : "") : (n.kind === "assignments" ? v.owner : "")];
      return '<tr><td>' + (r.index + 1) + '</td>' + cells.map(function (c) {
        return '<td>' + (c != null && c !== "" ? escapeHtml(String(c)) : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>';
      }).join("") + '</tr>';
    }).join("");
    return sectionHeading("Network query “" + n.name + "”") +
      '<p class="hint" style="color:' + (n.ok ? "var(--color-success)" : "var(--color-warning)") + '">' + escapeHtml(n.message) + '</p>' +
      (n.sampleRecord ? '<pre class="mono" style="max-height:160px;overflow:auto;font-size:0.78rem;background:var(--color-surface);border:1px solid var(--color-border);border-radius:var(--radius-md);padding:0.6rem;white-space:pre-wrap;word-break:break-all">' + escapeHtml(JSON.stringify(n.sampleRecord, null, 2).slice(0, 4000)) + '</pre>' : "") +
      (body ? '<div style="overflow:auto"><table class="data-table" style="font-size:0.8rem"><thead><tr><th>#</th>' + head.map(function (h) { return '<th>' + escapeHtml(h) + '</th>'; }).join("") + '</tr></thead><tbody>' + body + '</tbody></table></div>' : "");
  }).join("");
  box.innerHTML = warnings + sample + (sample && table ? formDivider() : "") + table + (network ? formDivider() + network : "");
}

async function _runGenericApiPreview(id) {
  var btn = document.getElementById("f-gaPreviewBtn");
  var status = document.getElementById("f-gaPreviewStatus");
  if (!val("f-host")) { showToast("Enter the host on the General tab first", "error"); return; }
  var cfg = getGenericApiFormConfig();
  if (id) { if (!cfg.apiToken) delete cfg.apiToken; if (!cfg.password) delete cfg.password; if (!cfg.clientSecret) delete cfg.clientSecret; }
  if (btn) { btn.disabled = true; btn.textContent = "Reading…"; }
  try {
    var result = await api.integrations.genericApiPreview({ id: id || undefined, config: cfg, limit: 10 });
    if (status) {
      status.textContent = result.message || "";
      status.style.color = result.ok ? "var(--color-success)" : "var(--color-warning)";
    }
    _renderGenericApiPreview(result);
  } catch (err) {
    if (status) { status.textContent = (err && err.message) || "Preview failed"; status.style.color = "var(--color-danger)"; }
    var box = document.getElementById("f-gaPreviewResult");
    if (box) box.innerHTML = "";
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Run preview"; }
  }
}

function _wireGenericApiForm(id) {
  document.querySelectorAll("select[data-ga-value]").forEach(function (sel) {
    sel.value = sel.getAttribute("data-ga-value");
  });
  // The Filters mode select is the shared f-deviceMode markup; pin it the same way.
  var devMode = document.getElementById("f-deviceMode");
  if (devMode && devMode.querySelector("option[selected]")) devMode.value = devMode.querySelector("option[selected]").value;
  ["f-gaAuthType", "f-gaPageMode", "f-gaMethod"].forEach(function (elId) {
    var el = document.getElementById(elId);
    if (el) el.addEventListener("change", _gaSyncVisibility);
  });
  _gaSyncVisibility();
  var btn = document.getElementById("f-gaPreviewBtn");
  if (btn) btn.addEventListener("click", function () { _runGenericApiPreview(id); });
  // Detail queries: one delegated listener set on the container, so blocks
  // added later (Add, or a JSON import rebuilding the list) need no wiring.
  var details = document.getElementById("f-gaDetails");
  if (details) {
    details.querySelectorAll("select[data-ga-value]").forEach(function (sel) { sel.value = sel.getAttribute("data-ga-value"); });
    details.addEventListener("click", function (e) {
      var rm = e.target.closest && e.target.closest(".ga-detail-remove");
      if (rm) { var block = rm.closest("[data-ga-detail]"); if (block) block.remove(); }
    });
    details.addEventListener("change", function (e) {
      if (!e.target.classList || !e.target.classList.contains("ga-detail-method")) return;
      var block = e.target.closest("[data-ga-detail]");
      var wrap = block && block.querySelector(".ga-detail-body-wrap");
      if (wrap) wrap.style.display = e.target.value === "POST" ? "" : "none";
    });
    details.addEventListener("input", function (e) {
      if (!e.target.classList || !e.target.classList.contains("ga-detail-map")) return;
      var block = e.target.closest("[data-ga-detail]");
      if (block) _gaCheckDetailMap(block);
    });
    details.querySelectorAll("[data-ga-detail]").forEach(_gaCheckDetailMap);
  }
  var add = document.getElementById("f-gaDetailAdd");
  if (add && details) {
    add.addEventListener("click", function () {
      if (details.querySelectorAll("[data-ga-detail]").length >= 5) { showToast("At most 5 detail queries", "error"); return; }
      details.insertAdjacentHTML("beforeend", _gaDetailQueryHTML({}));
      var input = details.lastElementChild && details.lastElementChild.querySelector(".ga-detail-path");
      if (input) input.focus();
    });
  }
  // Monitor queries — the same delegated-listener shape as the detail queries.
  var monitors = document.getElementById("f-gaMonitors");
  if (monitors) {
    monitors.querySelectorAll("select[data-ga-value]").forEach(function (sel) { sel.value = sel.getAttribute("data-ga-value"); });
    monitors.addEventListener("click", function (e) {
      var rm = e.target.closest && e.target.closest(".ga-mon-remove");
      if (rm) { var block = rm.closest("[data-ga-monitor]"); if (block) block.remove(); }
    });
    var resync = function (e) {
      var block = e.target.closest && e.target.closest("[data-ga-monitor]");
      if (block) _gaSyncMonitorBlock(block);
    };
    monitors.addEventListener("change", resync);
    monitors.addEventListener("input", resync);
    monitors.querySelectorAll("[data-ga-monitor]").forEach(_gaSyncMonitorBlock);
  }
  var addMon = document.getElementById("f-gaMonitorAdd");
  if (addMon && monitors) {
    addMon.addEventListener("click", function () {
      if (monitors.querySelectorAll("[data-ga-monitor]").length >= 10) { showToast("At most 10 monitor queries", "error"); return; }
      monitors.insertAdjacentHTML("beforeend", _gaMonitorQueryHTML({}));
      var added = monitors.lastElementChild;
      if (added) {
        added.querySelectorAll("select[data-ga-value]").forEach(function (sel) { sel.value = sel.getAttribute("data-ga-value"); });
        _gaSyncMonitorBlock(added);
        var input = added.querySelector(".ga-mon-name");
        if (input) input.focus();
      }
    });
  }
  // Network queries — the same delegated-listener shape.
  var networks = document.getElementById("f-gaNetworks");
  if (networks) {
    networks.querySelectorAll("select[data-ga-value]").forEach(function (sel) { sel.value = sel.getAttribute("data-ga-value"); });
    networks.addEventListener("click", function (e) {
      var rm = e.target.closest && e.target.closest(".ga-net-remove");
      if (rm) { var block = rm.closest("[data-ga-network]"); if (block) block.remove(); }
    });
    var resyncNet = function (e) {
      var block = e.target.closest && e.target.closest("[data-ga-network]");
      if (block) _gaSyncNetworkBlock(block);
    };
    networks.addEventListener("change", resyncNet);
    networks.addEventListener("input", resyncNet);
    networks.querySelectorAll("[data-ga-network]").forEach(_gaSyncNetworkBlock);
  }
  var addNet = document.getElementById("f-gaNetworkAdd");
  if (addNet && networks) {
    addNet.addEventListener("click", function () {
      if (networks.querySelectorAll("[data-ga-network]").length >= 10) { showToast("At most 10 network queries", "error"); return; }
      networks.insertAdjacentHTML("beforeend", _gaNetworkQueryHTML({}));
      var added = networks.lastElementChild;
      if (added) {
        added.querySelectorAll("select[data-ga-value]").forEach(function (sel) { sel.value = sel.getAttribute("data-ga-value"); });
        _gaSyncNetworkBlock(added);
        var input = added.querySelector(".ga-net-name");
        if (input) input.focus();
      }
    });
  }
  _wireGenericApiJsonTab();
}

