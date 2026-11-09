/**
 * public/js/server-settings-api-tokens.js — Server Settings → API Tokens:
 * role-bound bearer tokens and the API Documentation Access card.
 *
 * Split out of server-settings.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals, called from the
 * core's tab dispatch (`loadApiTokensTab`). Loads AFTER server-settings.js —
 * tests/unit/serverSettingsSplit.test.ts holds the order.
 */

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
        // Integrations is capped (its status notes wrap inside it, so it
        // stops claiming the slack); Created By and Expires get a floor and
        // never wrap, so a name or date stays on one line.
        '<th>Name</th><th>Prefix</th><th>Role</th><th style="width:180px">Integrations</th><th>Trusted Hosts</th>' +
        '<th style="min-width:150px">Created By</th><th>Last Used</th><th style="min-width:150px">Expires</th><th>Status</th><th>Actions</th>' +
      '</tr></thead><tbody>' +
      tokens.map(function (t) {
        var statusBadge = t.revokedAt
          ? '<span class="badge badge-disabled">Revoked</span>'
          : t.expiresAt && new Date(t.expiresAt) <= new Date()
            ? '<span class="badge badge-decommissioned">Expired</span>'
            : '<span class="badge badge-active">Active</span>';
        var actions = t.revokedAt
          ? '<button class="btn btn-sm btn-danger" onclick="deleteApiToken(' + jsArg(t.id) + ',' + jsArg(t.name) + ')">Delete</button>'
          : '<button class="btn btn-sm btn-secondary" onclick="editApiTokenTrustedHosts(' + jsArg(t.id) + ')">Edit Hosts</button>' +
            '<button class="btn btn-sm btn-secondary" onclick="revokeApiToken(' + jsArg(t.id) + ',' + jsArg(t.name) + ')">Revoke</button>' +
            '<button class="btn btn-sm btn-danger" onclick="deleteApiToken(' + jsArg(t.id) + ',' + jsArg(t.name) + ')">Delete</button>';
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
        // Empty = accepted from any source; otherwise the first few entries
        // with the full list in the tooltip.
        var hosts = t.trustedHosts || [];
        var hostsHtml = hosts.length
          ? '<span title="' + escapeHtml(hosts.join(", ")) + '">' +
              hosts.slice(0, 3).map(function (h) { return '<div class="mono">' + escapeHtml(h) + '</div>'; }).join("") +
              (hosts.length > 3 ? '<div style="color:var(--color-text-secondary)">+' + (hosts.length - 3) + ' more</div>' : '') +
            '</span>'
          : '<span style="color:var(--color-text-secondary)">Any</span>';
        return '<tr>' +
          '<td><strong>' + escapeHtml(t.name) + '</strong></td>' +
          '<td class="mono">' + escapeHtml(t.tokenPrefix || "—") + '…</td>' +
          '<td>' + roleHtml + '</td>' +
          '<td style="font-size:0.85rem">' + intgHtml + '</td>' +
          '<td style="font-size:0.82rem">' + hostsHtml + '</td>' +
          '<td style="white-space:nowrap">' + escapeHtml(t.createdBy || "—") + '</td>' +
          '<td>' + (t.lastUsedAt ? formatDate(t.lastUsedAt) + (t.lastUsedIp ? ' <span class="mono" style="font-size:0.78rem;color:var(--color-text-secondary)">(' + escapeHtml(t.lastUsedIp) + ')</span>' : '') : "—") + '</td>' +
          '<td style="white-space:nowrap">' + (t.expiresAt ? formatDate(t.expiresAt) : "Never") + '</td>' +
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
    '<div class="settings-cards-row" style="margin-top:1.5rem">' +
    '<div class="settings-card">' +
      '<h4>Create New Token</h4>' +
      '<div style="display:grid;gap:0.75rem">' +
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
          '<label class="form-label" for="f-token-trusted-hosts">Trusted hosts (optional)</label>' +
          '<textarea id="f-token-trusted-hosts" class="form-input" rows="3" spellcheck="false" style="font-family:monospace" placeholder="10.20.5.14&#10;10.20.0.0/16"></textarea>' +
          '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin-top:0.3rem">' +
            'One IP address or CIDR per line (commas also work). The token is refused from any other address. Leave blank to accept it from anywhere.' +
            (docsAccess.callerIp ? ' Polaris sees your address as <code class="mono">' + escapeHtml(docsAccess.callerIp) + '</code>.' : '') +
          '</div>' +
        '</div>' +
        '<div>' +
          '<label class="form-label" for="f-token-expires">Expires (optional)</label>' +
          '<input type="datetime-local" id="f-token-expires" class="form-input">' +
        '</div>' +
        '<div><button class="btn btn-primary" id="btn-create-api-token">Create Token</button></div>' +
      '</div>' +
    '</div>' +
    _apiDocsCardHtml(docsAccess) +
    '</div>';

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
  _apiTokensById = {};
  tokens.forEach(function (t) { _apiTokensById[t.id] = t; });
  _apiTokenCallerIp = docsAccess.callerIp || "";
}

var _apiTokenRolesById = {};
var _apiTokensById = {};
var _apiTokenCallerIp = "";

// One IP or CIDR per line; commas, semicolons and spaces also separate.
// The server validates — this only splits.
function _parseTrustedHosts(text) {
  return String(text || "")
    .split(/[\s,;]+/)
    .map(function (h) { return h.trim(); })
    .filter(Boolean);
}

function editApiTokenTrustedHosts(id) {
  var t = _apiTokensById[id];
  if (!t) return;
  var body =
    '<p style="margin:0 0 0.75rem">Source addresses token <strong>' + escapeHtml(t.name) + '</strong> is accepted from. ' +
      'The change applies to the next request — the token value does not change.</p>' +
    '<label class="form-label" for="f-edit-trusted-hosts">Trusted hosts</label>' +
    '<textarea id="f-edit-trusted-hosts" class="form-input" rows="6" spellcheck="false" style="font-family:monospace;width:100%" placeholder="10.20.5.14&#10;10.20.0.0/16">' +
      escapeHtml((t.trustedHosts || []).join("\n")) + '</textarea>' +
    '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin-top:0.3rem">' +
      'One IP address or CIDR per line. Leave blank to accept the token from anywhere.' +
      (_apiTokenCallerIp ? ' Polaris sees your address as <code class="mono">' + escapeHtml(_apiTokenCallerIp) + '</code>.' : '') +
    '</div>';
  openModal("Trusted Hosts — " + t.name, body,
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-trusted-hosts">Save</button>');
  document.getElementById("btn-save-trusted-hosts").addEventListener("click", async function () {
    var btn = this;
    var hosts = _parseTrustedHosts(document.getElementById("f-edit-trusted-hosts").value);
    if (!hosts.length && (t.trustedHosts || []).length) {
      var ok = await showConfirm('Remove every trusted host? Token "' + t.name + '" will be accepted from any address.');
      if (!ok) return;
    }
    btn.disabled = true;
    try {
      await api.apiTokens.updateTrustedHosts(id, hosts);
      closeModal();
      showToast('Trusted hosts updated for "' + t.name + '"');
      _apiTokensLoaded = false;
      await loadApiTokensTab();
    } catch (err) {
      showToast(err.message || "Update failed", "error");
      btn.disabled = false;
    }
  });
}

// ─── API Documentation Access card ─────────────────────────────────────────
// Who may reach the unauthenticated /api docs page. Three postures only —
// loopback / RFC1918 / custom private subnets — deliberately no "all": the
// server refuses any custom entry outside RFC1918 space, so the widest this
// card can open the page is the private network.

function _apiDocsCardHtml(docsAccess) {
  var head =
    '<div class="settings-card">' +
      '<h4>API Documentation Access</h4>' +
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
    '<div style="display:grid;gap:0.75rem">' +
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
  var trustedHosts = _parseTrustedHosts(document.getElementById("f-token-trusted-hosts").value);
  var expiresAt = document.getElementById("f-token-expires").value;
  var body = { name: name, roleId: roleId };
  if (integrationIds.length) body.integrationIds = integrationIds;
  if (trustedHosts.length) body.trustedHosts = trustedHosts;
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

