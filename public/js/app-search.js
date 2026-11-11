/**
 * public/js/app-search.js — Global search: the sidebar search box, its settings gear, the active-alert
 * indicator (assetAlertDotHTML / alertSummaryDotHTML — here because the
 * dropdown renders on every page), recent searches, drafts, keyboard nav and
 * the #search= deep link.
 *
 * Part of the app.js shell (CQ-F051): plain browser scripts sharing page
 * globals, loaded on every app page in APP_FILES order (app.js first,
 * app-boot.js last). See tests/unit/appSplit.test.ts.
 */

// ─── Global search ──────────────────────────────────────────────────────────
// Injects a search input into .page-header on every authenticated page. Ctrl/Cmd+K
// focuses it; typing queries /api/v1/search and renders a grouped dropdown.

var _searchDebounceTimer = null;
var _searchLastQuery = "";
var _searchActiveResults = null;

function _searchPlaceholder() {
  var path = window.location.pathname;
  if (path.indexOf("/assets.html") !== -1) return "Search assets, hostnames, MACs, serials…";
  if (path.indexOf("/subnets.html") !== -1) return "Search networks, CIDRs, reservations, IPs…";
  if (path.indexOf("/blocks.html") !== -1) return "Search blocks, CIDRs, networks…";
  if (path.indexOf("/events.html") !== -1) return "Search everything — IPs, MACs, hosts, assets…";
  return "Search IPs, CIDRs, hosts, MACs, assets… (Ctrl+K)";
}

function renderGlobalSearch() {
  var pageHeader = document.querySelector(".page-header");
  if (!pageHeader) return;
  if (pageHeader.querySelector(".global-search")) return; // already mounted

  // The Ctrl+K shortcut below, advertised in the box. CSS shows it only while
  // the box is empty and unfocused, so it never sits under typed text, the
  // clear button or the spinner; aria-keyshortcuts says it to a screen reader.
  var nav = typeof navigator !== "undefined" ? navigator : {};
  var mac = /Mac|iPhone|iPad/.test(nav.platform || nav.userAgent || "");
  var wrap = document.createElement("div");
  wrap.className = "global-search";
  wrap.innerHTML =
    '<input type="search" id="global-search-input" autocomplete="off" spellcheck="false" placeholder="' + escapeHtml(_searchPlaceholder()) + '"' +
      ' aria-keyshortcuts="' + (mac ? "Meta+K" : "Control+K") + '">' +
    '<kbd class="global-search-kbd" aria-hidden="true">' + (mac ? "⌘ K" : "Ctrl K") + '</kbd>' +
    '<span id="global-search-spinner" class="global-search-spinner" hidden aria-hidden="true"></span>' +
    '<button type="button" id="global-search-gear" class="global-search-gear" title="Search settings" aria-label="Search settings" aria-haspopup="dialog" aria-expanded="false">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true">' +
      '<circle cx="12" cy="12" r="3"/>' +
      '<path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/>' +
      '</svg></button>' +
    '<div id="global-search-dropdown" class="global-search-dropdown" style="display:none"></div>' +
    '<div id="global-search-settings" class="global-search-settings" role="dialog" aria-label="Search settings" hidden></div>';

  // Insert between h2 and page-header-actions (if present)
  var actions = pageHeader.querySelector(".page-header-actions");
  if (actions) pageHeader.insertBefore(wrap, actions);
  else pageHeader.appendChild(wrap);

  var input = document.getElementById("global-search-input");
  var dropdown = document.getElementById("global-search-dropdown");

  input.addEventListener("input", function () {
    var q = input.value.trim();
    saveSearchDraft(input.value);
    clearTimeout(_searchDebounceTimer);
    if (q.length < 2) {
      // Empty input → fall back to the focus-state shortcut hints so
      // operators see the scope abbreviations again the moment they
      // clear the box. A 1-char query still hides the dropdown so
      // accidental keystrokes don't flash the hint panel.
      if (q.length === 0) _showSearchShortcutHints();
      else { dropdown.style.display = "none"; dropdown.innerHTML = ""; }
      _searchLastQuery = "";
      _searchActiveResults = null;
      _setSearchBusy(false);
      return;
    }
    _searchDebounceTimer = setTimeout(function () { _performSearch(q); }, 180);
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { input.blur(); _hideSearchDropdown(); return; }
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter") {
      _handleSearchKeyNav(e);
    }
  });

  // An empty box always opens on the shortcuts (and the recent searches
  // above them) — never on an earlier query's results, which would be
  // results for text no longer in the box. Text still in the box (the
  // operator clicked away without picking) brings its results back; text
  // restored from the draft on a new page has none cached yet, so it is
  // searched again. Focus never selects the text — the operator clicks to
  // place the cursor, and Ctrl/⌘+A (native; nothing intercepts it in a
  // field — see _rowSelectKeyTbody) selects it all to overwrite.
  input.addEventListener("focus", function () {
    _hideSearchSettings();
    var q = input.value.trim();
    if (!q) _showSearchShortcutHints();
    else if (_searchActiveResults) dropdown.style.display = "block";
    // A bare scope prefix (a shortcut hint just clicked) is not a query yet:
    // leave the hints up.
    else if (q.length >= 2 && !/^\w+:$/.test(q)) _performSearch(q);
  });
  _restoreSearchDraft(input);

  var gear = document.getElementById("global-search-gear");
  gear.addEventListener("click", function (e) {
    e.stopPropagation();
    var panel = document.getElementById("global-search-settings");
    if (panel.hidden) { _showSearchSettings(); return; }
    _hideSearchSettings();
    if (input.value.trim() && _searchActiveResults) dropdown.style.display = "block";
  });
  _syncSearchGear();

  document.addEventListener("click", function (e) {
    if (!wrap.contains(e.target)) { _hideSearchDropdown(); _hideSearchSettings(); }
  });
  document.addEventListener("keydown", function (e) {
    var panel = document.getElementById("global-search-settings");
    if (e.key === "Escape" && panel && !panel.hidden) { _hideSearchSettings(); gear.focus(); }
  });

  // Ctrl+K / Cmd+K — focus the search globally
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
}

// ─── Global search settings (the gear) ──────────────────────────────────────
// Which assets the box returns: monitored and/or unmonitored, and which
// lifecycle states. Per user, kept in this browser under the same
// "polaris-prefs-<name>-<username>" shape as the asset panel's chart prefs.
// Narrows the Assets and Device Map groups only — blocks, networks,
// reservations, IPs and IPsec hits are not assets and are never filtered.
// The server applies it (searchService's SearchAssetFilter), so a scoped
// `a:` search's 200-row budget is spent on rows that will be shown.

var SEARCH_MONITORED_OPTIONS = [
  { value: "monitored",   label: "Monitored" },
  { value: "unmonitored", label: "Unmonitored" },
];
var SEARCH_STATUS_OPTIONS = [
  { value: "active",         label: "Active" },
  { value: "maintenance",    label: "Maintenance" },
  { value: "storage",        label: "Storage" },
  { value: "decommissioned", label: "Decommissioned" },
  { value: "disabled",       label: "Disabled" },
  { value: "quarantined",    label: "Quarantined" },
];
var SEARCH_DEFAULT_PREFS = { monitored: ["monitored", "unmonitored"], status: ["active", "maintenance"] };

function _searchPrefsKey() {
  return "polaris-prefs-search-" + (typeof currentUsername === "string" && currentUsername ? currentUsername : "");
}

/** The signed-in user's search filter, { monitored: [...], status: [...] }. */
function loadSearchPrefs() {
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(_searchPrefsKey()) || "null"); } catch (_) {}
  // Unknown values are dropped (an option renamed since it was saved); a
  // missing or malformed list falls back to its default, an empty one stays.
  function pick(list, options, fallback) {
    if (!Array.isArray(list)) return fallback.slice();
    return options.map(function (o) { return o.value; }).filter(function (v) { return list.indexOf(v) !== -1; });
  }
  return {
    monitored: pick(stored && stored.monitored, SEARCH_MONITORED_OPTIONS, SEARCH_DEFAULT_PREFS.monitored),
    status: pick(stored && stored.status, SEARCH_STATUS_OPTIONS, SEARCH_DEFAULT_PREFS.status),
  };
}

function saveSearchPrefs(p) {
  try { localStorage.setItem(_searchPrefsKey(), JSON.stringify(p)); } catch (_) {}
}

function _searchPrefsAreDefault(p) {
  return p.monitored.join(",") === SEARCH_DEFAULT_PREFS.monitored.join(",") &&
    p.status.join(",") === SEARCH_DEFAULT_PREFS.status.join(",");
}

// The gear takes the accent colour while the filter differs from the
// default, so a search that "can't find" a device points at the reason.
function _syncSearchGear() {
  var gear = document.getElementById("global-search-gear");
  if (!gear) return;
  var custom = !_searchPrefsAreDefault(loadSearchPrefs());
  gear.classList.toggle("is-custom", custom);
  gear.title = custom ? "Search settings (changed from the default)" : "Search settings";
}

function _showSearchSettings() {
  var panel = document.getElementById("global-search-settings");
  var gear = document.getElementById("global-search-gear");
  if (!panel) return;
  _hideSearchDropdown();
  var p = loadSearchPrefs();
  function boxes(key, options) {
    return options.map(function (o) {
      return '<label class="gs-setting"><input type="checkbox" data-pref="' + key + '" value="' + o.value + '"' +
        (p[key].indexOf(o.value) !== -1 ? " checked" : "") + '> ' + escapeHtml(o.label) + '</label>';
    }).join("");
  }
  panel.innerHTML =
    '<div class="gs-group-label">Assets</div>' +
    '<div class="gs-settings-grid">' + boxes("monitored", SEARCH_MONITORED_OPTIONS) + '</div>' +
    '<div class="gs-group-label">Device states</div>' +
    '<div class="gs-settings-grid">' + boxes("status", SEARCH_STATUS_OPTIONS) + '</div>' +
    '<div class="gs-settings-foot">' +
      '<span>Applies to asset and Device Map results</span>' +
      '<button type="button" class="btn btn-sm btn-secondary" id="global-search-settings-reset">Reset to defaults</button>' +
    '</div>';
  panel.hidden = false;
  if (gear) gear.setAttribute("aria-expanded", "true");

  function onChange() {
    var next = { monitored: [], status: [] };
    panel.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      if (cb.checked) next[cb.getAttribute("data-pref")].push(cb.value);
    });
    saveSearchPrefs(next);
    _syncSearchGear();
    // A query already in the box is re-run under the new filter, so the
    // results are current the moment the panel closes.
    var input = document.getElementById("global-search-input");
    var q = input ? input.value.trim() : "";
    if (q.length >= 2) _performSearch(q);
  }
  panel.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
    cb.addEventListener("change", onChange);
  });
  document.getElementById("global-search-settings-reset").addEventListener("click", function () {
    panel.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
      cb.checked = SEARCH_DEFAULT_PREFS[cb.getAttribute("data-pref")].indexOf(cb.value) !== -1;
    });
    onChange();
  });
}

function _hideSearchSettings() {
  var panel = document.getElementById("global-search-settings");
  var gear = document.getElementById("global-search-gear");
  if (panel) panel.hidden = true;
  if (gear) gear.setAttribute("aria-expanded", "false");
}

// Toggle the in-flight spinner on the right edge of the search bar.
function _setSearchBusy(busy) {
  var spinner = document.getElementById("global-search-spinner");
  if (spinner) spinner.hidden = !busy;
}

async function _performSearch(q) {
  var dropdown = document.getElementById("global-search-dropdown");
  _searchLastQuery = q;
  _setSearchBusy(true);
  try {
    var results = await api.search.query(q, loadSearchPrefs());
    if (results.query !== _searchLastQuery) return; // stale response — a newer query owns the spinner
    _searchActiveResults = results;
    _renderSearchDropdown(results);
    // Re-run from the gear panel: the results wait behind it until it closes.
    var settings = document.getElementById("global-search-settings");
    if (settings && !settings.hidden) _hideSearchDropdown();
    _setSearchBusy(false);
  } catch (err) {
    if (q !== _searchLastQuery) return; // stale failure — don't clear a newer query's spinner
    dropdown.innerHTML = '<div class="global-search-empty">Search failed: ' + escapeHtml(err.message || "Unknown error") + '</div>';
    dropdown.style.display = "block";
    _setSearchBusy(false);
  }
}

// ─── Active-alert indicator ──────────────────────────────────────────────────
//
// Lives here rather than in assets.js because THREE surfaces draw it and only
// one of them is the assets page: the Assets list's Name column, the asset
// slide-over's Alerts tab, and the global search dropdown — which renders on
// every page, half of which never load assets.js. A guarded call from there
// would have shown the dot on some pages and not others, which is worse than
// not showing it at all.
//
// A dot beside the hostname in the Assets list, and the slide-over's Alerts tab
// itself, both saying "something is wrong with this device" in the colour of
// the WORST active alert on it. The animation lives in styles.css
// (.alert-strobe-* — including the prefers-reduced-motion opt-out); all these
// decide is the colour and whether it should be moving.
//
// Two properties worth keeping:
//   • THE COLOUR IS THE SAME VOCABULARY EVERYWHERE. assetAlertStrobeColor maps
//     each severity onto the SAME --color-sev-* token the .badge-level-* pills
//     and the acknowledge card read, so an alert looks the same severity in the
//     list, in the tab, in the slide-over table and in the email. An unknown
//     severity falls back to the danger token rather than to nothing: Polaris
//     is still asserting something is wrong, and a colourless indicator
//     understates that (business rule 36's posture on an unresolved severity).
//   • IT STROBES ONLY WHILE SOMETHING IS UNACKNOWLEDGED. An acknowledged alert
//     is still active and still marked — it has just stopped asking, which is
//     what keeps a wallboard of pulsing dots from becoming background noise.

/** Severity → the CSS colour the indicator takes. */
function assetAlertStrobeColor(severity) {
  var token = {
    notice: "--color-sev-notice",
    informational: "--color-sev-informational",
    info: "--color-sev-informational",
    warning: "--color-sev-warning",
    serious: "--color-sev-serious",
    error: "--color-sev-critical",
    critical: "--color-sev-critical",
  }[severity];
  return "var(" + (token || "--color-sev-critical") + ")";
}

/**
 * Severity rank, mirroring ALERT_SEVERITY_RANK in src/utils/alertSeverity.ts.
 * The browser cannot import that, and the server-side copy is what picks the
 * colour of the LIST's indicator — so the two must agree that `serious`
 * outranks `warning` or a device would strobe one colour in the list and
 * another in its own slide-over.
 */
function _alertSevRank(sev) {
  return { notice: 1, informational: 2, info: 2, warning: 3, serious: 4, error: 5, critical: 5 }[sev] || 0;
}

/**
 * The Assets-list dot, from the row's `activeAlert` summary
 * ({severity, count, unacknowledged}, or null when nothing is firing).
 *
 * The title says which of the two states it is in, because the difference
 * between "moving" and "not moving" is not something to make anyone squint at
 * — and it is the only thing a reduced-motion viewer has, the animation being
 * off for them entirely.
 */
function assetAlertDotHTML(asset) {
  return alertSummaryDotHTML(asset && asset.activeAlert);
}

/**
 * The same dot from a bare summary, for the callers that hold one without an
 * asset row around it — the search dropdown, whose hits carry `alert` (stamped
 * by `withAlertSummaries` in searchService). Same markup, so a device looks
 * equally alarmed whether it is found by scrolling or by typing its name.
 */
function alertSummaryDotHTML(a) {
  if (!a || !a.count) return "";
  var handled = !a.unacknowledged;
  var sev = a.severity || "critical";
  var title = a.count === 1
    ? "1 active " + sev + " alert" + (handled ? " — acknowledged" : "")
    : a.count + " active alerts, worst " + sev +
      (handled ? " — all acknowledged" : " — " + a.unacknowledged + " unacknowledged");
  return '<span class="alert-strobe-dot' + (handled ? " is-handled" : "") +
    '" style="--strobe-color:' + assetAlertStrobeColor(sev) + '"' +
    ' role="img" aria-label="' + escapeHtml(title) + '" title="' + escapeHtml(title) + '"></span>';
}

function _renderSearchDropdown(results) {
  var dropdown = document.getElementById("global-search-dropdown");
  var sites = results.sites || [];
  // Skip the virtual-Device-Map synthesis when the operator typed a
  // non-map scope prefix (`a:`, `r:`, `n:`, `b:` / long forms). The
  // backend already returns only that group's hits; synthesizing map
  // rows from the asset list would defeat the scope.
  var scopeMatch = (results.query || "").match(/^(block|asset|reservation|network|ipsec|vpn|b|a|r|n|v):/i);
  var endpointMapHits = scopeMatch ? [] : (results.assets || [])
    .filter(function (h) { return h.context && h.context.siteId; })
    .map(function (h) {
      return Object.assign({}, h, {
        context: Object.assign({}, h.context, { mapEntry: true }),
      });
    });
  var allSites = sites.concat(endpointMapHits);
  // IPsec tunnels + VPN connections (the asset IPsec tab's rows); absent from
  // a response an older server wrote.
  var ipsecHits = results.ipsec || [];
  var total = results.blocks.length + results.subnets.length + results.reservations.length + results.assets.length + results.ips.length + allSites.length + ipsecHits.length;
  if (total === 0) {
    // The gear's filter is always narrowing something (the default leaves out
    // four device states), so an empty result says where else to look.
    dropdown.innerHTML = '<div class="global-search-empty">No matches for "' + escapeHtml(results.query) + '"' +
      '<div class="global-search-empty-hint">Assets outside the search settings (the gear) are not shown.</div></div>';
    dropdown.style.display = "block";
    return;
  }

  // Asset/site hits carry `status` (the assets-table monitor pill, computed
  // server-side); map its kind onto the existing badge classes so the
  // dropdown pill matches the assets list exactly.
  var pillClassByKind = {
    "unmonitored": "badge-unmonitored",
    "up":          "badge-monitored",
    "warning":     "badge-monitor-warning",
    "down":        "badge-monitor-down",
    "recovering":  "badge-monitor-recovering",
    "pending":     "badge-monitor-recovering",
    "passive":     "badge-monitor-passive",
    "dep-down":    "badge-monitor-dep-down",
    "dep-test":    "badge-monitor-dep-test",
    "maintenance": "badge-maintenance",
    // An IPsec tunnel with some phase-2 selectors up and some down.
    "partial":     "badge-monitor-warning",
  };

  function section(label, hits) {
    if (!hits.length) return "";
    var rows = hits.map(function (h) {
      var pill = "";
      if (h.status && pillClassByKind[h.status.kind]) {
        pill = ' <span class="badge gs-item-pill ' + pillClassByKind[h.status.kind] + '">' + escapeHtml(h.status.label) + '</span>';
      }
      // Asset + site hits carry the same active-alert summary the Assets
      // list's dot reads (`h.alert`, one query for the whole result set), so a
      // device that strobes in the list strobes when you search for it. Before
      // the pill: the alert is the reason to look, the monitor state is the
      // detail — and a hit can carry both (an alerting device is often Up).
      var alertDot = h.alert ? alertSummaryDotHTML(h.alert) : "";
      return '<div class="gs-item" data-type="' + h.type + '" data-id="' + escapeHtml(h.id) + '"' +
        (h.context ? ' data-context="' + escapeHtml(JSON.stringify(h.context)) + '"' : '') + '>' +
        '<div class="gs-item-title">' + escapeHtml(h.title) + alertDot + pill + '</div>' +
        (h.subtitle ? '<div class="gs-item-sub">' + escapeHtml(h.subtitle) + '</div>' : '') +
      '</div>';
    }).join("");
    return '<div class="gs-group"><div class="gs-group-label">' + label + '</div>' + rows + '</div>';
  }

  // Page-aware section ordering — the section relevant to the page
  // the operator is currently on goes first so the most likely
  // intended pick is at the top of the dropdown. The remaining
  // sections fall through in a stable default order behind it.
  var sections = [
    { key: "ips",          label: "IP",          hits: results.ips },
    { key: "blocks",       label: "Blocks",      hits: results.blocks },
    { key: "subnets",      label: "Networks",    hits: results.subnets },
    { key: "reservations", label: "Reservations", hits: results.reservations },
    { key: "assets",       label: "Assets",      hits: results.assets },
    { key: "sites",        label: "Device Map",  hits: allSites },
    { key: "ipsec",        label: "IPsec / VPN", hits: ipsecHits },
  ];
  var pinned = _searchSectionForCurrentPage();
  if (pinned) {
    var idx = sections.findIndex(function (s) { return s.key === pinned; });
    if (idx > 0) {
      var hoisted = sections.splice(idx, 1)[0];
      sections.unshift(hoisted);
    }
  }
  var html = sections.map(function (s) { return section(s.label, s.hits); }).join("");

  dropdown.innerHTML = html;
  dropdown.style.display = "block";

  dropdown.querySelectorAll(".gs-item").forEach(function (el) {
    el.addEventListener("click", function () {
      var type = el.getAttribute("data-type");
      var id = el.getAttribute("data-id");
      var ctx = el.getAttribute("data-context");
      openSearchResult({ type: type, id: id, context: ctx ? JSON.parse(ctx) : null });
    });
  });
}

function _hideSearchDropdown() {
  var dropdown = document.getElementById("global-search-dropdown");
  if (dropdown) dropdown.style.display = "none";
}

// ─── Recent searches ────────────────────────────────────────────────────────
// The last RECENT_SEARCH_LIMIT queries the operator picked a result from,
// newest first, shown above the shortcuts. "Made a search" means opened a
// hit (openSearchResult) — recording every debounced keystroke would fill
// the list with "co", "cor", "core". sessionStorage, so the list lives as
// long as the browser TAB: it survives the page navigation a hit often
// causes, and a new tab starts empty. Keyed by username like the gear's
// settings, so a sign-out and sign-in as someone else in the same tab does
// not show them the previous user's searches.

var RECENT_SEARCH_LIMIT = 5;

function _recentSearchKey() {
  return "polaris-search-recent-" + (typeof currentUsername === "string" && currentUsername ? currentUsername : "");
}

/** This tab's recent searches, newest first. */
function loadRecentSearches() {
  var list = null;
  try { list = JSON.parse(sessionStorage.getItem(_recentSearchKey()) || "null"); } catch (_) {}
  if (!Array.isArray(list)) return [];
  return list.filter(function (q) { return typeof q === "string" && q.trim(); }).slice(0, RECENT_SEARCH_LIMIT);
}

/** Put `q` at the head of the list; an earlier copy (any case) moves up instead of repeating. */
function rememberRecentSearch(q) {
  q = String(q || "").trim();
  if (!q) return;
  var lower = q.toLowerCase();
  var next = [q].concat(loadRecentSearches().filter(function (r) { return r.toLowerCase() !== lower; }))
    .slice(0, RECENT_SEARCH_LIMIT);
  try { sessionStorage.setItem(_recentSearchKey(), JSON.stringify(next)); } catch (_) {}
}

// ─── Search draft ───────────────────────────────────────────────────────────
// What the operator typed and has not finished — no result opened yet. Kept
// while they click away (the input simply keeps it) and across a page load in
// the same tab (sessionStorage, written on every keystroke), so leaving a
// page mid-search costs nothing. Cleared by openSearchResult, and by emptying
// the box. Per user, like the recent searches.

function _searchDraftKey() {
  return "polaris-search-draft-" + (typeof currentUsername === "string" && currentUsername ? currentUsername : "");
}

function saveSearchDraft(text) {
  try {
    if (String(text || "").trim()) sessionStorage.setItem(_searchDraftKey(), String(text));
    else sessionStorage.removeItem(_searchDraftKey());
  } catch (_) {}
}

function loadSearchDraft() {
  try { return sessionStorage.getItem(_searchDraftKey()) || ""; } catch (_) { return ""; }
}

// Put this tab's draft back into a freshly mounted box. The username keys
// it, and on a first sign-in there is no cached user yet at mount — then
// wait for /auth/me. Never over text the operator typed in the meantime.
function _restoreSearchDraft(input) {
  function apply() {
    if (input.value) return;
    var draft = loadSearchDraft();
    if (draft) input.value = draft;
  }
  if (typeof currentUsername === "string" && currentUsername) apply();
  else if (typeof userReady !== "undefined" && userReady && typeof userReady.then === "function") userReady.then(apply);
}

// Show the scope-shortcut help panel when the search bar is focused with
// no query in flight. Clicking a hint pre-fills the input with the scope
// prefix and a trailing space so the operator can keep typing. This tab's
// recent searches sit above it; clicking one re-runs it.
function _showSearchShortcutHints() {
  var dropdown = document.getElementById("global-search-dropdown");
  if (!dropdown) return;
  var recent = loadRecentSearches();
  var recentHtml = recent.length
    ? '<div class="gs-group gs-recent-group">' +
      '  <div class="gs-group-label">Recent searches</div>' +
      recent.map(function (q) {
        return '<div class="gs-recent" data-query="' + escapeHtml(q) + '" title="Search again">' + escapeHtml(q) + '</div>';
      }).join("") +
      '</div>'
    : "";
  var hints = [
    { prefix: "block:",       short: "b:", label: "Search IP blocks only" },
    { prefix: "network:",     short: "n:", label: "Search networks (subnets) only" },
    { prefix: "asset:",       short: "a:", label: "Search assets only" },
    { prefix: "reservation:", short: "r:", label: "Search reservations only" },
    { prefix: "map:",         short: "m:", label: "Search pinned firewalls (Device Map) only" },
    { prefix: "tag:",         short: "t:", label: "Search by tag across networks & assets" },
    { prefix: "ipsec:",       short: "v:", label: "Search IPsec tunnels and VPN connections only" },
  ];
  var rows = hints.map(function (h) {
    return '<div class="gs-hint" data-prefix="' + escapeHtml(h.prefix) + '">' +
      '<div class="gs-hint-keys"><span class="gs-hint-key">' + escapeHtml(h.prefix) + '</span>' +
        '<span class="gs-hint-or">or</span>' +
        '<span class="gs-hint-key">' + escapeHtml(h.short) + '</span></div>' +
      '<div class="gs-hint-label">' + escapeHtml(h.label) + '</div>' +
    '</div>';
  }).join("");
  dropdown.innerHTML = recentHtml +
    '<div class="gs-group gs-hint-group">' +
    '  <div class="gs-group-label">Search shortcuts — scoped searches return up to 200 results (no top-8 cap)</div>' +
    rows +
    '  <div class="gs-hint-foot">Type multiple words to match all of them · wrap a phrase in "quotes" to keep spaces</div>' +
    '</div>';
  dropdown.style.display = "block";

  dropdown.querySelectorAll(".gs-hint").forEach(function (el) {
    el.addEventListener("click", function () {
      var input = document.getElementById("global-search-input");
      if (!input) return;
      input.value = el.getAttribute("data-prefix") + " ";
      saveSearchDraft(input.value);
      input.focus();
      // Keep the hint panel up — the operator hasn't typed a query yet.
    });
  });
  dropdown.querySelectorAll(".gs-recent").forEach(function (el) {
    el.addEventListener("click", function () {
      var input = document.getElementById("global-search-input");
      if (!input) return;
      var q = el.getAttribute("data-query");
      input.value = q;
      saveSearchDraft(q);
      clearTimeout(_searchDebounceTimer);
      _searchActiveResults = null;
      // Focusing runs the search (the focus handler searches text it has no
      // results for) — the same search typing runs, minus the debounce, and
      // under the gear's CURRENT settings. Only when the box already held
      // focus does no focus event fire, so search directly.
      var hadFocus = document.activeElement === input;
      input.focus();
      if (hadFocus) _performSearch(q);
    });
  });
}

function _handleSearchKeyNav(e) {
  var dropdown = document.getElementById("global-search-dropdown");
  if (!dropdown || dropdown.style.display === "none") return;
  var items = Array.from(dropdown.querySelectorAll(".gs-item"));
  if (!items.length) return;
  var idx = items.findIndex(function (el) { return el.classList.contains("active"); });
  if (e.key === "ArrowDown") {
    e.preventDefault();
    idx = (idx + 1) % items.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    idx = (idx - 1 + items.length) % items.length;
  } else if (e.key === "Enter") {
    e.preventDefault();
    var active = idx >= 0 ? items[idx] : items[0];
    active.click();
    return;
  }
  items.forEach(function (el) { el.classList.remove("active"); });
  items[idx].classList.add("active");
  items[idx].scrollIntoView({ block: "nearest" });
}

// Dispatch a search result to the right page + modal. Navigates via hash so
// the target page's init code picks it up and opens the modal on load. If the
// user is already on the target page, opens the modal directly.
function openSearchResult(hit) {
  _hideSearchDropdown();
  var input = document.getElementById("global-search-input");
  if (input) {
    rememberRecentSearch(input.value);
    input.value = "";
  }
  saveSearchDraft(""); // a finished search leaves no draft behind
  // The box is empty now, so the results it held describe nothing in it:
  // drop them, or the next focus would show them again instead of the
  // shortcuts and recent searches.
  _searchLastQuery = "";
  _searchActiveResults = null;

  var target = _searchTargetFor(hit);
  if (!target) return;

  if (window.location.pathname === target.page) {
    target.handler();
  } else if (typeof target.open === "function") {
    // The record's slide-over, in place — every page can host one
    // (PolarisPanels loads the panel's scripts on demand), so a hit no
    // longer costs the operator the page they were on.
    target.open();
  } else {
    window.location.href = target.page + target.hash;
  }
}

// Return the section key (matching the `sections` array in
// _renderSearchDropdown) that should be hoisted to the top when the
// operator is on the corresponding page. Null = use the default order.
function _searchSectionForCurrentPage() {
  var p = window.location.pathname || "";
  if (p === "/map.html")     return "sites";
  if (p === "/subnets.html") return "subnets";
  if (p === "/assets.html")  return "assets";
  if (p === "/blocks.html")  return "blocks";
  return null;
}

function _searchTargetFor(hit) {
  if (hit.type === "site") {
    // Site hit — pan to the marker AND open its topology modal, like
    // clicking the marker would. Same hash convention as below so
    // navigation from another page reaches the same end state.
    return {
      page: "/map.html",
      hash: "#site=" + encodeURIComponent(hit.id) + "&topology=1",
      handler: function () {
        if (typeof window.polarisMapOpenSiteTopology === "function") {
          window.polarisMapOpenSiteTopology(hit.id, null);
        }
      },
    };
  }
  if (hit.type === "asset") {
    var ctx = hit.context || {};
    // Virtual Device Map entry (mapEntry flag set by _renderSearchDropdown) —
    // open the FortiGate's topology modal focused on this endpoint.
    if (ctx.mapEntry) {
      if (window.location.pathname === "/map.html" &&
          typeof window.polarisMapOpenSiteTopology === "function") {
        var focusQuery = ctx.focusHostname || ctx.focusIpAddress || ctx.focusMacAddress || null;
        return {
          page: "/map.html",
          hash: "",
          handler: function () { window.polarisMapOpenSiteTopology(ctx.siteId, focusQuery); },
        };
      }
      var qHashFocus = ctx.focusHostname || ctx.focusIpAddress || ctx.focusMacAddress || "";
      var hash = "#site=" + encodeURIComponent(ctx.siteId) + "&topology=1" +
        (qHashFocus ? "&q=" + encodeURIComponent(qHashFocus) : "");
      return {
        page: "/map.html",
        hash: hash,
        handler: function () {
          if (typeof window.polarisMapOpenSiteTopology === "function") {
            window.polarisMapOpenSiteTopology(ctx.siteId, qHashFocus || null);
          }
        },
      };
    }
    // Regular asset hit (the Assets group, and all an `a:` scope returns) —
    // the asset slide-over, in place, on every page including the Device
    // Map. Panning to the marker / opening the topology is the Device Map
    // group's job; doing it here too made `a:` unable to open an asset there.
    return {
      page: "/assets.html",
      hash: "#view=asset:" + encodeURIComponent(hit.id),
      handler: function () { if (typeof openViewModal === "function") openViewModal(hit.id); },
      open: function () { PolarisPanels.openAsset(hit.id); },
    };
  }
  if (hit.type === "ipsec") {
    // A tunnel or VPN connection lives on the IPsec tab of the gate that
    // terminates it — open that gate's slide-over on that tab. `id` is
    // `<gateId>|tunnel|<name>`; the gate id also rides in context.assetId.
    var ictx = hit.context || {};
    var gateId = ictx.assetId || String(hit.id || "").split("|")[0];
    if (!gateId) return null;
    return {
      page: "/assets.html",
      hash: "#view=asset:" + encodeURIComponent(gateId) + "&tab=ipsec",
      handler: function () { if (typeof openViewModal === "function") openViewModal(gateId, { tab: "ipsec" }); },
      open: function () { PolarisPanels.openAsset(gateId, { tab: "ipsec" }); },
    };
  }
  if (hit.type === "block") {
    // On the IPAM page a block hit opens its editor; anywhere else the
    // drill-in slide-over (the block's networks) is the one surface that can
    // be hosted in place.
    return {
      page: "/ipam.html",
      hash: "#tab=blocks&view=block:" + encodeURIComponent(hit.id),
      handler: function () { if (typeof openBlockEditModal === "function") openBlockEditModal(hit.id); },
      open: function () { PolarisPanels.openBlock(hit.id); },
    };
  }
  if (hit.type === "subnet") {
    return {
      page: "/ipam.html",
      hash: "#tab=networks&subnet=" + encodeURIComponent(hit.id),
      handler: function () { if (typeof openIpPanel === "function") openIpPanel(hit.id); },
      open: function () { PolarisPanels.openNetwork(hit.id); },
    };
  }
  if (hit.type === "reservation") {
    // Route to the network slide-over so the operator sees the reservation
    // in its containing subnet context (IP-panel auto-scrolls + highlights
    // the row); supplies focusReservation= so ip-panel resolves the IP from
    // the reservation id even on hard reload.
    var resvSubnetId = hit.subnetId || (hit.context && hit.context.subnetId);
    if (resvSubnetId) {
      return {
        page: "/ipam.html",
        hash: "#tab=networks&subnet=" + encodeURIComponent(resvSubnetId) + "&focusReservation=" + encodeURIComponent(hit.id),
        handler: function () {
          if (typeof openIpPanel === "function") openIpPanel(resvSubnetId, { focusReservationId: hit.id });
        },
        open: function () { PolarisPanels.openNetwork(resvSubnetId, { focusReservationId: hit.id }); },
      };
    }
    // Fallback when the search hit didn't carry a subnetId — open the
    // reservation modal directly.
    return {
      page: "/ipam.html",
      hash: "#tab=networks&view=reservation:" + encodeURIComponent(hit.id),
      handler: function () { if (typeof openReservationModal === "function") openReservationModal(hit.id); },
    };
  }
  if (hit.type === "ip") {
    var ctx = hit.context || {};
    if (ctx.subnetId) {
      var hash = "#tab=networks&ip=" + encodeURIComponent(ctx.subnetId) + "@" + encodeURIComponent(ctx.ipAddress || "");
      return {
        page: "/ipam.html",
        hash: hash,
        handler: function () {
          if (typeof openIpPanel === "function") openIpPanel(ctx.subnetId, { focusIp: ctx.ipAddress });
        },
        open: function () { PolarisPanels.openNetwork(ctx.subnetId, { focusIp: ctx.ipAddress }); },
      };
    }
  }
  return null;
}

// Called on init — inspects the URL hash and opens the referenced modal if
// the current page matches the hash's entity type. No-op otherwise so we
// don't mis-dispatch (e.g. calling Subnets' openEditModal on the Blocks page).
function processSearchHash() {
  var hash = window.location.hash || "";
  var path = window.location.pathname;
  var onIpamPage = path.indexOf("/ipam.html") !== -1;

  // #view=<type>:<id> — legacy single-param form (still emitted by Blocks/
  // Networks legacy redirects). Match on either the legacy page paths or
  // the new IPAM consolidated page.
  // An optional &tab=<key> names the asset slide-over tab to land on (the
  // Active Alerts widget's navigation fallback sends tab=notifications).
  // `view=` may follow a `tab=` (`#tab=blocks&view=block:<id>` — the IPAM
  // forms PolarisPanels.openBlock's fallback, a search hit's fallback and a
  // shared /blocks/<id> link carry); anchored on `#` alone, those never opened.
  var m = /[#&]view=(\w+):([^&]+)/.exec(hash);
  if (m) {
    var type = m[1], id = decodeURIComponent(m[2]);
    var tabM = /[#&]tab=([^&]+)/.exec(hash);
    var viewTab = tabM ? decodeURIComponent(tabM[1]) : null;
    setTimeout(function () {
      if (type === "asset" && path.indexOf("/assets.html") !== -1 && typeof openViewModal === "function") {
        openViewModal(id, viewTab ? { tab: viewTab } : undefined);
      } else if (type === "block" && (onIpamPage || path.indexOf("/blocks.html") !== -1)) {
        // The block's VIEW is its drill-in panel — what a block row opens, what
        // PolarisPanels.openBlock's fallback and a shared /blocks/<id> link
        // (share-link.js) expect. The edit dialog is only the fallback.
        if (typeof openBlockPanel === "function") openBlockPanel(id);
        else if (typeof openBlockEditModal === "function") openBlockEditModal(id);
      } else if (type === "subnet" && (onIpamPage || path.indexOf("/subnets.html") !== -1) && typeof openSubnetEditModal === "function") {
        openSubnetEditModal(id);
      } else if (type === "reservation" && (onIpamPage || path.indexOf("/subnets.html") !== -1) && typeof openReservationModal === "function") {
        openReservationModal(id);
      }
    }, 150);
    return;
  }

  // IPAM-style hash params: #tab=networks&subnet=<id>&focusReservation=<id>
  // and the legacy plain #ip=<sid>@<ip> form (still emitted by the redirect
  // from /subnets.html#ip=... ). Both surfaces converge on openIpPanel here.
  if (onIpamPage) {
    var params = {};
    hash.replace(/^#/, "").split("&").forEach(function (kv) {
      var p = kv.split("=");
      if (p.length === 2) params[decodeURIComponent(p[0])] = decodeURIComponent(p[1]);
    });
    // The ipam orchestrator + subnets.js applyHashFilters already handle the
    // tab=networks + subnet=/focusReservation= path (they fire before this).
    // This branch covers #tab=networks&ip=<subnetId>@<ip> only.
    if (params.tab === "networks" && params.ip) {
      var ipParts = params.ip.split("@");
      if (ipParts.length === 2) {
        var subnetIdNew = ipParts[0];
        var focusIpNew = ipParts[1];
        setTimeout(function () {
          if (typeof openIpPanel !== "function") return;
          if (focusIpNew && api && api.subnets && typeof api.subnets.get === "function") {
            api.subnets.get(subnetIdNew).then(function (s) {
              openIpPanel(subnetIdNew, { focusIp: focusIpNew, subnetCidr: s && s.cidr });
            }, function () {
              openIpPanel(subnetIdNew, { focusIp: focusIpNew });
            });
          } else {
            openIpPanel(subnetIdNew);
          }
        }, 200);
      }
      return;
    }
  }

  // Legacy #ip=<sid>@<ip> on /subnets.html (also reachable via redirect from
  // /subnets.html → /ipam.html).
  var ipM = /^#ip=([^@]+)@(.+)$/.exec(hash);
  if (ipM && (onIpamPage || path.indexOf("/subnets.html") !== -1)) {
    var subnetId = decodeURIComponent(ipM[1]);
    var focusIp = decodeURIComponent(ipM[2]);
    setTimeout(function () {
      if (typeof openIpPanel !== "function") return;
      // Fetch the subnet metadata first so the panel can compute which page
      // contains focusIp before the initial render — avoids opening on page 1
      // and then re-fetching when the IP lives further into a large subnet.
      if (focusIp && typeof api !== "undefined" && api.subnets && typeof api.subnets.get === "function") {
        api.subnets.get(subnetId).then(function (s) {
          openIpPanel(subnetId, { focusIp: focusIp, subnetCidr: s && s.cidr });
        }, function () {
          openIpPanel(subnetId, { focusIp: focusIp });
        });
      } else {
        openIpPanel(subnetId);
      }
    }, 150);
  }
}
