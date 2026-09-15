/**
 * public/js/passkeys-self.js — self-service passkey management.
 *
 * The account-menu counterpart of totp-self.js, and here for the same reason:
 * every route it calls (`/auth/passkeys/*`) is gated on nothing beyond being
 * logged in, while /users.html — the only other place a credential control
 * lives — is page-gated `users`. Without this an ordinary local user could not
 * register the passkey the install is offering them.
 *
 * `local` accounts only. The server refuses every other authProvider, so this
 * gates on the payload's own `authProvider` rather than on the session's
 * cached one (which defaults to "local" on the cached-nav path — the trap
 * documented in app.js's wireTotpState).
 *
 * The ceremony itself is PolarisWebAuthn (webauthn.js); everything here is the
 * list, the naming and the confirmations around it.
 *
 * Depends on globals from api.js (api, escapeHtml) and app.js (openModal,
 * closeModal, showToast, showConfirm, val). Load order doesn't matter —
 * nothing runs until a menu item is selected.
 */

(function () {
  "use strict";

  function toast(msg, kind) { if (typeof showToast === "function") showToast(msg, kind); }

  function formatDate(value) {
    if (!value) return "never";
    try { return new Date(value).toLocaleString(); } catch (_) { return String(value); }
  }

  /**
   * The list rows. `deviceType === "multiDevice"` with `backedUp` means the
   * credential syncs through a password manager or iCloud Keychain — worth
   * showing, because it is the difference between "lose this phone and lose
   * this passkey" and not.
   */
  function rowsHTML(passkeys) {
    if (!passkeys.length) {
      return '<p class="empty-state" style="padding:1.25rem 0">No passkeys registered yet.</p>';
    }
    return '<div style="display:flex;flex-direction:column;gap:0.5rem">' + passkeys.map(function (p) {
      var synced = p.backedUp
        ? '<span class="badge" style="background:rgba(99,102,241,0.15);color:var(--color-primary,#6366f1)" title="Synced through a credential manager, so it survives losing this device">Synced</span>'
        : '<span class="badge" style="background:var(--color-bg-secondary);color:var(--color-text-tertiary)" title="Lives on one device only">This device only</span>';
      return '<div style="display:flex;align-items:center;gap:0.75rem;padding:0.6rem 0.75rem;border:1px solid var(--color-border);border-radius:6px">' +
        '<div style="flex:1;min-width:0">' +
          '<div style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(p.name) + '</div>' +
          '<div style="font-size:0.78rem;color:var(--color-text-tertiary)">Added ' + escapeHtml(formatDate(p.createdAt)) +
            ' · Last used ' + escapeHtml(formatDate(p.lastUsedAt)) + '</div>' +
        '</div>' +
        synced +
        '<button class="btn btn-secondary btn-sm" data-rename="' + escapeHtml(p.id) + '">Rename</button>' +
        '<button class="btn btn-secondary btn-sm" data-remove="' + escapeHtml(p.id) + '" data-name="' + escapeHtml(p.name) + '">Remove</button>' +
      '</div>';
    }).join("") + '</div>';
  }

  function modeNote(availability) {
    if (availability.unavailableReason) {
      return '<p class="hint" style="color:var(--color-warning,#f0a020)">' + escapeHtml(availability.unavailableReason) + '</p>';
    }
    if (availability.mode === "off") {
      return '<p class="hint">Passkeys are currently disabled on this install. Credentials you have already registered are kept, but will not sign you in until an administrator re-enables them.</p>';
    }
    if (availability.mode === "login") {
      return '<p class="hint">On this install a passkey signs you in on its own, in place of your password.</p>';
    }
    if (availability.mode === "second-factor") {
      return '<p class="hint">On this install a passkey is your second factor: password first, then the passkey instead of an authenticator code.</p>';
    }
    return '<p class="hint">On this install a passkey can sign you in on its own <em>or</em> act as your second factor after your password.</p>';
  }

  async function open(opts) {
    opts = opts || {};
    var data;
    try { data = await api.auth.passkeys(); }
    catch (err) { toast(err.message, "error"); return; }

    if (data.authProvider && data.authProvider !== "local") {
      toast("Passkeys are managed by your identity provider for SSO accounts.", "error");
      return;
    }
    render(data, opts);
  }

  function render(data, opts) {
    var availability = data.availability || {};
    var canRegister = !availability.unavailableReason &&
      availability.mode !== "off" &&
      window.PolarisWebAuthn && PolarisWebAuthn.supported();

    var body =
      '<p style="font-size:0.9rem;color:var(--color-text-secondary);margin-bottom:0.5rem">' +
        'A passkey lets this device prove who you are with its own screen lock — a PIN, a fingerprint or your face — ' +
        'instead of a password you could be tricked into typing somewhere else.' +
      '</p>' +
      modeNote(availability) +
      '<div id="passkey-list" style="margin-top:1rem">' + rowsHTML(data.passkeys || []) + '</div>';

    var footer =
      (canRegister
        ? '<div style="margin-right:auto"><button class="btn btn-primary" id="btn-passkey-add">Add a passkey</button></div>'
        : '') +
      '<button class="btn btn-secondary" id="btn-passkey-close">Close</button>';

    openModal("Passkeys", body, footer);
    document.getElementById("btn-passkey-close").addEventListener("click", closeModal);
    wireList(opts);

    var add = document.getElementById("btn-passkey-add");
    if (add) add.addEventListener("click", function () { addPasskey(this, opts); });
  }

  /** Re-fetch and repaint the list in place, leaving the modal open. */
  async function refresh(opts) {
    try {
      var data = await api.auth.passkeys();
      var list = document.getElementById("passkey-list");
      if (list) {
        list.innerHTML = rowsHTML(data.passkeys || []);
        wireList(opts);
      }
    } catch (_) { /* the list just stays as it was */ }
    if (opts && opts.onChange) opts.onChange();
  }

  function wireList(opts) {
    var list = document.getElementById("passkey-list");
    if (!list) return;
    list.querySelectorAll("[data-rename]").forEach(function (btn) {
      btn.addEventListener("click", function () { renamePasskey(this.getAttribute("data-rename"), opts); });
    });
    list.querySelectorAll("[data-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        removePasskey(this.getAttribute("data-remove"), this.getAttribute("data-name"), opts);
      });
    });
  }

  async function addPasskey(btn, opts) {
    btn.disabled = true;
    try {
      var start = await api.auth.passkeyRegisterOptions();
      var attestation;
      try {
        attestation = await PolarisWebAuthn.create(start.options);
      } catch (err) {
        // A cancelled dialog is a decision, not a failure — say what happened
        // and leave the list alone.
        toast(PolarisWebAuthn.describeError(err), "error");
        return;
      }
      var created = await api.auth.passkeyRegister({
        token: start.token,
        name: PolarisWebAuthn.guessDeviceName(),
        response: attestation,
      });
      toast('Passkey "' + created.name + '" registered');
      await refresh(opts);
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
    }
  }

  function renamePasskey(id, opts) {
    // A stacked modal over the list, so closing it returns to the list rather
    // than dropping the operator back on the page (polaris-ui-canon → stacked
    // modals).
    var body = '<div class="form-group"><label for="f-passkey-name">Name</label>' +
      '<input type="text" id="f-passkey-name" maxlength="80" autofocus>' +
      '<p class="hint">Something you will recognize later — “Work laptop”, “YubiKey on my keyring”.</p></div>';
    var footer = '<button class="btn btn-secondary" id="btn-passkey-rename-cancel">Cancel</button>' +
      '<button class="btn btn-primary" id="btn-passkey-rename-save">Save</button>';
    openModal("Rename passkey", body, footer);

    document.getElementById("btn-passkey-rename-cancel").addEventListener("click", closeModal);
    document.getElementById("btn-passkey-rename-save").addEventListener("click", async function () {
      var name = val("f-passkey-name");
      if (!name) { toast("Enter a name", "error"); return; }
      this.disabled = true;
      try {
        await api.auth.renamePasskey(id, name);
        closeModal();
        await refresh(opts);
      } catch (err) {
        toast(err.message, "error");
        this.disabled = false;
      }
    });
  }

  async function removePasskey(id, name, opts) {
    var ok = await showConfirm(
      'Remove the passkey "' + name + '"?\n\n' +
      'It will stop working immediately. Your password is unaffected, and you can register a new passkey at any time.',
    );
    if (!ok) return;
    try {
      await api.auth.deletePasskey(id);
      toast('Passkey "' + name + '" removed');
      await refresh(opts);
    } catch (err) {
      toast(err.message, "error");
    }
  }

  /** Enough state for the account menu to label its row without opening anything. */
  function summary() {
    return api.auth.passkeys().then(function (data) {
      return {
        authProvider: data.authProvider,
        count: (data.passkeys || []).length,
        availability: data.availability || {},
      };
    });
  }

  window.PolarisPasskeys = {
    open: open,
    summary: summary,
  };
})();
