// public/js/mobile/assets-tab.js — Assets list tab.
//
// Card feed of every asset, filterable by type via the chip row at the
// top. Tapping a card navigates to the asset detail route (real renderer
// arrives in Phase 5; Phase 4 lands on the placeholder).
//
// A card with live alerts additionally carries a strobing "Alerts" flag next
// to the hostname, coloured by the worst one — tapping it opens the alerts
// sheet for that device (acknowledge / clear, per the operator's role) rather
// than the device itself. Both the flag's markup and the sheet live in
// mobile/alerts.js; this file supplies the summary that rides the list
// payload and repaints the flag when the sheet hands back a new one.
//
// Above the chips sits the shared filter field + "Sort & filter" chip
// (mobile/list-controls.js). The text rides the route's `search` param, the
// sheet's status filter its `monitor` param, and the sort its sortBy/sortDir
// — all server-side, because the list is paged. The topbar no longer carries
// a search button: it only jumped to the Search tab, which the search bar
// above every page already reaches.
//
// State management: filter + asset list are kept on the module so a
// re-render (e.g. snapping back from a detail screen) can repopulate
// without re-fetching. Re-fetch on filter change.

(function () {
  // Asset type → leading icon + avatar class. Keep this in sync with the
  // .ico-* color tokens in mobile.css.
  var TYPE_META = {
    firewall:     { icon: "#i-shield",       cls: "ico-fw",    label: "Firewalls" },
    switch:       { icon: "#i-switch-icon",  cls: "ico-sw",    label: "Switches" },
    access_point: { icon: "#i-wifi",         cls: "ico-ap",    label: "APs" },
    router:       { icon: "#i-router",       cls: "ico-rtr",   label: "Routers" },
    server:       { icon: "#i-server",       cls: "ico-srv",   label: "Servers" },
    workstation:  { icon: "#i-desktop",      cls: "ico-wks",   label: "Workstations" },
    printer:      { icon: "#i-printer",      cls: "ico-prn",   label: "Printers" },
    other:        { icon: "#i-server",       cls: "ico-other", label: "Other" },
  };

  // Filter chips, in display order. `type` null = no assetType filter.
  var FILTERS = [
    { key: "all",          label: "All",          type: null },
    { key: "firewall",     label: "Firewalls",    type: "firewall" },
    { key: "switch",       label: "Switches",     type: "switch" },
    { key: "access_point", label: "APs",          type: "access_point" },
    { key: "router",       label: "Routers",      type: "router" },
    { key: "server",       label: "Servers",      type: "server" },
    { key: "workstation",  label: "Workstations", type: "workstation" },
    { key: "printer",      label: "Printers",     type: "printer" },
    { key: "other",        label: "Other",        type: "other" },
  ];

  var PAGE_SIZE = 50;

  // Sort + filter run SERVER-side — the list is paged, so a client sort would
  // only order the pages already loaded. Keys are the route's own sortBy
  // whitelist (ASSET_SORT_COLUMNS in src/api/routes/assets.ts) and its
  // `monitor` chip vocabulary (monitorClause), so nothing here can ask for a
  // sort or a filter the server would refuse. "Recently added" is the
  // server's default order (no sortBy), which is what the list always showed.
  var PREFS_KEY = "polaris-mobile-assets-list";
  var DEFAULTS = { sortKey: "", sortDir: "desc", monitor: "" };
  var SORTS = [
    { key: "",          label: "Recently added", defaultDir: "desc" },
    { key: "hostname",  label: "Name",           defaultDir: "asc" },
    { key: "ipAddress", label: "IP address",     defaultDir: "asc" },
    { key: "_monitor",  label: "Status",         defaultDir: "asc" },
    { key: "assetType", label: "Type",           defaultDir: "asc" },
    { key: "lastSeen",  label: "Last seen",      defaultDir: "desc" },
  ];
  var MONITOR_FILTER = {
    key: "monitor",
    label: "Status",
    options: [
      { value: "",            label: "Any" },
      { value: "Down",        label: "Down" },
      { value: "Missed",      label: "Missed" },
      { value: "Dep. Down",   label: "Dep. Down" },
      { value: "Recovering",  label: "Recovering" },
      { value: "Up",          label: "Up" },
      { value: "Monitored",   label: "Monitored" },
      { value: "Unmonitored", label: "Unmonitored" },
    ],
  };

  var _state = {
    filterKey: "all",
    search: "",      // filter-field text; not persisted (see list-controls.js)
    prefs: null,
    assets: [],      // accumulated rows
    total: 0,
    offset: 0,
    loading: false,
    // Monotonic sequence — incremented on every loadPage() call and checked
    // when the response arrives. Lets us drop stale results after a filter
    // change without needing AbortController support in api.js.
    seq: 0,
  };

  var Assets = {
    title: "Assets",
    icon: "#i-list",
    renderTopbar: function () {
      return ''
        + '<div class="m3-topbar">'
        + '  <div class="leading"></div>'
        + '  <div class="title">Assets</div>'
        + '  <div class="trailing"></div>'
        + '</div>';
    },
    render: function (body) {
      var p = prefs();
      body.innerHTML = ''
        + PolarisListControls.toolbarHTML({
            id: "assets",
            placeholder: "Filter assets",
            value: _state.search,
            sortLabel: sortLabel(),
            dir: p.sortDir,
            active: !!p.monitor,
          })
        + '<div class="chip-row" id="assets-chips"></div>'
        + '<div id="assets-list-host"></div>';

      PolarisListControls.wireToolbar("assets", {
        debounceMs: 350,
        onFilter: function (text) {
          if (text === _state.search) return;
          _state.search = text;
          reload();
        },
        onSort: openSortSheet,
      });

      renderChips();
      // Reset list state on every fresh render — operators expect tapping
      // the Assets tab to give them a clean view, not the leftover scroll
      // from yesterday.
      _state.assets = [];
      _state.offset = 0;
      _state.total = 0;
      loadPage(true);
    },
    onPullToRefresh: function () {
      // Reset paging + re-fetch the first page under the current filter.
      _state.assets = [];
      _state.offset = 0;
      _state.total = 0;
      return loadPage(true);
    },
  };

  function prefs() {
    if (!_state.prefs) _state.prefs = PolarisListControls.loadPrefs(PREFS_KEY, DEFAULTS);
    var p = _state.prefs;
    if (!SORTS.some(function (s) { return s.key === p.sortKey; })) p.sortKey = DEFAULTS.sortKey;
    if (p.sortDir !== "asc" && p.sortDir !== "desc") p.sortDir = DEFAULTS.sortDir;
    if (!MONITOR_FILTER.options.some(function (o) { return o.value === p.monitor; })) p.monitor = DEFAULTS.monitor;
    return p;
  }

  function sortLabel() {
    var p = prefs();
    var s = SORTS.find(function (x) { return x.key === p.sortKey; });
    var label = s ? s.label : "Sort";
    // The status filter lives in the sheet, so the chip names it — a list
    // narrowed by something the operator can't see reads as missing assets.
    if (p.monitor) {
      var m = MONITOR_FILTER.options.find(function (o) { return o.value === p.monitor; });
      if (m) label += " · " + m.label;
    }
    return label;
  }

  // Reset paging and re-fetch the first page under the current filters.
  function reload() {
    _state.assets = [];
    _state.offset = 0;
    _state.total = 0;
    return loadPage(true);
  }

  function openSortSheet() {
    var p = prefs();
    PolarisListControls.openSortSheet({
      sortOptions: SORTS,
      sortKey: p.sortKey,
      sortDir: p.sortDir,
      filters: [Object.assign({ value: p.monitor }, MONITOR_FILTER)],
      onApply: function (choice) {
        var changed = choice.sortKey !== p.sortKey || choice.sortDir !== p.sortDir
          || choice.filters.monitor !== p.monitor;
        if (!changed) return;
        p.sortKey = choice.sortKey;
        p.sortDir = choice.sortDir;
        p.monitor = choice.filters.monitor || "";
        PolarisListControls.savePrefs(PREFS_KEY, p);
        PolarisListControls.updateSortChip("assets", sortLabel(), p.sortDir, !!p.monitor);
        reload();
      },
    });
  }

  function renderChips() {
    var row = document.getElementById("assets-chips");
    if (!row) return;
    row.innerHTML = FILTERS.map(function (f) {
      var sel = f.key === _state.filterKey;
      return ''
        + '<button class="chip ' + (sel ? "selected" : "") + '" data-key="' + f.key + '">'
        + (sel ? '<svg viewBox="0 0 24 24"><use href="#i-check"/></svg>' : '')
        + escapeHtml(f.label)
        + '</button>';
    }).join("");
    row.querySelectorAll(".chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var key = btn.dataset.key;
        if (key === _state.filterKey) return;
        _state.filterKey = key;
        _state.assets = [];
        _state.offset = 0;
        _state.total = 0;
        renderChips();
        loadPage(true);
      });
    });
  }

  function loadPage(replace) {
    var filter = FILTERS.find(function (f) { return f.key === _state.filterKey; }) || FILTERS[0];
    _state.seq++;
    var thisSeq = _state.seq;
    _state.loading = true;
    // Paint the pending state. On a Load more that is just the button going
    // to its spinner, so refresh that node rather than re-rendering every
    // card already on screen (this call was the second full rebuild per tap).
    if (replace || !refreshFooter()) renderList();

    var params = { limit: PAGE_SIZE, offset: _state.offset };
    if (filter.type) params.assetType = filter.type;
    var p = prefs();
    if (_state.search) params.search = _state.search;
    if (p.monitor) params.monitor = p.monitor;
    if (p.sortKey) { params.sortBy = p.sortKey; params.sortDir = p.sortDir; }

    return api.assets.list(params).then(function (resp) {
      if (thisSeq !== _state.seq) return; // superseded by a later filter change
      _state.loading = false;
      if (!resp) return;
      var fresh = Array.isArray(resp.assets) ? resp.assets : [];
      _state.total = resp.total || fresh.length;
      _state.assets = replace ? fresh : _state.assets.concat(fresh);
      _state.offset = (replace ? 0 : _state.offset) + fresh.length;
      // Append the new page's cards when we can; fall back to a full render
      // for a filter change, the first page, or an empty tail (where the
      // footer swaps from button to count).
      if (replace || fresh.length === 0 || !appendCards(fresh)) renderList();
    }).catch(function (err) {
      if (thisSeq !== _state.seq) return;
      _state.loading = false;
      renderError(err && err.message ? err.message : "Failed to load assets");
    });
  }

  function renderList() {
    var host = document.getElementById("assets-list-host");
    if (!host) return;

    if (_state.assets.length === 0 && _state.loading) {
      host.innerHTML = '<div class="loading-screen" style="padding:48px 0;"><div class="spinner"></div></div>';
      return;
    }
    if (_state.assets.length === 0 && !_state.loading) {
      host.innerHTML = ''
        + '<div class="empty-state" style="padding-top:48px;">'
        + '  <div class="icon"><svg viewBox="0 0 24 24"><use href="#i-list"/></svg></div>'
        + '  <div class="ttl">No assets</div>'
        + '  <div class="desc">' + (_state.search || prefs().monitor
          ? 'Nothing matches this filter. Clear it, or pick “Any” status in Sort &amp; filter.'
          : 'Nothing matches this filter. Try “All” or run a discovery to populate the inventory.') + '</div>'
        + '</div>';
      return;
    }

    var html = '<div class="asset-list">';
    _state.assets.forEach(function (a) {
      html += renderAssetCard(a);
    });
    html += '</div><div id="assets-list-footer">' + footerHTML() + '</div>';

    host.innerHTML = html;
    wireListHost(host);
  }

  // The Load-more button, or the final count once everything is in. Its own
  // node so an append can refresh it without touching the cards.
  function footerHTML() {
    if (_state.assets.length < _state.total) {
      return ''
        + '<div style="display:flex;justify-content:center;padding:8px 16px 24px;">'
        + '  <button class="btn btn-tonal" id="assets-load-more"' + (_state.loading ? ' disabled' : '') + '>'
        + '    ' + (_state.loading
          ? '<span class="spinner" style="width:16px;height:16px;border-width:2px;"></span> Loading…'
          : 'Load more (' + (_state.total - _state.assets.length) + ' remaining)')
        + '  </button>'
        + '</div>';
    }
    return '<div style="text-align:center;padding:16px 16px 24px;color:var(--md-on-surface-variant);font-size:12px;letter-spacing:.5px;">' + _state.assets.length + ' asset' + (_state.assets.length === 1 ? "" : "s") + '</div>';
  }

  function refreshFooter() {
    var f = document.getElementById("assets-list-footer");
    if (!f) return false;
    f.innerHTML = footerHTML();
    return true;
  }

  // ONE delegated listener on the host instead of one per card, attached once.
  // Walking a 2000-asset fleet is 40 taps of Load more, and the old shape
  // re-attached a listener to every ACCUMULATED card on each one — tens of
  // thousands of attachments on a phone, on top of rebuilding every card.
  function wireListHost(host) {
    if (host.dataset.listWired === "1") return;
    host.dataset.listWired = "1";
    host.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var more = t.closest("#assets-load-more");
      if (more) {
        if (!more.disabled) loadPage(false);
        return;
      }
      // The alert flag is checked BEFORE the card: it lives inside the card,
      // so a tap on it matches both and the more specific one has to win, or
      // "show me what is wrong with this device" would open the device.
      var flag = t.closest(".alert-flag");
      if (flag) {
        var fcard = flag.closest(".asset-card");
        if (fcard) openAlertsFor(fcard.dataset.id);
        return;
      }
      var card = t.closest(".asset-card");
      if (!card) return;
      var id = card.dataset.id;
      if (!id) return;
      if (window.PolarisAssetDetail && PolarisAssetDetail.open) PolarisAssetDetail.open(id);
      else PolarisRouter.go("asset/" + id);
    });
    // The card stopped being a <button> when the alert flag (a real button)
    // moved inside it, so Enter/Space activation is supplied here. A key
    // pressed on the flag itself is left alone — it is still a button and
    // fires its own click, which the listener above already handles.
    host.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " " && ev.key !== "Spacebar") return;
      var t = ev.target;
      if (!t || !t.closest) return;
      if (!t.classList || !t.classList.contains("asset-card")) return;
      ev.preventDefault();
      t.click();
    });
  }

  // Append-only render for a Load more: the page's cards go on the end of the
  // existing list. Rebuilding the whole accumulated set per tap made the walk
  // to 2000 assets quadratic in DOM work (~82k card renders across 40 taps),
  // and the last tap alone destroyed and rebuilt 2000 cards.
  function appendCards(fresh) {
    var host = document.getElementById("assets-list-host");
    if (!host) return false;
    var list = host.querySelector(".asset-list");
    if (!list) return false;
    var holder = document.createElement("div");
    holder.innerHTML = fresh.map(renderAssetCard).join("");
    while (holder.firstChild) list.appendChild(holder.firstChild);
    refreshFooter();
    wireListHost(host);
    return true;
  }

  function renderError(msg) {
    var host = document.getElementById("assets-list-host");
    if (!host) return;
    host.innerHTML = ''
      + '<div class="empty-state" style="padding-top:48px;">'
      + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
      + '  <div class="ttl">Couldn’t load assets</div>'
      + '  <div class="desc">' + escapeHtml(msg) + '</div>'
      + '</div>';
  }

  function renderAssetCard(a) {
    var meta = TYPE_META[a.assetType] || TYPE_META.other;
    var dotCls = monitorDotCls(a);
    var bits = [];
    if (a.ipAddress) bits.push('<span class="mono">' + escapeHtml(a.ipAddress) + '</span>');
    var modelLine = [a.manufacturer, a.model].filter(Boolean).join(" ");
    if (modelLine) bits.push(escapeHtml(modelLine));
    if (a.location || a.learnedLocation) bits.push(escapeHtml(a.location || a.learnedLocation));
    if (!bits.length) bits.push(escapeHtml(a.assetType || "asset"));

    // A DIV, not a BUTTON, since the alert flag inside it is itself a button
    // and a nested <button> swallows the tap that opens the device (the same
    // trap the More tab's alert rows hit). Role + tabindex keep the keyboard
    // affordance the element used to carry for free; the host's keydown
    // handler supplies the Enter/Space activation a real button gave.
    return ''
      + '<div class="asset-card" role="button" tabindex="0" data-id="' + escapeHtml(a.id) + '">'
      + '  <div class="top">'
      + '    <div class="ico ' + meta.cls + '"><svg viewBox="0 0 24 24"><use href="' + meta.icon + '"/></svg></div>'
      + '    <div class="name">' + escapeHtml(a.hostname || a.assetTag || "(unnamed)") + '</div>'
      + alertFlagHTML(a)
      + (dotCls ? '    <span class="dot ' + dotCls + '" title="' + escapeHtml(monitorTitle(a)) + '"></span>' : '')
      + '  </div>'
      + '  <div class="meta">' + bits.join('<span class="muted">·</span>') + '</div>'
      + '</div>';
  }

  // ─── Active-alert flag ──────────────────────────────────────────────────
  // "Alerts" beside the hostname, strobing in the colour of the worst live
  // alert on the device — the phone's counterpart to the desktop list's dot
  // and the asset slide-over's strobing Alerts tab. The summary rides the
  // list payload already (`activeAlert`, one query per PAGE — see
  // activeAlertSummaryByAsset), so the flag costs no extra request; the
  // markup and the severity colour come from PolarisMobileAlerts so the flag
  // and the sheet it opens can't disagree about how bad this device is.
  function alertFlagHTML(a) {
    if (!window.PolarisMobileAlerts) return "";
    return PolarisMobileAlerts.flagHTML(a && a.activeAlert);
  }

  /**
   * Repaint one card's flag from a summary the sheet just recomputed, so an
   * acknowledge or a clear settles the list behind it without a re-fetch. The
   * accumulated row is updated too — a Load more re-renders from `_state`, and
   * a card rebuilt from a stale row would start strobing again.
   */
  function paintAlertFlag(assetId, summary) {
    var row = _state.assets.find(function (x) { return x.id === assetId; });
    if (row) row.activeAlert = summary || null;
    var card = null;
    document.querySelectorAll(".asset-card").forEach(function (c) {
      if (c.dataset.id === assetId) card = c;
    });
    if (!card) return;
    var top = card.querySelector(".top");
    if (!top) return;
    var existing = top.querySelector(".alert-flag");
    var html = window.PolarisMobileAlerts ? PolarisMobileAlerts.flagHTML(summary) : "";
    if (!html) { if (existing) existing.remove(); return; }
    var holder = document.createElement("div");
    holder.innerHTML = html;
    var flag = holder.firstChild;
    if (existing) top.replaceChild(flag, existing);
    else top.insertBefore(flag, top.querySelector(".dot"));   // before the status dot, or last
  }

  function openAlertsFor(assetId) {
    if (!assetId || !window.PolarisMobileAlerts) return;
    var row = _state.assets.find(function (x) { return x.id === assetId; });
    PolarisMobileAlerts.openForAsset(assetId, {
      hostname: (row && (row.hostname || row.assetTag)) || "",
      onSummary: function (summary) { paintAlertFlag(assetId, summary); },
    });
  }

  function monitorDotCls(a) {
    if (!a.monitored) return "";
    // Suppression outranks the probe state — matches desktop assetMonitorBadge.
    if (a.dependencySuppressed) return "dep-down";
    switch (a.monitorStatus) {
      case "up":      return "up";
      case "down":    return "down";
      case "warning": return "warn";
      case "recovering": return "recovering";
      case "unknown": return "unk";
      // No down-detection automation covers it — still polled, no verdict.
      case "passive": return "passive";
      default:        return "unk";
    }
  }
  function monitorTitle(a) {
    if (!a.monitored) return "Unmonitored";
    if (a.dependencySuppressed)        return "Dep. Down — upstream parent is down";
    if (a.monitorStatus === "up")      return "Up — last RTT " + (a.lastResponseTimeMs != null ? a.lastResponseTimeMs + " ms" : "n/a");
    if (a.monitorStatus === "down")    return "Down";
    // "Missed", not "Warning" — the alert severities own that word (api.js
    // POLARIS_MONITOR_STATUS_LABELS). No count here: the list payload does not
    // select consecutiveFailures, and "0 missed polls" would contradict the pill.
    if (a.monitorStatus === "warning") return "Missed — a poll failed, below the down threshold";
    if (a.monitorStatus === "recovering") return "Recovering — answering again, not yet Up";
    if (a.monitorStatus === "unknown") return "No samples yet";
    if (a.monitorStatus === "passive") return "Passive — no down-detection automation covers this device";
    return "Monitored";
  }

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  window.PolarisAssetsTab = { spec: Assets };
})();
