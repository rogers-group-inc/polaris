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

// ─── Capacity-snapshot reasons ────────────────────────────────────────

/** The shape capacityService's CapacityReason expects. Kept structural to
 *  avoid importing capacityService here and creating a module cycle. */
export interface LifecycleCapacityReason {
  severity: "watch" | "warning" | "critical";
  code: string;
  message: string;
  suggestion: string;
  family: string;
}

/**
 * All lifecycle rows share ONE family, deliberately.
 *
 * collapseReasonsByFamily keeps the highest-severity row per family and merges
 * the suppressed rows' suggestions onto the winner. So an install on EOL
 * PostgreSQL *and* near-EOL Node produces one capacity row — the PostgreSQL
 * problem, with the Node remediation appended — and the full per-technology
 * breakdown lives on the Platform Lifecycle card, where it belongs.
 *
 * Per-technology families would let a neglected install push four rows into the
 * Database card and four entries into every capacity.severity_changed Event's
 * details. The honest cost of one family is that it understates breadth, which
 * is why the winning message says how many others need attention.
 */
export const LIFECYCLE_REASON_FAMILY = "platform_lifecycle";

/**
 * Turn a lifecycle result into capacity reasons.
 *
 * Two rules that matter more than they look:
 *
 * `watch` rows NEVER reach here. "Node 20 goes end-of-life in five months" is
 * real but not yet actionable, and writing it into the capacity snapshot would
 * fire a severity-transition Event on every restart. That is the noise that
 * teaches operators to ignore the channel.
 *
 * Upstream EOL is capped at `warning` via the grader's capacitySeverityCap,
 * even when the component grades critical. It stays red on the card, still
 * fires an error-level Event and still emails — but it cannot hold the
 * non-dismissible sidebar alert open for the months between "PostgreSQL went
 * EOL" and "we booked the window". `below_minimum` is uncapped and does reach
 * that alert, because it is a misconfiguration of this install and one package
 * command from fixed.
 */
export function lifecycleCapacityReasons(result: PlatformLifecycleResult): LifecycleCapacityReason[] {
  const actionable = result.components.filter(
    (c) => c.grade.severity === "warning" || c.grade.severity === "critical",
  );
  if (actionable.length === 0) return [];

  const rank = { warning: 1, critical: 2 } as const;
  const sorted = [...actionable].sort(
    (a, b) =>
      (rank[b.grade.severity as "warning" | "critical"] ?? 0) -
      (rank[a.grade.severity as "warning" | "critical"] ?? 0),
  );

  return sorted.map((c, i) => {
    const g = c.grade;
    const cap = g.capacitySeverityCap;
    const severity = (cap && rank[g.severity as "warning" | "critical"] > rank[cap]
      ? cap
      : g.severity) as "warning" | "critical";

    let code: string;
    let message: string;
    let suggestion: string;
    const target = c.polarisTarget
      ? `Move to ${c.label} ${c.polarisTarget}${c.targetTrackEolAt ? ` (supported through ${c.targetTrackEolAt})` : ""}.`
      : `Plan an upgrade.`;

    if (g.state === "below_minimum") {
      code = "platform_below_minimum";
      message = `${c.label} ${c.observedVersion ?? g.track ?? "(unknown)"} is below Polaris's minimum (${c.label} ${c.polarisMinimum}).`;
      suggestion = `Upgrade the runtime on this host. ${target}`;
    } else if (g.state === "eol" || g.state === "eol_extended") {
      code = "platform_eol";
      const extended = g.state === "eol_extended" && g.extendedSupportUntil
        ? ` Extended support runs to ${g.extendedSupportUntil}.`
        : "";
      message = `${c.label} ${g.track} reached end of life on ${g.eolAt} (no further security patches).${extended}`;
      suggestion = target;
    } else {
      code = "platform_eol_approaching";
      const days = g.daysUntilEol ?? 0;
      message = `${c.label} ${g.track} reaches end of life in ${days} day${days === 1 ? "" : "s"} (${g.eolAt}).`;
      suggestion = target;
    }

    // The collapse pass merges suggestions but not messages, so the winner has
    // to carry the breadth itself or the card understates the problem.
    if (i === 0 && sorted.length > 1) {
      const others = sorted.length - 1;
      message += ` (+${others} other platform component${others === 1 ? "" : "s"} need${others === 1 ? "s" : ""} attention — see Platform Lifecycle.)`;
    }

    return { severity, code, message, suggestion, family: LIFECYCLE_REASON_FAMILY };
  });
}

// ─── Transition recording ─────────────────────────────────────────────

export const LIFECYCLE_STATE_SETTING_KEY = "platformLifecycle.lastState";
export const LIFECYCLE_CHANGED_ACTION = "platform.lifecycle_changed";
export const LIFECYCLE_RECOVERED_ACTION = "platform.lifecycle_recovered";

interface StoredLifecycleState {
  severity: LifecycleSeverity;
  /** Sorted `id:track:state` join over every non-ok component. */
  fingerprint: string;
  recordedAt: string;
}

const SEVERITY_RANK: Record<LifecycleSeverity, number> = { none: 0, watch: 1, warning: 2, critical: 3 };

/**
 * A stable signature of "what is wrong right now".
 *
 * Severity alone is not enough, and that is the whole reason this exists: an
 * install already at `warning` for "Node approaching EOL" that then also goes
 * EOL on PostgreSQL stays at `warning`, so a severity-only comparison would
 * never tell anyone about the second problem.
 */
export function lifecycleFingerprint(result: PlatformLifecycleResult): string {
  return result.components
    .filter((c) => c.grade.severity !== "none")
    .map((c) => `${c.id}:${c.grade.track ?? "-"}:${c.grade.state}`)
    .sort()
    .join("|");
}

async function readStoredLifecycleState(): Promise<StoredLifecycleState | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: LIFECYCLE_STATE_SETTING_KEY } });
    const v = row?.value as Partial<StoredLifecycleState> | null;
    if (!v || !v.severity) return null;
    return {
      severity: v.severity,
      fingerprint: v.fingerprint ?? "",
      recordedAt: v.recordedAt ?? new Date(0).toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Compare the current lifecycle state against the last recorded one and emit an
 * Event when it has changed. Structural copy of capacityService's
 * recordCapacityTransition, including its single-Setting-row approach — there is
 * no table here, because the only state that must survive a restart is "what
 * did we last tell the operator".
 *
 * Called ONLY by the daily job, never by the route. A lifecycle condition is
 * true for months, so re-firing it on every page load would spam the on-call
 * inbox; disk pressure is minutes-volatile and earns the opposite treatment.
 */
export async function recordPlatformLifecycleTransition(result: PlatformLifecycleResult): Promise<void> {
  try {
    const fingerprint = lifecycleFingerprint(result);
    const prior = await readStoredLifecycleState();

    // Fire on a change of severity OR fingerprint — see lifecycleFingerprint.
    if (prior && prior.severity === result.severity && prior.fingerprint === fingerprint) return;

    const direction = !prior
      ? "initial"
      : SEVERITY_RANK[result.severity] > SEVERITY_RANK[prior.severity]
        ? "escalated"
        : SEVERITY_RANK[result.severity] < SEVERITY_RANK[prior.severity]
          ? "recovered"
          : "changed";

    const actionable = result.components.filter(
      (c) => c.grade.severity === "warning" || c.grade.severity === "critical",
    );
    const headline = actionable.length > 0 ? actionable[0] : null;

    // A distinct recovery action, rather than one action for both. The
    // notification layer's event-mode reset accepts only actionPattern and
    // resourceType — no detailsMatch — so a single-action design would have its
    // reset match its own escalation and self-clear immediately. That is why
    // the capacity rule settled for a timed reset; emitting two actions costs
    // nothing and makes the automation genuinely self-clearing on an upgrade.
    const recovered = result.severity === "none" && direction === "recovered";
    const action = recovered ? LIFECYCLE_RECOVERED_ACTION : LIFECYCLE_CHANGED_ACTION;

    const level = recovered
      ? "info"
      : result.severity === "critical"
        ? "error"
        : result.severity === "none"
          ? "info"
          : "warning";

    const message = !prior
      ? `Platform lifecycle baseline established at ${result.severity}.`
      : recovered
        ? "Every platform component is back within its supported life."
        : headline
          ? `Platform lifecycle ${prior.severity} → ${result.severity}: ${headline.label} ${headline.grade.track ?? ""} is ${headline.grade.state.replace(/_/g, " ")}.`
          : `Platform lifecycle ${prior.severity} → ${result.severity}.`;

    const { logEvent } = await import("./eventLogService.js");
    await logEvent({
      action,
      level,
      resourceType: "system",
      resourceName: "Polaris server",
      actor: "system",
      message,
      details: {
        from: prior?.severity ?? null,
        to: result.severity,
        direction,
        datasetReviewedAt: result.datasetReviewedAt,
        components: result.components
          .filter((c) => c.grade.severity !== "none")
          .map((c) => ({
            id: c.id,
            label: c.label,
            observedVersion: c.observedVersion,
            track: c.grade.track,
            state: c.grade.state,
            severity: c.grade.severity,
            eolAt: c.grade.eolAt,
            daysUntilEol: c.grade.daysUntilEol,
          })),
      },
    });

    const value: StoredLifecycleState = {
      severity: result.severity,
      fingerprint,
      recordedAt: new Date().toISOString(),
    };
    await prisma.setting.upsert({
      where: { key: LIFECYCLE_STATE_SETTING_KEY },
      update: { value: value as any },
      create: { key: LIFECYCLE_STATE_SETTING_KEY, value: value as any },
    });
  } catch (err) {
    // Best-effort: never let the transition record break the caller.
    logger.warn({ err }, "failed to record platform lifecycle transition");
  }
}

/** How old a stored state may be before the watch job runs again. */
export const LIFECYCLE_WATCH_MIN_AGE_MS = 20 * 60 * 60 * 1000;

/** True when the stored state is fresh enough that the job should skip. */
export async function lifecycleStateIsFresh(now = Date.now()): Promise<boolean> {
  const prior = await readStoredLifecycleState();
  if (!prior) return false;
  const age = now - Date.parse(prior.recordedAt);
  return Number.isFinite(age) && age >= 0 && age < LIFECYCLE_WATCH_MIN_AGE_MS;
}
