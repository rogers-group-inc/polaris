/**
 * src/jobs/maintenanceScheduler.ts
 *
 * 30-second reconciler — source of truth for maintenance-window state.
 *
 * Evaluates every MaintenanceSchedule's recurrence against the wall clock,
 * diffs desired (asset, schedule) pairs against the open
 * AssetMaintenanceWindow rows, and enters/exits assets (status flip to/from
 * "maintenance" with `maintenanceReturnStatus` parking, window-row
 * open/close, maintenance.entered / maintenance.exited Events). Schedule
 * CRUD also calls reconcileMaintenance() inline so ad-hoc "enter maintenance
 * now" schedules take effect immediately — this tick is the safety net that
 * catches window boundaries, server restarts, and clobbered statuses
 * (self-heal).
 *
 * Serialization lives inside reconcileMaintenance() (in-flight runs coalesce
 * queued callers); defineJob's overlap skip sits on top of that.
 *
 * Import this module from src/app.ts to activate it.
 */

import { reconcileMaintenance } from "../services/maintenanceScheduleService.js";
import { defineJob } from "./_defineJob.js";

const INTERVAL_MS = 30 * 1000;

// Short boot delay so Prisma is connected and one-shot startup migrations
// have settled before the first fleet-wide pass.
defineJob({
  name: "maintenanceScheduler",
  intervalMs: INTERVAL_MS,
  firstRunDelayMs: 15_000,
  run: async () => {
    await reconcileMaintenance();
  },
});
