/**
 * src/services/accountSelfService.ts — a signed-in user managing their OWN
 * account: changing a local password, enrolling / confirming / disabling TOTP,
 * reading TOTP state, and the passkey-registration password step-up.
 *
 * Extracted from src/api/routes/auth.ts on 2026-11-06 (CQ-B044): this owns the
 * User reads and writes and every check that decides the outcome; the route
 * keeps what is bound to the request — session rotation, revoking the other
 * sessions, `req.session.mfaVerified`, and the audit Events that carry
 * `req.ip`. Admin-side counterparts (reset another user's password / TOTP)
 * stay in routes/users.ts.
 *
 * `User.totpSecret` is a scalar column, outside the JSON-blob seal extension
 * in db.ts, so sealing is explicit here (enrol) and opened explicitly where a
 * code is verified (confirm, disable, and the login challenge in auth.ts).
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { hashPassword, verifyPassword } from "../utils/password.js";
import { isLocked, recordFailure } from "../utils/loginLockout.js";
import { sealValue, openValue } from "../utils/secretBox.js";
import {
  verifyCodeStep as verifyTotpCodeStep,
  consumeBackupCode,
  generateSecret as generateTotpSecret,
  generateBackupCodes,
  buildEnrollment,
} from "./totpService.js";
import { claimTotpStep } from "./totpStepService.js";
import { assertPasswordMeetsPolicy } from "./passwordPolicyService.js";
import { logEvent } from "./eventLogService.js";

/** The account identity the route's Events name. */
interface AccountRef { id: string; username: string }

/**
 * Business rule 61: a LOCAL user changes their own password, proving the
 * current one. Writes the new hash and returns the account; the route then
 * clears the lockout and pending MFA, revokes the other sessions and rotates
 * this one.
 */
export async function changeOwnPassword(userId: string, currentPassword: string, newPassword: string): Promise<AccountRef> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found");
  if (user.authProvider !== "local") {
    throw new AppError(400, "Your password is managed by your identity provider — change it there.");
  }
  const { valid } = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) throw new AppError(401, "Current password is incorrect.");
  if (currentPassword === newPassword) {
    throw new AppError(400, "The new password must be different from the current one.");
  }
  await assertPasswordMeetsPolicy(newPassword);
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });
  return { id: user.id, username: user.username };
}

/**
 * Start TOTP enrolment: a fresh secret (sealed at rest) and its QR. Starting
 * again discards a half-configured enrolment; an ENABLED setup must be
 * disabled first — a working setup is never silently replaced.
 */
export async function startTotpEnrollment(userId: string): Promise<{ secret: string; otpauthUri: string; qrSvg: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found");
  if (user.authProvider !== "local") {
    throw new AppError(400, "Two-factor auth is managed by your identity provider for SSO accounts.");
  }
  if (user.totpEnabledAt) {
    throw new AppError(409, "Two-factor auth is already enabled. Disable it before re-enrolling.");
  }
  const secret = generateTotpSecret();
  const { otpauthUri, qrSvg } = await buildEnrollment(secret, user.username);
  await prisma.user.update({ where: { id: userId }, data: { totpSecret: sealValue(secret), totpLastStep: null } });
  return { secret, otpauthUri, qrSvg };
}

/**
 * Finish enrolment with the first code from the authenticator. Enables TOTP,
 * stores hashed backup codes and records the confirming code's step so it
 * cannot be replayed at the next login. Returns the plaintext backup codes
 * (shown once).
 */
export async function confirmTotpEnrollment(userId: string, code: string): Promise<{ account: AccountRef; backupCodes: string[] }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.totpSecret) {
    throw new AppError(400, "No enrollment in progress — start by generating a QR code.");
  }
  if (user.totpEnabledAt) {
    throw new AppError(409, "Two-factor auth is already enabled.");
  }
  const confirmStep = verifyTotpCodeStep(openValue(user.totpSecret), code);
  if (confirmStep === null) {
    throw new AppError(401, "Invalid code. Try again with a fresh value from your authenticator app.");
  }
  const { plaintext, hashes } = await generateBackupCodes();
  await prisma.user.update({
    where: { id: userId },
    data: { totpEnabledAt: new Date(), totpBackupCodes: hashes, totpLastStep: confirmStep },
  });
  return { account: { id: user.id, username: user.username }, backupCodes: plaintext };
}

/**
 * Self-disable TOTP. Requires a current TOTP code (step-claimed, so it is
 * single-use) or a backup code, so a stolen session cannot silently drop MFA.
 */
export async function disableOwnTotp(userId: string, code: string, isBackupCode: boolean): Promise<AccountRef> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new AppError(404, "User not found");
  if (!user.totpEnabledAt || !user.totpSecret) {
    throw new AppError(400, "Two-factor auth is not currently enabled.");
  }
  let verified = false;
  if (isBackupCode) {
    const remaining = await consumeBackupCode(user.totpBackupCodes, code);
    verified = remaining !== null;
  } else {
    const step = verifyTotpCodeStep(openValue(user.totpSecret), code);
    verified = step !== null && (await claimTotpStep(user.id, step));
  }
  if (!verified) throw new AppError(401, "Invalid code.");
  await prisma.user.update({
    where: { id: userId },
    data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: [], totpLastStep: null },
  });
  return { id: user.id, username: user.username };
}

/** The current user's TOTP state. Never returns the secret or the codes. */
export async function getTotpStatus(userId: string): Promise<{
  authProvider: string;
  enabled: boolean;
  enrolling: boolean;
  backupCodesRemaining: number;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { authProvider: true, totpSecret: true, totpEnabledAt: true, totpBackupCodes: true },
  });
  if (!user) throw new AppError(404, "User not found");
  return {
    authProvider: user.authProvider,
    enabled: !!user.totpEnabledAt,
    enrolling: !!user.totpSecret && !user.totpEnabledAt,
    backupCodesRemaining: user.totpBackupCodes?.length ?? 0,
  };
}

/** The account's auth provider ("local" when the row is gone — the passkey list's fallback). */
export async function getOwnAuthProvider(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { authProvider: true } });
  return user?.authProvider ?? "local";
}

/** The fields a passkey registration ceremony names its user by. */
export interface PasskeyRegistrant {
  id: string;
  username: string;
  displayName: string | null;
  authProvider: string;
}

/**
 * Business rule 108 (scan F244): registering a passkey needs the CURRENT
 * PASSWORD. A wrong one counts against the same per-account lockout budget as
 * a wrong password at login and writes `auth.passkey.step_up_failed`, so a
 * held session cannot be used to grind the password.
 */
export async function verifyPasskeyStepUp(
  userId: string,
  currentPassword: string,
  ip: string | undefined,
): Promise<PasskeyRegistrant> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true, authProvider: true, passwordHash: true },
  });
  if (!user) throw new AppError(404, "User not found");
  if (isLocked(user.username).locked) {
    throw new AppError(423, "Account temporarily locked due to too many failed attempts.");
  }
  const { valid } = await verifyPassword(currentPassword, user.passwordHash);
  if (!valid) {
    recordFailure(user.username);
    await logEvent({
      action: "auth.passkey.step_up_failed",
      level: "warning",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `Wrong password while registering a passkey for ${user.username}`,
      details: { ip },
    });
    throw new AppError(401, "Current password is incorrect");
  }
  const { passwordHash: _unused, ...registrant } = user;
  return registrant;
}

/** The registrant for the ceremony's second leg (the step-up was paid on the first). */
export async function findPasskeyRegistrant(userId: string): Promise<PasskeyRegistrant> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, displayName: true, authProvider: true },
  });
  if (!user) throw new AppError(404, "User not found");
  return user;
}
