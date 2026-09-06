/**
 * public/js/assets-maintenance.js
 *
 * Maintenance modal for the Assets page (toolbar → Maintenance, gated by the
 * maintenanceManagement RBAC key). Two tabs:
 *
 *   Create Schedule — name + dynamic asset filter (partial hostname, IP or
 *     subnet CIDR, model, manufacturer, OS, asset type — only MONITORED
 *     assets are eligible) with a debounced live device-list preview, plus a
 *     schedule editor (one-time window or daily/weekly/monthly/yearly
 *     recurrence with time-of-day range and optional active date bounds).
 *     The same form doubles as the editor when a schedule is opened from the
 *     list tab.
 *
 *   Schedules — every schedule with a human-readable date/time summary,
 *     enabled toggle, edit + delete.
 *
 * Also exposes the ad-hoc helper used by the status-pill / edit-modal flows
 * in assets.js: maintCreateAdhoc(assetId, hostname, endLocalIso) creates a
 * one-shot single-asset schedule starting now (the server reconciles inline,
 * so the asset is in maintenance before the call resolves).
 *
 * Builder markup mirrors the tag-criteria builder in server-settings.js
 * (which is NOT loaded on this page) with maint-prefixed ids/classes.
 * Times are SERVER-LOCAL wall-clock — the recurrence engine evaluates
 * schedules against the Polaris server's clock, stated in the UI hint.
 *
 * Depends on globals from app.js (openModal/closeModal/showToast/showConfirm/
 * escapeHtml/canManageMaintenance) and app.js (tabbedBodyHTML/
 * wireModalTabs), both loaded before this file on assets.html.
 */

/* global api, openModal, closeModal, showToast, showConfirm, escapeHtml,
          tabbedBodyHTML, wireModalTabs, loadAssets */

// ─── Filter vocabulary ───────────────────────────────────────────────────────

var MAINT_CRITERIA_FIELDS = [
  { value: "hostname",     label: "Hostname",         kind: "string" },
  { value: "subnet",       label: "IP / Subnet",      kind: "subnet" },
  { value: "model",        label: "Model",            kind: "string" },
  { value: "manufacturer", label: "Manufacturer",     kind: "string" },
  { value: "os",           label: "Operating system", kind: "string" },
  { value: "osVersion",    label: "OS version",       kind: "string" },
  { value: "assetType",    label: "Asset type",       kind: "assetType" },
  { value: "integration",  label: "Integration",      kind: "integration" },
  { value: "fortigate",    label: "Behind FortiGate", kind: "fortigate" },
];
var MAINT_STRING_OPS = [
  { value: "contains", label: "contains" },
  { value: "exact",    label: "is" },
  { value: "pattern",  label: "matches (wildcard *)" },
];
var MAINT_WEEKDAYS = [
  { value: 0, label: "Sun" }, { value: 1, label: "Mon" }, { value: 2, label: "Tue" },
  { value: 3, label: "Wed" }, { value: 4, label: "Thu" }, { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
];

var _maintSchedules = [];       // list-tab cache
var _maintEditingId = null;     // schedule id being edited (null = create mode)
var _maintEditingAssetIds = []; // explicit assetIds carried by the edited schedule
var _maintPreviewTimer = null;
var _maintAssetTypesCache = null;
var _maintIntegrationsCache = null; // [{id, name, type}] for the Integration rule select
var _maintFortigateNamesCache = null; // firewall hostnames for the Behind-FortiGate datalist
// Server-clock skew (ms to ADD to a browser wall clock to reach the server's).
// Null until the first /server-time read resolves; 0 once it does and the two
// clocks agree. See _maintLoadServerClock.
var _maintClockSkewMs = null;
var _maintServerTz = "";
// Has the operator typed in either one-shot field? Gates the async re-prefill
// so a late clock read can never overwrite a time they picked themselves.
var _maintOneshotTouched = false;

// ─── Local-time formatting ──────────────────────────────────────────────────

function _maintPad(n) { return (n < 10 ? "0" : "") + n; }

/** Date → "YYYY-MM-DDTHH:MM" in local time (datetime-local value format). */
function _maintLocalIso(d) {
  return d.getFullYear() + "-" + _maintPad(d.getMonth() + 1) + "-" + _maintPad(d.getDate()) +
    "T" + _maintPad(d.getHours()) + ":" + _maintPad(d.getMinutes());
}

// ─── Server clock ───────────────────────────────────────────────────────────
//
// Maintenance windows are picked in the SERVER's local wall clock — the
// recurrence engine runs there and the shapes carry no offset (see
// serverClockInfo in src/utils/maintenanceRecurrence.ts). Prefilling a
// datetime-local from the BROWSER's clock therefore posts the operator's digits
// for the server to read as its own: on a UTC-clocked host with a Central
// operator a "now → now + 2h" window lands 5-6 hours in the server's past and
// has already ENDED, so the schedule saves cleanly and no asset ever enters
// maintenance. Everything below picks, validates and labels in server time.

/** Parse "YYYY-MM-DDTHH:MM" treating the digits as BROWSER-local. */
function _maintParseLocalIso(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(iso || ""));
  if (!m) return null;
  var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * A Date whose BROWSER-local wall-clock digits equal the server's wall clock
 * right now — i.e. exactly what _maintLocalIso must be fed to produce a value
 * the server will read back as the same moment. Falls back to the browser's own
 * clock while the skew is unknown (unread, or the read failed): that is the
 * pre-fix behaviour, which is right whenever the two clocks agree and no worse
 * than it ever was when they don't.
 */
function maintServerNow() {
  return new Date(Date.now() + (_maintClockSkewMs || 0));
}

/**
 * Read the server's clock once per page and cache the skew.
 *
 * The skew folds timezone difference AND plain clock drift into one number,
 * which is all the callers need. It is rounded to the minute because the
 * pickers are minute-granular and the round trip contributes sub-second error.
 */
async function _maintLoadServerClock() {
  if (_maintClockSkewMs !== null) return;
  try {
    var info = await api.maintenanceSchedules.serverTime();
    var serverWall = _maintParseLocalIso(info && info.now);
    if (!serverWall) return;
    var raw = serverWall.getTime() - Date.now();
    _maintClockSkewMs = Math.round(raw / 60000) * 60000;
    _maintServerTz = (info && info.timeZone) || "";
  } catch (err) {
    // Best-effort: leave the skew unknown so maintServerNow falls back.
  }
}

/** Human label for the server clock: "America/Chicago — now Aug 19 2026 14:30". */
function maintServerClockLabel() {
  if (_maintClockSkewMs === null) return "";
  var nowIso = _maintLocalIso(maintServerNow());
  return (_maintServerTz ? _maintServerTz + " — " : "") + "server time now " + _maintFmtLocal(nowIso);
}

/**
 * Paint the live server clock into the editor's When hint, and re-prefill the
 * one-shot fields from it unless the operator has already typed a time.
 */
function _maintApplyServerClock() {
  var hint = document.getElementById("maint-tz-hint");
  if (hint) {
    var label = maintServerClockLabel();
    hint.textContent = "Times are the Polaris server’s local wall-clock" +
      (label ? " (" + label + ")" : "") +
      ". An end time at or before the start time spans midnight into the next day.";
  }
  if (_maintOneshotTouched || _maintEditingId) return;
  var startEl = document.getElementById("maint-start");
  var endEl = document.getElementById("maint-end");
  if (!startEl || !endEl) return;
  var now = maintServerNow();
  startEl.value = _maintLocalIso(now);
  endEl.value = _maintLocalIso(new Date(now.getTime() + 2 * 60 * 60 * 1000));
}

var _MAINT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function _maintFmtLocal(iso) {
  // "2026-07-12T22:00(:ss)" → "Jul 12 2026 22:00"
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return _MAINT_MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[1] + " " + m[4];
}

function _maintFmtDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
  if (!m) return String(iso || "");
  return _MAINT_MONTHS[Number(m[2]) - 1] + " " + Number(m[3]) + " " + m[1];
}

/** Human-readable one-liner for a schedule's recurrence shape. */
function maintScheduleSummary(schedule) {
  if (!schedule || !schedule.kind) return "—";
  if (schedule.kind === "oneshot") {
    return "One-time " + _maintFmtLocal(schedule.startAt) + " → " + _maintFmtLocal(schedule.endAt);
  }
  var time = schedule.startTime && schedule.endTime
    ? " " + schedule.startTime + "–" + schedule.endTime
    : " (all day)";
  var base;
  switch (schedule.freq) {
    case "daily":  base = "Daily" + time; break;
    case "weekly": {
      var days = (schedule.daysOfWeek || []).slice().sort().map(function (d) {
        var w = MAINT_WEEKDAYS.find(function (x) { return x.value === d; });
        return w ? w.label : d;
      }).join(", ");
      base = "Weekly " + days + time;
      break;
    }
    case "monthly": base = "Monthly on day " + schedule.dayOfMonth + time; break;
    case "yearly":  base = "Yearly " + _MAINT_MONTHS[(schedule.month || 1) - 1] + " " + schedule.day + time; break;
    default: base = schedule.freq + time;
  }
  if (schedule.activeFrom || schedule.activeUntil) {
    base += " · " + (schedule.activeFrom ? _maintFmtDate(schedule.activeFrom) : "…") +
      " – " + (schedule.activeUntil ? _maintFmtDate(schedule.activeUntil) : "…");
  }
  return base;
}

/**
 * The recurrence seam other surfaces read.
 *
 * `MaintenanceSchedule.schedule` stopped being the only thing shaped like a
 * recurrence when automation reminders gained a quiet time (business rule 44):
 * both are the same JSON, validated by the same server-side schema
 * (`maintenanceRecurrence.scheduleShapeSchema`). The automations wizard
 * therefore labels its quiet windows through THIS function rather than growing
 * a second summariser — two summarisers of one shape drift, and the drift
 * shows up as two different sentences describing the same window on two pages.
 *
 * Named rather than reached for as `maintScheduleSummary` so the dependency is
 * legible from the other side, and resolved at CALL time so script order
 * between the two files can't matter.
 */
window.PolarisRecurrence = {
  /** One-line human summary of a recurrence shape (oneshot or recurring). */
  summary: maintScheduleSummary,
  /** The weekday vocabulary the day pickers render from (0 = Sunday). */
  weekdays: MAINT_WEEKDAYS,
};

// ─── Modal shell ────────────────────────────────────────────────────────────

/**
 * Open the Maintenance modal.
 *
 * opts.assetIds — explicit device ids to pin as targets, from the Assets page
 *   bulk bar ("select rows → Maintenance"). They land in
 *   `_maintEditingAssetIds`, i.e. the same explicit-assetIds channel an edited
 *   schedule's pins ride, so the preview, the explicit-includes line and the
 *   save body need no selection-specific path. A name is prefilled (the
 *   operator can overwrite it) but nothing is created until Save — unlike the
 *   status-pill ad-hoc flow this is a normal named schedule, one-time or
 *   recurring, and the operator may add filter rules on top of the pins.
 */
async function openMaintenanceModal(opts) {
  var pinned = (opts && Array.isArray(opts.assetIds)) ? opts.assetIds.slice() : [];
  _maintEditingId = null;
  _maintEditingAssetIds = pinned;
  var body = tabbedBodyHTML("maint", [
    { key: "create",   label: "Create Schedule", html: _maintEditorHTML() },
    { key: "list",     label: "Schedules",       html: '<div id="maint-list-body" class="empty-state">Loading…</div>' },
    { key: "calendar", label: "Calendar",        html: _maintCalendarHTML() },
  ]);
  openModal(
    "Maintenance",
    body,
    '<button class="btn btn-secondary" onclick="closeModal()">Close</button>',
    { large: true }
  );
  wireModalTabs("maint");
  _maintWireEditor();
  _maintWireCalendar();
  _maintReloadList();
  // Pinned selection: _maintWireEditor() has just reset the editor's one-shot
  // date fields, so prefill AFTER it — and paint the explicit-includes line
  // here rather than in _maintEditorHTML(), which renders before the pins are
  // known to the DOM.
  if (pinned.length) {
    var nameEl = document.getElementById("maint-name");
    if (nameEl && !nameEl.value) {
      nameEl.value = "Maintenance — " + pinned.length +
        (pinned.length === 1 ? " device" : " devices");
    }
    _maintSyncExplicitLine();
    _maintRefreshPreview();
    if (nameEl) { nameEl.focus(); nameEl.select(); }
  }
}

// ─── Tab 1 — schedule editor ────────────────────────────────────────────────

function _maintFieldKind(field) {
  var f = MAINT_CRITERIA_FIELDS.find(function (x) { return x.value === field; });
  return f ? f.kind : "string";
}

function _maintRuleCellsHTML(field, op, valueStr) {
  var kind = _maintFieldKind(field);

  // Integration: exact-only, picked from the configured integrations.
  if (kind === "integration") {
    var opLabel = '<span style="flex:0 0 auto;align-self:center;color:var(--color-text-secondary);font-size:0.82rem">is</span>';
    if (_maintIntegrationsCache === null) {
      // Lookup fetch still in flight — placeholder select carrying the
      // desired value so _maintLoadEditorLookups can re-render with it.
      return opLabel +
        '<select class="maint-rule-integration" data-pending-value="' + escapeHtml(valueStr || "") + '" style="flex:1;width:auto">' +
          '<option value="">Loading integrations…</option>' +
        '</select>';
    }
    var known = _maintIntegrationsCache.some(function (i) { return i.id === valueStr; });
    var opts = _maintIntegrationsCache.map(function (i) {
      return '<option value="' + escapeHtml(i.id) + '"' + (i.id === valueStr ? " selected" : "") + '>' +
        escapeHtml(i.name + " (" + i.type + ")") + '</option>';
    }).join("");
    // A saved rule referencing a since-deleted integration keeps its id
    // visible rather than silently rewriting the rule on the next save.
    if (valueStr && !known) opts += '<option value="' + escapeHtml(valueStr) + '" selected>(deleted integration)</option>';
    return opLabel +
      '<select class="maint-rule-integration" style="flex:1;width:auto">' +
        (opts || '<option value="">No integrations configured</option>') +
      '</select>';
  }

  var opHtml;
  if (kind === "string" || kind === "fortigate") {
    // width:auto beats the global `select { width: 100% }` — with basis
    // `auto` that 100% width becomes the flex basis and the op select
    // stretches across the row, crushing the value input.
    opHtml = '<select class="maint-rule-op" style="flex:0 0 auto;width:auto">' +
      MAINT_STRING_OPS.map(function (o) {
        return '<option value="' + o.value + '"' + (o.value === op ? " selected" : "") + '>' + escapeHtml(o.label) + '</option>';
      }).join("") + '</select>';
  } else if (kind === "subnet") {
    opHtml = '<span style="flex:0 0 auto;align-self:center;color:var(--color-text-secondary);font-size:0.82rem">in</span>';
  } else {
    opHtml = '<span style="flex:0 0 auto;align-self:center;color:var(--color-text-secondary);font-size:0.82rem">is</span>';
  }
  var placeholder, listAttr = "";
  if (kind === "subnet") placeholder = "10.1.0.0/16, 10.2.3.4/32";
  else if (kind === "assetType") { placeholder = "firewall, switch"; listAttr = ' list="maint-assettype-list"'; }
  else if (kind === "fortigate") { placeholder = "RIVERBEND-FG, or a site prefix with contains"; listAttr = ' list="maint-fortigate-list"'; }
  else placeholder = "value, another value";
  return opHtml +
    '<input type="text" class="maint-rule-input" style="flex:1"' + listAttr +
    ' placeholder="' + escapeHtml(placeholder) + '" value="' + escapeHtml(valueStr || "") + '">';
}

function _maintRuleRowHTML(rule) {
  var field = rule ? rule.field : "hostname";
  var op = rule ? (rule.op || "contains") : "contains";
  var valueStr = "";
  if (rule) {
    if (rule.field === "subnet") valueStr = (rule.cidrs || []).join(", ");
    else if (rule.field === "integration") valueStr = (rule.values || [])[0] || ""; // select preselect (single id)
    else valueStr = (rule.values || []).join(", ");
  }
  var fieldOpts = MAINT_CRITERIA_FIELDS.map(function (f) {
    return '<option value="' + f.value + '"' + (f.value === field ? " selected" : "") + '>' + escapeHtml(f.label) + '</option>';
  }).join("");
  return '<div class="maint-rule" style="display:flex;gap:6px;margin-bottom:6px;align-items:flex-start">' +
    '<select class="maint-rule-field" style="flex:0 0 9.5rem">' + fieldOpts + '</select>' +
    '<div class="maint-rule-cells" style="display:flex;gap:6px;flex:1">' + _maintRuleCellsHTML(field, op, valueStr) + '</div>' +
    '<button type="button" class="maint-rule-remove btn-icon" title="Remove rule" aria-label="Remove rule" ' +
      'style="flex:0 0 auto;border:1px solid var(--color-border);border-radius:4px;background:transparent;color:var(--color-text-secondary);cursor:pointer;width:30px;height:30px">×</button>' +
  '</div>';
}

function _maintEditorHTML() {
  // Default all checked = "every day" (collected as freq=daily).
  var weekdayBoxes = MAINT_WEEKDAYS.map(function (w) {
    return '<label style="display:inline-flex;align-items:center;gap:4px;margin-right:10px;cursor:pointer">' +
      '<input type="checkbox" class="maint-dow" value="' + w.value + '" checked style="width:auto">' + w.label + '</label>';
  }).join("");
  return (
    '<div id="maint-edit-banner" class="hint" style="display:none;margin-bottom:8px;font-weight:600"></div>' +
    '<div class="form-group">' +
      '<label>Schedule name</label>' +
      '<input type="text" id="maint-name" maxlength="200" placeholder="e.g. Shop switch stack patching">' +
    '</div>' +

    '<div class="form-group" style="border-top:1px solid var(--color-border);padding-top:12px">' +
      '<label>Asset filter</label>' +
      '<p class="hint">Assets matching ALL rules enter maintenance while the schedule is active. Only <strong>monitored</strong> assets are eligible. A single IP is a /32 CIDR (e.g. <code>10.2.3.4/32</code>).</p>' +
      '<div id="maint-rules">' + _maintRuleRowHTML(null) + '</div>' +
      '<button type="button" id="maint-add-rule" class="btn btn-secondary btn-sm" style="margin-top:4px">+ Add rule</button>' +
      '<div id="maint-explicit" class="hint" style="display:none;margin-top:6px"></div>' +
      '<datalist id="maint-assettype-list"></datalist>' +
      '<datalist id="maint-fortigate-list"></datalist>' +
    '</div>' +

    '<div class="form-group">' +
      '<label>Included devices (preview)</label>' +
      '<div id="maint-preview" class="hint" style="font-style:italic">Add a filter rule to preview matching devices.</div>' +
    '</div>' +

    '<div class="form-group" style="border-top:1px solid var(--color-border);padding-top:12px">' +
      '<label>When</label>' +
      '<p class="hint" id="maint-tz-hint">Times are the Polaris server’s local wall-clock. An end time at or before the start time spans midnight into the next day.</p>' +
      '<label style="display:inline-flex;align-items:center;gap:6px;margin-right:16px;cursor:pointer">' +
        '<input type="radio" name="maint-kind" id="maint-kind-oneshot" value="oneshot" checked style="width:auto"> One-time window' +
      '</label>' +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">' +
        '<input type="radio" name="maint-kind" id="maint-kind-recurring" value="recurring" style="width:auto"> Recurring' +
      '</label>' +

      '<div id="maint-oneshot-block" style="margin-top:10px;display:flex;gap:12px;flex-wrap:wrap">' +
        '<div><label>Start</label><input type="datetime-local" id="maint-start"></div>' +
        '<div><label>End</label><input type="datetime-local" id="maint-end"></div>' +
      '</div>' +

      '<div id="maint-recurring-block" style="margin-top:10px;display:none">' +
        '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">' +
          '<div><label>Repeats</label>' +
            '<select id="maint-freq" style="width:auto">' +
              '<option value="days">Specific days of the week</option>' +
              '<option value="monthly">Monthly</option><option value="yearly">Yearly</option>' +
            '</select></div>' +
          '<div id="maint-monthly-block" style="display:none"><label>Day of month</label>' +
            '<input type="number" id="maint-daymonth" min="1" max="31" value="1" style="max-width:90px">' +
            '<span class="hint" style="display:block">31 = last-day clamp in short months</span></div>' +
          '<div id="maint-yearly-block" style="display:none"><label>Month / day</label>' +
            '<select id="maint-month" style="max-width:110px">' +
              _MAINT_MONTHS.map(function (m, i) { return '<option value="' + (i + 1) + '">' + m + '</option>'; }).join("") +
            '</select> ' +
            '<input type="number" id="maint-day" min="1" max="31" value="1" style="max-width:80px">' +
          '</div>' +
        '</div>' +
        '<div id="maint-weekly-block" style="margin-top:8px">' +
          '<label>Days</label>' +
          '<div>' + weekdayBoxes + '</div>' +
          '<span class="hint">All days checked = every day.</span>' +
        '</div>' +
        '<div style="margin-top:10px">' +
          '<label>Time range</label>' +
          '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin-right:14px">' +
            '<input type="checkbox" id="maint-allday" style="width:auto"> All day' +
          '</label>' +
          '<span id="maint-time-range">' +
            '<input type="time" id="maint-time-start" value="20:00"> &ndash; <input type="time" id="maint-time-end" value="02:00">' +
          '</span>' +
          '<span class="hint" style="display:block">An end at or before the start runs into the next day — 20:00 &ndash; 02:00 ends at 2 AM the following morning (the day checkboxes match the START day).</span>' +
        '</div>' +
        '<div style="margin-top:10px">' +
          '<label>Date range (optional)</label>' +
          '<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">' +
            '<input type="date" id="maint-active-from" style="width:auto"> &ndash; ' +
            '<input type="date" id="maint-active-until" style="width:auto">' +
          '</div>' +
          '<span class="hint">First / last day the schedule applies (inclusive). Leave empty for no bounds.</span>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '<div class="form-group" style="border-top:1px solid var(--color-border);padding-top:12px">' +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin:0">' +
        '<input type="checkbox" id="maint-suppress-children" checked style="width:auto"> Mark dependent devices as down' +
      '</label>' +
      '<p class="hint" style="margin:4px 0 0">Devices behind an in-maintenance asset go into dependency suppression (their notifications pause) for the window — as if the asset went offline. Uncheck when dependents stay reachable (redundant path, clustered parent) and should keep monitoring and alerting normally.</p>' +
    '</div>' +

    '<div class="form-group" style="display:flex;align-items:center;gap:16px;border-top:1px solid var(--color-border);padding-top:12px">' +
      '<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;margin:0">' +
        '<input type="checkbox" id="maint-enabled" checked style="width:auto"> Enabled' +
      '</label>' +
      '<button type="button" class="btn btn-primary" id="maint-save">Create Schedule</button>' +
      '<button type="button" class="btn btn-secondary" id="maint-cancel-edit" style="display:none">Cancel Edit</button>' +
    '</div>'
  );
}

function _maintCollectCriteria() {
  // Shared DOM→TagCriteria walker (api.js collectTagCriteria) — the wire
  // shape (comma-split, bare-IP→/32 promotion, integration single-id) is
  // identical to the appmap discovery wizard's device step by requirement.
  return collectTagCriteria({
    rowSelector: "#maint-rules .maint-rule",
    fieldSel: ".maint-rule-field",
    integrationSel: ".maint-rule-integration",
    opSel: ".maint-rule-op",
    inputSel: ".maint-rule-input",
  });
}

function _maintCollectSchedule() {
  var oneshot = document.getElementById("maint-kind-oneshot").checked;
  if (oneshot) {
    var startAt = document.getElementById("maint-start").value;
    var endAt = document.getElementById("maint-end").value;
    if (!startAt || !endAt) throw new Error("Start and end are required for a one-time window");
    return { version: 1, kind: "oneshot", startAt: startAt, endAt: endAt };
  }
  var freq = document.getElementById("maint-freq").value;
  var out = { version: 1, kind: "recurring", freq: freq };
  if (freq === "days") {
    // UI mode "specific days" maps onto the stored shape: all 7 checked =
    // freq "daily", a subset = freq "weekly" + daysOfWeek.
    var days = Array.prototype.map.call(
      document.querySelectorAll(".maint-dow:checked"),
      function (cb) { return Number(cb.value); }
    );
    if (!days.length) throw new Error("Pick at least one day of the week");
    if (days.length === 7) {
      out.freq = "daily";
    } else {
      out.freq = "weekly";
      out.daysOfWeek = days;
    }
  }
  if (freq === "monthly") out.dayOfMonth = parseInt(document.getElementById("maint-daymonth").value, 10) || 1;
  if (freq === "yearly") {
    out.month = parseInt(document.getElementById("maint-month").value, 10) || 1;
    out.day = parseInt(document.getElementById("maint-day").value, 10) || 1;
  }
  if (!document.getElementById("maint-allday").checked) {
    var ts = document.getElementById("maint-time-start").value;
    var te = document.getElementById("maint-time-end").value;
    if (!ts || !te) throw new Error("Start and end times are required (or check All day)");
    out.startTime = ts;
    out.endTime = te;
  }
  var af = document.getElementById("maint-active-from").value;
  var au = document.getElementById("maint-active-until").value;
  if (af) out.activeFrom = af;
  if (au) out.activeUntil = au;
  return out;
}

function _maintRefreshPreview() {
  var el = document.getElementById("maint-preview");
  if (!el) return;
  var criteria = _maintCollectCriteria();
  if (!criteria && !_maintEditingAssetIds.length) {
    // Cancel any in-flight debounce before painting the placeholder — a
    // pending timer from the previous state (e.g. the operator just clicked
    // Remove on the explicit-includes line) would otherwise land ~400ms later
    // and overwrite this line with a stale device list.
    if (_maintPreviewTimer) { clearTimeout(_maintPreviewTimer); _maintPreviewTimer = null; }
    el.innerHTML = "Add a filter rule to preview matching devices.";
    return;
  }
  el.textContent = "Checking…";
  if (_maintPreviewTimer) clearTimeout(_maintPreviewTimer);
  _maintPreviewTimer = setTimeout(async function () {
    try {
      var res = await api.maintenanceSchedules.preview({ criteria: criteria, assetIds: _maintEditingAssetIds });
      if (!res.total) {
        el.innerHTML = '<em>No monitored assets match.</em>';
        return;
      }
      var rows = res.assets.map(function (a) {
        return "<tr><td>" + escapeHtml(a.hostname || "—") + "</td><td>" + escapeHtml(a.ipAddress || "—") +
          "</td><td>" + escapeHtml([a.manufacturer, a.model].filter(Boolean).join(" ") || "—") + "</td></tr>";
      }).join("");
      var more = res.total > res.assets.length
        ? '<div class="hint" style="font-style:italic">…and ' + (res.total - res.assets.length) + " more</div>"
        : "";
      el.innerHTML =
        "<div><strong>" + res.total + "</strong> monitored asset" + (res.total === 1 ? "" : "s") + " included</div>" +
        '<div style="max-height:180px;overflow-y:auto;margin-top:4px;border:1px solid var(--color-border);border-radius:4px">' +
          '<table class="data-table" style="margin:0"><thead><tr><th>Hostname</th><th>IP</th><th>Model</th></tr></thead>' +
          "<tbody>" + rows + "</tbody></table></div>" + more;
    } catch (err) {
      el.textContent = "Preview unavailable: " + (err && err.message ? err.message : "error");
    }
  }, 400);
}

function _maintSyncScheduleBlocks() {
  var oneshot = document.getElementById("maint-kind-oneshot").checked;
  document.getElementById("maint-oneshot-block").style.display = oneshot ? "flex" : "none";
  document.getElementById("maint-recurring-block").style.display = oneshot ? "none" : "";
  var freq = document.getElementById("maint-freq").value;
  document.getElementById("maint-weekly-block").style.display  = (!oneshot && freq === "days")    ? "" : "none";
  document.getElementById("maint-monthly-block").style.display = (!oneshot && freq === "monthly") ? "" : "none";
  document.getElementById("maint-yearly-block").style.display  = (!oneshot && freq === "yearly")  ? "" : "none";
  document.getElementById("maint-time-range").style.display =
    document.getElementById("maint-allday").checked ? "none" : "";
}

function _maintSyncExplicitLine() {
  var el = document.getElementById("maint-explicit");
  if (!el) return;
  if (!_maintEditingAssetIds.length) { el.style.display = "none"; return; }
  el.style.display = "";
  // Wording covers both sources of explicit pins: an edited schedule's stored
  // assetIds and a bulk-bar selection carried in by openMaintenanceModal.
  el.innerHTML = "Includes <strong>" + _maintEditingAssetIds.length + "</strong> explicitly selected device" +
    (_maintEditingAssetIds.length === 1 ? "" : "s") +
    ' (only monitored devices are eligible) ' +
    '<button type="button" class="btn btn-secondary btn-sm" id="maint-clear-explicit">Remove</button>';
  var btn = document.getElementById("maint-clear-explicit");
  if (btn) btn.addEventListener("click", function () {
    _maintEditingAssetIds = [];
    _maintSyncExplicitLine();
    _maintRefreshPreview();
  });
}

// Background fetches for the editor's datalists/selects. Deliberately NOT
// awaited by _maintWireEditor: these are cosmetic helpers, and blocking on
// them left the whole editor inert (dead Save button) until three sequential
// API calls returned — the "can't click Save Changes" bug.
async function _maintLoadEditorLookups() {
  if (!_maintAssetTypesCache) {
    try { _maintAssetTypesCache = await api.assetTypes.list(); } catch (e) { _maintAssetTypesCache = []; }
  }
  var dl = document.getElementById("maint-assettype-list");
  if (dl) {
    dl.innerHTML = (_maintAssetTypesCache || []).map(function (t) {
      return '<option value="' + escapeHtml(t.name) + '">' + escapeHtml(t.label || t.name) + "</option>";
    }).join("");
  }

  if (!_maintIntegrationsCache) {
    try {
      var ints = await api.integrations.list();
      _maintIntegrationsCache = (ints.integrations || ints || []).map(function (i) {
        return { id: i.id, name: i.name, type: i.type };
      });
    } catch (e) { _maintIntegrationsCache = []; }
  }
  // Re-render any Integration rule cells that rendered before the cache
  // landed (field switched early, or edit-load with an integration rule) —
  // preserving the current selection when there is one.
  document.querySelectorAll("#maint-rules .maint-rule").forEach(function (row) {
    var fieldSel = row.querySelector(".maint-rule-field");
    if (!fieldSel || fieldSel.value !== "integration") return;
    var cur = row.querySelector(".maint-rule-integration");
    var selected = cur && cur.value ? cur.value : (cur && cur.getAttribute("data-pending-value")) || "";
    row.querySelector(".maint-rule-cells").innerHTML = _maintRuleCellsHTML("integration", "exact", selected);
  });

  if (!_maintFortigateNamesCache) {
    try {
      var fw = await api.assets.list({ assetType: "firewall", limit: 500 });
      _maintFortigateNamesCache = (fw.assets || []).map(function (a) { return a.hostname; }).filter(Boolean).sort();
    } catch (e) { _maintFortigateNamesCache = []; }
  }
  var fgdl = document.getElementById("maint-fortigate-list");
  if (fgdl) {
    fgdl.innerHTML = (_maintFortigateNamesCache || []).map(function (n) {
      return '<option value="' + escapeHtml(n) + '"></option>';
    }).join("");
  }
}

function _maintWireEditor() {
  // Kick the lookup fetches WITHOUT awaiting — every listener below must be
  // live the moment the modal paints.
  _maintLoadEditorLookups().catch(function () { /* best-effort */ });

  // Sensible one-shot defaults: now → now + 2h, in the SERVER's wall clock.
  // maintServerNow falls back to the browser clock until the skew read lands;
  // _maintApplyServerClock re-prefills (and labels the zone) when it does.
  _maintOneshotTouched = false;
  var now = maintServerNow();
  document.getElementById("maint-start").value = _maintLocalIso(now);
  document.getElementById("maint-end").value = _maintLocalIso(new Date(now.getTime() + 2 * 60 * 60 * 1000));
  _maintApplyServerClock();
  _maintLoadServerClock().then(_maintApplyServerClock);

  // An operator-typed time is never overwritten by the async re-prefill.
  ["maint-start", "maint-end"].forEach(function (id) {
    document.getElementById(id).addEventListener("input", function () { _maintOneshotTouched = true; });
  });

  document.getElementById("maint-add-rule").addEventListener("click", function () {
    document.getElementById("maint-rules").insertAdjacentHTML("beforeend", _maintRuleRowHTML(null));
  });
  var rulesEl = document.getElementById("maint-rules");
  rulesEl.addEventListener("change", function (e) {
    var fieldSel = e.target.closest ? e.target.closest(".maint-rule-field") : null;
    if (fieldSel) {
      var row = fieldSel.closest(".maint-rule");
      row.querySelector(".maint-rule-cells").innerHTML = _maintRuleCellsHTML(fieldSel.value, "contains", "");
    }
    _maintRefreshPreview();
  });
  rulesEl.addEventListener("input", function () { _maintRefreshPreview(); });
  rulesEl.addEventListener("click", function (e) {
    var rm = e.target.closest ? e.target.closest(".maint-rule-remove") : null;
    if (rm) {
      var row = rm.closest(".maint-rule");
      if (row) row.remove();
      _maintRefreshPreview();
    }
  });

  ["maint-kind-oneshot", "maint-kind-recurring", "maint-freq", "maint-allday"].forEach(function (id) {
    document.getElementById(id).addEventListener("change", _maintSyncScheduleBlocks);
  });
  _maintSyncScheduleBlocks();

  document.getElementById("maint-save").addEventListener("click", _maintSave);
  document.getElementById("maint-cancel-edit").addEventListener("click", function () {
    _maintResetEditor();
  });
}

function _maintResetEditor() {
  _maintEditingId = null;
  _maintEditingAssetIds = [];
  document.getElementById("maint-name").value = "";
  document.getElementById("maint-rules").innerHTML = _maintRuleRowHTML(null);
  document.getElementById("maint-enabled").checked = true;
  document.getElementById("maint-suppress-children").checked = true;
  document.getElementById("maint-kind-oneshot").checked = true;
  document.getElementById("maint-freq").value = "days";
  document.querySelectorAll(".maint-dow").forEach(function (cb) { cb.checked = true; });
  _maintOneshotTouched = false;
  var now = maintServerNow();
  document.getElementById("maint-start").value = _maintLocalIso(now);
  document.getElementById("maint-end").value = _maintLocalIso(new Date(now.getTime() + 2 * 60 * 60 * 1000));
  _maintApplyServerClock();
  document.getElementById("maint-edit-banner").style.display = "none";
  document.getElementById("maint-save").textContent = "Create Schedule";
  document.getElementById("maint-cancel-edit").style.display = "none";
  _maintSyncScheduleBlocks();
  _maintSyncExplicitLine();
  _maintRefreshPreview();
}

/** Load a schedule row into the editor and switch to the Create tab. */
function _maintLoadIntoEditor(row) {
  _maintEditingId = row.id;
  _maintEditingAssetIds = Array.isArray(row.assetIds) ? row.assetIds.slice() : [];
  document.getElementById("maint-name").value = row.name || "";
  document.getElementById("maint-enabled").checked = row.enabled !== false;
  document.getElementById("maint-suppress-children").checked = row.suppressChildren !== false;

  var criteria = row.criteria;
  var rulesEl = document.getElementById("maint-rules");
  rulesEl.innerHTML = criteria && criteria.rules && criteria.rules.length
    ? criteria.rules.map(function (r) { return _maintRuleRowHTML(r); }).join("")
    : _maintRuleRowHTML(null);

  var s = row.schedule || {};
  var oneshot = s.kind === "oneshot";
  document.getElementById("maint-kind-oneshot").checked = oneshot;
  document.getElementById("maint-kind-recurring").checked = !oneshot;
  if (oneshot) {
    // Stored times are already server-local wall clock — load verbatim.
    _maintOneshotTouched = true;
    document.getElementById("maint-start").value = String(s.startAt || "").slice(0, 16);
    document.getElementById("maint-end").value = String(s.endAt || "").slice(0, 16);
  } else {
    // Stored daily/weekly both load as the "specific days" UI mode: daily =
    // all boxes checked, weekly = its daysOfWeek subset.
    var storedFreq = s.freq || "daily";
    var daysMode = storedFreq === "daily" || storedFreq === "weekly";
    document.getElementById("maint-freq").value = daysMode ? "days" : storedFreq;
    document.querySelectorAll(".maint-dow").forEach(function (cb) {
      cb.checked = storedFreq === "weekly"
        ? Array.isArray(s.daysOfWeek) && s.daysOfWeek.indexOf(Number(cb.value)) !== -1
        : true;
    });
    if (s.dayOfMonth) document.getElementById("maint-daymonth").value = s.dayOfMonth;
    if (s.month) document.getElementById("maint-month").value = s.month;
    if (s.day) document.getElementById("maint-day").value = s.day;
    var allDay = !s.startTime;
    document.getElementById("maint-allday").checked = allDay;
    if (!allDay) {
      document.getElementById("maint-time-start").value = s.startTime;
      document.getElementById("maint-time-end").value = s.endTime;
    }
    document.getElementById("maint-active-from").value = s.activeFrom || "";
    document.getElementById("maint-active-until").value = s.activeUntil || "";
  }

  var banner = document.getElementById("maint-edit-banner");
  banner.textContent = "Editing schedule: " + (row.name || row.id);
  banner.style.display = "";
  document.getElementById("maint-save").textContent = "Save Changes";
  document.getElementById("maint-cancel-edit").style.display = "";
  _maintSyncScheduleBlocks();
  _maintSyncExplicitLine();
  _maintRefreshPreview();

  var createTab = document.querySelector('#maint-tabs .page-tab[data-tab="create"]');
  if (createTab) createTab.click();
}

async function _maintSave() {
  var btn = document.getElementById("maint-save");
  btn.disabled = true;
  try {
    var name = document.getElementById("maint-name").value.trim();
    if (!name) throw new Error("Schedule name is required");
    var criteria = _maintCollectCriteria();
    if (!criteria && !_maintEditingAssetIds.length) throw new Error("Add at least one filter rule");
    var body = {
      name: name,
      enabled: document.getElementById("maint-enabled").checked,
      criteria: criteria,
      assetIds: _maintEditingAssetIds,
      schedule: _maintCollectSchedule(),
      suppressChildren: document.getElementById("maint-suppress-children").checked,
    };
    if (_maintEditingId) {
      await api.maintenanceSchedules.update(_maintEditingId, body);
      showToast("Maintenance schedule updated");
    } else {
      await api.maintenanceSchedules.create(body);
      showToast("Maintenance schedule created");
    }
    _maintResetEditor();
    await _maintReloadList();
    // Statuses may have flipped immediately (inline reconcile) — refresh the table.
    if (typeof loadAssets === "function") loadAssets();
    var listTab = document.querySelector('#maint-tabs .page-tab[data-tab="list"]');
    if (listTab) listTab.click();
  } catch (err) {
    showToast(err && err.message ? err.message : "Failed to save schedule", "error");
  } finally {
    btn.disabled = false;
  }
}

// ─── Tab 2 — schedules list ─────────────────────────────────────────────────

function _maintTargetsSummary(row) {
  var parts = [];
  var ruleCount = row.criteria && row.criteria.rules ? row.criteria.rules.length : 0;
  if (ruleCount) parts.push(ruleCount + " filter rule" + (ruleCount === 1 ? "" : "s"));
  var explicit = Array.isArray(row.assetIds) ? row.assetIds.length : 0;
  if (explicit) parts.push(explicit + " explicit asset" + (explicit === 1 ? "" : "s"));
  return parts.join(" + ") || "—";
}

/** Repaint the calendar grid after a write, but only if it's been opened. */
function _maintCalRefresh() {
  if (_maintCalRendered) _maintRenderCalendar();
}

async function _maintReloadList() {
  var el = document.getElementById("maint-list-body");
  if (!el) return;
  _maintCalRefresh();
  try {
    var res = await api.maintenanceSchedules.list();
    _maintSchedules = res.schedules || [];
  } catch (err) {
    el.innerHTML = '<div class="empty-state">' + escapeHtml(err.message || "Failed to load schedules") + "</div>";
    return;
  }
  if (!_maintSchedules.length) {
    el.innerHTML = '<div class="empty-state">No maintenance schedules yet. Create one on the Create Schedule tab.</div>';
    return;
  }
  var rows = _maintSchedules.map(function (s) {
    return "<tr>" +
      "<td><a href=\"#\" class=\"maint-edit-link\" data-id=\"" + s.id + "\">" + escapeHtml(s.name) + "</a></td>" +
      "<td>" + escapeHtml(maintScheduleSummary(s.schedule)) + "</td>" +
      '<td style="white-space:nowrap">' + escapeHtml(_maintTargetsSummary(s)) + "</td>" +
      '<td style="white-space:nowrap">' + (s.suppressChildren !== false ? "Marked down" : "Unaffected") + "</td>" +
      '<td style="white-space:nowrap"><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">' +
        '<input type="checkbox" class="maint-enable-toggle" data-id="' + s.id + '"' + (s.enabled ? " checked" : "") + ' style="width:auto">' +
        (s.enabled ? "Enabled" : "Disabled") + "</label></td>" +
      '<td style="white-space:nowrap">' +
        '<button type="button" class="btn btn-secondary btn-sm maint-edit-btn" data-id="' + s.id + '">Edit</button> ' +
        '<button type="button" class="btn btn-danger btn-sm maint-delete-btn" data-id="' + s.id + '">Delete</button>' +
      "</td></tr>";
  }).join("");
  el.innerHTML =
    '<table class="data-table"><thead><tr style="white-space:nowrap">' +
    '<th>Name</th><th>Schedule</th><th>Targets</th><th title="Whether devices behind an in-maintenance asset are dependency-suppressed for the window">Dependents</th><th>State</th><th></th>' +
    "</tr></thead><tbody>" + rows + "</tbody></table>" +
    '<p class="hint" style="margin-top:8px">Disabling or deleting a schedule ends its active maintenance windows immediately and restores asset statuses.</p>';

  el.querySelectorAll(".maint-edit-btn, .maint-edit-link").forEach(function (b) {
    b.addEventListener("click", function (e) {
      e.preventDefault();
      var row = _maintSchedules.find(function (s) { return s.id === b.getAttribute("data-id"); });
      if (row) _maintLoadIntoEditor(row);
    });
  });
  el.querySelectorAll(".maint-enable-toggle").forEach(function (cb) {
    cb.addEventListener("change", async function () {
      var row = _maintSchedules.find(function (s) { return s.id === cb.getAttribute("data-id"); });
      if (!row) return;
      try {
        await api.maintenanceSchedules.update(row.id, {
          name: row.name,
          enabled: cb.checked,
          criteria: row.criteria || null,
          assetIds: row.assetIds || [],
          schedule: row.schedule,
          // Pass through — normalizeInput defaults a missing value to true,
          // which would silently flip an opted-out schedule.
          suppressChildren: row.suppressChildren !== false,
        });
        showToast(cb.checked ? "Schedule enabled" : "Schedule disabled");
        await _maintReloadList();
        if (typeof loadAssets === "function") loadAssets();
      } catch (err) {
        showToast(err.message || "Failed to update schedule", "error");
        cb.checked = !cb.checked;
      }
    });
  });
  el.querySelectorAll(".maint-delete-btn").forEach(function (b) {
    b.addEventListener("click", async function () {
      var row = _maintSchedules.find(function (s) { return s.id === b.getAttribute("data-id"); });
      if (!row) return;
      var ok = await showConfirm('Delete maintenance schedule "' + row.name + '"? Active windows end immediately and asset statuses are restored.');
      if (!ok) return;
      try {
        await api.maintenanceSchedules.delete(row.id);
        showToast("Schedule deleted");
        await _maintReloadList();
        if (typeof loadAssets === "function") loadAssets();
      } catch (err) {
        showToast(err.message || "Failed to delete schedule", "error");
      }
    });
  });
}

// ─── Tab 3 — calendar ───────────────────────────────────────────────────────
//
// A month grid of every schedule's occurrences. Occurrences are expanded
// SERVER-side (GET /maintenance-schedules/occurrences) and come back as
// server-local wall-clock strings — the recurrence engine runs on the Polaris
// server's clock, so re-deriving them here would draw windows on the wrong
// day for any operator in another timezone. Nothing below parses them as
// instants: day bucketing is string arithmetic on "YYYY-MM-DD".

var _MAINT_DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Visible month, as {y, m} with m 0-based. Null before the modal opens. */
var _maintCalMonth = null;
/** Has the grid been painted at least once? Gates the post-write refresh. */
var _maintCalRendered = false;
/** Day keys the operator expanded past the 3-chip fold. */
var _maintCalExpanded = {};

function _maintDayKey(d) {
  return d.getFullYear() + "-" + _maintPad(d.getMonth() + 1) + "-" + _maintPad(d.getDate());
}

/** "YYYY-MM-DD" ± n days, as "YYYY-MM-DD". */
function _maintShiftDay(dayKey, delta) {
  var p = dayKey.split("-").map(Number);
  return _maintDayKey(new Date(p[0], p[1] - 1, p[2] + delta));
}

/**
 * The day keys an occurrence paints on. Windows are half-open, so one ending
 * exactly at midnight (an all-day window, or 22:00 → 00:00) does NOT claim the
 * following day.
 */
function _maintOccurrenceDays(occ) {
  var startDay = String(occ.start).slice(0, 10);
  var endDay = String(occ.end).slice(0, 10);
  if (String(occ.end).slice(11, 16) === "00:00" && endDay > startDay) endDay = _maintShiftDay(endDay, -1);
  var out = [];
  var cur = startDay;
  for (var i = 0; i < 400; i++) {
    out.push(cur);
    if (cur >= endDay) break;
    cur = _maintShiftDay(cur, 1);
  }
  return out;
}

/** Chip label for `occ` as seen on day `dayKey`. */
function _maintChipTime(occ, dayKey) {
  var startDay = String(occ.start).slice(0, 10);
  var startTime = String(occ.start).slice(11, 16);
  var endTime = String(occ.end).slice(11, 16);
  var endDay = String(occ.end).slice(0, 10);
  if (startTime === "00:00" && endTime === "00:00" && endDay > startDay) return "All day";
  if (dayKey !== startDay) return "→ " + endTime;      // continues from a previous day
  if (endDay !== startDay) return startTime + " →";     // runs past midnight
  return startTime + "–" + endTime;
}

function _maintCalendarHTML() {
  return (
    '<div class="maint-cal">' +
      '<div class="maint-cal-bar">' +
        '<button type="button" class="btn btn-secondary btn-sm" id="maint-cal-prev" aria-label="Previous month">&lsaquo;</button>' +
        '<strong id="maint-cal-title" class="maint-cal-title">…</strong>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="maint-cal-next" aria-label="Next month">&rsaquo;</button>' +
        '<button type="button" class="btn btn-secondary btn-sm" id="maint-cal-today">Today</button>' +
        '<span class="hint maint-cal-hint">Server local time — click a day to schedule a window, or a window to edit it.</span>' +
      '</div>' +
      '<div class="maint-cal-dow">' +
        _MAINT_DOW.map(function (d) { return "<div>" + d + "</div>"; }).join("") +
      '</div>' +
      '<div id="maint-cal-grid" class="maint-cal-grid"><div class="empty-state" style="grid-column:1/-1">Loading…</div></div>' +
      '<div id="maint-cal-note" class="hint" style="margin-top:6px"></div>' +
    '</div>'
  );
}

function _maintWireCalendar() {
  var today = new Date();
  _maintCalMonth = { y: today.getFullYear(), m: today.getMonth() };
  _maintCalExpanded = {};
  _maintCalRendered = false;

  document.getElementById("maint-cal-prev").addEventListener("click", function () {
    _maintCalShift(-1);
  });
  document.getElementById("maint-cal-next").addEventListener("click", function () {
    _maintCalShift(1);
  });
  document.getElementById("maint-cal-today").addEventListener("click", function () {
    var now = new Date();
    _maintCalMonth = { y: now.getFullYear(), m: now.getMonth() };
    _maintRenderCalendar();
  });

  // Lazily render on first activation and refresh on every later one, so the
  // grid reflects schedules created/edited on the other two tabs.
  var tabBtn = document.querySelector('#maint-tabs .page-tab[data-tab="calendar"]');
  if (tabBtn) tabBtn.addEventListener("click", function () { _maintRenderCalendar(); });

  var grid = document.getElementById("maint-cal-grid");
  grid.addEventListener("click", function (e) {
    var more = e.target.closest ? e.target.closest(".maint-cal-more") : null;
    if (more) {
      _maintCalExpanded[more.getAttribute("data-day")] = true;
      _maintRenderCalendar();
      return;
    }
    var chip = e.target.closest ? e.target.closest(".maint-cal-chip") : null;
    if (chip) {
      _maintCalOpenSchedule(chip.getAttribute("data-schedule-id"));
      return;
    }
    var cell = e.target.closest ? e.target.closest(".maint-cal-day") : null;
    if (cell) _maintCalNewOnDay(cell.getAttribute("data-day"));
  });
}

function _maintCalShift(delta) {
  var d = new Date(_maintCalMonth.y, _maintCalMonth.m + delta, 1);
  _maintCalMonth = { y: d.getFullYear(), m: d.getMonth() };
  _maintCalExpanded = {};
  _maintRenderCalendar();
}

/** Open the schedule behind a calendar chip in the editor tab. */
async function _maintCalOpenSchedule(scheduleId) {
  var row = _maintSchedules.find(function (s) { return s.id === scheduleId; });
  if (!row) {
    // The list tab may not have loaded (or the schedule postdates its load).
    try {
      var res = await api.maintenanceSchedules.list();
      _maintSchedules = res.schedules || [];
      row = _maintSchedules.find(function (s) { return s.id === scheduleId; });
    } catch (err) { /* fall through to the toast below */ }
  }
  if (!row) { showToast("That schedule no longer exists", "error"); return; }
  _maintLoadIntoEditor(row);
}

/**
 * Click on an empty day → a new one-time window on that date, prefilled and
 * handed to the editor (which still requires a name + at least one target, so
 * nothing is created behind the operator's back). Today starts now; any other
 * day starts at 20:00, the same evening-window default the recurring editor
 * uses.
 */
function _maintCalNewOnDay(dayKey) {
  _maintResetEditor();
  // The grid's day keys are server-local (occurrences are expanded server-side),
  // so "is this cell today?" is a question about the SERVER's date.
  var now = maintServerNow();
  var p = dayKey.split("-").map(Number);
  var start = _maintDayKey(now) === dayKey
    ? now
    : new Date(p[0], p[1] - 1, p[2], 20, 0, 0, 0);
  // An operator-picked day is a deliberate time — never re-prefilled.
  _maintOneshotTouched = true;
  document.getElementById("maint-kind-oneshot").checked = true;
  document.getElementById("maint-kind-recurring").checked = false;
  document.getElementById("maint-start").value = _maintLocalIso(start);
  document.getElementById("maint-end").value = _maintLocalIso(new Date(start.getTime() + 2 * 60 * 60 * 1000));
  _maintSyncScheduleBlocks();
  var createTab = document.querySelector('#maint-tabs .page-tab[data-tab="create"]');
  if (createTab) createTab.click();
  var nameEl = document.getElementById("maint-name");
  if (nameEl) nameEl.focus();
}

async function _maintRenderCalendar() {
  var grid = document.getElementById("maint-cal-grid");
  var titleEl = document.getElementById("maint-cal-title");
  var noteEl = document.getElementById("maint-cal-note");
  if (!grid || !_maintCalMonth) return;

  var first = new Date(_maintCalMonth.y, _maintCalMonth.m, 1);
  titleEl.textContent = _MAINT_MONTHS[_maintCalMonth.m] + " " + _maintCalMonth.y;
  // Grid always starts on the Sunday on/before the 1st and runs whole weeks.
  var gridStart = new Date(_maintCalMonth.y, _maintCalMonth.m, 1 - first.getDay());
  var daysInMonth = new Date(_maintCalMonth.y, _maintCalMonth.m + 1, 0).getDate();
  var cells = Math.ceil((first.getDay() + daysInMonth) / 7) * 7;
  var gridEnd = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + cells - 1);

  _maintCalRendered = true;
  var byDay = {};
  try {
    var res = await api.maintenanceSchedules.occurrences(_maintDayKey(gridStart), _maintDayKey(gridEnd));
    (res.occurrences || []).forEach(function (occ) {
      _maintOccurrenceDays(occ).forEach(function (day) {
        (byDay[day] = byDay[day] || []).push(occ);
      });
    });
    noteEl.textContent = res.truncated
      ? "Too many windows to show them all this month — some are omitted."
      : "";
  } catch (err) {
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1">' +
      escapeHtml(err && err.message ? err.message : "Failed to load the calendar") + "</div>";
    return;
  }

  var todayKey = _maintDayKey(new Date());
  var html = "";
  for (var i = 0; i < cells; i++) {
    var d = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
    var key = _maintDayKey(d);
    var outside = d.getMonth() !== _maintCalMonth.m;
    var occs = (byDay[key] || []).slice().sort(function (a, b) {
      return a.start < b.start ? -1 : a.start > b.start ? 1 : a.name.localeCompare(b.name);
    });
    var expanded = !!_maintCalExpanded[key];
    var shown = expanded ? occs : occs.slice(0, 3);
    var chips = shown.map(function (occ) {
      var cls = "maint-cal-chip" + (occ.enabled ? "" : " maint-cal-chip-off") + (occ.adhoc ? " maint-cal-chip-adhoc" : "");
      var tip = occ.name + "\n" + _maintFmtLocal(occ.start) + " → " + _maintFmtLocal(occ.end) +
        (occ.enabled ? "" : "\n(disabled)");
      return '<button type="button" class="' + cls + '" data-schedule-id="' + escapeHtml(occ.scheduleId) + '" title="' + escapeHtml(tip) + '">' +
        '<span class="maint-cal-chip-time">' + escapeHtml(_maintChipTime(occ, key)) + "</span> " +
        escapeHtml(occ.name) +
        "</button>";
    }).join("");
    if (!expanded && occs.length > shown.length) {
      chips += '<button type="button" class="maint-cal-more" data-day="' + key + '">+' +
        (occs.length - shown.length) + " more</button>";
    }
    html += '<div class="maint-cal-day' + (outside ? " maint-cal-day-out" : "") +
      (key === todayKey ? " maint-cal-day-today" : "") + '" data-day="' + key + '" title="Click to schedule a window on ' + escapeHtml(_maintFmtDate(key)) + '">' +
      '<div class="maint-cal-daynum">' + d.getDate() + "</div>" +
      '<div class="maint-cal-chips">' + chips + "</div>" +
      "</div>";
  }
  grid.innerHTML = html;
}

// ─── Ad-hoc entry (status pill / edit modal) ────────────────────────────────

/**
 * Validate an ad-hoc "enter maintenance until" value from a datetime-local
 * field. Returns {ok, value} or {ok:false, error}.
 *
 * A datetime-local whose time half is untouched reads as "" — the operator
 * sees a filled-in date and Polaris sees nothing. Both ad-hoc entry points
 * (status pill, edit modal) run through this so that case, and an end time
 * already in the past, are refused with a reason instead of silently dropped.
 *
 * "In the past" is judged against the SERVER's clock, because that is what the
 * value is read as: on a UTC-clocked host a Central operator's "+2h" end time
 * is already hours behind the server, and the window it produces closes on the
 * very next reconcile. Callers may pass nowMs to pin it.
 */
function maintValidateAdhocEnd(value, nowMs) {
  var raw = String(value == null ? "" : value).trim();
  if (!raw) return { ok: false, error: "Pick the date AND time maintenance should end." };
  var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(raw);
  if (!m) return { ok: false, error: "Enter a full end date and time." };
  var when = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
  if (isNaN(when.getTime())) return { ok: false, error: "Enter a full end date and time." };
  if (when.getTime() <= (nowMs == null ? maintServerNow().getTime() : nowMs)) {
    return { ok: false, error: "The end time must be in the future." };
  }
  return { ok: true, value: raw.slice(0, 16) };
}

/**
 * Create a one-shot single-asset maintenance schedule starting now. The
 * server reconciles inline, so the asset is already in maintenance when the
 * promise resolves. endLocalIso is a datetime-local value ("YYYY-MM-DDTHH:MM").
 * opts.suppressChildren (default true) — whether dependents behind the asset
 * are dependency-suppressed for the window.
 */
async function maintCreateAdhoc(assetId, hostname, endLocalIso, opts) {
  return api.maintenanceSchedules.create({
    name: "Ad-hoc — " + (hostname || assetId),
    assetIds: [assetId],
    schedule: {
      version: 1,
      kind: "oneshot",
      // startNow: the SERVER stamps the start with its own wall clock. A
      // browser-stamped startAt lands in the server's future whenever the
      // operator's clock runs fast or sits in a TZ ahead of the server —
      // the "didn't immediately enter maintenance" bug.
      startNow: true,
      endAt: endLocalIso,
    },
    suppressChildren: !(opts && opts.suppressChildren === false),
  });
}

window.openMaintenanceModal = openMaintenanceModal;
window.maintCreateAdhoc = maintCreateAdhoc;
window.maintScheduleSummary = maintScheduleSummary;
window.maintLocalIso = _maintLocalIso;
window.maintValidateAdhocEnd = maintValidateAdhocEnd;
// Server-clock helpers: the ad-hoc surfaces in assets.js prefill and label
// their "until" pickers in server time through these.
window.maintServerNow = maintServerNow;
window.maintLoadServerClock = _maintLoadServerClock;
window.maintServerClockLabel = maintServerClockLabel;
// Calendar internals, exported for unit tests (day bucketing is the part with
// real edge cases: midnight-spanning and all-day windows).
window._maintOccurrenceDays = _maintOccurrenceDays;
window._maintChipTime = _maintChipTime;
