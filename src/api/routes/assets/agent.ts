/**
 * src/api/routes/assets/agent.ts — Polaris Agent deployment on an asset: bulk install, the per-asset agent card,
 * install / retry / reinstall / upgrade / uninstall (agentDeploy=write). Split out of
 * routes/assets.ts (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { boolQuery } from "../../../utils/queryParams.js";
import { z } from "zod";
import { prisma } from "../../../db.js";
import { AppError } from "../../../utils/errors.js";
import { assetDialAddress } from "../../../utils/assetDialAddress.js";
import { ipv6Dialable } from "../../../services/ipv6GateService.js";
import { requirePermission } from "../../middleware/permissions.js";
import { requestActor } from "../../middleware/auth.js";
import { logEvent } from "../events.js";
import { getCredential } from "../../../services/credentialService.js";
import { assetSourceKindFromIntegrationType, isPollingMethodCompatible } from "../../../utils/pollingCompatibility.js";
import { publicBaseUrl } from "../../../utils/publicUrl.js";

const router = Router();

// POST /api/v1/assets/bulk-agent-install — kick off Polaris Agent installs on
// every selected asset at once (assets-page bulk bar "Deploy Agent"). OS
// platform + transport are resolved per asset the way discovery auto-deploy
// does (inferAgentPlatform: Windows → WinRM credential with SSH fallback,
// everything else → SSH); ineligible assets (agent in any state but "failed",
// hypervisor, Fortinet source, unreachable, no matching credential) come back
// as skipped with a reason instead of failing the batch. An asset whose agent
// install FAILED is retried in place (the /:id/agent/retry reset, with this
// batch's credentials) and counted in `retried`. Remote installs run in a
// bounded background pool — the response returns immediately and the UI
// watches per-asset installStatus.
const BulkAgentInstallSchema = z.object({
  ids:               z.array(z.string()).min(1).max(200),
  sshCredentialId:   z.string().uuid().optional(),
  winrmCredentialId: z.string().uuid().optional(),
  arch:              z.enum(["amd64", "arm64"]).default("amd64"),
  // Per-OS install-method variant (bulk spans mixed OSes; the service applies
  // each per an asset's inferred platform). Omitted keys use the per-OS
  // default. OS-locked server-side by bulkInstallAgents.
  scriptIds:         z.object({
    linux:   z.string().max(100).optional(),
    darwin:  z.string().max(100).optional(),
    windows: z.string().max(100).optional(),
  }).partial().optional(),
  // Linux privilege tier (ignored for Windows/darwin). "ptrace" grants
  // CAP_SYS_PTRACE for Application Map connection attribution. Applies to every
  // Linux host in the selection. Full root is no longer selectable.
  privilegeTier:     z.enum(["unprivileged", "ptrace"]).optional(),
  // Reboot opt-in for every host in the selection (business rule 115).
  allowReboot:       z.boolean().optional(),
}).refine((b) => b.sshCredentialId || b.winrmCredentialId, {
  message: "Provide at least one credential (SSH and/or WinRM)",
});

// ─── Polaris Agent deployment (assets=fullwrite) ─────────────────────────
//
// Every verb that PUSHES, REPLACES or REMOVES the agent on a host is gated
// one notch above the rest of this router: `assets=fullwrite`, not `write`.
// Deploying the agent runs an installer on someone else's machine over a
// stored SSH / WinRM credential and leaves a service behind — a materially
// different act from editing an inventory record, and the one action on the
// assets key that reaches outside Polaris to change a host. Built-in roles:
// admin only (assets=fullwrite); `assetsadmin` keeps full inventory editing
// at `write` and no longer reaches deployment. Reads (GET /:id/agent, GET
// /agent-install-scripts) stay at `read` — an operator who cannot deploy can
// still see what is installed. The client hides these controls behind
// canDeployAgent() in public/js/app.js; keep the two in lockstep.

router.post("/bulk-agent-install", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const input = BulkAgentInstallSchema.parse(req.body);
    const actor = requestActor(req) || "unknown";
    const { bulkInstallAgents } = await import("../../../services/agentInstallService.js");
    const result = await bulkInstallAgents({
      assetIds:          input.ids,
      sshCredentialId:   input.sshCredentialId ?? null,
      winrmCredentialId: input.winrmCredentialId ?? null,
      arch:              input.arch,
      scriptIds:         input.scriptIds,
      privilegeTier:     input.privilegeTier,
      allowReboot:       input.allowReboot,
      actor,
    });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── Polaris Agent — operator-facing routes ──────────────────────────────────
//
// Phase 2 surface: stubs the actual remote install (which lives in
// agentInstallService — Phase 4) by just creating the ManagedAgent row
// and minting a one-shot enrollment token. End-to-end testable with curl:
// hit POST /install to get a managedAgentId + check the row, then have
// the agent (or curl-as-agent) POST /api/v1/agents/enroll with the
// enrollment token to swap it for a bearer. Phase 4 wires the SSH/WinRM
// file upload + remote service start that automates the agent-side work.

const AgentInstallSchema = z.object({
  credentialId: z.string().uuid("credentialId must be a UUID"),
  osPlatform:   z.enum(["linux", "darwin", "windows"]),
  arch:         z.enum(["amd64", "arm64"]),
  // Remote transport. Optional for backward-compat with older clients; when
  // omitted we default linux/darwin → ssh, windows → winrm (the pre-change
  // behavior). Operators installing the agent on a Windows host that has
  // OpenSSH Server enabled can pick "ssh" to use an SSH credential instead.
  transport:    z.enum(["ssh", "winrm"]).optional(),
  // Curated install-method variant id (see agentInstallScripts catalog).
  // Optional — omitted uses the per-OS default. OS-locked server-side.
  scriptId:     z.string().max(100).optional(),
  // Linux privilege tier: "unprivileged" (default, hardened DynamicUser unit) or
  // "ptrace" (unprivileged + CAP_SYS_PTRACE, enabling Application Map connection
  // attribution without full root). Ignored on Windows (LocalSystem) / darwin
  // (LaunchDaemon runs as root). Full root is no longer selectable.
  privilegeTier: z.enum(["unprivileged", "ptrace"]).optional(),
  // Reboot opt-in (business rule 115): install the host-side permission (the
  // marker, and on Linux the polkit rule) so the asset's Reboot button can
  // reboot this host. Default off; changeable later from the agent card.
  allowReboot: z.boolean().optional(),
});

router.get("/:id/agent", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    // No agent is an ordinary answer, not an error: 204 No Content. The asset
    // panel asks this for every device it opens, and a 404 here put a red
    // "Failed to load resource" line in the browser console on every
    // agent-less panel (found by scripts/smoke-frontend.mjs, 2026-11-06).
    // api.js maps a 204 to null, which is what its callers already expect.
    // The ACTION routes below (retry, upgrade, uninstall …) keep their 404:
    // acting on an agent that is not there is an error.
    if (!row) return res.status(204).end();
    // Strip secret-bearing fields before serializing.
    const {
      enrollmentTokenHash: _eh, enrollmentTokenPrefix: _ep,
      bearerHash: _bh,
      ...safe
    } = row;
    // Decoded verified-capability state (null = not reported yet). The
    // System-tab Privileges row renders from this when present so a
    // pre-DAC-fix ptrace unit reads as broken instead of healthy.
    const { decodeCapEff } = await import("../../../utils/capEff.js");
    res.json({ ...safe, caps: decodeCapEff(row.reportedCapEff) });
  } catch (err) { next(err); }
});

router.post("/:id/agent/install", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const body = AgentInstallSchema.parse(req.body);
    const actor = requestActor(req) || "unknown";

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
    const { resolveInstallScriptId } = await import("../../../services/agentInstallScripts.js");
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
    const { getServerCertFingerprint } = await import("../../../services/certInfo.js");
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
        const { getServerCertHostnames } = await import("../../../services/certInfo.js");
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
    const { startInstall } = await import("../../../services/agentInstallService.js");
    await startInstall({ managedAgentId: row.id, credentialId: body.credentialId });

    res.json({
      managedAgentId:        row.id,
      installStatus:         row.installStatus,
      serverCertFingerprint: fingerprint,
    });
  } catch (err) { next(err); }
});

router.post("/:id/agent/retry", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = requestActor(req) || "unknown";

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

    const { startInstall } = await import("../../../services/agentInstallService.js");
    await startInstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

    res.json({
      managedAgentId: row.id,
      installStatus:  "pending",
    });
  } catch (err) { next(err); }
});

// Reinstall = "start over" against the same host with the stored install
// params, regardless of current installStatus (unlike /retry, which only
// resets a "failed" row). Reuses the row's installCredentialId, osPlatform,
// arch, and transport; revokes the old bearer up front (runInstall mints a
// fresh enrollment token + bearer on re-enroll) and re-runs startInstall,
// which re-pushes the binary + agent.conf and re-runs the installer. The
// ManagedAgent row and the asset's per-stream *Polling config are kept — an
// operator wanting a truly clean slate uses force-remove + a fresh install.
router.post("/:id/agent/reinstall", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = requestActor(req) || "unknown";

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
    const { revokeBearer } = await import("../../../services/agentTokenService.js");
    await revokeBearer(row.id);

    // Optional privilege change on reinstall (Linux only). A reinstall can only
    // produce the unprivileged or ptrace unit — full root is retired, so a legacy
    // "root" agent DOWNGRADES to unprivileged unless the operator explicitly
    // picks a tier. Ignored on Windows (LocalSystem).
    const bodyTier: "unprivileged" | "ptrace" | undefined =
      (req.body?.privilegeTier === "unprivileged" || req.body?.privilegeTier === "ptrace")
        ? req.body.privilegeTier : undefined;
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

    const { startInstall } = await import("../../../services/agentInstallService.js");
    // A reinstall stops an agent that is running right now — hold the asset in
    // maintenance so the disconnect it causes doesn't page anyone (rule 80).
    // /retry and a first install pass no kind: nothing is running to drop.
    await startInstall({
      managedAgentId: row.id,
      credentialId:   row.installCredentialId,
      holdKind:       "agent-reinstall",
    });

    res.json({
      managedAgentId: row.id,
      installStatus:  "pending",
    });
  } catch (err) { next(err); }
});

const AgentUpgradeSchema = z.object({
  credentialId: z.string().uuid().optional(),
});

router.post("/:id/agent/upgrade", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const body = AgentUpgradeSchema.parse(req.body ?? {});
    const actor = requestActor(req) || "unknown";

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent installed for this asset");

    const { startUpgrade } = await import("../../../services/agentInstallService.js");
    // startUpgrade does its own AppError on no-credential / already-current /
    // missing manifest; let those propagate to the global error handler so
    // the operator sees the message inline.
    const result = await startUpgrade({
      managedAgentId: row.id,
      credentialId:   body.credentialId,
      actor,
    });
    res.json({
      managedAgentId: row.id,
      fromVersion:    result.fromVersion,
      toVersion:      result.toVersion,
      installStatus:  "upgrading",
    });
  } catch (err) { next(err); }
});

router.delete("/:id/agent", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = requestActor(req) || "unknown";
    const force = boolQuery(req.query.force);

    const row = await prisma.managedAgent.findUnique({ where: { assetId } });
    if (!row) throw new AppError(404, "No agent installed for this asset");

    // Phase 1 of the two-phase DELETE: synchronous revoke. The bearer
    // stops working immediately regardless of whether the host can be
    // reached. Phase 4 will add the async remote-uninstall pass.
    const { revokeBearer } = await import("../../../services/agentTokenService.js");
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
      res.json({ ok: true, forced: true });
      return;
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
      res.json({
        ok: true,
        forced: false,
        installStatus: "revoked",
        warning: "No install credential on file — remote uninstall skipped. " +
                 "Use ?force=true to drop the local row entirely, or restore the credential and DELETE again.",
      });
      return;
    }

    const { startUninstall } = await import("../../../services/agentInstallService.js");
    await startUninstall({ managedAgentId: row.id, credentialId: row.installCredentialId });

    res.json({ ok: true, forced: false, installStatus: "uninstalling" });
  } catch (err) { next(err); }
});

export default router;
