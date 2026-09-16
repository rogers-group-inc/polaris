/**
 * tests/integration/ssoEntryRateLimit.test.ts — the SSO entry redirects do not
 * share the password form's budget.
 *
 * Until 2026-09-16 `GET /auth/azure/login` was mounted under the same
 * ten-guess-per-15-minute limiter — and the same store — as `POST /auth/login`.
 * Two consequences, both invisible from the route file: a site that spent the
 * budget signing in lost its SAML redirect as well (rule 25 says SSO is never
 * gated, and this gated it), and eleven clicks on "Sign in with Microsoft" from
 * one NAT egress address refused the twelfth. It now carries `ssoEntryLimiter`
 * at the route, exactly like its `/oidc/login` sibling.
 *
 * The assertion is the coupling, not the ceiling: exhaust the login limiter,
 * then prove both SSO entry points still redirect. Neither needs SSO to be
 * configured — an unconfigured provider redirects to /login.html with an error,
 * which is still proof the limiter let the request through.
 */

import { it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app, resetLoginRateLimit } from "../../src/app.js";
import { dbDescribe } from "./_helpers.js";

// Both cases reach the DB (the login route reads the user, the SSO entry points
// read their settings row), so they skip cleanly without one like every other
// integration suite here.
dbDescribe("SSO entry redirects are off the password-guessing budget", () => {
  beforeEach(() => {
    resetLoginRateLimit();
  });

  it("keeps redirecting after the login limiter is exhausted", async () => {
    // Spend the whole 10-per-15-min allowance on the password form. The
    // credentials are wrong on purpose: what is being exhausted is the
    // attempt counter, which counts refusals just the same.
    for (let i = 0; i < 12; i++) {
      await request(app)
        .post("/api/v1/auth/login")
        .send({ username: "nobody", password: "wrong" });
    }

    // The form itself is now refused — this is what makes the test meaningful.
    const spent = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: "nobody", password: "wrong" });
    expect(spent.status).toBe(429);

    // Both SSO entry points must still be reachable.
    for (const path of ["/api/v1/auth/azure/login", "/api/v1/auth/oidc/login"]) {
      const res = await request(app).get(path);
      expect(res.status, `${path} was refused by the login limiter`).toBe(302);
      expect(res.headers.location).toContain("/login.html");
    }
  });

  it("clears a shift-start burst from one NAT egress address", async () => {
    // The ceiling is sized against the CALLBACK limiter, not the login one:
    // one sign-in is one entry then one callback from the same address, so an
    // entry ceiling below the callback's makes the callback's unreachable. The
    // old 30 / 15 min capped a whole site at ten sign-ins per five minutes.
    // 40 consecutive calls is past that and past the old ceiling outright,
    // which is the number this case exists to defend.
    for (const path of ["/api/v1/auth/azure/login", "/api/v1/auth/oidc/login"]) {
      for (let i = 0; i < 40; i++) {
        const res = await request(app).get(path);
        expect(res.status, `${path} call ${i + 1} was rate limited`).toBe(302);
      }
    }
  });
});
