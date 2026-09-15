/**
 * public/js/password-self.js — the password complexity checklist, and the
 * self-service "Change password" modal that uses it.
 *
 * Two things live here for one reason each.
 *
 * The CHECKLIST (rulesHTML / wire / check, and the confirm-field matcher) was
 * private to users.js, which is loaded on /users.html alone. The account menu
 * hangs off the page header on EVERY page, so the change-password modal it
 * opens needed the same live checklist somewhere shared — and a second copy of
 * five regexes is exactly how a client-side hint drifts away from the server's
 * `passwordPolicySchema` (src/utils/password.ts), which is the real gate.
 * users.js now delegates to this module rather than keeping its own copy.
 *
 * The MODAL is self-service: `PUT /auth/password` is gated on nothing beyond
 * being logged in, while /users.html is page-gated `users` (admin-only in the
 * built-in matrix). Same mismatch that moved TOTP enrollment into
 * totp-self.js — an ordinary local user could not reach the page that held
 * the only password field in the product.
 *
 * `local` accounts only. The server refuses every other authProvider ("your
 * password is managed by your identity provider"), so callers gate on the
 * session's own authProvider rather than guessing.
 *
 * Depends on globals from api.js (api, escapeHtml) and app.js (openModal,
 * closeModal, showToast, val). Load order doesn't matter: nothing here runs
 * until a menu item is selected.
 */

(function () {
  "use strict";

  function toast(msg, kind) { if (typeof showToast === "function") showToast(msg, kind); }

  // Mirrors src/utils/password.ts → passwordPolicySchema. The server is the
  // enforcement; this is the courtesy that tells the user which rule they have
  // not met yet, before they press the button.
  var RULES = [
    { key: "length",  label: "At least 8 characters", test: function (p) { return p.length >= 8; } },
    { key: "lower",   label: "Lowercase letter",      test: function (p) { return /[a-z]/.test(p); } },
    { key: "upper",   label: "Uppercase letter",      test: function (p) { return /[A-Z]/.test(p); } },
    { key: "number",  label: "Number",                test: function (p) { return /[0-9]/.test(p); } },
    { key: "special", label: "Special character",     test: function (p) { return /[^a-zA-Z0-9]/.test(p); } },
  ];

  /** The checklist markup. Render it under the new-password field. */
  function rulesHTML(containerId) {
    var html = '<div id="' + containerId + '" style="margin-top:0.4rem;font-size:0.8rem;line-height:1.6;color:var(--color-text-tertiary)">';
    RULES.forEach(function (r) {
      html += '<div data-rule="' + r.key + '"><span class="pw-icon">&#9675;</span> ' + r.label + '</div>';
    });
    return html + '</div>';
  }

  /** Repaint the checklist; returns true when every rule passes. */
  function check(pw, containerId) {
    var allPassed = true;
    RULES.forEach(function (r) {
      var passed = r.test(pw);
      if (!passed) allPassed = false;
      var el = document.querySelector('#' + containerId + ' [data-rule="' + r.key + '"]');
      if (el) {
        el.querySelector(".pw-icon").innerHTML = passed ? "&#10003;" : "&#9675;";
        el.style.color = passed ? "var(--color-success, #4caf50)" : "var(--color-text-tertiary)";
      }
    });
    return allPassed;
  }

  /** Repaint on every keystroke in the password field. */
  function wire(inputId, containerId) {
    var input = document.getElementById(inputId);
    if (!input) return;
    input.addEventListener("input", function () { check(this.value, containerId); });
  }

  /** The "Matches password" row for a confirm field. */
  function matchHTML(containerId) {
    return '<div id="' + containerId + '" style="margin-top:0.4rem;font-size:0.8rem;line-height:1.6;color:var(--color-text-tertiary)">' +
      '<span class="pw-icon">&#9675;</span> Matches password' +
      '</div>';
  }

  /** Repaint the match row; returns true when the two fields agree. */
  function checkMatch(pw, confirm, containerId) {
    var el = document.getElementById(containerId);
    if (!el) return false;
    var matched = confirm.length > 0 && pw === confirm;
    el.querySelector(".pw-icon").innerHTML = matched ? "&#10003;" : "&#9675;";
    el.style.color = matched ? "var(--color-success, #4caf50)" : "var(--color-text-tertiary)";
    return matched;
  }

  /** Repaint the match row on every keystroke in either field. */
  function wireMatch(passwordId, confirmId, containerId) {
    function update() {
      checkMatch(
        (document.getElementById(passwordId) || {}).value || "",
        (document.getElementById(confirmId) || {}).value || "",
        containerId,
      );
    }
    var pw = document.getElementById(passwordId);
    var cf = document.getElementById(confirmId);
    if (pw) pw.addEventListener("input", update);
    if (cf) cf.addEventListener("input", update);
  }

  /**
   * The change-password modal. `opts.username` only labels the dialog;
   * the server changes the SESSION's own account regardless of what is
   * passed, which is what keeps this route safe to leave ungated.
   */
  function open(opts) {
    opts = opts || {};
    var who = opts.username || (typeof currentUsername !== "undefined" ? currentUsername : "");

    var body =
      '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:1rem">' +
        'Change the password for <strong>' + escapeHtml(who) + '</strong>. ' +
        'Any other browser signed in as you will be signed out.' +
      '</p>' +
      '<div class="form-group">' +
        '<label for="f-pw-current">Current password *</label>' +
        '<input type="password" id="f-pw-current" autocomplete="current-password" autofocus>' +
      '</div>' +
      '<div class="form-group">' +
        '<label for="f-pw-new">New password *</label>' +
        '<input type="password" id="f-pw-new" autocomplete="new-password">' +
        rulesHTML("f-pw-new-checks") +
      '</div>' +
      '<div class="form-group">' +
        '<label for="f-pw-new-confirm">Confirm new password *</label>' +
        '<input type="password" id="f-pw-new-confirm" autocomplete="new-password">' +
        matchHTML("f-pw-new-match") +
      '</div>';
    var footer =
      '<button class="btn btn-secondary" id="btn-pw-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-pw-save">Change Password</button>';

    openModal("Change Password", body, footer);
    wire("f-pw-new", "f-pw-new-checks");
    wireMatch("f-pw-new", "f-pw-new-confirm", "f-pw-new-match");

    document.getElementById("btn-pw-cancel").addEventListener("click", closeModal);
    document.getElementById("btn-pw-save").addEventListener("click", async function () {
      var btn = this;
      var current = val("f-pw-current");
      var next = val("f-pw-new");
      if (!current) { toast("Enter your current password", "error"); return; }
      if (!check(next, "f-pw-new-checks")) {
        toast("New password does not meet complexity requirements", "error");
        return;
      }
      if (next !== val("f-pw-new-confirm")) { toast("Passwords do not match", "error"); return; }
      if (next === current) { toast("The new password must be different from the current one", "error"); return; }

      btn.disabled = true;
      try {
        var result = await api.auth.changePassword({ currentPassword: current, newPassword: next });
        closeModal();
        var revoked = (result && result.otherSessionsRevoked) || 0;
        toast(revoked
          ? "Password changed — " + revoked + " other session" + (revoked === 1 ? "" : "s") + " signed out"
          : "Password changed");
        if (opts.onChange) opts.onChange();
      } catch (err) {
        toast(err.message, "error");
      } finally {
        btn.disabled = false;
      }
    });
  }

  window.PolarisPasswordSelf = {
    open: open,
    rulesHTML: rulesHTML,
    wire: wire,
    check: check,
    matchHTML: matchHTML,
    wireMatch: wireMatch,
    checkMatch: checkMatch,
  };
})();
