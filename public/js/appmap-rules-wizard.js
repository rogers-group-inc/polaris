// appmap-rules-wizard.js — the DISCOVERY RULE builder (Integrations → Polaris
// Agent → Service & Process Discovery Rules).
//
// A discovery rule is: a NAME, a MODE (monitor only, or monitor + map on the
// Application Map — mapping implies monitoring), an ASSET SCOPE, and the
// process/service ITEMS to pin on the assets that scope selects — now and on
// assets discovered later (the reconcileAppMapAutoMap job re-applies it).
// Several rules coexist, which is the point: "map truckscale.service" should be
// answerable for the three truckscale hosts without also hitting every other
// host that happens to run it.
//
// Four steps: Name → Devices → Items → Summary. Built in the idiom of
// automations-wizard.js (openAutomationWizard): one closure-scoped `draft` holding
// every step's state, a HTML/Wire/Collect/Validate quad per step behind COLLECT /
// VALIDATE dispatch tables, a footer rendered once whose button visibility is
// synced per step, and free navigation back to any visited step. The shared
// .stepper / .step-panel CSS is reused verbatim — the stepper must stay a DIRECT
// first child of .modal-body for its sticky rule to apply.
//
// Two deliberate departures from the automations wizard:
//
//   - Step 2 produces a FLAT TagCriteria ({version,match:"all",rules:[…]}), not the
//     automations' nested scope.condition tree. That's what the server's
//     normalizeCriteria takes, and the tree shape can't round-trip through it
//     (no negation, no tag field, different operators). The builder is therefore
//     ported from the maintenance-schedule criteria UI — same vocabulary, same
//     validator — with apr- prefixed ids so the two can never collide.
//
//   - Step 3's item list is SCOPE-DRIVEN: it asks the server what the assets from
//     step 2 actually report, rather than listing the whole fleet's inventory.
//     Changing the scope invalidates it, so it re-fetches on entry when the scope
//     has moved.
//
// Editing an AUTO rule (one minted from a Services-tab checkbox) converts it to
// MANUAL on save: once an operator shapes it by hand, the consolidation machinery
// must stop adding assets to it. Its explicit assetIds survive the edit — the
// wizard just doesn't render a UI for them beyond the step-2/step-4 counts.
//
// The rules list renders INLINE on the Integrations page (not in a modal), so
// Cancel and post-save just close the modal — the save path re-renders the list
// via appMapRulesSaveOne (appmap-discovery.js).

/* global openModal, closeModal, showToast, showConfirm, escapeHtml, debounce, api */

(function () {
  "use strict";

  // Shared lookup caches — safe to keep at module scope (read-only reference data).
  var _aprAssetTypes = null;
  var _aprIntegrations = null;

  // ─── Criteria vocabulary ───────────────────────────────────────────
  //
  // The union of what tagAssignmentService.normalizeCriteria accepts. `status` is
  // included here (unlike the maintenance builder, which rejects it because that
  // feature flips status itself) — pinning doesn't touch status, so scoping by it
  // is fine.

  var APR_FIELDS = [
    { value: "hostname",     label: "Hostname",         kind: "string" },
    { value: "subnet",       label: "IP / Subnet",      kind: "subnet" },
    { value: "assetType",    label: "Asset type",       kind: "assetType" },
    { value: "manufacturer", label: "Manufacturer",     kind: "string" },
    { value: "model",        label: "Model",            kind: "string" },
    { value: "os",           label: "Operating system", kind: "string" },
    { value: "osVersion",    label: "OS version",       kind: "string" },
    { value: "department",   label: "Department",       kind: "string" },
    { value: "location",     label: "Location",         kind: "string" },
    { value: "status",       label: "Status",           kind: "status" },
    { value: "integration",  label: "Integration",      kind: "integration" },
    { value: "fortigate",    label: "Behind FortiGate", kind: "string" },
  ];
  var APR_STRING_OPS = [
    { value: "contains", label: "contains" },
    { value: "exact",    label: "is" },
    { value: "pattern",  label: "matches (wildcard *)" },
  ];
  var APR_STATUSES = ["active", "maintenance", "decommissioned", "storage", "disabled", "quarantined"];

  function fieldKind(field) {
    for (var i = 0; i < APR_FIELDS.length; i++) if (APR_FIELDS[i].value === field) return APR_FIELDS[i].kind;
    return "string";
  }

  // ─── Public entry point ────────────────────────────────────────────

  window.openAppMapRuleWizard = async function openAppMapRuleWizard(existing) {
    var editing = !!existing;

    var draft = editing ? JSON.parse(JSON.stringify(existing)) : {
      id: null,
      name: "",
      enabled: true,
      mode: "map",
      source: "manual",
      assetIds: [],
      scope: null,
      processes: { names: [], patterns: [], regex: false },
      services: { names: [], patterns: [], regex: false },
    };
    if (!draft.mode) draft.mode = "map";           // pre-mode rules were map rules
    if (!draft.assetIds) draft.assetIds = [];
    var wasAuto = draft.source === "auto";
    // allAssets is UI-only state: a null scope means "every monitored asset"
    // server-side, so the checkbox is just how that's expressed — UNLESS the rule
    // carries explicit assetIds (an auto rule), in which case a null scope means
    // JUST those assets and the checkbox must start unchecked.
    var allAssets = !draft.scope && !(draft.assetIds && draft.assetIds.length);

    // Step 3 state.
    var picked = { process: {}, service: {} };
    (draft.processes.names || []).forEach(function (n) { picked.process[n] = true; });
    (draft.services.names || []).forEach(function (n) { picked.service[n] = true; });
    var inventory = null;          // { processes, services } for the current scope
    var inventoryScopeKey = null;  // JSON of the scope the inventory was fetched for
    var itemSearch = "";
    // Services are the usual target — a unit is the thing operators map; the raw
    // process inventory is the long-tail fallback. Default the filter to match.
    var itemKind = "service";
    var itemSelectedOnly = false;

    var step = 1;
    var visited = editing ? 4 : 1;
    var STEPS = ["Name", "Devices", "Items", "Summary"];
    var scopePreviewTimer = null;

    // ─── Step 1: name ────────────────────────────────────────────────

    function step1Html() {
      return '' +
        (wasAuto
          ? '<p class="hint" style="margin-bottom:0.8rem">This rule was created automatically from a ' +
            'Monitor/Map checkbox on an asset’s Services tab. Saving your edits converts it to a ' +
            'manual rule — new per-asset pins will no longer be consolidated into it.</p>'
          : "") +
        '<div class="form-group">' +
          '<label for="apr-name">Rule name</label>' +
          '<input type="text" id="apr-name" class="input" maxlength="64" ' +
                 'placeholder="e.g. Truckscale app hosts" value="' + escapeHtml(draft.name) + '">' +
          '<p class="hint">Names the rule in the list and in audit Events.</p>' +
        '</div>' +
        '<div class="form-group">' +
          '<label>What should this rule do?</label>' +
          '<label class="appmap-check" style="display:block;margin-bottom:4px">' +
            '<input type="radio" name="apr-mode" value="map"' + (draft.mode !== "monitor" ? " checked" : "") + '> ' +
            '<strong>Monitor + map</strong> — collect telemetry/logs AND draw the items’ connections ' +
            'on the Application Map</label>' +
          '<label class="appmap-check" style="display:block">' +
            '<input type="radio" name="apr-mode" value="monitor"' + (draft.mode === "monitor" ? " checked" : "") + '> ' +
            '<strong>Monitor only</strong> — per-program CPU/RAM + logs, per-unit journal tailing; ' +
            'nothing is published to the Application Map</label>' +
          '<p class="hint">Mapping implies monitoring, so a mapping rule pins both surfaces.</p>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="appmap-check"><input type="checkbox" id="apr-enabled"' +
            (draft.enabled ? " checked" : "") + '> Enabled</label>' +
          '<p class="hint">A disabled rule stops pinning anything new. It never un-pins ' +
            'what it already pinned — use <em>Unmap everywhere</em> for map pins.</p>' +
        '</div>';
    }
    function collectStep1() {
      var n = document.getElementById("apr-name");
      var e = document.getElementById("apr-enabled");
      var m = document.querySelector('input[name="apr-mode"]:checked');
      if (n) draft.name = n.value.trim();
      if (e) draft.enabled = e.checked;
      if (m) draft.mode = m.value === "monitor" ? "monitor" : "map";
    }
    function validateStep1() {
      if (!draft.name) return "Give the rule a name.";
      return null;
    }

    // ─── Step 2: devices (flat TagCriteria) ──────────────────────────

    function ruleCellsHTML(field, op, valueStr) {
      var kind = fieldKind(field);
      if (kind === "integration") {
        var opts = (_aprIntegrations || []).map(function (i) {
          return '<option value="' + escapeHtml(i.id) + '"' + (i.id === valueStr ? " selected" : "") + '>' +
            escapeHtml(i.name || i.type || i.id) + '</option>';
        }).join("");
        return '<span style="color:var(--color-text-secondary);font-size:0.82rem">is</span>' +
          '<select class="input apr-rule-integration" style="flex:1">' +
            '<option value="">Select an integration…</option>' + opts +
          '</select>';
      }
      if (kind === "subnet") {
        return '<span style="color:var(--color-text-secondary);font-size:0.82rem">in</span>' +
          '<input type="text" class="input apr-rule-input" style="flex:1" ' +
                 'placeholder="10.2.0.0/16, 10.3.4.5" value="' + escapeHtml(valueStr) + '">';
      }
      if (kind === "assetType" || kind === "status") {
        var listId = kind === "assetType" ? "apr-assettype-list" : "apr-status-list";
        return '<span style="color:var(--color-text-secondary);font-size:0.82rem">is</span>' +
          '<input type="text" class="input apr-rule-input" style="flex:1" list="' + listId + '" ' +
                 'placeholder="comma-separated" value="' + escapeHtml(valueStr) + '">';
      }
      var opSel = APR_STRING_OPS.map(function (o) {
        return '<option value="' + o.value + '"' + (o.value === op ? " selected" : "") + '>' + escapeHtml(o.label) + '</option>';
      }).join("");
      return '<select class="input apr-rule-op" style="width:auto">' + opSel + '</select>' +
        '<input type="text" class="input apr-rule-input" style="flex:1" ' +
               'placeholder="comma-separated" value="' + escapeHtml(valueStr) + '">';
    }

    function ruleRowHTML(rule) {
      var field = (rule && rule.field) || "hostname";
      var op = (rule && rule.op) || "contains";
      var valueStr = "";
      if (rule) {
        if (rule.field === "subnet") valueStr = (rule.cidrs || []).join(", ");
        else if (rule.field === "integration") valueStr = (rule.values || [])[0] || "";
        else valueStr = (rule.values || []).join(", ");
      }
      var fieldSel = APR_FIELDS.map(function (f) {
        return '<option value="' + f.value + '"' + (f.value === field ? " selected" : "") + '>' + escapeHtml(f.label) + '</option>';
      }).join("");
      return '<div class="apr-rule" style="display:flex;gap:6px;align-items:center;margin-bottom:6px">' +
        '<select class="input apr-rule-field" style="width:auto">' + fieldSel + '</select>' +
        '<span class="apr-rule-cells" style="display:flex;gap:6px;align-items:center;flex:1">' +
          ruleCellsHTML(field, op, valueStr) +
        '</span>' +
        '<button type="button" class="btn-icon apr-rule-remove" aria-label="Remove condition" title="Remove condition">&times;</button>' +
      '</div>';
    }

    function explicitDevicesHtml() {
      var n = (draft.assetIds || []).length;
      if (!n) return "";
      return '<div class="form-group" id="apr-explicit-wrap">' +
        '<p class="hint">Also explicitly targets <strong>' + n + '</strong> specific device(s) — ' +
          'the assets whose Services-tab pins created this rule. Conditions below are unioned ' +
          'with them. ' +
          '<button type="button" class="btn btn-secondary btn-sm" id="apr-clear-explicit">Remove them</button>' +
        '</p>' +
      '</div>';
    }

    function step2Html() {
      var rules = (draft.scope && draft.scope.rules) || [];
      return '' +
        '<div class="form-group">' +
          '<label class="appmap-check"><input type="checkbox" id="apr-all-assets"' +
            (allAssets ? " checked" : "") + '> All monitored workstations &amp; servers</label>' +
          '<p class="hint">Polaris only collects a process/service inventory from workstations and ' +
            'servers (via the Polaris Agent, or agentless SSH/WinRM), so rules only ever target those — ' +
            'firewalls, switches, APs and printers report nothing to pin. ' +
            'Uncheck to narrow further; conditions are ANDed.</p>' +
        '</div>' +
        explicitDevicesHtml() +
        '<div id="apr-scope-builder"' + (allAssets ? ' style="display:none"' : "") + '>' +
          '<div id="apr-rules">' + (rules.length ? rules.map(ruleRowHTML).join("") : ruleRowHTML(null)) + '</div>' +
          '<button type="button" class="btn btn-secondary btn-sm" id="apr-add-rule">+ Add condition</button>' +
        '</div>' +
        '<div class="form-group" style="margin-top:1rem">' +
          '<label>Devices this rule affects</label>' +
          '<div id="apr-scope-preview" class="hint">Checking…</div>' +
        '</div>' +
        '<datalist id="apr-assettype-list"></datalist>' +
        '<datalist id="apr-status-list">' +
          APR_STATUSES.map(function (s) { return '<option value="' + s + '"></option>'; }).join("") +
        '</datalist>';
    }

    // DOM → TagCriteria via the shared walker (api.js collectTagCriteria) —
    // same wire shape as the Maintenance builder by requirement: comma-split
    // multi-value inputs, bare IPs promoted to /32 (or /128) so a save can't
    // 400 on something the operator typed reasonably, empty rows dropped, and
    // null when nothing usable is left — null means "every monitored asset",
    // NOT "match nothing".
    function collectCriteria() {
      return collectTagCriteria({
        rowSelector: "#apr-rules .apr-rule",
        fieldSel: ".apr-rule-field",
        integrationSel: ".apr-rule-integration",
        opSel: ".apr-rule-op",
        inputSel: ".apr-rule-input",
      });
    }

    function collectStep2() {
      var cb = document.getElementById("apr-all-assets");
      if (cb) allAssets = cb.checked;
      draft.scope = allAssets ? null : collectCriteria();
      // Ticking "all assets" makes explicit targets redundant AND would leave the
      // stored shape ambiguous (null scope + assetIds means "just those"), so the
      // checkbox clears them.
      if (allAssets) draft.assetIds = [];
    }
    function validateStep2() {
      // Unchecked + empty is a mistake, not a synonym for all-assets: silently
      // widening to the whole fleet is exactly the over-pinning this replaced.
      // Explicit device targets (an auto rule's assets) count as a scope.
      if (!allAssets && !draft.scope && !(draft.assetIds || []).length) {
        return "Add a condition, or tick “All monitored workstations & servers”.";
      }
      return null;
    }

    function refreshScopePreview() {
      var el = document.getElementById("apr-scope-preview");
      if (!el) return;
      collectStep2();
      el.textContent = "Checking…";
      if (scopePreviewTimer) clearTimeout(scopePreviewTimer);
      scopePreviewTimer = setTimeout(async function () {
        try {
          var res = await api.applicationMap.discoveryScope(draft.scope, draft.assetIds || []);
          if (!res.total) {
            el.innerHTML = '<em>No monitored assets match.</em>';
            return;
          }
          var rows = res.assets.slice(0, 25).map(function (a) {
            return "<tr><td>" + escapeHtml(a.hostname || "—") + "</td><td>" +
              escapeHtml(a.ipAddress || "—") + "</td><td>" + escapeHtml(a.assetType || "—") + "</td></tr>";
          }).join("");
          // Warm the item list now that we know the scope is settled — step 3
          // otherwise starts its aggregate only once the operator gets there.
          if (step === 2) loadInventoryIfNeeded();
          el.innerHTML = "<strong>" + res.total + "</strong> monitored asset(s)" +
            '<div class="table-wrapper" style="max-height:180px;overflow:auto;margin-top:6px">' +
              '<table class="data-table" style="margin:0"><tbody>' + rows + "</tbody></table>" +
            "</div>" +
            (res.total > 25 ? '<div class="hint">…and ' + (res.total - 25) + " more</div>" : "");
        } catch (err) {
          el.textContent = "Preview unavailable: " + (err && err.message ? err.message : String(err));
        }
      }, 400);
    }

    function wireStep2() {
      var panel = document.getElementById("apr-step-2");
      if (!panel) return;
      panel.addEventListener("change", function (ev) {
        if (ev.target.id === "apr-all-assets") {
          allAssets = ev.target.checked;
          var b = document.getElementById("apr-scope-builder");
          if (b) b.style.display = allAssets ? "none" : "";
          refreshScopePreview();
          return;
        }
        if (ev.target.classList.contains("apr-rule-field")) {
          // Field changed → rebuild that row's op + value cells for the new kind.
          var row = ev.target.closest(".apr-rule");
          row.querySelector(".apr-rule-cells").innerHTML = ruleCellsHTML(ev.target.value, "contains", "");
        }
        refreshScopePreview();
      });
      var reprev = (typeof debounce === "function") ? debounce(refreshScopePreview, 250) : refreshScopePreview;
      panel.addEventListener("input", function (ev) {
        if (ev.target.classList.contains("apr-rule-input")) reprev();
      });
      panel.addEventListener("click", function (ev) {
        if (ev.target.id === "apr-add-rule") {
          document.getElementById("apr-rules").insertAdjacentHTML("beforeend", ruleRowHTML(null));
          return;
        }
        if (ev.target.id === "apr-clear-explicit") {
          draft.assetIds = [];
          var wrap = document.getElementById("apr-explicit-wrap");
          if (wrap) wrap.remove();
          refreshScopePreview();
          return;
        }
        var rm = ev.target.closest ? ev.target.closest(".apr-rule-remove") : null;
        if (rm) {
          var rows = document.querySelectorAll("#apr-rules .apr-rule");
          if (rows.length > 1) rm.closest(".apr-rule").remove();
          else rm.closest(".apr-rule").querySelector(".apr-rule-input").value = "";
          refreshScopePreview();
        }
      });
    }

    // ─── Step 3: items reported by the scoped assets ─────────────────

    function itemRows() {
      if (!inventory) return [];
      var out = [];
      (inventory.services || []).forEach(function (r) {
        out.push({
          kind: "service", name: r.name, deviceCount: r.deviceCount, mappedCount: r.mappedCount,
          sub: [r.displayName, r.platform].filter(Boolean).join(" · "),
        });
      });
      (inventory.processes || []).forEach(function (r) {
        out.push({ kind: "process", name: r.name, deviceCount: r.deviceCount, mappedCount: r.mappedCount, sub: "" });
      });
      return out;
    }

    function visibleItemRows() {
      var q = itemSearch.trim().toLowerCase();
      return itemRows().filter(function (r) {
        if (itemKind !== "all" && r.kind !== itemKind) return false;
        if (itemSelectedOnly && !picked[r.kind][r.name]) return false;
        if (!q) return true;
        return r.name.toLowerCase().indexOf(q) >= 0 || (r.sub || "").toLowerCase().indexOf(q) >= 0;
      }).sort(function (a, b) {
        // Most-deployed first — the useful end of a long tail of one-host programs.
        if (b.deviceCount !== a.deviceCount) return b.deviceCount - a.deviceCount;
        return a.name.localeCompare(b.name);
      });
    }

    // The intro line depends on the rule's MODE (chosen on step 1), so it's
    // re-synced every time step 3 is entered rather than baked in once.
    function itemHintText() {
      return draft.mode === "monitor"
        ? 'Programs and service units reported by the devices this rule selects. Tick what you ' +
          'want <strong>monitored</strong> — CPU/RAM history for a program, journal tailing for ' +
          'a unit. Nothing is published to the Application Map.'
        : 'Programs and service units reported by the devices this rule selects. Tick what ' +
          'belongs on the Application Map. Anything you map is also <strong>monitored</strong> ' +
          '(CPU/RAM history for a program, journal tailing for a unit) — mapping implies ' +
          'monitoring, but not the reverse.';
    }
    function syncItemHint() {
      var el = document.getElementById("apr-item-hint");
      if (el) el.innerHTML = itemHintText();
    }

    function step3Html() {
      return '' +
        '<p class="hint" id="apr-item-hint" style="margin-bottom:0.6rem">' + itemHintText() + '</p>' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:0.6rem">' +
          '<input type="search" id="apr-item-search" class="input" placeholder="Search programs / units…" ' +
                 'style="flex:1 1 200px;min-width:150px" autocomplete="off" spellcheck="false">' +
          '<select id="apr-item-kind" class="input" style="width:auto">' +
            '<option value="service" selected>Services only</option>' +
            '<option value="process">Processes only</option>' +
            '<option value="all">All types</option>' +
          '</select>' +
          '<label class="appmap-check"><input type="checkbox" id="apr-item-selected"> Selected only</label>' +
        '</div>' +
        '<div class="table-wrapper table-wrapper-modal-sticky" style="max-height:42vh">' +
          '<table class="data-table" style="margin:0">' +
            '<thead><tr>' +
              '<th style="width:2.5rem"></th><th>Name</th>' +
              '<th style="width:6rem">Type</th><th style="width:6rem">Devices</th>' +
              '<th style="width:7rem">Mapped</th>' +
            '</tr></thead>' +
            '<tbody id="apr-item-tbody"><tr><td colspan="5" class="empty-state">Loading…</td></tr></tbody>' +
          '</table>' +
        '</div>' +
        '<div id="apr-item-count" class="hint" style="margin-top:0.5rem"></div>';
    }

    function updateItemCount() {
      var el = document.getElementById("apr-item-count");
      if (!el) return;
      var svc = Object.keys(picked.service).length;
      var proc = Object.keys(picked.process).length;
      var parts = [svc + " service" + (svc === 1 ? "" : "s")];
      // Only mention processes once any are picked, so the common services-only
      // case stays a single clean number.
      if (proc) parts.push(proc + " process" + (proc === 1 ? "" : "es"));
      el.textContent = parts.join(" · ") + " selected";
    }

    function renderItemRows() {
      var tbody = document.getElementById("apr-item-tbody");
      if (!tbody) return;
      updateItemCount();
      if (!inventory) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Loading…</td></tr>';
        return;
      }
      var rows = visibleItemRows();
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="empty-state">' +
          (itemRows().length
            ? "Nothing matches this search."
            : "These devices haven’t reported any processes or services yet. They appear once a Polaris Agent reports their inventory.") +
          "</td></tr>";
        return;
      }
      tbody.innerHTML = rows.map(function (r) {
        var nm = escapeHtml(r.name);
        return "<tr>" +
          '<td><input type="checkbox" class="apr-item-pick" data-kind="' + r.kind + '" data-name="' + nm + '"' +
            (picked[r.kind][r.name] ? " checked" : "") + "></td>" +
          "<td>" + nm + (r.sub ? '<div style="font-size:0.72rem;color:var(--color-text-tertiary)">' + escapeHtml(r.sub) + "</div>" : "") + "</td>" +
          "<td>" + (r.kind === "service" ? "Service" : "Process") + "</td>" +
          "<td>" + r.deviceCount + "</td>" +
          "<td>" + (r.mappedCount ? r.mappedCount + " host(s)" : "—") + "</td>" +
        "</tr>";
      }).join("");
    }

    // Re-fetch only when the scope actually moved — stepping back and forth
    // shouldn't cost a round-trip, but a changed scope must invalidate the list.
    async function loadInventoryIfNeeded() {
      var key = JSON.stringify(draft.scope || null);
      if (inventory && inventoryScopeKey === key) return;
      inventory = null;
      renderItemRows();
      try {
        var fetched = await api.applicationMap.discoveryInventory(draft.scope);
        // The scope may have moved while this was in flight (prefetch + a fast
        // edit); a stale response must not overwrite a newer one.
        if (JSON.stringify(draft.scope || null) !== key) return;
        inventory = fetched;
        inventoryScopeKey = key;
      } catch (err) {
        var tbody = document.getElementById("apr-item-tbody");
        if (tbody) {
          tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Failed to load: ' +
            escapeHtml(err && err.message ? err.message : String(err)) + "</td></tr>";
        }
        return;
      }
      renderItemRows();
    }

    function wireStep3() {
      var panel = document.getElementById("apr-step-3");
      if (!panel) return;
      var reRender = (typeof debounce === "function") ? debounce(renderItemRows, 200) : renderItemRows;
      panel.addEventListener("input", function (ev) {
        if (ev.target.id === "apr-item-search") { itemSearch = ev.target.value; reRender(); }
      });
      panel.addEventListener("change", function (ev) {
        if (ev.target.id === "apr-item-kind") { itemKind = ev.target.value; renderItemRows(); return; }
        if (ev.target.id === "apr-item-selected") { itemSelectedOnly = ev.target.checked; renderItemRows(); return; }
        var box = ev.target.closest ? ev.target.closest(".apr-item-pick") : null;
        if (!box) return;
        var k = box.getAttribute("data-kind");
        var n = box.getAttribute("data-name");
        if (box.checked) picked[k][n] = true; else delete picked[k][n];
        updateItemCount();
      });
    }

    function collectStep3() {
      draft.processes.names = Object.keys(picked.process);
      draft.services.names = Object.keys(picked.service);
    }
    function validateStep3() {
      if (!draft.processes.names.length && !draft.services.names.length &&
          !(draft.processes.patterns || []).length && !(draft.services.patterns || []).length) {
        return "Pick at least one process or service.";
      }
      return null;
    }

    // ─── Step 4: summary ─────────────────────────────────────────────

    function renderStep4() {
      var panel = document.getElementById("apr-step-4");
      if (!panel) return;
      var scopeText = allAssets
        ? "All monitored workstations & servers"
        : ((draft.scope && draft.scope.rules) || []).map(function (r) {
            var f = r.field;
            if (f === "subnet") return "IP in " + (r.cidrs || []).join(", ");
            if (f === "integration") {
              var hit = (_aprIntegrations || []).filter(function (i) { return i.id === (r.values || [])[0]; })[0];
              return "Integration is " + escapeHtml(hit ? (hit.name || hit.id) : (r.values || [])[0] || "?");
            }
            var lbl = APR_FIELDS.filter(function (x) { return x.value === f; })[0];
            return (lbl ? lbl.label : f) + " " + r.op + " " + (r.values || []).join(", ");
          }).join("  AND  ");
      if (!allAssets && (draft.assetIds || []).length) {
        var explicit = draft.assetIds.length + " specific device(s)";
        scopeText = scopeText ? scopeText + "  +  " + explicit : explicit;
      }
      var items = draft.services.names.map(function (n) { return n + " (service)"; })
        .concat(draft.processes.names.map(function (n) { return n + " (process)"; }));

      panel.innerHTML =
        '<dl class="review-grid">' +
          "<dt>Name</dt><dd>" + escapeHtml(draft.name) + "</dd>" +
          "<dt>Type</dt><dd>" + (draft.mode === "monitor" ? "Monitor only" : "Monitor + map") + "</dd>" +
          "<dt>Enabled</dt><dd>" + (draft.enabled ? "Yes" : "No") + "</dd>" +
          "<dt>Devices</dt><dd>" + escapeHtml(scopeText || "—") + "</dd>" +
          "<dt>Items</dt><dd>" + (items.length ? escapeHtml(items.join(", ")) : "—") + "</dd>" +
        "</dl>" +
        (wasAuto
          ? '<p class="hint" style="margin-top:0.6rem">Saving converts this automatically-created rule ' +
            'to a manual rule.</p>'
          : "") +
        '<div class="form-group" style="margin-top:0.8rem">' +
          "<label>What this will pin</label>" +
          '<div id="apr-rule-preview" class="hint">Checking…</div>' +
        "</div>";

      (async function () {
        var el = document.getElementById("apr-rule-preview");
        if (!el) return;
        try {
          var res = await api.applicationMap.previewDiscovery(draft);
          if (!res.deviceCount) {
            el.innerHTML = "<em>Nothing new to pin — every matching device already has these.</em>";
            return;
          }
          var names = (res.sampleDevices || []).map(function (d) { return d.hostname || d.assetId; });
          el.innerHTML = (draft.mode === "monitor"
              ? "Adds <strong>" + res.monitorPins + "</strong> monitor pin(s)"
              : "Adds <strong>" + res.processPins + "</strong> process pin(s) and <strong>" +
                res.servicePins + "</strong> service pin(s)" +
                (res.monitorPins ? " (plus <strong>" + res.monitorPins + "</strong> monitor pin(s))" : "")) +
            " across <strong>" + res.deviceCount + "</strong> device(s)" +
            (names.length ? ": " + escapeHtml(names.join(", ")) + (res.deviceCount > names.length ? ", …" : "") : "") + ".";
        } catch (err) {
          el.textContent = "Preview unavailable: " + (err && err.message ? err.message : String(err));
        }
      })();
    }

    // ─── Shell ───────────────────────────────────────────────────────

    var COLLECT = { 1: collectStep1, 2: collectStep2, 3: collectStep3, 4: function () {} };
    var VALIDATE = { 1: validateStep1, 2: validateStep2, 3: validateStep3, 4: function () { return null; } };

    function stepperHtml() {
      var html = '<div class="stepper" id="apr-stepper">';
      STEPS.forEach(function (label, i) {
        var n = i + 1;
        if (i > 0) html += '<div class="stepper-line" data-line="' + (n - 1) + '"></div>';
        html += '<div class="stepper-step" data-step="' + n + '">' +
          '<span class="stepper-num">' + n + "</span><span>" + escapeHtml(label) + "</span></div>";
      });
      return html + "</div>";
    }

    function updateStepper() {
      document.querySelectorAll("#apr-stepper .stepper-step").forEach(function (el) {
        var n = Number(el.getAttribute("data-step"));
        el.classList.toggle("active", n === step);
        el.classList.toggle("done", n < step);
        el.classList.toggle("clickable", n <= visited && n !== step);
      });
      document.querySelectorAll("#apr-stepper .stepper-line").forEach(function (el) {
        el.classList.toggle("done", Number(el.getAttribute("data-line")) < step);
      });
    }

    function syncFooter() {
      document.getElementById("apr-back").style.display = step > 1 ? "" : "none";
      document.getElementById("apr-next").style.display = step < STEPS.length ? "" : "none";
      document.getElementById("apr-save").style.display = (step === STEPS.length || editing) ? "" : "none";
    }

    function goToStep(n, opts) {
      opts = opts || {};
      if (!opts.skipCollect) COLLECT[step]();
      if (opts.validate) {
        var problem = VALIDATE[step]();
        if (problem) { showToast(problem, "error"); return false; }
      }
      if (scopePreviewTimer) { clearTimeout(scopePreviewTimer); scopePreviewTimer = null; }
      document.getElementById("apr-step-" + step).classList.remove("visible");
      step = n;
      visited = Math.max(visited, n);
      if (n === 4) renderStep4();
      document.getElementById("apr-step-" + step).classList.add("visible");
      updateStepper();
      syncFooter();
      var body = document.querySelector(".modal-body");
      if (body) body.scrollTop = 0;
      if (n === 2) refreshScopePreview();
      if (n === 3) { syncItemHint(); loadInventoryIfNeeded(); }
      return true;
    }

    var body = stepperHtml() +
      '<div class="step-panel visible" id="apr-step-1">' + step1Html() + "</div>" +
      '<div class="step-panel" id="apr-step-2">' + step2Html() + "</div>" +
      '<div class="step-panel" id="apr-step-3">' + step3Html() + "</div>" +
      '<div class="step-panel" id="apr-step-4"></div>';

    var footer =
      '<button type="button" class="btn btn-secondary" id="apr-cancel">Cancel</button>' +
      '<button type="button" class="btn btn-secondary" id="apr-back" style="display:none">&larr; Back</button>' +
      '<button type="button" class="btn btn-primary" id="apr-next">Next &rarr;</button>' +
      '<button type="button" class="btn btn-primary" id="apr-save" style="display:none">' +
        (editing ? "Save changes" : "Create rule") + "</button>";

    openModal(editing ? "Edit map rule" : "New map rule", body, footer, { wide: true });

    document.getElementById("apr-next").addEventListener("click", function () {
      goToStep(step + 1, { validate: true });
    });
    document.getElementById("apr-back").addEventListener("click", function () { goToStep(step - 1); });
    // → / ← walk the steps and Enter advances while Next is showing, submitting
    // only on step 4 (app.js § Stepped-modal keyboard navigation).
    if (typeof wireModalStepKeys === "function") {
      wireModalStepKeys({ back: "apr-back", next: "apr-next", submit: "apr-save" });
    }
    document.getElementById("apr-stepper").addEventListener("click", function (ev) {
      var el = ev.target.closest ? ev.target.closest(".stepper-step") : null;
      if (!el) return;
      var n = Number(el.getAttribute("data-step"));
      if (n <= visited && n !== step) goToStep(n);
    });
    // The rules list lives inline on the Integrations page, so the wizard just
    // closes; nothing to reopen.
    document.getElementById("apr-cancel").addEventListener("click", function () {
      closeModal();
    });

    document.getElementById("apr-save").addEventListener("click", async function () {
      COLLECT[step]();
      for (var i = 1; i <= STEPS.length; i++) {
        var problem = VALIDATE[i]();
        if (problem) {
          goToStep(i, { skipCollect: true });
          showToast(problem, "error");
          return;
        }
      }
      // A hand-edited auto rule becomes manual: the consolidation machinery must
      // stop adding assets to a rule the operator has shaped.
      if (!draft.source || wasAuto) draft.source = "manual";
      this.disabled = true;
      try {
        await window.appMapRulesSaveOne(draft);
        closeModal();
      } catch (err) {
        showToast("Save failed: " + (err && err.message ? err.message : String(err)), "error");
        this.disabled = false;
      }
    });

    wireStep2();
    wireStep3();
    updateStepper();
    syncFooter();

    // Lookups are cosmetic (a datalist and a select); deliberately not awaited so
    // a slow/failed fetch can't leave the wizard inert.
    (async function () {
      if (!_aprAssetTypes) {
        try { _aprAssetTypes = await api.assetTypes.list(); } catch (e) { _aprAssetTypes = []; }
      }
      var dl = document.getElementById("apr-assettype-list");
      if (dl) {
        // Only types a rule can actually match (the server publishes the list on
        // GET /discovery). Offering "firewall" here would let an operator build a
        // rule that silently matches nothing.
        var capable = window.appMapProcessCapableTypes || null;
        dl.innerHTML = (_aprAssetTypes || [])
          .map(function (t) { return t.name || t; })
          .filter(function (n) { return !capable || capable.indexOf(n) >= 0; })
          .map(function (n) { return '<option value="' + escapeHtml(n) + '"></option>'; })
          .join("");
      }
      if (!_aprIntegrations) {
        try { _aprIntegrations = await api.integrations.list(); } catch (e) { _aprIntegrations = []; }
      }
      // Repaint any integration row that rendered before the list arrived.
      document.querySelectorAll("#apr-rules .apr-rule").forEach(function (row) {
        var f = row.querySelector(".apr-rule-field");
        var cur = row.querySelector(".apr-rule-integration");
        if (f && f.value === "integration" && cur) {
          row.querySelector(".apr-rule-cells").innerHTML = ruleCellsHTML("integration", "exact", cur.value);
        }
      });
    })();
  };
})();
