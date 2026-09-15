/**
 * tests/unit/loginPageSkipLandings.test.ts
 *
 * "Skip login page" redirects the bare /login.html to SSO, so where a session
 * ENDS matters: a logout that landed on the login page would be signed straight
 * back in by a silent prompt=none provider. This pins the three sides of that
 * contract at the source level (the DB-backed redirect itself is exercised by
 * tests/integration/loginPageSkip.test.ts):
 *
 *  - every desktop logout landing — account menu, client inactivity timer,
 *    server-side idle check — is /signed-out.html, a page with NO sign-in
 *    fields whose one control is a plain link to the BARE /login.html (so the
 *    skip setting, not the page, decides SSO-or-form);
 *  - the Settings tab's hint names `/login.html?local=1`, the anti-lockout
 *    path (an admin reading the hint during an IdP outage must be told the
 *    key, since the bare URL no longer draws the form);
 *  - app.ts lets exactly `error` and `local` through — `error` because every
 *    SSO failure route redirects to /login.html?error=…, and redirecting that
 *    again would ping-pong with the IdP forever.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf-8");

describe("desktop logout landings", () => {
  const appJs = read("public", "js", "app.js");

  it("app.js never navigates to the login page directly — every logout lands on /signed-out.html", () => {
    expect(appJs.match(/window\.location\.href = "\/login\.html[^"]*"/g)).toBeNull();
    const landings = appJs.match(/window\.location\.href = "\/signed-out\.html[^"]*"/g) ?? [];
    expect(landings.length).toBeGreaterThanOrEqual(2); // account menu + inactivity timer
    expect(landings).toContain('window.location.href = "/signed-out.html?reason=inactivity"');
  });

  it("the server-side idle logout lands there too, with the same reason", () => {
    const appTs = read("src", "app.ts");
    expect(appTs).toContain('res.redirect("/signed-out.html?reason=inactivity")');
    expect(appTs).not.toContain('res.redirect("/login.html?signed_out');
  });

  it("api.js 401 redirects stay BARE so an expired session re-enters SSO silently", () => {
    const apiJs = read("public", "js", "api.js");
    const landings = apiJs.match(/window\.location\.href = "\/login\.html[^"]*"/g) ?? [];
    expect(landings.length).toBeGreaterThan(0);
    for (const l of landings) expect(l).toBe('window.location.href = "/login.html"');
  });
});

describe("the signed-out page", () => {
  const html = read("public", "signed-out.html");

  it("carries no sign-in fields", () => {
    expect(html).not.toMatch(/<form\b/i);
    expect(html).not.toMatch(/<input\b/i);
    expect(html).not.toMatch(/autocomplete=/i);
  });

  it("offers one Sign in control that opens the BARE login page", () => {
    // Bare: no query key, so app.ts's skip redirect decides SSO-or-form.
    expect(html).toContain('href="/login.html"');
    expect(html).not.toMatch(/href="\/login\.html\?/);
    expect(html).not.toContain("/api/v1/auth/");
  });

  it("renders the reason from a closed set via textContent, never innerHTML", () => {
    const js = read("public", "js", "signed-out.js");
    expect(js).toMatch(/var REASONS = \{/);
    expect(js).toContain("hasOwnProperty.call(REASONS, reason)");
    expect(js).toContain("msgEl.textContent");
    expect(js).not.toMatch(/\.innerHTML\s*=/); // the comment may name it; the code may not assign it
  });

  it("loads theme-init.js FIRST, as the standalone-page canon requires", () => {
    const firstScript = html.match(/<script[^>]*src="([^"]+)"/)![1];
    expect(firstScript).toBe("/js/theme-init.js");
    expect(html.indexOf('src="/js/theme-init.js"')).toBeLessThan(html.indexOf('href="/css/styles.css"'));
  });
});

describe("the anti-lockout path is named where an admin will read it", () => {
  it("the Settings tab hint points at /login.html?local=1", () => {
    const usersJs = read("public", "js", "users.js");
    expect(usersJs).toContain("<code>/login.html?local=1</code>");
  });
});

describe("app.ts form-drawing query keys", () => {
  const appTs = read("src", "app.ts");

  it("declares exactly error and local", () => {
    const m = appTs.match(/const LOGIN_FORM_QUERY_KEYS = \[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const keys = m![1].split(",").map(s => s.trim().replace(/^"|"$/g, "")).filter(Boolean).sort();
    expect(keys).toEqual(["error", "local"]);
  });

  it("every SSO failure route lands on /login.html WITH ?error= (the anti-loop key)", () => {
    const authTs = read("src", "api", "routes", "auth.ts");
    const landings = authTs.match(/redirect\((["`])\/login\.html[^"`]*\1\)/g) ?? [];
    expect(landings.length).toBeGreaterThan(5);
    for (const l of landings) expect(l).toContain("/login.html?error=");
  });
});
