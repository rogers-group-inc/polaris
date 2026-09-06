/**
 * public/js/api.js — Thin fetch wrapper for /api/v1
 */

// The Dash wallboard page (dash.html) sets window.__polarisApiBase (via
// dash-mode.js, loaded before this file) so every request routes to its own
// IP-gated listener at /dash/api/v1 instead of the authenticated API.
const API_BASE = (typeof window !== "undefined" && window.__polarisApiBase) || "/api/v1";

// ─── Shared HTML escaper ────────────────────────────────────────────────────
//
// Canonical escapeHtml for the whole front-end. api.js loads first on every
// page (index/assets/blocks/subnets/events/integrations/ipam/map/users/
// server-settings + mobile.html), so this global is available to app.js,
// map.js, and every mobile module — each of which previously carried its own
// near-identical copy (with two different apostrophe encodings). Escapes the
// full set & < > " ' so it's safe in both text and attribute contexts.
// setup.html does NOT load api.js (wizard runs standalone), so setup.js keeps
// its own self-contained copy.
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
if (typeof window !== "undefined") window.escapeHtml = escapeHtml;

// Shared YYYY-MM-DD formatter for the mobile SPA (asset sheet "Acquired",
// reservations "Expires" + edit-form value). Local-time — a date the operator
// set should render as the day they meant regardless of the browser TZ; a
// date-only value parses to local midnight and round-trips unchanged. Empty /
// unparseable → "". The desktop `formatDate` in app.js is a different,
// locale-pretty format ("Jul 4, 2026") and stays separate.
function mobileFormatDate(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  var pad = function (n) { return n < 10 ? "0" + n : "" + n; };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}
if (typeof window !== "undefined") window.mobileFormatDate = mobileFormatDate;

// ─── Shared display + delivery helpers ──────────────────────────────────────
// Canonical copies (2026-08 audit): every page loads api.js FIRST — including
// dash.html (which boots dash-boot.js instead of app.js) and mobile.html — so
// these live here rather than app.js. The dash-boot forks and the per-page
// copies (agent-build, assets, server-settings, both mobile tabs) are gone.

// ─── Display timezone ───────────────────────────────────────────────────────
// The account's chosen IANA zone, or "auto" (the default) meaning "let the
// browser use its own" — which is what every formatter here did before the
// preference existed, so an untouched account renders identically.
//
// Cached in localStorage and read SYNCHRONOUSLY at load, because api.js is the
// first script on every page and the first table can paint before /auth/me
// comes back. Without the cache a returning operator would see one frame of
// browser-zone times and then a jump. app.js calls setDisplayTimeZone() from
// the /auth/me response, which corrects the cache for the next load if the
// account's choice changed on another device.
//
// Per-browser storage of a per-ACCOUNT setting is deliberate and safe in one
// direction only: it is a render hint that the server's answer always
// overwrites, never the source of truth. The server re-renders its own emails
// from User.timezone and never consults this.
var POLARIS_TZ_KEY = "polaris-timezone";
var _displayTimeZone = "auto";
try {
  _displayTimeZone = localStorage.getItem(POLARIS_TZ_KEY) || "auto";
} catch (_) {
  // Private mode / blocked site data — "auto" is the correct fallback.
}

/** The stored preference verbatim: "auto" or an IANA zone name. */
function displayTimeZone() { return _displayTimeZone; }
if (typeof window !== "undefined") window.displayTimeZone = displayTimeZone;

/**
 * Adopt the account's zone (from /auth/me) and remember it for the next boot.
 * Idempotent; a falsy value resets to "auto" rather than leaving a stale zone
 * on a browser someone else has since signed into.
 */
function setDisplayTimeZone(tz) {
  _displayTimeZone = tz || "auto";
  try { localStorage.setItem(POLARIS_TZ_KEY, _displayTimeZone); } catch (_) {}
}
if (typeof window !== "undefined") window.setDisplayTimeZone = setDisplayTimeZone;

/**
 * The `timeZone` option to spread into a toLocale* call — EMPTY on "auto", so
 * the platform keeps using the browser's own zone rather than us resolving one
 * for it. Spreading nothing is not the same as passing the browser's zone
 * explicitly: it is what the call did before, byte for byte.
 *
 * Every absolute-time formatter in the app should spread this. A formatter
 * that doesn't renders in the browser's zone regardless of the preference,
 * which is only correct while the two agree.
 */
function timeZoneOpts() {
  return _displayTimeZone && _displayTimeZone !== "auto" ? { timeZone: _displayTimeZone } : {};
}
if (typeof window !== "undefined") window.timeZoneOpts = timeZoneOpts;

// Compact relative time ("5s ago" / "5m ago" / "3h ago" / "2d ago").
function timeAgo(dateStr) {
  var diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return diff + "s ago";
  if (diff < 3600) return Math.floor(diff / 60) + "m ago";
  if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
  return Math.floor(diff / 86400) + "d ago";
}
if (typeof window !== "undefined") window.timeAgo = timeAgo;

// Absolute datetime formatters — BROWSER locale (operator decision 2026-08:
// no hardcoded en-US; the same event should render the same way everywhere,
// in the viewer's own conventions). formatDateTime carries the year + seconds
// (detail panes, exports); formatShortDateTime drops the year (dense tables
// of recent rows). Accepts Date | ISO string | epoch ms; "" on falsy/invalid.
function formatDateTime(value) {
  if (!value) return "";
  var d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  var tz = timeZoneOpts();
  try {
    return d.toLocaleDateString(undefined, Object.assign({ month: "short", day: "numeric", year: "numeric" }, tz)) +
      " " + d.toLocaleTimeString(undefined, Object.assign({ hour: "2-digit", minute: "2-digit", second: "2-digit" }, tz));
  } catch (_) {
    // A stored zone this browser's ICU can't apply — render in the browser's
    // own rather than showing nothing.
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
}
if (typeof window !== "undefined") window.formatDateTime = formatDateTime;

function formatShortDateTime(value) {
  if (!value) return "";
  var d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "";
  var tz = timeZoneOpts();
  try {
    return d.toLocaleDateString(undefined, Object.assign({ month: "short", day: "numeric" }, tz)) +
      " " + d.toLocaleTimeString(undefined, Object.assign({ hour: "2-digit", minute: "2-digit", second: "2-digit" }, tz));
  } catch (_) {
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
}
if (typeof window !== "undefined") window.formatShortDateTime = formatShortDateTime;

// Base-1024 byte formatter, decimal-KB labels (the convention the majority of
// the previous four divergent copies used). One decimal above bytes.
function formatBytes(n) {
  if (n == null || isNaN(n)) return "";
  if (n < 1024) return n + " B";
  var units = ["KB", "MB", "GB", "TB", "PB"];
  var v = n;
  for (var i = 0; i < units.length; i++) {
    v = v / 1024;
    if (v < 1024 || i === units.length - 1) return v.toFixed(1) + " " + units[i];
  }
}
if (typeof window !== "undefined") window.formatBytes = formatBytes;

function getToastContainer() {
  var c = document.getElementById("toast-container");
  if (!c) {
    c = document.createElement("div");
    c.id = "toast-container";
    c.className = "toast-container";
    document.body.appendChild(c);
  }
  return c;
}

function showToast(message, type) {
  type = type || "success";
  var container = getToastContainer();
  var el = document.createElement("div");
  el.className = "toast toast-" + type;

  var text = document.createElement("span");
  text.textContent = message;

  var btn = document.createElement("button");
  btn.className = "toast-copy-btn";
  btn.title = "Copy";
  btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  btn.addEventListener("click", function () {
    navigator.clipboard.writeText(message).then(function () {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      setTimeout(function () {
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
      }, 1500);
    });
  });

  el.appendChild(text);
  el.appendChild(btn);
  container.appendChild(el);
  setTimeout(function () {
    el.style.opacity = "0";
    el.style.transition = "opacity 0.3s";
    setTimeout(function () { el.remove(); }, 300);
  }, 3500);
}
if (typeof window !== "undefined") {
  window.getToastContainer = getToastContainer;
  window.showToast = showToast;
}

function downloadCsv(headers, rows, filename) {
  var csvContent = _csvRow(headers) + "\n" +
    rows.map(function (r) { return _csvRow(r); }).join("\n");
  var blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Download an object as a pretty-printed .json file. Same Blob + a.download
 *  shape as downloadCsv above; two spaces because the file is meant to be read
 *  and hand-edited (an automation export, a config dump). */
function downloadJson(obj, filename) {
  var blob = new Blob([JSON.stringify(obj, null, 2) + "\n"], { type: "application/json;charset=utf-8;" });
  var url = URL.createObjectURL(blob);
  var a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function _csvRow(cells) {
  return cells.map(function (c) {
    var s = String(c == null ? "" : c);
    if (s.indexOf(",") !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }).join(",");
}
if (typeof window !== "undefined") {
  window.downloadCsv = downloadCsv;
  window.downloadJson = downloadJson;
  window._csvRow = _csvRow;
}

// ─── Active Query Tracker ───────────────────────────────────────────────────

var activeQueries = [];
var _onQueriesChanged = null;

function _registerQuery(label, controller) {
  var entry = { id: Date.now() + Math.random(), label: label, controller: controller };
  activeQueries.push(entry);
  if (_onQueriesChanged) _onQueriesChanged();
  return entry.id;
}

function _unregisterQuery(id) {
  activeQueries = activeQueries.filter(function (q) { return q.id !== id; });
  if (_onQueriesChanged) _onQueriesChanged();
}

function abortAllQueries() {
  activeQueries.forEach(function (q) { q.controller.abort(); });
  activeQueries = [];
  if (_onQueriesChanged) _onQueriesChanged();
}

// Read a cookie by name. Used to pull the CSRF token the server sets
// via the synchronizer-token middleware.
function _readCookie(name) {
  var m = document.cookie.match(new RegExp("(?:^|; )" + name.replace(/[.$?*|{}()[\]\\\/+^]/g, "\\$&") + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

// Build a headers object prefilled with the CSRF token. Use for direct
// fetch() calls that bypass the shared `request()` helper (file uploads,
// blob downloads, etc).
function _csrfHeaders(extra) {
  var headers = extra ? Object.assign({}, extra) : {};
  var csrf = _readCookie("polaris_csrf");
  if (csrf) headers["X-CSRF-Token"] = csrf;
  return headers;
}

// One-shot guard so the stale-Secure-cookie alert only fires once per page
// load — otherwise a page that fires off several mutations on init would
// stack alerts on top of each other.
var _staleCookieAlertShown = false;

async function request(method, path, body, signal) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  if (signal) opts.signal = signal;

  // Attach CSRF token on state-changing methods. GETs are exempt.
  var upper = method.toUpperCase();
  if (upper !== "GET" && upper !== "HEAD" && upper !== "OPTIONS") {
    var csrf = _readCookie("polaris_csrf");
    if (csrf) {
      opts.headers["X-CSRF-Token"] = csrf;
    } else if (window.location.protocol === "http:" && !_staleCookieAlertShown) {
      // No CSRF cookie readable AND we're on HTTP — almost certainly a
      // stale Secure-flagged cookie from a prior HTTPS install of Polaris
      // on this origin. The browser holds it but won't send it over HTTP
      // and won't let the server overwrite it. Tell the user what to do
      // before letting the server return its 403.
      _staleCookieAlertShown = true;
      window.alert(
        "Polaris can't read its CSRF cookie. Your browser likely has a stale cookie from a previous HTTPS install on this address.\n\n" +
        "Click the padlock/info icon in the address bar → Clear cookies and site data → reload this page.",
      );
    }
  }

  const res = await fetch(API_BASE + path, opts);

  if (res.status === 204) return null;
  if (res.status === 401) {
    if (typeof window.__polarisOn401 === "function") return window.__polarisOn401();
    window.location.href = "/login.html"; return;
  }

  return _readResponseBody(res);
}

// Turn a proxy-generated error page into a sentence that names the failure.
//
// Every error the Express app itself produces is JSON (errorHandler.ts), so an
// HTML body means the response never came from Polaris — nginx or the load
// balancer in front of it answered instead, and those emit
// `<html><head><title>502 Bad Gateway</title>…`. Their <title> is the single
// most useful string in the page, so lift it verbatim and add the operator-
// facing "so what" for the statuses that actually reach this path.
function _proxyErrorMessage(status, text) {
  var m = /<title>([^<]{1,120})<\/title>/i.exec(text || "");
  var detail = m ? m[1].trim() : "HTTP " + status;
  var hint = "";
  if (status === 413) {
    hint = " — the reverse proxy rejected the request body as too large.";
  } else if (status === 502 || status === 503) {
    hint = " — Polaris isn't answering behind the reverse proxy (restarting?).";
  } else if (status === 504) {
    hint = " — the request timed out at the reverse proxy.";
  } else if (status === 400 || status === 414 || status === 431) {
    hint = " — the reverse proxy rejected the request line or headers.";
  }
  return detail + hint;
}

// Read a response body as JSON, but never blind-parse it.
//
// `request` used to call `res.json()` before checking `res.ok`, so any non-JSON
// error response surfaced as `Unexpected token '<', "<html> <h"... is not valid
// JSON` — a toast that hides both the status code and the reason. Since only a
// proxy can produce a non-JSON response here, that string was the one piece of
// evidence an operator got, and it named nothing. Parse defensively instead and
// keep `status` on the thrown error so callers can branch on it.
async function _readResponseBody(res, fallbackMsg) {
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (_e) { data = null; }
  }

  if (data === null && text) {
    const err = new Error(res.ok
      ? `Server returned a non-JSON response (${res.status})`
      : _proxyErrorMessage(res.status, text));
    err.status = res.status;
    err.bodyText = text;
    throw err;
  }

  if (!res.ok) {
    const err = new Error(data?.error || fallbackMsg || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// An AbortSignal that fires after `ms`, so a slow/large request (e.g. a
// dashboard feed asking for the 1000-row cap) rejects instead of hanging the
// widget forever. Prefers AbortSignal.timeout; falls back to a manual
// controller; returns undefined where neither exists (request just won't time
// out).
function timeoutSignal(ms) {
  try { if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) return AbortSignal.timeout(ms); } catch (_e) {}
  if (typeof AbortController !== "undefined") {
    var c = new AbortController();
    setTimeout(function () { c.abort(); }, ms);
    return c.signal;
  }
  return undefined;
}

// Wall-clock ceiling for the dashboard feed fetches (noc-summary / summary).
var DASHBOARD_FETCH_TIMEOUT_MS = 20000;

function trackedRequest(label, method, path, body) {
  var controller = new AbortController();
  var qid = _registerQuery(label, controller);
  return request(method, path, body, controller.signal)
    .finally(function () { _unregisterQuery(qid); });
}

const api = {
  blocks: {
    list:   (params) => request("GET", "/blocks" + toQuery(params)),
    get:    (id)     => request("GET", `/blocks/${id}`),
    create: (body)   => request("POST", "/blocks", body),
    update: (id, b)  => request("PUT", `/blocks/${id}`, b),
    delete: (id)     => request("DELETE", `/blocks/${id}`),
  },
  subnets: {
    list:          (params) => request("GET", "/subnets" + toQuery(params)),
    get:           (id)     => request("GET", `/subnets/${id}`),
    ips:           (id, params) => request("GET", `/subnets/${id}/ips` + toQuery(params)),
    create:        (body)   => request("POST", "/subnets", body),
    nextAvailable: (body)   => request("POST", "/subnets/next-available", body),
    bulkAllocate:  (body)   => request("POST", "/subnets/bulk-allocate", body),
    bulkAllocatePreview: (body) => request("POST", "/subnets/bulk-allocate/preview", body),
    refresh:       (id)     => request("POST", `/subnets/${id}/refresh`),
    update:        (id, b)  => request("PUT", `/subnets/${id}`, b),
    delete:        (id)     => request("DELETE", `/subnets/${id}`),
    // Retire a network into the archive, freeing its CIDR (business rule 41).
    // Preserves everything it moves, unlike delete.
    archive:       (id)     => request("POST", `/subnets/${id}/archive`),
    archivedList:  (params) => request("GET", "/subnets/archived" + toQuery(params)),
    archivedGet:   (id)     => request("GET", `/subnets/archived/${id}`),
    // Address space declared out of scope for the networks list (business rule
    // 42). No `cidr` on update — it is the exclusion's identity; changing which
    // space is excluded is a delete plus an add.
    exclusions: {
      list:   ()      => request("GET",    "/subnets/exclusions"),
      create: (body)  => request("POST",   "/subnets/exclusions", body),
      update: (id, b) => request("PUT",    `/subnets/exclusions/${id}`, b),
      delete: (id)    => request("DELETE", `/subnets/exclusions/${id}`),
    },
  },
  allocationTemplates: {
    list:   ()        => request("GET",    "/allocation-templates"),
    create: (body)    => request("POST",   "/allocation-templates", body),
    update: (id, b)   => request("PUT",    `/allocation-templates/${id}`, b),
    delete: (id)      => request("DELETE", `/allocation-templates/${id}`),
  },
  credentials: {
    list:   ()        => request("GET",    "/credentials"),
    get:    (id)      => request("GET",    `/credentials/${id}`),
    create: (body)    => request("POST",   "/credentials", body),
    update: (id, b)   => request("PUT",    `/credentials/${id}`, b),
    delete: (id)      => request("DELETE", `/credentials/${id}`),
    test:   (body)    => request("POST",   "/credentials/test", body),
    usageCounts: ()   => request("GET",    "/credentials/usage"),
    usage:  (id)      => request("GET",    `/credentials/${id}/usage`),
  },
  apiTokens: {
    list:   ()        => request("GET",    "/api-tokens"),
    create: (body)    => request("POST",   "/api-tokens", body),
    revoke: (id)      => request("POST",   `/api-tokens/${id}/revoke`),
    delete: (id)      => request("DELETE", `/api-tokens/${id}`),
  },
  // Operator-uploaded device icons used by the Device Map's topology
  // graph. Admin-only writes; image-serve is auth-only and cacheable.
  deviceIcons: {
    list:   ()        => request("GET",    "/device-icons"),
    upload: (scope, manufacturer, typeOrModel, file) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("scope", scope);
      formData.append("manufacturer", manufacturer);
      formData.append("typeOrModel", typeOrModel);
      return fetch(API_BASE + "/device-icons", {
        method: "POST",
        headers: _csrfHeaders(),
        body: formData,
      }).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data?.error || "Icon upload failed");
          return data;
        });
      });
    },
    delete: (id)      => request("DELETE", `/device-icons/${id}`),
  },
  reservations: {
    list:          (params) => request("GET", "/reservations" + toQuery(params)),
    get:           (id)     => request("GET", `/reservations/${id}`),
    create:        (body)   => request("POST", "/reservations", body),
    nextAvailable: (body)   => request("POST", "/reservations/next-available", body),
    // Which addresses WOULD be allocated (Auto-Allocate modal, multiple mode).
    // Read-only — the rows are created one at a time through create() above.
    nextAvailablePreview: (body) => request("POST", "/reservations/next-available/preview", body),
    update:        (id, b)  => request("PUT", `/reservations/${id}`, b),
    release:       (id)     => request("DELETE", `/reservations/${id}`),
    // Stale-reservation alerts. Settings are admin-only writes; reads are
    // open so the Events-page badge count works for every authenticated user.
    getStaleSettings:    ()      => request("GET", "/reservations/stale-settings"),
    updateStaleSettings: (body)  => request("PUT", "/reservations/stale-settings", body),
    listAlerts:          (show)  => request("GET", "/reservations/alerts" + (show ? "?show=" + encodeURIComponent(show) : "")),
    alertsCount:         ()      => request("GET", "/reservations/alerts/count"),
    snoozeAlert:         (id)    => request("POST", `/reservations/${id}/snooze`),
    ignoreAlert:         (id)    => request("POST", `/reservations/${id}/stale-ignore`),
    unignoreAlert:       (id)    => request("DELETE", `/reservations/${id}/stale-ignore`),
    // Queued-push view + retry. listPushQueue is read-everyone; retryPush is
    // ownership-gated server-side (user-or-above for own rows, fullwrite for all).
    listPushQueue:       ()      => request("GET", "/reservations/push-queue"),
    pushQueueCount:      ()      => request("GET", "/reservations/push-queue/count"),
    retryPush:           (id)    => request("POST", `/reservations/${id}/retry-push`),
  },
  utilization: {
    global:  ()   => request("GET", "/utilization"),
    block:   (id) => request("GET", `/utilization/blocks/${id}`),
    subnet:  (id) => request("GET", `/utilization/subnets/${id}`),
  },
  dashboard: {
    // Optional `sections` array narrows the response to the named sections
    // (blocks | recent | assetTypes | monitorAlerts) so a widget fetches only
    // what it renders. Optional `sourceTypes` array narrows the
    // recentReservations slice. Omitted = the back-compat full payload
    // (manual-only recents).
    summary: (opts) => {
      var parts = [];
      if (opts && Array.isArray(opts.sections) && opts.sections.length) {
        parts.push("sections=" + encodeURIComponent(opts.sections.join(",")));
      }
      if (opts && Array.isArray(opts.sourceTypes) && opts.sourceTypes.length) {
        parts.push("recentSourceTypes=" + encodeURIComponent(opts.sourceTypes.join(",")));
      }
      // recentLimit: numeric row cap for recentReservations (max 1000).
      if (opts && opts.recentLimit != null) parts.push("recentLimit=" + encodeURIComponent(opts.recentLimit));
      return request("GET", "/dashboard/summary" + (parts.length ? "?" + parts.join("&") : ""), undefined, timeoutSignal(DASHBOARD_FETCH_TIMEOUT_MS));
    },
    // Feed endpoint for the NOC widgets (status tiles, down assets, top
    // CPU/mem, slowest response, packet loss, stale polls, recent reboots,
    // active alerts, sites with issues). qs carries the per-widget filter +
    // feeds= subset (built by widgets/index.js getNocSummary).
    nocSummary: (qs) => request("GET", "/dashboard/noc-summary" + (qs ? "?" + qs : ""), undefined, timeoutSignal(DASHBOARD_FETCH_TIMEOUT_MS)),
    // Available asset types + created region names + FortiGate device names
    // for widget filter pickers. Mounted on the dash listener too (dashServer
    // API allowlist).
    filterOptions: () => request("GET", "/dashboard/filter-options"),
  },
  me: {
    dashboard: {
      get: () => request("GET", "/me/dashboard"),
      put: (layout) => request("PUT", "/me/dashboard", layout),
    },
  },
  users: {
    list:          ()       => request("GET", "/users"),
    create:        (body)   => request("POST", "/users", body),
    resetPassword: (id, b)  => request("PUT", `/users/${id}/password`, b),
    updateRole:    (id, b)  => request("PUT", `/users/${id}/role`, b),
    updateRegions: (id, b)  => request("PUT", `/users/${id}/regions`, b),
    delete:        (id)     => request("DELETE", `/users/${id}`),
    resetTotp:     (id)     => request("DELETE", `/users/${id}/totp`),
    roleReviewNotifications: ()   => request("GET", "/users/role-review-notifications"),
    dismissRoleReview:       (id) => request("DELETE", `/users/${id}/role-review`),
  },
  roles: {
    list:      ()        => request("GET", "/roles"),
    get:       (id)      => request("GET", `/roles/${id}`),
    create:    (body)    => request("POST", "/roles", body),
    update:    (id, b)   => request("PUT",  `/roles/${id}`, b),
    delete:    (id)      => request("DELETE", `/roles/${id}`),
    functions: ()        => request("GET", "/roles/functions"),
  },
  groupMappings: {
    list:   (provider) => request("GET", provider ? `/group-mappings?provider=${encodeURIComponent(provider)}` : "/group-mappings"),
    get:    (id)       => request("GET", `/group-mappings/${id}`),
    create: (body)     => request("POST", "/group-mappings", body),
    update: (id, b)    => request("PUT", `/group-mappings/${id}`, b),
    delete: (id)       => request("DELETE", `/group-mappings/${id}`),
  },
  totp: {
    status:     ()     => request("GET",    "/auth/totp/status"),
    enroll:     ()     => request("POST",   "/auth/totp/enroll"),
    confirm:    (body) => request("POST",   "/auth/totp/confirm", body),
    disable:    (body) => request("DELETE", "/auth/totp", body),
  },
  assetTypes: {
    list:      (params) => request("GET", "/asset-types" + toQuery(params)),
    create:    (body)   => request("POST",   "/asset-types", body),
    update:    (id, b)  => request("PUT",    `/asset-types/${id}`, b),
    delete:    (id)     => request("DELETE", `/asset-types/${id}`),
    // The matching vocabulary + the discovery paths rules cannot reach.
    matchSchema:  ()      => request("GET",  "/asset-types/match-schema"),
    // Dry-run. `draft` (optional) previews an unsaved edit.
    matchPreview: (draft) => request("POST", "/asset-types/match-preview", draft ? { draft } : {}),
    matchApply:   ()      => request("POST", "/asset-types/match-apply", {}),
  },
  // Saved table filters (list-page presets). `scope` names the table the
  // preset belongs to ("assets"); the server gates each scope on the function
  // key that already owns its page.
  // Per-user list-page tabs (the /me/dashboard sibling — private, never shared).
  tableTabs: {
    get:  (scope)         => request("GET", "/me/table-tabs" + toQuery({ scope })),
    save: (scope, layout) => request("PUT", "/me/table-tabs" + toQuery({ scope }), layout),
  },
  // Per-user display timezone (the /me/dashboard sibling — private, no gate
  // beyond being signed in). `detected` is NOT a preference: it reports where
  // this browser is, so an account that never opens the picker still gets its
  // alert EMAIL on its own wall clock instead of the server's.
  timezone: {
    get:      ()   => request("GET",  "/me/timezone"),
    set:      (tz) => request("PUT",  "/me/timezone", { timezone: tz }),
    detected: (tz) => request("POST", "/me/timezone/detected", { timezone: tz }),
  },
  savedFilters: {
    list:   (scope)   => request("GET",    "/saved-filters" + toQuery({ scope })),
    create: (body)    => request("POST",   "/saved-filters", body),
    update: (id, b)   => request("PUT",    `/saved-filters/${id}`, b),
    delete: (id)      => request("DELETE", `/saved-filters/${id}`),
  },
  // Saved dashboards (Dashboard page → Dashboards ▾). The two reads are the
  // only ones the Dash wallboard mounts — it is session-less, so they answer
  // with PUBLIC rows only, and it is GET-only, so the writes don't exist there.
  savedDashboards: {
    list:   ()        => request("GET",    "/saved-dashboards"),
    get:    (id)      => request("GET",    `/saved-dashboards/${id}`),
    create: (body)    => request("POST",   "/saved-dashboards", body),
    update: (id, b)   => request("PUT",    `/saved-dashboards/${id}`, b),
    delete: (id)      => request("DELETE", `/saved-dashboards/${id}`),
  },
  assets: {
    list:      (params) => request("GET", "/assets" + toQuery(params)),
    get:       (id)     => request("GET", `/assets/${id}`),
    // Sidebar alert: last agent build shipped unsigned Windows binaries (assets:write).
    agentSigningAlert: () => request("GET", "/assets/agent-signing-alert"),
    create:    (body)   => request("POST", "/assets", body),
    update:    (id, b)  => request("PUT", `/assets/${id}`, b),
    delete:    (id)     => request("DELETE", `/assets/${id}`),
    bulkDelete:(ids)    => request("DELETE", "/assets", { ids }),
    import:    (rows, dryRun) => request("POST", "/assets/import", { rows, dryRun }),
    importPdf: (assets, dryRun) => request("POST", "/assets/import-pdf", { assets, dryRun }),
    alerts:    (id)     => request("GET", `/assets/${id}/alerts`),
    // Address-book entries responsible for this device (needs contacts:read).
    contacts:  (id)     => request("GET", `/assets/${id}/contacts`),
    tags:      ()       => request("GET", "/assets/tags"),
    dnsLookup: (id)     => request("POST", `/assets/${id}/dns-lookup`),
    forwardLookup: (id) => request("POST", `/assets/${id}/forward-lookup`),
    ouiLookup: (id)     => request("POST", `/assets/${id}/oui-lookup`),
    ouiLookupAll: ()    => trackedRequest("OUI Lookup", "POST", "/assets/oui-lookup"),
    removeMac: (id, mac) => request("DELETE", `/assets/${id}/macs/${encodeURIComponent(mac)}`),
    getIpHistory:         (id)  => request("GET",  `/assets/${id}/ip-history`),
    getHistorySettings:   ()    => request("GET",  "/assets/ip-history-settings"),
    updateHistorySettings:(body) => request("PUT",  "/assets/ip-history-settings", body),
    // Sources-column priority: which discovery source's learned location wins.
    getSourcePriority:    ()    => request("GET",  "/assets/source-priority"),
    updateSourcePriority: (body) => request("PUT",  "/assets/source-priority", body),
    bulkMonitor:          (body) => request("POST", "/assets/bulk-monitor", body),
    // Mass Pinning section (Assets → Settings): device-filter vocabulary, matched
    // inventory (mode:"count"|"full"), and the bulk pin/unpin apply.
    // Add Asset form's IP cross-reference: the containing network, the lease /
    // reservation on the address, the gate that has it, and any asset already
    // carrying it. Read-only (assets-ipcontext.js).
    ipContext:            (ip)  => request("GET",  "/assets/ip-context?ip=" + encodeURIComponent(ip)),
    pinFilterSchema:      ()    => request("GET",  "/assets/pin-filter-schema"),
    pinInventory:         (body) => request("POST", "/assets/pin-inventory", body),
    applyMassPins:        (body) => request("POST", "/assets/mass-pins", body),
    monitorHistory:       (id, opts) => {
      // Accepts a range string ("24h") or { range } / { from, to } object.
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = [];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/monitor-history` + (qs.length ? "?" + qs.join("&") : ""));
    },
    maintenanceWindows:   (id, opts) => {
      // Same range/from-to semantics as monitorHistory.
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = [];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/maintenance-windows` + (qs.length ? "?" + qs.join("&") : ""));
    },
    maintenanceInfo:      (id)  => request("GET", `/assets/${id}/maintenance-info`),
    probeNow:             (id)  => request("POST", `/assets/${id}/probe-now`),
    rediscover:           (id)  => request("POST", `/assets/${id}/rediscover`),
    resetMonitorOverride: (id)  => request("POST", `/assets/${id}/monitor-override/reset`),
    effectiveMonitorSettings: (id) => request("GET", `/assets/${id}/effective-monitor-settings`),
    snmpWalk:             (id, body, signal) => request("POST", `/assets/${id}/snmp-walk`, body, signal),
    quarantineAvailability: ()  => request("GET", "/assets/quarantine-availability"),
    quarantine:           (id, reason) => request("POST", `/assets/${id}/quarantine`, reason !== undefined ? { reason } : {}),
    unquarantine:         (id)  => request("DELETE", `/assets/${id}/quarantine`),
    verifyQuarantine:     (id)  => request("POST", `/assets/${id}/quarantine/verify`),
    getSightings:         (id)  => request("GET", `/assets/${id}/sightings`),
    getSources:           (id)  => request("GET", `/assets/${id}/sources`),
    splitSource:          (id, sourceId) => request("POST", `/assets/${id}/sources/${sourceId}/split`),
    merge:                (id, body) => request("POST", `/assets/${id}/merge`, body),
    pollingHistory:       (id)  => request("GET", `/assets/${id}/polling-history`),
    getDependencies:      (id)  => request("GET", `/assets/${id}/dependencies`),
    setDependencyOverride:    (id, parentAssetIds) => request("PUT",    `/assets/${id}/dependencies/override`, { parentAssetIds }),
    clearDependencyOverride:  (id) => request("DELETE", `/assets/${id}/dependencies/override`),
    startDependencyTest:      (id, durationMinutes) => request("POST",   `/assets/${id}/dependency-test`, { durationMinutes }),
    clearDependencyTest:      (id) => request("DELETE", `/assets/${id}/dependency-test`),
    connectionPath:       (id)  => request("GET", `/assets/${id}/connection-path`),
    bulkQuarantine:       (ids, reason) => request("POST", "/assets/bulk-quarantine", reason !== undefined ? { ids, reason } : { ids }),
    bulkUnquarantine:     (ids) => request("POST", "/assets/bulk-quarantine/release", { ids }),
    getSightingSettings:  ()    => request("GET", "/assets/sighting-settings"),
    updateSightingSettings: (body) => request("PUT", "/assets/sighting-settings", body),
    // System tab — telemetry, system-info snapshot, per-interface counters, per-mountpoint storage.
    systemInfo:           (id)  => request("GET", `/assets/${id}/system-info`),
    // MAC Table tab (switches). The tab called a nonexistent `api.request` and
    // so threw on every open — `request` is module-scope here, never a member
    // of `api`.
    macTable:             (id)  => request("GET", `/assets/${id}/mac-table`),
    arpTable:             (id, range) => request("GET", `/assets/${id}/arp-table${range ? `?range=${encodeURIComponent(range)}` : ""}`),
    processes:            (id)  => request("GET", `/assets/${id}/processes`),
    processHistory:       (id, name, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = ["name=" + encodeURIComponent(name)];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/process-history?` + qs.join("&"));
    },
    processLogs:          (id, name, opts) => {
      opts = opts || {};
      var qs = ["name=" + encodeURIComponent(name)];
      if (opts.since) qs.push("since=" + encodeURIComponent(opts.since));
      if (opts.limit) qs.push("limit=" + encodeURIComponent(opts.limit));
      if (opts.flagged) qs.push("flagged=1");
      return request("GET", `/assets/${id}/process-logs?` + qs.join("&"));
    },
    processConnections:   (id, name) => request("GET", `/assets/${id}/process-connections` + (name ? "?name=" + encodeURIComponent(name) : "")),
    setProcessConfig:     (id, name, body) => request("PUT", `/assets/${id}/processes/${encodeURIComponent(name)}/config`, body),
    services:             (id)  => request("GET", `/assets/${id}/services`),
    serviceLogs:          (id, unit, opts) => {
      opts = opts || {};
      var qs = ["unit=" + encodeURIComponent(unit)];
      if (opts.since) qs.push("since=" + encodeURIComponent(opts.since));
      if (opts.limit) qs.push("limit=" + encodeURIComponent(opts.limit));
      if (opts.flagged) qs.push("flagged=1");
      return request("GET", `/assets/${id}/service-logs?` + qs.join("&"));
    },
    serviceConnections:   (id, unit) => request("GET", `/assets/${id}/process-connections?unit=` + encodeURIComponent(unit)),
    customWidgets:        (id)  => request("GET", `/assets/${id}/custom-widgets`),
    telemetryHistory:     (id, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = [];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/telemetry-history` + (qs.length ? "?" + qs.join("&") : ""));
    },
    interfaceHistory:     (id, ifName, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = ["ifName=" + encodeURIComponent(ifName)];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/interface-history?` + qs.join("&"));
    },
    setInterfaceComment:  (id, ifName, description) =>
      request("PUT", `/assets/${id}/interfaces/${encodeURIComponent(ifName)}/comment`, { description: description }),
    storageHistory:       (id, mountPath, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = ["mountPath=" + encodeURIComponent(mountPath)];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/storage-history?` + qs.join("&"));
    },
    // Severity thresholds (incl. severity bands) that would fire on this asset's
    // charted metric — feeds the chart's severity shading.
    metricThresholds:     (id, opts) => {
      opts = opts || {};
      var qs = ["metric=" + encodeURIComponent(opts.metric || "")];
      if (opts.sensorName)  qs.push("sensorName="  + encodeURIComponent(opts.sensorName));
      if (opts.sensorClass) qs.push("sensorClass=" + encodeURIComponent(opts.sensorClass));
      return request("GET", `/assets/${id}/metric-thresholds?` + qs.join("&"));
    },
    hardwareHistory:      (id, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = [];
      if (opts.sensorName) qs.push("sensorName=" + encodeURIComponent(opts.sensorName));
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/hardware-history` + (qs.length ? "?" + qs.join("&") : ""));
    },
    ipsecHistory:         (id, tunnelName, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = ["tunnelName=" + encodeURIComponent(tunnelName)];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/ipsec-history?` + qs.join("&"));
    },
    // SD-WAN (FortiOS, gated by Integration.config.pullSdwan).
    sdwanMembers:         (id) => request("GET", `/assets/${id}/sdwan-members`),
    perfSlaLinks:         (id) => request("GET", `/assets/${id}/perf-sla-links`),
    perfSlaHistory:       (id, healthCheck, link, opts) => {
      if (typeof opts === "string") opts = { range: opts };
      opts = opts || {};
      var qs = ["healthCheck=" + encodeURIComponent(healthCheck), "link=" + encodeURIComponent(link)];
      if (opts.from && opts.to) {
        qs.push("from=" + encodeURIComponent(opts.from));
        qs.push("to="   + encodeURIComponent(opts.to));
      } else if (opts.range) {
        qs.push("range=" + encodeURIComponent(opts.range));
      }
      return request("GET", `/assets/${id}/perf-sla-history?` + qs.join("&"));
    },
    sdwanRules:           (id) => request("GET", `/assets/${id}/sdwan-rules`),
    mclagPeers:           (id) => request("GET", `/assets/${id}/mclag-peers`),
    // The upstream switch / AP / firewall the General tab names, resolved to
    // asset rows so those values can carry verbs.
    upstream:             (id) => request("GET", `/assets/${id}/upstream`),
    virtualization:       (id) => request("GET", `/assets/${id}/virtualization`),
    // Polaris Agent — operator-facing endpoints (see the polaris-agent skill "Polaris
    // Agent API surface"). `agent.get` returns 404 when no agent is
    // installed yet; the caller should treat that as "no install" rather
    // than an error, so this helper resolves null on the "No agent
    // installed" response instead of throwing.
    agent:                (id) => request("GET", `/assets/${id}/agent`).catch((err) => {
      var msg = (err && err.message) ? err.message : "";
      if (/no agent installed/i.test(msg)) return null;
      throw err;
    }),
    installAgent:         (id, body) => request("POST",   `/assets/${id}/agent/install`, body),
    bulkInstallAgents:    (body)     => request("POST",   "/assets/bulk-agent-install", body),
    agentInstallScripts:  ()         => request("GET",    "/assets/agent-install-scripts"),
    retryInstallAgent:    (id)       => request("POST",   `/assets/${id}/agent/retry`),
    reinstallAgent:       (id, body) => request("POST",   `/assets/${id}/agent/reinstall`, body || {}),
    upgradeAgent:         (id, body) => request("POST",   `/assets/${id}/agent/upgrade`, body || {}),
    deleteAgent:          (id, opts) => {
      var qs = (opts && opts.force) ? "?force=true" : "";
      return request("DELETE", `/assets/${id}/agent${qs}`);
    },
  },
  integrations: {
    list:   ()       => request("GET", "/integrations"),
    get:    (id)     => request("GET", `/integrations/${id}`),
    create: (body)   => request("POST", "/integrations", body),
    update: (id, b)  => request("PUT", `/integrations/${id}`, b),
    delete: (id)     => request("DELETE", `/integrations/${id}`),
    test:   (id, name) => trackedRequest("Testing " + (name || "integration"), "POST", `/integrations/${id}/test`),
    testFortigateSample:    (id)   => trackedRequest("Testing random FortiGate", "POST", `/integrations/${id}/test/fortigate-sample`),
    testFortigateSampleNew: (body) => trackedRequest("Testing random FortiGate", "POST", "/integrations/test/fortigate-sample", body),
    register:(id, b) => request("POST", `/integrations/${id}/register`, b),
    discover:(id, name) => trackedRequest("Discovering " + (name || "DHCP"), "POST", `/integrations/${id}/discover`),
    testNew:(body)   => trackedRequest("Testing connection", "POST", "/integrations/test", body),
    query:         (id, body) => request("POST", `/integrations/${id}/query`, body),
    discoveries:   ()    => request("GET", "/integrations/discoveries"),
    healthSummary: ()    => request("GET", "/integrations/health-summary"),
    fmgActivity:   (id)  => request("GET", `/integrations/${id}/fmg-activity`),
    abortDiscover: (id)  => request("DELETE", `/integrations/${id}/discover`),
    interfaceAggregate:        (id, klass) => request("GET", `/integrations/${id}/interface-aggregate?class=${encodeURIComponent(klass)}`),
    interfaceAggregatePreview: (id, body)  => request("POST", `/integrations/${id}/interface-aggregate/preview`, body),
    interfaceAggregateApply:   (id, klass) => trackedRequest("Applying auto-monitor interfaces", "POST", `/integrations/${id}/interface-aggregate/apply`, { class: klass }),
    storageAggregate:          (id, klass) => request("GET", `/integrations/${id}/storage-aggregate?class=${encodeURIComponent(klass)}`),
    storageAggregatePreview:   (id, body)  => request("POST", `/integrations/${id}/storage-aggregate/preview`, body),
    storageAggregateApply:     (id, klass) => trackedRequest("Applying auto-monitor storage", "POST", `/integrations/${id}/storage-aggregate/apply`, { class: klass }),
    autoMonitorAssetsPreflight: (id, proposed) => request("POST", `/integrations/${id}/auto-monitor-assets/preflight`, { proposed: proposed }),
  },
  monitorSettings: {
    // Manual tier — settings for orphan/non-integration-discovered assets.
    getManual:           ()     => request("GET",  "/monitor-settings/manual"),
    setManual:           (body) => request("PUT",  "/monitor-settings/manual", body),
    // Integration tier — settings stored in Integration.config.monitorSettings.
    getIntegration:      (id)   => request("GET",  `/monitor-settings/integration/${id}`),
    setIntegration:      (id, body) => request("PUT", `/monitor-settings/integration/${id}`, body),
    // Class overrides — (assetType + integration) tuple. integrationId may be
    // null (URL sentinel "null") to scope to the manual tier.
    listClassOverrides:  (params) => {
      var qs = [];
      if (params && Object.prototype.hasOwnProperty.call(params, "integrationId")) {
        qs.push("integrationId=" + encodeURIComponent(params.integrationId === null ? "null" : params.integrationId));
      }
      if (params && params.assetType) qs.push("assetType=" + encodeURIComponent(params.assetType));
      return request("GET", "/monitor-settings/class-overrides" + (qs.length ? "?" + qs.join("&") : ""));
    },
    createClassOverride: (body) => request("POST",   "/monitor-settings/class-overrides", body),
    updateClassOverride: (id, body) => request("PUT", `/monitor-settings/class-overrides/${id}`, body),
    deleteClassOverride: (id)   => request("DELETE", `/monitor-settings/class-overrides/${id}`),
    // Reverse lookup: assets with per-asset overrides under (integrationId, assetType).
    assetOverrides:      (params) => {
      var qs = [];
      if (params && Object.prototype.hasOwnProperty.call(params, "integrationId")) {
        qs.push("integrationId=" + encodeURIComponent(params.integrationId === null ? "null" : params.integrationId));
      }
      if (params && params.assetType) qs.push("assetType=" + encodeURIComponent(params.assetType));
      return request("GET", "/monitor-settings/asset-overrides" + (qs.length ? "?" + qs.join("&") : ""));
    },
  },
  logFlagRules: {
    list:   ()        => request("GET", "/log-flag-rules"),
    create: (body)    => request("POST", "/log-flag-rules", body),
    update: (id, body) => request("PUT", `/log-flag-rules/${id}`, body),
    remove: (id)      => request("DELETE", `/log-flag-rules/${id}`),
  },
  conflicts: {
    list:   (params) => request("GET", "/conflicts" + toQuery(params)),
    count:  ()       => request("GET", "/conflicts/count"),
    accept: (id)     => request("POST", `/conflicts/${id}/accept`),
    reject: (id)     => request("POST", `/conflicts/${id}/reject`),
    merge:  (id, body) => request("POST", `/conflicts/${id}/merge`, body),
    // duplicate-IP conflicts only — body { assetId, ipAddress }
    reassignIp: (id, body) => request("POST", `/conflicts/${id}/reassign-ip`, body),
    // subnet chassis-replacement conflicts only (business rule 41)
    chassisDiff: (id) => request("GET", `/conflicts/${id}/chassis-diff`),
    migrateReservations: (id, body) => request("POST", `/conflicts/${id}/migrate-reservations`, body),
  },
  events: {
    list: (params) => request("GET", "/events" + toQuery(params)),
    resourceTypes: () => request("GET", "/events/resource-types"),
    getArchiveSettings: () => request("GET", "/events/archive-settings"),
    updateArchiveSettings: (body) => request("PUT", "/events/archive-settings", body),
    testArchiveConnection: (body) => trackedRequest("Testing archive connection", "POST", "/events/archive-test", body),
    getSyslogSettings: () => request("GET", "/events/syslog-settings"),
    updateSyslogSettings: (body) => request("PUT", "/events/syslog-settings", body),
    testSyslogConnection: (body) => trackedRequest("Testing syslog connection", "POST", "/events/syslog-test", body),
    getRetentionSettings: () => request("GET", "/events/retention-settings"),
    updateRetentionSettings: (body) => request("PUT", "/events/retention-settings", body),
    getAssetDecommissionSettings: () => request("GET", "/events/asset-decommission-settings"),
    updateAssetDecommissionSettings: (body) => request("PUT", "/events/asset-decommission-settings", body),
  },
  alerts: {
    list:        (params) => request("GET", "/alerts" + toQuery(params)),
    // One alert, for the acknowledge page an emailed / pushed Acknowledge
    // button lands on. 404 when the caller's region scope excludes it.
    get:         (id)     => request("GET", `/alerts/${encodeURIComponent(id)}`),
    // `source` is audit provenance only (the closed set the route accepts:
    // "ack_page" | "web_push_action"); omitted means the in-app surfaces.
    acknowledge: (ids, note, source) => request("POST", "/alerts/acknowledge", { ids, note, ...(source ? { source } : {}) }),
    clear:       (ids)    => request("POST", "/alerts/clear", { ids }),
  },
  push: {
    key:         ()       => request("GET", "/push-subscriptions/key"),
    subscribe:   (sub)    => request("POST", "/push-subscriptions", sub),
    unsubscribe: (endpoint) => request("DELETE", "/push-subscriptions", { endpoint }),
    // How THIS account wants to be alerted: "email" | "push" | "any". Stored
    // server-side rather than per browser, so a sign-in on a new device knows
    // to enroll (or un-enroll) itself without being told again.
    preference:     ()     => request("GET", "/me/notification-preference"),
    setPreference:  (preference) => request("PUT", "/me/notification-preference", { preference }),
  },
  maintenanceSchedules: {
    list:    ()      => request("GET", "/maintenance-schedules"),
    // Calendar tab. from/to are LOCAL day strings ("YYYY-MM-DD") and the
    // occurrences come back as server-local wall-clock strings — never parse
    // them as instants (see listOccurrences).
    occurrences: (from, to) =>
      request("GET", `/maintenance-schedules/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    // The server's wall clock + zone. Every maintenance window is picked in
    // SERVER-local time, so the browser must prefill/validate/label from this
    // rather than from its own clock — see serverClockInfo.
    serverTime: () => request("GET", "/maintenance-schedules/server-time"),
    preview: (body)  => request("POST", "/maintenance-schedules/preview", body),
    create:  (body)  => request("POST", "/maintenance-schedules", body),
    update:  (id, b) => request("PUT", `/maintenance-schedules/${id}`, b),
    delete:  (id)    => request("DELETE", `/maintenance-schedules/${id}`),
  },
  automations: {
    list:    ()        => request("GET", "/automations"),
    schema:  ()        => request("GET", "/automations/schema"),
    recipientUsers: () => request("GET", "/automations/recipient-users"),
    scopeOptions: ()   => request("GET", "/automations/scope-options"),
    // {metric, dimension, scope} → the values the draft's own devices report
    // (sensor classes, interfaces, mounts …) for the builder's dimension picker.
    dimensionValues: (body) => request("POST", "/automations/dimension-values", body),
    // {metric, scope} → how often those devices take that reading
    // ({stream, mode, min, max, timeoutMs, assetCount}). The wizard counts its
    // hold + window fields in polls and converts through this.
    pollCadence: (body) => request("POST", "/automations/poll-cadence", body),
    preview: (body)    => request("POST", "/automations/preview", body),
    // Fires ONE action of a draft for real (creates a test-flagged alert and
    // dispatches immediately) — the wizard's Summary-step test buttons.
    testDelivery: (body) => request("POST", "/automations/test-delivery", body),
    create:  (body)    => request("POST", "/automations", body),
    update:  (id, b)   => request("PUT", `/automations/${id}`, b),
    delete:  (id)      => request("DELETE", `/automations/${id}`),
    // How many devices deleting/disabling this automation would leave with NO
    // down detection at all — the delete/disable confirmation reads it.
    removalImpact: (id) => request("GET", `/automations/${id}/removal-impact`),
  },
  automationScripts: {
    list:    ()      => request("GET", "/automations/scripts"),
    get:     (id)    => request("GET", `/automations/scripts/${id}`),
    create:  (body)  => request("POST", "/automations/scripts", body),
    update:  (id, b) => request("PUT", `/automations/scripts/${id}`, b),
    delete:  (id)    => request("DELETE", `/automations/scripts/${id}`),
    testRun: (id, b) => request("POST", `/automations/scripts/${id}/test-run`, b || {}),
    runs:    (params)=> request("GET", "/automations/scripts/runs" + toQuery(params)),
    run:     (id)    => request("GET", `/automations/scripts/runs/${id}`),
  },
  contacts: {
    // Paginated + server-side searched. `params` = { q, limit, offset }; the
    // response carries { contacts, total, limit, offset }. Callers must read
    // `total` rather than `contacts.length` to know how many matched.
    list:    (params) => request("GET", "/contacts" + toQuery(params || {})),
    get:     (id)    => request("GET", `/contacts/${id}`),
    // Unified recipient typeahead: Polaris users ∪ address-book contacts.
    // `directory` additionally queries the opted-in AD/Entra integrations
    // (live lookup, nothing persisted).
    search:  (q, directory) => request("GET", "/contacts/search" + toQuery({ q, directory: directory ? 1 : undefined })),
    preview: (body)  => request("POST", "/contacts/preview", body),
    // Vocabulary + value suggestions for the device-filter condition tree. Its
    // own route because /automations/schema + /scope-options are gated
    // automationManagement:read, which browsing the address book must not need.
    filterSchema: () => request("GET", "/contacts/filter-schema"),
    create:  (body)  => request("POST", "/contacts", body),
    update:  (id, b) => request("PUT", `/contacts/${id}`, b),
    // Take ownership of a directory-synced row: it stops being updated or
    // removed by the sync, and survives the person leaving the directory.
    adopt:   (id)    => request("POST", `/contacts/${id}/adopt`),
    delete:  (id)    => request("DELETE", `/contacts/${id}`),
  },
  // Network Discovery — saved active scans of operator-supplied IP ranges
  // ("+ Add Asset(s)" → Discovery on the Assets page). Every path is behind a
  // networkScan read-level floor; `adopt` additionally needs assets write, so a
  // caller may legitimately reach `run` and 403 on `adopt`.
  networkScans: {
    list:           ()          => request("GET",    "/network-scans"),
    get:            (id)        => request("GET",    `/network-scans/${id}`),
    create:         (body)      => request("POST",   "/network-scans", body),
    update:         (id, body)  => request("PUT",    `/network-scans/${id}`, body),
    delete:         (id)        => request("DELETE", `/network-scans/${id}`),
    // 202 + the run row; the wizard then polls `run` until it goes terminal.
    run:            (id)        => request("POST",   `/network-scans/${id}/run`, {}),
    cancelRun:      (runId)     => request("POST",   `/network-scans/runs/${runId}/cancel`, {}),
    getRun:         (runId)     => request("GET",    `/network-scans/runs/${runId}`),
    adopt:          (runId, b)  => request("POST",   `/network-scans/runs/${runId}/adopt`, b),
    // Pure IP math server-side (plus a known-address count) — no packets, so
    // it is safe to call on every keystroke behind the usual debounce.
    previewTargets: (body)      => request("POST",   "/network-scans/preview-targets", body),
  },
  deliveryChannels: {
    list:        ()       => request("GET",    "/delivery-channels"),
    get:         (id)     => request("GET",    `/delivery-channels/${id}`),
    create:      (body)   => request("POST",   "/delivery-channels", body),
    update:      (id, b)  => request("PUT",    `/delivery-channels/${id}`, b),
    delete:      (id)     => request("DELETE", `/delivery-channels/${id}`),
    test:        (id, b)  => request("POST",   `/delivery-channels/${id}/test`, b || {}),
    generateVapid:(id)    => request("POST",   `/delivery-channels/${id}/generate-vapid`),
    // Web Push is a single on/off capability, not a destination to configure.
    getWebPush:  ()       => request("GET",    "/delivery-channels/web-push"),
    setWebPush:  (enabled) => request("PUT",   "/delivery-channels/web-push", { enabled }),
    // Sends to the CALLER's own enrolled devices only.
    testWebPush: ()       => request("POST",  "/delivery-channels/web-push/test"),
  },
  serverSettings: {
    // Polaris Agent — Build button + inventory on Maintenance tab.
    agentInventory:    ()        => request("GET",    "/server-settings/agents/inventory"),
    agentBuildStart:   ()        => request("POST",   "/server-settings/agents/build"),
    agentBuildCurrent: ()        => request("GET",    "/server-settings/agents/build/current"),
    agentBuildStatus:  (id)      => request("GET",    `/server-settings/agents/build/${id}`),
    agentBuildCancel:  (id)      => request("DELETE", `/server-settings/agents/build/${id}`),
    agentPrune:        ()        => request("POST",   "/server-settings/agents/prune"),
    agentAutoBuildSettingGet:   () => request("GET",    "/server-settings/agents/auto-build-setting"),
    agentAutoBuildSettingSet:   (b)=> request("PUT",    "/server-settings/agents/auto-build-setting", { enabled: !!b }),
    agentAutoUpgradeSettingGet: () => request("GET",    "/server-settings/agents/auto-upgrade-setting"),
    agentAutoUpgradeSettingSet: (b)=> request("PUT",    "/server-settings/agents/auto-upgrade-setting", { enabled: !!b }),
    agentInstalledSummary:      () => request("GET",    "/server-settings/agents/installed-summary"),
    agentInstalledList:         () => request("GET",    "/server-settings/agents/installed"),
    agentUpgradeAll:            () => request("POST",   "/server-settings/agents/upgrade-all"),
    agentServerUrlGet:        () => request("GET",    "/server-settings/agents/server-url"),
    agentServerUrlSet:        (url) => request("PUT", "/server-settings/agents/server-url", { url }),
    agentCertPinsSummary:     () => request("GET",    "/server-settings/agents/cert-pins/summary"),
    agentCertPinBulkAdd:      (pin) => request("POST", "/server-settings/agents/cert-pins/bulk-add", { pin }),
    agentCertPinBulkRemove:   (pin) => request("POST", "/server-settings/agents/cert-pins/bulk-remove", { pin }),
    // Windows SSH deployment card (Integrations → Polaris Agent). Routes live
    // under /server-settings/agents/* like the agent-build card's, even though
    // the UI renders on the Integrations page.
    agentWindowsSshGet:       () => request("GET",  "/server-settings/agents/windows-ssh"),
    agentWindowsSshSave:      (cfg) => request("PUT", "/server-settings/agents/windows-ssh", cfg),
    agentWindowsSshGenerate:  () => request("POST", "/server-settings/agents/windows-ssh/generate"),
    agentWindowsSshScript:    (kind, platform) =>
      request("GET", "/server-settings/agents/windows-ssh/script?kind=" + encodeURIComponent(kind || "remediation") +
        "&platform=" + encodeURIComponent(platform || "windows")),
    // Script publishing. The publish call is tracked (it reaches a customer
    // tenant over the network and can take a few seconds) so it shows in the
    // cancellable-query tray like the other slow outbound operations.
    scriptPublishTargets:     () => request("GET", "/server-settings/agents/script-publish/targets"),
    scriptPublishIntune:      (integrationId) =>
      trackedRequest("Publishing to Intune", "POST", "/server-settings/agents/script-publish/intune", { integrationId }),
    // Arc: listing is read-only; arcRun EXECUTES the script on the named
    // machines, which is why it takes an explicit id list and never a filter.
    arcMachines:              (integrationId) =>
      trackedRequest("Listing Arc machines", "GET",
        "/server-settings/agents/script-publish/arc/machines?integrationId=" + encodeURIComponent(integrationId)),
    arcRun:                   (integrationId, armIds) =>
      trackedRequest("Running on Arc machines", "POST", "/server-settings/agents/script-publish/arc",
        { integrationId, armIds }),
    arcRunResult:             (integrationId, armId) =>
      request("GET", "/server-settings/agents/script-publish/arc/result?integrationId=" +
        encodeURIComponent(integrationId) + "&armId=" + encodeURIComponent(armId)),
    // Pinned SSH host keys (trust-on-first-use). Deleting one re-opens
    // first-use trust for that host — the recovery path after a rebuild.
    sshHostKeysList:          () => request("GET",    "/server-settings/agents/ssh-host-keys"),
    sshHostKeyDelete:         (id) => request("DELETE", "/server-settings/agents/ssh-host-keys/" + encodeURIComponent(id)),
    // Agent code signing (internal-CA PKCS#12) — masked secret config + dry-run test.
    agentSigningGet:          ()    => request("GET",  "/server-settings/agents/signing"),
    agentSigningSet:          (cfg) => request("PUT",  "/server-settings/agents/signing", cfg),
    agentSigningTest:         ()    => trackedRequest("Testing code signing", "POST", "/server-settings/agents/signing/test"),
    // The .pfx and its password travel together: installKeystore validates
    // before promoting, so a wrong password fails the upload instead of
    // replacing a working keystore with one that breaks the next build.
    agentSigningUploadKeystore: (file, password) =>
      uploadFileFields("/server-settings/agents/signing/keystore", file, { password: password }),
    agentSigningDeleteKeystore: () => request("DELETE", "/server-settings/agents/signing/keystore"),
    getNtp:      ()       => request("GET", "/server-settings/ntp"),
    updateNtp:   (body)   => request("PUT", "/server-settings/ntp", body),
    testNtp:     (body)   => trackedRequest("Testing NTP sync", "POST", "/server-settings/ntp/test", body),
    listCerts:   ()       => request("GET", "/server-settings/certificates"),
    uploadCert:  (category, file) => uploadFile("/server-settings/certificates", category, file),
    deleteCert:  (id)     => request("DELETE", `/server-settings/certificates/${id}`),
    getHttps:    ()       => request("GET", "/server-settings/https"),
    // Dash wallboard (unauthenticated read-only /dash surface) toggle + IP scope.
    dashGet:              ()      => request("GET",  "/server-settings/dash"),
    dashPut:              (body)  => request("PUT",  "/server-settings/dash", body),
    // Local login source-IP restriction (login form + password endpoints).
    // The GET also reports the caller's IP as Polaris resolves it, which is
    // what reveals a trust-proxy misconfiguration before the scope is trusted.
    loginAccessGet:       ()      => request("GET",  "/server-settings/login-access"),
    loginAccessPut:       (body)  => request("PUT",  "/server-settings/login-access", body),
    // API documentation (/api) source-IP scope. GET also reports the caller's
    // resolved IP (trust-proxy visibility, same as login-access); PUT answers
    // { apiDocs, callerAllowed, nginx } — warn on callerAllowed false.
    apiDocsGet:           ()      => request("GET",  "/server-settings/api-docs"),
    apiDocsPut:           (body)  => request("PUT",  "/server-settings/api-docs", body),
    // nginx GUI (proxy mode is now the only mode). Six controls + cert rotation.
    proxyGet:             ()      => request("GET",  "/server-settings/proxy"),
    proxyPut:             (body)  => request("PUT",  "/server-settings/proxy", body),
    proxyApply:           (body)  => request("POST", "/server-settings/proxy/apply", body),
    proxyAdoptManagedMode:()      => request("POST", "/server-settings/proxy/adopt-managed-mode"),
    proxyCertPreflight:   (certFile, keyFile) => {
      var formData = new FormData();
      formData.append("cert", certFile);
      formData.append("key", keyFile);
      return fetch(API_BASE + "/server-settings/proxy/cert/preflight", {
        method: "POST",
        headers: _csrfHeaders(),
        body: formData,
      }).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        return res.json().then(function (d) {
          if (!res.ok) throw new Error(d?.error || "Cert preflight failed");
          return d;
        });
      });
    },
    proxyCertRotate:      (body)  => request("POST", "/server-settings/proxy/cert/rotate", body),
    getDatabase: ()       => request("GET", "/server-settings/database"),
    backupDatabase: (password) => {
      var opts = { method: "POST", headers: _csrfHeaders({ "Content-Type": "application/json" }) };
      if (password) opts.body = JSON.stringify({ password: password });
      return fetch(API_BASE + "/server-settings/database/backup", opts).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Backup failed"); });
        var filename = "polaris-backup.gz";
        var cd = res.headers.get("Content-Disposition");
        if (cd) { var m = cd.match(/filename="?([^"]+)"?/); if (m) filename = m[1]; }
        return res.blob().then(function (blob) { return { blob: blob, filename: filename }; });
      });
    },
    restoreDatabase: (file, password) => {
      var formData = new FormData();
      formData.append("file", file);
      if (password) formData.append("password", password);
      return fetch(API_BASE + "/server-settings/database/restore", { method: "POST", headers: _csrfHeaders(), body: formData }).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        return res.json().then(function (data) { if (!res.ok) throw new Error(data.error || "Restore failed"); return data; });
      });
    },
    listBackups: () => request("GET", "/server-settings/database/backups"),
    // Scheduled backups. The GET returns the passphrase masked; echoing the mask
    // back on save means "keep the stored value".
    getBackupSchedule:  () => request("GET", "/server-settings/database/backup-schedule"),
    saveBackupSchedule: (body) => request("PUT", "/server-settings/database/backup-schedule", body),
    deleteBackup: (id) => request("DELETE", `/server-settings/database/backups/${id}`),
    downloadBackup: (id) => {
      return fetch(API_BASE + "/server-settings/database/backups/" + id + "/download").then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        if (!res.ok) return res.json().then(function (d) { throw new Error(d.error || "Download failed"); });
        var filename = "backup.gz";
        var cd = res.headers.get("Content-Disposition");
        if (cd) { var m = cd.match(/filename="?([^"]+)"?/); if (m) filename = m[1]; }
        return res.blob().then(function (blob) { return { blob: blob, filename: filename }; });
      });
    },
    listTags:    ()       => request("GET", "/server-settings/tags"),
    // The picker-shaped catalogue (name/category/colour + the enforce flag).
    // Mounted above the serverSettingsSystem floor that listTags sits behind,
    // so every role that can tag something can read the tag list.
    tagCatalog:  ()       => request("GET", "/server-settings/tags/catalog"),
    createTag:   (body)   => request("POST", "/server-settings/tags", body),
    updateTag:   (id, body) => request("PUT", `/server-settings/tags/${id}`, body),
    deleteTag:   (id)     => request("DELETE", `/server-settings/tags/${id}`),
    getTagSettings: ()    => request("GET", "/server-settings/tags/settings"),
    updateTagSettings: (body) => request("PUT", "/server-settings/tags/settings", body),
    previewTagCriteria: (body) => request("POST", "/server-settings/tags/preview-criteria", body),
    tagFilterSchema: ()   => request("GET", "/server-settings/tags/filter-schema"),
    getBranding:  ()       => request("GET", "/server-settings/branding"),
    updateBranding: (body) => request("PUT", "/server-settings/branding", body),
    uploadLogo: (file) => {
      const formData = new FormData();
      formData.append("file", file);
      return fetch(API_BASE + "/server-settings/branding/logo", {
        method: "POST",
        headers: _csrfHeaders(),
        body: formData,
      }).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data?.error || "Upload failed");
          return data;
        });
      });
    },
    deleteLogo: () => request("DELETE", "/server-settings/branding/logo"),
    getDns:      ()       => request("GET", "/server-settings/dns"),
    updateDns:   (body)   => request("PUT", "/server-settings/dns", body),
    testDns:     (body)   => trackedRequest("Testing DNS", "POST", "/server-settings/dns/test", body),
    getOui:         ()       => request("GET", "/server-settings/oui"),
    refreshOui:     ()       => trackedRequest("Refreshing OUI database", "POST", "/server-settings/oui/refresh"),
    lookupOui:      (pfx)    => request("GET", `/server-settings/oui/lookup/${encodeURIComponent(pfx)}`),
    getOuiOverrides:()       => request("GET", "/server-settings/oui/overrides"),
    addOuiOverride: (body)   => request("POST", "/server-settings/oui/overrides", body),
    deleteOuiOverride:(pfx)  => request("DELETE", `/server-settings/oui/overrides/${encodeURIComponent(pfx)}`),
    getPlaceholderMac:()     => request("GET", "/server-settings/reservation-mac"),
    setPlaceholderMac:(body) => request("PUT", "/server-settings/reservation-mac", body),
    listMibs: (params) => request("GET", "/server-settings/mibs" + toQuery(params)),
    getMibFacets: () => request("GET", "/server-settings/mibs/facets"),
    getMibProfileStatus: () => request("GET", "/server-settings/mibs/profile-status"),
    uploadMib: (file, fields) => {
      const formData = new FormData();
      formData.append("file", file);
      if (fields) {
        if (fields.manufacturer) formData.append("manufacturer", fields.manufacturer);
        if (fields.model) formData.append("model", fields.model);
        if (fields.notes) formData.append("notes", fields.notes);
      }
      return fetch(API_BASE + "/server-settings/mibs", {
        method: "POST",
        headers: _csrfHeaders(),
        body: formData,
      }).then(function (res) {
        if (res.status === 401) { window.location.href = "/login.html"; return; }
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data?.error || "MIB upload failed");
          return data;
        });
      });
    },
    deleteMib: (id) => request("DELETE", `/server-settings/mibs/${id}`),
    downloadMibUrl: (id) => API_BASE + "/server-settings/mibs/" + encodeURIComponent(id) + "/download",
    // MIB Browse modal — structured object tree for one MIB. Result is a
    // ParsedMibStructured shape: moduleName, imports[], symbols[], tables[].
    getMibStructure: (id) => request("GET", `/server-settings/mibs/${id}/structure`),
    // MIB-aware walk — body { assetId, credentialId, objectName, maxRows? }
    // Returns either { kind: "scalars", entries: [...] } or
    // { kind: "table", table: { columns, rows: [{ index, cells }] }, ... }.
    walkMib: (id, body, signal) => request("POST", `/server-settings/mibs/${id}/walk`, body, signal),
    // Bundled standard MIBs (RFC/IEEE). `key` is the std:* dropdown id; the
    // route strips the `std:` prefix server-side and looks up the parsed
    // structure or runs the MIB-aware walk against the asset. Same response
    // shapes as the uploaded variants above.
    getStdMibStructure: (key) => {
      var k = key && key.indexOf("std:") === 0 ? key.slice(4) : key;
      return request("GET", "/server-settings/mibs/std/" + encodeURIComponent(k) + "/structure");
    },
    walkStdMib: (key, body, signal) => {
      var k = key && key.indexOf("std:") === 0 ? key.slice(4) : key;
      return request("POST", "/server-settings/mibs/std/" + encodeURIComponent(k) + "/walk", body, signal);
    },
    listManufacturerAliases:   ()      => request("GET",    "/manufacturer-aliases"),
    createManufacturerAlias:   (body)  => request("POST",   "/manufacturer-aliases", body),
    updateManufacturerAlias:   (id, b) => request("PUT",    `/manufacturer-aliases/${encodeURIComponent(id)}`, b),
    deleteManufacturerAlias:   (id)    => request("DELETE", `/manufacturer-aliases/${encodeURIComponent(id)}`),
    // Editable Manufacturer Profile (Slice 6). Reads = admin or assets-admin;
    // writes admin-only. The monitoring path doesn't consume these rows yet
    // — the resolver swap lands in a follow-up.
    listManufacturerProfiles:    ()      => request("GET",    "/server-settings/manufacturer-profiles"),
    // Typeahead for the add box — asset manufacturers + alias/OUI-override
    // canonicals, minus the ones that already have a profile.
    listManufacturerSuggestions: ()      => request("GET",    "/server-settings/manufacturer-profiles/suggestions"),
    getManufacturerProfile:      (id)    => request("GET",    `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}`),
    createManufacturerProfile:   (body)  => request("POST",   "/server-settings/manufacturer-profiles", body),
    deleteManufacturerProfile:   (id)    => request("DELETE", `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}`),
    updateProfileMetric:         (id, metricKey, body) =>
      request("PUT", `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}/metrics/${encodeURIComponent(metricKey)}`, body),
    createProfileMetricOverride: (id, metricKey, body) =>
      request("POST", `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}/metrics/${encodeURIComponent(metricKey)}/overrides`, body),
    updateProfileMetricOverride: (id, metricKey, overrideId, body) =>
      request("PUT", `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}/metrics/${encodeURIComponent(metricKey)}/overrides/${encodeURIComponent(overrideId)}`, body),
    deleteProfileMetricOverride: (id, metricKey, overrideId) =>
      request("DELETE", `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}/metrics/${encodeURIComponent(metricKey)}/overrides/${encodeURIComponent(overrideId)}`),
    createProfileWidget:         (id, body) =>
      request("POST", `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}/widgets`, body),
    updateProfileWidget:         (id, widgetId, body) =>
      request("PUT", `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}/widgets/${encodeURIComponent(widgetId)}`, body),
    deleteProfileWidget:         (id, widgetId) =>
      request("DELETE", `/server-settings/manufacturer-profiles/${encodeURIComponent(id)}/widgets/${encodeURIComponent(widgetId)}`),
    getPgTuning: () => request("GET", "/server-settings/pg-tuning"),
    getQueueMode: () => request("GET", "/server-settings/queue-mode"),
    setQueueMode: (mode) => request("POST", "/server-settings/queue-mode", { mode: mode }),
    getCapacityAdvisor: () => request("GET", "/server-settings/capacity-advisor"),
    stageCapacityAdvisor: (keys) => request("POST", "/server-settings/capacity-advisor/stage", { keys: keys }),
    getSampleRetention: () => request("GET", "/server-settings/sample-retention"),
    setSampleRetention: (retention) => request("PUT", "/server-settings/sample-retention", retention),
    getAgentEventLog: () => request("GET", "/server-settings/agent-event-log"),
    setAgentEventLog: (config) => request("PUT", "/server-settings/agent-event-log", config),
    generateSecurityToken: (which) => request("POST", "/server-settings/security-tokens/generate", { which: which }),
    restart: () => request("POST", "/server-settings/restart"),
    checkForUpdates: () => request("GET", "/server-settings/updates/check"),
    getUpdateStatus: () => request("GET", "/server-settings/updates/status"),
    // allowWithoutBackup: only sent when the operator ticked the confirmation in
    // the Apply Update modal. Absent/false means the server ABORTS the update if
    // the pre-update backup fails.
    applyUpdate:     (password, allowWithoutBackup) => {
      const body = {};
      if (password) body.password = password;
      if (allowWithoutBackup) body.allowWithoutBackup = true;
      return request("POST", "/server-settings/updates/apply", Object.keys(body).length ? body : undefined);
    },
    dismissUpdate:   () => request("POST", "/server-settings/updates/dismiss"),
    getUpdateHistory: (limit) => request("GET", "/server-settings/updates/history" + (limit ? "?limit=" + limit : "")),
    getUpdateRepo:   () => request("GET", "/server-settings/updates/repo"),
    getUpdateSettings: () => request("GET", "/server-settings/updates/settings"),
    setUpdateSettings: (body) => request("PUT", "/server-settings/updates/settings", body),
  },
  search: {
    query: (q) => request("GET", `/search?q=${encodeURIComponent(q)}`),
  },
  map: {
    sites:    (regionNames) => request("GET", "/map/sites" + (regionNames && regionNames.length ? "?regionTags=" + encodeURIComponent(regionNames.slice().sort().join(",")) : "")),
    topology: (id)      => request("GET", `/map/sites/${id}/topology`),
    topologySearch: (id, q) => request("GET", `/map/sites/${id}/topology/search?q=${encodeURIComponent(q)}`),
    saveTopologyLayout:   (id, view, positions) => request("PUT",    `/map/sites/${id}/topology/layout`, { view, positions }),
    deleteTopologyLayout: (id, view)            => request("DELETE", `/map/sites/${id}/topology/layout?view=${encodeURIComponent(view)}`),
    // Explicit Save — stamps the restore point "Reset to last save" restores.
    saveTopologyCheckpoint: (id, view, positions) => request("POST", `/map/sites/${id}/topology/layout/checkpoint`, { view, positions }),
  },
  applicationMap: {
    get:          ()                => request("GET",    "/application-map"),
    saveLayout:   (view, positions) => request("PUT",    "/application-map/layout", { view: view, positions: positions }),
    deleteLayout: (view)            => request("DELETE", "/application-map/layout?view=" + encodeURIComponent(view || "global")),
    // Discovery: named map rules (an asset scope + the items to pin on it),
    // applied now AND to assets discovered later.
    discovery:         ()      => request("GET",  "/application-map/discovery"),
    saveDiscovery:     (rules) => request("PUT",  "/application-map/discovery", { rules: rules }),
    // Scope-driven lookups for the wizard: which assets match, and what those
    // assets actually report (so the item picker isn't the whole fleet).
    discoveryScope:     (scope, assetIds) => request("POST", "/application-map/discovery/scope-preview", { scope: scope, assetIds: assetIds || [] }),
    discoveryInventory: (scope) => request("POST", "/application-map/discovery/inventory", { scope: scope }),
    previewDiscovery:   (rule)  => request("POST", "/application-map/discovery/preview", { rule: rule }),
    unmapEverywhere:  (kind, name) => request("POST", "/application-map/discovery/unmap", { kind: kind, name: name }),
  },
  mapRegions: {
    list:   ()                     => request("GET",    "/map/regions"),
    create: (name, polygon, color) => request("POST",   "/map/regions", color ? { name, polygon, color } : { name, polygon }),
    update: (id, body)             => request("PUT",    `/map/regions/${id}`, body),
    delete: (id)                   => request("DELETE", `/map/regions/${id}`),
    // The Save Regions review: full reconcile + strip stale region tags off
    // pinned FortiGates that are no longer inside the named polygon.
    reconcile: ()                  => request("POST",   "/map/regions/reconcile"),
    // Read-only geometry + the derived containment tree for the map's "Show
    // regions" button. A DIFFERENT endpoint from list() on purpose: this one
    // lives under the /map mount and is reachable at deviceMap:read, whereas
    // list() needs mapRegions:read — see the route's own comment.
    overlay: ()                    => request("GET",    "/map/region-overlay"),
  },
  auth: {
    me: () => request("GET", "/auth/me"),
    azureConfig: () => request("GET", "/auth/azure/config"),
    azureSettings: () => request("GET", "/auth/azure/settings"),
    updateAzureSettings: (body) => request("PUT", "/auth/azure/settings", body),
    testAzureSettings: () => request("POST", "/auth/azure/test"),
    oidcConfig: () => request("GET", "/auth/oidc/config"),
    oidcSettings: () => request("GET", "/auth/oidc/settings"),
    updateOidcSettings: (body) => request("PUT", "/auth/oidc/settings", body),
    testOidc: () => request("POST", "/auth/oidc/test"),
    ldapSettings: () => request("GET", "/auth/ldap/settings"),
    updateLdapSettings: (body) => request("PUT", "/auth/ldap/settings", body),
    testLdap: () => request("POST", "/auth/ldap/test"),
    entraProxyConfig: () => request("GET", "/auth/entra-proxy/config"),
    entraProxySettings: () => request("GET", "/auth/entra-proxy/settings"),
    updateEntraProxySettings: (body) => request("PUT", "/auth/entra-proxy/settings", body),
    testEntraProxy: () => request("POST", "/auth/entra-proxy/test"),
  },
};

// `api` above is a top-level `const`, and a top-level const/let in a classic
// script lives in the global LEXICAL environment — it is NOT a property of
// `window`. So the bare identifier `api` resolves everywhere, while
// `window.api` is `undefined`, which is a trap for the shared modules that
// legitimately have to feature-detect the client before using it: both
// region-pills.js (the region catalogue behind every region pill and picker)
// and app.js's `wireTotpState` guarded on `window.api` and therefore
// short-circuited on EVERY page — the region picker reported "No map regions
// defined yet" and filed every stored assignment under "Unknown region tags",
// and the account menu's self-service 2FA row never rendered. Neither failed
// loudly, because both were written to degrade quietly when the client is
// absent. Publishing the object is what makes that guard mean what it says.
window.api = api;

/**
 * Multipart POST of one file plus arbitrary sibling form fields. Separate from
 * uploadFile() because that one hardcodes a `category` field; this carries the
 * keystore password alongside the .pfx so validation and install are one
 * request (a two-step "upload, then set the password" would leave an
 * unvalidated keystore installed in between).
 */
async function uploadFileFields(path, file, fields) {
  const formData = new FormData();
  formData.append("file", file);
  Object.keys(fields || {}).forEach(function (k) {
    if (fields[k] !== undefined && fields[k] !== null) formData.append(k, fields[k]);
  });

  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: _csrfHeaders(),
    body: formData,
  });

  if (res.status === 401) { window.location.href = "/login.html"; return; }
  return _readResponseBody(res, "Upload failed");
}

async function uploadFile(path, category, file) {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("category", category);

  const res = await fetch(API_BASE + path, {
    method: "POST",
    headers: _csrfHeaders(),
    body: formData,
  });

  if (res.status === 401) { window.location.href = "/login.html"; return; }
  // Same defensive parse as `request` — and the likeliest caller to meet
  // nginx's 1 MB `client_max_body_size` head-on, since this one posts files.
  return _readResponseBody(res, "Upload failed");
}

function toQuery(params) {
  if (!params) return "";
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return qs ? "?" + qs : "";
}

// ─── Clipboard (shared, 2026-08 audit) ──────────────────────────────────────
//
// One robust text-copy for every page: navigator.clipboard when available
// (secure contexts), else the textarea/execCommand legacy path (HTTP installs,
// older browsers). Resolves true/false — callers own their toast/flash UX.
// Previously two module-private robust helpers (map.js, ip-panel.js) next to
// ~19 raw writeText sites that silently failed on non-secure contexts.
function copyTextToClipboard(text) {
  function legacyCopy() {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = !!(document.execCommand && document.execCommand("copy"));
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(); },
      );
    }
  } catch (_) { /* fall through to legacy path */ }
  return Promise.resolve(legacyCopy());
}
window.copyTextToClipboard = copyTextToClipboard;

// ─── Shared status palettes (2026-08 audit) ─────────────────────────────────
//
// POLARIS_HEALTH_COLORS: the topology node-health hues (Device Map modal +
// widget, mobile topology, map.js endpoint nodes). Deliberately distinct from
// the CSS --color-* theme variables and from the assets-page monitor-state
// palette — do NOT remap. topology-render.js re-exposes this object as
// PolarisTopologyRender.HEALTH_NODE_COLORS.
window.POLARIS_HEALTH_COLORS = {
  up:          "#2e7d32", // green
  degraded:    "#f9a825", // amber
  down:        "#c62828", // red
  maintenance: "#9575cd", // purple — scheduler-held status="maintenance"
  unknown:     "#9e9e9e", // gray — unknown / dep-suppressed
  unmonitored: "#757575", // gray — unmonitored
  recovering:  "#0288d1", // blue — endpoint nodes only
  depDown:     "#607d8b", // slate — Device Map widget's dep-suppressed pin
  // Indigo — no down-detection automation covers the device, so Polaris has no
  // verdict to paint. Distinct from the grey "unknown", which claims we have no
  // samples: a passive device is polled and charted like any other.
  passive:     "#5c6bc0",
};

// The lighter material trio/quad the dashboard widgets use for pips + tiles
// (statusSummary, sitesWithIssues).
window.POLARIS_WIDGET_STATUS_COLORS = {
  ok:      "#66bb6a",
  warning: "#ffa726",
  down:    "#ef5350",
  neutral: "#90a4ae",
};

// Operator-facing label per monitorStatus value. Mirrors MONITOR_STATUS_LABELS
// in src/utils/monitorStatus.ts — change one, change both, or the assets pill
// and the search-hit pill (rendered from the server's label) drift apart.
//
// `warning` reads "Missed", not "Warning": the alert severities are also named
// warning/serious/critical, so a Status pill reading Warning was read as "an
// alert has fired about this device" when it only ever meant "a poll was
// missed and the down count has started". The stored value is untouched — this
// is the display name only.
window.POLARIS_MONITOR_STATUS_LABELS = {
  up:         "Up",
  warning:    "Missed",
  recovering: "Recovering",
  down:       "Down",
  unknown:    "Pending",
  passive:    "Passive",
};

// Label for a raw monitorStatus; unrecognized values pass through unchanged so
// a server-side addition renders as itself instead of vanishing.
function monitorStatusLabel(status) {
  if (!status) return window.POLARIS_MONITOR_STATUS_LABELS.unknown;
  return window.POLARIS_MONITOR_STATUS_LABELS[status] || String(status);
}
window.monitorStatusLabel = monitorStatusLabel;

// Copy a PNG blob to the clipboard. Resolves true on success, false when the
// clipboard image API is unavailable (HTTP context / permission denied) or the
// write fails — callers own their toast/download-fallback UX. Companion to
// copyTextToClipboard above; there is no legacy path for images.
function copyPngToClipboard(blob) {
  try {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined" || !navigator.clipboard.write) {
      return Promise.resolve(false);
    }
    return navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]).then(
      function () { return true; },
      function () { return false; },
    );
  } catch (_) {
    return Promise.resolve(false);
  }
}
window.copyPngToClipboard = copyPngToClipboard;

// ─── Flat-criteria collector (2026-08 audit) ────────────────────────────────
//
// DOM → TagCriteria for the two flat criteria builders (the Maintenance
// schedule editor and the appmap Service & Process Discovery wizard's device
// step, which was ported from it). Both render rows as
// [field select][op?/integration-select?/value input][remove]; this walks
// them with the caller's selectors and produces the exact wire shape
// tagAssignmentService.normalizeCriteria accepts — comma-split multi-values,
// bare IPs promoted to /32 (v4) / /128 (v6), single-id integration rules,
// empty rows dropped, and null when nothing usable remains (null = "no
// criteria", NOT "match nothing"). The RENDER halves stay per-page (they
// diverge deliberately); the wire shape must never drift, so it lives here.
function collectTagCriteria(cfg) {
  var rules = [];
  document.querySelectorAll(cfg.rowSelector).forEach(function (row) {
    var field = row.querySelector(cfg.fieldSel).value;
    if (field === "integration") {
      var sel = row.querySelector(cfg.integrationSel);
      if (sel && sel.value) rules.push({ field: "integration", op: "exact", values: [sel.value] });
      return;
    }
    var input = row.querySelector(cfg.inputSel);
    var parts = (input && input.value ? input.value : "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return;
    if (field === "subnet") {
      rules.push({
        field: "subnet", op: "inCidr",
        cidrs: parts.map(function (p) {
          if (p.indexOf("/") !== -1) return p;
          return p.indexOf(":") !== -1 ? p + "/128" : p + "/32";
        }),
      });
    } else {
      var opSel = row.querySelector(cfg.opSel);
      rules.push({ field: field, op: opSel ? opSel.value : "exact", values: parts });
    }
  });
  return rules.length ? { version: 1, match: "all", rules: rules } : null;
}
window.collectTagCriteria = collectTagCriteria;
