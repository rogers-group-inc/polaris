/**
 * src/utils/privateFiles.ts — business rule 117: files that hold the database
 * (backups, restore temp files) are readable by the Polaris account only.
 *
 * The shipped units set no UMask, so a file opened without a mode lands 0644
 * and a directory 0755 — a full pg_dump (password hashes, tokens, the event
 * log, device credentials in clear when POLARIS_SECRET_KEY is unset) readable
 * by every local account. `ensurePrivateDir` makes a directory 0700 and
 * tightens what an older install already left in it; `PRIVATE_FILE_MODE` is
 * the mode every such file is opened with. On Windows (dev only) chmod is a
 * near no-op and failures are ignored.
 */

import { chmodSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

const tightened = new Set<string>();

/** mkdir -p as 0700, and (once per process) chmod it and its files to 0700 / 0600. Never throws on chmod. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (tightened.has(dir)) return;
  tightened.add(dir);
  try { chmodSync(dir, PRIVATE_DIR_MODE); } catch { /* not ours to fix, or not POSIX */ }
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).isFile()) chmodSync(p, PRIVATE_FILE_MODE);
      } catch { /* best effort */ }
    }
  } catch { /* unreadable dir — the mkdir above already failed loudly if it mattered */ }
}

/** chmod a file to 0600, ignoring failure (a share that does not support modes). */
export function makeFilePrivate(path: string): void {
  try { chmodSync(path, PRIVATE_FILE_MODE); } catch { /* best effort */ }
}
