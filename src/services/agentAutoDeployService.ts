/**
 * src/services/agentAutoDeployService.ts
 *
 * Discovery-time auto-deploy of the Polaris Agent to newly-discovered,
 * agent-less workstations / servers found by the AD and Entra integrations.
 * Opt-in per class (workstationMonitor.agentDeploy / serverMonitor.agentDeploy);
 * default OFF. When enabled, the post-sync pass in runDiscovery
 * (integrations.ts) calls runAutoDeployForClass for each class.
 *
 * SAFETY — this pushes deployed code to production endpoints over SSH/WinRM:
 *   • Opt-in, default off. A prominent UI warning tells operators to test on a
 *     small OU first; a human must review rollout scope before enabling fleet-
 *     wide.
 *   • Bounded: each run kicks off at most `maxConcurrent` NEW installs per
 *     class (minus whatever is still in-flight for that class), and never more
 *     than RUN_CEILING. The rest are picked up on subsequent discovery cycles
 *     — paced rollout, not a single fan-out.
 *   • Idempotent: an asset is eligible only when it has NO ManagedAgent row
 *     (the `assetId @unique` guard). Once a row exists — pending, active, or
 *     even failed — auto-deploy never touches it again (a failed install is the
 *     operator's to retry via the manual /reinstall path), so re-running
 *     discovery never re-kicks the same device.
 *
 * The actual install reuses the manual path's machinery: we create the
 * ManagedAgent row exactly as POST /assets/:id/agent/install does, then call
 * the fire-and-forget startInstall(). Platform is inferred from the device OS;
 * arch defaults to amd64 (the Asset row carries no architecture signal, and
 * enrollment re-validates platform/arch and fails the row on mismatch — a wrong
 * guess is caught safely, not silently accepted).
 */

import { prisma } from "../db.js";
import { logEvent } from "./eventLogService.js";
import { logger } from "../utils/logger.js";
import { getCredential } from "./credentialService.js";
import { assetSourceKindFromIntegrationType, isPollingMethodCompatible } from "../utils/pollingCompatibility.js";

// Hard cap on installs kicked off per class per discovery run. maxConcurrent
// (≤20) is normally the binding limit; this is a backstop so a first-ever AD
// discovery enumerating thousands of computer objects can't fan out unbounded
// even if an operator sets maxConcurrent high.
const RUN_CEILING = 200;

// installStatuses that count as "an install is in progress for this asset".
// Used both to compute the in-flight throttle and (via the no-ManagedAgent
// eligibility filter) to guarantee idempotency.
const INFLIGHT_STATUSES = ["pending", "uploading", "enrolling"];

// Single source of truth for the platform union is the install-script
// catalog (this file re-exports it for its existing importers).
import type { AgentOsPlatform } from "./agentInstallScripts.js";
import { publicBaseUrl } from "../utils/publicUrl.js";
export type { AgentOsPlatform };
export type AgentTransport = "ssh" | "winrm";

export interface AgentDeployClassConfig {
  enabled: boolean;
  sshCredentialId?: string | null;
  winrmCredentialId?: string | null;
  maxConcurrent?: number;
}

/**
 * Infer the agent OS platform from a discovered OS string. Pure.
 * Windows → "windows"; macOS → "darwin"; everything else (incl. blank/unknown)
 * → "linux". Linux is the safe default — the only thing a wrong guess costs is
 * a failed enrollment (re-validated server-side), and most non-Windows/non-Mac
 * managed hosts are Linux.
 */
export function inferAgentPlatform(os: string | null | undefined): AgentOsPlatform {
  const s = (os || "").toLowerCase();
  if (/windows|win32|win64|microsoft/.test(s)) return "windows";
  if (/\bmac|darwin|os\s?x|macos/.test(s)) return "darwin";
  return "linux";
}

export interface DeployTarget {
  osPlatform: AgentOsPlatform;
  transport: AgentTransport;
  credentialId: string;
}

/**
 * Resolve the transport + credential for a device given its platform and the
 * class's deploy config. Pure. Returns a skip reason when no usable credential
 * is configured for the inferred platform:
 *   • windows → WinRM credential preferred, else SSH (Windows-via-OpenSSH).
 *   • darwin / linux → SSH only.
 */
export function pickTransportAndCredential(
  osPlatform: AgentOsPlatform,
  cfg: AgentDeployClassConfig,
): DeployTarget | { skip: string } {
  const ssh = cfg.sshCredentialId || null;
  const winrm = cfg.winrmCredentialId || null;
  if (osPlatform === "windows") {
    if (winrm) return { osPlatform, transport: "winrm", credentialId: winrm };
    if (ssh)   return { osPlatform, transport: "ssh",   credentialId: ssh };
    return { skip: "no WinRM or SSH credential configured for Windows hosts" };
  }
  // darwin / linux
  if (ssh) return { osPlatform, transport: "ssh", credentialId: ssh };
  return { skip: `no SSH credential configured for ${osPlatform} hosts` };
}

/**
 * Run-level preconditions (shared across both classes of one integration):
 * HTTPS must be running (cert fingerprint to pin) and Polaris must know a
 * callback URL to stamp into agent.conf. Mirrors the checks the manual install
 * route does, but evaluated ONCE before any row is created so a misconfigured
 * server skips the whole pass with a single warning instead of minting dozens
 * of ManagedAgent rows that will all fail enrollment.
 */
export async function checkAutoDeployPreconditions(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { getServerCertFingerprint, getServerCertHostnames } = await import("./certInfo.js");
  const fingerprint = getServerCertFingerprint();
  if (!fingerprint) {
    return { ok: false, reason: "HTTPS is not running — agent install requires TLS for the cert pin" };
  }
  if (!publicBaseUrl() && !process.env.POLARIS_PUBLIC_HOST) {
    const hosts = getServerCertHostnames();
    const certHost = hosts?.dnsSans[0] || hosts?.cn || hosts?.ipSans[0] || null;
    if (!certHost || certHost === "localhost" || certHost === "127.0.0.1" || certHost === "::1") {
      return { ok: false, reason: "no callback URL — set POLARIS_PUBLIC_URL or a cert CN/SAN matching the Polaris hostname" };
    }
  }
  return { ok: true };
}

export interface AutoDeployResult {
  eligible: number;   // agent-less devices of this class found (pre-slot)
  kicked: number;     // installs actually kicked off this run
  skipped: number;    // devices skipped (unreachable / no matching credential)
  deferred: number;   // eligible-but-slot-limited; will retry next cycle
}

/**
 * Auto-deploy the agent to agent-less devices of one class for one integration.
 * Assumes preconditions already passed. Bounded by maxConcurrent (minus
 * in-flight) and RUN_CEILING; emits per-asset + summary Events.
 */
export async function runAutoDeployForClass(opts: {
  integrationId: string;
  integrationName: string;
  integrationType: string;
  klass: "workstation" | "server" | "virtual_machine";
  assetType: string;
  cfg: AgentDeployClassConfig;
  actor: string;
}): Promise<AutoDeployResult> {
  const { integrationId, integrationName, integrationType, klass, assetType, cfg, actor } = opts;
  const empty: AutoDeployResult = { eligible: 0, kicked: 0, skipped: 0, deferred: 0 };
  if (!cfg?.enabled) return empty;

  // Agent must be compatible with this integration's source kind (AD/Entra are).
  const sourceKind = assetSourceKindFromIntegrationType(integrationType);
  if (!isPollingMethodCompatible(sourceKind, "agent")) return empty;

  const maxConcurrent = Math.max(1, Math.min(20, cfg.maxConcurrent ?? 4));

  // Steady-state in-flight throttle: how many installs are already in progress
  // for this integration+class. Across cycles this is usually ~0 (prior batch
  // finished hours ago); within a run it bounds simultaneous SSH/WinRM work.
  const inflight = await prisma.managedAgent.count({
    where: {
      installStatus: { in: INFLIGHT_STATUSES },
      asset: { discoveredByIntegrationId: integrationId, assetType: assetType as any },
    },
  });
  const slots = Math.max(0, Math.min(maxConcurrent - inflight, RUN_CEILING));

  // Eligible = this integration's assets of this class with NO ManagedAgent row.
  // `take` bounds the scan at 2000-asset fleets; we only need up to RUN_CEILING.
  const candidates = await prisma.asset.findMany({
    where: {
      discoveredByIntegrationId: integrationId,
      assetType: assetType as any,
      managedAgent: { is: null },
    },
    select: { id: true, hostname: true, dnsName: true, ipAddress: true, os: true },
    take: RUN_CEILING,
  });
  if (candidates.length === 0) return empty;

  const { getServerCertFingerprint } = await import("./certInfo.js");
  const fingerprint = getServerCertFingerprint();
  if (!fingerprint) return empty; // precondition rechecked defensively

  const { startInstall } = await import("./agentInstallService.js");

  let kicked = 0;
  let skipped = 0;
  let eligible = 0;
  for (const a of candidates) {
    // Reachability: prefer routable IP, fall back to DNS / hostname (AD objects
    // often have no IP). startInstall resolves the same order; skip — never
    // fail — when none resolve, so unreachable rows don't pile up as failures.
    const host = a.ipAddress || a.dnsName || a.hostname || "";
    if (!host) {
      skipped += 1;
      await logEvent({ action: "agent.autodeploy.skipped", resourceType: "asset", resourceId: a.id, actor, level: "info", message: `Agent auto-deploy skipped (${klass}) — no IP / DNS / hostname to reach the device`, details: { integrationId, class: klass } }).catch(() => {});
      continue;
    }
    const osPlatform = inferAgentPlatform(a.os);
    const target = pickTransportAndCredential(osPlatform, cfg);
    if ("skip" in target) {
      skipped += 1;
      await logEvent({ action: "agent.autodeploy.skipped", resourceType: "asset", resourceId: a.id, actor, level: "info", message: `Agent auto-deploy skipped (${klass}) — ${target.skip}`, details: { integrationId, class: klass, osPlatform } }).catch(() => {});
      continue;
    }
    // Credential must exist + match the transport.
    const cred = await getCredential(target.credentialId).catch(() => null);
    if (!cred || cred.type !== target.transport) {
      skipped += 1;
      await logEvent({ action: "agent.autodeploy.skipped", resourceType: "asset", resourceId: a.id, actor, level: "info", message: `Agent auto-deploy skipped (${klass}) — credential missing or type mismatch (need "${target.transport}")`, details: { integrationId, class: klass } }).catch(() => {});
      continue;
    }

    eligible += 1;
    if (kicked >= slots) continue; // slot-limited — picked up next cycle

    try {
      const row = await prisma.managedAgent.create({
        data: {
          assetId:               a.id,
          osPlatform,
          arch:                  "amd64",
          installedBy:           actor,
          installStatus:         "pending",
          serverCertFingerprint: fingerprint,
          installCredentialId:   target.credentialId,
          installTransport:      target.transport,
        },
      });
      await startInstall({ managedAgentId: row.id, credentialId: target.credentialId });
      kicked += 1;
      await logEvent({ action: "agent.autodeploy.kickoff", resourceType: "asset", resourceId: a.id, actor, level: "info", message: `Polaris Agent auto-deploy kicked off (${klass}, ${osPlatform}/amd64, ${target.transport}) for "${a.hostname || host}"`, details: { integrationId, class: klass, managedAgentId: row.id, transport: target.transport } }).catch(() => {});
    } catch (err: any) {
      // A unique-constraint race (a manual install landed between the findMany
      // and the create) lands here — treat as skip, not failure.
      skipped += 1;
      logger.warn({ err, assetId: a.id, integrationId }, "agent auto-deploy create/kickoff failed");
    }
  }

  const deferred = Math.max(0, eligible - kicked);
  await logEvent({
    action:       "agent.autodeploy.batch",
    resourceType: "integration",
    resourceId:   integrationId,
    resourceName: integrationName,
    actor,
    level:        "info",
    message:      `Agent auto-deploy (${klass}) for "${integrationName}" — ${kicked} kicked, ${skipped} skipped, ${deferred} deferred to next cycle`,
    details:      { class: klass, kicked, skipped, deferred, inflight, maxConcurrent },
  }).catch(() => {});

  return { eligible, kicked, skipped, deferred };
}
