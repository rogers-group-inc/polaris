/* global api, escapeHtml, showToast, openModal, closeModal, wireModalStepKeys */
/**
 * public/js/quiet-time-wizard.js — `window.PolarisQuietTimeWizard`
 *
 * The five-step builder for a GLOBAL quiet time (business rule 92), opened
 * from Automations → Settings → Global Quiet Times. It follows the automation
 * wizard's progression on purpose — Devices, then which alerts, then when —
 * because an operator who has built an automation already knows the moves:
 *
 *   1 Name      name + enabled
 *   2 Devices   the SAME condition builder and vocabulary as the automation
 *               wizard's Devices step (PolarisConditionBuilder over
 *               PolarisScopeVocabulary), with the same live preview
 *   3 Alerts    which severities, and which kinds of alert (metrics / state
 *               fields from the automation schema catalogue) — "any" by default
 *   4 Schedule  the shared quiet-time editor (quiet-time-editor.js): the
 *               window, what goes quiet, the summary time, channel, threshold
 *   5 Review
 *
 * Canon shape: `openModal(..., {wide:true})` with the `.stepper` first in the
 * body, one draft object, HTML / wire / collect / validate per step, one
 * `wireModalStepKeys`. It REPLACES whatever modal opened it (both use the one
 * shared #modal-overlay) and calls `opts.onDone` when it closes, saved or not,
 * so the Settings modal can put itself back.
 */
(function () {
  "use strict";

  var STEPS = ["Name", "Devices", "Alerts", "Schedule", "Review"];
  var ALL_SEVERITIES = ["notice", "informational", "warning", "serious", "critical"];

  async function open(existing, opts) {
    opts = opts || {};
    var schema, vocab, channels;
    try {
      schema = window._ruleSchema || await api.automations.schema();
      if (!window._ruleSchema) window._ruleSchema = schema;
      vocab = await window.PolarisScopeVocabulary.load();
      var cd = await api.deliveryChannels.list();
      channels = (cd && cd.channels) || [];
    } catch (err) {
      showToast((err && err.message) || "Failed to open the quiet-time editor", "error");
      if (typeof opts.onDone === "function") opts.onDone();
      return;
    }

    var editing = existing && existing.id ? existing : null;
    var draft = editing
      ? { name: editing.name || "", enabled: editing.enabled !== false, scope: JSON.parse(JSON.stringify(editing.scope || {})), quiet: editing.quiet ? JSON.parse(JSON.stringify(editing.quiet)) : null }
      // The default a new global quiet time starts from: everything but
      // critical. The whole reason for a global quiet time is "let critical
      // page, hold the rest", so that is what the first screen says.
      : { name: "", enabled: true, scope: { allAssets: true }, quiet: { windows: [], severities: ["notice", "informational", "warning", "serious"], alertKinds: null } };
    draft.severities = (draft.quiet && draft.quiet.severities) || null;
    draft.alertKinds = (draft.quiet && draft.quiet.alertKinds) || null;

    var step = 1;
    var visited = editing ? STEPS.length : 1;
    var previewTimer = null;

    var CB = window.PolarisConditionBuilder;
    var condBuilder = CB.create({ meta: vocab.meta, valueOptions: vocab.valueOptions, onChange: function () { schedulePreview(); } });

    // ── Step 1 ───────────────────────────────────────────────────────────────
    function step1Html() {
      return '<h3 style="margin:0 0 0.25rem">Name this quiet time</h3>' +
        '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">It appears in the Settings list, on the Active Alerts page’s QUIET pill, and in the summary email’s subject.</p>' +
        '<div class="form-group"><label for="qtw-name">Name</label><input type="text" id="qtw-name" maxlength="200" value="' + escapeHtml(draft.name) + '" placeholder="e.g. Nights and weekends" style="width:100%"></div>' +
        '<div class="form-group"><label style="font-weight:400"><input type="checkbox" id="qtw-enabled"' + (draft.enabled ? " checked" : "") + '> Enabled</label></div>';
    }
    function collectStep1() {
      draft.name = (document.getElementById("qtw-name") || {}).value || "";
      draft.enabled = !!(document.getElementById("qtw-enabled") || {}).checked;
    }
    function validateStep1() { return draft.name.trim() ? null : "Give the quiet time a name."; }

    // ── Step 2 ───────────────────────────────────────────────────────────────
    function scopeIsAll(scope) {
      return !scope || scope.allAssets === true || !scope.condition;
    }
    function step2Html() {
      var all = scopeIsAll(draft.scope);
      var root = draft.scope && draft.scope.condition ? draft.scope.condition : { op: "and", children: [] };
      return '<h3 style="margin:0 0 0.25rem">Which devices?</h3>' +
        '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">Alerts about these devices go quiet. The same filter the automation wizard uses.</p>' +
        '<div class="form-group" style="margin-bottom:0.5rem"><label style="font-weight:600"><input type="checkbox" id="qtw-all-assets"' + (all ? " checked" : "") + '> All devices</label>' +
        '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:2px 0 0 24px">Uncheck to narrow it down.</p></div>' +
        '<div id="qtw-cond-wrap" style="display:' + (all ? "none" : "block") + '">' +
          '<div id="qtw-cond-root">' + condBuilder.groupHtml(root, 0) + '</div>' +
          '<div id="qtw-scope-preview" class="aw-preview-box" style="margin-top:0.75rem"><p class="aw-preview-head"><span class="aw-preview-muted">Checking…</span></p><div class="aw-preview-body"></div></div>' +
        '</div>';
    }
    function wireStep2() {
      var panel = document.getElementById("qtw-step-2");
      var allCb = panel.querySelector("#qtw-all-assets");
      allCb.addEventListener("change", function () {
        panel.querySelector("#qtw-cond-wrap").style.display = allCb.checked ? "none" : "block";
        if (!allCb.checked) { condBuilder.seedIfEmpty(panel.querySelector("#qtw-cond-root")); schedulePreview(); }
      });
      condBuilder.wire(panel, "#qtw-cond-root");
    }
    function collectStep2() {
      var cb = document.getElementById("qtw-all-assets");
      if (cb && cb.checked) { draft.scope = { allAssets: true }; return; }
      var root = document.querySelector("#qtw-cond-root > .scg-group");
      if (!root) return;
      draft.scope = { condition: condBuilder.collect(root) };
    }
    function validateStep2() {
      var sc = draft.scope || {};
      if (sc.allAssets || !sc.condition) return null;
      if (!sc.condition.children.length) return 'Add at least one condition, or check "All devices".';
      return condBuilder.validate(sc.condition);
    }
    function schedulePreview() {
      if (previewTimer) clearTimeout(previewTimer);
      previewTimer = setTimeout(runPreview, 400);
    }
    async function runPreview() {
      var box = document.getElementById("qtw-scope-preview");
      if (!box) return;
      collectStep2();
      try {
        var res = await api.automations.preview({ scope: draft.scope });
        var rows = (res.matches || []).slice(0, 15).map(function (m) { return "<tr><td>" + escapeHtml(m.hostname || m.assetId || "") + "</td></tr>"; }).join("");
        box.innerHTML = '<p class="aw-preview-head"><strong>' + escapeHtml(String(res.totalEvaluated)) + "</strong> monitored device(s) match." +
          (res.totalEvaluated > 15 ? ' <span class="aw-preview-muted">Showing the first 15.</span>' : "") + "</p>" +
          '<div class="aw-preview-body table-wrapper">' + (rows ? '<table class="data-table"><tbody>' + rows + "</tbody></table>" : "") + "</div>";
      } catch (err) {
        box.innerHTML = '<p class="aw-preview-head"><span class="aw-preview-muted">Preview unavailable: ' + escapeHtml((err && err.message) || "error") + "</span></p>";
      }
    }

    // ── Step 3 ───────────────────────────────────────────────────────────────
    function kindCatalog() {
      var out = [];
      var tts = (schema && schema.triggerTypes) || [];
      tts.forEach(function (t) {
        (t.metrics || []).forEach(function (m) {
          var meta = schema.metricMeta && schema.metricMeta[m];
          out.push({ value: m, label: (meta && meta.label) || m, group: t.type === "host_metric" ? "Polaris host" : "Device metrics" });
        });
        (t.fields || []).forEach(function (f) {
          var fm = schema.fieldMeta && schema.fieldMeta[f];
          out.push({ value: f, label: (fm && fm.label) || f, group: "Device state" });
        });
      });
      return out;
    }
    function step3Html() {
      var sevs = (schema && schema.severities) || ALL_SEVERITIES;
      var chosen = draft.severities;
      var kinds = kindCatalog();
      var picked = draft.alertKinds;
      var groups = {};
      kinds.forEach(function (k) { (groups[k.group] = groups[k.group] || []).push(k); });
      return '<h3 style="margin:0 0 0.25rem">Which alerts?</h3>' +
        '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">Untick a severity to let it through whatever the hour — the usual shape is everything but critical.</p>' +
        '<div class="form-group"><label style="font-weight:600">Severities</label>' +
          '<div style="display:flex;gap:0.9rem;flex-wrap:wrap">' +
          sevs.map(function (sv) {
            var on = !chosen || chosen.indexOf(sv) >= 0;
            return '<label style="display:inline-flex;align-items:center;gap:5px;margin:0;font-weight:400;cursor:pointer">' +
              '<input type="checkbox" class="qtw-sev" value="' + escapeHtml(sv) + '"' + (on ? " checked" : "") + ' style="width:auto"> ' +
              '<span class="sev-select sev-' + escapeHtml(sv) + '" style="padding:1px 8px;border-radius:999px;font-size:0.78rem">' + escapeHtml(sv) + "</span></label>";
          }).join("") + "</div></div>" +
        '<div class="form-group" style="margin-top:0.9rem"><label style="font-weight:600">Kinds of alert</label>' +
          '<label style="display:block;font-weight:400;margin:0.2rem 0 0;cursor:pointer"><input type="radio" name="qtw-kinds" value="any"' + (picked ? "" : " checked") + ' style="width:auto"> Any alert</label>' +
          '<label style="display:block;font-weight:400;margin:0.2rem 0 0;cursor:pointer"><input type="radio" name="qtw-kinds" value="some"' + (picked ? " checked" : "") + ' style="width:auto"> Only these kinds</label>' +
          '<div id="qtw-kinds-list" style="margin:0.5rem 0 0 1.4rem;' + (picked ? "" : "display:none") + '">' +
            Object.keys(groups).map(function (gname) {
              return '<div style="font-size:0.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--color-text-tertiary);margin:0.5rem 0 0.2rem">' + escapeHtml(gname) + "</div>" +
                '<div style="display:flex;gap:0.5rem 1rem;flex-wrap:wrap">' +
                groups[gname].map(function (k) {
                  return '<label style="display:inline-flex;align-items:center;gap:4px;margin:0;font-weight:400;cursor:pointer;font-size:0.85rem">' +
                    '<input type="checkbox" class="qtw-kind" value="' + escapeHtml(k.value) + '"' + (picked && picked.indexOf(k.value) >= 0 ? " checked" : "") + ' style="width:auto"> ' + escapeHtml(k.label) + "</label>";
                }).join("") + "</div>";
            }).join("") +
            '<p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.5rem 0 0">Audit-event and change automations carry no kind and match only “Any alert”.</p>' +
          "</div>" +
        "</div>";
    }
    function wireStep3() {
      var panel = document.getElementById("qtw-step-3");
      panel.querySelectorAll('input[name="qtw-kinds"]').forEach(function (r) {
        r.addEventListener("change", function () {
          panel.querySelector("#qtw-kinds-list").style.display = (panel.querySelector('input[name="qtw-kinds"]:checked') || {}).value === "some" ? "" : "none";
        });
      });
    }
    function collectStep3() {
      var panel = document.getElementById("qtw-step-3");
      var all = panel.querySelectorAll(".qtw-sev");
      var on = Array.prototype.filter.call(all, function (b) { return b.checked; }).map(function (b) { return b.value; });
      draft.severities = on.length === all.length ? null : on;
      draft._noSeverity = on.length === 0;
      var some = (panel.querySelector('input[name="qtw-kinds"]:checked') || {}).value === "some";
      var kinds = Array.prototype.filter.call(panel.querySelectorAll(".qtw-kind"), function (b) { return b.checked; }).map(function (b) { return b.value; });
      draft.alertKinds = some ? kinds : null;
      draft._noKinds = some && kinds.length === 0;
    }
    function validateStep3() {
      if (draft._noSeverity) return "Pick at least one severity to hold.";
      if (draft._noKinds) return 'Pick at least one kind of alert, or choose "Any alert".';
      return null;
    }

    // ── Step 4 ───────────────────────────────────────────────────────────────
    function editorMeta() {
      var qm = schema && schema.repeatMeta && schema.repeatMeta.quietMeta;
      return { severities: schema && schema.severities, channels: channels, serverClock: qm && qm.serverClock, showSeverities: false };
    }
    function renderStep4() {
      var panel = document.getElementById("qtw-step-4");
      panel.innerHTML = '<h3 style="margin:0 0 0.25rem">When, and what happens</h3>' +
        '<p style="font-size:0.85rem;color:var(--color-text-tertiary);margin:0 0 0.75rem">The quiet period, what it holds, and how the summary email goes out when it ends.</p>' +
        '<div id="qtw-editor">' + window.PolarisQuietTimeEditor.html("qtw", draft.quiet && draft.quiet.windows && draft.quiet.windows.length ? draft.quiet : null, editorMeta()) + "</div>";
      window.PolarisQuietTimeEditor.wire(panel.querySelector("#qtw-editor"), draft.quiet, null);
    }
    function collectStep4() {
      var host = document.querySelector("#qtw-step-4 #qtw-editor");
      if (!host) return;
      var got = window.PolarisQuietTimeEditor.collect(host, { severities: draft.severities });
      draft._quietProblem = got.error || null;
      if (got.config) {
        got.config.alertKinds = draft.alertKinds;
        draft.quiet = got.config;
      }
    }
    function validateStep4() { return draft._quietProblem || (draft.quiet && draft.quiet.windows && draft.quiet.windows.length ? null : "Pick the days and hours of the quiet period."); }

    // ── Step 5 ───────────────────────────────────────────────────────────────
    function renderStep5() {
      var panel = document.getElementById("qtw-step-5");
      var q = draft.quiet || {};
      var kinds = draft.alertKinds ? draft.alertKinds.map(function (k) {
        var meta = (schema.metricMeta && schema.metricMeta[k]) || (schema.fieldMeta && schema.fieldMeta[k]);
        return (meta && meta.label) || k;
      }).join(", ") : "any alert";
      var ch = channels.filter(function (c) { return c.id === q.summaryChannelId; })[0];
      var rows = [
        ["Name", draft.name + (draft.enabled ? "" : " (disabled)")],
        ["Devices", scopeIsAll(draft.scope) ? "All devices" : "Filtered devices"],
        ["Severities", draft.severities ? draft.severities.join(", ") : "every severity"],
        ["Kinds of alert", kinds],
        ["When", (q.windows || []).map(function (w) { return window.PolarisRecurrence.summary(w); }).join("; ")],
        ["Holds", q.holds === "followUps" ? "Only reminders and escalations (the first alert still sends)" : "Everything — summary email afterwards"],
      ];
      if (q.holds !== "followUps") {
        rows.push(["Summary sent", q.summaryAt ? "at " + q.summaryAt + " (server time)" : "when each quiet period ends"]);
        rows.push(["Recurring alerts", q.recurrenceThreshold ? "reported when fired more than " + q.recurrenceThreshold + " times" : "not reported separately"]);
        rows.push(["Email channel", ch ? ch.name : "Automatic"]);
      }
      panel.innerHTML = '<h3 style="margin:0 0 0.25rem">Review &amp; save</h3>' +
        '<dl class="aw-summary-dl" style="display:grid;grid-template-columns:max-content 1fr;gap:0.35rem 1rem;font-size:0.9rem">' +
        rows.map(function (r) { return "<dt style=\"color:var(--color-text-tertiary)\">" + escapeHtml(r[0]) + "</dt><dd style=\"margin:0\">" + escapeHtml(r[1]) + "</dd>"; }).join("") +
        "</dl>";
    }

    // ── Shell ────────────────────────────────────────────────────────────────
    function stepperHtml() {
      var parts = [];
      for (var i = 1; i <= STEPS.length; i++) {
        parts.push('<div class="stepper-step" data-step="' + i + '"><span class="stepper-num">' + i + "</span><span>" + STEPS[i - 1] + "</span></div>");
        if (i < STEPS.length) parts.push('<div class="stepper-line" data-line="' + i + '"></div>');
      }
      return '<div class="stepper" id="qtw-stepper">' + parts.join("") + "</div>";
    }
    var body = stepperHtml() +
      '<div class="step-panel visible" id="qtw-step-1">' + step1Html() + "</div>" +
      '<div class="step-panel" id="qtw-step-2">' + step2Html() + "</div>" +
      '<div class="step-panel" id="qtw-step-3">' + step3Html() + "</div>" +
      '<div class="step-panel" id="qtw-step-4"></div>' +
      '<div class="step-panel" id="qtw-step-5"></div>';
    var footer =
      '<button class="btn btn-secondary" id="qtw-cancel" type="button">Cancel</button>' +
      '<button class="btn btn-secondary" id="qtw-back" type="button" style="display:none">&larr; Back</button>' +
      '<button class="btn btn-primary" id="qtw-next" type="button">Next &rarr;</button>' +
      '<button class="btn btn-primary" id="qtw-save" type="button" style="display:none">' + (editing ? "Save changes" : "Create quiet time") + "</button>";
    openModal(editing ? "Edit global quiet time" : "New global quiet time", body, footer, { wide: true });

    var COLLECT = { 1: collectStep1, 2: collectStep2, 3: collectStep3, 4: collectStep4, 5: function () {} };
    var VALIDATE = { 1: validateStep1, 2: validateStep2, 3: validateStep3, 4: validateStep4, 5: function () { return null; } };

    function updateStepper() {
      document.querySelectorAll("#qtw-stepper .stepper-step").forEach(function (el) {
        var n = Number(el.getAttribute("data-step"));
        el.classList.toggle("active", n === step);
        el.classList.toggle("done", n < step);
        el.classList.toggle("clickable", n <= visited && n !== step);
      });
      document.querySelectorAll("#qtw-stepper .stepper-line").forEach(function (el) {
        el.classList.toggle("done", Number(el.getAttribute("data-line")) < step);
      });
    }
    function syncFooter() {
      document.getElementById("qtw-back").style.display = step > 1 ? "" : "none";
      document.getElementById("qtw-next").style.display = step < STEPS.length ? "" : "none";
      document.getElementById("qtw-save").style.display = (step === STEPS.length || editing) ? "" : "none";
    }
    function goToStep(n, o) {
      o = o || {};
      if (!o.skipCollect) COLLECT[step]();
      if (o.validate) {
        var problem = VALIDATE[step]();
        if (problem) { showToast(problem, "error"); return false; }
      }
      if (step === 2 && previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
      document.getElementById("qtw-step-" + step).classList.remove("visible");
      step = n;
      visited = Math.max(visited, n);
      if (n === 4) renderStep4();
      if (n === 5) renderStep5();
      document.getElementById("qtw-step-" + n).classList.add("visible");
      updateStepper();
      syncFooter();
      var mb = document.querySelector(".modal-body");
      if (mb) mb.scrollTop = 0;
      if (n === 2 && !scopeIsAll(draft.scope)) schedulePreview();
      return true;
    }

    function finish() {
      closeModal();
      if (typeof opts.onDone === "function") opts.onDone();
    }

    async function save(btn) {
      COLLECT[step]();
      for (var i = 1; i <= STEPS.length; i++) {
        var problem = VALIDATE[i]();
        if (problem) {
          if (i !== step) goToStep(i, { skipCollect: true });
          showToast(problem, "error");
          return;
        }
      }
      var quiet = Object.assign({}, draft.quiet, { severities: draft.severities, alertKinds: draft.alertKinds });
      var payload = { name: draft.name.trim(), enabled: draft.enabled, scope: draft.scope, quiet: quiet };
      btn.disabled = true;
      try {
        if (editing) await api.quietTimes.update(editing.id, payload);
        else await api.quietTimes.create(payload);
        showToast(editing ? "Quiet time saved" : "Quiet time created", "success");
        finish();
      } catch (err) {
        btn.disabled = false;
        showToast((err && err.message) || "Save failed", "error");
      }
    }

    document.getElementById("qtw-next").addEventListener("click", function () { goToStep(step + 1, { validate: true }); });
    document.getElementById("qtw-back").addEventListener("click", function () { goToStep(step - 1); });
    document.getElementById("qtw-cancel").addEventListener("click", finish);
    document.getElementById("qtw-save").addEventListener("click", function () { save(this); });
    document.querySelectorAll("#qtw-stepper .stepper-step").forEach(function (el) {
      el.addEventListener("click", function () {
        var n = Number(el.getAttribute("data-step"));
        if (n <= visited && n !== step) goToStep(n);
      });
    });
    if (typeof wireModalStepKeys === "function") wireModalStepKeys({ back: "qtw-back", next: "qtw-next", submit: "qtw-save" });

    wireStep2();
    wireStep3();
    updateStepper();
    syncFooter();
  }

  window.PolarisQuietTimeWizard = { open: open };
})();
