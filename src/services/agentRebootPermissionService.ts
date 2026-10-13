/**
 * src/services/agentRebootPermissionService.ts — turn an agent host's reboot
 * opt-in on or off after it was deployed (business rule 115).
 *
 * The opt-in has two halves that must agree: `ManagedAgent.rebootEnabled` (the
 * server will send a reboot command) and the host-side permission (the
 * root-owned marker the agent requires, and on Linux the polkit rule that lets
 * the unprivileged agent ask logind to reboot — utils/agentRebootPermission).
 * The host half is installed or removed over the agent's stored install
 * credential and transport, exactly as an upgrade reaches the host
 * (agentInstallService.applyRebootPermissionOnHost).
 *
 *   enable   the script must succeed before the flag is set; `rebootCapable`
 *            is cleared until the agent reports again (a refresh-config nudge
 *            asks it to) — the button stays off until the HOST says it can.
 *   disable  the flag is cleared FIRST and stays cleared even when the host
 *            cannot be reached: Polaris stops sending reboots at once, and the
 *            Event says the host may still carry the permission.
 *
 * Re-running either is safe (the scripts are idempotent) — "enable" again is
 * how an operator repairs a host that reports it cannot reboot.
 */

import { prisma } from "../db.js";
import { AppError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import { logEvent } from "./eventLogService.js";
import { getCredential } from "./credentialService.js";
import { applyRebootPermissionOnHost } from "./agentInstallService.js";
import { publishConfigRefresh } from "./agentCommandWake.js";

/** Install states with an agent on the host to grant or withdraw a permission for. */
const TOGGLEABLE = new Set(["active", "enrolling", "upgrade_failed"]);

export interface AgentRebootToggleResult {
  rebootEnabled: boolean;
  /** Set when the host could not be changed (disable only — enable throws). */
  hostError: string | null;
}

export async function setAgentRebootEnabled(input: { assetId: string; enabled: boolean; actor: string; testOverrides?: { fakeSshSucceed?: boolean; fakeSshFail?: string } }): Promise<AgentRebootToggleResult> {
  const row = await prisma.managedAgent.findUnique({
    where: { assetId: input.assetId },
    select: {
      id: true, osPlatform: true, installStatus: true, installTransport: true, installCredentialId: true, rebootEnabled: true,
      asset: { select: { hostname: true, ipAddress: true, dnsName: true } },
    },
  });
  if (!row) throw new AppError(404, "No Polaris Agent is installed on this asset");
  if (!TOGGLEABLE.has(row.installStatus)) throw new AppError(409, `The Polaris Agent is ${row.installStatus.replace(/_/g, " ")} — wait for it to finish before changing reboots`);
  const host = row.asset.ipAddress || row.asset.dnsName || row.asset.hostname;
  const label = row.asset.hostname || row.asset.ipAddress || undefined;

  const credential = row.installCredentialId ? await getCredential(row.installCredentialId, { revealSecrets: true }).catch(() => null) : null;
  const reach = async (enable: boolean): Promise<string | null> => {
    if (!credential) return "the agent's install credential is no longer on file — reinstall the agent with a credential to change this";
    if (!host) return "the asset has no address to reach the host at";
    try {
      await applyRebootPermissionOnHost({ host, osPlatform: row.osPlatform, transport: row.installTransport, cred: credential.config as Record<string, unknown>, enable, testOverrides: input.testOverrides });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  if (input.enabled) {
    const err = await reach(true);
    if (err) {
      await logEvent({
        action: "agent.reboot_permission_failed", resourceType: "asset", resourceId: input.assetId, resourceName: label, actor: input.actor, level: "warning",
        message: `Reboots were not enabled: the permission could not be installed on the host — ${err}`,
        details: { managedAgentId: row.id },
      });
      throw new AppError(502, `Could not install the reboot permission on the host: ${err}`);
    }
    await prisma.managedAgent.update({ where: { id: row.id }, data: { rebootEnabled: true, rebootCapable: null } });
    await publishConfigRefresh([row.id]).catch((e) => logger.debug({ err: e }, "reboot permission: refresh nudge failed"));
    await logEvent({
      action: "agent.reboot_enabled", resourceType: "asset", resourceId: input.assetId, resourceName: label, actor: input.actor, level: "warning",
      message: `Reboots enabled for this host: Polaris may now reboot it through the Polaris Agent${row.osPlatform === "linux" ? " (polkit rule installed)" : ""}`,
      details: { managedAgentId: row.id, osPlatform: row.osPlatform },
    });
    return { rebootEnabled: true, hostError: null };
  }

  // Disable: Polaris stops asking first, whatever the host says.
  await prisma.managedAgent.update({ where: { id: row.id }, data: { rebootEnabled: false, rebootCapable: null } });
  const err = await reach(false);
  await publishConfigRefresh([row.id]).catch(() => undefined);
  await logEvent({
    action: "agent.reboot_disabled", resourceType: "asset", resourceId: input.assetId, resourceName: label, actor: input.actor, level: err ? "warning" : "info",
    message: err
      ? `Reboots disabled for this host — Polaris will not reboot it, but the host-side permission could not be removed (${err}); remove it by hand or try again`
      : "Reboots disabled for this host; the host-side permission was removed",
    details: { managedAgentId: row.id, hostError: err },
  });
  return { rebootEnabled: false, hostError: err };
}
