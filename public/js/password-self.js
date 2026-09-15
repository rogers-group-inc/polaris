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
 * five regexes is exactly how a client-side hint drifts away from the server,
 * which is the real gate. users.js now delegates to this module rather than
 * keeping its own copy.
 *
 * Since the bar became operator-configurable (Users → Authentication →
 * Settings), WHICH rules apply is no longer a constant: the list is fetched
 * once per page from GET /auth/password-policy and every rendered checklist is
 * repainted when it lands. The predicates stay client-side so a checklist
 * drawn before that request returns is still honest — it shows the shipped
 * defaults, which are the strictest thing the product ever asked for.
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

  // The tests, keyed the way the server keys its rules. The LABELS and which
  // rules apply now come from the server (GET /auth/password-policy), because
  // the complexity bar is operator-configurable — but the predicates stay here:
  // they are the same five regexes utils/passwordPolicy.ts uses, and shipping
  // them rather than fetching them keeps the checklist working before, and if,
  // the policy request lands.
  var TESTS = {
    length:  function (p, policy) { return p.length >= policy.minLength; },
    lower:   function (p) { return /[a-z]/.test(p); },
    upper:   function (p) { return /[A-Z]/.test(p); },
    number:  function (p) { return /[0-9]/.test(p); },
    special: function (p) { return /[^a-zA-Z0-9]/.test(p); },
  };

  // The shipped defaults — the five rules this product enforced before the
  // policy was configurable. Used until the real policy arrives, so a checklist
  // is never blank and never silently empty on a failed fetch.
  var _policy = {
    minLength: 8,
    requireLowercase: true,
    requireUppercase: true,
    requireNumber: true,
    requireSpecial: true,
  };
  var _rules = null;      // [{ key, label }] once resolved
  var _loading = null;    // in-flight fetch, so N modals make one request
  var _containers = [];   // rendered checklists, repainted when the policy lands

  function derivedRules(policy) {
    var rules = [{ key: "length", label: "At least " + policy.minLength + " characters" }];
    if (policy.requireLowercase) rules.push({ key: "lower", label: "Lowercase letter" });
    if (policy.requireUppercase) rules.push({ key: "upper", label: "Uppercase letter" });
    if (policy.requireNumber) rules.push({ key: "number", label: "Number" });
    if (policy.requireSpecial) rules.push({ key: "special", label: "Special character" });
    return rules;
  }

  function activeRules() {
    return _rules || derivedRules(_policy);
  }

  /**
   * Fetch the live policy once per page. Deliberately best-effort: a failure
   * leaves the defaults in place, which is the strictest posture the product
   * ships with, so the worst case is a checklist that asks for slightly more
   * than the server will. The server is the enforcement either way.
   */
  function ensurePolicy() {
    if (_rules) return Promise.resolve(_policy);
    if (_loading) return _loading;
    _loading = fetch("/api/v1/auth/password-policy")
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.policy) {
          _policy = data.policy;
          _rules = (data.rules && data.rules.length) ? data.rules : derivedRules(data.policy);
          repaintAll();
        }
        return _policy;
      })
      .catch(function () { return _policy; });
    return _loading;
  }

  function rowsHTML() {
    return activeRules().map(function (r) {
      return '<div data-rule="' + r.key + '"><span class="pw-icon">&#9675;</span> ' + r.label + '</div>';
    }).join("");
  }

  // A checklist rendered before the policy arrived has the wrong rows; redraw
  // it in place and re-run the check against whatever the user has typed so
  // far, so the list never disagrees with the button it sits above.
  function repaintAll() {
    // Drop containers whose modal has since closed, so reopening a dialog a
    // hundred times does not leave a hundred dead ids to walk.
    _containers = _containers.filter(function (entry) {
      return document.getElementById(entry.containerId) !== null;
    });
    _containers.forEach(function (entry) {
      document.getElementById(entry.containerId).innerHTML = rowsHTML();
      var input = entry.inputId ? document.getElementById(entry.inputId) : null;
      check(input ? input.value : "", entry.containerId);
    });
  }

  /** The checklist markup. Render it under the new-password field. */
  function rulesHTML(containerId) {
    ensurePolicy();
    if (!_containers.some(function (c) { return c.containerId === containerId; })) {
      _containers.push({ containerId: containerId, inputId: null });
    }
    return '<div id="' + containerId + '" style="margin-top:0.4rem;font-size:0.8rem;line-height:1.6;color:var(--color-text-tertiary)">' +
      rowsHTML() + '</div>';
  }

  /** Repaint the checklist; returns true when every rule passes. */
  function check(pw, containerId) {
    var allPassed = true;
    activeRules().forEach(function (r) {
      var passed = TESTS[r.key] ? TESTS[r.key](pw, _policy) : true;
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
    var entry = null;
    _containers.forEach(function (c) { if (c.containerId === containerId) entry = c; });
    if (entry) entry.inputId = inputId;
    else _containers.push({ containerId: containerId, inputId: inputId });
    input.addEventListener("input", function () { check(this.value, containerId); });
    ensurePolicy();
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
