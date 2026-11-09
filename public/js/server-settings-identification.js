/**
 * public/js/server-settings-identification.js — Server Settings →
 * Identification: the tag registry (tag colours, the auto-assign device
 * filter, the "assets with this tag" slide-in), DNS settings, the OUI
 * database and overrides, Device Icons and Device Types.
 *
 * The tab's shared state (`_tagsData`, `_mibsData`, `_mfgProfiles`, …) lives
 * in the core, server-settings.js, because the MIB and profile files read it
 * too. Split out of server-settings.js (CQ-F051) as a byte-for-byte move. A
 * plain browser script: its functions and `var`s are page globals, called
 * from the core's tab dispatch (`loadIdentificationTab`). Loads AFTER
 * server-settings.js — tests/unit/serverSettingsSplit.test.ts holds the order.
 */

// ─── DNS Settings ─────────────────────────────────────────────────────────

var _dnsDefaults = { servers: [], mode: "standard", dohUrl: "", verifyTls: false };

function dnsCardsHTML() {
  return '<div class="settings-cards-row">' +
    '<div class="settings-card">' +
    '<h4>DNS Configuration</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Configure custom DNS servers for reverse lookups (PTR records). These servers are used when resolving IP addresses ' +
      'to hostnames — both for manual DNS lookups on the Assets page and during automated integration discovery.' +
    '</p>' +
    '<div class="form-group"><label>Protocol</label>' +
      '<select id="f-dns-mode">' +
        '<option value="standard"' + (_dnsDefaults.mode === "standard" ? ' selected' : '') + '>Standard (UDP/TCP)</option>' +
        '<option value="dot"' + (_dnsDefaults.mode === "dot" ? ' selected' : '') + '>DNS over TLS (DoT)</option>' +
        '<option value="doh"' + (_dnsDefaults.mode === "doh" ? ' selected' : '') + '>DNS over HTTPS (DoH)</option>' +
      '</select>' +
      '<p class="hint">Standard uses plain DNS on port 53. DoT encrypts queries via TLS on port 853. DoH sends queries over HTTPS.</p>' +
    '</div>' +
    '<div id="dns-servers-group" class="form-group"><label>DNS Servers</label>' +
      '<textarea id="f-dns-servers" rows="5" placeholder="One server per line, e.g.:\n8.8.8.8\ndns.google\n2001:4860:4860::8888">' + escapeHtml(_dnsDefaults.servers.join("\n")) + '</textarea>' +
      '<p class="hint" id="dns-servers-hint">Enter one server per line. IP addresses and hostnames are both supported. When empty, the system default resolver is used.</p>' +
      '<div id="dns-servers-examples" style="margin-top:0.5rem;font-size:0.78rem;color:var(--color-text-tertiary)"></div>' +
    '</div>' +
    '<div id="dns-doh-group" class="form-group" style="display:none"><label>DoH URL</label>' +
      '<input type="text" id="f-dns-doh-url" value="' + escapeHtml(_dnsDefaults.dohUrl) + '" placeholder="https://dns.google/resolve">' +
      '<p class="hint">The HTTPS endpoint for DNS queries. Must support the JSON API (application/dns-json). Common providers:</p>' +
      '<div style="margin-top:0.4rem;font-size:0.78rem;color:var(--color-text-tertiary)">' +
        '<table style="border-collapse:collapse;width:100%">' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Google</td><td class="mono">https://dns.google/resolve</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Cloudflare</td><td class="mono">https://cloudflare-dns.com/dns-query</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Quad9</td><td class="mono">https://dns.quad9.net:5053/dns-query</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">AdGuard</td><td class="mono">https://dns.adguard-dns.com/dns-query</td></tr>' +
        '</table>' +
      '</div>' +
    '</div>' +
    '<div id="dns-verifytls-group" class="form-group" style="display:none">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-dns-verifytls"' + (_dnsDefaults.verifyTls === true ? ' checked' : '') + '>' +
        '<span>Verify resolver TLS certificate</span>' +
      '</label>' +
      '<p class="hint" style="color:var(--color-warning,#d98c00)">Recommended. When off, encrypted DNS (DoT/DoH) accepts any certificate, so a network attacker can impersonate the resolver and return forged answers that drive hostname learning and auto-reservations. Public resolvers (Google, Cloudflare, Quad9) present valid certificates and work with this on. Turn off only for an internal resolver that uses a private CA.</p>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-primary" id="btn-dns-save">Save DNS Settings</button>' +
    '</div>' +
  '</div>' +
  '<div class="settings-card">' +
    '<h4>Test DNS Lookup</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Verify that the configured DNS servers answer, by looking up a known IP address or hostname.' +
    '</p>' +
    '<div class="form-group"><label>IP Address or Hostname</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="text" id="f-dns-test-ip" value="8.8.8.8" placeholder="e.g. 8.8.8.8, nas.example.lan or https://nas.example.lan" style="width:320px">' +
        '<button class="btn btn-secondary" id="btn-dns-test">Test Lookup</button>' +
      '</div>' +
      '<p class="hint">An IP address runs a reverse (PTR) lookup; a hostname or URL runs a forward (A/AAAA) lookup against the configured servers.</p>' +
      '<div id="dns-status" style="font-size:0.82rem;margin-top:0.4rem"></div>' +
    '</div>' +
  '</div>' +
  '</div>';
}

function wireDnsControls() {
  var modeSelect = document.getElementById("f-dns-mode");
  modeSelect.addEventListener("change", updateDnsFieldVisibility);
  updateDnsFieldVisibility();
  document.getElementById("btn-dns-save").addEventListener("click", saveDnsSettings);
  document.getElementById("btn-dns-test").addEventListener("click", testDnsLookup);
}

function updateDnsFieldVisibility() {
  var mode = document.getElementById("f-dns-mode").value;
  var serversGroup = document.getElementById("dns-servers-group");
  var dohGroup = document.getElementById("dns-doh-group");
  var serversHint = document.getElementById("dns-servers-hint");
  var serversExamples = document.getElementById("dns-servers-examples");
  var verifyTlsGroup = document.getElementById("dns-verifytls-group");

  // TLS verification only applies to the encrypted modes (DoT/DoH).
  if (verifyTlsGroup) verifyTlsGroup.style.display = (mode === "doh" || mode === "dot") ? "" : "none";

  if (mode === "doh") {
    serversGroup.style.display = "none";
    dohGroup.style.display = "";
  } else {
    serversGroup.style.display = "";
    dohGroup.style.display = "none";
    if (mode === "dot") {
      serversHint.textContent = "Enter one server per line. IP addresses and hostnames are both supported. Port 853 (TLS) is used automatically.";
      serversExamples.innerHTML =
        '<table style="border-collapse:collapse;width:100%">' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Google</td><td class="mono">dns.google</td><td class="mono" style="padding-left:12px">8.8.8.8</td><td class="mono" style="padding-left:12px">2001:4860:4860::8888</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Cloudflare</td><td class="mono">one.one.one.one</td><td class="mono" style="padding-left:12px">1.1.1.1</td><td class="mono" style="padding-left:12px">2606:4700:4700::1111</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Quad9</td><td class="mono">dns.quad9.net</td><td class="mono" style="padding-left:12px">9.9.9.9</td><td class="mono" style="padding-left:12px">2620:fe::fe</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">AdGuard</td><td class="mono">dns.adguard-dns.com</td><td class="mono" style="padding-left:12px">94.140.14.14</td><td class="mono" style="padding-left:12px">2a10:50c0::ad1:ff</td></tr>' +
        '</table>';
    } else {
      serversHint.textContent = "Enter one server per line. IP addresses and hostnames are both supported. When empty, the system default resolver is used.";
      serversExamples.innerHTML =
        '<table style="border-collapse:collapse;width:100%">' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Google</td><td class="mono">dns.google</td><td class="mono" style="padding-left:12px">8.8.8.8</td><td class="mono" style="padding-left:12px">2001:4860:4860::8888</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Cloudflare</td><td class="mono">one.one.one.one</td><td class="mono" style="padding-left:12px">1.1.1.1</td><td class="mono" style="padding-left:12px">2606:4700:4700::1111</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">Quad9</td><td class="mono">dns.quad9.net</td><td class="mono" style="padding-left:12px">9.9.9.9</td><td class="mono" style="padding-left:12px">2620:fe::fe</td></tr>' +
          '<tr><td style="padding:2px 12px 2px 0;font-weight:500">OpenDNS</td><td class="mono">dns.opendns.com</td><td class="mono" style="padding-left:12px">208.67.222.222</td><td class="mono" style="padding-left:12px">2620:119:35::35</td></tr>' +
        '</table>';
    }
  }
}

function collectDnsForm() {
  return {
    mode: document.getElementById("f-dns-mode").value,
    servers: document.getElementById("f-dns-servers").value
      .split("\n").map(function (s) { return s.trim(); }).filter(Boolean),
    dohUrl: (document.getElementById("f-dns-doh-url").value || "").trim(),
    verifyTls: document.getElementById("f-dns-verifytls").checked,
  };
}

async function saveDnsSettings() {
  var btn = document.getElementById("btn-dns-save");
  btn.disabled = true;
  try {
    await api.serverSettings.updateDns(collectDnsForm());
    showToast("DNS settings saved");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function testDnsLookup() {
  var btn = document.getElementById("btn-dns-test");
  var statusEl = document.getElementById("dns-status");
  btn.disabled = true;
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Testing...</span>';
  try {
    var form = collectDnsForm();
    form.testIp = document.getElementById("f-dns-test-ip").value.trim() || "8.8.8.8";
    var result = await api.serverSettings.testDns(form);
    if (result.results && result.results.length > 1) {
      statusEl.innerHTML = result.results.map(function (r) {
        var color = r.ok ? "var(--color-success)" : "var(--color-danger)";
        return '<div style="font-size:0.82rem;padding:2px 0"><span style="color:' + color + '">' +
          (r.ok ? "&#10003;" : "&#10007;") + '</span> <strong>' + escapeHtml(r.server) + '</strong> — ' + escapeHtml(r.message) + '</div>';
      }).join("");
    } else {
      statusEl.innerHTML = result.ok
        ? '<span style="color:var(--color-success)">' + escapeHtml(result.message) + '</span>'
        : '<span style="color:var(--color-danger)">' + escapeHtml(result.message) + '</span>';
    }
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

// ─── OUI Database ──────────────────────────────────────────────────────────

async function loadOuiStatus() {
  try {
    var status = await api.serverSettings.getOui();
    document.getElementById("oui-status-loaded").textContent = status.loaded ? "Loaded" : "Not downloaded";
    document.getElementById("oui-status-entries").textContent = status.entries ? status.entries.toLocaleString() + " vendors" : "-";
    document.getElementById("oui-status-refreshed").textContent = status.refreshedAt ? formatDate(status.refreshedAt) : "Never";
  } catch (_) {
    document.getElementById("oui-status-loaded").textContent = "Error loading status";
  }
}

async function runOuiQuery() {
  var input = document.getElementById("f-oui-query");
  var resultEl = document.getElementById("oui-query-result");
  var btn = document.getElementById("btn-oui-query");
  var q = input.value.trim();
  if (!q) {
    resultEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Enter a MAC address or 3-byte prefix.</span>';
    return;
  }
  btn.disabled = true;
  resultEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Looking up...</span>';
  try {
    var r = await api.serverSettings.lookupOui(q);
    var rows = "";
    rows += '<div class="db-info-grid">' +
      '<div class="db-info-label">Prefix</div>' +
      '<div class="db-info-value" style="font-family:var(--font-mono)">' + escapeHtml(r.prefix) + '</div>' +
      '<div class="db-info-label">IEEE Database</div>' +
      '<div class="db-info-value">' + (r.ieee ? escapeHtml(r.ieee) : '<span style="color:var(--color-text-tertiary)">No match</span>') + '</div>' +
      '<div class="db-info-label">Override</div>' +
      '<div class="db-info-value">' +
        (r.override
          ? escapeHtml(r.override.manufacturer) + (r.override.device ? ' <span style="color:var(--color-text-tertiary)">(' + escapeHtml(r.override.device) + ')</span>' : '')
          : '<span style="color:var(--color-text-tertiary)">None</span>') +
      '</div>' +
      '<div class="db-info-label">Effective</div>' +
      '<div class="db-info-value">' +
        (r.effective
          ? '<strong>' + escapeHtml(r.effective) + '</strong>' +
            ' <span style="color:var(--color-text-tertiary);font-size:0.78rem">(from ' + escapeHtml(r.source) + ')</span>'
          : '<span style="color:var(--color-danger)">Unknown — no IEEE match and no override</span>') +
      '</div>' +
    '</div>';
    resultEl.innerHTML = rows;
  } catch (err) {
    resultEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

async function refreshOuiDatabase() {
  var btn = document.getElementById("btn-oui-refresh");
  var statusEl = document.getElementById("oui-refresh-status");
  btn.disabled = true;
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Downloading IEEE OUI database...</span>';
  try {
    var result = await api.serverSettings.refreshOui();
    statusEl.innerHTML = '<span style="color:var(--color-success)">' +
      escapeHtml(result.entries.toLocaleString() + " entries loaded (" + result.sizeKb + " KB)") + '</span>';
    showToast("OUI database refreshed — " + result.entries.toLocaleString() + " vendors", "success");
    loadOuiStatus();
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
    showToast("OUI refresh failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// ─── Identification Tab ────────────────────────────────────────────────────

async function loadIdentificationTab() {
  var container = document.getElementById("tab-identification");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';

  // Assets-admin only loads the MIB-related endpoints (the only ones the
  // backend opens to them). The admin-only endpoints below would 403 and
  // reject the whole Promise.all, leaving the page stuck on "Loading…".
  if (typeof isAdmin === "function" && !isAdmin()) {
    try {
      var mibResults = await Promise.all([
        api.serverSettings.listMibs().catch(function () { return []; }),
        api.serverSettings.getMibFacets().catch(function () { return { manufacturers: [], modelsByManufacturer: {} }; }),
      ]);
      _mibsData = mibResults[0] || [];
      _mibFacets = mibResults[1] || { manufacturers: [], modelsByManufacturer: {} };
      _tagsLoaded = true;
      renderIdentificationTab();
    } catch (err) {
      container.innerHTML = '<div class="settings-card"><p style="color:var(--color-danger)">' + escapeHtml(err.message || "Failed to load") + '</p></div>';
    }
    return;
  }

  try {
    var results = await Promise.all([
      api.serverSettings.listTags(),
      api.serverSettings.getTagSettings(),
      api.serverSettings.getDns().catch(function () { return null; }),
      api.serverSettings.getOuiOverrides().catch(function () { return []; }),
      api.serverSettings.listMibs().catch(function () { return []; }),
      api.serverSettings.getMibFacets().catch(function () { return { manufacturers: [], modelsByManufacturer: {} }; }),
      api.serverSettings.listManufacturerAliases().catch(function () { return []; }),
      api.deviceIcons.list().catch(function () { return []; }),
      api.serverSettings.listManufacturerProfiles().catch(function () { return { profiles: [], transforms: [] }; }),
      api.serverSettings.getPlaceholderMac().catch(function () { return null; }),
      api.assetTypes.list({ withUsage: 1 }).catch(function () { return { types: [] }; }),
      api.assetTypes.matchSchema().catch(function () { return null; }),
    ]);
    _tagsData = results[0];
    _tagSettings = results[1] || { enforce: false };
    if (results[2]) {
      _dnsDefaults.servers = results[2].servers || [];
      _dnsDefaults.mode = results[2].mode || "standard";
      _dnsDefaults.dohUrl = results[2].dohUrl || "";
      _dnsDefaults.verifyTls = results[2].verifyTls === true;
    }
    _ouiOverrides = results[3] || [];
    _mibsData = results[4] || [];
    _mibFacets = results[5] || { manufacturers: [], modelsByManufacturer: {} };
    _manufacturerAliases = results[6] || [];
    _deviceIcons = results[7] || [];
    var profilePayload = results[8] || {};
    _mfgProfiles = profilePayload.profiles || [];
    _mfgProfileTransforms = profilePayload.transforms || [];
    _mfgProfileCombiners = profilePayload.combiners || [];
    _mfgMetricTransforms = profilePayload.metricTransforms || {};
    _placeholderMac = results[9] || null;
    _assetTypes = (results[10] || {}).types || [];
    if (results[11]) _assetTypeMatchSchema = results[11];
    _tagsLoaded = true;
    renderIdentificationTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function _currentCategories() {
  var cats = {};
  _tagsData.forEach(function (t) { cats[t.category || "General"] = true; });
  return Object.keys(cats);
}

// The MIB Database + Manufacturer Profiles cards moved to the Credentials
// tab. Most pre-existing event handlers in those flows call
// `renderIdentificationTab()` to refresh after a mutation. To avoid touching
// every callsite, the identification renderer below also re-renders the
// Credentials tab whenever it's been loaded — the dual-render keeps both
// surfaces in sync and is cheap (innerHTML rewrite of two cards).
function _maybeRerenderCredentialsTabForMibOrProfile() {
  if (typeof _credsLoaded !== "undefined" && _credsLoaded) {
    try { renderCredentialsTab(); } catch (_) {}
  }
}

function renderIdentificationTab() {
  var container = document.getElementById("tab-identification");
  var html = '';

  // Assets-admin's MIB-browse surface lives on the Credentials tab now. If a
  // non-admin somehow lands on Identification (e.g. a stale bookmark), render
  // an empty card pointing them at the right tab rather than a blank page.
  if (typeof isAdmin === "function" && !isAdmin()) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">The MIB Database has moved to the Credentials tab.</p></div>';
    _maybeRerenderCredentialsTabForMibOrProfile();
    return;
  }

  // ── 1. DNS Configuration ──
  html += dnsCardsHTML();

  // ── 2. MAC & Vendor Identification (consolidated: Overrides + Aliases + OUI Database) ──
  html += '<div class="settings-card">' +
    '<h4>MAC &amp; Vendor Identification</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1.25rem">' +
      'Three-layer resolution pipeline: <strong>Prefix Overrides</strong> take top priority, ' +
      'then <strong>Manufacturer Aliases</strong> normalize the vendor name, ' +
      'and the <strong>IEEE OUI Database</strong> provides the base lookup.' +
    '</p>';

  // ── Placeholder MAC Prefix ──
  // Sits in this card because it IS a MAC-prefix setting, next to the OUI
  // machinery that interprets prefixes — an operator will often add a matching
  // Prefix Override ("02:0F:5E → Polaris (placeholder)") a few inches below.
  var phPrefix = (_placeholderMac && _placeholderMac.prefix) || "02:0F:5E";
  html += '<h5 class="mac-id-section-heading">Placeholder MAC Prefix</h5>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'A DHCP reservation is a MAC&rarr;IP binding, so reserving an IP for a device that isn\'t racked yet ' +
      'needs a MAC before there is a device to supply one. The IP panel\'s <strong>Generate</strong> button ' +
      'builds one from this prefix, and it is the <em>only</em> thing marking that MAC as a placeholder &mdash; ' +
      'Fortinet discovery replaces a MAC matching it with the real device\'s MAC once one appears at that IP ' +
      '(per-integration opt-in on the DHCP Push tab). A MAC that does not match is never touched.' +
    '</p>' +
    '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:0.5rem">' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Prefix</label>' +
        '<input type="text" id="f-placeholder-mac-prefix" value="' + escapeHtml(phPrefix) + '" ' +
          'placeholder="02:0F:5E" style="font-family:var(--font-mono);font-size:0.85rem">' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-save-placeholder-mac">Save</button>' +
    '</div>' +
    '<ul class="hint" style="margin:0.25rem 0 1.25rem 1.2rem;padding:0">' +
      '<li>1&ndash;5 hex octets. The first octet must be <strong>locally administered and unicast</strong> ' +
        '(02, 06, 0A, 0E, &hellip;). A real vendor OUI is rejected: it would make that vendor\'s genuine ' +
        'devices look like placeholders, and discovery would be free to overwrite them.</li>' +
      '<li><strong>Changing this is not retroactive, in either direction.</strong> Reservations carrying the ' +
        'old prefix stop being adoptable, and any reservation that happens to match the new one becomes ' +
        'adoptable immediately.</li>' +
      '<li>Installs that generated MACs before this setting existed used a bare <code>02</code>. Set the ' +
        'prefix to <code>02</code> to have those recognized &mdash; noting that <code>02</code> alone also ' +
        'matches genuine KVM, Docker and FortiOS-HA MACs.</li>' +
    '</ul>';

  // ── Prefix Overrides ──
  html += '<h5 class="mac-id-section-heading">Prefix Overrides</h5>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'Static MAC prefix → manufacturer mappings that take priority over everything else. ' +
      'Use for custom hardware, internal devices, or to correct misidentified vendors.' +
    '</p>';

  if (_ouiOverrides.length > 0) {
    html += '<table class="ip-table" style="margin-bottom:1rem"><thead><tr>' +
      '<th>MAC Prefix</th><th>Manufacturer</th><th>Device</th><th style="width:70px"></th>' +
    '</tr></thead><tbody>';
    _ouiOverrides.forEach(function (o) {
      html += '<tr>' +
        '<td class="mono" style="font-size:0.85rem">' + escapeHtml(o.prefix) + '</td>' +
        '<td>' + escapeHtml(o.manufacturer) + '</td>' +
        '<td>' + escapeHtml(o.device || '') + '</td>' +
        '<td class="actions"><button class="btn btn-sm btn-danger oui-override-del" data-prefix="' + escapeHtml(o.prefix) + '">Del</button></td>' +
      '</tr>';
    });
    html += '</tbody></table>';
  } else {
    html += '<p class="empty-state" style="margin-bottom:1rem">No overrides defined. The IEEE OUI database is used for all lookups.</p>';
  }

  html +=
    '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">' +
      '<div style="flex:0 0 140px">' +
        '<label style="font-size:0.78rem;font-weight:500">MAC Prefix</label>' +
        '<input type="text" id="f-oui-prefix" placeholder="AA:BB:CC" style="font-family:var(--font-mono);font-size:0.85rem">' +
      '</div>' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Manufacturer</label>' +
        '<span class="aw-combo aw-combo-dim">' +
          '<input type="text" id="f-oui-manufacturer" autocomplete="off" placeholder="e.g. Custom Switch Co.">' +
          '<div class="aw-suggest" id="oui-mfr-suggest"></div>' +
        '</span>' +
      '</div>' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Device <span style="color:var(--color-text-tertiary);font-weight:400">(optional)</span></label>' +
        '<input type="text" id="f-oui-device" placeholder="e.g. PowerEdge R740">' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-add-oui-override">Add Override</button>' +
    '</div>';

  // ── Divider ──
  html += '<hr class="mac-id-divider">';

  // ── Two-column: Manufacturer Aliases (left) + IEEE OUI Database (right) ──
  html += '<div class="mac-id-two-col">';

  // Left: Manufacturer Aliases
  html += '<div>' +
    '<h5 class="mac-id-section-heading">Manufacturer Aliases</h5>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'Map vendor name variants to a single canonical form so the same vendor doesn\'t split into multiple entries. ' +
      'Each alias (e.g. <code>Fortinet, Inc.</code>) is rewritten to its canonical name (e.g. <code>Fortinet</code>) on every asset and MIB write. ' +
      'Aliases are matched case-insensitively.' +
    '</p>';

  if (_manufacturerAliases.length > 0) {
    var groups = {};
    _manufacturerAliases.forEach(function (a) {
      if (!groups[a.canonical]) groups[a.canonical] = [];
      groups[a.canonical].push(a);
    });
    var canonicalNames = Object.keys(groups).sort(function (a, b) { return a.localeCompare(b); });

    html += '<div style="max-height:22rem;overflow-y:auto;overflow-x:auto;margin-bottom:1rem">' +
      '<table class="ip-table"><thead><tr>' +
      '<th style="position:sticky;top:0;z-index:1;background:var(--color-bg-primary)">Alias</th>' +
      '<th style="position:sticky;top:0;z-index:1;background:var(--color-bg-primary)">Canonical</th>' +
      '<th style="position:sticky;top:0;z-index:1;background:var(--color-bg-primary);width:120px"></th>' +
    '</tr></thead><tbody>';
    canonicalNames.forEach(function (canonical) {
      groups[canonical].forEach(function (a) {
        html += '<tr data-alias-id="' + escapeHtml(a.id) + '">' +
          '<td><span class="alias-text mono" style="font-size:0.85rem">' + escapeHtml(a.alias) + '</span></td>' +
          '<td><span class="canonical-text">' + escapeHtml(a.canonical) + '</span></td>' +
          '<td class="actions">' +
            '<button class="btn btn-sm alias-edit" data-id="' + escapeHtml(a.id) + '">Edit</button> ' +
            '<button class="btn btn-sm btn-danger alias-del" data-id="' + escapeHtml(a.id) + '">Del</button>' +
          '</td>' +
        '</tr>';
      });
    });
    html += '</tbody></table></div>'; // end scroll container
  } else {
    html += '<p class="empty-state" style="margin-bottom:1rem">No aliases defined.</p>';
  }

  html +=
    '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap">' +
      '<div style="flex:2;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Alias <span style="color:var(--color-text-tertiary);font-weight:400">(input)</span></label>' +
        '<span class="aw-combo aw-combo-dim">' +
          '<input type="text" id="f-alias-input" autocomplete="off" placeholder="e.g. Fortinet, Inc.">' +
          '<div class="aw-suggest" id="alias-input-suggest"></div>' +
        '</span>' +
      '</div>' +
      '<div style="flex:1;min-width:120px">' +
        '<label style="font-size:0.78rem;font-weight:500">Canonical</label>' +
        '<span class="aw-combo aw-combo-dim">' +
          '<input type="text" id="f-alias-canonical" autocomplete="off" placeholder="e.g. Fortinet">' +
          '<div class="aw-suggest" id="alias-canonical-suggest"></div>' +
        '</span>' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-add-alias">Add</button>' +
    '</div>' +
  '</div>';

  // Right: IEEE OUI Database
  html += '<div>' +
    '<h5 class="mac-id-section-heading">IEEE OUI Database</h5>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'Maps MAC address prefixes to hardware manufacturers. ' +
      'Refreshed automatically every week; aliases and overrides layer on top.' +
    '</p>' +
    '<div id="oui-status" class="db-info-grid" style="margin-bottom:1rem">' +
      '<div class="db-info-label">Status</div><div class="db-info-value" id="oui-status-loaded">Loading...</div>' +
      '<div class="db-info-label">Entries</div><div class="db-info-value" id="oui-status-entries">-</div>' +
      '<div class="db-info-label">Last Refreshed</div><div class="db-info-value" id="oui-status-refreshed">-</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-secondary" id="btn-oui-refresh">Refresh Now</button>' +
      '<span id="oui-refresh-status" style="font-size:0.82rem;margin-left:8px"></span>' +
    '</div>' +
    '<div style="margin-top:1rem;padding-top:1rem;border-top:1px solid var(--color-border)">' +
      '<label style="display:block;font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
        'OUI Query — look up a MAC address or 3-byte prefix' +
      '</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="text" id="f-oui-query" placeholder="AA:BB:CC or AA:BB:CC:DD:EE:FF" ' +
          'style="font-family:var(--font-mono);font-size:0.85rem;flex:1">' +
        '<button class="btn btn-secondary" id="btn-oui-query">Look Up</button>' +
      '</div>' +
      '<div id="oui-query-result" style="margin-top:0.75rem;font-size:0.85rem"></div>' +
    '</div>' +
  '</div>';

  html += '</div>'; // end mac-id-two-col
  html += '</div>'; // end settings-card

  // MIB Database + Manufacturer Profiles cards moved to the Credentials tab
  // so the credential, MIB-source, and per-vendor probe configuration all
  // live together. See renderCredentialsTab().

  // ── 4b. Device Icons ──
  html += deviceIconsCardHTML();

  // ── 4c. Device Types ──
  html += deviceTypesCardHTML();

  // ── 5. Tags (bottom) ──
  // Group tags by category
  var categories = {};
  _tagsData.forEach(function (t) {
    var cat = t.category || "General";
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(t);
  });
  _emptyCategories.forEach(function (cat) {
    if (!categories[cat]) categories[cat] = [];
  });
  var catNames = Object.keys(categories).sort();
  // GET /assets/by-tag is gated assets:read, which this tab does not imply.
  var canOpenTagAssets = typeof permAtLeast === "function" && permAtLeast("assets", "read");
  // Writes to the registry are the Tags key's; a caller here without it
  // (Server Settings read) sees the registry and no verbs.
  var canEditRegistry = typeof canManageTags !== "function" || canManageTags();

  html +=
    '<div class="settings-card">' +
      '<h4>Tags</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Define tags used to classify assets, networks, and blocks. Tags can be organized by category for easier filtering.' +
      '</p>' +
      '<div class="form-group" style="margin-bottom:1rem">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
          '<input type="checkbox" id="f-enforce-tags"' + (_tagSettings.enforce ? ' checked' : '') + (canEditRegistry ? '' : ' disabled') + '>' +
          '<span>Force predefined tags</span>' +
        '</label>' +
        '<p class="hint">When enabled, users can only select from predefined tags when creating or editing networks and assets. Free-text tag entry will be disabled.</p>' +
      '</div>' +
      (canEditRegistry
        ? '<div style="display:flex;gap:8px;margin-bottom:1rem">' +
            '<button class="btn btn-primary" id="btn-add-tag">+ Add Tag</button>' +
          '</div>'
        : '<p class="hint" style="margin-bottom:1rem">Adding, editing and assigning tags needs Read-Write on Tags.</p>');

  if (_tagsData.length === 0 && _emptyCategories.length === 0) {
    html += '<p class="empty-state">No tags defined yet. Add one to get started.</p>';
  } else {
    catNames.forEach(function (cat) {
      var tags = categories[cat];
      var isEmpty = tags.length === 0;
      html += '<div class="tag-category-section">' +
        '<div class="tag-category-header">' +
          '<h5 style="font-size:0.82rem;color:var(--color-text-tertiary);text-transform:uppercase;letter-spacing:0.05em;margin:0">' + escapeHtml(cat) + '</h5>' +
          (isEmpty && isAdmin()
            ? '<button class="tag-category-remove" data-cat="' + escapeHtml(cat) + '" title="Remove empty category">&times;</button>'
            : '') +
        '</div>';
      if (isEmpty) {
        html += '<p style="font-size:0.82rem;color:var(--color-text-tertiary);font-style:italic;margin:0.25rem 0 0">No tags — category will be removed on save</p>';
      } else {
        html += '<div class="tag-chip-list">';
          // ONE chip renderer: _tagRegistryChipHTML (azure: rows read-only, the
          // Tags key gates the verbs, built-ins keep Delete off, and the chip
          // opens the assets slide-in). A merge on 2026-10-16 put an inline
          // copy back here that had none of that; tagRegistryChipDom.test.ts
          // now fails if the markup is ever written twice again.
          tags.forEach(function (t) { html += _tagRegistryChipHTML(t, canOpenTagAssets); });
        html += '</div>';
      }
      html += '</div>';
    });
  }

  if (_emptyCategories.length > 0) {
    html += '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:1rem;font-style:italic">' +
      'Empty categories are shown until dismissed. Click the &times; next to an empty category to remove it.' +
    '</p>';
  }

  html += '</div>';

  // ── Set HTML and wire events ──
  container.innerHTML = html;

  wireDnsControls();
  loadOuiStatus();
  // MIB + manufacturer-profile wiring lives on the Credentials tab now.
  wireDeviceIconHandlers();
  wireDeviceTypeHandlers();

  // Placeholder MAC prefix
  var phBtn = document.getElementById("btn-save-placeholder-mac");
  if (phBtn) phBtn.addEventListener("click", savePlaceholderMacPrefix);

  // OUI override events
  document.getElementById("btn-add-oui-override").addEventListener("click", addOuiOverride);
  // The device-count manufacturer pickers (same as MIB upload / Device Icons).
  // The alias's input side lists the inventory too: a device whose name hasn't
  // been aliased yet shows up there under the spelling it reports.
  _wireManufacturerCountCombo("f-oui-manufacturer", "oui-mfr-suggest", _knownManufacturerRows);
  _wireManufacturerCountCombo("f-alias-input", "alias-input-suggest", _knownManufacturerRows);
  _wireManufacturerCountCombo("f-alias-canonical", "alias-canonical-suggest", _knownManufacturerRows);
  container.querySelectorAll(".oui-override-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      deleteOuiOverrideUI(btn.getAttribute("data-prefix"));
    });
  });

  // OUI database refresh
  document.getElementById("btn-oui-refresh").addEventListener("click", refreshOuiDatabase);

  // OUI query
  document.getElementById("btn-oui-query").addEventListener("click", runOuiQuery);
  document.getElementById("f-oui-query").addEventListener("keydown", function (e) {
    if (e.key === "Enter") { e.preventDefault(); runOuiQuery(); }
  });

  // Manufacturer alias events
  wireManufacturerAliasControls();

  // Tags events
  var addTagBtn = document.getElementById("btn-add-tag");   // withheld without Tags write
  if (addTagBtn) addTagBtn.addEventListener("click", openAddTagModal);

  container.querySelectorAll(".tag-chip-edit").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      openEditTagModal(btn.getAttribute("data-tag-id"));
    });
  });

  container.querySelectorAll(".tag-chip-delete").forEach(function (btn) {
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      deleteTag(btn.getAttribute("data-tag-id"));
    });
  });

  container.querySelectorAll(".tag-chip-open").forEach(function (chip) {
    var open = function () { openTagAssetsPanel(chip.getAttribute("data-tag-name")); };
    chip.addEventListener("click", open);
    chip.addEventListener("keydown", function (e) {
      if (e.target !== chip) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });

  container.querySelectorAll(".tag-category-remove").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var cat = btn.getAttribute("data-cat");
      _emptyCategories = _emptyCategories.filter(function (c) { return c !== cat; });
      renderIdentificationTab();
    });
  });

  document.getElementById("f-enforce-tags").addEventListener("change", async function () {
    var cb = this;
    var newVal = cb.checked;
    cb.disabled = true;
    try {
      await api.serverSettings.updateTagSettings({ enforce: newVal });
      _tagSettings.enforce = newVal;
      if (typeof _tagCache !== "undefined") _tagCache.loaded = false;
      showToast(newVal ? "Predefined tags enforced" : "Free-text tags enabled");
    } catch (err) {
      cb.checked = !newVal;
      showToast(err.message, "error");
    } finally {
      cb.disabled = false;
    }
  });

  // Re-render the Credentials tab too — the MIB Database and Manufacturer
  // Profiles cards live there now, and many pre-existing handlers still call
  // renderIdentificationTab() after a mutation. This keeps both surfaces in
  // sync without touching every callsite.
  _maybeRerenderCredentialsTabForMibOrProfile();
}

// Save the placeholder MAC prefix. The confirm is the load-bearing part: a
// prefix change silently changes which existing reservations discovery is
// allowed to overwrite, in both directions, and nothing else in the UI would
// tell the operator that.
async function savePlaceholderMacPrefix() {
  var input = document.getElementById("f-placeholder-mac-prefix");
  if (!input) return;
  var prefix = input.value.trim();
  var current = (_placeholderMac && _placeholderMac.prefix) || "";
  if (!prefix) { showToast("Enter a prefix", "error"); return; }
  if (prefix.toUpperCase() === current.toUpperCase()) { showToast("Prefix unchanged"); return; }

  var ok = await showConfirm(
    "Change the placeholder MAC prefix from " + current + " to " + prefix + "?\n\n"
      + "Reservations still carrying " + current + " will no longer be adopted by discovery, and any "
      + "reservation whose MAC happens to match " + prefix + " becomes adoptable immediately.\n\n"
      + "This does not change any existing reservation by itself.",
  );
  if (!ok) return;

  try {
    _placeholderMac = await api.serverSettings.setPlaceholderMac({ prefix: prefix });
    showToast("Placeholder MAC prefix saved");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function addOuiOverride() {
  var prefix = document.getElementById("f-oui-prefix").value.trim();
  var manufacturer = document.getElementById("f-oui-manufacturer").value.trim();
  var device = document.getElementById("f-oui-device").value.trim();
  if (!prefix || !manufacturer) { showToast("Both MAC prefix and manufacturer are required", "error"); return; }
  try {
    var body = { prefix: prefix, manufacturer: manufacturer };
    if (device) body.device = device;
    var result = await api.serverSettings.addOuiOverride(body);
    // Update local cache
    var idx = _ouiOverrides.findIndex(function (o) { return o.prefix === result.prefix; });
    if (idx >= 0) _ouiOverrides[idx] = result;
    else _ouiOverrides.push(result);
    _ouiOverrides.sort(function (a, b) { return a.prefix.localeCompare(b.prefix); });
    var msg = "OUI override added: " + result.prefix + " → " + result.manufacturer;
    if (result.device) msg += " / " + result.device;
    if (result.assetsUpdated > 0) msg += " (" + result.assetsUpdated + " asset" + (result.assetsUpdated === 1 ? "" : "s") + " updated)";
    showToast(msg, "success");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function deleteOuiOverrideUI(prefix) {
  var ok = await showConfirm('Remove OUI override for "' + prefix + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteOuiOverride(prefix);
    _ouiOverrides = _ouiOverrides.filter(function (o) { return o.prefix !== prefix; });
    showToast("Override removed");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Device Icons ──────────────────────────────────────────────────────────
//
// Operator-uploaded images that override generic node shapes on the Device
// Map's topology graph. Resolution at render time is most-specific-wins:
// manufacturer + model → manufacturer + assetType; both need a manufacturer
// (deviceIconService.buildResolutionCandidates). Storage is bytes-in-DB
// behind the /api/v1/device-icons endpoints; admin-only CRUD; image-serve
// is auth-only with HTTP cache headers so the topology modal doesn't refetch
// on every render.

var _deviceIconAssetTypes = [
  "firewall", "switch", "access_point", "router",
  "server", "workstation", "printer", "hypervisor", "container", "other",
];

// ─── Device Types ──────────────────────────────────────────────────────────
//
// The AssetTypeDef registry, plus the inference rules that decide which
// discovery-time facts land a device in each bucket. Two halves, because a
// device's type comes from two different kinds of place: an authoritative
// source that STATES it (a FortiGate's controller, vCenter's inventory), and
// a guess off a text field. Only the second is editable, and the card says so
// rather than leaving an operator to discover it by writing a rule that never
// fires.

// Fallback vocabulary. The live one is server-published on
// GET /asset-types/match-schema as `condition`, in the SAME shape
// scopeConditionMeta hands the automations device filter — this only covers a
// payload that hasn't arrived yet.
var _DT_FIELD_LABELS = {
  any: "Any field",
  os: "OS",
  osVersion: "OS version",
  hostname: "Hostname",
  manufacturer: "Manufacturer",
  model: "Model",
  chassis: "Chassis (Entra / Intune)",
};
var _DT_OP_LABELS = {
  contains: "contains",
  notContains: "does not contain",
  equals: "is equal to",
  notEquals: "is not equal to",
  startsWith: "starts with",
  notStartsWith: "does not start with",
  endsWith: "ends with",
  notEndsWith: "does not end with",
  regex: "matches regex",
  notRegex: "does not match regex",
  // Pre-2026-09 spellings. The API folds these forward on read, so they only
  // reach here from a stale payload.
  starts_with: "starts with",
  ends_with: "ends with",
};
var _DT_GROUP_OP_PROSE = {
  and: "all of",
  or: "any of",
  none: "none of",
  notAll: "not all of",
};
var _DT_CONTEXT_LABELS = {
  directory: "Directory discovery (AD / Entra / Intune / Azure Arc)",
  scan: "Network Discovery scans",
};
var _DT_CONTEXT_SHORT = { directory: "Directory", scan: "Scans" };

function _dtLabelFor(name) {
  var t = (_assetTypes || []).find(function (x) { return x.name === name; });
  return t ? t.label : name;
}

/**
 * The condition-builder vocabulary. Server-published (`/match-schema` →
 * `condition`) in the shape `scopeConditionMeta` returns for the automations
 * device filter, so the shared PolarisConditionBuilder takes it unchanged and
 * this page holds no field or operator list of its own.
 */
function _dtConditionMeta() {
  var pub = _assetTypeMatchSchema && _assetTypeMatchSchema.condition;
  if (pub && pub.fields && pub.fields.length) return pub;
  // Pre-upgrade payload: rebuild the catalog from the fallback label maps.
  var fields = (_assetTypeMatchSchema && _assetTypeMatchSchema.fields) || Object.keys(_DT_FIELD_LABELS);
  var ops = (_assetTypeMatchSchema && _assetTypeMatchSchema.ops) || Object.keys(_DT_OP_LABELS);
  return {
    groupOps: ["and", "or", "none", "notAll"],
    groupOpLabels: {
      and: "All child conditions must be satisfied (AND)",
      or: "At least one child condition must be satisfied (OR)",
      none: "All child conditions must NOT be satisfied",
      notAll: "At least one child condition must NOT be satisfied",
    },
    operatorLabels: _DT_OP_LABELS,
    fields: fields.map(function (f) {
      return { field: f, label: _DT_FIELD_LABELS[f] || f, ops: ops };
    }),
    maxDepth: 5,
    maxRules: 64,
  };
}

function _dtFieldLabel(field) {
  var fm = (_dtConditionMeta().fields || []).find(function (f) { return f.field === field; });
  return (fm && fm.label) || _DT_FIELD_LABELS[field] || field;
}
function _dtOpLabel(op) {
  return (_dtConditionMeta().operatorLabels || {})[op] || _DT_OP_LABELS[op] || op;
}

/**
 * A type's rules as a condition TREE, whatever shape the payload carried.
 *
 * The API folds the pre-2026-09 flat list forward on read (`{clauses:[…]}`, an
 * ANY-of, with the leaf operator under `op` and negation on a `negate` flag),
 * so this only ever fires on a stale or hand-built payload — but the card must
 * never render a legacy row as "Assigned only", which is what reading
 * `.children` off it would do, and the editor must never open one with an
 * empty builder, which is how saving would delete a built-in's matching.
 *
 * Mirrors `normalizeMatchRules` in src/utils/assetTypeMatch.ts.
 */
function _dtRulesTree(raw) {
  if (!raw || typeof raw !== "object") return null;
  var NEG = { equals: "notEquals", contains: "notContains", startsWith: "notStartsWith",
    endsWith: "notEndsWith", regex: "notRegex", starts_with: "notStartsWith", ends_with: "notEndsWith" };
  var ALIAS = { starts_with: "startsWith", ends_with: "endsWith" };
  var leaf = function (c) {
    var stated = c.operator || c.op;
    return {
      field: c.field,
      operator: c.negate ? (NEG[stated] || stated) : (ALIAS[stated] || stated),
      value: c.value,
    };
  };
  if (Array.isArray(raw.clauses)) {
    return { op: "or", children: raw.clauses.map(leaf) };
  }
  if (!Array.isArray(raw.children)) return null;
  var walk = function (g) {
    return {
      op: g.op,
      children: (g.children || []).map(function (c) {
        return Array.isArray(c && c.children) ? walk(c) : leaf(c);
      }),
    };
  };
  return walk(raw);
}

/** Every leaf in a tree, in walk order. */
function _dtLeaves(tree) {
  var out = [];
  var walk = function (g) {
    (g.children || []).forEach(function (c) {
      if (Array.isArray(c && c.children)) walk(c);
      else out.push(c);
    });
  };
  if (tree) walk(tree);
  return out;
}

/** One leaf as prose, using the server's own field + operator wording. */
function _dtClauseProse(c) {
  return _dtFieldLabel(c.field) + " " + _dtOpLabel(c.operator || c.op) + ' "' + c.value + '"';
}

/** One-line summary of a type's matching, for the table's Matching column. */
function _dtMatchSummary(t) {
  var tree = _dtRulesTree(t.matchRules);
  var leaves = _dtLeaves(tree);
  var contexts = t.matchContexts || [];
  if (!leaves.length || !contexts.length) {
    return '<span style="color:var(--color-text-tertiary)">Assigned only</span>';
  }
  var where = contexts.map(function (c) { return _DT_CONTEXT_SHORT[c] || c; }).join(" + ");
  // The root operator is named only when there is more than one condition for
  // it to combine — on a single leaf it would read as noise, and on the very
  // common one-leaf OR it would be actively misleading.
  var lead = (leaves.length > 1 ? (_DT_GROUP_OP_PROSE[tree.op] || tree.op) + ": " : "") +
    _dtClauseProse(leaves[0]);
  var more = leaves.length > 1
    ? ' <span style="color:var(--color-text-tertiary)">+' + (leaves.length - 1) + " more</span>"
    : "";
  return '<span style="color:var(--color-text-tertiary)">' + escapeHtml(where) + ':</span> ' +
    escapeHtml(lead) + more;
}

function deviceTypesCardHTML() {
  var types = (_assetTypes || []).slice().sort(function (a, b) {
    // Built-ins first (they are the buckets code branches on), then by the
    // order the resolver actually walks, so the table reads as the ladder.
    if (a.isBuiltIn !== b.isBuiltIn) return a.isBuiltIn ? -1 : 1;
    if ((a.matchPriority || 0) !== (b.matchPriority || 0)) return (a.matchPriority || 0) - (b.matchPriority || 0);
    return (a.label || "").localeCompare(b.label || "");
  });

  var html = '<div class="settings-card">' +
    '<h4>Device Types</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'The buckets every asset is filed under, and the rules that decide which one a newly discovered device lands in. ' +
      'Built-in types cannot be renamed or removed — dashboards, filters and monitoring behaviour key on their names — but ' +
      'their <strong>matching rules are yours to edit</strong>, and you can add types of your own.' +
    '</p>' +
    '<div style="display:flex;gap:8px;margin-bottom:1rem;flex-wrap:wrap">' +
      '<button class="btn btn-primary" id="btn-add-device-type">+ Add Type</button>' +
      '<button class="btn btn-secondary" id="btn-dt-apply-rules">Apply rules to existing “Other” assets…</button>' +
    '</div>';

  if (!types.length) {
    html += '<p class="empty-state">No device types loaded.</p>';
  } else {
    html += '<div class="table-wrapper" style="overflow-x:auto">' +
      '<table class="data-table"><thead><tr>' +
        '<th>Type</th><th>Name</th><th>Matching</th>' +
        '<th style="text-align:right">Assets</th><th style="width:96px"></th>' +
      '</tr></thead><tbody>';
    types.forEach(function (t) {
      html += '<tr>' +
        '<td><strong>' + escapeHtml(t.label) + '</strong>' +
          (t.isBuiltIn
            ? ' <span style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:1px 5px;margin-left:4px;vertical-align:middle"' +
              ' title="Shipped with Polaris; name and label are fixed">built-in</span>'
            : '') +
          (t.description ? '<div style="font-size:0.76rem;color:var(--color-text-tertiary);margin-top:2px">' + escapeHtml(t.description) + '</div>' : '') +
        '</td>' +
        '<td><code style="font-size:0.78rem">' + escapeHtml(t.name) + '</code></td>' +
        '<td style="font-size:0.8rem">' + _dtMatchSummary(t) + '</td>' +
        '<td style="text-align:right">' + (t.usageCount != null ? t.usageCount : "—") + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn-icon device-type-edit" data-id="' + escapeHtml(t.id) + '" title="Edit">&#9998;</button>' +
          (t.isProtected
            ? ''
            : '<button class="btn-icon device-type-delete" data-id="' + escapeHtml(t.id) + '" title="Delete">&times;</button>') +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
  }

  // ── The half rules cannot reach ──
  // Rendered from the server's own catalogue (GET /asset-types/match-schema)
  // rather than a copy here, so it cannot quietly stop describing the code.
  var sources = _assetTypeMatchSchema.authoritativeSources || [];
  if (sources.length) {
    html += '<details style="margin-top:1.25rem">' +
      '<summary style="cursor:pointer;font-size:0.85rem;font-weight:600">How a device gets its type</summary>' +
      '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin-top:0.75rem;line-height:1.55">' +
        '<p style="margin:0 0 0.75rem">Polaris takes the first answer it can get, in this order:</p>' +
        '<ol style="margin:0 0 1rem;padding-left:1.25rem">';
    sources.forEach(function (s) {
      html += '<li style="margin-bottom:0.5rem"><strong>' + escapeHtml(s.source) + '</strong>' +
        (s.assigns && s.assigns.length
          ? ' → ' + s.assigns.map(function (n) {
              return '<code style="font-size:0.76rem">' + escapeHtml(_dtLabelFor(n)) + '</code>';
            }).join(", ")
          : '') +
        '<div style="color:var(--color-text-tertiary)">' + escapeHtml(s.reason) + '</div></li>';
    });
    html += '</ol>' +
      '<p style="margin:0 0 0.75rem"><strong>Then the matching rules above</strong>, walked in priority order — ' +
      'the first type whose rules claim the device wins. Rules run in two separate places, and each type ' +
      'declares which of them it takes part in:</p>' +
      '<ul style="margin:0 0 1rem;padding-left:1.25rem">' +
        '<li><strong>Directory discovery</strong> reads a directory record’s OS string. Out of the box only ' +
        '<em>Server</em> and <em>Workstation</em> run here.</li>' +
        '<li><strong>Network Discovery scans</strong> read a scanned device’s own self-description. Out of the box ' +
        '<em>Firewall</em>, <em>Switch</em>, <em>Access Point</em>, <em>Router</em> and <em>Printer</em> run here.</li>' +
      '</ul>' +
      '<p style="margin:0"><strong>Otherwise the device lands in “Other.”</strong> ' +
      'Editing a rule changes what discovery does the next time it sees a device — it does not re-type anything ' +
      'already in inventory. Use <em>Apply rules to existing “Other” assets</em> for that; it only ever moves ' +
      'assets <em>out of</em> “Other”, so a type you set by hand is never overwritten.</p>' +
    '</div></details>';
  }

  html += '</div>';
  return html;
}

function wireDeviceTypeHandlers() {
  var addBtn = document.getElementById("btn-add-device-type");
  if (addBtn) addBtn.addEventListener("click", function () { openDeviceTypeModal(null); });

  var applyBtn = document.getElementById("btn-dt-apply-rules");
  if (applyBtn) applyBtn.addEventListener("click", openDeviceTypeApplyModal);

  document.querySelectorAll(".device-type-edit").forEach(function (btn) {
    btn.addEventListener("click", function () {
      openDeviceTypeModal(btn.getAttribute("data-id"));
    });
  });
  document.querySelectorAll(".device-type-delete").forEach(function (btn) {
    btn.addEventListener("click", function () {
      deleteDeviceTypeUI(btn.getAttribute("data-id"));
    });
  });
}

async function deleteDeviceTypeUI(id) {
  var t = (_assetTypes || []).find(function (x) { return x.id === id; });
  if (!t) return;
  var ok = await showConfirm(
    'Delete device type "' + t.label + '"?' +
    (t.usageCount ? " " + t.usageCount + " asset(s) still use it — the delete will be refused." : ""),
  );
  if (!ok) return;
  try {
    await api.assetTypes.delete(id);
    showToast("Device type deleted", "success");
    await loadIdentificationTab();
  } catch (err) {
    showToast(err.message || "Failed to delete device type", "error");
  }
}

// ─── Editor ────────────────────────────────────────────────────────────────
//
// The conditions are edited in the shared PolarisConditionBuilder — the same
// nested AND/OR widget, the same group operators and the same stored tree
// shape as the automations device filter, the address book and tag
// auto-assign. It was a flat clause list with a "not" checkbox until 2026-09;
// two condition dialects that look alike and behave differently was the whole
// problem, and this one now differs only where it has to (its own field
// vocabulary of discovery-time FACTS, and negation on the leaf so an absent
// fact can't satisfy it).

/** The tree the editor opens with. A new type starts as an OR — a list of
 *  alternatives is what type matching almost always is, and it is the shape
 *  every built-in ships with. */
function _dtEditorTree(t) {
  var stored = _dtRulesTree(t && t.matchRules);
  return stored && (stored.children || []).length ? stored : { op: "or", children: [] };
}

/**
 * Prune a collected tree the way the server's `normalizeMatchRules` does: a
 * valueless row is dropped, a group left with nothing is dropped, and a root
 * with nothing left becomes null.
 *
 * Pruning rather than refusing is this surface's existing contract — "+
 * Condition" renders an empty row, and an operator who adds one and thinks
 * better of it must not have to remove it before saving. Doing it here rather
 * than leaving it to the server means the payload matches what will actually
 * be stored, so the preview and the saved row can't differ.
 */
function _dtPruneTree(group) {
  var children = [];
  (group.children || []).forEach(function (c) {
    if (Array.isArray(c && c.children)) {
      var kept = _dtPruneTree(c);
      if (kept) children.push(kept);
    } else if (c && String(c.value || "").trim()) {
      children.push({ field: c.field, operator: c.operator, value: String(c.value).trim() });
    }
  });
  return children.length ? { op: group.op, children: children } : null;
}

/**
 * Read the editor form back into the payload shape the API expects.
 *
 * An empty tree posts `matchRules: null`, never the empty group: `and([])` is
 * true by identity, so shipping it would ask the server to claim the whole
 * fleet for this type. Null is the shape that means "only ever assigned".
 */
function _dtReadForm(builder) {
  var rootGroup = document.querySelector("#dt-cond-root > .scg-group");
  var collected = rootGroup && builder ? builder.collect(rootGroup) : null;
  var tree = collected ? _dtPruneTree(collected) : null;
  var contexts = [];
  document.querySelectorAll("#dt-context-list input[type=checkbox]").forEach(function (cb) {
    if (cb.checked) contexts.push(cb.getAttribute("data-ctx"));
  });
  var priorityRaw = parseInt(document.getElementById("f-dt-priority").value, 10);
  return {
    label: (document.getElementById("f-dt-label").value || "").trim(),
    name: (document.getElementById("f-dt-name").value || "").trim().toLowerCase(),
    description: (document.getElementById("f-dt-description").value || "").trim(),
    matchRules: tree,
    matchContexts: contexts,
    matchPriority: isNaN(priorityRaw) ? 100 : priorityRaw,
  };
}

function openDeviceTypeModal(id) {
  var t = id ? (_assetTypes || []).find(function (x) { return x.id === id; }) : null;
  var isNew = !t;
  var locked = !!(t && t.isProtected);
  var contexts = (t && t.matchContexts) || [];
  var ctxList = _assetTypeMatchSchema.contexts || ["directory", "scan"];

  // The vocabulary is already on the page (loadIdentificationTab fetches
  // /match-schema alongside the registry), so the builder can be created
  // synchronously — unlike the tag modals, which have to await their own
  // schema before they can assemble a body.
  var condBuilder = window.PolarisConditionBuilder.create({
    meta: _dtConditionMeta(),
    // No suggestions: these are facts about a device that may have no Asset
    // row yet, so there is no inventory to offer values from. Free text only.
    valueOptions: function () { return []; },
    onChange: function () {},
  });

  var body =
    '<div class="form-group"><label>Label *</label>' +
      '<input type="text" id="f-dt-label" value="' + escapeHtml(t ? t.label : "") + '"' + (locked ? " disabled" : "") + ' placeholder="Rack PDU">' +
      '<div class="hint">What operators see in lists, filters and charts.</div>' +
    '</div>' +
    '<div class="form-group"><label>Name *</label>' +
      '<input type="text" id="f-dt-name" value="' + escapeHtml(t ? t.name : "") + '"' + (locked ? " disabled" : "") + ' placeholder="rack_pdu">' +
      '<div class="hint">' +
        (locked
          ? 'Built-in. Monitoring, topology and dashboard behaviour key on this name, so it is fixed.'
          : (isNew
            ? 'Lowercase letters, digits, dash and underscore. Stored on every asset of this type — renaming later rewrites them all.'
            : 'Renaming rewrites every asset currently using this type, in one transaction.')) +
      '</div>' +
    '</div>' +
    '<div class="form-group"><label>Description</label>' +
      '<textarea id="f-dt-description" rows="2"' + (locked ? " disabled" : "") + '>' + escapeHtml((t && t.description) || "") + '</textarea>' +
    '</div>';

  if (locked) {
    body += infoBox(
      'This is a <strong>built-in</strong> type, so its name and label are fixed — but the matching below is ' +
      'yours. Editing it changes which devices Polaris files here.',
    );
  }

  body += formDivider() + sectionHeading("Matching rules");

  body +=
    '<p style="font-size:0.8rem;color:var(--color-text-secondary);margin:0 0 0.75rem">' +
      'A device is filed here when the conditions below are satisfied — the same nested ' +
      'AND/OR builder the automations device filter uses. Leave it empty and this type is only ever ' +
      'assigned by an authoritative discovery source or by hand.' +
    '</p>' +
    '<p style="font-size:0.8rem;color:var(--color-text-secondary);margin:0 0 0.75rem">' +
      'One difference from a device filter, because these run before a device is in inventory: a device that ' +
      'reported <strong>nothing</strong> for a field never matches a condition on it, ' +
      '<em>including a negative one</em>. At discovery time a missing fact means “not known yet”, not “empty”.' +
    '</p>';

  body += '<div class="form-group"><label>Applies to</label><div id="dt-context-list">';
  ctxList.forEach(function (c) {
    body += '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin-bottom:4px">' +
      '<input type="checkbox" data-ctx="' + escapeHtml(c) + '"' + (contexts.indexOf(c) >= 0 ? " checked" : "") + '>' +
      '<span style="font-size:0.85rem">' + escapeHtml(_DT_CONTEXT_LABELS[c] || c) + '</span>' +
    '</label>';
  });
  body += '</div><div class="hint">Where these rules run. A rule set with nothing ticked never fires.</div></div>';

  body += '<div class="form-group" id="dt-cond-body"><label>Conditions</label>' +
    '<p class="hint" style="margin:0 0 8px">Drag the <span class="aw-grip" style="cursor:default">&#x2842;</span> handle to ' +
      'move a condition into another group or reorder groups.</p>' +
    '<div id="dt-cond-root">' + condBuilder.groupHtml(_dtEditorTree(t), 0) + '</div>' +
  '</div>';

  body += '<div class="form-group"><label>Priority</label>' +
    '<input type="number" id="f-dt-priority" min="0" max="1000" style="max-width:120px" value="' +
      escapeHtml(String(t && t.matchPriority != null ? t.matchPriority : 100)) + '">' +
    '<div class="hint">Lower wins. When two types both claim a device, the smaller number decides ' +
      '(Firewall 10 → Switch 12 → Access Point 14 → Router 16 → Printer 18 → Server 20 → Workstation 30).</div>' +
  '</div>';

  body += '<div id="dt-preview-out" style="margin-top:0.5rem"></div>';

  var footer =
    '<button class="btn btn-secondary" id="btn-dt-preview">Preview matches</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-dt-save">' + (isNew ? "Create Type" : "Save Changes") + '</button>';

  openModal(isNew ? "Add Device Type" : "Edit Device Type — " + t.label, body, footer, { wide: true });

  // Rows, groups and the grip drag all live in the shared module. Bind to the
  // section, NEVER to #modal-overlay: openModal reuses one persistent overlay
  // element, so a listener there would outlive the dialog and stack up per
  // open (see the same note on _wireTagFilterBuilder).
  var condBody = document.getElementById("dt-cond-body");
  condBuilder.wire(condBody, "#dt-cond-root");
  // A new type opens on an empty root — seed one row so it lands editable.
  condBuilder.seedIfEmpty(document.getElementById("dt-cond-root"));

  // Auto-fill the machine name from the label while it is still untouched, so
  // the common case is one field, not two.
  if (isNew) {
    var nameEl = document.getElementById("f-dt-name");
    var nameTouched = false;
    nameEl.addEventListener("input", function () { nameTouched = true; });
    document.getElementById("f-dt-label").addEventListener("input", function () {
      if (nameTouched) return;
      nameEl.value = this.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
    });
  }

  document.getElementById("btn-dt-preview").addEventListener("click", async function () {
    var btn = this;
    var out = document.getElementById("dt-preview-out");
    var form = _dtReadForm(condBuilder);
    if (!form.name) { showToast("Give the type a name before previewing", "error"); return; }
    btn.disabled = true;
    out.innerHTML = '<p class="empty-state" style="margin:0">Checking…</p>';
    try {
      // Preview the DRAFT, not the stored row — the point is to see what the
      // edit on screen would do before committing it.
      var res = await api.assetTypes.matchPreview({
        name: form.name,
        matchRules: form.matchRules,
        matchContexts: form.matchContexts,
        matchPriority: form.matchPriority,
      });
      out.innerHTML = _dtPreviewHTML(res, form.name);
    } catch (err) {
      out.innerHTML = '<p style="color:var(--color-danger);font-size:0.82rem;margin:0">' +
        escapeHtml(err.message || "Preview failed") + '</p>';
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("btn-dt-save").addEventListener("click", async function () {
    var btn = this;
    var form = _dtReadForm(condBuilder);
    if (!locked && !form.label) { showToast("Label is required", "error"); return; }
    if (isNew && !form.name) { showToast("Name is required", "error"); return; }
    // No builder.validate() call: _dtPruneTree has already removed the two
    // things it would report (a valueless row, an empty group), and the only
    // other rule it carries — the CIDR shape check — belongs to a field this
    // vocabulary does not have.
    if (form.matchRules && !form.matchContexts.length) {
      showToast('Tick at least one "Applies to" box, or the rules will never run', "error");
      return;
    }
    btn.disabled = true;
    try {
      var payload = {
        matchRules: form.matchRules,
        matchContexts: form.matchContexts,
        matchPriority: form.matchPriority,
      };
      // A protected row rejects identity edits outright, so don't send fields
      // the form rendered disabled — an unchanged value would still read as an
      // attempted edit if the server compared loosely.
      if (!locked) {
        payload.label = form.label;
        payload.description = form.description || null;
      }
      if (isNew) {
        payload.name = form.name;
        await api.assetTypes.create(payload);
        showToast("Device type created", "success");
      } else {
        if (!locked && form.name && form.name !== t.name) payload.name = form.name;
        await api.assetTypes.update(t.id, payload);
        showToast("Device type saved", "success");
      }
      closeModal();
      await loadIdentificationTab();
    } catch (err) {
      showToast(err.message || "Failed to save device type", "error");
      btn.disabled = false;
    }
  });
}

/** Render a preview result. Shared by the editor and the apply dialog. */
function _dtPreviewHTML(res, onlyType) {
  if (!res.examined) {
    return '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0">' +
      'No assets are currently filed under “Other”, so there is nothing for a rule to reclaim.</p>';
  }
  var rows = (res.sample || []).filter(function (r) {
    return !onlyType || r.matchedType === onlyType;
  });
  var mine = onlyType
    ? (res.byType || []).filter(function (b) { return b.type === onlyType; })
    : (res.byType || []);
  var total = mine.reduce(function (sum, b) { return sum + b.count; }, 0);

  if (!total) {
    return '<p style="font-size:0.82rem;color:var(--color-text-tertiary);margin:0">' +
      'Matches <strong>0</strong> of the ' + res.examined + ' asset(s) currently filed under “Other”.</p>';
  }

  var html = '<p style="font-size:0.82rem;margin:0 0 0.5rem">Matches <strong>' + total + '</strong> of the ' +
    res.examined + ' asset(s) currently filed under “Other”' +
    (onlyType ? '' : ': ' + mine.map(function (b) {
      return escapeHtml(_dtLabelFor(b.type)) + " " + b.count;
    }).join(", ")) + '.</p>';

  if (rows.length) {
    html += '<div class="table-wrapper" style="max-height:240px;overflow:auto">' +
      '<table class="data-table"><thead><tr><th>Hostname</th><th>OS</th>' +
      (onlyType ? '' : '<th>Would become</th>') + '<th>Matched on</th></tr></thead><tbody>';
    rows.slice(0, 25).forEach(function (r) {
      var c = r.matchedClause;
      html += '<tr>' +
        '<td>' + escapeHtml(r.hostname || "—") + '</td>' +
        '<td style="font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(r.os || "—") + '</td>' +
        (onlyType ? '' : '<td>' + escapeHtml(_dtLabelFor(r.matchedType)) + '</td>') +
        // A tree under `none` / `notAll` has no leaf that can honestly be
        // called the reason (a leaf that tested TRUE there is what would have
        // PREVENTED the match), so the server sends null and this reads "—".
        '<td style="font-size:0.78rem;color:var(--color-text-tertiary)">' +
          (c ? escapeHtml(_dtClauseProse(c)) : "—") +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table></div>';
    if (total > rows.slice(0, 25).length) {
      html += '<p style="font-size:0.76rem;color:var(--color-text-tertiary);margin:0.35rem 0 0">' +
        'Showing the first ' + rows.slice(0, 25).length + '.</p>';
    }
  }
  return html;
}

/**
 * The retroactive half, as its own explicit step.
 *
 * Kept out of the editor's Save deliberately: a rule edit is cheap to undo, a
 * fleet-wide re-type is not, and an operator experimenting with a pattern
 * should not be moving inventory on every keystroke of trial and error.
 */
function openDeviceTypeApplyModal() {
  var body = '<p style="font-size:0.85rem;margin:0 0 0.75rem">' +
    'Re-file the assets currently sitting under <strong>“Other”</strong> using the saved matching rules.</p>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 1rem">' +
      'Only assets in “Other” are considered, so a type set by an authoritative discovery source — or by hand — ' +
      'is never overwritten. Nothing is moved back <em>into</em> “Other”.</p>' +
    '<div id="dt-apply-out"><p class="empty-state" style="margin:0">Checking…</p></div>';
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-dt-apply-confirm" disabled>Apply</button>';
  openModal("Apply Rules to Existing Assets", body, footer, { wide: true });

  var confirmBtn = document.getElementById("btn-dt-apply-confirm");
  api.assetTypes.matchPreview().then(function (res) {
    document.getElementById("dt-apply-out").innerHTML = _dtPreviewHTML(res, null);
    if (res.matched > 0) confirmBtn.disabled = false;
  }).catch(function (err) {
    document.getElementById("dt-apply-out").innerHTML =
      '<p style="color:var(--color-danger);font-size:0.82rem;margin:0">' + escapeHtml(err.message || "Preview failed") + '</p>';
  });

  confirmBtn.addEventListener("click", async function () {
    this.disabled = true;
    try {
      var res = await api.assetTypes.matchApply();
      showToast(res.updated ? "Re-typed " + res.updated + " asset(s)" : "Nothing to re-type", "success");
      closeModal();
      await loadIdentificationTab();
    } catch (err) {
      showToast(err.message || "Failed to apply rules", "error");
      this.disabled = false;
    }
  });
}

// Asset-type <option>s for the Device Icons upload form and its inline
// editor: every type in the asset-type REGISTRY (the Device Types card's list,
// custom types included) — the service validates against the same registry
// (isKnownAssetType). The built-in ten are only the fallback for a registry
// that failed to load. A stored type the registry no longer carries stays
// selectable, so opening the editor can't silently re-key the icon.
function _deviceIconTypeOptionsHTML(selected) {
  var registryTypes = (_assetTypes || []).slice().sort(function (a, b) {
    return (a.label || a.name || "").localeCompare(b.label || b.name || "");
  });
  var opts = registryTypes.length
    ? registryTypes.map(function (t) { return { value: t.name, label: t.label || t.name }; })
    : _deviceIconAssetTypes.map(function (t) { return { value: t, label: t }; });
  var known = false;
  var html = opts.map(function (o) {
    var sel = o.value === selected;
    if (sel) known = true;
    return '<option value="' + escapeHtml(o.value) + '"' + (sel ? " selected" : "") + '>' + escapeHtml(o.label) + '</option>';
  }).join("");
  if (selected && !known) {
    html += '<option value="' + escapeHtml(selected) + '" selected>' + escapeHtml(selected) + ' (unknown)</option>';
  }
  return html;
}

var _iconEditId = null; // the Device Icons row open in its inline editor

function deviceIconsCardHTML() {
  var byScope = { "manufacturer-type": [], "manufacturer-model": [] };
  _deviceIcons.forEach(function (i) {
    if (byScope[i.scope]) byScope[i.scope].push(i);
  });

  var typeOptionsHtml = _deviceIconTypeOptionsHTML("");

  var html = '<div class="settings-card">' +
    '<h4>Device Icons</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Upload PNG / JPEG / WebP images (max 256 KB) or SVG (max 32 KB, strict validation — no scripts, no external refs) to overlay vendor logos on the Device Map\'s topology graph. ' +
      'Every icon is keyed to a <strong>manufacturer</strong> plus either an asset <strong>type</strong> or a specific <strong>model</strong>. ' +
      'The manufacturer field accepts any value — the dropdown only suggests names already on file. ' +
      'On render: <strong>manufacturer + model</strong> exact match wins over the <strong>manufacturer + type</strong> fallback. The asset\'s status (Up/Missed/Down/Recovering) keeps coloring the ring around the logo so both signals stay visible.' +
    '</p>';

  // Upload form: manufacturer + scope (type|model) + type dropdown / model input + file
  html += '<div class="form-row" style="display:grid;grid-template-columns:1fr 140px 1fr 1fr auto;gap:8px;align-items:flex-end;margin-bottom:0.5rem">' +
    '<div class="form-group" style="margin:0">' +
      '<label style="font-size:0.78rem">Match Manufacturer</label>' +
      // The MIB upload form's combobox: inventory vendors first, with counts.
      '<span class="aw-combo aw-combo-dim">' +
        '<input type="text" id="f-icon-mfr" autocomplete="off" placeholder="Fortinet">' +
        '<div class="aw-suggest" id="icon-mfr-suggest"></div>' +
      '</span>' +
    '</div>' +
    '<div class="form-group" style="margin:0">' +
      '<label style="font-size:0.78rem">And Match by</label>' +
      '<select id="f-icon-scope">' +
        '<option value="manufacturer-type">Asset type</option>' +
        '<option value="manufacturer-model">Model</option>' +
      '</select>' +
    '</div>' +
    '<div class="form-group" style="margin:0">' +
      '<label style="font-size:0.78rem" id="f-icon-key-label">Asset type</label>' +
      '<select id="f-icon-type">' + typeOptionsHtml + '</select>' +
      '<input type="text" id="f-icon-model" placeholder="FortiGate-91G" style="display:none">' +
    '</div>' +
    '<div class="form-group" style="margin:0">' +
      '<label style="font-size:0.78rem">Image file</label>' +
      '<input type="file" id="f-icon-file" accept="image/png,image/jpeg,image/webp,image/svg+xml">' +
    '</div>' +
    '<button class="btn btn-primary" id="btn-icon-upload" style="height:34px">Upload</button>' +
  '</div>' +
  '<p id="icon-upload-status" style="margin:0 0 1rem;font-size:0.82rem"></p>';

  // List by scope. The key column is split into Manufacturer / Type-or-Model
  // because the canonical key (e.g. "Fortinet/firewall") is opaque on its own.
  function renderScopeList(scope, label, tailHeader) {
    var list = byScope[scope];
    var s = '<h5 class="mac-id-section-heading">' + escapeHtml(label) + ' (' + list.length + ')</h5>';
    if (list.length === 0) {
      s += '<p class="empty-state" style="padding:0.5rem 0;margin:0 0 1rem">No icons uploaded yet for this scope.</p>';
      return s;
    }
    s += '<table class="data-table" style="font-size:0.85rem;margin-bottom:1rem"><thead><tr>' +
      // nowrap: the uppercase header's letter-spacing broke "Preview" over two
      // lines in a 60px column.
      '<th style="width:72px;white-space:nowrap">Preview</th><th>Manufacturer</th><th>' + escapeHtml(tailHeader) + '</th><th>Filename</th><th style="width:100px">Size</th><th style="width:160px">Uploaded</th><th style="width:150px"></th>' +
    '</tr></thead><tbody>';
    list.forEach(function (i) {
      var slash = i.key.indexOf("/");
      var mfr = slash >= 0 ? i.key.slice(0, slash) : i.key;
      var tail = slash >= 0 ? i.key.slice(slash + 1) : "";
      var editing = i.id === _iconEditId;
      var isModel = i.scope === "manufacturer-model";
      s += '<tr' + (editing ? ' class="icon-edit-row" data-id="' + escapeHtml(i.id) + '"' : '') + '>' +
        '<td><img src="' + escapeHtml(i.url) + '" alt="" style="width:40px;height:40px;object-fit:contain;background:#1c2029;border:1px solid var(--color-border);border-radius:4px"></td>' +
        (editing
          // Inline editor: the same manufacturer picker as the upload form,
          // and the match-by switch, so an icon can move between the two
          // tables without a re-upload. The image is never touched.
          ? '<td><span class="aw-combo aw-combo-dim">' +
              '<input type="text" id="f-icon-edit-mfr" autocomplete="off" value="' + escapeHtml(mfr) + '" style="font-size:0.82rem">' +
              '<div class="aw-suggest" id="icon-edit-mfr-suggest"></div>' +
            '</span></td>' +
            '<td><div style="display:flex;gap:6px">' +
              '<select id="f-icon-edit-scope" style="font-size:0.82rem;width:auto">' +
                '<option value="manufacturer-type"' + (isModel ? '' : ' selected') + '>Asset type</option>' +
                '<option value="manufacturer-model"' + (isModel ? ' selected' : '') + '>Model</option>' +
              '</select>' +
              '<select id="f-icon-edit-type" style="font-size:0.82rem;flex:1' + (isModel ? ';display:none' : '') + '">' +
                _deviceIconTypeOptionsHTML(isModel ? "" : tail) + '</select>' +
              '<input type="text" id="f-icon-edit-model" value="' + escapeHtml(isModel ? tail : "") + '" placeholder="e.g. FortiGate-60F" style="font-size:0.82rem;flex:1' + (isModel ? '' : ';display:none') + '">' +
            '</div></td>'
          : '<td><code class="mono" style="font-size:0.78rem">' + escapeHtml(mfr) + '</code></td>' +
            '<td><code class="mono" style="font-size:0.78rem">' + escapeHtml(tail) + '</code></td>') +
        '<td>' + escapeHtml(i.filename) + '</td>' +
        '<td>' + escapeHtml(formatBytesShort(i.size)) + '</td>' +
        '<td style="font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(formatDate(i.uploadedAt)) + (i.uploadedBy ? ' by ' + escapeHtml(i.uploadedBy) : '') + '</td>' +
        '<td style="white-space:nowrap">' +
          (editing
            ? '<button class="btn btn-sm btn-primary icon-edit-save">Save</button> <button class="btn btn-sm icon-edit-cancel">Cancel</button>'
            : '<button class="btn btn-sm icon-edit" data-id="' + escapeHtml(i.id) + '">Edit</button> ' +
              '<button class="btn btn-sm btn-danger icon-del" data-id="' + escapeHtml(i.id) + '" data-key="' + escapeHtml(i.scope + ':' + i.key) + '">Delete</button>') +
        '</td>' +
      '</tr>';
    });
    s += '</tbody></table>';
    return s;
  }
  html += renderScopeList("manufacturer-type", "Manufacturer + Type", "Asset type");
  html += renderScopeList("manufacturer-model", "Manufacturer + Model", "Model");

  html += '</div>';
  return html;
}

// api.js canonical (2026-08 audit — this copy capped at MB).
var formatBytesShort = formatBytes;

// Rows for the Identification tab's manufacturer pickers (Device Icons, the
// alias pair, the MAC override) — every name the operator already has on hand,
// so the list isn't empty on installs with few aliases: alias canonicals, MIB
// facets (which include the asset inventory and its device counts), static
// MAC-override manufacturers, and the manufacturer half of every icon key.
// Free text is still allowed; each service alias-normalizes at write time.
function _knownManufacturerRows() {
  var names = (_manufacturerAliases || []).map(function (a) { return a.canonical; })
    .concat((_mibFacets && _mibFacets.manufacturers) || [])
    .concat((_ouiOverrides || []).map(function (o) { return o.manufacturer; }))
    .concat((_deviceIcons || []).map(function (i) {
      var slash = (i.key || "").indexOf("/");
      return slash > 0 ? i.key.slice(0, slash) : "";
    }));
  return _manufacturerCountRows(names);
}

function wireDeviceIconHandlers() {
  _wireManufacturerCountCombo("f-icon-mfr", "icon-mfr-suggest", _knownManufacturerRows);
  var btn = document.getElementById("btn-icon-upload");
  if (btn) btn.addEventListener("click", uploadIconUI);
  document.querySelectorAll(".icon-del").forEach(function (b) {
    b.addEventListener("click", function () {
      deleteIconUI(b.getAttribute("data-id"), b.getAttribute("data-key"));
    });
  });
  document.querySelectorAll(".icon-edit").forEach(function (b) {
    b.addEventListener("click", function () {
      _iconEditId = b.getAttribute("data-id");
      renderIdentificationTab();
    });
  });
  var editRow = document.querySelector(".icon-edit-row");
  if (editRow) {
    _wireManufacturerCountCombo("f-icon-edit-mfr", "icon-edit-mfr-suggest", _knownManufacturerRows);
    var editScope = document.getElementById("f-icon-edit-scope");
    var editType = document.getElementById("f-icon-edit-type");
    var editModel = document.getElementById("f-icon-edit-model");
    editScope.addEventListener("change", function () {
      var m = editScope.value === "manufacturer-model";
      editType.style.display = m ? "none" : "";
      editModel.style.display = m ? "" : "none";
    });
    editRow.querySelector(".icon-edit-save").addEventListener("click", function () {
      saveIconKeyUI(editRow.getAttribute("data-id"), this);
    });
    editRow.querySelector(".icon-edit-cancel").addEventListener("click", function () {
      _iconEditId = null;
      renderIdentificationTab();
    });
  }

  // Toggle the third column between the asset-type dropdown and the
  // model free-text input. Label flips too so the operator always sees
  // which input applies to the current scope.
  var scopeSel = document.getElementById("f-icon-scope");
  var typeSel = document.getElementById("f-icon-type");
  var modelInput = document.getElementById("f-icon-model");
  var keyLabel = document.getElementById("f-icon-key-label");
  if (scopeSel && typeSel && modelInput && keyLabel) {
    var refreshScope = function () {
      var isModel = scopeSel.value === "manufacturer-model";
      typeSel.style.display = isModel ? "none" : "";
      modelInput.style.display = isModel ? "" : "none";
      keyLabel.textContent = isModel ? "Model" : "Asset type";
    };
    scopeSel.addEventListener("change", refreshScope);
    refreshScope();
  }
}

async function uploadIconUI() {
  var scopeEl = document.getElementById("f-icon-scope");
  var mfrEl = document.getElementById("f-icon-mfr");
  var typeEl = document.getElementById("f-icon-type");
  var modelEl = document.getElementById("f-icon-model");
  var fileEl = document.getElementById("f-icon-file");
  var statusEl = document.getElementById("icon-upload-status");
  var btn = document.getElementById("btn-icon-upload");
  if (!scopeEl || !mfrEl || !typeEl || !modelEl || !fileEl) return;
  var scope = scopeEl.value;
  var manufacturer = (mfrEl.value || "").trim();
  var typeOrModel = scope === "manufacturer-model"
    ? (modelEl.value || "").trim()
    : typeEl.value;
  if (!manufacturer) { showToast("Manufacturer is required", "error"); return; }
  if (!typeOrModel) { showToast(scope === "manufacturer-model" ? "Model is required" : "Asset type is required", "error"); return; }
  if (!fileEl.files || fileEl.files.length === 0) { showToast("Choose an image file first", "error"); return; }
  btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Uploading…</span>';
  try {
    var created = await api.deviceIcons.upload(scope, manufacturer, typeOrModel, fileEl.files[0]);
    showToast("Icon uploaded for " + created.key, "success");
    if (statusEl) statusEl.innerHTML = "";
    mfrEl.value = "";
    modelEl.value = "";
    fileEl.value = "";
    _deviceIcons = await api.deviceIcons.list();
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

async function saveIconKeyUI(id, btn) {
  var scope = document.getElementById("f-icon-edit-scope").value;
  var manufacturer = (document.getElementById("f-icon-edit-mfr").value || "").trim();
  var typeOrModel = scope === "manufacturer-model"
    ? (document.getElementById("f-icon-edit-model").value || "").trim()
    : document.getElementById("f-icon-edit-type").value;
  if (!manufacturer) { showToast("Manufacturer is required", "error"); return; }
  if (!typeOrModel) { showToast(scope === "manufacturer-model" ? "Model is required" : "Asset type is required", "error"); return; }
  btn.disabled = true;
  try {
    var updated = await api.deviceIcons.update(id, { scope: scope, manufacturer: manufacturer, typeOrModel: typeOrModel });
    _deviceIcons = _deviceIcons.map(function (i) { return i.id === id ? updated : i; });
    _iconEditId = null;
    showToast("Icon now matches " + updated.key, "success");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
    btn.disabled = false;
  }
}

async function deleteIconUI(id, label) {
  var ok = await showConfirm('Delete device icon "' + label + '"?');
  if (!ok) return;
  try {
    await api.deviceIcons.delete(id);
    _deviceIcons = _deviceIcons.filter(function (i) { return i.id !== id; });
    showToast("Icon deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// (mibProfileStatusHTML removed — superseded by the editable Manufacturer
// Profiles card on the same Identification tab.)

// ─── Tag auto-assign device filter ───────────────────────────────────────────
// Shared by the Add Tag and Edit Tag modals. A tag with a filter is
// auto-applied to / removed from assets matching it (managed sync, engine-owned
// copies only — hand-applied tags are never disturbed).
//
// The filter IS the automations device filter: the same shared
// PolarisConditionBuilder, the same stored condition-tree shape, the same
// server-side evaluator. It replaced a flat one-rule-per-row builder that could
// only AND its rules, so "which devices?" is now asked one way everywhere. A tag
// still carrying the legacy flat shape opens here with its rules intact — the
// server folds it forward through criteriaToCondition on read.
//
// Vocabulary comes from GET /server-settings/tags/filter-schema, which carries
// the WIDE device-filter field set (the address book's, not the narrower
// automations Devices step's) because the flat tag builder already offered
// osVersion / department / location / fortigate and the wildcard operator.

var _tagFilterSchemaPromise = null;
var _tagPreviewTimer = null;

/** The builder vocabulary, fetched once per page load. */
function _loadTagFilterSchema() {
  if (!_tagFilterSchemaPromise) {
    _tagFilterSchemaPromise = api.serverSettings.tagFilterSchema().catch(function (err) {
      _tagFilterSchemaPromise = null; // let a later open retry
      throw err;
    });
  }
  return _tagFilterSchemaPromise;
}

/** The category the Device Map owns. Server-authoritative; this is the fallback
 *  for a schema payload that predates the field. */
function _regionCategoryOf(schema) {
  return (schema && schema.regionCategory) || "Map Regions";
}

/** Suggestion source for one field, mirroring the address book's mapping. */
function _tagValueOptions(schema) {
  return function (field) {
    var fm = (((schema.scopeCondition || {}).fields) || []).find(function (f) { return f.field === field; }) || {};
    if (fm.values) return fm.values.map(function (v) { return { value: v, label: v }; });
    var o = schema.options || {};
    var plain = function (list) { return (list || []).map(function (v) { return { value: v, label: v }; }); };
    switch (fm.optionsFrom) {
      case "assetTypes":
        return (o.assetTypes || []).map(function (t) { return { value: t.name, label: t.label || t.name }; });
      case "manufacturers":  return plain(o.manufacturers);
      case "models":         return plain(o.models);
      case "interfaceNames": return plain(o.interfaceNames);
      case "ssids":          return plain(o.ssids);
      case "nativeVlans":    return (o.nativeVlans || []).slice(); // already { value, label }
      case "tags":           return plain(o.tags);
      case "subnets":
        return (o.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr, name: sn.name }; });
      case "ipBlocks":
        return (o.ipBlocks || []).map(function (b) { return { value: b.cidr, label: b.name + " — " + b.cidr }; });
      default: return [];
    }
  };
}

/**
 * The tree a tag opens with. `assetCondition` is the current shape;
 * `assetConditionEffective` is the server's fold-forward of a legacy `criteria`
 * blob, so an un-migrated tag still opens with its rules in the builder.
 */
function _tagStoredCondition(tag) {
  if (!tag) return null;
  var cond = tag.assetCondition || tag.assetConditionEffective || null;
  return cond && (cond.children || []).length ? cond : null;
}

/**
 * The auto-assign section. `builder` must already exist (its field/operator
 * selects are rendered from the fetched vocabulary), which is why both modals
 * await the schema before assembling their body.
 *
 * A tag in the Device Map's category gets an explanation instead of a builder:
 * those tag names are already managed by the region reconcile through
 * RegionTagAssignment, and a second managed-sync engine on the same string would
 * spend every cycle undoing the first.
 */
function _tagFilterSectionHTML(tag, builder, schema) {
  var regionCat = _regionCategoryOf(schema);
  if (tag && (tag.category || "") === regionCat) {
    return '<div class="form-group" style="border-top:1px solid var(--color-border);padding-top:12px;margin-top:4px">' +
      '<label>Auto-assign</label>' +
      '<p class="hint" style="margin:0">This tag belongs to the <strong>' + escapeHtml(regionCat) + '</strong> category, so the ' +
        'Device Map applies it to every device inside its region &mdash; edit the region there to change who gets it. ' +
        'It cannot also carry a device filter.</p>' +
    '</div>';
  }

  var stored = _tagStoredCondition(tag);
  var stuck = (tag && tag.assetFilterUnconvertible) || [];
  // A stuck filter is one the builder can't RENDER, not one that stopped
  // applying — so the toggle reads as on and the warning explains the empty
  // builder. Leaving it off would advertise the tag as unfiltered.
  var on = !!stored || stuck.length > 0;
  var root = stored || { op: "and", children: [] };

  return '<div class="form-group" style="border-top:1px solid var(--color-border);padding-top:12px;margin-top:4px">' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="f-tag-auto-toggle"' + (on ? ' checked' : '') + ' style="width:auto">' +
      '<span>Auto-assign by filter</span>' +
    '</label>' +
    '<p class="hint">When on, this tag is automatically applied to every device matching the filter below, and removed when a ' +
      'device no longer matches. Tags you add by hand are never removed. Decommissioned devices are skipped unless the filter ' +
      'mentions status.</p>' +
    '<p class="hint">A <strong>Native VLAN</strong> condition also tags the <strong>interfaces</strong>: every port on that VLAN, ' +
      'on each device the filter matches, carries the tag too &mdash; so a switch with a port on the VLAN gets the tag along with the port.</p>' +
    '<div id="f-tag-filter-body" style="' + (on ? '' : 'display:none;') + '">' +
      (stuck.length
        ? '<p class="hint" style="color:var(--color-warning);margin:0 0 8px">This tag&rsquo;s filter uses ' +
            escapeHtml(stuck.join(", ")) + ', which this builder cannot show. It still applies &mdash; ' +
            'saving without changing the conditions below leaves it exactly as it is.</p>'
        : '') +
      '<p class="hint" style="margin:0 0 8px">Drag the <span class="aw-grip" style="cursor:default">&#x2842;</span> handle to ' +
        'move a condition into another group or reorder groups.</p>' +
      '<div id="f-tag-cond-root">' + builder.groupHtml(root, 0) + '</div>' +
      '<div id="f-tag-preview" class="hint" style="margin-top:8px;font-style:italic"></div>' +
    '</div>' +
  '</div>';
}

/**
 * The auto-assign half of the request body.
 *
 * An empty tree posts an explicit null rather than the tree: `and([])` is true
 * for every asset, so shipping it would ask the server to tag the entire fleet.
 * (The server collapses it too — normalizeTagCondition — but the toggle being
 * off must mean "clear the filter" on the wire, not "match everything".)
 */
function _collectTagFilter(builder, stuck) {
  var toggle = document.getElementById("f-tag-auto-toggle");
  // No toggle at all = the region-category form, which never writes a filter.
  if (!toggle) return {};
  if (!toggle.checked) return { assetCondition: null };
  var rootGroup = document.querySelector("#f-tag-cond-root > .scg-group");
  var tree = rootGroup && builder ? builder.collect(rootGroup) : null;
  if (!tree || !(tree.children || []).length) {
    // On, but nothing built. For a tag whose LEGACY filter this builder can't
    // render, that is the "leave it exactly as it is" case: omit both shape keys
    // so the server touches neither column. Posting assetCondition:null here
    // would clear a filter the operator was only shown a warning about.
    return (stuck && stuck.length) ? {} : { assetCondition: null };
  }
  return { assetCondition: tree };
}

/** Validation problem string, or null. Called before save so a bad CIDR or an
 *  empty group is refused here rather than as a 400. */
function _validateTagFilter(builder, stuck) {
  var toggle = document.getElementById("f-tag-auto-toggle");
  if (!toggle || !toggle.checked || !builder) return null;
  var rootGroup = document.querySelector("#f-tag-cond-root > .scg-group");
  if (!rootGroup) return null;
  var tree = builder.collect(rootGroup);
  if (!(tree.children || []).length) {
    // An unrenderable legacy filter is allowed to stay untouched (see
    // _collectTagFilter); anything else needs a condition or the toggle off.
    if (stuck && stuck.length) return null;
    return 'Add a condition, or switch "Auto-assign by filter" off.';
  }
  return builder.validate(tree);
}

function _refreshTagFilterPreview(tagId, builder) {
  var el = document.getElementById("f-tag-preview");
  if (!el) return;
  // No `stuck` here on purpose: the preview only ever describes a tree the
  // builder can show, and an omitted key would make it preview nothing.
  var body = _collectTagFilter(builder);
  if (!body.assetCondition) { el.textContent = ""; return; }
  el.textContent = "Checking…";
  if (_tagPreviewTimer) clearTimeout(_tagPreviewTimer);
  _tagPreviewTimer = setTimeout(async function () {
    try {
      var payload = { assetCondition: body.assetCondition };
      if (tagId) payload.tagId = tagId;
      var res = await api.serverSettings.previewTagCriteria(payload);
      var msg = res.matchCount + " device" + (res.matchCount === 1 ? "" : "s") + " match";
      if (res.portCount) msg += " · " + res.portCount + " interface" + (res.portCount === 1 ? "" : "s") + " on the VLAN";
      if (res.diff) msg += " · this save: +" + res.diff.add + " / −" + res.diff.remove;
      el.textContent = msg;
    } catch (err) {
      el.textContent = "Preview unavailable: " + (err && err.message ? err.message : "error");
    }
  }, 350);
}

/** Wire the toggle + the shared builder. Safe to call when the section rendered
 *  the region-category explanation instead (nothing to wire). */
function _wireTagFilterBuilder(tagId, builder) {
  var toggle = document.getElementById("f-tag-auto-toggle");
  if (!toggle || !builder) return;
  var bodyEl = document.getElementById("f-tag-filter-body");
  var rootEl = document.getElementById("f-tag-cond-root");

  toggle.addEventListener("change", function () {
    bodyEl.style.display = toggle.checked ? "" : "none";
    // Revealed empty: seed a starter row so the operator lands on something
    // editable (the address book's All-devices untick does the same).
    if (toggle.checked) builder.seedIfEmpty(rootEl);
    _refreshTagFilterPreview(tagId, builder);
  });

  // Rows, groups, the value combobox and the grip drag all live in the shared
  // module; the preview debounce rides its onChange.
  //
  // Bind to the SECTION, never to #modal-overlay. openModal reuses one
  // persistent overlay element, so binding there would leave the delegated
  // change/input/click listeners attached after the dialog closed and add a
  // fresh set on every open — by the third Add Tag, one "+ Condition" click
  // appends three rows. Every other consumer binds to a container that dies
  // with its form (the wizard's step panel, #mp-root, the address book's own
  // overlay); #f-tag-filter-body is this surface's equivalent and contains the
  // tree root, which is all wire() needs.
  builder.wire(bodyEl, "#f-tag-cond-root");
  _refreshTagFilterPreview(tagId, builder);
}

// The Color field of the Add / Edit Tag dialogs: a custom hex, or a severity
// reference ("severity:warning") that paints with the severity's theme token on
// every theme (tagColorCss in app.js). One builder for both dialogs — a stored
// reference fed to <input type="color"> would read back as #000000 and the next
// save would overwrite it.
function _tagColorFieldHTML(color) {
  var sev = tagColorSeverity(color);
  var hex = sev ? randomTagColor() : (tagColorCss(color) || randomTagColor());
  var opts = '<option value=""' + (sev ? '' : ' selected') + '>Custom color</option>' +
    TAG_SEVERITY_ORDER.map(function (s) {
      return '<option value="' + s + '"' + (s === sev ? ' selected' : '') + '>Severity: ' + s.charAt(0).toUpperCase() + s.slice(1) + '</option>';
    }).join('');
  return '<div class="form-group"><label>Color</label>' +
    '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<select id="f-tag-color-source" style="width:auto">' + opts + '</select>' +
      '<input type="color" id="f-tag-color" value="' + escapeHtml(hex) + '" style="width:40px;height:32px;padding:2px;border:1px solid var(--color-border);border-radius:4px;background:transparent;cursor:pointer">' +
      '<button type="button" id="f-tag-color-random" title="Random color" aria-label="Random color" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--color-border);border-radius:4px;background:transparent;color:var(--color-text-secondary);cursor:pointer">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/><path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/></svg>' +
      '</button>' +
      '<span id="f-tag-color-swatch" style="display:none;width:32px;height:32px;border-radius:4px;border:1px solid var(--color-border)"></span>' +
      '<span id="f-tag-color-hex" style="font-family:var(--font-mono);font-size:0.82rem;color:var(--color-text-secondary)"></span>' +
    '</div>' +
    '<p class="hint">A severity color matches that severity\'s pills and chart bands on every theme.</p>' +
  '</div>';
}

/** Wires the field built by _tagColorFieldHTML; returns a getter for the value to save. */
function _wireTagColorField() {
  var source = document.getElementById("f-tag-color-source");
  var colorInput = document.getElementById("f-tag-color");
  var randomBtn = document.getElementById("f-tag-color-random");
  var swatch = document.getElementById("f-tag-color-swatch");
  var hexLabel = document.getElementById("f-tag-color-hex");
  function sync() {
    var sev = source.value;
    colorInput.style.display = sev ? "none" : "";
    randomBtn.style.display = sev ? "none" : "inline-flex";
    swatch.style.display = sev ? "inline-block" : "none";
    if (sev) swatch.style.background = TAG_SEVERITY_COLORS[sev];
    hexLabel.textContent = sev ? "follows the theme" : colorInput.value;
  }
  source.addEventListener("change", sync);
  colorInput.addEventListener("input", sync);
  randomBtn.addEventListener("click", function () {
    colorInput.value = randomTagColor();
    sync();
  });
  sync();
  return function () { return source.value ? "severity:" + source.value : colorInput.value; };
}

async function openAddTagModal() {
  // The device-filter vocabulary has to be in hand BEFORE the body is assembled:
  // the builder renders its field/operator selects from it.
  var schema, condBuilder;
  try {
    schema = await _loadTagFilterSchema();
    condBuilder = window.PolarisConditionBuilder.create({
      meta: schema.scopeCondition,
      valueOptions: _tagValueOptions(schema),
      onChange: function () { _refreshTagFilterPreview(null, condBuilder); },
    });
  } catch (err) {
    showToast((err && err.message) || "Couldn't load the device-filter options", "error");
    return;
  }
  var regionCat = _regionCategoryOf(schema);

  // Collect existing categories (including empty tracked ones) for the dropdown.
  // The Device Map's category is deliberately NOT offered: every tag in it is
  // minted by a region save and kept in step by the region reconcile, so a
  // hand-added sibling would be owned by nothing. The server refuses it too.
  var existingCats = [];
  _tagsData.forEach(function (t) {
    var cat = t.category || "General";
    if (cat !== regionCat && existingCats.indexOf(cat) === -1) existingCats.push(cat);
  });
  _emptyCategories.forEach(function (cat) {
    if (cat !== regionCat && existingCats.indexOf(cat) === -1) existingCats.push(cat);
  });
  existingCats.sort();

  var catOptions = '<option value="">General</option>';
  existingCats.forEach(function (c) {
    if (c !== "General") {
      catOptions += '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>';
    }
  });

  var body =
    '<div class="form-group"><label>Tag Name *</label>' +
      '<input type="text" id="f-tag-name" placeholder="e.g. prod, critical, kubernetes">' +
    '</div>' +
    '<div class="form-group"><label>Category</label>' +
      '<div style="display:flex;gap:8px">' +
        '<select id="f-tag-category-select" style="flex:1">' + catOptions +
          '<option value="__new__">+ New Category...</option>' +
        '</select>' +
        '<input type="text" id="f-tag-category-new" placeholder="Category name" style="flex:1;display:none">' +
      '</div>' +
      '<p class="hint">Group related tags together. e.g. Environment, Function, Location</p>' +
    '</div>' +
    _tagColorFieldHTML(null) +
    _tagFilterSectionHTML(null, condBuilder, schema);

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-tag">Add Tag</button>';
  openModal("Add Tag", body, footer);
  _wireTagFilterBuilder(null, condBuilder);

  // Toggle new category input
  var catSelect = document.getElementById("f-tag-category-select");
  var catNew = document.getElementById("f-tag-category-new");
  catSelect.addEventListener("change", function () {
    if (catSelect.value === "__new__") {
      catNew.style.display = "";
      catNew.focus();
    } else {
      catNew.style.display = "none";
    }
  });

  var tagColorValue = _wireTagColorField();

  document.getElementById("btn-save-tag").addEventListener("click", async function () {
    var btn = this;
    var name = document.getElementById("f-tag-name").value.trim();
    if (!name) { showToast("Tag name is required", "error"); return; }

    var category;
    if (catSelect.value === "__new__") {
      category = catNew.value.trim() || "General";
    } else {
      category = catSelect.value || "General";
    }

    var problem = _validateTagFilter(condBuilder);
    if (problem) { showToast(problem, "error"); return; }

    btn.disabled = true;
    try {
      await api.serverSettings.createTag(Object.assign({
        name: name,
        category: category,
        color: tagColorValue(),
      }, _collectTagFilter(condBuilder)));
      closeModal();
      showToast('Tag "' + name + '" created');
      // Remove from empty categories if a tag was added to it
      _emptyCategories = _emptyCategories.filter(function (c) { return c !== category; });
      _tagsData = await api.serverSettings.listTags();
      renderIdentificationTab();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openEditTagModal(id) {
  var tag = _tagsData.find(function (t) { return t.id === id; });
  if (!tag) return;

  var schema, condBuilder;
  try {
    schema = await _loadTagFilterSchema();
    condBuilder = window.PolarisConditionBuilder.create({
      meta: schema.scopeCondition,
      valueOptions: _tagValueOptions(schema),
      onChange: function () { _refreshTagFilterPreview(tag.id, condBuilder); },
    });
  } catch (err) {
    showToast((err && err.message) || "Couldn't load the device-filter options", "error");
    return;
  }
  var regionCat = _regionCategoryOf(schema);
  // A tag ALREADY in the Device Map's category keeps it (that is the map's own
  // row); it just isn't offered as a destination for anything else.
  var inRegionCat = (tag.category || "") === regionCat;
  // Fields a legacy filter uses that the builder can't render — see
  // _collectTagFilter for why the save has to know.
  var stuckFields = tag.assetFilterUnconvertible || [];

  var existingCats = [];
  _tagsData.forEach(function (t) {
    var cat = t.category || "General";
    if (cat !== regionCat && existingCats.indexOf(cat) === -1) existingCats.push(cat);
  });
  _emptyCategories.forEach(function (cat) {
    if (cat !== regionCat && existingCats.indexOf(cat) === -1) existingCats.push(cat);
  });
  existingCats.sort();

  var catOptions = inRegionCat
    ? '<option value="' + escapeHtml(regionCat) + '" selected>' + escapeHtml(regionCat) + '</option>'
    : '<option value="General"' + (tag.category === "General" ? ' selected' : '') + '>General</option>';
  existingCats.forEach(function (c) {
    if (c !== "General") {
      catOptions += '<option value="' + escapeHtml(c) + '"' + (tag.category === c ? ' selected' : '') + '>' + escapeHtml(c) + '</option>';
    }
  });

  // Business rule 136: a built-in Priority tag shows its name, category and
  // colour read-only, and the save posts the device filter alone.
  var locked = !!tag.builtIn;
  var body = locked
    ? '<p class="hint" style="margin:0 0 12px">Built-in Priority tag. Its name, category and colour are fixed and it ' +
        'cannot be deleted. A device filter adds the tag to matching devices; tags people add by hand stay.</p>' +
      '<div class="form-group"><label>Tag Name</label>' +
        '<input type="text" id="f-tag-name" value="' + escapeHtml(tag.name) + '" disabled>' +
      '</div>' +
      '<div class="form-group"><label>Category</label>' +
        '<input type="text" value="' + escapeHtml(tag.category || "") + '" disabled>' +
      '</div>' +
      _tagFilterSectionHTML(tag, condBuilder, schema)
    : '<div class="form-group"><label>Tag Name *</label>' +
      '<input type="text" id="f-tag-name" value="' + escapeHtml(tag.name) + '">' +
    '</div>' +
    '<div class="form-group"><label>Category</label>' +
      '<div style="display:flex;gap:8px">' +
        '<select id="f-tag-category-select" style="flex:1">' + catOptions +
          '<option value="__new__">+ New Category...</option>' +
        '</select>' +
        '<input type="text" id="f-tag-category-new" placeholder="Category name" style="flex:1;display:none">' +
      '</div>' +
    '</div>' +
    _tagColorFieldHTML(tag.color || "#4fc3f7") +
    _tagFilterSectionHTML(tag, condBuilder, schema);

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-tag">Save Changes</button>';
  openModal("Edit Tag", body, footer);
  _wireTagFilterBuilder(tag.id, condBuilder);

  if (locked) {
    document.getElementById("btn-save-tag").addEventListener("click", async function () {
      var btn = this;
      var problem = _validateTagFilter(condBuilder, stuckFields);
      if (problem) { showToast(problem, "error"); return; }
      btn.disabled = true;
      try {
        await api.serverSettings.updateTag(id, _collectTagFilter(condBuilder, stuckFields));
        closeModal();
        showToast('Tag "' + tag.name + '" updated');
        if (typeof _tagCache !== "undefined") _tagCache.loaded = false;
        _tagsData = await api.serverSettings.listTags();
        renderIdentificationTab();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
    return;
  }

  var catSelect = document.getElementById("f-tag-category-select");
  var catNew = document.getElementById("f-tag-category-new");
  catSelect.addEventListener("change", function () {
    if (catSelect.value === "__new__") {
      catNew.style.display = "";
      catNew.focus();
    } else {
      catNew.style.display = "none";
    }
  });

  var tagColorValue = _wireTagColorField();

  document.getElementById("btn-save-tag").addEventListener("click", async function () {
    var btn = this;
    var name = document.getElementById("f-tag-name").value.trim();
    if (!name) { showToast("Tag name is required", "error"); return; }

    var category;
    if (catSelect.value === "__new__") {
      category = catNew.value.trim() || "General";
    } else {
      category = catSelect.value || "General";
    }

    var problem = _validateTagFilter(condBuilder, stuckFields);
    if (problem) { showToast(problem, "error"); return; }

    btn.disabled = true;
    try {
      await api.serverSettings.updateTag(id, Object.assign({
        name: name,
        category: category,
        color: tagColorValue(),
      }, _collectTagFilter(condBuilder, stuckFields)));
      closeModal();
      showToast('Tag "' + name + '" updated');
      if (typeof _tagCache !== "undefined") _tagCache.loaded = false;
      _tagsData = await api.serverSettings.listTags();
      renderIdentificationTab();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function deleteTag(id) {
  var tag = _tagsData.find(function (t) { return t.id === id; });
  var name = tag ? tag.name : "this tag";
  var ok = await showConfirm('Delete tag "' + name + '"? This will not remove it from existing assets or networks.');
  if (!ok) return;

  // Snapshot categories before delete
  var catsBefore = _currentCategories();

  try {
    await api.serverSettings.deleteTag(id);
    showToast('Tag "' + name + '" deleted');
    _tagsData = await api.serverSettings.listTags();

    // Detect categories that became empty after this delete
    var catsAfter = _currentCategories();
    catsBefore.forEach(function (cat) {
      if (catsAfter.indexOf(cat) === -1 && _emptyCategories.indexOf(cat) === -1) {
        _emptyCategories.push(cat);
      }
    });

    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Tag assets slide-in ─────────────────────────────────────────────────────
// Clicking a chip in the Tags card lists the assets carrying exactly that tag
// (GET /assets/by-tag). Same shape as the credential-usage slide-in below; a
// row opens the asset panel in place through PolarisPanels.
var _tagAssetsReturnFocus = null;
var _tagAssetsCurrent = null;

function _ensureTagAssetsPanelDOM() {
  if (document.getElementById("tag-assets-overlay")) return;
  // Skeleton + backdrop / close / Escape / resize wiring: buildSlideover (app.js).
  buildSlideover({
    id: "tag-assets-panel",
    prefix: "tag-assets",
    dialog: true,
    title: "Tag",
    close: closeTagAssetsPanel,
    resizeKey: "polaris.panel.width.tagassets",
  });

  var body = document.getElementById("tag-assets-body");
  var openRow = function (row) {
    var assetId = row.getAttribute("data-asset-id");
    if (!assetId) return;
    if (window.PolarisPanels && typeof window.PolarisPanels.openAsset === "function") {
      window.PolarisPanels.openAsset(assetId);
      return;
    }
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(assetId);
  };
  body.addEventListener("click", function (e) {
    var row = e.target.closest ? e.target.closest("[data-asset-id]") : null;
    if (row) openRow(row);
  });
  body.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var row = e.target.closest ? e.target.closest("[data-asset-id]") : null;
    if (row) { e.preventDefault(); openRow(row); }
  });
}

function closeTagAssetsPanel() {
  var overlay = document.getElementById("tag-assets-overlay");
  if (overlay) overlay.classList.remove("open");
  _tagAssetsCurrent = null;
  if (_tagAssetsReturnFocus && typeof _tagAssetsReturnFocus.focus === "function") {
    try { _tagAssetsReturnFocus.focus(); } catch (_) { }
  }
  _tagAssetsReturnFocus = null;
}

function _tagAssetsRow(a) {
  var label = a.hostname || a.ipAddress || a.id;
  var sub = [];
  if (a.ipAddress && a.hostname) sub.push(escapeHtml(a.ipAddress));
  if (a.assetType) sub.push(escapeHtml(a.assetType));
  if (a.status && a.status !== "active") sub.push(escapeHtml(a.status));
  if (a.monitorStatus) sub.push(escapeHtml(a.monitorStatus));
  return '<div data-asset-id="' + escapeHtml(a.id) + '" role="button" tabindex="0" title="Open asset details" ' +
    'style="padding:0.5rem 0.6rem;border:1px solid var(--color-border);border-radius:0.35rem;margin-bottom:0.4rem;cursor:pointer;background:var(--color-surface)">' +
    '<div style="font-weight:500;color:var(--color-accent)">' + escapeHtml(label) + '</div>' +
    (sub.length ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.1rem">' + sub.join(" · ") + '</div>' : "") +
    '</div>';
}

/**
 * One chip in the Tags card. `canOpenTagAssets` makes it the button that opens
 * the assets-with-this-tag slide-in (GET /assets/by-tag needs assets:read).
 */
function _tagRegistryChipHTML(t, canOpenTagAssets) {
  // .hue-pill (styles.css) draws the chip from `--hue` alone and keeps the
  // label legible whatever colour the operator picked.
  var hueStyle = tagHueStyle(t.color);
  var colorStyle = hueStyle ? ' style="' + hueStyle + '"' : '';
  // Either filter shape counts — a tag written before the condition-tree
  // cutover still auto-assigns through the folded-forward flat blob.
  var managed = !!(t.assetCondition || (t.criteria && t.criteria.rules && t.criteria.rules.length));
  var autoMark = managed
    ? '<span title="Auto-assigned by filter" style="margin-right:4px">&#9881;</span>'
    : '';
  // An `azure:` row is the Arc sync's: read-only here (the server
  // refuses PUT / DELETE), and removed automatically once no asset
  // carries it — so it offers neither verb.
  var mirrored = /^azure:/i.test(t.name);
  // The registry is the Tags key's (2026-11-03), not the role name's.
  var canEdit = (typeof canManageTags !== "function" || canManageTags()) && !mirrored;
  var chipTitle = [
    canOpenTagAssets ? "Show the assets with this tag" : "",
    mirrored ? "Mirrored from Azure by the Azure Arc integration — change it in Azure; Polaris removes it once no asset carries it" : "",
    t.builtIn ? "Built-in Priority tag — its name, category and colour are fixed and it cannot be deleted; only its device filter can be edited" : "",
  ].filter(Boolean).join(". ");
  return '<span class="tag-chip' + (hueStyle ? ' hue-pill hue-strong' : '') + (canOpenTagAssets ? ' tag-chip-open' : '') + '"' +
      ' data-tag-name="' + escapeHtml(t.name) + '"' +
      (chipTitle ? ' title="' + escapeHtml(chipTitle) + '"' : '') +
      (canOpenTagAssets ? ' role="button" tabindex="0"' : '') +
      colorStyle + '>' +
    autoMark +
    escapeHtml(t.name) +
    (canEdit ? '<button class="tag-chip-edit" data-tag-id="' + t.id + '" title="Edit" style="margin-left:4px;background:none;border:none;color:inherit;cursor:pointer;font-size:0.75rem;opacity:0.7;padding:0">&#9998;</button>' : '') +
    (canEdit && !t.builtIn ? '<button class="tag-chip-delete" data-tag-id="' + t.id + '" title="Delete">&times;</button>' : '') +
  '</span>';
}

async function openTagAssetsPanel(tagName) {
  if (!tagName) return;
  _ensureTagAssetsPanelDOM();
  var overlay = document.getElementById("tag-assets-overlay");
  // A first open records the trigger; a chip clicked while the panel already
  // shows another tag pivots it in place.
  if (!overlay.classList.contains("open")) _tagAssetsReturnFocus = document.activeElement;
  _tagAssetsCurrent = tagName;
  var metaEl = document.getElementById("tag-assets-meta");
  var bodyEl = document.getElementById("tag-assets-body");
  document.getElementById("tag-assets-title").textContent = tagName;
  metaEl.textContent = "";
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading...</p>';

  raiseSlideover(overlay);
  requestAnimationFrame(function () {
    overlay.classList.add("open");
    var panel = document.getElementById("tag-assets-panel");
    if (panel) panel.focus();
  });

  try {
    var r = await api.assets.byTag(tagName);
    // A late answer for a tag the panel has since left (or closed) is dropped.
    if (_tagAssetsCurrent !== tagName) return;
    var total = r.total || 0;
    var rows = r.assets || [];
    metaEl.innerHTML = '<span>' + total + ' asset' + (total === 1 ? "" : "s") + ' with this tag</span>';
    if (total === 0) {
      bodyEl.innerHTML = '<div style="padding:1rem 1.25rem"><p class="empty-state" style="padding:1rem 0">No assets carry this tag.</p></div>';
      return;
    }
    bodyEl.innerHTML =
      '<div style="padding:1rem 1.25rem">' +
        (rows.length < total
          ? '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem">Showing the first ' + rows.length + ' of ' + total + '.</p>'
          : '') +
        rows.map(_tagAssetsRow).join("") +
      '</div>';
  } catch (err) {
    if (_tagAssetsCurrent !== tagName) return;
    bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem;color:var(--color-danger)">' +
      escapeHtml(err.message || "Failed to load") + '</p>';
  }
}

