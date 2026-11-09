/**
 * src/utils/deploymentContext.ts
 *
 * Best-effort heuristics for "where is Polaris running?" Used to pick the
 * right help text in operator-facing recommendation alerts (TimescaleDB,
 * pg-boss). Both heuristics are computed once at first call and cached;
 * false negatives are fine — the conservative branch of each alert just
 * shows a more general suggestion.
 *
 *   dbIsLocal()          — is DATABASE_URL pointing at this same host?
 *   runtimeIsContainer() — is Polaris running in Docker / Podman / Kubernetes?
 *                          Also THE container test for Restart (rule 99), the
 *                          OS lifecycle probe and the HA install-shape check.
 */

import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { URL } from "node:url";

let cachedDbIsLocal: boolean | null = null;
let cachedRuntimeIsContainer: boolean | null = null;

/** The state directory Polaris's Dockerfile and compose files pin. */
const CONTAINER_STATE_DIR = "/app/state";

/** Test hook: forget the cached answers so a test can re-probe. */
export function resetDeploymentContextCache(): void {
  cachedDbIsLocal = null;
  cachedRuntimeIsContainer = null;
}

/**
 * Host and port of a PostgreSQL connection URL, for display. Parsed with URL —
 * never a regex — so a bracketed IPv6 host survives, and a socket-only URL
 * (`postgresql:///polaris?host=/var/run/postgresql`) says "local socket"
 * rather than inventing localhost:5432.
 */
export function describeDatabaseEndpoint(url: string | undefined): { host: string; port: number | null } {
  if (!url) return { host: "unknown", port: null };
  try {
    const u = new URL(url);
    const socketHost = u.searchParams.get("host");
    if (!u.hostname) return { host: socketHost ? `local socket (${socketHost})` : "local socket", port: null };
    return { host: u.hostname.replace(/^\[|\]$/g, ""), port: u.port ? Number(u.port) : 5432 };
  } catch {
    return { host: "unknown", port: null };
  }
}

function collectLocalAddresses(): Set<string> {
  const out = new Set<string>(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
  const ifaces = networkInterfaces();
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const addr of list) {
      if (addr.address) out.add(addr.address.toLowerCase());
    }
  }
  return out;
}

export function dbIsLocal(): boolean {
  if (cachedDbIsLocal !== null) return cachedDbIsLocal;
  const url = process.env.DATABASE_URL;
  if (!url) {
    cachedDbIsLocal = false;
    return cachedDbIsLocal;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (!host) {
      cachedDbIsLocal = true; // Unix socket / no host = local
      return cachedDbIsLocal;
    }
    const local = collectLocalAddresses();
    cachedDbIsLocal = local.has(host);
    return cachedDbIsLocal;
  } catch {
    cachedDbIsLocal = false;
    return cachedDbIsLocal;
  }
}

export function runtimeIsContainer(): boolean {
  if (cachedRuntimeIsContainer !== null) return cachedRuntimeIsContainer;
  // /.dockerenv is the most reliable signal Docker leaves behind in its images.
  if (existsSync("/.dockerenv")) {
    cachedRuntimeIsContainer = true;
    return cachedRuntimeIsContainer;
  }
  // Kubernetes injects this on every pod regardless of base image.
  if (process.env.KUBERNETES_SERVICE_HOST) {
    cachedRuntimeIsContainer = true;
    return cachedRuntimeIsContainer;
  }
  // Podman writes /run/.containerenv instead of /.dockerenv — and under
  // cgroup v2 its /proc/1/cgroup is just "0::/", so the check below misses it.
  if (existsSync("/run/.containerenv")) {
    cachedRuntimeIsContainer = true;
    return cachedRuntimeIsContainer;
  }
  // Polaris's own image pins POLARIS_STATE_DIR to /app/state. Only THAT value
  // is a container signal: the variable is also documented for BARE-METAL
  // installs that must keep state outside /opt (SELinux / STIG / a separate
  // volume), and treating any value as "container" refused Restart, refused
  // HA and mis-graded the OS on exactly those hosts (CQ-B042, 2026-11-06).
  if ((process.env.POLARIS_STATE_DIR ?? "").trim().replace(/\/+$/, "") === CONTAINER_STATE_DIR) {
    cachedRuntimeIsContainer = true;
    return cachedRuntimeIsContainer;
  }
  // /proc/1/cgroup carries the container runtime name on Linux. Read once;
  // fail safe to false on any I/O error or non-Linux host.
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|containerd|kubepods|crio/.test(cgroup)) {
      cachedRuntimeIsContainer = true;
      return cachedRuntimeIsContainer;
    }
  } catch {
    // Not Linux, /proc not mounted, or no permissions. Treat as bare-metal.
  }
  cachedRuntimeIsContainer = false;
  return cachedRuntimeIsContainer;
}

export interface DeploymentContext {
  dbIsLocal: boolean;
  runtimeIsContainer: boolean;
}

export function getDeploymentContext(): DeploymentContext {
  return { dbIsLocal: dbIsLocal(), runtimeIsContainer: runtimeIsContainer() };
}
