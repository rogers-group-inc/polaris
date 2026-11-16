/**
 * src/jobs/sweepFortinetLinkState.ts
 *
 * Periodic controller-link sweep for FortiGate-managed FortiSwitches and
 * FortiAPs (business rule 59): asks each controller FortiGate whether it still
 * has a FortiLink session / CAPWAP tunnel to each device it manages, and
 * projects the answer onto `Asset.fortilinkStatus`. The whole decision set —
 * which devices are due, which are off, the three refusals, the normalization,
 * the batched writes — lives in services/fortinetLinkStateService.ts.
 *
 * Why a job and not part of the monitor loop: the monitor loop asks the
 * DEVICE, on the transport the operator chose. That is structurally unable to
 * see this fault, because a switch with a dead FortiLink session answers ICMP
 * and SNMP perfectly well. Only the controller knows, and the controller is a
 * different target with a different failure mode — so it gets its own tick
 * rather than a cadence inside `monitorAssets`.
 *
 * Cadence (rule 59(a), operator decision 2026-11-16): the FortiLink session is
 * a virtual interface to the device, so each device is read on its own
 * INTERFACE (system-info) interval — default 10 min — and only while its
 * interface polling is on. This job's 60 s tick is only the scheduler's
 * granularity: each tick the service picks the devices that are due and asks
 * only the controllers that manage at least one of them. Until 2026-11-16 every
 * device was read every 60 s (`POLARIS_FORTILINK_SWEEP_SEC`, now ignored);
 * detection latency moved from ~1 min to up to one interface interval, and
 * controller load dropped ~10x at the defaults.
 *
 * Cost is bounded by CONTROLLER count, not fleet size — at most two calls per
 * controller (switches + APs) per interface interval, whether it manages 3
 * devices or 300. That matters most on FMG PROXY mode, which serializes at
 * concurrency 1; direct mode and standalone FortiGate integrations talk to each
 * gate independently. A controller that cannot be read writes nothing, so its
 * devices stay due and it is retried each tick until it answers.
 *
 * Scheduler role only — one sweep for the fleet, not one per monitor replica.
 * A second replica sweeping would double the upstream rate against exactly the
 * controllers this is designed not to overrun.
 */

import { defineJob } from "./_defineJob.js";
import { sweepFortinetLinkState } from "../services/fortinetLinkStateService.js";

/** Scheduler granularity, not the read cadence — see the header. */
const TICK_MS = 60_000;

// Delayed first run: discovery stamps `fortinetTopology.controllerFortigate`,
// which is how the sweep learns which controller to ask, and at boot a fresh
// install has not run discovery yet. A pass before then simply finds no groups
// and does nothing — the delay just keeps the startup log quiet.
const FIRST_RUN_DELAY_MS = 45_000;

defineJob({
  name: "sweepFortinetLinkState",
  intervalMs: TICK_MS,
  firstRunDelayMs: FIRST_RUN_DELAY_MS,
  run: async () => {
    await sweepFortinetLinkState();
  },
});
