/**
 * tests/integration/notFoundHeaders.test.ts — an unmatched route keeps helmet's headers
 *
 * Regression guard for the 2026-09-10 HawkScan finding "CSP: Wildcard Directive"
 * on /robots.txt and /sitemap.xml.
 *
 * Cause: nothing handled unmatched routes, so Express fell through to its
 * built-in finalhandler, which REPLACES the Content-Security-Policy helmet
 * already set with its own `default-src 'none'`. Neither `frame-ancestors` nor
 * `form-action` falls back to default-src, so every 404 in the app advertised
 * an unrestricted framing and form-submission policy while every normal
 * response carried the real one. finalhandler's HTML body also echoed the
 * request back ("Cannot GET /robots.txt").
 *
 * The fix routes unmatched routes through AppError(404) so errorHandler answers
 * them, which keeps helmet's response headers and returns the app's usual
 * `{ error }` JSON shape. This asserts all three properties; a plain status
 * check would still pass with finalhandler back in place.
 *
 * Note the asymmetry this also pins: an unknown path UNDER /api/v1 answers 401,
 * not 404, for an unauthenticated caller, because requireAuth is mounted on the
 * API router ahead of any route match — the API deliberately does not tell an
 * anonymous caller which endpoints exist. Authenticated, it reaches the same
 * JSON 404 as everything else.
 */

import { it, expect } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { authedAgent, dbDescribe, ensureTestUser } from "./_helpers.js";

// The two unmatched paths the scanner actually reported.
const UNMATCHED = ["/robots.txt", "/sitemap.xml"];

dbDescribe("unmatched routes", () => {
  for (const path of UNMATCHED) {
    it(`${path} is a JSON 404 that keeps the real CSP`, async () => {
      const res = await request(app).get(path);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Not found" });

      const csp = res.headers["content-security-policy"];
      expect(csp, "helmet's CSP must still be on the response").toBeTruthy();

      // The specific regression: finalhandler's policy is exactly this, and it
      // leaves framing and form submission unrestricted.
      expect(csp).not.toBe("default-src 'none'");
      expect(csp).toContain("frame-ancestors 'self'");
      expect(csp).toContain("form-action 'self'");

      // finalhandler echoed the method and path into an HTML body.
      expect(res.text).not.toMatch(/Cannot GET/i);
      expect(res.text).not.toContain(path);
    });
  }

  it("an unknown /api/v1 path is 401 anonymously, JSON 404 once authenticated", async () => {
    const anon = await request(app).get("/api/v1/no-such-endpoint");
    expect(anon.status).toBe(401);

    await ensureTestUser();
    const { agent } = await authedAgent(app);
    const authed = await agent.get("/api/v1/no-such-endpoint");

    expect(authed.status).toBe(404);
    expect(authed.body).toEqual({ error: "Not found" });
    expect(authed.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  });

  it("sends the same CSP on a 404 as on a matched route", async () => {
    const matched = await request(app).get("/login.html");
    const missing = await request(app).get("/robots.txt");

    expect(matched.headers["content-security-policy"]).toBe(
      missing.headers["content-security-policy"],
    );
  });
});
