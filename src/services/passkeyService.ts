/**
 * src/services/passkeyService.ts — WebAuthn passkeys for LOCAL accounts.
 * Business rule 64.
 *
 * Three things live here: the operator policy (`passkeyConfig`, a Setting row
 * on the settingsStore pattern), the four ceremonies (register, passwordless
 * login, second-factor step, and the admin/self CRUD around stored
 * credentials), and the rules that decide which of those a given install and a
 * given account may use.
 *
 * ─── The policy ───
 * `mode` is what the admin chooses in Users → Authentication → Settings:
 *
 *   "off"            passkeys do nothing. Registration is refused, the login
 *                    button is hidden, existing credentials stay on disk (so
 *                    flipping the switch back does not orphan anyone) but
 *                    authenticate nothing.
 *   "login"          a passkey signs you in on its own — the passwordless flow.
 *   "second-factor"  password first, then a passkey instead of a TOTP code.
 *   "both"           either, user's choice. The default.
 *
 * "both" is the default because enabling passkeys REFUSES nothing: passwords
 * keep working, registration is opt-in per user, and an install that never
 * looks at the tab is exactly as reachable as it was. The FOSS posture rule is
 * that an upgrade must not start denying logins — it says nothing about
 * offering a stronger one.
 *
 * ─── Why a passkey is allowed to be the whole login ───
 * `requireUserVerification` (default true) makes the authenticator prove the
 * human is present AND verified — a PIN, a fingerprint, a face — before it will
 * sign. That is two factors inside one gesture (something you have: the
 * authenticator; something you know or are: the UV check), which is why a
 * passkey login is stamped `mfaVerified` and skips the TOTP step. Turn UV off
 * and that stops being true, which is why the setting says so and why the mode
 * and the UV flag are edited on the same card.
 *
 * ─── What this module deliberately does NOT do ───
 * It never provisions a user. Every other credential path in Polaris can mint
 * an account (SAML/OIDC/LDAP all find-or-provision); a passkey cannot, because
 * a credential that names no existing user is a credential for nobody. A
 * discoverable-credential login that resolves to no row is an authentication
 * failure, not a signup.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { createSettingStore } from "./settingsStore.js";
import * as webauthnChallenge from "../utils/webauthnChallenge.js";
import { resolveRelyingParty, type RelyingParty } from "../utils/webauthnRp.js";
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from "@simplewebauthn/server";

export const PASSKEY_SETTING_KEY = "passkeyConfig";

export type PasskeyMode = "off" | "login" | "second-factor" | "both";

export interface PasskeySettings {
  mode: PasskeyMode;
  /** Operator-pinned RP ID, or "" to derive from the request's Host header. */
  rpId: string;
  /**
   * Require the authenticator to verify the user (PIN / biometric). True is
   * what makes a passkey acceptable as the whole login; turning it off is only
   * sensible for an install that keeps passkeys as a second factor.
   */
  requireUserVerification: boolean;
}

export function defaultPasskeySettings(): PasskeySettings {
  return { mode: "both", rpId: "", requireUserVerification: true };
}

function isPasskeyMode(v: unknown): v is PasskeyMode {
  return v === "off" || v === "login" || v === "second-factor" || v === "both";
}

function parsePasskeySettings(raw: unknown): PasskeySettings {
  const fallback = defaultPasskeySettings();
  if (raw == null || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  return {
    mode: isPasskeyMode(r.mode) ? r.mode : fallback.mode,
    // Normalized the way the RP resolver will compare it: bare host, lowercase,
    // no scheme and no trailing dot. An operator pasting a URL is the expected
    // input, not an error worth refusing.
    rpId: typeof r.rpId === "string" ? normalizeRpId(r.rpId) : fallback.rpId,
    requireUserVerification:
      typeof r.requireUserVerification === "boolean" ? r.requireUserVerification : fallback.requireUserVerification,
  };
}

export function normalizeRpId(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/\.$/, "");
}

const passkeyStore = createSettingStore<PasskeySettings>({
  key: PASSKEY_SETTING_KEY,
  ttlMs: 10_000,
  parse: parsePasskeySettings,
});

export function invalidatePasskeyCache(): void {
  passkeyStore.invalidate();
}

/**
 * The active policy. Fails to "off" rather than to the default: a settings read
 * that throws must not be the thing that decides a credential may sign someone
 * in. Passwords still work, so failing closed here costs a user a fallback,
 * not their access.
 */
export async function getPasskeySettings(): Promise<PasskeySettings> {
  try {
    return await passkeyStore.get();
  } catch {
    return { ...defaultPasskeySettings(), mode: "off" };
  }
}

export async function savePasskeySettings(input: Partial<PasskeySettings>): Promise<PasskeySettings> {
  const current = await passkeyStore.get();
  const next: PasskeySettings = {
    mode: isPasskeyMode(input.mode) ? input.mode : current.mode,
    rpId: typeof input.rpId === "string" ? normalizeRpId(input.rpId) : current.rpId,
    requireUserVerification:
      typeof input.requireUserVerification === "boolean" ? input.requireUserVerification : current.requireUserVerification,
  };
  return passkeyStore.save(next);
}

export function passkeyLoginEnabled(s: PasskeySettings): boolean {
  return s.mode === "login" || s.mode === "both";
}

export function passkeySecondFactorEnabled(s: PasskeySettings): boolean {
  return s.mode === "second-factor" || s.mode === "both";
}

// ─── Relying party ──────────────────────────────────────────────────────────

export interface RequestLike {
  protocol: string;
  headers: { host?: string | undefined; [k: string]: unknown };
  get?(name: string): string | undefined;
}

/** Resolve the RP for this request, or throw the operator-facing reason why not. */
export async function requireRelyingParty(req: RequestLike): Promise<RelyingParty> {
  const settings = await getPasskeySettings();
  const result = resolveRelyingParty(hostOf(req), req.protocol, settings.rpId);
  if (!result.ok) throw new AppError(400, result.reason);
  return result.rp;
}

function hostOf(req: RequestLike): string | undefined {
  const viaGetter = typeof req.get === "function" ? req.get("host") : undefined;
  return viaGetter ?? (typeof req.headers?.host === "string" ? req.headers.host : undefined);
}

/**
 * What the login page needs to know before it decides whether to show a
 * "Sign in with a passkey" button. Unauthenticated — it reveals whether the
 * feature is on and whether this origin can host it, and nothing about who is
 * enrolled.
 */
export async function getPasskeyAvailability(req: RequestLike): Promise<{
  loginEnabled: boolean;
  secondFactorEnabled: boolean;
  mode: PasskeyMode;
  /** Null when the RP resolves; otherwise why this origin cannot use passkeys. */
  unavailableReason: string | null;
  rpId: string | null;
}> {
  const settings = await getPasskeySettings();
  const result = resolveRelyingParty(hostOf(req), req.protocol, settings.rpId);
  const usable = result.ok && settings.mode !== "off";
  return {
    loginEnabled: usable && passkeyLoginEnabled(settings),
    secondFactorEnabled: usable && passkeySecondFactorEnabled(settings),
    mode: settings.mode,
    unavailableReason: result.ok ? null : result.reason,
    rpId: result.ok ? result.rp.rpId : null,
  };
}

// ─── Stored credentials ─────────────────────────────────────────────────────

export interface PasskeySummary {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  deviceType: string | null;
  backedUp: boolean;
  transports: string[];
}

const SUMMARY_SELECT = {
  id: true,
  name: true,
  createdAt: true,
  lastUsedAt: true,
  deviceType: true,
  backedUp: true,
  transports: true,
} as const;

export async function listPasskeys(userId: string): Promise<PasskeySummary[]> {
  return prisma.userPasskey.findMany({
    where: { userId },
    select: SUMMARY_SELECT,
    orderBy: { createdAt: "asc" },
  });
}

/** How many passkeys each of these users holds — one query, for the users table. */
export async function countPasskeysByUser(userIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (userIds.length === 0) return counts;
  const rows = await prisma.userPasskey.groupBy({
    by: ["userId"],
    where: { userId: { in: userIds } },
    _count: { _all: true },
  });
  for (const row of rows) counts.set(row.userId, row._count._all);
  return counts;
}

export async function renamePasskey(userId: string, id: string, name: string): Promise<PasskeySummary> {
  const trimmed = name.trim();
  if (!trimmed) throw new AppError(400, "Passkey name is required");
  // Scoped by userId, not just id: the route is self-service, so "your own" is
  // part of the lookup rather than a check after it.
  const existing = await prisma.userPasskey.findFirst({ where: { id, userId }, select: { id: true } });
  if (!existing) throw new AppError(404, "Passkey not found");
  return prisma.userPasskey.update({
    where: { id },
    data: { name: trimmed.slice(0, 80) },
    select: SUMMARY_SELECT,
  });
}

/**
 * Delete one passkey. Returns the name for the audit Event.
 *
 * No "last credential" guard, deliberately: a password is always present on a
 * local account (it is a NOT NULL column and there is no passkey-only signup),
 * so removing every passkey cannot lock anyone out the way removing the last
 * admin role could.
 */
export async function deletePasskey(userId: string, id: string): Promise<string> {
  const existing = await prisma.userPasskey.findFirst({ where: { id, userId }, select: { id: true, name: true } });
  if (!existing) throw new AppError(404, "Passkey not found");
  await prisma.userPasskey.delete({ where: { id } });
  webauthnChallenge.revokeForUser(userId);
  return existing.name;
}

/** Admin-side revoke-all. Returns how many were removed. */
export async function deleteAllPasskeys(userId: string): Promise<number> {
  const { count } = await prisma.userPasskey.deleteMany({ where: { userId } });
  webauthnChallenge.revokeForUser(userId);
  return count;
}

// ─── Registration ───────────────────────────────────────────────────────────

interface LocalUser {
  id: string;
  username: string;
  displayName?: string | null;
  authProvider: string;
}

function assertLocalAccount(user: LocalUser): void {
  if (user.authProvider !== "local") {
    throw new AppError(400, "Passkeys are for local accounts — your sign-in is managed by your identity provider.");
  }
}

async function assertPasskeysUsable(): Promise<PasskeySettings> {
  const settings = await getPasskeySettings();
  if (settings.mode === "off") {
    throw new AppError(400, "Passkeys are disabled for this install.");
  }
  return settings;
}

export async function startRegistration(
  user: LocalUser,
  req: RequestLike,
): Promise<{ token: string; options: Awaited<ReturnType<typeof generateRegistrationOptions>> }> {
  assertLocalAccount(user);
  const settings = await assertPasskeysUsable();
  const rp = await requireRelyingParty(req);

  const existing = await prisma.userPasskey.findMany({
    where: { userId: user.id },
    select: { credentialId: true, transports: true },
  });

  const options = await generateRegistrationOptions({
    rpName: "Polaris",
    rpID: rp.rpId,
    userName: user.username,
    userDisplayName: user.displayName || user.username,
    // The user handle must be STABLE for this account and must not be
    // guessable-from-PII: it is what a discoverable credential stores and
    // replays, and a credential manager keys its entry on it. The account UUID
    // is both — and reusing it means re-registering an authenticator replaces
    // that account's entry instead of stacking a second one beside it.
    userID: new TextEncoder().encode(user.id),
    attestationType: "none",
    // Every credential this account already holds, so the authenticator refuses
    // to enroll itself twice and the user gets "you already registered this"
    // from the browser rather than a duplicate row.
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
    authenticatorSelection: {
      // "required" — a passkey that is not discoverable cannot start a
      // usernameless login, which is the flow this feature is mostly for.
      residentKey: "required",
      userVerification: settings.requireUserVerification ? "required" : "preferred",
    },
  });

  const token = webauthnChallenge.issue({
    purpose: "register",
    challenge: options.challenge,
    userId: user.id,
    rpId: rp.rpId,
    origin: rp.origin,
  });
  return { token, options };
}

export async function finishRegistration(args: {
  user: LocalUser;
  token: string;
  response: RegistrationResponseJSON;
  name: string;
}): Promise<PasskeySummary> {
  assertLocalAccount(args.user);
  const settings = await assertPasskeysUsable();

  const ceremony = webauthnChallenge.consume(args.token, "register");
  if (!ceremony || ceremony.userId !== args.user.id) {
    throw new AppError(400, "That passkey registration expired or was already used — start again.");
  }

  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response: args.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpId,
      requireUserVerification: settings.requireUserVerification,
    });
  } catch (err) {
    // The library's messages name the actual mismatch (origin, RP ID, UV flag),
    // which is what an operator debugging a proxy needs to see.
    throw new AppError(400, `Passkey registration could not be verified: ${(err as Error).message}`);
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw new AppError(400, "Passkey registration could not be verified.");
  }

  const { credential, credentialDeviceType, credentialBackedUp, aaguid } = verification.registrationInfo;

  // A credential ID is unique across the install, so the same authenticator
  // cannot be claimed by a second account. excludeCredentials stops the honest
  // case; this is the race and the dishonest one.
  const clash = await prisma.userPasskey.findUnique({
    where: { credentialId: credential.id },
    select: { userId: true },
  });
  if (clash) {
    throw new AppError(
      409,
      clash.userId === args.user.id
        ? "That passkey is already registered on this account."
        : "That passkey is already registered to another account.",
    );
  }

  const created = await prisma.userPasskey.create({
    data: {
      userId: args.user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: BigInt(credential.counter),
      transports: (credential.transports ?? []) as string[],
      name: args.name.trim().slice(0, 80) || "Passkey",
      aaguid: aaguid || null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    },
    select: SUMMARY_SELECT,
  });
  return created;
}

// ─── Authentication ─────────────────────────────────────────────────────────

/**
 * Begin a passkey login.
 *
 * `allowCredentials` is left EMPTY on purpose. Naming a user's credentials
 * before they have authenticated would turn this endpoint into an enumeration
 * oracle — "does alice exist, and how many keys does she have" — so the browser
 * is asked for any discoverable credential for this RP, and the assertion
 * itself names the account. That is why registration demands a resident key.
 */
export async function startLogin(req: RequestLike): Promise<{
  token: string;
  options: Awaited<ReturnType<typeof generateAuthenticationOptions>>;
}> {
  const settings = await assertPasskeysUsable();
  if (!passkeyLoginEnabled(settings)) {
    throw new AppError(400, "Passkeys are configured as a second factor only on this install.");
  }
  const rp = await requireRelyingParty(req);

  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    userVerification: settings.requireUserVerification ? "required" : "preferred",
  });
  const token = webauthnChallenge.issue({
    purpose: "login",
    challenge: options.challenge,
    userId: null,
    rpId: rp.rpId,
    origin: rp.origin,
  });
  return { token, options };
}

/**
 * Begin the second-factor step for a user who has already passed the password.
 * Here the credentials ARE named: the caller proved they know the password, so
 * listing that account's authenticators tells them nothing new, and naming them
 * is what lets a non-discoverable security key participate.
 */
export async function startSecondFactor(
  req: RequestLike,
  userId: string,
): Promise<{ token: string; options: Awaited<ReturnType<typeof generateAuthenticationOptions>> }> {
  const settings = await assertPasskeysUsable();
  if (!passkeySecondFactorEnabled(settings)) {
    throw new AppError(400, "Passkeys are not enabled as a second factor on this install.");
  }
  const rp = await requireRelyingParty(req);
  const credentials = await prisma.userPasskey.findMany({
    where: { userId },
    select: { credentialId: true, transports: true },
  });
  if (credentials.length === 0) throw new AppError(400, "This account has no passkeys registered.");

  const options = await generateAuthenticationOptions({
    rpID: rp.rpId,
    userVerification: settings.requireUserVerification ? "required" : "preferred",
    allowCredentials: credentials.map((c) => ({ id: c.credentialId, transports: c.transports as never })),
  });
  const token = webauthnChallenge.issue({
    purpose: "mfa",
    challenge: options.challenge,
    userId,
    rpId: rp.rpId,
    origin: rp.origin,
  });
  return { token, options };
}

export interface PasskeyAuthResult {
  userId: string;
  username: string;
  passkeyId: string;
  passkeyName: string;
}

/**
 * Verify an assertion and update the stored counter.
 *
 * `expectUserId` is set for the second-factor step: the assertion must come
 * from a credential belonging to the account that just passed the password,
 * or a second passkey-holder could finish somebody else's half-done login.
 */
export async function finishAuthentication(args: {
  token: string;
  response: AuthenticationResponseJSON;
  purpose: "login" | "mfa";
  expectUserId?: string;
}): Promise<PasskeyAuthResult> {
  const settings = await assertPasskeysUsable();
  const ceremony = webauthnChallenge.consume(args.token, args.purpose);
  if (!ceremony) throw new AppError(401, "That passkey sign-in expired — try again.");
  if (args.expectUserId && ceremony.userId !== args.expectUserId) {
    throw new AppError(401, "That passkey sign-in does not belong to this login.");
  }

  const credentialId = args.response.id;
  const stored = await prisma.userPasskey.findUnique({
    where: { credentialId },
    include: { user: { select: { id: true, username: true, authProvider: true } } },
  });
  // Deliberately the same message as a failed signature: "that credential is
  // not registered here" is a fact worth learning for someone probing with a
  // key they control.
  if (!stored) throw new AppError(401, "That passkey was not recognized.");
  if (args.expectUserId && stored.userId !== args.expectUserId) {
    throw new AppError(401, "That passkey belongs to a different account.");
  }
  if (stored.user.authProvider !== "local") {
    throw new AppError(401, "That passkey was not recognized.");
  }

  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response: args.response,
      expectedChallenge: ceremony.challenge,
      expectedOrigin: ceremony.origin,
      expectedRPID: ceremony.rpId,
      requireUserVerification: settings.requireUserVerification,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(stored.publicKey),
        counter: Number(stored.counter),
        transports: stored.transports as never,
      },
    });
  } catch {
    throw new AppError(401, "That passkey was not recognized.");
  }
  if (!verification.verified) throw new AppError(401, "That passkey was not recognized.");

  const newCounter = verification.authenticationInfo.newCounter;
  // A counter that goes BACKWARDS from a non-zero value is the one signal
  // WebAuthn gives that a credential has been cloned. Many platform
  // authenticators pin the counter at 0 forever, so 0-to-0 is normal and only a
  // decrease from a real count is evidence. Refuse the login and say nothing
  // specific — the operator gets the detail in the Event the route writes.
  if (Number(stored.counter) > 0 && newCounter <= Number(stored.counter)) {
    throw new AppError(401, "That passkey was not recognized.");
  }

  await prisma.userPasskey.update({
    where: { id: stored.id },
    data: {
      counter: BigInt(newCounter),
      lastUsedAt: new Date(),
      // The authenticator re-states these on every assertion; a passkey that
      // has since been backed up to a credential manager should stop claiming
      // it is single-device.
      backedUp: verification.authenticationInfo.credentialBackedUp,
      deviceType: verification.authenticationInfo.credentialDeviceType,
    },
  });

  return {
    userId: stored.userId,
    username: stored.user.username,
    passkeyId: stored.id,
    passkeyName: stored.name,
  };
}

/** Does this account hold at least one passkey? Drives the login page's second-factor choice. */
export async function userHasPasskey(userId: string): Promise<boolean> {
  const count = await prisma.userPasskey.count({ where: { userId } });
  return count > 0;
}
