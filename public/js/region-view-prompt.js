/**
 * public/js/region-view-prompt.js — after an asset's description is saved,
 * offer a Wall or Rack view for each NEW room, rack or junction box region it
 * names (business rule 150).
 *
 *   window.PolarisRegionViewPrompt.afterSave({ assetId, before, after, siteId? })
 *
 * A region is the code chain down to that level (`b:Plant r:MDF jb:7` → the
 * room "Plant › MDF" and the junction box "Plant › MDF › 7"). It is NEW when
 * the old description did not name it. A region some Rack / Wall view of the
 * site already stands for is not asked about, nor one the operator chose
 * "Don't map" for in this browser. Area, building and floor regions are never
 * asked about: Topology and Layer 2 views draw them.
 *
 * Nothing here changes a description; the save already happened. Creating or
 * mapping a view needs Device Map write, so a caller without it is not asked.
 */
(function () {
  "use strict";

  var FIELDS = [["area", "a"], ["building", "b"], ["floor", "f"], ["room", "r"], ["rack", "ra"], ["junctionBox", "jb"]];
  var KEY_TO_FIELD = { a: "area", b: "building", f: "floor", r: "room", ra: "rack", jb: "junctionBox" };
  var ASK_LEVELS = { room: "Room", rack: "Rack", junctionBox: "Junction box" };
  var SKIP_PREFIX = "polaris.regionPrompt.skip:";

  function esc(s) {
    return typeof escapeHtml === "function" ? escapeHtml(String(s == null ? "" : s))
      : String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; });
  }

  /** Pure — the same grammar as src/utils/locationCodes.ts → parseLocationCodes. */
  function parseCodes(raw) {
    var out = { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };
    if (!raw || typeof raw !== "string") return out;
    var re = /(?:^|\s)(jb|ra|a|b|f|r):/gi;
    var hits = [], m;
    while ((m = re.exec(raw))) hits.push({ field: KEY_TO_FIELD[m[1].toLowerCase()], start: m.index, valueStart: m.index + m[0].length });
    hits.forEach(function (h, i) {
      var end = i + 1 < hits.length ? hits[i + 1].start : raw.length;
      var v = raw.slice(h.valueStart, end).trim();
      if (v) out[h.field] = v;
    });
    return out;
  }
  function chainKey(c) {
    return FIELDS.map(function (f) { return String((c && c[f[0]]) || "").trim().replace(/\s+/g, " ").toLowerCase(); }).join("|");
  }
  function chainText(c) {
    return FIELDS.filter(function (f) { return c[f[0]]; }).map(function (f) { return f[1] + ":" + c[f[0]]; }).join(" ");
  }
  /** Pure — the room / rack / junction-box chains a set of codes names, outermost first. */
  function askableChains(codes) {
    var out = [];
    var chain = { area: null, building: null, floor: null, room: null, rack: null, junctionBox: null };
    FIELDS.forEach(function (f) {
      chain = Object.assign({}, chain);
      chain[f[0]] = codes[f[0]] || null;
      if (codes[f[0]] && ASK_LEVELS[f[0]]) out.push({ level: f[0], codes: chain });
    });
    return out;
  }
  /** Pure — the chains `after` names that `before` did not, and no view stands for. */
  function newRegions(before, after, views, skipped) {
    var had = {};
    askableChains(parseCodes(before)).forEach(function (r) { had[chainKey(r.codes)] = true; });
    var mapped = {};
    (views || []).forEach(function (v) { if (v.region) mapped[chainKey(v.region)] = true; });
    return askableChains(parseCodes(after)).filter(function (r) {
      var k = chainKey(r.codes);
      return !had[k] && !mapped[k] && !(skipped && skipped[k]);
    });
  }
  function skippedSet(siteId) {
    var out = {};
    try {
      var raw = localStorage.getItem(SKIP_PREFIX + siteId);
      (raw ? JSON.parse(raw) : []).forEach(function (k) { out[k] = true; });
    } catch (e) { /* per-viewer convenience only */ }
    return out;
  }
  function rememberSkip(siteId, key) {
    try {
      var cur = Object.keys(skippedSet(siteId));
      if (cur.indexOf(key) === -1) cur.push(key);
      localStorage.setItem(SKIP_PREFIX + siteId, JSON.stringify(cur.slice(-500)));
    } catch (e) { /* per-viewer convenience only */ }
  }

  async function afterSave(opts) {
    if (!opts || !opts.assetId || typeof buildOverlay !== "function") return;
    if (typeof permAtLeast === "function" && !permAtLeast("deviceMap", "write")) return;
    var after = parseCodes(opts.after);
    if (!askableChains(after).length) return;
    var siteId = opts.siteId || null;
    var views = null;
    try {
      var res = await api.map.assetRegionViews(opts.assetId);
      if (!siteId) siteId = res.siteId;
      if (res.siteId === siteId) views = res.views;
    } catch (e) { /* lookup failed: nothing to offer */ }
    if (!siteId) return;
    if (!views) {
      try {
        views = (await api.map.topologyViews(siteId)).filter(function (v) { return v.mode === "rack" || v.mode === "wall"; });
      } catch (e) { return; }
    }
    var regions = newRegions(opts.before, opts.after, views, skippedSet(siteId));
    if (!regions.length) return;
    openDialog(siteId, regions, views, opts.assetName || "this device", opts.onDone);
  }

  function openDialog(siteId, regions, views, assetName, onDone) {
    var rows = regions.map(function (r, i) {
      var name = r.codes[r.level];
      var label = ASK_LEVELS[r.level] + " " + name;
      var opts = [
        '<option value="new:wall">Create a Wall view “' + esc(label) + '”</option>',
        '<option value="new:rack">Create a Rack view “' + esc(label) + '”</option>',
      ].concat(views.map(function (v) {
        return '<option value="map:' + esc(v.id) + '">Map to ' + esc(v.mode === "rack" ? "Rack" : "Wall") + ' view: ' + esc(v.name) +
          (v.region ? " (replaces its region)" : "") + '</option>';
      })).concat(['<option value="skip">Don’t map</option>']);
      // A junction box or rack reads as a wall first; a room as a rack.
      if (r.level === "room") opts = [opts[1], opts[0]].concat(opts.slice(2));
      return '<div style="display:contents">' +
        '<span style="display:flex;flex-direction:column"><strong>' + esc(label) + '</strong><code style="font-size:0.75rem;color:var(--color-text-secondary)">' + esc(chainText(r.codes)) + '</code></span>' +
        '<select data-region-choice="' + i + '" aria-label="View for ' + esc(label) + '">' + opts.join("") + '</select></div>';
    }).join("");
    var body =
      '<p style="margin:0 0 12px">' + esc(assetName) + '’s description names ' + regions.length + ' region' + (regions.length === 1 ? "" : "s") +
      ' no Wall or Rack view stands for yet. Choose a view for each, or leave it unmapped. The description is already saved.</p>' +
      '<div style="display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr);gap:10px 16px;align-items:center">' + rows + '</div>' +
      '<p class="hint" style="margin:12px 0 0">Room, rack and junction box regions map to a Wall or Rack view. Areas, buildings and floors are drawn on the Topology and Layer 2 maps.</p>';
    var footer = '<button type="button" class="btn btn-secondary" data-rvp="skip">Not now</button>' +
      '<button type="button" class="btn btn-primary" data-rvp="ok">Save and map</button>';
    var dlg = buildOverlay(1100, "New regions in the description", body, footer);
    dlg.overlay.querySelector('[data-rvp="skip"]').addEventListener("click", dlg.close);
    var okBtn = dlg.overlay.querySelector('[data-rvp="ok"]');
    okBtn.addEventListener("click", async function () {
      okBtn.disabled = true;
      var made = 0, mapped = 0, failed = [];
      for (var i = 0; i < regions.length; i++) {
        var r = regions[i];
        var choice = dlg.overlay.querySelector('[data-region-choice="' + i + '"]').value;
        var label = ASK_LEVELS[r.level] + " " + r.codes[r.level];
        try {
          if (choice === "skip") rememberSkip(siteId, chainKey(r.codes));
          else if (choice.indexOf("new:") === 0) {
            await api.map.createTopologyView(siteId, { name: label, mode: choice.slice(4), region: r.codes });
            made++;
          } else if (choice.indexOf("map:") === 0) {
            await api.map.updateTopologyView(siteId, choice.slice(4), { region: r.codes });
            mapped++;
          }
        } catch (err) {
          failed.push(label + " — " + (err && err.message ? err.message : String(err)));
        }
      }
      dlg.close();
      if ((made || mapped) && typeof onDone === "function") { try { onDone(); } catch (e) { /* caller's refresh */ } }
      if (typeof showToast === "function") {
        if (failed.length) showToast("Some regions were not mapped: " + failed.join("; "), "error");
        else if (made || mapped) showToast((made ? made + " view" + (made === 1 ? "" : "s") + " created" : "") + (made && mapped ? ", " : "") + (mapped ? mapped + " mapped" : ""));
      }
    });
  }

  window.PolarisRegionViewPrompt = {
    afterSave: afterSave,
    // Pure helpers, exported for tests.
    _parseCodes: parseCodes,
    _askableChains: askableChains,
    _newRegions: newRegions,
    _chainKey: chainKey,
  };
})();
