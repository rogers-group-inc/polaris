/**
 * src/services/ipv6GateService.ts — is IPv6 ON for this install? (business rule 128)
 *
 * IPv6 is a whole-install switch: while it is off, Polaris collects, stores
 * and shows nothing IPv6 — no IPv6 networks or addresses from discovery (rule
 * 125), no interface IPv6 (rule 126), no primary IPv6 on an asset, and no
 * probe over IPv6. While it is on, all of that runs.
 *
 * The switch is the `ipv6Config` Setting's `enabled`, decided ONCE and then
 * left to the operator:
 *   - at install (the first boot of a version carrying this rule, upgrades
 *     included), `initializeIpv6Setting` sets it from the host: on when the
 *     machine Polaris runs on holds a routable IPv6 address (not loopback, not
 *     fe80::), off otherwise — Event `settings.ipv6.initialized`;
 *   - after that only Server Settings → Web Server → IPv6 changes it
 *     (`setIpv6Enabled`, Event `settings.ipv6.updated`). The host gaining or
 *     losing IPv6 later changes nothing on its own.
 * Until the install-time decision is written (a monitor or discovery role
 * that boots before web), the answer is the same host detection it will write.
 *
 * On is not the same as REACHABLE. A container on an IPv4-only network with
 * IPv6 switched on still learns IPv6 from discovery (the FortiGate is read
 * over IPv4), but cannot send a packet to an IPv6 device — polling an
 * IPv6-only asset there would only mark it down. So probes ask a second
 * question, `ipv6Dialable()`: on AND this process can originate IPv6 (it holds
 * a routable IPv6 address, or the kernel has a route to global unicast —
 * `hasIpv6Route`).
 *
 * Read on hot paths (every interface write, every probe target), so both
 * answers are synchronous cached booleans, refreshed in the background at
 * most every REFRESH_MS. Each process role keeps its own cache; a change
 * reaches every role within REFRESH_MS + the store's TTL.
 */

import { networkInterfaces } from "node:os";
import { createSocket } from "node:dgram";
import { createSettingStore } from "./settingsStore.js";
import { logEvent } from "./eventLogService.js";
import { isIpamIpv6Address } from "../utils/cidr.js";
import { logger } from "../utils/logger.js";

export interface Ipv6Config {
  /** The switch. null = not decided yet (no row): host detection answers. */
  enabled: boolean | null;
  /** Who set it last: the install-time detection, or an operator. */
  setBy: "install" | "operator" | null;
  /** The host's routable IPv6 addresses when the install-time decision was made. */
  installHostAddresses: string[];
}

export interface Ipv6Status {
  /** The answer every IPv6 path reads. */
  enabled: boolean;
  /** Who set it: "install" (detected at install), "operator", or null while undecided. */
  setBy: "install" | "operator" | null;
  /** The host's routable IPv6 addresses when the install-time decision was made. */
  installHostAddresses: string[];
  /** The host's routable IPv6 addresses now, as this process sees them. */
  hostAddresses: string[];
  /** Does the kernel route global unicast IPv6 (2000::/3) from this process? */
  hasRoute: boolean;
  /** On AND this process can reach IPv6 — what a probe reads before dialling an IPv6 address. */
  dialable: boolean;
}

const REFRESH_MS = 60_000;

/**
 * Stored shape → config. Tolerant: a missing row is undecided, and a row from
 * the pre-release `{ mode }` shape maps on → true, off → false, auto →
 * undecided (the install-time detection then settles it). Pure — exported for tests.
 */
export function parseIpv6Config(raw: unknown): Ipv6Config {
  const r = (raw ?? {}) as { enabled?: unknown; setBy?: unknown; installHostAddresses?: unknown; mode?: unknown };
  let enabled: boolean | null = typeof r.enabled === "boolean" ? r.enabled : null;
  if (enabled === null && (r.mode === "on" || r.mode === "off")) enabled = r.mode === "on";
  const setBy = r.setBy === "install" || r.setBy === "operator" ? r.setBy : enabled === null ? null : "operator";
  const installHostAddresses = Array.isArray(r.installHostAddresses)
    ? r.installHostAddresses.filter((a): a is string => typeof a === "string")
    : [];
  return { enabled, setBy, installHostAddresses };
}

const store = createSettingStore<Ipv6Config>({
  key: "ipv6Config",
  ttlMs: 30_000,
  parse: parseIpv6Config,
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

/** The stored switch, or the host detection while undecided. Pure — exported for tests. */
export function decideIpv6Enabled(stored: boolean | null, hostAddresses: readonly string[]): boolean {
  return stored ?? hostAddresses.length > 0;
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

/** Read the setting + the host, and refresh the cache. */
export async function getIpv6Status(): Promise<Ipv6Status> {
  let config: Ipv6Config;
  try {
    config = await store.get();
  } catch (err) {
    // A settings outage keeps the last known answer rather than flipping IPv6.
    const last = cached?.status;
    config = {
      enabled: last && last.setBy ? last.enabled : null,
      setBy: last?.setBy ?? null,
      installHostAddresses: last?.installHostAddresses ?? [],
    };
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, "ipv6 gate: settings read failed");
  }
  const hostAddresses = routableHostIpv6(networkInterfaces());
  const enabled = decideIpv6Enabled(config.enabled, hostAddresses);
  const hasRoute = await hasIpv6Route();
  const status: Ipv6Status = {
    enabled,
    setBy: config.setBy,
    installHostAddresses: config.installHostAddresses,
    hostAddresses,
    hasRoute,
    dialable: decideIpv6Dialable(enabled, hostAddresses, hasRoute),
  };
  cached = { status, at: Date.now() };
  return status;
}

function current(): Ipv6Status {
  if (!cached) {
    // Before the first refresh: host detection alone — the same answer the
    // install-time decision writes — and dialable only on a routable address
    // (the route probe is async and lands with the refresh).
    const hostAddresses = routableHostIpv6(networkInterfaces());
    const enabled = decideIpv6Enabled(null, hostAddresses);
    cached = {
      status: {
        enabled, setBy: null, installHostAddresses: [], hostAddresses, hasRoute: false,
        dialable: decideIpv6Dialable(enabled, hostAddresses, false),
      },
      at: 0,
    };
  }
  if (Date.now() - cached.at > REFRESH_MS && !refreshing) {
    refreshing = getIpv6Status().finally(() => { refreshing = null; });
    refreshing.catch(() => {});
  }
  return cached.status;
}

/** Is IPv6 on? Synchronous, from the cache; a stale cache answers its last value and refreshes in the background. */
export function ipv6Enabled(): boolean {
  return current().enabled;
}

/**
 * May a probe dial an IPv6 address? IPv6 is on AND this process can reach it.
 * Every `assetDialAddress` / loss-sweep caller reads this, not ipv6Enabled():
 * an IPv6-only asset on an install that cannot reach IPv6 is left unpolled
 * (as it was before rule 128) rather than polled into "down".
 */
export function ipv6Dialable(): boolean {
  return current().dialable;
}

/**
 * The install-time decision: if nobody has decided yet, switch IPv6 on when
 * this host holds a routable IPv6 address and off otherwise, and record it.
 * Never overwrites a decision already made — by an earlier boot or an
 * operator. Run once per boot by the migrations role (jobs/initIpv6Setting.ts).
 */
export async function initializeIpv6Setting(): Promise<{ initialized: boolean; enabled: boolean }> {
  store.invalidate();
  const config = await store.get();
  if (config.enabled !== null) return { initialized: false, enabled: config.enabled };
  const hostAddresses = routableHostIpv6(networkInterfaces());
  const enabled = hostAddresses.length > 0;
  await store.save({ enabled, setBy: "install", installHostAddresses: hostAddresses });
  await getIpv6Status();
  await logEvent({
    action: "settings.ipv6.initialized",
    resourceType: "setting",
    resourceId: "ipv6Config",
    resourceName: "IPv6",
    actor: "system",
    level: "info",
    message: enabled
      ? `IPv6 switched ON at install — this server has a routable IPv6 address (${hostAddresses.join(", ")}). Change it under Server Settings → Web Server → IPv6.`
      : "IPv6 switched OFF at install — this server has no routable IPv6 address. Turn it on under Server Settings → Web Server → IPv6 if your network uses IPv6.",
    details: { enabled, hostAddresses },
  });
  return { initialized: true, enabled };
}

/** Switch IPv6 on or off (Server Settings). Audited. */
export async function setIpv6Enabled(enabled: boolean, actor: string): Promise<Ipv6Status> {
  const before = await getIpv6Status();
  await store.save({ enabled, setBy: "operator", installHostAddresses: before.installHostAddresses });
  const after = await getIpv6Status();
  await logEvent({
    action: "settings.ipv6.updated",
    resourceType: "setting",
    resourceId: "ipv6Config",
    resourceName: "IPv6",
    actor,
    level: "info",
    message: `IPv6 switched ${enabled ? "ON" : "OFF"}` +
      (before.enabled !== enabled ? ` (was ${before.enabled ? "on" : "off"})` : "") +
      (after.enabled && !after.dialable ? " — this server cannot reach IPv6, so devices with only an IPv6 address are not polled" : ""),
    details: { enabled, previous: before.enabled, dialable: after.dialable, hasRoute: after.hasRoute, hostAddresses: after.hostAddresses },
  });
  return after;
}

/** Tests only: forget the cache. */
export function _resetIpv6GateForTests(): void {
  cached = null;
  store.invalidate();
}
