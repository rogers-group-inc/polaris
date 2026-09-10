/**
 * public/js/server-settings.js — Server Settings page (NTP + Web Server + Database).
 * Note: the "Web Server" tab keeps the internal key `certificates` (data-tab,
 * loadCertificates) from before it was renamed — only its label changed.
 */

document.addEventListener("DOMContentLoaded", function () {
  // Page-level access widening: admin sees every tab; assets-admin sees only
  // the Credentials tab (and only the MIB Database card within it) so the
  // MIB-aware browse + walk surface is reachable without giving them the
  // rest of Server Settings. Backend guards on /server-settings/mibs/* are
  // the source of truth — this is just UX hide. The credentials list itself
  // and the Manufacturer Profiles card are gated to admin inside
  // renderCredentialsTab().
  var isAssetsAdminOnly = (typeof isAdmin === "function" && !isAdmin());
  if (isAssetsAdminOnly) {
    document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) {
      if (t.getAttribute("data-tab") !== "credentials") t.style.display = "none";
    });
    document.querySelectorAll(".page-tab-panel").forEach(function (p) {
      if (p.id !== "tab-credentials") p.style.display = "none";
    });
    // The HTML defaults the active tab to Identification — flip the active
    // class so assets-admin lands on Credentials without an extra click.
    document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) { t.classList.remove("active"); });
    document.querySelectorAll(".page-tab-panel").forEach(function (p) { p.classList.remove("active"); });
    var credTab = document.querySelector('#settings-tabs .page-tab[data-tab="credentials"]');
    var credPanel = document.getElementById("tab-credentials");
    if (credTab) credTab.classList.add("active");
    if (credPanel) credPanel.classList.add("active");
  }

  // Tab switching
  document.querySelectorAll("#settings-tabs .page-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      document.querySelectorAll("#settings-tabs .page-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".page-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("tab-" + target).classList.add("active");
      // Persist the active tab in the URL so a page refresh restores it
      // (read back via the ?tab= handler below on load). replaceState keeps
      // it out of the back/forward history.
      try {
        var u = new URL(window.location.href);
        u.searchParams.set("tab", target);
        window.history.replaceState(null, "", u);
      } catch (e) { /* non-fatal: tab still switches */ }
      // Lazy-load tabs on first click
      if (target === "ntp" && !_ntpLoaded) loadNtpSettings();
      if (target === "certificates" && !_certsLoaded) loadCertificates();
      if (target === "maintenance" && !_dbLoaded) loadDatabaseInfo();
      if (target === "identification" && !_tagsLoaded) loadIdentificationTab();
      if (target === "customization" && !_brandingLoaded) loadCustomizationTab();
      if (target === "credentials" && !_credsLoaded) loadCredentialsTab();
      if (target === "retention" && !_retentionLoaded) loadRetentionTab();
      if (target === "api-tokens" && !_apiTokensLoaded) loadApiTokensTab();
      // High Availability lives in its own module (server-settings-ha.js):
      // the tab is a build procedure with its own state machine, and it
      // polls while visible because a node registering arrives from
      // another machine. It reloads on every activation rather than once,
      // so returning to it shows current cluster state.
      if (target === "ha" && window.PolarisHaTab) window.PolarisHaTab.load();
    });
  });

  // Check for ?tab= query parameter to open a specific tab
  var urlParams = new URLSearchParams(window.location.search);
  var requestedTab = urlParams.get("tab");
  // Back-compat: ?tab=database now maps to the renamed Maintenance tab.
  if (requestedTab === "database") requestedTab = "maintenance";
  if (requestedTab) {
    var tabBtn = document.querySelector('#settings-tabs .page-tab[data-tab="' + requestedTab + '"]');
    if (tabBtn) {
      tabBtn.click();
      return;
    }
  }

  // Assets-admin starts on Credentials (only tab they can see); admin starts
  // on Identification per the HTML default.
  if (isAssetsAdminOnly) {
    loadCredentialsTab();
  } else {
    loadIdentificationTab();
  }
});

// ─── NTP Tab ────────────────────────────────────────────────────────────────

var _ntpLoaded = false;

async function loadNtpSettings() {
  _ntpLoaded = true;
  var container = document.getElementById("tab-ntp");
  var defaults = {
    enabled: false,
    mode: "ntp",
    servers: "",
    timezoneOverride: "",
  };

  try {
    var saved = await api.serverSettings.getNtp();
    if (saved) {
      defaults.enabled = saved.enabled || false;
      defaults.mode = saved.mode || "ntp";
      defaults.servers = (saved.servers || []).join("\n");
      defaults.timezoneOverride = saved.timezoneOverride || "";
    }
  } catch (_) {}

  container.innerHTML =
    '<div class="settings-cards-row">' +
    '<div class="settings-card">' +
      '<h4>Time Synchronization</h4>' +
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
          '<input type="checkbox" id="f-ntp-enabled"' + (defaults.enabled ? ' checked' : '') + '>' +
          '<span>Enable NTP synchronization</span>' +
        '</label>' +
        '<p class="hint">Synchronize the server clock with external NTP servers.</p>' +
      '</div>' +
      '<div class="form-group"><label>Mode</label>' +
        '<select id="f-ntp-mode">' +
          '<option value="ntp"' + (defaults.mode === "ntp" ? ' selected' : '') + '>NTP (UDP 123)</option>' +
          '<option value="sntp"' + (defaults.mode === "sntp" ? ' selected' : '') + '>SNTP (Simple NTP)</option>' +
          '<option value="nts"' + (defaults.mode === "nts" ? ' selected' : '') + '>NTS (Network Time Security)</option>' +
        '</select>' +
        '<p class="hint">NTS encrypts and authenticates time queries using TLS. Requires NTS-capable servers.</p>' +
      '</div>' +
      '<div class="form-group"><label>NTP Servers</label>' +
        '<textarea id="f-ntp-servers" rows="4" placeholder="One server per line, e.g.:\npool.ntp.org\ntime.google.com\ntime.cloudflare.com">' + escapeHtml(defaults.servers) + '</textarea>' +
        '<p class="hint">Enter one server per line. IP addresses or hostnames are accepted.</p>' +
      '</div>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Timezone Override</h4>' +
      '<div class="form-group"><label>Timezone</label>' +
        '<div class="search-select" id="tz-select-wrap">' +
          '<input type="text" class="search-select-input" id="f-ntp-timezone" autocomplete="off" placeholder="Search timezones... (blank = system timezone)">' +
          '<input type="hidden" id="f-ntp-timezone-val" value="' + escapeHtml(defaults.timezoneOverride) + '">' +
          '<button type="button" class="search-select-clear" id="tz-clear" title="Clear" style="display:none">&times;</button>' +
          '<span class="search-select-arrow">&#9662;</span>' +
          '<div class="search-select-dropdown" id="tz-dropdown"></div>' +
        '</div>' +
        '<p class="hint">IANA timezone identifier (e.g. America/Chicago, UTC, Europe/London). Leave blank to use the server\'s OS timezone.</p>' +
      '</div>' +
      '<div id="ntp-current-time" style="font-size:0.82rem;color:var(--color-text-tertiary);margin-top:0.5rem"></div>' +
    '</div>' +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-primary" id="btn-ntp-save">Save NTP Settings</button>' +
      '<button class="btn btn-secondary" id="btn-ntp-test">Test Sync</button>' +
      '<span id="ntp-status" style="font-size:0.82rem;margin-left:8px"></span>' +
    '</div>';

  // Show current time
  updateCurrentTime();
  setInterval(updateCurrentTime, 1000);

  document.getElementById("btn-ntp-save").addEventListener("click", saveNtpSettings);
  document.getElementById("btn-ntp-test").addEventListener("click", testNtpSync);

  initTimezoneDropdown(defaults.timezoneOverride);
}

function updateCurrentTime() {
  var el = document.getElementById("ntp-current-time");
  if (!el) return;
  var tz = document.getElementById("f-ntp-timezone-val");
  var tzVal = tz ? tz.value.trim() : "";
  try {
    var opts = { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" };
    if (tzVal) opts.timeZone = tzVal;
    el.textContent = "Current server time: " + new Date().toLocaleString(undefined, opts);
  } catch (_) {
    el.textContent = "Current server time: " + new Date().toLocaleTimeString();
  }
}

// Page-scoped cache for the NTP timezone override. Fetched once when any
// tab that needs to format timestamps loads (currently Maintenance), reused
// by formatLocalTime() below. Empty string = "no override; use browser-local."
var _tzOverride = null; // null = unloaded, "" = loaded but empty, "America/Chicago" = explicit
async function loadTzOverride() {
  if (_tzOverride !== null) return _tzOverride;
  try {
    var ntp = await api.serverSettings.getNtp();
    _tzOverride = (ntp && ntp.timezoneOverride) ? ntp.timezoneOverride : "";
  } catch (_) {
    _tzOverride = "";
  }
  return _tzOverride;
}

// Render an ISO timestamp using the configured server timezone override (set
// in Server Settings → Time & NTP → Timezone Override). When no override is
// set, falls back to the browser's local timezone — for an admin operating
// from the same site as the server, those usually match.
function formatLocalTime(iso) {
  if (!iso) return "";
  try {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var opts = {
      year: "numeric", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit",
      timeZoneName: "short",
    };
    if (_tzOverride) opts.timeZone = _tzOverride;
    return d.toLocaleString(undefined, opts);
  } catch (_) {
    return iso;
  }
}

async function saveNtpSettings() {
  var btn = document.getElementById("btn-ntp-save");
  btn.disabled = true;
  try {
    var servers = document.getElementById("f-ntp-servers").value
      .split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    await api.serverSettings.updateNtp({
      enabled: document.getElementById("f-ntp-enabled").checked,
      mode: document.getElementById("f-ntp-mode").value,
      servers: servers,
      timezoneOverride: document.getElementById("f-ntp-timezone-val").value.trim() || null,
    });
    // Invalidate the formatLocalTime cache so the next Maintenance render
    // picks up the new override without a full page refresh.
    _tzOverride = null;
    showToast("NTP settings saved");
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

async function testNtpSync() {
  var btn = document.getElementById("btn-ntp-test");
  var statusEl = document.getElementById("ntp-status");
  btn.disabled = true;
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Testing...</span>';
  try {
    var servers = document.getElementById("f-ntp-servers").value
      .split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
    var result = await api.serverSettings.testNtp({
      mode: document.getElementById("f-ntp-mode").value,
      servers: servers,
    });
    statusEl.innerHTML = result.ok
      ? '<span style="color:var(--color-success)">' + escapeHtml(result.message) + '</span>'
      : '<span style="color:var(--color-danger)">' + escapeHtml(result.message) + '</span>';
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

// ─── Timezone Searchable Dropdown ──────────────────────────────────────────

function initTimezoneDropdown(currentValue) {
  var input = document.getElementById("f-ntp-timezone");
  var hidden = document.getElementById("f-ntp-timezone-val");
  var dropdown = document.getElementById("tz-dropdown");
  var clearBtn = document.getElementById("tz-clear");

  // Build timezone list from Intl API
  var allZones;
  try {
    allZones = Intl.supportedValuesOf("timeZone");
  } catch (_) {
    // Fallback for older browsers — populate a reasonable subset
    allZones = [
      "UTC",
      "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
      "America/Anchorage", "America/Phoenix", "America/Toronto", "America/Vancouver",
      "America/Mexico_City", "America/Sao_Paulo", "America/Buenos_Aires", "America/Bogota",
      "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Rome",
      "Europe/Amsterdam", "Europe/Moscow", "Europe/Istanbul", "Europe/Athens",
      "Asia/Tokyo", "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Singapore", "Asia/Seoul",
      "Asia/Kolkata", "Asia/Dubai", "Asia/Bangkok", "Asia/Taipei", "Asia/Jakarta",
      "Australia/Sydney", "Australia/Melbourne", "Australia/Perth", "Australia/Brisbane",
      "Pacific/Auckland", "Pacific/Honolulu", "Pacific/Fiji",
      "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
    ];
  }

  var highlightIdx = -1;

  // Set initial display value
  if (currentValue) {
    input.value = currentValue;
    clearBtn.style.display = "";
  }

  function renderOptions(filter) {
    var html = "";
    var count = 0;
    var currentGroup = "";
    var filterLower = (filter || "").toLowerCase();

    // Group by region (part before /)
    for (var i = 0; i < allZones.length; i++) {
      var tz = allZones[i];
      if (filterLower && tz.toLowerCase().indexOf(filterLower) === -1) continue;

      var slash = tz.indexOf("/");
      var group = slash > 0 ? tz.substring(0, slash) : "Other";
      var label = slash > 0 ? tz.substring(slash + 1).replace(/_/g, " ") : tz;

      if (group !== currentGroup) {
        currentGroup = group;
        html += '<div class="search-select-group">' + escapeHtml(group) + '</div>';
      }

      html += '<div class="search-select-option" data-value="' + escapeHtml(tz) + '"' +
        (tz === hidden.value ? ' class="search-select-option selected"' : '') +
        '>' + escapeHtml(label) + ' <span style="color:var(--color-text-tertiary);font-size:0.78rem">' + escapeHtml(tz) + '</span></div>';
      count++;
    }

    if (count === 0) {
      html = '<div class="search-select-empty">No timezones match "' + escapeHtml(filter) + '"</div>';
    }

    dropdown.innerHTML = html;
    highlightIdx = -1;

    // Wire click handlers
    dropdown.querySelectorAll(".search-select-option").forEach(function (opt) {
      opt.addEventListener("mousedown", function (e) {
        e.preventDefault(); // prevent blur
        selectTz(opt.getAttribute("data-value"));
      });
    });
  }

  function selectTz(value) {
    hidden.value = value;
    input.value = value;
    clearBtn.style.display = value ? "" : "none";
    closeDropdown();
    updateCurrentTime();
  }

  function clearTz() {
    hidden.value = "";
    input.value = "";
    clearBtn.style.display = "none";
    closeDropdown();
    updateCurrentTime();
  }

  function openDropdown() {
    renderOptions(input.value === hidden.value ? "" : input.value);
    dropdown.classList.add("open");

    // Scroll to selected item
    var sel = dropdown.querySelector(".selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  function closeDropdown() {
    dropdown.classList.remove("open");
    highlightIdx = -1;
    // Restore display value
    input.value = hidden.value || "";
  }

  function getVisibleOptions() {
    return dropdown.querySelectorAll(".search-select-option");
  }

  function updateHighlight(opts) {
    opts.forEach(function (o, i) {
      if (i === highlightIdx) {
        o.classList.add("highlighted");
        o.scrollIntoView({ block: "nearest" });
      } else {
        o.classList.remove("highlighted");
      }
    });
  }

  input.addEventListener("focus", function () {
    input.select();
    openDropdown();
  });

  input.addEventListener("input", function () {
    renderOptions(input.value);
    dropdown.classList.add("open");
  });

  input.addEventListener("blur", function () {
    // Small delay to allow mousedown on option to fire first
    setTimeout(closeDropdown, 150);
  });

  input.addEventListener("keydown", function (e) {
    var opts = getVisibleOptions();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!dropdown.classList.contains("open")) { openDropdown(); return; }
      highlightIdx = Math.min(highlightIdx + 1, opts.length - 1);
      updateHighlight(opts);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightIdx = Math.max(highlightIdx - 1, 0);
      updateHighlight(opts);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIdx >= 0 && highlightIdx < opts.length) {
        selectTz(opts[highlightIdx].getAttribute("data-value"));
      }
    } else if (e.key === "Escape") {
      closeDropdown();
      input.blur();
    }
  });

  clearBtn.addEventListener("click", function (e) {
    e.stopPropagation();
    clearTz();
    input.focus();
  });
}

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
      'Verify that the configured DNS servers can perform reverse lookups by testing with a known IP address.' +
    '</p>' +
    '<div class="form-group"><label>Test IP Address</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="text" id="f-dns-test-ip" value="8.8.8.8" placeholder="e.g. 8.8.8.8 or 2001:4860:4860::8888" style="width:320px">' +
        '<button class="btn btn-secondary" id="btn-dns-test">Test Lookup</button>' +
      '</div>' +
      '<p class="hint">Enter an IPv4 or IPv6 address to perform a test PTR lookup against the configured servers.</p>' +
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

// ─── Web Server Tab (internal key "certificates") ────────────────────────────

var _certsLoaded = false;
var _certData = { trustedCAs: [], serverCerts: [] };
var _httpsSettings = { fingerprint: null, cn: null, dnsSans: [], ipSans: [], expiresAt: null, certPath: null };
var _proxyData = null;
var _dashSettings = null; // { enabled, rfc1918Only } | null while loading/failed
var _loginAccess = null;  // { settings, callerIp } | null while loading/failed

// Render the Web Server tab (data-tab="certificates"). nginx terminates TLS — four stacked cards:
// HTTPS Certificate (read-only metadata + Rotate button), nginx Proxy (the
// six operator-settable directives: HTTPS port, HTTP/3, TLS protocols, HSTS,
// Prometheus allow-list, with a Save & Apply button), Dash Wallboard (the
// unauthenticated read-only /dash surface: on/off toggle + source-IP scope),
// and Trusted CAs.
// A drift banner appears above the cards when proxyConfig.managedMode is
// false (the refuse-and-banner UX for existing installs that haven't opted
// into Polaris-managed nginx config yet). See src/api/routes/proxySettings.ts.
function renderCertsTab(container) {
  var s = _httpsSettings || {};
  var p = (_proxyData && _proxyData.config) || {};
  var drift = (_proxyData && _proxyData.drift) || { managedMode: false, driftMarkers: [] };
  var fingerprint = (_proxyData && _proxyData.currentFingerprint) || s.fingerprint || "(unavailable)";
  var cn = s.cn || "(none)";
  var dnsSans = (s.dnsSans && s.dnsSans.length) ? s.dnsSans.join(", ") : "(none)";
  var ipSans = (s.ipSans && s.ipSans.length) ? s.ipSans.join(", ") : "(none)";
  var certPath = s.certPath || "(unset)";

  // Expiry with severity pill — amber <30d, red <7d, green otherwise.
  var expiryHtml = "(unknown)";
  if (s.expiresAt) {
    var ms = Date.parse(s.expiresAt) - Date.now();
    var days = Math.floor(ms / (24 * 60 * 60 * 1000));
    var pillClass = "badge-available";
    var pillLabel = days + " days";
    if (days < 0)       { pillClass = "badge-deprecated"; pillLabel = "EXPIRED"; }
    else if (days < 7)  { pillClass = "badge-deprecated"; pillLabel = days + " days"; }
    else if (days < 30) { pillClass = "badge-reserved";   pillLabel = days + " days"; }
    expiryHtml = escapeHtml(formatDate(s.expiresAt)) +
                 ' <span class="badge ' + pillClass + '" style="margin-left:6px">' +
                 escapeHtml(pillLabel) + '</span>';
  }

  // Drift banner — only renders when managedMode is false.
  var bannerHtml = "";
  if (!drift.managedMode) {
    var markers = (drift.driftMarkers || []).slice(0, 5).map(escapeHtml).join("; ");
    var moreCount = Math.max(0, (drift.driftMarkers || []).length - 5);
    var markerLine = markers
      ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.4rem;font-family:monospace">' +
          escapeHtml("Detected: ") + markers + (moreCount > 0 ? " (+" + moreCount + " more)" : "") +
        '</div>'
      : '';
    bannerHtml =
      '<div class="settings-card" style="border-color:#f59e0b;background:rgba(245,158,11,0.08);margin-bottom:1rem">' +
        '<h4 style="color:#f59e0b;margin-bottom:0.5rem">nginx config not Polaris-managed yet</h4>' +
        '<p style="font-size:0.85rem;margin-bottom:0.6rem">' +
          'The Save &amp; Apply button below is disabled until you click <strong>Adopt managed mode</strong>. ' +
          'Until then, the controls show what Polaris parsed from <code>/etc/nginx/conf.d/polaris.conf</code> and ' +
          'are read-only. Adopting will overwrite any hand-edits beyond the six controls Polaris manages on the ' +
          'next Apply.' +
        '</p>' +
        markerLine +
        '<div style="margin-top:0.8rem">' +
          '<button class="btn btn-sm btn-primary" id="proxy-adopt-btn">Adopt managed mode</button>' +
        '</div>' +
      '</div>';
  }

  var disabled = drift.managedMode ? "" : " disabled";
  var hsts = p.hsts || { enabled: true, maxAgeSeconds: 31536000, includeSubDomains: true, preload: true };
  var prom = (p.prometheusAllowIps || []).join("\n");
  var tlsProtocols = p.tlsProtocols || ["TLSv1.2", "TLSv1.3"];

  var certCardHtml =
    '<div class="settings-card">' +
      '<h4>HTTPS Certificate</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'TLS is terminated by nginx reading the cert at <code>' + escapeHtml(certPath) + '</code>. ' +
        'Rotation walks through the dual-pin stage→swap→retire workflow so it\'s zero-downtime as long as ' +
        'every agent is online to receive the new pin. The SHA-256 fingerprint Polaris Agents pin against ' +
        'lives on Integrations → Polaris Agent.' +
      '</p>' +
      '<div class="form-group"><label>Cert path</label>' +
        '<input type="text" readonly value="' + escapeHtml(certPath) + '" style="font-family:monospace">' +
      '</div>' +
      '<div class="form-group"><label>Common Name</label>' +
        '<input type="text" readonly value="' + escapeHtml(cn) + '">' +
      '</div>' +
      '<div class="form-group"><label>DNS SANs</label>' +
        '<input type="text" readonly value="' + escapeHtml(dnsSans) + '">' +
      '</div>' +
      '<div class="form-group"><label>IP SANs</label>' +
        '<input type="text" readonly value="' + escapeHtml(ipSans) + '">' +
      '</div>' +
      '<div class="form-group"><label>Expiry</label>' +
        '<div style="padding:0.4rem 0">' + expiryHtml + '</div>' +
      '</div>' +
      '<div style="margin-top:0.5rem">' +
        '<button class="btn btn-sm btn-secondary" id="proxy-rotate-cert-btn">Rotate certificate</button>' +
      '</div>' +
    '</div>';

  var proxyCardHtml =
    '<div class="settings-card">' +
      '<h4>nginx Proxy</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Six operator-settable directives. Save &amp; Apply renders <code>/etc/nginx/conf.d/polaris.conf</code> ' +
        'from these values, runs <code>nginx -t</code>, and reloads nginx. server_name is derived from ' +
        '<code>POLARIS_PUBLIC_URL</code>.' +
      '</p>' +
      '<div class="form-group">' +
        '<label for="proxy-https-port">HTTPS listen port (TCP + UDP)</label>' +
        '<input type="number" id="proxy-https-port" min="1" max="65535" value="' + escapeHtml(String(p.httpsPort || 443)) + '"' + disabled + '>' +
      '</div>' +
      '<div class="form-group">' +
        '<label><input type="checkbox" id="proxy-http3-enabled"' + (p.http3Enabled ? " checked" : "") + disabled + '> HTTP/3 (QUIC over UDP)</label>' +
        '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">Requires nginx 1.30+. When off, removes the QUIC listener, the Alt-Svc header, and ssl_early_data.</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>TLS protocols</label>' +
        '<div style="display:flex;gap:1rem">' +
          '<label><input type="checkbox" id="proxy-tls-12"' + (tlsProtocols.indexOf("TLSv1.2") >= 0 ? " checked" : "") + disabled + '> TLSv1.2</label>' +
          '<label><input type="checkbox" id="proxy-tls-13"' + (tlsProtocols.indexOf("TLSv1.3") >= 0 ? " checked" : "") + disabled + '> TLSv1.3</label>' +
        '</div>' +
        '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">QUIC requires TLSv1.3 — turning HTTP/3 on auto-includes 1.3.</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label><input type="checkbox" id="proxy-hsts-enabled"' + (hsts.enabled ? " checked" : "") + disabled + '> HSTS (Strict-Transport-Security header)</label>' +
        '<div style="display:flex;gap:0.5rem;align-items:center;margin-top:0.4rem">' +
          '<input type="number" id="proxy-hsts-max-age" min="0" value="' + escapeHtml(String(hsts.maxAgeSeconds)) + '" style="flex:1"' + disabled + '>' +
          '<select id="proxy-hsts-preset" style="flex:0 0 8rem"' + disabled + '>' +
            '<option value="">Preset…</option>' +
            '<option value="3600">1 hour</option>' +
            '<option value="86400">1 day</option>' +
            '<option value="2592000">30 days</option>' +
            '<option value="31536000">1 year</option>' +
          '</select>' +
        '</div>' +
        '<label style="margin-top:0.3rem"><input type="checkbox" id="proxy-hsts-subdomains"' + (hsts.includeSubDomains ? " checked" : "") + disabled + '> includeSubDomains</label> &nbsp; ' +
        '<label><input type="checkbox" id="proxy-hsts-preload"' + (hsts.preload ? " checked" : "") + disabled + '> preload</label>' +
        '<div style="font-size:0.78rem;color:#f59e0b;margin-top:0.3rem">HSTS cannot be undone in already-visited browsers for the duration of the previous max-age.</div>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="proxy-prometheus-ips">Prometheus allow-list (one IP per line)</label>' +
        '<textarea id="proxy-prometheus-ips" rows="3" placeholder="10.0.0.42"' + disabled + '>' + escapeHtml(prom) + '</textarea>' +
        '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">Empty list = deny all. Bearer auth still gates /metrics; this is the first defense layer.</div>' +
      '</div>' +
      '<div style="margin-top:1rem">' +
        '<button class="btn btn-sm btn-primary" id="proxy-apply-btn"' + disabled + '>Save &amp; Apply</button>' +
        '<div id="proxy-apply-status" style="font-size:0.85rem;margin-top:0.6rem;display:none"></div>' +
        '<div id="proxy-apply-output" style="font-size:0.78rem;margin-top:0.4rem;display:none;background:var(--color-surface);padding:0.6rem;border-radius:4px;white-space:pre-wrap;font-family:monospace;max-height:14rem;overflow:auto"></div>' +
      '</div>' +
    '</div>';

  // Dash Wallboard card — controls the unauthenticated read-only /dash
  // surface (own process; src/dash/dashServer.ts). The dash listener re-reads
  // the setting within ~10s, no restart needed. PUT is serverSettingsSystem
  // fullwrite-gated server-side.
  var d = _dashSettings; // null = load failed (endpoint gated or older server)
  var dScope = (d && d.ipScope) || "rfc1918";
  var dCidrs = (d && Array.isArray(d.allowedCidrs)) ? d.allowedCidrs.join(", ") : "";
  var dashCardHtml =
    '<div class="settings-card">' +
      '<h4>Dash Wallboard</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'A read-only, no-login duplicate of the Dashboard at <code>/dash</code> for NOC wallboards and kiosks. ' +
        'It answers with the built-in <code>readonly</code> role\'s permissions; widget layout is saved in each ' +
        'viewer\'s browser. Requests from disallowed source IPs are dropped (no response). Changes take effect within ~10 seconds.' +
      '</p>' +
      (d === null
        ? '<p style="font-size:0.85rem;color:var(--color-text-secondary)">Unavailable — could not load the Dash settings.</p>'
        : '<div class="form-group">' +
            '<label><input type="checkbox" id="dash-enabled"' + (d.enabled ? " checked" : "") + '> Enable the Dash wallboard</label>' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Allowed source IPs</label>' +
            '<div style="display:flex;flex-direction:column;gap:0.3rem;margin-top:0.3rem">' +
              '<label><input type="radio" name="dash-ip-scope" value="rfc1918"' + (dScope === "rfc1918" ? " checked" : "") + '> Private networks only (RFC1918 + loopback)</label>' +
              '<label><input type="radio" name="dash-ip-scope" value="all"' + (dScope === "all" ? " checked" : "") + '> All source IPs</label>' +
              '<label><input type="radio" name="dash-ip-scope" value="custom"' + (dScope === "custom" ? " checked" : "") + '> Custom networks</label>' +
            '</div>' +
            '<div id="dash-custom-cidrs" style="margin-top:0.4rem;' + (dScope === "custom" ? "" : "display:none") + '">' +
              '<textarea id="dash-allowed-cidrs" rows="3" placeholder="10.0.0.0/8, 192.168.10.0/24, 203.0.113.5" ' +
                'style="width:100%;font-family:monospace">' + escapeHtml(dCidrs) + '</textarea>' +
              '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">Comma- or newline-separated IPv4 networks (CIDR) or addresses. A bare address is treated as /32. Only these sources are served.</div>' +
            '</div>' +
            '<div id="dash-allip-warning" style="font-size:0.78rem;color:#f59e0b;margin-top:0.3rem;' + (dScope === "all" ? "" : "display:none") + '">' +
              'All-IPs means ANY host that can reach this server can view the wallboard (asset names, IPs, alert feeds) without logging in.' +
            '</div>' +
          '</div>' +
          '<div style="margin-top:0.5rem">' +
            '<button class="btn btn-sm btn-primary" id="dash-save-btn">Save</button>' +
            '<span style="font-size:0.82rem;color:var(--color-text-secondary);margin-left:0.8rem">Wallboard URL: <code>' + escapeHtml(window.location.origin) + '/dash</code></span>' +
          '</div>') +
    '</div>';

  var caCardHtml =
    '<div class="settings-card" style="display:flex;flex-direction:column">' +
      '<h4>Trusted Certificate Authorities</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">CA certificates used to verify remote servers when Polaris connects to integrations, syslog, and archive targets. Still operator-editable in proxy mode.</p>' +
      '<ul class="cert-list" id="ca-list"><li class="cert-empty">Loading...</li></ul>' +
      '<div style="margin-top:auto;padding-top:1rem">' +
        '<div class="upload-area" id="ca-upload-area">' +
          '<input type="file" id="ca-file-input" accept=".pem,.crt,.cer,.der">' +
          '<strong style="color:var(--color-text-primary)">Upload CA Certificate</strong>' +
          '<p>Click to select a .pem, .crt, or .cer file</p>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Local Login Access card — optional source-IP restriction on the local
  // login form (/login.html) and the password endpoints. Default off. This is
  // the companion to "Skip login page" (Users → Authentication → Session):
  // that setting hides the form from navigation, this one decides who may
  // reach it at all. SSO paths are never restricted.
  var la = _loginAccess;
  var laS = la && la.settings;
  var laScope = (laS && laS.ipScope) || "rfc1918";
  var laCidrs = (laS && Array.isArray(laS.allowedCidrs)) ? laS.allowedCidrs.join(", ") : "";
  var loginCardHtml =
    '<div class="settings-card">' +
      '<h4>Local Login Access</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Restrict which source networks may reach the local login form at <code>/login.html</code> and submit ' +
        'a username and password. <strong>SAML, OIDC and App Proxy sign-in are never restricted</strong> &mdash; only the ' +
        'password path, which carries local <em>and</em> LDAP accounts. Requests from disallowed sources are dropped. ' +
        'Leave this off unless remote users all sign in through SSO: /login.html is the way back in when the ' +
        'identity provider is down.' +
      '</p>' +
      (la === null
        ? '<p style="font-size:0.85rem;color:var(--color-text-secondary)">Unavailable &mdash; could not load the login access settings.</p>'
        : '<div class="form-group">' +
            '<label><input type="checkbox" id="la-enabled"' + (laS.enabled ? " checked" : "") + '> Restrict local login by source IP</label>' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Allowed source IPs</label>' +
            '<div style="display:flex;flex-direction:column;gap:0.3rem;margin-top:0.3rem">' +
              '<label><input type="radio" name="la-ip-scope" value="rfc1918"' + (laScope === "rfc1918" ? " checked" : "") + '> Private networks only (RFC1918 + loopback)</label>' +
              '<label><input type="radio" name="la-ip-scope" value="all"' + (laScope === "all" ? " checked" : "") + '> All source IPs (no restriction)</label>' +
              '<label><input type="radio" name="la-ip-scope" value="custom"' + (laScope === "custom" ? " checked" : "") + '> Custom networks</label>' +
            '</div>' +
            '<div id="la-custom-cidrs" style="margin-top:0.4rem;' + (laScope === "custom" ? "" : "display:none") + '">' +
              '<textarea id="la-allowed-cidrs" rows="3" placeholder="10.0.0.0/8, 192.168.10.0/24, 203.0.113.5" ' +
                'style="width:100%;font-family:monospace">' + escapeHtml(laCidrs) + '</textarea>' +
              '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">Comma- or newline-separated IPv4 networks (CIDR) or addresses. A bare address is treated as /32. Include your VPN pool if admins sign in remotely.</div>' +
            '</div>' +
            '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.5rem">' +
              'Polaris currently sees your browser as <code>' + escapeHtml(la.callerIp || "unknown") + '</code>. ' +
              'If that is a load balancer or proxy address rather than your own, every client looks the same to this ' +
              'setting and the restriction will not mean what it appears to &mdash; fix <code>TRUST_PROXY</code> first.' +
            '</div>' +
          '</div>' +
          '<div style="margin-top:0.5rem">' +
            '<button class="btn btn-sm btn-primary" id="la-save-btn">Save</button>' +
          '</div>') +
    '</div>';

  container.innerHTML = bannerHtml + certCardHtml + proxyCardHtml + dashCardHtml + loginCardHtml + caCardHtml;

  var adoptBtn = document.getElementById("proxy-adopt-btn");
  if (adoptBtn) adoptBtn.addEventListener("click", handleProxyAdopt);

  var dashSaveBtn = document.getElementById("dash-save-btn");
  if (dashSaveBtn) dashSaveBtn.addEventListener("click", handleDashSave);

  var laSaveBtn = document.getElementById("la-save-btn");
  if (laSaveBtn) laSaveBtn.addEventListener("click", handleLoginAccessSave);
  document.querySelectorAll('input[name="la-ip-scope"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      var custom = document.getElementById("la-custom-cidrs");
      if (custom) custom.style.display = radio.value === "custom" && radio.checked ? "" : "none";
    });
  });
  document.querySelectorAll('input[name="dash-ip-scope"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      if (!this.checked) return;
      var warn = document.getElementById("dash-allip-warning");
      if (warn) warn.style.display = this.value === "all" ? "" : "none";
      var custom = document.getElementById("dash-custom-cidrs");
      if (custom) custom.style.display = this.value === "custom" ? "" : "none";
    });
  });

  var rotateBtn = document.getElementById("proxy-rotate-cert-btn");
  if (rotateBtn) rotateBtn.addEventListener("click", openRotateCertModal);

  var presetSelect = document.getElementById("proxy-hsts-preset");
  if (presetSelect) {
    presetSelect.addEventListener("change", function () {
      if (this.value) {
        document.getElementById("proxy-hsts-max-age").value = this.value;
        this.value = "";
      }
    });
  }

  var http3Box = document.getElementById("proxy-http3-enabled");
  if (http3Box) {
    http3Box.addEventListener("change", function () {
      if (this.checked) {
        var tls13 = document.getElementById("proxy-tls-13");
        if (tls13) tls13.checked = true;
      }
    });
  }

  var applyBtn = document.getElementById("proxy-apply-btn");
  if (applyBtn) applyBtn.addEventListener("click", handleProxyApply);
}

async function handleLoginAccessSave() {
  var enabled = !!document.getElementById("la-enabled").checked;
  var scopeEl = document.querySelector('input[name="la-ip-scope"]:checked');
  var ipScope = scopeEl ? scopeEl.value : "rfc1918";

  var allowedCidrs = [];
  if (ipScope === "custom") {
    var raw = (document.getElementById("la-allowed-cidrs") || {}).value || "";
    allowedCidrs = raw.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (enabled && allowedCidrs.length === 0) {
      showToast("Add at least one network, or local login would be blocked from everywhere.", "error");
      return;
    }
  }

  // Enabling narrows the SSO-outage recovery path. Confirm with the stakes
  // named; the server refuses outright if the caller's own IP is excluded.
  if (enabled && !(await showConfirm(
    "Restrict the local login page to these networks? Anyone outside them \u2014 including admins working remotely \u2014 " +
    "will only be able to sign in through SSO, even if the identity provider is down."))) {
    return;
  }

  try {
    var result = await api.serverSettings.loginAccessPut({ enabled: enabled, ipScope: ipScope, allowedCidrs: allowedCidrs });
    if (result && result.loginAccess) {
      _loginAccess = { settings: result.loginAccess, callerIp: (_loginAccess && _loginAccess.callerIp) || "" };
    }
    showToast(enabled ? "Local login restricted by source IP" : "Local login source-IP restriction disabled");
  } catch (err) {
    showToast("Failed to save login access settings: " + (err.message || err), "error");
  }
}

async function handleDashSave() {
  var enabled = !!document.getElementById("dash-enabled").checked;
  var scopeEl = document.querySelector('input[name="dash-ip-scope"]:checked');
  var ipScope = scopeEl ? scopeEl.value : "rfc1918";

  var allowedCidrs = [];
  if (ipScope === "custom") {
    var raw = (document.getElementById("dash-allowed-cidrs") || {}).value || "";
    allowedCidrs = raw.split(/[\s,]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (enabled && allowedCidrs.length === 0) {
      showToast("Add at least one network, or an empty list would block every viewer.", "error");
      return;
    }
  }

  if (enabled && ipScope === "all" &&
      !(await showConfirm("Allow ALL source IPs to view the Dash wallboard without logging in?"))) {
    return;
  }

  try {
    var result = await api.serverSettings.dashPut({ enabled: enabled, ipScope: ipScope, allowedCidrs: allowedCidrs });
    _dashSettings = (result && result.dash) || { enabled: enabled, ipScope: ipScope, allowedCidrs: allowedCidrs };
    showToast(enabled ? "Dash wallboard enabled" : "Dash wallboard disabled");
  } catch (err) {
    showToast("Failed to save Dash settings: " + (err.message || err), "error");
  }
}

async function handleProxyAdopt() {
  if (!(await showConfirm("Adopt Polaris-managed nginx config mode? Hand-edits beyond the six controls will be overwritten on the next Apply."))) return;
  try {
    await api.serverSettings.proxyAdoptManagedMode();
    await loadCertificates();
  } catch (err) {
    showToast("Failed to adopt managed mode: " + (err.message || err), "error");
  }
}

function readProxyFormValues() {
  var tlsProtocols = [];
  if (document.getElementById("proxy-tls-12").checked) tlsProtocols.push("TLSv1.2");
  if (document.getElementById("proxy-tls-13").checked) tlsProtocols.push("TLSv1.3");
  var ipsRaw = document.getElementById("proxy-prometheus-ips").value || "";
  var ips = ipsRaw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  return {
    httpsPort: parseInt(document.getElementById("proxy-https-port").value, 10),
    http3Enabled: document.getElementById("proxy-http3-enabled").checked,
    tlsProtocols: tlsProtocols,
    hsts: {
      enabled: document.getElementById("proxy-hsts-enabled").checked,
      maxAgeSeconds: parseInt(document.getElementById("proxy-hsts-max-age").value, 10) || 0,
      includeSubDomains: document.getElementById("proxy-hsts-subdomains").checked,
      preload: document.getElementById("proxy-hsts-preload").checked,
    },
    prometheusAllowIps: ips,
  };
}

async function handleProxyApply() {
  var btn = document.getElementById("proxy-apply-btn");
  var status = document.getElementById("proxy-apply-status");
  var outBox = document.getElementById("proxy-apply-output");
  var body = readProxyFormValues();
  btn.disabled = true;
  status.style.display = "block";
  status.style.color = "var(--color-text-secondary)";
  status.textContent = "Rendering and reloading nginx…";
  outBox.style.display = "none";
  outBox.textContent = "";
  try {
    var res = await api.serverSettings.proxyApply(body);
    if (res.ok) {
      status.style.color = "var(--color-text-secondary)";
      status.innerHTML =
        '<span style="color:#4ade80">✓</span> Applied (sha256=' + escapeHtml(res.hash.slice(0, 12)) + '…). ' +
        'If you changed the port, open TCP+UDP/<strong>' + escapeHtml(String(body.httpsPort)) + '</strong> in your firewall.';
      if (res.listening) {
        outBox.style.display = "block";
        outBox.textContent = res.listening;
      }
      setTimeout(loadCertificates, 800);
    } else {
      status.style.color = "#ef4444";
      status.textContent = "✗ Apply failed. nginx -t output below.";
      outBox.style.display = "block";
      outBox.textContent = res.wrapperOutput || "(no output)";
    }
  } catch (err) {
    status.style.color = "#ef4444";
    status.textContent = "✗ " + (err.message || "Apply failed");
  } finally {
    btn.disabled = false;
  }
}

// ─── Rotate certificate modal: dual-pin stage → swap → retire workflow ──────

function openRotateCertModal() {
  // Uses the canonical openModal() (.modal structure) so it picks up the shared
  // modal CSS, drag, scrim-close, and accessibility behavior — was previously a
  // hand-rolled .modal-overlay/.modal-content that the canonical styles didn't
  // reach.
  var body =
    '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Four-step zero-downtime rotation: ' +
      '(1) upload the replacement pair; ' +
      '(2) stage the new pin on every active agent so they accept both old + new; ' +
      '(3) swap the cert file + reload nginx; ' +
      '(4) retire the old pin once you\'re confident every agent has reconnected.' +
    '</p>' +
    '<div class="form-group"><label for="rotate-cert-file">Certificate (.pem / .crt)</label>' +
      '<input type="file" id="rotate-cert-file" accept=".pem,.crt,.cer">' +
    '</div>' +
    '<div class="form-group"><label for="rotate-key-file">Private key (.pem / .key)</label>' +
      '<input type="file" id="rotate-key-file" accept=".pem,.key">' +
    '</div>' +
    '<div id="rotate-preflight" style="display:none;background:var(--color-surface);padding:0.8rem;border-radius:4px;margin-bottom:1rem;font-size:0.82rem"></div>' +
    '<div id="rotate-error" style="display:none;color:var(--color-danger);font-size:0.85rem;margin-bottom:1rem"></div>';
  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-secondary" id="rotate-preflight-btn">1. Preflight</button>' +
    '<button class="btn btn-secondary" id="rotate-stage-btn" disabled>2. Stage pin</button>' +
    '<button class="btn btn-primary" id="rotate-swap-btn" disabled>3. Swap cert</button>' +
    '<button class="btn btn-secondary" id="rotate-retire-btn" disabled>4. Retire old pin</button>';
  openModal("Rotate HTTPS certificate", body, footer, { wide: true });

  var state = { preflight: null, oldFingerprint: null };

  function showError(msg) {
    var box = document.getElementById("rotate-error");
    box.style.display = "block";
    box.textContent = msg;
  }
  function clearError() {
    document.getElementById("rotate-error").style.display = "none";
  }
  function updatePreflightDisplay(extraNote) {
    var box = document.getElementById("rotate-preflight");
    if (!state.preflight) { box.style.display = "none"; return; }
    box.style.display = "block";
    box.innerHTML =
      '<div style="font-family:monospace;margin-bottom:0.4rem">' +
        '<strong>New fingerprint:</strong> ' + escapeHtml(state.preflight.newFingerprint) + '<br>' +
        '<strong>CN:</strong> ' + escapeHtml(state.preflight.newCn || "(none)") + '<br>' +
        '<strong>DNS SANs:</strong> ' + escapeHtml((state.preflight.newDnsSans || []).join(", ") || "(none)") + '<br>' +
        '<strong>Expiry:</strong> ' + escapeHtml(state.preflight.newExpiresAt ? formatDate(state.preflight.newExpiresAt) : "(unknown)") + '<br>' +
        '<strong>Current pin to retire:</strong> ' + escapeHtml(state.oldFingerprint || "(none)") +
      '</div>' +
      (extraNote || "");
  }

  document.getElementById("rotate-preflight-btn").addEventListener("click", async function () {
    clearError();
    var certFile = document.getElementById("rotate-cert-file").files[0];
    var keyFile = document.getElementById("rotate-key-file").files[0];
    if (!certFile || !keyFile) { showError("Select both a cert and key file."); return; }
    this.disabled = true;
    try {
      state.preflight = await api.serverSettings.proxyCertPreflight(certFile, keyFile);
      state.oldFingerprint = state.preflight.currentFingerprint;
      updatePreflightDisplay('<div style="color:#f59e0b">Click <strong>Stage pin</strong> next.</div>');
      document.getElementById("rotate-stage-btn").disabled = false;
    } catch (err) {
      showError(err.message || "Preflight failed");
      this.disabled = false;
    }
  });

  document.getElementById("rotate-stage-btn").addEventListener("click", async function () {
    if (!state.preflight) return;
    clearError();
    this.disabled = true;
    try {
      var result = await api.serverSettings.agentCertPinBulkAdd(state.preflight.newFingerprint);
      updatePreflightDisplay(
        '<div style="color:#4ade80">✓ Staged on ' + escapeHtml(String(result.added)) +
        ' agent(s); ' + escapeHtml(String(result.alreadyPresent)) + ' already had the pin. ' +
        'Total active: ' + escapeHtml(String(result.totalActive)) + '. ' +
        'Agents apply the new pin within seconds via WS push (offline agents pick it up on next /config poll). ' +
        'Verify uptake at <a href="#" id="rotate-summary-link">cert-pins summary</a> or just wait ~30s, ' +
        'then click <strong>Swap cert</strong>.</div>',
      );
      document.getElementById("rotate-summary-link").addEventListener("click", async function (ev) {
        ev.preventDefault();
        var summary = await api.serverSettings.agentCertPinsSummary();
        var entry = (summary.pins || []).find(function (p) { return p.pin === state.preflight.newFingerprint.toLowerCase(); });
        var have = entry ? entry.canonical + entry.staged : 0;
        showToast("Cert pin uptake: " + have + " / " + summary.totalActiveAgents + " active agents have the new pin.");
      });
      document.getElementById("rotate-swap-btn").disabled = false;
    } catch (err) {
      showError(err.message || "Stage failed");
      this.disabled = false;
    }
  });

  document.getElementById("rotate-swap-btn").addEventListener("click", async function () {
    if (!state.preflight) return;
    if (!(await showConfirm("Swap /etc/polaris-nginx/{cert,key}.pem and reload nginx? Make sure all active agents have heartbeated with the new pin staged."))) return;
    clearError();
    this.disabled = true;
    try {
      var result = await api.serverSettings.proxyCertRotate({
        certPem: state.preflight.certPem,
        keyPem: state.preflight.keyPem,
      });
      if (result.ok) {
        updatePreflightDisplay(
          '<div style="color:#4ade80">✓ Cert swapped + nginx reloaded. New fingerprint live. ' +
          (state.oldFingerprint
            ? 'Click <strong>Retire old pin</strong> to remove <code>' + escapeHtml(state.oldFingerprint) + '</code> from every agent\'s accepted set.'
            : 'No previous pin recorded — nothing to retire.') +
          '</div>',
        );
        if (state.oldFingerprint) {
          document.getElementById("rotate-retire-btn").disabled = false;
        }
      } else {
        showError("Rotate failed. nginx output: " + (result.wrapperOutput || "(no output)"));
        this.disabled = false;
      }
    } catch (err) {
      showError(err.message || "Rotate failed");
      this.disabled = false;
    }
  });

  document.getElementById("rotate-retire-btn").addEventListener("click", async function () {
    if (!state.oldFingerprint) return;
    if (!(await showConfirm("Retire the previous pin (" + state.oldFingerprint + ") from every active agent's accepted set? Skipped on any agent where it would be the last pin."))) return;
    clearError();
    this.disabled = true;
    try {
      var result = await api.serverSettings.agentCertPinBulkRemove(state.oldFingerprint);
      var msg = "Retired on " + result.removed + " agent(s)";
      if (result.lastPinSkipped > 0) msg += "; " + result.lastPinSkipped + " skipped (would have been last pin)";
      showToast(msg + ". Rotation complete.");
      closeModal();
      await loadCertificates();
    } catch (err) {
      showError(err.message || "Retire failed");
      this.disabled = false;
    }
  });
}

async function loadCertificates() {
  _certsLoaded = true;
  var container = document.getElementById("tab-certificates");

  try {
    _httpsSettings = await api.serverSettings.getHttps();
  } catch (_) {}

  try {
    _proxyData = await api.serverSettings.proxyGet();
  } catch (_) { _proxyData = null; }

  try {
    var dashResp = await api.serverSettings.dashGet();
    _dashSettings = (dashResp && dashResp.dash) || null;
  } catch (_) { _dashSettings = null; }

  try {
    var laResp = await api.serverSettings.loginAccessGet();
    _loginAccess = laResp && laResp.loginAccess
      ? { settings: laResp.loginAccess, callerIp: laResp.callerIp || "" }
      : null;
  } catch (_) { _loginAccess = null; }

  renderCertsTab(container);
  wireUploadArea("ca-upload-area", "ca-file-input", uploadCA);
  await refreshCertLists();
}

function wireUploadArea(areaId, inputId, handler) {
  var area = document.getElementById(areaId);
  var input = document.getElementById(inputId);
  area.addEventListener("click", function () { input.click(); });
  input.addEventListener("change", function () {
    if (input.files.length > 0) handler(Array.from(input.files));
    input.value = "";
  });
}

async function refreshCertLists() {
  try {
    _certData = await api.serverSettings.listCerts();
  } catch (_) {
    _certData = { trustedCAs: [], serverCerts: [] };
  }
  renderCAList();
}

function certIconSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>';
}

function renderCAList() {
  var list = document.getElementById("ca-list");
  if (!_certData.trustedCAs.length) {
    list.innerHTML = '<li class="cert-empty">No trusted CAs uploaded. Polaris will use the system trust store.</li>';
    return;
  }
  list.innerHTML = _certData.trustedCAs.map(function (cert) {
    return '<li class="cert-item">' +
      '<div class="cert-icon">' + certIconSvg() + '</div>' +
      '<div class="cert-info">' +
        '<div class="cert-name">' + escapeHtml(cert.name) + '</div>' +
        '<div class="cert-meta">' + escapeHtml(cert.subject || "Unknown subject") +
          (cert.expiresAt ? ' &middot; Expires ' + formatDate(cert.expiresAt) : '') +
          ' &middot; Uploaded ' + formatDate(cert.uploadedAt) +
        '</div>' +
      '</div>' +
      '<div class="cert-actions">' +
        '<button class="btn btn-sm btn-danger" onclick="deleteCA(\'' + cert.id + '\', \'' + escapeHtml(cert.name) + '\')">Remove</button>' +
      '</div>' +
    '</li>';
  }).join("");
}

async function uploadCA(files) {
  for (var i = 0; i < files.length; i++) {
    try {
      await api.serverSettings.uploadCert("ca", files[i]);
      showToast("CA certificate uploaded: " + files[i].name);
    } catch (err) {
      showToast("Failed to upload " + files[i].name + ": " + err.message, "error");
    }
  }
  await refreshCertLists();
}

async function deleteCA(id, name) {
  var ok = await showConfirm('Remove trusted CA "' + name + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteCert(id);
    showToast("CA removed");
    await refreshCertLists();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Maintenance Tab ───────────────────────────────────────────────────────

var _dbLoaded = false;
var _advisorJustStaged = false;
var _retentionLoaded = false;

// ─── Retention Tab (sample retention only — event retention lives on the
//                    Events Settings page) ─────────────────────────────────
//
// Lazy-loaded on first click of the Retention tab. Fetches the global
// Setting("sampleRetention") via api.serverSettings.getSampleRetention()
// and reuses the existing renderSampleRetentionCard / _wireSampleRetentionCard
// helpers. Was previously crammed into the Maintenance tab; phase 7 moved
// it here so the Maintenance tab keeps its DB-health focus.

async function loadRetentionTab() {
  var container = document.getElementById("tab-retention");
  if (!container) return;
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading retention settings…</p></div>';
  try {
    var results = await Promise.allSettled([
      api.serverSettings.getSampleRetention(),
      api.serverSettings.getAgentEventLog(),
    ]);
    if (results[0].status === "rejected") throw results[0].reason;
    var retention = results[0].value && results[0].value.retention ? results[0].value.retention : null;
    var eventLogCfg = results[1].status === "fulfilled" && results[1].value && results[1].value.config
      ? results[1].value.config
      : null;
    _retentionLoaded = true;
    container.innerHTML = renderSampleRetentionCard(retention) + renderAgentEventLogCard(eventLogCfg);
    _wireSampleRetentionCard();
    _wireAgentEventLogCard();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err && err.message ? err.message : String(err)) + '</p></div>';
  }
}

// ─── Agent OS event-log collection card ───────────────────────────────────
// Global master switch + curation filter for the OS event-log → audit Events
// ingest. Default disabled; opt-in. Sits on the Retention tab because it
// governs how much host-event data flows into the (retention-bounded) audit
// log. Backed by Setting("agentEventLog") via api.serverSettings.getAgentEventLog().
function renderAgentEventLogCard(cfg) {
  var c = cfg || {};
  var enabled = c.enabled === true;
  var minLevel = c.minLevel === "info" || c.minLevel === "warning" || c.minLevel === "error" ? c.minLevel : "error";
  var channels = Array.isArray(c.windowsChannels) ? c.windowsChannels.join(", ") : "System, Application";
  var linuxPri = (typeof c.linuxMinPriority === "number") ? c.linuxMinPriority : 3;
  var maxPush  = (typeof c.maxPerPush === "number") ? c.maxPerPush : 100;
  var hourlyCap = (typeof c.perAssetHourlyCap === "number") ? c.perAssetHourlyCap : 500;
  function lvlOpt(v, label) { return '<option value="' + v + '"' + (minLevel === v ? " selected" : "") + '>' + label + '</option>'; }
  return '<div class="settings-card" id="agent-event-log-card" style="margin-top:1rem">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
      '<h4 style="margin:0">Agent OS Event Log</h4>' +
      '<button class="btn btn-primary" id="btn-agent-event-log-save">Save</button>' +
    '</div>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.85rem">' +
      'When enabled, Polaris Agents ship matching OS event-log entries (Windows Event Log / Linux journald) which appear on each asset\'s <strong>Events</strong> tab and forward through your syslog / SFTP archival. Off by default. ' +
      'Event messages can contain hostnames or sensitive text — keep the severity filter tight and review before relying on it for compliance.' +
    '</p>' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;margin-bottom:0.85rem">' +
      '<input type="checkbox" id="ael-enabled" style="width:15px;height:15px"' + (enabled ? " checked" : "") + '>' +
      '<span style="font-size:0.9rem;font-weight:600">Collect OS event logs from agents</span>' +
    '</label>' +
    '<div class="form-row" style="gap:14px;flex-wrap:wrap">' +
      '<div style="min-width:160px"><label for="ael-min-level">Minimum severity</label>' +
        '<select id="ael-min-level">' + lvlOpt("error", "Error + Critical") + lvlOpt("warning", "Warning and up") + lvlOpt("info", "Info and up") + '</select>' +
        '<p class="hint" style="font-size:0.74rem">Lower = more volume in the audit log.</p>' +
      '</div>' +
      '<div style="min-width:120px"><label for="ael-linux-pri">Linux journald priority ≤</label>' +
        '<input type="number" id="ael-linux-pri" min="0" max="7" value="' + linuxPri + '" style="width:90px">' +
        '<p class="hint" style="font-size:0.74rem">0 emerg … 7 debug (3 = err).</p>' +
      '</div>' +
    '</div>' +
    '<div class="form-group" style="margin-top:0.6rem"><label for="ael-win-channels">Windows channels</label>' +
      '<input type="text" id="ael-win-channels" value="' + escapeHtml(channels) + '" placeholder="System, Application" style="width:100%;max-width:420px">' +
      '<p class="hint" style="font-size:0.74rem">Comma-separated Windows Event Log channel names.</p>' +
    '</div>' +
    '<div class="form-row" style="gap:14px;flex-wrap:wrap;margin-top:0.6rem">' +
      '<div style="min-width:140px"><label for="ael-max-push">Max entries per push</label>' +
        '<input type="number" id="ael-max-push" min="1" max="5000" value="' + maxPush + '" style="width:110px"></div>' +
      '<div style="min-width:160px"><label for="ael-hourly-cap">Per-asset hourly cap</label>' +
        '<input type="number" id="ael-hourly-cap" min="1" max="100000" value="' + hourlyCap + '" style="width:120px">' +
        '<p class="hint" style="font-size:0.74rem">Overflow is summarized into one event.</p>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function _wireAgentEventLogCard() {
  var saveBtn = document.getElementById("btn-agent-event-log-save");
  if (!saveBtn) return;
  saveBtn.addEventListener("click", async function () {
    var channelsRaw = (document.getElementById("ael-win-channels").value || "");
    var payload = {
      enabled: document.getElementById("ael-enabled").checked === true,
      minLevel: document.getElementById("ael-min-level").value,
      windowsChannels: channelsRaw.split(",").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; }),
      linuxMinPriority: parseInt(document.getElementById("ael-linux-pri").value, 10),
      maxPerPush: parseInt(document.getElementById("ael-max-push").value, 10),
      perAssetHourlyCap: parseInt(document.getElementById("ael-hourly-cap").value, 10),
    };
    saveBtn.disabled = true;
    try {
      await api.serverSettings.setAgentEventLog(payload);
      showToast("Agent OS event-log settings saved", "success");
    } catch (err) {
      showToast("Save failed: " + (err && err.message ? err.message : String(err)), "error");
    } finally {
      saveBtn.disabled = false;
    }
  });
}

// api.js formatBytes with the capacity card's em-dash for missing kept.
function _capacityFormatBytes(b) {
  if (b == null) return "—";
  return formatBytes(b);
}

function _capacityFormatPct(num, denom) {
  if (denom == null || denom <= 0) return "—";
  return Math.round((num / denom) * 100) + "%";
}

function _capacitySeverityLabel(s) {
  // Accept both the new vocabulary (critical/warning/watch/ok) and the
  // legacy color names (red/amber) so a stale snapshot returned from an
  // older server build still renders cleanly during a partial rollout.
  if (s === "critical" || s === "red") return "Critical";
  if (s === "warning" || s === "amber") return "Action recommended";
  if (s === "watch") return "Watch";
  return "Healthy";
}

// CSS classes for the capacity pills/cards stay on the color vocabulary
// (`capacity-pill-red`, `capacity-reason-amber`, etc.) — they're tied to
// the actual colors, not to severity names, so renaming the enum doesn't
// change them. This helper maps a severity to its CSS class suffix.
function _capacitySeverityCssClass(s) {
  if (s === "critical" || s === "red") return "red";
  if (s === "warning" || s === "amber") return "amber";
  if (s === "watch") return "watch";
  return "ok";
}

// Friendly label for a volume's set of roles. Matches the backend's
// `volumeLabel()` so the UI and the audit-log Event message use the same
// terminology.
function _capacityVolumeLabel(roles) {
  if (!roles || !roles.length) return "Volume";
  if (roles.length === 1) {
    if (roles[0] === "db") return "Database volume";
    if (roles[0] === "app") return "Application volume";
    if (roles[0] === "state") return "State volume";
    if (roles[0] === "backups") return "Backups volume";
  }
  if (roles.indexOf("db") !== -1 && roles.indexOf("app") !== -1) return "Application + DB volume";
  if (roles.indexOf("db") !== -1) return "DB volume";
  return "Application volume";
}

// Render one volume row inside the Application host card. Bar-style indicator
// gives the operator a quick at-a-glance read on each filesystem; numeric
// detail is shown alongside.
function _capacityRenderVolume(v) {
  if (!v || !v.totalBytes) return "";
  var pct = v.freeBytes / v.totalBytes;
  var pctLabel = (pct * 100).toFixed(1) + "%";
  var barClass = "capacity-bar capacity-bar-ok";
  if (pct < 0.10) barClass = "capacity-bar capacity-bar-red";
  else if (pct < 0.20) barClass = "capacity-bar capacity-bar-amber";
  else if (pct < 0.30) barClass = "capacity-bar capacity-bar-watch";
  // Used % is the inverse of free %; show that bar so a fuller volume reads
  // as a longer/redder bar (the conventional disk-meter direction).
  var usedPct = (1 - pct) * 100;
  var pathLabel = (v.paths && v.paths.length) ? v.paths.join(", ") : "—";
  var rolesLabel = _capacityVolumeLabel(v.roles);
  return (
    '<div style="display:flex;flex-direction:column;gap:0.2rem;margin-bottom:0.55rem">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.5rem">' +
        '<span style="font-size:0.82rem;font-weight:600">' + escapeHtml(rolesLabel) + '</span>' +
        '<span style="font-size:0.78rem;color:var(--color-text-secondary)">' +
          _capacityFormatBytes(v.freeBytes) + ' free of ' + _capacityFormatBytes(v.totalBytes) + ' (' + escapeHtml(pctLabel) + ')' +
        '</span>' +
      '</div>' +
      '<div style="height:6px;background:var(--color-bg-tertiary, rgba(127,127,127,0.18));border-radius:3px;overflow:hidden">' +
        '<div class="' + barClass + '" style="height:100%;width:' + Math.min(100, Math.max(0, usedPct)).toFixed(1) + '%"></div>' +
      '</div>' +
      '<div style="font-size:0.74rem;color:var(--color-text-tertiary);font-family:var(--font-mono, monospace)">' + escapeHtml(pathLabel) + '</div>' +
    '</div>'
  );
}

// Combined Database Engine + Connection Pool stat card. The two sets of
// fields are tightly related (engine identity + its live connection
// state) and were taking up two cards' worth of horizontal space — fold
// them into one card with sub-headings so the Maintenance tab reads as
// host / database / engine+pool / monitoring rather than four narrow
// columns where the engine and pool barely overlap on what they tell
// the operator.
function renderEnginePoolStatHtml(db, capacity) {
  if (!db) return "";
  var hasPool = db.uptime || db.activeConnections !== undefined || db.maxConnections !== undefined;

  var engineRows =
    dbInfoRow("Type", db.type || "Unknown") +
    dbInfoRow("Version", db.version || "Unknown") +
    (db.host ? dbInfoRow("Host", db.host + (db.port ? ":" + db.port : "")) : "") +
    (db.database ? dbInfoRow("Database", db.database) : "") +
    (db.ssl ? dbInfoRow("SSL", db.ssl) : "");

  // Polaris-side pool sizing comes from the capacity snapshot. Render
  // alongside the DB-side counters so operators see configured capacity
  // (Prisma + pg-boss) and observed usage (current + peak) on one card
  // without having to cross-reference the snapshot JSON.
  var pollPool = capacity && capacity.database && capacity.database.connectionPool;
  var polarisPoolRows = "";
  if (pollPool) {
    var prismaSize = pollPool.prismaPoolSize;
    var pgbossSize = pollPool.pgbossPoolSize;
    var configured = prismaSize + (pgbossSize || 0);
    var configuredLabel = pgbossSize !== null && pgbossSize !== undefined
      ? configured + ' (Prisma ' + prismaSize + ' + pg-boss ' + pgbossSize + ')'
      : String(configured);
    polarisPoolRows =
      dbInfoRow("Polaris pool size", configuredLabel) +
      dbInfoRow("Peak observed", String(pollPool.peakObserved));
  }

  var poolRows = hasPool
    ? (db.activeConnections !== undefined ? dbInfoRow("Active connections", db.activeConnections) : "") +
      (db.maxConnections !== undefined ? dbInfoRow("Max connections", db.maxConnections) : "") +
      polarisPoolRows +
      (db.uptime ? dbInfoRow("Uptime", db.uptime) : "")
    : polarisPoolRows;

  return '<div class="capacity-stat-card">' +
    '<h5>Database engine</h5>' +
    '<div class="db-info-grid">' + engineRows + '</div>' +
    (poolRows
      ? '<h5 style="margin-top:0.85rem">Connection pool</h5>' +
        '<div class="db-info-grid">' + poolRows + '</div>'
      : '') +
  '</div>';
}

// ─── Capacity Advisor card ────────────────────────────────────────────────

// Lever rows are grouped into three sections so the operator can scan them
// quickly:
//   - "queue":         the QUEUE_MODE lever (queue-mode-endpoint apply)
//   - "env":           DATABASE_POOL_SIZE / POLARIS_PGBOSS_POOL_SIZE / per-cadence workers
//   - "advisory":      PG_MAX_CONNECTIONS / PG_* tuning (no Stage button)
function _advisorSection(rec) {
  if (rec.key === "QUEUE_MODE") return "queue";
  if (rec.applyMode === "advisory-only") return "advisory";
  return "env";
}

// Friendly labels for the levers shown in the table.
function _advisorLabel(key) {
  switch (key) {
    case "QUEUE_MODE":                       return "Queue mode";
    case "DATABASE_POOL_SIZE":               return "DATABASE_POOL_SIZE (Prisma pool)";
    case "POLARIS_PGBOSS_POOL_SIZE":         return "POLARIS_PGBOSS_POOL_SIZE";
    case "POLARIS_MONITOR_PROBE_WORKERS":    return "POLARIS_MONITOR_PROBE_WORKERS";
    case "POLARIS_MONITOR_FAST_WORKERS":     return "POLARIS_MONITOR_FAST_WORKERS";
    case "POLARIS_MONITOR_HEAVY_WORKERS":    return "POLARIS_MONITOR_HEAVY_WORKERS";
    case "POLARIS_MONITOR_FLOATING_WORKERS": return "POLARIS_MONITOR_FLOATING_WORKERS";
    case "POLARIS_PROBE_CONCURRENCY":        return "POLARIS_PROBE_CONCURRENCY (cursor)";
    case "POLARIS_HEAVY_CONCURRENCY":        return "POLARIS_HEAVY_CONCURRENCY (cursor)";
    case "PG_MAX_CONNECTIONS":               return "PostgreSQL max_connections";
    case "PG_SHARED_BUFFERS":                return "shared_buffers";
    case "PG_EFFECTIVE_CACHE_SIZE":          return "effective_cache_size";
    case "PG_WORK_MEM":                      return "work_mem";
    case "PG_RANDOM_PAGE_COST":              return "random_page_cost";
    default:                                 return key;
  }
}

// Filter the advisor's full recommendation list down to what's relevant to
// the recommended queue mode. Cursor mode hides POLARIS_MONITOR_*_WORKERS +
// POLARIS_PGBOSS_POOL_SIZE; pg-boss mode hides POLARIS_*_CONCURRENCY.
function _advisorRecommendationsForView(advisor) {
  if (!advisor || !Array.isArray(advisor.recommendations)) return [];
  var mode = advisor.recommendedQueueMode || "cursor";
  return advisor.recommendations.filter(function (r) {
    if (mode === "pgboss") {
      return r.key !== "POLARIS_PROBE_CONCURRENCY" && r.key !== "POLARIS_HEAVY_CONCURRENCY";
    }
    return r.key !== "POLARIS_PGBOSS_POOL_SIZE" &&
           r.key !== "POLARIS_MONITOR_PROBE_WORKERS" &&
           r.key !== "POLARIS_MONITOR_FAST_WORKERS" &&
           r.key !== "POLARIS_MONITOR_HEAVY_WORKERS" &&
           r.key !== "POLARIS_MONITOR_FLOATING_WORKERS";
  });
}

function _advisorRowHtml(rec, advisor, pgConfigFile) {
  var section = _advisorSection(rec);
  var label = _advisorLabel(rec.key);
  var current = rec.current === null || rec.current === undefined ? "—" : String(rec.current);
  var recommended = String(rec.recommended);
  // operatorOverride wins: the value was set explicitly via ALTER SYSTEM
  // (postgresql.auto.conf), so it's a deliberate choice the advisor honors —
  // never "Stage", even when it differs from the heuristic recommendation.
  var pillCls, pillLabel;
  if (rec.operatorOverride) {
    pillCls = "advisor-pill advisor-pill-ok";
    pillLabel = "Operator-set";
  } else if (rec.changeRequired) {
    pillCls = "advisor-pill advisor-pill-change";
    pillLabel = "Stage";
  } else {
    pillCls = "advisor-pill advisor-pill-ok";
    pillLabel = "OK";
  }

  // Cold-start badge for cadence-driven rows.
  var coldStartBadge = "";
  var coldKeys = ["POLARIS_MONITOR_PROBE_WORKERS","POLARIS_MONITOR_FAST_WORKERS","POLARIS_MONITOR_HEAVY_WORKERS","POLARIS_MONITOR_FLOATING_WORKERS","POLARIS_PROBE_CONCURRENCY","POLARIS_HEAVY_CONCURRENCY"];
  if (advisor && advisor.usingColdStartDefaults && coldKeys.indexOf(rec.key) !== -1) {
    coldStartBadge = ' <span class="advisor-cold-badge" title="Histogram samples insufficient — using cold-start defaults until populated">cold-start</span>';
  }
  // "Applies after queue-mode flip" hint for cursor-only / pgboss-only levers
  // when the recommended mode differs from the active mode.
  var modeFlipHint = "";
  if (rec.appliesAfterQueueModeFlip) {
    modeFlipHint = ' <span class="advisor-cold-badge" title="Takes effect after the queue-mode flip is applied">post-flip</span>';
  }
  var overrideNote = rec.operatorOverride
    ? " — set explicitly via ALTER SYSTEM (postgresql.auto.conf); advisory recommendation overridden"
    : "";
  var tooltip = "";
  if (rec.breakdown && typeof rec.breakdown === "object") {
    try {
      var parts = Object.keys(rec.breakdown).map(function (k) { return k + "=" + rec.breakdown[k]; });
      tooltip = ' title="' + escapeHtml(rec.rationale + " — " + parts.join(", ") + overrideNote) + '"';
    } catch (e) {
      tooltip = ' title="' + escapeHtml((rec.rationale || "") + overrideNote) + '"';
    }
  } else if (rec.rationale || overrideNote) {
    tooltip = ' title="' + escapeHtml((rec.rationale || "") + overrideNote) + '"';
  }

  // Checkbox column: shown only on env / queue rows where changeRequired = true.
  var checkboxCell = "";
  if (section !== "advisory") {
    if (rec.changeRequired) {
      checkboxCell = '<input type="checkbox" class="advisor-stage-checkbox" data-key="' + escapeHtml(rec.key) + '" checked>';
    } else {
      checkboxCell = '<span class="muted">—</span>';
    }
  } else if (rec.key === "PG_MAX_CONNECTIONS" || rec.key === "PG_SHARED_BUFFERS" || rec.key === "PG_EFFECTIVE_CACHE_SIZE" || rec.key === "PG_WORK_MEM" || rec.key === "PG_RANDOM_PAGE_COST") {
    // Advisory-only rows: surface the pgConfigFile hint inline on the last advisory row.
    checkboxCell = '<span class="muted">manual</span>';
  }

  return '<tr class="advisor-row advisor-row-' + section + (rec.changeRequired ? " advisor-row-change" : "") + '"' + tooltip + '>' +
    '<td>' + escapeHtml(label) + coldStartBadge + modeFlipHint + '</td>' +
    '<td class="mono">' + escapeHtml(current) + '</td>' +
    '<td class="mono">' + escapeHtml(recommended) + '</td>' +
    '<td><span class="' + pillCls + '">' + pillLabel + '</span></td>' +
    '<td style="text-align:center">' + checkboxCell + '</td>' +
  '</tr>';
}

function renderCapacityAdvisorCard(advisor, pgConfigFile, dbConnectionMode) {
  if (!advisor) return "";
  var recs = _advisorRecommendationsForView(advisor);
  if (recs.length === 0) return "";

  var headerNote = advisor.anyChangeRequired
    ? '<span class="advisor-header-amber">' + recs.filter(function (r) { return r.changeRequired; }).length + ' recommendation' + (recs.filter(function (r) { return r.changeRequired; }).length === 1 ? "" : "s") + ' available</span>'
    : '<span class="advisor-header-ok">All settings at or above recommended</span>';

  var coldStartNote = advisor.usingColdStartDefaults
    ? '<p class="hint" style="margin:0.4rem 0 0 0;font-size:0.78rem">Some cadences are using cold-start defaults until the histogram populates (~24h). Recommendations may shift once real workload duration data is observed.</p>'
    : "";

  // PgBouncer mode shifts what max_connections actually needs to support:
  // PgBouncer multiplexes Polaris's pool slots onto a much smaller backend
  // pool, so the advisor's max_connections recommendation is an upper bound
  // rather than a strict requirement under this topology.
  var pgbouncerNote = dbConnectionMode === "pgbouncer"
    ? '<p class="hint" style="margin:0.4rem 0 0 0;font-size:0.78rem;color:var(--color-text-secondary)">PgBouncer detected. Polaris\'s pool size is what it opens to PgBouncer; PgBouncer\'s <code>default_pool_size</code> is what reaches PostgreSQL. The <code>PostgreSQL max_connections</code> recommendation below is a conservative upper bound — your actual PG max only needs to support PgBouncer\'s configured pool sizes plus admin/autovacuum overhead.</p>'
    : "";

  var groupedRows = {
    queue: recs.filter(function (r) { return _advisorSection(r) === "queue"; }),
    env:   recs.filter(function (r) { return _advisorSection(r) === "env";   }),
    advisory: recs.filter(function (r) { return _advisorSection(r) === "advisory"; }),
  };

  function renderRows(list) {
    return list.map(function (r) { return _advisorRowHtml(r, advisor, pgConfigFile); }).join("");
  }

  var staged = recs.filter(function (r) { return r.applyMode !== "advisory-only" && r.changeRequired; }).length;
  var stageBtn;
  if (_advisorJustStaged && staged === 0) {
    stageBtn = '<button class="btn btn-warning" id="capacity-advisor-restart-btn">Restart Polaris to apply</button>';
  } else if (staged > 0) {
    stageBtn = '<button class="btn btn-primary" id="capacity-advisor-stage-btn" data-staged-count="' + staged + '">Stage selected</button>';
  } else {
    stageBtn = '<button class="btn btn-primary" disabled>Stage selected</button>';
  }

  var pgConfigHint = pgConfigFile
    ? '<p class="hint" style="margin:0.4rem 0 0 0;font-size:0.78rem">Advisory-only settings live in <code>' + escapeHtml(pgConfigFile) + '</code>. Edit and restart PostgreSQL to apply.</p>'
    : "";

  return '<div class="settings-card capacity-advisor-card" id="capacity-advisor-card">' +
    '<div class="capacity-header">' +
      '<h4 style="margin:0">Capacity Advisor</h4>' +
      headerNote +
    '</div>' +
    coldStartNote +
    pgbouncerNote +
    // Half-width card since the Maintenance reorder — the five fixed columns
    // no longer fit at every viewport, so the table scrolls inside its own
    // container rather than crushing the Setting column or the grid cell.
    '<div style="overflow-x:auto;margin-top:0.75rem">' +
    '<table class="ip-table advisor-table" style="width:100%;min-width:36rem">' +
      '<thead><tr>' +
        '<th>Setting</th>' +
        '<th style="width:8rem">Current</th>' +
        '<th style="width:8rem">Recommended</th>' +
        '<th style="width:6rem">Status</th>' +
        '<th style="width:5rem;text-align:center">Stage</th>' +
      '</tr></thead>' +
      '<tbody>' +
        (groupedRows.queue.length ? renderRows(groupedRows.queue) : "") +
        (groupedRows.env.length
          ? '<tr class="advisor-divider"><td colspan="5"><strong>Pool &amp; worker (apply via .env, restart Polaris)</strong></td></tr>' + renderRows(groupedRows.env)
          : "") +
        (groupedRows.advisory.length
          ? '<tr class="advisor-divider"><td colspan="5"><strong>Advisory-only (require PostgreSQL restart)</strong></td></tr>' + renderRows(groupedRows.advisory)
          : "") +
      '</tbody>' +
    '</table>' +
    '</div>' +
    pgConfigHint +
    '<div style="margin-top:0.85rem;display:flex;align-items:center;gap:0.75rem">' +
      stageBtn +
      '<span class="hint" style="font-size:0.78rem">Computed ' + escapeHtml(formatLocalTime(advisor.computedAt)) + '. Restart Polaris after Stage to pick up changes.</span>' +
    '</div>' +
  '</div>';
}

// ─── Platform Lifecycle card ──────────────────────────────────────────────
//
// What this host is running, and whether any of it is past or approaching end
// of life. Data comes from GET /server-settings/platform-lifecycle, which
// grades the observed stack against the committed, human-reviewed dataset in
// src/data/platformEol.json.
//
// Deliberately NO action buttons: nothing on this card is one-click fixable,
// and offering a button that cannot do the thing would be a lie. Contrast the
// two capacity reason codes that legitimately get one.

function _lifecycleStateLabel(state) {
  if (state === "below_minimum") return "Below minimum";
  if (state === "eol") return "End of life";
  if (state === "eol_extended") return "EOL (extended support)";
  if (state === "approaching_eol") return "Approaching EOL";
  if (state === "aging") return "Aging";
  // Distinct from "Aging" on purpose: this row is below the version Polaris
  // targets, which is a preference and not a date. "Aging" here was misread as
  // "needs upgrading" for a component with 386 days of support left.
  if (state === "behind_target") return "Behind target";
  if (state === "ahead_of_tested") return "Ahead of tested";
  if (state === "current") return "Current";
  if (state === "not_installed") return "Not installed";
  return "Unknown";
}

// "in 74 days" / "131 days ago" reads faster than a bare date, and the date is
// alongside it anyway.
function _lifecycleWhen(grade) {
  if (grade.daysUntilEol === null || grade.daysUntilEol === undefined) return "";
  var d = grade.daysUntilEol;
  if (d === 0) return "today";
  if (d > 0) return "in " + d + " day" + (d === 1 ? "" : "s");
  return -d + " day" + (d === -1 ? "" : "s") + " ago";
}

function _lifecycleRowHtml(c) {
  var g = c.grade || {};
  var css = _capacitySeverityCssClass(g.severity === "none" ? "ok" : g.severity);
  var when = _lifecycleWhen(g);

  var supportedUntil = g.eolAt
    ? escapeHtml(g.eolAt) + (when ? ' <span class="hint" style="font-size:0.72rem">(' + escapeHtml(when) + ')</span>' : "")
    : (c.policy === "dated" ? '<span class="hint">—</span>' : '<span class="hint">no published date</span>');

  var installed = c.observedVersion
    ? escapeHtml(c.observedVersion)
    : '<span class="hint">' + escapeHtml(c.probeStatus === "absent" ? "not installed" : "unknown") + "</span>";

  // probeNote can carry raw `go version` / `nginx -v` output from the host, so
  // it is escaped like everything else even though the dataset is committed.
  var titleAttr = c.probeNote ? ' title="' + escapeHtml(c.probeNote) + '"' : "";

  var target = c.polarisTarget
    ? escapeHtml(c.polarisTarget) +
      (c.targetTrackEolAt ? ' <span class="hint" style="font-size:0.72rem">(to ' + escapeHtml(c.targetTrackEolAt) + ')</span>' : "")
    : '<span class="hint">—</span>';

  var detail = "";
  var interesting = g.severity && g.severity !== "none";
  if (interesting && c.playbook) {
    var steps = (c.playbook.steps || []).map(function (s) {
      return "<li>" + escapeHtml(s) + "</li>";
    }).join("");
    var files = (c.playbook.files || []).map(function (f) {
      return "<code>" + escapeHtml(f) + "</code>";
    }).join(", ");
    detail =
      '<tr class="lifecycle-detail-row"><td colspan="6" style="padding:0 8px 8px">' +
        '<details>' +
          '<summary style="cursor:pointer;font-size:0.8rem">How to upgrade — ' + escapeHtml(c.playbook.title || "") + '</summary>' +
          '<div style="margin:0.5rem 0 0 0;font-size:0.8rem">' +
            (steps ? "<ol style=\"margin:0 0 0.5rem 1.1rem;padding:0\">" + steps + "</ol>" : "") +
            (files ? '<p class="hint" style="margin:0.25rem 0 0">Files that move together: ' + files + "</p>" : "") +
            (c.playbook.docAnchor ? '<p class="hint" style="margin:0.25rem 0 0">See <code>' + escapeHtml(c.playbook.docAnchor) + "</code></p>" : "") +
          "</div>" +
        "</details>" +
      "</td></tr>";
  }

  return '<tr class="capacity-reason-' + css + '"' + titleAttr + ">" +
      "<td><strong>" + escapeHtml(c.label || c.id) + "</strong></td>" +
      "<td>" + installed + "</td>" +
      "<td>" + (g.track ? escapeHtml(g.track) : '<span class="hint">—</span>') + "</td>" +
      "<td>" + supportedUntil + "</td>" +
      '<td><span class="capacity-pill capacity-pill-' + css + '">' + escapeHtml(_lifecycleStateLabel(g.state)) + "</span></td>" +
      "<td>" + target + "</td>" +
    "</tr>" + detail;
}

function renderPlatformLifecycleCard(lifecycle) {
  // Same empty contract as the advisor card, so the row layout cannot break.
  if (!lifecycle) return "";

  if (lifecycle.datasetError) {
    // A broken dataset gets a visible message, never a silently empty card.
    return '<div class="settings-card" id="platform-lifecycle-card">' +
      '<div class="capacity-header"><h4 style="margin:0">Platform Lifecycle</h4>' +
      '<span class="capacity-pill capacity-pill-amber">Unavailable</span></div>' +
      '<p class="hint" style="margin:0.6rem 0 0">The end-of-life dataset could not be read: ' +
        escapeHtml(lifecycle.datasetError) +
      "</p></div>";
  }

  var components = lifecycle.components || [];
  if (components.length === 0) return "";

  // Worst first: an operator should not have to scan for the problem.
  var order = { critical: 0, warning: 1, watch: 2, none: 3 };
  var sorted = components.slice().sort(function (a, b) {
    var d = (order[a.grade.severity] ?? 3) - (order[b.grade.severity] ?? 3);
    return d !== 0 ? d : String(a.label || a.id).localeCompare(String(b.label || b.id));
  });

  var severity = lifecycle.severity === "none" ? "ok" : lifecycle.severity;
  var pillClass = "capacity-pill capacity-pill-" + _capacitySeverityCssClass(severity);
  var problems = components.filter(function (c) {
    return c.grade.severity === "warning" || c.grade.severity === "critical";
  }).length;

  var headerNote = problems > 0
    ? '<span class="' + pillClass + '">' + problems + " need" + (problems === 1 ? "s" : "") + " attention</span>"
    : '<span class="' + pillClass + '">' + _capacitySeverityLabel(severity) + "</span>";

  // The app states how old the lifecycle data is; refreshing it is the skill's
  // job (/polaris-tech-lifecycle). Without this line a stale "Current" verdict
  // looks authoritative.
  var staleNote = "";
  if (lifecycle.datasetReviewedAt) {
    var ageDays = Math.floor((Date.now() - Date.parse(lifecycle.datasetReviewedAt + "T00:00:00Z")) / 86400000);
    if (ageDays > 180) {
      staleNote = '<p class="hint" style="margin:0.4rem 0 0;color:var(--color-warning);font-size:0.78rem">' +
        "End-of-life dates were last reviewed " + escapeHtml(lifecycle.datasetReviewedAt) +
        " (" + ageDays + ' days ago). Refresh the dataset before trusting a "Current" verdict.</p>';
    }
  }

  var infoLine = (lifecycle.informational || []).map(function (i) {
    return escapeHtml(i.label) + " " + escapeHtml(i.version);
  }).join(" · ");

  return '<div class="settings-card" id="platform-lifecycle-card">' +
    '<div class="capacity-header">' +
      '<h4 style="margin:0">Platform Lifecycle</h4>' +
      headerNote +
    "</div>" +
    staleNote +
    // Six columns do not fit at every viewport; scroll inside the container
    // rather than crushing the Component column (same fix as the advisor card).
    '<div style="overflow-x:auto;margin-top:0.75rem">' +
    '<table class="ip-table" style="width:100%;min-width:42rem">' +
      "<thead><tr>" +
        "<th>Component</th>" +
        '<th style="width:8rem">Installed</th>' +
        '<th style="width:5rem">Track</th>' +
        '<th style="width:12rem">Supported until</th>' +
        '<th style="width:11rem">Status</th>' +
        '<th style="width:9rem">Polaris target</th>' +
      "</tr></thead>" +
      "<tbody>" + sorted.map(_lifecycleRowHtml).join("") + "</tbody>" +
    "</table>" +
    "</div>" +
    (infoLine ? '<p class="hint" style="margin:0.6rem 0 0;font-size:0.78rem">' + infoLine + "</p>" : "") +
    '<p class="hint" style="margin:0.3rem 0 0;font-size:0.78rem">' +
      "Checked " + escapeHtml(formatLocalTime(lifecycle.computedAt)) +
      (lifecycle.datasetReviewedAt ? " · dates reviewed " + escapeHtml(lifecycle.datasetReviewedAt) : "") +
    "</p>" +
  "</div>";
}

function renderCapacityCard(capacity, dbInfo, pgTuning) {
  if (!capacity) {
    // Capacity grading unavailable (e.g. statfs not supported) — still render
    // the engine + pool stats under a plain Database header so operators
    // don't lose visibility into the database connection.
    var engineOnly = renderEnginePoolStatHtml(dbInfo, null);
    if (!engineOnly) return "";
    return '<div class="settings-card">' +
      '<h4>Database</h4>' +
      '<div class="capacity-grid">' + engineOnly + '</div>' +
    '</div>';
  }

  var severity = capacity.severity || "ok";
  // CSS class suffix stays on the color vocab (`red`/`amber`/`watch`/`ok`)
  // while the severity enum uses critical/warning. See _capacitySeverityCssClass.
  var severityCssClass = _capacitySeverityCssClass(severity);
  var pillClass = "capacity-pill capacity-pill-" + severityCssClass;

  // pg_tuning_needed used to inline a per-setting table here; that's now
  // rendered inside the Capacity Advisor card, which also covers max_connections
  // and worker-count recommendations alongside the PostgreSQL settings.

  // Reasons section — list each issue with severity + suggestion. When the
  // list is empty we still render a single subdued "all checks passed" row
  // so an operator sees evidence of work rather than a silent void.
  var reasonsHtml = "";
  if (!capacity.reasons || capacity.reasons.length === 0) {
    reasonsHtml =
      '<div class="capacity-reasons">' +
        '<div class="capacity-reason capacity-reason-ok">' +
          '<div class="capacity-reason-head">' +
            '<span class="capacity-pill capacity-pill-ok capacity-pill-sm">OK</span>' +
            '<span class="capacity-reason-msg">All capacity checks passed' +
              (capacity.computedAt ? ' at ' + escapeHtml(formatLocalTime(capacity.computedAt)) : '') +
            '.</span>' +
          '</div>' +
        '</div>' +
      '</div>';
  } else if (capacity.reasons && capacity.reasons.length > 0) {
    reasonsHtml =
      '<div class="capacity-reasons">' +
        capacity.reasons.map(function (r) {
          // Action buttons for reason codes that have a one-click apply.
          // The legacy pgboss_recommended / pgboss_overdue / pgboss_pending
          // codes were folded into the Capacity Advisor's QUEUE_MODE lever
          // — they no longer come back from the server.
          var action = "";
          if (r.code === "metrics_token_unset") {
            action = '<button class="btn btn-sm btn-primary capacity-action" data-action="generate-token" data-which="metrics" style="margin-top:0.5rem">Generate token</button>';
          } else if (r.code === "health_token_unset") {
            action = '<button class="btn btn-sm btn-primary capacity-action" data-action="generate-token" data-which="health" style="margin-top:0.5rem">Generate token</button>';
          }
          var rowPillLabel = (r.severity === "critical" || r.severity === "red") ? "Critical"
            : r.severity === "watch" ? "Watch"
            : "Warning";
          var cssClass = _capacitySeverityCssClass(r.severity);
          return '<div class="capacity-reason capacity-reason-' + cssClass + '">' +
            '<div class="capacity-reason-head">' +
              '<span class="capacity-pill capacity-pill-' + cssClass + ' capacity-pill-sm">' +
                rowPillLabel +
              '</span>' +
              '<span class="capacity-reason-msg">' + escapeHtml(r.message) + '</span>' +
            '</div>' +
            '<div class="capacity-reason-suggestion">' + escapeHtml(r.suggestion) + '</div>' +
            action +
          '</div>';
        }).join("") +
      '</div>';
  }

  var host = capacity.appHost || {};
  var db = capacity.database || {};
  var work = capacity.workload || {};

  var volumes = Array.isArray(host.volumes) ? host.volumes : [];
  var volumesHtml = volumes.length
    ? volumes.map(_capacityRenderVolume).join("")
    : '<p class="hint" style="margin:0">No volume statistics available — statfs may be unsupported on this host.</p>';

  var hostHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Application host</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow("CPU cores", host.cpuCount != null ? host.cpuCount : "—") +
        dbInfoRow("RAM (total)", _capacityFormatBytes(host.totalMemoryBytes)) +
        dbInfoRow("RAM (free)", _capacityFormatBytes(host.freeMemoryBytes)) +
        (host.loadAvg ? dbInfoRow("Load avg (1/5/15m)", host.loadAvg.map(function (n) { return n.toFixed(2); }).join(" / ")) : "") +
        dbInfoRow("DB co-located", host.dbColocated ? "Yes" : "No (remote)") +
      '</div>' +
      '<h5 style="margin-top:0.85rem">Storage volumes</h5>' +
      '<div style="margin-top:0.4rem">' + volumesHtml + '</div>' +
      (host.dbColocated
        ? ''
        : '<p class="hint" style="margin-top:0.5rem">PostgreSQL is on a separate host — its data volume is not visible here.</p>') +
    '</div>';

  var allTables = (dbInfo && dbInfo.tables) || [];
  var tablesHtml = allTables.map(function (t) {
    return '<tr>' +
      '<td class="mono" style="font-size:0.78rem">' + escapeHtml(t.name) + '</td>' +
      '<td style="text-align:right">' + formatNumber(t.rows) + '</td>' +
      '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(t.size) + '</td>' +
      '</tr>';
  }).join("");

  // TimescaleDB three-state: not installed / installed but no hypertables / enabled
  var ts = db.timescale || {};
  var tsLabel = "Not installed";
  if (ts.extensionInstalled) {
    var htCount = Array.isArray(ts.hypertableTables) ? ts.hypertableTables.length : 0;
    tsLabel = htCount > 0 ? ("Enabled (" + htCount + " hypertable" + (htCount === 1 ? "" : "s") + ")") : "Installed, not enabled";
  }

  // Monitor queue: three-state shape mirroring TimescaleDB. When
  // `persisted` differs from `active`, the operator has clicked the
  // [Enable on next restart] button and a restart is pending — append a
  // bold "Pending: <mode> on next restart" hint so it's not invisible.
  var q = db.queue || {};
  var queueLabel;
  if (!q.pgbossInstalled) {
    queueLabel = "Cursor (pg-boss not installed)";
  } else if (q.active === "pgboss") {
    queueLabel = "pg-boss (active)";
  } else {
    queueLabel = "Cursor (pg-boss installed, not active)";
  }
  if (q.persisted && q.active && q.persisted !== q.active) {
    queueLabel += ' <strong style="color:var(--color-warning,#f59e0b)">— Pending: ' +
      escapeHtml(q.persisted) + ' on next restart</strong>';
  }

  var dbHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Database</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow("Current size", _capacityFormatBytes(db.sizeBytes)) +
        dbInfoRow(
          "Steady-state at current settings",
          _capacityFormatBytes(work.steadyStateSizeBytes),
          "Peak size the database grows to if nothing changes. Legitimately larger than " +
          "the current size while sample tables are still filling. Retention windows are " +
          "reclaimed a whole TimescaleDB chunk at a time, so each tier keeps its configured " +
          "window plus one chunk interval plus one prune cycle.",
        ) +
        (allTables.length ? dbInfoRow("Tables", allTables.length) : "") +
        dbInfoRow("TimescaleDB", tsLabel) +
        dbInfoRow("Monitor queue", queueLabel) +
      '</div>' +
      (tablesHtml
        ? '<div style="margin-top:0.75rem;max-height:240px;overflow-y:auto">' +
            '<table class="ip-table"><thead><tr>' +
              '<th>Table</th>' +
              '<th style="text-align:right">Rows</th>' +
              '<th style="text-align:right">Size</th>' +
            '</tr></thead><tbody>' + tablesHtml + '</tbody></table>' +
          '</div>'
        : '') +
    '</div>';

  var workHtml =
    '<div class="capacity-stat-card">' +
      '<h5>Monitoring workload</h5>' +
      '<div class="db-info-grid">' +
        dbInfoRow("Monitored assets", formatNumber(work.monitoredAssetCount || 0)) +
        dbInfoRow("Monitored interfaces", formatNumber(work.monitoredInterfaceCount || 0)) +
        dbInfoRow("Monitored storage mounts", formatNumber(work.monitoredStorageCount || 0)) +
        (work.cadences
          ? dbInfoRow("Cadences",
              work.cadences.responseTimeSec + "s response · " +
              work.cadences.telemetrySec + "s telemetry · " +
              work.cadences.systemInfoSec + "s system info")
          : "") +
        (work.retention
          ? dbInfoRow("Retention",
              work.retention.monitorDays + "d monitor · " +
              work.retention.telemetryDays + "d telemetry · " +
              work.retention.systemInfoDays + "d system info")
          : "") +
      '</div>' +
      '<p class="hint" style="margin-top:0.5rem">Steady-state size is what the database grows to if monitoring settings stay as they are. Reduce retention or cadence to lower it.</p>' +
    '</div>';

  var enginePoolHtml = renderEnginePoolStatHtml(dbInfo, capacity);

  return '<div class="settings-card capacity-card capacity-card-' + severityCssClass + '" id="capacity-card">' +
    '<div class="capacity-header">' +
      '<h4 style="margin:0">Database</h4>' +
      '<span class="' + pillClass + '">' + _capacitySeverityLabel(severity) + '</span>' +
    '</div>' +
    reasonsHtml +
    '<div class="capacity-grid">' + hostHtml + dbHtml + enginePoolHtml + workHtml + '</div>' +
    '<p class="hint" style="margin-top:0.75rem;font-size:0.78rem">Last computed ' + escapeHtml(formatLocalTime(capacity.computedAt)) + '</p>' +
  '</div>';
}

// ─── Sample Retention card (Maintenance tab) ───────────────────────────────
//
// Edit the global Setting("sampleRetention") shape. One card with a compact
// 3-stream × 3-tier × 3-class grid (27 inputs total). Values are days; 0
// disables retention for that cell ("keep forever").
//
// Layout per stream: a small header row with the three class columns
// (Default / Switches / Access points) followed by three rows for the
// three tiers (Detail / Hourly / Daily). Stream sections stack vertically.
// Inputs are tight (3.5rem) so the whole card fits in a single screen.

// Per-ENTITY retention. Rows = entities, columns = tiers (detail/hourly/daily).
// Encoding per cell: N = keep N days; 0 = drop this tier; -1 = keep forever.
// The three selection-aware entities (interfaces/storage/ipsec) apply their
// configured retention to OPERATOR-SELECTED (monitored) rows only — unselected
// bulk rows are kept a fixed 24h and never rolled up (chosen per-asset in the
// interface/storage/IPsec slide-ins).
var SAMPLE_RETENTION_ENTITIES = [
  { key: "assets",      label: "Response time",  hint: "Per-asset response-time probe (asset_monitor_samples)." },
  { key: "cpuMem",      label: "CPU & memory",   hint: "Per-asset CPU / memory telemetry." },
  { key: "hardware",    label: "Hardware sensors", hint: "Per-asset hardware sensors (temperature / fan / voltage / power / disk)." },
  { key: "interfaces",  label: "Interfaces",     hint: "Per-interface counters.", selectionAware: true },
  { key: "storage",     label: "Storage",        hint: "Per-volume usage.",       selectionAware: true },
  { key: "ipsec",       label: "IPsec tunnels",  hint: "Per-tunnel state.",       selectionAware: true },
  { key: "perfSla",     label: "SD-WAN Perf SLA", hint: "Per health-check member latency / jitter / loss." },
  { key: "process",     label: "Processes & services", hint: "Pinned-program CPU/RAM plus process + service log lines." },
];
// FLAT entities: one window instead of detail/hourly/daily, for tables that are
// current-state-with-age rather than tiered time-series. Same −1/0/N encoding.
var SAMPLE_RETENTION_FLAT_ENTITIES = [
  {
    key: "appMapConnections",
    label: "Application Map connections",
    hint: "Observed listening ports + peers for mapped processes/services. Rows accumulate " +
          "(one per distinct socket) and age out on this window; capped at 200 listening / " +
          "500 outbound / 200 inbound per program per host. Also sets how far back the " +
          "Application Map's “Seen within” filter can reach.",
    def: 30,
  },
  {
    key: "arpEntries",
    label: "ARP / neighbour cache",
    hint: "IP→MAC bindings read from each FortiGate. Rows accumulate (one per distinct " +
          "binding, not one per poll) and age out on this window; capped at 4000 per device. " +
          "Also sets how far back the ARP Table tab’s range selector can reach.",
    def: 30,
  },
];
var SAMPLE_RETENTION_TIERS   = [
  { key: "detail", label: "Detail"      },
  { key: "hourly", label: "Hourly avg"  },
  { key: "daily",  label: "Daily avg"   },
];
var SAMPLE_RETENTION_DEFAULTS = {
  detail: 7,
  hourly: 30,
  daily:  365,
};

function _retentionInputHtml(entity, tier, value) {
  var id = "ret-" + entity + "-" + tier;
  var safeValue = (typeof value === "number" && Number.isFinite(value)) ? value : 0;
  return '<input type="number" min="-1" max="3650" step="1" id="' + id + '" data-entity="' + escapeHtml(entity) +
    '" data-tier="' + escapeHtml(tier) +
    '" value="' + safeValue + '" style="width:4rem;text-align:center;padding:2px 4px;font-size:0.85rem">';
}

function renderSampleRetentionCard(retention) {
  // Fall through to defaults if the snapshot fetch failed; operator can
  // still edit and Save to seed the Setting on first use.
  var r = retention || {};
  var defTier = { detail: 7, hourly: 30, daily: 365 };

  var rows = "";
  var hasSelectionAware = false;
  SAMPLE_RETENTION_ENTITIES.forEach(function (entity) {
    var entRet = r[entity.key] || defTier;
    if (entity.selectionAware) hasSelectionAware = true;
    var cells = SAMPLE_RETENTION_TIERS.map(function (tier) {
      return '<td style="padding:3px 6px;text-align:center">' +
        _retentionInputHtml(entity.key, tier.key, entRet[tier.key]) +
      '</td>';
    }).join("");
    var label = escapeHtml(entity.label) + (entity.selectionAware ? ' <span style="color:var(--color-text-tertiary)">*</span>' : "");
    rows +=
      '<tr>' +
        '<td style="padding:4px 10px 4px 0;font-size:0.85rem;white-space:nowrap">' + label +
          '<div style="font-size:0.72rem;color:var(--color-text-tertiary)">' + escapeHtml(entity.hint) + '</div>' +
        '</td>' +
        cells +
        '<td style="padding:3px 0 3px 6px;font-size:0.78rem;color:var(--color-text-tertiary)">days</td>' +
      '</tr>';
  });

  var headerCells = SAMPLE_RETENTION_TIERS.map(function (tier) {
    return '<th style="padding:3px 6px;text-align:center;font-size:0.74rem;color:var(--color-text-secondary);font-weight:600;text-transform:uppercase;letter-spacing:0.04em">' +
      escapeHtml(tier.label) +
    '</th>';
  }).join("");

  var footnote = hasSelectionAware
    ? '<p class="hint" style="margin-top:0.5rem;font-size:0.76rem">* Applies to <strong>selected (monitored)</strong> interfaces / storage / IPsec tunnels only — unselected ones are kept 24&nbsp;h and not rolled up. Choose which to keep from each asset\'s interface / storage / IPsec slide-in.</p>'
    : "";

  // Flat entities render as their own single-input rows: they have one window,
  // so putting them in the tier table would leave two thirds of it meaningless.
  var flatRows = SAMPLE_RETENTION_FLAT_ENTITIES.map(function (entity) {
    var cur = r[entity.key] && typeof r[entity.key].days === "number" ? r[entity.key].days : entity.def;
    return '<tr>' +
      '<td style="padding:4px 10px 4px 0;font-size:0.85rem">' + escapeHtml(entity.label) +
        '<div style="font-size:0.72rem;color:var(--color-text-tertiary);max-width:34rem">' + escapeHtml(entity.hint) + '</div>' +
      '</td>' +
      '<td style="padding:3px 6px;text-align:center;vertical-align:top">' +
        '<input type="number" min="-1" max="3650" step="1" id="ret-flat-' + escapeHtml(entity.key) + '"' +
        ' data-flat-entity="' + escapeHtml(entity.key) + '"' +
        ' value="' + cur + '" style="width:4rem;text-align:center;padding:2px 4px;font-size:0.85rem">' +
      '</td>' +
      '<td style="padding:3px 0 3px 6px;font-size:0.78rem;color:var(--color-text-tertiary);vertical-align:top">days</td>' +
    '</tr>';
  }).join("");
  var flatSection = flatRows
    ? '<h5 style="margin:1.1rem 0 0.35rem;font-size:0.8rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-secondary)">Single-window data</h5>' +
      '<table style="border-collapse:collapse"><tbody>' + flatRows + '</tbody></table>'
    : "";

  return '<div class="settings-card" id="sample-retention-card">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.5rem">' +
      '<h4 style="margin:0">Sample Retention</h4>' +
      '<div style="display:flex;gap:6px">' +
        '<button class="btn btn-secondary btn-sm" id="btn-sample-retention-defaults">Restore defaults</button>' +
        '<button class="btn btn-primary"   id="btn-sample-retention-save">Save</button>' +
      '</div>' +
    '</div>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.85rem">' +
      'How long Polaris keeps each kind of sample data. Older samples roll up into hourly buckets, then daily buckets, then drop. Per cell: <strong>N</strong> = keep N days, <strong>0</strong> = drop that tier, <strong>−1</strong> = keep forever.' +
    '</p>' +
    '<table style="border-collapse:collapse">' +
      '<thead><tr>' +
        '<th></th>' +
        headerCells +
        '<th></th>' +
      '</tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>' +
    footnote +
    flatSection +
    '<p class="hint" style="margin-top:0.5rem;font-size:0.78rem">Defaults: 7 days detail / 30 days hourly / 365 days daily. Takes effect on the next nightly prune (heavy-loop tick) and on the next chart request.</p>' +
  '</div>';
}

function _wireSampleRetentionCard() {
  var card = document.getElementById("sample-retention-card");
  if (!card) return;
  var saveBtn = document.getElementById("btn-sample-retention-save");
  var defBtn  = document.getElementById("btn-sample-retention-defaults");
  if (defBtn) {
    defBtn.addEventListener("click", function () {
      // Restore the default values into the inputs without saving. The
      // operator clicks Save to actually persist.
      SAMPLE_RETENTION_ENTITIES.forEach(function (entity) {
        SAMPLE_RETENTION_TIERS.forEach(function (tier) {
          var el = document.getElementById("ret-" + entity.key + "-" + tier.key);
          if (el) el.value = String(SAMPLE_RETENTION_DEFAULTS[tier.key]);
        });
      });
      SAMPLE_RETENTION_FLAT_ENTITIES.forEach(function (entity) {
        var el = document.getElementById("ret-flat-" + entity.key);
        if (el) el.value = String(entity.def);
      });
    });
  }
  if (saveBtn) {
    saveBtn.addEventListener("click", async function () {
      var payload = {};
      var hasError = false;
      SAMPLE_RETENTION_ENTITIES.forEach(function (entity) {
        payload[entity.key] = {};
        SAMPLE_RETENTION_TIERS.forEach(function (tier) {
          var el = document.getElementById("ret-" + entity.key + "-" + tier.key);
          if (!el) return;
          var n = parseInt(el.value, 10);
          // -1 = keep forever, 0 = drop tier, 1..3650 = days.
          if (!Number.isFinite(n) || n < -1 || n > 3650) {
            hasError = true;
            el.style.borderColor = "var(--color-status-error, #e57373)";
            return;
          }
          el.style.borderColor = "";
          payload[entity.key][tier.key] = n;
        });
      });
      SAMPLE_RETENTION_FLAT_ENTITIES.forEach(function (entity) {
        var el = document.getElementById("ret-flat-" + entity.key);
        if (!el) return;
        var n = parseInt(el.value, 10);
        if (!Number.isFinite(n) || n < -1 || n > 3650) {
          hasError = true;
          el.style.borderColor = "var(--color-status-error, #e57373)";
          return;
        }
        el.style.borderColor = "";
        payload[entity.key] = { days: n };
      });
      if (hasError) {
        showToast("Retention values must be −1 (forever), 0 (off), or 1–3650 days", "error");
        return;
      }
      saveBtn.disabled = true;
      try {
        await api.serverSettings.setSampleRetention(payload);
        showToast("Sample retention saved", "success");
        _showRetentionPruneInfoModal();
      } catch (err) {
        showToast("Save failed: " + (err && err.message ? err.message : String(err)), "error");
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
}

// Post-save explainer: retention changes are applied by the retention prune
// pass, which runs on a 24h cadence (RETENTION_PRUNE_INTERVAL_MS server-side)
// — the save itself deletes nothing. Sets expectations for when the operator
// will actually see database size move.
function _showRetentionPruneInfoModal() {
  var p = 'style="font-size:0.9rem;color:var(--color-text-secondary);margin:0 0 0.75rem"';
  var body =
    '<p ' + p + '>Retention changes are applied by the <strong>retention prune pass</strong>, ' +
      'which runs once every 24 hours — not at save time. The next pass fires when 24 hours ' +
      'have elapsed since the previous one, so the new limits take effect ' +
      '<strong>within the next 24 hours</strong>.</p>' +
    '<p ' + p + '>When it runs, sample history is stored in one-day chunks and every chunk ' +
      'entirely older than the new cutoff is dropped whole — that is what returns disk space ' +
      'to the operating system, compressed history included. Expect a step down in database ' +
      'size at that point, then a one-day trim on each pass after.</p>' +
    '<p ' + p + '>Two caveats: the chunk straddling a cutoff is kept until it fully ages past it ' +
      '(up to one extra day of data per tier), and rows removed by row-level deletes free space ' +
      'for reuse inside PostgreSQL rather than shrinking files on disk.</p>' +
    '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0">You can confirm the ' +
      'prune ran on the Maintenance tab — the Database card’s volume bars and steady-state ' +
      'size reflect the new retention after the next pass.</p>';
  var footer = '<button class="btn btn-primary" onclick="closeModal()">Got it</button>';
  openModal("When will the database shrink?", body, footer);
}

async function loadDatabaseInfo() {
  var container = document.getElementById("tab-maintenance");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading maintenance information...</p></div>';

  try {
    // Fetch capacity advisor in parallel with the database snapshot — if the
    // advisor fails (e.g. statfs not available) we still render the rest of
    // the tab. Also pull the NTP timezone override so capacity timestamps
    // render in server time; failures fall through to browser-local.
    var results = await Promise.allSettled([
      api.serverSettings.getDatabase(),
      api.serverSettings.getCapacityAdvisor(),
      loadTzOverride(),
      api.serverSettings.getPlatformLifecycle(),
    ]);
    if (results[0].status === "rejected") throw results[0].reason;
    var db = results[0].value;
    var lifecycle = results[3] && results[3].status === "fulfilled" ? results[3].value : null;
    var advisorResp = results[1].status === "fulfilled" && results[1].value
      ? results[1].value
      : null;
    var advisor = advisorResp && advisorResp.advisor ? advisorResp.advisor : null;
    var capacity = advisorResp && advisorResp.capacity ? advisorResp.capacity : null;
    var pgTuning = advisorResp && advisorResp.pgTuning ? advisorResp.pgTuning : null;
    var dbConnectionMode = advisorResp && advisorResp.dbConnectionMode ? advisorResp.dbConnectionMode : "direct";
    _dbLoaded = true;

    var advisorHtml = renderCapacityAdvisorCard(advisor, pgTuning && pgTuning.pgConfigFile, dbConnectionMode);
    var lifecycleHtml = renderPlatformLifecycleCard(lifecycle);

    // ── Application Updates card ──
    var updateCardHtml =
      '<div class="settings-card" id="update-card">' +
        '<h4>Application Updates</h4>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
          'Check for new versions and apply updates directly from the browser. Automatic rollback on failure.' +
        '</p>' +
        '<div id="update-status-area">' +
          '<div class="db-info-grid" style="margin-bottom:1rem">' +
            '<div class="db-info-label">Current Version</div>' +
            '<div class="db-info-value" id="update-current-version">v' + escapeHtml(_branding && _branding.version ? _branding.version : '?') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;align-items:center">' +
            '<button class="btn btn-secondary" id="btn-check-updates">Check for Updates</button>' +
            '<span id="update-check-status" style="font-size:0.82rem"></span>' +
          '</div>' +
        '</div>' +
        // Update source — which git repo updates are pulled from, and whether
        // that comes from POLARIS_UPDATE_REPO (.env) or the install's origin.
        // Lives outside #update-status-area so it survives status re-renders.
        '<div id="update-repo-info" style="margin-top:0.75rem;font-size:0.8rem;color:var(--color-text-tertiary)"></div>' +
        // Update train — nightly (every commit) vs release (tagged releases only).
        '<div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
          '<label for="update-train-select" style="display:block;font-size:0.85rem;font-weight:600;margin-bottom:0.35rem">Update train</label>' +
          '<select id="update-train-select" style="max-width:280px">' +
            '<option value="nightly">Nightly — latest commits</option>' +
            '<option value="release">Release — stable releases only</option>' +
          '</select>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0">' +
            'Nightly tracks every change on the update branch. Release only downloads published, tagged releases.' +
          '</p>' +
        '</div>' +
        '<div style="margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
          '<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none">' +
            '<input type="checkbox" id="update-backup-checkbox" style="width:15px;height:15px;flex-shrink:0">' +
            '<span style="font-size:0.85rem">Back up database before applying updates</span>' +
          '</label>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.3rem 0 0 23px">Disable to skip the backup step. The migration step of an update cannot be rolled back, so with this off a failed update has <strong>no recovery point</strong> — the in-app updater does not roll back, and the fallback script restores the database only from this backup. If you turned this off because backups were failing, the Backups card below now says why. Not recommended for production systems.</p>' +
        '</div>' +
        '<details id="update-history" style="margin-top:1rem">' +
          '<summary style="cursor:pointer;font-size:0.82rem;color:var(--color-text-secondary);user-select:none">Recent updates</summary>' +
          '<div id="update-history-body" style="margin-top:0.6rem;font-size:0.82rem;color:var(--color-text-tertiary)">Loading...</div>' +
        '</details>' +
      '</div>';

    container.innerHTML =
      // Database first — the volume bars and capacity severity are what an
      // operator opens this tab to see. Capacity Advisor and Application
      // Updates then share one row as half-width cards; the advisor renders
      // nothing when it has no recommendations, in which case Updates keeps
      // the full width rather than leaving half a row empty.
      renderCapacityCard(capacity, db, pgTuning) +
      (advisorHtml
        ? '<div class="settings-cards-row">' + advisorHtml + updateCardHtml + '</div>'
        : updateCardHtml) +
      // Platform Lifecycle sits with the "what is this server and does it need
      // work" group (Database → Advisor → Updates → Lifecycle) and above the
      // operational-task group below. Full width of its own on purpose: it
      // wants six columns, and pairing it with Updates would recreate the
      // column crush the advisor card already had to solve.
      lifecycleHtml +
      // ── Polaris Agent card ──
      // ── Backup / Restore / History — three columns ──
      '<div class="settings-cards-row-3">' +

      // ── Backup Card ──
      '<div class="settings-card">' +
        '<h4>Backup</h4>' +
        '<p class="hint" style="margin-bottom:0.75rem">Create a compressed backup of the database. Optionally encrypt with a password for secure storage or transfer.</p>' +
        '<div class="form-row" style="align-items:flex-end;gap:12px;flex-wrap:wrap">' +
          '<div style="flex:1;min-width:200px">' +
            '<label for="backup-password">Encryption password <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="password" id="backup-password" placeholder="Leave blank for unencrypted backup" autocomplete="new-password">' +
          '</div>' +
          '<div style="flex:1;min-width:200px">' +
            '<label for="backup-password-confirm">Confirm password</label>' +
            '<input type="password" id="backup-password-confirm" placeholder="Re-enter password" autocomplete="new-password">' +
          '</div>' +
          '<div>' +
            '<button class="btn btn-primary" id="btn-backup" style="white-space:nowrap">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              'Create Backup</button>' +
          '</div>' +
        '</div>' +
        '<div id="backup-status" style="margin-top:0.5rem"></div>' +
      '</div>' +

      // ── Restore Card ──
      '<div class="settings-card">' +
        '<h4>Restore</h4>' +
        '<p class="hint" style="margin-bottom:0.75rem">Restore the database from a previously created backup file. This will replace all current data.</p>' +
        '<div class="restore-drop-zone" id="restore-drop-zone">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="32" height="32" style="opacity:0.5"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
          '<p>Drag and drop a backup file here, or <label for="restore-file-input" class="link-text" style="cursor:pointer">browse</label></p>' +
          '<p class="hint">Accepts .gz or .enc.gz files</p>' +
          '<input type="file" id="restore-file-input" accept=".gz" style="display:none">' +
        '</div>' +
        '<div id="restore-file-info" style="display:none;margin-top:0.75rem">' +
          '<div class="db-info-grid" style="margin-bottom:0.75rem">' +
            '<div class="db-info-label">File</div><div class="db-info-value" id="restore-filename">-</div>' +
            '<div class="db-info-label">Size</div><div class="db-info-value" id="restore-filesize">-</div>' +
            '<div class="db-info-label">Backup version</div><div class="db-info-value" id="restore-version">-</div>' +
            '<div class="db-info-label">Encrypted</div><div class="db-info-value" id="restore-encrypted">-</div>' +
          '</div>' +
          '<div id="restore-version-warning" style="display:none;margin-bottom:0.75rem;padding:0.6rem 0.75rem;border-radius:6px;background:color-mix(in srgb, var(--color-warning) 12%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);font-size:0.82rem;color:var(--color-text-primary)">' +
            '<strong style="color:var(--color-warning)">Version mismatch</strong> — ' +
            'This backup was created with a different version of Polaris. ' +
            'Restoring a backup from a different version may fail or cause issues if the database schema has changed. ' +
            'For best results, ensure the application version matches the backup version before restoring.' +
          '</div>' +
          '<div id="restore-password-row" style="display:none;margin-bottom:0.75rem">' +
            '<label for="restore-password">Decryption password</label>' +
            '<input type="password" id="restore-password" placeholder="Enter the password used during backup" autocomplete="off">' +
          '</div>' +
          '<div style="display:flex;gap:8px">' +
            '<button class="btn btn-danger" id="btn-restore">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>' +
              'Restore Database</button>' +
            '<button class="btn btn-secondary" id="btn-restore-cancel">Cancel</button>' +
          '</div>' +
        '</div>' +
        '<div id="restore-status" style="margin-top:0.5rem"></div>' +
      '</div>' +

      // ── Backup History Card ──
      '<div class="settings-card">' +
        '<h4>Backup History</h4>' +
        '<div id="backup-history-body"><p class="empty-state">Loading...</p></div>' +
      '</div>' +

      '</div>' + // close 3-column row of Backup/Restore/History cards

      // ── Scheduled Backups card ──
      // Manual backup alone means "someone remembers to click the button".
      // This is the standing recovery point; default off so it never competes
      // with an enterprise backup product already covering this Postgres.
      '<div class="settings-card">' +
        '<h4>Scheduled Backups</h4>' +
        '<p class="hint" style="margin-bottom:0.75rem">Take a backup automatically on a fixed cadence. Off by default — leave it off if an enterprise backup product already covers this PostgreSQL instance. Copies land in <code>data/backups/</code> on this host; set an off-host directory so losing the host does not lose every backup with it.</p>' +
        '<label style="display:flex;align-items:center;gap:8px;margin-bottom:0.75rem">' +
          '<input type="checkbox" id="bksched-enabled">' +
          '<span>Enable scheduled backups</span>' +
        '</label>' +
        '<div id="bksched-fields" class="form-row" style="align-items:flex-end;gap:12px;flex-wrap:wrap">' +
          '<div style="min-width:130px">' +
            '<label for="bksched-interval">Every (hours)</label>' +
            '<input type="number" id="bksched-interval" min="1" max="168" step="1">' +
          '</div>' +
          '<div style="min-width:150px">' +
            '<label for="bksched-hour">At UTC hour <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="number" id="bksched-hour" min="0" max="23" step="1" placeholder="any">' +
          '</div>' +
          '<div style="min-width:130px">' +
            '<label for="bksched-retain">Keep last</label>' +
            '<input type="number" id="bksched-retain" min="1" max="50" step="1">' +
          '</div>' +
          '<div style="flex:1;min-width:200px">' +
            '<label for="bksched-passphrase">Encryption passphrase <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="password" id="bksched-passphrase" placeholder="Leave blank for unencrypted" autocomplete="new-password">' +
          '</div>' +
          '<div style="flex:1;min-width:220px">' +
            '<label for="bksched-copyto">Off-host copy directory <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
            '<input type="text" id="bksched-copyto" placeholder="/mnt/backups/polaris">' +
          '</div>' +
          '<div>' +
            '<button class="btn btn-primary" id="btn-bksched-save" style="white-space:nowrap">Save Schedule</button>' +
          '</div>' +
        '</div>' +
        '<div id="bksched-status" style="margin-top:0.5rem"></div>' +
      '</div>' +

      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-secondary" id="btn-db-refresh">Refresh</button>' +
      '</div>';

    // Wire up events
    document.getElementById("btn-db-refresh").addEventListener("click", function () {
      _dbLoaded = false;
      loadDatabaseInfo();
    });

    initBackupControls();
    initRestoreControls();
    loadBackupHistory();
    loadBackupSchedule();
    initUpdateControls();
    initCapacityActions();
    initCapacityAdvisorActions();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

// ─── Backup Logic ───────────────────────────────────────────────────────────

// Returns true if the caller should proceed. If discoveries are running, prompts
// the user to abort them first; aborts on confirmation, cancels on dismissal.
async function warnIfDiscoveryRunning(actionLabel) {
  var result;
  try { result = await api.integrations.discoveries(); } catch (_) { return true; }
  var running = (result && result.discoveries) || [];
  if (running.length === 0) return true;

  var names = running.map(function (d) { return d.name; }).join(", ");
  var confirmed = await showConfirm(
    'A discovery is currently running (' + names + ').\n\n' +
    'Abort the discovery and continue with the ' + actionLabel + '?'
  );
  if (!confirmed) return false;

  await Promise.allSettled(running.map(function (d) {
    return api.integrations.abortDiscover(d.id);
  }));
  return true;
}

/**
 * Wire click handlers for the action buttons rendered inside capacity
 * reasons. Called from loadDatabaseInfo after the card is in the DOM.
 *
 * Only the metrics/health token-generation buttons remain here; queue-mode
 * changes are handled by the Capacity Advisor card via its Stage flow.
 */
function initCapacityActions() {
  var card = document.getElementById("capacity-card");
  if (!card) return;

  card.querySelectorAll('button[data-action="generate-token"]').forEach(function (btn) {
    btn.addEventListener("click", async function () {
      var which = btn.getAttribute("data-which");
      if (which !== "metrics" && which !== "health") return;
      btn.disabled = true;
      btn.textContent = "Generating...";
      try {
        await api.serverSettings.generateSecurityToken(which);
        showToast("Token written to .env — gate is active immediately", "success");
        _dbLoaded = false;
        loadDatabaseInfo();
      } catch (err) {
        showToast("Could not generate token: " + (err && err.message ? err.message : "unknown error"), "error");
        btn.disabled = false;
        btn.textContent = "Generate token";
      }
    });
  });
}

/**
 * Wire the Stage button on the Capacity Advisor card. Collects checked rows,
 * confirms the operator, posts to POST /capacity-advisor/stage, and renders
 * per-row success/error badges from the receipt.
 */
function wireAdvisorRestartBtn(restartBtn) {
  if (!restartBtn) return;
  restartBtn.addEventListener("click", async function () {
    if (!await warnIfDiscoveryRunning("restart")) return;
    var ok = await showConfirm(
      "Restart Polaris now?\n\n" +
      "The server will be unreachable for ~30 seconds. Any in-flight operator action " +
      "will fail and must be retried after the restart."
    );
    if (!ok) return;
    restartBtn.disabled = true;
    restartBtn.textContent = "Restarting...";
    try {
      await api.serverSettings.restart();
      _advisorJustStaged = false;
      pollUntilServerReachable();
    } catch (err) {
      showToast("Restart failed: " + (err && err.message ? err.message : "unknown error"), "error");
      restartBtn.disabled = false;
      restartBtn.textContent = "Restart Polaris to apply";
    }
  });
}

/**
 * Mark a staged advisor row in place: drop the checkbox, flip the Status pill
 * to "Staged". Staged env values live in .env but don't reach the running
 * process until restart, so a re-fetch would still show them as pending —
 * hence we mutate the DOM directly instead of re-rendering from the advisor.
 */
function markAdvisorRowStaged(card, key) {
  var checkbox = card.querySelector('input.advisor-stage-checkbox[data-key="' + key + '"]');
  if (!checkbox) return;
  var row = checkbox.closest("tr");
  if (!row) return;
  var cells = row.querySelectorAll("td");
  // Status pill is the 4th column; Stage checkbox is the 5th (see _advisorRowHtml).
  if (cells[3]) cells[3].innerHTML = '<span class="advisor-pill advisor-pill-ok">Staged</span>';
  if (cells[4]) cells[4].innerHTML = '<span class="muted">✓</span>';
  row.classList.remove("advisor-row-change");
}

function initCapacityAdvisorActions() {
  var card = document.getElementById("capacity-advisor-card");
  if (!card) return;

  wireAdvisorRestartBtn(document.getElementById("capacity-advisor-restart-btn"));

  var stageBtn = document.getElementById("capacity-advisor-stage-btn");
  if (!stageBtn || stageBtn.disabled) return;

  stageBtn.addEventListener("click", async function () {
    _advisorJustStaged = false;
    var checked = Array.prototype.slice.call(
      card.querySelectorAll('input.advisor-stage-checkbox:checked')
    ).map(function (el) { return el.getAttribute("data-key"); });
    if (checked.length === 0) {
      showToast("Tick at least one row before staging", "error");
      return;
    }
    var msg = "Write " + checked.length + " value" + (checked.length === 1 ? "" : "s") +
      " to .env? They take effect on next Polaris restart.\n\nKeys:\n  " + checked.join("\n  ") +
      "\n\nmax_connections and PostgreSQL tuning are NOT in this set — those require a Postgres restart and must be done manually.";
    var ok = await showConfirm(msg);
    if (!ok) return;
    stageBtn.disabled = true;
    stageBtn.textContent = "Staging...";
    try {
      var receipt = await api.serverSettings.stageCapacityAdvisor(checked);
      var appliedRows = (receipt.results || []).filter(function (r) { return r.status === "applied"; });
      var applied = appliedRows.length;
      var errored = (receipt.results || []).filter(function (r) { return r.status === "error";   });
      if (errored.length > 0) {
        showToast("Staged " + applied + ", " + errored.length + " error" + (errored.length === 1 ? "" : "s") + ": " + errored.map(function (r) { return r.key + " — " + (r.reason || "unknown"); }).join("; "), "error");
        stageBtn.disabled = false;
        stageBtn.textContent = "Stage selected";
        return;
      }
      // Staged values are written to .env but don't reach the running process
      // until restart, so re-fetching the advisor would still show them as
      // pending. Instead, mark the staged rows and swap the footer button to
      // "Restart Polaris to apply" in place — no full-tab reload.
      _advisorJustStaged = true;
      appliedRows.forEach(function (r) { markAdvisorRowStaged(card, r.key); });
      showToast("Staged " + applied + " value" + (applied === 1 ? "" : "s") + ". Restart Polaris to apply.", "success");

      var remaining = card.querySelectorAll("input.advisor-stage-checkbox").length;
      if (remaining === 0) {
        var restartBtn = document.createElement("button");
        restartBtn.className = "btn btn-warning";
        restartBtn.id = "capacity-advisor-restart-btn";
        restartBtn.textContent = "Restart Polaris to apply";
        stageBtn.replaceWith(restartBtn);
        wireAdvisorRestartBtn(restartBtn);
      } else {
        // Other recommendations remain unstaged — keep the Stage button live.
        stageBtn.disabled = false;
        stageBtn.textContent = "Stage selected";
      }
    } catch (err) {
      showToast("Stage failed: " + (err && err.message ? err.message : "unknown error"), "error");
      stageBtn.disabled = false;
      stageBtn.textContent = "Stage selected";
    }
  });
}

function initBackupControls() {
  var btnBackup = document.getElementById("btn-backup");
  btnBackup.addEventListener("click", async function () {
    var pw = document.getElementById("backup-password").value;
    var pwConfirm = document.getElementById("backup-password-confirm").value;
    var statusEl = document.getElementById("backup-status");

    if (pw && pw !== pwConfirm) {
      statusEl.innerHTML = '<span class="badge badge-error">Passwords do not match</span>';
      return;
    }

    if (!await warnIfDiscoveryRunning("backup")) return;

    btnBackup.disabled = true;
    btnBackup.textContent = "Creating backup...";
    statusEl.innerHTML = '<span class="badge badge-info">Compressing' + (pw ? " and encrypting" : "") + ' database...</span>';

    try {
      var result = await api.serverSettings.backupDatabase(pw || null);
      if (!result || !result.blob) throw new Error("No data received");

      // Trigger download
      var url = URL.createObjectURL(result.blob);
      var a = document.createElement("a");
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      var sizeKb = (result.blob.size / 1024).toFixed(1);
      statusEl.innerHTML = '<span class="badge badge-success">Backup created: ' + escapeHtml(result.filename) + ' (' + sizeKb + ' KB' + (pw ? ', encrypted' : '') + ')</span>';
      document.getElementById("backup-password").value = "";
      document.getElementById("backup-password-confirm").value = "";
      showToast("Backup downloaded: " + result.filename, "success");
      loadBackupHistory();
    } catch (err) {
      statusEl.innerHTML = '<span class="badge badge-error">' + escapeHtml(err.message) + '</span>';
      showToast("Backup failed: " + err.message, "error");
    } finally {
      btnBackup.disabled = false;
      btnBackup.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Create Backup';
    }
  });
}

// ─── Restore Logic ──────────────────────────────────────────────────────────

var _restoreFile = null;

function initRestoreControls() {
  var dropZone = document.getElementById("restore-drop-zone");
  var fileInput = document.getElementById("restore-file-input");
  var fileInfo = document.getElementById("restore-file-info");
  var btnRestore = document.getElementById("btn-restore");
  var btnCancel = document.getElementById("btn-restore-cancel");

  dropZone.addEventListener("dragover", function (e) {
    e.preventDefault();
    dropZone.classList.add("drag-over");
  });
  dropZone.addEventListener("dragleave", function () {
    dropZone.classList.remove("drag-over");
  });
  dropZone.addEventListener("drop", function (e) {
    e.preventDefault();
    dropZone.classList.remove("drag-over");
    if (e.dataTransfer.files.length > 0) selectRestoreFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", function () {
    if (fileInput.files.length > 0) selectRestoreFile(fileInput.files[0]);
  });

  btnCancel.addEventListener("click", function () {
    _restoreFile = null;
    fileInfo.style.display = "none";
    dropZone.style.display = "";
    document.getElementById("restore-status").innerHTML = "";
    fileInput.value = "";
  });

  btnRestore.addEventListener("click", async function () {
    if (!_restoreFile) return;
    var pw = document.getElementById("restore-password")?.value || null;
    var statusEl = document.getElementById("restore-status");

    if (!await warnIfDiscoveryRunning("restore")) return;

    var confirmed = await showConfirm("This will replace ALL current data with the backup contents. This cannot be undone. Continue?");
    if (!confirmed) return;

    btnRestore.disabled = true;
    btnRestore.textContent = "Restoring...";
    statusEl.innerHTML = '<span class="badge badge-info">Restoring database...</span>';

    try {
      var result = await api.serverSettings.restoreDatabase(_restoreFile, pw);
      statusEl.innerHTML = '<span class="badge badge-success">' + escapeHtml(result.message || "Restore completed") +
        (result.backupDate ? ' (backup from ' + escapeHtml(formatDate(result.backupDate)) + ')' : '') + '</span>';
      showToast("Database restored successfully", "success");

      // A restore drops and recreates every table, so the running processes are
      // holding stale relation OIDs (the service recycles its own pool, but the
      // monitor/discovery roles have their own) and possibly a generated Prisma
      // client built against a different schema version. Make the restart
      // impossible to miss rather than leaving the operator on a subtly broken
      // instance.
      if (result.restartRequired) {
        statusEl.innerHTML +=
          '<div style="margin-top:0.75rem;padding:0.6rem 0.75rem;border-radius:6px;' +
          'background:color-mix(in srgb, var(--color-warning) 12%, transparent);' +
          'border:1px solid color-mix(in srgb, var(--color-warning) 30%, transparent);' +
          'font-size:0.85rem;color:var(--color-text-primary)">' +
          '<strong style="color:var(--color-warning)">Restart required</strong> — ' +
          'every Polaris process must restart to pick up the restored schema. ' +
          'Until then, queries may fail with "could not open relation".' +
          '</div>';
      }

      // Reset the form
      _restoreFile = null;
      fileInfo.style.display = "none";
      dropZone.style.display = "";
      document.getElementById("restore-file-input").value = "";

      // Refresh the database info
      setTimeout(function () {
        _dbLoaded = false;
        loadDatabaseInfo();
      }, 1500);
    } catch (err) {
      statusEl.innerHTML = '<span class="badge badge-error">' + escapeHtml(err.message) + '</span>';
      showToast("Restore failed: " + err.message, "error");
    } finally {
      btnRestore.disabled = false;
      btnRestore.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" style="vertical-align:-2px;margin-right:4px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>Restore Database';
    }
  });
}

function selectRestoreFile(file) {
  _restoreFile = file;
  var dropZone = document.getElementById("restore-drop-zone");
  var fileInfo = document.getElementById("restore-file-info");
  var statusEl = document.getElementById("restore-status");

  dropZone.style.display = "none";
  fileInfo.style.display = "";
  statusEl.innerHTML = "";

  document.getElementById("restore-filename").textContent = file.name;
  document.getElementById("restore-filesize").textContent = formatFileSize(file.size);

  // Extract version from filename: polaris-backup-1.0.0-2026-...gz
  var versionMatch = file.name.match(/polaris-backup-(\d+\.\d+\.\d+)-/);
  var backupVersion = versionMatch ? versionMatch[1] : null;
  var currentVersion = _branding && _branding.version ? _branding.version : null;
  var versionEl = document.getElementById("restore-version");
  var warningEl = document.getElementById("restore-version-warning");

  if (backupVersion) {
    versionEl.textContent = backupVersion;
    if (currentVersion && backupVersion !== currentVersion) {
      warningEl.style.display = "";
      warningEl.innerHTML =
        '<strong style="color:var(--color-warning)">Version mismatch</strong> — ' +
        'This backup was created with <strong>v' + escapeHtml(backupVersion) + '</strong>, ' +
        'but the running application is <strong>v' + escapeHtml(currentVersion) + '</strong>. ' +
        'Restoring a backup from a different version may fail or cause issues if the database schema has changed. ' +
        'For best results, ensure the application version matches the backup version before restoring.';
    } else {
      warningEl.style.display = "none";
    }
  } else {
    versionEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Unknown</span>';
    warningEl.style.display = "";
    warningEl.innerHTML =
      '<strong style="color:var(--color-warning)">Unknown version</strong> — ' +
      'Could not determine the application version from this backup file. ' +
      'Ensure this backup was created by a compatible version of Polaris before restoring.';
  }

  var isEncrypted = file.name.includes(".enc");
  document.getElementById("restore-encrypted").innerHTML = isEncrypted
    ? '<span class="badge badge-warning" style="font-size:0.75rem">Yes</span>'
    : '<span class="badge badge-info" style="font-size:0.75rem">No</span>';
  document.getElementById("restore-password-row").style.display = isEncrypted ? "" : "none";

  // Also check magic bytes for encryption detection
  if (file.size > 8) {
    var reader = new FileReader();
    reader.onload = function () {
      var arr = new Uint8Array(reader.result);
      var magic = String.fromCharCode.apply(null, arr.slice(0, 7));
      if (magic === "POLARIS") {
        document.getElementById("restore-encrypted").innerHTML = '<span class="badge badge-warning" style="font-size:0.75rem">Yes</span>';
        document.getElementById("restore-password-row").style.display = "";
      }
    };
    reader.readAsArrayBuffer(file.slice(0, 8));
  }
}

// ─── Scheduled Backups ──────────────────────────────────────────────────────

async function loadBackupSchedule() {
  var enabledEl = document.getElementById("bksched-enabled");
  if (!enabledEl) return;
  var statusEl = document.getElementById("bksched-status");

  function syncFieldState() {
    var on = enabledEl.checked;
    ["bksched-interval", "bksched-hour", "bksched-retain", "bksched-passphrase", "bksched-copyto"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.disabled = !on;
    });
  }

  try {
    var s = await api.serverSettings.getBackupSchedule();
    enabledEl.checked = !!s.enabled;
    document.getElementById("bksched-interval").value = s.intervalHours;
    document.getElementById("bksched-hour").value = s.hourUtc === null ? "" : s.hourUtc;
    document.getElementById("bksched-retain").value = s.retainCount;
    // The GET returns the mask sentinel, never the stored passphrase. Sending it
    // back unchanged means "keep what is stored" (server-side isMaskedSecret).
    document.getElementById("bksched-passphrase").value = s.passphrase || "";
    document.getElementById("bksched-copyto").value = s.copyToDir || "";
    syncFieldState();

    if (s.lastError) {
      statusEl.innerHTML = '<span class="badge badge-danger">Last run failed: ' + escapeHtml(s.lastError) + '</span>';
    } else if (s.lastRunAt) {
      statusEl.innerHTML = '<span class="hint">Last successful backup: ' + escapeHtml(formatDate(s.lastRunAt)) + '</span>';
    } else if (s.enabled) {
      statusEl.innerHTML = '<span class="hint">Enabled — the first backup runs shortly.</span>';
    } else {
      statusEl.innerHTML = '';
    }
  } catch (err) {
    statusEl.innerHTML = '<span class="badge badge-danger">Could not load schedule: ' + escapeHtml(err.message) + '</span>';
    return;
  }

  enabledEl.addEventListener("change", syncFieldState);

  document.getElementById("btn-bksched-save").addEventListener("click", async function () {
    var btn = this;
    var hourRaw = document.getElementById("bksched-hour").value;
    var body = {
      enabled: enabledEl.checked,
      intervalHours: parseInt(document.getElementById("bksched-interval").value, 10) || 24,
      hourUtc: hourRaw === "" ? null : parseInt(hourRaw, 10),
      retainCount: parseInt(document.getElementById("bksched-retain").value, 10) || 7,
      passphrase: document.getElementById("bksched-passphrase").value,
      copyToDir: document.getElementById("bksched-copyto").value,
    };
    btn.disabled = true;
    btn.textContent = "Saving...";
    try {
      await api.serverSettings.saveBackupSchedule(body);
      showToast("Backup schedule saved", "success");
      await loadBackupSchedule();
    } catch (err) {
      showToast("Could not save schedule: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save Schedule";
    }
  });
}

// ─── Backup History ─────────────────────────────────────────────────────────

// The check that would have said "your pg_dump is PostgreSQL 13, your server
// is 15" on the day it became true, instead of on the day someone needed a
// restore (prod, 2026-09-09: months of failing backups behind "see the server
// log"). Renders nothing when the tools are fine; the resolver's own sentence
// — versions, path, fix — when they are not. Rule 47.
function renderBackupToolingBanner(t) {
  if (!t || t.ok) return '';
  var problems = [t.pgDump, t.psql].filter(function (r) { return r && !r.compatible; });
  if (problems.length === 0) return '';
  return '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:0.75rem 1rem;margin-bottom:0.75rem">' +
      '<div style="font-weight:600;font-size:0.88rem;margin-bottom:0.35rem">&#10007; Backups cannot run on this host</div>' +
      problems.map(function (r) {
        return '<p style="font-size:0.82rem;margin:0.25rem 0;line-height:1.5">' + escapeHtml(r.problem || (r.tool + ' is unusable')) + '</p>';
      }).join('') +
    '</div>';
}

async function loadBackupHistory() {
  var body = document.getElementById("backup-history-body");
  if (!body) return;
  try {
    // The tooling probe is best-effort: a failure there must not hide the list.
    var results = await Promise.all([
      api.serverSettings.listBackups(),
      api.serverSettings.backupTooling().catch(function () { return null; }),
    ]);
    var history = results[0];
    var toolingHtml = renderBackupToolingBanner(results[1]);
    if (!history || history.length === 0) {
      body.innerHTML = toolingHtml + '<p class="empty-state" style="font-size:0.85rem">No backups have been created yet.</p>';
      return;
    }
    body.innerHTML = toolingHtml +
      '<table class="ip-table"><thead><tr>' +
        '<th>Date</th><th>Filename</th><th style="text-align:right">Size</th><th>Encrypted</th><th style="width:140px"></th>' +
      '</tr></thead><tbody>' +
      history.slice(0, 20).map(function (b) {
        var dlBtn = b.downloadable !== false
          ? '<button class="btn btn-secondary btn-sm backup-dl-btn" data-id="' + escapeHtml(b.id) + '" data-filename="' + escapeHtml(b.filename) + '" style="font-size:0.75rem;padding:2px 8px">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:3px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
              'Download</button>'
          : '<span style="font-size:0.75rem;color:var(--color-text-tertiary)">Unavailable</span>';
        var preUpdateBadge = b.preUpdate
          ? ' <span class="badge" style="font-size:0.7rem;background:color-mix(in srgb, var(--color-warning) 15%, transparent);color:var(--color-warning);border:1px solid color-mix(in srgb, var(--color-warning) 40%, transparent)">Pre-update</span>'
          : '';
        var pathRow = b.path
          ? '<div class="mono" style="font-size:0.72rem;color:var(--color-text-tertiary);margin-top:2px;word-break:break-all" title="' + escapeHtml(b.path) + '">' + escapeHtml(b.path) + '</div>'
          : '';
        return '<tr>' +
          '<td style="font-size:0.82rem;white-space:nowrap;vertical-align:top">' + escapeHtml(formatDate(b.createdAt)) + '</td>' +
          '<td class="mono" style="font-size:0.82rem">' + escapeHtml(b.filename) + preUpdateBadge + pathRow + '</td>' +
          '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary);vertical-align:top">' + formatFileSize(b.size || b.sizeBytes || 0) + '</td>' +
          '<td style="vertical-align:top">' + (b.encrypted
            ? '<span class="badge badge-warning" style="font-size:0.7rem">Encrypted</span>'
            : '<span class="badge badge-info" style="font-size:0.7rem">Plain</span>') +
          '</td>' +
          '<td style="display:flex;gap:4px;vertical-align:top">' + dlBtn +
            '<button class="btn btn-danger btn-sm backup-del-btn" data-id="' + escapeHtml(b.id) + '" style="font-size:0.75rem;padding:2px 8px" title="Delete">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/></svg>' +
            '</button>' +
          '</td>' +
          '</tr>';
      }).join("") +
      '</tbody></table>';

    // Wire up download buttons
    body.querySelectorAll(".backup-dl-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-id");
        btn.disabled = true;
        btn.textContent = "...";
        api.serverSettings.downloadBackup(id).then(function (result) {
          if (!result || !result.blob) throw new Error("No data received");
          var url = URL.createObjectURL(result.blob);
          var a = document.createElement("a");
          a.href = url;
          a.download = result.filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
          showToast("Downloaded: " + result.filename, "success");
        }).catch(function (err) {
          showToast("Download failed: " + err.message, "error");
        }).finally(function () {
          btn.disabled = false;
          btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" style="vertical-align:-1px;margin-right:3px"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>Download';
        });
      });
    });

    body.querySelectorAll(".backup-del-btn").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        var id = btn.getAttribute("data-id");
        var ok = await showConfirm("Delete this backup? This cannot be undone.");
        if (!ok) return;
        btn.disabled = true;
        try {
          await api.serverSettings.deleteBackup(id);
          showToast("Backup deleted");
          loadBackupHistory();
        } catch (err) {
          showToast("Delete failed: " + err.message, "error");
          btn.disabled = false;
        }
      });
    });
  } catch {
    body.innerHTML = '<p class="empty-state" style="font-size:0.85rem">Could not load backup history.</p>';
  }
}

function formatFileSize(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  var units = ["B", "KB", "MB", "GB"];
  var i = 0;
  var size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

function dbInfoRow(label, value, hint) {
  var titleAttr = hint ? ' title="' + escapeHtml(hint) + '"' : "";
  return '<div class="db-info-label"' + titleAttr + '>' + escapeHtml(label) + '</div>' +
         '<div class="db-info-value">' + escapeHtml(String(value)) + '</div>';
}

function formatNumber(n) {
  if (n === undefined || n === null) return "-";
  return Number(n).toLocaleString();
}

// ─── Application Updates ───────────────────────────────────────────────────

var _updatePollTimer = null;

function initUpdateControls() {
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);

  // Show which repo updates are pulled from + where that's configured.
  loadUpdateRepoInfo();

  // Load and wire the backup checkbox + update-train dropdown (one settings GET)
  var backupCheckbox = document.getElementById("update-backup-checkbox");
  var trainSelect = document.getElementById("update-train-select");
  api.serverSettings.getUpdateSettings().then(function (s) {
    if (backupCheckbox) backupCheckbox.checked = !s.skipBackup;
    if (trainSelect) trainSelect.value = s.train === "release" ? "release" : "nightly";
  }).catch(function () {
    if (backupCheckbox) backupCheckbox.checked = true; // default: enabled
    if (trainSelect) trainSelect.value = "nightly";
  });
  if (backupCheckbox) {
    backupCheckbox.addEventListener("change", function () {
      api.serverSettings.setUpdateSettings({ skipBackup: !backupCheckbox.checked }).catch(function (err) {
        showToast("Failed to save setting: " + err.message, "error");
        backupCheckbox.checked = !backupCheckbox.checked; // revert
      });
    });
  }
  if (trainSelect) {
    var _prevTrain = trainSelect.value;
    trainSelect.addEventListener("change", function () {
      var train = trainSelect.value;
      api.serverSettings.setUpdateSettings({ train: train }).then(function () {
        _prevTrain = train;
        showToast("Update train set to " + (train === "release" ? "Release" : "Nightly"), "success");
        // A prior check reflects the old train — clear it so the operator
        // re-checks against the newly selected train.
        var statusEl = document.getElementById("update-check-status");
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Train changed — check for updates to compare.</span>';
      }).catch(function (err) {
        showToast("Failed to save setting: " + err.message, "error");
        trainSelect.value = _prevTrain; // revert
      });
    });
  }

  var historyEl = document.getElementById("update-history");
  if (historyEl) {
    var historyLoaded = false;
    historyEl.addEventListener("toggle", function () {
      if (!historyEl.open || historyLoaded) return;
      historyLoaded = true;
      loadUpdateHistory();
    });
  }

  // Check if there's a pending notification from a background check or previous restart
  api.serverSettings.getUpdateStatus().then(function (status) {
    if (status.state === "disabled") {
      renderUpdateDisabled(status);
    } else if (status.state === "complete") {
      renderUpdateComplete(status);
    } else if (status.state === "failed") {
      renderUpdateFailed(status);
    } else if (status.state === "available") {
      renderUpdateAvailable(status);
    } else if (status.state === "applying" || status.state === "restarting") {
      renderUpdateProgress();
      renderSteps(status.steps);
      startUpdatePolling();
    }
  }).catch(function () {});
}

function renderUpdateDisabled(status) {
  var area = document.getElementById("update-status-area");
  if (!area) return;
  area.innerHTML =
    '<div class="db-info-grid" style="margin-bottom:1rem">' +
      '<div class="db-info-label">Current Version</div>' +
      '<div class="db-info-value">v' + escapeHtml(status.currentVersion || '?') + '</div>' +
    '</div>' +
    '<div style="background:var(--color-bg-secondary);border:1px solid var(--color-border);border-radius:6px;padding:0.85rem 1rem">' +
      '<div style="font-weight:600;font-size:0.9rem;margin-bottom:0.35rem">' +
        escapeHtml(status.error || 'In-app updates are disabled.') +
      '</div>' +
      (status.method
        ? '<div style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(status.method) + '</div>'
        : '') +
    '</div>';
}

async function loadUpdateRepoInfo() {
  var el = document.getElementById("update-repo-info");
  if (!el) return;
  try {
    var info = await api.serverSettings.getUpdateRepo();
    if (!info || !info.url) {
      // Disabled/Docker installs or no origin remote — nothing useful to show.
      el.innerHTML = "";
      return;
    }
    var src = info.source === "env"
      ? 'configured via <span class="mono">POLARIS_UPDATE_REPO</span> in <span class="mono">.env</span>'
      : 'from the <span class="mono">origin</span> git remote (set <span class="mono">POLARIS_UPDATE_REPO</span> in <span class="mono">.env</span> to override)';
    el.innerHTML =
      '<span style="font-weight:600">Update source:</span> ' +
      '<span class="mono" style="color:var(--color-text-secondary)">' + escapeHtml(info.url) + '</span>' +
      '<br><span style="font-size:0.76rem">' + src + '</span>';
  } catch (err) {
    el.innerHTML = "";
  }
}

async function loadUpdateHistory() {
  var body = document.getElementById("update-history-body");
  if (!body) return;
  try {
    var commits = await api.serverSettings.getUpdateHistory(20);
    if (!commits || commits.length === 0) {
      body.innerHTML = '<span>No commit history available.</span>';
      return;
    }
    var html = '<div style="border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary);max-height:280px;overflow-y:auto">';
    commits.forEach(function (c, i) {
      html += '<div style="padding:0.35rem 0.6rem;' + (i < commits.length - 1 ? 'border-bottom:1px solid var(--color-border);' : '') + 'display:flex;gap:10px;align-items:baseline">' +
        '<span class="mono" style="color:var(--color-text-tertiary);flex-shrink:0">' + escapeHtml(c.hash) + '</span>' +
        (c.date ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;flex-shrink:0">' + escapeHtml(c.date) + '</span>' : '') +
        '<span style="color:var(--color-text-primary)">' + escapeHtml(c.subject) + '</span>' +
      '</div>';
    });
    html += '</div>';
    body.innerHTML = html;
  } catch (err) {
    body.innerHTML = '<span style="color:var(--color-danger)">Failed to load history: ' + escapeHtml(err.message || String(err)) + '</span>';
  }
}

async function checkForUpdatesUI() {
  var btn = document.getElementById("btn-check-updates");
  var statusEl = document.getElementById("update-check-status");
  btn.disabled = true;
  btn.textContent = "Checking...";
  statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Fetching latest version...</span>';

  try {
    var result = await api.serverSettings.checkForUpdates();

    if (result.state === "disabled") {
      renderUpdateDisabled(result);
      return;
    }

    if (result.state === "up-to-date") {
      if (result.note) {
        statusEl.innerHTML = '<span style="color:var(--color-text-secondary)">' + escapeHtml(result.note) + '</span>';
      } else {
        statusEl.innerHTML = '<span style="color:var(--color-success)">Up to date (v' + escapeHtml(result.currentVersion) + ')</span>';
      }
      btn.textContent = "Check for Updates";
      btn.disabled = false;
      return;
    }

    if (result.state === "available") {
      renderUpdateAvailable(result);
      return;
    }

    if (result.state === "failed") {
      statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(result.error || "Check failed") + '</span>';
    }
  } catch (err) {
    statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  }

  btn.textContent = "Check for Updates";
  btn.disabled = false;
}

function renderUpdateAvailable(result) {
  var area = document.getElementById("update-status-area");

  var changesHtml = "";
  if (result.changes && result.changes.length > 0) {
    changesHtml = '<div style="margin-top:0.75rem"><label style="font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-tertiary)">Changes (' + result.commitsBehind + ' commit' + (result.commitsBehind === 1 ? '' : 's') + ')</label>' +
      '<div style="max-height:160px;overflow-y:auto;margin-top:0.4rem;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary)">';
    result.changes.forEach(function (c) {
      var parts = c.match(/^(\w+)\s+(.*)$/);
      if (parts) {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' +
          '<span class="mono" style="color:var(--color-text-tertiary);margin-right:8px">' + escapeHtml(parts[1]) + '</span>' +
          '<span>' + escapeHtml(parts[2]) + '</span></div>';
      } else {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' + escapeHtml(c) + '</div>';
      }
    });
    changesHtml += '</div></div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-primary) 10%, transparent);border:1px solid var(--color-primary);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-primary);font-weight:600;font-size:0.95rem">Update Available</span>' +
        (result.train === "release"
          ? '<span style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);border:1px solid var(--color-border);border-radius:10px;padding:1px 8px">Release' + (result.releaseTag ? ' ' + escapeHtml(result.releaseTag) : '') + '</span>'
          : '<span style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);border:1px solid var(--color-border);border-radius:10px;padding:1px 8px">Nightly</span>') +
      '</div>' +
      // Set by the server when the checkout is already ahead of the running
      // build (an earlier update pulled, then failed before the restart).
      // Without it this card would read as a brand-new release.
      (result.note
        ? '<div style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.6rem">' + escapeHtml(result.note) + '</div>'
        : '') +
      '<div class="db-info-grid">' +
        '<div class="db-info-label">Current</div><div class="db-info-value">v' + escapeHtml(result.currentVersion) + ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(result.currentCommit) + ')</span></div>' +
        '<div class="db-info-label">Latest</div><div class="db-info-value">v' + escapeHtml(result.latestVersion) + ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(result.latestCommit) + ')</span></div>' +
      '</div>' +
      changesHtml +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-primary" id="btn-apply-update">Apply Update</button>' +
      '<button class="btn btn-secondary" id="btn-check-updates">Check Again</button>' +
      '<span id="update-check-status" style="font-size:0.82rem"></span>' +
    '</div>';

  document.getElementById("btn-apply-update").addEventListener("click", applyUpdateUI);
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
}

async function applyUpdateUI() {
  if (!await warnIfDiscoveryRunning("update")) return;

  var backupCheckbox = document.getElementById("update-backup-checkbox");
  var backupEnabled = backupCheckbox ? backupCheckbox.checked : true;

  var password = null;
  // Server default: a FAILED pre-update backup aborts the update. This flag is
  // the operator's explicit "proceed anyway", collected in the password modal.
  var allowWithoutBackup = false;
  if (backupEnabled) {
    var pwResult = await promptUpdateBackupPassword();
    if (pwResult === null) return; // user cancelled
    password = pwResult.password || null; // empty string → unencrypted
    allowWithoutBackup = !!pwResult.allowWithoutBackup;
  } else {
    var confirmed = await showConfirm(
      "Apply this update? Backup is disabled — no recovery point will be created, and the migration step cannot be rolled back. " +
      "The server will restart automatically when complete."
    );
    if (!confirmed) return;
  }

  var btn = document.getElementById("btn-apply-update");
  btn.disabled = true;
  btn.textContent = "Starting update...";

  try {
    await api.serverSettings.applyUpdate(password, allowWithoutBackup);
    renderUpdateProgress();
    startUpdatePolling();
    // Kick the sidebar's own update-progress panel (app.js). It self-paces at
    // 60 s while idle and 5 s only once it has SEEN an update in flight, so
    // without this nudge it can sleep clean through the applying phase and
    // never render — the panel is the only progress the operator has once they
    // navigate off this page.
    if (typeof window._pollUpdateProgress === "function") window._pollUpdateProgress();
  } catch (err) {
    showToast("Failed to start update: " + err.message, "error");
    btn.disabled = false;
    btn.textContent = "Apply Update";
  }
}

// Resolves to { password, allowWithoutBackup } — password "" means
// proceed-without-encryption — or null when the operator cancels.
function promptUpdateBackupPassword() {
  return new Promise(function (resolve) {
    var body =
      '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'A database backup will be created before the update and the server will restart automatically when complete. ' +
        'Optionally encrypt the backup with a password — recommended if the backup will be archived off-host.' +
      '</p>' +
      '<div class="form-row" style="gap:12px;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:180px">' +
          '<label for="update-backup-pw">Encryption password <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
          '<input type="password" id="update-backup-pw" placeholder="Leave blank for unencrypted backup" autocomplete="new-password">' +
        '</div>' +
        '<div style="flex:1;min-width:180px">' +
          '<label for="update-backup-pw-confirm">Confirm password</label>' +
          '<input type="password" id="update-backup-pw-confirm" placeholder="Re-enter password" autocomplete="new-password">' +
        '</div>' +
      '</div>' +
      '<div id="update-backup-pw-error" style="color:var(--color-danger);font-size:0.82rem;margin-top:0.5rem;min-height:1em"></div>' +
      // Unticked by default: if the backup fails, the update stops. Migrations
      // are not reversible, so continuing past a failed backup means the update
      // has no recovery point at all.
      '<label style="display:flex;align-items:flex-start;gap:8px;margin-top:1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
        '<input type="checkbox" id="update-allow-nobackup" style="margin-top:3px">' +
        '<span>Proceed even if the backup fails. Leave this off unless you accept that a failed migration would have no recovery point.</span>' +
      '</label>';
    var footer =
      '<button class="btn btn-secondary" id="upd-pw-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="upd-pw-ok">Apply Update</button>';
    openModal("Apply Update", body, footer);

    document.getElementById("upd-pw-cancel").onclick = function () {
      closeModal();
      resolve(null);
    };
    document.getElementById("upd-pw-ok").onclick = function () {
      var pw = document.getElementById("update-backup-pw").value;
      var pwConfirm = document.getElementById("update-backup-pw-confirm").value;
      var errEl = document.getElementById("update-backup-pw-error");
      if (pw && pw !== pwConfirm) {
        errEl.textContent = "Passwords do not match";
        return;
      }
      errEl.textContent = "";
      var allowEl = document.getElementById("update-allow-nobackup");
      closeModal();
      resolve({ password: pw || "", allowWithoutBackup: !!(allowEl && allowEl.checked) });
    };
    var pwInput = document.getElementById("update-backup-pw");
    if (pwInput) pwInput.focus();
  });
}

function renderUpdateProgress() {
  var area = document.getElementById("update-status-area");
  area.innerHTML =
    '<div style="margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.75rem">' +
        '<div class="spinner" style="width:18px;height:18px"></div>' +
        '<span style="font-weight:600">Updating...</span>' +
      '</div>' +
      '<div id="update-steps-list"></div>' +
    '</div>';
}

function renderSteps(steps) {
  var el = document.getElementById("update-steps-list");
  if (!el) return;

  var html = '';
  (steps || []).forEach(function (step) {
    var icon = '';
    var color = 'var(--color-text-tertiary)';
    if (step.status === "done") { icon = '&#10003;'; color = 'var(--color-success)'; }
    else if (step.status === "running") { icon = '&#9679;'; color = 'var(--color-primary)'; }
    else if (step.status === "failed") { icon = '&#10007;'; color = 'var(--color-danger)'; }
    else { icon = '&#9675;'; }

    html += '<div style="display:flex;align-items:center;gap:8px;padding:0.35rem 0;font-size:0.88rem">' +
      '<span style="color:' + color + ';font-size:1rem;width:20px;text-align:center;flex-shrink:0">' + icon + '</span>' +
      '<span style="' + (step.status === "running" ? 'font-weight:600' : '') + '">' + escapeHtml(step.name) + '</span>' +
      (step.message ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;margin-left:auto">' + escapeHtml(step.message) + '</span>' : '') +
    '</div>';
  });
  el.innerHTML = html;
}

function startUpdatePolling() {
  if (_updatePollTimer) clearInterval(_updatePollTimer);
  _updatePollTimer = setInterval(pollUpdateStatus, 2000);
}

function stopUpdatePolling() {
  if (_updatePollTimer) { clearInterval(_updatePollTimer); _updatePollTimer = null; }
}

var _serverDownSince = null;

async function pollUpdateStatus() {
  try {
    var status = await api.serverSettings.getUpdateStatus();
    _serverDownSince = null;

    if (status.state === "applying" || status.state === "restarting") {
      renderSteps(status.steps);
      if (status.state === "restarting") {
        // Server is about to go down — switch to restart polling
        stopUpdatePolling();
        pollForRestart(status);
      }
      return;
    }

    if (status.state === "complete") {
      stopUpdatePolling();
      window.location.href = "server-settings.html?tab=database";
      return;
    }

    if (status.state === "failed") {
      stopUpdatePolling();
      renderUpdateFailed(status);
      return;
    }
  } catch (err) {
    // Server is down — it's probably restarting
    if (!_serverDownSince) _serverDownSince = Date.now();
    // If server has been down for more than 60s, show an error
    if (Date.now() - _serverDownSince > 60000) {
      stopUpdatePolling();
      var area = document.getElementById("update-status-area");
      if (area) {
        area.innerHTML =
          '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem">' +
            '<strong style="color:var(--color-danger)">Server unreachable</strong>' +
            '<p style="font-size:0.82rem;margin-top:0.5rem">The server has not responded for over 60 seconds. It may have failed to restart. Check the server logs.</p>' +
          '</div>';
      }
    }
  }
}

function pollForRestart(lastStatus) {
  var area = document.getElementById("update-status-area");
  if (area) {
    renderSteps(lastStatus.steps);
    var stepsEl = document.getElementById("update-steps-list");
    if (stepsEl) {
      stepsEl.innerHTML += '<div style="display:flex;align-items:center;gap:8px;padding:0.5rem 0;font-size:0.88rem">' +
        '<div class="spinner" style="width:16px;height:16px"></div>' +
        '<span>Waiting for server to restart...</span>' +
      '</div>';
    }
  }

  var attempts = 0;
  var restartTimer = setInterval(async function () {
    attempts++;
    try {
      var status = await api.serverSettings.getUpdateStatus();
      if (status.state === "complete") {
        clearInterval(restartTimer);
        window.location.href = "server-settings.html?tab=database";
        return;
      }
      if (status.state === "failed") {
        clearInterval(restartTimer);
        renderUpdateFailed(status);
        return;
      }
    } catch (_) {
      // Server still down
    }
    if (attempts > 30) {
      clearInterval(restartTimer);
      if (area) {
        area.innerHTML =
          '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem">' +
            '<strong style="color:var(--color-danger)">Server did not come back</strong>' +
            '<p style="font-size:0.82rem;margin-top:0.5rem">The server has not responded after 60 seconds. Check the server logs for errors.</p>' +
            '<button class="btn btn-secondary" style="margin-top:0.75rem" onclick="location.reload()">Retry</button>' +
          '</div>';
      }
    }
  }, 2000);
}

// Lightweight standalone restart poller used by the Capacity Advisor "Restart
// Polaris to apply" button. Unlike pollForRestart, this isn't tied to the
// update-status state machine — a plain restart never reaches "complete", so
// we just wait for ANY successful response from the server and reload.
function pollUntilServerReachable() {
  // Full-screen overlay so the operator can see something is happening even
  // when the click happened from a non-update card.
  var overlay = document.createElement("div");
  overlay.className = "blocking-overlay";
  overlay.innerHTML =
    '<div class="blocking-overlay-card">' +
      '<div class="spinner" style="width:28px;height:28px;margin:0 auto 0.75rem"></div>' +
      '<strong>Restarting Polaris...</strong>' +
      '<p id="restart-poll-msg" style="font-size:0.82rem;margin-top:0.5rem;color:var(--color-text-secondary)">' +
        'Waiting for the server to come back online.' +
      '</p>' +
    '</div>';
  document.body.appendChild(overlay);

  var serverWentDown = false;
  var attempts = 0;
  var timer = setInterval(async function () {
    attempts++;
    try {
      await api.serverSettings.getUpdateStatus();
      if (serverWentDown) {
        // Was down, now reachable → reload to pick up the restarted process.
        clearInterval(timer);
        window.location.reload();
        return;
      }
    } catch (_) {
      // Server is down — expected during the restart window.
      serverWentDown = true;
    }
    if (attempts > 60) {
      clearInterval(timer);
      var msg = document.getElementById("restart-poll-msg");
      if (msg) {
        msg.innerHTML = '<span style="color:var(--color-danger)">Server has not responded after 120 seconds. ' +
          'Check the server logs.</span><br><button class="btn btn-secondary" style="margin-top:0.75rem" onclick="location.reload()">Retry</button>';
      }
    }
  }, 2000);
}

function renderUpdateComplete(status) {
  var area = document.getElementById("update-status-area");
  if (!area) return;

  var changesHtml = "";
  if (status.changes && status.changes.length > 0) {
    var n = status.changes.length;
    changesHtml = '<div style="margin-top:0.75rem"><label style="font-size:0.78rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:var(--color-text-tertiary)">Applied Changes (' + n + ' commit' + (n === 1 ? '' : 's') + ')</label>' +
      '<div style="max-height:200px;overflow-y:auto;margin-top:0.4rem;border:1px solid var(--color-border);border-radius:var(--radius-sm);background:var(--color-bg-secondary)">';
    status.changes.forEach(function (c) {
      var parts = c.match(/^(\w+)\s+(.*)$/);
      if (parts) {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' +
          '<span class="mono" style="color:var(--color-text-tertiary);margin-right:8px">' + escapeHtml(parts[1]) + '</span>' +
          '<span>' + escapeHtml(parts[2]) + '</span></div>';
      } else {
        changesHtml += '<div style="padding:0.3rem 0.6rem;font-size:0.82rem;border-bottom:1px solid var(--color-border)">' + escapeHtml(c) + '</div>';
      }
    });
    changesHtml += '</div></div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-success) 10%, transparent);border:1px solid var(--color-success);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-success);font-weight:600;font-size:0.95rem">&#10003; Update Complete</span>' +
      '</div>' +
      '<div class="db-info-grid">' +
        (status.currentVersion ? '<div class="db-info-label">Previous</div><div class="db-info-value">v' + escapeHtml(status.currentVersion) + '</div>' : '') +
        (status.latestVersion ? '<div class="db-info-label">Current</div><div class="db-info-value">v' + escapeHtml(status.latestVersion) + '</div>' : '') +
      '</div>' +
      changesHtml +
    '</div>' +
    '<div style="display:flex;gap:8px;align-items:center">' +
      '<button class="btn btn-secondary" id="btn-dismiss-update">Dismiss</button>' +
      '<button class="btn btn-secondary" onclick="location.reload()">Reload Page</button>' +
    '</div>';

  document.getElementById("btn-dismiss-update").addEventListener("click", async function () {
    await api.serverSettings.dismissUpdate();
    // Reset to check state
    var area2 = document.getElementById("update-status-area");
    area2.innerHTML =
      '<div class="db-info-grid" style="margin-bottom:1rem">' +
        '<div class="db-info-label">Current Version</div>' +
        '<div class="db-info-value">v' + escapeHtml(status.latestVersion || '?') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-secondary" id="btn-check-updates">Check for Updates</button>' +
        '<span id="update-check-status" style="font-size:0.82rem"></span>' +
      '</div>';
    document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
  });
}

function renderUpdateFailed(status) {
  var area = document.getElementById("update-status-area");
  if (!area) return;

  var stepsHtml = '';
  if (status.steps && status.steps.length > 0) {
    stepsHtml = '<div style="margin-top:0.75rem">';
    status.steps.forEach(function (step) {
      var icon = step.status === "done" ? "&#10003;" : step.status === "failed" ? "&#10007;" : "&#9675;";
      var color = step.status === "done" ? "var(--color-success)" : step.status === "failed" ? "var(--color-danger)" : "var(--color-text-tertiary)";
      stepsHtml += '<div style="display:flex;align-items:center;gap:8px;padding:0.25rem 0;font-size:0.85rem">' +
        '<span style="color:' + color + '">' + icon + '</span>' +
        '<span>' + escapeHtml(step.name) + '</span>' +
        (step.message ? '<span style="color:var(--color-text-tertiary);font-size:0.78rem;margin-left:auto">' + escapeHtml(step.message) + '</span>' : '') +
      '</div>';
    });
    stepsHtml += '</div>';
  }

  var recoveryHtml = '';
  if (status.backupFile) {
    // Three separate psql sessions, not one: a database with TimescaleDB must be
    // restored between timescaledb_pre_restore() and timescaledb_post_restore(),
    // and pre_restore only affects sessions opened after it. The single
    // `gunzip | psql` this card used to print skipped both and corrupted a
    // Timescale restore — same defect the fallback scripts carried until 2026-09.
    var CODE = 'font-size:0.8rem;background:var(--color-bg-secondary);padding:1px 5px;border-radius:3px';
    var BLOCK = 'display:block;margin-top:0.3rem;font-size:0.8rem;background:var(--color-bg-secondary);padding:4px 8px;border-radius:3px;white-space:nowrap;overflow-x:auto';
    var restoreCmd = 'gunzip -c ' + status.backupFile + ' | sudo -u postgres psql -v ON_ERROR_STOP=1 --single-transaction -d polaris';
    recoveryHtml =
      '<div style="margin-top:1rem;background:color-mix(in srgb, var(--color-warning) 8%, transparent);border:1px solid color-mix(in srgb, var(--color-warning) 35%, transparent);border-radius:6px;padding:1rem">' +
        '<div style="font-weight:600;font-size:0.88rem;margin-bottom:0.5rem">Pre-update backup available</div>' +
        '<p style="font-size:0.82rem;margin:0 0 0.75rem">A backup was created before the update started. Download it from <strong>Backup History</strong> below before attempting any recovery.</p>' +
        '<details>' +
          '<summary style="cursor:pointer;font-size:0.82rem;color:var(--color-text-secondary);user-select:none">Manual restore instructions (if the app is unavailable)</summary>' +
          '<ol style="font-size:0.82rem;margin:0.6rem 0 0.5rem;padding-left:1.4rem;line-height:1.7">' +
            '<li>Download the pre-update backup from <strong>Backup History</strong> below and copy it to the server.</li>' +
            '<li>Prefer <strong>Server Settings → Maintenance → Restore</strong> once the app is reachable — it runs the TimescaleDB restore gates for you. The steps below are for when it is not.</li>' +
            '<li>Stop the Polaris process group:<br>' +
              '<code style="' + CODE + '">sudo systemctl stop polaris.target</code> &nbsp;(Linux) &nbsp;or&nbsp; ' +
              '<code style="' + CODE + '">nssm stop &lt;service&gt;</code> for each Polaris service (Windows)</li>' +
            '<li>Open the TimescaleDB restore window (skip this and step 6 only if the extension is not installed):<br>' +
              '<code style="' + BLOCK + '">sudo -u postgres psql -d polaris -c \'SELECT timescaledb_pre_restore();\'</code></li>' +
            '<li>Restore the dump:<br>' +
              '<code style="' + BLOCK + '">' + escapeHtml(restoreCmd) + '</code></li>' +
            '<li>Close the restore window — <strong>run this even if step 5 failed</strong>; a database left in restoring mode rejects hypertable writes:<br>' +
              '<code style="' + BLOCK + '">sudo -u postgres psql -d polaris -c \'SELECT timescaledb_post_restore();\'</code></li>' +
            '<li>Start the process group again:<br>' +
              '<code style="' + CODE + '">sudo systemctl start polaris.target</code> &nbsp;(Linux) &nbsp;or&nbsp; ' +
              '<code style="' + CODE + '">nssm start &lt;service&gt;</code> for each Polaris service (Windows — and use <code style="' + CODE + '">psql -U postgres</code> in place of <code style="' + CODE + '">sudo -u postgres psql</code> above)</li>' +
          '</ol>' +
        '</details>' +
      '</div>';
  }

  area.innerHTML =
    '<div style="background:color-mix(in srgb, var(--color-danger) 10%, transparent);border:1px solid var(--color-danger);border-radius:6px;padding:1rem;margin-bottom:1rem">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:0.5rem">' +
        '<span style="color:var(--color-danger);font-weight:600;font-size:0.95rem">&#10007; Update Failed</span>' +
      '</div>' +
      '<p style="font-size:0.85rem;margin:0.5rem 0">' + escapeHtml(status.error || 'Unknown error') + '</p>' +
      stepsHtml +
    '</div>' +
    recoveryHtml +
    '<div style="display:flex;gap:8px;align-items:center;margin-top:1rem">' +
      '<button class="btn btn-secondary" id="btn-dismiss-update">Dismiss</button>' +
      '<button class="btn btn-secondary" id="btn-check-updates">Check Again</button>' +
    '</div>';

  // Reload backup history so the pre-update backup entry is visible immediately
  if (status.backupFile) loadBackupHistory();

  document.getElementById("btn-dismiss-update").addEventListener("click", async function () {
    await api.serverSettings.dismissUpdate();
    _dbLoaded = false;
    loadDatabaseInfo();
  });
  document.getElementById("btn-check-updates").addEventListener("click", checkForUpdatesUI);
}

// ─── Customization Tab ─────────────────────────────────────────────────────

var _brandingLoaded = false;
// Shipped-default logo URLs, current first. "/logo.png" was retired 2026-08 but
// is still stored by installs seeded before then; only the pre-upgrade fallback
// below consults this. Mirrors DEFAULT_LOGO_URLS in services/brandingService.ts.
var DEFAULT_LOGO_URLS = ["/img/brand/polaris-symbol-dark.png", "/logo.png"];
var _brandingData = { appName: "Polaris", subtitle: "Network Management Tool", logoUrl: "/img/brand/polaris-symbol-dark.png" };

async function loadCustomizationTab() {
  var container = document.getElementById("tab-customization");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';

  try {
    _brandingData = await api.serverSettings.getBranding();
    _brandingLoaded = true;
    renderCustomizationTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function renderCustomizationTab() {
  var container = document.getElementById("tab-customization");
  // `customLogo` is computed server-side (brandingService.hasCustomLogo); the
  // path comparison is the fallback for a pre-upgrade payload.
  var isCustomLogo = _brandingData.customLogo !== undefined
    ? _brandingData.customLogo
    : Boolean(_brandingData.logoUrl && DEFAULT_LOGO_URLS.indexOf(_brandingData.logoUrl) === -1);
  // Placement + accent default ON/OFF the same way the server does, so an
  // install that has never saved this card renders its real behavior.
  var logoAccent    = _brandingData.logoAccent === true;
  var logoOnLogin   = _brandingData.logoOnLogin !== false;
  var logoOnSidebar = _brandingData.logoOnSidebar !== false;
  // The preview must show what the surfaces show — i.e. the composited PNG
  // once the accent is on. Cache-busted per render since the upload route
  // reuses one filename.
  var previewSrc = isCustomLogo
    ? (logoAccent
        // Same theme the surfaces will request, so the preview shows the
        // variant this operator is actually looking at.
        ? "/api/v1/server-settings/branding/logo-accent.png?theme=" +
          PolarisBrandLogo.currentTheme() + "&t=" + Date.now()
        : _brandingData.logoUrl)
    : PolarisBrandLogo.ASSETS.sidebar[PolarisBrandLogo.currentTheme()];
  // Pre-feature payloads carry no temperatureUnit — treat anything but "f" as °C,
  // matching normalizeTemperatureUnit server-side.
  var tempUnit = _brandingData.temperatureUnit === "f" ? "f" : "c";

  container.innerHTML =
    '<div class="settings-cards-row">' +
    '<div class="settings-card">' +
      '<h4>Application Name</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Change the name shown in browser tabs and PDF exports. ' +
        'On the login page and in the sidebar it is printed <strong>only beside a custom logo</strong> — ' +
        'the Polaris logo already spells the name out, so it is not repeated underneath. ' +
        'Leave it blank if your own logo carries your wordmark.' +
      '</p>' +
      '<div class="form-group"><label>Application Name</label>' +
        '<input type="text" id="f-brand-appname" value="' + escapeHtml(_brandingData.appName || "") + '" placeholder="e.g. Polaris">' +
      '</div>' +
      '<div class="form-group"><label>Subtitle</label>' +
        '<input type="text" id="f-brand-subtitle" value="' + escapeHtml(_brandingData.subtitle || "") + '" placeholder="e.g. Network Management Tool">' +
        '<p class="hint">Shown beneath the application name on the sidebar and login page.</p>' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-brand-save">Save</button>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Logo</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Upload a custom logo to replace the Polaris one. Recommended size: 280\u00d7280px or larger. Supported formats: PNG, JPEG, WebP. ' +
        'Wherever your logo is switched off below, Polaris shows its own mark in the version that suits the current theme.' +
      '</p>' +
      '<div style="display:flex;align-items:flex-start;gap:1.5rem;flex-wrap:wrap">' +
        '<div style="flex-shrink:0">' +
          '<div class="logo-preview-box">' +
            '<img id="logo-preview" src="' + escapeHtml(previewSrc) + '" alt="Current logo">' +
          '</div>' +
          '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:0.5rem;text-align:center">' +
            (isCustomLogo ? 'Custom logo' : 'Polaris logo') +
          '</p>' +
        '</div>' +
        '<div style="flex:1;min-width:200px">' +
          '<div class="upload-area" id="logo-upload-area">' +
            '<input type="file" id="logo-file-input" accept="image/png,image/jpeg,image/webp">' +
            '<strong style="color:var(--color-text-primary)">Upload New Logo</strong>' +
            '<p>Click to select an image file</p>' +
          '</div>' +
          (isCustomLogo
            ? '<button class="btn btn-secondary" id="btn-logo-reset" style="margin-top:0.75rem">Reset to Default</button>'
            : '') +
        '</div>' +
      '</div>' +
      // Placement + accent. Shown always so the options are discoverable, but
      // inert without a custom logo \u2014 they only choose where YOUR logo goes.
      '<div style="margin-top:1.25rem;border-top:1px solid var(--color-border);padding-top:1rem' +
        (isCustomLogo ? '' : ';opacity:0.55') + '">' +
        '<label style="display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.6rem">' +
          '<input type="checkbox" id="f-logo-on-login"' + (logoOnLogin ? ' checked' : '') + (isCustomLogo ? '' : ' disabled') + ' style="margin-top:0.2rem">' +
          '<span><strong>Show my logo on the login page</strong>' +
            '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">Off: the Polaris wordmark is shown there instead.</span>' +
          '</span>' +
        '</label>' +
        '<label style="display:flex;align-items:flex-start;gap:0.5rem;margin-bottom:0.6rem">' +
          '<input type="checkbox" id="f-logo-on-sidebar"' + (logoOnSidebar ? ' checked' : '') + (isCustomLogo ? '' : ' disabled') + ' style="margin-top:0.2rem">' +
          '<span><strong>Show my logo in the top-left corner after login</strong>' +
            '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">Off: the Polaris mark is shown in the sidebar instead.</span>' +
          '</span>' +
        '</label>' +
        '<label style="display:flex;align-items:flex-start;gap:0.5rem">' +
          '<input type="checkbox" id="f-logo-accent"' + (logoAccent ? ' checked' : '') + (isCustomLogo ? '' : ' disabled') + ' style="margin-top:0.2rem">' +
          '<span><strong>Accent my logo with the Polaris symbol</strong>' +
            '<span style="display:block;font-size:0.78rem;color:var(--color-text-tertiary)">Overlays the Polaris star on the bottom-right corner of your logo, at about 50% of its size.</span>' +
          '</span>' +
        '</label>' +
        '<button class="btn btn-primary" id="btn-logo-placement-save" style="margin-top:0.9rem"' + (isCustomLogo ? '' : ' disabled') + '>Save</button>' +
      '</div>' +
    '</div>' +
    '<div class="settings-card">' +
      '<h4>Display Units</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Hardware-sensor temperatures are always collected, stored, and alerted on in Celsius. ' +
        'This changes only how they are <strong>displayed</strong> — the asset Hardware Sensors table and ' +
        'sensor charts, the mobile app, the Highest Temperature widget, and the Dash wallboard. ' +
        'Automation thresholds are unaffected and stay in °C.' +
      '</p>' +
      '<div class="form-group"><label>Temperature</label>' +
        '<select id="f-brand-tempunit">' +
          '<option value="c"' + (tempUnit === "c" ? ' selected' : '') + '>Celsius (°C)</option>' +
          '<option value="f"' + (tempUnit === "f" ? ' selected' : '') + '>Fahrenheit (°F)</option>' +
        '</select>' +
        '<p class="hint">Applies to every operator and to the unauthenticated wallboard.</p>' +
      '</div>' +
      '<button class="btn btn-primary" id="btn-tempunit-save">Save</button>' +
    '</div>' +
    '</div>';

  // Wire save buttons — every card PUTs the whole branding payload, so any one
  // of them persists whatever the operator changed on this tab.
  document.getElementById("btn-brand-save").addEventListener("click", function () { saveBranding(false); });
  document.getElementById("btn-tempunit-save").addEventListener("click", function () { saveBranding(false); });
  var placementBtn = document.getElementById("btn-logo-placement-save");
  // Re-render after this one: the preview swaps to (or away from) the
  // server-composited accent version.
  if (placementBtn) placementBtn.addEventListener("click", function () { saveBranding(true); });

  // Wire logo upload
  wireUploadArea("logo-upload-area", "logo-file-input", uploadLogo);

  // Wire reset button
  var resetBtn = document.getElementById("btn-logo-reset");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetLogo);
  }
}

async function saveBranding(rerender) {
  var btns = ["btn-brand-save", "btn-tempunit-save", "btn-logo-placement-save"]
    .map(function (id) { return document.getElementById(id); })
    .filter(Boolean);
  // Remember which were already disabled (the placement block is, without a
  // custom logo) so re-enabling can't hand out a control the card had greyed.
  var wasDisabled = btns.map(function (b) { return b.disabled; });
  btns.forEach(function (b) { b.disabled = true; });
  try {
    var unitEl = document.getElementById("f-brand-tempunit");
    var loginEl = document.getElementById("f-logo-on-login");
    var sidebarEl = document.getElementById("f-logo-on-sidebar");
    var accentEl = document.getElementById("f-logo-accent");
    var data = {
      appName: document.getElementById("f-brand-appname").value.trim(),
      subtitle: document.getElementById("f-brand-subtitle").value.trim(),
      temperatureUnit: unitEl ? unitEl.value : undefined,
    };
    // Omitted rather than sent as undefined-ish: the PUT falls back to the
    // stored value per field, so a card that didn't render these can't clear them.
    if (loginEl)   data.logoOnLogin   = loginEl.checked;
    if (sidebarEl) data.logoOnSidebar = sidebarEl.checked;
    if (accentEl)  data.logoAccent    = accentEl.checked;
    _brandingData = await api.serverSettings.updateBranding(data);
    applyBranding(_brandingData);
    // Same URL, new bytes when the accent flipped — force the live sidebar to
    // re-fetch so the operator sees the change without a reload.
    PolarisBrandLogo.applyTo(document.querySelector(".sidebar-logo"), _brandingData, "sidebar", { bust: true });
    showToast("Branding saved");
    if (rerender) renderCustomizationTab();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btns.forEach(function (b, i) { b.disabled = wasDisabled[i]; });
  }
}

async function uploadLogo(files) {
  if (!files || files.length === 0) return;
  var file = files[0];
  if (!file.type.startsWith("image/")) {
    showToast("Please select an image file", "error");
    return;
  }
  try {
    _brandingData = await api.serverSettings.uploadLogo(file);
    applyBranding(_brandingData);
    // The upload route reuses one filename, so the sidebar's <img> URL didn't
    // change even though the image did — force it to re-fetch.
    PolarisBrandLogo.applyTo(document.querySelector(".sidebar-logo"), _brandingData, "sidebar", { bust: true });
    renderCustomizationTab();
    showToast("Logo uploaded");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function resetLogo() {
  var ok = await showConfirm("Reset to the default logo?");
  if (!ok) return;
  try {
    _brandingData = await api.serverSettings.deleteLogo();
    applyBranding(_brandingData);
    // The upload route reuses one filename, so the sidebar's <img> URL didn't
    // change even though the image did — force it to re-fetch.
    PolarisBrandLogo.applyTo(document.querySelector(".sidebar-logo"), _brandingData, "sidebar", { bust: true });
    renderCustomizationTab();
    showToast("Logo reset to default");
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Identification Tab ────────────────────────────────────────────────────

var _tagsLoaded = false;
var _tagsData = [];
var _emptyCategories = [];
var _tagSettings = { enforce: false };
var _ouiOverrides = [];
var _placeholderMac = null;
var _mibsData = [];
var _mibFacets = { manufacturers: [], modelsByManufacturer: {} };
var _manufacturerAliases = [];
var _deviceIcons = [];
// Device Types card: the AssetTypeDef registry with its usage counts, plus the
// matching vocabulary + authoritative-source catalogue the server publishes so
// this file doesn't carry a second copy that drifts from the resolver.
var _assetTypes = [];
// `condition` is the shared condition-builder catalog (fields + operators +
// group operators + labels + depth cap), in the same shape scopeConditionMeta
// publishes for the automations device filter — see _dtConditionMeta.
var _assetTypeMatchSchema = { fields: [], ops: [], contexts: [], condition: null, authoritativeSources: [] };
var _mibFilter = { manufacturer: "", model: "", scope: "all" };
// Slice 6b — editable Manufacturer Profile (DB-backed) state.
// _mfgProfiles is the summary list shown in the card; _mfgProfileTransforms
// is the static transform registry (shipped alongside the summary). Per-
// profile detail (metrics + overrides + widgets) is loaded on-demand into
// _mfgProfileDetail when the operator expands a row.
var _mfgProfiles = [];
var _mfgProfileTransforms = [];
// Binary combiners (CombinerKind on the backend). Populated from the same
// /manufacturer-profiles GET that delivers _mfgProfileTransforms. The
// Transform select swaps option list between transforms and combiners
// based on the row's current Type (double_scalar → combiners; everything
// else → unary transforms).
var _mfgProfileCombiners = [];
var _mfgProfileDetail = {};         // profileId → full profile (lazy)
var _mfgProfileExpanded = {};       // profileId → bool
var _mfgProfileMetricEdit = {};     // composite key "id:metricKey" → bool (edit-in-progress)
var _mfgProfileOverrideEdit = {};   // overrideId → bool (edit-in-progress on a per-model override row)
// Typeahead values for the "+ Add Manufacturer" box. Lazy — fetched on first
// focus of the input rather than with the tab payload, since the card renders
// on two tabs and most visits never touch the add box. Invalidated after a
// create so the new profile drops out of its own suggestion list.
var _mfgSuggestions = null;         // [{ value, sources[], assetCount }] | null
var _mfgSuggestionsPromise = null;  // in-flight fetch (coalesces rapid focus)
// MIB symbol cache for the chained MIB → Symbol pickers. Lazily populated
// by `_ensureMibSymbols(mibId)` when an operator selects a MIB; results
// are kept across re-renders so the symbol dropdown is instant on second
// open. Cleared when an admin uploads / deletes a MIB elsewhere.
var _mfgMibSymbolsCache = {};       // mibId → { loading: bool, names: string[] }
// Mid-edit MIB selections — when the operator changes a MIB dropdown, the
// new value is parked here so the next re-render can show the symbol
// picker driven by the freshly-selected MIB before the form is saved.
// Cleared when the row exits edit mode (save / cancel).
var _mfgEditMibSelections = {};     // key → mibId (key shape: "metric:{pid}:{mk}" | "override:{oid}" | "new:{pid}:{mk}")
function _mfgEditMibId(profileId, metricKey) {
  return _mfgEditMibSelections["metric:" + profileId + ":" + metricKey];
}
function _mfgOverrideEditMibId(overrideId) {
  return _mfgEditMibSelections["override:" + overrideId];
}
function _mfgNewOverrideMibId(profileId, metricKey) {
  return _mfgEditMibSelections["new:" + profileId + ":" + metricKey];
}

// Mid-edit Type selections — generalized to support `double_scalar`
// alongside the existing scalar / table. Drives the per-row Symbol cell
// (1 or 2 pickers) AND the Transform select's option list (unary
// transforms vs binary combiners). Cleared on save / cancel.
var _mfgEditTypeSelections = {};    // key → "scalar" | "double_scalar" | "table"
function _mfgEditTypeFor(key, fallback) {
  if (key in _mfgEditTypeSelections) return _mfgEditTypeSelections[key];
  return fallback || "scalar";
}

// Per-widget edit state. Key shape: "widget:" + widgetId. Edit mode opens
// when the operator clicks Edit on a widget card; cleared on save / cancel.
var _mfgWidgetEdit = {};
// Per-profile add-widget state. Key shape: profileId. true = the "+ Add
// widget" card below the list is expanded into a form.
var _mfgAddingWidget = {};
// Widget-edit shadow stores (mirror the metric-row shadow pattern). Same
// key-shape convention so the dropdown change handlers can re-render the
// dependent pickers (Symbol depends on MIB + Type; the gauge/line/table
// display options block depends on widgetType). Cleared on save / cancel.
//   _mfgWidgetEditMib[key]        — currently selected MIB (split via splitMibSelection on save)
//   _mfgWidgetEditType[key]       — scalar | table (drives Symbol picker)
//   _mfgWidgetEditWidgetType[key] — gauge | line | table (drives displayOptions sub-editor)
// Key shape: "widget:" + widgetId | "new-widget:" + profileId
var _mfgWidgetEditMib        = {};
var _mfgWidgetEditType       = {};
var _mfgWidgetEditWidgetType = {};
function _mfgWidgetMibFor(key, fallback) {
  if (key in _mfgWidgetEditMib) return _mfgWidgetEditMib[key];
  return fallback || "";
}
function _mfgWidgetTypeFor(key, fallback) {
  if (key in _mfgWidgetEditType) return _mfgWidgetEditType[key];
  return fallback || "scalar";
}
function _mfgWidgetWidgetTypeFor(key, fallback) {
  if (key in _mfgWidgetEditWidgetType) return _mfgWidgetEditWidgetType[key];
  return fallback || "gauge";
}
function _mfgWidgetClearShadow(key) {
  delete _mfgWidgetEditMib[key];
  delete _mfgWidgetEditType[key];
  delete _mfgWidgetEditWidgetType[key];
}
// Type-column labels for the operator-facing dropdown. `double_scalar` is
// the bytes-form pair (two OIDs combined by a binary combiner — replaces
// the memory-only "composition" feature).
var _MFG_TYPE_LABELS = {
  scalar:        "scalar",
  double_scalar: "double scalar",
  table:         "table",
};
// Generic Type select used by every metric row + override. `kinds` controls
// which options are rendered — pass `["scalar","double_scalar","table"]` for
// metric rows, or `["scalar","table"]` for the custom-widget form (widgets
// don't support double_scalar because the resolver wouldn't know how to
// combine the two readings inside the widget render path).
function _typeSelectHTML(cls, current, kinds) {
  var ks = kinds || ["scalar", "double_scalar", "table"];
  var v = current || ks[0];
  var html = '<select class="' + cls + '" style="font-size:0.78rem">';
  ks.forEach(function (k) {
    html += '<option value="' + k + '"' + (v === k ? " selected" : "") + '>' +
      escapeHtml(_MFG_TYPE_LABELS[k] || k) + '</option>';
  });
  html += '</select>';
  return html;
}
// View-mode rendering of the Symbol cell. One OID for scalar/table, two
// stacked labelled OIDs ("A:" + "B:") for double_scalar.
function _symbolCellViewHTML(type, symbol, symbolB) {
  if (type === "double_scalar" && (symbol || symbolB)) {
    return '<div style="display:flex;flex-direction:column;gap:2px">' +
      '<span><code style="font-size:0.85rem">A: ' + escapeHtml(symbol  || "") + '</code></span>' +
      '<span><code style="font-size:0.85rem">B: ' + escapeHtml(symbolB || "") + '</code></span>' +
    '</div>';
  }
  return symbol
    ? '<code style="font-size:0.85rem">' + escapeHtml(symbol) + '</code>'
    : '<span style="color:var(--color-text-tertiary);font-style:italic">(built-in seed)</span>';
}
// Edit-mode rendering of the Symbol cell — 1 picker for scalar/table, 2
// stacked pickers ("A:" + "B:") for double_scalar. Picker classes carry
// the suffix so the save handler can pull them by role.
//   cls + "-a"  — symbol A (also serves the single-symbol scalar/table case)
//   cls + "-b"  — symbol B (double_scalar only)
function _symbolCellEditHTML(type, mibId, symbol, symbolB, cls) {
  function row(label, suffix, val) {
    return '<div style="display:flex;align-items:center;gap:6px;font-size:0.78rem">' +
      '<span style="color:var(--color-text-tertiary);flex:0 0 24px">' + escapeHtml(label) + '</span>' +
      renderSymbolPicker(val, mibId, cls + "-" + suffix) +
    '</div>';
  }
  if (type === "double_scalar") {
    return '<div style="display:flex;flex-direction:column;gap:4px">' +
      row("A:", "a", symbol  || "") +
      row("B:", "b", symbolB || "") +
    '</div>';
  }
  // scalar / table — single picker. The class still carries the "-a" suffix
  // so the save handler can read it uniformly.
  return renderSymbolPicker(symbol || "", mibId, cls + "-a", type);
}
// Pull `{symbol, symbolB}` from an edit-mode <tr>. Returns symbolB=null on
// scalar / table; caller validates required-symbol on the row's type.
function _readSymbolPair(tr, clsBase, type) {
  var a = (tr.querySelector("." + clsBase + "-a") || {}).value || "";
  if (type === "double_scalar") {
    var b = (tr.querySelector("." + clsBase + "-b") || {}).value || "";
    return { symbol: a.trim(), symbolB: b.trim() };
  }
  return { symbol: a.trim(), symbolB: null };
}

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
        '<input type="text" id="f-oui-manufacturer" placeholder="e.g. Custom Switch Co.">' +
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
        '<input type="text" id="f-alias-input" placeholder="e.g. Fortinet, Inc.">' +
      '</div>' +
      '<div style="flex:1;min-width:120px">' +
        '<label style="font-size:0.78rem;font-weight:500">Canonical</label>' +
        '<input type="text" id="f-alias-canonical" placeholder="e.g. Fortinet">' +
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

  html +=
    '<div class="settings-card">' +
      '<h4>Tags</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Define tags used to classify assets, networks, and blocks. Tags can be organized by category for easier filtering.' +
      '</p>' +
      '<div class="form-group" style="margin-bottom:1rem">' +
        '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
          '<input type="checkbox" id="f-enforce-tags"' + (_tagSettings.enforce ? ' checked' : '') + '>' +
          '<span>Force predefined tags</span>' +
        '</label>' +
        '<p class="hint">When enabled, users can only select from predefined tags when creating or editing networks and assets. Free-text tag entry will be disabled.</p>' +
      '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:1rem">' +
        '<button class="btn btn-primary" id="btn-add-tag">+ Add Tag</button>' +
      '</div>';

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
        tags.forEach(function (t) {
          var colorStyle = t.color ? ' style="background:' + escapeHtml(t.color) + '22;border-color:' + escapeHtml(t.color) + ';color:' + escapeHtml(t.color) + '"' : '';
          // Either filter shape counts — a tag written before the condition-tree
          // cutover still auto-assigns through the folded-forward flat blob.
          var managed = !!(t.assetCondition || (t.criteria && t.criteria.rules && t.criteria.rules.length));
          var autoMark = managed
            ? '<span title="Auto-assigned by device filter" style="margin-right:4px">&#9881;</span>'
            : '';
          html += '<span class="tag-chip"' + colorStyle + '>' +
            autoMark +
            escapeHtml(t.name) +
            (isAdmin() ? '<button class="tag-chip-edit" data-tag-id="' + t.id + '" title="Edit" style="margin-left:4px;background:none;border:none;color:inherit;cursor:pointer;font-size:0.75rem;opacity:0.7;padding:0">&#9998;</button>' : '') +
            (isAdmin() ? '<button class="tag-chip-delete" data-tag-id="' + t.id + '" title="Delete">&times;</button>' : '') +
          '</span>';
        });
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
  document.getElementById("btn-add-tag").addEventListener("click", openAddTagModal);

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

// ─── MIB Database card ─────────────────────────────────────────────────────

function _mibFilteredRows() {
  return _mibsData.filter(function (m) {
    if (_mibFilter.scope === "generic" && m.manufacturer) return false;
    if (_mibFilter.scope === "device" && !m.manufacturer) return false;
    if (_mibFilter.manufacturer && (m.manufacturer || "").toLowerCase() !== _mibFilter.manufacturer.toLowerCase()) return false;
    if (_mibFilter.model && (m.model || "").toLowerCase() !== _mibFilter.model.toLowerCase()) return false;
    return true;
  });
}

function _mibManufacturerOptions(selected) {
  var opts = '<option value=""' + (!selected ? ' selected' : '') + '>All manufacturers</option>';
  (_mibFacets.manufacturers || []).forEach(function (m) {
    opts += '<option value="' + escapeHtml(m) + '"' + (selected === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
  });
  return opts;
}

function _mibModelOptions(manufacturer, selected) {
  var models = (_mibFacets.modelsByManufacturer || {})[manufacturer] || [];
  var opts = '<option value=""' + (!selected ? ' selected' : '') + '>All models</option>';
  models.forEach(function (m) {
    opts += '<option value="' + escapeHtml(m) + '"' + (selected === m ? ' selected' : '') + '>' + escapeHtml(m) + '</option>';
  });
  return opts;
}

// ─── Manufacturer Aliases helpers ──────────────────────────────────────────
// (card HTML is inlined into renderIdentificationTab as part of the consolidated
// MAC & Vendor Identification card)

function wireManufacturerAliasControls() {
  var addBtn = document.getElementById("btn-add-alias");
  if (addBtn) addBtn.addEventListener("click", addManufacturerAlias);

  var container = document.getElementById("tab-identification");
  container.querySelectorAll(".alias-del").forEach(function (btn) {
    btn.addEventListener("click", function () {
      deleteManufacturerAliasUI(btn.getAttribute("data-id"));
    });
  });
  container.querySelectorAll(".alias-edit").forEach(function (btn) {
    btn.addEventListener("click", function () {
      editManufacturerAliasUI(btn.getAttribute("data-id"));
    });
  });
}

async function addManufacturerAlias() {
  var aliasInput = document.getElementById("f-alias-input");
  var canonicalInput = document.getElementById("f-alias-canonical");
  var alias = (aliasInput.value || "").trim();
  var canonical = (canonicalInput.value || "").trim();
  if (!alias || !canonical) {
    showToast("Both alias and canonical are required", "error");
    return;
  }
  try {
    await api.serverSettings.createManufacturerAlias({ alias: alias, canonical: canonical });
    aliasInput.value = "";
    canonicalInput.value = "";
    showToast('Alias "' + alias + '" → "' + canonical + '" added', "success");
    await loadIdentificationTab();
  } catch (err) {
    showToast(err.message || "Failed to add alias", "error");
  }
}

async function deleteManufacturerAliasUI(id) {
  var existing = _manufacturerAliases.find(function (a) { return a.id === id; });
  var label = existing ? '"' + existing.alias + '" → "' + existing.canonical + '"' : "this alias";
  var ok = await showConfirm("Delete alias " + label + "?");
  if (!ok) return;
  try {
    await api.serverSettings.deleteManufacturerAlias(id);
    showToast("Alias deleted", "success");
    await loadIdentificationTab();
  } catch (err) {
    showToast(err.message || "Failed to delete alias", "error");
  }
}

function editManufacturerAliasUI(id) {
  var existing = _manufacturerAliases.find(function (a) { return a.id === id; });
  if (!existing) return;

  var body =
    '<div class="form-group"><label>Alias *</label>' +
      '<input type="text" id="f-edit-alias" value="' + escapeHtml(existing.alias) + '">' +
      '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:4px">Stored lowercased; matched case-insensitively against incoming manufacturer strings.</div>' +
    '</div>' +
    '<div class="form-group"><label>Canonical *</label>' +
      '<input type="text" id="f-edit-canonical" value="' + escapeHtml(existing.canonical) + '">' +
      '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:4px">Saving will rewrite existing assets and MIBs already stored under the previous canonical value.</div>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-alias">Save Changes</button>';
  openModal("Edit Manufacturer Alias", body, footer);

  document.getElementById("btn-save-alias").addEventListener("click", async function () {
    var btn = this;
    var alias = document.getElementById("f-edit-alias").value.trim();
    var canonical = document.getElementById("f-edit-canonical").value.trim();
    if (!alias || !canonical) {
      showToast("Both alias and canonical are required", "error");
      return;
    }
    btn.disabled = true;
    try {
      await api.serverSettings.updateManufacturerAlias(id, { alias: alias, canonical: canonical });
      closeModal();
      showToast("Alias updated", "success");
      await loadIdentificationTab();
    } catch (err) {
      showToast(err.message || "Failed to update alias", "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function mibCardHTML() {
  var rows = _mibFilteredRows();
  var html = '<div class="settings-card">' +
    '<h4>MIB Database</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'SNMP MIB modules used to resolve vendor-specific OIDs during monitoring. ' +
      'Vendor profiles (Cisco, Juniper, Fortinet, …) are <b>universal</b> per-manufacturer, but you can also upload a <b>device-specific</b> MIB that overrides the vendor MIB for one model only. Resolution priority at probe time is <i>device → vendor → generic → built-in seed</i>. ' +
      'Files are validated as ASN.1/SMI on upload — anything else is rejected.' +
    '</p>';

  // (Vendor Profile Status pill removed — the editable Manufacturer
  // Profiles card is the canonical surface for per-manufacturer telemetry
  // resolution status.)

  // Filter row
  html +=
    '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-bottom:1rem">' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Manufacturer</label>' +
        '<select id="f-mib-filter-mfr">' + _mibManufacturerOptions(_mibFilter.manufacturer) + '</select>' +
      '</div>' +
      '<div style="flex:1;min-width:160px">' +
        '<label style="font-size:0.78rem;font-weight:500">Model</label>' +
        '<select id="f-mib-filter-model"' + (_mibFilter.manufacturer ? '' : ' disabled') + '>' +
          _mibModelOptions(_mibFilter.manufacturer, _mibFilter.model) +
        '</select>' +
      '</div>' +
      '<div style="flex:0 0 auto">' +
        '<label style="font-size:0.78rem;font-weight:500">Scope</label>' +
        '<select id="f-mib-filter-scope">' +
          '<option value="all"' + (_mibFilter.scope === "all" ? " selected" : "") + '>All</option>' +
          '<option value="device"' + (_mibFilter.scope === "device" ? " selected" : "") + '>Device-specific</option>' +
          '<option value="generic"' + (_mibFilter.scope === "generic" ? " selected" : "") + '>Generic only</option>' +
        '</select>' +
      '</div>' +
    '</div>';

  // List
  if (rows.length > 0) {
    html += '<table class="ip-table" style="margin-bottom:1rem"><thead><tr>' +
      '<th>Module</th><th>Manufacturer</th><th>Model</th><th>Imports</th><th style="width:90px;text-align:right">Size</th><th style="width:130px">Uploaded</th><th style="width:120px"></th>' +
    '</tr></thead><tbody>';
    rows.forEach(function (m) {
      var sizeKb = (m.size / 1024).toFixed(1) + " KB";
      var importsText = (m.imports && m.imports.length > 0) ? m.imports.length + " ref" + (m.imports.length === 1 ? "" : "s") : "—";
      var importsTitle = (m.imports && m.imports.length > 0) ? m.imports.join(", ") : "";
      html += '<tr>' +
        '<td class="mono" style="font-size:0.85rem">' + escapeHtml(m.moduleName) + '</td>' +
        '<td>' + (m.manufacturer ? escapeHtml(m.manufacturer) : '<span style="color:var(--color-text-tertiary);font-style:italic">generic</span>') + '</td>' +
        '<td>' + (m.model ? escapeHtml(m.model) : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>' +
        '<td' + (importsTitle ? ' title="' + escapeHtml(importsTitle) + '"' : '') + ' style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(importsText) + '</td>' +
        '<td style="text-align:right;font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(sizeKb) + '</td>' +
        '<td style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(formatDate(m.uploadedAt)) + '</td>' +
        '<td class="actions" style="white-space:nowrap;flex-wrap:nowrap">' +
          '<button class="btn btn-sm btn-primary mib-browse" data-id="' + escapeHtml(m.id) + '" data-name="' + escapeHtml(m.moduleName) + '">Browse</button> ' +
          '<a class="btn btn-sm btn-secondary" href="' + api.serverSettings.downloadMibUrl(m.id) + '" download="' + escapeHtml(m.filename) + '">Download</a> ' +
          (isAdmin()
            ? '<button class="btn btn-sm btn-danger mib-del" data-id="' + escapeHtml(m.id) + '" data-name="' + escapeHtml(m.moduleName) + '">Del</button>'
            : '') +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table>';
  } else if (_mibsData.length === 0) {
    html += '<p class="empty-state" style="margin-bottom:1rem">No MIBs uploaded yet. Add one below to start.</p>';
  } else {
    html += '<p class="empty-state" style="margin-bottom:1rem">No MIBs match the current filter.</p>';
  }

  // Upload form (admin only — assets-admin can browse + walk but not edit)
  if (!isAdmin()) {
    html += '</div>';
    return html;
  }

  var mfrListId = "mib-mfr-datalist";
  var modelListId = "mib-model-datalist";
  var mfrOpts = (_mibFacets.manufacturers || []).map(function (m) { return '<option value="' + escapeHtml(m) + '"></option>'; }).join("");
  var modelOpts = "";
  Object.keys(_mibFacets.modelsByManufacturer || {}).forEach(function (mfr) {
    (_mibFacets.modelsByManufacturer[mfr] || []).forEach(function (md) {
      modelOpts += '<option value="' + escapeHtml(md) + '"></option>';
    });
  });

  html +=
    '<div style="border-top:1px solid var(--color-border);padding-top:1rem">' +
      '<h5 style="margin:0 0 0.75rem;font-size:0.9rem">Upload MIB</h5>' +
      '<datalist id="' + mfrListId + '">' + mfrOpts + '</datalist>' +
      '<datalist id="' + modelListId + '">' + modelOpts + '</datalist>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500;display:block;margin-bottom:0.25rem">Scope</label>' +
        '<label style="display:block;margin-bottom:0.25rem;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="vendor" checked> ' +
          '<b>Manufacturer-wide</b> &mdash; covers every model from this vendor (most common)' +
        '</label>' +
        '<label style="display:block;margin-bottom:0.25rem;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="device"> ' +
          '<b>Device-specific</b> &mdash; overrides the manufacturer-wide MIB for one model only' +
        '</label>' +
        '<label style="display:block;cursor:pointer">' +
          '<input type="radio" name="mib-scope-up" value="generic"> ' +
          '<b>Generic</b> &mdash; shared across all vendors (e.g. SNMPv2-SMI, IF-MIB)' +
        '</label>' +
      '</div>' +
      '<div id="mib-upload-vendor-fields" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:0.75rem">' +
        '<div style="flex:1;min-width:160px">' +
          '<label style="font-size:0.78rem;font-weight:500">Manufacturer *</label>' +
          '<input type="text" id="f-mib-up-mfr" list="' + mfrListId + '" placeholder="e.g. Cisco">' +
        '</div>' +
        '<div id="mib-upload-model-field" style="flex:1;min-width:160px;display:none">' +
          '<label style="font-size:0.78rem;font-weight:500">Model *</label>' +
          '<input type="text" id="f-mib-up-model" list="' + modelListId + '" placeholder="e.g. Catalyst 9300">' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500">MIB file *</label>' +
        '<input type="file" id="f-mib-up-file" accept=".mib,.txt,.my,.smi,text/plain">' +
      '</div>' +
      '<div class="form-group" style="margin-bottom:0.75rem">' +
        '<label style="font-size:0.78rem;font-weight:500">Notes <span style="color:var(--color-text-tertiary);font-weight:400">(optional)</span></label>' +
        '<input type="text" id="f-mib-up-notes" placeholder="Source URL, version, anything you want to remember">' +
      '</div>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<button class="btn btn-primary" id="btn-mib-upload">Upload MIB</button>' +
        '<span id="mib-upload-status" style="font-size:0.82rem"></span>' +
      '</div>' +
    '</div>';

  html += '</div>';
  return html;
}

function wireMibControls() {
  var mfr = document.getElementById("f-mib-filter-mfr");
  var model = document.getElementById("f-mib-filter-model");
  var scope = document.getElementById("f-mib-filter-scope");
  if (mfr) {
    mfr.addEventListener("change", function () {
      _mibFilter.manufacturer = mfr.value || "";
      _mibFilter.model = ""; // reset model when manufacturer changes
      renderIdentificationTab();
    });
  }
  if (model) {
    model.addEventListener("change", function () {
      _mibFilter.model = model.value || "";
      renderIdentificationTab();
    });
  }
  if (scope) {
    scope.addEventListener("change", function () {
      _mibFilter.scope = scope.value || "all";
      renderIdentificationTab();
    });
  }

  document.querySelectorAll("input[name='mib-scope-up']").forEach(function (r) {
    r.addEventListener("change", function () {
      var fields = document.getElementById("mib-upload-vendor-fields");
      var modelField = document.getElementById("mib-upload-model-field");
      if (!fields || !modelField) return;
      if (!r.checked) return;
      if (r.value === "generic") {
        fields.style.display = "none";
      } else {
        fields.style.display = "flex";
        modelField.style.display = r.value === "device" ? "block" : "none";
      }
    });
  });

  var btn = document.getElementById("btn-mib-upload");
  if (btn) btn.addEventListener("click", uploadMibUI);

  document.querySelectorAll(".mib-del").forEach(function (b) {
    b.addEventListener("click", function () {
      deleteMibUI(b.getAttribute("data-id"), b.getAttribute("data-name"));
    });
  });

  document.querySelectorAll(".mib-browse").forEach(function (b) {
    b.addEventListener("click", function () {
      openMibBrowseModal(b.getAttribute("data-id"), b.getAttribute("data-name"));
    });
  });
}

async function uploadMibUI() {
  var fileInput = document.getElementById("f-mib-up-file");
  var statusEl = document.getElementById("mib-upload-status");
  var btn = document.getElementById("btn-mib-upload");
  if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
    showToast("Choose a MIB file first", "error");
    return;
  }
  var scopeRadio = document.querySelector("input[name='mib-scope-up']:checked");
  var scope = scopeRadio ? scopeRadio.value : "vendor";
  var fields = {};
  if (scope === "vendor" || scope === "device") {
    var mfr = (document.getElementById("f-mib-up-mfr").value || "").trim();
    if (!mfr) { showToast("Manufacturer is required for manufacturer-wide and device-specific MIBs", "error"); return; }
    fields.manufacturer = mfr;
  }
  if (scope === "device") {
    var model = (document.getElementById("f-mib-up-model").value || "").trim();
    if (!model) { showToast("Model is required for device-specific MIBs", "error"); return; }
    fields.model = model;
  }
  var notes = (document.getElementById("f-mib-up-notes").value || "").trim();
  if (notes) fields.notes = notes;

  btn.disabled = true;
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-text-tertiary)">Uploading…</span>';
  try {
    var created = await api.serverSettings.uploadMib(fileInput.files[0], fields);
    showToast("MIB uploaded: " + created.moduleName, "success");
    if (statusEl) statusEl.innerHTML = "";
    // Refresh list + facets + profile status
    var [list, facets] = await Promise.all([
      api.serverSettings.listMibs(),
      api.serverSettings.getMibFacets(),
    ]);
    _mibsData = list || [];
    _mibFacets = facets || { manufacturers: [], modelsByManufacturer: {} };
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--color-danger)">' + escapeHtml(err.message) + '</span>';
  } finally {
    btn.disabled = false;
  }
}

async function deleteMibUI(id, name) {
  var ok = await showConfirm('Delete MIB module "' + name + '"?');
  if (!ok) return;
  try {
    await api.serverSettings.deleteMib(id);
    _mibsData = _mibsData.filter(function (m) { return m.id !== id; });
    showToast("MIB deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── MIB Browse modal ─────────────────────────────────────────────────────
//
// Two-pane modal: left = collapsible sections (Tables, Scalars / Other);
// right = selected object detail + "Walk on asset…" pivot. Walk results
// render scalars as a flat list and tables as a 2D table with column
// headers from the MIB and rows keyed by the SMI INDEX. Symbolic + decoded
// values (INTEGER enums → up(1), TimeTicks → human duration) come from
// the server — the client just renders.

var _mibBrowseState = null; // { mibId, structure, selectedSymbol, walkOpen, asset, credentialId }

async function openMibBrowseModal(mibId, moduleName) {
  // Open shell with a loading state so the modal feels responsive even
  // while the structured parse + OID resolution roll back.
  var title = "Browse MIB" + (moduleName ? " — " + moduleName : "");
  openModal(title, '<p class="empty-state">Loading MIB structure…</p>', '<button class="btn btn-secondary" onclick="closeModal()">Close</button>', { xl: true });

  var structure;
  try {
    structure = await api.serverSettings.getMibStructure(mibId);
  } catch (err) {
    var msg = '<p style="color:var(--color-danger)">' + escapeHtml(err.message || "Failed to load MIB structure") + '</p>';
    document.querySelector(".modal-body").innerHTML = msg;
    return;
  }

  _mibBrowseState = {
    mibId: mibId,
    moduleName: structure.moduleName || moduleName,
    structure: structure,
    selectedSymbol: null,
    asset: null,
    credentialId: null,
  };

  renderMibBrowseModal();
}

function renderMibBrowseModal() {
  var s = _mibBrowseState;
  if (!s) return;
  var st = s.structure;

  var unresolvedNote = "";
  if (st.unresolvedCount > 0) {
    // Name the missing anchor when the server could identify it. A MIB whose
    // root is an IMPORTed symbol fails wholesale rather than partially, so the
    // bare count reads as "this MIB is broken" when the actual fix is usually
    // "upload the one module that defines <symbol>".
    var roots = Array.isArray(st.unresolvedRoots) ? st.unresolvedRoots : [];
    var cause = roots.length > 0
      ? ' Undefined here: <b>' + roots.map(escapeHtml).join("</b>, <b>") + '</b>' +
        ' — upload the MIB that defines ' + (roots.length === 1 ? 'it' : 'them') + '.'
      : (Array.isArray(st.imports) && st.imports.length > 0
          ? ' This MIB imports from: ' + st.imports.map(escapeHtml).join(", ")
          : '');
    unresolvedNote =
      '<div style="margin:0 0 0.5rem;padding:0.5rem 0.75rem;border:1px solid var(--color-warning,#d97706);border-radius:4px;background:rgba(217,119,6,0.06);font-size:0.82rem">' +
        '<b>' + st.unresolvedCount + '</b> symbol' + (st.unresolvedCount === 1 ? '' : 's') + ' could not be resolved to a numeric OID — likely a missing IMPORTS dependency.' +
        cause +
      '</div>';
  }

  var leftPane =
    unresolvedNote +
    _mibBrowseTablesSection(st) +
    _mibBrowseScalarsSection(st);

  var rightPane = _mibBrowseDetailPane();

  var body =
    '<div style="display:grid;grid-template-columns:minmax(280px,38%) 1fr;gap:1rem;height:70vh;overflow:hidden;padding:1rem">' +
      '<div id="mib-browse-left" style="overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;min-height:0;height:100%;border-right:1px solid var(--color-border);padding-right:0.75rem">' + leftPane + '</div>' +
      '<div id="mib-browse-right" style="overflow-y:auto;overflow-x:hidden;overscroll-behavior:contain;min-height:0;height:100%">' + rightPane + '</div>' +
    '</div>';

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';
  openModal("Browse MIB — " + (s.moduleName || ""), body, footer, { xl: true });

  // Wire object selection
  document.querySelectorAll(".mib-browse-symbol").forEach(function (el) {
    el.addEventListener("click", function () {
      var name = el.getAttribute("data-name");
      _mibBrowseState.selectedSymbol = name;
      renderMibBrowseModal();
    });
  });

  // Wire collapsibles
  document.querySelectorAll(".mib-browse-section-toggle").forEach(function (h) {
    h.addEventListener("click", function () {
      var sec = h.parentElement;
      sec.classList.toggle("collapsed");
      var caret = h.querySelector(".caret");
      if (caret) caret.textContent = sec.classList.contains("collapsed") ? "▸" : "▾";
    });
  });

  // Wire "Walk on asset…" if visible
  var walkBtn = document.getElementById("btn-mib-walk-open");
  if (walkBtn) walkBtn.addEventListener("click", _mibBrowseOpenWalk);
}

function _mibBrowseTablesSection(st) {
  if (!st.tables || st.tables.length === 0) return "";
  var rows = st.tables.map(function (t) {
    var colCount = t.columns ? t.columns.length : 0;
    return '<div class="mib-browse-symbol" data-name="' + escapeHtml(t.name) + '" style="padding:0.4rem 0.5rem;cursor:pointer;border-radius:4px;font-family:var(--font-mono)">' +
      escapeHtml(t.name) +
      ' <span style="color:var(--color-text-tertiary);font-size:0.78rem;font-family:inherit;margin-left:0.25rem">(' + colCount + ' col' + (colCount === 1 ? '' : 's') + ')</span>' +
    '</div>';
  }).join("");
  return _mibBrowseSection("Tables", rows, false);
}

function _mibBrowseScalarsSection(st) {
  // Anything not a known table column or table-row entry goes here.
  var tableColumns = new Set();
  var tableRows = new Set();
  (st.tables || []).forEach(function (t) {
    tableRows.add(t.rowSymbol);
    (t.columns || []).forEach(function (c) { tableColumns.add(c); });
  });
  // Surface every other symbol — scalars + group nodes (OBJECT IDENTIFIER
  // shorthand) all belong here. Filter out the table objects themselves
  // (they appear in the Tables section already).
  var tableNames = new Set((st.tables || []).map(function (t) { return t.name; }));
  var rows = (st.symbols || [])
    .filter(function (s) {
      return !tableColumns.has(s.name) && !tableRows.has(s.name) && !tableNames.has(s.name);
    })
    .map(function (s) {
      var typeBadge = s.baseType && s.baseType !== "OTHER" && s.baseType !== "OBJECT IDENTIFIER"
        ? ' <span style="color:var(--color-text-tertiary);font-size:0.78rem;font-family:inherit;margin-left:0.25rem">' + escapeHtml(s.baseType) + '</span>'
        : '';
      var unresolved = s.fullOid === null
        ? ' <span style="color:var(--color-warning,#d97706);font-size:0.78rem;font-family:inherit;margin-left:0.25rem">(unresolved)</span>'
        : '';
      return '<div class="mib-browse-symbol" data-name="' + escapeHtml(s.name) + '" style="padding:0.4rem 0.5rem;cursor:pointer;border-radius:4px;font-family:var(--font-mono)">' +
        escapeHtml(s.name) + typeBadge + unresolved +
      '</div>';
    }).join("");
  if (!rows) return "";
  return _mibBrowseSection("Scalars / Other", rows, false);
}

function _mibBrowseSection(title, innerHTML, startCollapsed) {
  return '<div class="mib-browse-section' + (startCollapsed ? ' collapsed' : '') + '" style="margin-bottom:0.75rem">' +
    '<h5 class="mib-browse-section-toggle" style="margin:0 0 0.25rem;font-size:0.85rem;font-weight:600;cursor:pointer;user-select:none;padding:0.35rem 0.5rem;background:var(--color-surface-alt,rgba(127,127,127,0.05));border-radius:4px">' +
      '<span class="caret" style="display:inline-block;width:1em">' + (startCollapsed ? '▸' : '▾') + '</span>' +
      escapeHtml(title) +
    '</h5>' +
    '<div class="mib-browse-section-body">' + innerHTML + '</div>' +
  '</div>';
}

function _mibBrowseDetailPane() {
  var s = _mibBrowseState;
  if (!s) return "";
  var st = s.structure;
  if (!s.selectedSymbol) {
    return '<p class="empty-state" style="margin-top:1rem">Pick an object on the left to see its details and run a walk.</p>';
  }

  // The selected entry is either a top-level symbol OR a MibTable. Tables
  // live in their own array; everything else lives in symbols. Detail
  // rendering differs slightly between them.
  var table = (st.tables || []).find(function (t) { return t.name === s.selectedSymbol; });
  if (table) return _mibBrowseTableDetail(table, st);
  var sym = (st.symbols || []).find(function (x) { return x.name === s.selectedSymbol; });
  if (!sym) return '<p class="empty-state">Symbol not found.</p>';
  return _mibBrowseScalarDetail(sym);
}

function _mibBrowseScalarDetail(sym) {
  var rows = [
    ["OID", sym.fullOid ? sym.fullOid : '<span style="color:var(--color-warning,#d97706)">unresolved</span>'],
    ["Kind", sym.kind || ""],
    ["Syntax", sym.syntax ? escapeHtml(sym.syntax) : "—"],
    ["Base type", sym.baseType || ""],
    ["Access", sym.access || "—"],
    ["Status", sym.status || "—"],
  ];
  var rowsHtml = rows.map(function (r) {
    return '<tr><th style="text-align:left;padding:0.25rem 0.75rem 0.25rem 0;font-weight:500;color:var(--color-text-secondary);width:8rem">' + escapeHtml(r[0]) + '</th>' +
      '<td class="mono" style="padding:0.25rem 0;font-size:0.85rem">' + r[1] + '</td></tr>';
  }).join("");

  var enumHtml = "";
  if (sym.enumValues && sym.enumValues.length > 0) {
    enumHtml = '<div style="margin-top:0.75rem"><b style="font-size:0.85rem">Enum values</b>' +
      '<table class="ip-table" style="margin-top:0.25rem;font-size:0.85rem">' +
        '<thead><tr><th>Label</th><th style="width:80px;text-align:right">Value</th></tr></thead>' +
        '<tbody>' +
          sym.enumValues.map(function (e) {
            return '<tr><td class="mono">' + escapeHtml(e.label) + '</td><td style="text-align:right">' + e.value + '</td></tr>';
          }).join("") +
        '</tbody>' +
      '</table></div>';
  }

  var descHtml = sym.description
    ? '<div style="margin-top:0.75rem"><b style="font-size:0.85rem">Description</b><p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0.25rem 0 0;white-space:pre-wrap">' + escapeHtml(sym.description) + '</p></div>'
    : "";

  var canWalk = sym.fullOid && (sym.access === "read-only" || sym.access === "read-write" || sym.access === "read-create");
  var walkBtn = canWalk
    ? '<button class="btn btn-primary" id="btn-mib-walk-open" style="margin-top:1rem">Walk on asset…</button>'
    : '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:1rem">' +
        (sym.fullOid ? 'Not a readable object — only read-only / read-write / read-create symbols can be walked.' : 'Cannot walk — OID is unresolved.') +
      '</p>';

  return '<h4 style="margin:0 0 0.5rem;font-family:var(--font-mono)">' + escapeHtml(sym.name) + '</h4>' +
    '<table style="font-size:0.82rem;width:100%"><tbody>' + rowsHtml + '</tbody></table>' +
    enumHtml + descHtml +
    walkBtn +
    _mibBrowseWalkPanel();
}

function _mibBrowseTableDetail(table, st) {
  // Pick the first column with read access as the default walk target,
  // since the table object itself is `not-accessible` (it can't be GET'd).
  var firstReadable = (table.columns || [])
    .map(function (col) { return (st.symbols || []).find(function (s) { return s.name === col; }); })
    .find(function (s) {
      return s && s.fullOid && (s.access === "read-only" || s.access === "read-write" || s.access === "read-create");
    });

  var colsHtml = (table.columns || []).map(function (col) {
    var sym = (st.symbols || []).find(function (x) { return x.name === col; });
    var typeBadge = sym && sym.baseType && sym.baseType !== "OTHER" ? sym.baseType : "—";
    var enumBadge = sym && sym.enumValues && sym.enumValues.length > 0 ? ' enum(' + sym.enumValues.length + ')' : '';
    return '<tr><td class="mono mib-browse-symbol" data-name="' + escapeHtml(col) + '" style="padding:0.25rem 0.5rem;cursor:pointer">' + escapeHtml(col) + '</td>' +
      '<td style="padding:0.25rem 0.5rem;color:var(--color-text-secondary);font-size:0.82rem">' + escapeHtml(typeBadge) + escapeHtml(enumBadge) + '</td></tr>';
  }).join("");

  // For a table, the operator typically wants to walk the WHOLE table, so
  // we make the Walk button target the first readable column. The walk
  // endpoint then groups the multi-column results back into a 2D table.
  // (Walking the table object itself works too — the response gets matched
  // against every column. But not-accessible parents sometimes confuse
  // certain SNMP agents, so we lean on the first column.)
  var walkBtn = "";
  if (firstReadable) {
    walkBtn =
      '<button class="btn btn-primary" id="btn-mib-walk-open" data-target="' + escapeHtml(firstReadable.name) + '" style="margin-top:1rem">Walk this table on asset…</button>' +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.5rem 0 0">Walks <b>' + escapeHtml(firstReadable.name) + '</b> as the table entry — results are grouped into a 2D table by the SMI <code>INDEX</code>.</p>';
  } else {
    walkBtn = '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:1rem">No readable columns — table cannot be walked.</p>';
  }

  var indexHtml = (table.indexNames && table.indexNames.length > 0)
    ? '<div style="margin-top:0.5rem;font-size:0.85rem"><b>INDEX:</b> <span class="mono">' + table.indexNames.map(escapeHtml).join(", ") + '</span></div>'
    : "";

  var descHtml = table.description
    ? '<div style="margin-top:0.5rem"><b style="font-size:0.85rem">Description</b><p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0.25rem 0 0;white-space:pre-wrap">' + escapeHtml(table.description) + '</p></div>'
    : "";

  return '<h4 style="margin:0 0 0.5rem;font-family:var(--font-mono)">' + escapeHtml(table.name) +
    ' <span style="font-family:inherit;font-size:0.85rem;color:var(--color-text-tertiary);font-weight:400">(SMI table)</span></h4>' +
    indexHtml + descHtml +
    '<div style="margin-top:0.75rem"><b style="font-size:0.85rem">Columns (click to view)</b>' +
      '<table class="ip-table" style="margin-top:0.25rem;font-size:0.85rem"><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody>' + colsHtml + '</tbody></table>' +
    '</div>' +
    walkBtn +
    _mibBrowseWalkPanel();
}

function _mibBrowseWalkPanel() {
  // A persistent slot at the bottom of the right pane that the walk pivot
  // populates inline. Keeps the asset picker + results visible alongside
  // the symbol detail without opening a second modal.
  return '<div id="mib-walk-panel" style="margin-top:1.25rem;display:none;border-top:1px solid var(--color-border);padding-top:0.75rem"></div>';
}

function _mibBrowseOpenWalk(ev) {
  // The button on a table-detail view stamps `data-target` with a column
  // symbol name. Scalar-detail views walk the selected symbol directly.
  var btn = ev && ev.currentTarget ? ev.currentTarget : null;
  var targetName = btn && btn.getAttribute("data-target");
  var symbolName = targetName || _mibBrowseState.selectedSymbol;

  var panel = document.getElementById("mib-walk-panel");
  if (!panel) return;
  panel.style.display = "block";
  panel.innerHTML =
    '<h5 style="margin:0 0 0.5rem">Walk <span class="mono">' + escapeHtml(symbolName) + '</span></h5>' +
    '<div class="form-group" style="margin-bottom:0.5rem">' +
      '<label style="font-size:0.78rem;font-weight:500">Search asset</label>' +
      '<input type="search" id="f-mib-walk-search" autocomplete="off" spellcheck="false" placeholder="hostname, IP, or MAC (min 2 chars)">' +
      '<div id="f-mib-walk-results" style="margin-top:0.25rem;max-height:200px;overflow:auto;border:1px solid var(--color-border);border-radius:4px;display:none"></div>' +
    '</div>' +
    '<div id="f-mib-walk-selected" style="display:none;padding:0.5rem 0.6rem;border:1px solid var(--color-border);border-radius:4px;margin-bottom:0.5rem;background:var(--color-surface-alt,rgba(127,127,127,0.05))"></div>' +
    '<div class="form-group" style="margin-bottom:0.5rem">' +
      '<label style="font-size:0.78rem;font-weight:500">SNMP credential</label>' +
      '<select id="f-mib-walk-cred" disabled><option value="">Loading credentials…</option></select>' +
    '</div>' +
    '<div style="display:flex;gap:0.5rem;align-items:center">' +
      '<button class="btn btn-primary" id="btn-mib-walk-run" disabled>Run Walk</button>' +
      '<span id="mib-walk-status" style="font-size:0.82rem;color:var(--color-text-secondary)"></span>' +
    '</div>' +
    '<div id="mib-walk-result" style="margin-top:0.75rem"></div>';

  _wireMibWalkPanel(symbolName);

  // Auto-scroll the panel into view
  panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function _wireMibWalkPanel(symbolName) {
  var selectedAsset = null;
  var searchTimer = null;
  var lastQuery = "";

  var searchInput = document.getElementById("f-mib-walk-search");
  var resultsBox  = document.getElementById("f-mib-walk-results");
  var selectedBox = document.getElementById("f-mib-walk-selected");
  var credSelect  = document.getElementById("f-mib-walk-cred");
  var runBtn      = document.getElementById("btn-mib-walk-run");
  var statusEl    = document.getElementById("mib-walk-status");
  var resultBox   = document.getElementById("mib-walk-result");

  // Load SNMP credentials from the shared list
  api.credentials.list().then(function (creds) {
    var snmp = (creds || []).filter(function (c) { return c.type === "snmp"; });
    if (snmp.length === 0) {
      credSelect.innerHTML = '<option value="">No SNMP credentials configured</option>';
      credSelect.disabled = true;
      return;
    }
    credSelect.innerHTML =
      '<option value="">Select a credential…</option>' +
      snmp.map(function (c) {
        return '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.name) + '</option>';
      }).join("");
    credSelect.disabled = false;
  }).catch(function () {
    credSelect.innerHTML = '<option value="">Failed to load credentials</option>';
  });

  function refreshRunState() {
    runBtn.disabled = !(selectedAsset && credSelect.value);
  }
  credSelect.addEventListener("change", refreshRunState);

  function setSelected(hit) {
    selectedAsset = hit;
    if (!hit) {
      selectedBox.style.display = "none";
      runBtn.disabled = true;
      return;
    }
    selectedBox.innerHTML =
      '<div style="font-weight:600">' + escapeHtml(hit.title || "asset") + '</div>' +
      (hit.subtitle ? '<div style="font-size:0.8rem;color:var(--color-text-secondary)">' + escapeHtml(hit.subtitle) + '</div>' : '');
    selectedBox.style.display = "block";
    resultsBox.style.display = "none";
    resultsBox.innerHTML = "";
    searchInput.value = hit.title || "";
    refreshRunState();
  }

  function renderHits(hits) {
    if (!hits.length) {
      resultsBox.innerHTML = '<div style="padding:0.5rem;color:var(--color-text-secondary);font-size:0.85rem">No asset matches.</div>';
      resultsBox.style.display = "block";
      return;
    }
    resultsBox.innerHTML = hits.map(function (h, idx) {
      return '<div class="mib-walk-hit" data-idx="' + idx + '" style="padding:0.4rem 0.6rem;cursor:pointer;border-bottom:1px solid var(--color-border)">' +
        '<div style="font-weight:600">' + escapeHtml(h.title || "asset") + '</div>' +
        (h.subtitle ? '<div style="font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(h.subtitle) + '</div>' : '') +
      '</div>';
    }).join("");
    resultsBox.style.display = "block";
    resultsBox.querySelectorAll(".mib-walk-hit").forEach(function (el) {
      el.addEventListener("click", function () {
        var idx = Number(el.getAttribute("data-idx"));
        setSelected(hits[idx]);
      });
    });
  }

  searchInput.addEventListener("input", function () {
    var q = searchInput.value.trim();
    if (selectedAsset && q !== (selectedAsset.title || "")) {
      selectedAsset = null;
      selectedBox.style.display = "none";
      refreshRunState();
    }
    clearTimeout(searchTimer);
    if (q.length < 2) {
      resultsBox.style.display = "none";
      resultsBox.innerHTML = "";
      lastQuery = "";
      return;
    }
    searchTimer = setTimeout(async function () {
      lastQuery = q;
      try {
        var results = await api.assets.list({ search: q, limit: 25 });
        if (q !== lastQuery) return;
        var hits = (results.assets || []).map(function (a) {
          var vendorModel = [a.manufacturer, a.model].filter(Boolean).join(" ");
          var bits = [a.ipAddress, a.macAddress, vendorModel].filter(Boolean);
          return { id: a.id, title: a.hostname || a.assetTag || "asset", subtitle: bits.join(" — ") || a.assetType };
        });
        renderHits(hits);
      } catch (err) {
        resultsBox.innerHTML = '<div style="padding:0.5rem;color:var(--color-danger);font-size:0.85rem">Search failed: ' + escapeHtml(err.message || "") + '</div>';
        resultsBox.style.display = "block";
      }
    }, 180);
  });

  runBtn.addEventListener("click", async function () {
    if (!selectedAsset || !credSelect.value) return;
    runBtn.disabled = true;
    statusEl.textContent = "Walking…";
    resultBox.innerHTML = "";
    try {
      var result = await api.serverSettings.walkMib(_mibBrowseState.mibId, {
        assetId: selectedAsset.id,
        credentialId: credSelect.value,
        objectName: symbolName,
      });
      statusEl.textContent =
        result.rowCount + " row" + (result.rowCount === 1 ? '' : 's') +
        ' in ' + result.durationMs + ' ms' +
        (result.truncated ? ' (truncated)' : '');
      resultBox.innerHTML = _renderMibWalkResult(result);
      _wireMibWalkCopy(result);
    } catch (err) {
      statusEl.textContent = "";
      resultBox.innerHTML = '<div style="padding:0.5rem 0.75rem;border:1px solid var(--color-danger);border-radius:4px;color:var(--color-danger);font-size:0.85rem">' + escapeHtml(err.message || "Walk failed") + '</div>';
    } finally {
      refreshRunState();
    }
  });

  setTimeout(function () { searchInput.focus(); }, 50);
}

function _renderMibWalkResult(result) {
  if (!result || !result.kind) return "";
  var mismatchBanner = "";
  if (result.rowCount > 0 && result.decodedCount * 2 < result.rowCount) {
    var pct = Math.round((result.decodedCount / result.rowCount) * 100);
    mismatchBanner =
      '<div style="margin-bottom:0.5rem;padding:0.5rem 0.75rem;border:1px solid var(--color-warning,#d97706);border-radius:4px;background:rgba(217,119,6,0.06);font-size:0.82rem">' +
        'Decoded ' + result.decodedCount + ' / ' + result.rowCount + ' rows (' + pct + '%). This MIB may not match the asset\'s manufacturer.' +
      '</div>';
  }

  if (result.kind === "table" && result.table) {
    var t = result.table;
    var thead =
      '<thead><tr>' +
        (t.indexNames && t.indexNames.length > 0
          ? '<th style="font-family:var(--font-mono)">' + t.indexNames.map(escapeHtml).join(", ") + '</th>'
          : '<th style="font-family:var(--font-mono)">index</th>') +
        t.columns.map(function (c) { return '<th style="font-family:var(--font-mono)">' + escapeHtml(c) + '</th>'; }).join("") +
      '</tr></thead>';
    var tbody = '<tbody>' + t.rows.map(function (row) {
      var cells = t.columns.map(function (col) {
        var c = row.cells[col];
        if (!c) return '<td style="color:var(--color-text-tertiary)">—</td>';
        var title = c.decoded !== c.raw ? ' title="raw: ' + escapeHtml(c.raw) + '"' : '';
        return '<td' + title + '>' + escapeHtml(c.decoded) + '</td>';
      }).join("");
      return '<tr><td class="mono">' + escapeHtml(row.index) + '</td>' + cells + '</tr>';
    }).join("") + '</tbody>';
    return mismatchBanner +
      '<div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">' +
        '<button class="btn btn-sm btn-secondary" id="btn-mib-walk-copy">Copy results</button>' +
        '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">Hover any cell for the raw value.</span>' +
      '</div>' +
      '<div style="overflow-x:auto"><table class="ip-table" style="font-size:0.82rem">' + thead + tbody + '</table></div>';
  }

  // Scalars
  var entries = result.entries || [];
  if (entries.length === 0) {
    return '<p class="empty-state">No rows returned.</p>';
  }
  var rows = entries.map(function (e) {
    var label = e.symbol ? e.symbol + (e.suffix ? '.' + e.suffix : '') : e.oid;
    var decoded = e.decoded;
    var raw = e.raw;
    var rawNote = decoded !== raw ? ' <span style="color:var(--color-text-tertiary);font-size:0.78rem">(' + escapeHtml(raw) + ')</span>' : '';
    return '<tr>' +
      '<td class="mono" style="font-size:0.85rem">' + escapeHtml(label) + '</td>' +
      '<td>' + escapeHtml(decoded) + rawNote + '</td>' +
      '<td style="color:var(--color-text-tertiary);font-size:0.78rem">' + escapeHtml(e.baseType || "") + '</td>' +
    '</tr>';
  }).join("");

  return mismatchBanner +
    '<div style="display:flex;gap:0.5rem;align-items:center;margin-bottom:0.5rem">' +
      '<button class="btn btn-sm btn-secondary" id="btn-mib-walk-copy">Copy results</button>' +
    '</div>' +
    '<table class="ip-table" style="font-size:0.85rem">' +
      '<thead><tr><th>Object</th><th>Value</th><th>Type</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
    '</table>';
}

function _wireMibWalkCopy(result) {
  var btn = document.getElementById("btn-mib-walk-copy");
  if (!btn) return;
  btn.addEventListener("click", function () {
    var text;
    if (result.kind === "table" && result.table) {
      var t = result.table;
      var headers = ["index"].concat(t.columns).join("\t");
      var lines = t.rows.map(function (row) {
        return [row.index].concat(t.columns.map(function (col) {
          return row.cells[col] ? row.cells[col].decoded : "";
        })).join("\t");
      });
      text = headers + "\n" + lines.join("\n");
    } else {
      var entries = result.entries || [];
      text = entries.map(function (e) {
        var label = e.symbol ? e.symbol + (e.suffix ? '.' + e.suffix : '') : e.oid;
        return label + "\t" + e.decoded + "\t" + (e.baseType || "");
      }).join("\n");
    }
    copyTextToClipboard(text).then(function (ok) {
      showToast(ok ? "Walk results copied" : "Copy failed — select and copy by hand", ok ? "success" : "error");
    });
  });
}

// ─── Device Icons ──────────────────────────────────────────────────────────
//
// Operator-uploaded images that override generic node shapes on the Device
// Map's topology graph. Resolution at render time is most-specific-wins:
// model-with-manufacturer → model-alone → assetType. Storage is bytes-in-DB
// behind the /api/v1/device-icons endpoints; admin-only CRUD; image-serve
// is auth-only with HTTP cache headers so the topology modal doesn't refetch
// on every render.

var _deviceIconAssetTypes = [
  "firewall", "switch", "access_point", "router",
  "server", "workstation", "printer", "other",
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

function deviceIconsCardHTML() {
  var byScope = { "manufacturer-type": [], "manufacturer-model": [] };
  _deviceIcons.forEach(function (i) {
    if (byScope[i.scope]) byScope[i.scope].push(i);
  });

  // Manufacturer datalist — merged from every source the operator already
  // has on hand so the picker isn't empty on installs that haven't
  // configured many aliases. Sources, in order: alias canonicals, MIB
  // facets (which already includes the asset inventory), and the
  // manufacturer half of every existing device-icon key. Free text is
  // allowed for anything not in the list; the service alias-normalizes
  // the value at write time.
  var manufacturerOptions = "";
  var seen = {};
  function addManufacturerOption(name) {
    var c = (name || "").trim();
    if (c && !seen[c]) { seen[c] = 1; manufacturerOptions += '<option value="' + escapeHtml(c) + '">'; }
  }
  (_manufacturerAliases || []).forEach(function (a) { addManufacturerOption(a.canonical); });
  ((_mibFacets && _mibFacets.manufacturers) || []).forEach(addManufacturerOption);
  _deviceIcons.forEach(function (i) {
    var slash = (i.key || "").indexOf("/");
    if (slash > 0) addManufacturerOption(i.key.slice(0, slash));
  });

  var typeOptionsHtml = _deviceIconAssetTypes
    .map(function (t) { return '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>'; })
    .join("");

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
      '<label style="font-size:0.78rem">Manufacturer</label>' +
      '<input type="text" id="f-icon-mfr" list="f-icon-mfr-list" placeholder="Fortinet">' +
      '<datalist id="f-icon-mfr-list">' + manufacturerOptions + '</datalist>' +
    '</div>' +
    '<div class="form-group" style="margin:0">' +
      '<label style="font-size:0.78rem">Match by</label>' +
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
      '<th style="width:60px">Preview</th><th>Manufacturer</th><th>' + escapeHtml(tailHeader) + '</th><th>Filename</th><th style="width:100px">Size</th><th style="width:160px">Uploaded</th><th style="width:80px"></th>' +
    '</tr></thead><tbody>';
    list.forEach(function (i) {
      var slash = i.key.indexOf("/");
      var mfr = slash >= 0 ? i.key.slice(0, slash) : i.key;
      var tail = slash >= 0 ? i.key.slice(slash + 1) : "";
      s += '<tr>' +
        '<td><img src="' + escapeHtml(i.url) + '" alt="" style="width:40px;height:40px;object-fit:contain;background:#1c2029;border:1px solid var(--color-border);border-radius:4px"></td>' +
        '<td><code class="mono" style="font-size:0.78rem">' + escapeHtml(mfr) + '</code></td>' +
        '<td><code class="mono" style="font-size:0.78rem">' + escapeHtml(tail) + '</code></td>' +
        '<td>' + escapeHtml(i.filename) + '</td>' +
        '<td>' + escapeHtml(formatBytesShort(i.size)) + '</td>' +
        '<td style="font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(formatDate(i.uploadedAt)) + (i.uploadedBy ? ' by ' + escapeHtml(i.uploadedBy) : '') + '</td>' +
        '<td><button class="btn btn-sm btn-danger icon-del" data-id="' + escapeHtml(i.id) + '" data-key="' + escapeHtml(i.scope + ':' + i.key) + '">Delete</button></td>' +
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

function wireDeviceIconHandlers() {
  var btn = document.getElementById("btn-icon-upload");
  if (btn) btn.addEventListener("click", uploadIconUI);
  document.querySelectorAll(".icon-del").forEach(function (b) {
    b.addEventListener("click", function () {
      deleteIconUI(b.getAttribute("data-id"), b.getAttribute("data-key"));
    });
  });

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
      case "tags":           return plain(o.tags);
      case "subnets":
        return (o.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr }; });
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
      '<span>Auto-assign by device filter</span>' +
    '</label>' +
    '<p class="hint">When on, this tag is automatically applied to every device matching the filter below, and removed when a ' +
      'device no longer matches. Tags you add by hand are never removed. Decommissioned devices are skipped unless the filter ' +
      'mentions status.</p>' +
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
    return 'Add a condition, or switch "Auto-assign by device filter" off.';
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
          '<option value="__new__">+ New category...</option>' +
        '</select>' +
        '<input type="text" id="f-tag-category-new" placeholder="Category name" style="flex:1;display:none">' +
      '</div>' +
      '<p class="hint">Group related tags together. e.g. Environment, Function, Location</p>' +
    '</div>' +
    '<div class="form-group"><label>Color</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="color" id="f-tag-color" value="' + randomTagColor() + '" style="width:40px;height:32px;padding:2px;border:1px solid var(--color-border);border-radius:4px;background:transparent;cursor:pointer">' +
        '<button type="button" id="f-tag-color-random" title="Random color" aria-label="Random color" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--color-border);border-radius:4px;background:transparent;color:var(--color-text-secondary);cursor:pointer">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/><path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/></svg>' +
        '</button>' +
        '<span id="f-tag-color-hex" style="font-family:var(--font-mono);font-size:0.82rem;color:var(--color-text-secondary)"></span>' +
      '</div>' +
    '</div>' +
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

  // Update hex preview
  var colorInput = document.getElementById("f-tag-color");
  var hexLabel = document.getElementById("f-tag-color-hex");
  colorInput.addEventListener("input", function () {
    hexLabel.textContent = colorInput.value;
  });
  hexLabel.textContent = colorInput.value;

  var randomBtn = document.getElementById("f-tag-color-random");
  if (randomBtn) randomBtn.addEventListener("click", function () {
    colorInput.value = randomTagColor();
    hexLabel.textContent = colorInput.value;
  });

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
        color: colorInput.value,
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

  var body =
    '<div class="form-group"><label>Tag Name *</label>' +
      '<input type="text" id="f-tag-name" value="' + escapeHtml(tag.name) + '">' +
    '</div>' +
    '<div class="form-group"><label>Category</label>' +
      '<div style="display:flex;gap:8px">' +
        '<select id="f-tag-category-select" style="flex:1">' + catOptions +
          '<option value="__new__">+ New category...</option>' +
        '</select>' +
        '<input type="text" id="f-tag-category-new" placeholder="Category name" style="flex:1;display:none">' +
      '</div>' +
    '</div>' +
    '<div class="form-group"><label>Color</label>' +
      '<div style="display:flex;gap:8px;align-items:center">' +
        '<input type="color" id="f-tag-color" value="' + escapeHtml(tag.color || "#4fc3f7") + '" style="width:40px;height:32px;padding:2px;border:1px solid var(--color-border);border-radius:4px;background:transparent;cursor:pointer">' +
        '<button type="button" id="f-tag-color-random" title="Random color" aria-label="Random color" style="display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:1px solid var(--color-border);border-radius:4px;background:transparent;color:var(--color-text-secondary);cursor:pointer">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/><path d="M20.49 15a9 9 0 01-14.85 3.36L1 14"/></svg>' +
        '</button>' +
        '<span id="f-tag-color-hex" style="font-family:var(--font-mono);font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(tag.color || "#4fc3f7") + '</span>' +
      '</div>' +
    '</div>' +
    _tagFilterSectionHTML(tag, condBuilder, schema);

  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-tag">Save Changes</button>';
  openModal("Edit Tag", body, footer);
  _wireTagFilterBuilder(tag.id, condBuilder);

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

  var colorInput = document.getElementById("f-tag-color");
  var hexLabel = document.getElementById("f-tag-color-hex");
  colorInput.addEventListener("input", function () {
    hexLabel.textContent = colorInput.value;
  });
  hexLabel.textContent = colorInput.value;

  var randomBtn = document.getElementById("f-tag-color-random");
  if (randomBtn) randomBtn.addEventListener("click", function () {
    colorInput.value = randomTagColor();
    hexLabel.textContent = colorInput.value;
  });

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
        color: colorInput.value,
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

// ─── Credentials Tab ───────────────────────────────────────────────────────

var _credsLoaded = false;
var _credsData = [];
// credential id → count of assets effectively using it (asset/class/integration
// tiers resolved server-side). Drives the Assets column + click-through slide-in.
var _credUsageCounts = {};
// Mask sentinel must match the server's credentialService.MASK. Secrets
// arrive pre-masked from GET; the server preserves the real value on PUT
// whenever the mask (or an empty string) is resubmitted.
var _credMask = "••••••••";

async function loadCredentialsTab() {
  var container = document.getElementById("tab-credentials");
  container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading...</p></div>';
  try {
    // Assets-admin loads only the MIB-related endpoints (the only ones the
    // backend opens to them). admin gets the full set — credentials list,
    // MIBs + facets (for the MIB Database card), and manufacturer profiles.
    //
    // `credentials=write` also loads the credential list: that level owns
    // "add credentials, edit your own" (the ownership dimension), so the card
    // it manages can't be admin-gated any more. The MIB / profile calls in
    // the same batch already swallow their own 403s, and both those cards
    // still render for admin only.
    var adminUser = !(typeof isAdmin === "function" && !isAdmin());
    var mayWriteCreds = _credsWritable();
    if (adminUser || mayWriteCreds) {
      var results = await Promise.all([
        api.credentials.list(),
        api.serverSettings.listMibs().catch(function () { return []; }),
        api.serverSettings.getMibFacets().catch(function () { return { manufacturers: [], modelsByManufacturer: {} }; }),
        api.serverSettings.listManufacturerProfiles().catch(function () { return { profiles: [], transforms: [] }; }),
        api.credentials.usageCounts().catch(function () { return {}; }),
      ]);
      _credsData = results[0] || [];
      _mibsData = results[1] || [];
      _mibFacets = results[2] || { manufacturers: [], modelsByManufacturer: {} };
      _credUsageCounts = results[4] || {};
      var profilePayload = results[3] || {};
      _mfgProfiles = profilePayload.profiles || [];
      _mfgProfileTransforms = profilePayload.transforms || [];
      _mfgProfileCombiners = profilePayload.combiners || [];
    } else {
      // Assets-admin: MIB Database card only. Credentials list + Manufacturer
      // Profiles stay admin-only — gated below in renderCredentialsTab().
      var mibResults = await Promise.all([
        api.serverSettings.listMibs().catch(function () { return []; }),
        api.serverSettings.getMibFacets().catch(function () { return { manufacturers: [], modelsByManufacturer: {} }; }),
      ]);
      _credsData = [];
      _mibsData = mibResults[0] || [];
      _mibFacets = mibResults[1] || { manufacturers: [], modelsByManufacturer: {} };
    }
    _credsLoaded = true;
    renderCredentialsTab();
  } catch (err) {
    container.innerHTML = '<div class="settings-card"><p class="empty-state">Error: ' + escapeHtml(err.message) + '</p></div>';
  }
}

function credTypeLabel(t) {
  if (t === "snmp")    return "SNMP";
  if (t === "winrm")   return "WinRM";
  if (t === "ssh")     return "SSH";
  if (t === "restapi") return "REST API";
  if (t === "http")    return "HTTP";
  return t;
}

function credSummary(c) {
  var cfg = c.config || {};
  if (c.type === "snmp") {
    if (cfg.version === "v3") return "v3 · " + escapeHtml(cfg.username || "") + " · " + escapeHtml(cfg.securityLevel || "");
    return "v2c · community set";
  }
  if (c.type === "winrm") {
    return escapeHtml(cfg.username || "") + (cfg.useHttps ? " · HTTPS" : "");
  }
  if (c.type === "ssh") {
    var hasKey = typeof cfg.privateKey === "string" && cfg.privateKey;
    var auth = hasKey ? "private key" : "password";
    if (hasKey && typeof cfg.passphrase === "string" && cfg.passphrase) auth += " (encrypted)";
    return escapeHtml(cfg.username || "") + " · " + auth +
      (cfg.verifyHostKey === true ? " · host key verified" : "");
  }
  if (c.type === "restapi") {
    var url = cfg.baseUrl || "";
    var verifyTls = cfg.verifyTls === true ? "verify TLS" : "skip TLS";
    return escapeHtml(url) + " · " + verifyTls;
  }
  if (c.type === "http") {
    // Summarize the AUTH, which is all this credential is since the check moved
    // to a manufacturer widget. It used to lead with the request line and the
    // expectation — with those fields stripped that rendered as a FICTIONAL
    // "http://<device>/ · expect 2xx" for every row, describing a check the
    // credential no longer defines.
    var mode = httpAuthModeOf(cfg);
    if (mode === "bearer") return "bearer token";
    if (mode === "basic")  return escapeHtml(cfg.username || "") + " · basic";
    if (mode === "digest") return escapeHtml(cfg.username || "") + " · digest";
    return "no authentication";
  }
  return "";
}

// Any role with `credentials=write` manages the Stored Credentials card —
// their own rows at write, everyone's at fullwrite (the ownership dimension).
function _credsWritable() {
  if (typeof permAtLeast === "function") return permAtLeast("credentials", "write");
  return !(typeof isAdmin === "function" && !isAdmin());
}

// Ownership check for ONE row, shared with the server's assertOwnership: null
// createdBy is unowned (rows predating the column) and fullwrite-only.
function _credEditable(c) {
  if (typeof canEditCredential === "function") return canEditCredential(c);
  return _credsWritable();
}

function renderCredentialsTab() {
  var container = document.getElementById("tab-credentials");
  var adminUser = !(typeof isAdmin === "function" && !isAdmin());
  var mayWriteCreds = _credsWritable();

  var html = "";

  // ── 1. Stored Credentials (credentials=write; own rows only below fullwrite) ──
  if (mayWriteCreds) {
    var rows = _credsData.map(function (c) {
      var n = _credUsageCounts[c.id] || 0;
      var assetsCell = n > 0
        ? '<button type="button" data-action="usage" data-id="' + escapeHtml(c.id) + '" data-name="' + escapeHtml(c.name) + '" title="Show the assets using this credential" ' +
            'style="background:none;border:none;padding:0;cursor:pointer;color:var(--color-accent);font:inherit;text-decoration:underline">' + n + '</button>'
        : '<span style="color:var(--color-text-secondary)">0</span>';
      // Editing, deleting and TESTING are all ownership-scoped — testing
      // because passing the row's id merges its stored secrets into the
      // probe, so it is "borrow this password", not a read.
      var mine = _credEditable(c);
      var lock = mine ? "" : " disabled";
      var lockTitle = mine ? "" :
        ' title="' + escapeHtml(c.createdBy
          ? ("Owned by " + c.createdBy + " — needs Full Read-Write on Credentials")
          : "No recorded owner — needs Full Read-Write on Credentials") + '"';
      var ownerCell = c.createdBy
        ? escapeHtml(c.createdBy)
        : '<span style="color:var(--color-text-tertiary)" title="Created before credentials had an owner — only Full Read-Write can edit it">&mdash;</span>';
      return '<tr>' +
        '<td>' + escapeHtml(c.name) + '</td>' +
        '<td>' + credTypeLabel(c.type) + '</td>' +
        '<td style="color:var(--color-text-secondary);font-size:0.85rem">' + credSummary(c) + '</td>' +
        '<td style="color:var(--color-text-secondary);font-size:0.85rem">' + ownerCell + '</td>' +
        '<td>' + assetsCell + '</td>' +
        '<td style="text-align:right">' +
          '<button class="btn btn-sm btn-secondary" data-action="edit" data-id="' + escapeHtml(c.id) + '"' + lock + lockTitle + '>Edit</button> ' +
          '<button class="btn btn-sm btn-secondary" data-action="test" data-id="' + escapeHtml(c.id) + '"' + lock + lockTitle + '>Test</button> ' +
          '<button class="btn btn-sm btn-danger" data-action="delete" data-id="' + escapeHtml(c.id) + '" data-name="' + escapeHtml(c.name) + '"' + lock + lockTitle + '>Delete</button>' +
        '</td>' +
      '</tr>';
    }).join("");

    html +=
      '<div class="settings-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">' +
          '<h4 style="margin:0">Stored Credentials</h4>' +
          '<button class="btn btn-primary btn-sm" id="btn-cred-new">Add Credential</button>' +
        '</div>' +
        '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
          'Named credentials for asset monitoring probes. ' +
          'SNMP (v2c/v3), WinRM, and SSH credentials can be reused across assets. ' +
          'ICMP needs no credentials, and FortiManager-discovered firewalls reuse the direct-mode API token configured on their integration.' +
          ((typeof permAtLeast === "function" && !permAtLeast("credentials", "fullwrite"))
            ? '<br><span style="color:var(--color-text-tertiary)">You can edit, delete and test the credentials you created; the rest are listed read-only.</span>'
            : '') +
        '</p>' +
        (_credsData.length === 0
          ? '<p class="empty-state">No credentials yet. Click "Add Credential" to create one.</p>'
          : '<table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Details</th><th>Owner</th><th>Assets</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>') +
      '</div>';
  }

  // ── 2. MIB Database (admin OR assets-admin) ──
  html += mibCardHTML();

  // ── 3. Manufacturer Profiles (admin-only) ──
  if (adminUser) {
    html += manufacturerProfilesCardHTML();
  }

  container.innerHTML = html;

  // Wire credentials list controls only when rendered.
  if (mayWriteCreds) {
    document.getElementById("btn-cred-new").addEventListener("click", function () { openCredentialModal(null); });
    container.querySelectorAll('button[data-action="edit"]').forEach(function (btn) {
      btn.addEventListener("click", function () { openCredentialModal(btn.getAttribute("data-id")); });
    });
    container.querySelectorAll('button[data-action="test"]').forEach(function (btn) {
      btn.addEventListener("click", function () { testCredentialFromList(btn.getAttribute("data-id")); });
    });
    container.querySelectorAll('button[data-action="delete"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        deleteCredential(btn.getAttribute("data-id"), btn.getAttribute("data-name"));
      });
    });
    container.querySelectorAll('button[data-action="usage"]').forEach(function (btn) {
      btn.addEventListener("click", function () {
        openCredUsagePanel(btn.getAttribute("data-id"), btn.getAttribute("data-name"));
      });
    });
  }

  // MIB controls (browse/upload/delete) — admin-only writes enforced by the
  // backend; admin-or-assets-admin reads.
  wireMibControls();

  // Manufacturer profile controls (admin-only) — only rendered above for admin.
  if (adminUser) {
    wireManufacturerProfileControls();
  }
}

// ─── Credential usage slide-in ───────────────────────────────────────────────
// Lists the assets a credential reaches, grouped by the tier each one inherits
// it from (asset / class / integration). Models the canonical asset-details
// slide-over (assets.js): append a `.slideover-overlay` to <body>, toggle the
// `.open` class, reuse initSlideoverResize. Clicking an asset hands off via the
// #view=asset:<id> deep link — assets.js is NOT loaded on this page (see the
// wiring comment below).
var _credUsageReturnFocus = null;

function _ensureCredUsagePanelDOM() {
  if (document.getElementById("cred-usage-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "cred-usage-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="cred-usage-panel">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="cred-usage-title">Credential usage</h3>' +
          '<button class="btn-icon" id="cred-usage-close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="cred-usage-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="cred-usage-body"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) { if (e.target === overlay) closeCredUsagePanel(); });
  document.getElementById("cred-usage-close").addEventListener("click", closeCredUsagePanel);
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (!overlay.classList.contains("open")) return;
    // Let a nested asset panel grab Escape first.
    if (document.querySelector(".slideover-overlay.slideover-nested.open")) return;
    closeCredUsagePanel();
  });

  // Click-through to asset details. The Assets page isn't loaded here (this is
  // the Server Settings page), so navigate to it via the canonical
  // #view=asset:<id> hash that app.js processSearchHash() opens on load —
  // the same deep link global search / widgets / the map use.
  document.getElementById("cred-usage-body").addEventListener("click", function (e) {
    var row = e.target.closest ? e.target.closest("[data-asset-id]") : null;
    if (!row) return;
    var assetId = row.getAttribute("data-asset-id");
    if (!assetId) return;
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(assetId);
  });

  if (typeof initSlideoverResize === "function") {
    initSlideoverResize(document.getElementById("cred-usage-panel"), "polaris.panel.width.credusage");
  }
}

function closeCredUsagePanel() {
  var overlay = document.getElementById("cred-usage-overlay");
  if (overlay) overlay.classList.remove("open");
  if (_credUsageReturnFocus && typeof _credUsageReturnFocus.focus === "function") {
    try { _credUsageReturnFocus.focus(); } catch (_) { }
  }
  _credUsageReturnFocus = null;
}

function _credStreamBadges(streams) {
  if (!streams || !streams.length) return "";
  return streams.map(function (s) {
    return '<span style="display:inline-block;font-size:0.68rem;padding:0.05rem 0.4rem;border-radius:0.25rem;' +
      'background:var(--color-bg-tertiary);color:var(--color-text-secondary);margin:0 0.15rem 0.15rem 0;white-space:nowrap">' +
      escapeHtml(s) + '</span>';
  }).join("");
}

function _credUsageAssetRow(a) {
  var label = a.hostname || a.ipAddress || a.assetId;
  var sub = [];
  if (a.ipAddress && a.hostname) sub.push(escapeHtml(a.ipAddress));
  if (a.assetType) sub.push(escapeHtml(a.assetType));
  if (!a.monitored) sub.push('<span style="color:var(--color-text-tertiary)">not monitored</span>');
  return '<div data-asset-id="' + escapeHtml(a.assetId) + '" role="button" tabindex="0" ' +
    'title="Open asset details" ' +
    'style="padding:0.5rem 0.6rem;border:1px solid var(--color-border);border-radius:0.35rem;margin-bottom:0.4rem;cursor:pointer;background:var(--color-surface)">' +
    '<div style="font-weight:500;color:var(--color-accent)">' + escapeHtml(label) + '</div>' +
    (sub.length ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.1rem">' + sub.join(" · ") + '</div>' : "") +
    (a.streams && a.streams.length ? '<div style="margin-top:0.3rem">' + _credStreamBadges(a.streams) + '</div>' : "") +
    '</div>';
}

function _credUsageSectionHeader(title, count, blurb) {
  return '<div style="margin:1rem 0 0.5rem">' +
    '<h4 style="margin:0 0 0.15rem">' + escapeHtml(title) + ' (' + count + ')</h4>' +
    (blurb ? '<p style="margin:0;font-size:0.78rem;color:var(--color-text-secondary)">' + escapeHtml(blurb) + '</p>' : "") +
    '</div>';
}

async function openCredUsagePanel(credId, credName) {
  _ensureCredUsagePanelDOM();
  _credUsageReturnFocus = document.activeElement;
  var titleEl = document.getElementById("cred-usage-title");
  var metaEl = document.getElementById("cred-usage-meta");
  var bodyEl = document.getElementById("cred-usage-body");
  titleEl.textContent = credName ? credName : "Credential usage";
  metaEl.textContent = "";
  bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Loading...</p>';

  requestAnimationFrame(function () {
    var ov = document.getElementById("cred-usage-overlay");
    ov.classList.add("open");
    var panel = document.getElementById("cred-usage-panel");
    if (panel) panel.focus();
  });

  try {
    var u = await api.credentials.usage(credId);
    var total = u.total || 0;
    metaEl.innerHTML =
      '<span>' + total + ' asset' + (total === 1 ? "" : "s") + ' use this credential</span>';

    if (total === 0 && !u.classRefCount && !u.integrationRefCount) {
      bodyEl.innerHTML =
        '<div style="padding:1rem 1.25rem">' +
          '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem">' +
            'This shows where the credential is configured across the monitor-settings tiers — not a live probe trace.' +
          '</p>' +
          '<p class="empty-state" style="padding:1rem 0">No assets use this credential, and it is not referenced by any class or integration setting.</p>' +
        '</div>';
      return;
    }

    var html =
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0.5rem 0 0.25rem">' +
        'Assets are grouped by the tier they inherit this credential from. Click any asset to open its details.' +
      '</p>';

    // Asset level
    if (u.assetLevel && u.assetLevel.length) {
      html += _credUsageSectionHeader("Asset level", u.assetLevel.length, "Configured directly on the asset.");
      html += u.assetLevel.map(_credUsageAssetRow).join("");
    }

    // Class level
    if (u.classLevel && u.classLevel.length) {
      var classCount = u.classLevel.reduce(function (n, g) { return n + g.assets.length; }, 0);
      html += _credUsageSectionHeader("Class level", classCount, "Inherited from a per-class monitor override (integration + asset type).");
      html += u.classLevel.map(function (g) {
        var scope = (g.integrationName || "Manual tier") + " · " + g.assetType;
        return '<div style="margin:0.25rem 0 0.6rem">' +
          '<div style="font-size:0.82rem;font-weight:500;margin-bottom:0.3rem">' + escapeHtml(scope) +
            (g.streams && g.streams.length ? ' <span style="font-weight:400;color:var(--color-text-secondary)">— ' + g.streams.map(escapeHtml).join(", ") + '</span>' : "") +
          '</div>' +
          g.assets.map(_credUsageAssetRow).join("") +
          '</div>';
      }).join("");
    }

    // Integration level
    if (u.integrationLevel && u.integrationLevel.length) {
      var intCount = u.integrationLevel.reduce(function (n, g) { return n + g.assets.length; }, 0);
      html += _credUsageSectionHeader("Integration level", intCount, "Inherited from the integration's default monitor credential.");
      html += u.integrationLevel.map(function (g) {
        return '<div style="margin:0.25rem 0 0.6rem">' +
          '<div style="font-size:0.82rem;font-weight:500;margin-bottom:0.3rem">' + escapeHtml(g.integrationName) + '</div>' +
          g.assets.map(_credUsageAssetRow).join("") +
          '</div>';
      }).join("");
    }

    // Config references with no current assets (e.g. a class/integration default
    // pointing here but no asset matches the class yet).
    if (total === 0 && (u.classRefCount || u.integrationRefCount)) {
      var refs = [];
      if (u.classRefCount) refs.push(u.classRefCount + " class override" + (u.classRefCount === 1 ? "" : "s"));
      if (u.integrationRefCount) refs.push(u.integrationRefCount + " integration default" + (u.integrationRefCount === 1 ? "" : "s"));
      html += '<p class="empty-state" style="padding:1rem 0">No assets currently resolve to this credential, but it is referenced by ' +
        refs.join(" and ") + '.</p>';
    }

    bodyEl.innerHTML = '<div style="padding:0.75rem 1.25rem 1.25rem">' + html + '</div>';
  } catch (err) {
    bodyEl.innerHTML = '<p class="empty-state" style="padding:1rem 1.25rem">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

// Launches the Test Connection modal directly from the credentials list,
// without going through the edit modal first. Secrets in the GET payload are
// masked, but the server's /credentials/test endpoint merges real values back
// in via `id`, so the probe sees the actual stored secrets.
async function testCredentialFromList(id) {
  var cred;
  try { cred = await api.credentials.get(id); }
  catch (err) { showToast(err.message, "error"); return; }
  openCredentialTestModal({
    id: cred.id,
    name: cred.name,
    type: cred.type,
    config: cred.config,
    fromList: true,
  });
}

async function openCredentialModal(id, initialState) {
  var cred = null;
  if (id) {
    try { cred = await api.credentials.get(id); }
    catch (err) { showToast(err.message, "error"); return; }
  }
  var isNew = !cred;
  // initialState overrides the fetched-or-default form values; passed by the
  // Test Connection modal's Back button so the operator's in-flight edits
  // (including a freshly-typed password) survive the round-trip.
  var formName   = initialState ? initialState.name   : (cred ? cred.name   : "");
  var formType   = initialState ? initialState.type   : (cred ? cred.type   : "snmp");
  var formConfig = initialState ? initialState.config : (cred ? cred.config : null);
  var title = isNew ? "Add Credential" : ("Edit Credential — " + (cred ? cred.name : ""));
  var body =
    '<div class="form-group"><label>Name</label>' +
      '<input type="text" id="f-cred-name" value="' + escapeHtml(formName) + '" placeholder="e.g. Core SNMP v2c">' +
    '</div>' +
    '<div class="form-group"><label>Type</label>' +
      '<select id="f-cred-type"' + (isNew ? '' : ' disabled') + '>' +
        '<option value="snmp"'    + (formType === "snmp"    ? ' selected' : '') + '>SNMP</option>' +
        '<option value="winrm"'   + (formType === "winrm"   ? ' selected' : '') + '>WinRM</option>' +
        '<option value="ssh"'     + (formType === "ssh"     ? ' selected' : '') + '>SSH</option>' +
        '<option value="restapi"' + (formType === "restapi" ? ' selected' : '') + '>REST API</option>' +
        '<option value="http"'    + (formType === "http"    ? ' selected' : '') + '>HTTP</option>' +
      '</select>' +
      (isNew ? '<p class="hint">Type cannot be changed after creation.</p>' : '') +
    '</div>' +
    '<div id="cred-type-fields"></div>';
  var footer =
    '<button class="btn btn-secondary" id="btn-cred-test" style="margin-right:auto">Test Connection</button>' +
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-cred-save">Save</button>';
  openModal(title, body, footer);

  function renderTypeFields() {
    var t = document.getElementById("f-cred-type").value;
    // New credentials default to verify-ON (2026-06-03 review, H1; SSH
    // host-key pinning follows the same shape). Existing credentials keep
    // their stored config (no verifyTls / verifyHostKey → checkbox unchecked →
    // current no-verify behavior preserved on save). initialState (Back button)
    // always wins so in-flight edits survive.
    var cfg = formConfig || (isNew ? { verifyTls: true, verifyHostKey: true } : {});
    var host = document.getElementById("cred-type-fields");
    if (t === "snmp")        host.innerHTML = credSnmpForm(cfg);
    else if (t === "winrm")  host.innerHTML = credWinrmForm(cfg);
    else if (t === "ssh")    host.innerHTML = credSshForm(cfg);
    else if (t === "restapi") host.innerHTML = credRestApiForm(cfg);
    else if (t === "http")    host.innerHTML = credHttpForm(cfg);
    if (t === "snmp") wireSnmpVersionToggle();
    if (t === "http") wireHttpAuthModeToggle();
  }
  document.getElementById("f-cred-type").addEventListener("change", function () {
    // Switching type discards the config from the old type — there's no
    // sensible cross-type carryover (SNMP community vs WinRM password etc.)
    formConfig = null;
    renderTypeFields();
  });
  renderTypeFields();

  document.getElementById("btn-cred-test").addEventListener("click", function () {
    var name = (document.getElementById("f-cred-name").value || "").trim();
    var selectedType = document.getElementById("f-cred-type").value;
    var config = readCredentialForm(selectedType);
    openCredentialTestModal({
      id: id,
      name: name,
      type: selectedType,
      config: config,
    });
  });

  document.getElementById("btn-cred-save").addEventListener("click", async function () {
    var name = (document.getElementById("f-cred-name").value || "").trim();
    if (!name) { showToast("Name is required", "error"); return; }
    var selectedType = document.getElementById("f-cred-type").value;
    var config = readCredentialForm(selectedType);
    try {
      if (isNew) await api.credentials.create({ name: name, type: selectedType, config: config });
      else await api.credentials.update(id, { name: name, config: config });
      closeModal();
      showToast("Credential saved");
      await loadCredentialsTab();
    } catch (err) {
      showToast(err.message, "error");
    }
  });
}

// Test Connection modal — opens on top of the credential edit modal. Operator
// searches for an asset by name/IP/hostname; the asset's IP supplies the host
// for a one-shot probe of the credential as it currently sits in the form.
// Back returns to the credential modal with the operator's in-flight edits
// preserved (including any freshly-typed password) so the test result can
// inform their next save.
/**
 * The response an HTTP check actually got back, rendered so the operator can
 * TAILOR the check against it. This is the whole reason the test
 * flow exists for this type: an HTTP check's expectation is a string that has to
 * be picked OUT of the device's response, and pass/fail gives you nothing to
 * pick from. The body is shown verbatim (escaped) in a selectable block.
 *
 * The match verdict is stated separately from the pass/fail above it because it
 * is THREE-valued: matched, not matched, or nothing configured to match. The
 * last is the state every operator is in on their first test, and collapsing it
 * into the pass/fail line would read as a failed match and send them hunting
 * for a problem with the device instead of typing an expectation.
 */
function credHttpDiagnosticsHTML(diag, cfg, check) {
  if (!diag) return "";
  var muted = "color:var(--color-text-secondary)";
  function row(label, value) {
    return '<div style="display:flex;gap:0.5rem;font-size:0.8rem;margin-top:0.15rem">' +
      '<span style="' + muted + ';min-width:104px;flex-shrink:0">' + escapeHtml(label) + '</span>' +
      '<span style="word-break:break-all">' + escapeHtml(String(value)) + '</span>' +
    '</div>';
  }

  // Match verdict. null = nothing configured yet, which is the state an operator
  // is in on the first test — say so and point at the next step instead of
  // rendering a neutral dash they have to interpret.
  var verdict;
  if (diag.matched === null || diag.matched === undefined) {
    verdict = '<div style="font-size:0.8rem;margin-top:0.4rem;' + muted + '">' +
      'No expected content set — judged on the status code alone. Pick a distinctive string out of the body below and paste it into <strong>Expected content</strong>.' +
    '</div>';
  } else if (diag.matched === true) {
    verdict = '<div style="font-size:0.8rem;margin-top:0.4rem;color:var(--color-success,#27ae60)">' +
      '✓ Expected content found in the response body.' +
    '</div>';
  } else {
    verdict = '<div style="font-size:0.8rem;margin-top:0.4rem;color:var(--color-warning,#d68910)">' +
      '⚠ Expected content NOT found in the response body — the check fails.' +
    '</div>';
  }

  var size = diag.bytesRead + ' bytes' +
    (diag.bodyTruncatedAtCap ? ' (device sent more — read capped)' : '');

  // What the device ASKED for. A 401 is otherwise indistinguishable between
  // "wrong password" and "you configured Basic and it wants Digest" — and the
  // second is the common case on cameras and other embedded devices.
  var authRow = "";
  if (diag.authRequested && diag.authRequested.length) {
    var selected = httpAuthModeOf(cfg || {});
    var offered = diag.authRequested.join(", ");
    var mismatch = diag.statusCode === 401 &&
      selected !== "none" &&
      diag.authRequested.map(function (s) { return String(s).toLowerCase(); }).indexOf(selected) === -1;
    authRow = row("Device requested", offered +
      (mismatch
        ? ' — this credential is set to "' + selected + '". Switch Authentication to match.'
        : ''));
  }
  if (diag.digestNegotiated) {
    authRow += row("Digest", "challenge answered, request re-sent");
  }

  return '<div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--color-border);border-radius:4px">' +
      '<div style="font-weight:600;font-size:0.85rem">Response</div>' +
      row("Requested", diag.url) +
      row("Status", diag.statusCode) +
      authRow +
      (diag.contentType ? row("Content-Type", diag.contentType) : "") +
      row("Body size", size) +
      verdict +
      '<div style="font-size:0.78rem;' + muted + ';margin-top:0.6rem">Body' +
        (diag.excerptTruncated ? ' (first ' + diag.excerpt.length + ' characters)' : '') +
      '</div>' +
      '<pre style="margin:0.2rem 0 0;padding:0.5rem;max-height:260px;overflow:auto;background:var(--color-surface-alt,rgba(127,127,127,0.08));border-radius:3px;font-size:0.78rem;white-space:pre-wrap;word-break:break-word;user-select:text">' +
        (diag.excerpt ? escapeHtml(diag.excerpt) : '<span style="' + muted + '">(empty body)</span>') +
      '</pre>' +
    '</div>';
}

/**
 * The CHECK-definition fields, rendered inside the Test Connection modal for
 * `http` credentials.
 *
 * These used to live on the credential form. They moved to the manufacturer
 * custom widget that owns the check — but the test flow still needs them,
 * because tailoring a check is inherently iterative: you cannot know which
 * string to expect until you have seen what the device returns. So the modal
 * carries a full, unsaved check definition, and the loop is: point it at a
 * device, read the body that comes back, paste a distinctive string into
 * Expected content, re-test — then save the settled values onto the widget.
 *
 * Nothing here is persisted by the test.
 */
function credHttpCheckFields() {
  return '' +
    '<div style="margin-top:0.9rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
      '<div style="font-weight:600;font-size:0.85rem;margin-bottom:0.5rem">Check to run</div>' +
      '<p class="hint" style="margin-top:0">These describe the request, not the credential. Once they are right, save them on the matching <strong>Manufacturer Profile → Custom Widget</strong>; this modal never persists them.</p>' +
      '<div class="form-group" style="margin-top:1rem">' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" id="f-tchk-https">' +
          '<span>Use HTTPS</span>' +
        '</label>' +
      '</div>' +
      // Port is an opt-in override: the scheme already implies one (80 / 443),
      // so an always-editable box invites typing the value that was already
      // going to be used. Disabled rather than hidden so it is visible that a
      // port exists and is being defaulted.
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" id="f-tchk-customport">' +
          '<span>Custom port</span>' +
        '</label>' +
        '<input type="number" id="f-tchk-port" min="1" max="65535" placeholder="default (80)" style="max-width:200px;margin-top:4px" disabled>' +
      '</div>' +
      '<div class="form-group"><label>Path</label>' +
        '<input type="text" id="f-tchk-path" placeholder="/healthz">' +
      '</div>' +
      '<div class="form-group"><label>Expected status code</label>' +
        '<input type="number" id="f-tchk-status" min="100" max="599" placeholder="any 2xx" style="max-width:200px">' +
        '<p class="hint">Leave blank to accept any 2xx. Redirects are never followed, so set this to 301/302 only if the redirect itself is the healthy answer.</p>' +
      '</div>' +
      '<div class="form-group"><label>Match</label>' +
        // flex-wrap so the checkbox drops below the select on a narrow modal
        // rather than being clipped out of reach.
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">' +
          '<select id="f-tchk-matchmode" style="max-width:240px">' +
            '<option value="contains" selected>Contains this text</option>' +
            '<option value="regex">Matches this regular expression</option>' +
          '</select>' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap">' +
            '<input type="checkbox" id="f-tchk-casesensitive">' +
            '<span>Case sensitive</span>' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="form-group"><label>Expected content</label>' +
        '<input type="text" id="f-tchk-body" placeholder="e.g. OK">' +
        '<p class="hint">Text the response body must carry. This is what separates "the web server answered" from "the service still works" — a device serving an error page still returns 200. Leave blank to judge on the status code alone.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
          '<input type="checkbox" id="f-tchk-verifytls">' +
          '<span>Verify TLS certificate</span>' +
        '</label>' +
        '<p class="hint">Only applies with HTTPS. Off by default — device management certs are usually self-signed.</p>' +
      '</div>' +
    '</div>';
}

/** Collect the modal's check definition. Blank number fields mean "default". */
function readHttpCheckFields() {
  function numOrNull(id) {
    var v = (document.getElementById(id).value || "").trim();
    return v ? Number(v) : null;
  }
  // A disabled Custom port sends null rather than whatever is left in the box,
  // so un-ticking it actually returns the check to the scheme default instead
  // of silently keeping the last typed value.
  var customPort = document.getElementById("f-tchk-customport").checked;
  return {
    useHttps:       document.getElementById("f-tchk-https").checked,
    port:           customPort ? numOrNull("f-tchk-port") : null,
    path:           (document.getElementById("f-tchk-path").value || "").trim(),
    expectStatus:   numOrNull("f-tchk-status"),
    expectBody:     document.getElementById("f-tchk-body").value,
    matchMode:      document.getElementById("f-tchk-matchmode").value,
    caseSensitive:  document.getElementById("f-tchk-casesensitive").checked,
    verifyTls:      document.getElementById("f-tchk-verifytls").checked,
  };
}

function openCredentialTestModal(state) {
  var typeLabel = credTypeLabel(state.type);
  var title = "Test Credential" + (state.name ? " — " + state.name : "");
  var body =
    '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0 0 0.75rem">' +
      'Pick an asset to test this ' + escapeHtml(typeLabel) + ' credential against, or type an address directly — ' +
      'useful for a device that isn\'t onboarded yet. Either way the host is all that is borrowed; ' +
      'monitor settings are ignored — the form values you entered are what gets exercised.' +
      (state.type === 'http'
        ? ' The response body comes back below, so you can pick your <strong>Expected content</strong> string out of what the device actually returns. A per-asset path override is not applied here — this tests the credential.'
        : '') +
    '</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal">' +
        '<input type="radio" name="cred-test-mode" value="asset" checked>' +
        '<span>Choose an existing asset</span>' +
      '</label>' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-weight:normal;margin-top:0.25rem">' +
        '<input type="radio" name="cred-test-mode" value="manual">' +
        '<span>Enter an IP or hostname</span>' +
      '</label>' +
    '</div>' +
    '<div class="form-group" data-test-mode="asset"><label>Search asset</label>' +
      '<input type="search" id="f-cred-test-search" autocomplete="off" spellcheck="false" placeholder="hostname, IP, or MAC (min 2 chars)">' +
      '<div id="f-cred-test-results" style="margin-top:0.25rem;max-height:240px;overflow:auto;border:1px solid var(--color-border);border-radius:4px;display:none"></div>' +
    '</div>' +
    '<div id="f-cred-test-selected" data-test-mode="asset" style="display:none;padding:0.6rem 0.75rem;border:1px solid var(--color-border);border-radius:4px;margin-bottom:0.75rem;background:var(--color-surface-alt,rgba(127,127,127,0.05))"></div>' +
    '<div class="form-group" data-test-mode="manual" style="display:none"><label>IP address or hostname</label>' +
      '<input type="text" id="f-cred-test-host" autocomplete="off" spellcheck="false" placeholder="10.20.30.40">' +
      '<p class="hint">Just the host — no scheme, port or path. Those are part of the check below, so a pasted URL is refused rather than silently trimmed down to something that dials differently from what you typed. Nothing is saved; this only picks the target for one probe.</p>' +
    '</div>' +
    (state.type === 'http' ? credHttpCheckFields() : '') +
    '<div id="f-cred-test-result" style="display:none"></div>';
  var footer =
    (state.fromList ? '' : '<button class="btn btn-secondary" id="btn-cred-test-back" style="margin-right:auto">&larr; Back</button>') +
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>' +
    '<button class="btn btn-primary" id="btn-cred-test-run" disabled>Run Test</button>';
  openModal(title, body, footer);

  var selectedAsset = null;
  var searchTimer = null;
  var lastQuery = "";

  var searchInput   = document.getElementById("f-cred-test-search");
  var resultsBox    = document.getElementById("f-cred-test-results");
  var selectedBox   = document.getElementById("f-cred-test-selected");
  var hostInput     = document.getElementById("f-cred-test-host");
  var resultBox     = document.getElementById("f-cred-test-result");
  var runBtn        = document.getElementById("btn-cred-test-run");
  var backBtn       = document.getElementById("btn-cred-test-back");
  var modeRadios    = document.querySelectorAll('input[name="cred-test-mode"]');

  function testMode() {
    for (var i = 0; i < modeRadios.length; i++) {
      if (modeRadios[i].checked) return modeRadios[i].value;
    }
    return "asset";
  }

  /**
   * Run Test is enabled by whichever half the current mode actually uses, so
   * switching modes can't leave it enabled on the strength of the other half's
   * input — which would post an assetId the operator had already navigated away
   * from.
   */
  function syncRunEnabled() {
    runBtn.disabled = testMode() === "asset"
      ? !selectedAsset
      : !(hostInput.value || "").trim();
  }

  for (var mi = 0; mi < modeRadios.length; mi++) {
    modeRadios[mi].addEventListener("change", function () {
      var mode = testMode();
      var groups = document.querySelectorAll("[data-test-mode]");
      for (var i = 0; i < groups.length; i++) {
        var forMode = groups[i].getAttribute("data-test-mode");
        // The selected-asset card is only ever shown when something is selected,
        // so restoring it on a mode flip has to respect that too.
        var wanted = forMode === mode && (groups[i].id !== "f-cred-test-selected" || !!selectedAsset);
        groups[i].style.display = wanted ? "" : "none";
      }
      syncRunEnabled();
      var focusEl = mode === "asset" ? searchInput : hostInput;
      setTimeout(function () { focusEl.focus(); }, 0);
    });
  }
  // Port controls (http only): Custom port gates the field, and Use HTTPS
  // relabels its placeholder so the default on offer is the real one.
  var httpsBox  = document.getElementById("f-tchk-https");
  var customBox = document.getElementById("f-tchk-customport");
  var portInput = document.getElementById("f-tchk-port");
  if (httpsBox && customBox && portInput) {
    function syncPort() {
      portInput.disabled = !customBox.checked;
      portInput.placeholder = "default (" + (httpsBox.checked ? "443" : "80") + ")";
      portInput.style.opacity = customBox.checked ? "" : "0.5";
    }
    httpsBox.addEventListener("change", syncPort);
    customBox.addEventListener("change", syncPort);
    syncPort();
  }

  hostInput.addEventListener("input", syncRunEnabled);
  hostInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !runBtn.disabled) { e.preventDefault(); runBtn.click(); }
  });

  function setSelected(hit) {
    selectedAsset = hit;
    if (!hit) {
      selectedBox.style.display = "none";
      syncRunEnabled();
      return;
    }
    selectedBox.innerHTML =
      '<div style="display:flex;align-items:flex-start;gap:0.6rem">' +
        '<div style="color:var(--color-success,#27ae60);font-weight:700;font-size:1.1rem;line-height:1.2;flex-shrink:0" aria-label="Selected">✓</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600">' + escapeHtml(hit.title || "asset") + '</div>' +
          (hit.subtitle ? '<div style="font-size:0.82rem;color:var(--color-text-secondary)">' + escapeHtml(hit.subtitle) + '</div>' : '') +
        '</div>' +
      '</div>';
    selectedBox.style.display = "block";
    resultsBox.style.display = "none";
    resultsBox.innerHTML = "";
    searchInput.value = hit.title || "";
    syncRunEnabled();
  }

  function renderResults(hits) {
    if (!hits.length) {
      resultsBox.innerHTML = '<div style="padding:0.5rem 0.75rem;color:var(--color-text-secondary);font-size:0.85rem">No asset matches.</div>';
      resultsBox.style.display = "block";
      return;
    }
    resultsBox.innerHTML = hits.map(function (h, idx) {
      return '<div class="cred-test-hit" data-idx="' + idx + '" style="padding:0.5rem 0.75rem;cursor:pointer;border-bottom:1px solid var(--color-border)">' +
        '<div style="font-weight:600">' + escapeHtml(h.title || "asset") + '</div>' +
        (h.subtitle ? '<div style="font-size:0.8rem;color:var(--color-text-secondary)">' + escapeHtml(h.subtitle) + '</div>' : '') +
      '</div>';
    }).join("");
    resultsBox.style.display = "block";
    resultsBox.querySelectorAll(".cred-test-hit").forEach(function (el) {
      el.addEventListener("click", function () {
        var idx = Number(el.getAttribute("data-idx"));
        setSelected(hits[idx]);
      });
    });
  }

  searchInput.addEventListener("input", function () {
    var q = searchInput.value.trim();
    if (selectedAsset && q !== (selectedAsset.title || "")) {
      // operator started typing again — clear the previous selection
      selectedAsset = null;
      selectedBox.style.display = "none";
      syncRunEnabled();
    }
    clearTimeout(searchTimer);
    if (q.length < 2) {
      resultsBox.style.display = "none";
      resultsBox.innerHTML = "";
      lastQuery = "";
      return;
    }
    searchTimer = setTimeout(async function () {
      lastQuery = q;
      try {
        // /assets, not the global /search endpoint: /search caps each
        // entity group at 8 and partitions pinned firewalls out into
        // `sites`, so on fleets with lots of endpoints sharing a hostname
        // prefix a firewall could silently fall off the bottom of the
        // typeahead. /assets has no per-group cap and returns every
        // asset type uniformly, including firewalls regardless of map pin.
        var results = await api.assets.list({ search: q, limit: 25 });
        if (q !== lastQuery) return; // stale
        var hits = (results.assets || []).map(function (a) {
          var vendorModel = [a.manufacturer, a.model].filter(Boolean).join(" ");
          var bits = [a.ipAddress, a.macAddress, vendorModel].filter(Boolean);
          return {
            id: a.id,
            title: a.hostname || a.assetTag || "asset",
            subtitle: bits.join(" — ") || a.assetType,
          };
        });
        renderResults(hits);
      } catch (err) {
        resultsBox.innerHTML = '<div style="padding:0.5rem 0.75rem;color:var(--color-danger,#c0392b);font-size:0.85rem">Search failed: ' + escapeHtml(err.message || "Unknown error") + '</div>';
        resultsBox.style.display = "block";
      }
    }, 180);
  });
  setTimeout(function () { searchInput.focus(); }, 0);

  runBtn.addEventListener("click", async function () {
    var mode = testMode();
    var typedHost = (hostInput.value || "").trim();
    if (mode === "asset" ? !selectedAsset : !typedHost) return;
    runBtn.disabled = true;
    var origLabel = runBtn.textContent;
    runBtn.textContent = "Testing…";
    resultBox.style.display = "block";
    resultBox.innerHTML = '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0.75rem 0 0">Running probe…</p>';
    // Send exactly ONE target. The server prefers assetId when both arrive, but
    // sending only what the current mode selected keeps the audited hostSource
    // honest about what the operator actually aimed at.
    var body = { type: state.type, config: state.config };
    if (mode === "asset") body.assetId = selectedAsset.id;
    else body.host = typedHost;
    if (state.id) body.id = state.id;
    // The check definition is per-test, not part of the credential.
    if (state.type === "http") body.check = readHttpCheckFields();
    try {
      var res = await api.credentials.test(body);
      var ok = !!res.success;
      var color = ok ? 'var(--color-success,#27ae60)' : 'var(--color-danger,#c0392b)';
      var icon  = ok ? '✓' : '✗';
      var label = ok ? 'Success' : 'Failed';
      var detail;
      if (ok) detail = 'Probe answered in ' + (res.responseTimeMs || 0) + ' ms.';
      else detail = res.error || 'Probe failed (no error returned).';
      resultBox.innerHTML =
        '<div style="margin-top:0.75rem;padding:0.75rem;border:1px solid ' + color + ';border-radius:4px;background:rgba(127,127,127,0.04)">' +
          '<div style="font-weight:600;color:' + color + '">' + icon + ' ' + label + '</div>' +
          '<div style="font-size:0.85rem;margin-top:0.25rem">' + escapeHtml(detail) + '</div>' +
          (res.host ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.25rem">Host: ' + escapeHtml(res.host) + '</div>' : '') +
        '</div>' +
        credHttpDiagnosticsHTML(res.httpDiagnostics, state.config, body.check);
    } catch (err) {
      resultBox.innerHTML =
        '<div style="margin-top:0.75rem;padding:0.75rem;border:1px solid var(--color-danger,#c0392b);border-radius:4px">' +
          '<div style="font-weight:600;color:var(--color-danger,#c0392b)">✗ Failed</div>' +
          '<div style="font-size:0.85rem;margin-top:0.25rem">' + escapeHtml(err.message || "Test request failed") + '</div>' +
        '</div>';
    } finally {
      runBtn.textContent = origLabel;
      syncRunEnabled();
    }
  });

  if (backBtn) {
    backBtn.addEventListener("click", function () {
      openCredentialModal(state.id, { name: state.name, type: state.type, config: state.config });
    });
  }
}

function credSnmpForm(cfg) {
  var version = cfg.version === "v3" ? "v3" : "v2c";
  var community = cfg.community || "";
  var port = cfg.port || "";
  var v3 = {
    username: cfg.username || "",
    securityLevel: cfg.securityLevel || "authPriv",
    authProtocol: cfg.authProtocol || "SHA",
    authKey: cfg.authKey || "",
    privProtocol: cfg.privProtocol || "AES",
    privKey: cfg.privKey || "",
  };
  return (
    '<div class="form-group"><label>Version</label>' +
      '<select id="f-snmp-version">' +
        '<option value="v2c"' + (version === "v2c" ? " selected" : "") + '>v2c</option>' +
        '<option value="v3"'  + (version === "v3"  ? " selected" : "") + '>v3</option>' +
      '</select>' +
    '</div>' +
    '<div id="snmp-v2c-fields" style="display:' + (version === "v2c" ? "block" : "none") + '">' +
      '<div class="form-group"><label>Community</label>' +
        '<input type="password" id="f-snmp-community" value="' + escapeHtml(community) + '" placeholder="public">' +
      '</div>' +
    '</div>' +
    '<div id="snmp-v3-fields" style="display:' + (version === "v3" ? "block" : "none") + '">' +
      '<div class="form-group"><label>Username</label>' +
        '<input type="text" id="f-snmp-user" value="' + escapeHtml(v3.username) + '">' +
      '</div>' +
      '<div class="form-group"><label>Security Level</label>' +
        '<select id="f-snmp-seclevel">' +
          '<option value="noAuthNoPriv"' + (v3.securityLevel === "noAuthNoPriv" ? " selected" : "") + '>noAuthNoPriv</option>' +
          '<option value="authNoPriv"'   + (v3.securityLevel === "authNoPriv"   ? " selected" : "") + '>authNoPriv</option>' +
          '<option value="authPriv"'     + (v3.securityLevel === "authPriv"     ? " selected" : "") + '>authPriv</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Auth Protocol</label>' +
        '<select id="f-snmp-authproto">' +
          '<option value="SHA"'    + (v3.authProtocol === "SHA"    ? " selected" : "") + '>SHA-1 (HMAC-SHA-96)</option>' +
          '<option value="MD5"'    + (v3.authProtocol === "MD5"    ? " selected" : "") + '>MD5 (HMAC-MD5-96)</option>' +
          '<option value="SHA224"' + (v3.authProtocol === "SHA224" ? " selected" : "") + '>SHA-224</option>' +
          '<option value="SHA256"' + (v3.authProtocol === "SHA256" ? " selected" : "") + '>SHA-256</option>' +
          '<option value="SHA384"' + (v3.authProtocol === "SHA384" ? " selected" : "") + '>SHA-384</option>' +
          '<option value="SHA512"' + (v3.authProtocol === "SHA512" ? " selected" : "") + '>SHA-512</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Auth Key</label>' +
        '<input type="password" id="f-snmp-authkey" value="' + escapeHtml(v3.authKey) + '">' +
      '</div>' +
      '<div class="form-group"><label>Priv Protocol</label>' +
        '<select id="f-snmp-privproto">' +
          '<option value="AES"'     + (v3.privProtocol === "AES"     ? " selected" : "") + '>AES-128 (CFB)</option>' +
          '<option value="DES"'     + (v3.privProtocol === "DES"     ? " selected" : "") + '>DES (CBC, 56-bit)</option>' +
          '<option value="AES256B"' + (v3.privProtocol === "AES256B" ? " selected" : "") + '>AES-256 (Blumenthal draft)</option>' +
          '<option value="AES256R"' + (v3.privProtocol === "AES256R" ? " selected" : "") + '>AES-256 (Reeder draft / Cisco)</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-group"><label>Priv Key</label>' +
        '<input type="password" id="f-snmp-privkey" value="' + escapeHtml(v3.privKey) + '">' +
      '</div>' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-snmp-port" value="' + escapeHtml(String(port)) + '" placeholder="161" min="1" max="65535">' +
    '</div>'
  );
}

function wireSnmpVersionToggle() {
  var sel = document.getElementById("f-snmp-version");
  if (!sel) return;
  sel.addEventListener("change", function () {
    var v = sel.value;
    var v2 = document.getElementById("snmp-v2c-fields");
    var v3 = document.getElementById("snmp-v3-fields");
    if (v2) v2.style.display = v === "v2c" ? "block" : "none";
    if (v3) v3.style.display = v === "v3"  ? "block" : "none";
  });
}

function credWinrmForm(cfg) {
  return (
    '<div class="form-group"><label>Username</label>' +
      '<input type="text" id="f-winrm-user" value="' + escapeHtml(cfg.username || "") + '" placeholder="Administrator">' +
    '</div>' +
    '<div class="form-group"><label>Password</label>' +
      '<input type="password" id="f-winrm-pass" value="' + escapeHtml(cfg.password || "") + '">' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-winrm-port" value="' + escapeHtml(String(cfg.port || "")) + '" placeholder="5986" min="1" max="65535">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-winrm-https"' + (cfg.useHttps ? " checked" : "") + '>' +
        '<span>Use HTTPS</span>' +
      '</label>' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-winrm-verifytls"' + (cfg.verifyTls === true ? " checked" : "") + '>' +
        '<span>Verify TLS certificate</span>' +
      '</label>' +
      '<p class="hint" style="color:var(--color-warning,#d98c00)">Applies when Use HTTPS is on. Leave enabled. WinRM sends the username and password as Basic auth, so disabling certificate verification lets a network attacker intercept the connection and capture these credentials. Disable only for a host with a self-signed certificate you cannot replace.</p>' +
    '</div>'
  );
}

function credSshForm(cfg) {
  return (
    '<div class="form-group"><label>Username</label>' +
      '<input type="text" id="f-ssh-user" value="' + escapeHtml(cfg.username || "") + '">' +
    '</div>' +
    '<div class="form-group"><label>Password</label>' +
      '<input type="password" id="f-ssh-pass" value="' + escapeHtml(cfg.password || "") + '">' +
      '<p class="hint">Provide either a password or a private key.</p>' +
    '</div>' +
    '<div class="form-group"><label>Private Key</label>' +
      '<textarea id="f-ssh-key" rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----">' + escapeHtml(cfg.privateKey || "") + '</textarea>' +
    '</div>' +
    '<div class="form-group"><label>Private Key Passphrase <span style="font-weight:normal;color:var(--color-text-tertiary)">(only if the key is encrypted)</span></label>' +
      '<input type="password" id="f-ssh-passphrase" value="' + escapeHtml(cfg.passphrase || "") + '" autocomplete="new-password">' +
      '<p class="hint">Leave blank for an unencrypted key. Keys generated by Polaris (Integrations &rarr; Polaris Agent &rarr; SSH Deployment) are never encrypted &mdash; they are already sealed at rest and never exported, so a passphrase would only sit beside the key it protects.</p>' +
    '</div>' +
    '<div class="form-group"><label>Port</label>' +
      '<input type="number" id="f-ssh-port" value="' + escapeHtml(String(cfg.port || "")) + '" placeholder="22" min="1" max="65535">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="f-ssh-verifyhostkey"' + (cfg.verifyHostKey === true ? " checked" : "") + '>' +
        '<span>Verify the server\'s host key</span>' +
      '</label>' +
      '<p class="hint">Recommended. When off, Polaris accepts whatever host key is presented, so anything answering on the target\'s address can impersonate it &mdash; and on an agent install it is handed a script to run as root. On first connection Polaris pins the key it sees and refuses later connections if it changes; if a host is legitimately rebuilt or re-keyed, delete its pin under Integrations &rarr; Polaris Agent &rarr; Windows SSH Deployment.</p>' +
    '</div>'
  );
}

function credRestApiForm(cfg) {
  return (
    '<div class="form-group"><label>Base URL</label>' +
      '<input type="text" id="f-rest-baseurl" value="' + escapeHtml(cfg.baseUrl || "") + '" placeholder="https://device.example/">' +
      '<p class="hint">Full URL the credential authenticates against, including scheme. Trailing slashes are normalized. ' + 'This is what <strong>Test</strong> dials. When this credential is selected on a monitored device stream, only the token, ' + 'the <em>port</em> and the TLS setting are used — the request goes to that device’s own address, not to this host.</p>' +
    '</div>' +
    '<div class="form-group"><label>API Token</label>' +
      '<input type="password" id="f-rest-token" value="' + escapeHtml(cfg.apiToken || "") + '">' +
      '<p class="hint">Sent as <code>Authorization: Bearer &lt;token&gt;</code>.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:6px;cursor:pointer">' +
        '<input type="checkbox" id="f-rest-verifytls"' + (cfg.verifyTls === true ? " checked" : "") + '>' +
        '<span>Verify TLS certificate</span>' +
      '</label>' +
      '<p class="hint">Off by default to match FortiOS REST behaviour where self-signed device certs are common. Turn on when targeting a host with a real certificate.</p>' +
    '</div>'
  );
}

/**
 * The `http` credential form — AUTHENTICATION ONLY since 2026-08. Everything
 * that describes the check itself (scheme, port, path, expected status,
 * expected content, match mode, TLS verification) moved to the manufacturer
 * custom widget that owns the check, and is additionally settable ad hoc in the
 * Test Connection modal so a check can be dialled in before it is saved.
 *
 * There is no "None" option: a credential exists to authenticate, and an
 * unauthenticated check is expressed by a widget with no credential attached.
 */
function credHttpForm(cfg) {
  var authMode = httpAuthModeOf(cfg);
  // A pre-split credential can resolve to "none" (it authenticated nothing).
  // The select has no such option, so land it on bearer rather than rendering a
  // dropdown whose value silently isn't in its own list.
  if (authMode === "none") authMode = "bearer";
  return (
    // Sits directly under the credential Type dropdown (which the modal shell
    // renders immediately above this host element), because the first thing to
    // establish is what this credential does NOT contain — operators arriving
    // from the old combined form look for the path here.
    // The global reset (styles.css `* { margin: 0 }`) zeroes margins on a bare
    // <p>, and `.hint` only gets spacing via `.form-group .hint` — which this
    // is not, sitting above the first group rather than inside one. So the
    // bottom margin is explicit, matching `.form-group`'s own 1rem rhythm.
    '<p class="hint" style="margin:0 0 1rem">What this credential is used to check — the path, the status code, the content the body must carry — is configured per manufacturer and model under <strong>Manufacturer Profiles → Custom Widgets</strong>. Use <strong>Test Connection</strong> below to try a check against a device before saving it there.</p>' +
    '<div class="form-group"><label>Authentication</label>' +
      '<select id="f-http-authmode" style="max-width:280px">' +
        '<option value="bearer"' + (authMode === "bearer" ? " selected" : "") + '>Bearer token</option>' +
        '<option value="basic"' +  (authMode === "basic"  ? " selected" : "") + '>Basic (cleartext)</option>' +
        '<option value="digest"' + (authMode === "digest" ? " selected" : "") + '>Digest (hashed)</option>' +
      '</select>' +
      // One alert per mode, all three riding the same data-http-auth mechanism
      // that shows/hides the carrier fields below — so exactly one is on screen
      // and none can drift out of sync with the selection.
      //
      // Every mode gets one because every mode is exposed over plain HTTP; what
      // differs is WHAT leaks. All three name Manufacturer Profiles rather than
      // offering a fix here, because `useHttps` is configured per CHECK on the
      // widget: a credential cannot control its own exposure, and that is
      // precisely what an operator would otherwise hunt for on this form.
      _httpAuthAlert("bearer",
        '<strong>The token is sent in cleartext</strong> unless the assets using this credential are checked over HTTPS. ' +
        'Bearer sends it verbatim in the <code>Authorization</code> header, so anyone on the path can read it and reuse it.') +
      _httpAuthAlert("basic",
        '<strong>The username and password are sent in cleartext</strong> unless the assets using this credential are checked over HTTPS. ' +
        'Basic sends them base64-encoded — encoding, not encryption — so anyone on the path can read them and reuse them.') +
      _httpAuthAlert("digest",
        '<strong>The password hash is readable</strong> unless the assets using this credential are checked over HTTPS. ' +
        'Digest sends a hash instead of the password, so anyone on the path can attack it offline or replay it until the nonce expires ' +
        '— along with the username, which travels in the clear.') +
    '</div>' +
    '<div class="form-group" data-http-auth="bearer"><label>Bearer token</label>' +
      '<input type="password" id="f-http-token" value="' + escapeHtml(cfg.apiToken || "") + '">' +
      '<p class="hint">Sent as <code>Authorization: Bearer &lt;token&gt;</code>.</p>' +
    '</div>' +
    '<div class="form-group" data-http-auth="basic digest"><label>Username</label>' +
      '<input type="text" id="f-http-user" value="' + escapeHtml(cfg.username || "") + '">' +
    '</div>' +
    '<div class="form-group" data-http-auth="basic digest"><label>Password</label>' +
      '<input type="password" id="f-http-pass" value="' + escapeHtml(cfg.password || "") + '">' +
    '</div>'
  );
}

/**
 * One mode-scoped warning box. Factored out so the three differ only in the
 * mode they belong to and the sentence they carry — the styling is the file's
 * existing `alert alert-warning` convention.
 */
function _httpAuthAlert(mode, bodyHTML) {
  return '<div class="alert alert-warning" data-http-auth="' + mode + '" ' +
    'style="padding:0.6rem 0.75rem;border-radius:6px;background:rgba(214,137,16,0.12);' +
    'border:1px solid var(--color-warning,#d68910);color:var(--color-text-primary);' +
    'font-size:0.82rem;margin:0.5rem 0 0.75rem">' +
      bodyHTML +
      ' HTTPS is set per check — tick <strong>Use HTTPS</strong> on the HTTP-check widget under Manufacturer Profiles → Custom Widgets.' +
    '</div>';
}

/**
 * Mirror of resolveHttpAuthMode in src/utils/httpCheck.ts. A credential saved
 * before the auth-mode field existed carries no `authMode`, and must render as
 * whatever it has always DONE — bearer when a token is set, basic when a
 * username/password pair is — rather than as "None", which would misreport an
 * authenticating credential and then strip its auth on the next save.
 */
function httpAuthModeOf(cfg) {
  var declared = cfg.authMode;
  if (declared === "none" || declared === "bearer" || declared === "basic" || declared === "digest") return declared;
  if (cfg.apiToken) return "bearer";
  if (cfg.username && cfg.password) return "basic";
  return "none";
}

/** Show only the carrier fields the selected auth mode actually sends. */
function wireHttpAuthModeToggle() {
  var sel = document.getElementById("f-http-authmode");
  if (!sel) return;
  function sync() {
    var mode = sel.value;
    var groups = document.querySelectorAll("[data-http-auth]");
    for (var i = 0; i < groups.length; i++) {
      var modes = (groups[i].getAttribute("data-http-auth") || "").split(" ");
      groups[i].style.display = modes.indexOf(mode) === -1 ? "none" : "";
    }
  }
  sel.addEventListener("change", sync);
  sync();
}

function readCredentialForm(type) {
  function num(v) { v = (v || "").trim(); return v ? Number(v) : undefined; }
  if (type === "snmp") {
    var version = document.getElementById("f-snmp-version").value;
    var port = num(document.getElementById("f-snmp-port").value);
    if (version === "v2c") {
      var cfg = { version: "v2c", community: document.getElementById("f-snmp-community").value };
      if (port !== undefined) cfg.port = port;
      return cfg;
    }
    var v3 = {
      version: "v3",
      username: document.getElementById("f-snmp-user").value,
      securityLevel: document.getElementById("f-snmp-seclevel").value,
      authProtocol: document.getElementById("f-snmp-authproto").value,
      authKey: document.getElementById("f-snmp-authkey").value,
      privProtocol: document.getElementById("f-snmp-privproto").value,
      privKey: document.getElementById("f-snmp-privkey").value,
    };
    if (port !== undefined) v3.port = port;
    return v3;
  }
  if (type === "winrm") {
    var w = {
      username: document.getElementById("f-winrm-user").value,
      password: document.getElementById("f-winrm-pass").value,
      useHttps: document.getElementById("f-winrm-https").checked,
      verifyTls: document.getElementById("f-winrm-verifytls").checked,
    };
    var wp = num(document.getElementById("f-winrm-port").value);
    if (wp !== undefined) w.port = wp;
    return w;
  }
  if (type === "restapi") {
    return {
      baseUrl: (document.getElementById("f-rest-baseurl").value || "").trim(),
      apiToken: document.getElementById("f-rest-token").value,
      verifyTls: document.getElementById("f-rest-verifytls").checked,
    };
  }
  if (type === "http") {
    // AUTH ONLY. The check definition moved to the manufacturer custom widget,
    // so this form no longer collects a path, status or body expectation.
    // NOTE: the carriers the selected mode does not send are stripped
    // SERVER-side (validateHttpConfig), not here. Blanking a secret field in
    // this payload means "keep the stored value" to
    // mergeConfigPreservingSecrets, so clearing it client-side would silently
    // preserve exactly the credential it looks like it is removing.
    return {
      authMode: document.getElementById("f-http-authmode").value,
      apiToken: document.getElementById("f-http-token").value,
      username: (document.getElementById("f-http-user").value || "").trim(),
      password: document.getElementById("f-http-pass").value,
    };
  }
  var s = {
    username: document.getElementById("f-ssh-user").value,
    password: document.getElementById("f-ssh-pass").value,
    privateKey: document.getElementById("f-ssh-key").value,
    passphrase: document.getElementById("f-ssh-passphrase").value,
    verifyHostKey: document.getElementById("f-ssh-verifyhostkey").checked,
  };
  var sp = num(document.getElementById("f-ssh-port").value);
  if (sp !== undefined) s.port = sp;
  return s;
}

async function deleteCredential(id, name) {
  var ok = await showConfirm('Delete credential "' + name + '"?');
  if (!ok) return;
  try {
    await api.credentials.delete(id);
    showToast("Credential deleted");
    await loadCredentialsTab();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── API Tokens tab ────────────────────────────────────────────────────────

var _apiTokensLoaded = false;

var _quarantineIntegrations = [];

async function loadApiTokensTab() {
  var container = document.getElementById("tab-api-tokens");
  if (!container) return;
  _apiTokensLoaded = true;
  container.innerHTML = '<p class="empty-state" style="padding:2rem">Loading…</p>';
  try {
    // The docs-access card must not take the whole tab down with it — a
    // failed apiDocsGet renders as an error state inside its own card.
    var results = await Promise.allSettled([api.apiTokens.list(), api.serverSettings.apiDocsGet()]);
    if (results[0].status === "rejected") throw results[0].reason;
    var data = results[0].value;
    var docsData = results[1].status === "fulfilled" ? results[1].value : null;
    var docsError = results[1].status === "rejected"
      ? ((results[1].reason && results[1].reason.message) || "Failed to load API documentation access settings")
      : null;
    _quarantineIntegrations = data.quarantineIntegrations || [];
    renderApiTokensTab(data.tokens || [], data.roles || [], _quarantineIntegrations, data.apiBaseUrl || null, {
      apiDocs: docsData ? docsData.apiDocs : null,
      callerIp: docsData ? docsData.callerIp : "",
      error: docsError,
    });
  } catch (err) {
    container.innerHTML = '<p class="empty-state" style="color:var(--color-danger,#c0392b);padding:2rem">' + escapeHtml(err.message || "Failed to load API tokens") + '</p>';
  }
}

function _integrationLabel(intg) {
  var typeLabel = intg.type === "fortimanager" ? "FortiManager" : "FortiGate";
  return intg.name + " (" + typeLabel + ")";
}

function _integrationStatusNote(intg) {
  if (!intg.enabled) return '<span style="color:var(--color-danger,#c0392b)"> — integration disabled, quarantine push will fail</span>';
  if (!intg.pushQuarantineEnabled) return '<span style="color:var(--color-warning,#d68910)"> — Quarantine Push toggle is off on this integration; pushes will be skipped</span>';
  return '';
}

function renderApiTokensTab(tokens, roles, quarantineIntegrations, apiBaseUrl, docsAccess) {
  var container = document.getElementById("tab-api-tokens");
  if (!container) return;
  docsAccess = docsAccess || { apiDocs: null, callerIp: "", error: null };

  // Base URL for external callers: POLARIS_PUBLIC_URL's origin + /api/v1 when
  // the server knows it, else this browser's own origin as a best-effort hint.
  var baseUrlIsFallback = !apiBaseUrl;
  var effectiveBaseUrl = apiBaseUrl || (window.location.origin + "/api/v1");

  var integrationById = {};
  (quarantineIntegrations || []).forEach(function (i) { integrationById[i.id] = i; });
  var roleById = {};
  (roles || []).forEach(function (r) { roleById[r.id] = r; });

  var tableHtml = tokens.length
    ? '<div class="table-wrapper"><table class="data-table"><thead><tr>' +
        '<th>Name</th><th>Prefix</th><th>Role</th><th>Integrations</th><th>Created By</th><th>Last Used</th><th>Expires</th><th>Status</th><th>Actions</th>' +
      '</tr></thead><tbody>' +
      tokens.map(function (t) {
        var statusBadge = t.revokedAt
          ? '<span class="badge badge-disabled">Revoked</span>'
          : t.expiresAt && new Date(t.expiresAt) <= new Date()
            ? '<span class="badge badge-decommissioned">Expired</span>'
            : '<span class="badge badge-active">Active</span>';
        var actions = t.revokedAt
          ? '<button class="btn btn-sm btn-danger" onclick="deleteApiToken(\'' + t.id + '\',\'' + escapeHtml(t.name) + '\')">Delete</button>'
          : '<button class="btn btn-sm btn-secondary" onclick="revokeApiToken(\'' + t.id + '\',\'' + escapeHtml(t.name) + '\')">Revoke</button>' +
            '<button class="btn btn-sm btn-danger" onclick="deleteApiToken(\'' + t.id + '\',\'' + escapeHtml(t.name) + '\')">Delete</button>';
        var tokenRole = roleById[t.roleId];
        var roleHtml = '<span class="badge badge-type">' + escapeHtml(t.roleName || "—") + '</span>' +
          (tokenRole && tokenRole.adminEquivalent
            ? '<div style="font-size:0.78rem;color:var(--color-danger,#c0392b)">admin-equivalent</div>'
            : '');
        var intgHtml = (t.integrationIds && t.integrationIds.length)
          ? t.integrationIds.map(function (id) {
              var intg = integrationById[id];
              if (!intg) {
                return '<div><span class="badge badge-type">deleted: ' + escapeHtml(id.slice(0, 8)) + '…</span></div>';
              }
              return '<div><span class="badge badge-type">' + escapeHtml(_integrationLabel(intg)) + '</span>' + _integrationStatusNote(intg) + '</div>';
            }).join("")
          : tokenRole && tokenRole.grantsQuarantineWrite
            ? '<span style="color:var(--color-danger,#c0392b)">none — token cannot push</span>'
            : '<span style="color:var(--color-text-secondary)">n/a</span>';
        return '<tr>' +
          '<td><strong>' + escapeHtml(t.name) + '</strong></td>' +
          '<td class="mono">' + escapeHtml(t.tokenPrefix || "—") + '…</td>' +
          '<td>' + roleHtml + '</td>' +
          '<td style="font-size:0.85rem">' + intgHtml + '</td>' +
          '<td>' + escapeHtml(t.createdBy || "—") + '</td>' +
          '<td>' + (t.lastUsedAt ? formatDate(t.lastUsedAt) + (t.lastUsedIp ? ' <span class="mono" style="font-size:0.78rem;color:var(--color-text-secondary)">(' + escapeHtml(t.lastUsedIp) + ')</span>' : '') : "—") + '</td>' +
          '<td>' + (t.expiresAt ? formatDate(t.expiresAt) : "Never") + '</td>' +
          '<td>' + statusBadge + '</td>' +
          '<td class="actions">' + actions + '</td>' +
        '</tr>';
      }).join("") +
      '</tbody></table></div>'
    : '<p class="empty-state" style="padding:1.5rem 0">No API tokens yet.</p>';

  // Role dropdown — the token acts with this role's permission matrix
  // everywhere in the API. Purpose-built minimal roles (Users → Manage
  // Roles) are the recommended choice; picking an admin-equivalent role
  // surfaces a warning banner (and logs a warning Event server-side).
  var roleOpts = '<option value="">Select a role…</option>' + (roles || []).map(function (r) {
    return '<option value="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) +
      (r.adminEquivalent ? " (admin-equivalent)" : "") + '</option>';
  }).join("");

  // Integration picker — only relevant when the chosen role can push
  // quarantine. Hidden until such a role is selected. Required (server
  // enforces non-empty).
  var integrationPickerHtml;
  if (!quarantineIntegrations || quarantineIntegrations.length === 0) {
    integrationPickerHtml =
      '<div class="alert alert-warning" style="padding:0.6rem 0.75rem;border-radius:6px;background:rgba(214,137,16,0.12);border:1px solid var(--color-warning,#d68910);color:var(--color-text-primary)">' +
        'No FortiManager or FortiGate integrations exist yet. Add one (with Quarantine Push enabled) before minting a token whose role can push quarantine.' +
      '</div>';
  } else {
    integrationPickerHtml = quarantineIntegrations.map(function (intg) {
      return '<label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer;padding:4px 0">' +
        '<input type="checkbox" name="token-integration" value="' + escapeHtml(intg.id) + '" style="margin-top:3px">' +
        '<span><strong>' + escapeHtml(_integrationLabel(intg)) + '</strong>' + _integrationStatusNote(intg) + '</span>' +
      '</label>';
    }).join("");
  }

  container.innerHTML =
    '<div class="settings-section">' +
      '<h3 class="settings-section-title">API Tokens</h3>' +
      '<p style="color:var(--color-text-secondary);margin:0 0 1rem">Bearer tokens for external systems (e.g. SIEM) to call the Polaris API. ' +
        'Each token acts with the permissions of the role it is bound to. ' +
        'The raw token value is shown <strong>once</strong> at creation and cannot be recovered.</p>' +
      '<div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin:0 0 0.35rem">' +
        '<span class="form-label" style="margin:0">Base API URL</span>' +
        '<code class="mono" style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;padding:0.3rem 0.6rem;font-size:0.88rem;user-select:all">' + escapeHtml(effectiveBaseUrl) + '</code>' +
        '<button class="btn btn-sm btn-secondary" id="btn-copy-api-base-url">Copy</button>' +
      '</div>' +
      '<p style="color:var(--color-text-secondary);font-size:0.82rem;margin:0 0 1rem">' +
        'Callers send <code class="mono">Authorization: Bearer &lt;token&gt;</code> against this base, e.g. <code class="mono">' + escapeHtml(effectiveBaseUrl) + '/assets</code>.' +
        (baseUrlIsFallback
          ? ' Derived from this browser’s address — <code class="mono">POLARIS_PUBLIC_URL</code> is not set on the server.'
          : '') +
      '</p>' +
      '<p style="margin:0 0 1rem"><a href="/api" target="_blank" rel="noopener">View API documentation →</a> ' +
        '<span style="color:var(--color-text-secondary);font-size:0.82rem">No login required — reachable only from the networks configured under API Documentation Access below.</span></p>' +
      tableHtml +
    '</div>' +
    '<div class="settings-section" style="margin-top:1.5rem">' +
      '<h4 style="margin:0 0 0.75rem">Create New Token</h4>' +
      '<div style="display:grid;gap:0.75rem;max-width:560px">' +
        '<div>' +
          '<label class="form-label" for="f-token-name">Name <span style="color:var(--color-danger,#c0392b)">*</span></label>' +
          '<input type="text" id="f-token-name" class="form-input" placeholder="e.g. SIEM Quarantine" maxlength="80">' +
        '</div>' +
        '<div>' +
          '<label class="form-label" for="f-token-role">Acts as role <span style="color:var(--color-danger,#c0392b)">*</span></label>' +
          '<select id="f-token-role" class="form-input">' + roleOpts + '</select>' +
          '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin-top:0.3rem">The token can do exactly what this role can. For least privilege, create a purpose-built role under Users → Manage Roles (e.g. assets read-only).</div>' +
          '<div id="f-token-role-warning" class="alert alert-warning" style="display:none;margin-top:0.4rem;padding:0.6rem 0.75rem;border-radius:6px;background:rgba(192,57,43,0.12);border:1px solid var(--color-danger,#c0392b);color:var(--color-text-primary)">' +
            'This role is <strong>admin-equivalent</strong> — anyone holding this token has full control of Polaris. Prefer a minimal role.' +
          '</div>' +
        '</div>' +
        '<div id="f-token-integrations-block" style="display:none">' +
          '<label class="form-label">Integrations <span style="color:var(--color-danger,#c0392b)">*</span></label>' +
          '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.4rem">This token will only be allowed to quarantine via the selected integrations. At least one is required.</div>' +
          '<div style="border:1px solid var(--color-border);border-radius:6px;padding:0.5rem 0.75rem">' + integrationPickerHtml + '</div>' +
        '</div>' +
        '<div>' +
          '<label class="form-label" for="f-token-expires">Expires (optional)</label>' +
          '<input type="datetime-local" id="f-token-expires" class="form-input">' +
        '</div>' +
        '<div><button class="btn btn-primary" id="btn-create-api-token">Create Token</button></div>' +
      '</div>' +
    '</div>' +
    _apiDocsCardHtml(docsAccess);

  document.getElementById("btn-create-api-token").addEventListener("click", createApiToken);
  _wireApiDocsCard(docsAccess);

  document.getElementById("btn-copy-api-base-url").addEventListener("click", async function () {
    try {
      if (!(await copyTextToClipboard(effectiveBaseUrl))) throw new Error("copy failed");
      showToast("Base API URL copied");
    } catch (_) {
      showToast("Copy failed — select the URL text manually", "error");
    }
  });

  // Toggle the integration block + admin warning as the role selection changes.
  var roleSelect = document.getElementById("f-token-role");
  var integrationsBlock = document.getElementById("f-token-integrations-block");
  var roleWarning = document.getElementById("f-token-role-warning");
  if (roleSelect) {
    var sync = function () {
      var r = roleById[roleSelect.value];
      if (integrationsBlock) integrationsBlock.style.display = r && r.grantsQuarantineWrite ? "block" : "none";
      if (roleWarning) roleWarning.style.display = r && r.adminEquivalent ? "block" : "none";
    };
    roleSelect.addEventListener("change", sync);
    sync();
  }
  // Stash for createApiToken's client-side validation.
  _apiTokenRolesById = roleById;
}

var _apiTokenRolesById = {};

// ─── API Documentation Access card ─────────────────────────────────────────
// Who may reach the unauthenticated /api docs page. Three postures only —
// loopback / RFC1918 / custom private subnets — deliberately no "all": the
// server refuses any custom entry outside RFC1918 space, so the widest this
// card can open the page is the private network.

function _apiDocsCardHtml(docsAccess) {
  var head =
    '<div class="settings-section" style="margin-top:1.5rem">' +
      '<h4 style="margin:0 0 0.35rem">API Documentation Access</h4>' +
      '<p style="color:var(--color-text-secondary);font-size:0.82rem;margin:0 0 0.75rem">' +
        'The documentation at <code class="mono">/api</code> is readable without a login, so which networks can reach it is the whole access control. ' +
        'Loopback (the Polaris host itself) is always allowed while the page is enabled; only private (RFC1918) networks can be added.</p>';
  if (docsAccess.error || !docsAccess.apiDocs) {
    return head +
      '<p class="empty-state" style="color:var(--color-danger,#c0392b);padding:0.5rem 0">' +
        escapeHtml(docsAccess.error || "Failed to load API documentation access settings") + '</p>' +
    '</div>';
  }
  var s = docsAccess.apiDocs;
  var scopeRadio = function (value, label, hint) {
    return '<label style="display:flex;align-items:flex-start;gap:6px;cursor:pointer;padding:2px 0">' +
      '<input type="radio" name="docs-ip-scope" value="' + value + '"' + (s.ipScope === value ? ' checked' : '') + ' style="margin-top:3px">' +
      '<span><strong>' + label + '</strong>' +
        '<div style="font-size:0.8rem;color:var(--color-text-secondary)">' + hint + '</div></span>' +
    '</label>';
  };
  return head +
    '<div style="display:grid;gap:0.75rem;max-width:560px">' +
      '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
        '<input type="checkbox" id="docs-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Serve the API documentation page</span>' +
      '</label>' +
      '<div id="docs-scope-block"' + (s.enabled ? '' : ' style="opacity:0.55"') + '>' +
        '<label class="form-label">Allowed source networks</label>' +
        scopeRadio("loopback", "Loopback only", "Only the Polaris host itself (127.0.0.0/8, ::1).") +
        scopeRadio("rfc1918", "RFC1918 private networks + loopback (default)", "Any private source — 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16.") +
        scopeRadio("custom", "Specified private subnets", "Only the networks listed below (plus loopback, always).") +
        '<div id="docs-cidrs-block" style="margin-top:0.4rem' + (s.ipScope === "custom" ? '' : ';display:none') + '">' +
          '<textarea id="docs-allowed-cidrs" class="form-input" rows="3" placeholder="10.20.0.0/16&#10;192.168.5.0/24" spellcheck="false">' +
            escapeHtml((s.allowedCidrs || []).join("\n")) + '</textarea>' +
          '<div style="font-size:0.8rem;color:var(--color-text-secondary);margin-top:0.25rem">One IPv4 network per line, CIDR or bare address. ' +
            '<strong>Must be inside RFC1918 private space</strong> — a public network is refused. Loopback needs no entry.</div>' +
        '</div>' +
      '</div>' +
      '<div style="font-size:0.8rem;color:var(--color-text-secondary)">Polaris sees your address as <code class="mono">' + escapeHtml(docsAccess.callerIp || "unknown") + '</code>. ' +
        'This is Express’ <code class="mono">req.ip</code> under the configured <code class="mono">TRUST_PROXY</code> — if it shows a proxy’s address rather than yours, fix TRUST_PROXY before relying on this scope.</div>' +
      '<div><button class="btn btn-primary" id="btn-save-api-docs">Save Documentation Access</button></div>' +
    '</div>' +
  '</div>';
}

function _wireApiDocsCard(docsAccess) {
  var saveBtn = document.getElementById("btn-save-api-docs");
  if (!saveBtn) return; // error state — nothing to wire
  saveBtn.addEventListener("click", saveApiDocsAccess);
  var cidrsBlock = document.getElementById("docs-cidrs-block");
  document.querySelectorAll('input[name="docs-ip-scope"]').forEach(function (radio) {
    radio.addEventListener("change", function () {
      if (cidrsBlock) cidrsBlock.style.display = radio.value === "custom" && radio.checked ? "" : "none";
    });
  });
  var enabledBox = document.getElementById("docs-enabled");
  var scopeBlock = document.getElementById("docs-scope-block");
  if (enabledBox && scopeBlock) {
    enabledBox.addEventListener("change", function () {
      scopeBlock.style.opacity = enabledBox.checked ? "" : "0.55";
    });
  }
}

async function saveApiDocsAccess() {
  var enabled = !!(document.getElementById("docs-enabled") || {}).checked;
  var scopeInput = document.querySelector('input[name="docs-ip-scope"]:checked');
  var ipScope = scopeInput ? scopeInput.value : "rfc1918";
  var allowedCidrs = ((document.getElementById("docs-allowed-cidrs") || {}).value || "")
    .split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
  if (enabled && ipScope === "custom" && allowedCidrs.length === 0) {
    showToast("Add at least one private network, or pick Loopback only", "error");
    return;
  }
  var btn = document.getElementById("btn-save-api-docs");
  btn.disabled = true;
  try {
    var result = await api.serverSettings.apiDocsPut({ enabled: enabled, ipScope: ipScope, allowedCidrs: allowedCidrs });
    showToast("API documentation access saved");
    if (result.callerAllowed === false) {
      showToast(enabled
        ? "Note: your current address is outside this scope — the docs page will not load from this machine"
        : "The docs page is now disabled for everyone, this machine included", "warning");
    }
    if (result.nginx && result.nginx.attempted && !result.nginx.ok) {
      showToast("nginx sync failed — the app-level gate is still enforcing the new scope. See the Web Server tab.", "warning");
    }
    _apiTokensLoaded = false;
    await loadApiTokensTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  } finally {
    btn.disabled = false;
  }
}

async function createApiToken() {
  var name = (document.getElementById("f-token-name").value || "").trim();
  if (!name) { showToast("Token name is required", "error"); return; }
  var roleId = document.getElementById("f-token-role").value;
  if (!roleId) { showToast("Select a role for the token", "error"); return; }
  var role = _apiTokenRolesById[roleId];
  var integrationIds = Array.from(document.querySelectorAll('input[name="token-integration"]:checked')).map(function (cb) { return cb.value; });
  if (role && role.grantsQuarantineWrite && integrationIds.length === 0) {
    showToast("Pick at least one integration — this role can push quarantine", "error");
    return;
  }
  var expiresAt = document.getElementById("f-token-expires").value;
  var body = { name: name, roleId: roleId };
  if (integrationIds.length) body.integrationIds = integrationIds;
  if (expiresAt) body.expiresAt = new Date(expiresAt).toISOString();

  var btn = document.getElementById("btn-create-api-token");
  btn.disabled = true;
  try {
    var result = await api.apiTokens.create(body);
    // Show the raw token in a modal — the only time the caller ever sees it.
    _showRawTokenModal(result.token.name, result.rawToken);
    _apiTokensLoaded = false;
    await loadApiTokensTab();
  } catch (err) {
    showToast(err.message || "Create failed", "error");
  } finally {
    btn.disabled = false;
  }
}

function _showRawTokenModal(name, rawToken) {
  var body =
    '<p style="margin:0 0 0.75rem">Token <strong>' + escapeHtml(name) + '</strong> created. Copy the token below — it will <strong>never be shown again</strong>.</p>' +
    '<div style="background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;padding:0.75rem;font-family:monospace;font-size:0.9rem;word-break:break-all;user-select:all" id="raw-token-display">' +
      escapeHtml(rawToken) +
    '</div>' +
    '<div style="margin-top:0.75rem">' +
      '<button class="btn btn-secondary" id="btn-copy-raw-token">Copy to clipboard</button>' +
    '</div>';
  openModal("Token Created — Save Now", body,
    '<button class="btn btn-primary" onclick="closeModal()">I have saved it</button>');
  document.getElementById("btn-copy-raw-token").addEventListener("click", async function () {
    try {
      if (!(await copyTextToClipboard(rawToken))) throw new Error("copy failed");
      showToast("Token copied");
    } catch (_) {
      showToast("Copy failed — select the token text manually", "error");
    }
  });
}

async function revokeApiToken(id, name) {
  var ok = await showConfirm('Revoke token "' + name + '"? It will stop working immediately.');
  if (!ok) return;
  try {
    await api.apiTokens.revoke(id);
    showToast('Token "' + name + '" revoked');
    _apiTokensLoaded = false;
    await loadApiTokensTab();
  } catch (err) {
    showToast(err.message || "Revoke failed", "error");
  }
}

async function deleteApiToken(id, name) {
  var ok = await showConfirm('Permanently delete token "' + name + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.apiTokens.delete(id);
    showToast('Token "' + name + '" deleted');
    _apiTokensLoaded = false;
    await loadApiTokensTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

// ────────────────────────────────────────────────────────────────────────
// Slice 6b — Editable Manufacturer Profile card.
// Renders a per-profile expandable list under Identification. Click the
// caret to load + show the full profile (metrics + per-model overrides);
// inline-edit defaults + add/edit/delete overrides. Custom-widget editor
// lives in Slice 7 (where the asset-details Custom MIB tab consumes it);
// for now we just surface the widget count per profile.
// ────────────────────────────────────────────────────────────────────────

var METRIC_KEY_LABELS = {
  cpu:               "CPU",
  memory:            "Memory",
  temperature:       "Hardware Sensors",
  interfaces:        "Interfaces",
  lldp:              "LLDP",
  storage:           "Storage",
  wirelessStations:  "Wireless stations",
};

function manufacturerProfilesCardHTML() {
  var html = '<div class="settings-card">' +
    '<h4>Manufacturer Profiles</h4>' +
    '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
      'Per-manufacturer SNMP telemetry profile — pick which MIB symbol Polaris walks ' +
      'for each System-tab metric, with optional per-model exceptions. Seeded from the ' +
      'built-in vendor profiles on first boot; edits here will take effect once the ' +
      'monitoring resolver swap lands.' +
    '</p>';

  if (_mfgProfiles.length === 0) {
    html += '<p class="empty-state" style="margin-bottom:0.75rem">No manufacturer profiles yet — the seeding job creates one per built-in vendor on first boot.</p>';
  } else {
    html += '<div id="mfg-profiles-list" style="margin-bottom:0.75rem">';
    _mfgProfiles.forEach(function (p) {
      html += renderProfileRow(p);
    });
    html += '</div>';
  }

  // Free-text box with a suggestion dropdown (the .aw-combo idiom, not a
  // <datalist> — most browsers won't open one on click). Any custom name is
  // still accepted; the list only steers toward spellings Polaris already
  // uses, so a new profile actually resolves for the assets that carry it.
  html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
    '<span class="aw-combo aw-combo-dim" style="flex:1;max-width:280px">' +
      '<input type="text" id="f-mfg-profile-add-name" autocomplete="off" placeholder="Manufacturer (e.g. Aruba)">' +
      '<div class="aw-suggest" id="mfg-profile-add-suggest"></div>' +
    '</span>' +
    '<button class="btn btn-primary" id="btn-add-mfg-profile">+ Add Manufacturer</button>' +
  '</div>';

  html += '</div>';
  return html;
}

function renderProfileRow(p) {
  var isOpen = !!_mfgProfileExpanded[p.id];
  var caret = isOpen ? "▼" : "▶";
  var html = '<div class="mfg-profile-row" data-profile-id="' + escapeHtml(p.id) + '" style="border:1px solid var(--color-border);border-radius:4px;margin-bottom:6px;background:var(--color-bg-secondary,rgba(0,0,0,0.04))">' +
    '<div class="mfg-profile-header" style="display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer">' +
      '<span class="mfg-profile-caret" style="font-family:var(--font-mono);font-size:0.75rem;width:14px">' + caret + '</span>' +
      '<span style="font-weight:600;flex:1">' + escapeHtml(p.manufacturer) + '</span>' +
      '<span style="font-size:0.74rem;color:var(--color-text-secondary)">' +
        p.metricCount + ' metric' + (p.metricCount === 1 ? '' : 's') + ' · ' +
        p.overrideCount + ' override' + (p.overrideCount === 1 ? '' : 's') + ' · ' +
        p.widgetCount + ' widget' + (p.widgetCount === 1 ? '' : 's') + ' · ' +
        p.scopedMibCount + ' MIB' + (p.scopedMibCount === 1 ? '' : 's') +
      '</span>' +
      '<button class="btn btn-sm btn-danger mfg-profile-del" data-id="' + escapeHtml(p.id) + '" title="Delete profile">Del</button>' +
    '</div>' +
    '<div class="mfg-profile-body" id="mfg-profile-body-' + escapeHtml(p.id) + '" style="' + (isOpen ? '' : 'display:none') + '">' +
      (isOpen && _mfgProfileDetail[p.id] ? renderProfileDetail(_mfgProfileDetail[p.id]) : (isOpen ? '<p class="empty-state" style="padding:0.75rem">Loading…</p>' : '')) +
    '</div>' +
  '</div>';
  return html;
}

function renderProfileDetail(detail) {
  var html = '<div style="padding:8px 12px 12px;border-top:1px solid var(--color-border)">';
  html += '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:6px">' +
    'Each row is one System-tab metric. The <b>Default</b> column is what Polaris walks for ' +
    'every asset under this profile; per-model exceptions fall under each row.' +
  '</div>';
  html += '<table class="ip-table" style="margin-bottom:8px"><thead><tr>' +
    '<th style="width:8%">Metric</th>' +
    '<th style="width:12%">Model</th>' +
    '<th style="width:18%">MIB</th>' +
    '<th style="width:9%">Type</th>' +
    '<th>Symbol</th>' +
    '<th style="width:12%">Transform</th>' +
    '<th style="width:140px">Action</th>' +
  '</tr></thead><tbody>';

  detail.metrics.forEach(function (m) {
    var editKey = detail.id + ":" + m.metricKey;
    var editing = !!_mfgProfileMetricEdit[editKey];
    html += '<tr data-profile-id="' + escapeHtml(detail.id) + '" data-metric-key="' + escapeHtml(m.metricKey) + '">' +
      '<td><b>' + escapeHtml(METRIC_KEY_LABELS[m.metricKey] || m.metricKey) + '</b></td>' +
      // MODEL column for the default row — "DEFAULT" badge marks the
      // profile-wide entry the resolver falls back to when no per-model
      // override matches. Override rows fill this column with their model
      // pattern instead.
      '<td><span style="font-size:0.74rem;font-weight:600;letter-spacing:0.04em;color:var(--color-text-tertiary)">DEFAULT</span></td>';
    if (editing) {
      // Use the row's current MIB selection (if the operator has changed
      // it during this edit session it lives in the shadow store via the
      // change handler that also pre-warms `_mfgMibSymbolsCache`). For
      // first render fall back to the persisted defaultMibId /
      // defaultMibStdKey (joined into a single combined dropdown value).
      // Check `=== undefined` rather than truthiness so an explicit `""`
      // (operator picked "Built-in seed" to reset) is preserved instead of
      // being clobbered by the persisted value on re-render.
      var storedEditMib = _mfgEditMibId(detail.id, m.metricKey);
      var editMibId = (storedEditMib === undefined)
        ? joinMibSelection(m.defaultMibId, m.defaultMibStdKey)
        : storedEditMib;
      // Column order: MIB · Type · Symbol · Transform. Type picks first so
      // the Symbol cell renders 1 or 2 pickers and the Transform list
      // swaps between unary transforms and binary combiners.
      var editType = _mfgEditTypeFor("metric:" + detail.id + ":" + m.metricKey, m.defaultType);
      html +=
        '<td>' + renderMibSelect(editMibId, "mfg-edit-mib", detail.manufacturer) + '</td>' +
        '<td>' + renderTypeSelect(editType, "mfg-edit-type") + '</td>' +
        '<td>' + _symbolCellEditHTML(editType, editMibId, m.defaultSymbol, m.defaultSymbolB, "mfg-edit-sym") + '</td>' +
        '<td>' + renderTransformSelect(m.defaultTransform, "mfg-edit-transform", editType) + '</td>' +
        '<td><button class="btn btn-sm btn-primary mfg-metric-save">Save</button> ' +
          '<button class="btn btn-sm mfg-metric-cancel">Cancel</button></td>';
    } else {
      var defaultDisplay = _symbolCellViewHTML(m.defaultType, m.defaultSymbol, m.defaultSymbolB);
      // For seed-MIB display, prefer symbol A (the primary OID) so the "MIB"
      // cell still reflects where the bytes-form symbols live.
      var seedMib = m.defaultSymbol ? SEED_SYMBOL_MIB[m.defaultSymbol] : null;
      // Display order: uploaded MIB → operator-pinned std MIB hint → implied
      // seed MIB from the symbol → literal "seed" fallback.
      var stdMibLabel = m.defaultMibStdKey ? STD_MIB_LABELS[m.defaultMibStdKey] : null;
      var mibDisplay = m.defaultMibId
        ? '<span style="font-size:0.78rem">' + escapeHtml(_mfgLookupMibLabel(m.defaultMibId)) + '</span>'
        : (stdMibLabel
            ? '<span style="font-size:0.78rem">' + escapeHtml(stdMibLabel) + '</span>'
            : (seedMib
                ? '<span style="font-size:0.78rem;color:var(--color-text-secondary);font-style:italic">' + escapeHtml(seedMib) + '</span>'
                : '<span style="font-size:0.78rem;color:var(--color-text-tertiary);font-style:italic">seed</span>'));
      var typeLabel = _MFG_TYPE_LABELS[m.defaultType] || m.defaultType;
      html +=
        '<td>' + mibDisplay + '</td>' +
        '<td><span style="font-size:0.78rem">' + escapeHtml(typeLabel) + '</span></td>' +
        '<td>' + defaultDisplay + '</td>' +
        '<td><span style="font-size:0.78rem;color:var(--color-text-secondary)">' + (m.defaultTransform ? escapeHtml(transformLabel(m.defaultTransform)) : "—") + '</span></td>' +
        '<td><button class="btn btn-sm mfg-metric-edit">Edit</button></td>';
    }
    html += '</tr>';

    // Override rows hang under the metric row.
    if (m.overrides && m.overrides.length > 0) {
      m.overrides.forEach(function (o) {
        html += renderOverrideRow(detail.id, m.metricKey, o, detail.manufacturer);
      });
    }
    // Add-override form — single inline row (Model · Symbol · MIB · Type ·
    // Transform · Add) sized so wrap is rare on the typical Identification
    // tab width. Each cell of the parent table gets its own field so the
    // columns line up vertically with the metric row above.
    var newMibId = _mfgNewOverrideMibId(detail.id, m.metricKey) || null;
    // Add-override row layout matches the override view + edit rows:
    //   METRIC (blank) · MODEL (↳ add label + pattern input) · MIB · TYPE · SYMBOL · TRANSFORM · ACTION
    var newPatternCell =
      '<td style="padding-left:20px"><div style="display:flex;align-items:center;gap:4px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.74rem">↳ add</span>' +
        '<input type="text" class="mfg-new-override-pattern" placeholder="Model regex" style="flex:1;font-size:0.78rem">' +
      '</div></td>';
    var newType = _mfgEditTypeFor("new:" + detail.id + ":" + m.metricKey, "scalar");
    html += '<tr class="mfg-add-override-row" data-profile-id="' + escapeHtml(detail.id) + '" data-metric-key="' + escapeHtml(m.metricKey) + '" style="background:var(--color-bg-primary)">' +
      '<td></td>' +
      newPatternCell +
      '<td>' + renderMibSelect(newMibId, "mfg-new-override-mib", detail.manufacturer, true) + '</td>' +
      '<td>' + renderTypeSelect(newType, "mfg-new-override-type") + '</td>' +
      '<td>' + _symbolCellEditHTML(newType, newMibId, "", "", "mfg-new-override-sym") + '</td>' +
      '<td>' + renderTransformSelect(null, "mfg-new-override-transform", newType) + '</td>' +
      '<td><button class="btn btn-sm mfg-override-add">Add</button></td>' +
    '</tr>';
  });
  html += '</tbody></table>';
  // ─── Custom widgets section ──────────────────────────────────────────
  // Each widget here renders on the asset details Custom MIB tab for every
  // asset whose alias-normalized manufacturer matches this profile (and
  // whose model satisfies the optional per-widget gate). Polaris probes
  // each widget on the telemetry cadence; the asset tab reads the latest
  // sample from AssetCustomWidgetSample.
  html += renderWidgetSection(detail);
  html += '</div>';
  return html;
}

// ─── Widget section + per-widget card renderers ────────────────────────
// Cards layout — one per widget — instead of a wide table. The metric
// table already eats most of the horizontal real estate; cramming 8-10
// fields per row here would force wrapping that breaks scan-ability.
// Each card has a compact view mode and an inline-expanded edit mode.

var WIDGET_TYPE_LABELS = {
  gauge: "Gauge", line: "Line chart", table: "Table",
  state: "State (0/1)", http: "HTTP check",
};
var WIDGET_TYPE_ORDER  = ["gauge", "line", "table", "state", "http"];

// ─── State probes (widgetType "state") ──────────────────────────────────
// A status-shaped OID rather than a gauge: an alarm bit, a PSU present flag, a
// fan-tray OK register. The operator declares how a reading becomes true so
// Polaris never has to guess a vendor's polarity (SNMPv2 TruthValue is
// true(1)/false(2), plenty of enums use 2 for the bad state, some agents answer
// strings). Mirrors STATE_MAP_MODES in src/utils/stateProbes.ts — keep in step.
var STATE_MODE_LABELS = {
  nonzero:   "value is not 0  (plain alarm bit)",
  zero:      "value is 0  (inverted / health register)",
  equals:    "value is one of…",
  notEquals: "value is anything EXCEPT…",
  gte:       "value is ≥ …",
  lte:       "value is ≤ …",
};
var STATE_MODE_ORDER = ["nonzero", "zero", "equals", "notEquals", "gte", "lte"];
var STATE_MODES_WITH_VALUES = ["equals", "notEquals", "gte", "lte"];

function renderWidgetSection(detail) {
  var widgets = (detail.widgets || []).slice().sort(function (a, b) {
    if ((a.order || 0) !== (b.order || 0)) return (a.order || 0) - (b.order || 0);
    return (a.name || "").localeCompare(b.name || "");
  });
  var html = '<div style="margin-top:18px">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
      '<h5 style="margin:0;font-size:0.9rem;font-weight:600">Custom widgets</h5>' +
      (_mfgAddingWidget[detail.id]
        ? '<span style="font-size:0.78rem;color:var(--color-text-tertiary)">New widget…</span>'
        : '<button class="btn btn-sm mfg-widget-add-toggle" data-profile-id="' + escapeHtml(detail.id) + '">+ Add widget</button>') +
    '</div>' +
    '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:8px">' +
      'Widgets render on the asset details <b>Custom MIB</b> tab for every asset whose manufacturer matches ' +
      'this profile. Each widget walks its symbol against the chosen MIB on the telemetry cadence.' +
    '</div>';
  if (widgets.length === 0 && !_mfgAddingWidget[detail.id]) {
    html += '<p class="empty-state" style="padding:0.5rem 0;margin:0;font-size:0.82rem">No widgets defined yet.</p>';
  }
  widgets.forEach(function (w) {
    html += renderWidgetCard(detail.id, w, detail.manufacturer);
  });
  if (_mfgAddingWidget[detail.id]) {
    html += renderAddWidgetCard(detail.id, detail.manufacturer);
  }
  html += '</div>';
  return html;
}

function renderWidgetCard(profileId, w, manufacturer) {
  if (_mfgWidgetEdit[w.id]) return renderWidgetEditCard(profileId, w, manufacturer);
  // View mode — single compact card.
  var mibLabel = w.mibId
    ? _mfgLookupMibLabel(w.mibId)
    : '<span style="color:var(--color-text-tertiary);font-style:italic">(no MIB)</span>';
  var modelLabel = w.modelPattern
    ? '<code style="font-size:0.78rem">' + escapeHtml(w.modelPattern) + '</code>'
    : '<span style="color:var(--color-text-tertiary)">any model</span>';
  var transformLabel_ = w.transform ? escapeHtml(transformLabel(w.transform)) : "—";
  var optsLabel = _widgetOptionsSummary(w);
  return '<div class="mfg-widget-card" data-profile-id="' + escapeHtml(profileId) + '" data-widget-id="' + escapeHtml(w.id) + '" style="border:1px solid var(--color-border);border-radius:6px;padding:8px 10px;margin-bottom:6px;background:var(--color-bg-primary)">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">' +
      '<span style="font-weight:600">' + escapeHtml(w.name) + '</span>' +
      '<span style="font-size:0.72rem;color:var(--color-text-tertiary);text-transform:uppercase;letter-spacing:0.04em">' + escapeHtml(WIDGET_TYPE_LABELS[w.widgetType] || w.widgetType) + '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-sm mfg-widget-edit">Edit</button>' +
      ' <button class="btn btn-sm btn-danger mfg-widget-del">Del</button>' +
    '</div>' +
    '<div style="font-size:0.78rem;color:var(--color-text-secondary);display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 12px">' +
      '<span><b>MIB:</b> ' + mibLabel + '</span>' +
      '<span><b>Symbol:</b> <code style="font-size:0.78rem">' + escapeHtml(w.symbol) + '</code> <span style="color:var(--color-text-tertiary)">(' + escapeHtml(w.type) + ')</span></span>' +
      '<span><b>Model:</b> ' + modelLabel + '</span>' +
      '<span><b>Transform:</b> ' + transformLabel_ + '</span>' +
      (w.widgetType === "state"
        ? '<span style="grid-column:1/-1"><b>State:</b> ' + escapeHtml(_stateMapSummary(w.stateMap)) +
          (w.labelSymbol ? ' · rows named by <code style="font-size:0.78rem">' + escapeHtml(w.labelSymbol) + '</code>' : '') + '</span>'
        : (optsLabel ? '<span style="grid-column:1/-1"><b>Display:</b> ' + optsLabel + '</span>' : '')) +
    '</div>' +
  '</div>';
}

/** Plain-English mapping summary for the probe card — mirrors describeStateMap
 *  in src/utils/stateProbes.ts. */
function _stateMapSummary(m) {
  if (!m) return "no mapping";
  var t = m.trueLabel || "Alarm";
  var f = m.falseLabel || "OK";
  var vals = Array.isArray(m.values) ? m.values.join(", ") : "";
  switch (m.mode) {
    case "zero":      return t + " when the value is 0, " + f + " otherwise";
    case "equals":    return t + " when the value is " + vals + ", " + f + " otherwise";
    case "notEquals": return f + " when the value is " + vals + ", " + t + " otherwise";
    case "gte":       return t + " when the value is " + vals + " or more, " + f + " below that";
    case "lte":       return t + " when the value is " + vals + " or less, " + f + " above that";
    default:          return t + " when the value is not 0, " + f + " when it is 0";
  }
}

function renderWidgetEditCard(profileId, w, manufacturer) {
  var key = "widget:" + w.id;
  var storedMib = _mfgWidgetMibFor(key, joinMibSelection(w.mibId, null));
  var storedType = _mfgWidgetTypeFor(key, w.type);
  var storedWidgetType = _mfgWidgetWidgetTypeFor(key, w.widgetType);
  return _renderWidgetFormCard({
    profileId:        profileId,
    formClass:        "mfg-widget-edit-card",
    dataAttrs:        ' data-widget-id="' + escapeHtml(w.id) + '"',
    title:            "Edit widget",
    nameValue:        w.name,
    modelValue:       w.modelPattern || "",
    orderValue:       (w.order != null) ? w.order : 0,
    mibSelected:      storedMib,
    typeSelected:     storedType,
    widgetTypeSelected: storedWidgetType,
    symbolValue:      w.symbol || "",
    transformValue:   w.transform,
    displayOptions:   w.displayOptions || {},
    stateMap:         w.stateMap || null,
    labelSymbol:      w.labelSymbol || "",
    httpCheck:        w.httpCheck || null,
    credentialId:     w.credentialId || "",
    manufacturer:     manufacturer,
    saveBtnClass:     "mfg-widget-save",
    cancelBtnClass:   "mfg-widget-cancel",
    saveBtnLabel:     "Save",
  });
}

function renderAddWidgetCard(profileId, manufacturer) {
  var key = "new-widget:" + profileId;
  var storedMib = _mfgWidgetMibFor(key, "");
  var storedType = _mfgWidgetTypeFor(key, "scalar");
  var storedWidgetType = _mfgWidgetWidgetTypeFor(key, "gauge");
  return _renderWidgetFormCard({
    profileId:        profileId,
    formClass:        "mfg-widget-add-card",
    dataAttrs:        '',
    title:            "New widget",
    nameValue:        "",
    modelValue:       "",
    orderValue:       0,
    mibSelected:      storedMib,
    typeSelected:     storedType,
    widgetTypeSelected: storedWidgetType,
    symbolValue:      "",
    transformValue:   null,
    displayOptions:   {},
    stateMap:         null,
    labelSymbol:      "",
    httpCheck:        null,
    credentialId:     "",
    manufacturer:     manufacturer,
    saveBtnClass:     "mfg-widget-add-save",
    cancelBtnClass:   "mfg-widget-add-cancel",
    saveBtnLabel:     "Add widget",
  });
}

// Shared form renderer for both Edit and Add. Field IDs/classes are the
// same in both modes — the save handler dispatches off the form's outer
// class (mfg-widget-edit-card vs mfg-widget-add-card) instead of unique
// per-field selectors.
function _renderWidgetFormCard(o) {
  var snmpHidden = o.widgetTypeSelected === "http";
  var html = '<div class="' + o.formClass + '" data-profile-id="' + escapeHtml(o.profileId) + '"' + o.dataAttrs + ' style="border:1px solid var(--color-primary,#4fc3f7);border-radius:6px;padding:10px 12px;margin-bottom:6px;background:var(--color-bg-secondary,rgba(127,127,127,0.04))">' +
    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
      '<span style="font-weight:600;font-size:0.85rem">' + escapeHtml(o.title) + '</span>' +
      '<span style="flex:1"></span>' +
      '<button class="btn btn-sm btn-primary ' + o.saveBtnClass + '">' + escapeHtml(o.saveBtnLabel) + '</button>' +
      ' <button class="btn btn-sm ' + o.cancelBtnClass + '">Cancel</button>' +
    '</div>' +
    // Field grid — name + widget-type + MIB + symbol-type + symbol + transform + model + order
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
      _widgetFormField("Name *",
        '<input type="text" class="mfg-widget-name" value="' + escapeHtml(o.nameValue) + '" placeholder="e.g. Connected wireless clients" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Widget type",
        _widgetTypeSelectHTML("mfg-widget-widgettype", o.widgetTypeSelected)) +
      // The SNMP quartet is hidden (not removed) on an http widget: the check
      // names a request, not an OID. Hidden rather than removed so a
      // typed-then-reconsidered symbol survives flipping the type back and
      // forth before save — the same reasoning as the monitor-settings rows.
      _widgetFormField("MIB *",
        renderMibSelect(o.mibSelected, "mfg-widget-mib", o.manufacturer, true), snmpHidden) +
      _widgetFormField("Symbol type",
        renderWidgetTypeSelect(o.typeSelected, "mfg-widget-type"), snmpHidden) +
      _widgetFormField("Symbol *",
        renderSymbolPicker(o.symbolValue, o.mibSelected, "mfg-widget-symbol", o.typeSelected), snmpHidden) +
      _widgetFormField("Transform",
        renderTransformSelect(o.transformValue, "mfg-widget-transform"), snmpHidden) +
      _widgetFormField("Model regex (optional)",
        '<input type="text" class="mfg-widget-model" value="' + escapeHtml(o.modelValue) + '" placeholder="e.g. FortiAP-231F" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Order",
        '<input type="number" class="mfg-widget-order" value="' + escapeHtml(String(o.orderValue)) + '" min="0" step="1" style="width:100%;font-size:0.82rem">') +
    '</div>' +
    // A state probe's second block is its true/false mapping, not display
    // options — the mapping is what makes the probe alertable, so it takes the
    // prominent slot rather than hiding behind a gauge's min/max.
    '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--color-border)">' +
      (o.widgetTypeSelected === "http"
        ? '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">HTTP check</div>' +
          _widgetHttpCheckForm(o.httpCheck, o.credentialId)
        : o.widgetTypeSelected === "state"
        ? '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">State mapping</div>' +
          _widgetStateOptionsForm(o.stateMap, o.labelSymbol, o.typeSelected)
        : '<div style="font-size:0.78rem;font-weight:600;margin-bottom:6px">Display options</div>' +
          _widgetDisplayOptionsForm(o.widgetTypeSelected, o.displayOptions)) +
    '</div>' +
  '</div>';
  return html;
}

/**
 * The state-probe mapping sub-form. Everything here is operator-declared because
 * no part of it can be inferred from the MIB: which raw values mean "bad", what
 * to call the two states, which side is the interesting one, and (for a table)
 * which sibling column names the rows.
 */
function _widgetStateOptionsForm(stateMap, labelSymbol, symbolType) {
  var m = stateMap || {};
  var mode = m.mode || "nonzero";
  var values = Array.isArray(m.values) ? m.values.join(", ") : "";
  var needsValues = STATE_MODES_WITH_VALUES.indexOf(mode) !== -1;
  var modeOpts = STATE_MODE_ORDER.map(function (k) {
    return '<option value="' + k + '"' + (mode === k ? " selected" : "") + '>' + escapeHtml(STATE_MODE_LABELS[k]) + '</option>';
  }).join("");
  return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
    _widgetFormField("True when",
      '<select class="mfg-widget-statemode" style="width:100%;font-size:0.82rem">' + modeOpts + '</select>') +
    _widgetFormField("Comparison value(s)",
      '<input type="text" class="mfg-widget-statevalues" value="' + escapeHtml(values) + '" placeholder="comma-separated, e.g. 2, alarm" style="width:100%;font-size:0.82rem"' +
        (needsValues ? "" : " disabled") + '>') +
    _widgetFormField("Label for the true state",
      '<input type="text" class="mfg-widget-statetrue" value="' + escapeHtml(m.trueLabel || "Alarm") + '" maxlength="32" placeholder="Alarm" style="width:100%;font-size:0.82rem">') +
    _widgetFormField("Label for the false state",
      '<input type="text" class="mfg-widget-statefalse" value="' + escapeHtml(m.falseLabel || "OK") + '" maxlength="32" placeholder="OK" style="width:100%;font-size:0.82rem">') +
    _widgetFormField("Row-name symbol (optional, tables)",
      '<input type="text" class="mfg-widget-labelsymbol" value="' + escapeHtml(labelSymbol || "") + '" placeholder="e.g. fgHwSensorEntName" style="width:100%;font-size:0.82rem"' +
        (symbolType === "table" ? "" : " disabled") + '>') +
    '<label style="display:flex;align-items:center;gap:6px;font-size:0.74rem;color:var(--color-text-secondary)">' +
      '<input type="checkbox" class="mfg-widget-stateproblem"' + (m.trueIsProblem === false ? "" : " checked") + '>' +
      '<span>The true state is the problem</span>' +
    '</label>' +
  '</div>' +
  '<p style="font-size:0.74rem;color:var(--color-text-tertiary);margin:8px 0 0">' +
    'Readings are stored as 0/1 using this mapping, so an automation can alert on the state directly. ' +
    'A table probe produces one independent flag per row — give it a row-name symbol from the same table ' +
    '(joined on the OID index) or rows will only be identifiable by index, which differs per model. ' +
    'A value the mapping can\'t compare is recorded as no reading rather than as healthy.' +
  '</p>';
}

function _widgetFormField(label, controlHTML, hidden) {
  // `hidden` keeps a field in the DOM but out of sight — used for the SNMP
  // quartet on an http widget, which names a request rather than an OID.
  // Hidden rather than omitted so the shadow store still finds the inputs and a
  // typed-then-reconsidered symbol survives flipping the type back and forth
  // before save (the monitor-settings precedent).
  var style = 'display:flex;flex-direction:column;gap:2px;font-size:0.74rem;color:var(--color-text-secondary)';
  if (hidden) style = 'display:none';
  return '<label style="' + style + '">' +
    '<span>' + escapeHtml(label) + '</span>' +
    controlHTML +
  '</label>';
}

/**
 * The HTTP-check sub-form — the check definition that used to live on an `http`
 * credential. It sits on the manufacturer profile because a check varies by
 * vendor AND MODEL (every Axis camera answers the same VAPIX path) while a
 * login varies by vendor or site; keeping both on a credential meant a second
 * path needed a second copy of the same password.
 *
 * "Applies to" is the existing `modelPattern` field in the grid above — blank
 * means every asset of this manufacturer, which is the common case and is why
 * the hint says so rather than leaving an empty box to interpret.
 */
function _widgetHttpCheckForm(check, credentialId) {
  var c = check || {};
  var creds = (_credentialCache.list || []).filter(function (x) { return x.type === "http"; });
  var opts = '<option value="">None — unauthenticated</option>';
  creds.forEach(function (x) {
    opts += '<option value="' + escapeHtml(x.id) + '"' + (credentialId === x.id ? " selected" : "") + '>' + escapeHtml(x.name) + '</option>';
  });
  var mode = c.matchMode === "regex" ? "regex" : "contains";
  return '' +
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 12px">' +
      _widgetFormField("Credential",
        '<select class="mfg-http-cred" style="width:100%;font-size:0.82rem">' + opts + '</select>') +
      _widgetFormField("Path",
        '<input type="text" class="mfg-http-path" value="' + escapeHtml(c.path || "") + '" placeholder="/healthz" style="width:100%;font-size:0.82rem">') +
      // Same opt-in shape as the Test Connection modal: the scheme implies a
      // port, so the field is disabled until an operator says otherwise. A
      // stored port IS a custom port, which is what pre-ticks the box.
      _widgetFormField("Port",
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.8rem;margin-bottom:3px">' +
          '<input type="checkbox" class="mfg-http-customport"' + (c.port ? " checked" : "") + '><span>Custom port</span>' +
        '</label>' +
        '<input type="number" class="mfg-http-port" value="' + escapeHtml(c.port ? String(c.port) : "") + '" min="1" max="65535" ' +
          'placeholder="default (' + (c.useHttps === true ? "443" : "80") + ')" style="width:100%;font-size:0.82rem"' +
          (c.port ? "" : " disabled") + '>') +
      _widgetFormField("Expected status",
        '<input type="number" class="mfg-http-status" value="' + escapeHtml(c.expectStatus ? String(c.expectStatus) : "") + '" min="100" max="599" placeholder="any 2xx" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Match",
        '<select class="mfg-http-matchmode" style="width:100%;font-size:0.82rem">' +
          '<option value="contains"' + (mode === "contains" ? " selected" : "") + '>Contains</option>' +
          '<option value="regex"' + (mode === "regex" ? " selected" : "") + '>Regex</option>' +
        '</select>' +
        '<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:0.8rem;margin-top:4px">' +
          '<input type="checkbox" class="mfg-http-casesensitive"' + (c.caseSensitive === true ? " checked" : "") + '>' +
          '<span>Case sensitive</span>' +
        '</label>') +
      _widgetFormField("Expected content",
        '<input type="text" class="mfg-http-body" value="' + escapeHtml(c.expectBody || "") + '" placeholder="e.g. OK" style="width:100%;font-size:0.82rem">') +
    '</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:12px;margin-top:8px;font-size:0.8rem">' +
      '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" class="mfg-http-https"' + (c.useHttps === true ? " checked" : "") + '><span>Use HTTPS</span></label>' +
      '<label style="display:flex;align-items:center;gap:5px;cursor:pointer"><input type="checkbox" class="mfg-http-verifytls"' + (c.verifyTls === true ? " checked" : "") + '><span>Verify TLS</span></label>' +
    '</div>' +
    '<p class="hint" style="margin-top:8px">Records a pass/fail 0/1 (alertable as <strong>Custom state value</strong>) plus the response time — a wrong status code or missing content is recorded as a failure, and it is an <strong>automation</strong> that decides whether that means the device is down. Leave <strong>Model regex</strong> above blank to check every ' + '' + 'device of this manufacturer. Dial the check in against a real device from <strong>Credentials → Test Connection</strong> first.</p>';
}

/** Collect the HTTP-check sub-form. Blank numbers mean "use the default". */
function _readWidgetHttpCheck(scope) {
  function val(cls) { var el = scope.querySelector(cls); return el ? el.value : ""; }
  function chk(cls) { var el = scope.querySelector(cls); return !!(el && el.checked); }
  function numOrNull(cls) { var v = (val(cls) || "").trim(); return v ? Number(v) : null; }
  return {
    useHttps:       chk(".mfg-http-https"),
    // Un-ticked Custom port sends null, so clearing the override actually
    // returns the check to the scheme default.
    port:           chk(".mfg-http-customport") ? numOrNull(".mfg-http-port") : null,
    path:           (val(".mfg-http-path") || "").trim(),
    expectStatus:   numOrNull(".mfg-http-status"),
    expectBody:     val(".mfg-http-body"),
    matchMode:      val(".mfg-http-matchmode") || "contains",
    caseSensitive:  chk(".mfg-http-casesensitive"),
    verifyTls:      chk(".mfg-http-verifytls"),
  };
}

function _widgetTypeSelectHTML(cls, current) {
  var v = current || "gauge";
  var html = '<select class="' + cls + '" style="width:100%;font-size:0.82rem">';
  WIDGET_TYPE_ORDER.forEach(function (k) {
    html += '<option value="' + k + '"' + (v === k ? " selected" : "") + '>' + escapeHtml(WIDGET_TYPE_LABELS[k]) + '</option>';
  });
  html += '</select>';
  return html;
}

// Per-widgetType displayOptions sub-form. Fields match what the asset
// Custom MIB tab consumes today:
//   gauge → min, max, unit, warningAt (warningAt drives the upcoming
//           threshold band in _renderCustomWidgetGauge)
//   line  → unit
//   table → no operator-tunable options; the renderer derives columns
//           from the latest sample.
function _widgetDisplayOptionsForm(widgetType, opts) {
  var o = opts || {};
  function num(v) { return (v === null || v === undefined) ? "" : String(v); }
  if (widgetType === "gauge") {
    return '<div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px 10px">' +
      _widgetFormField("Min", '<input type="number" class="mfg-widget-opt-min" value="' + escapeHtml(num(o.min)) + '" step="any" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Max", '<input type="number" class="mfg-widget-opt-max" value="' + escapeHtml(num(o.max)) + '" step="any" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Unit", '<input type="text"   class="mfg-widget-opt-unit" value="' + escapeHtml(o.unit || "") + '" placeholder="e.g. % or clients" style="width:100%;font-size:0.82rem">') +
      _widgetFormField("Warning at", '<input type="number" class="mfg-widget-opt-warning" value="' + escapeHtml(num(o.warningAt)) + '" step="any" style="width:100%;font-size:0.82rem">') +
    '</div>';
  }
  if (widgetType === "line") {
    return '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 10px">' +
      _widgetFormField("Unit", '<input type="text" class="mfg-widget-opt-unit" value="' + escapeHtml(o.unit || "") + '" placeholder="e.g. bps or %" style="width:100%;font-size:0.82rem">') +
    '</div>';
  }
  // table — no editable options
  return '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">Table widgets render every column from the latest sample. No display options to configure.</div>';
}

// Compact one-line summary of displayOptions for the view card.
function _widgetOptionsSummary(w) {
  var o = w.displayOptions || {};
  var parts = [];
  if (w.widgetType === "gauge") {
    if (o.min != null) parts.push("min " + o.min);
    if (o.max != null) parts.push("max " + o.max);
    if (o.unit)        parts.push("unit " + o.unit);
    if (o.warningAt != null) parts.push("warn " + o.warningAt);
  } else if (w.widgetType === "line") {
    if (o.unit) parts.push("unit " + o.unit);
  }
  return parts.length ? escapeHtml(parts.join(" · ")) : "";
}

// Read displayOptions back from a form scope (an edit card or add card).
// Empty / non-numeric values are dropped so the stored JSON stays tight.
function _readWidgetDisplayOptions(scope, widgetType) {
  function numOrNull(input) {
    if (!input) return null;
    var s = (input.value || "").trim();
    if (s === "") return null;
    var n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  function strOrNull(input) {
    if (!input) return null;
    var s = (input.value || "").trim();
    return s === "" ? null : s;
  }
  var out = {};
  if (widgetType === "gauge") {
    var min  = numOrNull(scope.querySelector(".mfg-widget-opt-min"));
    var max  = numOrNull(scope.querySelector(".mfg-widget-opt-max"));
    var unit = strOrNull(scope.querySelector(".mfg-widget-opt-unit"));
    var warn = numOrNull(scope.querySelector(".mfg-widget-opt-warning"));
    if (min != null)  out.min = min;
    if (max != null)  out.max = max;
    if (unit)         out.unit = unit;
    if (warn != null) out.warningAt = warn;
  } else if (widgetType === "line") {
    var unitL = strOrNull(scope.querySelector(".mfg-widget-opt-unit"));
    if (unitL) out.unit = unitL;
  }
  return out;
}

function renderOverrideRow(profileId, metricKey, o, manufacturer) {
  var editing = !!_mfgProfileOverrideEdit[o.id];
  // Override rows leave the METRIC column blank (the default row above
  // already names the metric). The MODEL column carries the override's
  // identity — the regex literal in view mode, a Model regex input in
  // edit mode. The leading ↳ visually nests the row under its default.
  var head = '<tr class="mfg-override-row" data-profile-id="' + escapeHtml(profileId) +
    '" data-metric-key="' + escapeHtml(metricKey) +
    '" data-override-id="' + escapeHtml(o.id) + '" style="background:var(--color-bg-primary)">' +
    '<td></td>';
  if (editing) {
    var oMibId = _mfgOverrideEditMibId(o.id);
    if (oMibId === undefined) oMibId = joinMibSelection(o.mibId, o.mibStdKey); // first render: persisted value
    // Column order matches the metric default row above:
    //   METRIC (blank) · MODEL (↳ pattern input) · MIB · TYPE · SYMBOL · TRANSFORM · ACTION
    var patternCell =
      '<td style="padding-left:20px"><div style="display:flex;align-items:center;gap:4px">' +
        '<span style="color:var(--color-text-tertiary);font-size:0.78rem">↳</span>' +
        '<input type="text" class="mfg-edit-override-pattern" value="' + escapeHtml(o.modelPattern) + '" placeholder="Model regex" style="flex:1;font-size:0.78rem">' +
      '</div></td>';
    var oEditType = _mfgEditTypeFor("override:" + o.id, o.type);
    return head +
      patternCell +
      '<td>' + renderMibSelect(oMibId, "mfg-edit-override-mib", manufacturer) + '</td>' +
      '<td>' + renderTypeSelect(oEditType, "mfg-edit-override-type") + '</td>' +
      '<td>' + _symbolCellEditHTML(oEditType, oMibId, o.symbol, o.symbolB, "mfg-edit-override-sym") + '</td>' +
      '<td>' + renderTransformSelect(o.transform, "mfg-edit-override-transform", oEditType) + '</td>' +
      '<td><button class="btn btn-sm btn-primary mfg-override-save">Save</button> ' +
        '<button class="btn btn-sm mfg-override-cancel">Cancel</button></td>' +
    '</tr>';
  }
  var seedMibO = o.symbol ? SEED_SYMBOL_MIB[o.symbol] : null;
  var stdMibLabelO = o.mibStdKey ? STD_MIB_LABELS[o.mibStdKey] : null;
  var mibLabel = o.mibId
    ? escapeHtml(_mfgLookupMibLabel(o.mibId))
    : (stdMibLabelO
        ? escapeHtml(stdMibLabelO)
        : (seedMibO
            ? '<span style="color:var(--color-text-secondary);font-style:italic">' + escapeHtml(seedMibO) + '</span>'
            : '<span style="color:var(--color-text-tertiary);font-style:italic">seed</span>'));
  // MODEL column carries the regex literal (e.g. "FortiSwitch") with a
  // leading ↳ to nest it visually under its default row above.
  var modelCell =
    '<td style="padding-left:20px"><span style="color:var(--color-text-tertiary);font-size:0.78rem">↳</span> ' +
      '<code style="font-size:0.8rem">' + escapeHtml(o.modelPattern) + '</code>' +
    '</td>';
  var typeLabelO = _MFG_TYPE_LABELS[o.type] || o.type;
  return head +
    modelCell +
    '<td><span style="font-size:0.78rem">' + mibLabel + '</span></td>' +
    '<td><span style="font-size:0.78rem">' + escapeHtml(typeLabelO) + '</span></td>' +
    '<td>' + _symbolCellViewHTML(o.type, o.symbol, o.symbolB) + '</td>' +
    '<td><span style="font-size:0.78rem;color:var(--color-text-secondary)">' + (o.transform ? escapeHtml(transformLabel(o.transform)) : "—") + '</span></td>' +
    '<td><button class="btn btn-sm mfg-override-edit">Edit</button> ' +
      '<button class="btn btn-sm btn-danger mfg-override-del">Del</button></td>' +
  '</tr>';
}

// Standard MIB hints the operator can pin on a metric row or override.
// Keys mirror `_SNMP_STANDARD_MIBS` in `public/js/assets.js` (the SNMP Walk
// dropdown) and the `STD_MIB_KEYS` set in `manufacturerProfileService.ts`.
// `std:fortinet` deliberately omitted — vendor MIBs belong in the Uploaded
// MIBs section, not the Standard MIBs optgroup.
var STD_MIB_LABELS = {
  "std:system":         "System (RFC 1213)",
  "std:interfaces":     "Interfaces — ifTable (RFC 2863)",
  "std:if-ext":         "Interfaces — ifXTable, 64-bit counters (RFC 2863)",
  "std:host-resources": "HOST-RESOURCES-MIB (RFC 2790)",
  "std:entity":         "ENTITY-MIB (RFC 4133)",
  "std:entity-sensor":  "ENTITY-SENSOR-MIB (RFC 3433)",
  "std:lldp":           "LLDP-MIB (IEEE 802.1AB)",
  "std:poe":            "PoE — POWER-ETHERNET-MIB (RFC 3621)",
  "std:bridge":         "Bridge — MAC forwarding + STP (RFC 4188)",
  "std:q-bridge":       "Bridge — VLAN-aware forwarding (RFC 4363)",
  "std:rstp":           "Rapid Spanning Tree (RFC 4318)",
};
var STD_MIB_ORDER = ["std:system", "std:interfaces", "std:if-ext", "std:host-resources", "std:entity", "std:entity-sensor", "std:lldp", "std:poe", "std:bridge", "std:q-bridge", "std:rstp"];

// Splits a single dropdown value into the {mibId, mibStdKey} pair the
// backend expects. The dropdown carries one combined string ("" = built-in
// seed, "std:*" = standard MIB hint, otherwise a UUID = uploaded MIB) so
// the operator only has to pick once.
function splitMibSelection(value) {
  if (!value) return { mibId: null, mibStdKey: null };
  if (value.indexOf("std:") === 0) return { mibId: null, mibStdKey: value };
  return { mibId: value, mibStdKey: null };
}

// Inverse of splitMibSelection — turns the persisted pair into the single
// string the dropdown's <option value=…> expects. Std key wins when both
// are non-null (defensive — the backend rejects that combination).
function joinMibSelection(mibId, mibStdKey) {
  if (mibStdKey) return mibStdKey;
  if (mibId)     return mibId;
  return "";
}

// Built-in seed symbols → originating MIB module name. The values mirror
// the seeded OIDs in `src/services/oidRegistry.ts`'s BUILT_IN_OIDS table:
// each entry is a hardcoded OID Polaris ships so the probe works without
// the MIB being uploaded, but the MIB name is still the operator-meaningful
// label for "where does this symbol come from."
var SEED_SYMBOL_MIB = {
  cpmCPUTotal5secRev:        "CISCO-PROCESS-MIB",
  ciscoMemoryPoolUsed:       "CISCO-MEMORY-POOL-MIB",
  ciscoMemoryPoolFree:       "CISCO-MEMORY-POOL-MIB",
  jnxOperatingCPU:           "JUNIPER-MIB",
  jnxOperatingBuffer:        "JUNIPER-MIB",
  hpSwitchCpuStat:           "STATISTICS-MIB",
  fgSysCpuUsage:             "FORTINET-FORTIGATE-MIB",
  fgSysMemUsage:             "FORTINET-FORTIGATE-MIB",
  fsSysCpuUsage:             "FORTINET-FORTISWITCH-MIB",
  fsSysMemUsage:             "FORTINET-FORTISWITCH-MIB",
  fsSysMemCapacity:          "FORTINET-FORTISWITCH-MIB",
  fsSysDiskUsage:            "FORTINET-FORTISWITCH-MIB",
  fsSysDiskCapacity:         "FORTINET-FORTISWITCH-MIB",
  fapCpuUsage:               "FORTINET-FORTIAP-MIB",
  fapMemoryUsage:            "FORTINET-FORTIAP-MIB",
  fapTemperature:            "FORTINET-FORTIAP-MIB",
  rlCpuUtilDuringLastMinute: "RADLAN-MIB",
};

// Map a MibFile.id back to its module name (or a short fallback) for the
// MIB column. Reads the same `_mibsData` cache the dropdown is populated
// from, so a freshly uploaded MIB shows up immediately on next render.
function _mfgLookupMibLabel(mibId) {
  for (var i = 0; i < _mibsData.length; i++) {
    if (_mibsData[i].id === mibId) {
      return _mibsData[i].moduleName || _mibsData[i].filename || "(MIB)";
    }
  }
  return "(deleted MIB)";
}

// Metric-row Type select: scalar | double_scalar | table.
function renderTypeSelect(current, cls) {
  return _typeSelectHTML(cls, current, ["scalar", "double_scalar", "table"]);
}
// Custom-widget Symbol-Type select: scalar | table only (widget renderer
// has no combiner support).
function renderWidgetTypeSelect(current, cls) {
  return _typeSelectHTML(cls, current, ["scalar", "table"]);
}

// Transform / Combiner select. `type` decides which list to render:
//   "double_scalar" → binary combiners (CombinerKind on the backend)
//   anything else   → unary transforms (TransformKind)
function renderTransformSelect(current, cls, type) {
  var list = type === "double_scalar" ? _mfgProfileCombiners : _mfgProfileTransforms;
  var html = '<select class="' + cls + '" style="font-size:0.78rem">' +
    '<option value="">— none —</option>';
  list.forEach(function (t) {
    html += '<option value="' + escapeHtml(t.kind) + '"' + (current === t.kind ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
  });
  html += '</select>';
  return html;
}

// Symbol picker that depends on the MIB selection. When mibId is empty
// (= "Built-in seed"), Polaris doesn't have a symbol list to draw from
// — every seeded symbol lives in oidRegistry without an enumerable
// directory. So we fall through to a free-text input the operator types
// into. When mibId is set AND the structure has been fetched + cached,
// we render a `<select>` populated with that MIB's readable symbol
// names. While the structure is in flight we render a disabled select
// with "Loading…" so the operator sees the chain react.
function renderSymbolPicker(currentSymbol, mibId, cls, type) {
  // Standard-MIB picks (std:*) and "Built-in seed" (empty) both fall back
  // to free-text — there's no enumerable symbol directory on the frontend
  // for those, since the seeded OIDs live in oidRegistry without a parsed
  // structure document the picker can walk.
  if (!mibId || (typeof mibId === "string" && mibId.indexOf("std:") === 0)) {
    return '<input type="text" class="' + cls + '" value="' + escapeHtml(currentSymbol || "") +
      '" placeholder="Symbol (e.g. fgSysCpuUsage)" style="width:100%;font-size:0.78rem">';
  }
  var entry = _mfgMibSymbolsCache[mibId];
  if (!entry || entry.loading) {
    // Fire the fetch (idempotent) and render a placeholder. The change
    // listener that triggered this re-render kicks off the load; once
    // it completes the helper re-renders the tab and the dropdown
    // populates.
    _ensureMibSymbols(mibId);
    return '<select class="' + cls + '" disabled style="width:100%;font-size:0.78rem">' +
      '<option>Loading symbols…</option>' +
    '</select>';
  }
  // Pick which side of the split to surface. `type === "table"` shows the
  // table-row OIDs (each one walks to a 2D result); anything else (scalar
  // is the default) shows the scalar/leaf symbols. Memory's multi-OID
  // picker still passes no type and gets the scalars list, matching its
  // pre-split behaviour.
  var names = (type === "table") ? (entry.tables || []) : (entry.scalars || []);
  var html = '<select class="' + cls + '" style="width:100%;font-size:0.78rem">' +
    '<option value="">— select —</option>';
  // Defensive: if the current value isn't in the chosen list (e.g. operator
  // had a table symbol selected and flipped Type to scalar) still surface it
  // as a selected option so the form save round-trips cleanly while the
  // operator decides whether to switch.
  if (currentSymbol && names.indexOf(currentSymbol) === -1) {
    html += '<option value="' + escapeHtml(currentSymbol) + '" selected>' +
      escapeHtml(currentSymbol) + ' (not a ' + escapeHtml(type === "table" ? "table" : "scalar") + ')' +
    '</option>';
  }
  names.forEach(function (name) {
    html += '<option value="' + escapeHtml(name) + '"' +
      (currentSymbol === name ? " selected" : "") + '>' +
      escapeHtml(name) +
    '</option>';
  });
  // (The "not a scalar"/"not a table" pre-pended option above already
  // preserves any current value that isn't in the chosen list.)
  html += '</select>';
  return html;
}

// Lazy-fetch + cache one MIB's symbol list, split into `tables` vs
// `scalars` so the per-row Symbol picker can populate from whichever
// list matches the operator's chosen Type. Mirrors the Browse modal's
// split: tables come from `struct.tables[]`, scalars are every other
// symbol that isn't a table column, table row, or table name.
// Re-render happens once the fetch resolves so the disabled "Loading…"
// state in the picker swaps to the populated dropdown.
function _ensureMibSymbols(mibId) {
  if (!mibId) return;
  // Std-MIB hints are display-only — no MibFile row exists to fetch a
  // structure from. Skip the network call.
  if (typeof mibId === "string" && mibId.indexOf("std:") === 0) return;
  if (_mfgMibSymbolsCache[mibId] && !_mfgMibSymbolsCache[mibId].loading) return;
  if (_mfgMibSymbolsCache[mibId] && _mfgMibSymbolsCache[mibId].loading) return; // already in flight
  _mfgMibSymbolsCache[mibId] = { loading: true, scalars: [], tables: [] };
  api.serverSettings.getMibStructure(mibId).then(function (struct) {
    var tables = (struct.tables || []).map(function (t) { return t.name; }).filter(Boolean);
    // Build "everything that isn't a table-related symbol" for the scalar list.
    var tableColumns = new Set();
    var tableRows    = new Set();
    var tableNames   = new Set(tables);
    (struct.tables || []).forEach(function (t) {
      if (t.rowSymbol) tableRows.add(t.rowSymbol);
      (t.columns || []).forEach(function (c) { tableColumns.add(c); });
    });
    var scalars = (struct.symbols || [])
      .map(function (s) { return s.name; })
      .filter(function (n) {
        return n && !tableColumns.has(n) && !tableRows.has(n) && !tableNames.has(n);
      });
    // De-dupe + sort so both dropdowns are predictable.
    tables  = Array.from(new Set(tables)).sort(function (a, b) { return a.localeCompare(b); });
    scalars = Array.from(new Set(scalars)).sort(function (a, b) { return a.localeCompare(b); });
    _mfgMibSymbolsCache[mibId] = { loading: false, scalars: scalars, tables: tables };
    // Preserving, not bare: this lands after the picking handler's own restore,
    // so a bare re-render re-erases everything the operator typed.
    _mfgRerenderPreservingAll();
  }).catch(function (err) {
    _mfgMibSymbolsCache[mibId] = { loading: false, scalars: [], tables: [] };
    showToast(err.message || "Failed to load MIB symbols", "error");
    _mfgRerenderPreservingAll();
  });
}

// Dropdown of MIBs available to symbol resolution at this manufacturer's
// scope. Three groups, in order:
//   1) Standard MIBs (RFC / IEEE specs Polaris ships seeded OIDs for) — the
//      `std:*` keys. Display-only at probe time; the value persists into
//      `defaultMibStdKey` so the MIB column shows a meaningful label.
//   2) Vendor MIBs — uploaded MIBs whose `manufacturer` matches this profile
//      (case-insensitive). Mirrors `oidRegistry`'s vendor-scope pass.
//   3) Generic MIBs — uploaded MIBs with `manufacturer = null`. The
//      resolver consults these at the generic tier for every vendor.
//
// `currentSelection` is the combined dropdown value (see joinMibSelection):
// "" = built-in seed, "std:*" = standard MIB key, UUID = uploaded MIB.
// `omitSeed=true` hides the "Built-in seed" placeholder so the add-row
// dropdown shows only real options (an empty-on-submit value still
// round-trips to mibId=null on the server side).
function renderMibSelect(currentSelection, cls, manufacturer, omitSeed) {
  var current = currentSelection || "";
  var mfg = (manufacturer || "").toLowerCase();
  var vendorScoped = (_mibsData || []).filter(function (m) {
    return (m.manufacturer || "").toLowerCase() === mfg;
  });
  var generic = (_mibsData || []).filter(function (m) {
    return !m.manufacturer;
  });
  var html = '<select class="' + cls + '" style="font-size:0.78rem">';
  if (omitSeed) {
    if (!current) {
      html += '<option value="" selected disabled>— select MIB —</option>';
    }
  } else {
    html += '<option value=""' + (!current ? " selected" : "") + '>Built-in seed</option>';
  }
  // Standard MIBs optgroup
  html += '<optgroup label="Standard MIBs">';
  STD_MIB_ORDER.forEach(function (key) {
    html += '<option value="' + escapeHtml(key) + '"' +
      (current === key ? " selected" : "") + '>' +
      escapeHtml(STD_MIB_LABELS[key]) +
    '</option>';
  });
  html += '</optgroup>';
  // Vendor MIBs optgroup (only when this profile has any vendor-scoped uploads)
  if (vendorScoped.length) {
    html += '<optgroup label="Vendor MIBs">';
    vendorScoped.forEach(function (m) {
      var label = m.moduleName || m.filename || m.id;
      if (m.model) label += " (" + m.model + ")";
      html += '<option value="' + escapeHtml(m.id) + '"' +
        (current === m.id ? " selected" : "") + '>' +
        escapeHtml(label) +
      '</option>';
    });
    html += '</optgroup>';
  }
  // Generic MIBs optgroup (only when at least one uploaded MIB has no manufacturer)
  if (generic.length) {
    html += '<optgroup label="Generic MIBs">';
    generic.forEach(function (m) {
      var label = m.moduleName || m.filename || m.id;
      html += '<option value="' + escapeHtml(m.id) + '"' +
        (current === m.id ? " selected" : "") + '>' +
        escapeHtml(label) +
      '</option>';
    });
    html += '</optgroup>';
  }
  html += '</select>';
  return html;
}

function transformLabel(kind) {
  for (var i = 0; i < _mfgProfileTransforms.length; i++) {
    if (_mfgProfileTransforms[i].kind === kind) return _mfgProfileTransforms[i].label;
  }
  // Fall through to combiners (double_scalar) — same lookup pattern; same
  // result if the kind isn't a recognized combiner either.
  for (var j = 0; j < _mfgProfileCombiners.length; j++) {
    if (_mfgProfileCombiners[j].kind === kind) return _mfgProfileCombiners[j].label;
  }
  return kind;
}

function wireManufacturerProfileControls() {
  var addBtn = document.getElementById("btn-add-mfg-profile");
  if (addBtn) addBtn.addEventListener("click", addManufacturerProfile);

  wireManufacturerSuggestCombo();

  var list = document.getElementById("mfg-profiles-list");
  if (!list) return;

  // Delegated click handler — one listener covers every row, every edit
  // button, every save/cancel, override add/delete, profile delete.
  list.addEventListener("click", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    var delBtn = target.closest(".mfg-profile-del");
    if (delBtn) { e.stopPropagation(); return deleteManufacturerProfile(delBtn.getAttribute("data-id")); }

    var header = target.closest(".mfg-profile-header");
    if (header) return toggleProfileExpand(header.parentElement.getAttribute("data-profile-id"));

    var editBtn = target.closest(".mfg-metric-edit");
    if (editBtn) return beginMetricEdit(editBtn.closest("tr"));

    var saveBtn = target.closest(".mfg-metric-save");
    if (saveBtn) return saveMetricEdit(saveBtn.closest("tr"));

    var cancelBtn = target.closest(".mfg-metric-cancel");
    if (cancelBtn) return cancelMetricEdit(cancelBtn.closest("tr"));

    var addOverBtn = target.closest(".mfg-override-add");
    if (addOverBtn) return addOverride(addOverBtn.closest("tr"));

    var delOverBtn = target.closest(".mfg-override-del");
    if (delOverBtn) return deleteOverride(delOverBtn.closest("tr"));

    var editOverBtn = target.closest(".mfg-override-edit");
    if (editOverBtn) return beginOverrideEdit(editOverBtn.closest("tr"));

    var saveOverBtn = target.closest(".mfg-override-save");
    if (saveOverBtn) return saveOverrideEdit(saveOverBtn.closest("tr"));

    var cancelOverBtn = target.closest(".mfg-override-cancel");
    if (cancelOverBtn) return cancelOverrideEdit(cancelOverBtn.closest("tr"));

    // ─── Widget click handlers ─────────────────────────────────────────
    var addWidgetToggleBtn = target.closest(".mfg-widget-add-toggle");
    if (addWidgetToggleBtn) {
      var pidAdd = addWidgetToggleBtn.getAttribute("data-profile-id");
      _mfgAddingWidget[pidAdd] = true;
      renderIdentificationTab();
      return;
    }
    var widgetEditBtn = target.closest(".mfg-widget-edit");
    if (widgetEditBtn) {
      var cardEdit = widgetEditBtn.closest(".mfg-widget-card");
      if (cardEdit) {
        _mfgWidgetEdit[cardEdit.getAttribute("data-widget-id")] = true;
        renderIdentificationTab();
      }
      return;
    }
    var widgetSaveBtn = target.closest(".mfg-widget-save");
    if (widgetSaveBtn) return saveWidgetEdit(widgetSaveBtn.closest(".mfg-widget-edit-card"));
    var widgetCancelBtn = target.closest(".mfg-widget-cancel");
    if (widgetCancelBtn) {
      var cardC = widgetCancelBtn.closest(".mfg-widget-edit-card");
      if (cardC) {
        var wid = cardC.getAttribute("data-widget-id");
        delete _mfgWidgetEdit[wid];
        _mfgWidgetClearShadow("widget:" + wid);
        renderIdentificationTab();
      }
      return;
    }
    var widgetAddSaveBtn = target.closest(".mfg-widget-add-save");
    if (widgetAddSaveBtn) return saveNewWidget(widgetAddSaveBtn.closest(".mfg-widget-add-card"));
    var widgetAddCancelBtn = target.closest(".mfg-widget-add-cancel");
    if (widgetAddCancelBtn) {
      var cardAC = widgetAddCancelBtn.closest(".mfg-widget-add-card");
      if (cardAC) {
        var pidAC = cardAC.getAttribute("data-profile-id");
        delete _mfgAddingWidget[pidAC];
        _mfgWidgetClearShadow("new-widget:" + pidAC);
        renderIdentificationTab();
      }
      return;
    }
    var widgetDelBtn = target.closest(".mfg-widget-del");
    if (widgetDelBtn) {
      var cardDel = widgetDelBtn.closest(".mfg-widget-card");
      if (cardDel) return deleteWidget(cardDel.getAttribute("data-profile-id"), cardDel.getAttribute("data-widget-id"));
      return;
    }
  });

  // The chained MIB → Symbol pickers need a `change` listener separate
  // from the click delegation above. When the operator changes any of
  // the three MIB selects in this card, stash the new value into the
  // edit-state map and re-render so the symbol picker swaps from text
  // input (seed) to dropdown (MIB-driven), or to a different MIB's symbol
  // list. _ensureMibSymbols pre-warms the cache so the dropdown is ready.
  list.addEventListener("change", function (e) {
    var target = e.target;
    if (!(target instanceof Element)) return;

    if (target.classList.contains("mfg-edit-mib")) {
      var tr = target.closest("tr");
      if (!tr) return;
      var key = "metric:" + tr.getAttribute("data-profile-id") + ":" + tr.getAttribute("data-metric-key");
      _mfgEditMibSelections[key] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-edit-override-mib")) {
      var tr2 = target.closest("tr");
      if (!tr2) return;
      _mfgEditMibSelections["override:" + tr2.getAttribute("data-override-id")] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-new-override-mib")) {
      var tr3 = target.closest("tr");
      if (!tr3) return;
      _mfgEditMibSelections["new:" + tr3.getAttribute("data-profile-id") + ":" + tr3.getAttribute("data-metric-key")] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    // Type selectors — flipping scalar / double_scalar / table re-renders
    // both the Symbol cell (1 or 2 pickers) AND the Transform select (unary
    // transforms vs binary combiners). Three flavours: metric-row edit,
    // override-row edit, add-override row.
    if (target.classList.contains("mfg-edit-type")) {
      var trType = target.closest("tr");
      if (!trType) return;
      _mfgEditTypeSelections["metric:" + trType.getAttribute("data-profile-id") + ":" + trType.getAttribute("data-metric-key")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-edit-override-type")) {
      var trTypeOv = target.closest("tr");
      if (!trTypeOv) return;
      _mfgEditTypeSelections["override:" + trTypeOv.getAttribute("data-override-id")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-new-override-type")) {
      var trTypeNew = target.closest("tr");
      if (!trTypeNew) return;
      _mfgEditTypeSelections["new:" + trTypeNew.getAttribute("data-profile-id") + ":" + trTypeNew.getAttribute("data-metric-key")] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    // ─── Widget MIB / Type / WidgetType selects ───────────────────────
    // The widget card hosts THREE chained selects (MIB → symbol Type →
    // Symbol picker; plus a parallel WidgetType select that drives the
    // displayOptions sub-form). They share these class names with the
    // metric-row controls, so first resolve which card they live in
    // before falling through to the metric handlers above… actually
    // the widget-card classes are unique (mfg-widget-mib etc.) so this
    // is straight-through.
    // State-probe mode: only some modes take comparison values. Toggled IN PLACE
    // rather than through renderIdentificationTab() — a re-render rebuilds the
    // card from the stored widget, which would discard whatever the operator has
    // typed into the other mapping fields.
    if (target.classList.contains("mfg-widget-statemode")) {
      var cardSM = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardSM) return;
      var valsEl = cardSM.querySelector(".mfg-widget-statevalues");
      if (valsEl) valsEl.disabled = STATE_MODES_WITH_VALUES.indexOf(target.value) === -1;
      return;
    }
    if (target.classList.contains("mfg-widget-mib")) {
      var cardWM = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWM) return;
      var keyWM = _widgetCardKey(cardWM);
      _mfgWidgetEditMib[keyWM] = target.value || "";
      if (target.value) _ensureMibSymbols(target.value);
      _mfgRerenderPreserving(target);
      return;
    }
    if (target.classList.contains("mfg-widget-type")) {
      var cardWT = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWT) return;
      _mfgWidgetEditType[_widgetCardKey(cardWT)] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
    // Port controls on an http widget. Handled here rather than by a re-render
    // because nothing about the payload changes — only whether the field is
    // editable and which default its placeholder names.
    if (target.classList.contains("mfg-http-customport") || target.classList.contains("mfg-http-https")) {
      var cardHP = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardHP) return;
      var cpBox = cardHP.querySelector(".mfg-http-customport");
      var tlsBox = cardHP.querySelector(".mfg-http-https");
      var pInput = cardHP.querySelector(".mfg-http-port");
      if (cpBox && pInput) {
        pInput.disabled = !cpBox.checked;
        pInput.style.opacity = cpBox.checked ? "" : "0.5";
        pInput.placeholder = "default (" + (tlsBox && tlsBox.checked ? "443" : "80") + ")";
      }
      return;
    }
    if (target.classList.contains("mfg-widget-widgettype")) {
      var cardWWT = target.closest(".mfg-widget-edit-card, .mfg-widget-add-card");
      if (!cardWWT) return;
      _mfgWidgetEditWidgetType[_widgetCardKey(cardWWT)] = target.value;
      _mfgRerenderPreserving(target);
      return;
    }
  });
}

// Derive the widget-shadow-store key from an edit or add card element.
function _widgetCardKey(cardEl) {
  if (!cardEl) return "";
  if (cardEl.classList.contains("mfg-widget-edit-card")) {
    return "widget:" + cardEl.getAttribute("data-widget-id");
  }
  return "new-widget:" + cardEl.getAttribute("data-profile-id");
}

// ─── Preserving typed input across a chained-select re-render ───────────────
//
// The MIB / symbol-type / widget-type selects are chained: changing one changes
// what the dependent controls offer (Symbol comes from the MIB, the sub-form
// from the widget type), so each handler re-renders. But the re-render rebuilds
// every row and card from STORED state, and the only things carried across were
// the three selects themselves — so an operator who typed a Name and then
// picked a MIB watched the Name vanish. Every field was affected, on the metric
// rows and override rows as much as the widget card.
//
// Rather than a shadow store per field (nine handlers × a growing set of
// fields), snapshot the editing container's live control values, re-render, then
// write them back. Keyed on the same identity the handlers already use, so the
// values can't land in a different row. A `<select>` whose options changed drops
// a value the new list doesn't offer — which is what should happen to a Symbol
// after its MIB is swapped.

/** The editing container an element belongs to (widget card or table row). */
function _mfgEditContainerOf(el) {
  if (!el || !el.closest) return null;
  return el.closest(".mfg-widget-edit-card, .mfg-widget-add-card, tr");
}

/** Stable identity for a container, matching the handlers' shadow-store keys so
 *  a snapshot is restored into the same row it came from. */
function _mfgEditContainerKey(container) {
  if (!container) return "";
  if (container.classList.contains("mfg-widget-edit-card") ||
      container.classList.contains("mfg-widget-add-card")) {
    return _widgetCardKey(container);
  }
  var ovr = container.getAttribute("data-override-id");
  if (ovr) return "override:" + ovr;
  var pid = container.getAttribute("data-profile-id");
  var mk = container.getAttribute("data-metric-key");
  if (!pid || !mk) return "";
  // A metric row and the "add override" row beneath it share profile+metricKey;
  // the controls each one owns are what tell them apart.
  var isNew = !!container.querySelector(".mfg-new-override-mib, .mfg-new-override-type, .mfg-new-override-symbol");
  return (isNew ? "new:" : "metric:") + pid + ":" + mk;
}

/** The field's snapshot key — its own `mfg-*` class, which is unique per
 *  control within a container. */
function _mfgFieldKey(el) {
  var cls = (el.className || "").split(/\s+/);
  for (var i = 0; i < cls.length; i++) {
    if (cls[i].indexOf("mfg-") === 0) return cls[i];
  }
  return "";
}

function _mfgSnapshotFields(container) {
  var vals = {};
  if (!container) return vals;
  container.querySelectorAll("input, select, textarea").forEach(function (el) {
    var key = _mfgFieldKey(el);
    if (!key) return;
    vals[key] = (el.type === "checkbox" || el.type === "radio") ? el.checked : el.value;
  });
  return vals;
}

/**
 * Re-render the Identification tab without losing what the operator has typed
 * into the row/card that triggered it. Use this instead of a bare
 * renderIdentificationTab() from any chained-control handler.
 */
function _mfgRerenderPreserving(el) {
  var container = _mfgEditContainerOf(el);
  var key = _mfgEditContainerKey(container);
  var vals = _mfgSnapshotFields(container);
  renderIdentificationTab();
  if (!key || !Object.keys(vals).length) return;
  var snap = {};
  snap[key] = vals;
  _mfgRestoreEditors(snap);
}

/** Every open editing container's live values, keyed by container identity. */
function _mfgSnapshotAllEditors() {
  var snap = {};
  document.querySelectorAll(".mfg-widget-edit-card, .mfg-widget-add-card, tr[data-metric-key], tr[data-override-id]")
    .forEach(function (c) {
      var key = _mfgEditContainerKey(c);
      if (!key) return;
      var vals = _mfgSnapshotFields(c);
      if (Object.keys(vals).length) snap[key] = vals;
    });
  return snap;
}

/** Write a snapshot back into whichever containers now carry those keys. */
function _mfgRestoreEditors(snap) {
  if (!snap) return;
  document.querySelectorAll(".mfg-widget-edit-card, .mfg-widget-add-card, tr[data-metric-key], tr[data-override-id]")
    .forEach(function (c) {
      var vals = snap[_mfgEditContainerKey(c)];
      if (!vals) return;
      c.querySelectorAll("input, select, textarea").forEach(function (field) {
        var fk = _mfgFieldKey(field);
        if (!fk || !(fk in vals)) return;
        if (field.type === "checkbox" || field.type === "radio") { field.checked = !!vals[fk]; return; }
        // A <select> whose options changed drops a value the new list doesn't
        // offer — which is what should happen to a Symbol after a MIB swap.
        field.value = vals[fk];
      });
    });
}

/**
 * Re-render preserving EVERY open editor, for a re-render with no triggering
 * element to key from — specifically the ASYNCHRONOUS one.
 *
 * `_mfgRerenderPreserving` above fixes the re-render a chained select performs
 * synchronously, but picking a MIB also kicks off `_ensureMibSymbols`, whose
 * fetch re-renders again when it resolves. That second render lands AFTER the
 * restore, from a callback that never saw the element, so on a cache miss — i.e.
 * every first pick of a MIB, the reported case — the operator watched the Name
 * come back and then vanish again a few hundred ms later. Snapshotting all open
 * editors is what lets a callback with no context put them back.
 */
function _mfgRerenderPreservingAll() {
  var snap = _mfgSnapshotAllEditors();
  renderIdentificationTab();
  _mfgRestoreEditors(snap);
}

// ─── "+ Add Manufacturer" typeahead ────────────────────────────────────────
// The box stays free text — any custom vendor is accepted. The dropdown only
// offers what Polaris already knows (asset manufacturers + the alias/OUI
// canonicals from MAC & Vendor Identification) so a profile is far likelier to
// be spelled the way `getProfileFor` resolves it. Same open-on-click combobox
// the automations wizard uses; `<datalist>` is deliberately avoided (most
// browsers won't open one on click).

var _MFG_SUGGEST_SOURCE_LABELS = { asset: "in inventory", alias: "alias", oui: "OUI override" };

function _mfgSuggestEls() {
  var input = document.getElementById("f-mfg-profile-add-name");
  var box = document.getElementById("mfg-profile-add-suggest");
  return input && box ? { input: input, box: box } : null;
}

function _closeMfgSuggest(box) {
  if (box) { box.classList.remove("open"); box.innerHTML = ""; }
}

// Fetch-once, coalesced. A failure closes the dropdown silently — suggestions
// are an aid, and the operator can always type the name.
function _ensureMfgSuggestions() {
  if (_mfgSuggestions) return Promise.resolve(_mfgSuggestions);
  if (!_mfgSuggestionsPromise) {
    _mfgSuggestionsPromise = api.serverSettings.listManufacturerSuggestions()
      .then(function (resp) {
        _mfgSuggestions = (resp && resp.suggestions) || [];
        return _mfgSuggestions;
      })
      .catch(function () { _mfgSuggestions = []; return _mfgSuggestions; })
      .finally(function () { _mfgSuggestionsPromise = null; });
  }
  return _mfgSuggestionsPromise;
}

function _renderMfgSuggest(input, box, rows) {
  var q = (input.value || "").trim().toLowerCase();
  // Prefix matches first, then interior — typing "ar" should offer "Aruba"
  // before "Hikari". An exact match is dropped: nothing left to complete.
  var matches = rows.filter(function (r) {
    var v = r.value.toLowerCase();
    return (!q || v.indexOf(q) !== -1) && v !== q;
  });
  if (q) {
    matches.sort(function (a, b) {
      var ap = a.value.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      var bp = b.value.toLowerCase().indexOf(q) === 0 ? 0 : 1;
      return ap - bp;
    });
  }
  matches = matches.slice(0, 50);
  if (!matches.length) {
    box.innerHTML = '<div class="aw-suggest-empty">' +
      (q ? "No known manufacturer matches — press Add to create it anyway."
         : "No suggestions yet — every known manufacturer already has a profile.") +
      '</div>';
    box.classList.add("open");
    return;
  }
  box.innerHTML = matches.map(function (r) {
    var hints = (r.sources || []).map(function (s) {
      return s === "asset" && r.assetCount
        ? r.assetCount + " device" + (r.assetCount === 1 ? "" : "s")
        : (_MFG_SUGGEST_SOURCE_LABELS[s] || s);
    });
    return '<div class="aw-suggest-item" data-val="' + escapeHtml(r.value) + '">' +
      escapeHtml(r.value) +
      (hints.length ? ' <span style="color:var(--color-text-tertiary)">· ' + escapeHtml(hints.join(" · ")) + '</span>' : "") +
    '</div>';
  }).join("");
  box.classList.add("open");
}

function _openMfgSuggest() {
  var els = _mfgSuggestEls();
  if (!els) return;
  _ensureMfgSuggestions().then(function (rows) {
    // The card re-renders freely; bail if this input is no longer the live one.
    var live = _mfgSuggestEls();
    if (!live || live.input !== els.input || document.activeElement !== live.input) return;
    _renderMfgSuggest(live.input, live.box, rows);
  });
}

function wireManufacturerSuggestCombo() {
  var els = _mfgSuggestEls();
  if (!els) return;
  var input = els.input, box = els.box;

  input.addEventListener("focus", _openMfgSuggest);
  input.addEventListener("click", _openMfgSuggest);
  input.addEventListener("input", function () {
    if (_mfgSuggestions) _renderMfgSuggest(input, box, _mfgSuggestions);
    else _openMfgSuggest();
  });
  input.addEventListener("blur", function () {
    // Delay so a mousedown on an item (which fires before blur completes) lands.
    setTimeout(function () { _closeMfgSuggest(box); }, 150);
  });
  box.addEventListener("mousedown", function (e) {
    var item = e.target.closest && e.target.closest(".aw-suggest-item");
    if (!item) return;
    e.preventDefault(); // keep focus on the input
    input.value = item.getAttribute("data-val");
    _closeMfgSuggest(box);
  });
  input.addEventListener("keydown", function (e) {
    var open = box.classList.contains("open");
    if (e.key === "Escape") { if (open) { _closeMfgSuggest(box); e.stopPropagation(); } return; }
    if (e.key === "Enter" && !open) { addManufacturerProfile(); return; }
    if (!open) return;
    var items = Array.prototype.slice.call(box.querySelectorAll(".aw-suggest-item"));
    var idx = items.findIndex(function (i) { return i.classList.contains("active"); });
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!items.length) return;
      e.preventDefault();
      var next = e.key === "ArrowDown" ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0);
      items.forEach(function (i) { i.classList.remove("active"); });
      items[next].classList.add("active");
      if (items[next].scrollIntoView) items[next].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      // A highlighted suggestion completes the box; otherwise Enter submits
      // whatever was typed, so a custom name never needs a mouse.
      if (idx >= 0) { input.value = items[idx].getAttribute("data-val"); _closeMfgSuggest(box); }
      else { _closeMfgSuggest(box); addManufacturerProfile(); }
    }
  });
}

async function addManufacturerProfile() {
  var input = document.getElementById("f-mfg-profile-add-name");
  var name = input && input.value ? input.value.trim() : "";
  if (!name) { showToast("Manufacturer is required", "error"); return; }
  try {
    var resp = await api.serverSettings.createManufacturerProfile({ manufacturer: name });
    if (resp && resp.profile) {
      _mfgProfiles.unshift({
        id:             resp.profile.id,
        manufacturer:   resp.profile.manufacturer,
        metricCount:    resp.profile.metrics.length,
        overrideCount:  0,
        widgetCount:    0,
        scopedMibCount: 0,
        createdAt:      resp.profile.createdAt,
        updatedAt:      resp.profile.updatedAt,
      });
      _mfgProfileDetail[resp.profile.id] = resp.profile;
      _mfgProfileExpanded[resp.profile.id] = true;
    }
    input.value = "";
    // The name just used now has a profile, so it must drop out of the list.
    _mfgSuggestions = null;
    showToast("Manufacturer profile added");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Create failed", "error");
  }
}

async function deleteManufacturerProfile(id) {
  var profile = _mfgProfiles.find(function (p) { return p.id === id; });
  if (!profile) return;
  var ok = await showConfirm('Delete the "' + profile.manufacturer + '" profile?', "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteManufacturerProfile(id);
    _mfgProfiles = _mfgProfiles.filter(function (p) { return p.id !== id; });
    delete _mfgProfileDetail[id];
    delete _mfgProfileExpanded[id];
    // Freed up — the manufacturer is suggestable again.
    _mfgSuggestions = null;
    showToast("Profile deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

async function toggleProfileExpand(id) {
  if (!id) return;
  if (_mfgProfileExpanded[id]) {
    _mfgProfileExpanded[id] = false;
    renderIdentificationTab();
    return;
  }
  _mfgProfileExpanded[id] = true;
  if (!_mfgProfileDetail[id]) {
    renderIdentificationTab();
    try {
      var resp = await api.serverSettings.getManufacturerProfile(id);
      _mfgProfileDetail[id] = resp.profile;
      renderIdentificationTab();
    } catch (err) {
      showToast(err.message || "Load failed", "error");
    }
  } else {
    renderIdentificationTab();
  }
}

function beginMetricEdit(tr) {
  if (!tr) return;
  _mfgProfileMetricEdit[tr.getAttribute("data-profile-id") + ":" + tr.getAttribute("data-metric-key")] = true;
  renderIdentificationTab();
}

function cancelMetricEdit(tr) {
  if (!tr) return;
  var pid = tr.getAttribute("data-profile-id");
  var mk  = tr.getAttribute("data-metric-key");
  delete _mfgProfileMetricEdit[pid + ":" + mk];
  delete _mfgEditMibSelections["metric:" + pid + ":" + mk];
  delete _mfgEditTypeSelections["metric:" + pid + ":" + mk];
  renderIdentificationTab();
}

async function saveMetricEdit(tr) {
  if (!tr) return;
  var profileId = tr.getAttribute("data-profile-id");
  var metricKey = tr.getAttribute("data-metric-key");
  var transform = (tr.querySelector(".mfg-edit-transform") || {}).value || "";
  var mibSel    = (tr.querySelector(".mfg-edit-mib")       || {}).value || "";
  var type      = (tr.querySelector(".mfg-edit-type")      || {}).value || "scalar";
  // Single dropdown value carries either a UUID, a std:* key, or "" — split
  // into the per-column shape the backend persists.
  var mibSplit = splitMibSelection(mibSel);
  var pair     = _readSymbolPair(tr, "mfg-edit-sym", type);
  if (type === "double_scalar" && (!pair.symbol || !pair.symbolB)) {
    showToast("Both Symbol A and Symbol B are required for double scalar", "error");
    return;
  }
  var payload = {
    defaultSymbol:    pair.symbol || null,
    defaultSymbolB:   type === "double_scalar" ? (pair.symbolB || null) : null,
    defaultMibId:     mibSplit.mibId,
    defaultMibStdKey: mibSplit.mibStdKey,
    defaultType:      type,
    defaultTransform: transform || null,
  };
  try {
    var resp = await api.serverSettings.updateProfileMetric(profileId, metricKey, payload);
    if (resp && resp.metric) updateMetricInDetail(profileId, resp.metric);
    delete _mfgProfileMetricEdit[profileId + ":" + metricKey];
    delete _mfgEditMibSelections["metric:" + profileId + ":" + metricKey];
    delete _mfgEditTypeSelections["metric:" + profileId + ":" + metricKey];
    showToast("Saved");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

async function addOverride(tr) {
  if (!tr) return;
  var profileId = tr.getAttribute("data-profile-id");
  var metricKey = tr.getAttribute("data-metric-key");
  var pattern   = (tr.querySelector(".mfg-new-override-pattern")   || {}).value || "";
  var transform = (tr.querySelector(".mfg-new-override-transform") || {}).value || "";
  var mibSel    = (tr.querySelector(".mfg-new-override-mib")       || {}).value || "";
  var type      = (tr.querySelector(".mfg-new-override-type")      || {}).value || "scalar";
  var mibSplit  = splitMibSelection(mibSel);
  if (!pattern.trim()) { showToast("Model regex is required", "error"); return; }
  var pair = _readSymbolPair(tr, "mfg-new-override-sym", type);
  if (!pair.symbol) { showToast("Pattern and Symbol A are required", "error"); return; }
  if (type === "double_scalar" && !pair.symbolB) {
    showToast("Symbol B is required for double scalar", "error");
    return;
  }
  var payload = {
    modelPattern: pattern.trim(),
    symbol:       pair.symbol,
    symbolB:      type === "double_scalar" ? pair.symbolB : null,
    mibId:        mibSplit.mibId,
    mibStdKey:    mibSplit.mibStdKey,
    type:         type,
    transform:    transform || null,
  };
  try {
    var resp = await api.serverSettings.createProfileMetricOverride(profileId, metricKey, payload);
    if (resp && resp.override) appendOverrideToDetail(profileId, metricKey, resp.override);
    delete _mfgEditMibSelections["new:" + profileId + ":" + metricKey];
    delete _mfgEditTypeSelections["new:" + profileId + ":" + metricKey];
    showToast("Override added");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Add override failed", "error");
  }
}

function beginOverrideEdit(tr) {
  if (!tr) return;
  _mfgProfileOverrideEdit[tr.getAttribute("data-override-id")] = true;
  renderIdentificationTab();
}

function cancelOverrideEdit(tr) {
  if (!tr) return;
  var oid = tr.getAttribute("data-override-id");
  delete _mfgProfileOverrideEdit[oid];
  delete _mfgEditMibSelections["override:" + oid];
  delete _mfgEditTypeSelections["override:" + oid];
  renderIdentificationTab();
}

async function saveOverrideEdit(tr) {
  if (!tr) return;
  var profileId  = tr.getAttribute("data-profile-id");
  var metricKey  = tr.getAttribute("data-metric-key");
  var overrideId = tr.getAttribute("data-override-id");
  var pattern    = (tr.querySelector(".mfg-edit-override-pattern")   || {}).value || "";
  var mibSel     = (tr.querySelector(".mfg-edit-override-mib")       || {}).value || "";
  var transform  = (tr.querySelector(".mfg-edit-override-transform") || {}).value || "";
  var type       = (tr.querySelector(".mfg-edit-override-type")      || {}).value || "scalar";
  var mibSplit   = splitMibSelection(mibSel);
  if (!pattern.trim()) { showToast("Model regex is required", "error"); return; }
  var pair = _readSymbolPair(tr, "mfg-edit-override-sym", type);
  if (!pair.symbol) { showToast("Pattern and Symbol A are required", "error"); return; }
  if (type === "double_scalar" && !pair.symbolB) {
    showToast("Symbol B is required for double scalar", "error");
    return;
  }
  var payload = {
    modelPattern: pattern.trim(),
    symbol:       pair.symbol,
    symbolB:      type === "double_scalar" ? pair.symbolB : null,
    mibId:        mibSplit.mibId,
    mibStdKey:    mibSplit.mibStdKey,
    type:         type,
    transform:    transform || null,
  };
  try {
    var resp = await api.serverSettings.updateProfileMetricOverride(profileId, metricKey, overrideId, payload);
    if (resp && resp.override) replaceOverrideInDetail(profileId, metricKey, resp.override);
    delete _mfgProfileOverrideEdit[overrideId];
    delete _mfgEditMibSelections["override:" + overrideId];
    delete _mfgEditTypeSelections["override:" + overrideId];
    showToast("Saved");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

function replaceOverrideInDetail(profileId, metricKey, override) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m || !m.overrides) return;
  for (var i = 0; i < m.overrides.length; i++) {
    if (m.overrides[i].id === override.id) { m.overrides[i] = override; return; }
  }
}

async function deleteOverride(tr) {
  if (!tr) return;
  var profileId  = tr.getAttribute("data-profile-id");
  var metricKey  = tr.getAttribute("data-metric-key");
  var overrideId = tr.getAttribute("data-override-id");
  var ok = await showConfirm("Delete this override?", "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteProfileMetricOverride(profileId, metricKey, overrideId);
    removeOverrideFromDetail(profileId, metricKey, overrideId);
    showToast("Override deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

function updateMetricInDetail(profileId, metric) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  for (var i = 0; i < d.metrics.length; i++) {
    if (d.metrics[i].metricKey === metric.metricKey) {
      d.metrics[i] = metric;
      return;
    }
  }
}

function appendOverrideToDetail(profileId, metricKey, override) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m) return;
  m.overrides = (m.overrides || []).concat([override]);
  // Bump summary count so the row's "N overrides" line stays in sync until
  // the next full reload.
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary) summary.overrideCount += 1;
}

function removeOverrideFromDetail(profileId, metricKey, overrideId) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  var m = d.metrics.find(function (mm) { return mm.metricKey === metricKey; });
  if (!m) return;
  m.overrides = (m.overrides || []).filter(function (o) { return o.id !== overrideId; });
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary && summary.overrideCount > 0) summary.overrideCount -= 1;
}

// ─── Widget mutations ─────────────────────────────────────────────────

// Read the shared widget form (Add or Edit card) into a payload the
// backend route accepts. Returns null + toasts on validation failure.
function _readWidgetFormPayload(scope) {
  if (!scope) return null;
  var name           = (scope.querySelector(".mfg-widget-name")        || {}).value || "";
  var mibSel         = (scope.querySelector(".mfg-widget-mib")         || {}).value || "";
  var typeSel        = (scope.querySelector(".mfg-widget-type")        || {}).value || "scalar";
  var widgetType     = (scope.querySelector(".mfg-widget-widgettype")  || {}).value || "gauge";
  var symbol         = (scope.querySelector(".mfg-widget-symbol")      || {}).value || "";
  var modelPattern   = (scope.querySelector(".mfg-widget-model")       || {}).value || "";
  var orderRaw       = (scope.querySelector(".mfg-widget-order")       || {}).value || "0";
  var transform      = (scope.querySelector(".mfg-widget-transform")   || {}).value || "";

  if (!name.trim())   { showToast("Widget name is required", "error");                 return null; }

  // An http widget names a request, not an OID, so the MIB/symbol pair is
  // required for every OTHER type. Mirrors the same split in
  // manufacturerProfileService.createWidget.
  var isHttp = widgetType === "http";
  var mibSplit = splitMibSelection(mibSel);
  if (!isHttp) {
    // Backend requires a real MibFile UUID — std:* keys aren't acceptable
    // because the asset-side collector needs an enumerable symbol directory
    // to walk against on the device.
    if (!mibSplit.mibId) { showToast("Pick an uploaded MIB (Standard MIBs aren't supported for widgets)", "error"); return null; }
    if (!symbol.trim()) { showToast("Symbol is required", "error");                     return null; }
  }

  var displayOptions = _readWidgetDisplayOptions(scope, widgetType);
  var payload = {
    name:           name.trim(),
    symbol:         isHttp ? null : symbol.trim(),
    mibId:          isHttp ? null : mibSplit.mibId,
    type:           typeSel,
    widgetType:     widgetType,
    transform:      transform || null,
    displayOptions: displayOptions,
    order:          Number(orderRaw) || 0,
    modelPattern:   modelPattern.trim() ? modelPattern.trim() : null,
  };
  if (isHttp) {
    payload.httpCheck    = _readWidgetHttpCheck(scope);
    payload.credentialId = (scope.querySelector(".mfg-http-cred") || {}).value || null;
  }
  if (widgetType === "state") {
    var mode      = (scope.querySelector(".mfg-widget-statemode")    || {}).value || "nonzero";
    var valuesRaw = (scope.querySelector(".mfg-widget-statevalues")  || {}).value || "";
    var trueLabel = (scope.querySelector(".mfg-widget-statetrue")    || {}).value || "";
    var falseLabel= (scope.querySelector(".mfg-widget-statefalse")   || {}).value || "";
    var labelSym  = (scope.querySelector(".mfg-widget-labelsymbol")  || {}).value || "";
    var problemEl = scope.querySelector(".mfg-widget-stateproblem");
    var values = valuesRaw.split(",").map(function (v) { return v.trim(); }).filter(function (v) { return v !== ""; });
    // Caught here as well as server-side: a probe whose comparison set is empty
    // would evaluate every reading to false and look healthy forever.
    if (STATE_MODES_WITH_VALUES.indexOf(mode) !== -1 && values.length === 0) {
      showToast("That state mode needs at least one comparison value", "error");
      return null;
    }
    payload.stateMap = {
      mode: mode,
      values: values,
      trueLabel: trueLabel.trim() || "Alarm",
      falseLabel: falseLabel.trim() || "OK",
      trueIsProblem: problemEl ? !!problemEl.checked : true,
    };
    payload.labelSymbol = typeSel === "table" && labelSym.trim() ? labelSym.trim() : null;
  }
  return payload;
}

async function saveNewWidget(scope) {
  if (!scope) return;
  var profileId = scope.getAttribute("data-profile-id");
  var payload = _readWidgetFormPayload(scope);
  if (!payload) return;
  try {
    var resp = await api.serverSettings.createProfileWidget(profileId, payload);
    if (resp && resp.widget) appendWidgetToDetail(profileId, resp.widget);
    delete _mfgAddingWidget[profileId];
    _mfgWidgetClearShadow("new-widget:" + profileId);
    showToast("Widget added");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Add widget failed", "error");
  }
}

async function saveWidgetEdit(scope) {
  if (!scope) return;
  var profileId = scope.getAttribute("data-profile-id");
  var widgetId  = scope.getAttribute("data-widget-id");
  var payload   = _readWidgetFormPayload(scope);
  if (!payload) return;
  try {
    var resp = await api.serverSettings.updateProfileWidget(profileId, widgetId, payload);
    if (resp && resp.widget) replaceWidgetInDetail(profileId, resp.widget);
    delete _mfgWidgetEdit[widgetId];
    _mfgWidgetClearShadow("widget:" + widgetId);
    showToast("Saved");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Save failed", "error");
  }
}

async function deleteWidget(profileId, widgetId) {
  if (!profileId || !widgetId) return;
  var d = _mfgProfileDetail[profileId];
  var w = d && (d.widgets || []).find(function (x) { return x.id === widgetId; });
  var name = w ? w.name : "this widget";
  var ok = await showConfirm('Delete the "' + name + '" widget?', "Delete");
  if (!ok) return;
  try {
    await api.serverSettings.deleteProfileWidget(profileId, widgetId);
    removeWidgetFromDetail(profileId, widgetId);
    delete _mfgWidgetEdit[widgetId];
    _mfgWidgetClearShadow("widget:" + widgetId);
    showToast("Widget deleted");
    renderIdentificationTab();
  } catch (err) {
    showToast(err.message || "Delete failed", "error");
  }
}

function appendWidgetToDetail(profileId, widget) {
  var d = _mfgProfileDetail[profileId];
  if (!d) return;
  d.widgets = (d.widgets || []).concat([widget]);
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary) summary.widgetCount = (summary.widgetCount || 0) + 1;
}

function replaceWidgetInDetail(profileId, widget) {
  var d = _mfgProfileDetail[profileId];
  if (!d || !d.widgets) return;
  for (var i = 0; i < d.widgets.length; i++) {
    if (d.widgets[i].id === widget.id) { d.widgets[i] = widget; return; }
  }
}

function removeWidgetFromDetail(profileId, widgetId) {
  var d = _mfgProfileDetail[profileId];
  if (!d || !d.widgets) return;
  d.widgets = d.widgets.filter(function (w) { return w.id !== widgetId; });
  var summary = _mfgProfiles.find(function (p) { return p.id === profileId; });
  if (summary && summary.widgetCount > 0) summary.widgetCount -= 1;
}
