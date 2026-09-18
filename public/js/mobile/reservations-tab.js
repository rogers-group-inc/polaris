// public/js/mobile/reservations-tab.js — Reservations tab.
//
// Lists active reservations. Each row collapses to IP (headline) +
// MAC / hostname (subtitle). Tapping the row expands it inline to
// show owner/subnet/source/notes plus role-gated action buttons:
//   • Edit  — opens an inline edit sheet (PUT /reservations/:id).
//             Visible to admin/networkadmin always; user/assetsadmin
//             only when r.createdBy === user.username.
//   • Free  — releases the reservation (DELETE /reservations/:id).
//             Same role gating as Edit.
//   • Reserve — only on `sourceType="dhcp_lease"` rows. Opens the
//             standard reserve sheet (subnet-detail.js global helper)
//             pre-populated with IP / MAC / hostname. On submit, the
//             helper releases the lease first then creates a manual
//             reservation that pushes to the FortiGate when the
//             subnet's integration has DHCP push enabled.
//             Visible to any role with create access
//             (admin/networkadmin/assetsadmin/user).
//
// Only one row stays expanded at a time. Tapping the same row again
// collapses it.

(function () {
  var LIST_LIMIT = 200;

  var _state = { rows: [], expandedId: null, user: null };

  // Gate on the permission matrix (reservations level), NOT the role name —
  // custom/renamed roles that grant reservations=write must pass, exactly
  // like the desktop's permAtLeast / canEditReservation. See app.js.
  var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
  function permAtLeast(user, key, level) {
    var have = (user && user.permissions && user.permissions[key]) || "none";
    return (_PERM_RANK[have] || 0) >= (_PERM_RANK[level] || 0);
  }
  function canCreate(user) {
    return permAtLeast(user, "reservations", "write");
  }
  // Edit / Free: fullwrite passes unconditionally; write passes only when
  // the caller created the row (ownership model). Mirrors the backend's
  // requireOwnership("reservations") + req.permissionLevel branch and the
  // desktop canEditReservation().
  function canModify(user, row) {
    if (permAtLeast(user, "reservations", "fullwrite")) return true;
    if (!permAtLeast(user, "reservations", "write")) return false;
    return !!(row && row.createdBy && user.username && row.createdBy === user.username);
  }

  var Reservations = {
    title: "Reservations",
    icon: "#i-bookmark",
    renderTopbar: function (ctx) {
      // Add action moved to a floating "+ Reserve" FAB in the body —
      // matches the Networks page's Reserve FAB so the same primary
      // create gesture lands in the same spot on both screens.
      return ""
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Reservations</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" id="reservations-refresh-btn" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body, ctx) {
      _state.user = (ctx && ctx.user) || null;
      _state.expandedId = null;
      var user = _state.user;
      body.innerHTML = ''
        + '<div id="reservations-host"></div>'
        + (canCreate(user)
          ? '<button class="fab-ext" id="reservations-fab" style="position:fixed;right:16px;bottom:calc(var(--navbar-h) + 16px);z-index:30;"><svg viewBox="0 0 24 24"><use href="#i-add"/></svg>Reserve</button>'
          : '');
      load();

      var btn = document.getElementById("reservations-refresh-btn");
      if (btn) btn.addEventListener("click", function () {
        btn.disabled = true;
        load().finally(function () { btn.disabled = false; });
      });

      var fab = document.getElementById("reservations-fab");
      if (fab) fab.addEventListener("click", function () {
        openCreateByIpSheet();
      });
    },
    onPullToRefresh: function () {
      return load();
    },
  };

  function load() {
    var host = document.getElementById("reservations-host");
    if (!host) return Promise.resolve();
    host.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';

    return api.reservations.list({ status: "active", limit: LIST_LIMIT }).then(function (resp) {
      _state.rows = (resp && resp.reservations) || [];
      _state.total = (resp && resp.total) || _state.rows.length;
      renderList();
    }).catch(function (err) {
      host.innerHTML = ""
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
        + '  <div class="ttl">Couldn’t load</div>'
        + '  <div class="desc">' + escapeHtml(err && err.message ? err.message : "error") + '</div>'
        + '</div>';
    });
  }

  function renderList() {
    var host = document.getElementById("reservations-host");
    if (!host) return;
    var rs = _state.rows;
    if (rs.length === 0) {
      host.innerHTML = ""
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></div>'
        + '  <div class="ttl">No reservations</div>'
        + '  <div class="desc">No active reservations on file.</div>'
        + '</div>';
      return;
    }

    var html = ""
      + '<div class="section-head">Active<span class="count">'
      + escapeHtml(String(rs.length))
      + (_state.total > rs.length ? " of " + escapeHtml(String(_state.total)) : "")
      + '</span></div>';

    rs.forEach(function (r, i) {
      var expanded = _state.expandedId === r.id;
      var subtitleBits = [];
      if (r.macAddress) subtitleBits.push('<span class="mono">' + escapeHtml(r.macAddress) + '</span>');
      if (r.hostname) subtitleBits.push(escapeHtml(r.hostname));
      if (subtitleBits.length === 0 && r.subnet) {
        // Nothing identifying the device — fall back to the subnet label
        // so the row still has a useful second line.
        if (r.subnet.name) subtitleBits.push(escapeHtml(r.subnet.name));
        else if (r.subnet.cidr) subtitleBits.push('<span class="mono">' + escapeHtml(r.subnet.cidr) + '</span>');
      }
      var subtitle = subtitleBits.join(" · ") || '<span style="color:var(--md-on-surface-variant);">—</span>';

      var chevHref = expanded ? "#i-chev-down" : "#i-chev-right";
      var ip = r.ipAddress || "—";

      html += ""
        + '<button class="list-item two-line" data-id="' + escapeHtml(r.id) + '"' + (expanded ? ' aria-expanded="true"' : '') + '>'
        + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-bookmark"/></svg></span>'
        + '  <div class="content">'
        + '    <div class="headline"><span class="mono">' + escapeHtml(ip) + '</span></div>'
        + '    <div class="supporting">' + subtitle + '</div>'
        + '  </div>'
        + '  <div class="trailing"><svg viewBox="0 0 24 24"><use href="' + chevHref + '"/></svg></div>'
        + '</button>'
        + (expanded ? renderExpandedPanel(r) : '')
        + (i < rs.length - 1 ? '<div class="list-divider"></div>' : "");
    });
    host.innerHTML = html;

    wireRowHandlers();
  }

  function renderExpandedPanel(r) {
    var detailRows = [];
    if (r.hostname) detailRows.push(detailRow("Hostname", escapeHtml(r.hostname)));
    if (r.owner)    detailRows.push(detailRow("Owner", escapeHtml(r.owner)));
    if (r.subnet) {
      var subnetText = r.subnet.name
        ? escapeHtml(r.subnet.name) + (r.subnet.cidr ? ' <span class="mono" style="color:var(--md-on-surface-variant);font-size:12px;">' + escapeHtml(r.subnet.cidr) + '</span>' : '')
        : (r.subnet.cidr ? '<span class="mono">' + escapeHtml(r.subnet.cidr) + '</span>' : '—');
      detailRows.push(detailRow("Network", subnetText));
    }
    if (r.sourceType) detailRows.push(detailRow("Source", escapeHtml(String(r.sourceType).replace(/_/g, " "))));
    if (r.notes)    detailRows.push(detailRow("Notes", escapeHtml(r.notes)));
    if (r.expiresAt) detailRows.push(detailRow("Expires", escapeHtml(formatDate(r.expiresAt))));
    if (r.createdBy) detailRows.push(detailRow("Created by", escapeHtml(r.createdBy)));

    var user = _state.user;
    var buttons = [];
    var isLease = r.sourceType === "dhcp_lease";
    if (isLease && canCreate(user)) {
      // Green when push-eligible so the operator sees that confirming
      // also writes the reservation to the FortiGate.
      var reserveCls = r.pushEligible ? "btn-success" : "btn-filled";
      var reserveTitle = r.pushEligible ? "Reserve on Gate" : "Reserve in Polaris";
      buttons.push('<button class="btn ' + reserveCls + '" data-act="reserve" data-id="' + escapeHtml(r.id) + '" title="' + reserveTitle + '">Reserve</button>');
    }
    // A FortiGate VIP and a statically-configured interface address are owned
    // by the DEVICE's config, not by Polaris: no Edit, no Release. The server
    // refuses both (409) — this keeps the buttons off a row that can't use
    // them. Matches the desktop IP panel, where the same two source types
    // render read-only with a purple status dot.
    var isDeviceOwned = r.sourceType === "vip" || r.sourceType === "interface_ip";
    if (canModify(user, r) && !isDeviceOwned) {
      buttons.push('<button class="btn btn-tonal" data-act="edit" data-id="' + escapeHtml(r.id) + '">Edit</button>');
      // Leases → Revoke (forgets the current lease, client can re-acquire);
      // reservations → Release (gives up the reservation).
      var freeLabel = isLease ? "Revoke" : "Release";
      var freeTitle = isLease ? "Revoke Lease" : "Release Reservation";
      buttons.push('<button class="btn btn-error" data-act="free" data-id="' + escapeHtml(r.id) + '" title="' + freeTitle + '">' + freeLabel + '</button>');
    }
    if (r.subnetId) {
      buttons.push('<button class="btn btn-text" data-act="open-subnet" data-subnet="' + escapeHtml(r.subnetId) + '">Open network</button>');
    }

    var btnBar = buttons.length
      ? '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:12px;">' + buttons.join("") + '</div>'
      : '';

    var emptyHint = (detailRows.length === 0 && buttons.length === 0)
      ? '<div style="color:var(--md-on-surface-variant);font-size:13px;">No additional details.</div>'
      : '';

    return ''
      + '<div class="reservation-expand" style="background:var(--md-surface-cont-low);padding:12px 16px 16px;border-radius:0 0 var(--shape-md) var(--shape-md);">'
      +   detailRows.join('')
      +   emptyHint
      +   btnBar
      + '</div>';
  }

  function detailRow(label, valueHtml) {
    return ''
      + '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:13px;">'
      + '  <span style="color:var(--md-on-surface-variant);flex-shrink:0;">' + escapeHtml(label) + '</span>'
      + '  <span style="text-align:right;word-break:break-word;">' + valueHtml + '</span>'
      + '</div>';
  }

  function wireRowHandlers() {
    var host = document.getElementById("reservations-host");
    if (!host) return;

    // Action buttons inside an expanded panel — bound first so the
    // row-collapse handler doesn't swallow them via stopPropagation.
    host.querySelectorAll(".reservation-expand button[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var act = btn.dataset.act;
        var id = btn.dataset.id;
        var row = _state.rows.find(function (r) { return r.id === id; });
        if (act === "edit"          && row) openEditSheet(row);
        if (act === "free"          && row) confirmFree(row);
        if (act === "reserve"       && row) startReserveFromLease(row);
        if (act === "open-subnet")          PolarisRouter.go("subnet/" + btn.dataset.subnet);
      });
    });

    // Row click → toggle expansion.
    host.querySelectorAll(".list-item[data-id]").forEach(function (row) {
      row.addEventListener("click", function () {
        var id = row.dataset.id;
        _state.expandedId = (_state.expandedId === id) ? null : id;
        renderList();
      });
    });
  }

  // ─── Reserve-from-lease ────────────────────────────────────────────────
  function startReserveFromLease(row, user, onSuccess) {
    user = user || _state.user;
    if (!row.subnetId) {
      PolarisTabs.showSnackbar("Lease has no subnet — can't promote.", { error: true });
      return;
    }
    window.PolarisReserveSheet.open(row.subnetId, user, {
      ip: row.ipAddress,
      mac: row.macAddress,
      hostname: row.hostname,
      notes: row.notes,
    }, {
      existingLeaseId: row.id,
      onSuccess: onSuccess || function () {
        _state.expandedId = null;
        load();
      },
    });
  }

  // ─── Free (release) ────────────────────────────────────────────────────
  function confirmFree(row, onSuccess) {
    var label = row.ipAddress || row.hostname || "this reservation";
    var isLease = row.sourceType === "dhcp_lease";
    var verb = isLease ? "Revoke" : "Release";
    if (!window.confirm(verb + " " + label + "?")) return;
    api.reservations.release(row.id).then(function () {
      PolarisTabs.showSnackbar(verb + "d " + label);
      if (typeof onSuccess === "function") onSuccess();
      else { _state.expandedId = null; load(); }
    }).catch(function (err) {
      PolarisTabs.showSnackbar(err && err.message ? err.message : (verb + " failed"), { error: true });
    });
  }

  // ─── Edit sheet ────────────────────────────────────────────────────────
  // Inline edit modal. Fields: hostname, owner, MAC, notes, expires.
  // PUT /reservations/:id. Pulls subnet shell first so we know push
  // eligibility — on push-eligible subnets, clearing the MAC is rejected
  // server-side (DHCP reservations are MAC→IP); the UI hides the clear
  // hint and labels MAC as required.
  function openEditSheet(row, onSuccess) {
    closeEditSheet();
    if (!row.subnetId) {
      PolarisTabs.showSnackbar("Reservation has no subnet — can't edit.", { error: true });
      return;
    }
    api.subnets.ips(row.subnetId, { page: 1, pageSize: 1 }).then(function (resp) {
      var subnet = resp && resp.subnet;
      renderEditSheet(row, subnet, onSuccess);
    }).catch(function (err) {
      PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not load network", { error: true });
    });
  }

  function renderEditSheet(row, subnet, onSuccess) {
    var pushEligible = !!(subnet && subnet.pushEligible);
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "edit-rsv-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "edit-rsv-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '  <h3 class="sheet-title" style="margin:0;">Edit reservation</h3>'
      + '  <button class="icon-btn" id="edit-rsv-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div style="color:var(--md-on-surface-variant);font-size:13px;margin-bottom:12px;"><span class="mono">' + escapeHtml(row.ipAddress || "") + '</span>'
      +   (subnet && subnet.cidr ? ' · in <span class="mono">' + escapeHtml(subnet.cidr) + '</span>' : '')
      + '</div>'
      + '<div id="edit-rsv-error" class="hidden" style="background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'
      + '<form id="edit-rsv-form" autocomplete="off">'
      + '  <div class="tf-outlined"><span class="lbl">Hostname</span>'
      + '    <input class="field" id="e-hostname" maxlength="100" value="' + escapeHtml(row.hostname || "") + '">'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Owner</span>'
      + '    <input class="field" id="e-owner" maxlength="100" value="' + escapeHtml(row.owner || "") + '">'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">MAC address' + (pushEligible ? ' *' : '') + '</span>'
      + '    <input class="field mono" id="e-mac" placeholder="aa:bb:cc:dd:ee:ff" value="' + escapeHtml(row.macAddress || "") + '"' + (pushEligible ? ' required' : '') + '>'
      + '    <div class="support" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'
      +       (pushEligible
                ? '<span>Pushed to ' + escapeHtml((subnet && subnet.fortigateDevice) || "FortiGate") + '. Clearing the MAC is not allowed — release the reservation instead.</span>'
                : '<span></span>')
      + '      <button type="button" class="btn btn-text" id="e-mac-gen" title="Generate a placeholder MAC for a device that isn’t racked yet — discovery replaces it with the real one once the device appears at this IP" style="font-size:13px;padding:4px 10px;flex-shrink:0;">Generate</button>'
      + '    </div>'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Notes</span>'
      + '    <input class="field" id="e-notes" maxlength="500" value="' + escapeHtml(row.notes || "") + '">'
      +     (pushEligible ? '    <div class="support" id="e-notes-budget">Saved to the FortiGate reservation comment.</div>' : '')
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Expires (YYYY-MM-DD)</span>'
      + '    <input class="field mono" id="e-expires" placeholder="" value="' + escapeHtml(formatDate(row.expiresAt) || "") + '">'
      + '  </div>'
      + '  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">'
      + '    <button type="button" class="btn btn-text" id="edit-rsv-cancel">Cancel</button>'
      + '    <button type="submit" class="btn btn-filled" id="edit-rsv-submit">Save</button>'
      + '  </div>'
      + '</form>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeEditSheet);
    document.getElementById("edit-rsv-close").addEventListener("click", closeEditSheet);
    document.getElementById("edit-rsv-cancel").addEventListener("click", closeEditSheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeEditSheet);
    document.getElementById("edit-rsv-form").addEventListener("submit", function (e) {
      e.preventDefault();
      submitEdit(row, pushEligible, onSuccess);
    });
    // The edit sheet had no Generate button, unlike mobile create and both
    // desktop paths — so the one place an operator would fix a MAC on a phone
    // was the one place that couldn't produce a placeholder.
    var genBtn = document.getElementById("e-mac-gen");
    var macInput = document.getElementById("e-mac");
    if (genBtn && macInput) {
      genBtn.addEventListener("click", function () {
        macInput.value = window.PolarisPlaceholderMac.generate(
          subnet ? subnet.macPlaceholderPrefix : null,
        );
        macInput.focus();
        try { macInput.select(); } catch (_) {}
      });
    }
    wireNotesBudget(pushEligible, row.createdBy);
  }

  // Live "N characters left" under Notes on a push-eligible network. The notes
  // become the FortiGate reservation's description, which the device caps at
  // 255 characters INCLUDING the "Polaris/<user>: … [<hostname>]" wrapper, so
  // the budget moves as the hostname is edited. `createdBy` is the ORIGINAL
  // creator — the device-side description keeps their name across an edit, not
  // the editor's. Budget math is shared with the desktop IP panel
  // (public/js/reservation-notes.js); the server refuses an over-length save
  // either way.
  function wireNotesBudget(pushEligible, createdBy) {
    if (!pushEligible || !window.PolarisReservationNotes) return;
    var notes = document.getElementById("e-notes");
    var hint = document.getElementById("e-notes-budget");
    if (!notes || !hint) return;
    var hostEl = document.getElementById("e-hostname");
    function render() {
      var state = window.PolarisReservationNotes.hintFor(
        notes.value,
        hostEl ? hostEl.value : "",
        createdBy,
      );
      hint.textContent = state.text;
      hint.style.color = state.over > 0 ? "var(--md-error, #b3261e)" : "";
    }
    notes.addEventListener("input", render);
    if (hostEl) hostEl.addEventListener("input", render);
    render();
  }

  function submitEdit(row, pushEligible, onSuccess) {
    clearEditError();
    var hostname = (document.getElementById("e-hostname").value || "").trim();
    var owner    = (document.getElementById("e-owner").value || "").trim();
    var mac      = (document.getElementById("e-mac").value || "").trim();
    var notes    = (document.getElementById("e-notes").value || "").trim();
    var expires  = (document.getElementById("e-expires").value || "").trim();

    if (pushEligible && !mac) { showEditError("MAC is required on DHCP-push networks"); return; }

    // Send empty strings (not undefined) so the server clears the field
    // — the backend treats "" as a deliberate clear on hostname/owner/
    // notes/projectRef. MAC is only sent when it changed AND is non-empty
    // on push-eligible subnets (clearing is rejected server-side anyway).
    var body = {
      hostname: hostname,
      owner: owner,
      notes: notes,
      expiresAt: expires || null,
    };
    if (!pushEligible || mac) body.macAddress = mac;

    var btn = document.getElementById("edit-rsv-submit");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';

    api.reservations.update(row.id, body).then(function () {
      closeEditSheet();
      PolarisTabs.showSnackbar("Saved");
      if (typeof onSuccess === "function") onSuccess();
      else load();
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = "Save";
      showEditError(err && err.message ? err.message : "Update failed");
    });
  }

  function closeEditSheet() {
    var s = document.getElementById("edit-rsv-sheet");
    var sc = document.getElementById("edit-rsv-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }
  function showEditError(msg) {
    var el = document.getElementById("edit-rsv-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function clearEditError() {
    var el = document.getElementById("edit-rsv-error");
    if (el) el.classList.add("hidden");
  }

  // ─── Reserve-by-IP sheet ───────────────────────────────────────────────
  // Quick-reserve: operator types an IP, we look up the containing subnet
  // via /search, then either create the reservation, navigate to a more
  // specific error toast (no network / IP in use as VIP / DHCP lease /
  // existing reservation), or surface the server's create error inline.
  function openCreateByIpSheet() {
    closeCreateByIpSheet();

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "create-rsv-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "create-rsv-sheet";
    sheet.innerHTML = ""
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '  <h3 class="sheet-title" style="margin:0;">Reserve an IP</h3>'
      + '  <button class="icon-btn" id="create-rsv-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div style="color:var(--md-on-surface-variant);font-size:13px;margin-bottom:12px;">Polaris will find the matching network for you.</div>'
      + '<div id="create-rsv-error" class="hidden" style="background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'
      + '<form id="create-rsv-form" autocomplete="off">'
      + '  <div class="tf-outlined"><span class="lbl">IP address *</span>'
      + '    <input class="field mono" id="c-ip" placeholder="10.1.2.3" required>'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Hostname</span>'
      + '    <input class="field" id="c-hostname" maxlength="100">'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">MAC address</span>'
      + '    <input class="field mono" id="c-mac" placeholder="optional">'
      + '    <div class="support">Required if the network pushes DHCP reservations to a FortiGate.</div>'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Notes</span>'
      + '    <input class="field" id="c-notes" maxlength="500">'
      + '  </div>'
      + '  <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:8px;">'
      + '    <button type="button" class="btn btn-text" id="create-rsv-cancel">Cancel</button>'
      + '    <button type="submit" class="btn btn-filled" id="create-rsv-submit">Reserve</button>'
      + '  </div>'
      + '</form>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeCreateByIpSheet);
    document.getElementById("create-rsv-close").addEventListener("click", closeCreateByIpSheet);
    document.getElementById("create-rsv-cancel").addEventListener("click", closeCreateByIpSheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeCreateByIpSheet);
    document.getElementById("create-rsv-form").addEventListener("submit", function (e) {
      e.preventDefault();
      submitCreateByIp();
    });
    setTimeout(function () {
      var ipInput = document.getElementById("c-ip");
      if (ipInput) try { ipInput.focus(); } catch (_) {}
    }, 50);
  }

  function submitCreateByIp() {
    clearCreateError();
    var ip       = (document.getElementById("c-ip").value || "").trim();
    var hostname = (document.getElementById("c-hostname").value || "").trim();
    var mac      = (document.getElementById("c-mac").value || "").trim();
    var notes    = (document.getElementById("c-notes").value || "").trim();
    if (!ip) { showCreateError("IP address is required"); return; }

    var btn = document.getElementById("create-rsv-submit");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';
    var restore = function () {
      var b = document.getElementById("create-rsv-submit");
      if (!b) return;
      b.disabled = false;
      b.innerHTML = "Reserve";
    };

    api.search.query(ip).then(function (resp) {
      var hit = resp && resp.ips && resp.ips[0];
      if (!hit || !hit.context || !hit.context.subnetId) {
        restore();
        PolarisTabs.showSnackbar("No network contains " + ip, { error: true });
        return;
      }
      var ctx = hit.context;
      if (ctx.reservationId) {
        // IP already taken — fetch the existing row so the toast can name
        // the kind of hold (manual reservation / VIP / DHCP lease / etc.).
        return api.reservations.get(ctx.reservationId).then(function (existing) {
          restore();
          var src = (existing && existing.sourceType) || "";

          // A live DHCP lease can be promoted in place: hand off to the shared
          // reserve sheet with existingLeaseId set — the same flow the per-row
          // "Reserve" button on a lease uses (startReserveFromLease), which
          // releases the lease then creates the manual reservation. This keeps
          // the typed-IP path and the row button behaving identically. Any
          // other hold (manual reservation, VIP, dhcp_reservation, …) is not
          // taken over — it falls through to the explanatory toast below.
          if (src === "dhcp_lease" && canCreate(_state.user)) {
            closeCreateByIpSheet();
            PolarisTabs.showSnackbar(ip + " is leased — promote it to a reservation");
            window.PolarisReserveSheet.open(ctx.subnetId, _state.user, {
              ip: ip,
              hostname: hostname || (existing && existing.hostname) || "",
              mac: mac || (existing && existing.macAddress) || "",
              notes: notes,
            }, {
              existingLeaseId: ctx.reservationId,
              onSuccess: function () { load(); },
            });
            return;
          }

          var msg;
          if (src === "vip") msg = ip + " is in use as a FortiGate VIP";
          else if (src === "dhcp_lease") msg = ip + " is held by an active DHCP lease";
          else if (src === "dhcp_reservation") msg = ip + " is already a DHCP reservation";
          else if (src === "interface_ip") msg = ip + " is a FortiGate interface IP";
          else if (src === "fortiswitch") msg = ip + " is in use by a FortiSwitch";
          else if (src === "fortinap") msg = ip + " is in use by a FortiAP";
          else if (src === "dns_resolved") msg = ip + " is already in use (DNS-resolved)";
          else msg = ip + " is already reserved";
          PolarisTabs.showSnackbar(msg, { error: true });
        }).catch(function () {
          restore();
          PolarisTabs.showSnackbar(ip + " is already reserved", { error: true });
        });
      }

      // Free — create the reservation.
      var body = { subnetId: ctx.subnetId, ipAddress: ip };
      if (hostname) body.hostname = hostname;
      if (mac)      body.macAddress = mac;
      if (notes)    body.notes = notes;

      return api.reservations.create(body).then(function () {
        closeCreateByIpSheet();
        var where = ctx.subnetName || ctx.subnetCidr || "network";
        PolarisTabs.showSnackbar("Reserved " + ip + " in " + where);
        load();
      }).catch(function (err) {
        restore();
        showCreateError(err && err.message ? err.message : "Reservation failed");
      });
    }).catch(function (err) {
      restore();
      showCreateError(err && err.message ? err.message : "Lookup failed");
    });
  }

  function closeCreateByIpSheet() {
    var s = document.getElementById("create-rsv-sheet");
    var sc = document.getElementById("create-rsv-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }
  function showCreateError(msg) {
    var el = document.getElementById("create-rsv-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function clearCreateError() {
    var el = document.getElementById("create-rsv-error");
    if (el) el.classList.add("hidden");
  }

  // ─── Helpers ───────────────────────────────────────────────────────────
  // formatDate is the shared mobileFormatDate global from api.js (same local-
  // time YYYY-MM-DD this used; unparseable now yields "" instead of the raw
  // string, which the escapeHtml-wrapped "Expires" cell + edit-form value
  // both render cleanly).
  var formatDate = mobileFormatDate;

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  window.PolarisReservationsTab = { spec: Reservations };

  // Cross-page reservation action helpers. Used by subnet-detail.js so
  // the IP-list rows on the Networks page can reuse the same Edit /
  // Free / Reserve-from-lease flows without duplicating modal markup
  // or backend wiring. Each action accepts an optional onSuccess
  // callback so the caller can refresh its own list rather than the
  // Reservations tab's.
  window.PolarisReservationActions = {
    canCreate: canCreate,
    canModify: canModify,
    edit:             function (row, user, onSuccess) { openEditSheet(row, onSuccess); },
    free:             function (row, user, onSuccess) { confirmFree(row, onSuccess); },
    reserveFromLease: function (row, user, onSuccess) { startReserveFromLease(row, user, onSuccess); },
  };
})();
