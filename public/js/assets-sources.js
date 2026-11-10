/**
 * public/js/assets-sources.js — where an asset's data came from: the Sources tab (source states, the
 * dependency tree, sightings, IP history), splitting a MAC off onto its own
 * asset (business rule 91(j)), TLS / SSH host pins, and the Quarantine tab.
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── Sources tab (multi-source asset model — Phase 3a) ─────────────────────
//
// Renders the AssetSource rows for an asset, one card per source, in stable
// presentation order (entra → intune → ad → fortigate-firewall → fortiswitch →
// fortiap → manual). Each card shows the source's friendly label, the
// originating integration (when known), an inferred-row warning badge, and
// the raw observed blob as a key-value table — that's the "what did this
// source independently say" view that the Phase 1+2 foundation set up.

// _assetSourceLabels moved to app.js — the merge modal (asset-merge-modal.js)
// renders the same vocabulary from the Conflicts panel, which does not load
// this file.

// Internal fields hidden from the per-source key/value table. `kind` and
// `syncedAt` are surfaced in the card header instead; raw recovery markers
// like `recovered` are shown via the inferred badge. The two account-state
// booleans are hidden too — the header's state badge renders exactly those,
// and they're the pair whose opposite polarity ("Account Enabled: No" vs
// "Account Disabled: Yes") is what made the raw table hard to read across
// sources.
var _assetSourceHiddenObservedKeys = {
  kind: 1, syncedAt: 1, recovered: 1, accountEnabled: 1, accountDisabled: 1,
};

// Badge treatment per normalized source state (server-derived — see
// src/utils/assetSourceState.ts). Grey for "not reported" so a source that
// simply doesn't speak to lifecycle never reads as a problem.
var _assetSourceStateBadgeClass = {
  "enabled":  "badge-active",
  "disabled": "badge-disabled",
  "unknown":  "badge-unmonitored",
};

// Header badge answering "does THIS source consider the asset enabled?".
function _assetSourceStateBadge(state) {
  if (!state || !state.label) return "";
  var cls = _assetSourceStateBadgeClass[state.state] || "badge-unmonitored";
  var tip = state.field
    ? "This source reports " + state.field + " = " + (state.value === null ? "—" : state.value)
    : "This source reports no enabled/disabled state for the asset.";
  return '<span class="badge ' + cls + '" title="' + escapeHtml(tip) + '">' + escapeHtml(state.label) + '</span>';
}

// One-line roll-up above the source cards: which sources call the asset
// enabled and which call it disabled. Only rendered when at least one source
// actually reports a state; account-kind disagreement (one directory says
// enabled, another says disabled) gets called out explicitly because that's
// the case that drives the asset's lifecycle status.
function _assetSourceStateSummaryHTML(sources) {
  var reported = sources.filter(function (s) { return s.state && s.state.state && s.state.state !== "unknown"; });
  if (!reported.length) return "";

  var render = function (list) {
    return list.map(function (s) {
      var label = _assetSourceLabels[s.sourceKind] || s.sourceKind;
      return '<span style="white-space:nowrap">' + escapeHtml(label) + ' <span style="color:var(--color-text-secondary)">(' + escapeHtml(s.state.label) + ')</span></span>';
    }).join(", ");
  };
  var enabled  = reported.filter(function (s) { return s.state.state === "enabled"; });
  var disabled = reported.filter(function (s) { return s.state.state === "disabled"; });

  var lines = [];
  if (enabled.length)  lines.push('<div><strong style="color:var(--color-success)">Enabled</strong> per ' + render(enabled) + '</div>');
  if (disabled.length) lines.push('<div><strong style="color:#ef9a9a">Disabled</strong> per ' + render(disabled) + '</div>');

  var accountStates = {};
  reported.forEach(function (s) { if (s.state.kind === "account") accountStates[s.state.state] = 1; });
  var conflict = accountStates.enabled && accountStates.disabled
    ? '<div style="margin-top:0.35rem;color:var(--color-warning)">Directory sources disagree — a disabled account decommissions the asset, so the disabling directory wins on the next discovery run.</div>'
    : '';

  return '<div class="section-block" style="margin-bottom:1rem;font-size:0.85rem;line-height:1.6">' +
    '<div class="section-label" style="margin-bottom:0.35rem">Reported state by source</div>' +
    lines.join("") + conflict +
  '</div>';
}

function _humanizeSourceObservedKey(k) {
  // Camel-case → "Title Case With Spaces".
  if (!k) return "";
  var spaced = String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function _formatSourceObservedValue(v) {
  if (v === null || v === undefined) return '<span style="color:var(--color-text-secondary)">—</span>';
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (typeof v === "number") return escapeHtml(String(v));
  if (typeof v === "string") {
    // Pretty-print ISO timestamps; raw-show short strings; mono-format obvious
    // identifiers so they're easy to read at a glance.
    if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return escapeHtml(formatDate(v));
    if (_isCopyableAddress(v)) return _sourceAddressCopyHTML(v);
    return escapeHtml(v);
  }
  // A list of addresses (a source's MACs, its IPs): one click-to-copy value each.
  if (Array.isArray(v) && v.length && v.every(function (x) { return typeof x === "string" && _isCopyableAddress(x); })) {
    return v.map(_sourceAddressCopyHTML).join(", ");
  }
  return '<code class="mono" style="font-size:0.78rem">' + escapeHtml(JSON.stringify(v)) + '</code>';
}

// Is this observed value an IP address (v4 / v6, optionally with a /prefix)
// or a MAC address? Those are click-to-copy on the Sources tab. A shape check
// only: the value is copied verbatim, never parsed (IP math lives server-side).
var _SOURCE_IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/\d{1,2})?$/;
var _SOURCE_IPV6_RE = /^[0-9a-f:.]{2,45}(?:%[\w.-]+)?(?:\/\d{1,3})?$/i;
var _SOURCE_MAC_RE = /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$|^(?:[0-9a-f]{4}\.){2}[0-9a-f]{4}$/i;
function _isCopyableAddress(v) {
  var t = String(v).trim();
  if (!t) return false;
  if (_SOURCE_MAC_RE.test(t) || _SOURCE_IPV4_RE.test(t)) return true;
  // IPv6: hex groups with "::" or all eight groups (so "12:30:45" is not one).
  return _SOURCE_IPV6_RE.test(t) && (t.indexOf("::") !== -1 || (t.match(/:/g) || []).length === 7);
}
function _sourceAddressCopyHTML(v) {
  return '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(v) + '">' + escapeHtml(v) + '</span>';
}

// Status pip rendered next to each row in the dependency tree. Mirrors the
// Status-pill priority used elsewhere: probe-down beats dep-down beats the
// rest of the five-state machine. We render a single character (▲ ● ▼) so
// the tree stays scannable; full label is in the title tooltip.
function _depTreeStatusPip(node) {
  // node may be either a parent (no dependencySuppressed field surfaced) or a
  // child (has it). For parents we don't have suppressed in the payload —
  // that's fine, the pip just reflects monitorStatus.
  if (!node || node.monitored === false) return '<span class="dep-tree-pip dep-tree-pip-unmon" title="Unmonitored">●</span>';
  // Admin-only "Dependency Test" overlay outranks every other state in the
  // tree pip — admins reading the tree need to see immediately which node
  // is the simulated-down one driving suppression downstream.
  var depTestUntil = node.dependencyTestUntil ? new Date(node.dependencyTestUntil) : null;
  if (depTestUntil && depTestUntil.getTime() > Date.now()) {
    return '<span class="dep-tree-pip dep-tree-pip-dep-test" title="Dependency Test active — simulated DOWN until ' + escapeHtml(formatDateTime(depTestUntil)) + '">●</span>';
  }
  if (node.dependencySuppressed) {
    return '<span class="dep-tree-pip dep-tree-pip-dep" title="Dep. Down — upstream parent is offline">●</span>';
  }
  switch (node.monitorStatus) {
    case "up":         return '<span class="dep-tree-pip dep-tree-pip-up"   title="Up">▲</span>';
    case "warning":    return '<span class="dep-tree-pip dep-tree-pip-warn" title="Missed">▲</span>';
    case "recovering": return '<span class="dep-tree-pip dep-tree-pip-rec"  title="Recovering">▲</span>';
    case "down":       return '<span class="dep-tree-pip dep-tree-pip-down" title="Down">▼</span>';
    // Hollow glyph, matching the hollow pill: no verdict was rendered.
    case "passive":    return '<span class="dep-tree-pip dep-tree-pip-passive" title="Passive — no down-detection automation covers this device">◇</span>';
    default:           return '<span class="dep-tree-pip dep-tree-pip-unk"  title="Pending">●</span>';
  }
}

var _DEP_TREE_TYPE_LABEL = { firewall: "firewall", switch: "switch", access_point: "access point" };

// How the edge to this node's parent was detected, in operator words. The three
// endpoint-half values matter most: an edge that silences alerts should say out
// loud which signal put it there. "controller"/"interface"/"lldp"/"mesh" are the
// Fortinet infra half; "hypervisor" is a vCenter VM→host placement.
var _DEP_TREE_VIA_LABEL = {
  "switch-port": "last-seen switch port",
  wireless:      "last-seen access point",
  sighting:      "last-seen firewall",
  subnet:        "owning firewall (from IPAM)",
  hypervisor:    "hypervisor placement",
  controller:    "controller",
  interface:     "interface",
  lldp:          "LLDP",
  mesh:          "wireless mesh",
  manual:        "operator override"
};
var _DEP_TREE_VIA_TITLE = {
  "switch-port": "Detected from the FortiSwitch port this device was last seen on",
  wireless:      "Detected from the FortiAP this device was last associated with",
  sighting:      "Detected from the FortiGate that last saw this device (DHCP lease / reservation / ARP)",
  subnet:        "Inferred: no FortiGate has reported this device, so the gate that owns the network its IP sits in was used. Least specific — it places the device by address, not by having seen it",
  hypervisor:    "Detected from the vCenter host this VM is placed on"
};

// Humanize a raw assetType for the tree ("kubernetes_cluster" → "kubernetes cluster").
function _depTreeTypeLabel(assetType) {
  if (_DEP_TREE_TYPE_LABEL[assetType]) return _DEP_TREE_TYPE_LABEL[assetType];
  return String(assetType || "asset").replace(/_/g, " ");
}

// Click target: hostname becomes a button that pivots openViewModal to that
// asset. When the hostname is missing we fall through to the asset id.
function _depTreeNodeRow(node, opts) {
  opts = opts || {};
  var name = node.hostname || node.id;
  var safeName = escapeHtml(name);
  var typeLabel = _depTreeTypeLabel(node.assetType);
  var pip = _depTreeStatusPip(node);
  // Caller-supplied annotation tag (e.g. the HA-peer row's "HA standby") —
  // reuses the override-tag styling.
  var extraTag = opts.tag
    ? ' <span class="dep-tree-source-tag"' + (opts.tagTitle ? ' title="' + escapeHtml(opts.tagTitle) + '"' : '') + '>' + escapeHtml(opts.tag) + '</span>'
    : "";
  // Every node carries its computed dependencyLayer in the payload; surface it
  // so the operator can read each row's level, not just the current asset's.
  var levelBit = (node.dependencyLayer != null)
    ? ' <span class="dep-tree-level" title="Dependency level ' + node.dependencyLayer + '">L' + node.dependencyLayer + '</span>'
    : "";
  // Two rows reading the same name are two devices (business rule 91 — a
  // FortiLink fleet names its switch-ids per site, so "IDF-1" sits behind
  // every gate). renderDependencyTreeBlock passes the serial (or, failing
  // that, the address) for every node whose hostname another rendered node
  // shares, and it rides the link's tooltip too so the pivot says where it goes.
  var disambigHTML = opts.disambig
    ? ' <span class="dep-tree-disambig" title="Shares its name with another device in this tree — this is the one with ' + (opts.disambigKind === "ip" ? "address " : "serial ") + escapeHtml(opts.disambig) + '">' + escapeHtml(opts.disambig) + '</span>'
    : "";
  var openTitle = "Open " + safeName + (opts.disambig ? " (" + escapeHtml(opts.disambig) + ")" : "");
  var hostHTML;
  if (opts.self) {
    // Current asset — bold + non-clickable, with the level annotation.
    var layerBit = (node.dependencyLayer != null) ? ' <span class="dep-tree-self-meta">— level ' + node.dependencyLayer + '</span>' : "";
    hostHTML = '<strong class="dep-tree-self">' + safeName + '</strong>' + disambigHTML + layerBit;
  } else {
    hostHTML = '<button type="button" class="dep-tree-link" data-asset-id="' + escapeHtml(node.id) + '" title="' + openTitle + '">' + safeName + '</button>' + disambigHTML;
  }
  var sourceTag = (node.source === "override") ? ' <span class="dep-tree-source-tag" title="Operator override">override</span>' : "";
  // How the edge was detected. Shown for the endpoint-half signals and the
  // hypervisor one — for the Fortinet infra signals it's implied by the shape of
  // the tree and would just add noise to every row.
  var viaTag = "";
  if (!opts.self && opts.via && _DEP_TREE_VIA_TITLE[opts.via]) {
    viaTag = ' <span class="dep-tree-source-tag" title="' + escapeHtml(_DEP_TREE_VIA_TITLE[opts.via]) + '">' +
      escapeHtml(_DEP_TREE_VIA_LABEL[opts.via] || opts.via) + '</span>';
  }
  // "+N more" hint for a node whose own children were capped out of the payload.
  // Infra-only, like the tree itself — this can never be a count of downstream
  // workstations or printers.
  var moreTag = (opts.moreCount > 0)
    ? ' <span class="dep-tree-level" title="' + opts.moreCount + ' more switch(es) / access point(s) below this device, not shown here — open it to see them">+' + opts.moreCount + '</span>'
    : "";
  var depthClass = opts.depth ? ' dep-tree-row-depth-' + opts.depth : '';
  // Worst active alert on this node — the assets list's strobe dot (app.js
  // alertSummaryDotHTML), so a device reads equally alarmed here and in the
  // list: strobing while any alert is unacknowledged, still once all are taken.
  // Separate from the pip, which is monitor STATE: an up device can be alerting.
  var alertDot = node.activeAlert ? ' ' + alertSummaryDotHTML(node.activeAlert) : '';
  return '<div class="dep-tree-row' + (opts.self ? ' dep-tree-row-self' : '') + depthClass + '">' +
    pip + ' ' + hostHTML + alertDot +
    ' <span class="dep-tree-type">' + escapeHtml(typeLabel) + '</span>' +
    // Self node already prints "— level N" inline, so skip the tag there.
    (opts.self ? '' : levelBit) +
    sourceTag +
    viaTag +
    moreTag +
    extraTag +
    '</div>';
}

// Render the General-tab dependency tree block. Hidden by default; populated
// asynchronously after openViewModal awaits api.assets.getDependencies(id).
// `payload` is the full /dependencies response. `selfId` distinguishes the
// current asset from any other id that might appear in the lists (defensive).
function renderDependencyTreeBlock(payload, selfId) {
  if (!payload) return "";
  var parents  = Array.isArray(payload.effectiveParents) ? payload.effectiveParents : [];
  var children = Array.isArray(payload.children)         ? payload.children         : [];
  var self     = payload.asset || {};
  // HA cluster peer (firewalls only). Display-only sibling: the DAG has no
  // edge between HA members (both are layer-1 roots), so this is the only
  // way the tree shows the cluster's second box.
  var haPeer   = payload.haPeer || null;
  if (parents.length === 0 && children.length === 0 && !haPeer) {
    // Endpoints joined the tree in 2026-08 (they hang off their last-seen
    // switch / AP / FortiGate), so the block now renders for every asset type.
    // An endpoint landing here has no resolvable upstream device, which is worth
    // saying plainly: it's also the reason dependency suppression can't apply,
    // so this row alerts on its own probe state even when its site is dark.
    //
    // The infra wording names switches / APs specifically rather than claiming
    // "no dependency chain at all", because the downward view is infra-only: a
    // gate with endpoints sighted on it but no managed switches lands here, and
    // it does have dependents — they're just not this tree's subject.
    var infraTypes = ["firewall", "switch", "access_point"];
    var isInfra = infraTypes.indexOf(self.assetType) !== -1;
    return '<div class="dep-tree-block">' +
      '<div class="dep-tree-header">Dependency Tree</div>' +
      '<div class="dep-tree-empty">' +
        (isInfra
          ? 'Standalone — no upstream or downstream switches / access points discovered.'
          : 'No upstream device identified — no last-seen switch, access point or FortiGate resolves to a monitored device, so dependency suppression can\'t apply to this asset.') +
      '</div>' +
      '</div>';
  }

  // Rule 91: which hostnames appear on more than one node of THIS tree. Every
  // such node gets its serial (or address) beside the name — a tree reading
  // "IDF-1 → IDF-1" is otherwise unreadable, and the operator opening one of
  // them has to know which site they are about to pivot to.
  var nameCounts = {};
  function countName(n) {
    if (!n || !n.hostname) return;
    var k = String(n.hostname).toLowerCase();
    nameCounts[k] = (nameCounts[k] || 0) + 1;
  }
  parents.forEach(function (p) { countName(p.parent); });
  countName(self);
  countName(haPeer);
  children.forEach(function (c) {
    countName(c);
    (Array.isArray(c.grandchildren) ? c.grandchildren : []).forEach(countName);
  });
  function disambigOpts(n) {
    if (!n || !n.hostname || (nameCounts[String(n.hostname).toLowerCase()] || 0) < 2) return {};
    if (n.serialNumber) return { disambig: n.serialNumber, disambigKind: "serial" };
    if (n.ipAddress) return { disambig: n.ipAddress, disambigKind: "ip" };
    return {};
  }
  function withDisambig(opts, n) {
    var d = disambigOpts(n);
    if (d.disambig) { opts.disambig = d.disambig; opts.disambigKind = d.disambigKind; }
    return opts;
  }

  var subtitle;
  if (parents.length === 0) subtitle = "Level 1 — root of the dependency tree";
  else if (parents.length === 1) {
    var p0 = parents[0].parent;
    var p0d = disambigOpts(p0);
    subtitle = "Level " + (self.dependencyLayer != null ? self.dependencyLayer : "?") + " · directly under " + escapeHtml(p0.hostname || p0.id) +
      (p0d.disambig ? " (" + escapeHtml(p0d.disambig) + ")" : "");
  } else {
    subtitle = "Level " + (self.dependencyLayer != null ? self.dependencyLayer : "?") + " · " + parents.length + " parents";
  }

  var parentsHTML = "";
  if (parents.length > 0) {
    parentsHTML = parents.map(function (p) { return _depTreeNodeRow({
      id: p.parent.id, hostname: p.parent.hostname, assetType: p.parent.assetType,
      serialNumber: p.parent.serialNumber, ipAddress: p.parent.ipAddress,
      dependencyLayer: p.parent.dependencyLayer, monitorStatus: p.parent.monitorStatus,
      monitored: p.parent.monitored, dependencySuppressed: false /* we don't have it on parent */, source: p.source,
      dependencyTestUntil: p.parent.dependencyTestUntil, activeAlert: p.parent.activeAlert,
    }, withDisambig({ via: p.detectedVia }, p.parent)); }).join("");
    parentsHTML += '<div class="dep-tree-connector">│</div>';
  }
  var selfHTML = _depTreeNodeRow({
    id: self.id, hostname: self.hostname, assetType: self.assetType,
    serialNumber: self.serialNumber, ipAddress: self.ipAddress,
    dependencyLayer: self.dependencyLayer, monitorStatus: self.monitorStatus,
    monitored: self.monitored !== false, dependencySuppressed: !!self.dependencySuppressed,
    dependencyTestUntil: self.dependencyTestUntil, activeAlert: self.activeAlert,
  }, withDisambig({ self: true }, self));

  // HA peer row — rendered directly under the self row at the same level
  // (no connector: it's a redundant sibling, not a parent or child). The
  // pip reflects the peer's own state (a standby is typically unmonitored;
  // its roster-driven health lives on its General tab).
  var haPeerHTML = "";
  if (haPeer) {
    var peerTag = haPeer.haRole === "secondary" ? "HA standby"
                : haPeer.haRole === "primary"   ? "HA primary (active)"
                : "HA peer";
    haPeerHTML = _depTreeNodeRow({
      id: haPeer.id, hostname: haPeer.hostname, assetType: haPeer.assetType,
      serialNumber: haPeer.serialNumber, ipAddress: haPeer.ipAddress,
      dependencyLayer: haPeer.dependencyLayer, monitorStatus: haPeer.monitorStatus,
      monitored: haPeer.monitored, activeAlert: haPeer.activeAlert,
    }, withDisambig({ tag: peerTag, tagTitle: "HA cluster peer of " + (self.hostname || "this firewall") + " — redundant sibling, not a dependency" }, haPeer));
  }

  var childrenHTML = "";
  if (children.length > 0) {
    childrenHTML += '<div class="dep-tree-connector">│</div>';
    childrenHTML += children.map(function (c) {
      // Both downward layers are infra-only (see GET /:id/dependencies), so a
      // "+N" here means switches/APs the grandchild cap left out — never the
      // workstations and printers that hang off this switch.
      var gcs = Array.isArray(c.grandchildren) ? c.grandchildren : [];
      var more = (typeof c.childCount === "number") ? Math.max(0, c.childCount - gcs.length) : 0;
      var row = _depTreeNodeRow(c, withDisambig({ depth: 1, via: c.detectedVia, moreCount: more }, c));
      if (gcs.length === 0) return row;
      var gcRows = gcs.map(function (gc) { return _depTreeNodeRow(gc, withDisambig({ depth: 2, via: gc.detectedVia }, gc)); }).join("");
      return row + gcRows;
    }).join("");
    if (payload.childrenTruncated) {
      var shown = children.length;
      var total = (typeof payload.childCount === "number") ? payload.childCount : 0;
      childrenHTML += '<div class="dep-tree-empty" style="margin-top:0.35rem">Showing ' + shown +
        ' of ' + (total > shown ? total : shown) + ' downstream switches / access points.</div>';
    }
  }

  var overrideTag = payload.hasOverride
    ? '<span class="dep-tree-override-tag" title="Operator override is in effect">override active</span>'
    : "";
  // Admin-only "Dependency Test" — when active on the self node, render an
  // explanatory banner above the tree so it's obvious why every child is
  // showing up as Dep. Suppressed and so admins can see the auto-clear time.
  var depTestBanner = "";
  var selfDepTest = self.dependencyTestUntil ? new Date(self.dependencyTestUntil) : null;
  if (selfDepTest && selfDepTest.getTime() > Date.now()) {
    var startedBy = self.dependencyTestStartedBy ? " by " + escapeHtml(self.dependencyTestStartedBy) : "";
    depTestBanner = '<div class="dep-tree-test-banner">' +
      '<strong>Dependency Test active</strong>' + startedBy + ' — children are suppressed as if this device were down. Auto-clears ' + escapeHtml(formatDateTime(selfDepTest)) + '.' +
      '</div>';
  }

  return '<div class="dep-tree-block">' +
    '<div class="dep-tree-header">Dependency Tree ' + overrideTag + '</div>' +
    '<div class="dep-tree-subtitle">' + escapeHtml(subtitle) + '</div>' +
    depTestBanner +
    '<div class="dep-tree-body">' +
      parentsHTML +
      selfHTML +
      haPeerHTML +
      childrenHTML +
    '</div>' +
    '</div>';
}

// Wire clicks on .dep-tree-link buttons inside the body element. Each button
// carries data-asset-id; clicking pivots the open modal to that asset. Closes
// the current view in place (openViewModal swaps the body) so the user can
// keep walking up/down the tree.
function _wireDependencyTreeLinks(rootEl) {
  if (!rootEl) return;
  var btns = rootEl.querySelectorAll("[data-asset-id].dep-tree-link");
  for (var i = 0; i < btns.length; i++) {
    btns[i].addEventListener("click", function (e) {
      e.preventDefault();
      var id = e.currentTarget.getAttribute("data-asset-id");
      if (id) openViewModal(id);
    });
  }
}

// Shared markup for the per-firewall DHCP sighting table. Used by the Sources
// tab (general-visibility "found by N firewalls" history) and the Quarantine
// tab's fan-out section.
//
// The FortiGate and VLAN cells are row-menu triggers: a click opens what they
// name (the gate's asset, the network), a right click shows the menu (the
// gate's Open HTTPS / Open SSH too). The server resolves each gate name to
// its asset (`fortigateAsset`) and each address to its network (`subnetId`);
// an unresolved one stays plain text. A row whose gate resolved carries the
// row-menu-row marker, so a double click / right click anywhere on it is
// the gate's. The IP is click-to-copy (the slide-over body's copy handler).
var _sightingMenuRows = {};
var _sightingMenuSeq = 0;

function _sightingsTableHTML(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<p class="empty-state" style="margin:0">No firewall sightings recorded.</p>';
  }
  return '<table class="data-table" style="font-size:0.82rem"><thead><tr><th>FortiGate</th><th>IP Address</th><th>VLAN</th><th>Source</th><th>Last Seen</th></tr></thead><tbody>' +
    rows.map(function (s) {
      var key = "s" + (++_sightingMenuSeq);
      _sightingMenuRows[key] = s;
      var gateName = s.fortigateDevice || "?";
      var gateRef = s.fortigateAsset && s.fortigateAsset.id ? s.fortigateAsset : null;
      var gateCell = gateRef
        ? '<button type="button" class="row-menu-trigger" aria-haspopup="menu" data-sighting-gate="' + key + '" title="Open this FortiGate. Right-click for more">' + escapeHtml(gateName) + '</button>'
        : '<span title="No firewall in inventory matches this FortiGate name">' + escapeHtml(gateName) + '</span>';
      var vlanCell = "—";
      if (s.subnetName || s.vlan != null) {
        var parts = [];
        if (s.subnetName) parts.push(escapeHtml(s.subnetName));
        if (s.vlan != null) parts.push("VLAN " + escapeHtml(String(s.vlan)));
        vlanCell = parts.join(" · ");
        if (s.subnetId && _canOpenSightingNetwork()) {
          vlanCell = '<button type="button" class="row-menu-trigger" aria-haspopup="menu" data-sighting-net="' + key + '" title="Open this network. Right-click for more">' + vlanCell + '</button>';
        }
      }
      var ipCell = s.ipAddress
        ? '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(s.ipAddress) + '">' + escapeHtml(s.ipAddress) + '</span>'
        : "—";
      return (gateRef ? '<tr data-row-menu-row>' : '<tr>') +
        '<td>' + gateCell + '</td>' +
        '<td>' + ipCell + '</td>' +
        '<td>' + vlanCell + '</td>' +
        '<td><span class="badge badge-type">' + escapeHtml(s.source || "?") + '</span></td>' +
        '<td>' + (s.lastSeen ? formatDate(s.lastSeen) : "—") + '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table>';
}

// Opening a network panel reads the network list (subnets:read); without it
// the VLAN stays plain text rather than offering a panel that 403s.
function _canOpenSightingNetwork() {
  return typeof permAtLeast === "function" && permAtLeast("subnets", "read") &&
    typeof PolarisPanels !== "undefined" && typeof PolarisPanels.openNetwork === "function";
}

function _sightingGateMenuItems(s) {
  var items = _upstreamMenuItems(s.fortigateAsset);
  if (!items.length) return items;
  items.push({ separator: true });
  items.push({
    label: "Copy name",
    onSelect: function () { copyTextToClipboard(s.fortigateDevice || ""); },
  });
  return items;
}

function _sightingNetworkMenuItems(s) {
  var label = s.subnetName || (s.vlan != null ? "VLAN " + s.vlan : "network");
  return [
    {
      label: "Open network",
      primary: true,
      title: "Open " + label + " in its network panel" + (s.ipAddress ? ", at " + s.ipAddress : ""),
      // The network was matched BY this IP (it holds it), so the panel can
      // scroll to and highlight that row. subnetCidr saves the panel a fetch
      // to find the right page; openNetwork looks it up when it is absent.
      onSelect: function () {
        PolarisPanels.openNetwork(s.subnetId, s.ipAddress
          ? { focusIp: s.ipAddress, subnetCidr: s.subnetCidr || undefined }
          : undefined);
      },
    },
    { separator: true },
    {
      label: "Copy name",
      onSelect: function () { copyTextToClipboard(label); },
    },
  ];
}

// One document listener for every rendered sightings table (Sources tab,
// Quarantine tab). Guarded so a second evaluation of this file can't stack it.
if (typeof document !== "undefined" && document.addEventListener && typeof window !== "undefined" && !window.__polarisSightingMenus) {
  window.__polarisSightingMenus = true;
  document.addEventListener("click", function (e) {
    var t = e.target;
    var btn = t && typeof t.closest === "function" ? t.closest("[data-sighting-gate], [data-sighting-net]") : null;
    if (!btn) return;
    var gateKey = btn.getAttribute("data-sighting-gate");
    var s = _sightingMenuRows[gateKey || btn.getAttribute("data-sighting-net")];
    if (!s) return;
    e.preventDefault();
    if (gateKey) {
      showRowMenu(btn, _sightingGateMenuItems(s), { label: "Actions for " + (s.fortigateDevice || "FortiGate") });
    } else {
      showRowMenu(btn, _sightingNetworkMenuItems(s), { label: "Actions for " + (s.subnetName || "network") });
    }
  });
}

// Shared markup for the IP-history table (IPs this asset has held over time).
function _ipHistoryTableHTML(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return '<p class="empty-state" style="margin:0">No IP history recorded for this asset.</p>';
  }
  // VLAN of the network the address sits in (server-resolved per row); the
  // network's name rides the tooltip.
  return '<table class="data-table" style="font-size:0.82rem"><thead><tr><th>IP Address</th><th>VLAN</th><th>First Seen</th><th>Last Seen</th></tr></thead><tbody>' +
    rows.map(function (h) {
      var net = h.network || null;
      var vlanTitle = net ? ' title="' + escapeHtml((net.name || "") + (net.cidr ? " " + net.cidr : "")) + '"' : '';
      return '<tr>' +
        '<td>' + (h.ip ? '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(h.ip) + '">' + escapeHtml(h.ip) + '</span>' : "-") + '</td>' +
        '<td' + vlanTitle + '>' + (h.vlan != null ? escapeHtml(String(h.vlan)) : "-") + '</td>' +
        '<td>' + (h.firstSeen ? escapeHtml(formatDate(h.firstSeen)) : "-") + '</td>' +
        '<td>' + (h.lastSeen ? escapeHtml(formatDate(h.lastSeen)) : "-") + '</td>' +
      '</tr>';
    }).join("") +
    '</tbody></table>';
}

// ─── Split a MAC off onto its own asset (business rule 91(j)) ────────────────
// The Sources tab lists every MAC on the asset with the address it last held,
// the gate that saw it and when. A MAC seen by a lease or a gate's client list
// can be split onto a new asset — the recovery for devices fused before rule
// 91(f). The primary MAC stays, and a MAC the device reports as its own (an
// interface port, an agent / Intune / vCenter NIC, a range) is never another
// device. Click a row to select it, click the MAC to copy, right-click for the
// menu; the bulk bar splits every selected MAC at once.
var _MAC_SPLIT_OWN_SOURCES = { "monitor-interface": 1, "polaris-agent": 1, "intune-ethernet": 1, "intune-wifi": 1, "vcenter-vnic": 1 };
var _MAC_SPLIT_VISIBLE = 6;
var _macSplitState = {}; // assetId → { asset, sources, ipHistory, selected: {mac:1}, expanded }

function _macSplitRefusal(asset, m) {
  if (m.macEnd) return "A MAC range is the device's own ports";
  if (asset.macAddress && String(m.mac).toUpperCase() === String(asset.macAddress).toUpperCase()) return "The primary MAC stays: split the others off";
  if (_MAC_SPLIT_OWN_SOURCES[m.source]) return "The device reports this MAC as its own";
  return null;
}

function _macSplitCanAct(asset) {
  return typeof canEditAsset === "function" && canEditAsset(asset) &&
    asset.status !== "decommissioned" && !asset.quarantinedAt;
}

// "iPhone" for "iPhone-F2BC27" (rule 91(i) suffix), else the name itself.
function _macSplitBase(hostname) {
  var m = /^(.+)-([0-9a-f]{6}|[0-9a-f]{12})$/i.exec(hostname || "");
  return m ? m[1] : (hostname || "");
}

function _macSplitSuffix(mac) {
  return String(mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase().slice(-6);
}

function _macSplitAddrsByMac(asset) {
  var by = {};
  (asset.associatedIps || []).forEach(function (r) {
    if (!r.mac) return;
    var k = String(r.mac).toUpperCase();
    (by[k] = by[k] || []).push(r);
  });
  Object.keys(by).forEach(function (k) {
    by[k].sort(function (a, b) { return String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")); });
  });
  return by;
}

function _assetMacSplitSectionHTML(asset, sources, ipHistory) {
  var macs = Array.isArray(asset && asset.macAddresses) ? asset.macAddresses : [];
  if (macs.length < 2) return "";
  var st = _macSplitState[asset.id] || { selected: {}, expanded: false };
  st.asset = asset; st.sources = sources || []; st.ipHistory = ipHistory || [];
  _macSplitState[asset.id] = st;
  return '<div id="asset-mac-split-' + escapeHtml(asset.id) + '" data-shot-section="macSplit" data-shot-label="MAC addresses">' +
    _assetMacSplitInnerHTML(asset.id) + '</div>';
}

function _assetMacSplitInnerHTML(assetId) {
  var st = _macSplitState[assetId];
  var asset = st.asset;
  var canAct = _macSplitCanAct(asset);
  var primary = asset.macAddress ? String(asset.macAddress).toUpperCase() : "";
  var byMac = _macSplitAddrsByMac(asset);
  var macs = asset.macAddresses.slice().sort(function (a, b) {
    var ap = String(a.mac).toUpperCase() === primary, bp = String(b.mac).toUpperCase() === primary;
    if (ap !== bp) return ap ? -1 : 1;
    return String(b.lastSeen || "").localeCompare(String(a.lastSeen || ""));
  });
  var shown = st.expanded ? macs : macs.slice(0, _MAC_SPLIT_VISIBLE);
  var selCount = Object.keys(st.selected).length;

  var rows = shown.map(function (m) {
    var mac = String(m.mac).toUpperCase();
    var why = _macSplitRefusal(asset, m);
    var addrs = byMac[mac] || [];
    var last = addrs[0] || null;
    var first = addrs.reduce(function (acc, r) { return r.firstSeen && (!acc || r.firstSeen < acc) ? r.firstSeen : acc; }, null);
    var badges = "";
    if (mac === primary) badges += ' <span class="badge badge-active" title="The MAC this asset is known by">Primary</span>';
    else if (why && (m.macEnd || _MAC_SPLIT_OWN_SOURCES[m.source])) badges += ' <span class="badge badge-readonly" title="' + escapeHtml(why) + '">Own port</span>';
    var ipCell = last
      ? '<span class="mono copy-cell" title="Click to copy" data-copy="' + escapeHtml(last.ip) + '" onclick="event.stopPropagation()">' + escapeHtml(last.ip) + '</span>' +
        (typeof _addressNetworkChipHTML === "function" ? _addressNetworkChipHTML(last.network) : "")
      : '<span class="hint">no address</span>';
    var seenBy = [];
    var gate = (last && last.device) || m.device;
    if (gate) seenBy.push(escapeHtml(gate));
    if (last && last.medium) seenBy.push(escapeHtml(last.medium));
    if (!seenBy.length && m.source) seenBy.push(escapeHtml(formatMacSource(m.source)));
    var action = why
      ? '<span class="hint" title="' + escapeHtml(why) + '">' + (mac === primary ? "Stays" : "—") + '</span>'
      : (canAct ? '<button type="button" class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); openMacSplitConfirm(' + jsArg(assetId) + ', [' + jsArg(mac) + '])">Split</button>' : '');
    var selectable = canAct && !why;
    return '<tr data-mac="' + escapeHtml(mac) + '"' + (st.selected[mac] ? ' class="selected"' : '') +
      (selectable ? ' onclick="_macSplitToggle(' + jsArg(assetId) + ', ' + jsArg(mac) + ')"' : '') +
      ' oncontextmenu="_macSplitRowMenu(event, ' + jsArg(assetId) + ', ' + jsArg(mac) + ')">' +
      '<td class="mono"><span class="copy-cell" title="Click to copy" data-copy="' + escapeHtml(mac) + '" onclick="event.stopPropagation()">' + escapeHtml(mac) + '</span>' + badges + '</td>' +
      '<td>' + ipCell + '</td>' +
      '<td>' + (seenBy.join(' &middot; ') || '—') + '</td>' +
      '<td>' + (first ? escapeHtml(formatDate(first)) : '—') + '</td>' +
      '<td>' + (m.lastSeen ? escapeHtml(formatDate(m.lastSeen)) : '—') + '</td>' +
      '<td class="actions">' + action + '</td>' +
    '</tr>';
  }).join("");
  if (!st.expanded && macs.length > _MAC_SPLIT_VISIBLE) {
    rows += '<tr><td colspan="6" class="empty-state" style="padding:0.5rem"><button type="button" class="btn btn-sm btn-secondary" onclick="_macSplitExpand(' + jsArg(assetId) + ')">Show ' + (macs.length - _MAC_SPLIT_VISIBLE) + ' more</button></td></tr>';
  }

  var bulk = canAct
    ? '<div class="bulk-bar' + (selCount ? '' : ' bulk-bar-idle') + '" style="margin-bottom:0.4rem">' +
        '<span class="bulk-bar-count">' + (selCount ? selCount + ' selected' : 'Click rows to select MACs to split') + '</span>' +
        (selCount
          ? '<button type="button" class="btn btn-sm btn-secondary" onclick="_macSplitSelected(' + jsArg(assetId) + ')">Split each into its own asset</button>' +
            '<button type="button" class="btn btn-sm btn-secondary" onclick="_macSplitClear(' + jsArg(assetId) + ')">Clear</button>'
          : '') +
      '</div>'
    : '';
  var base = _macSplitBase(asset.hostname) || "the device";
  return '<div class="section-block" style="margin-bottom:1rem">' +
    '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:0.6rem;margin-bottom:0.25rem">' +
      '<div class="section-label" style="margin:0">MAC addresses on this asset</div>' +
      '<span class="hint">' + macs.length + ' MACs' + (primary ? ' · 1 primary' : '') + '</span>' +
    '</div>' +
    '<p class="hint" style="margin:0 0 0.6rem">Each MAC was seen by a DHCP lease, a FortiGate&#39;s client list or the device itself. ' +
      'If some are different devices that share a name, split them: each gets its own asset named ' + escapeHtml(base) + '-&lt;last 3 octets&gt;.</p>' +
    bulk +
    '<div class="table-wrapper"><table><thead><tr><th>MAC</th><th>Last IP</th><th>Seen by</th><th>First seen</th><th>Last seen</th><th></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div>' +
  '</div>';
}

function _macSplitRerender(assetId) {
  var host = document.getElementById("asset-mac-split-" + assetId);
  if (host && _macSplitState[assetId]) host.innerHTML = _assetMacSplitInnerHTML(assetId);
}

function _macSplitToggle(assetId, mac) {
  var st = _macSplitState[assetId];
  if (!st) return;
  if (st.selected[mac]) delete st.selected[mac]; else st.selected[mac] = 1;
  _macSplitRerender(assetId);
}

function _macSplitClear(assetId) {
  var st = _macSplitState[assetId];
  if (!st) return;
  st.selected = {};
  _macSplitRerender(assetId);
}

function _macSplitExpand(assetId) {
  var st = _macSplitState[assetId];
  if (!st) return;
  st.expanded = true;
  _macSplitRerender(assetId);
}

function _macSplitSelected(assetId) {
  var st = _macSplitState[assetId];
  if (!st) return;
  openMacSplitConfirm(assetId, Object.keys(st.selected));
}

function _macSplitRowMenu(ev, assetId, mac) {
  ev.preventDefault();
  var st = _macSplitState[assetId];
  if (!st) return;
  var m = st.asset.macAddresses.find(function (x) { return String(x.mac).toUpperCase() === mac; });
  var why = m ? _macSplitRefusal(st.asset, m) : "Not on this asset";
  var items = [{ label: "Copy MAC", onSelect: function () { _macSplitCopy(mac); } }];
  if (_macSplitCanAct(st.asset)) {
    items.unshift({ label: "Split into its own asset", disabled: !!why, title: why || "", onSelect: function () { openMacSplitConfirm(assetId, [mac]); } });
  }
  showRowMenu(ev.currentTarget, items, { menuAt: { x: ev.clientX, y: ev.clientY } });
}

function _macSplitCopy(text) {
  try {
    navigator.clipboard.writeText(text).then(function () { showToast("Copied " + text); });
  } catch (e) { /* clipboard unavailable */ }
}

// The asset would be renamed only when its name is discovery's (rule 91(i)):
// no operator rename, and a FortiGate endpoint source with nothing better.
function _macSplitOriginalRenames(asset, sources) {
  if (asset.hostnameOverride || !asset.hostname) return false;
  if (_macSplitBase(asset.hostname) !== asset.hostname) return false;
  var kinds = (sources || []).map(function (s) { return s.sourceKind; }).filter(function (k) { return k !== "manual"; });
  return kinds.length > 0 && kinds.every(function (k) { return k === "fortigate-endpoint"; });
}

function openMacSplitConfirm(assetId, macs) {
  var st = _macSplitState[assetId];
  if (!st || !macs || !macs.length) return;
  var asset = st.asset;
  var byMac = _macSplitAddrsByMac(asset);
  var base = _macSplitBase(asset.hostname) || "";
  var kept = {};
  (asset.associatedIps || []).forEach(function (r) { if (!r.mac || macs.indexOf(String(r.mac).toUpperCase()) === -1) kept[r.ip] = 1; });
  var rows = macs.map(function (mac) {
    var ips = (byMac[mac] || []).map(function (r) { return r.ip; });
    var hist = (st.ipHistory || []).filter(function (h) { return ips.indexOf(h.ip) !== -1 && !kept[h.ip]; }).length;
    var takes = [];
    if (ips.length) takes.push(ips.slice(0, 2).map(escapeHtml).join(", ") + (ips.length > 2 ? " +" + (ips.length - 2) : ""));
    if (hist) takes.push(hist + " history row" + (hist === 1 ? "" : "s"));
    return '<tr><td class="mono">' + escapeHtml(mac) + '</td>' +
      '<td class="mono">' + escapeHtml(base ? base + "-" + _macSplitSuffix(mac) : "(no name)") + '</td>' +
      '<td>' + (takes.join(" · ") || '<span class="hint">the MAC only</span>') + '</td></tr>';
  }).join("");
  var renameHTML = _macSplitOriginalRenames(asset, st.sources) && asset.macAddress
    ? '<div class="form-group" style="margin:0"><label>This asset</label>' +
        '<div class="form-value"><span class="mono">' + escapeHtml(asset.hostname) + '</span> → <span class="mono">' + escapeHtml(asset.hostname + "-" + _macSplitSuffix(asset.macAddress)) + '</span></div>' +
        '<div class="hint">Renamed because its name came from a DHCP lease or a FortiGate&#39;s client list. A name you set yourself is never changed.</div></div>'
    : '<div class="form-group" style="margin:0"><label>This asset</label><div class="form-value"><span class="mono">' + escapeHtml(asset.hostname || asset.id) + '</span> keeps its name.</div></div>';
  var n = macs.length;
  var label = "Split " + n + " MAC" + (n === 1 ? "" : "s");
  var body =
    '<div style="display:flex;flex-direction:column;gap:0.9rem">' +
      '<p style="margin:0">Each MAC below becomes its own asset. What moves with it: the MAC, the addresses on it, their IP history and any DHCP reservation on it. Monitoring, credentials, tags and notes stay here.</p>' +
      '<div class="table-wrapper"><table><thead><tr><th>MAC</th><th>New asset</th><th>Takes</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      renameHTML +
      '<div class="hint">Discovery keeps each MAC on its new asset from now on. Merge asset puts them back together.</div>' +
    '</div>';
  var footer =
    '<button class="btn btn-secondary" id="mac-split-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="mac-split-go">' + label + '</button>';
  openModal(n === 1 ? "Split this MAC into its own asset?" : "Split " + n + " MACs into their own assets?", body, footer, { wide: true });
  document.getElementById("mac-split-cancel").onclick = closeModal;
  document.getElementById("mac-split-go").onclick = async function () {
    var btn = this;
    btn.disabled = true; btn.textContent = "Splitting…";
    try {
      var result = await api.assets.splitMacs(assetId, macs);
      closeModal();
      st.selected = {};
      var made = (result && result.created) || [];
      showToast(made.length === 1 ? "Split onto " + (made[0].hostname || "a new asset") : "Split onto " + made.length + " new assets");
      if (typeof loadAssets === "function") { try { await loadAssets(); } catch (e) { /* not on the Assets page */ } }
      openViewModal(assetId);
    } catch (err) {
      btn.disabled = false; btn.textContent = label;
      showToast(err.message || "Split failed", "error");
    }
  };
}

function _assetSourcesTabHTML(sources, assetId, sightings, ipHistory, discoveringIntegrationId, asset) {
  sources = Array.isArray(sources) ? sources : [];
  sightings = Array.isArray(sightings) ? sightings : [];
  ipHistory = Array.isArray(ipHistory) ? ipHistory : [];
  // Admin-only Merge action — absorb a duplicate asset into this one (the
  // inverse of the per-source Split below). Asset-level, so it's offered
  // regardless of source count (a manually-created single-source asset can
  // still be merged with a discovered duplicate).
  var mergeToolbar = canMergeAssets()
    ? '<div style="display:flex;justify-content:flex-end;margin-bottom:0.75rem">' +
        '<button class="btn btn-sm btn-secondary" onclick="openAssetMergeFromAssetsPage(' + jsArg(assetId) + ')" ' +
        'title="Merge a duplicate asset into this one (combines discovery sources; the inverse of Split)">Merge asset...</button>' +
      '</div>'
    : '';
  if (sources.length === 0 && sightings.length === 0 && ipHistory.length === 0) {
    return mergeToolbar + '<div class="empty-state" style="padding:1rem">No source rows on file for this asset. Phase-1 backfill runs at startup; check the Events log if you expected entries here.</div>';
  }
  // History sections appended below the per-source cards: which firewalls have
  // seen this asset, and which IPs it has held over time. Folded in here so
  // they're visible to anyone who can view the asset (the Quarantine tab's
  // sighting copy is assets-admin-only and serves the push fan-out workflow).
  var historyHTML =
    '<div data-shot-section="sightings" data-shot-label="Firewall Sightings">' +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">Firewall Sightings</div>' +
      _sightingsTableHTML(sightings) +
    '</div>' +
    '</div>' +
    '<div data-shot-section="ipHistory" data-shot-label="IP History">' +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">IP History</div>' +
      _ipHistoryTableHTML(ipHistory) +
    '</div>' +
    '</div>';

  // Split is admin-only and only meaningful when there's more than one
  // source on the asset (the backend rejects splitting the only source).
  // Manual sources can never be split (backend also rejects those).
  // Splitting creates a record and detaches a source: an edit, not a merge.
  var canSplit = canManageAssets() && sources.length > 1;
  var tlsPinsPlaced = false;
  var sourceCards = sources.map(function (s) {
    var label = _assetSourceLabels[s.sourceKind] || s.sourceKind;
    var badges = [];
    // Lifecycle verdict first — it's the thing operators scan the card for.
    var stateBadge = _assetSourceStateBadge(s.state);
    if (stateBadge) badges.push(stateBadge);
    if (s.inferred) {
      badges.push('<span class="badge badge-maintenance" title="Synthesized by phase-1 backfill from a legacy `ad-guid:` tag breadcrumb. The next real discovery from this source replaces the row with truth.">Inferred</span>');
    }
    if (s.integration) {
      badges.push('<span class="badge badge-active" title="' + escapeHtml(s.integration.type) + '">' + escapeHtml(s.integration.name) + '</span>');
    }
    var splitButton = "";
    if (canSplit && s.sourceKind !== "manual") {
      splitButton = '<button class="btn btn-sm btn-secondary" onclick="splitAssetSource(' + jsArg(assetId) + ', ' + jsArg(s.id) + ', ' + jsArg(label) + ')" title="Detach this source onto a new asset (recovery action for bad merges)">Split</button>';
    }
    var headerRight = (badges.length || splitButton)
      ? '<div style="display:flex;gap:0.4rem;flex-wrap:wrap;align-items:center">' + badges.join("") + splitButton + '</div>'
      : '';

    var meta = [];
    if (s.syncedAt) meta.push("Synced " + escapeHtml(formatDate(s.syncedAt)));
    if (s.firstSeen) meta.push("First seen " + escapeHtml(formatDate(s.firstSeen)));
    if (s.lastSeen)  meta.push("Last seen " + escapeHtml(formatDate(s.lastSeen)));
    if (s.externalId) meta.push("External ID <code class=\"mono\" style=\"font-size:0.78rem\">" + escapeHtml(s.externalId) + "</code>");

    var observed = (s.observed && typeof s.observed === "object") ? s.observed : {};
    var rows = Object.keys(observed)
      .filter(function (k) { return !_assetSourceHiddenObservedKeys[k]; })
      .map(function (k) {
        return '<tr>' +
          '<th style="text-align:left;padding:0.25rem 0.6rem 0.25rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top;word-break:break-word">' + escapeHtml(_humanizeSourceObservedKey(k)) + '</th>' +
          '<td style="padding:0.25rem 0;vertical-align:top;word-break:break-word">' + _formatSourceObservedValue(observed[k]) + '</td>' +
        '</tr>';
      }).join("");
    // table-layout:fixed + an explicit colgroup makes the label column the
    // same width on every card, so values align vertically across sources
    // even when the longest label in each source differs.
    var observedTable = rows
      ? '<table style="width:100%;font-size:0.85rem;border-collapse:collapse;table-layout:fixed">' +
          '<colgroup><col style="width:220px"><col></colgroup>' +
          rows +
        '</table>'
      : '<em style="color:var(--color-text-secondary)">No observed fields recorded.</em>';

    // Rule 113(e): the discovering FortiManager / FortiGate integration's
    // card shows the certificate pinned for each endpoint Polaris sends its
    // token to — FortiManager itself, and in proxy-bypass mode this gate too.
    // Filled after render by _loadAssetTlsPins (one request, off first paint).
    var isDiscovering = s.integration && discoveringIntegrationId && s.integration.id === discoveringIntegrationId &&
      (s.integration.type === "fortimanager" || s.integration.type === "fortigate");
    var tlsPinsHTML = isDiscovering && !tlsPinsPlaced
      ? '<div class="asset-tls-pins" data-asset-id="' + escapeHtml(assetId) + '" style="margin-top:0.6rem"><em style="color:var(--color-text-secondary);font-size:0.82rem">Loading pinned certificates…</em></div>'
      : '';
    if (tlsPinsHTML) tlsPinsPlaced = true;
    // Rule 123: the Polaris Agent card shows the SSH host key / WinRM TLS
    // certificate Polaris pinned for this host — or, while the asset is
    // decommissioned, the archive holding them. Filled by _loadAssetHostPins.
    var hostPinsHTML = s.sourceKind === "polaris-agent"
      ? '<div class="asset-host-pins" data-asset-id="' + escapeHtml(assetId) + '" style="margin-top:0.6rem"><em style="color:var(--color-text-secondary);font-size:0.82rem">Loading pinned server identities…</em></div>'
      : '';

    return (
      '<div class="section-block" style="margin-bottom:1rem">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.6rem;margin-bottom:0.25rem">' +
          '<div class="section-label" style="margin:0">' + escapeHtml(label) + '</div>' +
          headerRight +
        '</div>' +
        (meta.length ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' + meta.join(" · ") + '</div>' : '') +
        observedTable +
        tlsPinsHTML +
        hostPinsHTML +
      '</div>'
    );
  }).join("");
  return '<div data-shot-section="sources" data-shot-label="Discovery Sources">' +
    mergeToolbar + (asset ? _assetMacSplitSectionHTML(asset, sources, ipHistory) : '') + _assetSourceStateSummaryHTML(sources) + sourceCards +
  '</div>' + historyHTML;
}

// Fingerprints are stored as bare upper-case hex; show them the way FortiOS and
// openssl print them (colon-separated pairs) so they can be compared by eye.
function _formatCertFingerprint(fp) {
  var hex = String(fp || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return hex.replace(/(..)(?=.)/g, "$1:");
}

/**
 * Fill the Sources tab's pinned-certificate block (rule 113(e)/(f)): one row
 * per TLS endpoint the discovering integration dials with a token, its pinned
 * SHA-256, and — when the server now presents a different certificate — both
 * fingerprints and a Trust new certificate button for whoever may manage pins.
 */
function _loadAssetTlsPins(rootEl) {
  var slot = rootEl && rootEl.querySelector(".asset-tls-pins");
  if (!slot) return;
  var assetId = slot.getAttribute("data-asset-id");
  api.assets.tlsPins(assetId).then(function (r) {
    var eps = (r && r.endpoints) || [];
    if (!eps.length) { slot.innerHTML = ""; return; }
    var canTrust = typeof permAtLeast === "function" && permAtLeast("serverSettingsSystem", "write");
    var rows = eps.map(function (e) {
      var p = e.pin;
      var state, detail;
      if (!p) {
        state = '<span class="badge badge-maintenance" title="Polaris has not connected to this endpoint with SSL verification off since pinning began, or it verifies a CA chain instead">Not pinned</span>';
        detail = '<span style="color:var(--color-text-secondary)">—</span>';
      } else if (p.pendingFingerprint) {
        state = '<span class="badge badge-conflict" title="This server now presents a different certificate, so Polaris is not sending it the token">Certificate changed</span>';
        detail =
          '<div><span style="color:var(--color-text-secondary)">Pinned</span> <code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(_formatCertFingerprint(p.fingerprint)) + '</code></div>' +
          '<div><span style="color:var(--color-text-secondary)">Now presents</span> <code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(_formatCertFingerprint(p.pendingFingerprint)) + '</code>' +
            (p.pendingSubject ? ' <span style="color:var(--color-text-secondary)">(' + escapeHtml(p.pendingSubject) + ')</span>' : '') +
            (p.pendingSeenAt ? ' <span style="color:var(--color-text-secondary)">since ' + escapeHtml(formatDate(p.pendingSeenAt)) + '</span>' : '') + '</div>' +
          (canTrust ? '<div style="margin-top:0.35rem"><button class="btn btn-sm btn-secondary" data-tls-trust="' + escapeHtml(p.id) + '" data-tls-fp="' + escapeHtml(p.pendingFingerprint) + '" data-tls-host="' + escapeHtml(e.host + ":" + e.port) + '">Trust new certificate</button></div>' : '');
      } else {
        state = '<span class="badge badge-active">Pinned</span>';
        detail = '<code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(_formatCertFingerprint(p.fingerprint)) + '</code>' +
          (p.subject ? ' <span style="color:var(--color-text-secondary)">(' + escapeHtml(p.subject) + ')</span>' : '') +
          '<div style="color:var(--color-text-secondary);font-size:0.75rem">First seen ' + escapeHtml(formatDate(p.firstSeen)) + ' · last seen ' + escapeHtml(formatDate(p.lastSeen)) + '</div>';
      }
      return '<tr>' +
        '<th style="text-align:left;padding:0.3rem 0.6rem 0.3rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top">' + escapeHtml(e.label) +
          '<div class="mono" style="font-size:0.75rem;font-weight:400">' + escapeHtml(e.host + ":" + e.port) + '</div></th>' +
        '<td style="padding:0.3rem 0.6rem 0.3rem 0;vertical-align:top;white-space:nowrap">' + state + '</td>' +
        '<td style="padding:0.3rem 0;vertical-align:top">' + detail + '</td>' +
      '</tr>';
    }).join("");
    slot.innerHTML =
      '<div class="section-label" style="margin:0.25rem 0 0.25rem 0;font-size:0.8rem">TLS certificates (SHA-256)</div>' +
      '<table style="width:100%;font-size:0.82rem;border-collapse:collapse;table-layout:fixed"><colgroup><col style="width:220px"><col style="width:150px"><col></colgroup>' + rows + '</table>';
    Array.prototype.forEach.call(slot.querySelectorAll("[data-tls-trust]"), function (btn) {
      btn.addEventListener("click", function () {
        var hostPort = btn.getAttribute("data-tls-host");
        var fp = btn.getAttribute("data-tls-fp");
        var ok = window.confirm("Trust the new certificate of " + hostPort + "?\n\nSHA-256 " + _formatCertFingerprint(fp) +
          "\n\nCheck it against the device first (FortiOS: System → Certificates, or openssl s_client). From now on Polaris sends the token only to this certificate.");
        if (!ok) return;
        btn.disabled = true;
        api.serverSettings.tlsCertPinTrust(btn.getAttribute("data-tls-trust"), fp).then(function () {
          showToast("Trusted the new certificate of " + hostPort);
          _loadAssetTlsPins(rootEl);
        }).catch(function (err) {
          btn.disabled = false;
          showToast((err && err.message) || "Could not trust the certificate", "error");
        });
      });
    });
  }).catch(function () {
    slot.innerHTML = '<em style="color:var(--color-text-secondary);font-size:0.82rem">Pinned certificates unavailable.</em>';
  });
}

/**
 * Fill the Polaris Agent card's pinned-identity block (rule 123): the SSH host
 * key(s) and TLS certificate(s) Polaris pinned on this asset's addresses, or —
 * while the asset is decommissioned — the archive its agent holds, which is put
 * back when the asset is reactivated.
 */
function _loadAssetHostPins(rootEl) {
  var slot = rootEl && rootEl.querySelector(".asset-host-pins");
  if (!slot) return;
  api.assets.hostPins(slot.getAttribute("data-asset-id")).then(function (r) {
    var archived = r && r.archived;
    var pins = archived ? archived.pins : ((r && r.live) || []);
    var heading = '<div class="section-label" style="margin:0.25rem 0 0.25rem 0;font-size:0.8rem">Pinned SSH thumbprint &amp; TLS certificate</div>';
    var note = archived
      ? '<div style="font-size:0.78rem;color:var(--color-text-secondary);margin-bottom:0.3rem">' +
          '<span class="badge badge-maintenance">Archived on decommission</span> ' + escapeHtml(formatDateTime(archived.at)) +
          ' — removed from Pinned server identities so this address does not refuse another machine; reinstated when the asset is reactivated.</div>'
      : '';
    if (!pins.length) {
      slot.innerHTML = heading + note +
        '<em style="color:var(--color-text-secondary);font-size:0.82rem">' +
        (archived ? "Nothing was pinned for this host when it was decommissioned." : "Nothing pinned yet — Polaris pins a host key the first time it connects over SSH (or WinRM over HTTPS).") +
        '</em>';
      return;
    }
    var rows = pins.map(function (p) {
      var isSsh = p.kind === "ssh";
      var fp = isSsh ? p.fingerprint : _formatCertFingerprint(p.fingerprint);
      var extra = isSsh ? p.keyType : p.subject;
      return '<tr>' +
        '<th style="text-align:left;padding:0.3rem 0.6rem 0.3rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top">' +
          (isSsh ? "SSH host key" : "TLS certificate (SHA-256)") +
          '<div class="mono" style="font-size:0.75rem;font-weight:400">' + escapeHtml(p.host + ":" + p.port) + '</div></th>' +
        '<td style="padding:0.3rem 0.6rem 0.3rem 0;vertical-align:top;white-space:nowrap">' +
          (archived ? '<span class="badge badge-maintenance">Archived</span>' : '<span class="badge badge-active">Pinned</span>') + '</td>' +
        '<td style="padding:0.3rem 0;vertical-align:top"><code class="mono" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(fp) + '</code>' +
          (extra ? ' <span style="color:var(--color-text-secondary)">(' + escapeHtml(extra) + ')</span>' : '') +
          '<div style="color:var(--color-text-secondary);font-size:0.75rem">First seen ' + escapeHtml(formatDate(p.firstSeen)) + ' · last seen ' + escapeHtml(formatDate(p.lastSeen)) + '</div></td>' +
      '</tr>';
    }).join("");
    slot.innerHTML = heading + note +
      '<table style="width:100%;font-size:0.82rem;border-collapse:collapse;table-layout:fixed"><colgroup><col style="width:220px"><col style="width:150px"><col></colgroup>' + rows + '</table>';
  }).catch(function () {
    slot.innerHTML = '<em style="color:var(--color-text-secondary);font-size:0.82rem">Pinned server identities unavailable.</em>';
  });
}

// ─── Quarantine tab ─────────────────────────────────────────────────────────

function _assetQuarantineTabHTML(a) {
  var isQ = a.status === "quarantined";
  var macs = [];
  if (Array.isArray(a.macAddresses)) {
    // Range entries render as "start – end" — the quarantine push expands
    // them server-side, so the label just needs to convey coverage.
    macs = a.macAddresses.map(function (m) { return typeof m === "object" ? macEntryText(m) : m; }).filter(Boolean);
  } else if (a.macAddress) {
    macs = [a.macAddress];
  }

  var statusSection = '';
  if (isQ) {
    var targets = Array.isArray(a.quarantineTargets) ? a.quarantineTargets : [];
    var targetsHtml = targets.length
      ? '<table class="data-table" style="font-size:0.82rem;margin-top:0.5rem"><thead><tr><th>FortiGate</th><th>Status</th><th>Pushed MACs</th><th>Pushed At</th></tr></thead><tbody>' +
          targets.map(function (t) {
            var statusCls = t.status === "synced" ? "badge-active" : t.status === "drift" ? "badge-maintenance" : "badge-disabled";
            return '<tr>' +
              '<td>' + escapeHtml(t.fortigateDevice || "?") + '</td>' +
              '<td><span class="badge ' + statusCls + '">' + escapeHtml(t.status || "?") + '</span></td>' +
              '<td class="mono" style="font-size:0.78rem">' + escapeHtml((t.pushedMacs || []).join(", ") || "—") + '</td>' +
              '<td>' + (t.pushedAt ? formatDate(t.pushedAt) : "—") + '</td>' +
            '</tr>';
          }).join("") +
        '</tbody></table>'
      : '<p class="empty-state" style="margin:0.5rem 0 0">No push targets recorded.</p>';

    statusSection =
      '<div data-shot-section="qStatus" data-shot-label="Quarantine Status">' +
      '<div class="section-block" style="margin-bottom:1rem">' +
        '<div class="section-label" style="margin-bottom:0.25rem">Quarantine Status</div>' +
        (a.quarantineReason ? '<p style="margin:0 0 0.5rem;color:var(--color-text-secondary)">Reason: ' + escapeHtml(a.quarantineReason) + '</p>' : '') +
        (a.quarantinedAt ? '<p style="margin:0 0 0.5rem;font-size:0.82rem;color:var(--color-text-secondary)">Quarantined ' + formatDate(a.quarantinedAt) + (a.quarantinedBy ? ' by ' + escapeHtml(a.quarantinedBy) : '') + '</p>' : '') +
        '<div class="section-label" style="margin:0.75rem 0 0.25rem">FortiGate Push Targets</div>' +
        targetsHtml +
      '</div>' +
      '</div>';
  }

  var macsHtml = macs.length
    ? '<div class="mono" style="font-size:0.82rem">' + escapeHtml(macs.join(", ")) + '</div>'
    : '<em style="color:var(--color-text-secondary)">No MACs on record — quarantine push requires at least one MAC.</em>';

  var sightingsSection =
    '<div data-shot-section="qSightings" data-shot-label="DHCP Sightings">' +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">DHCP Sightings</div>' +
      '<div id="asset-sightings-container"><em style="color:var(--color-text-secondary)">Loading…</em></div>' +
    '</div>' +
    '</div>';

  var isInfra = a.assetType === "firewall" || a.assetType === "switch" || a.assetType === "access_point";
  var actionBtn = isQ
    ? '<button class="btn btn-secondary" id="btn-qtn-release">Release Quarantine</button>'
    : (macs.length && !isInfra ? '<button class="btn btn-danger" id="btn-qtn-quarantine">Quarantine This Asset</button>' : '');
  var verifyBtn = isQ ? '<button class="btn btn-secondary" id="btn-qtn-verify">Verify Push</button>' : '';

  return '<div style="padding:0.5rem 0">' +
    statusSection +
    '<div data-shot-section="qMacs" data-shot-label="Associated MACs">' +
    '<div class="section-block" style="margin-bottom:1rem">' +
      '<div class="section-label" style="margin-bottom:0.25rem">Associated MACs</div>' +
      macsHtml +
    '</div>' +
    '</div>' +
    sightingsSection +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' + actionBtn + verifyBtn + '</div>' +
  '</div>';
}

function _wireQuarantineTab(a) {
  var tabPanel = document.getElementById("asset-view-tab-quarantine");
  if (!tabPanel) return;

  // Load sightings async when the tab is visible.
  function _loadSightings() {
    var container = document.getElementById("asset-sightings-container");
    if (!container) return;
    api.assets.getSightings(a.id).then(function (data) {
      var rows = Array.isArray(data) ? data : (data.sightings || []);
      container.innerHTML = _sightingsTableHTML(rows);
    }).catch(function () {
      var container2 = document.getElementById("asset-sightings-container");
      if (container2) container2.innerHTML = '<p class="empty-state" style="color:var(--color-danger,#c0392b)">Failed to load sightings.</p>';
    });
  }

  // Load sightings immediately if the quarantine tab is active, otherwise on click.
  var tabBtn = document.querySelector('#asset-view-tabs [data-tab="quarantine"]');
  if (tabBtn) {
    if (tabBtn.classList.contains("active")) {
      _loadSightings();
    } else {
      tabBtn.addEventListener("click", function handler() {
        tabBtn.removeEventListener("click", handler);
        _loadSightings();
      });
    }
  }

  var quarantineBtn = tabPanel.querySelector("#btn-qtn-quarantine");
  if (quarantineBtn) {
    quarantineBtn.addEventListener("click", async function () {
      var reason = await _promptQuarantineReason(1);
      if (reason === null) return;
      quarantineBtn.disabled = true;
      try {
        var result = await api.assets.quarantine(a.id, reason || undefined);
        showToast(result.message || "Asset quarantined");
        closeAssetPanel();
        loadAssets();
      } catch (err) {
        showToast(err.message || "Quarantine failed", "error");
        quarantineBtn.disabled = false;
      }
    });
  }

  var releaseBtn = tabPanel.querySelector("#btn-qtn-release");
  if (releaseBtn) {
    releaseBtn.addEventListener("click", async function () {
      var ok = await showConfirm("Release quarantine on this asset?");
      if (!ok) return;
      releaseBtn.disabled = true;
      try {
        var result = await api.assets.unquarantine(a.id);
        showToast(result.message || "Quarantine released");
        closeAssetPanel();
        loadAssets();
      } catch (err) {
        showToast(err.message || "Release failed", "error");
        releaseBtn.disabled = false;
      }
    });
  }

  var verifyBtn = tabPanel.querySelector("#btn-qtn-verify");
  if (verifyBtn) {
    verifyBtn.addEventListener("click", async function () {
      verifyBtn.disabled = true;
      verifyBtn.textContent = "Verifying…";
      try {
        var result = await api.assets.verifyQuarantine(a.id);
        if (result.driftDetected) {
          showToast("Drift detected — one or more targets were out of sync. Updated.", "warning");
        } else {
          showToast("All quarantine targets verified OK", "success");
        }
        openViewModal(a.id);
      } catch (err) {
        showToast(err.message || "Verify failed", "error");
      } finally {
        verifyBtn.disabled = false;
        verifyBtn.textContent = "Verify Push";
      }
    });
  }
}
