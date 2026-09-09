/**
 * src/utils/sshKeygen.ts — generate an ed25519 keypair that actually parses.
 *
 * ssh2's `generateKeyPairSync("ed25519", …)` intermittently emits a private key
 * that its OWN `parseKey` rejects as "Malformed OpenSSH private key" — roughly
 * one call in three on Node 20+. It is not input-dependent: the same arguments
 * succeed on the next attempt.
 *
 * That bug had two visible consequences before this helper existed. Clicking
 * "Generate keypair" on Integrations → Polaris Agent → SSH Deployment failed
 * with a 500 about a third of the time, and `tests/unit/windowsSshOnboarding.test.ts`
 * (plus `sshPassphrase.test.ts`, which builds ed25519 fixtures at module load)
 * flaked at the same rate — a flake documented for months as "compare
 * like-for-like before blaming your change".
 *
 * The fix is to treat `parseKey` as the validation it already was and generate
 * again on failure. One implementation, shared by every caller including the
 * tests, so a future keypair surface cannot reintroduce the flake by
 * hand-rolling the call.
 */

import ssh2 from "ssh2";
import { logger } from "./logger.js";

const sshUtils = ssh2.utils;

/** Attempts before giving up. Five makes a genuine failure ~1 in 250. */
export const KEYGEN_ATTEMPTS = 5;

export interface Ed25519Keypair {
  /** OpenSSH private-key format, which ssh2's client accepts directly. */
  privateKey: string;
  /** authorized_keys one-liner, trimmed. */
  publicKey:  string;
}

export class SshKeygenError extends Error {
  constructor(attempts: number, lastError: string) {
    super(`Could not generate a parseable ed25519 key after ${attempts} attempts: ${lastError}`);
    this.name = "SshKeygenError";
  }
}

/**
 * Generate an ed25519 keypair, retrying until the private half parses.
 *
 * Throws `SshKeygenError` only if every attempt produced an unparseable key,
 * which would mean something is genuinely wrong with the toolchain rather than
 * the intermittent bug this works around. Callers map it to their own error
 * type; nothing should catch it and continue with a key that does not parse,
 * because such a key stores fine and then silently never authenticates.
 */
export function generateEd25519Keypair(comment: string): Ed25519Keypair {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= KEYGEN_ATTEMPTS; attempt += 1) {
    const pair = sshUtils.generateKeyPairSync("ed25519", comment ? { comment } : {});
    const privateKey = String(pair.private);
    const parsed = sshUtils.parseKey(privateKey);
    if (!(parsed instanceof Error)) {
      return { privateKey, publicKey: String(pair.public).trim() };
    }
    lastError = parsed.message;
    logger.warn({ attempt, err: parsed.message }, "generated ed25519 key failed to parse; regenerating");
  }
  throw new SshKeygenError(KEYGEN_ATTEMPTS, lastError);
}

/**
 * Same, with a passphrase on the private half.
 *
 * Separate function rather than an optional argument because an encrypted key
 * cannot be validated the same way: `parseKey` needs the passphrase to parse
 * it, so the check has to pass it through. Used for test fixtures and by
 * anything that stores a passphrase-protected key.
 */
export function generateEncryptedEd25519Keypair(passphrase: string, comment = ""): Ed25519Keypair {
  let lastError = "unknown";
  for (let attempt = 1; attempt <= KEYGEN_ATTEMPTS; attempt += 1) {
    const pair = sshUtils.generateKeyPairSync("ed25519", {
      ...(comment ? { comment } : {}),
      passphrase,
      cipher: "aes256-cbc",
    });
    const privateKey = String(pair.private);
    const parsed = sshUtils.parseKey(privateKey, passphrase);
    if (!(parsed instanceof Error)) {
      return { privateKey, publicKey: String(pair.public).trim() };
    }
    lastError = parsed.message;
    logger.warn({ attempt, err: parsed.message }, "generated encrypted ed25519 key failed to parse; regenerating");
  }
  throw new SshKeygenError(KEYGEN_ATTEMPTS, lastError);
}
