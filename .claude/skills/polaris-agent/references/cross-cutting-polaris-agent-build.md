## cross-cutting/polaris-agent-build

**What it is:** In-app build pipeline that produces the six platform
agent binaries (linux/darwin/windows × amd64/arm64) and writes the
`manifest.json` consumed by the install/upgrade flows. Runs `go build`
directly in a child process (no `make` dependency — Windows hosts don't
ship GNU make). FIFO queue (depth 3) + per-build cancellation + post-
build auto-prune + boot-time auto-build are layered on top.

**Writers** (state that mutates):
- `src/services/agentBuildService.ts` — owns everything: state map,
  FIFO queue, mutex, per-build child-process handle, version reads,
  manifest writes, post-build prune. Exports:
  - `goAvailable()` — runs `go version`, no cache. UI / route gate on this. Returns `ok` (the binary ran) *and* `meetsMinimum` (the parsed minor line is ≥ `GO_MINIMUM`); `startBuild()` and the auto-build both refuse when the toolchain is present but too old, instead of failing later inside `go build`. An unparseable version counts as meeting the minimum — a vendored or `devel` toolchain must not be refused.
  - `startBuild({actor})` — queues or runs immediately. 400 on no-Go,
    409 on queue-full (`BuildQueueFullError`). Emits `agent.build.started`
    (immediate) or `agent.build.queued` (enqueued).
  - `cancelBuild(buildId, actor)` — three branches: queued (splice from
    queue), in-flight (SIGTERM + SIGKILL after 5s grace, set
    `state.cancelled` so runBuild sees CancelledError), already-finished
    (`BuildAlreadyFinishedError` → route 409). Emits `agent.build.cancelled`.
  - `pruneOldAgentVersions()` — policy is keep-current + keep-in-use +
    keep-last-N (env `POLARIS_AGENT_KEEP_VERSIONS`, default 3). Fires
    after every successful build + on operator click of the Clean-up
    button on the Maintenance card. Emits `agent.versions.pruned` with
    `trigger: "post-build"|"manual"`.
- `src/api/routes/serverSettings.ts:/agents/*` — admin-only routes
  exposing the service: inventory, build start/poll/current/cancel,
  prune, installed-summary (returns active count + per-version histogram
  + live `upgrading` and `upgradeFailed` counts so the UI can poll for
  in-flight upgrade-all status), installed (full per-host list — one row
  per ManagedAgent joined with a thin Asset slice for the "Installed
  agents" slide-in on the Polaris Agents tab; drives per-host
  reinstall/upgrade/remove via the `/assets/:id/agent/*` routes),
  upgrade-all (delegates to `upgradeAllOutdated` in agentInstallService),
  auto-build-setting GET+PUT, auto-upgrade-setting GET+PUT.
- `src/jobs/autoBuildAgents.ts` — one-shot startup job, fires 60s after
  boot. Five gates in order: manifest exists, version drift, Go
  available, kill-switch off, then `startBuild({actor: "system:auto-
  build-on-version-change"})`. Emits `agent.build.auto_started` (info)
  or `agent.build.auto_skipped` (warning, with reason).
- `src/services/agentInstallService.ts:startUpgrade({managedAgentId,
  credentialId?, actor})` — SSH/WinRM-driven binary swap that preserves
  agent.conf. Transitions installStatus active → upgrading → active.
  Emits `agent.upgrade_kickoff`, `agent.upgrade_succeeded`,
  `agent.upgrade_failed` — plus `agent.upgrade_skipped` from
  `upgradeAllOutdated` when a row refuses BEFORE `installStatus` moves, which
  is the only trace such a row leaves (rule 49). The credential + transport
  come from `resolveUpgradeCredential`, not straight off the row. Which statuses may start one is the exported
  `UPGRADEABLE_INSTALL_STATUSES` / `canUpgradeFromStatus` in the same file
  — `active` **plus `upgrade_failed`**, since every failure path leaves the
  old binary and agent.conf in place. THREE readers must keep using that
  predicate rather than testing `=== "active"`: the guard here,
  `upgradeAllOutdated`'s Prisma filter, and the `outOfDate` flags on
  `/server-settings/agents/installed` + `/installed-summary` (the latter
  gates the Upgrade-all button and supplies its confirm count). When they
  disagreed, one unreachable moment was permanent: the row left the
  fan-out's filter AND its own Retry Upgrade button 409'd, leaving
  uninstall/reinstall as the only route back to a current agent.
  The bulk path lives in
  `upgradeAllOutdated(actor)` (same file) — Promise pool of 4 over every
  upgradeable ManagedAgent whose agentVersion lags `manifest.currentVersion`.
  Called from both the operator-initiated `POST
  /server-settings/agents/upgrade-all` and the post-build auto-upgrade
  hook in `finalizeBuild` (agentBuildService.ts) gated on
  `Setting.agent.autoUpgradeOnNewBuild`. Auto-path emits
  `agent.upgrade_all_auto_kickoff` so the audit trail distinguishes
  human-initiated from build-triggered fan-outs.
- `src/utils/version.ts:getAgentVersion()` / `getAgentSourceDir()` —
  readers of `agent/VERSION` (not writers, but documenting here for
  proximity). 5s mtime-checked cache; format-validated; fallback
  `"0.0.0-no-version-file"`.
- `src/services/agentSigningService.ts` — internal-CA code signing of the
  two Windows binaries as a post-build step (opt-in via the
  `agent.codeSigning` Setting; Integrations → Polaris Agents → Code
  signing). Owns the masked-secret config (keystorePassword follows the
  notificationChannelService MASK/merge discipline, and is registered in
  `utils/configSecretFields.ts` so it is SEALED at rest — renaming it
  without touching that set stores the password in plaintext), the
  `java -jar jsign.jar --storetype PKCS12` invocation (password via env
  `POLARIS_SIGNING_PASSWORD`, never argv) with an EXPLICIT `--tsaurl` +
  `--tsmode RFC3161` (PKCS12 gets no automatic countersignature, so this
  is what keeps signatures valid past cert expiry), the keytool-backed (bare
  name, then the JVM's own `java.home` — the headless JDK ships keytool beside the JVM, so a PATH miss is NOT an absent tool; a real absence only degrades the Test message, signing never uses keytool) keystore/alias check behind the Test button, the `signingAvailability()`
  probe (java on PATH + jar candidates + keystore READABILITY), and the
  durable `agent.signing.lastFailure` Setting behind the sidebar alert, and the operator keystore upload (`installKeystore` validate-then-rename into `SIGNING_DIR`, which is under `data/` and NOT `UPLOADS_DIR` — that one is served at `/uploads/<file>`, so a keystore there would be downloadable; `removeManagedKeystore` only ever touches the managed path).
  `agentBuildService.signWindowsBinaries()` calls it between the platform
  loop and the manifest write; phase `"signing"`, steps `sign / windows-<arch>`. **FAIL-OPEN:** a failure emits `agent.build.sign_failed` (warning) + stamps the failure Setting but the build completes and ships unsigned — never blocks agent rollout.
  A fully-signed build (or disabling signing) clears the stamp. Routes:
  `GET/PUT /server-settings/agents/signing` (PUT =
  `serverSettingsSystem:fullwrite`) + `POST .../signing/test`
  (token-fetch dry run); the alert feed is
  `GET /assets/agent-signing-alert` gated `assets:write` (the
  agent-deploy permission — deliberately NOT under /server-settings,
  whose router-level gate only admin passes), polled every 30s by
  `pollSigningAlert()` in `public/js/app.js` with per-user-per-failure
  localStorage dismissal (`polaris.signing-alert.dismissed.<username>`).
- `deploy/setup-{rhel,ubuntu,windows}{,-nodb}.{sh,ps1}` — install Go
  alongside Node + mkdir `$APP_DIR/data/agents` + `$APP_DIR/.cache/go-build`;
  also install Java 25 headless + the SHA-256-pinned jsign jar to
  `$APP_DIR/tools/jsign.jar` (warn-don't-abort — signing is opt-in).
- `Dockerfile` — pulls `golang-go` from trixie-backports (the suite must track the base image); pre-creates
  `/app/state/.cache/go-build`; installs `openjdk-25-jre-headless` by NAME + the
  pinned jsign jar at `/opt/polaris/tools/jsign.jar`.

**Readers** (consume state):
- `public/js/server-settings.js:initAgentBuildCard` — Maintenance-tab
  Polaris Agent card. Three states (inventory / progress / progress-
  queued-behind). Auto-poll every 2s while running. Sub-features:
  Upgrade-all line, Clean-up button, Auto-build toggle, × cancel buttons
  on in-flight + queued rows.
- `public/js/assets.js:assetAgentSubpanelHTML` — Upgrade button on
  active agents; Retry Upgrade on `upgrade_failed` (which the route now
  accepts). `_isTransientAgentState`
  includes `"upgrading"` so the existing 3s poll picks it up.
- `public/js/agent-build.js` installed-agents rows — the per-row Upgrade
  button keys on `outOfDate` alone (the server already folds the
  upgradeable-status test into that flag) and relabels to "Retry upgrade"
  on an `upgrade_failed` row.
- `src/api/routes/agents.ts:agentsBinaryRouter` — `GET /api/v1/agents/binary/:filename`
  serves binaries the Build command produced. Whitelist-checked against
  the current manifest's `binaries` map.

**Invariants:**
- `agent/VERSION` (text file) is the single source of truth. `getAgentVersion()`
  reads it server-side; `agent/Makefile`'s `VERSION` directive reads it shell-side.
  Both feed the same `-ldflags '-X main.version=…'` flag so the in-binary version,
  the manifest's currentVersion, and the directory name all match.
- Single-slot active build + FIFO queue (depth 3). Queue overflow → 409;
  Go missing → 400.
- Per-platform `go build` invocations are serial. Parallel builds would
  thrash the shared GOCACHE for negligible wall-clock win.
- `manifest.json` is written atomically (write `.tmp` + rename) AFTER all
  six platforms succeed. Cancelled mid-flight builds leave a partial
  set under `data/agents/<version>/` but the existing manifest still
  points at the previous version's filenames.
- Signing (when enabled) runs AFTER the platform loop and BEFORE the
  manifest write — jsign mutates the .exe in place, and nothing
  downstream hashes the binary bytes (integrity = the agent's TLS cert
  pin), so in-place signing is safe. If a per-binary hash is ever added
  to the manifest, compute it after signing. Signing failures are
  fail-open by explicit operator decision: build completes, warning
  Event + failure-stamp Setting + sidebar alert instead of a block.
- Prune helper NEVER touches the current version, NEVER touches versions
  in use by a live ManagedAgent (`installStatus !== "revoked"`), and
  ALWAYS keeps the most recent N (default 3, env `POLARIS_AGENT_KEEP_VERSIONS`).
- Auto-build refuses to fire on a fresh install (no manifest = operator
  hasn't opted in). Also refuses when Go isn't available (logs warning
  Event) or when `Setting.agent.autoBuildOnVersionMismatch === false`.
- Upgrade does NOT touch agent.conf. Bearer + cert pin survive; agent
  reconnects with the same identity after the binary swap.

**When changing this:**
- Adding a new platform/arch: extend `PLATFORMS` in `agentBuildService.ts`
  AND `manifest.binaries` shape in `agent/internal/transport/client.go`
  enroll request AND the install/upgrade script templates AND `Dockerfile`'s
  GOARCH support if shipping Polaris on that platform.
- Adding state to BuildState that isn't JSON-serializable: extend `publicView()`
  to drop it before returning to API consumers.
- Touching the install script templates: bump agent/VERSION so deployed
  agents pull the new bytes; the install path is templated server-side so
  changes ship via the next server release, not via agent rebuild.
- Adding a new upgrade-class action (e.g. config-only refresh): add it to
  `_isTransientAgentState` so the asset-details panel's auto-poll picks
  it up.
- Bumping the pinned jsign version: update the version + SHA-256 in ALL
  of `Dockerfile`, all six `deploy/setup-*.{sh,ps1}`, and the manual
  install one-liners in `docs/INSTALL.md` ("Optional: Code signing").
  The default jar probe paths in `agentSigningService.JSIGN_JAR_CANDIDATES`
  are version-less (`tools/jsign.jar`), so only the download sites move.

---
