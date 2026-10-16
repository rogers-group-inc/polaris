/**
 * public/js/assets-firmware-group.js — group firmware upgrades (business
 * rule 122) on the Assets page.
 *
 * The bulk bar's Upgrade button:
 *   grey  — nothing selected, a selected asset is not a FortiGate /
 *           FortiSwitch / FortiAP, or more than MAX_GROUP selected;
 *   red   — the selection spans more than one controlling FortiGate, or holds
 *           a device Polaris cannot place under one (the server's
 *           /assets/firmware-groups/sources answer). Clicking it explains why
 *           and offers "Keep only these" per FortiGate;
 *   normal — every selected device sits under one FortiGate. Clicking it opens
 *           the booking dialog: the upgrade order, the dropped devices, the
 *           single-device bookings it will cancel, time / concurrency /
 *           recipients.
 * The red state is guidance only — the server refuses a mixed selection too.
 *
 * Also the group's detail modal (progress, Cancel / Stop), opened after a
 * booking, from the asset's Firmware card and from Events → Calendar.
 *
 * Reads `_assetsSelected` / `_assetsSelectedMeta` (assets.js) and reuses the
 * single-device dialog's `_fwLocalInputValue` / `_fwBrowserZone` /
 * `_fwParseEmails` / `_fwWhenText` helpers.
 */
(function () {
  "use strict";

  var MAX_GROUP = 500;
  var ELIGIBLE = ["firewall", "switch", "access_point"];
  var DEBOUNCE_MS = 300;

  // The last sources answer, keyed by the sorted id list it was for.
  var _sources = { key: "", result: null, error: null };
  var _seq = 0;
  var _timer = null;
  var _detailPoll = null;

  function typeLabel(t) {
    return t === "access_point" ? "FortiAP" : t === "switch" ? "FortiSwitch" : t === "firewall" ? "FortiGate" : t;
  }

  function selectedIds() {
    return (typeof _assetsSelected !== "undefined") ? Array.from(_assetsSelected) : [];
  }

  function keyOf(ids) { return ids.slice().sort().join(","); }

  function isMixed(r) {
    return !!r && (r.sources.length > 1 || r.unresolved.length > 0 || r.unsupported.length > 0);
  }

  function btn() { return document.getElementById("assets-bulk-firmware-btn"); }

  function setLook(b, red, title) {
    b.classList.toggle("btn-danger", red);
    b.classList.toggle("btn-secondary", !red);
    b.title = title;
  }

  function applySources(b, r) {
    if (!r) return;
    if (isMixed(r)) {
      var n = r.sources.length + (r.unresolved.length ? 1 : 0) + (r.unsupported.length ? 1 : 0);
      setLook(b, true, "Selected devices come from " + n + " sources. Click for details.");
    } else {
      var s = r.sources[0];
      setLook(b, false, "Schedule a group firmware upgrade" + (s ? " on " + s.gateName : "") + " — devices upgrade in dependency order");
    }
  }

  /** Called from _assetsUpdateBulkBar on every selection change. */
  function syncButton() {
    var b = btn();
    if (!b) return;
    var ids = selectedIds();
    if (ids.length === 0) {
      b.disabled = true;
      setLook(b, false, "Select FortiGates, FortiSwitches or FortiAPs to upgrade their firmware together");
      return;
    }
    var meta = (typeof _assetsSelectedMeta !== "undefined") ? _assetsSelectedMeta : {};
    var notFortinet = ids.filter(function (id) { return meta[id] && ELIGIBLE.indexOf(meta[id].assetType) < 0; });
    if (notFortinet.length) {
      b.disabled = true;
      setLook(b, false, "Only FortiGates, FortiSwitches and FortiAPs can be upgraded — " + notFortinet.length + " selected asset" + (notFortinet.length === 1 ? " is" : "s are") + " not");
      return;
    }
    if (ids.length > MAX_GROUP) {
      b.disabled = true;
      setLook(b, false, "A group upgrade can select at most " + MAX_GROUP + " devices — " + ids.length + " selected");
      return;
    }
    b.disabled = false;
    var key = keyOf(ids);
    if (_sources.key === key && _sources.result) { applySources(b, _sources.result); return; }
    setLook(b, false, "Checking which FortiGate the selected devices sit under…");
    if (_timer) clearTimeout(_timer);
    _timer = setTimeout(function () { fetchSources(ids, key); }, DEBOUNCE_MS);
  }

  function fetchSources(ids, key) {
    var mine = ++_seq;
    return api.assets.firmwareGroupSources(ids).then(function (r) {
      if (mine !== _seq) return null; // a newer selection's answer wins
      _sources = { key: key, result: r, error: null };
      var b = btn();
      if (b && keyOf(selectedIds()) === key) applySources(b, r);
      return r;
    }).catch(function (err) {
      if (mine !== _seq) return null;
      _sources = { key: key, result: null, error: err };
      return null;
    });
  }

  async function onClick() {
    var ids = selectedIds();
    if (!ids.length) return;
    var key = keyOf(ids);
    var r = (_sources.key === key && _sources.result) ? _sources.result : await fetchSources(ids, key);
    if (!r) {
      showToast((_sources.error && _sources.error.message) || "Could not check the selected devices", "error");
      return;
    }
    if (isMixed(r)) openSourcesModal(r);
    else openBookingModal(ids);
  }

  // ─── Red button: why ─────────────────────────────────────────────────────

  function nameList(ids) {
    var data = (typeof _assetsData !== "undefined" && Array.isArray(_assetsData)) ? _assetsData : [];
    var byId = {};
    data.forEach(function (a) { byId[a.id] = a.hostname || a.ipAddress || a.id; });
    return ids.map(function (id) { return byId[id] || null; });
  }

  function openSourcesModal(r) {
    var sections = r.sources.map(function (s, i) {
      var names = nameList(s.assetIds).filter(Boolean);
      var shown = names.slice(0, 12).map(escapeHtml).join(", ") + (names.length > 12 ? ", …" : "");
      return '<div class="fwg-source" style="padding:0.6rem 0.75rem;border:1px solid var(--color-border);border-radius:6px;margin-bottom:0.6rem">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:0.75rem">' +
          '<div><strong>' + escapeHtml(s.gateName) + '</strong>' +
            (s.integrationName ? ' <span style="color:var(--color-text-secondary)">· ' + escapeHtml(s.integrationName) + '</span>' : '') +
            '<div class="hint" style="margin:0.15rem 0 0">' + s.assetIds.length + ' selected device' + (s.assetIds.length === 1 ? '' : 's') + (shown ? ': ' + shown : '') + '</div></div>' +
          '<button type="button" class="btn btn-sm btn-secondary" data-fwg-keep="' + i + '">Keep only these</button>' +
        '</div></div>';
    }).join("");
    var placed = function (title, list) {
      if (!list.length) return "";
      return '<div style="padding:0.6rem 0.75rem;border:1px solid var(--color-warning);border-radius:6px;margin-bottom:0.6rem">' +
        '<strong>' + escapeHtml(title) + '</strong>' +
        '<ul style="margin:0.3rem 0 0 1.1rem;padding:0;font-size:0.85rem">' +
          list.map(function (u) { return '<li>' + escapeHtml(u.name) + ' — ' + escapeHtml(u.reason) + '</li>'; }).join("") +
        '</ul></div>';
    };
    var body =
      '<p style="margin:0 0 0.75rem">A group upgrade runs against one FortiGate at a time: the FortiGate and the FortiSwitches and FortiAPs behind it, in dependency order. ' +
        'The selection spans ' + (r.sources.length + (r.unresolved.length ? 1 : 0) + (r.unsupported.length ? 1 : 0)) + ' sources — keep one FortiGate’s devices to continue.</p>' +
      sections +
      placed("Not under a FortiGate Polaris can name", r.unresolved) +
      placed("Not upgradable as part of a group", r.unsupported);
    openModal("Upgrade — the selection spans several sources", body, '<button class="btn btn-secondary" onclick="closeModal()">Close</button>', { wide: true });
    document.querySelectorAll("[data-fwg-keep]").forEach(function (b) {
      b.addEventListener("click", function () {
        var s = r.sources[Number(b.getAttribute("data-fwg-keep"))];
        if (!s) return;
        keepOnly(s.assetIds);
        _sources = { key: keyOf(s.assetIds), result: { sources: [s], unresolved: [], unsupported: [] }, error: null };
        closeModal();
        if (typeof _assetsUpdateBulkBar === "function") _assetsUpdateBulkBar();
      });
    });
  }

  function keepOnly(ids) {
    var keep = {};
    ids.forEach(function (id) { keep[id] = true; });
    Array.from(_assetsSelected).forEach(function (id) {
      if (!keep[id]) { _assetsSelected.delete(id); delete _assetsSelectedMeta[id]; }
    });
    document.querySelectorAll("#assets-tbody input.row-cb").forEach(function (cb) {
      cb.checked = _assetsSelected.has(cb.getAttribute("data-id"));
    });
    if (typeof _assetsUpdateSelectAll === "function") _assetsUpdateSelectAll();
  }

  // ─── Booking dialog ──────────────────────────────────────────────────────

  function nextHour() { var d = new Date(Date.now() + 60 * 60000); d.setMinutes(0, 0, 0); return d; }

  /** Pure, for the DOM test: the dialog body for a plan. */
  function bookingBodyHTML(plan, defaults) {
    var g = plan.gate;
    var parts = [];
    parts.push('<p style="margin:0 0 0.6rem"><strong>FortiGate:</strong> ' + escapeHtml(g.name) +
      (g.integrationName ? ' <span style="color:var(--color-text-secondary)">· ' + escapeHtml(g.integrationName) + '</span>' : '') + '</p>');
    parts.push('<p class="hint" style="margin:0 0 0.75rem">Devices upgrade deepest first — access points, then the switches above them, then the FortiGate. ' +
      'A device never upgrades while one above, below or paired with it is upgrading, and a device is only upgraded once everything behind it finished cleanly. ' +
      'If one fails, the devices above it are skipped and the rest carry on. Each device’s health is checked just before it starts: one that is down or unhealthy is skipped and the next one starts.</p>');

    if (plan.existingGroup) {
      parts.push('<div class="alert alert-warning" style="margin:0 0 0.75rem">A group upgrade is already ' +
        (plan.existingGroup.status === "running" ? "running" : "scheduled for " + escapeHtml(_fwWhenText(plan.existingGroup.scheduledFor))) +
        ' on this FortiGate. Only one group per FortiGate at a time — open it to change or cancel it. ' +
        '<button type="button" class="btn btn-sm btn-secondary" id="fwg-open-existing" data-group-id="' + escapeHtml(plan.existingGroup.id) + '">Open it</button></div>');
    }
    if (plan.otherGroups && plan.otherGroups.length) {
      parts.push('<div class="alert alert-warning" style="margin:0 0 0.75rem">' + escapeHtml(plan.otherGroups.map(function (o) { return o.name; }).join(", ")) +
        (plan.otherGroups.length === 1 ? ' is' : ' are') + ' already in another group upgrade.</div>');
    }

    if (plan.included.length) {
      var depths = []; plan.included.forEach(function (m) { if (depths.indexOf(m.depth) < 0) depths.push(m.depth); });
      depths.sort(function (a, b) { return b - a; });
      var rows = plan.included.map(function (m) {
        var stage = depths.indexOf(m.depth) + 1;
        var nw = ' style="white-space:nowrap"';
        return '<tr><td' + nw + '>' + stage + '</td><td' + nw + '>' + escapeHtml(m.name) + '</td><td' + nw + '>' + escapeHtml(m.model || typeLabel(m.assetType)) + '</td>' +
          '<td' + nw + '>' + escapeHtml(m.fromVersion || "unknown") + ' → <strong>' + escapeHtml(m.toVersion) + '</strong></td>' +
          '<td style="color:var(--color-warning)' + ((m.warnings || []).length ? ';min-width:220px' : '') + '">' + (m.warnings || []).map(escapeHtml).join("<br>") + '</td></tr>';
      }).join("");
      parts.push('<h4 style="margin:0.5rem 0 0.3rem">Upgrade order (' + plan.included.length + ')</h4>' +
        '<div class="table-wrapper" style="max-height:240px;overflow:auto"><table class="data-table" id="fwg-order-table" style="font-size:0.82rem;width:100%"><thead><tr><th style="white-space:nowrap">Stage</th><th style="white-space:nowrap">Device</th><th style="white-space:nowrap">Type</th><th style="white-space:nowrap">Firmware</th><th style="white-space:nowrap">Notes</th></tr></thead><tbody>' + rows + '</tbody></table></div>');
    } else {
      parts.push('<div class="alert alert-warning" style="margin:0.5rem 0">Nothing to upgrade: every selected device is already current or has no image in the Repository.</div>');
    }

    if (plan.dropped.length) {
      var drows = plan.dropped.map(function (m) {
        return '<tr><td>' + escapeHtml(m.name) + '</td><td>' + escapeHtml(typeLabel(m.assetType)) + '</td><td>' + escapeHtml(m.fromVersion || "unknown") + '</td><td>' + escapeHtml(m.reason) + '</td></tr>';
      }).join("");
      parts.push('<h4 style="margin:0.75rem 0 0.3rem">Dropped from this schedule (' + plan.dropped.length + ')</h4>' +
        '<div class="table-wrapper" style="max-height:160px;overflow:auto"><table class="data-table" id="fwg-dropped-table" style="font-size:0.82rem"><thead><tr><th style="white-space:nowrap">Device</th><th style="white-space:nowrap">Type</th><th style="white-space:nowrap">Running</th><th style="white-space:nowrap">Why</th></tr></thead><tbody>' + drows + '</tbody></table></div>');
    }

    var bookable = plan.included.length > 0 && !plan.existingGroup && !(plan.otherGroups && plan.otherGroups.length);
    if (bookable) {
      if (plan.individualBookings.length) {
        parts.push('<div class="alert alert-warning" id="fwg-individual-warning" style="margin:0.75rem 0 0">' +
          '<strong>' + plan.individualBookings.length + ' device' + (plan.individualBookings.length === 1 ? ' has its own upgrade' : 's have their own upgrades') + ' scheduled.</strong> ' +
          'Booking this group cancels ' + (plan.individualBookings.length === 1 ? 'it' : 'them') + ' and the group upgrades ' + (plan.individualBookings.length === 1 ? 'that device' : 'those devices') + ' instead:' +
          '<ul style="margin:0.3rem 0 0.4rem 1.1rem;padding:0">' + plan.individualBookings.map(function (b) {
            return '<li>' + escapeHtml(b.name) + ' → ' + escapeHtml(b.toVersion) + ', ' + escapeHtml(_fwWhenText(b.scheduledFor)) + '</li>';
          }).join("") + '</ul>' +
          '<label style="display:flex;gap:0.5rem;align-items:center;cursor:pointer"><input type="checkbox" id="fwg-ack-cancel"> Cancel ' + (plan.individualBookings.length === 1 ? 'that upgrade' : 'those upgrades') + ' and include ' + (plan.individualBookings.length === 1 ? 'the device' : 'them') + ' in the group</label>' +
        '</div>');
      }
      var zone = _fwBrowserZone();
      var emails = (defaults && defaults.notifyEmails) || [];
      parts.push('<div style="margin-top:0.9rem;padding-top:0.75rem;border-top:1px solid var(--color-border)">' +
        '<div style="display:grid;grid-template-columns:2fr 1fr;gap:0 1rem">' +
          '<div class="form-group"><label for="fwg-when">Run at</label>' +
            '<input type="datetime-local" id="fwg-when" min="' + escapeHtml(_fwLocalInputValue(new Date(Date.now() + 2 * 60000))) + '" value="' + escapeHtml(_fwLocalInputValue(nextHour())) + '">' +
            '<p class="hint" style="margin:0.25rem 0 0">Your time' + (zone ? ' (' + escapeHtml(zone) + ')' : '') + '. If Polaris only gets to it more than 15 minutes late, the group is not started.</p></div>' +
          '<div class="form-group"><label for="fwg-concurrency">At once</label>' +
            '<input type="number" id="fwg-concurrency" min="1" max="' + ((defaults && defaults.maxConcurrency) || 10) + '" step="1" value="1">' +
            '<p class="hint" style="margin:0.25rem 0 0">Devices on separate branches only.</p></div>' +
        '</div>' +
        '<div class="form-group"><label for="fwg-emails">Email the summary to</label>' +
          '<input type="text" id="fwg-emails" placeholder="you@example.com, team@example.com" value="' + escapeHtml(emails.join(", ")) + '">' +
          '<p class="hint" style="margin:0.25rem 0 0">Comma-separated. One summary when the group finishes, listing failures, devices skipped for health, devices skipped because something behind them failed, and dropped devices.</p></div>' +
        '<div class="alert alert-warning" style="padding:0.6rem 0.75rem;font-size:0.82rem;margin:0.25rem 0 0.6rem">Each device reboots during its upgrade — everything behind a switch, and every network and tunnel behind the FortiGate, goes down with it. ' +
          'Polaris checks that each image is newer and fits the platform, not that the jump is on Fortinet’s supported upgrade path. A flash that fails partway can leave a device unbootable.</div>' +
        '<label style="display:flex;gap:0.5rem;align-items:center;font-size:0.85rem;cursor:pointer"><input type="checkbox" id="fwg-ack"> I have checked the devices, versions and order above</label>' +
      '</div>');
    }
    return parts.join("");
  }

  async function openBookingModal(ids) {
    var footer = '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="fwg-submit" disabled>Schedule group upgrade</button>';
    openModal("Group firmware upgrade", '<p class="hint">Planning…</p>', footer, { wide: true });
    var res;
    try {
      res = await api.assets.firmwareGroupPreview(ids);
    } catch (err) {
      var body = document.querySelector("#modal-overlay .modal-body");
      if (body) body.innerHTML = '<div class="alert alert-warning">' + escapeHtml((err && err.message) || "Could not plan the group upgrade") + '</div>';
      return;
    }
    var plan = res.plan;
    var bodyEl = document.querySelector("#modal-overlay .modal-body");
    if (!bodyEl) return;
    bodyEl.innerHTML = bookingBodyHTML(plan, res.defaults);
    var titleEl = document.getElementById("modal-title");
    if (titleEl) titleEl.textContent = "Group firmware upgrade — " + plan.gate.name;

    var open = document.getElementById("fwg-open-existing");
    if (open) open.addEventListener("click", function () { openDetail(open.getAttribute("data-group-id")); });

    var submit = document.getElementById("fwg-submit");
    var ack = document.getElementById("fwg-ack");
    var ackCancel = document.getElementById("fwg-ack-cancel");
    var whenEl = document.getElementById("fwg-when");
    var emailsEl = document.getElementById("fwg-emails");
    var concEl = document.getElementById("fwg-concurrency");
    if (!submit) return;
    if (!ack) { submit.style.display = "none"; return; }
    function sync() {
      var conc = Number(concEl && concEl.value);
      submit.disabled = !ack.checked || (ackCancel && !ackCancel.checked) || !whenEl.value ||
        _fwParseEmails(emailsEl.value).length === 0 || !(conc >= 1 && conc <= 10 && Math.floor(conc) === conc);
    }
    [ack, ackCancel, whenEl, emailsEl, concEl].forEach(function (el) {
      if (!el) return;
      el.addEventListener("input", sync);
      el.addEventListener("change", sync);
    });
    sync();
    submit.addEventListener("click", async function () {
      submit.disabled = true;
      try {
        var out = await api.assets.createFirmwareGroup({
          assetIds: ids,
          scheduledFor: new Date(whenEl.value).toISOString(),
          concurrency: Number(concEl.value),
          notifyEmails: _fwParseEmails(emailsEl.value),
          cancelIndividual: !!(ackCancel && ackCancel.checked),
        });
        showToast("Group upgrade scheduled for " + _fwWhenText(out.group.scheduledFor));
        openDetail(out.group.id);
      } catch (err) {
        showToast((err && err.message) || "Could not schedule the group upgrade", "error");
        sync();
      }
    });
  }

  // ─── Group detail ────────────────────────────────────────────────────────

  var STATE_LOOK = {
    planned:           ["Planned", "var(--color-text-secondary)"],
    waiting:           ["Waiting", "var(--color-warning)"],
    running:           ["Upgrading", "var(--color-accent)"],
    upgraded:          ["Upgraded", "var(--color-success)"],
    "already-current": ["Already current", "var(--color-success)"],
    failed:            ["Failed", "var(--color-danger)"],
    unverified:        ["Unverified", "var(--color-warning)"],
    skipped:           ["Skipped", "var(--color-warning)"],
    dropped:           ["Dropped", "var(--color-text-tertiary)"],
  };
  var SKIP_WORD = { health: "health", subtree: "upstream of a failure", cancelled: "not started", timeout: "waited too long" };

  /** Pure, for the DOM test. */
  function detailBodyHTML(g) {
    var head = '<p style="margin:0 0 0.6rem"><strong>' + escapeHtml(g.gateName) + '</strong> · ' + escapeHtml(g.status) +
      ' · scheduled for ' + escapeHtml(_fwWhenText(g.scheduledFor)) + ' · ' + g.concurrency + ' at once · by ' + escapeHtml(g.createdBy) + '</p>';
    if (g.error) head += '<div class="alert alert-warning" style="margin:0 0 0.6rem">' + escapeHtml(g.error) + '</div>';
    var rows = g.members.map(function (m) {
      var look = STATE_LOOK[m.state] || [m.state, "inherit"];
      var label = look[0] + (m.state === "skipped" && m.skipKind ? " (" + (SKIP_WORD[m.skipKind] || m.skipKind) + ")" : "");
      var note = m.detail || "";
      if (m.state === "running" && m.run && m.run.stage) note = "stage: " + m.run.stage;
      if ((m.state === "failed" || m.state === "unverified") && m.run && m.run.stage) note = m.run.stage + ": " + note;
      var ver = m.toVersion ? escapeHtml(m.fromVersion || "?") + ' → ' + escapeHtml(m.toVersion) : escapeHtml(m.fromVersion || "");
      return '<tr data-state="' + escapeHtml(m.state) + '"><td>' + escapeHtml(m.name) + '</td><td>' + escapeHtml(typeLabel(m.assetType)) + '</td><td>' + ver + '</td>' +
        '<td style="color:' + look[1] + ';white-space:nowrap">' + escapeHtml(label) + '</td><td>' + escapeHtml(note) + '</td></tr>';
    }).join("");
    return head + '<div class="table-wrapper" style="max-height:420px;overflow:auto"><table class="data-table" id="fwg-detail-table" style="font-size:0.82rem"><thead><tr><th style="white-space:nowrap">Device</th><th style="white-space:nowrap">Type</th><th style="white-space:nowrap">Firmware</th><th style="white-space:nowrap">State</th><th style="white-space:nowrap">Detail</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function stopDetailPoll() { if (_detailPoll) { clearInterval(_detailPoll); _detailPoll = null; } }

  async function openDetail(groupId) {
    stopDetailPoll();
    var g;
    try { g = (await api.assets.firmwareGroup(groupId)).group; } catch (err) { showToast((err && err.message) || "Could not load the group upgrade", "error"); return; }
    var canWrite = typeof permAtLeast === "function" && permAtLeast("assets", "write");
    function footerHTML(st) {
      var cancel = canWrite && (st === "pending" || st === "running")
        ? '<button class="btn btn-danger" id="fwg-cancel" style="margin-right:auto">' + (st === "running" ? "Stop group upgrade" : "Cancel group upgrade") + '</button>'
        : '';
      return cancel + '<button class="btn btn-secondary" onclick="closeModal()">Close</button>';
    }
    openModal("Group firmware upgrade — " + g.gateName, '<div id="fwg-detail">' + detailBodyHTML(g) + '</div>', footerHTML(g.status), { wide: true });
    function wire(st) {
      var c = document.getElementById("fwg-cancel");
      if (!c) return;
      c.addEventListener("click", async function () {
        var ok = await showConfirm(st === "running"
          ? "Stop this group upgrade?\nDevices already upgrading finish; nothing else is started. The summary email lists what was done."
          : "Cancel this group upgrade?\nNothing is sent to any device and no email goes out.");
        if (!ok) return;
        try {
          var out = await api.assets.cancelFirmwareGroup(groupId);
          showToast(st === "running" ? "Group upgrade stopped" : "Group upgrade cancelled");
          refresh(out.group);
        } catch (err) { showToast((err && err.message) || "Could not cancel the group upgrade", "error"); }
      });
    }
    function refresh(next) {
      var box = document.getElementById("fwg-detail");
      if (!box) { stopDetailPoll(); return; }
      box.innerHTML = detailBodyHTML(next);
      var foot = document.querySelector("#modal-overlay .modal-footer");
      if (foot) { foot.innerHTML = footerHTML(next.status); wire(next.status); }
      var live = next.status === "running" || next.status === "pending" || next.members.some(function (m) { return m.state === "running"; });
      if (!live) stopDetailPoll();
    }
    wire(g.status);
    _detailPoll = setInterval(async function () {
      if (!document.getElementById("fwg-detail")) { stopDetailPoll(); return; }
      try { refresh((await api.assets.firmwareGroup(groupId)).group); } catch (e) { /* next tick */ }
    }, 3000);
  }

  function init() {
    var b = btn();
    if (b) b.addEventListener("click", onClick);
    syncButton();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();

  window.PolarisFirmwareGroup = {
    syncButton: syncButton,
    onClick: onClick,
    openDetail: openDetail,
    // Exposed for the DOM tests.
    _bookingBodyHTML: bookingBodyHTML,
    _detailBodyHTML: detailBodyHTML,
    _isMixed: isMixed,
  };
})();
