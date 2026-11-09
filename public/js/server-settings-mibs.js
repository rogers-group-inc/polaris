/**
 * public/js/server-settings-mibs.js — the MIB Database card (rendered on the
 * Credentials tab, and the one card a non-admin with MIB rights sees there),
 * the manufacturer-alias helpers, and the MIB Browse / Walk modal.
 *
 * Split out of server-settings.js (CQ-F051) as a byte-for-byte move. A plain
 * browser script: its functions and `var`s are page globals. Loads AFTER
 * server-settings.js — tests/unit/serverSettingsSplit.test.ts holds the order.
 */

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

  var modelListId = "mib-model-datalist";
  var modelOpts = "";
  Object.keys(_mibFacets.modelsByManufacturer || {}).forEach(function (mfr) {
    (_mibFacets.modelsByManufacturer[mfr] || []).forEach(function (md) {
      modelOpts += '<option value="' + escapeHtml(md) + '"></option>';
    });
  });

  html +=
    '<div style="border-top:1px solid var(--color-border);padding-top:1rem">' +
      '<h5 style="margin:0 0 0.75rem;font-size:0.9rem">Upload MIB</h5>' +
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
          // The same open-on-click combobox as "+ Add Manufacturer": vendors
          // with devices in inventory first, each with its device count, since
          // a vendor MIB only resolves for assets whose manufacturer matches.
          '<span class="aw-combo aw-combo-dim">' +
            '<input type="text" id="f-mib-up-mfr" autocomplete="off" placeholder="e.g. Cisco">' +
            '<div class="aw-suggest" id="mib-up-mfr-suggest"></div>' +
          '</span>' +
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
  wireMibUploadManufacturerCombo();

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
    // Say whether the module is USABLE where it landed, not just stored. A
    // vendor leaf module uploaded without its core module resolves nothing,
    // and until 2026-09 the operator found that out from a chart that never
    // filled. Stays on screen until the next upload or re-render.
    if (statusEl) statusEl.innerHTML = _mibUploadResultHTML(created);
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
    // `unresolvedRootDetails` pairs each root with the module the file's own
    // IMPORTS says defines it, so the fix can be named outright.
    var details = Array.isArray(st.unresolvedRootDetails) ? st.unresolvedRootDetails : [];
    var roots = details.length > 0
      ? details.map(function (d) { return d.symbol; })
      : (Array.isArray(st.unresolvedRoots) ? st.unresolvedRoots : []);
    var modules = [];
    details.forEach(function (d) { if (d.module && modules.indexOf(d.module) === -1) modules.push(d.module); });
    var cause = roots.length > 0
      ? ' Undefined here: <b>' + roots.map(escapeHtml).join("</b>, <b>") + '</b>' +
        (modules.length > 0
          ? ' — upload <b>' + modules.map(escapeHtml).join("</b>, <b>") + '</b>' + (roots.length === 1 ? ', which defines it.' : ', which define them.')
          : ' — upload the MIB that defines ' + (roots.length === 1 ? 'it' : 'them') + '.')
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
      resultBox.innerHTML = _renderProfileMibWalkResult(result);
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

function _renderProfileMibWalkResult(result) {
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

