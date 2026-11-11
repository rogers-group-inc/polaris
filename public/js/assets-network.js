/**
 * public/js/assets-network.js — the network tabs: SD-WAN (Performance SLA + members), the MAC table,
 * a FortiGate's managed-children Wireless / MAC tables, the ARP table, the
 * IPsec tab, and the Paths tab (path checks, traceroute graph).
 *
 * Part of the Assets page script (CQ-F050): plain browser scripts sharing
 * page globals, loaded right after assets.js on every page that carries it
 * and in app-panels.js's asset bundle, in ASSETS_FILES order. Nothing here
 * runs at load beyond listener wiring. See tests/unit/assetsSplit.test.ts.
 */

// ─── SD-WAN tab (FortiOS Performance SLA + service rules) ───────────────────
//
// Rendered as a conditional asset-modal tab (not a slide-over) when a FortiGate
// firewall reports SD-WAN data. Two sections: a service-rules table (current
// selected member per rule + click-through to a member-selection timeline) and
// a Performance SLA section (per health-check/member latency / jitter / packet-
// loss charts over time). Data comes from the perf-SLA + sdwan-rule sample
// streams via the asset history endpoints.

function _sdwanMemberColor(name, members) {
  return PolarisAssetShared.sdwanMemberColor(name, members);
}

// Compact "Health Check Status" strip — one segment per recent scrape.
//
// A segment is judged server-side (readSdwanMembers → sdwanSegmentVerdict):
//   red    — dead in some health check, or alive but over that health check's
//            own SLA target (`outOfSla`): the FortiGate's verdict wins outright;
//   severity colour — alive and in SLA, but an SD-WAN automation's severity
//            tier would fire on the reading (`severity`), in the flat per-
//            severity palette (PolarisChartSeverity.downColorOf) that holds on
//            every theme;
//   green  — alive, in SLA, and no automation tier crossed.
//
// The strip is pure color: its segments carry no text at all. The table
// screenshot rasterizes the live DOM, so the strip reaches the image as it
// looks here — but its FALLBACK composer (_screenshotTableElText) re-draws cell
// TEXT, and there the column came out blank. data-shot-text/-color hand that
// path the summary the segments add up to instead.
function _sdwanStripSegment(r) {
  var UP = "#2ecc40", DOWN = "#e02020";
  if (!r.up) return { color: DOWN, label: "down" };
  if (r.outOfSla) return { color: DOWN, label: "out of SLA" };
  if (r.severity) {
    var cs = window.PolarisChartSeverity;
    return { color: cs && cs.downColorOf ? cs.downColorOf(r.severity) : DOWN, label: "up — " + r.severity + " by automation" };
  }
  return { color: UP, label: "up" };
}
function _sdwanStatusStripHTML(recent) {
  if (!recent || !recent.length) return '<span style="color:var(--color-text-tertiary)">—</span>';
  // `up` counts alive, in-SLA scrapes — a severity-shaded one is still up, and
  // the summary names the worst severity beside the count instead.
  var up = 0;
  var worst = null;
  var order = (window.PolarisChartSeverity && window.PolarisChartSeverity.SEV_ORDER) || [];
  var segs = recent.map(function (r) {
    var seg = _sdwanStripSegment(r);
    if (r.up && !r.outOfSla) {
      up++;
      if (r.severity && (worst === null || order.indexOf(r.severity) > order.indexOf(worst))) worst = r.severity;
    }
    return '<span title="' + escapeHtml(_fmtTooltipTs(r.timestamp) + ' — ' + seg.label) +
      '" style="flex:1 1 auto;min-width:2px;height:16px;background:' + seg.color + '"></span>';
  }).join("");
  var allUp = up === recent.length;
  var shotColor = !allUp ? MONITOR_STATE_COLORS.down
    : worst ? _sdwanStripSegment({ up: true, severity: worst }).color : MONITOR_STATE_COLORS.up;
  return '<span data-shot-text="' + (allUp ? '▲ ' : '▼ ') + up + '/' + recent.length + ' up' + (worst ? ' · ' + worst : '') + '"' +
    ' data-shot-color="' + shotColor + '"' +
    ' style="display:flex;gap:1px;align-items:stretch;min-width:120px;max-width:340px">' + segs + '</span>';
}

// The Link cell. An overlay member (linkSource "ipsec") reads its IPsec
// tunnel's status, never an interface carrier — a tunnel has none, and SNMP
// reported healthy overlays as down. `linkState` is absent on an older server;
// fall back to the boolean then.
function _sdwanMemberLinkHTML(m) {
  var state = m.linkState !== undefined ? m.linkState
    : (m.linkUp == null ? null : (m.linkUp ? "up" : "down"));
  var tunnel = m.linkSource === "ipsec";
  var title = tunnel ? ' title="IPsec tunnel status"' : '';
  if (state === "up") {
    var label = tunnel ? "tunnel up" : (m.linkSpeedBps ? _fmtBitsPerSec(m.linkSpeedBps) : "up");
    return '<span' + title + ' style="color:' + MONITOR_STATE_COLORS.up + '">▲ ' + escapeHtml(label) + '</span>';
  }
  if (state === "down") {
    return '<span' + title + ' style="color:' + MONITOR_STATE_COLORS.down + '">▼ ' + (tunnel ? "tunnel down" : "down") + '</span>';
  }
  if (state === "partial") {
    return '<span title="IPsec tunnel status — some phase-2 selectors are down" style="color:' + MONITOR_STATE_COLORS.warning + '">◆ partial</span>';
  }
  if (state === "dynamic") {
    return '<span title="Dial-up tunnel — no single up/down state" style="color:var(--color-text-secondary)">dial-up</span>';
  }
  return '<span style="color:var(--color-text-tertiary)">—</span>';
}

// SD-WAN Members table body — canonical applyTableLayout column template.
// Members are grouped by SD-WAN zone: a full-width zone header row, then that
// zone's members indented beneath it (dependency-tree style). When no member
// reports a zone the table renders flat with no headers (unchanged behavior).
function _sdwanMembersTableHTML(members) {
  function statusDot(up) {
    return '<span title="' + (up ? 'up' : 'down') + '" data-shot-text="' + (up ? '▲' : '▼') + '"' +
      ' data-shot-color="' + (up ? MONITOR_STATE_COLORS.up : MONITOR_STATE_COLORS.down) + '"' +
      ' style="display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px;background:' +
      (up ? MONITOR_STATE_COLORS.up : MONITOR_STATE_COLORS.down) + '"></span>';
  }
  // One member row. `indented` adds a faint tree connector + indent in the
  // Member cell when the row sits under a zone header. The connector lives in
  // the cell content (not td padding) so it survives applyTableLayout's
  // column resize/reorder.
  function memberRow(m, indented) {
    var hcChips = (m.healthChecks || []).map(function (h) {
      var c = h.state === "up" ? MONITOR_STATE_COLORS.up : MONITOR_STATE_COLORS.down;
      var lat = (typeof h.latencyMs === "number") ? (Math.round(h.latencyMs * 100) / 100) + "ms" : "—";
      return '<span title="' + escapeHtml(h.healthCheck) +
        ' · jitter ' + (typeof h.jitterMs === "number" ? (Math.round(h.jitterMs * 100) / 100) + "ms" : "—") +
        ' · loss ' + (typeof h.packetLoss === "number" ? h.packetLoss + "%" : "—") +
        '" class="badge hue-pill" style="--hue:var(--color-text-tertiary);margin:0 4px 2px 0;text-transform:none">' +
        '<span data-shot-text="' + (h.state === "up" ? '▲' : '▼') + '" style="color:' + c + '">●</span> ' +
        escapeHtml(h.healthCheck) + ' ' + lat + '</span>';
    }).join("") || '<span style="color:var(--color-text-tertiary)">—</span>';
    var link = _sdwanMemberLinkHTML(m);
    var bytes = (m.txBytes != null || m.rxBytes != null)
      ? (m.txBytes != null ? _fmtBytes(m.txBytes) : "—") + ' / ' + (m.rxBytes != null ? _fmtBytes(m.rxBytes) : "—")
      : '<span style="color:var(--color-text-tertiary)">—</span>';
    var indent = indented
      ? '<span style="display:inline-block;width:1.25rem;color:var(--color-text-tertiary)">└</span>'
      : '';
    return '<tr>' +
        '<td data-col-id="member" data-col-required="true">' + indent + statusDot(m.state === "up") + escapeHtml(m.link) + '</td>' +
        '<td data-col-id="ip">' + (m.ip ? escapeHtml(m.ip) : '<span style="color:var(--color-text-tertiary)">—</span>') + '</td>' +
        '<td data-col-id="hcstatus">' + _sdwanStatusStripHTML(m.recent) + '</td>' +
        '<td data-col-id="checks">' + hcChips + '</td>' +
        '<td data-col-id="bytes">' + bytes + '</td>' +
        '<td data-col-id="link">' + link + '</td>' +
      '</tr>';
  }
  // Full-width zone grouping header. No data-col-id cells, so applyTableLayout
  // (which keys off data-col-id cells) leaves it untouched.
  function zoneHeader(label) {
    return '<tr class="sdwan-zone-header"><td colspan="6" style="padding:5px 8px;font-weight:600;' +
      'background:var(--color-bg-primary);color:var(--color-text-secondary)">▸ ' + escapeHtml(label) + '</td></tr>';
  }
  var rows;
  if (!members.some(function (m) { return m.zone; })) {
    // No zones configured — flat table, unchanged.
    rows = members.map(function (m) { return memberRow(m, false); }).join("");
  } else {
    var groups = new Map(); // zone name | null → members[]
    members.forEach(function (m) {
      var z = m.zone || null;
      if (!groups.has(z)) groups.set(z, []);
      groups.get(z).push(m);
    });
    var parts = [];
    groups.forEach(function (list, z) {
      if (z === null) return; // null bucket emitted last
      parts.push(zoneHeader(z) + list.map(function (m) { return memberRow(m, true); }).join(""));
    });
    if (groups.has(null)) {
      parts.push(zoneHeader("No zone") + groups.get(null).map(function (m) { return memberRow(m, true); }).join(""));
    }
    rows = parts.join("");
  }
  return '<div class="table-wrapper"><table id="sdwan-members-table" class="data-table" style="font-size:0.82rem"><thead><tr>' +
      '<th data-col-id="member" data-col-required="true">Member</th>' +
      '<th data-col-id="ip">IP</th>' +
      '<th data-col-id="hcstatus">Health Check Status</th>' +
      '<th data-col-id="checks">Health Checks</th>' +
      '<th data-col-id="bytes">Bytes (Sent/Received)</th>' +
      '<th data-col-id="link" style="width:110px">Link</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// Provenance + freshness strip carried by all three SD-WAN sections.
//
// Every section on this tab is a SNAPSHOT of what the gate last answered, and
// each is a separate write on the SD-WAN pass (its own cadence, default 60s —
// not the system-info pass it rode until 2026-09): a rules scrape can land
// while the perf-SLA one fails, and vice versa. So each states its OWN stamp
// rather than the asset's lastSystemInfoAt — otherwise an empty members table
// reads "this gate has no WAN members" when it means "not answered since
// yesterday". `lastAt`/`cadenceSec` come from the endpoint that served the
// section (collectedAt / pollIntervalSec), so the number an operator reads is
// the number the amber threshold compares against.
//
// The badge is the full stream badge, not a bare cadence chip: SD-WAN is
// REST-only, and which transport and credential answered is the next question
// after "is this current". `_wireSdwanTab` upgrades it to authoritative
// provenance once /effective-monitor-settings lands.
//
// `extraHTML` sits between the heading and the badge (Performance SLA's
// health-check selector); `rightHTML` is pushed to the far end of the row (its
// range buttons). Both empty for the two tables, which then render as a plain
// left-aligned strip.
function _sdwanSectionHeaderHTML(a, title, lastAt, cadenceSec, neverText, extraHTML, rightHTML) {
  // Method + tier are the Interfaces stream's (SD-WAN runs only when it is on
  // FortiOS REST); the cadence is SD-WAN's own — the same figure the stamp
  // ambers against, so the badge and the stamp never disagree.
  var badge = _streamSourceBadgeHTML(a, "interfaces", { intervalSec: cadenceSec });
  return '<div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;flex-wrap:wrap;margin:0 0 0.5rem">' +
      '<div style="display:flex;align-items:baseline;gap:0.5rem;flex-wrap:wrap">' +
        '<h4 style="margin:0">' + escapeHtml(title) + '</h4>' +
        (extraHTML || "") +
        badge +
        _freshnessStampHTML(lastAt, cadenceSec, neverText) +
      '</div>' +
      (rightHTML ? '<div style="display:flex;gap:6px">' + rightHTML + '</div>' : '') +
    '</div>';
}

function _assetSdwanTabHTML(a, rules, links, members, meta) {
  rules = rules || [];
  links = links || [];
  members = members || [];
  meta = meta || {};
  var html = '<div style="padding:0.25rem 0">';

  // ── SD-WAN Members table (above the rules) ──
  if (members.length) {
    html +=
      '<div data-shot-section="sdwanMembers" data-shot-label="SD-WAN Members">' +
      '<section style="margin-bottom:1.25rem">' +
        _sdwanSectionHeaderHTML(a, "SD-WAN Members", meta.membersAt, meta.membersPollSec, "never collected") +
        '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-text-tertiary)">WAN members (interfaces + overlays) with per-health-check status. The Health Check Status strip shows up/down per scrape over the last 30 minutes; IP / link / bytes come from the latest interface poll.</p>' +
        _sdwanMembersTableHTML(members) +
      '</section>' +
      ((rules.length || links.length) ? '<hr style="margin:1.25rem 0;border:none;border-top:1px solid var(--color-border)">' : '') +
      '</div>';
  }

  // ── SD-WAN Rules table ── (canonical column-layout template: data-col-id on
  // every <th>, anchors marked data-col-required, applyTableLayout() wired in
  // _wireSdwanTab after the body lands in the DOM.)
  if (rules.length) {
    function _pillList(items, joinStr) {
      if (!items || !items.length) return '<span style="color:var(--color-text-tertiary)">—</span>';
      return items.map(function (m) { return escapeHtml(m); }).join(joinStr);
    }
    // member interface → SD-WAN zone, from the Members data this tab already
    // loaded. Lets a zone-preference rule group its candidate members by zone.
    var memberZoneByName = {};
    (members || []).forEach(function (mm) { if (mm && mm.link) memberZoneByName[mm.link] = mm.zone || null; });
    var ruleRows = rules.map(function (r) {
      var avail = Array.isArray(r.availableMembers) ? r.availableMembers : [];
      // One member pill (selected member highlighted). Color basis is the
      // rule's full candidate list so colors are stable across zone groups.
      function memberPill(m) {
        var sel = m === r.selectedMember;
        return '<span class="badge hue-pill' + (sel ? ' hue-strong' : '') + '" style="margin:0 4px 2px 0;text-transform:none;--hue:' +
          (sel ? _sdwanMemberColor(m, avail) : 'var(--color-text-tertiary)') +
          '">' + escapeHtml(m) + (sel ? ' ✓' : '') + '</span>';
      }
      var pills;
      var zones = Array.isArray(r.priorityZones) ? r.priorityZones : [];
      if (zones.length) {
        // Zone-preference rule: one indented group per preferred zone listing
        // that zone's candidate members, selected one highlighted.
        var used = {};
        function zoneLabel(z) {
          return '<span style="font-size:0.72rem;color:var(--color-text-tertiary);margin-right:4px">' + escapeHtml(z) + ':</span>';
        }
        var groupsHtml = zones.map(function (z) {
          var zMembers = avail.filter(function (m) { return memberZoneByName[m] === z; });
          zMembers.forEach(function (m) { used[m] = true; });
          var inner = zMembers.length
            ? zMembers.map(memberPill).join("")
            : '<span style="color:var(--color-text-tertiary);font-size:0.74rem">no members</span>';
          return '<div style="margin:0 0 2px 0">' + zoneLabel(z) + inner + '</div>';
        }).join("");
        var leftovers = avail.filter(function (m) { return !used[m]; });
        if (leftovers.length) {
          groupsHtml += '<div style="margin:0 0 2px 0">' + zoneLabel("other") + leftovers.map(memberPill).join("") + '</div>';
        }
        pills = groupsHtml;
      } else {
        pills = avail.length
          ? avail.map(memberPill).join("")
          : '<span style="color:var(--color-text-tertiary)">—</span>';
      }
      var enabledCell = r.enabled == null
        ? '<span style="color:var(--color-text-tertiary)">—</span>'
        : (r.enabled
            ? '<span style="color:' + MONITOR_STATE_COLORS.up + '">● Enabled</span>'
            : '<span style="color:var(--color-text-tertiary)">○ Disabled</span>');
      return '<tr>' +
          '<td data-col-id="id">' + (r.ruleId != null ? escapeHtml(String(r.ruleId)) : '—') + '</td>' +
          '<td data-col-id="name" style="font-weight:600">' + escapeHtml(r.ruleName) + '</td>' +
          '<td data-col-id="dst">' + _pillList(r.dst, ", ") + '</td>' +
          '<td data-col-id="members">' + pills + '</td>' +
          '<td data-col-id="criteria">' + (r.criteria ? escapeHtml(r.criteria) : '—') + '</td>' +
          '<td data-col-id="perfsla">' + _pillList(r.healthChecks, ", ") + '</td>' +
          '<td data-col-id="status">' + enabledCell + '</td>' +
        '</tr>';
    }).join("");
    html +=
      '<div data-shot-section="sdwanRules" data-shot-label="SD-WAN Rules">' +
      '<section style="margin-bottom:1.25rem">' +
        _sdwanSectionHeaderHTML(a, "SD-WAN Rules", meta.rulesAt, meta.rulesPollSec, "never collected") +
        '<p class="hint" style="margin:0 0 0.5rem 0;color:var(--color-text-tertiary)">Service rules in FortiGate priority order, with the currently selected member highlighted in <strong>Members</strong>. Zone-preference rules list each preferred zone\'s members grouped by zone. The active member is inferred from health-check state when FortiOS does not report the selected route directly.</p>' +
        '<div class="table-wrapper"><table id="sdwan-rules-table" class="data-table" style="font-size:0.82rem"><thead><tr>' +
          '<th data-col-id="id" style="width:48px">ID</th>' +
          '<th data-col-id="name" data-col-required="true">Name</th>' +
          '<th data-col-id="dst">Destination</th>' +
          '<th data-col-id="members" data-col-required="true">Members</th>' +
          '<th data-col-id="criteria">Criteria</th>' +
          '<th data-col-id="perfsla">Performance SLA</th>' +
          '<th data-col-id="status" style="width:100px">Status</th>' +
        '</tr></thead><tbody>' + ruleRows + '</tbody></table></div>' +
      '</section>' +
      '</div>';
  }

  // ── Performance SLA section ──
  if (links.length) {
    var rangeBtns = _chartRangeBtnsHTML("sdwan-range-btn", [
      { value: "1h",  label: "1h"  },
      { value: "12h", label: "12h" },
      { value: "24h", label: "24h" },
      { value: "7d",  label: "7d"  },
      { value: "30d", label: "30d" },
    ], "assetSdwan", "24h");
    // One option per health-check (members are overlaid on each chart).
    var hcOrder = [];
    links.forEach(function (l) { if (hcOrder.indexOf(l.healthCheck) < 0) hcOrder.push(l.healthCheck); });
    var options = hcOrder.map(function (hc) {
      var n = links.filter(function (l) { return l.healthCheck === hc; }).length;
      return '<option value="' + escapeHtml(hc) + '">' + escapeHtml(hc) + ' (' + n + ' member' + (n === 1 ? '' : 's') + ')</option>';
    }).join("");
    html += '<div data-shot-section="perfSla" data-shot-label="Performance SLA" data-shot-chart="assetSdwan">';
    if (rules.length) {
      html += '<hr style="margin:1.25rem 0;border:none;border-top:1px solid var(--color-border)">';
    }
    // Same header builder as the two tables above, so all three sections state
    // provenance and age the same way. The stamp is the perf-SLA stream's own
    // newest sample — the very `collectedAt` the members table states, both
    // reading that one table. No fallback: it used to fall back to the asset's
    // lastSystemInfoAt, but SD-WAN has its own pass since 2026-09, so that
    // stamp says nothing about SD-WAN — no sample means "never collected".
    // _wireSdwanTab upgrades the badge to authoritative provenance.
    html +=
      '<section>' +
        _sdwanSectionHeaderHTML(
          a, "Performance SLA",
          meta.membersAt || null, meta.membersPollSec, "never collected",
          '<select id="sdwan-perfsla-select" class="form-input" style="padding:2px 6px;font-size:0.82rem">' + options + '</select>',
          rangeBtns
        ) +
        // ONE legend for all three charts, above the stats line — hiding a
        // member hides it on latency, jitter and loss together.
        '<div id="sdwan-perfsla-legend"></div>' +
        '<div id="sdwan-perfsla-stats" style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:0.5rem">Loading…</div>' +
        '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Latency (ms)</h5>' +
        '<div id="sdwan-latency-chart" class="sdwan-chart-box"></div>' +
        '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Jitter (ms)</h5>' +
        '<div id="sdwan-jitter-chart" class="sdwan-chart-box"></div>' +
        '<h5 style="margin:0.75rem 0 0.25rem;font-size:0.85rem">Packet loss (%)</h5>' +
        '<div id="sdwan-loss-chart" class="sdwan-chart-box"></div>' +
      '</section>' +
      '</div>';
  }

  html += '</div>';
  return html;
}

// Holds the current SD-WAN tab selection state (link list + selected rule) so
// the shared range buttons can reload whichever sub-view is showing.
var _sdwanTabState = null;

function _wireSdwanTab(a, rules, links) {
  links = links || [];
  // Group health-check members so a single selection overlays every member of
  // a health-check on the charts.
  var linksByHc = {};
  var hcNames = [];
  links.forEach(function (l) {
    if (!linksByHc[l.healthCheck]) { linksByHc[l.healthCheck] = []; hcNames.push(l.healthCheck); }
    linksByHc[l.healthCheck].push(l);
  });
  _sdwanTabState = { assetId: a.id, links: links, linksByHc: linksByHc, hcNames: hcNames, hcName: hcNames[0] || null, rules: rules || [] };
  // Upgrade the Performance SLA provenance badge from the coarse sync guess to
  // the authoritative resolved polling method + tier (covers class overrides).
  _updateStreamSourceBadgesFromEffective(a.id, a);
  // Style chart boxes (same treatment as the IPsec panel).
  document.querySelectorAll(".sdwan-chart-box").forEach(function (el) {
    el.classList.add("chart-box");
    el.style.minHeight = "140px";
    el.style.display = "flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.color = "var(--color-text-secondary)";
    el.style.fontSize = "0.85rem";
  });

  var range = _getChartRangePref("assetSdwan", "24h");

  // Perf-SLA health-check selector + initial load (overlays all members).
  var sel = document.getElementById("sdwan-perfsla-select");
  if (sel && hcNames.length) {
    sel.addEventListener("change", function () {
      _sdwanTabState.hcName = sel.value;
      _loadPerfSlaForHealthCheck(a.id, sel.value, linksByHc[sel.value] || [], _getChartRangePref("assetSdwan", "24h"));
    });
    _loadPerfSlaForHealthCheck(a.id, hcNames[0], linksByHc[hcNames[0]] || [], range);
  }

  // Canonical column-layout template (resize + hover-gear chooser), persisted
  // by table-type so widths apply across every FortiGate's SD-WAN tab.
  if (typeof applyTableLayout === "function") {
    var membersTable = document.getElementById("sdwan-members-table");
    if (membersTable) applyTableLayout(membersTable, _assetTableTypeKey("asset-sdwan-members", a), {
      onScreenshot: function (t) { _screenshotTableEl(t, "SD-WAN Members"); },
    });
    var rulesTable = document.getElementById("sdwan-rules-table");
    if (rulesTable) applyTableLayout(rulesTable, _assetTableTypeKey("asset-sdwan-rules", a), {
      onScreenshot: function (t) { _screenshotTableEl(t, "SD-WAN Rules"); },
    });
  }

  // Shared range buttons — reload the Performance SLA charts (SD-WAN rules are
  // current-state, so they don't reload on range change).
  document.querySelectorAll(".sdwan-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      var r = b.getAttribute("data-range");
      document.querySelectorAll(".sdwan-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetSdwan", r);
      if (_sdwanTabState.hcName) _loadPerfSlaForHealthCheck(a.id, _sdwanTabState.hcName, _sdwanTabState.linksByHc[_sdwanTabState.hcName] || [], r);
    });
  });
  // Drag-select on any Performance SLA chart applies the selection as a
  // custom window across all three (no Custom… button on this bar — the
  // preset highlights just clear).
  ["sdwan-latency-chart", "sdwan-jitter-chart", "sdwan-loss-chart"].forEach(function (cid) {
    _wireChartDragSelect(document.getElementById(cid), function (fromIso, toIso) {
      _applyCustomRangeSelection({ btnClass: "sdwan-range-btn" }, fromIso, toIso);
      var st = _sdwanTabState;
      if (st && st.hcName) _loadPerfSlaForHealthCheck(a.id, st.hcName, st.linksByHc[st.hcName] || [], { from: fromIso, to: toIso });
    });
  });
}

// Load every member of a health-check in parallel and overlay them on the
// three metric charts (one colored line per member). `members` is the array of
// link objects (from /perf-sla-links) for this health-check; they share the
// same SLA thresholds.
async function _loadPerfSlaForHealthCheck(assetId, hcName, members, range) {
  var latEl  = document.getElementById("sdwan-latency-chart");
  var jitEl  = document.getElementById("sdwan-jitter-chart");
  var lossEl = document.getElementById("sdwan-loss-chart");
  var stats  = document.getElementById("sdwan-perfsla-stats");
  var legendEl = document.getElementById("sdwan-perfsla-legend");
  if (!latEl || !members || !members.length) return;
  latEl.textContent = jitEl.textContent = lossEl.textContent = "Loading samples…";
  if (legendEl) legendEl.innerHTML = "";
  if (stats) stats.textContent = "Loading…";
  var opts = (typeof range === "string" || !range) ? { range: range || "24h" } : range;
  // Stash the active selection on each chart container (canonical convention)
  // so screenshots carry a drag-selected custom window's From/To.
  [latEl, jitEl, lossEl].forEach(function (el) {
    if (!el) return;
    if (opts.from && opts.to) {
      el.dataset.from = opts.from;
      el.dataset.to = opts.to;
      delete el.dataset.range;
    } else {
      el.dataset.range = opts.range || "24h";
      delete el.dataset.from;
      delete el.dataset.to;
    }
  });
  var memberNames = members.map(function (m) { return m.link; });
  try {
    var results = await Promise.all(members.map(function (m) {
      return api.assets.perfSlaHistory(assetId, m.healthCheck, m.link, opts)
        .then(function (data) { return { link: m.link, data: data, samples: data.samples || [] }; })
        .catch(function () { return { link: m.link, data: null, samples: [] }; });
    }));
    var series = results.map(function (r) {
      return { label: r.link, color: _sdwanMemberColor(r.link, memberNames), samples: r.samples, data: r.data };
    });
    var first = results.find(function (r) { return r.data; }) || results[0];
    var copts = {
      since: first && first.data ? first.data.since : undefined, until: first && first.data ? first.data.until : undefined, subject: hcName,
      // Rollup tier → dashed bucket-peak lines on latency and jitter.
      maxTier: _chartRollupTier(first && first.data),
    };
    var thr = members[0] || {};
    // Stash render state so the clickable legend can re-render all three charts
    // on toggle. Reset per-member visibility whenever the health-check changes.
    _sdwanTabState.perfSla = { series: series, copts: copts, thr: thr, data: first && first.data };
    _sdwanTabState.hiddenMembers = new Set();
    _renderPerfSlaStats(stats, series, first && first.data, hcName);
    _renderAllPerfSlaCharts();
  } catch (err) {
    latEl.textContent = jitEl.textContent = lossEl.textContent = "Error: " + (err.message || "failed to load");
    if (stats) stats.textContent = "";
  }
}

function _renderPerfSlaStats(container, series, data, subject) {
  if (!container) return;
  var visible = series.map(function (s) { return _inChartWindow(s.samples, data && data.since); });
  var total = visible.reduce(function (n, v) { return n + v.length; }, 0);
  if (!total) { _renderChartStats(container, 0, []); return; }
  function avg(key) {
    var vals = [];
    visible.forEach(function (v) { v.forEach(function (x) { if (typeof x[key] === "number") vals.push(x[key]); }); });
    if (!vals.length) return null;
    return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
  }
  function fmt(v, unit) { return v == null ? null : (Math.round(v * 100) / 100) + " " + unit; }
  var parts = [
    { label: "Members", value: String(series.length) },
    { label: "Avg latency", value: fmt(avg("latencyMs"), "ms") },
    { label: "Avg jitter",  value: fmt(avg("jitterMs"), "ms") },
    { label: "Avg loss",    value: fmt(avg("packetLoss"), "%") },
  ];
  var tierPart = _tierStatsPart(data);
  if (tierPart) parts.unshift(tierPart);
  _renderChartStats(container, total, parts);
}

// Re-render the shared legend and all three Performance SLA charts from the
// stashed state (honors the current per-member hidden set). Called on initial
// load + on legend toggle.
function _renderAllPerfSlaCharts() {
  var st = _sdwanTabState;
  if (!st || !st.perfSla) return;
  var ps = st.perfSla;
  _renderPerfSlaLegend(document.getElementById("sdwan-perfsla-legend"), ps.series);
  var latEl  = document.getElementById("sdwan-latency-chart");
  var jitEl  = document.getElementById("sdwan-jitter-chart");
  var lossEl = document.getElementById("sdwan-loss-chart");
  // maxKey: the rollup bucket's peak, drawn dashed under each member's
  // average. Not on packet loss — its average is already the figure that
  // matters, and a 100 % peak in one sample would read as an outage.
  if (latEl)  _renderPerfSlaMultiChart(latEl,  ps.series, "latencyMs",  { label: "Latency", unit: "ms", threshold: ps.thr.latencyThresholdMs, maxKey: "maxLatencyMs" }, ps.copts);
  if (jitEl)  _renderPerfSlaMultiChart(jitEl,  ps.series, "jitterMs",   { label: "Jitter",  unit: "ms", threshold: ps.thr.jitterThresholdMs, maxKey: "maxJitterMs" }, ps.copts);
  if (lossEl) _renderPerfSlaMultiChart(lossEl, ps.series, "packetLoss", { label: "Packet loss", unit: "%", threshold: ps.thr.packetLossThreshold }, ps.copts);
}

// The one member legend above the stats line, driving all three charts. Same
// chips and gestures as the CPU chart's legend (_cpuLegendHTML /
// _wireCpuLegend): click to hide or show a member, double-click to show ONLY
// that member, "Show all" once anything is off. A member with no samples in
// the range gets no chip — there is nothing of it on any chart to toggle.
function _renderPerfSlaLegend(el, series) {
  if (!el) return;
  var hidden = (_sdwanTabState && _sdwanTabState.hiddenMembers) || new Set();
  var withData = series.filter(function (s) { return s.samples && s.samples.length; });
  if (!withData.length) { el.innerHTML = ""; return; }
  var chips = withData.map(function (s) {
    return _seriesChipHTML(s.label, s.label, s.color, !hidden.has(s.label),
      "Click to hide " + s.label + " · double-click to show only this member", "sdwan-legend-chip");
  }).join("");
  // One Max chip for the latency AND jitter charts on a rollup tier — a
  // separate control from the member chips, so isolate / Show all leave it be.
  var maxTier = _sdwanTabState && _sdwanTabState.perfSla && _sdwanTabState.perfSla.copts
    ? _sdwanTabState.perfSla.copts.maxTier : null;
  if (maxTier) chips += _maxLineChipHTML("assetSdwan", maxTier, _getMaxLinePref("assetSdwan"));
  if (hidden.size) {
    chips += '<span class="sdwan-legend-all" title="Show every member again"' +
      ' style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;color:var(--color-accent)">Show all</span>';
  }
  el.innerHTML = '<div style="display:flex;flex-wrap:wrap;gap:4px 10px;font-size:0.72rem;color:var(--color-text-secondary);margin:0.25rem 0 0.35rem">' +
    chips + '</div>';
  if (maxTier) _wireMaxLineChip(el, "assetSdwan", _renderAllPerfSlaCharts);
  // A double-click also fires two clicks — defer the single-click toggle just
  // past the double-click window (as _wireCpuLegend does) so an isolate does
  // not first hide the member it was aimed at.
  var clickTimer = null;
  el.querySelectorAll(".sdwan-legend-chip").forEach(function (chip) {
    var key = chip.getAttribute("data-series");
    chip.addEventListener("click", function () {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      clickTimer = setTimeout(function () {
        clickTimer = null;
        var st = _sdwanTabState;
        if (!st) return;
        if (!st.hiddenMembers) st.hiddenMembers = new Set();
        if (st.hiddenMembers.has(key)) st.hiddenMembers.delete(key);
        else st.hiddenMembers.add(key);
        _renderAllPerfSlaCharts();
      }, 220);
    });
    chip.addEventListener("dblclick", function () {
      if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
      var st = _sdwanTabState;
      if (!st) return;
      st.hiddenMembers = new Set(withData.map(function (s) { return s.label; }).filter(function (l) { return l !== key; }));
      _renderAllPerfSlaCharts();
    });
  });
  var all = el.querySelector(".sdwan-legend-all");
  if (all) {
    all.addEventListener("click", function () {
      if (_sdwanTabState) _sdwanTabState.hiddenMembers = new Set();
      _renderAllPerfSlaCharts();
    });
  }
}

// Screenshot stats line for a Performance SLA chart. The legend lives outside
// the chart SVG now, so the capture names the members it shows in the header
// instead — otherwise the lines in a copied image are anonymous.
function _perfSlaShotStats() {
  var base = _statsSummaryFrom("sdwan-perfsla-stats")();
  var st = _sdwanTabState;
  if (!st || !st.perfSla) return base;
  var hidden = st.hiddenMembers || new Set();
  var shown = st.perfSla.series.filter(function (s) { return s.samples && s.samples.length && !hidden.has(s.label); })
    .map(function (s) { return s.label; });
  if (!shown.length) return base;
  var line = "Members: " + shown.join(", ");
  return base ? base + " · " + line : line;
}

// Multi-series gauge chart: one polyline per visible member
// (`series[].samples`) and the shared dashed SLA threshold line. The legend is
// NOT drawn here — _renderPerfSlaLegend draws one for all three charts. The
// hidden set lives on `_sdwanTabState.hiddenMembers` so it persists across
// resize re-renders and is shared by all three charts.
function _renderPerfSlaMultiChart(container, series, metricKey, meta, opts) {
  opts = opts || {};
  meta = meta || {};
  // Build per-series value arrays; drop members with no numeric points.
  // Rollup tiers (opts.maxTier) with a meta.maxKey: each member's bucket
  // peak, kept on the value so the dashed line, the axis and the tooltip
  // read the same figure. Null on a bucket with no max.
  var maxTier = meta.maxKey ? opts.maxTier || null : null;
  var showMax = !!maxTier && _getMaxLinePref("assetSdwan");
  var drawn = series.map(function (s) {
    return {
      label: s.label, color: s.color,
      values: s.samples.map(function (x) {
        var m = maxTier ? x[meta.maxKey] : null;
        return { ts: x.timestamp, v: x[metricKey], m: typeof m === "number" && isFinite(m) ? m : null };
      }).filter(function (e) { return typeof e.v === "number"; }),
    };
  }).filter(function (s) { return s.values.length; });
  if (!drawn.length) { container.textContent = "No samples in this range yet."; return; }
  // Per-member hidden set (shared across all three charts; lives on tab state).
  var hidden = (_sdwanTabState && _sdwanTabState.hiddenMembers) || new Set();
  var visible = drawn.filter(function (s) { return !hidden.has(s.label); });
  var W = container.clientWidth || 600, H = 160;
  var padL = 52, padR = 10, padT = 10, padB = 24; // legend is HTML above the stats line
  var innerW = W - padL - padR, innerH = H - padT - padB;
  var allTs = [];
  drawn.forEach(function (s) { s.values.forEach(function (e) { allTs.push({ timestamp: e.ts }); }); });
  var bounds = _chartTimeBounds(allTs, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var spanMs = t1 - t0, oneDayMs = 86400000;
  var pad2 = _chartPad2;
  var hasThreshold = typeof meta.threshold === "number" && meta.threshold > 0;
  // Scale the y-axis to the VISIBLE series so hiding a high member rescales the
  // rest (fall back to all members when everything is hidden).
  var maxV = 1;
  (visible.length ? visible : drawn).forEach(function (s) { s.values.forEach(function (e) { if (e.v > maxV) maxV = e.v; }); });
  // Shown peaks join the axis (visible window only) so the dashed line is
  // never clipped off the top; hidden, the axis fits the averages + SLA line.
  if (showMax) {
    visible.forEach(function (s) {
      _inChartWindow(s.values, opts.since, "ts").forEach(function (e) { if (e.m != null && e.m > maxV) maxV = e.m; });
    });
  }
  if (hasThreshold) maxV = Math.max(maxV, meta.threshold * 1.05);
  function tidyCeil(n) { var exp = Math.pow(10, Math.floor(Math.log10(n))); var mant = n / exp; var step = mant <= 1 ? 1 : mant <= 2 ? 2 : mant <= 5 ? 5 : 10; return step * exp; }
  var ceil = tidyCeil(maxV);
  var xFor = _chartXScale(padL, innerW, t0, t1);
  var yFor = _chartYScale(padT, innerH, 0, ceil);
  var thresholdLine = "";
  if (hasThreshold) {
    var ty = yFor(meta.threshold);
    thresholdLine =
      '<line x1="' + padL + '" y1="' + ty + '" x2="' + (W - padR) + '" y2="' + ty + '" stroke="#e9a23b" stroke-width="1.25" stroke-dasharray="5,4"/>' +
      '<text x="' + (W - padR) + '" y="' + (ty - 3) + '" text-anchor="end" font-size="9" fill="#e9a23b">SLA ' + (Math.round(meta.threshold * 100) / 100) + ' ' + escapeHtml(meta.unit || "") + '</text>';
  }
  // Every member's max line goes in first, so all of them sit UNDER every
  // average line rather than one member's peak covering another's average.
  var maxSvg = showMax
    ? visible.map(function (s) {
        return _maxLineSVG(s.values.map(function (e) { return e.m == null ? null : { x: xFor(e.ts), y: yFor(e.m) }; }), s.color);
      }).join("")
    : "";
  var seriesSvg = visible.map(function (s) {
    var pts = s.values.map(function (e) { return xFor(e.ts) + "," + yFor(e.v); }).join(" ");
    var dots = s.values.map(function (e) {
      return '<circle class="chart-hit" cx="' + xFor(e.ts) + '" cy="' + yFor(e.v) + '" r="5" fill="transparent" style="cursor:crosshair"' +
        ' data-ts="' + escapeHtml(String(e.ts)) + '" data-v="' + e.v + '" data-member="' + escapeHtml(s.label) + '"' +
        (maxTier ? ' data-vmax="' + (e.m != null ? e.m : "") + '"' : '') + '/>';
    }).join("");
    return '<polyline points="' + pts + '" fill="none" stroke="' + s.color + '" stroke-width="1.5"/>' + dots;
  }).join("");
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4;
    var y = padT + innerH - (i / 4) * innerH;
    ticks +=
      '<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + (Math.round(v * 100) / 100) + '</text>';
  }
  var xTicks = _chartXTicksSVG(t0, t1, padL, padT, innerW, innerH);
  var clipId = _chartClipId("sdwanGauge");
  container.innerHTML =
    '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block">' +
      _chartClipDefs(clipId, padL, padT, innerW, innerH) +
      ticks + xTicks +
      _dateChangeMarkers(t0, t1, padL, padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, padL, padT, innerW, innerH) +
      '<g ' + _chartClipAttr(clipId) + '>' +
        thresholdLine +
        maxSvg +
        seriesSvg +
      '</g>' +
    '</svg>' + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  container.style.alignItems = "stretch";
  container.style.justifyContent = "flex-start";
  _stashChartGeometry(container, t0, t1, padL, innerW, W);
  _wireChartTooltip(container, function (target) {
    var unitSfx = meta.unit ? " " + meta.unit : "";
    var vmax = target.getAttribute("data-vmax");
    var reading = vmax != null
      ? _avgMaxText(target.getAttribute("data-v") + unitSfx, vmax !== "" ? vmax + unitSfx : null)
      : escapeHtml(target.getAttribute("data-v")) + ' ' + escapeHtml(meta.unit || "");
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(target.getAttribute("data-member")) + '</div>' +
      '<div>' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + '</div>' +
      '<div>' + escapeHtml(meta.label || metricKey) + ': ' + reading + '</div>';
  });
  _addChartScreenshotButton(container, "SD-WAN " + (meta.label || metricKey), { yAxis: (meta.label || "") + " (" + (meta.unit || "") + ")", subject: opts.subject, getStats: _perfSlaShotStats });
  _observeChartResize(container, function (c) { _renderPerfSlaMultiChart(c, series, metricKey, meta, opts); });
}

// ─── Fibre Channel tab (business rule 156) ─────────────────────────────────
//
// One tab, two readings of one fetch (`api.assets.fibreChannel`):
//  - on an FC switch, its ports and the device logged into each one, with the
//    port's cumulative error counters;
//  - on a server the switches matched by registered host name, one card per
//    switch (a fabric), its HBA ports, the health of each link, and the other
//    devices on that switch's VSAN that registered no HBA string (in practice
//    the storage array's target ports).
// Prefetched beside the panel's wave so the tab is present or absent on first
// paint; drawn from the prefetched payload, re-read by the strip's Poll.

function _fcTabEligible(payload) {
  return !!(payload && (payload.switch || payload.host));
}

function _assetFcTabHTML(assetId) {
  return '<div id="asset-fc-mount-' + escapeHtml(assetId) + '">' +
    '<span class="empty-state">Loading…</span></div>';
}

// The counters an operator acts on, in the order they read: a link that
// dropped, then words / frames the optic mangled. Zero is shown as a dash so a
// non-zero cell stands out; a non-zero corruption counter is amber.
var _FC_ERROR_COLS = [
  ["linkFailures",   "Link failures",  "Times the link went down (fcIfLinkFailures)", false],
  ["syncLosses",     "Sync losses",    "Losses of synchronisation (fcIfSyncLosses)", true],
  ["sigLosses",      "Signal losses",  "Losses of signal (fcIfSigLosses)", false],
  ["invalidTxWords", "Invalid words",  "Invalid transmission words received — usually an optic, cable or connector (fcIfInvalidTxWords)", true],
  ["invalidCrcs",    "CRC errors",     "Frames received with a bad CRC (fcIfInvalidCrcs)", true],
];

function _fcCounterCells(counters) {
  var c = counters || {};
  return _FC_ERROR_COLS.map(function (col) {
    var v = c[col[0]];
    if (typeof v !== "number" || v === 0) return '<td class="mono" style="color:var(--color-text-tertiary)">—</td>';
    var warn = col[3];
    return '<td class="mono"' + (warn ? ' style="color:var(--color-warning);font-weight:600"' : "") +
      ' title="' + escapeHtml(col[2]) + '">' + escapeHtml(Number(v).toLocaleString()) + '</td>';
  }).join("");
}

function _fcCounterHeads() {
  return _FC_ERROR_COLS.map(function (col) {
    return '<th title="' + escapeHtml(col[2]) + '">' + escapeHtml(col[1]) + '</th>';
  }).join("");
}

function _fcAnyErrors(counters) {
  var c = counters || {};
  return _FC_ERROR_COLS.some(function (col) { return typeof c[col[0]] === "number" && c[col[0]] > 0; });
}

// The attached device's best name: the asset it was matched to, else the
// registered host name / port label, else the HBA model.
function _fcDeviceHTML(login) {
  if (login.matchedAsset) {
    return '<a href="#" class="asset-link" data-asset-id="' + escapeHtml(login.matchedAsset.id) + '"' +
      ' title="Matched by the host name the HBA registered (' + escapeHtml(login.hostName || "") + ')">' +
      escapeHtml(login.matchedAsset.hostname || login.hostName || login.matchedAsset.id) + '</a>';
  }
  if (login.hostName) {
    return '<span title="Registered name; no single asset answers to it">' + escapeHtml(login.hostName) + '</span>';
  }
  return '<span style="color:var(--color-text-tertiary)">' + escapeHtml(login.hbaModel || "unnamed") + '</span>';
}

function _fcHbaHTML(r) {
  var parts = [];
  if (r.hbaModel) parts.push(escapeHtml(r.hbaModel));
  var ver = [r.hbaFirmware ? "FW " + r.hbaFirmware : "", r.hbaDriver ? "driver " + r.hbaDriver : ""].filter(Boolean).join(" · ");
  if (ver) parts.push('<span style="color:var(--color-text-secondary)">' + escapeHtml(ver) + '</span>');
  if (r.osInfo) parts.push('<span style="color:var(--color-text-secondary)">' + escapeHtml(r.osInfo) + '</span>');
  return parts.length ? parts.join("<br>") : '<span style="color:var(--color-text-tertiary)">—</span>';
}

function _fcSwitchHTML(sw) {
  var loginsByIf = {};
  (sw.logins || []).forEach(function (l) { (loginsByIf[l.ifIndex] = loginsByIf[l.ifIndex] || []).push(l); });
  var used = [], idle = [];
  (sw.ports || []).forEach(function (p) {
    if (loginsByIf[p.ifIndex] || _fcAnyErrors(p.errorCounters)) used.push(p); else idle.push(p);
  });
  var rows = used.map(function (p) {
    var ls = loginsByIf[p.ifIndex] || [];
    var port = '<td class="mono">' + escapeHtml(p.ifName || ("ifIndex " + p.ifIndex)) + '</td>';
    if (ls.length === 0) {
      return '<tr>' + port + '<td>—</td>' +
        '<td colspan="3" style="color:var(--color-text-tertiary)" title="The port has error history but nothing is logged in now">nothing logged in</td>' +
        _fcCounterCells(p.errorCounters) + '</tr>';
    }
    return ls.map(function (l, i) {
      return '<tr>' + (i === 0 ? port : '<td></td>') +
        '<td>' + escapeHtml(String(l.vsan)) + '</td>' +
        '<td>' + _fcDeviceHTML(l) + '</td>' +
        '<td class="mono" title="' + escapeHtml(l.nodeWwn ? "Node WWN " + l.nodeWwn : "") + '">' + escapeHtml(l.portWwn) + '</td>' +
        '<td>' + _fcHbaHTML(l) + '</td>' +
        (i === 0 ? _fcCounterCells(p.errorCounters) : '<td colspan="' + _FC_ERROR_COLS.length + '"></td>') +
      '</tr>';
    }).join("");
  }).join("");
  var idleLine = idle.length
    ? '<p style="margin:0.4rem 0 0;font-size:0.8rem;color:var(--color-text-tertiary)">' +
        idle.length + ' more port' + (idle.length === 1 ? "" : "s") + ' with nothing logged in and no errors: ' +
        escapeHtml(idle.map(function (p) { return p.ifName || p.ifIndex; }).join(", ")) + '</p>'
    : "";
  return '<div class="table-wrapper"><table class="ip-table" style="font-size:0.8rem"><thead><tr>' +
      '<th>Port</th><th>VSAN</th><th>Device</th><th>Port WWN</th><th>HBA / OS</th>' + _fcCounterHeads() +
    '</tr></thead><tbody>' + (rows || '<tr><td colspan="' + (5 + _FC_ERROR_COLS.length) + '" class="empty-state">No ports in use.</td></tr>') +
    '</tbody></table></div>' + idleLine +
    '<p style="margin:0.4rem 0 0;font-size:0.75rem;color:var(--color-text-tertiary)">Error counts are the switch\'s totals since its counters were last cleared, not a rate.</p>';
}

// How a login was tied to this asset: the WWN the host itself reported
// (exact), or the host name its HBA registered with the switch.
function _fcMatchHTML(method) {
  if (method === "wwn") return '<span title="The host reports this port WWN as its own HBA">WWN</span>';
  if (method === "name") return '<span title="The host name the HBA registered with the switch matches this asset" style="color:var(--color-text-secondary)">name</span>';
  return '<span style="color:var(--color-text-tertiary)">—</span>';
}

// The host's own HBA ports (agent / vCenter), and the switch port that sees
// each one logged in — or that no switch in Polaris does.
function _fcHostHbasHTML(hbas) {
  if (!hbas || !hbas.length) return "";
  var rows = hbas.map(function (h) {
    var seen = (h.seenBy || []).length
      ? h.seenBy.map(function (s) {
          return '<a href="#" class="asset-link" data-asset-id="' + escapeHtml(s.switch.id) + '">' +
            escapeHtml(s.switch.hostname || s.switch.id) + '</a> <span class="mono">' + escapeHtml(s.ifName || "") + '</span>';
        }).join("<br>")
      : '<span style="color:var(--color-text-tertiary)" title="No switch in Polaris has this WWN logged in">no monitored switch</span>';
    var state = h.portState || "—";
    var stateBad = h.portState && !/^online$/i.test(h.portState);
    return '<tr>' +
      '<td class="mono">' + escapeHtml(h.name || "—") + '</td>' +
      '<td class="mono">' + escapeHtml(h.portWwn) + '</td>' +
      '<td' + (stateBad ? ' style="color:var(--color-warning);font-weight:600"' : "") + '>' + escapeHtml(state) + '</td>' +
      '<td>' + escapeHtml(h.speed || "—") + '</td>' +
      '<td class="mono" title="The WWN of the fabric this port is attached to">' + escapeHtml(h.fabricWwn || "—") + '</td>' +
      '<td>' + _fcHbaHTML({ hbaModel: h.model, hbaFirmware: h.firmware, hbaDriver: h.driver }) + '</td>' +
      '<td>' + seen + '</td>' +
      '<td style="color:var(--color-text-secondary)">' + escapeHtml(h.source === "vcenter" ? "vCenter" : "Polaris Agent") + '</td>' +
    '</tr>';
  }).join("");
  return '<h5 style="margin:0.9rem 0 0.35rem">HBA ports this host reports</h5>' +
    '<div class="table-wrapper"><table class="ip-table" style="font-size:0.8rem"><thead><tr>' +
      '<th>Port</th><th>Port WWN</th><th>State</th><th>Speed</th><th>Fabric</th><th>HBA</th><th>Seen by</th><th>Reported by</th>' +
    '</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function _fcHostHTML(host) {
  var fabrics = host.fabrics || [];
  var hbas = host.hbas || [];
  var fabricWwns = {};
  hbas.forEach(function (h) { if (h.fabricWwn) fabricWwns[h.fabricWwn] = true; });
  var hostFabricCount = Object.keys(fabricWwns).length;
  var note = "";
  if (fabrics.length === 1 && hostFabricCount >= 2) {
    note = calloutHTML("note", "One fabric monitored",
      "This host is attached to " + hostFabricCount + " fabrics, but only one of their switches is monitored in Polaris.");
  } else if (fabrics.length === 1) {
    note = calloutHTML("warning", "One fabric",
      "Only one fibre-channel switch in Polaris sees this host. Either it has no second fabric path, " +
      "or the other switch is not monitored over SNMP.");
  } else if (fabrics.length === 0 && hbas.length) {
    note = calloutHTML("note", "No monitored switch",
      "No fibre-channel switch in Polaris has this host's HBA ports logged in. The ports below are what the host itself reports.");
  }
  return note + fabrics.map(function (f, idx) {
    var swName = (f.switch && (f.switch.hostname || f.switch.id)) || "switch";
    var head = '<h5 style="margin:0.8rem 0 0.35rem">Fabric ' + String.fromCharCode(65 + idx) + ' · ' +
      '<a href="#" class="asset-link" data-asset-id="' + escapeHtml(f.switch.id) + '">' + escapeHtml(swName) + '</a>' +
      (f.switch.model ? ' <span style="font-weight:400;color:var(--color-text-secondary)">' + escapeHtml(f.switch.model) + '</span>' : "") +
      ' <span style="font-weight:400;color:var(--color-text-secondary)">· VSAN ' + escapeHtml(f.vsans.join(", ")) + '</span></h5>';
    var rows = (f.ports || []).map(function (p) {
      return '<tr>' +
        '<td class="mono">' + escapeHtml(p.portWwn) + '</td>' +
        '<td class="mono">' + escapeHtml(p.ifName || "—") + '</td>' +
        '<td>' + _fcHbaHTML(p) + '</td>' +
        '<td>' + _fcMatchHTML(p.matchMethod) + '</td>' +
        _fcCounterCells(p.errorCounters) +
      '</tr>';
    }).join("");
    var others = (f.others || []).length
      ? '<p style="margin:0.35rem 0 0;font-size:0.8rem;color:var(--color-text-secondary)">Also on this switch\'s VSAN, with no HBA registration (usually storage): ' +
          f.others.map(function (o) {
            return escapeHtml(o.label || o.portWwn) + ' <span class="mono" style="color:var(--color-text-tertiary)">(' + escapeHtml(o.ifName || "") + ')</span>';
          }).join(", ") + '</p>'
      : "";
    return head + '<div class="table-wrapper"><table class="ip-table" style="font-size:0.8rem"><thead><tr>' +
        '<th>HBA port WWN</th><th>Switch port</th><th>HBA / OS</th><th>Matched by</th>' + _fcCounterHeads() +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>' + others;
  }).join("") +
  _fcHostHbasHTML(hbas) +
  '<p style="margin:0.5rem 0 0;font-size:0.75rem;color:var(--color-text-tertiary)">A switch port is tied to this host by the WWN the host reports, ' +
    'or failing that by the host name its HBA registered. Error counts are the switch port\'s totals since its counters were last cleared.</p>';
}

function _renderAssetFc(assetId, payload) {
  var mount = document.getElementById("asset-fc-mount-" + assetId);
  if (!mount) return;
  var d = payload || {};
  var refreshId = "fc-refresh-" + assetId;
  var html = _currentStateStripHTML({
    title: d.switch ? "Fibre Channel ports" : "Fibre Channel",
    lastAt: d.collectedAt || null,
    neverText: "not collected yet",
    refreshId: refreshId,
    refreshTitle: "Re-read the switch's fibre-channel tables now",
  });
  if (d.switch) html += _fcSwitchHTML(d.switch);
  if (d.host) html += _fcHostHTML(d.host);
  mount.innerHTML = html;
  _wireAssetPivotLinks(mount);
  // A host's Poll re-reads THIS asset, which holds no FC tables; the strip's
  // button is offered on the switch only.
  if (d.switch) {
    _wireCurrentStateRefresh(refreshId, assetId, async function () {
      var next = await api.assets.fibreChannel(assetId).catch(function () { return null; });
      if (next) _renderAssetFc(assetId, next);
    });
  } else {
    var btn = document.getElementById(refreshId);
    if (btn) btn.remove();
  }
}

// ─── MAC Table tab ─────────────────────────────────────────────────────────
//
// The switch's layer-2 forwarding database. Two views of the same fetch: the
// per-port MAC counts (which distinguish an access port from an uplink at a
// glance) and the entry list itself.

// Per-asset filter text, keyed by asset id like the ARP Table tab's, so the
// strip's Refresh (a full re-fetch) keeps the operator's filter.
var _assetMacFilter = {};

// VLAN id -> name per asset, from the last system-info load. The interface
// slide-over reads it; the MAC Table brings its own copy in its response.
var _assetVlanNames = {};

function _assetMacTableTabHTML(assetId) {
  return '<div id="asset-mactable-mount-' + escapeHtml(assetId) + '">' +
    '<span class="empty-state">Loading…</span></div>';
}

function _wireAssetMacTableTab(assetId) {
  var btn = document.querySelector('#asset-view-tabs .page-tab[data-tab="mactable"]');
  if (!btn) return;
  var loaded = false;
  btn.addEventListener("click", function () {
    if (loaded) return;
    loaded = true;
    _loadAssetMacTable(assetId);
  });
}

async function _loadAssetMacTable(assetId) {
  var mount = document.getElementById("asset-mactable-mount-" + assetId);
  if (!mount) return;
  try {
    var data = await api.assets.macTable(assetId);
    var entries = (data && data.entries) || [];
    var vlanNames = (data && data.vlanNames) || {};
    // ifName → the port's configured native / tagged VLANs.
    var portVlans = (data && data.portVlans) || {};

    // Cadence · freshness · Refresh, on the server's fully-walked
    // pollIntervalSec so the chip and the amber threshold are the same figure.
    // `collectedAt` is the scrape stamp (persistMacTable writes one `now`
    // across every row) and stays the ONLY source for the stamp: a switch
    // polled over REST via its parent FortiGate has a recent system-info pass
    // and no forwarding database at all, and "updated 2m ago" over an empty
    // table would be a claim the data does not support.
    var macCadenceSec = (data && typeof data.pollIntervalSec === "number") ? data.pollIntervalSec : null;
    function stripHTML(suffixHTML) {
      return _currentStateStripHTML({
        title: "Forwarding database",
        suffixHTML: suffixHTML || "",
        chipHTML: _cadenceChipHTML(macCadenceSec, "How often the system-info pass re-reads this switch's forwarding database"),
        lastAt: (data && data.collectedAt) || null,
        cadenceSec: macCadenceSec,
        neverText: "no entries recorded yet",
        refreshId: "mactable-refresh-" + assetId,
        refreshTitle: "Re-read this switch's forwarding database from the device now",
      });
    }
    function wireStrip() {
      _wireCurrentStateRefresh("mactable-refresh-" + assetId, assetId, function () {
        return _loadAssetMacTable(assetId);
      });
    }

    if (entries.length === 0) {
      // The pass stamp belongs HERE rather than in the strip: it separates
      // "never scraped" from "scraped and genuinely empty", which is the whole
      // question an operator has in front of an empty forwarding database.
      var lastPass = data && data.lastSystemInfoAt;
      mount.innerHTML = stripHTML() +
        '<span class="empty-state">No forwarding-database entries. ' +
        'This is collected over SNMP on the system-info cadence; a switch polled ' +
        'via its parent FortiGate reports none.' +
        (lastPass
          ? ' The last system-info pass ran ' + escapeHtml(timeAgo(lastPass)) + ' and returned none.'
          : ' No system-info pass has completed against this switch yet.') +
        '</span>';
      wireStrip();
      return;
    }

    var dash = '<span style="color:var(--color-text-secondary)">—</span>';

    // The table reads port-first: an operator asks "what is on port 32", not
    // "where is this MAC". So the interface IS the row, with its MACs nested
    // under it — which also puts the per-port count (the single most useful
    // number here) on the same line as the port instead of in a second table
    // above. Toggle glyphs + the child prefix follow the Interfaces table's
    // conventions; the group header row follows the SD-WAN zone header's.
    function groupsFrom(rows) {
      var byKey = {};
      rows.forEach(function (e) {
        // Unresolved rows group by their raw basePort — see the note below on
        // why they exist at all.
        var key = e.ifName || ("base port " + (e.basePort != null ? e.basePort : "?"));
        (byKey[key] = byKey[key] || { key: key, resolved: !!e.ifName, entries: [] }).entries.push(e);
      });
      return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
        // Resolved ports first, then natural order so port7 precedes port32.
        if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
        return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" });
      });
    }

    // Rows whose basePort never resolved to an interface. On a FortiSwitch
    // these are the trunk/LAG pseudo-ports (base port 32768 and up), which
    // publish no dot1dBasePortIfIndex row — so every MAC behind the trunk
    // lands here, unattributable, and swamps the real per-port entries.
    // Hidden by DEFAULT rather than dropped: they are legitimate sightings,
    // they just can't be placed on a port. The per-port summary above already
    // excludes them (macCountsByPort requires an ifName).
    var attributed   = entries.filter(function (e) { return !!e.ifName; });
    var unattributed = entries.filter(function (e) { return !e.ifName; });
    var showUnattributed = false;
    var filter = _assetMacFilter[assetId] || "";
    var countsId = "mactable-counts-" + assetId;
    var noteId   = "mactable-note-" + assetId;
    var bodyId   = "mactable-body-" + assetId;

    // Substring match across every identifying field — the ARP Table box's
    // rule, so "where is that MAC", "what is on port 32" and "which port is
    // PRINTER-4 on" are all one box. The interface name is the group key for
    // an unresolved row too, so "base port 32768" finds the trunk's entries.
    // A MAC fragment matches with or without separators (_childFilterMatches).
    function matches(e) {
      return _childFilterMatches([
        e.ifName || ("base port " + (e.basePort != null ? e.basePort : "?")),
        e.vlanId != null ? "vlan " + e.vlanId : "",
        e.vlanId != null ? (vlanNames[String(e.vlanId)] || "") : "", e.status || "",
        e.matchedAsset ? (e.matchedAsset.hostname || "") : "",
        e.matchedAsset ? (e.matchedAsset.ipAddress || "") : "",
      ], [e.macAddress], filter);
    }

    // The shell (strip + filter box) renders ONCE and only the counts, the
    // unresolved-port note and the table re-render as the operator types —
    // the ARP Table tab's arrangement; rebuilding the box loses the caret.
    function render() {
      mount.innerHTML =
        stripHTML('<span id="' + countsId + '" style="font-weight:400;color:var(--color-text-secondary)"></span>') +
        '<div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin:0 0 0.5rem">' +
          '<input type="text" id="mactable-filter-' + escapeHtml(assetId) + '" class="form-input" ' +
            'placeholder="Filter by MAC, interface, VLAN or hostname" ' +
            'style="max-width:22rem;font-size:0.82rem;flex:1 1 14rem" value="' + escapeHtml(filter) + '">' +
        '</div>' +
        '<div id="' + noteId + '"></div>' +
        '<div id="' + bodyId + '"></div>';
      wireStrip();
      var box = document.getElementById("mactable-filter-" + assetId);
      if (box) {
        // Debounced like the ARP box: a core switch's table runs to thousands.
        box.addEventListener("input", debounce(function () {
          filter = box.value.trim().toLowerCase();
          _assetMacFilter[assetId] = filter;
          renderTable();
        }, 150));
      }
      renderTable();
    }

    function renderTable() {
      var pool   = showUnattributed ? attributed.concat(unattributed) : attributed;
      var shown  = pool.filter(matches);
      var groups = groupsFrom(shown);
      var counts = document.getElementById(countsId);
      if (counts) {
        counts.textContent = '(' + shown.length + (filter ? " of " + pool.length : "") +
          ' entries on ' + groups.length + ' interface' + (groups.length === 1 ? "" : "s") + ')';
      }
      var noteEl = document.getElementById(noteId);
      if (noteEl) {
        noteEl.innerHTML = unattributed.length === 0 ? "" :
          '<div style="margin:0 0 0.5rem;font-size:0.82rem;color:var(--color-text-secondary)">' +
            unattributed.length + ' entr' + (unattributed.length === 1 ? "y" : "ies") +
            ' on ports Polaris could not resolve (trunk / LAG pseudo-ports). ' +
            '<button type="button" class="mactable-toggle-link" id="mactable-toggle-' + assetId + '">' +
              (showUnattributed ? "Hide" : "Show") +
            '</button>' +
          '</div>';
      }
      var bodyEl = document.getElementById(bodyId);
      if (!bodyEl) return;
      bodyEl.innerHTML = groups.length === 0
        ? '<div class="empty-state">' + (filter ? "No entries match that filter." : "No entries on a resolved port.") + '</div>'
        : '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
            '<th>Interface / MAC</th><th title="The VLAN the entry was learned in; the port\'s configured native / tagged VLANs are on its row">VLAN</th><th>Status</th><th>Device</th>' +
          '</tr></thead><tbody>' + groups.map(groupHtml).join("") + '</tbody></table></div>';
      var toggle = document.getElementById("mactable-toggle-" + assetId);
      if (toggle) toggle.addEventListener("click", function () {
        showUnattributed = !showUnattributed;
        renderTable();
      });
      _wireGroupToggles(bodyEl, {
        toggle: ".mactable-group-toggle", entry: ".mactable-entry",
        expandTitle: "Expand entries", collapseTitle: "Collapse entries",
      });
      // The Device column's links had no listener anywhere until the ARP Table
      // tab arrived needing the same pivot — they rendered as anchors and did
      // nothing when clicked.
      _wireAssetPivotLinks(bodyEl);
    }

    function groupHtml(g) {
      // Only `learned` rows say what is reachable through the port: `self` is
      // the bridge's own address and `mgmt` a configured static entry, so both
      // are shown but neither counts toward the access-vs-uplink reading.
      var learned = g.entries.filter(function (e) { return e.status === "learned"; }).length;
      var reads = !g.resolved ? "unresolved port — every MAC behind the trunk lands here"
        : learned === 0 ? ""
        : learned === 1 ? "access port (one device)"
        : "uplink / trunk (" + learned + " devices behind it)";
      var head = '<tr class="mactable-group"><td colspan="4" style="padding:5px 8px;font-weight:600;' +
        'background:var(--color-bg-primary);color:var(--color-text-secondary)">' +
        '<button type="button" class="mactable-group-toggle" data-group="' + escapeHtml(g.key) + '" ' +
          'style="background:none;border:none;cursor:pointer;color:var(--color-text-secondary);' +
          'padding:0 3px 0 0;font-size:0.75rem;vertical-align:middle;line-height:1" ' +
          'title="Collapse entries">▼</button>' +
        '<span class="mono" style="color:var(--color-text-primary)">' + escapeHtml(g.key) + '</span> ' +
        '<span style="font-weight:400">· ' + g.entries.length + ' MAC' + (g.entries.length === 1 ? "" : "s") +
          (reads ? " · " + escapeHtml(reads) : "") + '</span>' +
        // What the port is configured to carry, beside the VLAN column's
        // learned-in VLAN per entry. Resolved ports only: an unresolved
        // pseudo-port has no interface row to read.
        (g.resolved && portVlans[g.key]
          ? ' <span style="font-weight:400;margin-left:0.5rem">' + _portVlansHTML(portVlans[g.key], vlanNames) + '</span>'
          : "") +
        '</td></tr>';
      return head + g.entries.map(function (e, i) {
        return entryHtml(e, g.key, i === g.entries.length - 1);
      }).join("");
    }

    function entryHtml(e, groupKey, isLast) {
      var dev = e.matchedAsset
        ? '<a href="#" class="asset-link" data-asset-id="' + escapeHtml(e.matchedAsset.id) + '">' +
            escapeHtml(e.matchedAsset.hostname || e.matchedAsset.ipAddress || e.matchedAsset.id) + '</a>'
        : dash;
      return '<tr class="mactable-entry" data-group="' + escapeHtml(groupKey) + '">' +
        '<td class="mono" style="padding-left:1.4rem">' +
          _treeElbow(isLast) +
          escapeHtml(e.macAddress) +
        '</td>' +
        '<td>' + (e.vlanId != null ? _vlanPillHTML(e.vlanId, vlanNames, e.vlanInferred === true) : dash) + '</td>' +
        '<td>' + escapeHtml(e.status) + '</td>' +
        '<td>' + dev + '</td>' +
      '</tr>';
    }

    render();
  } catch (err) {
    mount.innerHTML = '<span class="empty-state">Error: ' + escapeHtml(err.message || "failed to load") + '</span>';
  }
}


// ─── FortiGate Wireless / MAC Table tabs (managed children) ────────────────
//
// A FortiGate's view of what its FortiAPs and FortiSwitches already hold: the
// clients of every AP (GET /assets/:id/child-wireless) and the forwarding
// database of every switch (GET /assets/:id/child-mac-table), one group per
// child. The rows are each child's own — the same ones its own Wireless / MAC
// Table tab shows — so freshness is stated per child on its group row, not
// once for the gate. No Poll button: polling the gate re-reads none of them.

// Per-asset filter text, keyed by "<tab>:<gate id>" like the per-device tabs'.
var _assetChildFilter = {};

function _assetChildMountHTML(kind, assetId) {
  return '<div id="asset-' + kind + '-mount-' + escapeHtml(assetId) + '">' +
    '<span class="empty-state">Loading…</span></div>';
}

function _wireAssetChildTabs(assetId) {
  [["childwireless", _loadAssetChildWireless], ["childmactable", _loadAssetChildMacTable]].forEach(function (pair) {
    var btn = document.querySelector('#asset-view-tabs .page-tab[data-tab="' + pair[0] + '"]');
    if (!btn) return;
    var loaded = false;
    function load() {
      if (loaded) return;
      loaded = true;
      pair[1](assetId);
    }
    btn.addEventListener("click", load);
    // Opened straight onto this tab (opts.tab) — the click already happened.
    if (btn.classList.contains("active")) load();
  });
}

// One child's group header: name (opens the child), its address and model,
// the caller's count text, and the child's own freshness stamp.
function _childGroupHeadHTML(child, countText, colspan) {
  var name = child.hostname || child.ipAddress || child.serialNumber || child.id;
  var sub = [child.ipAddress, child.model].filter(Boolean).join(" · ");
  return '<tr class="childtab-group"><td colspan="' + colspan + '" style="padding:5px 8px;font-weight:600;' +
      'background:var(--color-bg-primary);color:var(--color-text-secondary)">' +
    '<button type="button" class="childtab-group-toggle" data-group="' + escapeHtml(child.id) + '" ' +
      'style="background:none;border:none;cursor:pointer;color:var(--color-text-secondary);' +
      'padding:0 3px 0 0;font-size:0.75rem;vertical-align:middle;line-height:1" ' +
      'title="Collapse">▼</button>' +
    '<a href="#" class="asset-link" data-asset-id="' + escapeHtml(child.id) + '">' + escapeHtml(name) + '</a> ' +
    '<span style="font-weight:400">' +
      (sub ? '· <span class="mono">' + escapeHtml(sub) + '</span> ' : "") +
      '· ' + escapeHtml(countText) + ' · ' +
    '</span>' +
    (child.monitored
      ? _freshnessStampHTML(child.lastSystemInfoAt, null, "never collected")
      : '<span style="font-size:0.72rem;color:var(--color-text-tertiary)">not monitored</span>') +
  '</td></tr>';
}

// Shared shell: heading + counts, filter box, an optional note line and the
// table body. Rendered ONCE; only the counts / note / body re-render as the
// operator types (rebuilding the box loses the caret).
// The heading's stamp is the NEWEST child poll — the gate itself writes none of
// these rows — and each group row states its own child's age beside it.
function _childTabShell(mount, kind, assetId, title, placeholder, children, renderBody) {
  var stateKey = kind + ":" + assetId;
  var filter = _assetChildFilter[stateKey] || "";
  var newest = null;
  children.forEach(function (c) {
    if (c.lastSystemInfoAt && (!newest || c.lastSystemInfoAt > newest)) newest = c.lastSystemInfoAt;
  });
  mount.innerHTML =
    _currentStateStripHTML({
      title: title,
      suffixHTML: '<span id="' + kind + '-counts-' + escapeHtml(assetId) + '" style="font-weight:400;color:var(--color-text-secondary)"></span>',
      lastAt: newest,
      neverText: "no child polled yet",
    }) +
    '<div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin:0 0 0.5rem">' +
      '<input type="text" id="' + kind + '-filter-' + escapeHtml(assetId) + '" class="form-input" ' +
        'placeholder="' + escapeHtml(placeholder) + '" ' +
        'style="max-width:22rem;font-size:0.82rem;flex:1 1 14rem" value="' + escapeHtml(filter) + '">' +
    '</div>' +
    '<div id="' + kind + '-note-' + escapeHtml(assetId) + '"></div>' +
    '<div id="' + kind + '-body-' + escapeHtml(assetId) + '"></div>';
  var countsEl = document.getElementById(kind + "-counts-" + assetId);
  var noteEl   = document.getElementById(kind + "-note-" + assetId);
  var bodyEl   = document.getElementById(kind + "-body-" + assetId);
  function rerender() {
    renderBody(filter, bodyEl, countsEl, noteEl, rerender);
    _wireAssetPivotLinks(bodyEl);
    _wireGroupToggles(bodyEl, {
      toggle: ".childtab-group-toggle", entry: ".childtab-entry",
      expandTitle: "Expand", collapseTitle: "Collapse",
    });
  }
  var box = document.getElementById(kind + "-filter-" + assetId);
  if (box) {
    box.addEventListener("input", debounce(function () {
      filter = box.value.trim().toLowerCase();
      _assetChildFilter[stateKey] = filter;
      rerender();
    }, 150));
  }
  rerender();
}

// Partial match for the filter box. Plain substring over every field, so a
// middle fragment of an IP ("41.30") or a colon-separated MAC ("a0:12") hits;
// MAC fields are ALSO compared with separators stripped from both sides, so
// "a012", "a0-12" and "a0.12" (Cisco-style dotted) find AA:BB:A0:12:… too.
// That separator-free match must START ON AN OCTET (an even offset): without
// the rule "a0" would hit BA:01 through "ba01", which no one typing a0 means.
// `filter` is already lower-cased.
function _childFilterMatches(textParts, macParts, filter) {
  return PolarisAssetShared.childFilterMatches(textParts, macParts, filter);
}

async function _loadAssetChildWireless(assetId) {
  var mount = document.getElementById("asset-childwireless-mount-" + assetId);
  if (!mount) return;
  try {
    var data = await api.assets.childWireless(assetId);
    var aps = (data && data.accessPoints) || [];
    var stations = (data && data.stations) || [];
    var byAp = {};
    stations.forEach(function (s) { (byAp[s.apAssetId] = byAp[s.apAssetId] || []).push(s); });
    var dash = '<span style="color:var(--color-text-secondary)">—</span>';

    _childTabShell(mount, "childwireless", assetId, "Wireless clients",
      "Filter by client MAC, IP, SSID or hostname, or access point name, IP or model", aps,
      function (filter, bodyEl, countsEl) {
        var shownTotal = 0;
        var rows = aps.map(function (ap) {
          var own = byAp[ap.id] || [];
          // An AP whose own name or address matches keeps all its clients.
          var apHit = filter && _childFilterMatches([ap.hostname, ap.ipAddress, ap.serialNumber, ap.model], [], filter);
          var shown = (!filter || apHit) ? own : own.filter(function (s) {
            var m = s.matchedAsset || {};
            return _childFilterMatches([s.staIpAddr, s.ssid, m.hostname, m.ipAddress], [s.staMacAddr, s.bssid], filter);
          });
          if (filter && !apHit && shown.length === 0) return "";
          shownTotal += shown.length;
          var head = _childGroupHeadHTML(ap,
            own.length + (own.length === 1 ? " client" : " clients"), 6);
          if (shown.length === 0) {
            return head + '<tr class="childtab-entry" data-group="' + escapeHtml(ap.id) + '">' +
              '<td colspan="6" style="padding-left:1.4rem;color:var(--color-text-tertiary);font-size:0.78rem">' +
              'No clients connected.</td></tr>';
          }
          return head + shown.map(function (s, i) {
            var signal = (s.signalStrength != null) ? (s.signalStrength + " dBm") : "—";
            return '<tr class="childtab-entry" data-group="' + escapeHtml(ap.id) + '">' +
              '<td class="mono" style="padding-left:1.4rem;white-space:nowrap">' + _treeElbow(i === shown.length - 1) + escapeHtml(s.staMacAddr) + '</td>' +
              '<td style="white-space:nowrap">' + (s.ssid ? escapeHtml(s.ssid) : dash) + '</td>' +
              '<td class="mono" style="white-space:nowrap">' + (s.staIpAddr ? escapeHtml(s.staIpAddr) : dash) + '</td>' +
              '<td>' + (s.matchedAsset
                ? '<a href="#" class="asset-link" data-asset-id="' + escapeHtml(s.matchedAsset.id) + '">' +
                    escapeHtml(s.matchedAsset.hostname || s.matchedAsset.ipAddress || s.matchedAsset.id) + '</a>'
                : '<span style="color:var(--color-text-tertiary);white-space:nowrap">(not in inventory)</span>') + '</td>' +
              '<td>' + escapeHtml(_wirelessBandLabel(s.band)) + '</td>' +
              '<td style="text-align:right;white-space:nowrap">' + escapeHtml(signal) + '</td>' +
            '</tr>';
          }).join("");
        }).join("");
        if (countsEl) {
          countsEl.textContent = filter
            ? "(" + shownTotal + " of " + stations.length + " clients match)"
            : "(" + stations.length + " client" + (stations.length === 1 ? "" : "s") + " on " +
              aps.length + " access point" + (aps.length === 1 ? "" : "s") + ")";
        }
        bodyEl.innerHTML = !rows
          ? '<div class="empty-state">No access points or clients match that filter.</div>'
          : '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
              '<th>Access point / Client</th><th>SSID</th><th>IP</th><th>Endpoint</th><th style="white-space:nowrap">Band</th>' +
              '<th style="text-align:right;white-space:nowrap">Signal</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      });
  } catch (err) {
    mount.innerHTML = '<span class="empty-state">Error: ' + escapeHtml(err.message || "failed to load") + '</span>';
  }
}

async function _loadAssetChildMacTable(assetId) {
  var mount = document.getElementById("asset-childmactable-mount-" + assetId);
  if (!mount) return;
  try {
    var data = await api.assets.childMacTable(assetId);
    var switches = (data && data.switches) || [];
    var entries = (data && data.entries) || [];
    var vlanNames = (data && data.vlanNames) || {};
    // switch id → ifName → the port's configured native / tagged VLANs.
    var portVlans = (data && data.portVlans) || {};
    var bySw = {};
    entries.forEach(function (e) { (bySw[e.switchAssetId] = bySw[e.switchAssetId] || []).push(e); });
    var dash = '<span style="color:var(--color-text-secondary)">—</span>';
    // Trunk / LAG pseudo-port rows hidden by default, as on a switch's own
    // MAC Table tab: every MAC behind the trunk lands there, unattributable.
    var showUnattributed = false;
    var unattributedTotal = entries.filter(function (e) { return !e.ifName; }).length;

    function portOf(e) {
      return e.ifName || ("base port " + (e.basePort != null ? e.basePort : "?"));
    }
    function matches(e, filter) {
      return _childFilterMatches([
        portOf(e),
        e.vlanId != null ? "vlan " + e.vlanId : "",
        e.vlanId != null ? (vlanNames[String(e.vlanId)] || "") : "", e.status || "",
        e.matchedAsset ? (e.matchedAsset.hostname || "") : "",
        e.matchedAsset ? (e.matchedAsset.ipAddress || "") : "",
      ], [e.macAddress], filter);
    }

    _childTabShell(mount, "childmactable", assetId, "Forwarding databases",
      "Filter by MAC, port, VLAN or hostname, or switch name, IP or model", switches,
      function (filter, bodyEl, countsEl, noteEl, rerender) {
        var pool = 0, shownTotal = 0;
        var rows = switches.map(function (sw) {
          var own = (bySw[sw.id] || []).filter(function (e) { return showUnattributed || !!e.ifName; });
          pool += own.length;
          var swHit = filter && _childFilterMatches([sw.hostname, sw.ipAddress, sw.serialNumber, sw.model], [], filter);
          var shown = (!filter || swHit) ? own : own.filter(function (e) { return matches(e, filter); });
          if (filter && !swHit && shown.length === 0) return "";
          shownTotal += shown.length;
          shown.sort(function (a, b) {
            var pa = portOf(a), pb = portOf(b);
            if (!!a.ifName !== !!b.ifName) return a.ifName ? -1 : 1;
            var c = pa.localeCompare(pb, undefined, { numeric: true, sensitivity: "base" });
            return c !== 0 ? c : String(a.macAddress).localeCompare(String(b.macAddress));
          });
          var ports = {};
          own.forEach(function (e) { if (e.ifName) ports[e.ifName] = true; });
          var portCount = Object.keys(ports).length;
          var head = _childGroupHeadHTML(sw,
            own.length + " MAC" + (own.length === 1 ? "" : "s") + " on " + portCount + " port" + (portCount === 1 ? "" : "s"), 5);
          if (shown.length === 0) {
            return head + '<tr class="childtab-entry" data-group="' + escapeHtml(sw.id) + '">' +
              '<td colspan="5" style="padding-left:1.4rem;color:var(--color-text-tertiary);font-size:0.78rem">' +
              (sw.monitored
                ? "No forwarding-database entries. This is collected over SNMP on the system-info cadence; a switch polled via its parent FortiGate reports none."
                : "Not monitored — enable monitoring on this switch to collect its forwarding database.") +
              '</td></tr>';
          }
          return head + shown.map(function (e, i) {
            var dev = e.matchedAsset
              ? '<a href="#" class="asset-link" data-asset-id="' + escapeHtml(e.matchedAsset.id) + '">' +
                  escapeHtml(e.matchedAsset.hostname || e.matchedAsset.ipAddress || e.matchedAsset.id) + '</a>'
              : dash;
            return '<tr class="childtab-entry" data-group="' + escapeHtml(sw.id) + '">' +
              '<td class="mono" style="padding-left:1.4rem;white-space:nowrap">' + _treeElbow(i === shown.length - 1) + escapeHtml(e.macAddress) + '</td>' +
              // The port's configured VLANs under its name, not a column of
              // their own: a sixth column squeezed Status and Device to a
              // letter per line in the panel's width.
              '<td><span class="mono" style="white-space:nowrap">' + escapeHtml(portOf(e)) + '</span>' +
                ((e.ifName && portVlans[sw.id] && portVlans[sw.id][e.ifName])
                  ? '<div style="margin-top:2px">' + _portVlansHTML(portVlans[sw.id][e.ifName], vlanNames) + '</div>'
                  : "") +
              '</td>' +
              '<td>' + (e.vlanId != null ? _vlanPillHTML(e.vlanId, vlanNames, e.vlanInferred === true) : dash) + '</td>' +
              '<td style="white-space:nowrap">' + escapeHtml(e.status) + '</td>' +
              '<td>' + dev + '</td>' +
            '</tr>';
          }).join("");
        }).join("");
        if (countsEl) {
          countsEl.textContent = '(' + shownTotal + (filter ? " of " + pool : "") + ' entries on ' +
            switches.length + ' switch' + (switches.length === 1 ? "" : "es") + ')';
        }
        if (noteEl) {
          noteEl.innerHTML = unattributedTotal === 0 ? "" :
            '<div style="margin:0 0 0.5rem;font-size:0.82rem;color:var(--color-text-secondary)">' +
              unattributedTotal + ' entr' + (unattributedTotal === 1 ? "y" : "ies") +
              ' on ports Polaris could not resolve (trunk / LAG pseudo-ports). ' +
              '<button type="button" class="mactable-toggle-link" id="childmactable-toggle-' + escapeHtml(assetId) + '">' +
                (showUnattributed ? "Hide" : "Show") +
              '</button>' +
            '</div>';
          var toggle = document.getElementById("childmactable-toggle-" + assetId);
          if (toggle) toggle.addEventListener("click", function () {
            showUnattributed = !showUnattributed;
            rerender();
          });
        }
        bodyEl.innerHTML = !rows
          ? '<div class="empty-state">No switches or entries match that filter.</div>'
          : '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
              '<th>Switch / MAC</th><th title="The port, and the native / tagged VLANs it is configured to carry">Port</th>' +
              '<th title="The VLAN the entry was learned in">VLAN</th><th style="white-space:nowrap">Status</th><th style="white-space:nowrap">Device</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
      });
  } catch (err) {
    mount.innerHTML = '<span class="empty-state">Error: ' + escapeHtml(err.message || "failed to load") + '</span>';
  }
}


// ─── ARP Table tab ─────────────────────────────────────────────────────────
//
// The FortiGate's layer-3 neighbour cache — the L3 sibling of the MAC Table
// tab. That one answers "what is plugged into port 7" from a switch's
// forwarding database; this one answers "what is at 10.4.12.63" from the
// router's own resolution of the address, which is the question an operator
// arrives with far more often. So unlike MAC Table this one leads with a
// filter box.
//
// The rows come from discovery, not the monitor cadence, and the whole table
// shares one collection timestamp — an ARP cache is only meaningful next to
// its age, so that timestamp is in the header rather than a column.

function _assetArpTableTabHTML(assetId) {
  return '<div id="asset-arptable-mount-' + escapeHtml(assetId) + '">' +
    '<span class="empty-state">Loading…</span></div>';
}

function _wireAssetArpTableTab(assetId) {
  var btn = document.querySelector('#asset-view-tabs .page-tab[data-tab="arptable"]');
  if (!btn) return;
  var loaded = false;
  btn.addEventListener("click", function () {
    if (loaded) return;
    loaded = true;
    _loadAssetArpTable(assetId, _assetArpRange[assetId] || "current");
  });
}

// "45s" / "12m" / "3h 04m". FortiOS reports the age in seconds; anything
// non-numeric is absent rather than zero, so it renders as a dash.
function _arpAgeLabel(sec) {
  return PolarisAssetShared.arpAgeLabel(sec);
}

// Shared pivot wiring for the `.asset-link` anchors the MAC Table and ARP
// Table tabs render. MAC Table emitted these from the day it shipped with
// nothing listening, so its Device column looked clickable and did nothing.
//
// Delegated from the container and bound once (CQ-F042): the three tables
// repaint their body on every keystroke in their filter box, and a core
// switch's table runs to thousands of rows. The named handler makes a second
// call on the same container a no-op, so callers wire it on every paint.
function _wireAssetPivotLinks(container) {
  if (!container) return;
  container.addEventListener("click", _handleAssetPivotClick);
}

function _handleAssetPivotClick(e) {
  var link = e.target && typeof e.target.closest === "function" ? e.target.closest(".asset-link") : null;
  if (!link || !e.currentTarget.contains(link)) return;
  e.preventDefault();
  var id = link.getAttribute("data-asset-id");
  if (id) openViewModal(id);
}

// The ▶ / ▼ group toggle of the MAC Table, ARP Table and managed-children
// tables: shows or hides its group's entry rows in place (so an open group
// survives a repaint of something above it). Delegated from the body the
// table is painted into, bound once per body (a data flag, since each table
// passes its own selectors); `opts` = { toggle, entry, expandTitle,
// collapseTitle }, `entry` being the entry-row class whose data-group the
// toggle's data-group names.
function _wireGroupToggles(container, opts) {
  if (!container || container.getAttribute("data-group-toggles-wired") === "1") return;
  container.setAttribute("data-group-toggles-wired", "1");
  container.addEventListener("click", function (e) {
    var tog = e.target && typeof e.target.closest === "function" ? e.target.closest(opts.toggle) : null;
    if (!tog || !container.contains(tog)) return;
    var key = tog.getAttribute("data-group");
    var expanded = tog.textContent.trim() === "▼";
    tog.textContent = expanded ? "▶" : "▼";
    tog.title = expanded ? opts.expandTitle : opts.collapseTitle;
    container.querySelectorAll(opts.entry + '[data-group="' + CSS.escape(key) + '"]')
      .forEach(function (row) { row.style.display = expanded ? "none" : ""; });
  });
}

// Per-asset tab state, keyed by asset id so switching devices in the panel
// history doesn't carry one gate's range or filter onto another.
var _assetArpRange  = {};
var _assetArpFilter = {};

// Range selector. "Current" is the last poll's answer; the rest ask what the
// device held at ANY point in the window, which the accumulate+age table can
// answer because a binding is one row with a lastSeen rather than one row per
// poll. Options past the configured retention are disabled rather than hidden,
// so an operator can see that 30 days exists and is simply not being kept.
var _ARP_RANGES = [
  { id: "current", label: "Current",      days: 0     },
  { id: "1h",      label: "Last hour",    days: 1 / 24 },
  { id: "12h",     label: "Last 12 hours", days: 0.5  },
  { id: "24h",     label: "Last 24 hours", days: 1    },
  { id: "7d",      label: "Last 7 days",  days: 7     },
  { id: "30d",     label: "Last 30 days", days: 30    },
];

// "every 10 minutes" / "every 12 hours" — the cadence sentence is the whole
// point of the disclaimer, so it reads in the units an operator thinks in.
function _arpCadenceLabel(sec) {
  if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return null;
  if (sec < 60)   return sec + " seconds";
  if (sec < 3600) {
    var m = Math.round(sec / 60);
    return m === 1 ? "minute" : m + " minutes";
  }
  var h = Math.round(sec / 3600);
  return h === 1 ? "hour" : h + " hours";
}

/**
 * One neighbour-cache entry's row menu. Pure: `h` is { openAsset(id),
 * copy(text, what) }. The entry opens the device it matched — what a click on
 * the address or a double click on the row does; an unmatched entry has
 * nothing to open, so its menu shows on either click.
 */
function _arpRowMenuItems(e, h) {
  var items = [];
  if (e.matchedAsset) {
    items.push({ label: "Open device", primary: true, onSelect: function () { h.openAsset(e.matchedAsset.id); } });
    items.push({ separator: true });
  }
  items.push({ label: "Copy IP address", onSelect: function () { h.copy(e.ipAddress, "IP address"); } });
  if (e.macAddress) items.push({ label: "Copy MAC address", onSelect: function () { h.copy(e.macAddress, "MAC address"); } });
  return items;
}

async function _loadAssetArpTable(assetId, range) {
  var mount = document.getElementById("asset-arptable-mount-" + assetId);
  if (!mount) return;
  var activeRange = range || _assetArpRange[assetId] || "current";
  _assetArpRange[assetId] = activeRange;
  try {
    var data = await api.assets.arpTable(assetId, activeRange);
    var entries = (data && data.entries) || [];
    var dash = '<span style="color:var(--color-text-secondary)">—</span>';
    var filter = _assetArpFilter[assetId] || "";
    var cadence = _arpCadenceLabel(data && data.pollIntervalSec);
    var retentionDays = (data && typeof data.retentionDays === "number") ? data.retentionDays : null;

    // Declared up here because the strip renders the counts slot and the strip
    // is also what the zero-entries branch below returns.
    var countsId = "arptable-counts-" + assetId;
    var bodyId   = "arptable-body-" + assetId;

    // Cadence · freshness · Refresh. `pollIntervalSec` is the server's walk and
    // is the only figure that can be right here: for an unmonitored gate the
    // writer is discovery, not the system-info pass, and the two are twelve
    // hours apart. Null means neither writes it — the stamp then says how old
    // the rows are without pretending anything is coming to replace them.
    var arpCadenceSec = (data && typeof data.pollIntervalSec === "number") ? data.pollIntervalSec : null;
    function arpStripHTML() {
      return _currentStateStripHTML({
        title: "Neighbour cache",
        suffixHTML: '<span id="' + countsId + '" style="font-weight:400;color:var(--color-text-secondary)"></span>',
        chipHTML: _cadenceChipHTML(arpCadenceSec, "How often this gate's neighbour cache is re-read"),
        lastAt: (data && data.collectedAt) || null,
        cadenceSec: arpCadenceSec,
        neverText: "never read",
        refreshId: "arptable-refresh-" + assetId,
        refreshTitle: "Re-read this gate's neighbour cache from the device now",
      });
    }
    function wireArpStrip() {
      _wireCurrentStateRefresh("arptable-refresh-" + assetId, assetId, function () {
        return _loadAssetArpTable(assetId, activeRange);
      });
    }

    // The disclaimer. Two separate facts, and the second is the one that
    // actually matters: a poll is a SNAPSHOT of a cache whose entries expire in
    // minutes, so anything that came and went between two polls was never
    // visible to Polaris at all. Without saying so, an absent device reads as
    // "it was never on the network", which is a stronger claim than the data
    // supports.
    function disclaimerHtml() {
      var when = cadence
        ? 'This device’s neighbour cache is read <strong>every ' + escapeHtml(cadence) + '</strong>.'
        : 'This device’s neighbour cache is only read when discovery runs.';
      var keep = retentionDays == null ? ""
        : retentionDays < 0 ? " Entries are kept indefinitely."
        : retentionDays === 0 ? " Entries are not retained."
        : " Entries are kept for " + retentionDays + " day" + (retentionDays === 1 ? "" : "s") + ".";
      return '<div class="empty-state" style="margin:0 0 0.6rem;padding:6px 9px;border-radius:4px;' +
        'background:var(--color-bg-primary);border:1px solid var(--color-border);font-size:0.78rem;' +
        'line-height:1.5;text-align:left">' +
        when + ' Each read is a snapshot, and a FortiGate ages entries out of its own cache in ' +
        'roughly 1–5 minutes — so <strong>short-lived entries can be missing entirely</strong>, ' +
        'and an address absent here was not necessarily absent from the network.' +
        keep +
        '</div>';
    }

    function rangeControlHtml() {
      var opts = _ARP_RANGES.map(function (r) {
        var beyond = retentionDays != null && retentionDays >= 0 && r.days > retentionDays;
        return '<option value="' + escapeHtml(r.id) + '"' +
          (r.id === activeRange ? " selected" : "") +
          (beyond ? " disabled" : "") + '>' +
          escapeHtml(r.label) + (beyond ? " (beyond retention)" : "") +
        '</option>';
      }).join("");
      return '<label style="display:inline-flex;align-items:center;gap:5px;font-size:0.82rem">' +
        'Show <select id="arptable-range-' + escapeHtml(assetId) + '" class="form-input" ' +
          'style="font-size:0.82rem;padding:2px 6px;width:auto">' + opts + '</select>' +
      '</label>';
    }

    if (entries.length === 0) {
      mount.innerHTML = arpStripHTML() +
        disclaimerHtml() +
        '<div style="margin:0 0 0.6rem">' + rangeControlHtml() + '</div>' +
        '<span class="empty-state">' +
          (activeRange === "current"
            ? 'No ARP entries. Either this device holds no neighbours, or Polaris has never had a successful read from it.'
            : 'No ARP entries seen in this window.') +
        '</span>';
      wireRange();
      wireArpStrip();
      return;
    }

    // Interface-first, matching the MAC Table tab: the interface is the
    // network segment, and an operator scanning for an address wants to see
    // which one it came back on.
    function groupsFrom(rows) {
      var byKey = {};
      rows.forEach(function (e) {
        var key = e.ifName || "(no interface reported)";
        (byKey[key] = byKey[key] || { key: key, resolved: !!e.ifName, entries: [] }).entries.push(e);
      });
      return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
        if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
        return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" });
      });
    }

    // Partial match across every identifying field, so one box answers
    // "what is at .63", "where is that MAC" and "which port is PRINTER-4 on" —
    // a MAC fragment matches with or without separators (_childFilterMatches,
    // shared with the gate's Wireless / MAC Table tabs).
    function matches(e) {
      return _childFilterMatches([
        e.ipAddress, e.ifName || "",
        e.matchedAsset ? (e.matchedAsset.hostname || "") : "",
        e.matchedAsset ? (e.matchedAsset.ipAddress || "") : "",
      ], [e.macAddress], filter);
    }

    // On a historical range the newest read is not "now", so every row carries
    // its own last-seen. On Current they are all the same instant and the
    // column would just repeat the header.
    var showLastSeen = activeRange !== "current";

    // The shell (heading + range control + filter box) is rendered ONCE and
    // only the counts span and the table below it re-render as the operator
    // types. Previously one `render()` rebuilt the whole panel — filter input
    // included — on every keystroke, which is why it had to save and restore
    // the caret by hand: re-creating the very element being typed into is what
    // makes that hack necessary. A core FortiGate's neighbour cache runs into
    // the thousands, so each keystroke also re-filtered, re-grouped,
    // re-sorted and re-attached a listener per group and per matched device.
    // (countsId / bodyId are declared above the zero-entries branch, which
    // renders the strip that owns the counts slot.)

    function countsHTML() {
      var shown = entries.filter(matches);
      var matched = shown.filter(function (e) { return !!e.matchedAsset; }).length;
      // The read stamp used to live here; it is now the strip's, where it can
      // go amber against the cadence stated beside it.
      return '(' +
        shown.length + (filter ? " of " + entries.length : "") + ' entr' +
        (shown.length === 1 ? "y" : "ies") + ' · ' + matched + ' matched to a known device' +
      ')';
    }

    function renderBody() {
      var groups = groupsFrom(entries.filter(matches));
      var counts = document.getElementById(countsId);
      if (counts) counts.innerHTML = countsHTML();
      var bodyEl = document.getElementById(bodyId);
      if (!bodyEl) return;
      bodyEl.innerHTML = groups.length === 0
        ? '<div class="empty-state">No entries match that filter.</div>'
        : '<div class="table-wrapper"><table class="data-table" style="font-size:0.82rem"><thead><tr>' +
            '<th>Interface / IP</th><th>MAC</th><th>Age</th>' +
            (showLastSeen ? '<th>Last seen</th>' : '') +
            '<th>Device</th>' +
          '</tr></thead><tbody>' + groups.map(groupHtml).join("") + '</tbody></table></div>';
      _wireGroupToggles(bodyEl, {
        toggle: ".arptable-group-toggle", entry: ".arptable-entry",
        expandTitle: "Expand entries", collapseTitle: "Collapse entries",
      });
      _wireAssetPivotLinks(bodyEl);
    }

    function render() {
      mount.innerHTML =
        arpStripHTML() +
        disclaimerHtml() +
        '<div style="display:flex;gap:0.6rem;align-items:center;flex-wrap:wrap;margin:0 0 0.5rem">' +
          rangeControlHtml() +
          '<input type="text" id="arptable-filter-' + escapeHtml(assetId) + '" class="form-input" ' +
            'placeholder="Filter by IP, MAC, interface or hostname" ' +
            'style="max-width:22rem;font-size:0.82rem;flex:1 1 14rem" value="' + escapeHtml(filter) + '">' +
        '</div>' +
        '<div id="' + bodyId + '"></div>';

      // Delegated, so it survives renderBody() rewriting the table per keystroke.
      var bodyEl = document.getElementById(bodyId);
      if (bodyEl) {
        bodyEl.addEventListener("click", function (ev) {
          var trig = ev.target && ev.target.closest ? ev.target.closest(".arptable-menu") : null;
          if (!trig) return;
          var entry = entries[parseInt(trig.getAttribute("data-idx"), 10)];
          if (!entry) return;
          showRowMenu(trig, _arpRowMenuItems(entry, {
            openAsset: function (id) { openViewModal(id); },
            copy: function (text, what) {
              copyTextToClipboard(text).then(function (ok) {
                showToast(ok ? what + " copied" : "Couldn't copy to the clipboard", ok ? "success" : "error");
              });
            },
          }), { label: "Actions for " + entry.ipAddress });
        });
      }

      var box = document.getElementById("arptable-filter-" + assetId);
      if (box) {
        // Debounced (the shared global from table-sf.js, as at ~14 other call
        // sites): the operator's keystrokes outrun a multi-thousand-row
        // re-group, and every intermediate prefix is a view nobody asked for.
        var apply = debounce(function () {
          filter = box.value.trim().toLowerCase();
          _assetArpFilter[assetId] = filter;
          renderBody();
        }, 150);
        box.addEventListener("input", apply);
      }
      wireRange();
      wireArpStrip();
      renderBody();
    }

    // Changing the range is a re-fetch, not a client-side filter: the window
    // is applied in SQL against an index, and a 30-day payload is not
    // something to ship on the chance the operator wants it.
    function wireRange() {
      var sel = document.getElementById("arptable-range-" + assetId);
      if (!sel) return;
      sel.addEventListener("change", function () {
        mount.innerHTML = '<span class="empty-state">Loading…</span>';
        _loadAssetArpTable(assetId, sel.value);
      });
    }

    function groupHtml(g) {
      var cols = showLastSeen ? 5 : 4;
      var head = '<tr class="arptable-group"><td colspan="' + cols + '" style="padding:5px 8px;font-weight:600;' +
        'background:var(--color-bg-primary);color:var(--color-text-secondary)">' +
        '<button type="button" class="arptable-group-toggle" data-group="' + escapeHtml(g.key) + '" ' +
          'style="background:none;border:none;cursor:pointer;color:var(--color-text-secondary);' +
          'padding:0 3px 0 0;font-size:0.75rem;vertical-align:middle;line-height:1" ' +
          'title="Collapse entries">&#9660;</button>' +
        '<span class="mono" style="color:var(--color-text-primary)">' + escapeHtml(g.key) + '</span> ' +
        '<span style="font-weight:400">&middot; ' + g.entries.length + ' address' +
          (g.entries.length === 1 ? "" : "es") + '</span>' +
        '</td></tr>';
      return head + g.entries.map(function (e, i) {
        return entryHtml(e, g.key, i === g.entries.length - 1);
      }).join("");
    }

    function entryHtml(e, groupKey, isLast) {
      var dev = e.matchedAsset
        ? '<a href="#" class="asset-link" data-asset-id="' + escapeHtml(e.matchedAsset.id) + '">' +
            escapeHtml(e.matchedAsset.hostname || e.matchedAsset.ipAddress || e.matchedAsset.id) + '</a>'
        : dash;
      var age = _arpAgeLabel(e.ageSec);
      // The address is the row's name (the standard row gestures): its menu
      // is _arpRowMenuItems, opened through the delegated listener in render().
      return '<tr class="arptable-entry" data-row-menu-row data-group="' + escapeHtml(groupKey) + '">' +
        '<td class="mono" style="padding-left:1.4rem">' +
          _treeElbow(isLast) +
          '<button type="button" class="row-menu-trigger arptable-menu" data-idx="' + entries.indexOf(e) + '" ' +
            'aria-haspopup="menu" aria-expanded="false">' + escapeHtml(e.ipAddress) + '</button>' +
        '</td>' +
        '<td class="mono">' + escapeHtml(e.macAddress) + '</td>' +
        '<td class="mono">' + (age ? escapeHtml(age) : dash) + '</td>' +
        (showLastSeen
          ? '<td title="' + escapeHtml(e.lastSeen || "") + '">' + (e.lastSeen ? escapeHtml(timeAgo(e.lastSeen)) : dash) + '</td>'
          : '') +
        '<td>' + dev + '</td>' +
      '</tr>';
    }

    render();
  } catch (err) {
    mount.innerHTML = '<span class="empty-state">Error: ' + escapeHtml(err.message || "failed to load") + '</span>';
  }
}

// ─── IPsec tab ─────────────────────────────────────────────────────────────
//
// A FortiGate's phase-1 tunnels and who is connected through them, from
// GET /assets/:id/ipsec. This tab is the ONE home of an IPsec tunnel: the
// System tab's Interfaces table leaves every IPsec tunnel (and its
// `tunnel`-typed interface twin) out and points here, so the Poll 1m pin and
// the per-tunnel history panel live on this tab too. Two sections:
//
//   Tunnels & peers — each phase-1 with its site peers (a hub's ADVPN spokes,
//                     a spoke's shortcuts, dial-up sites) nested beneath it,
//                     the elbow the ARP and Interfaces tables draw
//   Remote access   — FortiClient users on IPsec dial-up and on SSL-VPN
//
// Both tables sort + filter through TableSF, the control every list table
// carries, with the per-user state persisted. The tunnel table is the
// Interfaces table's two-mode render: the nested tree by default, flat the
// moment a sort or a filter is active (a peer's position then no longer says
// which tunnel it hangs off, so its second line does).
//
// Prefetched in openViewModal's wave, so the tab is present on a gate that
// reported anything and absent otherwise.

var _IPSEC_KIND_LABELS = {
  "advpn-spoke":    "ADVPN spoke",
  "advpn-shortcut": "ADVPN shortcut",
  "dialup-peer":    "Dial-up peer",
  "remote-access":  "FortiClient (IPsec)",
  "ssl-vpn":        "FortiClient (SSL-VPN)",
};

function _ipsecIsRemoteAccess(c) {
  return PolarisAssetShared.ipsecIsRemoteAccess(c);
}

function _ipsecTabEligible(payload) {
  return !!(payload && ((payload.tunnels && payload.tunnels.length) || (payload.connections && payload.connections.length)));
}

function _assetIpsecTabHTML(assetId) {
  return '<div id="asset-ipsec-mount-' + escapeHtml(assetId) + '">' +
    '<span class="empty-state">Loading…</span></div>';
}

// The asset each mounted tab renders for — Refresh re-renders from a fresh
// payload and the tunnel link opens the history panel against it.
var _assetIpsecAsset = {};

// "3d 04h" / "5h 12m" / "40m" — how long a connection has been up.
function _ipsecUptimeLabel(since) {
  return PolarisAssetShared.ipsecUptimeLabel(since);
}

// The monitor badges, so up / down read the way they do on every asset row.
// "dynamic" (a dial-up template, working as configured with nobody on it)
// takes the passive outline rather than a colour that implies a verdict.
function _ipsecStatusPill(status) {
  var kind = status === "up" ? "monitored"
           : status === "down" ? "monitor-down"
           : status === "dynamic" ? "monitor-passive"
           : "monitor-warning";
  return '<span class="badge badge-' + kind + '" style="white-space:nowrap">' + escapeHtml(status || "—") + '</span>';
}

/**
 * A Tunnels & peers row's menu (the standard row gestures — click the name or
 * double-click the row runs the primary item, right-click shows them all).
 * Pure: `tunnelNames` is the set of tunnels in this read, `h` the open
 * handlers ({ openTunnel(name), openAsset(id) }).
 *
 * A tunnel opens its own status + throughput panel, then its far end's device
 * when the remote gateway matched one. A peer has no panel of its own, so it
 * opens its device when matched, else the tunnel it hangs off; a peer with
 * neither gets no items, and its name renders as plain text.
 */
function _ipsecRowMenuItems(kind, raw, tunnelNames, h) {
  var items = [];
  var dev = raw.matchedAsset;
  if (kind === "tunnel") {
    items.push({ label: "Open tunnel", primary: true, onSelect: function () { h.openTunnel(raw.tunnelName); } });
    if (dev) items.push({ label: "Open device", onSelect: function () { h.openAsset(dev.id); } });
    return items;
  }
  if (dev) items.push({ label: "Open device", primary: true, onSelect: function () { h.openAsset(dev.id); } });
  if (raw.parentTunnel && tunnelNames[raw.parentTunnel]) {
    items.push({ label: "Open tunnel " + raw.parentTunnel, primary: !dev, onSelect: function () { h.openTunnel(raw.parentTunnel); } });
  }
  return items;
}

async function _reloadAssetIpsec(assetId) {
  try {
    _renderAssetIpsec(assetId, await api.assets.ipsec(assetId), _assetIpsecAsset[assetId]);
  } catch (err) {
    var mount = document.getElementById("asset-ipsec-mount-" + assetId);
    if (mount) mount.innerHTML = '<span class="empty-state">Error: ' + escapeHtml((err && err.message) || "failed to load") + '</span>';
  }
}

/**
 * Pin / unpin a tunnel for the per-minute cadence. A tunnel can be pinned two
 * ways: as an IPsec tunnel (`monitoredIpsecTunnels` — SA status + bytes, what
 * an IPsec automation reads) and through its interface twin
 * (`monitoredInterfaces`). The box is checked when either holds; checking it
 * adds the IPsec pin, clearing it removes BOTH — the twin is no longer listed
 * anywhere else, so a pin left on it would keep polling with nothing on
 * screen saying so. Reads the asset fresh before the PUT: the two arrays are
 * replaced wholesale, and the System tab can have changed interface pins
 * since this payload loaded.
 */
async function _setIpsecTunnelPin(assetId, tunnelName, on) {
  var cur = await api.assets.get(assetId);
  var tunnels = new Set(cur.monitoredIpsecTunnels || []);
  var ifaces  = new Set(cur.monitoredInterfaces || []);
  var patch = {};
  if (on) {
    tunnels.add(tunnelName);
    patch.monitoredIpsecTunnels = Array.from(tunnels);
  } else {
    tunnels.delete(tunnelName);
    patch.monitoredIpsecTunnels = Array.from(tunnels);
    if (ifaces.has(tunnelName)) {
      ifaces.delete(tunnelName);
      patch.monitoredInterfaces = Array.from(ifaces);
    }
  }
  await api.assets.update(assetId, patch);
  var a = _assetIpsecAsset[assetId];
  if (a) {
    a.monitoredIpsecTunnels = patch.monitoredIpsecTunnels;
    if (patch.monitoredInterfaces) a.monitoredInterfaces = patch.monitoredInterfaces;
  }
}

function _renderAssetIpsec(assetId, data, asset) {
  var mount = document.getElementById("asset-ipsec-mount-" + assetId);
  if (!mount) return;
  if (asset) _assetIpsecAsset[assetId] = asset;
  asset = _assetIpsecAsset[assetId] || { id: assetId };
  var dash = '<span style="color:var(--color-text-secondary)">—</span>';
  var tunnels = (data && data.tunnels) || [];
  var connections = (data && data.connections) || [];
  var sitePeers = connections.filter(function (c) { return !_ipsecIsRemoteAccess(c); });
  var users = connections.filter(_ipsecIsRemoteAccess);
  var cadenceSec = (data && typeof data.pollIntervalSec === "number") ? data.pollIntervalSec : null;
  var canEdit = typeof canManageAssets === "function" && canManageAssets();
  var refreshId = "ipsec-refresh-" + assetId;
  var tunTbodyId = "ipsec-tunnels-tbody-" + assetId;
  var userTbodyId = "ipsec-users-tbody-" + assetId;
  var TUN_COLS = 9;
  var USER_COLS = 8;

  function monoOrDash(v) { return v && v !== "0.0.0.0" ? '<span class="mono" style="white-space:nowrap">' + escapeHtml(v) + '</span>' : dash; }
  function bytesCell(n) { return '<td class="mono" style="white-space:nowrap">' + _fmtBytes(n) + '</td>'; }
  function uptimeSec(c) { return c.connectedSince ? Math.max(0, (Date.now() - new Date(c.connectedSince).getTime()) / 1000) : null; }
  function uptimeCell(c) {
    var up = _ipsecUptimeLabel(c.connectedSince);
    return up ? '<span style="white-space:nowrap" title="' + escapeHtml(formatDateTime(c.connectedSince)) + '">' + escapeHtml(up) + '</span>' : dash;
  }
  // The row's kind, as a quiet second line under its name — a column of its
  // own cost the addresses their width in a slide-over.
  function subLine(text) {
    return '<div style="font-family:var(--font-sans, inherit);font-size:0.72rem;font-weight:400;color:var(--color-text-secondary);white-space:nowrap">' + text + '</div>';
  }
  function deviceText(c) {
    return c.matchedAsset ? (c.matchedAsset.hostname || c.matchedAsset.ipAddress || "") : (c.peerId || "");
  }
  function deviceCell(c) {
    if (c.matchedAsset) {
      return '<a href="#" class="asset-link" style="white-space:nowrap" data-asset-id="' + escapeHtml(c.matchedAsset.id) + '"' +
        (c.peerId ? ' title="IKE peer ID: ' + escapeHtml(c.peerId) + '"' : '') + '>' +
        escapeHtml(c.matchedAsset.hostname || c.matchedAsset.ipAddress || c.matchedAsset.id) + '</a>';
    }
    // The IKE identity is the next best name for a site the inventory
    // doesn't hold — it is what the spoke calls itself.
    return c.peerId ? '<span class="mono" style="white-space:nowrap" title="IKE peer ID — no known asset at this address">' + escapeHtml(c.peerId) + '</span>' : dash;
  }

  // ── Tunnels & peers: row model ──
  // Children keyed to their template; a child whose template is not in the
  // tunnel batch (that pass's tunnel read failed) still gets a group.
  var byParent = {};
  sitePeers.forEach(function (c) {
    var k = c.parentTunnel || "";
    (byParent[k] = byParent[k] || []).push(c);
  });
  // FortiClient users hang off a dial-up template too, but are listed under
  // Remote access rather than nested here — a template's "N connected" still
  // counts them, or a remote-access template always read 0.
  var usersByParent = {};
  users.forEach(function (c) {
    if (c.parentTunnel) usersByParent[c.parentTunnel] = (usersByParent[c.parentTunnel] || 0) + 1;
  });
  var tunnelNames = {};
  tunnels.forEach(function (t) { tunnelNames[t.tunnelName] = true; });
  var orphanParents = Object.keys(byParent).filter(function (k) { return !tunnelNames[k]; }).sort();

  // A dial-up template with peers nested under it collapses, and starts
  // collapsed: a hub's ADVPN template can carry hundreds of spokes. So the
  // persisted set is the OPENED templates (its own scope — the helper's sets
  // are otherwise collapsed names), per user per asset.
  var opened = _getCollapsedIfaces(assetId, "ipsec-open");
  function isCollapsible(t) { return t.status === "dynamic" && (byParent[t.tunnelName] || []).length > 0; }
  var collapsibleNames = {};
  tunnels.forEach(function (t) { if (isCollapsible(t)) collapsibleNames[t.tunnelName] = true; });

  function tunnelKind(t) { return t.status === "dynamic" ? "Dial-up template" : "Site-to-site"; }

  // Field names double as the columns' data-sf-key. `name` is an ARRAY so one
  // box finds a row by its name, its kind, the peer's IKE id or the parent
  // tunnel (TableSF joins array values for matching and sorting).
  function tunnelEntry(t) {
    var kids = byParent[t.tunnelName] || [];
    return {
      kind: "tunnel", raw: t, kids: kids.length,
      connected: kids.length + (usersByParent[t.tunnelName] || 0),
      name: [t.tunnelName, tunnelKind(t)],
      status: t.status || "",
      gw: t.remoteGateway && t.remoteGateway !== "0.0.0.0" ? t.remoteGateway : "",
      via: [t.parentInterface, t.overlayIp].filter(Boolean),
      device: t.matchedAsset ? (t.matchedAsset.hostname || t.matchedAsset.ipAddress || "") : "",
      up: null,
      "in": t.incomingBytes, out: t.outgoingBytes,
    };
  }
  function peerEntry(c, isLast) {
    return {
      kind: "peer", raw: c, isLast: isLast,
      name: [c.name, _IPSEC_KIND_LABELS[c.kind] || c.kind, c.parentTunnel || "", c.peerId || ""],
      status: c.status || "",
      gw: c.remoteGateway || "",
      via: c.tunnelIp || "",
      device: deviceText(c),
      up: uptimeSec(c),
      "in": c.incomingBytes, out: c.outgoingBytes,
    };
  }
  var tunEntries = [];
  function pushKids(list) { list.forEach(function (c, i) { tunEntries.push(peerEntry(c, i === list.length - 1)); }); }
  tunnels.forEach(function (t) { tunEntries.push(tunnelEntry(t)); pushKids(byParent[t.tunnelName] || []); });
  orphanParents.forEach(function (k) {
    tunEntries.push({ kind: "group", name: [k || "(no tunnel reported)"] });
    pushKids(byParent[k]);
  });

  function pinCell(t) {
    var on = !!(t.pinned || t.interfacePinned);
    var title = t.interfacePinned && !t.pinned
      ? "The tunnel's interface is polled every minute. Clear to stop it."
      : t.interfacePinned
        ? "Polled every minute, as an IPsec tunnel and through its interface. Clear to stop both."
        : "Poll this tunnel every minute and keep its history (what an IPsec tunnel automation reads)";
    return '<td style="text-align:center;width:1%"><input type="checkbox" class="asset-ipsec-pin" data-name="' + escapeHtml(t.tunnelName) + '"' +
      (on ? " checked" : "") + (canEdit ? "" : " disabled") + ' title="' + escapeHtml(title) + '"></td>';
  }

  function tunnelRowHTML(e, tree) {
    var t = e.raw;
    var kindText = t.status === "dynamic"
      ? "Dial-up template &middot; " + e.connected + " connected"
      : "Site-to-site";
    var via = t.overlayIp
      ? monoOrDash(t.parentInterface) + '<div class="mono" style="font-size:0.72rem;color:var(--color-text-secondary);white-space:nowrap" title="Tunnel interface address">' + escapeHtml(t.overlayIp) + '</div>'
      : monoOrDash(t.parentInterface);
    // The toggle only in the tree view — flat (sorted / filtered) rows have
    // no children under them to hide.
    var toggle = "";
    if (tree && isCollapsible(t)) {
      var isOpen = opened.has(t.tunnelName);
      toggle = '<button type="button" class="ipsec-expand-toggle" data-parent="' + escapeHtml(t.tunnelName) + '" style="background:none;border:none;cursor:pointer;color:var(--color-text-secondary);padding:0 3px 0 0;font-size:0.75rem;vertical-align:middle;line-height:1" title="' +
        (isOpen ? "Collapse peers" : "Expand peers") + '">' + (isOpen ? "▼" : "▶") + '</button>';
    }
    return '<tr class="ipsec-tunnel" data-row-menu-row>' +
      pinCell(t) +
      '<td class="mono" style="font-weight:600;white-space:nowrap">' + toggle +
        '<button type="button" class="row-menu-trigger asset-ipsec-menu" data-kind="tunnel" data-name="' + escapeHtml(t.tunnelName) + '" ' +
          'aria-haspopup="menu" aria-expanded="false" title="Open this tunnel\'s status and throughput history">' +
          escapeHtml(t.tunnelName) + '</button>' + subLine(kindText) + '</td>' +
      '<td>' + _ipsecStatusPill(t.status) + '</td>' +
      '<td>' + monoOrDash(t.remoteGateway) + '</td>' +
      '<td>' + via + '</td>' +
      // A site-to-site tunnel's far end, matched by its remote gateway.
      '<td>' + deviceCell({ matchedAsset: t.matchedAsset, peerId: null }) + '</td>' +
      '<td>' + dash + '</td>' +
      bytesCell(t.incomingBytes) + bytesCell(t.outgoingBytes) +
    '</tr>';
  }

  function peerRowHTML(e, flat) {
    var c = e.raw;
    var kind = escapeHtml(_IPSEC_KIND_LABELS[c.kind] || c.kind);
    // The peer's name opens its device, else the tunnel it hangs off; with
    // neither there is nothing to open and the name stays plain text.
    var hasMenu = _ipsecRowMenuItems("peer", c, tunnelNames, {}).length > 0;
    var peerName = hasMenu
      ? '<button type="button" class="row-menu-trigger asset-ipsec-menu" data-kind="peer" data-peer="' + sitePeers.indexOf(c) + '" ' +
          'aria-haspopup="menu" aria-expanded="false">' + escapeHtml(c.name) + '</button>'
      : escapeHtml(c.name);
    // Flat (sorted / filtered): no parent row above it, so the second line
    // names the tunnel it hangs off.
    var nameCell = flat
      ? '<td class="mono" style="white-space:nowrap">' + peerName +
          subLine(kind + (c.parentTunnel ? ' &middot; via ' + escapeHtml(c.parentTunnel) : '')) + '</td>'
      : '<td class="mono" style="padding-left:1.4rem;white-space:nowrap">' + _treeElbow(e.isLast) + peerName +
          '<div style="padding-left:1.55rem">' + subLine(kind) + '</div></td>';
    // In the tree, a peer names its template so the toggle can find it, and
    // ships hidden while that template is collapsed.
    var rowAttrs = hasMenu ? " data-row-menu-row" : "";
    if (!flat && c.parentTunnel) {
      rowAttrs += ' data-parent="' + escapeHtml(c.parentTunnel) + '"';
      if (collapsibleNames[c.parentTunnel] && !opened.has(c.parentTunnel)) rowAttrs += ' style="display:none"';
    }
    return '<tr class="ipsec-peer"' + rowAttrs + '>' +
      '<td style="width:1%" title="Peers come and go with traffic — pin the tunnel they hang off"></td>' +
      nameCell +
      '<td>' + _ipsecStatusPill(c.status) + '</td>' +
      '<td>' + monoOrDash(c.remoteGateway) + '</td>' +
      '<td>' + monoOrDash(c.tunnelIp) + '</td>' +
      '<td>' + deviceCell(c) + '</td>' +
      '<td>' + uptimeCell(c) + '</td>' +
      bytesCell(c.incomingBytes) + bytesCell(c.outgoingBytes) +
    '</tr>';
  }

  function groupRowHTML(e) {
    return '<tr class="ipsec-tunnel"><td></td><td class="mono" style="font-weight:600" colspan="' + (TUN_COLS - 1) + '">' +
      escapeHtml(e.name[0]) + subLine("tunnel not in the last read") + '</td></tr>';
  }

  // ── Remote access: row model ──
  var userEntries = users.map(function (c) {
    return {
      raw: c,
      user: [c.userName || c.peerId || ""],
      type: _IPSEC_KIND_LABELS[c.kind] || c.kind,
      tunnel: c.parentTunnel || "",
      gw: c.remoteGateway || "",
      assigned: c.tunnelIp || "",
      up: uptimeSec(c),
      "in": c.incomingBytes, out: c.outgoingBytes,
    };
  }).sort(function (x, y) {
    return String(x.user[0]).localeCompare(String(y.user[0]), undefined, { sensitivity: "base" });
  });

  function userRowHTML(e) {
    var c = e.raw;
    var who = c.userName || c.peerId;
    return '<tr>' +
      '<td>' + (who ? escapeHtml(who) : dash) + '</td>' +
      '<td style="white-space:nowrap">' + escapeHtml(e.type) + '</td>' +
      '<td>' + monoOrDash(c.parentTunnel) + '</td>' +
      '<td>' + monoOrDash(c.remoteGateway) + '</td>' +
      '<td>' + monoOrDash(c.tunnelIp) + '</td>' +
      '<td>' + uptimeCell(c) + '</td>' +
      bytesCell(c.incomingBytes) + bytesCell(c.outgoingBytes) +
    '</tr>';
  }

  // ── shell ──
  var counts = tunnels.length + ' tunnel' + (tunnels.length === 1 ? "" : "s") +
    ' · ' + sitePeers.length + ' site peer' + (sitePeers.length === 1 ? "" : "s") +
    ' · ' + users.length + ' remote user' + (users.length === 1 ? "" : "s");

  var tunTable = tunEntries.length
    ? '<div class="table-wrapper"><table class="data-table" id="ipsec-tunnels-table-' + escapeHtml(assetId) + '" style="font-size:0.82rem"><thead><tr>' +
        '<th style="width:1%;white-space:nowrap" data-col-id="poll" data-col-required="true" title="Poll 1m — fast-cadence polling + history for the tunnel">1m</th>' +
        '<th data-col-id="name" data-col-required="true" data-sf-key="name" data-sf-type="string">Tunnel / peer</th>' +
        '<th data-col-id="status" data-sf-key="status" data-sf-options="">Status</th>' +
        '<th data-col-id="gw" data-sf-key="gw" data-sf-type="ip">Remote gateway</th>' +
        '<th data-col-id="via" data-sf-key="via" data-sf-type="string" title="Tunnels: the interface it rides, and its own address. Peers: the overlay or assigned address inside the tunnel">Via / tunnel IP</th>' +
        '<th data-col-id="device" data-sf-key="device" data-sf-type="string" style="white-space:nowrap">Device</th>' +
        '<th data-col-id="up" data-sf-key="up" data-sf-type="number" data-sf-nofilter>Up</th>' +
        '<th data-col-id="in" data-sf-key="in" data-sf-type="number" data-sf-nofilter>In</th>' +
        '<th data-col-id="out" data-sf-key="out" data-sf-type="number" data-sf-nofilter>Out</th>' +
      '</tr></thead><tbody id="' + tunTbodyId + '"></tbody></table></div>'
    : '<span class="empty-state">No IPsec tunnels reported.</span>';

  var userTable = users.length
    ? '<div class="table-wrapper"><table class="data-table" id="ipsec-users-table-' + escapeHtml(assetId) + '" style="font-size:0.82rem"><thead><tr>' +
        '<th data-col-id="user" data-col-required="true" data-sf-key="user" data-sf-type="string">User</th>' +
        '<th data-col-id="type" data-sf-key="type" data-sf-options="">Type</th>' +
        '<th data-col-id="tunnel" data-sf-key="tunnel" data-sf-options="">Tunnel</th>' +
        '<th data-col-id="gw" data-sf-key="gw" data-sf-type="ip">Remote address</th>' +
        '<th data-col-id="assigned" data-sf-key="assigned" data-sf-type="ip">Assigned IP</th>' +
        '<th data-col-id="up" data-sf-key="up" data-sf-type="number" data-sf-nofilter>Up</th>' +
        '<th data-col-id="in" data-sf-key="in" data-sf-type="number" data-sf-nofilter>In</th>' +
        '<th data-col-id="out" data-sf-key="out" data-sf-type="number" data-sf-nofilter>Out</th>' +
      '</tr></thead><tbody id="' + userTbodyId + '"></tbody></table></div>'
    : '<span class="empty-state">No FortiClient users connected at the last read.</span>';

  mount.innerHTML =
    _currentStateStripHTML({
      title: "IPsec",
      suffixHTML: '<span style="font-weight:400;color:var(--color-text-secondary)">(' + escapeHtml(counts) + ')</span>',
      chipHTML: _cadenceChipHTML(cadenceSec, "How often this gate's tunnels and connected peers are re-read"),
      lastAt: (data && data.collectedAt) || null,
      cadenceSec: cadenceSec,
      neverText: "never read",
      refreshId: refreshId,
      refreshTitle: "Re-read this gate's tunnels and connected peers from the device now",
    }) +
    // Same reason the ARP tab carries one: the table is a snapshot, and an
    // absent shortcut or user reads as a claim the data cannot support.
    '<div class="empty-state" style="margin:0 0 0.6rem;padding:6px 9px;border-radius:4px;' +
      'background:var(--color-bg-primary);border:1px solid var(--color-border);font-size:0.78rem;' +
      'line-height:1.5;text-align:left">' +
      'Each read is a snapshot of who is connected at that moment. ADVPN shortcuts form on demand and ' +
      'tear down when idle, and remote users come and go — <strong>a peer missing here may simply not ' +
      'have been connected when the gate was last read.</strong> <strong>Poll&nbsp;1m</strong> polls a ' +
      'tunnel every minute and keeps its history; click a tunnel for its charts.' +
    '</div>' +
    '<h4 style="margin:0.4rem 0 0.4rem">Tunnels &amp; peers</h4>' +
    tunTable +
    '<h4 style="margin:1.1rem 0 0.4rem">Remote access</h4>' +
    userTable;

  // ── tunnel table: TableSF + two-mode render ──
  var tunSf = null;
  function renderTunnels() {
    var tbody = document.getElementById(tunTbodyId);
    if (!tbody) return;
    var st = tunSf ? tunSf.getPrefs() : null;
    var active = !!(st && (st.sortKey || Object.keys(st.sfFilters || {}).length > 0));
    if (!active) {
      tbody.innerHTML = tunEntries.map(function (e) {
        return e.kind === "tunnel" ? tunnelRowHTML(e, true) : e.kind === "group" ? groupRowHTML(e) : peerRowHTML(e, false);
      }).join("");
      return;
    }
    var list = tunSf.apply(tunEntries.filter(function (e) { return e.kind !== "group"; }));
    tbody.innerHTML = list.length === 0
      ? '<tr><td colspan="' + TUN_COLS + '" class="empty-state">No tunnels or peers match the current filters.</td></tr>'
      : list.map(function (e) { return e.kind === "tunnel" ? tunnelRowHTML(e, false) : peerRowHTML(e, true); }).join("");
  }
  var userSf = null;
  function renderUsers() {
    var tbody = document.getElementById(userTbodyId);
    if (!tbody) return;
    var list = userSf ? userSf.apply(userEntries) : userEntries;
    tbody.innerHTML = list.length === 0
      ? '<tr><td colspan="' + USER_COLS + '" class="empty-state">No users match the current filters.</td></tr>'
      : list.map(userRowHTML).join("");
  }

  // Sort + filter persist per user (one key per table, not per gate — what an
  // operator sorts a tunnel table by is a habit, not a fact about one hub),
  // and are restored minus filters on columns that are not there.
  function setupSf(tbodyId, prefsKey, entries, optionKeys, render) {
    if (typeof TableSF === "undefined" || !document.getElementById(tbodyId)) return null;
    var sf = new TableSF(tbodyId, function () {
      if (typeof PolarisPrefs !== "undefined") PolarisPrefs.save(prefsKey, currentUsername, sf.getPrefs());
      render();
    });
    sf.addClearButton();
    optionKeys.forEach(function (k) {
      sf.setColumnOptions(k, _distinctSorted(entries.map(function (e) { return e[k]; })));
    });
    var saved = typeof PolarisPrefs !== "undefined" ? PolarisPrefs.load(prefsKey, currentUsername) : null;
    if (saved) sf.applyState({ sortKey: saved.sortKey, sortDir: saved.sortDir, sfFilters: saved.sfFilters || {} });
    return sf;
  }
  tunSf = setupSf(tunTbodyId, "asset-ipsec-tunnels", tunEntries.filter(function (e) { return e.kind !== "group"; }), ["status"], renderTunnels);
  userSf = setupSf(userTbodyId, "asset-ipsec-users", userEntries, ["type", "tunnel"], renderUsers);
  renderTunnels();
  renderUsers();
  if (typeof applyTableLayout === "function") {
    var tt = document.getElementById("ipsec-tunnels-table-" + assetId);
    if (tt) applyTableLayout(tt, "asset-ipsec-tunnels", { onScreenshot: function (t) { _screenshotTableEl(t, "IPsec tunnels", { hiddenNoun: "row" }); } });
    var ut = document.getElementById("ipsec-users-table-" + assetId);
    if (ut) applyTableLayout(ut, "asset-ipsec-users", { onScreenshot: function (t) { _screenshotTableEl(t, "Remote access", { hiddenNoun: "user" }); } });
  }

  // ── wiring — delegated, since a sort or filter rewrites the tbody ──
  var tunBody = document.getElementById(tunTbodyId);
  if (tunBody) {
    tunBody.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      // Expand / collapse a dial-up template's peers (tree view only).
      var tog = t.closest(".ipsec-expand-toggle");
      if (tog) {
        ev.stopPropagation();
        var parentName = tog.getAttribute("data-parent");
        var isOpen = tog.textContent.trim() === "▼";
        tog.textContent = isOpen ? "▶" : "▼";
        tog.title = isOpen ? "Expand peers" : "Collapse peers";
        tunBody.querySelectorAll("tr.ipsec-peer").forEach(function (row) {
          if (row.getAttribute("data-parent") !== parentName) return;
          row.style.display = isOpen ? "none" : "";
        });
        if (isOpen) opened.delete(parentName); else opened.add(parentName);
        _setCollapsedIfaces(assetId, opened, "ipsec-open");
        return;
      }
      // The row's name: a menu whose primary verb a plain click runs.
      var trig = t.closest(".asset-ipsec-menu");
      if (trig) {
        var isTunnel = trig.getAttribute("data-kind") === "tunnel";
        var raw = isTunnel
          ? tunnels.find(function (x) { return x.tunnelName === trig.getAttribute("data-name"); })
          : sitePeers[parseInt(trig.getAttribute("data-peer"), 10)];
        if (!raw) return;
        showRowMenu(trig, _ipsecRowMenuItems(isTunnel ? "tunnel" : "peer", raw, tunnelNames, {
          openTunnel: function (name) { openIpsecTunnelDetailPanel(asset, name); },
          openAsset: function (id) { openViewModal(id); },
        }), { label: "Actions for " + (isTunnel ? raw.tunnelName : raw.name) });
        return;
      }
      // The peer's asset — delegated rather than _wireAssetPivotLinks'
      // per-element binding, which a re-render would drop.
      var pivot = t.closest(".asset-link");
      if (pivot) {
        ev.preventDefault();
        var id = pivot.getAttribute("data-asset-id");
        if (id) openViewModal(id);
      }
    });
    tunBody.addEventListener("change", async function (ev) {
      var cb = ev.target;
      if (!cb || !cb.classList || !cb.classList.contains("asset-ipsec-pin") || !canEdit) return;
      var name = cb.getAttribute("data-name");
      var on = cb.checked;
      cb.disabled = true;
      try {
        await _setIpsecTunnelPin(assetId, name, on);
        tunnels.forEach(function (t) {
          if (t.tunnelName !== name) return;
          t.pinned = on;
          if (!on) t.interfacePinned = false;
        });
        showToast(on ? ("Polling " + name + " every minute") : ("Stopped fast-polling " + name));
      } catch (err) {
        cb.checked = !on;
        showToast((err && err.message) || "Failed to update", "error");
      } finally {
        cb.disabled = false;
      }
    });
  }
  _wireCurrentStateRefresh(refreshId, assetId, function () { return _reloadAssetIpsec(assetId); });
}

// ─── Asset slide-over → Paths tab ───────────────────────────────────
//
// Agent-run path checks this host runs (path-checks.js owns
// the definitions). Prefetched in openViewModal's wave so the tab never
// appears and then vanishes. One check is "selected" at a time; its charts,
// latest result and traceroute render below the summary table.
//
// A result describes the PATH from this host (business rule 85): nothing here
// says anything about the host's own Up / Down.
//
// The same renderer draws a check's POLARIS SERVER source (Path Monitor →
// Results → the "Polaris server" row, renderServerPathDetail below): the
// subject id is then _PATH_SERVER_SUBJECT and _pathApi routes the two reads to
// /path-checks/:id/server/*. The server raises no automation alerts, so its
// latency chart draws no severity bands. The latency line follows the
// canonical two-colour failure treatment (a failed run dives to the baseline
// in red), NOT the five-verdict palette the response-time chart alone uses; no
// DATA series is red or grey.

var _pathTabState = null;
var _PATH_PHASES = [
  { key: "latencyMs", label: "Total", color: "#4f9dde" },
  { key: "dnsMs",     label: "DNS",     color: "#9b7ede" },
  { key: "connectMs", label: "Connect", color: "#e0a84f" },
  { key: "tlsMs",     label: "TLS",     color: "#5bc0be" },
  { key: "ttfbMs",    label: "TTFB",    color: "#c77dba" },
];
var _PATH_KIND_LABELS = { http: "HTTP", https: "HTTPS", tcp: "TCP", icmp: "ICMP" };
/** Mirrors pathCheckService.POLARIS_SERVER_SUBJECT. */
var _PATH_SERVER_SUBJECT = "polaris-server";

/** Pure: the two per-source reads for an asset id, or for the server. */
function _pathApi(subjectId) {
  if (subjectId === _PATH_SERVER_SUBJECT) {
    return {
      history: function (checkId, opts) { return api.pathChecks.serverHistory(checkId, opts); },
      traceroutes: function (checkId, limit) { return api.pathChecks.serverTraceroutes(checkId, limit); },
    };
  }
  return {
    history: function (checkId, opts) { return api.assets.pathCheckHistory(subjectId, checkId, opts); },
    traceroutes: function (checkId, limit) { return api.assets.pathCheckTraceroutes(subjectId, checkId, limit); },
  };
}

/**
 * Draw one check's SERVER source into `mount` — the charts, latest result and
 * path graph of the slide-over's Paths tab, for the source that has no
 * slide-over. `payload` is GET /path-checks/:id/server ({checks: [...]}).
 */
function renderServerPathDetail(mount, payload) {
  var checks = (payload && payload.checks) || [];
  if (!checks.length) {
    mount.innerHTML = '<p class="hint">This check does not run on the Polaris server.</p>';
    return;
  }
  mount.innerHTML = '<div id="path-detail"></div>';
  var server = { id: _PATH_SERVER_SUBJECT, hostname: "Polaris server" };
  _pathTabState = { assetId: server.id, checks: checks, checkId: checks[0].id, hiddenPhases: _pathLoadHiddenPhases() };
  _pathSelectCheck(server, checks[0].id);
}

/** Pure: does this host get a Paths tab? */
function _pathTabEligible(payload) {
  return !!(payload && Array.isArray(payload.checks) && payload.checks.length);
}

function _pathResultPill(latest) {
  if (!latest || !latest.lastSampleAt || latest.lastOk === null || latest.lastOk === undefined) {
    return '<span style="color:var(--color-text-tertiary)">no result yet</span>';
  }
  // A failed run that still got an HTTP answer reads "Unexpected response",
  // the same three words as the Path Monitor page (path-checks.js resultState).
  if (!latest.lastOk && latest.lastHttpStatus != null) {
    return '<span class="badge" style="background:#e07b00;color:#fff">Unexpected response</span>';
  }
  return '<span class="badge" style="background:' + (latest.lastOk ? MONITOR_STATE_COLORS.up : MONITOR_STATE_COLORS.down) + ';color:#fff">' +
    (latest.lastOk ? "OK" : "Fail") + "</span>";
}

function _pathFmtWhen(v) {
  if (!v) return "—";
  var d = new Date(v);
  return isNaN(d.getTime()) ? "—" : _fmtTooltipTs(d.toISOString());
}

function _assetPathCheckTabHTML(a, payload) {
  var checks = (payload && payload.checks) || [];
  var rows = checks.map(function (c, i) {
    var l = c.latest || {};
    return '<tr class="path-check-row' + (i === 0 ? " row-panel-active" : "") + '" data-check-id="' + escapeHtml(c.id) + '" style="cursor:pointer">' +
      "<td>" + escapeHtml(c.name) + (c.enabled ? "" : ' <span class="hint">(disabled)</span>') + "</td>" +
      '<td><span class="badge">' + escapeHtml(_PATH_KIND_LABELS[c.kind] || c.kind) + "</span></td>" +
      '<td style="font-family:var(--font-mono,monospace);font-size:0.8rem" title="' + escapeHtml(c.target) + '">' + escapeHtml(c.target) + "</td>" +
      "<td>" + _pathResultPill(l) + "</td>" +
      "<td>" + (l.lastLatencyMs != null ? Math.round(l.lastLatencyMs) + " ms" : "—") + "</td>" +
      "<td>" + escapeHtml(_pathFmtWhen(l.lastSampleAt)) + "</td>" +
      "</tr>";
  }).join("");
  var manage = (typeof permAtLeast === "function" && permAtLeast("pathChecks", "read"))
    ? '<a href="/path-monitor.html" class="btn btn-sm btn-secondary">Manage checks</a>' : "";
  return '<div data-shot-section="pathChecks">' +
      '<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem">' +
        '<p class="hint" style="margin:0">Checks the Polaris Agent on this host runs. They describe the path from this host — never its own Up / Down.</p>' +
        '<span style="margin-left:auto">' + manage + "</span></div>" +
      '<div class="table-wrapper"><table><thead><tr><th>Check</th><th style="width:70px">Kind</th><th>Target</th><th style="width:110px">Result</th><th style="width:80px">Latency</th><th style="width:140px">Last result</th></tr></thead>' +
        "<tbody>" + rows + "</tbody></table></div>" +
    "</div>" +
    '<div id="path-detail" style="margin-top:1.25rem"></div>';
}

function _wireAssetPathCheckTab(a, payload) {
  var checks = (payload && payload.checks) || [];
  if (!checks.length) return;
  _pathTabState = { assetId: a.id, checks: checks, checkId: checks[0].id, hiddenPhases: _pathLoadHiddenPhases() };
  document.querySelectorAll(".path-check-row").forEach(function (tr) {
    tr.addEventListener("click", function () {
      document.querySelectorAll(".path-check-row").forEach(function (x) { x.classList.remove("row-panel-active"); });
      tr.classList.add("row-panel-active");
      _pathSelectCheck(a, tr.getAttribute("data-check-id"));
    });
  });
  _pathSelectCheck(a, checks[0].id);
}

function _pathLoadHiddenPhases() {
  var hidden = new Set(["dnsMs", "connectMs", "tlsMs", "ttfbMs"]);
  try {
    var raw = localStorage.getItem("polaris-prefs-series-" + (typeof currentUsername !== "undefined" ? currentUsername : "") + "-pathPhases");
    if (raw) hidden = new Set(JSON.parse(raw));
  } catch (_) { /* per-viewer convenience only */ }
  return hidden;
}

function _pathSaveHiddenPhases(set) {
  try {
    localStorage.setItem("polaris-prefs-series-" + (typeof currentUsername !== "undefined" ? currentUsername : "") + "-pathPhases", JSON.stringify(Array.from(set)));
  } catch (_) { /* ignore */ }
}

function _pathSelectCheck(a, checkId) {
  var st = _pathTabState;
  if (!st) return;
  st.checkId = checkId;
  var check = st.checks.find(function (c) { return c.id === checkId; });
  var mount = document.getElementById("path-detail");
  if (!check || !mount) return;
  var l = check.latest || {};
  var stale = l.lastSampleAt && (Date.now() - new Date(l.lastSampleAt).getTime()) > 3 * (check.intervalSec || 60) * 1000;
  var isHttp = check.kind === "http" || check.kind === "https";
  var isServer = a.id === _PATH_SERVER_SUBJECT;
  mount.innerHTML =
    '<div data-shot-section="pathDetail" data-shot-chart="assetPathCheck">' +
      '<div style="display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;margin-bottom:0.5rem">' +
        '<strong>' + escapeHtml(check.name) + "</strong>" +
        '<span class="badge">' + escapeHtml(_PATH_KIND_LABELS[check.kind] || check.kind) + "</span>" +
        _pathResultPill(l) +
        '<span class="hint">' + (isServer ? "This Polaris server" : "Polaris Agent on this host") + " · every " + Math.round((check.intervalSec || 60) / 60) + " min</span>" +
        _freshnessStampHTML(l.lastSampleAt || null, check.intervalSec || 60, "no results yet") +
        '<span style="margin-left:auto;display:flex;gap:4px">' +
          _chartRangeBtnsHTML("path-range-btn", [
            { value: "1h", label: "1h" }, { value: "12h", label: "12h" }, { value: "24h", label: "24h" },
            { value: "7d", label: "7d" }, { value: "30d", label: "30d" },
          ], "assetPathCheck", "24h") +
        "</span>" +
      "</div>" +
      (stale ? _staleBannerBoxHTML("⚠ Last result " + _pathFmtWhen(l.lastSampleAt) + (isServer
        ? " — the server may have stopped running this check (is the check enabled, and is the scheduler role up?)"
        : " — the agent may be offline or not running this check")) : "") +
      '<div class="chart-label">Latency</div>' +
      '<div class="chart-box" id="asset-path-latency-chart" style="min-height:170px">Loading samples…</div>' +
      '<div class="chart-stats" id="asset-path-latency-stats"></div>' +
      '<div class="chart-label" style="margin-top:0.75rem">Availability</div>' +
      '<div class="chart-box" id="asset-path-avail-chart" style="min-height:120px">Loading…</div>' +
      '<div class="chart-stats" id="asset-path-avail-stats"></div>' +
      (isHttp
        ? '<div class="chart-label" style="margin-top:0.75rem">HTTP status</div>' +
          '<div class="chart-box" id="asset-path-status-chart" style="min-height:44px">Loading…</div>' +
          '<div class="chart-stats" id="asset-path-status-stats"></div>'
        : "") +
    "</div>" +
    '<div data-shot-section="pathLatest" id="path-latest" style="margin-top:1rem"></div>' +
    '<div data-shot-section="pathTraceroute" id="path-traceroute" style="margin-top:1rem"></div>';

  mount.querySelectorAll(".path-range-btn").forEach(function (b) {
    b.addEventListener("click", function () {
      mount.querySelectorAll(".path-range-btn").forEach(function (x) { x.classList.remove("btn-primary"); x.classList.add("btn-secondary"); });
      b.classList.remove("btn-secondary"); b.classList.add("btn-primary");
      _setChartRangePref("assetPathCheck", b.getAttribute("data-range"));
      _loadPathCheckHistoryFor(a.id, check, b.getAttribute("data-range"));
    });
  });
  ["asset-path-latency-chart", "asset-path-avail-chart"].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) _wireChartDragSelect(el, function (fromIso, toIso) {
      _applyCustomRangeSelection({ btnClass: "path-range-btn" }, fromIso, toIso);
      _loadPathCheckHistoryFor(a.id, check, { from: fromIso, to: toIso });
    });
  });
  _loadPathCheckHistoryFor(a.id, check, _getChartRangePref("assetPathCheck", "24h"));
  _renderPathLatestCard(check);
  _loadPathTraceroutes(a.id, check, a);
  if (!st.tiers) st.tiers = {};
  if (isServer) return; // no automation alerts on the server source — no bands to draw
  _loadMetricSeverityTiers(a.id, "pathLatencyMs", { checkId: check.id }).then(function (tiers) {
    st.tiers[check.id] = tiers;
    if (st.lastData && st.checkId === check.id) _renderPathCharts(check, st.lastData);
  });
}

async function _loadPathCheckHistoryFor(assetId, check, rangeOrOpts) {
  var opts = (typeof rangeOrOpts === "string" || !rangeOrOpts) ? { range: rangeOrOpts || "24h" } : rangeOrOpts;
  ["asset-path-latency-chart", "asset-path-avail-chart", "asset-path-status-chart"].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    if (opts.from && opts.to) { el.dataset.from = opts.from; el.dataset.to = opts.to; delete el.dataset.range; }
    else { el.dataset.range = opts.range; delete el.dataset.from; delete el.dataset.to; }
  });
  try {
    var data = await _pathApi(assetId).history(check.id, opts);
    var st = _pathTabState;
    if (!st || st.assetId !== assetId || st.checkId !== check.id) return;
    st.lastData = data;
    _renderPathCharts(check, data);
  } catch (err) {
    var el = document.getElementById("asset-path-latency-chart");
    if (el) el.textContent = "Error: " + (err.message || "failed to load");
  }
}

function _renderPathCharts(check, data) {
  var samples = (data && data.samples) || [];
  var lat = document.getElementById("asset-path-latency-chart");
  var av = document.getElementById("asset-path-avail-chart");
  var stc = document.getElementById("asset-path-status-chart");
  var copts = { since: data && data.since, until: data && data.until, subject: check.name, tier: data && data.tier };
  if (lat) _renderPathLatencyChart(lat, samples, copts, check);
  if (av) _renderPathAvailabilityChart(av, samples, copts);
  if (stc) _renderPathStatusStrip(stc, samples, copts);
  samples = _inChartWindow(samples, data && data.since);
  var lats = samples.map(function (s) { return s.latencyMs; }).filter(function (v) { return typeof v === "number"; });
  var avg = lats.length ? lats.reduce(function (x, y) { return x + y; }, 0) / lats.length : null;
  var count = samples.reduce(function (n, s) { return n + (s.sampleCount || 1); }, 0);
  var okCount = samples.reduce(function (n, s) { return n + (s.okCount != null ? s.okCount : (s.ok ? 1 : 0)); }, 0);
  var parts = [
    _tierStatsPart(data),
    { label: "Avg latency", value: avg == null ? null : Math.round(avg) + " ms" },
    { label: "Max", value: lats.length ? Math.round(Math.max.apply(null, lats)) + " ms" : null },
  ].filter(Boolean);
  _renderChartStats(document.getElementById("asset-path-latency-stats"), samples.length, parts);
  _renderChartStats(document.getElementById("asset-path-avail-stats"), samples.length, [
    { label: "Availability", value: count ? (Math.round((okCount / count) * 1000) / 10) + " %" : null },
    { label: "Failed runs", value: String(count - okCount) },
  ]);
}

/** Pure: bucket detail samples into n availability ratios over [t0, t1]. */
function _pathAvailabilityBuckets(samples, t0, t1, n) {
  var out = [];
  var span = (t1 - t0) / n;
  for (var i = 0; i < n; i++) out.push({ t: t0 + i * span, ok: 0, total: 0 });
  samples.forEach(function (s) {
    var t = new Date(s.timestamp).getTime();
    if (t < t0 || t > t1) return;
    var idx = Math.min(n - 1, Math.floor((t - t0) / span));
    var total = s.sampleCount != null ? s.sampleCount : 1;
    var ok = s.okCount != null ? s.okCount : (s.ok ? 1 : 0);
    out[idx].total += total;
    out[idx].ok += ok;
  });
  return out;
}

/** Pure: an availability bucket's colour — the status strip's verdict scheme
 *  (all passed / some failed / none passed), so a short bar no longer reads green. */
function _pathAvailabilityColor(b) {
  if (b.ok >= b.total) return _CHART_UP_COLOR;
  return b.ok > 0 ? MONITOR_STATE_COLORS.warning : MONITOR_STATE_COLORS.down;
}

function _pathChartFrame(container, H) {
  var W = container.clientWidth || 600;
  return { W: W, H: H, padL: 52, padR: 10, padT: 10, padB: 22 };
}

// The shared calendar-boundary ticks every chart draws (_chartXTicksSVG) — the
// equal-fifths loop this replaced called _chartTickFmt, which main retired.
function _pathXTicks(g, t0, t1, innerW, innerH) {
  return _chartXTicksSVG(t0, t1, g.padL, g.padT, innerW, innerH);
}

function _renderPathLatencyChart(container, samples, opts, check) {
  var st = _pathTabState || {};
  var hidden = st.hiddenPhases || new Set();
  if (!samples.length) { container.textContent = "No samples in this range yet."; return; }
  var g = _pathChartFrame(container, 170);
  var innerW = g.W - g.padL - g.padR, innerH = g.H - g.padT - g.padB;
  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var phases = _PATH_PHASES.filter(function (p) {
    return samples.some(function (s) { return typeof s[p.key] === "number"; });
  });
  var visible = phases.filter(function (p) { return !hidden.has(p.key) || p.key === "latencyMs" && phases.length === 1; });
  var maxV = 1;
  visible.forEach(function (p) { samples.forEach(function (s) { if (typeof s[p.key] === "number" && s[p.key] > maxV) maxV = s[p.key]; }); });
  var tiers = (st.tiers && st.tiers[check.id]) || [];
  tiers.forEach(function (t) { if (t.threshold > maxV) maxV = t.threshold * 1.05; });
  var exp = Math.pow(10, Math.floor(Math.log10(maxV)));
  var m = maxV / exp;
  var ceil = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * exp;
  var xFor = _chartXScale(g.padL, innerW, t0, t1);
  var yFor = _chartYScale(g.padT, innerH, 0, ceil);
  var sev = _severityChartLayer("conn", tiers, 0, ceil, { padL: g.padL, padR: g.padR, padT: g.padT, innerH: innerH, W: g.W, yFor: yFor, unit: "ms" });
  var ticks = "";
  for (var i = 0; i <= 4; i++) {
    var v = ceil * i / 4, y = g.padT + innerH - (i / 4) * innerH;
    ticks += '<line x1="' + g.padL + '" y1="' + y + '" x2="' + (g.W - g.padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (g.padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + Math.round(v) + "</text>";
  }
  var lines = visible.map(function (p, idx) {
    var pts = samples.filter(function (s) { return typeof s[p.key] === "number"; })
      .map(function (s) { return xFor(s.timestamp) + "," + yFor(s[p.key]); }).join(" ");
    var stroke = p.key === "latencyMs" && tiers.length ? sev.stroke : p.color;
    return '<polyline points="' + pts + '" fill="none" stroke="' + stroke + '" stroke-width="' + (p.key === "latencyMs" ? 1.75 : 1.25) + '"/>';
  }).join("");
  // Failed runs dive to the baseline in the canonical failure red (a marker,
  // not a data series).
  var fails = samples.filter(function (s) { return s.ok === false || (s.failCount > 0 && s.okCount === 0); }).map(function (s) {
    return '<circle cx="' + xFor(s.timestamp) + '" cy="' + (g.padT + innerH) + '" r="3" fill="' + _CHART_FAIL_COLOR + '"/>';
  }).join("");
  var hits = samples.map(function (s) {
    var yv = typeof s.latencyMs === "number" ? yFor(s.latencyMs) : g.padT + innerH;
    return '<circle class="chart-hit" cx="' + xFor(s.timestamp) + '" cy="' + yv + '" r="5" fill="transparent" style="cursor:crosshair" data-ts="' +
      escapeHtml(String(s.timestamp)) + '" data-i="' + samples.indexOf(s) + '"/>';
  }).join("");
  var chips = phases.map(function (p) {
    var off = hidden.has(p.key) && !(p.key === "latencyMs" && phases.length === 1);
    return '<button type="button" class="btn btn-sm btn-secondary path-phase-chip" data-phase="' + p.key + '" style="opacity:' + (off ? 0.45 : 1) + '">' +
      '<span style="display:inline-block;width:10px;height:6px;background:' + p.color + ';margin-right:4px"></span>' + escapeHtml(p.label) + "</button>";
  }).join(" ");
  var clipId = _chartClipId("conn");
  container.innerHTML =
    '<div style="display:flex;gap:4px;flex-wrap:wrap;margin-bottom:4px">' + chips + "</div>" +
    '<svg width="100%" height="' + g.H + '" viewBox="0 0 ' + g.W + " " + g.H + '" preserveAspectRatio="none" style="display:block">' +
      sev.defs + _chartClipDefs(clipId, g.padL, g.padT, innerW, innerH) +
      ticks + _pathXTicks(g, t0, t1, innerW, innerH) +
      _dateChangeMarkers(t0, t1, g.padL, g.padT, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, g.padL, g.padT, innerW, innerH) +
      "<g " + _chartClipAttr(clipId) + ">" + sev.lines + lines + fails + hits + "</g>" + sev.labels +
    "</svg>" + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  _stashChartGeometry(container, t0, t1, g.padL, innerW, g.W);
  _wireChartTooltip(container, function (target) {
    var s = samples[Number(target.getAttribute("data-i"))] || {};
    var row = function (label, v) { return typeof v === "number" ? "<div>" + label + ": " + Math.round(v) + " ms</div>" : ""; };
    return '<div style="font-weight:600;margin-bottom:2px">' + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + "</div>" +
      (s.ok === false ? '<div style="color:' + _CHART_FAIL_COLOR + '">Failed' + (s.error ? " — " + escapeHtml(s.error) : "") + "</div>" : "") +
      row("Total", s.latencyMs) + row("DNS", s.dnsMs) + row("Connect", s.connectMs) + row("TLS", s.tlsMs) + row("TTFB", s.ttfbMs) +
      (s.httpStatus != null ? "<div>HTTP " + s.httpStatus + "</div>" : "");
  });
  container.querySelectorAll(".path-phase-chip").forEach(function (b) {
    b.addEventListener("click", function () {
      var key = b.getAttribute("data-phase");
      if (hidden.has(key)) hidden.delete(key); else hidden.add(key);
      _pathSaveHiddenPhases(hidden);
      _renderPathLatencyChart(container, samples, opts, check);
    });
  });
  _addChartScreenshotButton(container, "Path latency", { yAxis: "Latency (ms)", subject: opts.subject, getStats: _statsSummaryFrom("asset-path-latency-stats") });
  _observeChartResize(container, function (c) { _renderPathLatencyChart(c, samples, opts, check); });
}

function _renderPathAvailabilityChart(container, samples, opts) {
  if (!samples.length) { container.textContent = "No samples in this range yet."; return; }
  var g = _pathChartFrame(container, 120);
  var innerW = g.W - g.padL - g.padR, innerH = g.H - g.padT - g.padB;
  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var t0 = bounds.t0, t1 = bounds.t1;
  var n = Math.max(10, Math.min(120, Math.floor(innerW / 8)));
  var buckets = _pathAvailabilityBuckets(samples, t0, t1, n);
  var bw = innerW / n;
  var yFor = _chartYScale(g.padT, innerH, 0, 100);
  var bars = buckets.map(function (b, i) {
    if (!b.total) return ""; // no run in this slot (agent offline) — a gap, not a failure
    var pct = (b.ok / b.total) * 100;
    // A 0 % bar has no height — keep a red stub on the baseline so an outage
    // stays visible and distinct from an empty (no-run) slot.
    var y = Math.min(yFor(pct), g.padT + innerH - 3);
    return '<rect class="chart-hit" x="' + (g.padL + i * bw + 0.5) + '" y="' + y + '" width="' + Math.max(1, bw - 1) + '" height="' + (g.padT + innerH - y) +
      '" fill="' + _pathAvailabilityColor(b) + '" opacity="0.8" data-ts="' + new Date(b.t).toISOString() + '" data-v="' + (Math.round(pct * 10) / 10) + '" data-n="' + b.total + '"/>';
  }).join("");
  var ticks = [0, 50, 100].map(function (v) {
    var y = yFor(v);
    return '<line x1="' + g.padL + '" y1="' + y + '" x2="' + (g.W - g.padR) + '" y2="' + y + '" stroke="rgba(127,127,127,0.15)"/>' +
      '<text x="' + (g.padL - 4) + '" y="' + (y + 3) + '" text-anchor="end" font-size="10" fill="currentColor">' + v + "%</text>";
  }).join("");
  container.innerHTML =
    '<svg width="100%" height="' + g.H + '" viewBox="0 0 ' + g.W + " " + g.H + '" preserveAspectRatio="none" style="display:block">' +
      ticks + _pathXTicks(g, t0, t1, innerW, innerH) +
      _maintenanceBandLayer(t0, t1, g.padL, g.padT, innerW, innerH) + bars +
    "</svg>" + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  _stashChartGeometry(container, t0, t1, g.padL, innerW, g.W);
  _wireChartTooltip(container, function (target) {
    return "<div>" + escapeHtml(_fmtTooltipTs(target.getAttribute("data-ts"))) + "</div>" +
      "<div>Available: " + escapeHtml(target.getAttribute("data-v")) + " % of " + escapeHtml(target.getAttribute("data-n")) + " runs</div>";
  });
  _addChartScreenshotButton(container, "Path availability", { yAxis: "Availability (%)", subject: opts.subject, getStats: _statsSummaryFrom("asset-path-avail-stats") });
  _observeChartResize(container, function (c) { _renderPathAvailabilityChart(c, samples, opts); });
}

/** A verdict strip, not a data series: one cell per run (or rollup bucket),
 *  green for a pass and red for a failure, the HTTP code in the tooltip. */
function _renderPathStatusStrip(container, samples, opts) {
  if (!samples.length) { container.textContent = "No samples in this range yet."; return; }
  var W = container.clientWidth || 600, H = 26, padL = 52, padR = 10;
  var innerW = W - padL - padR;
  var bounds = _chartTimeBounds(samples, opts.since, opts.until);
  var xFor = _chartXScale(padL, innerW, bounds.t0, bounds.t1);
  var cellW = Math.max(2, innerW / Math.max(samples.length, 1));
  var counts = {};
  var cells = samples.map(function (s, i) {
    var label = s.httpStatus != null ? String(s.httpStatus) : (s.ok ? "ok" : "error");
    counts[label] = (counts[label] || 0) + (s.sampleCount || 1);
    var partial = s.failCount > 0 && s.okCount > 0;
    var color = partial ? "#f4a261" : (s.ok ? MONITOR_STATE_COLORS.up : MONITOR_STATE_COLORS.down);
    return '<rect class="chart-hit" x="' + xFor(s.timestamp) + '" y="4" width="' + cellW + '" height="' + (H - 8) + '" fill="' + color + '" data-i="' + i + '"/>';
  }).join("");
  container.innerHTML = '<svg width="100%" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" style="display:block">' + cells + "</svg>" + CHART_TOOLTIP_HTML;
  container.style.position = "relative";
  _wireChartTooltip(container, function (target) {
    var s = samples[Number(target.getAttribute("data-i"))] || {};
    return "<div>" + escapeHtml(_fmtTooltipTs(String(s.timestamp))) + "</div>" +
      "<div>" + (s.httpStatus != null ? "HTTP " + s.httpStatus : (s.ok ? "Passed" : "Failed")) +
      (s.sampleCount ? " · " + s.okCount + "/" + s.sampleCount + " passed" : "") + "</div>";
  });
  var summary = Object.keys(counts).sort().map(function (k) { return k + " ×" + counts[k]; }).join(" · ");
  var statsEl = document.getElementById("asset-path-status-stats");
  if (statsEl) statsEl.textContent = summary;
  _observeChartResize(container, function (c) { _renderPathStatusStrip(c, samples, opts); });
}

function _renderPathLatestCard(check) {
  var mount = document.getElementById("path-latest");
  if (!mount) return;
  var l = check.latest || {};
  // The asset-details key/value row (label left, value right). This used
  // asset-view-row/-label/-value, which have no CSS — label and value ran together.
  var row = function (k, v) { return '<div class="detail-row"><span class="detail-label">' + k + '</span><span class="detail-value">' + v + "</span></div>"; };
  mount.innerHTML = '<div class="chart-label">Latest result</div><div class="asset-view-grid">' +
    row("Result", _pathResultPill(l)) +
    row("When", escapeHtml(_pathFmtWhen(l.lastSampleAt))) +
    row("Latency", l.lastLatencyMs != null ? Math.round(l.lastLatencyMs) + " ms" : "—") +
    (check.kind === "http" || check.kind === "https" ? row("HTTP status", l.lastHttpStatus != null ? String(l.lastHttpStatus) : "—") : "") +
    row("Resolved IP", escapeHtml(l.lastResolvedIp || "—")) +
    (l.lastOk === false && l.lastError ? row("Error", '<span style="color:' + _CHART_FAIL_COLOR + '">' + escapeHtml(l.lastError) + "</span>") : "") +
    row("Last failure", escapeHtml(_pathFmtWhen(l.lastFailAt))) +
    _pathSampleRows(check.latestSample, row) +
    "</div>" +
    _pathExcerptHTML(check.latestSample);
}

/** The newest sample's body / TLS facts (the source row carries only the verdict). */
function _pathSampleRows(s, row) {
  if (!s) return "";
  var out = "";
  var phases = ["dnsMs", "connectMs", "tlsMs", "ttfbMs"].filter(function (k) { return typeof s[k] === "number"; })
    .map(function (k) { return k.replace("Ms", "").toUpperCase() + " " + Math.round(s[k]) + " ms"; });
  if (phases.length) out += row("Phases", escapeHtml(phases.join(" · ")));
  // bodyMatched = "the body expectation held" — which for a "must NOT contain"
  // check means the text was absent, so the wording is neutral about direction.
  if (s.bodyMatched != null) out += row("Body check", s.bodyMatched ? "as expected" : '<span style="color:' + _CHART_FAIL_COLOR + '">not as expected</span>');
  if (s.bodySha256) out += row("Body SHA-256", '<code class="copy-cell" style="font-size:0.75rem;word-break:break-all">' + escapeHtml(s.bodySha256) + "</code>");
  if (s.bodyBytes != null) out += row("Body size", s.bodyBytes + " bytes" + (s.bodyBytes >= 65536 ? " (first 64 KB read)" : ""));
  if (s.tlsIssuer) out += row("TLS issuer", escapeHtml(s.tlsIssuer));
  if (s.tlsNotAfter) out += row("TLS expires", _pathTlsExpiryHTML(s.tlsNotAfter));
  return out;
}

/** Display bands only — the alerting threshold is an automation on pathTlsDaysLeft. */
function _pathTlsExpiryHTML(notAfter) {
  var d = new Date(notAfter);
  if (isNaN(d.getTime())) return "—";
  var days = Math.floor((d.getTime() - Date.now()) / 86400000);
  var color = days <= 7 ? MONITOR_STATE_COLORS.down : days <= 30 ? MONITOR_STATE_COLORS.warning : MONITOR_STATE_COLORS.up;
  return escapeHtml(formatDate(notAfter)) + ' <span style="color:' + color + ';font-weight:600">(' + (days < 0 ? "expired" : days + " days") + ")</span>";
}

function _pathExcerptHTML(s) {
  if (!s || !s.bodyExcerpt) return "";
  return '<div class="chart-label" style="margin-top:0.5rem">Response excerpt' + (s.ok ? "" : " (failed run)") + "</div>" +
    '<pre style="max-height:160px;overflow:auto;white-space:pre-wrap;font-size:0.75rem;background:var(--color-bg-subtle,rgba(127,127,127,0.08));padding:0.5rem;border-radius:var(--radius-md)">' +
    escapeHtml(String(s.bodyExcerpt).slice(0, 4096)) + "</pre>";
}

/** Pure: which TTLs differ between two traceroutes' hop lists. */
function _trDiffHops(cur, prev) {
  var out = new Set();
  if (!prev) return out;
  var byTtl = {};
  (prev.hops || []).forEach(function (h) { byTtl[h.ttl] = h.ip || null; });
  (cur.hops || []).forEach(function (h) {
    var before = Object.prototype.hasOwnProperty.call(byTtl, h.ttl) ? byTtl[h.ttl] : undefined;
    if (before === undefined || before !== (h.ip || null)) out.add(h.ttl);
  });
  return out;
}

/** Pure: avg / min / max of a hop's answered probes (−1 = timeout). */
function _trHopRtt(rtts) {
  var v = (rtts || []).filter(function (x) { return typeof x === "number" && x >= 0; });
  if (!v.length) return null;
  var sum = v.reduce(function (a, b) { return a + b; }, 0);
  return { avg: sum / v.length, min: Math.min.apply(null, v), max: Math.max.apply(null, v) };
}

/**
 * Pure: fold the fetched traceroutes (newest first) into one NetPath-style
 * graph — column 0 is this host, column N the destination, one column per TTL
 * between. A hop is a node per (ttl, ip); the same address at the same TTL in
 * several traces is one node, so a route change reads as a branch. Each link
 * counts the traces that took it; `sel` marks the selected trace's own route,
 * with the latency each link ADDS (its hop's avg RTT minus the last answered
 * hop's before it) so the slow segment is the one that lights up.
 */
function _trPathGraph(traces, sel) {
  var nodes = {}, edges = {}, maxTtl = 0;
  var selT = traces[sel] || traces[0];
  var destIp = (selT && selT.destinationIp) || null;
  traces.forEach(function (t) { if (!destIp && t.destinationIp) destIp = t.destinationIp; });
  function keyOf(t, h, isLast) {
    if (h.ip && ((isLast && t.complete) || h.ip === destIp)) return "dst";
    return h.ttl + ":" + (h.ip || "*");
  }
  function ensure(key, h) {
    var n = nodes[key] || (nodes[key] = { key: key, ttl: h ? h.ttl : 0, hop: null, traces: 0, onSel: false });
    if (h && !n.hop) n.hop = h; // newest trace first, so the first sighting is the latest
    return n;
  }
  function touch(key, ti, h) {
    var n = ensure(key, h);
    n.traces++;
    if (ti === sel) { n.onSel = true; if (h) n.hop = h; }
    return n;
  }
  function link(a, b, ti, extra) {
    // A trace that stopped short gets its own link to the destination — merged
    // with a completed trace's, the ✕ would land on a route that got through.
    var k = a + ">" + b + (extra && extra.broken ? "!" : "");
    var e = edges[k] || (edges[k] = { from: a, to: b, traces: 0, onSel: false, broken: false, delta: null, lossy: false, unanswered: false });
    e.traces++;
    if (extra && extra.broken) e.broken = true;
    if (ti === sel) { e.onSel = true; if (extra) { e.delta = extra.delta; e.lossy = !!extra.lossy; e.unanswered = !!extra.unanswered; } }
  }
  ensure("src", null).onSel = true;
  traces.forEach(function (t, ti) {
    var hops = (t.hops || []).slice().sort(function (a, b) { return a.ttl - b.ttl; });
    var prev = "src", lastAvg = 0;
    hops.forEach(function (h, i) {
      var key = keyOf(t, h, i === hops.length - 1);
      if (key === prev) return; // the destination answering at two TTLs
      touch(key, ti, h);
      if (key !== "dst" && h.ttl > maxTtl) maxTtl = h.ttl;
      var rtt = _trHopRtt(h.rttMs);
      var lost = (h.rttMs || []).filter(function (x) { return !(typeof x === "number" && x >= 0); }).length;
      link(prev, key, ti, { delta: rtt ? Math.max(0, rtt.avg - lastAvg) : null, lossy: rtt && lost > 0, unanswered: !rtt });
      if (rtt) lastAvg = rtt.avg;
      prev = key;
    });
    if (prev !== "dst") {
      ensure("dst", null); // drawn even when no trace reached it
      link(prev, "dst", ti, { broken: true });
    }
  });
  nodes.src.traces = traces.length;
  if (nodes.dst && !nodes.dst.hop) nodes.dst.hop = { ttl: 0, ip: destIp, rdns: null, rttMs: [] };
  // Columns: TTL for a hop, one past the deepest hop for the destination.
  var cols = [];
  Object.keys(nodes).forEach(function (k) {
    var n = nodes[k];
    n.col = k === "src" ? 0 : k === "dst" ? maxTtl + 1 : n.ttl;
    (cols[n.col] || (cols[n.col] = [])).push(n);
  });
  // Rows: most-travelled first, then by address — stable across selections, so
  // picking another trace moves the highlight, never the nodes.
  cols.forEach(function (list) {
    if (!list) return;
    list.sort(function (a, b) { return b.traces - a.traces || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    list.forEach(function (n, i) { n.row = i; });
  });
  return { nodes: nodes, edges: Object.keys(edges).map(function (k) { return edges[k]; }), cols: maxTtl + 2, traces: traces.length, destIp: destIp };
}

/** Pure: a link's colour by the latency it adds — the NetPath reading. */
function _trEdgeColor(e) {
  if (e.broken) return "var(--color-danger)";
  if (!e.onSel || e.delta == null) return "var(--color-text-tertiary)";
  if (e.delta >= 50) return "var(--color-danger)";
  if (e.delta >= 10 || e.lossy) return "var(--color-warning)";
  return "var(--color-success)";
}

/**
 * Pure: where everything on the path graph sits. Columns shrink to fit the
 * panel before the graph scrolls (source and destination on one screen is the
 * point of the view); `minWidth` null gives the roomiest columns, which is
 * what the export draws. Shared by the on-screen SVG and the export scene so
 * the two cannot drift.
 */
function _trPathLayout(g, minWidth) {
  var MINCOL = 76, MAXCOL = 130, ROWH = 74, PADX = 12, PADT = 22, R = 13;
  if (minWidth == null) minWidth = PADX * 2 + g.cols * MAXCOL;
  var rows = 1;
  Object.keys(g.nodes).forEach(function (k) { rows = Math.max(rows, g.nodes[k].row + 1); });
  var colW = Math.max(MINCOL, Math.min(MAXCOL, ((minWidth || 0) - PADX * 2) / g.cols));
  var W = Math.max(minWidth || 0, PADX * 2 + g.cols * colW);
  var offX = (W - g.cols * colW) / 2;
  return {
    W: W, H: PADT + rows * ROWH + 4, R: R,
    pos: function (n) { return { x: offX + n.col * colW + colW / 2, y: PADT + R + n.row * ROWH }; },
    clip: function (s) { var max = Math.max(4, Math.floor((colW - 8) / 6.2)); s = String(s || ""); return s.length > max ? s.slice(0, max - 1) + "…" : s; },
  };
}

/**
 * Pure: how one node reads — its glyph, its name, the line under the name,
 * and its colours (theme tokens, or a monitor-state hex). Shared by the SVG
 * and the export scene.
 */
function _trNodeView(g, k, source) {
  var n = g.nodes[k], h = n.hop || {};
  var rtt = h.rttMs ? _trHopRtt(h.rttMs) : null;
  var v = { fill: null, stroke: "var(--color-text-secondary)", text: "var(--color-text-primary)", dashed: false,
    strokeWidth: k === "dst" ? 3 : 1.5, opacity: n.onSel || k === "src" ? 1 : 0.45, glyph: "", name: "", sub: "" };
  if (k === "src") {
    v.fill = "var(--color-accent)"; v.stroke = v.fill; v.text = "#fff"; v.glyph = "⌂";
    v.name = (source && source.hostname) || "This host"; v.sub = "source";
  } else if (k === "dst") {
    v.fill = h.monitorStatus && MONITOR_STATE_COLORS[h.monitorStatus] ? MONITOR_STATE_COLORS[h.monitorStatus] : "var(--color-bg-primary)";
    v.glyph = "◎"; if (v.fill.charAt(0) === "#") { v.stroke = v.fill; v.text = "#fff"; }
    v.name = h.hostname || h.rdns || g.destIp || "Destination"; v.sub = rtt ? (Math.round(rtt.avg * 10) / 10) + " ms" : "destination";
  } else if (!h.ip) {
    v.stroke = "var(--color-text-tertiary)"; v.dashed = true; v.text = "var(--color-text-tertiary)";
    v.glyph = "*"; v.name = "no reply"; v.sub = "TTL " + n.ttl;
  } else {
    var sc = h.monitorStatus && MONITOR_STATE_COLORS[h.monitorStatus];
    v.fill = sc || "var(--color-bg-primary)"; if (sc) { v.stroke = sc; v.text = "#fff"; }
    v.glyph = String(n.ttl); v.name = h.hostname || h.rdns || h.ip; v.sub = rtt ? (Math.round(rtt.avg * 10) / 10) + " ms" : "—";
  }
  return v;
}

/** Pure: a link's stroke width — thicker the more traces took it. */
function _trEdgeWidth(g, e) {
  var w = 1.25 + 3 * (e.traces / Math.max(1, g.traces));
  return e.onSel ? Math.max(2.5, w) : w;
}

/** Pure: the path graph as SVG. `source` is this host ({hostname, ipAddress}). */
function _trPathSVG(g, source, minWidth) {
  var L = _trPathLayout(g, minWidth || 0), R = L.R, W = L.W, H = L.H;
  var edgeSvg = "", nodeSvg = "", hitSvg = "";
  // Unselected routes first so the selected one paints on top.
  g.edges.slice().sort(function (a, b) { return (a.onSel ? 1 : 0) - (b.onSel ? 1 : 0); }).forEach(function (e) {
    var a = L.pos(g.nodes[e.from]), b = L.pos(g.nodes[e.to]);
    var x1 = a.x + R, x2 = b.x - R, mx = (x1 + x2) / 2;
    var dash = e.broken || e.unanswered ? ' stroke-dasharray="5 4"' : "";
    edgeSvg += '<path d="M' + x1.toFixed(1) + "," + a.y + " C" + mx.toFixed(1) + "," + a.y + " " + mx.toFixed(1) + "," + b.y + " " + x2.toFixed(1) + "," + b.y +
      '" fill="none" stroke="' + _trEdgeColor(e) + '" stroke-width="' + +_trEdgeWidth(g, e).toFixed(2) + '"' + dash +
      ' stroke-linecap="round" opacity="' + (e.onSel ? 1 : 0.35) + '"/>';
    if (e.broken && e.onSel) {
      var cx = (x1 + x2) / 2, cy = (a.y + b.y) / 2;
      edgeSvg += '<g stroke="var(--color-danger)" stroke-width="2.5" stroke-linecap="round">' +
        '<line x1="' + (cx - 5) + '" y1="' + (cy - 5) + '" x2="' + (cx + 5) + '" y2="' + (cy + 5) + '"/>' +
        '<line x1="' + (cx - 5) + '" y1="' + (cy + 5) + '" x2="' + (cx + 5) + '" y2="' + (cy - 5) + '"/></g>';
    }
  });
  Object.keys(g.nodes).forEach(function (k) {
    var p = L.pos(g.nodes[k]), h = g.nodes[k].hop || {}, v = _trNodeView(g, k, source);
    nodeSvg += '<g opacity="' + v.opacity + '">' +
      '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y + '" r="' + R + '" fill="' + (v.fill || "none") + '" stroke="' + v.stroke + '" stroke-width="' + v.strokeWidth + '"' +
        (v.dashed ? ' stroke-dasharray="3 3"' : "") + "/>" +
      '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + 4) + '" text-anchor="middle" font-size="11" font-weight="600" fill="' + v.text + '">' + escapeHtml(v.glyph) + "</text>" +
      '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + R + 14) + '" text-anchor="middle" font-size="11" fill="var(--color-text-primary)">' + escapeHtml(L.clip(v.name)) + "</text>" +
      '<text x="' + p.x.toFixed(1) + '" y="' + (p.y + R + 27) + '" text-anchor="middle" font-size="10" fill="var(--color-text-secondary)">' + escapeHtml(L.clip(v.sub)) + "</text>" +
      "</g>";
    hitSvg += '<circle class="chart-hit" data-k="' + escapeHtml(k) + '" cx="' + p.x.toFixed(1) + '" cy="' + p.y + '" r="' + (R + 5) + '" fill="transparent"' +
      (h.assetId ? ' style="cursor:pointer"' : "") + "/>";
  });
  return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H + '" style="display:block;font-family:inherit">' + edgeSvg + nodeSvg + hitSvg + "</svg>";
}

// Paper is white whatever theme is on screen: the daylight (noon) values of
// the tokens the path graph paints with.
var _TR_PAPER_COLORS = {
  "var(--color-accent)": "#0288d1", "var(--color-bg-primary)": "#ffffff",
  "var(--color-text-primary)": "#1a1a2e", "var(--color-text-secondary)": "#555570", "var(--color-text-tertiary)": "#8080a0",
  "var(--color-success)": "#2e7d32", "var(--color-warning)": "#f57f17", "var(--color-danger)": "#c62828",
  "#fff": "#ffffff",
};

/**
 * Pure: the path graph as a graph-export.js scene — model px are the SVG's px
 * at the roomiest column width, colours the daylight palette. `mix(hex,
 * alpha)` is PolarisGraphExport.mixWithWhite: paper has no alpha, so a faded
 * branch is resolved to its colour over white. `pdfText` is its WinAnsi
 * mapping, applied to what the PDF prints (a hostname can hold anything).
 * A circle's glyph, its name and the line under it are three text-only boxes,
 * because a scene label carries one font size and colour.
 */
function _trPathScene(g, source, mix, pdfText) {
  var L = _trPathLayout(g, null), R = L.R;
  function paper(c) { return c == null ? null : _TR_PAPER_COLORS[c] || c; }
  function label(text, pdf, fontPx, color, valign, my, bold) {
    return { lines: [text], pdfLines: [pdfText(pdf)], fontPx: fontPx, mono: false, bold: !!bold, italic: false, color: color,
      bg: null, valign: valign, halign: "center", mx: 0, my: my };
  }
  function line(path, color, width, style) {
    return { path: path, color: color, width: width, style: style, arrowTarget: null, arrowSource: null, label: null,
      mid: { x: (path[0].x + path[path.length - 1].x) / 2, y: (path[0].y + path[path.length - 1].y) / 2 }, z: 0 };
  }
  var scene = { under: [], parents: [], edges: [], nodes: [], minFontPx: 10, icons: [],
    bbox: { x1: 0, y1: 0, x2: L.W, y2: L.H, w: L.W, h: L.H } };
  g.edges.slice().sort(function (a, b) { return (a.onSel ? 1 : 0) - (b.onSel ? 1 : 0); }).forEach(function (e) {
    var a = L.pos(g.nodes[e.from]), b = L.pos(g.nodes[e.to]);
    var x1 = a.x + R, x2 = b.x - R, mx = (x1 + x2) / 2, my = (a.y + b.y) / 2, q = (x2 - x1) / 4;
    // The SVG's S-curve is one cubic with both handles at mid-x; drawn here as
    // the quadratic on each side of its midpoint, tangent where the cubic is.
    scene.edges.push(line(
      [{ type: "M", x: x1, y: a.y }, { type: "Q", cx: x1 + q, cy: a.y, x: mx, y: my }, { type: "Q", cx: x2 - q, cy: b.y, x: x2, y: b.y }],
      mix(paper(_trEdgeColor(e)), e.onSel ? 1 : 0.35), _trEdgeWidth(g, e), e.broken || e.unanswered ? "dashed" : "solid"));
    if (e.broken && e.onSel) {
      [[-5, -5, 5, 5], [-5, 5, 5, -5]].forEach(function (d) {
        scene.edges.push(line([{ type: "M", x: mx + d[0], y: my + d[1] }, { type: "L", x: mx + d[2], y: my + d[3] }],
          paper("var(--color-danger)"), 2.5, "solid"));
      });
    }
  });
  Object.keys(g.nodes).forEach(function (k) {
    var p = L.pos(g.nodes[k]), v = _trNodeView(g, k, source);
    var x1 = p.x - R, y1 = p.y - R, x2 = p.x + R, y2 = p.y + R;
    function textBox(lbl) {
      return { shape: "rect", polygon: null, x1: x1, y1: y1, x2: x2, y2: y2, fill: null, stroke: null,
        strokeWidth: 0, strokeStyle: "solid", icon: null, label: lbl, z: 0 };
    }
    scene.nodes.push({ shape: "ellipse", polygon: null, x1: x1, y1: y1, x2: x2, y2: y2,
      fill: v.fill ? mix(paper(v.fill), v.opacity) : null, stroke: mix(paper(v.stroke), v.opacity),
      strokeWidth: v.strokeWidth, strokeStyle: v.dashed ? "dashed" : "solid", icon: null, label: null, z: 0 });
    // ⌂ and ◎ are not in the PDF's WinAnsi fonts; the Visio package keeps them.
    var pdfGlyph = k === "src" ? "S" : k === "dst" ? "D" : v.glyph;
    scene.nodes.push(textBox(label(v.glyph, pdfGlyph, 11, mix(paper(v.text), v.opacity), "center", 0, true)));
    scene.nodes.push(textBox(label(L.clip(v.name), L.clip(v.name), 11, mix(paper("var(--color-text-primary)"), v.opacity), "bottom", 3)));
    scene.nodes.push(textBox(label(L.clip(v.sub), L.clip(v.sub), 10, mix(paper("var(--color-text-secondary)"), v.opacity), "bottom", 16)));
  });
  return scene;
}

function _trPathTooltipHTML(g, key, source) {
  var n = g.nodes[key];
  if (!n) return "";
  var h = n.hop || {};
  var rows = [];
  var name = key === "src" ? ((source && source.hostname) || "This host") : (h.hostname || h.rdns || h.ip || "No reply");
  rows.push("<strong>" + escapeHtml(name) + "</strong>" + (key === "src" ? " · source" : key === "dst" ? " · destination" : " · TTL " + n.ttl));
  if (key === "src" && source && source.ipAddress) rows.push(escapeHtml(source.ipAddress));
  if (key !== "src") {
    if (h.ip && h.ip !== name) rows.push(escapeHtml(h.ip));
    if (h.rdns && h.rdns !== name) rows.push(escapeHtml(h.rdns));
    var rtt = _trHopRtt(h.rttMs);
    if (rtt) rows.push("RTT " + (Math.round(rtt.avg * 10) / 10) + " ms avg · " + (Math.round(rtt.min * 10) / 10) + "–" + (Math.round(rtt.max * 10) / 10) + " ms");
    var probes = (h.rttMs || []).length, lost = (h.rttMs || []).filter(function (x) { return !(typeof x === "number" && x >= 0); }).length;
    if (probes && lost) rows.push(lost + " of " + probes + " probes unanswered");
    if (!h.ip && key !== "dst") rows.push("No router answered at this hop — common where ICMP time-exceeded is filtered");
    if (h.interfaceName) rows.push("Interface " + escapeHtml(h.interfaceName));
    if (h.subnetCidr) rows.push("Subnet " + escapeHtml(h.subnetCidr));
    if (h.assetId) rows.push('<span style="color:var(--color-text-secondary)">Click to open the asset</span>');
  }
  if (key !== "src" && g.traces > 1) rows.push('<span style="color:var(--color-text-secondary)">On ' + n.traces + " of " + g.traces + " traces" + (n.onSel ? "" : " · not on the selected one") + "</span>");
  return rows.join("<br>");
}

var _TR_PATH_LEGEND_HTML =
  '<div class="hint" style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center;margin-top:0.35rem">' +
    '<span>Latency added by each link:</span>' +
    '<span><span style="display:inline-block;width:18px;height:3px;vertical-align:middle;background:var(--color-success)"></span> under 10 ms</span>' +
    '<span><span style="display:inline-block;width:18px;height:3px;vertical-align:middle;background:var(--color-warning)"></span> 10–50 ms or probe loss</span>' +
    '<span><span style="display:inline-block;width:18px;height:3px;vertical-align:middle;background:var(--color-danger)"></span> over 50 ms · ✕ destination not reached</span>' +
    '<span>Faded branches are routes other recent traces took; thicker links were taken more often.</span>' +
  "</div>";

function _renderTrPathGraph(box, list, sel, source) {
  var g = _trPathGraph(list, sel);
  box.innerHTML = '<div style="overflow-x:auto">' +
    _trPathSVG(g, source, Math.max(0, (box.clientWidth || 0) - 16)) + "</div>" + CHART_TOOLTIP_HTML;
  _wireChartTooltip(box, function (t) { return _trPathTooltipHTML(g, t.getAttribute("data-k"), source); });
  box.querySelector("svg").addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.classList || !t.classList.contains("chart-hit")) return;
    var n = g.nodes[t.getAttribute("data-k")];
    if (!n || !n.hop || !n.hop.assetId) return;
    // Drawn inside Path Monitor → Results (the server source)? That detail
    // shares the slide-over Paths tab's element ids — clear it first.
    var serverDetail = document.getElementById("path-server-detail");
    if (serverDetail && serverDetail.contains(box)) serverDetail.innerHTML = "";
    openViewModal(n.hop.assetId);
  });
}

async function _loadPathTraceroutes(assetId, check, source) {
  var mount = document.getElementById("path-traceroute");
  if (!mount) return;
  if (!check.traceroute || check.traceroute.enabled === false) {
    mount.innerHTML = '<div class="chart-label">Path</div><p class="hint">Traceroute is off for this check.</p>';
    return;
  }
  mount.innerHTML = '<div class="chart-label">Path</div><p class="hint">Loading…</p>';
  try {
    var res = await _pathApi(assetId).traceroutes(check.id, 10);
    if (!_pathTabState || _pathTabState.checkId !== check.id) return;
    var list = (res && res.traceroutes) || [];
    if (!list.length) {
      mount.innerHTML = '<div class="chart-label">Path</div><p class="hint">No traceroute yet — one runs on the first run, every ' +
        ((check.traceroute && check.traceroute.everyNRuns) || 5) + " runs after that, and whenever the check starts failing.</p>";
      return;
    }
    var options = list.map(function (t, i) {
      return '<option value="' + i + '">' + escapeHtml(_pathFmtWhen(t.timestamp)) + " · " + t.hopCount + " hops" +
        (t.complete ? "" : " · incomplete") + (t.reason === "transition" ? " · on failure" : "") + "</option>";
    }).join("");
    mount.innerHTML = '<div style="display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap">' +
        '<div class="chart-label" style="margin:0">Path</div>' +
        '<select id="path-tr-select" style="width:auto">' + options + "</select>" +
        '<span id="path-tr-diff" class="hint"></span>' +
        '<button type="button" class="btn-icon" id="path-tr-export" aria-label="Export" aria-haspopup="menu" title="Export: screenshot, PDF or Visio" style="margin-left:auto;line-height:0">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>' +
        "</button></div>" +
      '<div class="chart-box" id="path-tr-graph" style="margin-top:0.5rem;position:relative"></div>' +
      _TR_PATH_LEGEND_HTML +
      '<div class="table-wrapper" style="margin-top:0.75rem"><table id="path-tr-table"><thead><tr>' +
        '<th style="width:50px">TTL</th><th style="width:140px">IP</th><th>Reverse DNS</th><th style="width:150px">RTT avg / min / max</th><th>Asset</th><th style="width:140px">Subnet</th>' +
      '</tr></thead><tbody id="path-tr-body"></tbody></table></div>' +
      '<p class="hint" id="path-tr-foot" style="margin-top:0.35rem"></p>';
    var sel = document.getElementById("path-tr-select");
    sel.value = "0";
    var draw = function () {
      var i = Number(sel.value) || 0;
      var cur = list[i], prev = list[i + 1];
      var changed = _trDiffHops(cur, prev);
      var graphBox = document.getElementById("path-tr-graph");
      if (graphBox) {
        _renderTrPathGraph(graphBox, list, i, source);
        _observeChartResize(graphBox, function (el) { _renderTrPathGraph(el, list, Number(sel.value) || 0, source); });
      }
      var diffEl = document.getElementById("path-tr-diff");
      if (diffEl) diffEl.textContent = !prev ? "" : changed.size ? "Path changed vs the previous trace — " + changed.size + " hop" + (changed.size === 1 ? "" : "s") + " differ" : "Same path as the previous trace";
      var prevIp = {};
      (prev ? prev.hops : []).forEach(function (h) { prevIp[h.ttl] = h.ip; });
      document.getElementById("path-tr-body").innerHTML = (cur.hops || []).map(function (h) {
        var rtt = _trHopRtt(h.rttMs);
        var fmt = function (x) { return (Math.round(x * 10) / 10) + " ms"; };
        var assetCell = h.assetId
          ? '<a href="#" class="dep-tree-link path-tr-asset" data-id="' + escapeHtml(h.assetId) + '" title="Status when the trace was taken">' +
              '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;background:' + (MONITOR_STATE_COLORS[h.monitorStatus] || "var(--color-text-tertiary)") + '"></span>' +
              escapeHtml(h.hostname || h.ip) + (h.interfaceName ? " · " + escapeHtml(h.interfaceName) : "") + "</a>"
          : "";
        var isChanged = changed.has(h.ttl);
        return '<tr' + (isChanged ? ' style="box-shadow:inset 3px 0 0 var(--color-accent)" title="was ' + escapeHtml(prevIp[h.ttl] || "* (no reply)") + '"' : "") + ">" +
          "<td>" + h.ttl + "</td>" +
          "<td>" + (h.ip ? escapeHtml(h.ip) : '<span class="hint">* * *</span>') + "</td>" +
          "<td>" + escapeHtml(h.rdns || "") + "</td>" +
          "<td>" + (rtt ? fmt(rtt.avg) + " / " + fmt(rtt.min) + " / " + fmt(rtt.max) : "—") + "</td>" +
          "<td>" + assetCell + "</td>" +
          "<td>" + (h.subnetCidr ? '<span class="tag-chip">' + escapeHtml(h.subnetCidr) + "</span>" : "") + "</td>" +
          "</tr>";
      }).join("");
      var last = (cur.hops || [])[cur.hops.length - 1];
      document.getElementById("path-tr-foot").textContent =
        (cur.complete ? "Reached the destination (" + (cur.destinationIp || "") + ")." : "Incomplete — stopped at TTL " + (last ? last.ttl : 0) + ".") +
        (cur.note ? " " + cur.note : "") +
        " A path change is recorded on the Events tab as path_check.path_changed.";
      document.querySelectorAll(".path-tr-asset").forEach(function (lnk) {
        lnk.addEventListener("click", function (e) { e.preventDefault(); openViewModal(lnk.getAttribute("data-id")); });
      });
    };
    sel.addEventListener("change", draw);
    draw();
    var exportBtn = document.getElementById("path-tr-export");
    exportBtn.addEventListener("click", function () {
      _openPathMapExport(exportBtn, check, list, Number(sel.value) || 0, source);
    });
  } catch (err) {
    mount.innerHTML = '<div class="chart-label">Path</div><p class="hint">' + escapeHtml(err.message || "Failed to load traceroutes") + "</p>";
  }
}

/** Pure: the path map export's header lines — the route, then the trace drawn. */
function _pathMapExportMeta(check, list, sel, source, g) {
  var t = list[sel] || list[0];
  var from = (source && source.hostname) || "This host";
  var to = g.destIp || "destination";
  return [
    from + " -> " + to + "  |  " + (_PATH_KIND_LABELS[check.kind] || check.kind || "") + " check",
    "Trace " + _pathFmtWhen(t.timestamp) + ", " + t.hopCount + " hops, " + (t.complete ? "reached the destination" : "incomplete") +
      (list.length > 1 ? "  |  Faded branches: routes the other " + (list.length - 1) + " recent trace" + (list.length === 2 ? "" : "s") + " took" : ""),
  ];
}

/** Pure: the path map export's key — the on-screen legend, as paper colours. */
function _pathMapExportKey() {
  var P = _TR_PAPER_COLORS;
  return [
    { kind: "line", color: P["var(--color-success)"], text: "adds under 10 ms" },
    { kind: "line", color: P["var(--color-warning)"], text: "adds 10-50 ms or probe loss" },
    { kind: "line", color: P["var(--color-danger)"], text: "adds over 50 ms" },
    { kind: "line", color: P["var(--color-danger)"], text: "destination not reached", dashed: true },
    { kind: "line", color: P["var(--color-text-tertiary)"], text: "hop did not answer", dashed: true },
    { kind: "dot", color: MONITOR_STATE_COLORS.up, text: "asset up" },
    { kind: "dot", color: MONITOR_STATE_COLORS.warning, text: "asset warning" },
    { kind: "dot", color: MONITOR_STATE_COLORS.down, text: "asset down" },
  ];
}

// The Export menu (graph-export.js) for the path map. The slide-over opens on
// every page and the Path Monitor draws the same map, but graph-export.js and
// the vendor libraries it needs are only static on some of them — so they are
// fetched here on first use (_loadPanelScript requests each file once a page).
function _openPathMapExport(btn, check, list, sel, source) {
  var need = [];
  if (!window.jspdf) need.push("/js/vendor/jspdf.umd.min.js");
  if (typeof htmlToImage === "undefined") need.push("/js/vendor/html-to-image.min.js");
  if (!window.PolarisGraphExport) need.push("/js/graph-export.js");
  need.reduce(function (p, src) { return p.then(function () { return _loadPanelScript(src); }); }, Promise.resolve())
    .then(function () {
      window.PolarisGraphExport.openMenu(btn, function () {
        var g = _trPathGraph(list, sel);
        var name = check.name || "Path";
        return {
          scene: _trPathScene(g, source, window.PolarisGraphExport.mixWithWhite, window.PolarisGraphExport.pdfText),
          title: "Path: " + name,
          fileBase: "polaris-path-" + (String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "check"),
          noun: "path map",
          metaLines: _pathMapExportMeta(check, list, sel, source, g),
          keyItems: _pathMapExportKey(),
          scopeNote: "Exports the trace selected now, with the routes the other recent traces took as faded branches.",
        };
      }, { screenshot: function () { _pathMapScreenshot(); } });
    }, function (err) {
      showToast("Export unavailable: " + (err && err.message ? err.message : String(err)), "error");
    });
}

// The map and its legend onto the clipboard — the map at full width even when
// the panel scrolls it. Both are copied into an off-screen holder as wide as
// the map, so the legend wraps to the picture rather than to the panel; it
// stays in the document so the theme's colours still resolve.
function _pathMapScreenshot() {
  var svg = document.querySelector("#path-tr-graph svg");
  if (!svg) { showToast("Nothing to export", "error"); return; }
  var bg = getComputedStyle(document.documentElement).getPropertyValue("--color-bg-primary").trim() || "#ffffff";
  var holder = document.createElement("div");
  holder.style.cssText = "position:fixed;left:-100000px;top:0;padding:12px 16px;background:" + bg + ";width:" + svg.getAttribute("width") + "px";
  holder.innerHTML = svg.outerHTML + _TR_PATH_LEGEND_HTML;
  holder.querySelectorAll(".chart-hit").forEach(function (el) { el.remove(); });
  document.body.appendChild(holder);
  // `style` applies to the capture's clone only: it drops the holder's
  // off-screen offset so the clone is not drawn 100000 px to the left.
  htmlToImage.toBlob(holder, { pixelRatio: 2, backgroundColor: bg, style: { position: "static", left: "0" } })
    .then(function (blob) { holder.remove(); return blob ? copyPngToClipboard(blob) : false; },
      function (err) { holder.remove(); throw err; })
    .then(function (ok) {
      showToast(ok ? "Screenshot copied to clipboard" : "Screenshot failed — requires HTTPS or clipboard permission", ok ? "success" : "error");
    }, function () { showToast("Screenshot failed", "error"); });
}
