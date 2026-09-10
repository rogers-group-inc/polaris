/**
 * src/utils/version.ts — App version derivation.
 *
 * Version format: `<major>.<minor>.<patch>` where major+minor come from
 * package.json's `version` field and patch is the git commit count, so
 * the version always identifies the exact commit running.
 *
 * Resolution order for the patch:
 *   1. POLARIS_BUILD_COMMIT_COUNT env var — set by the Dockerfile from a
 *      build arg, since the runtime container has no .git directory to
 *      inspect at boot.
 *   2. `git rev-list --count HEAD` — the RHEL prod / dev fallback where
 *      the running tree is a real git checkout.
 *   3. "0" — last-resort fallback when neither is available.
 *
 * Computed once at module load and cached, since the answer never changes
 * for the life of the process.
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function readPackageMajorMinor(): { majorMinor: string; raw: string } {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../../package.json", "../../../package.json"]) {
      const p = join(here, rel);
      if (!existsSync(p)) continue;
      const pkg = JSON.parse(readFileSync(p, "utf-8"));
      const raw: string = pkg.version || "0.9.0";
      const [major, minor] = raw.split(".");
      return { majorMinor: `${major}.${minor}`, raw };
    }
  } catch {}
  return { majorMinor: "0.9", raw: "0.9.0" };
}

function resolvePatch(): string {
  const baked = process.env.POLARIS_BUILD_COMMIT_COUNT;
  if (baked && /^\d+$/.test(baked.trim())) return baked.trim();
  try {
    return execSync("git rev-list --count HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "0";
  }
}

const APP_VERSION = (() => {
  const { majorMinor } = readPackageMajorMinor();
  return `${majorMinor}.${resolvePatch()}`;
})();

export function getAppVersion(): string {
  return APP_VERSION;
}

// The commit the RUNNING process was built from, captured once at boot. This
// is deliberately separate from "what does the checkout's HEAD say": the
// in-app updater pulls new code before it installs, builds and restarts, so
// after an update that failed part-way the checkout is ahead of the process
// serving requests. Comparing the checkout to the remote then says "up to
// date" while the old build keeps running with no way to finish (prod,
// 2026-09-10). Null where there is no git tree to ask (the Docker image) or
// git is not on PATH.
const RUNNING_COMMIT: string | null = (() => {
  try {
    const out = execSync("git rev-parse HEAD", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
})();

/** Full SHA of the commit this process booted from, or null when unknown. */
export function getRunningCommit(): string | null {
  return RUNNING_COMMIT;
}

// ─── Polaris Agent version (decoupled from Polaris version) ──────────────
//
// The Polaris Agent is version-tracked independently from Polaris itself.
// `agent/VERSION` is a one-line text file at the root of the agent module
// that ANY edit to agent code MUST also bump (per the polaris-agent skill's rebuild
// contract). Decoupling means:
//
//   - Polaris releases that don't touch agent/ produce zero auto-build
//     noise and no operator-visible Upgrade prompts.
//   - The agent binary's `--version` reports `agent/VERSION`, not Polaris's.
//   - `manifest.json` in data/agents/ tracks the agent's version, not
//     Polaris's, so directory names + the auto-build comparison key are
//     stable across Polaris patch releases.
//
// Caching: small mtime check (5 s) so a release tarball drop is picked up
// without a server restart. The file is tiny (one line); the stat + read
// cost on cache miss is negligible.

const AGENT_VERSION_FORMAT = /^\d+\.\d+\.\d+(-[\w.]+)?$/;
const AGENT_VERSION_TTL_MS = 5_000;
const AGENT_VERSION_FALLBACK = "0.0.0-no-version-file";

let agentVersionCache: { value: string; checkedAt: number; mtimeMs: number } | null = null;

function locateAgentVersionFile(): string | null {
  // Mirrors `readPackageMajorMinor`'s walk; the agent/ directory sits
  // alongside package.json at the project root.
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../../agent/VERSION", "../../../agent/VERSION"]) {
      const p = join(here, rel);
      if (existsSync(p)) return p;
    }
  } catch { /* fall through */ }
  return null;
}

export function getAgentVersion(): string {
  const path = locateAgentVersionFile();
  if (!path) return AGENT_VERSION_FALLBACK;

  // Fast path: cache hit, mtime unchanged, within TTL.
  const now = Date.now();
  if (agentVersionCache && now - agentVersionCache.checkedAt < AGENT_VERSION_TTL_MS) {
    return agentVersionCache.value;
  }

  // Slow path: stat the file. If mtime matches the cached entry, just
  // bump checkedAt; otherwise re-read.
  try {
    const st = statSync(path);
    if (agentVersionCache && agentVersionCache.mtimeMs === st.mtimeMs) {
      agentVersionCache.checkedAt = now;
      return agentVersionCache.value;
    }
    const raw = readFileSync(path, "utf-8").trim();
    if (!AGENT_VERSION_FORMAT.test(raw)) {
      // Malformed file (e.g. operator pasted multiple lines or whitespace
      // that survived our trim). Don't crash; report the fallback so
      // operators see the symptom in Events / logs.
      return AGENT_VERSION_FALLBACK;
    }
    agentVersionCache = { value: raw, checkedAt: now, mtimeMs: st.mtimeMs };
    return raw;
  } catch {
    return AGENT_VERSION_FALLBACK;
  }
}

// Path to the agent/ directory itself — useful for the build service which
// needs to `cd` into it before invoking `go build`. Returns null when the
// directory can't be located (defensive — should never happen in a release
// tarball).
export function getAgentSourceDir(): string | null {
  const versionFile = locateAgentVersionFile();
  if (!versionFile) return null;
  return dirname(versionFile);
}
