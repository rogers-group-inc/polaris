/**
 * public/js/app.js — Shared UI utilities: nav, toasts, modals, helpers
 */

// ─── Theme ────────────────────────────────────────────────
//
// The engine — the theme catalogue (THEMES / TRANSIT_THEMES / DEFAULT_THEME),
// the strip positions (THEME_BAND_POS), the crossfade and glow clocks, the
// band's travel and seam, and isLightTheme — lives in js/theme-core.js, which
// every page loads right before this file and which the Dash wallboard
// (dash-boot.js) and the phone (mobile/app.js) share. This file is the
// sidebar band's HOST: it builds the engine against `.theme-band-track`,
// names the theme in the band's aria-label, and keeps the long-standing
// global names (_setTheme / advanceTheme / _seatThemeBands …) that renderNav
// and the rest of the shell call.

// The desktop's own copy of the engraving: 1676 x 64, twice the band's 32 px
// height for high-density screens, WebP at quality 90 — 31 KB, where the
// shared 3456 x 132 PNG it replaced was 757 KB. The phone keeps a full-size
// one (/img/brand/time-strip.webp), since it draws the strip 72 px tall. Positions are
// fractions of the strip's width, so the resolution changes nothing else.
var THEME_BAND_ART = "/img/brand/time-strip-desktop.webp";
// The art's intrinsic size, written onto each <img> so the band can be
// MEASURED (and seated) in the first paint, before the image has decoded —
// with width/height the browser knows the aspect ratio up front. Without
// them the width read 0 until load, and the band painted unseated and jumped
// into place on every page change.
var THEME_BAND_ART_W = 1676, THEME_BAND_ART_H = 64;

// A shipped /img/brand/ file's URL with the running version as ?v=, from the
// cached branding payload. The server answers that immutable (src/app.ts), so
// a page change paints the art from cache instead of revalidating it first.
// No cached version yet (a first visit): the plain URL, revalidated as before.
function _brandArtUrl(path) {
  var v = "";
  try {
    var b = JSON.parse(localStorage.getItem("polaris-branding") || "null");
    if (b && b.version) v = String(b.version);
  } catch (e) { /* storage blocked — unversioned */ }
  return v ? path + "?v=" + encodeURIComponent(v) : path;
}

// No saved preference (fresh browser, or a user who has never touched the
// band) follows the OS. theme-init.js already did this in <head>; repeating it
// here keeps a page that skipped it correct.
_applySavedTheme();

// Page layout: how wide the shell may grow. Two capped columns centred in the
// window (the sidebar, tables and slide-overs all follow the column's edges)
// and one that fills the window. Stored per BROWSER, like the theme, because
// the right answer is a property of the monitor, not of the account — the same
// operator wants Auto on the ultrawide and 16:9 on the laptop. The CSS side is
// the --layout-max-width token keyed on :root[data-layout] in styles.css.
var LAYOUTS = [
  { id: "16x9",  label: "16:9",  title: "A 16:9 column centred in the window" },
  { id: "16x10", label: "16:10", title: "A 16:10 column centred in the window" },
  { id: "auto",  label: "Auto",  title: "Fill the browser window, however wide it is" },
];
var DEFAULT_LAYOUT = "16x9";
var LAYOUT_STORAGE_KEY = "polaris-layout";

// Unknown, missing or retired values land on the default rather than on a
// layout the stylesheet does not define (which would silently mean full-bleed).
function _layoutId(v) {
  for (var i = 0; i < LAYOUTS.length; i++) if (LAYOUTS[i].id === v) return v;
  return DEFAULT_LAYOUT;
}

function _currentLayout() {
  return _layoutId(document.documentElement.getAttribute("data-layout"));
}

(function () {
  var saved = null;
  try { saved = localStorage.getItem(LAYOUT_STORAGE_KEY); } catch (e) {}
  document.documentElement.setAttribute("data-layout", _layoutId(saved));
})();

// The sidebar band's engine (theme-core.js → createThemeEngine). The
// aria-label is the ONLY place the theme is named: the band carries no
// caption and no marker — the artwork under the centre is the whole of the
// visual answer — so this is not a redundant announcement of something a
// screen reader could reach another way; drop it and the control becomes an
// unlabelled button that changes the page's colours.
var _themeEngine = createThemeEngine({
  track: ".theme-band-track",
  control: ".theme-band",
  onApply: function (t) {
    var bands = document.querySelectorAll(".theme-band");
    for (var i = 0; i < bands.length; i++) {
      bands[i].setAttribute("aria-label", "Time of day: " + t.label + ". Move through the day.");
    }
  },
});

// The shell's long-standing names for the engine's verbs. renderNav seats the
// band after every rebuild of the rail; _setTheme is what the CSS comments and
// brand-logo.js name.
function _setTheme(theme, phase) { _themeEngine.set(theme, phase); }
function _seatThemeBands() { _themeEngine.seat(); }
function advanceTheme() { _themeEngine.advance(); }
window.advanceTheme = advanceTheme;

// Aliases for callers that predate the band. `openThemeMenu` no longer opens
// anything — there is no theme menu to open.
function toggleTheme() { advanceTheme(); }
function openThemeMenu() { advanceTheme(); }

// ─── Current User ────────────────────────────────────────────────────────────
//
// After the dynamic-roles cutover `currentUserRole` carries the role NAME
// (string) for the few surfaces that need role identity (visual badge,
// sidebar polling). All real capability checks consult
// `currentRolePermissions` via the permAtLeast(functionKey, level) helper —
// the canX() back-compat shims have been rewritten to call it so existing
// call sites keep working.
//
// `currentEffectiveRegions` is the union of role.regionTags and user.regionTags.
// Storage-only in v1; consumers (asset/subnet/reservation list filters,
// map view) will read it in a follow-on change.

var currentUserRole = null;          // role name (string)
var currentUserRoleColor = null;     // role.color (#rrggbb) or null
var currentRolePermissions = {};     // { [functionKey]: "none"|"read"|"write"|"fullwrite" }
var currentEffectiveRegions = [];    // string[]
var currentUserRegions = [];         // user.regionTags
var currentUsername = null;
var currentUserAuthProvider = "local"; // "local" | "azure" | "oidc" | "ldap"
// What "auto" resolves to in a server-rendered surface (an alert email), so
// the account menu can SAY so instead of describing it abstractly. Null until
// /auth/me lands.
var currentServerTimezone = null;
// Business rule 128: is IPv6 on for this install? Every IPv6 surface (the
// primary IPv6 line, the Interfaces IPv6 column, observed rows) draws only
// while this is true. False until /auth/me lands — a surface drawn earlier
// simply shows no IPv6, which is the safe answer.
var polarisIpv6Enabled = false;
var polarisIpv6Dialable = false; // IPv6 on AND this server can reach it (rule 128)
var _userReadyResolve = null;
var userReady = new Promise(function (resolve) { _userReadyResolve = resolve; });

async function fetchCurrentUser() {
  try {
    // Raw fetch on purpose (CQ-F026): /auth/me answers 200 { authenticated:false }
    // for a signed-out caller, and api.js's request() would turn any 401 on the
    // way into a /login.html redirect before this boot step could handle it.
    var data = await fetch("/api/v1/auth/me").then(function (r) { return r.json(); });
    if (data.authenticated) {
      currentUserRole = (data.role && data.role.name) || null;
      currentUserRoleColor = (data.role && data.role.color) || null;
      currentRolePermissions = (data.role && data.role.permissions) || {};
      currentUsername = data.username;
      currentUserAuthProvider = data.authProvider || "local";
      currentUserRegions = (data.regionTags && data.regionTags.user) || [];
      currentEffectiveRegions = (data.regionTags && data.regionTags.effective) || [];
      currentServerTimezone = data.serverTimezone || null;
      polarisIpv6Enabled = data.ipv6Enabled === true;
      polarisIpv6Dialable = data.ipv6Dialable === true;
      _tzPref = data.timezone || "auto";
      // Hand the account's zone to the formatters in api.js, which read it
      // synchronously from localStorage at load — this call is what keeps that
      // cache honest when the choice was changed on another device.
      if (typeof setDisplayTimeZone === "function") setDisplayTimeZone(data.timezone);
      reportBrowserTimezone(data.detectedTimezone);
      try {
        localStorage.setItem("polaris-user", JSON.stringify({
          role: currentUserRole,
          roleColor: currentUserRoleColor,
          permissions: currentRolePermissions,
          username: data.username,
          regions: currentEffectiveRegions,
        }));
      } catch (_) {}
    } else {
      try { localStorage.removeItem("polaris-user"); } catch (_) {}
    }
  } catch (_) {}
  if (_userReadyResolve) { _userReadyResolve(); _userReadyResolve = null; }
  return currentUserRole;
}

/**
 * Tell the server what zone this browser is in, so "auto" can mean the
 * operator's own wall clock on a surface that HAS no browser — an alert email.
 *
 * Fire-and-forget, and only when it actually differs from what the server
 * already has: this runs on every page load, so comparing first is what keeps
 * it a write per RELOCATION rather than a write per navigation. A failure is
 * silent by design — the whole point is a boot that never notices this.
 */
function reportBrowserTimezone(known) {
  var tz = null;
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (_) { return; }
  if (!tz || tz === known) return;
  try {
    api.timezone.detected(tz).catch(function () {});
  } catch (_) {}
}

// permAtLeast(functionKey, level) — the canonical capability check.
// none < read < write < fullwrite. Use this for any "can the user do X"
// branch; the canX() shims below are convenience wrappers for the most
// common patterns.
var _PERM_RANK = { none: 0, read: 1, write: 2, fullwrite: 3 };
function permLevel(key) { return currentRolePermissions[key] || "none"; }
function permAtLeast(key, level) {
  return (_PERM_RANK[permLevel(key)] || 0) >= (_PERM_RANK[level] || 0);
}

// Role-name shims — kept for places that genuinely need to know the role
// identity (sidebar admin-only menu items, role-name display badge). DO
// NOT use these for new capability checks — use permAtLeast(key, level).
function isAdmin() { return currentUserRole === "admin"; }

// Capability shims — rewritten to consult the permission matrix. The
// names map to the closest function-key check that matches the old
// hardcoded-role behavior. Custom roles with the relevant grant pass.
function canManageNetworks() { return permAtLeast("subnets", "fullwrite"); }
// Mirrors the server's isAdminEquivalentPermissions (users + roles fullwrite):
// the predicate behind admin-only overrides such as force-deleting a network
// that still holds active reservations.
function isAdminEquivalent() { return permAtLeast("users", "fullwrite") && permAtLeast("roles", "fullwrite"); }
// IP blocks are their OWN function key: POST/PUT/DELETE /blocks gate on
// ipBlocks:write, so the Blocks tab's Add / Edit / Delete must not ride the
// subnets gate above (a subnets:fullwrite role without ipBlocks:write saw
// controls that could only 403, and an ipBlocks:write role never saw them).
function canManageBlocks() { return permAtLeast("ipBlocks", "write"); }
function canManageAssets() { return permAtLeast("assets", "write"); }
// Business rule 141 (e): Read-Write reaches the devices you added or that
// carry one of your tags; Full Read-Write every device. The server says
// which, per row (`canEdit` / `canQuarantine` / `canMaintain` on GET /assets
// and GET /assets/:id), so a verb is offered only where its click succeeds.
// A row without the flag (an older payload, a partial object) is treated as
// reachable — the server is the control either way.
function _scopedVerb(key, flag, a) {
  if (permAtLeast(key, "fullwrite")) return true;
  if (!permAtLeast(key, "write")) return false;
  return !a || a[flag] !== false;
}
function canEditAsset(a) { return _scopedVerb("assets", "canEdit", a); }
function canQuarantineAsset(a) { return _scopedVerb("assetsQuarantine", "canQuarantine", a); }
function canMaintainAsset(a) { return _scopedVerb("maintenanceManagement", "canMaintain", a); }
// Quarantine is its OWN function key, not part of `assets` — a role can manage
// asset records without being allowed to push MAC blocks to FortiGates, and
// (per the built-in matrix) vice versa. Every server route under
// /assets/:id/quarantine* gates on assetsQuarantine, so anything offering those
// verbs in the UI must check this and not canManageAssets(), or the control
// appears for operators whose click can only 403.
function canQuarantineAssets() { return permAtLeast("assetsQuarantine", "write"); }
// Deploying the Polaris Agent is the one act on the `assets` key that reaches
// OUTSIDE Polaris to change a host: it runs an installer over a stored SSH /
// WinRM credential and leaves a service behind. Every agent
// install / retry / reinstall / upgrade / uninstall route (and the bulk
// deploy) is its own key, `agentDeploy`, so anything OFFERING those verbs must
// check this and not canManageAssets() — an assets:write operator keeps full
// inventory editing and gets no dead Install button. Reads (what version is
// installed, which scripts exist) stay at `assets=read`.
function canDeployAgent() { return permAtLeast("agentDeploy", "write"); }
// The other two dangerous acts split off assets / alerts the same day
// (2026-11-03): merging any two records, and clearing an alert.
function canMergeAssets() { return permAtLeast("assetMerge", "write"); }
function canClearAlerts() { return permAtLeast("alertClear", "write"); }
// The tag registry AND putting a tag on any record ride one key, Tags: a
// tag is write reach for everyone who holds it (business rule 141), so
// assigning one is an administrator's act, not part of editing the record.
// Every picker that edits tags asks this; without it the picker is static.
function canManageTags() { return permAtLeast("tags", "write"); }
// Probing is its own key and — since 2026-09-04 — a READ-ONLY one: a probe
// dials the device and writes nothing in Polaris, so `read` IS the grant
// (business rule 43). Anything offering Poll Now / SNMP Walk / a DNS lookup
// must check this rather than isUserOrAbove() or isAdmin(), both of which
// answer a different question: the first showed the button to a role granted
// IP-space writes and nothing on probes (its click could only 403), and the
// second hid it from every custom role that holds the grant.
function canProbeAssets() { return permAtLeast("assetsProbe", "read"); }
// The dependency-down SIMULATION is not a probe — it stamps
// `dependencyTestUntil` and can briefly mask a real outage — so it sits on
// `assetMonitorSettings=fullwrite`, admin-only in every built-in role.
function canSimulateDependencyDown() { return permAtLeast("assetMonitorSettings", "fullwrite"); }
function canManageMaintenance() { return permAtLeast("maintenanceManagement", "write"); }
function isUserOrAbove() { return permAtLeast("subnets", "write") || permAtLeast("reservations", "write"); }
// Rule 141 (f): the Conflicts view is visible at READ — a duplicate-reservation
// conflict is resolved at reservations:write, not discoveryConflicts:write —
// and each card says what THIS caller may do (`canResolve` / `canRelease`).
function canReviewConflicts() { return permAtLeast("discoveryConflicts", "read"); }
function canResolveConflicts() { return permAtLeast("discoveryConflicts", "write"); }
function canReserveIps() { return permAtLeast("reservations", "write"); }
function canCreateNetworks() { return permAtLeast("subnets", "write"); }
// Add Network dialogs: the operator never picks a block — the server places a
// new network in the most specific block containing its CIDR. This fills a
// read-only Block field from the typed CIDR (debounced; the containment math
// stays server-side in src/utils/cidr.ts), so the operator sees where it will
// land before saving. A stale reply (the CIDR changed while it was in flight)
// is dropped rather than painted over the newer answer. The field is a
// preview only; the create response's `block` is what the server chose.
function wireResolvedBlockField(cidrInputId, blockFieldId) {
  var input = document.getElementById(cidrInputId);
  var field = document.getElementById(blockFieldId);
  if (!input || !field) return;
  var timer = null;
  var seq = 0;
  function show(text) { field.value = text; }
  input.addEventListener("input", function () {
    clearTimeout(timer);
    var cidr = input.value.trim();
    if (!cidr) { seq++; show(""); return; }
    timer = setTimeout(async function () {
      var mine = ++seq;
      try {
        var out = await api.subnets.resolveBlock(cidr);
        if (mine !== seq) return;
        show(out && out.block
          ? out.block.name + " (" + out.block.cidr + ")"
          : (cidr.indexOf("/") < 0 ? "" : "No block contains this network"));
      } catch (_) {
        if (mine === seq) show("");
      }
    }, 250);
  });
}

function canEditSubnet(subnet) {
  if (permAtLeast("subnets", "fullwrite")) return true;
  if (!permAtLeast("subnets", "write")) return false;
  // Rule 141 (e): the server judges own-or-tagged per row (`canEdit`); the
  // creator comparison is the fallback for a row that lacks the flag.
  if (subnet && typeof subnet.canEdit === "boolean") return subnet.canEdit;
  return !!(subnet && subnet.createdBy && subnet.createdBy === currentUsername);
}
// Credentials carry the ownership dimension: write = your own rows only,
// fullwrite = any row. A null createdBy is UNOWNED (rows predating the
// column) and reachable only at fullwrite — same rule the server's
// assertOwnership applies, so the button and the route agree.
function canEditCredential(cred) {
  if (permAtLeast("credentials", "fullwrite")) return true;
  if (!permAtLeast("credentials", "write")) return false;
  return !!(cred && cred.createdBy && cred.createdBy === currentUsername);
}
function canEditReservation(reservation) {
  if (permAtLeast("reservations", "fullwrite")) return true;
  if (!permAtLeast("reservations", "write")) return false;
  if (reservation && typeof reservation.canEdit === "boolean") return reservation.canEdit;
  return !!(reservation && reservation.createdBy && reservation.createdBy === currentUsername);
}

// ─── Discovery-source vocabulary ─────────────────────────────────────────────
// AssetSource.sourceKind -> the name an operator reads. Lives here rather than
// on the Assets page because three surfaces render it: the asset Sources tab,
// the merge modal's comparison, and the duplicate-IP conflict card — and the
// last two are reachable from the Events page, which does not load assets.js.
// A kind with no entry falls through to the raw string, which is readable
// enough that a new integration is never blocked on updating this map.
var _assetSourceLabels = {
  "entra":              "Microsoft Entra ID",
  "intune":             "Microsoft Intune",
  "ad":                 "Active Directory",
  "fortigate-firewall": "FortiGate (firewall)",
  "fortiswitch":        "FortiSwitch",
  "fortiap":            "FortiAP",
  "fortigate-endpoint": "FortiGate / FortiManager (endpoint)",
  "snmp-sysdescr": "Device self-report (SNMP sysDescr)",
  "snmp-identity": "Device self-report (SNMP sysName + ENTITY-MIB)",
  "snmp-profile":  "Device self-report (manufacturer profile over SNMP)",
  "fortinet-live":      "Device self-report (FortiOS firmware)",
  "vcenter-vm":         "VMware vCenter (VM)",
  "vcenter-host":       "VMware vCenter (ESXi host)",
  "arc":                "Azure Arc",
  "arc-k8s":            "Azure Arc (Kubernetes)",
  "polaris-agent":      "Polaris Agent",
  "manual":             "Manual / other",
};

// ─── Sidebar Navigation ──────────────────────────────────────────────────────

// `perm` hides the entry unless the role holds that function key at that
// level; `anyPerm` hides it unless AT LEAST ONE of the listed pairs holds —
// which is what a multi-tab page needs (IPAM is IP Blocks + Networks, and a
// role granted only one of them still has somewhere to land; `reservations`
// is deliberately NOT in IPAM's set — a reservation is only reachable through
// its subnet's IP panel, so subnets:read is what makes the page usable).
// Every entry whose page can 403 needs one of the two: without it the sidebar
// advertises a page whose first fetch is the only thing that tells the
// operator they can't be there. Dashboard is deliberately ungated — its
// routes carry no permission gate and it's the post-login landing page.
const NAV_ITEMS = [
  { href: "/",                label: "Dashboard",    icon: "layoutDashboard" },
  { href: "/map.html",        label: "Device Map",   icon: "network", perm: ["deviceMap", "read"] },
  { href: "/appmap.html",     label: "Application Map", icon: "workflow", perm: ["applicationMap", "read"] },
  // Agent-run path checks. Gate in lockstep with pageRequiredPermission
  // in src/app.ts.
  { href: "/path-monitor.html", label: "Path Monitor", icon: "route", perm: ["pathChecks", "read"] },
  { href: "/ipam.html",       label: "IP Management", icon: "blocks", anyPerm: [["ipBlocks", "read"], ["subnets", "read"]] },
  { href: "/assets.html",         label: "Assets",       icon: "monitor", perm: ["assets", "read"] },
  { href: "/events.html",         label: "Events",       icon: "activity", perm: ["events", "read"] },
  { href: "/automations.html", label: "Automations", icon: "bot", perm: ["automationManagement", "read"] },
  // Was gated on canManageNetworks() (subnets:fullwrite) — the wrong key
  // entirely: a role granted integrations couldn't see the page, and a role
  // granted IP space but not integrations saw it and 403'd. No built-in role
  // changes hands (readonly/user/assetsadmin hold integrations:none, and
  // networkadmin holds :write).
  { href: "/integrations.html",  label: "Integrations", icon: "plug", perm: ["integrations", "read"] },
  { href: "/users.html",        label: "Users",        icon: "shieldUser", adminOnly: true },
];

// Last known push status + the account's notification preference, plus an
// in-flight guard. Module-level because the control is rebuilt from scratch
// every time the user menu opens — there is no long-lived button to repaint,
// so the state has to outlive the menu.
var _pushState = null;
var _pushBusy = false;
var _notifPref = null;

// renderNav (and with it wireNotificationPrefs) runs twice on a cold cache —
// once off the cached user, once after /auth/me lands. One enrollment offer
// per page load, checked at most once.
var _pushOfferHandled = false;

// The three answers to "how do you want to be alerted", in menu order. Kept
// here rather than fetched from GET /me/notification-preference's `options`
// so the menu can be built the instant the preference resolves — the server
// still owns the vocabulary, and an unknown value simply renders as itself.
var NOTIF_PREF_LABELS = { email: "Email", push: "Push", any: "Email and push" };
var NOTIF_PREF_ORDER = ["email", "push", "any"];

// The account's display timezone, from /auth/me. Module-level for the same
// reason _notifPref is: the account menu is rebuilt from scratch on every open,
// so the current value has to outlive the menu. Null until /auth/me lands.
var _tzPref = null;
// The zone list, fetched ONCE and only when the picker is first opened — it is
// the whole IANA database (~400 names) and no page needs it to render.
var _tzOptions = null;

// Last known TOTP enrollment state for the account menu's two-factor row, and
// a one-per-page-load fetch guard. Same reason as _pushState: the row is built
// fresh every time the menu opens, so there's no control to repaint.
var _totpState = null;
var _totpFetched = false;

// The same arrangement for the passkey row: one fetch per page load, read when
// the menu is built. Kept apart from _totpState because the two answer
// different questions — this one also carries whether the INSTALL offers
// passkeys at all, which no TOTP payload knows.
var _passkeyState = null;
var _passkeyFetched = false;

/**
 * Notification preference + push enrollment for the user menu.
 *
 * There is no "enable push" switch any more, because enrollment is not a
 * decision — it is the CONSEQUENCE of one. The operator says how they want to
 * be alerted (Email / Push / both), that answer is stored on the ACCOUNT, and
 * every browser they sign in on reconciles its own subscription to it here.
 * Which is the whole point: a switch flipped on a laptop reached exactly that
 * laptop, so "I turned push on" and "my phone buzzes" were different facts.
 *
 * Gated on alerts:read, which is what the push routes themselves require —
 * pushSubscriptions.ts states the intent outright ("any viewer may opt into
 * push"). The user menu renders on every page, so the control is reachable
 * from anywhere; the old one lived on /automations.html, which a role with
 * alerts but no automation management could not even open.
 *
 * Registering the worker here (rather than lazily) means the push handler is
 * live on every page for anyone already enrolled, and syncToPreference repairs
 * a rotated endpoint on the way past.
 */
function wireNotificationPrefs() {
  if (!permAtLeast("alerts", "read")) return;
  if (!window.polarisPush || !polarisPush.isSupported()) {
    // No push in this browser at all — the preference is still the account's
    // and still editable here; this device simply can't be one of its targets.
    Promise.resolve()
      .then(function () { return api.push.preference(); })
      .then(function (r) { _notifPref = (r && r.preference) || "email"; })
      // Same fallback as the supported branch below: a failed read must still
      // leave a row the operator can SET the preference from, since a hidden
      // row is indistinguishable from "this account has no such setting".
      .catch(function () { _notifPref = _notifPref || "email"; });
    return;
  }

  polarisPush.registerSW().catch(function () { /* push is optional */ });

  // Wrapped rather than called bare: this runs inside the sidebar render, so
  // a synchronous throw here would take the navigation down with it. A
  // notification preference is never worth that.
  Promise.resolve()
    .then(function () { return api.push.preference(); })
    .then(function (r) {
      _notifPref = (r && r.preference) || "email";
      // Enroll or un-enroll THIS browser to match. Silent by design: it never
      // prompts (no user activation at boot), so a browser that has never been
      // asked simply stays un-enrolled and the menu row says so.
      return polarisPush.syncToPreference(_notifPref, "desktop");
    })
    .catch(function () { _notifPref = _notifPref || "email"; })
    .then(function () {
      return polarisPush.status().then(function (st) { _pushState = st || null; }).catch(function () {});
    })
    // Status first, so the offer can answer "does the server even do push?"
    // from the reading already in hand instead of fetching the key again.
    .then(function () { return _maybeOfferPushEnrollment(); });
}

/**
 * Ask a browser that has never been asked whether it should receive push.
 *
 * The reconcile above enrolls this browser silently when permission is already
 * granted — which is every browser that has enrolled before. A browser signing
 * in for the first time sits at permission "default", and nothing may enroll
 * it without the permission prompt, which needs live user activation. Without
 * this, an operator whose account prefers push had to go and re-pick the
 * preference from the account menu on every new laptop, browser profile or
 * re-install, and nothing told them so: the alert simply never arrived there.
 *
 * Asked once per account per browser (polarisPush records it), and inside the
 * alerts:read gate wireNotificationPrefs already applies — the push routes
 * themselves say any viewer may opt into push.
 */
function _maybeOfferPushEnrollment() {
  if (_pushOfferHandled) return;
  if (!window.polarisPush || !polarisPush.shouldOfferEnrollment) return;
  _pushOfferHandled = true;
  return polarisPush
    .shouldOfferEnrollment(_notifPref, { username: currentUsername, status: _pushState })
    .then(function (offer) { if (offer) _openPushOfferDialog(); })
    .catch(function () { /* an offer nobody asked for is never worth an error */ });
}

/**
 * The offer itself.
 *
 * Recorded as made the moment it opens rather than when a button is clicked.
 * openModal's other exits — the X, a click on the scrim, Escape — hand back no
 * callback, and an offer that reopens on every page navigation until it is
 * answered through one specific button is a nag. So: asked once, however it
 * ends, and the body says where to go afterwards.
 *
 * enable() is called as the FIRST statement of the click handler, before
 * closeModal and before any await, because Notification.requestPermission()
 * needs the click's transient user activation and Safari drops it across an
 * await — the same ordering rule as _chooseNotifPref and push.js's enable().
 */
function _openPushOfferDialog() {
  if (typeof openModal !== "function") return;
  var body =
    '<p style="font-size:0.9rem;color:var(--color-text-primary);margin:0 0 0.75rem">' +
      'Your account is set to be notified by ' +
      escapeHtml((NOTIF_PREF_LABELS[_notifPref] || _notifPref).toLowerCase()) +
      ', but this browser has never been enrolled. Turn push notifications on here?' +
    '</p>' +
    '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin:0">' +
      'Your browser will ask for permission. You can turn push on or off at any time from ' +
      'the Notifications row in your account menu.' +
    '</p>';
  var footer =
    '<button class="btn btn-secondary" id="push-offer-dismiss">Not now</button>' +
    '<button class="btn btn-primary" id="push-offer-enable">Enable</button>';
  openModal("Push notifications", body, footer);
  polarisPush.recordOfferMade(currentUsername);

  var dismissBtn = document.getElementById("push-offer-dismiss");
  if (dismissBtn) dismissBtn.onclick = function () { closeModal(); };

  var enableBtn = document.getElementById("push-offer-enable");
  if (!enableBtn) return;
  enableBtn.onclick = function () {
    var enrolling = polarisPush.enable({ surface: "desktop" });
    closeModal();
    enrolling.then(function () {
      if (typeof showToast === "function") showToast("Push notifications are on for this browser", "success");
    }, function (err) {
      if (typeof showToast === "function") {
        showToast((err && err.message) || "This browser refused push notifications.", "warning");
      }
    }).then(function () {
      return polarisPush.status().then(function (st) { _pushState = st || null; }).catch(function () {});
    });
  };
}

/**
 * The user menu's notification row: what this account currently prefers, and a
 * way into the three choices. Null only for a role below alerts:read or before
 * the preference has resolved — a row that named the wrong current setting
 * would be worse than a row that isn't there yet.
 */
function _notifPrefMenuItem(anchor) {
  if (!permAtLeast("alerts", "read")) return null;
  if (!_notifPref) return null;
  return {
    label: "Notifications: " + (NOTIF_PREF_LABELS[_notifPref] || _notifPref),
    icon: ICONS.bell,
    onSelect: function () { _openNotifPrefMenu(anchor); },
  };
}

/**
 * The user menu's timezone row.
 *
 * Unlike the notification row this has NO permission gate: what zone a
 * timestamp is drawn in changes nothing about which data an account can reach,
 * so gating it on any function key would leave some legitimate signed-in user
 * unable to fix their own clock. It matches the route, which is authenticated
 * only.
 *
 * Labelled with the resolved answer rather than the literal "auto", because
 * "Automatic" alone doesn't tell the operator what their EMAIL will say — and
 * that surface is the reason the setting exists.
 */
function _tzMenuItem() {
  if (!_tzPref) return null;
  var label = _tzPref === "auto" ? "Automatic" : _tzPref;
  return {
    label: "Timezone: " + label,
    icon: ICONS.clock,
    onSelect: function () { _openTimezoneModal(); },
  };
}

/**
 * The user menu's layout row. No permission gate and no async state: it is a
 * display preference held in this browser, so it always renders, labelled with
 * the layout in force.
 */
function _layoutMenuItem(anchor) {
  var cur = _currentLayout();
  var label = cur;
  for (var i = 0; i < LAYOUTS.length; i++) if (LAYOUTS[i].id === cur) label = LAYOUTS[i].label;
  return {
    label: "Layout: " + label,
    icon: ICONS.monitor,
    onSelect: function () { _openLayoutMenu(anchor); },
  };
}

/**
 * The three-way layout chooser, opened on the same anchor once the account
 * menu has closed (showRowMenu closes before it runs a handler) — the same
 * shape as the notification-preference chooser.
 */
function _openLayoutMenu(anchor) {
  if (typeof showRowMenu !== "function") return;
  var cur = _currentLayout();
  var items = LAYOUTS.map(function (l) {
    return {
      label: l.label + (l.id === cur ? "  ✓" : ""),
      title: l.title,
      onSelect: function () { _setLayout(l.id); },
    };
  });
  showRowMenu(anchor, items, { label: "Page layout", align: "end" });
}

// Applies live: the shell width and the slide-over offset both read the CSS
// token, so an open panel moves with the column and nothing needs a reload.
function _setLayout(id) {
  id = _layoutId(id);
  document.documentElement.setAttribute("data-layout", id);
  try { localStorage.setItem(LAYOUT_STORAGE_KEY, id); } catch (e) {}
}

/**
 * The zone picker. A modal with a native <select> rather than the row-menu
 * chooser the notification preference uses: that one has three options and
 * this one has the whole tz database, which a menu cannot show and a native
 * select can (it scrolls, and type-ahead finds a zone by name).
 */
function _openTimezoneModal() {
  if (typeof openModal !== "function") return;
  var loading = _tzOptions ? "" : '<div class="muted">Loading zones…</div>';
  openModal(
    "Display timezone",
    '<div class="form-group"><label for="tz-select">Show times in</label>' +
      '<select id="tz-select"' + (_tzOptions ? "" : " disabled") + '></select></div>' +
      loading +
      '<div class="muted" style="margin-top:10px;font-size:12px" id="tz-hint"></div>',
    '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
      '<button class="btn btn-primary" id="tz-save">Save</button>',
  );

  var hint = document.getElementById("tz-hint");
  if (hint) {
    // Deliberately says what this does NOT cover. An alert email is one message
    // to everyone the automation names (business rule 25), so it is written on
    // the install's clock and names the zone in its footer — this setting moves
    // the UI and nothing else, and an operator who expects otherwise will
    // reasonably read a 3-hour gap as a bug.
    hint.textContent = currentServerTimezone
      ? 'Automatic follows this browser. Times in alert emails are not affected — an alert is one ' +
        'message to everyone it names, so it is written in the server timezone (' + currentServerTimezone +
        ') and says so in its footer.'
      : 'Automatic follows this browser. Times in alert emails are not affected — an alert is one ' +
        'message to everyone it names, so it is written in the server timezone and says so in its footer.';
  }

  var save = document.getElementById("tz-save");
  if (save) {
    save.addEventListener("click", function () {
      var sel = document.getElementById("tz-select");
      if (!sel || sel.disabled) return;
      _saveTimezone(sel.value);
    });
  }

  var fill = function (zones) {
    _tzOptions = zones;
    var sel = document.getElementById("tz-select");
    if (!sel) return; // modal closed while the list was in flight
    var opts = ['<option value="auto">Automatic (this browser)</option>'];
    for (var i = 0; i < zones.length; i++) {
      opts.push('<option value="' + escapeHtml(zones[i]) + '">' + escapeHtml(zones[i]) + "</option>");
    }
    sel.innerHTML = opts.join("");
    sel.value = _tzPref || "auto";
    // A stored zone this build no longer lists would otherwise leave the
    // select on its first entry, so Save would silently change the setting.
    if (sel.value !== (_tzPref || "auto")) {
      sel.insertAdjacentHTML("afterbegin",
        '<option value="' + escapeHtml(_tzPref) + '">' + escapeHtml(_tzPref) + " (current)</option>");
      sel.value = _tzPref;
    }
    sel.disabled = false;
    var l = document.querySelector(".modal-body .muted");
    if (l && l.textContent === "Loading zones…") l.remove();
  };

  if (_tzOptions) { fill(_tzOptions); return; }
  api.timezone.get()
    .then(function (r) { fill((r && r.options) || []); })
    .catch(function () {
      var sel = document.getElementById("tz-select");
      if (sel) sel.innerHTML = '<option value="auto">Automatic (this browser)</option>';
      if (sel) sel.disabled = false;
      showToast("Couldn't load the timezone list", "error");
    });
}

/**
 * Persist a chosen zone and repaint.
 *
 * A full reload rather than a re-render: absolute times are formatted at render
 * time all over the app (tables, charts, slide-overs, cached widget HTML), and
 * there is no repaint hook that reaches all of them. Reloading is the only
 * thing that guarantees the operator doesn't end up reading half a page in the
 * old zone.
 */
function _saveTimezone(tz) {
  api.timezone.set(tz)
    .then(function (r) {
      _tzPref = (r && r.timezone) || tz;
      if (typeof setDisplayTimeZone === "function") setDisplayTimeZone(_tzPref);
      closeModal();
      window.location.reload();
    })
    .catch(function (err) {
      showToast((err && err.message) || "Couldn't save the timezone", "error");
    });
}

/**
 * The three-way chooser, opened from the account menu against the same anchor
 * (the showRowMenu pattern). A menu-item click is real user activation, so
 * picking "Push" here CAN raise the browser's permission prompt — which is
 * exactly why the choice lives in a menu rather than in a dialog with a Save
 * button several awaits away from the click.
 */
function _openNotifPrefMenu(anchor) {
  if (typeof showRowMenu !== "function") return;
  // Only the server having no Web Push channel makes the push options
  // pointless. An unsupported or permission-denied BROWSER does not: the
  // preference belongs to the account, and the operator's phone may well be
  // able to receive what this laptop can't.
  var pushOffered = !_pushState || _pushState.enabledOnServer !== false;
  var items = NOTIF_PREF_ORDER.map(function (pref) {
    var wantsPush = pref !== "email";
    var blocked = wantsPush && !pushOffered;
    return {
      label: NOTIF_PREF_LABELS[pref] + (pref === _notifPref ? "  ✓" : ""),
      disabled: blocked,
      title: blocked
        ? "Web Push isn't configured on this server — an admin sets it up on Automations → Delivery."
        : undefined,
      onSelect: function () { _chooseNotifPref(pref); },
    };
  });
  showRowMenu(anchor, items, { label: "Notification preference" });
}

/**
 * Apply a chosen preference: enroll this browser first (while the click's
 * activation is still live), then persist.
 *
 * NEVER await before enable() — awaiting burns the click's transient user
 * activation and Safari then refuses the permission prompt. That is why this
 * branches off the cached _pushState instead of re-reading status(); see the
 * ordering comment in push.js.
 *
 * The preference is SAVED even when this browser refuses the prompt. It is an
 * account-wide answer, and the operator's other devices may honour it — so
 * the toast says what happened here rather than the save silently not
 * happening.
 */
function _chooseNotifPref(pref) {
  if (_pushBusy || pref === _notifPref) return;
  _pushBusy = true;
  var wantPush = pref === "push" || pref === "any";
  var needPrompt = wantPush && window.polarisPush && polarisPush.isSupported() &&
    _pushState && _pushState.permission !== "granted";

  // First, synchronously, while the click still counts.
  var enroll = needPrompt
    ? polarisPush.enable({ surface: "desktop" }).then(function () { return null; },
        function (err) { return (err && err.message) || "This browser refused push notifications."; })
    : Promise.resolve(null);

  enroll.then(function (enrollErr) {
    return api.push.setPreference(pref).then(function () {
      _notifPref = pref;
      // Reconcile whatever the enrollment attempt left behind — in
      // particular, switching to Email must un-enroll this browser.
      return (window.polarisPush && polarisPush.isSupported()
        ? polarisPush.syncToPreference(pref, "desktop")
        : Promise.resolve("")
      ).then(function () {
        if (typeof showToast !== "function") return;
        if (enrollErr) showToast("Preference saved: " + NOTIF_PREF_LABELS[pref] + ". " + enrollErr, "warning");
        else showToast("Notifications: " + NOTIF_PREF_LABELS[pref], "success");
      });
    });
  }).catch(function (err) {
    if (typeof showToast === "function") showToast((err && err.message) || "Couldn't save your notification preference", "error");
  }).then(function () {
    _pushBusy = false;
    if (!window.polarisPush || !polarisPush.isSupported()) return;
    return polarisPush.status().then(function (st) { _pushState = st || null; }).catch(function () {});
  });
}

/**
 * Two-factor (TOTP) enrollment state for the user menu's row.
 *
 * Fetched once per page load — the account menu is the only surface that
 * reads it, and it's rebuilt per open. Deliberately NOT gated on
 * `currentUserAuthProvider`: renderNav also runs off the localStorage cache,
 * which doesn't carry the provider (it defaults to "local"), so the row gates
 * on the status payload's OWN authProvider instead. That's also the value the
 * /auth/totp/* routes enforce against, so the menu can't offer a control the
 * server will refuse.
 */
function wireTotpState() {
  if (_totpFetched) return;
  if (!window.PolarisTotpSelf || !window.api || !api.totp) return;
  _totpFetched = true;
  PolarisTotpSelf.status()
    .then(function (st) { _totpState = st || null; })
    .catch(function () { _totpState = null; });
}

/**
 * The user menu's change-password row, or null when it isn't on offer.
 *
 * Gated on the SAME payload the two-factor row reads — `/auth/totp/status`
 * returns the account's `authProvider`, and one fetch driving both rows beats
 * a second round trip that answers the identical question. The reason it is
 * not `currentUserAuthProvider` is the one wireTotpState gives above: the
 * cached-nav path defaults that to "local", which would offer an SSO user a
 * control the server refuses with "managed by your identity provider".
 *
 * Local accounts get this here for the same reason they get TOTP here:
 * /users.html holds the only other password field in the product and is
 * page-gated `users`, so an ordinary local user had nowhere to change their
 * own password even though `PUT /auth/password` asks for no permission at all.
 */
function _changePasswordMenuItem() {
  if (!window.PolarisPasswordSelf) return null;
  if (!_totpState || _totpState.authProvider !== "local") return null;
  return {
    label: "Change password",
    icon: ICONS.key,
    title: "Requires your current password",
    onSelect: function () { PolarisPasswordSelf.open({ username: currentUsername }); },
  };
}

/**
 * The user menu's two-factor row, or null when it isn't on offer: no shared
 * module on the page, state not read yet, or an SSO/LDAP account whose
 * directory owns MFA (the enroll route rejects those outright).
 *
 * Local accounts get a self-service second factor here because /users.html —
 * where this flow used to live exclusively — is admin-gated, so an ordinary
 * local user could never reach it despite the routes being self-service.
 */
function _totpMenuItem() {
  if (!window.PolarisTotpSelf) return null;
  if (!_totpState || _totpState.authProvider !== "local") return null;

  var label, title;
  if (_totpState.enabled) {
    label = "Disable two-factor auth";
    title = "Requires a current authenticator code or a backup code"
      + (_totpState.backupCodesRemaining ? " (" + _totpState.backupCodesRemaining + " backup codes left)" : "");
  } else if (_totpState.enrolling) {
    // A secret was minted but never confirmed — enroll() re-issues one, so
    // the row resumes the flow rather than pretending nothing happened.
    label = "Finish two-factor setup";
    title = "Enrollment was started but never confirmed";
  } else {
    label = "Set up two-factor auth";
    title = "Add an authenticator-app code to your login";
  }
  return { label: label, icon: ICONS.shield, title: title, onSelect: _openTotpSelf };
}

/**
 * Re-read enrollment state so the row relabels after the flow changed it.
 * Exposed because /users.html hosts the same flow off its own row menu — the
 * cached row would otherwise still read "Set up two-factor auth" on the page
 * where the operator just enabled it.
 */
function refreshTotpState() {
  if (!window.PolarisTotpSelf) return;
  PolarisTotpSelf.status()
    .then(function (st) { _totpState = st || null; })
    .catch(function () {});
}

/** Open the enroll/disable flow, refreshing the cached row state after. */
function _openTotpSelf() {
  PolarisTotpSelf.open({ onChange: refreshTotpState });
}

/**
 * Passkey state for the user menu's row. One fetch per page load, same
 * arrangement as wireTotpState — and the same reason it is not gated on
 * `currentUserAuthProvider`: the cached-nav path defaults that to "local".
 */
function wirePasskeyState() {
  if (_passkeyFetched) return;
  if (!window.PolarisPasskeys || !window.api || !api.auth) return;
  _passkeyFetched = true;
  PolarisPasskeys.summary()
    .then(function (st) { _passkeyState = st || null; })
    .catch(function () { _passkeyState = null; });
}

/** Re-read passkey state so the row's count relabels after the flow changed it. */
function refreshPasskeyState() {
  if (!window.PolarisPasskeys) return;
  PolarisPasskeys.summary()
    .then(function (st) { _passkeyState = st || null; })
    .catch(function () {});
}

/**
 * The user menu's passkey row, or null when it isn't on offer.
 *
 * Three ways it stays hidden: no shared module on the page, an SSO/LDAP
 * account (whose provider owns credentials), or an install where passkeys are
 * switched off AND this user has none — someone holding credentials from
 * before the switch still gets the row, because removing them is the one thing
 * they might now want to do.
 */
function _passkeyMenuItem() {
  if (!window.PolarisPasskeys) return null;
  if (!_passkeyState || _passkeyState.authProvider !== "local") return null;

  var availability = _passkeyState.availability || {};
  var off = availability.mode === "off";
  if (off && !_passkeyState.count) return null;

  var label = _passkeyState.count
    ? "Passkeys (" + _passkeyState.count + ")"
    : "Set up a passkey";
  var title = off
    ? "Passkeys are disabled on this install — you can still remove the ones you registered"
    : (availability.unavailableReason
      ? availability.unavailableReason
      : "Sign in with this device's PIN, fingerprint or face instead of a password");
  return {
    label: label,
    icon: ICONS.key,
    title: title,
    onSelect: function () { PolarisPasskeys.open({ onChange: refreshPasskeyState }); },
  };
}

const ICONS = {
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
  mapPin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  layers: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>',
  monitor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect class="ac" x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
  // The pulse's accent is a gradient, not a whole shape: red at the spike
  // tips (y 3 and 21), the entry's own colour across the baseline at y 12.
  // Only the active entry points its stroke at it (styles.css → .ac-tips).
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><defs><linearGradient id="ac-activity-tips" gradientUnits="userSpaceOnUse" x1="0" y1="3" x2="0" y2="21"><stop offset="0.25" style="stop-color:var(--color-brand-red)"/><stop offset="0.45" style="stop-color:currentColor"/><stop offset="0.55" style="stop-color:currentColor"/><stop offset="0.75" style="stop-color:var(--color-brand-red)"/></linearGradient></defs><polyline class="ac-tips" points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
  plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path class="ac" d="M18 8v5a6 6 0 01-12 0V8h12z"/></svg>',
  users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3L21 2"/><path d="M17 6l3 3"/><path d="M14 9l3 3"/></svg>',
  globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  share2: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
  zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  // Sidebar icons. The shape marked class="ac" is stroked in brand red
  // when its nav entry is the active page (styles.css → .sidebar-nav a.active .ac).
  layoutDashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect class="ac" x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/></svg>',
  network: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect class="ac" x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/></svg>',
  workflow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect class="ac" x="3" y="3" width="8" height="8" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect x="13" y="13" width="8" height="8" rx="2"/></svg>',
  route: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle class="ac" cx="18" cy="5" r="3"/></svg>',
  blocks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect class="ac" x="8" y="2" width="8" height="5" rx="1"/><rect x="2" y="17" width="6" height="5" rx="1"/><rect x="9" y="17" width="6" height="5" rx="1"/><rect x="16" y="17" width="6" height="5" rx="1"/><path d="M12 7v10M5 17v-3h14v3"/></svg>',
  bot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="10" rx="2"/><circle class="ac" cx="12" cy="5" r="2"/><path class="ac" d="M12 7v4"/><line x1="8" y1="16" x2="8.01" y2="16"/><line x1="16" y1="16" x2="16.01" y2="16"/></svg>',
  shieldUser: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><circle class="ac" cx="12" cy="9" r="2.5"/><path class="ac" d="M8 16a4 4 0 0 1 8 0"/></svg>',
  // Round caps are load-bearing: the dot is a 0.01-long line, invisible
  // under butt caps, which left a bare curl instead of a question mark.
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle class="ac" cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 01-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>',
};

function renderNav() {
  const current = window.location.pathname;
  const sidebar = document.getElementById("sidebar");
  if (!sidebar) return;

  const visibleItems = NAV_ITEMS.filter(function (item) {
    if (item.adminOnly) return isAdmin();
    if (item.perm) return permAtLeast(item.perm[0], item.perm[1]);
    if (item.anyPerm) {
      return item.anyPerm.some(function (pair) { return permAtLeast(pair[0], pair[1]); });
    }
    return true;
  });

  // The strip's art URL, versioned so it paints from cache (see _brandArtUrl).
  var bandSrc = _brandArtUrl(THEME_BAND_ART);
  sidebar.innerHTML = `
    <div class="sidebar-brand">
      <img alt="" class="sidebar-logo brand-mark brand-mark-sidebar" decoding="sync" style="visibility:hidden">
      <h1 style="font-size:1.1rem;font-weight:600;margin:0.5rem 0 0;color:var(--color-text-primary);text-align:center;visibility:hidden;display:none">Polaris</h1>
      <p style="font-size:0.78rem;color:var(--color-text-tertiary);margin:0.15rem 0 0;text-align:center;visibility:hidden">Network Management Tool</p>
    </div>
    <ul class="sidebar-nav">
      ${visibleItems.map(item => {
        let isActive = current === item.href || (item.href === "/" && (current === "/index.html" || current === "/"));
        // IPAM absorbs the legacy /blocks.html and /subnets.html surfaces;
        // mark the IPAM entry active when the user is on those URLs (they
        // get redirected by the express layer but the active class needs
        // to match either form pre-redirect on hard reloads).
        if (item.href === "/ipam.html" && (current === "/blocks.html" || current === "/subnets.html")) {
          isActive = true;
        }
        let dot = "";
        if (item.href === "/events.html") {
          // Single sidebar alert dot. Lives only on Events — the page whose
          // Alerts panel holds conflicts, the push queue and stale
          // reservations. Red for a pending conflict or a failed push, yellow
          // for stale reservations or pushes still retrying; red takes
          // precedence (see refreshConflictDot). There is intentionally no
          // second dot.
          dot = '<span class="nav-conflict-dot" id="nav-conflict-dot" style="display:none"></span>';
        }
        return `<li><a href="${item.href}" class="${isActive ? "active" : ""}">${ICONS[item.icon]}<span>${item.label}</span>${dot}</a></li>`;
      }).join("")}
    </ul>
    <div style="margin-top:auto">
      <div id="role-review-status" class="query-status role-review-status" style="display:none"></div>
      <div id="integration-failed-status" class="query-status integration-failed-status" style="display:none"></div>
      <div id="fmg-proxy-advice" class="query-status fmg-proxy-advice" style="display:none"></div>
      <div id="signing-failure-alert" class="query-status signing-failure-alert" style="display:none"></div>
      <div id="platform-advisory-alert" style="display:none"></div>
      <div id="update-status" class="query-status update-status" style="display:none"></div>
      <div id="query-status" class="query-status" style="display:none"></div>
      <div id="capacity-critical-alert" class="capacity-critical-alert" style="display:none"></div>
      ${(isAdmin() || canManageAssets() || permAtLeast("credentials", "write") || permAtLeast("firmware", "read")) ? `<div style="padding:0.5rem 0.5rem 0;border-top:1px solid var(--color-border-light)">
        <a href="/server-settings.html" class="sidebar-bottom-link${current === '/server-settings.html' ? ' active' : ''}">${ICONS.settings}<span>Server Settings</span></a>
      </div>` : ''}
      <!-- The theme band sits here, below Server Settings and above the
           version line. Push enrollment and logout stay in the user menu
           behind the page-header badge (renderUserBadge) — push in
           particular must stay reachable for an alerts:read role that cannot
           open /automations.html, where the only enrollment control once
           lived. The padding/border pair depends on whether the Server
           Settings block above rendered: without it this block owns the
           separator from the nav.

           One click steps to the next theme and the band travels to bring that
           theme's hour to the CENTRE of the window; noon → nightfall fades
           through the afternoon waypoint on the way. No menu opens. The click
           is handled by the delegated listener next to advanceTheme() — do NOT
           wire one here as well, or a click advances two steps.

           Deliberately bare: no caption naming the theme and no centre marker.
           The artwork under the middle of the window is the whole of the
           visual answer, which is why the aria-label is the only place the
           theme is named and must stay (and must keep being repainted by
           _setTheme) — without it this is an unlabelled button that changes
           every colour on the page. NOTE this comment lives inside a template
           literal: a backtick anywhere in it ends the string, and the page
           dies on a SyntaxError with the sidebar never rendering at all.

           The art is repeated THREE times on purpose — the track is anchored
           one strip width left of centre, so copies one and three cover
           the window on either side at every position a leg can reach, and
           travelling off the end of one copy lands on identical pixels in the
           next (which is what lets the JS subtract a strip width unseen). Two
           copies leave bare surface beside the art just before the seam is
           normalised away. The track carries NO position here: it has to be
           measured against the rendered art, so _seatThemeBands() below is
           what places it once this markup is in the document. -->
      <div style="padding:${(isAdmin() || canManageAssets()) ? '0.25rem' : '0.5rem'} 0.5rem 0.5rem;${(isAdmin() || canManageAssets()) ? '' : 'border-top:1px solid var(--color-border-light);'}">
        <button type="button" id="btn-theme-band" class="theme-band" aria-label="Time of day: ${_getTheme(_getCurrentTheme()).label}. Move through the day.">
          <span class="theme-band-window">
            <span class="theme-band-track" id="theme-band-track">
              <img src="${bandSrc}" width="${THEME_BAND_ART_W}" height="${THEME_BAND_ART_H}" decoding="sync" alt="" draggable="false">
              <img src="${bandSrc}" width="${THEME_BAND_ART_W}" height="${THEME_BAND_ART_H}" decoding="sync" alt="" draggable="false">
              <img src="${bandSrc}" width="${THEME_BAND_ART_W}" height="${THEME_BAND_ART_H}" decoding="sync" alt="" draggable="false">
            </span>
          </span>
        </button>
      </div>
      <div id="sidebar-version" style="padding:0 0.75rem 0.75rem;text-align:center;font-size:0.7rem;color:var(--color-text-tertiary);letter-spacing:0.02em"></div>
    </div>
  `;


  // The band has to be placed AFTER the markup lands, not interpolated into
  // it: its position is measured against the rendered width of the artwork,
  // which depends on the band's height and the display's pixel ratio and is
  // unknowable while this is still a string. renderNav also rebuilds the whole
  // rail, so every re-render hands the band painter a brand-new track that has
  // never been positioned — an unseated one sits at the strip's left edge and
  // the next click travels from there instead of from the theme showing.
  _seatThemeBands();

  wireNotificationPrefs();
  wireTotpState();
  wirePasskeyState();

  // Wire up query status indicator
  _onQueriesChanged = renderQueryStatus;

  // Every sidebar poller rides this instead of a bare setInterval: a
  // backgrounded tab stops asking (appmap.js's `if (!document.hidden)` gate,
  // generalized), and coming back re-reads immediately rather than waiting out
  // up to a full interval on stale numbers. Six uncoordinated intervals here
  // were ~39 requests/minute per open tab, indefinitely, whether or not anyone
  // was looking — multiplied by tabs and operators, that was the largest
  // server-side cost in the frontend audit.
  function pollVisible(fn, ms) {
    var timer = setInterval(function () { if (!document.hidden) fn(); }, ms);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) fn();
    });
    return timer;
  }

  // Poll server for background discoveries (e.g. integration discovery after navigation)
  var _serverDiscoveries = [];
  async function pollDiscoveries() {
    try {
      var result = await api.integrations.discoveries();
      _serverDiscoveries = result.discoveries || [];
    } catch (_) {
      _serverDiscoveries = [];
    }
    renderQueryStatus();
    if (typeof window._onDiscoveriesChanged === "function") window._onDiscoveriesChanged(_serverDiscoveries);
  }
  pollDiscoveries();
  pollVisible(pollDiscoveries, 4000);

  // Expose for renderQueryStatus closure and for callers that need an immediate refresh
  window._getServerDiscoveries = function () { return _serverDiscoveries; };
  window._pollDiscoveries = pollDiscoveries;

  // Live firmware flashes (business rule 138) share the discoveries' panel:
  // asset, who started it, the stage it is on, and an Abort. Whoever can open
  // an asset (assets:read) can watch its flash; Abort needs assets:write.
  // Self-paced like the update poller below — 5 s while a flash is live, 15 s
  // otherwise — and a hidden tab stops asking.
  var _firmwareRuns = [];
  var _firmwareTimer = null;
  async function pollFirmwareRuns() {
    try {
      var result = await api.assets.activeFirmwareRuns();
      _firmwareRuns = (result && result.runs) || [];
    } catch (_) {
      _firmwareRuns = [];
    }
    renderQueryStatus();
  }
  function _scheduleFirmwarePoll() {
    if (_firmwareTimer) clearTimeout(_firmwareTimer);
    _firmwareTimer = setTimeout(function () {
      if (document.hidden) { _scheduleFirmwarePoll(); return; }
      pollFirmwareRuns().then(_scheduleFirmwarePoll, _scheduleFirmwarePoll);
    }, _firmwareRuns.length ? 5000 : 15000);
  }
  if (permAtLeast("assets", "read")) {
    pollFirmwareRuns().then(_scheduleFirmwarePoll, _scheduleFirmwarePoll);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) pollFirmwareRuns().then(_scheduleFirmwarePoll, _scheduleFirmwarePoll);
    });
  }
  window._getFirmwareRuns = function () { return _firmwareRuns; };
  // The card calls this right after a flash starts, so the panel shows it
  // without sitting out the idle interval.
  window._pollFirmwareRuns = function () {
    if (!permAtLeast("assets", "read")) return Promise.resolve();
    return pollFirmwareRuns().then(_scheduleFirmwarePoll, _scheduleFirmwarePoll);
  };

  // ─── New-user role-review notifications ────────────────────────────────
  // Admin-only sidebar panel. Lists users who just completed their first
  // login so an admin can decide whether to promote them off the default
  // role. Dismiss is global — clearing the flag hides the entry for every
  // admin at once.
  var _roleReviewUsers = [];
  async function pollRoleReviewNotifications() {
    if (!isAdmin()) return;
    try {
      var result = await api.users.roleReviewNotifications();
      _roleReviewUsers = (result && result.users) || [];
    } catch (_) {
      _roleReviewUsers = [];
    }
    renderRoleReviewStatus();
  }
  if (isAdmin()) {
    pollRoleReviewNotifications();
    pollVisible(pollRoleReviewNotifications, 30000);
  }
  window._pollRoleReviewNotifications = pollRoleReviewNotifications;
  window._getRoleReviewUsers = function () { return _roleReviewUsers; };

  // ─── Failed-integration notice ────────────────────────────────────────
  // Sidebar panel surfacing integrations whose most recent credential test
  // failed. lastTestOk changes only when an operator runs Test Connection,
  // so polling at 30 s is plenty — the underlying state changes slowly.
  // Silently degrades on permission denial (the route requires
  // integrations=read; users without it just see nothing).
  var _failedIntegrations = [];
  // FortiManager integrations still on the proxy transport with more gates than
  // the server's throughput threshold. Rides the same payload deliberately —
  // see the route comment; a slow-moving advisory does not deserve its own poll.
  var _fmgProxyAdvice = [];
  async function pollFailedIntegrations() {
    try {
      var result = await api.integrations.healthSummary();
      _failedIntegrations = (result && result.failed) || [];
      _fmgProxyAdvice = (result && result.proxyAdvice) || [];
    } catch (_) {
      _failedIntegrations = [];
      _fmgProxyAdvice = [];
    }
    renderIntegrationFailedStatus();
    renderFmgProxyAdvice();
  }
  pollFailedIntegrations();
  pollVisible(pollFailedIntegrations, 30000);
  window._getFailedIntegrations = function () { return _failedIntegrations; };
  window._getFmgProxyAdvice = function () { return _fmgProxyAdvice; };

  // ─── Agent code-signing failure alert ─────────────────────────────────
  // Dismissable sidebar alert: the last agent build shipped UNSIGNED
  // Windows binaries (code signing enabled but failed — the build is
  // fail-open by design). Visible only to roles that can deploy agents
  // (assets:write — same gate as the per-asset agent install routes).
  // Dismissal is per-user + per-failure: the localStorage key stores the
  // failure's `at` stamp, so a NEW failure re-shows the alert. Cleared
  // server-side by the next fully-signed build or by disabling signing.
  var _signingFailure = null;
  async function pollSigningAlert() {
    if (!canManageAssets()) return;
    try {
      var result = await api.assets.agentSigningAlert();
      _signingFailure = (result && result.failure) || null;
    } catch (_) {
      _signingFailure = null;
    }
    renderSigningFailureAlert();
  }
  if (canManageAssets()) {
    pollSigningAlert();
    pollVisible(pollSigningAlert, 30000);
  }
  window._getSigningFailure = function () { return _signingFailure; };

  // ─── Open security advisories on this host's platform ─────────────────
  // Dismissable sidebar alert naming every installed component below its
  // track's securityFloor (Platform Lifecycle grade `unpatched`). Shown to
  // roles that can change server settings — the people who act on it.
  // Reads the same memoised payload as the Maintenance card (6 h server-side
  // memo), so a slow poll costs nothing; the data only moves when a package
  // is upgraded or Polaris updates its dataset, and both restart the app.
  var _platformAdvisories = [];
  async function pollPlatformAdvisories() {
    if (!permAtLeast("serverSettingsSystem", "write")) return;
    try {
      var result = await api.serverSettings.getPlatformLifecycle();
      _platformAdvisories = ((result && result.components) || []).filter(function (c) {
        return c.grade && c.grade.state === "unpatched" && c.grade.securityFloor;
      });
    } catch (_) {
      _platformAdvisories = [];
    }
    renderPlatformAdvisoryAlert();
  }
  if (permAtLeast("serverSettingsSystem", "write")) {
    pollPlatformAdvisories();
    pollVisible(pollPlatformAdvisories, 600000);
  }
  window._getPlatformAdvisories = function () { return _platformAdvisories; };

  // ─── In-app update progress ───────────────────────────────────────────
  // Sidebar panel that mirrors the discovery indicator while an in-app
  // update is being applied (Server Settings → Maintenance kicks it off,
  // but it should be visible from any page). Shown to EVERY signed-in user —
  // the update restarts the app under all of them — and only while the update
  // is actually running (state applying/restarting). It used to be admin-only
  // because the full /updates/status is serverSettingsSystem-gated, so the
  // people the restart surprised were exactly the ones never told. Callers who
  // can read the full status keep reading it (the panel then shows the step's
  // message too); everyone else reads /updates/activity, an auth-only
  // projection carrying just the state and the current step's name.
  var _updateStatus = null;
  var _updateFullStatus = permAtLeast("serverSettingsSystem", "read");
  async function pollUpdateProgress() {
    try {
      _updateStatus = _updateFullStatus
        ? await api.serverSettings.getUpdateStatus()
        : await api.serverSettings.getUpdateActivity();
    } catch (_) {
      // Mid-restart the web process is briefly unreachable and the poll
      // fails. Keep the last known status so the panel persists across the
      // restart window instead of flickering out; only clear it when we
      // weren't already mid-update.
      if (!(_updateStatus && (_updateStatus.state === "applying" || _updateStatus.state === "restarting"))) {
        _updateStatus = null;
      }
    }
    renderUpdateStatus();
  }
  // Self-scheduling instead of a flat interval: 5 s while an update is
  // actually mid-flight (responsive enough for per-step progress), 15 s
  // otherwise. It was a flat 5 s for the whole session — 12 requests a
  // minute, forever, to learn that no update is running — then 60 s idle,
  // which held only for the admin who clicked Apply (Apply kicks the poller):
  // every OTHER open tab could sleep through the whole applying phase and
  // meet the restart with no warning. 15 s is an in-memory read. A hidden tab
  // stops asking unless an update IS in flight, where the operator may well
  // switch away and back.
  var _updateTimer = null;
  function _updateApplying() {
    return !!(_updateStatus && (_updateStatus.state === "applying" || _updateStatus.state === "restarting"));
  }
  function _scheduleUpdatePoll() {
    if (_updateTimer) clearTimeout(_updateTimer);
    _updateTimer = setTimeout(_runUpdatePoll, _updateApplying() ? 5000 : 15000);
  }
  function _runUpdatePoll() {
    if (document.hidden && !_updateApplying()) { _scheduleUpdatePoll(); return; }
    pollUpdateProgress().then(_scheduleUpdatePoll, _scheduleUpdatePoll);
  }
  pollUpdateProgress().then(_scheduleUpdatePoll, _scheduleUpdatePoll);
  // Same immediate re-read every pollVisible() poller gets on un-hiding: an
  // update that started while the tab was in the background is already
  // several steps in, and the panel exists to be seen — waiting out the
  // remaining idle interval can outlast the whole applying phase.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) window._pollUpdateProgress();
  });
  // Callers that just kicked an update (or want the panel fresh now) get an
  // immediate read AND a re-paced loop — without this an Apply click could
  // sit out the idle interval before the sidebar panel showed progress. The
  // Apply button in server-settings.js is the one caller that MUST use this:
  // with a short applying phase, the sidebar otherwise slept through the
  // entire update and the panel never appeared at all.
  window._pollUpdateProgress = function () {
    return pollUpdateProgress().then(function (r) { _scheduleUpdatePoll(); return r; }, function (e) { _scheduleUpdatePoll(); throw e; });
  };
  window._getUpdateStatus = function () { return _updateStatus; };

  // Inject global search bar + user badge into page header
  renderGlobalSearch();
  renderUserBadge();

  // Single Events-page sidebar dot — poll every 30 s; exposed on window so
  // events.js can refresh it after operator actions. Combines every
  // Events-page alert signal — everything the Alerts panel shows: discovery
  // conflicts and permanently failed pushes (danger), pushes still retrying
  // and stale-reservation alerts (warning). Red precedence, so a danger
  // signal is never masked by a warning one. There is no separate IPAM dot.
  async function refreshConflictDot() {
    var dot = document.getElementById("nav-conflict-dot");
    if (!dot) return;
    try {
      var counts = await Promise.all([
        canReviewConflicts()
          ? api.conflicts.count().catch(function () { return { count: 0 }; })
          : Promise.resolve({ count: 0 }),
        api.reservations.pushQueueCount().catch(function () { return { count: 0, failed: 0 }; }),
        api.reservations.alertsCount().catch(function () { return { count: 0 }; }),
      ]);
      var conflictCount = (counts[0] && counts[0].count) || 0;
      var queueCount = (counts[1] && counts[1].count) || 0;
      var failedCount = (counts[1] && counts[1].failed) || 0;
      var alertCount = (counts[2] && counts[2].count) || 0;
      // A push that failed for good is drawn red in the push queue, so it is
      // danger here too — only stale alerts and pushes still retrying are a
      // warning. Same rule as the Alerts button's badge (events.js).
      var dangerCount = conflictCount + failedCount;
      var total = conflictCount + queueCount + alertCount;
      dot.style.display = total > 0 ? "inline-block" : "none";
      // Red (danger) wins over yellow (warning).
      dot.classList.toggle("nav-conflict-dot--warning", dangerCount === 0 && total > 0);
    } catch (_) {}
  }
  refreshConflictDot();
  pollVisible(refreshConflictDot, 30000);
  window.refreshConflictDot = refreshConflictDot;

  // Re-apply branding when it already loaded — the brand block above renders
  // visibility:hidden until applyBranding clears it, and on pages that re-run
  // renderNav after boot (map.js re-renders after its own fetchCurrentUser)
  // the fetchBranding() apply can land BEFORE that re-render, leaving the
  // logo / app name / version invisible until the next full page load.
  if (_branding) applyBranding(_branding, true);
}

function _getUserInitials(username) {
  if (!username) return "?";
  var parts = username.replace(/[._-]/g, " ").trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return username.substring(0, 2).toUpperCase();
}

function _getInitialsColor(username) {
  var hash = 0;
  for (var i = 0; i < (username || "").length; i++) hash = username.charCodeAt(i) + ((hash << 5) - hash);
  var colors = ["#4a9eff", "#34d399", "#f59e0b", "#f472b6", "#a78bfa", "#fb923c", "#38bdf8", "#4ade80"];
  return colors[Math.abs(hash) % colors.length];
}

function _getRoleLabel(role) {
  switch (role) {
    case "admin":        return "Admin";
    case "networkadmin": return "Network Admin";
    case "assetsadmin":  return "Assets Admin";
    case "user":         return "User";
    default:             return role || "";
  }
}

function _getRoleBadgeClass(role) {
  switch (role) {
    case "admin":        return "badge-admin";
    case "networkadmin": return "badge-network-admin";
    case "assetsadmin":  return "badge-assets-admin";
    case "user":         return "badge-available";
    default:             return "badge-readonly";
  }
}

// ─── Role badge color helpers ────────────────────────────────────────────────
// A role can carry a stored `color` (#rrggbb). When present it drives the badge
// inline (translucent fill + solid text + border, matching the .badge-* CSS
// recipe) so renamed built-ins and custom roles keep their color. When absent,
// callers fall back to the legacy name-keyed badge classes above.

// Inline style string for a role badge given its stored color — only the
// `--hue` of a `.hue-pill` (styles.css), so the caller's badge must carry that
// class. Returns "" when the color is missing/invalid so the caller can fall
// back to a CSS class. The label is never the raw colour: a role coloured pale
// yellow or white would vanish on daylight, a navy one on nightfall.
function roleBadgeStyleFromColor(color) {
  var m = /^#?([0-9a-fA-F]{6})$/.exec(String(color || "").trim());
  return m ? "--hue:#" + m[1] : "";
}

// A pleasant random `#rrggbb` for the new-role color picker default — random
// hue, fixed mid saturation/lightness so every default reads as a usable badge.
function randomRoleColor() {
  var h = Math.floor(Math.random() * 360), s = 0.62, l = 0.55;
  var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
  var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + rgb.map(function (v) {
    return ("0" + Math.round((v + m) * 255).toString(16)).slice(-2);
  }).join("");
}
