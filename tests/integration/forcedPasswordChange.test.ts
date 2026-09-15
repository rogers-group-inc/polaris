/**
 * tests/integration/forcedPasswordChange.test.ts
 *
 * "Require a change at next sign-in" (Users → Authentication → Settings →
 * Password Complexity), end to end over the real app.
 *
 * The property this file exists for is an ORDERING one, and it is the kind a
 * mocked Prisma would wave through: a password-change token is minted only
 * once EVERY factor on the account is satisfied. Mint it at the password step
 * instead and someone holding a stolen password could set a new one — and
 * collect the session — without ever facing the second factor. So the TOTP
 * case here is not a nice-to-have: it is the regression test for an MFA
 * bypass.
 *
 * The rest is the ordinary shape of the feature: a conforming password is
 * never interrupted, a non-conforming one gets no session until it is
 * replaced, the replacement is held to the live policy, and reusing the old
 * password is refused.
 *
 * Uses its own user — interrupting the shared tester's login would strand
 * every other suite in the run. Skips cleanly when DATABASE_URL isn't
 * reachable.
 */

import { it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { app, resetLoginRateLimit } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword, verifyPassword } from "../../src/utils/password.js";
import {
  savePasswordPolicy,
  invalidatePasswordPolicyCache,
} from "../../src/services/passwordPolicyService.js";
import { defaultPasswordPolicy } from "../../src/utils/passwordPolicy.js";
import { generateSecret } from "../../src/services/totpService.js";
import { TOTP, Secret } from "otpauth";
import { sealValue } from "../../src/utils/secretBox.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

const USERNAME = "polaris-forcedpw-tester";
// Meets the shipped defaults, and fails a 20-character minimum — which is how
// every "non-conforming" case below is produced without storing a bad password.
const ORIGINAL = "Original-Pass-1!";
const LONG_ENOUGH = "Replacement-Passphrase-2!";

let userId = "";

async function setPolicy(patch: Parameters<typeof savePasswordPolicy>[0]): Promise<void> {
  await savePasswordPolicy({ ...defaultPasswordPolicy(), ...patch });
  invalidatePasswordPolicyCache();
}

/**
 * The code an authenticator app would be showing right now. Built here with
 * the same RFC 6238 defaults totpService uses (SHA1 / 6 digits / 30s), since
 * the service exports a verifier but no generator — nothing in production
 * needs to produce a code.
 */
function currentCode(secret: string): string {
  return new TOTP({
    issuer: "Polaris",
    label: USERNAME,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
}

async function resetUserRow(): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(ORIGINAL),
      authProvider: "local",
      totpSecret: null,
      totpEnabledAt: null,
      totpBackupCodes: [],
    },
  });
}

beforeAll(async () => {
  if (!dbReachable) return;
  const role = await prisma.role.findUnique({ where: { name: "readonly" } });
  if (!role) throw new Error("built-in 'readonly' Role row missing — run `npx prisma migrate deploy` first");

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
});

afterAll(async () => {
  if (!dbReachable) return;
  await setPolicy({});
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await prisma.event.deleteMany({ where: { resourceName: USERNAME } });
});

beforeEach(async () => {
  if (!dbReachable) return;
  await resetUserRow();
  await setPolicy({});
  // Every case here is a COMPLETE login, and the budget is ten guesses per
  // quarter hour from one address — a ceiling no real client approaches and
  // this suite passes twice over. Clearing it is the only way to assert on the
  // flow rather than on a 429.
  resetLoginRateLimit();
});

d("the policy is off (the default)", () => {
  it("signs a non-conforming password straight in — an upgrade refuses nothing", async () => {
    // A 20-character minimum that ORIGINAL fails, but with the forced change
    // switched off: the bar applies to new passwords, not to this login.
    await setPolicy({ minLength: 20, forceChangeOnLogin: false });
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: USERNAME, password: ORIGINAL });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.passwordChangeRequired).toBeUndefined();
  });
});

d("the policy is on", () => {
  beforeEach(async () => {
    if (!dbReachable) return;
    await setPolicy({ minLength: 20, forceChangeOnLogin: true });
  });

  it("withholds the session and demands a new password", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: USERNAME, password: ORIGINAL });
    expect(res.status).toBe(200);
    expect(res.body.passwordChangeRequired).toBe(true);
    expect(res.body.pendingToken).toBeTruthy();
    // No session yet — that is the whole point of withholding it.
    expect(res.body.ok).toBeUndefined();
    // And the client is told what it has to satisfy.
    expect(res.body.policy.minLength).toBe(20);
  });

  it("does not interrupt a password that already conforms", async () => {
    await prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(LONG_ENOUGH) } });
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: USERNAME, password: LONG_ENOUGH });
    expect(res.body.ok).toBe(true);
    expect(res.body.passwordChangeRequired).toBeUndefined();
  });

  it("still refuses a WRONG password rather than offering it a change", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: USERNAME, password: "not-the-password" });
    expect(res.status).toBe(401);
    expect(res.body.pendingToken).toBeUndefined();
  });

  it("issues the session once a conforming password is set", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/v1/auth/login").send({ username: USERNAME, password: ORIGINAL });
    const res = await agent
      .post("/api/v1/auth/login/password-change")
      .send({ pendingToken: login.body.pendingToken, newPassword: LONG_ENOUGH });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    // The new password is really stored...
    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect((await verifyPassword(LONG_ENOUGH, row!.passwordHash)).valid).toBe(true);
    // ...and the session really exists.
    const me = await agent.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.username).toBe(USERNAME);
  });

  it("holds the replacement to the live policy", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ username: USERNAME, password: ORIGINAL });
    const res = await request(app)
      .post("/api/v1/auth/login/password-change")
      .send({ pendingToken: login.body.pendingToken, newPassword: "Still-Short-1!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/20 characters/);
  });

  it("refuses the password that triggered the demand in the first place", async () => {
    // Re-submitting it satisfies the letter of the demand and none of its
    // point. Under a stable policy the length rule catches this first (the old
    // password is by definition non-conforming); the route's explicit
    // same-as-old check is what covers the case where an admin relaxes the
    // policy during the five minutes the token is alive.
    const login = await request(app).post("/api/v1/auth/login").send({ username: USERNAME, password: ORIGINAL });
    const res = await request(app)
      .post("/api/v1/auth/login/password-change")
      .send({ pendingToken: login.body.pendingToken, newPassword: ORIGINAL });
    expect(res.status).toBe(400);
    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect((await verifyPassword(ORIGINAL, row!.passwordHash)).valid).toBe(true);
  });

  it("burns the token — it buys exactly one password change", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ username: USERNAME, password: ORIGINAL });
    const first = await request(app)
      .post("/api/v1/auth/login/password-change")
      .send({ pendingToken: login.body.pendingToken, newPassword: LONG_ENOUGH });
    expect(first.status).toBe(200);

    const replay = await request(app)
      .post("/api/v1/auth/login/password-change")
      .send({ pendingToken: login.body.pendingToken, newPassword: "Another-Long-Passphrase-3!" });
    expect(replay.status).toBe(401);
  });

  it("refuses a token nobody issued", async () => {
    const res = await request(app)
      .post("/api/v1/auth/login/password-change")
      .send({ pendingToken: "a".repeat(64), newPassword: LONG_ENOUGH });
    expect(res.status).toBe(401);
  });
});

d("with a second factor in front of it — the MFA-ordering invariant", () => {
  let secret = "";

  beforeEach(async () => {
    if (!dbReachable) return;
    secret = generateSecret();
    await prisma.user.update({
      where: { id: userId },
      data: { totpSecret: sealValue(secret), totpEnabledAt: new Date(), totpBackupCodes: [] },
    });
    await setPolicy({ minLength: 20, forceChangeOnLogin: true });
  });

  it("asks for the second factor FIRST, offering no password-change token", async () => {
    // If this ever returns passwordChangeRequired, a stolen password alone can
    // set a new one and take the session — the MFA bypass this ordering exists
    // to prevent.
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: USERNAME, password: ORIGINAL });
    expect(res.status).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.passwordChangeRequired).toBeUndefined();
    expect(res.body.methods).toEqual({ totp: true, passkey: false });
  });

  it("will not spend an MFA token at the password-change endpoint", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({ username: USERNAME, password: ORIGINAL });
    const res = await request(app)
      .post("/api/v1/auth/login/password-change")
      .send({ pendingToken: login.body.pendingToken, newPassword: LONG_ENOUGH });
    expect(res.status).toBe(401);
    // And the password is untouched.
    const row = await prisma.user.findUnique({ where: { id: userId } });
    expect((await verifyPassword(ORIGINAL, row!.passwordHash)).valid).toBe(true);
  });

  it("demands the change on the far side of the code, then issues the session", async () => {
    const agent = request.agent(app);
    const login = await agent.post("/api/v1/auth/login").send({ username: USERNAME, password: ORIGINAL });
    const totp = await agent
      .post("/api/v1/auth/login/totp")
      .send({ pendingToken: login.body.pendingToken, code: currentCode(secret) });
    expect(totp.status).toBe(200);
    expect(totp.body.passwordChangeRequired).toBe(true);
    expect(totp.body.ok).toBeUndefined();

    const done = await agent
      .post("/api/v1/auth/login/password-change")
      .send({ pendingToken: totp.body.pendingToken, newPassword: LONG_ENOUGH });
    expect(done.status).toBe(200);
    const me = await agent.get("/api/v1/auth/me");
    expect(me.body.username).toBe(USERNAME);
  });
});
