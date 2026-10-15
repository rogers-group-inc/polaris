// public/js/mobile/asset-edit.js — the asset edit menu and its three sheets.
//
// Tapping the asset's NAME in the asset sheet header (asset-detail.js) opens a
// menu: first the desktop panel header's device verbs — Discover Now and
// Reboot — then one entry per tab of the desktop's Edit Asset modal
// (openEditModal in public/js/assets.js): General, Monitoring, Maintenance.
// Each tab entry opens a stacked `.sheet` that is the phone build of that tab:
//
//   General     — the identity / details / location / procurement / notes /
//                 tags form (assetFormHTML + getAssetFormData). Saves the same
//                 fields with PUT /assets/:id, behind the same two questions
//                 the desktop asks when the IP changes: who else holds that
//                 address (rule 40(i)) and how sure Polaris is of it (rule 103).
//   Monitoring  — monitoring on/off under the status gate (rule 10), the
//                 agent's state, and per stream the polling method, its
//                 credential and MIB, cadence and timeouts
//                 (assetMonitoringFormHTML + _wireMonitorEditTab). The method
//                 vocabulary is polling-methods.js, the file the desktop reads.
//   Maintenance — the windows open now and the schedules covering the asset,
//                 with Remove / Delete, and "enter maintenance until…"
//                 (assetMaintenanceFormHTML). The ad-hoc schedule, its
//                 validation and the server clock are assets-maintenance.js's
//                 own helpers, loaded on first use.
//
// Each sheet saves ONLY its own tab's fields — PUT /assets/:id is a partial
// update — where the desktop modal saves all three tabs in one press. Each
// re-reads the asset when it opens rather than trusting the row the asset
// sheet painted, which may be minutes old.
//
// Desktop-only, by design: Delete Asset (the modal's footer verb), creating a
// registry tag, installing / upgrading the Polaris Agent, the merge review a
// duplicate-IP save can lead to, and the "other asset overrides" list.
//
// Gates mirror the routes: General and Monitoring save with assets:write (the
// PUT's gate); Maintenance reads at assets:read and acts at
// maintenanceManagement:write, so an entry the viewer cannot use is drawn
// disabled with the reason rather than offering a form that can only 403.

(function () {
  "use strict";

  // ─── Permissions (mirrors permAtLeast in app.js) ────────────────────────
  var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
  function permAtLeast(key, level) {
    var user = (window.PolarisMobile && PolarisMobile.user && PolarisMobile.user()) || null;
    var have = (user && user.permissions && user.permissions[key]) || "none";
    return (_PERM_RANK[have] || 0) >= (_PERM_RANK[level] || 0);
  }
  function canEditAsset() { return permAtLeast("assets", "write"); }
  function canManageMaintenance() { return permAtLeast("maintenanceManagement", "write"); }

  function toast(msg, isError) {
    if (window.PolarisTabs && PolarisTabs.showSnackbar) PolarisTabs.showSnackbar(msg, isError ? { error: true } : undefined);
  }

  // ─── Mirrors of desktop constants (lockstep; tests/unit/mobileAssetEdit.test.ts) ──
  // UNMONITORABLE_STATUSES in assets.js — business rule 10.
  var UNMONITORABLE_STATUSES = ["decommissioned", "disabled", "storage", "quarantined"];
  function statusAllowsMonitoring(status) {
    return UNMONITORABLE_STATUSES.indexOf(String(status || "")) === -1;
  }
  // DESCRIPTION_DEVICE_TARGETS in assets.js — the device fields a Description
  // is truncated into on push (warn, never limit).
  var DESCRIPTION_DEVICE_TARGETS = {
    access_point: { cap: 35, device: "FortiAP",   field: "location" },
    firewall:     { cap: 35, device: "FortiGate", field: "alias" },
  };
  // isAssetTypeLocked in assets.js — discovered Fortinet infrastructure keeps
  // its type (the PUT refuses a change too).
  function isAssetTypeLocked(a) {
    if (!a || !a.discoveredByIntegrationId) return false;
    var t = a.assetType;
    return t === "firewall" || t === "switch" || t === "access_point";
  }
  // ASSET_TYPE_OPTIONS seed in assets.js; replaced by /asset-types when it answers.
  var ASSET_TYPE_SEED = [
    { value: "server",       label: "Server" },
    { value: "switch",       label: "Switch" },
    { value: "router",       label: "Router" },
    { value: "firewall",     label: "Firewall" },
    { value: "workstation",  label: "Workstation" },
    { value: "printer",      label: "Printer" },
    { value: "access_point", label: "Access Point" },
    { value: "hypervisor",   label: "Hypervisor" },
    { value: "other",        label: "Other" },
  ];
  var STATUS_OPTIONS = [
    { value: "storage",        label: "Storage" },
    { value: "active",         label: "Active" },
    { value: "maintenance",    label: "Maintenance" },
    { value: "decommissioned", label: "Decommissioned" },
    { value: "disabled",       label: "Disabled" },
  ];
  // isPickerHiddenTag in app.js — the Arc-owned `azure:` namespace is never
  // offered; the server keeps those tags through every operator write.
  function isPickerHiddenTag(name) {
    return String(name == null ? "" : name).toLowerCase().indexOf("azure:") === 0;
  }
  // tagColorCss in app.js, on the phone's severity tokens.
  var TAG_SEVERITY_TOKENS = {
    notice: "--md-sev-notice", informational: "--md-sev-info", warning: "--md-sev-warning",
    serious: "--md-sev-serious", critical: "--md-sev-critical",
  };
  function tagColorCss(color) {
    var m = /^severity:([a-z]+)$/.exec(String(color || ""));
    if (m && TAG_SEVERITY_TOKENS[m[1]]) return "var(" + TAG_SEVERITY_TOKENS[m[1]] + ")";
    return /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(String(color || "")) ? color : "";
  }
  function tagChipStyle(color, on) {
    var c = tagColorCss(color);
    if (!c) return "";
    function tint(p) { return "color-mix(in srgb, " + c + " " + p + "%, transparent)"; }
    return on
      ? "background:" + tint(27) + ";border-color:" + c + ";color:" + c
      : "background:" + tint(7) + ";border-color:" + tint(25) + ";color:" + tint(60);
  }

  // ─── Small helpers ──────────────────────────────────────────────────────
  function esc(s) { return escapeHtml(s == null ? "" : String(s)); }
  function $(id) { return document.getElementById(id); }
  function fieldVal(id) { var el = $(id); return el ? String(el.value || "").trim() : ""; }
  function dateInputVal(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
  }
  function tf(label, controlHtml, supportHtml, wrapAttrs) {
    return '<div class="tf-outlined"' + (wrapAttrs || "") + '><span class="lbl">' + esc(label) + '</span>' +
      controlHtml + (supportHtml ? '<div class="support">' + supportHtml + '</div>' : '') + '</div>';
  }
  function input(id, value, attrs, extraClass) {
    return '<input class="field' + (extraClass ? " " + extraClass : "") + '" id="' + id + '" value="' + esc(value) + '"' + (attrs || "") + '>';
  }
  function optionsHtml(list, current) {
    return list.map(function (o) {
      return '<option value="' + esc(o.value) + '"' + (o.value === current ? " selected" : "") + '>' + esc(o.label) + '</option>';
    }).join("");
  }
  function sectionLabel(text) { return '<div class="ae-section">' + esc(text) + '</div>'; }
  function checkRow(id, label, checked, extra) {
    return '<label class="ae-check" for="' + id + '"><input type="checkbox" id="' + id + '"' +
      (checked ? " checked" : "") + (extra || "") + '><span>' + esc(label) + '</span></label>';
  }

  // Classic script loaded once, on demand — the phone's _loadPanelScript.
  // `readyGlobal` names what the script leaves behind; already present means
  // already loaded.
  var _scriptLoads = {};
  function loadScriptOnce(src, readyGlobal) {
    if (readyGlobal && typeof window[readyGlobal] === "function") return Promise.resolve();
    if (_scriptLoads[src]) return _scriptLoads[src];
    _scriptLoads[src] = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { delete _scriptLoads[src]; reject(new Error("Couldn’t load " + src)); };
      document.head.appendChild(s);
    });
    return _scriptLoads[src];
  }

  // ─── Sheet plumbing ─────────────────────────────────────────────────────
  // Every sheet here is a generic `.sheet` (1000/1001), stacked over the asset
  // sheet (900/901) and the navbar; questions asked from inside one stack at
  // 1010/1011 like confirmClear in mobile/alerts.js.
  function removeSheet(id) {
    var s = $(id), sc = $(id + "-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }
  function buildSheet(id, onClose) {
    removeSheet(id);
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = id + "-scrim";
    var sheet = document.createElement("div");
    sheet.className = "sheet ae-sheet";
    sheet.id = id;
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    scrim.addEventListener("click", onClose);
    PolarisTabs.attachSwipeToDismiss(sheet, onClose);
    return sheet;
  }
  function sheetHeader(title, sub, closeId) {
    return '<div class="sheet-handle"></div>' +
      '<div class="ae-head">' +
        '<div class="ae-head-text"><h3 class="sheet-title">' + esc(title) + '</h3>' +
          (sub ? '<div class="ae-sub">' + esc(sub) + '</div>' : '') + '</div>' +
        '<button class="icon-btn" id="' + closeId + '" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>' +
      '</div>';
  }

  // A question as a sheet (never window.confirm — suppressed in some installed
  // PWAs). Resolves true on the OK button, false on anything else.
  function confirmSheet(o) {
    return new Promise(function (resolve) {
      var scrim = document.createElement("div");
      scrim.className = "scrim";
      scrim.style.zIndex = "1010";
      var sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.style.zIndex = "1011";
      sheet.id = "ae-confirm-sheet";
      sheet.innerHTML = '<div class="sheet-handle"></div>' +
        '<h3 class="sheet-title" style="margin:0 0 8px;">' + esc(o.title) + '</h3>' +
        '<p class="ae-confirm-body">' + esc(o.body) + '</p>' +
        '<div class="ae-actions">' +
          '<button type="button" class="btn btn-outlined" id="ae-confirm-cancel">' + esc(o.cancel || "Cancel") + '</button>' +
          '<button type="button" class="btn ' + (o.danger ? "btn-error" : "btn-filled") + '" id="ae-confirm-ok">' + esc(o.ok || "OK") + '</button>' +
        '</div>';
      document.body.appendChild(scrim);
      document.body.appendChild(sheet);
      var done = false;
      function close(v) { if (done) return; done = true; scrim.remove(); sheet.remove(); resolve(v); }
      scrim.addEventListener("click", function () { close(false); });
      sheet.querySelector("#ae-confirm-cancel").addEventListener("click", function () { close(false); });
      sheet.querySelector("#ae-confirm-ok").addEventListener("click", function () { close(true); });
      PolarisTabs.attachSwipeToDismiss(sheet, function () { close(false); });
    });
  }

  // ─── The menu ───────────────────────────────────────────────────────────
  // One entry per tab of the desktop's Edit Asset modal, in its order.
  var TABS = [
    { key: "general", label: "General", icon: "i-info",
      desc: "Name, address, details, location, procurement, notes, tags",
      allowed: canEditAsset, denied: "Needs Read-Write on Assets" },
    { key: "monitoring", label: "Monitoring", icon: "i-target",
      desc: "Monitoring on/off, polling methods, intervals, timeouts",
      allowed: canEditAsset, denied: "Needs Read-Write on Assets" },
    { key: "maintenance", label: "Maintenance", icon: "i-construction",
      desc: "Open windows, covering schedules, enter maintenance",
      allowed: function () { return true; }, denied: "" },
  ];

  var MENU_ID = "asset-edit-menu";
  var EDIT_ID = "asset-edit-sheet";
  var _token = 0;          // bumped per sheet open; late loads for a closed sheet bail
  var _ctx = null;         // { assetId, hostname, onSaved }

  // ─── The device verbs above the tabs ────────────────────────────────────
  // The desktop panel header's Discover Now and Reboot, as menu rows. Neither
  // is decided here: POST /assets/:id/rediscover answers a 400 naming why an
  // asset has no re-runnable discovery (assetDiscoveryScope.ts), and GET
  // /assets/:id/reboot says what may reboot it. The rows only describe and
  // relay; the reboot's confirm sheet is asset-detail.js's (opts.onReboot).
  /** The Discover Now row's supporting line. Pure. */
  function discoverDesc(a) {
    var role = a && a.fortinetTopology && a.fortinetTopology.role;
    if (role === "fortiswitch" || role === "fortiap") return "Runs its controller FortiGate’s discovery";
    if (role === "fortigate") return "Refresh this FortiGate’s subnets, reservations, switches and APs";
    return "Re-read this device from its integration";
  }

  /** The Reboot row's state for one availability answer: null = no row. Pure. */
  function rebootRowState(rb, canAct) {
    if (!rb || rb.error || !rb.state || rb.state === "unsupported") return null;
    if (rb.activeRun) return { enabled: false, desc: "Reboot in progress" };
    var schedulable = !!REBOOT_SCHEDULABLE[rb.state];
    if (!rb.available && !schedulable) return { enabled: false, desc: rb.reason || "This device cannot be rebooted from Polaris" };
    if (!canAct) return { enabled: false, desc: "Needs Read-Write on Assets" };
    if (!rb.available) return { enabled: true, desc: (rb.reason || "Not right now.") + " It can be scheduled for later." };
    if (rb.schedule) return { enabled: true, desc: "A reboot is already scheduled — this reboots now" };
    return { enabled: true, desc: "Restart now or schedule it" };
  }
  /** States a booking can still be made from (RB_SCHEDULABLE in asset-detail.js). */
  var REBOOT_SCHEDULABLE = { available: true, blocked: true, "agent-offline": true };

  function actionRowHtml(id, icon, label, desc, enabled) {
    return '<button type="button" class="list-item two-line ae-menu-action" role="menuitem" id="' + id + '"' +
        (enabled ? '' : ' disabled aria-disabled="true"') + '>' +
      '<div class="leading tonal"><svg viewBox="0 0 24 24"><use href="#' + icon + '"/></svg></div>' +
      '<div class="content"><div class="headline">' + esc(label) + '</div>' +
        '<div class="supporting">' + esc(desc) + '</div></div>' +
    '</button>';
  }

  function runDiscoverNow(assetId) {
    api.assets.rediscover(assetId).then(function (resp) {
      toast(resp && resp.viaController && resp.deviceName
        ? "Discovering via controller " + resp.deviceName + " — tap Refresh in a minute or two"
        : "Discovery started — tap Refresh in a minute or two");
    }).catch(function (err) {
      toast((err && err.message) || "Discovery failed to start", true);
    });
  }

  // Fill the Reboot row once GET /assets/:id/reboot answers; drop it (and the
  // section, if Discover Now is not there either) when nothing can reboot it.
  function loadRebootRow(assetId, onReboot) {
    if (!api.assets.reboot || !permAtLeast("assets", "read")) { dropRebootRow(); return; }
    api.assets.reboot(assetId).then(function (rb) {
      var row = $("ae-action-reboot");
      if (!row || !_ctx || _ctx.assetId !== assetId) return;
      var st = rebootRowState(rb, canEditAsset());
      if (!st || !onReboot) { dropRebootRow(); return; }
      row.querySelector(".supporting").textContent = st.desc;
      row.disabled = !st.enabled;
      if (st.enabled) row.removeAttribute("aria-disabled"); else row.setAttribute("aria-disabled", "true");
      row.addEventListener("click", function () {
        if (row.disabled) return;
        closeMenu();
        onReboot(rb);
      });
    }).catch(dropRebootRow);
  }
  function dropRebootRow() {
    var row = $("ae-action-reboot");
    if (row) row.remove();
    var sec = $("ae-menu-actions");
    if (sec && !sec.querySelector(".ae-menu-action")) sec.remove();
  }

  function closeMenu() { removeSheet(MENU_ID); }
  function closeEdit() { _token++; removeSheet(EDIT_ID); removeSheet("ae-confirm-sheet"); }
  function closeAll() { closeMenu(); closeEdit(); }

  /**
   * Open the edit menu for an asset.
   * @param {{id:string, hostname?:string, assetTag?:string}} asset
   * @param {{onSaved?: function, onReboot?: function}} [opts] — onSaved is
   *        called after any sheet saves, so the asset sheet behind can repaint;
   *        onReboot(rb) starts the asset sheet's reboot confirm for the
   *        availability answer the Reboot row was drawn from (no row without it).
   */
  function openMenu(asset, opts) {
    if (!asset || !asset.id) return;
    closeAll();
    _ctx = {
      assetId: asset.id,
      hostname: asset.hostname || asset.assetTag || "",
      onSaved: opts && typeof opts.onSaved === "function" ? opts.onSaved : null,
    };
    var onReboot = opts && typeof opts.onReboot === "function" ? opts.onReboot : null;
    var canDiscover = canEditAsset();
    var sheet = buildSheet(MENU_ID, closeMenu);
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Asset actions");
    sheet.innerHTML = sheetHeader("Asset actions", _ctx.hostname, "ae-menu-close") +
      // Discover Now, then Reboot — the desktop header's order. Reboot starts
      // as "Checking…" and is filled (or dropped) by loadRebootRow.
      '<div class="ae-menu" id="ae-menu-actions" role="menu" aria-label="Actions">' +
        actionRowHtml("ae-action-discover", "i-sync", "Discover Now",
          canDiscover ? discoverDesc(asset) : "Needs Read-Write on Assets", canDiscover) +
        (onReboot ? actionRowHtml("ae-action-reboot", "i-power", "Reboot", "Checking…", false) : "") +
      '</div>' +
      '<div class="ae-menu" role="menu" aria-label="Edit">' +
      TABS.map(function (t) {
        var ok = t.allowed();
        return '<button type="button" class="list-item two-line ae-menu-item" role="menuitem" data-tab="' + t.key + '"' +
            (ok ? '' : ' disabled aria-disabled="true"') + '>' +
          '<div class="leading tonal"><svg viewBox="0 0 24 24"><use href="#' + t.icon + '"/></svg></div>' +
          '<div class="content"><div class="headline">' + esc(t.label) + '</div>' +
            '<div class="supporting">' + esc(ok ? t.desc : t.denied) + '</div></div>' +
          '<div class="trailing"><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></div>' +
        '</button>';
      }).join("") +
      '</div>';
    // Pinned header band (handle + title row) — reachable from the bottom of the sheet.
    if (window.PolarisTabs && PolarisTabs.pinSheetHead) PolarisTabs.pinSheetHead(sheet);
    $("ae-menu-close").addEventListener("click", closeMenu);
    var discoverRow = $("ae-action-discover");
    if (discoverRow) discoverRow.addEventListener("click", function () {
      if (discoverRow.disabled) return;
      var id = _ctx.assetId;
      closeMenu();
      runDiscoverNow(id);
    });
    if (onReboot) loadRebootRow(asset.id, onReboot);
    sheet.querySelectorAll(".ae-menu-item").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.disabled) return;
        var key = b.getAttribute("data-tab");
        closeMenu();
        openTab(key);
      });
    });
  }

  // Open one tab's sheet for the asset the menu was opened on.
  function openTab(key) {
    if (!_ctx) return;
    var tab = TABS.filter(function (t) { return t.key === key; })[0];
    if (!tab) return;
    if (!tab.allowed()) { toast(tab.denied, true); return; }
    closeEdit();
    var token = ++_token;
    var sheet = buildSheet(EDIT_ID, closeEdit);
    sheet.setAttribute("data-tab", key);
    sheet.innerHTML = sheetHeader(tab.label, _ctx.hostname, "ae-close") +
      '<div id="ae-error" class="ae-error" hidden></div>' +
      '<div id="ae-body"><div class="loading-screen" style="padding:32px 0;"><div class="spinner"></div></div></div>';
    // Pinned header band (handle + title row) — reachable from the bottom of the sheet.
    if (window.PolarisTabs && PolarisTabs.pinSheetHead) PolarisTabs.pinSheetHead(sheet);
    $("ae-close").addEventListener("click", closeEdit);
    var loader = key === "general" ? loadGeneral : key === "monitoring" ? loadMonitoring : loadMaintenance;
    loader(_ctx.assetId, token).catch(function (err) {
      if (token !== _token) return;
      var body = $("ae-body");
      if (body) body.innerHTML = '<div class="empty-state" style="padding:32px 0;"><div class="ttl">Couldn’t load asset</div>' +
        '<div class="desc">' + esc((err && err.message) || "error") + '</div></div>';
    });
  }

  function setError(msg) {
    var el = $("ae-error");
    if (!el) return;
    el.textContent = msg || "";
    el.hidden = !msg;
    if (msg) { var s = $(EDIT_ID); if (s) s.scrollTop = 0; }
  }
  function footerHtml(saveLabel) {
    return '<div class="ae-actions ae-footer">' +
      '<button type="button" class="btn btn-text" id="ae-cancel">Cancel</button>' +
      (saveLabel ? '<button type="button" class="btn btn-filled" id="ae-save">' + esc(saveLabel) + '</button>' : '') +
    '</div>';
  }
  function afterSave(message) {
    var onSaved = _ctx && _ctx.onSaved;
    closeEdit();
    toast(message);
    if (onSaved) { try { onSaved(); } catch (_) { /* the repaint is best-effort */ } }
  }
  function wireSave(handler) {
    $("ae-cancel").addEventListener("click", closeEdit);
    var btn = $("ae-save");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      btn.disabled = true;
      setError("");
      Promise.resolve().then(handler).catch(function (err) {
        setError((err && err.message) || "Save failed");
      }).then(function () { btn.disabled = false; });
    });
  }

  // ═══ General ════════════════════════════════════════════════════════════
  var _tagCatalog = null;   // { enforce, tags, failed } — read once per page
  function loadTagCatalog() {
    if (_tagCatalog) return Promise.resolve(_tagCatalog);
    return api.serverSettings.tagCatalog().then(function (p) {
      _tagCatalog = {
        tags: ((p && p.tags) || []).filter(function (t) { return t && !isPickerHiddenTag(t.name); }),
        failed: false,
      };
      return _tagCatalog;
    }).catch(function () {
      return { tags: [], failed: true };   // not cached: the next open retries
    });
  }
  var _assetTypes = null;
  function loadAssetTypes() {
    if (_assetTypes) return Promise.resolve(_assetTypes);
    return api.assetTypes.list().then(function (res) {
      var rows = Array.isArray(res) ? res : (res && res.types) || [];
      rows = rows.filter(function (t) { return t && t.name; })
        .map(function (t) { return { value: String(t.name), label: String(t.label || t.name) }; });
      _assetTypes = rows.length ? rows : ASSET_TYPE_SEED;
      return _assetTypes;
    }).catch(function () { return ASSET_TYPE_SEED; });
  }

  function loadGeneral(id, token) {
    return Promise.all([api.assets.get(id), loadTagCatalog(), loadAssetTypes()]).then(function (r) {
      if (token !== _token) return;
      renderGeneral(r[0], r[1], r[2]);
    });
  }

  function tagPickerHtml(selected, catalog) {
    var cats = {}, registered = {};
    catalog.tags.forEach(function (t) {
      var c = t.category || "General";
      (cats[c] = cats[c] || []).push(t);
      registered[t.name] = true;
    });
    // A tag the asset carries with no registry row (discovery's own, or one
    // applied before the registry had it) is drawn ticked so a save keeps it —
    // the desktop picker's "Not in tag list" group.
    var unlisted = selected.filter(function (n, i) {
      return !registered[n] && !isPickerHiddenTag(n) && selected.indexOf(n) === i;
    });
    function chip(name, color) {
      var on = selected.indexOf(name) !== -1;
      return '<label class="chip ae-tag' + (on ? ' selected' : '') + '" data-color="' + esc(color || "") + '" style="' + tagChipStyle(color, on) + '">' +
        '<input type="checkbox" name="ae-tag" value="' + esc(name) + '"' + (on ? ' checked' : '') + '>' + esc(name) + '</label>';
    }
    if (!catalog.tags.length && !unlisted.length) {
      return '<p class="ae-hint">' + (catalog.failed
        ? "Couldn’t load the tag list."
        : "No tags defined yet. An administrator adds them under Server Settings → Tags.") + '</p>';
    }
    var html = Object.keys(cats).sort().map(function (c) {
      return '<div class="ae-tag-cat">' + esc(c) + '</div><div class="chip-row wrap ae-tag-row">' +
        cats[c].map(function (t) { return chip(t.name, t.color); }).join("") + '</div>' +
        (c === "Map Regions"
          ? '<p class="ae-hint">Auto-applied to devices inside a Device Map region — removing one from a device still in the region re-adds it on the next reconcile.</p>'
          : '');
    }).join("");
    if (unlisted.length) {
      html += '<div class="ae-tag-cat">Not in tag list</div><div class="chip-row wrap ae-tag-row">' +
        unlisted.map(function (n) { return chip(n, ""); }).join("") + '</div>' +
        '<p class="ae-hint">Added by discovery or before the tag list had them. Kept on save unless you untick one.</p>';
    }
    return html;
  }

  function renderGeneral(a, catalog, types) {
    var body = $("ae-body");
    if (!body) return;
    var locked = isAssetTypeLocked(a);
    var typeOpts = types.slice();
    var curType = a.assetType || "other";
    if (!typeOpts.some(function (o) { return o.value === curType; })) typeOpts.push({ value: curType, label: curType });
    var target = (a.discoveredByIntegration && a.discoveredByIntegration.syncDescriptions === true)
      ? DESCRIPTION_DEVICE_TARGETS[a.assetType] || null : null;

    var hostHint = a.hostnameOverride
      ? "Manually overridden — clear the field to resume the discovered hostname."
      : (a.discoveredByIntegrationId ? "Discovered — saving a change pins it as a manual override." : "");
    var ipHint = a.ipBlankPinned
      ? "Manually cleared — discovery will not put an address back; one it reports raises a conflict."
      : a.ipOverride
        ? "Manually overridden. A matching discovered address releases the override; a different one raises a conflict."
        : (a.discoveredByIntegrationId ? "Discovered — saving a change pins it as a manual override. Clearing it leaves the asset with no address." : "");
    var coordHint = a.coordSource === "manual"
      ? "Coordinates are manually pinned — clear both to resume discovered values."
      : (a.latitude != null ? "Discovered from the device — saving a change pins them as manual." : "");

    body.innerHTML = '<form id="ae-form" autocomplete="off">' +
      tf("Hostname", input("ae-hostname", a.hostname || "", ' placeholder="e.g. server-01"'), esc(hostHint)) +
      tf("DNS name", '<div class="field ae-static">' + esc(a.dnsName || "—") + '</div>') +
      tf("IP address", input("ae-ipAddress", a.ipAddress || "",
          ' autocapitalize="off" spellcheck="false" placeholder="' + (a.ipBlankPinned ? "no address (cleared)" : "e.g. 10.0.1.50") + '"', "mono"),
        esc(ipHint) + ((a.ipBlankPinned || a.ipOverride)
          ? ' <button type="button" class="btn btn-text ae-inline-btn" id="ae-ipRevert">Revert to discovered IP</button>' : '')) +
      tf("Serial number", input("ae-serialNumber", a.serialNumber || "", ' placeholder="e.g. SN-DELL-001"')) +

      sectionLabel("Asset details") +
      tf("Asset tag", input("ae-assetTag", a.assetTag || "", ' placeholder="e.g. ACME-00421"')) +
      tf("Manufacturer", input("ae-manufacturer", a.manufacturer || "", ' placeholder="e.g. Dell, Cisco, HP"')) +
      tf("Model", input("ae-model", a.model || "", ' placeholder="e.g. PowerEdge R740"')) +
      tf("Type", '<select class="field" id="ae-assetType"' + (locked ? ' disabled' : '') + '>' + optionsHtml(typeOpts, curType) + '</select>',
        locked ? "Locked — discovered by an integration." : "") +
      tf("Status", '<select class="field" id="ae-status">' + optionsHtml(STATUS_OPTIONS, a.status || "active") + '</select>') +

      sectionLabel("Location & ownership") +
      tf("Location", input("ae-location", a.location || a.snmpLocation || "", ' placeholder="e.g. DC1 Rack A3"'),
        [!a.location && a.snmpLocation ? "Pre-filled from SNMP sysLocation — Save to adopt it." : "",
         a.learnedLocation ? "Learned: " + esc(a.learnedLocation) : ""].filter(Boolean).join(" ")) +
      tf("Department", input("ae-department", a.department || "", ' placeholder="e.g. Infrastructure"')) +
      tf("Assigned to", input("ae-assignedTo", a.assignedTo || "", ' placeholder="e.g. platform-team"')) +
      tf("Operating system", input("ae-os", a.os || "", ' placeholder="e.g. RHEL 9, Windows Server 2022"')) +
      '<div class="ae-pair">' +
        tf("Latitude", input("ae-latitude", a.latitude != null ? String(a.latitude) : "", ' type="number" step="any" min="-90" max="90" inputmode="decimal"')) +
        tf("Longitude", input("ae-longitude", a.longitude != null ? String(a.longitude) : "", ' type="number" step="any" min="-180" max="180" inputmode="decimal"')) +
      '</div>' +
      (coordHint ? '<p class="ae-hint ae-hint-tight">' + esc(coordHint) + '</p>' : '') +

      sectionLabel("Procurement") +
      '<div class="ae-pair">' +
        tf("Acquired", input("ae-acquiredAt", dateInputVal(a.acquiredAt), ' type="date"')) +
        tf("Warranty expires", input("ae-warrantyExpiry", dateInputVal(a.warrantyExpiry), ' type="date"')) +
      '</div>' +
      tf("Purchase order", input("ae-purchaseOrder", a.purchaseOrder || "", ' placeholder="PO-12345"')) +

      sectionLabel("Description & notes") +
      tf("Description", input("ae-description", a.description || "", ' maxlength="255" placeholder="e.g. b:Shop f:2 r:North Closet"'),
        "Device Map grouping codes: <code>a:</code>area <code>b:</code>building <code>f:</code>floor <code>r:</code>room <code>jb:</code>junction box." +
        (target ? ' Written to the ' + esc(target.device) + ' <code>' + esc(target.field) + '</code> by Description Sync.' : '') +
        (target ? '<span id="ae-desc-cap" class="ae-warn" data-cap="' + target.cap + '" hidden></span>' : '')) +
      tf("Notes", '<textarea class="field" id="ae-notes" rows="3" placeholder="Optional notes">' + esc(a.notes || "") + '</textarea>') +

      sectionLabel("Tags") +
      '<div id="ae-tags">' + tagPickerHtml(a.tags || [], catalog) + '</div>' +
    '</form>' + footerHtml("Save");

    // Tag chips: the label owns the checkbox; repaint its colour on toggle.
    body.querySelectorAll(".ae-tag input").forEach(function (cb) {
      cb.addEventListener("change", function () {
        var chip = cb.parentElement;
        chip.classList.toggle("selected", cb.checked);
        chip.setAttribute("style", tagChipStyle(chip.getAttribute("data-color"), cb.checked));
      });
    });
    var revert = $("ae-ipRevert");
    var ipEl = $("ae-ipAddress");
    if (revert && ipEl) {
      revert.addEventListener("click", function () {
        ipEl.setAttribute("data-ip-revert", "1");
        ipEl.value = "";
        ipEl.placeholder = "discovered address — applied on save";
        revert.parentNode.textContent = "Will revert to the discovered address on save.";
      });
      ipEl.addEventListener("input", function () {
        if (ipEl.value.trim() !== "") ipEl.removeAttribute("data-ip-revert");
      });
    }
    wireDescriptionCap();
    wireSave(function () { return saveGeneral(a); });
  }

  // Live "over the device limit" line, as wireDescriptionCapWarning.
  function wireDescriptionCap() {
    var inp = $("ae-description"), warn = $("ae-desc-cap");
    if (!inp || !warn) return;
    var cap = parseInt(warn.getAttribute("data-cap"), 10);
    function update() {
      var len = inp.value.length;
      warn.hidden = !(len > cap);
      if (len > cap) warn.textContent = " Over the device limit: " + len + " characters, cut to " + cap + " on the device (“" + inp.value.slice(0, cap) + "”). Polaris keeps the full text.";
    }
    inp.addEventListener("input", update);
    update();
  }

  // The General fields, shaped exactly as getAssetFormData sends them.
  function readGeneral() {
    var acq = fieldVal("ae-acquiredAt"), war = fieldVal("ae-warrantyExpiry");
    var desc = $("ae-description").value;
    if (desc.length > 255) desc = desc.slice(0, 255);
    var tags = [];
    document.querySelectorAll('#ae-tags input[name="ae-tag"]:checked').forEach(function (cb) { tags.push(cb.value); });
    var data = {
      assetTag:       fieldVal("ae-assetTag") || undefined,
      manufacturer:   fieldVal("ae-manufacturer") || undefined,
      model:          fieldVal("ae-model") || undefined,
      assetType:      $("ae-assetType").value,
      status:         $("ae-status").value,
      location:       fieldVal("ae-location"),            // "" clears
      department:     fieldVal("ae-department") || undefined,
      assignedTo:     fieldVal("ae-assignedTo") || undefined,
      os:             fieldVal("ae-os") || undefined,
      acquiredAt:     acq ? new Date(acq).toISOString() : undefined,
      warrantyExpiry: war ? new Date(war).toISOString() : undefined,
      purchaseOrder:  fieldVal("ae-purchaseOrder") || undefined,
      notes:          fieldVal("ae-notes"),               // "" clears
      description:    desc,                               // "" clears
      tags:           tags,
      hostname:       fieldVal("ae-hostname"),            // "" releases the override
      ipAddress:      fieldVal("ae-ipAddress"),           // "" pins no address
      serialNumber:   fieldVal("ae-serialNumber") || undefined,
    };
    if ($("ae-ipAddress").getAttribute("data-ip-revert") === "1") data.ipRevertToDiscovered = true;
    var latRaw = fieldVal("ae-latitude"), lngRaw = fieldVal("ae-longitude");
    if (!latRaw && !lngRaw) { data.latitude = null; data.longitude = null; }
    else {
      var lat = parseFloat(latRaw), lng = parseFloat(lngRaw);
      if (!isFinite(lat) || !isFinite(lng)) throw new Error("Latitude and longitude must both be set, or both left blank");
      data.latitude = lat; data.longitude = lng;
    }
    return data;
  }

  function saveGeneral(asset) {
    var data = readGeneral();
    var typed = (data.ipAddress || "").trim();
    // Rule 40(i) / rule 103: only a CHANGED address is a new claim worth asking about.
    var ipChanged = !data.ipRevertToDiscovered && typed !== "" && typed !== (asset.ipAddress || "");
    return Promise.resolve(ipChanged ? preflightDuplicateIp(typed, asset.id, data) : true).then(function (go) {
      if (!go) return false;
      return ipChanged ? confirmAddressConfidence(asset.id, typed) : true;
    }).then(function (go) {
      if (!go) return;
      return api.assets.update(asset.id, data).then(function (updated) {
        afterSave(updated && updated.ipConflict
          ? "Asset updated — duplicate IP submitted for conflict review"
          : "Asset updated");
      });
    });
  }

  // Rule 40(i), as _preflightDuplicateIp: tell the person about to cause an
  // address collision BEFORE it lands. The merge-review option is the
  // desktop's; here the choice is save-and-review or don't. A failed check
  // never blocks the save.
  function preflightDuplicateIp(ip, assetId, data) {
    return api.assets.ipCheck({
      ip: ip, excludeAssetId: assetId,
      assetType: data.assetType || undefined,
    }).catch(function () { return null; }).then(function (check) {
      if (!check || !check.wouldConflict || !Array.isArray(check.holders) || !check.holders.length) return true;
      var current = check.holders.filter(function (h) { return h.claimCurrent; });
      var lines = [ip + " is already recorded on " + (current.length === 1 ? "another asset:" : current.length + " other assets:")];
      current.forEach(function (h) {
        var bits = [h.hostname || h.assetId, h.assetType || "unknown type", h.status || ""];
        var seen = h.ipLastSeen || h.lastSeen;
        if (h.pinned) bits.push("address pinned by an operator");
        else if (seen) bits.push("address confirmed " + timeAgo(seen));
        lines.push("• " + bits.filter(Boolean).join(" · "));
      });
      lines.push("", "Saving keeps your address and raises a Duplicate IP conflict for review. " +
        "If the two are the same device, merge them from the conflict card on the desktop.");
      return confirmSheet({ title: "Address already in use", body: lines.join("\n"), ok: "Save & submit for review" });
    });
  }

  // Rule 103, as _confirmAddressConfidence (probe on: a typed address).
  var CONF_BAND_LABEL = { "high": "high", "medium": "medium", "low": "low", "very-low": "very low" };
  function confHours(h) {
    if (!(h > 0)) return "";
    if (h < 1) return Math.max(1, Math.round(h * 60)) + " min";
    if (h < 48) return (Math.round(h * 10) / 10) + " h";
    var d = Math.floor(h / 24);
    return d + " d " + Math.round(h - d * 24) + " h";
  }
  function confirmAddressConfidence(assetId, ip) {
    return api.assets.addressCheck(assetId, ip, true).catch(function () { return null; }).then(function (check) {
      if (!check || !check.warn) return true;
      var lines = [ip + " has " + (CONF_BAND_LABEL[check.evidenceBand] || check.evidenceBand) +
        " confidence (" + check.evidenceScore + ", below " + check.warnBelow + ")."];
      if (!check.parts || !check.parts.length) lines.push("Polaris has never seen this address on this device.");
      else lines.push("What Polaris has: " + check.parts.map(function (p) {
        var where = p.device ? " on " + p.device : "";
        var when = p.kind === "polling" ? " for " + confHours(p.hours) : (p.seenAt ? ", " + timeAgo(p.seenAt) : "");
        return p.label + where + when;
      }).join("; ") + ".");
      (check.penalties || []).forEach(function (p) { lines.push(p.detail + "."); });
      if (check.probe) {
        lines.push(check.probe.answered
          ? "It answered a ping from this server just now (that shows something is there, not that it is this device)."
          : "It did not answer a ping from this server" + (check.probe.error ? " (" + check.probe.error + ")" : "") + ".");
      }
      return confirmSheet({ title: "Low-confidence address", body: lines.join("\n"), ok: "Use it anyway" });
    });
  }

  // ═══ Monitoring ═════════════════════════════════════════════════════════
  // The desktop's six stream subtabs, in its order. `stream` is the key the
  // polling vocabulary uses (cpuMemory is "telemetry" there).
  var STREAMS = [
    { key: "responseTime", label: "Response Time",    stream: "responseTime", poll: "responseTimePolling", cred: "responseTimeCredentialId", mib: "responseTimeMibId", mibKey: "responseTime" },
    { key: "cpuMemory",    label: "CPU/Memory",       stream: "telemetry",    poll: "cpuMemoryPolling",    cred: "cpuMemoryCredentialId",    mib: "cpuMemoryMibId",    mibKey: "telemetry" },
    { key: "temperature",  label: "Hardware Sensors", stream: "temperature",  poll: "temperaturePolling",  cred: "temperatureCredentialId",  mib: "temperatureMibId",  mibKey: "temperature" },
    { key: "interfaces",   label: "Interfaces",       stream: "interfaces",   poll: "interfacesPolling",   cred: "interfacesCredentialId",   mib: "interfacesMibId",   mibKey: "interfaces" },
    { key: "lldp",         label: "LLDP",             stream: "lldp",         poll: "lldpPolling",         cred: "lldpCredentialId",         mib: "lldpMibId",         mibKey: "lldp" },
    // Storage has no credential or MIB column of its own: the SNMP walk reuses
    // the interfaces stream's session, HOST-RESOURCES-MIB + the vendor fallback.
    { key: "storage",      label: "Storage",          stream: "storage",      poll: "storagePolling",      cred: null,                       mib: null,                mibKey: null },
  ];
  var IN_FLIGHT = ["pending", "uploading", "enrolling", "upgrading", "uninstalling"];
  var AGENT_STATUS = {
    pending: "Pending — install queued", uploading: "Uploading binary", enrolling: "Awaiting enrollment",
    active: "Active", upgrading: "Upgrading", uninstalling: "Uninstalling",
  };

  function loadMonitoring(id, token) {
    return Promise.all([
      api.assets.get(id),
      api.assets.agent(id).catch(function () { return null; }),
      api.credentials.list().catch(function () { return []; }),
      api.assets.effectiveMonitorSettings(id).catch(function () { return null; }),
    ]).then(function (r) {
      if (token !== _token) return;
      renderMonitoring(r[0], r[1], Array.isArray(r[2]) ? r[2] : [], r[3]);
    });
  }

  function numInput(id, value, min, max) {
    return input(id, value == null ? "" : String(value),
      ' type="number" inputmode="numeric" min="' + min + '" max="' + max + '" placeholder="Blank inherits"');
  }

  function renderMonitoring(a, agent, creds, eff) {
    var body = $("ae-body");
    if (!body) return;
    var source = (a.discoveredByIntegration && a.discoveredByIntegration.type) || "manual";
    if (!_POLLING_COMPAT[source]) source = "manual";
    var autoMib = _autoMibNamesForAsset(a);
    var streams = STREAMS.filter(function (s) {
      // A container / App has no sensors, disks or LLDP of its own.
      return a.assetType !== "container" || (s.key !== "temperature" && s.key !== "lldp" && s.key !== "storage");
    });
    var agentActive = !!(agent && agent.installStatus === "active");
    var agentInFlight = !!(agent && IN_FLIGHT.indexOf(agent.installStatus) !== -1);
    var transportShown = !(agentActive || agentInFlight);

    function streamBody(s) {
      var cur = a[s.poll] || "";
      var html = tf("Polling method", _polarisPollingDropdownHTML("ae-" + s.poll, source, s.stream, cur).replace("<select ", '<select class="field" '),
        '“Inherit” falls through to the class / integration / manual / source-default tiers.');
      if (s.cred) {
        html += tf("Credential", '<select class="field" id="ae-' + s.cred + '" data-current-id="' + esc(a[s.cred] || "") + '"></select>',
          '<span id="ae-' + s.cred + '-hint" hidden>This stream stores a credential. It is still used whenever the inherited method takes that type — choose “Source default” to clear it.</span>',
          ' id="ae-' + s.cred + '-wrap" hidden');
      }
      if (s.mib) {
        html += tf("MIB", '<select class="field" id="ae-' + s.mib + '" data-mib-picker="1" data-current-id="' + esc(a[s.mib] || "") +
            '" data-auto-mib-name="' + esc(autoMib[s.mibKey] || "") + '">' + _mibOptionsHTML(a[s.mib] || "", autoMib[s.mibKey]) + '</select>',
          "", ' id="ae-' + s.mib + '-wrap" hidden');
      }
      if (s.key === "responseTime") {
        html += tf("HTTP check path override", input("ae-httpCheckPath", a.httpCheckPath || "", ' maxlength="1024" placeholder="/"'),
            "For an HTTP-check widget on this device’s manufacturer profile. Blank uses the widget’s own path.") +
          tf("Poll interval (seconds)", numInput("ae-monitorIntervalSec", a.monitorIntervalSec, 5, 86400),
            '<span id="ae-tier-intervalSeconds"></span> Minimum 5.') +
          tf("Probe timeout (ms)", numInput("ae-probeTimeoutMs", a.probeTimeoutMs, 100, 60000),
            '<span id="ae-tier-probeTimeoutMs"></span> 100–60000; default 5000.' +
            '<span class="ae-warn" id="ae-probe-warn" hidden> Below 500 ms, probes will likely false-fail.</span>') +
          '<div class="ae-section ae-section-sub">Declaring Down</div><p class="ae-hint" id="ae-down-detection">Resolving…</p>';
      } else if (s.key === "cpuMemory") {
        html += tf("CPU/Memory timeout (ms)", numInput("ae-cpuMemoryTimeoutMs", a.cpuMemoryTimeoutMs, 1000, 120000),
          '<span id="ae-tier-cpuMemoryTimeoutMs"></span> 1000–120000; default 10000.');
      } else if (s.key === "temperature") {
        html += tf("Hardware sensor timeout (ms)", numInput("ae-temperatureTimeoutMs", a.temperatureTimeoutMs, 1000, 120000),
          '<span id="ae-tier-temperatureTimeoutMs"></span> 1000–120000; default 10000.');
      } else if (s.key === "interfaces") {
        html += tf("System info timeout (ms)", numInput("ae-systemInfoTimeoutMs", a.systemInfoTimeoutMs, 1000, 120000),
          '<span id="ae-tier-systemInfoTimeoutMs"></span> Interfaces, storage and LLDP. 1000–120000; default 10000.');
      } else {
        html += '<p class="ae-hint">Cadence and timeout for this stream are shared with <strong>Interfaces</strong> at the per-asset tier — set them there.</p>';
      }
      return html;
    }

    var agentHtml = "";
    if (agentActive || agentInFlight) {
      agentHtml = '<div class="card-filled ae-agent">' +
        '<div class="ae-agent-head"><strong>Polaris Agent</strong><span class="ae-pill' + (agentActive ? ' ok' : '') + '">' +
          esc(AGENT_STATUS[agent.installStatus] || agent.installStatus) + '</span></div>' +
        '<p class="ae-hint">' + (agentActive
          ? "Agent v" + esc(agent.agentVersion || "?") + " owns this host’s monitoring streams, so polling methods are not set here."
          : "An install or uninstall is in flight; polling methods return when it settles.") + '</p></div>';
    }

    body.innerHTML = '<form id="ae-form" autocomplete="off">' +
      checkRow("ae-monitored", "Enable monitoring for this asset", !!a.monitored) +
      '<p class="ae-hint">A successful probe means the credential authenticated. Failed probes count as packet loss.</p>' +
      '<p class="ae-hint ae-warn" id="ae-monitored-blocked" hidden></p>' +
      agentHtml +
      (transportShown
        ? '<div id="ae-transport">' +
            sectionLabel("Polling methods") +
            '<div class="chip-row wrap ae-streams" role="tablist">' +
              streams.map(function (s, i) {
                return '<button type="button" class="chip' + (i === 0 ? ' selected' : '') + '" role="tab" data-stream="' + s.key + '" aria-selected="' + (i === 0) + '">' + esc(s.label) + '</button>';
              }).join("") +
            '</div>' +
            streams.map(function (s, i) {
              return '<div class="ae-stream" data-stream="' + s.key + '"' + (i === 0 ? '' : ' hidden') + '>' + streamBody(s) + '</div>';
            }).join("") +
            '<p class="ae-hint">Per-asset choices win over the class / integration / source-default tiers.</p>' +
          '</div>'
        : '') +
    '</form>' + footerHtml("Save");

    // Stream chips swap the visible body (the desktop's subtab strip).
    body.querySelectorAll(".ae-streams .chip").forEach(function (chip) {
      chip.addEventListener("click", function () {
        var key = chip.getAttribute("data-stream");
        body.querySelectorAll(".ae-streams .chip").forEach(function (c) {
          var on = c === chip;
          c.classList.toggle("selected", on);
          c.setAttribute("aria-selected", String(on));
        });
        body.querySelectorAll(".ae-stream").forEach(function (p) { p.hidden = p.getAttribute("data-stream") !== key; });
      });
    });

    // Credential + MIB rows follow the method, as refreshStreamCred.
    function refreshStream(s) {
      var pollEl = $("ae-" + s.poll);
      if (!pollEl) return;
      var method = pollEl.value || null;
      if (s.cred) {
        var credEl = $("ae-" + s.cred), wrap = $("ae-" + s.cred + "-wrap"), hint = $("ae-" + s.cred + "-hint");
        var credType = _credTypeForPolling(method);
        var current = credEl.getAttribute("data-current-id") || "";
        if (credType || current) {
          credEl.innerHTML = _credentialOptionsHTML(creds, current, credType);
          wrap.hidden = false;
        } else {
          credEl.innerHTML = "";
          wrap.hidden = true;
        }
        hint.hidden = !(!credType && current);
      }
      if (s.mib) $("ae-" + s.mib + "-wrap").hidden = method !== "snmp";
    }
    streams.forEach(function (s) {
      var pollEl = $("ae-" + s.poll);
      if (!pollEl) return;
      pollEl.addEventListener("change", function () {
        // A deliberate method change drops a credential of another type.
        if (s.cred) $("ae-" + s.cred).setAttribute("data-current-id", "");
        refreshStream(s);
      });
      if (s.cred) $("ae-" + s.cred).addEventListener("change", function () {
        this.setAttribute("data-current-id", this.value);
      });
      if (s.mib) $("ae-" + s.mib).addEventListener("change", function () {
        // Keep the pick when the uploaded-MIB group lands and repaints the list.
        this.setAttribute("data-current-id", this.value);
      });
      refreshStream(s);
    });
    if (transportShown) _populateUploadedMibsInDropdowns();

    // Rule 10: a status that is never polled can't be monitored. Status lives
    // on the General sheet here, so the note points there.
    var monChk = $("ae-monitored"), blocked = $("ae-monitored-blocked"), transport = $("ae-transport");
    var monitorable = statusAllowsMonitoring(a.status);
    if (!monitorable) {
      monChk.checked = false;
      monChk.disabled = true;
      blocked.hidden = false;
      blocked.textContent = "A " + a.status + " asset is not polled. Change its Status on the General sheet to enable monitoring.";
    }
    function refreshEnabled() {
      var on = monChk.checked;
      if (transport) transport.hidden = !on;
      ["ae-monitorIntervalSec", "ae-probeTimeoutMs"].forEach(function (id) { var el = $(id); if (el) el.disabled = !on; });
    }
    monChk.addEventListener("change", refreshEnabled);
    refreshEnabled();

    var probeEl = $("ae-probeTimeoutMs"), probeWarn = $("ae-probe-warn");
    if (probeEl && probeWarn) {
      var checkProbe = function () {
        var v = parseInt(probeEl.value, 10);
        probeWarn.hidden = !(Number.isFinite(v) && v > 0 && v < 500);
      };
      probeEl.addEventListener("input", checkProbe);
      checkProbe();
    }

    paintEffective(a, eff);
    wireSave(function () { return saveMonitoring(a, streams, transportShown); });
  }

  // Tier badges, Inherit labels and the Declaring Down sentence from
  // /effective-monitor-settings — _populateAssetMonitorTierBadges +
  // _paintDownDetectionHint on the desktop.
  function paintEffective(a, eff) {
    var dd = $("ae-down-detection");
    if (!eff || !eff.resolved || !eff.provenance) {
      if (dd) dd.textContent = "Could not resolve which automation decides Down for this device.";
      return;
    }
    var TIER = { "class": "class override", "integration": "integration tier", "manual": "manual tier" };
    [["intervalSeconds", " s"], ["probeTimeoutMs", " ms"], ["cpuMemoryTimeoutMs", " ms"],
     ["temperatureTimeoutMs", " ms"], ["systemInfoTimeoutMs", " ms"]].forEach(function (f) {
      var el = $("ae-tier-" + f[0]);
      if (!el) return;
      var tier = TIER[eff.provenance[f[0]]];
      el.textContent = tier ? "Inherited from " + tier + ": " + eff.resolved[f[0]] + f[1] + "." : "";
    });
    STREAMS.forEach(function (s) {
      var sel = $("ae-" + s.poll);
      if (!sel) return;
      var hasPreview = eff.inheritPolling && eff.inheritPolling.provenance && (s.poll in eff.inheritPolling.provenance);
      var prov = hasPreview ? eff.inheritPolling.provenance[s.poll] : eff.provenance[s.poll];
      if (!prov || prov === "asset" || prov === "default") return;
      var resolved = hasPreview ? eff.inheritPolling.values[s.poll] : eff.resolved[s.poll];
      var opt = sel.querySelector('option[value=""]');
      if (!opt || !resolved) return;
      var integName = a.discoveredByIntegration && a.discoveredByIntegration.name;
      var tierStr = prov === "integration" && integName ? integName : (TIER[prov] || prov);
      opt.textContent = "Inherit (" + tierStr + ": " + (_POLLING_LABELS[resolved] || resolved) + ")";
    });
    if (!dd) return;
    var d = eff.downDetection;
    if (!d) { dd.textContent = "Could not resolve which automation decides Down for this device."; return; }
    if (d.passive) {
      dd.innerHTML = "<strong>Passive</strong> — no down-detection automation covers this device. " +
        "Polaris records its polls but will never declare it Missed or Down.";
      return;
    }
    var txt = "Down after <strong>" + d.missedPolls + " missed poll" + (d.missedPolls === 1 ? "" : "s") + "</strong>";
    var MDA = window.PolarisMonitorDownAfter;
    if (MDA && MDA.calc) {
      var c = MDA.calc(d.missedPolls, eff.resolved.intervalSeconds, eff.resolved.probeTimeoutMs, d.recoveryPolls);
      txt += " ≈ " + MDA.human(c.realSec) + " at this device’s " + c.interval + "s poll interval";
    }
    if (d.automationName) txt += ", set by <strong>" + esc(d.automationName) + "</strong>";
    txt += ".";
    if (d.recoveryPolls > d.missedPolls) txt += " Back to Up after <strong>" + d.recoveryPolls + " received polls</strong>.";
    if (d.conflict) {
      txt += ' <span class="ae-warn">Another equally-specific automation asks for ' +
        d.conflict.counts.filter(function (n) { return n !== d.conflict.chosen; }).join(" / ") +
        " — Polaris uses the smaller count.</span>";
    }
    dd.innerHTML = txt;
  }

  // The Monitoring fields, shaped exactly as getAssetFormData's monitoring half.
  function intOrNull(id, min, max) {
    var el = $(id);
    if (!el) return undefined;
    if (el.value === "") return null;
    var n = parseInt(el.value, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  }
  function readMonitoring(streams, transportShown) {
    var data = { monitored: $("ae-monitored").checked };
    var iv = intOrNull("ae-monitorIntervalSec", 5, 86400);
    if (iv !== undefined) data.monitorIntervalSec = iv;
    [["probeTimeoutMs", 100, 60000], ["cpuMemoryTimeoutMs", 1000, 120000],
     ["temperatureTimeoutMs", 1000, 120000], ["systemInfoTimeoutMs", 1000, 120000]].forEach(function (f) {
      var v = intOrNull("ae-" + f[0], f[1], f[2]);
      if (v !== undefined) data[f[0]] = v;
    });
    if (!transportShown) return data;   // the agent owns the streams; leave them alone
    streams.forEach(function (s) {
      var pollEl = $("ae-" + s.poll);
      if (pollEl) data[s.poll] = pollEl.value || null;
      if (s.cred) {
        var credEl = $("ae-" + s.cred);
        data[s.cred] = credEl.options.length === 0
          ? (credEl.getAttribute("data-current-id") || null)
          : (credEl.value || null);
      }
      if (s.mib) data[s.mib] = $("ae-" + s.mib).value || null;
    });
    var path = $("ae-httpCheckPath");
    if (path) data.httpCheckPath = path.value.trim() || null;
    return data;
  }

  function saveMonitoring(asset, streams, transportShown) {
    var data = readMonitoring(streams, transportShown);
    return api.assets.update(asset.id, data).then(function () { afterSave("Monitoring updated"); });
  }

  // ═══ Maintenance ════════════════════════════════════════════════════════
  var MAINT_SRC = "/js/assets-maintenance.js";

  function loadMaintenance(id, token) {
    var mayMaint = canManageMaintenance();
    return Promise.all([
      api.assets.get(id),
      api.assets.maintenanceInfo(id).catch(function () { return null; }),
      // The ad-hoc helpers and the server clock are assets-maintenance.js's;
      // only someone who can act needs them.
      mayMaint ? loadScriptOnce(MAINT_SRC, "maintCreateAdhoc").then(function () {
        return typeof window.maintLoadServerClock === "function" ? window.maintLoadServerClock() : null;
      }).then(function () { return true; }, function () { return false; }) : Promise.resolve(false),
    ]).then(function (r) {
      if (token !== _token) return;
      renderMaintenance(r[0], r[1], mayMaint, r[2] && typeof window.maintCreateAdhoc === "function");
    });
  }

  function maintenanceInfoHtml(info, mayMaint) {
    if (!info) return '<p class="ae-hint">Maintenance info unavailable.</p>';
    var rows = [];
    (info.openWindows || []).forEach(function (w) {
      rows.push('<div class="list-item two-line ae-maint-row"><div class="content">' +
        '<div class="headline">In maintenance now</div>' +
        '<div class="supporting">' + esc(w.scheduleName) + (w.until ? " · until ~" + esc(new Date(w.until).toLocaleString()) : "") + '</div>' +
      '</div></div>');
    });
    (info.schedules || []).forEach(function (s) {
      var when = s.activeNow ? "active now"
        : (s.nextStart ? "next: " + new Date(s.nextStart).toLocaleString() : "no upcoming window");
      var acts = "";
      if (mayMaint) {
        // A filter-matched asset has no per-asset removal — the filter would
        // put it straight back — so say that where the button would be.
        acts = (s.removable
            ? '<button type="button" class="btn btn-outlined btn-sm" data-maint-act="remove" data-schedule-id="' + esc(s.id) +
                '" data-schedule-name="' + esc(s.name) + '"' + (s.lastTarget ? ' data-last-target="true"' : '') + '>Remove this asset</button>'
            : '<span class="ae-hint">Matched by this schedule’s filter — edit the filter on the desktop to exclude it.</span>') +
          '<button type="button" class="btn btn-error btn-sm" data-maint-act="delete" data-schedule-id="' + esc(s.id) +
            '" data-schedule-name="' + esc(s.name) + '">Delete schedule</button>';
      }
      rows.push('<div class="ae-maint-sched"><div class="ae-maint-sched-head"><strong>' + esc(s.name) + '</strong>' +
          (s.enabled ? '' : ' <span class="ae-hint">(disabled)</span>') + '</div>' +
        '<div class="ae-hint">Covered by this schedule — ' + esc(when) + '</div>' +
        (acts ? '<div class="ae-maint-acts">' + acts + '</div>' : '') + '</div>');
    });
    return rows.length ? rows.join("") : '<p class="ae-hint">Not covered by any maintenance schedule.</p>';
  }

  function renderMaintenance(a, info, mayMaint, canAdhoc) {
    var body = $("ae-body");
    if (!body) return;
    var adhoc = "";
    if (canAdhoc) {
      var label = typeof window.maintServerClockLabel === "function" ? window.maintServerClockLabel() : "";
      adhoc = sectionLabel("Enter maintenance") +
        (a.monitored === false
          ? '<p class="ae-hint ae-warn">This asset isn’t monitored, so it can’t enter maintenance — there is no polling to pause. Enable monitoring on the Monitoring sheet first.</p>'
          : '') +
        tf("Until", input("ae-maint-until", "", ' type="datetime-local"'),
          "Both the date and the time, in the Polaris server’s timezone" + (label ? ": <strong>" + esc(label) + "</strong>" : "") + ".") +
        checkRow("ae-maint-suppress", "Mark dependent devices as down", true) +
        '<p class="ae-hint">Creates a one-time maintenance schedule for this asset starting now. Polling and notifications pause until the end time.</p>';
    } else if (mayMaint) {
      adhoc = '<p class="ae-hint">Maintenance scheduling couldn’t be loaded — try again, or use Assets → Maintenance on the desktop.</p>';
    } else {
      adhoc = '<p class="ae-hint">You don’t have permission to change maintenance windows.</p>';
    }

    body.innerHTML = sectionLabel("Current") +
      '<div id="ae-maint-info">' + maintenanceInfoHtml(info, mayMaint) + '</div>' +
      adhoc + footerHtml(canAdhoc ? "Enter maintenance" : "");

    var untilEl = $("ae-maint-until");
    if (untilEl && typeof window.maintLocalIso === "function") {
      // Seed now + 2h on the SERVER's clock — the value is read as server wall time.
      var nowMs = typeof window.maintServerNow === "function" ? window.maintServerNow().getTime() : Date.now();
      untilEl.value = window.maintLocalIso(new Date(nowMs + 2 * 3600 * 1000));
    }
    wireMaintenanceActions(a);
    if (!canAdhoc) { $("ae-cancel").textContent = "Close"; $("ae-cancel").addEventListener("click", closeEdit); return; }
    wireSave(function () { return enterMaintenance(a); });
  }

  function enterMaintenance(a) {
    var raw = $("ae-maint-until").value;
    var check = window.maintValidateAdhocEnd(raw);
    if (!check.ok) throw new Error(check.error);
    var suppress = $("ae-maint-suppress").checked;
    return window.maintCreateAdhoc(a.id, a.hostname, check.value, { suppressChildren: suppress }).then(function () {
      // Targets are intersected with monitored=true server-side, so the
      // schedule can exist without the asset entering maintenance — say so.
      return api.assets.maintenanceInfo(a.id).then(function (i) { return !!(i && i.inMaintenance); }, function () { return true; });
    }).then(function (entered) {
      if (entered) { afterSave("Maintenance mode active"); return; }
      afterSave("Schedule created, but the asset did not enter maintenance (only monitored assets can)");
    });
  }

  // Remove / Delete on a covering schedule, delegated once on the info block.
  function wireMaintenanceActions(a) {
    var infoEl = $("ae-maint-info");
    if (!infoEl) return;
    infoEl.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest("[data-maint-act]") : null;
      if (!btn) return;
      var act = btn.getAttribute("data-maint-act");
      var sid = btn.getAttribute("data-schedule-id");
      var name = btn.getAttribute("data-schedule-name") || "this schedule";
      var last = btn.getAttribute("data-last-target") === "true";
      var q = act === "delete"
        ? { title: "Delete “" + name + "”?", body: "Every device it covers leaves maintenance and resumes monitoring. This cannot be undone.", ok: "Delete schedule", danger: true }
        : { title: "Remove from “" + name + "”?", body: last
            ? "It is the only device on that schedule, so the schedule is deleted with it. Monitoring and notifications resume immediately."
            : "The schedule keeps running for its other devices. Monitoring and notifications resume for this asset immediately.",
            ok: "Remove", danger: true };
      confirmSheet(q).then(function (ok) {
        if (!ok) return;
        infoEl.querySelectorAll("[data-maint-act]").forEach(function (b) { b.disabled = true; });
        var p = act === "delete"
          ? api.maintenanceSchedules.delete(sid).then(function () { toast("Maintenance schedule “" + name + "” deleted"); })
          : api.maintenanceSchedules.removeAsset(sid, a.id).then(function (res) {
              toast(res && res.scheduleDeleted ? "Asset removed — schedule “" + name + "” deleted" : "Asset removed from “" + name + "”");
            });
        p.catch(function (err) { toast((err && err.message) || "Failed to update the maintenance schedule", true); })
          .then(function () {
            // Reload either way: the fresh read says what is true now.
            return api.assets.maintenanceInfo(a.id).then(function (info) {
              var el = $("ae-maint-info");
              if (el) el.innerHTML = maintenanceInfoHtml(info, canManageMaintenance());
            }, function () { /* keep what is shown */ });
          }).then(function () {
            if (_ctx && _ctx.onSaved) { try { _ctx.onSaved(); } catch (_) { /* best effort */ } }
          });
      });
    });
  }

  window.PolarisAssetEdit = {
    openMenu: openMenu,
    openTab: openTab,
    closeAll: closeAll,
    TABS: TABS.map(function (t) { return t.key; }),
    _rebootRowState: rebootRowState,
  };
})();
