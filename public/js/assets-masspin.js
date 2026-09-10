/**
 * public/js/assets-masspin.js
 *
 * "Mass Pinning" section of the Assets page Settings modal — a manual way to
 * pin AND unpin fast-cadence monitoring targets (interfaces incl. FortiGate
 * IPsec tunnels, storage mounts) across many devices at once:
 *
 *   1. Device filter: the same nested AND/OR condition builder the automation
 *      wizard's Devices step uses (shared public/js/condition-builder.js),
 *      with a debounced matched-device count. Vocabulary comes from
 *      GET /assets/pin-filter-schema (assets:read — deliberately NOT the
 *      automationManagement-gated /automations/schema).
 *   2. Facet picker: Interfaces (IPsec tunnels ride along, routed to
 *      monitoredIpsecTunnels via the row's isIpsecTunnel provenance) or
 *      Storage mounts.
 *   3. "Load matching devices" fetches POST /assets/pin-inventory — the
 *      matched assets' inventory aggregated by name, each row a TRI-STATE
 *      checkbox (checked = pinned on every reporting device, indeterminate =
 *      some, unchecked = none) expandable to per-device checkboxes.
 *   4. Toggles STAGE locally (a Map of diffs vs the server state — staging a
 *      value back to what the server holds deletes the key); Apply sends the
 *      whole batch to POST /assets/mass-pins behind a confirm.
 *
 * Tri-state click semantics (explicit, because an indeterminate checkbox
 * reports checked === false): unchecked/partial click → pin on ALL devices of
 * the row; fully-checked click → unpin on ALL — the house "one more click
 * takes all of them" answer (assets.js alerts bulk-bar precedent).
 *
 * Pure helpers (stageKey/rowState/cycleRow/toggleDevice/buildApplyPayload/
 * summarize) are exposed on window.PolarisMassPin for the happy-dom unit
 * suite; everything DOM-bound lives in init(), which the Settings modal calls
 * once per render (idempotent via a dataset stamp that dies with the section
 * DOM, so the re-render an override delete triggers rebuilds cleanly).
 *
 * Depends on globals: api (api.js), escapeHtml/showToast/showConfirm (app.js),
 * calloutHTML (integrations.js — loaded before this file on assets.html),
 * window.PolarisConditionBuilder (condition-builder.js).
 */

/* global api, escapeHtml, showToast, showConfirm, calloutHTML */

(function () {
  "use strict";

  // ── Pure helpers ───────────────────────────────────────────────────────────
  // \x1f (unit separator) can't appear in an ifName/mountPath, so the key
  // round-trips names containing ":" or "|" safely.
  var SEP = "\x1f";

  function stageKey(field, assetId, name) {
    return field + SEP + assetId + SEP + name;
  }

  function parseStageKey(key) {
    var i1 = key.indexOf(SEP);
    var i2 = key.indexOf(SEP, i1 + 1);
    return {
      field: key.slice(0, i1),
      assetId: key.slice(i1 + 1, i2),
      name: key.slice(i2 + 1),
    };
  }

  /** Which Asset array a row's pins target. */
  function fieldForRow(facet, row) {
    if (facet === "storage") return "storage";
    return row.isIpsecTunnel ? "ipsecTunnels" : "interfaces";
  }

  /** Stage a desired value as a DIFF: equal to the server state ⇒ delete the key. */
  function setStaged(staged, key, desired, serverPinned) {
    if (desired === serverPinned) staged.delete(key);
    else staged.set(key, desired);
  }

  /** Effective (server + staged) pinned state of one device entry on a row. */
  function devicePinned(facet, row, inventory, staged, dev) {
    var key = stageKey(fieldForRow(facet, row), inventory.assets[dev.a].id, row.name);
    return staged.has(key) ? staged.get(key) : dev.pinned;
  }

  /** Tri-state math over effective values: {on, total, state}. */
  function rowState(facet, row, inventory, staged) {
    var on = 0;
    for (var i = 0; i < row.devices.length; i++) {
      if (devicePinned(facet, row, inventory, staged, row.devices[i])) on += 1;
    }
    var total = row.devices.length;
    return {
      on: on,
      total: total,
      state: on === 0 ? "unchecked" : on === total ? "checked" : "indeterminate",
    };
  }

  /**
   * Aggregate-row click: not-all-pinned → pin on every device; all-pinned →
   * unpin on every device. Mutates `staged`; returns the value it staged.
   */
  function cycleRow(facet, row, inventory, staged) {
    var st = rowState(facet, row, inventory, staged);
    var desired = st.on < st.total;
    var field = fieldForRow(facet, row);
    for (var i = 0; i < row.devices.length; i++) {
      var dev = row.devices[i];
      setStaged(staged, stageKey(field, inventory.assets[dev.a].id, row.name), desired, dev.pinned);
    }
    return desired;
  }

  /** Per-device checkbox click: flip that one device's effective state. */
  function toggleDevice(facet, row, inventory, staged, dev) {
    var desired = !devicePinned(facet, row, inventory, staged, dev);
    setStaged(staged, stageKey(fieldForRow(facet, row), inventory.assets[dev.a].id, row.name), desired, dev.pinned);
    return desired;
  }

  /** Staged diffs → the POST /assets/mass-pins body. */
  function buildApplyPayload(staged) {
    var pin = [];
    var unpin = [];
    staged.forEach(function (desired, key) {
      var p = parseStageKey(key);
      (desired ? pin : unpin).push({ assetId: p.assetId, name: p.name, field: p.field });
    });
    return { pin: pin, unpin: unpin };
  }

  /** {pins, unpins, devices} — devices = distinct assetIds touched. */
  function summarize(staged) {
    var pins = 0, unpins = 0;
    var devices = {};
    staged.forEach(function (desired, key) {
      if (desired) pins += 1; else unpins += 1;
      devices[parseStageKey(key).assetId] = true;
    });
    return { pins: pins, unpins: unpins, devices: Object.keys(devices).length };
  }

  // ── Section shell (rendered by _monsetRender; content built in init) ───────
  // A section in the stacked Settings modal, matching the sibling sections'
  // <h4> + content idiom. The inner #mp-root is replaced wholesale by init().
  function sectionHTML() {
    return '<div id="mp-section">' +
      '<h4 style="margin:0 0 0.75rem">Mass Pinning</h4>' +
      '<div id="mp-root"><div class="empty-state" style="padding:1rem 0">Loading&hellip;</div></div>' +
    '</div>';
  }

  // ── DOM wiring ─────────────────────────────────────────────────────────────
  function init() {
    var panel = document.getElementById("mp-section");
    if (!panel || panel.dataset.mpInited === "1") return;
    panel.dataset.mpInited = "1";

    var root = panel.querySelector("#mp-root");
    if (!root) return;

    var CB = window.PolarisConditionBuilder;
    if (!CB) {
      root.innerHTML = '<p class="hint">Condition builder failed to load — reload the page.</p>';
      return;
    }

    // Per-open state. Dies with the panel DOM on every modal re-render.
    var schema = null;        // /assets/pin-filter-schema payload
    var condBuilder = null;
    var staged = new Map();   // stageKey → desired bool (diffs vs server only)
    var inventory = null;     // last-loaded PinInventory
    var lastScope = null;     // scope body of the last successful Load (Apply re-uses it)
    var countTimer = null;

    api.assets.pinFilterSchema().then(function (s) {
      schema = s;
      buildUI();
    }).catch(function (err) {
      root.innerHTML = '<p class="hint">' + escapeHtml(err.message || "Failed to load the device-filter vocabulary") + '</p>' +
        '<button class="btn btn-secondary" id="mp-retry">Retry</button>';
      var retry = root.querySelector("#mp-retry");
      if (retry) retry.addEventListener("click", function () {
        delete panel.dataset.mpInited;
        init();
      });
    });

    function valueOptions(field) {
      var fm = ((schema.scopeCondition || {}).fields || []).find(function (f) { return f.field === field; }) || {};
      if (fm.values) return fm.values.map(function (v) { return { value: v, label: v }; });
      var o = schema.options || {};
      switch (fm.optionsFrom) {
        case "assetTypes":    return (o.assetTypes || []).map(function (t) { return { value: t.name, label: t.label || t.name }; });
        case "manufacturers": return (o.manufacturers || []).map(function (m) { return { value: m, label: m }; });
        case "models":        return (o.models || []).map(function (m) { return { value: m, label: m }; });
        case "interfaceNames": return (o.interfaceNames || []).map(function (n) { return { value: n, label: n }; });
        case "ssids":         return (o.ssids || []).map(function (n) { return { value: n, label: n }; });
        case "tags":          return (o.tags || []).map(function (t) { return { value: t, label: t }; });
        case "subnets":       return (o.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr }; });
        case "ipBlocks":      return (o.ipBlocks || []).map(function (b) { return { value: b.cidr, label: b.name + " — " + b.cidr }; });
        default: return [];
      }
    }

    function buildUI() {
      condBuilder = CB.create({
        meta: schema.scopeCondition,
        valueOptions: valueOptions,
        onChange: scheduleCount,
      });
      root.innerHTML =
        '<p class="hint" style="margin:0 0 0.75rem">Pin or unpin fast-cadence polling targets across many devices at once. ' +
        'Filter the devices, load their inventory, toggle the checkboxes, then Apply — nothing changes until Apply.</p>' +
        '<div class="form-group" style="margin-bottom:0.5rem">' +
          '<label style="font-weight:600"><input type="checkbox" id="mp-all-assets"> All assets</label>' +
          '<p class="hint" style="margin:2px 0 0 24px">Leave unchecked to filter which devices are affected.</p>' +
        '</div>' +
        '<div id="mp-cond-wrap">' +
          '<div id="mp-cond-root">' + condBuilder.groupHtml({ op: "and", children: [] }, 0) + '</div>' +
        '</div>' +
        '<p class="hint" id="mp-count" style="margin:0.5rem 0"></p>' +
        '<div style="display:flex;align-items:center;gap:1rem;flex-wrap:wrap;margin:0.75rem 0">' +
          '<label style="display:flex;align-items:center;gap:4px"><input type="radio" name="mp-facet" value="interfaces" checked style="width:auto"> Interfaces</label>' +
          '<label style="display:flex;align-items:center;gap:4px"><input type="radio" name="mp-facet" value="storage" style="width:auto"> Storage mounts</label>' +
          '<span class="hint">Interfaces include FortiGate IPsec tunnels.</span>' +
          '<button class="btn btn-secondary" id="mp-load" style="margin-left:auto">Load matching devices</button>' +
        '</div>' +
        '<input type="text" id="mp-filter" placeholder="Filter names&hellip;" style="display:none;margin-bottom:0.5rem;max-width:280px">' +
        '<div id="mp-list"></div>' +
        '<div id="mp-warn" style="margin-top:0.5rem"></div>' +
        '<div style="display:flex;align-items:center;gap:1rem;margin-top:0.75rem">' +
          '<span id="mp-summary" class="hint">No staged changes.</span>' +
          '<button class="btn btn-primary" id="mp-apply" disabled style="margin-left:auto">Apply</button>' +
        '</div>';
      wire();
      // Seed a starter condition row so the operator lands on something
      // editable (All assets defaults UNCHECKED — an accidental tab click
      // must never queue a fleet-wide load).
      condBuilder.seedIfEmpty(root.querySelector("#mp-cond-root"));
    }

    function currentFacet() {
      var r = root.querySelector('input[name="mp-facet"]:checked');
      return r ? r.value : "interfaces";
    }

    /**
     * Current scope body, or null with a reason when unloadable. Read the
     * checkbox's .checked PROPERTY, never a :checked selector (happy-dom
     * resolves the selector from the attribute).
     */
    function collectScope() {
      var allCb = root.querySelector("#mp-all-assets");
      if (allCb && allCb.checked) return { scope: { allAssets: true } };
      var rootGroup = root.querySelector("#mp-cond-root > .scg-group");
      if (!rootGroup) return { error: "Add a condition or check All assets." };
      var tree = condBuilder.collect(rootGroup);
      if (!tree.children.length) return { error: 'Add at least one condition, or check "All assets".' };
      var problem = condBuilder.validate(tree);
      if (problem) return { error: problem };
      return { scope: { condition: tree } };
    }

    function scheduleCount() {
      if (countTimer) clearTimeout(countTimer);
      countTimer = setTimeout(runCount, 400);
    }

    async function runCount() {
      var box = root.querySelector("#mp-count");
      if (!box) return;
      var s = collectScope();
      if (s.error) { box.textContent = ""; return; }
      try {
        var res = await api.assets.pinInventory(Object.assign({ facet: currentFacet(), mode: "count" }, s.scope));
        var cap = schema.maxAssets || 1000;
        box.innerHTML = '<strong>' + res.matchedCount + '</strong> device(s) match this filter.' +
          (res.matchedCount > cap ? ' <span style="color:var(--color-warning,#b7791f)">Over the ' + cap + '-device limit — narrow the filter before loading.</span>' : "");
      } catch (err) {
        box.textContent = err.message || "Preview unavailable";
      }
    }

    async function confirmDiscardStaged() {
      if (staged.size === 0) return true;
      var s = summarize(staged);
      return showConfirm("Discard " + (s.pins + s.unpins) + " staged pin change(s)? They have not been applied.");
    }

    function wire() {
      var allCb = root.querySelector("#mp-all-assets");
      allCb.addEventListener("change", function () {
        var wrap = root.querySelector("#mp-cond-wrap");
        wrap.style.display = allCb.checked ? "none" : "block";
        if (!allCb.checked) condBuilder.seedIfEmpty(root.querySelector("#mp-cond-root"));
        scheduleCount();
      });
      condBuilder.wire(root, "#mp-cond-root");

      // Facet switch discards staged edits (the row set changes underneath
      // them; silently carrying invisible staged writes would be worse).
      root.querySelectorAll('input[name="mp-facet"]').forEach(function (radio) {
        radio.addEventListener("change", async function () {
          if (staged.size > 0 && !(await confirmDiscardStaged())) {
            // Revert: re-check the other radio to match the loaded facet.
            var back = root.querySelector('input[name="mp-facet"][value="' + (inventory ? inventory.facet : "interfaces") + '"]');
            if (back) back.checked = true;
            return;
          }
          staged.clear();
          inventory = null;
          root.querySelector("#mp-list").innerHTML = "";
          root.querySelector("#mp-filter").style.display = "none";
          syncFooter();
          scheduleCount();
        });
      });

      root.querySelector("#mp-load").addEventListener("click", async function () {
        var s = collectScope();
        if (s.error) { showToast(s.error, "error"); return; }
        if (!(await confirmDiscardStaged())) return;
        await doLoad(s.scope);
      });

      root.querySelector("#mp-filter").addEventListener("input", applyNameFilter);

      // One delegated listener for every aggregate + device checkbox and the
      // expand chevrons — the list can carry tens of thousands of entries.
      root.querySelector("#mp-list").addEventListener("change", function (e) {
        var t = e.target;
        if (t.hasAttribute("data-mp-row")) {
          var rowIdx = Number(t.getAttribute("data-mp-row"));
          cycleRow(inventory.facet, inventory.rows[rowIdx], inventory, staged);
          syncRow(rowIdx);
          syncFooter();
        } else if (t.hasAttribute("data-mp-dev")) {
          var parts = t.getAttribute("data-mp-dev").split(":");
          var ri = Number(parts[0]), di = Number(parts[1]);
          toggleDevice(inventory.facet, inventory.rows[ri], inventory, staged, inventory.rows[ri].devices[di]);
          syncRow(ri);
          syncFooter();
        }
      });
      root.querySelector("#mp-list").addEventListener("click", function (e) {
        var btn = e.target.closest("[data-mp-expand]");
        if (!btn) return;
        var rowIdx = Number(btn.getAttribute("data-mp-expand"));
        var sub = root.querySelector('[data-mp-sublist="' + rowIdx + '"]');
        if (!sub) return;
        if (sub.style.display === "none") {
          // Sublists render lazily on first expand — 1000 assets × dozens of
          // names would otherwise be tens of thousands of hidden DOM rows.
          if (!sub.dataset.built) { sub.innerHTML = sublistHTML(rowIdx); sub.dataset.built = "1"; }
          sub.style.display = "block";
          btn.textContent = "▾";
        } else {
          sub.style.display = "none";
          btn.textContent = "▸";
        }
      });

      root.querySelector("#mp-apply").addEventListener("click", doApply);
    }

    async function doLoad(scope) {
      var list = root.querySelector("#mp-list");
      var btn = root.querySelector("#mp-load");
      btn.disabled = true;
      list.innerHTML = '<p class="hint">Loading&hellip;</p>';
      try {
        var res = await api.assets.pinInventory(Object.assign({ facet: currentFacet(), mode: "full" }, scope));
        if (res.overCap) {
          inventory = null;
          list.innerHTML = '<p class="hint" style="color:var(--color-warning,#b7791f)">' + res.matchedCount +
            ' devices match — over the ' + (schema.maxAssets || 1000) + '-device limit. Narrow the filter.</p>';
          root.querySelector("#mp-filter").style.display = "none";
          return;
        }
        inventory = res.inventory;
        lastScope = scope;
        staged.clear();
        renderList();
        syncFooter();
      } catch (err) {
        list.innerHTML = '<p class="hint">' + escapeHtml(err.message || "Failed to load inventory") + '</p>';
      } finally {
        btn.disabled = false;
      }
    }

    function renderList() {
      var list = root.querySelector("#mp-list");
      var filterInput = root.querySelector("#mp-filter");
      if (!inventory || inventory.rows.length === 0) {
        var facetLabel = currentFacet() === "storage" ? "storage mounts" : "interfaces";
        list.innerHTML = '<p class="hint">No ' + facetLabel + ' reported in the last 72 hours across the ' +
          (inventory ? inventory.assets.length : 0) + ' matched device(s) — devices with stale inventory are omitted.</p>';
        filterInput.style.display = "none";
        return;
      }
      var html = inventory.rows.map(function (row, i) {
        var typeTag = row.isIpsecTunnel
          ? ' <span class="hint" style="font-size:0.78rem">[IPsec]</span>'
          : (row.ifType ? ' <span class="hint" style="font-size:0.78rem">[' + escapeHtml(row.ifType) + ']</span>' : "");
        return '<div class="mp-row" data-mp-name="' + escapeHtml(row.name.toLowerCase()) + '" style="padding:2px 0">' +
          '<div style="display:flex;align-items:center;gap:6px;font-size:0.86rem">' +
            '<button type="button" class="btn-icon" data-mp-expand="' + i + '" title="Show devices" ' +
              'style="border:none;background:none;cursor:pointer;width:18px;padding:0;color:var(--color-text-tertiary)">▸</button>' +
            '<input type="checkbox" data-mp-row="' + i + '" style="width:auto">' +
            '<span style="font-family:monospace">' + escapeHtml(row.name) + '</span>' + typeTag +
            '<span class="hint" data-mp-rowcount="' + i + '" style="margin-left:auto;font-size:0.78rem"></span>' +
          '</div>' +
          '<div data-mp-sublist="' + i + '" style="display:none;margin:2px 0 4px 42px"></div>' +
        '</div>';
      }).join("");
      list.innerHTML =
        '<div style="max-height:340px;overflow:auto;border:1px solid var(--color-border);border-radius:var(--radius-sm);padding:0.5rem;background:var(--color-bg-tertiary)">' +
        html + '</div>';
      filterInput.style.display = "block";
      applyNameFilter();
      for (var i = 0; i < inventory.rows.length; i++) syncRow(i);
    }

    function sublistHTML(rowIdx) {
      var row = inventory.rows[rowIdx];
      return row.devices.map(function (dev, di) {
        var a = inventory.assets[dev.a];
        return '<label style="display:flex;align-items:center;gap:6px;padding:1px 0;font-size:0.82rem">' +
          '<input type="checkbox" data-mp-dev="' + rowIdx + ':' + di + '" style="width:auto"' +
            (devicePinned(inventory.facet, row, inventory, staged, dev) ? " checked" : "") + '>' +
          '<span>' + escapeHtml(a.hostname || a.id) + '</span>' +
          (a.ipAddress ? '<span class="hint" style="font-size:0.78rem">(' + escapeHtml(a.ipAddress) + ')</span>' : "") +
        '</label>';
      }).join("");
    }

    /** Re-derive one row's aggregate checkbox + count line + open sublist. */
    function syncRow(rowIdx) {
      var row = inventory.rows[rowIdx];
      var st = rowState(inventory.facet, row, inventory, staged);
      var cb = root.querySelector('input[data-mp-row="' + rowIdx + '"]');
      if (cb) {
        cb.checked = st.state === "checked";
        cb.indeterminate = st.state === "indeterminate";
      }
      var count = root.querySelector('[data-mp-rowcount="' + rowIdx + '"]');
      if (count) count.textContent = "pinned on " + st.on + " / " + st.total + " device" + (st.total === 1 ? "" : "s");
      var sub = root.querySelector('[data-mp-sublist="' + rowIdx + '"]');
      if (sub && sub.dataset.built) {
        sub.querySelectorAll("input[data-mp-dev]").forEach(function (dcb) {
          var di = Number(dcb.getAttribute("data-mp-dev").split(":")[1]);
          dcb.checked = devicePinned(inventory.facet, row, inventory, staged, row.devices[di]);
        });
      }
    }

    /** View-only substring filter — hidden rows keep their checkbox state. */
    function applyNameFilter() {
      var q = (root.querySelector("#mp-filter").value || "").trim().toLowerCase();
      root.querySelectorAll(".mp-row").forEach(function (rowEl) {
        rowEl.style.display = !q || rowEl.getAttribute("data-mp-name").indexOf(q) !== -1 ? "" : "none";
      });
    }

    function syncFooter() {
      var s = summarize(staged);
      var summaryEl = root.querySelector("#mp-summary");
      var warnEl = root.querySelector("#mp-warn");
      var applyBtn = root.querySelector("#mp-apply");
      if (s.pins + s.unpins === 0) {
        summaryEl.textContent = "No staged changes.";
        warnEl.innerHTML = "";
        applyBtn.disabled = true;
        return;
      }
      summaryEl.innerHTML = "<strong>+" + s.pins + " pin(s) / −" + s.unpins + " unpin(s)</strong> across " + s.devices + " device(s)";
      warnEl.innerHTML = s.unpins > 0 && typeof calloutHTML === "function"
        ? calloutHTML("warning", "Unpinning stops fast polling",
            "Unpinned interfaces and tunnels stop collecting fast-cadence history (new samples keep only 24 hours) and stop being eligible for interface alerting. Storage mounts keep evaluating on slow samples.")
        : "";
      applyBtn.disabled = false;
    }

    async function doApply() {
      var s = summarize(staged);
      var ok = await showConfirm("Apply +" + s.pins + " pin(s) / −" + s.unpins + " unpin(s) across " + s.devices + " device(s)?");
      if (!ok) return;
      var btn = root.querySelector("#mp-apply");
      btn.disabled = true;
      try {
        var res = await api.assets.applyMassPins(buildApplyPayload(staged));
        showToast("Updated " + res.updatedAssets + " asset(s): +" + res.pinsAdded + " pin(s) / −" + res.pinsRemoved + " unpin(s)");
        if (res.skipped && res.skipped.length) {
          showToast(res.skipped.length + " asset(s) skipped (pin cap or errors) — see the Events page for detail", "error");
        }
        staged.clear();
        // Reload against the scope of the LAST load, not whatever the builder
        // holds now — the checklist must show the post-apply server truth for
        // the set the operator just edited.
        if (lastScope) await doLoad(lastScope);
        syncFooter();
      } catch (err) {
        showToast(err.message || "Apply failed", "error");
        btn.disabled = false;
      }
    }
  }

  window.PolarisMassPin = {
    sectionHTML: sectionHTML,
    init: init,
    // Pure helpers, exposed for the unit suite.
    stageKey: stageKey,
    parseStageKey: parseStageKey,
    fieldForRow: fieldForRow,
    setStaged: setStaged,
    devicePinned: devicePinned,
    rowState: rowState,
    cycleRow: cycleRow,
    toggleDevice: toggleDevice,
    buildApplyPayload: buildApplyPayload,
    summarize: summarize,
  };
})();
