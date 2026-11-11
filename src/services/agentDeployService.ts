/**
 * src/services/agentDeployService.ts — the operator verbs on ONE asset's
 * Polaris Agent: the agent card, install kickoff, retry, reinstall, upgrade
 * and removal (force or remote uninstall). Moved out of
 * routes/assets/agent.ts (CQ-B062 slice 2); the route keeps the Zod schemas,
 * the agentDeploy / assets gates and the 204 for "no agent". The heavy
 * services (agentInstallService, agentTokenService, certInfo, capEff,
 * agentInstallScripts) are still loaded on demand, as the route did.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { assetDialAddress } from "../utils/assetDialAddress.js";
import { ipv6Dialable } from "./ipv6GateService.js";
import { logEvent } from "./eventLogService.js";
import { getCredential } from "./credentialService.js";
import { assetSourceKindFromIntegrationType, isPollingMethodCompatible } from "../utils/pollingCompatibility.js";
import { publicBaseUrl } from "../utils/publicUrl.js";

/**
 * GET /assets/:id/agent — the agent card: the ManagedAgent row with the
 * secret-bearing fields stripped plus the decoded verified capabilities, or
 * null when the asset has no agent (the route answers 204, not 404).
 */
export async function getAgentCard(assetId: string) {
  const row = await prisma.managedAgent.findUnique({ where: { assetId } });
  // No agent is an ordinary answer, not an error: 204 No Content. The asset
  // panel asks this for every device it opens, and a 404 here put a red
  // "Failed to load resource" line in the browser console on every
  // agent-less panel (found by scripts/smoke-frontend.mjs, 2026-11-06).
  // api.js maps a 204 to null, which is what its callers already expect.
  // The ACTION routes below (retry, upgrade, uninstall …) keep their 404:
  // acting on an agent that is not there is an error.
  if (!row) return null;
  // Strip secret-bearing fields before serializing.
  const {
    enrollmentTokenHash: _eh, enrollmentTokenPrefix: _ep,
    bearerHash: _bh,
    ...safe
  } = row;
  // Decoded verified-capability state (null = not reported yet). The
  // System-tab Privileges row renders from this when present so a
  // pre-DAC-fix ptrace unit reads as broken instead of healthy.
  const { decodeCapEff } = await import("../utils/capEff.js");
  return { ...safe, caps: decodeCapEff(row.reportedCapEff) };
}

export interface AgentInstallInput {
  credentialId: string;
  osPlatform: "linux" | "darwin" | "windows";
  arch: "amd64" | "arm64";
  transport?: "ssh" | "winrm";
  scriptId?: string;
  privilegeTier?: "unprivileged" | "ptrace";
  allowReboot?: boolean;
}

/**
 * POST /assets/:id/agent/install — refuse what cannot take an agent (Fortinet
 * sources, hypervisors, containers), resolve and check the transport, the
 * install-method variant and the credential type, 409 on an existing row,
 * require a server cert to pin and a URL the remote agent can call back on,
 * then create the ManagedAgent row, write agent.install_kickoff and start the
 * async install.
 */
export async function kickoffAgentInstall(assetId: string, body: AgentInstallInput, actor: string) {
  const asset = await prisma.asset.findUnique({
    where: { id: assetId },
    include: { discoveredByIntegration: true },
  });
  if (!asset) throw new AppError(404, "Asset not found");

  // Compatibility check: agent is incompatible with Fortinet appliance
  // sources. The Zod validator + the resolver would reject the polling
  // method itself, but install kickoff has its own check because the
  // operator might click Install before flipping any stream to "agent".
  const sourceKind = assetSourceKindFromIntegrationType(asset.discoveredByIntegration?.type ?? null);
  if (!isPollingMethodCompatible(sourceKind, "agent")) {
    throw new AppError(400,
      `Polaris Agent is not compatible with ${sourceKind} sources. Compatible: manual, activedirectory, entraid, windowsserver, vcenter (VMs).`);
  }
  // vCenter VMs are guest OSes and take the agent fine — but ESXi hosts
  // can't run third-party binaries. Gate on the asset's class, not the
  // integration type (the vcenter source matrix must allow "agent" for VMs).
  if (asset.assetType === "hypervisor") {
    throw new AppError(400, "Polaris Agent cannot be installed on a hypervisor host (ESXi, Unraid, TrueNAS SCALE).");
  }
  // A container is not a machine: the agent would land in an image layer
  // the next update throws away. Its host's integration reports it.
  if (asset.assetType === "container") {
    throw new AppError(400, "Polaris Agent cannot be installed on a container.");
  }

  // Resolve transport: explicit body value wins; otherwise default by
  // osPlatform (linux/darwin → ssh; windows → winrm). Linux + macOS only
  // support SSH — refuse a winrm pick there.
  const transport = body.transport ?? (body.osPlatform === "windows" ? "winrm" : "ssh");
  if (transport === "winrm" && body.osPlatform !== "windows") {
    throw new AppError(400,
      `WinRM transport is only valid for Windows hosts — osPlatform=${body.osPlatform}`);
  }

  // Validate the chosen install-method variant against the target OS (the
  // OS-lock). Throws 400 on unknown id or OS mismatch; returns the concrete
  // id to persist (the per-OS default when none was picked).
  const { resolveInstallScriptId } = await import("./agentInstallScripts.js");
  resolveInstallScriptId(body.osPlatform, body.scriptId);

  // Credential type must match the transport (ssh-typed cred for SSH,
  // winrm-typed cred for WinRM). Both transports are available for
  // Windows; only SSH is available for linux/darwin.
  const cred = await getCredential(body.credentialId).catch(() => null);
  if (!cred) throw new AppError(400, `Credential ${body.credentialId} not found`);
  if (cred.type !== transport) {
    throw new AppError(400,
      `Credential type "${cred.type}" doesn't match transport "${transport}" — need a "${transport}" credential`);
  }

  // 409 if a row already exists. Operator uses /reinstall to wipe + retry.
  const existing = await prisma.managedAgent.findUnique({ where: { assetId } });
  if (existing) {
    throw new AppError(409,
      `Agent already installed (status=${existing.installStatus}). Use reinstall to start over.`);
  }

  // Cert pin: we capture the SHA-256 of the running Polaris leaf cert
  // at this moment and bake it into the agent's config at install. If
  // HTTPS isn't running, there's no cert to pin and no encrypted
  // transport — refuse the install with a clear error rather than
  // silently issuing a bearer that the agent won't be able to use.
  const { getServerCertFingerprint } = await import("./certInfo.js");
  const fingerprint = getServerCertFingerprint();
  if (!fingerprint) {
    throw new AppError(400,
      "HTTPS is not running on this Polaris server — agent install requires TLS for the cert pin. " +
      "Enable HTTPS in Server Settings → HTTPS first.");
  }

  // The remote agent must be able to call back to Polaris. agent.conf's
  // server_url gets stamped via inferOwnServerUrl() which prefers (in
  // order) POLARIS_PUBLIC_URL → the running cert's first DNS SAN →
  // the cert's CN → an IP SAN → POLARIS_PUBLIC_HOST → localhost. The
  // final localhost fallback only works for same-box installs; on
  // every remote install it produces an agent that connection-refuses
  // against its own loopback. Refuse early when ALL the above sources
  // fail for a remote-host install.
  if (!publicBaseUrl() && !process.env.POLARIS_PUBLIC_HOST) {
    const targetHost = assetDialAddress(asset, ipv6Dialable()) || asset.dnsName || asset.hostname || "";
    const isSameBox = targetHost === "127.0.0.1" || targetHost === "::1" ||
                      targetHost === "localhost" || targetHost.toLowerCase() === "localhost.localdomain";
    if (!isSameBox) {
      // Check whether the cert can supply a hostname before bailing.
      const { getServerCertHostnames } = await import("./certInfo.js");
      const hosts = getServerCertHostnames();
      const certHost = hosts?.dnsSans[0] || hosts?.cn || hosts?.ipSans[0] || null;
      if (!certHost || certHost === "localhost" || certHost === "127.0.0.1" || certHost === "::1") {
        throw new AppError(400,
          "Polaris doesn't know what URL to embed in the remote agent's agent.conf. " +
          "Set POLARIS_PUBLIC_URL in /opt/polaris/.env to your Polaris server's public URL " +
          "(e.g. https://polaris.example.com:3000) and restart Polaris, OR regenerate the " +
          "HTTPS cert under Server Settings → Web Server with a CN/SAN matching the " +
          "hostname remote hosts use to reach Polaris (the agent install path picks the " +
          "URL up from there automatically). Then retry the install.");
      }
    }
  }

  const row = await prisma.managedAgent.create({
    data: {
      assetId,
      osPlatform:            body.osPlatform,
      arch:                  body.arch,
      installedBy:           actor,
      installStatus:         "pending",
      serverCertFingerprint: fingerprint,
      installCredentialId:   body.credentialId,
      installTransport:      transport,
      installScriptId:       body.scriptId ?? null,
      // Privilege tier is a Linux-only concept; other OSes stay "unprivileged".
      privilegeTier:         body.osPlatform === "linux" ? (body.privilegeTier ?? "unprivileged") : "unprivileged",
      rebootEnabled:         body.allowReboot === true,
    },
  });

  await logEvent({
    action:       "agent.install_kickoff",
    resourceType: "asset",
    resourceId:   assetId,
    actor,
    level:        "info",
    message:      `Polaris Agent install kicked off (${body.osPlatform}/${body.arch}, ${transport}${body.allowReboot ? ", reboots allowed" : ""})`,
    details:      { managedAgentId: row.id, credentialId: body.credentialId, transport, scriptId: body.scriptId ?? null, allowReboot: body.allowReboot === true },
  });

  // Fire the async install. The service mints its own enrollment token,
  // SFTPs the binary + agent.conf, runs the installer, and transitions
  // installStatus as it goes. The UI polls GET /:id/agent to watch
  // progress; failure lands as installStatus="failed" + installError.
  const { startInstall } = await import("./agentInstallService.js");
  await startInstall({ managedAgentId: row.id, credentialId: body.credentialId });

  return {
    managedAgentId:        row.id,
    installStatus:         row.installStatus,
    serverCertFingerprint: fingerprint,
  };
}

/**
 * POST /assets/:id/agent/retry — reset a FAILED install to pending (404 no
 * row, 409 not failed, 400 when its credential is gone), write
 * agent.install_retry and start the install again.
 */
export async function retryAgentInstall(assetId: string, actor: string) {
  const row = await prisma.managedAgent.findUnique({ where: { assetId } });
  if (!row) throw new AppError(404, "No agent row to retry for this asset");
  if (row.installStatus !== "failed") {
    throw new AppError(409,
      `Agent installStatus is "${row.installStatus}"; only failed installs can be retried.`);
  }
  if (!row.installCredentialId) {
    throw new AppError(400,
      "No install credential on file (credential was deleted). " +
      "Force-remove the agent and start a fresh install.");
  }

  // Make sure the credential still exists before we reset the row —
  // otherwise startInstall would flip us right back to "failed" with
  // a less actionable error.
  const cred = await getCredential(row.installCredentialId).catch(() => null);
  if (!cred) {
    throw new AppError(400,
      "Original install credential no longer exists. " +
      "Force-remove the agent and start a fresh install.");
  }

  await prisma.managedAgent.update({
    where: { id: row.id },
    data:  { installStatus: "pending", installError: null },
  });

  await logEvent({
    action:       "agent.install_retry",
    resourceType: "asset",
    resourceId:   assetId,
    actor,
    level:        "info",
    message:      `Polaris Agent install retried (${row.osPlatform}/${row.arch})`,
    details:      { managedAgentId: row.id, credentialId: row.installCredentialId },
  });

  const { startInstall } = await import("./agentInstallService.js");
  await startInstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

  return {
    managedAgentId: row.id,
    installStatus:  "pending",
  };
}

/**
 * POST /assets/:id/agent/reinstall — start over with the stored install
 * params whatever the status: revoke the bearer, settle the Linux privilege
 * tier (a legacy root agent downgrades unless `bodyTier` picks one), write
 * agent.reinstall_kickoff and start the install under an agent-reinstall
 * maintenance hold (rule 80).
 */
export async function reinstallAgent(assetId: string, actor: string, bodyTier: "unprivileged" | "ptrace" | undefined) {
  const row = await prisma.managedAgent.findUnique({ where: { assetId } });
  if (!row) throw new AppError(404, "No agent installed for this asset");
  if (!row.installCredentialId) {
    throw new AppError(400,
      "No install credential on file (credential was deleted). " +
      "Force-remove the agent and start a fresh install.");
  }

  // Make sure the credential still exists before we reset the row —
  // otherwise startInstall would flip us right back to "failed".
  const cred = await getCredential(row.installCredentialId).catch(() => null);
  if (!cred) {
    throw new AppError(400,
      "Original install credential no longer exists. " +
      "Force-remove the agent and start a fresh install.");
  }

  // Kill the current bearer immediately — the re-enroll issues a fresh
  // one. Anything the old agent process does before it re-enrolls is
  // rejected, which is what we want during a reinstall.
  const { revokeBearer } = await import("./agentTokenService.js");
  await revokeBearer(row.id);

  // Optional privilege change on reinstall (Linux only). A reinstall can only
  // produce the unprivileged or ptrace unit — full root is retired, so a legacy
  // "root" agent DOWNGRADES to unprivileged unless the operator explicitly
  // picks a tier. Ignored on Windows (LocalSystem).
  const nextTier: "unprivileged" | "ptrace" =
    row.osPlatform !== "linux" ? "unprivileged"
    : bodyTier !== undefined ? bodyTier
    : row.privilegeTier === "ptrace" ? "ptrace"
    : "unprivileged"; // legacy "root" (or already unprivileged) → unprivileged

  await prisma.managedAgent.update({
    where: { id: row.id },
    data:  { installStatus: "pending", installError: null, privilegeTier: nextTier },
  });

  await logEvent({
    action:       "agent.reinstall_kickoff",
    resourceType: "asset",
    resourceId:   assetId,
    actor,
    level:        "info",
    message:      `Polaris Agent reinstall kicked off (${row.osPlatform}/${row.arch}, ${row.installTransport}${row.osPlatform === "linux" ? ", " + nextTier : ""})`,
    details:      { managedAgentId: row.id, credentialId: row.installCredentialId, privilegeTier: nextTier },
  });

  const { startInstall } = await import("./agentInstallService.js");
  // A reinstall stops an agent that is running right now — hold the asset in
  // maintenance so the disconnect it causes doesn't page anyone (rule 80).
  // /retry and a first install pass no kind: nothing is running to drop.
  await startInstall({
    managedAgentId: row.id,
    credentialId:   row.installCredentialId,
    holdKind:       "agent-reinstall",
  });

  return {
    managedAgentId: row.id,
    installStatus:  "pending",
  };
}

/**
 * POST /assets/:id/agent/upgrade — 404 without an agent row; otherwise
 * startUpgrade, whose own AppErrors (no credential, already current, missing
 * manifest) reach the operator as they are.
 */
export async function upgradeAgent(assetId: string, credentialId: string | undefined, actor: string) {
  const row = await prisma.managedAgent.findUnique({ where: { assetId } });
  if (!row) throw new AppError(404, "No agent installed for this asset");

  const { startUpgrade } = await import("./agentInstallService.js");
  // startUpgrade does its own AppError on no-credential / already-current /
  // missing manifest; let those propagate to the global error handler so
  // the operator sees the message inline.
  const result = await startUpgrade({
    managedAgentId: row.id,
    credentialId,
    actor,
  });
  return {
    managedAgentId: row.id,
    fromVersion:    result.fromVersion,
    toVersion:      result.toVersion,
    installStatus:  "upgrading",
  };
}

/**
 * DELETE /assets/:id/agent — revoke the bearer at once, then either drop the
 * row and reset the asset's agent polling / Application Map facts (`force`,
 * agent.force_removed), or write agent.revoked and start the remote uninstall
 * with the install credential (left "revoked" with a warning when that
 * credential is gone).
 */
export async function removeAgent(assetId: string, actor: string, force: boolean) {
  const row = await prisma.managedAgent.findUnique({ where: { assetId } });
  if (!row) throw new AppError(404, "No agent installed for this asset");

  // Phase 1 of the two-phase DELETE: synchronous revoke. The bearer
  // stops working immediately regardless of whether the host can be
  // reached. Phase 4 will add the async remote-uninstall pass.
  const { revokeBearer } = await import("./agentTokenService.js");
  await revokeBearer(row.id);

  if (force) {
    // Hard-delete the local row. Orphan binary remains on the host
    // (operator's choice when ?force=true); the bearer is dead so it
    // can't talk to Polaris. Also clear the *Polling fields back to
    // null so the periodic puller resumes per the source default —
    // mirrors what runUninstall does on the non-force path. Removing the
    // agent also tears the host off the Application Map: clear the map
    // pins + delete its connection facts (nothing collects them anymore,
    // and the pinned child nodes would otherwise render forever).
    await prisma.$transaction([
      prisma.managedAgent.delete({ where: { id: row.id } }),
      prisma.asset.update({
        where: { id: assetId },
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
      prisma.assetProcessConnection.deleteMany({ where: { assetId } }),
    ]);
    await logEvent({
      action:       "agent.force_removed",
      resourceType: "asset",
      resourceId:   assetId,
      actor,
      level:        "warning",
      message:      `Polaris Agent force-removed; bearer revoked, remote uninstall skipped`,
      details:      { managedAgentId: row.id },
    });
    return { ok: true, forced: true };
  }

  // Default DELETE path: revoke + async remote uninstall using the
  // credential stored at install time. On success, startUninstall
  // hard-deletes the row and emits agent.uninstalled; on failure it
  // transitions to installStatus="uninstall_failed" and emits
  // agent.uninstall_failed (warning) — operator can retry or fall
  // back to ?force=true.
  //
  // Emit the bearer-revoke event before kicking off the remote work
  // so the audit trail captures the synchronous half regardless of
  // what happens to the remote side. Bearer is already dead.
  await logEvent({
    action:       "agent.revoked",
    resourceType: "asset",
    resourceId:   assetId,
    actor,
    level:        "warning",
    message:      "Polaris Agent bearer revoked",
    details:      { managedAgentId: row.id },
  });

  if (!row.installCredentialId) {
    // No credential on file (e.g. it was deleted; SetNull cascade
    // cleared the FK). Operator can either delete the credential
    // back into existence then DELETE again, or use ?force=true.
    // Leave the row in "revoked" — bearer is dead, host has an orphan
    // binary, but Polaris won't keep retrying with no credential.
    await prisma.managedAgent.update({
      where: { id: row.id },
      data: { installStatus: "revoked" },
    });
    return {
      ok: true,
      forced: false,
      installStatus: "revoked",
      warning: "No install credential on file — remote uninstall skipped. " +
               "Use ?force=true to drop the local row entirely, or restore the credential and DELETE again.",
    };
  }

  const { startUninstall } = await import("./agentInstallService.js");
  await startUninstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

  return { ok: true, forced: false, installStatus: "uninstalling" };
}
