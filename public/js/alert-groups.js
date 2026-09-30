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
 * ── What this screen does NOT edit yet ───────────────────────────────────────
 *
 * A group's notify actions and escalation chain use the same shapes an
 * automation's do, and the API accepts both — but there is no editor for them
 * here. This screen manages membership, the reminder cadence, the ack-note
 * policy and the alert text; recipients and chains have to be set through the
 * API, or the group runs with whatever it was seeded with. `tellsSummary`
 * below reads them so the list can at least SAY what a group will do.
 */
(function () {
  "use strict";

  var groups = [];
  var joinable = [];

  /** `permAtLeast` is the page-wide helper in app.js (a global, not a
   *  namespace). Defaults to FALSE when it is somehow absent: hiding a control
   *  the caller may actually hold is recoverable, showing one they do not is a
   *  403 they cannot explain. */
  function canEdit() {
    return typeof permAtLeast === "function" && permAtLeast("automationManagement", "write");
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
      // badge-active / badge-deprecated are the real classes (styles.css);
      // there is no badge-success.
      "<td>" + (g.enabled
        ? '<span class="badge badge-active">Active</span>'
        : '<span class="badge badge-deprecated">Off</span> <span style="font-size:0.78rem;color:var(--color-text-tertiary)">members deliver on their own</span>') + "</td>" +
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

  /** Does this stored scope mean "every device"? Null, absent and
   *  `{allAssets:true}` all do — the three shapes a group has carried. */
  function scopeIsAll(scope) {
    if (!scope || typeof scope !== "object") return true;
    if (scope.allAssets === true) return true;
    return !scope.condition;
  }

  async function openEditor(id) {
    var group = null;
    var vocab = null;
    try {
      if (id) group = await api.alertGroups.get(id);
      var jr = await api.alertGroups.joinable(id || undefined);
      joinable = (jr && jr.rules) || [];
      // The device-filter vocabulary must be IN HAND before the modal body is
      // assembled — the builder renders its field/operator selects from it —
      // so this awaits here and bails with a toast rather than opening a
      // dialog it cannot populate. Same contract every other consumer holds.
      vocab = await window.PolarisScopeVocabulary.load();
    } catch (err) {
      showToast((err && err.message) || "Failed to open the group", "error");
      return;
    }
    var g = group || { name: "", description: "", enabled: true, requireAckNote: false, messageTemplate: "", repeat: null, rules: [] };
    var selected = new Set((g.rules || []).map(function (r) { return r.id; }));

    // buildOverlay is POSITIONAL — (z, title, bodyHtml, footerHtml, onClose,
    // wide) — and returns { overlay, dialog, close }. The footer is raw HTML
    // whose buttons this function wires itself; there is no actions array.
    // 1300 is the rung for a dialog over a base modal (see app.js).
    var footer =
      '<button class="btn btn-secondary" id="ag-cancel" type="button">Cancel</button>' +
      '<button class="btn btn-primary" id="ag-save" type="button">' + (id ? "Save" : "Create group") + "</button>";
    var ov = buildOverlay(1300, id ? "Edit alert group" : "New alert group", editorHtml(g, selected), footer, null, true);

    // The device filter, through the SHARED builder — same module, same tree
    // shape and same server-side evaluator as the automation wizard's Devices
    // step. Nothing here holds a field list of its own.
    var CB = window.PolarisConditionBuilder;
    var scopeBuilder = CB.create({ meta: vocab.meta, valueOptions: vocab.valueOptions });
    var scopeHost = ov.overlay.querySelector("#ag-scope-builder");
    // `groupHtml` takes the TREE; `seedIfEmpty` takes the rendered CONTAINER
    // and drops one blank row in if the tree had none — so an operator who
    // unticks the box gets a row to fill rather than an empty panel.
    var storedTree = (g.scope && g.scope.condition) || { op: "and", children: [] };
    scopeHost.innerHTML = scopeBuilder.groupHtml(storedTree, 0);
    scopeBuilder.seedIfEmpty(scopeHost);
    scopeBuilder.wire(ov.overlay, "#ag-scope-builder");

    // The all-devices checkbox just hides the tree; it does NOT clear it, so
    // ticking it by mistake and un-ticking it again does not cost the
    // operator the filter they had built.
    var allBox = ov.overlay.querySelector("#ag-all-devices");
    allBox.addEventListener("change", function () {
      scopeHost.style.display = allBox.checked ? "none" : "";
    });

    ov.overlay.querySelector("#ag-cancel").addEventListener("click", function () { ov.close(); });
    var saveBtn = ov.overlay.querySelector("#ag-save");
    saveBtn.addEventListener("click", async function () {
      saveBtn.disabled = true;
      try {
        if (await save(id, ov, scopeBuilder, allBox)) ov.close();
      } finally {
        saveBtn.disabled = false;
      }
    });
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
      '<h4 style="margin:0 0 0.25rem;font-size:0.95rem">Which devices</h4>' +
      '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">' +
        "Where the folding applies. Each automation still watches whatever its own Devices step says — this decides which of those devices get <strong>one</strong> alert from this group. " +
        "On a device outside this filter, a member automation delivers on its own, exactly as it would ungrouped." +
      "</p>" +
      '<label style="display:block;font-weight:400;margin:0 0 0.4rem">' +
        '<input type="checkbox" id="ag-all-devices"' + (scopeIsAll(g.scope) ? " checked" : "") + "> Every device its automations cover" +
      "</label>" +
      '<div id="ag-scope-builder"' + (scopeIsAll(g.scope) ? ' style="display:none"' : "") + "></div>" +

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
      (r.enabled === false ? ' <span class="badge badge-deprecated">disabled</span>' : "") +
      (r.reason ? '<div style="font-size:0.75rem;color:var(--color-text-tertiary);margin-left:1.5rem">' + escapeHtml(r.reason) + "</div>" : "") +
    "</label>";
  }

  async function save(id, ov, scopeBuilder, allBox) {
    // Scope every read to THIS overlay: the Automations page has its own
    // form fields, and a document-wide lookup would find whichever matched
    // first. `ov.overlay` is the element buildOverlay returns.
    var root = ov && ov.overlay ? ov.overlay : document;
    var name = (root.querySelector("#ag-name") || {}).value || "";
    if (!name.trim()) { showToast("Give the group a name", "error"); return false; }
    var repeatMin = parseInt((root.querySelector("#ag-repeat") || {}).value, 10);

    // The device filter. An unticked "every device" box with an unbuildable
    // tree is refused rather than silently stored: `and([])` is true of every
    // asset, so storing it would quietly widen the group to the whole fleet —
    // the opposite of what someone unticking the box meant. Same trap the tag
    // filter documents; the shapes are identical and the meanings are opposite.
    var scope = { allAssets: true };
    if (allBox && !allBox.checked) {
      // collect() takes the ROOT GROUP ELEMENT, not a selector — DOM order is
      // the tree, so it walks the rendered markup.
      var groupEl = root.querySelector("#ag-scope-builder > .scg-group");
      if (!groupEl) { showToast("Build a device filter, or tick every device", "error"); return false; }
      var tree = scopeBuilder.collect(groupEl);
      var problem = scopeBuilder.validate(tree);
      if (problem) { showToast(problem, "error"); return false; }
      if (!tree || !(tree.children || []).length) {
        showToast("Add a condition to the device filter, or tick every device", "error");
        return false;
      }
      scope = { condition: tree };
    }

    var body = {
      scope: scope,
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
    // showConfirm takes a plain STRING and renders it with white-space:pre-wrap,
    // so the newlines below survive. There is no options object and no custom
    // button label.
    var ok = await showConfirm(
      "Delete alert group “" + impact.name + "”?\n\n" + lines.join("\n"),
    );
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
