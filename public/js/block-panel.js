/**
 * public/js/block-panel.js — Slide-over networks panel for blocks page
 */

var _blockPanelBlockId = null;
var _blockPanelData = null;
var _blockPanelDirty = false;

// ─── Panel lifecycle ────────────────────────────────────────────────────────

function _ensureBlockPanelDOM() {
  if (document.getElementById("block-panel-overlay")) return;
  var overlay = document.createElement("div");
  overlay.id = "block-panel-overlay";
  overlay.className = "slideover-overlay";
  overlay.innerHTML =
    '<div class="slideover" id="block-panel">' +
      '<div class="slideover-resize-handle"></div>' +
      '<div class="slideover-header">' +
        '<div class="slideover-header-top">' +
          '<h3 id="block-panel-title"></h3>' +
          '<button class="btn-icon" id="block-panel-close" title="Close">&times;</button>' +
        '</div>' +
        '<div class="slideover-meta" id="block-panel-meta"></div>' +
      '</div>' +
      '<div class="slideover-body" id="block-panel-body">' +
        '<p class="empty-state">Loading...</p>' +
      '</div>' +
      '<div class="slideover-footer" id="block-panel-footer"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeBlockPanel();
  });
  document.getElementById("block-panel-close").addEventListener("click", closeBlockPanel);

  initSlideoverResize(document.getElementById("block-panel"), "polaris.panel.width.block");
}

function openBlockPanel(blockId) {
  _ensureBlockPanelDOM();
  _blockPanelBlockId = blockId;
  _blockPanelDirty = false;
  document.getElementById("block-panel-title").textContent = "Loading...";
  document.getElementById("block-panel-meta").innerHTML = "";
  document.getElementById("block-panel-body").innerHTML = '<p class="empty-state">Loading...</p>';
  document.getElementById("block-panel-footer").innerHTML = "";
  revealOverlay(document.getElementById("block-panel-overlay"));
  _fetchBlockSubnets();
}

function closeBlockPanel() {
  var overlay = document.getElementById("block-panel-overlay");
  if (overlay) overlay.classList.remove("open");
  var activeRow = document.querySelector("tr.row-panel-active");
  if (activeRow) activeRow.classList.remove("row-panel-active");
  if (_blockPanelDirty && typeof loadBlocks === "function") loadBlocks();
  _blockPanelBlockId = null;
  _blockPanelData = null;
  _blockPanelDirty = false;
}

async function _fetchBlockSubnets() {
  try {
    var results = await Promise.all([
      api.blocks.get(_blockPanelBlockId),
      api.subnets.list({ blockId: _blockPanelBlockId, limit: 1000 }),
    ]);
    var block = results[0];
    var subnetsResult = results[1];
    var subnets = subnetsResult.subnets || subnetsResult;
    _blockPanelData = { block: block, subnets: subnets };
    _renderBlockPanelHeader(block);
    _renderBlockSubnetList(subnets);
    _renderBlockPanelFooter(subnets);
  } catch (err) {
    document.getElementById("block-panel-body").innerHTML =
      '<p class="empty-state">Error: ' + escapeHtml(err.message) + '</p>';
  }
}

// ─── Render helpers ─────────────────────────────────────────────────────────

function _renderBlockPanelHeader(block) {
  document.getElementById("block-panel-title").innerHTML =
    escapeHtml(block.name) + ' <code style="font-size:0.85rem;margin-left:4px">' + escapeHtml(block.cidr) + '</code>';

  var meta = '';
  meta += statusBadge(block.ipVersion);
  if (block.description) {
    meta += '<span style="color:var(--color-text-tertiary)">' + escapeHtml(block.description) + '</span>';
  }
  if (canCreateNetworks()) {
    meta += '<span style="margin-left:auto">' +
      '<button class="btn btn-sm btn-primary" id="block-panel-add-btn">+ Add Network</button>' +
      '</span>';
  }

  document.getElementById("block-panel-meta").innerHTML = meta;

  var addBtn = document.getElementById("block-panel-add-btn");
  if (addBtn) {
    addBtn.addEventListener("click", function () {
      _openBlockPanelAddSubnet(_blockPanelBlockId);
    });
  }
}

function _renderBlockSubnetList(subnets) {
  var body = document.getElementById("block-panel-body");

  if (subnets.length === 0) {
    body.innerHTML = '<p class="empty-state">No networks in this block.</p>';
    return;
  }

  var showActions = canCreateNetworks();
  var html = '<table class="ip-table"><thead><tr>' +
    '<th>Name</th>' +
    '<th>Network</th>' +
    '<th>Status</th>' +
    '<th>Sources</th>' +
    '<th>Integration</th>' +
    '<th>Reservations</th>' +
    '<th style="width:130px">Utilization</th>' +
    (showActions ? '<th style="width:100px">Actions</th>' : '') +
    '</tr></thead><tbody>';

  subnets.forEach(function (s) {
    var statusHtml = s.hasConflict
      ? (s.conflictMessage
          ? '<span title="' + escapeHtml(s.conflictMessage) + '">' + statusBadge("conflict") + '</span>'
          : statusBadge("conflict"))
      : statusBadge(s.status);
    var server = s.fortigateDevice
      ? escapeHtml(s.fortigateDevice)
      : '<span style="color:var(--color-text-tertiary)">-</span>';
    var integration = s.integration
      ? escapeHtml(s.integration.name)
      : '<span style="color:var(--color-text-tertiary)">Manual</span>';
    // Active reservations holding an address (what the server counts into
    // `_count.reservations`) — the Utilization bar beside it is this over the
    // CIDR's usable hosts. The Del confirmation takes `totalReservations`
    // instead: the cascade also removes the released and expired history.
    var reservations = s._count ? s._count.reservations : 0;

    html += '<tr>' +
      '<td><strong>' + escapeHtml(s.name) + '</strong></td>' +
      '<td class="mono" style="font-size:0.8rem">' + escapeHtml(s.cidr) + '</td>' +
      '<td>' + statusHtml + '</td>' +
      '<td style="font-size:0.8rem">' + server + '</td>' +
      '<td style="font-size:0.8rem">' + integration + '</td>' +
      '<td>' + reservations + '</td>' +
      '<td>' + subnetUtilCellHTML(s.utilizationPercent, reservations, s.usableHosts) + '</td>' +
      (showActions
        ? '<td class="actions">' +
            (canEditSubnet(s)
              ? '<button class="btn btn-sm btn-secondary subnet-panel-edit-btn" data-sid="' + s.id + '">Edit</button>' +
                '<button class="btn btn-sm btn-danger subnet-panel-del-btn"' +
                  ' data-sid="' + s.id + '"' +
                  ' data-cidr="' + escapeHtml(s.cidr) + '"' +
                  ' data-reservations="' + (s.totalReservations || 0) + '">Del</button>'
              : '') +
          '</td>'
        : '') +
      '</tr>';
  });

  html += '</tbody></table>';
  body.innerHTML = html;

  body.querySelectorAll(".subnet-panel-edit-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _openBlockPanelEditSubnet(btn.getAttribute("data-sid"));
    });
  });
  body.querySelectorAll(".subnet-panel-del-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      _confirmBlockPanelDeleteSubnet(
        btn.getAttribute("data-sid"),
        btn.getAttribute("data-cidr"),
        parseInt(btn.getAttribute("data-reservations"), 10) || 0
      );
    });
  });
}

function _renderBlockPanelFooter(subnets) {
  var count = subnets.length;
  document.getElementById("block-panel-footer").innerHTML =
    '<span>' + count + ' network' + (count !== 1 ? 's' : '') + '</span>';
}

// ─── Subnet modals ──────────────────────────────────────────────────────────

async function _openBlockPanelAddSubnet(blockId) {
  await _ensureTagCache();
  var body =
    '<div class="form-group"><label>CIDR *</label><input type="text" id="f-cidr" placeholder="e.g. 10.0.3.0/24"></div>' +
    '<div class="form-group"><label>Name *</label><input type="text" id="f-name" placeholder="e.g. API Servers"></div>' +
    '<div class="form-group"><label>Purpose</label><textarea id="f-purpose" placeholder="What is this network for?"></textarea></div>' +
    '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" placeholder="1-4094"></div>' +
    tagFieldHTML([]);
  var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">Create Network</button>';
  openModal("Add Network", body, footer);
  wireTagPicker();

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var vlan = document.getElementById("f-vlan").value;
      await api.subnets.create({
        blockId: blockId,
        cidr: document.getElementById("f-cidr").value.trim(),
        name: document.getElementById("f-name").value.trim(),
        purpose: document.getElementById("f-purpose").value.trim() || undefined,
        vlan: vlan ? parseInt(vlan, 10) : undefined,
        tags: getTagFieldValue(),
      });
      closeModal();
      showToast("Network created");
      _blockPanelDirty = true;
      _fetchBlockSubnets();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function _openBlockPanelEditSubnet(id) {
  try {
    var results = await Promise.all([api.subnets.get(id), _ensureTagCache()]);
    var subnet = results[0];
    var isIntegration = !!subnet.discoveredBy;
    var isDeprecatedIntegration = isIntegration && subnet.status === "deprecated" && canManageNetworks();
    var dis = isIntegration && !isDeprecatedIntegration ? ' disabled class="field-locked"' : '';
    var statusDis = isIntegration && !isDeprecatedIntegration ? ' disabled class="field-locked"' : '';
    var hint = isDeprecatedIntegration
      ? '<p class="hint" style="margin-bottom:12px">This network was deprecated by an integration. Changing the status will convert it to a manual network.</p>'
      : (isIntegration ? '<p class="hint" style="margin-bottom:12px">This network is managed by an integration. Only purpose and tags can be edited.</p>' : '');

    var body = hint +
      '<div class="form-group"><label>CIDR</label><input type="text" value="' + escapeHtml(subnet.cidr) + '" disabled class="field-locked"></div>' +
      '<div class="form-group"><label>Name</label><input type="text" id="f-name" value="' + escapeHtml(subnet.name) + '"' + dis + '></div>' +
      '<div class="form-group"><label>Purpose</label><textarea id="f-purpose">' + escapeHtml(subnet.purpose || "") + '</textarea></div>' +
      '<div class="form-group"><label>Status</label><select id="f-status"' + statusDis + '>' +
        '<option value="available"' + (subnet.status === "available" ? " selected" : "") + '>Available</option>' +
        '<option value="reserved"' + (subnet.status === "reserved" ? " selected" : "") + '>Reserved</option>' +
        '<option value="deprecated"' + (subnet.status === "deprecated" ? " selected" : "") + '>Deprecated</option>' +
      '</select></div>' +
      '<div class="form-group"><label>VLAN</label><input type="number" id="f-vlan" min="1" max="4094" value="' + (subnet.vlan || "") + '" placeholder="Empty to clear"' + dis + '></div>' +
      tagFieldHTML(subnet.tags || []);
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-save">Save Changes</button>';
    openModal("Edit Network", body, footer);
    wireTagPicker();

    document.getElementById("btn-save").addEventListener("click", async function () {
      var btn = this;
      btn.disabled = true;
      try {
        var input = {
          purpose: document.getElementById("f-purpose").value.trim() || undefined,
          tags: getTagFieldValue(),
        };
        if (!isIntegration) {
          var vlanVal = document.getElementById("f-vlan").value;
          input.name = document.getElementById("f-name").value.trim() || undefined;
          input.status = document.getElementById("f-status").value;
          input.vlan = vlanVal ? parseInt(vlanVal, 10) : null;
        } else if (isDeprecatedIntegration) {
          var newStatus = document.getElementById("f-status").value;
          input.status = newStatus;
          if (newStatus !== "deprecated") input.convertToManual = true;
        }
        await api.subnets.update(id, input);
        closeModal();
        showToast("Network updated");
        _blockPanelDirty = true;
        _fetchBlockSubnets();
      } catch (err) {
        showToast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function _confirmBlockPanelDeleteSubnet(id, cidr, reservationCount) {
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
    _blockPanelDirty = true;
    _fetchBlockSubnets();
  } catch (err) {
    showToast(err.message, "error");
  }
}
