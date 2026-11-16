/**
 * tests/integration/loginPageSkip.test.ts — "Skip login page" on /login.html
 *
 * The setting used to redirect PROTECTED pages only, so /login.html loaded the
 * password form for anyone who typed the URL, on any network. It now redirects
 * the bare login page too, and two query keys are the only ways to draw the
 * form: `?error=` (an SSO failure just bounced here — anti-loop) and `?local=1`
 * (the anti-lockout path for local / LDAP accounts and an IdP outage). A logout
 * lands on /signed-out.html instead — a page with no form, served regardless of
 * the setting, whose Sign in button opens the bare /login.html so THIS redirect
 * decides SSO-or-form.
 *
 * End-to-end over the real app with a fake-but-complete SAML config (the
 * redirect decision only tests the fields for presence; nothing here reaches
 * the IdP). Skips cleanly when DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { updateSsoSettings } from "../../src/services/azureAuthService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

const SAML_TARGET = "/api/v1/auth/azure/login?prompt=none";
const FAKE_SAML = {
  idpEntityId: "https://idp.example.test/saml",
  idpLoginUrl: "https://idp.example.test/sso",
  idpCertificate: "MIIB-login-page-skip-test",
  // SAML counts as configured only with an Application URL (the SAML client
  // refuses without one) — since 2026-11-16.
  spEntityId: "https://polaris.example.test",
};

/** The `sso` Setting row as it was before the suite, restored afterwards. */
let originalRow: unknown | null | undefined;

async function setSso(opts: { enabled: boolean; skipLoginPage: boolean }): Promise<void> {
  await updateSsoSettings({ ...FAKE_SAML, ...opts });
}

beforeAll(async () => {
  if (!dbReachable) return;
  const row = await prisma.setting.findUnique({ where: { key: "sso" } });
  originalRow = row ? row.value : null;
});

afterAll(async () => {
  if (!dbReachable) return;
  if (originalRow === null) {
    await prisma.setting.deleteMany({ where: { key: "sso" } });
  } else if (originalRow !== undefined) {
    await prisma.setting.upsert({
      where: { key: "sso" },
      update: { value: originalRow as never },
      create: { key: "sso", value: originalRow as never },
    });
  }
  // The in-process TTL cache still holds the test config; put the flag back
  // off so a later file in the same worker can't inherit a skip redirect.
  await updateSsoSettings({ enabled: false, skipLoginPage: false }).catch(() => {});
});

d("skip off (the default)", () => {
  it("serves the login page", async () => {
    await setSso({ enabled: true, skipLoginPage: false });
    const res = await request(app).get("/login.html");
    expect(res.status).toBe(200);
  });

  it("serves the signed-out page", async () => {
    const res = await request(app).get("/signed-out.html");
    expect(res.status).toBe(200);
  });
});

d("skip on with SAML configured", () => {
  beforeAll(async () => {
    if (!dbReachable) return;
    await setSso({ enabled: true, skipLoginPage: true });
  });

  it("redirects the bare login page to SSO", async () => {
    const res = await request(app).get("/login.html");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SAML_TARGET);
  });

  it("still redirects a protected page to the same target", async () => {
    const res = await request(app).get("/assets.html");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SAML_TARGET);
  });

  it("draws the form when an SSO failure bounced here (?error=)", async () => {
    const res = await request(app).get("/login.html?error=sso_callback_error");
    expect(res.status).toBe(200);
  });

  it("draws the form on the anti-lockout path (?local=1)", async () => {
    const res = await request(app).get("/login.html?local=1");
    expect(res.status).toBe(200);
  });

  it("ignores an unrelated query key", async () => {
    const res = await request(app).get("/login.html?utm=x");
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(SAML_TARGET);
  });

  it("serves the signed-out page untouched — a logout must END somewhere", async () => {
    const res = await request(app).get("/signed-out.html?reason=inactivity");
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/login.html"');
    expect(res.text).not.toMatch(/<form\b/i);
  });
});

d("skip on but SSO torn down afterwards", () => {
  it("falls through to the form rather than stranding the operator", async () => {
    await setSso({ enabled: false, skipLoginPage: true });
    const res = await request(app).get("/login.html");
    expect(res.status).toBe(200);
  });
});
