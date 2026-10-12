/**
 * tests/integration/totpReplay.test.ts
 *
 * F237 / business rule 108 (RFC 6238 section 5.2). verifyCode was stateless and
 * accepted the previous, current and next 30-second step, so a code that had just
 * logged someone in verified again for up to ~90 seconds. The step each code
 * belongs to is now recorded per user and a step at or below the last one used is
 * refused.
 *
 * Own file for the same reason as totpLockoutNotReset: the per-IP login limiter
 * is process-wide.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { TOTP, Secret } from "otpauth";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { sealValue } from "../../src/utils/secretBox.js";
import { clearLockout } from "../../src/utils/loginLockout.js";
import { claimTotpStep } from "../../src/services/totpStepService.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

const USERNAME = "test-totp-replay-user";
const PASSWORD = "Replay-Test-Passw0rd-2026!";
const SECRET = new Secret({ size: 20 }).base32;
const totp = new TOTP({ algorithm: "SHA1", digits: 6, period: 30, secret: Secret.fromBase32(SECRET) });

let userId = "";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  const role = await prisma.role.findFirst({ where: { name: "readonly" } });
  if (!role) throw new Error("built-in readonly role missing");
  userId = (
    await prisma.user.create({
      data: {
        username: USERNAME,
        passwordHash: await hashPassword(PASSWORD),
        roleId: role.id,
        authProvider: "local",
        totpSecret: sealValue(SECRET),
        totpEnabledAt: new Date(),
      },
    })
  ).id;
  clearLockout(USERNAME);
});

afterAll(async () => {
  if (!dbReachable) return;
  clearLockout(USERNAME);
  await prisma.event.deleteMany({ where: { resourceName: USERNAME } });
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await prisma.$disconnect();
});

const passwordStep = () => request(app).post("/api/v1/auth/login").send({ username: USERNAME, password: PASSWORD });
const submit = (pendingToken: string, code: string) =>
  request(app).post("/api/v1/auth/login/totp").send({ pendingToken, code });

d("a TOTP code is accepted once", () => {
  it("logs in with a fresh code and refuses the same code a second time", async () => {
    const code = totp.generate();

    const a = await passwordStep();
    expect(a.body.mfaRequired).toBe(true);
    const ok = await submit(a.body.pendingToken, code);
    expect(ok.status).toBe(200);

    // Same code, new pending token, well inside the +/-1 step window.
    const b = await passwordStep();
    const replay = await submit(b.body.pendingToken, code);
    expect(replay.status).toBe(401);
  });

  it("records the step on the account", async () => {
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { totpLastStep: true } });
    expect(typeof row?.totpLastStep).toBe("number");
    expect(row!.totpLastStep!).toBeGreaterThan(50_000_000);
  });
});

d("claimTotpStep", () => {
  it("accepts a later step, refuses the same or an earlier one, and is atomic", async () => {
    const base = (await prisma.user.findUnique({ where: { id: userId }, select: { totpLastStep: true } }))!.totpLastStep!;
    expect(await claimTotpStep(userId, base)).toBe(false);
    expect(await claimTotpStep(userId, base - 1)).toBe(false);
    expect(await claimTotpStep(userId, base + 1)).toBe(true);
    expect(await claimTotpStep(userId, base + 1)).toBe(false);

    // Two concurrent submissions of one step: exactly one wins.
    const results = await Promise.all([claimTotpStep(userId, base + 5), claimTotpStep(userId, base + 5)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
