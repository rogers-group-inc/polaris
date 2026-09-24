// public/js/mobile/asset-detail.js — Asset detail slide-up sheet.
//
// Header carries camera (screenshot — see screenshotSheet), refresh and
// close icon buttons.
//
// Sections (top to bottom):
//   - Hero with status pill + identity bits (name lives in the sheet header)
//   - Monitor section (response-time chart, status pill, RTT/last poll)
//   - Telemetry section (CPU+Memory chart, when supported)
//   - General section (IP/MAC/type/model/OS/location/last seen)
//   - Temperatures section — current per-sensor reading + 1h min/avg/max
//   - Interfaces section — operStatus=="up" only; tap a row opens a bottom
//     sheet with status / speed / ip / mac / errors / LLDP neighbor(s)
//   - Discovery sources — per-source list (sourceKind + integration + lastSeen)
//   - Firewall sightings — which FortiGates saw this asset (needs
//     assetsQuarantine read; degrades to a muted note otherwise)
//   - IP history list
//
// Hero carries the strobing "Alerts" flag when the device has live alerts —
// the same control the Assets list card shows, in the colour of the worst one,
// tapping through to the shared alerts sheet (acknowledge / clear, per role;
// PolarisMobileAlerts in mobile/alerts.js). It sits on the status pill's row
// because the two together are how this device is doing.
//
// Hero also carries a Quarantine / Release Quarantine button, gated on the
// assetsQuarantine:write permission and the same eligibility as the desktop
// quarantine tab (non-infra + has a MAC to push, or already quarantined →
// Release). See quarantineButtonHtml / wireQuarantineButton.
//
// Hero also carries a "View SD-WAN" button for FortiGate firewalls that
// reported SD-WAN data (perf-SLA links / rules / members exist). Tapping it
// slides up a second bottom sheet (stacked on the asset sheet, like the
// interface sheet) with SD-WAN Members + Rules current-state lists and a
// Performance SLA section (per-member latency / jitter / packet-loss charts
// over a selectable health-check + range). See openSdwanSheet.
//
// Below it, one current-state table button per device class — "View ARP
// Table" on a firewall, "View MAC Table" on a switch, "View Wireless" on a
// monitored access point (the desktop's ARP Table / MAC Table / Wireless
// tabs). Each opens a stacked sheet read-only: ARP with a range + filter,
// MAC grouped by port, Wireless as radio → SSID → client. A matched device in
// any of them opens that asset. See openArpSheet / openMacSheet /
// openWirelessSheet.
//
// Out of scope for v1 (desktop-only):
//   - Per-interface throughput + errors charts
//   - Per-interface comments editor
//   - IPsec tunnels
//   - SNMP walk
//   - SD-WAN rule member-selection categorical timeline (the mobile chart
//     helper is numeric-only; the SD-WAN sheet shows the current selected
//     member per rule, not its failover history)
//   - Per-source observed blob view (mobile shows the source summary, not the
//     full observed key/value table)

(function () {
  // Single shared chart range — driven by the 24h/7d segmented control on
  // the Monitor card. Telemetry chart follows the same range so both
  // sections move together when the operator switches windows.
  var DEFAULT_RANGE = "24h";
  var RANGES = ["1h", "12h", "24h", "7d", "30d"];

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
  // links) so openSdwanSheet renders the current-state lists without a
  // re-fetch. Populated by loadSdwanGate; only set when data actually exists.
  var _sdwanCache = Object.create(null);

  // Per-mount state keyed by asset id so navigating back from another tab
  // remembers which sections were collapsed and which range was active.
  var _mounts = Object.create(null);

  function mountState(id) {
    if (!_mounts[id]) {
      _mounts[id] = {
        range: DEFAULT_RANGE,
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
  // Sized to clear the full peek-band content above the bottom navbar:
  // 32px of handle area (4px line + 12+16 margins) + 64px of header (48px
  // icon-btn rows + 4+12 padding) = 96px. Anything smaller cuts into the
  // hostname row.
  var PEEK_BAND_PX = 96;
  var _state = "closed";   // "closed" | "expanded" | "peek"
  var _openId = null;      // asset id currently shown — also the loader race guard

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
      + '  <span class="dot" id="asset-sheet-dot" style="display:none;"></span>'
      + '  <div class="asset-sheet-name" id="asset-sheet-name">Asset</div>'
      + '  <button class="icon-btn" id="asset-sheet-screenshot" aria-label="Screenshot"><svg viewBox="0 0 24 24"><use href="#i-camera"/></svg></button>'
      + '  <button class="icon-btn" id="asset-sheet-refresh" aria-label="Refresh"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
      + '  <button class="icon-btn" id="asset-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div id="asset-host"></div>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    // Tapping the scrim (over the searchbar) minimizes rather than dismisses.
    scrim.addEventListener("click", minimize);
    document.getElementById("asset-sheet-close").addEventListener("click", dismiss);
    document.getElementById("asset-sheet-refresh").addEventListener("click", function () {
      if (_openId) onRefresh(_openId, this, mountState(_openId));
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
    PolarisTabs.attachSwipeToDismiss(sheet, dismiss, {
      // First swipe-down locks to peek; second swipe-down dismisses.
      onSwipeDown: function () {
        if (_state === "expanded") {
          minimize();
        } else if (_state === "peek") {
          sheet.style.transition = "transform .2s ease-out";
          sheet.style.transform = "translateY(100%)";
          setTimeout(dismiss, 180);
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
        return Math.max(0, (sheet.offsetHeight || 0) - PEEK_BAND_PX);
      },
    });
    return sheet;
  }

  function setHeader(asset) {
    var nameEl = document.getElementById("asset-sheet-name");
    if (nameEl) nameEl.textContent = asset.hostname || asset.assetTag || "Asset";
    var dotEl = document.getElementById("asset-sheet-dot");
    if (dotEl) {
      var cls = monitorDotCls(asset);
      dotEl.className = "dot" + (cls ? " " + cls : "");
      dotEl.style.display = cls ? "" : "none";
    }
    // Refresh fires probeNow, which only makes sense for monitored assets —
    // unmonitored hosts have no probe transport to run, so hide the button.
    var refreshBtn = document.getElementById("asset-sheet-refresh");
    if (refreshBtn) refreshBtn.style.display = asset.monitored ? "" : "none";
  }

  function minimize() {
    if (_state !== "expanded") return;
    var sheet = document.getElementById("asset-sheet");
    var scrim = document.getElementById("asset-sheet-scrim");
    if (!sheet) return;
    // Slide the sheet down so only its top band (handle + header) peeks above
    // the bottom navbar. The sheet is anchored at bottom: navbar-h (see CSS),
    // so translateY(offsetHeight - PEEK_BAND_PX) leaves the band exposed just
    // above the navbar; the rest of the sheet extends behind the navbar and
    // is occluded by the navbar's higher z-index. Measured from the live
    // height so short content peeks correctly too. attachSwipeToDismiss
    // clears inline transform on snap-back, which falls through to the CSS
    // translate, so peek is restored.
    var translate = Math.max(0, (sheet.offsetHeight || 0) - PEEK_BAND_PX);
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
    _state = "closed";
    // Tear down any stacked child sheets first so they don't orphan over the
    // backdrop once the asset sheet is gone.
    closeSdwanSheet();
    closeTableSheet();
    closeInterfaceSheet();
    var s = document.getElementById("asset-sheet");
    var sc = document.getElementById("asset-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

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
    function capture() { return htmlToImage.toCanvas(host, { pixelRatio: scale, backgroundColor: bg }); }

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

  // Public opener. Builds the sheet (if needed), then fetches + renders the
  // asset into it. Opening a different asset while one is shown replaces the
  // content in place (single #asset-host). Opening the same asset just
  // re-expands. `_openId` doubles as the loader race guard: a late promise
  // from a superseded asset bails because `_openId` no longer matches.
  function open(id) {
    if (!id) return;
    var sheet = ensureSheet();

    if (_openId === id && _state !== "closed") { expand(); return; }

    _openId = id;
    expandFresh(sheet);

    var st = mountState(id);
    api.assets.get(id).then(function (asset) {
      if (_openId !== id) return;
      if (!asset) throw new Error("Asset not found");
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
      wireTableButtons(id, asset);
      loadAlerts(id, asset);
    }).catch(function (err) {
      if (_openId !== id) return;
      var msg = (err && err.message) ? err.message : "Failed to load asset";
      var host = document.getElementById("asset-host");
      if (!host) return;
      host.innerHTML = ''
        + '<div class="empty-state" style="padding-top:64px;">'
        + '  <div class="icon" style="background:var(--md-error-container);color:var(--md-on-error-container);"><svg viewBox="0 0 24 24"><use href="#i-warn"/></svg></div>'
        + '  <div class="ttl">Couldn’t load asset</div>'
        + '  <div class="desc">' + escapeHtml(msg) + '</div>'
        + '</div>';
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
    var nameEl = document.getElementById("asset-sheet-name");
    if (nameEl) nameEl.textContent = "Asset";
    var dotEl = document.getElementById("asset-sheet-dot");
    if (dotEl) { dotEl.className = "dot"; dotEl.style.display = "none"; }
    var refreshBtn = document.getElementById("asset-sheet-refresh");
    if (refreshBtn) refreshBtn.style.display = "none"; // setHeader re-shows when monitored
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

    var rangeButtons = RANGES.map(function (r) {
      return '<button class="seg-item' + (r === st.range ? " on" : "") + '" data-range="' + r + '">' + r + '</button>';
    }).join("");

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
      // SD-WAN entry button — hidden until loadSdwanGate confirms this
      // FortiGate firewall actually reported SD-WAN data, then revealed +
      // wired to openSdwanSheet.
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
      + sectionHeader("monitor", "Response Time", escapeHtml(monitorPillSubtext(asset)), st.sections.monitor, "asset-monitor-sub")
      + '<div class="sect-body" data-sect="monitor"' + (st.sections.monitor ? '' : ' hidden') + '>'
      + '  <div class="card-filled" style="padding:16px;margin-bottom:8px;">'
      + '    <div class="seg" id="asset-range-seg" style="display:inline-flex;border:1px solid var(--md-outline);border-radius:var(--shape-full);overflow:hidden;margin-bottom:8px;">' + rangeButtons + '</div>'
      + '    <div id="asset-monitor-chart" style="min-height:120px;"></div>'
      + '  </div>'
      + '</div>'

      // CPU + Memory section — collapsed by default; subtitle shows
      // cpu/mem avg/max once the loader returns.
      + sectionHeader("telemetry", "CPU + Memory", "", st.sections.telemetry, "asset-telemetry-sub")
      + '<div class="sect-body" data-sect="telemetry"' + (st.sections.telemetry ? '' : ' hidden') + '>'
      + '  <div class="card-filled" style="padding:16px;margin-bottom:8px;">'
      + '    <div id="asset-telemetry-chart" style="min-height:120px;"></div>'
      + '  </div>'
      + '</div>'

      // General section
      + sectionHeader("general", "General", "", st.sections.general)
      + '<div class="sect-body" data-sect="general"' + (st.sections.general ? '' : ' hidden') + '>'
      + renderGeneralBody(asset)
      + '</div>'

      // Hardware Sensors section — populated by loadSystemInfo.
      + sectionHeader("temperatures", "Hardware Sensors", "", st.sections.temperatures)
      + '<div class="sect-body" data-sect="temperatures"' + (st.sections.temperatures ? '' : ' hidden') + '>'
      + '  <div id="asset-temperatures-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
      + '</div>'

      // Interfaces section — populated by loadSystemInfo (operStatus=="up" only).
      + sectionHeader("interfaces", "Interfaces", "", st.sections.interfaces)
      + '<div class="sect-body" data-sect="interfaces"' + (st.sections.interfaces ? '' : ' hidden') + '>'
      + '  <div id="asset-interfaces-host"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>'
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

    // Range segmented control
    var seg = document.getElementById("asset-range-seg");
    if (seg) seg.querySelectorAll(".seg-item").forEach(function (b) {
      b.addEventListener("click", function () {
        if (b.dataset.range === st.range) return;
        st.range = b.dataset.range;
        seg.querySelectorAll(".seg-item").forEach(function (x) {
          x.classList.toggle("on", x.dataset.range === st.range);
        });
        loadMonitor(asset.id, st);
        loadTelemetry(asset.id, st);
      });
    });
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
  function sectionHeader(key, title, subtitleHtml, expanded, subtitleId) {
    var subId = subtitleId ? ' id="' + subtitleId + '"' : '';
    return ''
      + '<button class="asset-sect-header" data-key="' + key + '">'
      + '  <div style="flex:1;text-align:left;min-width:0;">'
      + '    <div class="sect-title">' + escapeHtml(title) + '</div>'
      + '    <div class="sect-sub"' + subId + '>' + (subtitleHtml || "") + '</div>'
      + '  </div>'
      + '  <svg class="caret" viewBox="0 0 24 24" width="24" height="24" style="fill:var(--md-on-surface-variant);flex-shrink:0;"><use href="' + (expanded ? "#i-chev-down" : "#i-chev-right") + '"/></svg>'
      + '</button>';
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
    row("IP", asset.ipAddress ? '<span class="mono">' + escapeHtml(asset.ipAddress) + '</span>' : null);
    row("MAC", asset.macAddress ? '<span class="mono">' + escapeHtml(asset.macAddress) + '</span>' : null);
    row("Hostname", asset.hostname);
    row("DNS name", asset.dnsName);
    row("Serial", asset.serialNumber ? '<span class="mono">' + escapeHtml(asset.serialNumber) + '</span>' : null);
    row("Manufacturer", asset.manufacturer);
    row("Model", asset.model);
    row("OS", [asset.os, asset.osVersion].filter(Boolean).join(" "));
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

    api.assets.monitorHistory(id, st.range).then(function (resp) {
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
        chartHost.innerHTML = PolarisCharts.lineChart({
          // The Up green rather than the app accent, mirroring desktop: the one
          // chart about reachability speaks the same colours as the status pill.
          series: [{ values: samples, color: "var(--md-success)", fill: true }],
          height: 120,
          yUnit: "ms",
          ariaLabel: "Response time over " + st.range,
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
        sub.textContent = statBits.length ? statBits.join(" · ") : "No samples";
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

    api.assets.telemetryHistory(id, st.range).then(function (resp) {
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
        chartHost.innerHTML = PolarisCharts.lineChart({
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
          ariaLabel: "CPU and memory over " + st.range,
        });
      }
      if (sub) {
        var stats = resp.stats || {};
        var bits = [];
        if (stats.avgCpuPct != null) bits.push('<span style="color:var(--md-primary);">cpu avg ' + Math.round(stats.avgCpuPct) + "%</span>");
        if (stats.maxCpuPct != null) bits.push("max " + Math.round(stats.maxCpuPct) + "%");
        if (stats.avgMemPct != null) bits.push('<span style="color:var(--md-tertiary);">mem avg ' + Math.round(stats.avgMemPct) + "%</span>");
        if (stats.maxMemPct != null) bits.push("max " + Math.round(stats.maxMemPct) + "%");
        sub.innerHTML = bits.length ? bits.join(" · ") : "No samples";
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
    var samples = (tempHist && tempHist.samples) || [];
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
  function renderInterfaces(host, info, assetId, st, asset) {
    var ifaces = (info && info.interfaces) || [];
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
          + '  <span class="trailing muted mono" style="font-size:12px;">' + escapeHtml(speed) + '</span>'
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

    host.innerHTML = listHtml + toggleHtml;

    // Wire row taps — index into the same `visible` list rendered above.
    host.querySelectorAll(".iface-row").forEach(function (row) {
      row.addEventListener("click", function () {
        var idx = parseInt(row.dataset.ifaceIdx, 10);
        if (isNaN(idx)) return;
        openInterfaceSheet(visible[idx], info, assetId);
      });
    });

    // Wire the toggle — flips state and re-renders against the same data.
    var toggleBtn = document.getElementById("iface-show-all-btn");
    if (toggleBtn) toggleBtn.addEventListener("click", function () {
      if (st) st.interfacesShowAll = !st.interfacesShowAll;
      renderInterfaces(host, info, assetId, st, asset);
    });
  }

  // ─── Interface bottom sheet ────────────────────────────────────────────
  // Reuses the .sheet + .scrim pattern from map-tab.js for consistency.
  function openInterfaceSheet(iface, info, assetId) {
    closeInterfaceSheet();

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "iface-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "iface-sheet";

    var title = iface.alias || iface.ifName || "Interface";
    var ifSubtitle = (iface.alias && iface.ifName && iface.alias !== iface.ifName) ? iface.ifName : "";

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
    row("In errors",  iface.inErrors  != null ? String(iface.inErrors)  : null);
    row("Out errors", iface.outErrors != null ? String(iface.outErrors) : null);

    var detailRowsHtml = rows.map(function (r) {
      var v = r.mono ? '<span class="mono">' + escapeHtml(r.v) + '</span>' : escapeHtml(r.v);
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
          + '    <div style="min-width:0;font-weight:500;">' + escapeHtml(headline) + '</div>'
          + '    <div style="font-size:12px;">' + portBit + '</div>'
          + '  </div>'
          + (metaBits.length ? '  <div class="muted" style="font-size:12px;margin-top:4px;">' + metaBits.join(" · ") + '</div>' : '')
          + (n.systemDescription ? '  <div class="muted" style="font-size:12px;margin-top:4px;">' + escapeHtml(n.systemDescription) + '</div>' : '')
          + matchBtn
          + '</div>';
      }).join("");
    }

    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;">'
      + '  <div style="min-width:0;">'
      + '    <h3 class="sheet-title" style="margin:0 0 4px;">' + escapeHtml(title) + '</h3>'
      + (ifSubtitle ? '    <div class="muted mono" style="font-size:13px;">' + escapeHtml(ifSubtitle) + '</div>' : '')
      + '  </div>'
      + '  <button class="icon-btn" id="iface-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + detailRowsHtml
      + '<div style="font-weight:500;margin:16px 0 8px;">Neighbor</div>'
      + neighborHtml;

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeInterfaceSheet);
    document.getElementById("iface-sheet-close").addEventListener("click", closeInterfaceSheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeInterfaceSheet);
    sheet.querySelectorAll(".iface-neighbor-pivot").forEach(function (b) {
      b.addEventListener("click", function () {
        var nid = b.dataset.assetId;
        closeInterfaceSheet();
        if (nid) open(nid);   // replace the sheet content in place with the neighbor
      });
    });
  }

  function closeInterfaceSheet() {
    var s = document.getElementById("iface-sheet");
    var sc = document.getElementById("iface-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
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

  // ─── Alerts ──────────────────────────────────────────────────────────────
  // The hero's alert flag — the same strobing "Alerts" control the Assets list
  // card carries, for the same reason, on the screen an operator lands on
  // after tapping that card. Tapping it opens the shared alerts sheet
  // (acknowledge / clear, per role) stacked over this one.
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
      PolarisMobileAlerts.openForAsset(id, {
        hostname: (asset && (asset.hostname || asset.assetTag)) || "",
        // Settle the flag from what the sheet loaded, so acknowledging or
        // clearing from up there stops the strobe down here without a reload.
        onSummary: function (next) { paintAlertFlag(id, next, asset); },
      });
    });
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
      if (btn) btn.onclick = function () { openSdwanSheet(id); };
    }).catch(function () { /* gate is best-effort — no button on failure */ });
  }

  // Holds the open SD-WAN sheet's perf-SLA selection (health-check grouping +
  // active range) so the range segmented control can reload the charts.
  var _sdwanSheetState = null;

  // ─── SD-WAN bottom sheet ───────────────────────────────────────────────
  // Stacked on top of the asset sheet using the generic .sheet/.scrim pattern
  // (same as openInterfaceSheet). Sections: Members + Rules current-state
  // lists, then a Performance SLA section with per-member latency / jitter /
  // packet-loss charts for a selectable health-check + range.
  function openSdwanSheet(assetId) {
    closeSdwanSheet();
    var cache = _sdwanCache[assetId];
    if (!cache) return;
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

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "sdwan-sheet-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "sdwan-sheet";

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

    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:8px;">'
      + '  <h3 class="sheet-title" style="margin:0;">SD-WAN</h3>'
      + '  <button class="icon-btn" id="sdwan-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + sections;

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeSdwanSheet);
    document.getElementById("sdwan-sheet-close").addEventListener("click", closeSdwanSheet);
    PolarisTabs.attachSwipeToDismiss(sheet, closeSdwanSheet);

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

  function closeSdwanSheet() {
    _sdwanSheetState = null;
    var s = document.getElementById("sdwan-sheet");
    var sc = document.getElementById("sdwan-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
  }

  // Members list — status dot + member name (+ zone), IP / link / speed, and
  // per-health-check chips with current latency.
  function renderSdwanMembersList(members) {
    return members.map(function (m, i) {
      var up = m.state === "up";
      var sub = [];
      if (m.ip) sub.push('<span class="mono">' + escapeHtml(m.ip) + '</span>');
      if (m.zone) sub.push(escapeHtml(m.zone));
      if (m.linkUp != null) sub.push(m.linkUp ? ("link up" + (m.linkSpeedBps ? " · " + escapeHtml(formatBps(m.linkSpeedBps)) : "")) : "link down");
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

    Promise.all(members.map(function (m) {
      return api.assets.perfSlaHistory(assetId, m.healthCheck, m.link, { range: range })
        .then(function (data) { return { link: m.link, samples: (data && data.samples) || [] }; })
        .catch(function () { return { link: m.link, samples: [] }; });
    })).then(function (results) {
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
        host.innerHTML = PolarisCharts.lineChart({
          series: series,
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
        var total = results.reduce(function (n, r) { return n + r.samples.length; }, 0);
        if (!total) {
          statsEl.textContent = "No samples in this window.";
        } else {
          function avg(key) {
            var vals = [];
            results.forEach(function (r) { r.samples.forEach(function (s) { if (typeof s[key] === "number") vals.push(s[key]); }); });
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
    { key: "arp",      label: "View ARP Table", icon: "i-list",        applies: function (a) { return a.assetType === "firewall"; } },
    { key: "mac",      label: "View MAC Table", icon: "i-switch-icon", applies: function (a) { return a.assetType === "switch"; } },
    { key: "wireless", label: "View Wireless",  icon: "i-wifi",        applies: function (a) { return a.assetType === "access_point" && !!a.monitored; } },
  ];

  function tableButtonsHtml(asset) {
    return TABLE_BUTTONS.filter(function (b) { return b.applies(asset); }).map(function (b) {
      return ''
        + '  <div style="margin-top:12px;">'
        + '    <button class="btn btn-tonal btn-block" id="asset-' + b.key + '-btn"><svg viewBox="0 0 24 24"><use href="#' + b.icon + '"/></svg>' + escapeHtml(b.label) + '</button>'
        + '  </div>';
    }).join("");
  }

  function wireTableButtons(id, asset) {
    var openers = { arp: openArpSheet, mac: openMacSheet, wireless: openWirelessSheet };
    TABLE_BUTTONS.forEach(function (b) {
      var btn = document.getElementById("asset-" + b.key + "-btn");
      if (btn) btn.onclick = function () { openers[b.key](id, asset); };
    });
  }

  // The open table sheet: which asset + which table, and a token bumped on
  // every (re)load so a late response for a closed or re-ranged sheet bails.
  var _tableSheet = null;

  // Shared shell — the generic stacked .sheet (same shape as openSdwanSheet):
  // handle, title row with a Reload + Close button, a controls slot, a
  // freshness/count line and the body the loader renders into.
  function openTableSheet(key, assetId, title, onReload) {
    closeTableSheet();
    _tableSheet = { key: key, assetId: assetId, token: 0 };

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "table-sheet-scrim";
    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "table-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;align-items:center;gap:4px;margin-bottom:8px;">'
      + '  <h3 class="sheet-title" style="margin:0;flex:1;min-width:0;">' + escapeHtml(title) + '</h3>'
      + '  <button class="icon-btn" id="table-sheet-reload" aria-label="Reload"><svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg></button>'
      + '  <button class="icon-btn" id="table-sheet-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div id="table-sheet-controls"></div>'
      + '<div id="table-sheet-meta" class="muted" style="font-size:12px;margin-bottom:8px;"></div>'
      + '<div id="table-sheet-body"><div class="loading-screen" style="padding:24px 0;"><div class="spinner"></div></div></div>';
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);

    scrim.addEventListener("click", closeTableSheet);
    document.getElementById("table-sheet-close").addEventListener("click", closeTableSheet);
    document.getElementById("table-sheet-reload").addEventListener("click", onReload);
    PolarisTabs.attachSwipeToDismiss(sheet, closeTableSheet);

    // One delegated listener for the whole body: group headers expand and
    // collapse in place, and a matched device swaps the asset sheet to it.
    sheet.addEventListener("click", function (e) {
      var link = e.target.closest("[data-open-asset]");
      if (link) {
        e.preventDefault();
        var target = link.getAttribute("data-open-asset");
        closeTableSheet();
        open(target);
        return;
      }
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
    return sheet;
  }

  function closeTableSheet() {
    _tableSheet = null;
    var s = document.getElementById("table-sheet");
    var sc = document.getElementById("table-sheet-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
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
    return '<a href="#" data-open-asset="' + escapeHtml(m.id) + '" style="color:var(--md-primary);text-decoration:none;">'
      + escapeHtml(m.hostname || m.ipAddress || m.id) + '</a>';
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

  function openArpSheet(assetId) {
    openTableSheet("arp", assetId, "ARP Table", function () { loadArpSheet(assetId); });
    loadArpSheet(assetId);
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
  function openMacSheet(assetId) {
    openTableSheet("mac", assetId, "MAC Table", function () { loadMacSheet(assetId); });
    loadMacSheet(assetId);
  }

  function loadMacSheet(assetId) {
    var current = beginTableLoad("mac", assetId);
    if (!current) return;
    api.assets.macTable(assetId).then(function (data) {
      if (!current()) return;
      var entries = (data && data.entries) || [];
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
        var hay = [e.macAddress, e.ifName || "", e.vlanId != null ? "vlan " + e.vlanId : "",
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
              if (e.vlanId != null) sub.push("VLAN " + escapeHtml(String(e.vlanId)));
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

  function openWirelessSheet(assetId) {
    openTableSheet("wireless", assetId, "Wireless", function () { loadWirelessSheet(assetId, true); });
    loadWirelessSheet(assetId, false);
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

      if (!radios.length) {
        body.innerHTML = stations.length
          ? stations.map(wirelessStationRow).join('<div class="list-divider"></div>')
          : tableMsg("No radios or wireless clients reported for this AP.");
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
      body.innerHTML = html;
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

  function onRefresh(id, btn, st) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner" style="width:18px;height:18px;border-width:2px;"></span>';
    api.assets.probeNow(id).then(function (resp) {
      // Reflect what each stream did so the operator knows whether it
      // was a partial failure (matches desktop "Poll partial" toast).
      var bits = [];
      if (resp.success) bits.push("probe " + (resp.responseTimeMs != null ? resp.responseTimeMs + " ms" : "ok"));
      else if (resp.error) bits.push("probe failed");
      if (resp.telemetry) {
        if (resp.telemetry.collected) bits.push("telemetry");
        else if (resp.telemetry.error) bits.push("telemetry: " + resp.telemetry.error);
      }
      if (resp.systemInfo) {
        if (resp.systemInfo.collected) bits.push("system-info");
        else if (resp.systemInfo.error) bits.push("system-info: " + resp.systemInfo.error);
      }
      var anyFailure = (resp.success === false) ||
        (resp.telemetry && resp.telemetry.collected === false && resp.telemetry.error) ||
        (resp.systemInfo && resp.systemInfo.collected === false && resp.systemInfo.error);
      PolarisTabs.showSnackbar((anyFailure ? "Poll partial — " : "Poll ok — ") + bits.join(" · "), { error: !!anyFailure });
      // Repull the charts + system-info sections.
      loadMonitor(id, st);
      loadTelemetry(id, st);
      loadSystemInfo(id, st);
      // probeNow ran the state machine, so monitorStatus may have flipped
      // (e.g. down → up). Re-fetch the asset row and re-render the status pill
      // + header dot — otherwise they keep showing the stale state the sheet
      // opened with even though every chart refreshed.
      api.assets.get(id).then(function (fresh) {
        if (!fresh || _openId !== id) return;
        _assetCache[id] = fresh;
        var pillHost = document.getElementById("asset-hero-pill");
        if (pillHost) pillHost.innerHTML = renderMonitorPill(fresh);
        setHeader(fresh);
      }).catch(function () { /* pill stays as-is; charts already refreshed */ });
    }).catch(function (err) {
      var msg = (err && err.message) ? err.message : "Poll failed";
      PolarisTabs.showSnackbar("Poll failed — " + msg, { error: true });
    }).finally(function () {
      btn.disabled = false;
      btn.innerHTML = '<svg viewBox="0 0 24 24"><use href="#i-refresh"/></svg>';
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
  // and the action button itself reflect the new status (mirrors the pill
  // refresh in onRefresh). Guarded by _openId so a stale response from a
  // superseded asset can't overwrite the current sheet.
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

  // ─── helpers ───────────────────────────────────────────────────────────
  function monitorDotCls(asset) {
    if (!asset.monitored) return "";
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

  // Pull-to-refresh path — same backend work the topbar Refresh button
  // does (probe-now + repull monitor/telemetry/system-info), but returns a
  // promise so the PTR puck can spin until it settles. Snackbar still
  // fires so the operator gets the same per-stream outcome message.
  function refreshFromPtr(ctx) {
    var id = (ctx && ctx.route && ctx.route.parts && ctx.route.parts[0]) || "";
    if (!id) return null;
    var st = mountState(id);
    return api.assets.probeNow(id).then(function (resp) {
      var bits = [];
      if (resp.success) bits.push("probe " + (resp.responseTimeMs != null ? resp.responseTimeMs + " ms" : "ok"));
      else if (resp.error) bits.push("probe failed");
      if (resp.telemetry) {
        if (resp.telemetry.collected) bits.push("telemetry");
        else if (resp.telemetry.error) bits.push("telemetry: " + resp.telemetry.error);
      }
      if (resp.systemInfo) {
        if (resp.systemInfo.collected) bits.push("system-info");
        else if (resp.systemInfo.error) bits.push("system-info: " + resp.systemInfo.error);
      }
      var anyFailure = (resp.success === false) ||
        (resp.telemetry && resp.telemetry.collected === false && resp.telemetry.error) ||
        (resp.systemInfo && resp.systemInfo.collected === false && resp.systemInfo.error);
      PolarisTabs.showSnackbar((anyFailure ? "Poll partial — " : "Poll ok — ") + bits.join(" · "), { error: !!anyFailure });
      loadMonitor(id, st);
      loadTelemetry(id, st);
      loadSystemInfo(id, st);
      // Re-render the status pill + header dot from the freshly-probed asset
      // so a down → up flip is reflected (see onRefresh for the rationale).
      api.assets.get(id).then(function (fresh) {
        if (!fresh || _openId !== id) return;
        _assetCache[id] = fresh;
        var pillHost = document.getElementById("asset-hero-pill");
        if (pillHost) pillHost.innerHTML = renderMonitorPill(fresh);
        setHeader(fresh);
      }).catch(function () { /* pill stays as-is; charts already refreshed */ });
    }).catch(function (err) {
      var msg = (err && err.message) ? err.message : "Poll failed";
      PolarisTabs.showSnackbar("Poll failed — " + msg, { error: true });
    });
  }

  window.PolarisAssetDetail = {
    open: open,
    spec: {
      parentTab: "assets",
      // No topbar — the slide-up sheet carries its own header.
      renderTopbar: function () { return ""; },
      render: render,
      onPullToRefresh: refreshFromPtr,
    },
  };
})();
