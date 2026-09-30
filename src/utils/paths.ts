/**
 * src/utils/paths.ts — Resolve where Polaris's persistent state lives on disk.
 *
 * Single opt-in env var: POLARIS_STATE_DIR.
 *   - Unset (RHEL prod, dev): falls back to the project root, so .env,
 *     .setup-complete, data/backups/, and public/uploads/ stay exactly where
 *     they've always been. Zero behavior change for existing installs.
 *   - Set (Docker image only): redirects all four state items under one
 *     directory so the container needs a single bind mount. The Dockerfile
 *     pins this to /app/state.
 *
 * Layout under STATE_DIR (whichever it is):
 *   .env
 *   .setup-complete
 *   data/backups/
 *   public/uploads/
 *
 * The `public/uploads` substructure is preserved (rather than collapsed to
 * just `uploads/`) so the Express `/uploads/*` static route can be mounted
 * to the same path on both layouts without a special case.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const STATE_DIR = process.env.POLARIS_STATE_DIR
  ? resolve(process.env.POLARIS_STATE_DIR)
  : PROJECT_ROOT;

// Shipped static assets (public/img/brand/*.png, mobile.html, sw.js, …). Deliberately
// derived from PROJECT_ROOT and NOT from STATE_DIR: this is code that ships
// with the release, not operator state, and it must resolve identically
// whether we're running from src/ (tsx) or dist/ (built).
export const PUBLIC_DIR = resolve(PROJECT_ROOT, "public");

export const ENV_FILE = resolve(STATE_DIR, ".env");
export const SETUP_COMPLETE_MARKER = resolve(STATE_DIR, ".setup-complete");
export const BACKUP_DIR = resolve(STATE_DIR, "data", "backups");
export const UPLOADS_DIR = resolve(STATE_DIR, "public", "uploads");

/**
 * Operator-uploaded agent code-signing keystore (a PKCS#12 holding an
 * internal-CA signing cert + its private key).
 *
 * Deliberately under `data/` and NOT `UPLOADS_DIR`: that one resolves to
 * STATE_DIR/public/uploads and is served at /uploads/<file>, so a keystore
 * placed there would be downloadable by anyone who could guess the name. This
 * directory is never mounted by any static handler. Lives under STATE_DIR so it
 * survives in-app updates and container recreation like backups and agent
 * binaries do.
 */
export const SIGNING_DIR = resolve(STATE_DIR, "data", "signing");

// Polaris Agent binaries. The release tarball ships per-version directories
// under data/agents/<version>/ (one binary per OS×arch) plus manifest.json
// that names the current default version. The in-app updater preserves
// data/ across self-updates so an in-progress agent install isn't broken
// when Polaris itself upgrades.
export const AGENT_BIN_DIR = resolve(STATE_DIR, "data", "agents");

/**
 * Firmware images the repository holds for switches and access points
 * (Server Settings → Repository, business rule 87). One `<imageId>.out` per
 * row; uploads land in `.incoming/` first so the final rename is on one
 * filesystem and atomic. Under `data/` like the agent binaries — never
 * `UPLOADS_DIR`, which is served at /uploads — and outside the pg_dump backup,
 * so it travels with the host exactly as `data/agents` does.
 */
export const FIRMWARE_DIR = resolve(STATE_DIR, "data", "firmware");
export const FIRMWARE_INCOMING_DIR = resolve(FIRMWARE_DIR, ".incoming");
