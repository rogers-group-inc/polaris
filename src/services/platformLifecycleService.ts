/**
 * src/services/platformLifecycleService.ts
 *
 * "What is this Polaris host actually running, and is any of it past — or
 * approaching — end of life?"
 *
 * Three separate concerns, deliberately kept apart:
 *   - THIS file observes the host and assembles the answer.
 *   - src/utils/platformLifecycleGrade.ts grades observed-vs-dataset (pure).
 *   - src/data/platformEol.json is the committed, human-reviewed lifecycle
 *     data. Never fetched at runtime: an air-gapped install must still warn
 *     correctly. Refreshing it is a task for /polaris-tech-lifecycle, not a job.
 *
 * Cost: everything except three gated execs is in-process memory or state the
 * boot sequence already cached. The only new database work is one
 * `SHOW server_version` — a GUC read, not the string-building `SELECT
 * version()`. There are no per-asset queries, so the 2000-asset case costs
 * exactly what the 100-asset case costs. The whole assembly is memoized for
 * six hours so a 10-minute caller pays the exec cost at most four times a day.
 *
 * Failure contract: observePlatformStack() NEVER throws. Every probe has its
 * own try/catch and reports probeStatus instead. getPlatformLifecycle() also
 * swallows a missing or malformed dataset into `datasetError`, because the
 * capacity snapshot and the whole Maintenance tab must keep rendering when the
 * lifecycle data is the only broken thing.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { platform as osPlatform, release as osRelease } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { prisma } from "../db.js";
import { prismaVersion } from "../generated/prisma/internal/prismaNamespace.js";
import { logger } from "../utils/logger.js";
import { getAppVersion, getAgentVersion } from "../utils/version.js";
import { runtimeIsContainer } from "../utils/deploymentContext.js";
import { isPgbouncerMode } from "../utils/dbConnections.js";
import { getDetectionState } from "./timescaleService.js";
import { goAvailable } from "./agentBuildService.js";
import {
  parsePostgresVersion,
  parseNginxVersion,
  parseJavaVersion,
  parseOsRelease,
  runningNodeTrack,
} from "../utils/platformVersions.js";
import {
  platformEolDatasetSchema,
  gradeComponent,
  maxSeverity,
  type PlatformEolDataset,
  type PlatformPlaybook,
  type LifecycleGrade,
  type LifecycleSeverity,
} from "../utils/platformLifecycleGrade.js";

const execFileAsync = promisify(execFile);

// ─── The dataset ──────────────────────────────────────────────────────

/**
 * Resolved relative to this module so it works from `src/` under tsx AND from
 * `dist/` in a built install or container. The JSON is mirrored into dist/ by
 * the `ASSETS` entry in scripts/copy-build-assets.mjs — without that entry
 * this read fails only in production, which is the whole reason that script
 * exists.
 */
const DATASET_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "platformEol.json");

let datasetCache: PlatformEolDataset | null = null;

/** Load and validate the dataset once. Throws on a malformed file. */
export function loadPlatformEolDataset(): PlatformEolDataset {
  if (datasetCache) return datasetCache;
  const parsed = platformEolDatasetSchema.parse(JSON.parse(readFileSync(DATASET_PATH, "utf8")));
  datasetCache = parsed;
  return parsed;
}

/** Test seam: drop the cached dataset. */
export function _resetDatasetCache(): void {
  datasetCache = null;
}

// ─── Observation ──────────────────────────────────────────────────────

export type ProbeStatus =
  /** A version was read. */
  | "ok"
  /** The component is legitimately not present on this host. */
  | "absent"
  /** The probe ran and failed. */
  | "error"
  /** Present, but its version cannot be read from here at all. */
  | "undetectable";

export interface ObservedComponent {
  id: string;
  observedVersion: string | null;
  /** Raw probe output, for display. May carry host text — always escape it. */
  observedRaw: string | null;
  probeStatus: ProbeStatus;
  probeNote?: string;
}

const EXEC_TIMEOUT_MS = 3_000;

/** Every candidate path we will try for the nginx binary. */
const NGINX_BINARIES = ["nginx", "/usr/sbin/nginx", "/usr/local/nginx/sbin/nginx"];

/**
 * The managed nginx config. Its presence is how we decide whether this install
 * is fronted by nginx at all, so an install that is not never spawns a process.
 * Mirrors the constant in nginxApplyService (kept local to avoid importing that
 * service's whole graph for one string).
 */
const LIVE_NGINX_CONF = "/etc/nginx/conf.d/polaris.conf";

async function probePostgres(): Promise<ObservedComponent> {
  try {
    // SHOW server_version is a GUC read. SELECT version() builds a long
    // banner string and is what GET /database already pays for; no reason to
    // pay it twice.
    const rows = await prisma.$queryRawUnsafe<{ server_version: string }[]>("SHOW server_version");
    const raw = rows[0]?.server_version ?? null;
    if (!raw) return { id: "postgres", observedVersion: null, observedRaw: null, probeStatus: "error", probeNote: "server_version was empty" };
    return { id: "postgres", observedVersion: parsePostgresVersion(raw), observedRaw: raw, probeStatus: "ok" };
  } catch (err: any) {
    return { id: "postgres", observedVersion: null, observedRaw: null, probeStatus: "error", probeNote: err?.message };
  }
}

function probeTimescale(): ObservedComponent {
  // Already cached by the boot-time detection pass — no query here.
  const st = getDetectionState();
  if (!st.extensionInstalled) {
    return { id: "timescaledb", observedVersion: null, observedRaw: null, probeStatus: "absent" };
  }
  return {
    id: "timescaledb",
    observedVersion: st.extensionVersion,
    observedRaw: st.extensionVersion,
    probeStatus: st.extensionVersion ? "ok" : "undetectable",
    probeNote: st.extensionVersion ? undefined : "extension present but extversion was null",
  };
}

async function probeGo(): Promise<ObservedComponent> {
  try {
    const go = await goAvailable();
    if (!go.ok) return { id: "go", observedVersion: null, observedRaw: null, probeStatus: "absent", probeNote: go.error };
    return {
      id: "go",
      observedVersion: go.versionNumber ?? null,
      observedRaw: go.version ?? null,
      probeStatus: go.versionNumber ? "ok" : "undetectable",
    };
  } catch (err: any) {
    return { id: "go", observedVersion: null, observedRaw: null, probeStatus: "error", probeNote: err?.message };
  }
}

async function probeJava(): Promise<ObservedComponent> {
  try {
    // STDERR by long-standing JDK convention.
    const { stderr, stdout } = await execFileAsync("java", ["-version"], { timeout: EXEC_TIMEOUT_MS });
    const raw = ((stderr || stdout) ?? "").split("\n")[0]?.trim() ?? "";
    return {
      id: "java",
      observedVersion: parseJavaVersion(raw),
      observedRaw: raw || null,
      probeStatus: raw ? "ok" : "undetectable",
    };
  } catch {
    // Absent, not an error: Java is only needed for optional agent signing.
    return { id: "java", observedVersion: null, observedRaw: null, probeStatus: "absent" };
  }
}

async function probeNginx(): Promise<ObservedComponent> {
  // Gate on the managed config so a non-nginx install never spawns anything.
  if (!existsSync(LIVE_NGINX_CONF)) {
    return {
      id: "nginx",
      observedVersion: null,
      observedRaw: null,
      probeStatus: "absent",
      probeNote: "no managed nginx config on this host",
    };
  }
  for (const bin of NGINX_BINARIES) {
    try {
      // `nginx -v` writes to stderr and needs no privilege. Deliberately NOT
      // routed through the polaris-nginx-apply sudo wrapper: that wrapper's
      // argument surface is the entire granted privilege and must not widen
      // for a version read.
      const { stderr, stdout } = await execFileAsync(bin, ["-v"], { timeout: EXEC_TIMEOUT_MS });
      const raw = ((stderr || stdout) ?? "").trim();
      const version = parseNginxVersion(raw);
      if (version) return { id: "nginx", observedVersion: version, observedRaw: raw, probeStatus: "ok" };
    } catch {
      // Try the next candidate path.
    }
  }
  return {
    id: "nginx",
    observedVersion: null,
    observedRaw: null,
    probeStatus: "undetectable",
    probeNote: "nginx config present but `nginx -v` could not be run (PATH, or a hardened unit blocking exec)",
  };
}

function probeOs(): ObservedComponent {
  const container = runtimeIsContainer();
  const plat = osPlatform();

  if (plat === "win32") {
    // Reported, never graded: the build-number-to-product table rots and
    // Windows Server lifecycles run ~10 years, which is not this risk.
    return { id: "os:windows", observedVersion: null, observedRaw: osRelease(), probeStatus: "undetectable", probeNote: `Windows build ${osRelease()}` };
  }

  try {
    const raw = readFileSync("/etc/os-release", "utf8");
    const { id, versionId } = parseOsRelease(raw);
    // Rocky and AlmaLinux track RHEL's majors on RHEL's calendar.
    const family = id === "rocky" || id === "almalinux" || id === "rhel" || id === "centos" ? "rhel" : id;
    if (!family || !versionId) {
      return { id: "os:unknown", observedVersion: null, observedRaw: raw.slice(0, 200), probeStatus: "undetectable", probeNote: "os-release lacked ID or VERSION_ID" };
    }
    return {
      id: `os:${family}`,
      observedVersion: versionId,
      observedRaw: `${id} ${versionId}`,
      probeStatus: "ok",
      // Without this, a container's bookworm os-release gets reported as the
      // operator's RHEL host, which is actively misleading.
      probeNote: container ? "container base image, not the host OS" : undefined,
    };
  } catch {
    return { id: "os:unknown", observedVersion: null, observedRaw: osRelease(), probeStatus: "undetectable", probeNote: `${plat} ${osRelease()}` };
  }
}

function probePgbouncer(): ObservedComponent {
  if (!isPgbouncerMode()) {
    return { id: "pgbouncer", observedVersion: null, observedRaw: null, probeStatus: "absent" };
  }
  // The version needs SHOW VERSION on the admin console (port 6432, the
  // `pgbouncer` database, an admin user) — credentials Polaris does not hold,
  // on a host it may not even share. Say so rather than guessing.
  return {
    id: "pgbouncer",
    observedVersion: null,
    observedRaw: null,
    probeStatus: "undetectable",
    probeNote: "PgBouncer is in use but its version is not readable from Polaris — confirm the 1.21+ floor by hand",
  };
}

function probeNode(): ObservedComponent {
  return {
    id: "node",
    observedVersion: process.versions.node,
    observedRaw: process.version,
    probeStatus: "ok",
  };
}

function probePrisma(): ObservedComponent {
  // The generated client states its own version — in memory, no node_modules
  // walk and no dependence on how the process was launched.
  const v = prismaVersion?.client ?? null;
  return {
    id: "prisma",
    observedVersion: v,
    observedRaw: v ? `Prisma Client ${v}` : null,
    probeStatus: v ? "ok" : "undetectable",
  };
}

/**
 * Observe the whole stack. Never throws; never runs a per-asset query.
 */
export async function observePlatformStack(): Promise<ObservedComponent[]> {
  const settled = await Promise.allSettled([
    probePostgres(),
    probeGo(),
    probeJava(),
    probeNginx(),
  ]);

  const async: ObservedComponent[] = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          id: ["postgres", "go", "java", "nginx"][i]!,
          observedVersion: null,
          observedRaw: null,
          probeStatus: "error" as ProbeStatus,
          probeNote: String((r as PromiseRejectedResult).reason),
        },
  );

  return [probeNode(), ...async, probeTimescale(), probeOs(), probePgbouncer(), probePrisma()];
}

// ─── Assembly ─────────────────────────────────────────────────────────

export interface LifecycleComponent extends ObservedComponent {
  label: string;
  kind: string;
  policy: string;
  securityExposed: boolean;
  polarisMinimum: string | null;
  polarisTarget: string | null;
  targetTrackEolAt: string | null;
  confidence: string;
  source: string;
  notes?: string;
  playbook: PlatformPlaybook | null;
  grade: LifecycleGrade;
}

export interface PlatformLifecycleResult {
  computedAt: string;
  datasetReviewedAt: string | null;
  datasetError: string | null;
  severity: LifecycleSeverity;
  components: LifecycleComponent[];
  /** Versions worth showing that have no upstream lifecycle to grade. */
  informational: Array<{ id: string; label: string; version: string }>;
}

const MEMO_TTL_MS = 6 * 60 * 60 * 1000;
let memo: { at: number; value: PlatformLifecycleResult } | null = null;

/** Test seam: drop the memoized result. */
export function _resetLifecycleMemo(): void {
  memo = null;
}

/**
 * The whole answer. Memoized for six hours; pass `force` to bypass (the
 * Refresh button and the daily job do).
 *
 * Never throws — a broken dataset comes back as `datasetError` with an empty
 * component list, so every caller (including the capacity snapshot) keeps
 * working.
 */
export async function getPlatformLifecycle(opts: { force?: boolean } = {}): Promise<PlatformLifecycleResult> {
  if (!opts.force && memo && Date.now() - memo.at < MEMO_TTL_MS) return memo.value;

  const now = new Date();
  const base: PlatformLifecycleResult = {
    computedAt: now.toISOString(),
    datasetReviewedAt: null,
    datasetError: null,
    severity: "none",
    components: [],
    informational: [],
  };

  let dataset: PlatformEolDataset;
  try {
    dataset = loadPlatformEolDataset();
  } catch (err: any) {
    logger.warn({ err }, "platform lifecycle dataset unreadable; card will render an error");
    const value = { ...base, datasetError: err?.message ?? "dataset could not be read" };
    memo = { at: Date.now(), value };
    return value;
  }

  let observed: ObservedComponent[] = [];
  try {
    observed = await observePlatformStack();
  } catch (err: any) {
    // observePlatformStack is written not to throw; this is belt and braces.
    logger.warn({ err }, "platform stack observation failed wholesale");
  }

  const byId = new Map(observed.map((o) => [o.id, o]));
  const playbooks = new Map(dataset.playbooks.map((p) => [p.id, p]));
  const components: LifecycleComponent[] = [];

  for (const tech of dataset.technologies) {
    const obs = byId.get(tech.id);
    if (!obs) continue; // dataset knows about something this host never reports
    const installed = obs.probeStatus !== "absent";
    const grade = gradeComponent(tech, obs.observedVersion, now, { installed });
    const targetRow = tech.polarisTarget ? tech.tracks.find((t) => t.track === tech.polarisTarget) : undefined;
    components.push({
      ...obs,
      label: tech.label,
      kind: tech.kind,
      policy: tech.policy,
      securityExposed: tech.securityExposed,
      polarisMinimum: tech.polarisMinimum ?? null,
      polarisTarget: tech.polarisTarget ?? null,
      targetTrackEolAt: targetRow?.eol ?? null,
      confidence: tech.confidence,
      source: tech.source,
      notes: tech.notes,
      playbook: tech.upgradePlaybook ? playbooks.get(tech.upgradePlaybook) ?? null : null,
      grade,
    });
  }

  // Anything the host reported that the dataset has no entry for still belongs
  // on the card — an unrecognized OS is worth seeing, not hiding.
  for (const obs of observed) {
    if (dataset.technologies.some((t) => t.id === obs.id)) continue;
    if (!obs.id.startsWith("os:")) continue;
    components.push({
      ...obs,
      label: "Operating system",
      kind: "os",
      policy: "none",
      securityExposed: true,
      polarisMinimum: null,
      polarisTarget: null,
      targetTrackEolAt: null,
      confidence: "vendor",
      source: "",
      notes: "This host's OS is not in the lifecycle dataset — add it if Polaris is meant to support it.",
      playbook: null,
      grade: {
        state: "unknown",
        severity: "none",
        track: null,
        eolAt: null,
        activeSupportEndsAt: null,
        extendedSupportUntil: null,
        daysUntilEol: null,
      },
    });
  }

  const informational = [
    { id: "polaris", label: "Polaris", version: getAppVersion() },
    { id: "polaris-agent", label: "Polaris Agent (source)", version: getAgentVersion() },
  ];

  const value: PlatformLifecycleResult = {
    ...base,
    datasetReviewedAt: dataset.reviewedAt,
    severity: maxSeverity(components.map((c) => c.grade.severity)),
    components,
    informational,
  };
  memo = { at: Date.now(), value };
  return value;
}
