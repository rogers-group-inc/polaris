/**
 * src/api/routes/assets/agent.ts — Polaris Agent deployment on an asset: bulk install, the per-asset agent card,
 * install / retry / reinstall / upgrade / uninstall (agentDeploy=write). Split out of
 * routes/assets.ts (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { boolQuery } from "../../../utils/queryParams.js";
import { z } from "zod";
import { requirePermission } from "../../middleware/permissions.js";
import { requestActor } from "../../middleware/auth.js";
import { getAgentCard, kickoffAgentInstall, retryAgentInstall, reinstallAgent, upgradeAgent, removeAgent } from "../../../services/agentDeployService.js";

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
    const card = await getAgentCard(assetId);
    if (!card) return res.status(204).end();
    res.json(card);
  } catch (err) { next(err); }
});

router.post("/:id/agent/install", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const body = AgentInstallSchema.parse(req.body);
    const actor = requestActor(req) || "unknown";

    res.json(await kickoffAgentInstall(assetId, body, actor));
  } catch (err) { next(err); }
});

router.post("/:id/agent/retry", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = requestActor(req) || "unknown";

    res.json(await retryAgentInstall(assetId, actor));
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

    const bodyTier: "unprivileged" | "ptrace" | undefined =
      (req.body?.privilegeTier === "unprivileged" || req.body?.privilegeTier === "ptrace")
        ? req.body.privilegeTier : undefined;
    res.json(await reinstallAgent(assetId, actor, bodyTier));
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

    res.json(await upgradeAgent(assetId, body.credentialId, actor));
  } catch (err) { next(err); }
});

router.delete("/:id/agent", requirePermission("agentDeploy", "write"), async (req, res, next) => {
  try {
    const assetId = req.params.id as string;
    const actor = requestActor(req) || "unknown";
    const force = boolQuery(req.query.force);

    res.json(await removeAgent(assetId, actor, force));
  } catch (err) { next(err); }
});

export default router;
