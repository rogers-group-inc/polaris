/**
 * public/js/dashboard.js — Dashboard orchestrator (column layout, v2).
 *
 * SolarWinds-style model:
 *   - The dashboard is an ordered list of COLUMNS; each column has a 12-grid
 *     width (3|4|6|12) and a vertical stack of widgets. Array order is the
 *     layout — there is no free-grid reflow.
 *   - EDIT MODE is explicit: the page is read-only until "Customize Page";
 *     edit mode reveals drag handles, remove ×, width/height controls, the
 *     "+ new column" drop target, and the gear config. "Done Editing" saves
 *     and exits.
 *   - Drag a widget (from the picker or an existing one) → a green "+"
 *     insertion placeholder marks the target slot; a trailing empty column is
 *     a "new column" drop target. The dragged widget lifts (shadow).
 *
 * Layout state mirrors the server: { version: 2, columns: [ { id, width,
 * widgets: [ { id, type, height, config } ] } ] }. Legacy v1 layouts are
 * migrated to v2 on load (migrateV1ToV2). Per-widget render lifecycle
 * (fetchData → renderInstance → ctx.onUnmount) is unchanged from v1.
 */

(function () {
  var ROW_HEIGHT_PX = 280;
  var GAP_PX = 16;
  var SAVE_DEBOUNCE_MS = 800;
  var WIDTH_STEPS = [3, 4, 6, 12];
  var HEIGHT_STEPS = [1, 2, 3];

  // Layout is v3: multiple named dashboards (tabs), each a column layout.
  //   { version:3, dashboards:[{ id, name, columns:[...] }], activeId }
  var state = {
    layout: { version: 3, dashboards: [], activeId: null },
    editing: false,
    saving: false,
    saveTimer: null,
    unmounts: {},  // widget instance id → cleanup fn
    // A PUBLISHED (public) saved dashboard being viewed instead of the
    // viewer's own layout — the Dash wallboard's "load a public dashboard"
    // mode (dashboard-saved.js). While set, the canvas renders THIS and
    // nothing here may be edited or persisted: the wallboard has no session
    // to save with, and its own local layout must survive being looked away
    // from. { id, name, ownerName, columns }.
    external: null,
  };

  // The currently-shown dashboard. All column/widget logic operates on its
  // .columns; switching tabs just repoints activeId. Always returns an object
  // (falls back to the first, or a fresh empty one) so callers never null-check.
  function activeDash() {
    // Viewing a published dashboard: one screen, no tabs, nothing to switch to.
    if (state.external) {
      return { id: "published:" + state.external.id, name: state.external.name, columns: state.external.columns };
    }
    var d = state.layout.dashboards;
    if (!d || !d.length) {
      state.layout.dashboards = [{ id: PolarisWidgets.uuid(), name: "Dashboard 1", columns: [] }];
      state.layout.activeId = state.layout.dashboards[0].id;
      return state.layout.dashboards[0];
    }
    var found = d.find(function (x) { return x.id === state.layout.activeId; });
    if (!found) { found = d[0]; state.layout.activeId = found.id; }
    return found;
  }

  var canvasEl = null;
  var emptyEl = null;
  var tabsEl = null;
  var customizeBtn = null;
  var refreshBtn = null;
  var addWidgetsBtn = null;
  var doneBtn = null;
  var createBtn = null;
  var openPopover = null;
  // The empty-state prompt as the page shipped it — restored when a published
  // dashboard is closed, since viewing an EMPTY published one rewrites it.
  var emptyDefaultHTML = "";

  // Drag stashes — dataTransfer.getData() is unreadable during dragover, so
  // the dragged type/id are stashed module-level at dragstart, cleared at
  // dragend. `_placeholder` is the single green "+" insertion marker.
  var _dragStashId = null;
  var _dragStashType = null;
  var _placeholder = null;

  document.addEventListener("DOMContentLoaded", function () {
    canvasEl     = document.getElementById("dashboard-canvas");
    emptyEl      = document.getElementById("dashboard-empty-state");
    tabsEl       = document.getElementById("dashboard-tabs");
    customizeBtn = document.getElementById("dashboard-customize");
    refreshBtn   = document.getElementById("dashboard-refresh");
    addWidgetsBtn = document.getElementById("dashboard-add-widgets");
    doneBtn      = document.getElementById("dashboard-done");
    createBtn    = document.getElementById("dashboard-create");

    if (!canvasEl || !emptyEl || !customizeBtn) return;
    emptyDefaultHTML = emptyEl.innerHTML;

    customizeBtn.addEventListener("click", enterEditMode);
    if (refreshBtn) refreshBtn.addEventListener("click", refreshWidgets);
    if (addWidgetsBtn) addWidgetsBtn.addEventListener("click", function () { WidgetLibrary.open(handleTapToAdd); });
    if (doneBtn) doneBtn.addEventListener("click", exitEditMode);
    if (createBtn) createBtn.addEventListener("click", createDashboard);

    canvasEl.addEventListener("dragover", onCanvasDragOver);
    canvasEl.addEventListener("dragleave", onCanvasDragLeave);
    canvasEl.addEventListener("drop", onCanvasDrop);

    // Library-card dragstarts happen in the picker overlay (outside the
    // canvas), so capture at the document level to stash the type.
    document.addEventListener("dragstart", function (e) {
      var card = e.target && e.target.closest ? e.target.closest(".widget-library-card[data-type]") : null;
      if (card) { _dragStashType = card.getAttribute("data-type"); _dragStashId = null; }
    });
    document.addEventListener("dragend", clearDragState);

    document.addEventListener("click", function (e) {
      if (!openPopover) return;
      if (openPopover.el.contains(e.target)) return;
      // A filter field's picker modal is opened FROM the popover and sits
      // above it; and a pill's × re-renders its field, detaching the clicked
      // button before this handler sees it. Neither is a click outside.
      if (e.target.closest && e.target.closest(".widget-filter-picker")) return;
      if (!e.target.isConnected) return;
      if (e.target.closest && e.target.closest(".dashboard-widget-action[data-action='gear']")) return;
      closePopover();
    });
    // Escape closes the gear popover (the picker modal above it takes its own
    // Escape in the capture phase, so this never sees that one).
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && openPopover) closePopover();
    });

    bootstrap();
    maybeShowWelcomeModal();
  });

  // ─── Bootstrap + migration ──────────────────────────────────────────────

  // Dash wallboard mode (dash.html, flagged by dash-mode.js): there is no
  // session, so the layout lives in the viewer's browser instead of the
  // per-user UserDashboard row. normalizeLayout already handles null/garbage.
  var DASH_LOCAL_KEY = "polaris-dash-layout";

  function readLocalLayout() {
    try {
      var raw = localStorage.getItem(DASH_LOCAL_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_err) {
      return null;
    }
  }

  async function bootstrap() {
    var loaded;
    if (window.POLARIS_DASH_LOCAL) {
      // A wallboard pinned to a published dashboard restores THAT, not its own
      // layout — a kiosk that reboots must come back to the same screen. The
      // local layout is still read (it is what "My layout" returns to), and a
      // published dashboard that has since been deleted or unpublished falls
      // back to it rather than leaving the wallboard blank.
      loaded = readLocalLayout();
      if (window.PolarisSavedDashboards && typeof window.PolarisSavedDashboards.restorePinned === "function") {
        try { await window.PolarisSavedDashboards.restorePinned(); } catch (_err) { /* falls back to local */ }
      }
    } else {
      try {
        loaded = await api.me.dashboard.get();
      } catch (_err) {
        loaded = null;
      }
    }
    state.layout = normalizeLayout(loaded);

    // Drop-silently: across EVERY dashboard, widget types no longer registered
    // are filtered out and emptied columns dropped. Persist if anything changed.
    var before = JSON.stringify(state.layout.dashboards);
    state.layout.dashboards.forEach(function (dash) {
      dash.columns.forEach(function (col) {
        col.widgets = col.widgets.filter(function (w) { return PolarisWidgets.getByType(w.type) != null; });
      });
      dash.columns = dash.columns.filter(function (col) { return col.widgets.length > 0; });
    });
    if (JSON.stringify(state.layout.dashboards) !== before) queueSave();

    setHeaderMode();
    renderRoot();
  }

  // ─── First-run welcome modal ────────────────────────────────────────────
  // Greets an admin landing on the dashboard while the instance is still
  // being stood up (no IP blocks yet, or no integrations yet) with the
  // getting-started steps. Shows once per user per browser: the dismissal
  // flag is stamped at show time so every close path (X, backdrop, footer
  // buttons) counts as "seen". Non-admins and fully set-up instances never
  // see it. Key naming follows `polaris.panellock.<username>` in app.js.

  function welcomeDismissKey() { return "polaris.welcome.dismissed." + (currentUsername || "anon"); }

  async function maybeShowWelcomeModal() {
    await userReady;
    if (!isAdmin()) return;
    try { if (localStorage.getItem(welcomeDismissKey())) return; } catch (_) {}

    var blocks, integrations;
    try {
      var results = await Promise.all([api.blocks.list(), api.integrations.list()]);
      blocks = Array.isArray(results[0]) ? results[0] : (results[0] && results[0].blocks) || [];
      integrations = Array.isArray(results[1]) ? results[1] : (results[1] && results[1].integrations) || [];
    } catch (_) {
      return; // can't tell whether the instance is fresh — don't nag
    }
    var hasBlocks = blocks.length > 0;
    var hasIntegrations = integrations.length > 0;
    if (hasBlocks && hasIntegrations) return;

    try { localStorage.setItem(welcomeDismissKey(), new Date().toISOString()); } catch (_) {}

    function stepHTML(num, done, title, desc) {
      var badge = done
        ? '<span style="flex:none;width:26px;height:26px;border-radius:50%;background:var(--color-success);color:#fff;display:flex;align-items:center;justify-content:center;font-size:0.85rem" aria-label="Done">&#10003;</span>'
        : '<span style="flex:none;width:26px;height:26px;border-radius:50%;background:var(--color-surface);border:1px solid var(--color-border);color:var(--color-text-secondary);display:flex;align-items:center;justify-content:center;font-size:0.85rem">' + num + '</span>';
      return (
        '<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0">' +
          badge +
          '<div>' +
            '<div style="font-weight:600' + (done ? ";text-decoration:line-through;color:var(--color-text-tertiary)" : "") + '">' + title + '</div>' +
            '<div style="font-size:0.85rem;color:var(--color-text-secondary);margin-top:2px">' + desc + '</div>' +
          '</div>' +
        '</div>'
      );
    }

    var bodyHTML =
      '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
        'Polaris pulls the systems you already run into one dashboard — your assets, the address space they live in, and how they are doing. A couple of steps get it working for you:' +
      '</p>' +
      stepHTML(1, hasBlocks, 'Add an IP block',
        'On the <a href="/ipam.html">IPAM</a> page, create a top-level block for the address space you manage (e.g. <code>10.0.0.0/8</code>). Blocks are the namespaces every network and reservation lives under.') +
      stepHTML(2, false, 'Carve out networks',
        'Within a block, add the subnets your sites and VLANs actually use — or skip ahead and let discovery create them for you.') +
      stepHTML(3, hasIntegrations, 'Connect your first integration',
        'On the <a href="/integrations.html">Integrations</a> page, connect FortiManager, FortiGate, Microsoft Entra ID, Active Directory, or a Windows DHCP server. Discovery then fills in networks, reservations, and assets automatically and keeps them current.');

    var footerHTML =
      '<button class="btn btn-secondary" id="welcome-close-btn">Close</button>' +
      (hasBlocks
        ? '<button class="btn btn-primary" id="welcome-cta-btn" data-href="/integrations.html">Set Up an Integration</button>'
        : '<button class="btn btn-primary" id="welcome-cta-btn" data-href="/ipam.html">Add an IP Block</button>');

    openModal("Welcome to Polaris", bodyHTML, footerHTML);
    document.getElementById("welcome-close-btn").addEventListener("click", closeModal);
    document.getElementById("welcome-cta-btn").addEventListener("click", function (e) {
      window.location.href = e.currentTarget.getAttribute("data-href");
    });
  }

  // Normalize any stored layout to v3 (multi-dashboard). v3 passes through;
  // v2 (single column layout) and v1 (free-grid) are wrapped into one
  // "Dashboard 1" tab; anything else becomes a single empty dashboard.
  function normalizeLayout(data) {
    if (data && data.version === 3 && Array.isArray(data.dashboards) && data.dashboards.length) {
      if (!data.activeId || !data.dashboards.some(function (d) { return d.id === data.activeId; })) {
        data.activeId = data.dashboards[0].id;
      }
      return data;
    }
    var columns = [];
    if (data && data.version === 2 && Array.isArray(data.columns)) columns = data.columns;
    else if (data && data.version === 1 && Array.isArray(data.widgets)) columns = migrateV1ToV2(data).columns;
    var id = PolarisWidgets.uuid();
    return { version: 3, dashboards: [{ id: id, name: "Dashboard 1", columns: columns }], activeId: id };
  }

  // v1 {widgets:[{col,row,width,height}]} → v2 columns: bucket by col-start,
  // order by row within each, column width = closest snap of the widest
  // widget. Everything (id/type/config) preserved; empty fallback on error.
  function migrateV1ToV2(v1) {
    try {
      var byCol = {};
      v1.widgets.forEach(function (w) {
        var k = (w.col == null ? 0 : w.col);
        (byCol[k] = byCol[k] || []).push(w);
      });
      var starts = Object.keys(byCol).map(Number).sort(function (a, b) { return a - b; });
      var columns = starts.map(function (cs) {
        var ws = byCol[cs].slice().sort(function (a, b) { return (a.row || 0) - (b.row || 0); });
        var maxW = ws.reduce(function (m, w) { return Math.max(m, w.width || 6); }, 0);
        return {
          id: PolarisWidgets.uuid(),
          width: snapWidth(maxW),
          widgets: ws.map(function (w) {
            return { id: w.id || PolarisWidgets.uuid(), type: w.type, height: (w.height === 2 ? 2 : 1), config: w.config || {} };
          }),
        };
      });
      return { version: 2, columns: columns };
    } catch (_e) {
      return { version: 2, columns: [] };
    }
  }

  function snapWidth(n) {
    var best = WIDTH_STEPS[0], bestD = Infinity;
    WIDTH_STEPS.forEach(function (s) { var d = Math.abs(n - s); if (d < bestD) { bestD = d; best = s; } });
    return best;
  }

  function totalWidgets() {
    return activeDash().columns.reduce(function (n, c) { return n + c.widgets.length; }, 0);
  }

  // ─── Edit mode ────────────────────────────────────────────────────────────

  function enterEditMode() {
    if (state.external) return;
    state.editing = true; setHeaderMode(); renderRoot();
  }
  function exitEditMode() {
    state.editing = false;
    setHeaderMode();
    WidgetLibrary.close();
    if (state.saveTimer) saveNow();
    renderRoot();
  }
  function setHeaderMode() {
    // A published dashboard belongs to whoever published it: the viewer gets
    // no Customize / Add Widgets / Create, so there is no way to build an edit
    // that could not be saved.
    // Creating a dashboard is an edit-mode verb like Add Widgets: it is the +
    // after the last tab (renderTabs), drawn only while customizing. The
    // header's old Create New Dashboard button is gone; createBtn stays null.
    var viewingPublished = !!state.external;
    if (customizeBtn)   customizeBtn.hidden   = state.editing || viewingPublished;
    // Refresh is a viewing verb, so a published dashboard keeps it.
    if (refreshBtn)     refreshBtn.hidden     = state.editing;
    // Widgets are added from each block's "+ Add Widget" (or "+ New Widget
    // Block"); the header's Add Widgets button is gone, addWidgetsBtn null.
    if (addWidgetsBtn)  addWidgetsBtn.hidden  = true;
    if (doneBtn)        doneBtn.hidden        = !state.editing || viewingPublished;
    if (createBtn)      createBtn.hidden      = true;
    canvasEl.classList.toggle("is-editing", state.editing && !viewingPublished);
    // The Dashboards menu (dashboard-saved.js) shows only while customizing
    // or viewing a published dashboard; it re-gates on this.
    // The document's own realm's constructor: a DOM test evals this file
    // where the global CustomEvent is Node's, which happy-dom rejects.
    var view = document.defaultView || window;
    document.dispatchEvent(new view.CustomEvent("polaris:dashboard-mode"));
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  // Header Refresh: remount every widget body in place (the column shells
  // stay), so each fetches its data now instead of waiting for its own
  // interval. Nothing is saved.
  function refreshWidgets() {
    if (state.editing) return;
    activeDash().columns.forEach(function (col) { col.widgets.forEach(renderWidget); });
  }

  function unmountAll() {
    Object.keys(state.unmounts).forEach(function (id) {
      try { state.unmounts[id](); } catch (_) {}
    });
    state.unmounts = {};
  }

  // Choose between the empty-state prompt and the canvas, then render. The tab
  // bar (when >1 dashboard) renders above either, independent of empty state.
  function renderRoot() {
    renderTabs();
    if (!state.editing && totalWidgets() === 0) { showEmpty(); return; }
    hideEmpty();
    renderCanvas();
  }

  // ─── Dashboards / tabs ────────────────────────────────────────────────────

  // Tab bar appears once there's more than one dashboard. Click a tab to
  // switch; in edit mode each tab can be renamed (double-click) and removed (×).
  function renderTabs() {
    if (!tabsEl) return;
    if (state.external) { tabsEl.hidden = true; tabsEl.innerHTML = ""; return; }
    var dashes = state.layout.dashboards || [];
    // The strip shows even with one dashboard: its tab names the canvas and
    // is the folder tab the page card opens from. Only an empty layout hides it.
    if (!dashes.length) { tabsEl.hidden = true; tabsEl.innerHTML = ""; return; }
    tabsEl.hidden = false;
    tabsEl.innerHTML = dashes.map(function (d) {
      var active = d.id === state.layout.activeId;
      // In edit mode the ACTIVE tab's name is an inline text input — click it
      // and type to rename. Other tabs show a plain name (click to switch).
      var nameHtml = (state.editing && active)
        ? '<input type="text" class="dashboard-tab-name-input" data-name="' + escapeHtml(d.id) + '" value="' + escapeHtml(d.name || "") + '" maxlength="60" size="' + Math.max((d.name || "").length, 8) + '" aria-label="Dashboard name">'
        : '<span class="dashboard-tab-name">' + escapeHtml(d.name || "Untitled") + '</span>';
      return '<div class="dashboard-tab' + (active ? " active" : "") + '" data-dash="' + escapeHtml(d.id) + '" role="button" tabindex="0">' +
        nameHtml +
        (state.editing && dashes.length > 1 ? '<button type="button" class="dashboard-tab-remove" data-remove="' + escapeHtml(d.id) + '" title="Delete dashboard">&times;</button>' : '') +
      '</div>';
    }).join("") +
      // Edit mode: a + after the last tab adds a dashboard (it replaced the
      // header's Create New Dashboard button).
      (state.editing
        ? '<button type="button" class="table-tab-add dashboard-tab-add" id="dashboard-tab-add" title="New dashboard" aria-label="New dashboard">+</button>'
        : "");
    var addTabBtn = tabsEl.querySelector("#dashboard-tab-add");
    if (addTabBtn) addTabBtn.addEventListener("click", createDashboard);
    tabsEl.querySelectorAll(".dashboard-tab").forEach(function (tab) {
      var id = tab.getAttribute("data-dash");
      tab.addEventListener("click", function (e) {
        if (e.target.closest("[data-remove]")) { e.stopPropagation(); deleteDashboard(id); return; }
        if (e.target.closest(".dashboard-tab-name-input")) return; // editing the active name, don't switch
        switchDashboard(id);
      });
    });
    // Drag a tab to a new place, in and out of edit mode (folder-tabs.js,
    // shared with the Assets view tabs). The whole tab is the handle; a press
    // on the rename input or the × never starts one. Wired once on the strip,
    // by delegation, so it survives this innerHTML re-render. Not on a
    // published dashboard, which is someone else's layout.
    if (window.PolarisFolderTabs && window.PolarisFolderTabs.wireDrag) {
      window.PolarisFolderTabs.wireDrag(tabsEl, tabsEl, {
        tabSel: ".dashboard-tab",
        idAttr: "data-dash",
        canStart: function () { return !state.external; },
        onDrop: function (ids, moved) { setDashboardOrder(ids, moved); },
      });
    }
    // Inline rename on the active tab's input: Enter or blur commits, Esc cancels.
    var input = tabsEl.querySelector(".dashboard-tab-name-input");
    if (input) {
      // The field is bare text (styles.css), so it is sized to its text —
      // the `size` attribute counts average-width characters and left a gap
      // after the name. Re-fitted on every keystroke.
      fitNameInput(input);
      input.addEventListener("input", function () { fitNameInput(input); });
      input.addEventListener("click", function (e) { e.stopPropagation(); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); input.blur(); }
        else if (e.key === "Escape") { input.value = nameOf(input.getAttribute("data-name")); input.blur(); }
      });
      input.addEventListener("blur", function () { commitTabName(input.getAttribute("data-name"), input.value); });
    }
  }

  // Width of the input's text in its own font, measured on a hidden span; an
  // empty name keeps 2ch so there is still something to click. Cosmetic, so
  // it can never break the tab row: a measuring failure leaves the `size`
  // attribute's width in place. A width of 0 (nothing laid out) is ignored.
  function fitNameInput(input) {
    try {
      var probe = document.getElementById("dashboard-tab-name-probe");
      if (!probe) {
        probe = document.createElement("span");
        probe.id = "dashboard-tab-name-probe";
        probe.setAttribute("aria-hidden", "true");
        probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;left:-9999px;top:0";
        document.body.appendChild(probe);
      }
      var cs = window.getComputedStyle(input);
      probe.style.font = cs.font;
      probe.style.letterSpacing = cs.letterSpacing;
      probe.textContent = input.value;
      var w = probe.getBoundingClientRect().width;
      if (!input.value) input.style.width = "2ch";
      else if (w > 0) input.style.width = Math.ceil(w) + 2 + "px";
    } catch (_) { /* keep the size-attribute width */ }
  }

  function nameOf(id) {
    var d = state.layout.dashboards.find(function (x) { return x.id === id; });
    return d ? (d.name || "") : "";
  }

  function commitTabName(id, value) {
    var d = state.layout.dashboards.find(function (x) { return x.id === id; });
    if (!d) return;
    var name = (value || "").trim().slice(0, 60);
    if (!name || name === d.name) { renderTabs(); return; } // blank/unchanged → restore
    d.name = name;
    queueSave();
    renderTabs();
  }

  function createDashboard() {
    var id = PolarisWidgets.uuid();
    var n = (state.layout.dashboards.length || 0) + 1;
    state.layout.dashboards.push({ id: id, name: "Dashboard " + n, columns: [] });
    state.layout.activeId = id;
    // New tab is empty and ready to edit, per the feature intent.
    state.editing = true;
    setHeaderMode();
    renderRoot();
    queueSave();
  }

  // The strip's DOM order after a drag, written back into the layout. A
  // drop that left a tab where it was saves nothing.
  function setDashboardOrder(ids, moved) {
    var arr = state.layout.dashboards;
    var byId = {};
    arr.forEach(function (d) { byId[d.id] = d; });
    var next = ids.map(function (id) { return byId[id]; }).filter(Boolean);
    if (next.length === arr.length) {
      state.layout.dashboards = next;
      if (moved) queueSave();
    }
    renderTabs();
  }

  function switchDashboard(id) {
    if (id === state.layout.activeId) return;
    state.layout.activeId = id;
    closePopover();
    renderRoot();
    queueSave();
  }

  async function deleteDashboard(id) {
    if (state.layout.dashboards.length <= 1) return; // never remove the last
    if (!(await showConfirm("Delete this dashboard and its widgets?"))) return;
    applyChange(function () {
      state.layout.dashboards = state.layout.dashboards.filter(function (x) { return x.id !== id; });
      if (state.layout.activeId === id) state.layout.activeId = state.layout.dashboards[0].id;
    });
  }

  function showEmpty() {
    if (state.external) {
      emptyEl.textContent = 'The published dashboard "' + state.external.name + '" has no widgets on it.';
    } else if (emptyDefaultHTML) {
      emptyEl.innerHTML = emptyDefaultHTML;
    }
    emptyEl.hidden = false;
    canvasEl.hidden = true;
    canvasEl.innerHTML = "";
    unmountAll();
  }
  function hideEmpty() {
    emptyEl.hidden = true;
    canvasEl.hidden = false;
  }

  function renderCanvas() {
    unmountAll();
    canvasEl.innerHTML = "";
    _placeholder = null;
    activeDash().columns.forEach(function (col, ci) {
      canvasEl.appendChild(mountColumnShell(col, ci));
    });
    if (state.editing) canvasEl.appendChild(buildNewColumnTarget());
    // Mount widget bodies after all shells are in the DOM.
    activeDash().columns.forEach(function (col) { col.widgets.forEach(renderWidget); });
  }

  function mountColumnShell(col, ci) {
    var colEl = document.createElement("section");
    colEl.className = "dashboard-column";
    colEl.setAttribute("data-col-id", col.id);
    colEl.style.gridColumn = "span " + col.width;

    if (state.editing) {
      var header = document.createElement("div");
      header.className = "dashboard-column-header";
      header.innerHTML = widthCtlHTML(col.width) +
        '<button type="button" class="dashboard-column-remove" data-action="remove-column" title="Remove column">&times;</button>';
      header.querySelectorAll("[data-w]").forEach(function (btn) {
        btn.addEventListener("click", function () { setColumnWidth(col.id, parseInt(btn.getAttribute("data-w"), 10)); });
      });
      header.querySelector('[data-action="remove-column"]').addEventListener("click", function () { removeColumn(col.id); });
      colEl.appendChild(header);
    }

    var stack = document.createElement("div");
    stack.className = "dashboard-column-stack";
    col.widgets.forEach(function (w) { stack.appendChild(mountWidgetShell(w)); });
    colEl.appendChild(stack);
    // "+ Add Widget" closes each block in edit mode: the picker opened from
    // here adds to THIS block, at its bottom. Outside the stack, so the drag
    // placeholder's slot arithmetic (which counts the stack's cards) is
    // untouched.
    if (state.editing) {
      var add = document.createElement("button");
      add.type = "button";
      add.className = "dashboard-column-add";
      add.textContent = "+ Add Widget";
      add.addEventListener("click", function () {
        if (_dragStashId || _dragStashType) return;
        WidgetLibrary.open(function (type) { addWidgetToColumn(type, col.id); });
      });
      colEl.appendChild(add);
    }
    return colEl;
  }

  var WIDTH_LABELS = { 3: "¼", 4: "⅓", 6: "½", 12: "Full" };
  function widthCtlHTML(active) {
    return '<div class="dashboard-column-width-ctl">' + WIDTH_STEPS.map(function (w) {
      return '<button type="button" data-w="' + w + '"' + (w === active ? ' class="active"' : '') +
        ' title="Width ' + w + '/12">' + WIDTH_LABELS[w] + '</button>';
    }).join("") + '</div>';
  }

  // Widget header title — composed by the widget registry (PolarisWidgets.
  // widgetTitle) from the module's label plus the asset-type and
  // minimum-severity gear filters. Kept as a local alias since several call
  // sites use it.
  function widgetTitleFor(module, w) {
    return PolarisWidgets.widgetTitle(module, w);
  }

  // The Server Settings gear (the sidebar's `settings` icon in app.js),
  // copied rather than read from there: the /dash wallboard runs this file
  // without app.js. The ⚙ glyph it replaced rendered at text size and read
  // as too small beside the header's other controls.
  var GEAR_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>';

  function mountWidgetShell(w) {
    var module = PolarisWidgets.getByType(w.type);
    var label = widgetTitleFor(module, w);
    var article = document.createElement("article");
    article.className = "dashboard-widget";
    article.setAttribute("data-id", w.id);
    article.setAttribute("data-type", w.type);
    // Fixed pixel height so widget bodies (charts, Leaflet map) get a sized
    // container. height 1/2/3 rows → 280 / 576 / 872px (N rows + the gaps).
    var hRows = Math.min(3, Math.max(1, w.height || 1));
    article.style.height = (hRows * ROW_HEIGHT_PX + (hRows - 1) * GAP_PX) + "px";

    // In edit mode a dedicated grip is the drag handle — a clear, easy target
    // for dragging the widget to another column (the title alone was too easy
    // to miss). The whole widget can move across columns from here.
    var grip = state.editing ? '<span class="dashboard-widget-grip" draggable="true" title="Drag to move (to any column)">⠿</span>' : "";
    var editControls = state.editing
      ? '<button type="button" class="dashboard-widget-height-toggle" data-action="height" title="Height (click to cycle 1×/2×/3×)">' + (Math.min(3, Math.max(1, w.height || 1))) + '×</button>' +
        '<button type="button" class="dashboard-widget-action dashboard-widget-gear" data-action="gear" title="Configure" aria-label="Configure widget">' + GEAR_SVG + '</button>' +
        '<button type="button" class="dashboard-widget-remove" data-action="remove" title="Remove">&times;</button>'
      : "";
    article.innerHTML =
      '<div class="dashboard-widget-header">' +
        grip +
        '<div class="dashboard-widget-title" title="' + escapeHtml(label) + '">' + escapeHtml(label) + '</div>' +
        editControls +
      '</div>' +
      '<div class="dashboard-widget-body"></div>';

    if (state.editing) {
      var gripEl = article.querySelector(".dashboard-widget-grip");
      gripEl.addEventListener("dragstart", function (e) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("application/x-polaris-widget-move", w.id);
        e.dataTransfer.setData("text/plain", w.id);
        _dragStashId = w.id;
        _dragStashType = null;
        article.classList.add("lifted");
        canvasEl.classList.add("is-dragging");
      });
      gripEl.addEventListener("dragend", clearDragState);

      article.querySelector('[data-action="gear"]').addEventListener("click", function (ev) {
        ev.stopPropagation();
        openGearPopover(w, ev.currentTarget);
      });
      article.querySelector('[data-action="height"]').addEventListener("click", function () {
        // Cycle 1× → 2× → 3× → 1×.
        setWidgetHeight(w.id, (Math.min(3, Math.max(1, w.height || 1)) % 3) + 1);
      });
      article.querySelector('[data-action="remove"]').addEventListener("click", function () { removeWidget(w.id); });
    }
    return article;
  }

  function buildNewColumnTarget() {
    var el = document.createElement("div");
    el.className = "dashboard-newcol-target";
    el.setAttribute("data-newcol", "1");
    el.innerHTML = '<span>+ New Widget Block</span>';
    // Click-to-add (keyboard/touch parity with drag): the widget picked here
    // STARTS a new block. It used to go through handleTapToAdd, which appends
    // to the last block — so the target said "New block" and the widget
    // landed in an existing one.
    el.addEventListener("click", function () {
      if (_dragStashId || _dragStashType) return;
      WidgetLibrary.open(function (type) { addWidgetAt(type, { newColumn: true }); });
    });
    return el;
  }

  // renderWidget — per-widget mount lifecycle. UNCHANGED from v1: clears the
  // body, runs fetchData → renderInstance, registers cleanup via ctx.onUnmount.
  function renderWidget(w) {
    var article = canvasEl.querySelector('.dashboard-widget[data-id="' + cssEscape(w.id) + '"]');
    if (!article) return;
    var body = article.querySelector(".dashboard-widget-body");
    body.innerHTML = "";

    if (state.unmounts[w.id]) {
      try { state.unmounts[w.id](); } catch (_) {}
      delete state.unmounts[w.id];
    }
    var unmountFns = [];
    var ctx = {
      onUnmount: function (fn) { unmountFns.push(fn); },
    };

    var module = PolarisWidgets.getByType(w.type);
    if (!module) {
      body.innerHTML = '<p class="empty-state">Unknown widget: ' + escapeHtml(w.type) + '</p>';
      return;
    }
    // NOC-style auto-scroll: when a widget's content overflows, slowly creep
    // through it and loop (like noc.example.com). Read-only only —
    // never while editing. Self-activates when/if content overflows.
    if (!state.editing) {
      unmountFns.push(startAutoScroll(body, article));
    }
    var dataPromise;
    try {
      dataPromise = module.fetchData ? module.fetchData(w.config || {}) : Promise.resolve(null);
    } catch (err) {
      dataPromise = Promise.reject(err);
    }
    Promise.resolve(dataPromise).then(function (data) {
      try {
        module.renderInstance(body, w.config || {}, data, ctx);
      } catch (err) {
        body.innerHTML = '<p class="empty-state" style="color:#ef5350">Render failed: ' + escapeHtml(err.message || String(err)) + '</p>';
      }
    }).catch(function (err) {
      body.innerHTML = '<p class="empty-state" style="color:#ef5350">' + escapeHtml(err.message || "Fetch failed") + '</p>';
    });
    state.unmounts[w.id] = function () { unmountFns.forEach(function (fn) { try { fn(); } catch (_) {} }); };
  }

  // ─── State mutations ──────────────────────────────────────────────────────

  function applyChange(mutator) {
    mutator();
    renderRoot();
    queueSave();
  }

  function queueSave() {
    // Viewing a published dashboard is not editing one.
    if (state.external) return;
    if (state.saveTimer) clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
  }
  async function saveNow() {
    state.saveTimer = null;
    if (state.external) return;
    state.saving = true;
    try {
      if (window.POLARIS_DASH_LOCAL) {
        localStorage.setItem(DASH_LOCAL_KEY, JSON.stringify(state.layout));
      } else {
        await api.me.dashboard.put(state.layout);
      }
    } catch (err) {
      if (typeof showToast === "function") showToast("Failed to save dashboard: " + (err.message || err), "error");
    } finally {
      state.saving = false;
    }
  }

  function findWidget(id) {
    for (var ci = 0; ci < activeDash().columns.length; ci++) {
      var idx = activeDash().columns[ci].widgets.findIndex(function (w) { return w.id === id; });
      if (idx !== -1) return { colIndex: ci, idx: idx, widget: activeDash().columns[ci].widgets[idx] };
    }
    return null;
  }

  function newColumn(widthHint, widgets) {
    return { id: PolarisWidgets.uuid(), width: snapWidth(widthHint || 6), widgets: widgets || [] };
  }

  function addWidgetAt(type, target) {
    var module = PolarisWidgets.getByType(type);
    if (!module) return;
    var inst = {
      id: PolarisWidgets.uuid(),
      type: module.type,
      height: module.defaultSize.height === 2 ? 2 : 1,
      config: Object.assign({}, module.defaultConfig || {}),
    };
    if (!target || target.newColumn || !activeDash().columns.length) {
      activeDash().columns.push(newColumn(module.defaultSize.width, [inst]));
    } else {
      activeDash().columns[target.columnIndex].widgets.splice(target.insertionIndex, 0, inst);
    }
    hideEmpty();
    renderRoot();
    queueSave();
  }

  function moveWidgetTo(id, target) {
    var src = findWidget(id);
    if (!src || !target) return;
    applyChange(function () {
      activeDash().columns[src.colIndex].widgets.splice(src.idx, 1);
      if (target.newColumn) {
        activeDash().columns.push(newColumn(6, [src.widget]));
      } else {
        var at = target.insertionIndex;
        // Same-column move past the removed slot shifts the index down by one.
        if (target.columnIndex === src.colIndex && src.idx < at) at--;
        activeDash().columns[target.columnIndex].widgets.splice(at, 0, src.widget);
      }
      activeDash().columns = activeDash().columns.filter(function (c) { return c.widgets.length > 0; });
    });
  }

  function removeWidget(id) {
    applyChange(function () {
      activeDash().columns.forEach(function (c) { c.widgets = c.widgets.filter(function (w) { return w.id !== id; }); });
      activeDash().columns = activeDash().columns.filter(function (c) { return c.widgets.length > 0; });
    });
  }

  function removeColumn(colId) {
    applyChange(function () {
      activeDash().columns = activeDash().columns.filter(function (c) { return c.id !== colId; });
    });
  }

  function setColumnWidth(colId, width) {
    var col = activeDash().columns.find(function (c) { return c.id === colId; });
    if (!col || col.width === width) return;
    applyChange(function () { col.width = width; });
  }

  function setWidgetHeight(id, height) {
    var src = findWidget(id);
    if (!src || src.widget.height === height) return;
    applyChange(function () { src.widget.height = height; });
  }

  function updateConfig(id, key, value) {
    var src = findWidget(id);
    if (!src) return;
    src.widget.config = Object.assign({}, src.widget.config || {}, { [key]: value });
    queueSave();
    renderWidget(src.widget);
    // Header title may depend on the asset-type filter or the minimum-severity
    // tier — refresh it in place
    // (renderWidget only re-renders the body, not the shell header).
    var article = canvasEl.querySelector('.dashboard-widget[data-id="' + cssEscape(id) + '"]');
    var titleEl = article && article.querySelector(".dashboard-widget-title");
    if (titleEl) {
      var label = widgetTitleFor(PolarisWidgets.getByType(src.widget.type), src.widget);
      titleEl.textContent = label;
      titleEl.setAttribute("title", label);
    }
  }

  // Append to the bottom of the block with this id — looked up at pick time,
  // since the picker stays open while the layout can change underneath it.
  function addWidgetToColumn(type, colId) {
    var cols = activeDash().columns;
    for (var i = 0; i < cols.length; i++) {
      if (cols[i].id === colId) {
        addWidgetAt(type, { columnIndex: i, insertionIndex: cols[i].widgets.length });
        return;
      }
    }
    addWidgetAt(type, { newColumn: true });
  }

  function handleTapToAdd(type) {
    // Click-to-add from the picker: append to the last column, or start one.
    if (activeDash().columns.length) {
      var last = activeDash().columns.length - 1;
      addWidgetAt(type, { columnIndex: last, insertionIndex: activeDash().columns[last].widgets.length });
    } else {
      addWidgetAt(type, { newColumn: true });
    }
  }

  // ─── Drag handlers (canvas) ─────────────────────────────────────────────

  function onCanvasDragOver(ev) {
    var types = ev.dataTransfer ? ev.dataTransfer.types : null;
    if (!types) return;
    var isAdd  = types.indexOf("application/x-polaris-widget") !== -1;
    var isMove = types.indexOf("application/x-polaris-widget-move") !== -1;
    if (!isAdd && !isMove) return;
    if (!state.editing) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = isAdd ? "copy" : "move";
    showPlaceholderAt(ev.clientX, ev.clientY);
  }

  function onCanvasDragLeave(ev) {
    if (ev.relatedTarget && canvasEl.contains(ev.relatedTarget)) return;
    clearPlaceholder();
  }

  function onCanvasDrop(ev) {
    if (!state.editing) return;
    var addType = ev.dataTransfer.getData("application/x-polaris-widget");
    var moveId  = ev.dataTransfer.getData("application/x-polaris-widget-move");
    if (!addType && !moveId) return;
    ev.preventDefault();
    var target = dropTargetFromCursor(ev.clientX, ev.clientY);
    clearDragState();
    if (!target) return;
    if (addType) { addWidgetAt(addType, target); WidgetLibrary.close(); }
    else if (moveId) { moveWidgetTo(moveId, target); }
  }

  // Resolve the cursor to { columnIndex, insertionIndex } or { newColumn:true }.
  function dropTargetFromCursor(clientX, clientY) {
    var newColEl = canvasEl.querySelector(".dashboard-newcol-target");
    if (newColEl && withinRect(newColEl, clientX, clientY)) return { newColumn: true };

    var colEls = Array.prototype.slice.call(canvasEl.querySelectorAll(".dashboard-column"));
    if (!colEls.length) return { newColumn: true };

    // Pick the column whose box contains the cursor in BOTH axes. Columns wrap
    // into multiple rows, and a Full-width column spans the entire row width —
    // so an x-only test would always match it and trap every drop in the first
    // (top) column. Require y to be inside the column too; if the cursor is in
    // a gap / below everything, fall back to the nearest column by centre.
    var colEl = null;
    for (var i = 0; i < colEls.length; i++) {
      var r = colEls[i].getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) { colEl = colEls[i]; break; }
    }
    if (!colEl) {
      var bestD = Infinity;
      for (var k = 0; k < colEls.length; k++) {
        var rr = colEls[k].getBoundingClientRect();
        var dx = clientX - (rr.left + rr.width / 2);
        var dy = clientY - (rr.top + rr.height / 2);
        var d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; colEl = colEls[k]; }
      }
    }
    var ci = colEls.indexOf(colEl);
    var cards = Array.prototype.slice.call(colEl.querySelectorAll(".dashboard-widget"));
    var idx = cards.length;
    for (var j = 0; j < cards.length; j++) {
      var cr = cards[j].getBoundingClientRect();
      if (clientY < cr.top + cr.height / 2) { idx = j; break; }
    }
    return { columnIndex: ci, insertionIndex: idx };
  }

  function withinRect(el, x, y) {
    var r = el.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  }

  function ensurePlaceholder() {
    if (_placeholder) return _placeholder;
    _placeholder = document.createElement("div");
    _placeholder.className = "dashboard-drop-placeholder";
    return _placeholder;
  }

  function showPlaceholderAt(clientX, clientY) {
    var target = dropTargetFromCursor(clientX, clientY);
    canvasEl.querySelectorAll(".dashboard-column.drag-over, .dashboard-newcol-target.drag-over")
      .forEach(function (e) { e.classList.remove("drag-over"); });
    var ph = ensurePlaceholder();
    if (!target || target.newColumn) {
      var nc = canvasEl.querySelector(".dashboard-newcol-target");
      if (nc) nc.classList.add("drag-over");
      if (ph.parentNode) ph.parentNode.removeChild(ph);
      return;
    }
    var colEls = canvasEl.querySelectorAll(".dashboard-column");
    var colEl = colEls[target.columnIndex];
    if (!colEl) return;
    colEl.classList.add("drag-over");
    var stack = colEl.querySelector(".dashboard-column-stack");
    var cards = stack.querySelectorAll(".dashboard-widget");
    if (target.insertionIndex >= cards.length) stack.appendChild(ph);
    else stack.insertBefore(ph, cards[target.insertionIndex]);
  }

  function clearPlaceholder() {
    if (_placeholder && _placeholder.parentNode) _placeholder.parentNode.removeChild(_placeholder);
    canvasEl.querySelectorAll(".drag-over").forEach(function (e) { e.classList.remove("drag-over"); });
  }

  function clearDragState() {
    _dragStashId = null;
    _dragStashType = null;
    clearPlaceholder();
    canvasEl.classList.remove("is-dragging");
    canvasEl.querySelectorAll(".dashboard-widget.lifted").forEach(function (e) { e.classList.remove("lifted"); });
  }

  // ─── Gear popover ───────────────────────────────────────────────────────

  function openGearPopover(w, anchorEl) {
    closePopover();
    var module = PolarisWidgets.getByType(w.type);
    if (!module) return;
    var pop = document.createElement("div");
    pop.className = "widget-config-popover";
    // No footer: every change applies to the widget the moment it is made, so
    // a Done button only closed the popover (a click outside or Escape does),
    // and Remove widget repeated the × on the widget's own header.
    pop.innerHTML = '<h4>' + escapeHtml(module.label) + '</h4><div class="widget-config-fields"></div>';
    document.body.appendChild(pop);

    var fieldsEl = pop.querySelector(".widget-config-fields");
    if (module.renderConfig) {
      try {
        module.renderConfig(fieldsEl, w.config || {}, function (key, value) { updateConfig(w.id, key, value); });
      } catch (err) {
        fieldsEl.innerHTML = '<p class="empty-state">Config failed to render.</p>';
      }
    } else {
      fieldsEl.innerHTML = '<p style="font-size:0.82rem;color:var(--color-text-secondary)">This widget has no configurable options.</p>';
    }

    // Fixed, in viewport coordinates, and kept inside the viewport. It was
    // absolute at page coordinates: opened from a widget near the bottom it
    // hung past the viewport, which made the DOCUMENT scrollable, so a wheel
    // over it slid the page card up under the pinned tab row. Without room
    // below the gear it opens upward instead; taller than the viewport, it
    // scrolls inside (styles.css max-height).
    var width = 260;
    pop.style.width = width + "px";
    function place() {
      var a = anchorEl.getBoundingClientRect();
      var vw = document.documentElement.clientWidth;
      var vh = document.documentElement.clientHeight;
      var h = pop.offsetHeight;
      var leftSide = a.left - width - 6;
      var left = leftSide >= 8 ? leftSide : a.right + 6;
      if (left + width > vw - 8) left = Math.max(8, vw - 8 - width);
      var top = a.top;
      if (top + h > vh - 8) top = a.bottom - h;
      top = Math.max(8, Math.min(top, vh - 8 - h));
      pop.style.top = top + "px";
      pop.style.left = left + "px";
    }
    place();
    // A field that loads its options after the first paint changes the height.
    var resizeObs = typeof ResizeObserver === "function" ? new ResizeObserver(place) : null;
    if (resizeObs) resizeObs.observe(pop);
    // Fixed no longer travels with the gear, so a scroll that moves the gear
    // (the page card, the page) closes it. A widget body's own auto-scroll
    // does not hold the gear and is ignored; so is a scroll inside the popover.
    function onScroll(e) {
      var t = e.target;
      if (pop.contains(t)) return;
      if (t === document || (t.contains && t.contains(anchorEl))) closePopover();
    }
    window.addEventListener("scroll", onScroll, true);

    openPopover = {
      el: pop,
      widgetId: w.id,
      cleanup: function () {
        if (resizeObs) resizeObs.disconnect();
        window.removeEventListener("scroll", onScroll, true);
      },
    };
  }
  function closePopover() {
    if (!openPopover) return;
    try { openPopover.cleanup && openPopover.cleanup(); } catch (_) {}
    try { document.body.removeChild(openPopover.el); } catch (_) {}
    openPopover = null;
  }

  // ─── NOC-style auto-scroll ───────────────────────────────────────────────
  // Mirrors the SolarWinds NOC wall display (noc.example.com): pause
  // ~3s at the top, creep down 1px per tick, dwell ~3s at the bottom, reset to
  // the top (glide), repeat — but only while the content actually overflows.
  // NOC uses translateY on an inner wrapper; we drive scrollTop on the
  // overflow:auto widget body instead (no DOM wrapper needed). Pauses while
  // the operator hovers the widget so they can read / click without it moving.
  //
  // Hover is not the whole story: clicking a row opens a row menu (Acknowledge
  // alert… / Open device) that is position:fixed and mounted on <body>, so
  // moving the pointer onto the menu LEAVES the widget — hover released, the
  // creep resumed, and showRowMenu closes on a scroll of any container holding
  // its anchor, so the menu vanished before the operator could pick anything.
  // While a row in this body carries the open-menu stamp the widget holds too,
  // and dwells briefly once it clears so the list doesn't lurch the instant the
  // menu closes. The attribute is spelled out below rather than read from
  // app.js: the /dash wallboard runs this file WITHOUT app.js (and so never
  // stamps anything). Keep it in step with ROW_MENU_OPEN_ATTR in app.js.
  //
  // The operator can scroll the body by hand while it holds (wheel, scrollbar,
  // touch). When the hold ends the creep resumes from THERE: `offset` is re-read
  // from scrollTop, or the next tick would snap the list back to where the
  // creep had left it.
  function startAutoScroll(scrollEl, hoverEl) {
    var STEP_MS = 80;                              // tick cadence (NOC metric-box speed)
    var TOP_PAUSE_TICKS = Math.ceil(3000 / STEP_MS); // ~3s dwell at the top
    var BOTTOM_DWELL = 40;                          // extra ticks held at the bottom (~3.2s)
    var RESUME_TICKS = Math.ceil(1000 / STEP_MS);   // ~1s settle after a hold ends
    var offset = 0;
    var pause = TOP_PAUSE_TICKS;
    var hovered = false;
    var held = false;

    function onEnter() { hovered = true; }
    function onLeave() { hovered = false; }
    hoverEl.addEventListener("mouseenter", onEnter);
    hoverEl.addEventListener("mouseleave", onLeave);

    var timer = setInterval(function () {
      var maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      if (maxScroll <= 4) {                         // content fits → nothing to scroll
        if (scrollEl.scrollTop !== 0) scrollEl.scrollTop = 0;
        offset = 0; pause = TOP_PAUSE_TICKS;
        return;
      }
      // Reading it, or acting on a row through an open menu pinned to it.
      if (hovered || scrollEl.querySelector("[data-rowmenu-open]")) {
        held = true;
        return;
      }
      if (held) {
        held = false;
        offset = Math.min(scrollEl.scrollTop, maxScroll);
        pause = Math.max(pause, RESUME_TICKS);
      }
      if (pause > 0) { pause--; return; }
      offset += 1;
      if (offset > maxScroll + BOTTOM_DWELL) {       // past bottom + dwell → glide home, re-pause
        offset = 0;
        pause = TOP_PAUSE_TICKS;
        try { scrollEl.scrollTo({ top: 0, behavior: "smooth" }); }
        catch (_) { scrollEl.scrollTop = 0; }
        return;
      }
      scrollEl.scrollTop = Math.min(offset, maxScroll);
    }, STEP_MS);

    return function cleanup() {
      clearInterval(timer);
      hoverEl.removeEventListener("mouseenter", onEnter);
      hoverEl.removeEventListener("mouseleave", onLeave);
    };
  }

  // CSS.escape polyfill — old browsers + safe escape for our use case.
  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
  }

  // ─── Saved dashboards seam ────────────────────────────────────────────────
  //
  // What public/js/dashboard-saved.js (the "Dashboards ▾" menu) is allowed to
  // know about this file. Two directions:
  //   - read  — a snapshot of the canvas on screen, to publish or keep;
  //   - write — load a saved dashboard as a NEW TAB (the signed-in page: a
  //             copy, so editing it never writes back to a preset that may be
  //             someone else's — the UserTableTabs rule), or VIEW a published
  //             one read-only (the wallboard, which has nothing to save with).
  //
  // Every layout arriving from the server passes through dropUnknownWidgets:
  // a published dashboard is another operator's blob, and it may name a widget
  // type this viewer's build doesn't register or their role can't read.

  function dropUnknownWidgets(columns) {
    return (Array.isArray(columns) ? columns : [])
      .map(function (col) {
        return {
          id: col && col.id ? col.id : PolarisWidgets.uuid(),
          width: snapWidth(col && col.width ? col.width : 6),
          widgets: ((col && col.widgets) || []).filter(function (w) {
            return w && PolarisWidgets.getByType(w.type) != null;
          }).map(function (w) {
            return {
              id: PolarisWidgets.uuid(),   // fresh instance ids: the same widget may already be on the viewer's own canvas
              type: w.type,
              height: HEIGHT_STEPS.indexOf(w.height) === -1 ? 1 : w.height,
              config: w.config && typeof w.config === "object" ? w.config : {},
            };
          }),
        };
      })
      .filter(function (col) { return col.widgets.length > 0; });
  }

  window.PolarisDashboard = {
    /** True on the Dash wallboard (no session, localStorage layout). */
    isWallboard: function () { return !!window.POLARIS_DASH_LOCAL; },

    /** The canvas on screen, as a saved-dashboard payload. Null while viewing a published one. */
    snapshot: function () {
      if (state.external) return null;
      var dash = activeDash();
      return { name: dash.name || "", layout: { columns: JSON.parse(JSON.stringify(dash.columns || [])) } };
    },

    /** Widgets on the canvas — what the save modal reports it is about to store. */
    widgetCount: function () { return totalWidgets(); },

    /**
     * Write one key of a widget's config — persist + re-render, exactly as the
     * gear popover's own onChange does. The seam exists for controls that live
     * on the widget HEADER rather than in the popover (the ⇅ sort button,
     * PolarisWidgets.setHeaderSort): those are stamped from widgets/index.js,
     * which is handed a body element and a config object and knows nothing
     * about the canvas. Refuses while viewing a published dashboard — that
     * layout is someone else's row and this page only renders it.
     */
    setWidgetConfig: function (id, key, value) {
      if (state.external) return false;
      if (!findWidget(id)) return false;
      updateConfig(id, key, value);
      return true;
    },

    /** True while customizing (Customize Page clicked, Done not yet). */
    isEditing: function () { return !!state.editing && !state.external; },

    /** Id of the published dashboard being viewed, or null. */
    publishedId: function () { return state.external ? state.external.id : null; },

    /**
     * Load a saved dashboard as a new TAB of the viewer's own layout, and
     * switch to it. A copy by construction — the tab carries no reference back
     * to the row, so editing it can never rewrite someone else's dashboard.
     */
    loadAsNewTab: function (saved) {
      if (!saved) return false;
      var columns = dropUnknownWidgets(saved.layout && saved.layout.columns);
      var id = PolarisWidgets.uuid();
      state.external = null;
      state.layout.dashboards.push({ id: id, name: (saved.name || "Dashboard").slice(0, 60), columns: columns });
      state.layout.activeId = id;
      setHeaderMode();
      renderRoot();
      queueSave();
      return true;
    },

    /** Render a published dashboard read-only, in place of the local layout. */
    viewPublished: function (saved) {
      if (!saved) return false;
      state.external = {
        id: saved.id,
        name: saved.name || "Published dashboard",
        ownerName: saved.ownerName || "",
        columns: dropUnknownWidgets(saved.layout && saved.layout.columns),
      };
      state.editing = false;
      closePopover();
      WidgetLibrary.close();
      setHeaderMode();
      renderRoot();
      return true;
    },

    /** Back to the viewer's own layout. */
    clearPublished: function () {
      if (!state.external) return false;
      state.external = null;
      // Restore the page's own prompt HERE rather than leaving it to
      // showEmpty: the viewer's layout usually HAS widgets, so the empty state
      // just hides — and would still be stamped with the published
      // dashboard's name the next time it showed.
      if (emptyDefaultHTML) emptyEl.innerHTML = emptyDefaultHTML;
      setHeaderMode();
      renderRoot();
      return true;
    },
  };
})();
