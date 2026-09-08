# Services — FortiManager / FortiGate discovery, push, description sync, run state

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/descriptionSyncService.ts

**What it owns:** Description sync between Polaris and Fortinet devices (FMG + standalone FortiGate), gated per-integration by `config.syncDescriptions` (default off). **Polaris-primary:** a non-empty Polaris value always wins — pushed on save, re-asserted by every reconcile (device-side edits overwritten, audited); an empty Polaris field **adopts** the device value (`*.adopted` Event) — clearing the Polaris value is how an operator takes the device's. No conflict state (retired 2026-07 with the newest-wins merge; legacy `conflict` rows resolve by pushing the Polaris value). `Asset.descriptionSync.value` / `AssetInterfaceOverride.syncedValue` persist the last synced value (FMG-mirror bookkeeping + UI badge, not a merge base). Guard: a device-side clear never removes a Polaris value (push re-asserts). Surfaces: FortiGate `system/interface` description ↔ `AssetInterfaceOverride`; FortiSwitch per-port description (managed-switch child table via parent controller) ↔ `AssetInterfaceOverride` on the switch asset; device-level `Asset.description` ↔ FortiGate `system/global` alias / FortiSwitch managed-switch description / FortiAP wtp **`location`** (AP Manager's field — wtp `comment` is absent from FMG's copy, so installs strip it; confirmed on live FMG 7.x). FortiOS field shapes are flagged VERIFY-on-real-device in the header (alias cap, child-table PUT patch semantics — the wtp `location` cap is confirmed at 35 chars; the reconcile gates the FortiAP surface on the `location` attribute actually appearing in the wtp read).

**Public API:** `normalizeDescription`, `decideDescriptionSync(polaris, device): "none"|"push"|"adopt"`, `capDescriptionForTarget` + `DESCRIPTION_CAPS`, `pushInterfaceDescription`, `pushSwitchPortDescription`, `pushDeviceDescription` (all accept an optional pre-built `transport` + `currentDeviceValue` so the reconcile pass reuses its batched reads), `syncDescriptionsOnSave({assetId, scope: "interface"|"device", ifName?, actor?})`, `runDescriptionSyncForIntegration(integration): DescriptionSyncSummary` (summary carries `fmgMirrored`/`fmgMirrorFailed`).

**Cross-service deps:** reservationPushService (imports `buildTransportForIntegration` / `callFortiOs` / `classifyPushError` / `Transport` — never inline a new transport builder), fortimanagerService (`proxyQuery` — the FMG-DB mirror's JSON-RPC seam; detection itself lives in fortimanagerService as `detectCentralManagement`), eventLogService (`logEvent`).

**Used by:** src/api/routes/assets.ts (`PUT /:id/interfaces/:ifName/comment` → `syncDescriptionsOnSave(scope:"interface")`, response gains `sync: {attempted, status, error}`; asset PUT → `syncDescriptionsOnSave(scope:"device")` fire-and-forget when `description` changed; `GET /:id` exposes a derived `discoveredByIntegration.syncDescriptions` boolean — the raw config is stripped as it holds tokens); src/services/discovery/discoveryEngine.ts:syncDhcpSubnets Phase 13.7 (`runDescriptionSyncForIntegration`, gated on the toggle — zero cost when off). **Frontend posture on the short device description fields — warn, never limit:** public/js/assets.js keeps the asset Description input at `maxlength="255"` for every type and instead warns live once the typed value would be truncated on push. `descriptionDeviceTarget(asset)` resolves the device target — DESCRIPTION_DEVICE_TARGETS (access_point → FortiAP `location` 35, firewall → FortiGate `alias` 35) mirrors DESCRIPTION_CAPS in the service, keep them in lockstep — and returns null unless `discoveredByIntegration.syncDescriptions===true`, so a non-syncing integration never warns; `descriptionCapWarningHTML` renders the hidden hint and `wireDescriptionCapWarning` reveals it on `input` plus once at wire-up, so a pre-existing over-length description warns on open rather than only after an edit. Wired in both asset modals and in public/js/map.js's right-click topology description editor (same Asset.description, same push, helpers resolved off assets.js which map.html loads first). The Polaris value is never shortened — capDescriptionForTarget truncates only what reaches the device. FortiSwitch `description` is capped at 63 device-side but carries no warning (nobody has hit 63). public/js/integrations.js fires a `showConfirm` (`onSyncDescriptionsToggle`) the moment the operator enables Description Sync, spelling out the device-side caps and the warn-don't-shorten posture (reverts the toggle on decline).

**Invariants:**
- Polaris-primary: a non-empty Polaris value pushes whenever the device differs (device-side edits overwritten, audited); an empty Polaris field adopts the device value. A device-side clear never removes a Polaris value (push re-asserts). The save-time path always pushes.
- Synced-value bookkeeping: a successful push/adopt (or a converged "none") stamps the value onto `Asset.descriptionSync.value` / `AssetInterfaceOverride.syncedValue` — consumed by the FMG mirror's device-agrees check and the UI badge. A failed push preserves the prior stamp.
- All device I/O goes through the shared Transport (both `useProxy` modes + standalone FortiGate). HA-secondary members are skipped (config replicates from the primary).
- Managed-switch addressing: the `switch-id` mkey is NOT reliably the serial — FortiLink setups rename it (e.g. to the hostname; confirmed on FortiOS 7.6.7, where a serial-keyed PUT 404s "Invalid url"). Serial-keyed entry points resolve the CMDB row by `switch-id` OR `sn` (`matchManagedSwitchRow` on the save-time pre-read; the reconcile keys its switch-row map by both), then address the device by the row's real mkey. The 63-char managed-switch/port description cap is confirmed on the same firmware.
- FMG central-management mirror: when discovery has stamped `Integration.config.centralManagement.{wtp,fsw}` (fortimanagerService.detectCentralManagement, run at FMG discovery start — primary signal: the ADOM's dvmdb `flags`, where the `per_device_wtp`/`per_device_fsw` flag being ABSENT means central; bit values decoded per-box from the `/dvmdb/adom` syntax dump via the pure `decodeCentralManagementFlags`, confirmed on a live FMG 7.x; the ADOM-level `obj/wireless-controller/wtp` / `obj/fsp/managed-switch` table probes supply the UI row counts and the fallback verdict), a successful device-side push for that class ALSO `update`s FMG's copy (`mirrorToFmg`, JSON-RPC via fortimanagerService.proxyQuery + read-back verify) — otherwise the next AP Manager / FortiSwitch Manager install reverts the device value. Mirror targets (confirmed on live FMG 7.x for wtp): FortiAP `location` in the controller FortiGate's DEVICE DB (`/pm/config/device/<fgt>/vdom/root/wireless-controller/wtp/<wtp-id>` — the per-AP rows AP Manager displays; the ADOM obj table is empty); FortiSwitch description / port description in the ADOM-level `obj/fsp/managed-switch` table (UNVERIFIED — inert on per-device-managed installs). **Never `set`** (would create objects FMG never had) **and never an install** (would push everything an FMG admin staged). Mirror failures log `asset.description.fmg_mirror_failed` warning Events and never touch device-side sync state; summary carries `fmgMirrored`/`fmgMirrorFailed`. The reconcile's `mirrorCentralDbDrift` batch pass (one FMG-table GET per class — per controller FortiGate for wtp) heals FMG-side drift for values the device already agrees on (pushedThisRun + stored synced-at-value state), so pre-mirror pushes and transient mirror failures converge. FMG's copy is a projection of the device value, not an edit surface: a staged-but-never-installed central-pane edit gets overwritten; an installed edit reaches the device and flows back through the normal adopt path.
- Best-effort, never throws to callers. Transport/read errors leave sync state untouched (quarantine-verify rule); only an actual failed PUT stamps `syncStatus="failed"` + `syncError` (prefixed `[permanent]`/`[transient]` via classifyPushError). `syncStatus` ∈ synced/failed/conflict.
- Every push verifies by read-back; mismatch = permanent failure.
- Clearing a Polaris value is local-only (no device-side delete): a cleared interface comment leaves the device description in place; a cleared `Asset.description` nulls `descriptionSync` and re-seeds from the device next discovery.
- No retry queue — the Phase 13.7 reconcile is the retry path, and is also where device-side edits are detected (adopt / conflict). DB writes only on change.
- Firewall transport deviceName resolves `fortinetTopology.deviceName` (FMG dvmdb name, stamped at discovery) before falling back to hostname; switches/APs route via `fortinetTopology.controllerFortigate`.

**When changing this:**
- Adding a synced surface: add the target kind + cap, a push function with read-back verify, the reconcile read + decision loop, and events; keep the Transport import (parity rule) and update the Description Sync tab copy in public/js/integrations.js.
- Test both FMG proxy and direct (bypass) modes plus standalone FortiGate; verify the FortiOS field shapes flagged in the header on a real 7.x device before relying on them in production.
- The interface-keying is name-only — a device-side rename orphans the override; don't "fix" this by adopting into renamed rows without a stable-ID design.
- Scale: the reconcile is a few CMDB GETs per FortiGate + work proportional to overrides with changed values. Keep it that way — no per-asset device calls, no unconditional DB writes.

---

## services/discovery/assetDiscoveryScope.ts

**What it owns:** The answer to "which discovery would refresh THIS asset, and how do I narrow the run to just this one device?" Backs the asset details slide-in’s **Discover Now** button (`POST /assets/:id/rediscover`), keeping that route thin.

**Public API:** `DiscoveryScope`, `ScopeIntegration`, `ResolvedAssetScope`, `AssetScopeResolution`, `resolveDiscoveryScopeForAsset`

**Cross-service deps:** `prisma`, `src/utils/fortinetParentKey.ts`.

**Used by:** `src/api/routes/assets.ts` (`POST /:id/rediscover`).

**Invariants:**
- It answers TWO separate questions and must not conflate them: WHICH INTEGRATION runs, and WHAT the run is narrowed to. A FortiSwitch/FortiAP’s integration is the one owning its CONTROLLER GATE, not necessarily the one that stamped the child.
- The controller is resolved through `utils/fortinetParentKey.ts` (`readControllerStamp` → `parentAssetWhereOr` → `resolveInfraParentAsset`). **Never** match `fortinetTopology.controllerFortigate` against `Asset.hostname`: FMG’s device name need not equal the gate’s configured hostname, and the mismatch fails silently (prod 2026-08-12).
- `scope: null` is meaningful — a standalone-FortiGate integration IS one device, so a plain full run is the exact equivalent, and `scopeDeviceName` is rejected for non-FMG types anyway.
- `filterAsset` is the row the integration include/exclude filter is re-checked against. For a switch/AP that is the CONTROLLER, because the filter patterns name gates.
- Every refusal carries a human REASON. The UI renders the button disabled with that text, so returning a bare false would read to an operator as a permission problem.

**When changing this:**
- Adding a scope kind is a three-part change: the `DiscoveryScope` union here, a target parameter on that integration’s collector, AND a sweep-disabling sync mode. The directory / vCenter / Arc sync layers run ABSENCE-BASED destructive sweeps — handing one a single-device result without a scoped mode decommissions the rest of the fleet. `sweepPhaseEnabled` in `discoveryEngine.ts` is the pattern to copy.
- Keep the selects tight: this runs on the route, and the slide-in opens constantly.

---

## services/discoveryCancelWatchdog.ts

**What it owns:** The force-exit backstop for discovery cancellation. Armed when a run's abort signal fires, disarmed when `runDiscovery` reaches its finally. If the run hasn't unwound within the grace window (2 min), it logs the in-flight devices with ages, writes an `integration.discover.force_exit` Event, finalizes the `DiscoveryRun` row as `aborted`, and exits the process with code 1 (systemd `Restart=on-failure` / NSSM restart it).

**Public API:** `armDiscoveryCancelWatchdog` (returns the disarm fn), `formatStuckDevices`, `CANCEL_FORCE_EXIT_GRACE_MS`, `FORCE_EXIT_CLEANUP_TIMEOUT_MS`, `ActiveDeviceSnapshot`, `CancelWatchdogOptions`.

**Cross-service deps:** `discoveryRunState.finishRun`, `eventLogService.logEvent`, `logger` — all injectable via options for tests.

**Used by:** `src/services/discovery/discoveryEngine.ts` — `runDiscovery` arms it right after the heartbeat timer and disarms in the finally. One call site.

**Invariants:**
- Fires ONLY when armed (abort signal fired) and not disarmed — a run that cancels cleanly, completes, or errors never trips it.
- Exists for wedges the abort signal cannot reach (non-HTTP awaits, e.g. a lock-blocked Prisma query). Those keep the 60s heartbeat ticking, so the discoveryRunReaper never clears them either — this watchdog is the only automatic recovery.
- The pre-exit bookkeeping writes (Event, finishRun) are each raced against `FORCE_EXIT_CLEANUP_TIMEOUT_MS` — the DB may be the wedge; the exit must never be blocked by the hang it exists to break.
- Finalizing the row as `aborted` before exit clears the UI immediately (no reaper wait) and leaves `cancelRequested=true`, so a pg-boss redelivery of the interrupted job self-aborts at runDiscovery startup.

**When changing this:**
- Keep the grace ≥ the cancel poll interval (3s) with generous margin — a well-behaved abort must always beat the watchdog.
- The exit takes the whole process: fine for the discovery role, whole-app under `POLARIS_ROLE=all` / cursor-mode web fallback (same semantics as the operator /restart endpoint). Don't make the grace shorter without considering that case.
- The disarm call in runDiscovery's finally is load-bearing — if you restructure runDiscovery, a missing disarm means every cancelled run force-exits the process 2 minutes later.

---

## services/discoveryDurationService.ts

**What it owns:** Rolling discovery-duration tracking per integration (and per-FortiGate within FMG runs), baseline computation for slow-run detection, the threshold formula, and the auto-abort ceiling.

**Public API:** `recordSample`, `getBaseline`, `getBaselines`, `computeBaseline`.

**Cross-service deps:** none (reads/writes Settings key "discoveryDurationStats").

**Used by:** `src/services/discovery/discoveryEngine.ts` — slow-check baseline lookup (`checkForSlowRuns`, which reads both `thresholdMs` for the warning and `autoAbortMs` for the hard cancel) and record per-FG and overall run durations; `src/api/routes/integrations.ts` — the `GET /integrations` list endpoint attaches `discoveryBaseline` per row so the card UI can show an "Avg Discovery Time" sized against `pollInterval`. ~4 call sites.

**Invariants:**
- Only successful (non-aborted, non-errored) runs recorded; failed runs skip `recordSample()` to avoid poisoning the average. (This is why the auto-abort loop-breaker in `discoveryAutoAbortService` exists — an auto-aborted run can't refresh its own baseline.)
- Rolling window = 10 samples; new sample appends, list trims to last 10.
- Baseline requires ≥3 samples; returns null otherwise.
- Slow-run threshold = `max(avg + 2σ, avg × 1.5, avg + 60s)` — ensures headroom even on uniform fast runs.
- Auto-abort ceiling = `max(2× avg, thresholdMs)` — clamped to the slow threshold so the warning always fires at or before the abort, and tiny baselines keep the 60s floor instead of aborting at 2× a few seconds.
- Unit key is either integrationId (overall) or `${integrationId}:${fortigateDevice}` (per-FG).
- Stats are stored in Settings as `{ units: { [unitKey]: { samples: [ms], updatedAt } } }`.

**When changing this:**
- Test threshold formula on small sample sets (3–5 entries) to ensure floor (60s) prevents false positives.
- Verify window=10 balances responsiveness vs stability; too small (5) may be jittery, too large (20) may lag env changes.
- Check getBaselines() batch reads are correct (no off-by-one in map population).
- Confirm recordSample() ignores invalid input (negative ms, non-finite values).
- Test edge case: if all 10 samples are identical, stddev=0 and threshold should still be avg + 60s (floor wins).
- `autoAbortMs` must never drop below `thresholdMs` — checkForSlowRuns assumes the slow warning precedes any auto-abort.

---

## services/discoveryAutoAbortService.ts

**What it owns:** The loop-breaker state behind discovery auto-abort — after `checkForSlowRuns` cancels a run at its `autoAbortMs` ceiling, the NEXT overlong run is exempt (alternating abort/exempt) so a fleet that legitimately outgrew its baseline can complete once and re-baseline.

**Public API:** `decideAutoAbort` (pure), `evaluateAutoAbort`, `clearAutoAbortState`, `AutoAbortUnitState`, `AutoAbortDecision`.

**Cross-service deps:** none (reads/writes Settings key "discoveryAutoAbortState").

**Used by:** `src/services/discovery/discoveryEngine.ts` — `checkForSlowRuns` calls `evaluateAutoAbort` when an over-ceiling run is found (web/scheduler role); `runDiscovery`'s completed branch calls `clearAutoAbortState` alongside `recordSample` (discovery role). Cross-process coherence rides the Setting row.

**Invariants:**
- An entry exists only between an auto-abort and the next successful full (non-scoped) run; success deletes it.
- Exemption is granted to exactly one run (keyed by the run's `startedAt` ISO) and is stable across repeated 30s ticks; `granted: true` surfaces only on the first tick so the caller logs the skip Event once.
- If the exempted run never completes successfully, the following overlong run is aborted again (abort/exempt alternation) — the sequence can only end via a successful run or the runs dropping back under the ceiling.
- Scoped single-device runs never participate (checkForSlowRuns skips them before evaluating).

**When changing this:**
- Keep `decideAutoAbort` pure — it's the unit-tested core (`tests/unit/discoveryAutoAbortService.test.ts`).
- Any new terminal outcome in `runDiscovery` that records a duration sample must also clear this state, or the alternation logic will keep exempting/aborting against a baseline that's already fresh.
- The evaluate path only runs for over-ceiling runs, so Setting reads are rare — don't move it into the per-tick hot path for all runs.

---

## services/discoveryRunState.ts

**What it owns:** DB-backed live state for discovery runs (replaces the prior in-memory `activeDiscovery` Map). The discovery worker coalesces hot progress writes through a `RunAccumulator`; the web role reads the rows for the `/discoveries` list, slow-run detection, and cancel signalling.

**Public API:** `DiscoveryRunStatus`, `ActiveDeviceEntry`, `RunAccumulator`, `newRunAccumulator`, `upsertQueuedRun`, `markRunStarted`, `flushRunProgress`, `touchWorkerHeartbeat`, `finishRun`, `isRunActive`, `anyRunActive`, `isCancelRequested`, `requestCancel`, `listActiveRuns`, `persistSlowFlags`, `reapStaleRuns`, `DiscoveryRunRow`

**Cross-service deps:** `prisma`, `logger`.

**Used by:** `src/services/discovery/discoveryEngine.ts` (discovery control), `src/api/routes/integrations.ts` (`/discoveries` list + cancel + backup-restore guard), `src/api/routes/assets.ts` (`POST /:id/rediscover` pre-check via `isRunActive`), `src/jobs/discoveryRunReaper.ts` (stale-run reaping), `src/services/discoveryCancelWatchdog.ts` (`finishRun("aborted")` before force-exit).

**Invariants:**
- Hot progress is coalesced in the accumulator (mutates synchronously, flushes throttled + on terminal transitions); `flushRunProgress` / `touchWorkerHeartbeat` are best-effort and never kill a run on a transient DB hiccup.
- Slow-alert flags are owned by the web-role slow check, never touched by the worker flush; `createdAt` resets on every upsert so elapsed-time math reflects current run age.
- `reapStaleRuns` marks any queued/running row with a stale heartbeat as error.
- `scopeDeviceName` (single-FortiGate scoped re-discovery) is stamped by `upsertQueuedRun` and reset to NULL by the next run's upsert — it's part of the `base` reset object, so a full run never inherits a stale scope label.

**When changing this:**
- The worker heartbeat timer detects stalled phases — keep it shorter than the reaper's stale window.
- The heartbeat runs on a timer independent of progress, so a wedged-but-alive run heartbeats forever and the reaper never clears it — that gap is covered by `discoveryCancelWatchdog` (force-exit after a cancelled run overstays its grace), not by the reaper. Don't "fix" a stuck run by loosening the reaper.

---

## services/fortigateService.ts

**What it owns:** Standalone FortiGate REST API client & discovery (mirrors FMG scope—DHCP subnets, reservations, device inventory, interface IPs, managed FortiSwitches/FortiAPs, VIPs).

**Public API:** testConnection, fgRequest, proxyQuery, discoverDhcpSubnets, FortiGateConfig, plus re-exported DiscoveryResult & 6 DiscoveredXxx types from FMG.

**Cross-service deps:** fortimanagerService (imports DiscoveryResult shape + types; fortimanagerService imports fgRequest, testConnection, proxyQuery for proxy-mode device iteration).

**Used by:** src/api/routes/integrations.ts — test + manual proxy query, src/services/discovery/discoveryEngine.ts — discovery, src/services/monitoringService.ts — REST calls for uptime monitoring, src/services/reservationPushService.ts — direct REST push of DHCP reservations, src/services/assetQuarantineService.ts — direct REST push of quarantine targets.

**Invariants:**
- fgRequest is the low-level bearer-token auth layer; all per-device queries use it.
- discoverDhcpSubnets returns DiscoveryResult identical to FMG's shape so the discoveryEngine.ts syncDhcpSubnets pipeline handles both identically.
- FortiAP `/api/v2/monitor/wifi/managed_ap` row parsing is centralized in `src/utils/fortiapMonitorRow.ts` (`parseFortiapMonitorRow` + `FORTIAP_MONITOR_FORMAT`) — both transports import the same parser + format string so they can't drift.
- Standalone FortiGate has no proxy/direct toggle (useProxy doesn't apply); all queries go directly to the device's management IP.
- proxyQuery is a read-only REST pass-through for manual API testing; does not modify CMDB.
- Per-FortiGate query fan-out is seven parallel chains (A-G); Chain G calls `/api/v2/monitor/system/ha-peer` to populate `DiscoveredDevice.haMode` + `haMembers`. 404 / empty = standalone.
- Chain G failures are isolated — a hung HA query never tanks the whole device's discovery (same try/catch pattern as Chains A-F).
- Chain C's detected-device loop additionally builds `switchMacByName: Map<switch_id, mac>` from rows where `is_fortilink_peer===true` and stamps each managed FortiSwitch's `baseMac` field after the AP-attribution pass. Zero extra REST calls — joined from the existing query response. Keep the stamp inside Chain C: doing it elsewhere would re-iterate detected-device rows for no win.

**When changing this:**
- Verify DiscoveryResult shape matches fortimanagerService exactly—sync pipeline expects field parity.
- `lastSeenSwitch` / `lastSeenAp` are deliberately NOT in MATERIAL_ASSET_FIELDS: discovery Phase 7 writes them set-always, and Phase 7 vs 7.5 stage differently-formatted strings for the same port, so a generic staged-vs-before diff here could not stay quiet. Their dedicated events come from the builders instead.
- **`logDiscoveryAssetUpdated` also emits `asset.firmware.changed`** when the material diff contains `os`/`osVersion`. This is the ONE seam covering all nine snapshot-based discovery paths (FortiGate / FortiSwitch / FortiAP infra, Arc, Entra/Intune, AD, vCenter) — don't re-emit firmware at those call sites, and don't record Fortinet-infra os/osVersion in discovery's change-baseline, or the event doubles.
- The builders are **pure** (return `LogEventInput | undefined`, no Prisma) so discovery loops can accumulate into one `logEventsBatch` and the change decisions are unit-testable — see `tests/unit/assetChangeEvents.test.ts`.
- **Firmware suppresses a null→value first learn** (Polaris learning what a device runs is identification, already covered by `asset.discovered`/`asset.discovery_updated`) and a value→null (a source going quiet is not a downgrade). **Connection events do the opposite for null→value**: first observed attachment IS the "where is this plugged in" record worth having. Both connection kinds compare trim + case-insensitively, because discovery writes `inv.apName` while the wireless scrape writes the AP asset's hostname and a pure case difference between the two writers would otherwise alternate an event every cycle.
- These four actions are written UNCONDITIONALLY — never through `maybeEmitChangeEvents`/`isChangeActionSubscribed` like the `change.*` family. They're edge-triggered and rare, so a steady fleet writes none; their entries in `notificationTypes.CHANGE_TYPES` only give the automations wizard a picker over an always-present event.
- Check monitoringService and both push services still call fgRequest with correct vdom/token/method signatures.
- Confirm proxyQuery handles GET/POST/PUT/DELETE correctly for manual testing route.
- Test discovery parallelism (no clamping unlike FMG proxy mode) with high per-device concurrency.
- Ensure VDOM parameter threading is correct (default "root"; custom vdoms from config).
- Renaming any of the four `asset.*.changed` action strings must move `CHANGE_TYPE_ACTIONS` in `notificationTypes.ts` in the same commit, or stored automations silently stop matching (`tests/unit/notificationChangeTypes.test.ts` pins the pairing).
- Adding another per-FortiGate REST endpoint: add an 8th chain inside the Promise.all rather than appending after — keeps wall-clock at max(chain) instead of sum(chains).

---

## services/fortigateCoordPushService.ts

**What it owns:** Write-back orchestrator for FortiGate `gui-device-latitude` / `gui-device-longitude` (and FMG coordinate metavars when applicable) after `syncDhcpSubnets` resolves geocoded coords that diverge from the device's current CMDB values. The FMG metavar names are operator-configurable (`fortigateMonitor.latitudeMetavar` / `longitudeMetavar`, default `Latitude` / `Longitude`).

**Public API:** `pushCoordsToFortigate(integration, deviceName, latitude, longitude, latMetavar?, lngMetavar?): Promise<CoordPushResult>`. The metavar names default to `Latitude` / `Longitude`; the caller passes the integration's configured names. Ignored by the standalone FortiGate path (CMDB-only).

**Cross-service deps:** fortimanagerService (uses native FMG helpers `setFmgDeviceMetavarCoords` — Policy & Objects metadata-variable `dynamic_mapping` upsert — + `setFmgDeviceCmdbGuiCoords`), fortigateService (uses `fgRequest` for the standalone CMDB PUT).

**Used by:** src/services/discovery/discoveryEngine.ts:syncDhcpSubnets Phase 3 — fires once per FortiGate after the per-HA-member loop, gated on `pushGeocodedCoords` + geocode success + `coordsClose()` mismatch. Geocode coords come from either the SNMP sysLocation or the FMG address metavar (address wins; see the geo cross-cutting section).

**Invariants:**
- FMG mode writes BOTH per-device metavars AND CMDB GUI coords. Standalone FortiGate writes only CMDB. Single source of truth for routing — never inline another transport choice in callers.
- All FMG writes go through the native lane (no `/sys/proxy/json` wrapper) — they don't share the proxy-lane concurrency=1 constraint.
- Best-effort: per-target failures are collected into the returned `{ok, targets[], error?}` shape but never thrown. Audit events (`integration.coords.pushed` / `integration.coords.push_failed`) live at the caller in discoveryEngine.ts, not here.
- FMG-mode CMDB writes land in FMG's CMDB but do NOT trigger an FMG install — the live FortiGate sees the change only when an operator runs Install Device Configuration in FMG. UI text on the toggle surfaces this caveat.
- Coords are formatted as `.toFixed(6)` strings before sending (FortiOS stores them as strings, not floats).

**When changing this:**
- Adding a new write target: add a new try/catch arm, push the target name onto the `targets` array on success, log + continue on failure (don't throw).
- If extending to integration types beyond fortimanager / fortigate, mirror the type-dispatch pattern from reservationPushService — never inline a new transport builder.
- Verify both modes when changing the FMG payload: re-discover with `pushGeocodedCoords` on; confirm metavars + CMDB both updated via `curl` directly against FMG's REST API.

---

## services/fortigateLocationService.ts

**What it owns:** Discovery-time REST pull of FortiGate SNMP sysLocation (`GET /api/v2/cmdb/system.snmp/sysinfo`). REST instead of net-snmp so it reuses the existing FMG-proxy / standalone transport and doesn't need a separate SNMP credential.

**Public API:** `fetchFortigateSysLocation({integration, deviceName}): Promise<string | null>`.

**Cross-service deps:** reservationPushService (imports `callFortiOs` + `buildTransportForIntegration`).

**Used by:** src/services/discovery/discoveryEngine.ts:syncDhcpSubnets Phase 3 — gated on the integration's `fortigateMonitor.pullSnmpLocation` toggle. Fires ONCE per FortiGate per discovery cycle (NOT per HA member — cluster members share sysLocation by physical co-location).

**Invariants:**
- REST-only. Never bring back an SNMP path here — adding net-snmp would re-introduce a credential resolver + per-host gate that the REST approach deliberately sidesteps.
- Returns trimmed, whitespace-collapsed string OR null. Empty FortiOS response → null. Transport failures → null (logged at warn).
- Never throws. The discovery sync continues with no location update on failure.
- Works in BOTH FMG proxy and direct modes — FMG forwards the call to the FortiGate in proxy mode, so Polaris doesn't need network reachability to the FortiGate's mgmt IP.

**When changing this:**
- Adding new SNMP system-info fields (sysContact, sysDescription): same endpoint already returns them. Extend the interface and surface as additional return fields rather than adding new endpoints.
- Don't add retries here — the caller (syncDhcpSubnets) treats this as a single-shot, best-effort fetch; retry logic would burn discovery wall-clock for marginal value.

---

## services/integrationHealthService.ts

**What it owns:** the payload behind `GET /api/v1/integrations/health-summary` — the sidebar's 30-second poll, running on every page for every signed-in session. Two unrelated signals share one response deliberately: `failed` (enabled integrations whose most recent connection test failed) and `proxyAdvice` (enabled FortiManager integrations still on the proxy transport whose fleet has outgrown it). Neither is worth a second poll.

**Public API:** `getIntegrationHealthSummary()` (the whole payload), `selectProxyAdvice(integrations, gateCountById, threshold?)` and `integrationIsFmgProxyMode(config)` (pure, unit-tested), `FMG_PROXY_GATE_ADVISORY_THRESHOLD` (= 10).

**Cross-service deps:** prisma only (two `integration.findMany` + one `asset.groupBy`).

**Used by:** `src/api/routes/integrations.ts` `GET /health-summary` (thin wrapper); `public/js/app.js` `pollFailedIntegrations()` renders both halves into the sidebar (`#integration-failed-status`, `#fmg-proxy-advice`).

**Invariants:**
- **Gate counts come from ONE `asset.groupBy`, never a count per integration.** This runs every 30 s per session; the fleet-size rule applies at 2000 assets.
- **Proxy is the DEFAULT**: `useProxy !== false`. An absent flag is a proxy-mode integration — reading it as direct would silence the advisory for exactly the installs that never touched the setting.
- The threshold comparison is **strictly greater-than**: a fleet sitting exactly on the line is supported, not advised.
- A missing groupBy row is **zero** gates, not an unknown — a proxy integration that has discovered nothing must not be advised.
- The advisory is about **THROUGHPUT, not capability**. `/sys/proxy/json` is serialized at concurrency 1 by FMG (see fmgWorker.ts) so a poll cycle grows linearly with gate count, while direct mode parallelises up to 20. Proxy mode's separate inability to collect a FortiGate's REST monitoring streams is a real but distinct (and fixable) problem — keep it out of this copy or the advisory reads as wrong the moment that lands.

**When changing this:**
- `FMG_PROXY_GATE_ADVISORY_THRESHOLD` is duplicated as operator-facing copy in the Direct Polling hint in `public/js/integrations.js`. **Change both together** — a modal and a sidebar advising different things about the same fleet is worse than either number being slightly off.
- Adding a third signal to this response: keep it cheap and slow-moving. Anything needing sub-30 s freshness, or a query that scales with asset count, does not belong on a poll every session runs.

---

## services/fmgActivityService.ts

**What it owns:** DB-backed heartbeat of every local `FmgWorker`'s proxy + native lane state. The role that runs FMG traffic (discovery in split-role prod, the single process in "all" mode) writes a snapshot of `getAllFmgWorkers()` to the `fmgActivitySnapshot` Setting row every 2 s. The web role reads the same row back to render "Active FMG Calls" on the integrations page — bridging the in-memory state across the multi-process split.

**Public API:** `startFmgActivityHeartbeat()` (idempotent boot-path entry), `getFmgActivityForIntegration(integrationId)` (read-side; returns proxyInFlightLabel + proxyQueueDepth + nativeInFlightCount + updatedAt/role/ageMs/fresh), `STALENESS_MS` (10 s — older snapshots are flagged `fresh: false`), `stopFmgActivityHeartbeatForTests`.

**Cross-service deps:** fmgWorker (`getAllFmgWorkers()` for the snapshot), prisma (single `Setting` row read/write).

**Used by:** src/app.ts boots `startFmgActivityHeartbeat()` inside the `runsDiscoveryConsumers` block, src/api/routes/integrations.ts `GET /:id/fmg-activity` reads via `getFmgActivityForIntegration()`, public/js/integrations.js polls that endpoint every 2 s for every FortiManager-type integration card on screen.

**Invariants:**
- Heartbeat write rate is 2 s per FMG-running process; only roles with `runsDiscoveryConsumers=true` write. Single Setting row clobbers per write — no per-process slicing, so in dev "all" mode the lone process is the writer.
- Snapshot is `{ updatedAt, role, integrations: { [id]: { proxyInFlightLabel, proxyQueueDepth, nativeInFlightCount } } }`. An integration absent from the map = no FmgWorker has been instantiated for it yet (lazy create on first submit).
- Freshness window is 5× heartbeat interval (10 s) so a transient hiccup doesn't flap the UI; a genuinely-down heartbeat process surfaces inside the window.
- Read path returns a zeroed readout with `fresh: false` when the Setting row is missing — so the UI renders "no heartbeat" on a brand-new install before discovery runs.

**When changing this:**
- Changing the heartbeat interval: keep `STALENESS_MS ≥ 3×` the interval so the UI doesn't flap on a single missed write.
- Adding new FmgWorker fields you want surfaced: extend `FmgWorkerActivity`, both `buildSnapshot` and `getFmgActivityForIntegration`, the route response shape, and the `_renderFmgActivity()` helper in [public/js/integrations.js](public/js/integrations.js).
- Adding more cross-process state surfaces in the future: prefer one Setting row per concern (clobber-on-write is fine at 2 s cadence), not one big shared blob.

---

## services/fmgWorker.ts

**What it owns:** Per-integration FortiManager worker with two lanes — a proxy lane (strict concurrency=1 FIFO) for `/sys/proxy/json` calls and a native lane (unbounded) for every other FMG call. Module-level `Map<integrationId, FmgWorker>` lazy-created on first submit; never torn down.

**Public API:** `getFmgWorker(integrationId): FmgWorker`, `getAllFmgWorkers(): FmgWorker[]`, `FmgWorker.submitProxy<T>(label, task, signal)`, `FmgWorker.submitNative<T>(label, task, signal)`, `FmgWorker.proxyQueueDepth`, `FmgWorker.proxyInFlightLabel`, `FmgWorker.nativeInFlightCount`, `__resetFmgWorkersForTests`.

**Cross-service deps:** metrics (publishes `polaris_fmg_worker_queue_depth{integrationId}` + `polaris_fmg_worker_inflight{integrationId}` for the proxy lane, `polaris_fmg_worker_native_inflight{integrationId}` for the native lane).

**Used by:** src/services/fortimanagerService.ts (`rpc()` routes via `submitProxy` / `submitNative` based on the JSON-RPC payload URL — every call that touches FMG flows through this), src/services/fmgActivityService.ts (`getAllFmgWorkers()` for the 2 s heartbeat snapshot). No other module should call `submitProxy` / `submitNative` directly; by transitivity the rpc-path covers reservationPushService.ts, assetQuarantineService.ts, monitoringService.ts, and the integrations.ts routes that test / probe / manual-query FMG.

**Invariants:**
- Proxy lane is strict FIFO with concurrency=1 — honors FMG's "drops parallel /sys/proxy/json past 1-2" constraint. Cross-feature serialization holds here: an operator clicking "Reserve IP" mid-discovery has the reservation-push proxy call wait behind in-flight discovery proxy calls.
- Native lane is unbounded; the worker just tracks inflight count for observability. Native FMG endpoints (`/pm/config/...`, `/dvmdb/...`, auth) hit FMG's own DB and have no parallel-call constraint.
- Aborts (proxy lane): pre-dispatch abort drops the queued entry and rejects with AbortError. In-flight abort is the task's fetch-signal responsibility.
- Aborts (native lane): no queue, so abort just bubbles through the task's own fetch signal.
- One worker per integration id. Different integrations get independent workers and run fully concurrently across both lanes.

**When changing this:**
- Adding a NEW FMG-bound code path: just call `rpc()` with the integrationId; the lane dispatch is automatic from the JSON-RPC payload URL. Never call `submitProxy` / `submitNative` directly from outside fortimanagerService.
- If a new FMG endpoint pattern shows up that needs lane treatment different from "is it /sys/proxy/json", update `rpcPayloadIsProxy()` in fortimanagerService — keep the predicate the only place that decides which lane.
- Test both lanes when adding behavior — the proxy lane is exercised by FIFO + abort tests; the native lane by concurrent-fire + inflight-decrement-on-throw tests.

---

## services/fortimanagerService.ts

**What it owns:** FortiManager JSON-RPC API client & full discovery orchestration (DHCP subnets, device inventory, interface IPs, VLAN membership, DHCP reservations, FortiSwitches/FortiAPs, VIPs, ARP).

**Public API:** testConnection, resolveDeviceMgmtIpViaFmg, testRandomFortiGate, proxyQuery, fmgProxyRest, proxyQueryViaFortigate, discoverDhcpSubnets, FortiManagerConfig, DiscoveryResult, DiscoveryProgressCallback (and 6 DiscoveredXxx types). Every entry point accepts an optional `integrationId?: string` (and `discoverDhcpSubnets` additionally accepts `warmCacheIps?: Map<string,string>`); when supplied, internal `rpc()` calls funnel through `getFmgWorker(integrationId)` so FMG traffic stays serial against the "one-request-at-a-time" constraint. There is intentionally **no `/sys/logout`**: Polaris authenticates with a predefined REST API Admin api-key, which (per the FMG API Best Practices Guide) is permanent and shares one session per user — login/logout endpoints exist for session-based auth only. A prior hourly logout (commit 3e70476) tore the shared session out from under the split-role monitor/discovery processes that reuse it and was removed; if FMG reaps the session at its hard lifetime the next bearer call re-establishes it.

**Cross-service deps:** fortigateService (imports discoverDhcpSubnets for direct-mode fallback; imports fgTestConnection and proxyQuery for proxy testing); fmgWorker (every rpc call routes through `getFmgWorker` when an integrationId is in scope).

**Used by:** src/api/routes/integrations.ts — test + manual proxy query, src/services/discovery/discoveryEngine.ts — discovery orchestration + realtime push via FMG, src/services/monitoringService.ts — FMG proxy REST for uptime monitoring, src/services/reservationPushService.ts — push DHCP reservations to FortiGate via FMG proxy/direct, src/services/assetQuarantineService.ts — push quarantine targets via FMG proxy/direct.

**Invariants:**
- Proxy mode (`useProxy: true`, default) clamps per-FortiGate parallelism to 1 because FortiManager drops parallel `/sys/proxy/json` connections. The FMG worker's proxy lane enforces that serialization; the per-device CMDB scrapes (interface config, DHCP CMDB, VIPs, geo coords, etc.) run concurrently on the worker's native lane, so per-device throughput is higher than the proxy-lane bottleneck alone would suggest.
- Direct mode (`useProxy: false`) requires valid fortigateApiUser/fortigateApiToken on the FMG integration; mgmt IPs come from either the warm cache (monitor-up firewall Asset rows) or `resolveDeviceMgmtIpViaFmg` for cache-cold/new devices. Cache-cold mgmt-IP resolves now run concurrently across the worker pool (native lane is unbounded) — fresh installs no longer pay the serial-resolve penalty before per-device discovery can start.
- All FMG-bound calls go through `rpc()`, which inspects the JSON-RPC payload's first param URL and routes to `getFmgWorker(integrationId).submitProxy` (when it's `/sys/proxy/json`) or `submitNative` (every other URL). Per-device direct-FortiGate calls do NOT touch FMG and fan out up to `discoveryParallelism` wide independently of the worker.
- Transport-level resilience (`rpcInner`/`rpcAttempt`): retries **transient** failures only — HTTP 5xx + network/timeout — up to 2 times with exponential backoff (500ms, 1500ms), serialized INSIDE the FmgWorker lane slot so the proxy lane stays concurrency=1 and a struggling FMG isn't piled on. **Permanent** failures fail fast with no retry: HTTP 401/403/404/405 and the FMG RPC `-11` surfaced by callers. Outward `AppError.httpStatus` stays 502 for every transport fault — the upstream HTTP code is encoded in the message and used only to decide retryability, never re-exposed to Polaris's own clients (a raw 401 would trip the frontend's session-expired logout). An external abort (integration re-saved) short-circuits without retrying. This is a transport-layer policy beneath the discovery callers; do NOT add a second app-level retry loop on top (see `fetchFortigateSysLocation` note).
- Projected CMDB `get` calls pass `loadsub: 0` to skip child-table loads (FMG API Best Practices Guide), EXCEPT where a child table is intentionally needed: `system/interface` (secondary-ip) and `firewall/vip` (mappedip + realservers — the latter is the Virtual-Server pool consumed by `parseVipServerInfo`). Do NOT add a `fields` list to the `/dvmdb/.../device` full-device-record fetch or `system/dhcp/server` — naming restricted fields like `latitude` makes this FMG authorize each field individually and fail the whole query with `-11`.
- Parity invariant: both FMG and standalone FortiGate return identical DiscoveryResult shape for sync pipeline compatibility.
- FortiAP `/api/v2/monitor/wifi/managed_ap` row parsing centralized in `src/utils/fortiapMonitorRow.ts` (`parseFortiapMonitorRow` + `FORTIAP_MONITOR_FORMAT`) — shared with the standalone FortiGate path. Captures IP / MAC (with `board_mac` fallback) / model (with `deriveFortiapModelFromSerial` for blank-model APs) / `apUplinkInterface` (from `wan_status[].interface` then LLDP `local_port`) plus the live telemetry snapshot (`cpu_usage` / `mem_free` / `mem_total` / `sensors_temperatures`) which feeds the AssetSource observed blob and the runtime AP REST telemetry collector. **Firmware version trust rule**: `os_version` is the live running firmware (canonical `FPxxx-vX.Y.Z-buildNNNN`); the `version` / `firmware_version` fields are CACHED display-format values that lag upgrades ("7.4.5 Build 0734", bare "FortiAP" placeholder — prod incident 2026-07) and are accepted only when they match the canonical shape (`isCanonicalFortiapVersion`). A row with no usable version yields `""` and `upsertFortinetInfraAssetSource` (discoveryEngine.ts) preserves the previous blob's `osVersion` instead of blanking it (absent ≠ wipe, LLDP-persist convention; applies to fortiswitch rows too).
- Step 3d.5's detected-device loop additionally builds `switchMacByName: Map<switch_id, mac>` from rows where `is_fortilink_peer===true` and stamps each managed FortiSwitch's `baseMac` field after the AP-attribution pass. Zero extra `/sys/proxy/json` calls — joined from the existing query response, so the FMG proxy lane stays at the same call count. Parity-mirrored in `fortigateService.ts` Chain C.
- Cache-miss fallback in processDevice's direct-mode branch: if a warm-cache dispatch fails, re-resolve via FMG worker and retry once at the freshly-resolved IP. Cleared via `cachedNames.delete(deviceKey)` so the loop never iterates more than twice.
- All FMG name-keyed in-memory state (`mgmtIpByDevice`, `cachedNames`, `warmDispatched`, `devicesByName`) keys on `fmgNameKey(name)` (lowercased). FMG-stored device names and FortiOS system-status hostnames can disagree in case for the same device; lowercasing the key on both write paths (warm-cache pre-populate + FMG-verify resolve) means the worker's lookup succeeds no matter which producer seeded the entry. Display names in log lines + Events still use original casing carried on the rawDevice / asset row.
- HA detection is **zero extra calls**: `extractHaFromFmgDevice(raw)` reads `ha_mode` + `ha_slave[]` directly off each `/dvmdb/adom/<adom>/device` record FMG already returns. The "current primary" is identified by matching `ha_slave[].sn` against `device.sn`; `idx === 0` is the fallback. Standalone devices return `{ haMode: "standalone", haMembers: [] }` so downstream code branches uniformly.
- Per-member health: `extractHaFromFmgDevice` also normalizes `ha_slave[].status` (numeric or string `1`=up / `0`=down; anything else → `status` undefined so unknown encodings degrade to "no signal", never a false alarm — verify-on-real-FMG) into `haMembers[].status`. The fortigateService Chain G stamps `status:"up"` for every ha-peer-listed member (listing IS liveness there; a dead member drops out of ha-peer entirely and falls to the Phase 2a sweep). Consumed by the discoveryEngine.ts firewall fan-out: `fortinetTopology.haMemberStatus` + the standby-only display `haClusterIp`, the `asset.ha.standby_down`/`asset.ha.standby_restored` Events (suppressed for offline-in-FMG cached reads and for primaries), and the frontend Standby / Standby Down pill. `haClusterIp` must NEVER be promoted to `Asset.ipAddress` — the standby's null IP is what keeps IP-keyed dedup/probe/reservation paths from cross-matching cluster members.
- Direct-mode HA precedence: when FMG's `ha_slave[]` is populated, it wins over fortigateService's `ha-peer`-derived view (FMG's view is stable across failover; ha-peer reflects whichever physical box is currently active and would flip on failover).
- `DiscoveryResult.knownDeviceNames` preserves FMG-side casing (whatever `/dvmdb/adom/.../device` returned). The downstream Phase 2 / 2a roster check in `discoveryEngine.ts:syncDhcpSubnets` builds a lowercase `knownDeviceNamesLc` view and compares lowercase-on-both-sides, AND prefers `knownFirewallSerials` over the hostname check entirely — same device, same chassis, different name casing is a real-world FMG-vs-FortiOS condition (FMG-stored "evansville-fw-1" vs FortiOS-returned "EVANSVILLE-FW-1"). If you add a new consumer of `knownDeviceNames`, normalize the same way.
- **The roster is where HA member identities come from, not the processed devices.** `extractRosterIdentities(devicesDataRaw)` walks the RAW `/dvmdb/adom/<adom>/device` payload once — pre-filter, any conn_status — and returns `{ names, serials }` covering each device's top-level `name`/`hostname`/`sn` PLUS every `ha_slave[]` member's `name` and `sn`. `names` becomes `DiscoveryResult.knownDeviceNames`, `serials` becomes the new `DiscoveryResult.knownDeviceSerials`. It deliberately ignores `ha_mode`: the question is "does the upstream still know this chassis", not "what shape is the cluster". Sourcing member identities from `result.devices` instead (the pre-2026-08 behavior) made a standby's survival depend on its cluster answering — a gate that failed its direct read, was skipped for an unresolved management IP, or was filtered out contributes NO processed device, so its primary matched the raw-roster name and lived while its standby matched nothing and was decommissioned by Phase 2a every cycle. fortigateService's `rosterSerials(devices, callerSerial)` is the standalone analogue (caller serial + every Chain-G `ha-peer` member).
- Phase 2a's serial match is **case-insensitive** (both sides folded to upper case) and carries a third rule after serial and hostname: `haStandbyOfUnreadCluster(fortinetTopology, knownFirewallSerialsUc, haRosterPublishedUc)` in `discoveryEngine.ts` protects a `haRole=="secondary"` asset whose `haPeerSerial` the upstream still knows but whose cluster published no membership this run (`haRosterPublished` = serials from every processed device's `haMembers`). A member missing from a roster that WAS read has genuinely left the cluster and is still judged; a member of a cluster nobody enumerated is unknowable, not gone. Unit-tested in `tests/unit/haStandbyRosterIdentity.test.ts` alongside `extractRosterIdentities`.
- `testRandomFortiGate` Fisher-Yates-shuffles the filtered device list and walks up to `MAX_RANDOM_FORTIGATE_ATTEMPTS = 2` entries — so one offline/in-maintenance gate doesn't fail the whole direct-transport test when the rest of the fleet is healthy. Only the per-gate steps (`resolveDeviceMgmtIpViaFmg` + `fgTestConnection`) retry; FMG-level failures (device list fetch, empty/filtered-out ADOM, missing mgmt interface) are returned as-is on the first try. The response carries an `attempts: string[]` listing every gate name tried so callers can surface "initial pick failed; backup pick succeeded" or "also tried: X" in the UI.
- **Scoped re-discovery** (`discoverDhcpSubnets`'s trailing `scopeDeviceName?` param, from `POST /assets/:id/rediscover`): the roster is narrowed to the one matching device (case-insensitive `fmgNameKey` on name/hostname) AFTER `filterDevices` and AFTER the raw roster is captured into `knownDeviceNames` — so the returned `knownDeviceNames` still carries the whole fleet and nothing outside the scope can ever look "removed" downstream. No match THROWS (message distinguishes roster-miss from filtered-out); the scoped progress log must keep the `Found 1 managed device` phrasing (the run accumulator regex-parses `totalDevices` out of it). The caller (`runDiscovery`) is responsible for finalizing in `"finalize-scoped"` mode — this service only narrows.

**When changing this:**
- Verify parity with fortigateService.discoverDhcpSubnets (DiscoveryResult shape + field semantics).
- Check reservationPushService & assetQuarantineService both call fmgProxyRest correctly for proxy mode + resolveDeviceMgmtIpViaFmg for direct mode, AND that both pass `integrationId` so the call routes through the FMG worker.
- Confirm monitoringService still resolves management IPs and calls fmgProxyRest with `integrationId` for proxy-mode health checks.
- Update polaris-monitoring-discovery/references/fmg-discovery-decision-tree.md if transport modes, roster filters, or per-class stamping change.
- Test proxy-mode parallelism clamp + direct-mode device resolution end-to-end. Confirm warm-cache producer fills the worker pool from t=0 on a fleet with monitor-up firewalls.
- New FMG-bound code paths MUST submit through `getFmgWorker(integrationId)` — bare `rpc()` without an integrationId loses cross-feature serialization and reintroduces the parallel-connection failure mode.

---

## services/geocoderService.ts

**What it owns:** Address-string → lat/lng geocoder backed by OpenStreetMap Nominatim with a positive+negative `GeocodeCache` (90-day TTL) and a process-global 1 req/sec rate limiter.

**Public API:** `geocode(query: string): Promise<{ latitude: number | null, longitude: number | null, cached: boolean }>`.

**Cross-service deps:** None (uses prisma directly for cache reads/writes; `getAppVersion()` for the Nominatim User-Agent).

**Used by:** src/api/routes/integrations.ts:syncDhcpSubnets Phase 3 — geocodes FortiGate SNMP sysLocation when `fortigateMonitor.pullSnmpLocation` is on.

**Invariants:**
- Normalization key: trim + collapse-whitespace + lowercase. Same on read and write so capitalization / spacing variants collide on one cache row.
- Cache stores BOTH positive AND negative results. A null lat/lng row means "Nominatim returned no match" — the negative-cache signal that prevents gibberish strings from repeatedly hitting upstream.
- Transport failures (timeout / non-2xx / parse error) do NOT write a cache row. Only the upstream's actual response (success OR empty array) writes — so a transient Nominatim outage doesn't poison subsequent retries.
- Rate limiter is module-level chained Promise enforcing ≥1100 ms between outgoing requests (Nominatim's usage policy is 1 req/sec; 100 ms safety margin). Cache hits BYPASS the gate entirely.
- User-Agent identifies Polaris per Nominatim's usage policy (`Polaris-IPAM/<version>`). Never use a generic / library-default UA.
- Never throws. All failures return `{latitude: null, longitude: null, cached: false}` so callers in the discovery hot path don't need to wrap.

**When changing this:**
- Don't add per-request retries — Nominatim's policy is "be patient and don't hammer us"; one shot per cycle, fall through on failure, retry on next discovery.
- TTL is 90 days. Lengthening it reduces upstream load further; shortening risks operators editing sysLocation and waiting too long to see the new pin location. Don't go below 7 days.
- Adding a second provider (Google / Mapbox): introduce a `provider` parameter, store provider per cache row (already in schema), and run all writes through a single normalization so the cache stays consistent.
- If extending to other domains (e.g. non-FortiGate asset location lookups), keep the rate limiter shared — Nominatim doesn't care which Polaris feature triggered the request, only the rate-per-process matters.

---

## services/reservationPushService.ts

**What it owns:** DHCP reserved-address push/unpush to FortiGate via FMG proxy or direct REST.

**Public API:** normalizeMac, pushReservation, updatePushedReservation, unpushReservation, releaseDhcpLease, plus the transport helpers `buildTransportForIntegration` / `findScopeIdForCidr` / `listReservedAddresses` / `callFortiOs` (+ types `Transport`, `FortiOsReservedAddress`) exported so peer services can reuse the same FMG-proxy / direct-FortiGate dispatcher for read-only single-scope work.

**Cross-service deps:** fortigateService (fgRequest), fortimanagerService (fmgProxyRest, resolveDeviceMgmtIpViaFmg).

**Used by:** src/services/reservationService.ts (pushReservation on create, unpushReservation on dhcp_reservation release, releaseDhcpLease on both dhcp_reservation and dhcp_lease release); src/services/subnetRefreshService.ts (read-only per-subnet refresh consumes the transport helpers).

**Invariants:**
- MAC address must be 48-bit (normalized to xx:xx:xx:xx:xx:xx)
- Transport selection: useProxy=true → FMG proxy, useProxy=false → direct FortiGate REST
- Direct mode requires fortigateApiToken + mgmtInterface on integration config
- Scope resolution by matching gateway+netmask or ip-range start-ip
- Verify-by-readback mandatory; failure throws AppError (triggers reservation rollback)
- Description format: "Polaris/<user>: <hostname>" or "Polaris: <hostname>"
- Lease release (releaseDhcpLease) uses /api/v2/monitor/system/dhcp/release-lease (best-effort, no rollback)

**When changing this:**
- Test both FMG proxy and direct modes with actual FortiOS DHCP server configs
- Verify MAC normalization handles all separators (colons, dashes, dots, none)
- Check scope resolution fallbacks (gateway+netmask, then ip-range)
- Test verify-by-readback on slow devices (echoed id missing, need IP+MAC lookup)

---
