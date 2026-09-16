/**
 * public/js/subnets.js — Networks list + CRUD + next-available
 */

var cachedBlocks = [];
var _subnetsPageSize = 15;
var _subnetsPage = 1;
var _subnetsData = [];
var _allSubnetsData = [];
var _subnetsSF = null;
var _subnetsLayout = null;

function _saveSubnetsPrefs() {
  PolarisPrefs.save("subnets", currentUsername, Object.assign(
    { pageSize: _subnetsPageSize, layout: _subnetsLayout ? _subnetsLayout.getPrefs() : null },
    _subnetsSF ? _subnetsSF.getPrefs() : {},
  ));
}

function _restoreSubnetsPrefs() {
  var p = PolarisPrefs.load("subnets", currentUsername);
  if (!p) return;
  if (p.pageSize) {
    _subnetsPageSize = p.pageSize;
    var psSel = document.getElementById("filter-pagesize");
    if (psSel) psSel.value = String(p.pageSize);
  }
  if (_subnetsSF) _subnetsSF.setPrefs(p);
  if (_subnetsLayout && p.layout) _subnetsLayout.setPrefs(p.layout);
}

async function _initSubnetsPage() {
  _subnetsSF = new TableSF("subnets-tbody", function () { _subnetsPage = 1; renderSubnetsPage(); _saveSubnetsPrefs(); });
  var subnetsTable = document.querySelector("#subnets-tbody").closest("table");
  _subnetsLayout = setupColumnLayout(subnetsTable, {
    onChange: _saveSubnetsPrefs,
  });
  await userReady;
  _restoreSubnetsPrefs();
  await loadBlockOptions();
  _applySubnetsHashFilters();
  loadSubnets();

  var addBtn = document.getElementById("btn-add-subnet");
  if (addBtn) addBtn.addEventListener("click", openSubnetCreateModal);
  var allocBtn = document.getElementById("btn-auto-alloc");
  if (allocBtn) allocBtn.addEventListener("click", openAllocateModal);
  // Ungated in the markup on purpose: read-level operators may LOOK at what is
  // excluded from the list they are reading (the dialog gates its own add /
  // rename / remove controls on subnets:fullwrite, matching the route).
  var exclBtn = document.getElementById("btn-exclusions");
  if (exclBtn) exclBtn.addEventListener("click", openExclusionsModal);
  // Row verbs live behind the name. "Open" is what the name click used to do on
  // its own; Edit / Delete are per-ROW (canEditSubnet honours the ownership
  // dimension — write-level callers only manage networks they created), so the
  // menu is built from the row's own permission rather than a page-wide one.
  document.getElementById("subnets-tbody").addEventListener("click", function (e) {
    var trigger = e.target.closest(".subnet-menu");
    if (!trigger) return;
    e.preventDefault();
    var id = trigger.getAttribute("data-subnet-id");
    var s = (_subnetsData || []).find(function (x) { return x.id === id; });
    if (!s) return;
    var items = [{ label: "Open", onSelect: function () { openSubnetFromRow(trigger, id); } }];
    if (canEditSubnet(s)) {
      items.push({ label: "Edit", onSelect: function () { openSubnetEditModal(id); } });
      items.push({ separator: true });
      // Archive is `subnets:fullwrite`, not the ownership-aware write the rest
      // of this menu uses: a discovered network carries createdBy=null, so an
      // ownership-scoped caller could never reach one, and retiring a site's
      // address space is not an own-rows action (business rule 41).
      if (permAtLeast("subnets", "fullwrite")) {
        items.push({
          label: "Archive",
          onSelect: function () { confirmArchiveSubnet(id, s.cidr, s.totalReservations || 0); },
        });
      }
      items.push({
        label: "Delete",
        danger: true,
        onSelect: function () { confirmDeleteSubnet(id, s.cidr, s.totalReservations || 0); },
      });
    }
    showRowMenu(trigger, items, { label: "Actions for " + s.name });
  });
  wireFavoriteClicks("subnets-tbody", function () { renderSubnetsPage(); });
  // Page-size selector now lives in the pagination row (renderPageControls
  // onSizeChange) — no standalone #filter-pagesize.
}

// Reads dashboard / search deep-link hash params and seeds the filter
// dropdowns / opens the IP panel BEFORE the initial load so the user lands
// on the right view without a flicker.
//
// Supported hash forms:
//   #tab=networks&block=<blockId>
//   #tab=networks&subnet=<subnetId>[&focusReservation=<resvId>]
//   #ip=<subnetId>@<ip>                  (legacy — handled by app.js)
//   #view=subnet:<id>                     (legacy — handled by app.js)
function _applySubnetsHashFilters() {
  var hash = (window.location.hash || "").replace(/^#/, "");
  if (!hash) return;
  var params = {};
  hash.split("&").forEach(function (kv) {
    var p = kv.split("=");
    if (p.length === 2) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
  });
  if (params.block && _subnetsSF) {
    // Block filtering now lives in the Block column header filter, which keys
    // off block NAME (not id). Translate the deep-linked block id via the
    // already-loaded cachedBlocks (loadBlockOptions is awaited before this) and
    // seed the column's multi-select filter. setColumnOptions later preserves
    // this value when it builds the checkbox list from the loaded data.
    var blk = cachedBlocks.find(function (b) { return b.id === params.block; });
    if (blk) {
      _subnetsSF._filters["block.name"] = [blk.name];
      _subnetsSF.restoreFilterUI();
    }
  }
  if (params.subnet) {
    // Defer until subnet list has rendered so we can open the panel from a
    // freshly-loaded subnet record. ip-panel.js handles focusReservation.
    var subnetId = params.subnet;
    var focusReservationId = params.focusReservation || null;
    setTimeout(function () {
      if (typeof openIpPanel !== "function") return;
      var opts = focusReservationId ? { focusReservationId: focusReservationId } : undefined;
      if (api && api.subnets && typeof api.subnets.get === "function") {
        api.subnets.get(subnetId).then(function (s) {
          var merged = Object.assign({ subnetCidr: s && s.cidr }, opts || {});
          openIpPanel(subnetId, merged);
        }, function () { openIpPanel(subnetId, opts); });
      } else {
        openIpPanel(subnetId, opts);
      }
    }, 200);
  }
}

// export() is invoked by the IPAM orchestrator (ipam.js), which owns the
// single Export button in the top page-header and dispatches to the active tab.
window.PolarisSubnets = { init: _initSubnetsPage, applyHashFilters: _applySubnetsHashFilters, export: handleNetworkExport };

// Legacy /subnets.html auto-run. IPAM sets __polarisIpamTabs=true before
// loading this script so it can drive init itself.
if (!window.__polarisIpamTabs) {
  document.addEventListener("DOMContentLoaded", _initSubnetsPage);
}

// Loads the block list into `cachedBlocks` — still needed by blockSelectHTML
// (create / auto-allocate modals) and by the hash deep-link block translation.
// Block filtering itself now lives in the Block column header filter (TableSF).
async function loadBlockOptions() {
  try {
    cachedBlocks = await api.blocks.list();
  } catch (err) {
    showToast("Failed to load blocks: " + err.message, "error");
  }
}

function blockSelectHTML(id, required) {
  var opts = '<option value="">' + (required ? "Select a block..." : "All blocks") + '</option>';
  cachedBlocks.forEach(function (b) {
    opts += '<option value="' + b.id + '">' + escapeHtml(b.name) + ' (' + escapeHtml(b.cidr) + ')</option>';
  });
  return '<select id="' + id + '">' + opts + '</select>';
}

async function loadSubnets() {
  var tbody = document.getElementById("subnets-tbody");
  try {
    // Block and Creator filtering now live in their column header filters
    // (TableSF), so the full network list loads and filtering happens
    // client-side alongside every other column filter.
    var result = await api.subnets.list({ limit: 10000 });
    _allSubnetsData = (result.subnets || result).map(function (s) {
      s._integration = s.integration ? s.integration.name : "Manual";
      return s;
    });
    _rebuildIntegrationColumnOptions();
    _rebuildBlockColumnOptions();
    _rebuildCreatorColumnOptions();
    _subnetsData = _allSubnetsData;
    renderSubnetsPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function _rebuildIntegrationColumnOptions() {
  if (!_subnetsSF) return;
  var seen = new Set();
  var hasManual = false;
  _allSubnetsData.forEach(function (s) {
    if (s.integration) seen.add(s.integration.name);
    else hasManual = true;
  });
  var options = Array.from(seen).sort(function (a, b) { return a.localeCompare(b); });
  if (hasManual) options.unshift("Manual");
  _subnetsSF.setColumnOptions("_integration", options);
}

function _rebuildBlockColumnOptions() {
  if (!_subnetsSF) return;
  var seen = new Set();
  _allSubnetsData.forEach(function (s) {
    if (s.block && s.block.name) seen.add(s.block.name);
  });
  var options = Array.from(seen).sort(function (a, b) { return a.localeCompare(b); });
  _subnetsSF.setColumnOptions("block.name", options);
}

function _rebuildCreatorColumnOptions() {
  if (!_subnetsSF) return;
  var seen = new Set();
  _allSubnetsData.forEach(function (s) {
    if (s.createdBy) seen.add(s.createdBy);
  });
  var options = Array.from(seen).sort(function (a, b) { return a.localeCompare(b); });
  _subnetsSF.setColumnOptions("createdBy", options);
}

function renderSubnetsPage() {
  var tbody = document.getElementById("subnets-tbody");
  if (_subnetsData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state">No networks found. Create one to get started.</td></tr>';
    clearPageControls("pagination");
    return;
  }
  var sfData = _subnetsSF ? _subnetsSF.apply(_subnetsData) : _subnetsData;
  if (sfData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="13" class="empty-state">No results match the current filters.</td></tr>';
    clearPageControls("pagination");
    return;
  }
  sfData = sortFavoritesFirst(sfData, "subnets");
  var start = (_subnetsPage - 1) * _subnetsPageSize;
  var page = sfData.slice(start, start + _subnetsPageSize);
  tbody.innerHTML = page.map(function (s) {
    var tags = (s.tags || []).map(function (t) { return escapeHtml(t); }).join(", ");
    var blockName = s.block ? escapeHtml(s.block.name) : "-";
    var fgtDevice = s.fortigateDevice ? escapeHtml(s.fortigateDevice) : "-";
    var source = s.integration
      ? escapeHtml(s.integration.name)
      : '<span style="color:var(--color-text-tertiary)">Manual</span>';
    // Active reservations holding an address — the same figure the Utilization
    // bar beside it is a percentage of, and what the server counts into
    // `_count.reservations`. Released and expired rows are deliberately not in
    // it; the delete confirmation uses `totalReservations` for those.
    var resvCount = s._count ? s._count.reservations : 0;
    return '<tr>' +
      starCellHTML("subnets", s.id) +
      '<td><button type="button" class="row-menu-trigger subnet-menu" data-subnet-id="' + s.id + '" ' +
        'aria-haspopup="menu" aria-expanded="false" title="Actions for this network">' +
        '<strong>' + escapeHtml(s.name) + '</strong></button></td>' +
      '<td class="mono">' + escapeHtml(s.cidr) + '</td>' +
      '<td>' + blockName + '</td>' +
      '<td>' + escapeHtml(s.purpose || "-") + '</td>' +
      '<td>' + (s.vlan ? '<span class="badge badge-vlan">VLAN ' + s.vlan + '</span>' : '-') + '</td>' +
      '<td>' + (s.hasConflict ? (s.conflictMessage ? '<span title="' + escapeHtml(s.conflictMessage) + '">' + statusBadge("conflict") + '</span>' : statusBadge("conflict")) : statusBadge(s.status)) + '</td>' +
      '<td>' + (tags || '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
      '<td>' + fgtDevice + '</td>' +
      '<td>' + source + '</td>' +
      '<td>' + (s.createdBy ? escapeHtml(s.createdBy) : '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
      '<td>' + resvCount + '</td>' +
      '<td>' + subnetUtilCellHTML(s.utilizationPercent, resvCount, s.usableHosts) + '</td>' +
      '</tr>';
  }).join("");
  renderPageControls("pagination", sfData.length, _subnetsPageSize, _subnetsPage, function (p) {
    _subnetsPage = p;
    renderSubnetsPage();
  }, function (size) {
    _subnetsPageSize = size;
    _subnetsPage = 1;
    renderSubnetsPage();
    _saveSubnetsPrefs();
  });
}

async function openSubnetCreateModal() {
  await _ensureTagCache();
  var body = '<div class="form-group"><label>Block *</label>' + blockSelectHTML("f-blockId", true) + '</div>' +
    '<div class="form-group"><label>CIDR *</label><input type="text" id="f-cidr" placeholder="e.g. 10.0.3.0/24"></div>' +
    '<div class="form-group"><label>Name *</label><input type="text" id="f-name" placeholder="e.g. API Servers"></div>' +
    '<div class="form-group"><label>Purpose</label><textarea id="f-purpose" placeholder="What is this network for?"></textarea></div>' +
    '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" placeholder="1-4094"></div>' +
    tagFieldHTML([]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Create Network</button>';
  openModal("Add Network", body, footer);
  wireTagPicker();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var vlan = document.getElementById("f-vlan").value;
      var input = {
        blockId: val("f-blockId"),
        cidr: val("f-cidr"),
        name: val("f-name"),
        purpose: val("f-purpose") || undefined,
        vlan: vlan ? parseInt(vlan, 10) : undefined,
        tags: getTagFieldValue(),
      };
      await api.subnets.create(input);
      closeModal();
      showToast("Network created");
      loadSubnets();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

/* ─── Exclusions: address space kept OUT of the networks list ─────────────── */
//
// Business rule 42. Some address space is the same at every site — a management
// VLAN, an out-of-band range, an appliance's fixed subnet — and a Polaris subnet
// is ONE row per CIDR, so the first site discovered claims it and every other
// site collides with it. Since rule 41 that collision reads as a chassis
// REPLACEMENT (each site's gate answers with its own serial) and raises a
// conflict on every discovery run about a box nobody swapped.
//
// An exclusion says "this CIDR is not one network". Discovery then skips it
// whole: no create, no update, no chassis check, no stale sweep.
//
// The CIDR is the exclusion's identity and is deliberately NOT editable — this
// dialog offers a name field per row and nothing else, because re-pointing an
// exclusion at different address space in place would silently un-exclude what
// the operator excluded. That is a Remove plus an Add.

var _exclusions = [];

async function openExclusionsModal() {
  // subnets:fullwrite, matching the route gate — an exclusion is fleet-wide and
  // covers discovered rows nobody owns, so the ownership-aware write tier can't
  // be the right gate. Read-level operators still SEE the list: what is missing
  // from the networks page is exactly the thing worth being able to look up.
  var canEdit = canManageNetworks();

  var body =
    infoBox(
      "Excluded address space is <strong>never added to the networks list</strong> and " +
      "<strong>never raises a conflict</strong>. Use it for a subnet that is the same at " +
      "every site — a management VLAN, an out-of-band range — which Polaris can otherwise " +
      "only record once, leaving every other site's FortiGate looking like a replacement " +
      "of the first."
    ) +
    (canEdit
      ? '<div class="form-group">' +
          sectionHeading("Add an exclusion") +
          '<div class="excl-add-row">' +
            '<input type="text" id="excl-name" placeholder="Name — e.g. Site Management VLAN">' +
            '<input type="text" id="excl-cidr" placeholder="Subnet — e.g. 10.255.0.0/24">' +
            '<button type="button" class="btn btn-primary btn-sm" id="excl-add">Add</button>' +
          "</div>" +
          '<p class="hint">IPv4 only. Host bits are normalized away, so <code>10.255.0.5/24</code> ' +
          'is stored as <code>10.255.0.0/24</code>. An exclusion also covers everything ' +
          'inside it, so a <code>/16</code> excludes the <code>/24</code>s within it.</p>' +
        "</div>" +
        formDivider()
      : "") +
    '<div id="excl-list" class="empty-state">Loading…</div>';

  openModal(
    "Excluded Address Space",
    body,
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>',
    { large: true }
  );

  if (canEdit) {
    var addBtn = document.getElementById("excl-add");
    if (addBtn) addBtn.addEventListener("click", _submitExclusion);
    ["excl-name", "excl-cidr"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); _submitExclusion(); }
      });
    });
  }
  await _reloadExclusions();
}

async function _reloadExclusions() {
  var el = document.getElementById("excl-list");
  if (!el) return;
  try {
    var rows = await api.subnets.exclusions.list();
    _exclusions = Array.isArray(rows) ? rows : [];
  } catch (err) {
    el.innerHTML = '<div class="empty-state">' +
      escapeHtml(err.message || "Failed to load exclusions") + "</div>";
    return;
  }
  _renderExclusions();
}

function _renderExclusions() {
  var el = document.getElementById("excl-list");
  if (!el) return;
  var canEdit = canManageNetworks();

  if (!_exclusions.length) {
    el.className = "";
    el.innerHTML = '<div class="empty-state">' +
      (canEdit
        ? "Nothing is excluded. Add a subnet above to keep it out of the networks list."
        : "Nothing is excluded.") +
      "</div>";
    return;
  }

  var rows = _exclusions.map(function (ex) {
    // matchCount is REPORTED, never acted on: adding an exclusion stops future
    // recording and leaves rows already in the list alone, so an operator who
    // wants one gone retires it themselves.
    var matches = ex.matchCount > 0
      ? '<span class="excl-match" title="' +
          escapeHtml(ex.matches.map(function (m) { return m.cidr + " — " + m.name; }).join("\n")) +
          '">' + ex.matchCount + " already listed</span>"
      : '<span class="excl-clear">none listed</span>';
    return "<tr>" +
      '<td style="white-space:nowrap"><code>' + escapeHtml(ex.cidr) + "</code></td>" +
      "<td>" + (canEdit
        ? '<input type="text" class="excl-name-edit" data-id="' + escapeHtml(ex.id) + '" value="' +
            escapeHtml(ex.name) + '" aria-label="Exclusion name">'
        : escapeHtml(ex.name)) + "</td>" +
      '<td style="white-space:nowrap">' + matches + "</td>" +
      '<td style="white-space:nowrap">' + escapeHtml(ex.createdBy || "—") + "</td>" +
      (canEdit
        ? '<td style="white-space:nowrap"><button type="button" class="btn btn-danger btn-sm excl-remove" ' +
            'data-id="' + escapeHtml(ex.id) + '">Remove</button></td>'
        : "<td></td>") +
      "</tr>";
  }).join("");

  el.className = "";
  el.innerHTML =
    '<table class="data-table"><thead><tr style="white-space:nowrap">' +
      '<th>Subnet</th><th>Name</th>' +
      '<th title="Networks already in the list that this exclusion covers. Adding an exclusion never removes them — retire one from its own row menu if you want it gone.">Existing</th>' +
      "<th>Added by</th><th></th>" +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    '<p class="hint" style="margin-top:8px">The subnet is an exclusion’s identity and cannot be ' +
    'changed — remove it and add the new range instead. Removing an exclusion lets discovery ' +
    'record that address space again on its next run.</p>';

  // Name commits on Enter or on blur, and only when it actually changed.
  el.querySelectorAll(".excl-name-edit").forEach(function (input) {
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") {
        var row = _exclusions.find(function (x) { return x.id === input.getAttribute("data-id"); });
        if (row) input.value = row.name;
        input.blur();
      }
    });
    input.addEventListener("blur", function () { _commitExclusionName(input); });
  });

  el.querySelectorAll(".excl-remove").forEach(function (btn) {
    btn.addEventListener("click", function () { _removeExclusion(btn.getAttribute("data-id")); });
  });
}

async function _submitExclusion() {
  var nameEl = document.getElementById("excl-name");
  var cidrEl = document.getElementById("excl-cidr");
  var addBtn = document.getElementById("excl-add");
  if (!nameEl || !cidrEl) return;
  var name = (nameEl.value || "").trim();
  var cidr = (cidrEl.value || "").trim();
  if (!name) { showToast("Name is required", "error"); nameEl.focus(); return; }
  if (!cidr) { showToast("Subnet is required", "error"); cidrEl.focus(); return; }

  if (addBtn) { addBtn.disabled = true; addBtn.textContent = "Adding…"; }
  try {
    var created = await api.subnets.exclusions.create({ name: name, cidr: cidr });
    nameEl.value = "";
    cidrEl.value = "";
    showToast(
      created.matchCount > 0
        ? created.cidr + " excluded — " + created.matchCount +
            " network(s) already in the list were left in place"
        : created.cidr + " excluded"
    );
    await _reloadExclusions();
    nameEl.focus();
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    if (addBtn) { addBtn.disabled = false; addBtn.textContent = "Add"; }
  }
}

async function _commitExclusionName(input) {
  var id = input.getAttribute("data-id");
  var row = _exclusions.find(function (x) { return x.id === id; });
  if (!row) return;
  var name = (input.value || "").trim();
  if (!name) { input.value = row.name; showToast("Name is required", "error"); return; }
  if (name === row.name) return;
  try {
    var saved = await api.subnets.exclusions.update(id, { name: name });
    row.name = saved.name;
    input.value = saved.name;
    showToast("Exclusion renamed");
  } catch (err) {
    input.value = row.name;
    showToast(err.message, "error");
  }
}

async function _removeExclusion(id) {
  var row = _exclusions.find(function (x) { return x.id === id; });
  if (!row) return;
  var ok = await showConfirm(
    'Stop excluding "' + row.name + '" (' + row.cidr + ')? Discovery may record this ' +
    "address space as a network again on its next run."
  );
  if (!ok) return;
  try {
    await api.subnets.exclusions.delete(id);
    showToast("Exclusion removed");
    await _reloadExclusions();
  } catch (err) {
    showToast(err.message, "error");
  }
}

/* ─── Auto-Allocate: template-driven bulk modal ──────────────────────────── */

var _allocTemplates = [];
var _allocSelectedTemplateId = "";

function _allocAnchorKey() {
  return currentUsername ? "polaris-prefs-alloc-anchor-" + currentUsername : null;
}
function _loadAllocAnchor() {
  var key = _allocAnchorKey();
  if (!key) return 24;
  try {
    var raw = localStorage.getItem(key);
    if (!raw) return 24;
    var n = parseInt(raw, 10);
    if (!Number.isInteger(n) || n < 8 || n > 32) return 24;
    return n;
  } catch (_) { return 24; }
}
function _saveAllocAnchor(prefix) {
  var key = _allocAnchorKey();
  if (!key) return;
  try { localStorage.setItem(key, String(prefix)); } catch (_) {}
}

async function openAllocateModal(initialState) {
  initialState = initialState || null;
  try {
    var loaded = await Promise.all([api.allocationTemplates.list(), _ensureTagCache()]);
    _allocTemplates = Array.isArray(loaded[0]) ? loaded[0] : [];
  } catch (err) {
    _allocTemplates = [];
    showToast("Could not load templates: " + err.message, "error");
  }
  _allocSelectedTemplateId = (initialState && initialState.selectedTemplateId) || "";

  var canEditTemplates = canManageNetworks();
  var initialAnchor = (initialState && Number.isInteger(initialState.anchorPrefix)) ? initialState.anchorPrefix : _loadAllocAnchor();
  var initialSite = (initialState && initialState.site) || "";
  var initialTags = (initialState && Array.isArray(initialState.tags)) ? initialState.tags : [];
  var body =
    '<div class="form-group"><label>Block</label>' + blockSelectHTML("f-blockId", true) + '<p class="hint">Required to Allocate' + (canEditTemplates ? '; not required to save a template' : '') + '.</p></div>' +
    '<div class="form-group">' +
      '<label>Template</label>' +
      '<div class="alloc-template-row">' +
        '<select id="f-template"></select>' +
        (canEditTemplates ? '<button type="button" class="btn btn-sm btn-danger" id="f-template-delete" title="Delete selected template" disabled>&times;</button>' : '') +
      '</div>' +
      '<p class="hint">' + (canEditTemplates ? 'Pick a saved template to pre-fill the rows below, or build one from scratch.' : 'Pick a saved template to pre-fill the rows below.') + '</p>' +
    '</div>' +
    '<div class="alloc-two-col">' +
      '<div class="form-group"><label>Site Name</label><input type="text" id="f-site" placeholder="e.g. Riverbend" value="' + escapeHtml(initialSite) + '"><p class="hint">Required to Allocate; prepended to each row name (e.g. <code>Riverbend_Hardware</code>). Not required to save a template.</p></div>' +
      '<div class="form-group"><label>Anchor Prefix</label><input type="number" id="f-anchor" min="8" max="32" value="' + initialAnchor + '"><p class="hint">Minimum alignment for the group. Defaults to /24 and is remembered for you. If the template needs more space, a larger anchor is used automatically.</p></div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Subnets</label>' +
      '<div class="alloc-entries-header"><span>Name</span><span>Prefix</span><span>VLAN</span><span></span></div>' +
      '<div id="f-entries"></div>' +
      '<div style="display:flex;gap:6px;margin-top:6px">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="f-add-row">+ Add Row</button>' +
        '<button type="button" class="btn btn-sm btn-secondary" id="f-add-skip">+ Add Skip</button>' +
      '</div>' +
      '<p class="hint">Skip rows reserve address space (aligned to their prefix) without creating a subnet, so you can leave gaps between allocations.</p>' +
      '<div id="f-footprint" class="alloc-footprint" style="display:none"></div>' +
    '</div>' +
    tagFieldHTML(initialTags);

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    (canEditTemplates ? '<button class="btn btn-secondary" id="btn-save-template">Save Template</button>' : '') +
    '<button class="btn btn-primary" id="btn-allocate">Allocate</button>';

  openModal("Auto-Allocate Next Networks", body, footer, { wide: true });
  wireTagPicker();

  if (initialState && initialState.blockId) {
    var blockEl = document.getElementById("f-blockId");
    if (blockEl) blockEl.value = initialState.blockId;
  }

  _renderAllocTemplateOptions();

  var initialEntries = (initialState && Array.isArray(initialState.entries)) ? initialState.entries : null;
  if (initialEntries && initialEntries.length > 0) {
    initialEntries.forEach(function (entry) { _addAllocEntryRow(entry); });
  } else {
    _addAllocEntryRow(); // start with one empty row
  }
  _refreshAllocHeaderBadge();
  _scheduleAllocFootprintUpdate();

  document.getElementById("f-blockId").addEventListener("change", function () {
    _refreshAllocHeaderBadge();
    _scheduleAllocFootprintUpdate();
  });
  document.getElementById("f-template").addEventListener("change", function (e) {
    _onAllocTemplateChange(e);
    _scheduleAllocFootprintUpdate();
  });
  var tplDelBtn = document.getElementById("f-template-delete");
  if (tplDelBtn) tplDelBtn.addEventListener("click", _onAllocTemplateDelete);
  document.getElementById("f-add-row").addEventListener("click", function () { _addAllocEntryRow(); _scheduleAllocFootprintUpdate(); });
  document.getElementById("f-add-skip").addEventListener("click", function () { _addAllocEntryRow({ skip: true }); _scheduleAllocFootprintUpdate(); });
  document.getElementById("f-entries").addEventListener("click", function (e) {
    var rm = e.target.closest(".alloc-row-remove");
    if (!rm) return;
    var row = rm.closest(".alloc-entry-row");
    if (!row) return;
    var rows = document.querySelectorAll("#f-entries .alloc-entry-row");
    if (rows.length <= 1) {
      // Always keep at least one row — clear fields instead of removing the sole row
      row.querySelectorAll("input").forEach(function (inp) { if (!inp.disabled) inp.value = ""; });
      _scheduleAllocFootprintUpdate();
      return;
    }
    row.remove();
    _scheduleAllocFootprintUpdate();
  });
  document.getElementById("f-entries").addEventListener("input", _scheduleAllocFootprintUpdate);

  var saveTplBtn = document.getElementById("btn-save-template");
  if (saveTplBtn) saveTplBtn.addEventListener("click", _onAllocSaveTemplate);
  document.getElementById("btn-allocate").addEventListener("click", _onAllocSubmit);
  document.getElementById("f-anchor").addEventListener("change", function () {
    var n = parseInt(this.value, 10);
    if (Number.isInteger(n) && n >= 8 && n <= 32) _saveAllocAnchor(n);
    _scheduleAllocFootprintUpdate();
  });
}

function _refreshAllocHeaderBadge() {
  var overlay = document.getElementById("modal-overlay");
  if (!overlay) return;
  var h3 = overlay.querySelector(".modal-header h3");
  if (!h3) return;
  var blockId = document.getElementById("f-blockId");
  var blk = blockId ? cachedBlocks.find(function (b) { return b.id === blockId.value; }) : null;
  var badge = blk ? " " + statusBadge(blk.ipVersion) : "";
  // Re-render title with badge. Title text is trusted (literal); badge is safe HTML.
  h3.innerHTML = escapeHtml("Auto-Allocate Next Networks") + badge;
}

var _allocFootprintTimer = null;
var _allocFootprintSeq = 0;

function _scheduleAllocFootprintUpdate() {
  if (_allocFootprintTimer) clearTimeout(_allocFootprintTimer);
  _allocFootprintTimer = setTimeout(_updateAllocFootprint, 200);
}

async function _updateAllocFootprint() {
  var box = document.getElementById("f-footprint");
  if (!box) return;
  var entries;
  try { entries = _collectAllocEntries(); }
  catch (_) { entries = []; }

  // Local footprint math (always shows, even without a block).
  var span = 0;
  for (var i = 0; i < entries.length; i++) {
    span += Math.pow(2, 32 - entries[i].prefixLength);
  }
  if (span === 0) {
    box.style.display = "none";
    box.className = "alloc-footprint";
    box.innerHTML = "";
    return;
  }
  var slash24s = Math.ceil(span / 256);
  var containingPrefix = 32 - Math.ceil(Math.log2(span));
  var local = span.toLocaleString() + " addresses · " + slash24s + " /24-equivalent · needs /" + containingPrefix + " anchor";

  // If a block is selected, ask the server if it actually fits.
  var blockSel = document.getElementById("f-blockId");
  var blockId = blockSel ? blockSel.value : "";
  if (!blockId) {
    box.style.display = "block";
    box.className = "alloc-footprint alloc-footprint-info";
    box.innerHTML = escapeHtml(local);
    return;
  }

  var anchor = parseInt(document.getElementById("f-anchor").value, 10);
  if (!Number.isInteger(anchor) || anchor < 8 || anchor > 32) anchor = 24;

  var seq = ++_allocFootprintSeq;
  box.style.display = "block";
  box.className = "alloc-footprint alloc-footprint-info";
  box.innerHTML = escapeHtml(local) + " · checking fit…";

  try {
    var preview = await api.subnets.bulkAllocatePreview({
      blockId: blockId,
      entries: entries,
      anchorPrefix: anchor,
    });
    if (seq !== _allocFootprintSeq) return; // a newer update is in flight
    var header = preview.totalAddresses.toLocaleString() + " addresses · " +
      preview.slashTwentyFourCount + " /24-equivalent";
    if (preview.error) {
      box.className = "alloc-footprint alloc-footprint-warn";
      box.innerHTML = escapeHtml(header + " · " + preview.error);
      return;
    }
    if (preview.fits && preview.anchorCidr) {
      box.className = "alloc-footprint alloc-footprint-ok";
      box.innerHTML = escapeHtml(header) + ' · <strong>will land in ' + escapeHtml(preview.anchorCidr) + '</strong>';
    } else {
      box.className = "alloc-footprint alloc-footprint-warn";
      box.innerHTML = escapeHtml(header) + ' · <strong>no free /' + (preview.effectiveAnchorPrefix || containingPrefix) +
        '-aligned region in ' + escapeHtml(preview.blockCidr) + ' — create a new IP block</strong>';
    }
  } catch (err) {
    if (seq !== _allocFootprintSeq) return;
    box.className = "alloc-footprint alloc-footprint-warn";
    box.innerHTML = escapeHtml(local + " · fit check failed: " + err.message);
  }
}

function _renderAllocTemplateOptions() {
  var sel = document.getElementById("f-template");
  if (!sel) return;
  var html = '<option value="">— None (custom) —</option>';
  _allocTemplates.forEach(function (t) {
    html += '<option value="' + t.id + '"' + (t.id === _allocSelectedTemplateId ? " selected" : "") + '>' + escapeHtml(t.name) + '</option>';
  });
  sel.innerHTML = html;
  var delBtn = document.getElementById("f-template-delete");
  if (delBtn) delBtn.disabled = !_allocSelectedTemplateId;  // omitted from DOM for non-admins
}

function _addAllocEntryRow(entry) {
  entry = entry || { name: "", prefixLength: "", vlan: "" };
  var container = document.getElementById("f-entries");
  if (!container) return;
  var row = document.createElement("div");
  var isSkip = entry.skip === true;
  row.className = "alloc-entry-row" + (isSkip ? " alloc-entry-skip" : "");
  if (isSkip) row.setAttribute("data-skip", "true");
  var prefixVal = entry.prefixLength != null && entry.prefixLength !== "" ? entry.prefixLength : "";
  if (isSkip) {
    row.innerHTML =
      '<input type="text" class="alloc-entry-name" value="— skip —" disabled>' +
      '<input type="number" class="alloc-entry-prefix" min="8" max="32" placeholder="e.g. 26" value="' + prefixVal + '">' +
      '<input type="text" class="alloc-entry-vlan" value="—" disabled>' +
      '<button type="button" class="btn btn-sm btn-icon alloc-row-remove" title="Remove row">&times;</button>';
  } else {
    row.innerHTML =
      '<input type="text" class="alloc-entry-name" placeholder="e.g. AcmeHardware" value="' + escapeHtml(entry.name || "") + '">' +
      '<input type="number" class="alloc-entry-prefix" min="8" max="32" placeholder="e.g. 25" value="' + prefixVal + '">' +
      '<input type="number" class="alloc-entry-vlan" min="1" max="4094" placeholder="Optional" value="' + (entry.vlan != null && entry.vlan !== "" ? entry.vlan : "") + '">' +
      '<button type="button" class="btn btn-sm btn-icon alloc-row-remove" title="Remove row">&times;</button>';
  }
  container.appendChild(row);
}

function _collectAllocEntries() {
  var rows = document.querySelectorAll("#f-entries .alloc-entry-row");
  var entries = [];
  for (var i = 0; i < rows.length; i++) {
    var isSkip = rows[i].getAttribute("data-skip") === "true";
    var prefRaw = rows[i].querySelector(".alloc-entry-prefix").value.trim();

    if (isSkip) {
      if (!prefRaw) continue; // empty skip row — just ignore
      var plSkip = parseInt(prefRaw, 10);
      if (!Number.isInteger(plSkip) || plSkip < 8 || plSkip > 32) throw new Error("Row " + (i + 1) + " (skip): prefix length must be 8-32");
      entries.push({ skip: true, prefixLength: plSkip });
      continue;
    }

    var name = rows[i].querySelector(".alloc-entry-name").value.trim();
    var vlanRaw = rows[i].querySelector(".alloc-entry-vlan").value.trim();
    if (!name && !prefRaw && !vlanRaw) continue; // blank row
    if (!name) throw new Error("Row " + (i + 1) + ": name is required");
    var pl = parseInt(prefRaw, 10);
    if (!Number.isInteger(pl) || pl < 8 || pl > 32) throw new Error("Row " + (i + 1) + " (" + name + "): prefix length must be 8-32");
    var entry = { name: name, prefixLength: pl };
    if (vlanRaw) {
      var v = parseInt(vlanRaw, 10);
      if (!Number.isInteger(v) || v < 1 || v > 4094) throw new Error("Row " + (i + 1) + " (" + name + "): VLAN must be 1-4094");
      entry.vlan = v;
    }
    entries.push(entry);
  }
  return entries;
}

function _onAllocTemplateChange(e) {
  var id = e.target.value;
  _allocSelectedTemplateId = id;
  var delBtn = document.getElementById("f-template-delete");
  if (delBtn) delBtn.disabled = !id;
  var anchorEl = document.getElementById("f-anchor");
  if (!id) {
    if (anchorEl) anchorEl.value = _loadAllocAnchor();
    return;
  }
  var tpl = _allocTemplates.find(function (t) { return t.id === id; });
  if (!tpl) return;
  var container = document.getElementById("f-entries");
  container.innerHTML = "";
  (tpl.entries || []).forEach(function (entry) { _addAllocEntryRow(entry); });
  if (!tpl.entries || tpl.entries.length === 0) _addAllocEntryRow();
  if (anchorEl) {
    var next = (tpl.anchorPrefix != null) ? tpl.anchorPrefix : _loadAllocAnchor();
    anchorEl.value = next;
    if (tpl.anchorPrefix != null) _saveAllocAnchor(tpl.anchorPrefix);
  }
}

async function _onAllocTemplateDelete() {
  if (!_allocSelectedTemplateId) return;
  var tpl = _allocTemplates.find(function (t) { return t.id === _allocSelectedTemplateId; });
  if (!tpl) return;
  var ok = await showConfirm('Delete template "' + tpl.name + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.allocationTemplates.delete(tpl.id);
    _allocTemplates = _allocTemplates.filter(function (t) { return t.id !== tpl.id; });
    _allocSelectedTemplateId = "";
    _renderAllocTemplateOptions();
    showToast("Template deleted");
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function _onAllocSaveTemplate() {
  var entries;
  try { entries = _collectAllocEntries(); }
  catch (err) { showToast(err.message, "error"); return; }
  if (entries.length === 0) { showToast("Add at least one subnet row before saving", "error"); return; }

  // Capture full form state BEFORE any await — _promptSaveTemplateChoice and
  // _promptText each open their own modals that replace the auto-allocate
  // modal's DOM, so by the time we'd read these inputs afterwards they're
  // gone. We use this state both to feed the API call (anchorPrefix) and to
  // restore the auto-allocate modal once the save flow ends.
  var anchorRaw = parseInt(document.getElementById("f-anchor")?.value, 10);
  var anchorPrefix = (Number.isInteger(anchorRaw) && anchorRaw >= 8 && anchorRaw <= 32) ? anchorRaw : undefined;
  var capturedState = {
    blockId: document.getElementById("f-blockId")?.value || "",
    site: document.getElementById("f-site")?.value || "",
    anchorPrefix: anchorPrefix,
    entries: entries,
    tags: getTagFieldValue(),
    selectedTemplateId: _allocSelectedTemplateId || "",
  };

  var loaded = _allocSelectedTemplateId
    ? _allocTemplates.find(function (t) { return t.id === _allocSelectedTemplateId; })
    : null;

  var choice = "new";
  if (loaded) {
    choice = await _promptSaveTemplateChoice(loaded.name);
    if (!choice) { await openAllocateModal(capturedState); return; }
  }

  try {
    if (choice === "update" && loaded) {
      var updated = await api.allocationTemplates.update(loaded.id, { name: loaded.name, entries: entries, anchorPrefix: anchorPrefix });
      var idx = _allocTemplates.findIndex(function (t) { return t.id === loaded.id; });
      if (idx >= 0) _allocTemplates[idx] = updated;
      capturedState.selectedTemplateId = updated.id;
      showToast('Template "' + updated.name + '" updated');
    } else {
      var name = await _promptText(
        "Save Template",
        "Give this template a name:",
        loaded ? loaded.name + " (copy)" : ""
      );
      if (!name) { await openAllocateModal(capturedState); return; }
      var created = await api.allocationTemplates.create({ name: name, entries: entries, anchorPrefix: anchorPrefix });
      _allocTemplates.push(created);
      capturedState.selectedTemplateId = created.id;
      showToast('Template "' + created.name + '" saved');
    }
    await openAllocateModal(capturedState);
  } catch (err) {
    showToast(err.message, "error");
    await openAllocateModal(capturedState);
  }
}

function _promptSaveTemplateChoice(existingName) {
  return new Promise(function (resolve) {
    var body =
      '<p style="font-size:0.9rem;color:var(--color-text-secondary)">Template <strong>' + escapeHtml(existingName) + '</strong> is currently loaded. What would you like to do?</p>';
    var footer =
      '<button class="btn btn-secondary" id="tpl-choice-cancel">Cancel</button>' +
      '<button class="btn btn-secondary" id="tpl-choice-new">Save As New</button>' +
      '<button class="btn btn-primary" id="tpl-choice-update">Overwrite</button>';
    openModal("Save Template", body, footer);
    document.getElementById("tpl-choice-cancel").onclick = function () { closeModal(); resolve(null); };
    document.getElementById("tpl-choice-new").onclick = function () { closeModal(); resolve("new"); };
    document.getElementById("tpl-choice-update").onclick = function () { closeModal(); resolve("update"); };
  });
}

function _promptText(title, label, initial) {
  return new Promise(function (resolve) {
    var body =
      '<div class="form-group"><label>' + escapeHtml(label) + '</label>' +
      '<input type="text" id="prompt-text" value="' + escapeHtml(initial || "") + '"></div>';
    var footer =
      '<button class="btn btn-secondary" id="prompt-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="prompt-ok">Save</button>';
    openModal(title, body, footer);
    var input = document.getElementById("prompt-text");
    input.focus();
    input.select();
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") document.getElementById("prompt-ok").click();
    });
    document.getElementById("prompt-cancel").onclick = function () { closeModal(); resolve(null); };
    document.getElementById("prompt-ok").onclick = function () {
      var v = input.value.trim();
      if (!v) { input.focus(); return; }
      closeModal();
      resolve(v);
    };
  });
}

function _showAllocResults(result) {
  var n = result.created.length;
  var rows = result.created.map(function (s) {
    return '<tr><td>' + escapeHtml(s.name) + '</td><td><code class="alloc-cidr-copy" data-cidr="' + escapeHtml(s.cidr) + '" style="font-size:1.05rem;cursor:pointer" title="Click to copy">' + escapeHtml(s.cidr) + '</code></td></tr>';
  }).join("");

  var anchorNote = result.anchorCidr
    ? '<p style="margin:0 0 12px;color:var(--color-text-secondary);font-size:0.875rem">All allocated inside <strong>' + escapeHtml(result.anchorCidr) + '</strong></p>'
    : "";

  var body = anchorNote +
    '<table class="table" style="margin:0"><thead><tr><th>Name</th><th>CIDR</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';

  var footer =
    '<button type="button" class="btn btn-secondary" id="btn-alloc-screenshot">Screenshot</button>' +
    '<button type="button" class="btn btn-secondary" id="btn-alloc-copy">Copy</button>' +
    '<button type="button" class="btn btn-primary" onclick="closeModal()">Done</button>';

  openModal(n + ' Network' + (n !== 1 ? 's' : '') + ' Allocated', body, footer);

  document.getElementById("btn-alloc-copy").addEventListener("click", function () {
    var text = result.created.map(function (s) { return s.name + "\t" + s.cidr; }).join("\n");
    copyTextToClipboard(text).then(function (ok) { showToast(ok ? "Copied to clipboard" : "Copy failed", ok ? "success" : "error"); });
  });

  document.querySelectorAll(".alloc-cidr-copy").forEach(function (el) {
    el.addEventListener("click", function () {
      var cidr = el.getAttribute("data-cidr");
      copyTextToClipboard(cidr).then(function (ok) { showToast(ok ? "Copied " + cidr : "Copy failed", ok ? "success" : "error"); });
    });
  });

  document.getElementById("btn-alloc-screenshot").addEventListener("click", function () {
    _screenshotAllocResults(result);
  });
}

function _screenshotAllocResults(result) {
  var cs = getComputedStyle(document.documentElement);
  var bgPrimary  = cs.getPropertyValue("--color-bg-primary").trim();
  var bgSecondary = cs.getPropertyValue("--color-bg-secondary").trim();
  var bgSurface  = cs.getPropertyValue("--color-surface").trim();
  var clrBorder  = cs.getPropertyValue("--color-border").trim();
  var clrText    = cs.getPropertyValue("--color-text-primary").trim();
  var clrMuted   = cs.getPropertyValue("--color-text-secondary").trim();
  var clrAccent  = cs.getPropertyValue("--color-accent").trim();

  var rows = result.created;
  var n = rows.length;
  var title = n + " Network" + (n !== 1 ? "s" : "") + " Allocated";
  var anchorNote = result.anchorCidr ? "All allocated inside " + result.anchorCidr : "";

  var scale = 2;
  var pad = 24, titleH = 56, anchorH = anchorNote ? 32 : 0;
  var headerH = 36, rowH = 36, colNameW = 300, colCidrW = 160;
  var tableW = colNameW + colCidrW;
  var w = tableW + pad * 2;
  var h = titleH + anchorH + headerH + n * rowH + pad;

  var canvas = document.createElement("canvas");
  canvas.width  = w * scale;
  canvas.height = h * scale;
  var ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  ctx.fillStyle = bgPrimary;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = clrText;
  ctx.font = "bold 17px system-ui,-apple-system,sans-serif";
  ctx.fillText(title, pad, 36);

  if (anchorNote) {
    ctx.fillStyle = clrMuted;
    ctx.font = "13px system-ui,-apple-system,sans-serif";
    ctx.fillText(anchorNote, pad, titleH + 20);
  }

  var tableY = titleH + anchorH;

  ctx.fillStyle = bgSecondary;
  ctx.fillRect(pad, tableY, tableW, headerH);

  ctx.fillStyle = clrMuted;
  ctx.font = "bold 11px system-ui,-apple-system,sans-serif";
  ctx.fillText("NAME", pad + 10, tableY + 23);
  ctx.fillText("CIDR", pad + colNameW + 10, tableY + 23);

  ctx.fillStyle = clrBorder;
  ctx.fillRect(pad + colNameW, tableY, 1, headerH);

  rows.forEach(function (s, i) {
    var y = tableY + headerH + i * rowH;
    ctx.fillStyle = i % 2 === 0 ? bgPrimary : bgSurface;
    ctx.fillRect(pad, y, tableW, rowH);

    ctx.fillStyle = clrText;
    ctx.font = "14px system-ui,-apple-system,sans-serif";
    ctx.fillText(s.name, pad + 10, y + 23);

    ctx.fillStyle = clrAccent;
    ctx.font = "14px \"Courier New\",Courier,monospace";
    ctx.fillText(s.cidr, pad + colNameW + 10, y + 23);

    ctx.fillStyle = clrBorder;
    ctx.fillRect(pad + colNameW, y, 1, rowH);
    ctx.fillRect(pad, y + rowH - 1, tableW, 1);
  });

  ctx.strokeStyle = clrBorder;
  ctx.lineWidth = 1;
  ctx.strokeRect(pad + 0.5, tableY + 0.5, tableW - 1, headerH + n * rowH - 1);

  canvas.toBlob(function (blob) {
    if (!blob) { showToast("Screenshot failed", "error"); return; }
    copyPngToClipboard(blob).then(function (ok) {
      showToast(ok ? "Screenshot copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
    });
  }, "image/png");
}

async function _onAllocSubmit() {
  var btn = document.getElementById("btn-allocate");
  var blockId = val("f-blockId");
  if (!blockId) { showToast("Select a block", "error"); return; }
  var site = val("f-site");
  if (!site) { showToast("Enter a site name", "error"); return; }

  var anchorRaw = document.getElementById("f-anchor").value;
  var anchor = parseInt(anchorRaw, 10);
  if (!Number.isInteger(anchor) || anchor < 8 || anchor > 32) {
    showToast("Anchor prefix must be /8 to /32", "error");
    return;
  }
  _saveAllocAnchor(anchor);

  var entries;
  try { entries = _collectAllocEntries(); }
  catch (err) { showToast(err.message, "error"); return; }
  if (entries.length === 0) { showToast("Add at least one subnet row", "error"); return; }

  var tags = getTagFieldValue();
  btn.disabled = true;
  try {
    var result = await api.subnets.bulkAllocate({
      blockId: blockId,
      prefix: site,
      entries: entries,
      tags: tags,
      anchorPrefix: anchor,
    });
    loadSubnets();
    _showAllocResults(result);
  } catch (err) {
    showToast(err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

/** Open the IP panel, moving the row highlight to this row. */
function openSubnetFromRow(trigger, id) {
  var prev = document.querySelector("tr.row-panel-active");
  if (prev) prev.classList.remove("row-panel-active");
  var row = trigger.closest("tr");
  if (row) row.classList.add("row-panel-active");
  openIpPanel(id);
}

async function openSubnetEditModal(id) {
  try {
    var results = await Promise.all([api.subnets.get(id), _ensureTagCache()]);
    var subnet = results[0];
    var readOnly = !canEditSubnet(subnet);
    var isIntegration = !!subnet.discoveredBy;
    var isDeprecatedIntegration = isIntegration && subnet.status === "deprecated" && canManageNetworks();
    var allLocked = readOnly ? ' disabled class="field-locked"' : '';
    var dis = allLocked || (isIntegration && !isDeprecatedIntegration ? ' disabled class="field-locked"' : '');
    var statusDis = allLocked || (isIntegration && !isDeprecatedIntegration ? ' disabled class="field-locked"' : '');
    var purposeDis = allLocked;
    var hasPendingMerge = !readOnly && !isIntegration && subnet.conflictMessage && subnet.pendingIntegration && canManageNetworks();
    var hintMsg = readOnly
      ? '<p class="hint" style="margin-bottom:12px">View-only — you don\'t have permission to edit networks.</p>'
      : (isDeprecatedIntegration
        ? '<p class="hint" style="margin-bottom:12px">This network was deprecated by an integration. Changing the status will convert it to a manual network.</p>'
        : (isIntegration ? '<p class="hint" style="margin-bottom:12px">This network is managed by an integration. Only purpose and tags can be edited.</p>' : ''));
    if (hasPendingMerge) {
      var pi = subnet.pendingIntegration;
      var mergeDesc = pi.integrationType === "windowsserver"
        ? escapeHtml(pi.integrationName)
        : escapeHtml(pi.integrationName) + ' on ' + escapeHtml(pi.fortigateDevice);
      hintMsg = '<div class="merge-banner">' +
        '<span>This network was also discovered by <strong>' + mergeDesc + '</strong>. Merge to let the integration manage it.</span>' +
        '<button class="btn btn-sm btn-primary" id="btn-merge">Merge</button>' +
        '</div>';
    }
    var body = hintMsg +
      '<div class="form-group"><label>CIDR</label><input type="text" value="' + escapeHtml(subnet.cidr) + '" disabled class="field-locked"></div>' +
      '<div class="form-group"><label>Name</label><input type="text" id="f-name" value="' + escapeHtml(subnet.name) + '"' + dis + '></div>' +
      '<div class="form-group"><label>Purpose</label><textarea id="f-purpose"' + purposeDis + '>' + escapeHtml(subnet.purpose || "") + '</textarea></div>' +
      '<div class="form-group"><label>Status</label><select id="f-status"' + statusDis + '><option value="available"' + (subnet.status === "available" ? " selected" : "") + '>Available</option><option value="reserved"' + (subnet.status === "reserved" ? " selected" : "") + '>Reserved</option><option value="deprecated"' + (subnet.status === "deprecated" ? " selected" : "") + '>Deprecated</option></select></div>' +
      '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" value="' + (subnet.vlan || "") + '" placeholder="Empty to clear"' + dis + '></div>' +
      tagFieldHTML(subnet.tags || [], { readOnly: readOnly });
    var footer = readOnly
      ? '<button class="btn btn-secondary" onclick="closeModal()">Close</button>'
      : '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal(readOnly ? "View Network" : "Edit Network", body, footer);
    if (!readOnly) wireTagPicker();

    if (hasPendingMerge) {
      document.getElementById("btn-merge").addEventListener("click", async function () {
        var mergeBtn = this;
        var pi = subnet.pendingIntegration;
        var mergeLabel = pi.integrationType === "windowsserver"
          ? pi.integrationName
          : pi.integrationName + ' on ' + pi.fortigateDevice;
        var ok = await showConfirm('Merge this network with "' + mergeLabel + '"? It will become managed by the integration.');
        if (!ok) return;
        mergeBtn.disabled = true;
        try {
          await api.subnets.update(id, { mergeIntegration: true });
          closeModal();
          showToast("Network merged with integration");
          loadSubnets();
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          mergeBtn.disabled = false;
        }
      });
    }

    if (!readOnly) {
      document.getElementById("btn-save").addEventListener("click", async function () {
        var btn = this;
        btn.disabled = true;
        try {
          var input = {
            purpose: val("f-purpose") || undefined,
            tags: getTagFieldValue(),
          };
          if (!isIntegration) {
            var vlanVal = document.getElementById("f-vlan").value;
            input.name = val("f-name") || undefined;
            input.status = val("f-status");
            input.vlan = vlanVal ? parseInt(vlanVal, 10) : null;
          } else if (isDeprecatedIntegration) {
            var newStatus = val("f-status");
            input.status = newStatus;
            if (newStatus !== "deprecated") {
              input.convertToManual = true;
            }
          }
          await api.subnets.update(id, input);
          closeModal();
          showToast("Network updated");
          loadSubnets();
        } catch (err) {
          showToast(err.message, "error");
        } finally {
          btn.disabled = false;
        }
      });
    }
  } catch (err) {
    showToast(err.message, "error");
  }
}

// Retire a network (business rule 41). Deliberately worded against Delete
// sitting right below it: this one PRESERVES, and the distinction is the whole
// reason both verbs exist. Archiving is also what frees a CIDR that a
// deprecated network is still holding — the state discovery reports as
// "a deprecated network still holds this range".
async function confirmArchiveSubnet(id, cidr, reservationCount) {
  var msg = 'Archive network "' + cidr + '"?';
  if (reservationCount > 0) {
    msg += ' Its ' + reservationCount + ' reservation' + (reservationCount !== 1 ? 's' : '') +
      ' will be archived with it.';
  }
  msg += ' Nothing is deleted — the network and everything it held stay readable under' +
    ' Archived networks — and its address space is released, so a replacement FortiGate' +
    ' can record the same range.';
  var ok = await showConfirm(msg);
  if (!ok) return;
  try {
    var out = await api.subnets.archive(id);
    showToast('Network archived with ' + out.reservationCount + ' reservation' +
      (out.reservationCount !== 1 ? 's' : '') + ' — its address space is free again');
    loadSubnets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function confirmDeleteSubnet(id, cidr, reservationCount) {
  var msg = 'Delete network "' + cidr + '"?';
  if (reservationCount > 0) {
    msg += ' This will also delete ' + reservationCount + ' reservation' + (reservationCount !== 1 ? 's' : '') + '.';
  }
  msg += ' This cannot be undone.';
  var ok = await showConfirm(msg);
  if (!ok) return;
  try {
    await api.subnets.delete(id);
    showToast("Network deleted");
    loadSubnets();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// val() is the app.js canonical (2026-08 audit — five identical top-level copies shadowed each other on co-loaded pages).

/* ─── PDF / CSV Export ──────────────────────────────────────────────────────
   The Export button + menu now live in the IPAM top page-header and are wired
   once by ipam.js, which calls window.PolarisSubnets.export(mode, fmt) when the
   Networks tab is active. (Previously an IIFE here tried to wire a button that
   lives inside the lazily-mounted tab template — it always ran before the tab
   was in the DOM, so getElementById returned null and export never worked.) */

async function handleNetworkExport(mode, fmt) {
  var networks, label, ok;

  var filteredData = _subnetsSF ? _subnetsSF.apply(_subnetsData) : _subnetsData;
  if (mode === "page") {
    networks = filteredData.slice((_subnetsPage - 1) * _subnetsPageSize, _subnetsPage * _subnetsPageSize);
    label = "page " + _subnetsPage;
  } else if (mode === "filtered") {
    networks = filteredData;
    label = networks.length + " filtered networks";
    if (networks.length > 100) {
      ok = await showConfirm("This will export " + networks.length + " networks. Continue?");
      if (!ok) return;
    }
  } else if (mode === "all") {
    ok = await showConfirm("Export the entire network list? This may take a moment.");
    if (!ok) return;
  }

  await trackedPdfExport("Exporting networks " + fmt.toUpperCase(), async function (signal) {
    if (mode === "all") {
      // "Entire Network List" must export EVERY known network, not just the
      // first page. The /subnets endpoint caps a single response at 10000 rows
      // (subnetService.listSubnets) and returns `total`, so page through until
      // we've collected them all rather than hardcoding a single limit.
      networks = [];
      var pageSize = 10000;
      var offset = 0;
      for (;;) {
        if (signal.aborted) return;
        var allResult = await request("GET", "/subnets?limit=" + pageSize + "&offset=" + offset, undefined, signal);
        var batch = allResult.subnets || allResult;
        networks = networks.concat(batch);
        var total = allResult.total;
        offset += batch.length;
        if (typeof total !== "number" || batch.length === 0 || networks.length >= total) break;
      }
      label = "all " + networks.length + " networks";
    }
    if (signal.aborted) return;
    if (!networks || networks.length === 0) { showToast("No networks to export", "error"); return; }
    if (fmt === "csv") generateNetworkCsv(networks);
    else generateNetworkPdf(networks, label);
  });
}

function generateNetworkPdf(networks, label) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();

  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " \u2014 Network Report", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp + "  |  Scope: " + label + "  |  Count: " + networks.length, 40, 52);

  var head = [["Name", "Network", "Block", "Purpose", "VLAN", "Status", "Sources", "Integration", "Reservations", "Utilization"]];
  var body = networks.map(function (s) {
    return [
      s.name || "-",
      s.cidr || "-",
      s.block ? s.block.name : "-",
      s.purpose || "-",
      s.vlan ? "VLAN " + s.vlan : "-",
      s.hasConflict ? ("Conflict" + (s.conflictMessage ? ": " + s.conflictMessage : "")) : (s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : "-"),
      s.fortigateDevice || "-",
      s.integration ? s.integration.name : "Manual",
      s._count ? String(s._count.reservations) : "0",
      _utilExportText(s),
    ];
  });

  doc.autoTable({
    startY: 64,
    head: head,
    body: body,
    theme: "grid",
    styles: { fontSize: 8, cellPadding: 4, overflow: "linebreak" },
    headStyles: { fillColor: [30, 30, 54], textColor: [230, 230, 230], fontStyle: "bold" },
    alternateRowStyles: { fillColor: [245, 245, 250] },
    margin: { left: 40, right: 40 },
    didDrawPage: function (data) {
      var pageNum = doc.internal.getNumberOfPages();
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 150);
      doc.text(
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Polaris") + " Network Report",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "polaris-networks-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + networks.length + " networks to " + filename);
}

// Utilization as an export cell: "12 / 254 (5%)", or a dash where there is no
// denominator to quote (IPv6). Shared by the PDF and CSV builders so the two
// can't phrase the same column differently.
function _utilExportText(s) {
  if (s.utilizationPercent == null || s.usableHosts == null) return "-";
  var used = s._count ? s._count.reservations : 0;
  return used + " / " + s.usableHosts + " (" + Math.round(s.utilizationPercent) + "%)";
}

function generateNetworkCsv(networks) {
  var headers = ["Name", "Network", "Block", "Purpose", "VLAN", "Status", "Tags", "Sources", "Integration", "Reservations", "Utilization"];
  var rows = networks.map(function (s) {
    return [
      s.name || "", s.cidr || "", s.block ? s.block.name : "",
      s.purpose || "", s.vlan ? String(s.vlan) : "", s.hasConflict ? ("Conflict" + (s.conflictMessage ? ": " + s.conflictMessage : "")) : (s.status || ""),
      (s.tags || []).join("; "), s.fortigateDevice || "",
      s.integration ? s.integration.name : "Manual",
      s._count ? String(s._count.reservations) : "0",
      _utilExportText(s),
    ];
  });
  var filename = "polaris-networks-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + networks.length + " networks to " + filename);
}
