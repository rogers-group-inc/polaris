/**
 * src/api/routes/auth.ts — Login / Logout / Session check / Azure SAML SSO
 */

import { Router, type Request } from "express";
import { z } from "zod";
import { prisma } from "../../db.js";
import { hashPassword, verifyPassword, passwordPolicySchema } from "../../utils/password.js";
import { isLocked, lockoutRemaining, recordFailure, clearLockout } from "../../utils/loginLockout.js";
import * as mfaPending from "../../utils/mfaPending.js";
import {
  verifyCode as verifyTotpCode,
  consumeBackupCode,
  generateSecret as generateTotpSecret,
  generateBackupCodes,
  buildEnrollment,
} from "../../services/totpService.js";
// User.totpSecret is a scalar column, so it sits OUTSIDE the JSON-blob
// seal-on-write/open-on-read extension in db.ts — sealing is explicit at the
// four sites below. openValue passes an unsealed value straight through, which
// is what lets enrollments predating this change keep verifying while
// backfillSecretEncryption converts them.
import { sealValue, openValue } from "../../utils/secretBox.js";
import { AppError } from "../../utils/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission, snapshotFromRole } from "../middleware/permissions.js";
import {
  isAzureSsoConfiguredAsync,
  getSamlLoginUrl,
  validateSamlResponse,
  getSamlLogoutUrl,
  findOrProvisionSamlUser,
  getSsoSettings,
  updateSsoSettings,
} from "../../services/azureAuthService.js";
import {
  isLdapEnabled,
  authenticateLdapUser,
  findOrProvisionLdapUser,
  getLdapSettingsMasked,
  updateLdapSettings,
  testLdapConnection,
} from "../../services/ldapAuthService.js";
import {
  isOidcEnabled,
  buildAuthorizationUrl as buildOidcAuthorizationUrl,
  handleCallback as handleOidcCallback,
  findOrProvisionOidcUser,
  getOidcSettingsForUi,
  updateOidcSettings,
  testOidcConnection,
} from "../../services/oidcAuthService.js";
import {
  isEntraProxyEnabled,
  isEntraProxyLoginAvailable,
  isTrustedEntraProxySource,
  extractEntraProxyIdentity,
  findOrProvisionEntraProxyUser,
  getEntraProxySettings,
  updateEntraProxySettings,
  testEntraProxyRequest,
} from "../../services/entraProxyAuthService.js";
import {
  getPasskeySettings,
  savePasskeySettings,
  passkeySecondFactorEnabled,
  getPasskeyAvailability,
  userHasPasskey,
  listPasskeys,
  renamePasskey,
  deletePasskey,
  startRegistration as startPasskeyRegistration,
  finishRegistration as finishPasskeyRegistration,
  startLogin as startPasskeyLogin,
  startSecondFactor as startPasskeySecondFactor,
  finishAuthentication as finishPasskeyAuthentication,
  type PasskeySettings,
} from "../../services/passkeyService.js";
import {
  getPasswordPolicy,
  savePasswordPolicy,
  assertPasswordMeetsPolicy,
  passwordNeedsPolicyChange,
} from "../../services/passwordPolicyService.js";
import {
  describePasswordPolicy,
  PASSWORD_MIN_LENGTH_CEILING,
  PASSWORD_MIN_LENGTH_FLOOR,
  passwordRules,
  type PasswordPolicy,
} from "../../utils/passwordPolicy.js";
import { normalizeNotificationPreference } from "../../services/notificationPreferenceService.js";
import { normalizeUserTimezone, serverTimeZone } from "../../services/userTimezoneService.js";
import { resolveTagScopesForUser } from "../../services/regionScopeService.js";
import { isBlockedOutboundHost } from "../../utils/netGuard.js";
import { totpCodeLimiter, ssoEntryLimiter, entraProxyLoginLimiter, ssoCallbackLimiter, passwordChangeLimiter, passkeyCeremonyLimiter } from "../middleware/rateLimits.js";
import { safeNextPath } from "../../utils/safeRedirect.js";
import {
  takeLoginTarget,
  peekLoginTarget,
  generateRelayState,
  relayStateTarget,
} from "../../utils/loginRedirect.js";
import { logEvent } from "./events.js";

const router = Router();

// Rotate the session ID on login to prevent fixation: if an attacker planted
// a session ID on the client pre-auth, the post-auth identity binds to a new
// ID the attacker doesn't know.
function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Stamp the freshly-regenerated session with the logged-in identity — the
 * single home for the eight fields every login pathway must set (previously
 * copy-pasted across the LDAP / local / TOTP / SAML / OIDC / Entra-proxy
 * paths; adding a session field meant six coordinated edits).
 * `mfaVerified` is true for every SSO/directory provider (the IdP owns MFA)
 * and for the post-TOTP step; false only on the local password step of a
 * TOTP-enrolled account.
 */
function stampLoginSession(
  req: Request,
  user: { id: string; username: string; roleId: string; role: Parameters<typeof snapshotFromRole>[0] & { name: string } },
  authProvider: string,
  mfaVerified: boolean,
): void {
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.roleId = user.roleId;
  req.session.roleSnapshot = snapshotFromRole(user.role);
  req.session.role = user.role.name;
  req.session.authProvider = authProvider;
  req.session.mfaVerified = mfaVerified;
  req.session.lastActivity = Date.now();
}

const LoginSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

// POST /api/v1/auth/login
router.post("/login", async (req, res, next) => {
  try {
    const { username, password } = LoginSchema.parse(req.body);

    // Per-username lockout check — runs before the DB lookup so a locked
    // account short-circuits without the caller learning anything else.
    const lock = isLocked(username);
    if (lock.locked) {
      logEvent({
        action: "auth.login.locked",
        resourceType: "user",
        resourceName: username,
        level: "warning",
        message: `Login attempt on locked account "${username}"`,
        details: { ip: req.ip, lockedUntil: lock.until?.toISOString() },
      });
      throw new AppError(
        423,
        `Account temporarily locked due to too many failed attempts. Try again in ${lockoutRemaining(lock.until)}.`,
      );
    }

    const user = await prisma.user.findUnique({ where: { username }, include: { role: true } });

    // ── LDAP branch ──
    // Route to LDAP when the existing account is an LDAP user, OR when the
    // username is unknown and LDAP is enabled (just-in-time provisioning).
    // Local accounts (authProvider "local") fall through to the password path
    // below with all lockout/TOTP behavior intact. The shared per-username
    // lockout counter applies to LDAP attempts too (checked above).
    const useLdap = (user?.authProvider === "ldap") || (!user && (await isLdapEnabled()));
    if (useLdap) {
      try {
        const result = await authenticateLdapUser(username, password);
        clearLockout(username);
        const provisioned = await findOrProvisionLdapUser(result);

        await regenerateSession(req);
        // Directory owns MFA for LDAP users (TOTP self-enroll is SSO-blocked).
        stampLoginSession(req, provisioned, "ldap", true);

        logEvent({
          action: "auth.login.ldap",
          resourceType: "user",
          resourceId: provisioned.id,
          resourceName: provisioned.username,
          actor: provisioned.username,
          message: `LDAP login: ${provisioned.username} → role "${provisioned.role.name}"`,
          details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, groups: result.groups.length, role: provisioned.role.name },
        });
        return res.json({ ok: true, username: provisioned.username, role: provisioned.role.name });
      } catch (err) {
        const tripped = recordFailure(username);
        if (tripped.lockedNow) {
          logEvent({
            action: "auth.login.lockout",
            resourceType: "user",
            resourceName: username,
            level: "warning",
            message: `Account "${username}" locked after ${tripped.failures} failed attempts`,
            details: { ip: req.ip, lockedUntil: tripped.until?.toISOString() },
          });
        }
        logEvent({
          action: "auth.login.failed",
          resourceType: "user",
          resourceName: username,
          level: "warning",
          message: `Failed LDAP login for "${username}"`,
          details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, failures: tripped.failures },
        });
        throw new AppError(401, "Invalid username or password");
      }
    }

    // Constant-time verify: passing null stored hash still runs a dummy
    // argon2 verify so response time is identical for unknown usernames.
    const { valid, needsRehash } = await verifyPassword(password, user?.passwordHash ?? null);
    if (!user || !valid) {
      const tripped = recordFailure(username);
      if (tripped.lockedNow) {
        logEvent({
          action: "auth.login.lockout",
          resourceType: "user",
          resourceName: username,
          level: "warning",
          message: `Account "${username}" locked after ${tripped.failures} failed attempts`,
          details: { ip: req.ip, lockedUntil: tripped.until?.toISOString() },
        });
      }
      logEvent({
        action: "auth.login.failed",
        resourceType: "user",
        resourceName: username,
        level: "warning",
        message: `Failed local login for "${username}"`,
        details: {
          ip: req.ip,
          userAgent: req.get("user-agent") || undefined,
          failures: tripped.failures,
        },
      });
      throw new AppError(401, "Invalid username or password");
    }

    // Good password — clear the failure counter now; if TOTP fails later,
    // recordFailure() on the /login/totp path will start the counter fresh.
    clearLockout(username);

    // Re-hash on successful login if stored params are weaker than current target.
    // First-login flip: stamp needsRoleReview here (password step) for BOTH
    // TOTP-less and TOTP-enabled accounts. By the time the /login/totp step
    // runs, this update has already bumped lastLogin, so first-login can't
    // be detected there. A user who passes password but bails at TOTP still
    // gets flagged — that's fine; an admin reviewing them just sees an
    // account that has valid credentials but no completed-session activity.
    // Skip the stamp for admins — an admin reviewing their own role is
    // redundant noise (first-run wizard creates the seed admin this way).
    const isFirstLogin = user.lastLogin === null;
    const updateData: { lastLogin: Date; passwordHash?: string; needsRoleReview?: boolean } =
      { lastLogin: new Date() };
    if (needsRehash) {
      updateData.passwordHash = await hashPassword(password);
    }
    if (isFirstLogin && user.role.name !== "admin") updateData.needsRoleReview = true;
    await prisma.user.update({ where: { id: user.id }, data: updateData });

    // Does the password that just worked still meet the complexity policy?
    // This is the ONLY moment the question can be asked — a stored hash is
    // one-way — and the answer is carried across the second factor rather than
    // acted on here: handing out a password-change token before MFA would let a
    // stolen password set a new one and skip the second factor entirely.
    const mustChangePassword = user.authProvider === "local" && (await passwordNeedsPolicyChange(password));

    // Which second factors this local account can finish with. A passkey
    // counts only while the operator has passkeys configured as a second
    // factor ("second-factor" or "both"); under "login" a passkey is an
    // alternative to the password, not an addition to it, so a password login
    // stays single-step.
    const secondFactors = await resolveSecondFactors(user);

    // If a second factor is owed, don't issue the session yet — hand the
    // caller an opaque pending token instead and wait for the second step
    // (/login/totp or /login/passkey).
    if (secondFactors.totp || secondFactors.passkey) {
      const pendingToken = mfaPending.issue(user.id, user.username, {
        methods: secondFactors,
        mustChangePassword,
      });
      logEvent({
        action: "auth.login.password_ok",
        resourceType: "user",
        resourceId: user.id,
        resourceName: user.username,
        actor: user.username,
        message: `Password accepted for ${user.username}; awaiting second factor`,
        details: { ip: req.ip, methods: Object.entries(secondFactors).filter(([, on]) => on).map(([m]) => m) },
      });
      return res.json({ mfaRequired: true, pendingToken, methods: secondFactors });
    }

    if (mustChangePassword) {
      return res.json(await demandPasswordChange(req, user, "password"));
    }

    await regenerateSession(req);
    stampLoginSession(req, user, user.authProvider || "local", false);

    logEvent({
      action: "auth.login.local",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `Local login: ${user.username}`,
      details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, rehashed: needsRehash || undefined },
    });

    res.json({ ok: true, username: user.username, role: user.role.name });
  } catch (err) {
    next(err);
  }
});

/**
 * Which second factors stand between this account and a session.
 *
 * TOTP is a property of the account; a passkey is a property of the account
 * AND of the install's policy, so both are consulted. Non-local accounts have
 * neither — their identity provider owns MFA.
 */
async function resolveSecondFactors(user: { id: string; authProvider: string; totpEnabledAt: Date | null }): Promise<{
  totp: boolean;
  passkey: boolean;
}> {
  if (user.authProvider !== "local") return { totp: false, passkey: false };
  const settings = await getPasskeySettings();
  const passkey = passkeySecondFactorEnabled(settings) ? await userHasPasskey(user.id) : false;
  return { totp: Boolean(user.totpEnabledAt), passkey };
}

/**
 * Every factor passed, but the password fails the policy and the operator has
 * asked for those to be changed at login. Mint a single-use token that buys
 * one thing — setting a new password and collecting the withheld session — and
 * tell the client what the password has to satisfy.
 */
async function demandPasswordChange(
  req: Request,
  user: { id: string; username: string },
  via: string,
): Promise<{ passwordChangeRequired: true; pendingToken: string; policy: PasswordPolicy }> {
  const pendingToken = mfaPending.issue(user.id, user.username, { purpose: "password-change" });
  logEvent({
    action: "auth.login.password_change_required",
    resourceType: "user",
    resourceId: user.id,
    resourceName: user.username,
    actor: user.username,
    level: "warning",
    message: `${user.username} authenticated but must set a password meeting the current complexity policy`,
    details: { ip: req.ip, via },
  });
  return { passwordChangeRequired: true, pendingToken, policy: await getPasswordPolicy() };
}

const TotpLoginSchema = z.object({
  pendingToken: z.string().min(1),
  code:         z.string().min(1),
  isBackupCode: z.boolean().optional(),
});

// POST /api/v1/auth/login/totp — second-step of the two-phase login
router.post("/login/totp", async (req, res, next) => {
  try {
    const { pendingToken, code, isBackupCode } = TotpLoginSchema.parse(req.body);

    // Peek first so we can correctly attribute failures to the right user
    // without prematurely consuming a token that might still be valid.
    const pending = mfaPending.peek(pendingToken);
    if (!pending) {
      throw new AppError(401, "Session expired — please sign in again.");
    }

    // Apply the shared login lockout here too, so an attacker can't grind
    // codes after a stolen password without hitting the same 5-failure ceiling.
    const lock = isLocked(pending.username);
    if (lock.locked) {
      logEvent({
        action: "auth.login.locked",
        resourceType: "user",
        resourceId: pending.userId,
        resourceName: pending.username,
        level: "warning",
        message: `TOTP attempt on locked account "${pending.username}"`,
        details: { ip: req.ip, lockedUntil: lock.until?.toISOString() },
      });
      throw new AppError(
        423,
        `Account temporarily locked due to too many failed attempts. Try again in ${lockoutRemaining(lock.until)}.`,
      );
    }

    const user = await prisma.user.findUnique({ where: { id: pending.userId }, include: { role: true } });
    if (!user || !user.totpSecret || !user.totpEnabledAt) {
      // User or their TOTP config disappeared between steps — fail closed.
      mfaPending.consume(pendingToken);
      throw new AppError(401, "Session expired — please sign in again.");
    }

    let verified = false;
    let remainingBackupCodes: string[] | null = null;

    if (isBackupCode) {
      const remaining = await consumeBackupCode(user.totpBackupCodes, code);
      if (remaining !== null) {
        verified = true;
        remainingBackupCodes = remaining;
      }
    } else {
      verified = verifyTotpCode(openValue(user.totpSecret), code);
    }

    if (!verified) {
      const tripped = recordFailure(pending.username);
      logEvent({
        action: "auth.login.totp_failed",
        resourceType: "user",
        resourceId: user.id,
        resourceName: user.username,
        level: "warning",
        message: `Failed ${isBackupCode ? "backup-code" : "TOTP"} attempt for ${user.username}`,
        details: { ip: req.ip, failures: tripped.failures },
      });
      if (tripped.lockedNow) {
        // Drop the pending token so they can't keep trying to grind codes
        // against the same password-verified state after the lockout expires.
        mfaPending.consume(pendingToken);
      }
      throw new AppError(401, "Invalid verification code");
    }

    // Success: consume the pending token, persist any backup-code removal,
    // issue the real session, clear failure counter.
    mfaPending.consume(pendingToken);
    clearLockout(pending.username);

    const postVerifyData: { lastLogin: Date; totpBackupCodes?: string[] } = { lastLogin: new Date() };
    if (remainingBackupCodes) postVerifyData.totpBackupCodes = remainingBackupCodes;
    await prisma.user.update({ where: { id: user.id }, data: postVerifyData });

    // Both factors are satisfied — only now may a forced password change be
    // offered. The flag rode here on the pending token from the password step.
    if (pending.mustChangePassword) {
      return res.json(await demandPasswordChange(req, user, "totp"));
    }

    await regenerateSession(req);
    stampLoginSession(req, user, user.authProvider || "local", true);

    logEvent({
      action: "auth.login.local",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `Local login (with TOTP): ${user.username}`,
      details: {
        ip: req.ip,
        userAgent: req.get("user-agent") || undefined,
        method: isBackupCode ? "backup_code" : "totp",
        backupCodesRemaining: remainingBackupCodes ? remainingBackupCodes.length : undefined,
      },
    });

    res.json({ ok: true, username: user.username, role: user.role });
  } catch (err) {
    next(err);
  }
});

// ─── Passkey login ──────────────────────────────────────────────────────────
// Business rule 64.
//
// Three entry points, all of them local-account only:
//
//   /passkeys/config          unauthenticated. Tells the login page whether to
//                             draw the button at all, and why not when not.
//   /passkeys/login/options   unauthenticated. Issues a challenge for ANY
//                             discoverable credential on this RP — no username,
//                             so nothing here can be used to probe for accounts.
//   /passkeys/login           unauthenticated. Verifies the assertion and, on
//                             success, issues the session outright.
//
// The second-factor pair (/login/passkey/options + /login/passkey) sits below
// them and is NOT unauthenticated: it takes the pending token minted by the
// password step, exactly as /login/totp does.
//
// The source-IP login gate in app.ts covers all of these — they are local
// credentials by another name (see LOGIN_CREDENTIAL_PATHS there).

// GET /api/v1/auth/passkeys/config
router.get("/passkeys/config", async (req, res, next) => {
  try {
    res.json(await getPasskeyAvailability(req));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/passkeys/login/options
router.post("/passkeys/login/options", passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    res.json(await startPasskeyLogin(req));
  } catch (err) {
    next(err);
  }
});

const PasskeyAssertionSchema = z.object({
  token: z.string().min(1),
  // The assertion is handed to the library, which validates its shape far more
  // thoroughly than a Zod mirror could — and a mirror that drifted from the
  // WebAuthn spec would reject valid authenticators. Bounded, not described.
  response: z.object({}).passthrough(),
});

// POST /api/v1/auth/passkeys/login — passwordless sign-in
router.post("/passkeys/login", passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    const { token, response } = PasskeyAssertionSchema.parse(req.body);
    const settings = await getPasskeySettings();
    if (settings.mode !== "login" && settings.mode !== "both") {
      throw new AppError(400, "Passkeys are not enabled for sign-in on this install.");
    }

    let auth;
    try {
      auth = await finishPasskeyAuthentication({ token, response: response as never, purpose: "login" });
    } catch (err) {
      logEvent({
        action: "auth.login.passkey_failed",
        resourceType: "user",
        level: "warning",
        message: "Failed passkey sign-in",
        details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, reason: (err as Error).message },
      });
      throw err;
    }

    const user = await prisma.user.findUnique({ where: { id: auth.userId }, include: { role: true } });
    if (!user) throw new AppError(401, "That passkey was not recognized.");

    // A passkey assertion is not guessable, so it is the one credential that
    // can safely clear a lockout rather than be refused by it: whoever holds
    // the authenticator is the account owner, and refusing them would hand an
    // attacker a denial-of-service through failed password attempts alone.
    clearLockout(user.username);

    const isFirstLogin = user.lastLogin === null;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        lastLogin: new Date(),
        ...(isFirstLogin && user.role.name !== "admin" ? { needsRoleReview: true } : {}),
      },
    });

    await regenerateSession(req);
    // mfaVerified: a passkey ceremony with user verification is two factors in
    // one gesture — see the note in passkeyService. When the operator has
    // turned UV off it is one, and the claim would be false; the TOTP step is
    // skipped either way (the credential is still a possession factor the
    // password path cannot reach), so the honest thing is to mirror the
    // setting rather than assert verification that did not happen.
    stampLoginSession(req, user, "local", (await getPasskeySettings()).requireUserVerification);

    logEvent({
      action: "auth.login.passkey",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `Passkey login: ${user.username} (${auth.passkeyName})`,
      details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, passkey: auth.passkeyName },
    });
    res.json({ ok: true, username: user.username, role: user.role.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/login/passkey/options — second-factor step
router.post("/login/passkey/options", passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    const { pendingToken } = z.object({ pendingToken: z.string().min(1) }).parse(req.body);
    const pending = mfaPending.peek(pendingToken);
    if (!pending) throw new AppError(401, "Session expired — please sign in again.");
    if (!pending.methods.passkey) throw new AppError(400, "This account cannot use a passkey as its second factor.");
    res.json(await startPasskeySecondFactor(req, pending.userId));
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/login/passkey — second-factor verify
router.post("/login/passkey", passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    const { pendingToken, token, response } = PasskeyAssertionSchema.extend({
      pendingToken: z.string().min(1),
    }).parse(req.body);

    const pending = mfaPending.peek(pendingToken);
    if (!pending) throw new AppError(401, "Session expired — please sign in again.");
    if (!pending.methods.passkey) throw new AppError(400, "This account cannot use a passkey as its second factor.");

    const lock = isLocked(pending.username);
    if (lock.locked) {
      throw new AppError(
        423,
        `Account temporarily locked due to too many failed attempts. Try again in ${lockoutRemaining(lock.until)}.`,
      );
    }

    // expectUserId binds the assertion to the account that passed the
    // password: without it, anyone holding ANY passkey on this install could
    // finish somebody else's half-completed login.
    await finishPasskeyAuthentication({
      token,
      response: response as never,
      purpose: "mfa",
      expectUserId: pending.userId,
    });

    const user = await prisma.user.findUnique({ where: { id: pending.userId }, include: { role: true } });
    if (!user) {
      mfaPending.consume(pendingToken);
      throw new AppError(401, "Session expired — please sign in again.");
    }

    mfaPending.consume(pendingToken);
    clearLockout(pending.username);
    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });

    if (pending.mustChangePassword) {
      return res.json(await demandPasswordChange(req, user, "passkey"));
    }

    await regenerateSession(req);
    stampLoginSession(req, user, user.authProvider || "local", true);

    logEvent({
      action: "auth.login.local",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `Local login (with passkey): ${user.username}`,
      details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, method: "passkey" },
    });
    res.json({ ok: true, username: user.username, role: user.role.name });
  } catch (err) {
    next(err);
  }
});

// ─── Forced password change at login ────────────────────────────────────────
// Business rule 63.
//
// Reached only with a "password-change" pending token, which is minted only
// after EVERY factor on the account has been satisfied (see demandPasswordChange
// and the note in utils/mfaPending.ts). It is the last step of a login, not a
// self-service route: there is no session yet, and the response either carries
// one or carries nothing.

const ForcedPasswordChangeSchema = z.object({
  pendingToken: z.string().min(1),
  newPassword: passwordPolicySchema,
});

// POST /api/v1/auth/login/password-change
router.post("/login/password-change", passwordChangeLimiter, async (req, res, next) => {
  try {
    const { pendingToken, newPassword } = ForcedPasswordChangeSchema.parse(req.body);
    const pending = mfaPending.peek(pendingToken, "password-change");
    if (!pending) throw new AppError(401, "Session expired — please sign in again.");

    const user = await prisma.user.findUnique({ where: { id: pending.userId }, include: { role: true } });
    if (!user || user.authProvider !== "local") {
      mfaPending.consume(pendingToken, "password-change");
      throw new AppError(401, "Session expired — please sign in again.");
    }

    await assertPasswordMeetsPolicy(newPassword);
    // Belt and braces. Under a stable policy the assertion above already
    // catches this — the old password is non-conforming by definition, or
    // there would have been no demand — but the policy can be relaxed during
    // the five minutes this token lives, and re-submitting the password that
    // triggered the demand satisfies its letter and none of its point. No
    // plaintext to compare against, so compare against the stored hash.
    const { valid: sameAsOld } = await verifyPassword(newPassword, user.passwordHash);
    if (sameAsOld) throw new AppError(400, "The new password must be different from your current one.");

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    // Consume only after the write lands: a failed update must leave the user
    // holding a token they can retry with, not stranded at a login screen.
    mfaPending.consume(pendingToken, "password-change");
    clearLockout(user.username);

    await regenerateSession(req);
    stampLoginSession(req, user, "local", true);

    logEvent({
      action: "user.password_changed",
      level: "warning",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `${user.username} set a new password to satisfy the complexity policy at login`,
      details: { ip: req.ip, forced: true },
    });
    res.json({ ok: true, username: user.username, role: user.role.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/logout
router.post("/logout", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  });
});

// GET /api/v1/auth/me — returns the caller's identity + the full role
// snapshot (id, name, isProtected, permissions matrix) plus the effective
// region tag set (union of role.regionTags and user.regionTags). The
// frontend uses the snapshot to gate menu items / buttons without per-call
// API checks. Returns 200 + `authenticated: false` for unauthenticated
// callers — never 401 — so the login page can probe state.
router.get("/me", async (req, res, next) => {
  try {
    if (!req.session?.userId) {
      return res.json({ authenticated: false });
    }
    const snapshot = req.session.roleSnapshot ?? null;
    // Load the user's own regionTags (and re-load role.regionTags from DB
    // so a recent role edit is reflected without waiting for the snapshot
    // version-cache refresh path). One indexed PK lookup per /auth/me
    // call — same cost as the legacy implementation.
    const u = await prisma.user.findUnique({
      where: { id: req.session.userId },
      include: { role: true },
    });
    if (!u) {
      // User row deleted out from under the session — fall back to a
      // best-effort response so the frontend can re-login cleanly.
      return res.json({ authenticated: false });
    }
    // Effective region/other tag scope — union(role, user, group). Group
    // tags are re-resolved live from the user's last-seen SSO groups, so a
    // GroupMapping edit takes effect on next page load without re-login.
    // Shared with the notifications region-scope filter via regionScopeService.
    const tagScopes = await resolveTagScopesForUser(u);

    res.json({
      authenticated: true,
      username: req.session.username,
      authProvider: req.session.authProvider || "local",
      // Spread the snapshot (or DB fallback) then always attach the live
      // role color from `u.role` — the session snapshot predates the color
      // column, so reading it from the freshly-loaded role row avoids a
      // re-login requirement for the sidebar badge to pick up a color edit.
      role: {
        ...(snapshot ?? {
          id: u.role.id,
          name: u.role.name,
          isProtected: u.role.isProtected,
          permissions: u.role.permissions ?? {},
          updatedAt: u.role.updatedAt.toISOString(),
        }),
        color: u.role.color ?? null,
      },
      regionTags: tagScopes.regionTags,
      otherTags: tagScopes.otherTags,
      // Rides /auth/me so every client can reconcile this browser's push
      // enrollment to the account's choice on the same boot request it already
      // makes, instead of a second round trip before it can decide.
      notificationPreference: normalizeNotificationPreference(u.notificationPreference),
      // Rides /auth/me for the same reason: every absolute time the UI draws
      // needs the zone before the first render, and a second round trip would
      // mean the first paint used the browser zone and then jumped.
      // "auto" is passed through AS "auto" rather than resolved here — on the
      // client that means "pass no timeZone option and let the browser use its
      // own", which is not the same answer as the server's zone.
      timezone: normalizeUserTimezone(u.timezone),
      // What "auto" will mean in an EMAIL, so the account menu can say so
      // instead of leaving the operator to guess how a server-side render
      // resolves it.
      serverTimezone: serverTimeZone(),
      // What the server currently believes this account's BROWSER zone is.
      // Echoed back so the client can compare before POSTing /me/timezone
      // /detected — this endpoint is hit on every page load, and without the
      // echo every one of those loads would be a write.
      detectedTimezone: u.detectedTimezone ?? null,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Azure SAML SSO ──────────────────────────────────────────────────────────

// GET /api/v1/auth/azure/config — public, login page checks this
router.get("/azure/config", async (_req, res) => {
  const settings = await getSsoSettings();
  const enabled = !!(settings.enabled && settings.idpEntityId && settings.idpLoginUrl && settings.idpCertificate);
  let brand = "generic";
  if (settings.idpLoginUrl && /microsoftonline\.com|login\.microsoft\.com/i.test(settings.idpLoginUrl)) {
    brand = "microsoft";
  } else if (settings.idpLoginUrl && /accounts\.google\.com/i.test(settings.idpLoginUrl)) {
    brand = "google";
  } else if (settings.idpLoginUrl && /okta\.com/i.test(settings.idpLoginUrl)) {
    brand = "okta";
  }
  res.json({
    enabled,
    brand,
    skipLoginPage: settings.skipLoginPage,
    autoLogoutMinutes: settings.autoLogoutMinutes,
  });
});

// GET /api/v1/auth/azure/login — redirects to IdP SAML login
// ssoEntryLimiter, NOT the login limiter: this redirect guesses at nothing, and
// SSO entry must keep working from anywhere even when the password surface is
// exhausted or restricted. Mirrors /oidc/login exactly.
router.get("/azure/login", ssoEntryLimiter, async (req, res) => {
  const configured = await isAzureSsoConfiguredAsync();
  if (!configured) {
    return res.redirect("/login.html?error=azure_not_configured");
  }
  try {
    // Fold the remembered destination into the RelayState, because the cookie
    // holding it will not survive the IdP's cross-site POST back to us. PEEK,
    // never consume: this request is the outbound half of a flow that can
    // fail, and the browser-side flows still read the cookie if the operator
    // ends up back on the login form.
    const relayState = generateRelayState(peekLoginTarget(req));
    req.session.samlRelayState = relayState;
    const url = await getSamlLoginUrl(relayState);
    res.redirect(url);
  } catch (err: any) {
    res.redirect(`/login.html?error=${encodeURIComponent(err.message || "sso_error")}`);
  }
});

// POST /api/v1/auth/azure/callback — handles SAML Response from IdP
router.post("/azure/callback", ssoCallbackLimiter, async (req, res) => {
  try {
    // Validate relay state when available (SameSite=Lax cookies are not
    // sent on cross-site POST, so the session may be empty here — the
    // signed SAML response provides the primary authentication guarantee)
    const returnedState = req.body.RelayState || "";
    if (req.session.samlRelayState && returnedState !== req.session.samlRelayState) {
      return res.redirect("/login.html?error=invalid_state");
    }

    const profile = await validateSamlResponse(req.body);
    const user = await findOrProvisionSamlUser(profile);

    // Regenerate after the relay-state check above has consumed the pre-auth
    // session; the new session drops the old ID (and samlRelayState with it).
    await regenerateSession(req);
    // IdP is responsible for MFA on Azure SAML users; their session is
    // implicitly "mfa-verified" as far as Polaris is concerned.
    stampLoginSession(req, user, "azure", true);
    req.session.samlNameID = profile.nameID;
    req.session.samlSessionIndex = profile.sessionIndex;

    logEvent({
      action: "auth.login.azure",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `SAML SSO login: ${user.username} (${user.email || "no email"})`,
    });

    // Back to whatever protected page bounced them here (an emailed
    // Acknowledge link, most often), else the dashboard. NOT from the session:
    // regenerateSession() above deliberately drops everything the pre-login
    // session held. RelayState first and the cookie second, because this
    // request is a CROSS-SITE POST from the IdP and a SameSite=Lax cookie is
    // not sent on one — the same reason the relay-state check above has to
    // tolerate an empty session. `relayStateTarget` re-sanitizes the path it
    // returns; the cookie is consumed either way, so a target this flow could
    // not honor never ambushes the next sign-in.
    const carried = relayStateTarget(returnedState);
    const remembered = takeLoginTarget(req, res);
    res.redirect(carried ?? remembered);
  } catch (err: any) {
    logEvent({
      action: "auth.login.azure.failed",
      resourceType: "user",
      level: "error",
      message: `SAML SSO callback failed: ${err.message}`,
    });
    res.redirect(`/login.html?error=${encodeURIComponent(err.message || "sso_callback_error")}`);
  }
});

// POST /api/v1/auth/azure/logout — SAML single logout
router.post("/azure/logout", requireAuth, async (req, res) => {
  try {
    const nameID = req.session.samlNameID;
    const sessionIndex = req.session.samlSessionIndex;

    if (nameID && sessionIndex && await isAzureSsoConfiguredAsync()) {
      const relayState = generateRelayState();
      const logoutUrl = await getSamlLogoutUrl(nameID, sessionIndex, relayState);
      req.session.destroy(() => {});
      res.clearCookie("connect.sid");
      return res.json({ ok: true, logoutUrl });
    }

    // No SAML session — just destroy local session
    req.session.destroy(() => {});
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  } catch (err: any) {
    req.session.destroy(() => {});
    res.clearCookie("connect.sid");
    res.json({ ok: true });
  }
});

// POST /api/v1/auth/azure/test — validate SAML config (admin only)
router.post("/azure/test", requireAuth, requirePermission("serverSettingsSystem", "write"), async (_req, res, next) => {
  try {
    const settings = await getSsoSettings();
    const results: { certificate: any; idpLoginUrl: any } = {
      certificate: { ok: false, message: "No certificate provided" },
      idpLoginUrl: { ok: false, message: "No IdP Login URL provided" },
    };

    // ── Validate certificate ──
    if (settings.idpCertificate) {
      try {
        const crypto = await import("node:crypto");
        // Wrap bare base64 in PEM headers if needed
        let pem = settings.idpCertificate.trim();
        if (!pem.startsWith("-----BEGIN")) {
          pem = `-----BEGIN CERTIFICATE-----\n${pem}\n-----END CERTIFICATE-----`;
        }
        const cert = new crypto.X509Certificate(pem);
        const now = new Date();
        const validFrom = new Date(cert.validFrom);
        const validTo = new Date(cert.validTo);
        const expired = now > validTo;
        const notYetValid = now < validFrom;
        const daysLeft = Math.floor((validTo.getTime() - now.getTime()) / 86400000);

        results.certificate = {
          ok: !expired && !notYetValid,
          subject: cert.subject,
          issuer: cert.issuer,
          validFrom: cert.validFrom,
          validTo: cert.validTo,
          expired,
          daysLeft,
          message: expired
            ? `Certificate expired on ${cert.validTo}`
            : notYetValid
            ? `Certificate not valid until ${cert.validFrom}`
            : `Valid — expires in ${daysLeft} days (${cert.validTo})`,
        };
      } catch (certErr: any) {
        results.certificate = {
          ok: false,
          message: `Invalid certificate: ${certErr.message}`,
        };
      }
    }

    // ── Check IdP Login URL reachability ──
    if (settings.idpLoginUrl) {
      try {
        // SSRF guard: the URL is operator-supplied — only probe plain
        // http(s) targets outside the blocked ranges (loopback, link-local
        // metadata, multicast). Same policy as integration hosts (netGuard).
        const idpUrl = new URL(settings.idpLoginUrl);
        if (idpUrl.protocol !== "https:" && idpUrl.protocol !== "http:") {
          throw new Error(`Unsupported URL scheme "${idpUrl.protocol}" — must be http(s)`);
        }
        if (isBlockedOutboundHost(idpUrl.hostname)) {
          throw new Error(`Host "${idpUrl.hostname}" is in a blocked range (loopback / link-local / multicast)`);
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(idpUrl, {
          method: "HEAD",
          signal: controller.signal,
          redirect: "manual",
        });
        clearTimeout(timeout);
        // 200, 302, 405 are all fine — means the IdP endpoint is alive
        results.idpLoginUrl = {
          ok: true,
          status: resp.status,
          message: `Reachable (HTTP ${resp.status})`,
        };
      } catch (urlErr: any) {
        const msg = urlErr.name === "AbortError"
          ? "Connection timed out (8s)"
          : urlErr.cause?.code === "ENOTFOUND"
          ? `Host not found — ${new URL(settings.idpLoginUrl).hostname}`
          : urlErr.message || "Connection failed";
        results.idpLoginUrl = { ok: false, message: msg };
      }
    }

    const allOk = results.certificate.ok && results.idpLoginUrl.ok;
    res.json({ ok: allOk, results });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/azure/settings — admin only
router.get("/azure/settings", requireAuth, requirePermission("serverSettingsSystem", "write"), async (_req, res, next) => {
  try {
    const settings = await getSsoSettings();
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/auth/azure/settings — admin only
router.put("/azure/settings", requireAuth, requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    // Lockout guard for "Skip login page". Hiding the local login page means
    // every unauthenticated visitor is bounced straight to SSO — if SSO isn't
    // actually working, nobody (including the admin who flipped it) can get
    // back in. So turning it ON requires BOTH:
    //   (a) a SAML or OIDC provider is configured, AND
    //   (b) the admin enabling it is themselves signed in via SSO — which is
    //       end-to-end proof that the SSO round-trip succeeds for at least one
    //       account before the password page disappears.
    // Turning it OFF is always allowed (recovery path), so only gate the rising
    // edge.
    const current = await getSsoSettings();
    const enablingSkip = req.body?.skipLoginPage === true && !current.skipLoginPage;
    if (enablingSkip) {
      const provider = req.session.authProvider;
      if (provider !== "azure" && provider !== "oidc") {
        throw new AppError(
          400,
          "Enable “Skip login page” only while signed in through SSO (SAML or OIDC). " +
            "This proves SSO works end-to-end before the login page is hidden, preventing lockout.",
        );
      }
      const ssoConfigured = (await isAzureSsoConfiguredAsync()) || (await isOidcEnabled());
      if (!ssoConfigured) {
        throw new AppError(400, "Configure and enable a SAML or OIDC provider before enabling “Skip login page”.");
      }
    }
    const settings = await updateSsoSettings(req.body);
    res.json(settings);
  } catch (err) {
    next(err);
  }
});

// ─── OIDC (OpenID Connect) SSO ────────────────────────────────────────────────

// GET /api/v1/auth/oidc/config — public, login page checks this
router.get("/oidc/config", async (_req, res) => {
  const enabled = await isOidcEnabled();
  res.json({ enabled });
});

// GET /api/v1/auth/oidc/login — redirect to the IdP authorization endpoint.
// state / nonce / PKCE verifier are stashed in the session for the callback.
router.get("/oidc/login", ssoEntryLimiter, async (req, res) => {
  try {
    if (!(await isOidcEnabled())) return res.redirect("/login.html?error=oidc_not_configured");
    const { url, state, nonce, codeVerifier } = await buildOidcAuthorizationUrl();
    req.session.oidcState = state;
    req.session.oidcNonce = nonce;
    req.session.oidcCodeVerifier = codeVerifier;
    req.session.save((err) => {
      if (err) return res.redirect(`/login.html?error=${encodeURIComponent("oidc_session_error")}`);
      res.redirect(url);
    });
  } catch (err: any) {
    res.redirect(`/login.html?error=${encodeURIComponent(err.message || "oidc_error")}`);
  }
});

// GET /api/v1/auth/oidc/callback — exchange code, validate ID token, provision.
// SameSite=Lax cookies ARE sent on this top-level GET navigation (unlike the
// SAML cross-site POST), so the session-stored checks are reliably present.
router.get("/oidc/callback", ssoCallbackLimiter, async (req, res) => {
  const state = req.session.oidcState;
  const nonce = req.session.oidcNonce;
  const codeVerifier = req.session.oidcCodeVerifier;
  try {
    if (!state || !nonce || !codeVerifier) {
      return res.redirect("/login.html?error=oidc_no_session");
    }
    const proto = req.protocol;
    const currentUrl = `${proto}://${req.get("host")}${req.originalUrl}`;
    const claims = await handleOidcCallback(currentUrl, { state, nonce, codeVerifier });
    const user = await findOrProvisionOidcUser(claims);

    await regenerateSession(req);
    stampLoginSession(req, user, "oidc", true); // IdP owns MFA

    logEvent({
      action: "auth.login.oidc",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `OIDC SSO login: ${user.username} → role "${user.role.name}"`,
      details: { groups: claims.groups.length, role: user.role.name },
    });
    res.redirect(takeLoginTarget(req, res));
  } catch (err: any) {
    logEvent({
      action: "auth.login.oidc.failed",
      resourceType: "user",
      level: "error",
      message: `OIDC callback failed: ${err.message}`,
    });
    res.redirect(`/login.html?error=${encodeURIComponent(err.message || "oidc_callback_error")}`);
  }
});

// GET /api/v1/auth/oidc/settings — admin only (secret masked, redirect URI derived)
router.get("/oidc/settings", requireAuth, requirePermission("serverSettingsSystem", "write"), async (_req, res, next) => {
  try {
    res.json(await getOidcSettingsForUi());
  } catch (err) { next(err); }
});

// PUT /api/v1/auth/oidc/settings — admin only
router.put("/oidc/settings", requireAuth, requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    await updateOidcSettings(req.body);
    res.json(await getOidcSettingsForUi());
  } catch (err) { next(err); }
});

// POST /api/v1/auth/oidc/test — run discovery + report endpoints (admin only)
router.post("/oidc/test", requireAuth, requirePermission("serverSettingsSystem", "write"), async (_req, res, next) => {
  try {
    res.json(await testOidcConnection());
  } catch (err) { next(err); }
});

// ─── LDAP Settings ──────────────────────────────────────────────────────────

router.get("/ldap/settings", requireAuth, requirePermission("serverSettingsSystem", "write"), async (_req, res, next) => {
  try {
    res.json(await getLdapSettingsMasked());
  } catch (err) { next(err); }
});

router.put("/ldap/settings", requireAuth, requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    await updateLdapSettings(req.body);
    res.json(await getLdapSettingsMasked());
  } catch (err) { next(err); }
});

// POST /api/v1/auth/ldap/test — service-account bind + base DN check (admin only)
router.post("/ldap/test", requireAuth, requirePermission("serverSettingsSystem", "write"), async (_req, res, next) => {
  try {
    res.json(await testLdapConnection());
  } catch (err) { next(err); }
});

// ─── Entra App Proxy (header SSO) ────────────────────────────────────────────
// Users pre-authenticated by Entra ID arrive through the App Proxy connector
// carrying unsigned identity headers. Trust is source-IP only (see
// entraProxyAuthService.ts); the strip middleware in app.ts removes the
// headers from untrusted requests, and /entra-proxy/login re-validates trust
// itself. All failures redirect to /login.html (never a protected page) so
// the app.ts auto-login redirect can't loop.

const EntraProxySettingsSchema = z.object({
  enabled: z.boolean(),
  trustedSourceIps: z.array(z.string().max(64)).max(64),
  objectIdHeader: z.string().max(64),
  usernameHeader: z.string().max(64),
  emailHeader: z.string().max(64),
  displayNameHeader: z.string().max(64),
  groupsHeader: z.string().max(64),
});

// GET /api/v1/auth/entra-proxy/config — public, login page checks this.
// `available` = THIS request could complete a header login (trusted source +
// identity header present). Booleans only — never header values.
router.get("/entra-proxy/config", ssoCallbackLimiter, async (req, res) => {
  const enabled = await isEntraProxyEnabled().catch(() => false);
  const available = enabled && (await isEntraProxyLoginAvailable(req).catch(() => false));
  res.json({ enabled, available });
});

// GET /api/v1/auth/entra-proxy/login — read the identity headers on THIS
// request, validate trust, provision, stamp the session. Both the login-page
// button and the app.ts silent auto-login land here.
router.get("/entra-proxy/login", entraProxyLoginLimiter, async (req, res) => {
  // The explicit ?next= wins (app.ts's silent auto-login sets it), but the
  // cookie is consumed either way — a target left behind here would otherwise
  // ambush the operator's next sign-in.
  const remembered = takeLoginTarget(req, res);
  const next = req.query.next ? safeNextPath(req.query.next) : remembered;
  try {
    if (!(await isEntraProxyEnabled())) {
      return res.redirect("/login.html?error=entra_proxy_not_configured");
    }
    if (!(await isTrustedEntraProxySource(req.ip))) {
      logEvent({
        action: "auth.login.entra_proxy.untrusted",
        resourceType: "user",
        level: "warning",
        message: `Entra App Proxy login refused: source ${req.ip || "unknown"} is not an allowlisted connector`,
        details: { ip: req.ip },
      });
      return res.redirect("/login.html?error=entra_proxy_untrusted_source");
    }
    const identity = await extractEntraProxyIdentity(req);
    if (!identity) {
      return res.redirect("/login.html?error=entra_proxy_missing_headers");
    }
    const user = await findOrProvisionEntraProxyUser(identity);

    await regenerateSession(req);
    stampLoginSession(req, user, "entra-proxy", true); // Entra pre-auth owns MFA

    logEvent({
      action: "auth.login.entra_proxy",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `Entra App Proxy SSO login: ${user.username} → role "${user.role.name}"`,
      details: { ip: req.ip, groups: identity.groups.length, role: user.role.name },
    });
    res.redirect(next);
  } catch (err: any) {
    logEvent({
      action: "auth.login.entra_proxy.failed",
      resourceType: "user",
      level: "error",
      message: `Entra App Proxy login failed: ${err.message}`,
      details: { ip: req.ip },
    });
    res.redirect(`/login.html?error=${encodeURIComponent(err.message || "entra_proxy_error")}`);
  }
});

// GET /api/v1/auth/entra-proxy/settings — admin only (no secrets to mask)
router.get("/entra-proxy/settings", requireAuth, requirePermission("serverSettingsSystem", "write"), async (_req, res, next) => {
  try {
    res.json(await getEntraProxySettings());
  } catch (err) { next(err); }
});

// PUT /api/v1/auth/entra-proxy/settings — admin only
router.put("/entra-proxy/settings", requireAuth, requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    const input = EntraProxySettingsSchema.partial().parse(req.body ?? {});
    res.json(await updateEntraProxySettings(input));
  } catch (err) { next(err); }
});

// POST /api/v1/auth/entra-proxy/test — report how THIS request looks to the
// trust gate (request IP, trusted?, which identity header NAMES are present).
router.post("/entra-proxy/test", requireAuth, requirePermission("serverSettingsSystem", "write"), async (req, res, next) => {
  try {
    res.json(await testEntraProxyRequest(req));
  } catch (err) { next(err); }
});

// ─── TOTP self-management ───────────────────────────────────────────────────
// Endpoints for the logged-in user to enroll / confirm / disable their own
// second factor. Admin-initiated reset for *another* user lives under
// /users/:id/totp (see routes/users.ts).

const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, "Current password is required"),
  newPassword: passwordPolicySchema,
});

/**
 * Rotate the session ID while keeping the caller logged in.
 *
 * `regenerateSession` on its own would strand the page: every field the app
 * reads off the session (identity, role snapshot, mfaVerified) lives in the
 * object it throws away, and so does `csrfToken` — which the csrf middleware
 * already mirrored into a response cookie EARLIER in this same request, from
 * the OLD session. A fresh token minted on the next request would then
 * disagree with the cookie the still-open page is holding, and the user's next
 * save would 403 until they reloaded. So the identity fields and the CSRF
 * token are carried across deliberately: the ID rotates, the page does not
 * notice.
 */
async function rotateSessionKeepingIdentity(req: Request): Promise<void> {
  const carried = { ...req.session } as Record<string, unknown>;
  await regenerateSession(req);
  for (const [key, value] of Object.entries(carried)) {
    if (key === "cookie") continue; // express-session owns the new one
    (req.session as unknown as Record<string, unknown>)[key] = value;
  }
  req.session.lastActivity = Date.now();
}

/**
 * Drop every OTHER live session belonging to this user from the
 * connect-pg-simple store. This is the point of changing a password after a
 * suspected compromise: the new password is worthless while whoever learned
 * the old one still holds a valid cookie.
 *
 * Best-effort by design — the same reasoning as `getOnlineUserIds` in
 * users.ts: the session table is owned by connect-pg-simple, not by Prisma's
 * schema, so a read or write against it must never be the thing that fails a
 * password change that has already been committed.
 */
async function revokeOtherSessions(userId: string, keepSid: string): Promise<number> {
  try {
    const rows = await prisma.$queryRaw<{ sid: string; sess: unknown }[]>`
      SELECT sid, sess FROM session WHERE expire > NOW()
    `;
    const doomed = rows
      .filter((r) => r.sid !== keepSid && (r.sess as { userId?: unknown } | null)?.userId === userId)
      .map((r) => r.sid);
    if (!doomed.length) return 0;
    await prisma.$executeRaw`DELETE FROM session WHERE sid = ANY(${doomed}::text[])`;
    return doomed.length;
  } catch {
    return 0;
  }
}

// PUT /api/v1/auth/password — a local user changing their OWN password.
// Business rule 61.
//
// Distinct from the admin-side `PUT /users/:id/password` in two ways that
// matter: it proves the caller knows the current password (an admin reset
// cannot, which is why that one is an Event at `warning` level), and it is
// gated on nothing but being logged in — /users.html is `users`-gated, so
// before this route an ordinary local user had no way to change their own
// password at all.
router.put("/password", requireAuth, passwordChangeLimiter, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = ChangePasswordSchema.parse(req.body);
    const userId = req.session.userId!;
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

    // Same housekeeping the admin reset does: a lockout counted against the
    // old password is meaningless now, and a TOTP challenge minted against it
    // must not survive.
    clearLockout(user.username);
    mfaPending.revokeForUser(userId);

    const revoked = await revokeOtherSessions(userId, req.sessionID);
    await rotateSessionKeepingIdentity(req);

    logEvent({
      action: "user.password_changed",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `${user.username} changed their own password`,
      details: { ip: req.ip, otherSessionsRevoked: revoked },
    });

    res.json({ ok: true, otherSessionsRevoked: revoked });
  } catch (err) {
    next(err);
  }
});

const TotpConfirmSchema = z.object({ code: z.string().min(1) });
const TotpDisableSchema = z.object({ code: z.string().min(1), isBackupCode: z.boolean().optional() });

// POST /api/v1/auth/totp/enroll — start enrollment for the current user
router.post("/totp/enroll", requireAuth, async (req, res, next) => {
  try {
    const userId = req.session.userId!;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new AppError(404, "User not found");
    if (user.authProvider !== "local") {
      throw new AppError(400, "Two-factor auth is managed by your identity provider for SSO accounts.");
    }

    // Starting fresh enrollment always discards any half-configured state.
    // If TOTP is already fully enabled, the caller must disable it first —
    // we don't silently replace a working setup.
    if (user.totpEnabledAt) {
      throw new AppError(409, "Two-factor auth is already enabled. Disable it before re-enrolling.");
    }

    const secret = generateTotpSecret();
    const { otpauthUri, qrSvg } = await buildEnrollment(secret, user.username);
    await prisma.user.update({ where: { id: userId }, data: { totpSecret: sealValue(secret) } });

    res.json({ secret, otpauthUri, qrSvg });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/totp/confirm — finalize enrollment by proving the user
// configured their authenticator correctly (verify first 6-digit code)
router.post("/totp/confirm", requireAuth, totpCodeLimiter, async (req, res, next) => {
  try {
    const { code } = TotpConfirmSchema.parse(req.body);
    const userId = req.session.userId!;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || !user.totpSecret) {
      throw new AppError(400, "No enrollment in progress — start by generating a QR code.");
    }
    if (user.totpEnabledAt) {
      throw new AppError(409, "Two-factor auth is already enabled.");
    }
    if (!verifyTotpCode(openValue(user.totpSecret), code)) {
      throw new AppError(401, "Invalid code. Try again with a fresh value from your authenticator app.");
    }

    const { plaintext, hashes } = await generateBackupCodes();
    await prisma.user.update({
      where: { id: userId },
      data: { totpEnabledAt: new Date(), totpBackupCodes: hashes },
    });

    // Mark the current session mfa-verified so the user doesn't have to
    // log out and back in just because they enrolled.
    req.session.mfaVerified = true;

    logEvent({
      action: "auth.totp.enrolled",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `TOTP enabled for ${user.username}`,
    });

    res.json({ ok: true, backupCodes: plaintext });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/auth/totp — self-disable. Requires a valid current TOTP or
// backup code so a stolen session can't silently drop MFA.
router.delete("/totp", requireAuth, totpCodeLimiter, async (req, res, next) => {
  try {
    const { code, isBackupCode } = TotpDisableSchema.parse(req.body);
    const userId = req.session.userId!;
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
      verified = verifyTotpCode(openValue(user.totpSecret), code);
    }
    if (!verified) throw new AppError(401, "Invalid code.");

    await prisma.user.update({
      where: { id: userId },
      data: { totpSecret: null, totpEnabledAt: null, totpBackupCodes: [] },
    });

    logEvent({
      action: "auth.totp.disabled",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: user.username,
      message: `TOTP disabled for ${user.username} (self)`,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/auth/totp/status — current user's enrollment state
router.get("/totp/status", requireAuth, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId! },
      select: { authProvider: true, totpSecret: true, totpEnabledAt: true, totpBackupCodes: true },
    });
    if (!user) throw new AppError(404, "User not found");
    res.json({
      authProvider: user.authProvider,
      enabled: !!user.totpEnabledAt,
      enrolling: !!user.totpSecret && !user.totpEnabledAt,
      backupCodesRemaining: user.totpBackupCodes?.length ?? 0,
    });
  } catch (err) {
    next(err);
  }
});

// ─── Passkey self-management ────────────────────────────────────────────────
// The logged-in user registering / renaming / removing their OWN credentials,
// alongside TOTP above. Admin-initiated revoke for ANOTHER user lives under
// /users/:id/passkeys (routes/users.ts) — the same split TOTP reset uses.
//
// Every route here scopes by `req.session.userId` inside the service call
// rather than trusting an id from the path, so there is no object-reference to
// get wrong: the worst a crafted id can do is 404.

// GET /api/v1/auth/passkeys — this account's credentials + what the install allows
router.get("/passkeys", requireAuth, async (req, res, next) => {
  try {
    const [passkeys, availability, user] = await Promise.all([
      listPasskeys(req.session.userId!),
      getPasskeyAvailability(req),
      prisma.user.findUnique({ where: { id: req.session.userId! }, select: { authProvider: true } }),
    ]);
    res.json({ passkeys, availability, authProvider: user?.authProvider ?? "local" });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/auth/passkeys/register/options
router.post("/passkeys/register/options", requireAuth, passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId! },
      select: { id: true, username: true, displayName: true, authProvider: true },
    });
    if (!user) throw new AppError(404, "User not found");
    res.json(await startPasskeyRegistration(user, req));
  } catch (err) {
    next(err);
  }
});

const PasskeyRegisterSchema = z.object({
  token: z.string().min(1),
  name: z.string().max(80).optional(),
  response: z.object({}).passthrough(),
});

// POST /api/v1/auth/passkeys/register
router.post("/passkeys/register", requireAuth, passkeyCeremonyLimiter, async (req, res, next) => {
  try {
    const { token, name, response } = PasskeyRegisterSchema.parse(req.body);
    const user = await prisma.user.findUnique({
      where: { id: req.session.userId! },
      select: { id: true, username: true, displayName: true, authProvider: true },
    });
    if (!user) throw new AppError(404, "User not found");

    const passkey = await finishPasskeyRegistration({
      user,
      token,
      response: response as never,
      name: name?.trim() || "Passkey",
    });
    await logEvent({
      action: "user.passkey_registered",
      level: "warning",
      resourceType: "user",
      resourceId: user.id,
      resourceName: user.username,
      actor: req.session.username,
      message: `${user.username} registered a passkey ("${passkey.name}")`,
      details: { ip: req.ip, userAgent: req.get("user-agent") || undefined, deviceType: passkey.deviceType ?? undefined },
    });
    res.status(201).json(passkey);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/auth/passkeys/:id — rename
router.patch("/passkeys/:id", requireAuth, async (req, res, next) => {
  try {
    const { name } = z.object({ name: z.string().min(1).max(80) }).parse(req.body);
    res.json(await renamePasskey(req.session.userId!, req.params.id as string, name));
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/auth/passkeys/:id
router.delete("/passkeys/:id", requireAuth, async (req, res, next) => {
  try {
    const name = await deletePasskey(req.session.userId!, req.params.id as string);
    await logEvent({
      action: "user.passkey_removed",
      level: "warning",
      resourceType: "user",
      resourceId: req.session.userId!,
      resourceName: req.session.username,
      actor: req.session.username,
      message: `${req.session.username} removed a passkey ("${name}")`,
      details: { ip: req.ip },
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ─── Password complexity policy ─────────────────────────────────────────────
//
// The GET is deliberately UNAUTHENTICATED. Three surfaces need the rules
// before there is a session to read them with: the setup wizard's first-admin
// form, the forced-change step at login, and the login page in general. What it
// discloses is a minimum length and which character classes are required —
// which any caller can also learn by submitting one bad password — and in
// exchange the client checklist stops being a second, drifting copy of the
// rules. The PUT is admin-gated.

// GET /api/v1/auth/password-policy
router.get("/password-policy", async (_req, res, next) => {
  try {
    const policy = await getPasswordPolicy();
    res.json({
      policy,
      // The labels the checklist renders, in order, so the client never has to
      // reconstruct "At least N characters" from the knobs.
      rules: passwordRules(policy).map((r) => ({ key: r.key, label: r.label })),
      limits: { minLengthFloor: PASSWORD_MIN_LENGTH_FLOOR, minLengthCeiling: PASSWORD_MIN_LENGTH_CEILING },
    });
  } catch (err) {
    next(err);
  }
});

const PasswordPolicySchema = z.object({
  minLength: z.number().int().min(PASSWORD_MIN_LENGTH_FLOOR).max(PASSWORD_MIN_LENGTH_CEILING).optional(),
  requireLowercase: z.boolean().optional(),
  requireUppercase: z.boolean().optional(),
  requireNumber: z.boolean().optional(),
  requireSpecial: z.boolean().optional(),
  forceChangeOnLogin: z.boolean().optional(),
});

// PUT /api/v1/auth/password-policy
router.put(
  "/password-policy",
  requireAuth,
  requirePermission("serverSettingsSystem", "fullwrite"),
  async (req, res, next) => {
    try {
      const input = PasswordPolicySchema.parse(req.body ?? {});
      const before = await getPasswordPolicy();
      const updated = await savePasswordPolicy(input);
      await logEvent({
        // Turning on forceChangeOnLogin interrupts every non-conforming user's
        // next sign-in — the same "narrows a path operators depend on" shape
        // that makes the login-access enable a warning.
        level: updated.forceChangeOnLogin ? "warning" : "info",
        action: "password_policy.updated",
        resourceType: "setting",
        resourceName: "passwordPolicyConfig",
        actor: req.session?.username,
        message: `Password complexity policy: ${describePasswordPolicy(updated)}`,
        details: { before: before as never, after: updated as never, actorIp: req.ip },
      });
      res.json({ policy: updated });
    } catch (err) {
      next(err);
    }
  },
);

// ─── Passkey policy ─────────────────────────────────────────────────────────

// GET /api/v1/auth/passkey-settings — the admin view (mode + RP ID + what this
// request's origin actually resolves to, which is the thing an operator behind
// a proxy needs to see before trusting the feature).
router.get("/passkey-settings", requireAuth, requirePermission("serverSettingsSystem", "read"), async (req, res, next) => {
  try {
    const [settings, availability] = await Promise.all([getPasskeySettings(), getPasskeyAvailability(req)]);
    res.json({ settings, availability });
  } catch (err) {
    next(err);
  }
});

const PasskeySettingsSchema = z.object({
  mode: z.enum(["off", "login", "second-factor", "both"]).optional(),
  rpId: z.string().max(253).optional(),
  requireUserVerification: z.boolean().optional(),
});

// PUT /api/v1/auth/passkey-settings
router.put(
  "/passkey-settings",
  requireAuth,
  requirePermission("serverSettingsSystem", "fullwrite"),
  async (req, res, next) => {
    try {
      const input = PasskeySettingsSchema.parse(req.body ?? {});
      const before = await getPasskeySettings();
      const updated: PasskeySettings = await savePasskeySettings(input);
      await logEvent({
        // Switching a mode OFF strands credentials people may be relying on;
        // switching UV off weakens what a passkey login proves. Both are worth
        // a warning-level line in the audit trail.
        level: updated.mode === "off" || !updated.requireUserVerification ? "warning" : "info",
        action: "passkey_settings.updated",
        resourceType: "setting",
        resourceName: "passkeyConfig",
        actor: req.session?.username,
        message:
          `Passkeys: mode "${updated.mode}", user verification ${updated.requireUserVerification ? "required" : "preferred"}` +
          (updated.rpId ? `, domain ${updated.rpId}` : ", domain derived from the request"),
        details: { before: before as never, after: updated as never, actorIp: req.ip },
      });
      res.json({ settings: updated, availability: await getPasskeyAvailability(req) });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
