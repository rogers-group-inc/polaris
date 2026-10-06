# Services — Polaris Agent install, build, channel, commands; the firmware repository

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol. The three firmware services sit here because `firmwareUpgradeService` copies `agentInstallService.startUpgrade`'s shape — synchronous refusals, a row, a kickoff Event, a rule-80 hold, a `setImmediate` runner on the web process.

## services/firmwareRepositoryService.ts

**What it owns:** The firmware repository (Server Settings → Repository; business rule 87): the manufacturer › device type (`switch` / `access_point` / `firewall` — the last since 2026-10-06) › model TREE, the IMAGES filed under a model node (two per node — primary + backup — with the rotation an upload performs), the login BINDINGS at the three scopes (a device-admin `form` login; on a Firewall scope also a `restapi` token credential or `source: "integration-token"`), and the per-asset CANDIDATE lookup. Bytes on disk under `FIRMWARE_DIR`; identity from the image header, never the model string.

**Public API:** `FIRMWARE_ASSET_TYPES`, `FIRMWARE_MAX_IMAGE_BYTES_BY_TYPE` (switch / AP 100 MiB — the FortiSwitch endpoint's own ceiling — firewall 300 MiB; `registerUploadedImage` enforces the per-type cap), `FIRMWARE_MAX_IMAGE_BYTES` (the largest — what multer accepts at all), `FIRMWARE_BINDING_SOURCES` (`credential` | `integration-token`), `isFirmwareAssetType`, `getFirmwareTree`, `listImages`, `getImage`, `registerUploadedImage`, `discardIncomingUpload`, `setPrimaryImage`, `deleteImage`, `purgeModelImages`, `resolveImagePath`, `ensureFirmwareDirs`, `listBindings`, `upsertBinding`, `deleteBinding`, `resolveFirmwareCredential`, `findUpgradeCandidates`, `listRecentRuns`, `listAssetsForNode` + `FIRMWARE_NODE_ASSET_LIMIT` (a tree node's device list — its `where` MUST stay the tree groupBy's: switch/AP, not decommissioned, stored manufacturer, null-or-blank model for the "" node, or the list disagrees with the count the operator clicked; a count + a capped tight-select findMany + one primaries read, compared in memory); the row / node / candidate types.

**Cross-service deps:** `prisma` (asset groupBy + a tight-select serial scan, firmwareImage, firmwareCredentialBinding, firmwareUpgradeRun.count); `utils/firmwareVersion` (header/filename parse, compare, `platformFromSerial`); `utils/manufacturerNormalize.normalizeManufacturer`; `utils/paths` (`FIRMWARE_DIR`, `FIRMWARE_INCOMING_DIR`); `credentialService.getCredential({ revealSecrets: true })` (the ONE place a device password or bound API token is read); `utils/httpCheck.isDeviceLoginCredential`; `utils/fortinetRestCredential.restApiCredentialAuth` (a `restapi` binding's token / verifySsl / port); `prisma.integration` (an `integration-token` binding's token — `integrationTokenFor` reads the discovering integration's config: a standalone `fortigate` integration's `apiToken` / `verifySsl` / `port`, a `fortimanager`'s `fortigateApiToken` / `fortigateVerifySsl`, so one binding covers both transports — FMG ↔ FortiGate parity); `firmwareEngines/index` (`engineFor`, `engineKindForType`); `assetTypeService.listAssetTypes` (labels); `eventLogService.logEvent`.

**Used by:**
- `src/api/routes/firmware.ts` — every repository route; `discardIncomingUpload` when the upload's text fields fail validation.
- `src/services/firmwareUpgradeService.ts` — `findUpgradeCandidates`, `resolveFirmwareCredential`, `resolveImagePath`, `getImage`.
- `public/js/server-settings-firmware.js` — the tab, through the routes.

**Invariants:**
- **Matching is by platform, filing is by model.** An asset is offered an image only when `image.platform === platformFromSerial(asset.serialNumber)` (rule 87); the model node decides nothing about eligibility. A filename-only image has `platform: null` and is never offered.
- **A node holds one primary and one backup**, and the DATABASE enforces it (two partial unique indexes). `registerUploadedImage` rotates in ONE transaction and refuses whole (409) when a queued/running run references the backup it would remove. `setPrimaryImage` steps through the transient `swapping` role because the partial indexes are checked per statement. `deleteImage` on the primary promotes the backup so a node never has a backup alone.
- **Only a PRIMARY is offered unasked.** `findUpgradeCandidates` returns the strictly-newer primary for the platform (the asset's own model node preferred, else newest) and names the SAME node's backup only when it too is strictly newer. Zero queries when `engineFor` is null.
- **Resolution is model › type › manufacturer, most specific LIVE row that can sign in to THIS device wins.** SKIPPED, never a shadow (the rule-49 posture): a binding whose credential was deleted (`credentialId` null on a `credential` source) or is no longer a `form` login / openable `restapi` token; a token kind (`restapi` credential or `integration-token`) on anything but a firewall (`bindingFitsType` — the tree's effective-binding fold applies the same test); an `integration-token` whose asset has no `discoveredByIntegrationId`, whose integration is gone or holds no FortiOS token. `getFirmwareTree` cannot know the per-asset integration, so it shows an integration-token binding as effective even where some gates will fall through. Secrets are revealed only with `{ revealSecrets: true }`, which only `startFirmwareUpgrade` asks for; a token comes back as `bearerToken` (+ `verifyTls`, `port`) with empty username/password.
- **The binding vocabulary is guarded by the database**: `source` CHECK, and `source = 'credential' OR (assetType = 'firewall' AND credentialId IS NULL)` (migration `20261006010000_firmware_fortigate`); `upsertBinding` answers the same refusals as 400s first (`restapi` or integration-token off a Firewall scope).
- **The same bytes are filed once** (`sha256 @unique` → 409 naming the node); the temp file is removed on every failure path; the final rename is same-filesystem (the incoming dir sits under FIRMWARE_DIR).
- **An upload path is proven inside FIRMWARE_INCOMING_DIR before ANY file operation on it** — read, rename or delete (private `incomingPath()`, resolve + prefix check). A path that fails is refused (400) and left on disk: it is not ours to remove. `discardIncomingUpload` is the only way the route removes an upload it refused before registering, and it goes through the same check (CodeQL js/path-injection, 2026-09-28).
- Never writes Asset. Never opens a socket to a device.

**When changing this:**
- Adding a device type (firewall was the last, 2026-10-06): `FIRMWARE_ASSET_TYPES`, `FIRMWARE_MAX_IMAGE_BYTES_BY_TYPE` (and nginx's firmware `client_max_body_size` if the max grows — `deploy/nginx/polaris.conf` + `.template` + `tests/unit/nginxRenderer.test.ts`), the two CHECK constraints (last widened by migration `20261006010000_firmware_fortigate`), `engineKindForType`, `utils/firmwareVersion.ts` family + serial test, the tree's type order and the tab's copy, `public/js/assets.js → _assetFirmwareEligible` and the mobile `FW_ELIGIBLE`, the wiki's device lists. Note `firmwareVsPrimary` reads `FIRMWARE_ASSET_TYPES`, so the automation field starts reading the new type at once; the baseline automation's seeded scope does not follow.
- Changing the two-image cap: the partial unique indexes AND `registerUploadedImage`'s rotation AND the tab's copy ("A model keeps two images") move together; `tests/unit/firmwareImageRotation.test.ts` pins every transition.
- Any new offer path must go through `findUpgradeCandidates` — the platform + strictly-newer gate lives there once.
- Scale: the tree is two `groupBy`s + one small `findMany` + one tight-select serial scan (only when the tab opens); never add a per-asset query.

## services/firmwareUpgradeService.ts

**What it owns:** One asset, one flash (business rule 87): what the asset card is told (`getUpgradeAvailability`), the SYNCHRONOUS gates and the kickoff (`startFirmwareUpgrade`), the runner that drives an engine and keeps the run row current, the reads, and the boot sweep for runs a restart orphaned. Copies `agentInstallService.startUpgrade`'s shape.

**Public API:** `getUpgradeAvailability`, `startFirmwareUpgrade`, `checkSchedulableUpgrade` (what a BOOKING takes when it is made — business rule 93: the image gates + a bound login, returning `{ approved, fromVersion, warnings }` where `warnings` are today's `healthBlockers`, NOT a refusal), `getRun`, `listRunsForAsset`, `failOrphanedFirmwareRuns`; `FirmwareRunConflictError` (the 409 subclass for a refusal that clears on its own — a live run on the device, on a connection-path ancestor/descendant or MCLAG peer, and the P2002 race; a click answers it like any 409, a booking waits on it); `UpgradeAvailability` / `UpgradeAvailabilityState` / `RunSummary` / `StartUpgradeInput` (`scheduleId?` — the booking this start fires). The private `approvedImageFor` (engine → HA → address → platform → candidates → the approved image) is the ONE copy of the image gates, shared by a start and by a booking; the private `haClusterOf` (a `firewall` whose `fortinetTopology` carries `haMode` / `haRole`) is why an HA member is `unsupported` on the card and a 400 at start AND at booking.

**Cross-service deps:** `firmwareRepositoryService` (candidates, credential, image path); `firmwareEngines/index` (`engineFor`, `engineByKind`) and `firmwareEngines/types` (`DEFAULT_FIRMWARE_TIMEOUTS`); `maintenanceScheduleService.openMaintenanceHold` / `releaseMaintenanceHold` (kind `firmware-upgrade`, rule 80); `connectionPathService.resolveConnectionPath` + `prisma.assetMclagPeer` (the topology gate); `utils/assetInvariants.UNMONITORABLE_STATUSES` (rule 10); `eventLogService.logEvent`; a dynamic import of `discovery/assetDiscoveryScope.resolveDiscoveryScopeForAsset` + `discovery/discoveryEngine.triggerDiscovery` (the scoped rediscover on success); `node:fs/promises.stat`.

**Used by:**
- `src/api/routes/firmware.ts` — `firmwareAssetRouter` (`GET /`, `POST /`, `GET /runs`) and `GET /server-settings/firmware/runs/:id`.
- `src/jobs/failOrphanedFirmwareRuns.ts` — the boot sweep.
- `src/services/firmwareScheduleService.ts` — `checkSchedulableUpgrade` at booking, `startFirmwareUpgrade({ scheduleId })` when a booking fires, `FirmwareRunConflictError` to tell "wait" from "refused" (rule 93). The reverse edge is a LAZY import: the runner's `.finally` and `failOrphanedFirmwareRuns` call `notifyScheduledRunFinished` through `notifyScheduledRun`, like `requestRediscover`, because the schedule service imports this one.
- `public/js/assets.js` — the Firmware card, through the routes (`_startFirmwarePoll` polls the run).

**Invariants:**
- **The gates are synchronous and ordered** (engine → not an HA member → address → platform → candidates → the REQUIRED approved `imageId` must be the offered primary or the eligible backup → health → login → one live run per asset, none on a connection-path ancestor/descendant or MCLAG peer → the image file exists), each an `AppError` answered to the click; the partial unique index on `(assetId) WHERE status IN (queued, running)` answers the race (P2002 → 409). `tests/unit/firmwareUpgradeGates.test.ts` pins the order. The three "a related flash is live" refusals (one live run, topology, P2002) are `FirmwareRunConflictError` and NOTHING else is — a booking retries on that class and settles `refused` on every other, so widening it turns a permanent refusal into a two-hour retry loop.
- **A booked start is the same start** (rule 93): `scheduleId` changes the Event's wording ("Scheduled firmware upgrade started", `details.scheduleId`), links `FirmwareUpgradeSchedule.runId` BEFORE the runner is scheduled (so a crash between the two still lets the boot sweep find the booking), and after the runner settles — success or failure, after the terminal row and Event — the booking's recipients are emailed. It takes no gate a click does not.
- **`maintenance` is allowed; unmonitored is allowed** (the hold no-ops, as it does for an agent upgrade). Down / warning / recovering / dependency-suppressed / unmonitorable are refused.
- **The hold outlives the engine on a run that reached the reboot** (`holdUntilMonitorAnswers`): after an `upgraded` or `unverified` outcome the run sits in stage `recovering` and polls `assetMonitorSample.findFirst({success:true, timestamp > engine end})` every `recoveryPollMs` until one lands or `recoveryWaitMs` (10 min) passes, first pushing the hold's `expiresAt` past the cap. The engine proves the device over its WEB UI, which on a FortiAP answered minutes before the SNMP agent monitoring polls; releasing on "engine done" let the next polls miss outside the window. A `failed` run skips the wait (an incident); no hold row = unmonitored = nothing to wait for. The two timeouts live on `FirmwareEngineTimeouts` so tests shrink them through `overrides`, but no ENGINE reads them.
- **The hold is taken BEFORE the runner is scheduled** and released in the runner's `finally` BEFORE the terminal Event (the `failUpgrade` ordering, rule 80a), by `failOrphanedFirmwareRuns` at boot, and by the reconcile's 45-minute expiry as the backstop.
- **Never writes `Asset.osVersion`.** Projection owns it (asset-source-projection); the run records `verifiedVersion` and requests a scoped rediscover, and `getUpgradeAvailability` reports `pending-discovery` until the record catches up so the button does not re-offer a flash that happened.
- **The plaintext password — or a FortiGate's bearer token — exists only inside the runner's engine context** (`ctx.credential`, `ctx.bearerToken`, with the token's `verifyTls` / `port`) — never in a log line, the run `log`, or an Event's `details` (only `credentialId` / name / scope / `source`).
- **`ASSET_SELECT` carries `discoveredByIntegrationId` + `fortinetTopology`** — the first is what an `integration-token` binding resolves through, the second the HA gate. Both are cheap per-asset columns on a one-asset read; never widen this select into a fleet read.
- **The server owns the card's vocabulary**: `state` and `reason` are what the card draws; a new state is added here, not inferred from a sentence client-side.
- Runs execute on the web process (the image is on its disk; pg-boss is optional). A restart mid-flash orphans the run; the sweep names it rather than hides it. Row writes are throttled to one per 5 s; nothing here touches the monitor ticks.

**When changing this:**
- A new blocker: add it to `healthBlockers` (so availability and start agree), to the gates test, and to the wiki's list.
- A new engine: `firmwareEngines/index.ts` `engineFor` + `engineKindForType`, the run row's `engine` vocabulary (`fortiswitch-https` / `fortiap-https` / `fortigate-https`), the file map, and the docs' "Fortinet only" sentence. An engine that signs in differently (the FortiGate's bearer token) widens `FirmwareEngineContext` in `firmwareEngines/types.ts` and the `ctx` built in `runUpgrade`.
- Lifting the HA refusal: `haClusterOf`, AND the engine's own `system/ha` preflight (`fortigateHttps.ts → gateHaMode`), AND rule 87's invariant + the wiki — the refusal lives in three places on purpose.
- A new terminal outcome: `finish`, the Event table (`firmware.upgrade_*`), the card's `_fwRunResultHTML`, and `dropHold` ordering — and `notifyScheduledRunFinished`'s status → outcome mapping plus `utils/firmwareResultEmailTemplate.ts` (a booked run's email).
- A new image gate goes in `approvedImageFor`, so a booking takes it at booking AND at firing; a new device-STATE gate goes after it in `startFirmwareUpgrade` only (and, if it is a health blocker, `healthBlockers` so the booking modal warns about it).
- If a queue ever replaces `setImmediate`, the image must travel with the job (it lives on the web host's disk) and the boot sweep's "this process was driving it" premise changes.

## services/firmwareScheduleService.ts

**What it owns:** A firmware flash BOOKED for later (business rule 93) and the email that says how it went. Booking (`createSchedule` / `updateSchedule` / `cancelSchedule`) from the asset's Firmware card: the image approved BY NAME as for a flash now (rule 87), a time (`assertSchedulableTime`: ≥ `MIN_LEAD_MS` 1 min ahead, ≤ `MAX_LEAD_MS` ~a year), and recipients (`normalizeRecipients`: lower-cased, de-duplicated, 1…`MAX_RECIPIENTS` 20; the modal pre-fills `defaultRecipientsFor` = the booker's profile email). Firing (`runDueSchedules`, the job's tick): due `pending` rows oldest first, up to 50, ONE AT A TIME — first seen more than `LATE_GRACE_MS` (15 min) late → `missed`; waiting on a conflict more than `CONFLICT_WAIT_MS` (2 h) → `refused`; else CLAIM (`pending` → `started`, conditional) and hand to `startFirmwareUpgrade({ scheduleId })` — success stays `started`, a `FirmwareRunConflictError` goes back to `pending` with `error` = what it waits on, any other error → `refused`. Notifying (`notifyScheduledRunFinished` for a run; the private `settle` for refused / missed): claim `notifiedAt`, resolve the channel, render per recipient.

**Public API:** `normalizeRecipients`, `assertSchedulableTime` (both pure, throw 400), `defaultRecipientsFor`, `getPendingSchedule`, `listSchedulesForAsset`, `createSchedule`, `updateSchedule`, `cancelSchedule`, `runDueSchedules` (+ `DueRunResult`), `notifyScheduledRunFinished`; `LATE_GRACE_MS`, `CONFLICT_WAIT_MS`, `MIN_LEAD_MS`, `MAX_LEAD_MS`, `MAX_RECIPIENTS`; `ScheduleSummary`, `CreateScheduleInput`, `UpdateScheduleInput`.

**Cross-service deps:** `prisma` (firmwareUpgradeSchedule, firmwareUpgradeRun, asset, user); `firmwareUpgradeService.{checkSchedulableUpgrade, startFirmwareUpgrade, FirmwareRunConflictError}`; `quietTimeSummaryService.resolveSummaryChannel(null, [])` (with no policy and no held rows it falls through to the oldest enabled email channel); `notificationDeliveryService.{applyBrandLetterhead, sendEmailThroughChannel}`; `userTimezoneService.{resolveTimeZone, serverTimeZone}`; `utils/firmwareResultEmailTemplate.renderFirmwareResultEmail`; `eventLogService.logEvent`.

**Used by:**
- `src/api/routes/firmware.ts` — `firmwareAssetRouter`: `GET /` folds in `getPendingSchedule` as `schedule`; `GET /schedules`, `GET /schedules/defaults`, `POST /schedules`, `PATCH /schedules/:scheduleId`, `DELETE /schedules/:scheduleId`.
- `src/jobs/startScheduledFirmwareUpgrades.ts` — `runDueSchedules` every 60 s (web/all role).
- `src/services/firmwareUpgradeService.ts` — `notifyScheduledRunFinished`, lazily, from the runner's `.finally` and from `failOrphanedFirmwareRuns`.
- `public/js/assets.js` — the Firmware card: the upgrade dialog's "Schedule for later" box, and Change… / Cancel scheduled upgrade, through the routes.
- `public/js/mobile/asset-detail.js` — the same on the phone's OS row: the confirm sheet's "Schedule for later" box, Change / Cancel.

**Invariants:**
- **Approved at booking, judged at firing.** Booking takes only `checkSchedulableUpgrade` (image gates + a bound login); health and topology are NOT taken then and come back as `warnings` for the modal. Firing goes through `startFirmwareUpgrade`, which re-takes EVERY gate — so a newer primary uploaded after booking makes the booked image no longer offered and the booking is REFUSED, never silently retargeted.
- **Every transition out of `pending` is conditional on `status = 'pending'`** (claim, update, cancel), so a tick racing a cancel fires or cancels, never both, and two ticks never fire one booking twice. The DB backs the service's 409: one `pending` per asset (partial unique) and ≥ 1 recipient (CHECK).
- **Refused is final; a conflict waits.** Only `FirmwareRunConflictError` puts a booking back; the wait is measured from `scheduledFor`, and a waiting booking (non-null `error`) is exempt from the 15-min late rule.
- **Sequential on purpose.** One booking at a time inside a tick is what lets the topology gate see the run the previous booking just started — a batch of switches booked for one minute flashes in turn. Each start is a few point queries before `setImmediate`, so 50 is seconds.
- **Emailed once, whatever happened.** `notifiedAt` is claimed (conditional) BEFORE sending; started→finished, refused, missed and orphaned all reach `sendResults`. One message per recipient, each in that reader's zone when the address is a Polaris user's (else the install's) — like the quiet-time summary, a per-reader message, not a split alert (rule 25 untouched). No channel or a failed send = `notifyError` + `firmware.upgrade_schedule_email_failed`; the booking's own status is unaffected.
- The device link in the email degrades to plain text when `POLARIS_PUBLIC_URL` is unset (`assetPageUrl`).

**When changing this:**
- A new terminal booking status: the migration's status CHECK, `settle`'s Event action, the template's `FirmwareResultOutcome`, the card's `_fwScheduleHTML`, and the wiki's Firmware section.
- Changing the grace or the wait: the constants, the rule-93 invariant + narrative, the wiki, and `tests/unit/firmwareSchedule.test.ts`.
- Running bookings anywhere but the web role breaks the `setImmediate` premise (the image is on that host's disk) — see firmwareUpgradeService's queue note.
- Scale: one indexed query (`status, scheduledFor`) per minute; nothing per asset unless a booking is due.

---

## services/serviceInventoryService.ts

**What it owns:** The `AssetService` current-state table (one row per `(asset, unit)` systemd unit / Windows service) — the unit-centric sibling of the process inventory — and its `AssetInventoryScrape` `services` stamp. The whole list arrives per agent scrape and is written as a DELTA (`utils/inventoryDelta`): one interactive transaction reads the host's rows, creates / deletes / updates only what changed, and upserts the scrape stamp. CPU and memory are stored rounded and compared through a dead band (1 point / 2%), so a running service's jitter does not rewrite its row. It replaced delete-replace on 2026-09-28: at ~500 agents that was ~47M inserts + 47M deletes a day on this table alone.

**Public API:** AssetServiceInput, isServiceControllable, persistAssetServices, getInventoryPresence (`{ services, software }` — whether the asset slide-over draws the Services / Software tabs: rows in `AssetService` / `AssetProcess` / `AssetSoftware`, or an `AssetInventoryScrape` stamp of kind services / processes / software*, since a source that reported an EMPTY list is still pulling the information in; five indexed `findFirst` existence reads, nothing loaded).

**Cross-service deps:** `prisma.assetService`, `retryOnDeadlock` (utils/dbRetry).

**Used by:**
- `src/api/routes/agents.ts` — the `serviceInventory` sample-stream arm maps `ServiceSampleSchema` rows → `persistAssetServices`. Also ships `streams.services` + `monitoredServices`/`mappedServices` on `GET /agents/config` (folded into both the payload ETag and the heartbeat `computeConfigEtag`).
- `src/api/routes/assets.ts` — `GET /assets/:id/inventory-presence` (assets:read, thin → `getInventoryPresence`). `GET /assets/:id/services` reads the rows + pins (read-only; start/stop/restart control was removed in the Satellite-posture change). `monitoredServices`/`mappedServices` ride the general `PUT /assets/:id` pin path (UpdateAssetSchema).
- `agent/internal/collectors/services*.go` — the sole producer (`ServiceInventoryOnce`; systemd `systemctl list-units/list-unit-files/show`, Windows `Win32_Service`). The Linux path parses the **plain columnar** output of `list-units`/`list-unit-files` (`--plain --no-legend`), NOT `-o json`: systemctl only emits JSON for those list verbs from an interactive session — under the agent's systemd service context it silently falls back to the table format, so JSON parsing yields nothing (this caused Linux services to never populate; fixed 2026-07). The untagged pure parsers `parseListUnits` / `parseListUnitFiles` / `parseShowUnits` live in `services.go` (unit-tested). On a command error OR an empty parse `listUnits` returns nil + logs, so a parse regression skips the push rather than wiping the inventory (an empty list still deletes every row — the delta's remove set). **CPU is derived in `ServiceInventoryOnce`, not per platform** (`applyServiceCPURates`): each platform returns a cumulative counter (systemd `CPUUsageNSec` for the cgroup, else the main PID's CPU time; Windows the service process's CPU time via gopsutil) plus a `cpuKey` naming what it measured, and `cpuPct` is the difference against the previous scrape over the wall time between them. So the first scrape after an agent start carries none, and a changed key (restart, reused PID) drops the baseline instead of differencing two processes. On Windows memory/CPU/program name come from ONE `readPidStat` per distinct PID — services sharing an svchost.exe each report the whole process; the Services tab marks them shared (`_svcSharedProcessIndex`), the agent does not split. `ServiceInventoryOnce` also records unit → DisplayName (`serviceDisplayName`) for the Windows service-log reader.
- `public/js/assets.js` — the Services tab (`_wireAssetServicesTab`) + `openServiceDetailPanel`.

**Invariants:**
- Delete-then-insert in ONE `$transaction` under `retryOnDeadlock`; empty rows = valid delete-only scrape. Keyed `@@unique([assetId, unit])`. Plain table, NO FK to Asset (matches AssetProcess/AssetSdwanRule).
- `controllable` is DERIVED here, never trusted from the wire: systemd `loadState==="loaded"`, or any Windows service. Control routes re-check it.
- Agent-only. Agentless SSH/WinRM does not resolve units (`agentlessProcessService` hardcodes serviceUnit null) — no agentless producer exists.
- `mainProcess` is a display cross-link to the process rows (Services tab, *Include processes* view), not a key.

**When changing this:**
- Adding a field: extend the Prisma model + migration, `ServiceSample` (Go transport) + collectors, `ServiceSampleSchema` + the ingest arm (agents.ts), the `AssetServiceInput` map, `SERVICE_FIELDS` + `pickServiceFields` in serviceInventoryService, and the `GET /assets/:id/services` projection — in lockstep. Bump `agent/VERSION`. **Miss `SERVICE_FIELDS` and the delta never sees the new column change**: an existing row keeps its first value forever and only newly created rows carry the field. The process table's twin is `PROCESS_FIELDS` + `pick` in `monitoringService.persistAssetProcesses`. A new live FIGURE (one that jitters) goes through the dead band (`sameInventoryRow`), not the exact list.
- The `serviceLog` stream (per-unit journalctl → `AssetServiceLogSample`; agent `servicelog.go` + the platform `readServiceUnitLog` — `journalctl -u` on Linux (seeds at the tail), a `wevtutil qe /f:RenderedXml` XPath per channel on Windows (`winServiceLogQuery`: SCM entries whose data names the service's short or display name in System, plus its own provider in System/Application; cursor = highest EventRecordID per unit per channel; the first read backfills `winServiceLogBackfill` = 50 because SCM entries are sparse), ingested in agents.ts via `enqueueServiceLogSamples`, read at `GET /assets/:id/service-logs`) and connection-unit-attribution (Phase 3) hang off the same pins (`monitoredServices`/`mappedServices`) shipped by the config endpoint. Adding a service-log field touches the Prisma model + migration, `ServiceLogSample` (Go transport) + `servicelog.go`, `ServiceLogSampleSchema` + the ingest arm, `ServiceLogRow`/`enqueueServiceLogSamples` (sampleWriteBuffer), and the `pruneSystemInfoSamples` line.

---

## services/softwareInventoryService.ts

**What it owns:** The `AssetSoftware` current-state table (installed software, one row per `(asset, source, key)`) and its three `AssetInventoryScrape` stamps (`software` / `software:intune` / `software:arc`), plus the two integration passes that fill the non-agent sources. Three writers share the table and **each owns only its own `source` rows** — `agent` (the agent's `softwareInventory` stream), `intune` (Intune detected apps, read during an Entra/Intune run) and `arc` (Azure Change Tracking software, read from Log Analytics during an Arc run). Every write is a DELTA (`utils/inventoryDelta` `diffInventory` + `sameFields`, every field exact — no dead band) in one interactive transaction that also upserts the source's scrape stamp, the `serviceInventoryService` shape. The read side never merges sources: `getAssetSoftware` returns every source's rows plus `{source, scrapedAt, count}` per source in `SOFTWARE_SOURCES` order (agent → intune → arc), and the tab shows one at a time.

**Public API:** SoftwareSource, SOFTWARE_SOURCES, softwareScrapeKind, AssetSoftwareInput, softwareKey, storedSoftwareRow, persistAssetSoftware, clearAssetSoftware, sweepOrphanedSoftware, AssetSoftwareView, getAssetSoftware, AGENT_SOFTWARE_FRESH_MS, INTUNE_SOFTWARE_MAX_AGE_MS, IntuneSoftwareCandidate, planIntuneSoftwareFetch, intuneAppToInput, arcSoftwareToInput, syncIntuneSoftware, syncArcSoftware.

**Cross-service deps:** `prisma.assetSoftware` / `assetInventoryScrape` / `assetSource`, `retryOnDeadlock` (utils/dbRetry), `entraIdService.fetchIntuneDetectedApps` (Graph beta `$batch` of `/deviceManagement/managedDevices/{id}/detectedApps`), `azureArcService.fetchArcSoftware` (Log Analytics KQL over `ConfigurationData`).

**Used by:**
- `src/api/routes/agents.ts` — the `softwareInventory` sample-stream arm (`SoftwareSampleSchema`, max 20 000 rows, no min) → `ingestSoftwareInventory` → `persistAssetSoftware(assetId, "agent", rows)`. `GET /agents/config` ships `streams.software {enabled: true, intervalSec: 21600}` — a constant, like `streams.services`, and deliberately not folded into `computeConfigEtag` because it never changes.
- `src/api/routes/assets.ts` — `GET /assets/:id/software` (gate `assets:read`, thin → `getAssetSoftware`).
- `src/services/discovery/discoveryEngine.ts` — the Entra branch calls `syncIntuneSoftware` after `syncEntraDevices`, passing the run's device list, the Intune list read's outcome (`intuneRead`) and whether the run is scoped; the Azure Arc branch calls `syncArcSoftware` after `syncAzureTagRegistry`.
- `agent/internal/collectors/software*.go` — the agent-side producer (`SoftwareInventoryOnce`: HKLM Uninstall keys in both registry views on Windows, `dpkg-query` else `rpm` on Linux).
- `public/js/assets.js` — the asset **Software** tab (`_wireAssetSoftwareTab`), through `api.assets.software`.

**Invariants:**
- **A source never writes another source's rows.** Every query in the writers is scoped `where: { assetId, source }`; the key is unique per `(assetId, source, key)`, not per `(assetId, key)`, so the same program reported by the agent and by Intune is two rows.
- **An empty list is a delete-all for that source; a failed read passes nothing.** The agent never pushes a nil collector result; the Intune pass skips a device absent from `fetchIntuneDetectedApps`'s result (its sub-request failed), keeping its list AND its stamp so the next run retries it; the Arc pass clears machines with no snapshot ONLY when `failedWorkspaces === 0`.
- **Both integration passes never throw.** Failures are progress-log `error` lines at steps `discover.intune.software` / `discover.arc.software`; the run's device sync stands.
- **Intune read plan (`planIntuneSoftwareFetch`, pure):** an asset whose agent list is younger than `AGENT_SOFTWARE_FRESH_MS` (2 d) is skipped — the agent reads the host itself; a device whose stored `stamp` equals its current `lastSyncDateTime` and whose list is younger than `INTUNE_SOFTWARE_MAX_AGE_MS` (7 d) is skipped — it has not checked in, so its apps cannot have changed. A scoped run (Discover Now) forces the read, but the agent skip still applies. Reads in chunks of 200 devices, persists with concurrency 4.
- **Toggle off clears, not freezes.** `pullSoftware` off (or `enableIntune` off) → `clearAssetSoftware` over this integration's Intune assets, except on a scoped run; Arc `pullSoftware` off or no workspace IDs → clears this integration's Arc lists. The pass only runs at all when the Intune list read itself succeeded (`intuneRead === "ok"`).
- **The Arc pass is tenant-wide, so a scoped run skips it entirely.**
- **Orphans:** `sweepOrphanedSoftware(source)` (raw SQL) deletes intune / arc rows and stamps for assets that no longer carry an `AssetSource` of that `sourceKind` — run at the end of every full Intune / Arc pass. The FK cascade covers a deleted asset; this covers an asset that left the integration but still exists.
- Real FK to Asset with cascade — unlike `AssetService` / `AssetProcess`.

**When changing this:**
- Adding a field: the Prisma model + migration, `SoftwareSample` (Go transport) + the platform readers, `SoftwareSampleSchema` + `ingestSoftwareInventory` (agents.ts), `AssetSoftwareInput` + `storedSoftwareRow`, `SOFTWARE_FIELDS` + `pickSoftwareFields`, the two integration mappers (`intuneAppToInput` / `arcSoftwareToInput`) and the `getAssetSoftware` projection — in lockstep; bump `agent/VERSION`. **Miss `SOFTWARE_FIELDS` and the delta never sees the column change** (the `SERVICE_FIELDS` trap).
- Changing the key (what makes two rows "the same program") rewrites every stored list on the next scrape of each source — every row is a delete plus an insert, and `firstSeenAt` restarts.
- A fourth source: add it to `SoftwareSource` / `SOFTWARE_SOURCES` (its position is the UI preference), a scrape kind, the tab's source labels and empty-state copy in `public/js/assets.js`, and — if it is integration-fed — an orphan sweep keyed on its `AssetSource.sourceKind`.
- Scale: the Intune pass at 2000 devices is ten 200-device chunks, each one `$batch` round (20 per request, concurrency 4) plus four concurrent short transactions; `loadScrapes` reads stamps in 5000-id IN chunks. Keep per-device work out of the sequential path.

---

## services/agentInstallScripts.ts

**What it owns:** The curated catalog of Polaris Agent install-method VARIANTS (metadata only — id / osPlatform / label / description / isDefault) plus the OS-lock validator. One vetted variant per OS today (`linux-systemd`, `darwin-launchd`, `windows-service`). Script BODIES stay inline in `agentInstallService.ts` (version-coupled to the binary); this module owns the picker vocabulary + validation.

**Public API:** `AGENT_INSTALL_SCRIPTS`, `scriptsForOs`, `defaultScriptIdFor`, `installScriptMetaById`, `resolveInstallScriptId`, `AgentInstallScriptMeta`, `AgentOsPlatform`

**Cross-service deps:** `AppError` only (pure metadata + validation; no DB/IO).

**Used by:** `src/services/agentInstallService.ts` (`installerScript`/`uninstallerScript` switch on the resolved id; `runInstall`/`bulkInstallAgents` validate via `resolveInstallScriptId`), `src/api/routes/assets.ts` (per-asset + bulk install validation; `GET /assets/agent-install-scripts` serves the catalog), `public/js/assets.js` (deploy-modal picker).

**Invariants:**
- **OS-lock is here, server-side:** `resolveInstallScriptId(os, scriptId)` throws when a variant's `osPlatform` ≠ the target OS (or on unknown id). The UI filter is convenience only — a crafted API request still can't run a Windows script on Linux.
- Selection is a fixed enum of catalog ids validated server-side — never a free-text/operator-supplied script body. Curated ≠ operator-authored: adds NO RCE surface beyond what agent deploy already does (an operator with `assets:write` + valid creds already runs a root/LocalSystem installer).
- Exactly one `isDefault` variant per `osPlatform`. `scriptId` null/"" resolves to that default (pre-picker installs + discovery auto-deploy pass nothing).

**When changing this:**
- Adding a variant: add the catalog entry here AND a matching `case` in `agentInstallService.ts`'s `installerScript`/`uninstallerScript` (and, for Windows, the renderer template selection). A catalog id with no wired script throws at install time by design.
- New OS install scripts run as root/LocalSystem on remote hosts — treat as deployed code requiring real-host testing + human review before production.

---

## services/agentAutoDeployService.ts

**What it owns:** Discovers agent-less devices during integration sync and auto-kicks off installs per configured class settings. Bounded, paced, and idempotent — checks preconditions, infers platform/transport+credential, and fires installs.

**Public API:** `inferAgentPlatform`, `pickTransportAndCredential`, `checkAutoDeployPreconditions`, `runAutoDeployForClass`, `AgentOsPlatform`, `AgentTransport`, `AgentDeployClassConfig`, `DeployTarget`, `AutoDeployResult`

**Cross-service deps:** `credentialService.getCredential`, `agentInstallService.startInstall`, `certInfo.getServerCertFingerprint`, `logEvent`, polling-compatibility utils.

**Used by:** `src/services/discovery/discoveryEngine.ts` — discovery post-sync pass (calls `checkAutoDeployPreconditions` then `runAutoDeployForClass` per workstation/server class when the class's `agentDeploy` is enabled).

**Invariants:**
- Opt-in, default off (UI warns to test on a small OU first).
- Eligibility guarded by `ManagedAgent.assetId @unique` — an asset that already has any ManagedAgent row (pending/active/failed) is never re-kicked.
- Per-run kicks off at most `maxConcurrent` new installs (clamped low single digits) plus a hard RUN_CEILING backstop.
- Platform inferred from the asset OS string; fires fire-and-forget to `startInstall()` (no retry — failures are operator's to re-kick via manual reinstall).

**When changing this:**
- Adding transport/platform logic: validate in both `inferAgentPlatform` and `pickTransportAndCredential`.
- The idempotency guard (no existing ManagedAgent row) is non-negotiable — never re-kick an enrolled or in-flight asset.

---

## services/agentBuildService.ts

**What it owns:** In-app build pipeline that compiles the agent binaries (six platform/arch combos via `go build`) one build at a time, with a small FIFO queue, manifest.json publication, and old-version auto-prune. Stateful in-memory build map + single active-build mutex.

**Public API:** `startBuild`, `cancelBuild`, `getBuild`, `getCurrentBuild`, `getCurrentBuildAndQueue`, `goAvailable`, `getInventory`, `pruneOldAgentVersions`, `PLATFORMS`, `QUEUE_DEPTH`, `GO_MINIMUM`, `BuildPhase`, `BuildState`, `BuildStep`, `GoAvailability`, `BuildQueueFullError`, `GoUnavailableError`, `BuildAlreadyFinishedError`, `BuildNotFoundError`, `InventoryResult`, `PruneResult`

`GO_MINIMUM` is the single source of truth for the Go minor line the build requires — every operator-facing "install Go N+" string interpolates it, and `npm run check:versions` asserts it agrees with `agent/go.mod` and the install scripts (see `polaris-tech-lifecycle`). Bumping it alone is not enough; the pin has 12 declaration sites.

**Cross-service deps:** `agentInstallService.inferOwnServerUrl`, `version` (agent version + source dir), `certInfo.getServerCertHostnames`, `publicUrl` port helper, `prisma` (settings + auto-upgrade hook).

**Used by:** `src/api/routes/serverSettings.ts` (build/inventory/upgrade-all/prune endpoints), `src/jobs/autoBuildAgents.ts`.

**Invariants:**
- Single active build; concurrent requests queue FIFO up to `QUEUE_DEPTH` (then a `BuildQueueFullError` → 409).
- One build runs all six platform/arch combos serially (parallel `go build` thrashes the module cache); operator Cancel checks fire between platforms.
- Manifest version stamped from live source at start-of-run; auto-prune keeps last N versions (skips in-use + manifest-current) and fails closed if manifest reads fail.
- Optional post-build auto-upgrade is fire-and-forget, gated on a Setting.

**When changing this:**
- Go env (HOME/GOCACHE/GOMODCACHE) must stay in sync between module-resolve and build steps.
- Queue advance happens in the finally block — guard against deleted/cancelled entries.

---

## services/agentChannelService.ts

**What it owns:** In-memory `managedAgentId → WebSocket` registry for live agents: attach/detach lifecycle, heartbeat ping/pong, server-initiated probe-now requests, config-refresh frames, command-dispatch wake frames, AND the cross-process command-wake LISTENer.

**Public API:** `attach`, `detach`, `isAttached`, `sendProbeNow`, `refreshConfig`, `wakeCommands`, `startCommandWakeListener`, `liveSessionCount`, `shutdownAllSessions`, `ProbeNowResult`

**Cross-service deps:** `prisma` (managed-agent updates, plus the one asset read that NAMES the device), `logEvent`, `maintenanceScheduleService.releaseMaintenanceHold` (business rule 80), `pg` (dedicated LISTEN client), `dbConnections.getDirectDatabaseUrl`, `agentCommandWake.CMD_WAKE_CHANNEL`.

**Used by:** `src/api/routes/agentsWs.ts` (attach on authenticated WS upgrade), `src/api/routes/serverSettings.ts` + `src/services/monitoringService.ts` (`sendProbeNow` / `refreshConfig`), `src/app.ts` (`startCommandWakeListener` after the WS handler attaches, web/all role). `shutdownAllSessions` is exported but NOT wired into the SIGTERM hook — a restart ends the process with the sockets open and writes no `agent.disconnected`; the agents simply redial the successor.

**Invariants:**
- **`agent.connected` / `agent.disconnected` must NAME the asset.** An `asset` Event with no `resourceName` gives an event automation an empty subject (`utils/alertSubject.eventSubjectLabel` returns "" for one), so every alert about an agent dropping rendered a widget row and an email that could not say WHICH host — the one fact those alerts carry. `attach` resolves `hostname || ipAddress` once and parks it on the Session so `detach` can name the device without a database read on a path that runs when the socket is already dead, and so both events agree on the label. Every other `agent.*` Event that names an asset does the same (`agentInstallService`'s runners pass the row they hold; its `fail*` helpers use `assetLabel`).
- **A reattach is what ENDS an upgrade or reinstall hold** (business rule 80), not the installer returning: the WS teardown trails the service stop by up to a heartbeat interval, so a hold released when the script exited lets the lagging `agent.disconnected` through. `attach` releases `agent-upgrade` and `agent-reinstall` only — an `agent-uninstall` hold ends with the uninstall, since nothing is meant to come back from one. The release is best-effort: its failure must not break the attach, and the hold's expiry covers it.
- Attach replaces any existing session for the same agentId (idempotent).
- **A socket's close / error / heartbeat detach is scoped to ITS session** (`detach(id, reason, session)`), never to the agent id alone. A replaced socket's close event lands after the closing handshake — after the replacement took the map slot — and an id-keyed detach from it tore down the live replacement and wrote a warning `agent.disconnected`, paging "Agent disconnected" for a connection that was fine. It fired after every in-app update: the restart's reconnect herd queues every agent's argon2 bearer verify, the agent's 10s handshake timeout runs out, it redials, and both dials complete. An unscoped `detach(id, reason)` (revoke, operator action) still ends whatever is attached.
- **An upgrade the agent abandoned is never attached.** `agentsWs.ts` watches the raw socket for `close` / `end` while `verifyBearer` runs and drops the upgrade when `upgradeAbandoned` says the agent hung up; `attach` itself refuses a socket whose `readyState` is not OPEN, BEFORE it can displace the live session, and writes no event for it.
- Heartbeat ping interval + pong-timeout force-close and detach a silent agent.
- Probe-now is request-id correlated with a timeout reject; detach clears pending probes and is a no-op when not attached.
- Frame envelope is a JSON `{ type, id, payload }` — a wire protocol shared with the Go agent. Frame types: `hello` / `refresh-config` / `probe-now-request` / `commands-pending`.
- `wakeCommands` is a no-op when the agent isn't attached to THIS process — the NOTIFY reaches whichever process holds the session; the ≤20s command poll is the floor regardless.
- The command-wake LISTENer uses the DIRECT database URL (session-pinned; PgBouncer transaction pooling breaks LISTEN) and reconnects with a fixed backoff on error.

**When changing this:**
- The frame format is the agent wire protocol — any change breaks deployed agents. A new frame type must be added to the Go agent's `wsLoop` switch in lockstep (unknown types are ignored there, so new server→agent frames are backward-safe).
- Pending-probe map must be cleaned up in teardown to avoid leaks; `shutdownAllSessions` also stops the wake LISTENer.

---

## services/agentInstallService.ts

**What it owns:** Fire-and-forget remote install / uninstall / upgrade of the Polaris Agent over SSH (Linux/macOS/Windows) or WinRM (Windows): resolves credentials, mints an enrollment token, uploads the binary + a rendered `agent.conf`, runs platform scripts, and drives the ManagedAgent lifecycle (pending → uploading → enrolling → active | failed).

**Public API:** `startInstall`, `startUninstall`, `startUpgrade`, `upgradeAllOutdated`, `bulkInstallAgents`, `BulkInstallInput`, `BulkInstallResult`, `resolveUpgradeCredential`, `UPGRADEABLE_INSTALL_STATUSES`, `canUpgradeFromStatus`, `renderAgentConf`, `inferOwnServerUrl`, `inferOwnServerUrlSync`, `AGENT_SERVER_URL_SETTING_KEY`, `StartInstallInput`, `StartUninstallInput`, `StartUpgradeInput`, `ResolvedUpgradeCredential`, `UpgradeAllResult`

**Cross-service deps:** `credentialService.getCredential`, `windowsSshOnboardingService.getOnboardingState` (the managed deployment credential the upgrade falls back to), `agentTokenService.mintEnrollmentToken`, `agentBuildService.getInventory`, `certInfo.getServerCertHostnames`, `maintenanceScheduleService` (`openMaintenanceHold` / `releaseMaintenanceHold` — business rule 80), `publicUrl` port helper, `utils/agentUnit` (`linuxServiceBlock`/`normalizePrivilegeTier`/`AgentPrivilegeTier` — the privilege-tier → systemd unit mapping; re-exported from here), `logEvent`, `prisma`, WinRM helper.

**Used by:** `src/api/routes/assets.ts` (per-asset install / reinstall / upgrade / uninstall; `bulkInstallAgents` behind `POST /assets/bulk-agent-install`), `src/api/routes/serverSettings.ts` (upgrade-all), `src/services/agentAutoDeployService.ts` (`startInstall`), `src/services/agentBuildService.ts` (auto-upgrade hook).

**Invariants:**
- **An operation that stops a RUNNING agent holds the asset in maintenance first** (business rule 80). Stopping the service drops the WebSocket, which writes `agent.disconnected` at warning level, which is what the seeded baseline automation fires on — so upgrade, reinstall and uninstall take a `MaintenanceHold` in their SYNCHRONOUS half, before the runner is scheduled, and a hold taken after the installer has already stopped the service has missed the event. A first install and `/retry` take NO hold (`StartInstallInput.holdKind` is set by the reinstall route alone): there is no agent to disconnect, and holding would silence a host still telling the truth. The hold is best-effort in both directions — `takeAgentHold` swallows its errors, because a hold is an improvement to an upgrade and never a precondition for one.
- **Failure releases the hold; success does not.** Every `fail*` helper drops it — an agent down because its upgrade failed is a real problem and the alert is the point — while the success paths leave it to `agentChannelService.attach` (the agent reattaching) or to the hold's own expiry, because the WS teardown trails the service stop by up to a heartbeat interval. The exception is `agent.uninstalled`: nothing is coming back to reattach, so completing the uninstall ends that hold.
- Fire-and-forget: kicks off an async runner, returns immediately.
- **The bulk deploy RETRIES a failed install; it skips every other agent state** (2026-09-24). `bulkInstallAgents` resets a `installStatus="failed"` row in place — the same reset as `POST /assets/:id/agent/retry`, writing the same `agent.install_retry` Event with `details.bulk: true` — and counts it in `BulkInstallResult.retried` as well as `kicked`. The retry KEEPS the row's `osPlatform` + `arch` (the host has not changed; a wrong guess is corrected by reinstall / force-remove, not by re-inferring from `Asset.os`) and TAKES the batch's policy: credential + transport re-picked by `pickTransportAndCredential` for the row's platform, `installScriptId`, `privilegeTier`, `installedBy`. When the batch's credentials do not cover that platform, the row's own `installCredentialId` is reused if it still resolves (what the per-asset Retry does), else the asset is skipped with the reason. No maintenance hold (rule 80 — nothing running to disconnect). In-flight, `active`, `upgrade_failed`, `uninstall_failed` and `revoked` rows stay skipped as "agent already installed (status=…)": each has work on the host or an agent to preserve. Pinned by `tests/unit/agentInstallBulkRetry.test.ts`.
- Platform/arch drives binary selection (inferred from `Asset.os`, arch defaults amd64); SSH needs username + (password OR privateKey), WinRM needs username + password.
- Uninstall (and force-remove) hard-deletes the ManagedAgent row on success, clears all polling columns (incl. `processesPolling`) so source defaults resume, AND tears the host off the Application Map — clears `mappedProcesses`/`mappedServices` + `deleteMany` its `AssetProcessConnection` rows in the same transaction (nothing collects them once the agent is gone, and pinned child nodes render from the pins regardless of connection rows). Upgrade replaces the binary only — `agent.conf` (bearer + pin) is untouched so the agent keeps its identity.
- Server-URL resolution order: Setting override → `POLARIS_PUBLIC_URL` → cert hostnames → fallback → localhost.
- **Upgrade resolves its own credential (business rule 49).** `resolveUpgradeCredential` tries the operator override, then `installCredentialId`, then the Polaris-managed SSH deployment credential — an id that no longer resolves counts as absent, because the FK is `ON DELETE SET NULL` and pre-`20260514010000` installs never had one. **Transport follows the credential's `type`, never `row.installTransport`** (the `20260609000000` backfill wrote `winrm` onto every existing Windows row; the managed credential is key-only). An ADOPTED credential + transport is written back onto the row **only after the upgrade succeeds**; an operator override is never adopted. Install / reinstall / uninstall are unchanged — they still require a credential on file.
- **Linux privilege tier** (`ManagedAgent.privilegeTier`, Linux-only) selects the systemd `[Service]` block via `agentUnit.linuxServiceBlock`: `unprivileged` (default) or `ptrace` (+CAP_SYS_PTRACE +CAP_DAC_READ_SEARCH for Application Map attribution — the pair, not SYS_PTRACE alone; see the privilege-model entry). Full root is retired — never emitted for new installs/reinstalls; a legacy `root` row downgrades on reinstall. Reinstall conversion logic lives in the `POST /assets/:id/agent/reinstall` route (`assets.ts`), not here.

**When changing this:**
- `agent.conf` templating must stay in sync with the Go agent (pin set + enrollment-token format).
- Concurrent upgrades are pool-bounded so a fleet upgrade doesn't overwhelm hosts; `testOverrides` allow fake SSH for unit tests.
- A row `upgradeAllOutdated` cannot upgrade writes an `agent.upgrade_skipped` Event against the asset: `startUpgrade` throws before it touches `installStatus`, so such a row leaves no trace of its own and is re-skipped by every later fan-out. Never let that path go silent again.
- **`upgradeAllOutdated` does not attempt a host that monitoring reads as DOWN** (2026-09-30): an eligible row whose asset is `monitored === true && monitorStatus === "down"` is left untouched (still `active` / `upgrade_failed`, still lagging, so the next fan-out or the per-asset Upgrade button — `startUpgrade`, deliberately NOT gated — picks it up), counted in `UpgradeAllResult.deferredDown`, and gets one info-level `agent.upgrade_deferred` Event (batched via `logEventsBatch`, best-effort). Its own action, never `agent.upgrade_skipped`: an automation keyed on "skipped" means a stranded host and must not page about a host that is merely off. An UNMONITORED asset is still attempted — its `monitorStatus` is stale. The reason is the pool: a dead host's SSH/WinRM connect sits out its timeout holding one of the 4 slots every reachable host queues behind. Applies to both callers (`POST /server-settings/agents/upgrade-all` and the `agent.autoUpgradeOnNewBuild` hook); the Server Settings toast reports the deferred count.
- The privilege-tier → unit mapping is pure in `utils/agentUnit.ts` (unit-tested) — edit systemd directives there, and remember `linuxServiceBlock` only ever emits unprivileged/ptrace (no root branch).

---

## services/agentTokenService.ts

**What it owns:** Mints/verifies the two managed-agent token types — enrollment (one-shot, short TTL, consumed at `/enroll`) and bearer (long-lived, revoked on uninstall) — stored as argon2id hashes + an indexed prefix, with the bearer bound to a single assetId.

**Public API:** `mintEnrollmentToken`, `consumeEnrollmentToken`, `shouldEnableMonitoringOnEnroll`, `verifyBearer`, `revokeBearer`, `ConsumedEnrollment`, `VerifiedAgent`

**Cross-service deps:** `prisma` (managedAgent), password hash/verify util.

**Used by:** `src/api/middleware/auth.ts` (`verifyBearer` for agent endpoints), `src/api/routes/agents.ts` (`consumeEnrollmentToken` at `/enroll`), `src/api/routes/agentsWs.ts` (`verifyBearer` on WS upgrade), `src/api/routes/assets.ts` (`revokeBearer` on uninstall), `src/services/agentInstallService.ts` (`mintEnrollmentToken`).

**Invariants:**
- Token format `polaris_<random>` with an indexed prefix for O(1) candidate lookup; full secret stored only as an argon2id hash.
- Enrollment has a short TTL and is idempotent to re-mint (Reinstall overwrites a stale token); `consumeEnrollmentToken` atomically clears enrollment fields, mints the bearer, flips installStatus→active, stamps polling columns, and auto-enables `monitored` (never on decommissioned/disabled assets — business rule 10; no-op on already-monitored so a Reinstall doesn't re-log).
- `verifyBearer` self-heals a stuck "enrolling" status (an agent reusing an existing bearer skips `/enroll`); `revokeBearer` is idempotent.
- Bearer is bound to `assetId @unique` as cross-asset-reuse defense; dual-pin enroll validates against the canonical fingerprint while additional pins stage in `additionalServerCertFingerprints`.

**When changing this:**
- Enrollment expiry is load-bearing for install-retry safety (operator re-mints via Reinstall) — don't make it permanent.

---

## services/agentCommandService.ts

**What it owns:** The agent command queue — the `AgentCommand` table + its lifecycle. Today the only queued action is `run_script` (agent-side automation script runs). Process/service start/stop/restart control was REMOVED (Satellite-posture change) — this module keeps only the shared fetch/report plumbing.

**Public API:** `fetchPendingCommands(managedAgentId)` (agent poll; marks sent atomically + flips linked run_script `AutomationScriptRun`s pending→running); `recordCommandResult(managedAgentId, commandId, success, error, resultState, output?)` (agent report → completes the command + the linked run + audit); type `AgentCommandView`.

**Cross-service deps:** `eventLogService.logEvent` (`automation.script.run`, generic `agent.command.*.result` fallback); `prisma.agentCommand`, `prisma.automationScriptRun`.

**Used by:** `src/api/routes/agents.ts` (bearer `GET /agents/commands` + `POST /agents/command-result`). Rows are ENQUEUED by `automationScriptService.requestScriptRun` (not this service).

**Invariants:**
- `fetchPendingCommands` flips pending→sent atomically so a slow agent (or a WS-wake + poll racing) doesn't double-execute the same command.
- `recordCommandResult` verifies the command belongs to the reporting agent (managedAgentId match).
- The agent refuses any non-`run_script` action; the server enqueues only `run_script`. A stale/foreign non-run_script row reaching `recordCommandResult` is audited generically, never as control.

**When changing this:**
- Near-real-time dispatch is via a `commands-pending` WS frame (`agentCommandWake.publishCommandWake` → `agentChannelService.wakeCommands`); the ≤20s `/commands` poll remains the source of truth + guaranteed floor. Don't make the WS frame authoritative.
- A new action would need: the enqueue path, the agent executor arm (`pollAndRunCommands` in `agent/cmd/polaris-agent/main.go`), and the result branch here — in lockstep. Process/service control is intentionally NOT here anymore.

---

## services/agentCommandWake.ts

**What it owns:** The cross-process "wake this agent" signal for near-real-time command dispatch. When a command is enqueued (from any process/role), this emits a Postgres NOTIFY so the process holding the agent's WS session pushes a `commands-pending` frame instead of the agent waiting out its ≤20s command poll.

**Public API:** `publishCommandWake(managedAgentId)` (best-effort `SELECT pg_notify(CMD_WAKE_CHANNEL, id)` via prisma — never throws); `CMD_WAKE_CHANNEL` constant (`polaris_agent_cmd_wake`).

**Cross-service deps:** `prisma.$executeRaw` (pg_notify); `logger`. Deliberately lightweight (no WS/pg-Client imports) so the enqueue side (`automationScriptService`, which runs in the monitor/all role) can import it without pulling the WS server.

**Used by:** `src/services/automationScriptService.ts` (`requestScriptRun` fires it after creating the agent `run_script` command). The LISTEN side is `agentChannelService.startCommandWakeListener` (web/all role) → `wakeCommands`.

**Invariants:**
- **Best-effort only** — a failed/missed NOTIFY just means the agent picks the command up on its next `/commands` poll (the guaranteed floor). Never let a wake failure block or fail the enqueue.
- NOTIFY works through PgBouncer; the paired LISTEN (agentChannelService) needs a session-pinned DIRECT connection — keep the two halves' transport assumptions aligned.
- Channel name is lowercase (unquoted-identifier fold) — `publishCommandWake` and the `LISTEN` must use the same literal.

**When changing this:** if another enqueue path (beyond script runs) starts creating `AgentCommand` rows, call `publishCommandWake` there too, or that path silently falls back to the poll latency.

**Also owns `publishConfigRefresh` + `CFG_REFRESH_CHANNEL` (`polaris_agent_cfg_refresh`)** — the sibling "this agent's config changed, refetch it" signal. Payload is a comma-joined list of managedAgentIds (chunked at 150 to stay under pg_notify's 8000-byte cap). `agentChannelService`'s wake listener LISTENs on both channels and dispatches by `msg.channel` to `refreshConfig`. Same best-effort contract: the heartbeat's `configEtag` is the guaranteed floor.

---

## services/pathCheckService.ts

**What it owns:** Path checks — the `PathCheck` definition (HTTP / HTTPS / TCP / ICMP + optional traceroute), its validation, audited CRUD, and the materialized `PathCheckSource` membership (check × agent host, plus each pair's latest result — and, when `runOnServer`, ONE row with `assetId` NULL for the Polaris server itself). Also the agent-facing definition shape and its ETag fold, which the server source reuses verbatim (`serverCheckDefinitions`).

**Public API:** `CHECK_KINDS`, `BODY_MATCH_MODES`, `MIN/MAX_INTERVAL_SEC`, `MIN/MAX_TIMEOUT_MS`, `MAX_ENABLED_CHECKS` (50), `MAX_CHECKS_PER_AGENT` (20), `MIN_AGENT_PATH_CHECK_VERSION` (0.21.0), `DEFAULT_TRACEROUTE`, `normalizeTraceroute`, `splitHostPort`, `targetHostOf`, `assertTargetHostAllowed`, `normalizeCheckInput`, `definitionSha256`, `toAgentCheckDef`, `listChecks`, `getCheck`, `createCheck`, `updateCheck`, `setCheckEnabled`, `deleteCheck`, `reconcilePathCheckSources`, `agentOnline`, `previewSources`, `listCheckResults`, `getAssetChecks`, `agentConfigChecks`, `pathCheckEtagFold`, `getServerCheck`, `listServerTraceroutes`, `serverCheckDefinitions`, `testCheck`, `TEST_RUNS_PER_MINUTE`, `_resetTestRunLimiter`, `SERVER_SOURCE_PERMISSION_MESSAGE`, `CREDENTIAL_USE_MESSAGE`, `loadServerCheckAuth`, `normalizeHostHeader`, `requiredAgentVersion`, `HTTP_METHODS`, `MAX_REDIRECTS`, `MIN_AGENT_REQUEST_OPTIONS_VERSION` (0.23.0), `PATH_CHECK_AUTH_MODES`, type `ServerCheckDef`, and the re-exported `POLARIS_SERVER_SUBJECT` / `POLARIS_SERVER_LABEL`; types `PathCheckInput`, `NormalizedCheck`, `AgentCheckDef`, `CheckHttpConfig`, `CheckTracerouteConfig`, `ReconcileResult`, `CheckWriteOpts`.

**Cross-service deps:** `prisma`, `eventLogService.logEvent`, `agentCommandWake.publishConfigRefresh`, `notificationEngine.loadScopeAssetIds` (the scope resolver the engine itself uses — so a check's Sources can never disagree with an automation's Devices step), `notificationTypes.scopeIsUnconstrained`, `utils/netGuard.isBlockedOutboundHost`, `utils/httpCheck` (`parseStatusSpec`, `agentRegexProblem`), `utils/version.versionAtLeast`, `agentInstallService.AGENT_SERVER_URL_SETTING_KEY`.

**Used by:** `src/api/routes/pathChecks.ts` (CRUD / preview / results / filter-schema / the three server-source reads), `src/jobs/reconcilePathCheckSources.ts` (5-minute full reconcile), `src/jobs/runServerPathChecks.ts` (`serverCheckDefinitions`, every 15 s).

**Invariants:**
- **A check carries no threshold.** The SLA — what latency is a breach, how many failures page someone — lives in the automation that watches the `path*` metrics, the split business rule 36 makes for "down". Never add a threshold column here.
- **Membership ignores `monitored`.** Whether a result may ALERT is business rule 37's question, asked by the engine at fire time. `loadScopeAssetIds` is called WITHOUT `monitoredOnly`.
- **`{}` / an empty tree means "nothing chosen"** here (a pins-only check), NOT "any device" — that legacy reading belongs to event automations (business rule 46). `{allAssets:true}` short-circuits to every active agent without loading the fleet.
- **Target refusal is at save, on the LITERAL host**: loopback / link-local / unspecified / multicast (netGuard), IPv6 literals (v1 is IPv4-only), URL userinfo, and Polaris's own names/addresses. The agent refuses the same ranges again AFTER resolution. Rule 33's netGuard exemption (the vendor HTTP check aims at the device's own address) does NOT carry over.
- **Body-match regex must be RE2-compatible** (`agentRegexProblem`) — the agent is Go; a JS-only pattern would save and then fail every run on every agent.
- **`definitionSha256` covers exactly what the agent receives** (`agentDefCore`), key-sorted at every level. A description/name-only edit must not change it; any field the agent reads must. It is what both config ETags fold.
- **Reconcile is set-based**: one active-agent query, one source query, then `createMany` / `deleteMany` / `updateMany` in one `$transaction` — never a query per host. Agents whose membership changed (or every member, when the definition changed) are nudged via `publishConfigRefresh`.
- **Disabled checks keep their sources** (the fleet view shows their last results); `agentConfigChecks` filters on `enabled`.
- **`MAX_CHECKS_PER_AGENT` is enforced in `agentConfigChecks`** (oldest checks win, deterministically) and REPORTED by `reportOverCap` as a `path_check.agent_over_cap` Event when a host newly exceeds it — never a silent truncation. The in-memory set dedupes it across the 5-minute ticks.
- **`agentConfigChecks` returns `[]` below `MIN_AGENT_PATH_CHECK_VERSION`.**
- **A target/kind edit clears `lastPathHash` / `lastOk`** on every source so the first new traceroute is a baseline, not a "path changed" Event about a different destination.
- **The server source is one row, `assetId` NULL, following `runOnServer` and nothing else.** `reconcilePathCheckSources` creates it, deletes duplicates beyond the first and deletes it when the flag goes off; it nudges no agent. A partial unique index (`path_check_sources_server_key`, migration only — Prisma cannot say it) holds the one-per-check rule. Every agent-shaped read keeps working because an agent's rows always carry an asset id: `reportOverCap` groups `assetId: { not: null }`, `listCheckResults` puts the server row FIRST with `server: true`, `notificationDimensionService`'s checkId pairs read `assetId in ids`, which never matches NULL.
- **`testCheck` (the wizard's Test button) runs a DRAFT once from the server and stores nothing but a `path_check.tested` Event.** It is the same gate as aiming the server (a test IS a request from there), validates through `normalizeCheckInput` with a stand-in name and `runOnServer: true` so the save-time refusals still apply, forces `keepBodyExcerpt` on and the traceroute off, and is rate-limited per actor (`TEST_RUNS_PER_MINUTE`, in-memory, per process — a split install's web role is the only one serving it).
- **Request options (2026-09-30): GET or HEAD only, a Host override, followed redirects, a negated body match.** Nothing that writes is ever sent (the Zod enum and `normalizeCheckInput` both refuse PUT/POST/DELETE; HEAD with a body match is refused). The options and `negate` are written to `http` and to the agent definition ONLY when not the default, so every pre-existing check keeps its `definitionSha256` and its agents' baselines. A definition using any of them needs agent `MIN_AGENT_REQUEST_OPTIONS_VERSION` (0.23.0): `agentConfigChecks` does not ship it to an older agent (it would ignore the fields and run a different check under the same name) and `listCheckResults` reports `supported: false` / `requiredAgentVersion`.
- **Authentication makes a check SERVER-ONLY.** `credentialId` (an `http` Credential, bearer / basic / digest — `form` and every other type refused) forces `runOnServer`, and a check with one may carry no agent scope or pins (400); reconcile gives it no agent member whatever its stored scope, and `agentConfigChecks` filters `credentialId: null` besides — the secret never leaves the server. Choosing or re-aiming one is a USE of the secret (`assertMayUseCredential`): any `credentials` rung from `read` up may use ANY credential — the operator's decision (2026-09-30), deliberately looser than rule 43's test-by-id (own rows at write), since the caller already holds pathChecks:write + networkScan:write; changing the credential stays on the Credentials routes. Re-checked when the credential or the traffic changes (not on a rename); `none` is 403. `loadServerCheckAuth` opens it per run (Prisma opens sealed values on read). The server revision folds the credential id, so re-pointing it re-baselines. `credentialService.deleteCredential` refuses (409, naming the checks) while a check uses it; the FK is RESTRICT behind that.
- **Aiming the SERVER is chained on `networkScan:write`** (`CheckWriteOpts.mayRunOnServer`, answered by the route from the caller's matrix; 403 `SERVER_SOURCE_PERMISSION_MESSAGE`). Required on create with `runOnServer`, on an update that turns it on, RE-AIMS it (the agent definition hash compared with the name blanked — a rename is not re-aiming) or re-enables it, and on `setCheckEnabled(true)` of a server-run check. Never required to turn the server off, rename, edit Sources or delete. The reason is business rule 85's server-source section: the server probes from its own network position, and an HTTP excerpt is a read primitive from there.
- Delete cascades sources only; samples and traceroutes age out on retention (a row DELETE in a compressed chunk decompresses it).

**Wired into GET /agents/config and the heartbeat:** `agents.ts` ships `pathChecks: await agentConfigChecks(assetId, agentVersion)` in the payload (strong ETag covers it) AND folds `pathCheckEtagFold(...)` into `computeConfigEtag` as `conn`. **Both halves or neither** — the heartbeat etag is the only thing that makes a running agent refetch.

**When changing this:** a field the agent reads → `agentDefCore` + `transport.PathCheckDef` in `agent/internal/transport/client.go` + an `agent/VERSION` bump, in lockstep — AND `services/pathCheckServerRunner.ts`, which runs the same definition on the server. A new kind → `CHECK_KINDS`, `targetHostOf`, the route's Zod enum, the agent's `ValidateCheckDef` + runner, the server runner, and the wizard. A new membership signal → the 5-minute job catches it; a write path that changes membership should reconcile inline.

---

## services/pathCheckIngestService.ts

**What it owns:** The server half of the agent's two path-check streams (`POST /agents/samples`, stream `pathCheck` and `pathCheckTraceroute`): authorization of each sample against the pushing host's sources, the body-excerpt policy, buffered sample writes, the source's latest-result columns, hop resolution, and path-change Events. The Polaris server's own runs (`jobs/runServerPathChecks.ts`) come through the SAME two functions under the reserved subject `POLARIS_SERVER_SUBJECT` ("polaris-server"), which it owns with `POLARIS_SERVER_LABEL`.

**Public API:** `ingestPathCheckSamples`, `ingestPathCheckTraceroutes`, `resolveHopContexts`, `excerptToKeep`, `hopIp`, `pathHashOf`, `sampleTime`, `PATH_CHANGE_EVENT_FLOOR_MS`, `POLARIS_SERVER_SUBJECT`, `POLARIS_SERVER_LABEL`; types `IngestResult`, `PathCheckSampleInput`, `PathCheckTracerouteInput`, `StoredHop`, `HopContext`.

**Cross-service deps:** `prisma` (`pathCheckSource`, `assetPathCheckTraceroute`, `asset`, one `$queryRaw`), `sampleWriteBuffer.enqueuePathCheckSamples`, `eventLogService.logEvent`, `metrics` (`recordPathCheckSamples`, `recordPathCheckPathChange`), `utils/cidr.isValidIpAddress`, `utils/httpCheck.MAX_EXCERPT_CHARS`.

**Used by:** `src/api/routes/agents.ts` (`POST /samples` — the two path-check arms return `{accepted, rejected}` of their own), `src/jobs/runServerPathChecks.ts` (the server subject).

**Invariants:**
- **The subject is the pushing agent's own asset.** Nothing in the body names a host; `assetId` comes from `req.managedAgent`.
- **`POLARIS_SERVER_SUBJECT` reads the `assetId`-NULL source row** (`sourcesFor`), and its samples / traceroutes are written with that string in the FK-less `assetId` column. It is never a UUID, so no agent's bearer can reach it and no asset can collide with it; the alert engine reads these tables only for real asset ids, so server rows never alert. Its `path_check.path_changed` Event names the CHECK (`resourceType: "path-check"`, `details.source: "server"`) — the server is no asset, so no device-filtered automation matches it.
- **A sample for a check this host is not a source of is REJECTED**, counted in `rejected` and in `polaris_agent_path_check_samples_total{outcome="rejected"}` — never stored.
- **The excerpt policy is enforced HERE, not trusted from the wire** (`excerptToKeep`): kept only on a failed run or when the check keeps excerpts, re-cut to `MAX_EXCERPT_CHARS`. Hash + byte count are always stored.
- **Nothing here touches `monitorStatus` / `consecutiveFailures` / `lastMonitorAt` / the responseTime stream.** A path-check result describes a path from the host, not the host.
- **Every row is stamped `cadence: "fast"`** — the rollup SQL filters on it.
- **Hop resolution is ONE query per push** (`resolveHopContexts`: unnest + three LATERAL joins — primary `Asset.ipAddress`, then `AssetAssociatedIp` with the port name, then the most specific non-deprecated subnet via `cidr >>= inet`). Decommissioned assets skipped; `AssetIpHistory` deliberately not read (no `ip` index, and a live hop is not "who held it last month"). Hops are decorated at WRITE time, so a trace shows what Polaris knew when it was taken.
- **`pathHashOf` excludes RTTs and trailing silent hops** — the same route at a different latency, or timing out two TTLs later, is not a change.
- **`path_check.path_changed` is written only against a non-null previous hash** (the first trace, and the first after a target edit, is a baseline) and at most once per `PATH_CHANGE_EVENT_FLOOR_MS` (10 min) per (host, check) — ECMP flap is recorded in the rows, not in the Event table. It names the asset (`resourceType: "asset"`, `resourceName`) so an event automation's device filter applies to the HOST (business rule 46).
- A late-arriving older push never overwrites a newer latest result (`lastSampleAt` guard).

**When changing this:** a new sample field → `PathCheckSampleSchema` in agents.ts + `PathCheckSampleRow` (sampleWriteBuffer) + the Prisma model/migration + the Go `transport.PathCheckSample`, in lockstep, and `pathCheckServerRunner` must fill it too; a rollup column also needs `sampleRollupService` + `sampleHistoryService.readPathCheckHistory`.

---

## services/pathCheckServerRunner.ts

**What it owns:** The probe half of a path check's **Polaris server** source (`PathCheck.runOnServer`): one run of one definition FROM THE SERVER — timed DNS preferring IPv4, the SSRF refusal after resolution (plus the server's own addresses), HTTP(S) / TCP / ICMP, and the optional traceroute — returning a sample and trace in the agent's wire shape. Also the scheduling rules the job applies (due-ness, traceroute mode, state pruning), as pure helpers.

**Public API:** `runServerCheck` (optional 4th arg `RunCapture`, filled by a TEST run only: headers via `captureHeaders`, the 64 KB body judged, `httpVersion`, `finalUrl`; optional 5th `auth: HttpAuthConfig`), `sameOrigin`, `captureHeaders`, `MAX_CAPTURED_HEADERS`, `pathBodyMatches`, `excerptOf`, `truncateError`, `ownAddresses`, `refusedAddress`, `serverCheckDue`, `serverTraceMode`, `pruneServerStates`, `DUE_SLACK_MS`, `TRACEROUTE_BUDGET_MS`, `_deps` (test seams: `lookup`, `ownAddresses`, `refusedAddress`); types `TraceMode`, `ServerCheckState`.

**Cross-service deps:** `utils/netGuard.isBlockedOutboundHost`, `utils/cidr.isValidIpAddress`, `utils/digestAuth` (`parseDigestChallenge`, `buildDigestAuthorization`, `newCnonce`), `utils/httpCheck` (`parseStatusSpec`, `statusInRanges`, `MAX_BODY_BYTES`, `MAX_EXCERPT_CHARS`), `utils/icmpPing.burstPingHost`, `utils/serverTraceroute.traceFromServer`, `utils/version.getAppVersion`; types from `pathCheckService` / `pathCheckIngestService`. No Prisma — results are written by the job through the ingest service.

**Used by:** `src/jobs/runServerPathChecks.ts`, `pathCheckService.testCheck`.

**Invariants:**
- **It mirrors the agent's probe** (`agent/internal/collectors/path_check*.go`) field for field, so a server row and an agent row mean the same thing on one chart: one GET, no proxy (`agent: false`), no redirects, no auth; status judged before body; the first 64 KB read and fingerprinted; a 4 KB excerpt on a failed run or when the check keeps them; TLS facts reported even when verification FAILED (`rejectUnauthorized: false`, then `tls.authorized` checked by hand); TCP = one connect; ICMP = one echo; the agent's error strings where it has one (`dns lookup failed:`, `refused:`, `ipv6 not supported in v1`, `connect failed:`, `HTTP 302 (expected 2xx)`).
- **Redirects are followed by hand, hop by hop** (≤ 5), each new host resolved and refused-checked like the first, never to a non-http(s) URL or one with userinfo. **Credentials and the Host override go ONLY to the target's own origin** (`sameOrigin`): a redirect that leaves it gets neither, or following one would hand the secret to whatever host the target names. Digest is the `utils/digestAuth` handshake — unauthenticated first, then exactly ONE answer, never a loop. `bodyMatched` means "the body expectation held" (for a negated match, the text was absent) — the agent reports it the same way.
- **It refuses the server's OWN addresses after resolution**, beyond the agent's ranges — a name resolving to this host is a loopback probe of Polaris itself. The save path refuses the literal (`assertTargetHostAllowed`); this catches the DNS name.
- **ICMP rides the system `ping` and the traceroute the system tracer** — the service holds no CAP_NET_RAW. A `ping` that could not run reads `icmp unsupported on this server …`, never as the target failing (rule 71); a missing tracer is a trace with no hops and a note.
- **Never throws**; every problem is the sample's `error`.
- **Scheduling mirrors `cmd/polaris-agent/path_check.go`:** due when the interval (less `DUE_SLACK_MS`) has elapsed, always on the first run under a revision; traceroute on the baseline, every Nth run, and on the run after a PASS if it fails; a changed revision re-baselines.

**When changing this:** a probe rule changed on the agent → change it here in the same commit (and the reverse). Authentication is the one deliberate asymmetry: it exists ONLY here. A new sample field → fill it here as well as in the Go collector.

---
