/**
 * src/services/discovery/dhcp/changeEvents.ts — syncDhcpSubnets Phase 11.5
 * (CQ-B060; the body moved verbatim, its free variables made parameters).
 *
 * Flush per-asset change events. One batch per run, diffing each tracked
 * field's first-touch baseline against its final in-memory value. Runs AFTER
 * Phase 11 so the intra-run ping-pongs described at the changeBaseline
 * declaration have settled — a steady fleet produces an empty array and
 * writes nothing.
 *
 * Events are optimistic with respect to Phase 7.5's batchSettled flush (a
 * write that failed there still reports here) — the same accepted caveat the
 * Arc path carries.
 */

import type { AssetIndex } from "../discoveryEngine.js";
import {
  buildConnectionChangedEvent,
  buildFirmwareChangedEvent,
  logEventsBatch,
  type LogEventInput,
} from "../../eventLogService.js";
import { wirelessRoamEventsWanted } from "../../notificationChangeEvents.js";
import { logger } from "../../../utils/logger.js";

/** The fields syncDhcpSubnets records a first-touch baseline for. */
export type ChangeBaselineFields = "os" | "osVersion" | "lastSeenSwitch" | "lastSeenAp";
export type ChangeBaseline = Map<string, { name: string | null } & Partial<Record<ChangeBaselineFields, unknown>>>;

export async function flushChangeEvents(input: {
  changeBaseline: ChangeBaseline;
  assetIdx: AssetIndex;
  actor: string | undefined;
  integrationId: string;
  integrationName: string;
}): Promise<void> {
  const { changeBaseline, assetIdx, actor, integrationId, integrationName } = input;
  if (changeBaseline.size > 0) {
    try {
      const changeEvents: LogEventInput[] = [];
      const roamsWanted = await wirelessRoamEventsWanted();
      for (const [assetId, baseline] of changeBaseline) {
        const asset = assetIdx.findById(assetId);
        if (!asset) continue;
        const ctx = {
          assetId,
          assetName: baseline.name,
          actor: actor || "system:discovery",
          source: "fortigate-endpoint",
          integrationId,
          integrationName,
        };
        if ("os" in baseline || "osVersion" in baseline) {
          const before: Record<string, unknown> = {};
          const after: Record<string, unknown> = {};
          if ("os" in baseline) { before.os = baseline.os; after.os = asset.os ?? null; }
          if ("osVersion" in baseline) { before.osVersion = baseline.osVersion; after.osVersion = asset.osVersion ?? null; }
          const ev = buildFirmwareChangedEvent(ctx, before, after);
          if (ev) changeEvents.push(ev);
        }
        if ("lastSeenSwitch" in baseline) {
          const ev = buildConnectionChangedEvent("switch", ctx, baseline.lastSeenSwitch as string | null, asset.lastSeenSwitch ?? null);
          if (ev) changeEvents.push(ev);
        }
        // A roam Event only while an automation uses the roam trigger
        // (wirelessRoamEventsWanted, asked once before this loop).
        if ("lastSeenAp" in baseline && roamsWanted) {
          const ev = buildConnectionChangedEvent("ap", ctx, baseline.lastSeenAp as string | null, asset.lastSeenAp ?? null);
          if (ev) changeEvents.push(ev);
        }
      }
      if (changeEvents.length > 0) await logEventsBatch(changeEvents);
    } catch (err: any) {
      // Audit rows must never fail the sync.
      logger.warn({ integrationId, err: err?.message }, "discovery.change_events.flush_failed");
    }
  }
}
