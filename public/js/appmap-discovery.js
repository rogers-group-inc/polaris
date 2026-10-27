// appmap-discovery.js — the service & process DISCOVERY RULES list, rendered
// inline on Integrations → Polaris Agent (above the Polaris Agent card). Each
// rule pins process/service items for monitoring — or monitoring + the
// Application Map, per its mode — onto the assets its scope selects (now, and on
// assets discovered later via the reconcileAppMapAutoMap job).
//
// This file owns the LIST; the builder lives in appmap-rules-wizard.js. Same
// split as automations.js / automations-wizard.js. The list used to be a modal
// opened from the Application Map's Discovery button; it moved here because the
// inventory the rules select from is agent-fed, and because monitor-only rules
// have nothing to do with the map. The Application Map's empty state points
// operators at this card.
//
// Two rule sources render side by side:
//   - manual rules, authored in the wizard (+ Add Rule);
//   - AUTO rules, minted server-side when an operator ticks a Monitor/Map
//     checkbox on an asset's Services tab. Auto rules are single-item, target
//     the specific assets whose checkboxes created them, and consolidate — the
//     same item pinned on a second asset joins the existing auto rule. They wear
//     an "Auto" badge to set them apart; editing one in the wizard converts it
//     to manual.
//
// Asymmetry worth knowing while reading this: removing an item from a rule, or
// disabling/deleting the rule, stops FUTURE auto-pinning — it does not
// retroactively unpin, because the pin arrays are operator-owned and someone may
// have pinned a name by hand. (The one exception: un-ticking the checkbox on an
// asset takes that asset off the matching AUTO rules, so the reconcile can't
// fight the operator.)

/* global showToast, showConfirm, escapeHtml, permAtLeast, api, openAppMapRuleWizard */

(function () {
  "use strict";

  var rules = [];
  var assetLabels = {};
  var containerEl = null;

  function canWrite() {
    return typeof permAtLeast === "function" &&
      permAtLeast("applicationMap", "write") && permAtLeast("assets", "write");
  }

  function scopeSummary(r) {
    var parts = [];
    if (r.scope && Array.isArray(r.scope.children)) {
      // The condition tree (the wizard's shared device filter). Count its
      // leaves; name the first one.
      var leaves = [];
      (function walk(g) {
        (g.children || []).forEach(function (c) {
          if (Array.isArray(c.children)) walk(c); else leaves.push(c);
        });
      })(r.scope);
      if (leaves.length) {
        var lead = leaves[0].field + " " + leaves[0].operator + " " + leaves[0].value;
        parts.push(leaves.length === 1 ? lead : lead + " +" + (leaves.length - 1) + " more");
      }
    } else if (r.scope && (r.scope.rules || []).length) {
      var n = r.scope.rules.length;
      var first = r.scope.rules[0];
      var label = first.field === "subnet"
        ? "IP in " + (first.cidrs || []).join(", ")
        : first.field + " " + first.op + " " + (first.values || []).join(", ");
      parts.push(n === 1 ? label : label + " +" + (n - 1) + " more");
    }
    var ids = r.assetIds || [];
    if (ids.length) {
      var names = ids.map(function (id) { return assetLabels[id] || id; });
      parts.push(names.length <= 2 ? names.join(", ") : names.slice(0, 2).join(", ") + " +" + (names.length - 2) + " more");
    }
    if (!parts.length) return "All workstations & servers";
    return parts.join(" · ");
  }

  function itemSummary(r) {
    var svc = (r.services && r.services.names) || [];
    var proc = (r.processes && r.processes.names) || [];
    var pat = ((r.services && r.services.patterns) || []).length +
              ((r.processes && r.processes.patterns) || []).length;
    var parts = [];
    if (svc.length) parts.push(svc.length + " service" + (svc.length === 1 ? "" : "s"));
    if (proc.length) parts.push(proc.length + " process" + (proc.length === 1 ? "" : "es"));
    if (pat) parts.push(pat + " pattern" + (pat === 1 ? "" : "s"));
    return parts.length ? parts.join(" · ") : "—";
  }

  function bodyHTML() {
    return '' +
      '<div style="display:flex;justify-content:flex-end;margin-bottom:0.6rem">' +
        (canWrite() ? '<button type="button" class="btn btn-primary btn-sm" id="apd-add">+ Add Rule</button>' : "") +
      '</div>' +
      '<div class="table-wrapper" style="max-height:46vh;overflow:auto">' +
        '<table class="data-table" style="margin:0">' +
          '<thead><tr>' +
            '<th style="width:4rem">On</th>' +
            '<th>Rule</th>' +
            '<th style="width:9.5rem">Type</th>' +
            '<th>Devices</th>' +
            '<th>Items</th>' +
            '<th style="width:8rem"></th>' +
          '</tr></thead>' +
          '<tbody id="apd-tbody"><tr><td colspan="6" class="empty-state">Loading…</td></tr></tbody>' +
        '</table>' +
      '</div>';
  }

  function renderRows() {
    var tbody = document.getElementById("apd-tbody");
    if (!tbody) return;
    if (!rules.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state">' +
        (canWrite()
          ? "No discovery rules yet. Add one to choose which devices get which processes and services " +
            "monitored (and optionally mapped) — or tick Monitor/Map on an asset's Services tab and a " +
            "rule appears here automatically."
          : "No discovery rules configured.") +
        "</td></tr>";
      return;
    }
    var dis = canWrite() ? "" : " disabled";
    tbody.innerHTML = rules.map(function (r) {
      var autoBadge = r.source === "auto"
        ? ' <span class="badge badge-auto-rule" title="Created automatically from a Monitor/Map checkbox on an asset’s Services tab. Consolidates as more assets pin the same item; editing it makes it manual.">Auto</span>'
        : "";
      return "<tr>" +
        '<td><label class="toggle-switch" title="' +
          (r.enabled ? "Enabled — stops pinning new items when turned off" : "Disabled") + '">' +
          '<input type="checkbox" class="apd-toggle" data-id="' + escapeHtml(r.id) + '"' +
            (r.enabled ? " checked" : "") + dis + ">" +
          '<span class="toggle-slider"></span></label></td>' +
        '<td><a href="#" class="apd-edit-link" data-id="' + escapeHtml(r.id) + '">' + escapeHtml(r.name) + "</a>" + autoBadge + "</td>" +
        "<td>" + (r.mode === "monitor" ? "Monitor only" : "Monitor + map") + "</td>" +
        "<td>" + escapeHtml(scopeSummary(r)) + "</td>" +
        "<td>" + escapeHtml(itemSummary(r)) + "</td>" +
        '<td style="white-space:nowrap">' +
          '<button type="button" class="btn btn-secondary btn-sm apd-edit" data-id="' + escapeHtml(r.id) + '"' + dis + ">Edit</button> " +
          '<button type="button" class="btn btn-secondary btn-sm apd-delete" data-id="' + escapeHtml(r.id) + '"' + dis + ">Delete</button>" +
        "</td>" +
      "</tr>";
    }).join("");
  }

  // Every write PUTs the whole rule set — the endpoint validates and applies the
  // complete config (cross-rule name/id uniqueness can't be checked per-rule), and
  // applying is what makes pins land immediately instead of waiting for the tick.
  async function persist(nextRules, successMsg) {
    var res = await api.applicationMap.saveDiscovery(nextRules);
    rules = res.rules || [];
    assetLabels = res.assetLabels || assetLabels;
    var a = res.applied || {};
    var mapped = (a.processPins || 0) + (a.servicePins || 0);
    // A monitor-only rule maps nothing, so "pinned 0 item(s) (+3 for monitoring)"
    // would read like a failure — say what actually happened instead.
    var pinned = mapped
      ? mapped + " item(s)" + (a.monitorPins ? " (+" + a.monitorPins + " for monitoring)" : "")
      : (a.monitorPins || 0) + " item(s) for monitoring";
    showToast(
      a.devices ? successMsg + " — pinned " + pinned + " on " + a.devices + " device(s)" : successMsg,
      "success",
    );
    // If the Application Map page is open in this tab (it isn't, on the
    // Integrations page), reflect the pin changes without a manual refresh.
    if (typeof window.appMapReload === "function") window.appMapReload();
    return res;
  }

  // Called by the wizard on save. Upsert by id so Edit replaces in place.
  window.appMapRulesSaveOne = async function appMapRulesSaveOne(rule) {
    var next = rules.slice();
    var idx = rule.id ? next.findIndex(function (r) { return r.id === rule.id; }) : -1;
    if (idx >= 0) next[idx] = rule; else next.push(rule);
    await persist(next, idx >= 0 ? "Rule updated" : "Rule created");
    renderRows();
  };

  function wire() {
    var add = document.getElementById("apd-add");
    if (add) {
      add.addEventListener("click", function () {
        if (typeof openAppMapRuleWizard === "function") openAppMapRuleWizard(null);
      });
    }
    var tbody = document.getElementById("apd-tbody");
    if (!tbody) return;

    tbody.addEventListener("click", async function (ev) {
      var editEl = ev.target.closest ? ev.target.closest(".apd-edit, .apd-edit-link") : null;
      if (editEl) {
        ev.preventDefault();
        if (!canWrite()) return;
        var id = editEl.getAttribute("data-id");
        var hit = rules.filter(function (r) { return r.id === id; })[0];
        if (hit && typeof openAppMapRuleWizard === "function") openAppMapRuleWizard(hit);
        return;
      }
      var del = ev.target.closest ? ev.target.closest(".apd-delete") : null;
      if (del) {
        var did = del.getAttribute("data-id");
        var row = rules.filter(function (r) { return r.id === did; })[0];
        if (!row) return;
        var ok = await showConfirm(
          'Delete the discovery rule "' + row.name + '"? Devices it already pinned keep their pins — ' +
          "deleting only stops future auto-pinning.",
        );
        if (!ok) return;
        del.disabled = true;
        try {
          await persist(rules.filter(function (r) { return r.id !== did; }), "Rule deleted");
          renderRows();
        } catch (err) {
          showToast("Delete failed: " + (err && err.message ? err.message : String(err)), "error");
          del.disabled = false;
        }
      }
    });

    tbody.addEventListener("change", async function (ev) {
      var cb = ev.target.closest ? ev.target.closest(".apd-toggle") : null;
      if (!cb) return;
      var id = cb.getAttribute("data-id");
      var next = rules.map(function (r) {
        return r.id === id ? Object.assign({}, r, { enabled: cb.checked }) : r;
      });
      try {
        await persist(next, cb.checked ? "Rule enabled" : "Rule disabled");
        renderRows();
      } catch (err) {
        showToast("Update failed: " + (err && err.message ? err.message : String(err)), "error");
        cb.checked = !cb.checked; // revert the optimistic flip
      }
    });
  }

  async function reload() {
    var cfg = await api.applicationMap.discovery();
    rules = (cfg && cfg.rules) || [];
    assetLabels = (cfg && cfg.assetLabels) || {};
    // Published by the server so the wizard's asset-type picker can't offer a type
    // no rule could ever match — rather than keeping a second copy of the constant
    // in sync on the client.
    window.appMapProcessCapableTypes = (cfg && cfg.processCapableAssetTypes) || null;
    renderRows();
  }

  // Entry point: render the card body into #agent-discovery-rules-body on the
  // Integrations page's Polaris Agent tab. Idempotent per page load (the tab's
  // lazy-init guard calls it once). Reading the rule set requires
  // applicationMap:read; a 403 degrades to an explanatory line instead of an
  // empty card.
  async function initDiscoveryRulesCard() {
    containerEl = document.getElementById("agent-discovery-rules-body");
    if (!containerEl) return;
    if (typeof permAtLeast === "function" && !permAtLeast("applicationMap", "read")) {
      containerEl.innerHTML =
        '<p class="empty-state" style="padding:0.5rem 0">You don’t have permission to view discovery rules.</p>';
      return;
    }
    containerEl.innerHTML = bodyHTML();
    wire();
    try {
      await reload();
    } catch (err) {
      var tbody = document.getElementById("apd-tbody");
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Failed to load: ' +
          escapeHtml(err && err.message ? err.message : String(err)) + "</td></tr>";
      }
    }
  }

  window.PolarisDiscoveryRules = { init: initDiscoveryRulesCard };
})();
