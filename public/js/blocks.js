/**
 * public/js/blocks.js — IP Blocks list + CRUD
 */

var _blocksPageSize = 15;
var _blocksPage = 1;
var _blocksData = [];
var _blocksSF = null;
var _blocksLayout = null;

function _saveBlocksPrefs() {
  PolarisPrefs.save("blocks", currentUsername, Object.assign(
    { pageSize: _blocksPageSize, layout: _blocksLayout ? _blocksLayout.getPrefs() : null },
    _blocksSF ? _blocksSF.getPrefs() : {},
  ));
}

function _restoreBlocksPrefs() {
  var p = PolarisPrefs.load("blocks", currentUsername);
  if (!p) return;
  if (p.pageSize) {
    _blocksPageSize = p.pageSize;
    var psSel = document.getElementById("filter-pagesize");
    if (psSel) psSel.value = String(p.pageSize);
  }
  if (_blocksSF) _blocksSF.setPrefs(p);
  if (_blocksLayout && p.layout) _blocksLayout.setPrefs(p.layout);
}

// Init is callable both by the legacy /blocks.html auto-run AND by the
// IPAM tabbed page (public/js/ipam.js) which mounts this tab's markup on
// demand. Re-callable: each call rebuilds the TableSF / column layout
// against whatever DOM is currently in the document.
async function _initBlocksPage() {
  _blocksSF = new TableSF("blocks-tbody", function () { _blocksPage = 1; renderBlocksPage(); _saveBlocksPrefs(); });
  var blocksTable = document.querySelector("#blocks-tbody").closest("table");
  _blocksLayout = setupColumnLayout(blocksTable, {
    onChange: _saveBlocksPrefs,
  });
  await userReady;
  _restoreBlocksPrefs();
  loadBlocks();
  wireFavoriteClicks("blocks-tbody", function () { renderBlocksPage(); });

  // The row's verbs live behind its name. "Open" is what the name click used to
  // do on its own; Edit / Delete appear only for operators who may manage
  // networks, so a read-only viewer still gets a one-item menu that opens the
  // block rather than a control that does nothing.
  document.getElementById("blocks-tbody").addEventListener("click", function (e) {
    var trigger = e.target.closest(".block-menu");
    if (!trigger) return;
    e.preventDefault();
    var id = trigger.getAttribute("data-block-id");
    var b = (_blocksData || []).find(function (x) { return x.id === id; });
    if (!b) return;
    var items = [{ label: "Open", onSelect: function () { openBlockFromRow(trigger, id); } }];
    if (canManageNetworks()) {
      items.push({ label: "Edit", onSelect: function () { openBlockEditModal(id); } });
      items.push({ separator: true });
      items.push({ label: "Delete", danger: true, onSelect: function () { confirmDeleteBlock(id, b.cidr, b._count ? b._count.subnets : 0); } });
    }
    showRowMenu(trigger, items, { label: "Actions for " + b.name });
  });

  var addBtn = document.getElementById("btn-add-block");
  if (addBtn) addBtn.addEventListener("click", openBlockCreateModal);
  // Page-size selector now lives in the pagination row (renderPageControls
  // onSizeChange) — no standalone #filter-pagesize.
}

// export() is invoked by the IPAM orchestrator (ipam.js), which owns the single
// Export button in the top page-header and dispatches to the active tab.
window.PolarisBlocks = { init: _initBlocksPage, export: handleBlockExport };

// The legacy /blocks.html bootstrap still auto-runs on its own page. The
// IPAM page sets window.__polarisIpamTabs=true BEFORE this script loads so
// the auto-run is suppressed there and ipam.js calls init() on demand.
if (!window.__polarisIpamTabs) {
  document.addEventListener("DOMContentLoaded", _initBlocksPage);
}

/** Open the block panel, moving the row highlight to this row. */
function openBlockFromRow(trigger, id) {
  var prev = document.querySelector("tr.row-panel-active");
  if (prev) prev.classList.remove("row-panel-active");
  var row = trigger.closest("tr");
  if (row) row.classList.add("row-panel-active");
  openBlockPanel(id);
}

async function loadBlocks() {
  var tbody = document.getElementById("blocks-tbody");
  try {
    // Version filtering now lives in the Version column header filter (TableSF),
    // so the full block list loads and filtering happens client-side.
    _blocksData = await api.blocks.list();
    renderBlocksPage();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderBlocksPage() {
  var tbody = document.getElementById("blocks-tbody");
  if (_blocksData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No IP blocks found. Create one to get started.</td></tr>';
    clearPageControls("pagination");
    return;
  }
  var sfData = _blocksSF ? _blocksSF.apply(_blocksData) : _blocksData;
  if (sfData.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">No results match the current filters.</td></tr>';
    clearPageControls("pagination");
    return;
  }
  sfData = sortFavoritesFirst(sfData, "blocks");
  var start = (_blocksPage - 1) * _blocksPageSize;
  var page = sfData.slice(start, start + _blocksPageSize);
  tbody.innerHTML = page.map(function (b) {
    var tags = (b.tags || []).map(function (t) { return escapeHtml(t); }).join(", ");
    return '<tr>' +
      starCellHTML("blocks", b.id) +
      '<td><button type="button" class="row-menu-trigger block-menu" data-block-id="' + b.id + '" ' +
        'aria-haspopup="menu" aria-expanded="false" title="Actions for this block">' +
        '<strong>' + escapeHtml(b.name) + '</strong></button></td>' +
      '<td class="mono" title="' + cidrRangeTitle(b.cidr) + '">' + escapeHtml(b.cidr) + '</td>' +
      '<td>' + statusBadge(b.ipVersion) + '</td>' +
      '<td>' + escapeHtml(b.description || "-") + '</td>' +
      '<td>' + (tags || '<span style="color:var(--color-text-tertiary)">-</span>') + '</td>' +
      '<td>' + (b._count ? b._count.subnets : 0) + '</td>' +
      '<td>' + formatDate(b.createdAt) + '</td>' +
      '</tr>';
  }).join("");
  renderPageControls("pagination", sfData.length, _blocksPageSize, _blocksPage, function (p) {
    _blocksPage = p;
    renderBlocksPage();
  }, function (size) {
    _blocksPageSize = size;
    _blocksPage = 1;
    renderBlocksPage();
    _saveBlocksPrefs();
  });
}

async function openBlockCreateModal() {
  await _ensureTagCache();
  var body = formHTML({ name: "", cidr: "", description: "" }) + tagFieldHTML([]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Create Block</button>';
  openModal("Add IP Block", body, footer);
  wireTagPicker();
  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var input = {
        name: val("f-name"),
        cidr: val("f-cidr"),
        description: val("f-description") || undefined,
        tags: getTagFieldValue(),
      };
      await api.blocks.create(input);
      closeModal();
      showToast("Block created");
      loadBlocks();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function openBlockEditModal(id) {
  try {
    var block = await api.blocks.get(id);
    await _ensureTagCache();
    var readOnly = !canManageNetworks();
    var lock = readOnly ? ' disabled class="field-locked"' : '';
    var banner = readOnly
      ? '<p class="hint" style="margin-bottom:12px">View-only — you don\'t have permission to edit blocks.</p>'
      : '';
    var body = banner +
      '<div class="form-group"><label>Name</label><input type="text" id="f-name" value="' + escapeHtml(block.name) + '"' + lock + '></div>' +
      '<div class="form-group"><label>CIDR</label><input type="text" value="' + escapeHtml(block.cidr) + '" disabled></div>' +
      '<div class="form-group"><label>Description</label><textarea id="f-description"' + lock + '>' + escapeHtml(block.description || "") + '</textarea></div>' +
      tagFieldHTML(block.tags || [], { readOnly: readOnly });
    var footer = readOnly
      ? '<button class="btn btn-secondary" onclick="closeModal()">Close</button>'
      : '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button><button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal(readOnly ? "View Block" : "Edit Block", body, footer);
    if (!readOnly) {
      wireTagPicker();
      document.getElementById("btn-save").addEventListener("click", async function () {
        var btn = this;
        btn.disabled = true;
        try {
          var input = {
            name: val("f-name") || undefined,
            description: val("f-description") || undefined,
            tags: getTagFieldValue(),
          };
          await api.blocks.update(id, input);
          closeModal();
          showToast("Block updated");
          loadBlocks();
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

// A block that still holds networks cannot be deleted (business rule 4) — say
// so up front rather than asking to confirm a delete the server will refuse.
// The server is still the authority: a network added since the list loaded
// comes back as the same 409 message through the catch below.
async function confirmDeleteBlock(id, cidr, networkCount) {
  if (networkCount > 0) {
    showToast('Block "' + cidr + '" still contains ' + networkCount + ' network' +
      (networkCount !== 1 ? 's' : '') + '. Move them to another block (Networks → Move to block…), ' +
      'archive or delete them first.', "error");
    return;
  }
  var ok = await showConfirm('Delete block "' + cidr + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.blocks.delete(id);
    showToast("Block deleted");
    loadBlocks();
  } catch (err) {
    showToast(err.message, "error");
  }
}

function formHTML(defaults) {
  return '<div class="form-group"><label>Name *</label><input type="text" id="f-name" value="' + escapeHtml(defaults.name) + '" placeholder="e.g. Corporate Datacenter"></div>' +
    '<div class="form-group"><label>CIDR *</label><input type="text" id="f-cidr" value="' + escapeHtml(defaults.cidr) + '" placeholder="e.g. 10.0.0.0/8"></div>' +
    '<div class="form-group"><label>Description</label><textarea id="f-description" placeholder="Optional description">' + escapeHtml(defaults.description) + '</textarea></div>';
}

// val() is the app.js canonical (2026-08 audit — five identical top-level copies shadowed each other on co-loaded pages).

function cidrRangeTitle(cidr) {
  try {
    var range = _cidrToRange(cidr);
    if (!range) return "";
    return "Start: " + range.start + "\nEnd:   " + range.end;
  } catch (_) { return ""; }
}

function _cidrToRange(cidr) {
  var slash = cidr.indexOf("/");
  if (slash === -1) return null;
  var ip = cidr.slice(0, slash);
  var prefix = parseInt(cidr.slice(slash + 1), 10);
  return ip.indexOf(":") === -1 ? _cidr4Range(ip, prefix) : _cidr6Range(ip, prefix);
}

function _cidr4Range(ip, prefix) {
  var p = ip.split(".");
  if (p.length !== 4) return null;
  var n = ((parseInt(p[0], 10) << 24) | (parseInt(p[1], 10) << 16) | (parseInt(p[2], 10) << 8) | parseInt(p[3], 10)) >>> 0;
  var mask = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  var start = (n & mask) >>> 0;
  var end = (start | (~mask >>> 0)) >>> 0;
  function fmt(x) { return [(x >>> 24) & 0xFF, (x >>> 16) & 0xFF, (x >>> 8) & 0xFF, x & 0xFF].join("."); }
  return { start: fmt(start), end: fmt(end) };
}

function _cidr6Range(ip, prefix) {
  var groups = _expandIPv6(ip);
  if (!groups) return null;
  var bits = BigInt(0);
  for (var i = 0; i < 8; i++) bits = (bits << BigInt(16)) | BigInt(groups[i]);
  var hostBits = BigInt(128 - prefix);
  var mask = prefix === 0 ? BigInt(0) : ~((BigInt(1) << hostBits) - BigInt(1)) & ((BigInt(1) << BigInt(128)) - BigInt(1));
  var start = bits & mask;
  var end = start | ((BigInt(1) << hostBits) - BigInt(1));
  return { start: _compressIPv6(start), end: _compressIPv6(end) };
}

function _expandIPv6(ip) {
  var halves = ip.split("::");
  var left = halves[0] ? halves[0].split(":") : [];
  var right = halves.length > 1 ? (halves[1] ? halves[1].split(":") : []) : null;
  var groups;
  if (right !== null) {
    var fill = [];
    for (var i = 0; i < 8 - left.length - right.length; i++) fill.push("0");
    groups = left.concat(fill, right);
  } else {
    groups = left;
  }
  if (groups.length !== 8) return null;
  return groups.map(function (g) { return parseInt(g || "0", 16); });
}

function _compressIPv6(bigint) {
  var groups = [];
  var rem = bigint;
  for (var i = 0; i < 8; i++) { groups.unshift(Number(rem & BigInt(0xFFFF))); rem >>= BigInt(16); }
  var bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (var j = 0; j < 8; j++) {
    if (groups[j] === 0) {
      if (curStart === -1) { curStart = j; curLen = 1; } else curLen++;
      if (curLen > bestLen) { bestStart = curStart; bestLen = curLen; }
    } else { curStart = -1; curLen = 0; }
  }
  if (bestLen < 2) return groups.map(function (g) { return g.toString(16); }).join(":");
  var L = groups.slice(0, bestStart).map(function (g) { return g.toString(16); }).join(":");
  var R = groups.slice(bestStart + bestLen).map(function (g) { return g.toString(16); }).join(":");
  return L + "::" + R;
}

/* ─── PDF / CSV Export ──────────────────────────────────────────────────────
   Wired by ipam.js (which owns the single Export button in the IPAM top
   page-header) via window.PolarisBlocks.export(mode, fmt) when the IP Blocks
   tab is active. Mirrors the Networks export (handleNetworkExport in
   subnets.js) so both tabs offer the same page / filtered / all + PDF / CSV
   options as the Assets page. */

async function handleBlockExport(mode, fmt) {
  var blocks, label, ok;

  var filteredData = _blocksSF ? _blocksSF.apply(_blocksData) : _blocksData;
  if (mode === "page") {
    blocks = filteredData.slice((_blocksPage - 1) * _blocksPageSize, _blocksPage * _blocksPageSize);
    label = "page " + _blocksPage;
  } else if (mode === "filtered") {
    blocks = filteredData;
    label = blocks.length + " filtered blocks";
    if (blocks.length > 100) {
      ok = await showConfirm("This will export " + blocks.length + " blocks. Continue?");
      if (!ok) return;
    }
  } else if (mode === "all") {
    ok = await showConfirm("Export the entire block list? This may take a moment.");
    if (!ok) return;
  }

  await trackedPdfExport("Exporting blocks " + fmt.toUpperCase(), async function (signal) {
    if (mode === "all") {
      var allResult = await request("GET", "/blocks", undefined, signal);
      blocks = allResult.blocks || allResult;
      label = "all " + blocks.length + " blocks";
    }
    if (signal.aborted) return;
    if (!blocks || blocks.length === 0) { showToast("No blocks to export", "error"); return; }
    if (fmt === "csv") generateBlockCsv(blocks);
    else generateBlockPdf(blocks, label);
  });
}

function generateBlockPdf(blocks, label) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("PDF library not loaded. Check your internet connection and reload the page.");
  }
  var jsPDF = window.jspdf.jsPDF;
  var doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "letter" });

  var now = new Date();
  var timestamp = now.toLocaleDateString() + " " + now.toLocaleTimeString();

  doc.setFontSize(16);
  doc.setTextColor(40, 40, 40);
  doc.text((_branding ? _branding.appName : "Polaris") + " — IP Block Report", 40, 36);
  doc.setFontSize(9);
  doc.setTextColor(120, 120, 120);
  doc.text("Generated: " + timestamp + "  |  Scope: " + label + "  |  Count: " + blocks.length, 40, 52);

  var head = [["Name", "CIDR", "Version", "Description", "Tags", "Networks", "Created"]];
  var body = blocks.map(function (b) {
    return [
      b.name || "-",
      b.cidr || "-",
      b.ipVersion === "v6" ? "IPv6" : (b.ipVersion === "v4" ? "IPv4" : "-"),
      b.description || "-",
      (b.tags || []).join(", ") || "-",
      b._count ? String(b._count.subnets) : "0",
      b.createdAt ? formatDate(b.createdAt) : "-",
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
        "Page " + data.pageNumber + " of " + pageNum + "  |  " + (_branding ? _branding.appName : "Polaris") + " IP Block Report",
        doc.internal.pageSize.getWidth() / 2,
        doc.internal.pageSize.getHeight() - 20,
        { align: "center" }
      );
    },
  });

  var filename = "polaris-ip-blocks-" + now.toISOString().slice(0, 10) + ".pdf";
  doc.save(filename);
  showToast("Exported " + blocks.length + " blocks to " + filename);
}

function generateBlockCsv(blocks) {
  var headers = ["Name", "CIDR", "Version", "Description", "Tags", "Networks", "Created"];
  var rows = blocks.map(function (b) {
    return [
      b.name || "", b.cidr || "",
      b.ipVersion === "v6" ? "IPv6" : (b.ipVersion === "v4" ? "IPv4" : ""),
      b.description || "", (b.tags || []).join("; "),
      b._count ? String(b._count.subnets) : "0",
      b.createdAt ? formatDate(b.createdAt) : "",
    ];
  });
  var filename = "polaris-ip-blocks-" + new Date().toISOString().slice(0, 10) + ".csv";
  downloadCsv(headers, rows, filename);
  showToast("Exported " + blocks.length + " blocks to " + filename);
}
