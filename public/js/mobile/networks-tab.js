// public/js/mobile/networks-tab.js — Networks tab.
//
// Every network, sortable and filterable, in the navbar slot the Reservations
// tab used to hold. Tapping a network opens its IP sheet over the list
// (PolarisNetworkSheet in subnet-detail.js) rather than navigating away, so
// the operator keeps their place, filter and sort.
//
// Sorting and filtering are client-side over the WHOLE list, the way the
// desktop Networks page does it (`api.subnets.list({ limit: 10000 })` in
// subnets.js): the subnets endpoint takes no search or sort, and the whole
// list is what the desktop already loads. Address order is TableSF's
// `_ipNum` (table-sf.js, loaded by mobile.html for it) — the one IPv4 + IPv6
// comparator the desktop's Network column sorts with, rather than a second
// copy of it here.
//
// The filter matches name, CIDR, purpose, VLAN, FortiGate, block and tags —
// the columns the desktop list shows. It is a substring match on text, not an
// address-containment search: "which network holds 10.1.2.3" is the global
// search bar's job, and it already answers it.

(function () {
  var PREFS_KEY = "polaris-mobile-networks-list";
  var DEFAULTS = { sortKey: "name", sortDir: "asc", status: "all" };

  var SORTS = [
    { key: "name",         label: "Name",         defaultDir: "asc" },
    { key: "cidr",         label: "Network",      defaultDir: "asc" },
    { key: "utilization",  label: "Utilization",  defaultDir: "desc" },
    { key: "reservations", label: "Reservations", defaultDir: "desc" },
    { key: "vlan",         label: "VLAN",         defaultDir: "asc" },
  ];

  // The desktop's Status column options, in its order.
  var STATUS_CHIPS = [
    { key: "all",        label: "All" },
    { key: "available",  label: "Available" },
    { key: "reserved",   label: "Reserved" },
    { key: "deprecated", label: "Deprecated" },
  ];

  var _state = {
    rows: null,        // full list, as fetched; null until the first load lands
    error: null,
    filter: "",        // not persisted — see list-controls.js
    prefs: null,
    user: null,
    seq: 0,
  };

  function prefs() {
    if (!_state.prefs) _state.prefs = PolarisListControls.loadPrefs(PREFS_KEY, DEFAULTS);
    if (!SORTS.some(function (s) { return s.key === _state.prefs.sortKey; })) _state.prefs.sortKey = DEFAULTS.sortKey;
    if (!STATUS_CHIPS.some(function (c) { return c.key === _state.prefs.status; })) _state.prefs.status = DEFAULTS.status;
    return _state.prefs;
  }

  function sortLabel() {
    var p = prefs();
    var s = SORTS.find(function (x) { return x.key === p.sortKey; });
    return s ? s.label : "Sort";
  }

  // Reservations:write — the same gate the network sheet's Reserve uses.
  function canReserve(user) {
    var actions = window.PolarisReservationActions;
    return !!(actions && actions.canCreate && actions.canCreate(user));
  }

  var Networks = {
    title: "Networks",
    icon: "#i-subnet",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Networks</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" id="networks-refresh-btn" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body, ctx) {
      _state.user = (ctx && ctx.user) || null;
      var p = prefs();
      body.innerHTML = ''
        + PolarisListControls.toolbarHTML({
            id: "networks",
            placeholder: "Filter networks",
            value: _state.filter,
            sortLabel: sortLabel(),
            dir: p.sortDir,
          })
        + '<div class="chip-row" id="networks-chips"></div>'
        + '<div id="networks-list-host"></div>'
        + (canReserve(_state.user)
          ? '<button class="fab-ext" id="networks-fab" style="position:fixed;right:16px;bottom:calc(var(--navbar-h) + 16px);z-index:30;"><svg viewBox="0 0 24 24"><use href="#i-add"/></svg>Reserve</button>'
          : '');

      PolarisListControls.wireToolbar("networks", {
        onFilter: function (text) {
          if (text === _state.filter) return;
          _state.filter = text;
          renderList();
        },
        onSort: openSortSheet,
      });

      var refresh = document.getElementById("networks-refresh-btn");
      if (refresh) refresh.addEventListener("click", function () {
        refresh.disabled = true;
        load().finally(function () { refresh.disabled = false; });
      });

      // Reserve any address: Polaris finds the network (reservation-actions.js).
      var fab = document.getElementById("networks-fab");
      if (fab) fab.addEventListener("click", function () {
        PolarisReservationActions.reserveByIp(_state.user, function () { load(true); });
      });

      renderChips();
      // Paint what we have at once (coming back from another tab), then
      // re-pull: utilization moves under the operator between visits.
      if (_state.rows) renderList();
      load(!!_state.rows);
    },
    onPullToRefresh: function () {
      return load(true);
    },
  };

  /**
   * Fetch the full list. `quiet` keeps the rows on screen while it lands —
   * every re-pull except the very first.
   */
  function load(quiet) {
    var mySeq = ++_state.seq;
    if (!quiet) {
      var host = document.getElementById("networks-list-host");
      if (host) host.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
    }
    return api.subnets.list({ limit: 10000 }).then(function (resp) {
      if (mySeq !== _state.seq) return;
      _state.rows = (resp && resp.subnets) || [];
      _state.error = null;
      renderList();
    }).catch(function (err) {
      if (mySeq !== _state.seq) return;
      _state.error = (err && err.message) || "Failed to load networks";
      if (!_state.rows) renderList();
      else PolarisTabs.showSnackbar(_state.error, { error: true });
    });
  }

  function renderChips() {
    var row = document.getElementById("networks-chips");
    if (!row) return;
    var p = prefs();
    row.innerHTML = STATUS_CHIPS.map(function (c) {
      var sel = c.key === p.status;
      return ''
        + '<button class="chip ' + (sel ? "selected" : "") + '" data-key="' + c.key + '">'
        + (sel ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '')
        + escapeHtml(c.label)
        + '</button>';
    }).join("");
    row.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.key === prefs().status) return;
        _state.prefs.status = btn.dataset.key;
        PolarisListControls.savePrefs(PREFS_KEY, _state.prefs);
        renderChips();
        renderList();
      });
    });
  }

  function openSortSheet() {
    var p = prefs();
    PolarisListControls.openSortSheet({
      sortOptions: SORTS,
      sortKey: p.sortKey,
      sortDir: p.sortDir,
      onApply: function (choice) {
        _state.prefs.sortKey = choice.sortKey;
        _state.prefs.sortDir = choice.sortDir;
        PolarisListControls.savePrefs(PREFS_KEY, _state.prefs);
        PolarisListControls.updateSortChip("networks", sortLabel(), choice.sortDir, false);
        renderList();
      },
    });
  }

  // ─── Filter + sort (pure; exposed for tests) ───────────────────────────
  function haystack(s) {
    return [
      s.name, s.cidr, s.purpose,
      s.vlan != null ? "vlan " + s.vlan : "",
      s.vlan != null ? String(s.vlan) : "",
      s.fortigateDevice,
      s.block && s.block.name,
      Array.isArray(s.tags) ? s.tags.join(" ") : "",
    ].filter(Boolean).join("\n").toLowerCase();
  }

  function filterRows(rows, text, status) {
    var terms = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
    return rows.filter(function (s) {
      if (status && status !== "all" && s.status !== status) return false;
      if (!terms.length) return true;
      var h = haystack(s);
      // Every term must appear — "vlan 20 branch" narrows, it doesn't widen.
      return terms.every(function (t) { return h.indexOf(t) >= 0; });
    });
  }

  function addrKey(cidr) {
    if (window.TableSF && TableSF.prototype && TableSF.prototype._ipNum) {
      try { return TableSF.prototype._ipNum.call(TableSF.prototype, cidr); } catch (_) { /* fall through */ }
    }
    return String(cidr || "");
  }

  function prefixLen(cidr) {
    var i = String(cidr || "").indexOf("/");
    return i >= 0 ? (parseInt(String(cidr).slice(i + 1), 10) || 0) : 0;
  }

  function sortRows(rows, key, dir) {
    var sign = dir === "desc" ? -1 : 1;
    var decorated = rows.map(function (s, i) {
      var v;
      if (key === "cidr")              v = addrKey(s.cidr);
      else if (key === "utilization")  v = s.utilizationPercent;
      else if (key === "reservations") v = s._count ? s._count.reservations : null;
      else if (key === "vlan")         v = s.vlan;
      else                             v = String(s.name || s.cidr || "").toLowerCase();
      return { s: s, v: v, i: i };
    });
    decorated.sort(function (a, b) {
      // Rows with no value sort last in BOTH directions — a network with no
      // VLAN is not "smaller" than VLAN 1.
      var an = a.v == null, bn = b.v == null;
      if (an || bn) return an === bn ? a.i - b.i : (an ? 1 : -1);
      var c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      if (c === 0 && key === "cidr") c = prefixLen(a.s.cidr) - prefixLen(b.s.cidr);
      if (c === 0 && key !== "name") {
        var na = String(a.s.name || "").toLowerCase(), nb = String(b.s.name || "").toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : a.i - b.i;
      }
      return c === 0 ? a.i - b.i : c * sign;
    });
    return decorated.map(function (d) { return d.s; });
  }

  // ─── Render ────────────────────────────────────────────────────────────
  function renderList() {
    var host = document.getElementById("networks-list-host");
    if (!host) return;

    if (!_state.rows) {
      if (_state.error) {
        host.innerHTML = ''
          + '<div class="empty-state" style="padding-top:48px;">'
          + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
          + '  <div class="ttl">Couldn’t load networks</div>'
          + '  <div class="desc">' + escapeHtml(_state.error) + '</div>'
          + '</div>';
      }
      return;
    }

    if (_state.rows.length === 0) {
      host.innerHTML = '<div class="empty-state" style="padding-top:48px;"><div class="icon"><svg viewBox="0 0 24 24"><use href="#i-subnet"/></svg></div><div class="ttl">No networks</div><div class="desc">No networks have been created yet.</div></div>';
      return;
    }

    var p = prefs();
    var shown = sortRows(filterRows(_state.rows, _state.filter, p.status), p.sortKey, p.sortDir);

    if (shown.length === 0) {
      host.innerHTML = ''
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-subnet"/></svg></div>'
        + '  <div class="ttl">No matching networks</div>'
        + '  <div class="desc">Nothing matches this filter. Clear it or pick “All”.</div>'
        + '</div>';
      return;
    }

    var html = '<div class="network-list">';
    shown.forEach(function (s, i) {
      html += rowHTML(s) + (i < shown.length - 1 ? '<div class="list-divider"></div>' : '');
    });
    html += '</div>'
      + '<div class="list-count">' + (shown.length === _state.rows.length
        ? shown.length + ' network' + (shown.length === 1 ? '' : 's')
        : shown.length + ' of ' + _state.rows.length + ' networks') + '</div>';
    host.innerHTML = html;
    wireListHost(host);
  }

  function rowHTML(s) {
    var pieces = [];
    if (s.purpose) pieces.push(escapeHtml(s.purpose));
    if (s.vlan != null && s.vlan !== "") pieces.push('VLAN ' + escapeHtml(String(s.vlan)));
    if (s.fortigateDevice) pieces.push(escapeHtml(s.fortigateDevice));
    var subtitle = '<span class="mono">' + escapeHtml(s.cidr || "") + '</span>' + (pieces.length ? ' · ' + pieces.join(' · ') : '');
    var util = s.utilizationPercent;
    var utilText = util == null ? "" : (Math.round(util) + "%");
    var held = s._count ? s._count.reservations : null;
    var status = s.status && s.status !== "available"
      ? '<span class="network-status ' + escapeHtml(s.status) + '">' + escapeHtml(s.status) + '</span>'
      : '';
    return ''
      + '<button class="list-item two-line network-row" data-id="' + escapeHtml(s.id) + '">'
      + '  <span class="leading tonal"><svg viewBox="0 0 24 24"><use href="#i-subnet"/></svg></span>'
      + '  <div class="content">'
      + '    <div class="headline">' + escapeHtml(s.name || s.cidr || "(unnamed)") + status + '</div>'
      + '    <div class="supporting">' + subtitle + '</div>'
      + '  </div>'
      + '  <div class="trailing network-util"' + (held != null && s.usableHosts ? ' title="' + held + ' of ' + s.usableHosts + ' addresses held"' : '') + '>'
      +      (utilText ? '<span class="pct">' + utilText + '</span>' : '')
      + '  </div>'
      + '</button>';
  }

  // One delegated listener on the host, attached once.
  function wireListHost(host) {
    if (host.dataset.listWired === "1") return;
    host.dataset.listWired = "1";
    host.addEventListener("click", function (ev) {
      var row = ev.target && ev.target.closest ? ev.target.closest(".network-row") : null;
      if (row && row.dataset.id) openNetwork(row.dataset.id);
    });
  }

  function openNetwork(id) {
    if (!id || !window.PolarisNetworkSheet) return;
    var row = (_state.rows || []).find(function (s) { return s.id === id; });
    PolarisNetworkSheet.open(id, _state.user || (window.PolarisMobile && PolarisMobile.user()), {
      title: row ? (row.name || row.cidr) : "Network",
      // A reservation made or released in the sheet moves this row's count
      // and utilization; re-pull quietly so the list behind it is honest.
      onChanged: function () { load(true); },
    });
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  window.PolarisNetworksTab = {
    spec: Networks,
    openNetwork: openNetwork,
    // Pure helpers, for tests.
    _filterRows: filterRows,
    _sortRows: sortRows,
  };
})();
