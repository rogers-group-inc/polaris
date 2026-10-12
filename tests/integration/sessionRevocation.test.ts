/**
 * tests/integration/sessionRevocation.test.ts
 *
 * Business rule 108, the session half:
 *
 *   F188  an account deleted, re-roled, password-reset, or stripped of its second
 *         factor or passkeys kept every session it already held;
 *   F229  the self-service /auth routes admitted a bearer-token caller, whose
 *         undefined userId made a Prisma `where` unfiltered;
 *   F239  /conflicts decided on the role snapshot the session was issued with;
 *   F244  registering a passkey needed no proof beyond a session.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { clearLockout } from "../../src/utils/loginLockout.js";
import { createRole, deleteRole, updateRole } from "../../src/services/roleService.js";
import { createToken } from "../../src/services/apiTokenService.js";
import { savePasskeySettings, invalidatePasskeyCache, defaultPasskeySettings } from "../../src/services/passkeyService.js";
import { authedAgent, dbDescribe, dbReachable, ensureTestUser } from "./_helpers.js";

const d = dbDescribe;

const PASSWORD = "Session-Test-Passw0rd-2026!";
const PLAIN_ROLE = "test-session-plain";
const CONFLICT_ROLE = "test-session-conflicts";
const TOKEN_PREFIX = "test-session-";
const USERS = ["test-session-delete", "test-session-role", "test-session-pw", "test-session-conflict", "test-session-passkey", "test-session-victim"];

let plainRoleId = "";
let conflictRoleId = "";
const ids: Record<string, string> = {};

async function cleanup() {
  await prisma.apiToken.deleteMany({ where: { name: { startsWith: TOKEN_PREFIX } } });
  await prisma.userPasskey.deleteMany({ where: { user: { username: { in: USERS } } } });
  await prisma.user.deleteMany({ where: { username: { in: USERS } } });
  await prisma.role.deleteMany({ where: { name: { in: [PLAIN_ROLE, CONFLICT_ROLE] } } });
}

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await ensureTestUser();
  await cleanup();
  plainRoleId = (await createRole({ name: PLAIN_ROLE, permissions: { assets: "read" } })).id;
  conflictRoleId = (await createRole({ name: CONFLICT_ROLE, permissions: { discoveryConflicts: "write" } })).id;
  const passwordHash = await hashPassword(PASSWORD);
  for (const username of USERS) {
    const roleId = username === "test-session-conflict" ? conflictRoleId : plainRoleId;
    ids[username] = (await prisma.user.create({ data: { username, passwordHash, roleId, authProvider: "local" } })).id;
  }
  await savePasskeySettings({ ...defaultPasskeySettings(), mode: "both" });
  invalidatePasskeyCache();
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  await deleteRole(plainRoleId).catch(() => {});
  await deleteRole(conflictRoleId).catch(() => {});
  await savePasskeySettings({ ...defaultPasskeySettings() });
  invalidatePasskeyCache();
  for (const u of USERS) clearLockout(u);
  await prisma.$disconnect();
});

/** A signed-in browser session for `username`. */
async function signIn(username: string) {
  const agent = request.agent(app);
  await agent.get("/api/v1/auth/me");
  const res = await agent.post("/api/v1/auth/login").send({ username, password: PASSWORD });
  expect(res.status).toBe(200);
  await agent.get("/api/v1/auth/me");
  const cookies = (agent.jar as any).getCookies({ domain: "127.0.0.1", path: "/", secure: false, script: false });
  const csrf = (cookies.find((c: any) => c.name === "polaris_csrf") || {}).value || "";
  return { agent, csrf };
}

const signedIn = async (agent: ReturnType<typeof request.agent>) => (await agent.get("/api/v1/auth/me")).body.authenticated === true;

d("an administrator's act on an account ends that account's sessions (F188)", () => {
  it("a password reset", async () => {
    const target = await signIn("test-session-pw");
    expect(await signedIn(target.agent)).toBe(true);
    const admin = await authedAgent(app);
    const res = await admin.agent.put(`/api/v1/users/${ids["test-session-pw"]}/password`).set("X-CSRF-Token", admin.csrf).send({ password: "Another-Passw0rd-2026!x" });
    expect(res.status).toBe(200);
    expect(await signedIn(target.agent)).toBe(false);
  });

  it("a role change", async () => {
    const target = await signIn("test-session-role");
    expect(await signedIn(target.agent)).toBe(true);
    const admin = await authedAgent(app);
    const res = await admin.agent.put(`/api/v1/users/${ids["test-session-role"]}/role`).set("X-CSRF-Token", admin.csrf).send({ roleId: conflictRoleId });
    expect(res.status).toBe(200);
    expect(await signedIn(target.agent)).toBe(false);
  });

  it("a delete", async () => {
    const target = await signIn("test-session-delete");
    expect(await signedIn(target.agent)).toBe(true);
    const admin = await authedAgent(app);
    const res = await admin.agent.delete(`/api/v1/users/${ids["test-session-delete"]}`).set("X-CSRF-Token", admin.csrf);
    expect(res.status).toBe(204);
    expect(await signedIn(target.agent)).toBe(false);
  });

  it("leaves other people's sessions alone", async () => {
    const bystander = await signIn("test-session-victim");
    const admin = await authedAgent(app);
    await admin.agent.put(`/api/v1/users/${ids["test-session-pw"]}/password`).set("X-CSRF-Token", admin.csrf).send({ password: "Yet-Another-Passw0rd-2026!" });
    expect(await signedIn(bystander.agent)).toBe(true);
  });
});

d("self-service routes need a user session, not a token (F229)", () => {
  it("a bearer token cannot delete or rename another user's passkey", async () => {
    const victim = ids["test-session-victim"];
    const passkey = await prisma.userPasskey.create({
      data: {
        userId: victim,
        credentialId: "test-session-cred-" + Date.now(),
        publicKey: Buffer.from("x"),
        counter: 0,
        name: "Victim key",
        transports: [],
      } as never,
    });
    const role = await prisma.role.findFirst({ where: { name: PLAIN_ROLE } });
    const { rawToken } = await createToken({ name: `${TOKEN_PREFIX}t`, roleId: role!.id, createdBy: "integration-test" });
    const del = await request(app).delete(`/api/v1/auth/passkeys/${passkey.id}`).set("Authorization", `Bearer ${rawToken}`);
    expect(del.status).toBe(401);
    const ren = await request(app).patch(`/api/v1/auth/passkeys/${passkey.id}`).set("Authorization", `Bearer ${rawToken}`).send({ name: "pwned" });
    expect(ren.status).toBe(401);
    const row = await prisma.userPasskey.findUnique({ where: { id: passkey.id } });
    expect(row?.name).toBe("Victim key");
  });
});

d("conflicts decide on a current role snapshot (F239)", () => {
  // /conflicts/count answers 0 for a caller who may not see conflicts, and the
  // real number for one who may — a non-destructive read of the role decision.
  let conflictId = "";
  let assetId = "";

  beforeAll(async () => {
    if (!dbReachable) return;
    assetId = (await prisma.asset.create({ data: { hostname: "test-session-conflict-asset", assetType: "server", status: "active" } })).id;
    conflictId = (await prisma.conflict.create({ data: { entityType: "asset", assetId, status: "pending", proposedHostname: "test-session-conflict-asset" } as never })).id;
  });
  afterAll(async () => {
    if (!dbReachable) return;
    await prisma.conflict.deleteMany({ where: { id: conflictId } });
    await prisma.asset.deleteMany({ where: { id: assetId } });
  });

  it("a role reduced after sign-in takes effect on the next /conflicts request", async () => {
    const user = await signIn("test-session-conflict");
    const before = await user.agent.get("/api/v1/conflicts/count");
    expect(before.body.count).toBeGreaterThanOrEqual(1);

    await updateRole(conflictRoleId, { permissions: { discoveryConflicts: "none" } });

    const after = await user.agent.get("/api/v1/conflicts/count");
    expect(after.body.count).toBe(0);
  });

  it("a bearer token resolves its bound role instead of always being denied", async () => {
    await updateRole(conflictRoleId, { permissions: { discoveryConflicts: "read" } });
    const { rawToken } = await createToken({ name: `${TOKEN_PREFIX}conflicts`, roleId: conflictRoleId, createdBy: "integration-test" });
    const res = await request(app).get("/api/v1/conflicts/count").set("Authorization", `Bearer ${rawToken}`);
    expect(res.status).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(1);
  });
});

d("registering a passkey asks for the current password (F244)", () => {
  it("refuses a missing or wrong password and answers a correct one", async () => {
    const user = await signIn("test-session-passkey");
    const none = await user.agent.post("/api/v1/auth/passkeys/register/options").set("X-CSRF-Token", user.csrf).send({});
    expect(none.status).toBe(400);
    const wrong = await user.agent.post("/api/v1/auth/passkeys/register/options").set("X-CSRF-Token", user.csrf).send({ currentPassword: "not-my-password" });
    expect(wrong.status).toBe(401);
    const right = await user.agent.post("/api/v1/auth/passkeys/register/options").set("X-CSRF-Token", user.csrf).send({ currentPassword: PASSWORD });
    // The password step passed. What follows is the WebAuthn ceremony itself, which
    // needs an https origin or localhost; the test client is 127.0.0.1, so it may
    // answer with a relying-party error. What it must not say is anything about
    // the password.
    expect([200, 400]).toContain(right.status);
    expect(JSON.stringify(right.body)).not.toMatch(/password/i);
  });
});
