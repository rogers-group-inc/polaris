// public/js/mobile/alerts.js — the phone's alert vocabulary, its two verbs,
// and the per-asset Alerts sheet.
//
// Three things live here, in one module because they are one decision made in
// three places:
//
//   1. SEVERITY → COLOUR (sevColor) and SEVERITY → RANK (sevRank). The mobile
//      mirror of `assetAlertStrobeColor` / `_alertSevRank` in
//      public/js/assets.js, which in turn mirror `ALERT_SEVERITY_RANK` in
//      src/utils/alertSeverity.ts — the server's own ranking, which is what
//      picks the severity the Assets-list summary reports. A device that
//      flags amber in the list and red in its own sheet is the failure a
//      shared vocabulary exists to prevent, so the map is stated once and the
//      rank order is pinned by tests/unit/mobileAssetAlerts.test.ts.
//
//   2. THE FLAG (flagHTML): the strobing "Alerts" word beside a hostname on
//      the Assets tab, built from the `activeAlert` summary the list endpoint
//      already ships ({severity, count, unacknowledged} — see
//      activeAlertSummaryByAsset). Rendering it here rather than in
//      assets-tab.js keeps the flag and the sheet it opens reading the same
//      severity out of the same table.
//
//   3. THE SHEET (openForAsset): a generic bottom sheet listing that device's
//      active alerts, each with the verbs the operator's role actually
//      allows — Acknowledge at alerts:write, Clear at alerts:fullwrite. The
//      phone is where an alert is usually READ; leaving both verbs on desktop
//      is what left the person holding the pager unable to stop an escalation
//      chain from where they were standing. (The More tab's fleet-wide alerts
//      list is the same idea one level up, and shares this module's note
//      prompt.)
//
// The sheet re-summarizes what it loaded and hands it back through
// `opts.onSummary`, so an acknowledge or a clear settles the flag on the card
// behind it with no list re-fetch — the discipline `_paintAssetAlertsTabStrobe`
// follows on desktop. The state that matters most is the empty one: the last
// alert being cleared has to stop the strobe, not leave it running until the
// tab is re-rendered.

(function () {
  // ─── Permissions ────────────────────────────────────────────────────────
  // Mirrors permAtLeast() in app.js. The routes gate acknowledge on
  // `alerts:write` and clear on `alerts:fullwrite`, so a control that could
  // only ever 403 is not drawn at all.
  var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
  function permAtLeast(key, level) {
    var user = (window.PolarisMobile && PolarisMobile.user && PolarisMobile.user()) || null;
    var have = (user && user.permissions && user.permissions[key]) || "none";
    return (_PERM_RANK[have] || 0) >= (_PERM_RANK[level] || 0);
  }
  function canAck()   { return permAtLeast("alerts", "write"); }
  function canClear() { return permAtLeast("alerts", "fullwrite"); }

  // ─── Severity vocabulary ────────────────────────────────────────────────
  var SEV_TOKEN = {
    notice:        "--md-sev-notice",
    informational: "--md-sev-info",
    info:          "--md-sev-info",
    warning:       "--md-sev-warning",
    serious:       "--md-sev-serious",
    error:         "--md-sev-critical",
    critical:      "--md-sev-critical",
  };
  // An unknown severity falls back to critical, never to nothing: Polaris is
  // still asserting something is wrong, and a colourless flag understates it.
  function sevColor(sev) { return "var(" + (SEV_TOKEN[sev] || "--md-sev-critical") + ")"; }

  var SEV_RANK = { notice: 1, informational: 2, info: 2, warning: 3, serious: 4, error: 5, critical: 5 };
  function sevRank(sev) { return SEV_RANK[sev] || 0; }

  /**
   * Reduce a list of alerts to the same {severity, count, unacknowledged}
   * shape the list endpoint ships per row, so the sheet can repaint the flag
   * from what it just loaded instead of asking the server again. Null when
   * nothing is active — which is what clears the flag.
   */
  function summarize(alerts) {
    var count = 0, unack = 0, worst = null;
    (alerts || []).forEach(function (n) {
      count += 1;
      if (!n.acknowledged) unack += 1;
      if (!worst || sevRank(n.severity) > sevRank(worst)) worst = n.severity;
    });
    if (!count) return null;
    return { severity: worst || "critical", count: count, unacknowledged: unack };
  }

  /** Newest first, then by dimension — the order _sortAssetAlerts uses on desktop. */
  function sortAlerts(alerts) {
    return (alerts || []).slice().sort(function (a, b) {
      var d = new Date(b.triggeredAt || 0).getTime() - new Date(a.triggeredAt || 0).getTime();
      if (d) return d;
      return String(a.dimension || "").localeCompare(String(b.dimension || ""), undefined, { numeric: true, sensitivity: "base" });
    });
  }

  // ─── The flag ───────────────────────────────────────────────────────────
  /**
   * The strobing "Alerts" control for one asset card. Empty string when the
   * device has nothing active, so a quiet card carries no node at all.
   *
   * The label says which of the two states it is in, because the difference
   * between moving and not moving is not something to make anyone squint at —
   * and it is the only thing a reduced-motion viewer has, the animation being
   * off for them entirely.
   */
  function flagHTML(summary) {
    if (!summary || !summary.count) return "";
    var handled = !summary.unacknowledged;
    var sev = summary.severity || "critical";
    var label = summary.count === 1
      ? "1 active " + sev + " alert" + (handled ? " — acknowledged" : "")
      : summary.count + " active alerts, worst " + sev +
        (handled ? " — all acknowledged" : " — " + summary.unacknowledged + " unacknowledged");
    return '<button type="button" class="alert-flag' + (handled ? " is-handled" : "") + '"' +
      ' style="--alert-flag-color:' + sevColor(sev) + '"' +
      ' aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '">' +
      'Alerts' + (summary.count > 1 ? '<span class="count">' + summary.count + '</span>' : "") +
      '</button>';
  }

  /**
   * The same statement as `flagHTML`, reduced to a dot — for rows with no room
   * for a word. Search results are the caller: a hit is one line carrying an
   * icon, a name, a subtitle and a chevron, and an "ALERTS" pill in there
   * would push the hostname into an ellipsis on a phone. Same colour, same
   * strobe, same handled state, same label — only the shape differs.
   *
   * It is deliberately NOT tappable. A search row's job is to take you to the
   * thing you searched for; a second target inside it, two thumb-widths from
   * the row's own, is a mis-tap waiting to happen. The dot says "this one is
   * alarmed" and the row it sits in opens the device, whose own Alerts control
   * is the way in.
   */
  function dotHTML(summary) {
    if (!summary || !summary.count) return "";
    var handled = !summary.unacknowledged;
    var sev = summary.severity || "critical";
    var label = summary.count === 1
      ? "1 active " + sev + " alert" + (handled ? " — acknowledged" : "")
      : summary.count + " active alerts, worst " + sev +
        (handled ? " — all acknowledged" : " — " + summary.unacknowledged + " unacknowledged");
    return '<span class="alert-dot' + (handled ? " is-handled" : "") + '"' +
      ' style="--alert-flag-color:' + sevColor(sev) + '"' +
      ' role="img" aria-label="' + escapeHtml(label) + '" title="' + escapeHtml(label) + '"></span>';
  }

  // ─── Acknowledge note prompt ────────────────────────────────────────────
  /**
   * A note field, only when an automation demands one.
   *
   * The default stays ONE TAP — this is the path for someone who just got
   * paged, and the desktop tab and the emailed link are where a note usually
   * gets typed. But an automation with `requireAckNote` is refused server-side
   * without one, so on those rows the tap opens this instead of failing.
   * Resolves to the note, or null if dismissed (never ""), because "I changed
   * my mind" and "do it, nothing to say" are different answers.
   *
   * A sheet rather than window.prompt(): prompt() is unstyled, and in an
   * installed PWA some browsers suppress it outright — leaving the operator
   * unable to acknowledge with no visible reason why. Shared with the More
   * tab's fleet-wide alerts list, which had the only copy of this.
   */
  function promptAckNote(count) {
    return new Promise(function (resolve) {
      var scrim = document.createElement("div");
      scrim.className = "scrim";
      scrim.style.zIndex = "1010";
      var sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.style.zIndex = "1011";
      var many = count > 1;
      sheet.innerHTML = ''
        + '<div class="sheet-handle"></div>'
        + '<h3 class="sheet-title" style="margin:0 0 4px;">Acknowledge ' + (many ? count + " alerts" : "alert") + '</h3>'
        + '<p style="margin:0 0 12px;color:var(--md-on-surface-variant);font-size:14px;">'
        + (many ? "One of these alerts’ automations requires a note. It is applied to all of them."
                : "This alert’s automation requires a note.")
        + '</p>'
        + '<textarea id="ack-note" rows="3" maxlength="2000" placeholder="What is the problem and what is the fix?"'
        + ' style="width:100%;box-sizing:border-box;font:inherit;font-size:15px;padding:10px;border-radius:8px;'
        + 'border:1px solid var(--md-outline);background:var(--md-surface-cont-low);color:inherit;resize:vertical;"></textarea>'
        + '<p id="ack-note-err" style="display:none;margin:6px 0 0;font-size:13px;color:var(--md-error);">A note is required.</p>'
        + '<div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px;">'
        + '  <button id="ack-note-cancel" class="btn btn-outlined">Cancel</button>'
        + '  <button id="ack-note-ok" class="btn btn-filled">Acknowledge</button>'
        + '</div>';
      document.body.appendChild(scrim);
      document.body.appendChild(sheet);
      var ta = sheet.querySelector("#ack-note");
      var err = sheet.querySelector("#ack-note-err");
      function close(val) { scrim.remove(); sheet.remove(); resolve(val); }
      scrim.addEventListener("click", function () { close(null); });
      sheet.querySelector("#ack-note-cancel").addEventListener("click", function () { close(null); });
      sheet.querySelector("#ack-note-ok").addEventListener("click", function () {
        var v = ta.value.trim();
        if (!v) { err.style.display = ""; ta.focus(); return; }
        close(v);
      });
      ta.addEventListener("input", function () { err.style.display = "none"; });
      setTimeout(function () { try { ta.focus(); } catch (e) { /* keyboard may refuse */ } }, 50);
    });
  }

  /**
   * Confirm a clear. Its own sheet for the same reason the note prompt is one
   * — window.confirm() is suppressed in some installed PWAs — and it states
   * what clearing DOES: it is the operator's "this is handled", it stops
   * escalation and runs the automation's reset actions, and an auto-reset
   * rule whose condition is still true simply raises a new alert. A mis-tap
   * is noise rather than a silent loss, and saying so is what keeps the
   * confirm from being tapped through blind.
   */
  function confirmClear(count) {
    return new Promise(function (resolve) {
      var scrim = document.createElement("div");
      scrim.className = "scrim";
      scrim.style.zIndex = "1010";
      var sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.style.zIndex = "1011";
      sheet.innerHTML = ''
        + '<div class="sheet-handle"></div>'
        + '<h3 class="sheet-title" style="margin:0 0 4px;">Clear ' + (count > 1 ? count + " alerts" : "this alert") + '?</h3>'
        + '<p style="margin:0 0 8px;color:var(--md-on-surface-variant);font-size:14px;line-height:20px;">'
        + 'Clearing stops escalation and runs the automation’s reset actions. '
        + 'A condition that is still true can raise a new alert.</p>'
        + '<div style="display:flex;gap:12px;justify-content:flex-end;margin-top:16px;">'
        + '  <button id="alert-clear-cancel" class="btn btn-outlined">Cancel</button>'
        + '  <button id="alert-clear-ok" class="btn btn-error">Clear</button>'
        + '</div>';
      document.body.appendChild(scrim);
      document.body.appendChild(sheet);
      function close(val) { scrim.remove(); sheet.remove(); resolve(val); }
      scrim.addEventListener("click", function () { close(false); });
      sheet.querySelector("#alert-clear-cancel").addEventListener("click", function () { close(false); });
      sheet.querySelector("#alert-clear-ok").addEventListener("click", function () { close(true); });
    });
  }

  function toast(msg, isError) {
    if (window.PolarisTabs && PolarisTabs.showSnackbar) PolarisTabs.showSnackbar(msg, isError ? { error: true } : undefined);
  }

  // ─── The sheet ──────────────────────────────────────────────────────────
  var _sheetAssetId = null;   // also the load race guard
  var _onSummary = null;      // caller's repaint hook
  var _alerts = [];

  function close() {
    var s = document.getElementById("asset-alerts-sheet");
    var sc = document.getElementById("asset-alerts-scrim");
    if (s) s.remove();
    if (sc) sc.remove();
    _sheetAssetId = null;
    _onSummary = null;
    _alerts = [];
  }

  /**
   * Open the alerts sheet for one asset.
   *
   * @param {string} assetId
   * @param {{hostname?: string, onSummary?: function}} [opts] — `onSummary`
   *        receives the {severity, count, unacknowledged} summary (or null)
   *        every time the list settles, so the surface behind the sheet can
   *        repaint its own flag without re-fetching.
   */
  function openForAsset(assetId, opts) {
    if (!assetId) return Promise.resolve();
    close();
    opts = opts || {};
    _sheetAssetId = assetId;
    _onSummary = typeof opts.onSummary === "function" ? opts.onSummary : null;

    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.id = "asset-alerts-scrim";

    var sheet = document.createElement("div");
    sheet.className = "sheet";
    sheet.id = "asset-alerts-sheet";
    sheet.innerHTML = ''
      + '<div class="sheet-handle"></div>'
      + '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:12px;">'
      + '  <div style="min-width:0;">'
      + '    <h3 class="sheet-title" style="margin:0 0 2px;">Alerts</h3>'
      + (opts.hostname ? '    <div style="color:var(--md-on-surface-variant);font-size:13px;">' + escapeHtml(opts.hostname) + '</div>' : "")
      + '  </div>'
      + '  <button class="icon-btn" id="asset-alerts-close" aria-label="Close"><svg viewBox="0 0 24 24"><use href="#i-close"/></svg></button>'
      + '</div>'
      + '<div id="asset-alerts-body"><div class="loading-screen" style="padding:32px 0;"><div class="spinner"></div></div></div>';

    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    scrim.addEventListener("click", close);
    sheet.querySelector("#asset-alerts-close").addEventListener("click", close);
    if (window.PolarisTabs && PolarisTabs.attachSwipeToDismiss) PolarisTabs.attachSwipeToDismiss(sheet, close);
    wireBody(sheet, assetId);

    return load(assetId);
  }

  function load(assetId) {
    return api.assets.alerts(assetId).then(function (data) {
      if (_sheetAssetId !== assetId) return;   // sheet closed, or moved on
      _alerts = sortAlerts((data && data.active) || []);
      paint();
    }).catch(function (err) {
      if (_sheetAssetId !== assetId) return;
      var body = document.getElementById("asset-alerts-body");
      if (body) {
        body.innerHTML = '<div class="empty-state" style="padding:24px 0;">'
          + '<div class="ttl">Couldn’t load alerts</div>'
          + '<div class="desc">' + escapeHtml((err && err.message) || "Request failed") + '</div></div>';
      }
    });
  }

  function paint() {
    var body = document.getElementById("asset-alerts-body");
    if (!body) return;
    // Hand the summary back BEFORE the body renders: the flag behind the sheet
    // is worth settling even if something below fails to paint.
    if (_onSummary) { try { _onSummary(summarize(_alerts)); } catch (e) { /* the caller's problem, not the sheet's */ } }

    if (_alerts.length === 0) {
      body.innerHTML = '<div class="empty-state" style="padding:24px 0;">'
        + '<div class="icon"><svg viewBox="0 0 24 24"><use href="#i-bell"/></svg></div>'
        + '<div class="ttl">No active alerts</div>'
        + '<div class="desc">Nothing is firing on this device right now.</div></div>';
      return;
    }

    var ack = canAck(), clear = canClear();
    var unacked = _alerts.filter(function (n) { return !n.acknowledged; });
    // One switch losing its uplink raises one alert per pinned interface, so a
    // per-row-only sheet means a dozen taps and a dozen prompts to close out
    // one outage. Offered only when there is more than one to batch.
    var bulk = (ack && unacked.length > 1)
      ? '<button class="btn btn-tonal btn-block" id="asset-alerts-ack-all" style="margin-bottom:12px;">'
        + 'Acknowledge all (' + unacked.length + ')</button>'
      : "";

    body.innerHTML = bulk + _alerts.map(function (n) { return alertItemHTML(n, ack, clear); }).join("");
  }

  function alertItemHTML(n, ack, clear) {
    var sev = n.severity || "info";
    var when = n.triggeredAt ? timeAgo(n.triggeredAt) : "";
    // Metric and dimension identify what the message's bare label ("port12",
    // "TMP1") actually IS, and are the fallback for a custom message template
    // that renders no label at all.
    var what = [n.metric, n.dimension].filter(Boolean).join(" · ");
    var meta = [when, what].filter(Boolean).join(" · ");

    var ackBlock = "";
    if (n.acknowledged) {
      // An acknowledged alert with no note still names who did it:
      // "acknowledged, nothing said" and "not acknowledged" are different facts.
      var note = (n.acknowledgeNote || "").trim();
      var by = (n.acknowledgedBy || "acknowledged") + (n.acknowledgedAt ? " · " + timeAgo(n.acknowledgedAt) : "");
      ackBlock = '<div class="alert-ack-note">' + (note ? escapeHtml(note) : "<em>No note</em>")
        + '<div style="color:var(--md-on-surface-variant);font-size:12px;margin-top:4px;">' + escapeHtml(by) + '</div></div>';
    }

    var actions = [];
    if (!n.acknowledged && ack) {
      actions.push('<button class="btn btn-tonal alert-ack" data-id="' + escapeHtml(n.id) + '"'
        + (n.requireAckNote ? ' data-note-required="1"' : "") + '>Acknowledge</button>');
    }
    if (clear) {
      actions.push('<button class="btn btn-outlined alert-clear" data-id="' + escapeHtml(n.id) + '">Clear</button>');
    }

    // Raised while the device was dependency-down (business rule 78) — the
    // same slate badge the desktop surfaces wear, beside the severity.
    var dep = n.dependencyDown
      ? ' <span class="badge badge-monitor-dep-down" title="Raised while this device was dependency-down">Dep. Down</span>'
      : "";
    return '<div class="card-filled alert-item" style="--alert-flag-color:' + sevColor(sev) + '">'
      + '<div class="alert-sev">' + escapeHtml(sev) + dep + '</div>'
      + '<div class="alert-msg">' + escapeHtml(n.message || "") + '</div>'
      + (meta ? '<div class="alert-meta">' + escapeHtml(meta) + '</div>' : "")
      + ackBlock
      + (actions.length ? '<div class="alert-actions">' + actions.join("") + '</div>' : "")
      + '</div>';
  }

  // ONE delegated listener on the sheet, attached at open — the body is
  // rebuilt after every acknowledge and clear, so per-button listeners would
  // have to be re-attached each time (and, missed once, leave dead controls).
  function wireBody(sheet, assetId) {
    sheet.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var ackBtn = t.closest(".alert-ack");
      if (ackBtn) { acknowledge([ackBtn.dataset.id], ackBtn.dataset.noteRequired === "1", assetId, ackBtn); return; }
      var clearBtn = t.closest(".alert-clear");
      if (clearBtn) { clearAlerts([clearBtn.dataset.id], assetId, clearBtn); return; }
      var all = t.closest("#asset-alerts-ack-all");
      if (all) {
        var pending = _alerts.filter(function (n) { return !n.acknowledged; });
        // Required when ANY of them requires it: the route applies one note to
        // the whole batch and refuses it whole otherwise, so asking up front
        // beats a 400 after the fact.
        acknowledge(pending.map(function (n) { return n.id; }),
          pending.some(function (n) { return n.requireAckNote; }), assetId, all);
      }
    });
  }

  function busy(btn, on) {
    if (!btn) return;
    btn.disabled = on;
    if (on) { btn.dataset.label = btn.textContent; btn.textContent = "…"; }
    else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
  }

  async function acknowledge(ids, noteRequired, assetId, btn) {
    if (!ids.length) return;
    var note;
    if (noteRequired) {
      note = await promptAckNote(ids.length);
      if (note === null) return;   // dismissed
    }
    busy(btn, true);
    try {
      var res = await api.alerts.acknowledge(ids, note || undefined);
      // Report what the SERVER did, not what was asked for: the route skips
      // rows already acknowledged, and a success toast over a no-op is how
      // "I tapped it and nothing happened" starts.
      var n = res && typeof res.acknowledged === "number" ? res.acknowledged : ids.length;
      toast(n ? (n > 1 ? n + " alerts acknowledged" : "Alert acknowledged") : "Already acknowledged", !n);
      await load(assetId);
    } catch (err) {
      toast((err && err.message) || "Couldn’t acknowledge", true);
      busy(btn, false);
    }
  }

  async function clearAlerts(ids, assetId, btn) {
    if (!ids.length) return;
    var ok = await confirmClear(ids.length);
    if (!ok) return;
    busy(btn, true);
    try {
      var res = await api.alerts.clear(ids);
      var n = res && typeof res.cleared === "number" ? res.cleared : ids.length;
      toast(n ? (n > 1 ? n + " alerts cleared" : "Alert cleared") : "That alert was already cleared", !n);
      await load(assetId);
    } catch (err) {
      toast((err && err.message) || "Couldn’t clear the alert", true);
      busy(btn, false);
    }
  }

  window.PolarisMobileAlerts = {
    openForAsset: openForAsset,
    close: close,
    flagHTML: flagHTML,
    dotHTML: dotHTML,
    summarize: summarize,
    sevColor: sevColor,
    sevRank: sevRank,
    promptAckNote: promptAckNote,
    canAcknowledge: canAck,
    canClear: canClear,
  };
})();
