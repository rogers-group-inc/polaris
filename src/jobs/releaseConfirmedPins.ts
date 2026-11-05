/**
 * src/jobs/releaseConfirmedPins.ts
 *
 * Business rule 103(a): a primary-address pin is released once the network
 * backs the pinned address on its own — its discovery confidence score (no
 * operator weight, no polling) reaches the warn line and beats every other
 * address the asset has. The decision is utils/addressConfidence.ts →
 * pinReleaseVerdict; the write and the Event are
 * services/primaryAddressService.ts → releaseConfirmedPins.
 *
 * Why a sweep and not a discovery hook: the evidence comes from several
 * integrations (FortiGate address rows, DHCP reservations, vCenter, Arc, a
 * Generic API feed), each on its own schedule, so no single sync is the moment
 * it changes. Pinned assets are few — an operator pins one at a time — so the
 * pass is one read plus a batched score per 200 of them, and a fleet with no
 * pins issues one cheap query.
 *
 * Cadence: 15 minutes. Releasing a pin is never urgent: the asset is already
 * on the address the evidence now backs.
 */

import { logger } from "../utils/logger.js";
import { defineJob } from "./_defineJob.js";
import { releaseConfirmedPins } from "../services/primaryAddressService.js";

const INTERVAL_MS = 15 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 90_000;

// Delayed first run: let discovery and the monitor loops settle first, so a
// half-populated fleet's thin evidence isn't what gets compared.
defineJob({
  name: "releaseConfirmedPins",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: FIRST_RUN_DELAY_MS,
  run: async () => {
    const result = await releaseConfirmedPins();
    if (result.released) logger.info(result, "released primary-address pins the network now backs");
  },
});
