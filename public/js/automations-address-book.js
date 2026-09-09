/* global api, escapeHtml, showToast, showConfirm, permAtLeast, buildOverlay */
/**
 * public/js/automations-address-book.js
 *
 * The address book: named email addresses alerts can route to, each optionally
 * owning a set of devices. Two surfaces, one renderer:
 *
 *   1. Automations → Address Book tab — full management (renderTab).
 *   2. A picker opened from the recipient fields in the automation wizard
 *      (openPicker), which resolves the chosen entries back to the caller.
 *
 * LAYERING. openModal reuses ONE shared #modal-overlay and overwrites its body,
 * so calling it from inside the open wizard would destroy the wizard's form DOM
 * (see the comment above showConfirm in app.js). Both surfaces here therefore
 * build their own standalone overlay — the showConfirm / _showMergeReviewModal
 * pattern — at a z-index above the base modal:
 *
 *   1300  picker   (same rung as showConfirm; a confirm opened FROM the picker
 *                   is appended later and so paints above it)
 *   1320  editor   (stacks over the picker, and over nothing on the tab)
 *
 * Unlike _showMergeReviewModal, both restore focus and trap Tab — the two
 * things that instance drops. They also carry the app-wide modal lock (the
 * padlock next to the X, shared with every openModal dialog).
 */
(function () {
  var Z_PICKER = 1300;
  var Z_EDITOR = 1320;

  // ── Device-filter vocabulary ──────────────────────────────────────────────
  // A contact's "devices this contact is responsible for" is the SAME nested
  // AND/OR condition tree the automation wizard's Devices step builds — same
  // module (public/js/condition-builder.js), same stored shape, same server-side
  // evaluator. The flat comma-separated criteria rows this replaced asked the
  // one question in a second language.
  //
  // The vocabulary comes from GET /contacts/filter-schema rather than being
  // written out here: it's the wizard's field set plus the four this surface has
  // always carried (OS version / Department / Location / Behind FortiGate) and a
  // wildcard operator, and a client-side copy is how the builder would come to
  // offer a field the server refuses. `_filterSchema` caches it per page load.
  var _filterSchema = null;

  function loadFilterSchema() {
    if (_filterSchema) return Promise.resolve(_filterSchema);
    return api.contacts.filterSchema().then(function (r) {
      _filterSchema = {
        meta: (r && r.scopeCondition) || { fields: [], groupOps: ["and", "or"], maxDepth: 5 },
        options: (r && r.options) || {},
      };
      return _filterSchema;
    });
  }

  function canWrite() { return permAtLeast("contacts", "write"); }
  function canWriteAny() { return permAtLeast("contacts", "fullwrite"); }
  /** Ownership mirror of the server gate: own rows at write, anyone's at fullwrite. */
  function canEditRow(c) {
    if (canWriteAny()) return true;
    if (!canWrite()) return false;
    return !!c.createdBy && c.createdBy === (window.currentUsername || null);
  }
  /** Is this row owned by the directory sync rather than by an operator? */
  function isSyncedRow(c) {
    return !!c && !!c.origin && c.origin !== "manual";
  }
  /**
   * Taking a synced row out of the sync's hands needs fullwrite, and falls out
   * of the existing gate with no special case: synced rows carry createdBy
   * null, and a write-level caller may only touch rows they created.
   */
  function canAdoptRow(c) {
    return isSyncedRow(c) && canWriteAny();
  }

  // ─── Standalone overlay (the stacked-modal pattern) ────────────────────────

  // buildOverlay now lives in app.js (loaded on every page) so surfaces outside
  // this file — the automations code editor, which the wizard opens on pages that
  // never load the address book — can stack a dialog over an open modal too.

  // ─── Editor (add / edit one contact) ──────────────────────────────────────

  /**
   * Value suggestions per field, from the schema payload — the wizard's
   * scValueOptions with the same `optionsFrom` contract, so a field the server
   * adds to the catalog gets its picker here with no client change.
   */
  function valueOptionsFor(schema) {
    var fields = schema.meta.fields || [];
    var opts = schema.options || {};
    return function (field) {
      var fm = null;
      for (var i = 0; i < fields.length; i++) if (fields[i].field === field) fm = fields[i];
      if (!fm) return [];
      if (fm.values) return fm.values.map(function (v) { return { value: v, label: v }; });
      var plain = function (list) {
        return (list || []).map(function (v) { return { value: v, label: v }; });
      };
      switch (fm.optionsFrom) {
        case "assetTypes":
          return (opts.assetTypes || []).map(function (t) { return { value: t.name, label: t.label || t.name }; });
        case "manufacturers": return plain(opts.manufacturers);
        case "models": return plain(opts.models);
        case "interfaceNames": return plain(opts.interfaceNames);
        case "ssids":          return plain(opts.ssids);
        case "tags": return plain(opts.tags);
        case "subnets":
          return (opts.subnets || []).map(function (sn) { return { value: sn.cidr, label: sn.name + " — " + sn.cidr }; });
        default: return [];
      }
    };
  }

  /**
   * Is this contact responsible for EVERY device? Drives the All-devices
   * checkbox, which is the automations Devices step's control exactly — same
   * default-checked two-state shape, so "which devices?" is asked the same way in
   * both places.
   *
   * A NEW contact starts checked (`c` null). Unchecking reveals the builder, and
   * an empty builder means "no filter" — only the pinned devices below, which is
   * the address-only state most contacts are in. That last part is where contacts
   * differ from automations, where an empty tree with All-assets unchecked is a
   * validation error: an automation must select something to be worth saving,
   * while a contact is perfectly useful as a bare address.
   */
  function allDevicesOf(c) {
    if (!c) return true;
    if (c.assetAllDevices) return true;
    var cond = c.assetConditionEffective || c.assetCondition;
    // The all-devices marker is an empty AND group (true for every asset by
    // boolean identity); anything else is a real filter.
    return !!cond && (cond.children || []).length === 0;
  }

  function editorBodyHtml(c, builder) {
    var allDevices = allDevicesOf(c);
    var stuck = (c && c.assetFilterUnconvertible) || [];
    var cond = (c && (c.assetConditionEffective || c.assetCondition)) || null;
    var root = cond && (cond.children || []).length ? cond : { op: "and", children: [] };
    return '' +
      '<div class="form-group">' +
        '<label for="ab-email">Email address</label>' +
        '<input type="email" class="input" id="ab-email" autocomplete="off" spellcheck="false" ' +
               'placeholder="noc-oncall@example.com" value="' + escapeHtml((c && c.email) || "") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="ab-name">Name</label>' +
        '<input type="text" class="input" id="ab-name" maxlength="200" ' +
               'placeholder="NOC On-Call rotation" value="' + escapeHtml((c && c.name) || "") + '">' +
        '<p class="hint">What the recipient picker shows instead of the raw address.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="ab-desc">Description</label>' +
        '<textarea class="input" id="ab-desc" rows="2" maxlength="1000" ' +
                  'placeholder="Rotates weekly; paged for anything at the Ashfield plant">' + escapeHtml((c && c.description) || "") + '</textarea>' +
      '</div>' +
      '<div class="section-block">' +
        '<div class="section-label">Devices this contact is responsible for</div>' +
        '<p class="hint" style="margin-top:0">An automation whose Notify action routes to ' +
          '“the contacts responsible for the triggering device” reaches this address for any device below. ' +
          'Pinned devices are added on top of whatever the filter matches.</p>' +
        '<div class="form-group" style="margin-bottom:0.5rem">' +
          '<label style="font-weight:600"><input type="checkbox" id="ab-all-devices"' + (allDevices ? " checked" : "") + '> All devices</label>' +
          '<p class="hint" style="margin:2px 0 0 24px">Every device in the inventory, including ones discovered later. ' +
            'Uncheck to filter which devices this contact is responsible for — leave the filter empty and only the pinned devices below count.</p>' +
        '</div>' +
        '<div id="ab-filter-wrap"' + (allDevices ? ' style="display:none"' : "") + '>' +
          (stuck.length
            ? '<p class="hint" style="color:var(--color-warning);margin:0 0 8px">This contact’s filter uses ' +
                escapeHtml(stuck.join(", ")) + ', which this builder can’t show. It still applies — ' +
                'saving without adding conditions below leaves it exactly as it is.</p>'
            : "") +
          '<p class="hint" style="margin:0 0 8px">Drag the <span class="aw-grip" style="cursor:default">&#x2842;</span> handle to move a condition into another group or reorder groups.</p>' +
          '<div id="ab-cond-root">' + builder.groupHtml(root, 0) + '</div>' +
        '</div>' +
        '<div class="form-group" style="margin-top:12px">' +
          '<label>Pinned devices</label>' +
          '<div id="ab-pins"></div>' +
          '<div style="display:flex;gap:6px;align-items:center;margin-top:6px">' +
            '<input type="text" class="input" id="ab-pin-search" style="flex:1" autocomplete="off" ' +
                   'placeholder="Search a device by hostname or IP to pin…">' +
          '</div>' +
          '<div id="ab-pin-results" class="hint"></div>' +
        '</div>' +
        '<div class="form-group" style="margin-top:12px">' +
          '<label>Devices covered right now</label>' +
          '<div id="ab-preview" class="hint">—</div>' +
        '</div>' +
      '</div>';
    // No datalists: the builder's value control is the shared click-to-suggest
    // combobox, fed by /contacts/filter-schema. (A <datalist> was tried in the
    // wizard and confirmed nothing — see polaris-ui-canon → "Don't use `<datalist>`".)
  }

  /**
   * Add/edit modal. `contact` null = create. Resolves to the saved contact, or
   * null if the operator dismissed it.
   */
  async function openEditor(contact) {
    // The vocabulary has to be in hand BEFORE the body is assembled: the builder
    // renders its field/operator selects from it, and the wizard's own comment
    // says the same about creating its instance above the modal call.
    var schema;
    try {
      schema = await loadFilterSchema();
    } catch (err) {
      showToast((err && err.message) || "Couldn’t load the device-filter options", "error");
      return null;
    }
    return new Promise(function (resolve) {
      var pins = ((contact && contact.assetIds) || []).slice();
      var pinLabels = {};
      var settled = null;
      // A legacy filter this builder can't render is carried through the save
      // untouched (see the warning in the body) rather than being replaced by
      // whatever the empty tree collects to.
      var stuckCriteria = ((contact && (contact.assetFilterUnconvertible || []).length) && contact.assetCriteria) || null;

      var CB = window.PolarisConditionBuilder;
      var condBuilder = CB.create({
        meta: schema.meta,
        valueOptions: valueOptionsFor(schema),
        onChange: function () { refreshPreview(); },
      });

      var ui = buildOverlay(
        Z_EDITOR,
        contact ? "Edit contact" : "Add contact",
        editorBodyHtml(contact, condBuilder),
        '<button class="btn btn-secondary" type="button" data-ab="cancel">Cancel</button>' +
        '<button class="btn btn-primary" type="button" data-ab="save">' + (contact ? "Save" : "Add contact") + '</button>',
        function () { resolve(settled); },
        true,
      );
      var root = ui.dialog;

      function q(sel) { return root.querySelector(sel); }

      // ── Device filter (the shared condition tree) ──
      // Read the checkbox by PROPERTY rather than with a `:checked` selector:
      // happy-dom resolves `:checked` from the attribute, so a selector here
      // would make the DOM tests assert the engine's behaviour instead of ours
      // (the same trap as <option selected> — see polaris-ui-canon → "Nested condition tree").
      function allDevicesChecked() {
        var cb = q("#ab-all-devices");
        return !!(cb && cb.checked);
      }

      /** The device-ownership half of the request body. */
      function filterBody() {
        if (allDevicesChecked()) return { assetAllDevices: true, assetIds: pins };
        var rootGroup = root.querySelector("#ab-cond-root > .scg-group");
        var tree = rootGroup ? condBuilder.collect(rootGroup) : null;
        if (tree && (tree.children || []).length) return { assetCondition: tree, assetIds: pins };
        // Unchecked with nothing built: preserve a legacy blob we couldn't
        // render, else there is simply no filter — only the pins.
        return stuckCriteria ? { assetCriteria: stuckCriteria, assetIds: pins } : { assetIds: pins };
      }

      var allCb = q("#ab-all-devices");
      if (allCb) {
        allCb.addEventListener("change", function () {
          q("#ab-filter-wrap").style.display = allCb.checked ? "none" : "";
          // Revealed empty: seed a starter row so the operator lands on something
          // editable (the wizard's All-assets untick does the same).
          if (!allCb.checked) condBuilder.seedIfEmpty(q("#ab-cond-root"));
          refreshPreview();
        });
      }

      // Rows, groups, the value combobox and the grip drag all live in the
      // shared module; the preview debounce rides its onChange.
      condBuilder.wire(root, "#ab-cond-root");

      // ── Pinned devices ──
      function renderPins() {
        var box = q("#ab-pins");
        if (!pins.length) { box.innerHTML = '<p class="hint" style="margin:0">No pinned devices.</p>'; return; }
        box.innerHTML = '<div class="tag-chip-list">' + pins.map(function (id) {
          return '<span class="tag-chip">' + escapeHtml(pinLabels[id] || id) +
            '<button type="button" class="tag-chip-delete" data-ab-unpin="' + escapeHtml(id) + '" ' +
            'aria-label="Remove pinned device">&times;</button></span>';
        }).join("") + '</div>';
      }
      root.addEventListener("click", function (ev) {
        var b = ev.target.closest && ev.target.closest("[data-ab-unpin]");
        if (!b) return;
        var id = b.getAttribute("data-ab-unpin");
        pins = pins.filter(function (x) { return x !== id; });
        renderPins();
        refreshPreview();
      });

      var pinTimer = null;
      q("#ab-pin-search").addEventListener("input", function () {
        var term = this.value.trim();
        clearTimeout(pinTimer);
        var out = q("#ab-pin-results");
        if (term.length < 2) { out.innerHTML = ""; return; }
        pinTimer = setTimeout(function () {
          api.assets.list({ search: term, limit: 8 }).then(function (r) {
            var rows = (r && r.assets) || [];
            if (!rows.length) { out.innerHTML = "No matching devices."; return; }
            out.innerHTML = rows.map(function (a) {
              return '<div><button type="button" class="btn btn-secondary btn-sm" style="margin:2px 0" ' +
                'data-ab-pin="' + escapeHtml(a.id) + '" data-ab-pin-label="' + escapeHtml(a.hostname || a.ipAddress || a.id) + '">+ ' +
                escapeHtml(a.hostname || "(no hostname)") + (a.ipAddress ? " — " + escapeHtml(a.ipAddress) : "") +
                '</button></div>';
            }).join("");
          }).catch(function () { out.innerHTML = "Device lookup failed."; });
        }, 250);
      });
      root.addEventListener("click", function (ev) {
        var b = ev.target.closest && ev.target.closest("[data-ab-pin]");
        if (!b) return;
        var id = b.getAttribute("data-ab-pin");
        if (pins.indexOf(id) === -1) pins.push(id);
        pinLabels[id] = b.getAttribute("data-ab-pin-label");
        renderPins();
        refreshPreview();
        q("#ab-pin-search").value = "";
        q("#ab-pin-results").innerHTML = "";
      });

      // ── Live preview ──
      var previewTimer = null;
      function refreshPreview() {
        clearTimeout(previewTimer);
        var el = q("#ab-preview");
        if (!el) return;
        var body = filterBody();
        if (!body.assetCondition && !body.assetCriteria && !body.assetAllDevices && !pins.length) {
          el.textContent = "No devices — this contact is address-only.";
          return;
        }
        el.textContent = "Checking…";
        previewTimer = setTimeout(function () {
          api.contacts.preview(body).then(function (r) {
            var n = r.matchCount || 0;
            var un = r.unmonitoredCount || 0;
            // The unmonitored remainder is stated, not hidden: the filter does
            // cover those devices, so the contact is on the hook for them —
            // but no automation fires about a device Polaris isn't polling, so
            // the note says which half can actually reach this recipient.
            var extra = un
              ? ' <span class="hint">(+' + un + " unmonitored device" + (un === 1 ? "" : "s") + " covered, but automations never fire on those)</span>"
              : "";
            if (!n) {
              el.innerHTML = un
                ? "No monitored devices match." + extra
                : "No devices match.";
              return;
            }
            var names = (r.sample || []).slice(0, 8).map(function (a) { return a.hostname || a.ipAddress || a.id; });
            el.innerHTML = '<strong>' + n + '</strong> monitored device' + (n === 1 ? "" : "s") + " — " +
              escapeHtml(names.join(", ")) + (n > names.length ? ", …" : "") + extra;
          }).catch(function (err) { el.textContent = (err && err.message) || "Preview failed."; });
        }, 400);
      }

      renderPins();
      refreshPreview();

      // ── Save ──
      root.querySelector('[data-ab="cancel"]').addEventListener("click", function () { ui.close(); });
      root.querySelector('[data-ab="save"]').addEventListener("click", async function () {
        var btn = this;
        var filter = filterBody();
        var body = {
          email: q("#ab-email").value.trim(),
          name: q("#ab-name").value.trim() || null,
          description: q("#ab-desc").value.trim() || null,
        };
        Object.keys(filter).forEach(function (k) { body[k] = filter[k]; });
        if (!body.email) { showToast("Enter an email address", "error"); return; }
        // Same words wherever the builder is used — validate() moved into the
        // shared module for exactly this.
        if (body.assetCondition) {
          var problem = condBuilder.validate(body.assetCondition);
          if (problem) { showToast(problem, "error"); return; }
        }
        btn.disabled = true;
        try {
          var res = contact
            ? await api.contacts.update(contact.id, body)
            : await api.contacts.create(body);
          settled = res.contact;
          showToast(contact ? "Contact updated" : "Contact added", "success");
          ui.close();
        } catch (err) {
          showToast((err && err.message) || "Save failed", "error");
          btn.disabled = false;
        }
      });
    });
  }

  // ─── Row rendering (shared by the tab and the picker) ─────────────────────

  /** Count the leaf conditions in a tree (groups don't count as conditions). */
  function conditionCount(cond) {
    if (!cond) return 0;
    var n = 0;
    (cond.children || []).forEach(function (child) {
      n += child.op ? conditionCount(child) : 1;
    });
    return n;
  }

  function targetSummary(c) {
    var bits = [];
    var cond = c.assetConditionEffective || c.assetCondition;
    if (cond && (cond.children || []).length === 0) bits.push("all devices");
    else if (cond) {
      var n = conditionCount(cond);
      bits.push(n + " condition" + (n === 1 ? "" : "s"));
    } else if ((c.assetFilterUnconvertible || []).length) {
      // Still matching, just not renderable here — say so rather than "—".
      bits.push("a legacy filter");
    }
    if ((c.assetIds || []).length) {
      bits.push(c.assetIds.length + " pinned device" + (c.assetIds.length === 1 ? "" : "s"));
    }
    return bits.length ? bits.join(" + ") : "—";
  }

  // ─── Shared table renderer (both surfaces) ─────────────────────────────────

  /**
   * ONE table for the tab and the picker. The surfaces differ only in their
   * COLUMNS — the picker adds a checkbox and drops the management columns — so
   * they share the cell builders instead of each writing its own <td> for
   * name/email/description/source and drifting on one of them.
   *
   * `cols` is an ordered list of { label?, width?, cls?, cell(entry) } specs;
   * `cell` returns the cell's INNER html. `hint` is pre-rendered html appended
   * under the table, because each surface decides emptiness differently (the
   * picker's panes always carry their dynamic rows, so `entries.length` is the
   * question there, not the row count).
   */
  function abTable(cols, entries, hint) {
    var head = cols.map(function (c) {
      return "<th" + (c.width ? ' style="width:' + c.width + '"' : "") + ">" + (c.label || "") + "</th>";
    }).join("");
    var body = entries.map(function (en) {
      return "<tr>" + cols.map(function (c) {
        return "<td" + (c.cls ? ' class="' + c.cls + '"' : "") + ">" + (c.cell(en) || "") + "</td>";
      }).join("") + "</tr>";
    }).join("");
    return '<div class="table-wrapper"><table><thead><tr>' + head + "</tr></thead><tbody>" +
      body + "</tbody></table></div>" + (hint || "");
  }

  /** The four cells every address-book row has, whichever surface renders it. */
  var AB_CELLS = {
    name: { label: "Name", width: "220px", cell: function (en) { return escapeHtml(en.name || "—"); } },
    email: { label: "Email", width: "250px", cls: "mono", cell: function (en) { return escapeHtml(en.email || ""); } },
    description: {
      label: "Description",
      cell: function (en) {
        // Two people called "J. Martin" are told apart by their job, not their
        // id, so a synced row with no description of its own shows what the
        // directory knows instead of an empty cell. Derived at RENDER time —
        // storing it would put it in the operator-owned description column,
        // where the next sync would appear to have overwritten their text.
        var text = en.description
          || [en.jobTitle, en.department].filter(function (x) { return !!x; }).join(" — ");
        return escapeHtml(text || "");
      },
    },
    source: { label: "Source", width: "110px", cell: function (en) { return sourceBadge(en.source); } },
    /**
     * How many browsers this ACCOUNT has enrolled for Web Push — the same cell
     * the push-mode picker renders, for the same reason: push is opt-in per
     * browser, so "none" is the single most common reason a push automation is
     * configured correctly and delivers nothing, and it is invisible everywhere
     * else. Zero is called out in the warning colour rather than left blank.
     *
     * A row that is not a Polaris account says so instead of showing 0: an
     * address-book contact and a directory hit are ADDRESSES, and no number of
     * enrolled browsers exists for them to have.
     */
    pushDevices: {
      label: "Push devices",
      width: "120px",
      cell: function (en) {
        if (en.source !== "user") {
          return '<span style="color:var(--color-text-tertiary)" title="Push notifications go to a Polaris ' +
            'account’s enrolled browsers; this row is an address">no Polaris account</span>';
        }
        var n = en.pushDevices || 0;
        return n
          ? escapeHtml(n + " device" + (n === 1 ? "" : "s"))
          : '<span style="color:var(--color-warning)" title="This account has not turned push on in any browser, ' +
            'so a push automation naming it delivers nothing">none</span>';
      },
    },
    /**
     * Where a region sits in the nesting drawn on the Device Map: L1 is an
     * innermost region, and each step up contains the level below it. Shown so
     * the list an operator routes from says which rows are the local teams and
     * which are the divisions above them — the same L1/L2 vocabulary the
     * recipient picker's "Asset's L<n> Region Users" entries use.
     *
     * Blank rather than "L1" when the catalogue couldn't be levelled: claiming
     * everything is innermost would be a statement about the map, not an
     * admission that the derivation failed.
     */
    level: {
      label: "Level",
      width: "80px",
      cell: function (en) { return en.level ? "L" + en.level : "—"; },
    },
  };

  /**
   * The routable TAG rows, built from one filter-schema payload.
   *
   * Every row here names a set of USERS reached by a tag on their scope, so
   * they all read "<tag> Users" — what the operator is choosing is the
   * people, not the label. Two sources, deliberately kept apart because they
   * match differently at fire time:
   *
   *   region → resolveUsersByRegions, which matches User.regionTags ONLY.
   *             Regions come from `options.regions` rather than out of the
   *             registry (where they exist as `region:<name>` in the Map
   *             Regions category) because that list carries the nesting LEVEL
   *             the column shows, and needs no mapRegions:read.
   *   tag    → resolveRecipientUsers, which matches the flattened region-plus-
   *             other scope. `options.tagCatalog` is the registry with the Map
   *             Regions rows already dropped, so a region can't appear twice
   *             under two matching rules.
   *
   * Regions first: they are the older vocabulary and the one the dynamic
   * asset-relative entries above them belong to.
   */
  function tagRoutingEntries(schema) {
    var opts = (schema && schema.options) || {};
    var levels = (opts.regionLevels && opts.regionLevels.byName) || {};
    var regions = (opts.regions || []).map(function (name) {
      return {
        source: "region", id: name, name: name + " Users",
        level: levels[String(name).toLowerCase()],
        description: "Every user tagged with the " + name + " region",
      };
    });
    var tags = (opts.tagCatalog || []).map(function (t) {
      var name = (t && t.name) || String(t || "");
      return {
        source: "tag", id: name, name: name + " Users",
        description: "Every user tagged " + name +
          (t && t.category ? " · " + t.category : ""),
      };
    });
    return regions.concat(tags);
  }

  // ─── Tab surface ───────────────────────────────────────────────────────────

  /**
   * The tab renders the SAME two panes the wizard's picker does — People
   * (searched: contacts, Polaris user accounts and, where the integrations opted
   * in, the org directory) and Regions (browsed) — minus the checkboxes and the
   * Add-to-To/Cc/Bcc footer, which only mean something while composing a Notify
   * action. It previously listed stored contacts alone, so the page an operator
   * opens to ask "who can Polaris email?" answered a narrower question than the
   * modal did.
   *
   * Stored contacts are rendered from GET /contacts rather than out of the
   * search payload, for two things that payload can't carry: the row's
   * `createdBy` and device filter (the Devices + Added by columns, and the
   * per-row ownership check behind Edit/Delete), and completeness — search
   * returns at most 50 deduped hits ordered users-first, so on an install with
   * more than 50 accounts the contacts would fall off the end of the very page
   * that manages them. A search hit whose address a contact already holds is
   * dropped, so one mailbox stays one row.
   */

  // Survives a re-render (the Refresh button, a save from the editor) so the
  // operator's search term isn't silently thrown away under them.
  //
  // `source` is the table's tab: which POPULATION the People pane is listing —
  // all of them, Polaris accounts, one directory, or the contacts added here by
  // hand. `sources` is the directory half of that strip, and comes from the
  // server (which directories feed this book, what they are called, and whether
  // this caller may see them) rather than being guessed at, so a tab can never
  // name a directory whose rows the visibility gate would then withhold.
  var _tab = { term: "", source: "all", sources: [] };

  function tabBodyHtml() {
    return '' +
      '<div class="page-tabs" id="ab-tab-tabs" style="margin-bottom:10px">' +
        '<button type="button" class="page-tab active" data-ab-ttab="people">People</button>' +
        '<button type="button" class="page-tab" data-ab-ttab="tags">Tags</button>' +
      '</div>' +
      '<div data-ab-tpane="people">' +
        '<div class="form-group" style="margin-bottom:8px">' +
          '<input type="text" class="input" id="ab-tab-search" autocomplete="off" spellcheck="false" ' +
                 'placeholder="Search people, contacts and lists…" value="' + escapeHtml(_tab.term) + '">' +
        '</div>' +
        '<div class="table-tabs" id="ab-tab-sources">' + sourceTabsHtml() + '</div>' +
        '<div id="ab-tab-results"><p class="empty-state">Loading…</p></div>' +
      '</div>' +
      '<div data-ab-tpane="tags" style="display:none">' +
        '<p class="hint" style="margin-top:0">Every tag an automation’s <strong>Notify</strong> action can ' +
          'route to, and the users each one reaches. Map regions come from the polygons drawn on the Device Map; ' +
          'the rest are the tag registry. Nothing here is edited on this page — draw or rename a region on the ' +
          'Device Map, manage tags under Server Settings → Identification, and assign either to people with ' +
          '<strong>Assign Tags</strong> under Users. ' +
          '<strong>Level</strong> applies to regions only and follows from how the polygons nest: L1 is an ' +
          'innermost region, and each level above it contains the one below.</p>' +
        '<div id="ab-tab-tags"><p class="empty-state">Loading…</p></div>' +
      '</div>';
  }

  /**
   * The People table's columns for ONE source tab.
   *
   * Two of them are dropped where the tab has already answered them: Source on
   * a single-source tab (a whole column repeating the tab's own name), and the
   * three management columns on the Polaris users tab, where no row is a
   * contact and all three would read "—" for every row. The All tab keeps the
   * full set, because that is the only tab where the columns vary by row.
   */
  function tabPeopleCols(plan) {
    var cols = [AB_CELLS.name, AB_CELLS.email, AB_CELLS.description];
    if (plan.contacts) {
      cols.push({
        // "Responsible for", not "Devices": this column is the contact's device
        // FILTER — which devices an automation routing to "the contacts
        // responsible for the triggering device" reaches them about. It was
        // read as "this person's devices", which is a different question and
        // the one the Push devices column below answers.
        label: "Responsible for",
        width: "180px",
        cell: function (en) { return escapeHtml(en.contact ? targetSummary(en.contact) : "—"); },
      });
    }
    // Only where an account can appear: a Manual or directory tab holds
    // addresses alone, and every cell would read "no Polaris account".
    if (plan.key === "all" || plan.key === "user") cols.push(AB_CELLS.pushDevices);
    if (plan.key === "all") cols.push(AB_CELLS.source);
    if (!plan.contacts) return cols;
    return cols.concat([
      {
        label: "Added by",
        width: "120px",
        cell: function (en) {
          if (isSyncedRow(en.contact)) return '<span class="hint">Directory sync</span>';
          return escapeHtml((en.contact && en.contact.createdBy) || "—");
        },
      },
      {
        width: "120px",
        cell: function (en) {
          if (!en.contact) return "";
          // A synced row is the sync's until someone claims it: Delete would be
          // undone on the next run, so the honest verb is Adopt.
          if (isSyncedRow(en.contact)) {
            return canAdoptRow(en.contact)
              ? '<button class="btn btn-secondary btn-sm" data-ab-adopt="' + escapeHtml(en.contact.id) + '" ' +
                'title="Take ownership of this entry so the directory sync stops updating or removing it">Adopt</button>'
              : "";
          }
          if (!canEditRow(en.contact)) return "";
          return '<button class="btn btn-secondary btn-sm" data-ab-edit="' + escapeHtml(en.contact.id) + '">Edit</button> ' +
            '<button class="btn btn-danger btn-sm" data-ab-del="' + escapeHtml(en.contact.id) + '">Delete</button>';
        },
      },
    ]);
  }

  // How many CONTACT rows one page of the People tab asks for. The server caps
  // at 200 regardless; this is the number the "showing N of M" hint is about.
  var AB_PAGE_SIZE = 50;

  /** The catalogue entry for a directory tab, or null. */
  function directorySource(key) {
    var found = null;
    (_tab.sources || []).forEach(function (s) { if (s.kind === key) found = s; });
    return found;
  }

  /**
   * The tab strip over the People table: All / Polaris users / one tab per
   * directory / Manual.
   *
   * Tabs rather than the three Curated / Directory / All chips they replace,
   * because "the address book" is not one list — it is Polaris accounts, the
   * rows an operator typed in, and each directory's roster, three populations
   * that are managed differently and answer different questions. The chips
   * could only split the CONTACTS half, so the accounts and the live directory
   * hits sat in every slice regardless.
   *
   * A directory tab is named after the integration that feeds it (its product
   * name when two integrations of one kind share the backend), because "the
   * directory" is not what an operator calls it.
   */
  function sourceTabs() {
    var tabs = [
      { key: "all", label: "All", title: "Everyone and everywhere Polaris can send an alert" },
      { key: "user", label: "Polaris users", title: "Accounts on this Polaris install that carry an email address" },
    ];
    (_tab.sources || []).forEach(function (s) {
      tabs.push({
        key: s.kind,
        // "<name> directory" unless the operator already put the word in the
        // integration's name, where it would read "… Directory directory".
        label: /director(y|ies)/i.test(s.label) ? s.label : s.label + " directory",
        title: s.sync
          ? "People synced into the address book from " + s.label
          : "People looked up live in " + s.label + " — nothing from it is stored in Polaris",
      });
    });
    tabs.push({ key: "manual", label: "Manual", title: "Contacts added here by hand" });
    return tabs;
  }

  function sourceTabsHtml() {
    return '<div class="table-tabs-list" role="tablist" aria-label="Address book sources">' +
      sourceTabs().map(function (t) {
        var on = _tab.source === t.key;
        return '<button type="button" class="table-tab' + (on ? " active" : "") + '" role="tab" ' +
          'aria-selected="' + (on ? "true" : "false") + '" title="' + escapeHtml(t.title) + '" ' +
          'data-ab-source="' + escapeHtml(t.key) + '">' +
          '<span class="table-tab-name">' + escapeHtml(t.label) + "</span></button>";
      }).join("") + "</div>";
  }

  /**
   * What ONE tab is made of: which halves to fetch, what to ask the contacts
   * endpoint for, and which search hits belong here.
   *
   * Each tab is a QUERY rather than a client-side filter over one merged list,
   * because the contacts half is paginated: filtering 50 mixed rows down to the
   * synced ones would show a fraction of them and call it the directory. It
   * also keeps the tabs honest about cost — Manual asks the directory nothing,
   * and Polaris users never fans out to the GAL.
   */
  function tabPlan(key) {
    if (key === "user") {
      return { key: key, contacts: false, search: true, live: false,
        keep: function (en) { return en.source === "user"; } };
    }
    if (key === "manual") return { key: key, contacts: true, origin: "manual", search: false };
    if (key === "all") return { key: key, contacts: true, origin: "all", search: true, live: true, keep: null };
    // A directory: its synced rows, plus what a live lookup finds in it.
    return { key: key, contacts: true, origin: key, search: true, live: true,
      keep: function (en) { return en.source === key; } };
  }

  /**
   * Refresh the strip from what the list endpoint reported. Returns true when
   * the ACTIVE tab was a directory that has since gone away (integration
   * disabled, or the caller lost the visibility gate) and has been reset to
   * All — the caller reloads, because the rows on screen are for a tab that no
   * longer exists.
   */
  function syncSourceTabs(payload) {
    var next = (payload && payload.directoryVisible && payload.directorySources) || [];
    var same = next.length === _tab.sources.length && next.every(function (s, i) {
      return s.kind === _tab.sources[i].kind && s.label === _tab.sources[i].label && !!s.sync === _tab.sources[i].sync;
    });
    var reset = false;
    if (!same) {
      _tab.sources = next.map(function (s) {
        return { kind: s.kind, label: s.label || s.kind, sync: !!s.sync, search: !!s.search };
      });
      if (_tab.source !== "all" && _tab.source !== "user" && _tab.source !== "manual" && !directorySource(_tab.source)) {
        _tab.source = "all";
        reset = true;
      }
      var slot = document.getElementById("ab-tab-sources");
      if (slot) slot.innerHTML = sourceTabsHtml();
    }
    return reset;
  }

  async function loadTabPeople() {
    var box = document.getElementById("ab-tab-results");
    if (!box) return;
    var term = _tab.term;
    var plan = tabPlan(_tab.source);
    var contacts = [];
    var entries = [];
    var capped = false;
    var total = 0;
    try {
      // The search term goes to the SERVER for both halves. This used to pull
      // every contact and filter in the browser, which made each keystroke cost
      // the whole table.
      var res = await Promise.all([
        plan.contacts ? api.contacts.list({ q: term, origin: plan.origin, limit: AB_PAGE_SIZE }) : null,
        plan.search ? api.contacts.search(term, !!plan.live) : null,
      ]);
      if (res[0]) {
        contacts = res[0].contacts || [];
        total = typeof res[0].total === "number" ? res[0].total : contacts.length;
        // The strip is refreshed from whichever load carried the catalogue.
        // The Polaris users tab makes no list call and so learns nothing — it
        // renders the strip the last load left, which is the one the initial
        // All load built.
        if (syncSourceTabs(res[0])) return loadTabPeople();
      }
      var found = (res[1] && res[1].entries) || [];
      // The 50-row cap the "showing the first 50" hint is about is the SERVER's,
      // so it is counted BEFORE this tab drops the hits belonging to another
      // source — otherwise a capped payload whose rows were mostly not this
      // tab's would read as a complete answer.
      capped = found.length >= 50;
      entries = found.filter(plan.keep || function () { return true; });
    } catch (err) {
      if (term !== _tab.term) return;
      box.innerHTML = '<p class="empty-state">' +
        escapeHtml((err && err.message) || "Failed to load the address book") + "</p>";
      return;
    }
    if (term !== _tab.term) return; // a later keystroke already owns the pane

    // Contacts first, and a search hit sharing one of their addresses drops:
    // the contact row is the manageable one, and the picker's own dedupe
    // already treats one mailbox as one entry.
    var held = {};
    contacts.forEach(function (c) { held[String(c.email || "").toLowerCase()] = true; });
    var rows = contacts.map(function (c) {
      return {
        // A synced row badges as the directory it came from, which is why
        // Contact.origin stores the backend name: it drops straight into the
        // same `source` vocabulary sourceBadge already understands.
        source: c.origin && c.origin !== "manual" ? c.origin : "contact",
        id: c.id, email: c.email, name: c.name,
        description: c.description, jobTitle: c.jobTitle, department: c.department,
        kind: c.kind === "group" ? "group" : "person", contact: c,
      };
    }).concat(entries.filter(function (en) {
      return !en.email || !held[String(en.email).toLowerCase()];
    }));

    // Every note the pane has to make, in one place: each tab is a different
    // population, so an empty one means something different on each.
    var notes = [];
    var ADD_A_CONTACT = "Add a contact to route alerts to an address that has no Polaris account — " +
      "a distribution list, an on-call rotation, a vendor NOC.";
    var src = directorySource(plan.key);
    // The label is the operator's name for their integration and the notes are
    // written into innerHTML — escape it here, once, rather than at each use.
    var srcName = src ? escapeHtml(src.label) : "directory";
    if (!rows.length) {
      if (term) {
        notes.push(plan.key === "all" ? "No people match that search."
          : plan.key === "user" ? "No Polaris account matches that search."
            : plan.key === "manual" ? "No contact added here matches that search."
              : "No " + srcName + " entry matches that search.");
      } else if (plan.key === "user") {
        // An account with no address is not listed anywhere the address book
        // reaches (searchAddressBook skips it), so say where addresses come
        // from rather than implying there are no accounts.
        notes.push("No Polaris account carries an email address — an account is listed here once it has one. " +
          "Addresses are set per account under Users.");
      } else if (plan.key === "manual") {
        notes.push("No contacts have been added here yet. " + ADD_A_CONTACT);
      } else if (src) {
        notes.push(src.sync
          ? "The directory sync hasn’t stored any " + srcName + " entries yet."
          : "Nothing from " + srcName + " is stored in Polaris — search to look someone up in it.");
      } else {
        notes.push("No contacts yet, and no Polaris account carries an email address. " + ADD_A_CONTACT);
      }
    } else {
      if (plan.key === "all" && !term && !contacts.length) {
        // The rows are all Polaris accounts and directory hits. Say what's
        // missing rather than let a populated table imply the address book is
        // set up.
        notes.push("No contacts yet — every row above is a Polaris account. " + ADD_A_CONTACT);
      }
      // A directory that is searched but not synced has NO rows of its own
      // until something is typed; one that is synced still only stores the
      // people the filters let through. Either way the table is not the roster.
      if (src && src.search && !term) {
        notes.push(src.sync
          ? "Search to look anyone up in " + srcName + " — the rows above are only what the sync has stored."
          : "Type at least two characters to look someone up in " + srcName + ".");
      }
      if (plan.contacts && total > contacts.length) {
        // A real count, not a guess from a truncated array: the server reports
        // how many matched across every page, so the operator learns whether
        // narrowing the search will actually help.
        notes.push("Showing " + contacts.length + " of " + total +
          " matching contacts — narrow the search to see the rest.");
      } else if (plan.search && capped) {
        // The users ∪ directory half is still capped at 50 by searchAddressBook.
        notes.push("Showing the first 50 matches — narrow the search to see more.");
      }
    }
    var hint = notes.map(function (n) {
      return '<p class="hint" style="margin:8px 0 0">' + n + "</p>";
    }).join("");
    box.innerHTML = abTable(tabPeopleCols(plan), rows, hint);
  }

  function loadTabTags() {
    var box = document.getElementById("ab-tab-tags");
    if (!box) return;
    var cols = [AB_CELLS.name, AB_CELLS.level, AB_CELLS.description, AB_CELLS.source];
    // Levels and the registry both ride the filter-schema payload — GET
    // /map/regions is gated `mapRegions:read` and GET /server-settings/tags
    // behind `serverSettingsSystem:read`, neither of which someone browsing the
    // address book need hold.
    return loadFilterSchema().then(function (schema) {
      var rows = tagRoutingEntries(schema);
      box.innerHTML = abTable(cols, rows, rows.length ? "" :
        '<p class="hint" style="margin:8px 0 0">No tags or map regions are defined yet — draw regions on the ' +
        'Device Map, or add tags under Server Settings → Identification.</p>');
    }).catch(function (err) {
      box.innerHTML = '<p class="empty-state">' +
        escapeHtml((err && err.message) || "Failed to load the tag catalogue") + "</p>";
    });
  }

  function wireTab(host) {
    host.querySelectorAll("[data-ab-ttab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var want = btn.getAttribute("data-ab-ttab");
        host.querySelectorAll("[data-ab-ttab]").forEach(function (b) { b.classList.toggle("active", b === btn); });
        host.querySelectorAll("[data-ab-tpane]").forEach(function (pane) {
          pane.style.display = pane.getAttribute("data-ab-tpane") === want ? "" : "none";
        });
      });
    });

    var timer = null;
    var search = host.querySelector("#ab-tab-search");
    if (search) {
      search.addEventListener("input", function () {
        _tab.term = this.value.trim();
        clearTimeout(timer);
        timer = setTimeout(function () { loadTabPeople(); }, 250);
      });
    }

    host.addEventListener("click", async function (ev) {
      var stab = ev.target.closest && ev.target.closest("[data-ab-source]");
      if (stab) {
        var want = stab.getAttribute("data-ab-source") || "all";
        if (want === _tab.source) return;
        _tab.source = want;
        var slot = document.getElementById("ab-tab-sources");
        if (slot) slot.innerHTML = sourceTabsHtml();
        // The table is rebuilt from a different query, so blank it rather than
        // leaving the previous tab's rows sitting under the new tab's name.
        var results = document.getElementById("ab-tab-results");
        if (results) results.innerHTML = '<p class="empty-state">Loading…</p>';
        loadTabPeople();
        return;
      }
      var ad = ev.target.closest && ev.target.closest("[data-ab-adopt]");
      if (ad) {
        // Spelled out because it is not obvious from the button: adopting is
        // what makes the entry survive the person leaving the directory, and
        // it is also what stops their details being kept current.
        if (!(await showConfirm(
          "Take ownership of this entry? It will stay in the address book even if the person leaves the " +
          "directory, and the directory sync will stop updating it.",
        ))) return;
        try {
          await api.contacts.adopt(ad.getAttribute("data-ab-adopt"));
          showToast("Entry is now yours to manage", "success");
        } catch (err) { showToast((err && err.message) || "Could not take ownership", "error"); }
        loadTabPeople();
        return;
      }
      var ed = ev.target.closest && ev.target.closest("[data-ab-edit]");
      if (ed) {
        // One row by id. Re-reading the whole list to find it was merely
        // wasteful before; against a paginated list it is also wrong, since the
        // row being edited need not be on the page that was fetched.
        var row = (await api.contacts.get(ed.getAttribute("data-ab-edit"))).contact;
        if (row) { await openEditor(row); loadTabPeople(); }
        return;
      }
      var del = ev.target.closest && ev.target.closest("[data-ab-del]");
      if (del) {
        if (!(await showConfirm("Delete this contact? Automations routing to it will stop reaching that address."))) return;
        try {
          await api.contacts.delete(del.getAttribute("data-ab-del"));
          showToast("Contact deleted", "success");
        } catch (err) { showToast((err && err.message) || "Delete failed", "error"); }
        loadTabPeople();
      }
    });
  }

  /**
   * Paint (or repaint) the tab. The shell is built ONCE — rebuilding it on every
   * load would blur the search box mid-keystroke — and both panes then refresh
   * from the server, so Refresh and a save from the editor land the same way.
   */
  async function renderTab() {
    var host = document.getElementById("contacts-list");
    if (!host) return;
    if (!host._abShell) {
      host.innerHTML = tabBodyHtml();
      host._abShell = true;
      wireTab(host);
    }
    await Promise.all([loadTabPeople(), loadTabTags()]);
  }

  // ─── Picker surface (opened from the wizard's recipient fields) ───────────

  /**
   * The two DYNAMIC recipients — entries that name no address but a RULE for
   * finding one from the triggering device at fire time. They were checkboxes
   * under the wizard's recipient fields, which asked "who gets this?" in two
   * places; here they sit in the same list as everyone else and come back as
   * pills. `id` is fixed because one of each is meaningful.
   *
   * They live in DIFFERENT panes, by what they resolve to: responsible contacts
   * are people out of this very address book, so they head the People list;
   * region users are reached BY a tag on their scope, so they head the Tags
   * list alongside the named regions and registry tags. Each sits
   * at the top of its pane rather than in the results, because it isn't a search
   * hit — it's the standing answer to "whoever owns the device".
   */
  var PEOPLE_DYNAMIC = [
    {
      source: "assetContacts",
      id: "assetContacts",
      name: "Asset’s Responsible Contacts",
      description: "The address-book contacts whose device filter covers the triggering device",
    },
  ];
  var REGION_DYNAMIC = [
    {
      source: "deviceRegion",
      id: "deviceRegion",
      name: "Asset’s Region Users",
      description: "Every user whose region tags match the triggering device’s own region: tag (any level)",
    },
  ];

  /**
   * The dynamic Regions entries for an install whose regions are NESTED: one
   * per asset-relative level, so an operator can put front-line staff on the
   * trigger and the division's managers on the escalation.
   *
   * Offered ONLY when something is actually nested (`maxLevel >= 2`). On a flat
   * catalogue "L1 Region Users" is a synonym for the entry above, and offering
   * it would invite a rule that quietly changes meaning the day someone draws
   * a containing polygon.
   */
  function regionDynamicEntries(maxLevel) {
    var out = REGION_DYNAMIC.slice();
    var top = typeof maxLevel === "number" ? maxLevel : 1;
    if (top < 2) return out;
    for (var n = 1; n <= top; n++) {
      out.push({
        source: "deviceRegionLevel",
        id: "deviceRegionLevel:" + n,
        level: n,
        name: "Asset’s L" + n + " Region Users",
        description: n === 1
          ? "The device’s own most-specific region"
          : "The region " + (n - 1) + " level" + (n - 1 === 1 ? "" : "s") + " out from the device’s own region",
      });
    }
    return out;
  }

  function pickerBodyHtml() {
    return '' +
      // Two tabs rather than one merged list: people are SEARCHED (typeahead over
      // users, contacts and the directory) while tags are BROWSED (a short fixed
      // catalogue), and a search box over a couple of dozen tag names is noise.
      '<div class="page-tabs" id="ab-pick-tabs" style="margin-bottom:10px">' +
        '<button type="button" class="page-tab active" data-ab-tab="people">People</button>' +
        '<button type="button" class="page-tab" data-ab-tab="tags">Tags</button>' +
      '</div>' +
      '<div data-ab-pane="people">' +
        '<div class="form-group" style="margin-bottom:8px">' +
          '<input type="text" class="input" id="ab-pick-search" autocomplete="off" spellcheck="false" ' +
                 'placeholder="Search people, contacts and lists…">' +
        '</div>' +
        '<div id="ab-pick-results"><p class="empty-state">Loading…</p></div>' +
      '</div>' +
      '<div data-ab-pane="tags" style="display:none">' +
        '<p class="hint" style="margin-top:0">Pick a tag to reach every user carrying it, or ' +
          '<strong>Asset’s Region Users</strong>, which resolves from the region of the device that triggered the alert. ' +
          'Where regions are nested, <strong>L1</strong> is the device’s own region and higher levels are the regions ' +
          'that contain it — so L1 reaches the local team and L2 reaches whoever covers the division.</p>' +
        '<div id="ab-pick-tags"><p class="empty-state">Loading…</p></div>' +
      '</div>';
  }

  /**
   * Can a WEB PUSH actually reach this entry? Users, roles, map regions and
   * the region-dynamic entries all resolve to ACCOUNTS, which is what a push
   * subscription hangs off. A contact or a directory hit is a bare address,
   * and `usersForTarget` on the push transport ignores `addresses` entirely —
   * so offering one would let an operator pick a recipient who provably gets
   * nothing, which is the exact failure this picker's device counts exist to
   * make visible.
   */
  function pushReachable(en) {
    return !!en && (en.source === "user" || en.source === "region" || en.source === "tag" ||
      en.source === "deviceRegion" || en.source === "deviceRegionLevel");
  }

  function sourceBadge(src) {
    var label = src === "user" ? "Polaris user"
      : src === "contact" ? "Contact"
        : src === "entra" ? "Entra"
          : src === "region" ? "Region"
            : src === "tag" ? "Tag"
              : (src === "deviceRegion" || src === "deviceRegionLevel" || src === "assetContacts") ? "Dynamic"
                : "Directory";
    return '<span class="badge" style="font-size:0.7rem">' + escapeHtml(label) + "</span>";
  }

  /**
   * Stable selection key. People key on the ADDRESS (so the same mailbox reached
   * as a user and as a contact is one selection, which is what the search's own
   * dedupe already assumes); tag, region and dynamic entries have no address, so
   * they key on source + id — which is also what keeps a registry tag and a
   * same-named region apart, since the two route through different fields.
   */
  function pickKey(e) {
    return e.email ? String(e.email).toLowerCase() : e.source + "|" + e.id;
  }

  /**
   * Address-book picker. `field` is the recipient field it was opened from
   * ("to" | "cc" | "bcc") and comes back on the result so the caller knows
   * where to drop the entries. Resolves { field, entries } or null.
   */
  function openPicker(opts) {
    var field = (opts && opts.field) || "to";
    // PUSH MODE. Opened from a web-push Notify action, whose recipients are
    // ACCOUNTS rather than addresses. Four differences, all of them the same
    // point: an address is not a push endpoint. A "Push devices" column says
    // how many browsers each user actually enrolled (push is opt-in PER
    // BROWSER, so a perfectly reasonable-looking pick can deliver nothing);
    // rows push cannot reach lose their checkbox; the Responsible-Contacts
    // entry and "+ New contact" are withheld; and the footer offers To alone,
    // since a push action has no Cc or Bcc.
    //
    // Counts ride IN from the caller (`pushDevices`, userId -> n) rather than
    // being fetched here: the wizard already holds them on the
    // /automations/recipient-users payload it loaded to build the pills.
    var isPush = !!(opts && opts.mode === "push");
    var pushDevices = (opts && opts.pushDevices) || {};
    return new Promise(function (resolve) {
      var chosen = {};       // pickKey → entry
      var settled = null;
      var entries = [];       // People pane (search results)
      var tagEntries = [];    // Tags pane (one row per map region + registry tag)
      var regionMaxLevel = 1;  // how deep nesting goes — decides the level entries

      var ui = buildOverlay(
        Z_PICKER,
        "Address book",
        pickerBodyHtml(),
        (isPush ? "" : '<button class="btn btn-secondary" type="button" data-ab="new">+ New contact</button>') +
        '<span style="flex:1"></span>' +
        '<button class="btn btn-secondary" type="button" data-ab="add-to">Add to To</button>' +
        (isPush ? "" :
          '<button class="btn btn-secondary" type="button" data-ab="add-cc">Add to Cc</button>' +
          '<button class="btn btn-secondary" type="button" data-ab="add-bcc">Add to Bcc</button>'),
        function () { resolve(settled); },
        true,
      );
      var root = ui.dialog;
      function q(sel) { return root.querySelector(sel); }

      // Highlight the field the picker was opened from so "Add to Cc" from a Cc
      // field is the obvious default without removing the other two.
      var defBtn = root.querySelector('[data-ab="add-' + field + '"]');
      if (defBtn) { defBtn.classList.remove("btn-secondary"); defBtn.classList.add("btn-primary"); }

      /**
       * The picker's columns: the shared four, wrapped in a selection checkbox
       * and an Edit cell. Both panes use them, so a region reads like a person.
       */
      /**
       * The "Push devices" cell. Zero is called out rather than left blank:
       * a user with no enrolled browser is the single most common reason a
       * push automation is configured correctly and still delivers nothing,
       * and it is invisible everywhere else.
       */
      function pushDeviceCell(en) {
        if (en.source === "user") {
          var n = pushDevices[en.id] || 0;
          return n
            ? escapeHtml(n + " device" + (n === 1 ? "" : "s"))
            : '<span style="color:var(--color-warning)">none</span>';
        }
        // A group entry resolves to many accounts at fire time, so a count
        // here would be a guess; an unreachable row says WHY it is unpickable.
        return pushReachable(en)
          ? '<span style="color:var(--color-text-tertiary)">—</span>'
          : '<span style="color:var(--color-text-tertiary)">no Polaris account</span>';
      }

      function pickCols() {
        var cols = [
          {
            width: "36px",
            cell: function (en) {
              // No checkbox on a row push cannot reach — refusing the pick is
              // honest where a warning after the fact is not.
              if (isPush && !pushReachable(en)) return "";
              var key = pickKey(en);
              return '<input type="checkbox" data-ab-pick="' + escapeHtml(key) + '"' +
                (chosen[key] ? " checked" : "") + ">";
            },
          },
          AB_CELLS.name,
          AB_CELLS.email,
          AB_CELLS.description,
          AB_CELLS.source,
          {
            width: "110px",
            cell: function (en) {
              return en.source === "contact" && en.owned !== false && canWrite()
                ? '<button class="btn btn-secondary btn-sm" data-ab-pedit="' + escapeHtml(en.id) + '">Edit</button>'
                : "";
            },
          },
        ];
        // Before Source, so the two columns that say whether this row will
        // actually receive anything sit together.
        if (isPush) cols.splice(4, 0, { label: "Push devices", width: "130px", cell: pushDeviceCell });
        return cols;
      }

      /** The People pane's dynamic head — withheld in push mode, where
       *  "Asset's Responsible Contacts" resolves to addresses with no account
       *  behind them and so reaches nobody over push. */
      function peopleHead() { return isPush ? [] : PEOPLE_DYNAMIC; }

      function render() {
        var box = q("#ab-pick-results");
        // The dynamic entry heads the list unconditionally — it is not a search
        // result, so a query that matches nobody must not hide it.
        var hint = entries.length ? "" : '<p class="hint" style="margin:8px 0 0">No people match that search.</p>';
        if (isPush) {
          hint += '<p class="hint" style="margin:8px 0 0">Push reaches <strong>Polaris accounts</strong>, so ' +
            'contacts and directory hits are listed but not selectable — there is no browser subscription behind ' +
            'an address. A user showing <strong>none</strong> has not turned push on in any browser yet.</p>';
        }
        box.innerHTML = abTable(pickCols(), peopleHead().concat(entries), hint);
      }

      /**
       * The Tags pane: the dynamic entries first — they're what an operator
       * reaches for most, and they need no catalogue at all — then one row per
       * operator-drawn map region, then the tag registry.
       */
      function renderTags() {
        var box = q("#ab-pick-tags");
        if (!box) return;
        box.innerHTML = abTable(
          pickCols(),
          regionDynamicEntries(regionMaxLevel).concat(tagEntries),
          tagEntries.length
            ? ""
            : '<p class="hint" style="margin:8px 0 0">No tags or map regions are defined yet — draw regions on ' +
              'the Device Map, or add tags under Server Settings → Identification.</p>',
        );
      }

      async function load(term) {
        try {
          // `true` = also search the organization's directory (live, not stored).
          entries = (await api.contacts.search(term || "", true)).entries || [];
        } catch (err) {
          q("#ab-pick-results").innerHTML = '<p class="empty-state">' +
            escapeHtml((err && err.message) || "Search failed") + "</p>";
          return;
        }
        render();
      }

      // Tab switching. Both panes stay in the DOM, so the People search term and
      // the current selection survive a look at the Tags list.
      root.querySelectorAll("[data-ab-tab]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var want = btn.getAttribute("data-ab-tab");
          root.querySelectorAll("[data-ab-tab]").forEach(function (b) {
            b.classList.toggle("active", b === btn);
          });
          root.querySelectorAll("[data-ab-pane]").forEach(function (pane) {
            pane.style.display = pane.getAttribute("data-ab-pane") === want ? "" : "none";
          });
        });
      });

      var timer = null;
      q("#ab-pick-search").addEventListener("input", function () {
        var term = this.value.trim();
        clearTimeout(timer);
        timer = setTimeout(function () { load(term); }, 250);
      });

      root.addEventListener("change", function (ev) {
        var cb = ev.target.closest && ev.target.closest("[data-ab-pick]");
        if (!cb) return;
        var key = cb.getAttribute("data-ab-pick");
        // Both panes' pools, so a selection survives switching tabs — every
        // paint re-reads the checkbox state from `chosen`.
        var pool = entries.concat(peopleHead(), regionDynamicEntries(regionMaxLevel), tagEntries);
        var entry = null;
        for (var i = 0; i < pool.length; i++) if (pickKey(pool[i]) === key) entry = pool[i];
        if (cb.checked && entry) chosen[key] = entry;
        else delete chosen[key];
      });

      root.addEventListener("click", async function (ev) {
        var ed = ev.target.closest && ev.target.closest("[data-ab-pedit]");
        if (ed) {
          var id = ed.getAttribute("data-ab-pedit");
          var row = (await api.contacts.get(id)).contact;
          if (row) { await openEditor(row); load(q("#ab-pick-search").value.trim()); }
        }
      });

      // Absent in push mode: a freshly created contact is an address, which
      // push cannot reach, so offering to make one here would be a dead end.
      var newBtn = root.querySelector('[data-ab="new"]');
      if (newBtn) newBtn.addEventListener("click", async function () {
        var created = await openEditor(null);
        if (created) {
          // Auto-select what the operator just added — they opened the editor
          // from a recipient field, so they mean to use it.
          chosen[created.email.toLowerCase()] = {
            source: "contact", id: created.id, email: created.email,
            name: created.name, description: created.description, kind: "person",
          };
        }
        load(q("#ab-pick-search").value.trim());
      });

      ["to", "cc", "bcc"].forEach(function (f) {
        var btn = root.querySelector('[data-ab="add-' + f + '"]');
        if (!btn) return; // push mode renders To alone
        btn.addEventListener("click", function () {
          var picked = Object.keys(chosen).map(function (k) { return chosen[k]; });
          if (!picked.length) { showToast("Select at least one recipient", "error"); return; }
          settled = { field: f, entries: picked };
          ui.close();
        });
      });

      load("");
      // Both catalogues ride the filter-schema payload (options.regions and
      // options.tagCatalog, from listScopeOptions), so the picker needs no
      // second endpoint and no permission the address book lacks.
      loadFilterSchema().then(function (schema) {
        tagEntries = tagRoutingEntries(schema);
        var lv = schema.options && schema.options.regionLevels;
        regionMaxLevel = lv && typeof lv.maxLevel === "number" ? lv.maxLevel : 1;
        renderTags();
      }).catch(function () {
        renderTags(); // degrade to the dynamic entries — they need no catalogue
      });
    });
  }

  window.PolarisAddressBook = {
    // The dynamic catalogue, for the wizard's recipient TYPEAHEAD: typing
    // “asset’s” there has to offer the same entries this picker heads its
    // panes with, and a second copy of the list would drift. `maxLevel` is the
    // caller's, since the region levels are loaded per surface.
    dynamicEntries: function (maxLevel) {
      return PEOPLE_DYNAMIC.concat(regionDynamicEntries(maxLevel));
    },
    renderTab: renderTab,
    openEditor: function (c) { return openEditor(c).then(function (r) { renderTab(); return r; }); },
    openPicker: openPicker,
  };
})();
