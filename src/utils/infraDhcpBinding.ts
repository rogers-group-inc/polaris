/**
 * src/utils/infraDhcpBinding.ts
 *
 * Two decisions the Fortinet-infra reservation rows need, kept pure so they
 * unit-test without a database or a FortiGate.
 *
 * Why this exists: Phase 3a/3b of discovery create a reservation for every
 * managed FortiSwitch / FortiAP with a resolvable address — and that address is
 * often read out of the gate's own DHCP lease table (the hostname fallback), so
 * Polaris records a *dynamic lease* as a reservation with sourceType
 * "fortiswitch"/"fortinap". Phase 5, which is the only pass that knows whether an
 * address is leased or genuinely reserved on the device, had no branch for those
 * source types: the fact was discovered and dropped on every cycle. Operators saw
 * an authoritative-looking row with no Reserve action while the FortiGate's own
 * DHCP page said "Not Reserved".
 *
 * The fix is not to relabel the row. `sourceType` is answering a different
 * question (who owns this IP) and is still right. What was missing is the
 * orthogonal fact — how the gate hands the address out — which now lives in
 * `Reservation.dhcpBinding`. These helpers decide (a) what to write onto an
 * existing infra row when Phase 5 sees a DHCP entry for it, and (b) whether a
 * reservation already sitting at a managed device's IP belongs to THAT device, so
 * Phase 3 doesn't raise a conflict card against a row an operator just created
 * for the AP in front of them.
 */

/** Values `Reservation.dhcpBinding` is allowed to hold. */
export type DhcpBinding = "lease" | "reservation";

/** The subset of `Reservation` these decisions read. */
export interface InfraReservationRow {
  sourceType: string;
  macAddress?: string | null;
  hostname?: string | null;
  dhcpBinding?: string | null;
  pushedToId?: string | null;
  leaseExpiresAt?: Date | null;
}

/** The subset of a discovered DHCP entry these decisions read. */
export interface InfraDhcpEntry {
  /** "dhcp-reservation" = a real reserved-address entry; "dhcp-lease" = dynamic. */
  type: "dhcp-reservation" | "dhcp-lease";
  macAddress?: string | null;
  /** True when the monitor side confirmed a client is actively holding the IP. */
  seenLeased?: boolean;
  /** Unix seconds the lease runs out (FortiOS `expire_time`); leases only. */
  expireTime?: number;
}

/** The two source types whose binding state Phase 5 is the only observer of. */
export const INFRA_SOURCE_TYPES = ["fortiswitch", "fortinap"] as const;

export function isInfraSourceType(sourceType: string | null | undefined): boolean {
  return sourceType === "fortiswitch" || sourceType === "fortinap";
}

/**
 * Is this row takeover-able by an operator "Reserve"?
 *
 * Only a lease-backed infra row. A row marked "reservation" is a real MAC→IP
 * binding on the gate and stays authoritative; a NULL row has simply never been
 * observed in DHCP data (an AP on a static address, or one not currently
 * leasing) and must keep its pre-feature behavior rather than being assumed
 * free — guessing wrong here hands an operator an IP the device is still using.
 */
export function isLeaseBackedInfraRow(row: InfraReservationRow | null | undefined): boolean {
  if (!row) return false;
  return isInfraSourceType(row.sourceType) && row.dhcpBinding === "lease";
}

/** MAC comparison in the Asset/Reservation storage form (upper, colon-separated). */
function normalizeMacForCompare(mac: string | null | undefined): string | null {
  if (!mac) return null;
  const t = mac.trim();
  if (!t) return null;
  return t.toUpperCase().replace(/-/g, ":");
}

export interface InfraBindingPatch {
  dhcpBinding?: DhcpBinding;
  /** Only ever set when the row had none — the lease entry's MAC. */
  macAddress?: string;
  /** Presence stamp, mirroring the dhcp_* branch's staleness bump. */
  lastSeenLeased?: true;
  /** Display-only lease clock; null clears it. Present only on change. */
  leaseExpiresAt?: Date | null;
}

/**
 * What Phase 5 should write onto an existing fortiswitch/fortinap row given the
 * DHCP entry it just found at that IP. Returns null when nothing changed.
 *
 * Returning a patch only on change is load-bearing, not an optimization: this
 * runs per DHCP entry per discovery cycle, and at 2000 assets an unconditional
 * write per row is exactly the pattern the surrounding code goes out of its way
 * to avoid (it defers pure staleness bumps into one updateMany).
 *
 * Three deliberate omissions:
 *   • `expiresAt` is never staged. A lease carries an expiry, and stamping it
 *     here would hand these rows to expireReservations — the row would expire on
 *     the gate's lease clock, be re-created by the next discovery, and churn,
 *     with windows where a live AP reads as unreserved. The expiry goes to
 *     `leaseExpiresAt` instead, which nothing acts on; the IP panel shows it.
 *     It changes only when the device renews, so the change-only rule above
 *     still holds — one write per renewal, not one per cycle.
 *   • `macAddress` is taken from the LEASE ENTRY only, and only to fill a blank.
 *     It is the MAC the gate actually saw requesting the address, which is the
 *     only MAC a future MAC→IP push may bind. A device's base MAC is not
 *     reliably its DHCP client MAC, and binding the wrong one yields an entry
 *     that looks correct everywhere and never binds.
 *   • `sourceType` is never touched. The row's ownership fact is unchanged.
 */
export function decideInfraDhcpBinding(
  row: InfraReservationRow,
  entry: InfraDhcpEntry,
): InfraBindingPatch | null {
  if (!isInfraSourceType(row.sourceType)) return null;

  const patch: InfraBindingPatch = {};

  const binding: DhcpBinding = entry.type === "dhcp-reservation" ? "reservation" : "lease";
  if (row.dhcpBinding !== binding) patch.dhcpBinding = binding;

  // Fill-only. An operator-corrected MAC on the row is never overwritten by
  // discovery, matching how the description-sync and VIP-merge paths treat
  // operator-authored values.
  const entryMac = normalizeMacForCompare(entry.macAddress);
  if (entryMac && !normalizeMacForCompare(row.macAddress)) patch.macAddress = entryMac;

  // Inert today — the stale-reservation service only evaluates dhcp_reservation
  // rows — but it keeps these rows consistent with the presence model, and it is
  // the evidence a future pool/staleness surface would read.
  if (entry.seenLeased) patch.lastSeenLeased = true;

  // A reservation entry has no lease clock, so it clears one left by an
  // earlier lease; a lease without a usable expiry clears it too rather than
  // keep showing a date the gate no longer reports.
  const leaseExpiresAt =
    binding === "lease" && typeof entry.expireTime === "number" && entry.expireTime > 0
      ? new Date(entry.expireTime * 1000)
      : null;
  const current = row.leaseExpiresAt ? new Date(row.leaseExpiresAt).getTime() : null;
  if ((leaseExpiresAt ? leaseExpiresAt.getTime() : null) !== current) patch.leaseExpiresAt = leaseExpiresAt;

  return Object.keys(patch).length > 0 ? patch : null;
}

/** Case-insensitive equality that treats blank/absent as "unknown", not a match. */
function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export interface InfraReleaseDevice {
  mac?: string | null;
  name?: string | null;
  /** Asset.discoveredByIntegrationId */
  integrationId?: string | null;
  /** fortinetTopology.controllerFortigate */
  controllerFortigate?: string | null;
}

export interface InfraReleaseCandidate {
  sourceType: string;
  macAddress?: string | null;
  hostname?: string | null;
  pushedToId?: string | null;
  /** Subnet.discoveredBy */
  subnetDiscoveredBy?: string | null;
  /** Subnet.fortigateDevice */
  subnetFortigateDevice?: string | null;
}

/**
 * May a device going away release this reservation, found at its address?
 *
 * Reservations are matched by IP, and RFC1918 space repeats behind different
 * gates — business rule 17 already scopes ARP presence evidence per (device, ip)
 * for exactly this reason. So two scope tests run first, each skipped when either
 * side doesn't know its own answer (an unknown must not silently authorize a
 * release): the row's subnet must belong to the asset's integration, and when
 * both name a FortiGate those must agree.
 *
 * Then ownership: a fortiswitch/fortinap row is ours by construction, and a
 * Polaris-PUSHED row counts when `reservationBelongsToInfraDevice` ties it to
 * this device. Everything else — above all an operator's own manual reservation
 * at the address — survives the device's removal.
 */
export function shouldReleaseInfraReservation(
  device: InfraReleaseDevice,
  row: InfraReleaseCandidate,
): boolean {
  if (
    device.integrationId && row.subnetDiscoveredBy &&
    device.integrationId !== row.subnetDiscoveredBy
  ) return false;

  if (
    device.controllerFortigate && row.subnetFortigateDevice &&
    !sameName(device.controllerFortigate, row.subnetFortigateDevice)
  ) return false;

  if (isInfraSourceType(row.sourceType)) return true;
  return !!row.pushedToId && reservationBelongsToInfraDevice(row, { mac: device.mac, name: device.name });
}

/**
 * What the orphan reconcile should do with an infra row, given the managed
 * devices (if any) currently holding its address within the same integration.
 *
 * Asymmetric on purpose, because the two signals cost differently when wrong:
 *   • every matching device decommissioned → "release". Someone already judged
 *     the device gone.
 *   • no matching device at all → "release" only for a row Polaris never pushed.
 *     That signal is weak (a transient discovery state, or an asset create that
 *     failed after its reservation landed) and a false positive on a pushed row
 *     would mean an unnecessary WRITE to a production gate. A Polaris-local row
 *     released in error costs nothing — discovery re-creates it next cycle.
 */
export function classifyOrphanInfraRow(
  row: { pushedToId?: string | null },
  matchingDeviceStatuses: string[],
): "release" | "skip" | "keep" {
  if (matchingDeviceStatuses.length === 0) return row.pushedToId ? "skip" : "release";
  return matchingDeviceStatuses.every((s) => s === "decommissioned") ? "release" : "keep";
}

/**
 * Does an existing reservation at a managed device's IP belong to that device?
 *
 * Phase 3a/3b raise a conflict card whenever they find a `manual` row at the
 * switch/AP address they are about to claim. Once an operator reserves an AP's
 * IP — which is the whole point of making these rows takeover-able — that is
 * precisely what the next discovery cycle finds, so without this predicate the
 * feature's first effect would be a conflict card per reserved AP.
 *
 * Identity is MAC first (the strong key), then hostname, then "Polaris pushed
 * this row somewhere" as the weakest signal — a pushed row at the device's own
 * address was created by this system on purpose, not typed by an operator who
 * happens to want the same IP. A genuine collision — an operator reserving an
 * address a different device holds — still matches none of these and still
 * raises its card.
 */
export function reservationBelongsToInfraDevice(
  row: InfraReservationRow | null | undefined,
  device: { mac?: string | null; name?: string | null },
): boolean {
  if (!row) return false;

  const rowMac = normalizeMacForCompare(row.macAddress);
  const devMac = normalizeMacForCompare(device.mac);
  if (rowMac && devMac) return rowMac === devMac;

  const rowHost = (row.hostname || "").trim().toLowerCase();
  const devHost = (device.name || "").trim().toLowerCase();
  if (rowHost && devHost && rowHost === devHost) return true;

  return !!row.pushedToId;
}
