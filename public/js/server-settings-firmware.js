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
      (stale ? "The credential bound here was deleted; bind another or the next level up" : "Bind a device admin login here or at a level above") +
      '">No login — upgrades cannot start</span>';
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

  function imagesTableHTML(mdl) {
    if (!mdl.images || mdl.images.length === 0) {
      return '<p class="empty-state" style="padding:0.75rem">No images uploaded for this model.</p>';
    }
    return '<table class="data-table fw-images"><thead><tr>' +
      '<th style="width:6rem">Role</th><th>Version</th><th style="width:7rem">Platform</th><th>File</th><th style="width:6rem">Size</th><th>Uploaded</th><th></th>' +
    '</tr></thead><tbody>' + mdl.images.map(imageRowHTML).join("") + '</tbody></table>' +
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
      metaHTML: mdl.assetCount + " asset" + (mdl.assetCount === 1 ? "" : "s") + " · " + (mdl.images || []).length + " image" + ((mdl.images || []).length === 1 ? "" : "s"),
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
      metaHTML: t.models.length + " model" + (t.models.length === 1 ? "" : "s") + " · " + t.assetCount + " asset" + (t.assetCount === 1 ? "" : "s"),
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
      metaHTML: m.assetCount + " asset" + (m.assetCount === 1 ? "" : "s"),
      pillsHTML: bindingPillHTML(m, ctx),
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
      toast(label + " is now the primary image", "success");
      await reload();
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

  window.PolarisFirmwareTab = {
    load: load,
    render: render,
    reload: reload,
    // Pure pieces, for the DOM tests.
    cardHTML: cardHTML,
    runsCardHTML: runsCardHTML,
    bindingPillHTML: bindingPillHTML,
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
