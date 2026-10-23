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
 *   - "on" / "off": forced, for detection that is wrong for the install. A
 *     container on an IPv4-only network is NOT such a case — it cannot reach
 *     IPv6 either; give its network IPv6 instead (docs/INSTALL.md).
 *
 * "auto" turns ON at once and OFF only after the host has had no routable
 * IPv6 for AUTO_OFF_HOLD_MS. Off clears every automatic primary IPv6 and
 * stops IPv6 collection, so a router advertisement that lapsed for a few
 * minutes must not do that; while held, probes still skip IPv6 targets the
 * host cannot reach (`dialable`), so nothing is polled into down. An automatic
 * flip — and the start of a hold — is recorded as an Event, by the scheduler
 * role only (every role refreshes its own cache; one record is enough).
 *
 * On is not the same as REACHABLE. A container on an IPv4-only bridge forced
 * "on" still learns IPv6 from discovery (the FortiGate is read over IPv4), but
 * cannot send a packet to an IPv6 device — polling an IPv6-only asset there
 * would only mark it down. So probes ask a second question, `ipv6Dialable()`:
 * on AND this process can originate IPv6 (it holds a routable IPv6 address,
 * or the kernel has a route to global unicast — `hasIpv6Route`).
 *
 * Read on hot paths (every interface write, every probe target), so the
 * answer is a synchronous cached boolean — `ipv6Enabled()` — refreshed in the
 * background at most every REFRESH_MS. Each process role keeps its own cache;
 * a mode change reaches every role within REFRESH_MS + the store's TTL.
 */

import { networkInterfaces } from "node:os";
import { createSocket } from "node:dgram";
import { createSettingStore } from "./settingsStore.js";
import { logEvent } from "./eventLogService.js";
import { isIpamIpv6Address } from "../utils/cidr.js";
import { logger } from "../utils/logger.js";
import { roleConfig } from "../utils/role.js";

export type Ipv6Mode = "auto" | "on" | "off";

export interface Ipv6Status {
  mode: Ipv6Mode;
  /** The host's routable IPv6 addresses, as this process sees them. */
  hostAddresses: string[];
  /** Does the kernel route global unicast IPv6 (2000::/3) from this process? */
  hasRoute: boolean;
  /** The answer every IPv6 path reads. */
  enabled: boolean;
  /** On AND this process can reach IPv6 — what a probe reads before dialling an IPv6 address. */
  dialable: boolean;
  /**
   * "auto" is on only because the host had a routable IPv6 recently — the
   * address is gone and IPv6 turns off at this time unless it returns.
   * Null when not holding.
   */
  heldUntil: string | null;
}

const REFRESH_MS = 60_000;
/** How long "auto" stays on after the host's last routable IPv6 disappears. */
export const AUTO_OFF_HOLD_MS = 15 * 60_000;

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

/**
 * The mode and the host's addresses → on or off. In "auto", a host that held a
 * routable IPv6 at `lastHostIpv6At` (ms; 0 = never seen by this process) stays
 * on for AUTO_OFF_HOLD_MS after losing it. Pure — exported for tests.
 */
export function decideIpv6Enabled(
  mode: Ipv6Mode,
  hostAddresses: readonly string[],
  lastHostIpv6At = 0,
  now = Date.now(),
): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  if (hostAddresses.length > 0) return true;
  return lastHostIpv6At > 0 && now - lastHostIpv6At < AUTO_OFF_HOLD_MS;
}

/** On + able to reach IPv6 → may a probe dial an IPv6 address? Pure — exported for tests. */
export function decideIpv6Dialable(enabled: boolean, hostAddresses: readonly string[], hasRoute: boolean): boolean {
  return enabled && (hostAddresses.length > 0 || hasRoute);
}

/**
 * Is there a route to global unicast IPv6? A UDP connect() only asks the
 * kernel to pick a route and source — no packet leaves — so this answers
 * "could I send", without contacting anything. 2000::1 is just an address
 * inside 2000::/3 that the default route covers; nothing is sent to it.
 */
export function hasIpv6Route(timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      resolve(ok);
    };
    let sock: ReturnType<typeof createSocket>;
    try {
      sock = createSocket("udp6");
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finish(false), timeoutMs);
    sock.once("error", () => finish(false));
    try {
      sock.connect(9, "2000::1", () => finish(true));
    } catch {
      finish(false);
    }
  });
}

let cached: { status: Ipv6Status; at: number } | null = null;
let refreshing: Promise<Ipv6Status> | null = null;
/** When this process last saw the host hold a routable IPv6 (ms; 0 = never). */
let lastHostIpv6At = 0;

/**
 * The Event an automatic change deserves, comparing the last real refresh
 * with this one (both in "auto"), or null. Pure — exported for tests.
 */
export function autoChangeEvent(prev: Ipv6Status, next: Ipv6Status): { action: string; level: "info" | "warning"; message: string } | null {
  if (prev.mode !== "auto" || next.mode !== "auto") return null;
  if (!prev.enabled && next.enabled) {
    return {
      action: "settings.ipv6.auto_on",
      level: "info",
      message: `IPv6 turned ON automatically — this server now has a routable IPv6 address (${next.hostAddresses.join(", ")})`,
    };
  }
  if (prev.enabled && !next.enabled) {
    return {
      action: "settings.ipv6.auto_off",
      level: "warning",
      message: `IPv6 turned OFF automatically — this server has had no routable IPv6 address for ${AUTO_OFF_HOLD_MS / 60_000} minutes. ` +
        "Automatically chosen primary IPv6 addresses are cleared and IPv6 is no longer collected.",
    };
  }
  if (!prev.heldUntil && next.heldUntil) {
    return {
      action: "settings.ipv6.auto_hold",
      level: "warning",
      message: `This server lost its routable IPv6 address (was ${prev.hostAddresses.join(", ") || "unknown"}). ` +
        `IPv6 stays on until ${next.heldUntil} and turns off then unless the address returns; ` +
        "until it does, devices with only an IPv6 address are not polled.",
    };
  }
  if (prev.heldUntil && !next.heldUntil && next.enabled) {
    return {
      action: "settings.ipv6.auto_hold_ended",
      level: "info",
      message: `This server has a routable IPv6 address again (${next.hostAddresses.join(", ")}) — IPv6 stays on.`,
    };
  }
  return null;
}

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
  const now = Date.now();
  const hostAddresses = routableHostIpv6(networkInterfaces());
  if (hostAddresses.length > 0) lastHostIpv6At = now;
  const enabled = decideIpv6Enabled(mode, hostAddresses, lastHostIpv6At, now);
  const hasRoute = await hasIpv6Route();
  const held = mode === "auto" && enabled && hostAddresses.length === 0;
  const status: Ipv6Status = {
    mode,
    hostAddresses,
    hasRoute,
    enabled,
    dialable: decideIpv6Dialable(enabled, hostAddresses, hasRoute),
    heldUntil: held ? new Date(lastHostIpv6At + AUTO_OFF_HOLD_MS).toISOString() : null,
  };
  // Compare with the last REAL refresh (at > 0), never the boot placeholder:
  // a process starting up is not a change.
  const prev = cached && cached.at > 0 ? cached.status : null;
  cached = { status, at: now };
  if (prev && roleConfig().runsSchedulers) {
    const ev = autoChangeEvent(prev, status);
    if (ev) {
      logger.warn({ ipv6: status }, ev.message);
      try {
        await logEvent({
          action: ev.action,
          resourceType: "setting",
          resourceId: "ipv6Config",
          resourceName: "IPv6",
          actor: "system",
          level: ev.level,
          message: ev.message,
          details: { mode, enabled, dialable: status.dialable, hasRoute, hostAddresses, previousHostAddresses: prev.hostAddresses, heldUntil: status.heldUntil },
        });
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ipv6 gate: event write failed");
      }
    }
  }
  return status;
}

/**
 * Is IPv6 on? Synchronous, from the cache; a stale cache answers its last
 * value and refreshes in the background. Before the first refresh lands the
 * answer is the host detection alone (mode "auto"), which is the default.
 */
function current(): Ipv6Status {
  if (!cached) {
    // Before the first refresh: host detection alone, and dialable only on a
    // routable address (the route probe is async and lands with the refresh).
    const hostAddresses = routableHostIpv6(networkInterfaces());
    if (hostAddresses.length > 0) lastHostIpv6At = Date.now();
    const enabled = decideIpv6Enabled("auto", hostAddresses);
    cached = {
      status: { mode: "auto", hostAddresses, hasRoute: false, enabled, dialable: decideIpv6Dialable(enabled, hostAddresses, false), heldUntil: null },
      at: 0,
    };
  }
  if (Date.now() - cached.at > REFRESH_MS && !refreshing) {
    refreshing = getIpv6Status().finally(() => { refreshing = null; });
    refreshing.catch(() => {});
  }
  return cached.status;
}

export function ipv6Enabled(): boolean {
  return current().enabled;
}

/**
 * May a probe dial an IPv6 address? IPv6 is on AND this process can reach it.
 * Every `assetDialAddress` / loss-sweep caller reads this, not ipv6Enabled():
 * an IPv6-only asset on an install that cannot reach IPv6 is left unpolled
 * (as it was before rule 127) rather than polled into "down".
 */
export function ipv6Dialable(): boolean {
  return current().dialable;
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
      (after.enabled && !after.dialable ? " but this server cannot reach IPv6, so devices with only an IPv6 address are not polled" : "") +
      (before.enabled !== after.enabled ? `, was ${before.enabled ? "ON" : "OFF"}` : ""),
    details: { mode, previousMode: before.mode, enabled: after.enabled, dialable: after.dialable, hasRoute: after.hasRoute, hostAddresses: after.hostAddresses },
  });
  return after;
}

/** Tests only: forget the cache. */
export function _resetIpv6GateForTests(): void {
  cached = null;
  lastHostIpv6At = 0;
  store.invalidate();
}
