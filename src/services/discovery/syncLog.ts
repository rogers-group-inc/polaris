/**
 * src/services/discovery/syncLog.ts
 *
 * The per-integration sync-pass logger: every discovery sync pass (the DHCP /
 * device passes in discoveryEngine, Generic API devices + networks, the
 * Unraid / TrueNAS / Proxmox workload sync) writes its progress lines as
 * `integration.sync` Events against the integration, with the message
 * prefixed by `[<integration name>]`.
 *
 * Replaces nine identical hand-written closures (CQ-B032). Fire-and-forget,
 * exactly as they were: the returned function does not await `logEvent`, and
 * `logEvent` swallows its own write errors.
 */
import { logEvent } from "../eventLogService.js";

export type SyncLog = (level: "info" | "warning" | "error", message: string) => void;

/** Build the `syncLog(level, message)` writer for one integration's sync pass. */
export function makeSyncLog(integrationId: string, integrationName: string, actor: string | undefined): SyncLog {
  return (level, message) => {
    logEvent({ action: "integration.sync", resourceType: "integration", resourceId: integrationId, resourceName: integrationName, actor, level, message: `[${integrationName}] ${message}` });
  };
}
