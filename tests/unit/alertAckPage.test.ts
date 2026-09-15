/**
 * tests/unit/alertAckPage.test.ts — acknowledging from an email, after the
 * single-use-token cutover (business rule 25).
 *
 * The link in an alert email is now an ordinary Polaris page URL naming ONE
 * alert, and identity comes from the session the reader signs into. Three
 * things have to hold for that to be an improvement rather than a regression,
 * and each is easy to break without noticing:
 *
 *  1. The URL carries the ALERT and nothing else. A recipient identifier
 *     sneaking back in would silently re-introduce the per-recipient fan-out.
 *  2. One composed body is filled ONCE, and blanks the button away rather than
 *     mailing a literal "{ack}" on an install with no public URL.
 *  3. The reader comes back to the alert after logging in. Without the
 *     remembered target the emailed button lands on the dashboard, which is
 *     the whole reason the old token existed.
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ackUrlForEmail, ackUrlForPush, substituteAckToken } from "../../src/utils/notificationTemplate.js";
import { fillComposedAckUrl } from "../../src/services/notificationRecipientService.js";
import {
  readCookie,
  takeLoginTarget,
  rememberLoginTarget,
  peekLoginTarget,
  generateRelayState,
  relayStateTarget,
  LOGIN_NEXT_COOKIE,
} from "../../src/utils/loginRedirect.js";

const PREV_PUBLIC_URL = process.env.POLARIS_PUBLIC_URL;
afterEach(() => {
  if (PREV_PUBLIC_URL === undefined) delete process.env.POLARIS_PUBLIC_URL;
  else process.env.POLARIS_PUBLIC_URL = PREV_PUBLIC_URL;
});

describe("acknowledge URL", () => {
  it("names the alert and only the alert", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    const url = ackUrlForEmail("n-123");
    expect(url).toBe("https://polaris.example.com/alert-ack.html?id=n-123");
    // No recipient, no user, no secret. If any of those appear here the body
    // stops being shareable and the fan-out has to come back.
    expect(url).not.toMatch(/user|token|recipient/i);
  });

  it("is identical for every recipient of the same alert", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(ackUrlForEmail("n-1")).toBe(ackUrlForEmail("n-1"));
    expect(ackUrlForEmail("n-1")).not.toBe(ackUrlForEmail("n-2"));
  });

  it("escapes an id rather than pasting it into the query string", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com";
    expect(ackUrlForEmail("a&b=c")).toBe("https://polaris.example.com/alert-ack.html?id=a%26b%3Dc");
  });

  it("tolerates a trailing slash on the public URL", () => {
    process.env.POLARIS_PUBLIC_URL = "https://polaris.example.com/";
    expect(ackUrlForEmail("n1")).toBe("https://polaris.example.com/alert-ack.html?id=n1");
  });

  it("is null for EMAIL without a public URL — a relative link in an inbox resolves against nothing", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(ackUrlForEmail("n1")).toBeNull();
  });

  it("is never null for WEB PUSH — the service worker resolves a relative path against its own origin", () => {
    delete process.env.POLARIS_PUBLIC_URL;
    expect(ackUrlForPush("n1")).toBe("/alert-ack.html?id=n1");
  });
});

describe("fillComposedAckUrl", () => {
  // The button row as the shipped template actually builds it: the ack button,
  // a spacer, and the Open-device button. Both details matter — the cell is
  // what carries the button's styling away with it (pruneDeadLinks has a bare
  // <a href=""> fallback for operator templates, but it leaves the cell), and
  // a TWO-cell row is a label/value pair pruneEmptyRows drops wholesale.
  const composed = {
    subject: "Alert",
    text: "CPU high\n\nAcknowledge:      {ack}\n",
    html: '<tr><td style="border-radius:6px;background:#ff1744">'
      + '<a href="{ack}" style="display:inline-block">Acknowledge alert</a></td>'
      + '<td style="width:10px">&nbsp;</td>'
      + '<td><a href="https://p.example.com/assets.html">Open device</a></td></tr>',
  };

  it("fills every copy of the token in one pass", () => {
    const out = fillComposedAckUrl(composed, "https://p.example.com/alert-ack.html?id=n1");
    expect(out.text).toContain("https://p.example.com/alert-ack.html?id=n1");
    expect(out.html).toContain('href="https://p.example.com/alert-ack.html?id=n1"');
    expect(out.text).not.toContain("{ack}");
    expect(out.html).not.toContain("{ack}");
  });

  it("blanks the button away rather than mailing a literal token", () => {
    // The install with no POLARIS_PUBLIC_URL is exactly the one least likely
    // to notice "{ack}" sitting in an operator's inbox.
    const out = fillComposedAckUrl(composed, null);
    expect(out.text).not.toContain("{ack}");
    expect(out.html).not.toContain("{ack}");
    // The dead "Acknowledge:" line and the empty-href button are pruned, not
    // left behind pointing at nothing.
    expect(out.text).not.toMatch(/Acknowledge:\s*$/m);
    expect(out.html).not.toContain('href=""');
  });

  it("leaves a body with no {ack} in it untouched", () => {
    const plain = { subject: "S", text: "nothing to fill", html: "<p>nothing to fill</p>" };
    const out = fillComposedAckUrl(plain, "https://p.example.com/alert-ack.html?id=n1");
    expect(out.text).toBe("nothing to fill");
    expect(out.html).toBe("<p>nothing to fill</p>");
  });

  it("omits html entirely when the composition had none", () => {
    const out = fillComposedAckUrl({ subject: "S", text: "x {ack}" }, null);
    expect(out).not.toHaveProperty("html");
  });

  it("escapes the URL when it lands in HTML", () => {
    const out = substituteAckToken('<a href="{ack}">x</a>', "https://p.example.com/a?id=1&b=2", { html: true });
    expect(out).toContain("&amp;b=2");
  });
});

describe("post-login return target", () => {
  const res = () => {
    const cookies: Array<{ name: string; value: string; opts: any }> = [];
    return {
      cookies,
      cookie: (name: string, value: string, opts: any) => cookies.push({ name, value, opts }),
      clearCookie: vi.fn(),
    } as any;
  };
  const req = (cookieHeader?: string, secure = true, dest?: string) =>
    ({
      secure,
      get: (h: string) => {
        const k = h.toLowerCase();
        if (k === "cookie") return cookieHeader;
        if (k === "sec-fetch-dest") return dest;
        return undefined;
      },
    }) as any;

  it("remembers where an emailed link was headed", () => {
    const r = res();
    rememberLoginTarget(req(), r, "/alert-ack.html?id=n1");
    expect(r.cookies[0].name).toBe(LOGIN_NEXT_COOKIE);
    expect(r.cookies[0].value).toBe("/alert-ack.html?id=n1");
    // login.js reads it, so it cannot be HttpOnly — safeNextPath is what makes
    // that safe, not the flag.
    expect(r.cookies[0].opts.httpOnly).toBe(false);
  });

  it("goes out SameSite=None on HTTPS so it survives the IdP's cross-site POST", () => {
    // Lax is not sent on a cross-site POST, which is exactly the shape of the
    // SAML assertion coming back from Azure — the cookie was never present at
    // /azure/callback, so every emailed Acknowledge link landed on "/".
    const r = res();
    rememberLoginTarget(req(undefined, true), r, "/alert-ack.html?id=n1");
    expect(r.cookies[0].opts.sameSite).toBe("none");
    expect(r.cookies[0].opts.secure).toBe(true);
  });

  it("remembers a target only for a top-level navigation", () => {
    // Under SameSite=None a browser stores the cookie a cross-site SUBRESOURCE
    // provoked, so `<img src="…/alert-ack.html?id=x">` on a foreign page could
    // otherwise choose where the operator lands after their next sign-in.
    for (const dest of ["image", "iframe", "script", "empty"]) {
      const r = res();
      rememberLoginTarget(req(undefined, true, dest), r, "/alert-ack.html?id=n1");
      expect(r.cookies).toHaveLength(0);
    }
    const nav = res();
    rememberLoginTarget(req(undefined, true, "document"), nav, "/alert-ack.html?id=n1");
    expect(nav.cookies).toHaveLength(1);
    // No header at all (a pre-2020 browser, curl) keeps the old behaviour.
    const bare = res();
    rememberLoginTarget(req(undefined, true, undefined), bare, "/alert-ack.html?id=n1");
    expect(bare.cookies).toHaveLength(1);
  });

  it("stays Lax on plain HTTP, where a browser would drop None outright", () => {
    const r = res();
    rememberLoginTarget(req(undefined, false), r, "/alert-ack.html?id=n1");
    expect(r.cookies[0].opts.sameSite).toBe("lax");
    expect(r.cookies[0].opts.secure).toBe(false);
  });

  it("peeks without consuming, so a failed SSO round trip still has its target", () => {
    // It takes no Response at all — there is nothing it could clear. The SAML
    // login route is only the outbound half of a flow that can fail, and
    // login.js still reads the cookie if the operator lands back on the form.
    const header = `${LOGIN_NEXT_COOKIE}=%2Falert-ack.html%3Fid%3Dn1`;
    expect(peekLoginTarget(req(header))).toBe("/alert-ack.html?id=n1");
    // Nothing worth returning to reads as null, not as "/" — the SAML login
    // route branches on it rather than folding "/" into the RelayState.
    expect(peekLoginTarget(req(undefined))).toBeNull();
    expect(peekLoginTarget(req(`${LOGIN_NEXT_COOKIE}=%2Flogin.html`))).toBeNull();
  });

  it("does not write a cookie for the destination login already lands on", () => {
    const r = res();
    rememberLoginTarget(req(), r, "/");
    expect(r.cookies).toHaveLength(0);
  });

  it("refuses an off-origin target instead of storing it", () => {
    const r = res();
    rememberLoginTarget(req(), r, "https://evil.example.net/steal");
    rememberLoginTarget(req(), r, "//evil.example.net/steal");
    rememberLoginTarget(req(), r, "/\\evil.example.net/steal");
    // Each reduces to "/", which is the case that writes nothing at all.
    expect(r.cookies).toHaveLength(0);
  });

  it("reads the target back and always clears it", () => {
    const r = res();
    expect(takeLoginTarget(req(`${LOGIN_NEXT_COOKIE}=%2Falert-ack.html%3Fid%3Dn1`), r))
      .toBe("/alert-ack.html?id=n1");
    expect(r.clearCookie).toHaveBeenCalled();

    // A target that failed to be honored must not ambush the NEXT login.
    const r2 = res();
    expect(takeLoginTarget(req(undefined), r2)).toBe("/");
    expect(r2.clearCookie).toHaveBeenCalled();
  });

  it("never sends the operator back to the login form", () => {
    // Landing on a login page after signing in reads as a failed login.
    expect(takeLoginTarget(req(`${LOGIN_NEXT_COOKIE}=%2Flogin.html`), res())).toBe("/");
  });

  it("picks the right cookie out of a crowded header", () => {
    const header = `polaris_csrf=abc; ${LOGIN_NEXT_COOKIE}=%2Fassets.html; connect.sid=xyz`;
    expect(readCookie(header, LOGIN_NEXT_COOKIE)).toBe("/assets.html");
    expect(readCookie(header, "nope")).toBeNull();
    expect(readCookie(undefined, LOGIN_NEXT_COOKIE)).toBeNull();
  });

  it("survives a malformed percent-escape without throwing", () => {
    expect(readCookie(`${LOGIN_NEXT_COOKIE}=%E0%A4%A`, LOGIN_NEXT_COOKIE)).toBeNull();
  });
});

describe("SAML RelayState as the second carrier", () => {
  // The IdP POSTs the assertion back cross-site, where no SameSite=Lax cookie
  // is sent — RelayState is what carries the destination across that hop.
  const ACK = "/alert-ack.html?id=0c3a4f1e-2b7d-4a55-9f60-8e1d2c3b4a59";

  it("carries an emailed ack link back, and reads it out again", () => {
    const state = generateRelayState(ACK);
    expect(state).toContain(".");
    expect(relayStateTarget(state)).toBe(ACK);
  });

  it("carries the longest link Polaris sends without breaking the 80-byte ceiling", () => {
    // A pushed ack link is the email's plus `&src=push` — the worst case the
    // budget in loginRedirect.ts is sized against. Some IdPs truncate past 80.
    const pushed = `${ACK}&src=push`;
    const state = generateRelayState(pushed);
    expect(Buffer.byteLength(state)).toBeLessThanOrEqual(80);
    expect(relayStateTarget(state)).toBe(pushed);
  });

  it("drops a target too long to fit rather than truncating it", () => {
    // Half a path is a worse landing than the dashboard; the cookie is the
    // fallback here, so the relay state carries the nonce alone.
    const state = generateRelayState("/assets.html?" + "q=".repeat(60));
    expect(Buffer.byteLength(state)).toBeLessThanOrEqual(80);
    expect(state).not.toContain(".");
    expect(relayStateTarget(state)).toBeNull();
  });

  it("stays an opaque nonce when there is nowhere in particular to return", () => {
    for (const nothing of [undefined, null, "/", ""]) {
      const state = generateRelayState(nothing);
      expect(state).not.toContain(".");
      expect(relayStateTarget(state)).toBeNull();
    }
  });

  it("is unguessable — two calls never collide", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateRelayState(ACK)));
    expect(seen.size).toBe(200);
  });

  it("re-sanitizes on the way back in, since the IdP and the browser touched it", () => {
    // A relay state is echoed by a third party, so what comes back is
    // untrusted input — the same open-redirect guard runs on it as on the
    // cookie. Nothing here is authorized by RelayState; it names a page.
    expect(relayStateTarget("nonce.https://evil.example.net/steal")).toBeNull();
    expect(relayStateTarget("nonce.//evil.example.net/steal")).toBeNull();
    expect(relayStateTarget("nonce./\\evil.example.net/steal")).toBeNull();
    // Landing back on the login form would read as a failed sign-in.
    expect(relayStateTarget("nonce./login.html")).toBeNull();
    // Non-strings (a missing RelayState in the POST body) are not a crash.
    expect(relayStateTarget(undefined)).toBeNull();
    expect(relayStateTarget(42)).toBeNull();
  });

  it("splits on the FIRST separator, so a dotted path survives intact", () => {
    expect(relayStateTarget("abc./alert-ack.html?id=n1")).toBe("/alert-ack.html?id=n1");
  });
});

/* ─── The page itself ──────────────────────────────────────────────────────── */

// The page's shell + states. Its markup for the alert itself comes from
// PolarisAlertAckView, which the page loads first (and which the in-app
// acknowledge modal loads too) — so the harness evaluates that module before
// the page, exactly as alert-ack.html orders the two <script> tags.
const VIEW_SRC = readFileSync(join(process.cwd(), "public", "js", "alert-ack-view.js"), "utf-8");
const PAGE_SRC = readFileSync(join(process.cwd(), "public", "js", "alert-ack.js"), "utf-8");

const ALERT = {
  id: "n1",
  message: "PINERUN-222E-4 is down",
  severity: "critical",
  assetId: "a1",
  assetHostname: "PINERUN-222E-4",
  dimension: null,
  ruleName: "Asset down",
  triggeredAt: "2026-08-27T10:00:00Z",
  testRun: false,
  acknowledged: false,
  acknowledgedBy: null,
  acknowledgedAt: null,
  acknowledgeNote: null,
  cleared: false,
  requireAckNote: false,
};

const g = globalThis as any;

async function renderPage(opts?: { alert?: any; getFails?: number; ackFails?: { status: number; message: string } }) {
  document.body.innerHTML = `
    <div class="ack-wrapper"><div class="ack-card" id="ack-card">
      <div class="ack-brand" id="ack-brand" style="display:none"></div>
      <h1 class="ack-title" id="ack-title">Loading alert…</h1>
      <p class="ack-lead" id="ack-lead"></p>
      <div id="ack-body"></div>
    </div></div>`;

  let row = { ...ALERT, ...(opts?.alert ?? {}) };
  const acked: Array<{ ids: string[]; note?: string; source?: string }> = [];

  g.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ appName: "", customLogo: false }) }));
  g.PolarisBrandLogo = { applyTo: vi.fn(() => ({ custom: false })), onThemeChange: vi.fn() };
  g.api = {
    alerts: {
      get: vi.fn(async () => {
        if (opts?.getFails) {
          const e: any = new Error("nope");
          e.status = opts.getFails;
          throw e;
        }
        return row;
      }),
      acknowledge: vi.fn(async (ids: string[], note?: string, source?: string) => {
        acked.push({ ids, note, source });
        if (opts?.ackFails) {
          const e: any = new Error(opts.ackFails.message);
          e.status = opts.ackFails.status;
          throw e;
        }
        row = { ...row, acknowledged: true, acknowledgedBy: "dmoore", acknowledgedAt: "2026-08-27T10:05:00Z", acknowledgeNote: note ?? null };
        return { acknowledged: 1 };
      }),
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(VIEW_SRC)();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(PAGE_SRC)();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { acked, title: () => document.getElementById("ack-title")!.textContent, body: () => document.getElementById("ack-body")! };
}

describe("alert-ack.js", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/alert-ack.html?id=n1");
    vi.restoreAllMocks();
  });

  it("shows the alert and an acknowledge button", async () => {
    const p = await renderPage();
    expect(p.title()).toBe("Acknowledge this alert?");
    expect(p.body().innerHTML).toContain("PINERUN-222E-4 is down");
    expect(p.body().innerHTML).toContain("Asset down");
    expect(p.body().querySelector("#ack-submit")).toBeTruthy();
    expect(p.body().querySelector("#ack-note")).toBeTruthy();
  });

  it("acknowledges with the typed note and the page's own provenance", async () => {
    const p = await renderPage();
    (p.body().querySelector("#ack-note") as HTMLTextAreaElement).value = "  replaced the SFP  ";
    (p.body().querySelector("#ack-submit") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(p.acked).toEqual([{ ids: ["n1"], note: "replaced the SFP", source: "ack_page" }]);
    expect(p.title()).toBe("Acknowledged");
  });

  it("marks a push-originated acknowledgement as such", async () => {
    window.history.replaceState({}, "", "/alert-ack.html?id=n1&src=push");
    const p = await renderPage();
    (p.body().querySelector("#ack-submit") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(p.acked[0].source).toBe("web_push_action");
  });

  it("sends an untouched note box as no note at all", async () => {
    const p = await renderPage();
    (p.body().querySelector("#ack-submit") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(p.acked[0].note).toBeUndefined();
  });

  it("asks for the note when the automation demands one", async () => {
    const p = await renderPage({ alert: { requireAckNote: true } });
    expect(document.getElementById("ack-lead")!.textContent).toContain("asks for a note");
    expect(p.body().querySelector("#ack-note")!.hasAttribute("required")).toBe(true);
    expect(p.body().innerHTML).toContain("Add a note (required)");
  });

  it("re-renders the form with the reason when the server refuses an empty note", async () => {
    // The policy is enforced in acknowledgeNotifications, not here — so a 400
    // is form validation and must not become a dead end.
    const p = await renderPage({ alert: { requireAckNote: true }, ackFails: { status: 400, message: "A note is required" } });
    (p.body().querySelector("#ack-submit") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(p.title()).toBe("Acknowledge this alert?");
    expect(p.body().innerHTML).toContain("A note is required");
    expect(p.body().querySelector("#ack-submit")).toBeTruthy();
  });

  it("says so plainly when the reader's role can see alerts but not acknowledge them", async () => {
    const p = await renderPage({ ackFails: { status: 403, message: "Forbidden" } });
    (p.body().querySelector("#ack-submit") as HTMLElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(p.title()).toContain("can't acknowledge");
  });

  it("reports who got there first instead of offering a second acknowledgement", async () => {
    const p = await renderPage({ alert: { acknowledged: true, acknowledgedBy: "jsmith", acknowledgeNote: "known issue" } });
    expect(p.title()).toBe("Acknowledged");
    expect(document.getElementById("ack-lead")!.textContent).toContain("jsmith");
    // The note is shown back — requiring one and displaying it nowhere is the
    // bug that made the in-app note write-only for a release.
    expect(p.body().innerHTML).toContain("known issue");
    expect(p.body().querySelector("#ack-submit")).toBeNull();
  });

  it("offers nothing to acknowledge on an alert that already cleared", async () => {
    const p = await renderPage({ alert: { cleared: true } });
    expect(p.title()).toContain("already cleared");
    expect(p.body().querySelector("#ack-submit")).toBeNull();
  });

  it("treats a region-scoped miss the same as a deleted alert", async () => {
    // The route answers 404 rather than 403 for an alert outside the caller's
    // regions; either way the reader learns only that the link goes nowhere.
    for (const status of [404, 403]) {
      const p = await renderPage({ getFails: status });
      expect(p.title(), `status ${status}`).toContain("not here any more");
    }
  });

  it("offers a retry rather than a dead page when the read fails", async () => {
    const p = await renderPage({ getFails: 500 });
    expect(p.title()).toBe("Something went wrong");
    expect(p.body().querySelector("#ack-retry")).toBeTruthy();
  });

  it("escapes alert text rather than rendering it", async () => {
    const p = await renderPage({ alert: { message: '<img src=x onerror="alert(1)">' } });
    expect(p.body().innerHTML).toContain("&lt;img");
    expect(p.body().querySelector("img")).toBeNull();
  });
});
