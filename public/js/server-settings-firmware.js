/**
 * public/js/server-settings-firmware.js — Server Settings → Repository
 * (business rule 87): the firmware repository for switches and access points.
 *
 * Exposes `window.PolarisFirmwareTab = { load, render, … }`, which
 * server-settings.js calls when the tab is opened (the server-settings-ha.js
 * precedent — a tab with its own state machine in its own module).
 *
 * What the tab shows: a three-level accordion, manufacturer › device type
 * (switch / access point) › model, built server-side from the assets that
 * exist plus every model node that holds images. Under a model: its two
 * images (primary and backup — a new upload becomes primary, the displaced
 * primary becomes backup, the old backup is removed), the upload control,
 * and the device-admin login bound at that node. A login may be bound at any
 * of the three levels; every node shows the EFFECTIVE login and where it is
 * inherited from — `effectiveBinding.scope` comes from the server, the
 * client never recomputes precedence. A model node with images and no assets
 * is ORPHANED: flagged amber, opened by default, and given the one
 * node-level delete verb.
 *
 * Mechanic: the Manufacturer Profiles accordion (renderProfileRow + one
 * delegated click listener), nested three deep — not the interface-tree table
 * mechanic, because a model node's body is composite (a table, an upload row,
 * an editor) and there is no sort or filter. Collapse state persists per
 * browser under localStorage, the way the interface tree's does.
 *
 * Gates (permAtLeast on the `firmware` key): read = see everything here;
 * write = upload / delete / make-primary / purge / bind. Flashing a device is
 * the asset slide-over's verb (fullwrite), not this page's.
 */
(function () {
  "use strict";

  var COLLAPSE_KEY = "polaris-firmware-collapse";
  var _loaded = false;
  var _tree = null;
  var _runs = null;
  var _expanded = null;      // { "<nodeKey>": true|false } — an explicit choice; absent = the default
  var _bindingEdit = {};     // nodeKey → true while its inline editor is open
  var _credentials = null;   // the form-mode http credentials, fetched when an editor opens
  var _uploading = {};       // nodeKey → true while an upload is in flight

  // ─── helpers ───────────────────────────────────────────────────────────────

  function esc(s) { return typeof escapeHtml === "function" ? escapeHtml(s == null ? "" : String(s)) : String(s == null ? "" : s); }
  function can(level) { return typeof permAtLeast === "function" && permAtLeast("firmware", level); }
  function toast(msg, kind) { if (typeof showToast === "function") showToast(msg, kind || "info"); }
  function ago(iso) { return typeof timeAgo === "function" ? timeAgo(iso) : String(iso); }
  function bytes(n) {
    if (typeof formatBytes === "function") return formatBytes(n);
    if (!(n >= 0)) return "—";
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
    return n + " B";
  }
  function typeWord(t, plural) {
    if (t === "access_point") return plural ? "access points" : "access point";
    if (t === "switch") return plural ? "switches" : "switch";
    return t;
  }

  /** The collapse key of a node — and the value of its data-fw-key. */
  function nodeKey(mfr, type, model) {
    return [mfr, type, model].filter(function (x) { return x !== undefined && x !== null; }).map(encodeURIComponent).join("/");
  }

  function readExpanded() {
    if (_expanded) return _expanded;
    _expanded = {};
    try {
      var raw = window.localStorage && window.localStorage.getItem(COLLAPSE_KEY);
      if (raw) _expanded = JSON.parse(raw) || {};
    } catch (_e) { _expanded = {}; }
    return _expanded;
  }
  function writeExpanded() {
    try { if (window.localStorage) window.localStorage.setItem(COLLAPSE_KEY, JSON.stringify(_expanded || {})); } catch (_e) { /* per-viewer convenience only */ }
  }
  /** Manufacturer and type nodes open by default; a model closed — unless it is orphaned, which must be seen. */
  function isOpen(key, depth, orphaned) {
    var ex = readExpanded();
    if (Object.prototype.hasOwnProperty.call(ex, key)) return !!ex[key];
    return depth < 2 || !!orphaned;
  }

  // ─── pure renderers (exported for the DOM tests) ───────────────────────────

  function scopeLabel(scope, ctx) {
    if (scope === "manufacturer") return ctx.mfrName;
    if (scope === "assetType") return ctx.mfrName + " › " + ctx.typeLabel;
    return "this model";
  }

  /** What login applies at this node, and whether it is its own or inherited. */
  function bindingPillHTML(node, ctx) {
    var own = node.binding && node.binding.credentialId;
    var eff = node.effectiveBinding;
    if (own && eff) {
      return '<span class="fw-pill fw-binding-pill is-own" title="Bound at this level">Login: ' + esc(eff.credentialName) + '</span>';
    }
    if (eff) {
      return '<span class="fw-pill fw-binding-pill is-inherited" title="Inherited from ' + esc(scopeLabel(eff.scope, ctx)) + '">Login: ' +
        esc(eff.credentialName) + ' · inherited from ' + esc(scopeLabel(eff.scope, ctx)) + '</span>';
    }
    var stale = node.binding && node.binding.stale;
    return '<span class="fw-pill fw-binding-pill is-none" title="' +
      (stale ? "The credential bound here was deleted; bind another or the next level up" : "Bind a device admin login here or at a level above — an operator upgrading one of these devices needs one") +
      '">No device login</span>';
  }

  /**
   * The manufacturer node's login pill. A login bound HERE reads like any
   * other node's. Otherwise the manufacturer has no login of its own to report,
   * and what matters is whether every device type below it is covered — by a
   * type binding, or by each of its models carrying one. It names the types
   * that are not, and says nothing at all when every type is: a warning that
   * fires on a fully covered manufacturer is one an operator learns to ignore.
   */
  function manufacturerLoginPillHTML(m, ctx) {
    if (m.binding && m.binding.credentialId && m.effectiveBinding) return bindingPillHTML(m, ctx);
    var missing = typesWithoutLogin(m);
    if (missing.length === 0) return "";
    var names = missing.map(function (t) { return t.label || t.assetType; });
    var stale = m.binding && m.binding.stale;
    return '<span class="fw-pill fw-binding-pill is-none" title="' +
      esc((stale ? "The credential bound at " + m.name + " was deleted. " : "") +
        "Bind a device admin login on each of these device types, on their models, or once here at " + m.name +
        " — an operator upgrading one of these devices needs one.") +
      '">No device login for ' + esc(names.join(", ")) + '</span>';
  }

  /** Device types under a manufacturer with at least one model no login reaches. */
  function typesWithoutLogin(m) {
    return (m.assetTypes || []).filter(function (t) {
      if (t.effectiveBinding) return false;
      var models = t.models || [];
      if (models.length === 0) return true;
      return models.some(function (mdl) { return !mdl.effectiveBinding; });
    });
  }

  /** "12 assets" — a button that opens the device list when the viewer may see assets. */
  function assetCountHTML(n, scopeLabel) {
    var text = n + " asset" + (n === 1 ? "" : "s");
    var mayList = n > 0 && typeof permAtLeast === "function" && permAtLeast("assets", "read");
    if (!mayList) return text;
    return '<button type="button" class="fw-asset-count" title="List the devices in ' + esc(scopeLabel) + '">' + text + '</button>';
  }

  /** Only http credentials in "form" mode are device logins. */
  function credentialOptionsHTML(list, currentId) {
    return (list || []).filter(function (c) {
      var cfg = c.config || {};
      var mode = typeof httpAuthModeOf === "function" ? httpAuthModeOf(cfg) : cfg.authMode;
      return c.type === "http" && mode === "form";
    }).map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === currentId ? " selected" : "") + '>' + esc(c.name) + '</option>';
    }).join("");
  }

  function bindingEditorHTML(node, ctx) {
    var effName = node.effectiveBinding && !(node.binding && node.binding.credentialId)
      ? node.effectiveBinding.credentialName
      : null;
    var currentId = node.binding && node.binding.credentialId ? node.binding.credentialId : "";
    var opts = credentialOptionsHTML(_credentials, currentId);
    var inherit = effName ? "Inherit — " + effName : "Inherit — none";
    return '<div class="fw-binding-editor">' +
      '<label style="font-size:0.8rem">Device login</label>' +
      '<select class="fw-binding-select">' +
        '<option value=""' + (currentId ? "" : " selected") + '>' + esc(inherit) + '</option>' +
        opts +
      '</select>' +
      '<button type="button" class="btn btn-sm btn-primary fw-binding-save">Save</button>' +
      '<button type="button" class="btn btn-sm btn-secondary fw-binding-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-sm btn-link fw-binding-new">Add a device admin login…</button>' +
      (opts ? "" : '<span class="fw-node-meta">No device admin logins yet — add one (HTTP credential, “Device admin login (form)”).</span>') +
    '</div>';
  }

  function imageRowHTML(img) {
    var role = img.role === "backup"
      ? '<span class="fw-pill fw-role-pill is-backup">Backup</span>'
      : '<span class="fw-pill fw-role-pill is-primary">Primary</span>';
    var warn = (img.warnings && img.warnings.length)
      ? ' <span class="fw-pill fw-warn-pill" title="' + esc(img.warnings.join(" ")) + '">Check</span>'
      : "";
    var missing = img.fileMissing ? ' <span class="fw-pill fw-warn-pill" title="The image bytes are gone from disk (data/firmware). Upload it again.">File missing</span>' : "";
    var verbs = "";
    if (can("write")) {
      if (img.role === "backup") verbs += '<button type="button" class="btn btn-sm btn-secondary fw-image-promote" data-id="' + esc(img.id) + '" data-label="' + esc(img.versionLabel) + '">Make primary</button> ';
      verbs += '<button type="button" class="btn btn-sm btn-danger fw-image-del" data-id="' + esc(img.id) + '" data-role="' + esc(img.role) + '" data-label="' + esc(img.versionLabel) + '">Delete</button>';
    }
    return '<tr data-image-id="' + esc(img.id) + '">' +
      '<td>' + role + '</td>' +
      '<td><strong>' + esc(img.versionLabel) + '</strong>' + warn + missing + '</td>' +
      '<td>' + (img.platform ? esc(img.platform) : '<span class="fw-node-meta">unknown</span>') + '</td>' +
      '<td class="fw-file" title="' + esc(img.filename) + '">' + esc(img.filename) + '</td>' +
      '<td>' + esc(bytes(img.sizeBytes)) + '</td>' +
      '<td title="' + esc(img.uploadedAt ? new Date(img.uploadedAt).toLocaleString() : "") + '">' + esc(img.uploadedBy || "—") + ' · ' + esc(img.uploadedAt ? ago(img.uploadedAt) : "") + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' + verbs + '</td>' +
    '</tr>';
  }

  /** Higher version first; an unparsed version sorts last; ties by upload time, newest first. */
  function byVersionDesc(a, b) {
    var va = a.version, vb = b.version;
    if (va && vb) {
      var parts = ["major", "minor", "patch", "build"];
      for (var i = 0; i < parts.length; i++) {
        var x = va[parts[i]], y = vb[parts[i]];
        if (x == null || y == null) continue;
        if (x !== y) return y - x;
      }
    } else if (va || vb) {
      return va ? -1 : 1;
    }
    return String(b.uploadedAt || "").localeCompare(String(a.uploadedAt || ""));
  }

  function imagesTableHTML(mdl) {
    if (!mdl.images || mdl.images.length === 0) {
      return '<p class="empty-state" style="padding:0.75rem">No images uploaded for this model.</p>';
    }
    // Newest version on top, regardless of role. The server hands the rows
    // primary-first; drawn that way, Make primary only traded the two
    // version strings while every pill and verb stayed put, and an operator
    // could not see the swap. With a stable order the Primary pill and the
    // button move between rows instead.
    var images = mdl.images.slice().sort(byVersionDesc);
    return '<table class="data-table fw-images"><thead><tr>' +
      '<th style="width:6rem">Role</th><th>Version</th><th style="width:7rem">Platform</th><th>File</th><th style="width:6rem">Size</th><th>Uploaded</th><th></th>' +
    '</tr></thead><tbody>' + images.map(imageRowHTML).join("") + '</tbody></table>' +
    '<p class="fw-node-meta" style="margin:6px 0 0">A model keeps two images. Uploading a new one makes it primary and moves the current primary to backup; the old backup is removed.</p>';
  }

  function uploadRowHTML(mdl, key) {
    if (!can("write")) return "";
    var backup = (mdl.images || []).filter(function (i) { return i.role === "backup"; })[0];
    var full = (mdl.images || []).length >= 2 && backup;
    var busy = !!_uploading[key];
    return '<div class="fw-upload-row">' +
      '<input type="file" class="fw-upload-file" accept=".out" ' + (busy ? "disabled" : "") + '>' +
      '<button type="button" class="btn btn-sm btn-primary fw-upload-btn" ' + (busy ? "disabled" : "") +
        (full ? ' title="Uploading will remove the backup (' + esc(backup.versionLabel) + ')"' : "") + '>Upload image</button>' +
      '<span class="fw-upload-status"' + (busy ? "" : ' style="display:none"') + '><span class="fw-progress"><span class="fw-progress-fill"></span></span></span>' +
    '</div>';
  }

  function nodeHTML(o) {
    var open = isOpen(o.key, o.depth, o.orphaned);
    return '<div class="fw-node' + (o.orphaned ? " is-orphaned" : "") + '" data-fw-key="' + esc(o.key) + '" data-fw-depth="' + o.depth + '"' + (o.attrs || "") + '>' +
      '<div class="fw-node-header">' +
        '<span class="fw-node-caret">' + (open ? "▼" : "▶") + '</span>' +
        '<span class="fw-node-title">' + o.title + '</span>' +
        (o.metaHTML ? '<span class="fw-node-meta">' + o.metaHTML + '</span>' : "") +
        (o.pillsHTML || "") +
        '<span class="fw-node-spacer"></span>' +
        (o.verbsHTML || "") +
      '</div>' +
      '<div class="fw-node-body"' + (open ? "" : ' style="display:none"') + '>' + (open ? o.bodyHTML : "") + '</div>' +
    '</div>';
  }

  function bindVerbHTML(node) {
    if (!can("write")) return "";
    var own = node.binding && node.binding.credentialId;
    return '<button type="button" class="btn btn-sm btn-secondary fw-binding-edit">' + (own ? "Change login…" : "Set login…") + '</button>';
  }

  function modelNodeHTML(m, t, mdl) {
    var key = nodeKey(m.name, t.assetType, mdl.model);
    var ctx = { mfrName: m.name, typeLabel: t.label };
    var editing = !!_bindingEdit[key];
    var orphanPill = mdl.orphaned
      ? '<span class="fw-pill fw-orphan-pill" title="Images for this model are still on disk, but no asset carries the model any more. Delete them if the hardware is gone.">No assets carry this model any more</span>'
      : "";
    var purge = (mdl.orphaned && can("write"))
      ? '<button type="button" class="btn btn-sm btn-danger fw-model-purge" title="Delete every image under this model">Delete firmware for this model</button> '
      : "";
    var body =
      (editing ? bindingEditorHTML(mdl, ctx) : "") +
      imagesTableHTML(mdl) +
      uploadRowHTML(mdl, key);
    return nodeHTML({
      key: key, depth: 2, orphaned: mdl.orphaned,
      attrs: ' data-fw-mfr="' + esc(m.name) + '" data-fw-type="' + esc(t.assetType) + '" data-fw-model="' + esc(mdl.model) + '"',
      title: esc(mdl.model || "(no model)"),
      metaHTML: assetCountHTML(mdl.assetCount, m.name + " › " + t.label + " › " + (mdl.model || "(no model)")) + " · " + (mdl.images || []).length + " image" + ((mdl.images || []).length === 1 ? "" : "s"),
      pillsHTML: orphanPill + bindingPillHTML(mdl, ctx),
      verbsHTML: purge + bindVerbHTML(mdl),
      bodyHTML: body,
    });
  }

  function typeNodeHTML(m, t) {
    var key = nodeKey(m.name, t.assetType);
    var ctx = { mfrName: m.name, typeLabel: t.label };
    var editing = !!_bindingEdit[key];
    var enginePill = t.engine
      ? ""
      : '<span class="fw-pill fw-engine-pill" title="Images can be stored, but Polaris has no engine to apply them to this manufacturer’s ' + esc(typeWord(t.assetType, true)) + '">No upgrade engine</span>';
    var body = (editing ? bindingEditorHTML(t, ctx) : "") + t.models.map(function (mdl) { return modelNodeHTML(m, t, mdl); }).join("");
    return nodeHTML({
      key: key, depth: 1,
      attrs: ' data-fw-mfr="' + esc(m.name) + '" data-fw-type="' + esc(t.assetType) + '"',
      title: esc(t.label),
      metaHTML: t.models.length + " model" + (t.models.length === 1 ? "" : "s") + " · " + assetCountHTML(t.assetCount, m.name + " › " + t.label),
      pillsHTML: enginePill + bindingPillHTML(t, ctx),
      verbsHTML: bindVerbHTML(t),
      bodyHTML: body,
    });
  }

  function manufacturerNodeHTML(m) {
    var key = nodeKey(m.name);
    var ctx = { mfrName: m.name, typeLabel: "" };
    var editing = !!_bindingEdit[key];
    var body = (editing ? bindingEditorHTML(m, ctx) : "") + m.assetTypes.map(function (t) { return typeNodeHTML(m, t); }).join("");
    return nodeHTML({
      key: key, depth: 0,
      attrs: ' data-fw-mfr="' + esc(m.name) + '"',
      title: esc(m.name),
      metaHTML: assetCountHTML(m.assetCount, m.name),
      pillsHTML: manufacturerLoginPillHTML(m, ctx),
      verbsHTML: bindVerbHTML(m),
      bodyHTML: body,
    });
  }

  function cardHTML() {
    var tree = _tree || { manufacturers: [] };
    var html = '<div class="settings-card">' +
      '<h4>Firmware Repository</h4>' +
      '<p style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.75rem">' +
        'Firmware images for the switches and access points in the inventory, filed by manufacturer, device type and model. ' +
        'Bind a device admin login at a manufacturer, a device type or a model — the most specific one wins — and a device ' +
        'whose firmware is older than its model’s primary image offers an upgrade on its asset details.' +
      '</p>' +
      (typeof calloutHTML === "function"
        ? calloutHTML("info", "Fortinet only, over HTTPS",
            "Upgrades run for Fortinet FortiSwitch and FortiAP devices by signing in to the device’s own web UI over HTTPS. " +
            "A FortiGate-managed FortiAP usually has its local UI disabled and will report the device as unreachable. " +
            "Images for other manufacturers can be stored; their assets show no upgrade action.")
        : "");
    if (tree.manufacturers.length === 0) {
      html += '<p class="empty-state">No switches or access points in the inventory yet — the tree is built from assets’ manufacturer, device type and model.</p>';
    } else {
      html += '<div id="fw-tree" style="margin-top:0.75rem">' + tree.manufacturers.map(manufacturerNodeHTML).join("") + '</div>';
    }
    html += '</div>';
    return html;
  }

  function runsCardHTML() {
    var runs = _runs || [];
    var rows = runs.map(function (r) {
      var who = r.asset ? (r.asset.hostname || r.asset.ipAddress || r.assetId) : r.assetId;
      var status = r.status;
      var color = status === "succeeded" ? "var(--color-success)" : status === "failed" ? "var(--color-danger)" : status === "unverified" ? "var(--color-warning)" : "var(--color-text-secondary)";
      return '<tr>' +
        '<td>' + esc(who) + '</td>' +
        '<td>' + esc(r.fromVersion || "?") + ' → ' + esc(r.toVersion) + '</td>' +
        '<td><span style="color:' + color + '">' + esc(status) + (r.stage && (status === "running" || status === "queued") ? " · " + esc(r.stage) : "") + '</span></td>' +
        '<td title="' + esc(r.startedAt ? new Date(r.startedAt).toLocaleString() : "") + '">' + esc(r.startedBy) + ' · ' + esc(r.startedAt ? ago(r.startedAt) : "") + '</td>' +
        '<td style="color:var(--color-text-secondary);font-size:0.8rem">' + esc(r.error || "") + '</td>' +
        '<td style="text-align:right"><button type="button" class="btn btn-sm btn-secondary fw-run-view" data-id="' + esc(r.id) + '">View log</button></td>' +
      '</tr>';
    }).join("");
    return '<div class="settings-card">' +
      '<h4>Recent upgrade runs</h4>' +
      (runs.length === 0
        ? '<p class="empty-state">No firmware upgrades have run yet.</p>'
        : '<table class="data-table"><thead><tr><th>Device</th><th>Version</th><th>Status</th><th>Started</th><th>Error</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>') +
    '</div>';
  }

  function render() {
    var container = document.getElementById("tab-firmware");
    if (!container) return;
    container.innerHTML = cardHTML() + runsCardHTML();
    wire();
  }

  // ─── data ──────────────────────────────────────────────────────────────────

  async function reload() {
    var results = await Promise.all([
      api.serverSettings.getFirmwareTree(),
      api.serverSettings.listFirmwareRuns({ limit: 25 }).catch(function () { return { runs: [] }; }),
    ]);
    _tree = results[0];
    _runs = (results[1] && results[1].runs) || [];
    render();
  }

  async function load() {
    if (_loaded) return;
    _loaded = true;
    var container = document.getElementById("tab-firmware");
    if (container) container.innerHTML = '<div class="settings-card"><p class="empty-state">Loading…</p></div>';
    try {
      await reload();
    } catch (err) {
      _loaded = false;
      if (container) container.innerHTML = '<div class="settings-card"><p class="empty-state" style="color:var(--color-danger)">' + esc(err && err.message ? err.message : "Could not load the repository") + '</p></div>';
    }
  }

  // ─── wiring ────────────────────────────────────────────────────────────────

  function nodeOf(el) {
    var n = el.closest(".fw-node");
    if (!n) return null;
    return {
      el: n,
      key: n.getAttribute("data-fw-key"),
      manufacturer: n.getAttribute("data-fw-mfr"),
      assetType: n.getAttribute("data-fw-type"),
      model: n.getAttribute("data-fw-model"),
    };
  }

  function wire() {
    var container = document.getElementById("tab-firmware");
    if (!container || container.__fwWired) return;
    container.__fwWired = true;
    container.addEventListener("click", function (e) {
      var target = e.target;
      if (!(target instanceof Element)) return;
      var btn;
      if ((btn = target.closest(".fw-run-view"))) return viewRun(btn.getAttribute("data-id"));
      var node = nodeOf(target);
      if (!node) return;
      // Before the header toggle: the count sits in the header, and a click on
      // it opens the device list without folding the node.
      if ((btn = target.closest(".fw-asset-count"))) { e.stopPropagation(); return openAssetList(node); }
      if ((btn = target.closest(".fw-binding-edit"))) { e.stopPropagation(); return openBindingEditor(node); }
      if ((btn = target.closest(".fw-binding-save"))) { e.stopPropagation(); return saveBinding(node); }
      if ((btn = target.closest(".fw-binding-cancel"))) { e.stopPropagation(); delete _bindingEdit[node.key]; return render(); }
      if ((btn = target.closest(".fw-binding-new"))) { e.stopPropagation(); return newCredential(); }
      if ((btn = target.closest(".fw-image-promote"))) { e.stopPropagation(); return promoteImage(btn.getAttribute("data-id"), btn.getAttribute("data-label")); }
      if ((btn = target.closest(".fw-image-del"))) { e.stopPropagation(); return deleteImage(btn.getAttribute("data-id"), btn.getAttribute("data-label"), btn.getAttribute("data-role"), node); }
      if ((btn = target.closest(".fw-model-purge"))) { e.stopPropagation(); return purgeModel(node); }
      if ((btn = target.closest(".fw-upload-btn"))) { e.stopPropagation(); return uploadImage(node); }
      if (target.closest(".fw-upload-row") || target.closest(".fw-binding-editor") || target.closest("table")) return;
      if (target.closest(".fw-node-header")) return toggle(node);
    });
    container.addEventListener("change", function (e) {
      var input = e.target;
      if (!(input instanceof Element) || !input.classList.contains("fw-upload-file")) return;
      var row = input.closest(".fw-upload-row");
      var status = row && row.querySelector(".fw-upload-status");
      var f = input.files && input.files[0];
      if (status) {
        status.style.display = f ? "" : "none";
        status.className = "fw-upload-status";
        status.innerHTML = f ? esc(f.name + " · " + bytes(f.size)) : "";
      }
    });
  }

  function toggle(node) {
    var ex = readExpanded();
    var depth = Number(node.el.getAttribute("data-fw-depth"));
    var orphaned = node.el.classList.contains("is-orphaned");
    ex[node.key] = !isOpen(node.key, depth, orphaned);
    writeExpanded();
    render();
  }

  async function openBindingEditor(node) {
    try {
      var list = await api.credentials.list();
      _credentials = Array.isArray(list) ? list : (list && list.credentials) || [];
    } catch (err) {
      _credentials = [];
      toast("Could not list credentials: " + (err && err.message ? err.message : err), "error");
    }
    _bindingEdit[node.key] = true;
    render();
  }

  async function saveBinding(node) {
    var sel = node.el.querySelector(".fw-binding-select");
    var credentialId = sel && sel.value ? sel.value : null;
    var body = { manufacturer: node.manufacturer, credentialId: credentialId };
    if (node.assetType) body.assetType = node.assetType;
    if (node.model !== null && node.model !== undefined) body.model = node.model;
    try {
      await api.serverSettings.setFirmwareBinding(body);
      toast(credentialId ? "Device login bound" : "Binding removed — this level now inherits", "success");
      delete _bindingEdit[node.key];
      await reload();
    } catch (err) {
      toast(err && err.message ? err.message : "Save failed", "error");
    }
  }

  function newCredential() {
    if (typeof openCredentialModal === "function") {
      openCredentialModal(null, { name: "", type: "http", config: { authMode: "form" } });
    } else {
      toast("Add the login under Server Settings → Credentials (HTTP, “Device admin login (form)”)", "info");
    }
  }

  async function uploadImage(node) {
    var input = node.el.querySelector(".fw-upload-file");
    var file = input && input.files && input.files[0];
    if (!file) { toast("Choose a .out file first", "error"); return; }
    var status = node.el.querySelector(".fw-upload-status");
    var fill = status && status.querySelector(".fw-progress-fill");
    var backupRow = node.el.querySelector('.fw-images tr[data-image-id] .fw-role-pill.is-backup');
    if (backupRow) {
      var backupLabel = backupRow.closest("tr").querySelector("td:nth-child(2) strong");
      var ok = typeof showConfirm === "function"
        ? await showConfirm("Uploading will remove the backup image" + (backupLabel ? " (" + backupLabel.textContent + ")" : "") + " — a model keeps two. Continue?")
        : true;
      if (!ok) return;
    }
    _uploading[node.key] = true;
    var btn = node.el.querySelector(".fw-upload-btn");
    if (btn) btn.disabled = true;
    if (status) { status.style.display = ""; status.className = "fw-upload-status"; status.innerHTML = '<span class="fw-progress"><span class="fw-progress-fill"></span></span>'; fill = status.querySelector(".fw-progress-fill"); }
    try {
      var res = await api.serverSettings.uploadFirmwareImage(file, { manufacturer: node.manufacturer, assetType: node.assetType, model: node.model }, function (frac) {
        if (fill) {
          if (frac === null) { fill.parentElement.classList.add("is-indeterminate"); }
          else fill.style.width = Math.round(frac * 100) + "%";
        }
      });
      var msg = "Uploaded " + res.image.versionLabel + " — now primary";
      if (res.demoted) msg += "; " + res.demoted.versionLabel + " is the backup";
      if (res.rotatedOut) msg += "; removed " + res.rotatedOut.versionLabel;
      toast(msg, "success");
      delete _uploading[node.key];
      await reload();
      if (res.warnings && res.warnings.length) {
        var again = document.querySelector('.fw-node[data-fw-key="' + node.key.replace(/"/g, '\\"') + '"] .fw-upload-status');
        if (again) { again.style.display = ""; again.className = "fw-upload-status is-warn"; again.textContent = res.warnings.join(" "); }
      }
    } catch (err) {
      delete _uploading[node.key];
      if (btn) btn.disabled = false;
      if (status) { status.style.display = ""; status.className = "fw-upload-status is-error"; status.textContent = err && err.message ? err.message : "Upload failed"; }
      toast(err && err.message ? err.message : "Upload failed", "error");
    }
  }

  async function promoteImage(id, label) {
    try {
      await api.serverSettings.promoteFirmwareImage(id);
      await reload();
      // Rows are drawn primary-first, so a swap moves only the two version
      // strings — every pill and verb stays put and the redraw is easy to
      // miss. Flag the promoted row and say who became the backup.
      var row = document.querySelector('tr[data-image-id="' + id + '"]');
      var demoted = null;
      if (row) {
        row.classList.add("fw-row-flash");
        var backupVerb = row.parentNode ? row.parentNode.querySelector(".fw-image-promote") : null;
        demoted = backupVerb ? backupVerb.getAttribute("data-label") : null;
      }
      toast(label + " is now the primary image" + (demoted ? "; " + demoted + " is the backup" : ""), "success");
    } catch (err) { toast(err && err.message ? err.message : "Failed", "error"); }
  }

  async function deleteImage(id, label, role, node) {
    var text = 'Delete image "' + label + '"?' +
      (role === "primary" ? " The backup image, if any, becomes the primary." : "") +
      " Assets on " + (node.model || "this model") + " will no longer be offered this version.";
    var ok = typeof showConfirm === "function" ? await showConfirm(text) : window.confirm(text);
    if (!ok) return;
    try {
      await api.serverSettings.deleteFirmwareImage(id);
      toast("Image deleted", "success");
      await reload();
    } catch (err) { toast(err && err.message ? err.message : "Delete failed", "error"); }
  }

  async function purgeModel(node) {
    var versions = Array.prototype.map.call(node.el.querySelectorAll(".fw-images td:nth-child(2) strong"), function (el) { return el.textContent; });
    var text = "Delete all firmware for " + node.manufacturer + " › " + typeWord(node.assetType) + " › " + node.model +
      (versions.length ? " (" + versions.join(", ") + ")" : "") + "? No asset carries this model any more.";
    var ok = typeof showConfirm === "function" ? await showConfirm(text) : window.confirm(text);
    if (!ok) return;
    try {
      var res = await api.serverSettings.purgeFirmwareModel({ manufacturer: node.manufacturer, assetType: node.assetType, model: node.model });
      toast("Deleted " + res.deleted + " image" + (res.deleted === 1 ? "" : "s"), "success");
      await reload();
    } catch (err) { toast(err && err.message ? err.message : "Delete failed", "error"); }
  }

  async function viewRun(id) {
    try {
      var res = await api.serverSettings.getFirmwareRun(id);
      var run = res.run;
      var lines = (run.log || []).map(function (l) { return "[" + l.t + "] " + (l.level || "info").toUpperCase() + " " + l.msg; }).join("\n");
      var who = run.asset ? (run.asset.hostname || run.asset.ipAddress || run.assetId) : run.assetId;
      if (typeof openModal === "function") {
        openModal("Firmware upgrade — " + who + " → " + run.toVersion,
          '<p style="margin-bottom:0.5rem"><strong>' + esc(run.status) + '</strong>' + (run.error ? ' — ' + esc(run.error) : "") + '</p>' +
          '<pre style="max-height:60vh;overflow:auto;font-size:0.76rem;white-space:pre-wrap">' + esc(lines || "(no log lines)") + '</pre>',
          '<button class="btn btn-secondary" onclick="closeModal()">Close</button>');
      }
    } catch (err) { toast(err && err.message ? err.message : "Could not load the run", "error"); }
  }

  // ─── device-list slide-in ──────────────────────────────────────────────────
  // The devices behind a node's asset count. Modelled on the credential-usage
  // slide-in (server-settings.js → openCredUsagePanel): a `.slideover-overlay`
  // appended to <body> once, raised on open, Escape to the topmost only, and a
  // row click hands off to PolarisPanels.openAsset, which loads the asset
  // slide-over on this page and stacks it over this one.

  var _listReturnFocus = null;
  var _listRows = [];

  var FW_STANDING = {
    current: { label: "Current", cls: "is-own", title: "Runs the platform's primary image" },
    older: { label: "Behind primary", cls: "is-none", title: "Runs an older version than the platform's primary image" },
    newer: { label: "Ahead of primary", cls: "is-inherited", title: "Runs a newer version than the image selected as primary" },
  };

  function standingPillHTML(v) {
    var s = v && FW_STANDING[v];
    if (!s) return '<span class="fw-node-meta" title="No primary image for this platform, or no readable serial or version">—</span>';
    return '<span class="fw-pill fw-binding-pill ' + s.cls + '" title="' + esc(s.title) + '">' + esc(s.label) + '</span>';
  }

  function assetListRowHTML(a) {
    var name = a.hostname || a.ipAddress || a.id;
    var sub = [];
    if (a.ipAddress && a.hostname) sub.push(esc(a.ipAddress));
    if (a.model) sub.push(esc(a.model));
    if (a.serialNumber) sub.push(esc(a.serialNumber));
    if (!a.monitored) sub.push('<span style="color:var(--color-text-tertiary)">not monitored</span>');
    return '<div class="fw-asset-row" data-asset-id="' + esc(a.id) + '" role="button" tabindex="0" title="Open asset details">' +
      '<div class="fw-asset-row-main">' +
        '<div class="fw-asset-row-name">' + esc(name) + '</div>' +
        (sub.length ? '<div class="fw-asset-row-sub">' + sub.join(" · ") + '</div>' : "") +
      '</div>' +
      '<div class="fw-asset-row-fw">' +
        '<span class="fw-asset-row-version">' + esc(a.osVersion || "no version") + '</span>' +
        standingPillHTML(a.firmwareVsPrimary) +
      '</div>' +
    '</div>';
  }

  /** The list body for a filter string — pure, so the DOM test renders it. */
  function assetListBodyHTML(res, filter) {
    var rows = (res && res.assets) || [];
    if (rows.length === 0) return '<p class="empty-state" style="padding:1rem 0">No devices here.</p>';
    var f = String(filter || "").trim().toLowerCase();
    var shown = f
      ? rows.filter(function (a) {
          return [a.hostname, a.ipAddress, a.model, a.serialNumber, a.osVersion].some(function (x) { return x && String(x).toLowerCase().indexOf(f) !== -1; });
        })
      : rows;
    var capped = res.total > rows.length
      ? '<p class="fw-node-meta" style="margin:0 0 0.5rem">Showing the first ' + rows.length + ' of ' + res.total + ' by hostname — filter to find the rest.</p>'
      : "";
    if (shown.length === 0) return capped + '<p class="empty-state" style="padding:1rem 0">Nothing matches “' + esc(filter) + '”.</p>';
    return capped + shown.map(assetListRowHTML).join("");
  }

  function ensureAssetListDOM() {
    if (document.getElementById("fw-assets-overlay")) return;
    var overlay = document.createElement("div");
    overlay.id = "fw-assets-overlay";
    overlay.className = "slideover-overlay";
    overlay.innerHTML =
      '<div class="slideover" id="fw-assets-panel" role="dialog" aria-labelledby="fw-assets-title" tabindex="-1">' +
        '<div class="slideover-resize-handle"></div>' +
        '<div class="slideover-header">' +
          '<div class="slideover-header-top">' +
            '<h3 id="fw-assets-title">Devices</h3>' +
            '<button class="btn-icon" id="fw-assets-close" aria-label="Close">&times;</button>' +
          '</div>' +
          '<div class="slideover-meta" id="fw-assets-meta"></div>' +
        '</div>' +
        '<div class="slideover-body">' +
          '<div style="padding:1rem 1.25rem">' +
            '<input type="search" id="fw-assets-filter" placeholder="Filter by hostname, IP, model, serial or version" style="width:100%;margin-bottom:0.75rem">' +
            '<div id="fw-assets-body"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) { if (e.target === overlay) closeAssetList(); });
    document.getElementById("fw-assets-close").addEventListener("click", closeAssetList);
    if (typeof wireSlideoverEscape === "function") wireSlideoverEscape(overlay, closeAssetList);

    var body = document.getElementById("fw-assets-body");
    var openRow = function (row) {
      var id = row && row.getAttribute("data-asset-id");
      if (!id) return;
      if (window.PolarisPanels && typeof window.PolarisPanels.openAsset === "function") { window.PolarisPanels.openAsset(id); return; }
      window.location.href = "/assets.html#view=asset:" + encodeURIComponent(id);
    };
    body.addEventListener("click", function (e) { openRow(e.target.closest ? e.target.closest("[data-asset-id]") : null); });
    body.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var row = e.target.closest ? e.target.closest("[data-asset-id]") : null;
      if (row) { e.preventDefault(); openRow(row); }
    });
    document.getElementById("fw-assets-filter").addEventListener("input", function (e) {
      body.innerHTML = assetListBodyHTML(_listRows, e.target.value);
    });

    if (typeof initSlideoverResize === "function") initSlideoverResize(document.getElementById("fw-assets-panel"), "polaris.panel.width.firmwareassets");
  }

  function closeAssetList() {
    var overlay = document.getElementById("fw-assets-overlay");
    if (overlay) overlay.classList.remove("open");
    if (_listReturnFocus && typeof _listReturnFocus.focus === "function") { try { _listReturnFocus.focus(); } catch (_) { /* gone */ } }
    _listReturnFocus = null;
  }

  function typeLabelOf(mfrName, assetType) {
    var m = ((_tree && _tree.manufacturers) || []).filter(function (x) { return x.name === mfrName; })[0];
    var t = m && (m.assetTypes || []).filter(function (x) { return x.assetType === assetType; })[0];
    return (t && t.label) || typeWord(assetType, false);
  }

  async function openAssetList(node) {
    ensureAssetListDOM();
    _listReturnFocus = document.activeElement;
    var title = node.manufacturer;
    var params = { manufacturer: node.manufacturer };
    if (node.assetType) {
      params.assetType = node.assetType;
      title += " › " + typeLabelOf(node.manufacturer, node.assetType);
    }
    if (node.model !== null && node.model !== undefined) {
      // nodeOf reads data-fw-model, which is "" on the "(no model)" node.
      if (node.model === "") { params.noModel = "1"; title += " › (no model)"; }
      else { params.model = node.model; title += " › " + node.model; }
    }
    document.getElementById("fw-assets-title").textContent = title;
    document.getElementById("fw-assets-meta").textContent = "";
    var filterEl = document.getElementById("fw-assets-filter");
    filterEl.value = "";
    var body = document.getElementById("fw-assets-body");
    body.innerHTML = '<p class="empty-state" style="padding:1rem 0">Loading…</p>';
    _listRows = [];

    var overlay = document.getElementById("fw-assets-overlay");
    if (typeof raiseSlideover === "function") raiseSlideover(overlay);
    requestAnimationFrame(function () {
      overlay.classList.add("open");
      var panel = document.getElementById("fw-assets-panel");
      if (panel) panel.focus();
    });

    try {
      var res = await api.serverSettings.listFirmwareNodeAssets(params);
      _listRows = res;
      var behind = (res.assets || []).filter(function (a) { return a.firmwareVsPrimary === "older"; }).length;
      document.getElementById("fw-assets-meta").textContent =
        res.total + " device" + (res.total === 1 ? "" : "s") + (behind ? " · " + behind + " behind the primary image" : "") + " · click one to open its details";
      body.innerHTML = assetListBodyHTML(res, filterEl.value);
    } catch (err) {
      body.innerHTML = '<p class="empty-state" style="padding:1rem 0;color:var(--color-danger)">' + esc(err && err.message ? err.message : "Could not load the devices") + '</p>';
    }
  }

  window.PolarisFirmwareTab = {
    load: load,
    render: render,
    reload: reload,
    // Pure pieces, for the DOM tests.
    cardHTML: cardHTML,
    runsCardHTML: runsCardHTML,
    bindingPillHTML: bindingPillHTML,
    manufacturerLoginPillHTML: manufacturerLoginPillHTML,
    assetListBodyHTML: assetListBodyHTML,
    openAssetList: openAssetList,
    credentialOptionsHTML: credentialOptionsHTML,
    bindingEditorHTML: bindingEditorHTML,
    imagesTableHTML: imagesTableHTML,
    nodeKey: nodeKey,
    isOpen: isOpen,
    _setState: function (s) {
      if (s.tree !== undefined) _tree = s.tree;
      if (s.runs !== undefined) _runs = s.runs;
      if (s.credentials !== undefined) _credentials = s.credentials;
      if (s.expanded !== undefined) _expanded = s.expanded;
      if (s.bindingEdit !== undefined) _bindingEdit = s.bindingEdit;
    },
  };
})();
