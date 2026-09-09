/**
 * src/jobs/seedBaselineAutomations.ts
 *
 * One-shot startup that seeds a set of BASELINE automations (NotificationRule
 * rows) mirroring the alertable dashboard widgets — down assets, high
 * CPU/memory/temperature/disk, slow response, packet loss, storage-fills-soon,
 * down interfaces / IPsec tunnels, and recent reboots. They exist so a fresh
 * install has sensible monitoring out of the box AND so operators have worked
 * examples of every trigger/reset shape to copy from.
 *
 * SEED-ONCE, NOT self-heal: each seed SET is guarded by its own marker key in
 * Setting (`seedBaselineAutomationsSeededAt` for the original widget-mirror
 * set; `seedBaselineAutomationsV2SeededAt` for the event-based set). Once a
 * marker is stamped, that set is never touched again — so a rule the operator
 * edits or DELETES stays edited/deleted. Later sets ship behind NEW marker
 * keys (per the _runOnce contract: a shipped marker key never changes), which
 * is how existing installs pick up new baseline rules without duplicating the
 * ones they already have. (Contrast seedAssetTypes, which re-heals protected
 * built-ins every boot.) Every rule is fully editable + deletable; none are
 * protected.
 *
 * Rules are built as raw input bodies and run through `ruleInputSchema` +
 * `createRule` — the exact path the Automations API uses — so they carry the
 * canonical v2 shape (reset + actions + legacy mirror) and can never drift from
 * what the validator accepts. In-app delivery only (no NotificationChannel
 * required); numeric rules auto-clear with hysteresis at the widget's WARNING
 * level (e.g. CPU fires >90%, clears <75%).
 *
 * Thresholds are the values the dashboard widgets use for their red/yellow
 * coloring (public/js/widgets/*.js). They live only in the frontend today, so
 * these are a deliberate server-side baseline — operators are expected to tune
 * them per environment.
 *
 * The V2 EVENT SET gives operators an automation per notable system-generated
 * event family (discovery failures, push failures, agent drop-offs, capacity
 * escalations, conflicts, lockouts…) so the alert text, delivery, and
 * escalation for those events are operator-controllable from the Automations
 * page. All are event triggers with timed reset + a cooldown — the engine's
 * event-tail cooldown + timed-clear passes keep them storm-proof.
 *
 * The V3 DOWN-DETECTION SET is different in kind from the first two: it is
 * COMPUTED from live data rather than a static array. Down stopped being a
 * monitor-settings value (business rule 36) and became the covering
 * automation's missed-poll count, so V3 reads each install's effective
 * pre-cutover thresholds and mirrors them into automations — one all-assets
 * rule at the dominant value, plus a narrower rule per asset class that
 * differed — then retires the pre-cutover "Asset down" row IF the operator
 * never touched it. An edited row is kept and flagged instead, because it
 * still governs its devices (at the default count) and the operator needs to
 * be told that number is now theirs to set.
 *
 * To force a re-seed of a set (e.g. to restore a deleted baseline rule), run:
 *   DELETE FROM "settings" WHERE key = 'seedBaselineAutomationsSeededAt';   -- widget set
 *   DELETE FROM "settings" WHERE key = 'seedBaselineAutomationsV2SeededAt'; -- event set
 *   DELETE FROM "settings" WHERE key = 'seedBaselineAutomationsV3SeededAt'; -- down detection
 *   DELETE FROM "settings" WHERE key = 'seedBaselineAutomationsV4ResetEventSeededAt'; -- counterpart resets
 *   DELETE FROM "settings" WHERE key = 'seedBaselineAutomationsV5LossCeilingSeededAt'; -- loss ceiling
 * then restart. (This resurrects that ENTIRE set, including rules you deleted.
 * For V3 that means re-deriving the thresholds from the settings tiers, which
 * are dormant but still stored — and it will NOT re-retire an Asset down rule
 * it already removed.)
 */

import { logger } from "../utils/logger.js";
import { runInstrumentedJob } from "./_metrics.js";
import { hasRunMarker, stampRunMarker } from "./_runOnce.js";
import { RESET_EVENT_SUGGESTIONS, ruleInputSchema } from "../services/notificationTypes.js";
import { createRule, deleteRule } from "../services/notificationRuleService.js";
import { prisma } from "../db.js";
import { logEvent } from "../services/eventLogService.js";
import { resolveMonitorSettings } from "../services/monitoringService.js";
import { DEFAULT_MISSED_POLLS } from "../services/notificationTypes.js";
import { invalidateDownDetectionCache } from "../services/downDetectionService.js";

const MARKER_KEY = "seedBaselineAutomationsSeededAt";
const MARKER_KEY_V2 = "seedBaselineAutomationsV2SeededAt";
const MARKER_KEY_V3 = "seedBaselineAutomationsV3SeededAt";
const MARKER_KEY_V4 = "seedBaselineAutomationsV4ResetEventSeededAt";
const MARKER_KEY_V5 = "seedBaselineAutomationsV5LossCeilingSeededAt";
const MARKER_KEY_V6 = "seedBaselineAutomationsV6PlatformLifecycleSeededAt";

/**
 * Platform end-of-life. Its own marker and its own set rather than an entry
 * appended to EVENT_BASELINE_RULES: the marker contract is that a shipped set
 * never changes, so an append would mean no existing install ever receives this
 * rule — only brand-new ones would.
 *
 * Two things here are deliberate and easy to "simplify" wrongly:
 *
 * The reset is event-mode on a DISTINCT recovery action. `resetEventSchema`
 * accepts only actionPattern and resourceType — no detailsMatch — so a
 * single-action design would have this rule's reset match its own escalation
 * and clear itself immediately. That is exactly why "Capacity severity
 * escalated" settled for a timed reset; the lifecycle service emits
 * platform.lifecycle_recovered so this one can genuinely self-clear when the
 * operator finishes the upgrade.
 *
 * The cooldown is a week. An end-of-life condition is continuously true for
 * months, so a short cooldown re-notifies on every daily tick that shifts the
 * fingerprint (a day-count crossing a threshold, a second component degrading).
 * Seven days puts "PostgreSQL is end-of-life" in the inbox roughly monthly —
 * often enough to survive a change of on-call, rarely enough to stay read.
 */
const PLATFORM_LIFECYCLE_RULES: Record<string, unknown>[] = [
  {
    name: "Platform end-of-life warning",
    description:
      "Fires when the platform lifecycle check worsens (platform.lifecycle_changed, direction=escalated) — a runtime, database or OS is past or approaching end of life, or below Polaris's minimum. Clears when the check recovers. See Server Settings → Maintenance → Platform Lifecycle. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: {
      type: "event",
      actionPattern: "platform.lifecycle_changed",
      detailsMatch: { direction: "escalated" },
    },
    reset: { mode: "event", resetEvent: { actionPattern: "platform.lifecycle_recovered" } },
    cooldownSec: 604800,
    messageTemplate: "{value}",
  },
];

/**
 * The saturation ceiling the baseline packet-loss automation ships with.
 *
 * 90 rather than the schema default of 100, and the difference is deliberate.
 * The loss ratio stopped trimming outages out of its own window (business rule
 * 29), so a device back from a 55-minute outage genuinely reads ~92% for the
 * rest of a 60-minute window. True, but it describes the outage Asset down has
 * already alerted on. At 100 this ALL-ASSETS baseline would trail a second
 * alert behind every outage on every device.
 *
 * The schema default stays 100 so a hand-written rule is never silently
 * narrowed; Polaris opts its OWN default rule out instead.
 */
const BASELINE_LOSS_CEILING_PCT = 90;
const SEED_ACTOR = "system:seed-baseline-automations";
/** The name the pre-cutover baseline row carries — the only fingerprint the
 *  V3 retire step has, alongside createdBy. */
const V1_ASSET_DOWN_NAME = "Asset down";

// Raw input bodies (what a POST to /automations looks like). ruleInputSchema
// fills every default (enabled, channels=["in_app"], aggregation, etc.) and
// normalizes reset/actions to the canonical v2 shape.
const BASELINE_RULES: Record<string, unknown>[] = [
  // ── State conditions (mirror the Down Assets / Down Interfaces widgets) ──
  {
    name: "Asset down",
    description:
      "Fires when a monitored asset stops responding. Mirrors the dashboard's Down Assets widget. Baseline example — edit or delete freely.",
    severity: "critical",
    // Explicit count so a fresh install has a working down-detection
    // automation even if the V3 pass below fails for any reason.
    trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", missedPolls: 3 },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    messageTemplate: "{asset} is down",
  },
  {
    name: "Monitored interface down",
    description:
      "Fires when a pinned interface is admin-up but operationally down. Mirrors the Down Interfaces widget. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_state", field: "ifOperStatus", operator: "==", value: "down" },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    messageTemplate: "{asset}: monitored interface {dimension} is down",
  },
  {
    name: "IPsec tunnel down",
    description:
      "Fires when a monitored IPsec tunnel drops. Mirrors the IPsec portion of the Down Interfaces widget. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_state", field: "ipsecStatus", operator: "==", value: "down" },
    scope: { allAssets: true },
    reset: { mode: "auto" },
    messageTemplate: "{asset}: IPsec tunnel {dimension} is down",
  },

  // ── Numeric thresholds (fire at CRITICAL, auto-clear at WARNING) ──
  {
    name: "High CPU utilization",
    description:
      "Fires when average CPU stays above 90% and clears below 75%. Mirrors the Highest Avg CPU widget. Baseline example — edit or delete freely.",
    severity: "critical",
    trigger: { type: "asset_metric", metric: "cpuPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 75 },
    messageTemplate: "{asset} CPU at {value}% (fires above {threshold}%)",
  },
  {
    name: "High memory utilization",
    description:
      "Fires when average memory stays above 90% and clears below 75%. Mirrors the Highest Avg Memory widget. Baseline example — edit or delete freely.",
    severity: "critical",
    trigger: { type: "asset_metric", metric: "memPct", aggregation: "avg", windowSec: 300, operator: ">", threshold: 90 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 75 },
    messageTemplate: "{asset} memory at {value}% (fires above {threshold}%)",
  },
  {
    name: "High device temperature",
    description:
      "Fires when a hardware temperature sensor stays above 80°C and clears below 65°C. Mirrors the Highest Temperature widget. Baseline example — edit or delete freely.",
    severity: "critical",
    trigger: {
      type: "asset_metric",
      metric: "hwSensorValue",
      aggregation: "avg",
      windowSec: 300,
      operator: ">",
      threshold: 80,
      dimensionFilter: { sensorClass: "temperature" },
    },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 65 },
    messageTemplate: "{asset} temperature at {value}°C (fires above {threshold}°C)",
  },
  {
    name: "High disk usage",
    description:
      "Fires when a filesystem is above 90% used and clears below 75%. Mirrors the Highest Disk Usage widget. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_metric", metric: "storageUsedPct", aggregation: "latest", operator: ">", threshold: 90 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 75 },
    messageTemplate: "{asset} disk at {value}% used (fires above {threshold}%)",
  },
  {
    name: "Slow response time",
    description:
      "Fires when average probe response time stays above 500ms and clears below 200ms. Mirrors the Slowest Response widget. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "asset_metric", metric: "responseTimeMs", aggregation: "avg", windowSec: 300, operator: ">", threshold: 500 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 200 },
    messageTemplate: "{asset} response time at {value}ms (fires above {threshold}ms)",
  },
  // Packet loss climbs a severity ladder rather than firing one flat alert: loss
  // is a spectrum, so 12% and 45% on the same switch are different problems and
  // an operator wants them paged differently. Tiers share the 15-minute history
  // window (rule 19 — sampling is per trigger, only threshold/severity vary);
  // "truly down" is deliberately NOT the top rung, because it's a different
  // measurement — consecutive total failures, minutes faster than any window can
  // be — and the Asset down rule above owns it (business rule 29).
  {
    name: "High packet loss",
    description:
      "Fires at three levels over the last 15 minutes of probe history: warning above 10% loss, serious above 20%, critical above 30%, clearing below 5%. Only devices that are currently answering are measured, and readings at or above 90% are ignored — at that point the device is having an outage rather than a lossy link, and Asset down already alerts on it, so one outage never raises two alerts and none trails it as the outage ages out of the window. Mirrors the Packet Loss widget — works for any monitored asset. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "asset_metric", metric: "probeLossPct", windowSec: 900, operator: ">", threshold: 10, ignoreAtOrAbove: BASELINE_LOSS_CEILING_PCT },
    severityBands: [
      { threshold: 20, severity: "serious" },
      { threshold: 30, severity: "critical" },
    ],
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 5 },
    messageTemplate: "{asset} packet loss at {value}% (fires above {threshold}%)",
  },
  {
    name: "Storage filling soon",
    description:
      "Fires when a filesystem is projected to fill within 7 days and clears when the projection recovers past 30 days. Mirrors the Storage Forecast widget. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "asset_metric", metric: "storageDaysUntilFull", aggregation: "latest", operator: "<", threshold: 7 },
    scope: { allAssets: true },
    reset: { mode: "auto", clearThreshold: 30 },
    messageTemplate: "{asset} storage projected to fill in {value} days",
  },

  // ── Event condition (mirrors the Recent Reboots widget) ──
  {
    name: "Device recently rebooted",
    description:
      "Fires when a monitored device's uptime resets (a reboot). Mirrors the Recent Reboots widget. Example of an event-based automation — edit or delete freely.",
    severity: "notice",
    trigger: { type: "event", actionPattern: "device.reboot" },
    scope: { allAssets: true },
    reset: { mode: "manual" },
  },
];

// ── V2: event-based automations over the system-generated Event families ──
// One automation per notable event family Polaris already writes, so operators
// control (and customize) the alerting for those events from the Automations
// page. Every actionPattern below is verified against a real logEvent call
// site (tests/unit/seedBaselineAutomations.test.ts pins each glob to fixture
// action strings). {value} is the event's own message on the event path, so
// the default templates surface the source event's text verbatim.
const EVENT_BASELINE_RULES: Record<string, unknown>[] = [
  {
    name: "Integration discovery failed",
    description:
      "Fires when an integration's discovery run fails (integration.discover.error) and clears when that same integration completes a run. One alert per integration per hour. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "event", actionPattern: "integration.discover.error" },
    reset: { mode: "event", resetEvent: { actionPattern: "integration.discover.completed" } },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Integration discovery aborted",
    description:
      "Fires when a discovery run is aborted — by an operator or the auto-abort watchdog (integration.discover.aborted / .auto_aborted). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "integration.discover.*aborted" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Quarantine push failed",
    description:
      "Fires when pushing (or releasing) an asset quarantine to its FortiGates fails (asset.quarantine.failed / .unpush.failed). Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "event", actionPattern: "asset.quarantine.*failed" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 1800,
    messageTemplate: "{value}",
  },
  {
    name: "Reservation push failed",
    description:
      "Fires when pushing a DHCP reservation to a FortiGate fails and the push is queued for retry (reservation.push.failed). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "reservation.push.failed" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 1800,
    messageTemplate: "{value}",
  },
  {
    name: "Reservation push permanently failed",
    description:
      "Fires when a queued reservation push exhausts its retries (reservation.push.queued.failed_permanent) — operator action needed. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "reservation.push.queued.failed_permanent" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 1800,
    messageTemplate: "{value}",
  },
  {
    name: "Agent disconnected",
    description:
      "Fires when a Polaris Agent's WebSocket drops (agent.disconnected) and clears when that same agent reconnects (agent.connected) — an agent that never comes back keeps its alert. Brief reconnects are absorbed by the 30-minute cooldown. Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "agent.disconnected" },
    reset: { mode: "event", resetEvent: { actionPattern: "agent.connected" } },
    cooldownSec: 1800,
    messageTemplate: "{value}",
  },
  {
    name: "Agent upgrade failed",
    description:
      "Fires when a Polaris Agent upgrade fails (agent.upgrade_failed) and clears when that agent upgrades successfully (agent.upgrade_succeeded). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "agent.upgrade_failed" },
    reset: { mode: "event", resetEvent: { actionPattern: "agent.upgrade_succeeded" } },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Capacity severity escalated",
    description:
      "Fires when the Polaris host's capacity severity worsens (capacity.severity_changed with direction=escalated — recoveries never alert). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "capacity.severity_changed", detailsMatch: { direction: "escalated" } },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 600,
    messageTemplate: "{value}",
  },
  {
    name: "IP conflict detected",
    description:
      "Fires on the two address conflicts that stamp an Event (conflict.detected): an ip-override conflict — a discovered IP disagreeing with an operator IP pin — and a duplicate-IP conflict, two network-present assets recording the same address (business rule 40). The discovery hostname-collision flavors surface on the Conflicts page without an Event. Baseline example — edit or delete freely.",
    severity: "notice",
    trigger: { type: "event", actionPattern: "conflict.detected" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Asset auto-decommissioned",
    description:
      "Fires when the stale-asset sweep decommissions a device that hasn't been seen past the cutoff (asset.auto_decommissioned). Baseline example — edit or delete freely.",
    severity: "notice",
    trigger: { type: "event", actionPattern: "asset.auto_decommissioned" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 600,
    messageTemplate: "{value}",
  },
  {
    name: "HA standby down",
    description:
      "Fires when an HA cluster's standby member stops answering while the primary is still up (asset.ha.standby_down) — redundancy is degraded. Baseline example — edit or delete freely.",
    severity: "serious",
    trigger: { type: "event", actionPattern: "asset.ha.standby_down" },
    reset: { mode: "timed", afterSec: 14400 },
    cooldownSec: 3600,
    messageTemplate: "{value}",
  },
  {
    name: "Login lockout engaged",
    description:
      "Fires when repeated failed logins trip the lockout (auth.login.lockout). Baseline example — edit or delete freely.",
    severity: "warning",
    trigger: { type: "event", actionPattern: "auth.login.lockout" },
    reset: { mode: "timed", afterSec: 86400 },
    cooldownSec: 900,
    messageTemplate: "{value}",
  },
];

async function seedRuleSet(markerKey: string, ruleBodies: Record<string, unknown>[]): Promise<{ created: number; skipped: boolean }> {
  if (await hasRunMarker(markerKey)) {
    return { created: 0, skipped: true };
  }

  let created = 0;
  for (const raw of ruleBodies) {
    try {
      const input = ruleInputSchema.parse(raw);
      await createRule(input, SEED_ACTOR);
      created += 1;
    } catch (err) {
      // A single malformed/edge rule must never abort the rest of the seed.
      logger.warn({ err, rule: (raw as { name?: string }).name }, "Failed to seed baseline automation");
    }
  }

  // Stamp regardless of per-rule failures: this is seed-ONCE. Re-running would
  // re-create rules the operator may have deliberately deleted. A partial seed
  // is recoverable via the documented DELETE-the-marker escape hatch.
  await stampRunMarker(markerKey, { created });
  return { created, skipped: false };
}

interface ClassThreshold {
  assetType: string;
  threshold: number;
  count: number;
  integrations: Set<string>;
  conflict?: boolean;
}

/**
 * V3 — mirror each install's PRE-CUTOVER down thresholds into automations.
 *
 * Down used to be `failureThreshold` on the monitor-settings tiers. It is now
 * the covering automation's `missedPolls` (business rule 36), so an install
 * that had tuned a class away from the default would silently change its
 * time-to-down on upgrade unless the old numbers are carried forward. This
 * reads the EFFECTIVE threshold for every monitored asset and emits:
 *
 *   - one all-assets automation at the DOMINANT value (the one covering the
 *     most devices), and
 *   - one `assetTypes:[t]` automation per class whose value differs, which
 *     outranks the all-assets rule on scopeRank and so reproduces the override.
 *
 * Deliberately NOT built on seedRuleSet: that takes a static array of bodies,
 * while this set is computed from live data. Keeping them separate leaves the
 * V1/V2 sets structurally untouched.
 *
 * KNOWN GAP, stated rather than papered over: `scopeRank` does not rank
 * `integrationIds`, so if two integrations carry DIFFERENT thresholds for the
 * same asset class this cannot express it — both rules would tie. It takes the
 * more-sensitive value (matching the resolver's own tiebreak) and records the
 * conflict in the log and the audit trail. Adding a ladder rung to make one
 * seed work would change business rule 18 for every install.
 */
async function seedDownDetectionV3(): Promise<{ created: number; skipped: boolean }> {
  if (await hasRunMarker(MARKER_KEY_V3)) return { created: 0, skipped: true };

  const assets = await prisma.asset.findMany({
    where: { monitored: true },
    select: {
      id: true, assetType: true, discoveredByIntegrationId: true,
      discoveredByIntegration: { select: { type: true } },
      monitorIntervalSec: true, probeTimeoutMs: true, responseTimePolling: true,
      // The resolver's AssetMonitorContext reads these too — selected rather
      // than cast past, so a future field addition fails the build here.
      cpuMemoryIntervalSec: true, temperatureIntervalSec: true, systemInfoIntervalSec: true,
    },
  });

  // Effective threshold per asset. Sequential is fine: resolveMonitorSettings
  // memoizes on (integrationId, assetType), so the DB reads are per distinct
  // CLASS, not per asset.
  const byClass = new Map<string, ClassThreshold>();
  const fleet = new Map<number, number>();
  for (const a of assets) {
    let threshold = DEFAULT_MISSED_POLLS;
    try {
      const eff = await resolveMonitorSettings({
        ...a,
        discoveredByIntegrationType: a.discoveredByIntegration?.type ?? null,
      } as Parameters<typeof resolveMonitorSettings>[0]);
      if (Number.isFinite(eff.failureThreshold) && eff.failureThreshold > 0) threshold = eff.failureThreshold;
    } catch (err) {
      logger.warn({ err, assetId: a.id }, "V3 seed: could not resolve a threshold, using the default");
    }
    fleet.set(threshold, (fleet.get(threshold) ?? 0) + 1);
    const klass = a.assetType ?? "other";
    const prev = byClass.get(klass);
    if (!prev) {
      byClass.set(klass, { assetType: klass, threshold, count: 1, integrations: new Set([a.discoveredByIntegrationId ?? "manual"]) });
    } else {
      prev.count += 1;
      prev.integrations.add(a.discoveredByIntegrationId ?? "manual");
      // Two integrations disagreeing about one class: take the more sensitive
      // value, the same tiebreak the runtime resolver uses.
      if (threshold !== prev.threshold) {
        prev.threshold = Math.min(threshold, prev.threshold);
        prev.conflict = true;
      }
    }
  }

  // Dominant fleet-wide value; ties go to the smaller (again matching the
  // resolver). An install with no monitored assets keeps the default.
  let dominant = DEFAULT_MISSED_POLLS;
  let bestCount = -1;
  for (const [threshold, count] of fleet) {
    if (count > bestCount || (count === bestCount && threshold < dominant)) {
      dominant = threshold;
      bestCount = count;
    }
  }

  const bodies: Record<string, unknown>[] = [
    {
      name: V1_ASSET_DOWN_NAME,
      description:
        'Fires when a monitored asset stops responding. THIS AUTOMATION DEFINES what "down" means for every device it ' +
        "covers: a device is down after this many polls in a row with no answer. A device covered by no down automation " +
        "is never called down — it is still polled and charted, Polaris just renders no verdict. Baseline — edit or delete freely.",
      severity: "critical",
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", missedPolls: dominant },
      scope: { allAssets: true },
      reset: { mode: "auto" },
      messageTemplate: "{asset} is down",
    },
  ];
  const conflicts: { assetType: string; integrations: string[]; chosen: number }[] = [];
  for (const c of byClass.values()) {
    if (c.conflict) conflicts.push({ assetType: c.assetType, integrations: [...c.integrations], chosen: c.threshold });
    if (c.threshold === dominant) continue;
    bodies.push({
      name: `Asset down — ${c.assetType}`,
      description:
        `Carries forward the ${c.threshold}-missed-poll threshold this install had configured for ${c.assetType} ` +
        "devices before the count moved onto automations. More specific than the all-assets rule, so it wins for these devices.",
      severity: "critical",
      trigger: { type: "asset_state", field: "monitorStatus", operator: "==", value: "down", missedPolls: c.threshold },
      scope: { assetTypes: [c.assetType] },
      reset: { mode: "auto" },
      messageTemplate: "{asset} is down",
    });
  }

  // CREATE FIRST, retire second. The reverse order leaves a window with zero
  // down-detection automations — every monitored asset flips to passive. A
  // momentary duplicate is strictly preferable to a momentarily blind fleet.
  let created = 0;
  for (const raw of bodies) {
    try {
      await createRule(ruleInputSchema.parse(raw), SEED_ACTOR);
      created += 1;
    } catch (err) {
      logger.warn({ err, rule: (raw as { name?: string }).name }, "Failed to seed down-detection automation");
    }
  }

  const retired = await retirePristineAssetDownRule(created > 0);

  if (conflicts.length) {
    logger.warn({ conflicts }, "V3 seed: an asset class carried different thresholds across integrations — took the more sensitive value");
    for (const c of conflicts) {
      await logEvent({
        action: "automation.seed.threshold_conflict",
        level: "warning",
        resourceType: "notification-rule",
        resourceName: `Asset down — ${c.assetType}`,
        actor: SEED_ACTOR,
        message:
          `Your ${c.assetType} devices had different missed-poll thresholds across integrations. Polaris carried the ` +
          `more sensitive one (${c.chosen}) into one automation. To restore the per-integration difference, add a ` +
          "narrower down-detection automation scoped by tag or subnet.",
        details: { assetType: c.assetType, integrations: c.integrations, chosen: c.chosen },
      });
    }
  }

  await stampRunMarker(MARKER_KEY_V3, { created, retired, dominant, conflicts: conflicts.length });
  invalidateDownDetectionCache();
  return { created, skipped: false };
}

/**
 * Retire the pre-cutover "Asset down" row — but ONLY if the operator never
 * touched it. `updatedAt === createdAt` holds exactly on an untouched row and
 * is bumped by any save, INCLUDING a bare enable/disable toggle, which counts
 * as the operator having made a decision about this rule.
 *
 * Deleted via the SERVICE, not prisma.delete: deleteRule soft-clears the rule's
 * active notifications first, which would otherwise sit in every alert feed
 * forever once the cascade drops their state rows.
 *
 * An EDITED row is kept and flagged. It still matches isDownDetectionTrigger, so
 * it keeps governing its devices at DEFAULT_MISSED_POLLS — exactly the behaviour
 * it had before — but the operator has to be told the number is now theirs.
 */
async function retirePristineAssetDownRule(safeToRetire: boolean): Promise<boolean> {
  const old = await prisma.notificationRule.findFirst({
    where: { name: V1_ASSET_DOWN_NAME, createdBy: SEED_ACTOR },
    orderBy: { createdAt: "asc" },
    select: { id: true, createdAt: true, updatedAt: true },
  });
  if (!old) return false;
  // Never retire the old rule when the replacement failed to save — that would
  // leave the fleet with no down detection at all.
  if (!safeToRetire) {
    logger.warn({ ruleId: old.id }, "V3 seed: replacement automations failed to save — leaving the existing Asset down rule in place");
    return false;
  }
  if (old.updatedAt.getTime() !== old.createdAt.getTime()) {
    logger.info({ ruleId: old.id }, 'Baseline "Asset down" was edited by an operator — left in place');
    await logEvent({
      action: "automation.seed.v3_retained",
      level: "warning",
      resourceType: "notification-rule",
      resourceId: old.id,
      resourceName: V1_ASSET_DOWN_NAME,
      actor: SEED_ACTOR,
      message:
        'Your edited "Asset down" automation was left untouched. It now DEFINES when a device is down, and it carries ' +
        `no missed-poll count — so it governs its devices at the default of ${DEFAULT_MISSED_POLLS}. Edit it to set the count you want.`,
      details: { ruleId: old.id },
    });
    return false;
  }
  await deleteRule(old.id, SEED_ACTOR);
  return true;
}

/**
 * V4 — repoint timed event automations at the event that says it recovered.
 *
 * The V1/V2 sets shipped before an event automation could reset on anything but
 * a clock, so "Agent disconnected" cleared itself after four hours whether or
 * not the agent ever came back — an alert that answers a question nobody asked.
 * With the counterpart-Event reset in place, the honest reset for those rules is
 * the reconnect.
 *
 * Deliberately narrow, because these are the operator's rows now, not ours:
 *
 *   - only rules whose trigger action pattern has a KNOWN counterpart
 *     (RESET_EVENT_SUGGESTIONS — the same map the wizard prefills from),
 *   - only rules still on a TIMED reset (a hand-picked manual reset is a
 *     decision, not a default), and
 *   - only rules the operator has never edited (`updatedAt === createdAt`, the
 *     V3 retire-step's own test). An edited row keeps its timer and is left
 *     alone entirely — silently changing when someone's tuned alert clears is
 *     worse than leaving it on a clock.
 *
 * The legacy mirror is written in the same update (`clearBehavior: "auto"`,
 * matching legacyMirrorOfV2 for a mode with no legacy spelling), so a
 * pre-wizard reader sees "clears without operator action" rather than a stale
 * four-hour timer.
 */
async function migrateEventResetsV4(): Promise<{ updated: number; skipped: boolean }> {
  if (await hasRunMarker(MARKER_KEY_V4)) return { updated: 0, skipped: true };

  const rows = await prisma.notificationRule.findMany({
    select: { id: true, name: true, trigger: true, reset: true, clearBehavior: true, createdAt: true, updatedAt: true },
  });
  const repointed: { name: string; pattern: string }[] = [];
  for (const row of rows) {
    const trigger = row.trigger as { type?: string; actionPattern?: string } | null;
    if (!trigger || trigger.type !== "event" || !trigger.actionPattern) continue;
    const counterpart = RESET_EVENT_SUGGESTIONS[trigger.actionPattern];
    if (!counterpart) continue;
    // The stored v2 reset when there is one; the legacy column otherwise (a row
    // that predates the v2 cutover and was never re-saved).
    const mode = (row.reset as { mode?: string } | null)?.mode ?? row.clearBehavior;
    if (mode !== "timed") continue;
    if (row.updatedAt.getTime() !== row.createdAt.getTime()) continue;
    try {
      await prisma.notificationRule.update({
        where: { id: row.id },
        data: {
          reset: { mode: "event", resetEvent: { actionPattern: counterpart, resourceType: null } },
          clearBehavior: "auto",
          clearAfterSec: null,
        },
      });
      repointed.push({ name: row.name, pattern: counterpart });
    } catch (err) {
      logger.warn({ err, rule: row.name }, "Failed to repoint automation onto its counterpart event");
    }
  }

  if (repointed.length > 0) {
    await logEvent({
      action: "automation.seed.v4_reset_event",
      resourceType: "notification-rule",
      actor: SEED_ACTOR,
      level: "info",
      message:
        `${repointed.length} unedited baseline automation(s) now clear when the matching recovery event arrives ` +
        `instead of on a timer: ${repointed.map((r) => `"${r.name}" → ${r.pattern}`).join(", ")}`,
      details: { repointed },
    }).catch(() => {});
  }
  await stampRunMarker(MARKER_KEY_V4, { updated: repointed.length });
  return { updated: repointed.length, skipped: false };
}

/**
 * V5 — give the baseline packet-loss automation a saturation ceiling on
 * installs that already have it.
 *
 * The seed above is marker-guarded and never re-runs, so without this every
 * existing install keeps a probeLossPct rule with no ceiling. That was harmless
 * while the ratio discarded outages from its own window; it is not now that the
 * anchor is gone, because the baseline rule is scoped to ALL ASSETS and would
 * raise a second alert trailing every outage on every device as it ages out of
 * the 15-minute window. The anchor removal introduced that regression, so
 * repairing it is this change's job rather than the operator's.
 *
 * Bounded exactly like V3's retire step and V4:
 *   - only probeLossPct triggers that state NO ceiling (an operator who set one
 *     has already answered this question), and
 *   - only rules never edited (updatedAt === createdAt). A tuned rule is theirs,
 *     and silently narrowing when someone's alert fires is worse than leaving it
 *     noisy and saying so.
 *
 * An edited rule is therefore left alone AND NAMED in the Event, at warning
 * level: the operator has to be told that one of their own rules will now alert
 * after outages unless they set a ceiling on it themselves.
 */
async function migrateLossCeilingV5(): Promise<{ updated: number; skipped: boolean }> {
  if (await hasRunMarker(MARKER_KEY_V5)) return { updated: 0, skipped: true };

  const rows = await prisma.notificationRule.findMany({
    select: { id: true, name: true, trigger: true, createdAt: true, updatedAt: true },
  });
  const updated: string[] = [];
  const leftAlone: string[] = [];
  for (const row of rows) {
    const trigger = row.trigger as Record<string, unknown> | null;
    if (!trigger || trigger.type !== "asset_metric" || trigger.metric !== "probeLossPct") continue;
    if (typeof trigger.ignoreAtOrAbove === "number") continue;
    if (row.updatedAt.getTime() !== row.createdAt.getTime()) {
      leftAlone.push(row.name);
      continue;
    }
    try {
      await prisma.notificationRule.update({
        where: { id: row.id },
        data: { trigger: { ...trigger, ignoreAtOrAbove: BASELINE_LOSS_CEILING_PCT } },
      });
      updated.push(row.name);
    } catch (err) {
      logger.warn({ err, rule: row.name }, "Failed to add a saturation ceiling to a packet-loss automation");
    }
  }

  if (updated.length > 0 || leftAlone.length > 0) {
    const didUpdate = updated.length > 0
      ? `${updated.length} unedited packet-loss automation(s) now ignore readings at or above ` +
        `${BASELINE_LOSS_CEILING_PCT}%, so an outage no longer trails a loss alert behind it: ` +
        `${updated.join(", ")}. `
      : "";
    const didSkip = leftAlone.length > 0
      ? `${leftAlone.length} edited packet-loss automation(s) were left alone and carry NO ceiling, so they may ` +
        `now alert as an outage ages out of their window — set "Ignore readings at or above" on each if that ` +
        `is unwanted: ${leftAlone.join(", ")}`
      : "";
    await logEvent({
      action: "automation.seed.v5_loss_ceiling",
      resourceType: "notification-rule",
      actor: SEED_ACTOR,
      level: leftAlone.length > 0 ? "warning" : "info",
      message: didUpdate + didSkip,
      details: { updated, leftAlone, ceilingPct: BASELINE_LOSS_CEILING_PCT },
    }).catch(() => {});
  }
  await stampRunMarker(MARKER_KEY_V5, { updated: updated.length, leftAlone: leftAlone.length });
  return { updated: updated.length, skipped: false };
}

export async function seedBaselineAutomations(): Promise<{ created: number; skipped: boolean }> {
  // Independent markers: a pre-V2 install has the first marker stamped and
  // still picks up the event set; a fresh install seeds both.
  const v1 = await seedRuleSet(MARKER_KEY, BASELINE_RULES);
  const v2 = await seedRuleSet(MARKER_KEY_V2, EVENT_BASELINE_RULES);
  // V3 runs LAST so a fresh install's just-created V1 "Asset down" row is the
  // pristine one it retires — wasteful by a single create, but it keeps the
  // marker contract (a shipped set never changes) intact.
  const v3 = await seedDownDetectionV3();
  // V4 runs after V2 so a fresh install's event rules are already seeded with
  // the counterpart reset and this finds nothing to do — it exists for installs
  // that stamped the V2 marker before the reset existed.
  const v4 = await migrateEventResetsV4();
  // V5 runs after V1 so a fresh install's just-seeded loss rule already carries
  // the ceiling and this finds nothing to do; it exists for installs that
  // stamped the V1 marker before the ceiling existed, where the anchor removal
  // would otherwise leave an all-assets rule alerting after every outage.
  const v5 = await migrateLossCeilingV5();
  // V6 is its own set with its own marker so installs that stamped V2 long ago
  // still receive the platform end-of-life rule.
  const v6 = await seedRuleSet(MARKER_KEY_V6, PLATFORM_LIFECYCLE_RULES);
  return {
    created: v1.created + v2.created + v3.created + v6.created,
    skipped: v1.skipped && v2.skipped && v3.skipped && v4.skipped && v5.skipped && v6.skipped,
  };
}

/** Exported for the seed unit test (glob-vs-fixture pinning). */
export { BASELINE_RULES, EVENT_BASELINE_RULES, PLATFORM_LIFECYCLE_RULES };

(async () => {
  try {
    await runInstrumentedJob("seedBaselineAutomations", async () => {
      const result = await seedBaselineAutomations();
      if (!result.skipped) {
        logger.info(result, "Seeded baseline automations");
      }
    });
  } catch (err) {
    logger.error({ err }, "seedBaselineAutomations startup task failed");
  }
})();
