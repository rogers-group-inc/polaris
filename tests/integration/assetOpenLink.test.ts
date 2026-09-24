/**
 * tests/integration/assetOpenLink.test.ts — the `/assets/<id>` landing route
 * over the real app.
 *
 * The pure decision is pinned in tests/unit/assetOpenLink.test.ts; this file
 * proves the wiring: the route is mounted, reads the user-agent and the
 * `?desktop=1` escape hatch, is never cacheable, needs no session, and lets a
 * non-id fall through to the static handler rather than redirecting. Skips
 * cleanly when DATABASE_URL isn't reachable (importing the app opens the pool).
 */

import { it, expect } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { dbDescribe } from "./_helpers.js";

const d = dbDescribe;

const ID = "3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b";
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

d("GET /assets/:id (the emailed Open device link)", () => {
  it("sends a phone to the mobile SPA's asset detail, without a session", async () => {
    const res = await request(app).get(`/assets/${ID}`).set("User-Agent", PHONE_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/mobile.html#asset/${ID}`);
  });

  it("sends a desktop browser to the desktop assets page", async () => {
    const res = await request(app).get(`/assets/${ID}`).set("User-Agent", DESKTOP_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/assets.html#view=asset:${ID}`);
  });

  it("honours ?desktop=1 on a phone", async () => {
    const res = await request(app).get(`/assets/${ID}?desktop=1`).set("User-Agent", PHONE_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/assets.html#view=asset:${ID}`);
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
  });

  it("leaves the desktop assets PAGE alone on a phone — only the root redirects", async () => {
    // A phone that chose Desktop view navigates the desktop UI by these URLs;
    // the landing route must not have widened the root redirect to them.
    const res = await request(app).get("/assets.html").set("User-Agent", PHONE_UA);
    expect(res.status).toBe(302);
    expect(res.headers.location).not.toContain("/mobile.html");
  });
});
