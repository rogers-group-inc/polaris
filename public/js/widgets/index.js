/**
 * public/js/widgets/index.js — Dashboard widget registry + small shared helpers.
 *
 * Each widget module self-registers via PolarisWidgets.register({...}). The
 * dashboard orchestrator (public/js/dashboard.js) reads getAll() for the
 * library catalog and getByType(type) for instance rendering on the canvas.
 *
 * Widget module shape:
 *   {
 *     type:            string                              // stable id, used in saved layouts
 *     label:           string                              // display name
 *     description:     string                              // 1-line library blurb
 *     category?:       string                              // picker Group-By bucket (default "Other")
 *     defaultSize:     { width, height }                   // grid cells (width ∈ 3|4|6|12, height ∈ 1|2)
 *     minSize?:        { width, height }                   // optional resize floor
 *     requiredPermission?: { key, level }                  // gates library visibility AND instance render
 *     fetchData?:      (config) => Promise<any>            // optional — widgets fetch their own feed/section
 *                                                          // (getNocSummary(opts, feeds) / getSummary(opts))
 *     renderInstance:  (el, config, data, ctx)             // full render
 *     renderPreview:   (el, ctx)                           // mock-data mini for library
 *     renderConfig?:   (el, config, onChange)              // gear popover
 *     defaultConfig?:  object                              // seed config on add
 *     onMount?:        (el, ctx)                           // optional post-mount hook (timers etc.)
 *     onUnmount?:      (el, ctx)                           // cleanup hook
 *   }
 */

(function () {
  var registry = [];

  window.PolarisWidgets = {
    register: function (widget) {
      // Defensive: replace if same type re-registered (hot reload, dup includes).
      registry = registry.filter(function (w) { return w.type !== widget.type; });
      registry.push(widget);
    },
    getAll: function () { return registry.slice(); },
    getByType: function (type) {
      for (var i = 0; i < registry.length; i++) if (registry[i].type === type) return registry[i];
      return null;
    },
    // Filter to widgets the current user is allowed to see. Uses the
    // permAtLeast() helper exposed by app.js.
    getAllowed: function () {
      return registry.filter(function (w) {
        if (!w.requiredPermission) return true;
        if (typeof permAtLeast !== "function") return true;
        return permAtLeast(w.requiredPermission.key, w.requiredPermission.level || "read");
      });
    },
  };

  // The built-in asset types, in display order. A widget's asset-type filter is
  // "all on" by default; only a strict subset is sent to the server (so
  // operator-added custom types always show through). MUST stay in lockstep
  // with BUILT_IN_ASSET_TYPES in src/utils/assetTypes.ts — the server derives
  // the HIDDEN set as (its built-ins − the ones we send), so a name this list
  // lacks is a type the operator can never filter on.
  window.PolarisWidgets.BUILTIN_ASSET_TYPES = [
    "server", "switch", "router", "firewall", "workstation", "printer", "access_point", "other",
    "hypervisor",         // vCenter (migration 20260709000000)
    "kubernetes_cluster", // Azure Arc connected clusters (migration 20260807020000)
  ];

  // The eight types that existed before the registry grew. A stored widget
  // config predates a new built-in if it names every one of these and nothing
  // else — see effectiveAssetTypes below.
  var LEGACY_ASSET_TYPES = [
    "server", "switch", "router", "firewall", "workstation", "printer", "access_point", "other",
  ];

  // Read a stored `config.assetTypes` in TODAY's terms.
  //
  // The filter is stored as the ENABLED list, so a config saved before a built-in
  // existed simply doesn't mention it — indistinguishable, by shape alone, from
  // an operator who just switched it off. We resolve that in favor of showing
  // the data: a list carrying ALL EIGHT legacy types is "everything was on when
  // this was saved", so it widens to every built-in and the caller's all-on test
  // then suppresses the param entirely. Without this, adding a built-in would
  // silently hide it in every widget whose config was already all-on — the
  // list would go from 8-of-8 (unfiltered) to 8-of-10 (a strict subset), and
  // the server would start excluding the two it never heard about.
  //
  // Known limit: an operator who unchecks ONLY the newer types, leaving all
  // eight legacy ones on, saves a list this reads as all-on and widens back.
  // Anything else — any narrower pick — is passed through untouched.
  function effectiveAssetTypes(list) {
    if (!Array.isArray(list)) return null;
    var all = window.PolarisWidgets.BUILTIN_ASSET_TYPES;
    for (var i = 0; i < LEGACY_ASSET_TYPES.length; i++) {
      if (list.indexOf(LEGACY_ASSET_TYPES[i]) === -1) return list;
    }
    return all.slice();
  }
  window.PolarisWidgets.effectiveAssetTypes = effectiveAssetTypes;

  // The types a config wants HIDDEN, which is what the server is actually told.
  // Two stored shapes, unioned:
  //
  //   • `assetTypesOff` — what the grid writes today: the UNCHECKED names,
  //     built-in or custom. Naming the hidden set is what lets a custom type be
  //     switched off at all, and it means a type added to the registry later
  //     isn't in any existing config's list, so it shows until an operator says
  //     otherwise — the same "new types stay visible" property the widening
  //     rule below buys for the legacy shape, without the guesswork. It also
  //     retires that rule's known limit: unchecking ONLY the newer built-ins is
  //     now stored as a hidden list and survives, where before it read as
  //     all-on and widened back.
  //   • `assetTypes` — the LEGACY enabled list (built-ins only), from a config
  //     saved before the grid learned the registry. Hidden is
  //     (built-ins − effectiveAssetTypes(list)), so an all-on legacy config
  //     stays unfiltered.
  //
  // Returns [] when nothing is hidden — callers then send no param at all.
  function hiddenAssetTypes(config) {
    config = config || {};
    var out = [];
    var add = function (t) { if (t && out.indexOf(t) === -1) out.push(t); };
    if (Array.isArray(config.assetTypesOff)) config.assetTypesOff.forEach(add);
    var enabled = effectiveAssetTypes(config.assetTypes);
    if (enabled && enabled.length > 0) {
      window.PolarisWidgets.BUILTIN_ASSET_TYPES.forEach(function (t) {
        if (enabled.indexOf(t) === -1) add(t);
      });
    }
    return out;
  }
  window.PolarisWidgets.hiddenAssetTypes = hiddenAssetTypes;

  // Widget refresh cadence, by how fast the underlying thing actually moves:
  //   fast   — in-flight progress (a running discovery)
  //   normal — outage state (down assets/interfaces, active alerts)
  //   slow   — ranked metrics, forecasts, maps, history
  // NOTE: NOC_TTL_MS is 15000, so `fast` refetches faster than the shared memo
  // TTL and gets cached data two ticks out of three. That is tolerable for a
  // progress readout; do not copy the pattern to a widget that needs fresh data.
  window.PolarisWidgets.REFRESH = { fast: 10000, normal: 30000, slow: 60000 };

  // Shared NOC-summary accessor. Each widget fetches ONLY its own feed(s)
  // (?feeds=topCpu) so it renders as soon as its data exists instead of
  // gating on the slowest feed in a monolithic payload. Results are memoized
  // for a short TTL keyed by (feeds, filter, limit) with in-flight dedupe, so
  // two widgets sharing a feed + filter still make one fetch. The server adds
  // its own short per-feed cache on top, so extra requests from many widgets /
  // tabs / kiosk walls stay cheap. Pass the opts object from
  // PolarisWidgets.nocFilterOpts(config); omit it for the unfiltered payload.
  var _nocCache = {}; // key -> { at, data, inflight }
  var NOC_TTL_MS = 15000;

  // Translate a widget config into a stable query string for /noc-summary.
  // The asset-type filter goes out as ?hideAssetTypes= (the switched-off
  // names) and only when something is off — all-on = omit = unfiltered.
  // regionScope "mine" expands to the caller's
  // effective region names (app.js global currentEffectiveRegions); "custom"
  // uses the widget's own picked region list (config.regions). fortigateScope
  // "custom" sends the picked FortiGate device names (config.fortigates) —
  // the per-site narrowing below regions. An empty list any way means
  // "unrestricted", so no param is sent.
  function nocQueryString(opts) {
    opts = opts || {};
    var parts = [];
    // One param carries the asset-type filter, and it names what to HIDE —
    // hiddenAssetTypes folds both stored shapes (the grid's `assetTypesOff`
    // and a legacy enabled `assetTypes` list) into that one set, so a config
    // that was all-on when it was saved sends nothing and the built-ins added
    // since it was written keep showing.
    var hidden = hiddenAssetTypes(opts);
    if (hidden.length > 0) {
      parts.push("hideAssetTypes=" + encodeURIComponent(hidden.slice().sort().join(",")));
    }
    var regions = null;
    if (opts.regionScope === "custom") regions = Array.isArray(opts.regions) ? opts.regions : [];
    else if (opts.regionScope === "mine") regions = (typeof currentEffectiveRegions !== "undefined" && currentEffectiveRegions) || [];
    if (regions && regions.length) parts.push("regionTags=" + encodeURIComponent(regions.slice().sort().join(",")));
    if (opts.fortigateScope === "custom" && Array.isArray(opts.fortigates) && opts.fortigates.length) {
      parts.push("fortigates=" + encodeURIComponent(opts.fortigates.slice().sort().join(",")));
    }
    // Ask the server for a larger cap only when a widget wants more than the
    // default payload holds (>100 → the 1000-row option). Numeric limits ≤100
    // are omitted so those widgets keep sharing the one default-capped payload
    // and clip client-side; only the 1000-row widgets fetch their own.
    if (opts.limit) parts.push("limit=" + encodeURIComponent(opts.limit));
    // Per-asset averaging count for the sample-averaged top-N feeds (Highest
    // Avg CPU/Memory). Only sent when it differs from the server default (10)
    // so default-config widgets keep sharing one cached payload.
    if (opts.samples) parts.push("samples=" + encodeURIComponent(opts.samples));
    // Down Assets only: ask the server to keep dependency-suppressed assets in
    // the feed. Sent only when on, so the default-config widget keeps sharing
    // the one cached payload.
    if (opts.includeDependencyDown) parts.push("includeDependencyDown=1");
    return parts.join("&");
  }

  // feeds: array of feed names the caller renders (e.g. ["topCpu"], or
  // ["downInterfaces","downIpsecTunnels"]). Omit/empty = the full payload.
  window.PolarisWidgets.getNocSummary = function (opts, feeds) {
    var qs = nocQueryString(opts);
    if (Array.isArray(feeds) && feeds.length) {
      qs = (qs ? qs + "&" : "") + "feeds=" + encodeURIComponent(feeds.slice().sort().join(","));
    }
    var key = qs || "_default";
    var now = Date.now();
    var slot = _nocCache[key];
    if (slot && slot.data && now - slot.at < NOC_TTL_MS) return Promise.resolve(slot.data);
    if (slot && slot.inflight) return slot.inflight;
    slot = _nocCache[key] = slot || { at: 0, data: null, inflight: null };
    slot.inflight = api.dashboard.nocSummary(qs)
      .then(function (data) {
        slot.at = Date.now();
        slot.data = data;
        slot.inflight = null;
        return data;
      })
      .catch(function (err) {
        slot.inflight = null;
        throw err;
      });
    return slot.inflight;
  };

  // Shared /dashboard/summary accessor for the IP-space widgets, same memo +
  // in-flight-dedupe pattern as getNocSummary. Widgets fetch only their own
  // section (?sections=blocks|recent|assetTypes) so each renders as soon as
  // its data exists — nothing depends on the dashboard orchestrator having
  // pre-fetched a shared payload. opts: { sections, sourceTypes, recentLimit }.
  var _summaryCache = {}; // key -> { at, data, inflight }
  window.PolarisWidgets.getSummary = function (opts) {
    opts = opts || {};
    var key = JSON.stringify([opts.sections || [], opts.sourceTypes || [], opts.recentLimit == null ? "" : opts.recentLimit]);
    var now = Date.now();
    var slot = _summaryCache[key];
    if (slot && slot.data && now - slot.at < NOC_TTL_MS) return Promise.resolve(slot.data);
    if (slot && slot.inflight) return slot.inflight;
    slot = _summaryCache[key] = slot || { at: 0, data: null, inflight: null };
    slot.inflight = api.dashboard.summary(opts)
      .then(function (data) {
        slot.at = Date.now();
        slot.data = data;
        slot.inflight = null;
        return data;
      })
      .catch(function (err) {
        slot.inflight = null;
        throw err;
      });
    return slot.inflight;
  };

  // Shared /map/sites accessor — same memo + in-flight-dedupe as the two
  // above. The Device Map and Site Map widgets each called api.map.sites()
  // raw on their own 60s timer, so a dashboard carrying both (or two copies
  // of one, which a wallboard commonly does) made that many independent
  // full-fleet fetches every minute. Keyed on the region list so differently
  // scoped instances still get their own answer.
  var _mapSitesCache = {}; // key -> { at, data, inflight }
  window.PolarisWidgets.getMapSites = function (regions) {
    var list = Array.isArray(regions) ? regions : (regions ? [regions] : []);
    var key = JSON.stringify(list.slice().sort());
    var now = Date.now();
    var slot = _mapSitesCache[key];
    if (slot && slot.data && now - slot.at < NOC_TTL_MS) return Promise.resolve(slot.data);
    if (slot && slot.inflight) return slot.inflight;
    slot = _mapSitesCache[key] = slot || { at: 0, data: null, inflight: null };
    slot.inflight = api.map.sites(regions)
      .then(function (data) {
        slot.at = Date.now();
        slot.data = data;
        slot.inflight = null;
        return data;
      })
      .catch(function (err) {
        slot.inflight = null;
        throw err;
      });
    return slot.inflight;
  };

  // Extract the NOC filter opts a widget should pass to getNocSummary / its
  // own fetch. Centralized so every widget reads the same config keys.
  window.PolarisWidgets.nocFilterOpts = function (config) {
    config = config || {};
    var n = window.PolarisWidgets.serverRowLimit(config.rowLimit);
    // sampleCount (Highest Avg CPU/Memory "Average over" control): sent only
    // when it deviates from the server default of 10, so default-config
    // widgets share the one cached payload. Other widgets carry no
    // sampleCount config and omit the param entirely.
    var s = parseInt(config.sampleCount, 10);
    return {
      assetTypes: config.assetTypes,
      // The grid's switched-off list (built-in or custom). Read together with
      // `assetTypes` by hiddenAssetTypes — see the two stored shapes there.
      assetTypesOff: config.assetTypesOff,
      regionScope: config.regionScope,
      regions: config.regions,
      fortigateScope: config.fortigateScope,
      fortigates: config.fortigates,
      // Only widgets wanting MORE than the default payload holds (the 1000-row
      // option) request a larger server cap; ≤100 shares the default payload.
      limit: n > 100 ? n : undefined,
      samples: s > 0 && s !== 10 ? s : undefined,
      // Only the Down Assets widget carries this key; every other widget's
      // config leaves it undefined and sends no param.
      includeDependencyDown: config.includeDependencyDown ? true : undefined,
    };
  };

  // ─── Shared row-limit control ───────────────────────────────────────────
  // Every list widget's "Row limit" dropdown uses the same numeric options
  // (5/10/20/50/100/1000). Helpers centralize option HTML, parsing, client-side
  // clipping, and the server-limit translation. 1000 is the hard ceiling — the
  // server sends at most that many rows per feed.
  window.PolarisWidgets.ROW_LIMIT_OPTIONS = [
    { value: "5", label: "5 rows" },
    { value: "10", label: "10 rows" },
    { value: "20", label: "20 rows" },
    { value: "50", label: "50 rows" },
    { value: "100", label: "100 rows" },
    { value: "1000", label: "1000 rows" },
  ];

  // Build the <option> tags for a Row-limit <select>, marking the current value.
  window.PolarisWidgets.rowLimitOptionsHTML = function (current) {
    var cur = current == null ? 10 : current;
    return window.PolarisWidgets.ROW_LIMIT_OPTIONS.map(function (o) {
      return '<option value="' + o.value + '"' + (String(cur) === o.value ? " selected" : "") + '>' + o.label + '</option>';
    }).join("");
  };

  // Parse a Row-limit <select> value into the stored config form (a number).
  window.PolarisWidgets.parseRowLimit = function (v) {
    return parseInt(v, 10);
  };

  // Clip a row array to a rowLimit config value; null/NaN = no clip.
  window.PolarisWidgets.clip = function (rows, rowLimit) {
    rows = rows || [];
    if (rowLimit == null) return rows.slice();
    var n = parseInt(rowLimit, 10);
    return isNaN(n) ? rows.slice() : rows.slice(0, n);
  };

  // Translate a rowLimit config value into a server-side row cap (the number).
  window.PolarisWidgets.serverRowLimit = function (rowLimit) {
    return parseInt(rowLimit, 10) || 0;
  };

  // Stamp (or clear) a row of pills on the widget's header title — the same
  // style the group headers use, so "[4] Down Assets (Firewall)" reads as the
  // overall total. The pills lead the title: it is a single ellipsized line, so
  // a count appended after the name is the first thing a narrow column drops —
  // and the count is the part an operator scans the wall for. `el` is the
  // widget body; resolves the shell header via closest(). No-ops outside a
  // dashboard shell (e.g. the widget library preview renders without the
  // .dashboard-widget wrapper). An empty list removes the pills. Re-call on
  // every render tick — updateConfig rewrites the title's textContent, which
  // drops them until the next render re-stamps.
  //
  // `pills` is [{ text, className, title? }]; the whole set is re-rendered every
  // call, so counts AND colors track the current data.
  window.PolarisWidgets.setHeaderPills = function (el, pills) {
    var article = el && el.closest ? el.closest(".dashboard-widget") : null;
    var title = article ? article.querySelector(".dashboard-widget-title") : null;
    if (!title) return;
    var host = title.querySelector(".widget-header-count");
    if (!pills || !pills.length) { if (host) host.remove(); return; }
    if (!host) {
      host = document.createElement("span");
      host.className = "widget-header-count";
      host.style.marginRight = "6px";
      host.style.display = "inline-flex";
      host.style.gap = "4px";
      host.style.verticalAlign = "middle";
    }
    // Always re-seat at the head: a host built before this ordering (or left
    // behind by an in-place title rewrite) would otherwise keep trailing.
    if (title.firstChild !== host) title.insertBefore(host, title.firstChild);
    host.innerHTML = pills.map(function (p) {
      return '<span class="widget-pill ' + (p.className || "widget-pill-red") + '"' +
        (p.title ? ' title="' + escapeHtml(p.title) + '"' : "") + '>' +
        escapeHtml(String(p.text)) + '</span>';
    }).join("");
  };

  // Single total pill — optional `severity` colors it to the highest active
  // alert severity in the set (see countPillClass) so it agrees with the
  // per-row severity pills underneath it; omit it for the plain red count.
  window.PolarisWidgets.setHeaderCount = function (el, count, severity) {
    window.PolarisWidgets.setHeaderPills(el, !count ? [] : [{
      text: count,
      className: window.PolarisWidgets.alertSeverityPillClass(severity) || "widget-pill-red",
    }]);
  };

  // Per-severity breakdown of a row set's ACTIVE alerts, most-severe first.
  // Returns [{ severity, count }]; rows carrying no alert are excluded — the
  // caller decides whether those get a bucket of their own.
  window.PolarisWidgets.alertSeverityCounts = function (rows, severityOf) {
    var sevOf = severityOf || function (r) { return r && r.alertSeverity; };
    var counts = {};
    (rows || []).forEach(function (r) {
      var sev = sevOf(r);
      if (!sev || !window.PolarisWidgets.ALERT_SEVERITY_RANK[sev]) return;
      counts[sev] = (counts[sev] || 0) + 1;
    });
    return Object.keys(counts).map(function (sev) {
      return { severity: sev, count: counts[sev] };
    }).sort(function (a, b) {
      var d = window.PolarisWidgets.ALERT_SEVERITY_RANK[b.severity] - window.PolarisWidgets.ALERT_SEVERITY_RANK[a.severity];
      return d !== 0 ? d : a.severity.localeCompare(b.severity);
    });
  };

  // Header pills as a SEVERITY BREAKDOWN — one pill per active-alert severity
  // in the set, colored to that severity, most severe first, so the operator
  // reads "2 critical, 12 serious" off the title instead of one number colored
  // to the worst of them.
  //
  // CONVENTION (2026-08): callers pass the rows they are ABOUT TO RENDER — post
  // severity filter, post row limit / horizon / red guarantee — so the pills
  // count what is on screen at that moment. That deliberately differs from the
  // CSV export provider, which stays on the full matched set (its own menu
  // states the tier counts), and it means a row limit shrinks the pills: a
  // 10-row panel over a 40-node outage reads 10, not 40.
  //
  // opts.unalerted decides what happens to rows carrying no active alert:
  //   "neutral" (default) — a trailing grey pill counts them, so the pills
  //     still sum to the row total (Down Assets / Down Interfaces, where the
  //     total IS the headline). A set with NO alerting row at all keeps the
  //     plain red total pill rather than greying the whole count out.
  //   "omit" — dropped entirely (ranked top-N widgets, where the row count is
  //     just the operator's Row limit and a grey bucket is noise).
  // opts.severityOf overrides the feed-standard row.alertSeverity.
  window.PolarisWidgets.setHeaderSeverityCounts = function (el, rows, opts) {
    opts = opts || {};
    rows = rows || [];
    var counts = window.PolarisWidgets.alertSeverityCounts(rows, opts.severityOf);
    var pills = counts.map(function (c) {
      return {
        text: c.count,
        className: window.PolarisWidgets.alertSeverityPillClass(c.severity) || "widget-pill-watch",
        title: c.count + " with an active " + c.severity + " alert",
      };
    });
    if (opts.unalerted !== "omit") {
      if (!pills.length) { window.PolarisWidgets.setHeaderCount(el, rows.length, null); return; }
      var quiet = rows.length - counts.reduce(function (n, c) { return n + c.count; }, 0);
      if (quiet > 0) {
        pills.push({ text: quiet, className: "widget-pill-neutral", title: quiet + " with no active alert" });
      }
    }
    window.PolarisWidgets.setHeaderPills(el, pills);
  };

  // The same breakdown for a widget whose rows carry their OWN severity
  // vocabulary rather than the automation-alert ladder (Capacity Health's
  // ok/watch/amber/red reasons). Kept generic instead of teaching
  // ALERT_SEVERITY_RANK a second ladder — those two vocabularies must not blend,
  // or a capacity "red" would start ranking against an automation "critical" in
  // the minimum-severity filter and the export tiers.
  //
  // opts: { keyOf(row) → tier key, order: [most severe … least], classOf(key) →
  // widget-pill-* class, noun: "…" for the pill tooltip }. Tiers absent from the
  // set get no pill; an unknown key is ignored (same posture as the alert
  // ladder's unknown-severity drop).
  window.PolarisWidgets.setHeaderTierCounts = function (el, rows, opts) {
    opts = opts || {};
    var keyOf = opts.keyOf || function (r) { return r && r.severity; };
    var order = opts.order || [];
    var classOf = opts.classOf || function () { return "widget-pill-watch"; };
    var counts = {};
    (rows || []).forEach(function (r) {
      var k = keyOf(r);
      if (!k || order.indexOf(k) === -1) return;
      counts[k] = (counts[k] || 0) + 1;
    });
    window.PolarisWidgets.setHeaderPills(el, order.filter(function (k) { return counts[k]; }).map(function (k) {
      return {
        text: counts[k],
        className: classOf(k),
        title: counts[k] + " " + (opts.noun ? opts.noun + " " : "") + "at " + k,
      };
    }));
  };

  // ─── Severity-tier CSV export (widget header ⤓ button) ───────────────────
  // Client-side mirror of the server's ALERT_SEVERITY_RANK in
  // nocDashboardService.ts — the automation-alert ladder, with the audit-Event
  // levels folded in at their pill-equivalent ranks (info = informational,
  // error = critical), matching ALERT_SEV_PILL below.
  window.PolarisWidgets.ALERT_SEVERITY_RANK = {
    notice: 1, informational: 2, info: 2, warning: 3, serious: 4, error: 5, critical: 5,
  };

  // The severity ladder as operator-facing tiers, least→most severe. ONE list
  // feeds both the CSV-export menu and the gear popover's "Minimum severity"
  // display filter, so the two can never disagree about what "Serious and up"
  // means. `all` (rank 0) is the no-filter tier — every other tier requires a
  // row to carry an active alert at least that severe.
  window.PolarisWidgets.SEVERITY_TIERS = [
    { key: "all", label: "All rows", minRank: 0 },
    { key: "notice", label: "Notice and up", minRank: 1 },
    { key: "informational", label: "Informational and up", minRank: 2 },
    { key: "warning", label: "Warning and up", minRank: 3 },
    { key: "serious", label: "Serious and up", minRank: 4 },
    { key: "critical", label: "Critical only", minRank: 5 },
  ];

  function tierByKey(key) {
    var tiers = window.PolarisWidgets.SEVERITY_TIERS;
    for (var i = 0; i < tiers.length; i++) if (tiers[i].key === key) return tiers[i];
    return tiers[0];
  }

  // Export menu keeps its four historical tiers, in most-severe-first order.
  var EXPORT_TIERS = ["all", "critical", "serious", "warning"].map(tierByKey);

  // ─── Shared minimum-severity display filter ──────────────────────────────
  // `config.minSeverity` holds a SEVERITY_TIERS key ("all" = unset = show
  // everything). Every widget whose feed attaches an active-alert severity
  // (Down Assets, Down Interfaces, the top-N metric widgets, Storage Forecast)
  // renders the control via renderMinSeverityConfig and filters through
  // filterByMinSeverity. Filtering happens on the FETCHED set — before the row
  // limit, the red-guarantee pass, the header count and the CSV export — so
  // every number the widget shows agrees with what's on screen.
  //
  // Filtering client-side is safe because every one of those feeds is sorted
  // severity-first SERVER-side (severityFirst in nocDashboardService), so the
  // rows that qualify are the ones that survive the server's row cap.
  //
  // Note the semantics an operator gets above "All rows": a row with no active
  // alert ranks 0, so any real minimum hides un-alerted rows entirely. That's
  // the point of the control (a down-assets panel narrowed to what's actually
  // alerting), and the popover hint says so.
  window.PolarisWidgets.minSeverityRank = function (config) {
    if (!config || !config.minSeverity || config.minSeverity === "all") return 0;
    return tierByKey(config.minSeverity).minRank;
  };

  // rows → rows at/above the configured tier. severityOf defaults to the
  // feed-standard row.alertSeverity; the Active Alerts widget passes its own
  // (audit-Event level). Always returns a new array; no-ops at tier "all".
  window.PolarisWidgets.filterByMinSeverity = function (rows, config, severityOf) {
    rows = rows || [];
    var min = window.PolarisWidgets.minSeverityRank(config);
    if (!min) return rows.slice();
    var sevOf = severityOf || function (r) { return r.alertSeverity; };
    return rows.filter(function (r) {
      return (window.PolarisWidgets.ALERT_SEVERITY_RANK[sevOf(r)] || 0) >= min;
    });
  };

  // Inverse of minSeverityRank: the tier key a numeric rank floor maps to
  // (largest tier at/below the rank). Used to render pre-existing configs that
  // stored severity some other way — the Active Alerts widget's legacy
  // `severities` checkbox array folds into a tier through this.
  window.PolarisWidgets.severityTierForRank = function (rank) {
    var tiers = window.PolarisWidgets.SEVERITY_TIERS;
    var key = tiers[0].key;
    for (var i = 0; i < tiers.length; i++) if (tiers[i].minRank <= (rank || 0)) key = tiers[i].key;
    return key;
  };

  // Empty-state text for a widget emptied BY the severity filter — so the
  // operator reads "nothing at this severity" instead of "nothing is wrong".
  // Returns null at tier "all" (caller keeps its own empty text).
  window.PolarisWidgets.minSeverityEmptyText = function (config) {
    if (!window.PolarisWidgets.minSeverityRank(config)) return null;
    // Every tier key past "all" IS the severity name, so one phrasing covers
    // the whole ladder (critical being the top makes "or above" a no-op there).
    return "No rows at or above " + tierByKey(config.minSeverity).key + " severity";
  };

  // The active tier's operator-facing label ("Warning and up"), or null at tier
  // "all". Widget HEADERS append it so a severity-narrowed widget says what it
  // is now showing — a top-N metric widget filtered to alerting rows is no
  // longer "the highest N in the fleet", it's "the alerting ones, ranked".
  window.PolarisWidgets.severityTierLabel = function (config) {
    if (!window.PolarisWidgets.minSeverityRank(config)) return null;
    return tierByKey(config.minSeverity).label;
  };

  window.PolarisWidgets.minSeverityOptionsHTML = function (current) {
    var cur = current || "all";
    return window.PolarisWidgets.SEVERITY_TIERS.map(function (t) {
      return '<option value="' + t.key + '"' + (cur === t.key ? " selected" : "") + '>' + escapeHtml(t.label) + '</option>';
    }).join("");
  };

  // Append the "Minimum severity" control to a gear popover. Call it after the
  // widget's own controls and before renderNocFilterConfig, so the popover reads
  // widget-specific → severity → scope. `hint` overrides the default note.
  window.PolarisWidgets.renderMinSeverityConfig = function (el, config, onChange, hint) {
    config = config || {};
    var cur = config.minSeverity || "all";
    el.insertAdjacentHTML("beforeend", ''
      + '<label>Minimum severity</label>'
      + '<select data-minsev>' + window.PolarisWidgets.minSeverityOptionsHTML(cur) + '</select>'
      + '<p class="widget-config-hint" data-minsev-hint' + (cur === "all" ? ' style="display:none"' : '') + '>'
      + escapeHtml(hint || "Only rows with an active alert at or above this severity are shown.")
      + '</p>');
    var sel = el.querySelector("[data-minsev]");
    var note = el.querySelector("[data-minsev-hint]");
    if (!sel) return;
    sel.addEventListener("change", function () {
      if (note) note.style.display = sel.value === "all" ? "none" : "";
      onChange("minSeverity", sel.value);
    });
  };

  // downloadCsv is canonical in api.js (loaded on every surface incl. the
  // Dash wallboard) since the 2026-08 audit — the fallback copy is gone.
  function csvDownload(headers, rows, filename) {
    downloadCsv(headers, rows, filename);
  }

  function closeExportMenu() {
    var m = document.querySelector(".widget-export-menu");
    if (m) m.remove();
    document.removeEventListener("click", exportMenuDismiss, true);
    document.removeEventListener("keydown", exportMenuKey, true);
    document.removeEventListener("scroll", exportMenuScroll, true);
  }
  // Page scroll detaches the fixed-position menu from its button — close it.
  // Scrolls INSIDE a widget body are ignored: the NOC auto-scroll creeps
  // overflowing widget bodies continuously and must not dismiss the menu.
  function exportMenuScroll(ev) {
    var t = ev.target;
    if (t && t.closest && t.closest(".dashboard-widget-body")) return;
    closeExportMenu();
  }
  // Outside-click dismiss ignores the export buttons themselves so a click on
  // the owning button toggles (its own handler closes) instead of close+reopen.
  function exportMenuDismiss(ev) {
    var t = ev.target;
    if (t && t.closest && (t.closest(".widget-export-menu") || t.closest(".widget-header-export"))) return;
    closeExportMenu();
  }
  function exportMenuKey(ev) { if (ev.key === "Escape") closeExportMenu(); }

  function openExportMenu(btn) {
    var existing = document.querySelector(".widget-export-menu");
    var wasMine = existing && existing.__owner === btn;
    closeExportMenu();
    if (wasMine) return; // second click on the same button = toggle closed
    var provider = btn.__polarisExport;
    if (!provider || !provider.rows || !provider.rows.length) return;
    var sevOf = provider.severityOf || function (r) { return r.alertSeverity; };
    function rankOf(r) { return window.PolarisWidgets.ALERT_SEVERITY_RANK[sevOf(r)] || 0; }

    var menu = document.createElement("div");
    menu.className = "widget-export-menu";
    menu.__owner = btn;
    menu.innerHTML = '<div class="widget-export-menu-title">Export CSV</div>' +
      EXPORT_TIERS.map(function (t, i) {
        var n = provider.rows.filter(function (r) { return rankOf(r) >= t.minRank; }).length;
        return '<button type="button" data-tier="' + i + '"' + (n ? "" : " disabled") + '>' +
          '<span>' + t.label + '</span><span class="widget-export-count">' + n + '</span></button>';
      }).join("");
    document.body.appendChild(menu);
    var rect = btn.getBoundingClientRect();
    menu.style.top = (rect.bottom + 4) + "px";
    menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8)) + "px";

    menu.querySelectorAll("button[data-tier]").forEach(function (b) {
      b.addEventListener("click", function () {
        var tier = EXPORT_TIERS[parseInt(b.getAttribute("data-tier"), 10)];
        var rows = provider.rows.filter(function (r) { return rankOf(r) >= tier.minRank; });
        closeExportMenu();
        if (!rows.length) return;
        var headers = provider.columns.map(function (c) { return c.header; }).concat(["Severity"]);
        var data = rows.map(function (r) {
          return provider.columns.map(function (c) { return c.get(r); }).concat([sevOf(r) || ""]);
        });
        var filename = "polaris-" + provider.filename +
          (tier.key === "all" ? "" : "-" + tier.key) + "-" +
          new Date().toISOString().slice(0, 10) + ".csv";
        csvDownload(headers, data, filename);
        if (typeof showToast === "function") {
          showToast("Exported " + rows.length + " row" + (rows.length === 1 ? "" : "s") + " to " + filename);
        }
      });
    });
    document.addEventListener("click", exportMenuDismiss, true);
    document.addEventListener("keydown", exportMenuKey, true);
    document.addEventListener("scroll", exportMenuScroll, true);
  }

  // Stamp (or remove) a CSV-export button (⤓) on the widget's header, next to
  // the title. Re-call on every render tick with the FULL fetched row set —
  // pre row-limit clip, so "Warning and up" reaches rows the visual cap hides.
  // The menu offers severity tiers (All / Critical only / Serious and up /
  // Warning and up) filtered on each row's active-alert severity.
  // provider: {
  //   columns:    [{ header, get(row) }] — a trailing "Severity" column is
  //               appended automatically from severityOf
  //   rows:       the exportable row array
  //   filename:   kebab slug for the file name; defaults from the widget's
  //               data-type (topCpu → top-cpu)
  //   severityOf: (row) => severity string; default row.alertSeverity
  // }
  // No-ops outside a dashboard shell (library preview); zero rows removes the
  // button (mirrors setHeaderCount).
  window.PolarisWidgets.setHeaderExport = function (el, provider) {
    var article = el && el.closest ? el.closest(".dashboard-widget") : null;
    var header = article ? article.querySelector(".dashboard-widget-header") : null;
    var title = header ? header.querySelector(".dashboard-widget-title") : null;
    if (!title) return;
    var btn = header.querySelector(".widget-header-export");
    if (!provider || !provider.rows || !provider.rows.length) { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "dashboard-widget-action widget-header-export";
      btn.title = "Export CSV…";
      btn.textContent = "⤓";
      title.insertAdjacentElement("afterend", btn);
      btn.addEventListener("click", function (ev) {
        ev.stopPropagation();
        openExportMenu(btn);
      });
    }
    if (!provider.filename) {
      provider.filename = String(article.getAttribute("data-type") || "widget")
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
    }
    btn.__polarisExport = provider;
  };

  // The caller's effective region names, or [] when unrestricted. Used by the
  // Status Map (which fetches /map/sites, not /noc-summary).
  window.PolarisWidgets.myRegionNames = function () {
    return ((typeof currentEffectiveRegions !== "undefined" && currentEffectiveRegions) || []).slice();
  };

  // Resolve a widget config's region scope into the region-name list its own
  // fetch should filter by: "custom" → the widget's picked regions, "mine" →
  // the caller's effective regions, else null (= unfiltered). Used by the
  // Status Map / Device Map widgets, which fetch /map/sites directly instead
  // of riding getNocSummary.
  window.PolarisWidgets.regionNamesForConfig = function (config) {
    config = config || {};
    if (config.regionScope === "custom") return Array.isArray(config.regions) ? config.regions.slice() : [];
    if (config.regionScope === "mine") return window.PolarisWidgets.myRegionNames();
    return null;
  };

  // Picker options for the shared filter config, memoized for the page
  // lifetime (retried on failure). Sourced from /dashboard/filter-options —
  // one fetch feeds both the "Selected regions" list (the distinct
  // region:<name> tags reconcileMapRegions keeps stamped on live assets) and
  // the "Selected FortiGates" list (live firewall device names). The endpoint
  // is mounted on the dash listener's API allowlist, so both pickers also
  // work on the unauthenticated /dash wallboard.
  var _filterOptionsPromise = null;
  function getFilterOptions() {
    if (_filterOptionsPromise) return _filterOptionsPromise;
    // A widget rendered without the app shell's API client (an isolated
    // harness) gets empty pickers rather than a ReferenceError.
    if (typeof api === "undefined" || !api.dashboard || !api.dashboard.filterOptions) {
      return Promise.resolve({});
    }
    _filterOptionsPromise = api.dashboard.filterOptions()
      .catch(function () { _filterOptionsPromise = null; return {}; });
    return _filterOptionsPromise;
  }
  window.PolarisWidgets.getRegionOptions = function () {
    return getFilterOptions().then(function (d) { return (d && d.regions) || []; });
  };
  window.PolarisWidgets.getFortigateOptions = function () {
    return getFilterOptions().then(function (d) { return (d && d.fortigates) || []; });
  };

  // The asset-type vocabulary the gear grid offers, as [{value, label}]: every
  // built-in plus every CUSTOM registry type present in the fleet, labelled by
  // its registry row. Rides the SAME one-shot /dashboard/filter-options fetch
  // as the region and FortiGate pickers, so the grid costs no extra request
  // and works on the unauthenticated /dash wallboard.
  //
  // Why this exists: the grid used to be drawn from the static
  // BUILTIN_ASSET_TYPES list, so an operator-added type (network_camera, …)
  // had no checkbox — it showed in every widget's rows and could not be
  // switched off, no matter how many of them the fleet held. The static list
  // is still the seed and the fallback (a failed fetch, a logged-out page, a
  // pre-{name,label} server answering `string[]`).
  //
  // Registry labels are folded into ASSET_TYPE_LABELS by MUTATING it — the row
  // renderers (downNodes, downInterfaces) captured that object at load, so a
  // re-assignment would never reach them — and an existing key is never
  // overwritten, so the compact "AP" the widgets show survives the registry's
  // longer "Access Point".
  window.PolarisWidgets.getAssetTypeOptions = function () {
    var BUILTIN = window.PolarisWidgets.BUILTIN_ASSET_TYPES;
    var labels = window.PolarisWidgets.ASSET_TYPE_LABELS;
    var seed = function () {
      return BUILTIN.map(function (t) { return { value: t, label: labels[t] || t }; });
    };
    return getFilterOptions().then(function (d) {
      var rows = (d && d.assetTypes) || [];
      var out = [];
      var seen = {};
      rows.forEach(function (r) {
        var name = typeof r === "string" ? r : (r && r.name);
        if (!name || seen[name]) return;
        seen[name] = true;
        var label = (r && typeof r === "object" && r.label) || null;
        if (label && !Object.prototype.hasOwnProperty.call(labels, name)) labels[name] = label;
        out.push({ value: name, label: labels[name] || label || name });
      });
      // Every built-in is offered even on a fleet that owns none of that type,
      // so the grid doesn't gain and lose checkboxes as inventory changes.
      BUILTIN.forEach(function (t) {
        if (!seen[t]) { seen[t] = true; out.push({ value: t, label: labels[t] || t }); }
      });
      return out.length ? out : seed();
    }).catch(function () { return seed(); });
  };

  // Open an asset's details slide-in in place when the canonical slide-over
  // (openViewModal from assets.js) is loaded on the page — it is on the
  // dashboard (index.html pulls assets.js + deps), map, and assets pages.
  // Falls back to navigating to the Assets page with the view hash. Returns
  // true when it opened in place. opts.tab names the slide-over tab to land
  // on (openViewModal's opts.tab); the navigation fallback carries it as
  // #view=asset:<id>&tab=<key>, which processSearchHash hands back to
  // openViewModal on the Assets page.
  window.PolarisWidgets.openAssetDetail = function (id, opts) {
    if (!id) return false;
    opts = opts || {};
    if (typeof window.openViewModal === "function") { window.openViewModal(id, opts); return true; }
    // Dash wallboard (dash.html): the asset slide-over isn't loaded and there
    // is no session — navigating would bounce the kiosk to the login page.
    // Make the click a no-op instead.
    if (window.POLARIS_DASH_LOCAL) return false;
    window.location.href = "/assets.html#view=asset:" + encodeURIComponent(id) +
      (opts.tab ? "&tab=" + encodeURIComponent(opts.tab) : "");
    return false;
  };

  // ── Clicking a row that carries an ALERT ──────────────────────────────────
  //
  // A row on an outage widget is a prompt to do one of two things — put your
  // name on the alert, or go look at the device — so the click ASKS instead of
  // assuming the second. It only asks when asking is meaningful: an alert
  // nobody has yet, on a surface that can show a dialog, for an operator whose
  // role may actually acknowledge. Everything else goes straight to the device,
  // which is what the click did before this existed.
  //
  // Six ways it resolves to a plain open, and each is deliberate:
  //   • no live alert on the row      — a down device with no automation
  //                                     covering it (business rule 36's
  //                                     `passive`) has nothing to acknowledge
  //   • already acknowledged          — someone owns it; the row's own pill
  //                                     says so, and re-acknowledging is a
  //                                     no-op the server would skip
  //   • no showRowMenu / no modal     — the /dash wallboard loads neither
  //                                     app.js nor the ack modules
  //   • alerts < write                — withholding the verb beats a menu item
  //                                     that 403s (the row-menu canon: a verb
  //                                     you can't perform isn't offered).
  //                                     A COURTESY only — the route is the
  //                                     control, and the modal renders its
  //                                     refusal as a state either way
  //
  // opts: { assetId, alertId, alertAcknowledged, onAcknowledged }
  window.PolarisWidgets.openAssetRow = function (anchor, opts) {
    opts = opts || {};
    var openDevice = function () { window.PolarisWidgets.openAssetDetail(opts.assetId); };
    var canAck = typeof window.permAtLeast !== "function" || window.permAtLeast("alerts", "write");
    if (!opts.alertId || opts.alertAcknowledged || !canAck
        || typeof window.showRowMenu !== "function"
        || !window.PolarisAlertAckModal || !window.openModal) {
      openDevice();
      return false;
    }
    window.showRowMenu(anchor, [
      {
        label: "Acknowledge alert…",
        title: "Put your name on this alert without leaving the dashboard",
        onSelect: function () {
          window.PolarisAlertAckModal.open(opts.alertId, {
            onAcknowledged: opts.onAcknowledged,
            onOpenDevice: openDevice,
          });
        },
      },
      { label: "Open device", onSelect: openDevice },
    ], { label: "Alert actions" });
    return true;
  };

  // Append the shared per-widget filter controls into a gear-popover container.
  // Region scope (All / My regions / Selected regions) goes on every NOC
  // widget; "Selected regions" reveals a checkbox list of the created regions
  // (none checked = unfiltered, mirroring the asset-type grid). On the
  // unauthenticated /dash wallboard "My regions" is hidden — there is no
  // viewer identity for it to resolve against (a saved "mine" renders and
  // behaves as "all" there). The asset-type toggle grid AND the FortiGates
  // scope (All / Selected FortiGates — narrows to assets behind the picked
  // gates, e.g. one site's switches/APs) are added only when includeAssetTypes
  // is true (every NOC widget except the maps, which fetch /map/sites and
  // don't ride the noc-summary filter).
  // The type grid is painted TWICE: once synchronously from the built-in list
  // so the popover is never empty, then again when getAssetTypeOptions()
  // resolves and adds the custom registry types present in the fleet. A toggle
  // made before that lands is kept (the repaint reads the live off-list, not
  // the config snapshot).
  // onChange(key, value) is the widget's config setter — key is "regionScope"/
  // "fortigateScope" (string), "regions"/"fortigates" (string[]),
  // "assetTypesOff" (string[] — the switched-off types, what the filter is
  // actually stored as) or "assetTypes" (string[] — the checked list, kept in
  // step for the header title and for a config read by older bundles).
  // Appends, so a widget can render its own controls first, then call this.
  window.PolarisWidgets.renderNocFilterConfig = function (el, config, onChange, includeAssetTypes) {
    config = config || {};
    var labels = window.PolarisWidgets.ASSET_TYPE_LABELS;
    var BUILTIN = window.PolarisWidgets.BUILTIN_ASSET_TYPES;
    var onDash = window.POLARIS_DASH_LOCAL === true;
    var scope = config.regionScope === "custom" ? "custom"
      : (config.regionScope === "mine" && !onDash) ? "mine"
      : "all";
    var fgScope = config.fortigateScope === "custom" ? "custom" : "all";
    var html = ''
      + '<label class="widget-config-label">Regions</label>'
      + '<select class="widget-config-select" data-nocf="regionScope">'
      +   '<option value="all"' + (scope === "all" ? " selected" : "") + '>All regions</option>'
      +   (onDash ? '' : '<option value="mine"' + (scope === "mine" ? " selected" : "") + '>My regions</option>')
      +   '<option value="custom"' + (scope === "custom" ? " selected" : "") + '>Selected regions…</option>'
      + '</select>'
      + '<div class="widget-config-typegrid" data-nocf="regionList" style="display:none"></div>';
    if (includeAssetTypes) {
      html += '<label class="widget-config-label">FortiGates</label>'
        + '<select class="widget-config-select" data-nocf="fortigateScope">'
        +   '<option value="all"' + (fgScope === "all" ? " selected" : "") + '>All FortiGates</option>'
        +   '<option value="custom"' + (fgScope === "custom" ? " selected" : "") + '>Selected FortiGates…</option>'
        + '</select>'
        + '<div class="widget-config-typegrid widget-config-fglist" data-nocf="fortigateList" style="display:none"></div>';
      html += '<label class="widget-config-label">Asset types</label>'
        + '<div class="widget-config-typegrid" data-nocf="typeList"></div>';
    }
    el.insertAdjacentHTML("beforeend", html);

    // Live copy of the filter keys this popover edits. updateConfig replaces
    // the widget's config object, so the `config` snapshot we closed over
    // goes stale after the first change — `live` is what the FortiGate list
    // reads to filter by the CURRENT region selection (and what repaints
    // read for checked state).
    var live = {
      regionScope: scope,
      regions: Array.isArray(config.regions) ? config.regions.slice() : [],
      fortigateScope: fgScope,
      fortigates: Array.isArray(config.fortigates) ? config.fortigates.slice() : [],
    };
    function setCfg(key, value) {
      if (Object.prototype.hasOwnProperty.call(live, key)) live[key] = value;
      onChange(key, value);
      // A region change re-filters which gates the FortiGate list offers.
      if ((key === "regionScope" || key === "regions") && repaintFortigates) repaintFortigates(true);
    }
    var repaintFortigates = null;

    // Wire one scope <select> + its "Selected …" checkbox list. The list is
    // shown/populated only while scope is "custom"; checkbox handlers re-read
    // the live DOM. getOptions resolves to strings or {value, label} entries
    // (label shown, value stored) and is re-invoked on forced repaints (the
    // FortiGate list re-filters when the region pick changes). Returns the
    // paint function; paint(true) rebuilds even when already painted.
    function wireScopePicker(scopeAttr, listAttr, listKey, getOptions, emptyMsg) {
      var sel = el.querySelector('[data-nocf="' + scopeAttr + '"]');
      var listEl = el.querySelector('[data-nocf="' + listAttr + '"]');
      if (!sel) return function () {};
      function paintList(force) {
        if (!listEl) return;
        if (sel.value !== "custom") { listEl.style.display = "none"; return; }
        listEl.style.display = "";
        if (listEl.childElementCount && !force) return;
        getOptions().then(function (entries) {
          if (!listEl.isConnected || sel.value !== "custom") return;
          if (!entries.length) {
            listEl.innerHTML = '<p style="grid-column:1/-1;font-size:0.8rem;color:var(--color-text-secondary);margin:2px 0">'
              + emptyMsg + '</p>';
            return;
          }
          var opts = entries.map(function (e) {
            return typeof e === "string" ? { value: e, label: e } : e;
          });
          // Drop selections the (re-filtered) list no longer offers so the
          // saved config always mirrors what the operator can see. Skipped
          // when the option fetch came back empty (a failed fetch must not
          // wipe a saved pick).
          var selected = Array.isArray(live[listKey]) ? live[listKey] : [];
          var visible = selected.filter(function (v) {
            return opts.some(function (o) { return o.value === v; });
          });
          if (visible.length !== selected.length) setCfg(listKey, visible);
          selected = visible;
          listEl.innerHTML = opts.map(function (o, i) {
            return '<label class="widget-config-typeopt">'
              + '<input type="checkbox" data-nocopt="' + i + '"' + (selected.indexOf(o.value) !== -1 ? " checked" : "") + '> '
              + escapeHtml(o.label) + '</label>';
          }).join("");
          var boxes = listEl.querySelectorAll("[data-nocopt]");
          Array.prototype.forEach.call(boxes, function (cb) {
            cb.addEventListener("change", function () {
              var current = [];
              Array.prototype.forEach.call(boxes, function (b) {
                if (b.checked) current.push(opts[parseInt(b.getAttribute("data-nocopt"), 10)].value);
              });
              setCfg(listKey, current);
            });
          });
        });
      }
      sel.addEventListener("change", function () {
        setCfg(scopeAttr, sel.value);
        paintList();
      });
      paintList();
      return paintList;
    }

    wireScopePicker(
      "regionScope", "regionList", "regions",
      window.PolarisWidgets.getRegionOptions,
      'No regions found — draw regions on the Device Map first.',
    );
    if (includeAssetTypes) {
      repaintFortigates = wireScopePicker(
        "fortigateScope", "fortigateList", "fortigates",
        function () {
          return window.PolarisWidgets.getFortigateOptions().then(function (gates) {
            if (!gates.length) return [];
            // Narrow the offered gates to the widget's CURRENT region scope
            // (a gate matches when it carries any selected region's tag); no
            // region narrowing = every gate. "(No FortiGate)" (server
            // sentinel __none__) is always offered so switches/APs with no
            // associated gate stay selectable — including inside a region.
            var regions = null;
            if (live.regionScope === "custom") regions = live.regions;
            else if (live.regionScope === "mine" && !onDash) regions = window.PolarisWidgets.myRegionNames();
            var offered = gates;
            if (regions && regions.length) {
              offered = gates.filter(function (g) {
                var rs = g.regions || [];
                for (var i = 0; i < rs.length; i++) {
                  if (regions.indexOf(rs[i]) !== -1) return true;
                }
                return false;
              });
            }
            return [{ value: "__none__", label: "(No FortiGate)" }].concat(
              offered.map(function (g) { return { value: g.name, label: g.name }; }),
            );
          });
        },
        'No FortiGates found — run a FortiManager / FortiGate discovery first.',
      );
    }

    if (includeAssetTypes) {
      // The off-list is the state this grid edits. Seeded from the stored
      // config through the same resolver the query path uses, so a config
      // saved before a built-in existed shows that type CHECKED — matching
      // the rows the widget actually renders.
      var liveOff = hiddenAssetTypes(config);
      var typeGrid = el.querySelector('[data-nocf="typeList"]');

      function paintTypeGrid(options) {
        typeGrid.innerHTML = options.map(function (o) {
          var off = liveOff.indexOf(o.value) !== -1;
          return '<label class="widget-config-typeopt">'
            + '<input type="checkbox" data-noctype="' + escapeHtml(o.value) + '"' + (off ? "" : " checked") + '> '
            + escapeHtml(o.label) + '</label>';
        }).join("");
        var boxes = typeGrid.querySelectorAll("[data-noctype]");
        Array.prototype.forEach.call(boxes, function (cb) {
          cb.addEventListener("change", function () {
            var on = [];
            var offered = {};
            var off = [];
            Array.prototype.forEach.call(boxes, function (b) {
              var t = b.getAttribute("data-noctype");
              offered[t] = true;
              if (b.checked) on.push(t); else off.push(t);
            });
            // A type the grid doesn't offer (switched off while it was in the
            // fleet, since decommissioned) stays hidden rather than silently
            // switching itself back on.
            liveOff.forEach(function (t) { if (!offered[t] && off.indexOf(t) === -1) off.push(t); });
            liveOff = off;
            onChange("assetTypesOff", off);
            // The checked list is what the header title names, and it is what
            // an older bundle reading this config would filter on — keep the
            // two in step rather than leaving a stale enabled list behind.
            onChange("assetTypes", on);
          });
        });
      }

      // Built-ins now (the popover is never empty), then the full vocabulary —
      // built-ins plus the custom registry types present in the fleet — once
      // /dashboard/filter-options answers.
      paintTypeGrid(BUILTIN.map(function (t) { return { value: t, label: labels[t] || t }; }));
      window.PolarisWidgets.getAssetTypeOptions().then(function (options) {
        if (typeGrid.isConnected === false) return; // popover closed while we waited
        if (options.length > BUILTIN.length) paintTypeGrid(options);
      }).catch(function () { /* keep the built-in grid */ });
    }
  };

  // RFC4122 v4 (good-enough; not crypto). Used for widget instance ids.
  window.PolarisWidgets.uuid = function () {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  };

  // Shared label/color maps for asset types (used by Monitor Alerts + Assets by Type).
  window.PolarisWidgets.ASSET_TYPE_LABELS = {
    server: "Server", switch: "Switch", router: "Router", firewall: "Firewall",
    workstation: "Workstation", printer: "Printer", access_point: "AP", other: "Other",
    hypervisor: "Hypervisor", kubernetes_cluster: "K8s Cluster",
  };
  window.PolarisWidgets.ASSET_TYPE_COLORS = {
    server: "#4fc3f7", switch: "#26c6da", router: "#7e57c2", firewall: "#ef5350",
    workstation: "#66bb6a", printer: "#ffa726", access_point: "#ab47bc", other: "#90a4ae",
    hypervisor: "#5c6bc0", kubernetes_cluster: "#00897b",
  };

  // Display name for ANY asset type, including one this bundle has never heard
  // of. A row used to print an operator-added type's stored value verbatim
  // ("network_camera") because the static map was the only source; a custom
  // type is now humanized ("Network Camera") and, once a gear popover has
  // pulled /dashboard/filter-options, named by its actual registry label.
  window.PolarisWidgets.assetTypeLabel = function (t, fallback) {
    if (!t) return fallback || "";
    var labels = window.PolarisWidgets.ASSET_TYPE_LABELS;
    if (labels[t]) return labels[t];
    return String(t).replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
  };

  // ─── Widget header title ─────────────────────────────────────────────────
  // The name a widget INSTANCE wears on the canvas, derived from its
  // registration plus the two gear controls that change what it's showing:
  //
  //   • asset-type filter — a narrowed grid is named in parens, whichever way
  //     is shorter: the types SHOWN ("Highest Avg CPU (Server, Switch)") or,
  //     when fewer are off than on, the ones switched off ("Down Assets (excl.
  //     Printer, Camera)"). Hiding one type out of a dozen shouldn't spend the
  //     whole header listing the eleven that remain. All-on / unset → bare.
  //   • minimum severity — the tier is appended ("… — Warning and up"), and a
  //     widget may declare a `severityLabel` to swap its base label: a top-N
  //     metric widget narrowed to alerting rows is no longer showing the
  //     fleet's highest values (nor even ranking purely by value — those feeds
  //     sort severity-first), so keeping the superlative would name something
  //     the widget is not doing. Widgets whose label carries no superlative
  //     ("Down Assets", "Packet Loss") declare none and just gain the tier.
  //
  // Lives here rather than in dashboard.js because it reads the registry's own
  // catalogs, and because dashboard.js is a boot IIFE with no seam to test.
  window.PolarisWidgets.widgetTitle = function (module, w) {
    var cfg = (w && w.config) || {};
    var tier = window.PolarisWidgets.severityTierLabel(cfg);
    var base = module
      ? ((tier && module.severityLabel) || module.label)
      : ((w && w.type) + " (unknown widget)");
    var BUILTIN = window.PolarisWidgets.BUILTIN_ASSET_TYPES || [];
    var hidden = hiddenAssetTypes(cfg);
    if (hidden.length > 0) {
      var name = function (t) { return window.PolarisWidgets.assetTypeLabel(t); };
      // Built-ins first in canonical order, then custom types — the grid's own
      // order, so the header reads in the order the checkboxes are laid out.
      var inGridOrder = function (list) {
        return BUILTIN.filter(function (t) { return list.indexOf(t) !== -1; })
          .concat(list.filter(function (t) { return BUILTIN.indexOf(t) === -1; }));
      };
      // What's left ON: the grid's checked list when it wrote one (it names
      // custom types too), else the built-ins that aren't hidden.
      var shown = inGridOrder((Array.isArray(cfg.assetTypes) && cfg.assetTypes.length > 0
        ? cfg.assetTypes
        : BUILTIN
      ).filter(function (t) { return hidden.indexOf(t) === -1; }));
      hidden = inGridOrder(hidden);
      if (shown.length === 0) base += " (no types)";
      else if (hidden.length < shown.length) base += " (excl. " + hidden.map(name).join(", ") + ")";
      else base += " (" + shown.map(name).join(", ") + ")";
    }
    if (tier) base += " — " + tier;
    return base;
  };

  // Severity pill for rows whose asset carries an active automation alert
  // (feeds attach alertSeverity/alertRank and sort severity-first). Palette
  // mirrors the canonical badge-level-* scale used on the Automations page /
  // wizard / Alerts tab so a severity reads identically everywhere: notice →
  // grey, informational → blue, warning → yellow, serious → ORANGE,
  // critical → RED. (Previously serious collapsed into the same red as
  // critical, which disagreed with the Automations page.)
  var ALERT_SEV_PILL = {
    notice: "widget-pill-neutral",
    informational: "widget-pill-watch", info: "widget-pill-watch",
    warning: "widget-pill-amber",
    serious: "widget-pill-orange",
    critical: "widget-pill-red", error: "widget-pill-red",
  };
  window.PolarisWidgets.alertSeverityPill = function (sev) {
    if (!sev) return "";
    var cls = ALERT_SEV_PILL[sev] || "widget-pill-watch";
    return '<span class="widget-pill ' + cls + '" title="Highest active alert: ' + escapeHtml(sev) + '" style="margin-right:4px;flex:0 0 auto">' + escapeHtml(String(sev)) + '</span>';
  };

  // Just the pill class for a severity (null when unknown/absent) — lets count
  // pills reuse the row palette without rendering a labeled pill.
  window.PolarisWidgets.alertSeverityPillClass = function (sev) {
    return (sev && ALERT_SEV_PILL[sev]) || null;
  };

  // Highest active-alert severity across a row set (null when no row carries
  // one). Rows attach `alertSeverity` from the noc-summary feeds.
  window.PolarisWidgets.maxAlertSeverity = function (rows) {
    var best = null;
    var bestRank = 0;
    (rows || []).forEach(function (r) {
      var sev = r && r.alertSeverity;
      var rank = (sev && window.PolarisWidgets.ALERT_SEVERITY_RANK[sev]) || 0;
      if (sev && rank > bestRank) { best = sev; bestRank = rank; }
    });
    return best;
  };

  // Full class string for a count pill summarizing a row set: colored to the
  // set's most severe active alert so a group of `serious` rows gets an orange
  // count instead of the flat red that read as `critical`. Falls back to red
  // when NO row carries an alert — there's no severity to honor there, and red
  // stays the widgets' generic "these are down" count.
  window.PolarisWidgets.countPillClass = function (rows) {
    var cls = window.PolarisWidgets.alertSeverityPillClass(window.PolarisWidgets.maxAlertSeverity(rows));
    return "widget-pill " + (cls || "widget-pill-red");
  };

  // Bar-fill color for an alerting row, matching the pill's own text color
  // one-for-one (keep in lockstep with ALERT_SEV_PILL above + the
  // .widget-pill-* rules in styles.css). The _topnBar / Storage Forecast bars
  // color by static value thresholds, which disagrees with the pill whenever an
  // operator's automation threshold isn't the widget's — a 77 °C row pilled
  // `critical` drew the widget's yellow 65–80 band. When a row carries an
  // active alert the ALERT is the authoritative signal, so its severity wins;
  // un-alerted rows keep their value-threshold color.
  var ALERT_SEV_BAR = {
    notice: "var(--color-sev-notice)",
    informational: "#4fc3f7", info: "#4fc3f7",
    warning: "#ffd54f",
    serious: "var(--color-sev-serious)",
    critical: "#ef5350", error: "#ef5350",
  };
  window.PolarisWidgets.alertSeverityBarColor = function (sev) {
    if (!sev) return null;
    return ALERT_SEV_BAR[sev] || null;
  };

  // "5m 03s" / "2h 17m" / "3d 4h" — same shape the legacy dashboard used.
  window.PolarisWidgets.durationSince = function (iso) {
    if (!iso) return "—";
    var diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (diff < 60) return diff + "s";
    if (diff < 3600) {
      var m = Math.floor(diff / 60);
      var s = diff % 60;
      return m + "m " + (s < 10 ? "0" + s : s) + "s";
    }
    if (diff < 86400) {
      var h = Math.floor(diff / 3600);
      var rm = Math.floor((diff % 3600) / 60);
      return h + "h " + (rm < 10 ? "0" + rm : rm) + "m";
    }
    var d = Math.floor(diff / 86400);
    var rh = Math.floor((diff % 86400) / 3600);
    return d + "d " + rh + "h";
  };
})();
