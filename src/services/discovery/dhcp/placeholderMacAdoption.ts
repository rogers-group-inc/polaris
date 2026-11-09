/**
 * src/services/discovery/dhcp/placeholderMacAdoption.ts — syncDhcpSubnets
 * Phase 7.7 (CQ-B060; the body moved verbatim, its free variables made
 * parameters).
 *
 * Adopt the real MAC onto placeholder-MAC reservations. A reservation created
 * for a not-yet-racked device carries a SYNTHETIC MAC (see utils/mac.ts) so it
 * could be written to the gate at all. That entry matches nothing: when the
 * device finally arrives it DHCPs with its real MAC, misses the reservation
 * and takes a pool address instead. Phase 7.6 has the correcting evidence in
 * hand — it drops a MAC mismatch on the floor, because for PRESENCE a
 * different MAC genuinely isn't proof the reserved device is alive. Here that
 * same mismatch is the signal: if the stored MAC is a placeholder, whatever is
 * actually answering at that IP is the device the reservation was always
 * meant for.
 *
 * Double opt-in (pushReservations + adoptDiscoveredMac), placeholder-only
 * overwrite, device-write-then-Polaris ordering and the per-RUN budget all
 * live in placeholderMacAdoptionService — see its header. Never throws: an
 * adoption failure must not poison the run's accounting, matching the other
 * device-writing passes.
 */

import type { DiscoveryResult } from "../../fortimanagerService.js";
import type { SyncLog } from "../syncLog.js";
import {
  buildMacEvidenceIndex,
  runPlaceholderMacAdoption,
  type AdoptionBudget,
} from "../../placeholderMacAdoptionService.js";
import { inventorySightingIsLocal } from "../../../utils/inventoryLocality.js";

export async function adoptPlaceholderMacs(input: {
  result: DiscoveryResult;
  /** The run's per-RUN budget; absent on paths that never adopt. */
  adoptionBudget: AdoptionBudget | undefined;
  /** utils/inventoryLocality.buildArpMacDeviceIndex over this run's ARP rows. */
  arpMacDeviceIndex: Set<string>;
  integrationId: string;
  integrationName: string;
  actor: string | undefined;
  signal: AbortSignal | undefined;
  syncLog: SyncLog;
}): Promise<void> {
  const { result, adoptionBudget, arpMacDeviceIndex, integrationId, integrationName, actor, signal, syncLog } = input;
  if (adoptionBudget && adoptionBudget.remaining > 0 && !signal?.aborted) {
    // Inventory evidence is locality-filtered: with overlapping RFC1918
    // subnets, a ZTNA-relayed row can claim (this gate, <client's home IP>)
    // for an address this gate ALSO serves — exactly the key a placeholder
    // reservation here would adopt the wrong MAC from. ARP rows are local by
    // construction and pass through unfiltered.
    const evidence = buildMacEvidenceIndex(
      result.arpTable || [],
      (result.deviceInventory || []).filter((d) => inventorySightingIsLocal(d, arpMacDeviceIndex)),
    );
    if (evidence.size > 0) {
      await runPlaceholderMacAdoption({
        integrationId,
        integrationName,
        evidence,
        budget: adoptionBudget,
        actor,
        signal,
      })
        .then((r) => {
          if (r.attempted > 0) {
            syncLog(
              "info",
              `Placeholder MAC adoption: ${r.adopted} reservation(s) updated to the discovered device's MAC`
                + (r.failed > 0 ? `, ${r.failed} failed` : "")
                + (r.deferred > 0 ? `, ${r.deferred} deferred to the next cycle` : ""),
            );
          }
        })
        .catch((err: any) => {
          syncLog("error", `Placeholder MAC adoption failed: ${err?.message || "Unknown error"}`);
        });
    }
  }
}
