/**
 * public/js/app-tags.js — Tags: how a registry tag's colour is painted (tagColorCss / tagHueStyle /
 * the severity references), the tag cache, and the tag picker field.
 *
 * Part of the app.js shell (CQ-F051): plain browser scripts sharing page
 * globals, loaded on every app page in APP_FILES order (app.js first,
 * app-boot.js last). See tests/unit/appSplit.test.ts.
 */

// ─── Tag colours ────────────────────────────────────────────────────────────
function randomTagColor() {
  var palette = ["#4fc3f7","#4ade80","#f59e0b","#f472b6","#a78bfa","#fb923c","#38bdf8","#34d399","#e879f9","#facc15","#f87171","#2dd4bf","#818cf8","#c084fc"];
  return palette[Math.floor(Math.random() * palette.length)];
}

// A tag's stored color is either a hex or a SEVERITY REFERENCE ("severity:warning").
// A reference resolves to the same theme token the severity bands paint with
// (PolarisChartSeverity's SEV_COLOR — keep the two maps in step), so a Priority tag
// reads exactly as its severity does on every theme. A fixed hex cannot: the
// --color-sev-* palette is retuned per theme (styles.css :root + daylight block).
var TAG_SEVERITY_COLORS = {
  notice: "var(--color-sev-notice)",
  informational: "var(--color-sev-informational)",
  warning: "var(--color-sev-warning)",
  serious: "var(--color-sev-serious)",
  critical: "var(--color-sev-critical)",
};
var TAG_SEVERITY_ORDER = ["notice", "informational", "warning", "serious", "critical"];

/** The severity a stored tag color references, or null for a plain hex. */
function tagColorSeverity(color) {
  var m = /^severity:([a-z]+)$/.exec(String(color || ""));
  return m && TAG_SEVERITY_COLORS[m[1]] ? m[1] : null;
}

/** A stored tag color as a CSS color — a hex, or the severity's theme token.
 *  Anything else (a malformed value) comes back empty so no caller writes it
 *  into a style attribute. */
function tagColorCss(color) {
  var sev = tagColorSeverity(color);
  if (sev) return TAG_SEVERITY_COLORS[sev];
  return /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/.test(String(color || "")) ? color : "";
}

/** That color at `pct`% over transparent — the tint every tag chip draws its
 *  background and border with. color-mix, not a hex alpha suffix, because a
 *  theme token has no hex to append to. */
function tagColorTint(color, pct) {
  var css = tagColorCss(color);
  return css ? "color-mix(in srgb, " + css + " " + pct + "%, transparent)" : "";
}

/** The inline half of a `.hue-pill` (styles.css) for a tag colour: just the
 *  `--hue` custom property, or "" when the colour is unusable. Fill, label and
 *  border all come from the class, which clamps the label's lightness per theme
 *  — never write a stored colour into a chip's `color:` directly, because a
 *  pale one (yellow, white) vanishes on daylight and a deep one on nightfall. */
function tagHueStyle(color) {
  var css = tagColorCss(color);
  return css ? "--hue:" + css : "";
}

// ─── Tag field (enforced or free-text) ─────────────────────────────────────

// `failed` is the difference between "this install has no tags" and "we could
// not find out" — the picker says which, instead of inviting the operator to
// add a tag to a registry it just couldn't read.
var _tagCache = { loaded: false, failed: false, enforce: false, tags: [] };

function _ensureTagCache() {
  if (_tagCache.loaded) return Promise.resolve();
  // ONE read, and deliberately the catalogue route rather than the registry's
  // own GET /server-settings/tags + /tags/settings pair: those sit behind the
  // serverSettingsSystem read floor, which every non-admin built-in role is
  // seeded "none" on, so both calls 403'd and the catch below left the picker
  // claiming the install had no tags.
  return api.serverSettings.tagCatalog().then(function (payload) {
    _tagCache.enforce = !!(payload && payload.enforce === true);
    // The cache feeds the pickers only, so the Arc-owned rows never enter it.
    _tagCache.tags = ((payload && payload.tags) || []).filter(function (t) { return t && !isPickerHiddenTag(t.name); });
    _tagCache.failed = false;
    _tagCache.loaded = true;
  }).catch(function () {
    _tagCache.tags = [];
    _tagCache.failed = true;
    _tagCache.loaded = true;
  });
}

// region: tags are editable like any other tag (2026-08). They used to be a
// hidden "protected prefix" the picker filtered out and force-preserved on
// save, because the add-only reconciler couldn't tell a hand-applied tag from
// its own — but mapRegionService now records provenance (RegionTagAssignment),
// so a tag added here is operator-owned and never auto-stripped, and removing
// an auto-applied one on an in-region device just re-adds it next reconcile.
// The Map Regions category carries a hint saying exactly that.
var REGION_TAG_CATEGORY = "Map Regions";

// Class + inline style for one tag chip. Selected/unselected must be tellable
// apart at a glance for ANY tag color, so the distinction rides three channels
// — an unselected chip (.hue-off) dims its border and text as well as its
// background; a selected one (.hue-strong) carries a full border. Background
// alpha alone (the old 44-vs-11 split) left every chip's full-strength border +
// text looking equally "on" in a dark theme. A chip with no usable colour gets
// neither, and keeps the plain .tag-picker-chip look.
function _tagChipHue(color, checked) {
  var style = tagHueStyle(color);
  if (!style) return { cls: '', style: '' };
  return { cls: ' hue-pill ' + (checked ? 'hue-strong' : 'hue-off'), style: style };
}

// Creating a registry tag is gated write (the top rung) on serverSettingsSystem; a failed
// catalogue read also means we can't offer it (we'd be adding to a list we
// couldn't show).
function _canCreateRegistryTags() {
  if (_tagCache.failed) return false;
  // The registry is the Tags key's (2026-11-03) — the same grant as assigning.
  return typeof permAtLeast === "function" && permAtLeast("tags", "write");
}

/**
 * Build tag field HTML. Call _ensureTagCache() before using this.
 * selected: array of currently selected tag names
 */
function _renderTagChips(selected) {
  var cats = {};
  var registered = {};
  _tagCache.tags.forEach(function (t) {
    var cat = t.category || "General";
    if (!cats[cat]) cats[cat] = [];
    cats[cat].push(t);
    registered[t.name] = true;
  });
  var catNames = Object.keys(cats).sort();
  var html = '';
  // Tags the item carries that have no registry row — discovery's own tags
  // (azurearc, auto-discovered, arc-*, fortiswitch, entraid…), or ones applied
  // before the registry had a row for them. getTagFieldValue reads only the
  // rendered checkboxes, so a tag with no chip was silently DROPPED on every
  // save of the edit form. They render ticked in their own group instead:
  // kept unless the operator unticks one.
  var unlisted = selected.filter(function (name, i) {
    return !registered[name] && !isPickerHiddenTag(name) && selected.indexOf(name) === i;
  });

  if (_tagCache.tags.length === 0 && unlisted.length === 0) {
    html += '<p class="hint" style="margin:0">' + (
      _tagCache.failed
        ? 'Could not load the tag list. Reload the page to try again.'
        : (_canCreateRegistryTags()
            ? 'No tags defined yet. Use the form below to add one.'
            : 'No tags defined yet. An administrator adds them under Server Settings → Tags.')
    ) + '</p>';
  } else {
    catNames.forEach(function (cat) {
      html += '<div class="tag-picker-category">' +
        '<span class="tag-picker-cat-label">' + escapeHtml(cat) + '</span>';
      cats[cat].forEach(function (t) {
        html += _tagChipHTML(t.name, t.color, selected.indexOf(t.name) !== -1);
      });
      if (cat === REGION_TAG_CATEGORY) {
        // These are also written by the Device Map region reconciler; say what
        // an edit here actually does so a re-appearing tag isn't a mystery.
        html += '<p class="hint" style="flex-basis:100%;margin:2px 0 0">' +
          'Region tags are auto-applied to devices inside a Device Map region — removing one from a device still in the region re-adds it on the next reconcile. A tag you add here yourself is never auto-removed.' +
        '</p>';
      }
      html += '</div>';
    });
    if (unlisted.length > 0) {
      html += '<div class="tag-picker-category">' +
        '<span class="tag-picker-cat-label">Not in tag list</span>';
      unlisted.forEach(function (name) { html += _tagChipHTML(name, '', true); });
      html += '<p class="hint" style="flex-basis:100%;margin:2px 0 0">' +
        'Added by discovery or before the tag list had them. Kept on save unless you untick one — a discovery tag you untick comes back on the next run.' +
      '</p></div>';
    }
  }
  return html;
}

// `azure:` tags belong to the Azure Arc sync (it strips and re-adds every one
// each run) and are left OUT of the tag picker — no chip, ticked or not — so
// an operator can never put an Azure tag on a device whose Arc resource does
// not carry it. Every other surface (lists, details, filters, search) still
// shows them. The server keeps an asset's `azure:` tags through every operator
// write (withArcOwnedTags in src/utils/tagNormalize.ts), which is what lets the
// edit form save a tag list without them.
var AZURE_TAG_PREFIX = "azure:";

/** True for a tag the picker never offers (the Arc-owned `azure:` namespace). */
function isPickerHiddenTag(name) {
  return String(name == null ? "" : name).toLowerCase().indexOf(AZURE_TAG_PREFIX) === 0;
}

function _tagChipHTML(name, color, checked) {
  var hue = _tagChipHue(color, checked);
  return '<label class="tag-picker-chip' + (checked ? ' selected' : '') + hue.cls + '" style="' + hue.style + '">' +
    '<input type="checkbox" name="f-tags-cb" value="' + escapeHtml(name) + '"' + (checked ? ' checked' : '') + '>' +
    escapeHtml(name) +
  '</label>';
}

function tagFieldHTML(selected, opts) {
  selected = selected || [];
  opts = opts || {};

  // Putting a tag on a record is the Tags key's grant, whatever the record's
  // own key says (business rule 141: a tag is write reach for everyone who
  // holds it). Without it the field is the static read-only rendering below,
  // and the form posts the tags back unchanged — which the server's
  // tag-change check lets through.
  var mayEditTags = typeof canManageTags !== "function" || canManageTags();

  // Read-only: render selected tags as static badges, no checkboxes or "add new" row.
  if (opts.readOnly || !mayEditTags) {
    // Every tag the record carries is SHOWN, `azure:` ones included (the
    // read-only view is the one place they are visible). What is POSTED back
    // leaves them out, as the editable picker does: they are the Arc sync's
    // and `withArcOwnedTags` keeps them server-side.
    var visibleSelected = selected;
    var roHint = (!opts.readOnly && !mayEditTags)
      ? '<p class="hint">Changing tags needs Read-Write on Tags.</p>'
      : '';
    if (visibleSelected.length === 0) {
      return '<div class="form-group"><label>Tags</label><p style="color:var(--color-text-tertiary);margin:0">—</p>' + roHint + '</div>';
    }
    var tagsByName = {};
    _tagCache.tags.forEach(function (t) { tagsByName[t.name] = t; });
    var chips = visibleSelected.map(function (name) {
      var t = tagsByName[name];
      var hue = _tagChipHue(t && t.color ? t.color : '', true);
      // The hidden checked box keeps the collector (collectTagField) posting
      // the tags the record already carries, so a save from a form that may
      // not edit tags is "unchanged", not "cleared".
      return '<span class="tag-picker-chip selected' + hue.cls + '" style="' + hue.style + '">' +
        (isPickerHiddenTag(name) ? '' : '<input type="checkbox" name="f-tags-cb" value="' + escapeHtml(name) + '" checked hidden>') +
        escapeHtml(name) +
      '</span>';
    }).join('');
    return '<div class="form-group"><label>Tags</label><div class="tag-picker" style="pointer-events:none">' + chips + '</div>' + roHint + '</div>';
  }

  var html = '<div class="form-group"><label>Tags</label>' +
    '<div class="tag-picker" id="f-tags-picker">' +
    _renderTagChips(selected) +
    '</div>';

  // Adding a registry row is a server-settings mutation (POST /server-settings
  // /tags is fullwrite-gated), so only offer it to a caller who holds that
  // grant — the users.js picker's posture. Everyone else got a "+ Add Tag"
  // button whose only outcome was a 403 toast, which read as the tag feature
  // being broken rather than as not theirs.
  if (!_tagCache.enforce && _canCreateRegistryTags()) {
    var catOptions = '';
    var seenCats = {};
    _tagCache.tags.forEach(function (t) {
      var c = t.category || "General";
      if (!seenCats[c]) { seenCats[c] = true; catOptions += '<option value="' + escapeHtml(c) + '">'; }
    });

    html += '<div class="tag-add-row" id="f-tags-add-row" style="display:flex;gap:6px;align-items:center;margin-top:6px">' +
      '<input type="text" id="f-tag-new-name" placeholder="Tag name" style="flex:1;min-width:0">' +
      '<input type="text" id="f-tag-new-cat" list="f-tag-cat-list" placeholder="Category" style="width:120px">' +
      '<datalist id="f-tag-cat-list">' + catOptions + '</datalist>' +
      '<input type="color" id="f-tag-new-color" value="' + randomTagColor() + '" title="Tag color" style="width:36px;height:36px;padding:2px;border:1px solid var(--color-border);border-radius:var(--radius-md);cursor:pointer">' +
      '<button type="button" class="btn btn-sm btn-primary" id="f-tag-add-btn">+ Add Tag</button>' +
      '</div>' +
      '<p class="hint">Select tags above or add new ones</p>';
  }

  html += '</div>';
  return html;
}

/**
 * Read selected tags from the form — works for both enforced and free-text modes.
 */
function getTagFieldValue() {
  var checked = [];
  document.querySelectorAll('input[name="f-tags-cb"]:checked').forEach(function (cb) {
    checked.push(cb.value);
  });
  return checked;
}

/**
 * Wire up tag picker toggle styling after the form is rendered.
 */
function _wireChipListeners(container) {
  container.querySelectorAll('.tag-picker-chip input').forEach(function (cb) {
    cb.addEventListener("change", function () {
      var label = cb.parentElement;
      if (cb.checked) {
        label.classList.add("selected");
      } else {
        label.classList.remove("selected");
      }
      var tag = _tagCache.tags.find(function (t) { return t.name === cb.value; });
      if (tag && tag.color && tagHueStyle(tag.color)) {
        label.classList.toggle("hue-strong", cb.checked);
        label.classList.toggle("hue-off", !cb.checked);
      }
    });
  });
}

function wireTagPicker() {
  var picker = document.getElementById("f-tags-picker");
  if (!picker) return;
  _wireChipListeners(picker);

  var addBtn = document.getElementById("f-tag-add-btn");
  if (!addBtn) return;
  addBtn.addEventListener("click", async function () {
    var nameEl = document.getElementById("f-tag-new-name");
    var catEl = document.getElementById("f-tag-new-cat");
    var colorEl = document.getElementById("f-tag-new-color");
    var name = nameEl.value.trim();
    if (!name) { nameEl.focus(); return; }

    addBtn.disabled = true;
    try {
      var newTag = await api.serverSettings.createTag({
        name: name,
        category: catEl.value.trim() || "General",
        color: colorEl.value || randomTagColor(),
      });
      _tagCache.tags.push(newTag);

      // Get currently selected tags before re-rendering
      var selected = getTagFieldValue();
      selected.push(newTag.name);

      // Re-render chips and re-wire
      picker.innerHTML = _renderTagChips(selected);
      _wireChipListeners(picker);

      // Update category datalist
      var datalist = document.getElementById("f-tag-cat-list");
      if (datalist) {
        var seen = {};
        _tagCache.tags.forEach(function (t) {
          var c = t.category || "General";
          if (!seen[c]) { seen[c] = true; }
        });
        datalist.innerHTML = Object.keys(seen).map(function (c) {
          return '<option value="' + escapeHtml(c) + '">';
        }).join('');
      }

      nameEl.value = "";
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      addBtn.disabled = false;
    }
  });

  // Allow Enter key in the name field to trigger add
  var nameInput = document.getElementById("f-tag-new-name");
  if (nameInput) {
    nameInput.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addBtn.click(); }
    });
  }
}
