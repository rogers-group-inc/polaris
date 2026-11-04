/**
 * src/services/agentInstallScripts.ts
 *
 * Curated catalog of Polaris Agent install-method variants. Each variant is a
 * vetted, in-repo installer approach (systemd, launchd, Windows Service, …).
 * Operators PICK a variant when deploying; they cannot author arbitrary ones —
 * so this adds NO remote-code-execution surface beyond what agent deploy
 * already does (an operator with assets:write + valid SSH/WinRM creds already
 * runs a root/LocalSystem installer today). The picker only chooses AMONG these.
 *
 * SECURITY — OS-LOCK: a variant is bound to exactly one osPlatform, and
 * `resolveInstallScriptId` throws when the chosen variant's OS doesn't match the
 * target asset's OS. This is enforced HERE (service layer), not just in the UI,
 * so a hand-crafted API request can never run a PowerShell installer against a
 * Linux host or vice-versa. The selection is a fixed enum of catalog ids
 * validated server-side — never a free-text/operator-supplied script body.
 *
 * The actual script BODIES live inline in agentInstallService.ts (version-
 * coupled to the binary's expected paths). This module owns the catalog
 * METADATA + validation; agentInstallService switches on the resolved id to
 * pick the matching script. To add a new variant: add an entry here AND a
 * branch in agentInstallService's installer/uninstaller selectors.
 */

import { AppError } from "../utils/errors.js";

export type AgentOsPlatform = "linux" | "darwin" | "windows";

export interface AgentInstallScriptMeta {
  /** Stable id persisted on ManagedAgent.installScriptId + sent by the UI. */
  id: string;
  osPlatform: AgentOsPlatform;
  /** Short label for the picker (e.g. "systemd service"). */
  label: string;
  /** One-line explanation shown under the picker. */
  description: string;
  /** The per-OS default chosen when the operator doesn't pick one. Exactly
   *  one variant per osPlatform must be marked default. */
  isDefault: boolean;
}

/**
 * The catalog. Framework baseline: one vetted variant per OS, matching the
 * scripts that shipped inline before the picker existed. Additional variants
 * (a no-systemd Linux fallback, an NSSM Windows service, …) are added as new
 * entries here once authored + tested on real hosts.
 */
export const AGENT_INSTALL_SCRIPTS: AgentInstallScriptMeta[] = [
  {
    id: "linux-systemd",
    osPlatform: "linux",
    label: "systemd service",
    description:
      "Installs the binary to /usr/local/bin and registers a hardened systemd unit (DynamicUser, ProtectSystem=strict). Requires systemd + passwordless sudo.",
    isDefault: true,
  },
  {
    id: "darwin-launchd",
    osPlatform: "darwin",
    label: "launchd daemon",
    description:
      "Installs the binary and registers a launchd daemon under /Library/LaunchDaemons. Requires passwordless sudo.",
    isDefault: true,
  },
  {
    id: "windows-service",
    osPlatform: "windows",
    label: "Windows Service",
    description:
      "Downloads the binary over the cert-pinned HTTPS channel and registers a native Windows Service (New-Service) with automatic restart on failure.",
    isDefault: true,
  },
];

/** All variants for a given OS (what the UI picker lists for that target). */
export function scriptsForOs(os: AgentOsPlatform): AgentInstallScriptMeta[] {
  return AGENT_INSTALL_SCRIPTS.filter((s) => s.osPlatform === os);
}

/** The default variant id for an OS. Throws if the catalog is malformed
 *  (missing a default) — a programming error, surfaced loudly. */
function defaultScriptIdFor(os: AgentOsPlatform): string {
  const def = AGENT_INSTALL_SCRIPTS.find((s) => s.osPlatform === os && s.isDefault);
  if (!def) throw new AppError(500, `No default install script registered for platform "${os}"`);
  return def.id;
}

/** Look up a variant by id (undefined when unknown). */
function installScriptMetaById(id: string): AgentInstallScriptMeta | undefined {
  return AGENT_INSTALL_SCRIPTS.find((s) => s.id === id);
}

/**
 * Resolve + validate an operator-chosen install-script id against the target
 * OS. Returns the concrete id to persist/execute:
 *   - scriptId omitted/null → the OS default (back-compat: pre-picker installs
 *     and auto-deploy pass nothing).
 *   - scriptId given → must be a known catalog id whose osPlatform === os,
 *     otherwise AppError(400). THIS IS THE OS-LOCK.
 */
export function resolveInstallScriptId(os: AgentOsPlatform, scriptId?: string | null): string {
  if (scriptId == null || scriptId === "") return defaultScriptIdFor(os);
  const meta = installScriptMetaById(scriptId);
  if (!meta) {
    throw new AppError(400, `Unknown install script "${scriptId}"`);
  }
  if (meta.osPlatform !== os) {
    throw new AppError(
      400,
      `Install script "${meta.label}" is for ${meta.osPlatform} hosts and cannot be used on a ${os} target`,
    );
  }
  return meta.id;
}
