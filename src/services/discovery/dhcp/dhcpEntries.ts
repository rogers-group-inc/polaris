/**
 * src/services/discovery/dhcp/dhcpEntries.ts — syncDhcpSubnets Phase 5:
 * create or reconcile one reservation per DHCP lease / reservation the gates
 * report (in-memory lookups). An existing row is flipped between lease and
 * reservation, echoed (a Polaris-pushed manual row), conflicted, taken over
 * from a vanished VIP's placeholder, adopted, or — for a managed switch / AP's
 * own row — has its DHCP binding state recorded (rule 23); an observed IPv6
 * row the gate now binds is superseded (rule 125). Steady-state
 * `lastSeenLeased` bumps are flushed as one updateMany. Emits one summary line
 * with per-path and per-write counters. CQ-B060; the body moved verbatim, its
 * free variables made parameters. The engine-defined helpers (findSubnetForIp,
 * reservationKey, upsertConflict) are passed in, so this module imports
 * nothing from the engine at runtime.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { AssetIndex, upsertConflict as UpsertConflict } from "../discoveryEngine.js";
import type { SyncLog } from "../syncLog.js";
import { prisma } from "../../../db.js";
import { mapSettledWithConcurrency } from "../../../utils/concurrency.js";
import { logEvent } from "../../eventLogService.js";
import { releaseDnsResolvedAt } from "../../dnsResolvedReservationService.js";
import { isInfraSourceType, decideInfraDhcpBinding } from "../../../utils/infraDhcpBinding.js";
import { dhcpExpiryPatch } from "../../../utils/dhcpLeaseExpiry.js";

export async function syncDhcpEntries(input: {
  result: DiscoveryResult;
  /** syncDhcpSubnets' active-reservation index, keyed by reservationKey; updated in place. */
  activeResMap: Map<string, any>;
  /** Keys (reservationKey) holding an active dns_resolved row at the run's load.
   *  Absent = unknown: release before every create, as before. */
  dnsResolvedKeys?: ReadonlySet<string>;
  assetIdx: AssetIndex;
  /** Phase 3c's VIP address keys, and the gates whose VIP table read this cycle. */
  currentVipKeys: Set<string>;
  vipQueriedDevices: Set<string>;
  /** Appended to for the run's summary counts, as before. */
  dhcpLeases: string[];
  dhcpReservations: string[];
  findSubnetForIp: (ip: string) => { id: string } | undefined;
  reservationKey: (subnetId: string, ip: string) => string;
  upsertConflict: typeof UpsertConflict;
  projectRefLabel: string;
  integrationId: string;
  integrationName: string;
  actor: string | undefined;
  syncLog: SyncLog;
}): Promise<void> {
  const {
    result, activeResMap, dnsResolvedKeys, assetIdx, currentVipKeys, vipQueriedDevices, dhcpLeases, dhcpReservations,
    findSubnetForIp, reservationKey, upsertConflict, projectRefLabel,
    integrationId, integrationName, actor, syncLog,
  } = input;

  // Phase 5 instrumentation — counts per-branch path frequency and per-type
  // write fire count so we can size the actual per-cycle DB pressure before
  // deciding whether to bulk-batch the create / update paths. Emitted as a
  // single info-level syncLog at the bottom of the phase; one Event row per
  // per-FortiGate sync. Cheap (just integer increments) and always-on so
  // operators can grep the Events page to characterize their fleet.
  const phase5Stats = {
    entriesTotal: 0,
    skippedNoIp: 0,
    skippedNoSubnet: 0,
    skippedCollision: 0,
    // Path counters (exactly one per processed entry).
    // dhcpFlipMixed = the row needed a sourceType change (and maybe also a
    // staleness bump) — written inline as one per-row update.
    // dhcpFlipBumpOnly = the row only needed lastSeenLeased=now (steady-state
    // confirmation that an existing dhcp_reservation's target is still online)
    // — deferred to one bulk updateMany at end of phase. On big FortiGates with
    // hundreds of leased reservations this is the dominant per-cycle write cost
    // and bulking it collapses N statements into 1 round-trip.
    pathExistingDhcpNoChange: 0,
    pathExistingDhcpFlipMixed: 0,
    pathExistingDhcpFlipBumpOnly: 0,
    pathExistingManualPolarisEcho: 0,
    pathExistingManualConflictOnly: 0,
    pathExistingVipSuccession: 0,
    pathExistingVipMacFill: 0,
    pathExistingPendingAdopt: 0,
    pathExistingPendingCollide: 0,
    // infraBinding* = an existing fortiswitch/fortinap row (Phase 3a/3b created
    // it for a managed switch/AP) that this DHCP entry tells us the binding
    // state of. Before these two existed the source types matched NO branch and
    // fell through with no counter at all, which is why the "path-* counters sum
    // to entriesTotal" property below was quietly false for every managed
    // switch/AP on the gate.
    pathExistingInfraBindingChange: 0,
    pathExistingInfraNoChange: 0,
    // An `observed` IPv6 row (business rule 125) the gate's DHCP now binds.
    pathExistingObservedSuperseded: 0,
    pathNewCreate: 0,
    pathNewCreateAfterRetry: 0,
    pathNewCreateFailed: 0,
    // Write counters (statement count, NOT row count).
    // writesReservationUpdateMany is the bulk path — 0 or 1 statement per
    // cycle, covering pathExistingDhcpFlipBumpOnly rows.
    writesReservationUpdate: 0,
    writesReservationUpdateMany: 0,
    writesReservationCreate: 0,
    writesReservationDelete: 0,
    writesConflictUpdateMany: 0,
    writesDnsRelease: 0,
    writesUpsertConflict: 0,
  };
  // Collected ids whose only Phase 5 write is the lastSeenLeased=now bump.
  // Flushed as one updateMany after the loop.
  const dhcpFlipBumpOnlyIds: string[] = [];
  // Per-row renewals / type flips (each row's lease end differs, so no single
  // statement covers them): queued here, merged per row, and written
  // concurrently after the loop instead of one awaited update per entry. The
  // loop keeps `existingRes` current in memory, as it did after each write.
  const dhcpMixedUpdates = new Map<string, Record<string, unknown>>();

  if (result.dhcpEntries && result.dhcpEntries.length > 0) {
    for (const entry of result.dhcpEntries) {
      phase5Stats.entriesTotal++;
      if (!entry.ipAddress) { phase5Stats.skippedNoIp++; continue; }

      const matchingSubnet = findSubnetForIp(entry.ipAddress);
      if (!matchingSubnet) { phase5Stats.skippedNoSubnet++; continue; }

      const key = reservationKey(matchingSubnet.id, entry.ipAddress);
      const isDhcpReservation = entry.type === "dhcp-reservation";

      // Look up matching asset by MAC (in-memory)
      let matchedAsset: any = null;
      if (entry.macAddress) {
        matchedAsset = assetIdx.findByMac(entry.macAddress.toUpperCase().replace(/-/g, ":"));
      }

      const proposedHostname = (matchedAsset && matchedAsset.hostname) || entry.hostname || null;
      const proposedOwner = (matchedAsset && matchedAsset.assignedTo) || (isDhcpReservation ? "dhcp-reservation" : "dhcp-lease");
      const proposedNotes = [
        `${isDhcpReservation ? "DHCP reservation" : "DHCP lease"} on ${entry.device} (${entry.interfaceName})`,
        entry.macAddress ? `MAC: ${entry.macAddress}` : null,
        entry.vci ? `Model: ${entry.vci}` : null,
        entry.ssid ? `SSID: ${entry.ssid}` : null,
        entry.accessPoint ? `AP: ${entry.accessPoint}` : null,
      ].filter(Boolean).join(" — ");
      // Use vci to identify FortiSwitch/FortiAP entries not caught by managed device APIs
      const vciLower = (entry.vci || "").toLowerCase();
      const proposedSourceType = (
        vciLower.startsWith("fortiswitch-") ? "fortiswitch" :
        vciLower.startsWith("fortiap-") ? "fortinap" :
        isDhcpReservation ? "dhcp_reservation" : "dhcp_lease"
      ) as "fortiswitch" | "fortinap" | "dhcp_reservation" | "dhcp_lease";
      const proposedExpiresAt = !isDhcpReservation && entry.expireTime ? new Date(entry.expireTime * 1000) : undefined;

      const existingRes = activeResMap.get(key);
      if (existingRes) {
        // Queued push-row collision handling — runs BEFORE the manual /
        // Polaris-pushed branches because a pending row has sourceType
        // "manual" and a pushedToId stamp (we set both at queue time so the
        // queue view knows the intended target). Without this guard the
        // existing logic would silently flip the pending row to
        // dhcp_reservation as if it were our own echo — but nothing has
        // actually been written to the device yet.
        if (existingRes.sourceType === "manual" && existingRes.pushStatus === "pending") {
          const pendingMac = existingRes.macAddress
            ? existingRes.macAddress.toUpperCase().replace(/-/g, ":")
            : null;
          const freshMac = entry.macAddress
            ? entry.macAddress.toUpperCase().replace(/-/g, ":")
            : null;
          const macsMatch = !!pendingMac && !!freshMac && pendingMac === freshMac;
          if (
            isDhcpReservation &&
            macsMatch &&
            typeof entry.scopeId === "number" &&
            typeof entry.entryId === "number"
          ) {
            // Fast-path adopt — operator added the entry on the device
            // (or a previous retry succeeded but Polaris missed the reply)
            // while we were queued. Promote in place to synced.
            phase5Stats.pathExistingPendingAdopt++;
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: {
                sourceType: "dhcp_reservation",
                pushedToId: integrationId,
                pushedScopeId: entry.scopeId,
                pushedEntryId: entry.entryId,
                pushStatus: "synced",
                pushedAt: new Date(),
                pushError: null,
                pushQueuedAt: null,
                pushAttempts: 0,
                pushLastAttemptAt: null,
                ...(entry.seenLeased
                  ? { lastSeenLeased: new Date(), staleNotifiedAt: null, staleSnoozedUntil: null }
                  : {}),
              },
            });
            phase5Stats.writesReservationUpdate++;
            await prisma.conflict.updateMany({
              where: { reservationId: existingRes.id, status: "pending" },
              data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
            });
            phase5Stats.writesConflictUpdateMany++;
            existingRes.sourceType = "dhcp_reservation";
            existingRes.pushStatus = "synced";
            logEvent({
              action: "reservation.push.queued.adopted",
              level: "info",
              resourceType: "reservation",
              resourceId: existingRes.id,
              resourceName: existingRes.hostname || entry.ipAddress,
              actor,
              message: `Queued reservation adopted by discovery — entry already on FortiGate "${entry.device}" (scope ${entry.scopeId}, entry ${entry.entryId})`,
              details: {
                integrationId,
                integrationName,
                deviceName: entry.device,
                scopeId: entry.scopeId,
                entryId: entry.entryId,
                ip: entry.ipAddress,
                mac: pendingMac,
              },
            });
            continue;
          }
          // Hard collision: pending row at this IP, but discovery sees a
          // different MAC or a dhcp_lease. Flip to failed_permanent so the
          // operator can see what won the IP, and skip the discovery create
          // on this IP — the unique-on-active constraint would block it
          // anyway.
          const errMsg = `IP collided during queue — discovered ${proposedSourceType}${freshMac ? ` by ${freshMac}` : ""}`;
          phase5Stats.pathExistingPendingCollide++;
          await prisma.reservation.update({
            where: { id: existingRes.id },
            data: {
              pushStatus: "failed_permanent",
              pushError: errMsg,
              pushLastAttemptAt: new Date(),
            },
          });
          phase5Stats.writesReservationUpdate++;
          existingRes.pushStatus = "failed_permanent";
          logEvent({
            action: "reservation.push.queued.collided",
            level: "warning",
            resourceType: "reservation",
            resourceId: existingRes.id,
            resourceName: existingRes.hostname || entry.ipAddress,
            actor,
            message: `Queued push for ${entry.ipAddress} aborted — ${errMsg}. Release the reservation or pick a different IP.`,
            details: {
              integrationId,
              integrationName,
              deviceName: entry.device,
              ip: entry.ipAddress,
              pendingMac,
              discoveredSourceType: proposedSourceType,
              discoveredMac: freshMac,
            },
          });
          continue;
        }
        if (existingRes.sourceType === "manual") {
          if (existingRes.pushedToId) {
            // Polaris-pushed manual reservation — discovery is just seeing
            // its own echo. Flip sourceType silently so the conflict isn't
            // raised and future discoveries treat this as a normal
            // dhcp_reservation. We do NOT overwrite the user-provided
            // hostname / owner / projectRef / notes — the device-side
            // description is intentionally distinct (Polaris/<user>:
            // <hostname>) and shouldn't become the Polaris-side hostname.
            // Also dismiss any pending conflicts already raised on this
            // row from prior discovery runs that didn't have this guard.
            phase5Stats.pathExistingManualPolarisEcho++;
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: {
                sourceType: "dhcp_reservation",
                ...(entry.seenLeased && isDhcpReservation
                  ? { lastSeenLeased: new Date(), staleNotifiedAt: null, staleSnoozedUntil: null }
                  : {}),
              },
            });
            phase5Stats.writesReservationUpdate++;
            await prisma.conflict.updateMany({
              where: { reservationId: existingRes.id, status: "pending" },
              data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
            });
            phase5Stats.writesConflictUpdateMany++;
          } else {
            phase5Stats.pathExistingManualConflictOnly++;
            await upsertConflict(existingRes.id, integrationId, { hostname: proposedHostname, owner: proposedOwner, projectRef: projectRefLabel, notes: proposedNotes, sourceType: proposedSourceType }, existingRes);
            phase5Stats.writesUpsertConflict++;
          }
        } else if (existingRes.sourceType === "vip") {
          const vipStillExists = currentVipKeys.has(key);
          const macNormalized = entry.macAddress ? entry.macAddress.toUpperCase().replace(/-/g, ":") : null;

          if (!vipStillExists && vipQueriedDevices.has(((existingRes.vipInfo as any)?.device) || "")) {
            // VIP succession: the FortiGate no longer reports this VIP (we
            // queried successfully, the entry isn't there), and a DHCP
            // lease/reservation has landed at the same IP. Convert the row
            // in place — preserves the reservation id and any operator
            // edits while the sourceType honestly reflects the gate's
            // current state. Operator-typed owner / notes / hostname
            // survive; only the canonical VIP-discovery placeholders are
            // overwritten by the DHCP-discovery equivalents.
            // The canonical owner is the VIP's name. A VIP renamed at the same
            // address refreshes vipInfo but never owner or hostname, so a row
            // whose owner still matches its discovery-written hostname is
            // canonical too.
            const vipName = (existingRes.vipInfo as any)?.name;
            const isCanonicalVipOwner =
              !!existingRes.owner &&
              (existingRes.owner === vipName || existingRes.owner === existingRes.hostname);
            const isCanonicalVipNotes =
              !existingRes.notes ||
              (typeof existingRes.notes === "string" &&
                (existingRes.notes.startsWith("Firewall VIP ") || existingRes.notes.startsWith("Virtual server ")));
            const updateData: Record<string, unknown> = {
              sourceType: proposedSourceType,
              vipInfo: null,
            };
            if (isCanonicalVipOwner) updateData.owner = proposedOwner;
            if (isCanonicalVipNotes) updateData.notes = proposedNotes;
            if (macNormalized && !existingRes.macAddress) updateData.macAddress = macNormalized;
            if (entry.seenLeased && isDhcpReservation) {
              updateData.lastSeenLeased = new Date();
              updateData.staleNotifiedAt = null;
              updateData.staleSnoozedUntil = null;
            }
            phase5Stats.pathExistingVipSuccession++;
            await prisma.reservation.update({ where: { id: existingRes.id }, data: updateData });
            phase5Stats.writesReservationUpdate++;
            // Auto-reject any pending VIP-merge conflicts on this row —
            // they were raised against the prior VIP state which is now
            // gone. The DHCP source is unambiguous; no operator review
            // needed.
            await prisma.conflict.updateMany({
              where: { reservationId: existingRes.id, status: "pending" },
              data: { status: "rejected", resolvedBy: "auto", resolvedAt: new Date() },
            });
            phase5Stats.writesConflictUpdateMany++;
            const priorVipInfo = existingRes.vipInfo as any;
            existingRes.sourceType = proposedSourceType;
            existingRes.vipInfo = null;
            if (isCanonicalVipOwner) existingRes.owner = proposedOwner;
            if (isCanonicalVipNotes) existingRes.notes = proposedNotes;
            if (macNormalized && !existingRes.macAddress) existingRes.macAddress = macNormalized;
            logEvent({
              action: "reservation.vip.replaced",
              resourceType: "reservation",
              resourceId: existingRes.id,
              resourceName: `${entry.ipAddress}`,
              actor,
              message: `VIP "${priorVipInfo?.name || "(unknown)"}" no longer on ${priorVipInfo?.device || "(unknown)"} — converted to ${proposedSourceType.replace("_", " ")} at ${entry.ipAddress}`,
              details: {
                integrationId,
                integrationName,
                reservationId: existingRes.id,
                ipAddress: entry.ipAddress,
                priorVipInfo,
                newSourceType: proposedSourceType,
                fortigateDevice: entry.device,
              },
            });
            continue;
          }

          // VIP + DHCP collision (DHCP arriving second): the FortiGate has a
          // VIP external IP that also shows up as a DHCP lease/reservation.
          // Silent fill of macAddress (technical observation; no operator
          // decision needed), then a FILL-ONLY merge conflict: the VIP row's
          // own owner / projectRef / hostname are authoritative (VIP is
          // load-bearing firewall config), so the DHCP side's values are never
          // offered for review — only a field the VIP row left blank raises a
          // card. upsertConflict's 30-day guard prevents re-raise once the
          // operator resolves.
          phase5Stats.pathExistingVipMacFill++;
          if (macNormalized && !existingRes.macAddress) {
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: { macAddress: macNormalized },
            });
            phase5Stats.writesReservationUpdate++;
            existingRes.macAddress = macNormalized;
          }
          await upsertConflict(
            existingRes.id,
            integrationId,
            { hostname: proposedHostname, owner: proposedOwner, projectRef: projectRefLabel, notes: proposedNotes, sourceType: proposedSourceType },
            existingRes,
            "fill-only",
          );
          phase5Stats.writesUpsertConflict++;
        } else if (
          existingRes.sourceType === "dhcp_lease" ||
          existingRes.sourceType === "dhcp_reservation"
        ) {
          // Existing dhcp_* row: keep sourceType honest as the device-side
          // state shifts (e.g. a lease IP gets promoted to a static
          // reservation, or a static reservation is removed and only a
          // lease remains). When sourceType flips, also flip the
          // conventional owner placeholder ("dhcp-lease" ↔
          // "dhcp-reservation") so the UI status pill and owner column
          // stay aligned. Operator-stamped owners (anything outside that
          // allowlist) survive untouched.
          const needsSourceFlip = existingRes.sourceType !== proposedSourceType;
          const needsStalenessBump = entry.seenLeased && isDhcpReservation;
          // A renewed lease carries a new end; a lease promoted to a
          // reservation must stop expiring. Without this the row kept the
          // expiry it was created with, expireStaleReservations retired a
          // live lease, and the next pass re-created it under a new id
          // (utils/dhcpLeaseExpiry.ts).
          const expiryPatch = dhcpExpiryPatch(existingRes.expiresAt, proposedSourceType, proposedExpiresAt);
          if (needsSourceFlip || expiryPatch) {
            // Mixed update — the new sourceType / lease end differs per row,
            // so we can't bulk these (updateMany only supports one common
            // data shape). Issue inline as one per-row update; the staleness
            // bump rides along when both apply. A renewal lands here once
            // per lease renewal, not once per pass.
            const update: Record<string, unknown> = {
              sourceType: proposedSourceType,
              ...(expiryPatch ?? {}),
            };
            if (
              existingRes.owner === "dhcp-lease" ||
              existingRes.owner === "dhcp-reservation"
            ) {
              update.owner =
                proposedSourceType === "dhcp_reservation"
                  ? "dhcp-reservation"
                  : "dhcp-lease";
            }
            if (needsStalenessBump) {
              update.lastSeenLeased = new Date();
              update.staleNotifiedAt = null;
              update.staleSnoozedUntil = null;
            }
            phase5Stats.pathExistingDhcpFlipMixed++;
            dhcpMixedUpdates.set(existingRes.id, { ...(dhcpMixedUpdates.get(existingRes.id) ?? {}), ...update });
            if (expiryPatch) existingRes.expiresAt = expiryPatch.expiresAt;
          } else if (needsStalenessBump) {
            // Pure staleness bump — defer to one bulk updateMany at end of
            // phase. Every row in this set gets the same data shape
            // (lastSeenLeased=now, clear staleNotifiedAt + staleSnoozedUntil),
            // so a single statement covers them all. On a 200-row FortiGate
            // this is the difference between 100+ updates and 1.
            dhcpFlipBumpOnlyIds.push(existingRes.id);
            phase5Stats.pathExistingDhcpFlipBumpOnly++;
          } else {
            phase5Stats.pathExistingDhcpNoChange++;
          }
        } else if (existingRes.sourceType === "observed") {
          // An observed IPv6 sighting (business rule 125) is evidence, not a
          // claim; the gate's own DHCP binding for the address is the stronger
          // fact. Convert in place so the row keeps its id.
          const macNormalized = entry.macAddress ? entry.macAddress.toUpperCase().replace(/-/g, ":") : null;
          const update: Record<string, unknown> = {
            sourceType: proposedSourceType,
            owner: proposedOwner,
            notes: proposedNotes,
            expiresAt: proposedExpiresAt ?? null,
            ...(proposedHostname ? { hostname: proposedHostname } : {}),
            ...(macNormalized ? { macAddress: macNormalized } : {}),
          };
          phase5Stats.pathExistingObservedSuperseded++;
          await prisma.reservation.update({ where: { id: existingRes.id }, data: update });
          phase5Stats.writesReservationUpdate++;
          existingRes.sourceType = proposedSourceType;
          if (macNormalized) existingRes.macAddress = macNormalized;
        } else if (isInfraSourceType(existingRes.sourceType)) {
          // Managed FortiSwitch/FortiAP row (Phase 3a/3b created it, and the IP
          // it claimed may have come from this very lease table via the hostname
          // fallback). Phase 5 is the ONLY pass that can see whether the gate
          // leases this address or genuinely reserves it, and before this branch
          // existed it dropped that fact on the floor every cycle — leaving a
          // row that reads authoritative in Polaris while the FortiGate's DHCP
          // page says "Not Reserved", with no Reserve action to fix it.
          //
          // sourceType is deliberately NOT flipped: it answers "who owns this
          // IP" and is still correct. Only the orthogonal binding fact is
          // recorded. See utils/infraDhcpBinding.ts for why expiresAt is never
          // stamped here (the lease clock goes to the display-only
          // leaseExpiresAt) and why the MAC comes from the lease entry only.
          const patch = decideInfraDhcpBinding(existingRes, entry);
          if (patch) {
            const update: Record<string, unknown> = {};
            if (patch.dhcpBinding) update.dhcpBinding = patch.dhcpBinding;
            if (patch.macAddress) update.macAddress = patch.macAddress;
            if (patch.leaseExpiresAt !== undefined) update.leaseExpiresAt = patch.leaseExpiresAt;
            if (patch.lastSeenLeased) {
              update.lastSeenLeased = new Date();
              update.staleNotifiedAt = null;
              update.staleSnoozedUntil = null;
            }
            phase5Stats.pathExistingInfraBindingChange++;
            await prisma.reservation.update({
              where: { id: existingRes.id },
              data: update,
            });
            phase5Stats.writesReservationUpdate++;
            if (patch.dhcpBinding) existingRes.dhcpBinding = patch.dhcpBinding;
            if (patch.macAddress) existingRes.macAddress = patch.macAddress;
            if (patch.leaseExpiresAt !== undefined) existingRes.leaseExpiresAt = patch.leaseExpiresAt;
          } else {
            // Steady state — the overwhelmingly common case once a fleet has
            // been through one cycle. No write: this runs per DHCP entry per
            // cycle and at 2000 assets an unconditional update here would be
            // the same mistake the bulked staleness bump above exists to avoid.
            phase5Stats.pathExistingInfraNoChange++;
          }
        }
        continue;
      }

      // Persist the MAC at first discovery. The FortiOS CMDB reserved-address
      // payload already carries the MAC; without this the row is created with
      // macAddress=null and the IP panel edit modal can't render the existing
      // MAC for the operator to edit.
      const normalizedMacAtCreate = entry.macAddress
        ? entry.macAddress.toUpperCase().replace(/-/g, ":")
        : null;
      const createData = {
        subnetId: matchingSubnet.id,
        ipAddress: entry.ipAddress,
        hostname: proposedHostname,
        owner: proposedOwner,
        projectRef: projectRefLabel,
        notes: proposedNotes,
        macAddress: normalizedMacAtCreate,
        status: "active" as const,
        sourceType: proposedSourceType,
        expiresAt: proposedExpiresAt,
        // First-discovery stamp for newly-created dhcp_reservation rows
        // whose target is currently online — gives the stale job a
        // baseline so it doesn't immediately flag a brand-new reservation
        // we just learned about.
        lastSeenLeased: entry.seenLeased && isDhcpReservation ? new Date() : null,
      };
      try {
        // Only where the run's load saw a dns_resolved row (efficiency audit
        // group 3: this was a delete per new lease). One that appears mid-run
        // collides below and is released and retried there.
        if (!dnsResolvedKeys || dnsResolvedKeys.has(key)) {
          await releaseDnsResolvedAt(matchingSubnet.id, entry.ipAddress);
          phase5Stats.writesDnsRelease++;
        }
        let newRes;
        let createdAfterRetry = false;
        try {
          newRes = await prisma.reservation.create({ data: createData });
          phase5Stats.writesReservationCreate++;
        } catch (err: any) {
          // `fireDnsResolvedReconcile` (Prisma extension hook in src/db.ts) is
          // fire-and-forget on every asset write that touches ipAddress /
          // status / hostname / dnsName / macAddress. A queued reconcile from
          // Phase 3/4 or a parallel monitor pass can land between the
          // releaseDnsResolvedAt call above and this create, inserting a
          // dns_resolved row at (subnetId, ip, "active") that then collides
          // with our create on the @@unique([subnetId, ipAddress, status])
          // index. P2002 with a dns_resolved row on the colliding side →
          // release it again and retry once. Any other sourceType is a
          // genuine collision (concurrent integration writing to overlapping
          // subnets, manual reservation typed during sync, etc.) — log and
          // skip rather than thrashing.
          if (err?.code !== "P2002") throw err;
          const colliding = await prisma.reservation.findFirst({
            where: { subnetId: matchingSubnet.id, ipAddress: entry.ipAddress, status: "active" },
            select: { id: true, sourceType: true },
          });
          if (colliding?.sourceType !== "dns_resolved") {
            syncLog("error", `Failed to create DHCP ${isDhcpReservation ? "reservation" : "lease"} for ${entry.ipAddress}: collided with active ${colliding?.sourceType ?? "(missing)"} reservation`);
            phase5Stats.skippedCollision++;
            continue;
          }
          // Hard-delete the colliding dns_resolved row rather than flipping
          // to status="released" — the (sub, ip, "released") slot may
          // already be occupied by an older released dns_resolved row, and
          // the @@unique([subnetId, ipAddress, status]) constraint would
          // block the transition. dns_resolved is a system fallback with no
          // audit value, so the delete is the simpler + always-correct
          // semantic.
          await prisma.reservation.delete({ where: { id: colliding.id } });
          phase5Stats.writesReservationDelete++;
          newRes = await prisma.reservation.create({ data: createData });
          phase5Stats.writesReservationCreate++;
          createdAfterRetry = true;
        }
        if (createdAfterRetry) {
          phase5Stats.pathNewCreateAfterRetry++;
        } else {
          phase5Stats.pathNewCreate++;
        }
        activeResMap.set(key, newRes); // Track for MAC cross-update phase
        if (isDhcpReservation) {
          dhcpReservations.push(`${entry.ipAddress} (${entry.hostname || entry.macAddress})`);
        } else {
          dhcpLeases.push(`${entry.ipAddress} (${entry.hostname || entry.macAddress})`);
        }
      } catch (err: any) {
        phase5Stats.pathNewCreateFailed++;
        syncLog("error", `Failed to create DHCP ${isDhcpReservation ? "reservation" : "lease"} for ${entry.ipAddress}: ${err.message || "Unknown error"}`);
      }
    }
  }

  // Flush the deferred dhcp_reservation staleness bumps as one updateMany.
  // Every row in dhcpFlipBumpOnlyIds gets the same data shape, so this is
  // exactly the shape updateMany was designed for. One statement regardless
  // of row count — the dominant per-cycle write savings on big FortiGates.
  if (dhcpMixedUpdates.size > 0) {
    const flush = [...dhcpMixedUpdates];
    const results = await mapSettledWithConcurrency(flush, 25, ([id, data]) =>
      prisma.reservation.update({ where: { id }, data }),
    );
    phase5Stats.writesReservationUpdate += flush.length;
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        syncLog("error", `Failed to update DHCP reservation ${flush[i]![0]}: ${(r.reason as Error)?.message || "Unknown error"}`);
      }
    });
  }

  if (dhcpFlipBumpOnlyIds.length > 0) {
    const bumpAt = new Date();
    await prisma.reservation.updateMany({
      where: { id: { in: dhcpFlipBumpOnlyIds } },
      data: {
        lastSeenLeased: bumpAt,
        staleNotifiedAt: null,
        staleSnoozedUntil: null,
      },
    });
    phase5Stats.writesReservationUpdateMany++;
  }

  // Phase 5 summary — one info Event per per-FortiGate sync so operators can
  // characterize the actual per-cycle DB write distribution from the Events
  // page. The path-* counters sum to entriesTotal; the writes-* counters are
  // the actual prisma.reservation/conflict statements issued (NOT rows —
  // updateMany counts as one regardless of rows touched, which is the
  // connection-pressure number).
  if (phase5Stats.entriesTotal > 0) {
    const totalWrites =
      phase5Stats.writesReservationUpdate +
      phase5Stats.writesReservationUpdateMany +
      phase5Stats.writesReservationCreate +
      phase5Stats.writesReservationDelete +
      phase5Stats.writesConflictUpdateMany +
      phase5Stats.writesDnsRelease +
      phase5Stats.writesUpsertConflict;
    syncLog(
      "info",
      `Phase 5 DHCP entry processing: ${phase5Stats.entriesTotal} entries, ${totalWrites} DB writes ` +
      `(updates=${phase5Stats.writesReservationUpdate}, updateMany=${phase5Stats.writesReservationUpdateMany} covering ${dhcpFlipBumpOnlyIds.length} rows, ` +
      `creates=${phase5Stats.writesReservationCreate}, deletes=${phase5Stats.writesReservationDelete}, ` +
      `conflictUpdates=${phase5Stats.writesConflictUpdateMany}, dnsReleases=${phase5Stats.writesDnsRelease}, ` +
      `upsertConflicts=${phase5Stats.writesUpsertConflict}); ` +
      `paths: noChange=${phase5Stats.pathExistingDhcpNoChange}, ` +
      `dhcpFlipMixed=${phase5Stats.pathExistingDhcpFlipMixed}, dhcpFlipBumpOnly=${phase5Stats.pathExistingDhcpFlipBumpOnly}, ` +
      `polarisEcho=${phase5Stats.pathExistingManualPolarisEcho}, manualConflict=${phase5Stats.pathExistingManualConflictOnly}, ` +
      `vipSucc=${phase5Stats.pathExistingVipSuccession}, vipMacFill=${phase5Stats.pathExistingVipMacFill}, ` +
      `pendingAdopt=${phase5Stats.pathExistingPendingAdopt}, pendingCollide=${phase5Stats.pathExistingPendingCollide}, ` +
      `infraBinding=${phase5Stats.pathExistingInfraBindingChange}, infraNoChange=${phase5Stats.pathExistingInfraNoChange}, ` +
      `observedSuperseded=${phase5Stats.pathExistingObservedSuperseded}, ` +
      `newCreate=${phase5Stats.pathNewCreate}, newCreateRetry=${phase5Stats.pathNewCreateAfterRetry}, ` +
      `newCreateFail=${phase5Stats.pathNewCreateFailed}, skipNoIp=${phase5Stats.skippedNoIp}, ` +
      `skipNoSubnet=${phase5Stats.skippedNoSubnet}, skipCollision=${phase5Stats.skippedCollision})`,
    );
  }
}
