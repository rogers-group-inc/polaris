// public/js/mobile/auth.js — Login and TOTP screens for the mobile app.
//
// Wires up the same multi-step auth flow as the desktop login.html. Every step
// can hand back any of three outcomes, routed by handleLoginOutcome():
//   POST /api/v1/auth/login
//     → { ok, user }                          → session set, navigate home
//     → { mfaRequired, pendingToken, methods } → second-factor step (code or passkey)
//     → { passwordChangeRequired, pendingToken } → forced new-password step
//   POST /api/v1/auth/login/totp     ┐ same three outcomes — a second factor
//   POST /api/v1/auth/login/passkey  ┘ can still be followed by a forced change
//   POST /api/v1/auth/passkeys/login → passwordless, same three outcomes
//
// Renders directly into the .app container; doesn't touch the navbar or
// top app bar (those are app.js's responsibility once authenticated).

(function () {
  var pendingToken = null;
  var pwChangeToken = null;
  // Which second factors the account can finish with, as reported by the
  // password step. Defaults to the pre-passkey answer so an older response
  // shape still renders the code form.
  var mfaMethods = { totp: true, passkey: false };
  var ssoConfig = null;

  // Microsoft 4-square logo, used when SSO is configured for Azure/Entra.
  var MS_LOGO_SVG = '<svg viewBox="0 0 23 23" xmlns="http://www.w3.org/2000/svg" style="width:18px;height:18px"><path fill="#f25022" d="M1 1h10v10H1z"/><path fill="#00a4ef" d="M1 12h10v10H1z"/><path fill="#7fba00" d="M12 1h10v10H12z"/><path fill="#ffb900" d="M12 12h10v10H12z"/></svg>';

  async function loadSsoConfig() {
    if (ssoConfig !== null) return ssoConfig;
    ssoConfig = await PolarisAuthFlow.fetchAzureConfig();
    return ssoConfig;
  }

  // ─── On-screen keyboard fit ──────────────────────────────────────────────
  //
  // Same problem and same fix as the desktop login page (see login.js): iOS
  // Safari does not shrink the layout viewport when the keyboard opens, so the
  // centered login card stays put with the password field and Sign in button
  // behind the keyboard. On the mobile shell it's worse than a scroll away —
  // body is overflow:hidden and .login-shell is exactly min-height:100%, so
  // .app-body has nothing to scroll and those controls are unreachable.
  //
  // window.visualViewport reports the actually-visible rect on both iOS Safari
  // and Chrome Android. While it's meaningfully shorter than the layout
  // viewport we pin .app to that rect (--vv-height / --vv-offset-top, see the
  // .kb-open rules in mobile.css) and scroll the active form's bottom — the
  // submit button — into view.
  var KEYBOARD_MIN_PX = 120;   // below this it's browser chrome, not a keyboard
  var kbInstalled = false;
  var kbPending = 0;
  var kbLastScrolled = null;

  function applyKeyboardFit() {
    kbPending = 0;
    var app = document.getElementById("app");
    var vv = window.visualViewport;
    if (!app || !vv) return;

    // Self-unmount: the auth screens own this behavior, but they're replaced
    // wholesale by boot() with no teardown hook, so every measurement re-checks
    // that a login form is still on screen rather than trusting a lifecycle
    // callback to have fired.
    var mounted = !!(document.getElementById("login-form") || document.getElementById("totp-form"));
    var layoutH = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
    var open = mounted && layoutH - vv.height > KEYBOARD_MIN_PX;

    if (!open) {
      resetKeyboardFit();
      return;
    }

    app.style.setProperty("--vv-height", vv.height + "px");
    app.style.setProperty("--vv-offset-top", vv.offsetTop + "px");
    app.classList.add("kb-open");

    var active = document.activeElement;
    var target = active && active.form ? active.form : active;
    // Only when the focused form changes (keyboard just opened, or the TOTP
    // step swapped the form in place) — re-running this on every resize/scroll
    // event would fight the user's own scrolling.
    if (target && target !== kbLastScrolled && target.scrollIntoView) {
      target.scrollIntoView({ block: "end", behavior: "smooth" });
      kbLastScrolled = target;
    }
  }

  function resetKeyboardFit() {
    var app = document.getElementById("app");
    if (app) {
      app.classList.remove("kb-open");
      app.style.removeProperty("--vv-height");
      app.style.removeProperty("--vv-offset-top");
    }
    kbLastScrolled = null;
  }

  function scheduleKeyboardFit() {
    if (!kbPending) kbPending = window.requestAnimationFrame(applyKeyboardFit);
  }

  // Idempotent — both auth screens call it on render, and the listeners live
  // for the page's lifetime (rAF-coalesced, and a no-op once the forms are
  // gone). Nothing here removes them, because a session can expire back onto
  // the login screen at any point.
  function installKeyboardFit() {
    if (kbInstalled || !window.visualViewport) return;
    kbInstalled = true;
    window.visualViewport.addEventListener("resize", scheduleKeyboardFit);
    window.visualViewport.addEventListener("scroll", scheduleKeyboardFit);
    window.addEventListener("orientationchange", scheduleKeyboardFit);
    document.addEventListener("focusin", scheduleKeyboardFit);
  }

  // ─── "Skip login page" ───────────────────────────────────────────────
  //
  // The desktop enforces the setting server-side, in app.ts's protected-page
  // redirect. /mobile.html is deliberately NOT a protected page — the phone SPA
  // draws its own login screen, so an unauthenticated visitor has to be allowed
  // to load the page — which left the phone as the one surface still offering a
  // username/password form the setting says should not exist. So the SPA
  // enforces it here, at the single choke point where a local login gets drawn:
  // boot, session-expiry 401, and Cancel out of the TOTP step all land in
  // renderLogin.
  //
  // Same provider precedence as app.ts: SAML first, OIDC as the fallback, and
  // `skipLoginPage` rides the azure config payload because it is a shared
  // setting rather than a SAML one. If neither provider resolves we fall
  // through and draw the form — the flag can only be set by an SSO-authenticated
  // admin, but SSO can be torn down afterwards, and a phone with no way back in
  // is worse than one showing a form the desktop would have hidden.
  //
  // One exception: an explicit Sign out. With skip on and a silent SSO
  // (prompt=none) the redirect would sign the operator straight back in and the
  // button would look broken. The desktop dodges this by landing logout on
  // /signed-out.html, a page with no form whose Sign in button opens the
  // bare /login.html; the phone has no such page, so more-tab marks the
  // transition instead and the check below spends the marker to draw the
  // form once.
  var SIGNED_OUT_KEY = "polaris-mobile-signed-out";

  function markSignedOut() {
    try { sessionStorage.setItem(SIGNED_OUT_KEY, "1"); } catch (_) {}
  }

  function takeSignedOutFlag() {
    try {
      var v = sessionStorage.getItem(SIGNED_OUT_KEY);
      sessionStorage.removeItem(SIGNED_OUT_KEY);
      return v === "1";
    } catch (_) {
      return false;
    }
  }

  async function redirectToSsoIfLoginSkipped() {
    var justSignedOut = takeSignedOutFlag();
    var azure = await loadSsoConfig();
    if (justSignedOut) return false;
    if (!azure || !azure.skipLoginPage) return false;
    if (azure.enabled) {
      window.location.href = "/api/v1/auth/azure/login?prompt=none";
      return true;
    }
    var oidc = await PolarisAuthFlow.fetchOidcConfig();
    if (oidc && oidc.enabled) {
      window.location.href = "/api/v1/auth/oidc/login";
      return true;
    }
    return false;
  }

  // Async because of the skip-login check above: hold the spinner while it
  // resolves rather than painting a login form we may be about to navigate
  // away from. Callers fire-and-forget — nothing waits on the login screen.
  async function renderLogin(app) {
    app.dataset.tab = "";
    app.innerHTML = '<div class="loading-screen"><div class="spinner"></div></div>';
    if (await redirectToSsoIfLoginSkipped()) return;  // navigating away; leave the spinner up
    renderLoginForm(app);
  }

  function renderLoginForm(app) {
    app.dataset.tab = "";
    app.innerHTML = ''
      + '<div class="app-body">'
      + '  <div class="login-shell">'
      + '    <img class="brand-logo brand-mark brand-mark-login" id="brand-logo" src="/img/brand/polaris-horiz-dark.png" alt="Polaris">'
      + '    <h2 id="brand-name" style="display:none">Polaris</h2>'
      + '    <div class="sub" id="brand-sub">IP management, navigated</div>'

      + '    <div id="login-error" class="hidden" style="width:100%;background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'

      + '    <form id="login-form" style="width:100%;">'
      + '      <div class="full-field">'
      + '        <div class="tf-outlined"><span class="lbl">Username</span>'
      + '          <input class="field" type="text" id="username" autocomplete="username" required autofocus>'
      + '        </div>'
      + '      </div>'
      + '      <div class="full-field">'
      + '        <div class="tf-outlined"><span class="lbl">Password</span>'
      + '          <input class="field" type="password" id="password" autocomplete="current-password" required>'
      + '        </div>'
      + '      </div>'
      + '      <button type="submit" class="btn btn-filled btn-block" style="height:48px;">Sign in</button>'
      + '    </form>'

      + '    <div id="passkey-section" class="hidden" style="width:100%;">'
      + '      <div class="divider">or</div>'
      + '      <button id="passkey-btn" class="btn btn-tonal btn-block" style="height:48px;">Sign in with a passkey</button>'
      + '    </div>'

      + '    <div id="sso-section" class="hidden" style="width:100%;">'
      + '      <div class="divider">or</div>'
      + '      <button id="sso-btn" class="btn btn-tonal btn-block" style="height:48px;"></button>'
      + '    </div>'
      + '  </div>'
      + '</div>';

    // Passkey sign-in. A phone is where this matters most — Face ID / a
    // fingerprint instead of typing a password on a small keyboard — but the
    // button only appears when the install allows it AND the PWA is on HTTPS,
    // since a ceremony in a non-secure context can only throw.
    if (window.PolarisWebAuthn && PolarisWebAuthn.supported()) {
      PolarisAuthFlow.fetchPasskeyConfig().then(function (cfg) {
        if (!cfg || !cfg.loginEnabled) return;
        // Same host-vs-rpId check the desktop login page makes: a proxy that
        // rewrites Host leaves the button drawable and the ceremony impossible.
        if (PolarisWebAuthn.unavailableHere(cfg.rpId)) return;
        var sec = document.getElementById("passkey-section");
        var btn = document.getElementById("passkey-btn");
        if (!sec || !btn) return;
        sec.classList.remove("hidden");
        btn.addEventListener("click", async function () {
          clearError();
          btn.disabled = true;
          try {
            var r = await PolarisAuthFlow.passkeyLogin();
            if (!r.ok) { showError(r.error); return; }
            handleLoginOutcome(app, r);
          } finally {
            btn.disabled = false;
          }
        });
      }).catch(function () {});
    }

    // Pull branding (logo + app name) — best-effort. Which mark to paint, and
    // whether the Application Name is shown as text at all, is
    // PolarisBrandLogo's call: the shipped Polaris art already carries the
    // wordmark, so a caption under it would only repeat it.
    PolarisAuthFlow.fetchBranding().then(function (b) {
      if (!b) return;
      var nameEl = document.getElementById("brand-name");
      var subEl = document.getElementById("brand-sub");

      function paint() {
        var r = PolarisBrandLogo.applyTo(document.getElementById("brand-logo"), b, "login");
        if (nameEl) {
          nameEl.textContent = b.appName || "Polaris";
          nameEl.style.display = r.showName ? "" : "none";
        }
        if (subEl && b.subtitle !== undefined) {
          subEl.textContent = b.subtitle || "";
          subEl.style.display = r.showSubtitle ? "" : "none";
        }
      }

      paint();
      PolarisBrandLogo.onThemeChange(paint);
      document.title = (b.appName || "").trim() || "Polaris";
      // Favicon tracks the uploaded logo only — a wordmark is illegible at
      // 16px, and the themed symbol pair is already the declared icon.
      // setFavicon updates BOTH links (see brand-logo.js).
      if (b.customLogo && b.logoUrl) PolarisBrandLogo.setFavicon(b.logoUrl);
    }).catch(function () {});

    // SSO button (Microsoft only for now — matches desktop scope).
    loadSsoConfig().then(function (cfg) {
      if (!cfg || !cfg.enabled) return;
      var sec = document.getElementById("sso-section");
      var btn = document.getElementById("sso-btn");
      var brand = cfg.brand || "microsoft";
      btn.innerHTML = MS_LOGO_SVG
        + '<span style="margin-left:8px;">Continue with '
        + (brand === "microsoft" ? "Microsoft"
          : brand === "google"   ? "Google"
          : brand === "okta"     ? "Okta" : "SSO")
        + '</span>';
      sec.classList.remove("hidden");
      btn.addEventListener("click", function () {
        window.location.href = "/api/v1/auth/azure/login";
      });
    });

    document.getElementById("login-form").addEventListener("submit", onLoginSubmit);
    kbLastScrolled = null;
    installKeyboardFit();
  }

  function renderTotp(app) {
    app.dataset.tab = "";
    app.innerHTML = ''
      + '<div class="app-body">'
      + '  <div class="login-shell">'
      + '    <div class="logo-mark"><svg viewBox="0 0 24 24"><use href="#i-shield"/></svg></div>'
      + '    <h2>Verification</h2>'
      + '    <div class="sub" id="totp-sub">Enter the 6-digit code from your authenticator app.</div>'

      + '    <div id="login-error" class="hidden" style="width:100%;background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'

      + '    <form id="totp-form" style="width:100%;">'
      + '      <div class="full-field">'
      + '        <div class="tf-outlined"><span class="lbl" id="totp-label">Code</span>'
      + '          <input class="field mono" type="text" id="totp-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" required autofocus>'
      + '        </div>'
      + '      </div>'
      + '      <button type="submit" class="btn btn-filled btn-block" style="height:48px;">Verify</button>'
      + '      <button type="button" id="totp-toggle" class="btn btn-text btn-block" style="height:40px; margin-top:8px;">Use a backup code</button>'
      + '      <button type="button" id="totp-cancel" class="btn btn-text btn-block" style="height:40px; color:var(--md-on-surface-variant);">Cancel</button>'
      + '    </form>'
      + '    <div id="mfa-passkey-block" class="hidden" style="width:100%;">'
      + '      <button type="button" id="mfa-passkey-btn" class="btn btn-filled btn-block" style="height:48px;">Use your passkey</button>'
      + '      <button type="button" id="mfa-passkey-cancel" class="btn btn-text btn-block" style="height:40px; color:var(--md-on-surface-variant);">Cancel</button>'
      + '    </div>'
      + '    <button type="button" id="mfa-switch" class="btn btn-text btn-block hidden" style="height:40px;">Use a passkey instead</button>'
      + '  </div>'
      + '</div>';

    // Which halves of this screen apply depends on what the account actually
    // enrolled. A passkey-only account never sees a code field it cannot fill.
    var canPasskey = !!mfaMethods.passkey && window.PolarisWebAuthn && PolarisWebAuthn.supported();
    var canTotp = !!mfaMethods.totp;
    if (!canTotp) {
      document.getElementById("totp-form").classList.add("hidden");
      document.getElementById("mfa-passkey-block").classList.remove("hidden");
      document.getElementById("totp-sub").textContent = canPasskey
        ? "Confirm it's you with your passkey."
        : "This account uses a passkey as its second factor, and this browser cannot use passkeys here.";
      document.getElementById("mfa-passkey-btn").disabled = !canPasskey;
    } else if (canPasskey) {
      document.getElementById("mfa-switch").classList.remove("hidden");
    }

    document.getElementById("mfa-switch").addEventListener("click", function () {
      var form = document.getElementById("totp-form");
      var block = document.getElementById("mfa-passkey-block");
      var usingCode = !form.classList.contains("hidden");
      form.classList.toggle("hidden", usingCode);
      block.classList.toggle("hidden", !usingCode);
      this.textContent = usingCode ? "Use a verification code instead" : "Use a passkey instead";
    });

    document.getElementById("mfa-passkey-btn").addEventListener("click", async function () {
      var btn = this;
      clearError();
      btn.disabled = true;
      try {
        var r = await PolarisAuthFlow.confirmPasskey(pendingToken);
        if (!r.ok) { showError(r.error); return; }
        pendingToken = null;
        handleLoginOutcome(app, r);
      } finally {
        btn.disabled = false;
      }
    });

    document.getElementById("mfa-passkey-cancel").addEventListener("click", function () {
      pendingToken = null;
      renderLogin(app);
    });

    var input = document.getElementById("totp-code");
    var label = document.getElementById("totp-label");
    var sub   = document.getElementById("totp-sub");
    var toggle = document.getElementById("totp-toggle");
    input.dataset.mode = "totp";

    toggle.addEventListener("click", function () {
      var backup = input.dataset.mode === "backup";
      if (backup) {
        input.dataset.mode = "totp";
        input.type = "text"; input.maxLength = 6; input.placeholder = "123456"; input.value = "";
        label.textContent = "Code";
        sub.textContent = "Enter the 6-digit code from your authenticator app.";
        toggle.textContent = "Use a backup code";
      } else {
        input.dataset.mode = "backup";
        input.type = "text"; input.maxLength = 9; input.placeholder = "XXXX-XXXX"; input.value = "";
        label.textContent = "Backup code";
        sub.textContent = "Enter one of the backup codes you saved when enabling 2FA.";
        toggle.textContent = "Use the authenticator app instead";
      }
      input.focus();
    });

    document.getElementById("totp-cancel").addEventListener("click", function () {
      pendingToken = null;
      renderLogin(app);
    });

    document.getElementById("totp-form").addEventListener("submit", onTotpSubmit);
    // The keyboard is typically already up from the password field, so no
    // visualViewport event follows this render — re-measure explicitly to get
    // the Verify button above it.
    kbLastScrolled = null;
    installKeyboardFit();
    scheduleKeyboardFit();
  }

  function showError(msg) {
    var el = document.getElementById("login-error");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  function clearError() {
    var el = document.getElementById("login-error");
    if (el) el.classList.add("hidden");
  }

  async function onLoginSubmit(e) {
    e.preventDefault();
    clearError();
    var username = document.getElementById("username").value.trim();
    var password = document.getElementById("password").value;
    var btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    var r = await PolarisAuthFlow.login(username, password);
    if (!r.ok) { showError(r.error); btn.disabled = false; return; }
    handleLoginOutcome(document.getElementById("app"), r);
  }

  /**
   * What a finished step means — the mobile twin of login.js's function of the
   * same name. Any step can hand back any of the three outcomes, so routing
   * them in one place is what keeps "second factor, then forced password
   * change" working without each screen knowing about the other.
   */
  function handleLoginOutcome(app, r) {
    if (r.mfaRequired) {
      pendingToken = r.pendingToken;
      mfaMethods = r.methods || { totp: true, passkey: false };
      renderTotp(app);
      return;
    }
    if (r.passwordChangeRequired) {
      pwChangeToken = r.pendingToken;
      renderPasswordChange(app);
      return;
    }
    // Success — re-bootstrap with the new session. Unpin .app first: the
    // authenticated shell sizes itself off height:100%, and the measurement
    // pass that would otherwise clear the class only runs on the next
    // viewport event.
    resetKeyboardFit();
    window.PolarisMobile.boot();
  }

  /**
   * Forced password change, reached only once every factor has passed. The
   * phone needs this screen for the same reason the desktop does: without it
   * the SPA treats the withheld session as a success, boots, finds no session
   * and bounces straight back to the login form — a loop with no explanation.
   */
  function renderPasswordChange(app) {
    app.dataset.tab = "";
    app.innerHTML = ''
      + '<div class="app-body">'
      + '  <div class="login-shell">'
      + '    <div class="logo-mark"><svg viewBox="0 0 24 24"><use href="#i-shield"/></svg></div>'
      + '    <h2>New password</h2>'
      + '    <div class="sub">Your password no longer meets this system\'s complexity requirements.</div>'
      + '    <div id="login-error" class="hidden" style="width:100%;background:var(--md-error-container);color:var(--md-on-error-container);border-radius:var(--shape-xs);padding:10px 14px;font-size:13px;margin-bottom:12px;letter-spacing:.25px;"></div>'
      + '    <form id="pwchange-form" style="width:100%;">'
      + '      <div class="full-field">'
      + '        <div class="tf-outlined"><span class="lbl">New password</span>'
      + '          <input class="field" type="password" id="pw-new" autocomplete="new-password" required autofocus>'
      + '        </div>'
      + '      </div>'
      + '      <div id="pw-new-checks"></div>'
      + '      <div class="full-field" style="margin-top:12px;">'
      + '        <div class="tf-outlined"><span class="lbl">Confirm password</span>'
      + '          <input class="field" type="password" id="pw-confirm" autocomplete="new-password" required>'
      + '        </div>'
      + '      </div>'
      + '      <div id="pw-confirm-match"></div>'
      + '      <button type="submit" class="btn btn-filled btn-block" style="height:48px;margin-top:12px;">Set password and sign in</button>'
      + '    </form>'
      + '  </div>'
      + '</div>';

    // The checklist is the shared module's, which fetches the live policy — so
    // what this screen asks for is what the server will accept.
    document.getElementById("pw-new-checks").outerHTML = PolarisPasswordSelf.rulesHTML("pw-new-checks");
    document.getElementById("pw-confirm-match").outerHTML = PolarisPasswordSelf.matchHTML("pw-confirm-match");
    PolarisPasswordSelf.wire("pw-new", "pw-new-checks");
    PolarisPasswordSelf.wireMatch("pw-new", "pw-confirm", "pw-confirm-match");

    document.getElementById("pwchange-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      clearError();
      var next = document.getElementById("pw-new").value;
      if (!PolarisPasswordSelf.check(next, "pw-new-checks")) {
        showError("The new password does not meet the complexity requirements.");
        return;
      }
      if (next !== document.getElementById("pw-confirm").value) {
        showError("The two passwords do not match.");
        return;
      }
      var btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      var r = await PolarisAuthFlow.changePasswordAtLogin(pwChangeToken, next);
      if (!r.ok) { showError(r.error); btn.disabled = false; return; }
      pwChangeToken = null;
      resetKeyboardFit();
      window.PolarisMobile.boot();
    });

    kbLastScrolled = null;
    installKeyboardFit();
    scheduleKeyboardFit();
  }

  async function onTotpSubmit(e) {
    e.preventDefault();
    clearError();
    var input = document.getElementById("totp-code");
    var code = input.value.trim();
    if (!code) return;
    var isBackupCode = input.dataset.mode === "backup";
    var btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    var r = await PolarisAuthFlow.confirmTotp(pendingToken, code, isBackupCode);
    if (!r.ok) {
      showError(r.error);
      if (!r.network) input.select();
      btn.disabled = false;
      return;
    }
    pendingToken = null;
    handleLoginOutcome(document.getElementById("app"), r);
  }

  window.PolarisAuth = {
    renderLogin: renderLogin,
    markSignedOut: markSignedOut,
  };
})();
