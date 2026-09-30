// public/js/mobile/reservation-actions.js — reservation verbs shared by the
// Networks tab's IP sheet.
//
// The phone used to carry a Reservations tab: a flat list of the first 200
// active reservations with these verbs on each row. That tab is gone — the
// Networks tab took its navbar slot, and a network's IP sheet is where a
// reservation is seen and acted on — but the verbs outlived it:
//   • Edit    — the edit sheet (PUT /reservations/:id).
//   • Free    — Release a reservation / Revoke a lease (DELETE).
//   • Reserve — promote a DHCP lease through the shared reserve sheet
//               (PolarisReserveSheet in subnet-detail.js).
//   • Reserve an IP — type an address, Polaris finds its network
//               (the Networks tab's "+ Reserve" FAB).
// Every verb takes an onSuccess callback so the caller refreshes its own
// list; nothing here owns a list any more.

(function () {
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

  // ─── Reserve-from-lease ────────────────────────────────────────────────
  function startReserveFromLease(row, user, onSuccess) {
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
      onSuccess: onSuccess,
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
  function openCreateByIpSheet(user, onSuccess) {
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
      submitCreateByIp(user, onSuccess);
    });
    setTimeout(function () {
      var ipInput = document.getElementById("c-ip");
      if (ipInput) try { ipInput.focus(); } catch (_) {}
    }, 50);
  }

  function submitCreateByIp(user, onSuccess) {
    var done = function () { if (typeof onSuccess === "function") onSuccess(); };
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
          if (src === "dhcp_lease" && canCreate(user)) {
            closeCreateByIpSheet();
            PolarisTabs.showSnackbar(ip + " is leased — promote it to a reservation");
            window.PolarisReserveSheet.open(ctx.subnetId, user, {
              ip: ip,
              hostname: hostname || (existing && existing.hostname) || "",
              mac: mac || (existing && existing.macAddress) || "",
              notes: notes,
            }, {
              existingLeaseId: ctx.reservationId,
              onSuccess: done,
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
        done();
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

  // A FortiGate VIP and a statically-configured interface address are owned
  // by the DEVICE's config, not by Polaris: no Edit, no Release. The server
  // refuses both (409); this keeps the buttons off a row that can't use them,
  // matching the desktop IP panel, which renders the same two source types
  // read-only.
  function isDeviceOwned(row) {
    return !!row && (row.sourceType === "vip" || row.sourceType === "interface_ip");
  }

  window.PolarisReservationActions = {
    canCreate: canCreate,
    canModify: canModify,
    isDeviceOwned: isDeviceOwned,
    reserveByIp:      function (user, onSuccess) { openCreateByIpSheet(user, onSuccess); },
    edit:             function (row, user, onSuccess) { openEditSheet(row, onSuccess); },
    free:             function (row, user, onSuccess) { confirmFree(row, onSuccess); },
    reserveFromLease: function (row, user, onSuccess) { startReserveFromLease(row, user, onSuccess); },
  };
})();
