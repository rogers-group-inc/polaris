// public/js/mobile/subnet-detail.js — Subnet detail + Reserve sheet.
//
// Phase 8 deliverable. Two pieces:
//   1. Subnet detail screen (#subnet/<id>): info hero + paged IP list with
//      reservation status. Tapping a reserved row navigates to the linked
//      asset; tapping a free row opens the Reserve sheet pre-filled with
//      that IP.
//   2. Reserve sheet (modal): IP / hostname / MAC (required when
//      `pushEligible`) / notes + collapsible "more fields" for projectRef /
//      expiresAt. POST /reservations on submit. Notes flow into the FortiOS
//      reserved-address description on push-eligible subnets — operator typing
//      here shows up on the FortiGate's reservation comment field.
//
// Role gates: readonly users see the list but no Reserve FAB and tapping
// a free IP shows a snackbar instead of the sheet. user / assetsadmin /
// networkadmin / admin can reserve. The mobile UI doesn't expose
// ownership-edit guarding yet; release happens on desktop.

(function () {
  var IP_PAGE_SIZE = 256;

  // Per-subnet state cache so navigating back from a quick reserve doesn't
  // refetch the IP list.
  var _mounts = Object.create(null);
  function mountState(id) {
    if (!_mounts[id]) {
      _mounts[id] = { subnet: null, ips: [], page: 1, totalIps: 0, loading: false, ipv6: false, expandedIp: null };
    }
    return _mounts[id];
  }

  // Can the user create reservations? Gate on the permission matrix
  // (reservations >= write), NOT the role name — custom/renamed roles
  // that grant reservations=write must pass, exactly like the desktop's
  // permAtLeast("reservations", "write"). See app.js canReserveIps().
  var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
  function permAtLeast(user, key, level) {
    var have = (user && user.permissions && user.permissions[key]) || "none";
    return (_PERM_RANK[have] || 0) >= (_PERM_RANK[level] || 0);
  }
  function canWrite(user) {
    return permAtLeast(user, "reservations", "write");
  }

  // ─── Top-level renderers ───────────────────────────────────────────────
  function renderTopbar(ctx) {
    return ''
      + '<div class="m3-topbar">'
      + '  <div class="leading">'
      + '    <button class="icon-btn" id="subnet-back-btn" aria-label="Back"><svg viewBox="0 0 24 24"><use href="#i-back"/></svg></button>'
      + '  </div>'
      + '  <div class="title" id="subnet-topbar-title">Network</div>'
      + '  <div class="trailing"></div>'
      + '</div>';
  }

  function render(body, ctx) {
    var id = (ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (!id) {
      body.innerHTML = '<div class="empty-state" style="padding-top:64px;"><div class="ttl">Network id missing</div></div>';
      return;
    }
    var st = mountState(id);
    body.innerHTML = ''
      + '<div id="subnet-host"><div class="loading-screen"><div class="spinner"></div></div></div>'
      + (canWrite(ctx.user)
        ? '<button class="fab-ext" id="subnet-fab" style="position:fixed;right:16px;bottom:calc(var(--navbar-h) + 16px);z-index:30;display:none;"><svg viewBox="0 0 24 24"><use href="#i-add"/></svg>Reserve</button>'
        : '');

    var back = document.getElementById("subnet-back-btn");
    if (back) back.addEventListener("click", function () {
      if (window.history.length > 1) window.history.back();
      else PolarisRouter.go("more/subnets", { replace: true });
    });

    loadSubnet(id, st, ctx.user);
  }

  function loadSubnet(id, st, user) {
    api.subnets.ips(id, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
      st.subnet = resp.subnet;
      st.ips = resp.ips || [];
      st.page = resp.page || 1;
      st.totalIps = resp.totalIps || st.ips.length;
      st.ipv6 = !!resp.ipv6;
      var topbar = document.getElementById("subnet-topbar-title");
      if (topbar) topbar.textContent = st.subnet.name || st.subnet.cidr || "Network";

      renderShell(st, user);
      mountRefreshButton(id, st, user);

      var fab = document.getElementById("subnet-fab");
      if (fab) {
        fab.style.display = "";
        fab.addEventListener("click", function () { openReserveSheet(id, st, user, null); });
      }
    }).catch(function (err) {
      var host = document.getElementById("subnet-host");
      if (host) host.innerHTML = errorState(err && err.message ? err.message : "Failed to load network");
    });
  }


  // The refresh button lives in the topbar trailing slot. Only shown for
  // FortiGate-discovered subnets (`fortigateDevice` non-empty) AND callers
  // who can write — matches the backend's `requireUserOrAbove` guard on
  // POST /subnets/:id/refresh. Tap reconciles that single scope's CMDB
  // reservations + live leases against Polaris, then re-fetches the IP list
  // so the operator sees the result without leaving the page.
  function mountRefreshButton(id, st, user) {
    var topbar = document.querySelector("#subnet-topbar-title");
    if (!topbar) return;
    var trailing = topbar.parentElement && topbar.parentElement.querySelector(".trailing");
    if (!trailing) return;
    trailing.innerHTML = "";
    if (!st.subnet || !st.subnet.fortigateDevice || !canWrite(user)) return;

    var btn = document.createElement("button");
    btn.className = "icon-btn";
    btn.id = "subnet-refresh-btn";
    btn.setAttribute("aria-label", "Refresh from " + (st.subnet.fortigateDevice || "FortiGate"));
    btn.title = "Refresh from " + (st.subnet.fortigateDevice || "FortiGate");
    btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg>';
    trailing.appendChild(btn);

    btn.addEventListener("click", function () {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.classList.add("spinning");
      api.subnets.refresh(id).then(function (r) {
        var parts = [];
        if (r.created)  parts.push(r.created + " created");
        if (r.updated)  parts.push(r.updated + " updated");
        if (r.released) parts.push(r.released + " released");
        if (r.skipped)  parts.push(r.skipped + " skipped");
        var summary = parts.length ? parts.join(", ") : "no changes";
        PolarisTabs.showSnackbar("Refreshed " + (st.subnet.fortigateDevice || "FortiGate") + " — " + summary);
        return api.subnets.ips(id, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
          st.subnet = resp.subnet;
          st.ips = resp.ips || [];
          st.totalIps = resp.totalIps || st.ips.length;
          renderShell(st, user);
          mountRefreshButton(id, st, user);
        });
      }).catch(function (err) {
        PolarisTabs.showSnackbar(err && err.message ? err.message : "Refresh failed", { error: true });
      }).finally(function () {
        btn.disabled = false;
        btn.classList.remove("spinning");
      });
    });
  }

  function errorState(msg) {
    return ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Couldn’t load network</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  function renderShell(st, user) {
    var host = document.getElementById("subnet-host");
    if (!host) return;
    var s = st.subnet;
    var heroBits = [];
    heroBits.push('<span class="mono">' + escapeHtml(s.cidr) + '</span>');
    if (s.purpose) heroBits.push(escapeHtml(s.purpose));
    if (s.vlan) heroBits.push("VLAN " + s.vlan);
    if (s.fortigateDevice) heroBits.push(escapeHtml(s.fortigateDevice));

    var pushBadge = s.pushEligible
      ? '<span class="status-pill warn" style="margin-top:8px;display:inline-flex;"><svg viewBox="0 0 24 24" width="14" height="14" style="fill:currentColor;"><use href="#i-info"/></svg>DHCP-push network — MAC required</span>'
      : '';

    var reservedCount = st.ips.filter(function (i) { return i.reservation; }).length;
    var paged = st.ips.length < st.totalIps;

    host.innerHTML = ''
      + '<div class="asset-hero">'
      + '  <div class="hero-name">' + escapeHtml(s.name || s.cidr) + '</div>'
      + '  <div class="hero-sub">' + heroBits.join(" · ") + '</div>'
      + '  ' + pushBadge
      + '</div>'
      + '<div class="section-head">IPs<span class="count">' + reservedCount + ' reserved · ' + (st.totalIps + (paged ? "+" : "")) + ' total</span></div>'
      + '<div id="subnet-ip-list"></div>'
      + (paged ? '<div style="text-align:center;padding:12px 0 24px;color:var(--md-on-surface-variant);font-size:12px;">Showing first ' + st.ips.length + ' addresses — open network on desktop for full pagination.</div>' : '');

    renderIpList(st, user);
  }

  // Reserved rows tap-expand inline (same pattern as the Reservations
  // tab) so the operator can see full reservation details and act on
  // them — Edit / Free / Reserve-to-gate / Open asset — without having
  // to leave the Networks page. Free rows keep the original behavior:
  // tap goes straight to the Reserve sheet (creating a reservation is
  // the only thing you can do with a free row, so an extra expand
  // click would just be in the way).
  function renderIpList(st, user) {
    var host = document.getElementById("subnet-ip-list");
    if (!host) return;
    var subnetId = (PolarisRouter.current().parts || [])[0] || "";

    var html = "";
    st.ips.forEach(function (ip, idx) {
      var r = ip.reservation;
      var reserved = !!r;
      var expanded = reserved && st.expandedIp === ip.address;
      var iconHref = reserved ? "#i-bookmark" : "#i-add";
      var leadCls  = reserved ? "tonal" : "";
      var headlineMain = '<span class="mono">' + escapeHtml(ip.address) + '</span>';

      var sub = "";
      if (reserved) {
        // Same subtitle ordering as the Reservations tab: MAC first
        // (because it's the most discriminating identifier on a DHCP
        // network), hostname second.
        var bits = [];
        if (r.macAddress) bits.push('<span class="mono">' + escapeHtml(r.macAddress) + '</span>');
        if (r.hostname) bits.push(escapeHtml(r.hostname));
        if (bits.length === 0) {
          if (r.owner) bits.push(escapeHtml(r.owner));
          else if (r.sourceType && r.sourceType !== "manual") bits.push(escapeHtml(r.sourceType.replace(/_/g, " ")));
        }
        sub = bits.join(" · ");
      } else {
        sub = ip.type === "host" ? "Free" : escapeHtml(ip.type);
      }

      var trailing = reserved
        ? '<div class="trailing"><svg viewBox="0 0 24 24"><use href="' + (expanded ? "#i-chev-down" : "#i-chev-right") + '"/></svg></div>'
        : '';

      html += ''
        + '<button class="list-item' + (sub ? " two-line" : "") + '" data-ip="' + escapeHtml(ip.address) + '" data-reserved="' + (reserved ? "1" : "0") + '" data-asset="' + escapeHtml(ip.assetId || "") + '" data-type="' + escapeHtml(ip.type) + '"' + (expanded ? ' aria-expanded="true"' : '') + '>'
        + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
        + '  <div class="content">'
        + '    <div class="headline">' + headlineMain + '</div>'
        + (sub ? '    <div class="supporting">' + sub + '</div>' : '')
        + '  </div>'
        +    trailing
        + '</button>'
        + (expanded ? renderIpExpandedPanel(ip, st, subnetId, user) : '')
        + (idx < st.ips.length - 1 ? '<div class="list-divider"></div>' : '');
    });
    host.innerHTML = html;

    wireIpRowHandlers(host, st, subnetId, user);
  }

  function renderIpExpandedPanel(ip, st, subnetId, user) {
    var r = ip.reservation;
    if (!r) return '';
    var pushEligible = !!(st.subnet && st.subnet.pushEligible);

    // Row carries the subnetId (implied by the page) onto the
    // reservation object so the shared action helpers can find it.
    var rowForActions = Object.assign({}, r, { ipAddress: ip.address, subnetId: subnetId, pushEligible: pushEligible });

    var detailRows = [];
    if (r.hostname) detailRows.push(ipDetailRow("Hostname", escapeHtml(r.hostname)));
    if (r.owner)    detailRows.push(ipDetailRow("Owner", escapeHtml(r.owner)));
    if (r.sourceType) detailRows.push(ipDetailRow("Source", escapeHtml(String(r.sourceType).replace(/_/g, " "))));
    if (r.notes)    detailRows.push(ipDetailRow("Notes", escapeHtml(r.notes)));
    if (r.macAddress) detailRows.push(ipDetailRow("MAC", '<span class="mono">' + escapeHtml(r.macAddress) + '</span>'));
    if (r.expiresAt) detailRows.push(ipDetailRow("Expires", escapeHtml(_formatDateShort(r.expiresAt))));
    if (r.createdBy) detailRows.push(ipDetailRow("Created by", escapeHtml(r.createdBy)));

    var actions = window.PolarisReservationActions || {};
    var canCreate = actions.canCreate ? actions.canCreate(user) : false;
    var canModify = actions.canModify ? actions.canModify(user, rowForActions) : false;

    var buttons = [];
    var isLease = r.sourceType === "dhcp_lease";
    // A managed FortiSwitch/FortiAP row the gate only LEASES (no MAC→IP
    // reserved-address entry) is claimable exactly like a lease — the desktop IP
    // panel and the server's isSupersedableByCreate draw the same line. Rows
    // with dhcpBinding "reservation" or null stay authoritative.
    var isLeaseBackedInfra = (r.sourceType === "fortiswitch" || r.sourceType === "fortinap")
      && r.dhcpBinding === "lease";
    if ((isLease || isLeaseBackedInfra) && canCreate) {
      var reserveCls = pushEligible ? "btn-success" : "btn-filled";
      var reserveTitle = pushEligible ? "Reserve on Gate" : "Reserve in Polaris";
      buttons.push('<button class="btn ' + reserveCls + '" data-act="reserve" data-ip="' + escapeHtml(ip.address) + '" title="' + reserveTitle + '">Reserve</button>');
    }
    if (canModify) {
      buttons.push('<button class="btn btn-tonal" data-act="edit" data-ip="' + escapeHtml(ip.address) + '">Edit</button>');
      // No Release for infra rows, matching the desktop panel: discovery
      // re-creates the managed device's row next cycle, so it reads as a
      // no-op.
      if (!isLeaseBackedInfra) {
        var freeLabel = isLease ? "Revoke" : "Release";
        buttons.push('<button class="btn btn-error" data-act="free" data-ip="' + escapeHtml(ip.address) + '">' + freeLabel + '</button>');
      }
    }
    if (ip.assetId) {
      buttons.push('<button class="btn btn-text" data-act="open-asset" data-asset="' + escapeHtml(ip.assetId) + '">Open asset</button>');
    }

    var btnBar = buttons.length
      ? '<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:12px;">' + buttons.join("") + '</div>'
      : '';

    return ''
      + '<div class="reservation-expand" style="background:var(--md-surface-cont-low);padding:12px 16px 16px;border-radius:0 0 var(--shape-md) var(--shape-md);">'
      +   detailRows.join('')
      +   btnBar
      + '</div>';
  }

  function ipDetailRow(label, valueHtml) {
    return ''
      + '<div style="display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:13px;">'
      + '  <span style="color:var(--md-on-surface-variant);flex-shrink:0;">' + escapeHtml(label) + '</span>'
      + '  <span style="text-align:right;word-break:break-word;">' + valueHtml + '</span>'
      + '</div>';
  }

  function _formatDateShort(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }

  function wireIpRowHandlers(host, st, subnetId, user) {
    // Action buttons first so stopPropagation prevents the row tap
    // from collapsing the panel out from under the click target.
    host.querySelectorAll(".reservation-expand button[data-act]").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var act = btn.dataset.act;
        var ipAddr = btn.dataset.ip;
        var assetId = btn.dataset.asset;
        if (act === "open-asset" && assetId) {
          if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(assetId);
          else PolarisRouter.go("asset/" + assetId);
          return;
        }
        var ipEntry = st.ips.find(function (x) { return x.address === ipAddr; });
        if (!ipEntry || !ipEntry.reservation) return;
        var row = Object.assign({}, ipEntry.reservation, {
          ipAddress: ipAddr,
          subnetId: subnetId,
          pushEligible: !!(st.subnet && st.subnet.pushEligible),
        });
        var actions = window.PolarisReservationActions || {};
        var onSuccess = function () { st.expandedIp = null; reloadList(subnetId, st, user); };
        if (act === "edit"    && actions.edit)             actions.edit(row, user, onSuccess);
        if (act === "free"    && actions.free)             actions.free(row, user, onSuccess);
        if (act === "reserve" && actions.reserveFromLease) actions.reserveFromLease(row, user, onSuccess);
      });
    });

    host.querySelectorAll(".list-item").forEach(function (row) {
      row.addEventListener("click", function () {
        var ip = row.dataset.ip;
        var reserved = row.dataset.reserved === "1";
        var type = row.dataset.type;
        if (reserved) {
          // Toggle expansion (same as Reservations tab).
          st.expandedIp = (st.expandedIp === ip) ? null : ip;
          renderIpList(st, user);
          return;
        }
        if (type !== "host") {
          PolarisTabs.showSnackbar(ip + " — " + type + " address (not reservable)");
          return;
        }
        if (!canWrite(user)) {
          PolarisTabs.showSnackbar("Read-only role — reservations live on desktop.");
          return;
        }
        openReserveSheet(subnetId, st, user, ip);
      });
    });
  }

  // ─── Reserve sheet ─────────────────────────────────────────────────────
  // prefill: either a string (IP) for back-compat, or an object
  //   { ip?, mac?, hostname?, notes? }.
  // opts (optional):
  //   { existingLeaseId, onSuccess }
  //   existingLeaseId: marks the "promote DHCP lease to manual reservation
  //     (and push to gate)" flow invoked from the Reservations tab. The lease
  //     is NOT released here — createReservation supersedes it server-side
  //     (releaseSupersededDhcpLeaseAt), so the create is gated only on the
  //     caller's reservations:write. Retained for call-site clarity.
  //   onSuccess: callback fired after a successful create. When omitted,
  //     the subnet-detail page reloads its IP list (legacy behavior).
  function openReserveSheet(subnetId, st, user, prefill, opts) {
    closeReserveSheet();

    var s = st.subnet;
    var pushEligible = !!s.pushEligible;
    var pf = (prefill && typeof prefill === "object") ? prefill : { ip: prefill || "" };
    var defaultIp = pf.ip || pickNextFreeIp(st) || "";
    opts = opts || {};

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "reserve-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "reserve-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
      + '  <h3 class="sheet-title" style="margin:0;">Reserve IP</h3>'
      + '  <button class="icon-btn" id="reserve-close-btn" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div id="reserve-error" class="hidden" style="background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'
      + '<form id="reserve-form" autocomplete="off">'
      + '  <div class="tf-outlined"><span class="lbl">IP address</span>'
      + '    <input class="field mono" id="r-ip" value="' + escapeHtml(defaultIp) + '" required>'
      + '    <div class="support">Inside ' + escapeHtml(s.cidr) + '</div>'
      + '  </div>'
      + '  <div class="tf-outlined"><span class="lbl">Hostname</span>'
      + '    <input class="field" id="r-hostname" maxlength="100" value="' + escapeHtml(pf.hostname || "") + '">'
      + '  </div>'
      + (pushEligible
        ? '  <div class="tf-outlined"><span class="lbl">MAC address *</span>'
          + '    <input class="field mono" id="r-mac" placeholder="aa:bb:cc:dd:ee:ff" required value="' + escapeHtml(pf.mac || "") + '">'
          + '    <div class="support" style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'
          + '      <span>Will be pushed to ' + escapeHtml(s.fortigateDevice || "FortiGate") + ' as a DHCP reservation.</span>'
          + '      <button type="button" class="btn btn-text" id="r-mac-gen" title="Generate a placeholder MAC for a device that isn’t racked yet — discovery replaces it with the real one once the device appears at this IP" style="font-size:13px;padding:4px 10px;flex-shrink:0;">Generate</button>'
          + '    </div>'
          + '  </div>'
        : '  <div class="tf-outlined"><span class="lbl">MAC address</span>'
          + '    <input class="field mono" id="r-mac" placeholder="optional" value="' + escapeHtml(pf.mac || "") + '">'
          + '    <div class="support" style="display:flex;justify-content:flex-end;">'
          + '      <button type="button" class="btn btn-text" id="r-mac-gen" title="Generate a placeholder MAC for a device that isn’t racked yet — discovery replaces it with the real one once the device appears at this IP" style="font-size:13px;padding:4px 10px;">Generate</button>'
          + '    </div>'
          + '  </div>')
      + '  <div class="tf-outlined"><span class="lbl">Notes</span>'
      + '    <input class="field" id="r-notes" maxlength="500" placeholder="' + (pushEligible ? "Saved to the FortiGate reservation comment" : "") + '" value="' + escapeHtml(pf.notes || "") + '">'
      + (pushEligible ? '    <div class="support" id="r-notes-budget">Saved to the FortiGate reservation comment.</div>' : '')
      + '  </div>'
      + '  <details style="margin-bottom:16px;">'
      + '    <summary style="color:var(--md-primary);font-size:14px;font-weight:500;letter-spacing:.1px;cursor:pointer;padding:8px 0;">More fields</summary>'
      + '    <div class="tf-outlined" style="margin-top:12px;"><span class="lbl">Project / ticket</span>'
      + '      <input class="field" id="r-project" maxlength="120">'
      + '    </div>'
      + '    <div class="tf-outlined"><span class="lbl">Expires (YYYY-MM-DD)</span>'
      + '      <input class="field mono" id="r-expires" placeholder="">'
      + '    </div>'
      + '  </details>'
      + '  <div style="display:flex;justify-content:flex-end;gap:8px;">'
      + '    <button type="button" class="btn btn-text" id="reserve-cancel">Cancel</button>'
      + '    <button type="submit" class="btn btn-filled" id="reserve-submit">Reserve</button>'
      + '  </div>'
      + '</form>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeReserveSheet);
    document.getElementById("reserve-close-btn").addEventListener("click", closeReserveSheet);
    document.getElementById("reserve-cancel").addEventListener("click", closeReserveSheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeReserveSheet);
    document.getElementById("reserve-form").addEventListener("submit", function (e) {
      e.preventDefault();
      onSubmit(subnetId, st, user, opts);
    });
    var genBtn = document.getElementById("r-mac-gen");
    var macInput = document.getElementById("r-mac");
    if (genBtn && macInput) {
      genBtn.addEventListener("click", function () {
        macInput.value = generateLocalMac(s ? s.macPlaceholderPrefix : null);
        macInput.focus();
        try { macInput.select(); } catch (_) {}
      });
    }
    wireNotesBudget(pushEligible, "r-notes", "r-notes-budget", "r-hostname", user && user.username);
  }

  // Live "N characters left" under Notes on a push-eligible network. The notes
  // become the FortiGate reservation's description, which the device caps at
  // 255 characters INCLUDING the "Polaris/<user>: … [<hostname>]" wrapper — so
  // the budget moves as the hostname is typed. Budget math is shared with the
  // desktop IP panel (public/js/reservation-notes.js); the server refuses an
  // over-length save either way.
  function wireNotesBudget(pushEligible, notesId, hintId, hostId, createdBy) {
    if (!pushEligible || !window.PolarisReservationNotes) return;
    var notes = document.getElementById(notesId);
    var hint = document.getElementById(hintId);
    if (!notes || !hint) return;
    var hostEl = hostId ? document.getElementById(hostId) : null;
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

  // Placeholder MAC for an IP reserved ahead of the device. Delegates to the
  // shared helper in public/js/placeholder-mac.js — this file used to carry its
  // own byte-for-byte copy of the generator, and the two drifted.
  function generateLocalMac(prefix) {
    return window.PolarisPlaceholderMac.generate(prefix);
  }

  function closeReserveSheet() {
    var s = document.getElementById("reserve-sheet");
    var sc = document.getElementById("reserve-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  function pickNextFreeIp(st) {
    for (var i = 0; i < st.ips.length; i++) {
      var ip = st.ips[i];
      if (ip.type === "host" && !ip.reservation) return ip.address;
    }
    return "";
  }

  function showReserveError(msg) {
    var el = document.getElementById("reserve-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function clearReserveError() {
    var el = document.getElementById("reserve-error");
    if (el) el.classList.add("hidden");
  }

  function onSubmit(subnetId, st, user, opts) {
    clearReserveError();
    opts = opts || {};
    var ip       = (document.getElementById("r-ip").value || "").trim();
    var hostname = (document.getElementById("r-hostname").value || "").trim();
    var mac      = (document.getElementById("r-mac") ? document.getElementById("r-mac").value || "" : "").trim();
    var notes    = (document.getElementById("r-notes") ? document.getElementById("r-notes").value || "" : "").trim();
    var project  = (document.getElementById("r-project") ? document.getElementById("r-project").value || "" : "").trim();
    var expires  = (document.getElementById("r-expires") ? document.getElementById("r-expires").value || "" : "").trim();

    if (!ip) { showReserveError("IP address is required"); return; }
    var body = { subnetId: subnetId, ipAddress: ip };
    if (hostname) body.hostname = hostname;
    if (mac) body.macAddress = mac;
    if (notes) body.notes = notes;
    if (project) body.projectRef = project;
    if (expires) body.expiresAt = expires;

    var btn = document.getElementById("reserve-submit");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';

    // Promoting a DHCP lease is a plain create — a dhcp_lease is observed
    // device presence, not a user-owned reservation, so createReservation
    // supersedes it server-side (releaseSupersededDhcpLeaseAt) rather than
    // requiring a separate ownership-gated release. This is what lets a
    // reservations:write user (who didn't "create" the lease) reserve the IP.
    // existingLeaseId is no longer needed but kept in the opts contract for
    // call-site clarity.
    api.reservations.create(body).then(function () {
      closeReserveSheet();
      PolarisTabs.showSnackbar("Reserved " + ip);
      if (typeof opts.onSuccess === "function") opts.onSuccess();
      else reloadList(subnetId, st, user);
    }).catch(function (err) {
      btn.disabled = false;
      btn.innerHTML = "Reserve";
      showReserveError(err && err.message ? err.message : "Reservation failed");
    });
  }

  function reloadList(subnetId, st, user) {
    api.subnets.ips(subnetId, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
      st.ips = resp.ips || [];
      st.totalIps = resp.totalIps || st.ips.length;
      renderIpList(st, user);
    }).catch(function () { /* ignore */ });
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  // Pull-to-refresh — for FortiGate-discovered subnets that the caller can
  // write to, this fires the same single-scope refresh as the topbar
  // button (reconciles CMDB reservations + leases against the FortiGate),
  // then re-pulls IPs. For other subnets it just re-pulls the IP list.
  // Either way returns a promise so the PTR puck spins until done.
  function refreshFromPtr(ctx) {
    var id = (ctx && ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (!id) return null;
    var st = mountState(id);
    var user = ctx && ctx.user;
    var canRefreshFromGate = st.subnet && st.subnet.fortigateDevice && canWrite(user);
    var prePull = canRefreshFromGate
      ? api.subnets.refresh(id).then(function (r) {
          var parts = [];
          if (r.created)  parts.push(r.created + " created");
          if (r.updated)  parts.push(r.updated + " updated");
          if (r.released) parts.push(r.released + " released");
          if (r.skipped)  parts.push(r.skipped + " skipped");
          var summary = parts.length ? parts.join(", ") : "no changes";
          PolarisTabs.showSnackbar("Refreshed " + (st.subnet.fortigateDevice || "FortiGate") + " — " + summary);
        }, function (err) {
          PolarisTabs.showSnackbar(err && err.message ? err.message : "Refresh failed", { error: true });
        })
      : Promise.resolve();
    return prePull.then(function () {
      return api.subnets.ips(id, { page: 1, pageSize: IP_PAGE_SIZE }).then(function (resp) {
        st.subnet = resp.subnet;
        st.ips = resp.ips || [];
        st.totalIps = resp.totalIps || st.ips.length;
        renderShell(st, user);
        mountRefreshButton(id, st, user);
      });
    }).catch(function (err) {
      PolarisTabs.showSnackbar(err && err.message ? err.message : "Reload failed", { error: true });
    });
  }

  window.PolarisSubnetDetail = {
    spec: {
      parentTab: null,
      renderTopbar: renderTopbar,
      render: render,
      onPullToRefresh: refreshFromPtr,
    },
  };

  // ─── Cross-tab reserve-sheet entry point ───────────────────────────────
  // Used by the Reservations tab to promote a DHCP lease into a Polaris-
  // pushed manual reservation without navigating to the subnet detail page.
  // Loads a minimal subnet shell (so we know pushEligible + fortigateDevice
  // for the form's required-MAC + comment-field hints) then opens the same
  // reserve sheet the subnet detail page uses.
  window.PolarisReserveSheet = {
    open: function (subnetId, user, prefill, opts) {
      if (!subnetId) return;
      api.subnets.ips(subnetId, { page: 1, pageSize: 1 }).then(function (resp) {
        var st = { subnet: resp.subnet, ips: resp.ips || [], page: 1, totalIps: resp.totalIps || 0, ipv6: !!resp.ipv6, loading: false };
        openReserveSheet(subnetId, st, user, prefill, opts);
      }).catch(function (err) {
        PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not load network", { error: true });
      });
    },
  };
})();
