/**
 * public/js/users.js — User management page
 */

// Module-scoped state ─────────────────────────────────────────────────────
var _usersRaw = [];           // last list from GET /users
var _usersSF = null;           // TableSF instance
var _usersPage = 1;            // unused today (no pagination) but matches the
                               //  callback shape the canonical implementations use
var _usersLayout = null;       // setupColumnLayout instance for the Users table
var _rolesLayout = null;       // setupColumnLayout instance for the Roles table
var _groupMappingsLayout = null; // setupColumnLayout instance for the Group Mappings table
var _rolesRaw = [];            // last list from GET /roles
var _rolesById = {};           // { id: role }
var _matrixSpec = null;        // { accessLevels, functions } from GET /roles/functions
var _regionList = [];          // cached map-region names for the region picker
var _regionByName = {};        // name → color hex; populated alongside _regionList
var _groupMappingsRaw = [];    // last list from GET /group-mappings
var _groupMappingsById = {};   // { id: mapping }

// Per-user TableSF prefs persistence — matches the canonical
// polaris-prefs-<scope>-<username> convention used by assets.js / blocks.js /
// subnets.js. Sort + filter state survives reload and is scoped per logged-in
// username so multiple operators sharing a workstation don't trample each
// other's settings. Save fires from the TableSF onChange callback; restore
// runs once after `userReady` resolves so currentUsername is populated.
function _saveUsersPrefs() {
  PolarisPrefs.save("users", currentUsername, Object.assign(
    {
      layout: _usersLayout ? _usersLayout.getPrefs() : null,
      rolesLayout: _rolesLayout ? _rolesLayout.getPrefs() : null,
      groupMappingsLayout: _groupMappingsLayout ? _groupMappingsLayout.getPrefs() : null,
    },
    _usersSF ? _usersSF.getPrefs() : {},
  ));
}

function _restoreUsersPrefs() {
  var p = PolarisPrefs.load("users", currentUsername);
  if (!p) return;
  if (_usersSF) _usersSF.setPrefs(p);
  if (_usersLayout && p.layout) _usersLayout.setPrefs(p.layout);
  if (_rolesLayout && p.rolesLayout) _rolesLayout.setPrefs(p.rolesLayout);
  if (_groupMappingsLayout && p.groupMappingsLayout) _groupMappingsLayout.setPrefs(p.groupMappingsLayout);
}

document.addEventListener("DOMContentLoaded", async function () {
  _usersSF = new TableSF("users-tbody", function () {
    _usersPage = 1;
    renderUsersBody();
    _saveUsersPrefs();
  });
  var usersTable = document.querySelector("#users-tbody").closest("table");
  if (usersTable && typeof setupColumnLayout === "function") {
    _usersLayout = setupColumnLayout(usersTable, { onChange: _saveUsersPrefs });
  }
  var rolesTableEl = document.querySelector("#roles-tbody");
  rolesTableEl = rolesTableEl ? rolesTableEl.closest("table") : null;
  if (rolesTableEl && typeof setupColumnLayout === "function") {
    _rolesLayout = setupColumnLayout(rolesTableEl, { onChange: _saveUsersPrefs });
  }
  var gmTableEl = document.querySelector("#group-mappings-tbody");
  gmTableEl = gmTableEl ? gmTableEl.closest("table") : null;
  if (gmTableEl && typeof setupColumnLayout === "function") {
    _groupMappingsLayout = setupColumnLayout(gmTableEl, { onChange: _saveUsersPrefs });
  }
  await userReady;
  _restoreUsersPrefs();
  loadUsers();
  loadRoles();          // also drives the role dropdowns in the user modals
  loadGroupMappings();  // IdP group → role + tags
  loadRegionList();     // best-effort; used by the region pickers
  loadTagList();        // best-effort; used by the tag pickers
  initAuthSettingsButton();
  document.getElementById("btn-add-user").addEventListener("click", openCreateModal);
  var btnAddRole = document.getElementById("btn-add-role");
  if (btnAddRole) btnAddRole.addEventListener("click", function () { openRoleSlideover(null); });
  var btnAddGm = document.getElementById("btn-add-group-mapping");
  if (btnAddGm) btnAddGm.addEventListener("click", function () { openGroupMappingSlideover(null); });
  var gmTbody = document.getElementById("group-mappings-tbody");
  if (gmTbody) {
    gmTbody.addEventListener("click", function (e) {
      var trigger = e.target.closest(".gm-menu");
      if (!trigger) return;
      var id = trigger.getAttribute("data-gm-id");
      var m = _groupMappingsById[id];
      if (!m) return;
      showRowMenu(trigger, [
        { label: "Edit…", onSelect: function () { openGroupMappingSlideover(id); } },
        { separator: true },
        { label: "Delete", danger: true, onSelect: function () { confirmDeleteGroupMapping(id); } },
      ], { label: "Actions for " + (m.groupLabel || m.groupKey) });
    });
  }

  // Username opens the row's verb menu. Built from the row RECORD rather than
  // the trigger's data-* attributes, because which verbs exist depends on
  // authProvider / totpEnabled / whether it's your own account.
  document.getElementById("users-tbody").addEventListener("click", function (e) {
    var trigger = e.target.closest(".user-menu");
    if (!trigger) return;
    var id = trigger.getAttribute("data-id");
    var u = (_usersRaw || []).find(function (x) { return String(x.id) === id; });
    if (!u) return;
    showRowMenu(trigger, _userMenuItems(u), { label: "Actions for " + u.username });
  });

  // Event delegation for roles-table action buttons
  var rolesTbody = document.getElementById("roles-tbody");
  if (rolesTbody) {
    rolesTbody.addEventListener("click", function (e) {
      var trigger = e.target.closest(".role-menu");
      if (!trigger) return;
      var id = trigger.getAttribute("data-role-id");
      var r = _rolesById[id];
      if (!r) return;
      showRowMenu(trigger, _roleMenuItems(r), { label: "Actions for " + r.name });
    });
  }
});

async function loadUsers() {
  var tbody = document.getElementById("users-tbody");
  try {
    _usersRaw = await api.users.list();
    if (_usersRaw.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No users found.</td></tr>';
      return;
    }
    // Decorate each row with a stable `totpEnabledSort` string so TableSF
    // can sort the 2FA column lexically (Enabled / Not set / IdP-managed).
    _usersRaw.forEach(function (u) {
      u.totpEnabledSort = isIdpManaged(u)
        ? "IdP-managed"
        : (u.totpEnabled ? "Enabled" : "Not set");
    });
    renderUsersBody();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

// A user whose identity + credentials are owned by an external IdP (SSO/LDAP);
// Polaris shows no local password or TOTP controls for them. Every non-local
// authProvider qualifies (azure / oidc / ldap / entra-proxy).
function isIdpManaged(u) {
  return !!u.authProvider && u.authProvider !== "local";
}

function idpProviderLabel(provider) {
  switch (provider) {
    case "azure": return "Azure";
    case "oidc": return "OIDC";
    case "ldap": return "LDAP";
    case "entra-proxy": return "App Proxy";
    default: return "SSO";
  }
}

function renderUsersBody() {
  var tbody = document.getElementById("users-tbody");
  var rows = _usersSF ? _usersSF.apply(_usersRaw) : _usersRaw;
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">No users match the current filters.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (u) {
    var roleName = u.role ? u.role.name : "";
    var roleKey = roleName.toLowerCase();
    var roleColor = u.role ? u.role.color : null;
    // Friendly label for the built-ins; raw name for everything else.
    var roleLabelText =
      roleKey === "admin" ? "admin" :
      roleKey === "networkadmin" ? "network admin" :
      roleKey === "assetsadmin" ? "assets admin" :
      roleKey === "user" ? "user" :
      roleKey === "readonly" ? "read only" :
      (roleName || "—");
    var roleBadge;
    var roleColorStyle = roleBadgeStyleFromColor(roleColor);
    if (roleColorStyle) {
      // Stored color wins — survives renames + colors custom roles.
      roleBadge = '<span class="badge" style="' + roleColorStyle + '">' + escapeHtml(roleLabelText) + '</span>';
    } else if (roleKey === "admin") roleBadge = '<span class="badge badge-admin">admin</span>';
    else if (roleKey === "networkadmin") roleBadge = '<span class="badge badge-network-admin">network admin</span>';
    else if (roleKey === "assetsadmin") roleBadge = '<span class="badge badge-assets-admin">assets admin</span>';
    else if (roleKey === "user") roleBadge = '<span class="badge badge-user">user</span>';
    else if (roleKey === "readonly") roleBadge = '<span class="badge badge-readonly">read only</span>';
    else roleBadge = '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-primary);border:1px solid var(--color-border)">' + escapeHtml(roleName || "—") + '</span>';
    var authBadge = isIdpManaged(u)
      ? '<span class="badge badge-reserved" title="' + escapeHtml(idpProviderLabel(u.authProvider)) + ' SSO">' + escapeHtml(idpProviderLabel(u.authProvider)) + '</span>'
      : '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-secondary)">Local</span>';
    var lastLogin = u.lastLogin
      ? '<span title="' + escapeHtml(new Date(u.lastLogin).toLocaleString()) + '">' + timeAgo(u.lastLogin) + '</span>'
      : '<span style="color:var(--color-text-tertiary)">Never</span>';
    var displayName = u.displayName ? ' <span style="color:var(--color-text-tertiary);font-size:0.85em">(' + escapeHtml(u.displayName) + ')</span>' : '';
    var onlineDot = u.isOnline
      ? '<span class="ip-status-dot ip-dot-available" title="Currently logged in" style="vertical-align:middle"></span>'
      : '';
    var regionsLabel = userTagPillsHtml(u);
    var totpCell;
    if (isIdpManaged(u)) {
      totpCell = '<span style="color:var(--color-text-tertiary);font-size:0.85em" title="Handled by your identity provider">IdP-managed</span>';
    } else if (u.totpEnabled) {
      totpCell = '<span class="badge" style="background:rgba(76,175,80,0.15);color:var(--color-success,#4caf50)">Enabled</span>';
    } else {
      totpCell = '<span style="color:var(--color-text-tertiary)">Not set</span>';
    }
    // Passkeys ride in the same cell but as their own chip, never merged into
    // the 2FA verdict: whether a passkey IS a second factor depends on the
    // install's passkey mode, and a column that claimed it always was would be
    // wrong on every "sign-in only" install.
    if (!isIdpManaged(u) && u.passkeyCount > 0) {
      totpCell += ' <span class="badge" style="background:rgba(99,102,241,0.15);color:var(--color-primary,#6366f1)" ' +
        'title="Registered passkeys">' + u.passkeyCount + ' passkey' + (u.passkeyCount === 1 ? '' : 's') + '</span>';
    }
    var roleId = u.role ? u.role.id : "";
    // Row verbs moved behind the username (polaris-ui-canon → "Row context menu").
    // The conditional set is unchanged — which items exist is decided in
    // _userMenuItems so the render and the menu can't drift apart.
    var nameCell = '<button type="button" class="row-menu-trigger user-menu"' +
      ' data-id="' + escapeHtml(u.id) + '"' +
      ' data-username="' + escapeHtml(u.username) + '"' +
      ' data-role-id="' + escapeHtml(roleId) + '"' +
      ' aria-haspopup="menu" aria-expanded="false" title="Actions for this user">' +
      '<strong>' + escapeHtml(u.username) + '</strong></button>';
    return '<tr>' +
      '<td style="text-align:center">' + onlineDot + '</td>' +
      '<td>' + nameCell + displayName + regionsLabel + '</td>' +
      '<td>' + authBadge + '</td>' +
      '<td>' + roleBadge + '</td>' +
      '<td>' + totpCell + '</td>' +
      '<td>' + lastLogin + '</td>' +
      '<td>' + formatDate(u.createdAt) + '</td>' +
      '</tr>';
  }).join("");
}

/**
 * The tag pills under a username: BOTH scope dimensions, one row.
 *
 * Regions alone were drawn here, which was right while Region Scope was its own
 * control. Assign Tags now edits both dimensions through one picker, so a list
 * that shows one of them says an operator's tags did not save. Each keeps its
 * own colour source — a region its stored map colour (PolarisRegionPills, shared
 * with the Device Map's "My regions" strip), a tag its registry colour — because
 * that is what makes a pill scannable, and the `title` names which dimension a
 * pill belongs to, since the two are matched differently at fire time.
 *
 * A tag the registry has no row for still renders, in the neutral grey
 * `tagColorFor` falls back to: the assignment is real whether or not a `Tag`
 * row backs it (there is no FK), and hiding it would be the same lie as before.
 */
function userTagPillsHtml(u) {
  var regions = Array.isArray(u.regionTags) ? u.regionTags : [];
  var tags = Array.isArray(u.otherTags) ? u.otherTags : [];
  if (!regions.length && !tags.length) return "";
  var html = "";
  // The shared pill helper takes a per-pill title function, so the dimension is
  // named on the pill itself rather than on a wrapper -- a `display:contents`
  // box has no hover target and would carry no tooltip at all.
  if (regions.length) {
    html += regionPillsHtml(regions, function () { return "Per-user region scope"; });
  }
  html += tags.map(function (t) {
    var hex = tagColorFor(t);
    var rgb = hexToRgbTriplet(hex);
    return '<span class="badge" title="Per-user tag scope" style="background:rgba(' + rgb + ',0.18);color:' +
      escapeHtml(hex) + ';border:1px solid rgba(' + rgb + ',0.45);font-size:0.7rem;padding:0.1rem 0.4rem">' +
      escapeHtml(t) +
    '</span>';
  }).join("");
  return '<div style="margin-top:0.25rem;display:flex;flex-wrap:wrap;gap:0.25rem">' + html + '</div>';
}

/**
 * The verbs offered for one user row, in menu order.
 *
 * Two conditions carried over verbatim from the old button row: an IdP-managed
 * account has no local password to reset, and 2FA is self-service for your own
 * account, an admin reset for someone else's (only when they actually have it
 * enabled), and absent entirely for Azure accounts where the IdP owns it.
 * Returning [] is impossible — Role, Tags and Delete are unconditional — so
 * the trigger never opens an empty menu.
 */
function _userMenuItems(u) {
  var isSelf = currentUsername === u.username;
  var items = [
    { label: "Change Role", onSelect: function () { openChangeRoleModal(u.id, u.username, u.role ? u.role.id : ""); } },
    { label: "Assign Tags", title: "Per-user tag scope (regions included)", onSelect: function () { openUserTagScopeModal(u.id, u.username); } },
  ];
  if (!isIdpManaged(u)) {
    items.push({ label: "Reset password…", onSelect: function () { openResetPasswordModal(u.id, u.username); } });
  }
  if (u.authProvider !== "azure") {
    if (isSelf) {
      items.push({ label: "Two-factor auth…", title: "Manage your two-factor authentication", onSelect: function () { openTotpSelfModal(); } });
    } else if (u.totpEnabled) {
      items.push({ label: "Reset 2FA…", title: "Reset 2FA (e.g. lost device)", onSelect: function () { confirmTotpReset(u.id, u.username); } });
    }
  }
  if (!isIdpManaged(u)) {
    if (isSelf) {
      items.push({ label: "Passkeys…", title: "Register or remove your own passkeys", onSelect: function () { PolarisPasskeys.open({ onChange: loadUsers }); } });
    } else if (u.passkeyCount > 0) {
      // The counterpart of "Reset 2FA": a lost authenticator needs an admin
      // path back. Safe because a local account always has a password, so this
      // can only widen the way in.
      items.push({ label: "Revoke passkeys…", title: "Remove every passkey on this account (e.g. lost device)", onSelect: function () { confirmPasskeyRevoke(u.id, u.username, u.passkeyCount); } });
    }
  }
  items.push({ separator: true });
  items.push({ label: "Delete", danger: true, onSelect: function () { confirmDelete(u.id, u.username); } });
  return items;
}

// Build a <select> of roles. `selectedId` pre-selects a row; `defaultName`
// (e.g. "readonly") falls back to a name-match when no id is given.
function roleSelectHtml(selectId, selectedId, defaultName) {
  if (_rolesRaw.length === 0) {
    return '<select id="' + selectId + '"><option value="" selected>Loading…</option></select>';
  }
  var fallbackId = selectedId;
  if (!fallbackId && defaultName) {
    var d = _rolesRaw.filter(function (r) { return r.name === defaultName; })[0];
    if (d) fallbackId = d.id;
  }
  var opts = _rolesRaw.map(function (r) {
    var label = r.name + (r.isBuiltIn ? "" : " (custom)");
    var selected = r.id === fallbackId ? " selected" : "";
    return '<option value="' + escapeHtml(r.id) + '"' + selected + '>' + escapeHtml(label) + '</option>';
  }).join("");
  return '<select id="' + selectId + '">' + opts + '</select>';
}

function openCreateModal() {
  var body = '<div class="form-group"><label>Username *</label><input type="text" id="f-username" placeholder="e.g. jsmith"></div>' +
    '<div class="form-group"><label>Password *</label><input type="password" id="f-password" placeholder="Enter password">' + passwordChecksHTML("f-pw-checks") + '<p class="hint">The user can change this after first login.</p></div>' +
    '<div class="form-group"><label>Confirm Password *</label><input type="password" id="f-password-confirm" placeholder="Re-enter password">' + passwordMatchHTML("f-pw-match") + '</div>' +
    '<div class="form-group"><label>Role</label>' + roleSelectHtml("f-role", null, "readonly") + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Create User</button>';
  openModal("Add User", body, footer);
  wirePasswordChecks("f-password", "f-pw-checks");
  wirePasswordMatch("f-password", "f-password-confirm", "f-pw-match");
  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    if (!val("f-username")) {
      showToast("Username is required", "error");
      return;
    }
    if (!checkPasswordField(val("f-password"), "f-pw-checks")) {
      showToast("Password does not meet complexity requirements", "error");
      return;
    }
    if (val("f-password") !== val("f-password-confirm")) {
      showToast("Passwords do not match", "error");
      return;
    }
    var roleId = val("f-role");
    if (!roleId) { showToast("Pick a role", "error"); return; }
    btn.disabled = true;
    try {
      await api.users.create({
        username: val("f-username"),
        password: val("f-password"),
        roleId: roleId,
      });
      closeModal();
      showToast("User created");
      loadUsers();
      loadRoles();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function openChangeRoleModal(id, username, currentRoleId) {
  var body = '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Change role for <strong>' + escapeHtml(username) + '</strong></p>' +
    '<div class="form-group"><label>Role</label>' + roleSelectHtml("f-role", currentRoleId, null) + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Update Role</button>';
  openModal("Change Role", body, footer);
  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    var roleId = val("f-role");
    if (!roleId) { showToast("Pick a role", "error"); return; }
    btn.disabled = true;
    try {
      await api.users.updateRole(id, { roleId: roleId });
      closeModal();
      showToast("Role updated for " + username);
      loadUsers();
      loadRoles();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

/**
 * Assign Tags — the per-user half of the two tag dimensions.
 *
 * ONE picker, not two. A map region is already a registry tag (mapRegionService
 * mints `region:<name>` in the locked "Map Regions" category on every region
 * save), so the tag picker below was listing every region alongside a separate
 * Region Scope control above it: the same names twice, in one dialog.
 *
 * The two DIMENSIONS still exist on the wire. `User.regionTags` is what
 * region-ONLY routing reads (resolveUsersByRegions, the level-scoped recipient
 * entries, "My regions" on the Device Map), so folding regions into otherTags
 * would take those users out of it silently. The PREFIX carries the split
 * instead: the picker is seeded with each region tag under its registry name
 * (`region:<name>`) and the save routes anything so prefixed back to
 * regionTags, bare. A region with no registry row — catalogue unreadable,
 * or the polygon deleted out from under the assignment — round-trips as an
 * unregistered chip under the same name rather than being dropped.
 */
function _splitUserTagScope(tags) {
  var regionTags = [];
  var otherTags = [];
  (tags || []).forEach(function (t) {
    var v = String(t || "").trim();
    if (!v) return;
    if (/^region:/i.test(v)) {
      var bare = v.slice("region:".length).trim();
      if (bare && regionTags.indexOf(bare) === -1) regionTags.push(bare);
    } else if (otherTags.indexOf(v) === -1) {
      otherTags.push(v);
    }
  });
  return { regionTags: regionTags, otherTags: otherTags };
}

function openUserTagScopeModal(id, username) {
  var user = _usersRaw.filter(function (u) { return u.id === id; })[0];
  var current = (user && Array.isArray(user.regionTags)) ? user.regionTags.slice() : [];
  var currentOther = (user && Array.isArray(user.otherTags)) ? user.otherTags.slice() : [];
  var seeded = current.map(function (n) { return "region:" + n; }).concat(currentOther);
  var help =
    '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Per-user tag scope for <strong>' + escapeHtml(username) + '</strong>. ' +
      'Empty = unrestricted. Effective scope is the union of the tags on the ' +
      'user&rsquo;s role, these per-user tags, and any granted by the ' +
      'user&rsquo;s IdP groups. Map regions appear as ' +
      '<code>region:&lt;name&gt;</code> under the <strong>Map Regions</strong> group.' +
    '</p>';
  var body = help +
    '<div class="form-group"><label>Tags</label>' + otherTagsPickerHtml("f-user-other", seeded) + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Save</button>';
  openModal("Assign Tags", body, footer);
  document.getElementById("btn-cancel").addEventListener("click", closeModal);
  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var split = _splitUserTagScope(collectOtherTags("f-user-other"));
      await api.users.updateRegions(id, { regionTags: split.regionTags, otherTags: split.otherTags });
      closeModal();
      showToast("Tag scope updated for " + username);
      loadUsers();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function openResetPasswordModal(id, username) {
  var body = '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">Set a new password for <strong>' + escapeHtml(username) + '</strong></p>' +
    '<div class="form-group"><label>New Password *</label><input type="password" id="f-password" placeholder="Enter password">' + passwordChecksHTML("f-pw-checks") + '</div>' +
    '<div class="form-group"><label>Confirm Password *</label><input type="password" id="f-password-confirm" placeholder="Re-enter password">' + passwordMatchHTML("f-pw-match") + '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button><button class="btn btn-primary" id="btn-save">Reset Password</button>';
  openModal("Reset Password", body, footer);
  wirePasswordChecks("f-password", "f-pw-checks");
  wirePasswordMatch("f-password", "f-password-confirm", "f-pw-match");
  document.getElementById("btn-cancel").addEventListener("click", closeModal);

  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    var pw = val("f-password");
    if (!checkPasswordField(pw, "f-pw-checks")) {
      showToast("Password does not meet complexity requirements", "error");
      return;
    }
    if (pw !== val("f-password-confirm")) {
      showToast("Passwords do not match", "error");
      return;
    }
    btn.disabled = true;
    try {
      await api.users.resetPassword(id, { password: pw });
      closeModal();
      showToast("Password reset for " + username);
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

async function confirmDelete(id, username) {
  var ok = await showConfirm('Delete user "' + username + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.users.delete(id);
    showToast("User deleted");
    loadUsers();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// val() is the app.js canonical (2026-08 audit — five identical top-level copies shadowed each other on co-loaded pages).

// ─── Self-service TOTP ─────────────────────────────────────────────────────
//
// The enroll / confirm / disable / backup-code UI lives in the shared
// public/js/totp-self.js so the SAME flow is reachable from the page-header
// account menu on every page — /users.html is admin-gated, so a local user
// without `users` could otherwise never configure their own second factor.
// This page only adds the table refresh and (below) the admin-side reset.

function openTotpSelfModal() {
  if (!window.PolarisTotpSelf) { showToast("Two-factor UI failed to load", "error"); return; }
  PolarisTotpSelf.open({
    username: currentUsername,
    onChange: function () {
      loadUsers();
      // Keep the account menu's own cached row honest on this page too.
      if (typeof refreshTotpState === "function") refreshTotpState();
    },
  });
}

async function confirmTotpReset(id, username) {
  var ok = await showConfirm(
    'Reset two-factor auth for "' + username + '"?\n\n' +
    'Use this only when the user has lost access to their authenticator app and their backup codes. ' +
    'They will be able to log in with just their password on the next attempt, and should re-enroll immediately.',
  );
  if (!ok) return;
  try {
    await api.users.resetTotp(id);
    showToast("2FA reset for " + username);
    loadUsers();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function confirmPasskeyRevoke(id, username, count) {
  var ok = await showConfirm(
    'Revoke ' + count + ' passkey' + (count === 1 ? '' : 's') + ' for "' + username + '"?\n\n' +
    'Use this when the user has lost the device or security key holding them. They keep their password ' +
    '(and their authenticator app, if any) and can register a new passkey afterwards.\n\n' +
    'This cannot be undone — the credentials have to be re-registered from the device itself.',
  );
  if (!ok) return;
  try {
    var result = await api.users.revokePasskeys(id);
    showToast((result.removed || count) + " passkey" + ((result.removed || count) === 1 ? "" : "s") + " revoked for " + username);
    loadUsers();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Authentication Settings ───────────────────────────────────────────────

async function initAuthSettingsButton() {
  var btn = document.getElementById("btn-auth-settings");
  if (!btn) return;

  btn.style.display = "";
  btn.addEventListener("click", openAuthSettingsModal);
}

var _authActiveTab = "saml";

async function openAuthSettingsModal() {
  var results = await Promise.all([
    api.auth.azureSettings().catch(function () { return { spEntityId: "", idpEntityId: "", idpLoginUrl: "", idpLogoutUrl: "", idpCertificate: "", wantResponseSigned: false, skipLoginPage: false, autoLogoutMinutes: 0 }; }),
    api.auth.oidcSettings().catch(function () { return { enabled: false, discoveryUrl: "", clientId: "", clientSecret: "", scopes: "openid profile email" }; }),
    api.auth.ldapSettings().catch(function () { return { enabled: false, url: "", bindDn: "", bindPassword: "", searchBase: "", searchFilter: "(sAMAccountName={{username}})", tlsVerify: true, displayNameAttr: "displayName", emailAttr: "mail" }; }),
    api.auth.entraProxySettings().catch(function () { return { enabled: false, trustedSourceIps: [], objectIdHeader: "x-entra-object-id", usernameHeader: "x-entra-upn", emailHeader: "x-entra-email", displayNameHeader: "x-entra-display-name", groupsHeader: "x-entra-groups" }; }),
    // The three that moved onto the Settings tab. Each falls back to the
    // shipped default so one failed request leaves a usable tab rather than an
    // empty one — the same posture the four provider reads above take.
    api.auth.passwordPolicy().catch(function () { return { policy: { minLength: 8, requireLowercase: true, requireUppercase: true, requireNumber: true, requireSpecial: true, forceChangeOnLogin: false } }; }),
    api.serverSettings.loginAccessGet().catch(function () { return { loginAccess: { enabled: false, ipScope: "rfc1918", allowedCidrs: [] }, callerIp: "" }; }),
    api.auth.passkeySettings().catch(function () { return { settings: { mode: "both", rpId: "", requireUserVerification: true }, availability: {} }; }),
  ]);
  var saml = results[0], oidc = results[1], ldap = results[2], entraProxy = results[3];
  var policy = results[4].policy;
  var loginAccess = { settings: results[5].loginAccess, callerIp: results[5].callerIp || "" };
  var passkeys = results[6];

  var body =
    '<div class="settings-tabs">' +
      '<button class="settings-tab' + (_authActiveTab === "saml" ? ' active' : '') + '" data-tab="saml">SAML</button>' +
      '<button class="settings-tab' + (_authActiveTab === "oidc" ? ' active' : '') + '" data-tab="oidc">OIDC</button>' +
      '<button class="settings-tab' + (_authActiveTab === "ldap" ? ' active' : '') + '" data-tab="ldap">LDAP</button>' +
      '<button class="settings-tab' + (_authActiveTab === "entra-proxy" ? ' active' : '') + '" data-tab="entra-proxy">App Proxy</button>' +
      '<button class="settings-tab' + (_authActiveTab === "settings" ? ' active' : '') + '" data-tab="settings">Settings</button>' +
    '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "saml" ? ' active' : '') + '" id="tab-saml">' + buildSamlTab(saml) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "oidc" ? ' active' : '') + '" id="tab-oidc">' + buildOidcTab(oidc) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "ldap" ? ' active' : '') + '" id="tab-ldap">' + buildLdapTab(ldap) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "entra-proxy" ? ' active' : '') + '" id="tab-entra-proxy">' + buildEntraProxyTab(entraProxy) + '</div>' +
    '<div class="settings-tab-panel' + (_authActiveTab === "settings" ? ' active' : '') + '" id="tab-settings">' + buildSettingsTab(saml, policy, loginAccess, passkeys) + '</div>';

  var footer =
    '<div style="margin-right:auto"><button class="btn btn-secondary" id="btn-test-auth">Test</button></div>' +
    '<button class="btn btn-secondary" id="btn-cancel-auth">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save-auth">Save</button>';

  openModal("Authentication", body, footer);

  // Tab switching
  document.querySelectorAll(".settings-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
      var target = tab.getAttribute("data-tab");
      _authActiveTab = target;
      document.querySelectorAll(".settings-tab").forEach(function (t) { t.classList.remove("active"); });
      document.querySelectorAll(".settings-tab-panel").forEach(function (p) { p.classList.remove("active"); });
      tab.classList.add("active");
      document.getElementById("tab-" + target).classList.add("active");
      document.getElementById("btn-test-auth").style.display = (target === "settings") ? "none" : "";
    });
  });
  document.getElementById("btn-test-auth").style.display = (_authActiveTab === "settings") ? "none" : "";

  // The trusted-networks list only means anything under the "custom" scope.
  wireLoginAccessScope();

  // SAML: live-update ACS / SLS URLs
  document.getElementById("f-sp-entity-id").addEventListener("input", function () {
    var base = this.value.trim().replace(/\/+$/, "");
    document.getElementById("f-sp-acs-url").value = base ? base + "/api/v1/auth/azure/callback" : "";
    document.getElementById("f-sp-sls-url").value = base ? base + "/login.html" : "";
  });

  // Copy buttons
  document.getElementById("btn-copy-acs-url").addEventListener("click", function () { copyField("f-sp-acs-url", this); });
  document.getElementById("btn-copy-sls-url").addEventListener("click", function () { copyField("f-sp-sls-url", this); });
  var oidcCopy = document.getElementById("btn-copy-oidc-redirect");
  if (oidcCopy) oidcCopy.addEventListener("click", function () { copyField("f-oidc-redirect-uri", this); });
  document.getElementById("btn-cancel-auth").addEventListener("click", closeModal);

  // Certificate file import
  document.getElementById("f-idp-cert-file").addEventListener("change", function () {
    var file = this.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function (e) { document.getElementById("f-idp-certificate").value = e.target.result; };
    reader.readAsText(file);
  });

  // Test \u2014 per active tab (SAML / OIDC / LDAP). Saves that tab's settings
  // first, then runs the provider-specific connectivity test.
  document.getElementById("btn-test-auth").addEventListener("click", async function () {
    var tab = _authActiveTab;
    var btn = this;
    var resultsDiv = document.getElementById(tab === "saml" ? "sso-test-results" : tab + "-test-results");
    if (!resultsDiv) return;
    function setBox(ok) {
      resultsDiv.style.display = "block";
      resultsDiv.style.background = ok ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)";
      resultsDiv.style.border = ok ? "1px solid rgba(34,197,94,0.3)" : "1px solid rgba(239,68,68,0.3)";
    }
    btn.disabled = true;
    btn.textContent = "Testing\u2026";
    resultsDiv.style.display = "block";
    resultsDiv.style.background = "var(--color-bg-secondary)";
    resultsDiv.style.border = "1px solid var(--color-border)";
    resultsDiv.innerHTML = '<span style="color:var(--color-text-secondary)">Running test\u2026</span>';
    try {
      if (tab === "saml") {
        await api.auth.updateAzureSettings(getSamlFormData());
        var data = await api.auth.testAzureSettings();
        var r = data.results;
        resultsDiv.innerHTML = '<div style="display:flex;flex-direction:column;gap:0.5rem">' +
          '<div>' + (r.certificate.ok ? "\u2705" : "\u274c") + ' <strong>Certificate:</strong> ' + escapeHtml(r.certificate.message) + '</div>' +
          '<div>' + (r.idpLoginUrl.ok ? "\u2705" : "\u274c") + ' <strong>IdP Login URL:</strong> ' + escapeHtml(r.idpLoginUrl.message) + '</div>' +
        '</div>';
        setBox(data.ok);
      } else if (tab === "oidc") {
        await api.auth.updateOidcSettings(getOidcFormData());
        var od = await api.auth.testOidc();
        var detailHtml = "";
        if (od.details) {
          detailHtml = '<div style="margin-top:0.4rem;font-size:0.8rem;color:var(--color-text-secondary)">' +
            'authorization: ' + escapeHtml(od.details.authorization_endpoint || "") + '<br>' +
            'token: ' + escapeHtml(od.details.token_endpoint || "") + '<br>' +
            'userinfo: ' + escapeHtml(od.details.userinfo_endpoint || "(none)") + '</div>';
        }
        resultsDiv.innerHTML = (od.ok ? "\u2705 " : "\u274c ") + escapeHtml(od.message) + detailHtml;
        setBox(od.ok);
      } else if (tab === "ldap") {
        await api.auth.updateLdapSettings(getLdapFormData());
        var ld = await api.auth.testLdap();
        resultsDiv.innerHTML = (ld.ok ? "\u2705 " : "\u274c ") + escapeHtml(ld.message);
        setBox(ld.ok);
      } else if (tab === "entra-proxy") {
        await api.auth.updateEntraProxySettings(getEntraProxyFormData());
        var ep = await api.auth.testEntraProxy();
        var epDetail = "";
        if (ep.details) {
          epDetail = '<div style="margin-top:0.4rem;font-size:0.8rem;color:var(--color-text-secondary)">' +
            'request IP: <code>' + escapeHtml(ep.details.requestIp || "(unknown)") + '</code> \u2014 ' +
            (ep.details.trusted ? 'trusted' : 'not trusted') + '<br>' +
            'identity headers on this request: ' + escapeHtml((ep.details.headersPresent || []).join(", ") || "(none)") + '</div>';
        }
        resultsDiv.innerHTML = (ep.ok ? "\u2705 " : "\u274c ") + escapeHtml(ep.message) + epDetail;
        setBox(ep.ok);
      }
    } catch (err) {
      resultsDiv.innerHTML = '<span style="color:var(--color-danger)">\u274c ' + escapeHtml(err.message) + '</span>';
      setBox(false);
    } finally {
      btn.disabled = false;
      btn.textContent = "Test";
    }
  });

  // Save — all tabs
  document.getElementById("btn-save-auth").addEventListener("click", async function () {
    var btn = this;

    // Ask before the write, not after: switching existing users to a forced
    // change interrupts the next sign-in of everyone whose password no longer
    // fits, and an admin who ticked a radio two scrolls up deserves to see
    // that spelled out. Only when it is being turned ON — turning it off
    // narrows nothing.
    var forceChange = document.getElementById("f-pw-existing-force").checked;
    if (forceChange && !policy.forceChangeOnLogin) {
      var ok = await showConfirm(
        "Require existing users to change a non-conforming password?\n\n" +
        "The next time a local user signs in, their password is checked against these rules. " +
        "If it fails, they must set a new one before they get a session — after any second factor, never instead of it.\n\n" +
        "SSO and LDAP accounts are unaffected.",
      );
      if (!ok) return;
    }

    btn.disabled = true;
    try {
      await Promise.all([
        api.auth.updateAzureSettings(getSamlFormData()),
        api.auth.updateOidcSettings(getOidcFormData()),
        api.auth.updateLdapSettings(getLdapFormData()),
        api.auth.updateEntraProxySettings(getEntraProxyFormData()),
        api.auth.updatePasswordPolicy(getPasswordPolicyFormData()),
        api.serverSettings.loginAccessPut(getLoginAccessFormData()),
        api.auth.updatePasskeySettings(getPasskeyFormData()),
      ]);
      closeModal();
      showToast("Authentication settings saved");
    } catch (err) {
      // Promise.all rejects on the first failure while the rest may still have
      // landed, so the toast must not claim nothing was saved.
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

/** Grey out the CIDR list unless the scope that consults it is selected. */
function wireLoginAccessScope() {
  var scope = document.getElementById("f-la-scope");
  var group = document.getElementById("f-la-cidrs-group");
  if (!scope || !group) return;
  function sync() {
    var custom = scope.value === "custom";
    group.style.opacity = custom ? "1" : "0.5";
    document.getElementById("f-la-cidrs").disabled = !custom;
  }
  scope.addEventListener("change", sync);
  sync();
}

function getPasswordPolicyFormData() {
  return {
    minLength: parseInt(document.getElementById("f-pw-min-length").value, 10) || 8,
    requireLowercase: document.getElementById("f-pw-lower").checked,
    requireUppercase: document.getElementById("f-pw-upper").checked,
    requireNumber: document.getElementById("f-pw-number").checked,
    requireSpecial: document.getElementById("f-pw-special").checked,
    forceChangeOnLogin: document.getElementById("f-pw-existing-force").checked,
  };
}

function getLoginAccessFormData() {
  return {
    enabled: document.getElementById("f-la-enabled").checked,
    ipScope: document.getElementById("f-la-scope").value,
    allowedCidrs: document.getElementById("f-la-cidrs").value
      .split(/[\s,]+/)
      .map(function (x) { return x.trim(); })
      .filter(Boolean),
  };
}

function getPasskeyFormData() {
  var checked = document.querySelector('input[name="pk-mode"]:checked');
  return {
    mode: checked ? checked.value : "both",
    rpId: val("f-pk-rpid"),
    requireUserVerification: document.getElementById("f-pk-uv").checked,
  };
}

function getSamlFormData() {
  return {
    enabled: document.getElementById("f-saml-enabled").checked,
    spEntityId: val("f-sp-entity-id"),
    idpEntityId: val("f-idp-entity-id"),
    idpLoginUrl: val("f-idp-login-url"),
    idpLogoutUrl: val("f-idp-logout-url"),
    idpCertificate: document.getElementById("f-idp-certificate").value.trim(),
    wantResponseSigned: document.getElementById("f-want-response-signed").checked,
    skipLoginPage: document.getElementById("f-skip-login").checked,
    autoLogoutMinutes: parseInt(document.getElementById("f-auto-logout").value, 10) || 0,
  };
}

function getOidcFormData() {
  return {
    enabled: document.getElementById("f-oidc-enabled").checked,
    discoveryUrl: val("f-oidc-discovery-url"),
    clientId: val("f-oidc-client-id"),
    clientSecret: val("f-oidc-client-secret"),
    scopes: val("f-oidc-scopes"),
    groupsClaim: val("f-oidc-groups-claim"),
    usernameClaim: val("f-oidc-username-claim"),
    emailClaim: val("f-oidc-email-claim"),
    displayNameClaim: val("f-oidc-displayname-claim"),
  };
}

function getLdapFormData() {
  return {
    enabled: document.getElementById("f-ldap-enabled").checked,
    url: val("f-ldap-url"),
    bindDn: val("f-ldap-bind-dn"),
    bindPassword: val("f-ldap-bind-password"),
    searchBase: val("f-ldap-search-base"),
    searchFilter: val("f-ldap-search-filter"),
    tlsVerify: document.getElementById("f-ldap-tls-verify").checked,
    displayNameAttr: val("f-ldap-display-name-attr"),
    emailAttr: val("f-ldap-email-attr"),
    userIdAttribute: val("f-ldap-userid-attr"),
    groupAttribute: val("f-ldap-group-attr"),
    groupBaseDn: val("f-ldap-group-base"),
    groupFilter: val("f-ldap-group-filter"),
  };
}

function getEntraProxyFormData() {
  var ips = val("f-entra-proxy-trusted-ips")
    .split(/[\s,]+/)
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
  return {
    enabled: document.getElementById("f-entra-proxy-enabled").checked,
    trustedSourceIps: ips,
    objectIdHeader: val("f-entra-proxy-objectid-header"),
    usernameHeader: val("f-entra-proxy-username-header"),
    emailHeader: val("f-entra-proxy-email-header"),
    displayNameHeader: val("f-entra-proxy-displayname-header"),
    groupsHeader: val("f-entra-proxy-groups-header"),
  };
}

function buildSamlTab(s) {
  var origin = window.location.origin;
  var spEntityId = s.spEntityId || origin;
  var spAcsUrl = spEntityId.replace(/\/+$/, "") + "/api/v1/auth/azure/callback";
  var spSlsUrl = spEntityId.replace(/\/+$/, "") + "/login.html";

  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure SAML 2.0 single sign-on with your identity provider.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-saml-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Enable SAML authentication</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin-bottom:0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Service Provider</h4>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin-bottom:0.75rem">Copy these values into your identity provider\'s SAML configuration.</p>' +
    '<div class="form-group">' +
      '<label>Application URL *</label>' +
      '<input type="text" id="f-sp-entity-id" value="' + escapeHtml(spEntityId) + '" placeholder="https://ipam.example.com">' +
      '<p class="hint">Your application\'s public URL. Used as the SP Entity ID and to build the callback URLs below.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>ACS (Login) URL</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-sp-acs-url" value="' + escapeHtml(spAcsUrl) + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-acs-url" title="Copy">Copy</button>' +
      '</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>SLS (Logout) URL</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-sp-sls-url" value="' + escapeHtml(spSlsUrl) + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-sls-url" title="Copy">Copy</button>' +
      '</div>' +
    '</div>' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Identity Provider</h4>' +
    '<div class="form-group">' +
      '<label>IdP Entity ID</label>' +
      '<input type="text" id="f-idp-entity-id" value="' + escapeHtml(s.idpEntityId || "") + '" placeholder="e.g. https://sts.windows.net/... or https://accounts.google.com/...">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Login URL</label>' +
      '<input type="text" id="f-idp-login-url" value="' + escapeHtml(s.idpLoginUrl || "") + '" placeholder="e.g. https://login.microsoftonline.com/.../saml2">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Logout URL</label>' +
      '<input type="text" id="f-idp-logout-url" value="' + escapeHtml(s.idpLogoutUrl || "") + '" placeholder="Optional — defaults to login URL">' +
    '</div>' +
    '<div class="form-group">' +
      '<label>IdP Certificate</label>' +
      '<textarea id="f-idp-certificate" rows="6" style="font-family:monospace;font-size:0.8rem;resize:vertical" placeholder="-----BEGIN CERTIFICATE-----\nMIIC8D...\n-----END CERTIFICATE-----">' + escapeHtml(s.idpCertificate || "") + '</textarea>' +
      '<p class="hint">Paste the Base64-encoded signing certificate from your IdP, or import a file.</p>' +
      '<input type="file" id="f-idp-cert-file" accept=".pem,.cer,.crt,.cert" style="margin-top:0.35rem;font-size:0.8rem">' +
    '</div>' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Signature Verification</h4>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-want-response-signed"' + (s.wantResponseSigned ? ' checked' : '') + '>' +
        '<span>Require signed SAML response</span>' +
      '</label>' +
      '<p class="hint" style="margin:0.35rem 0 0 1.5rem">Enable if your IdP signs the entire SAML response (not just the assertion).</p>' +
    '</div>' +
    '<div id="sso-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';
}

function buildOidcTab(s) {
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure OpenID Connect for single sign-on with providers like Azure AD, Google Workspace, or Okta.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-oidc-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Enable OIDC authentication</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<div class="form-group">' +
      '<label>Discovery URL</label>' +
      '<input type="text" id="f-oidc-discovery-url" value="' + escapeHtml(s.discoveryUrl || "") + '" placeholder="e.g. https://login.microsoftonline.com/{tenant}/v2.0/.well-known/openid-configuration">' +
      '<p class="hint">The OpenID Connect discovery endpoint. The client will auto-discover authorization, token, and userinfo endpoints.</p>' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>Client ID</label>' +
        '<input type="text" id="f-oidc-client-id" value="' + escapeHtml(s.clientId || "") + '" placeholder="Application (client) ID">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Client Secret</label>' +
        '<input type="password" id="f-oidc-client-secret" value="' + escapeHtml(s.clientSecret || "") + '" placeholder="Client secret value">' +
      '</div>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Scopes</label>' +
      '<input type="text" id="f-oidc-scopes" value="' + escapeHtml(s.scopes || "openid profile email") + '">' +
      '<p class="hint">Space-separated list of scopes to request. Include the scope that returns groups (e.g. <code>groups</code> or a provider-specific scope).</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Redirect URI</label>' +
      '<div style="display:flex;gap:0.5rem;align-items:center">' +
        '<input type="text" id="f-oidc-redirect-uri" value="' + escapeHtml(s.redirectUri || "") + '" readonly style="background:var(--color-bg-secondary);cursor:default;flex:1">' +
        '<button type="button" class="btn btn-sm btn-secondary" id="btn-copy-oidc-redirect" title="Copy">Copy</button>' +
      '</div>' +
      '<p class="hint">Register this exact redirect URI in your IdP app. Derived from <code>POLARIS_PUBLIC_URL</code>.</p>' +
    '</div>' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Claim Mapping</h4>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>Groups Claim</label>' +
        '<input type="text" id="f-oidc-groups-claim" value="' + escapeHtml(s.groupsClaim || "groups") + '">' +
        '<p class="hint">Claim holding the user\'s groups. <strong>Azure AD emits group object IDs (GUIDs), not names</strong> — map those IDs in Group Mappings, or configure Azure to emit names.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Username Claim</label>' +
        '<input type="text" id="f-oidc-username-claim" value="' + escapeHtml(s.usernameClaim || "preferred_username") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Email Claim</label>' +
        '<input type="text" id="f-oidc-email-claim" value="' + escapeHtml(s.emailClaim || "email") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Display Name Claim</label>' +
        '<input type="text" id="f-oidc-displayname-claim" value="' + escapeHtml(s.displayNameClaim || "name") + '">' +
      '</div>' +
    '</div>' +
    '<div id="oidc-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';
}

function buildLdapTab(s) {
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure LDAP or Active Directory for username/password authentication against a directory server.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-ldap-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Enable LDAP authentication</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Connection</p>' +
    '<div class="form-group">' +
      '<label>Server URL</label>' +
      '<input type="text" id="f-ldap-url" value="' + escapeHtml(s.url || "") + '" placeholder="e.g. ldaps://dc01.corp.local:636 or ldap://dc01.corp.local:389">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-ldap-tls-verify"' + (s.tlsVerify !== false ? ' checked' : '') + '>' +
        '<span>Verify TLS certificate</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Bind Credentials</p>' +
    '<div class="form-group">' +
      '<label>Bind DN</label>' +
      '<input type="text" id="f-ldap-bind-dn" value="' + escapeHtml(s.bindDn || "") + '" placeholder="e.g. CN=svc-polaris,OU=Service Accounts,DC=corp,DC=local">' +
      '<p class="hint">Distinguished name of the service account used to search the directory.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Bind Password</label>' +
      '<input type="password" id="f-ldap-bind-password" value="' + escapeHtml(s.bindPassword || "") + '">' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">User Search</p>' +
    '<div class="form-group">' +
      '<label>Search Base</label>' +
      '<input type="text" id="f-ldap-search-base" value="' + escapeHtml(s.searchBase || "") + '" placeholder="e.g. DC=corp,DC=local">' +
      '<p class="hint">Base DN to search for user accounts.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Search Filter</label>' +
      '<input type="text" id="f-ldap-search-filter" value="' + escapeHtml(s.searchFilter || "(sAMAccountName={{username}})") + '">' +
      '<p class="hint">LDAP filter to find the user. Use <code>{{username}}</code> as a placeholder for the login username.</p>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Attribute Mapping</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>Display Name Attribute</label>' +
        '<input type="text" id="f-ldap-display-name-attr" value="' + escapeHtml(s.displayNameAttr || "displayName") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Email Attribute</label>' +
        '<input type="text" id="f-ldap-email-attr" value="' + escapeHtml(s.emailAttr || "mail") + '">' +
      '</div>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<p style="font-size:0.75rem;text-transform:uppercase;letter-spacing:1px;color:var(--color-text-tertiary);margin-bottom:0.75rem">Group Membership</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>User ID Attribute</label>' +
        '<input type="text" id="f-ldap-userid-attr" value="' + escapeHtml(s.userIdAttribute || "objectGUID") + '">' +
        '<p class="hint">Stable per-user id. <code>objectGUID</code> (AD) or <code>entryUUID</code> (OpenLDAP).</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Group Attribute</label>' +
        '<input type="text" id="f-ldap-group-attr" value="' + escapeHtml(s.groupAttribute || "memberOf") + '">' +
        '<p class="hint">Multi-valued group DNs on the user entry. <code>memberOf</code> on AD.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Group Search Base <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
        '<input type="text" id="f-ldap-group-base" value="' + escapeHtml(s.groupBaseDn || "") + '" placeholder="e.g. OU=Groups,DC=corp,DC=local">' +
        '<p class="hint">Reverse member search to catch groups not in <code>memberOf</code>. Leave blank to skip.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Group Filter <span style="color:var(--color-text-tertiary)">(optional)</span></label>' +
        '<input type="text" id="f-ldap-group-filter" value="' + escapeHtml(s.groupFilter || "(member={{userDn}})") + '">' +
        '<p class="hint">Used with the group search base. <code>{{userDn}}</code> is the user\'s DN.</p>' +
      '</div>' +
    '</div>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin-top:0.5rem">Map LDAP group DNs to roles + tags in <strong>Group Mappings</strong>. Group identifiers match on the full DN (lowercased).</p>' +
    '<div id="ldap-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';
}

function buildEntraProxyTab(s) {
  var ips = (s.trustedSourceIps || []).join("\n");
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">Sign users in from identity headers injected by <strong>Microsoft Entra Application Proxy</strong> header-based SSO. Users pre-authenticated by Entra are logged in automatically (no second sign-in).</p>' +
    '<div style="background:rgba(234,179,8,0.10);border:1px solid rgba(234,179,8,0.35);border-radius:6px;padding:0.6rem 0.75rem;margin-bottom:1.1rem;font-size:0.8rem;color:var(--color-text-secondary)">' +
      '⚠️ <strong>These headers are unsigned.</strong> The only thing preventing spoofing is source-IP trust — Polaris honors the identity headers <em>only</em> from the addresses below and strips them from every other request. Make sure the backend is reachable <em>only</em> through the App Proxy connector (and your nginx). Entra also silently omits the groups header when a user is in more than ~150 groups unless the app is configured with “groups assigned to the application.”' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-entra-proxy-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Enable App Proxy header authentication</span>' +
      '</label>' +
    '</div>' +
    '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
    '<div class="form-group">' +
      '<label>Trusted source IPs / CIDRs</label>' +
      '<textarea id="f-entra-proxy-trusted-ips" rows="3" style="font-family:monospace;font-size:0.8rem;resize:vertical" placeholder="10.20.30.40&#10;10.20.30.0/24">' + escapeHtml(ips) + '</textarea>' +
      '<p class="hint">One IP or CIDR per line — the App Proxy connector host(s) <strong>as Polaris sees them</strong> (behind nginx, the address nginx forwards). Empty = header login is disabled. Use the <strong>Test</strong> button below to see this request\'s source address.</p>' +
    '</div>' +
    '<h4 style="font-size:0.88rem;font-weight:600;margin:1.25rem 0 0.75rem;color:var(--color-text-primary);border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">Header Mapping</h4>' +
    '<p style="font-size:0.8rem;color:var(--color-text-tertiary);margin-bottom:0.75rem">The header names you configure in the App Proxy SSO blade. Lowercase, letters/digits/hyphens only.</p>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 16px">' +
      '<div class="form-group">' +
        '<label>Object ID header *</label>' +
        '<input type="text" id="f-entra-proxy-objectid-header" value="' + escapeHtml(s.objectIdHeader || "x-entra-object-id") + '">' +
        '<p class="hint">Carries the Entra user object ID (GUID) — the account key.</p>' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Username / UPN header *</label>' +
        '<input type="text" id="f-entra-proxy-username-header" value="' + escapeHtml(s.usernameHeader || "x-entra-upn") + '">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Email header</label>' +
        '<input type="text" id="f-entra-proxy-email-header" value="' + escapeHtml(s.emailHeader || "") + '" placeholder="(optional)">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Display name header</label>' +
        '<input type="text" id="f-entra-proxy-displayname-header" value="' + escapeHtml(s.displayNameHeader || "") + '" placeholder="(optional)">' +
      '</div>' +
      '<div class="form-group">' +
        '<label>Groups header</label>' +
        '<input type="text" id="f-entra-proxy-groups-header" value="' + escapeHtml(s.groupsHeader || "") + '" placeholder="(optional)">' +
        '<p class="hint">Comma/semicolon-separated Entra group object IDs (GUIDs). Map them to roles + tags in <strong>Group Mappings</strong> (provider “App Proxy”).</p>' +
      '</div>' +
    '</div>' +
    '<div id="entra-proxy-test-results" style="display:none;margin-top:1rem;padding:0.75rem;border-radius:6px;font-size:0.85rem"></div>';
}

/**
 * The Settings tab — everything about signing in that is not tied to one
 * identity provider. Four sections, in the order an admin thinks about them:
 * session behaviour, the password bar, which networks may reach local login,
 * and passkeys.
 *
 * Renamed from "Session" (2026-09) when the last three moved in. The host ACL
 * is NOT a new setting: it is `loginAccessConfig`, the same row Server
 * Settings → Web Server used to edit, surfaced where the rest of authentication
 * lives so there is one place to reason about who can log in and how. Server
 * Settings now points here rather than keeping a second editor for one row.
 */
function buildSettingsTab(s, policy, loginAccess, passkeys) {
  return sectionHeading("Session", true) + buildSessionSection(s) +
    sectionHeading("Password Complexity") + buildPasswordPolicySection(policy) +
    sectionHeading("Trusted Networks for Login") + buildLoginAccessSection(loginAccess) +
    sectionHeading("Passkeys") + buildPasskeySection(passkeys);
}

function sectionHeading(text, first) {
  return '<h4 style="font-size:0.88rem;font-weight:600;margin:' + (first ? "0" : "1.75rem") + ' 0 0.75rem;color:var(--color-text-primary);' +
    'border-bottom:1px solid var(--color-border);padding-bottom:0.4rem">' + escapeHtml(text) + '</h4>';
}

/**
 * The complexity bar. Defaults are the five rules Polaris has always enforced,
 * so an admin who opens this and saves without touching anything changes
 * nothing.
 *
 * The two radios are the question the admin has to answer whenever they tighten
 * the rules — existing passwords cannot be re-checked against a policy (a hash
 * is one-way), so the only moment to act on one is the next time its owner
 * types it. Leaving the choice implicit is how an install ends up either
 * silently unenforced or unexpectedly interrupting every sign-in.
 */
function buildPasswordPolicySection(p) {
  function toggle(id, label, checked) {
    return '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer;margin-bottom:0.35rem">' +
      '<input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '>' +
      '<span>' + label + '</span>' +
    '</label>';
  }
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Applies to local accounts: the admin “Add User” and “Reset Password” forms, a user changing their own password, ' +
      'and the first admin created by the setup wizard. Accounts from SSO or LDAP are governed by their identity provider.' +
    '</p>' +
    '<div class="form-group">' +
      '<label>Minimum length</label>' +
      '<div style="display:flex;align-items:center;gap:0.5rem">' +
        '<input type="number" id="f-pw-min-length" min="8" max="128" value="' + (p.minLength || 8) + '" style="width:80px">' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">characters</span>' +
      '</div>' +
      '<p class="hint">8 is the floor — NIST SP 800-63B\'s minimum for a memorized secret, and not something this field will go below.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Required characters</label>' +
      toggle("f-pw-lower", "Lowercase letter", p.requireLowercase) +
      toggle("f-pw-upper", "Uppercase letter", p.requireUppercase) +
      toggle("f-pw-number", "Number", p.requireNumber) +
      toggle("f-pw-special", "Special character", p.requireSpecial) +
      '<p class="hint">Turning all four off leaves length as the only rule — a legitimate posture (NIST discourages mandatory composition rules), not a misconfiguration.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Existing passwords</label>' +
      '<label style="display:flex;align-items:flex-start;gap:0.5rem;cursor:pointer;margin-bottom:0.35rem">' +
        '<input type="radio" name="pw-existing" id="f-pw-existing-keep" value="keep"' + (p.forceChangeOnLogin ? '' : ' checked') + ' style="margin-top:0.25rem">' +
        '<span>Apply to new passwords only<br><span class="hint" style="margin:0">Passwords already set keep working until their owner changes them.</span></span>' +
      '</label>' +
      '<label style="display:flex;align-items:flex-start;gap:0.5rem;cursor:pointer">' +
        '<input type="radio" name="pw-existing" id="f-pw-existing-force" value="force"' + (p.forceChangeOnLogin ? ' checked' : '') + ' style="margin-top:0.25rem">' +
        '<span>Require a change at next sign-in<br><span class="hint" style="margin:0">A local user whose password fails these rules must set a new one before they get a session — after their second factor, never instead of it.</span></span>' +
      '</label>' +
    '</div>';
}

/**
 * The host ACL. Mirrors the Server Settings card it replaces, including the
 * observed caller IP — which is the whole point of showing this in a UI: the
 * gate compares Express's `req.ip`, and behind two proxies with a one-hop trust
 * setting that is the INNER proxy's address, so an "RFC1918 only" scope can
 * admit the entire internet while reading as enforced.
 */
function buildLoginAccessSection(la) {
  var s = (la && la.settings) || { enabled: false, ipScope: "rfc1918", allowedCidrs: [] };
  var callerIp = (la && la.callerIp) || "";
  var cidrs = (s.allowedCidrs || []).join("\n");
  function opt(value, label) {
    return '<option value="' + value + '"' + (s.ipScope === value ? ' selected' : '') + '>' + label + '</option>';
  }
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'Restricts which source networks may reach the local login form and the password endpoints. Covers local ' +
      '<strong>and LDAP</strong> sign-in — both arrive on the same request — and deliberately leaves every SSO path alone, ' +
      'since SSO is the route that has to keep working from anywhere. Off by default.' +
    '</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-la-enabled"' + (s.enabled ? ' checked' : '') + '>' +
        '<span>Restrict local login by source IP</span>' +
      '</label>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Allowed sources</label>' +
      '<select id="f-la-scope">' +
        opt("rfc1918", "Private networks (RFC1918) + loopback") +
        opt("custom", "Specific networks only") +
        opt("all", "Anywhere (no restriction)") +
      '</select>' +
    '</div>' +
    '<div class="form-group" id="f-la-cidrs-group">' +
      '<label>Trusted subnets / addresses</label>' +
      '<textarea id="f-la-cidrs" rows="4" style="font-family:monospace;font-size:0.8rem;resize:vertical" placeholder="10.0.0.0/8&#10;192.168.10.0/24&#10;203.0.113.5">' + escapeHtml(cidrs) + '</textarea>' +
      '<p class="hint">One per line — IPv4 CIDR (<code>10.0.0.0/8</code>) or a bare address (<code>203.0.113.5</code>). Used only with “Specific networks only”.</p>' +
    '</div>' +
    '<p class="hint" style="margin-top:-0.4rem">' +
      'Polaris sees this request coming from <code>' + escapeHtml(callerIp || "unknown") + '</code>. ' +
      'If that is a proxy rather than your workstation, fix <code>TRUST_PROXY</code> before relying on this — ' +
      'a scope that matches the proxy matches everyone behind it. Saving a scope that excludes your own address is refused.' +
    '</p>';
}

/**
 * Passkeys. The mode radio is the admin-selectable part: a passkey can be a
 * way IN, a second factor, both, or nothing.
 */
function buildPasskeySection(pk) {
  var s = (pk && pk.settings) || { mode: "both", rpId: "", requireUserVerification: true };
  var av = (pk && pk.availability) || {};
  function mode(value, label, detail) {
    return '<label style="display:flex;align-items:flex-start;gap:0.5rem;cursor:pointer;margin-bottom:0.35rem">' +
      '<input type="radio" name="pk-mode" value="' + value + '"' + (s.mode === value ? ' checked' : '') + ' style="margin-top:0.25rem">' +
      '<span>' + label + '<br><span class="hint" style="margin:0">' + detail + '</span></span>' +
    '</label>';
  }
  var unavailable = av.unavailableReason
    ? '<p class="hint" style="color:var(--color-warning,#f0a020)"><strong>Not usable at this address:</strong> ' + escapeHtml(av.unavailableReason) + '</p>'
    : '<p class="hint">Passkeys on this address register against the domain <code>' + escapeHtml(av.rpId || "") + '</code>.</p>';

  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
      'A passkey is a key pair held by the browser, phone or security key — unphishable, and nothing to type. ' +
      'Local accounts only; users enroll their own from the account menu. Registering one never removes the password.' +
    '</p>' +
    unavailable +
    '<div class="form-group">' +
      '<label>How passkeys may be used</label>' +
      mode("both", "Sign-in and second factor", "Users choose per sign-in. A user who has registered one must use it — as the whole login, or after their password.") +
      mode("login", "Sign-in only", "A passkey replaces the password. Password sign-in stays available and stays single-step.") +
      mode("second-factor", "Second factor only", "Password first, then the passkey instead of an authenticator code.") +
      mode("off", "Disabled", "No registration, no passkey sign-in. Credentials already registered are kept but authenticate nothing.") +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-pk-uv"' + (s.requireUserVerification ? ' checked' : '') + '>' +
        '<span>Require user verification (PIN, fingerprint, face)</span>' +
      '</label>' +
      '<p class="hint">This is what makes a passkey two factors in one gesture, and why a passkey sign-in skips the authenticator code. Turn it off and a passkey proves possession alone.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Passkey domain</label>' +
      '<input type="text" id="f-pk-rpid" value="' + escapeHtml(s.rpId || "") + '" placeholder="(derive from the address in the browser)">' +
      '<p class="hint">Leave blank unless users reach Polaris by more than one name. A passkey works only at the domain it was registered to, so a shared parent domain (<code>example.com</code>) lets one passkey serve <code>polaris.example.com</code> and <code>ipam.example.com</code> — at the cost of scoping it to that whole domain.</p>' +
    '</div>';
}

function buildSessionSection(s) {
  // Turning "Skip login page" ON is only permitted while the admin is signed in
  // through SSO (SAML or OIDC) — end-to-end proof that SSO works before the
  // local login page is hidden, so an SSO misconfiguration can't lock everyone
  // out. The server enforces this on save; we mirror it here. Turning it OFF is
  // always allowed, so the checkbox is only locked when it's currently off.
  var ssoSession = (typeof currentUserAuthProvider !== "undefined") &&
    (currentUserAuthProvider === "azure" || currentUserAuthProvider === "oidc");
  var lockOn = !ssoSession && !s.skipLoginPage;
  var hint = lockOn
    ? "You are signed in with a local account. To enable this, sign in through SSO (SAML or OIDC) first — this prevents locking everyone out if SSO is misconfigured."
    : "Redirect unauthenticated users straight to SSO. Requires a SAML or OIDC provider to be configured.";
  // Spell out what "skip" does to the accounts that don't use SSO. Since
  // 2026-09-06 it hides the form on /login.html too (app.ts redirects the bare
  // URL to SSO), but not the recovery path: local and LDAP users still reach
  // it at /login.html?local=1 — which is also the way back in when the
  // identity provider is down, so it must not read as "disabled".
  var skipNote =
    'While this is on, anyone visiting a Polaris page — the login page included — is sent straight to SSO and never sees the login form. ' +
    'Local and LDAP accounts can still sign in, but only by browsing directly to <code>/login.html?local=1</code> — ' +
    'keep that URL somewhere your admins can find it, since it is the way back in if SSO is down. ' +
    'To limit which networks may reach it, see <em>Trusted Networks for Login</em> further down this tab.';
  return '<p style="font-size:0.85rem;color:var(--color-text-secondary);margin-bottom:1.25rem">Configure session behavior for all authentication methods.</p>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:' + (lockOn ? 'not-allowed' : 'pointer') + '">' +
        '<input type="checkbox" id="f-skip-login"' + (s.skipLoginPage ? ' checked' : '') + (lockOn ? ' disabled' : '') + '>' +
        '<span>Skip login page (SSO only)</span>' +
      '</label>' +
      '<p class="hint" style="margin:0.35rem 0 0 1.5rem">' + hint + '</p>' +
      '<p class="hint" style="margin:0.35rem 0 0 1.5rem">' + skipNote + '</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Auto-logout after inactivity</label>' +
      '<div style="display:flex;align-items:center;gap:0.5rem">' +
        '<input type="number" id="f-auto-logout" min="0" max="1440" value="' + (s.autoLogoutMinutes || 0) + '" style="width:80px">' +
        '<span style="font-size:0.85rem;color:var(--color-text-secondary)">minutes</span>' +
      '</div>' +
      '<p class="hint">Set to 0 to disable. Maximum 1440 minutes (24 hours).</p>' +
    '</div>';
}

function copyField(id, btn) {
  var input = document.getElementById(id);
  copyTextToClipboard(input.value).then(function (ok) {
    if (!ok) return;
    var orig = btn.textContent;
    btn.textContent = "Copied!";
    setTimeout(function () { btn.textContent = orig; }, 1500);
  });
}

// ─── Password Complexity ──────────────────────────────────────────────────
//
// The rules and their checklist live in public/js/password-self.js, which is
// loaded on every page because the account menu's Change Password modal needs
// them too. These five names are the call sites this page already had; they
// forward, so there is one copy of the regexes on the client and one
// `passwordPolicySchema` on the server to match it against.

function passwordChecksHTML(containerId) { return PolarisPasswordSelf.rulesHTML(containerId); }
function wirePasswordChecks(inputId, containerId) { PolarisPasswordSelf.wire(inputId, containerId); }
function checkPasswordField(pw, containerId) { return PolarisPasswordSelf.check(pw, containerId); }
function passwordMatchHTML(containerId) { return PolarisPasswordSelf.matchHTML(containerId); }
function wirePasswordMatch(pwId, confirmId, containerId) { PolarisPasswordSelf.wireMatch(pwId, confirmId, containerId); }
function checkPasswordMatch(pw, confirm, containerId) { return PolarisPasswordSelf.checkMatch(pw, confirm, containerId); }

// ─── Roles section ─────────────────────────────────────────────────────────

async function loadRoles() {
  var section = document.getElementById("roles-section");
  if (!section) return;
  // Roles management is admin-only. The backend will 403 non-admin callers;
  // hiding the section client-side avoids a misleading empty card.
  if (typeof isAdmin === "function" && !isAdmin()) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  var tbody = document.getElementById("roles-tbody");
  try {
    _rolesRaw = await api.roles.list();
    _rolesById = {};
    _rolesRaw.forEach(function (r) { _rolesById[r.id] = r; });
    if (!_matrixSpec) {
      try { _matrixSpec = await api.roles.functions(); } catch (_) { _matrixSpec = null; }
    }
    renderRolesBody();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function renderRolesBody() {
  var tbody = document.getElementById("roles-tbody");
  // Hide the two protected built-ins (admin + readonly) from the editable
  // list — they're always-locked-and-pre-populated by definition. Custom
  // roles + the three editable built-ins (networkadmin / assetsadmin /
  // user) show up here.
  var visible = _rolesRaw.filter(function (r) { return !r.isProtected; });
  if (visible.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="empty-state">No editable roles. Click "+ Add Role" to create one.</td></tr>';
    return;
  }
  visible.sort(function (a, b) {
    // Built-ins first, then custom; alphabetical within each tier.
    if (a.isBuiltIn !== b.isBuiltIn) return a.isBuiltIn ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  tbody.innerHTML = visible.map(function (r) {
    var swatch = r.color
      ? '<span title="Badge color" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + escapeHtml(r.color) + ';margin-right:7px;vertical-align:middle;border:1px solid var(--color-border)"></span>'
      : '';
    // The name was already a button that jumped straight to Edit; it now opens
    // the row's menu, with Edit as the first item so that path is one extra key
    // or click rather than gone.
    var nameCell = swatch + '<button type="button" class="row-menu-trigger role-menu" data-role-id="' + escapeHtml(r.id) + '"' +
      ' aria-haspopup="menu" aria-expanded="false" title="Actions for this role"' +
      ' style="font-weight:600;vertical-align:middle">' + escapeHtml(r.name) + '</button>';
    var descCell = '<span style="color:var(--color-text-secondary);font-size:0.88em">' + escapeHtml(r.description || "—") + '</span>';
    var usersCell = '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-primary)">' + r.userCount + '</span>';
    var builtInCell = r.isBuiltIn
      ? '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-secondary)">Built-in</span>'
      : '<span style="color:var(--color-text-tertiary)">—</span>';
    return '<tr>' +
      '<td>' + nameCell + '</td>' +
      '<td>' + descCell + '</td>' +
      '<td>' + usersCell + '</td>' +
      '<td>' + builtInCell + '</td>' +
      '</tr>';
  }).join("");
}

/** Verbs for one role row. Delete stays PRESENT but disabled when it can't
 *  apply, carrying the reason as its tooltip — the old button row did the same,
 *  and hiding it would leave an admin wondering where the action went. */
function _roleMenuItems(r) {
  var blocked = r.isBuiltIn ? "Built-in roles cannot be deleted"
    : r.userCount > 0 ? "Reassign users first"
    : null;
  return [
    { label: "Edit…", onSelect: function () { openRoleSlideover(r.id); } },
    { separator: true },
    { label: "Delete", danger: !blocked, disabled: !!blocked, title: blocked || undefined, onSelect: function () { confirmDeleteRole(r.id); } },
  ];
}

async function confirmDeleteRole(id) {
  var role = _rolesById[id];
  if (!role) return;
  var ok = await showConfirm('Delete role "' + role.name + '"? This cannot be undone.');
  if (!ok) return;
  try {
    await api.roles.delete(id);
    showToast("Role deleted");
    loadRoles();
  } catch (err) {
    showToast(err.message, "error");
  }
}

// ─── Group Mappings section ─────────────────────────────────────────────────

var _GM_PROVIDERS = [
  { value: "oidc", label: "OIDC" },
  { value: "ldap", label: "LDAP" },
  { value: "saml", label: "SAML" },
  { value: "entra-proxy", label: "App Proxy" },
];

async function loadGroupMappings() {
  var section = document.getElementById("group-mappings-section");
  if (!section) return;
  // Admin-only (gated server-side on users=fullwrite); hide for everyone else.
  if (typeof isAdmin === "function" && !isAdmin()) {
    section.style.display = "none";
    return;
  }
  section.style.display = "";
  var tbody = document.getElementById("group-mappings-tbody");
  try {
    _groupMappingsRaw = await api.groupMappings.list();
    _groupMappingsById = {};
    _groupMappingsRaw.forEach(function (m) { _groupMappingsById[m.id] = m; });
    renderGroupMappingsBody();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Error: ' + escapeHtml(err.message) + '</td></tr>';
  }
}

function gmTagsCell(m) {
  var parts = [];
  (m.regionTags || []).forEach(function (t) {
    parts.push('<span class="badge" style="background:rgba(74,158,255,0.12);color:var(--color-primary,#4a9eff);border:1px solid rgba(74,158,255,0.35);margin:0.1rem 0.2rem 0.1rem 0">' + escapeHtml(t) + '</span>');
  });
  (m.otherTags || []).forEach(function (t) {
    parts.push('<span class="badge" style="background:rgba(158,158,158,0.14);color:var(--color-text-secondary);border:1px solid rgba(158,158,158,0.4);margin:0.1rem 0.2rem 0.1rem 0">' + escapeHtml(t) + '</span>');
  });
  return parts.length ? parts.join("") : '<span style="color:var(--color-text-tertiary)">—</span>';
}

function renderGroupMappingsBody() {
  var tbody = document.getElementById("group-mappings-tbody");
  if (!_groupMappingsRaw.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">No group mappings. Click "+ Add Mapping" to map an IdP group to a role + tags.</td></tr>';
    return;
  }
  tbody.innerHTML = _groupMappingsRaw.map(function (m) {
    var role = m.roleName ? escapeHtml(m.roleName) : '<span style="color:var(--color-text-tertiary)">(tags only)</span>';
    var enabled = m.enabled
      ? '<span class="badge" style="background:rgba(34,197,94,0.14);color:#22c55e;border:1px solid rgba(34,197,94,0.4)">Enabled</span>'
      : '<span class="badge" style="background:rgba(158,158,158,0.14);color:var(--color-text-tertiary);border:1px solid rgba(158,158,158,0.4)">Disabled</span>';
    return '<tr>' +
      '<td style="text-transform:uppercase;font-size:0.75rem;font-weight:600">' + escapeHtml(m.provider) + '</td>' +
      '<td style="word-break:break-all">' +
        '<button type="button" class="row-menu-trigger gm-menu" data-gm-id="' + m.id + '"' +
          ' aria-haspopup="menu" aria-expanded="false" title="Actions for this mapping"' +
          ' style="white-space:normal;text-align:left">' + escapeHtml(m.groupLabel || m.groupKey) + '</button>' +
        (m.description ? '<div class="hint" style="margin:0.15rem 0 0">' + escapeHtml(m.description) + '</div>' : '') +
      '</td>' +
      '<td>' + role + '</td>' +
      '<td>' + gmTagsCell(m) + '</td>' +
      '<td>' + enabled + '</td>' +
    '</tr>';
  }).join("");
}

async function confirmDeleteGroupMapping(id) {
  var m = _groupMappingsById[id];
  if (!m) return;
  var ok = await showConfirm('Delete the ' + m.provider + ' group mapping for "' + (m.groupLabel || m.groupKey) + '"?');
  if (!ok) return;
  try {
    await api.groupMappings.delete(id);
    showToast("Group mapping deleted");
    loadGroupMappings();
  } catch (err) {
    showToast(err.message, "error");
  }
}

async function openGroupMappingSlideover(id) {
  // Ensure the role list is loaded for the dropdown.
  if (!_rolesRaw || !_rolesRaw.length) {
    try { _rolesRaw = await api.roles.list(); _rolesRaw.forEach(function (r) { _rolesById[r.id] = r; }); } catch (_) {}
  }
  var m = id ? _groupMappingsById[id] : null;
  var isCreate = !m;
  var provider = m ? m.provider : "oidc";

  var providerOpts = _GM_PROVIDERS.map(function (p) {
    return '<option value="' + p.value + '"' + (provider === p.value ? " selected" : "") + '>' + p.label + '</option>';
  }).join("");
  var roleOpts = '<option value="">(tags only — no role)</option>' +
    _rolesRaw.map(function (r) {
      return '<option value="' + r.id + '"' + (m && m.roleId === r.id ? " selected" : "") + '>' + escapeHtml(r.name) + '</option>';
    }).join("");

  var groupHint = 'For LDAP, enter the full group DN (matched case-insensitively). For OIDC/SAML, enter the group claim value exactly. <strong>Azure AD emits group object IDs (GUIDs)</strong> — use the object ID unless your IdP emits names. For <strong>App Proxy</strong>, enter the Entra group object ID (GUID; matched case-insensitively) exactly as it appears in the App Proxy group header.';

  var body =
    '<div class="form-group">' +
      '<label>Provider</label>' +
      '<select id="f-gm-provider"' + (isCreate ? "" : " disabled") + '>' + providerOpts + '</select>' +
      (isCreate ? '' : '<p class="hint">Provider can\'t be changed after creation.</p>') +
    '</div>' +
    '<div class="form-group">' +
      '<label>Group Identifier *</label>' +
      '<input type="text" id="f-gm-group" value="' + escapeHtml(m ? (m.groupLabel || m.groupKey) : "") + '" placeholder="CN=NetAdmins,OU=Groups,DC=corp,DC=local or a group name/object-id">' +
      '<p class="hint">' + groupHint + '</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Role</label>' +
      '<select id="f-gm-role">' + roleOpts + '</select>' +
      '<p class="hint">Highest-privilege role wins when a user is in multiple mapped groups.</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label>Region Scope</label>' +
      regionPickerHtml("f-gm-regions", m ? (m.regionTags || []) : []) +
    '</div>' +
    '<div class="form-group">' +
      '<label>Tags</label>' +
      otherTagsPickerHtml("f-gm-other", m ? (m.otherTags || []) : []) +
    '</div>' +
    '<div class="form-group">' +
      '<label>Description</label>' +
      '<input type="text" id="f-gm-description" value="' + escapeHtml(m && m.description ? m.description : "") + '" maxlength="200" placeholder="Optional note">' +
    '</div>' +
    '<div class="form-group">' +
      '<label style="display:flex;align-items:center;gap:0.5rem;cursor:pointer">' +
        '<input type="checkbox" id="f-gm-enabled"' + (!m || m.enabled ? " checked" : "") + '><span>Enabled</span>' +
      '</label>' +
    '</div>';
  var footer = '<button class="btn btn-secondary" id="btn-cancel">Cancel</button>' +
    '<button class="btn btn-primary" id="btn-save">' + (isCreate ? "Create Mapping" : "Save Changes") + '</button>';
  openModal(isCreate ? "Add Group Mapping" : "Edit Group Mapping", body, footer);
  document.getElementById("btn-cancel").addEventListener("click", closeModal);
  document.getElementById("btn-save").addEventListener("click", async function () {
    var btn = this;
    var groupKey = (document.getElementById("f-gm-group").value || "").trim();
    if (!groupKey) { showToast("Group identifier is required", "error"); return; }
    var payload = {
      groupKey: groupKey,
      roleId: document.getElementById("f-gm-role").value || null,
      regionTags: collectRegionPicker("f-gm-regions"),
      otherTags: collectOtherTags("f-gm-other"),
      description: (document.getElementById("f-gm-description").value || "").trim() || null,
      enabled: document.getElementById("f-gm-enabled").checked,
    };
    btn.disabled = true;
    try {
      if (isCreate) {
        payload.provider = document.getElementById("f-gm-provider").value;
        await api.groupMappings.create(payload);
        showToast("Group mapping created");
      } else {
        await api.groupMappings.update(m.id, payload);
        showToast("Group mapping saved");
      }
      closeModal();
      loadGroupMappings();
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// ─── Permissions slide-over ────────────────────────────────────────────────

var _PERM_LEVELS = ["none", "read", "write", "fullwrite"];
var _PERM_LABELS = { none: "No Access", read: "Read-Only", write: "Read-Write", fullwrite: "Full Read-Write" };
var _PERM_RANK_UI = { none: 0, read: 1, write: 2, fullwrite: 3 };

// A function key may declare a SHORTER ladder than the four columns — a key
// that is read-only by nature (Asset Probes: a probe reads the device and
// writes nothing in Polaris) has no meaning above Read, and offering the
// cell put a radio there that no route ever asks for. The catalogue says so
// per key via `levels` on GET /roles/functions; a key without the field
// holds the full ladder. Server-side, normalizePermissions clamps the same
// way, so what this hides cannot be stored by another client either.
function _permLevelsFor(f) {
  return (f && f.levels && f.levels.length) ? f.levels : _PERM_LEVELS;
}
function _permKeySupports(f, lvl) {
  return _permLevelsFor(f).indexOf(lvl) !== -1;
}
// Highest level the key supports that is no higher than `lvl` — used by the
// bulk "set every row to" control so a narrow key follows the operator's
// intent downward instead of silently keeping its old value.
function _permClampToKey(f, lvl) {
  var allowed = _permLevelsFor(f);
  if (allowed.indexOf(lvl) !== -1) return lvl;
  var best = "none";
  for (var i = 0; i < allowed.length; i++) {
    var c = allowed[i];
    if (_PERM_RANK_UI[c] <= _PERM_RANK_UI[lvl] && _PERM_RANK_UI[c] >= _PERM_RANK_UI[best]) best = c;
  }
  return best;
}

async function openRoleSlideover(roleId) {
  if (!_matrixSpec) {
    try { _matrixSpec = await api.roles.functions(); }
    catch (err) { showToast("Could not load permission catalogue: " + err.message, "error"); return; }
  }
  var role = roleId ? _rolesById[roleId] : null;
  var isCreate = !role;
  var isProtected = !!(role && role.isProtected);
  var permissions = role ? Object.assign({}, role.permissions) : {};
  // Pre-fill new roles with all-none. Clamping a stored value into its key's
  // ladder happens in buildRoleSlideoverHtml, so every caller of the builder
  // gets it.
  _matrixSpec.functions.forEach(function (f) {
    if (!(f.key in permissions)) permissions[f.key] = "none";
  });

  var mount = document.getElementById("role-slideover-mount");
  if (!mount) return;
  mount.innerHTML = buildRoleSlideoverHtml(role, isCreate, isProtected, permissions);

  var overlay = document.getElementById("role-slideover-overlay");
  var panel = document.getElementById("role-slideover-panel");
  if (typeof initSlideoverResize === "function") {
    initSlideoverResize(panel, "polaris.panel.width.role-permissions");
  }
  revealOverlay(overlay);

  overlay.addEventListener("click", function (e) {
    if (e.target === overlay) closeRoleSlideover();
  });
  document.getElementById("role-slideover-close").addEventListener("click", closeRoleSlideover);
  document.getElementById("role-slideover-cancel").addEventListener("click", closeRoleSlideover);

  // "Set all to …" bulk action
  document.getElementById("role-bulk-set").addEventListener("change", function () {
    var lvl = this.value;
    if (!lvl) return;
    _matrixSpec.functions.forEach(function (f) {
      var target = _permClampToKey(f, lvl);
      var radio = document.querySelector('input[type="radio"][name="perm-' + f.key + '"][value="' + target + '"]');
      if (radio && !radio.disabled) radio.checked = true;
    });
    this.value = "";
  });

  // Color picker: live-preview the badge as the color or name changes, and
  // re-roll on "Randomize". Inert for protected roles (input disabled).
  var colorInput = document.getElementById("f-role-color");
  var colorPreview = document.getElementById("role-color-preview");
  var nameInput = document.getElementById("f-role-name");
  function syncColorPreview() {
    if (!colorPreview) return;
    var style = roleBadgeStyleFromColor(colorInput ? colorInput.value : null);
    if (style) colorPreview.setAttribute("style", style);
    var nm = nameInput ? nameInput.value.trim() : "";
    colorPreview.textContent = nm || "preview";
  }
  if (colorInput) colorInput.addEventListener("input", syncColorPreview);
  if (nameInput) nameInput.addEventListener("input", syncColorPreview);
  var randomBtn = document.getElementById("f-role-color-random");
  if (randomBtn) randomBtn.addEventListener("click", function () {
    if (colorInput) colorInput.value = randomRoleColor();
    syncColorPreview();
  });

  if (isProtected) {
    // Don't expose Save for protected roles — read-only view.
    var saveBtn = document.getElementById("role-slideover-save");
    if (saveBtn) saveBtn.style.display = "none";
    return;
  }

  document.getElementById("role-slideover-save").addEventListener("click", async function () {
    var btn = this;
    var name = (document.getElementById("f-role-name").value || "").trim();
    var description = (document.getElementById("f-role-description").value || "").trim();
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(name)) {
      showToast("Role name must be 2-32 chars: letters / digits / dash / underscore", "error");
      return;
    }
    var perms = {};
    _matrixSpec.functions.forEach(function (f) {
      var checked = document.querySelector('input[type="radio"][name="perm-' + f.key + '"]:checked');
      perms[f.key] = checked ? checked.value : "none";
    });
    var regionTags = collectRegionPicker("f-role-regions");
    var otherTags = collectOtherTags("f-role-other");
    var colorEl = document.getElementById("f-role-color");
    var color = colorEl ? colorEl.value : null;
    btn.disabled = true;
    try {
      if (isCreate) {
        await api.roles.create({ name: name, description: description, permissions: perms, regionTags: regionTags, otherTags: otherTags, color: color });
        showToast('Role "' + name + '" created');
      } else {
        await api.roles.update(role.id, { name: name, description: description, permissions: perms, regionTags: regionTags, otherTags: otherTags, color: color });
        showToast('Role "' + name + '" saved');
      }
      closeRoleSlideover();
      loadRoles();
      loadUsers();  // user-list role badges may rename if a built-in name changed
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  });
}

function closeRoleSlideover() {
  var overlay = document.getElementById("role-slideover-overlay");
  if (!overlay) return;
  overlay.classList.remove("open");
  setTimeout(function () {
    var mount = document.getElementById("role-slideover-mount");
    if (mount) mount.innerHTML = "";
  }, 250);
}

function buildRoleSlideoverHtml(role, isCreate, isProtected, permissions) {
  var titleText = isCreate ? "New Role" : ("Role: " + (role ? role.name : ""));
  var builtInBadge = role && role.isBuiltIn ? ' <span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-secondary);font-size:0.7em">Built-in</span>' : "";
  var protectedBadge = isProtected ? ' <span class="badge" style="background:rgba(239,68,68,0.15);color:var(--color-danger);font-size:0.7em">Locked</span>' : "";
  var userCountMeta = role ? (role.userCount + " user(s) hold this role") : "Not yet assigned";

  var matrixRows = _matrixSpec.functions.map(function (f) {
    // Clamp into the key's ladder HERE rather than only in the caller: a
    // role stored before a key narrowed (assetsProbe=write) would otherwise
    // select no radio in its row, and the save would collect that as "none" —
    // a silent revocation instead of the fold-down the server applies on read.
    var current = _permClampToKey(f, permissions[f.key] || "none");
    var cells = _PERM_LEVELS.map(function (lvl) {
      // A level outside this key's ladder gets a dash, not a radio — see
      // _permLevelsFor. The cell still renders so the columns stay aligned.
      if (!_permKeySupports(f, lvl)) {
        return '<td style="text-align:center;color:var(--color-text-tertiary)" ' +
          'title="' + escapeHtml(_PERM_LABELS[lvl]) + ' does not apply to ' + escapeHtml(f.label) + '">&mdash;</td>';
      }
      var disabled = isProtected ? " disabled" : "";
      var checked = current === lvl ? " checked" : "";
      return '<td style="text-align:center">' +
        '<label style="cursor:' + (isProtected ? "default" : "pointer") + ';display:inline-flex;align-items:center;justify-content:center;width:100%;height:100%;padding:0.5rem 0">' +
          '<input type="radio" name="perm-' + escapeHtml(f.key) + '" value="' + lvl + '"' + checked + disabled + '>' +
        '</label>' +
      '</td>';
    }).join("");
    var ownershipNote = f.hasOwnershipDimension
      ? ' <span title="Read-Write = create/edit/delete your own rows only; Full Read-Write = create/edit/delete any row" style="color:var(--color-text-tertiary);font-size:0.85em">(Read-Write = own · Full Read-Write = any)</span>'
      : '';
    return '<tr>' +
      '<td>' +
        '<div style="font-weight:600">' + escapeHtml(f.label) + ownershipNote + '</div>' +
        '<div style="font-size:0.78em;color:var(--color-text-tertiary)">' + escapeHtml(f.description) + '</div>' +
      '</td>' +
      cells +
    '</tr>';
  }).join("");

  var headerCells = _PERM_LEVELS.map(function (lvl) {
    return '<th style="text-align:center;font-size:0.8em">' + escapeHtml(_PERM_LABELS[lvl]) + '</th>';
  }).join("");

  var bulkSet = isProtected
    ? ''
    : '<div style="margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem">' +
        '<label style="font-size:0.85em;color:var(--color-text-secondary)">Set every row to:</label>' +
        '<select id="role-bulk-set" style="width:auto">' +
          '<option value="">—</option>' +
          _PERM_LEVELS.map(function (lvl) { return '<option value="' + lvl + '">' + escapeHtml(_PERM_LABELS[lvl]) + '</option>'; }).join("") +
        '</select>' +
      '</div>';

  var nameRow = '<div class="form-group">' +
    '<label>Name *</label>' +
    '<input type="text" id="f-role-name" maxlength="32" value="' + escapeHtml(role ? role.name : "") + '"' + (isProtected ? " disabled" : "") + '>' +
    '<p class="hint">2-32 characters; letters, digits, dash, underscore.</p>' +
  '</div>';
  var descRow = '<div class="form-group">' +
    '<label>Description</label>' +
    '<input type="text" id="f-role-description" maxlength="200" value="' + escapeHtml(role ? (role.description || "") : "") + '"' + (isProtected ? " disabled" : "") + '>' +
  '</div>';
  // New roles default to a random color; existing roles prefill their stored
  // color (or a random one if somehow unset). The native color input always
  // yields a valid #rrggbb, so it round-trips the backend regex cleanly.
  var initialColor = (role && role.color) || randomRoleColor();
  var previewLabel = (role && role.name) || "preview";
  var colorRow = '<div class="form-group">' +
    '<label>Badge Color</label>' +
    '<div style="display:flex;align-items:center;gap:0.6rem">' +
      '<input type="color" id="f-role-color" value="' + escapeHtml(initialColor) + '"' + (isProtected ? " disabled" : "") +
        ' style="width:48px;height:34px;padding:2px;border:1px solid var(--color-border);border-radius:6px;background:none;cursor:' + (isProtected ? "default" : "pointer") + '">' +
      (isProtected ? "" : '<button type="button" class="btn btn-sm btn-secondary" id="f-role-color-random">Randomize</button>') +
      '<span class="badge" id="role-color-preview" style="' + roleBadgeStyleFromColor(initialColor) + '">' + escapeHtml(previewLabel) + '</span>' +
    '</div>' +
    '<p class="hint">Pill color shown in the sidebar, the users list, and this list.</p>' +
  '</div>';
  var regionsRow = '<div class="form-group">' +
    '<label>Region Scope</label>' +
    '<p class="hint" style="margin-top:0">Empty = unrestricted. Combined with each user\'s own region tags at session time.</p>' +
    regionPickerHtml("f-role-regions", role ? (role.regionTags || []) : []) +
  '</div>' +
  '<div class="form-group">' +
    '<label>Tags</label>' +
    '<p class="hint" style="margin-top:0">Tag scope, a second dimension alongside region tags. Empty = unrestricted.</p>' +
    otherTagsPickerHtml("f-role-other", role ? (role.otherTags || []) : []) +
  '</div>';

  var footerHtml = isProtected
    ? '<button class="btn btn-secondary" id="role-slideover-cancel">Close</button>'
    : '<button class="btn btn-secondary" id="role-slideover-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="role-slideover-save">' + (isCreate ? "Create Role" : "Save Changes") + '</button>';

  return '' +
    '<div class="slideover-overlay" id="role-slideover-overlay">' +
      '<div class="slideover" id="role-slideover-panel">' +
        '<div class="slideover-resize-handle"></div>' +
        '<div class="slideover-header">' +
          '<div class="slideover-header-top">' +
            '<h3>' + escapeHtml(titleText) + builtInBadge + protectedBadge + '</h3>' +
            '<button class="btn-icon" id="role-slideover-close">&times;</button>' +
          '</div>' +
          '<div class="slideover-meta">' + escapeHtml(userCountMeta) + '</div>' +
        '</div>' +
        '<div class="slideover-body">' +
          '<div class="role-panel-content">' +
            nameRow +
            descRow +
            colorRow +
            regionsRow +
            '<hr style="border:none;border-top:1px solid var(--color-border);margin:1rem 0">' +
            '<h4 style="margin:0 0 0.5rem;font-size:0.95rem">Permissions</h4>' +
            bulkSet +
            '<div style="overflow:auto">' +
              '<table style="width:100%;border-collapse:collapse">' +
                '<thead><tr><th style="text-align:left">Function</th>' + headerCells + '</tr></thead>' +
                '<tbody>' + matrixRows + '</tbody>' +
              '</table>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="slideover-footer">' + footerHtml + '</div>' +
      '</div>' +
    '</div>';
}

// ─── Region tag picker (shared by user-regions modal + role slide-over) ──

async function loadRegionList() {
  // The fetch + the name->color map live in the shared PolarisRegionPills
  // module (region-pills.js) so the Device Map's "My regions" strip and this
  // page's pickers read one catalogue and paint one color per region. The
  // locals below stay as this page's own view of it: the picker also needs the
  // NAME list and an "is this tag in the catalogue?" test for orphan tags.
  // A failed load (region listing requires mapRegions=read) leaves both empty,
  // which degrades the picker to free text -- unchanged behavior.
  _regionByName = await window.PolarisRegionPills.load();
  _regionList = window.PolarisRegionPills.names();
  // Re-render any open user table so existing rows pick up the colors.
  if (typeof renderUsersBody === "function" && document.getElementById("users-tbody")) {
    try { renderUsersBody(); } catch (_) {}
  }
}

// Thin aliases over the shared module (region-pills.js). The stored hex, the
// neutral fallback for a tag outside the catalogue, and the hex->rgba pill
// markup all live there; these keep the existing call sites reading naturally.
function regionColorFor(name)  { return window.PolarisRegionPills.colorFor(name); }
function hexToRgbTriplet(hex)  { return window.PolarisRegionPills.rgbTriplet(hex); }
function regionPillsHtml(names, titleFor) { return window.PolarisRegionPills.html(names, titleFor); }

// Render every map-region as a clickable pill colored by the region's stored
// color. Selected pills are filled; deselected pills are an outline of the
// same color. Click toggles. Region tags previously assigned by hand that no
// longer exist in the catalogue are shown at the top in gray with a remove ×
// so admins can clean them up without losing the assignment data.
//
// Two things this must NOT do, both of which read to an operator as "my
// assignments were wiped":
//
//  - Call a tag unknown on a CASE difference. The catalogue is keyed by the
//    region's stored name, and every matcher on both sides of the wire
//    compares case-insensitively (selSet here, `normalizeNeedle` in
//    notificationRecipientService, `key()` in regionHierarchyService), so a
//    user tagged "southeast" against a region named "Southeast" is scoped
//    correctly and was being listed as an orphan AND as a selected pill.
//  - Call a tag unknown when the CATALOGUE never loaded. `GET /map/regions`
//    needs mapRegions=read, so a user administrator without it gets an empty
//    map -- which is not evidence about any tag. Absent a catalogue the
//    assignments render as neutral chips under a note saying so, because
//    "no longer in the map" would be a claim we cannot support.
function regionPickerHtml(idPrefix, selected) {
  var sel = Array.isArray(selected) ? selected.slice() : [];
  var selSet = {};
  sel.forEach(function (n) { selSet[n.toLowerCase()] = true; });

  var catalogLoaded = !!(window.PolarisRegionPills && window.PolarisRegionPills.isLoaded());
  var known = {};
  Object.keys(_regionByName).forEach(function (n) { known[n.toLowerCase()] = true; });

  // With no catalogue nothing can be judged missing, so every assignment is
  // carried in the same chip row -- kept, removable, and honestly labeled.
  var orphans = catalogLoaded
    ? sel.filter(function (n) { return !known[String(n).toLowerCase()]; })
    : sel.slice();
  var orphanNote = catalogLoaded
    ? 'Unknown region tags (no longer in the map). Click × to remove.'
    : 'Assigned region tags. The map-region list could not be read (requires Map Regions read), so these cannot be matched against it here.';
  var orphanHtml = orphans.length
    ? '<div style="margin-bottom:0.5rem">' +
        '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-bottom:0.25rem">' + escapeHtml(orphanNote) + '</div>' +
        orphans.map(function (n) {
          return '<span class="badge region-chip" data-region="' + escapeHtml(n) + '" data-selected="1" style="display:inline-flex;align-items:center;gap:0.35rem;background:rgba(158,158,158,0.18);color:#9e9e9e;border:1px solid rgba(158,158,158,0.45);padding:0.2rem 0.5rem;margin:0.15rem 0.25rem 0.15rem 0">' +
            escapeHtml(n) +
            ' <button type="button" class="region-chip-remove" aria-label="Remove" style="background:none;border:none;cursor:pointer;color:inherit;padding:0;font-size:1.1em;line-height:1">&times;</button>' +
          '</span>';
        }).join("") +
      '</div>'
    : '';

  // Same distinction: an empty catalogue is only "none drawn yet" when we
  // actually read it.
  var emptyNote = catalogLoaded
    ? 'No map regions defined yet. Create regions on the Device Map first.'
    : 'Map regions unavailable. Listing them requires Map Regions read; existing assignments above are unaffected.';
  var available = _regionList.length === 0
    ? '<div style="font-size:0.85rem;color:var(--color-text-tertiary);padding:0.5rem;border:1px dashed var(--color-border);border-radius:6px">' + escapeHtml(emptyNote) + '</div>'
    : '<div class="region-pill-grid" style="display:flex;flex-wrap:wrap;gap:0.4rem">' +
        _regionList.map(function (n) {
          var hex = regionColorFor(n);
          var rgb = hexToRgbTriplet(hex);
          var isSel = selSet[n.toLowerCase()];
          var style = isSel
            ? "background:rgba(" + rgb + ",0.22);color:" + hex + ";border:1px solid rgba(" + rgb + ",0.55)"
            : "background:transparent;color:" + hex + ";border:1px solid rgba(" + rgb + ",0.45);opacity:0.75";
          return '<button type="button" class="badge region-chip" data-region="' + escapeHtml(n) + '" data-selected="' + (isSel ? "1" : "0") + '" data-color="' + escapeHtml(hex) + '" data-rgb="' + escapeHtml(rgb) + '" style="cursor:pointer;padding:0.3rem 0.7rem;font-size:0.78rem;font-weight:600;text-transform:capitalize;' + style + '">' +
            escapeHtml(n) +
          '</button>';
        }).join("") +
      '</div>';

  return '<div id="' + idPrefix + '" class="region-picker">' +
    orphanHtml +
    available +
  '</div>';
}

// Event delegation for any region picker on the page (handles dynamic create).
document.addEventListener("click", function (e) {
  var removeBtn = e.target.closest(".region-chip-remove");
  if (removeBtn) {
    var orphan = removeBtn.closest(".region-chip");
    if (orphan) orphan.remove();
    e.preventDefault();
    return;
  }
  var pill = e.target.closest(".region-picker .region-chip");
  if (!pill || pill.getAttribute("data-selected") === null) return;
  // Orphan rows have no data-color and only respond to the × button above.
  if (!pill.hasAttribute("data-color")) return;
  var isSel = pill.getAttribute("data-selected") === "1";
  var hex = pill.getAttribute("data-color");
  var rgb = pill.getAttribute("data-rgb");
  if (isSel) {
    pill.setAttribute("data-selected", "0");
    pill.style.cssText = "cursor:pointer;padding:0.3rem 0.7rem;font-size:0.78rem;font-weight:600;text-transform:capitalize;background:transparent;color:" + hex + ";border:1px solid rgba(" + rgb + ",0.45);opacity:0.75";
  } else {
    pill.setAttribute("data-selected", "1");
    pill.style.cssText = "cursor:pointer;padding:0.3rem 0.7rem;font-size:0.78rem;font-weight:600;text-transform:capitalize;background:rgba(" + rgb + ",0.22);color:" + hex + ";border:1px solid rgba(" + rgb + ",0.55)";
  }
});

function collectRegionPicker(idPrefix) {
  var picker = document.getElementById(idPrefix);
  if (!picker) return [];
  var out = [];
  picker.querySelectorAll(".region-chip[data-selected='1']").forEach(function (c) {
    out.push(c.getAttribute("data-region"));
  });
  return out;
}

// ─── Tag picker (registry catalogue + free-form additions) ───────────────
// Parallel dimension to region tags, and the same interaction: every tag in
// the registry renders as a toggleable pill in its own color, click selects.
// Typing a name that isn't in the registry creates it there when the caller
// may (serverSettingsSystem fullwrite) and otherwise attaches it to this
// assignment alone. Used in the role slide-over, the per-user tag modal, and
// the Group Mappings slide-over.

// The one category the tag registry refuses hand-created rows in: every tag in
// it is minted by a Device Map region save (REGION_TAG_CATEGORY in
// mapRegionService, which is the authority). Mirrored here so the Category box
// never suggests it.
var REGION_TAG_CATEGORY = "Map Regions";

// Catalogue state. Loaded once per page load by loadTagList().
var _tagList = [];              // registry tag names, category-then-name order
var _tagByName = {};            // lower(name) → the registry row
var _tagCatalogLoaded = false;  // false also means "we never read it"

// Reads the picker-shaped catalogue route, which is auth-only — the registry's
// own GET /server-settings/tags sits behind the serverSettingsSystem read
// floor, which a user administrator may not hold, so this used to skip the read
// entirely for them. Same posture as loadRegionList either way: a failed read
// leaves the catalogue empty and the picker degrades to the free-text chip
// input it was before it had a catalogue — never to a claim that the install
// has no tags.
async function loadTagList() {
  try {
    var payload = await api.serverSettings.tagCatalog();
    var tags = (payload && payload.tags) || [];
    _tagList = [];
    _tagByName = {};
    (Array.isArray(tags) ? tags : []).forEach(function (t) {
      if (!t || !t.name) return;
      _tagByName[String(t.name).toLowerCase()] = t;
      _tagList.push(t.name);
    });
    _tagCatalogLoaded = true;
  } catch (_) {
    _tagCatalogLoaded = false;
  }
  // Repaint any rows already on screen so their tag pills pick up the registry
  // colours — the same late-catalogue repaint loadRegionList does, and for the
  // same reason: this load races the first render.
  if (typeof renderUsersBody === "function" && document.getElementById("users-tbody")) {
    try { renderUsersBody(); } catch (_e) { /* the table just keeps its grey pills */ }
  }
}

function tagColorFor(name) {
  var t = _tagByName[String(name || "").toLowerCase()];
  return (t && t.color) || "#9e9e9e";
}

function tagCategoryFor(name) {
  var t = _tagByName[String(name || "").toLowerCase()];
  return (t && t.category) || "General";
}

// Creating a registry row is a server-settings mutation, so the picker only
// offers it to a caller who holds that grant — otherwise a typed tag attaches
// to this assignment alone and the hint says so, instead of the click landing
// on a 403.
function canCreateRegistryTags() {
  return _tagCatalogLoaded && typeof permAtLeast === "function" && permAtLeast("serverSettingsSystem", "fullwrite");
}

function otherTagChipHtml(t) {
  return '<span class="badge other-tag-chip" data-tag="' + escapeHtml(t) + '" style="display:inline-flex;align-items:center;gap:0.35rem;background:rgba(74,158,255,0.16);color:var(--color-primary,#4a9eff);border:1px solid rgba(74,158,255,0.4);padding:0.2rem 0.5rem;margin:0.1rem 0">' +
    escapeHtml(t) +
    ' <button type="button" class="other-tag-remove" aria-label="Remove" style="background:none;border:none;cursor:pointer;color:inherit;padding:0;font-size:1.1em;line-height:1">&times;</button>' +
  '</span>';
}

function _otherTagPillStyle(hex, rgb, isSel) {
  return "cursor:pointer;padding:0.3rem 0.7rem;font-size:0.78rem;font-weight:600;" + (isSel
    ? "background:rgba(" + rgb + ",0.22);color:" + hex + ";border:1px solid rgba(" + rgb + ",0.55)"
    : "background:transparent;color:" + hex + ";border:1px solid rgba(" + rgb + ",0.45);opacity:0.75");
}

function otherTagPillHtml(name, isSel) {
  var hex = tagColorFor(name);
  var rgb = hexToRgbTriplet(hex);
  return '<button type="button" class="badge other-tag-pill" data-tag="' + escapeHtml(name) + '" data-selected="' + (isSel ? "1" : "0") + '" data-color="' + escapeHtml(hex) + '" data-rgb="' + escapeHtml(rgb) + '" style="' + _otherTagPillStyle(hex, rgb, isSel) + '">' +
    escapeHtml(name) +
  '</button>';
}

function otherTagsPickerHtml(idPrefix, selected) {
  var sel = Array.isArray(selected) ? selected.slice() : [];
  var selSet = {};
  sel.forEach(function (n) { selSet[String(n).toLowerCase()] = true; });

  // Assignments the registry doesn't carry stay as removable chips above the
  // grid — the assignment is real whether or not a Tag row backs it. With no
  // catalogue nothing can be judged unregistered, so every assignment lands
  // in that row and the note says why: the same distinction regionPickerHtml
  // draws between "not in the map" and "could not read the map".
  var unregistered = _tagCatalogLoaded
    ? sel.filter(function (n) { return !_tagByName[String(n).toLowerCase()]; })
    : sel.slice();
  var chipNote = _tagCatalogLoaded
    ? "Tags outside the tag registry. Click × to remove."
    : "Assigned tags. The tag registry could not be read (requires Server Settings read), so these cannot be matched against it here.";
  var chipsHtml = '<div class="other-tags-chip-row" style="margin-bottom:0.5rem">' +
    '<div class="other-tags-chip-note" style="font-size:0.78rem;color:var(--color-text-tertiary);margin-bottom:0.25rem;' + (unregistered.length ? "" : "display:none") + '">' + escapeHtml(chipNote) + '</div>' +
    '<div class="other-tags-chips" style="display:flex;flex-wrap:wrap;gap:0.35rem">' + unregistered.map(otherTagChipHtml).join("") + '</div>' +
  '</div>';

  // The catalogue itself, grouped by the registry's own categories (the list
  // arrives category-then-name ordered) so a few dozen tags stay scannable.
  var gridHtml = "";
  if (_tagCatalogLoaded) {
    if (_tagList.length === 0) {
      gridHtml = '<div class="other-tags-empty" style="font-size:0.85rem;color:var(--color-text-tertiary);padding:0.5rem;border:1px dashed var(--color-border);border-radius:6px">No tags defined yet. Add one below, or manage the full registry on Server Settings → Identification.</div>';
    } else {
      var groups = [];
      var byCat = {};
      _tagList.forEach(function (n) {
        var cat = tagCategoryFor(n);
        if (!byCat[cat]) { byCat[cat] = []; groups.push(cat); }
        byCat[cat].push(n);
      });
      gridHtml = groups.map(function (cat) {
        var pills = byCat[cat].map(function (n) {
          return otherTagPillHtml(n, !!selSet[n.toLowerCase()]);
        }).join("");
        return '<div class="other-tags-cat" data-category="' + escapeHtml(cat) + '" style="margin-bottom:0.5rem">' +
          (groups.length > 1
            ? '<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);margin-bottom:0.25rem">' + escapeHtml(cat) + '</div>'
            : "") +
          '<div class="other-tag-pill-grid" style="display:flex;flex-wrap:wrap;gap:0.4rem">' + pills + '</div>' +
        '</div>';
      }).join("");
    }
  }

  var addHint = !_tagCatalogLoaded
    ? "Tags are stored on this assignment as typed."
    : (canCreateRegistryTags()
        ? "A name that isn't in the list above is created as a new tag in the category beside it."
        : "A name that isn't in the list above applies to this assignment only — creating registry tags requires Server Settings full write.");
  // The Category box only appears for a caller who can actually create a
  // registry row. Without that grant a typed name attaches to this assignment
  // alone — there is no row for a category to land on, and offering the field
  // would ask for a value that is then discarded. Map Regions is left out of
  // the suggestions on purpose: the registry refuses a hand-created tag in it
  // (mapRegionService owns every row there), so offering it would only produce
  // a 409 the operator did nothing to deserve.
  var catList = idPrefix + "-cats";
  var catHtml = "";
  if (canCreateRegistryTags()) {
    var cats = [];
    _tagList.forEach(function (n) {
      var c = tagCategoryFor(n);
      if (c && c !== REGION_TAG_CATEGORY && cats.indexOf(c) === -1) cats.push(c);
    });
    if (cats.indexOf("General") === -1) cats.unshift("General");
    catHtml = '<input type="text" class="other-tags-category" list="' + escapeHtml(catList) + '" ' +
        'placeholder="Category" autocomplete="off" title="Category for a tag created from this box" ' +
        'style="width:150px;flex:0 0 150px" value="General">' +
      '<datalist id="' + escapeHtml(catList) + '">' +
        cats.map(function (c) { return '<option value="' + escapeHtml(c) + '"></option>'; }).join("") +
      '</datalist>';
  }
  var addRow = '<div class="other-tags-add" style="display:flex;gap:0.4rem;margin-top:0.25rem">' +
      '<input type="text" class="other-tags-input" placeholder="Type a tag, press Enter" autocomplete="off" style="flex:1;min-width:0">' +
      catHtml +
      '<button type="button" class="btn btn-sm btn-secondary other-tags-add-btn">Add</button>' +
    '</div>' +
    '<div style="font-size:0.78rem;color:var(--color-text-tertiary);margin-top:0.25rem">' + escapeHtml(addHint) + '</div>';

  return '<div id="' + escapeHtml(idPrefix) + '" class="other-tags-picker">' +
    chipsHtml +
    gridHtml +
    addRow +
  '</div>';
}

function _setOtherTagPillSelected(pill, isSel) {
  pill.setAttribute("data-selected", isSel ? "1" : "0");
  pill.style.cssText = _otherTagPillStyle(pill.getAttribute("data-color"), pill.getAttribute("data-rgb"), isSel);
}

// Select an existing pill by name (case-insensitive), reporting whether one
// was found. Selecting the pill rather than adding a chip is what keeps a
// typed name and its catalogue entry from both landing in the array.
function _selectOtherTagPill(picker, name) {
  var want = String(name).toLowerCase();
  var hit = null;
  picker.querySelectorAll(".other-tag-pill").forEach(function (p) {
    if ((p.getAttribute("data-tag") || "").toLowerCase() === want) hit = p;
  });
  if (!hit) return false;
  _setOtherTagPillSelected(hit, true);
  return true;
}

function _syncOtherTagChipNote(picker) {
  var note = picker.querySelector(".other-tags-chip-note");
  if (note) note.style.display = picker.querySelector(".other-tag-chip") ? "" : "none";
}

// Promote a chip to a registry pill once the Tag row exists, so the open form
// reads the way it will after a reload instead of showing the tag twice.
function _promoteOtherTagChip(picker, name) {
  var want = String(name).toLowerCase();
  // The registry is no longer empty, so the empty-state note would otherwise
  // sit directly above the pill it is denying the existence of.
  var emptyNote = picker.querySelector(".other-tags-empty");
  if (emptyNote) emptyNote.remove();
  picker.querySelectorAll(".other-tag-chip").forEach(function (c) {
    if ((c.getAttribute("data-tag") || "").toLowerCase() === want) c.remove();
  });
  _syncOtherTagChipNote(picker);
  var cat = tagCategoryFor(name);
  var grid = null;
  picker.querySelectorAll(".other-tags-cat").forEach(function (g) {
    if (g.getAttribute("data-category") === cat) grid = g.querySelector(".other-tag-pill-grid");
  });
  if (!grid) {
    // A tag created in a BRAND NEW category has no group to join. Append one
    // rather than dropping the pill into whichever grid happened to be first,
    // which would file it under someone else's heading until the next reload.
    var host = picker.querySelector(".other-tags-add");
    var block = document.createElement("div");
    block.className = "other-tags-cat";
    block.setAttribute("data-category", cat);
    block.style.marginBottom = "0.5rem";
    block.innerHTML =
      '<div style="font-size:0.72rem;text-transform:uppercase;letter-spacing:0.04em;color:var(--color-text-tertiary);margin-bottom:0.25rem">' +
        escapeHtml(cat) +
      '</div><div class="other-tag-pill-grid" style="display:flex;flex-wrap:wrap;gap:0.4rem"></div>';
    if (host) picker.insertBefore(block, host);
    else picker.appendChild(block);
    grid = block.querySelector(".other-tag-pill-grid");
  }
  if (grid) grid.insertAdjacentHTML("beforeend", otherTagPillHtml(name, true));
}

// Commit whatever is typed in the input. Chips are inserted SYNCHRONOUSLY —
// blur fires before the Save click, and collectOtherTags has to see the tag
// whether or not a registry write has come back yet (it also reads the raw
// input as a last resort). The registry create is a best-effort upgrade on
// top of that, never a gate on the assignment.
async function addOtherTagChips(input) {
  var picker = input.closest(".other-tags-picker");
  if (!picker) return;
  var raw = input.value;
  input.value = "";
  var chipWrap = picker.querySelector(".other-tags-chips");
  var existing = {};
  picker.querySelectorAll(".other-tag-chip").forEach(function (c) {
    existing[(c.getAttribute("data-tag") || "").toLowerCase()] = true;
  });

  var fresh = [];
  raw.split(",").forEach(function (part) {
    var t = part.trim();
    if (!t || t.length > 64) return;
    var key = t.toLowerCase();
    if (existing[key]) return;
    existing[key] = true;
    if (_selectOtherTagPill(picker, t)) return;
    if (chipWrap) chipWrap.insertAdjacentHTML("beforeend", otherTagChipHtml(t));
    fresh.push(t);
  });
  _syncOtherTagChipNote(picker);

  if (!fresh.length || !canCreateRegistryTags()) return;
  // Read once, after the chips are in: the box is shared by every name in the
  // comma-separated batch, and blank means the server's own default.
  var catEl = picker.querySelector(".other-tags-category");
  var category = catEl && catEl.value.trim() ? catEl.value.trim() : "General";
  for (var i = 0; i < fresh.length; i++) {
    var name = fresh[i];
    try {
      var created = await api.serverSettings.createTag({ name: name, category: category });
      if (created && created.name) {
        _tagByName[String(created.name).toLowerCase()] = created;
        if (_tagList.indexOf(created.name) === -1) _tagList.push(created.name);
        _promoteOtherTagChip(picker, created.name);
      }
    } catch (err) {
      // The tag still applies to this assignment; only the registry row is
      // missing, so name which half failed rather than implying nothing saved.
      showToast('Tag "' + name + '" applied here, but could not be added to the registry: ' + err.message, "warning");
    }
  }
}

function collectOtherTags(idPrefix) {
  var picker = document.getElementById(idPrefix);
  if (!picker) return [];
  var out = [];
  var seen = {};
  function push(t) {
    var v = String(t || "").trim();
    if (!v || seen[v.toLowerCase()]) return;
    seen[v.toLowerCase()] = true;
    out.push(v);
  }
  picker.querySelectorAll(".other-tag-chip").forEach(function (c) { push(c.getAttribute("data-tag")); });
  picker.querySelectorAll(".other-tag-pill[data-selected='1']").forEach(function (p) { push(p.getAttribute("data-tag")); });
  var input = picker.querySelector(".other-tags-input");
  if (input && input.value.trim()) input.value.split(",").forEach(push);
  return out;
}

document.addEventListener("keydown", function (e) {
  var input = e.target.closest && e.target.closest(".other-tags-picker .other-tags-input");
  if (!input) return;
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addOtherTagChips(input);
  } else if (e.key === "Backspace" && !input.value) {
    var picker = input.closest(".other-tags-picker");
    var chips = picker ? picker.querySelectorAll(".other-tag-chip") : [];
    if (chips.length) {
      chips[chips.length - 1].remove();
      _syncOtherTagChipNote(picker);
    }
  }
});
document.addEventListener("blur", function (e) {
  var input = e.target.closest && e.target.closest(".other-tags-picker .other-tags-input");
  if (input && input.value.trim()) addOtherTagChips(input);
}, true);
document.addEventListener("click", function (e) {
  if (!e.target.closest) return;
  var rm = e.target.closest(".other-tag-remove");
  if (rm) {
    var chip = rm.closest(".other-tag-chip");
    var chipPicker = rm.closest(".other-tags-picker");
    if (chip) chip.remove();
    if (chipPicker) _syncOtherTagChipNote(chipPicker);
    e.preventDefault();
    return;
  }
  var addBtn = e.target.closest(".other-tags-add-btn");
  if (addBtn) {
    var addPicker = addBtn.closest(".other-tags-picker");
    var addInput = addPicker ? addPicker.querySelector(".other-tags-input") : null;
    if (addInput) addOtherTagChips(addInput);
    e.preventDefault();
    return;
  }
  var pill = e.target.closest(".other-tags-picker .other-tag-pill");
  if (pill) {
    _setOtherTagPillSelected(pill, pill.getAttribute("data-selected") !== "1");
    e.preventDefault();
  }
});
