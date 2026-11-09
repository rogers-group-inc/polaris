/**
 * public/js/server-settings-credentials.js — Server Settings → Credentials:
 * the stored-credential list, its editor, and the credential usage slide-in.
 *
 * Split out of server-settings.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals, called from the
 * core's tab dispatch (`loadCredentialsTab`). Loads AFTER server-settings.js
 * — tests/unit/serverSettingsSplit.test.ts holds the order.
 */

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
      _mfgMetricTransforms = profilePayload.metricTransforms || {};
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
      (cfg.verifyHostKey === false ? " · host key NOT verified" : " · host key pinned") +
      (cfg.allowReboot === true ? " · reboots allowed" : "");
  }
  if (c.type === "restapi") {
    var url = cfg.baseUrl || "";
    var verifyTls = cfg.verifyTls === true ? "verify TLS" : "skip TLS";
    return escapeHtml(url) + " · " + verifyTls + (cfg.allowReboot === true ? " · reboots allowed" : "");
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
    if (mode === "form")   return escapeHtml(cfg.username || "") + " · device login" + (cfg.allowReboot === true ? " · reboots allowed" : "");
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
  // Skeleton + backdrop / close / Escape / resize wiring: buildSlideover
  // (app.js). Escape only when this panel is topmost — the asset panel a row
  // opens stacks over it.
  buildSlideover({
    id: "cred-usage-panel",
    prefix: "cred-usage",
    title: "Credential usage",
    closeTitle: null,
    close: closeCredUsagePanel,
    resizeKey: "polaris.panel.width.credusage",
  });

  // Click-through to asset details, in place over this panel: PolarisPanels
  // (app.js) loads assets.js on demand on the Server Settings page. The
  // canonical #view=asset:<id> deep link, which processSearchHash() opens on
  // load, stays as the fallback.
  document.getElementById("cred-usage-body").addEventListener("click", function (e) {
    var row = e.target.closest ? e.target.closest("[data-asset-id]") : null;
    if (!row) return;
    var assetId = row.getAttribute("data-asset-id");
    if (!assetId) return;
    if (window.PolarisPanels && typeof window.PolarisPanels.openAsset === "function") {
      window.PolarisPanels.openAsset(assetId);
      return;
    }
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(assetId);
  });
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

  raiseSlideover(document.getElementById("cred-usage-overlay"));
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
            'This shows where the credential is configured across the monitor-settings tiers, the Firmware Repository and Polaris Agent installs — not a live probe trace.' +
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

    // Operations — firmware flashes / reboots through a Repository login
    // binding, and Polaris Agent install / upgrade / reboot opt-in.
    if (u.operationLevel && u.operationLevel.length) {
      var opCount = u.operationLevel.reduce(function (n, g) { return n + g.assets.length; }, 0);
      html += _credUsageSectionHeader("Operations", opCount, "Used to act on the asset rather than poll it — firmware upgrades, reboots and Polaris Agent installs. An asset can also appear under a monitoring tier above.");
      html += u.operationLevel.map(function (g) {
        return '<div style="margin:0.25rem 0 0.6rem">' +
          '<div style="font-size:0.82rem;font-weight:500;margin-bottom:0.3rem">' + escapeHtml(g.label) + '</div>' +
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
    // New credentials default to verify-ON (2026-06-03 review, H1). SSH
    // host-key pinning is ON for every credential unless it stores
    // verifyHostKey: false (business rule 113), so its box reads checked for
    // an existing credential with no flag. initialState (Back button) always
    // wins so in-flight edits survive.
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
      var saved = isNew
        ? await api.credentials.create({ name: name, type: selectedType, config: config })
        : await api.credentials.update(id, { name: name, config: config });
      closeModal();
      showToast("Credential saved");
      // Other tabs that hold a credential picker (the Firmware repository's
      // device-login select) refresh on this rather than a page reload.
      try {
        window.dispatchEvent(new CustomEvent("polaris:credentials-changed", {
          detail: { id: (saved && saved.id) || id || null, created: isNew },
        }));
      } catch (e) { /* no listener is fine */ }
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
      '<p class="hint">Applies when Use HTTPS is on. WinRM sends the username and password as Basic auth. When checked, the certificate must chain to a trusted CA. When unchecked (a self-signed listener), Polaris pins the certificate it sees on the first connection and refuses to send the password if it ever changes; when a certificate is legitimately re-issued, compare it and choose Trust new certificate under Web Server → Pinned server identities.</p>' +
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
        '<input type="checkbox" id="f-ssh-verifyhostkey"' + (cfg.verifyHostKey !== false ? " checked" : "") + '>' +
        '<span>Verify the server\'s host key</span>' +
      '</label>' +
      '<p class="hint">Recommended. When off, Polaris accepts whatever host key is presented, so anything answering on the target\'s address can impersonate it &mdash; and on an agent install it is handed a script to run as root. On first connection Polaris pins the key it sees and refuses later connections if it changes; if a host is legitimately rebuilt or re-keyed, delete its pin under Integrations &rarr; Polaris Agent &rarr; Windows SSH Deployment (Pinned server identities).</p>' +
    '</div>' +
    credAllowRebootHTML(cfg, "",
      "Lets this login run <code>execute reboot</code> on a FortiGate it is set on, restart the FortiSwitches and FortiAPs that FortiGate manages, or reboot a standalone FortiSwitch / FortiAP over its own CLI.")
  );
}

/**
 * The "Allow reboots" opt-in (business rule 115) — one box shared by the three
 * credential kinds that can reboot a FortiGate / FortiSwitch / FortiAP: SSH,
 * REST API token, and a device admin login (`http` in form mode, so it rides
 * `data-http-auth="form"`). Off by default; the server refuses it on any other
 * kind and records every flip on the credential's Event.
 */
function credAllowRebootHTML(cfg, httpModes, what) {
  return '<div class="form-group"' + (httpModes ? ' data-http-auth="' + httpModes + '"' : '') + '>' +
    '<label style="display:flex;align-items:center;gap:8px;cursor:pointer">' +
      '<input type="checkbox" id="f-cred-allowreboot"' + (cfg.allowReboot === true ? " checked" : "") + '>' +
      '<span>Allow reboots</span>' +
    '</label>' +
    '<p class="hint">Off by default. ' + what + ' Anyone with Read-Write on Assets can then reboot those devices from the asset’s <strong>Reboot</strong> button, now or on a schedule; FortiGate HA members are always refused. ' +
      'The admin behind the credential also needs System read-write on the device.</p>' +
  '</div>';
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
    '</div>' +
    credAllowRebootHTML(cfg, "",
      "Lets this token reboot a FortiGate it is set on (FortiOS <code>system/os/reboot</code>), and restart the FortiSwitches and FortiAPs that FortiGate manages.")
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
        '<option value="form"' +   (authMode === "form"   ? " selected" : "") + '>Device admin login (form)</option>' +
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
      // "form" is not an HTTP auth scheme: it is a switch or access point's
      // own admin login, posted to the device's login page by a firmware
      // upgrade (Server Settings → Repository, business rule 87). It rides the
      // same show/hide mechanism, but its box says what it is FOR rather than
      // warning about a check — an HTTP-check widget refuses it at save time.
      '<div class="alert alert-info" data-http-auth="form" ' +
        'style="padding:0.6rem 0.75rem;border-radius:6px;background:rgba(53,132,228,0.10);' +
        'border:1px solid var(--color-info,#3584e4);color:var(--color-text-primary);' +
        'font-size:0.82rem;margin:0.5rem 0 0.75rem">' +
        '<strong>A device admin login.</strong> The username and password the switch or access point’s own web UI takes. ' +
        'Used by firmware upgrades (<strong>Server Settings → Repository</strong>), which always talk HTTPS to the device. ' +
        'Not an HTTP authentication scheme — an HTTP-check widget will not accept it.' +
      '</div>' +
    '</div>' +
    '<div class="form-group" data-http-auth="bearer"><label>Bearer token</label>' +
      '<input type="password" id="f-http-token" value="' + escapeHtml(cfg.apiToken || "") + '">' +
      '<p class="hint">Sent as <code>Authorization: Bearer &lt;token&gt;</code>.</p>' +
    '</div>' +
    '<div class="form-group" data-http-auth="basic digest form"><label>Username</label>' +
      '<input type="text" id="f-http-user" value="' + escapeHtml(cfg.username || "") + '">' +
    '</div>' +
    '<div class="form-group" data-http-auth="basic digest form"><label>Password</label>' +
      '<input type="password" id="f-http-pass" value="' + escapeHtml(cfg.password || "") + '">' +
    '</div>' +
    credAllowRebootHTML(cfg, "form",
      "Lets this admin login reboot a FortiGate it is set on or bound for in the Repository, and restart the FortiSwitches and FortiAPs that FortiGate manages.")
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
  if (declared === "none" || declared === "bearer" || declared === "basic" || declared === "digest" || declared === "form") return declared;
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
  var cfg = _readCredentialFormFields(type);
  // Allow reboots (business rule 115) rides the SSH, REST API and device admin
  // login forms. Sent on those types every time — an unticked box must clear
  // a stored `true`, since the server merges config onto the stored row.
  var allowReboot = document.getElementById("f-cred-allowreboot");
  if (allowReboot && (type === "ssh" || type === "restapi" || type === "http")) {
    cfg.allowReboot = type === "http" && cfg.authMode !== "form" ? false : allowReboot.checked;
  }
  return cfg;
}

function _readCredentialFormFields(type) {
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

