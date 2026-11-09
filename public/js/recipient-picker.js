// public/js/recipient-picker.js
//
// The To / Cc / Bcc recipient picker — pill boxes, typeahead, the Address book
// button, the save-to-book "+", drag between boxes — and the pill <-> payload
// mapping behind it. Lifted out of automations-wizard.js (2026-11-09) so the
// asset slide-over's firmware-upgrade and reboot dialogs (business rules 93 /
// 115(e)) build their recipients with the SAME control the automations' Notify
// and Reboot actions use, rather than a second picker that drifts.
//
// Two layers:
//   * module scope — the pure vocabulary (DYNAMIC_PILL_KINDS, isDynamicKind,
//     recipNeedle, pillsToRecipients, recipientsToPills). Plain globals, as
//     they were in the wizard, which still calls them by name.
//   * PolarisRecipientPicker.create(ctx) — one picker bound to a host's
//     catalogues: ctx.scopeOptions() (roles / regions / regionLevels /
//     tagCatalog — the /automations/scope-options shape), ctx.contactEmails()
//     (a Set of addresses already in the book, or null), ctx.pushDevices()
//     (userId -> enrolled browsers). Every getter is optional.
//
// Load order: after api.js and automations-address-book.js (the Address book
// button opens PolarisAddressBook.openPicker), BEFORE automations-wizard.js.
// tests/unit/assetSharedModules.test.ts pins it on every page.

// ─── Recipient pill ⇄ payload (pure; exported for tests) ───
// The Notify action's To/Cc/Bcc token fields store a pill as
// {kind:"user"|"address", value, label}; the wire shape splits that into
// recipientUserIds + addresses. Both halves live at module scope, closed over
// nothing, so tests/unit/automationRecipientPills.test.ts can pull them off
// window.PolarisAutomationRecipients (the PolarisAutomationSentences idiom).

/**
 * The two DYNAMIC recipient kinds: they name no address or account, they name a
 * RULE for finding one at fire time from the triggering asset. They were
 * checkboxes sitting under the recipient fields, which put "who gets this" in
 * two places at once; as pills they read in the same list as everyone else.
 * Their `value` is a constant — one of each is meaningful, so the pill's
 * identity IS its kind.
 */
var DYNAMIC_PILL_KINDS = { deviceRegion: "recipientDeviceRegion", assetContacts: "recipientAssetContacts" };

/**
 * The level-scoped device-region pill. Unlike the two above, its VALUE carries
 * information (the asset-relative level as a string), so several can coexist
 * and it can't be a flag keyed by kind alone.
 */
var DYNAMIC_LEVEL_KIND = "deviceRegionLevel";

/** Is this pill one of the dynamic "resolve from the triggering device" kinds? */
function isDynamicKind(kind) {
  return !!DYNAMIC_PILL_KINDS[kind] || kind === DYNAMIC_LEVEL_KIND;
}

/**
 * Fold a typed fragment and a label to one comparable form. The entries are
 * written with a typographic apostrophe and nobody types one, so "asset's"
 * — the obvious thing to type — matched nothing at all.
 */
function recipNeedle(s) {
  return String(s || "").toLowerCase().replace(/[’']/g, "");
}

/** Pills → the payload halves. Order preserved, duplicates dropped. */
function pillsToRecipients(pills) {
  var userIds = [], addresses = [], roles = [], regions = [], tags = [], levels = [];
  var out = {};
  (pills || []).forEach(function (p) {
    if (!p || !p.value) return;
    // Checked BEFORE the flag kinds: this one is keyed by value, not by kind.
    if (p.kind === DYNAMIC_LEVEL_KIND) {
      var lv = Number(p.value);
      if (Number.isInteger(lv) && lv >= 1 && levels.indexOf(lv) === -1) levels.push(lv);
      return;
    }
    if (DYNAMIC_PILL_KINDS[p.kind]) { out[DYNAMIC_PILL_KINDS[p.kind]] = true; return; }
    if (p.kind === "user") { if (userIds.indexOf(p.value) === -1) userIds.push(p.value); }
    else if (p.kind === "role") { if (roles.indexOf(p.value) === -1) roles.push(p.value); }
    else if (p.kind === "region") { if (regions.indexOf(p.value) === -1) regions.push(p.value); }
    // Registry tags are their OWN kind, not folded in with regions: a region
    // matches User.regionTags only (resolveUsersByRegions), while a tag matches
    // the flattened region-plus-other scope (resolveRecipientUsers). Same-named
    // rows would otherwise reach different people depending on which list the
    // operator happened to pick from.
    else if (p.kind === "tag") { if (tags.indexOf(p.value) === -1) tags.push(p.value); }
    else {
      var a = String(p.value).trim().toLowerCase();
      if (a && addresses.indexOf(a) === -1) addresses.push(a);
    }
  });
  if (userIds.length) out.recipientUserIds = userIds;
  if (addresses.length) out.addresses = addresses;
  if (roles.length) out.recipientRoles = roles;
  if (regions.length) out.recipientRegions = regions;
  if (tags.length) out.recipientTags = tags;
  if (levels.length) out.recipientDeviceRegionLevels = levels.slice().sort(function (a, b) { return a - b; });
  return out;
}

/** The payload halves → pills. A user id with no matching account is KEPT as an
 *  "unknown" pill rather than silently dropped on the next save — losing a
 *  recipient because their account was renamed is worse than showing a stub. */
function recipientsToPills(rec, users, roles, maxLevel) {
  var byId = {};
  (users || []).forEach(function (u) { byId[u.id] = u; });
  var roleById = {};
  (roles || []).forEach(function (r) { roleById[r.id] = r; });
  var out = [];
  // Dynamic entries first: they're the broadest thing in the list, and reading
  // "everyone in the device's region, plus Jane" in that order matches how an
  // operator describes it.
  if (rec && rec.recipientDeviceRegion) {
    out.push({ kind: "deviceRegion", value: "1", label: "Asset’s Region Users" });
  }
  if (rec && rec.recipientAssetContacts) {
    out.push({ kind: "assetContacts", value: "1", label: "Asset’s Responsible Contacts" });
  }
  // A stored level that no longer exists (someone removed the containing
  // polygon) is KEPT as an unknown pill, never dropped — the same contract as
  // an unknown user or role, and for the same reason: losing a recipient
  // silently is worse than showing a stub the operator can remove.
  ((rec && rec.recipientDeviceRegionLevels) || []).forEach(function (n) {
    var top = typeof maxLevel === "number" ? maxLevel : 0;
    out.push({
      kind: DYNAMIC_LEVEL_KIND,
      value: String(n),
      label: "Asset’s L" + n + " Region Users",
      unknown: top > 0 && n > top,
    });
  });
  ((rec && rec.recipientRegions) || []).forEach(function (name) {
    out.push({ kind: "region", value: name, label: name });
  });
  // Tag routing predates the picker offering it (the field was carried for
  // back-compat and nothing emitted it); it is now the Tags list's own output,
  // so a stored value has to round-trip as a pill or the next save drops it.
  ((rec && rec.recipientTags) || []).forEach(function (name) {
    out.push({ kind: "tag", value: name, label: name });
  });
  ((rec && rec.recipientRoles) || []).forEach(function (id) {
    // Roles are stored by ID, so a renamed role keeps routing; a DELETED one
    // survives as an unknown pill rather than vanishing on the next save.
    var r = roleById[id];
    out.push({ kind: "role", value: id, label: r ? r.name : "(unknown role)", unknown: !r });
  });
  ((rec && rec.recipientUserIds) || []).forEach(function (id) {
    var u = byId[id];
    out.push({ kind: "user", value: id, label: u ? (u.displayName || u.username) : "(unknown user)", unknown: !u });
  });
  ((rec && rec.addresses) || []).forEach(function (a) {
    out.push({ kind: "address", value: a, label: a });
  });
  return out;
}

/* eslint-disable-next-line no-unused-vars */
function createRecipientPicker(ctx) {
  ctx = ctx || {};
  // What the HOST holds — the wizard's /scope-options payload, its address-book
  // address set, its push-device counts — read through getters so a catalogue
  // the host loads AFTER create() is still the one used.
  function scopeOptions() { return (ctx.scopeOptions && ctx.scopeOptions()) || null; }
  function contactEmails() { return (ctx.contactEmails && ctx.contactEmails()) || null; }
  function pushDevices() { return (ctx.pushDevices && ctx.pushDevices()) || {}; }
  /** The suggestion-row badge for one account on a push box. */
  function pushDeviceBadge(userId) {
    var n = (pushDevices()[userId]) || 0;
    return n ? n + " device" + (n === 1 ? "" : "s") : "no push device";
  }

  // ─── Recipient token fields (To / Cc / Bcc) ────────────────────────────
  //
  // Email channels get three token boxes instead of the old multi-select +
  // comma-separated address input. A pill is {kind:"user"|"address", value,
  // label} and nothing more; DOM order IS the model, so collecting is a walk.
  //
  // The server model already accepted user ids in cc/bcc (emailRecipientsSchema
  // carries recipientUserIds alongside addresses) — the old UI just never
  // produced them, so this is a client-side mapping change with no schema work.


  /** Role catalogue for the recipient tokens (from /automations/scope-options). */
  function awRoles() { return (scopeOptions() && scopeOptions().roles) || []; }
  /** How deep region nesting goes. 1 (or absent) = nothing is nested, so the
   *  picker offers no level entries and a STORED level renders as unknown. */
  function awRegionMaxLevel() {
    var lv = scopeOptions() && scopeOptions().regionLevels;
    return lv && typeof lv.maxLevel === "number" ? lv.maxLevel : 1;
  }

  /**
   * Dynamic recipients matching the typed fragment — "Asset's Region Users" and
   * friends, which until now existed ONLY behind the Address book button, so
   * typing the thing you wanted matched nothing and read as "we don't have it".
   *
   * The catalogue itself comes from the address-book module, which already owns
   * it for the picker's panes; a second copy here would drift. To-only,
   * mirroring `pillAllowedInField` — suggesting one into Cc would look like it
   * worked and then send to nobody. Listed FIRST because, as in the picker, it
   * isn't a search hit: it's the standing answer to "whoever owns the device".
   */
  function dynamicSuggestions(q, field, mode) {
    if (field !== "to") return [];
    var needle = recipNeedle(q);
    var book = window.PolarisAddressBook;
    if (!book || !book.dynamicEntries) return [];
    return book.dynamicEntries(awRegionMaxLevel()).filter(function (e) {
      if (!pillAllowedInField(e.source, field, mode)) return false;
      return recipNeedle(e.name).indexOf(needle) !== -1;
    });
  }

  /**
   * Roles matching the typed fragment, as suggestion entries. Local — the role
   * list is small, already loaded with the wizard, and doesn't belong in
   * /contacts/search, which is the ADDRESS book.
   */
  function roleSuggestions(q) {
    var needle = String(q || "").toLowerCase();
    return awRoles()
      .filter(function (r) { return r.name.toLowerCase().indexOf(needle) !== -1; })
      .map(function (r) { return { source: "role", id: r.id, email: "", name: r.name, description: "Every user with this role" }; });
  }

  /**
   * Map regions matching the typed fragment, as suggestion entries. Local for
   * the same reason roles are: the catalogue rode in with the wizard's
   * /scope-options payload, and a region is not an address, so
   * /contacts/search never returns one. Without this the only way to route to
   * a region was the Address book button's Regions tab, so an operator who
   * typed a region name got the PEOPLE whose names happened to match it and no
   * sign of the region that reaches all of them.
   */
  function regionSuggestions(q) {
    var needle = String(q || "").toLowerCase();
    var levels = (scopeOptions() && scopeOptions().regionLevels && scopeOptions().regionLevels.byName) || {};
    return ((scopeOptions() && scopeOptions().regions) || [])
      .filter(function (name) { return String(name).toLowerCase().indexOf(needle) !== -1; })
      .map(function (name) {
        // Level is the same L1/L2 vocabulary the picker's Regions tab and the
        // "Asset's L<n> Region Users" entries use; omitted rather than assumed
        // when the catalogue couldn't be levelled.
        var lv = levels[String(name).toLowerCase()];
        return {
          source: "region", id: name, email: "", name: name,
          description: "Every user tagged with this region" + (lv ? " (L" + lv + ")" : ""),
        };
      });
  }

  /**
   * Registry tags matching the typed fragment. Local for the same reason roles
   * and regions are — the catalogue rode in with /scope-options, and a tag is
   * not an address, so /contacts/search never returns one.
   *
   * `tagCatalog` already excludes the Map Regions category: those rows ARE the
   * region catalogue under their `region:` registry names, they are offered by
   * regionSuggestions with their nesting level, and they route through the
   * region-only matcher. Listing them twice would put the same people behind
   * two entries that reach different sets.
   */
  function tagSuggestions(q) {
    var needle = String(q || "").toLowerCase();
    return ((scopeOptions() && scopeOptions().tagCatalog) || [])
      .filter(function (t) { return String(t && t.name).toLowerCase().indexOf(needle) !== -1; })
      .map(function (t) {
        return {
          source: "tag", id: t.name, email: "", name: t.name,
          description: "Every user tagged " + t.name + (t.category ? " \u00b7 " + t.category : ""),
        };
      });
  }

  function canReadContacts() { return typeof permAtLeast === "function" && permAtLeast("contacts", "read"); }
  function canAddContacts() { return typeof permAtLeast === "function" && permAtLeast("contacts", "write"); }

  // What each pill kind prints ahead of its label, and what its tooltip says.
  // The qualifier is what keeps a region called "Ashfield" from reading like a
  // person called "Ashfield" in a list that mixes both.
  var PILL_QUALIFIER = {
    role: "role:", region: "region:", tag: "tag:", deviceRegion: "dynamic:",
    deviceRegionLevel: "dynamic:", assetContacts: "dynamic:",
  };
  var PILL_TITLE = {
    region: "Every user tagged with this region",
    tag: "Every user carrying this tag",
    deviceRegion: "At fire time: the users whose region tags match the TRIGGERING device’s region (any level)",
    deviceRegionLevel: "At fire time: the users tagged with the region this many levels out from the TRIGGERING device’s own region",
    assetContacts: "At fire time: the address-book contacts whose device filter covers the TRIGGERING device",
  };

  function pillHtml(p) {
    var cls = "tag-chip" + (p.unknown ? " na-unknown" : "");
    var title = p.kind === "user"
      ? (p.unknown ? "This user account no longer exists" : "Polaris user account")
      : p.kind === "role"
        ? (p.unknown ? "This role no longer exists" : "Every user holding this role")
        : p.kind === DYNAMIC_LEVEL_KIND && p.unknown
          ? "No region is nested this deep any more — this reaches nobody"
          : PILL_TITLE[p.kind] || p.value;
    // The save affordance only makes sense for a typed address that isn't
    // already in the book, and only for someone who may add one.
    var showSave = p.kind === "address" && canAddContacts() &&
      contactEmails() && !contactEmails().has(String(p.value).toLowerCase());
    return '<span class="' + cls + '" draggable="true" data-kind="' + escapeHtml(p.kind) + '" ' +
        'data-value="' + escapeHtml(p.value) + '" data-label="' + escapeHtml(p.label) + '" ' +
        (p.unknown ? 'data-unknown="1" ' : "") +
        'title="' + escapeHtml(title) + '">' +
      (PILL_QUALIFIER[p.kind]
        ? '<span style="opacity:.6;font-size:.85em">' + PILL_QUALIFIER[p.kind] + '</span> '
        : "") +
      escapeHtml(p.label) +
      (showSave
        ? '<button type="button" class="na-chip-save" data-na-save title="Save to address book" aria-label="Save to address book">&plus;</button>'
        : "") +
      '<button type="button" class="tag-chip-delete" data-na-del aria-label="Remove recipient">&times;</button>' +
    "</span>";
  }

  /**
   * May a pill of this kind live in this box? Two independent gates, and both
   * exist because the alternative is a pill that looks accepted and then
   * reaches nobody:
   *
   *  - FIELD. The dynamic kinds are To-only: the wire shape has no per-field
   *    slot for them (they're flags on the ACTION, while Cc/Bcc are
   *    EmailRecipients lists), and at fire time the expander folds contact
   *    addresses into the To owner map.
   *  - MODE. A `push` box takes only what resolves to an ACCOUNT, because a
   *    push subscription hangs off a user. `usersForTarget` on the web_push
   *    transport ignores `addresses` and `recipientAssetContacts` outright, so
   *    those two are refused at the box rather than silently dropped at
   *    delivery (business rule 25's posture: say no where the operator is
   *    looking).
   */
  // Every kind that resolves to ACCOUNTS. `tag` rides the same reasoning as
  // `region` — it names user tags, not addresses.
  var PUSH_PILL_KINDS = { user: true, role: true, region: true, tag: true, deviceRegion: true, deviceRegionLevel: true };
  function pillAllowedInField(kind, field, mode) {
    if (mode === "push" && !PUSH_PILL_KINDS[kind]) return false;
    return !isDynamicKind(kind) || field === "to";
  }
  /** The mode a box was built in, read back off the DOM (see recipBoxHtml). */
  function boxMode(box) { return (box && box.getAttribute("data-mode")) || "email"; }

  /**
   * One address-book picker entry → a pill. The picker's `source` is the
   * vocabulary: `user` and the address-shaped sources it always had, plus the
   * Regions tab's `region` and the two dynamic entries.
   */
  function pickerEntryToPill(e) {
    if (!e) return null;
    if (e.source === "region") return { kind: "region", value: e.id, label: e.id };
    if (e.source === "tag") return { kind: "tag", value: e.id, label: e.id };
    if (e.source === "deviceRegion") return { kind: "deviceRegion", value: "1", label: e.name };
    if (e.source === "deviceRegionLevel") return { kind: DYNAMIC_LEVEL_KIND, value: String(e.level), label: e.name };
    if (e.source === "assetContacts") return { kind: "assetContacts", value: "1", label: e.name };
    if (e.source === "user") return { kind: "user", value: e.id, label: e.name || e.email };
    if (!e.email) return null;
    return { kind: "address", value: e.email, label: e.name ? e.name + " <" + e.email + ">" : e.email };
  }

  function recipBoxHtml(field, label, pills, withBook, mode) {
    // The To hint names “asset’s…” because the dynamic recipients are the one
    // thing here nobody would think to TYPE — they read as a picker feature.
    // The push variant omits "address" for the same reason the box refuses
    // one: there is no subscription behind an address.
    var placeholder = field !== "to" ? ""
      : mode === "push"
        ? "Type a name, role, region or “asset’s…”"
        : "Type a name, address, role, region or “asset’s…”";
    return '<div class="na-recip-row">' +
      '<label class="na-recip-label">' + escapeHtml(label) + "</label>" +
      '<div class="na-recip-box" data-field="' + field + '" data-mode="' + (mode || "email") + '">' +
        (pills || []).map(pillHtml).join("") +
        '<input type="text" class="na-recip-input" autocomplete="off" spellcheck="false" ' +
               'placeholder="' + escapeHtml(placeholder) + '" aria-label="Add a ' + escapeHtml(label) + ' recipient">' +
        '<div class="aw-suggest"></div>' +
      "</div>" +
      (withBook
        ? '<button type="button" class="btn btn-secondary btn-sm na-book" title="Open the address book">Address book</button>'
        : "") +
    "</div>";
  }

  /** Read a box's pills back out of the DOM. */
  function pillsOf(box) {
    return Array.from(box.querySelectorAll(":scope > .tag-chip")).map(function (el) {
      return {
        kind: el.getAttribute("data-kind"),
        value: el.getAttribute("data-value"),
        // From the attribute, not textContent: the chip also renders a "role:"
        // qualifier and the ×/+ buttons, which a text scrape would fold into
        // the label and then re-render on the next drag.
        label: el.getAttribute("data-label") || "",
        unknown: el.hasAttribute("data-unknown"),
      };
    });
  }

  function addPill(box, p) {
    if (!p || !p.value) return false;
    var dup = pillsOf(box).some(function (x) {
      return x.kind === p.kind && String(x.value).toLowerCase() === String(p.value).toLowerCase();
    });
    if (dup) return false;
    box.querySelector(".na-recip-input").insertAdjacentHTML("beforebegin", pillHtml(p));
    return true;
  }

  var EMAIL_RE = /^[^\s@]+@[^\s@.]+\.[^\s@]+$/;

  // Module-scope drag state. dataTransfer.getData is unreadable during
  // dragover, so the payload rides here and the MIME type is what dragover
  // filters on (the dashboard cross-container pattern, not the reorder one).
  var _naDragEl = null;
  var _naDragCue = null;
  function naClearDrag() {
    if (_naDragCue) { _naDragCue.classList.remove("aw-drop-into"); _naDragCue = null; }
    if (_naDragEl) { _naDragEl.classList.remove("na-dragging"); _naDragEl = null; }
  }

  /**
   * Wire one action's three boxes: typeahead, keyboard, removal, the save-to-
   * book affordance, the address-book button, and drag between the boxes.
   * `host` is the .na-recips wrapper — DnD is scoped to it, so a pill can never
   * jump into a different Notify action's fields.
   */
  function wireRecipBoxes(host, onChange) {
    var suggestTimer = null;

    host.querySelectorAll(".na-recip-box").forEach(function (box) {
      var input = box.querySelector(".na-recip-input");
      var sugg = box.querySelector(".aw-suggest");
      var mode = boxMode(box);
      var items = [];
      var idx = -1;

      function closeSuggest() { sugg.classList.remove("open"); sugg.innerHTML = ""; items = []; idx = -1; }
      function paint() {
        Array.from(sugg.children).forEach(function (el, i) { el.classList.toggle("active", i === idx); });
        if (idx >= 0 && sugg.children[idx]) sugg.children[idx].scrollIntoView({ block: "nearest" });
      }
      function openSuggest(entries) {
        items = entries || [];
        if (!items.length) {
          sugg.innerHTML = '<div class="aw-suggest-empty">No match — type a full address and press Enter.</div>';
          sugg.classList.add("open");
          idx = -1;
          return;
        }
        sugg.innerHTML = items.map(function (e, i) {
          var badge = e.source === "user" ? "user"
            : e.source === "contact" ? "contact"
              : isDynamicKind(e.source) ? "dynamic" : e.source;
          var label = e.email ? (e.name ? e.name + " — " + e.email : e.email) : (e.name || "");
          // On a push box the count IS the useful half of the row: an account
          // with no enrolled browser is picked exactly as easily as one with
          // three, and nothing else on screen tells them apart.
          if (mode === "push" && e.source === "user") badge = pushDeviceBadge(e.id);
          return '<div class="aw-suggest-item" data-i="' + i + '" title="' + escapeHtml(e.email || e.description || "") + '">' +
            escapeHtml(label) +
            ' <span style="opacity:.6;font-size:.85em">' + escapeHtml(badge) + "</span></div>";
        }).join("");
        sugg.classList.add("open");
        idx = 0;
        paint();
      }
      function entryToPill(e) {
        // A Polaris account becomes a USER pill and a role a ROLE pill — both
        // keyed by id, which survives a rename; only a bare address is stored
        // as the string itself. The dynamic sources share the picker's mapping
        // so a pill built by typing is identical to one picked from the book.
        if (isDynamicKind(e.source)) return pickerEntryToPill(e);
        if (e.source === "role") return { kind: "role", value: e.id, label: e.name };
        if (e.source === "region") return { kind: "region", value: e.id, label: e.id };
        if (e.source === "tag") return { kind: "tag", value: e.id, label: e.id };
        return e.source === "user"
          ? { kind: "user", value: e.id, label: e.name || e.email }
          : { kind: "address", value: e.email, label: e.name ? e.name + " <" + e.email + ">" : e.email };
      }
      function commit() {
        if (idx >= 0 && items[idx]) {
          if (addPill(box, entryToPill(items[idx]))) onChange();
          input.value = "";
          closeSuggest();
          return;
        }
        var raw = input.value.trim();
        if (!raw) return;
        if (mode === "push") {
          // A typed address has no subscription behind it, so committing one
          // would add a recipient the push transport ignores at fire time.
          showToast("A push alert reaches a Polaris account — pick a user, role or region, not an address", "error");
          return;
        }
        if (!EMAIL_RE.test(raw)) { showToast('"' + raw + '" is not a valid email address', "error"); return; }
        if (addPill(box, { kind: "address", value: raw.toLowerCase(), label: raw.toLowerCase() })) onChange();
        input.value = "";
        closeSuggest();
      }

      input.addEventListener("input", function () {
        var q = input.value.trim();
        clearTimeout(suggestTimer);
        if (q.length < 2) { closeSuggest(); return; }
        // Dynamic recipients, roles, regions and tags resolve LOCALLY and show
        // immediately — every one of those catalogues is already loaded, so the
        // list shouldn't wait on a network round trip (or disappear when the
        // caller lacks contacts:read).
        var local = dynamicSuggestions(q, box.getAttribute("data-field"), mode)
          .concat(roleSuggestions(q), regionSuggestions(q), tagSuggestions(q));
        if (!canReadContacts()) { openSuggest(local); return; }
        openSuggest(local);
        suggestTimer = setTimeout(function () {
          api.contacts.search(q, true).then(function (r) {
            // Ignore a response that lost the race with newer typing.
            if (input.value.trim() !== q) return;
            // On a push box the search half is narrowed to Polaris ACCOUNTS:
            // contacts and directory hits are addresses, which this transport
            // cannot reach, and offering them is how an operator builds an
            // action that delivers nothing.
            var hits = ((r && r.entries) || []).filter(function (e) {
              return pillAllowedInField(e.source === "user" ? "user" : "address", "to", mode);
            });
            openSuggest(local.concat(hits));
          }).catch(function () { /* keep the local matches already shown */ });
        }, 250);
      });
      input.addEventListener("keydown", function (ev) {
        if (ev.key === "ArrowDown") { ev.preventDefault(); if (items.length) { idx = (idx + 1) % items.length; paint(); } }
        else if (ev.key === "ArrowUp") { ev.preventDefault(); if (items.length) { idx = (idx - 1 + items.length) % items.length; paint(); } }
        else if (ev.key === "Enter") { ev.preventDefault(); commit(); }
        else if (ev.key === "," || ev.key === ";") { ev.preventDefault(); commit(); }
        else if (ev.key === "Escape") {
          // stopPropagation so the wizard modal doesn't close behind us.
          if (sugg.classList.contains("open")) { ev.stopPropagation(); closeSuggest(); }
        } else if (ev.key === "Backspace" && !input.value) {
          var ps = box.querySelectorAll(":scope > .tag-chip");
          if (ps.length) { ps[ps.length - 1].remove(); onChange(); }
        }
      });
      input.addEventListener("blur", function () { setTimeout(closeSuggest, 150); });
      // mousedown + preventDefault keeps focus in the input so the blur-close
      // above doesn't race the tap.
      sugg.addEventListener("mousedown", function (ev) {
        var it = ev.target.closest && ev.target.closest(".aw-suggest-item");
        if (!it) return;
        ev.preventDefault();
        idx = Number(it.getAttribute("data-i"));
        commit();
      });
      // Clicking the box's padding should focus the field — it reads as one control.
      box.addEventListener("mousedown", function (ev) { if (ev.target === box) { ev.preventDefault(); input.focus(); } });
    });

    // Pill removal + save-to-book, delegated across all three boxes.
    host.addEventListener("click", async function (ev) {
      var del = ev.target.closest && ev.target.closest("[data-na-del]");
      if (del) { del.closest(".tag-chip").remove(); onChange(); return; }

      var save = ev.target.closest && ev.target.closest("[data-na-save]");
      if (save) {
        var chip = save.closest(".tag-chip");
        var email = chip.getAttribute("data-value");
        save.disabled = true;
        try {
          await api.contacts.create({ email: email });
          if (contactEmails()) contactEmails().add(String(email).toLowerCase());
          save.remove();
          showToast("Saved to the address book", "success");
        } catch (err) {
          showToast((err && err.message) || "Could not save to the address book", "error");
          save.disabled = false;
        }
        return;
      }

      var book = ev.target.closest && ev.target.closest(".na-book");
      if (book) {
        // The mode travels with the request: in push mode the picker adds a
        // "Push devices" column, withholds the rows push cannot reach, and
        // offers To alone. Counts ride along rather than being fetched there,
        // since this file already holds them.
        var srcBox = book.closest(".na-recip-row").querySelector(".na-recip-box");
        var bookMode = boxMode(srcBox);
        // Every pill already on THIS action, tagged with its field, so the
        // picker can head each pane with the recipients the operator has.
        var current = [];
        host.querySelectorAll(".na-recip-box").forEach(function (b) {
          var f = b.getAttribute("data-field");
          pillsOf(b).forEach(function (p) { current.push({ kind: p.kind, value: p.value, label: p.label, field: f }); });
        });
        var res = await window.PolarisAddressBook.openPicker(
          bookMode === "push"
            ? { field: "to", mode: "push", pushDevices: pushDevices(), current: current }
            : { field: "to", current: current },
        );
        if (!res) return;
        // Current recipients the operator unticked come off wherever they sit —
        // matched on kind + value, the same identity addPill dedupes on.
        var removedAny = false;
        (res.removed || []).forEach(function (r) {
          var box = host.querySelector('.na-recip-box[data-field="' + r.field + '"]');
          if (!box) return;
          box.querySelectorAll(":scope > .tag-chip").forEach(function (chip) {
            if (chip.getAttribute("data-kind") === r.kind &&
                String(chip.getAttribute("data-value")).toLowerCase() === String(r.value).toLowerCase()) {
              chip.remove();
              removedAny = true;
            }
          });
        });
        if (removedAny) onChange();
        var dest = host.querySelector('.na-recip-box[data-field="' + res.field + '"]');
        if (!dest) return;
        var added = 0, refused = 0;
        res.entries.forEach(function (e) {
          var p = pickerEntryToPill(e);
          if (!p) return;
          if (!pillAllowedInField(p.kind, res.field, boxMode(dest))) { refused++; return; }
          if (addPill(dest, p)) added++;
        });
        if (refused) {
          showToast(bookMode === "push"
            ? "A push alert reaches a Polaris account — contacts and typed addresses have no subscription behind them"
            : "“Asset’s …” recipients can only go in To — they resolve per alert, and Cc/Bcc are fixed lists", "error");
        }
        if (added) onChange();
      }
    });

    // ── Drag a pill between To / Cc / Bcc ──
    // Cross-container MOVE, so the dashboard-canvas pattern: a custom MIME type
    // makes the drag identifiable during dragover, and the element itself is
    // stashed module-side because getData is unreadable there.
    host.addEventListener("dragstart", function (ev) {
      var chip = ev.target.closest && ev.target.closest(".na-recip-box > .tag-chip");
      if (!chip) return;
      _naDragEl = chip;
      chip.classList.add("na-dragging");
      try {
        ev.dataTransfer.setData("application/x-polaris-recipient", "1");
        ev.dataTransfer.setData("text/plain", chip.getAttribute("data-value") || "");
        ev.dataTransfer.effectAllowed = "move";
      } catch (_) { /* older browsers */ }
    });
    host.addEventListener("dragover", function (ev) {
      var types = ev.dataTransfer && ev.dataTransfer.types;
      if (!types || Array.prototype.indexOf.call(types, "application/x-polaris-recipient") === -1) return;
      var box = ev.target.closest && ev.target.closest(".na-recip-box");
      // Scoped to THIS action's fields — a pill must not jump between two
      // Notify actions, whose recipients are unrelated.
      if (!box || !host.contains(box) || !_naDragEl || _naDragEl.parentNode === box) return;
      // No cue for a field this kind can't live in, so the drop is refused
      // before the operator lets go rather than after.
      if (!pillAllowedInField(_naDragEl.getAttribute("data-kind"), box.getAttribute("data-field"), boxMode(box))) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = "move";
      if (_naDragCue !== box) {
        if (_naDragCue) _naDragCue.classList.remove("aw-drop-into");
        _naDragCue = box;
        box.classList.add("aw-drop-into");
      }
    });
    host.addEventListener("drop", function (ev) {
      var box = ev.target.closest && ev.target.closest(".na-recip-box");
      if (!box || !_naDragEl || _naDragEl.parentNode === box) { naClearDrag(); return; }
      ev.preventDefault();
      var p = {
        kind: _naDragEl.getAttribute("data-kind"),
        value: _naDragEl.getAttribute("data-value"),
        label: _naDragEl.getAttribute("data-label") || "",
        unknown: _naDragEl.hasAttribute("data-unknown"),
      };
      if (!pillAllowedInField(p.kind, box.getAttribute("data-field"), boxMode(box))) {
        // Keep the pill where it was: it resolves per alert, and Cc/Bcc are
        // fixed lists with no slot for it in the wire shape.
        showToast("“" + p.label + "” can only be a To recipient", "error");
        naClearDrag();
        return;
      }
      var moved = addPill(box, p);
      _naDragEl.remove();       // a move, not a copy — remove either way, since
      naClearDrag();            // a duplicate in the destination means it's there
      if (moved) onChange();
    });
    host.addEventListener("dragend", naClearDrag);
    host.addEventListener("dragleave", function (ev) {
      if (_naDragCue && ev.target === _naDragCue) { _naDragCue.classList.remove("aw-drop-into"); _naDragCue = null; }
    });
  }

  return {
    recipBoxHtml: recipBoxHtml,
    wireRecipBoxes: wireRecipBoxes,
    pillsOf: pillsOf,
    addPill: addPill,
    pillHtml: pillHtml,
    pickerEntryToPill: pickerEntryToPill,
    pillAllowedInField: pillAllowedInField,
    boxMode: boxMode,
    canReadContacts: canReadContacts,
    canAddContacts: canAddContacts,
    awRoles: awRoles,
    awRegionMaxLevel: awRegionMaxLevel,
    dynamicSuggestions: dynamicSuggestions,
    roleSuggestions: roleSuggestions,
    regionSuggestions: regionSuggestions,
    tagSuggestions: tagSuggestions,
    EMAIL_RE: EMAIL_RE,
  };
}

/**
 * The "who hears about it, and through which email channel" editor of a
 * dialog that books or runs an operation on ONE device — the firmware-upgrade
 * and reboot dialogs, desktop and phone (business rules 93 / 115(e)). Stateless
 * over the DOM: build it with the same inputs to render and again to wire or
 * read, as the dialogs' pure HTML functions need.
 *
 *   opts.prefix    id prefix ("fw" / "rb") — the box host is #<prefix>-notify-recips,
 *                  the channel list #<prefix>-notify-channels
 *   opts.defaults  GET …/schedules/defaults: { notify, users, catalog, channels }
 *   opts.spec      what to show: a booking's { to, cc, bcc, channelIds } — or
 *                  null for the defaults' remembered spec
 *   opts.withBook  show the Address book button (needs PolarisAddressBook)
 *
 * The spec it reads back is the server's `notifySpecSchema`: To carries every
 * kind including the device's dynamic recipients; Cc / Bcc are fixed lists.
 */
function notifyEditor(opts) {
  opts = opts || {};
  var d = opts.defaults || {};
  var catalog = d.catalog || {};
  var users = d.users || [];
  var channels = d.channels || [];
  var prefix = opts.prefix || "op";
  var spec = opts.spec || d.notify || { to: {}, cc: null, bcc: null, channelIds: [] };
  var maxLevel = catalog.regionLevels && typeof catalog.regionLevels.maxLevel === "number" ? catalog.regionLevels.maxLevel : 1;
  var picker = createRecipientPicker({ scopeOptions: function () { return catalog; } });
  var esc = typeof escapeHtml === "function" ? escapeHtml : function (x) {
    return String(x == null ? "" : x).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; });
  };

  function chosenChannels() {
    var ids = (spec.channelIds || []).filter(function (id) { return channels.some(function (c) { return c.id === id; }); });
    // Nothing chosen (or the chosen ones are gone): the oldest enabled one — what
    // the server would use for an empty list, made visible.
    return ids.length ? ids : (channels[0] ? [channels[0].id] : []);
  }

  function html() {
    var picked = chosenChannels();
    var chans = channels.length
      ? channels.map(function (c) {
          return '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:pointer">' +
            '<input type="checkbox" data-notify-channel="' + esc(c.id) + '"' + (picked.indexOf(c.id) !== -1 ? " checked" : "") + "> " +
            esc(c.name) + ' <span style="opacity:.6;font-size:.85em">' + (c.type === "oauth_m365" ? "Microsoft 365" : "SMTP") + "</span></label>";
        }).join("")
      : '<p class="hint" style="margin:0;color:var(--color-warning, var(--md-warning))">No email channel is enabled — add one under Automations → Delivery channels, or nothing can be sent.</p>';
    return '<div class="na-recips" id="' + prefix + '-notify-recips">' +
        picker.recipBoxHtml("to", "To", recipientsToPills(spec.to, users, catalog.roles, maxLevel), !!opts.withBook, "email") +
        picker.recipBoxHtml("cc", "Cc", recipientsToPills(spec.cc, users, catalog.roles), false, "email") +
        picker.recipBoxHtml("bcc", "Bcc", recipientsToPills(spec.bcc, users, catalog.roles), false, "email") +
      "</div>" +
      '<div class="form-group" id="' + prefix + '-notify-channels" style="margin:0.4rem 0 0">' +
        '<label style="display:block;font-size:0.8rem;margin-bottom:0.25rem">Send through</label>' +
        '<div style="display:flex;flex-wrap:wrap;gap:0.4rem 1rem">' + chans + "</div>" +
      "</div>";
  }

  function boxes(root) { return root ? root.querySelector("#" + prefix + "-notify-recips") : null; }
  function box(root, field) { var h = boxes(root); return h ? h.querySelector('.na-recip-box[data-field="' + field + '"]') : null; }

  /** Wire the boxes (typeahead, Address book, drag) and the channel boxes. */
  function wire(root, onChange) {
    var host = boxes(root);
    if (host) picker.wireRecipBoxes(host, onChange || function () {});
    var ch = root ? root.querySelector("#" + prefix + "-notify-channels") : null;
    if (ch) ch.addEventListener("change", function () { if (onChange) onChange(); });
  }

  /** The spec as the server takes it. */
  function read(root) {
    function list(field) {
      var b = box(root, field);
      return b ? pillsToRecipients(picker.pillsOf(b)) : {};
    }
    function orNull(r) { return Object.keys(r).length ? r : null; }
    var ids = [];
    (root ? root.querySelectorAll("#" + prefix + "-notify-channels [data-notify-channel]") : []).forEach(function (el) {
      if (el.checked) ids.push(el.getAttribute("data-notify-channel"));
    });
    return { to: list("to"), cc: orNull(list("cc")), bcc: orNull(list("bcc")), channelIds: ids };
  }

  /** Something in To, and a channel ticked whenever there is one to tick. */
  function ready(root) {
    var b = box(root, "to");
    var hasTo = !!(b && picker.pillsOf(b).length);
    var anyChannel = !channels.length ||
      !!(root && root.querySelector("#" + prefix + "-notify-channels [data-notify-channel]:checked"));
    return hasTo && anyChannel;
  }

  return { html: html, wire: wire, read: read, ready: ready };
}

/** A booking as the editor shows it: its picker spec, else its plain To list. */
function bookingNotifySpec(b) {
  if (!b) return null;
  var ids = b.notifyChannelIds || [];
  if (b.notifyRecipients && b.notifyRecipients.to) {
    return { to: b.notifyRecipients.to, cc: b.notifyRecipients.cc || null, bcc: b.notifyRecipients.bcc || null, channelIds: ids };
  }
  return { to: { addresses: b.notifyEmails || [] }, cc: b.notifyCc && b.notifyCc.length ? { addresses: b.notifyCc } : null, bcc: b.notifyBcc && b.notifyBcc.length ? { addresses: b.notifyBcc } : null, channelIds: ids };
}

if (typeof window !== "undefined") {
  window.PolarisRecipientPicker = {
    create: createRecipientPicker,
    isDynamicKind: isDynamicKind,
    recipNeedle: recipNeedle,
    pillsToRecipients: pillsToRecipients,
    recipientsToPills: recipientsToPills,
    DYNAMIC_PILL_KINDS: DYNAMIC_PILL_KINDS,
    DYNAMIC_LEVEL_KIND: DYNAMIC_LEVEL_KIND,
    notifyEditor: notifyEditor,
    bookingNotifySpec: bookingNotifySpec,
  };
}
