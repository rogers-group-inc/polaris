// public/js/mobile/alerts-tab.js — Alerts tab.
//
// Every active alert the viewer can see, filterable and sortable, in the
// navbar slot the Device Map used to hold (the map moved under More). It was
// the More → Alerts sub-page; it is also the push deep-link destination
// (PUSH_DEEP_LINK_PATHS.mobile in src/utils/notificationTemplate.ts), and
// app.js sends an old #more/alerts link here, since a push already sitting in
// a tray keeps the URL it was sent with.
//
// Filtering and sorting are client-side over one fetch of up to 500 active
// alerts (the endpoint's cap). The server can filter and sort too, but its
// severity order is the column's TEXT order, which puts "warning" above
// "critical" — severity here ranks by PolarisMobileAlerts.sevRank, the phone's
// mirror of ALERT_SEVERITY_RANK. When more than 500 are active the count line
// says so rather than letting the list read as complete.
//
// Acknowledging happens here (alerts:write): the phone is where an alert is
// usually READ, so making it desktop-only meant the person holding the pager
// couldn't stop an escalation chain. Clearing stays on desktop — it is the
// destructive half and needs fullwrite.

(function () {
  var PREFS_KEY = "polaris-mobile-alerts-list";
  var FETCH_LIMIT = 500;
  var DEFAULTS = { sortKey: "triggeredAt", sortDir: "desc", state: "all", severity: [] };

  var SORTS = [
    { key: "triggeredAt", label: "Time",     defaultDir: "desc" },
    { key: "severity",    label: "Severity", defaultDir: "desc" },
    { key: "device",      label: "Device",   defaultDir: "asc" },
  ];

  var STATE_CHIPS = [
    { key: "all",   label: "All" },
    { key: "unack", label: "Unacknowledged" },
    { key: "ack",   label: "Acknowledged" },
  ];

  // Severity filter, by RANK — "error" and "critical" are one rank, as are
  // "info" and "informational", so a pick catches both spellings.
  var SEVERITY_OPTIONS = [
    { value: "",  label: "Any" },
    { value: "5", label: "Critical" },
    { value: "4", label: "Serious" },
    { value: "3", label: "Warning" },
    { value: "2", label: "Informational" },
    { value: "1", label: "Notice" },
  ];

  var _state = {
    rows: null,        // as fetched; null until the first load lands
    total: 0,
    error: null,
    filter: "",        // not persisted — see list-controls.js
    prefs: null,
    user: null,
    seq: 0,
  };

  var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
  function permAtLeast(user, key, level) {
    var have = (user && user.permissions && user.permissions[key]) || "none";
    return (_PERM_RANK[have] || 0) >= (_PERM_RANK[level] || 0);
  }

  function sevRank(sev) {
    if (window.PolarisMobileAlerts && PolarisMobileAlerts.sevRank) return PolarisMobileAlerts.sevRank(sev);
    return 0;
  }

  function prefs() {
    if (!_state.prefs) _state.prefs = PolarisListControls.loadPrefs(PREFS_KEY, DEFAULTS);
    var p = _state.prefs;
    if (!SORTS.some(function (s) { return s.key === p.sortKey; })) p.sortKey = DEFAULTS.sortKey;
    if (!STATE_CHIPS.some(function (c) { return c.key === p.state; })) p.state = DEFAULTS.state;
    p.severity = (p.severity || []).filter(function (v) {
      return SEVERITY_OPTIONS.some(function (o) { return o.value !== "" && o.value === v; });
    });
    return p;
  }

  // The chip names a severity filter hidden in the sheet (canon-mobile.md §
  // Mobile list toolbar): up to two by name, a count beyond that.
  function sortLabel() {
    var p = prefs();
    var s = SORTS.find(function (x) { return x.key === p.sortKey; });
    var label = s ? s.label : "Sort";
    if (p.severity.length > 2) return label + " · " + p.severity.length + " severities";
    if (p.severity.length) {
      return label + " · " + p.severity.map(function (v) {
        var o = SEVERITY_OPTIONS.find(function (x) { return x.value === v; });
        return o ? o.label : v;
      }).join(", ");
    }
    return label;
  }

  var Alerts = {
    title: "Alerts",
    icon: "#i-bell",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Alerts</div>'
        + '  <div class="trailing">'
        + '    <button class="icon-btn" id="alerts-refresh-btn" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
        + '  </div>'
        + '</div>';
    },
    render: function (body, ctx) {
      _state.user = (ctx && ctx.user) || null;
      var p = prefs();
      body.innerHTML = ''
        + PolarisListControls.toolbarHTML({
            id: "alerts",
            placeholder: "Filter alerts",
            value: _state.filter,
            sortLabel: sortLabel(),
            dir: p.sortDir,
            active: p.severity.length > 0,
          })
        + '<div class="chip-row" id="alerts-chips"></div>'
        + '<div id="alerts-list-host"></div>';

      PolarisListControls.wireToolbar("alerts", {
        onFilter: function (text) {
          if (text === _state.filter) return;
          _state.filter = text;
          renderList();
        },
        onSort: openSortSheet,
      });

      var refresh = document.getElementById("alerts-refresh-btn");
      if (refresh) refresh.addEventListener("click", function () {
        refresh.disabled = true;
        load(true).finally(function () { refresh.disabled = false; });
      });

      renderChips();
      // Paint what we have at once (coming back from another tab), then
      // re-pull: alerts fire and clear between visits.
      if (_state.rows) renderList();
      return load(!!_state.rows);
    },
    onPullToRefresh: function () {
      return load(true);
    },
  };

  /** Fetch the active list. `quiet` keeps the rows on screen while it lands. */
  function load(quiet) {
    var mySeq = ++_state.seq;
    if (!quiet) {
      var host = document.getElementById("alerts-list-host");
      if (host) host.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
    }
    return api.alerts.list({ limit: FETCH_LIMIT }).then(function (resp) {
      if (mySeq !== _state.seq) return;
      _state.rows = (resp && resp.notifications) || [];
      _state.total = (resp && typeof resp.total === "number") ? resp.total : _state.rows.length;
      _state.error = null;
      renderList();
    }).catch(function (err) {
      if (mySeq !== _state.seq) return;
      _state.error = (err && err.message) || "Failed to load alerts";
      if (!_state.rows) renderList();
      else PolarisTabs.showSnackbar(_state.error, { error: true });
    });
  }

  function renderChips() {
    var row = document.getElementById("alerts-chips");
    if (!row) return;
    var p = prefs();
    row.innerHTML = STATE_CHIPS.map(function (c) {
      var sel = c.key === p.state;
      return ''
        + '<button class="chip ' + (sel ? "selected" : "") + '" data-key="' + c.key + '">'
        + (sel ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '')
        + escapeHtml(c.label)
        + '</button>';
    }).join("");
    row.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.dataset.key === prefs().state) return;
        _state.prefs.state = btn.dataset.key;
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
      filters: [{ key: "severity", label: "Severity", options: SEVERITY_OPTIONS, value: p.severity, multi: true }],
      onApply: function (choice) {
        _state.prefs.sortKey = choice.sortKey;
        _state.prefs.sortDir = choice.sortDir;
        _state.prefs.severity = choice.filters.severity || [];
        PolarisListControls.savePrefs(PREFS_KEY, _state.prefs);
        PolarisListControls.updateSortChip("alerts", sortLabel(), choice.sortDir, _state.prefs.severity.length > 0);
        renderList();
      },
    });
  }

  // ─── Filter + sort (pure; exposed for tests) ───────────────────────────
  function filterRows(rows, text, state, severities) {
    var terms = String(text || "").toLowerCase().split(/\s+/).filter(Boolean);
    var sevs = (severities || []).map(Number);
    return rows.filter(function (n) {
      if (state === "unack" && n.acknowledged) return false;
      if (state === "ack" && !n.acknowledged) return false;
      if (sevs.length && sevs.indexOf(sevRank(n.severity)) === -1) return false;
      if (!terms.length) return true;
      var h = [n.assetHostname, n.message, n.severity, n.dimension, n.acknowledgedBy]
        .filter(Boolean).join("\n").toLowerCase();
      // Every term must appear — "core loss" narrows, it doesn't widen.
      return terms.every(function (t) { return h.indexOf(t) >= 0; });
    });
  }

  function timeOf(n) {
    var t = n.triggeredAt ? new Date(n.triggeredAt).getTime() : NaN;
    return isNaN(t) ? null : t;
  }

  function sortRows(rows, key, dir) {
    var sign = dir === "asc" ? 1 : -1;
    var decorated = rows.map(function (n, i) {
      var v;
      if (key === "severity")    v = sevRank(n.severity);
      else if (key === "device") v = n.assetHostname ? String(n.assetHostname).toLowerCase() : null;
      else                       v = timeOf(n);
      return { n: n, v: v, t: timeOf(n) || 0, i: i };
    });
    decorated.sort(function (a, b) {
      // Rows with no value sort last in BOTH directions — an alert whose
      // device is gone is not "before" every hostname.
      var an = a.v == null, bn = b.v == null;
      if (an || bn) return an === bn ? b.t - a.t || a.i - b.i : (an ? 1 : -1);
      var c = a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
      if (c !== 0) return c * sign;
      // Ties (same severity, same device) read newest first.
      return b.t - a.t || a.i - b.i;
    });
    return decorated.map(function (d) { return d.n; });
  }

  // ─── Render ────────────────────────────────────────────────────────────
  function emptyState(title, desc) {
    return ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg></div>'
      + '  <div class="ttl">' + escapeHtml(title) + '</div>'
      + '  <div class="desc">' + escapeHtml(desc) + '</div>'
      + '</div>';
  }

  function formatTimeAgo(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return timeAgo(iso);
  }

  function renderList() {
    var host = document.getElementById("alerts-list-host");
    if (!host) return;

    if (!_state.rows) {
      if (_state.error) {
        host.innerHTML = ''
          + '<div class="empty-state" style="padding-top:48px;">'
          + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
          + '  <div class="ttl">Couldn’t load alerts</div>'
          + '  <div class="desc">' + escapeHtml(_state.error) + '</div>'
          + '</div>';
      }
      return;
    }

    if (_state.rows.length === 0) {
      host.innerHTML = emptyState("No active alerts", "Nothing is firing right now.");
      return;
    }

    var p = prefs();
    var shown = sortRows(filterRows(_state.rows, _state.filter, p.state, p.severity), p.sortKey, p.sortDir);

    if (shown.length === 0) {
      host.innerHTML = emptyState("No matching alerts", "Nothing matches this filter. Clear it or pick “All”.");
      return;
    }

    var canAck = permAtLeast(_state.user, "alerts", "write");
    var html = '<div class="alert-list">';
    shown.forEach(function (n, i) {
      html += rowHTML(n, canAck) + (i < shown.length - 1 ? '<div class="list-divider"></div>' : '');
    });
    var loaded = _state.rows.length;
    var count = shown.length === loaded
      ? shown.length + ' alert' + (shown.length === 1 ? '' : 's')
      : shown.length + ' of ' + loaded + ' alerts';
    if (_state.total > loaded) count += ' · newest ' + loaded + ' of ' + _state.total + ' active';
    html += '</div><div class="list-count">' + escapeHtml(count) + '</div>';
    host.innerHTML = html;
    wireListHost(host);
  }

  function rowHTML(n, canAck) {
    var sev = n.severity || "info";
    var rank = sevRank(sev);
    var leadCls = rank >= 5 ? "error" : (rank >= 3 ? "warning" : "");
    var iconHref = rank >= 5 ? "#i-down-arrow" : (rank >= 3 ? "#i-warn" : "#i-info");
    var meta = formatTimeAgo(n.triggeredAt);
    if (n.acknowledged) meta += " · acknowledged" + (n.acknowledgedBy ? " by " + n.acknowledgedBy : "");
    // The Ack control is a sibling of the row button, not inside it —
    // nesting a <button> inside a <button> is invalid and swallows the tap
    // that opens the device.
    var showAck = canAck && !n.acknowledged;
    return ''
      + '<div class="alert-row" style="display:flex;align-items:stretch;">'
      + '<button class="list-item three-line" style="flex:1;min-width:0;" data-aid="' + escapeHtml(n.assetId || "") + '">'
      + '  <span class="leading ' + leadCls + '"><svg viewBox="0 0 24 24"><use href="' + iconHref + '"/></svg></span>'
      + '  <div class="content">'
      + '    <div class="headline">' + escapeHtml(sev.toUpperCase()) + (n.assetHostname ? " · " + escapeHtml(n.assetHostname) : "") + '</div>'
      + '    <div class="supporting" style="white-space:normal;">' + escapeHtml(n.message || "") + '</div>'
      + '    <div class="supporting mono" style="font-size:12px;color:var(--md-on-surface-variant);margin-top:4px;">' + escapeHtml(meta) + '</div>'
      + '  </div>'
      + '</button>'
      + (showAck
        ? '<button class="ack-btn" data-ack="' + escapeHtml(n.id) + '" aria-label="Acknowledge alert"'
          + (n.requireAckNote ? ' data-note-required="1"' : "")
          + ' style="flex:0 0 auto;align-self:center;margin-right:12px;padding:8px 12px;border-radius:20px;'
          + 'border:1px solid var(--md-outline);background:transparent;color:var(--md-primary);font:inherit;font-size:13px;">Ack</button>'
        : '')
      + '</div>';
  }

  // One delegated listener on the host, attached once.
  function wireListHost(host) {
    if (host.dataset.listWired === "1") return;
    host.dataset.listWired = "1";
    host.addEventListener("click", function (ev) {
      var t = ev.target && ev.target.closest ? ev.target : null;
      if (!t) return;
      var ack = t.closest("[data-ack]");
      if (ack) {
        ev.stopPropagation();
        acknowledge(ack);
        return;
      }
      var row = t.closest(".list-item");
      if (!row) return;
      var aid = row.dataset.aid;
      // The alert may outlive its asset (assetId is nullable and the
      // hostname is snapshotted), so only navigate when there's one.
      if (!aid) return;
      if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(aid);
      else PolarisRouter.go("asset/" + aid);
    });
  }

  // Acknowledge from the phone — one tap, unless the alert's automation
  // requires a note. The note prompt is PolarisMobileAlerts.promptAckNote, a
  // sheet shared with the per-asset alerts sheet: window.prompt is suppressed
  // in some installed PWAs, and two copies is two places for the
  // required-field rule to drift.
  async function acknowledge(btn) {
    if (btn.disabled) return;
    var note;
    if (btn.dataset.noteRequired === "1") {
      note = await PolarisMobileAlerts.promptAckNote(1);
      if (note === null) return; // dismissed
    }
    btn.disabled = true;
    var old = btn.textContent;
    btn.textContent = "…";
    return api.alerts.acknowledge([btn.dataset.ack], note || undefined)
      .then(function () {
        PolarisTabs.showSnackbar("Alert acknowledged");
        return load(true);
      })
      .catch(function (err) {
        PolarisTabs.showSnackbar((err && err.message) || "Couldn't acknowledge", { error: true });
        btn.disabled = false;
        btn.textContent = old;
      });
  }

  // escapeHtml / timeAgo are the canonical globals from api.js.

  window.PolarisAlertsTab = {
    spec: Alerts,
    // Exposed for tests.
    filterRows: filterRows,
    sortRows: sortRows,
    _reset: function () { _state.rows = null; _state.total = 0; _state.error = null; _state.filter = ""; _state.prefs = null; _state.seq = 0; },
  };
})();
