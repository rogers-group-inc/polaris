/**
 * public/js/server-settings-ntp-web.js — Server Settings → Time & NTP and
 * Web Server (internal key `certificates`): NTP servers + the server clock,
 * the searchable timezone picker, the HTTPS certificate / trusted CAs / proxy
 * / Dash / IPv6 / login-access cards, and the rotate-certificate workflow.
 *
 * Split out of server-settings.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals, called from the
 * core's tab dispatch (`loadNtpSettings`, `loadCertificates`). Loads AFTER
 * server-settings.js — tests/unit/serverSettingsSplit.test.ts holds the order.
 */

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
    // One line per server: each was queried for real, and each answers on its own.
    var rows = (result.results && result.results.length) ? result.results : [{ ok: result.ok, message: result.message }];
    statusEl.innerHTML = rows.map(function (r) {
      return '<div style="color:var(' + (r.ok ? '--color-success' : '--color-danger') + ')">' + escapeHtml(r.message) + '</div>';
    }).join("");
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

      // One class attribute: a second one (the "selected" copy this used to
      // append) is ignored by the parser, so the current zone was never
      // highlighted.
      html += '<div class="search-select-option' + (tz === hidden.value ? ' selected' : '') +
        '" data-value="' + escapeHtml(tz) + '">' + escapeHtml(label) + ' <span style="color:var(--color-text-tertiary);font-size:0.78rem">' + escapeHtml(tz) + '</span></div>';
      count++;
    }

    if (count === 0) {
      html = '<div class="search-select-empty">No timezones match "' + escapeHtml(filter) + '"</div>';
    }

    dropdown.innerHTML = html;
    highlightIdx = -1;
  }

  // Picking an option: one delegated listener on the dropdown, bound once
  // (CQ-F042). renderOptions repaints every zone (~400 of them) on each
  // keystroke, and used to bind a listener per option per keystroke.
  if (dropdown.dataset.tzWired !== "1") {
    dropdown.dataset.tzWired = "1";
    dropdown.addEventListener("mousedown", function (e) {
      var opt = e.target && typeof e.target.closest === "function" ? e.target.closest(".search-select-option") : null;
      if (!opt || !dropdown.contains(opt)) return;
      e.preventDefault(); // prevent blur
      selectTz(opt.getAttribute("data-value"));
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

// ─── Web Server Tab (internal key "certificates") ────────────────────────────

var _certsLoaded = false;
var _certData = { trustedCAs: [], serverCerts: [] };
var _httpsSettings = { fingerprint: null, cn: null, dnsSans: [], ipSans: [], expiresAt: null, certPath: null };
var _proxyData = null;
var _dashSettings = null; // { enabled, rfc1918Only } | null while loading/failed
var _ipv6Settings = null; // { mode, hostAddresses, enabled } | null while loading/failed
var _loginAccess = null;  // { settings, callerIp } | null while loading/failed

// Render the Web Server tab (data-tab="certificates"). nginx terminates TLS — five cards
// in a .settings-cards-flow deck (up to three columns, reflowing to two then
// one as the window narrows; the min column width lives in styles.css):
// HTTPS Certificate (read-only metadata + Rotate button), nginx Proxy (the
// six operator-settable directives: HTTPS port, HTTP/3, TLS protocols, HSTS,
// Prometheus allow-list, with a Save & Apply button), Dash Wallboard (the
// unauthenticated read-only /dash surface: on/off toggle + source-IP scope),
// Local Login Access (READ-ONLY here since 2026-09 — the editor moved to Users →
// Authentication → Settings, where it sits with the password and passkey
// policies; this card states the current scope and points there), and Trusted CAs.
// A drift banner appears above the deck, full width, when proxyConfig.managedMode
// is false (the refuse-and-banner UX for existing installs that haven't opted
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
  var certEdge = "ok";
  if (s.expiresAt) {
    var ms = Date.parse(s.expiresAt) - Date.now();
    var days = Math.floor(ms / (24 * 60 * 60 * 1000));
    var pillClass = "badge-available";
    var pillLabel = days + " days";
    if (days < 0)       { pillClass = "badge-deprecated"; pillLabel = "EXPIRED"; certEdge = "red"; }
    else if (days < 7)  { pillClass = "badge-deprecated"; pillLabel = days + " days"; certEdge = "red"; }
    else if (days < 30) { pillClass = "badge-reserved";   pillLabel = days + " days"; certEdge = "amber"; }
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
    '<div class="settings-card severity-edge severity-edge-' + certEdge + '">' +
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

  // IPv6 card — business rule 128. Off means no IPv6 is discovered, collected,
  // stored or shown anywhere. Set once at install from whether this server had
  // a routable IPv6 address; a plain toggle from then on. PUT is
  // serverSettingsSystem write-gated.
  var v6 = _ipv6Settings;
  var v6Hosts = (v6 && Array.isArray(v6.hostAddresses)) ? v6.hostAddresses : [];
  var v6Origin = !v6 ? '' :
    v6.setBy === "install"
      ? (v6.enabled
          ? 'Switched on at install, because this server had a routable IPv6 address.'
          : 'Switched off at install, because this server had no routable IPv6 address.')
      : v6.setBy === "operator" ? 'Set in Server Settings.' : '';
  var ipv6CardHtml =
    '<div class="settings-card">' +
      '<h4>IPv6</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'When IPv6 is off, Polaris discovers, collects, stores and shows no IPv6 addresses, and every device is ' +
        'monitored on its IPv4 address. When it is on, a device with no IPv4 address is monitored on its primary IPv6 address, ' +
        'as long as this server can reach IPv6. Polaris sets this once at install, from whether this server has a ' +
        'routable IPv6 address; after that only this switch changes it. In a container the server is the container: ' +
        'on Docker or podman compose, enable IPv6 on the compose network first (see the install guide).' +
      '</p>' +
      (v6 === null
        ? '<p style="font-size:0.85rem;color:var(--color-text-secondary)">Unavailable — could not load the IPv6 setting.</p>'
        : '<div class="form-group">' +
            '<label><input type="checkbox" id="ipv6-enabled"' + (v6.enabled ? " checked" : "") + '> Enable IPv6</label>' +
            (v6Origin ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-top:0.2rem">' + v6Origin + '</div>' : '') +
          '</div>' +
          (v6.enabled && !v6.dialable
            ? '<p style="font-size:0.82rem;color:#f59e0b;margin-bottom:0.75rem">This server has no IPv6 address or route, so it cannot reach IPv6 devices. ' +
                'IPv6 addresses are still discovered and shown, but a device with only an IPv6 address is not polled. ' +
                'In a container, enable IPv6 on the compose network.</p>'
            : '') +
          (!v6.enabled && v6Hosts.length
            ? '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">This server now has a routable IPv6 address. ' +
                'Turn IPv6 on to discover and monitor IPv6 devices.</p>'
            : '') +
          '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">This server\'s IPv6: ' +
            (v6Hosts.length
              ? '<code>' + v6Hosts.map(escapeHtml).join(", ") + '</code>'
              : 'none routable (link-local and loopback addresses are not counted)') +
          '</p>' +
          '<div style="margin-top:0.5rem"><button class="btn btn-sm btn-primary" id="ipv6-save-btn">Save</button></div>') +
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

  // Local Login Access — a POINTER, not an editor.
  //
  // The setting itself (`loginAccessConfig`) still exists and still gates
  // /login.html and the password endpoints; what moved (2026-09) is where it is
  // edited. It now lives on Users → Authentication → Settings beside the
  // password policy and the passkey policy, because "who may sign in, and how"
  // is one decision and having two screens that write the same row is how the
  // two drift into disagreeing about what is configured. Read-only status here
  // so an admin looking at Web Server still learns the answer.
  var la = _loginAccess;
  var laS = la && la.settings;
  var laSummary;
  if (la === null) {
    laSummary = 'Unavailable &mdash; could not load the login access settings.';
  } else if (!laS.enabled) {
    laSummary = 'Not restricted &mdash; local login is reachable from any network that can reach Polaris.';
  } else if (laS.ipScope === "custom") {
    laSummary = 'Restricted to: <code>' + escapeHtml((laS.allowedCidrs || []).join(", ") || "(none)") + '</code>';
  } else if (laS.ipScope === "all") {
    laSummary = 'Scope set to all source IPs &mdash; effectively unrestricted.';
  } else {
    laSummary = 'Restricted to private networks (RFC1918) and loopback.';
  }
  var loginCardHtml =
    '<div class="settings-card">' +
      '<h4>Local Login Access</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
        'Restricts which source networks may reach the local login form at <code>/login.html</code> and submit ' +
        'a username and password. <strong>SAML, OIDC and App Proxy sign-in are never restricted</strong> &mdash; only the ' +
        'password path, which carries local <em>and</em> LDAP accounts.' +
      '</p>' +
      '<p style="font-size:0.85rem;margin-bottom:0.75rem"><strong>Current:</strong> ' + laSummary + '</p>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary)">' +
        'Edit this on <a href="/users.html">Users</a> &rarr; <strong>Authentication</strong> &rarr; <strong>Settings</strong>, ' +
        'where it sits with the password policy and passkey settings.' +
      '</p>' +
    '</div>';

  // Rule 113: every identity Polaris pinned on first use — the certificates
  // it pinned instead of verifying a CA (WinRM listeners, devices it upgrades,
  // FortiGates / FortiManagers with SSL verification off) with the changed
  // ones first and "Trust new certificate", and the SSH host keys. Lives here,
  // where certificate problems get looked for.
  var pinnedCardHtml =
    '<div class="settings-card" id="pinned-tls-card">' +
      '<h3>Pinned server identities</h3>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin:0 0 0.75rem 0">Polaris pins the TLS certificate of a server the first time it sends it a password or token ' +
        'without verifying a CA, and the SSH host key of every host it reaches over SSH, and refuses to send anything if either later changes. In the list a changed certificate comes first: ' +
        'compare it with the server and choose Trust new certificate. After a firmware upgrade Polaris runs itself, the device\'s new ' +
        'certificate is re-pinned automatically.</p>' +
      '<div id="pinned-tls-body"><p class="empty-state" style="padding:0.5rem 0;margin:0">Loading&hellip;</p></div>' +
    '</div>';

  container.innerHTML = bannerHtml +
    '<div class="settings-cards-flow">' +
      certCardHtml + proxyCardHtml + dashCardHtml + ipv6CardHtml + loginCardHtml + caCardHtml + pinnedCardHtml +
    '</div>';
  if (window.PolarisPinnedTlsCerts) window.PolarisPinnedTlsCerts.mount(document.getElementById("pinned-tls-body"));

  var adoptBtn = document.getElementById("proxy-adopt-btn");
  if (adoptBtn) adoptBtn.addEventListener("click", handleProxyAdopt);

  var dashSaveBtn = document.getElementById("dash-save-btn");
  if (dashSaveBtn) dashSaveBtn.addEventListener("click", handleDashSave);

  var ipv6SaveBtn = document.getElementById("ipv6-save-btn");
  if (ipv6SaveBtn) ipv6SaveBtn.addEventListener("click", function () { handleIpv6Save(container); });

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


async function handleIpv6Save(container) {
  var enabled = !!(document.getElementById("ipv6-enabled") || {}).checked;
  if (!enabled && _ipv6Settings && _ipv6Settings.enabled &&
      !(await showConfirm("Turn IPv6 off? Polaris stops discovering and showing IPv6 addresses, and devices that only have an IPv6 address stop being polled."))) {
    return;
  }
  try {
    var result = await api.serverSettings.ipv6Put({ enabled: enabled });
    _ipv6Settings = (result && result.ipv6) || _ipv6Settings;
    showToast("IPv6 " + (_ipv6Settings && _ipv6Settings.enabled ? "on" : "off") + " — other pages pick it up when reloaded");
    renderCertsTab(container);
  } catch (err) {
    showToast("Failed to save the IPv6 setting: " + (err.message || err), "error");
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
    var v6Resp = await api.serverSettings.ipv6Get();
    _ipv6Settings = (v6Resp && v6Resp.ipv6) || null;
  } catch (_) { _ipv6Settings = null; }

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
        '<button class="btn btn-sm btn-danger" onclick="deleteCA(' + jsArg(cert.id) + ', ' + jsArg(cert.name) + ')">Remove</button>' +
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

