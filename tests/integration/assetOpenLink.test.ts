/**
 * tests/integration/assetOpenLink.test.ts — the `/assets/<id>` landing route
 * over the real app.
 *
 * The pure decision is pinned in tests/unit/assetOpenLink.test.ts; this file
 * proves the wiring: the route is mounted, reads the user-agent and the
 * `?desktop=1` escape hatch, is never cacheable, remembers ITSELF as the login
 * target when signed out (the device lives in a fragment the server never
 * sees), and lets a non-id fall through to the static handler rather than
 * redirecting. Skips cleanly when DATABASE_URL isn't reachable (importing the
 * app opens the pool).
 */

import { it, expect, beforeAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { authedAgent, dbDescribe, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const ID = "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

/** The `polaris_next` value a response set, decoded, or null. */
function rememberedTarget(res: { headers: Record<string, unknown> }): string | null {
  const raw = res.headers["set-cookie"];
  const list = Array.isArray(raw) ? raw : raw ? [String(raw)] : [];
  const hit = list.find(c => c.startsWith("polaris_next="));
  if (!hit) return null;
  return decodeURIComponent(hit.slice("polaris_next=".length).split(";")[0]);
}

d("GET /assets/:id (the emailed Open device link)", () => {
  beforeAll(async () => { await ensureTestUser(); });

  it("sends a signed-in phone to the mobile SPA's asset detail", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/assets/${ID}`).set("User-Agent", PHONE_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/mobile.html#asset/${ID}`);
  });

  it("sends a signed-in desktop browser to the desktop device page", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/assets/${ID}`).set("User-Agent", DESKTOP_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/assets.html#view=asset:${ID}`);
  });

  it("honours ?desktop=1 on a phone", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/assets/${ID}?desktop=1`).set("User-Agent", PHONE_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/assets.html#view=asset:${ID}`);
  });

  it("signed out on a desktop: bounces to sign-in and remembers THIS link, not the fragment-less page", async () => {
    // Before, it went to /assets.html#view=asset:<id>; that page's gate could
    // only remember "/assets.html" (fragments never reach the server), and the
    // reader signed in to the asset list instead of the device.
    const res = await request(app).get(`/assets/${ID}`).set("User-Agent", DESKTOP_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain("/assets.html");
    expect(rememberedTarget(res)).toBe(`/assets/${ID}`);
  });

  it("signed out on a phone: still opens the SPA, and remembers the link for an SSO round trip", async () => {
    const res = await request(app).get(`/assets/${ID}`).set("User-Agent", PHONE_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/mobile.html#asset/${ID}`);
    expect(rememberedTarget(res)).toBe(`/assets/${ID}`);
  });

  it("signed out with ?desktop=1: the remembered target keeps the escape hatch", async () => {
    const res = await request(app).get(`/assets/${ID}?desktop=1`).set("User-Agent", PHONE_UA);
    expect(res.status).toBe(302);
    expect(rememberedTarget(res)).toBe(`/assets/${ID}?desktop=1`);
  });

  it("signed in: sets no login target", async () => {
    const { agent } = await authedAgent(app);
    const res = await agent.get(`/assets/${ID}`).set("User-Agent", DESKTOP_UA);
    expect(rememberedTarget(res)).toBeNull();
  });

  it("is never cacheable and varies on the user-agent", async () => {
    const res = await request(app).get(`/assets/${ID}`).set("User-Agent", PHONE_UA);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.vary).toMatch(/User-Agent/i);
  });

  it("falls through on anything that is not an asset id", async () => {
    // Not a redirect anywhere — the static handler's 404 is the answer.
    const res = await request(app).get("/assets/not-an-id").set("User-Agent", PHONE_UA);
    expect(res.status).toBe(404);
    expect(rememberedTarget(res)).toBeNull();
  });

  it("leaves the desktop assets PAGE alone on a phone — only the root redirects", async () => {
    // A phone that chose Desktop view navigates the desktop UI by these URLs;
    // the landing route must not have widened the root redirect to them.
    const res = await request(app).get("/assets.html").set("User-Agent", PHONE_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain("/mobile.html");
  });
});
