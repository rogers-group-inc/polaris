/**
 * public/js/saved-tree.js — the folder tree inside the two named-preset menus,
 * Assets → Filters ▾ (assets-filters.js) and Dashboard → Dashboards ▾
 * (dashboard-saved.js). Business rule 140.
 *
 * One module for both because they are the same list read two ways — styling
 * or behaving them apart is how they drift (the `.sfl-menu` rule). The page
 * owns its ITEM rows (a filter's ★ / ⊞ / ×, a dashboard's ⊞ / ×) and what a
 * click on one does; this module owns everything about folders:
 *
 *   - the tree: sections (My … / Shared … / Ownerless), folders that open and
 *     close in place (remembered per browser), items indented under them. An
 *     item or folder whose parent the server could not show the caller arrives
 *     with a null parent and simply sits at the top level.
 *   - drag and drop: a row you manage onto a folder files it there; onto a
 *     section heading puts it at the top level. A folder never drops into
 *     itself or its own subtree.
 *   - the folder ⋯ menu and an item's right-click menu: New subfolder, Rename
 *     (in place), Make public / private, Change owner, Make private to me,
 *     Delete folder — each offered only when the server said the caller may.
 *   - the Change owner and Make private to me dialogs, with their warnings.
 *   - the Folder picker the Save modals put under the name field.
 *
 * Ownership is the server's call (savedOwnershipService): every row carries
 * `isOwner` / `canManage` / `canTake`, and nothing here re-derives them.
 *
 * The Dash wallboard loads this too, with no session and no app.js: it gets a
 * read-only tree (no drag, no menus), which is why every verb below is behind
 * a `typeof` check of the helper it needs.
 */

/* global escapeHtml, showToast, openModal, closeModal, showConfirm, showRowMenu */

(function () {
  var FOLDER_SVG =
    '<svg class="sft-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  var CHEV_OPEN =
    '<svg class="sft-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  var CHEV_SHUT =
    '<svg class="sft-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
  var MORE_SVG =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
    '<circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
  var WARN_SVG =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">' +
    '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18h.01"/></svg>';

  /** Pixels of indent per nesting level. */
  var INDENT = 20;

  function esc(s) { return typeof escapeHtml === "function" ? escapeHtml(s) : String(s == null ? "" : s); }
  function toast(msg, kind) { if (typeof showToast === "function") showToast(msg, kind); }

  function readSet(key) {
    try {
      var a = JSON.parse(localStorage.getItem(key) || "[]");
      return new Set(Array.isArray(a) ? a : []);
    } catch (_err) { return new Set(); }
  }
  function writeSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch (_err) { /* private mode */ }
  }

  /** "Role · NOC", "Region · West", "jsmith", "was rlee". */
  function ownerText(row) {
    if (row.ownerKind === "none") return row.ownerName ? "was " + row.ownerName : "no owner";
    if (row.ownerKind === "role") return "Role · " + row.ownerName;
    if (row.ownerKind === "region") return "Region · " + row.ownerName;
    return row.ownerName || "";
  }

  /** The owner label a row shows — nothing when it is simply yours. */
  function ownerBadgeHtml(row) {
    if (row.isOwner && row.ownerKind === "user") return "";
    return '<span class="sfl-owner">' + esc(ownerText(row)) + "</span>";
  }

  function sectionOf(row) {
    if (row.isOwner) return "mine";
    if (row.ownerKind === "none") return "ownerless";
    return "shared";
  }

  function byName(a, b) { return String(a.name).localeCompare(String(b.name)); }

  /**
   * @param {object} opts
   *   storageKey   localStorage key for the open folders (per browser)
   *   labels       { mine, shared, ownerless, one, many } — "My filters",
   *                "Shared filters", "Ownerless", "filter", "filters"
   *   single       optional heading that replaces the three sections (the
   *                wallboard's "Published dashboards")
   *   itemRowHtml  (item, extraAttrs, depth) → the page's row markup; it must
   *                put `extraAttrs` on its root element
   *   interactive  false = read-only (no drag, no menus) — the wallboard
   *   canPublish   () → may the caller make something public
   *   ops          { createFolder, updateFolder, moveFolder, deleteFolder,
   *                  setFolderOwner, takeFolder, moveItem, setItemOwner,
   *                  takeItem, ownerOptions } — promise-returning
   *   refresh      () → Promise; re-fetch and re-render the menu
   *   rerender     () → re-render from the data already held
   */
  function create(opts) {
    var expanded = readSet(opts.storageKey);
    var data = { items: [], folders: [] };
    var idx = null;
    var renamingId = null;
    var dragging = null;   // { type: "item" | "folder", id }

    function setData(items, folders) {
      data = { items: items || [], folders: folders || [] };
      idx = buildIndex();
    }

    function buildIndex() {
      var folderById = {};
      var childFolders = {};
      var childItems = {};
      var rootFolders = [];
      var rootItems = [];
      data.folders.forEach(function (f) { folderById[f.id] = f; });
      data.folders.forEach(function (f) {
        if (f.parentId && folderById[f.parentId]) (childFolders[f.parentId] = childFolders[f.parentId] || []).push(f);
        else rootFolders.push(f);
      });
      data.items.forEach(function (it) {
        if (it.folderId && folderById[it.folderId]) (childItems[it.folderId] = childItems[it.folderId] || []).push(it);
        else rootItems.push(it);
      });
      return { folderById: folderById, childFolders: childFolders, childItems: childItems, rootFolders: rootFolders, rootItems: rootItems };
    }

    /** Items anywhere under a folder (what its count shows). */
    function countItems(folderId) {
      var n = (idx.childItems[folderId] || []).length;
      (idx.childFolders[folderId] || []).forEach(function (f) { n += countItems(f.id); });
      return n;
    }

    /** Every folder id under `folderId`, excluding it. */
    function descendants(folderId) {
      var out = [];
      (idx.childFolders[folderId] || []).forEach(function (f) { out.push(f.id); out.push.apply(out, descendants(f.id)); });
      return out;
    }

    function folderRowHtml(f, depth) {
      var open = expanded.has(f.id);
      var drag = opts.interactive !== false && f.canManage ? ' draggable="true"' : "";
      var badge = f.visibility === "public" ? '<span class="sfl-badge" title="Shared with everyone">Public</span>' : "";
      var hasVerbs = opts.interactive !== false && (f.canManage || f.canTake);
      if (renamingId === f.id) {
        return '<div class="sft-folder" data-sft-folder="' + esc(f.id) + '" style="padding-left:' + depth * INDENT + 'px">' +
          '<div class="sft-rename">' + FOLDER_SVG +
            '<input type="text" maxlength="60" data-sft-rename="' + esc(f.id) + '" value="' + esc(f.name) + '" aria-label="Folder name">' +
          "</div></div>";
      }
      return '<div class="sft-folder" data-sft-folder="' + esc(f.id) + '"' + drag + ' style="padding-left:' + depth * INDENT + 'px">' +
        '<button type="button" class="sft-toggle" data-sft-toggle="' + esc(f.id) + '" aria-expanded="' + (open ? "true" : "false") + '">' +
          (open ? CHEV_OPEN : CHEV_SHUT) + FOLDER_SVG +
          '<span class="sfl-name">' + esc(f.name) + "</span>" +
          '<span class="sft-count">' + countItems(f.id) + "</span>" + badge + ownerBadgeHtml(f) +
        "</button>" +
        (hasVerbs
          ? '<button type="button" class="sft-more" data-sft-more="' + esc(f.id) + '" aria-label="Folder actions for ' + esc(f.name) + '">' + MORE_SVG + "</button>"
          : "") +
      "</div>";
    }

    function itemHtml(it, depth) {
      var drag = opts.interactive !== false && it.canManage ? ' draggable="true"' : "";
      var attrs = ' data-sft-item="' + esc(it.id) + '"' + drag + (depth ? ' style="padding-left:' + depth * INDENT + 'px"' : "");
      return opts.itemRowHtml(it, attrs, depth);
    }

    function nodeHtml(folders, items, depth) {
      var html = "";
      folders.slice().sort(byName).forEach(function (f) {
        html += folderRowHtml(f, depth);
        if (expanded.has(f.id)) {
          html += nodeHtml(idx.childFolders[f.id] || [], idx.childItems[f.id] || [], depth + 1);
        }
      });
      items.slice().sort(byName).forEach(function (it) { html += itemHtml(it, depth); });
      return html;
    }

    /** The whole tree as menu markup (headings + rows). Empty string when there is nothing. */
    function html() {
      if (!idx) idx = buildIndex();
      if (opts.single) {
        var all = nodeHtml(idx.rootFolders, idx.rootItems, 0);
        return all ? '<div class="dropdown-heading" data-sft-root="1">' + esc(opts.single) + "</div>" + all : "";
      }
      var out = "";
      ["mine", "shared", "ownerless"].forEach(function (sec) {
        var fs = idx.rootFolders.filter(function (f) { return sectionOf(f) === sec; });
        var is = idx.rootItems.filter(function (it) { return sectionOf(it) === sec; });
        if (!fs.length && !is.length) return;
        var title = sec === "ownerless" ? ' title="Items whose owner was removed. Full read-write holders can reassign, take or delete them."' : "";
        out += '<div class="dropdown-heading" data-sft-root="1"' + title + ">" + esc(opts.labels[sec]) + "</div>" +
          nodeHtml(fs, is, 0);
      });
      return out;
    }

    function isEmpty() { return !data.items.length && !data.folders.length; }

    // ─── Verbs ──────────────────────────────────────────────────────────────

    async function run(promise, okMsg) {
      try {
        await promise;
        if (okMsg) toast(okMsg);
        await opts.refresh();
        return true;
      } catch (err) {
        toast((err && err.message) || "That did not work", "error");
        return false;
      }
    }

    function newFolder(parent) {
      if (typeof openModal !== "function") return;
      var publish = opts.canPublish();
      var body =
        '<div class="form-group"><label for="sft-new-name">Name</label>' +
          '<input type="text" id="sft-new-name" maxlength="60" autocomplete="off" placeholder="e.g. Firewalls"></div>' +
        '<div class="form-group"><label>Inside</label><div class="form-value">' +
          (parent ? esc(parent.name) : "Top level") + "</div></div>" +
        '<div class="form-group"><label>Visibility</label>' +
          '<label class="sfl-vis"><input type="radio" name="sft-new-vis" value="private" checked><span><strong>Private</strong> — only you can see it</span></label>' +
          '<label class="sfl-vis' + (publish ? "" : " sfl-vis-disabled") + '"><input type="radio" name="sft-new-vis" value="public"' + (publish ? "" : " disabled") + ">" +
            "<span><strong>Public</strong> — everyone who can see this list can see it" +
            (publish ? "" : '<br><span class="hint">Requires write access</span>') + "</span></label>" +
        "</div>";
      openModal(parent ? "New subfolder" : "New folder", body,
        '<button class="btn btn-secondary" id="sft-new-cancel">Cancel</button><button class="btn btn-primary" id="sft-new-save">Create</button>');
      var input = document.getElementById("sft-new-name");
      var save = document.getElementById("sft-new-save");
      document.getElementById("sft-new-cancel").addEventListener("click", closeModal);
      async function submit() {
        var name = (input.value || "").trim();
        if (!name) { toast("Name is required", "error"); input.focus(); return; }
        var vis = document.querySelector('input[name="sft-new-vis"]:checked');
        save.disabled = true;
        try {
          await opts.ops.createFolder({ name: name, parentId: parent ? parent.id : null, visibility: vis ? vis.value : "private" });
          closeModal();
          if (parent) { expanded.add(parent.id); writeSet(opts.storageKey, expanded); }
          toast('Created folder "' + name + '"');
          await opts.refresh();
        } catch (err) {
          toast((err && err.message) || "Could not create the folder", "error");
          save.disabled = false;
        }
      }
      save.addEventListener("click", submit);
      input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); submit(); } });
      setTimeout(function () { input.focus(); }, 0);
    }

    function startRename(f) {
      renamingId = f.id;
      opts.rerender();
    }

    async function commitRename(id, value) {
      var f = idx.folderById[id];
      renamingId = null;
      var name = (value || "").trim();
      if (!f || !name || name === f.name) { opts.rerender(); return; }
      await run(opts.ops.updateFolder(f.id, { name: name, visibility: f.visibility }), 'Renamed to "' + name + '"');
    }

    function setVisibility(f, visibility) {
      run(opts.ops.updateFolder(f.id, { name: f.name, visibility: visibility }),
        visibility === "public" ? '"' + f.name + '" is now public' : '"' + f.name + '" is now private');
    }

    async function deleteFolder(f) {
      if (typeof showConfirm !== "function") return;
      var kids = (idx.childFolders[f.id] || []).length;
      var items = (idx.childItems[f.id] || []).length;
      var parent = f.parentId ? idx.folderById[f.parentId] : null;
      var where = parent ? '"' + parent.name + '"' : "the top level";
      var parts = [];
      if (items) parts.push(items + " " + (items === 1 ? opts.labels.one : opts.labels.many));
      if (kids) parts.push(kids + (kids === 1 ? " subfolder" : " subfolders"));
      var msg = 'Delete the folder "' + f.name + '"?' +
        (parts.length ? "\n\nIts " + parts.join(" and ") + " move up to " + where + ". Nothing inside is deleted." : "") +
        (f.visibility === "public" ? "\n\nIt is shared — everyone loses the folder." : "");
      if (!(await showConfirm(msg))) return;
      run(opts.ops.deleteFolder(f.id), 'Deleted folder "' + f.name + '"');
    }

    /** What a folder's "include the items inside" would move, from what the caller can see. */
    function subtreeCounts(f, test) {
      var folders = 0;
      var items = 0;
      [f.id].concat(descendants(f.id)).forEach(function (id, i) {
        if (i > 0 && test(idx.folderById[id])) folders++;
        (idx.childItems[id] || []).forEach(function (it) { if (test(it)) items++; });
      });
      return { folders: folders, items: items };
    }

    function countsText(c) {
      var parts = [];
      if (c.items) parts.push(c.items + " " + (c.items === 1 ? opts.labels.one : opts.labels.many));
      if (c.folders) parts.push(c.folders + (c.folders === 1 ? " subfolder" : " subfolders"));
      return parts.join(" and ");
    }

    /**
     * Change owner — a user, a role or a region — with the warning the owner
     * asked for. `target` is { type: "folder" | "item", row }.
     */
    async function changeOwner(target) {
      if (typeof openModal !== "function") return;
      var row = target.row;
      var isFolder = target.type === "folder";
      var noun = isFolder ? "folder" : opts.labels.one;
      var options;
      try { options = await opts.ops.ownerOptions(); }
      catch (err) { toast((err && err.message) || "Could not load the owner choices", "error"); return; }
      var inside = isFolder ? subtreeCounts(row, function (r) { return r && r.canManage; }) : { folders: 0, items: 0 };
      var insideText = countsText(inside);

      function opt(value, label) { return '<option value="' + esc(value) + '">' + esc(label) + "</option>"; }
      var userOpts = '<option value="">Choose a user</option>' + (options.users || []).map(function (u) {
        return opt(u.id, u.displayName ? u.username + " — " + u.displayName : u.username);
      }).join("");
      var roleOpts = '<option value="">Choose a role</option>' + (options.roles || []).map(function (r) { return opt(r.id, r.name); }).join("");
      var regionOpts = '<option value="">Choose a region</option>' + (options.regions || []).map(function (r) { return opt(r, r); }).join("");

      var body =
        '<div class="form-group"><label>' + esc(noun.charAt(0).toUpperCase() + noun.slice(1)) + "</label>" +
          '<div class="form-value">' + esc(row.name) + ' <span class="hint">· ' + esc(row.visibility) +
          (insideText ? " · " + esc(insideText) + " inside" : "") + "</span></div></div>" +
        '<div class="form-group"><label>Current owner</label><div class="form-value">' +
          esc(row.isOwner && row.ownerKind === "user" ? "You (" + row.ownerName + ")" : ownerText(row)) + "</div></div>" +
        '<div class="form-group"><label>New owner</label>' +
          '<div class="sfo-kind">' +
            '<label class="sfl-vis"><input type="radio" name="sfo-kind" value="user" checked><span>A user</span></label>' +
            '<select id="sfo-user" aria-label="User">' + userOpts + "</select>" +
            '<label class="sfl-vis"><input type="radio" name="sfo-kind" value="role"><span>A role</span></label>' +
            '<select id="sfo-role" aria-label="Role" disabled>' + roleOpts + "</select>" +
            '<label class="sfl-vis"><input type="radio" name="sfo-kind" value="region"><span>A region</span></label>' +
            '<select id="sfo-region" aria-label="Region" disabled>' + regionOpts + "</select>" +
          "</div>" +
          '<div class="hint">A role owner is everyone holding that role; a region owner is everyone whose region scope names it.</div>' +
        "</div>" +
        (isFolder && insideText
          ? '<div class="form-group"><label class="sfl-vis"><input type="checkbox" id="sfo-include" checked>' +
            "<span>Also give them the " + esc(insideText) + " inside that you manage</span></label></div>"
          : "") +
        '<div class="sfo-warn" role="alert" id="sfo-warn"></div>';

      openModal("Change owner", body,
        '<button class="btn btn-secondary" id="sfo-cancel">Cancel</button><button class="btn btn-warning" id="sfo-save">Change owner</button>');
      document.getElementById("sfo-cancel").addEventListener("click", closeModal);
      var selects = { user: document.getElementById("sfo-user"), role: document.getElementById("sfo-role"), region: document.getElementById("sfo-region") };
      var warn = document.getElementById("sfo-warn");
      var save = document.getElementById("sfo-save");

      function kind() {
        var k = document.querySelector('input[name="sfo-kind"]:checked');
        return k ? k.value : "user";
      }
      function chosenLabel() {
        var sel = selects[kind()];
        if (!sel || !sel.value) return "";
        var text = sel.options[sel.selectedIndex].text;
        if (kind() === "role") return "members of the " + text + " role";
        if (kind() === "region") return "everyone scoped to the " + text + " region";
        return text.split(" — ")[0];
      }
      function paintWarning() {
        var who = chosenLabel() || "the new owner";
        var lines = [];
        lines.push(row.isOwner
          ? "<strong>You will no longer own this " + esc(noun) + ".</strong> Only " + esc(who) + " will be able to rename, move, publish, delete or hand it on."
          : "<strong>" + esc(ownerText(row)) + " will no longer own this " + esc(noun) + ".</strong> Only " + esc(who) + " will be able to change it.");
        if (row.visibility !== "public") {
          lines.push("It is private, so it moves out of your menu and into theirs — you will no longer see it unless you are one of them.");
        }
        lines.push("You can’t undo this yourself; the new owner would have to give it back.");
        warn.innerHTML = WARN_SVG + "<div>" + lines.map(function (l) { return "<p>" + l + "</p>"; }).join("") + "</div>";
      }
      document.querySelectorAll('input[name="sfo-kind"]').forEach(function (r) {
        r.addEventListener("change", function () {
          Object.keys(selects).forEach(function (k) { selects[k].disabled = k !== kind(); });
          paintWarning();
        });
      });
      Object.keys(selects).forEach(function (k) { selects[k].addEventListener("change", paintWarning); });
      paintWarning();

      save.addEventListener("click", async function () {
        var k = kind();
        var value = selects[k].value;
        if (!value) { toast("Choose who should own it", "error"); selects[k].focus(); return; }
        var owner = k === "user" ? { kind: "user", userId: value } : k === "role" ? { kind: "role", roleId: value } : { kind: "region", region: value };
        var include = document.getElementById("sfo-include");
        save.disabled = true;
        try {
          if (isFolder) await opts.ops.setFolderOwner(row.id, owner, !!(include && include.checked));
          else await opts.ops.setItemOwner(row.id, owner);
          closeModal();
          toast('"' + row.name + '" now belongs to ' + (chosenLabel() || "its new owner"));
          await opts.refresh();
        } catch (err) {
          toast((err && err.message) || "Could not change the owner", "error");
          save.disabled = false;
        }
      });
    }

    /**
     * Make private to me. Already yours as a user → plain "Make private", no
     * dialog. Anyone else's → the take-over warning first.
     */
    async function takePrivate(target) {
      var row = target.row;
      var isFolder = target.type === "folder";
      var noun = isFolder ? "folder" : opts.labels.one;
      var mine = row.isOwner && row.ownerKind === "user";
      var call = function (include) {
        return isFolder ? opts.ops.takeFolder(row.id, include) : opts.ops.takeItem(row.id);
      };
      if (mine) {
        run(call(false), '"' + row.name + '" is now private');
        return;
      }
      if (typeof openModal !== "function") return;
      var inside = isFolder ? subtreeCounts(row, function (r) { return r && r.canTake; }) : { folders: 0, items: 0 };
      var insideText = countsText(inside);
      var from = ownerText(row);
      var lines = [
        row.ownerKind === "none"
          ? "<strong>You are taking this ownerless " + esc(noun) + ".</strong> You become its owner and it turns private, so it disappears from every other operator’s menu."
          : "<strong>You are taking this " + esc(noun) + " from " + esc(from) + ".</strong> You become its owner and it turns private, so it disappears from every other operator’s menu, including theirs.",
      ];
      if (!isFolder && opts.labels.one === "filter") lines.push("View tabs that use it as their base filter keep working from their saved copy.");
      if (!isFolder && opts.labels.one === "dashboard") lines.push("Tabs already loaded from it keep their copy; a wallboard showing it stops following it.");
      lines.push("The change is recorded in Events" + (row.ownerKind === "none" ? "" : " with " + esc(from) + " named as the previous owner") + ". Only you can give it back.");
      var body =
        '<div class="form-group"><label>' + esc(noun.charAt(0).toUpperCase() + noun.slice(1)) + "</label>" +
          '<div class="form-value">' + esc(row.name) + ' <span class="hint">· ' + esc(row.visibility) + " · " + esc(from) + "</span></div></div>" +
        (isFolder && insideText
          ? '<div class="form-group"><label class="sfl-vis"><input type="checkbox" id="sft-take-include" checked>' +
            "<span>Also take the " + esc(insideText) + " inside</span></label></div>"
          : "") +
        '<div class="sfo-warn" role="alert">' + WARN_SVG + "<div>" + lines.map(function (l) { return "<p>" + l + "</p>"; }).join("") + "</div></div>";
      openModal("Make private to me", body,
        '<button class="btn btn-secondary" id="sft-take-cancel">Cancel</button><button class="btn btn-warning" id="sft-take-save">Make private to me</button>');
      document.getElementById("sft-take-cancel").addEventListener("click", closeModal);
      var save = document.getElementById("sft-take-save");
      save.addEventListener("click", async function () {
        var include = document.getElementById("sft-take-include");
        save.disabled = true;
        try {
          await call(!!(include && include.checked));
          closeModal();
          toast('"' + row.name + '" is now private to you');
          await opts.refresh();
        } catch (err) {
          toast((err && err.message) || "Could not make it private", "error");
          save.disabled = false;
        }
      });
    }

    function folderMenu(f, anchor, at) {
      if (typeof showRowMenu !== "function") return;
      var items = [];
      var mineAsUser = f.isOwner && f.ownerKind === "user";
      if (f.canManage) {
        items.push({ label: "New subfolder", onSelect: function () { newFolder(f); } });
        items.push({ label: "Rename", onSelect: function () { startRename(f); } });
        if (f.visibility === "public") items.push({ label: "Make private", onSelect: function () { setVisibility(f, "private"); } });
        else if (opts.canPublish()) items.push({ label: "Make public", onSelect: function () { setVisibility(f, "public"); } });
        items.push({ label: "Change owner", onSelect: function () { changeOwner({ type: "folder", row: f }); } });
      }
      if (f.canTake && !mineAsUser) items.push({ label: "Make private to me", onSelect: function () { takePrivate({ type: "folder", row: f }); } });
      if (f.canManage) {
        items.push({ separator: true });
        items.push({ label: "Delete folder", danger: true, onSelect: function () { deleteFolder(f); } });
      }
      if (items.length) showRowMenu(anchor, items, { label: "Actions for folder " + f.name, menuAt: at || null });
    }

    function itemMenu(it, anchor, at) {
      if (typeof showRowMenu !== "function") return;
      var items = [];
      var mineAsUser = it.isOwner && it.ownerKind === "user";
      if (it.canManage) items.push({ label: "Change owner", onSelect: function () { changeOwner({ type: "item", row: it }); } });
      if (it.canTake && !(mineAsUser && it.visibility === "private")) {
        items.push({
          label: mineAsUser ? "Make private" : "Make private to me",
          onSelect: function () { takePrivate({ type: "item", row: it }); },
        });
      }
      if (it.folderId && it.canManage) {
        items.push({ label: "Move to top level", onSelect: function () { run(opts.ops.moveItem(it.id, null), 'Moved "' + it.name + '" to the top level'); } });
      }
      if (items.length) showRowMenu(anchor, items, { label: "Actions for " + it.name, menuAt: at || null });
    }

    // ─── Drag and drop ──────────────────────────────────────────────────────

    /** May the thing being dragged land on folder `targetId` (null = top level)? */
    function canDrop(targetId) {
      if (!dragging) return false;
      if (dragging.type === "item") {
        var it = data.items.find(function (x) { return x.id === dragging.id; });
        return !!it && (it.folderId || null) !== targetId;
      }
      var f = idx.folderById[dragging.id];
      if (!f) return false;
      if ((f.parentId || null) === targetId) return false;
      if (targetId && (targetId === f.id || descendants(f.id).indexOf(targetId) !== -1)) return false;
      return true;
    }

    function clearDropMarks(root) {
      root.querySelectorAll(".sft-drop").forEach(function (el) { el.classList.remove("sft-drop"); });
    }

    async function drop(targetId) {
      var d = dragging;
      dragging = null;
      if (!d) return;
      var target = targetId ? idx.folderById[targetId] : null;
      var where = target ? '"' + target.name + '"' : "the top level";
      if (d.type === "item") {
        var it = data.items.find(function (x) { return x.id === d.id; });
        if (target) { expanded.add(target.id); writeSet(opts.storageKey, expanded); }
        await run(opts.ops.moveItem(d.id, targetId), it ? 'Moved "' + it.name + '" to ' + where : null);
      } else {
        var f = idx.folderById[d.id];
        if (target) { expanded.add(target.id); writeSet(opts.storageKey, expanded); }
        await run(opts.ops.moveFolder(d.id, targetId), f ? 'Moved folder "' + f.name + '" to ' + where : null);
      }
    }

    /** Wire the menu element once; every handler is delegated, so re-renders keep working. */
    function wire(menu) {
      menu.addEventListener("click", function (e) {
        var toggle = e.target.closest("[data-sft-toggle]");
        if (toggle) {
          e.stopPropagation();
          var id = toggle.getAttribute("data-sft-toggle");
          if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
          writeSet(opts.storageKey, expanded);
          opts.rerender();
          return;
        }
        var more = e.target.closest("[data-sft-more]");
        if (more) {
          e.stopPropagation();
          var f = idx && idx.folderById[more.getAttribute("data-sft-more")];
          if (f) folderMenu(f, more);
        }
      });

      if (opts.interactive === false) return;

      menu.addEventListener("contextmenu", function (e) {
        var folderEl = e.target.closest("[data-sft-folder]");
        var itemEl = e.target.closest("[data-sft-item]");
        if (!folderEl && !itemEl) return;
        e.preventDefault();
        var at = { x: e.clientX, y: e.clientY };
        if (folderEl) {
          var f = idx.folderById[folderEl.getAttribute("data-sft-folder")];
          if (f) folderMenu(f, folderEl, at);
        } else {
          var it = data.items.find(function (x) { return x.id === itemEl.getAttribute("data-sft-item"); });
          if (it) itemMenu(it, itemEl, at);
        }
      });

      menu.addEventListener("keydown", function (e) {
        var input = e.target.closest("[data-sft-rename]");
        if (!input) return;
        if (e.key === "Enter") { e.preventDefault(); commitRename(input.getAttribute("data-sft-rename"), input.value); }
        else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); renamingId = null; opts.rerender(); }
      });
      menu.addEventListener("focusout", function (e) {
        var input = e.target.closest && e.target.closest("[data-sft-rename]");
        if (input && renamingId) commitRename(input.getAttribute("data-sft-rename"), input.value);
      });

      menu.addEventListener("dragstart", function (e) {
        var folderEl = e.target.closest("[data-sft-folder][draggable]");
        var itemEl = !folderEl && e.target.closest("[data-sft-item][draggable]");
        if (!folderEl && !itemEl) return;
        dragging = folderEl
          ? { type: "folder", id: folderEl.getAttribute("data-sft-folder") }
          : { type: "item", id: itemEl.getAttribute("data-sft-item") };
        (folderEl || itemEl).classList.add("sft-dragging");
        try {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", dragging.type + ":" + dragging.id);
        } catch (_err) { /* some engines refuse setData on synthetic events */ }
      });
      menu.addEventListener("dragover", function (e) {
        if (!dragging) return;
        var folderEl = e.target.closest("[data-sft-folder]");
        var rootEl = !folderEl && e.target.closest("[data-sft-root]");
        var targetId = folderEl ? folderEl.getAttribute("data-sft-folder") : rootEl ? null : undefined;
        if (targetId === undefined || !canDrop(targetId)) return;
        e.preventDefault();
        clearDropMarks(menu);
        (folderEl || rootEl).classList.add("sft-drop");
      });
      menu.addEventListener("dragleave", function (e) {
        var el = e.target.closest && e.target.closest(".sft-drop");
        if (el && !el.contains(e.relatedTarget)) el.classList.remove("sft-drop");
      });
      menu.addEventListener("drop", function (e) {
        if (!dragging) return;
        var folderEl = e.target.closest("[data-sft-folder]");
        var rootEl = !folderEl && e.target.closest("[data-sft-root]");
        var targetId = folderEl ? folderEl.getAttribute("data-sft-folder") : rootEl ? null : undefined;
        clearDropMarks(menu);
        if (targetId === undefined || !canDrop(targetId)) { dragging = null; return; }
        e.preventDefault();
        drop(targetId);
      });
      menu.addEventListener("dragend", function () {
        dragging = null;
        clearDropMarks(menu);
        menu.querySelectorAll(".sft-dragging").forEach(function (el) { el.classList.remove("sft-dragging"); });
      });
    }

    /** Focus the rename field after a re-render put one on screen. */
    function focusRename(menu) {
      var input = menu.querySelector("[data-sft-rename]");
      if (input) { input.focus(); input.select(); }
    }

    // ─── The Save modals' Folder picker ─────────────────────────────────────

    function pickerOptionsHtml(selectedId) {
      if (!idx) idx = buildIndex();
      var html = '<option value="">Top level</option>';
      function walk(list, depth) {
        list.slice().sort(byName).forEach(function (f) {
          var pad = new Array(depth * 4 + 1).join(" ");
          var who = f.isOwner ? "" : " (" + ownerText(f) + ")";
          html += '<option value="' + esc(f.id) + '"' + (f.id === selectedId ? " selected" : "") + ">" + esc(pad + f.name + who) + "</option>";
          walk(idx.childFolders[f.id] || [], depth + 1);
        });
      }
      walk(idx.rootFolders, 0);
      return html;
    }

    /** The Folder form group, for a Save modal. Read the choice with `pickerValue`. */
    function pickerHtml(selectedId) {
      return '<div class="form-group">' +
        '<label for="sft-picker">Folder</label>' +
        '<div class="sft-picker-row">' +
          '<select id="sft-picker">' + pickerOptionsHtml(selectedId || null) + "</select>" +
          '<button type="button" class="btn btn-secondary btn-sm" id="sft-picker-new">New folder</button>' +
        "</div>" +
        '<div class="sft-picker-row" id="sft-picker-create" hidden>' +
          '<input type="text" id="sft-picker-name" maxlength="60" autocomplete="off" placeholder="New folder name" aria-label="New folder name">' +
          '<button type="button" class="btn btn-secondary btn-sm" id="sft-picker-add">Create</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" id="sft-picker-cancel">Cancel</button>' +
        "</div>" +
        '<div class="hint">Nested folders are indented. You can also drag between folders in the menu.</div>' +
      "</div>";
    }

    /** Wire the picker after the modal is open: inline "New folder" creates inside the selected one. */
    function wirePicker() {
      var select = document.getElementById("sft-picker");
      var newBtn = document.getElementById("sft-picker-new");
      var row = document.getElementById("sft-picker-create");
      var name = document.getElementById("sft-picker-name");
      if (!select || !newBtn || !row || !name) return;
      newBtn.addEventListener("click", function () { row.hidden = false; name.focus(); });
      document.getElementById("sft-picker-cancel").addEventListener("click", function () { row.hidden = true; name.value = ""; });
      async function add() {
        var n = (name.value || "").trim();
        if (!n) { name.focus(); return; }
        try {
          // Private: publishing a folder is its own, deliberate step (the ⋯ menu).
          var created = await opts.ops.createFolder({ name: n, parentId: select.value || null, visibility: "private" });
          await opts.refresh();
          select.innerHTML = pickerOptionsHtml(created && created.id);
          row.hidden = true;
          name.value = "";
          toast('Created folder "' + n + '"');
        } catch (err) {
          toast((err && err.message) || "Could not create the folder", "error");
        }
      }
      document.getElementById("sft-picker-add").addEventListener("click", add);
      name.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); add(); }
      });
    }

    function pickerValue() {
      var select = document.getElementById("sft-picker");
      return select && select.value ? select.value : null;
    }

    return {
      setData: setData,
      html: html,
      isEmpty: isEmpty,
      wire: wire,
      focusRename: focusRename,
      newFolder: newFolder,
      itemMenu: function (item, anchor) { itemMenu(item, anchor); },
      pickerHtml: pickerHtml,
      wirePicker: wirePicker,
      pickerValue: pickerValue,
    };
  }

  window.PolarisSavedTree = {
    create: create,
    ownerText: ownerText,
    ownerBadgeHtml: ownerBadgeHtml,
  };
})();
