/**
 * public/js/dashboard-saved.js — saved dashboards ("Dashboards ▾").
 *
 * The dashboard's answer to the Assets page's saved filter presets
 * (assets-filters.js): name the canvas you built, keep it PRIVATE or publish it
 * PUBLIC, and load anyone's published one back. Rows live on the SERVER
 * (GET/POST/PUT/DELETE /api/v1/saved-dashboards) precisely because they're
 * shareable:
 *
 *   Private — visible only to the operator who saved it.
 *   Public  — offered to every operator who can read the registry AND to the
 *             unauthenticated Dash wallboard. Publishing is a write to shared
 *             state (savedDashboards:write); keeping a private one needs only
 *             the read the page already has.
 *
 * ONE file serves both surfaces, because they are the same list read two ways:
 *
 *   Dashboard page (index.html, signed in)
 *     Loading a dashboard adds it as a NEW TAB of your own layout — a COPY, so
 *     editing it never writes back to a row that may be someone else's (the
 *     UserTableTabs rule). Save / delete live here, and so do Export this tab
 *     / Import tab from file (a .dashboard.json; the format is in
 *     dashboard-portability.js, offered only where that module is loaded).
 *
 *   Dash wallboard (dash.html, anonymous)
 *     The menu is "My layout (this browser)" plus every published dashboard.
 *     Loading one VIEWS it read-only — no copy, so the wallboard follows what
 *     the publisher changes — and the choice is pinned in localStorage so a
 *     kiosk reboot comes back to the same screen. Saving does not exist here:
 *     that listener is GET-only and has no session to own a row with.
 *
 * Depends on globals from api.js (api / showToast / escapeHtml), dashboard.js
 * (window.PolarisDashboard — the only thing this file knows about the canvas),
 * and, on the signed-in page only, app.js (openModal / closeModal / showConfirm
 * / permAtLeast). dash-boot.js supplies permAtLeast on the wallboard.
 */

/* global api, showToast, escapeHtml, openModal, closeModal, showConfirm, permAtLeast */

(function () {
  // The wallboard's pinned published dashboard. Per-browser, like the local
  // layout it stands in for — a wallboard is a screen, not an account.
  var PINNED_KEY = "polaris-dash-published";
  // How often an unattended wallboard re-reads the dashboard it is showing, so
  // a publisher's edit reaches the TV without someone walking over to it. Only
  // ever polled while a published dashboard is on screen.
  var PUBLISHED_POLL_MS = 5 * 60 * 1000;

  var _cache = [];        // last server list (save-modal name collisions + row lookups)
  var _loaded = false;    // false until the first successful list fetch
  var _pollTimer = null;
  var _pollStamp = null;  // updatedAt of the published dashboard on screen

  function dash() { return window.PolarisDashboard || null; }
  function portability() { return window.PolarisDashboardPortability || null; }
  function isWallboard() { return !!(window.POLARIS_DASH_LOCAL); }

  /** May this caller publish (or unpublish) a dashboard for everyone? */
  function canPublish() {
    return typeof permAtLeast !== "function" || permAtLeast("savedDashboards", "write");
  }
  function canDeleteAny() {
    return typeof permAtLeast === "function" && permAtLeast("savedDashboards", "fullwrite");
  }

  // ─── Pinned selection (wallboard) ─────────────────────────────────────────

  function readPinned() {
    try { return localStorage.getItem(PINNED_KEY) || null; } catch (_err) { return null; }
  }
  function writePinned(id) {
    try {
      if (id) localStorage.setItem(PINNED_KEY, id);
      else localStorage.removeItem(PINNED_KEY);
    } catch (_err) { /* private mode — the choice just won't survive a reload */ }
  }

  // ─── Data ─────────────────────────────────────────────────────────────────

  async function fetchList() {
    var data = await api.savedDashboards.list();
    _cache = (data && data.dashboards) || [];
    _loaded = true;
    return _cache;
  }

  // ─── Menu ─────────────────────────────────────────────────────────────────

  function rowHtml(d) {
    var badge = d.visibility === "public"
      ? '<span class="sfl-badge" title="Published — everyone, including the Dash wallboard, can load it">Public</span>'
      : "";
    var owner = d.isOwner || !d.ownerName ? "" : '<span class="sfl-owner">' + escapeHtml(d.ownerName) + "</span>";
    var active = isWallboard() && dash() && dash().publishedId() === d.id;
    var del = !isWallboard() && (d.isOwner || canDeleteAny())
      ? '<button type="button" class="sfl-del" data-sd-del="' + escapeHtml(d.id) +
        '" title="Delete this saved dashboard" aria-label="Delete ' + escapeHtml(d.name) + '">&times;</button>'
      : "";
    var count = d.widgetCount === 1 ? "1 widget" : (d.widgetCount || 0) + " widgets";
    return '<div class="sfl-row' + (active ? " sfl-row-base" : "") + '">' +
      '<button type="button" class="sfl-load" data-sd-load="' + escapeHtml(d.id) + '" title="' +
        escapeHtml(count + (isWallboard() ? " — show this on the wallboard" : " — load as a new dashboard tab")) + '">' +
        '<span class="sfl-name">' + escapeHtml(d.name) + "</span>" + badge + owner +
      "</button>" + del +
    "</div>";
  }

  function renderMenu(list, error) {
    var menu = document.getElementById("saved-dashboards-menu");
    if (!menu) return;
    var html = "";

    if (isWallboard()) {
      // The wallboard's own layout is one of the choices, not a mode hidden
      // behind "close" — it is what an unpinned wallboard shows.
      var showingLocal = !(dash() && dash().publishedId());
      html +=
        '<div class="sfl-row' + (showingLocal ? " sfl-row-base" : "") + '">' +
          '<button type="button" class="sfl-load" data-sd-act="local" title="The layout saved in this browser">' +
            '<span class="sfl-name">My layout</span>' +
            '<span class="sfl-owner">this browser</span>' +
          "</button>" +
        "</div>" +
        '<div class="dropdown-divider"></div>';
    } else {
      html += '<button type="button" data-sd-act="save">Save this dashboard&hellip;</button>';
      // File export/import of the tab on screen (dashboard-portability.js) —
      // local to this browser, so no permission beyond being on the page.
      if (portability()) {
        html += '<button type="button" data-sd-act="export" title="Download this tab as a .dashboard.json file">Export this tab</button>' +
                '<button type="button" data-sd-act="import" title="Add a tab from a .dashboard.json file">Import tab from file&hellip;</button>';
      }
      html += '<div class="dropdown-divider"></div>';
    }

    if (error) {
      html += '<div class="sfl-empty">Could not load saved dashboards</div>';
    } else if (!_loaded) {
      html += '<div class="sfl-empty">Loading&hellip;</div>';
    } else if (isWallboard()) {
      html += list.length
        ? '<div class="dropdown-heading">Published dashboards</div>' + list.map(rowHtml).join("")
        : '<div class="sfl-empty">No published dashboards yet</div>';
    } else {
      var mine = list.filter(function (d) { return d.isOwner; });
      var shared = list.filter(function (d) { return !d.isOwner; });
      if (!mine.length && !shared.length) html += '<div class="sfl-empty">No saved dashboards yet</div>';
      if (mine.length) html += '<div class="dropdown-heading">My dashboards</div>' + mine.map(rowHtml).join("");
      if (shared.length) html += '<div class="dropdown-heading">Shared dashboards</div>' + shared.map(rowHtml).join("");
    }
    menu.innerHTML = html;
  }

  async function refreshMenu() {
    try { renderMenu(await fetchList(), false); }
    catch (_err) { renderMenu([], true); }
  }

  /** The header button says which dashboard is on screen — a wallboard is read from across a room. */
  function syncButtonLabel() {
    var btn = document.getElementById("btn-saved-dashboards");
    if (!btn) return;
    var id = dash() ? dash().publishedId() : null;
    if (!id) { btn.innerHTML = "Dashboards &#9662;"; return; }
    var row = _cache.find(function (d) { return d.id === id; });
    btn.innerHTML = escapeHtml(row ? row.name : "Published") + " &#9662;";
  }

  // ─── Wallboard: view a published dashboard ────────────────────────────────

  function stopPoll() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    _pollStamp = null;
  }

  function startPoll(id) {
    stopPoll();
    _pollTimer = setInterval(async function () {
      if (!dash() || dash().publishedId() !== id) { stopPoll(); return; }
      try {
        var fresh = await api.savedDashboards.get(id);
        // Re-render only when the row actually moved: a re-render tears every
        // widget down and back up, which on a wallboard is a visible blink.
        if (fresh && fresh.updatedAt !== _pollStamp) {
          _pollStamp = fresh.updatedAt;
          dash().viewPublished(fresh);
          syncButtonLabel();
        }
      } catch (err) {
        // 404 = deleted or unpublished while we were showing it. Fall back to
        // this browser's own layout rather than freezing on a dead screen.
        if (err && err.status === 404) { showLocal(); showToast("That published dashboard is no longer available"); }
      }
    }, PUBLISHED_POLL_MS);
  }

  function showPublished(row) {
    if (!dash()) return;
    dash().viewPublished(row);
    writePinned(row.id);
    _pollStamp = row.updatedAt || null;
    startPoll(row.id);
    syncButtonLabel();
  }

  function showLocal() {
    if (!dash()) return;
    stopPoll();
    dash().clearPublished();
    writePinned(null);
    syncButtonLabel();
  }

  /**
   * Restore the pinned published dashboard at boot — awaited by dashboard.js's
   * bootstrap so the wallboard paints the pinned screen instead of flashing its
   * local layout first. A pin whose row has gone is dropped, not retried.
   */
  async function restorePinned() {
    if (!isWallboard()) return false;
    var id = readPinned();
    if (!id) return false;
    try {
      var row = await api.savedDashboards.get(id);
      if (!row || !row.id) return false;
      dash().viewPublished(row);
      _pollStamp = row.updatedAt || null;
      startPoll(row.id);
      return true;
    } catch (err) {
      if (err && err.status === 404) writePinned(null);
      return false;
    }
  }

  // ─── Signed-in page: save + load + delete ─────────────────────────────────

  function loadAsTab(row) {
    if (!dash() || !dash().loadAsNewTab(row)) return;
    showToast('Loaded dashboard "' + row.name + '" as a new tab');
  }

  async function deleteRow(id) {
    var row = _cache.find(function (d) { return d.id === id; });
    if (!row) return;
    var ok = await showConfirm(
      row.isOwner
        ? 'Delete the saved dashboard "' + row.name + '"?'
        : 'Delete "' + row.name + '", published by ' + row.ownerName + "?",
    );
    if (!ok) return;
    try {
      await api.savedDashboards.delete(id);
      showToast('Deleted "' + row.name + '"');
      await refreshMenu();
    } catch (err) {
      showToast(err.message || "Delete failed", "error");
    }
  }

  function openSaveModal() {
    var snap = dash() ? dash().snapshot() : null;
    if (!snap) return;
    var count = dash().widgetCount();
    var publish = canPublish();

    // Seed the name from the tab the operator is looking at — the usual intent
    // is "keep this screen", and they already named it. Never from a default.
    var seed = /^Dashboard \d+$/.test(snap.name || "") ? "" : (snap.name || "");

    var body =
      '<div class="form-group">' +
        '<label for="sd-name">Name</label>' +
        '<input type="text" id="sd-name" maxlength="60" autocomplete="off" list="sd-name-list" value="' +
          escapeHtml(seed) + '" placeholder="e.g. NOC overview">' +
        '<datalist id="sd-name-list">' +
          _cache.filter(function (d) { return d.isOwner; })
            .map(function (d) { return '<option value="' + escapeHtml(d.name) + '"></option>'; }).join("") +
        "</datalist>" +
        '<div class="hint">Saving over one of your existing names replaces it.</div>' +
      "</div>" +
      '<div class="form-group">' +
        "<label>Visibility</label>" +
        '<label class="sfl-vis"><input type="radio" name="sd-vis" value="private" checked>' +
          "<span><strong>Private</strong> — only you can load it</span></label>" +
        '<label class="sfl-vis' + (publish ? "" : " sfl-vis-disabled") + '">' +
          '<input type="radio" name="sd-vis" value="public"' + (publish ? "" : " disabled") + ">" +
          "<span><strong>Public</strong> — every operator can load it, and it can be shown on the " +
          "unauthenticated Dash wallboard" +
          (publish ? "" : '<br><span class="hint">Requires saved-dashboard write access</span>') +
          "</span></label>" +
      "</div>" +
      '<div class="form-group">' +
        "<label>What gets saved</label>" +
        '<div class="sfl-preview">' + (count === 1 ? "1 widget" : count + " widgets") +
          " in " + (snap.layout.columns.length === 1 ? "1 column" : snap.layout.columns.length + " columns") +
        "</div>" +
        '<div class="hint">The widgets, their columns, sizes and per-widget settings — this dashboard tab only. ' +
          "Loading it elsewhere makes a copy; later edits here don't follow it.</div>" +
      "</div>";

    var footer =
      '<button class="btn btn-secondary" id="sd-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="sd-save">Save</button>';

    openModal("Save this dashboard", body, footer);
    document.getElementById("sd-cancel").addEventListener("click", closeModal);

    var nameInput = document.getElementById("sd-name");
    var saveBtn = document.getElementById("sd-save");

    async function submit() {
      var name = (nameInput.value || "").trim();
      if (!name) { showToast("Name is required", "error"); nameInput.focus(); return; }
      var visEl = document.querySelector('input[name="sd-vis"]:checked');
      var visibility = visEl ? visEl.value : "private";

      var clash = _cache.find(function (d) {
        return d.isOwner && d.name.toLowerCase() === name.toLowerCase();
      });
      if (clash && !(await showConfirm('You already have a dashboard named "' + clash.name + '" — replace it?'))) return;

      saveBtn.disabled = true;
      try {
        // The server treats a same-(owner, name) POST as an update, so one
        // call covers both create and overwrite.
        await api.savedDashboards.create({ name: name, visibility: visibility, layout: snap.layout });
        closeModal();
        showToast('Saved dashboard "' + name + '"');
        await refreshMenu();
      } catch (err) {
        showToast(err.message || "Save failed", "error");
        saveBtn.disabled = false;
      }
    }

    saveBtn.addEventListener("click", submit);
    nameInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
    });
  }

  // ─── Signed-in page: export / import one tab as a file ───────────────────

  function exportTab() {
    var P = portability();
    var snap = dash() ? dash().snapshot() : null;
    if (!P || !snap) return;
    if (!dash().widgetCount()) { showToast("This tab has no widgets to export", "error"); return; }
    var blob = new Blob([P.exportText(snap)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = P.filenameForExport(snap.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    showToast('Exported "' + (snap.name || "Dashboard") + '"');
  }

  function pickImportFile() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.hidden = true;
    input.addEventListener("change", function () {
      var file = input.files && input.files[0];
      input.remove();
      if (file) importFile(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  async function importFile(file) {
    var P = portability();
    if (!P || !dash()) return;
    // Refuse without reading: a tab is a few KB.
    if (file.size > P.MAX_IMPORT_BYTES) { showToast("That file is too large to be a dashboard.", "error"); return; }
    var parsed;
    try {
      var widgets = window.PolarisWidgets;
      parsed = P.parseImportFile(await file.text(), file.name, widgets && widgets.getByType
        ? function (type) { return widgets.getByType(type) != null; }
        : null);
    } catch (err) {
      showToast((err && err.message) || "That file could not be read as a dashboard.", "error");
      return;
    }
    var kept = parsed.layout.columns.reduce(function (n, c) { return n + c.widgets.length; }, 0);
    if (!kept) {
      showToast(parsed.skipped
        ? "None of that file's widgets exist in this Polaris, so there is nothing to import."
        : "That dashboard has no widgets.", "error");
      return;
    }
    if (!dash().loadAsNewTab({ name: parsed.name, layout: parsed.layout })) return;
    var note = [];
    if (parsed.skipped) note.push(parsed.skipped === 1 ? "1 unknown widget skipped" : parsed.skipped + " unknown widgets skipped");
    note = note.concat(parsed.problems);
    showToast('Imported "' + parsed.name + '" as a new tab' + (note.length ? " (" + note.join("; ") + ")" : ""));
  }

  // ─── Wiring ───────────────────────────────────────────────────────────────

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("btn-saved-dashboards");
    var menu = document.getElementById("saved-dashboards-menu");
    if (!btn || !menu) return;

    // A role with no access to the registry gets no menu at all rather than a
    // button whose every action 403s. The wallboard always keeps it: its
    // identity is the built-in readonly role, and "My layout" lives in here.
    //
    // A GATE, re-evaluated — never an early return. At DOMContentLoaded
    // permAtLeast reads the localStorage snapshot of the user, which is empty
    // on a first login and stale after a role edit; the authoritative /auth/me
    // lands later and app.js announces it with "polaris:user-loaded". This
    // used to hide the wrapper and RETURN before binding the click — and
    // .btn-dropdown-wrap's display:inline-block beat the UA [hidden] rule, so
    // the hidden button stayed on screen, dead, even for roles holding read.
    function canUseMenu() {
      return isWallboard() || typeof permAtLeast !== "function" || permAtLeast("savedDashboards", "read");
    }
    // And only while customizing, or while a published dashboard is on screen
    // (Customize is withdrawn there, so this menu is the only way back to the
    // viewer's own layout). dashboard.js announces each mode change.
    function inMenuMode() {
      var d = dash();
      return !d || (d.isEditing && d.isEditing()) || !!d.publishedId();
    }
    function applyAccessGate() {
      var allowed = canUseMenu() && inMenuMode();
      var wrap = btn.closest(".btn-dropdown-wrap");
      if (wrap) wrap.hidden = !allowed; else btn.hidden = !allowed;
      if (!allowed) menu.classList.remove("open");
    }
    applyAccessGate();
    document.addEventListener("polaris:user-loaded", applyAccessGate);
    document.addEventListener("polaris:dashboard-mode", applyAccessGate);

    renderMenu([], false);   // placeholder, so the first open isn't an empty box

    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (!canUseMenu() || !inMenuMode()) return;
      var willOpen = !menu.classList.contains("open");
      // Sibling header menus stopPropagation on their own button, so their
      // document-level close listener never fires for a click on ours.
      document.querySelectorAll(".btn-dropdown-menu.open").forEach(function (m) { m.classList.remove("open"); });
      if (willOpen) {
        menu.classList.add("open");
        // Re-fetch on every open: someone may have published one since the
        // last look, and the list is small.
        refreshMenu().then(syncButtonLabel);
      }
    });
    document.addEventListener("click", function () { menu.classList.remove("open"); });
    menu.addEventListener("click", function (e) { e.stopPropagation(); });

    menu.addEventListener("click", function (e) {
      var act = e.target.closest("[data-sd-act]");
      if (act) {
        menu.classList.remove("open");
        var which = act.getAttribute("data-sd-act");
        if (which === "save") openSaveModal();
        else if (which === "export") exportTab();
        else if (which === "import") pickImportFile();
        else showLocal();
        return;
      }
      var load = e.target.closest("[data-sd-load]");
      if (load) {
        menu.classList.remove("open");
        var row = _cache.find(function (d) { return d.id === load.getAttribute("data-sd-load"); });
        if (!row) return;
        if (isWallboard()) showPublished(row);
        else loadAsTab(row);
        return;
      }
      var del = e.target.closest("[data-sd-del]");
      if (del) deleteRow(del.getAttribute("data-sd-del"));
    });

    // The pinned wallboard screen needs its name in the button before the menu
    // has ever been opened; the list is the only place that name comes from.
    if (isWallboard() && readPinned()) refreshMenu().then(syncButtonLabel);
  });

  // dashboard.js's bootstrap awaits this before painting the wallboard.
  window.PolarisSavedDashboards = {
    restorePinned: restorePinned,
    pinnedId: readPinned,
    refresh: refreshMenu,
  };
})();
