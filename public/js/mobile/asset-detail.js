// public/js/mobile/asset-detail.js — Asset detail slide-up sheet.
//
// The sheet shows ONE PAGE at a time (see "Page history"): the asset, or a
// page opened from it — the Dependency Tree, SD-WAN, IPsec, the ARP / MAC /
// Wireless tables, an interface, the alerts list, Storage, a volume, a drive,
// another asset.
// Opening one goes forward; the header's back / forward walk the list.
//
// Header, two rows: back, forward, then camera (screenshot — see
// screenshotSheet), refresh and close; under them the status dot and the
// asset's NAME, the full width — or, on any other page, that page's title
// over the asset's name. The NAME is a button: it opens the edit menu
// (General / Monitoring / Maintenance — the desktop Edit Asset modal's tabs,
// each as its own sheet; see mobile/asset-edit.js), and a save there
// re-reads this sheet.
//
// Sections (top to bottom):
//   - Hero with status pill + identity bits (name lives in the sheet header)
//   - Monitor section (response-time chart, status pill, RTT/last poll)
//   - Telemetry section (CPU+Memory chart, when supported; its own
//     1h / 24h / 7d range)
//   - General section (IP/MAC/type/model/OS/location/last seen)
//   - Temperatures section — current per-sensor reading + 1h min/avg/max
//   - "View IPsec" — on a Fortinet firewall that reported tunnels or peers;
//     opens the IPsec page (tunnels with their dial-up peers, remote-access
//     users). See the IPsec block.
//   - Interfaces section — IPsec tunnel twins left out (they are the IPsec
//     page's, with a line pointing there); a PoE summary (delivering / searching / fault,
//     faulted ports named) when any port reports PoE, then the list,
//     operStatus=="up" only, each row with its PoE state; tap a row opens its
//     page: status / speed / ip / mac / PoE / errors / LLDP neighbor(s), plus
//     throughput + error charts for a MONITORED interface
//   - "View Storage" — opens the Storage page (volumes; a hypervisor's arrays
//     and drives). See the Storage block.
//
// The four monitoring sections carry a polling-method chip beside the title
// (loadPollingChips, from /effective-monitor-settings).
//   - Discovery sources — per-source list (sourceKind + integration + lastSeen)
//   - Firewall sightings — which FortiGates saw this asset (needs
//     assetsQuarantine read; degrades to a muted note otherwise)
//   - IP history list
//
// Hero carries the strobing "Alerts" flag when the device has live alerts —
// the same control the Assets list card shows, in the colour of the worst one,
// tapping through to the Alerts page (acknowledge / clear, per role; drawn by
// PolarisMobileAlerts.renderInto in mobile/alerts.js). It sits on the status pill's row
// because the two together are how this device is doing.
//
// Hero also carries a Quarantine / Release Quarantine button, gated on the
// assetsQuarantine:write permission and the same eligibility as the desktop
// quarantine tab (non-infra + has a MAC to push, or already quarantined →
// Release). See quarantineButtonHtml / wireQuarantineButton.
//
// Hero's first button is "View Dependency Tree" (every asset): upstream /
// this device / downstream, each other device a link a page forward. See the
// Dependency Tree block.
//
// Hero also carries a "View SD-WAN" button for FortiGate firewalls that
// reported SD-WAN data (perf-SLA links / rules / members exist). Tapping it
// opens the SD-WAN page: Members + Rules current-state lists and a
// Performance SLA section (per-member latency / jitter / packet-loss charts
// over a selectable health-check + range). See renderSdwanPage.
//
// Below it, one current-state table button per device class — "View ARP
// Table" on a firewall, "View MAC Table" on a switch, "View Wireless" on a
// monitored access point (the desktop's ARP Table / MAC Table / Wireless
// tabs). Each opens a read-only page: ARP with a range + filter, MAC grouped
// by port, Wireless as radio → SSID → client. A matched device in any of
// them opens that asset a page forward. See renderTablePage and the
// loadArpSheet / loadMacSheet / loadWirelessSheet loaders.
//
// A switch or access point's OS row in General carries the firmware upgrade
// verb (business rule 87): "Upgrade to <version>" when the Repository holds a
// newer image and the operator has assets:write, a stacked confirm sheet, then
// "Upgrade started" and the stage / percent polled live. See the Firmware
// upgrade block (osRowValue / loadFirmwareRow / confirmFirmwareUpgrade /
// watchFirmwareRun).
//
// The phone's Back button is the header's back: a sheet stacked over this one
// (an edit sheet, a confirm) closes first, then the page history steps back,
// then the first page shrinks to its peek band, then the sheet closes — and
// only then does Back leave the page (see the "Phone Back button" block: the
// sheet keeps one history entry of its own while open).
//
// Out of scope for v1 (desktop-only):
//   - The Firmware Repository, the choice of a model's backup image, and a
//     run's history and log
//   - Per-interface charts for an UNMONITORED interface, and custom date
//     ranges on them
//   - Per-interface comments editor
//   - An IPsec tunnel's per-minute pin and its status / throughput history
//   - The dependency override and the Dependency Test
//   - SNMP walk
//   - SD-WAN rule member-selection categorical timeline (the mobile chart
//     helper is numeric-only; the SD-WAN page shows the current selected
//     member per rule, not its failover history)
//   - Per-source observed blob view (mobile shows the source summary, not the
//     full observed key/value table)

(function () {
  // Response Time chart range — driven by the segmented control on its card.
  // CPU + Memory and the interface slide-up carry their own shorter control
  // (CHART_RANGES), so each chart moves on its own.
  var DEFAULT_RANGE = "24h";
  var RANGES = ["1h", "12h", "24h", "7d", "30d"];
  var CHART_RANGES = ["1h", "24h", "7d"];
  var RANGE_MS = {
    "1h": 3600000, "12h": 12 * 3600000, "24h": 24 * 3600000,
    "7d": 7 * 86400000, "30d": 30 * 86400000,
  };
  // The [from, to] a chart of `range` covers — handed to lineChart so a
  // maintenance band can widen the axis to the window's edge. Null for a range
  // this table doesn't know, which just clips the bands to the samples.
  function rangeBounds(range) {
    var span = RANGE_MS[range];
    if (!span) return null;
    var to = Date.now();
    return { from: to - span, to: to };
  }

  // The rows a stats line may count: those at or after the window's left edge.
  // History endpoints return lookback rows before `since` only so the line
  // enters from the edge (lineChart keeps them off-plot) — the phone half of
  // `_inChartWindow` in public/js/assets.js.
  function inWindow(points, since, tsKey) {
    var list = points || [];
    var t0 = since == null ? NaN : +new Date(since);
    if (!isFinite(t0)) return list;
    var key = tsKey || "timestamp";
    return list.filter(function (p) { return !(+new Date(p && p[key]) < t0); });
  }

  // Maintenance windows for the open asset, fetched ONCE per sheet open and
  // shared by every chart on it — the phone half of `_loadMaintWindowsCache`
  // in public/js/assets.js. The lookback covers the longest range (30d) plus a
  // day's slack. Best effort: a failure means no bands, never a broken chart.
  // A section subtitle with no stats to show. "No samples" reads as a fault;
  // when a maintenance window overlaps the range, the absence is by design.
  function emptyStatsLabel(windows, range) {
    var b = rangeBounds(range);
    var overlaps = (windows || []).some(function (w) {
      var ws = +new Date(w.startedAt);
      var we = w.endedAt ? +new Date(w.endedAt) : Date.now();
      return isFinite(ws) && (!b || (we > b.from && ws < b.to));
    });
    return overlaps ? "Polling paused for maintenance" : "No samples";
  }

  var _maintWindows = { assetId: null, promise: null };
  function maintWindowsFor(id) {
    if (_maintWindows.assetId !== id || !_maintWindows.promise) {
      var now = Date.now();
      var promise = api.assets.maintenanceWindows(id, {
        from: new Date(now - 31 * 86400000).toISOString(),
        to:   new Date(now + 86400000).toISOString(),
      }).then(function (res) { return (res && res.windows) || []; })
        .catch(function () { return []; });
      _maintWindows = { assetId: id, promise: promise };
    }
    return _maintWindows.promise;
  }

  // Human labels for AssetSource.sourceKind — mirrors `_assetSourceLabels` in
  // the desktop assets.js so both surfaces name discovery sources the same.
  var SOURCE_LABELS = {
    "entra":              "Microsoft Entra ID",
    "intune":             "Microsoft Intune",
    "ad":                 "Active Directory",
    "fortigate-firewall": "FortiGate (firewall)",
    "fortiswitch":        "FortiSwitch",
    "fortiap":            "FortiAP",
    "fortigate-endpoint": "FortiGate / FortiManager (endpoint)",
    "vcenter-vm":         "VMware vCenter (VM)",
    "vcenter-host":       "VMware vCenter (ESXi host)",
    "arc":                "Azure Arc",
    "arc-k8s":            "Azure Arc (Kubernetes)",
    "polaris-agent":      "Polaris Agent",
    "manual":             "Manual / other",
  };

  // SD-WAN member palette — mirrors `_SDWAN_MEMBER_COLORS` in the desktop
  // assets.js so a given WAN member gets the same color on both surfaces.
  var _SDWAN_MEMBER_COLORS = ["#2a9d8f", "#4361ee", "#f4a261", "#9b5de5", "#e76f51", "#43aa8b", "#577590", "#bc6c25"];
  function sdwanColor(name, names) {
    if (!name) return "#7b8794";
    var i = (names || []).indexOf(name);
    if (i < 0) i = 0;
    return _SDWAN_MEMBER_COLORS[i % _SDWAN_MEMBER_COLORS.length];
  }

  // Per-asset cache of the SD-WAN gate fetch (members + rules + perf-SLA
  // links) so renderSdwanPage draws the current-state lists without a
  // re-fetch. Populated by loadSdwanGate; only set when data actually exists.
  var _sdwanCache = Object.create(null);

  // Per-mount state keyed by asset id so navigating back from another tab
  // remembers which sections were collapsed and which range was active.
  var _mounts = Object.create(null);

  function mountState(id) {
    if (!_mounts[id]) {
      _mounts[id] = {
        range: DEFAULT_RANGE,
        telemetryRange: DEFAULT_RANGE,
        // Chart sections collapse by default — operators get the summary
        // (avg/max in the section subtitle) at a glance and can expand for
        // the full chart when needed.
        sections: {
          monitor: false,
          telemetry: false,
          general: true,
          temperatures: true,
          interfaces: true,
          // Discovery provenance. Sources expanded by default (the primary
          // "where did this asset come from" answer); firewall sightings +
          // IP history collapsed with a count in the header subtitle.
          sources: true,
          sightings: false,
          ipHistory: false,
        },
        // Interfaces sub-toggle: collapsed shows only `monitoredInterfaces`
        // (the operator-pinned fast-poll subset); expanded shows every up
        // interface. Persists per asset for the lifetime of the SPA mount.
        interfacesShowAll: false,
      };
    }
    return _mounts[id];
  }

  // ─── Three-state slide-up sheet ────────────────────────────────────────
  // The asset detail is a bottom sheet (not a full-page route): tapping an
  // asset anywhere calls `open(id)`. States:
  //   expanded — tall (~90vh) scrollable sheet with the full content.
  //   peek     — slid down so only the header band (status dot + name) shows;
  //              the scrim is hidden so the searchbar behind becomes usable.
  //              The DOM is NOT torn down — charts, scroll position and per-
  //              asset `mountState` survive, so re-expand is instant.
  //   closed   — sheet + scrim removed from the DOM.
  // Minimize is triggered by tapping the scrim (i.e. the dimmed area over the
  // searchbar); expand by tapping the peek bar; dismiss by swipe-down or the
  // close button.
  // The peek band is the pinned head — handle + both header rows (toolbar and
  // the name / page title) — MEASURED (peekBandPx), since the title row's
  // height follows the page. This is only the fallback before layout: 32px of
  // handle area + two 48px rows + 4+12 padding + 4 between them.
  var PEEK_BAND_PX = 148;
  function peekBandPx(sheet) {
    var head = sheet.querySelector(".sheet-pinned-head") || sheet.querySelector(".asset-sheet-header");
    var h = head ? head.offsetHeight : 0;
    return h > 0 ? h : PEEK_BAND_PX;
  }
  var _state = "closed";   // "closed" | "expanded" | "peek"
  var _openId = null;      // asset id currently shown — also the loader race guard
  var _openAsset = null;   // its row, as last painted — what the edit menu opens on

  // Build the scrim + sheet once and reuse across opens. Returns the sheet.
  function ensureSheet() {
    var existing = document.getElementById("asset-sheet");
    if (existing) return existing;

    var scrim = document.createElement("div");
    scrim.className = "scrim asset-scrim";
    scrim.id = "asset-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet asset-sheet";
    sheet.id = "asset-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div class="asset-sheet-header">'
      // Row 1: the page history (back / forward) on the left, the sheet's
      // own verbs on the right.
      + '  <div class="asset-sheet-toolbar">'
      + '    <button class="icon-btn" id="asset-sheet-back" aria-label="Back" disabled><svg viewBox="0 0 24 24"><use href="#i-chev-left"/></svg></button>'
      + '    <button class="icon-btn" id="asset-sheet-fwd" aria-label="Forward" disabled><svg viewBox="0 0 24 24"><use href="#i-chev-right"/></svg></button>'
      + '    <span class="asset-sheet-toolbar-gap"></span>'
      + '    <button class="icon-btn" id="asset-sheet-screenshot" aria-label="Screenshot"><svg viewBox="0 0 24 24"><use href="#i-camera"/></svg></button>'
      + '    <button class="icon-btn" id="asset-sheet-refresh" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
      + '    <button class="icon-btn" id="asset-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '  </div>'
      // Row 2: on the asset page the status dot + name, the full width; on
      // any other page that page's title over the asset's name.
      + '  <div class="asset-sheet-title-row">'
      + '    <span class="dot" id="asset-sheet-dot" style="display:none;"></span>'
      // The name is the edit menu's trigger (PolarisAssetEdit in
      // mobile/asset-edit.js) — one entry per tab of the desktop's Edit Asset
      // modal. Disabled until the row loads; the text keeps its own id.
      + '    <button type="button" class="asset-sheet-name-btn" id="asset-sheet-name-btn" aria-haspopup="menu" aria-label="Edit asset" disabled>'
      + '      <span class="asset-sheet-name" id="asset-sheet-name">Asset</span>'
      + '      <svg class="caret" viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chev-down"/></svg>'
      + '    </button>'
      + '    <div class="asset-sheet-page" id="asset-sheet-page" hidden>'
      + '      <div class="asset-sheet-page-title" id="asset-sheet-page-title"></div>'
      + '      <div class="asset-sheet-page-sub" id="asset-sheet-page-sub"></div>'
      + '    </div>'
      + '  </div>'
      + '</div>'
      + '<div id="asset-host"></div>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    // The handle + header ride the pinned band (PolarisTabs.pinSheetHead) so
    // the name (edit menu), screenshot, refresh and close stay reachable however
    // far the body is scrolled — and a scrolled sheet minimized to peek still
    // shows its header band rather than whatever was mid-scroll.
    if (window.PolarisTabs && PolarisTabs.pinSheetHead) PolarisTabs.pinSheetHead(sheet);

    // Tapping the scrim (over the searchbar) minimizes rather than dismisses.
    scrim.addEventListener("click", minimize);
    document.getElementById("asset-sheet-close").addEventListener("click", closeSheet);
    document.getElementById("asset-sheet-refresh").addEventListener("click", function () {
      refreshPage(this);
    });
    document.getElementById("asset-sheet-back").addEventListener("click", function () {
      if (_state === "expanded") pageBack();
    });
    document.getElementById("asset-sheet-fwd").addEventListener("click", function () {
      if (_state === "expanded") pageForward();
    });
    // While peeked the header tap handler below re-expands instead (the
    // camera isn't in its exclusion list) and this guard makes the
    // screenshot click a no-op, so one tap = expand, second tap = capture.
    document.getElementById("asset-sheet-screenshot").addEventListener("click", function () {
      if (_state !== "expanded") return;
      screenshotSheet(this);
    });
    // Tapping the header while peeked re-expands (ignore taps on the buttons).
    sheet.querySelector(".asset-sheet-header").addEventListener("click", function (e) {
      if (_state === "peek" && !e.target.closest("#asset-sheet-close, #asset-sheet-refresh")) expand();
    });
    // The name opens the edit menu — only when expanded, so a tap on a peeked
    // band still just re-expands (the handler above), as the camera does.
    document.getElementById("asset-sheet-name-btn").addEventListener("click", function () {
      if (_state !== "expanded" || !_openAsset || !window.PolarisAssetEdit) return;
      var pg = currentPage();
      if (!pg || pg.kind !== "asset") return;
      var id = _openAsset.id;
      var menuAsset = _openAsset;
      PolarisAssetEdit.openMenu(menuAsset, {
        onSaved: function () { if (_openId === id) reloadSheet(id); },
        // The menu's Reboot row runs the same confirm sheet as the Uptime
        // row's button; that button (when drawn) is the one disabled while the
        // request is in flight.
        onReboot: function (rb) {
          if (_openId !== id) return;
          startRebootFlow(menuAsset, rb, document.getElementById("asset-reboot-btn") || { disabled: false }, null);
        },
      });
    });
    PolarisTabs.attachSwipeToDismiss(sheet, closeSheet, {
      // First swipe-down locks to peek; second swipe-down dismisses.
      onSwipeDown: function () {
        if (_state === "expanded") {
          minimize();
        } else if (_state === "peek") {
          sheet.style.transition = "transform .2s ease-out";
          sheet.style.transform = "translateY(100%)";
          setTimeout(closeSheet, 180);
        }
      },
      // Swipe-up from the peek band re-expands. In the expanded state baseline
      // is 0, so the helper falls back to native scroll on upward gestures.
      onSwipeUp: function () {
        if (_state === "peek") expand();
      },
      // Keep drag offsets continuous when peeked — without this the touchmove
      // overrides the peek CSS transform with translateY(dy), jumping the
      // sheet back to its natural position before the drag continues.
      baselineTranslate: function () {
        if (_state !== "peek") return 0;
        return Math.max(0, (sheet.offsetHeight || 0) - peekBandPx(sheet));
      },
    });
    return sheet;
  }

  function setHeader(asset) {
    _openAsset = asset;
    var nameEl = document.getElementById("asset-sheet-name");
    if (nameEl) nameEl.textContent = asset.hostname || asset.assetTag || "Asset";
    var nameBtn = document.getElementById("asset-sheet-name-btn");
    if (nameBtn) nameBtn.disabled = !window.PolarisAssetEdit;
    var dotEl = document.getElementById("asset-sheet-dot");
    if (dotEl) {
      var cls = monitorDotCls(asset);
      dotEl.className = "dot" + (cls ? " " + cls : "");
      dotEl.style.display = cls ? "" : "none";
    }
    // Refresh re-reads the sheet (reloadSheet), so every asset gets it — an
    // unmonitored one still changes under discovery.
    var refreshBtn = document.getElementById("asset-sheet-refresh");
    if (refreshBtn) refreshBtn.style.display = "";
  }

  function minimize() {
    if (_state !== "expanded") return;
    var sheet = document.getElementById("asset-sheet");
    var scrim = document.getElementById("asset-sheet-scrim");
    if (!sheet) return;
    // Slide the sheet down so only its top band (handle + header) peeks above
    // the bottom navbar. The sheet is anchored at bottom: navbar-h (see CSS),
    // so translateY(offsetHeight - band) leaves the band exposed just
    // above the navbar; the rest of the sheet extends behind the navbar and
    // is occluded by the navbar's higher z-index. Measured from the live
    // height so short content peeks correctly too. attachSwipeToDismiss
    // clears inline transform on snap-back, which falls through to the CSS
    // translate, so peek is restored.
    var translate = Math.max(0, (sheet.offsetHeight || 0) - peekBandPx(sheet));
    sheet.style.setProperty("--asset-peek-y", translate + "px");
    sheet.classList.add("peek");
    if (scrim) scrim.style.display = "none";
    _state = "peek";
  }

  function expand() {
    if (_state !== "peek") return;
    var sheet = document.getElementById("asset-sheet");
    var scrim = document.getElementById("asset-sheet-scrim");
    if (!sheet) return;
    sheet.classList.remove("peek");
    sheet.style.transform = "";   // drop any inline transform left by a drag
    if (scrim) scrim.style.display = "";
    _state = "expanded";
  }

  function dismiss() {
    _openId = null;
    _openAsset = null;
    _state = "closed";
    // Tear down any stacked child sheets first so they don't orphan over the
    // backdrop once the asset sheet is gone.
    if (window.PolarisAssetEdit) PolarisAssetEdit.closeAll();
    leavePage(currentPage());
    _pages = [];
    _pageIdx = -1;
    _pageSeq++;
    closeFirmwareConfirm(false);
    stopFirmwarePoll();
    closeRebootConfirm(false);
    stopRebootPoll();
    var s = document.getElementById("asset-sheet");
    var sc = document.getElementById("asset-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  // Closed by the operator (the X, or the second swipe-down): tear down, then
  // take the sheet's history entry back off so the next Back is the page's.
  function closeSheet() {
    dismiss();
    dropSheetEntry();
  }

  // ─── Phone Back button ──────────────────────────────────────────────
  // While the sheet is open it keeps one history entry of its own on top —
  // pushState with the SAME url, so no hashchange and no route render. Back
  // pops that entry and popstate decides what it meant, nearest thing first:
  // a sheet stacked on this one closes, then expanded → peek (the entry is
  // put back), then peek → closed. Minimize / expand by tap or swipe leave
  // the entry alone, so Back from a peek always closes.
  //
  // A pop is told from a forward hash navigation (Chrome fires popstate for
  // both) by the url: the entry sits over one with the same url, a navbar tap
  // goes somewhere else. An entry left behind by a sheet closed from another
  // route is stepped over when Back lands on it.
  var SHEET_ENTRY_KEY = "polarisAssetSheet";
  var _onSheetEntry = false;     // the current history entry is the sheet's
  var _sheetEntryHref = "";      // the url it was pushed at
  var _popsToIgnore = 0;         // popstates our own back()/go() cause
  var _repushAfterIgnore = false;

  function isSheetEntry(st) { return !!(st && st[SHEET_ENTRY_KEY]); }

  function pushSheetEntry() {
    if (isSheetEntry(window.history.state)) { _onSheetEntry = true; return; }
    var st = {};
    st[SHEET_ENTRY_KEY] = true;
    try {
      window.history.pushState(st, "", window.location.href);
      _onSheetEntry = true;
      _sheetEntryHref = window.location.href;
    } catch (_) { /* history unavailable — Back just leaves the page, as before */ }
  }

  function dropSheetEntry() {
    if (!isSheetEntry(window.history.state)) return;
    _onSheetEntry = false;
    _popsToIgnore++;
    window.history.back();
  }

  // The newest sheet stacked over the asset sheet (the edit menu or an edit
  // sheet, a confirm, the acknowledge-note prompt…) — closed through its own scrim, which every one
  // wires to its close path, so its state (a poll, a pending promise) is torn
  // down the way a tap outside it would. True when there was one.
  function closeStackedSheet() {
    var base = document.getElementById("asset-sheet");
    if (!base) return false;
    var sheets = document.querySelectorAll("body > .sheet");
    for (var i = sheets.length - 1; i >= 0; i--) {
      var s = sheets[i];
      if (s === base) return false;
      if (!(base.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      var scrim = s.previousElementSibling;
      if (scrim && scrim.classList.contains("scrim")) scrim.click();
      else {
        var x = s.querySelector('[aria-label="Close"]');
        if (x) x.click(); else s.remove();
      }
      return true;
    }
    return false;
  }

  function onPopState(e) {
    var wasOnEntry = _onSheetEntry;
    _onSheetEntry = isSheetEntry(e.state);
    if (_onSheetEntry) _sheetEntryHref = window.location.href;
    if (_popsToIgnore > 0) {
      _popsToIgnore--;
      if (_repushAfterIgnore) {
        _repushAfterIgnore = false;
        if (_state !== "closed") pushSheetEntry();
      }
      return;
    }
    if (_onSheetEntry) {
      // Landed on an entry a sheet closed elsewhere left behind: step over it.
      if (_state === "closed") { _popsToIgnore++; window.history.back(); }
      return;
    }
    if (!wasOnEntry || _state === "closed") return;
    if (window.location.href !== _sheetEntryHref) return;   // navigated away, not Back
    if (closeStackedSheet()) { pushSheetEntry(); return; }
    // Expanded, Back is the panel's own ‹ until the first page; then it
    // shrinks. Peeked, Back closes whatever page is showing.
    if (_state === "expanded" && pageBack()) { pushSheetEntry(); return; }
    if (_state === "expanded") { minimize(); pushSheetEntry(); return; }
    dismiss();
  }

  /**
   * history.back() for an in-app back control (search's arrow, a detail
   * page's chevron) that may be pressed while this sheet is open: steps past
   * the sheet's own entry as well, so the control does its job and the sheet
   * stays as it is (its entry is put back on the page it lands on).
   */
  function historyBack() {
    if (_state !== "closed" && isSheetEntry(window.history.state)) {
      _popsToIgnore++;
      _repushAfterIgnore = true;
      window.history.go(-2);
    } else {
      window.history.back();
    }
  }

  // One listener per page even if this file is evaluated again (the unit
  // tests do) — a stale copy would act on its own stale state.
  if (window.__polarisAssetSheetPop) window.removeEventListener("popstate", window.__polarisAssetSheetPop);
  window.__polarisAssetSheetPop = onPopState;
  window.addEventListener("popstate", onPopState);
  // A browser that navigates a fragment without a popstate still moves the
  // current entry; keep the flag honest.
  if (window.__polarisAssetSheetHash) window.removeEventListener("hashchange", window.__polarisAssetSheetHash);
  window.__polarisAssetSheetHash = function () { _onSheetEntry = isSheetEntry(window.history.state); };
  window.addEventListener("hashchange", window.__polarisAssetSheetHash);

  // ─── Screenshot ──────────────────────────────────────────────────────
  // Camera button in the sheet header. Captures the sheet body (#asset-host
  // — its FULL content height, including parts scrolled out of view;
  // collapsed sections stay collapsed, so the capture matches what the
  // operator chose to expand) via the vendored html-to-image library, draws
  // a title strip above it (mirrors the desktop _runScreenshotCapture in
  // assets.js), then hands the PNG off in mobile-priority order: native
  // share sheet → clipboard → plain download. Unlike desktop there's no
  // canonical-width reflow — the sheet captures at its natural mobile width,
  // which also means no relayout settle delay before rasterizing.
  function screenshotSheet(btn) {
    var host = document.getElementById("asset-host");
    if (!host || !host.firstChild) {
      PolarisTabs.showSnackbar("Nothing to screenshot", { error: true });
      return;
    }
    if (typeof htmlToImage === "undefined") {
      PolarisTabs.showSnackbar("Screenshot failed — capture library not loaded", { error: true });
      return;
    }
    var sheet = document.getElementById("asset-sheet");
    var bg = (sheet && getComputedStyle(sheet).backgroundColor) || "#191c20";
    var clrText = getComputedStyle(document.documentElement).getPropertyValue("--md-on-surface").trim() || "#e2e2e8";
    if (btn) btn.disabled = true;
    function done() { if (btn) btn.disabled = false; }

    // iOS Safari rejects canvases past ~16.7M device pixels (older devices)
    // and the body can run thousands of CSS px tall with every section
    // expanded — shrink the pixel ratio just enough to stay under the cap
    // (title strip + padding included) instead of failing with a blank PNG.
    var w = host.scrollWidth || host.offsetWidth || 1;
    var h = host.scrollHeight || host.offsetHeight || 1;
    var MAX_AREA = 16000000;
    var scale = Math.min(2, Math.sqrt(MAX_AREA / ((w + 32) * (h + 56))));

    // WebKit (every iOS browser + macOS Safari) intermittently drops images
    // and webfonts on the FIRST foreignObject rasterization — the standard
    // workaround is rendering twice and keeping the second pass. Desktop
    // Chrome/Edge carry "Chrome/" in the UA; iOS Chrome is "CriOS" and IS
    // WebKit, so it correctly falls into the double-capture branch.
    var isWebKit = /AppleWebKit/.test(navigator.userAgent) && !/Chrome\//.test(navigator.userAgent);
    // The body fades out under the pinned header while scrolled (a mask,
    // tabs.js sheetFade) — the picture is of the whole body, unmasked.
    var unmask = { maskImage: "none", webkitMaskImage: "none" };
    function capture() { return htmlToImage.toCanvas(host, { pixelRatio: scale, backgroundColor: bg, style: unmask }); }

    (isWebKit ? capture().then(capture) : capture()).then(function (cap) {
      var pad = 16;
      var titleH = 40;
      var cw = cap.width / scale;
      var ch = cap.height / scale;
      var canvas = document.createElement("canvas");
      canvas.width = Math.round((cw + pad * 2) * scale);
      canvas.height = Math.round((titleH + ch + pad) * scale);
      var ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, cw + pad * 2, titleH + ch + pad);
      ctx.fillStyle = clrText;
      ctx.font = "bold 15px Roboto, system-ui, sans-serif";
      var name = (document.getElementById("asset-sheet-name") || {}).textContent || "";
      ctx.fillText("Asset Details" + (name ? " — " + name : ""), pad, 26);
      // 1:1 device-pixel blit (cw×ch CSS px under the scale transform) so
      // the captured body is never resampled.
      ctx.drawImage(cap, pad, titleH, cw, ch);
      canvas.toBlob(function (blob) {
        if (!blob) { done(); PolarisTabs.showSnackbar("Screenshot failed", { error: true }); return; }
        deliverScreenshot(blob, name).then(function (msg) {
          done();
          if (msg) PolarisTabs.showSnackbar(msg);
        }).catch(function () {
          done();
          PolarisTabs.showSnackbar("Screenshot failed — couldn't share, copy, or download", { error: true });
        });
      }, "image/png");
    }).catch(function () {
      done();
      PolarisTabs.showSnackbar("Screenshot failed", { error: true });
    });
  }

  // Hand the PNG off: native share sheet (save to Photos / AirDrop / send)
  // when the browser can share files, falling back to clipboard, falling
  // back to an anchor download. Resolves with the snackbar message for the
  // path that worked — or "" when the user cancelled the share sheet
  // (cancelling isn't an error, so no toast). Share/clipboard can both
  // reject when the async rasterization outlived the tap's transient
  // activation window — the chain absorbs that too.
  function deliverScreenshot(blob, name) {
    var fname = "asset-" + (name ? name.replace(/[^\w.-]+/g, "_") + "-" : "") + "details.png";
    var file = null;
    try { file = new File([blob], fname, { type: "image/png" }); } catch (_) {}
    if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
      return navigator.share({ files: [file] }).then(function () {
        return "Screenshot shared";
      }).catch(function (err) {
        if (err && err.name === "AbortError") return ""; // user closed the share sheet
        return copyOrDownloadScreenshot(blob, fname);
      });
    }
    return copyOrDownloadScreenshot(blob, fname);
  }

  function copyOrDownloadScreenshot(blob, fname) {
    return copyPngToClipboard(blob).then(function (ok) {
      return ok ? "Screenshot copied to clipboard" : downloadScreenshot(blob, fname);
    });
  }

  function downloadScreenshot(blob, fname) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke late — Safari aborts the save if the URL dies under it.
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
    return "Screenshot downloaded";
  }

  // Public opener. Builds the sheet (if needed), then shows the asset as a
  // page. On a closed sheet that starts a fresh page history; on an open one
  // the asset is a page FORWARD of the one showing (a link, a neighbor, a
  // matched device), so ‹ returns to it. The asset already showing just
  // re-expands.
  function open(id) {
    if (!id) return;
    var sheet = ensureSheet();
    var cur = currentPage();

    if (_state !== "closed" && cur && cur.kind === "asset" && cur.assetId === id) { expand(); pushSheetEntry(); return; }

    // A fresh open re-reads the windows: one may have started or ended since.
    _maintWindows = { assetId: null, promise: null };
    if (_state === "closed") {
      _pages = [];
      _pageIdx = -1;
      expandFresh(sheet);
    } else if (_state === "peek") {
      expand();
    }
    // Back now steps the sheet down (pages, peek, then closed) before the
    // page behind it. No-op when the current entry is already the sheet's.
    pushSheetEntry();
    goToPage({ kind: "asset", assetId: id });
  }

  // ─── Page history ──────────────────────────────────────────────────────
  // The sheet shows ONE page at a time: the asset, or something opened from
  // it — SD-WAN, the ARP / MAC / Wireless tables, an interface, the alerts
  // list, Storage, a volume, a drive, or another asset. Opening one goes
  // FORWARD (dropping any pages ahead, as a browser does); the header's ‹ and
  // › walk the list, and the phone's Back is ‹ (see onPopState). Each page
  // remembers its scroll offset. A page is { kind, assetId, title?, sub?, … };
  // PAGE_KINDS says how each kind draws, refreshes and is left.
  var _pages = [];
  var _pageIdx = -1;
  // Bumped on every page shown: a loader that captured it and finds it moved
  // belongs to a page no longer on screen (two pages of one asset share
  // `_openId`, so that guard alone cannot tell them apart).
  var _pageSeq = 0;

  function currentPage() { return _pageIdx >= 0 ? _pages[_pageIdx] || null : null; }

  function hostEl() { return document.getElementById("asset-host"); }
  function sheetEl() { return document.getElementById("asset-sheet"); }

  function saveScroll() {
    var p = currentPage(), s = sheetEl();
    if (p && s) p.scrollTop = s.scrollTop;
  }

  function restoreScroll(p) {
    var s = sheetEl();
    if (s && p === currentPage()) s.scrollTop = p.scrollTop || 0;
  }

  function leavePage(p) {
    if (!p) return;
    var k = PAGE_KINDS[p.kind];
    if (k && k.leave) { try { k.leave(p); } catch (_) { /* leaving never fails the move */ } }
  }

  function goToPage(page) {
    saveScroll();
    leavePage(currentPage());
    _pages = _pages.slice(0, _pageIdx + 1);
    _pages.push(page);
    _pageIdx = _pages.length - 1;
    showPage();
  }

  function pageBack() {
    if (_pageIdx <= 0) return false;
    saveScroll();
    leavePage(currentPage());
    _pageIdx--;
    showPage();
    return true;
  }

  function pageForward() {
    if (_pageIdx >= _pages.length - 1) return false;
    saveScroll();
    leavePage(currentPage());
    _pageIdx++;
    showPage();
    return true;
  }

  // The hostname a sub-page names under its title: the page's own, else the
  // nearest asset page behind it that has loaded.
  function pageAssetName(p) {
    if (p.hostname) return p.hostname;
    for (var i = _pageIdx; i >= 0; i--) {
      var q = _pages[i];
      if (q && q.kind === "asset" && q.assetId === p.assetId && q.hostname) return q.hostname;
    }
    return "";
  }

  function paintNav() {
    var back = document.getElementById("asset-sheet-back");
    var fwd = document.getElementById("asset-sheet-fwd");
    var prev = _pages[_pageIdx - 1], next = _pages[_pageIdx + 1];
    if (back) {
      back.disabled = !prev;
      back.setAttribute("aria-label", prev ? "Back to " + pageLabel(prev) : "Back");
    }
    if (fwd) {
      fwd.disabled = !next;
      fwd.setAttribute("aria-label", next ? "Forward to " + pageLabel(next) : "Forward");
    }
  }

  function pageLabel(p) {
    return p.kind === "asset" ? (p.hostname || "asset") : (p.title || p.kind);
  }

  // Row 2 of the header: the asset page's dot + name (setHeader fills them
  // once the row loads), or a sub-page's title over its asset's name.
  function paintTitleRow(p) {
    var nameBtn = document.getElementById("asset-sheet-name-btn");
    var dot = document.getElementById("asset-sheet-dot");
    var block = document.getElementById("asset-sheet-page");
    var isAsset = p.kind === "asset";
    if (nameBtn) nameBtn.hidden = !isAsset;
    if (block) block.hidden = isAsset;
    if (isAsset) return;
    if (dot) dot.style.display = "none";
    var t = document.getElementById("asset-sheet-page-title");
    var s = document.getElementById("asset-sheet-page-sub");
    if (t) t.textContent = p.title || "";
    if (s) s.textContent = [pageAssetName(p), p.sub].filter(Boolean).join(" · ");
  }

  function showPage() {
    var p = currentPage();
    var host = hostEl();
    if (!p || !host) return;
    _pageSeq++;
    _openId = p.assetId;
    paintNav();
    paintTitleRow(p);
    var refreshBtn = document.getElementById("asset-sheet-refresh");
    if (p.kind === "asset") { renderAssetPage(p); return; }
    _openAsset = null;
    if (refreshBtn) refreshBtn.style.display = "";
    // Each page draws into a fresh element: a listener a page delegates from
    // it goes when the page does, never piling up on #asset-host.
    host.innerHTML = '<div class="asset-page" data-page="' + escapeHtml(p.kind) + '"></div>';
    var el = host.firstChild;
    var s = sheetEl();
    if (s) s.scrollTop = 0;
    PAGE_KINDS[p.kind].render(el, p);
    restoreScroll(p);
  }

  function renderAssetPage(p) {
    var id = p.assetId;
    resetAssetHeader(p);
    var host = hostEl();
    if (host) host.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';
    loadAsset(id, mountState(id)).then(function () {
      restoreScroll(p);
    }).catch(function (err) {
      if (currentPage() !== p) return;
      var msg = (err && err.message) ? err.message : "Failed to load asset";
      var h = hostEl();
      if (!h) return;
      h.innerHTML = ''
        + '<div class="empty-state" style="padding-top:64px;">'
        + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
        + '  <div class="ttl">Couldn’t load asset</div>'
        + '  <div class="desc">' + escapeHtml(msg) + '</div>'
        + '</div>';
    });
  }

  // The header's Refresh: the asset page re-reads the asset (reloadSheet);
  // any other page its own refresh, or is drawn again.
  function refreshPage(btn) {
    var p = currentPage();
    if (!p) return;
    if (p.kind === "asset") { reloadSheet(p.assetId, btn); return; }
    var k = PAGE_KINDS[p.kind];
    if (k.refresh) { k.refresh(p); return; }
    saveScroll();
    leavePage(p);
    showPage();
  }

  // How each kind of page draws (into its own element), refreshes in place,
  // and is left. Sub-pages for the asset page's own buttons and rows;
  // "asset" is drawn by renderAssetPage.
  var PAGE_KINDS = {
    sdwan:    { render: function (el, p) { renderSdwanPage(el, p.assetId); },
                leave: function () { _sdwanSheetState = null; } },
    // Both re-read on Refresh; IPsec draws from the gate's copy otherwise.
    ipsec:    { render: function (el, p) { renderIpsecPage(el, p); },
                refresh: function (p) { saveScroll(); p.refetch = true; showPage(); } },
    deptree:  { render: function (el, p) { renderDepTreePage(el, p); } },
    arp:      { render: function (el, p) { renderTablePage(el, "arp", p.assetId); loadArpSheet(p.assetId); },
                refresh: function (p) { loadArpSheet(p.assetId); },
                leave: function () { _tableSheet = null; } },
    mac:      { render: function (el, p) { renderTablePage(el, "mac", p.assetId); loadMacSheet(p.assetId); },
                refresh: function (p) { loadMacSheet(p.assetId); },
                leave: function () { _tableSheet = null; } },
    wireless: { render: function (el, p) { renderTablePage(el, "wireless", p.assetId); loadWirelessSheet(p.assetId); },
                refresh: function (p) { loadWirelessSheet(p.assetId, true); },
                leave: function () { _tableSheet = null; } },
    iface:    { render: function (el, p) { renderInterfacePage(el, p.iface, p.info, p.assetId, p.monitored); } },
    alerts:   { render: function (el, p) { renderAlertsPage(el, p); },
                leave: function () { if (window.PolarisMobileAlerts && PolarisMobileAlerts.close) PolarisMobileAlerts.close(); } },
    storage:  { render: function (el, p) { renderStoragePage(el, p); },
                // Re-read system-info rather than the copy the asset page cached.
                refresh: function (p) { saveScroll(); p.refetch = true; showPage(); } },
    volume:   { render: function (el, p) { renderVolumePage(el, p); } },
    drive:    { render: function (el, p) { renderDrivePage(el, p); } },
  };

  // ─── Asset names are tap targets ────────────────────────────────────────
  // Wherever the phone names ANOTHER asset and knows its id, the name is a
  // link that opens that asset's sheet: linkHtml draws it, and one capture-
  // phase listener on the document opens it — so a surface only has to draw
  // the link, and a row handler underneath (a collapsible IP row, a table
  // group head) never sees the tap. Inside the asset sheet the asset opens a
  // page forward (open). A sheet stacked ABOVE the asset sheet (the generic
  // .sheet at 1000/1001: site, topology node, the Assets list's alerts sheet)
  // would hide the sheet being opened, so it is closed first through
  // its own Close button — every pinned sheet header carries one — which runs
  // that sheet's own teardown. The one sheet BELOW it (the network sheet,
  // 891) stays, as its "Open asset" button leaves it. The current asset's own
  // name (header, General, confirm sheets) is never drawn as a link.
  function linkHtml(id, name) {
    if (!id) return escapeHtml(name);
    return '<a href="#" class="asset-link" data-open-asset="' + escapeHtml(id) + '">' + escapeHtml(name) + '</a>';
  }

  function onAssetLinkClick(e) {
    var link = e.target && e.target.closest ? e.target.closest("[data-open-asset]") : null;
    if (!link) return;
    var id = link.getAttribute("data-open-asset");
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    var over = link.closest(".sheet");
    if (over && over.id !== "asset-sheet" && !over.classList.contains("network-sheet")) {
      var closeBtn = over.querySelector('[aria-label="Close"]');
      if (closeBtn) closeBtn.click();
      else over.remove();
    }
    open(id);
  }
  document.addEventListener("click", onAssetLinkClick, true);

  // Fetch the asset row and paint the whole sheet from it. Shared by open()
  // and reloadSheet() so a refresh shows exactly what a fresh open would.
  // Resolves once the row is painted; the section loaders land on their own.
  function loadAsset(id, st) {
    var seq = _pageSeq;
    var page = currentPage();
    return api.assets.get(id).then(function (asset) {
      if (_openId !== id || seq !== _pageSeq) return;
      if (!asset) throw new Error("Asset not found");
      // The name the sub-pages show under their titles, and the Back label.
      if (page && page.kind === "asset") page.hostname = asset.hostname || asset.assetTag || "";
      paintNav();
      setHeader(asset);
      renderShell(asset, st);
      // Fire monitor + telemetry + IP history fetches in parallel — these
      // populate their respective sections independently.
      loadMonitor(id, st);
      loadTelemetry(id, st);
      loadSystemInfo(id, st, asset);
      loadSources(id, st);
      loadSightings(id, st);
      loadIpHistory(id, st);
      loadSdwanGate(id, st, asset);
      loadIpsecGate(id, asset);
      wireDepTreeButton(id);
      wireTableButtons(id, asset);
      loadAlerts(id, asset);
      loadFirmwareRow(id, asset);
      loadRebootRow(id, asset);
    });
  }

  // Refresh (header button and pull-to-refresh): re-read what Polaris already
  // has and repaint the sheet — it does NOT poll the device. It used to fire
  // probeNow, which put an on-demand probe + telemetry + system-info pass on
  // the device every tap; the monitor loop keeps the data current, and nothing
  // here re-reads on a timer, so this is how the operator catches up with it.
  // The open sections, chart range and scroll position survive, and the old
  // content stays up until the new row arrives (a failed reload keeps it).
  function reloadSheet(id, btn) {
    if (!id || _openId !== id) return Promise.resolve();
    var cur = currentPage();
    if (!cur || cur.kind !== "asset") return Promise.resolve();
    var sheet = document.getElementById("asset-sheet");
    var scroll = sheet ? sheet.scrollTop : 0;
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';
    }
    // A maintenance window may have started or ended since the sheet opened.
    _maintWindows = { assetId: null, promise: null };
    return loadAsset(id, mountState(id)).then(function () {
      if (sheet && _openId === id) sheet.scrollTop = scroll;
    }).catch(function (err) {
      if (_openId !== id) return;
      PolarisTabs.showSnackbar("Couldn’t refresh — " + ((err && err.message) || "error"), { error: true });
    }).finally(function () {
      if (!btn) return;
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg>';
    });
  }

  // Reset the sheet to a fresh expanded loading state (used by open()).
  function expandFresh(sheet) {
    sheet.classList.remove("peek");
    sheet.style.transform = "";
    var scrim = document.getElementById("asset-sheet-scrim");
    if (scrim) scrim.style.display = "";
    _state = "expanded";
    sheet.scrollTop = 0;
  }

  // An asset page about to load: its name if a visit already learned it,
  // no menu until the row lands, and no edit sheet left open on the previous
  // asset.
  function resetAssetHeader(p) {
    var nameEl = document.getElementById("asset-sheet-name");
    if (nameEl) nameEl.textContent = (p && p.hostname) || "Asset";
    _openAsset = null;
    var nameBtn = document.getElementById("asset-sheet-name-btn");
    if (nameBtn) nameBtn.disabled = true;
    if (window.PolarisAssetEdit) PolarisAssetEdit.closeAll();
    var dotEl = document.getElementById("asset-sheet-dot");
    if (dotEl) { dotEl.className = "dot"; dotEl.style.display = "none"; }
    var refreshBtn = document.getElementById("asset-sheet-refresh");
    if (refreshBtn) refreshBtn.style.display = "none"; // setHeader re-shows it once the row loads
    var host = document.getElementById("asset-host");
    if (host) host.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';
  }

  // Deep-link shim: `#asset/<id>` routes still resolve (e.g. a pasted URL).
  // Render the assets list as a backdrop so dismissing reveals it, then open
  // the sheet over it. Does NOT push history — normal in-app navigation calls
  // open() directly.
  function render(body, ctx) {
    var id = (ctx && ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (window.PolarisAssetsTab && PolarisAssetsTab.spec && PolarisAssetsTab.spec.render) {
      try {
        PolarisAssetsTab.spec.render(body, { user: ctx && ctx.user, route: { name: "assets", parts: [], full: "assets" } });
      } catch (_) { /* backdrop is best-effort */ }
    }
    if (id) open(id);
  }

  function renderShell(asset, st) {
    var host = document.getElementById("asset-host");
    if (!host) return;

    // The sheet header already shows the status dot + asset name, so the hero
    // omits the name line (it used to repeat it) and leads with the status
    // pill + identity bits.
    var monitorPillHtml = renderMonitorPill(asset);
    var heroBits = [];
    if (asset.ipAddress) heroBits.push('<span class="mono">' + escapeHtml(asset.ipAddress) + '</span>');
    var modelLine = [asset.manufacturer, asset.model].filter(Boolean).join(" ");
    if (modelLine) heroBits.push(escapeHtml(modelLine));
    if (asset.serialNumber) heroBits.push('<span class="mono">S/N ' + escapeHtml(asset.serialNumber) + '</span>');

    host.innerHTML = ''
      + '<div class="asset-hero">'
      + (heroBits.length ? '  <div class="hero-sub">' + heroBits.join(" · ") + '</div>' : '')
      // Status pill and the alert flag share a row: they are the two things
      // that say how this device is doing, and reading one without the other
      // is how a device shows "Up" while three alerts are firing on it. The
      // pill keeps its own id — the post-probe refresh re-renders into it, and
      // it must not take the flag with it.
      + '  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:' + (heroBits.length ? '12px' : '0') + ';">'
      + '    <div id="asset-hero-pill">' + monitorPillHtml + '</div>'
      + '    <span id="asset-hero-alerts"></span>'
      + '  </div>'
      // Dependency Tree — drawn for every asset, as the desktop General tab
      // draws its block for every asset: the page explains an empty tree.
      + '  <div style="margin-top:12px;">'
      + '    <button class="btn btn-tonal btn-block" id="asset-deptree-btn"><svg viewBox="0 0 24 24"><use href="#i-subnet"/></svg>View Dependency Tree</button>'
      + '  </div>'
      // SD-WAN entry button — hidden until loadSdwanGate confirms this
      // FortiGate firewall actually reported SD-WAN data, then revealed +
      // wired to open the SD-WAN page.
      + '  <div id="asset-sdwan-btn-wrap" style="margin-top:12px;display:none;">'
      + '    <button class="btn btn-tonal btn-block" id="asset-sdwan-btn"><svg viewBox="0 0 24 24"><use href="#i-router"/></svg>View SD-WAN</button>'
      + '  </div>'
      // Current-state table buttons — one per device class, the same classes
      // the desktop gives the ARP Table / MAC Table / Wireless tabs to. Shown
      // from the asset type alone (no prefetch): the sheet itself explains an
      // empty table, which is the answer the operator tapped for.
      + tableButtonsHtml(asset)
      // Quarantine action — rendered synchronously from the asset row (status +
      // MACs + type are all present). Empty string when the caller lacks the
      // assetsQuarantine:write permission or the asset isn't eligible; the wrap
      // stays so refreshAfterQuarantine can re-render into it after an action.
      + '  <div id="asset-quarantine-btn-wrap">' + quarantineButtonHtml(asset) + '</div>'
      + '</div>'

      // Response Time section — collapsed by default; subtitle shows
      // avg/max once the loader returns. `asset-monitor-sub` is the slot
      // the loader writes into.
      + sectionHeader("monitor", "Response Time", escapeHtml(monitorPillSubtext(asset)), st.sections.monitor, "asset-monitor-sub", "responseTime")
      + '<div class="sect-body" data-sect="monitor"' + (st.sections.monitor ? '' : ' hidden') + '>'
      + '  <div class="card-filled" style="padding:16px;margin-bottom:8px;">'
      + '    ' + rangeSegHtml("asset-range-seg", RANGES, st.range)
      + '    <div id="asset-monitor-chart" style="min-height:120px;"></div>'
      + '  </div>'
      + '</div>'

      // CPU + Memory section — collapsed by default; subtitle shows
      // cpu/mem avg/max once the loader returns. Its range is its own.
      + sectionHeader("telemetry", "CPU + Memory", "", st.sections.telemetry, "asset-telemetry-sub", "cpuMemory")
      + '<div class="sect-body" data-sect="telemetry"' + (st.sections.telemetry ? '' : ' hidden') + '>'
      + '  <div class="card-filled" style="padding:16px;margin-bottom:8px;">'
      + '    ' + rangeSegHtml("asset-telemetry-range-seg", CHART_RANGES, st.telemetryRange)
      + '    <div id="asset-telemetry-chart" style="min-height:120px;"></div>'
      + '  </div>'
      + '</div>'

      // General section
      + sectionHeader("general", "General", "", st.sections.general)
      + '<div class="sect-body" data-sect="general"' + (st.sections.general ? '' : ' hidden') + '>'
      + renderGeneralBody(asset)
      + '</div>'

      // Hardware Sensors section — populated by loadSystemInfo.
      + sectionHeader("temperatures", "Hardware Sensors", "", st.sections.temperatures, null, "temperature")
      + '<div class="sect-body" data-sect="temperatures"' + (st.sections.temperatures ? '' : ' hidden') + '>'
      + '  <div id="asset-temperatures-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // IPsec — hidden until loadIpsecGate finds tunnels or peers on this
      // Fortinet firewall (the desktop IPsec tab's prefetch-then-show).
      + '<div class="asset-storage-entry" id="asset-ipsec-btn-wrap" hidden>'
      + '  <button class="btn btn-tonal btn-block" id="asset-ipsec-btn"><svg viewBox="0 0 24 24"><use href="#i-shield"/></svg>View IPsec</button>'
      + '  <div class="asset-storage-sub" id="asset-ipsec-sub"></div>'
      + '</div>'

      // Interfaces section — populated by loadSystemInfo (operStatus=="up" only).
      + sectionHeader("interfaces", "Interfaces", "", st.sections.interfaces, null, "interfaces")
      + '<div class="sect-body" data-sect="interfaces"' + (st.sections.interfaces ? '' : ' hidden') + '>'
      + '  <div id="asset-interfaces-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // Storage — a page of its own (volumes; a hypervisor's arrays and
      // drives). Drawn for every asset: the page explains an empty answer.
      // The line under it is filled by loadSystemInfo / storageSummaryFor.
      + '<div class="asset-storage-entry">'
      + '  <button class="btn btn-tonal btn-block" id="asset-storage-btn"><svg viewBox="0 0 24 24"><use href="#i-storage"/></svg>View Storage</button>'
      + '  <div class="asset-storage-sub" id="asset-storage-sub"></div>'
      + '</div>'

      // Discovery sources — which integrations independently reported this
      // asset. Header subtitle shows the source count once loaded.
      + sectionHeader("sources", "Discovery sources", "", st.sections.sources, "asset-sources-sub")
      + '<div class="sect-body" data-sect="sources"' + (st.sections.sources ? '' : ' hidden') + '>'
      + '  <div id="asset-sources-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // FortiGate sightings — which firewalls have seen this asset (needs
      // assetsQuarantine read; degrades to a muted note otherwise).
      + sectionHeader("sightings", "Firewall sightings", "", st.sections.sightings, "asset-sightings-sub")
      + '<div class="sect-body" data-sect="sightings"' + (st.sections.sightings ? '' : ' hidden') + '>'
      + '  <div id="asset-sightings-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // IP history section
      + sectionHeader("ipHistory", "IP history", "", st.sections.ipHistory, "asset-ip-history-sub")
      + '<div class="sect-body" data-sect="ipHistory"' + (st.sections.ipHistory ? '' : ' hidden') + '>'
      + '  <div id="asset-ip-history-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>';

    var storageBtn = document.getElementById("asset-storage-btn");
    if (storageBtn) storageBtn.onclick = function () {
      goToPage({ kind: "storage", assetId: asset.id, title: "Storage", asset: asset });
    };
    paintStorageSummary(asset, null);

    // Section toggles
    document.querySelectorAll(".asset-sect-header").forEach(function (h) {
      h.addEventListener("click", function () {
        var key = h.dataset.key;
        st.sections[key] = !st.sections[key];
        var body = document.querySelector('.sect-body[data-sect="' + key + '"]');
        var caret = h.querySelector(".caret");
        if (body) {
          if (st.sections[key]) body.removeAttribute("hidden");
          else body.setAttribute("hidden", "");
        }
        // The icon is the <use> child's href — setting it on the <svg> does
        // nothing, which is why the chevron never flipped.
        if (caret) {
          var useEl = caret.querySelector("use");
          if (useEl) useEl.setAttribute("href", st.sections[key] ? "#i-chev-down" : "#i-chev-right");
        }
      });
    });

    // Range segmented controls — one per chart.
    wireRangeSeg("asset-range-seg", function (r) {
      st.range = r;
      loadMonitor(asset.id, st);
    });
    wireRangeSeg("asset-telemetry-range-seg", function (r) {
      st.telemetryRange = r;
      loadTelemetry(asset.id, st);
    });
    loadPollingChips(asset.id);
    // Quarantine / release action button (hero). The button renders
    // synchronously (fail-open); the availability probe re-renders the wrap if
    // it comes back saying no integration can be pushed to.
    var qWarm = warmQuarantinePushAvailability();
    if (qWarm) qWarm.then(function () {
      if (_openId !== asset.id || quarantinePushAvailable()) return;
      var wrap = document.getElementById("asset-quarantine-btn-wrap");
      if (!wrap) return;
      wrap.innerHTML = quarantineButtonHtml(asset);
      wireQuarantineButton(asset, st);
    });
    wireQuarantineButton(asset, st);

    // Back/refresh now live in the sheet header (wired once in ensureSheet).
  }

  // `subtitleHtml` is rendered raw (callers escape their own text). Pass
  // `subtitleId` when a loader needs to update the subtitle asynchronously
  // — the slot is always rendered so the loader can write into it even if
  // the initial subtitle is empty.
  // `pollStream` (optional) is the monitoring stream the section shows —
  // responseTime / cpuMemory / temperature / interfaces — and puts an empty
  // polling-method chip beside the title for loadPollingChips to fill.
  function sectionHeader(key, title, subtitleHtml, expanded, subtitleId, pollStream) {
    var subId = subtitleId ? ' id="' + subtitleId + '"' : '';
    var chip = pollStream
      ? '<span class="sect-poll" data-poll-stream="' + escapeHtml(pollStream) + '" hidden></span>'
      : '';
    return ''
      + '<button class="asset-sect-header" data-key="' + key + '">'
      + '  <div style="flex:1;text-align:left;min-width:0;">'
      + '    <div class="sect-title">' + escapeHtml(title) + chip + '</div>'
      + '    <div class="sect-sub"' + subId + '>' + (subtitleHtml || "") + '</div>'
      + '  </div>'
      + '  <svg class="caret" viewBox="0 0 24 24" width="24" height="24" style="fill:var(--md-on-surface-variant);flex-shrink:0;"><use href="' + (expanded ? "#i-chev-down" : "#i-chev-right") + '"/></svg>'
      + '</button>';
  }

  // A chart's range control: a segmented row of `ranges`, `current` lit.
  function rangeSegHtml(id, ranges, current) {
    return '<div class="seg" id="' + id + '" style="display:inline-flex;border:1px solid var(--md-outline);border-radius:var(--shape-full);overflow:hidden;margin-bottom:8px;">'
      + ranges.map(function (r) {
        return '<button class="seg-item' + (r === current ? " on" : "") + '" data-range="' + r + '">' + r + '</button>';
      }).join("")
      + '</div>';
  }

  // Wires a rangeSegHtml control: a tap on an unlit button lights it and
  // hands the new range to `onPick`.
  function wireRangeSeg(id, onPick) {
    var seg = document.getElementById(id);
    if (!seg) return;
    seg.querySelectorAll(".seg-item").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        if (b.classList.contains("on")) return;
        seg.querySelectorAll(".seg-item").forEach(function (x) { x.classList.toggle("on", x === b); });
        onPick(b.dataset.range);
      });
    });
  }

  // ─── Polling-method chips ──────────────────────────────────────────────
  // The labels the desktop uses (_POLLING_LABELS in integrations.js, which the
  // phone does not load).
  var POLLING_LABELS = {
    rest_api: "REST API", snmp: "SNMP", winrm: "WinRM", ssh: "SSH", icmp: "ICMP",
    disabled: "Disabled", agent: "Polaris Agent", vcenter: "vCenter", fortimanager: "FortiManager",
  };

  // Fill each section's chip from /effective-monitor-settings — the same
  // four-tier resolution the monitor uses, source default included, so the
  // chip names the method that actually runs. A null method means nothing
  // collects that stream for this asset ("Not collected"). Best-effort: on a
  // failed read the chips stay hidden rather than guess.
  function loadPollingChips(id) {
    if (!api.assets.effectiveMonitorSettings) return;
    api.assets.effectiveMonitorSettings(id).then(function (eff) {
      if (_openId !== id || !eff || !eff.resolved) return;
      document.querySelectorAll("#asset-host .sect-poll[data-poll-stream]").forEach(function (chip) {
        var method = eff.resolved[chip.dataset.pollStream + "Polling"];
        var label = method ? (POLLING_LABELS[method] || method) : "Not collected";
        chip.textContent = label;
        chip.title = "Polling method";
        chip.classList.toggle("off", !method || method === "disabled");
        chip.hidden = false;
      });
    }).catch(function () { /* chips stay hidden */ });
  }

  function renderGeneralBody(asset) {
    var rows = [];
    function row(k, v) { if (v != null && v !== "") rows.push({ k: k, v: v }); }
    row("Type", asset.assetType);
    // Controller admission state for managed FortiSwitches / FortiAPs
    // (fortinetTopology.state, stamped by FMG/FortiGate discovery).
    if (asset.assetType === "switch" || asset.assetType === "access_point") {
      var authState = asset.fortinetTopology && typeof asset.fortinetTopology === "object"
        ? asset.fortinetTopology.state : null;
      if (authState && typeof authState === "string") {
        row("Authorization", escapeHtml(authState.charAt(0).toUpperCase() + authState.slice(1)));
      }
    }
    // AP Profile — the wtp-profile the controller binds this AP to
    // (fortinetTopology.profile). Desktop General tab renders the same row.
    if (asset.assetType === "access_point") {
      var apProfile = asset.fortinetTopology && typeof asset.fortinetTopology === "object"
        ? asset.fortinetTopology.profile : null;
      if (apProfile && typeof apProfile === "string") {
        row("AP Profile", escapeHtml(apProfile));
      }
    }
    // The primary ADDRESS is a pair (business rule 102): the IP monitoring
    // probes and the card it is on — the pin's MAC, else the address row that
    // holds the IP, else the identity MAC. Mirrors primaryAddressMac() in
    // assets.js; the desktop lists every other address per MAC.
    var addrRows = Array.isArray(asset.associatedIps) ? asset.associatedIps : [];
    var primaryRow = asset.ipAddress
      ? addrRows.find(function (r) { return r.ip === asset.ipAddress && r.mac; })
      : null;
    var primaryMac = asset.primaryAddressMac || (primaryRow && primaryRow.mac) || asset.macAddress || null;
    // Rule 103's confidence for the primary, as the desktop chip shows it.
    var primaryConf = asset.addressConfidence && asset.ipAddress ? asset.addressConfidence[asset.ipAddress] : null;
    row("IP", asset.ipAddress
      ? '<span class="mono">' + escapeHtml(asset.ipAddress) + '</span>' +
        (asset.primaryAddressIp ? ' <span class="muted">pinned</span>' : '') +
        (primaryConf ? ' <span class="muted">· confidence ' + primaryConf.score + '</span>' : '')
      : null);
    row("MAC", primaryMac ? '<span class="mono">' + escapeHtml(primaryMac) + '</span>' : null);
    var others = addrRows.filter(function (r) { return r.ip !== asset.ipAddress; }).length;
    if (others > 0) row("Other IPs", String(others));
    row("Hostname", asset.hostname);
    row("DNS name", asset.dnsName);
    row("Serial", asset.serialNumber ? '<span class="mono">' + escapeHtml(asset.serialNumber) + '</span>' : null);
    row("Manufacturer", asset.manufacturer);
    row("Model", asset.model);
    row("OS", osRowValue(asset));
    // Uptime, and the Reboot verb (business rule 115) beside it. Always
    // rendered so the reboot loader has a slot; it removes the row again when
    // the device reports no uptime and Polaris cannot reboot it.
    row("Uptime", uptimeRowValue(asset));
    row("Location", asset.location || asset.learnedLocation);
    row("Department", asset.department);
    row("Assigned to", asset.assignedTo);
    row("Last seen", formatTimeAgo(asset.lastSeen));
    row("Last seen port", asset.lastSeenSwitch
      ? '<span class="mono">' + escapeHtml(asset.lastSeenSwitch) + '</span>'
      : null);
    row("Last seen AP", asset.lastSeenAp
      ? '<span class="mono">' + escapeHtml(asset.lastSeenAp) + '</span>'
      : null);
    row("Acquired", formatDate(asset.acquiredAt));

    if (rows.length === 0) {
      return '<div class="muted" style="padding:8px 16px 16px;">No additional details.</div>';
    }
    return rows.map(function (r) {
      return ''
        + '<div class="kv-row">'
        + '  <span class="k">' + escapeHtml(r.k) + '</span>'
        + '  <span class="v">' + (typeof r.v === "string" && r.v.indexOf("<") === 0 ? r.v : escapeHtml(r.v)) + '</span>'
        + '</div>';
    }).join("");
  }

  // ─── Loaders ───────────────────────────────────────────────────────────
  function loadMonitor(id, st) {
    var chartHost = document.getElementById("asset-monitor-chart");
    var sub = document.getElementById("asset-monitor-sub");
    if (chartHost) chartHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';

    var range = st.range;
    Promise.all([api.assets.monitorHistory(id, range), maintWindowsFor(id)]).then(function (got) {
      var resp = got[0], maint = got[1];
      if (_openId !== id || !resp) return;   // bail if a newer asset replaced us
      // Failed polls plot at the baseline in red (ok:false) so an outage reads
      // as the line diving to zero, matching the desktop response-time chart.
      // Rollup buckets have no per-sample `success` — they carry
      // successCount/sampleCount instead, and a partial-loss bucket still plots
      // its average rather than reading as a total outage.
      function hasResponse(s) {
        if (typeof s.successCount === "number") return s.successCount > 0 && typeof s.responseTimeMs === "number";
        return s.success && typeof s.responseTimeMs === "number";
      }
      function isFailure(s) {
        if (typeof s.successCount === "number") return s.sampleCount > 0 && s.successCount === 0;
        return !s.success;
      }
      // A miss taken while the asset was dependency-suppressed dives grey: the
      // upstream was dark, so nothing about this device is in question. A
      // rollup bucket qualifies only when EVERY failure in it was one.
      function isDependency(s) {
        if (typeof s.successCount === "number") {
          return s.failureCount > 0 && (s.dependencyFailureCount || 0) >= s.failureCount;
        }
        return s.dependencyDown === true;
      }
      // The COLOURS come from the shared replay of the monitor state machine
      // (public/js/monitor-states.js), the same one the desktop chart and the
      // Last-30-min strip run: up green, amber for a miss that has not reached
      // the covering automation's count, red for the miss that IS the verdict,
      // purple for a poll answering while misses are still outstanding. This is
      // the one chart that is about a VERDICT rather than a reading, which is
      // why it — and only it — carries five colours on every surface.
      //
      // `downDetection` rides the history payload, so the counts land with the
      // samples and the chart cannot paint an outage and repaint it a moment
      // later. Its ABSENCE is the unknown case: keep every miss red rather than
      // invent a threshold to be amber about.
      var dd = PolarisMonitorStates.fromPayload(resp.downDetection);
      // The colour a `down` probe is drawn in: the covering automation's own
      // severity (business rule 36), resolved through the same table the
      // desktop chart and the alert email read. Null severity — passive, or an
      // unresolved automation — keeps the red Down has always been.
      var downColor = (window.PolarisChartSeverity && dd.severity)
        ? window.PolarisChartSeverity.downColorOf(dd.severity)
        : null;
      var states = PolarisMonitorStates.replay(
        (resp.samples || []).map(function (s) { return { timestamp: s.timestamp, success: !isFailure(s) }; }),
        dd.threshold, dd.recoveryPolls,
      );
      var samples = [];
      (resp.samples || []).forEach(function (s, i) {
        var status = (states[i] && states[i].status) || "up";
        if (hasResponse(s)) samples.push({ ts: s.timestamp, v: s.responseTimeMs, rec: status === "recovering" });
        else if (isFailure(s)) {
          samples.push({
            ts: s.timestamp, v: null, ok: false, dep: isDependency(s),
            down: !dd.known || status === "down",
            downColor: downColor,
          });
        }
      });
      if (chartHost) {
        var bounds = rangeBounds(range);
        chartHost.innerHTML = PolarisCharts.lineChart({
          // The Up green rather than the app accent, mirroring desktop: the one
          // chart about reachability speaks the same colours as the status pill.
          series: [{ values: samples, color: "var(--md-success)", fill: true }],
          // Polling stops for a maintenance window, so the series has a hole
          // there; the band says why.
          maintenance: maint,
          from: bounds && bounds.from,
          to: bounds && bounds.to,
          height: 120,
          yUnit: "ms",
          ariaLabel: "Response time over " + st.range,
          // The key for the colours drawn — the same names the desktop chart
          // and the alert email use.
          legend: { series: "Up" },
        });
      }
      if (sub) {
        var stats = resp.stats || {};
        var statBits = [];
        if (stats.avgMs != null) statBits.push("avg " + stats.avgMs + " ms");
        if (stats.maxMs != null) statBits.push("max " + stats.maxMs + " ms");
        if (stats.packetLossRate != null && stats.packetLossRate > 0) {
          statBits.push((stats.packetLossRate * 100).toFixed(1) + "% loss");
        }
        sub.textContent = statBits.length ? statBits.join(" · ") : emptyStatsLabel(maint, range);
      }
    }).catch(function (err) {
      if (chartHost) chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load monitor history: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
      if (sub) sub.textContent = "—";
    });
  }

  function loadTelemetry(id, st) {
    var chartHost = document.getElementById("asset-telemetry-chart");
    var sub = document.getElementById("asset-telemetry-sub");
    if (chartHost) chartHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';

    var range = st.telemetryRange;
    Promise.all([api.assets.telemetryHistory(id, range), maintWindowsFor(id)]).then(function (got) {
      var resp = got[0], maint = got[1];
      if (_openId !== id || !resp) return;   // bail if a newer asset replaced us
      var samples = resp.samples || [];
      var cpuSeries = samples
        .filter(function (s) { return s.cpuPct != null; })
        .map(function (s) { return { ts: s.timestamp, v: s.cpuPct }; });
      var memSeries = samples
        .filter(function (s) { return s.memPct != null || (s.memUsedBytes != null && s.memTotalBytes); })
        .map(function (s) {
          var pct = s.memPct != null
            ? s.memPct
            : (s.memTotalBytes ? (Number(s.memUsedBytes) / Number(s.memTotalBytes)) * 100 : null);
          return { ts: s.timestamp, v: pct };
        })
        .filter(function (p) { return p.v != null; });

      if (cpuSeries.length === 0 && memSeries.length === 0) {
        if (chartHost) chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">No telemetry — this monitor type doesn’t collect CPU/memory.</div>';
        if (sub) sub.textContent = "Not collected for this monitor type";
        return;
      }
      if (chartHost) {
        var bounds = rangeBounds(range);
        chartHost.innerHTML = PolarisCharts.lineChart({
          maintenance: maint,
          from: bounds && bounds.from,
          to: bounds && bounds.to,
          // The telemetry stream carries no per-sample success flag — a failed
          // poll just leaves no row, because the telemetry cadence does not run
          // while the asset is down. `outages` carries the response-time probe’s
          // own failure record for the window, which is what the gapFade series
          // dive across.
          outages: resp.outages,
          series: [
            { values: cpuSeries, color: "var(--md-primary)", gapFade: true },
            { values: memSeries, color: "var(--md-tertiary)", gapFade: true },
          ],
          height: 120,
          yMin: 0, yMax: 100,
          yUnit: "%",
          ariaLabel: "CPU and memory over " + range,
        });
      }
      if (sub) {
        var stats = resp.stats || {};
        var bits = [];
        if (stats.avgCpuPct != null) bits.push('<span style="color:var(--md-primary);">cpu avg ' + Math.round(stats.avgCpuPct) + "%</span>");
        if (stats.maxCpuPct != null) bits.push("max " + Math.round(stats.maxCpuPct) + "%");
        if (stats.avgMemPct != null) bits.push('<span style="color:var(--md-tertiary);">mem avg ' + Math.round(stats.avgMemPct) + "%</span>");
        if (stats.maxMemPct != null) bits.push("max " + Math.round(stats.maxMemPct) + "%");
        sub.innerHTML = bits.length ? bits.join(" · ") : escapeHtml(emptyStatsLabel(maint, range));
      }
    }).catch(function (err) {
      if (chartHost) chartHost.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load telemetry: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
      if (sub) sub.textContent = "—";
    });
  }

  // Fetch system-info (current interfaces + temperatures + LLDP) and 1h
  // temperature samples for per-sensor min/avg/max. The two requests are
  // independent so they fly in parallel.
  function loadSystemInfo(id, st, asset) {
    if (asset) _assetCache[id] = asset;
    var resolvedAsset = asset || _assetCache[id] || null;
    var tempsHost  = document.getElementById("asset-temperatures-host");
    var ifacesHost = document.getElementById("asset-interfaces-host");
    if (!tempsHost && !ifacesHost) return;
    if (tempsHost)  tempsHost.innerHTML  = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    if (ifacesHost) ifacesHost.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';

    Promise.all([
      api.assets.systemInfo(id).catch(function (e) { return { error: e }; }),
      api.assets.hardwareHistory(id, { range: "1h" }).catch(function () { return null; }),
    ]).then(function (results) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      var info = results[0] || {};
      var tempHist = results[1] || null;

      if (info.error) {
        var msg = (info.error && info.error.message) ? info.error.message : "error";
        if (tempsHost)  tempsHost.innerHTML  = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load hardware sensors: ' + escapeHtml(msg) + '</div>';
        if (ifacesHost) ifacesHost.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load interfaces: ' + escapeHtml(msg) + '</div>';
        return;
      }

      // Cache for the interface-sheet open path so we don't re-fetch.
      _systemInfoCache[id] = info;

      if (tempsHost)  renderTemperatures(tempsHost, info, tempHist);
      if (ifacesHost) renderInterfaces(ifacesHost, info, id, st, resolvedAsset);
      paintStorageSummary(resolvedAsset, info);
    });
  }

  // Per-asset cache of the latest /system-info payload so the bottom sheet
  // can render details without re-fetching. Re-populated on every loadSystemInfo.
  var _systemInfoCache = Object.create(null);
  // Per-asset cache of the Asset row itself so async loaders (Refresh, the
  // interfaces toggle) can read fields like `monitoredInterfaces` without
  // re-fetching.
  var _assetCache = Object.create(null);

  function renderTemperatures(host, info, tempHist) {
    var sensors = (info && info.hardwareSensors) || [];
    if (sensors.length === 0) {
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No sensors reported.</div>';
      return;
    }
    function fmtNum(v) {
      if (typeof v !== "number" || !isFinite(v)) return "—";
      var a = Math.abs(v);
      return a >= 100 ? v.toFixed(0) : (a >= 10 ? v.toFixed(1) : v.toFixed(2));
    }
    // Aggregate the unfiltered 1h samples by sensorName for per-sensor
    // min/avg/max in one round-trip. AssetHardwareSensorSample rows carry
    // sensorName + value directly.
    var byName = Object.create(null);
    var samples = inWindow(tempHist && tempHist.samples, tempHist && tempHist.since);
    samples.forEach(function (s) {
      if (s.value == null || !s.sensorName) return;
      var b = byName[s.sensorName] || (byName[s.sensorName] = { sum: 0, n: 0, min: Infinity, max: -Infinity });
      b.sum += Number(s.value);
      b.n   += 1;
      if (s.value < b.min) b.min = Number(s.value);
      if (s.value > b.max) b.max = Number(s.value);
    });

    // Display-only °C→°F (install-wide `branding.temperatureUnit`). Gated on the
    // ROW's stored unit, so a fan's RPM stays RPM. Converting the aggregate is
    // safe: the transform is affine, so min/avg/max convert the same either way.
    var TU = window.PolarisTempUnit;
    var conv  = function (v, u) { return TU ? TU.convertReading(v, u) : v; };
    var uOf   = function (u) { return TU ? TU.displayUnit(u) : u; };

    var html = "";
    sensors.forEach(function (t, i) {
      var b = byName[t.sensorName];
      var displayUnit = uOf(t.unit);
      var unitSuffix = displayUnit ? " " + displayUnit : "";
      var statsLine;
      if (b && b.n > 0) {
        var avg = b.sum / b.n;
        statsLine = "1h · min " + fmtNum(conv(b.min, t.unit)) + " · avg " + fmtNum(conv(avg, t.unit)) +
          " · max " + fmtNum(conv(b.max, t.unit)) + unitSuffix;
      } else {
        statsLine = "no 1h history";
      }
      if (t.alarmStatus === "alarm") statsLine = "⚠ alarm · " + statsLine;
      var current = (t.value != null) ? fmtNum(conv(t.value, t.unit)) + unitSuffix : "—";
      html += ''
        + '<div class="list-item two-line" style="padding-left:16px;padding-right:16px;">'
        + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-temp"/></svg></span>'
        + '  <div class="content">'
        + '    <div class="headline">' + escapeHtml(t.sensorName || "sensor") + '</div>'
        + '    <div class="supporting">' + escapeHtml(statsLine) + '</div>'
        + '  </div>'
        + '  <span class="trailing mono" style="font-weight:600;">' + escapeHtml(current) + '</span>'
        + '</div>'
        + (i < sensors.length - 1 ? '<div class="list-divider"></div>' : '');
    });
    host.innerHTML = html;
  }

  // Default view: only `Asset.monitoredInterfaces` (the operator-pinned
  // fast-poll subset) — these are the interfaces the operator cares about,
  // and pinned-but-currently-down ones are kept so the operator can see
  // the outage. Expanded view: every interface whose latest sample reports
  // operStatus==="up", regardless of pinning. The "Show all / Show
  // monitored only" button at the bottom of the section flips
  // `st.interfacesShowAll` and re-renders.
  // PoE port state (pethPsePortDetectionStatus, RFC 3621) — the desktop
  // interface table's labels. `cls` colours it: delivering is good, a fault
  // is bad, everything else (searching, disabled, test) is neutral.
  var POE_LABELS = {
    disabled: "Disabled", searching: "Searching", delivering: "Delivering",
    fault: "Fault", test: "Test", "other-fault": "Fault (other)",
  };
  function poeCls(status) {
    if (status === "delivering") return "poe-ok";
    if (status === "fault" || status === "other-fault") return "poe-fault";
    return "poe-idle";
  }
  // `bare`: drop the "PoE " prefix — for a row already labelled PoE.
  function poeLabelHtml(iface, bare) {
    if (!iface || !iface.poeStatus) return "";
    return '<span class="poe-label ' + poeCls(iface.poeStatus) + '">' + (bare ? "" : "PoE ")
      + escapeHtml(POE_LABELS[iface.poeStatus] || iface.poeStatus) + '</span>';
  }

  // A switch's PoE at a glance, over EVERY port the system-info read returned —
  // not just the up ones the list shows, since a searching or faulted port is
  // usually down. Empty when no port reports PoE (most devices). Faulted ports
  // are named, because that is the line an operator opened this for.
  function poeSummaryHtml(ifaces) {
    var counts = { delivering: 0, searching: 0, fault: 0 };
    var faulted = [];
    var any = false;
    ifaces.forEach(function (i) {
      if (!i.poeStatus) return;
      any = true;
      if (i.poeStatus === "delivering") counts.delivering++;
      else if (i.poeStatus === "searching") counts.searching++;
      else if (i.poeStatus === "fault" || i.poeStatus === "other-fault") {
        counts.fault++;
        faulted.push(i.alias || i.ifName || "(unnamed)");
      }
    });
    if (!any) return "";
    var bits = [
      '<span class="poe-label poe-ok">' + counts.delivering + ' delivering</span>',
      '<span class="poe-label poe-idle">' + counts.searching + ' searching</span>',
      '<span class="poe-label ' + (counts.fault ? "poe-fault" : "poe-idle") + '">' + counts.fault + ' fault</span>',
    ];
    return ''
      + '<div class="poe-summary">'
      + '  <div class="poe-summary-row"><span class="poe-summary-k">PoE</span>' + bits.join("") + '</div>'
      + (faulted.length ? '  <div class="poe-summary-faults">Faulted: <span class="mono">' + faulted.map(escapeHtml).join(", ") + '</span></div>' : '')
      + '</div>';
  }

  function renderInterfaces(host, info, assetId, st, asset) {
    // IPsec tunnels are the IPsec page's, as they are the desktop IPsec tab's
    // and not its Interfaces table: FortiGate reports each one twice, as an
    // IPsec tunnel and as a tunnel-type interface. A tunnel interface with no
    // IPsec twin (GRE, VXLAN, ssl.root) stays. Mirrors _renderInterfacesTable.
    var ipsecNames = Object.create(null);
    var ipsecCount = 0;
    ((info && info.ipsecTunnels) || []).forEach(function (tn) {
      if (tn && tn.tunnelName && !ipsecNames[tn.tunnelName]) { ipsecNames[tn.tunnelName] = true; ipsecCount++; }
    });
    var ifaces = ((info && info.interfaces) || []).filter(function (i) {
      return !(i.ifType === "tunnel" && ipsecNames[i.ifName]);
    });
    var monitoredSet = Object.create(null);
    var monitoredArr = (asset && asset.monitoredInterfaces) || [];
    monitoredArr.forEach(function (n) { if (n) monitoredSet[n] = true; });

    var allUp = ifaces.filter(function (i) { return (i.operStatus || "").toLowerCase() === "up"; });
    var monitored = ifaces.filter(function (i) { return monitoredSet[i.ifName]; });

    function cmp(a, b) {
      var an = (a.alias || a.ifName || "").toLowerCase();
      var bn = (b.alias || b.ifName || "").toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    }
    allUp.sort(cmp);
    monitored.sort(cmp);

    var showAll = !!(st && st.interfacesShowAll);
    var visible = showAll ? allUp : monitored;

    var listHtml = "";
    if (visible.length === 0) {
      if (!showAll && monitoredArr.length === 0) {
        listHtml = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No interfaces monitored. Tap <b>Show all</b> to browse every up interface.</div>';
      } else if (!showAll) {
        // monitoredArr non-empty but no matching samples yet (heavy cadence hasn't fired).
        listHtml = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Monitored interfaces pinned but no samples yet.</div>';
      } else {
        listHtml = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No interfaces up.</div>';
      }
    } else {
      visible.forEach(function (iface, i) {
        var label = iface.alias || iface.ifName || "(unnamed)";
        var sub   = iface.alias && iface.ifName && iface.alias !== iface.ifName
          ? iface.ifName
          : (iface.ipAddress || "");
        var speed = (iface.speedBps != null) ? formatBps(iface.speedBps) : "";
        var idx   = String(i);
        // operStatus drives the leading status dot — pinned-but-down monitored
        // interfaces should look down, not up, when the operator opens the section.
        var statusCls = (iface.operStatus || "").toLowerCase() === "up" ? "up" : "down";
        listHtml += ''
          + '<div class="list-item two-line iface-row" data-iface-idx="' + escapeHtml(idx) + '" role="button" tabindex="0" style="padding-left:16px;padding-right:16px;cursor:pointer;">'
          + '  <span class="leading"><span class="dot ' + statusCls + '" style="display:inline-block;width:10px;height:10px;border-radius:50%;"></span></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(label) + '</div>'
          + (sub ? '    <div class="supporting mono">' + escapeHtml(sub) + '</div>' : '')
          + '  </div>'
          + '  <span class="trailing iface-trailing">'
          + '    <span class="muted mono" style="font-size:12px;">' + escapeHtml(speed) + '</span>'
          + poeLabelHtml(iface)
          + '  </span>'
          + '</div>'
          + (i < visible.length - 1 ? '<div class="list-divider"></div>' : '');
      });
    }

    var btnLabel = showAll
      ? "Show monitored only"
      : "Show all" + (allUp.length ? " (" + allUp.length + ")" : "");
    var toggleHtml = ''
      + '<div style="padding:12px 16px 4px;">'
      + '  <button class="btn btn-tonal" id="iface-show-all-btn" style="width:100%;">' + escapeHtml(btnLabel) + '</button>'
      + '</div>';

    // "4 IPsec tunnels are on the IPsec page" — the line that replaces them.
    var ipsecPointer = ipsecCount
      ? '<div class="muted" style="padding:8px 16px 0;font-size:13px;">' + ipsecCount + ' IPsec tunnel' + (ipsecCount === 1 ? ' is' : 's are')
        + ' on the <a href="#" id="iface-ipsec-link">IPsec page</a>.</div>'
      : '';

    host.innerHTML = poeSummaryHtml(ifaces) + listHtml + ipsecPointer + toggleHtml;

    var ipsecLink = document.getElementById("iface-ipsec-link");
    if (ipsecLink) ipsecLink.addEventListener("click", function (e) {
      e.preventDefault();
      goToPage({ kind: "ipsec", assetId: assetId, title: "IPsec" });
    });

    // Wire row taps — index into the same `visible` list rendered above.
    host.querySelectorAll(".iface-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var idx = parseInt(row.dataset.ifaceIdx, 10);
        if (isNaN(idx)) return;
        var ifc = visible[idx];
        goToPage({
          kind: "iface", assetId: assetId, iface: ifc, info: info, monitored: !!monitoredSet[ifc.ifName],
          title: ifc.alias || ifc.ifName || "Interface",
          sub: (ifc.alias && ifc.ifName && ifc.alias !== ifc.ifName) ? ifc.ifName : "",
        });
      });
    });

    // Wire the toggle — flips state and re-renders against the same data.
    var toggleBtn = document.getElementById("iface-show-all-btn");
    if (toggleBtn) toggleBtn.addEventListener("click", function () {
      if (st) st.interfacesShowAll = !st.interfacesShowAll;
      renderInterfaces(host, info, assetId, st, asset);
    });
  }

  // ─── Interface page ────────────────────────────────────────────────────
  // A page of the asset sheet (PAGE_KINDS.iface); its title and ifName ride
  // the header's title row. `monitored`: the interface is in the asset's
  // monitoredInterfaces — those get the throughput + error charts (the
  // desktop interface panel's pair).
  function renderInterfacePage(el, iface, info, assetId, monitored) {
    // Rows: status, speed, ip, mac, errors. Keep it tight.
    var rows = [];
    function row(k, v, mono) {
      if (v == null || v === "") return;
      rows.push({ k: k, v: v, mono: !!mono });
    }
    var statusBits = [];
    if (iface.operStatus)  statusBits.push("oper " + iface.operStatus);
    if (iface.adminStatus) statusBits.push("admin " + iface.adminStatus);
    row("Status", statusBits.join(" · "));
    row("Speed", iface.speedBps != null ? formatBps(iface.speedBps) : null);
    if (iface.ifType) row("Type", iface.ifType + (iface.vlanId != null ? " · VLAN " + iface.vlanId : ""));
    row("IP",  iface.ipAddress, true);
    if (iface.addressingMode) {
      var amLabel = { dhcp: "DHCP", static: "Static", pppoe: "PPPoE" }[String(iface.addressingMode).toLowerCase()] || iface.addressingMode;
      row("Addressing", amLabel);
    }
    row("MAC", iface.macAddress, true);
    if (iface.poeStatus) {
      // Status and class read together, as on the desktop: the class is a
      // budget bracket, meaningless without knowing power is flowing.
      rows.push({
        k: "PoE",
        html: poeLabelHtml(iface, true)
          + (iface.poeClass ? ' <span class="muted mono" style="font-size:12px;">' + escapeHtml(iface.poeClass) + '</span>' : ''),
      });
    }
    row("In errors",  iface.inErrors  != null ? String(iface.inErrors)  : null);
    row("Out errors", iface.outErrors != null ? String(iface.outErrors) : null);

    var detailRowsHtml = rows.map(function (r) {
      var v = r.html != null ? r.html
        : r.mono ? '<span class="mono">' + escapeHtml(r.v) + '</span>' : escapeHtml(r.v);
      return ''
        + '<div class="kv-row">'
        + '  <span class="k">' + escapeHtml(r.k) + '</span>'
        + '  <span class="v">' + v + '</span>'
        + '</div>';
    }).join("");

    // LLDP neighbors on this localIfName — drawn from the cached system-info
    // payload. Peer-inferred rows are included server-side so they render here too.
    var allNeighbors = (info && info.lldpNeighbors) || [];
    var neighbors = allNeighbors.filter(function (n) { return n.localIfName === iface.ifName; });
    var neighborHtml = "";
    if (neighbors.length === 0) {
      neighborHtml = '<div class="muted" style="padding:4px 0 0;font-size:13px;">No LLDP neighbor seen.</div>';
    } else {
      neighborHtml = neighbors.map(function (n) {
        var headline = n.systemName || n.managementIp || n.chassisId || "(unknown)";
        var portBit  = n.portId ? '<span class="mono">' + escapeHtml(n.portId) + '</span>' : "";
        var metaBits = [];
        if (n.managementIp) metaBits.push('<span class="mono">' + escapeHtml(n.managementIp) + '</span>');
        if (n.chassisId && n.chassisId !== n.managementIp) metaBits.push('<span class="mono">' + escapeHtml(n.chassisId) + '</span>');
        if (n.source === "peer-inferred") metaBits.push('<em>inferred</em>');
        var matchBtn = "";
        if (n.matchedAsset && n.matchedAsset.id) {
          matchBtn = '<button class="btn btn-tonal iface-neighbor-pivot" data-asset-id="' + escapeHtml(n.matchedAsset.id) + '" style="margin-top:8px;"><svg viewBox="0 0 24 24"><use href="#i-server"/></svg>View asset</button>';
        }
        return ''
          + '<div class="card-filled" style="padding:12px;margin-bottom:8px;">'
          + '  <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">'
          + '    <div style="min-width:0;font-weight:500;">' + linkHtml(n.matchedAsset && n.matchedAsset.id, headline) + '</div>'
          + '    <div style="font-size:12px;">' + portBit + '</div>'
          + '  </div>'
          + (metaBits.length ? '  <div class="muted" style="font-size:12px;margin-top:4px;">' + metaBits.join(" · ") + '</div>' : '')
          + (n.systemDescription ? '  <div class="muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(n.systemDescription) + '</div>' : '')
          + matchBtn
          + '</div>';
      }).join("");
    }

    el.innerHTML = ''
      + detailRowsHtml
      + (monitored
        ? ''
          + '<div style="font-weight:500;margin:16px 0 8px;">Usage</div>'
          + rangeSegHtml("iface-range-seg", CHART_RANGES, "1h")
          + '<div id="iface-tput-chart" style="min-height:120px;"></div>'
          + '<div class="muted" id="iface-tput-sub" style="font-size:12px;margin-top:4px;"></div>'
          + '<div style="font-weight:500;margin:16px 0 8px;">Errors</div>'
          + '<div id="iface-err-chart" style="min-height:120px;"></div>'
          + '<div class="muted" id="iface-err-sub" style="font-size:12px;margin-top:4px;"></div>'
        : '')
      + '<div style="font-weight:500;margin:16px 0 8px;">Neighbor</div>'
      + neighborHtml;

    el.querySelectorAll(".iface-neighbor-pivot").forEach(function (b) {
      b.addEventListener("click", function () {
        var nid = b.dataset.assetId;
        if (nid) open(nid);   // the neighbor, a page forward of this one
      });
    });
    if (monitored && iface.ifName) {
      wireRangeSeg("iface-range-seg", function (r) { loadInterfaceCharts(assetId, iface.ifName, r); });
      loadInterfaceCharts(assetId, iface.ifName, "1h");
    }
  }

  // Counter samples → per-interval rates. Mirrors _derivePerIntervalSeries in
  // public/js/assets.js: a rolled-up window (bucketSeconds set) already carries
  // per-second rates; raw samples are cumulative counters, differenced pairwise,
  // with a counter reset (negative delta) dropped rather than drawn as a spike.
  // Errors come out as a count per interval, not per second.
  function deriveInterfaceSeries(samples, data) {
    samples = samples || [];
    if (data && typeof data.bucketSeconds === "number" && data.bucketSeconds > 0) {
      var bucketSec = data.bucketSeconds;
      return samples.map(function (s) {
        return {
          ts: s.timestamp,
          inBps:  typeof s.inBytesPerSec  === "number" ? s.inBytesPerSec  * 8 : null,
          outBps: typeof s.outBytesPerSec === "number" ? s.outBytesPerSec * 8 : null,
          inErr:  typeof s.inErrorsPerSec  === "number" ? Math.round(s.inErrorsPerSec  * bucketSec) : null,
          outErr: typeof s.outErrorsPerSec === "number" ? Math.round(s.outErrorsPerSec * bucketSec) : null,
        };
      });
    }
    function delta(a, b) {
      if (typeof a !== "number" || typeof b !== "number") return null;
      return b - a < 0 ? null : b - a;
    }
    var out = [];
    for (var i = 1; i < samples.length; i++) {
      var prev = samples[i - 1], cur = samples[i];
      var dtSec = (new Date(cur.timestamp) - new Date(prev.timestamp)) / 1000;
      if (!(dtSec > 0)) continue;
      var inOct = delta(prev.inOctets, cur.inOctets);
      var outOct = delta(prev.outOctets, cur.outOctets);
      out.push({
        ts: cur.timestamp,
        inBps:  inOct  != null ? (inOct  * 8) / dtSec : null,
        outBps: outOct != null ? (outOct * 8) / dtSec : null,
        inErr:  delta(prev.inErrors,  cur.inErrors),
        outErr: delta(prev.outErrors, cur.outErrors),
      });
    }
    return out;
  }

  // The bit-rate unit a peak reads best in; the chart is drawn in that unit
  // so its axis ticks stay short.
  function bpsScale(peak) {
    if (peak >= 1e9) return { div: 1e9, unit: "Gbps" };
    if (peak >= 1e6) return { div: 1e6, unit: "Mbps" };
    if (peak >= 1e3) return { div: 1e3, unit: "Kbps" };
    return { div: 1, unit: "bps" };
  }
  function fmtBps(v) {
    var sc = bpsScale(v);
    var n = v / sc.div;
    return (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2)) + " " + sc.unit;
  }

  function loadInterfaceCharts(assetId, ifName, range) {
    var tputEl = document.getElementById("iface-tput-chart");
    var errEl = document.getElementById("iface-err-chart");
    var tputSub = document.getElementById("iface-tput-sub");
    var errSub = document.getElementById("iface-err-sub");
    if (!tputEl || !errEl) return;
    var spinner = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    tputEl.innerHTML = errEl.innerHTML = spinner;
    if (tputSub) tputSub.textContent = "";
    if (errSub) errSub.textContent = "";
    // The sheet belongs to one (asset, interface, range): a reply for any
    // other — a closed sheet, a different port, a range tapped since — drops.
    var current = function () {
      var seg = document.getElementById("iface-range-seg");
      var on = seg && seg.querySelector(".seg-item.on");
      return _openId === assetId && document.getElementById("iface-tput-chart") === tputEl
        && on && on.dataset.range === range;
    };
    Promise.all([api.assets.interfaceHistory(assetId, ifName, { range: range }), maintWindowsFor(assetId)]).then(function (got) {
      if (!current()) return;
      var data = got[0] || {}, maint = got[1];
      var d = deriveInterfaceSeries(data.samples, data);
      var bounds = rangeBounds(range);
      var common = { maintenance: maint, from: bounds && bounds.from, to: bounds && bounds.to, outages: data.outages, height: 120 };

      var inPts = [], outPts = [], peak = 0, inSum = 0, inN = 0, outSum = 0, outN = 0;
      var t0 = data.since != null ? +new Date(data.since) : NaN;
      d.forEach(function (p) {
        // Lookback points are drawn (off-plot, so the line enters from the
        // edge) but never counted in the averages or the axis peak.
        var counted = !(+new Date(p.ts) < t0);
        if (p.inBps != null)  { inPts.push({ ts: p.ts, v: p.inBps });  if (counted) { inSum += p.inBps;  inN++;  if (p.inBps > peak) peak = p.inBps; } }
        if (p.outBps != null) { outPts.push({ ts: p.ts, v: p.outBps }); if (counted) { outSum += p.outBps; outN++; if (p.outBps > peak) peak = p.outBps; } }
      });
      if (!inPts.length && !outPts.length) {
        tputEl.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">' + escapeHtml(emptyStatsLabel(maint, range)) + '</div>';
      } else {
        var sc = bpsScale(peak);
        var scaled = function (pts) { return pts.map(function (p) { return { ts: p.ts, v: p.v / sc.div }; }); };
        tputEl.innerHTML = PolarisCharts.lineChart(Object.assign({}, common, {
          series: [
            { values: scaled(inPts),  color: "var(--md-primary)",  gapFade: true },
            { values: scaled(outPts), color: "var(--md-tertiary)", gapFade: true },
          ],
          // An idle port peaks at 0 — give it a 0–1 axis, not lineChart's
          // -1–1 for a flat line.
          yMin: 0, yMax: peak > 0 ? undefined : 1, yUnit: sc.unit,
          ariaLabel: ifName + " throughput over " + range,
        }));
        if (tputSub) tputSub.innerHTML = ''
          + '<span style="color:var(--md-primary);">in avg ' + escapeHtml(fmtBps(inN ? inSum / inN : 0)) + '</span>'
          + ' · <span style="color:var(--md-tertiary);">out avg ' + escapeHtml(fmtBps(outN ? outSum / outN : 0)) + '</span>'
          + ' · peak ' + escapeHtml(fmtBps(peak));
      }

      var inE = [], outE = [], inTot = 0, outTot = 0;
      d.forEach(function (p) {
        var counted = !(+new Date(p.ts) < t0);
        if (p.inErr != null)  { inE.push({ ts: p.ts, v: p.inErr });  if (counted) inTot += p.inErr; }
        if (p.outErr != null) { outE.push({ ts: p.ts, v: p.outErr }); if (counted) outTot += p.outErr; }
      });
      if (!inE.length && !outE.length) {
        errEl.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">' + escapeHtml(emptyStatsLabel(maint, range)) + '</div>';
      } else {
        errEl.innerHTML = PolarisCharts.lineChart(Object.assign({}, common, {
          series: [
            { values: inE,  color: "var(--md-error)",   gapFade: true },
            { values: outE, color: "var(--md-warning)", gapFade: true },
          ],
          // A clean port (the usual case) is all zeros: same 0–1 axis.
          yMin: 0, yMax: (inTot + outTot) > 0 ? undefined : 1,
          ariaLabel: ifName + " errors over " + range,
        }));
        if (errSub) errSub.innerHTML = ''
          + '<span style="color:var(--md-error);">in ' + inTot + '</span>'
          + ' · <span style="color:var(--md-warning);">out ' + outTot + '</span>'
          + ' · total ' + (inTot + outTot);
      }
    }).catch(function (err) {
      if (!current()) return;
      var msg = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load interface history: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
      tputEl.innerHTML = msg;
      errEl.innerHTML = "";
    });
  }

  function formatBps(bps) {
    if (bps == null) return "";
    var n = Number(bps);
    if (!isFinite(n) || n <= 0) return "";
    if (n >= 1e9) return (n / 1e9) + " Gbps";
    if (n >= 1e6) return (n / 1e6) + " Mbps";
    if (n >= 1e3) return (n / 1e3) + " Kbps";
    return n + " bps";
  }

  // ─── IPsec ───────────────────────────────────────────────────────────────
  // "View IPsec" (above Interfaces) opens the IPsec page: the desktop IPsec
  // tab's two lists — Tunnels & peers (each tunnel, and under a dial-up
  // template the spokes / peers connected through it) and Remote access
  // (FortiClient users). Read-only: the per-minute pin and a tunnel's history
  // are desktop-only. A matched peer device opens that asset a page forward.
  var IPSEC_KIND_LABELS = {
    "advpn-spoke": "ADVPN spoke", "advpn-shortcut": "ADVPN shortcut", "dialup-peer": "Dial-up peer",
    "remote-access": "FortiClient (IPsec)", "ssl-vpn": "FortiClient (SSL-VPN)",
  };
  function ipsecIsRemoteAccess(c) { return c.kind === "remote-access" || c.kind === "ssl-vpn"; }
  // The payload the gate fetched, per asset — the page draws from it.
  var _ipsecCache = Object.create(null);

  // Gate: the desktop's — a firewall from FortiManager / standalone FortiGate,
  // and the button only once the read returns a tunnel or a connection.
  function loadIpsecGate(id, asset) {
    if (!asset || asset.assetType !== "firewall") return;
    var srcType = (asset.discoveredByIntegration && asset.discoveredByIntegration.type) || "manual";
    if (srcType !== "fortimanager" && srcType !== "fortigate") return;
    api.assets.ipsec(id).then(function (data) {
      if (_openId !== id) return;
      var tunnels = (data && data.tunnels) || [];
      var conns = (data && data.connections) || [];
      if (!tunnels.length && !conns.length) return;
      _ipsecCache[id] = data;
      var wrap = document.getElementById("asset-ipsec-btn-wrap");
      var btn = document.getElementById("asset-ipsec-btn");
      var sub = document.getElementById("asset-ipsec-sub");
      if (wrap) wrap.hidden = false;
      if (btn) btn.onclick = function () { goToPage({ kind: "ipsec", assetId: id, title: "IPsec" }); };
      if (sub) sub.textContent = ipsecSummary(tunnels, conns);
    }).catch(function () { /* gate is best-effort — no button on failure */ });
  }

  // "6 tunnels · 1 down · 42 peers · 3 users" — the line under the button.
  function ipsecSummary(tunnels, conns) {
    var down = tunnels.filter(function (t) { return t.status === "down"; }).length;
    var users = conns.filter(ipsecIsRemoteAccess).length;
    var peers = conns.length - users;
    var bits = [tunnels.length + " tunnel" + (tunnels.length === 1 ? "" : "s")];
    if (down) bits.push(down + " down");
    if (peers) bits.push(peers + " peer" + (peers === 1 ? "" : "s"));
    if (users) bits.push(users + " user" + (users === 1 ? "" : "s"));
    return bits.join(" · ");
  }

  // "3d 04h" / "5h 12m" / "40m" — how long a connection has been up
  // (the desktop's _ipsecUptimeLabel).
  function ipsecUptime(since) {
    if (!since) return "";
    var sec = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
    if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h " + String(Math.floor((sec % 3600) / 60)).padStart(2, "0") + "m";
    return Math.floor(sec / 86400) + "d " + String(Math.floor((sec % 86400) / 3600)).padStart(2, "0") + "h";
  }

  // up / down as every asset dot reads; "dynamic" (a dial-up template working
  // as configured with nobody on it) the passive one, not a verdict.
  function ipsecDotCls(status) {
    return status === "up" ? "up" : status === "down" ? "down" : status === "dynamic" ? "passive" : "warn";
  }

  function renderIpsecPage(el, p) {
    var cached = _ipsecCache[p.assetId];
    if (cached && !p.refetch) { drawIpsecPage(el, cached, p); return; }
    p.refetch = false;
    el.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    var seq = _pageSeq;
    api.assets.ipsec(p.assetId).then(function (data) {
      if (seq !== _pageSeq || currentPage() !== p) return;
      _ipsecCache[p.assetId] = data;
      drawIpsecPage(el, data, p);
      restoreScroll(p);
    }).catch(function (err) {
      if (seq !== _pageSeq || currentPage() !== p) return;
      el.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0 16px;">Couldn’t load IPsec: ' + escapeHtml((err && err.message) || "error") + '</div>';
    });
  }

  function drawIpsecPage(el, data, p) {
    var tunnels = (data && data.tunnels) || [];
    var conns = (data && data.connections) || [];
    if (!tunnels.length && !conns.length) {
      el.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0 16px;">This firewall reported no IPsec tunnels or VPN connections.</div>';
      return;
    }
    var users = conns.filter(ipsecIsRemoteAccess);
    var byParent = Object.create(null);
    var usersByParent = Object.create(null);
    conns.forEach(function (c) {
      var k = c.parentTunnel || "";
      if (ipsecIsRemoteAccess(c)) { if (k) usersByParent[k] = (usersByParent[k] || 0) + 1; return; }
      (byParent[k] = byParent[k] || []).push(c);
    });
    var tunnelNames = Object.create(null);
    tunnels.forEach(function (t) { tunnelNames[t.tunnelName] = true; });
    // A peer whose template is not in the tunnel read (that pass failed) still
    // gets a group of its own.
    var orphanParents = Object.keys(byParent).filter(function (k) { return !tunnelNames[k]; }).sort();
    // Which dial-up templates the operator opened — they start closed, since a
    // hub's ADVPN template can carry hundreds of spokes. Per page visit.
    var opened = p.openTemplates || (p.openTemplates = Object.create(null));

    function deviceHtml(matched, peerId) {
      if (matched) return linkHtml(matched.id, matched.hostname || matched.ipAddress || matched.id);
      return peerId ? '<span class="mono">' + escapeHtml(peerId) + '</span>' : "";
    }
    function addr(v) { return v && v !== "0.0.0.0" ? '<span class="mono">' + escapeHtml(v) + '</span>' : ""; }
    function bytesLine(i, o) {
      if (i == null && o == null) return "";
      return "in " + escapeHtml(bytesText(i)) + " · out " + escapeHtml(bytesText(o));
    }
    function row(dotCls, headHtml, lines, opts) {
      opts = opts || {};
      var body = lines.filter(Boolean).map(function (l) { return '<div class="supporting">' + l + '</div>'; }).join("");
      return ''
        + '<div class="list-item two-line ipsec-row' + (opts.nested ? ' ipsec-peer' : '') + '"' + (opts.attrs || '')
        + ' style="padding-left:' + (opts.nested ? '20px' : '0') + ';padding-right:0;align-items:flex-start;' + (opts.hidden ? 'display:none;' : '') + '">'
        + '  <span class="leading" style="margin-top:4px;"><span class="dot ' + dotCls + '"></span></span>'
        + '  <div class="content" style="min-width:0;">'
        + '    <div class="headline">' + headHtml + '</div>'
        + body
        + '  </div>'
        + (opts.trailing ? '  <span class="trailing">' + opts.trailing + '</span>' : '')
        + '</div>';
    }
    function peerRow(c, parent, hidden) {
      var kind = escapeHtml(IPSEC_KIND_LABELS[c.kind] || c.kind || "");
      var up = ipsecUptime(c.connectedSince);
      return row(ipsecDotCls(c.status), '<span class="mono">' + escapeHtml(c.name || "") + '</span>', [
        [kind, up ? "up " + escapeHtml(up) : ""].filter(Boolean).join(" · "),
        [deviceHtml(c.matchedAsset, c.peerId), addr(c.remoteGateway), addr(c.tunnelIp)].filter(Boolean).join(" · "),
        bytesLine(c.incomingBytes, c.outgoingBytes),
      ], { nested: true, hidden: hidden, attrs: parent != null ? ' data-parent="' + escapeHtml(parent) + '"' : '' });
    }

    var html = '<div style="font-weight:500;margin:8px 0 4px;">Tunnels &amp; peers</div>';
    tunnels.forEach(function (t) {
      var kids = byParent[t.tunnelName] || [];
      var collapsible = t.status === "dynamic" && kids.length > 0;
      var isOpen = !!opened[t.tunnelName];
      var connected = kids.length + (usersByParent[t.tunnelName] || 0);
      var kindText = t.status === "dynamic" ? "Dial-up template · " + connected + " connected" : "Site-to-site";
      var via = [t.parentInterface ? '<span class="mono">' + escapeHtml(t.parentInterface) + '</span>' : "", addr(t.overlayIp)].filter(Boolean).join(" · ");
      var toggle = collapsible
        ? '<button type="button" class="btn btn-text ipsec-toggle" data-parent="' + escapeHtml(t.tunnelName) + '" aria-expanded="' + isOpen + '"'
          + ' aria-label="' + (isOpen ? "Hide" : "Show") + ' peers" style="padding:4px 8px;min-height:0;">'
          + '<svg viewBox="0 0 24 24" width="20" height="20"><use href="' + (isOpen ? "#i-chev-down" : "#i-chev-right") + '"/></svg>' + kids.length + '</button>'
        : "";
      html += '<div class="list-divider"></div>'
        + row(ipsecDotCls(t.status), '<span class="mono" style="font-weight:600;">' + escapeHtml(t.tunnelName) + '</span>', [
          escapeHtml(kindText) + " · " + escapeHtml(t.status || "—"),
          [deviceHtml(t.matchedAsset, null), addr(t.remoteGateway)].filter(Boolean).join(" · "),
          via,
          bytesLine(t.incomingBytes, t.outgoingBytes),
        ], { trailing: toggle });
      kids.forEach(function (c) { html += peerRow(c, t.tunnelName, collapsible && !isOpen); });
    });
    orphanParents.forEach(function (k) {
      html += '<div class="list-divider"></div>'
        + row("unk", '<span class="mono" style="font-weight:600;">' + escapeHtml(k || "(no tunnel reported)") + '</span>', ["tunnel not in the last read"]);
      byParent[k].forEach(function (c) { html += peerRow(c, null, false); });
    });

    if (users.length) {
      html += '<div style="font-weight:500;margin:20px 0 4px;">Remote access</div>';
      users.forEach(function (c, i) {
        var up = ipsecUptime(c.connectedSince);
        html += (i ? '<div class="list-divider"></div>' : '')
          + row(ipsecDotCls(c.status), escapeHtml(c.userName || c.peerId || c.name || "(user)"), [
            [escapeHtml(IPSEC_KIND_LABELS[c.kind] || c.kind || ""), c.parentTunnel ? "via " + escapeHtml(c.parentTunnel) : "", up ? "up " + escapeHtml(up) : ""].filter(Boolean).join(" · "),
            [addr(c.remoteGateway), c.tunnelIp ? "assigned " + addr(c.tunnelIp) : ""].filter(Boolean).join(" · "),
            bytesLine(c.incomingBytes, c.outgoingBytes),
          ]);
      });
    }

    if (data && typeof data.pollIntervalSec === "number") {
      html += '<div class="muted" style="font-size:12px;margin:16px 0 8px;">Tunnels and connected peers are re-read every ' + escapeHtml(formatPollInterval(data.pollIntervalSec)) + '.</div>';
    }
    el.innerHTML = html;

    el.querySelectorAll(".ipsec-toggle").forEach(function (b) {
      b.addEventListener("click", function () {
        var name = b.getAttribute("data-parent");
        opened[name] = !opened[name];
        var on = opened[name];
        b.setAttribute("aria-expanded", String(on));
        b.setAttribute("aria-label", (on ? "Hide" : "Show") + " peers");
        var use = b.querySelector("use");
        if (use) use.setAttribute("href", on ? "#i-chev-down" : "#i-chev-right");
        el.querySelectorAll(".ipsec-peer").forEach(function (r) {
          if (r.getAttribute("data-parent") === name) r.style.display = on ? "" : "none";
        });
      });
    });
  }

  function formatPollInterval(sec) {
    if (sec % 3600 === 0) return (sec / 3600) + " h";
    if (sec % 60 === 0) return (sec / 60) + " min";
    return sec + " s";
  }

  // ─── Dependency Tree ─────────────────────────────────────────────────────
  // "View Dependency Tree" (top of the hero, above SD-WAN) opens the desktop
  // General tab's Dependency Tree as a page: the parents this device hangs
  // off, the device itself (and its HA peer), and the switches / access
  // points below it with theirs. Every other device's name opens it a page
  // forward, so the operator can walk the tree. Read-only: the override and
  // the Dependency Test are desktop-only. Mirrors renderDependencyTreeBlock.
  var DEP_TREE_VIA_LABEL = {
    "switch-port": "last-seen switch port", wireless: "last-seen access point", sighting: "last-seen firewall",
    subnet: "owning firewall (from IPAM)", hypervisor: "hypervisor placement", manual: "operator override",
  };

  function wireDepTreeButton(id) {
    var btn = document.getElementById("asset-deptree-btn");
    if (btn) btn.onclick = function () { goToPage({ kind: "deptree", assetId: id, title: "Dependency Tree" }); };
  }

  function renderDepTreePage(el, p) {
    el.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    var seq = _pageSeq;
    api.assets.getDependencies(p.assetId).then(function (data) {
      if (seq !== _pageSeq || currentPage() !== p) return;
      drawDepTreePage(el, data || {});
      restoreScroll(p);
    }).catch(function (err) {
      if (seq !== _pageSeq || currentPage() !== p) return;
      el.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0 16px;">Couldn’t load the dependency tree: ' + escapeHtml((err && err.message) || "error") + '</div>';
    });
  }

  // A tree node's dot: the Dependency Test outranks the rest, then the
  // asset dot's own order (monitorDotCls). Unmonitored reads unknown.
  function depNodeDotCls(n) {
    if (!n || n.monitored === false) return "unk";
    if (n.dependencyTestUntil && new Date(n.dependencyTestUntil).getTime() > Date.now()) return "dep-down";
    return monitorDotCls(n) || "unk";
  }

  function drawDepTreePage(el, data) {
    var parents = Array.isArray(data.effectiveParents) ? data.effectiveParents : [];
    var children = Array.isArray(data.children) ? data.children : [];
    var self = data.asset || {};
    var haPeer = data.haPeer || null;

    if (!parents.length && !children.length && !haPeer) {
      var isInfra = ["firewall", "switch", "access_point"].indexOf(self.assetType) !== -1;
      el.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0 16px;">'
        + (isInfra
          ? "Standalone — no upstream or downstream switches / access points discovered."
          : "No upstream device identified — no last-seen switch, access point or FortiGate resolves to a monitored device, so dependency suppression can’t apply to this asset.")
        + '</div>';
      return;
    }

    // Rule 91: two nodes sharing a name get their serial (or address) beside it.
    var nameCounts = Object.create(null);
    function countName(n) { if (n && n.hostname) { var k = String(n.hostname).toLowerCase(); nameCounts[k] = (nameCounts[k] || 0) + 1; } }
    parents.forEach(function (x) { countName(x.parent); });
    countName(self); countName(haPeer);
    children.forEach(function (c) { countName(c); (c.grandchildren || []).forEach(countName); });
    function disambig(n) {
      if (!n || !n.hostname || (nameCounts[String(n.hostname).toLowerCase()] || 0) < 2) return "";
      return n.serialNumber || n.ipAddress || "";
    }

    function nodeRow(n, opts) {
      opts = opts || {};
      var name = n.hostname || n.id;
      var head = opts.self ? '<strong>' + escapeHtml(name) + '</strong>' : linkHtml(n.id, name);
      var d = disambig(n);
      if (d) head += ' <span class="muted mono" style="font-size:12px;">' + escapeHtml(d) + '</span>';
      if (n.activeAlert && window.PolarisMobileAlerts) head += ' ' + PolarisMobileAlerts.dotHTML(n.activeAlert);
      var bits = [escapeHtml(String(n.assetType || "asset").replace(/_/g, " "))];
      if (n.dependencyLayer != null) bits.push("level " + escapeHtml(String(n.dependencyLayer)));
      if (opts.via && DEP_TREE_VIA_LABEL[opts.via]) bits.push("via " + escapeHtml(DEP_TREE_VIA_LABEL[opts.via]));
      if (opts.override) bits.push("override");
      if (opts.tag) bits.push(escapeHtml(opts.tag));
      if (opts.more > 0) bits.push("+" + opts.more + " more below");
      return ''
        + '<div class="list-item two-line" style="padding-left:' + (opts.depth ? (opts.depth * 20) + 'px' : '0') + ';padding-right:0;align-items:flex-start;">'
        + '  <span class="leading" style="margin-top:4px;"><span class="dot ' + depNodeDotCls(n) + '"></span></span>'
        + '  <div class="content" style="min-width:0;">'
        + '    <div class="headline">' + head + '</div>'
        + '    <div class="supporting">' + bits.join(" · ") + '</div>'
        + '  </div>'
        + '</div>';
    }
    function heading(text, first) {
      return '<div style="font-weight:500;margin:' + (first ? '8px' : '20px') + ' 0 4px;">' + escapeHtml(text) + '</div>';
    }

    var subtitle;
    if (!parents.length) subtitle = "Level 1 — root of the dependency tree";
    else if (parents.length === 1) subtitle = "Level " + (self.dependencyLayer != null ? self.dependencyLayer : "?") + " · directly under " + (parents[0].parent.hostname || parents[0].parent.id);
    else subtitle = "Level " + (self.dependencyLayer != null ? self.dependencyLayer : "?") + " · " + parents.length + " parents";

    var html = '<div class="muted" style="font-size:13px;margin:4px 0 0;">' + escapeHtml(subtitle) + (data.hasOverride ? " · override active" : "") + '</div>';
    var testUntil = self.dependencyTestUntil ? new Date(self.dependencyTestUntil) : null;
    if (testUntil && testUntil.getTime() > Date.now()) {
      html += '<div class="card-filled" style="padding:10px 12px;margin-top:8px;font-size:13px;"><strong>Dependency Test active</strong>'
        + (self.dependencyTestStartedBy ? " by " + escapeHtml(self.dependencyTestStartedBy) : "")
        + " — children are suppressed as if this device were down. Auto-clears " + escapeHtml(testUntil.toLocaleString()) + ".</div>";
    }

    if (parents.length) {
      html += heading("Upstream");
      parents.forEach(function (x, i) {
        html += (i ? '<div class="list-divider"></div>' : '')
          + nodeRow(x.parent, { via: x.detectedVia, override: x.source === "override" });
      });
    }

    html += heading("This device");
    html += nodeRow(self, { self: true });
    if (haPeer) {
      var peerTag = haPeer.haRole === "secondary" ? "HA standby" : haPeer.haRole === "primary" ? "HA primary (active)" : "HA peer";
      html += '<div class="list-divider"></div>' + nodeRow(haPeer, { tag: peerTag });
    }

    if (children.length) {
      html += heading("Downstream");
      children.forEach(function (c, i) {
        var gcs = Array.isArray(c.grandchildren) ? c.grandchildren : [];
        var more = typeof c.childCount === "number" ? Math.max(0, c.childCount - gcs.length) : 0;
        html += (i ? '<div class="list-divider"></div>' : '')
          + nodeRow(c, { via: c.detectedVia, more: more });
        gcs.forEach(function (gc) { html += nodeRow(gc, { depth: 1, via: gc.detectedVia }); });
      });
      if (data.childrenTruncated) {
        var total = typeof data.childCount === "number" ? data.childCount : 0;
        html += '<div class="muted" style="font-size:12px;margin-top:8px;">Showing ' + children.length + ' of '
          + Math.max(total, children.length) + ' downstream switches / access points.</div>';
      }
    }
    el.innerHTML = html;
  }

  // ─── Storage ─────────────────────────────────────────────────────────────
  // "View Storage" (between Interfaces and Discovery sources) opens the
  // Storage page: the storage stream's volumes for every asset, and on a
  // hypervisor its arrays — an Unraid / TrueNAS / Proxmox host's pools with
  // their device groups and member drives (the desktop System tab's Storage
  // table + Pool devices), a vCenter host's datastores with their type and
  // backing. A volume opens its usage chart, a drive its details — each a
  // page forward. Volumes are as fresh as the last poll; pools and drives as
  // the last discovery run. Physical drives exist only on those platforms:
  // nothing else reports them, so every other device shows volumes alone.

  // The desktop's _STORAGE_PCT_THRESHOLDS — a volume reads the same on both.
  var STORAGE_PCT_WARN = 75, STORAGE_PCT_CRIT = 90;
  var WORKLOAD_PLATFORMS = { unraid: true, truenas: true, proxmox: true };
  var POOL_ROLE = { data: "Data", parity: "Parity", log: "Log", cache: "Cache", spare: "Spare", special: "Special", dedup: "Dedup" };

  function bytesText(n) {
    if (n == null || isNaN(n)) return "—";
    return typeof formatBytes === "function" ? formatBytes(Number(n)) : n + " B";
  }

  function storagePct(used, total) {
    return (total > 0 && used != null) ? Math.max(0, Math.min(100, (used / total) * 100)) : null;
  }

  // The desktop's healthy / failing words (_storageHealthCell): a pool's,
  // a group's, a drive's or a SMART verdict. Unknown words stay neutral.
  function healthClass(h) {
    var s = String(h || "").toUpperCase();
    if (/^(ONLINE|HEALTHY|STARTED|DISK_OK|OK|PASSED)$/.test(s)) return "poe-ok";
    if (/(FAULT|UNAVAIL|REMOVED|OFFLINE|DEGRADED|FAIL|INVALID|DSBL|WRONG|STOPPED)/.test(s)) return "poe-fault";
    return "poe-idle";
  }
  function healthPill(h) {
    return h ? '<span class="poe-label ' + healthClass(h) + '">' + escapeHtml(h) + '</span>' : "";
  }

  // The desktop's _poolMemberUnhealthy, word for word.
  function memberUnhealthy(m) {
    var errs = (m.readErrors || 0) + (m.writeErrors || 0) + (m.checksumErrors || 0) + (m.errors || 0);
    var h = String(m.health || "").toUpperCase();
    return errs > 0 || (h !== "" && !/^(ONLINE|DISK_OK|AVAIL|INUSE)$/.test(h)) ||
      (!!m.smart && !/^(OK|PASSED|UNKNOWN)$/i.test(m.smart));
  }
  function poolUnhealthy(pool) {
    return (pool.health && !/^(ONLINE|STARTED|DISK_OK)$/i.test(pool.health)) ||
      (pool.groups || []).some(function (g) { return (g.members || []).some(memberUnhealthy); });
  }

  // The desktop's _poolScanText.
  function poolScanText(scan) {
    if (!scan) return "";
    var kind = scan.kind === "parity-check" ? "Parity check" : scan.kind === "resilver" ? "Resilver" : scan.kind === "scrub" ? "Scrub" : (scan.kind || "Scan");
    var when = scan.at ? " " + (scan.state === "running" ? "started " : "") + timeAgo(scan.at) : "";
    var state = scan.state === "running"
      ? "running" + (scan.percent != null ? " (" + Number(scan.percent).toFixed(1) + "%)" : "")
      : (scan.state || "—");
    var errs = scan.errors != null ? ", " + scan.errors + " error" + (scan.errors === 1 ? "" : "s") : "";
    return kind + ": " + state + when + errs;
  }

  function hostPools(v) {
    return (v && v.role === "host" && WORKLOAD_PLATFORMS[v.platform] && Array.isArray(v.pools)) ? v.pools : [];
  }

  function usageBarHtml(pct) {
    if (pct == null) return "";
    var tone = pct >= STORAGE_PCT_CRIT ? " crit" : pct >= STORAGE_PCT_WARN ? " warn" : "";
    return '<div class="storage-bar"><div class="storage-bar-fill' + tone + '" style="width:' + pct.toFixed(1) + '%"></div></div>';
  }

  function tempText(c) {
    if (c == null) return null;
    var TU = window.PolarisTempUnit;
    return TU ? (Math.round(TU.convertReading(c, "°C") * 10) / 10) + " " + TU.displayUnit("°C") : c + " °C";
  }

  // The line under the button: "2 arrays · 8 drives · 1 degraded", or the
  // volume count. Painted from the asset row first (its pools ride the
  // virtualization blob), then again once system-info adds the volumes.
  function paintStorageSummary(asset, info) {
    var el = document.getElementById("asset-storage-sub");
    if (!el || !asset) return;
    var pools = hostPools(asset.virtualization);
    var poolNames = {};
    var bits = [], bad = 0, drives = 0;
    pools.forEach(function (pool) {
      poolNames[pool.name] = true;
      (pool.groups || []).forEach(function (g) { drives += (g.members || []).length; });
      if (poolUnhealthy(pool)) bad++;
    });
    if (pools.length) bits.push(pools.length + (pools.length === 1 ? " array" : " arrays"));
    if (drives) bits.push(drives + (drives === 1 ? " drive" : " drives"));
    if (info) {
      var vols = (info.storage || []).filter(function (r) { return !poolNames[r.mountPath]; }).length;
      if (vols) bits.push(vols + (vols === 1 ? " volume" : " volumes"));
    }
    if (bad) bits.push(bad + " degraded");
    el.textContent = bits.join(" · ");
    el.classList.toggle("bad", bad > 0);
  }

  function renderStoragePage(el, p) {
    var id = p.assetId;
    var seq = _pageSeq;
    var asset = p.asset || _assetCache[id] || null;
    var isHost = !!(asset && asset.virtualization && asset.virtualization.role === "host");
    var cachedInfo = !p.refetch && _systemInfoCache[id];
    p.refetch = false;
    el.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    Promise.all([
      cachedInfo ? Promise.resolve(cachedInfo) : api.assets.systemInfo(id),
      isHost && api.assets.virtualization ? api.assets.virtualization(id).catch(function () { return null; }) : Promise.resolve(null),
    ]).then(function (r) {
      if (seq !== _pageSeq) return;
      var info = r[0] || {};
      _systemInfoCache[id] = info;
      p.data = { info: info, virt: r[1] };
      paintStoragePage(el, p);
      restoreScroll(p);
    }).catch(function (err) {
      if (seq !== _pageSeq) return;
      el.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0 16px;">Couldn’t load storage: ' + escapeHtml((err && err.message) || "error") + '</div>';
    });
  }

  function paintStoragePage(el, p) {
    var info = p.data.info || {}, virt = p.data.virt;
    var asset = p.asset || _assetCache[p.assetId] || {};
    var v = (virt && virt.virtualization) || asset.virtualization || {};
    var pools = hostPools(v);
    var poolNames = {};
    pools.forEach(function (pool) { poolNames[pool.name] = true; });
    var dsByName = {};
    ((virt && virt.datastores) || []).forEach(function (d) { if (d && d.name) dsByName[d.name] = d; });
    var rows = (info.storage || []);
    var rowByName = {};
    rows.forEach(function (r) { rowByName[r.mountPath] = r; });
    var volumes = rows.filter(function (r) { return !poolNames[r.mountPath]; });
    var pinned = {};
    (info.monitoredStorage || asset.monitoredStorage || []).forEach(function (m) { pinned[m] = true; });
    if (!p.open) p.open = {};

    var html = "";
    if (pools.length) {
      html += '<div class="section-head storage-head">Arrays <span class="count">' + pools.length + '</span></div>';
      html += pools.map(function (pool, pi) {
        var bad = poolUnhealthy(pool);
        var openNow = p.open[pool.name] != null ? p.open[pool.name] : bad;
        var row = rowByName[pool.name];
        var used = pool.usedBytes != null ? pool.usedBytes : row && row.usedBytes;
        var total = pool.totalBytes != null ? pool.totalBytes : row && row.totalBytes;
        var pct = storagePct(used, total);
        var fs = pool.filesystem ? String(pool.filesystem).replace(/^unraid-array/, "Unraid array") : (pool.kind || "");
        var groups = pool.groups || [];
        var driveCount = groups.reduce(function (s, g) { return s + (g.members || []).length; }, 0);
        var meta = [fs];
        if (!openNow && driveCount) meta.push(driveCount + (driveCount === 1 ? " drive" : " drives"));
        var body = "";
        if (openNow) {
          body += groups.map(function (g, gi) {
            var gLabel = (POOL_ROLE[g.role] || g.role || "") + (g.layout ? " · " + g.layout : "");
            return '<div class="pool-group-head">' + escapeHtml(gLabel)
              + (g.name ? ' <span class="mono">' + escapeHtml(g.name) + '</span>' : '')
              + ((g.members || []).length > 1 ? ' ' + healthPill(g.health) : '') + '</div>'
              + (g.members || []).map(function (m, mi) {
                var sub = [m.sizeBytes != null ? bytesText(m.sizeBytes) : null, tempText(m.temperatureC)];
                var errs = (m.readErrors || 0) + (m.writeErrors || 0) + (m.checksumErrors || 0) + (m.errors || 0);
                if (errs > 0) {
                  sub.push(m.readErrors != null || m.writeErrors != null || m.checksumErrors != null
                    ? "errors " + [m.readErrors, m.writeErrors, m.checksumErrors].map(function (x) { return x == null ? "—" : x; }).join("/")
                    : "errors " + m.errors);
                }
                return '<button type="button" class="pool-drive' + (memberUnhealthy(m) ? " bad" : "") + '" data-drive="' + pi + ':' + gi + ':' + mi + '">'
                  + '  <span class="pool-drive-main">'
                  + '    <span class="pool-drive-name"><span class="mono">' + escapeHtml(m.name) + '</span>'
                  +        (m.mediaType ? ' <span class="poe-label poe-idle">' + escapeHtml(m.mediaType) + '</span>' : '') + '</span>'
                  + '    <span class="pool-drive-sub">' + escapeHtml(sub.filter(Boolean).join(" · ")) + '</span>'
                  + '  </span>'
                  + (m.health ? healthPill(m.health) : '')
                  + '  <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#i-chev-right"/></svg>'
                  + '</button>';
              }).join("");
          }).join("");
        }
        return '<div class="card-filled pool-card">'
          + '<button type="button" class="pool-head" data-pool="' + escapeHtml(pool.name) + '" aria-expanded="' + (openNow ? "true" : "false") + '">'
          + '  <span class="mono pool-name">' + escapeHtml(pool.name) + '</span>'
          +    healthPill(pool.health)
          + '  <span class="pool-meta">' + escapeHtml(meta.filter(Boolean).join(" · ")) + '</span>'
          + '  <svg viewBox="0 0 24 24" aria-hidden="true"><use href="#' + (openNow ? "i-chev-down" : "i-chev-right") + '"/></svg>'
          + '</button>'
          + usageBarHtml(pct)
          + (pct != null ? '<div class="storage-line">' + escapeHtml(bytesText(used) + " used of " + bytesText(total) + " · " + Math.round(pct) + "%") + '</div>' : '')
          + (pool.healthDetail ? '<div class="storage-line warn">' + escapeHtml(pool.healthDetail) + '</div>' : '')
          + (pool.scan ? '<div class="storage-line">' + escapeHtml(poolScanText(pool.scan)) + '</div>' : '')
          + body
          + '</div>';
      }).join("");
    }

    if (volumes.length) {
      html += '<div class="section-head storage-head">Volumes <span class="count">' + volumes.length + '</span></div>';
      html += volumes.map(function (r, i) {
        var pct = storagePct(r.usedBytes, r.totalBytes);
        var free = (r.totalBytes != null && r.usedBytes != null) ? r.totalBytes - r.usedBytes : null;
        var ds = dsByName[r.mountPath];
        var extra = ds ? [ds.dsType, ds.backingLabel].filter(Boolean).join(" · ") : "";
        var tone = pct == null ? "" : pct >= STORAGE_PCT_CRIT ? " crit" : pct >= STORAGE_PCT_WARN ? " warn" : "";
        return '<button type="button" class="storage-vol" data-vol="' + i + '">'
          + '  <span class="storage-vol-top">'
          + '    <span class="mono storage-vol-name">' + escapeHtml(r.mountPath) + '</span>'
          +      (pinned[r.mountPath] ? '<span class="poe-label poe-idle">Poll 1m</span>' : '')
          +      (ds && ds.accessible === false ? '<span class="poe-label poe-fault">Inaccessible</span>' : '')
          +      (pct != null ? '<span class="storage-pct' + tone + '">' + Math.round(pct) + '%</span>' : '')
          + '  </span>'
          +    usageBarHtml(pct)
          + '  <span class="storage-line">' + escapeHtml(
                (r.usedBytes != null ? bytesText(r.usedBytes) + " used of " + bytesText(r.totalBytes) : "Size " + bytesText(r.totalBytes))
                + (free != null ? " · " + bytesText(free) + " free" : "")
                + (extra ? " · " + extra : "")) + '</span>'
          + '</button>';
      }).join("");
    }

    if (!pools.length && !volumes.length) {
      html += '<div class="empty-state" style="padding:24px 0;">'
        + '<div class="icon"><svg viewBox="0 0 24 24"><use href="#i-storage"/></svg></div>'
        + '<div class="ttl">No storage reported</div>'
        + '<div class="desc">Volumes come from this device’s Storage stream. Check its polling method under Monitoring in the edit menu (tap the asset’s name).</div></div>';
    } else if (!pools.length) {
      html += '<div class="storage-note">Tap a volume for its usage over time. Physical drives are reported only by Unraid, TrueNAS and Proxmox hosts; this device reports its mounted volumes.</div>';
    } else {
      html += '<div class="storage-note">Arrays and drives are as of the last discovery run; volumes as of the last poll. Tap a drive for its details.</div>';
    }
    el.innerHTML = html;

    el.querySelectorAll(".pool-head").forEach(function (b) {
      b.addEventListener("click", function () {
        var name = b.getAttribute("data-pool");
        var bad = pools.some(function (x) { return x.name === name && poolUnhealthy(x); });
        var was = p.open[name] != null ? p.open[name] : bad;
        p.open[name] = !was;
        paintStoragePage(el, p);
      });
    });
    el.querySelectorAll(".pool-drive").forEach(function (b) {
      b.addEventListener("click", function () {
        var ix = b.getAttribute("data-drive").split(":").map(Number);
        var pool = pools[ix[0]], g = pool && pool.groups[ix[1]], m = g && g.members[ix[2]];
        if (!m) return;
        goToPage({
          kind: "drive", assetId: p.assetId, title: m.name,
          sub: [pool.name, g.name || (POOL_ROLE[g.role] || g.role)].filter(Boolean).join(" · "),
          member: m,
        });
      });
    });
    el.querySelectorAll(".storage-vol").forEach(function (b) {
      b.addEventListener("click", function () {
        var r = volumes[Number(b.getAttribute("data-vol"))];
        if (!r) return;
        goToPage({ kind: "volume", assetId: p.assetId, title: r.mountPath, row: r, pinned: !!pinned[r.mountPath], ds: dsByName[r.mountPath] || null });
      });
    });
  }

  function kvRowsHtml(rows) {
    return rows.filter(function (r) { return r && r.v != null && r.v !== ""; }).map(function (r) {
      return '<div class="kv-row"><span class="k">' + escapeHtml(r.k) + '</span>'
        + '<span class="v' + (r.mono ? " mono" : "") + (r.cls ? " " + r.cls : "") + '">' + (r.html ? r.v : escapeHtml(r.v)) + '</span></div>';
    }).join("");
  }

  // A volume: its figures, then used % over a range (the desktop storage
  // panel's chart, phone-sized).
  function renderVolumePage(el, p) {
    var r = p.row || {};
    var ds = p.ds;
    var pct = storagePct(r.usedBytes, r.totalBytes);
    var free = (r.totalBytes != null && r.usedBytes != null) ? r.totalBytes - r.usedBytes : null;
    el.innerHTML = kvRowsHtml([
      { k: "Used", v: r.usedBytes != null ? bytesText(r.usedBytes) + (pct != null ? " (" + Math.round(pct) + "%)" : "") : null },
      { k: "Total", v: r.totalBytes != null ? bytesText(r.totalBytes) : null },
      { k: "Free", v: free != null ? bytesText(free) : null },
      { k: "Type", v: ds && ds.dsType },
      { k: "Backing", v: ds && ds.backingLabel },
      { k: "Provisioned", v: ds && ds.provisionedBytes != null ? bytesText(Number(ds.provisionedBytes)) : null },
      { k: "Polled every minute", v: p.pinned ? "Yes" : "No" },
    ])
      + '<div style="font-weight:500;margin:16px 0 8px;">Usage</div>'
      + rangeSegHtml("vol-range-seg", CHART_RANGES, p.range || "24h")
      + '<div id="vol-chart" style="min-height:120px;"></div>'
      + '<div class="muted" id="vol-chart-sub" style="font-size:12px;margin-top:4px;"></div>';
    wireRangeSeg("vol-range-seg", function (range) { p.range = range; loadVolumeChart(p, range); });
    loadVolumeChart(p, p.range || "24h");
  }

  function loadVolumeChart(p, range) {
    var chartEl = document.getElementById("vol-chart");
    var sub = document.getElementById("vol-chart-sub");
    if (!chartEl || !api.assets.storageHistory) return;
    var seq = _pageSeq;
    chartEl.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    if (sub) sub.textContent = "";
    var current = function () { return seq === _pageSeq && (p.range || "24h") === range && document.getElementById("vol-chart") === chartEl; };
    Promise.all([api.assets.storageHistory(p.assetId, p.row.mountPath, { range: range }), maintWindowsFor(p.assetId)]).then(function (got) {
      if (!current()) return;
      var data = got[0] || {}, maint = got[1];
      var t0 = data.since != null ? +new Date(data.since) : NaN;
      var pts = [], max = null, last = null;
      (data.samples || []).forEach(function (s) {
        var v = storagePct(s.usedBytes, s.totalBytes);
        if (v == null) return;
        pts.push({ ts: s.timestamp, v: v });
        if (!(+new Date(s.timestamp) < t0)) { last = v; if (max == null || v > max) max = v; }
      });
      if (!pts.length) {
        chartEl.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">' + escapeHtml(emptyStatsLabel(maint, range)) + '</div>';
        return;
      }
      var bounds = rangeBounds(range);
      chartEl.innerHTML = PolarisCharts.lineChart({
        series: [{ values: pts, color: "var(--md-primary)", gapFade: true }],
        yMin: 0, yMax: 100, yUnit: "%",
        maintenance: maint, from: bounds && bounds.from, to: bounds && bounds.to, outages: data.outages, height: 120,
        ariaLabel: p.row.mountPath + " used over " + range,
      });
      if (sub && last != null) sub.textContent = "now " + Math.round(last) + "% · peak " + Math.round(max) + "%";
    }).catch(function (err) {
      if (!current()) return;
      chartEl.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load usage: ' + escapeHtml((err && err.message) || "error") + '</div>';
    });
  }

  // A drive of an array, as the last discovery run saw it. Rows the
  // platform does not report are left out (no SMART on Proxmox, one error
  // total on Unraid).
  function renderDrivePage(el, p) {
    var m = p.member || {};
    var split = m.readErrors != null || m.writeErrors != null || m.checksumErrors != null;
    var errCls = function (n) { return n > 0 ? "bad" : ""; };
    el.innerHTML = kvRowsHtml([
      { k: "Health", v: m.health ? healthPill(m.health) : null, html: true },
      { k: "Model", v: m.model },
      { k: "Serial", v: m.serial, mono: true },
      { k: "Device", v: m.device && m.device !== m.name ? m.device : null, mono: true },
      { k: "Media", v: m.mediaType },
      { k: "Size", v: m.sizeBytes != null ? bytesText(m.sizeBytes) : null },
      { k: "Temperature", v: tempText(m.temperatureC) },
      { k: "Filesystem", v: m.filesystem },
      { k: "SMART", v: m.smart ? healthPill(m.smart) : null, html: true },
      split ? { k: "Read errors", v: m.readErrors != null ? String(m.readErrors) : null, cls: errCls(m.readErrors) } : null,
      split ? { k: "Write errors", v: m.writeErrors != null ? String(m.writeErrors) : null, cls: errCls(m.writeErrors) } : null,
      split ? { k: "Checksum errors", v: m.checksumErrors != null ? String(m.checksumErrors) : null, cls: errCls(m.checksumErrors) } : null,
      !split ? { k: "Errors", v: m.errors != null ? String(m.errors) : null, cls: errCls(m.errors) } : null,
    ])
      + '<div class="storage-note">As of the last discovery run.</div>';
  }

  // ─── Alerts ──────────────────────────────────────────────────────────────
  // The hero's alert flag — the same strobing "Alerts" control the Assets list
  // card carries, for the same reason, on the screen an operator lands on
  // after tapping that card. Tapping it opens the Alerts page of this sheet
  // (acknowledge / clear, per role).
  //
  // Its own fetch rather than a field on the asset row: `activeAlert` is
  // enriched onto the LIST payload only, and the detail sheet can be opened
  // from places that never went through the list (a search hit, a push deep
  // link, a pasted #asset/<id> URL). One small request, alongside the six this
  // sheet already fires in parallel.
  function loadAlerts(id, asset) {
    if (!window.PolarisMobileAlerts) return;
    api.assets.alerts(id).then(function (data) {
      if (_openId !== id) return;   // sheet moved on while we were fetching
      paintAlertFlag(id, PolarisMobileAlerts.summarize((data && data.active) || []), asset);
    }).catch(function () {
      // A device with no readable alerts simply carries no flag — this is an
      // ornament on a sheet full of real content, not something to error over.
    });
  }

  function paintAlertFlag(id, summary, asset) {
    var host = document.getElementById("asset-hero-alerts");
    if (!host) return;
    host.innerHTML = PolarisMobileAlerts.flagHTML(summary);
    var btn = host.querySelector(".alert-flag");
    if (!btn) return;
    btn.addEventListener("click", function () {
      goToPage({ kind: "alerts", assetId: id, title: "Alerts" });
    });
  }

  // The alerts list as a page of this sheet (PAGE_KINDS.alerts) — the same
  // list, acknowledge and clear as the standalone sheet the Assets list opens
  // (PolarisMobileAlerts.renderInto). Going back re-reads the asset, so the
  // hero's flag picks up whatever was acknowledged or cleared here.
  function renderAlertsPage(el, p) {
    if (!window.PolarisMobileAlerts || !PolarisMobileAlerts.renderInto) {
      el.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0 16px;">Alerts are unavailable.</div>';
      return;
    }
    PolarisMobileAlerts.renderInto(el, p.assetId);
  }

  // ─── SD-WAN ──────────────────────────────────────────────────────────────
  // Gate: SD-WAN sample streams only exist for monitored FortiGate firewalls
  // with the per-integration `pullSdwan` toggle on. We gate cheaply on
  // assetType + monitored (a non-FortiGate firewall simply returns empty
  // streams), fetch the three current-state endpoints, and reveal the hero
  // button only when the device actually reported data — mirroring the
  // prefetch-then-conditional pattern of the desktop SD-WAN tab.
  function loadSdwanGate(id, st, asset) {
    if (!asset || !asset.monitored || asset.assetType !== "firewall") return;
    // Only FortiManager / standalone-FortiGate firewalls can carry SD-WAN
    // sample streams — skip the gate fetch for any other discovery source
    // (mirrors the desktop SD-WAN tab's type check).
    var srcType = (asset.discoveredByIntegration && asset.discoveredByIntegration.type) || "manual";
    if (srcType !== "fortimanager" && srcType !== "fortigate") return;
    Promise.all([
      api.assets.sdwanMembers(id).catch(function () { return { members: [] }; }),
      api.assets.sdwanRules(id).catch(function () { return { rules: [] }; }),
      api.assets.perfSlaLinks(id).catch(function () { return { links: [] }; }),
    ]).then(function (r) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      var members = (r[0] && r[0].members) || [];
      var rules   = (r[1] && r[1].rules) || [];
      var links   = (r[2] && r[2].links) || [];
      if (!members.length && !rules.length && !links.length) return;
      _sdwanCache[id] = { members: members, rules: rules, links: links };
      var wrap = document.getElementById("asset-sdwan-btn-wrap");
      var btn  = document.getElementById("asset-sdwan-btn");
      if (wrap) wrap.style.display = "";
      if (btn) btn.onclick = function () { goToPage({ kind: "sdwan", assetId: id, title: "SD-WAN" }); };
    }).catch(function () { /* gate is best-effort — no button on failure */ });
  }

  // Holds the open SD-WAN page's perf-SLA selection (health-check grouping +
  // active range) so the range segmented control can reload the charts.
  var _sdwanSheetState = null;

  // ─── SD-WAN page ───────────────────────────────────────────────────────
  // A page of the asset sheet (PAGE_KINDS.sdwan). Sections: Members + Rules
  // current-state lists, then a Performance SLA section with per-member
  // latency / jitter / packet-loss charts for a selectable health-check +
  // range.
  function renderSdwanPage(el, assetId) {
    _sdwanSheetState = null;
    var cache = _sdwanCache[assetId];
    if (!cache) { el.innerHTML = '<div class="muted" style="font-size:13px;padding:8px 0 16px;">No SD-WAN data for this device.</div>'; return; }
    var members = cache.members || [];
    var rules   = cache.rules || [];
    var links   = cache.links || [];

    // Group perf-SLA links by health-check — selecting a health-check overlays
    // every member belonging to it on the charts (matches the desktop tab).
    var linksByHc = {};
    var hcNames = [];
    links.forEach(function (l) {
      if (!linksByHc[l.healthCheck]) { linksByHc[l.healthCheck] = []; hcNames.push(l.healthCheck); }
      linksByHc[l.healthCheck].push(l);
    });
    _sdwanSheetState = {
      assetId: assetId,
      linksByHc: linksByHc,
      hcNames: hcNames,
      hcName: hcNames[0] || null,
      range: "24h",
    };

    var sections = "";

    if (members.length) {
      sections += ''
        + '<div style="font-weight:500;margin:8px 0 4px;">Members</div>'
        + renderSdwanMembersList(members);
    }

    if (rules.length) {
      sections += ''
        + '<div style="font-weight:500;margin:20px 0 4px;">Rules</div>'
        + '<div class="muted" style="font-size:12px;margin-bottom:4px;">The selected member is inferred from health-check state when FortiOS doesn’t report the active route directly.</div>'
        + renderSdwanRulesList(rules);
    }

    if (hcNames.length) {
      var rangeButtons = ["1h", "12h", "24h", "7d", "30d"].map(function (rr) {
        return '<button class="seg-item' + (rr === _sdwanSheetState.range ? " on" : "") + '" data-range="' + rr + '">' + rr + '</button>';
      }).join("");
      var hcOptions = hcNames.map(function (hc) {
        var n = (linksByHc[hc] || []).length;
        return '<option value="' + escapeHtml(hc) + '">' + escapeHtml(hc) + ' (' + n + ' member' + (n === 1 ? '' : 's') + ')</option>';
      }).join("");
      sections += ''
        + '<div style="font-weight:500;margin:20px 0 8px;">Performance SLA</div>'
        + '<select id="sdwan-hc-select" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--md-outline);background:var(--md-surface-cont-high);color:var(--md-on-surface);font-size:14px;margin-bottom:8px;">' + hcOptions + '</select>'
        + '<div class="seg" id="sdwan-range-seg" style="display:inline-flex;border:1px solid var(--md-outline);border-radius:var(--shape-full);overflow:hidden;margin-bottom:8px;">' + rangeButtons + '</div>'
        + '<div id="sdwan-perfsla-legend" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;"></div>'
        + '<div id="sdwan-perfsla-stats" class="muted" style="font-size:12px;margin-bottom:8px;">Loading…</div>'
        + '<div class="card-filled" style="padding:12px;margin-bottom:8px;"><div style="font-size:13px;margin-bottom:4px;">Latency (ms)</div><div id="sdwan-lat-chart" style="min-height:120px;"></div></div>'
        + '<div class="card-filled" style="padding:12px;margin-bottom:8px;"><div style="font-size:13px;margin-bottom:4px;">Jitter (ms)</div><div id="sdwan-jit-chart" style="min-height:120px;"></div></div>'
        + '<div class="card-filled" style="padding:12px;margin-bottom:8px;"><div style="font-size:13px;margin-bottom:4px;">Packet loss (%)</div><div id="sdwan-loss-chart" style="min-height:120px;"></div></div>';
    }

    el.innerHTML = sections;

    // Wire the perf-SLA controls + initial load.
    if (hcNames.length) {
      var sel = document.getElementById("sdwan-hc-select");
      if (sel) sel.addEventListener("change", function () {
        _sdwanSheetState.hcName = sel.value;
        loadSdwanPerfSla(assetId, _sdwanSheetState.hcName, _sdwanSheetState.range);
      });
      var seg = document.getElementById("sdwan-range-seg");
      if (seg) seg.querySelectorAll(".seg-item").forEach(function (b) {
        b.addEventListener("click", function () {
          if (b.dataset.range === _sdwanSheetState.range) return;
          _sdwanSheetState.range = b.dataset.range;
          seg.querySelectorAll(".seg-item").forEach(function (x) {
            x.classList.toggle("on", x.dataset.range === _sdwanSheetState.range);
          });
          loadSdwanPerfSla(assetId, _sdwanSheetState.hcName, _sdwanSheetState.range);
        });
      });
      loadSdwanPerfSla(assetId, _sdwanSheetState.hcName, _sdwanSheetState.range);
    }
  }

  // Members list — status dot + member name (+ zone), IP / link / speed, and
  // per-health-check chips with current latency.
  function renderSdwanMembersList(members) {
    return members.map(function (m, i) {
      var up = m.state === "up";
      var sub = [];
      if (m.ip) sub.push('<span class="mono">' + escapeHtml(m.ip) + '</span>');
      if (m.zone) sub.push(escapeHtml(m.zone));
      // An overlay (linkSource "ipsec") reads its IPsec tunnel status, never an
      // interface carrier. `linkState` is absent on an older server.
      var ls = m.linkState !== undefined ? m.linkState
        : (m.linkUp == null ? null : (m.linkUp ? "up" : "down"));
      var tun = m.linkSource === "ipsec";
      if (ls === "up") sub.push(tun ? "tunnel up" : ("link up" + (m.linkSpeedBps ? " · " + escapeHtml(formatBps(m.linkSpeedBps)) : "")));
      else if (ls === "down") sub.push(tun ? "tunnel down" : "link down");
      else if (ls === "partial") sub.push("tunnel partial");
      else if (ls === "dynamic") sub.push("dial-up");
      var hcChips = (m.healthChecks || []).map(function (h) {
        var c = h.state === "up" ? "var(--md-success)" : "var(--md-error)";
        var lat = (typeof h.latencyMs === "number") ? (Math.round(h.latencyMs * 100) / 100) + "ms" : "—";
        return '<span style="display:inline-block;margin:2px 4px 0 0;padding:1px 7px;border-radius:10px;font-size:11px;background:var(--md-surface-cont-highest);color:var(--md-on-surface-variant);">'
          + '<span style="color:' + c + '">●</span> ' + escapeHtml(h.healthCheck) + ' ' + escapeHtml(lat) + '</span>';
      }).join("");
      return ''
        + '<div class="list-item two-line" style="padding-left:0;padding-right:0;align-items:flex-start;">'
        + '  <span class="leading" style="margin-top:2px;"><span class="dot ' + (up ? "up" : "down") + '" style="display:inline-block;width:10px;height:10px;border-radius:50%;"></span></span>'
        + '  <div class="content">'
        + '    <div class="headline">' + escapeHtml(m.link || "(member)") + '</div>'
        + (sub.length ? '    <div class="supporting">' + sub.join(" · ") + '</div>' : '')
        + (hcChips ? '    <div style="margin-top:2px;">' + hcChips + '</div>' : '')
        + '  </div>'
        + '</div>'
        + (i < members.length - 1 ? '<div class="list-divider"></div>' : '');
    }).join("");
  }

  // Rules list — rule name + id, destination / criteria, member pills with the
  // selected member highlighted, and enabled state.
  function renderSdwanRulesList(rules) {
    return rules.map(function (r, i) {
      var avail = Array.isArray(r.availableMembers) ? r.availableMembers : [];
      var pills = avail.length
        ? avail.map(function (m) {
            var seld = m === r.selectedMember;
            return '<span style="display:inline-block;margin:2px 4px 0 0;padding:1px 8px;border-radius:10px;font-size:12px;'
              + (seld
                  ? 'background:' + sdwanColor(m, avail) + ';color:#fff;font-weight:600'
                  : 'background:var(--md-surface-cont-highest);color:var(--md-on-surface-variant)')
              + '">' + escapeHtml(m) + (seld ? ' ✓' : '') + '</span>';
          }).join("")
        : '<span class="muted">—</span>';
      var sub = [];
      if (r.dst && r.dst.length) sub.push(escapeHtml(r.dst.join(", ")));
      if (r.criteria) sub.push(escapeHtml(r.criteria));
      var enabled = r.enabled == null
        ? ''
        : (r.enabled
            ? '<span style="color:var(--md-success);">● Enabled</span>'
            : '<span class="muted">○ Disabled</span>');
      return ''
        + '<div style="padding:8px 0;">'
        + '  <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;">'
        + '    <div style="font-weight:600;min-width:0;">' + escapeHtml(r.ruleName || "(rule)") + (r.ruleId != null ? ' <span class="muted" style="font-weight:400;font-size:12px;">#' + escapeHtml(String(r.ruleId)) + '</span>' : '') + '</div>'
        + '    <div style="font-size:12px;white-space:nowrap;">' + enabled + '</div>'
        + '  </div>'
        + (sub.length ? '  <div class="supporting" style="margin-top:2px;">' + sub.join(" · ") + '</div>' : '')
        + '  <div style="margin-top:4px;">' + pills + '</div>'
        + '</div>'
        + (i < rules.length - 1 ? '<div class="list-divider"></div>' : '');
    }).join("");
  }

  // Load every member of the selected health-check in parallel and overlay
  // them (one colored line per member) on the latency / jitter / loss charts.
  function loadSdwanPerfSla(assetId, hcName, range) {
    var latEl    = document.getElementById("sdwan-lat-chart");
    var jitEl    = document.getElementById("sdwan-jit-chart");
    var lossEl   = document.getElementById("sdwan-loss-chart");
    var statsEl  = document.getElementById("sdwan-perfsla-stats");
    var legendEl = document.getElementById("sdwan-perfsla-legend");
    if (!latEl || !_sdwanSheetState || !hcName) return;
    var members = _sdwanSheetState.linksByHc[hcName] || [];
    var memberNames = members.map(function (m) { return m.link; });
    var spinner = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    latEl.innerHTML = jitEl.innerHTML = lossEl.innerHTML = spinner;
    if (statsEl) statsEl.textContent = "Loading…";
    if (legendEl) legendEl.innerHTML = "";

    // The windows ride as their own promise rather than a slot in the
    // members array, so they can never shift a member's index.
    var maint = [];
    var maintP = maintWindowsFor(assetId).then(function (w) { maint = w; });
    Promise.all(members.map(function (m) {
      return api.assets.perfSlaHistory(assetId, m.healthCheck, m.link, { range: range })
        .then(function (data) { return { link: m.link, samples: (data && data.samples) || [], since: data && data.since }; })
        .catch(function () { return { link: m.link, samples: [] }; });
    })).then(function (results) { return maintP.then(function () { return results; }); }).then(function (results) {
      // Bail if the operator switched health-check/range or closed the sheet
      // while this fetch was in flight.
      if (!_sdwanSheetState || _sdwanSheetState.hcName !== hcName || _sdwanSheetState.range !== range) return;

      function chartFor(host, key, unit, yMax) {
        var series = results.map(function (r) {
          return {
            color: sdwanColor(r.link, memberNames),
            values: r.samples
              .filter(function (s) { return s[key] != null; })
              .map(function (s) { return { ts: s.timestamp, v: s[key] }; }),
          };
        });
        var bounds = rangeBounds(range);
        host.innerHTML = PolarisCharts.lineChart({
          series: series,
          maintenance: maint,
          from: bounds && bounds.from,
          to: bounds && bounds.to,
          height: 120,
          yMin: 0,
          yMax: yMax,
          yUnit: unit,
          ariaLabel: hcName + " " + key + " over " + range,
        });
      }
      chartFor(latEl,  "latencyMs",  "ms", undefined);
      chartFor(jitEl,  "jitterMs",   "ms", undefined);
      chartFor(lossEl, "packetLoss", "%",  100);

      // Legend — one colored chip per member.
      if (legendEl) {
        legendEl.innerHTML = memberNames.map(function (name) {
          return '<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;">'
            + '<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:' + sdwanColor(name, memberNames) + ';"></span>'
            + escapeHtml(name) + '</span>';
        }).join("");
      }

      // Stats line — member count, cross-member averages, and the SLA
      // thresholds (shared across the members of a health-check).
      if (statsEl) {
        var visible = results.map(function (r) { return inWindow(r.samples, r.since); });
        var total = visible.reduce(function (n, v) { return n + v.length; }, 0);
        if (!total) {
          statsEl.textContent = "No samples in this window.";
        } else {
          function avg(key) {
            var vals = [];
            visible.forEach(function (v) { v.forEach(function (s) { if (typeof s[key] === "number") vals.push(s[key]); }); });
            if (!vals.length) return null;
            return vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
          }
          function fmt(v, unit) { return v == null ? "—" : (Math.round(v * 100) / 100) + unit; }
          var bits = [members.length + " member" + (members.length === 1 ? "" : "s")];
          bits.push("avg lat " + fmt(avg("latencyMs"), "ms"));
          bits.push("jitter " + fmt(avg("jitterMs"), "ms"));
          bits.push("loss " + fmt(avg("packetLoss"), "%"));
          var thr = members[0] || {};
          var thrBits = [];
          if (thr.latencyThresholdMs != null)  thrBits.push("lat ≤ " + thr.latencyThresholdMs + "ms");
          if (thr.jitterThresholdMs != null)   thrBits.push("jitter ≤ " + thr.jitterThresholdMs + "ms");
          if (thr.packetLossThreshold != null) thrBits.push("loss ≤ " + thr.packetLossThreshold + "%");
          statsEl.innerHTML = escapeHtml(bits.join(" · ")) + (thrBits.length ? '<br><span style="opacity:.8;">SLA: ' + escapeHtml(thrBits.join(" · ")) + '</span>' : '');
        }
      }
    }).catch(function (err) {
      if (!_sdwanSheetState) return;
      var msg = (err && err.message) ? err.message : "error";
      if (latEl)  latEl.innerHTML  = '<div class="muted" style="font-size:13px;padding:8px 0;">Couldn’t load perf-SLA: ' + escapeHtml(msg) + '</div>';
      if (jitEl)  jitEl.innerHTML  = '';
      if (lossEl) lossEl.innerHTML = '';
      if (statsEl) statsEl.textContent = "—";
    });
  }

  // ─── Current-state tables (ARP / MAC / Wireless) ───────────────────────
  // One button per device class, mirroring which assets get the desktop's
  // ARP Table / MAC Table / Wireless tabs: every firewall, every switch, and
  // monitored access points. All three endpoints sit behind assets:read — the
  // gate the asset sheet itself already needed — so no permission check here.
  var TABLE_BUTTONS = [
    { key: "arp",      label: "View ARP Table", title: "ARP Table", icon: "i-list",        applies: function (a) { return a.assetType === "firewall"; } },
    { key: "mac",      label: "View MAC Table", title: "MAC Table", icon: "i-switch-icon", applies: function (a) { return a.assetType === "switch"; } },
    { key: "wireless", label: "View Wireless",  title: "Wireless",  icon: "i-wifi",        applies: function (a) { return a.assetType === "access_point" && !!a.monitored; } },
  ];

  function tableButtonsHtml(asset) {
    return TABLE_BUTTONS.filter(function (b) { return b.applies(asset); }).map(function (b) {
      return ''
        + '  <div style="margin-top:12px;">'
        + '    <button class="btn btn-tonal btn-block" id="asset-' + b.key + '-btn"><svg viewBox="0 0 24 24"><use href="#' + b.icon + '"/></svg>' + escapeHtml(b.label) + '</button>'
        + '  </div>';
    }).join("");
  }

  function wireTableButtons(id) {
    TABLE_BUTTONS.forEach(function (b) {
      var btn = document.getElementById("asset-" + b.key + "-btn");
      if (btn) btn.onclick = function () { goToPage({ kind: b.key, assetId: id, title: b.title }); };
    });
  }

  // The open table page: which asset + which table, and a token bumped on
  // every (re)load so a late response for a closed or re-ranged sheet bails.
  var _tableSheet = null;

  // Shared shell of the three table pages (PAGE_KINDS.arp / mac / wireless):
  // a controls slot, a freshness/count line and the body the loader renders
  // into. The title is the header's; Reload is the header's Refresh.
  function renderTablePage(el, key, assetId) {
    _tableSheet = { key: key, assetId: assetId, token: 0 };
    el.innerHTML = ''
      + '<div id="table-sheet-controls"></div>'
      + '<div id="table-sheet-meta" class="muted" style="font-size:12px;margin-bottom:8px;"></div>'
      + '<div id="table-sheet-body"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>';

    // One delegated listener for the whole page: group headers expand and
    // collapse in place. A matched device's link is the document-level
    // asset-link listener's (onAssetLinkClick), which opens it a page forward.
    el.addEventListener("click", function (e) {
      var head = e.target.closest(".tbl-group-head");
      if (head) {
        var grp = head.parentNode;
        var body = grp.querySelector(".tbl-group-body");
        var isOpen = !body.hidden;
        body.hidden = isOpen;
        var use = head.querySelector("use");
        if (use) use.setAttribute("href", isOpen ? "#i-chev-right" : "#i-chev-down");
      }
    });
  }

  // Start a load: returns a guard that says whether the response still
  // belongs on screen, and paints the spinner.
  function beginTableLoad(key, assetId) {
    if (!_tableSheet || _tableSheet.key !== key || _tableSheet.assetId !== assetId) return null;
    var token = ++_tableSheet.token;
    var body = document.getElementById("table-sheet-body");
    if (body) body.innerHTML = '<div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div>';
    return function current() {
      return !!_tableSheet && _tableSheet.key === key && _tableSheet.assetId === assetId && _tableSheet.token === token;
    };
  }

  function tableMsg(text) {
    return '<div class="muted" style="font-size:13px;padding:8px 0 16px;">' + text + '</div>';
  }

  // The matched-device cell shared by all three tables.
  function matchedDeviceHtml(m) {
    if (!m || !m.id) return "";
    return linkHtml(m.id, m.hostname || m.ipAddress || m.id);
  }

  // A collapsible group: tappable header (chevron + mono key + summary),
  // body of list rows.
  function tableGroupHtml(key, summary, rowsHtml, expanded) {
    return ''
      + '<div class="tbl-group">'
      + '  <div class="tbl-group-head" role="button" style="display:flex;align-items:center;gap:6px;padding:10px 0;cursor:pointer;border-top:1px solid var(--md-outline-variant, var(--md-outline));">'
      + '    <svg viewBox="0 0 24 24" style="width:18px;height:18px;flex:none;fill:currentColor;"><use href="#' + (expanded ? "i-chev-down" : "i-chev-right") + '"/></svg>'
      + '    <span class="mono" style="font-weight:600;">' + escapeHtml(key) + '</span>'
      + '    <span class="muted" style="font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + summary + '</span>'
      + '  </div>'
      + '  <div class="tbl-group-body"' + (expanded ? '' : ' hidden') + '>' + rowsHtml + '</div>'
      + '</div>';
  }

  function tableRowHtml(headline, supporting) {
    return ''
      + '<div class="list-item two-line" style="padding-left:24px;padding-right:0;min-height:0;">'
      + '  <div class="content">'
      + '    <div class="headline mono" style="font-size:14px;">' + headline + '</div>'
      + (supporting ? '    <div class="supporting">' + supporting + '</div>' : '')
      + '  </div>'
      + '</div>';
  }

  // Group rows by a key, resolved keys first in natural order (port7 before
  // port32) — the desktop tables' ordering.
  function groupRows(rows, keyOf) {
    var byKey = {};
    rows.forEach(function (r) {
      var k = keyOf(r);
      (byKey[k.key] = byKey[k.key] || { key: k.key, resolved: k.resolved, entries: [] }).entries.push(r);
    });
    return Object.keys(byKey).map(function (k) { return byKey[k]; }).sort(function (a, b) {
      if (a.resolved !== b.resolved) return a.resolved ? -1 : 1;
      return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" });
    });
  }

  function filterInputHtml(id, placeholder, value) {
    return '<input type="search" id="' + id + '" placeholder="' + escapeHtml(placeholder) + '" value="' + escapeHtml(value || "") + '" autocomplete="off" '
      + 'style="width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;border:1px solid var(--md-outline);background:var(--md-surface-cont-high);color:var(--md-on-surface);font-size:14px;margin-bottom:8px;">';
  }

  function wireFilterInput(id, onChange) {
    var box = document.getElementById(id);
    if (!box) return;
    var t = null;
    box.addEventListener("input", function () {
      clearTimeout(t);
      t = setTimeout(function () { onChange(box.value.trim().toLowerCase()); }, 150);
    });
  }

  // Groups start collapsed on a big table (a core gate's cache runs into the
  // thousands); a filter, or a table that fits on a screen, opens them all.
  function groupsStartExpanded(groups, filter) {
    if (filter) return true;
    if (groups.length === 1) return true;
    var n = groups.reduce(function (s, g) { return s + g.entries.length; }, 0);
    return n <= 40;
  }

  // ─── ARP Table sheet ───────────────────────────────────────────────────
  // The gate's layer-3 neighbour cache, interface-first like the desktop
  // tab, with its range selector (Current = the last read; the rest = held
  // at any point in the window) and one filter box over IP / MAC /
  // interface / hostname.
  var ARP_RANGES = [
    { id: "current", label: "Current" },
    { id: "1h",      label: "Last hour" },
    { id: "12h",     label: "Last 12 hours" },
    { id: "24h",     label: "Last 24 hours" },
    { id: "7d",      label: "Last 7 days" },
    { id: "30d",     label: "Last 30 days" },
  ];
  var ARP_RANGE_DAYS = { current: 0, "1h": 1 / 24, "12h": 0.5, "24h": 1, "7d": 7, "30d": 30 };
  var _arpRange = Object.create(null);   // per asset, for the SPA lifetime

  function arpAgeLabel(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec < 0) return null;
    if (sec < 60) return Math.round(sec) + "s";
    if (sec < 3600) return Math.floor(sec / 60) + "m";
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    return h + "h " + String(m).padStart(2, "0") + "m";
  }

  function cadenceLabel(sec) {
    if (typeof sec !== "number" || !isFinite(sec) || sec <= 0) return null;
    if (sec < 60) return sec + "s";
    if (sec < 3600) return Math.round(sec / 60) + "m";
    return Math.round(sec / 3600) + "h";
  }

  function loadArpSheet(assetId) {
    var current = beginTableLoad("arp", assetId);
    if (!current) return;
    var range = _arpRange[assetId] || "current";
    api.assets.arpTable(assetId, range).then(function (data) {
      if (!current()) return;
      var entries = (data && data.entries) || [];
      var retentionDays = (data && typeof data.retentionDays === "number") ? data.retentionDays : null;
      var controls = document.getElementById("table-sheet-controls");
      var meta = document.getElementById("table-sheet-meta");
      var body = document.getElementById("table-sheet-body");
      if (!body) return;

      var opts = ARP_RANGES.map(function (r) {
        var beyond = retentionDays != null && retentionDays >= 0 && ARP_RANGE_DAYS[r.id] > retentionDays;
        return '<option value="' + r.id + '"' + (r.id === range ? " selected" : "") + (beyond ? " disabled" : "") + '>'
          + escapeHtml(r.label) + (beyond ? " (beyond retention)" : "") + '</option>';
      }).join("");
      var filter = "";
      if (controls) {
        controls.innerHTML = ''
          + '<select id="arp-range-select" style="width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--md-outline);background:var(--md-surface-cont-high);color:var(--md-on-surface);font-size:14px;margin-bottom:8px;">' + opts + '</select>'
          + (entries.length ? filterInputHtml("arp-filter", "Filter by IP, MAC, interface or hostname", "") : '');
        var sel = document.getElementById("arp-range-select");
        if (sel) sel.addEventListener("change", function () {
          _arpRange[assetId] = sel.value;
          loadArpSheet(assetId);
        });
        wireFilterInput("arp-filter", function (f) { filter = f; renderBody(); });
      }

      // The desktop tab's disclaimer, compressed: a read is a snapshot of a
      // cache that ages out in minutes, so absence here proves little.
      var cad = cadenceLabel(data && data.pollIntervalSec);
      var metaBits = [];
      metaBits.push(data && data.collectedAt ? "read " + escapeHtml(formatTimeAgo(data.collectedAt)) : "never read");
      metaBits.push(cad ? "every " + escapeHtml(cad) : "on discovery only");
      var metaHead = metaBits.join(" · ");
      var metaNote = '<br><span style="opacity:.8;">Each read is a snapshot and a FortiGate ages entries out in about 1–5 minutes, so short-lived entries can be missing.</span>';

      if (!entries.length) {
        if (meta) meta.innerHTML = metaHead + metaNote;
        body.innerHTML = tableMsg(range === "current"
          ? "No ARP entries. Either this device holds no neighbours, or Polaris has never had a successful read from it."
          : "No ARP entries seen in this window.");
        return;
      }

      // On a historical range the rows are not one instant, so each carries
      // its own last-seen; on Current it would only repeat the header.
      var showLastSeen = range !== "current";

      function matches(e) {
        if (!filter) return true;
        var hay = [e.ipAddress, e.macAddress, e.ifName || "", e.matchedAsset ? (e.matchedAsset.hostname || "") : ""].join(" ").toLowerCase();
        return hay.indexOf(filter) !== -1;
      }

      function renderBody() {
        if (!current()) return;
        var shown = entries.filter(matches);
        var matched = shown.filter(function (e) { return !!e.matchedAsset; }).length;
        if (meta) meta.innerHTML = metaHead + " · " + shown.length + (filter ? " of " + entries.length : "")
          + " entr" + (shown.length === 1 ? "y" : "ies") + " · " + matched + " matched" + metaNote;
        var groups = groupRows(shown, function (e) {
          return { key: e.ifName || "(no interface reported)", resolved: !!e.ifName };
        });
        if (!groups.length) { body.innerHTML = tableMsg("No entries match that filter."); return; }
        var expanded = groupsStartExpanded(groups, filter);
        body.innerHTML = groups.map(function (g) {
          var rows = g.entries.map(function (e) {
            var sub = ['<span class="mono">' + escapeHtml(e.macAddress || "—") + '</span>'];
            var age = arpAgeLabel(e.ageSec);
            if (age) sub.push("age " + escapeHtml(age));
            if (showLastSeen && e.lastSeen) sub.push("seen " + escapeHtml(formatTimeAgo(e.lastSeen)));
            var dev = matchedDeviceHtml(e.matchedAsset);
            if (dev) sub.push(dev);
            return tableRowHtml(escapeHtml(e.ipAddress), sub.join(" · "));
          }).join("");
          return tableGroupHtml(g.key, "· " + g.entries.length + " entr" + (g.entries.length === 1 ? "y" : "ies"), rows, expanded);
        }).join("");
      }
      renderBody();
    }).catch(function (err) {
      if (!current()) return;
      var body = document.getElementById("table-sheet-body");
      if (body) body.innerHTML = tableMsg("Couldn’t load the ARP table: " + escapeHtml(err && err.message ? err.message : "error"));
    });
  }

  // ─── MAC Table sheet ───────────────────────────────────────────────────
  // The switch's forwarding database, port-first like the desktop tab: the
  // port is the group, its learned-MAC count says access port vs uplink, and
  // entries on unresolved trunk / LAG pseudo-ports are hidden behind a toggle
  // rather than swamping the real ports.
  function loadMacSheet(assetId) {
    var current = beginTableLoad("mac", assetId);
    if (!current) return;
    api.assets.macTable(assetId).then(function (data) {
      if (!current()) return;
      var entries = (data && data.entries) || [];
      // VLAN id -> name (vlanNameService); an unnamed id stays "VLAN 30".
      var vlanNames = (data && data.vlanNames) || {};
      function vlanLabel(id) { return vlanNames[String(id)] || ("VLAN " + id); }
      var controls = document.getElementById("table-sheet-controls");
      var meta = document.getElementById("table-sheet-meta");
      var body = document.getElementById("table-sheet-body");
      if (!body) return;

      var cad = cadenceLabel(data && data.pollIntervalSec);
      var metaHead = (data && data.collectedAt ? "read " + escapeHtml(formatTimeAgo(data.collectedAt)) : "no entries recorded yet")
        + " · " + (cad ? "every " + escapeHtml(cad) : "not polled");

      if (!entries.length) {
        if (controls) controls.innerHTML = "";
        if (meta) meta.innerHTML = metaHead;
        var lastPass = data && data.lastSystemInfoAt;
        body.innerHTML = tableMsg("No forwarding-database entries. This is collected over SNMP on the system-info cadence; a switch polled via its parent FortiGate reports none."
          + (lastPass
              ? " The last system-info pass ran " + escapeHtml(formatTimeAgo(lastPass)) + " and returned none."
              : " No system-info pass has completed against this switch yet."));
        return;
      }

      var attributed   = entries.filter(function (e) { return !!e.ifName; });
      var unattributed = entries.filter(function (e) { return !e.ifName; });
      var showUnattributed = false;
      var filter = "";

      if (controls) {
        controls.innerHTML = filterInputHtml("mac-filter", "Filter by MAC, port, VLAN or hostname", "");
        wireFilterInput("mac-filter", function (f) { filter = f; renderBody(); });
      }

      function matches(e) {
        if (!filter) return true;
        var hay = [e.macAddress, e.ifName || "", e.vlanId != null ? "vlan " + e.vlanId + " " + vlanLabel(e.vlanId) : "",
          e.matchedAsset ? (e.matchedAsset.hostname || "") : ""].join(" ").toLowerCase();
        return hay.indexOf(filter) !== -1;
      }

      function renderBody() {
        if (!current()) return;
        var pool = showUnattributed ? attributed.concat(unattributed) : attributed;
        var shown = pool.filter(matches);
        var groups = groupRows(shown, function (e) {
          return { key: e.ifName || ("base port " + (e.basePort != null ? e.basePort : "?")), resolved: !!e.ifName };
        });
        if (meta) meta.innerHTML = metaHead + " · " + shown.length + " entr" + (shown.length === 1 ? "y" : "ies")
          + " on " + groups.length + " port" + (groups.length === 1 ? "" : "s");
        var note = !unattributed.length ? "" :
          '<div class="muted" style="font-size:12px;margin-bottom:8px;">' + unattributed.length + ' entr' + (unattributed.length === 1 ? "y" : "ies")
          + ' on ports Polaris could not resolve (trunk / LAG pseudo-ports). '
          + '<a href="#" id="mac-unattributed-toggle" style="color:var(--md-primary);">' + (showUnattributed ? "Hide" : "Show") + '</a></div>';
        if (!groups.length) {
          body.innerHTML = note + tableMsg(filter ? "No entries match that filter." : "No entries on a resolved port.");
        } else {
          var expanded = groupsStartExpanded(groups, filter);
          body.innerHTML = note + groups.map(function (g) {
            // Only learned rows say what is reachable through the port — self
            // is the bridge's own address and mgmt a static entry.
            var learned = g.entries.filter(function (e) { return e.status === "learned"; }).length;
            var reads = !g.resolved ? "unresolved port"
              : learned === 0 ? ""
              : learned === 1 ? "access port"
              : "uplink / trunk";
            var summary = "· " + g.entries.length + " MAC" + (g.entries.length === 1 ? "" : "s") + (reads ? " · " + escapeHtml(reads) : "");
            var rows = g.entries.map(function (e) {
              var sub = [];
              if (e.vlanId != null) sub.push(escapeHtml(vlanLabel(e.vlanId)) + (e.vlanInferred ? " (inferred)" : ""));
              if (e.status) sub.push(escapeHtml(e.status));
              var dev = matchedDeviceHtml(e.matchedAsset);
              if (dev) sub.push(dev);
              return tableRowHtml(escapeHtml(e.macAddress), sub.join(" · "));
            }).join("");
            return tableGroupHtml(g.key, summary, rows, expanded);
          }).join("");
        }
        var tog = document.getElementById("mac-unattributed-toggle");
        if (tog) tog.addEventListener("click", function (e) {
          e.preventDefault();
          showUnattributed = !showUnattributed;
          renderBody();
        });
      }
      renderBody();
    }).catch(function (err) {
      if (!current()) return;
      var body = document.getElementById("table-sheet-body");
      if (body) body.innerHTML = tableMsg("Couldn’t load the MAC table: " + escapeHtml(err && err.message ? err.message : "error"));
    });
  }

  // ─── Wireless sheet ────────────────────────────────────────────────────
  // The AP's radios → the SSIDs each broadcasts → the clients on each, from
  // /system-info's apRadios + wirelessStations (the desktop Wireless tab's
  // source). Stations file under their SSID by BSSID first, then by
  // (radio, SSID name); anything unfiled is SHOWN under its own heading so
  // the tree never disagrees with the client count. An AP with no radio
  // inventory falls back to a flat client list.
  function wirelessBandLabel(band) {
    if (band === "2.4GHz") return "2.4 GHz";
    if (band === "5GHz")   return "5 GHz";
    if (band === "6GHz")   return "6 GHz";
    return "";
  }

  function buildWirelessTree(radios, stations) {
    var byBssid = {}, byRadioSsid = {};
    var nodes = radios.map(function (r) {
      var vapNodes = (r.vaps || []).map(function (v) {
        var node = { vap: v, stations: [] };
        if (v.bssid) byBssid[String(v.bssid).toUpperCase()] = node;
        if (v.ssid)  byRadioSsid[r.radioIndex + "\u0000" + String(v.ssid).toLowerCase()] = node;
        return node;
      });
      return { radio: r, vaps: vapNodes };
    });
    var unplaced = [];
    stations.forEach(function (s) {
      var node = s.bssid ? byBssid[String(s.bssid).toUpperCase()] : null;
      if (!node && s.radioId != null && s.ssid) node = byRadioSsid[s.radioId + "\u0000" + String(s.ssid).toLowerCase()];
      if (node) node.stations.push(s); else unplaced.push(s);
    });
    return { radios: nodes, unplaced: unplaced };
  }

  function wirelessStationRow(s) {
    var sub = [];
    if (s.staIpAddr) sub.push('<span class="mono">' + escapeHtml(s.staIpAddr) + '</span>');
    if (s.signalStrength != null) sub.push(escapeHtml(s.signalStrength + " dBm"));
    var band = wirelessBandLabel(s.band);
    if (band) sub.push(escapeHtml(band));
    var dev = matchedDeviceHtml(s.matchedAsset);
    sub.push(dev || '<span class="muted">not in inventory</span>');
    return tableRowHtml(escapeHtml(s.staMacAddr || "—"), sub.join(" · "));
  }

  // The AP's wireless-mesh role — the desktop Wireless strip's label
  // (_wirelessMeshRoleChipHTML). Root: another inventory AP is associated to
  // it as a client. Leaf: the controller reports its uplink as mesh
  // (fortinetTopology.meshUplink). Both on a mesh hop; "" otherwise. No hover
  // on a phone, so the leaves and the parent serial are spelled out inline.
  function wirelessMeshRoleHtml(asset, stations) {
    var topo = asset && asset.fortinetTopology;
    var isLeaf = !!topo && typeof topo === "object" && topo.meshUplink === "mesh";
    var parentSerial = isLeaf && typeof topo.parentApSerial === "string" ? topo.parentApSerial : "";
    var leaves = stations.filter(function (s) {
      return s && s.matchedAsset && s.matchedAsset.assetType === "access_point";
    });
    var lines = [];
    if (leaves.length) {
      lines.push('<strong>Mesh root</strong> <span class="muted">· serving ' +
        escapeHtml(leaves.map(function (s) { return s.matchedAsset.hostname || s.staMacAddr; }).join(", ")) + '</span>');
    }
    if (isLeaf) {
      lines.push('<strong>Mesh leaf</strong>' +
        (parentSerial ? ' <span class="muted">· parent AP <span class="mono">' + escapeHtml(parentSerial) + '</span></span>' : ""));
    }
    return lines.length
      ? '<div id="wireless-mesh-role" style="font-size:13px;margin-bottom:8px;">' + lines.join("<br>") + '</div>'
      : "";
  }

  function loadWirelessSheet(assetId, refetch) {
    var current = beginTableLoad("wireless", assetId);
    if (!current) return;
    // loadSystemInfo already fetched this snapshot for the sheet's sensor and
    // interface sections — reuse it on open; Reload fetches a fresh one.
    var cached = !refetch && _systemInfoCache[assetId];
    var p = cached ? Promise.resolve(cached) : api.assets.systemInfo(assetId);
    p.then(function (si) {
      if (!current()) return;
      if (!cached) _systemInfoCache[assetId] = si;
      var stations = (si && si.wirelessStations) || [];
      var radios = (si && si.apRadios) || [];
      var meta = document.getElementById("table-sheet-meta");
      var body = document.getElementById("table-sheet-body");
      if (!body) return;
      var controls = document.getElementById("table-sheet-controls");
      if (controls) controls.innerHTML = "";
      var lastAt = (si && si.lastSystemInfoAt) || null;
      if (meta) meta.innerHTML = (lastAt ? "read " + escapeHtml(formatTimeAgo(lastAt)) : "never collected")
        + " · " + radios.length + " radio" + (radios.length === 1 ? "" : "s")
        + " · " + stations.length + " client" + (stations.length === 1 ? "" : "s");
      var meshRole = wirelessMeshRoleHtml(_assetCache[assetId], stations);

      if (!radios.length) {
        body.innerHTML = meshRole + (stations.length
          ? stations.map(wirelessStationRow).join('<div class="list-divider"></div>')
          : tableMsg("No radios or wireless clients reported for this AP."));
        return;
      }

      var tree = buildWirelessTree(radios, stations);
      var html = tree.radios.map(function (rn) {
        var r = rn.radio;
        // Counted from the clients filed below, not the controller's tally —
        // the two disagree mid-roam and a number next to a list must match it.
        var clients = rn.vaps.reduce(function (n, vn) { return n + vn.stations.length; }, 0);
        var bits = [];
        var band = wirelessBandLabel(r.band);
        if (band) bits.push(band);
        if (r.channel != null) bits.push("ch " + r.channel + (r.bandwidthMhz != null ? " · " + r.bandwidthMhz + " MHz" : ""));
        bits.push(clients + (clients === 1 ? " client" : " clients"));
        var inner = rn.vaps.length ? rn.vaps.map(function (vn) {
          var v = vn.vap;
          var ssidBits = [vn.stations.length + (vn.stations.length === 1 ? " client" : " clients")];
          if (v.vlanId != null) ssidBits.push("VLAN " + v.vlanId);
          return ''
            + '<div style="padding:6px 0 2px 24px;font-weight:500;">' + escapeHtml(v.ssid || v.vapName || "(SSID)")
            + ' <span class="muted" style="font-weight:400;font-size:12px;">· ' + escapeHtml(ssidBits.join(" · ")) + '</span></div>'
            + vn.stations.map(wirelessStationRow).join("");
        }).join("") : '<div class="muted" style="padding:4px 0 8px 24px;font-size:13px;">No SSIDs reported for this radio.</div>';
        return tableGroupHtml("Radio " + r.radioIndex, "· " + escapeHtml(bits.join(" · ")), inner, true);
      }).join("");
      if (tree.unplaced.length) {
        html += tableGroupHtml("Not matched to an SSID",
          "· " + tree.unplaced.length + " of " + stations.length,
          tree.unplaced.map(wirelessStationRow).join(""), true);
      }
      body.innerHTML = meshRole + html;
    }).catch(function (err) {
      if (!current()) return;
      var body = document.getElementById("table-sheet-body");
      if (body) body.innerHTML = tableMsg("Couldn’t load wireless data: " + escapeHtml(err && err.message ? err.message : "error"));
    });
  }

  // Discovery sources — which integrations independently reported this asset.
  function loadSources(id, st) {
    var host = document.getElementById("asset-sources-host");
    var sub  = document.getElementById("asset-sources-sub");
    if (!host) return;
    api.assets.getSources(id).then(function (resp) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      var rows = Array.isArray(resp) ? resp : [];
      if (sub) sub.textContent = rows.length ? rows.length + (rows.length === 1 ? " source" : " sources") : "none";
      if (rows.length === 0) {
        host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No discovery sources recorded.</div>';
        return;
      }
      var html = "";
      rows.forEach(function (s, i) {
        var label = SOURCE_LABELS[s.sourceKind] || s.sourceKind;
        var bits = [];
        // Server-derived enabled/disabled verdict for this source (see
        // src/utils/assetSourceState.ts) — leads the supporting line so the
        // question "which source is calling this disabled?" is answerable
        // without opening the desktop UI. Omitted when unreported.
        if (s.state && s.state.state && s.state.state !== "unknown") {
          var col = s.state.state === "disabled" ? "var(--md-error)" : "var(--md-success)";
          bits.push('<span style="color:' + col + ';font-weight:500;">' + escapeHtml(s.state.label) + '</span>');
        }
        if (s.integration && s.integration.name) bits.push(escapeHtml(s.integration.name));
        if (s.lastSeen) bits.push("seen " + escapeHtml(formatTimeAgo(s.lastSeen)));
        var inferred = s.inferred ? ' <span class="muted" style="font-size:12px;font-weight:400;">· inferred</span>' : '';
        var extId = s.externalId
          ? '<div class="mono" style="font-size:11px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(s.externalId) + '</div>'
          : '';
        html += ''
          + '<div class="list-item two-line" style="padding-left:16px;padding-right:16px;">'
          + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-server"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(label) + inferred + '</div>'
          + '    <div class="supporting">' + bits.join(" · ") + extId + '</div>'
          + '  </div>'
          + '</div>'
          + (i < rows.length - 1 ? '<div class="list-divider"></div>' : '');
      });
      host.innerHTML = html;
    }).catch(function (err) {
      if (_openId !== id) return;
      if (sub) sub.textContent = "—";
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load sources: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  // FortiGate sightings — which firewalls have seen this asset, enriched with
  // subnet/VLAN server-side. Endpoint needs `assetsQuarantine read`; lower-
  // privilege roles get an error which we surface as a muted note.
  function loadSightings(id, st) {
    var host = document.getElementById("asset-sightings-host");
    var sub  = document.getElementById("asset-sightings-sub");
    if (!host) return;
    api.assets.getSightings(id).then(function (resp) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      var rows = Array.isArray(resp) ? resp : [];
      if (sub) sub.textContent = rows.length ? rows.length + (rows.length === 1 ? " firewall" : " firewalls") : "none";
      if (rows.length === 0) {
        host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No firewall sightings.</div>';
        return;
      }
      var html = "";
      rows.forEach(function (s, i) {
        var bits = [];
        if (s.ipAddress) bits.push('<span class="mono">' + escapeHtml(s.ipAddress) + '</span>');
        var netParts = [];
        if (s.subnetName) netParts.push(escapeHtml(s.subnetName));
        if (s.vlan != null) netParts.push("VLAN " + escapeHtml(String(s.vlan)));
        if (netParts.length) bits.push(netParts.join(" "));
        if (s.source) bits.push(escapeHtml(s.source));
        if (s.lastSeen) bits.push("seen " + escapeHtml(formatTimeAgo(s.lastSeen)));
        html += ''
          + '<div class="list-item two-line" style="padding-left:16px;padding-right:16px;">'
          + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-router"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline">' + escapeHtml(s.fortigateDevice || "?") + '</div>'
          + '    <div class="supporting">' + bits.join(" · ") + '</div>'
          + '  </div>'
          + '</div>'
          + (i < rows.length - 1 ? '<div class="list-divider"></div>' : '');
      });
      host.innerHTML = html;
    }).catch(function (err) {
      if (_openId !== id) return;
      if (sub) sub.textContent = "—";
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load firewall sightings: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  function loadIpHistory(id, st) {
    var host = document.getElementById("asset-ip-history-host");
    var sub  = document.getElementById("asset-ip-history-sub");
    if (!host) return;
    api.assets.getIpHistory(id).then(function (resp) {
      if (_openId !== id) return;   // bail if a newer asset replaced us
      // The endpoint returns a bare array — not `{ history: [...] }`.
      var rows = Array.isArray(resp) ? resp : ((resp && resp.history) || []);
      if (sub) sub.textContent = rows.length ? rows.length + (rows.length === 1 ? " address" : " addresses") : "none";
      if (rows.length === 0) {
        host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">No IP history recorded yet.</div>';
        return;
      }
      var html = "";
      rows.forEach(function (r, i) {
        html += ''
          + '<div class="list-item two-line" style="padding-left:16px;padding-right:16px;">'
          + '  <span class="leading"><svg viewBox="0 0 24 24"><use href="#i-history"/></svg></span>'
          + '  <div class="content">'
          + '    <div class="headline mono">' + escapeHtml(r.ip || "") + '</div>'
          + '    <div class="supporting">' + escapeHtml((r.source ? r.source + " · " : "") + (formatTimeAgo(r.lastSeen) || "")) + '</div>'
          + '  </div>'
          + '</div>'
          + (i < rows.length - 1 ? '<div class="list-divider"></div>' : '');
      });
      host.innerHTML = html;
    }).catch(function (err) {
      if (_openId !== id) return;
      if (sub) sub.textContent = "—";
      host.innerHTML = '<div class="muted" style="padding:8px 16px 16px;font-size:13px;">Couldn’t load IP history: ' + escapeHtml(err && err.message ? err.message : "error") + '</div>';
    });
  }

  // ─── Quarantine ────────────────────────────────────────────────────────
  // Mirrors the desktop quarantine tab's eligibility (assets.js
  // `_assetQuarantineTabHTML` + the tab guard): gate on the assetsQuarantine
  // write permission (the backend gate on POST/DELETE /assets/:id/quarantine),
  // then offer Quarantine only for non-infra assets that carry a MAC, and
  // Release for anything already quarantined. Infrastructure (firewall /
  // switch / access_point) can't be newly quarantined but keeps Release so a
  // misclassified push can still be undone.
  var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
  function canQuarantine() {
    var user = (window.PolarisMobile && PolarisMobile.user && PolarisMobile.user()) || null;
    var have = (user && user.permissions && user.permissions.assetsQuarantine) || "none";
    return (_PERM_RANK[have] || 0) >= _PERM_RANK.write;
  }

  // Quarantine push is per-integration (`config.pushQuarantine`, off by
  // default) — with it off on every enabled Fortinet integration the push
  // resolves to zero targets and fails with "0/0 FortiGate(s) accepted the
  // push", so the button is withheld rather than offered. Mirrors
  // _quarantinePushAvailable() in assets.js, including fail-open on an
  // unanswered/failed probe and never gating Release (releaseQuarantine
  // unpushes from the targets recorded on the asset, toggle or not).
  var _qtnPushEnabled = null;
  var _qtnPushProbe = null;
  function quarantinePushAvailable() { return _qtnPushEnabled !== false; }
  function warmQuarantinePushAvailability() {
    if (_qtnPushProbe || !canQuarantine()) return _qtnPushProbe;
    _qtnPushProbe = api.assets.quarantineAvailability().then(function (r) {
      _qtnPushEnabled = !!(r && r.pushEnabled);
    }).catch(function () { _qtnPushEnabled = null; });
    return _qtnPushProbe;
  }

  function quarantineButtonHtml(asset) {
    if (!asset || !canQuarantine()) return "";
    if (asset.status === "quarantined") {
      return '<button class="btn btn-tonal btn-block" style="margin-top:12px;" id="asset-quarantine-btn" data-q="release"><svg viewBox="0 0 24 24"><use href="#i-shield"/></svg>Release Quarantine</button>';
    }
    var isInfra = asset.assetType === "firewall" || asset.assetType === "switch" || asset.assetType === "access_point";
    var hasMac = !!(asset.macAddress || (asset.macAddresses && asset.macAddresses.length));
    if (hasMac && !isInfra && quarantinePushAvailable()) {
      return '<button class="btn btn-error btn-block" style="margin-top:12px;" id="asset-quarantine-btn" data-q="quarantine"><svg viewBox="0 0 24 24"><use href="#i-shield"/></svg>Quarantine</button>';
    }
    return "";
  }

  function wireQuarantineButton(asset, st) {
    var btn = document.getElementById("asset-quarantine-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      if (btn.dataset.q === "release") {
        if (!window.confirm("Release quarantine on this asset? Removes the MAC block from every FortiGate it was pushed to.")) return;
        btn.disabled = true;
        api.assets.unquarantine(asset.id).then(function (result) {
          PolarisTabs.showSnackbar((result && result.message) || "Quarantine released");
          refreshAfterQuarantine(asset.id, st);
        }).catch(function (err) {
          btn.disabled = false;
          PolarisTabs.showSnackbar(err && err.message ? err.message : "Release failed", { error: true });
        });
      } else {
        // window.prompt returns null on cancel (no push), "" when the operator
        // submits without a reason (proceed — reason is optional).
        var reason = window.prompt("Reason for quarantine (optional):");
        if (reason === null) return;
        btn.disabled = true;
        api.assets.quarantine(asset.id, reason || undefined).then(function (result) {
          PolarisTabs.showSnackbar((result && result.message) || "Asset quarantined");
          refreshAfterQuarantine(asset.id, st);
        }).catch(function (err) {
          btn.disabled = false;
          PolarisTabs.showSnackbar(err && err.message ? err.message : "Quarantine failed", { error: true });
        });
      }
    });
  }

  // Re-fetch the asset after a quarantine/release so the hero pill, header dot
  // and the action button itself reflect the new status — a targeted repaint
  // rather than a whole reloadSheet. Guarded by _openId so a stale response
  // from a superseded asset can't overwrite the current sheet.
  function refreshAfterQuarantine(id, st) {
    api.assets.get(id).then(function (fresh) {
      if (!fresh || _openId !== id) return;
      _assetCache[id] = fresh;
      var pillHost = document.getElementById("asset-hero-pill");
      if (pillHost) pillHost.innerHTML = renderMonitorPill(fresh);
      setHeader(fresh);
      var wrap = document.getElementById("asset-quarantine-btn-wrap");
      if (wrap) {
        wrap.innerHTML = quarantineButtonHtml(fresh);
        wireQuarantineButton(fresh, st);
      }
    }).catch(function () { /* pill/button stay as-is; the action already toasted */ });
  }

  // ─── Firmware upgrade (business rule 87) ────────────────────────────────
  // A switch, access point or FortiGate's OS / Firmware row carries the upgrade verb —
  // the desktop Firmware card, cut down to what a phone needs: the button
  // when the Repository holds a newer image and the operator may flash
  // (assets:write, rule 43(g)), a stacked confirm sheet naming the device and
  // the exact image (never window.confirm — suppressed in some installed
  // PWAs; canon-mobile), then "Upgrade started" and live progress polled from
  // the per-asset run read. The same sheet books the flash for later — a
  // "Schedule for later" box reveals the time and the results recipients
  // (business rule 93) — and a pending booking sits on the row with Change /
  // Cancel. The PRIMARY image only: choosing the model's backup, the run
  // history and its log stay on the desktop card. The Repository itself is
  // desktop-only.
  var FW_ELIGIBLE = { "switch": true, "access_point": true, "firewall": true };
  var FW_POLL_MS = 3000;
  var FW_STAGE_LABELS = {
    preflight: "Signing in",
    staging: "Uploading image",
    compat: "Checking compatibility",
    deploying: "Flashing",
    rebooting: "Rebooting",
    verifying: "Verifying new version",
    recovering: "Waiting for monitoring to answer",
  };
  var _fwPoll = null;   // { assetId, runId, timer } while a run is being watched

  function canFlashFirmware() {
    var user = (window.PolarisMobile && PolarisMobile.user && PolarisMobile.user()) || null;
    var have = (user && user.permissions && user.permissions.assets) || "none";
    return (_PERM_RANK[have] || 0) >= _PERM_RANK.write;
  }

  /** The OS row's value: the version text, plus a slot the firmware loader fills. */
  function osRowValue(asset) {
    var text = [asset.os, asset.osVersion].filter(Boolean).join(" ");
    if (!FW_ELIGIBLE[asset.assetType]) return text;
    return '<span>' + escapeHtml(text || "—") + '</span><span id="asset-fw-badge"></span><div id="asset-fw-slot" class="asset-fw-slot"></div>';
  }

  /**
   * "Up to date" beside the version: the Repository holds an active (primary)
   * image for this device's platform and the device runs exactly that version
   * (`vsPrimary === "current"`, the firmwareVsPrimary comparison). Nothing for
   * a device past the active image or one the Repository cannot place. Pure.
   */
  function fwBadgeHtml(fw) {
    if (!fw || fw.error || fw.state !== "up-to-date" || fw.vsPrimary !== "current") return "";
    return ' <span class="fw-uptodate" style="margin-left:6px;font-size:12px;padding:1px 8px;color:var(--md-success);border:1px solid var(--md-success);border-radius:10px;white-space:nowrap;" title="'
      + escapeHtml("Runs the Repository's active image" + (fw.primaryVersion ? " (" + fw.primaryVersion + ")" : "")) + '">✓ Up to date</span>';
  }

  /**
   * One line for a run in flight: the stage, and on a switch the percent of
   * the stage the flash is in (the engine stores percent, 0..100).
   */
  function fwProgressText(run) {
    if (!run) return "Upgrade started";
    var stage = run.stage;
    var p = run.progress || {};
    if (stage === "deploying" && (typeof p.erase === "number" || typeof p.write === "number" || typeof p.verify === "number")) {
      var parts = [["erase", "Erasing flash"], ["write", "Writing image"], ["verify", "Verifying image"]];
      for (var i = 0; i < parts.length; i++) {
        var v = p[parts[i][0]];
        if (typeof v === "number" && v < 100) return parts[i][1] + " " + Math.round(v) + "%";
      }
      return "Flashing — finishing up";
    }
    return FW_STAGE_LABELS[stage] || "Upgrade started";
  }

  /** What the slot shows for an availability answer. Pure, for the tests. */
  function fwSlotHtml(fw) {
    if (!fw || fw.error) return "";
    if (fw.state === "running" && fw.activeRun) return fwRunningHtml(fw.activeRun);
    // An HA secondary (business rule 129): its cluster is upgraded from the primary.
    if (fw.state === "cluster-member") {
      var primaryName = fw.clusterPrimary && fw.clusterPrimary.hostname ? fw.clusterPrimary.hostname : "its primary";
      var primaryId = fw.clusterPrimary && fw.clusterPrimary.hostname ? fw.clusterPrimary.assetId : null;
      return '<div class="muted" id="asset-fw-cluster" style="font-size:12px;margin-top:4px;">HA secondary — '
        + (fw.activeRun ? "the cluster is upgrading now, from " : "upgraded with its cluster from ") + linkHtml(primaryId, primaryName) + '</div>';
    }
    // In a pending / running GROUP upgrade (business rule 122): the group
    // flashes it, and the group is managed from the desktop Assets page.
    if (fw.group) {
      return '<div class="muted" id="asset-fw-group" style="font-size:12px;margin-top:4px;">Part of a group upgrade on ' + linkHtml(fw.group.gateAssetId, fw.group.gateName) + ' — '
        + (fw.group.status === "running" ? "running now" : escapeHtml(fwWhenText(fw.group.scheduledFor))) + '</div>';
    }
    var out = "";
    // Blocked is about NOW: the same verb opens the sheet with "Schedule for
    // later" ticked and locked, because a booking re-takes every gate when it
    // is due (business rule 93).
    var offered = fw.image && (fw.state === "available" || fw.state === "blocked");
    if (offered && !fw.schedule) {
      if (!canFlashFirmware()) {
        out += '<div class="muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(fw.image.versionLabel) + ' available — upgrading needs Read-Write on Assets</div>';
      } else {
        out += '<button class="btn btn-tonal" id="asset-fw-upgrade-btn" style="margin-top:6px;">Upgrade to ' + escapeHtml(fw.image.versionLabel) + '</button>';
        if (fw.cluster) out += '<div class="muted" style="font-size:12px;margin-top:4px;">Upgrades the whole HA cluster — every member reboots, about 10 minutes</div>';
        if (fw.state === "blocked") out += '<div class="muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(fw.reason || "Not right now") + ' It can be scheduled for later.</div>';
      }
    } else if (offered && fw.state === "available" && fw.schedule && canFlashFirmware()) {
      out += '<button class="btn btn-tonal" id="asset-fw-upgrade-btn" style="margin-top:6px;">Upgrade to ' + escapeHtml(fw.image.versionLabel) + ' now</button>';
    }
    if (fw.schedule) out += fwScheduleLineHtml(fw.schedule);
    if (!out && fw.state === "pending-discovery") {
      out = '<div class="muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(fw.reason || "Upgraded — the record catches up on the next poll") + '</div>';
    }
    return out;
  }

  /** A pending booking on the OS row: when, to what, and Change / Cancel at assets:write. */
  function fwScheduleLineHtml(sched) {
    return '<div id="asset-fw-schedule" style="margin-top:6px;font-size:13px;">'
      + '<div><strong>Scheduled:</strong> ' + escapeHtml(sched.toVersion) + ' at ' + escapeHtml(fwWhenText(sched.scheduledFor)) + '</div>'
      + '<div class="muted" style="font-size:12px;">Results to ' + escapeHtml((sched.notifyEmails || []).join(", ")) + '</div>'
      + (sched.error ? '<div style="font-size:12px;color:var(--md-warning);">Waiting: ' + escapeHtml(sched.error) + '</div>' : '')
      + (canFlashFirmware()
        ? '<div style="display:flex;gap:8px;margin-top:6px;">'
          + '<button class="btn btn-outlined" id="asset-fw-sched-change">Change</button>'
          + '<button class="btn btn-outlined" id="asset-fw-sched-cancel">Cancel</button></div>'
        : '')
      + '</div>';
  }

  /** "YYYY-MM-DDTHH:MM" in the phone's zone — a datetime-local input's value. Pure. */
  function fwLocalInputValue(d) {
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /** "Tue, Oct 7, 2:00 AM (in 9 h)". Pure. */
  function fwWhenText(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var txt = d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    var mins = Math.round((d.getTime() - Date.now()) / 60000);
    var rel = mins <= 0 ? "due now" : mins < 60 ? "in " + mins + " min" : mins < 48 * 60 ? "in " + Math.round(mins / 60) + " h" : "in " + Math.round(mins / 1440) + " days";
    return txt + " (" + rel + ")";
  }

  function fwParseEmails(text) {
    return String(text || "").split(/[\s,;]+/).map(function (s) { return s.trim(); }).filter(Boolean);
  }

  function loadFirmwareRow(id, asset) {
    if (!FW_ELIGIBLE[asset.assetType]) return;
    api.assets.firmwareUpgrade(id).then(function (fw) {
      if (_openId !== id) return;
      paintFirmwareSlot(asset, fw);
    }).catch(function () { /* the row keeps its version; the desktop card explains */ });
  }

  function paintFirmwareSlot(asset, fw) {
    var slot = document.getElementById("asset-fw-slot");
    if (!slot) return;
    slot.innerHTML = fwSlotHtml(fw);
    var badge = document.getElementById("asset-fw-badge");
    if (badge) badge.innerHTML = fwBadgeHtml(fw);
    var btn = document.getElementById("asset-fw-upgrade-btn");
    if (btn) btn.addEventListener("click", function () { startFirmwareFlow(asset, fw, btn, null); });
    var change = document.getElementById("asset-fw-sched-change");
    if (change && fw.schedule) change.addEventListener("click", function () { startFirmwareFlow(asset, fw, change, fw.schedule); });
    var cancel = document.getElementById("asset-fw-sched-cancel");
    if (cancel && fw.schedule) cancel.addEventListener("click", function () { cancelFirmwareSchedule(asset, fw.schedule, cancel); });
    if (fw && fw.state === "running" && fw.activeRun) watchFirmwareRun(asset.id, fw.activeRun.id);
    scheduleFirmwareRefresh(asset, fw);
  }

  // The desktop card's 10-minute re-read (assets.js _scheduleFirmwareRefresh):
  // while this asset's sheet is open, re-read the firmware status and repaint
  // only when the answer changed. While a flash is running its watcher owns
  // the slot, so the tick just waits another interval.
  var FW_REFRESH_MS = 10 * 60 * 1000;
  var _fwRefreshTimer = null;
  function scheduleFirmwareRefresh(asset, fw) {
    if (_fwRefreshTimer) clearTimeout(_fwRefreshTimer);
    _fwRefreshTimer = null;
    var sig = JSON.stringify(fw || null);
    _fwRefreshTimer = setTimeout(function () {
      _fwRefreshTimer = null;
      if (_openId !== asset.id || !document.getElementById("asset-fw-slot")) return;
      if (document.hidden || _fwPoll) { scheduleFirmwareRefresh(asset, fw); return; }
      api.assets.firmwareUpgrade(asset.id).then(function (next) {
        if (_openId !== asset.id) return;
        if (JSON.stringify(next || null) === sig) { scheduleFirmwareRefresh(asset, next); return; }
        paintFirmwareSlot(asset, next);
      }).catch(function () { scheduleFirmwareRefresh(asset, fw); });
    }, FW_REFRESH_MS);
  }

  /**
   * Upgrade now, book it for later, or change a booking — one sheet. `existing`
   * is the pending booking when changing it. The image is always the
   * PRIMARY on the phone (a booking keeps the image it was made with).
   */
  function startFirmwareFlow(asset, fw, btn, existing) {
    var mode = existing ? "change" : (fw.state === "blocked" ? "schedule-only" : (fw.schedule ? "now-only" : "choose"));
    var defaultsP = (mode === "choose" || mode === "schedule-only") && api.assets.firmwareScheduleDefaults
      ? api.assets.firmwareScheduleDefaults(asset.id).catch(function () { return null; })
      : Promise.resolve(null);
    defaultsP.then(function (defaults) {
      return confirmFirmwareUpgrade(asset, fw, { mode: mode, existing: existing, defaults: defaults });
    }).then(function (choice) {
      if (!choice || _openId !== asset.id) return;
      btn.disabled = true;
      if (choice.schedule) {
        var body = { scheduledFor: choice.schedule.scheduledFor, notifyEmails: choice.schedule.notifyEmails };
        var call = existing
          ? api.assets.updateFirmwareSchedule(asset.id, existing.id, body)
          : api.assets.scheduleFirmwareUpgrade(asset.id, Object.assign({ imageId: fw.image.id }, body));
        call.then(function () {
          if (_openId !== asset.id) return;
          PolarisTabs.showSnackbar(existing ? "Scheduled upgrade changed" : "Upgrade scheduled for " + new Date(body.scheduledFor).toLocaleString());
          loadFirmwareRow(asset.id, asset);
        }).catch(function (err) {
          btn.disabled = false;
          PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not save the schedule", { error: true });
        });
        return;
      }
      api.assets.startFirmwareUpgrade(asset.id, { imageId: fw.image.id }).then(function (res) {
        if (_openId !== asset.id) return;
        PolarisTabs.showSnackbar("Upgrade started");
        var slot = document.getElementById("asset-fw-slot");
        if (slot) slot.innerHTML = fwRunningHtml(res && res.run);
        if (res && res.run) watchFirmwareRun(asset.id, res.run.id);
      }).catch(function (err) {
        btn.disabled = false;
        PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not start the upgrade", { error: true });
      });
    });
  }

  function cancelFirmwareSchedule(asset, sched, btn) {
    btn.disabled = true;
    api.assets.cancelFirmwareSchedule(asset.id, sched.id).then(function () {
      PolarisTabs.showSnackbar("Scheduled upgrade cancelled");
      if (_openId === asset.id) loadFirmwareRow(asset.id, asset);
    }).catch(function (err) {
      btn.disabled = false;
      PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not cancel the scheduled upgrade", { error: true });
    });
  }

  /**
   * The sheet's body. Pure, for the tests. `opts.mode`: "choose" (upgrade now,
   * or tick "Schedule for later"), "schedule-only" (blocked now — the box is
   * ticked and locked), "change" (a booking's time and recipients), "now-only"
   * (a booking already exists, so no second one is offered).
   */
  function fwConfirmBodyHtml(asset, fw, opts) {
    opts = opts || {};
    var mode = opts.mode || "choose";
    var existing = opts.existing || null;
    var img = fw.image;
    var cred = fw.credential;
    function line(k, v) {
      return '<div class="kv-row"><span class="k">' + escapeHtml(k) + '</span><span class="v">' + v + '</span></div>';
    }
    var when = existing ? new Date(existing.scheduledFor) : (function () { var d = new Date(Date.now() + 60 * 60000); d.setMinutes(0, 0, 0); return d; })();
    var emails = existing ? (existing.notifyEmails || []) : ((opts.defaults && opts.defaults.notifyEmails) || []);
    var fields = ''
      + (fw.blockers && fw.blockers.length ? '<p style="margin:0 0 8px;font-size:13px;color:var(--md-warning);">Right now ' + escapeHtml(fw.blockers.join("; ")) + '. That is checked again when it is due.</p>' : '')
      + '<label style="display:block;font-size:13px;margin-bottom:4px;" for="fw-sched-when">Run at (your time)</label>'
      + '<input type="datetime-local" id="fw-sched-when" class="input" style="width:100%;" min="' + escapeHtml(fwLocalInputValue(new Date(Date.now() + 2 * 60000))) + '" value="' + escapeHtml(fwLocalInputValue(when)) + '">'
      + '<label style="display:block;font-size:13px;margin:10px 0 4px;" for="fw-sched-emails">Email the results to</label>'
      + '<input type="email" id="fw-sched-emails" class="input" style="width:100%;" multiple placeholder="you@example.com" value="' + escapeHtml(emails.join(", ")) + '">'
      + '<p style="margin:6px 0 0;font-size:12px;color:var(--md-on-surface-variant);">Not started if Polaris only gets to it more than 15 minutes late; waits up to 2 hours for an upgrade on a related device.</p>';
    var schedule;
    if (mode === "change") {
      schedule = '<div id="fw-sched-fields" style="margin-top:12px;">' + fields + '</div>';
    } else if (mode === "now-only") {
      schedule = '<p style="margin:12px 0 0;font-size:13px;color:var(--md-on-surface-variant);">An upgrade is already scheduled — change or cancel it from the OS row.</p>';
    } else {
      var locked = mode === "schedule-only";
      schedule = '<label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:14px;">'
        + '<input type="checkbox" id="fw-confirm-schedule"' + (locked ? ' checked disabled' : '') + '> Schedule for later</label>'
        + '<div id="fw-sched-fields" style="margin-top:8px;' + (locked ? '' : 'display:none;') + '">' + fields + '</div>';
    }
    var toVersion = img ? img.versionLabel : (existing ? existing.toVersion : "");
    return ''
      + '<div class="sheet-handle"></div>'
      + '<h3 class="sheet-title" style="margin:0 0 8px;">' + (existing ? "Change scheduled upgrade" : "Upgrade firmware?") + '</h3>'
      + line("Device", escapeHtml(asset.hostname || asset.ipAddress || asset.id))
      + (asset.serialNumber ? line("Serial", '<span class="mono">' + escapeHtml(asset.serialNumber) + '</span>') : '')
      + line("Running", escapeHtml(fw.current || asset.osVersion || "unknown"))
      + line("Upgrade to", '<strong>' + escapeHtml(toVersion) + '</strong>' + (img && img.platform ? ' (' + escapeHtml(img.platform) + ')' : ''))
      + (img ? line("Image", '<span class="mono" style="word-break:break-all;">' + escapeHtml(img.filename || "") + '</span>') : '')
      + (cred ? line("Login", escapeHtml(cred.credentialName)) : '')
      + '<p style="margin:12px 0 0;color:var(--md-on-surface-variant);font-size:14px;line-height:20px;">'
      + (asset.assetType === "firewall"
        ? 'The FortiGate reboots and is unreachable for several minutes — everything behind it goes with it. Polaris does not check Fortinet’s supported upgrade path. '
        : 'The device reboots and is unreachable for a few minutes. ')
      + 'Polaris holds its alerts, and the alerts of everything behind it, while it works. Do not power-cycle it while it is flashing.</p>'
      + schedule
      + '<div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px;">'
      + '  <button id="fw-confirm-cancel" class="btn btn-outlined">Cancel</button>'
      + '  <button id="fw-confirm-ok" class="btn btn-filled">' + (existing ? "Save" : (mode === "schedule-only" ? "Schedule" : "Upgrade")) + '</button>'
      + '</div>';
  }

  // The sheet — a stacked .sheet at 1010/1011, the shape of confirmClear in
  // mobile/alerts.js. Resolves { now: true }, { schedule: { scheduledFor,
  // notifyEmails } }, or false on Cancel / scrim / close / the asset sheet
  // being dismissed underneath it.
  var _fwConfirmResolve = null;
  function confirmFirmwareUpgrade(asset, fw, opts) {
    closeFirmwareConfirm(false);
    opts = opts || {};
    return new Promise(function (resolve) {
      _fwConfirmResolve = resolve;
      var scrim = document.createElement("div");
      scrim.className = "scrim";
      scrim.id = "fw-confirm-scrim";
      scrim.style.zIndex = "1010";
      var sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.id = "fw-confirm-sheet";
      sheet.style.zIndex = "1011";
      sheet.innerHTML = fwConfirmBodyHtml(asset, fw, opts);
      document.body.appendChild(scrim);
      document.body.appendChild(sheet);
      var later = sheet.querySelector("#fw-confirm-schedule");
      var fields = sheet.querySelector("#fw-sched-fields");
      var ok = sheet.querySelector("#fw-confirm-ok");
      var whenEl = sheet.querySelector("#fw-sched-when");
      var emailsEl = sheet.querySelector("#fw-sched-emails");
      function scheduling() { return opts.mode === "change" || !!(later && later.checked); }
      function sync() {
        if (later && fields) fields.style.display = later.checked ? "" : "none";
        if (!opts.existing) ok.textContent = scheduling() ? "Schedule" : "Upgrade";
        ok.disabled = scheduling() && !(whenEl && whenEl.value && emailsEl && fwParseEmails(emailsEl.value).length > 0);
      }
      if (later) later.addEventListener("change", sync);
      if (whenEl) whenEl.addEventListener("input", sync);
      if (emailsEl) emailsEl.addEventListener("input", sync);
      scrim.addEventListener("click", function () { closeFirmwareConfirm(false); });
      sheet.querySelector("#fw-confirm-cancel").addEventListener("click", function () { closeFirmwareConfirm(false); });
      ok.addEventListener("click", function () {
        if (!scheduling()) { closeFirmwareConfirm({ now: true }); return; }
        var when = new Date(whenEl.value); // datetime-local parses as the phone's local time
        if (isNaN(when.getTime())) { PolarisTabs.showSnackbar("Pick a date and time", { error: true }); return; }
        closeFirmwareConfirm({ schedule: { scheduledFor: when.toISOString(), notifyEmails: fwParseEmails(emailsEl.value) } });
      });
      PolarisTabs.attachSwipeToDismiss(sheet, function () { closeFirmwareConfirm(false); });
      sync();
    });
  }

  function fwRunningHtml(run) {
    return '<div id="asset-fw-progress" style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13px;color:var(--md-warning);">'
      + '<div class="spinner" style="width:14px;height:14px;border-width:2px;flex-shrink:0;"></div>'
      + '<span id="asset-fw-progress-text">' + escapeHtml(fwProgressText(run)) + '</span></div>';
  }

  function fwResultHtml(run) {
    if (!run) return "";
    if (run.status === "succeeded") {
      return '<div style="font-size:13px;margin-top:6px;color:var(--md-success);">Upgraded to ' + escapeHtml(run.verifiedVersion || run.toVersion) + '</div>';
    }
    if (run.status === "unverified") {
      return '<div style="font-size:13px;margin-top:6px;color:var(--md-warning);">The device came back but its version couldn’t be confirmed — check it</div>';
    }
    return '<div style="font-size:13px;margin-top:6px;color:var(--md-error);">Upgrade failed' + (run.error ? ': ' + escapeHtml(run.error) : '') + '</div>';
  }

  function closeFirmwareConfirm(val) {
    var s = document.getElementById("fw-confirm-sheet");
    var sc = document.getElementById("fw-confirm-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
    var r = _fwConfirmResolve;
    _fwConfirmResolve = null;
    if (r) r(val);
  }

  // Poll one run until it ends, repainting the row. Stops when the sheet is
  // dismissed or swaps to another asset; a network hiccup backs off and
  // tries again rather than giving up on a flash that is still running.
  function watchFirmwareRun(assetId, runId) {
    if (_fwPoll && _fwPoll.assetId === assetId && _fwPoll.runId === runId) return;
    stopFirmwarePoll();
    var me = { assetId: assetId, runId: runId, timer: null };
    _fwPoll = me;
    function tick() {
      if (_fwPoll !== me || _openId !== assetId) return;
      api.assets.firmwareUpgradeRun(assetId, runId).then(function (res) {
        if (_fwPoll !== me || _openId !== assetId) return;
        var run = res && res.run;
        var slot = document.getElementById("asset-fw-slot");
        if (run && (run.status === "queued" || run.status === "running")) {
          var t = document.getElementById("asset-fw-progress-text");
          if (t) t.textContent = fwProgressText(run);
          else if (slot) slot.innerHTML = fwRunningHtml(run);
          me.timer = setTimeout(tick, FW_POLL_MS);
          return;
        }
        _fwPoll = null;
        if (slot) slot.innerHTML = fwResultHtml(run);
        if (run && run.status === "succeeded") PolarisTabs.showSnackbar("Firmware upgraded to " + (run.verifiedVersion || run.toVersion));
        else if (run) PolarisTabs.showSnackbar(run.status === "unverified" ? "Upgrade finished, version unconfirmed" : "Firmware upgrade failed", { error: true });
      }).catch(function () {
        if (_fwPoll !== me) return;
        me.timer = setTimeout(tick, FW_POLL_MS * 2);
      });
    }
    me.timer = setTimeout(tick, FW_POLL_MS);
  }

  function stopFirmwarePoll() {
    if (_fwPoll && _fwPoll.timer) clearTimeout(_fwPoll.timer);
    _fwPoll = null;
  }

  // ─── Uptime + Reboot (business rule 115) ────────────────────────────────
  // General's Uptime row carries the Reboot verb — the desktop Status row's
  // Reboot… button, cut down to a phone: the server decides what may reboot
  // the device (a credential's or integration's Allow reboots, an agent
  // host's opt-in) and says why not; this row only shows it. Reboot now or
  // "Schedule for later" in one stacked confirm sheet (never window.confirm —
  // canon-mobile), a pending booking sits on the row with Change / Cancel, and
  // a live run is polled until it ends. Pressing it is assets:write
  // (canFlashFirmware — the same grant as a flash).
  var RB_POLL_MS = 5000;
  /** States a booking can still be made from — every gate is taken again when it fires. */
  var RB_SCHEDULABLE = { available: true, blocked: true, "agent-offline": true };
  var RB_ACTIVE = { queued: true, sending: true, rebooting: true };
  var _rbPoll = null;   // { assetId, runId, timer } while a reboot is being watched

  /** "12d 4h", "3h 20m", "<1m" — the desktop formatUptime. Pure. */
  function formatUptimeShort(seconds) {
    if (seconds == null || !isFinite(seconds) || seconds < 0) return "—";
    var s = Math.floor(seconds);
    if (s < 60) return "<1m";
    var days = Math.floor(s / 86400);
    var hours = Math.floor((s % 86400) / 3600);
    var mins = Math.floor((s % 3600) / 60);
    if (days > 0) return hours > 0 ? days + "d " + hours + "h" : days + "d";
    if (hours > 0) return mins > 0 ? hours + "h " + mins + "m" : hours + "h";
    return mins + "m";
  }

  /**
   * The device's uptime NOW: the last reading plus the time since it was
   * taken — frozen while the device is down, since a dead box's uptime does
   * not climb (the desktop System tab's rule). null when no transport reports
   * one. Pure.
   */
  function uptimeSecondsNow(asset, now) {
    if (!asset || asset.lastUptimeSec == null || !asset.lastMonitorAt) return null;
    var observed = Number(asset.lastUptimeSec);
    var at = new Date(asset.lastMonitorAt).getTime();
    if (!isFinite(observed) || !isFinite(at)) return null;
    if (asset.monitorStatus === "down") return observed;
    return observed + Math.max(0, Math.floor(((now == null ? Date.now() : now) - at) / 1000));
  }

  /** The Uptime row's value: the figure and "since", plus the slot the reboot loader fills. Pure. */
  function uptimeRowValue(asset, now) {
    var secs = uptimeSecondsNow(asset, now);
    var text;
    if (secs == null) {
      text = '<span class="muted" id="asset-uptime-text" data-has-uptime="0">—</span>';
    } else {
      var at = new Date(asset.lastMonitorAt).getTime();
      var sinceMs = asset.lastRebootAt ? new Date(asset.lastRebootAt).getTime() : (at - Number(asset.lastUptimeSec) * 1000);
      var since = new Date(sinceMs).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
      text = '<span id="asset-uptime-text" data-has-uptime="1">' + escapeHtml(formatUptimeShort(secs)) + '</span>'
        + ' <span class="muted">· since ' + escapeHtml(since) + '</span>';
    }
    return text + '<div id="asset-reboot-slot" class="asset-fw-slot"></div>';
  }

  /** What the reboot slot shows for an availability answer. Pure, for the tests. */
  function rbSlotHtml(rb) {
    if (!rb || rb.error || rb.state === "unsupported") return "";
    if (rb.activeRun) return rbRunningHtml(rb.activeRun);
    var out = "";
    var canAct = canFlashFirmware();
    var schedulable = !!RB_SCHEDULABLE[rb.state];
    if (!rb.schedule) {
      if (!canAct) {
        if (rb.available) out += '<div class="muted" style="font-size:12px;margin-top:4px;">Rebooting needs Read-Write on Assets</div>';
      } else if (rb.available || schedulable) {
        out += '<button class="btn btn-tonal" id="asset-reboot-btn" style="margin-top:6px;">' + (rb.available ? "Reboot…" : "Schedule reboot…") + '</button>';
        if (!rb.available) out += '<div class="muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(rb.reason || "Not right now.") + ' It can be scheduled for later.</div>';
      } else {
        out += '<div class="muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(rb.reason || "This device cannot be rebooted from Polaris.") + '</div>';
      }
    } else {
      if (canAct && rb.available) out += '<button class="btn btn-tonal" id="asset-reboot-btn" style="margin-top:6px;">Reboot now…</button>';
      out += rbScheduleLineHtml(rb.schedule);
    }
    return out;
  }

  function rbScheduleLineHtml(sched) {
    return '<div id="asset-reboot-schedule" style="margin-top:6px;font-size:13px;">'
      + '<div><strong>Reboot scheduled:</strong> ' + escapeHtml(fwWhenText(sched.scheduledFor)) + '</div>'
      + '<div class="muted" style="font-size:12px;">Results to ' + escapeHtml((sched.notifyEmails || []).join(", ")) + '</div>'
      + (sched.error ? '<div style="font-size:12px;color:var(--md-warning);">Waiting: ' + escapeHtml(sched.error) + '</div>' : '')
      + (canFlashFirmware()
        ? '<div style="display:flex;gap:8px;margin-top:6px;">'
          + '<button class="btn btn-outlined" id="asset-reboot-sched-change">Change</button>'
          + '<button class="btn btn-outlined" id="asset-reboot-sched-cancel">Cancel</button></div>'
        : '')
      + '</div>';
  }

  function rbRunningHtml(run) {
    var stage = run && (run.stage || run.status);
    var label = stage === "down" ? "Rebooting — device is down"
      : stage === "recovering" ? "Back up — waiting for monitoring to answer"
      : stage === "sending" || stage === "queued" ? "Sending the reboot"
      : "Rebooting";
    return '<div id="asset-reboot-progress" style="display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13px;color:var(--md-warning);">'
      + '<div class="spinner" style="width:14px;height:14px;border-width:2px;flex-shrink:0;"></div>'
      + '<span id="asset-reboot-progress-text">' + escapeHtml(label) + '</span></div>';
  }

  function rbResultHtml(run) {
    if (!run) return "";
    if (run.status === "succeeded") return '<div style="font-size:13px;margin-top:6px;color:var(--md-success);">Rebooted</div>';
    if (run.status === "unverified") return '<div style="font-size:13px;margin-top:6px;color:var(--md-warning);">Reboot sent, but Polaris could not confirm it happened — check the device</div>';
    return '<div style="font-size:13px;margin-top:6px;color:var(--md-error);">Reboot failed' + (run.error ? ': ' + escapeHtml(run.error) : '') + '</div>';
  }

  function loadRebootRow(id, asset) {
    if (!api.assets.reboot) return;
    api.assets.reboot(id).then(function (rb) {
      if (_openId !== id) return;
      paintRebootSlot(asset, rb);
    }).catch(function () { dropEmptyUptimeRow(); });
  }

  /** The row was rendered only to host the verb: with no uptime and nothing to reboot, it goes. */
  function dropEmptyUptimeRow() {
    var t = document.getElementById("asset-uptime-text");
    if (!t || t.getAttribute("data-has-uptime") === "1") return;
    var rowEl = t.closest(".kv-row");
    if (rowEl) rowEl.remove();
  }

  function paintRebootSlot(asset, rb) {
    var slot = document.getElementById("asset-reboot-slot");
    if (!slot) return;
    slot.innerHTML = rbSlotHtml(rb);
    if (!slot.innerHTML) { dropEmptyUptimeRow(); return; }
    var btn = document.getElementById("asset-reboot-btn");
    if (btn) btn.addEventListener("click", function () { startRebootFlow(asset, rb, btn, null); });
    var change = document.getElementById("asset-reboot-sched-change");
    if (change && rb.schedule) change.addEventListener("click", function () { startRebootFlow(asset, rb, change, rb.schedule); });
    var cancel = document.getElementById("asset-reboot-sched-cancel");
    if (cancel && rb.schedule) cancel.addEventListener("click", function () { cancelRebootSchedule(asset, rb.schedule, cancel); });
    if (rb.activeRun) watchRebootRun(asset.id, rb.activeRun.id);
  }

  function startRebootFlow(asset, rb, btn, existing) {
    var mode = existing ? "change" : (!rb.available ? "schedule-only" : (rb.schedule ? "now-only" : "choose"));
    var defaultsP = (mode === "choose" || mode === "schedule-only") && api.assets.rebootScheduleDefaults
      ? api.assets.rebootScheduleDefaults(asset.id).catch(function () { return null; })
      : Promise.resolve(null);
    defaultsP.then(function (defaults) {
      return confirmReboot(asset, rb, { mode: mode, existing: existing, defaults: defaults });
    }).then(function (choice) {
      if (!choice || _openId !== asset.id) return;
      btn.disabled = true;
      if (choice.schedule) {
        var body = { scheduledFor: choice.schedule.scheduledFor, notifyEmails: choice.schedule.notifyEmails, note: choice.note || null };
        var call = existing ? api.assets.updateRebootSchedule(asset.id, existing.id, body) : api.assets.scheduleReboot(asset.id, body);
        call.then(function () {
          if (_openId !== asset.id) return;
          PolarisTabs.showSnackbar(existing ? "Scheduled reboot changed" : "Reboot scheduled for " + new Date(body.scheduledFor).toLocaleString());
          loadRebootRow(asset.id, asset);
        }).catch(function (err) {
          btn.disabled = false;
          PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not save the schedule", { error: true });
        });
        return;
      }
      api.assets.startReboot(asset.id, choice.note ? { note: choice.note } : {}).then(function (res) {
        if (_openId !== asset.id) return;
        PolarisTabs.showSnackbar("Reboot sent — Polaris is watching for the device to come back");
        var slot = document.getElementById("asset-reboot-slot");
        if (slot) slot.innerHTML = rbRunningHtml(res && res.run);
        if (res && res.run) watchRebootRun(asset.id, res.run.id);
      }).catch(function (err) {
        btn.disabled = false;
        PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not start the reboot", { error: true });
      });
    });
  }

  function cancelRebootSchedule(asset, sched, btn) {
    btn.disabled = true;
    api.assets.cancelRebootSchedule(asset.id, sched.id).then(function () {
      PolarisTabs.showSnackbar("Scheduled reboot cancelled");
      if (_openId === asset.id) loadRebootRow(asset.id, asset);
    }).catch(function (err) {
      btn.disabled = false;
      PolarisTabs.showSnackbar(err && err.message ? err.message : "Could not cancel the scheduled reboot", { error: true });
    });
  }

  /**
   * The sheet's body. Pure, for the tests. `opts.mode`: "choose" (reboot now,
   * or tick "Schedule for later"), "schedule-only" (cannot reboot right now —
   * the box is ticked and locked), "change" (a booking's time and
   * recipients), "now-only" (a booking already exists).
   */
  function rbConfirmBodyHtml(asset, rb, opts) {
    opts = opts || {};
    var mode = opts.mode || "choose";
    var existing = opts.existing || null;
    function line(k, v) {
      return '<div class="kv-row"><span class="k">' + escapeHtml(k) + '</span><span class="v">' + v + '</span></div>';
    }
    var how = {
      "controller-switch": "Through its FortiGate " + ((rb.via && rb.via.label) || ""),
      "controller-ap": "Through its FortiGate " + ((rb.via && rb.via.label) || ""),
      "fortigate-rest": "The FortiGate's REST API",
      "fortigate-ssh": "The FortiGate's SSH CLI",
      "device-ssh": "The device's own SSH CLI",
      agent: "The Polaris Agent",
    }[rb.method] || "—";
    var warning = rb.kind === "agent"
      ? "The host restarts: its services stop and anyone signed in loses unsaved work."
      : asset.assetType === "firewall"
        ? "The FortiGate restarts and is unreachable for several minutes — everything behind it goes down with it."
        : asset.assetType === "switch"
          ? "The FortiSwitch restarts — everything connected through it drops for a few minutes."
          : "The FortiAP restarts — its wireless clients disconnect for a few minutes.";
    var when = existing ? new Date(existing.scheduledFor) : (function () { var d = new Date(Date.now() + 60 * 60000); d.setMinutes(0, 0, 0); return d; })();
    var emails = existing ? (existing.notifyEmails || []) : ((opts.defaults && opts.defaults.notifyEmails) || []);
    var fields = ''
      + (mode === "schedule-only" && rb.reason ? '<p style="margin:0 0 8px;font-size:13px;color:var(--md-warning);">Right now: ' + escapeHtml(rb.reason) + ' That is checked again when it is due.</p>' : '')
      + '<label style="display:block;font-size:13px;margin-bottom:4px;" for="rb-sched-when">Reboot at (your time)</label>'
      + '<input type="datetime-local" id="rb-sched-when" class="input" style="width:100%;" min="' + escapeHtml(fwLocalInputValue(new Date(Date.now() + 2 * 60000))) + '" value="' + escapeHtml(fwLocalInputValue(when)) + '">'
      + '<label style="display:block;font-size:13px;margin:10px 0 4px;" for="rb-sched-emails">Email the results to</label>'
      + '<input type="email" id="rb-sched-emails" class="input" style="width:100%;" multiple placeholder="you@example.com" value="' + escapeHtml(emails.join(", ")) + '">'
      + '<p style="margin:6px 0 0;font-size:12px;color:var(--md-on-surface-variant);">Not sent if Polaris only gets to it more than 15 minutes late.</p>';
    var schedule;
    if (mode === "change") {
      schedule = '<div id="rb-sched-fields" style="margin-top:12px;">' + fields + '</div>';
    } else if (mode === "now-only") {
      schedule = '<p style="margin:12px 0 0;font-size:13px;color:var(--md-on-surface-variant);">A reboot is already scheduled — change or cancel it from the Uptime row.</p>';
    } else {
      var locked = mode === "schedule-only";
      schedule = '<label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:14px;">'
        + '<input type="checkbox" id="rb-confirm-schedule"' + (locked ? ' checked disabled' : '') + '> Schedule for later</label>'
        + '<div id="rb-sched-fields" style="margin-top:8px;' + (locked ? '' : 'display:none;') + '">' + fields + '</div>';
    }
    var ack = mode === "change" ? '' : '<label style="display:flex;gap:8px;align-items:center;margin-top:12px;font-size:14px;">'
      + '<input type="checkbox" id="rb-confirm-ack"> I understand this device will go down</label>';
    // Why (business rule 115(d)); required while rb.noteRequired.
    var note = '<label style="display:block;font-size:13px;margin:12px 0 4px;" for="rb-note">Reason'
      + (rb.noteRequired ? ' <span style="color:var(--md-error);">*</span>' : ' <span style="color:var(--md-on-surface-variant);">(optional)</span>') + '</label>'
      + '<input type="text" id="rb-note" class="input" style="width:100%;" maxlength="500" placeholder="Why is this device being rebooted?" value="' + escapeHtml((existing && existing.note) || "") + '">';
    return ''
      + '<div class="sheet-handle"></div>'
      + '<h3 class="sheet-title" style="margin:0 0 8px;">' + (existing ? "Change scheduled reboot" : "Reboot device?") + '</h3>'
      + line("Device", escapeHtml(asset.hostname || asset.ipAddress || asset.id))
      + (asset.serialNumber ? line("Serial", '<span class="mono">' + escapeHtml(asset.serialNumber) + '</span>') : '')
      + line("Sent by", escapeHtml(how))
      + line("Signed by", escapeHtml(rb.authority || "—"))
      + (mode === "change" ? '' : '<p style="margin:12px 0 0;color:var(--md-on-surface-variant);font-size:14px;line-height:20px;">' + escapeHtml(warning)
        + ' Polaris holds its alerts while it reboots and records the reboot on its Events.</p>')
      + note
      + ack
      + schedule
      + '<div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px;">'
      + '  <button id="rb-confirm-cancel" class="btn btn-outlined">Cancel</button>'
      + '  <button id="rb-confirm-ok" class="btn btn-filled">' + (existing ? "Save" : (mode === "schedule-only" ? "Schedule" : "Reboot")) + '</button>'
      + '</div>';
  }

  // A stacked .sheet at 1010/1011 — the firmware confirm's shape. Resolves
  // { now: true, note }, { schedule: { scheduledFor, notifyEmails }, note }, or false.
  var _rbConfirmResolve = null;
  function confirmReboot(asset, rb, opts) {
    closeRebootConfirm(false);
    opts = opts || {};
    return new Promise(function (resolve) {
      _rbConfirmResolve = resolve;
      var scrim = document.createElement("div");
      scrim.className = "scrim";
      scrim.id = "rb-confirm-scrim";
      scrim.style.zIndex = "1010";
      var sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.id = "rb-confirm-sheet";
      sheet.style.zIndex = "1011";
      sheet.innerHTML = rbConfirmBodyHtml(asset, rb, opts);
      document.body.appendChild(scrim);
      document.body.appendChild(sheet);
      var later = sheet.querySelector("#rb-confirm-schedule");
      var ack = sheet.querySelector("#rb-confirm-ack");
      var fields = sheet.querySelector("#rb-sched-fields");
      var ok = sheet.querySelector("#rb-confirm-ok");
      var whenEl = sheet.querySelector("#rb-sched-when");
      var emailsEl = sheet.querySelector("#rb-sched-emails");
      var noteEl = sheet.querySelector("#rb-note");
      function noteValue() { return noteEl ? noteEl.value.trim() : ""; }
      function scheduling() { return opts.mode === "change" || !!(later && later.checked); }
      function sync() {
        if (later && fields) fields.style.display = later.checked ? "" : "none";
        if (!opts.existing) ok.textContent = scheduling() ? "Schedule" : "Reboot";
        var acked = (!ack || ack.checked) && (!rb.noteRequired || noteValue() !== "");
        ok.disabled = !acked || (scheduling() && !(whenEl && whenEl.value && emailsEl && fwParseEmails(emailsEl.value).length > 0));
      }
      [later, ack].forEach(function (el) { if (el) el.addEventListener("change", sync); });
      [whenEl, emailsEl, noteEl].forEach(function (el) { if (el) el.addEventListener("input", sync); });
      scrim.addEventListener("click", function () { closeRebootConfirm(false); });
      sheet.querySelector("#rb-confirm-cancel").addEventListener("click", function () { closeRebootConfirm(false); });
      ok.addEventListener("click", function () {
        if (!scheduling()) { closeRebootConfirm({ now: true, note: noteValue() }); return; }
        var when = new Date(whenEl.value);
        if (isNaN(when.getTime())) { PolarisTabs.showSnackbar("Pick a date and time", { error: true }); return; }
        closeRebootConfirm({ schedule: { scheduledFor: when.toISOString(), notifyEmails: fwParseEmails(emailsEl.value) }, note: noteValue() });
      });
      PolarisTabs.attachSwipeToDismiss(sheet, function () { closeRebootConfirm(false); });
      sync();
    });
  }

  function closeRebootConfirm(val) {
    var s = document.getElementById("rb-confirm-sheet");
    var sc = document.getElementById("rb-confirm-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
    var r = _rbConfirmResolve;
    _rbConfirmResolve = null;
    if (r) r(val);
  }

  // Poll one run until it ends, repainting the row; stops when the sheet is
  // dismissed or swaps to another asset; a network hiccup backs off.
  function watchRebootRun(assetId, runId) {
    if (_rbPoll && _rbPoll.assetId === assetId && _rbPoll.runId === runId) return;
    stopRebootPoll();
    var me = { assetId: assetId, runId: runId, timer: null };
    _rbPoll = me;
    function tick() {
      if (_rbPoll !== me || _openId !== assetId) return;
      api.assets.rebootRun(assetId, runId).then(function (res) {
        if (_rbPoll !== me || _openId !== assetId) return;
        var run = res && res.run;
        var slot = document.getElementById("asset-reboot-slot");
        if (run && RB_ACTIVE[run.status]) {
          if (slot) slot.innerHTML = rbRunningHtml(run);
          me.timer = setTimeout(tick, RB_POLL_MS);
          return;
        }
        _rbPoll = null;
        if (slot) slot.innerHTML = rbResultHtml(run);
        if (run && run.status === "succeeded") PolarisTabs.showSnackbar("Device rebooted");
        else if (run) PolarisTabs.showSnackbar(run.status === "unverified" ? "Reboot sent, but not confirmed" : "Reboot failed", { error: true });
      }).catch(function () {
        if (_rbPoll !== me) return;
        me.timer = setTimeout(tick, RB_POLL_MS * 2);
      });
    }
    me.timer = setTimeout(tick, RB_POLL_MS);
  }

  function stopRebootPoll() {
    if (_rbPoll && _rbPoll.timer) clearTimeout(_rbPoll.timer);
    _rbPoll = null;
  }

  // ─── helpers ───────────────────────────────────────────────────────────
  function monitorDotCls(asset) {
    if (!asset.monitored) return "";
    // A maintenance window outranks everything — polling is paused, so the
    // stored probe state is frozen at whatever it read when the window opened.
    // Matches desktop assetMonitorBadge.
    if (asset.status === "maintenance") return "maint";
    // Suppression outranks the probe state — matches desktop assetMonitorBadge.
    if (asset.dependencySuppressed) return "dep-down";
    switch (asset.monitorStatus) {
      case "up": return "up";
      case "down": return "down";
      case "warning": return "warn";
      case "recovering": return "recovering";
      case "unknown": return "unk";
      case "passive": return "passive";
      default: return "unk";
    }
  }

  function renderMonitorPill(asset) {
    if (!asset.monitored) {
      // HA standby FortiGate — unmonitored by design (the cluster IP routes
      // to the active member); health rides the HA roster each discovery
      // cycle. Mirrors the desktop assetMonitorBadge standby branch.
      var topo = asset.fortinetTopology;
      if (topo && typeof topo === "object" && topo.haRole === "secondary") {
        if (topo.haMemberStatus === "down") {
          return '<span class="status-pill down"><span class="dot down"></span>Standby Down</span>';
        }
        return '<span class="status-pill unk"><span class="dot unk"></span>HA Standby</span>';
      }
      return '<span class="status-pill unk">Unmonitored</span>';
    }
    // In a maintenance window every server-driven poll is paused, so the
    // five-state label would be a reading from before the window opened.
    if (asset.status === "maintenance") {
      return '<span class="status-pill maint"><span class="dot maint"></span>Maintenance</span>';
    }
    if (asset.dependencySuppressed) {
      var layerBit = (asset.dependencyLayer != null) ? " (Layer " + asset.dependencyLayer + ")" : "";
      return '<span class="status-pill dep-down"><span class="dot dep-down"></span>Dep. Down' + layerBit + '</span>';
    }
    var rttBit = (asset.lastResponseTimeMs != null) ? " · " + asset.lastResponseTimeMs + " ms" : "";
    switch (asset.monitorStatus) {
      case "up":      return '<span class="status-pill up"><span class="dot up"></span>Up' + rttBit + '</span>';
      case "down":    return '<span class="status-pill down"><span class="dot down"></span>Down — ' + (asset.consecutiveFailures || 0) + ' consecutive fails</span>';
      // Missed / Recovering used to fall through to the generic "Monitored",
      // which hid the two states an operator most wants on a phone: a poll has
      // started failing, or the device is answering again but not yet Up.
      case "warning":    return '<span class="status-pill warn"><span class="dot warn"></span>Missed — ' +
        (asset.consecutiveFailures || 0) + ' missed poll(s)</span>';
      case "recovering": return '<span class="status-pill recovering"><span class="dot recovering"></span>Recovering' + rttBit + '</span>';
      case "unknown": return '<span class="status-pill unk"><span class="dot unk"></span>No samples yet</span>';
      // Passive keeps SOME reachability signal in the label — the counter is
      // still advancing, and "Passive" alone would read as "not looked at".
      case "passive": return '<span class="status-pill passive"><span class="dot passive"></span>Passive — ' +
        ((asset.consecutiveFailures || 0) === 0 ? 'last poll ok' : (asset.consecutiveFailures + ' consecutive fails')) + '</span>';
      default:        return '<span class="status-pill unk"><span class="dot unk"></span>Monitored</span>';
    }
  }

  function monitorPillSubtext(asset) {
    if (!asset.monitored) {
      // HA standby — say why there's no monitoring (desktop System tab has
      // the long-form explanation; keep the mobile subtext one line).
      var topo = asset.fortinetTopology;
      if (topo && typeof topo === "object" && topo.haRole === "secondary") {
        return "standby firewalls are not monitored — health via the HA roster";
      }
      return "";
    }
    var bits = [];
    if (asset.status === "maintenance") {
      bits.push("monitoring paused");
      if (asset.maintenanceReturnStatus) bits.push("returns to " + asset.maintenanceReturnStatus);
      // The last poll predates the window — still worth showing, since it
      // says how long polling has been paused.
      if (asset.lastMonitorAt) bits.push("last poll " + formatTimeAgo(asset.lastMonitorAt));
      return bits.join(" · ");
    }
    if (asset.dependencySuppressed) {
      bits.push("upstream parent down");
      // The pill hides the five-state label while suppressed; keep the own-probe
      // outcome discoverable in the subtext.
      if (asset.monitorStatus) bits.push("own probe " + monitorStatusLabel(asset.monitorStatus).toLowerCase());
    }
    if (asset.responseTimePolling) bits.push(asset.responseTimePolling);
    if (asset.lastMonitorAt) bits.push("last poll " + formatTimeAgo(asset.lastMonitorAt));
    return bits.join(" · ");
  }

  // api.js timeAgo with the mobile guard for empty/unparseable timestamps.
  function formatTimeAgo(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return timeAgo(iso);
  }
  // formatDate is the shared mobileFormatDate global from api.js (local-time
  // YYYY-MM-DD). Was a UTC .toISOString().slice here — local is the correct
  // day for the operator's "Acquired" display.
  var formatDate = mobileFormatDate;

  // escapeHtml is the canonical global from api.js (loaded first on every page).

  // Pull-to-refresh — the same sheet reload as the header Refresh button
  // (reloadSheet; no device poll). Returns the promise so the PTR puck spins
  // until the row lands. The route carries the id on a #asset/<id> deep link;
  // a sheet opened in-app has none, so fall back to the open one.
  function refreshFromPtr(ctx) {
    var cur = currentPage();
    if (cur && cur.kind !== "asset") { refreshPage(null); return Promise.resolve(); }
    var id = (ctx && ctx.route && ctx.route.parts && ctx.route.parts[0]) || _openId;
    if (!id) return null;
    return reloadSheet(id, null);
  }

  window.PolarisAssetDetail = {
    open: open,
    historyBack: historyBack,
    // Another asset's name as a link that opens its sheet (see onAssetLinkClick).
    linkHtml: linkHtml,
    // Pure firmware-row pieces, for the tests.
    _fw: { fwProgressText: fwProgressText, fwSlotHtml: fwSlotHtml, fwResultHtml: fwResultHtml, fwBadgeHtml: fwBadgeHtml },
    // Pure uptime / reboot pieces, for the tests.
    _rb: { uptimeSecondsNow: uptimeSecondsNow, formatUptime: formatUptimeShort, uptimeRowValue: uptimeRowValue, rbSlotHtml: rbSlotHtml, rbConfirmBodyHtml: rbConfirmBodyHtml },
    spec: {
      parentTab: "assets",
      // No topbar — the slide-up sheet carries its own header.
      renderTopbar: function () { return ""; },
      render: render,
      onPullToRefresh: refreshFromPtr,
    },
  };
})();
