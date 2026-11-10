/**
 * public/js/region-tree-panel.js — the Device Map's Location regions panel (business
 * rule 153): a site's region tree, areas > buildings > floors > rooms >
 * racks > junction boxes.
 *
 *   window.PolarisRegionTreePanel.open({ siteId, data, canEdit, onChanged })
 *
 * Build from descriptions adds every region the site's descriptions name
 * (only ever adding). Add region, Rename, Move, Merge into and Delete edit the
 * tree directly. A rename or move lists the descriptions that name the
 * region in a full chain, with old → new codes, and offers to update them
 * through the reviewed location-code commit (rule 148); leaving them flags
 * those devices as disagreeing. Nothing here changes a description without
 * that confirmation. Devices whose codes disagree with the tree, or name a
 * lone floor, are listed so they can be fixed.
 */
(function () {
  "use strict";

  var KINDS = ["area", "building", "floor", "room", "rack", "junctionBox"];
  var WORD = { area: "Area", building: "Building", floor: "Floor", room: "Room", rack: "Rack", junctionBox: "Junction box" };
  var CODE = { area: "a", building: "b", floor: "f", room: "r", rack: "ra", junctionBox: "jb" };
  var RANK = { area: 0, building: 1, floor: 2, room: 3, rack: 4, junctionBox: 5 };

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s))
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }
  function toast(m, k) { if (typeof showToast === "function") showToast(m, k); }
  function codesText(c) {
    if (!c) return "no codes";
    var parts = KINDS.filter(function (k) { return c[k]; }).map(function (k) { return CODE[k] + ":" + c[k]; });
    return parts.length ? parts.join(" ") : "no codes";
  }

  /** Pure — the tree as display rows, depth-first, children by name. */
  function treeRows(nodes) {
    var kids = {};
    nodes.forEach(function (n) { (kids[n.parentId || ""] = kids[n.parentId || ""] || []).push(n); });
    Object.keys(kids).forEach(function (k) {
      kids[k].sort(function (a, b) {
        return RANK[a.kind] - RANK[b.kind] || String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: "base" });
      });
    });
    var out = [];
    var seen = {};
    (function walk(parent, depth) {
      (kids[parent] || []).forEach(function (n) {
        if (seen[n.id]) return;
        seen[n.id] = true;
        out.push({ node: n, depth: depth });
        walk(n.id, depth + 1);
      });
    })("", 0);
    // Anything orphaned (a parent outside the list) still shows.
    nodes.forEach(function (n) { if (!seen[n.id]) out.push({ node: n, depth: 0 }); });
    return out;
  }
  function pathOf(nodes, node) {
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var parts = [];
    var cur = node, guard = 0;
    while (cur && guard++ < 10) { parts.unshift(cur.name); cur = cur.parentId ? byId[cur.parentId] : null; }
    return parts.join(" › ");
  }

  async function open(opts) {
    if (typeof buildOverlay !== "function" || !opts || !opts.siteId) return;
    var siteId = opts.siteId;
    var canEdit = !!opts.canEdit;
    var nodes = [];
    var dlg = buildOverlay(1100, "Location regions", '<div data-rt-body><p class="muted">Loading…</p></div>',
      '<button type="button" class="btn btn-secondary" data-rt="close">Close</button>');
    dlg.overlay.querySelector('[data-rt="close"]').addEventListener("click", dlg.close);
    var body = dlg.overlay.querySelector("[data-rt-body]");

    async function reload() {
      try { nodes = (await api.map.regions(siteId)).nodes || []; } catch (e) { nodes = []; toast("Regions not loaded — " + (e && e.message ? e.message : e), "error"); }
      paint();
    }
    // The map re-reads the site (locations resolve through the new tree),
    // then the panel repaints with the fresh conflicts list.
    function changed() {
      var p = null;
      if (typeof opts.onChanged === "function") { try { p = opts.onChanged(); } catch (e) { p = null; } }
      return Promise.resolve(p).catch(function () {}).then(reload);
    }
    function paint() {
      var rows = treeRows(nodes);
      var conflicts = (opts.data && opts.data().regionConflicts) || [];
      var html =
        '<p class="hint" style="margin:0 0 10px">One place per name at this site (a floor is one per building), so a description can say just <code>r:Closet</code> or <code>ra:rack1</code> and Polaris knows the rest. Editing the tree never changes a description unless you confirm it.</p>' +
        (canEdit ? '<div style="display:flex;gap:8px;margin-bottom:10px">' +
          '<button type="button" class="btn btn-secondary btn-sm" data-rt="build">Build from descriptions</button>' +
          '<button type="button" class="btn btn-secondary btn-sm" data-rt="add">Add region</button></div>' : '') +
        (rows.length
          ? '<ul class="region-tree">' + rows.map(function (r) {
              var n = r.node;
              return '<li class="region-tree-row" data-rt-node="' + esc(n.id) + '" style="padding-left:' + (8 + r.depth * 18) + 'px">' +
                '<span class="region-tree-kind">' + esc(WORD[n.kind] || n.kind) + '</span>' +
                '<strong class="region-tree-name">' + esc(n.name) + '</strong>' +
                '<code class="region-tree-code">' + esc(CODE[n.kind] + ":" + n.name) + '</code>' +
                (canEdit ? '<button type="button" class="btn-icon region-tree-more" data-rt-menu="' + esc(n.id) + '" aria-label="Actions for ' + esc(n.name) + '">⋯</button>' : '') +
              '</li>';
            }).join("") + '</ul>'
          : '<p class="muted" style="margin:6px 0">No regions yet.' + (canEdit ? ' <strong>Build from descriptions</strong> adds every area, building, floor, room, rack and junction box the site’s descriptions already name.' : '') + '</p>') +
        (conflicts.length
          ? '<h5 class="region-tree-h">Devices to check (' + conflicts.length + ')</h5><ul class="region-tree-conflicts">' + conflicts.map(function (c) {
              return '<li><strong>' + esc(c.hostname || c.id) + '</strong> <code>' + esc(codesText(c.written)) + '</code> <span class="hint" style="margin:0">' +
                (c.status === "ambiguous" ? "names a floor without its building"
                  : c.status === "unknown" ? "names a region the tree doesn’t have — Build from descriptions adds it, or fix the description"
                  : "disagrees with the tree — shown as written") + '</span></li>';
            }).join("") + '</ul>'
          : '');
      body.innerHTML = html;
    }

    body.addEventListener("click", async function (e) {
      if (e.target.closest('[data-rt="build"]')) {
        try {
          var res = await api.map.buildRegions(siteId);
          toast(res.added ? res.added + " region" + (res.added === 1 ? "" : "s") + " added from descriptions" : "The tree already has every region the descriptions name");
          changed();
        } catch (err) { toast("Not built — " + (err && err.message ? err.message : err), "error"); }
        return;
      }
      if (e.target.closest('[data-rt="add"]')) { editDialog(null); return; }
      var more = e.target.closest("[data-rt-menu]");
      if (more && typeof showRowMenu === "function") {
        var n = nodes.filter(function (x) { return x.id === more.getAttribute("data-rt-menu"); })[0];
        if (!n) return;
        showRowMenu(more, [
          { heading: WORD[n.kind] + " " + n.name },
          { label: "Rename", onSelect: function () { editDialog(n, "rename"); } },
          { label: "Move", onSelect: function () { editDialog(n, "move"); } },
          { label: "Merge into", onSelect: function () { mergeDialog(n); } },
          { label: "Delete", danger: true, onSelect: function () { deleteNode(n); } },
        ], { label: "Region", align: "end" });
      }
    });

    function parentOptions(kind, selfId, selected) {
      var opts2 = nodes.filter(function (p) { return RANK[p.kind] < RANK[kind] && p.id !== selfId; })
        .sort(function (a, b) { return pathOf(nodes, a).localeCompare(pathOf(nodes, b)); })
        .map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === selected ? " selected" : "") + '>' + esc(WORD[p.kind] + ": " + pathOf(nodes, p)) + '</option>'; });
      return (kind === "floor" ? "" : '<option value="">Nothing — top of the tree</option>') + opts2.join("");
    }
    function editDialog(node, what) {
      var isNew = !node;
      var kind = node ? node.kind : "room";
      var bodyHtml =
        (isNew ? '<div class="form-group"><label for="rt-kind">Kind</label><select id="rt-kind">' +
          KINDS.map(function (k) { return '<option value="' + k + '"' + (k === kind ? " selected" : "") + '>' + WORD[k] + '</option>'; }).join("") + '</select></div>' : '') +
        (isNew || what === "rename" ? '<div class="form-group"><label for="rt-name">Name</label><input id="rt-name" type="text" maxlength="64" value="' + esc(node ? node.name : "") + '"></div>' : '') +
        (isNew || what === "move" ? '<div class="form-group"><label for="rt-parent">Inside</label><select id="rt-parent">' + parentOptions(kind, node && node.id, node && node.parentId) + '</select>' +
          '<div class="hint">A floor must be inside a building (or an area).</div></div>' : '');
      var footer = '<button type="button" class="btn btn-secondary" data-rte="cancel">Cancel</button>' +
        '<button type="button" class="btn btn-primary" data-rte="ok">' + (isNew ? "Add" : "Apply") + '</button>';
      var d = buildOverlay(1200, isNew ? "Add region" : (what === "move" ? "Move " : "Rename ") + WORD[node.kind].toLowerCase() + " " + node.name, bodyHtml, footer);
      var kindSel = d.overlay.querySelector("#rt-kind");
      if (kindSel) kindSel.addEventListener("change", function () {
        d.overlay.querySelector("#rt-parent").innerHTML = parentOptions(kindSel.value, null, null);
      });
      d.overlay.querySelector('[data-rte="cancel"]').addEventListener("click", d.close);
      d.overlay.querySelector('[data-rte="ok"]').addEventListener("click", async function () {
        var nameEl = d.overlay.querySelector("#rt-name"), parEl = d.overlay.querySelector("#rt-parent");
        try {
          if (isNew) {
            await api.map.createRegion(siteId, { kind: kindSel.value, name: nameEl.value.trim(), parentId: parEl.value || null });
            d.close();
            toast("Region added");
            changed();
            return;
          }
          var patch = {};
          if (nameEl) patch.name = nameEl.value.trim();
          if (parEl) patch.parentId = parEl.value || null;
          var res = await api.map.updateRegion(siteId, node.id, patch);
          d.close();
          await changed();
          if (res.rewrites && res.rewrites.length) offerRewrites(res.rewrites, res.node);
          else toast("Region updated — no description needed changing");
        } catch (err) { toast("Not saved — " + (err && err.message ? err.message : err), "error"); }
      });
      setTimeout(function () { var f = d.overlay.querySelector("#rt-name") || d.overlay.querySelector("select"); if (f) f.focus(); }, 0);
    }
    // The rename / move summary (rule 153): the descriptions that name the
    // region in a full chain, old → new; committed only on confirmation.
    function offerRewrites(rewrites, node) {
      var canAssets = typeof permAtLeast === "function" && permAtLeast("assets", "write");
      var rows = rewrites.map(function (r) {
        return '<tr><td>' + esc(r.name) + '</td><td class="mono">' + esc(codesText(r.from)) + '</td><td class="mono">' + esc(codesText(r.codes)) + '</td></tr>';
      }).join("");
      var bodyHtml = '<p style="margin:0 0 10px">' + rewrites.length + ' description' + (rewrites.length === 1 ? " names" : "s name") + ' ' + esc(WORD[node.kind].toLowerCase() + " " + node.name) +
        ' by its old place. Update them to match the tree? The free text in each description stays; only the location codes change.</p>' +
        '<div class="table-wrapper" style="max-height:300px;overflow:auto"><table><thead><tr><th>Device</th><th>Codes now</th><th>After update</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (canAssets ? '' : '<p class="hint">Updating descriptions needs Read-Write on Assets; they stay as they are and are listed under Devices to check.</p>');
      var footer = '<button type="button" class="btn btn-secondary" data-rw="leave">Leave them as they are</button>' +
        (canAssets ? '<button type="button" class="btn btn-primary" data-rw="ok">Update ' + rewrites.length + ' description' + (rewrites.length === 1 ? "" : "s") + '</button>' : '');
      var d = buildOverlay(1300, "Update descriptions?", bodyHtml, footer);
      d.overlay.querySelector('[data-rw="leave"]').addEventListener("click", d.close);
      var ok = d.overlay.querySelector('[data-rw="ok"]');
      if (ok) ok.addEventListener("click", async function () {
        ok.disabled = true;
        try {
          var res = await api.map.commitTopologyLocationCodes(siteId, rewrites.map(function (r) { return { assetId: r.assetId, codes: r.codes }; }));
          var results = (res && res.results) || [];
          var done = results.filter(function (x) { return x.status === "updated"; }).length;
          var refused = results.filter(function (x) { return x.status === "refused"; }).length;
          d.close();
          toast(done + " description" + (done === 1 ? "" : "s") + " updated" + (refused ? ", " + refused + " refused" : ""), refused ? "error" : undefined);
          changed();
        } catch (err) { ok.disabled = false; toast("Not updated — " + (err && err.message ? err.message : err), "error"); }
      });
    }
    function mergeDialog(node) {
      var others = nodes.filter(function (x) { return x.kind === node.kind && x.id !== node.id; });
      if (!others.length) { toast("There is no other " + WORD[node.kind].toLowerCase() + " to merge into", "error"); return; }
      var bodyHtml = '<div class="form-group"><label for="rt-into">Merge ' + esc(WORD[node.kind].toLowerCase() + " " + pathOf(nodes, node)) + ' into</label><select id="rt-into">' +
        others.map(function (o) { return '<option value="' + esc(o.id) + '">' + esc(pathOf(nodes, o)) + '</option>'; }).join("") + '</select>' +
        '<div class="hint">Everything inside it moves to the one you pick, and it is removed. Descriptions are not changed; any that still name it are listed under Devices to check.</div></div>';
      var footer = '<button type="button" class="btn btn-secondary" data-rm="cancel">Cancel</button><button type="button" class="btn btn-primary" data-rm="ok">Merge</button>';
      var d = buildOverlay(1200, "Merge region", bodyHtml, footer);
      d.overlay.querySelector('[data-rm="cancel"]').addEventListener("click", d.close);
      d.overlay.querySelector('[data-rm="ok"]').addEventListener("click", async function () {
        try { await api.map.mergeRegion(siteId, node.id, d.overlay.querySelector("#rt-into").value); d.close(); toast("Merged"); changed(); }
        catch (err) { toast("Not merged — " + (err && err.message ? err.message : err), "error"); }
      });
    }
    async function deleteNode(node) {
      var ok = typeof showConfirm === "function" ? await showConfirm('Delete ' + WORD[node.kind].toLowerCase() + ' "' + node.name + '" from the region tree? Descriptions are not changed.') : false;
      if (!ok) return;
      try { await api.map.deleteRegion(siteId, node.id); toast("Region deleted"); changed(); }
      catch (err) { toast("Not deleted — " + (err && err.message ? err.message : err), "error"); }
    }

    reload();
  }

  window.PolarisRegionTreePanel = { open: open, _treeRows: treeRows, _pathOf: pathOf };
})();
