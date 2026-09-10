/**
 * src/services/agentInstallService.ts — Polaris Agent remote install / uninstall
 *
 * Connects to a target host via the operator's stored SSH or WinRM
 * credential, uploads the platform-matched agent binary + a generated
 * agent.conf, and runs the embedded installer script to register the
 * agent as a system service (systemd on Linux, launchd on macOS, Windows
 * Service on Windows). Uninstall is the mirror — stop service, remove
 * unit/plist/service definition, remove binary + config.
 *
 * This is the FIRST time Polaris executes remote commands. The existing
 * `monitoringService.probeSsh` / `probeWinRm` only authenticate; they
 * don't carry out arbitrary work. The helpers here extend `ssh2` with
 * SFTP upload + remote exec, and (Phase 4b) extend the WinRM SOAP code
 * with WinRS Send-File + Invoke-Command.
 *
 * Lifecycle as it threads through this service (see ManagedAgent
 * comment block in schema.prisma for the full state machine):
 *
 *   startInstall:
 *     pending → uploading (binary + script copied) →
 *     enrolling (installer started on host; awaits the agent's first
 *                POST /api/v1/agents/enroll) → active (set by /enroll)
 *
 *   startUninstall:
 *     active → uninstalling → (row hard-deleted on success, or
 *                              uninstall_failed if remote work errored)
 *
 * Phase 4a scope: SSH path complete (Linux + macOS). WinRM path returns
 * a clear "not yet supported in this release" error. Phase 4b adds the
 * Windows path.
 */

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
import { AGENT_BIN_DIR } from "../utils/paths.js";
import { linuxServiceBlock, normalizePrivilegeTier, type AgentPrivilegeTier } from "../utils/agentUnit.js";
import { getCredential } from "./credentialService.js";
import { mintEnrollmentToken } from "./agentTokenService.js";
import { logEvent } from "./eventLogService.js";
import { truncate } from "../utils/text.js";
import { winrmRunOne, type WinRmConnection } from "../utils/winrm.js";
import { withSshClient, sshExec, sftpPut } from "../utils/remoteExec.js";
import { getPublicUrlPort } from "../utils/publicUrl.js";
import { getServerCertHostnames, getServerCertFingerprint } from "./certInfo.js";
import { assetSourceKindFromIntegrationType, isPollingMethodCompatible } from "../utils/pollingCompatibility.js";
import {
  inferAgentPlatform,
  pickTransportAndCredential,
  checkAutoDeployPreconditions,
  type AgentTransport,
} from "./agentAutoDeployService.js";
import { resolveInstallScriptId, type AgentOsPlatform } from "./agentInstallScripts.js";
import {
  getOnboardingState,
  type SshOnboardingPlatform,
} from "./windowsSshOnboardingService.js";

// ─── Public entry points ──────────────────────────────────────────────

export interface StartInstallInput {
  managedAgentId: string;
  credentialId:   string;
  hostOverride?:  string; // optional — defaults to Asset.ipAddress / dnsName / hostname
  /** Path-resolution hooks for tests; pass nothing in production. */
  testOverrides?: TestOverrides;
}

export interface StartUninstallInput {
  managedAgentId: string;
  credentialId:   string;
  hostOverride?:  string;
  testOverrides?: TestOverrides;
}

interface TestOverrides {
  /** Skip the actual SSH connect — return success immediately. Tests only. */
  fakeSshSucceed?: boolean;
  /** Skip the actual SSH connect — fail with this error. Tests only. */
  fakeSshFail?:    string;
}

/**
 * Fire-and-forget install kickoff. Returns immediately; the actual
 * SSH/WinRM work runs in the background and transitions installStatus
 * as it makes progress.
 *
 * The caller already created the ManagedAgent row in `pending` and
 * minted an enrollment token via the route handler. We pick up from
 * there: load the row, resolve the credential, copy binary + conf,
 * exec the installer, and stamp installStatus="enrolling" so the
 * agent's first POST /enroll (which flips it to "active") closes the
 * loop. Failures land in installStatus="failed" with installError set.
 */
export async function startInstall(input: StartInstallInput): Promise<void> {
  setImmediate(() => runInstall(input).catch((err) => {
    // Defensive — runInstall already captures errors into installError,
    // but anything escaping that path lands here.
    logger.error({ err, managedAgentId: input.managedAgentId }, "Agent install crashed unexpectedly");
  }));
}

/**
 * Fire-and-forget uninstall kickoff. Synchronous half (bearer revoke)
 * is done by the calling route — this picks up after revoke and does
 * the remote cleanup.
 */
export async function startUninstall(input: StartUninstallInput): Promise<void> {
  setImmediate(() => runUninstall(input).catch((err) => {
    logger.error({ err, managedAgentId: input.managedAgentId }, "Agent uninstall crashed unexpectedly");
  }));
}

/**
 * Statuses an upgrade may be kicked off from. `active` is the healthy case.
 *
 * `upgrade_failed` is here because it means "the OLD binary is still running":
 * every failure path leaves `agent.conf` untouched and either never reached
 * the host or refused before swapping the binary, so the row is exactly as
 * upgradeable as an active one. Excluding it made one unreachable moment
 * permanent — a laptop asleep during a fan-out dropped out of
 * `upgradeAllOutdated`'s filter (no later build ever retried it) AND out of
 * the per-asset retry (the panel's own "Retry Upgrade" button 409'd), leaving
 * uninstall/reinstall as the only way back onto the current agent.
 *
 * Everything else stays refused: the in-flight states (`pending`/`uploading`/
 * `enrolling`/`upgrading`/`uninstalling`) would race work already running on
 * the host, `failed` never completed an install to upgrade, and `revoked` has
 * no working bearer for the new binary to come back on.
 */
export const UPGRADEABLE_INSTALL_STATUSES = ["active", "upgrade_failed"] as const;

/** True when an agent in this installStatus can be sent an upgrade. */
export function canUpgradeFromStatus(status: string | null | undefined): boolean {
  return (UPGRADEABLE_INSTALL_STATUSES as readonly string[]).includes(status ?? "");
}

export interface StartUpgradeInput {
  managedAgentId: string;
  /** Operator override. Omitted, resolveUpgradeCredential uses the row's
   *  installCredentialId, falling back to the managed deployment credential. */
  credentialId?:  string;
  hostOverride?:  string;
  actor:          string; // username for audit trail
  testOverrides?: TestOverrides;
}

/** What an upgrade will actually connect with — see resolveUpgradeCredential. */
export interface ResolvedUpgradeCredential {
  credentialId:   string;
  credentialName: string;
  transport:      AgentTransport;
  /**
   * True when the credential did NOT come from the row — the row was stranded
   * (no usable `installCredentialId`) and we fell back to the Polaris-managed
   * SSH deployment credential. A successful upgrade writes the adoption back
   * onto the row; a failed one leaves it untouched.
   */
  adopted:        boolean;
}

/**
 * Decide which credential + transport an upgrade should use, healing rows that
 * can't answer for themselves.
 *
 * `ManagedAgent.installCredentialId` is written only at install time and its FK
 * is ON DELETE SET NULL, so a row loses its credential two ways: an admin
 * deleted the credential it installed with, or the install predates the column
 * (migration 20260514010000 added it with no backfill). Either way the row was
 * permanently un-upgradeable — `startUpgrade` threw BEFORE touching
 * `installStatus`, so the row stayed `active` + out-of-date and every
 * `upgradeAllOutdated` fan-out re-skipped it with no Event, no `installError`
 * and nothing on the asset panel. A host stranded this way sat on its original
 * binary forever while the rest of the fleet moved on.
 *
 * The fallback is the Polaris-managed SSH deployment credential (Integrations →
 * Polaris Agent → SSH Deployment). It exists precisely so Polaris can reach the
 * fleet without per-host credentials, and the onboarding script authorizes its
 * key on every host it runs on.
 *
 * **Transport follows the credential's TYPE, not the row.** For a healthy row
 * those always agree — the install routes refuse a credential whose `type`
 * doesn't match the chosen transport — so this changes nothing there. It is
 * what makes the fallback work at all: the managed credential is key-only, and
 * `installTransport` was backfilled to `winrm` for EVERY pre-2026-06-09 Windows
 * row (migration 20260609000000), so honoring the row would hand a passwordless
 * credential to `winrmConnectionFromCred` and die on "missing username or
 * password". Overriding is safe because the new transport is not persisted
 * until the upgrade succeeds: a host that really is WinRM-only fails to
 * connect, keeps its recorded transport, and lands as `upgrade_failed` with a
 * real reason — which is itself retryable.
 */
export async function resolveUpgradeCredential(
  row: { installCredentialId: string | null; installTransport: string; osPlatform: string },
  overrideCredentialId?: string,
): Promise<ResolvedUpgradeCredential> {
  const onRow = overrideCredentialId ?? row.installCredentialId ?? null;

  // An id that no longer resolves is treated as absent, not as an error: the
  // SetNull FK covers the deletion case, but a credential can also become
  // unreadable (secrets that won't decrypt), and the fallback is a better
  // answer than a refusal in both.
  let cred = onRow ? await getCredential(onRow).catch(() => null) : null;
  let adopted = false;

  if (!cred) {
    if (overrideCredentialId) {
      // An explicitly-passed id that doesn't resolve is an operator mistake —
      // say so instead of silently connecting with something else.
      throw new AppError(400, `Credential ${overrideCredentialId} not found`);
    }
    const managedId = await managedDeployCredentialIdFor(row.osPlatform);
    if (managedId) {
      cred = await getCredential(managedId).catch(() => null);
      adopted = !!cred;
    }
  }

  if (!cred) {
    throw new AppError(400,
      "No install credential on file for this agent, and no Polaris-managed SSH deployment " +
      "credential to fall back on. Generate a deployment keypair under Integrations → Polaris " +
      "Agent → SSH Deployment and run the onboarding script on this host, pass credentialId " +
      "explicitly, or force-remove the agent and reinstall.");
  }

  const transport: AgentTransport = cred.type === "winrm" ? "winrm" : "ssh";
  if (transport === "winrm" && row.osPlatform !== "windows") {
    throw new AppError(400,
      `Credential "${cred.name}" is WinRM, which is only valid for Windows hosts — ` +
      `this agent is ${row.osPlatform}.`);
  }

  return { credentialId: cred.id, credentialName: cred.name, transport, adopted };
}

/**
 * The managed deployment credential for a platform, or null when no keypair has
 * been generated. `getOnboardingState` already nulls an id whose credential was
 * deleted, so a dangling pointer reads as "none" rather than throwing here.
 *
 * darwin maps to the Linux credential: the SSH Deployment card is Windows +
 * Linux only, and both POSIX platforms take the same key. If that account isn't
 * on the Mac the connection simply fails — still better than the refusal, and
 * still retryable.
 */
async function managedDeployCredentialIdFor(osPlatform: string): Promise<string | null> {
  const platform: SshOnboardingPlatform = osPlatform === "windows" ? "windows" : "linux";
  try {
    const state = await getOnboardingState();
    return state.credentialIds[platform];
  } catch (err) {
    logger.warn({ err, osPlatform }, "Could not read SSH deployment onboarding state for upgrade fallback");
    return null;
  }
}

/**
 * Fire-and-forget upgrade kickoff. Refuses synchronously (throws) when
 * the agent is already at manifest.currentVersion, no binaries are staged,
 * the row isn't in an UPGRADEABLE_INSTALL_STATUSES state (so a previously
 * failed upgrade IS retryable from here), or no credential can be resolved
 * for it at all — `resolveUpgradeCredential` first tries the row's own
 * credential, then the managed SSH deployment credential, so "no install
 * credential on file" is no longer by itself a dead end. Otherwise transitions
 * installStatus → "upgrading" and dispatches
 * the platform-specific upgrade path. The agent's bearer + cert pin
 * survive — we don't touch agent.conf; only the binary is replaced.
 */
export async function startUpgrade(input: StartUpgradeInput): Promise<{ fromVersion: string | null; toVersion: string }> {
  const row = await prisma.managedAgent.findUnique({
    where: { id: input.managedAgentId },
    include: { asset: true },
  });
  if (!row) throw new AppError(404, "Managed agent not found");
  if (!canUpgradeFromStatus(row.installStatus)) {
    throw new AppError(409, `Agent installStatus is "${row.installStatus}"; only active or upgrade_failed agents can upgrade.`);
  }

  const manifest = await loadManifest();
  if (!manifest) {
    throw new AppError(400, "No agent binaries available — build them first.");
  }
  const binaryKey  = `${row.osPlatform}-${row.arch}`;
  const binaryName = manifest.binaries[binaryKey];
  if (!binaryName) {
    throw new AppError(400, `No agent binary for platform ${binaryKey}`);
  }
  if (row.agentVersion === manifest.currentVersion) {
    throw new AppError(409, `Agent is already at v${manifest.currentVersion}.`);
  }

  // Throws (before any state change) only when the row has no credential AND
  // there's no managed deployment credential to adopt.
  const resolved = await resolveUpgradeCredential(row, input.credentialId);

  // Sync-half: transition state + emit kickoff event. Then fire the
  // async runner. UI starts polling immediately and sees "upgrading".
  await prisma.managedAgent.update({
    where: { id: row.id },
    data:  { installStatus: "upgrading", installError: null },
  });
  await logEvent({
    action:       "agent.upgrade_kickoff",
    resourceType: "asset",
    resourceId:   row.assetId,
    actor:        input.actor,
    level:        "info",
    message:      resolved.adopted
      ? `Polaris Agent upgrade kicked off (${row.agentVersion ?? "unknown"} → ${manifest.currentVersion}) ` +
        `using the managed deployment credential "${resolved.credentialName}" — this agent had no install credential on file`
      : `Polaris Agent upgrade kicked off (${row.agentVersion ?? "unknown"} → ${manifest.currentVersion})`,
    details: {
      managedAgentId: row.id,
      credentialId:   resolved.credentialId,
      transport:      resolved.transport,
      adoptedCredential: resolved.adopted,
      fromVersion:    row.agentVersion ?? null,
      toVersion:      manifest.currentVersion,
      binaryFilename: binaryName,
    },
  });

  setImmediate(() =>
    runUpgrade({
      managedAgentId: row.id,
      resolved,
      hostOverride:   input.hostOverride,
      testOverrides:  input.testOverrides,
      actor:          input.actor,
    }).catch((err) => {
      logger.error({ err, managedAgentId: row.id }, "Agent upgrade crashed unexpectedly");
    }),
  );

  return { fromVersion: row.agentVersion ?? null, toVersion: manifest.currentVersion };
}

/**
 * Fan out `startUpgrade` to every ManagedAgent whose agentVersion lags the
 * current manifest and whose installStatus is upgradeable — "active" plus
 * "upgrade_failed", so a host that missed the last build's fan-out is picked
 * up by the next one rather than stranded. Bounded
 * concurrency (Promise pool of POOL_SIZE) — the SSH/WinRM connections
 * are the per-host bottleneck and higher parallelism risks tripping
 * concurrent-connection limits on the target hosts (Windows WinRM caps
 * at ~5 by default).
 *
 * Each per-agent upgrade goes through the regular state machine so
 * partial failures land naturally as `installStatus="upgrade_failed"`
 * per row + an `agent.upgrade_failed` Event; the operator sees them on
 * the Polaris Agent panel of the affected asset.
 *
 * Used by:
 *   - POST /server-settings/agents/upgrade-all (operator-initiated)
 *   - The post-build hook in agentBuildService.ts when the
 *     `agent.autoUpgradeOnNewBuild` Setting is enabled.
 *
 * Returns `{ eligible, queued }` so the caller can render a status line
 * to the operator (or log it on the system-initiated path).
 */
export interface UpgradeAllResult {
  eligible: number;
  queued:   number;
  perAsset: Array<{ assetId: string; managedAgentId: string; ok: boolean; error?: string }>;
}

export async function upgradeAllOutdated(actor: string): Promise<UpgradeAllResult> {
  const { getInventory } = await import("./agentBuildService.js");
  const inv = await getInventory();
  const currentVersion = inv.manifest?.currentVersion;
  if (!currentVersion) {
    return { eligible: 0, queued: 0, perAsset: [] };
  }
  const eligible = await prisma.managedAgent.findMany({
    where: {
      // Includes `upgrade_failed` (see UPGRADEABLE_INSTALL_STATUSES): a host
      // that missed one fan-out is retried by the next build instead of being
      // stranded on its old binary forever.
      installStatus: { in: [...UPGRADEABLE_INSTALL_STATUSES] },
      NOT: { agentVersion: currentVersion },
    },
    select: { id: true, assetId: true, agentVersion: true },
  });
  const perAsset: UpgradeAllResult["perAsset"] = [];
  const POOL_SIZE = 4;
  await mapWithConcurrency(eligible, POOL_SIZE, async (e) => {
    try {
      await startUpgrade({ managedAgentId: e.id, actor });
      perAsset.push({ assetId: e.assetId, managedAgentId: e.id, ok: true });
    } catch (err: any) {
      // startUpgrade throws BEFORE it touches installStatus, so a row that
      // refuses here leaves no trace of its own: it stays "active", stays
      // out-of-date, and gets re-skipped by every later fan-out. Until this
      // Event existed, a host stranded on an old binary was invisible unless
      // someone pressed Upgrade on it by hand. Record it against the asset so
      // it shows up where the operator already looks.
      const error = err?.message ?? String(err);
      logger.warn({ managedAgentId: e.id, assetId: e.assetId, err }, "Agent upgrade fan-out skipped a row");
      await logEvent({
        action:       "agent.upgrade_skipped",
        resourceType: "asset",
        resourceId:   e.assetId,
        actor,
        level:        "warning",
        message:      `Polaris Agent upgrade skipped (still on ${e.agentVersion ?? "an unknown version"}): ${error}`,
        details:      { managedAgentId: e.id, fromVersion: e.agentVersion ?? null, toVersion: currentVersion },
      }).catch(() => { /* best-effort — never fail the fan-out on the audit write */ });
      perAsset.push({ assetId: e.assetId, managedAgentId: e.id, ok: false, error });
    }
  });
  return {
    eligible: eligible.length,
    queued:   perAsset.filter((p) => p.ok).length,
    perAsset,
  };
}

// ─── Bulk install (assets-page bulk bar) ──────────────────────────────

// Concurrent remote installs in the bulk pool. Each install holds an SSH/SFTP
// or WinRM session and streams the agent binary, so this bounds outbound
// connection + bandwidth pressure the same way upgradeAllOutdated's POOL_SIZE
// bounds upgrades. Rows beyond the pool wait as installStatus="pending".
const BULK_INSTALL_POOL = 5;

export interface BulkInstallInput {
  assetIds:           string[];
  sshCredentialId?:   string | null;
  winrmCredentialId?: string | null;
  arch?:              "amd64" | "arm64";
  /** Operator-chosen install-method variant per OS (bulk spans mixed OSes, so
   *  the choice is keyed by platform). Omitted / null → the per-OS default. */
  scriptIds?:         Partial<Record<AgentOsPlatform, string | null>>;
  /** Linux privilege tier (ignored for Windows/darwin). "ptrace" grants
   *  CAP_SYS_PTRACE for Application Map connection attribution. Default
   *  "unprivileged". */
  privilegeTier?:     AgentPrivilegeTier;
  actor:              string;
}

export interface BulkInstallResult {
  requested: number;
  kicked:    number;
  skipped:   Array<{ assetId: string; hostname: string | null; reason: string }>;
}

/**
 * Operator-initiated bulk agent install — the assets-page bulk bar's "Deploy
 * Agent" action. Applies the same eligibility rules as the manual
 * POST /assets/:id/agent/install route per asset (source-kind compatibility,
 * no hypervisors, no existing ManagedAgent row, reachable host) but resolves
 * OS platform + transport automatically the way discovery auto-deploy does:
 * inferAgentPlatform(asset.os), Windows → WinRM credential (SSH fallback),
 * linux/darwin → SSH credential. Ineligible assets are reported back as
 * skipped with a reason — never an error for the whole batch.
 *
 * ManagedAgent rows are created synchronously (the UI immediately shows
 * "pending" on every kicked asset); the remote installs then run in a
 * background pool of BULK_INSTALL_POOL so a large selection can't fan out
 * hundreds of simultaneous SSH/SFTP sessions. Per-row failures land as
 * installStatus="failed" + installError via the normal state machine.
 *
 * Scale note: one findMany bounded by the route's ids cap + one create per
 * eligible asset. A one-shot operator action, not a ticking job.
 */
export async function bulkInstallAgents(input: BulkInstallInput): Promise<BulkInstallResult> {
  const arch = input.arch ?? "amd64";
  const actor = input.actor;

  // Run-level preconditions, checked ONCE so a misconfigured server fails the
  // whole request with one clear error instead of N identical skips.
  const pre = await checkAutoDeployPreconditions();
  if (!pre.ok) throw new AppError(400, `Cannot deploy agents — ${pre.reason}`);
  const fingerprint = getServerCertFingerprint();
  if (!fingerprint) throw new AppError(400, "HTTPS is not running — agent install requires TLS for the cert pin");
  const manifest = await loadManifest();
  if (!manifest) throw new AppError(400, "No agent binaries available — build them first (Server Settings → Maintenance → Polaris Agent).");

  // Credentials validated up front (type must match what they'll be used
  // for); pickTransportAndCredential below decides which applies per asset.
  const deployCfg = {
    enabled: true,
    sshCredentialId: input.sshCredentialId ?? null,
    winrmCredentialId: input.winrmCredentialId ?? null,
  };
  if (!deployCfg.sshCredentialId && !deployCfg.winrmCredentialId) {
    throw new AppError(400, "Provide at least one credential (SSH and/or WinRM)");
  }
  for (const [id, type] of [
    [deployCfg.sshCredentialId, "ssh"],
    [deployCfg.winrmCredentialId, "winrm"],
  ] as const) {
    if (!id) continue;
    const cred = await getCredential(id).catch(() => null);
    if (!cred) throw new AppError(400, `Credential ${id} not found`);
    if (cred.type !== type) {
      throw new AppError(400, `Credential "${cred.name}" is type "${cred.type}" — need a "${type}" credential`);
    }
  }

  // Validate any operator-chosen install-script variants up front (batch-level
  // error, like the credential checks above). Each slot's id is OS-locked to
  // its own key, so a windows-* id in the linux slot fails here.
  if (input.scriptIds) {
    for (const os of ["linux", "darwin", "windows"] as AgentOsPlatform[]) {
      const sid = input.scriptIds[os];
      if (sid) resolveInstallScriptId(os, sid);
    }
  }

  const assets = await prisma.asset.findMany({
    where: { id: { in: input.assetIds } },
    select: {
      id: true, hostname: true, dnsName: true, ipAddress: true, os: true, assetType: true,
      managedAgent: { select: { installStatus: true } },
      discoveredByIntegration: { select: { type: true } },
    },
  });
  const byId = new Map(assets.map((a) => [a.id, a]));

  const skipped: BulkInstallResult["skipped"] = [];
  const queue: Array<{ managedAgentId: string; credentialId: string }> = [];

  for (const assetId of input.assetIds) {
    const a = byId.get(assetId);
    if (!a) { skipped.push({ assetId, hostname: null, reason: "asset not found" }); continue; }
    const skip = (reason: string) => skipped.push({ assetId, hostname: a.hostname, reason });

    if (a.managedAgent) { skip(`agent already installed (status=${a.managedAgent.installStatus})`); continue; }
    const sourceKind = assetSourceKindFromIntegrationType(a.discoveredByIntegration?.type ?? null);
    if (!isPollingMethodCompatible(sourceKind, "agent")) { skip(`Polaris Agent is not compatible with ${sourceKind} sources`); continue; }
    if (a.assetType === "hypervisor") { skip("agent cannot be installed on a hypervisor (ESXi) host"); continue; }
    const host = a.ipAddress || a.dnsName || a.hostname || "";
    if (!host) { skip("no IP / DNS / hostname to reach the device"); continue; }

    const osPlatform = inferAgentPlatform(a.os);
    const target = pickTransportAndCredential(osPlatform, deployCfg);
    if ("skip" in target) { skip(target.skip); continue; }
    if (!manifest.binaries[`${osPlatform}-${arch}`]) { skip(`no agent binary built for ${osPlatform}-${arch}`); continue; }

    try {
      const row = await prisma.managedAgent.create({
        data: {
          assetId:               a.id,
          osPlatform,
          arch,
          installedBy:           actor,
          installStatus:         "pending",
          serverCertFingerprint: fingerprint,
          installCredentialId:   target.credentialId,
          installTransport:      target.transport,
          installScriptId:       input.scriptIds?.[osPlatform] ?? null,
          // Privilege tier is Linux-only; Windows/darwin stay "unprivileged".
          privilegeTier:         osPlatform === "linux" ? normalizePrivilegeTier(input.privilegeTier) : "unprivileged",
        },
      });
      queue.push({ managedAgentId: row.id, credentialId: target.credentialId });
      await logEvent({
        action:       "agent.install_kickoff",
        resourceType: "asset",
        resourceId:   a.id,
        resourceName: a.hostname || host,
        actor,
        level:        "info",
        message:      `Polaris Agent install kicked off (bulk, ${osPlatform}/${arch}, ${target.transport})`,
        details:      { managedAgentId: row.id, credentialId: target.credentialId, transport: target.transport, bulk: true },
      }).catch(() => {});
    } catch (err: any) {
      // Unique-constraint race (another install landed between findMany and
      // create) or any create failure — report as a skip, not a batch error.
      skip(err?.message || "failed to create agent record");
      logger.warn({ err, assetId: a.id }, "bulk agent install create failed");
    }
  }

  // Background pool over the actual remote installs. Each runInstall owns its
  // own error handling (failures land in installStatus="failed"); anything
  // escaping is logged, never thrown into the pool.
  if (queue.length > 0) {
    setImmediate(() => {
      void mapWithConcurrency(queue, BULK_INSTALL_POOL, (q) =>
        runInstall({ managedAgentId: q.managedAgentId, credentialId: q.credentialId }).catch((err) => {
          logger.error({ err, managedAgentId: q.managedAgentId }, "Bulk agent install crashed unexpectedly");
        }),
      );
    });
  }

  return { requested: input.assetIds.length, kicked: queue.length, skipped };
}

// ─── Install runner ───────────────────────────────────────────────────

async function runInstall(input: StartInstallInput): Promise<void> {
  const { managedAgentId, credentialId, hostOverride, testOverrides } = input;

  // Load the row + the asset (for hostname resolution).
  const row = await prisma.managedAgent.findUnique({
    where: { id: managedAgentId },
    include: { asset: true },
  });
  if (!row) {
    logger.warn({ managedAgentId }, "Install kickoff: ManagedAgent row not found");
    return;
  }

  // Build the agent.conf body — we need an enrollment token. The route
  // handler may have already minted one (Phase 2 path), but for the
  // automated install we mint a fresh one here so the operator's clock
  // restarts from when the install actually fires.
  const enrollmentToken = await mintEnrollmentToken(managedAgentId);

  const host = hostOverride ?? row.asset.ipAddress ?? row.asset.dnsName ?? row.asset.hostname;
  if (!host) {
    return failInstall(managedAgentId, row.assetId, "Asset has no IP, dnsName, or hostname to connect to");
  }

  // Resolve the binary path. Per platform/arch tuple, the file is named
  // polaris-agent-<os>-<arch>{,.exe} under AGENT_BIN_DIR/<version>/.
  // The version is read from the manifest; Phase 4a expects operators
  // to have produced this directory via `make -C agent all` and
  // shipped it inside their Polaris release tarball.
  const manifest = await loadManifest();
  if (!manifest) {
    return failInstall(managedAgentId, row.assetId,
      `No agent binaries available — drop a manifest.json + binaries under ${AGENT_BIN_DIR}/<version>/ and retry`);
  }
  const binaryKey = `${row.osPlatform}-${row.arch}`;
  const binaryName = manifest.binaries[binaryKey];
  if (!binaryName) {
    return failInstall(managedAgentId, row.assetId, `No agent binary for platform ${binaryKey}`);
  }
  const binaryPath = resolvePath(AGENT_BIN_DIR, manifest.currentVersion, binaryName);
  let binaryBytes: Buffer;
  try {
    binaryBytes = await readFile(binaryPath);
  } catch (err: any) {
    return failInstall(managedAgentId, row.assetId,
      `Failed to read agent binary at ${binaryPath}: ${err.message ?? err}`);
  }

  // Load the credential. SSH path needs username + (password OR
  // privateKey); WinRM path needs username + password.
  let cred;
  try {
    cred = await getCredential(credentialId, { revealSecrets: true });
  } catch (err: any) {
    return failInstall(managedAgentId, row.assetId, `Credential lookup failed: ${err.message ?? err}`);
  }

  // Pin the CURRENT server cert, not whatever was stored at the original
  // install. A reinstall reuses the row, and if the server cert has rotated
  // since that host was first installed, the stored fingerprint is stale — the
  // agent would bake a wrong pin into agent.conf, fail the pinned TLS
  // handshake, never complete /enroll, and sit forever at "enrolling". Refresh
  // to the live cert (falling back to the stored value only if the cert can't
  // be read) and persist it so the row reflects what the agent will trust.
  const liveFingerprint = getServerCertFingerprint();
  const certFingerprint = liveFingerprint || row.serverCertFingerprint;
  if (liveFingerprint && liveFingerprint !== row.serverCertFingerprint) {
    await prisma.managedAgent.update({
      where: { id: row.id },
      data:  { serverCertFingerprint: liveFingerprint },
    });
  }

  // Build the rendered agent.conf body that's about to be uploaded.
  const agentConfBody = renderAgentConf({
    serverUrl:                  await inferOwnServerUrl(),
    certFingerprint,
    additionalCertFingerprints: row.additionalServerCertFingerprints,
    enrollmentToken,
    agentId:                    row.id,
  });

  // Validate the persisted install-script variant against the row's OS (the
  // OS-lock, re-checked at execution time). A mismatch here is a bug — the
  // deploy routes validate before persisting — so fail the install loudly.
  try {
    resolveInstallScriptId(row.osPlatform as AgentOsPlatform, row.installScriptId);
  } catch (err: any) {
    return failInstall(managedAgentId, row.assetId, err?.message ?? String(err));
  }

  await transition(managedAgentId, "uploading");

  if (row.osPlatform === "linux" || row.osPlatform === "darwin") {
    try {
      await sshInstall({
        host,
        cred: cred.config as Record<string, unknown>,
        binaryBytes,
        agentConfBody,
        platform: row.osPlatform,
        scriptId: row.installScriptId,
        tier: normalizePrivilegeTier(row.privilegeTier),
        testOverrides,
      });
    } catch (err: any) {
      return failInstall(managedAgentId, row.assetId, err.message ?? String(err));
    }
  } else if (row.osPlatform === "windows") {
    try {
      if (row.installTransport === "ssh") {
        await sshWindowsInstall({
          host,
          cred: cred.config as Record<string, unknown>,
          agentConfBody,
          binaryFilename: binaryName,
          serverUrl: await inferOwnServerUrl(),
          certFingerprint: row.serverCertFingerprint,
          testOverrides,
        });
      } else {
        await winrmInstall({
          host,
          cred: cred.config as Record<string, unknown>,
          agentConfBody,
          binaryFilename: binaryName,
          serverUrl: await inferOwnServerUrl(),
          certFingerprint: row.serverCertFingerprint,
          testOverrides,
        });
      }
    } catch (err: any) {
      return failInstall(managedAgentId, row.assetId, err.message ?? String(err));
    }
  } else {
    return failInstall(managedAgentId, row.assetId, `Unsupported osPlatform ${row.osPlatform}`);
  }

  await transition(managedAgentId, "enrolling");
  await logEvent({
    action:       "agent.installed",
    resourceType: "asset",
    resourceId:   row.assetId,
    level:        "info",
    message:      "Polaris Agent installer completed on host — awaiting agent enrollment",
    details:      { managedAgentId },
  });
  // installStatus transitions to "active" when the agent posts /enroll.
}

async function failInstall(managedAgentId: string, assetId: string, reason: string): Promise<void> {
  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { installStatus: "failed", installError: reason },
  }).catch(() => { /* best-effort */ });
  await logEvent({
    action:       "agent.install_failed",
    resourceType: "asset",
    resourceId:   assetId,
    level:        "error",
    message:      `Agent install failed: ${reason}`,
    details:      { managedAgentId },
  });
}

async function transition(managedAgentId: string, installStatus: string): Promise<void> {
  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { installStatus, installError: null },
  });
}

// ─── Uninstall runner ─────────────────────────────────────────────────

async function runUninstall(input: StartUninstallInput): Promise<void> {
  const { managedAgentId, credentialId, hostOverride, testOverrides } = input;

  const row = await prisma.managedAgent.findUnique({
    where: { id: managedAgentId },
    include: { asset: true },
  });
  if (!row) {
    logger.warn({ managedAgentId }, "Uninstall kickoff: row not found");
    return;
  }

  const host = hostOverride ?? row.asset.ipAddress ?? row.asset.dnsName ?? row.asset.hostname;
  if (!host) {
    return failUninstall(managedAgentId, row.assetId, "Asset has no IP/dnsName/hostname to connect to");
  }

  let cred;
  try {
    cred = await getCredential(credentialId, { revealSecrets: true });
  } catch (err: any) {
    return failUninstall(managedAgentId, row.assetId, `Credential lookup failed: ${err.message ?? err}`);
  }

  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { installStatus: "uninstalling", installError: null },
  });

  if (row.osPlatform === "linux" || row.osPlatform === "darwin") {
    try {
      await sshUninstall({
        host,
        cred: cred.config as Record<string, unknown>,
        platform: row.osPlatform,
        scriptId: row.installScriptId,
        testOverrides,
      });
    } catch (err: any) {
      return failUninstall(managedAgentId, row.assetId, err.message ?? String(err));
    }
  } else if (row.osPlatform === "windows") {
    try {
      if (row.installTransport === "ssh") {
        await sshWindowsUninstall({
          host,
          cred: cred.config as Record<string, unknown>,
          testOverrides,
        });
      } else {
        await winrmUninstall({
          host,
          cred: cred.config as Record<string, unknown>,
          testOverrides,
        });
      }
    } catch (err: any) {
      return failUninstall(managedAgentId, row.assetId, err.message ?? String(err));
    }
  }

  // Hard-delete on success (audit trail lives in Event). Also clear the
  // four *Polling fields back to null so the source-default resolver
  // takes over again — the asset was "owned by the agent" while it was
  // installed; with the agent gone we want ICMP / SNMP / etc. periodic
  // polling to resume per the source default. Operators can re-pick a
  // specific method on the Monitoring tab if they want a different
  // post-uninstall config.
  // Removing the agent also tears the host off the Application Map: clear the
  // map pins (mappedProcesses/mappedServices) + null processesPolling +
  // delete its connection facts. Nothing collects those once the agent is gone,
  // and the pinned process/service child nodes would otherwise render on the
  // map indefinitely (they come from the pins, not the connection rows).
  await prisma.$transaction([
    prisma.managedAgent.delete({ where: { id: managedAgentId } }),
    prisma.asset.update({
      where: { id: row.assetId },
      data: {
        responseTimePolling: null,
        cpuMemoryPolling:    null,
        temperaturePolling:  null,
        interfacesPolling:   null,
        lldpPolling:         null,
        storagePolling:      null,
        processesPolling:    null,
        mappedProcesses:     [],
        mappedServices:      [],
      },
    }),
    prisma.assetProcessConnection.deleteMany({ where: { assetId: row.assetId } }),
  ]);
  await logEvent({
    action:       "agent.uninstalled",
    resourceType: "asset",
    resourceId:   row.assetId,
    level:        "info",
    message:      "Polaris Agent uninstalled cleanly",
    details:      { managedAgentId, osPlatform: row.osPlatform },
  });
}

async function failUninstall(managedAgentId: string, assetId: string, reason: string): Promise<void> {
  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data: { installStatus: "uninstall_failed", installError: reason },
  }).catch(() => { /* best-effort */ });
  await logEvent({
    action:       "agent.uninstall_failed",
    resourceType: "asset",
    resourceId:   assetId,
    level:        "warning",
    message:      `Agent uninstall failed: ${reason}`,
    details:      { managedAgentId },
  });
}

// ─── Upgrade runner ───────────────────────────────────────────────────
//
// SSH/WinRM-driven so it has root/admin context (the agent runs as a
// non-root user and can't reliably replace its own binary while running).
// CRUCIALLY does NOT touch agent.conf — the bearer + cert pin survive,
// so the agent reconnects with the same identity.
//
// Success: installStatus flips active → upgrading → active. agentVersion
// catches up via the agent's next heartbeat (≤ 5 min) or sooner via WS
// reconnect (immediate after Start-Service / systemctl start).

interface RunUpgradeInput {
  managedAgentId: string;
  resolved:       ResolvedUpgradeCredential;
  hostOverride?:  string;
  testOverrides?: TestOverrides;
  actor:          string;
}

async function runUpgrade(input: RunUpgradeInput): Promise<void> {
  const row = await prisma.managedAgent.findUnique({
    where: { id: input.managedAgentId },
    include: { asset: true },
  });
  if (!row) {
    logger.warn({ managedAgentId: input.managedAgentId }, "Upgrade kickoff: row not found");
    return;
  }

  const host = input.hostOverride ?? row.asset.ipAddress ?? row.asset.dnsName ?? row.asset.hostname;
  if (!host) {
    return failUpgrade(input.managedAgentId, row.assetId, "Asset has no IP, dnsName, or hostname to connect to", input.actor);
  }

  const manifest = await loadManifest();
  if (!manifest) {
    return failUpgrade(input.managedAgentId, row.assetId, "No agent binaries available — build them first.", input.actor);
  }
  const binaryName = manifest.binaries[`${row.osPlatform}-${row.arch}`];
  if (!binaryName) {
    return failUpgrade(input.managedAgentId, row.assetId, `No agent binary for platform ${row.osPlatform}-${row.arch}`, input.actor);
  }
  const toVersion = manifest.currentVersion;

  let cred;
  try {
    cred = await getCredential(input.resolved.credentialId, { revealSecrets: true });
  } catch (err: any) {
    return failUpgrade(input.managedAgentId, row.assetId, `Credential lookup failed: ${err.message ?? err}`, input.actor);
  }

  if (row.osPlatform === "linux" || row.osPlatform === "darwin") {
    const binaryPath = resolvePath(AGENT_BIN_DIR, toVersion, binaryName);
    let binaryBytes: Buffer;
    try {
      binaryBytes = await readFile(binaryPath);
    } catch (err: any) {
      return failUpgrade(input.managedAgentId, row.assetId,
        `Failed to read agent binary at ${binaryPath}: ${err.message ?? err}`, input.actor);
    }
    try {
      await sshUpgrade({
        host,
        cred:         cred.config as Record<string, unknown>,
        binaryBytes,
        platform:     row.osPlatform,
        testOverrides: input.testOverrides,
      });
    } catch (err: any) {
      return failUpgrade(input.managedAgentId, row.assetId, err.message ?? String(err), input.actor);
    }
  } else if (row.osPlatform === "windows") {
    try {
      // The RESOLVED transport, not the row's: for a healthy row they agree,
      // and for an adopted credential the row's value is stale (or was
      // backfilled to winrm) — see resolveUpgradeCredential.
      if (input.resolved.transport === "ssh") {
        await sshWindowsUpgrade({
          host,
          cred:            cred.config as Record<string, unknown>,
          binaryFilename:  binaryName,
          serverUrl:       await inferOwnServerUrl(),
          certFingerprint: row.serverCertFingerprint,
          testOverrides:   input.testOverrides,
        });
      } else {
        await winrmUpgrade({
          host,
          cred:            cred.config as Record<string, unknown>,
          binaryFilename:  binaryName,
          serverUrl:       await inferOwnServerUrl(),
          certFingerprint: row.serverCertFingerprint,
          testOverrides:   input.testOverrides,
        });
      }
    } catch (err: any) {
      return failUpgrade(input.managedAgentId, row.assetId, err.message ?? String(err), input.actor);
    }
  } else {
    return failUpgrade(input.managedAgentId, row.assetId, `Unsupported osPlatform ${row.osPlatform}`, input.actor);
  }

  // Success. Transition back to "active". agentVersion stays at the
  // existing value until the host's next heartbeat reports the new one;
  // the route already returned the expected toVersion to the operator so
  // the UI doesn't need to wait for that.
  //
  // An ADOPTED credential is written back here and only here — proof it can
  // actually reach the host, so the row stops being stranded and the next
  // fan-out needs no fallback. Written on success only: a host that failed
  // keeps whatever it had recorded rather than being repointed at a
  // credential that didn't work.
  const adoption = input.resolved.adopted
    ? {
        installCredentialId: input.resolved.credentialId,
        installTransport:    input.resolved.transport,
      }
    : {};
  await prisma.managedAgent.update({
    where: { id: row.id },
    data:  { installStatus: "active", installError: null, ...adoption },
  });
  await logEvent({
    action:       "agent.upgrade_succeeded",
    resourceType: "asset",
    resourceId:   row.assetId,
    actor:        input.actor,
    level:        "info",
    message:      input.resolved.adopted
      ? `Polaris Agent upgraded to v${toVersion}; adopted the managed deployment credential ` +
        `"${input.resolved.credentialName}" (${input.resolved.transport}) as this agent's install credential`
      : `Polaris Agent upgraded to v${toVersion}`,
    details: {
      managedAgentId:    row.id,
      fromVersion:       row.agentVersion ?? null,
      toVersion,
      adoptedCredential: input.resolved.adopted,
      ...(input.resolved.adopted
        ? { credentialId: input.resolved.credentialId, transport: input.resolved.transport }
        : {}),
    },
  });
}

async function failUpgrade(managedAgentId: string, assetId: string, reason: string, actor: string): Promise<void> {
  await prisma.managedAgent.update({
    where: { id: managedAgentId },
    data:  { installStatus: "upgrade_failed", installError: reason },
  }).catch(() => { /* best-effort */ });
  await logEvent({
    action:       "agent.upgrade_failed",
    resourceType: "asset",
    resourceId:   assetId,
    actor,
    level:        "warning",
    message:      `Agent upgrade failed: ${reason}`,
    details:      { managedAgentId },
  });
}

// ─── SSH helpers ──────────────────────────────────────────────────────

interface SshInstallParams {
  host: string;
  cred: Record<string, unknown>;
  binaryBytes: Buffer;
  agentConfBody: string;
  platform: "linux" | "darwin";
  scriptId?: string | null;
  tier?: AgentPrivilegeTier; // linux only — "ptrace" adds CAP_SYS_PTRACE
  testOverrides?: TestOverrides;
}

async function sshInstall(p: SshInstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);

  await withSshClient(p.host, p.cred, async (client) => {
    // 1. SFTP upload binary + installer script to /tmp.
    await sftpPut(client, "/tmp/polaris-agent.bin",         p.binaryBytes, 0o755);
    await sftpPut(client, "/tmp/polaris-agent-install.sh",  installerScript(p.platform, p.scriptId, p.tier ?? "unprivileged"), 0o700);
    await sftpPut(client, "/tmp/polaris-agent.conf",        Buffer.from(p.agentConfBody, "utf8"), 0o600);

    // 2. Run the installer. `sudo` is implicit — the credential is
    //    expected to map to a user that can `sudo -n` (passwordless
    //    sudo) on the target. Operators who want a different escalation
    //    model can roll their own bootstrap. If sudo prompts for a
    //    password the install hangs; the timeout below trips it.
    const out = await sshExec(client, "sudo -n bash /tmp/polaris-agent-install.sh", 60_000);
    if (out.exitCode !== 0) {
      throw new AppError(502, `Installer exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
    }
  });
}

interface SshUninstallParams {
  host: string;
  cred: Record<string, unknown>;
  platform: "linux" | "darwin";
  scriptId?: string | null;
  testOverrides?: TestOverrides;
}

async function sshUninstall(p: SshUninstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);

  await withSshClient(p.host, p.cred, async (client) => {
    await sftpPut(client, "/tmp/polaris-agent-uninstall.sh", uninstallerScript(p.platform, p.scriptId), 0o700);
    const out = await sshExec(client, "sudo -n bash /tmp/polaris-agent-uninstall.sh", 60_000);
    if (out.exitCode !== 0) {
      throw new AppError(502, `Uninstaller exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
    }
  });
}

// withSshClient / sshExec / sftpPut / ExecResult moved to
// src/utils/remoteExec.ts (shared with agentlessProcessService) — imported above.


// ─── Embedded scripts + agent.conf templating ─────────────────────────
//
// Per-platform installer scripts live inline here (not on disk alongside
// the binary). Rationale: version-coupling — the systemd unit shape /
// launchd plist shape must match the binary's expected paths, and
// shipping them together would mean the operator has to also re-upload
// the script every time we patch a service-management bug.
//
// All three scripts share the same input contract: nothing on the command
// line, everything pre-staged at /tmp/polaris-agent.bin and
// /tmp/polaris-agent.conf (binary + config) — the script just moves them
// into place and registers the service.

// Select the install script for the resolved catalog variant. resolveInstallScriptId
// re-validates the OS-lock (defense in depth — the row's installScriptId was
// already validated at deploy time). Add a `case` here for every new variant
// added to AGENT_INSTALL_SCRIPTS.
function installerScript(platform: "linux" | "darwin", scriptId?: string | null, tier: AgentPrivilegeTier = "unprivileged"): Buffer {
  const id = resolveInstallScriptId(platform, scriptId);
  switch (id) {
    case "linux-systemd":  return Buffer.from(linuxInstallScript(tier), "utf8");
    // darwin LaunchDaemons already run as root; the privilege tier is a
    // Linux-only concept.
    case "darwin-launchd": return Buffer.from(DARWIN_INSTALL_SCRIPT, "utf8");
    default:
      throw new AppError(500, `No installer script wired for variant "${id}"`);
  }
}

function uninstallerScript(platform: "linux" | "darwin", scriptId?: string | null): Buffer {
  // Uninstall must undo the SAME variant that installed the agent, so it keys
  // off the persisted installScriptId too.
  const id = resolveInstallScriptId(platform, scriptId);
  switch (id) {
    case "linux-systemd":  return Buffer.from(LINUX_UNINSTALL_SCRIPT, "utf8");
    case "darwin-launchd": return Buffer.from(DARWIN_UNINSTALL_SCRIPT, "utf8");
    default:
      throw new AppError(500, `No uninstaller script wired for variant "${id}"`);
  }
}

// Privilege-tier → systemd [Service] block mapping lives in utils/agentUnit.ts
// (pure, unit-tested there). Re-exported for callers that import from here.
export { normalizePrivilegeTier };
export type { AgentPrivilegeTier };

// Polaris Agent installer for Linux (systemd), parameterized by privilege tier.
// Run by polaris-agent-install.sh as root via sudo -n; reads pre-staged binary
// + config from /tmp/. Config lives under /var/lib/polaris-agent/ (systemd
// StateDirectory) rather than /etc/polaris-agent/ so the agent can rewrite it
// after /enroll succeeds — under the unprivileged unit ProtectSystem=strict
// makes /etc read-only, while StateDirectory stays writable. The legacy
// /etc/polaris-agent path is cleaned up if present so reinstalls don't orphan.
function linuxInstallScript(tier: AgentPrivilegeTier): string {
  return `#!/usr/bin/env bash
set -euo pipefail

BIN_SRC=/tmp/polaris-agent.bin
CONF_SRC=/tmp/polaris-agent.conf
BIN_DST=/usr/local/bin/polaris-agent
CONF_DIR=/var/lib/polaris-agent
CONF_DST=\${CONF_DIR}/agent.conf
UNIT=/etc/systemd/system/polaris-agent.service

# Stop + remove any existing install so reinstall is idempotent.
systemctl stop  polaris-agent 2>/dev/null || true

install -m 0755 -o root -g root "\${BIN_SRC}"  "\${BIN_DST}"
mkdir -p "\${CONF_DIR}"
chmod 0700 "\${CONF_DIR}"
# The conf must be READABLE BY THE UNIT'S DynamicUser, not by root. systemd
# chowns the StateDirectory itself to the dynamic user, but NOT files already
# inside it — so on a REINSTALL (where \${CONF_DIR} is already a symlink into
# /var/lib/private/ owned by the dynamic user) a root-owned agent.conf leaves
# the agent dying with "load config: permission denied" on every restart, and
# it parks in installStatus="enrolling" forever. Match the state directory's
# current owner instead; on a first install that's still root and systemd's
# directory migration chowns the whole tree at first start. After /enroll the
# agent rewrites the file itself (tempfile + rename as its own user), so
# ownership stays correct from then on.
install -m 0600 "\${CONF_SRC}" "\${CONF_DST}"
CONF_OWNER="$(stat -Lc '%u:%g' "\${CONF_DIR}" 2>/dev/null || echo 0:0)"
chown "\${CONF_OWNER}" "\${CONF_DST}"

# Legacy location from pre-StateDirectory installs. Harmless if absent.
rm -rf /etc/polaris-agent 2>/dev/null || true

cat > "\${UNIT}" <<'UNIT'
[Unit]
Description=Polaris Agent
After=network-online.target
Wants=network-online.target

${linuxServiceBlock(tier)}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable polaris-agent
systemctl start  polaris-agent

# Clean up the staging files; they're no longer needed.
rm -f "\${BIN_SRC}" "\${CONF_SRC}"

echo "Polaris Agent installed and started"
`;
}

const LINUX_UNINSTALL_SCRIPT = `#!/usr/bin/env bash
# Polaris Agent uninstaller for Linux (systemd). Idempotent — missing
# files are ignored.
set -euo pipefail

systemctl stop    polaris-agent 2>/dev/null || true
systemctl disable polaris-agent 2>/dev/null || true
rm -f /etc/systemd/system/polaris-agent.service
systemctl daemon-reload || true

rm -rf /var/lib/polaris-agent
# StateDirectory under DynamicUser lives at /var/lib/private/<name>, with
# /var/lib/polaris-agent as a symlink to it — removing only the symlink
# orphans the real state (agent.conf with its bearer, servicelog cursors).
rm -rf /var/lib/private/polaris-agent
rm -rf /etc/polaris-agent       # legacy pre-StateDirectory location
rm -f  /usr/local/bin/polaris-agent

echo "Polaris Agent removed"
`;

const DARWIN_INSTALL_SCRIPT = `#!/usr/bin/env bash
# Polaris Agent installer for macOS (launchd). Run as root via sudo -n.
set -euo pipefail

BIN_SRC=/tmp/polaris-agent.bin
CONF_SRC=/tmp/polaris-agent.conf
BIN_DST=/usr/local/bin/polaris-agent
CONF_DIR=/etc/polaris-agent
CONF_DST=\${CONF_DIR}/agent.conf
PLIST=/Library/LaunchDaemons/com.polaris.agent.plist

# Stop + unload any existing install so reinstall is idempotent.
if [ -f "\${PLIST}" ]; then
  launchctl unload "\${PLIST}" 2>/dev/null || true
fi

install -m 0755 -o root -g wheel "\${BIN_SRC}"  "\${BIN_DST}"
mkdir -p "\${CONF_DIR}"
install -m 0600 -o root -g wheel "\${CONF_SRC}" "\${CONF_DST}"

cat > "\${PLIST}" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>           <string>com.polaris.agent</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/polaris-agent</string>
    <string>-conf</string>
    <string>/etc/polaris-agent/agent.conf</string>
  </array>
  <key>RunAtLoad</key>       <true/>
  <key>KeepAlive</key>       <true/>
  <key>StandardOutPath</key> <string>/var/log/polaris-agent.log</string>
  <key>StandardErrorPath</key> <string>/var/log/polaris-agent.log</string>
</dict>
</plist>
PLIST

chmod 0644 "\${PLIST}"
launchctl load "\${PLIST}"

rm -f "\${BIN_SRC}" "\${CONF_SRC}"

echo "Polaris Agent installed and started"
`;

const DARWIN_UNINSTALL_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

PLIST=/Library/LaunchDaemons/com.polaris.agent.plist

if [ -f "\${PLIST}" ]; then
  launchctl unload "\${PLIST}" 2>/dev/null || true
  rm -f "\${PLIST}"
fi

rm -rf /etc/polaris-agent
rm -f  /usr/local/bin/polaris-agent
rm -f  /var/log/polaris-agent.log

echo "Polaris Agent removed"
`;

interface RenderAgentConfInput {
  serverUrl:       string;
  /**
   * Single canonical pin (legacy single-pin agents) or the full pin set
   * (Phase 2 dual-pin agents). Callers usually pass the canonical fingerprint
   * here; for staged-rotation pushes, pass the union via certFingerprints.
   */
  certFingerprint: string;
  /**
   * Additional staged pins (Phase 2 dual-pin). When present, written as
   * `cert_fingerprints = <comma-list>` in addition to the legacy
   * `cert_fingerprint` line so Phase 2 agents read the union and pre-Phase-2
   * agents continue to read the single canonical pin. Empty array (default)
   * keeps the file shape identical to the pre-Phase-2 format.
   */
  additionalCertFingerprints?: string[];
  enrollmentToken: string;
  agentId:         string;
}

export function renderAgentConf(input: RenderAgentConfInput): string {
  // Pin SET written as `cert_fingerprints` for Phase 2 agents. Always also
  // write the legacy `cert_fingerprint = <canonical>` line so older agent
  // binaries (pre-Phase-2 installs that haven't been Upgrade-all'd yet) keep
  // their single-pin behavior. Phase 2 agents prefer `cert_fingerprints` when
  // both are present.
  const additional = input.additionalCertFingerprints ?? [];
  const allPins = [input.certFingerprint, ...additional];
  const lines = [
    "# Polaris Agent configuration. Generated by agentInstallService.",
    "# Do not edit by hand — agent rewrites this file on enrollment.",
    `server_url        = ${input.serverUrl}`,
    `cert_fingerprint  = ${input.certFingerprint}`,
    `cert_fingerprints = ${allPins.join(",")}`,
    `agent_id          = ${input.agentId}`,
    `enrollment_token  = ${input.enrollmentToken}`,
    "",
  ];
  return lines.join("\n");
}

// ─── Server-URL inference + binary manifest ───────────────────────────

export const AGENT_SERVER_URL_SETTING_KEY = "agent.serverUrlOverride";

/**
 * Own-server URL the installed agent should call back to. Stamped into
 * `agent.conf`'s server_url at install time. Resolution order:
 *
 *   1. `Setting.agent.serverUrlOverride` — UI-settable from Server
 *      Settings → Maintenance → Polaris Agent card. Persists across
 *      restarts in Postgres; editable without shell access. This is
 *      the new "easy operator path" added after the rhel8test debacle.
 *   2. `POLARIS_PUBLIC_URL` env var (legacy operator override — kept
 *      for scripted deployments + reverse-proxy / split-DNS shops who
 *      already automated around it).
 *   3. The first DNS SAN on the running HTTPS leaf cert, plus the live
 *      HTTPS port. The cert is the natural source of truth — operators
 *      generate it with the hostname they expect Polaris to be reached
 *      at, and the agent's pin is verifying that exact cert anyway.
 *   4. The cert's Common Name + live HTTPS port.
 *   5. First IP SAN + live HTTPS port (covers IP-only certs used in
 *      isolated networks where there's no DNS).
 *   6. `POLARIS_PUBLIC_HOST` env var + PORT (legacy escape hatch).
 *   7. `localhost` + PORT (same-box installs only — the install kickoff
 *      route guards this and refuses when the target host isn't loopback).
 *
 * The HTTPS port comes from publicUrl.getPublicUrlPort() — the actual
 * port Polaris is listening on, NOT process.env.PORT (which is the HTTP
 * port and may differ).
 */
export async function inferOwnServerUrl(): Promise<string> {
  // (1) UI override Setting.
  try {
    const row = await prisma.setting.findUnique({ where: { key: AGENT_SERVER_URL_SETTING_KEY } });
    const v = (row?.value as { url?: string } | null)?.url;
    if (v && typeof v === "string" && v.trim()) return v.trim().replace(/\/$/, "");
  } catch {
    // Defensive: if the Setting table is unreachable, fall through to
    // the env/cert chain rather than fail the install.
  }

  // (2) Env override.
  const fromEnv = process.env.POLARIS_PUBLIC_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");

  // (3-5) Cert-driven derivation.
  const httpsPort = getPublicUrlPort();
  const hostnames = getServerCertHostnames();
  if (httpsPort != null && hostnames) {
    const preferred = hostnames.dnsSans[0] || hostnames.cn || hostnames.ipSans[0] || null;
    if (preferred) return `https://${preferred}:${httpsPort}`;
  }

  // (6-7) Legacy fallbacks. The install kickoff route enforces that we
  // never produce a "https://localhost:<port>" URL for a non-loopback
  // target, so these branches are safe as a last-resort default.
  const port = process.env.PORT ?? "3000";
  const host = process.env.POLARIS_PUBLIC_HOST ?? "localhost";
  return `https://${host}:${port}`;
}

/**
 * Same resolver as inferOwnServerUrl(), but synchronous and without the
 * UI-override Setting (since reading from Prisma is async). Returns the
 * URL the install path WOULD produce if no Setting override exists.
 * Used by the inventory endpoint to render the "effective default" hint
 * next to the operator-facing URL input on the Maintenance card.
 */
export function inferOwnServerUrlSync(): string {
  const fromEnv = process.env.POLARIS_PUBLIC_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const httpsPort = getPublicUrlPort();
  const hostnames = getServerCertHostnames();
  if (httpsPort != null && hostnames) {
    const preferred = hostnames.dnsSans[0] || hostnames.cn || hostnames.ipSans[0] || null;
    if (preferred) return `https://${preferred}:${httpsPort}`;
  }
  const port = process.env.PORT ?? "3000";
  const host = process.env.POLARIS_PUBLIC_HOST ?? "localhost";
  return `https://${host}:${port}`;
}

interface AgentManifest {
  currentVersion:    string;
  minimumCompatible: string;
  binaries:          Record<string, string>;
}

async function loadManifest(): Promise<AgentManifest | null> {
  try {
    const buf = await readFile(resolvePath(AGENT_BIN_DIR, "manifest.json"), "utf8");
    return JSON.parse(buf) as AgentManifest;
  } catch {
    return null;
  }
}

// ─── WinRM (Windows) install/uninstall ────────────────────────────────
//
// Architecture (vs SSH/Linux): we DON'T do a SOAP-based file upload. The
// PowerShell installer running on the host pulls the binary via HTTPS
// from Polaris's public `/api/v1/agents/binary/:filename` endpoint, with
// a cert-pin validation callback so it doesn't trust system CAs. WinRM
// only needs to run ONE command — the PowerShell installer one-liner.
// Saves us writing ~1000 lines of chunked WS-Management Send-verb code
// that's only used here.

interface WinRmInstallParams {
  host: string;
  cred: Record<string, unknown>;
  agentConfBody: string;
  binaryFilename: string;
  serverUrl: string;
  certFingerprint: string;
  testOverrides?: TestOverrides;
}

interface WinRmUninstallParams {
  host: string;
  cred: Record<string, unknown>;
  testOverrides?: TestOverrides;
}

async function winrmInstall(p: WinRmInstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return; // tests reuse the same flag for both transports
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);

  const conn = winrmConnectionFromCred(p.host, p.cred);

  // Render the installer PowerShell. Base64-encoded agent.conf is
  // embedded so command-line escaping rules don't bite us; pin +
  // server URL + binary filename are passed as separate single-quoted
  // strings (PowerShell's single quotes don't expand $vars).
  const confB64 = Buffer.from(p.agentConfBody, "utf8").toString("base64");
  const ps = WINDOWS_INSTALL_PS
    .replace(/__SERVER_URL__/g,        p.serverUrl)
    .replace(/__CERT_FINGERPRINT__/g,  p.certFingerprint)
    .replace(/__BINARY_FILENAME__/g,   p.binaryFilename)
    .replace(/__AGENT_CONF_B64__/g,    confB64);

  // PowerShell accepts a base64-encoded script via -EncodedCommand; that
  // avoids EVERY shell-escape problem on the way through cmd.exe and
  // the WS-Management envelope. The encoding is UTF-16-LE, per the
  // docs.
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const out = await winrmRunOne(conn, "powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded,
  ]);
  if (out.exitCode !== 0) {
    throw new AppError(502, `Windows installer exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
  }
}

async function winrmUninstall(p: WinRmUninstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);

  const conn = winrmConnectionFromCred(p.host, p.cred);
  const encoded = Buffer.from(WINDOWS_UNINSTALL_PS, "utf16le").toString("base64");
  const out = await winrmRunOne(conn, "powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded,
  ]);
  if (out.exitCode !== 0) {
    throw new AppError(502, `Windows uninstaller exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
  }
}

// ─── SSH-to-Windows install/uninstall/upgrade ─────────────────────────
//
// Runs the SAME PowerShell scripts the WinRM path uses (WINDOWS_INSTALL_PS,
// WINDOWS_UNINSTALL_PS, WINDOWS_UPGRADE_PS). Requires OpenSSH Server
// installed + enabled on the target Windows host (Windows Server 2019+ /
// Windows 10 1809+ ship it as an optional feature).
//
// Delivery: SFTP the script as a UTF-8 file with a BOM to
// C:/Windows/Temp/polaris-agent-*.ps1, then invoke
// `powershell.exe -ExecutionPolicy Bypass -File <path>`. We don't use
// `-EncodedCommand` here even though it works for WinRM — the base64
// payload of the install script overflows the Windows cmd.exe 8191-char
// command-line limit (the OpenSSH server on Windows hands the exec
// command to cmd.exe regardless of the DefaultShell registry value), so
// invocations failed with "The command line is too long." Writing the
// script to disk first sidesteps the limit entirely. The BOM is required
// so Windows PowerShell 5.1 treats the file as UTF-8 with non-ASCII
// characters intact.
//
// The PS script itself downloads the agent binary from Polaris over HTTPS
// with cert-pin validation (identical to the WinRM path) — no SFTP of the
// binary is needed. This keeps the new code surface minimal.

interface SshWindowsInstallParams {
  host: string;
  cred: Record<string, unknown>;
  agentConfBody: string;
  binaryFilename: string;
  serverUrl: string;
  certFingerprint: string;
  testOverrides?: TestOverrides;
}

interface SshWindowsUninstallParams {
  host: string;
  cred: Record<string, unknown>;
  testOverrides?: TestOverrides;
}

interface SshWindowsUpgradeParams {
  host: string;
  cred: Record<string, unknown>;
  binaryFilename: string;
  serverUrl: string;
  certFingerprint: string;
  testOverrides?: TestOverrides;
}

async function sshWindowsInstall(p: SshWindowsInstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);

  const confB64 = Buffer.from(p.agentConfBody, "utf8").toString("base64");
  const ps = WINDOWS_INSTALL_PS
    .replace(/__SERVER_URL__/g,       p.serverUrl)
    .replace(/__CERT_FINGERPRINT__/g, p.certFingerprint)
    .replace(/__BINARY_FILENAME__/g,  p.binaryFilename)
    .replace(/__AGENT_CONF_B64__/g,   confB64);
  await runPowerShellOverSsh(p.host, p.cred, ps, "polaris-agent-install.ps1", 180_000);
}

async function sshWindowsUninstall(p: SshWindowsUninstallParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);
  await runPowerShellOverSsh(p.host, p.cred, WINDOWS_UNINSTALL_PS, "polaris-agent-uninstall.ps1", 60_000);
}

async function sshWindowsUpgrade(p: SshWindowsUpgradeParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);

  const ps = WINDOWS_UPGRADE_PS
    .replace(/__SERVER_URL__/g,       p.serverUrl)
    .replace(/__CERT_FINGERPRINT__/g, p.certFingerprint)
    .replace(/__BINARY_FILENAME__/g,  p.binaryFilename);
  await runPowerShellOverSsh(p.host, p.cred, ps, "polaris-agent-upgrade.ps1", 180_000);
}

async function runPowerShellOverSsh(
  host: string,
  cred: Record<string, unknown>,
  ps: string,
  scriptName: string,
  timeoutMs: number,
): Promise<void> {
  // UTF-8 with BOM. The BOM is the way to tell Windows PowerShell 5.1 that a
  // .ps1 file is UTF-8 — without it PS5.1 falls back to the legacy ANSI code
  // page and any non-ASCII byte (an em-dash in a comment, a smart quote) is
  // mis-decoded. PowerShell 7 reads UTF-8 by default so the BOM is harmless
  // there. Forward-slash absolute path works with Windows OpenSSH's
  // sftp-server; "C:/Windows/Temp" is writable by every admin context and
  // always exists.
  const remotePath = `C:/Windows/Temp/${scriptName}`;
  const body = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(ps, "utf8")]);
  const cmd =
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${remotePath}"`;
  await withSshClient(host, cred, async (client) => {
    await sftpPut(client, remotePath, body, 0o600);
    const out = await sshExec(client, cmd, timeoutMs);
    if (out.exitCode !== 0) {
      throw new AppError(502, `PowerShell exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
    }
    // Best-effort cleanup. Not fatal if it fails (Windows\Temp is fair game
    // for orphans, and an admin re-run will overwrite the file anyway).
    try {
      await sshExec(client, `cmd.exe /c del /f /q "${remotePath.replace(/\//g, "\\")}"`, 10_000);
    } catch { /* ignore */ }
  });
}

function winrmConnectionFromCred(host: string, config: Record<string, unknown>): WinRmConnection {
  const username = String(config.username || "");
  const password = String(config.password || "");
  if (!username || !password) {
    throw new AppError(400, "WinRM credential is missing username or password");
  }
  return {
    host,
    port:     typeof config.port === "number" ? config.port : undefined,
    useHttps: config.useHttps !== false,
    // Honor the credential's TLS-verify opt-in (2026-06-03 review, H1); legacy
    // credentials with no flag keep the prior no-verify behavior.
    verifyTls: config.verifyTls === true,
    username,
    password,
    timeoutMs: 120_000, // installer downloads a ~10 MB binary; default 60s is tight
  };
}

// Shared PowerShell helper: cert-pinned HTTPS download via raw SslStream
// + HTTP/1.1. Bypasses HttpWebRequest / Invoke-WebRequest entirely.
//
// Rationale: Invoke-WebRequest under Windows PowerShell 5.1 uses
// HttpWebRequest under the hood, which couples cert-pin validation to a
// global ServicePointManager.ServerCertificateValidationCallback AND
// also tries to negotiate HTTP/2 via ALPN against modern nginx + reads
// proxy config out of WinINET. Both interactions are fragile when the
// powershell.exe process is launched non-interactively over OpenSSH (no
// HKCU hive loaded, no user profile), producing the cryptic
// "The underlying connection was closed: An unexpected error occurred
// on a send." with no diagnostic.
//
// Doing the TLS by hand removes every moving part: we open a TcpClient,
// wrap it in SslStream with a RemoteCertificateValidationCallback that
// performs the SHA-256 pin check, force TLS 1.2/1.3, send a HTTP/1.1
// `Connection: close` GET, parse the response status + Content-Length
// from the headers, and stream the body bytes straight to disk. Works
// uniformly over WinRM AND over OpenSSH.
const POLARIS_PS_PINNED_DOWNLOAD_FN = `
function Invoke-PolarisPinnedDownload {
  param([string]$Url, [string]$OutFile, [string]$ExpectedPin)

  $uri = [System.Uri]$Url
  $port = if ($uri.Port -gt 0) { $uri.Port } else { 443 }
  $script:_PolarisPinObserved = ''
  $script:_PolarisPinMatches  = $false

  $tcp = New-Object System.Net.Sockets.TcpClient
  $tcp.Connect($uri.Host, $port)
  try {
    $callback = {
      param($snd, $cert, $chain, $errors)
      $der = $cert.GetRawCertData()
      $sha = [System.Security.Cryptography.SHA256]::Create()
      try {
        $hash = $sha.ComputeHash($der)
        $hex = -join ($hash | ForEach-Object { $_.ToString('x2') })
        $script:_PolarisPinObserved = 'sha256:' + $hex
        $script:_PolarisPinMatches  = ($script:_PolarisPinObserved -eq $ExpectedPin)
        return $script:_PolarisPinMatches
      } finally { $sha.Dispose() }
    }

    $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, $callback)
    try {
      # TLS 1.2 always; TLS 1.3 if the .NET version's enum has it (Tls13 was
      # added in .NET 4.8 / PS7). Bitwise-OR so we never clobber what's
      # available.
      $protocols = [System.Security.Authentication.SslProtocols]::Tls12
      try { $protocols = $protocols -bor [System.Security.Authentication.SslProtocols]::Tls13 } catch {}
      try {
        $ssl.AuthenticateAsClient($uri.Host, $null, $protocols, $false)
      } catch {
        if ($script:_PolarisPinObserved -ne '' -and -not $script:_PolarisPinMatches) {
          throw "Cert pin mismatch: expected $ExpectedPin, got $script:_PolarisPinObserved"
        }
        throw
      }
      if (-not $script:_PolarisPinMatches) {
        throw "Cert pin mismatch: expected $ExpectedPin, got $script:_PolarisPinObserved"
      }

      $req = "GET $($uri.PathAndQuery) HTTP/1.1\`r\`nHost: $($uri.Host)\`r\`nUser-Agent: polaris-agent-install\`r\`nAccept: */*\`r\`nConnection: close\`r\`n\`r\`n"
      $reqBytes = [System.Text.Encoding]::ASCII.GetBytes($req)
      $ssl.Write($reqBytes, 0, $reqBytes.Length)
      $ssl.Flush()

      # Read headers byte-by-byte until CRLF CRLF — StreamReader would buffer
      # past the header/body boundary and eat binary body bytes.
      $hdr = New-Object System.Collections.ArrayList
      $state = 0
      while ($true) {
        $b = $ssl.ReadByte()
        if ($b -lt 0) { throw "Connection closed before headers complete" }
        [void]$hdr.Add([byte]$b)
        if     ($state -eq 0 -and $b -eq 13) { $state = 1 }
        elseif ($state -eq 1 -and $b -eq 10) { $state = 2 }
        elseif ($state -eq 2 -and $b -eq 13) { $state = 3 }
        elseif ($state -eq 3 -and $b -eq 10) { break }
        else { $state = 0 }
      }
      $headers = [System.Text.Encoding]::ASCII.GetString($hdr.ToArray())

      if ($headers -notmatch '^HTTP/1\\.\\d\\s+(\\d{3})\\s') {
        $preview = $headers.Substring(0, [Math]::Min(200, $headers.Length))
        throw "Bad HTTP response from $Url : $preview"
      }
      $status = [int]$Matches[1]
      if ($status -ne 200) { throw "HTTP $status fetching $Url" }

      $contentLength = $null
      foreach ($line in ($headers -split "\`r\`n")) {
        if ($line -match '^Content-Length:\\s*(\\d+)\\s*$') {
          $contentLength = [int64]$Matches[1]
        }
      }
      if ($null -eq $contentLength) { throw "Server omitted Content-Length on $Url" }

      $fs = [System.IO.File]::Open($OutFile, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
      try {
        $buf = New-Object byte[] 65536
        $remaining = $contentLength
        while ($remaining -gt 0) {
          $toRead = [int][Math]::Min($buf.Length, $remaining)
          $n = $ssl.Read($buf, 0, $toRead)
          if ($n -le 0) { throw "Connection closed before body complete ($remaining bytes missing)" }
          $fs.Write($buf, 0, $n)
          $remaining -= $n
        }
      } finally { $fs.Close() }
    } finally { $ssl.Dispose() }
  } finally { $tcp.Close() }
}
`;

// PowerShell install template — runs on the target host.
//
// Substitutions (literal text replace, no escaping needed because all
// placeholder values are server-controlled and don't contain ': or `$):
//   __SERVER_URL__         e.g. https://polaris.example.com:3000
//   __CERT_FINGERPRINT__   e.g. sha256:ab12cd34...
//   __BINARY_FILENAME__    e.g. polaris-agent-0.1.0-windows-amd64.exe
//   __AGENT_CONF_B64__     base64 of the rendered agent.conf body
//
// Download path: the embedded Invoke-PolarisPinnedDownload helper above
// performs an SslStream-based HTTPS GET with the pin verified inside the
// TLS handshake callback. We don't use Invoke-WebRequest here — see the
// helper's banner for why.
const WINDOWS_INSTALL_PS = `$ErrorActionPreference = 'Stop'
${POLARIS_PS_PINNED_DOWNLOAD_FN}

$serverUrl     = '__SERVER_URL__'
$pin           = '__CERT_FINGERPRINT__'.ToLower()
$binaryName    = '__BINARY_FILENAME__'
$confB64       = '__AGENT_CONF_B64__'

$installDir = Join-Path $env:ProgramFiles 'Polaris\\Agent'
$confDir    = Join-Path $env:ProgramData  'Polaris\\agent'
$binaryPath = Join-Path $installDir 'polaris-agent.exe'
$confPath   = Join-Path $confDir    'agent.conf'

New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path $confDir    | Out-Null

# Stop + remove any existing install so reinstall is idempotent.
$svc = Get-Service -Name 'polaris-agent' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name 'polaris-agent' -Force -ErrorAction SilentlyContinue }
  & sc.exe delete polaris-agent | Out-Null
  # sc.exe is async — give it a moment to release the binary lock.
  Start-Sleep -Seconds 2
}

$downloadUrl = "$serverUrl/api/v1/agents/binary/$binaryName"
Invoke-PolarisPinnedDownload -Url $downloadUrl -OutFile $binaryPath -ExpectedPin $pin

# Write agent.conf from the embedded base64. Atomic-ish via .tmp + Move-Item.
$confBytes = [Convert]::FromBase64String($confB64)
$tmpConf   = "$confPath.tmp"
[IO.File]::WriteAllBytes($tmpConf, $confBytes)
Move-Item -Force -LiteralPath $tmpConf -Destination $confPath

# ACL: only Administrators + SYSTEM read the config (the bearer is in it).
$acl = Get-Acl $confPath
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
$adminRule  = New-Object Security.AccessControl.FileSystemAccessRule('BUILTIN\\Administrators','FullControl','Allow')
$systemRule = New-Object Security.AccessControl.FileSystemAccessRule('NT AUTHORITY\\SYSTEM','FullControl','Allow')
$acl.AddAccessRule($adminRule)
$acl.AddAccessRule($systemRule)
Set-Acl -Path $confPath -AclObject $acl

# Register the Windows Service. New-Service is the canonical way to create
# a Windows Service from PowerShell on every supported Windows version;
# we explicitly avoid Get-WmiObject / Win32_Service which is DCOM-based
# and deprecated in PowerShell 7+.
New-Service -Name 'polaris-agent' \`
            -DisplayName 'Polaris Agent' \`
            -Description 'Polaris Agent — pushes monitoring samples to Polaris over HTTPS.' \`
            -BinaryPathName ('"' + $binaryPath + '" -conf "' + $confPath + '"') \`
            -StartupType Automatic | Out-Null

# Service recovery actions: restart on first/second/third failure with a 5s delay.
# sc.exe is the only well-supported path for this; New-Service doesn't expose it.
& sc.exe failure polaris-agent reset= 86400 actions= restart/5000/restart/5000/restart/10000 | Out-Null

Start-Service -Name 'polaris-agent'

Write-Host "Polaris Agent installed and started"
`;

const WINDOWS_UNINSTALL_PS = `$ErrorActionPreference = 'Continue'

$svc = Get-Service -Name 'polaris-agent' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name 'polaris-agent' -Force -ErrorAction SilentlyContinue }
  & sc.exe delete polaris-agent | Out-Null
  Start-Sleep -Seconds 2
}

$installDir = Join-Path $env:ProgramFiles 'Polaris\\Agent'
$confDir    = Join-Path $env:ProgramData  'Polaris\\agent'
if (Test-Path $installDir) { Remove-Item -Recurse -Force -LiteralPath $installDir }
if (Test-Path $confDir)    { Remove-Item -Recurse -Force -LiteralPath $confDir }

Write-Host "Polaris Agent removed"
exit 0
`;

// ─── Upgrade SSH/WinRM helpers ────────────────────────────────────────
//
// In contrast to install, upgrade does NOT touch agent.conf — the bearer
// + cert pin survive so the host-side agent reconnects with the same
// identity. The Linux/macOS path SFTPs a fresh binary to /tmp then runs
// a tiny upgrade shell script that stops the service, replaces the
// binary, starts the service. The Windows path runs an embedded
// PowerShell script that uses the same cert-pin-verified
// Invoke-WebRequest the install path uses — so the binary is pulled
// from the running Polaris server's /api/v1/agents/binary endpoint,
// not from anywhere else on the network.

interface SshUpgradeParams {
  host: string;
  cred: Record<string, unknown>;
  binaryBytes: Buffer;
  platform: "linux" | "darwin";
  testOverrides?: TestOverrides;
}

async function sshUpgrade(p: SshUpgradeParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);

  await withSshClient(p.host, p.cred, async (client) => {
    await sftpPut(client, "/tmp/polaris-agent.new",         p.binaryBytes, 0o755);
    await sftpPut(client, "/tmp/polaris-agent-upgrade.sh",  upgradeScript(p.platform), 0o700);
    const out = await sshExec(client, "sudo -n bash /tmp/polaris-agent-upgrade.sh", 60_000);
    if (out.exitCode !== 0) {
      throw new AppError(502, `Upgrade exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
    }
  });
}

interface WinRmUpgradeParams {
  host: string;
  cred: Record<string, unknown>;
  binaryFilename: string;
  serverUrl: string;
  certFingerprint: string;
  testOverrides?: TestOverrides;
}

async function winrmUpgrade(p: WinRmUpgradeParams): Promise<void> {
  if (p.testOverrides?.fakeSshSucceed) return;
  if (p.testOverrides?.fakeSshFail) throw new AppError(502, p.testOverrides.fakeSshFail);

  const conn = winrmConnectionFromCred(p.host, p.cred);
  const ps = WINDOWS_UPGRADE_PS
    .replace(/__SERVER_URL__/g,       p.serverUrl)
    .replace(/__CERT_FINGERPRINT__/g, p.certFingerprint)
    .replace(/__BINARY_FILENAME__/g,  p.binaryFilename);
  const encoded = Buffer.from(ps, "utf16le").toString("base64");
  const out = await winrmRunOne(conn, "powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-EncodedCommand", encoded,
  ]);
  if (out.exitCode !== 0) {
    throw new AppError(502, `Windows upgrade exited ${out.exitCode}: ${truncate(out.stderr || out.stdout, 400)}`);
  }
}

function upgradeScript(platform: "linux" | "darwin"): Buffer {
  return Buffer.from(platform === "linux" ? LINUX_UPGRADE_SCRIPT : DARWIN_UPGRADE_SCRIPT, "utf8");
}

const LINUX_UPGRADE_SCRIPT = `#!/usr/bin/env bash
# Polaris Agent upgrader (Linux/systemd). Run by polaris-agent-upgrade.sh
# as root via sudo -n. Replaces the binary in place; leaves agent.conf
# (which has the bearer + cert pin) untouched so the agent reconnects
# with the same identity.
set -euo pipefail

BIN_NEW=/tmp/polaris-agent.new
BIN_DST=/usr/local/bin/polaris-agent

if [ ! -f "\${BIN_NEW}" ]; then
  echo "Upgrade binary missing at \${BIN_NEW}" >&2
  exit 1
fi

systemctl stop polaris-agent || true
install -m 0755 -o root -g root "\${BIN_NEW}" "\${BIN_DST}"
systemctl start polaris-agent
rm -f "\${BIN_NEW}"
echo "Polaris Agent upgraded"
`;

const DARWIN_UPGRADE_SCRIPT = `#!/usr/bin/env bash
# Polaris Agent upgrader (macOS/launchd).
set -euo pipefail

BIN_NEW=/tmp/polaris-agent.new
BIN_DST=/usr/local/bin/polaris-agent
PLIST=/Library/LaunchDaemons/com.polaris.agent.plist

if [ ! -f "\${BIN_NEW}" ]; then
  echo "Upgrade binary missing at \${BIN_NEW}" >&2
  exit 1
fi
if [ -f "\${PLIST}" ]; then
  launchctl unload "\${PLIST}" 2>/dev/null || true
fi
install -m 0755 -o root -g wheel "\${BIN_NEW}" "\${BIN_DST}"
if [ -f "\${PLIST}" ]; then
  launchctl load "\${PLIST}"
fi
rm -f "\${BIN_NEW}"
echo "Polaris Agent upgraded"
`;

const WINDOWS_UPGRADE_PS = `$ErrorActionPreference = 'Stop'
${POLARIS_PS_PINNED_DOWNLOAD_FN}

$serverUrl  = '__SERVER_URL__'
$pin        = '__CERT_FINGERPRINT__'.ToLower()
$binaryName = '__BINARY_FILENAME__'

$installDir = Join-Path $env:ProgramFiles 'Polaris\\Agent'
$binaryPath = Join-Path $installDir 'polaris-agent.exe'
$tmpPath    = Join-Path $installDir 'polaris-agent.new.exe'

if (-not (Test-Path $installDir)) {
  throw "Polaris Agent isn't installed at $installDir — upgrade refused. Use Install instead."
}

# Same cert-pinned download flow the installer uses. Pull the new binary
# to a .new.exe alongside the live one, then atomic Move-Item over the
# top after stopping the service.
$downloadUrl = "$serverUrl/api/v1/agents/binary/$binaryName"
Invoke-PolarisPinnedDownload -Url $downloadUrl -OutFile $tmpPath -ExpectedPin $pin

# Stop service, swap binary, restart. The agent.conf file is untouched
# so the new binary keeps the same bearer + cert pin.
$svc = Get-Service -Name 'polaris-agent' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name 'polaris-agent' -Force }
}
# Brief wait so the service truly releases the binary lock.
Start-Sleep -Seconds 1
Move-Item -Force -LiteralPath $tmpPath -Destination $binaryPath
Start-Service -Name 'polaris-agent'

Write-Host "Polaris Agent upgraded"
`;
