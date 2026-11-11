/**
 * src/api/routes/assets/system.ts — The asset slide-over's System tab: maintenance windows and info, contacts,
 * telemetry and memory forecast, system info, processes, MAC / ARP tables, child
 * counts, services, software, inventory presence, process connections. Split out of
 * routes/assets.ts (CQ-B062) and mounted there in order.
 */

import { Router } from "express";
import { z } from "zod";
import { AppError } from "../../../utils/errors.js";
import { requirePermission } from "../../middleware/permissions.js";
import { resolveWriteScope, inWriteScope, scheduleCanEditByIds } from "../../../services/writeScopeService.js";
import { getAssetSoftware } from "../../../services/softwareInventoryService.js";
import { getInventoryPresence } from "../../../services/serviceInventoryService.js";
import { getFibreChannelForAsset } from "../../../services/fibreChannelService.js";
import { countControllerChildren, getControllerMacTable, getControllerWireless } from "../../../services/controllerChildrenService.js";
import { pickSampleTierForAsset } from "../../../services/sampleQueryRouter.js";
import { resolveRange, extendSinceForLookback } from "../../../utils/chartRange.js";
import { readTelemetryHistory } from "../../../services/sampleHistoryService.js";
import { listAssetWindows, getAssetMaintenanceInfo } from "../../../services/maintenanceScheduleService.js";
import { resolveContactsForAsset } from "../../../services/contactService.js";
import { getAssetProcessConnections } from "../../../services/applicationMapService.js";
import { readProbeOutages, serializeOutages } from "../../../services/probeOutageService.js";
import { loadMemoryForecastSeries } from "../../../services/memoryForecastService.js";
import { assertAssetExists, findAssetScopeRecord } from "../../../services/assetDetailReadService.js";

import { getAssetSystemInfo, getAssetProcesses, getAssetMacTable, getAssetArpTable, getAssetServices } from "../../../services/assetSystemTabService.js";


const router = Router();

// GET /assets/:id/maintenance-windows?range=...|from=...&to=... — maintenance
// window rows overlapping the chart range. Fetched in parallel with the
// sample histories (same pattern as the polling-transition Event fetch) and
// rendered as labeled shaded bands on every asset-details chart.
router.get("/:id/maintenance-windows", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { since, until, rangeLabel } = resolveRange(req);
    const windows = await listAssetWindows(id, since, until);
    res.json({ range: rangeLabel, since, until, windows });
  } catch (err) { next(err); }
});

// GET /assets/:id/maintenance-info — current windows + covering schedules for
// the edit-modal Maintenance tab / slide-over / phone sheet. Rule 141 (e):
// `canMaintain` says whether the caller may put THIS asset into maintenance or
// take it off a window's device list; each schedule's `canEdit` whether they
// may delete it (its creator, or every explicit device in scope). Both screens
// grey those verbs from these, never from the role alone.
router.get("/:id/maintenance-info", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const info = await getAssetMaintenanceInfo(id);
    const scope = await resolveWriteScope(req, "maintenanceManagement");
    const [asset, canEdit] = await Promise.all([
      scope.kind === "scoped"
        ? findAssetScopeRecord(id)
        : Promise.resolve(null),
      scheduleCanEditByIds(scope, info.schedules.map((s) => s.id)),
    ]);
    const canMaintain = scope.kind === "all" || (scope.kind === "scoped" && !!asset && inWriteScope(scope, asset));
    res.json({
      ...info,
      canMaintain,
      schedules: info.schedules.map((s) => ({ ...s, canEdit: canEdit.get(s.id) === true })),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/contacts — the address-book entries RESPONSIBLE for this
// device (Contact.assetCondition ∪ Contact.assetIds), for the slide-over's
// Contacts row. Chained gate: reading it exposes address-book content, so the
// caller needs `contacts:read` on top of `assets:read`.
router.get(
  "/:id/contacts",
  requirePermission("assets", "read"),
  requirePermission("contacts", "read"),
  async (req, res, next) => {
    try {
      const contacts = await resolveContactsForAsset(req.params.id as string);
      res.json({
        contacts: contacts.map((c) => ({
          id: c.id,
          email: c.email,
          name: c.name,
          description: c.description,
          // Why this contact matched — a pin is an operator decision, a filter
          // match is a rule, and an operator chasing an unexpected recipient
          // needs to know which.
          via: c.assetIds.includes(req.params.id as string) ? "pinned" : "filter",
        })),
      });
    } catch (err) { next(err); }
  },
);

// GET /assets/:id/telemetry-history?range=...|from=...&to=... — CPU+memory time series
router.get("/:id/telemetry-history", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const { since, until, rangeLabel } = resolveRange(req);
    const pick = await pickSampleTierForAsset(id, "cpuMem", since);
    const fetchSince = extendSinceForLookback(since, pick.bucketSeconds);
    // The telemetry cadence does not run while an asset is down, so a missed
    // poll leaves no row to mark. `outages` carries the response-time probe's
    // own failure record for the same window — the chart dives its line to the
    // baseline across each one instead of guessing at the outage from the size
    // of the hole. See services/probeOutageService.ts.
    const [result, outages] = await Promise.all([
      readTelemetryHistory(id, since, until, pick.tier, fetchSince),
      readProbeOutages(id, since, until),
    ]);
    res.json({
      range: rangeLabel,
      since,
      until,
      tier: pick.tier,
      bucketSeconds: pick.bucketSeconds,
      samples: result.samples,
      stats: result.stats,
      outages: serializeOutages(outages),
    });
  } catch (err) { next(err); }
});

// GET /assets/:id/memory-forecast — the 30-day memory trend behind the Memory
// chart's forecast overlay. The same daily points and fit as the
// memDaysUntilFull automation metric (memoryForecastService), so the overlay
// quotes the number an automation would compare. Independent of the chart's
// selected range: a forecast is always fitted on the full lookback.
router.get("/:id/memory-forecast", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await loadMemoryForecastSeries(req.params.id as string));
  } catch (err) { next(err); }
});

// GET /assets/:id/system-info — latest interface + storage snapshot. Returns
// every interface row tied to the most-recent system-info scrape timestamp,
// plus the most-recent telemetry row. Used to populate the System tab grid
// without requiring the client to make three separate calls.
router.get("/:id/system-info", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    res.json(await getAssetSystemInfo(id));
  } catch (err) { next(err); }
});

// GET /assets/:id/processes — Processes tab: current-state process inventory
// (one row per program, aggregated by name) plus the operator's pin sets so the
// table can render the Monitor / Alert checkbox state without a second call.
// Ordered by summed CPU desc then name so the busiest programs surface first.
router.get("/:id/processes", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    res.json(await getAssetProcesses(id));
  } catch (err) { next(err); }
});

// GET /assets/:id/services — current-state systemd unit / Windows service
// inventory for the Services tab. Mirrors /:id/processes: the current AssetService
// rows plus the two pin arrays (monitoredServices = journalctl tailing,
// mappedServices = Application Map connection attribution).
/**
 * GET /assets/:id/fibre-channel — the Fibre Channel tab (business rule 159):
 * `switch` = this asset's FC ports and the devices logged into them;
 * `host` = this asset's HBA ports as the switches it is matched on see them,
 * one entry per switch. Either is null when it has nothing; both null means
 * the tab is not drawn.
 */
router.get("/:id/fibre-channel", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await getFibreChannelForAsset(req.params.id as string));
  } catch (err) { next(err); }
});

/**
 * GET /assets/:id/mac-table — the switch's layer-2 forwarding database.
 *
 * Current-state (delete-replaced per scrape), so there is no time window to
 * select. Returns the entries plus per-port MAC counts, which is the number
 * that separates an access port from an uplink and is far cheaper to compute
 * here than in the browser over a few thousand rows.
 *
 * Also returns the freshness pair every current-state tab states — when the
 * table was last written (`collectedAt`, the newest lastSeen, since the whole
 * table is replaced in one scrape) and how often it is refreshed
 * (`pollIntervalSec`). Without both, an empty forwarding database reads as "no
 * devices on this switch" when it can equally mean "not scraped since
 * yesterday". Unlike ARP there is no discovery fallback: only the system-info
 * pass writes the FDB, so an unmonitored switch gets null.
 */
router.get("/:id/mac-table", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    res.json(await getAssetMacTable(id));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /assets/:id/child-counts — how many FortiAPs / FortiSwitches a
 * FortiGate controls; decides whether its Wireless / MAC Table tabs show.
 */
router.get("/:id/child-counts", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await countControllerChildren(req.params.id as string));
  } catch (err) { next(err); }
});

/**
 * GET /assets/:id/child-wireless — a FortiGate's Wireless tab: the wireless
 * clients of every FortiAP it controls, plus the AP list itself.
 */
router.get("/:id/child-wireless", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await getControllerWireless(req.params.id as string));
  } catch (err) { next(err); }
});

/**
 * GET /assets/:id/child-mac-table — a FortiGate's MAC Table tab: the
 * forwarding database of every FortiSwitch it controls, plus the switch list.
 */
router.get("/:id/child-mac-table", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await getControllerMacTable(req.params.id as string));
  } catch (err) { next(err); }
});

const ArpTableQuerySchema = z.object({
  range: z.enum(["current", "1h", "12h", "24h", "7d", "30d"]).optional().default("current"),
});

router.get("/:id/arp-table", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    const parsed = ArpTableQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(400, "Invalid range");
    const { range } = parsed.data;
    res.json(await getAssetArpTable(id, range));
  } catch (err) {
    next(err);
  }
});

router.get("/:id/services", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    res.json(await getAssetServices(id));
  } catch (err) { next(err); }
});

// GET /assets/:id/software — installed software, every source's list (agent /
// intune / arc) with each source's last-read time. The Software tab shows one
// source at a time; the service decides nothing about which.
router.get("/:id/software", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await getAssetSoftware(req.params.id as string));
  } catch (err) { next(err); }
});

// GET /assets/:id/inventory-presence — { services, software }: whether the
// Services / Software tabs have anything to show. The slide-over prefetches it
// so each tab is present on first paint or absent, never an empty shell.
router.get("/:id/inventory-presence", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    res.json(await getInventoryPresence(req.params.id as string));
  } catch (err) { next(err); }
});

// GET /assets/:id/process-connections?name=&unit= — Ports & Connections for the
// process detail slide-in AND the Services detail panel (Application Map data,
// per-asset view). Optional `name` filters to one process; optional `unit`
// (Phase 3) filters to one systemd unit / Windows service. Remote IPs are
// hydrated with the matched asset id + hostname via the bulk resolver.
router.get("/:id/process-connections", requirePermission("assets", "read"), async (req, res, next) => {
  try {
    const id = req.params.id as string;
    await assertAssetExists(id);
    const name = typeof req.query.name === "string" && req.query.name ? req.query.name : undefined;
    const unit = typeof req.query.unit === "string" && req.query.unit ? req.query.unit : undefined;
    res.json(await getAssetProcessConnections(id, name, unit));
  } catch (err) { next(err); }
});

export default router;
