/**
 * src/services/totpService.ts — Time-based One-Time Password (RFC 6238) helpers
 *
 * Used for optional second-factor auth on local accounts. Secret + backup-code
 * persistence lives on the User model; this service is pure logic.
 */

import { TOTP, Secret } from "otpauth";
import QRCode from "qrcode";
import { randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../utils/password.js";

const TOTP_ISSUER = "Polaris";
const BACKUP_CODE_COUNT = 10;

// Build a TOTP handle for a specific account. All our codes use the default
// RFC 6238 parameters (SHA1, 6 digits, 30s step), which is what every common
// authenticator app (Google Authenticator, 1Password, Authy, Bitwarden, etc.)
// defaults to. Don't change these without planning a re-enrollment.
function buildTotp(secret: string, username: string): TOTP {
  return new TOTP({
    issuer: TOTP_ISSUER,
    label: username,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  });
}

/** Generate a fresh base32-encoded TOTP secret. */
export function generateSecret(): string {
  return new Secret({ size: 20 }).base32;
}

/**
 * Build the otpauth:// URI for a given secret + account identity, and render
 * it as an SVG QR code. The SVG is returned as a string suitable for
 * inlining into HTML (the frontend wraps it in a container).
 */
export async function buildEnrollment(secret: string, username: string): Promise<{ otpauthUri: string; qrSvg: string }> {
  const totp = buildTotp(secret, username);
  const otpauthUri = totp.toString();
  const qrSvg = await QRCode.toString(otpauthUri, { type: "svg", errorCorrectionLevel: "M", margin: 1, width: 200 });
  return { otpauthUri, qrSvg };
}

/**
 * Verify a 6-digit TOTP code against a stored secret.
 * Allows ±1 step (±30s) of drift for clock skew between the server and the
 * user's device — standard tolerance for TOTP.
 */
export function verifyCode(secret: string, code: string): boolean {
  return verifyCodeStep(secret, code) !== null;
}

/**
 * Like verifyCode, but returns the 30-second time step the code belongs to (the
 * current step plus the drift that matched), or null when it matches none.
 * Callers record the step with `claimTotpStep` and refuse a step already used —
 * `verifyCode` alone is stateless, so a code stayed valid for ~90 seconds after
 * it had logged someone in (RFC 6238 section 5.2; rule 108).
 */
export function verifyCodeStep(secret: string, code: string, nowMs: number = Date.now()): number | null {
  const cleaned = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleaned)) return null;
  const totp = buildTotp(secret, "verify"); // label doesn't affect verification
  const delta = totp.validate({ token: cleaned, window: 1, timestamp: nowMs });
  if (delta === null) return null;
  return Math.floor(nowMs / 1000 / 30) + delta;
}

/**
 * Generate a fresh set of backup codes. Returns both the plaintext codes (to
 * show the user once) and their argon2id hashes (to persist on the User row).
 * Format: 10 codes of the form `XXXX-XXXX` where X is a hex digit, chosen for
 * easy readability in a print-out or copy-paste.
 */
export async function generateBackupCodes(): Promise<{ plaintext: string[]; hashes: string[] }> {
  const plaintext: string[] = [];
  for (let i = 0; i < BACKUP_CODE_COUNT; i++) {
    const bytes = randomBytes(4);
    const hex = bytes.toString("hex").toUpperCase();
    plaintext.push(`${hex.slice(0, 4)}-${hex.slice(4, 8)}`);
  }
  const hashes = await Promise.all(plaintext.map((code) => hashPassword(code)));
  return { plaintext, hashes };
}

/**
 * Try to consume one of the stored backup-code hashes. Returns the remaining
 * hashes (with the matched one removed) on success, or null if no match.
 * Caller is responsible for persisting the returned array.
 */
export async function consumeBackupCode(storedHashes: string[], code: string): Promise<string[] | null> {
  const cleaned = code.trim().toUpperCase();
  for (let i = 0; i < storedHashes.length; i++) {
    const { valid } = await verifyPassword(cleaned, storedHashes[i]);
    if (valid) {
      return [...storedHashes.slice(0, i), ...storedHashes.slice(i + 1)];
    }
  }
  return null;
}
