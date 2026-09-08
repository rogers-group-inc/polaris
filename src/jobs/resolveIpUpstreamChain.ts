/**
 * src/jobs/resolveIpUpstreamChain.ts
 *
 * Periodic IP-keyed upstream sweep (also runs shortly after boot): for every
 * network-present asset that has an address but NO MAC, walks IP → owning
 * FortiGate → its ARP cache → MAC → switch forwarding table / AP station table
 * and stamps `lastSeenSwitch` / `lastSeenAp`. The whole decision set (gate
 * scoping, the two freshness gates, the duplicate-MAC refusal, the port rank)
 * lives in src/services/ipUpstreamChainService.ts.
 *
 * Why a sweep: the evidence arrives from three different writers on three
 * different cadences (FMG/FortiGate discovery for ARP, the SNMP system-info
 * pass for the FDB, the FortiAP station scrape), and a MAC-less asset is
 * reached by none of them. Reading the tables they leave behind, on a cadence
 * of its own, is the only place the chain can be joined without hooking every
 * one of those write sites.
 *
 * Cadence: 10 minutes — the same order as the evidence tables' own refresh.
 * A pass with nothing to learn issues zero writes.
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { resolveIpUpstreamForMaclessAssets } from "../services/ipUpstreamChainService.js";

const INTERVAL_MS = 10 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90_000;

async function resolveIpUpstreamChain(): Promise<void> {
  try {
    await runInstrumentedJob("resolveIpUpstreamChain", async () => {
      const result = await resolveIpUpstreamForMaclessAssets();
      if (result.switchStamps || result.apStamps || result.ambiguous) {
        logger.info(result, "ip upstream chain pass complete");
      }
    });
  } catch (err) {
    logger.error({ err }, "ip upstream chain pass failed");
  }
}

// Delayed first run: the evidence tables are refreshed by discovery and the
// monitor loops, which are still settling at boot.
setTimeout(resolveIpUpstreamChain, FIRST_RUN_DELAY_MS);
setInterval(resolveIpUpstreamChain, INTERVAL_MS);
