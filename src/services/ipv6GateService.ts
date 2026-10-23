/**
 * src/services/ipv6GateService.ts — is IPv6 ON for this install? (business rule 127)
 *
 * IPv6 is a whole-install switch: while it is off, Polaris collects, stores
 * and shows nothing IPv6 — no IPv6 networks or addresses from discovery (rule
 * 125), no interface IPv6 (rule 126), no primary IPv6 on an asset, and no
 * probe over IPv6. While it is on, all of that runs.
 *
 * Whether it is on is the `ipv6Config` Setting's mode:
 *   - "auto" (the default): on exactly when the HOST Polaris runs on has a
 *     routable IPv6 address (not loopback, not fe80::) — the operator's network
 *     speaks IPv6, so the devices on it may too, and Polaris can reach them;
 *   - "on" / "off": forced. "on" exists for the container case: a container
 *     without IPv6 networking sees no IPv6 on its own interfaces even when the
 *     host and its network are dual-stack.
 *
 * Read on hot paths (every interface write, every probe target), so the
 * answer is a synchronous cached boolean — `ipv6Enabled()` — refreshed in the
 * background at most every REFRESH_MS. Each process role keeps its own cache;
 * a mode change reaches every role within REFRESH_MS + the store's TTL.
 */

import { networkInterfaces } from "node:os";
import { createSettingStore } from "./settingsStore.js";
import { logEvent } from "./eventLogService.js";
import { isIpamIpv6Address } from "../utils/cidr.js";
import { logger } from "../utils/logger.js";

export type Ipv6Mode = "auto" | "on" | "off";

export interface Ipv6Status {
  mode: Ipv6Mode;
  /** The host's routable IPv6 addresses, as this process sees them. */
  hostAddresses: string[];
  /** The answer every IPv6 path reads. */
  enabled: boolean;
}

const REFRESH_MS = 60_000;

const store = createSettingStore<{ mode: Ipv6Mode }>({
  key: "ipv6Config",
  ttlMs: 30_000,
  parse: (raw) => {
    const mode = (raw as { mode?: unknown } | undefined)?.mode;
    return { mode: mode === "on" || mode === "off" ? mode : "auto" };
  },
});

/**
 * The host's routable IPv6 addresses from an `os.networkInterfaces()` shape:
 * internal interfaces, link-local, loopback and anything not IPAM space are
 * left out. Pure — exported for tests.
 */
export function routableHostIpv6(ifaces: ReturnType<typeof networkInterfaces>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      const v6 = a.family === "IPv6" || (a.family as unknown) === 6;
      if (!v6 || a.internal) continue;
      const ip = a.address.split("%")[0];
      if (isIpamIpv6Address(ip) && !out.includes(ip)) out.push(ip);
    }
  }
  return out;
}

/** The mode and the host's addresses → on or off. Pure — exported for tests. */
export function decideIpv6Enabled(mode: Ipv6Mode, hostAddresses: readonly string[]): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  return hostAddresses.length > 0;
}

let cached: { status: Ipv6Status; at: number } | null = null;
let refreshing: Promise<Ipv6Status> | null = null;

/** Read the setting + the host, and refresh the cache. */
export async function getIpv6Status(): Promise<Ipv6Status> {
  let mode: Ipv6Mode = "auto";
  try {
    mode = (await store.get()).mode;
  } catch (err) {
    // A settings outage keeps the last known mode rather than flipping IPv6.
    mode = cached?.status.mode ?? "auto";
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ipv6 gate: settings read failed");
  }
  const hostAddresses = routableHostIpv6(networkInterfaces());
  const status: Ipv6Status = { mode, hostAddresses, enabled: decideIpv6Enabled(mode, hostAddresses) };
  cached = { status, at: Date.now() };
  return status;
}

/**
 * Is IPv6 on? Synchronous, from the cache; a stale cache answers its last
 * value and refreshes in the background. Before the first refresh lands the
 * answer is the host detection alone (mode "auto"), which is the default.
 */
export function ipv6Enabled(): boolean {
  if (!cached) {
    const hostAddresses = routableHostIpv6(networkInterfaces());
    cached = { status: { mode: "auto", hostAddresses, enabled: decideIpv6Enabled("auto", hostAddresses) }, at: 0 };
  }
  if (Date.now() - cached.at > REFRESH_MS && !refreshing) {
    refreshing = getIpv6Status().finally(() => { refreshing = null; });
    refreshing.catch(() => {});
  }
  return cached.status.enabled;
}

/** Set the mode (Server Settings). Audited. */
export async function setIpv6Mode(mode: Ipv6Mode, actor: string): Promise<Ipv6Status> {
  const before = cached?.status ?? (await getIpv6Status());
  await store.save({ mode });
  const after = await getIpv6Status();
  await logEvent({
    action: "settings.ipv6.updated",
    resourceType: "setting",
    resourceId: "ipv6Config",
    resourceName: "IPv6",
    actor,
    level: "info",
    message: `IPv6 mode set to "${mode}" — IPv6 is now ${after.enabled ? "ON" : "OFF"}` +
      (mode === "auto" ? ` (host ${after.hostAddresses.length ? "has" : "has no"} routable IPv6)` : "") +
      (before.enabled !== after.enabled ? `, was ${before.enabled ? "ON" : "OFF"}` : ""),
    details: { mode, previousMode: before.mode, enabled: after.enabled, hostAddresses: after.hostAddresses },
  });
  return after;
}

/** Tests only: forget the cache. */
export function _resetIpv6GateForTests(): void {
  cached = null;
  store.invalidate();
}
