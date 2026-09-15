/**
 * public/js/auth-flow.js — the login-flow fetch helpers shared by the desktop
 * login page (login.js) and the mobile SPA's auth screen (mobile/auth.js),
 * which previously carried drifting copies (2026-08 audit).
 *
 * Pure transport: each helper resolves a plain result object — success
 * navigation, error rendering, and button state stay with the page. Loaded
 * standalone on login.html (which deliberately does NOT load api.js) and on
 * mobile.html before the auth module.
 */

(function () {
  async function postJson(path, body) {
    try {
      var res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json().catch(function () { return {}; });
      return { ok: res.ok, data: data };
    } catch (_) {
      return { ok: false, network: true, data: {} };
    }
  }

  // Every step that can END a login resolves the same three-way shape, so the
  // page never has to remember which steps can branch:
  //   { ok: true }                                  → signed in, navigate
  //   { ok: true, mfaRequired, pendingToken, methods } → a second factor is owed
  //   { ok: true, passwordChangeRequired, pendingToken, policy } → set a
  //       conforming password to collect the session that was withheld
  // A second factor can be followed by a forced change, so both branches are
  // checked after EVERY step, not just after the password.
  function loginOutcome(data) {
    if (data.mfaRequired) {
      return {
        ok: true,
        mfaRequired: true,
        pendingToken: data.pendingToken,
        methods: data.methods || { totp: true, passkey: false },
      };
    }
    if (data.passwordChangeRequired) {
      return {
        ok: true,
        passwordChangeRequired: true,
        pendingToken: data.pendingToken,
        policy: data.policy || null,
      };
    }
    return { ok: true };
  }

  window.PolarisAuthFlow = {
    /** POST /auth/login → see loginOutcome */
    login: async function (username, password) {
      var r = await postJson("/api/v1/auth/login", { username: username, password: password });
      if (r.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!r.ok) return { ok: false, error: r.data.error || "Login failed" };
      return loginOutcome(r.data);
    },

    /** POST /auth/login/totp → see loginOutcome */
    confirmTotp: async function (pendingToken, code, isBackupCode) {
      var r = await postJson("/api/v1/auth/login/totp", {
        pendingToken: pendingToken, code: code, isBackupCode: isBackupCode,
      });
      if (r.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!r.ok) return { ok: false, error: r.data.error || "Invalid code" };
      return loginOutcome(r.data);
    },

    /** GET /auth/passkeys/config → availability ({ loginEnabled: false } on any failure). */
    fetchPasskeyConfig: async function () {
      try {
        var res = await fetch("/api/v1/auth/passkeys/config");
        return res.ok ? await res.json() : { loginEnabled: false, secondFactorEnabled: false };
      } catch (_) {
        return { loginEnabled: false, secondFactorEnabled: false };
      }
    },

    /** GET /auth/password-policy → { policy, rules, limits } or null. */
    fetchPasswordPolicy: async function () {
      try {
        var res = await fetch("/api/v1/auth/password-policy");
        return res.ok ? await res.json() : null;
      } catch (_) {
        return null;
      }
    },

    /**
     * Passwordless sign-in. Two round trips with a browser dialog between them:
     * ask for a challenge, let the authenticator sign it, hand the assertion
     * back. Both halves live here so login.js and the mobile SPA cannot drift.
     */
    passkeyLogin: async function () {
      if (!window.PolarisWebAuthn || !window.PolarisWebAuthn.supported()) {
        return { ok: false, error: "This browser cannot use passkeys here — passkeys need an HTTPS connection." };
      }
      var start = await postJson("/api/v1/auth/passkeys/login/options", {});
      if (start.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!start.ok) return { ok: false, error: start.data.error || "Passkeys are unavailable." };

      var assertion;
      try {
        assertion = await window.PolarisWebAuthn.get(start.data.options);
      } catch (err) {
        return { ok: false, cancelled: true, error: window.PolarisWebAuthn.describeError(err) };
      }
      var done = await postJson("/api/v1/auth/passkeys/login", { token: start.data.token, response: assertion });
      if (done.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!done.ok) return { ok: false, error: done.data.error || "That passkey was not recognized." };
      return loginOutcome(done.data);
    },

    /** The passkey second-factor step, for a login already past the password. */
    confirmPasskey: async function (pendingToken) {
      if (!window.PolarisWebAuthn || !window.PolarisWebAuthn.supported()) {
        return { ok: false, error: "This browser cannot use passkeys here — passkeys need an HTTPS connection." };
      }
      var start = await postJson("/api/v1/auth/login/passkey/options", { pendingToken: pendingToken });
      if (start.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!start.ok) return { ok: false, error: start.data.error || "Passkeys are unavailable." };

      var assertion;
      try {
        assertion = await window.PolarisWebAuthn.get(start.data.options);
      } catch (err) {
        return { ok: false, cancelled: true, error: window.PolarisWebAuthn.describeError(err) };
      }
      var done = await postJson("/api/v1/auth/login/passkey", {
        pendingToken: pendingToken, token: start.data.token, response: assertion,
      });
      if (done.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!done.ok) return { ok: false, error: done.data.error || "That passkey was not recognized." };
      return loginOutcome(done.data);
    },

    /** The forced-change step: set a conforming password, collect the session. */
    changePasswordAtLogin: async function (pendingToken, newPassword) {
      var r = await postJson("/api/v1/auth/login/password-change", {
        pendingToken: pendingToken, newPassword: newPassword,
      });
      if (r.network) return { ok: false, network: true, error: "Network error — try again" };
      if (!r.ok) return { ok: false, error: r.data.error || "Could not change the password" };
      return { ok: true };
    },

    /** GET /server-settings/branding → branding object, or null (best-effort).
     *  Mirrors the payload into the same localStorage key applyBranding uses and
     *  hands the hardware-sensor display unit to the converter — the mobile SPA
     *  and the login screen have no applyBranding, so without this a phone that
     *  never opens the desktop UI would render Celsius whatever the install set. */
    fetchBranding: async function () {
      try {
        var res = await fetch("/api/v1/server-settings/branding");
        if (!res.ok) return null;
        var b = await res.json();
        try { localStorage.setItem("polaris-branding", JSON.stringify(b)); } catch (_) {}
        if (window.PolarisTempUnit) window.PolarisTempUnit.setFromBranding(b);
        return b;
      } catch (_) {
        return null;
      }
    },

    /** GET /auth/azure/config → config object ({ enabled: false } on any failure).
     *  Carries `skipLoginPage`, which is a SHARED setting rather than a SAML
     *  one — an OIDC-only install reads it from here too. */
    fetchAzureConfig: async function () {
      try {
        var res = await fetch("/api/v1/auth/azure/config");
        return res.ok ? await res.json() : { enabled: false };
      } catch (_) {
        return { enabled: false };
      }
    },

    /** GET /auth/oidc/config → { enabled } ({ enabled: false } on any failure). */
    fetchOidcConfig: async function () {
      try {
        var res = await fetch("/api/v1/auth/oidc/config");
        return res.ok ? await res.json() : { enabled: false };
      } catch (_) {
        return { enabled: false };
      }
    },
  };
})();
