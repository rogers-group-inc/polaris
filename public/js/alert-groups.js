/* global api, escapeHtml, showToast, showConfirm, buildOverlay */
/**
 * public/js/alert-groups.js — the Automations page's "Alert Groups" tab.
 *
 * An AlertGroup (business rule 75) is a named set of automations whose alerts
 * about ONE device fold into a single alert. The group owns DELIVERY — who is
 * told, how it escalates, how often it reminds, whether closing it out needs a
 * note — while its member automations keep owning DETECTION.
 *
 * Exposed as `window.PolarisAlertGroups`; the page calls `renderTab()` when the
 * tab activates and `openEditor(id)` from the New button and the row menu.
 *
 * ── Why the member picker is the centre of this screen ───────────────────────
 *
 * Everything else here is a handful of fields. The membership is the decision:
 * it is what turns three separate pages at 02:00 into one. So the picker lists
 * EVERY automation and says, per row, why one cannot join rather than quietly
 * omitting it — an operator hunting for "Agent disconnected" and not finding it
 * would reasonably conclude the list was broken, when the real answer is that
 * an event automation keeps no state a shared alert could resolve.
 *
 * ── Recipients ───────────────────────────────────────────────────────────────
 *
 * A group's notify actions use the SAME shape as an automation's, so they are
 * seeded from the first member on create and edited here through the shared
 * recipient pills (`PolarisAutomationRecipients`). Escalation tiers are
 * accepted by the API but have no editor on this screen yet — a group created
 * here reminds and notifies; a chain has to be authored through the API.
 */
(function () {
  "use strict";

  var groups = [];
  var joinable = [];

  function canEdit() {
    return !!(window.PolarisPerms && window.PolarisPerms.atLeast
      ? window.PolarisPerms.atLeast("automationManagement", "fullwrite")
      : true);
  }

  // ── List ───────────────────────────────────────────────────────────────────

  async function renderTab() {
    var host = document.getElementById("ag-list");
    if (!host) return;
    host.innerHTML = '<p class="empty-state">Loading...</p>';
    try {
      var res = await api.alertGroups.list();
      groups = (res && res.groups) || [];
    } catch (err) {
      host.innerHTML = '<p class="empty-state">' + escapeHtml((err && err.message) || "Failed to load alert groups") + "</p>";
      return;
    }
    if (!groups.length) {
      host.innerHTML =
        '<div class="empty-state" style="padding:2rem 1rem;text-align:center">' +
          "<p style=\"margin:0 0 0.5rem\">No alert groups yet.</p>" +
          '<p style="margin:0;font-size:0.85rem;color:var(--color-text-tertiary);max-width:52ch;margin-inline:auto">' +
            "A group is worth making when several automations watch the same kind of device — a PoE fault, a chassis temperature and a dead uplink on one switch are one problem to whoever is holding the pager." +
          "</p>" +
        "</div>";
      return;
    }
    host.innerHTML =
      '<table class="data-table"><thead><tr>' +
        "<th>Group</th><th>Automations</th><th>Tells</th><th>Status</th><th></th>" +
      "</tr></thead><tbody>" +
      groups.map(rowHtml).join("") +
      "</tbody></table>";
    host.querySelectorAll("[data-ag-edit]").forEach(function (el) {
      el.addEventListener("click", function () { openEditor(el.getAttribute("data-ag-edit")); });
    });
    host.querySelectorAll("[data-ag-delete]").forEach(function (el) {
      el.addEventListener("click", function () { confirmDelete(el.getAttribute("data-ag-delete")); });
    });
  }

  function rowHtml(g) {
    var members = g.rules || [];
    var memberText = members.length
      ? members.slice(0, 3).map(function (r) { return escapeHtml(r.name); }).join(", ") +
        (members.length > 3 ? " <span style=\"color:var(--color-text-tertiary)\">and " + (members.length - 3) + " more</span>" : "")
      : '<span style="color:var(--color-text-tertiary)">none yet — this group folds nothing</span>';
    return "<tr>" +
      "<td><strong>" + escapeHtml(g.name) + "</strong>" +
        (g.description ? '<div style="font-size:0.8rem;color:var(--color-text-tertiary)">' + escapeHtml(g.description) + "</div>" : "") +
      "</td>" +
      "<td>" + memberText + "</td>" +
      "<td>" + escapeHtml(tellsSummary(g)) + "</td>" +
      "<td>" + (g.enabled
        ? '<span class="badge badge-success">Active</span>'
        : '<span class="badge">Off</span> <span style="font-size:0.78rem;color:var(--color-text-tertiary)">members deliver on their own</span>') + "</td>" +
      '<td style="text-align:right;white-space:nowrap">' +
        (canEdit()
          ? '<button type="button" class="btn btn-sm" data-ag-edit="' + escapeHtml(g.id) + '">Edit</button> ' +
            '<button type="button" class="btn btn-sm btn-danger" data-ag-delete="' + escapeHtml(g.id) + '">Delete</button>'
          : "") +
      "</td>" +
    "</tr>";
  }

  /** One line saying what this group actually DOES when something breaks —
   *  the column an operator scans to find the group that pages the wrong team. */
  function tellsSummary(g) {
    var bits = [];
    var actions = Array.isArray(g.actions) ? g.actions : [];
    var notifies = actions.filter(function (a) { return a && a.type === "notify"; });
    if (notifies.length) {
      var labels = window.PolarisAutomationRecipients && window.PolarisAutomationRecipients.recipientDisplayLabels
        ? window.PolarisAutomationRecipients.recipientDisplayLabels(notifies[0])
        : [];
      bits.push(labels.length ? labels.join(", ") : "notifies");
    }
    if (g.repeat && g.repeat.everyMin) bits.push("reminds every " + g.repeat.everyMin + " min");
    if (g.requireAckNote) bits.push("note required");
    return bits.length ? bits.join(" · ") : "nothing yet";
  }

  // ── Editor ─────────────────────────────────────────────────────────────────

  async function openEditor(id) {
    var group = null;
    try {
      if (id) group = await api.alertGroups.get(id);
      var jr = await api.alertGroups.joinable(id || undefined);
      joinable = (jr && jr.rules) || [];
    } catch (err) {
      showToast((err && err.message) || "Failed to open the group", "error");
      return;
    }
    var g = group || { name: "", description: "", enabled: true, requireAckNote: false, messageTemplate: "", repeat: null, rules: [] };
    var selected = new Set((g.rules || []).map(function (r) { return r.id; }));

    var overlay = buildOverlay({
      title: id ? "Edit alert group" : "New alert group",
      width: "760px",
      body: editorHtml(g, selected),
      actions: [
        { label: "Cancel", kind: "secondary", close: true },
        { label: id ? "Save" : "Create group", kind: "primary", onClick: function (ov) { return save(id, ov); } },
      ],
    });
    wireEditor(overlay);
  }

  function editorHtml(g, selected) {
    return (
      '<div class="form-group"><label>Name</label>' +
        '<input type="text" id="ag-name" value="' + escapeHtml(g.name || "") + '" placeholder="e.g. Switch health" style="width:100%"></div>' +
      '<div class="form-group"><label>Description (optional)</label>' +
        '<input type="text" id="ag-desc" value="' + escapeHtml(g.description || "") + '" style="width:100%"></div>' +

      '<div class="form-group">' +
        '<label style="font-weight:400"><input type="checkbox" id="ag-enabled"' + (g.enabled !== false ? " checked" : "") + "> Active</label>" +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 1.4rem">' +
          "Turning a group off does not turn its automations off — they go back to delivering on their own, and their live alerts are retired so the next check re-raises them that way." +
        "</p>" +
      "</div>" +

      "<hr style=\"border:0;border-top:1px solid var(--color-border);margin:1rem 0\">" +
      '<h4 style="margin:0 0 0.25rem;font-size:0.95rem">Automations in this group</h4>' +
      '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">' +
        "Whatever these raise about one device becomes one alert. Each automation keeps deciding what to watch for; the group decides who hears about it." +
      "</p>" +
      '<div id="ag-members" style="max-height:260px;overflow:auto;border:1px solid var(--color-border);border-radius:6px;padding:0.5rem">' +
        (joinable.length ? joinable.map(function (r) { return memberRowHtml(r, selected); }).join("") : '<p class="empty-state">No automations yet.</p>') +
      "</div>" +

      "<hr style=\"border:0;border-top:1px solid var(--color-border);margin:1rem 0\">" +
      '<h4 style="margin:0 0 0.5rem;font-size:0.95rem">What the group does when something breaks</h4>' +
      '<div class="form-group"><label>Alert text (optional)</label>' +
        '<input type="text" id="ag-msg" value="' + escapeHtml(g.messageTemplate || "") + '" placeholder="{asset}: {dimension.count} problems — {dimension}" style="width:100%">' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0">' +
          "Leave blank for the default. <code>{dimension}</code> lists every affected component, <code>{dimension.count}</code> is how many." +
        "</p>" +
      "</div>" +
      '<div class="form-group"><label style="font-weight:400">' +
        '<input type="checkbox" id="ag-ack-note"' + (g.requireAckNote ? " checked" : "") + "> Require a note when acknowledging</label></div>" +
      '<div class="form-group"><label>Remind while unhandled</label>' +
        '<div style="display:flex;align-items:center;gap:0.5rem">' +
          "every <input type=\"number\" id=\"ag-repeat\" min=\"5\" max=\"1440\" value=\"" + (g.repeat && g.repeat.everyMin ? g.repeat.everyMin : "") + '" placeholder="off" style="width:90px"> minutes' +
        "</div>" +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0">Blank = no reminders. Stops on acknowledge.</p>' +
      "</div>" +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.75rem 0 0">' +
        "<strong>Recipients</strong> are seeded from the first automation you add, and escalation chains are carried over with them. Editing either in this screen is not built yet — adjust them on the automation you seeded from, or through the API." +
      "</p>"
    );
  }

  function memberRowHtml(r, selected) {
    var checked = selected.has(r.id);
    var disabled = !r.selectable && !checked;
    return '<label style="display:block;padding:0.3rem 0.2rem;' + (disabled ? "opacity:0.55;" : "") + '">' +
      '<input type="checkbox" class="ag-member" value="' + escapeHtml(r.id) + '"' +
        (checked ? " checked" : "") + (disabled ? " disabled" : "") + "> " +
      escapeHtml(r.name) +
      (r.enabled === false ? ' <span class="badge">disabled</span>' : "") +
      (r.reason ? '<div style="font-size:0.75rem;color:var(--color-text-tertiary);margin-left:1.5rem">' + escapeHtml(r.reason) + "</div>" : "") +
    "</label>";
  }

  function wireEditor(overlay) {
    // Nothing dynamic yet beyond the checkboxes, which need no wiring — kept
    // as a seam so the recipient editor has somewhere to attach.
    void overlay;
  }

  async function save(id, overlay) {
    var root = overlay && overlay.el ? overlay.el : document;
    var name = (root.querySelector("#ag-name") || {}).value || "";
    if (!name.trim()) { showToast("Give the group a name", "error"); return false; }
    var repeatMin = parseInt((root.querySelector("#ag-repeat") || {}).value, 10);
    var body = {
      name: name.trim(),
      description: ((root.querySelector("#ag-desc") || {}).value || "").trim() || null,
      enabled: !!(root.querySelector("#ag-enabled") || {}).checked,
      requireAckNote: !!(root.querySelector("#ag-ack-note") || {}).checked,
      messageTemplate: ((root.querySelector("#ag-msg") || {}).value || "").trim() || null,
      repeat: repeatMin >= 5 ? { everyMin: repeatMin, stopOn: "acknowledge" } : null,
      ruleIds: Array.prototype.slice.call(root.querySelectorAll(".ag-member:checked")).map(function (el) { return el.value; }),
    };
    try {
      if (id) await api.alertGroups.update(id, body);
      else await api.alertGroups.create(body);
      showToast(id ? "Alert group saved" : "Alert group created", "success");
      renderTab();
      return true;
    } catch (err) {
      showToast((err && err.message) || "Failed to save the group", "error");
      return false;
    }
  }

  async function confirmDelete(id) {
    var impact;
    try {
      impact = await api.alertGroups.removalImpact(id);
    } catch (err) {
      showToast((err && err.message) || "Failed to check what this would affect", "error");
      return;
    }
    // Say what breaks BEFORE it breaks. The automations survive a delete, but
    // any of them with no notify action of their own were relying on the group
    // to do the telling — and would go silent without saying so.
    var lines = [
      impact.rules.length
        ? impact.rules.length + " automation(s) go back to delivering on their own."
        : "This group has no automations.",
    ];
    if (impact.liveAlerts) lines.push(impact.liveAlerts + " live alert(s) will be retired and re-raised by the next check.");
    if (impact.rulesWithNoOwnDelivery && impact.rulesWithNoOwnDelivery.length) {
      lines.push("⚠ These have no notify action of their own and will tell nobody until you give them one: " +
        impact.rulesWithNoOwnDelivery.map(function (r) { return r.name; }).join(", ") + ".");
    }
    var ok = await showConfirm({
      title: "Delete alert group “" + impact.name + "”?",
      message: lines.join("\n"),
      confirmLabel: "Delete group",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.alertGroups.delete(id);
      showToast("Alert group deleted", "success");
      renderTab();
    } catch (err) {
      showToast((err && err.message) || "Failed to delete the group", "error");
    }
  }

  window.PolarisAlertGroups = { renderTab: renderTab, openEditor: openEditor };
})();
