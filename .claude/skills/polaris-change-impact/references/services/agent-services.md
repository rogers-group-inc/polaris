# Services — Polaris Agent install, build, channel, commands; the firmware repository

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol. The two firmware services sit here because `firmwareUpgradeService` copies `agentInstallService.startUpgrade`'s shape — synchronous refusals, a row, a kickoff Event, a rule-80 hold, a `setImmediate` runner on the web process.

## services/firmwareRepositoryService.ts

**What it owns:** The firmware repository (Server Settings → Repository; business rule 87): the manufacturer › device type (`switch` / `access_point` only) › model TREE, the IMAGES filed under a model node (two per node — primary + backup — with the rotation an upload performs), the device-admin login BINDINGS at the three scopes, and the per-asset CANDIDATE lookup. Bytes on disk under `FIRMWARE_DIR`; identity from the image header, never the model string.

**Public API:** `FIRMWARE_ASSET_TYPES`, `FIRMWARE_MAX_IMAGE_BYTES`, `isFirmwareAssetType`, `getFirmwareTree`, `listImages`, `getImage`, `registerUploadedImage`, `setPrimaryImage`, `deleteImage`, `purgeModelImages`, `resolveImagePath`, `ensureFirmwareDirs`, `listBindings`, `upsertBinding`, `deleteBinding`, `resolveFirmwareCredential`, `findUpgradeCandidates`, `listRecentRuns`; the row / node / candidate types.

**Cross-service deps:** `prisma` (asset groupBy + a tight-select serial scan, firmwareImage, firmwareCredentialBinding, firmwareUpgradeRun.count); `utils/firmwareVersion` (header/filename parse, compare, `platformFromSerial`); `utils/manufacturerNormalize.normalizeManufacturer`; `utils/paths` (`FIRMWARE_DIR`, `FIRMWARE_INCOMING_DIR`); `credentialService.getCredential({ revealSecrets: true })` (the ONE place a device password is read); `utils/httpCheck.isDeviceLoginCredential`; `firmwareEngines/index` (`engineFor`, `engineKindForType`); `assetTypeService.listAssetTypes` (labels); `eventLogService.logEvent`.

**Used by:**
- `src/api/routes/firmware.ts` — every repository route.
- `src/services/firmwareUpgradeService.ts` — `findUpgradeCandidates`, `resolveFirmwareCredential`, `resolveImagePath`, `getImage`.
- `public/js/server-settings-firmware.js` — the tab, through the routes.

**Invariants:**
- **Matching is by platform, filing is by model.** An asset is offered an image only when `image.platform === platformFromSerial(asset.serialNumber)` (rule 87); the model node decides nothing about eligibility. A filename-only image has `platform: null` and is never offered.
- **A node holds one primary and one backup**, and the DATABASE enforces it (two partial unique indexes). `registerUploadedImage` rotates in ONE transaction and refuses whole (409) when a queued/running run references the backup it would remove. `setPrimaryImage` steps through the transient `swapping` role because the partial indexes are checked per statement. `deleteImage` on the primary promotes the backup so a node never has a backup alone.
- **Only a PRIMARY is offered unasked.** `findUpgradeCandidates` returns the strictly-newer primary for the platform (the asset's own model node preferred, else newest) and names the SAME node's backup only when it too is strictly newer. Zero queries when `engineFor` is null.
- **Resolution is model › type › manufacturer, most specific LIVE row wins.** A binding whose credential was deleted (`credentialId` null) or whose credential is no longer a `form` login is SKIPPED, never a shadow — the rule-49 posture. Secrets are revealed only with `{ revealSecrets: true }`, which only `startFirmwareUpgrade` asks for.
- **The same bytes are filed once** (`sha256 @unique` → 409 naming the node); the temp file is removed on every failure path; the final rename is same-filesystem (the incoming dir sits under FIRMWARE_DIR).
- Never writes Asset. Never opens a socket to a device.

**When changing this:**
- Adding a device type: `FIRMWARE_ASSET_TYPES`, the two CHECK constraints in migration `20260925000000`, `engineKindForType`, the tree's type order, the wiki's "switches and access points only".
- Changing the two-image cap: the partial unique indexes AND `registerUploadedImage`'s rotation AND the tab's copy ("A model keeps two images") move together; `tests/unit/firmwareImageRotation.test.ts` pins every transition.
- Any new offer path must go through `findUpgradeCandidates` — the platform + strictly-newer gate lives there once.
- Scale: the tree is two `groupBy`s + one small `findMany` + one tight-select serial scan (only when the tab opens); never add a per-asset query.

## services/firmwareUpgradeService.ts

**What it owns:** One asset, one flash (business rule 87): what the asset card is told (`getUpgradeAvailability`), the SYNCHRONOUS gates and the kickoff (`startFirmwareUpgrade`), the runner that drives an engine and keeps the run row current, the reads, and the boot sweep for runs a restart orphaned. Copies `agentInstallService.startUpgrade`'s shape.

**Public API:** `getUpgradeAvailability`, `startFirmwareUpgrade`, `getRun`, `listRunsForAsset`, `failOrphanedFirmwareRuns`; `UpgradeAvailability` / `UpgradeAvailabilityState` / `RunSummary` / `StartUpgradeInput`.

**Cross-service deps:** `firmwareRepositoryService` (candidates, credential, image path); `firmwareEngines/index` (`engineFor`, `engineByKind`) and `firmwareEngines/types` (`DEFAULT_FIRMWARE_TIMEOUTS`); `maintenanceScheduleService.openMaintenanceHold` / `releaseMaintenanceHold` (kind `firmware-upgrade`, rule 80); `connectionPathService.resolveConnectionPath` + `prisma.assetMclagPeer` (the topology gate); `utils/assetInvariants.UNMONITORABLE_STATUSES` (rule 10); `eventLogService.logEvent`; a dynamic import of `discovery/assetDiscoveryScope.resolveDiscoveryScopeForAsset` + `discovery/discoveryEngine.triggerDiscovery` (the scoped rediscover on success); `node:fs/promises.stat`.

**Used by:**
- `src/api/routes/firmware.ts` — `firmwareAssetRouter` (`GET /`, `POST /`, `GET /runs`) and `GET /server-settings/firmware/runs/:id`.
- `src/jobs/failOrphanedFirmwareRuns.ts` — the boot sweep.
- `public/js/assets.js` — the Firmware card, through the routes (`_startFirmwarePoll` polls the run).

**Invariants:**
- **The gates are synchronous and ordered** (engine → address → platform → candidates → the REQUIRED approved `imageId` must be the offered primary or the eligible backup → health → login → one live run per asset, none on a connection-path ancestor/descendant or MCLAG peer → the image file exists), each an `AppError` answered to the click; the partial unique index on `(assetId) WHERE status IN (queued, running)` answers the race (P2002 → 409). `tests/unit/firmwareUpgradeGates.test.ts` pins the order.
- **`maintenance` is allowed; unmonitored is allowed** (the hold no-ops, as it does for an agent upgrade). Down / warning / recovering / dependency-suppressed / unmonitorable are refused.
- **The hold is taken BEFORE the runner is scheduled** and released in the runner's `finally` BEFORE the terminal Event (the `failUpgrade` ordering, rule 80a), by `failOrphanedFirmwareRuns` at boot, and by the reconcile's 45-minute expiry as the backstop.
- **Never writes `Asset.osVersion`.** Projection owns it (asset-source-projection); the run records `verifiedVersion` and requests a scoped rediscover, and `getUpgradeAvailability` reports `pending-discovery` until the record catches up so the button does not re-offer a flash that happened.
- **The plaintext password exists only inside the runner's engine context** — never in a log line, the run `log`, or an Event's `details` (only `credentialId` / name / scope).
- **The server owns the card's vocabulary**: `state` and `reason` are what the card draws; a new state is added here, not inferred from a sentence client-side.
- Runs execute on the web process (the image is on its disk; pg-boss is optional). A restart mid-flash orphans the run; the sweep names it rather than hides it. Row writes are throttled to one per 5 s; nothing here touches the monitor ticks.

**When changing this:**
- A new blocker: add it to `healthBlockers` (so availability and start agree), to the gates test, and to the wiki's list.
- A new engine: `firmwareEngines/index.ts` `engineFor` + `engineKindForType`, the run row's `engine` vocabulary, the file map, and the docs' "Fortinet only" sentence.
- A new terminal outcome: `finish`, the Event table (`firmware.upgrade_*`), the card's `_fwRunResultHTML`, and `dropHold` ordering.
- If a queue ever replaces `setImmediate`, the image must travel with the job (it lives on the web host's disk) and the boot sweep's "this process was driving it" premise changes.

---

## services/serviceInventoryService.ts

**What it owns:** The `AssetService` current-state table (one row per `(asset, unit)` systemd unit / Windows service) — the unit-centric sibling of the process inventory. Full-replace per agent scrape.

**Public API:** AssetServiceInput, isServiceControllable, persistAssetServices.

**Cross-service deps:** `prisma.assetService`, `retryOnDeadlock` (utils/dbRetry).

**Used by:**
- `src/api/routes/agents.ts` — the `serviceInventory` sample-stream arm maps `ServiceSampleSchema` rows → `persistAssetServices`. Also ships `streams.services` + `monitoredServices`/`mappedServices` on `GET /agents/config` (folded into both the payload ETag and the heartbeat `computeConfigEtag`).
- `src/api/routes/assets.ts` — `GET /assets/:id/services` reads the rows + pins (read-only; start/stop/restart control was removed in the Satellite-posture change). `monitoredServices`/`mappedServices` ride the general `PUT /assets/:id` pin path (UpdateAssetSchema).
- `agent/internal/collectors/services*.go` — the sole producer (`ServiceInventoryOnce`; systemd `systemctl list-units/list-unit-files/show`, Windows `Win32_Service`). The Linux path parses the **plain columnar** output of `list-units`/`list-unit-files` (`--plain --no-legend`), NOT `-o json`: systemctl only emits JSON for those list verbs from an interactive session — under the agent's systemd service context it silently falls back to the table format, so JSON parsing yields nothing (this caused Linux services to never populate; fixed 2026-07). The untagged pure parsers `parseListUnits` / `parseListUnitFiles` / `parseShowUnits` live in `services.go` (unit-tested). On a command error OR an empty parse `listUnits` returns nil + logs, so a parse regression skips the push rather than wiping the delete-replaced inventory.
- `public/js/assets.js` — the Services tab (`_wireAssetServicesTab`) + `openServiceDetailPanel`.

**Invariants:**
- Delete-then-insert in ONE `$transaction` under `retryOnDeadlock`; empty rows = valid delete-only scrape. Keyed `@@unique([assetId, unit])`. Plain table, NO FK to Asset (matches AssetProcess/AssetSdwanRule).
- `controllable` is DERIVED here, never trusted from the wire: systemd `loadState==="loaded"`, or any Windows service. Control routes re-check it.
- Agent-only. Agentless SSH/WinRM does not resolve units (`agentlessProcessService` hardcodes serviceUnit null) — no agentless producer exists.
- `mainProcess` is a display cross-link to the process rows (Services tab, *Include processes* view), not a key.

**When changing this:**
- Adding a field: extend the Prisma model + migration, `ServiceSample` (Go transport) + collectors, `ServiceSampleSchema` + the ingest arm (agents.ts), the `AssetServiceInput` map, and the `GET /assets/:id/services` projection — in lockstep. Bump `agent/VERSION`.
- The `serviceLog` stream (per-unit journalctl → `AssetServiceLogSample`; agent `servicelog.go` + `readJournaldUnit`, ingested in agents.ts via `enqueueServiceLogSamples`, read at `GET /assets/:id/service-logs`) and connection-unit-attribution (Phase 3) hang off the same pins (`monitoredServices`/`mappedServices`) shipped by the config endpoint. Adding a service-log field touches the Prisma model + migration, `ServiceLogSample` (Go transport) + `servicelog.go`, `ServiceLogSampleSchema` + the ingest arm, `ServiceLogRow`/`enqueueServiceLogSamples` (sampleWriteBuffer), and the `pruneSystemInfoSamples` line.

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

**Used by:** `src/api/routes/agentsWs.ts` (attach on authenticated WS upgrade), `src/api/routes/serverSettings.ts` + `src/services/monitoringService.ts` (`sendProbeNow` / `refreshConfig`), `src/app.ts` (`startCommandWakeListener` after the WS handler attaches, web/all role), app shutdown hook (`shutdownAllSessions`).

**Invariants:**
- **`agent.connected` / `agent.disconnected` must NAME the asset.** An `asset` Event with no `resourceName` gives an event automation an empty subject (`utils/alertSubject.eventSubjectLabel` returns "" for one), so every alert about an agent dropping rendered a widget row and an email that could not say WHICH host — the one fact those alerts carry. `attach` resolves `hostname || ipAddress` once and parks it on the Session so `detach` can name the device without a database read on a path that runs when the socket is already dead, and so both events agree on the label. Every other `agent.*` Event that names an asset does the same (`agentInstallService`'s runners pass the row they hold; its `fail*` helpers use `assetLabel`).
- **A reattach is what ENDS an upgrade or reinstall hold** (business rule 80), not the installer returning: the WS teardown trails the service stop by up to a heartbeat interval, so a hold released when the script exited lets the lagging `agent.disconnected` through. `attach` releases `agent-upgrade` and `agent-reinstall` only — an `agent-uninstall` hold ends with the uninstall, since nothing is meant to come back from one. The release is best-effort: its failure must not break the attach, and the hold's expiry covers it.
- Attach replaces any existing session for the same agentId (idempotent).
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

**What it owns:** Agent-run path checks — the `PathCheck` definition (HTTP / HTTPS / TCP / ICMP + optional traceroute), its validation, audited CRUD, and the materialized `PathCheckSource` membership (check × agent host, plus each pair's latest result). Also the agent-facing definition shape and its ETag fold.

**Public API:** `CHECK_KINDS`, `BODY_MATCH_MODES`, `MIN/MAX_INTERVAL_SEC`, `MIN/MAX_TIMEOUT_MS`, `MAX_ENABLED_CHECKS` (50), `MAX_CHECKS_PER_AGENT` (20), `MIN_AGENT_PATH_CHECK_VERSION` (0.21.0), `DEFAULT_TRACEROUTE`, `normalizeTraceroute`, `splitHostPort`, `targetHostOf`, `assertTargetHostAllowed`, `normalizeCheckInput`, `definitionSha256`, `toAgentCheckDef`, `listChecks`, `getCheck`, `createCheck`, `updateCheck`, `setCheckEnabled`, `deleteCheck`, `reconcilePathCheckSources`, `agentOnline`, `previewSources`, `listCheckResults`, `getAssetChecks`, `agentConfigChecks`, `pathCheckEtagFold`; types `PathCheckInput`, `NormalizedCheck`, `AgentCheckDef`, `CheckHttpConfig`, `CheckTracerouteConfig`, `ReconcileResult`.

**Cross-service deps:** `prisma`, `eventLogService.logEvent`, `agentCommandWake.publishConfigRefresh`, `notificationEngine.loadScopeAssetIds` (the scope resolver the engine itself uses — so a check's Sources can never disagree with an automation's Devices step), `notificationTypes.scopeIsUnconstrained`, `utils/netGuard.isBlockedOutboundHost`, `utils/httpCheck` (`parseStatusSpec`, `agentRegexProblem`), `utils/version.versionAtLeast`, `agentInstallService.AGENT_SERVER_URL_SETTING_KEY`.

**Used by:** `src/api/routes/pathChecks.ts` (CRUD / preview / results / filter-schema), `src/jobs/reconcilePathCheckSources.ts` (5-minute full reconcile).

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
- Delete cascades sources only; samples and traceroutes age out on retention (a row DELETE in a compressed chunk decompresses it).

**Wired into GET /agents/config and the heartbeat:** `agents.ts` ships `pathChecks: await agentConfigChecks(assetId, agentVersion)` in the payload (strong ETag covers it) AND folds `pathCheckEtagFold(...)` into `computeConfigEtag` as `conn`. **Both halves or neither** — the heartbeat etag is the only thing that makes a running agent refetch.

**When changing this:** a field the agent reads → `agentDefCore` + `transport.PathCheckDef` in `agent/internal/transport/client.go` + an `agent/VERSION` bump, in lockstep. A new kind → `CHECK_KINDS`, `targetHostOf`, the route's Zod enum, the agent's `ValidateCheckDef` + runner, and the modal. A new membership signal → the 5-minute job catches it; a write path that changes membership should reconcile inline.

---

## services/pathCheckIngestService.ts

**What it owns:** The server half of the agent's two path-check streams (`POST /agents/samples`, stream `pathCheck` and `pathCheckTraceroute`): authorization of each sample against the pushing host's sources, the body-excerpt policy, buffered sample writes, the source's latest-result columns, hop resolution, and path-change Events.

**Public API:** `ingestPathCheckSamples`, `ingestPathCheckTraceroutes`, `resolveHopContexts`, `excerptToKeep`, `hopIp`, `pathHashOf`, `sampleTime`, `PATH_CHANGE_EVENT_FLOOR_MS`; types `IngestResult`, `PathCheckSampleInput`, `PathCheckTracerouteInput`, `StoredHop`, `HopContext`.

**Cross-service deps:** `prisma` (`pathCheckSource`, `assetPathCheckTraceroute`, `asset`, one `$queryRaw`), `sampleWriteBuffer.enqueuePathCheckSamples`, `eventLogService.logEvent`, `metrics` (`recordPathCheckSamples`, `recordPathCheckPathChange`), `utils/cidr.isValidIpAddress`, `utils/httpCheck.MAX_EXCERPT_CHARS`.

**Used by:** `src/api/routes/agents.ts` (`POST /samples` — the two path-check arms return `{accepted, rejected}` of their own).

**Invariants:**
- **The subject is the pushing agent's own asset.** Nothing in the body names a host; `assetId` comes from `req.managedAgent`.
- **A sample for a check this host is not a source of is REJECTED**, counted in `rejected` and in `polaris_agent_path_check_samples_total{outcome="rejected"}` — never stored.
- **The excerpt policy is enforced HERE, not trusted from the wire** (`excerptToKeep`): kept only on a failed run or when the check keeps excerpts, re-cut to `MAX_EXCERPT_CHARS`. Hash + byte count are always stored.
- **Nothing here touches `monitorStatus` / `consecutiveFailures` / `lastMonitorAt` / the responseTime stream.** A path-check result describes a path from the host, not the host.
- **Every row is stamped `cadence: "fast"`** — the rollup SQL filters on it.
- **Hop resolution is ONE query per push** (`resolveHopContexts`: unnest + three LATERAL joins — primary `Asset.ipAddress`, then `AssetAssociatedIp` with the port name, then the most specific non-deprecated subnet via `cidr >>= inet`). Decommissioned assets skipped; `AssetIpHistory` deliberately not read (no `ip` index, and a live hop is not "who held it last month"). Hops are decorated at WRITE time, so a trace shows what Polaris knew when it was taken.
- **`pathHashOf` excludes RTTs and trailing silent hops** — the same route at a different latency, or timing out two TTLs later, is not a change.
- **`path_check.path_changed` is written only against a non-null previous hash** (the first trace, and the first after a target edit, is a baseline) and at most once per `PATH_CHANGE_EVENT_FLOOR_MS` (10 min) per (host, check) — ECMP flap is recorded in the rows, not in the Event table. It names the asset (`resourceType: "asset"`, `resourceName`) so an event automation's device filter applies to the HOST (business rule 46).
- A late-arriving older push never overwrites a newer latest result (`lastSampleAt` guard).

**When changing this:** a new sample field → `PathCheckSampleSchema` in agents.ts + `PathCheckSampleRow` (sampleWriteBuffer) + the Prisma model/migration + the Go `transport.PathCheckSample`, in lockstep; a rollup column also needs `sampleRollupService` + `sampleHistoryService.readPathCheckHistory`.

---
