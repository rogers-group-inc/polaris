# Services — Polaris Agent install, build, channel, commands

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

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

**Cross-service deps:** `prisma` (managed-agent updates), `logEvent`, `pg` (dedicated LISTEN client), `dbConnections.getDirectDatabaseUrl`, `agentCommandWake.CMD_WAKE_CHANNEL`.

**Used by:** `src/api/routes/agentsWs.ts` (attach on authenticated WS upgrade), `src/api/routes/serverSettings.ts` + `src/services/monitoringService.ts` (`sendProbeNow` / `refreshConfig`), `src/app.ts` (`startCommandWakeListener` after the WS handler attaches, web/all role), app shutdown hook (`shutdownAllSessions`).

**Invariants:**
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

**Public API:** `startInstall`, `startUninstall`, `startUpgrade`, `upgradeAllOutdated`, `UPGRADEABLE_INSTALL_STATUSES`, `canUpgradeFromStatus`, `renderAgentConf`, `inferOwnServerUrl`, `inferOwnServerUrlSync`, `AGENT_SERVER_URL_SETTING_KEY`, `StartInstallInput`, `StartUninstallInput`, `StartUpgradeInput`, `UpgradeAllResult`

**Cross-service deps:** `credentialService.getCredential`, `agentTokenService.mintEnrollmentToken`, `agentBuildService.getInventory`, `certInfo.getServerCertHostnames`, `publicUrl` port helper, `utils/agentUnit` (`linuxServiceBlock`/`normalizePrivilegeTier`/`AgentPrivilegeTier` — the privilege-tier → systemd unit mapping; re-exported from here), `logEvent`, `prisma`, WinRM helper.

**Used by:** `src/api/routes/assets.ts` (per-asset install / reinstall / upgrade / uninstall), `src/api/routes/serverSettings.ts` (upgrade-all), `src/services/agentAutoDeployService.ts` (`startInstall`), `src/services/agentBuildService.ts` (auto-upgrade hook).

**Invariants:**
- Fire-and-forget: kicks off an async runner, returns immediately.
- Platform/arch drives binary selection (inferred from `Asset.os`, arch defaults amd64); SSH needs username + (password OR privateKey), WinRM needs username + password.
- Uninstall (and force-remove) hard-deletes the ManagedAgent row on success, clears all polling columns (incl. `processesPolling`) so source defaults resume, AND tears the host off the Application Map — clears `mappedProcesses`/`mappedServices` + `deleteMany` its `AssetProcessConnection` rows in the same transaction (nothing collects them once the agent is gone, and pinned child nodes render from the pins regardless of connection rows). Upgrade replaces the binary only — `agent.conf` (bearer + pin) is untouched so the agent keeps its identity.
- Server-URL resolution order: Setting override → `POLARIS_PUBLIC_URL` → cert hostnames → fallback → localhost.
- **Linux privilege tier** (`ManagedAgent.privilegeTier`, Linux-only) selects the systemd `[Service]` block via `agentUnit.linuxServiceBlock`: `unprivileged` (default) or `ptrace` (+CAP_SYS_PTRACE +CAP_DAC_READ_SEARCH for Application Map attribution — the pair, not SYS_PTRACE alone; see the privilege-model entry). Full root is retired — never emitted for new installs/reinstalls; a legacy `root` row downgrades on reinstall. Reinstall conversion logic lives in the `POST /assets/:id/agent/reinstall` route (`assets.ts`), not here.

**When changing this:**
- `agent.conf` templating must stay in sync with the Go agent (pin set + enrollment-token format).
- Concurrent upgrades are pool-bounded so a fleet upgrade doesn't overwhelm hosts; `testOverrides` allow fake SSH for unit tests.
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

---
