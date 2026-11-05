/**
 * src/utils/backupPassword.ts — strength floor for the optional encrypted-backup
 * passphrase.
 *
 * Server Settings → Maintenance lets an operator encrypt a database backup with
 * a passphrase that scrypt-derives the AES-256-GCM key. The route previously read
 * `req.body?.password || null` with no validation, so an empty/1-char passphrase
 * was accepted — making the "encrypted" backup trivially brute-forceable and
 * defeating the point of encrypting it. This adds a minimum length + a light
 * variety floor (catches "aaaaaaaaaaaa" / "111111111111"-style passphrases).
 *
 * Backup is the only path that validates: on RESTORE you must accept whatever
 * passphrase encrypted an existing file, so restore stays unvalidated.
 *
 * See the 2026-06-03 security review, finding M5.
 */

/** Minimum length for a backup-encryption passphrase. */
export const BACKUP_MIN_PASSWORD_LEN = 12;

/** Minimum number of DISTINCT characters — rejects single-char repeats. */
const BACKUP_MIN_DISTINCT_CHARS = 4;

/**
 * Validate a backup-encryption passphrase. Returns null when no passphrase was
 * supplied (an unencrypted backup is a legitimate choice). Returns the trimmed-
 * for-emptiness-only original string when valid. Throws `{ code: "WEAK_BACKUP_PASSWORD" }`
 * with an operator-facing message when supplied-but-too-weak.
 *
 * Note: the passphrase itself is NOT trimmed (leading/trailing spaces are valid
 * key material); only the "was anything supplied?" check treats whitespace-only
 * and empty as "no passphrase".
 */
export function validateBackupPassword(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw weak("Backup encryption password must be text.");
  }
  if (raw.trim().length === 0) return null; // no passphrase → unencrypted backup

  if (raw.length < BACKUP_MIN_PASSWORD_LEN) {
    throw weak(
      `Backup encryption password must be at least ${BACKUP_MIN_PASSWORD_LEN} characters.`,
    );
  }
  if (new Set(raw).size < BACKUP_MIN_DISTINCT_CHARS) {
    throw weak(
      "Backup encryption password is too weak — use a longer, more varied passphrase.",
    );
  }
  return raw;
}

function weak(message: string): Error {
  return Object.assign(new Error(message), { code: "WEAK_BACKUP_PASSWORD" });
}
