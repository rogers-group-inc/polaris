// public/js/asset-merge-modal.js
//
// The operator-driven asset merge modal — the inverse of the Sources-tab Split.
// Two assets that are really one physical device (the classic being a FortiGate-
// discovered endpoint and an AD/Entra computer that never cross-linked): the
// operator searches for the other asset, sees a field-by-field comparison, picks
// which side survives and which value wins per differing field, then confirms.
// Backend: POST /assets/:id/merge (assetMergeService).
//
// ── Why this is its own file ───────────────────────────────────────────────
// It is opened from TWO pages that share no other code: the Assets page (the
// Sources tab button and the two-row bulk bar) and the Conflicts slide-over on
// the Events page, where a duplicate-IP card offers it as the richer
// alternative to the inline one-click merge. events.html does not load
// assets.js and must not — it is 22k lines of list/detail machinery this modal
// does not need.
//
// Everything it depends on beyond this file lives in api.js (api.assets.*,
// escapeHtml, showToast, timeAgo) and app.js (openModal, closeModal,
// revealOverlay, isAdmin, formatDate), both of which every page loads.
//
// ── The host contract ──────────────────────────────────────────────────────
// openAssetMergeModal(assetId, preselectOtherId, opts) — `opts.onMerged` is
// called with the server result after a successful merge, and is how each page
// refreshes ITSELF. The modal deliberately knows nothing about either page:
// the Assets page reloads its list and re-opens the survivor, the Conflicts
// panel reloads the queue. Omitted, the merge still happens and nothing is
// refreshed.

// ─── Asset merge (admin) — inverse of Split ─────────────────────────────────
// Absorbs another asset into the one being viewed. The operator searches for
// the other asset, sees an extensive field-by-field comparison marking every
// difference, picks which side survives + which value wins per differing
// field, then confirms. Backend: POST /assets/:id/merge (assetMergeService).

// Fields the comparison diffs and the operator can pick a winner for. Kept in
// sync with MERGEABLE_FIELDS in src/services/assetMergeService.ts. `date:true`
// formats with formatDate; everything else is shown as-is.
var _mergeCompareFields = [
  { key: "hostname",        label: "Hostname" },
  { key: "dnsName",         label: "DNS Name" },
  { key: "ipAddress",       label: "IP Address" },
  { key: "macAddress",      label: "MAC Address" },
  { key: "serialNumber",    label: "Serial Number" },
  { key: "manufacturer",    label: "Manufacturer" },
  { key: "model",           label: "Model" },
  { key: "assetType",       label: "Type" },
  { key: "status",          label: "Status" },
  { key: "location",        label: "Location" },
  { key: "learnedLocation", label: "Learned Location" },
  { key: "department",      label: "Department" },
  { key: "assignedTo",      label: "Assigned To" },
  { key: "os",              label: "OS" },
  { key: "osVersion",       label: "OS Version" },
  { key: "snmpLocation",    label: "SNMP Location" },
  { key: "learnedAddress",  label: "Address" },
  { key: "purchaseOrder",   label: "Purchase Order" },
  // `combine:true` — both sides are kept and concatenated rather than one
  // winning. Mirrors CONCATENATED_FIELDS in src/services/assetMergeService.ts.
  { key: "notes",           label: "Notes", combine: true },
  { key: "acquiredAt",      label: "Acquired",        date: true },
  { key: "warrantyExpiry",  label: "Warranty Expiry", date: true }
];

// Module-level state for the open merge modal.
var _mergeThisAsset = null;        // the asset whose modal is open ("this"/A)
var _mergeOtherAsset = null;       // the selected merge target ("other"/B)
var _mergeThisSources = [];
var _mergeOtherSources = [];
var _mergeThisHistory = null;      // GET /assets/:id/polling-history summary (null = unknown)
var _mergeOtherHistory = null;
var _mergeThisDeps = null;         // GET /assets/:id/dependencies (null = unknown)
var _mergeOtherDeps = null;
var _mergeSearchTimer = null;
var _mergePreselected = false;     // true when opened from the bulk bar (both assets picked up front)
var _mergeOnDone = null;           // host page's post-merge refresh (see the header's host contract)
// The operator's Sources priority order (Assets -> Settings -> Sources), most
// authoritative first — GET /assets/source-priority. Decides which side's value
// a differing field defaults to. null = the fetch failed or the server predates
// the setting; the defaults then fall back to the empty-value rule alone.
var _mergeSourcePriority = null;   // { order: string[], labels: { kind: label } }

// Combine both rows' notes instead of picking a winner. MIRRORS
// `combineAssetNotes` in src/services/assetMergeService.ts — that function is
// what actually writes the value; this one only previews it, and the two must
// agree. There is no build step to share one implementation, so a change to
// either needs the same change to the other.
function _mergeCombineNotes(canonical, ghost) {
  var cText = ((canonical && canonical.notes) || "").trim();
  var gText = ((ghost && ghost.notes) || "").trim();
  if (!cText && !gText) return undefined;
  if (!gText) return undefined;
  if (!cText) return gText;
  if (cText === gText) return undefined;
  if (cText.indexOf(gText) !== -1) return undefined;

  function label(side, other) {
    var name = ((side && side.hostname) || "").trim() || "unnamed asset";
    var otherName = ((other && other.hostname) || "").trim() || "unnamed asset";
    if (name !== otherName) return name;
    var suffix = ((side && side.id) || "").slice(0, 8);
    return suffix ? name + " · " + suffix : name;
  }

  return "[" + label(canonical, ghost) + "]\n" + cText +
         "\n\n[" + label(ghost, canonical) + "]\n" + gText;
}

function _mergeFieldVal(asset, f) {
  var v = asset ? asset[f.key] : null;
  if (v === null || v === undefined || v === "") return "";
  if (f.date) return formatDate(v);
  return String(v);
}

function _mergeIsEmpty(v) { return v === null || v === undefined || (typeof v === "string" && v.trim() === ""); }

// `preselectOtherId` (optional) pre-selects the merge target and skips the
// search step — the bulk-bar Merge button and the duplicate-IP conflict card
// both pass the second asset. The "Choose a different asset" back link
// restores the search flow.
// `opts.onMerged(result)` is the host page's post-merge refresh — see the
// host contract in this file's header.
async function openAssetMergeModal(assetId, preselectOtherId, opts) {
  if (!isAdmin()) return;
  _mergeThisAsset = null; _mergeOtherAsset = null;
  _mergeThisSources = []; _mergeOtherSources = [];
  _mergeThisHistory = null; _mergeOtherHistory = null;
  _mergeThisDeps = null; _mergeOtherDeps = null;
  _mergePreselected = !!preselectOtherId;
  _mergeSourcePriority = null;
  _mergeOnDone = (opts && typeof opts.onMerged === "function") ? opts.onMerged : null;

  var intro = preselectOtherId
    ? 'Merge the two selected assets into one. Review the differences, choose which asset ' +
      'survives and which value wins for each field, then confirm.'
    : 'Merge another asset into this one. Search for the duplicate, review the differences, ' +
      'choose which asset survives and which value wins for each field, then confirm.';

  // xl modals zero out .modal-body padding (`.modal.modal-xl .modal-body` in
  // styles.css — other xl modals run full-bleed tables / sticky tab strips),
  // so wrap our content in our own padded container to keep text off the edges.
  var body =
    '<div style="padding:1.25rem">' +
      '<p style="margin:0 0 0.75rem;color:var(--color-text-secondary);font-size:0.85rem">' + intro + '</p>' +
      '<div class="form-group" id="merge-search-wrap" style="margin-bottom:0.5rem' + (preselectOtherId ? ';display:none' : '') + '">' +
        '<input type="text" id="merge-search" placeholder="Search hostname, IP, MAC, serial, asset tag, owner..." autocomplete="off" style="width:100%">' +
      '</div>' +
      '<div id="merge-search-results" style="max-height:280px;overflow:auto"></div>' +
      '<div id="merge-compare"></div>' +
    '</div>';

  var footer =
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
    '<button class="btn btn-primary" id="merge-confirm-btn" style="display:none">Merge</button>';

  openModal("Merge Assets", body, footer, { xl: true });

  // Load the current ("this") asset + its sources up front so the comparison
  // renders the moment a target is chosen.
  try {
    var fetched = await Promise.all([
      api.assets.get(assetId),
      api.assets.getSources(assetId).catch(function () { return []; }),
      api.assets.pollingHistory(assetId).catch(function () { return null; }),
      api.assets.getDependencies(assetId).catch(function () { return null; }),
      // Same setting the Sources column reads. Fetched here (not cached
      // globally) so an order saved in another tab is picked up by the next
      // merge; a failure just drops back to the empty-value default.
      api.assets.getSourcePriority().catch(function () { return null; })
    ]);
    _mergeThisAsset = fetched[0];
    _mergeThisSources = Array.isArray(fetched[1]) ? fetched[1] : [];
    _mergeThisHistory = fetched[2];
    _mergeThisDeps = fetched[3];
    _mergeSourcePriority = _mergeNormalizePriority(fetched[4]);
  } catch (err) {
    var rs = document.getElementById("merge-search-results");
    if (rs) rs.innerHTML = '<div class="empty-state" style="padding:1rem">Failed to load this asset: ' + escapeHtml(err.message || "error") + '</div>';
    return;
  }

  var input = document.getElementById("merge-search");
  if (input) {
    input.addEventListener("input", function () {
      if (_mergeSearchTimer) clearTimeout(_mergeSearchTimer);
      var q = this.value.trim();
      _mergeSearchTimer = setTimeout(function () { _mergeRunSearch(assetId, q); }, 250);
    });
    if (!preselectOtherId) input.focus();
  }

  if (preselectOtherId) await selectMergeTarget(preselectOtherId);
}

async function _mergeRunSearch(thisId, q) {
  var box = document.getElementById("merge-search-results");
  if (!box) return;
  if (q.length < 2) { box.innerHTML = '<div class="empty-state" style="padding:0.75rem;font-size:0.85rem">Type at least 2 characters to search.</div>'; return; }
  box.innerHTML = '<div class="empty-state" style="padding:0.75rem;font-size:0.85rem">Searching...</div>';
  try {
    var rows = await api.assets.list({ search: q, limit: 25 });
    var list = Array.isArray(rows) ? rows : (rows && rows.assets) || [];
    list = list.filter(function (a) { return a.id !== thisId; });
    if (!list.length) { box.innerHTML = '<div class="empty-state" style="padding:0.75rem;font-size:0.85rem">No other assets match.</div>'; return; }
    box.innerHTML = list.map(function (a) {
      var sub = [a.ipAddress, a.macAddress, a.serialNumber, a.assetType].filter(Boolean).map(escapeHtml).join(" · ");
      return '<div class="merge-result-row" onclick="selectMergeTarget(\'' + a.id + '\')" ' +
        'style="padding:0.45rem 0.6rem;border:1px solid var(--color-border);border-radius:6px;margin-bottom:0.35rem;cursor:pointer">' +
        '<div style="font-weight:600">' + escapeHtml(a.hostname || a.dnsName || a.ipAddress || "(unnamed)") + '</div>' +
        (sub ? '<div style="font-size:0.78rem;color:var(--color-text-secondary)">' + sub + '</div>' : '') +
      '</div>';
    }).join("");
  } catch (err) {
    box.innerHTML = '<div class="empty-state" style="padding:0.75rem">Search failed: ' + escapeHtml(err.message || "error") + '</div>';
  }
}

async function selectMergeTarget(otherId) {
  var box = document.getElementById("merge-search-results");
  var cmp = document.getElementById("merge-compare");
  if (cmp) cmp.innerHTML = '<div class="empty-state" style="padding:1rem">Loading comparison...</div>';
  try {
    var fetched = await Promise.all([
      api.assets.get(otherId),
      api.assets.getSources(otherId).catch(function () { return []; }),
      api.assets.pollingHistory(otherId).catch(function () { return null; }),
      api.assets.getDependencies(otherId).catch(function () { return null; })
    ]);
    _mergeOtherAsset = fetched[0];
    _mergeOtherSources = Array.isArray(fetched[1]) ? fetched[1] : [];
    _mergeOtherHistory = fetched[2];
    _mergeOtherDeps = fetched[3];
  } catch (err) {
    if (cmp) cmp.innerHTML = '<div class="empty-state" style="padding:1rem">Failed to load asset: ' + escapeHtml(err.message || "error") + '</div>';
    return;
  }
  // Collapse the search list once a target is chosen; offer a way back.
  if (box) box.innerHTML = '<button class="btn btn-sm btn-secondary" onclick="_mergeReopenSearch()">&larr; Choose a different asset</button>';
  _renderMergeComparison();
  var btn = document.getElementById("merge-confirm-btn");
  if (btn) btn.style.display = "";
}

function _mergeReopenSearch() {
  _mergeOtherAsset = null; _mergeOtherSources = []; _mergeOtherHistory = null; _mergeOtherDeps = null;
  var cmp = document.getElementById("merge-compare");
  if (cmp) cmp.innerHTML = "";
  var btn = document.getElementById("merge-confirm-btn");
  if (btn) btn.style.display = "none";
  var box = document.getElementById("merge-search-results");
  if (box) box.innerHTML = "";
  // The bulk-bar pre-selected flow opens with the search row hidden — restore
  // it so "Choose a different asset" always leads back to a usable search.
  var wrap = document.getElementById("merge-search-wrap");
  if (wrap) wrap.style.display = "";
  var input = document.getElementById("merge-search");
  if (input) { input.value = ""; input.focus(); }
}

function _mergeAssetLabel(a) {
  return escapeHtml(a.hostname || a.dnsName || a.ipAddress || a.id);
}

// ── Polling-history helpers (merge comparison) ──
// The absorbed side's sample history is permanently deleted by a merge, so the
// comparison surfaces how much each side holds and defaults the survivor to
// the longer one. Summaries come from GET /assets/:id/polling-history
// (monitor probes + telemetry across all retention tiers); null = the fetch
// failed and history is unknown.

// Comparable size of a summary: span first (ms between oldest and newest
// sample), sample count as the tiebreak. [0,0] = no history.
function _mergeHistoryScore(h) {
  if (!h || !h.sampleCount || !h.oldestAt || !h.newestAt) return [0, 0];
  var span = new Date(h.newestAt).getTime() - new Date(h.oldestAt).getTime();
  return [span > 0 ? span : 0, h.sampleCount];
}

// True when `a` holds strictly more polling history than `b`.
function _mergeHistoryLonger(a, b) {
  var sa = _mergeHistoryScore(a), sb = _mergeHistoryScore(b);
  if (sa[0] !== sb[0]) return sa[0] > sb[0];
  return sa[1] > sb[1];
}

// Short text form: "412 days (≈1,234,000 samples)" / "<1 day (≈40 samples)".
function _mergeHistoryText(h) {
  if (!h) return "unknown";
  if (!h.sampleCount) return "none";
  var span = h.spanDays > 0 ? h.spanDays + " day" + (h.spanDays === 1 ? "" : "s") : "<1 day";
  return span + " (≈" + Number(h.sampleCount).toLocaleString() + " samples)";
}

// Cell HTML for the comparison context row.
function _mergeHistoryCell(h) {
  if (!h) return '<em style="color:var(--color-text-secondary)">unknown</em>';
  if (!h.sampleCount) return '<em style="color:var(--color-text-secondary)">none</em>';
  return '<strong>' + escapeHtml(_mergeHistoryText(h)) + '</strong>' +
    '<div style="font-size:0.78rem;color:var(--color-text-secondary)">since ' + escapeHtml(formatDate(h.oldestAt)) + '</div>';
}

function _mergeSourcesSummary(sources) {
  if (!sources || !sources.length) return '<em style="color:var(--color-text-secondary)">none</em>';
  return sources.map(function (s) {
    var lbl = (_assetSourceLabels && _assetSourceLabels[s.sourceKind]) || s.sourceKind;
    return '<span class="badge badge-active" style="margin:0 0.2rem 0.2rem 0">' + escapeHtml(lbl) + '</span>';
  }).join("");
}

// ── Source-priority helpers (merge comparison) ──
// Two rows that are really one device were usually learned by different
// integrations, and the operator has already declared which of those they
// trust — the drag-to-reorder list on Assets -> Settings -> Sources. So the
// per-field winner defaults to the side whose best-ranked discovery source
// sits higher in that order, instead of always defaulting to A.
//
// The order only ranks the sources that can contribute a learned location
// (LOCATION_CONTRIBUTORS in src/utils/assetSourceLocation.ts) — `manual`,
// `polaris-agent`, `snmp-sysdescr` and `fortigate-firewall` are deliberately
// absent from it. Those rank BELOW every listed kind here rather than being
// promoted to the top: the operator never placed them, so inventing a rank for
// them would be this code's opinion, not theirs. A side holding only unranked
// sources still wins any field where the other side is empty.

// Coerce the GET /assets/source-priority payload into { order, labels }, or
// null when it carries no usable order.
function _mergeNormalizePriority(payload) {
  if (!payload || !Array.isArray(payload.order) || !payload.order.length) return null;
  var labels = {};
  if (Array.isArray(payload.contributors)) {
    payload.contributors.forEach(function (c) {
      if (c && c.kind) labels[c.kind] = c.label || c.kind;
    });
  }
  return { order: payload.order.slice(), labels: labels };
}

function _mergeSourceKindLabel(kind) {
  if (_mergeSourcePriority && _mergeSourcePriority.labels[kind]) return _mergeSourcePriority.labels[kind];
  return (_assetSourceLabels && _assetSourceLabels[kind]) || kind;
}

// Best (lowest) index this side's sources hold in `order`; -1 when none of them
// are ranked. -1 compares as worse than every real rank — see _mergePreferredSide.
function _mergeSourceRank(sources, order) {
  if (!order || !order.length || !sources || !sources.length) return -1;
  var best = -1;
  for (var i = 0; i < sources.length; i++) {
    var idx = order.indexOf(sources[i] && sources[i].sourceKind);
    if (idx < 0) continue;              // unranked kind — contributes nothing
    if (best < 0 || idx < best) best = idx;
  }
  return best;
}

// The source kind that earned a side its rank, for the explanatory hint.
function _mergeTopRankedKind(sources, order) {
  var rank = _mergeSourceRank(sources, order);
  return rank < 0 ? null : order[rank];
}

// "this" | "other" | null — which side the priority order prefers. null means
// it can't separate them (equal rank, or neither side has a ranked source),
// which leaves the empty-value rule alone in charge of the defaults.
function _mergePreferredSide(thisRank, otherRank) {
  if (thisRank === otherRank) return null;
  if (thisRank < 0) return "other";
  if (otherRank < 0) return "this";
  return thisRank < otherRank ? "this" : "other";
}

// Default winner for one differing field. The empty-value rule outranks the
// source priority both ways: an empty winner can never overwrite a value (the
// backend refuses it), so defaulting to it would render a radio that does
// nothing. With both sides holding a value the preferred side takes it, and
// with no preference it stays on A — the pre-existing behavior. Never asked
// about a `combine:true` field: those render no radios at all.
function _mergeDefaultWinner(A, B, key, preferred) {
  var aEmpty = _mergeIsEmpty(A[key]), bEmpty = _mergeIsEmpty(B[key]);
  if (aEmpty && !bEmpty) return "other";
  if (bEmpty && !aEmpty) return "this";
  return preferred || "this";
}

// ── Dependency helpers (merge comparison) ──
// A merge re-points everything that DEPENDS ON the absorbed asset at the
// survivor, and carries the absorbed asset's own upstream parent links when
// the survivor has none. When BOTH sides have parents the sets can't be
// unioned (one physical device has one real upstream; a union would weaken
// all-down suppression), so that case renders as a conflict with Keep A/B
// radios and the choice rides the merge body as `dependencyWinner`.

// The effective parent rows (parent resolved) out of a GET /dependencies payload.
function _mergeDepParents(deps) {
  if (!deps || !Array.isArray(deps.effectiveParents)) return [];
  return deps.effectiveParents.filter(function (p) { return p && p.parent; });
}

function _mergeDepParentNames(deps) {
  return _mergeDepParents(deps).map(function (p) { return p.parent.hostname || p.parent.id; });
}

// Order-insensitive identity of a side's effective parent set.
function _mergeDepParentsKey(deps) {
  return _mergeDepParents(deps).map(function (p) { return p.parent.id; }).sort().join("|");
}

// Both sides have effective parents and the sets differ → the operator picks.
function _mergeDepsConflict() {
  var a = _mergeDepParents(_mergeThisDeps), b = _mergeDepParents(_mergeOtherDeps);
  if (!a.length || !b.length) return false;
  return _mergeDepParentsKey(_mergeThisDeps) !== _mergeDepParentsKey(_mergeOtherDeps);
}

function _mergeDepParentsCell(deps) {
  if (!deps) return '<em style="color:var(--color-text-secondary)">unknown</em>';
  var parents = _mergeDepParents(deps);
  var html = parents.length
    ? parents.map(function (p) {
        var pinned = p.source === "override";
        return escapeHtml(p.parent.hostname || p.parent.id) +
          (pinned ? ' <span class="badge badge-active" title="Operator-pinned dependency override">pinned</span>' : '');
      }).join(", ")
    : '<em style="color:var(--color-text-secondary)">none</em>';
  if (deps.childCount > 0) {
    html += '<div style="font-size:0.78rem;color:var(--color-text-secondary)">' +
      deps.childCount + ' infra device' + (deps.childCount === 1 ? '' : 's') + ' depend' + (deps.childCount === 1 ? 's' : '') + ' on it</div>';
  }
  return html;
}

function _renderMergeComparison() {
  var cmp = document.getElementById("merge-compare");
  if (!cmp || !_mergeThisAsset || !_mergeOtherAsset) return;
  var A = _mergeThisAsset, B = _mergeOtherAsset;

  // Which side's discovery sources the operator ranks higher. Drives the
  // per-field winner defaults below; the radios stay live either way.
  var priorityOrder = _mergeSourcePriority ? _mergeSourcePriority.order : null;
  var aSourceRank = _mergeSourceRank(_mergeThisSources, priorityOrder);
  var bSourceRank = _mergeSourceRank(_mergeOtherSources, priorityOrder);
  var preferredSide = _mergePreferredSide(aSourceRank, bSourceRank);
  var srcBadge = ' <span class="badge badge-active" title="This side\'s discovery source ranks higher in Assets → Settings → Sources — its values are pre-selected where both sides have one">higher-ranked source</span>';

  // Survivor selector — which row's identity, monitoring history, dependency
  // edges and FKs are kept. The absorbed row's sample history is deleted, so
  // the side with the longer polling history is auto-selected (the operator
  // can still keep the other side — the radios stay live).
  var bHasLongerHistory = _mergeHistoryLonger(_mergeOtherHistory, _mergeThisHistory);
  var aHasLongerHistory = _mergeHistoryLonger(_mergeThisHistory, _mergeOtherHistory);
  var histBadge = ' <span class="badge badge-active" title="This side holds more polling history — auto-selected as the survivor so no history is lost">longer polling history</span>';
  var survivorHTML =
    '<div class="section-block" style="margin-bottom:0.75rem;padding:0.6rem 0.75rem">' +
      '<div class="section-label" style="margin-bottom:0.4rem">Which asset survives?</div>' +
      '<label style="display:block;margin-bottom:0.25rem;cursor:pointer">' +
        '<input type="radio" name="merge-survivor" value="this"' + (bHasLongerHistory ? '' : ' checked') + '> Keep <strong>' + _mergeAssetLabel(A) + '</strong> (' + (_mergePreselected ? 'A' : 'this asset') + ')' +
        (aHasLongerHistory ? histBadge : '') +
      '</label>' +
      '<label style="display:block;cursor:pointer">' +
        '<input type="radio" name="merge-survivor" value="other"' + (bHasLongerHistory ? ' checked' : '') + '> Keep <strong>' + _mergeAssetLabel(B) + '</strong> (' + (_mergePreselected ? 'B' : 'the other asset') + ')' +
        (bHasLongerHistory ? histBadge : '') +
      '</label>' +
      ((aHasLongerHistory || bHasLongerHistory)
        ? '<p class="hint" style="margin:0.4rem 0 0">Auto-selected the asset with the <strong>longer polling history</strong> (' +
          (bHasLongerHistory ? _mergeAssetLabel(B) : _mergeAssetLabel(A)) + ': ' + escapeHtml(_mergeHistoryText(bHasLongerHistory ? _mergeOtherHistory : _mergeThisHistory)) +
          ' vs ' + escapeHtml(_mergeHistoryText(bHasLongerHistory ? _mergeThisHistory : _mergeOtherHistory)) + ') — ' +
          'the absorbed asset\'s history is permanently deleted. Pick the other option above to keep it instead.</p>'
        : '') +
      '<p class="hint" style="margin:0.4rem 0 0">The survivor keeps its monitoring history and quarantine state. ' +
        'The absorbed asset\'s sample/telemetry history and interface-comment overrides are <strong>permanently deleted</strong>. ' +
        'Discovery sources, MAC / IP / sighting history and dependency links from both assets are combined onto the survivor ' +
        '(devices that depended on either asset depend on the merged one). ' +
        'If <strong>either</strong> asset is monitored the survivor comes out monitored — when that turns the survivor on, ' +
        'the absorbed asset\'s polling methods, credentials and pinned interfaces / storage / processes come with it.</p>' +
    '</div>';

  // Context rows (no winner choice) — help the operator pick the survivor.
  function ctxRow(label, av, bv) {
    return '<tr>' +
      '<th style="text-align:left;padding:0.3rem 0.6rem 0.3rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top;white-space:nowrap">' + escapeHtml(label) + '</th>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top">' + av + '</td>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top">' + bv + '</td>' +
      '<td></td>' +
    '</tr>';
  }
  var monA = A.monitored ? '<span class="badge badge-active">monitored</span>' + (A.monitorStatus ? ' ' + escapeHtml(A.monitorStatus) : "") : '<span style="color:var(--color-text-secondary)">not monitored</span>';
  var monB = B.monitored ? '<span class="badge badge-active">monitored</span>' + (B.monitorStatus ? ' ' + escapeHtml(B.monitorStatus) : "") : '<span style="color:var(--color-text-secondary)">not monitored</span>';
  var contextRows =
    ctxRow("Monitored", monA, monB) +
    ctxRow("Polling history", _mergeHistoryCell(_mergeThisHistory), _mergeHistoryCell(_mergeOtherHistory)) +
    ctxRow("Sources", _mergeSourcesSummary(_mergeThisSources), _mergeSourcesSummary(_mergeOtherSources)) +
    ctxRow("Last Seen", escapeHtml(A.lastSeen ? formatDate(A.lastSeen) : "-"), escapeHtml(B.lastSeen ? formatDate(B.lastSeen) : "-")) +
    ctxRow("Tags", (A.tags && A.tags.length ? A.tags.map(escapeHtml).join(", ") : "-"), (B.tags && B.tags.length ? B.tags.map(escapeHtml).join(", ") : "-"));

  // Dependency parents — context row that becomes a CONFLICT row (highlight +
  // Keep A/B radios) when both sides have effective parents and they differ.
  // One physical device has one real upstream, so the sets can't be unioned;
  // the pick rides the merge body as `dependencyWinner`. Dependents (devices
  // pointing at either asset) are combined regardless — no choice to make.
  var depsConflict = _mergeDepsConflict();
  var depWinnerCell = "";
  if (depsConflict) {
    depWinnerCell =
      '<div style="display:flex;gap:0.5rem;white-space:nowrap">' +
        '<label style="cursor:pointer"><input type="radio" name="mw-deps" value="this" checked> A</label>' +
        '<label style="cursor:pointer"><input type="radio" name="mw-deps" value="other"> B</label>' +
      '</div>';
  }
  contextRows +=
    '<tr' + (depsConflict ? ' style="background:var(--color-warning-bg, rgba(255,193,7,0.12))"' : '') + '>' +
      '<th style="text-align:left;padding:0.3rem 0.6rem 0.3rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top;white-space:nowrap">Dependency parents' +
        (depsConflict ? ' <span title="Both assets have dependency parents and they differ — pick whose the merged asset keeps">&#9679;</span>' : '') + '</th>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top;word-break:break-word">' + _mergeDepParentsCell(_mergeThisDeps) + '</td>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top;word-break:break-word">' + _mergeDepParentsCell(_mergeOtherDeps) + '</td>' +
      '<td style="padding:0.3rem 0;vertical-align:top">' + depWinnerCell + '</td>' +
    '</tr>';

  // Field rows — every mergeable field. Differences get a highlight + winner
  // radios; equal values render plainly. Empty-vs-value also counts as a diff.
  var diffCount = 0;
  var fieldRows = _mergeCompareFields.map(function (f) {
    var avRaw = _mergeFieldVal(A, f), bvRaw = _mergeFieldVal(B, f);
    var differs = avRaw !== bvRaw;
    if (differs) diffCount++;
    var av = avRaw === "" ? '<em style="color:var(--color-text-secondary)">empty</em>' : escapeHtml(avRaw);
    var bv = bvRaw === "" ? '<em style="color:var(--color-text-secondary)">empty</em>' : escapeHtml(bvRaw);
    var winnerCell = "";
    if (differs && f.combine) {
      // No winner to pick — both sides survive. The exact combined text depends
      // on which asset survives (it is labeled and ordered survivor-first), and
      // that is still changeable above, so the resulting value is previewed in
      // the confirmation step where the survivor is settled.
      winnerCell =
        '<span class="badge badge-active" title="Both assets\' notes are kept and combined onto the survivor — nothing is discarded">combined</span>';
    } else if (differs) {
      // Default winner: the side with a value; when both have one, the side the
      // operator's Sources priority prefers (A when it has no opinion).
      var defThis = _mergeDefaultWinner(A, B, f.key, preferredSide) === "this";
      winnerCell =
        '<div style="display:flex;gap:0.5rem;white-space:nowrap">' +
          '<label style="cursor:pointer"><input type="radio" name="mw-' + f.key + '" value="this"' + (defThis ? " checked" : "") + '> A</label>' +
          '<label style="cursor:pointer"><input type="radio" name="mw-' + f.key + '" value="other"' + (!defThis ? " checked" : "") + '> B</label>' +
        '</div>';
    }
    var rowStyle = differs ? ' style="background:var(--color-warning-bg, rgba(255,193,7,0.12))"' : '';
    return '<tr' + rowStyle + '>' +
      '<th style="text-align:left;padding:0.3rem 0.6rem 0.3rem 0;color:var(--color-text-secondary);font-weight:500;vertical-align:top;white-space:nowrap">' + escapeHtml(f.label) + (differs ? ' <span title="Differs">&#9679;</span>' : '') + '</th>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top;word-break:break-word">' + av + '</td>' +
      '<td style="padding:0.3rem 0.6rem;vertical-align:top;word-break:break-word">' + bv + '</td>' +
      '<td style="padding:0.3rem 0;vertical-align:top">' + winnerCell + '</td>' +
    '</tr>';
  }).join("");

  // Says WHY the radios are pre-selected the way they are — an operator who
  // disagrees should be pointed at the setting, not left re-picking every merge.
  var priorityHint = "";
  if (preferredSide && diffCount > 0) {
    var winSources = preferredSide === "this" ? _mergeThisSources : _mergeOtherSources;
    var loseSources = preferredSide === "this" ? _mergeOtherSources : _mergeThisSources;
    var winKind = _mergeTopRankedKind(winSources, priorityOrder);
    var loseKind = _mergeTopRankedKind(loseSources, priorityOrder);
    priorityHint =
      '<p class="hint" id="merge-priority-hint" style="margin:0 0 0.4rem">Pre-selected <strong>' + (preferredSide === "this" ? "A" : "B") + '</strong> ' +
      'where both sides have a value: its <strong>' + escapeHtml(_mergeSourceKindLabel(winKind)) + '</strong> source ranks higher than ' +
      (loseKind
        ? '<strong>' + escapeHtml(_mergeSourceKindLabel(loseKind)) + '</strong>'
        : 'anything on the other side') +
      ' in <strong>Settings &rarr; Sources</strong>. A side with no value never overwrites one, whatever its rank.</p>';
  }

  cmp.innerHTML =
    survivorHTML +
    '<div style="font-size:0.82rem;color:var(--color-text-secondary);margin-bottom:0.4rem">' +
      (diffCount === 0 ? 'No field differences — the two assets agree on every field.' : diffCount + ' field' + (diffCount === 1 ? '' : 's') + ' differ (highlighted). Pick the winning value for each.') +
      (depsConflict ? ' <strong>Both assets have dependency parents and they differ</strong> — pick whose upstream links the merged asset keeps (devices depending on either asset are combined either way).' : '') +
    '</div>' +
    priorityHint +
    '<div style="overflow:auto">' +
      '<table style="width:100%;font-size:0.85rem;border-collapse:collapse">' +
        '<thead><tr>' +
          '<th style="text-align:left;padding:0 0.6rem 0.4rem 0">Field</th>' +
          '<th style="text-align:left;padding:0 0.6rem 0.4rem">A: ' + _mergeAssetLabel(A) + (preferredSide === "this" ? srcBadge : "") + '</th>' +
          '<th style="text-align:left;padding:0 0.6rem 0.4rem">B: ' + _mergeAssetLabel(B) + (preferredSide === "other" ? srcBadge : "") + '</th>' +
          '<th style="text-align:left;padding:0 0 0.4rem">Keep</th>' +
        '</tr></thead>' +
        '<tbody>' + contextRows + fieldRows + '</tbody>' +
      '</table>' +
    '</div>';

  var btn = document.getElementById("merge-confirm-btn");
  if (btn && !btn._mergeBound) {
    btn._mergeBound = true;
    btn.addEventListener("click", _confirmMerge);
  }
}

// Resolve the merge plan from the operator's survivor + per-field winner
// choices. Mirrors the server's resolution (assetMergeService.mergeAssets):
// a field only OVERWRITES the survivor when the winning side has a non-empty
// value that differs from the survivor's current value. Picking the empty
// side never blanks the survivor (the backend guards this), so we don't show
// it as a change either.
function _buildMergePlan(survivor, fieldWinners, dependencyWinner) {
  var survivorAsset = survivor === "this" ? _mergeThisAsset : _mergeOtherAsset;
  var absorbedAsset = survivor === "this" ? _mergeOtherAsset : _mergeThisAsset;
  var absorbedSources = survivor === "this" ? _mergeOtherSources : _mergeThisSources;
  var survivorHistory = survivor === "this" ? _mergeThisHistory : _mergeOtherHistory;
  var absorbedHistory = survivor === "this" ? _mergeOtherHistory : _mergeThisHistory;
  var survivorDeps = survivor === "this" ? _mergeThisDeps : _mergeOtherDeps;
  var absorbedDeps = survivor === "this" ? _mergeOtherDeps : _mergeThisDeps;

  var overwrites = [];
  _mergeCompareFields.forEach(function (f) {
    var who = fieldWinners[f.key];           // "this" | "other" | undefined
    if (!who) return;                        // field didn't differ → no radio
    var winnerAsset = who === "this" ? _mergeThisAsset : _mergeOtherAsset;
    var winRaw = winnerAsset[f.key];
    // Empty winner can't overwrite a value (backend keeps the survivor's).
    var toAsset = _mergeIsEmpty(winRaw) ? survivorAsset : winnerAsset;
    var fromVal = _mergeFieldVal(survivorAsset, f);
    var toVal = _mergeFieldVal(toAsset, f);
    if (fromVal !== toVal) {
      overwrites.push({ key: f.key, label: f.label, from: fromVal, to: toVal });
    }
  });

  // Notes are combined, not won — resolved here because the label order is
  // survivor-first and the survivor is only settled at this point. `undefined`
  // means nothing changes (one side empty, identical text, or already
  // contained), which is exactly what the service writes.
  var combinedNotes = _mergeCombineNotes(survivorAsset, absorbedAsset);

  // Tags the union will ADD to the survivor (absorbed tags not already held).
  var survTags = (survivorAsset.tags || []);
  var have = {};
  survTags.forEach(function (t) { have[t] = true; });
  var tagsAdded = (absorbedAsset.tags || []).filter(function (t) { return !have[t]; });

  // monitored is OR-ed server-side; only the OFF→ON direction is a change worth
  // showing. Mirrors assetMergeService's carriedMonitoring, including the
  // business-rule-10 exclusion (a decommissioned/disabled survivor stays off) —
  // status here is the post-merge value the winners resolve to.
  var mergedStatus = survivorAsset.status;
  overwrites.forEach(function (o) { if (o.key === "status") mergedStatus = o.to; });
  var monitoringCarried = !!absorbedAsset.monitored && !survivorAsset.monitored &&
    mergedStatus !== "decommissioned" && mergedStatus !== "disabled";

  // Dependency plan — mirrors transferDependencyEdges server-side. Dependents
  // are always combined; the absorbed side's own parent links carry when the
  // survivor has none, and when both sides have parents the operator's
  // dependencyWinner ("this"/"other") decides — omitted = survivor keeps its own.
  var survParentNames = _mergeDepParentNames(survivorDeps);
  var absParentNames = _mergeDepParentNames(absorbedDeps);
  var depParentsCarried = [];   // parent names landing on the survivor from the absorbed side
  var depParentsDiscarded = []; // parent names dropped by the merge (the conflict's losing side)
  if (absParentNames.length) {
    if (!survParentNames.length) {
      depParentsCarried = absParentNames;
    } else if (_mergeDepParentsKey(survivorDeps) !== _mergeDepParentsKey(absorbedDeps)) {
      var winnerAssetObj = dependencyWinner === "this" ? _mergeThisAsset : dependencyWinner === "other" ? _mergeOtherAsset : survivorAsset;
      if (winnerAssetObj === absorbedAsset) {
        depParentsCarried = absParentNames;
        depParentsDiscarded = survParentNames;
      } else {
        depParentsDiscarded = absParentNames;
      }
    }
  }
  var absDependentCount = absorbedDeps && absorbedDeps.childCount > 0 ? absorbedDeps.childCount : 0;

  return {
    survivorAsset: survivorAsset,
    absorbedAsset: absorbedAsset,
    absorbedSources: absorbedSources || [],
    overwrites: overwrites,
    combinedNotes: combinedNotes,
    tagsAdded: tagsAdded,
    monitoringCarried: monitoringCarried,
    depParentsCarried: depParentsCarried,
    depParentsDiscarded: depParentsDiscarded,
    absDependentCount: absDependentCount,
    survivorHistory: survivorHistory,
    absorbedHistory: absorbedHistory,
    // The operator kept the side with LESS polling history — allowed (their
    // call), but the review calls it out since the longer history is deleted.
    losingLongerHistory: _mergeHistoryLonger(absorbedHistory, survivorHistory)
  };
}

// Stacked confirmation modal (own overlay at a higher z-index, like
// showConfirm) so the comparison modal underneath stays intact — "Back"
// just dismisses this layer. Resolves true on confirm, false otherwise.
function _showMergeReviewModal(survivor, fieldWinners, dependencyWinner) {
  return new Promise(function (resolve) {
    var plan = _buildMergePlan(survivor, fieldWinners, dependencyWinner);
    var survLabel = _mergeAssetLabel(plan.survivorAsset);
    var absLabel = _mergeAssetLabel(plan.absorbedAsset);

    var overwriteHTML;
    if (plan.overwrites.length === 0) {
      overwriteHTML = '<p style="margin:0;color:var(--color-text-secondary);font-size:0.85rem">No fields on <strong>' + survLabel + '</strong> will change — every winning value matches what it already has.</p>';
    } else {
      overwriteHTML =
        '<table style="width:100%;font-size:0.85rem;border-collapse:collapse">' +
          '<thead><tr>' +
            '<th style="text-align:left;padding:0 0.6rem 0.35rem 0">Field</th>' +
            '<th style="text-align:left;padding:0 0.6rem 0.35rem">Current</th>' +
            '<th style="text-align:left;padding:0 0 0.35rem">New value</th>' +
          '</tr></thead><tbody>' +
          plan.overwrites.map(function (o) {
            var from = o.from === "" ? '<em style="color:var(--color-text-secondary)">empty</em>' : escapeHtml(o.from);
            var to = o.to === "" ? '<em style="color:var(--color-text-secondary)">empty</em>' : escapeHtml(o.to);
            return '<tr>' +
              '<th style="text-align:left;padding:0.25rem 0.6rem 0.25rem 0;color:var(--color-text-secondary);font-weight:500;white-space:nowrap;vertical-align:top">' + escapeHtml(o.label) + '</th>' +
              '<td style="padding:0.25rem 0.6rem;vertical-align:top;word-break:break-word;color:var(--color-danger)">' + from + '</td>' +
              '<td style="padding:0.25rem 0;vertical-align:top;word-break:break-word;color:var(--color-success)">' + to + '</td>' +
            '</tr>';
          }).join("") +
          '</tbody></table>';
    }

    var combinedBits = [];
    if (plan.absorbedSources.length) {
      var kinds = plan.absorbedSources.map(function (s) { return (_assetSourceLabels && _assetSourceLabels[s.sourceKind]) || s.sourceKind; });
      combinedBits.push(plan.absorbedSources.length + ' discovery source' + (plan.absorbedSources.length === 1 ? '' : 's') + ' (' + escapeHtml(kinds.join(", ")) + ')');
    }
    combinedBits.push('MAC, IP and firewall-sighting history');
    // Dependency links. Dependents combine unconditionally; the parent-link
    // line only appears when the absorbed side actually contributes some.
    if (plan.absDependentCount > 0) {
      combinedBits.push(plan.absDependentCount + ' infra device' + (plan.absDependentCount === 1 ? '' : 's') +
        ' depending on ' + absLabel + ' (plus any endpoint devices behind it) re-pointed to ' + survLabel);
    } else {
      combinedBits.push('any devices depending on ' + absLabel + ' are re-pointed to ' + survLabel);
    }
    if (plan.depParentsCarried.length) {
      combinedBits.push('dependency parent' + (plan.depParentsCarried.length === 1 ? '' : 's') + ' from ' + absLabel + ': ' +
        plan.depParentsCarried.map(escapeHtml).join(", "));
    }
    if (plan.tagsAdded.length) {
      combinedBits.push('tags: ' + plan.tagsAdded.map(escapeHtml).join(", "));
    }
    // The OR-ed monitored flag is the one change an operator can't infer from
    // the field table (monitored isn't a mergeable field with winner radios),
    // so call it out explicitly along with the config that rides with it.
    if (plan.monitoringCarried) {
      combinedBits.push('<strong>monitoring stays enabled</strong> — ' + absLabel +
        ' was monitored, so ' + survLabel + ' is switched on, adopting its polling methods, ' +
        'credentials, cadences and pinned interfaces / storage / processes (status resets to unknown until the first poll)');
    }

    var bodyHTML =
      '<p style="margin:0 0 0.85rem;font-size:0.9rem">Merging <strong>' + absLabel + '</strong> into <strong>' + survLabel + '</strong>. Review the changes before confirming.</p>' +

      '<div class="section-block" style="margin-bottom:0.75rem;padding:0.6rem 0.75rem">' +
        '<div class="section-label" style="margin-bottom:0.4rem">Will be overwritten on ' + survLabel + (plan.overwrites.length ? ' (' + plan.overwrites.length + ')' : '') + '</div>' +
        overwriteHTML +
      '</div>' +

      '<div class="section-block" style="margin-bottom:0.75rem;padding:0.6rem 0.75rem">' +
        '<div class="section-label" style="margin-bottom:0.4rem">Combined onto ' + survLabel + '</div>' +
        '<ul style="margin:0;padding-left:1.1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
          combinedBits.map(function (b) { return '<li>' + b + '</li>'; }).join("") +
        '</ul>' +
      '</div>' +

      '<div class="section-block" style="margin-bottom:0;padding:0.6rem 0.75rem;border-left:3px solid var(--color-danger)">' +
        '<div class="section-label" style="margin-bottom:0.4rem;color:var(--color-danger)">Permanently deleted</div>' +
        '<ul style="margin:0;padding-left:1.1rem;font-size:0.85rem;color:var(--color-text-secondary)">' +
          '<li>The absorbed asset <strong>' + absLabel + '</strong> (its row is removed)</li>' +
          '<li>Its monitoring / telemetry / sample history' +
            (plan.absorbedHistory && plan.absorbedHistory.sampleCount
              ? ' — <strong>' + escapeHtml(_mergeHistoryText(plan.absorbedHistory)) + '</strong>'
              : (plan.absorbedHistory ? ' (none recorded)' : '')) +
            ' and interface-comment overrides</li>' +
          (plan.depParentsDiscarded.length
            ? '<li>The <strong>losing side\'s dependency parent link' + (plan.depParentsDiscarded.length === 1 ? '' : 's') + '</strong> (' +
              plan.depParentsDiscarded.map(escapeHtml).join(", ") + ') — the merged asset keeps the side you picked</li>'
            : '') +
        '</ul>' +
        (plan.losingLongerHistory
          ? '<p style="margin:0.5rem 0 0;font-size:0.82rem;color:var(--color-danger)"><strong>Note:</strong> the absorbed asset holds <strong>more</strong> polling history than the survivor (' +
            escapeHtml(_mergeHistoryText(plan.absorbedHistory)) + ' vs ' + escapeHtml(_mergeHistoryText(plan.survivorHistory)) +
            '). Keeping ' + survLabel + ' deletes the longer record — go Back and switch the survivor to preserve it.</p>'
          : '') +
        '<p style="margin:0.5rem 0 0;font-size:0.82rem;color:var(--color-text-secondary)">This cannot be undone. Use <strong>Split</strong> afterward if you need to separate a source again.</p>' +
      '</div>';

    var overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1300";
    overlay.innerHTML =
      '<div class="modal modal-wide">' +
        '<div class="modal-header"><h3>Confirm merge</h3></div>' +
        '<div class="modal-body">' + bodyHTML + '</div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" data-merge-review="back">Back</button>' +
          '<button class="btn btn-danger" data-merge-review="ok">Confirm merge</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    function done(val) {
      overlay.classList.remove("open");
      overlay.addEventListener("transitionend", function () { if (overlay.parentNode) overlay.remove(); }, { once: true });
      setTimeout(function () { if (overlay.parentNode) overlay.remove(); }, 400);
      resolve(val);
    }
    overlay.querySelector('[data-merge-review="back"]').onclick = function () { done(false); };
    overlay.querySelector('[data-merge-review="ok"]').onclick = function () { done(true); };
    overlay.addEventListener("click", function (e) { if (e.target === overlay) done(false); });
    revealOverlay(overlay);
  });
}

async function _confirmMerge() {
  if (!_mergeThisAsset || !_mergeOtherAsset) return;
  var survEl = document.querySelector('input[name="merge-survivor"]:checked');
  var survivor = survEl ? survEl.value : "this";
  var fieldWinners = {};
  _mergeCompareFields.forEach(function (f) {
    var sel = document.querySelector('input[name="mw-' + f.key + '"]:checked');
    if (sel) fieldWinners[f.key] = sel.value; // "this" | "other"
  });
  // Dependency-parent conflict pick — only rendered when both sides have
  // differing parent sets; undefined otherwise (server default: survivor's).
  var depSel = document.querySelector('input[name="mw-deps"]:checked');
  var dependencyWinner = depSel ? depSel.value : undefined; // "this" | "other"

  // Open the review modal: it shows exactly what will be overwritten on the
  // survivor (given the per-field winners), what gets combined, and what is
  // permanently deleted. Returns true only when the operator confirms.
  var ok = await _showMergeReviewModal(survivor, fieldWinners, dependencyWinner);
  if (!ok) return;

  var btn = document.getElementById("merge-confirm-btn");
  if (btn) btn.disabled = true;
  try {
    var body = {
      otherAssetId: _mergeOtherAsset.id,
      survivor: survivor,
      fieldWinners: fieldWinners
    };
    if (dependencyWinner) body.dependencyWinner = dependencyWinner;
    var result = await api.assets.merge(_mergeThisAsset.id, body);
    closeModal();
    showToast('Assets merged — moved ' + result.movedSources + ' source(s)' +
      (result.movedDependents ? ', re-pointed ' + result.movedDependents + ' dependent(s)' : ''));
    // Whatever the host page needs to refresh now that one of the two rows is
    // gone. Awaited so a failure surfaces in the catch below rather than as an
    // unhandled rejection — the merge itself has already committed by here, so
    // the toast above is the truth regardless of what the refresh does.
    if (_mergeOnDone) await _mergeOnDone(result);
  } catch (err) {
    if (btn) btn.disabled = false;
    showToast(err.message || 'Merge failed', 'error');
  }
}
