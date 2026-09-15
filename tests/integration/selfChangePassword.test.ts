/**
 * tests/integration/selfChangePassword.test.ts — `PUT /api/v1/auth/password`
 *
 * The self-service counterpart to the admin-side `PUT /users/:id/password`.
 * End-to-end over the real app because the three things worth pinning are all
 * things a mocked Prisma would wave through:
 *
 *   1. It changes the SESSION's account and nothing else. The body names no
 *      user, which is what makes a route gated on "logged in" safe.
 *   2. It proves knowledge of the current password — an admin reset cannot,
 *      and that difference is why the two write different Events.
 *   3. The session survives the change with its CSRF token intact. The route
 *      rotates the session ID, and `regenerate()` discards `csrfToken` along
 *      with everything else; the helper in auth.ts carries it across so the
 *      page that submitted the form can keep making writes. Without that the
 *      user's NEXT save 403s until they reload, which is exactly the failure
 *      authedAgent() documents having to work around after login.
 *
 * Uses its own user rather than the shared tester: changing that one's
 * password would strand every other suite in the run. Skips cleanly when
 * DATABASE_URL isn't reachable.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { verifyPassword } from "../../src/utils/password.js";
import { hashPassword } from "../../src/utils/password.js";
import { dbDescribe, dbReachable, waitForEventCount } from "./_helpers.js";

const d = dbDescribe;

const USERNAME = "polaris-pwchange-tester";
const ORIGINAL = "Original-Pass-1!";
const REPLACEMENT = "Replacement-Pass-2!";

let userId = "";
let agent: ReturnType<typeof request.agent>;
let csrf = "";

/** Put the row back to a known password + local provider between phases. */
async function resetUserRow(): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(ORIGINAL), authProvider: "local" },
  });
}

beforeAll(async () => {
  if (!dbReachable) return;
  const role = await prisma.role.findUnique({ where: { name: "readonly" } });
  if (!role) throw new Error("built-in 'readonly' Role row missing — run `npx prisma migrate deploy` first");

  // A deliberately UNPRIVILEGED role: the whole point of the route is that it
  // needs no permission at all, so a reader must be able to drive it.
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  const user = await prisma.user.create({
    data: {
      username: USERNAME,
      passwordHash: await hashPassword(ORIGINAL),
      roleId: role.id,
      authProvider: "local",
    },
  });
  userId = user.id;

  agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const login = await agent
    .post("/api/v1/auth/login")
    .send({ username: USERNAME, password: ORIGINAL })
    .set("Content-Type", "application/json");
  if (login.status !== 200) throw new Error(`Login failed (${login.status}): ${JSON.stringify(login.body)}`);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  if (!csrf) throw new Error("CSRF cookie not set after login");
});

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.event.deleteMany({ where: { action: "user.password_changed", resourceId: userId } });
  await prisma.user.deleteMany({ where: { username: USERNAME } });
});

function change(body: Record<string, unknown>) {
  return agent.put("/api/v1/auth/password").set("X-CSRF-Token", csrf).send(body);
}

d("refusals", () => {
  it("rejects a wrong current password without touching the stored hash", async () => {
    await resetUserRow();
    const res = await change({ currentPassword: "not-the-password", newPassword: REPLACEMENT });
    expect(res.status).toBe(401);

    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect((await verifyPassword(ORIGINAL, row!.passwordHash)).valid).toBe(true);
  });

  it("rejects a new password that misses the complexity bar", async () => {
    await resetUserRow();
    const res = await change({ currentPassword: ORIGINAL, newPassword: "alllowercase" });
    expect(res.status).toBe(400);

    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect((await verifyPassword(ORIGINAL, row!.passwordHash)).valid).toBe(true);
  });

  it("rejects re-setting the same password", async () => {
    await resetUserRow();
    const res = await change({ currentPassword: ORIGINAL, newPassword: ORIGINAL });
    expect(res.status).toBe(400);
  });

  it("refuses an account whose provider owns the credential", async () => {
    await resetUserRow();
    await prisma.user.update({ where: { id: userId }, data: { authProvider: "azure" } });
    const res = await change({ currentPassword: ORIGINAL, newPassword: REPLACEMENT });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/identity provider/i);
    await resetUserRow();
  });
});

d("a successful change", () => {
  it("replaces the hash, writes one Event, and leaves the session usable", async () => {
    await resetUserRow();
    const res = await change({ currentPassword: ORIGINAL, newPassword: REPLACEMENT });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The new password is stored and the old one no longer verifies.
    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect((await verifyPassword(REPLACEMENT, row!.passwordHash)).valid).toBe(true);
    expect((await verifyPassword(ORIGINAL, row!.passwordHash)).valid).toBe(false);

    // Audit trail: the self-change is its own action, distinct from the
    // admin-side `user.password_reset`.
    expect(await waitForEventCount("user.password_changed", 1, userId)).toBe(1);

    // The caller is still logged in as themselves...
    const me = await agent.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.authenticated).toBe(true);
    expect(me.body.username).toBe(USERNAME);

    // ...and the CSRF token the page is holding still works on the next
    // write, even though the session ID underneath it rotated. This is the
    // assertion that fails if rotateSessionKeepingIdentity stops carrying
    // `csrfToken` across the regenerate.
    const after = await change({ currentPassword: REPLACEMENT, newPassword: ORIGINAL });
    expect(after.status).toBe(200);
  });
});
