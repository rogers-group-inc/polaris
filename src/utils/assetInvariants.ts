/**
 * src/utils/assetInvariants.ts — Shared write-time invariants for Asset records.
 */

type DateLike = Date | string | null | undefined;

/**
 * An asset's acquiredAt must never be after its lastSeen — you can't be
 * seen before you were acquired. When a write would violate that (either
 * from a manual edit or from a discovery update clobbering one field
 * while leaving the other), clamp acquiredAt down to match lastSeen.
 *
 * Mutates the passed `data` object. `existing` supplies the pre-update
 * values for fields the write isn't touching; omit for creates.
 */
export function clampAcquiredToLastSeen(
  data: Record<string, unknown>,
  existing?: { acquiredAt?: DateLike; lastSeen?: DateLike } | null,
): void {
  const acqRaw = "acquiredAt" in data ? (data.acquiredAt as DateLike) : existing?.acquiredAt ?? null;
  const seenRaw = "lastSeen" in data ? (data.lastSeen as DateLike) : existing?.lastSeen ?? null;
  if (!acqRaw || !seenRaw) return;
  const acq = acqRaw instanceof Date ? acqRaw : new Date(acqRaw);
  const seen = seenRaw instanceof Date ? seenRaw : new Date(seenRaw);
  if (Number.isNaN(acq.getTime()) || Number.isNaN(seen.getTime())) return;
  if (seen < acq) data.acquiredAt = seen;
}

/**
 * Re-assert an operator hostname override over a pending Asset write.
 *
 * Discovery projection writes set `hostname` on every cycle. When the row
 * carries a `hostnameOverride` (operator pin, set via the asset edit form),
 * those writes must not clobber it — the guard rewrites the staged hostname
 * back to the override value. Handles both the plain (`hostname: "x"`) and
 * Prisma nested (`hostname: { set: "x" }`) data shapes.
 *
 * A write that itself touches `hostnameOverride` is the operator set/clear
 * path (the assets PUT handler) — it is authoritative and never rewritten.
 *
 * Mutates `data` in place. Returns true when the override was re-asserted.
 */
export function applyHostnameOverride(
  data: Record<string, unknown>,
  override: string | null | undefined,
): boolean {
  if (!data || typeof data !== "object") return false;
  if (!("hostname" in data)) return false;
  if ("hostnameOverride" in data) return false;
  if (!override) return false;
  const v = data.hostname;
  if (v && typeof v === "object" && "set" in (v as Record<string, unknown>)) {
    (v as Record<string, unknown>).set = override;
  } else {
    data.hostname = override;
  }
  return true;
}

/**
 * Outcome of applying the operator IP override to a pending Asset write.
 *
 *   "none"       — no override on the row, write doesn't stage ipAddress, or
 *                  the write itself touches ipOverride (operator set/clear
 *                  path — authoritative, never rewritten).
 *   "released"   — the staged IP equals the override: discovery agrees, so
 *                  the pin self-disables (data.ipOverride staged to null) and
 *                  the staged IP passes through untouched.
 *   "reasserted" — the staged IP differs (or is a clear): the pin wins — the
 *                  staged ipAddress is rewritten back to the override.
 *                  `discoveredIp` carries the IP the writer wanted (null when
 *                  the writer staged a clear) so the caller can raise an
 *                  ip-override Conflict for a concrete disagreement.
 */
export type IpOverrideOutcome =
  | { action: "none" }
  | { action: "released"; ip: string }
  | { action: "reasserted"; discoveredIp: string | null };

/**
 * Apply the operator IP override (Asset.ipOverride) to a pending Asset write.
 *
 * Sibling of applyHostnameOverride with different collision semantics:
 * discovery gets a vote. A staged ipAddress equal to the override releases
 * the pin (discovery converged — the override is no longer doing anything);
 * a staged different IP is rewritten back to the override, and the caller is
 * told which IP discovery proposed so it can raise a Conflict. A staged
 * clear (null/empty) is re-asserted without a conflict — a source losing its
 * opinion is not a disagreement.
 *
 * Comparison is a trimmed exact string match — discovery writers stage
 * canonical address strings, and a formatting mismatch re-asserting the pin
 * plus raising a conflict is the safe failure mode.
 *
 * Handles both the plain (`ipAddress: "x"`) and Prisma nested
 * (`ipAddress: { set: "x" }`) data shapes. On re-assertion any staged
 * `ipSource` is rewritten to "manual" so the row's provenance keeps matching
 * the pinned value. Mutates `data` in place.
 */
export function applyIpOverride(
  data: Record<string, unknown>,
  override: string | null | undefined,
): IpOverrideOutcome {
  if (!data || typeof data !== "object") return { action: "none" };
  if (!("ipAddress" in data)) return { action: "none" };
  if ("ipOverride" in data) return { action: "none" };
  if (!override) return { action: "none" };

  const v = data.ipAddress;
  const nested = v !== null && typeof v === "object" && "set" in (v as Record<string, unknown>);
  const rawStaged = nested ? (v as Record<string, unknown>).set : v;
  const staged = typeof rawStaged === "string" ? rawStaged.trim() || null : null;

  if (staged === override.trim()) {
    // Discovery agrees with the pin — release it and let the write through.
    data.ipOverride = null;
    return { action: "released", ip: staged };
  }

  // Pin wins: rewrite the staged IP back to the override.
  if (nested) {
    (v as Record<string, unknown>).set = override;
  } else {
    data.ipAddress = override;
  }
  const src = data.ipSource;
  if (src !== undefined) {
    if (src !== null && typeof src === "object" && "set" in (src as Record<string, unknown>)) {
      (src as Record<string, unknown>).set = "manual";
    } else {
      data.ipSource = "manual";
    }
  }
  return { action: "reasserted", discoveredIp: staged };
}

/**
 * Apply the operator's blank pin (Asset.ipBlankPinned) to a pending Asset
 * write — the "no address" sibling of applyIpOverride, with the same
 * discovery-gets-a-vote outcome vocabulary:
 *
 *   "none"       — no pin, the write doesn't stage ipAddress, the write
 *                  touches ipOverride / ipBlankPinned itself (an operator or
 *                  conflict-accept path — authoritative), or it stages a
 *                  clear (discovery agreeing with the blank keeps the pin:
 *                  unlike an address pin it does NOT self-release, or the
 *                  next source to report an address would quietly fill it).
 *   "reasserted" — the write stages an address: it is dropped (ipAddress and
 *                  any staged ipSource written back to null) and
 *                  `discoveredIp` names it, so the caller raises the
 *                  ip-override Conflict.
 *
 * Mutates `data` in place.
 */
export function applyIpBlankPin(
  data: Record<string, unknown>,
  pinned: boolean | null | undefined,
): IpOverrideOutcome {
  if (!data || typeof data !== "object") return { action: "none" };
  if (!("ipAddress" in data)) return { action: "none" };
  if ("ipOverride" in data || "ipBlankPinned" in data) return { action: "none" };
  if (!pinned) return { action: "none" };
  const staged = stagedIpOf(data);
  if (!staged) return { action: "none" };
  const v = data.ipAddress;
  if (v !== null && typeof v === "object" && "set" in (v as Record<string, unknown>)) {
    (v as Record<string, unknown>).set = null;
  } else {
    data.ipAddress = null;
  }
  if (data.ipSource !== undefined) {
    const src = data.ipSource;
    if (src !== null && typeof src === "object" && "set" in (src as Record<string, unknown>)) {
      (src as Record<string, unknown>).set = null;
    } else {
      data.ipSource = null;
    }
  }
  return { action: "reasserted", discoveredIp: staged };
}

/**
 * The address a pending Asset write stages, trimmed, or null when the write
 * stages none or a clear. Handles the plain and Prisma nested (`{ set }`)
 * shapes.
 */
export function stagedIpOf(data: Record<string, unknown> | null | undefined): string | null {
  if (!data || typeof data !== "object" || !("ipAddress" in data)) return null;
  const v = data.ipAddress;
  const raw = v !== null && typeof v === "object" && "set" in (v as Record<string, unknown>)
    ? (v as Record<string, unknown>).set
    : v;
  return typeof raw === "string" ? raw.trim() || null : null;
}

/**
 * Outcome of applying an operator-blanked address (Asset.ipCleared) to a
 * pending Asset write — business rule 40(j).
 *
 *   "none"     — no hold on the row, the write doesn't stage an address (or
 *                stages a clear — the blank stays blank), or the write itself
 *                touches ipCleared (authoritative).
 *   "filled"   — the write stages a DIFFERENT address: it passes through and
 *                the hold is released in the same write. This is the case the
 *                hold exists for — the device came back somewhere else.
 *   "returned" — the write re-stages the blanked address and nothing else
 *                holds it any more: the collision is gone, so the address is
 *                the device's again and the hold is released.
 *   "held"     — the write re-stages the blanked address while another
 *                network-present asset still records it: the address (and any
 *                staged ipSource) is dropped from the write, so the row stays
 *                blank rather than walking back onto the contested address.
 */
export type IpClearedOutcome =
  | { action: "none" }
  | { action: "filled"; ip: string }
  | { action: "returned"; ip: string }
  | { action: "held"; ip: string };

/**
 * Apply Asset.ipCleared to a pending write. `contested` says whether another
 * network-present asset currently records the blanked address — the caller
 * reads it only when `stagedIpOf(data)` equals the hold, so the common path
 * costs nothing. Mutates `data` in place.
 */
export function applyIpCleared(
  data: Record<string, unknown>,
  cleared: string | null | undefined,
  contested: boolean,
): IpClearedOutcome {
  if (!data || typeof data !== "object") return { action: "none" };
  if (!("ipAddress" in data)) return { action: "none" };
  if ("ipCleared" in data) return { action: "none" };
  if (!cleared) return { action: "none" };
  const staged = stagedIpOf(data);
  if (!staged) return { action: "none" };

  if (staged !== cleared.trim()) {
    data.ipCleared = null;
    return { action: "filled", ip: staged };
  }
  if (!contested) {
    data.ipCleared = null;
    return { action: "returned", ip: staged };
  }
  delete data.ipAddress;
  delete data.ipSource;
  return { action: "held", ip: staged };
}

/**
 * Evidence-source labels for Asset.lastSeenSource. Open set — the UI renders
 * the string verbatim — but every writer should use one of these so operators
 * see a consistent vocabulary.
 */
export type LastSeenSource =
  | "dhcp-lease"        // live DHCP lease / reservation confirmed actively held
  | "device-inventory"  // FortiGate per-client device inventory (device-reported timestamp)
  | "discovery"         // infra device answered / reported connected during discovery
  | "vcenter"           // vCenter reported the VM powered-on / the ESXi host connected at scrape time
  | "arc"               // Azure Arc reported status="Connected" at scrape time (a live himds heartbeat)
  | "unraid"            // Unraid reported the VM / container running (host: its API answered) at scrape time
  | "truenas"           // TrueNAS SCALE reported the VM / App running (host: its API answered) at scrape time
  | "proxmox"           // Proxmox VE reported the VM / LXC running (node: online in the cluster) at scrape time
  | "agent"             // Polaris Agent heartbeat
  | "probe"             // successful monitor probe
  | "ping"              // AD/Entra presence-verification ICMP fallback
  | "conflict-accept"   // operator accepted a discovery conflict carrying lastSeen
  | "conflict-reject";  // separate asset created from a rejected conflict's proposed values

/**
 * Discovery-origin evidence sources. For a MONITORED asset these must not
 * advance lastSeen — the monitor probe is the sole authority for presence
 * (the "use polling to determine last online" rule). A monitored device that's
 * failing its probe keeps lastSeen frozen at its last successful poll even if a
 * FortiGate still remembers it online in device inventory / a held lease / a
 * remembered-connected controller entry. Active/operator sources (probe, agent,
 * ping, conflict-*) are never deferred — they ARE the polling/operator signal.
 */
// "vcenter" is deferred like "device-inventory": power_state is real-time
// hypervisor truth at scrape time (unlike stale AD/Entra directory
// timestamps, which never write lastSeen at all), but for a monitored VM
// the probe still owns presence — a powered-on-but-network-dead VM must
// not read as present.
// "arc" is deferred for the same reason as "vcenter". Arc's
// properties.status === "Connected", READ AT DISCOVERY TIME, means the
// resource provider saw a himds heartbeat recently — a live liveness
// statement, categorically different from Entra's lastSyncDateTime or AD's
// lastLogonTimestamp (stored historical timestamps, which is exactly why
// those never write lastSeen at all). But an agent happily reaching Azure
// over a WAN link must not mask a device that's failing its Polaris probe,
// so for a MONITORED asset the probe still owns presence.
//
// Note the evidence timestamp is always RUN TIME, never
// properties.lastStatusChange — that records when the status last CHANGED, so
// a machine Connected for 90 days carries a 90-day-old value.
// "unraid" / "truenas" / "proxmox" are deferred for vCenter's reason: a running
// state read off the host's API is real-time, but a monitored workload's probe
// owns presence.
const POLLING_DEFERRED_SOURCES = new Set<string>(["discovery", "device-inventory", "dhcp-lease", "vcenter", "arc", "unraid", "truenas", "proxmox"]);

/**
 * Single write path for Asset.lastSeen: advance it to `evidenceAt` (stamping
 * `lastSeenSource` alongside) only when the evidence is newer than what the
 * row already holds. lastSeen never moves backward — a stale evidence source
 * (e.g. a FortiGate that remembers a device from weeks ago) can't regress a
 * fresher sighting from another source.
 *
 * Mutates `data` (the pending update payload). `existing` supplies the
 * current row value (and `monitored` flag); pass null/omit for creates.
 * Returns true when the bump was applied.
 */
/**
 * The lifecycle statuses excluded from every "live asset" query — the
 * definition of "asset that counts" for dashboards, maps, description
 * sync, and NOC feeds. Previously the `status: { notIn: [...] }` fragment
 * was retyped verbatim at 14 sites across 6 files; adding a status to
 * this policy (as happened with quarantined/storage) now happens once.
 * NOTE: `maintenance` is deliberately NOT here — surfaces that treat
 * maintenance as its own state (never an outage) filter it separately.
 */
export const EXCLUDED_LIFECYCLE_STATUSES: ("decommissioned" | "disabled")[] = [
  "decommissioned",
  "disabled",
];

export function bumpLastSeen(
  data: Record<string, unknown>,
  existing: { lastSeen?: DateLike; monitored?: boolean } | null | undefined,
  evidenceAt: Date | string,
  source: LastSeenSource | string,
): boolean {
  const ev = evidenceAt instanceof Date ? evidenceAt : new Date(evidenceAt);
  if (Number.isNaN(ev.getTime())) return false;
  // Polling is authoritative for monitored assets: discovery-origin evidence
  // can't advance lastSeen. The monitor probe (source "probe") owns it.
  if (existing?.monitored === true && POLLING_DEFERRED_SOURCES.has(source)) return false;
  // The freshest value already staged on this payload wins over the row.
  const stagedRaw = "lastSeen" in data ? (data.lastSeen as DateLike) : null;
  const currentRaw = stagedRaw ?? existing?.lastSeen ?? null;
  if (currentRaw) {
    const current = currentRaw instanceof Date ? currentRaw : new Date(currentRaw);
    if (!Number.isNaN(current.getTime()) && current >= ev) return false;
  }
  data.lastSeen = ev;
  data.lastSeenSource = source;
  return true;
}

/**
 * The asset statuses that CANNOT carry `monitored: true` — the lifecycle
 * states where polling the device is either impossible or a lie:
 *
 *   decommissioned / disabled — the asset is out of service (business rule 10).
 *   storage                   — on a shelf, not on the network.
 *   quarantined               — deliberately isolated at the FortiGate, so
 *                               every probe fails BY DESIGN. Polling it once
 *                               meant a security action produced an outage
 *                               alert storm about the isolation working.
 *
 * `maintenance` is deliberately NOT here: a window pauses polling
 * (MONITOR_CANDIDATE_WHERE) while `monitored` keeps the operator's intent so
 * it survives the window (business rule 16).
 *
 * Enforced centrally by clampMonitoredForStatus in src/db.ts (both write
 * directions) and swept on boot by jobs/clampMonitoredForStatus.ts.
 */
export const UNMONITORABLE_STATUSES: ("decommissioned" | "disabled" | "storage" | "quarantined")[] = [
  "decommissioned",
  "disabled",
  "storage",
  "quarantined",
];

/** Can an asset in this status be monitor-enabled? Unknown/absent statuses
 *  are permissive — the enum is the authority on what a status may be, and a
 *  value this list has never heard of must not silently stop polling. */
export function statusAllowsMonitoring(status: unknown): boolean {
  if (typeof status !== "string") return true;
  return !(UNMONITORABLE_STATUSES as string[]).includes(status);
}
