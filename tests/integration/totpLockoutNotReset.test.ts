/**
 * tests/integration/totpLockoutNotReset.test.ts
 *
 * F192 / business rule 108. The password step used to clear the per-account
 * failure counter the moment the password verified — before the second factor.
 * Anyone who knew the password could submit four wrong TOTP codes, repeat the
 * password to reset the count, and guess codes indefinitely. The counter now
 * survives the password step for an account that owes a second factor and is
 * cleared only by a completed login.
 *
 * One file on its own: the per-IP login limiter (10 requests / 15 min) is
 * process-wide and this sequence spends 9 of them.
 *
 * Skips cleanly when DATABASE_URL isn't reachable; see _helpers.ts.
 */

import { it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { Secret } from "otpauth";
import { app } from "../../src/app.js";
import { prisma } from "../../src/db.js";
import { hashPassword } from "../../src/utils/password.js";
import { sealValue } from "../../src/utils/secretBox.js";
import { clearLockout } from "../../src/utils/loginLockout.js";
import { dbDescribe, dbReachable } from "./_helpers.js";

const d = dbDescribe;

const USERNAME = "test-totp-lockout-user";
const PASSWORD = "Lockout-Test-Passw0rd-2026!";

beforeAll(async () => {
  if (!dbReachable) return;
  await prisma.$connect();
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  const role = await prisma.role.findFirst({ where: { name: "readonly" } });
  if (!role) throw new Error("built-in readonly role missing");
  const secret = new Secret({ size: 20 }).base32;
  await prisma.user.create({
    data: {
      username: USERNAME,
      passwordHash: await hashPassword(PASSWORD),
      roleId: role.id,
      authProvider: "local",
      totpSecret: sealValue(secret),
      totpEnabledAt: new Date(),
    },
  });
  clearLockout(USERNAME);
});

afterAll(async () => {
  if (!dbReachable) return;
  clearLockout(USERNAME);
  await prisma.event.deleteMany({ where: { resourceName: USERNAME } });
  await prisma.user.deleteMany({ where: { username: USERNAME } });
  await prisma.$disconnect();
});

async function passwordStep() {
  const res = await request(app).post("/api/v1/auth/login").send({ username: USERNAME, password: PASSWORD });
  return res;
}

const wrongCode = (pendingToken: string) =>
  request(app).post("/api/v1/auth/login/totp").send({ pendingToken, code: "000000" });

d("second-factor failures survive the password step", () => {
  it("locks the account after five wrong codes even when the password is re-entered between them", async () => {
    // pw, wrong, wrong, pw, wrong, wrong, pw, wrong  = five wrong codes in all.
    // If the password step reset the counter, the count would never pass two.
    const first = await passwordStep();
    expect(first.status).toBe(200);
    expect(first.body.mfaRequired).toBe(true);
    expect((await wrongCode(first.body.pendingToken)).status).toBe(401);
    expect((await wrongCode(first.body.pendingToken)).status).toBe(401);

    const second = await passwordStep();
    expect(second.status).toBe(200);
    expect((await wrongCode(second.body.pendingToken)).status).toBe(401);
    expect((await wrongCode(second.body.pendingToken)).status).toBe(401);

    const third = await passwordStep();
    expect(third.status).toBe(200);
    // The fifth wrong code trips the lockout.
    expect((await wrongCode(third.body.pendingToken)).status).toBe(401);

    // And now even the CORRECT password is refused: the account is locked.
    const afterLock = await passwordStep();
    expect(afterLock.status).toBe(423);
  });
});
