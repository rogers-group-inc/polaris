/**
 * tests/unit/mobileLoginSkip.test.ts
 *
 * "Skip login page" (Users → Authentication → Settings) on the phone SPA.
 *
 * The desktop enforces the setting in app.ts's protected-page redirect, but
 * /mobile.html is deliberately not a protected page — the SPA draws its own
 * login screen, so the page has to load for an unauthenticated visitor. That
 * left the phone as the one surface still offering the username/password form
 * the setting says should not exist, so mobile/auth.js enforces it at the
 * single choke point where a local login gets drawn.
 *
 * What has to hold: the redirect honors the same provider precedence as the
 * server (SAML, then OIDC); it never strands a phone when the flag outlives
 * the SSO config it was set under; and an explicit Sign out still lands on the
 * form once, or a silent (prompt=none) provider would sign the operator
 * straight back in and the button would look broken.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = readFileSync(join(process.cwd(), "public", "js", "mobile", "auth.js"), "utf-8");

const g = globalThis as any;

type Cfg = { enabled: boolean; skipLoginPage?: boolean };

/**
 * Fresh module instance per test — loadSsoConfig memoizes the azure config for
 * the page's lifetime, so one instance could only ever answer one scenario.
 */
function loadAuthModule(azure: Cfg, oidc: Cfg) {
  g.PolarisAuthFlow = {
    fetchBranding: vi.fn(async () => null),
    fetchAzureConfig: vi.fn(async () => azure),
    fetchOidcConfig: vi.fn(async () => oidc),
    login: vi.fn(),
    confirmTotp: vi.fn(),
  };
  g.PolarisMobile = { boot: vi.fn() };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(SRC)();
  return g.PolarisAuth as { renderLogin: (el: HTMLElement) => Promise<void>; markSignedOut: () => void };
}

const appEl = () => document.getElementById("app") as HTMLElement;
const formDrawn = () => !!document.getElementById("login-form");

beforeEach(() => {
  document.body.innerHTML = '<div class="app" id="app"></div>';
  window.location.href = "/mobile.html";
  sessionStorage.clear();
});

describe("mobile login — skip login page", () => {
  it("redirects to SAML instead of drawing the local form", async () => {
    const auth = loadAuthModule({ enabled: true, skipLoginPage: true }, { enabled: false });
    await auth.renderLogin(appEl());
    expect(String(window.location.href)).toContain("/api/v1/auth/azure/login?prompt=none");
    expect(formDrawn()).toBe(false);
  });

  it("falls back to OIDC when SAML is not the configured provider", async () => {
    const auth = loadAuthModule({ enabled: false, skipLoginPage: true }, { enabled: true });
    await auth.renderLogin(appEl());
    expect(String(window.location.href)).toContain("/api/v1/auth/oidc/login");
    expect(formDrawn()).toBe(false);
  });

  it("draws the form when the flag outlives the SSO config — never a locked-out phone", async () => {
    const auth = loadAuthModule({ enabled: false, skipLoginPage: true }, { enabled: false });
    await auth.renderLogin(appEl());
    expect(String(window.location.href)).toContain("/mobile.html");
    expect(formDrawn()).toBe(true);
  });

  it("draws the form normally when the setting is off", async () => {
    const auth = loadAuthModule({ enabled: true, skipLoginPage: false }, { enabled: false });
    await auth.renderLogin(appEl());
    expect(String(window.location.href)).toContain("/mobile.html");
    expect(formDrawn()).toBe(true);
  });

  it("lets an explicit sign-out land on the form once, then resumes redirecting", async () => {
    const auth = loadAuthModule({ enabled: true, skipLoginPage: true }, { enabled: false });

    auth.markSignedOut();
    await auth.renderLogin(appEl());
    expect(String(window.location.href)).toContain("/mobile.html");
    expect(formDrawn()).toBe(true);

    // The marker is spent — a session-expiry 401 after this redirects again.
    document.body.innerHTML = '<div class="app" id="app"></div>';
    await auth.renderLogin(appEl());
    expect(String(window.location.href)).toContain("/api/v1/auth/azure/login?prompt=none");
    expect(formDrawn()).toBe(false);
  });
});
