/**
 * src/jobs/initIpv6Setting.ts
 *
 * One-shot startup job (business rule 127): the install-time IPv6 decision.
 * If nobody has decided whether IPv6 is on yet, switch it on when this host
 * holds a routable IPv6 address and off otherwise, and record the decision as
 * an Event. A decision already made — by an earlier boot or an operator in
 * Server Settings — is never overwritten, so this is a no-op on every boot
 * after the first. Runs on the migrations role (web / all) only.
 *
 * Not marker-guarded: the Setting row itself is the marker.
 *
 * Import this module from src/app.ts to activate it:
 *   import "./jobs/initIpv6Setting.js";
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { initializeIpv6Setting } from "../services/ipv6GateService.js";

async function initIpv6Setting(): Promise<void> {
  try {
    await runInstrumentedJob("initIpv6Setting", async () => {
      const result = await initializeIpv6Setting();
      if (result.initialized) logger.info(result, "IPv6 switched at install from host detection");
    });
  } catch (err) {
    logger.error(err, "Failed to make the install-time IPv6 decision");
  }
}

initIpv6Setting();
