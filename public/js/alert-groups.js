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
  /** Business rule 194: the path-check catalog (id, name) the editor offers. */
  var pathChecks = [];

  /** The "One alert per" choices, in the order the editor lists them. The
   *  values are the server's ALERT_GROUP_FOLD_BY; `badge` is what the list
   *  shows beside a group that folds any way but the default. */
  var FOLD_OPTIONS = [
    { value: "device", label: "Device", badge: "per device", hint: "everything wrong with one device is one alert" },
    { value: "automation", label: "Automation", badge: "per automation", hint: "every device one automation trips shares that automation's alert (a Path Monitor automation: one alert per path check)" },
    { value: "deviceAutomation", label: "Device + automation", badge: "whole group", hint: "both at once: every device and every automation in the group share one alert (\"3 path checks · 80 devices\")" },
    { value: "subnet", label: "Subnet", badge: "per subnet", hint: "every device in the same subnet shares one alert" },
  ];

  /** The option for a stored value, falling back to Device for anything this
   *  page does not know (a row saved before the column existed reads "device"). */
  function foldOptionOf(value) {
    return FOLD_OPTIONS.find(function (o) { return o.value === value; }) || FOLD_OPTIONS[0];
  }

  function foldByOf(g) {
    return foldOptionOf(g && g.foldBy).value;
  }

  /** Business rule 193: the percent threshold applies only to a fold that
   *  puts several devices in one alert — the server stores null otherwise. */
  function foldSpansDevices(value) {
    return value === "automation" || value === "deviceAutomation" || value === "subnet";
  }

  /** The stored threshold, or null when off or meaningless for the fold. */
  function minPercentOf(g) {
    var p = g && g.minFailingPercent;
    return foldSpansDevices(foldByOf(g)) && typeof p === "number" && p >= 1 && p <= 100 ? p : null;
  }

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
        "<th>Group</th><th>Automations</th><th>Tells</th><th>Enabled</th>" +
      "</tr></thead><tbody>" +
      groups.map(rowHtml).join("") +
      "</tbody></table>";
    host.querySelectorAll(".ag-enabled-toggle").forEach(function (cb) {
      cb.addEventListener("change", function () { toggleEnabled(cb); });
    });
    // The name is the row's one trigger (canon: Row context menu): a left click
    // runs the primary verb, a right click anywhere on the row — replayed by
    // app.js through `data-row-menu-row` — shows the menu. ONE delegated
    // listener on the host, bound once: the table is repainted on every load.
    if (host.dataset.agMenuWired !== "1") {
      host.dataset.agMenuWired = "1";
      host.addEventListener("click", function (e) {
        var b = e.target && typeof e.target.closest === "function" ? e.target.closest(".ag-menu") : null;
        if (b && host.contains(b)) onGroupMenu(b);
      });
    }
  }

  // ── Row menu ───────────────────────────────────────────────────────────────

  /** Edit (primary) / Clone / View code / Export / Delete for an editor; View
   *  code (primary) / Export for a read-only role — the Automations list's set. */
  function onGroupMenu(b) {
    var g = groups.find(function (x) { return x.id === b.getAttribute("data-id"); });
    if (!g) return;
    var P = window.PolarisAutomationPortability;
    var code = P ? [
      { label: "View code", primary: !canEdit(), title: "See and edit this alert group as JSON", onSelect: function () { openCodeFor(g); } },
      { label: "Export", title: "Download this alert group as a portable file", onSelect: function () { exportGroup(g); } },
    ] : [];
    if (!canEdit()) {
      if (code.length) showRowMenu(b, code, { label: "Actions for " + g.name });
      return;
    }
    showRowMenu(b, [
      { label: "Edit", primary: true, onSelect: function () { openEditor(g.id); } },
      { label: "Clone", title: "Create a copy of this group with no automations in it", onSelect: function () { cloneGroupRow(g); } },
    ].concat(code.length ? [{ separator: true }].concat(code) : [], [
      { separator: true },
      { label: "Delete", danger: true, onSelect: function () { confirmDelete(g.id); } },
    ]), { label: "Actions for " + g.name });
  }

  /** "<name> (copy)", "(copy 2)" … — the Automations list's namer when the
   *  page has it, so the two Clone verbs name copies the same way. */
  function copyName(name) {
    var taken = groups.map(function (x) { return x.name; });
    if (typeof window._automationCloneName === "function") return window._automationCloneName(name, taken);
    return String(name || "Alert group") + " (copy)";
  }

  /** The copy is made SERVER-side (masked webhook headers copy as stored), with
   *  no automations — each belongs to one group — and then opened for editing. */
  async function cloneGroupRow(g) {
    try {
      var copy = await api.alertGroups.clone(g.id, copyName(g.name));
      showToast("Copied. Add automations to “" + copy.name + "” to put it to work.", "success");
      await renderTab();
      openEditor(copy.id);
    } catch (err) {
      showToast((err && err.message) || "Failed to copy the group", "error");
    }
  }

  /** A listed row as the PUT body: every plain field explicit (PUT replaces
   *  them), membership as `ruleIds`. Server-owned fields are dropped by the
   *  code view itself (`forCodeView`). */
  function groupToInput(g) {
    return {
      name: g.name,
      description: g.description == null ? null : g.description,
      enabled: g.enabled !== false,
      scope: g.scope == null ? null : g.scope,
      foldBy: foldByOf(g),
      minFailingPercent: minPercentOf(g),
      pathCheckIds: Array.isArray(g.pathCheckIds) ? g.pathCheckIds : [],
      messageTemplate: g.messageTemplate == null ? null : g.messageTemplate,
      requireAckNote: !!g.requireAckNote,
      emailComposition: g.emailComposition == null ? null : g.emailComposition,
      actions: g.actions == null ? null : g.actions,
      resetActions: g.resetActions == null ? null : g.resetActions,
      escalation: g.escalation == null ? null : g.escalation,
      repeat: g.repeat == null ? null : g.repeat,
      ruleIds: (g.rules || []).map(function (r) { return r.id; }),
    };
  }

  /** The keys whose change the code view's Save confirms. */
  var GROUP_DIFF_KEYS = ["enabled", "scope", "foldBy", "minFailingPercent", "pathCheckIds", "ruleIds", "actions", "escalation", "resetActions", "emailComposition"];

  function openCodeFor(g) {
    var P = window.PolarisAutomationPortability;
    if (!P) return;
    P.openCodeModal({
      title: "Code for “" + g.name + "”",
      noun: "alert group",
      body: groupToInput(g),
      diffKeys: GROUP_DIFF_KEYS,
      defaultsNote: "<code>enabled</code> turns on and <code>ruleIds</code> empties if you delete them, not keep their current values. Changing <code>scope</code>, <code>foldBy</code>, <code>pathCheckIds</code> or turning the group off retires its open alerts.",
      canSave: canEdit(),
      // Exports what is in the textarea, so an edit can leave without being saved.
      onExport: function (edited) { exportGroup(inputToRow(edited, g)); },
      onSave: canEdit() ? async function (edited) {
        await api.alertGroups.update(g.id, edited);
        showToast("Alert group saved", "success");
        renderTab();
      } : null,
    });
  }

  /** An edited PUT body back into the row shape the exporter reads: member
   *  ids named from every group's members the list knows. */
  function inputToRow(body, g) {
    var names = {};
    groups.forEach(function (x) { (x.rules || []).forEach(function (r) { names[r.id] = r.name; }); });
    (joinable || []).forEach(function (r) { names[r.id] = r.name; });
    var row = Object.assign({}, body);
    row.rules = (Array.isArray(body.ruleIds) ? body.ruleIds : []).map(function (id) { return { id: id, name: names[id] || id }; });
    return row;
  }

  /** Download one group as a portable `.alert-group.json`: members and path
   *  checks by name, delivery wiring as named dependencies. */
  async function exportGroup(g) {
    var P = window.PolarisAutomationPortability;
    if (!P || !P.buildGroupExportFile) { showToast("Export is not available on this page", "error"); return; }
    var cat = typeof window._automationPortabilityCatalogs === "function" ? window._automationPortabilityCatalogs() : {};
    if (!(cat.pathChecks && cat.pathChecks.length) && Array.isArray(g.pathCheckIds) && g.pathCheckIds.length) {
      try {
        var schema = await api.automations.schema();
        cat = Object.assign({}, cat, { pathChecks: (schema && schema.pathChecks) || [] });
      } catch (_e) { /* names degrade to ids, flagged unresolved in the file */ }
    }
    var file = P.buildGroupExportFile(g, cat, { polarisVersion: window.polarisVersion || undefined });
    window.downloadJson(file, P.groupFilenameForExport(g.name));
    var deps = (file.dependencies || []).length;
    showToast(deps
      ? "Exported. The file lists " + deps + " thing" + (deps === 1 ? "" : "s") + " it needs — delivery wiring is not included."
      : "Exported.", "success");
  }

  function rowHtml(g) {
    var members = g.rules || [];
    var memberText = members.length
      ? members.slice(0, 3).map(function (r) { return escapeHtml(r.name); }).join(", ") +
        (members.length > 3 ? " <span style=\"color:var(--color-text-tertiary)\">and " + (members.length - 3) + " more</span>" : "")
      : '<span style="color:var(--color-text-tertiary)">none yet — this group folds nothing</span>';
    // Standard row gestures: the name opens (Edit, or View code read-only),
    // a right click anywhere on the row is the menu, a double click opens.
    return "<tr data-row-menu-row>" +
      '<td><button type="button" class="row-menu-trigger ag-menu" data-id="' + escapeHtml(g.id) + '" ' +
        'aria-haspopup="menu" aria-expanded="false" title="' + (canEdit() ? "Actions for this group" : "View this group") + '"><strong>' + escapeHtml(g.name) + "</strong></button>" +
        (foldByOf(g) !== "device" ? ' <span class="badge">' + escapeHtml(foldOptionOf(foldByOf(g)).badge) + "</span>" : "") +
        (g.pathCheckIds && g.pathCheckIds.length ? ' <span class="badge" title="Governs only these path checks">' + g.pathCheckIds.length + " path check" + (g.pathCheckIds.length === 1 ? "" : "s") + "</span>" : "") +
        (minPercentOf(g) ? ' <span class="badge" title="No alert until at least this share of the devices reporting is failing">≥ ' + minPercentOf(g) + "% failing</span>" : "") +
        (g.description ? '<div style="font-size:0.8rem;color:var(--color-text-tertiary)">' + escapeHtml(g.description) + "</div>" : "") +
      "</td>" +
      "<td>" + memberText + "</td>" +
      "<td>" + escapeHtml(tellsSummary(g)) + "</td>" +
      // Enabled — the same switch the Automations list uses for editors; a
      // static Yes / No for everyone else.
      "<td style=\"white-space:nowrap\">" + (canEdit()
        ? '<label class="toggle-switch" title="' + (g.enabled ? "Enabled — click to disable" : "Disabled — click to enable") + '">' +
            '<input type="checkbox" class="ag-enabled-toggle" data-id="' + escapeHtml(g.id) + '"' + (g.enabled ? " checked" : "") + ">" +
            '<span class="toggle-slider"></span>' +
          "</label>"
        : (g.enabled ? "Yes" : '<span style="color:var(--color-text-tertiary)">No</span>')) +
        (g.enabled ? "" : ' <span style="font-size:0.78rem;color:var(--color-text-tertiary)">members deliver on their own</span>') +
      "</td>" +
    "</tr>";
  }

  /** The list row's Enabled switch. PUT is a full replace for the plain
   *  fields — an omitted description, alert text or ack-note flag is stored
   *  cleared, and an omitted scope reads as a scope CHANGE that retires every
   *  live alert — so this resends them from the listed row. Actions, the chain,
   *  the email layout and membership are left out: absent means untouched. */
  async function toggleEnabled(cb) {
    var g = groups.find(function (x) { return x.id === cb.getAttribute("data-id"); });
    if (!g) return;
    var desired = cb.checked;
    cb.disabled = true;
    try {
      await api.alertGroups.update(g.id, {
        name: g.name,
        description: g.description || null,
        enabled: desired,
        scope: g.scope == null ? null : g.scope,
        foldBy: foldByOf(g),
        minFailingPercent: minPercentOf(g),
        messageTemplate: g.messageTemplate || null,
        requireAckNote: !!g.requireAckNote,
        repeat: g.repeat || null,
      });
      showToast("Alert group " + (desired ? "enabled" : "disabled"), "success");
      renderTab();
    } catch (err) {
      cb.checked = !desired;
      cb.disabled = false;
      showToast((err && err.message) || "Update failed", "error");
    }
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
      // Rule 194: the checks to choose from — the same catalog the automation
      // wizard names checks from, behind the same automationManagement gate.
      var schema = await api.automations.schema();
      pathChecks = (schema && schema.pathChecks) || [];
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
    // Same hide-don't-clear contract for the path-check list (rule 194).
    var allChecks = ov.overlay.querySelector("#ag-all-checks");
    var checkList = ov.overlay.querySelector("#ag-check-list");
    if (allChecks && checkList) {
      allChecks.addEventListener("change", function () {
        checkList.style.display = allChecks.checked ? "none" : "";
      });
    }

    // What may join depends on the fold: a "monitor status is down" automation
    // has nothing to fold per device but plenty per automation or subnet. Re-ask the server
    // for the mode on screen, keeping whatever is ticked.
    var pctRow = ov.overlay.querySelector("#ag-min-pct-row");
    var pctOn = ov.overlay.querySelector("#ag-min-pct-on");
    var pctInput = ov.overlay.querySelector("#ag-min-pct");
    if (pctOn && pctInput) {
      pctOn.addEventListener("change", function () { pctInput.disabled = !pctOn.checked; });
    }
    ov.overlay.querySelectorAll('input[name="ag-fold-by"]').forEach(function (radio) {
      radio.addEventListener("change", async function () {
        if (pctRow) pctRow.style.display = foldSpansDevices(radio.value) ? "" : "none";
        var membersEl = ov.overlay.querySelector("#ag-members");
        var ticked = new Set(Array.prototype.slice.call(membersEl.querySelectorAll(".ag-member:checked")).map(function (el) { return el.value; }));
        try {
          var jr2 = await api.alertGroups.joinable(id || undefined, radio.value);
          joinable = (jr2 && jr2.rules) || [];
        } catch (err) {
          showToast((err && err.message) || "Failed to load the automations", "error");
          return;
        }
        membersEl.innerHTML = joinable.length
          ? joinable.map(function (r) { return memberRowHtml(r, ticked); }).join("")
          : '<p class="empty-state">No automations yet.</p>';
      });
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
        '<label style="font-weight:400"><input type="checkbox" id="ag-enabled"' + (g.enabled !== false ? " checked" : "") + "> Enabled</label>" +
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
      pathChecksHtml(g) +

      "<hr style=\"border:0;border-top:1px solid var(--color-border);margin:1rem 0\">" +
      '<h4 style="margin:0 0 0.25rem;font-size:0.95rem">One alert per</h4>' +
      FOLD_OPTIONS.map(function (o) {
        return '<label style="display:block;font-weight:400;margin:0 0 0.2rem">' +
          '<input type="radio" name="ag-fold-by" value="' + o.value + '"' + (foldByOf(g) === o.value ? " checked" : "") + "> " +
          o.label + " — " + o.hint +
        "</label>";
      }).join("") +
      '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 1.4rem">' +
        "By automation or by subnet, one alert lists every device, so a switch taking twelve hosts down with it is one page listing the twelve, not twelve pages. A device belongs to the most specific subnet in the registry that holds its IP; one in no subnet alerts on its own. " +
        "Those two also take a <em>monitor status is down</em> automation — turn on <em>Also alert when the device is dependency-down</em> there, so the hosts behind a failed switch report at all. Changing this retires the group's open alerts; the next check raises them again the new way. " +
        "Whichever you pick, the first email waits one polling interval, and after it whatever joins or recovers goes out as one update email at most once per interval." +
      "</p>" +
      // Business rule 193 — only for the folds that put several devices in one alert.
      '<div id="ag-min-pct-row" style="margin:0.6rem 0 0 1.4rem' + (foldSpansDevices(foldByOf(g)) ? "" : ";display:none") + '">' +
        '<label style="display:block;font-weight:400;margin:0 0 0.2rem">' +
          '<input type="checkbox" id="ag-min-pct-on"' + (minPercentOf(g) ? " checked" : "") + "> " +
          "Only alert when at least " +
          '<input type="number" id="ag-min-pct" min="1" max="100" step="1" value="' + (minPercentOf(g) || 80) + '"' +
            (minPercentOf(g) ? "" : " disabled") + ' style="width:4.5rem"> % of the devices are failing' +
        "</label>" +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 1.4rem">' +
          "Out of the devices the automations got a reading from in that alert (for a path check, the hosts with a current result — an offline agent does not count). " +
          "Below it there is no alert at all; once it is reached the alert opens with every failing device and stays up until the last one recovers." +
        "</p>" +
      "</div>" +

      "<hr style=\"border:0;border-top:1px solid var(--color-border);margin:1rem 0\">" +
      '<h4 style="margin:0 0 0.25rem;font-size:0.95rem">Automations in this group</h4>' +
      '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">' +
        "Whatever these raise is folded the way <em>One alert per</em> says. Each automation keeps deciding what to watch for; the group decides who hears about it." +
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
        "<strong>Recipients</strong> — with the escalation chain, email layout and reset actions — are copied once from the first automation in the group that has any, the first time the group is saved with no recipients of its own. Changing that automation afterwards does not change the group, and while an automation is in the group its own recipients are not used. Editing them here is not built yet; change them through the API." +
      "</p>"
    );
  }

  /** Business rule 194: which path checks the group governs. Only drawn when
   *  there are checks to choose from; a stored id whose check was deleted is
   *  simply not offered, so the next save drops it. */
  function pathChecksHtml(g) {
    if (!pathChecks.length) return "";
    var chosen = new Set(Array.isArray(g.pathCheckIds) ? g.pathCheckIds : []);
    var all = !pathChecks.some(function (c) { return chosen.has(c.id); });
    return (
      "<hr style=\"border:0;border-top:1px solid var(--color-border);margin:1rem 0\">" +
      '<h4 style="margin:0 0 0.25rem;font-size:0.95rem">Which path checks</h4>' +
      '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin:0 0 0.5rem">' +
        "For the Path Monitor automations in this group. A check outside this list is not folded by this group — its automation alerts on it on its own, exactly as it would ungrouped. Other automations are not affected." +
      "</p>" +
      '<label style="display:block;font-weight:400;margin:0 0 0.4rem">' +
        '<input type="checkbox" id="ag-all-checks"' + (all ? " checked" : "") + "> Every path check its automations cover" +
      "</label>" +
      '<div id="ag-check-list" style="max-height:200px;overflow:auto;border:1px solid var(--color-border);border-radius:6px;padding:0.5rem' + (all ? ";display:none" : "") + '">' +
        pathChecks.map(function (c) {
          return '<label style="display:block;font-weight:400;padding:0.2rem">' +
            '<input type="checkbox" class="ag-check" value="' + escapeHtml(c.id) + '"' + (chosen.has(c.id) ? " checked" : "") + "> " +
            escapeHtml(c.name) +
            (c.target ? ' <span style="color:var(--color-text-tertiary);font-size:0.78rem">' + escapeHtml(c.target) + "</span>" : "") +
            (c.enabled === false ? ' <span class="badge badge-deprecated">disabled</span>' : "") +
          "</label>";
        }).join("") +
      "</div>"
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

    var foldEl = root.querySelector('input[name="ag-fold-by"]:checked');
    var foldBy = foldEl ? foldOptionOf(foldEl.value).value : "device";
    // Business rule 193: null when unticked or when the fold is per device.
    var minPct = null;
    var pctOnEl = root.querySelector("#ag-min-pct-on");
    if (foldSpansDevices(foldBy) && pctOnEl && pctOnEl.checked) {
      var raw = Number((root.querySelector("#ag-min-pct") || {}).value);
      if (!Number.isInteger(raw) || raw < 1 || raw > 100) {
        showToast("The failing percent must be a whole number from 1 to 100", "error");
        return false;
      }
      minPct = raw;
    }
    // Rule 194: [] = every check. Only sent when the section was drawn, so a
    // save with no checks in the catalog leaves the stored list alone.
    var pathCheckIds;
    var allChecksEl = root.querySelector("#ag-all-checks");
    if (allChecksEl) {
      pathCheckIds = allChecksEl.checked ? [] : Array.prototype.slice.call(root.querySelectorAll(".ag-check:checked")).map(function (el) { return el.value; });
      if (!allChecksEl.checked && !pathCheckIds.length) {
        showToast("Choose at least one path check, or tick every path check", "error");
        return false;
      }
    }
    var body = {
      scope: scope,
      foldBy: foldBy,
      pathCheckIds: pathCheckIds,
      minFailingPercent: minPct,
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
