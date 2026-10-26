# Services — Polaris Agent install, build, channel, commands; the firmware repository; reboots

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol. The three firmware services sit here because `firmwareUpgradeService` copies `agentInstallService.startUpgrade`'s shape — synchronous refusals, a row, a kickoff Event, a rule-80 hold, a `setImmediate` runner on the web process. The six reboot services (business rule 115 — `rebootService`, `rebootTransports`, `rebootScheduleService`, `holdRecoveryWait`, `rebootScheduleCancel`, `agentRebootPermissionService`) sit after them because they copy the firmware pair's shape.

## services/firmwareRepositoryService.ts

**What it owns:** The firmware repository (Server Settings → Repository; business rule 87): the manufacturer › device type (`switch` / `access_point` / `firewall` — the last since 2026-10-06) › model TREE, the IMAGES filed under a model node (two per node — primary + backup — with the rotation an upload performs), the login BINDINGS at the three scopes (a device-admin `form` login; on a Firewall scope also a `restapi` token credential or `source: "integration-token"`), and the per-asset CANDIDATE lookup. Bytes on disk under `FIRMWARE_DIR`; identity from the image header, never the model string.

**Public API:** `FIRMWARE_ASSET_TYPES`, `FIRMWARE_MAX_IMAGE_BYTES_BY_TYPE` (switch / AP 100 MiB — the FortiSwitch endpoint's own ceiling — firewall 300 MiB; `registerUploadedImage` enforces the per-type cap), `FIRMWARE_MAX_IMAGE_BYTES` (the largest — what multer accepts at all), `FIRMWARE_BINDING_SOURCES` (`credential` | `integration-token`), `isFirmwareAssetType`, `getFirmwareTree`, `listImages`, `getImage`, `registerUploadedImage`, `discardIncomingUpload`, `setPrimaryImage`, `deleteImage`, `purgeModelImages`, `resolveImagePath`, `ensureFirmwareDirs`, `listBindings`, `upsertBinding`, `deleteBinding`, `resolveFirmwareCredential`, `findUpgradeCandidates`, `listRecentRuns`, `listAssetsForNode` + `FIRMWARE_NODE_ASSET_LIMIT` (a tree node's device list — its `where` MUST stay the tree groupBy's: switch/AP, not decommissioned, stored manufacturer, null-or-blank model for the "" node, or the list disagrees with the count the operator clicked; a count + a capped tight-select findMany + one primaries read, compared in memory); the row / node / candidate types; `firmwareBindingCredentialIds` (assetId → bound stored credential, one bindings read folded in memory — for the credential usage count).

**Cross-service deps:** `prisma` (asset groupBy + a tight-select serial scan, firmwareImage, firmwareCredentialBinding, firmwareUpgradeRun.count); `utils/firmwareVersion` (header/filename parse, compare, `platformFromSerial`); `utils/manufacturerNormalize.normalizeManufacturer`; `utils/paths` (`FIRMWARE_DIR`, `FIRMWARE_INCOMING_DIR`); `credentialService.getCredential({ revealSecrets: true })` (the ONE place a device password or bound API token is read); `utils/httpCheck.isDeviceLoginCredential`; `utils/fortinetRestCredential.restApiCredentialAuth` (a `restapi` binding's token / verifySsl / port); `prisma.integration` (an `integration-token` binding's token — `integrationTokenFor` reads the discovering integration's config: a standalone `fortigate` integration's `apiToken` / `verifySsl` / `port`, a `fortimanager`'s `fortigateApiToken` / `fortigateVerifySsl`, so one binding covers both transports — FMG ↔ FortiGate parity); `firmwareEngines/index` (`engineFor`, `engineKindForType`); `assetTypeService.listAssetTypes` (labels); `eventLogService.logEvent`.

**Used by:**
- `src/api/routes/firmware.ts` — every repository route; `discardIncomingUpload` when the upload's text fields fail validation.
- `src/services/credentialService.ts` — `firmwareBindingCredentialIds` (Stored Credentials usage count / slide-in; keep its tier order in step with `resolveFirmwareCredential`).
- `src/services/firmwareUpgradeService.ts` — `findUpgradeCandidates`, `resolveFirmwareCredential`, `resolveImagePath`, `getImage`.
- `public/js/server-settings-firmware.js` — the tab, through the routes.

**Invariants:**
- **Matching is by platform, filing is by model.** An asset is offered an image only when `image.platform === platformFromSerial(asset.serialNumber)` (rule 87); the model node decides nothing about eligibility. A filename-only image has `platform: null` and is never offered.
- **Each PLATFORM under a node holds one primary and one backup** (rule 87, amended 2026-10-23), and the DATABASE enforces it: two partial unique indexes on `(manufacturer, assetType, model, COALESCE(platform, ''))`, migration `20261023000000`. A node can hold several platforms: a standalone FortiGate integration files every gate under the literal model `FortiGate`. `registerUploadedImage` rotates only the uploaded image's platform pair, in ONE transaction, and refuses whole (409) when a queued/running run references the backup it would remove. `setPrimaryImage` swaps only with its platform's primary and steps through the transient `swapping` role, because the partial indexes are checked per statement. `deleteImage` on a primary promotes ITS platform's backup, so no platform has a backup alone. Every one of these queries must carry `platform: r.platform` (or `identity.platform`); one that drops it brings back the cross-platform demotion that hid a 61F image behind a 601E upload (2026-10-22).
- **Only a PRIMARY is offered unasked.** `findUpgradeCandidates` returns the strictly-newer primary for the platform (the asset's own model node preferred, else newest) and names the SAME node's backup only when it too is strictly newer. Zero queries when `engineFor` is null.
- **Resolution is model › type › manufacturer, most specific LIVE row that can sign in to THIS device wins.** SKIPPED, never a shadow (the rule-49 posture): a binding whose credential was deleted (`credentialId` null on a `credential` source) or is no longer a `form` login / openable `restapi` token; a token kind (`restapi` credential or `integration-token`) on anything but a firewall (`bindingFitsType` — the tree's effective-binding fold applies the same test); an `integration-token` whose asset has no `discoveredByIntegrationId`, whose integration is gone or holds no FortiOS token. `getFirmwareTree` cannot know the per-asset integration, so it shows an integration-token binding as effective even where some gates will fall through. Secrets are revealed only with `{ revealSecrets: true }`, which only `startFirmwareUpgrade` asks for; a token comes back as `bearerToken` (+ `verifyTls`, `port`) with empty username/password.
- **The binding vocabulary is guarded by the database**: `source` CHECK, and `source = 'credential' OR (assetType = 'firewall' AND credentialId IS NULL)` (migration `20261006010000_firmware_fortigate`); `upsertBinding` answers the same refusals as 400s first (`restapi` or integration-token off a Firewall scope).
- **The same bytes are filed once** (`sha256 @unique` → 409 naming the node); the temp file is removed on every failure path; the final rename is same-filesystem (the incoming dir sits under FIRMWARE_DIR).
- **An upload path is proven inside FIRMWARE_INCOMING_DIR before ANY file operation on it** — read, rename or delete (private `incomingPath()`, resolve + prefix check). A path that fails is refused (400) and left on disk: it is not ours to remove. `discardIncomingUpload` is the only way the route removes an upload it refused before registering, and it goes through the same check (CodeQL js/path-injection, 2026-09-28).
- Never writes Asset. Never opens a socket to a device.

**When changing this:**
- Adding a device type (firewall was the last, 2026-10-06): `FIRMWARE_ASSET_TYPES`, `FIRMWARE_MAX_IMAGE_BYTES_BY_TYPE` (and nginx's firmware `client_max_body_size` if the max grows — `deploy/nginx/polaris.conf` + `.template` + `tests/unit/nginxRenderer.test.ts`), the two CHECK constraints (last widened by migration `20261006010000_firmware_fortigate`), `engineKindForType`, `utils/firmwareVersion.ts` family + serial test, the tree's type order and the tab's copy, `public/js/assets.js → _assetFirmwareEligible` and the mobile `FW_ELIGIBLE`, the wiki's device lists. Note `firmwareVsPrimary` reads `FIRMWARE_ASSET_TYPES`, so the automation field starts reading the new type at once; the baseline automation's seeded scope does not follow.
- Changing the two-image cap: the partial unique indexes AND `registerUploadedImage`'s rotation AND `setPrimaryImage` / `deleteImage`'s pair lookups AND the tab's copy ("Each platform keeps two images", the per-platform upload confirm) move together; `tests/unit/firmwareImageRotation.test.ts` pins every transition, mixed platforms included.
- Any new offer path must go through `findUpgradeCandidates` — the platform + strictly-newer gate lives there once.
- Scale: the tree is two `groupBy`s + one small `findMany` + one tight-select serial scan (only when the tab opens); never add a per-asset query.

## services/firmwareUpgradeService.ts

**What it owns:** One asset, one flash (business rule 87): what the asset card is told (`getUpgradeAvailability`), the SYNCHRONOUS gates and the kickoff (`startFirmwareUpgrade`), the runner that drives an engine and keeps the run row current, the reads, and the boot sweep for runs a restart orphaned. Copies `agentInstallService.startUpgrade`'s shape.

**Public API:** `getUpgradeAvailability`, `startFirmwareUpgrade` (`groupMemberId?` — a GROUP member's start, rule 122: links the member's `runId` and advances the group when the run ends; WITHOUT it, a device whose group is running is refused 409), `assessGroupCandidate` (the group planner's non-throwing booking gates against the PRIMARY image: `{ ok, image, fromVersion, warnings }` or a drop `kind` + reason), `healthBlockers` and `FIRMWARE_ASSET_SELECT` / `FirmwareAssetRow` (exported for the group executor's live health check), `checkSchedulableUpgrade` (what a BOOKING takes when it is made — business rule 93: the image gates + a bound login, returning `{ approved, fromVersion, warnings }` where `warnings` are today's `healthBlockers`, NOT a refusal), `getRun`, `listRunsForAsset`, `failOrphanedFirmwareRuns`; `FirmwareRunConflictError` (the 409 subclass for a refusal that clears on its own — a live run on the device, on a connection-path ancestor/descendant or MCLAG peer, and the P2002 race; a click answers it like any 409, a booking waits on it); `UpgradeAvailability` / `UpgradeAvailabilityState` / `RunSummary` / `StartUpgradeInput` (`scheduleId?` — the booking this start fires). The private `approvedImageFor` (engine → HA → address → platform → candidates → the approved image) is the ONE copy of the image gates, shared by a start and by a booking; the private `haClusterOf` (a `firewall` whose `fortinetTopology` carries `haMode` / `haRole`) is why an HA member is `unsupported` on the card and a 400 at start AND at booking.

**Cross-service deps:** `firmwareRepositoryService` (candidates, credential, image path); `firmwareEngines/index` (`engineFor`, `engineByKind`) and `firmwareEngines/types` (`DEFAULT_FIRMWARE_TIMEOUTS`); `maintenanceScheduleService.openMaintenanceHold` / `releaseMaintenanceHold` (kind `firmware-upgrade`, rule 80); `holdRecoveryWait.holdUntilMonitorAnswers` (the post-reboot recovery wait, shared with rebootService); `connectionPathService.resolveConnectionPath` + `prisma.assetMclagPeer` (the topology gate); `utils/assetInvariants.UNMONITORABLE_STATUSES` (rule 10); `eventLogService.logEvent`; a dynamic import of `discovery/assetDiscoveryScope.resolveDiscoveryScopeForAsset` + `discovery/discoveryEngine.triggerDiscovery` (the scoped rediscover on success); `node:fs/promises.stat`.

**Used by:**
- `src/api/routes/firmware.ts` — `firmwareAssetRouter` (`GET /`, `POST /`, `GET /runs`) and `GET /server-settings/firmware/runs/:id`.
- `src/jobs/failOrphanedFirmwareRuns.ts` — the boot sweep.
- Reader of its rows, not a caller: `src/services/operationsCalendarService.ts` reads `FirmwareUpgradeRun` by `startedAt` range for the Events page's Calendar tab.
- `src/services/firmwareScheduleService.ts` — `checkSchedulableUpgrade` at booking, `startFirmwareUpgrade({ scheduleId })` when a booking fires, `FirmwareRunConflictError` to tell "wait" from "refused" (rule 93). The reverse edge is a LAZY import: the runner's `.finally` and `failOrphanedFirmwareRuns` call `notifyScheduledRunFinished` through `notifyScheduledRun`, like `requestRediscover`, because the schedule service imports this one.
- `public/js/assets.js` — the Firmware card, through the routes (`_startFirmwarePoll` polls the run).

**Invariants:**
- **The gates are synchronous and ordered** (engine → not an HA secondary or a non-a-p cluster (`haRefusal`, rule 129) → address → platform → candidates → the REQUIRED approved `imageId` must be the offered primary or the eligible backup → health → login → one live run per asset, none on a connection-path ancestor/descendant or MCLAG peer → the image file exists), each an `AppError` answered to the click; the partial unique index on `(assetId) WHERE status IN (queued, running)` answers the race (P2002 → 409). `tests/unit/firmwareUpgradeGates.test.ts` pins the order. The three "a related flash is live" refusals (one live run, topology, P2002) are `FirmwareRunConflictError` and NOTHING else is — a booking retries on that class and settles `refused` on every other, so widening it turns a permanent refusal into a two-hour retry loop.
- **A booked start is the same start** (rule 93): `scheduleId` changes the Event's wording ("Scheduled firmware upgrade started", `details.scheduleId`), links `FirmwareUpgradeSchedule.runId` BEFORE the runner is scheduled (so a crash between the two still lets the boot sweep find the booking), and after the runner settles — success or failure, after the terminal row and Event — the booking's recipients are emailed. It takes no gate a click does not.
- **`maintenance` is allowed; unmonitored is allowed** (the hold no-ops, as it does for an agent upgrade). Down / warning / recovering / dependency-suppressed / unmonitorable are refused.
- **The hold outlives the engine on a run that reached the reboot** (`holdUntilMonitorAnswers`, now in `services/holdRecoveryWait.ts`, shared with the reboot runner — business rule 115): after an `upgraded` or `unverified` outcome the run sits in stage `recovering` and polls `assetMonitorSample.findFirst({success:true, timestamp > engine end})` every `recoveryPollMs` until one lands or `recoveryWaitMs` (10 min) passes, first pushing the hold's `expiresAt` past the cap. The engine proves the device over its WEB UI, which on a FortiAP answered minutes before the SNMP agent monitoring polls; releasing on "engine done" let the next polls miss outside the window. A `failed` run skips the wait (an incident); no hold row = unmonitored = nothing to wait for. The two timeouts live on `FirmwareEngineTimeouts` so tests shrink them through `overrides`, but no ENGINE reads them.
- **The hold is taken BEFORE the runner is scheduled** and released in the runner's `finally` BEFORE the terminal Event (the `failUpgrade` ordering, rule 80a), by `failOrphanedFirmwareRuns` at boot, and by the reconcile's 45-minute expiry as the backstop.
- **Never writes `Asset.osVersion`.** Projection owns it (asset-source-projection); the run records `verifiedVersion` and requests a scoped rediscover, and `getUpgradeAvailability` reports `pending-discovery` until the record catches up so the button does not re-offer a flash that happened. On `up-to-date` it also reads the primaries (`loadPrimaryFirmwareImages`, one small findMany) and returns `vsPrimary` / `primaryVersion` through `firmwareVsPrimary` / `primaryImageForAsset` — the automation field's comparison, so the phone's "Up to date" and a `firmwareVsPrimary` automation cannot disagree.
- **The plaintext password — or a FortiGate's bearer token — exists only inside the runner's engine context** (`ctx.credential`, `ctx.bearerToken`, with the token's `verifyTls` / `port`) — never in a log line, the run `log`, or an Event's `details` (only `credentialId` / name / scope / `source`).
- **`ASSET_SELECT` carries `discoveredByIntegrationId` + `fortinetTopology`** — the first is what an `integration-token` binding resolves through, the second the HA gate. Both are cheap per-asset columns on a one-asset read; never widen this select into a fleet read.
- **The server owns the card's vocabulary**: `state` and `reason` are what the card draws; a new state is added here, not inferred from a sentence client-side.
- Runs execute on the web process (the image is on its disk; pg-boss is optional). A restart mid-flash orphans the run; the sweep names it rather than hides it. Row writes are throttled to one per 5 s; nothing here touches the monitor ticks.

**When changing this:**
- A new blocker: add it to `healthBlockers` (so availability and start agree), to the gates test, and to the wiki's list.
- A new engine: `firmwareEngines/index.ts` `engineFor` + `engineKindForType`, the run row's `engine` vocabulary (`fortiswitch-https` / `fortiap-https` / `fortigate-https`), the file map, and the docs' "Fortinet only" sentence. An engine that signs in differently (the FortiGate's bearer token) widens `FirmwareEngineContext` in `firmwareEngines/types.ts` and the `ctx` built in `runUpgrade`.
- Changing what an HA cluster may do (rule 129): `haMemberOf` / `haRefusal` / `clusterPeersOf` / `clusterInfo` here, AND the engine's own preflight and `verifyCluster` (`fortigateHttps.ts → gateHaMode`, `gateClusterState`, `gateHaHistory`), AND `assessGroupCandidate`'s `ha-member` refusal (groups still take no cluster), AND the cards (`assetFirmwarePanelHTML`'s `cluster-member` state and the approval dialog's cluster warning; the phone's `fwSlotHtml`), AND rules 87 + 129 and the wiki. A cluster run holds EVERY member asset and passes `ctx.cluster` + `HA_CLUSTER_TIMEOUT_OVERRIDES`. The secondary's card polls the PRIMARY's run through the primary's asset, because `getRunForAsset` 404s another asset's run.
- A state blocker shared with reboots: `rebootService` refuses while a firmware run is queued / running on the asset (state `blocked`); a new firmware run status that means "in flight" must be added to that read too.
- A new terminal outcome: `finish`, the Event table (`firmware.upgrade_*`), the card's `_fwRunResultHTML`, and `dropHold` ordering — and `notifyScheduledRunFinished`'s status → outcome mapping plus `utils/firmwareResultEmailTemplate.ts` (a booked run's email).
- A new image gate goes in `approvedImageFor`, so a booking takes it at booking AND at firing; a new device-STATE gate goes after it in `startFirmwareUpgrade` only (and, if it is a health blocker, `healthBlockers` so the booking modal warns about it).
- If a queue ever replaces `setImmediate`, the image must travel with the job (it lives on the web host's disk) and the boot sweep's "this process was driving it" premise changes.

## services/firmwareScheduleService.ts

**What it owns:** A firmware flash BOOKED for later (business rule 93) and the email that says how it went. Booking (`createSchedule` / `updateSchedule` / `cancelSchedule`) from the asset's Firmware card: the image approved BY NAME as for a flash now (rule 87), a time (`assertSchedulableTime`: ≥ `MIN_LEAD_MS` 1 min ahead, ≤ `MAX_LEAD_MS` ~a year), and recipients (`normalizeRecipients`: lower-cased, de-duplicated, 1…`MAX_RECIPIENTS` 20; the modal pre-fills `defaultRecipientsFor` = the booker's profile email). Firing (`runDueSchedules`, the job's tick): due `pending` rows oldest first, up to 50, ONE AT A TIME — first seen more than `LATE_GRACE_MS` (15 min) late → `missed`; waiting on a conflict more than `CONFLICT_WAIT_MS` (2 h) → `refused`; else CLAIM (`pending` → `started`, conditional) and hand to `startFirmwareUpgrade({ scheduleId })` — success stays `started`, a `FirmwareRunConflictError` goes back to `pending` with `error` = what it waits on, any other error → `refused`. Notifying (`notifyScheduledRunFinished` for a run; the private `settle` for refused / missed): claim `notifiedAt`, resolve the channel, render per recipient.

**Public API:** `normalizeRecipients(list, { max?, allowEmpty? })` (cap defaults to `MAX_RECIPIENTS`; `allowEmpty` for a Cc/Bcc list), `AUTOMATION_MAX_RECIPIENTS`, `assertSchedulableTime` (both pure, throw 400), `defaultRecipientsFor`, `getPendingSchedule`, `listSchedulesForAsset`, `createSchedule`, `updateSchedule`, `cancelSchedule`, `runDueSchedules` (+ `DueRunResult`), `notifyScheduledRunFinished`; `LATE_GRACE_MS`, `CONFLICT_WAIT_MS`, `MIN_LEAD_MS`, `MAX_LEAD_MS`, `MAX_RECIPIENTS`; `ScheduleSummary`, `CreateScheduleInput`, `UpdateScheduleInput`.

**Cross-service deps:** `prisma` (firmwareUpgradeSchedule, firmwareUpgradeRun, asset, user); `firmwareUpgradeService.{checkSchedulableUpgrade, startFirmwareUpgrade, FirmwareRunConflictError}`; `quietTimeSummaryService.resolveSummaryChannel(null, [])` (with no policy and no held rows it falls through to the oldest enabled email channel); `notificationDeliveryService.{applyBrandLetterhead, sendEmailThroughChannel}`; `userTimezoneService.{resolveTimeZone, serverTimeZone}`; `utils/firmwareResultEmailTemplate.renderFirmwareResultEmail`; `eventLogService.logEvent`.

**Used by:**
- `src/api/routes/firmware.ts` — `firmwareAssetRouter`: `GET /` folds in `getPendingSchedule` as `schedule`; `GET /schedules`, `GET /schedules/defaults`, `POST /schedules`, `PATCH /schedules/:scheduleId`, `DELETE /schedules/:scheduleId`.
- `src/jobs/startScheduledFirmwareUpgrades.ts` — `runDueSchedules` every 60 s (web/all role).
- Reader of its rows, not a caller: `src/services/operationsCalendarService.ts` reads `FirmwareUpgradeSchedule` by `scheduledFor` range for the Events page's Calendar tab — a new booking status needs a colour there (`public/js/ops-calendar.js → statusClass()`).
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
- `assertNotInGroup` (rule 122): `createSchedule` / `updateSchedule` refuse a device in a pending / running group upgrade — a booking beside the group would race its ordering. Booking a group CANCELS this service's pending rows itself (in `firmwareGroupService`'s transaction), so a new booking status must be considered there too.

---

## services/firmwareGroupService.ts

**What it owns:** GROUP firmware upgrades (business rule 122) — one controlling FortiGate and the FortiSwitches / FortiAPs behind it, booked from the Assets bulk bar and flashed in dependency order (the fortinet-updater ordering). Three halves. **Placement** (`resolveGroupSources`, the red Upgrade button's read; shared with `planGroup`): one asset read, one tight infra read (every firewall / switch — id, hostname, serial, type, stamps, integration), `buildInfraParentIndex` once, the parent walk ONE `asset_dependency_parents` query per level (override wins over computed, Fortinet-stamp fallback), gate = `controllerGateIdOf` else the first firewall up the tree; a device whose integration differs from its gate's is `unresolved`. **Planning / booking** (`planGroup`, `createGroupSchedule`, `cancelGroupSchedule`, `recordGroupCredentialUse`): `assessGroupCandidate` per device (PRIMARY image only; drops with a kind + reason), `depthOf` / `ancestorsOf` / MCLAG peers as the snapshot, the superseded single-device bookings cancelled in the same transaction as the create (only with `cancelIndividual`). **Execution** (`advanceGroup`, `advanceGroupForRun`, `runDueGroupSchedules`): record ended runs, skip parents whose subtree ended badly (`subtree`), take health live (`healthBlockers` → `skipped` / `health`, next device in the same pass, ancestors NOT held), re-assess the image (already current / changed primary → recorded, never flashed), `startFirmwareUpgrade({ groupMemberId })`, conflict wait (`waiting` → `timeout` after `CONFLICT_WAIT_MS`), finish + one summary email.

**Public API:** `resolveGroupSources`, `planGroup`, `createGroupSchedule`, `recordGroupCredentialUse`, `cancelGroupSchedule`, `advanceGroup`, `advanceGroupForRun`, `runDueGroupSchedules`, `getGroupSchedule`, `listGroupSchedules`, `activeGroupForAsset`; pure `ancestorsOf`, `depthOf`, `pickNext`, `subtreeState`, `conflicts`; `MAX_GROUP_SIZE` (500), `MAX_CONCURRENCY` (10), `TERMINAL_MEMBER_STATES`; types `GroupSource`, `SourcesResult`, `GroupPlan`, `PlannedMember`, `DroppedMember`, `ExecMember`, `GroupDetail`, `GroupMemberDetail`, `GroupListRow`, `CreateGroupInput`, `DueGroupResult`.

**Cross-service deps:** `prisma` (firmwareGroupSchedule, firmwareGroupMember, firmwareUpgradeSchedule, firmwareUpgradeRun, asset, assetDependencyParent, assetMclagPeer, integration, user); `firmwareUpgradeService.{FIRMWARE_ASSET_SELECT, assessGroupCandidate, healthBlockers, startFirmwareUpgrade, FirmwareRunConflictError, recordFirmwareCredentialUse}`; `firmwareScheduleService.{CONFLICT_WAIT_MS, LATE_GRACE_MS, assertSchedulableTime, normalizeRecipients}`; `utils/fortinetParentKey.{buildInfraParentIndex, controllerGateIdOf, readParentSwitchStamp, resolveInfraParentAsset}`; `quietTimeSummaryService.resolveSummaryChannel`; `notificationDeliveryService.{applyBrandLetterhead, sendEmailThroughChannel}`; `userTimezoneService`; `utils/firmwareGroupResultEmailTemplate`; `eventLogService.logEvent`.

**Used by:**
- `src/api/routes/firmware.ts` — `firmwareGroupRouter` (`/assets/firmware-groups`: sources, preview, book, list, read, cancel) and `firmwareAssetRouter`'s `GET /` (`activeGroupForAsset` as `group`).
- `src/jobs/startScheduledFirmwareUpgrades.ts` — `runDueGroupSchedules` every 60 s after `runDueSchedules`.
- `src/services/firmwareUpgradeService.ts` — `advanceGroupForRun`, lazily, from the runner's `.finally` when the run had a `groupMemberId`.
- Reader of its rows, not a caller: `src/services/operationsCalendarService.ts` (`groupItem`, one Calendar item on the gate); `firmwareScheduleService.assertNotInGroup` and `startFirmwareUpgrade`'s group guard query `firmwareGroupMember` directly.
- `public/js/assets-firmware-group.js` — the bulk bar's Upgrade button (grey / red / normal), the explanation and booking dialogs, the group detail modal; `public/js/assets.js` — the Firmware card's group note.

**Invariants:**
- **One gate per group, one group per gate.** Placement never matches a hostname against a FortiManager device name (the parent-key convention); the DB partial unique backs the 409.
- **A parent only after clean children; a failure is local; health never holds anything back.** `subtreeState` treats `failed`, `unverified` and every skip but `health` as blocking; `upgraded`, `already-current`, `dropped` and health skips as clean.
- **Approved by name.** A member flashes only the image stored at booking; a different primary at start drops it.
- **State lives in the DB; passes are idempotent.** Every pass re-reads members and runs; `advancing` guards one pass per group in this process, and a call during a pass queues one more pass. Starts go through `startFirmwareUpgrade`, so every rule-87 gate, the hold and the Events still apply.
- **One summary email** — `notifiedAt` claimed conditionally first; per-member runs send none (they carry no `scheduleId`).

**When changing this:**
- A new member state or skip kind: the migration CHECKs, `TERMINAL_MEMBER_STATES`, `endedBad`, the email template's sections and counts, `STATE_LOOK` / `SKIP_WORD` in `assets-firmware-group.js`, rule 122 and the wiki.
- Running anywhere but the web role breaks the `setImmediate` premise, as for single-device bookings.
- Scale: placement is O(levels) queries plus one infra read; a pass reads one group's members once and starts ≤ `concurrency` runs; the tick reads only `running` groups (and stopped ones still waiting to email).

---

## services/rebootService.ts

**What it owns:** Reboot one asset, now (business rule 115) — the ORCHESTRATION half: what may reboot and through what (the plan), who may sign it (the authority), the synchronous gates, the `RebootRun` row, the `device-reboot` hold, the Events, and the proof the device really cycled. The protocol half is `rebootTransports.ts`. Copies `firmwareUpgradeService`'s shape (sync gates → run row → Event → hold → runner on `setImmediate`, no queue).

**Public API:** `getRebootAvailability` (`state` ∈ unsupported / no-address / no-credential / ha / blocked / running / agent-not-active / agent-disabled / agent-incapable / agent-too-old / agent-offline / available — the server owns every word the slide-over draws), `checkSchedulableReboot` (what a BOOKING takes: the plan, with today's state blockers returned as `warnings`; an `agent-offline` host may be booked), `startReboot` (`StartRebootInput`, `scheduleId?`, `note?` — rule 115(d)), `getRebootRunForAsset`, `listRebootRunsForAsset`, `failOrphanedRebootRuns`, `integrationRebootGrant` (does an integration's `config.allowReboot` cover this device), `haMembershipOf` (pure — `fortinetTopology` haMode / haRole), `RebootRunConflictError` (the 409 a booking waits on), `MIN_AGENT_REBOOT_VERSION` ("0.26.0"), `DEFAULT_REBOOT_TIMEOUTS` (`agentAckMs` 150 s, `downWaitMs` 5 min, `upWaitMs` 15 min, `recoveryWaitMs` 10 min), types `RebootMethod` / `RebootAvailability` / `RebootAvailabilityState` / `RebootRunSummary` / `RebootPlan` / `RebootTimeouts`.

**Cross-service deps:** `rebootTransports` (`gateOps` through `_rebootTransportSeams`, `RebootSendError`); `credentialService.{getCredential, credentialAllowsReboot}`; `firmwareRepositoryService.resolveFirmwareCredential` (the gate's login binding, tried first); `reservationPushService.buildTransportForIntegration` (the integration token: FMG proxy / FMG direct / standalone); `utils/fortinetParentKey` (`parentAssetWhereOr`, `buildInfraParentIndex`, `resolveInfraParentAsset`, `readControllerStamp`, `readFirewallDeviceName`) to find the controlling gate; `utils/fortinetRestCredential.restApiCredentialAuth`; `maintenanceScheduleService.{openMaintenanceHold, releaseMaintenanceHold}` (kind `device-reboot`, rule 80); `holdRecoveryWait.holdUntilMonitorAnswers` (with `rebootSince` = the run's `startedAt`, rule 115(a)); `rebootScheduleCancel.cancelPendingRebootAfterReboot` (cause `manual`, rule 115(b)); `agentCommandWake.publishCommandWake` (agent path); `rebootSettingsService.{resolveRebootNote, normalizeRebootNote}` (the reason, rule 115(d)); `utils/assetInvariants.UNMONITORABLE_STATUSES` (rule 10); `utils/version.versionAtLeast`; `eventLogService.logEvent`; `node:net` (the SSH-port down-then-up probe). Lazy import of `rebootScheduleService.notifyScheduledRebootFinished` (the schedule service imports this one).

**Used by:**
- `src/api/routes/reboot.ts` — `GET /`, `POST /`, `GET /runs`, `GET /runs/:runId`.
- `src/services/rebootScheduleService.ts` — `checkSchedulableReboot` at booking, `startReboot({ scheduleId })` when a booking fires, `RebootRunConflictError` to tell "wait" from "refused".
- Reader of its rows, not a caller: `src/services/operationsCalendarService.ts` reads `RebootRun` by `startedAt` range for the Events page's Calendar tab — a new run status needs a colour there (`public/js/ops-calendar.js → statusClass()`).
- `src/jobs/failOrphanedRebootRuns.ts` — the boot sweep.
- `public/js/assets.js` — the slide-over header's Reboot button and agent card Reboots row, through the routes (`_startRebootPoll` polls the run).

**Invariants:**
- **The plan.** A FortiGate reboots itself — refused when it is an HA member (`haMembershipOf` at the click, the gate's own `system/ha` again in the run's preflight; rebooting one member fails the cluster over, which this does not orchestrate). A FortiSwitch / FortiAP with a controller stamp is restarted THROUGH the controlling gate (resolved via `utils/fortinetParentKey`, never by matching `controllerFortigate` against `Asset.hostname`; the restart API is addressed by the child's switch-id / wtp name, and the gate is addressed by its `controllerFortigate` device NAME through FMG); the gate's HA state does not matter. A switch / AP with no controller is rebooted over its own SSH CLI. An agent host gets `AgentCommand{action:"reboot"}`.
- **The authority — nothing else reboots anything.** In order: (1) a stored credential with `config.allowReboot` — the firmware repository's login binding for the gate first, then the gate's own per-stream credential columns ranked restapi > http form > ssh — sent to the GATE's own address; (2) the discovering integration's API token when that integration's `config.allowReboot` is on (`integrationRebootGrant`); (3) for an agent host, `ManagedAgent.rebootEnabled` AND `rebootCapable === true` AND agent ≥ 0.26.0 AND seen within 10 min. The first that applies wins; `RebootRun.authority` / `credentialId` record it and every Event names it.
- **Gates are synchronous**, answered to the click: plan (400 for `ha` / `unsupported`, else 409) → state blockers (rule-10 status, or a firmware run queued / running on the asset) → one active reboot per asset (`RebootRunConflictError`; the partial unique answers the race, P2002 → the same 409).
- **The run** preflights (the device's serial must match `Asset.serialNumber`; a FortiGate must be standalone LIVE), reads the boot time (FortiOS `web-ui/state` `utc_last_reboot`; agent `bootTime`) into `bootTimeBefore`, sends, then watches for PROOF: boot time advanced / the controller showed the child drop and rejoin (or `join_time` advanced) / the SSH port went down then up / the agent reported a newer `bootTime` / `Asset.lastRebootAt` moved past the start → `succeeded`. Went down and never came back → `failed`. Never seen down and no proof → `unverified`, never `succeeded`.
- **The agent command is withdrawn** (`pending` → `failed`) when the agent has not picked it up within `agentAckMs`, so a reboot cannot fire hours later when an agent returns. The agent acknowledges BEFORE it reboots; `agentCommandService.recordCommandResult` writes nothing for `reboot` — this run writes the Events.
- **The hold**: `device-reboot` (20 min), taken in `startReboot` before the runner is scheduled — never at booking — best-effort; held after proof until monitoring has RECORDED the reboot (`holdUntilMonitorAnswers(…, rebootSince)`: `Asset.lastRebootAt` past the run's start, or monitoring answered and `lastUptimeSec` is null; capped at `recoveryWaitMs`) so the `device.reboot` Event lands inside the window and the "Device recently rebooted" automation stays quiet (rule 115(a)); released BEFORE the terminal Event (rule 80a ordering), by `failOrphanedRebootRuns` at boot, and by the reconcile's expiry as the backstop. An agent's reattach does NOT release it — the run owns the window.
- **The reason (rule 115(d))** is stored on the run (`RebootRun.note`), named in `asset.reboot_started` (message "— reason: …" and `details.note`) and returned on `RebootRunSummary.note`. A reboot-now passes `resolveRebootNote` AFTER the plan / blocker / one-active-run gates and BEFORE the run row — so a blank one is a 400 while `rebootConfig.requireNote` is on and nothing was sent; a booking firing (`scheduleId`) carries its booking's note through `normalizeRebootNote` only, never re-judged — a booking made before the switch went on still runs.
- **A reboot-now that SUCCEEDS cancels the asset's pending booking** (`cancelPendingRebootAfterReboot`, cause `manual`, rule 115(b)); a booking's own run does not (it is `started`, not `pending`), and a failed reboot-now leaves the booking in place.
- **Events:** `asset.reboot_started` (info), `asset.reboot_succeeded` (info), `asset.reboot_unverified` / `asset.reboot_failed` (warning). A secret exists only inside `linkFor` → the transport; never in the run `log` or Event `details` (only `credentialId` / `authority` / `viaAssetId`).
- Runs execute on the web process (`setImmediate`); a restart mid-run orphans it and the boot sweep names it. Row writes throttled to one per 5 s; nothing here touches the monitor ticks. One asset per call — no fleet reads.

**When changing this:**
- A new device kind: the plan (`planFor`), the `method` vocabulary (run row comment + the domain model), a `GateOps` arm in `rebootTransports.ts`, its proof, the slide-over's state text, rule 115 and the wiki.
- A new authority: the ordered list above, `RebootRun.authority` wording, the Event, and rule 115 — the opt-in is the security boundary.
- Lifting the HA refusal: `haMembershipOf` AND the live `system/ha` preflight, together.
- A new terminal status: the migration's status CHECK, the Event table, `notifyScheduledRebootFinished`'s mapping, `utils/rebootResultEmailTemplate.ts`, and the slide-over's run rendering.
- Pinned by `tests/unit/rebootService.test.ts` and `tests/unit/rebootOptIn.test.ts`.

## services/rebootTransports.ts

**What it owns:** The PROTOCOL half of a reboot (business rule 115) — no Prisma, no Events, no holds. A `GateLink` in, one gate's operations out (`gateOps(link)` → `GateOps`): reboot the gate, restart a managed switch, restart a managed AP, read the gate's status / boot time and the managed switch / AP tables (`ManagedSwitchState` / `ManagedApState`).

**Public API:** `gateOps`, `runFortiCli`, `assertCliToken`, `RebootSendError`, types `GateLink` / `GateOps` / `SendResult` / `ManagedSwitchState` / `ManagedApState`, constants `REBOOT_PATH` (`/api/v2/monitor/system/os/reboot`, body `{event_log_message}`), `SWITCH_RESTART_PATH` (`/api/v2/monitor/switch-controller/managed-switch/restart`, `{mkey: switch-id}`), `AP_RESTART_PATH` (`/api/v2/monitor/wifi/managed_ap/restart`, `{wtpname}`); `_rebootTransportSeams` (the test seam rebootService calls through).

**Cross-service deps:** `fortigateService.fgRequest` (kind `token` — rule 96 pacing); `fortimanagerService.fmgProxyRest` (kind `fmg-proxy`); `firmwareEngines/deviceHttp.DeviceHttpClient` + `firmwareEngines/fortigateHttps.gateLogin` (kind `login`) and `firmwareEngines/types.DEFAULT_FIRMWARE_TIMEOUTS`; `utils/remoteExec.withSshClient` (kind `ssh`); `utils/fortiosEnvelope.readSystemStatus`.

**Used by:** `src/services/rebootService.ts` only.

**Invariants:**
- **Four link kinds**: `token` (an integration's or a restapi credential's bearer), `login` (a device admin form login), `fmg-proxy` (through FortiManager), `ssh` (FortiOS CLI over an interactive shell: `execute reboot`, `execute switch-controller switch-action restart swtp <id>`, `execute wireless-controller reset-wtp <serial>`; `runFortiCli` answers the `(y/n)` prompt and pages `--More--`).
- **A refusal and a dropped connection are different results**: `RebootSendError` = the device said no (the run fails, nothing was rebooted); `{ uncertain: true }` = the connection died mid-send, which a reboot routinely does — the run watches for proof instead of failing.
- **Every CLI argument passes `assertCliToken`** (switch-id, serial) — an interactive shell has no argv boundary.
- Lab-verified on FortiOS 7.6.7 and 8.0.1 (2026-10-13). A path or body change is checked against both.

**When changing this:** a new endpoint goes in `GateOps` for EVERY link kind it can ride (or the plan must refuse that kind); keep it Prisma-free so tests drive it through the seam.

## services/rebootScheduleService.ts

**What it owns:** A reboot BOOKED for later (business rule 115, the rule-93 shape) and the email that says how it went: `RebootSchedule` create / update / cancel from the asset slide-over, firing due bookings (the job's tick), and the results email.

**Public API:** `createRebootSchedule` (returns `warnings`; optional `context` is merged into the `asset.reboot_scheduled` Event details), `updateRebootSchedule`, `cancelRebootSchedule`, `getPendingRebootSchedule`, `listRebootSchedulesForAsset`, `bookRebootFromAutomation` (`AutomationRebootInput` → `AutomationRebootResult` `{ booked: true, scheduleId, scheduledFor } | { booked: false, reason }`), `nextAutomationRebootTime(when, at, now)`, `runDueRebootSchedules` (+ `DueRebootResult` `{ started, refused, missed, waiting }`), `notifyScheduledRebootFinished`; type `RebootScheduleSummary`.

**Cross-service deps:** `rebootService.{checkSchedulableReboot, startReboot, RebootRunConflictError, recordRebootCredentialUse}`; `firmwareScheduleService.{normalizeRecipients, assertSchedulableTime, LATE_GRACE_MS, CONFLICT_WAIT_MS, MIN_LEAD_MS, MAX_RECIPIENTS, AUTOMATION_MAX_RECIPIENTS}` (one copy of the booking rules); `rebootSettingsService.resolveRebootNote` (rule 115(d)); `quietTimeSummaryService.resolveSummaryChannel`; `notificationDeliveryService.{applyBrandLetterhead, sendEmailThroughChannel}`; `userTimezoneService.{resolveTimeZone, serverTimeZone}`; `utils/rebootResultEmailTemplate.renderRebootResultEmail`; `eventLogService.logEvent`.

**Used by:** `src/api/routes/reboot.ts` (`GET /schedules`, `GET /schedules/defaults`, `POST /schedules`, `PATCH` / `DELETE /schedules/:scheduleId`; `GET /` folds in the pending booking); `src/jobs/startScheduledReboots.ts` (`runDueRebootSchedules`, 60 s); `src/services/rebootService.ts` (lazy `notifyScheduledRebootFinished` from the runner's `.finally` and the boot sweep); `src/services/automationActionService.ts` (lazy `bookRebootFromAutomation` from the `reboot` action branch, rule 115(c)); `public/js/assets.js` (the reboot modal's schedule box; `_openBookingFromCalendar` opens it in change mode from an Events-calendar click). Reader of its rows, not a caller: `src/services/operationsCalendarService.ts` (`RebootSchedule` by `scheduledFor` range, the Events page's Calendar tab).

**Invariants:**
- **An automation BOOKS, never sends** (rule 115(c)). `bookRebootFromAutomation` skips — an info `asset.reboot_automation_skipped` Event, not a failure — when a booking is already pending for the asset, or the device rebooted within `minGapHours` (a `RebootRun` not `failed`, or `Asset.lastRebootAt`; the loop guard against a leak that refills memory after every boot). Otherwise it calls `createRebootSchedule` with actor `automation:<rule name>` and `context` `{ automation, ruleId, ruleName, notificationId }`, so every booking gate (opt-in, HA, asset kind) applies and a refusal throws to the caller as an action error; a lost race (409 "already scheduled") is a skip. Then `recordRebootCredentialUse` with `{ username: null, actor, mayUseAny: false }` — always `credential.borrowed` (rule 112). `nextAutomationRebootTime`: `now` = just past `MIN_LEAD_MS`; `at` = the next HH:MM on the server's clock at least `MIN_LEAD_MS` away, stepped by calendar day (`setDate`, never +24 h — the DST trap).
- **A booking is cancelled when the device reboots some other way** — that lives in `rebootScheduleCancel.ts` (rule 115(b)), not here, so the probe path does not load this module's email graph.
- Every firmware-booking invariant holds here (see `firmwareScheduleService`): approved at booking, judged at firing (`startReboot` re-takes every gate); every transition out of `pending` conditional; one `pending` per asset and ≥ 1 recipient enforced by the DB; refused is final, a `RebootRunConflictError` waits up to `CONFLICT_WAIT_MS`; `LATE_GRACE_MS` late → `missed`; sequential inside a tick; `notifiedAt` claimed before sending, one message per recipient in that reader's zone — unless the booking carries `notifyCc` / `notifyBcc` (only an automation's does, rule 115(c)), when it is ONE message to the whole To line plus Cc/Bcc in the server's zone.
- **An automation's booking holds RESOLVED addresses.** `AutomationRebootInput.notifyEmails` / `notifyCc` / `notifyBcc` arrive already resolved (`automationActionService` calls `notificationRecipientService.resolveRebootActionRecipients`); `createRebootSchedule`'s `maxRecipients` lifts each list's cap to `AUTOMATION_MAX_RECIPIENTS` (200) for them, and `updateRebootSchedule` caps an edited To at `max(MAX_RECIPIENTS, current length)` so an inherited long list stays editable. An operator's booking keeps 20 and empty Cc/Bcc.
- **Booking takes no hold** — the `device-reboot` hold is taken only when the run starts.
- **The reason (rule 115(d)).** `createRebootSchedule` judges `note` through `resolveRebootNote` (400 blank while required) and names it in `asset.reboot_scheduled`; `updateRebootSchedule` keeps the stored note when `note` is absent and judges it again when present (the change is listed in `asset.reboot_rescheduled`); `bookRebootFromAutomation` always passes `Automation "<rule name>"`, so the requirement never fails an automation; `runDueRebootSchedules` selects `note` and hands it to `startReboot`; the results email prints it as "Reason".
- Events: `asset.reboot_scheduled` / `reboot_rescheduled` / `reboot_schedule_cancelled` / `reboot_schedule_missed` / `reboot_schedule_refused` / `reboot_schedule_email_failed` / `reboot_automation_skipped`.

**When changing this:** a change to the shared booking rules is made in `firmwareScheduleService` and lands on both; a new terminal status needs the migration CHECK, the template's `RebootResultOutcome`, and the slide-over. Scale: one indexed `(status, scheduledFor)` query per minute.

## services/holdRecoveryWait.ts

**What it owns:** `holdUntilMonitorAnswers(assetId, kind, timeouts, run, rebootSince?)` — keep a rule-80 maintenance hold open until the device answers Polaris's OWN monitoring again: the first successful `AssetMonitorSample` after the operation, polled every `recoveryPollMs`, capped at `recoveryWaitMs`, after first pushing the hold's `expiresAt` past the cap. With `rebootSince` (rule 115(a)) the first answer is not enough: the hold stays open until monitoring has RECORDED the reboot — `Asset.lastRebootAt` > `rebootSince` (stamped in the same tick as the `device.reboot` Event and flushed after it) — or, once monitoring has answered, until `lastUptimeSec` is null (monitoring reads no uptime here, so no Event can come); still capped. **Each poll also probes the device itself** (`monitoringService → probeAsset`, the Poll Now probe, through the four-tier polling method) and records a SUCCESS through `recordProbeResult` — the hold parks the asset at status `maintenance`, which `MONITOR_CANDIDATE_WHERE` drops from every scheduled poll, so nothing else would ask it. Extracted from `firmwareUpgradeService` so both on-purpose reboots share it.

**Public API:** `holdUntilMonitorAnswers` (true when monitoring answered within the cap; false on the cap or with no hold), type `HoldRecoveryRun` (`onWaiting`, `push`, `flush` — the caller's run-log hooks).

**Cross-service deps:** `prisma` (`maintenanceHold`, `assetMonitorSample`, `asset` — `lastRebootAt` / `lastUptimeSec` when `rebootSince` is given); `monitoringService` (`probeAsset`, `recordProbeResult`); type `MaintenanceHoldKind` from `maintenanceScheduleService`.

**Used by:** `src/services/firmwareUpgradeService.ts` (kind `firmware-upgrade`, rule 87 — no `rebootSince`, ends at the first answer), `src/services/rebootService.ts` (kind `device-reboot`, rule 115 — `rebootSince` = the run's start).

**Invariants:**
- **The wait must probe; it cannot only read.** Until 2026-10-13 it only read the sample table, waiting for the scheduler — but the hold it is waiting under is what took the asset off the scheduler, so on every agentless device (a FortiSwitch flash, the case that surfaced it) it sat out the full 10-minute cap and then warned that monitoring "did not answer". A failed probe is NOT recorded (the device is mid-recovery, inside the window that exists so it is not judged yet; at the cap normal polling resumes); skipped / duplicate results are not recorded either. A probe that throws is logged and the wait carries on.
- **The sample table is still the release signal, not the probe's return** — an agent-polled host's `probeAsset` is a synthetic success that writes nothing (its real samples arrive by push, which maintenance does not stop), and a recorded success reaches the table on the sample buffer's next flush, so the release can trail the answer by one poll.
- **No hold row = unmonitored = nothing to wait for** (`openMaintenanceHold` declined); returns at once.
- The operation's own proof (web UI, controller, agent) routinely answers minutes before SNMP / ICMP does — releasing on that proof let the next missed polls land outside the window (a FortiAP's HTTPS answered while its SNMP agent was still silent).
- The `device.reboot` Event that drives the "Device recently rebooted" automation is written on the first probe that READS uptime, which can be later than the first probe that answers (and an agent reattaches before its first uptime-bearing sample) — hence `rebootSince`. When the cap ends a wait in which monitoring answered but never recorded the reboot, the run log says an alert may follow.
- Scale: one probe plus one or two indexed point queries per poll (15 s) per live run — a handful of devices at a time, never the fleet.

**When changing this:** never make the release depend on the scheduler again while the hold parks the status; both callers' timeouts objects carry `recoveryWaitMs` / `recoveryPollMs`; a new on-purpose-reboot operation calls this rather than copying it, passing `rebootSince` when its downtime is a reboot monitoring will detect.

## services/rebootScheduleCancel.ts

**What it owns:** Withdrawing a booked reboot once the device has rebooted some other way (business rule 115(b)) — `cancelPendingRebootAfterReboot({ assetId, cause: "manual" | "detected", actor, resourceName?, runId?, now? })`. Cancels the asset's `pending` `RebootSchedule` with a conditional `updateMany` (a booking the scheduler has already claimed is `started` and is not touched), sets `cancelledBy` (the actor for `manual`, `system:reboot` for `detected`) and an `error` reason, and writes `asset.reboot_schedule_cancelled` (info, actor `system:reboot`, `details` `{ scheduleId, scheduledFor, automatic: true, cause, rebootedBy, runId }`). Returns how many it cancelled; never throws.

**Public API:** `cancelPendingRebootAfterReboot`, types `RebootCancelCause`, `CancelAfterRebootInput`.

**Cross-service deps:** `prisma` (`rebootSchedule`); `eventLogService.logEvent`. Deliberately nothing else.

**Used by:** `src/services/rebootService.ts` (`runReboot`, cause `manual`, when a reboot-now — not a booking firing — SUCCEEDS); `src/services/monitoringService.ts` (lazy import from `recordProbeResult`'s reboot detection, cause `detected`, actor `system:monitor`, fire-and-forget beside the `device.reboot` Event).

**Invariants:**
- **Its own module** because `monitoringService` calls it from the probe path and must not import `rebootScheduleService`'s email and delivery graph.
- **No email** to the booking's recipients — matching an operator's cancel.
- A failed reboot-now cancels nothing (the booking is still worth keeping); a booking firing never cancels itself (it is `started`, not `pending`).
- One booking per asset is already enforced (partial unique index on `reboot_schedules`, 409 at booking); the loop tolerates more than one row anyway.
- Scale: called only on a reboot — one indexed read, a conditional update only when a booking exists.

**When changing this:** keep the import list to the database and the Event log; a new cause needs its `why` text and the wiki's Assets reboot section. Pinned by `tests/unit/rebootScheduleCancel.test.ts`.

## services/rebootSettingsService.ts

**What it owns:** The install-wide reboot setting (business rule 115(d)) — the `rebootConfig` Setting `{ requireNote: boolean }`, off by default — and the one place a reboot's reason is cleaned and judged.

**Public API:** `getRebootSettings()`, `saveRebootSettings(next, actor)`, `parseRebootSettings` (pure; anything but a literal `true` is off), `defaultRebootSettings()`, `invalidateRebootSettingsCache()`, `normalizeRebootNote(note)` (pure: control characters → spaces, runs of spaces collapsed, trimmed, blank → null, > `REBOOT_NOTE_MAX` (500) or not a string → 400), `resolveRebootNote(note)` (normalize, then 400 when blank and `requireNote` is on), `REBOOT_SETTING_KEY`, `REBOOT_NOTE_MAX`, type `RebootSettings`.

**Cross-service deps:** `settingsStore.createSettingStore` (10 s TTL); `eventLogService.logEvent` (`setting.reboot_updated`, only when the switch actually changes); `AppError`; `logger`.

**Used by:** `src/services/rebootService.ts` (`startReboot`); `src/services/rebootScheduleService.ts` (`createRebootSchedule`, `updateRebootSchedule`); `src/api/routes/reboot.ts` (`GET /assets/:id/reboot` → `noteRequired`); `src/api/routes/serverSettings.ts` (`GET|PUT /server-settings/reboot`). Client: `public/js/server-settings.js → _rebootSettingsCardHtml` / `saveRebootSettings` (Customization tab, Reboots card); the reboot dialog (`public/js/assets.js → _rebootNoteFieldHTML`) and the phone sheet (`public/js/mobile/asset-detail.js → rbConfirmBodyHtml`) read `noteRequired`.

**Invariants:**
- **Enforced in the service, not the dialog** — the desktop dialog, the phone and a bearer token all meet the same 400.
- **A settings-read failure reads as "not required"** (`getRebootSettings` catches): an outage must not be the reason a device cannot be rebooted. The opposite posture from `passwordPolicyService`, deliberately.
- **The requirement is judged when a reboot is ASKED for** (a reboot-now, a booking, a booking change that sends a note) — never when a booking fires.
- `noteRequired` rides the asset's reboot availability, so an `assets:write` user without `serverSettingsSystem` still sees the field marked required.
- Scale: one cached Setting read per reboot or booking; nothing on a ticking path.

**When changing this:** a new reboot entry point must pass its note through `resolveRebootNote` (or, for something Polaris books itself, supply a non-blank one, as `bookRebootFromAutomation` does); a new setting field needs `parseRebootSettings`, the route's strict Zod schema, the card, and the wiki's Server Settings page. Pinned by `tests/unit/rebootNote.test.ts`.

## services/agentRebootPermissionService.ts

**What it owns:** Turning an agent host's reboot opt-in (business rule 115) on or off AFTER deployment: `ManagedAgent.rebootEnabled` and the host-side permission (the root-owned marker the agent requires, plus on Linux the polkit rule that lets the unprivileged agent ask logind to reboot) must agree.

**Public API:** `setAgentRebootEnabled({ assetId, enabled, actor, testOverrides? })` → `AgentRebootToggleResult` `{ rebootEnabled, hostError }`.

**Cross-service deps:** `agentInstallService.applyRebootPermissionOnHost` (the host script over the agent's stored install credential + transport, exactly as an upgrade reaches the host); `credentialService.getCredential`; `agentCommandWake.publishConfigRefresh`; `eventLogService.logEvent`; `prisma.managedAgent`.

**Used by:** `src/api/routes/reboot.ts` — `PUT /agent` (`assets:fullwrite`); `public/js/assets.js` (`_toggleAgentReboot`).

**Invariants:**
- **Enable: host first, then flag.** The script must succeed before `rebootEnabled` is set; `rebootCapable` is reset to null and a refresh-config nudge asks the agent to report again — the button stays off until the HOST says it can.
- **Disable: flag first.** `rebootEnabled` is cleared even when the host cannot be reached (Polaris stops sending reboots at once); `hostError` and the Event say the host may still carry the permission.
- Only agents with something on the host to change (`active` / `enrolling` / `upgrade_failed`). Re-running either is safe (idempotent scripts) — "enable" again repairs a host that reports it cannot reboot.
- Events: `agent.reboot_enabled` (warning — a new power over the host), `agent.reboot_disabled` (info; warning when the host was not changed), `agent.reboot_permission_failed` (warning — the enable script failed; also written by `agentInstallService.runInstall` when the post-install grant fails).

**When changing this:** the scripts live in `utils/agentRebootPermission.ts`; the agent's marker check (`agent/internal/reboot`) must agree on paths in lockstep.

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
- **A frame is agent-controlled JSON (business rule 119(d), re-scan F8).** `asFrame` accepts only an object with a string `type` (`null`, numbers and arrays parse fine and used to throw on `frame.type`); the `ws.on("message")` body is wrapped so any throw detaches THAT session (`malformed frame`) — an uncaught exception in a ws listener exits the web role. Pinned by `tests/unit/agentChannelMalformedFrame.test.ts`.
- **`agent.connected` / `agent.disconnected` must NAME the asset.** An `asset` Event with no `resourceName` gives an event automation an empty subject (`utils/alertSubject.eventSubjectLabel` returns "" for one), so every alert about an agent dropping rendered a widget row and an email that could not say WHICH host — the one fact those alerts carry. `attach` resolves `hostname || ipAddress` once and parks it on the Session so `detach` can name the device without a database read on a path that runs when the socket is already dead, and so both events agree on the label. Every other `agent.*` Event that names an asset does the same (`agentInstallService`'s runners pass the row they hold; its `fail*` helpers use `assetLabel`).
- **A reattach is what ENDS an upgrade or reinstall hold** (business rule 80), not the installer returning: the WS teardown trails the service stop by up to a heartbeat interval, so a hold released when the script exited lets the lagging `agent.disconnected` through. `attach` releases `agent-upgrade` and `agent-reinstall` — an `agent-uninstall` hold ends with the uninstall, since nothing is meant to come back from one, and a `device-reboot` hold is NOT released here (business rule 115(a)): the reboot run owns that window and ends it only once monitoring has recorded the reboot, because the agent reattaches before its first uptime-bearing sample and a release on reattach put the `device.reboot` Event just outside the window. The release is best-effort: its failure must not break the attach, and the hold's expiry covers it.
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

**Input rule (business rule 107):** the server URL is allowlisted by `utils/agentServerUrl.ts`. `inferOwnServerUrl` / `inferOwnServerUrlSync` return only a normalized URL (an invalid stored override, `POLARIS_PUBLIC_URL` or cert-derived value is skipped for the next source, the override with a warning), and each of the five `__SERVER_URL__` replace sites calls `assertScriptSafeServerUrl`, so a Windows installer / upgrader script is never built from a URL that fails the allowlist. `PUT /server-settings/agents/server-url` applies the same check at save.

**What it owns:** Fire-and-forget remote install / uninstall / upgrade of the Polaris Agent over SSH (Linux/macOS/Windows) or WinRM (Windows): resolves credentials, mints an enrollment token, uploads the binary + a rendered `agent.conf`, runs platform scripts, and drives the ManagedAgent lifecycle (pending → uploading → enrolling → active | failed).

**Public API:** `startInstall`, `startUninstall`, `startUpgrade`, `upgradeAllOutdated`, `bulkInstallAgents`, `applyRebootPermissionOnHost` (+ `RebootPermissionTarget` — business rule 115), `BulkInstallInput`, `BulkInstallResult`, `resolveUpgradeCredential`, `UPGRADEABLE_INSTALL_STATUSES`, `canUpgradeFromStatus`, `renderAgentConf`, `inferOwnServerUrl`, `inferOwnServerUrlSync`, `AGENT_SERVER_URL_SETTING_KEY`, `StartInstallInput`, `StartUninstallInput`, `StartUpgradeInput`, `ResolvedUpgradeCredential`, `UpgradeAllResult`

**Cross-service deps:** `credentialService.getCredential`, `windowsSshOnboardingService.getOnboardingState` (the managed deployment credential the upgrade falls back to), `agentTokenService.mintEnrollmentToken`, `agentBuildService.getInventory`, `certInfo.getServerCertHostnames`, `maintenanceScheduleService` (`openMaintenanceHold` / `releaseMaintenanceHold` — business rule 80), `publicUrl` port helper, `utils/agentUnit` (`linuxServiceBlock`/`normalizePrivilegeTier`/`AgentPrivilegeTier` — the privilege-tier → systemd unit mapping; re-exported from here), `logEvent`, `prisma`, WinRM helper.

**Used by:** `src/api/routes/assets.ts` (per-asset install / reinstall / upgrade / uninstall; `bulkInstallAgents` behind `POST /assets/bulk-agent-install`), `src/api/routes/serverSettings.ts` (upgrade-all), `src/services/agentAutoDeployService.ts` (`startInstall`), `src/services/agentBuildService.ts` (auto-upgrade hook).

**Invariants:**
- **Staged, never fixed names (business rule 119(a)/(b)).** SSH install / upgrade / uninstall / reboot permission go through `runStagedUnix` (a `utils/remoteStaging` mktemp dir, `unixStagedCommand` runs and removes it) and Windows through `runPowerShellOverSsh` (a random dir in the SSH user's own temp, removed in `finally`). The install and upgrade scripts take `$1` = staging dir, `$2` = binary SHA-256 and verify before `install`; `installerScript` / `uninstallerScript` / `upgradeScript` are exported for `tests/unit/agentStagedScripts.test.ts`, which forbids `/tmp/` in any rendered script.
- **An operation that stops a RUNNING agent holds the asset in maintenance first** (business rule 80). Stopping the service drops the WebSocket, which writes `agent.disconnected` at warning level, which is what the seeded baseline automation fires on — so upgrade, reinstall and uninstall take a `MaintenanceHold` in their SYNCHRONOUS half, before the runner is scheduled, and a hold taken after the installer has already stopped the service has missed the event. A first install and `/retry` take NO hold (`StartInstallInput.holdKind` is set by the reinstall route alone): there is no agent to disconnect, and holding would silence a host still telling the truth. The hold is best-effort in both directions — `takeAgentHold` swallows its errors, because a hold is an improvement to an upgrade and never a precondition for one.
- **Failure releases the hold; success does not.** Every `fail*` helper drops it — an agent down because its upgrade failed is a real problem and the alert is the point — while the success paths leave it to `agentChannelService.attach` (the agent reattaching) or to the hold's own expiry, because the WS teardown trails the service stop by up to a heartbeat interval. The exception is `agent.uninstalled`: nothing is coming back to reattach, so completing the uninstall ends that hold.
- Fire-and-forget: kicks off an async runner, returns immediately.
- **The bulk deploy RETRIES a failed install; it skips every other agent state** (2026-09-24). `bulkInstallAgents` resets a `installStatus="failed"` row in place — the same reset as `POST /assets/:id/agent/retry`, writing the same `agent.install_retry` Event with `details.bulk: true` — and counts it in `BulkInstallResult.retried` as well as `kicked`. The retry KEEPS the row's `osPlatform` + `arch` (the host has not changed; a wrong guess is corrected by reinstall / force-remove, not by re-inferring from `Asset.os`) and TAKES the batch's policy: credential + transport re-picked by `pickTransportAndCredential` for the row's platform, `installScriptId`, `privilegeTier`, `installedBy`. When the batch's credentials do not cover that platform, the row's own `installCredentialId` is reused if it still resolves (what the per-asset Retry does), else the asset is skipped with the reason. No maintenance hold (rule 80 — nothing running to disconnect). In-flight, `active`, `upgrade_failed`, `uninstall_failed` and `revoked` rows stay skipped as "agent already installed (status=…)": each has work on the host or an agent to preserve. Pinned by `tests/unit/agentInstallBulkRetry.test.ts`.
- Platform/arch drives binary selection (inferred from `Asset.os`, arch defaults amd64); SSH needs username + (password OR privateKey), WinRM needs username + password.
- Uninstall (and force-remove) hard-deletes the ManagedAgent row on success, clears all polling columns (incl. `processesPolling`) so source defaults resume, AND tears the host off the Application Map — clears `mappedProcesses`/`mappedServices` + `deleteMany` its `AssetProcessConnection` rows in the same transaction (nothing collects them once the agent is gone, and pinned child nodes render from the pins regardless of connection rows). Upgrade replaces the binary only — `agent.conf` (bearer + pin) is untouched so the agent keeps its identity.
- Server-URL resolution order: Setting override → `POLARIS_PUBLIC_URL` → cert hostnames → fallback → localhost.
- **Upgrade resolves its own credential (business rule 49).** `resolveUpgradeCredential` tries the operator override, then `installCredentialId`, then the Polaris-managed SSH deployment credential — an id that no longer resolves counts as absent, because the FK is `ON DELETE SET NULL` and pre-`20260514010000` installs never had one. **Transport follows the credential's `type`, never `row.installTransport`** (the `20260609000000` backfill wrote `winrm` onto every existing Windows row; the managed credential is key-only). An ADOPTED credential + transport is written back onto the row **only after the upgrade succeeds**; an operator override is never adopted. Install / reinstall / uninstall are unchanged — they still require a credential on file.
- **Linux privilege tier** (`ManagedAgent.privilegeTier`, Linux-only) selects the systemd `[Service]` block via `agentUnit.linuxServiceBlock`: `unprivileged` (default) or `ptrace` (+CAP_SYS_PTRACE +CAP_DAC_READ_SEARCH for Application Map attribution — the pair, not SYS_PTRACE alone; see the privilege-model entry). Full root is retired — never emitted for new installs/reinstalls; a legacy `root` row downgrades on reinstall. Reinstall conversion logic lives in the `POST /assets/:id/agent/reinstall` route (`assets.ts`), not here.

- **Windows config ACL before the write (business rule 117).** The install script takes ownership of `%ProgramData%\Polaris` and `Polaris\agent` for Administrators (`icacls /setowner *S-1-5-32-544`) and sets a protected SYSTEM + Administrators DACL, resets anything already inside, and deletes a stale `agent.conf.tmp` BEFORE writing the conf — `%ProgramData%` lets every user create folders, so a pre-created one would otherwise own the bearer. SIDs, not names (localized). The agent side is `agent/internal/config/private_windows.go`.

**When changing this:**
- `agent.conf` templating must stay in sync with the Go agent (pin set + enrollment-token format).
- Concurrent upgrades are pool-bounded so a fleet upgrade doesn't overwhelm hosts; `testOverrides` allow fake SSH for unit tests.
- A row `upgradeAllOutdated` cannot upgrade writes an `agent.upgrade_skipped` Event against the asset: `startUpgrade` throws before it touches `installStatus`, so such a row leaves no trace of its own and is re-skipped by every later fan-out. Never let that path go silent again.
- **`upgradeAllOutdated` does not attempt a host that monitoring reads as DOWN** (2026-09-30): an eligible row whose asset is `monitored === true && monitorStatus === "down"` is left untouched (still `active` / `upgrade_failed`, still lagging, so the next fan-out or the per-asset Upgrade button — `startUpgrade`, deliberately NOT gated — picks it up), counted in `UpgradeAllResult.deferredDown`, and gets one info-level `agent.upgrade_deferred` Event (batched via `logEventsBatch`, best-effort). Its own action, never `agent.upgrade_skipped`: an automation keyed on "skipped" means a stranded host and must not page about a host that is merely off. An UNMONITORED asset is still attempted — its `monitorStatus` is stale. The reason is the pool: a dead host's SSH/WinRM connect sits out its timeout holding one of the 4 slots every reachable host queues behind. Applies to both callers (`POST /server-settings/agents/upgrade-all` and the `agent.autoUpgradeOnNewBuild` hook); the Server Settings toast reports the deferred count.
- **Reboot opt-in (business rule 115).** `StartInstallInput.allowReboot` / `BulkInstallInput.allowReboot` (and `POST /assets/:id/agent/install`'s body) set `ManagedAgent.rebootEnabled`; after a SUCCESSFUL install `runInstall` applies the host-side permission (`applyRebootPermissionOnHost` → `utils/agentRebootPermission.ts` scripts over the same transport) when the row has `rebootEnabled` — best-effort: a failure writes `agent.reboot_permission_failed` and never fails the install. The Linux uninstaller appends `LINUX_REBOOT_PERMISSION_CLEANUP`. `agentRebootPermissionService` calls `applyRebootPermissionOnHost` for a later toggle.
- The privilege-tier → unit mapping is pure in `utils/agentUnit.ts` (unit-tested) — edit systemd directives there, and remember `linuxServiceBlock` only ever emits unprivileged/ptrace (no root branch).

---

## services/agentTokenService.ts

**What it owns:** Mints/verifies the two managed-agent token types — enrollment (one-shot, short TTL, consumed at `/enroll`) and bearer (long-lived, revoked on uninstall) — stored as argon2id hashes + an indexed prefix, with the bearer bound to a single assetId.

**Public API:** `mintEnrollmentToken`, `consumeEnrollmentToken`, `shouldEnableMonitoringOnEnroll`, `verifyBearer`, `revokeBearer`, `ConsumedEnrollment`, `VerifiedAgent`

**Cross-service deps:** `prisma` (managedAgent), password hash/verify util, `agentHostPinService.noteArchivedAgentCheckin` (business rule 123).

**Used by:** `src/api/middleware/auth.ts` (`verifyBearer` for agent endpoints), `src/api/routes/agents.ts` (`consumeEnrollmentToken` at `/enroll`), `src/api/routes/agentsWs.ts` (`verifyBearer` on WS upgrade), `src/api/routes/assets.ts` (`revokeBearer` on uninstall), `src/services/agentInstallService.ts` (`mintEnrollmentToken`).

**Invariants:**
- Token format `polaris_<random>` with an indexed prefix for O(1) candidate lookup; full secret stored only as an argon2id hash.
- Enrollment has a short TTL and is idempotent to re-mint (Reinstall overwrites a stale token); `consumeEnrollmentToken` atomically clears enrollment fields, mints the bearer, flips installStatus→active, stamps polling columns, and auto-enables `monitored` (never on decommissioned/disabled assets — business rule 10; no-op on already-monitored so a Reinstall doesn't re-log).
- `verifyBearer` self-heals a stuck "enrolling" status (an agent reusing an existing bearer skips `/enroll`); `revokeBearer` is idempotent.
- Bearer is bound to `assetId @unique` as cross-asset-reuse defense; dual-pin enroll validates against the canonical fingerprint while additional pins stage in `additionalServerCertFingerprints`.

**When changing this:**
- Enrollment expiry is load-bearing for install-retry safety (operator re-mints via Reinstall) — don't make it permanent.
- **`verifyBearer` reports a decommissioned host's check-in (business rule 123).** Its candidate select carries `hostPinsArchivedAt`; a verified row with it set calls `agentHostPinService.noteArchivedAgentCheckin(row.id, callerIp)`, which is synchronous, throttled (10 min per agent per process) and fires the conflict raise without awaiting it. Keep it that way: this function runs on EVERY agent request, so the hook must never add a query to the hot path, throw, or refuse the request — the bearer is still valid while the operator decides.

---

## services/agentHostPinService.ts

**What it owns:** Business rule 123 — an agent host's pinned server identities across decommission. Exactly while the asset is decommissioned, the `SshHostKey` / `TlsCertPin` rows of the asset's addresses are moved off the live tables onto its `ManagedAgent` row (`archivedHostPins` JSON + `hostPinsArchivedAt`), so an address handed to another machine is not refused by a pin that belongs to the old one; they are written back verbatim when the asset leaves decommissioned. Also owns the `decommissioned-agent-checkin` Conflict flavour (raise / refresh / accept / reject) and the per-asset read + bulk preview the UI shows.

**Public API:** `assetPinHosts` (pure — `ipAddress` / `dnsName` / `hostname`, trimmed and de-duplicated: the strings the install may have dialed, since a pin is keyed by that exact string), `parseArchivedPins` (pure, defensive JSON parse), `hostPinsForAsset` (`{hasAgent, live, archived}`), `previewDecommissionPins(ids)`, `archiveAgentHostPins(assetId, actor)`, `reinstateAgentHostPins(assetId, actor)` (`{restored, skipped}`), `resolvePendingCheckinConflicts(assetId, resolvedBy)`, `noteArchivedAgentCheckin(managedAgentId, callerIp)`, `raiseDecommissionedAgentConflict`, `acceptDecommissionedAgentConflict`, `logDecommissionedAgentDismissal`, `reconcileAgentHostPins()`, `listArchivedHostPins()` (every archived pin with its asset and `archivedAt` — the Pinned server identities list's read-only rows), `pinFingerprintQuery(raw)` (pure — a query read as a TLS hex fragment and / or an SSH base64 fragment, each ≥ 8 characters, else null), `findAssetsByPinFingerprint(raw, limit = 8)` (global search's thumbprint → asset lookup, live and archived), `DECOMMISSIONED_AGENT_COLLISION_REASON` (`"decommissioned-agent-checkin"`); types `HostPin`, `AssetHostPins`, `DecommissionPinPreview`, `ReinstateOutcome`, `ArchivedHostPin`, `PinFingerprintMatch`; `_resetCheckinThrottle` (tests).

**Cross-service deps:** `prisma` (asset, managedAgent, sshHostKey, tlsCertPin, conflict); `sshHostKeyService.forgetCachedHostKey` / `tlsCertPinService.forgetCachedCertPin` (drop the per-process pin cache after its own writes); `eventLogService.logEvent` (`asset.host_pins_archived`, `asset.host_pins_reinstated` — warning when a pin was skipped — `conflict.detected`, `conflict.accepted`, `conflict.rejected`).

**Used by:**
- `src/api/routes/assets.ts` — `GET /:id/host-pins` (`hostPinsForAsset`), `POST /decommission-preview` (`previewDecommissionPins`), and the `PUT /:id` post-write hook `applyAssetUpdateSideEffects` (archive on a transition TO decommissioned; reinstate + `resolvePendingCheckinConflicts` on a transition AWAY; failures logged, never thrown — the status change already landed).
- `src/services/agentTokenService.ts` → `verifyBearer()` — `noteArchivedAgentCheckin`.
- `src/services/searchService.ts` → `runSearch()` — `findAssetsByPinFingerprint` (asset group, when `allowed.pins`).
- `src/api/routes/serverSettings.ts` — `GET /agents/archived-host-pins` (`listArchivedHostPins`).
- `src/services/conflictResolutionService.ts` — accept → `acceptDecommissionedAgentConflict`, reject → `logDecommissionedAgentDismissal`, keyed on `DECOMMISSIONED_AGENT_COLLISION_REASON`.
- `src/api/routes/conflicts.ts` → `assertCanReactivate()` — the constant, for the extra `assets:write` gate on accept / merge.
- `src/jobs/reconcileAgentHostPins.ts` — `reconcileAgentHostPins`.
- `public/js/assets.js` (Sources tab Polaris Agent card, decommission confirm), `public/js/mobile/asset-edit.js`, `public/js/events.js` (`renderDecommissionedAgentConflictCard`) — through the routes.

**Invariants:**
- **The archive is non-null exactly while the asset is decommissioned.** Two writers keep it so: the PUT hook at the operator's change, and `reconcileAgentHostPins` for every other `Asset.status` writer (the stale-asset job, the directory / workload decommission sweeps, a scheduled status change, a discovery run that brings an asset back), none of which call the hook. A new status writer needs nothing — the job converges it within 10 minutes — but a new path that wants the pins moved at the moment of the change calls archive / reinstate itself.
- **Only assets with a `ManagedAgent` are in scope** — the archive lives on that row. A non-agent asset's pins are untouched by decommission.
- **A shared address is never archived.** An address another NON-decommissioned asset still records (`ipAddress` / `dnsName` / `hostname`) keeps its live pin — it protects that asset too. `previewDecommissionPins` applies the same rule against assets OUTSIDE the selection, so the confirm names what will actually move.
- **Reinstate never overwrites.** A pin another machine has taken on the same endpoint since is left in place and reported in `skipped` (`asset.host_pins_reinstated` at warning); replacing a live pin is the operator's call under Pinned server identities. An identical fingerprint counts as restored.
- **Archive and reinstate are race-safe claims.** Each is ONE transaction guarded on the archive column (`hostPinsArchivedAt: null` to archive; the exact timestamp read to reinstate) via `updateMany`, so the PUT hook and the job never both act — the loser's deletes / creates roll back and it returns null. Both are idempotent.
- **The pin caches are dropped after the commit** (`forgetCachedHostKey` / `forgetCachedCertPin`, this process only). Another process's cache self-heals: a cached pin that disagrees re-reads the DB before refusing (the sshHostKeyService / tlsCertPinService invariant), and an archived pin no longer in the DB simply re-pins on first use.
- **One pending check-in conflict per asset.** A later check-in REFRESHES the pending row's payload (`lastCheckinAt`, `checkinIp`, `agentVersion`, pins); a REJECTED row whose `proposedAssetFields.archivedAt` equals the current `hostPinsArchivedAt` silences that decommission — decommission again (a new archive) and the next check-in raises again. The raise never throws (logged at warn).
- **Accept reactivates to `active` with monitoring left off** — the decommission clamped it and turning it back on is the operator's choice — then reinstates. Accept / merge on this flavour also require `assets:write` (`routes/conflicts.ts → assertCanReactivate`).
- **Scale.** The reconcile pass is two bounded `findMany`s (200 each, on the `hostPinsArchivedAt` index) and at most 8 archive / reinstate calls in flight; an idempotent fleet issues two cheap queries every 10 min at 100 or 2000 assets. The preview is a fixed four queries for any selection size (≤ 5000 ids at the route).

**When changing this:**
- A new kind of pinned server identity (another TOFU table keyed by host:port) belongs in `livePinRows`, `HostPin.kind`, the archive / reinstate branches and the Sources-tab renderer together, or decommission strands it live.
- If the agent install starts dialing a different address string, `assetPinHosts` must learn it — the archive finds pins only by the strings Polaris dialed.
- **The thumbprint lookup is bounded and never runs on an ordinary word.** `pinFingerprintQuery` needs 8+ hex (TLS) or 8+ base64 (SSH) characters, so a short query or a hostname with a dot or dash issues nothing. When it does run: one raw `LIKE` over `tls_cert_pins` (colons stripped, pinned OR pending fingerprint), one `sshHostKey.findMany` (`contains`, case-sensitive), each `LIMIT limit`; the archive scan reads only agents with `hostPinsArchivedAt` set (a handful — decommissioned agent hosts); then ONE `asset.findMany` resolving live hosts through `assetPinHosts`. An archived pin names its asset directly, so a decommissioned host is found by its old thumbprint.
- Tests: `tests/unit/agentHostPinService.test.ts` (pure helpers, `pinFingerprintQuery`), `tests/integration/agentHostPinArchive.test.ts` (archive / reinstate / shared address / skipped pin / check-in conflict / reject silencing / reconcile / thumbprint lookup + search gate + archived list route).

---

## services/agentCommandService.ts

**What it owns:** The agent command queue — the `AgentCommand` table + its lifecycle. Two queued actions: `run_script` (agent-side automation script runs, enqueued by `automationScriptService.requestScriptRun`) and `reboot` (business rule 115, enqueued and watched by `rebootService`). Process/service start/stop/restart control was REMOVED (Satellite-posture change) — this module keeps only the shared fetch/report plumbing.

**Public API:** `fetchPendingCommands(managedAgentId)` (agent poll; marks sent atomically + flips linked run_script `AutomationScriptRun`s pending→running); `recordCommandResult(managedAgentId, commandId, success, error, resultState, output?)` (agent report → completes the command + the linked run + audit); type `AgentCommandView`.

**Cross-service deps:** `eventLogService.logEvent` (`automation.script.run`, generic `agent.command.*.result` fallback); `prisma.agentCommand`, `prisma.automationScriptRun`.

**Used by:** `src/api/routes/agents.ts` (bearer `GET /agents/commands` + `POST /agents/command-result`). Rows are ENQUEUED by `automationScriptService.requestScriptRun` (not this service).

**Invariants:**
- `fetchPendingCommands` flips pending→sent atomically so a slow agent (or a WS-wake + poll racing) doesn't double-execute the same command.
- `recordCommandResult` verifies the command belongs to the reporting agent (managedAgentId match).
- The agent refuses any action but `run_script` and `reboot`. **`recordCommandResult` returns silently for `reboot`** — the agent acknowledges BEFORE it takes the host down, and the reboot run watching the row writes the Events. Any other stale/foreign action reaching `recordCommandResult` is audited generically, never as control.

**When changing this:**
- Near-real-time dispatch is via a `commands-pending` WS frame (`agentCommandWake.publishCommandWake` → `agentChannelService.wakeCommands`); the ≤20s `/commands` poll remains the source of truth + guaranteed floor. Don't make the WS frame authoritative.
- A new action would need: the enqueue path, the agent executor arm (`pollAndRunCommands` in `agent/cmd/polaris-agent/main.go`), and the result branch here — in lockstep. Process/service control is intentionally NOT here anymore.

---

## services/agentCommandWake.ts

**What it owns:** The cross-process "wake this agent" signal for near-real-time command dispatch. When a command is enqueued (from any process/role), this emits a Postgres NOTIFY so the process holding the agent's WS session pushes a `commands-pending` frame instead of the agent waiting out its ≤20s command poll.

**Public API:** `publishCommandWake(managedAgentId)` (best-effort `SELECT pg_notify(CMD_WAKE_CHANNEL, id)` via prisma — never throws); `CMD_WAKE_CHANNEL` constant (`polaris_agent_cmd_wake`).

**Cross-service deps:** `prisma.$executeRaw` (pg_notify); `logger`. Deliberately lightweight (no WS/pg-Client imports) so the enqueue side (`automationScriptService`, which runs in the monitor/all role) can import it without pulling the WS server.

**Used by:** `src/services/automationScriptService.ts` (`requestScriptRun` fires it after creating the agent `run_script` command), `src/services/rebootService.ts` (after creating an agent `reboot` command), `src/services/agentRebootPermissionService.ts` (`publishConfigRefresh` after an opt-in toggle, so the agent re-reports `rebootCapable`). The LISTEN side is `agentChannelService.startCommandWakeListener` (web/all role) → `wakeCommands`.

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

## services/agentSigningService.ts

**What it owns:** Windows agent-binary code signing: the `agent.codeSigning` Setting (keystore path, sealed keystore password, alias, timestamp URL), availability checks (Java, the jsign jar, keystore readability, `keytool` alias listing), `buildJsignArgs` / `signFile` (the `java -jar` invocation, password through the child environment) and the failure stamp behind the sidebar's unsigned-binaries alert.

**Public API:** `getSigningConfigRaw`, `getSigningConfigMasked`, `updateSigningConfig`, `mergeSigningConfig`, `maskSigningConfig`, `isSigningConfigured`, `resolveJsignJar`, `jsignJarCandidates`, `JSIGN_JAR_CANDIDATES`, `buildJsignArgs`, `signFile`, `recordSigningFailure`, `clearSigningFailure`, `getSigningAlert`.

**Input rule (business rule 107):** the jar is run with `java -jar`, so there is NO Setting-supplied jar path (removed 2026-10-12). `jsignJarCandidates()` is `POLARIS_JSIGN_JAR` (absolute, `.jar`) followed by the fixed install locations; `mergeSigningConfig` drops any incoming or stored `jsignJarPath`, and `getSigningConfigRaw` logs once when it finds one. Pinned by `tests/unit/agentSigningService.test.ts`.

**Used by:** `src/services/agentBuildService.ts` (`signWindowsBinaries`), `src/api/routes/serverSettings.ts` (`/agents/signing`).
