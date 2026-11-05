# Code-quality ledger

The working backlog of the whole-application code-quality review started 2026-11-04:
dead code, duplicated helpers, inconsistent patterns, efficiency, and the structure of the
largest files. Every row was verified against the tree at `b8011b73c` (by tool output or by
reading the code) before it was written here. Survey claims that turned out to be wrong are
kept at the bottom so nobody "fixes" them later.

A fix commit flips its row's status to `fixed@<sha>` in the same commit. Line numbers drift;
grep the symbol.

## How to use it

- **Tier 1** is the low-risk pass (dead code, consolidating byte-identical helpers). It is
  being worked now, one worktree per batch (B0 to B7 below).
- **Tier 2** (efficiency and consistency) and **Tier 3** (splitting the giant files) are
  planned, not started. Each row is sized to be one session; pick by value over risk.
- Anything touching jobs, discovery, monitoring or a per-asset query states its behaviour at
  100 and at 2000 monitored assets in the commit message (CLAUDE.md scale-check rule).

## The guards

| Command | What it does | Where it runs |
|---|---|---|
| `npm run check:dead` | knip over `src/`, `scripts/`, `prisma/`, `tests/`. Unused files, unused or unlisted dependencies and unresolved imports are errors. Unused exports and types are warnings until batch B2 lands, then errors. | pre-commit (on `.ts`, `package.json`, `knip.jsonc`, `tsconfig.json`), CI `test` job |
| `npm run check:dead:prod` | knip in production mode, report only. Lists exports reached only by a test. | by hand |
| `npm run check:dup` | jscpd over `src/`, `public/js/`, `scripts/`, `prisma/`. A report, never a gate; JSON lands in the gitignored `audit-reports/jscpd/`. | CI `test` job (informational) |
| `noUnusedLocals` | in `tsconfig.json`, enforced by `npm run typecheck`. Covers `src/` only (tests are not type-checked). | pre-push habit, CI |
| `npm run lint` | now expected to report **0 problems**, warnings included. | CI |

`public/` is outside knip on purpose: it has no module system, so every file would read as
unused. Frontend dead code is found by `grep -rw NAME public tests` and the happy-dom tests.

**Baseline at `b8011b73c`:**

| Measure | Count |
|---|---|
| Unused files (knip) | 2 → `src/models/types.ts`, `src/services/projectionDriftService.ts` |
| Unused exports / types (knip strict) | 504 / 281 |
| Duplicate exports (same value under two names) | 13 |
| Exports reached only by tests (production run minus strict run) | about 1,450 |
| jscpd clones | 339 (JS 180 clones, 2,785 lines; TS 159 clones, 2,350 lines) |
| `noUnusedLocals` errors / ESLint warnings | 20 / 26 → 0 / 0 (fixed in B0) |

## Row schema

`id` · `kind` · `where` · `canonical` (duplicate rows only) · `summary` · `risk` (L/M/H) ·
`effort` (S/M/L) · `tier` · `status` · `verified-by`

Kinds: dead-file, dead-export, dead-function, dead-global, dead-css, dup-helper,
canon-violation, efficiency, structure, lint, test-only, bug.

Status: `verified` → `fixed@<sha>` / `wontfix (reason)` / `test-only` / `deferred`.

**Test-only exports.** An export only a test reaches gets status `test-only`. Keep it when
the function has callers in its own file and the test is its specification. When it has no
production caller at all, move the test onto the real code path and delete the function.

## Tooling (T)

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-T001 | lint | `package.json` | No dead-code, duplication or dependency-graph tool existed. knip + jscpd added with `check:dead`, `check:dead:prod`, `check:dup`. | L | S | 1 | fixed@b6522808b | read |
| CQ-T002 | lint | `tsconfig.json` | `noUnusedLocals` was off; 20 unused locals had accumulated. Enabled and cleared. | L | S | 1 | fixed@a14685cf2 | tsc |
| CQ-T003 | lint | `eslint.config.mjs` scope | 26 warnings (25 unused vars, 1 stale disable directive). Cleared; lint reports 0. | L | S | 1 | fixed@a14685cf2 | eslint |
| CQ-T004 | dead-export | `package.json` devDependencies | `@types/express-rate-limit` and `@types/netmask` duplicated types both packages ship; `@types/xml2js` had no consumer. Removed. | L | S | 1 | fixed@b6522808b | knip |
| CQ-T005 | lint | `.githooks/pre-commit`, `docker-publish.yml` | knip in the hook and the CI `test` job; jscpd as an informational CI step. | L | S | 1 | fixed@f9f1b3666 | read |
| CQ-T006 | lint | `knip.jsonc` | Flip `exports` / `types` from warn to error. After the un-export (5b4e70834) 64 warnings remain: the CQ-B014 deletion candidates, three unused test-helper exports, and `HandlerTimeoutPressure` (needs a knip ignore). Flip once CQ-B014 lands. | L | S | 1 | fixed@d1ac410f0 | knip |
| CQ-T007 | lint | `agent/` | Nothing runs `gofmt`, `go vet` or `go test` on the agent anywhere; CodeQL is nightly only. Moves to B7 because the agent rebuild contract bumps `agent/VERSION` on any agent edit. | L | S | 1 | fixed@618592773 | read |
| CQ-T008 | dead-export | `package.json` dependencies | `@types/ws` sits in `dependencies`, not `devDependencies`. | L | S | 2 | verified | read |
| CQ-T009 | structure | `tests/` | 287 test files hand-roll `vi.mock("../../src/db.js")`; `eventLogService` is mocked in 90. Five local `makeAsset` factories. A shared stub factory would cut the boilerplate. | M | L | 3 | verified | grep |
| CQ-T010 | structure | `src/services/` | 171 of 285 services have no unit test file named after them; 25 are not imported by any test (largest: `subnetRefreshService`, `monitorSettingsService`, `savedFolderService`). Rule: one test per service you next touch. | L | L | 3 | verified | grep |

## Backend (B)

### Dead files and code

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-B001 | dead-file | `src/services/ipService.ts` | Only its own test imports it; `utils/cidr.ts` owns the math. The `ipam-reservations` skill entry wrongly says reservations routes use it. Delete with its test. | L | S | 1 | fixed@3401a55e8 | grep |
| CQ-B002 | dead-file | `src/services/projectionDriftService.ts` | `detectAndLogDrift` has no caller. About ten skill references describe it as live. | L | M | 1 | fixed@c95e3d1fa | knip |
| CQ-B003 | dead-file | `src/models/types.ts` | Nothing imports it (augmented Prisma result shapes, re-exported enums). | L | S | 1 | fixed@3401a55e8 | knip |
| CQ-B004 | dead-file | `src/jobs/integrationConnectionTester.ts` | Disabled in `app.ts` since 2026-06-02 "pending removal". Remove with its metric (`recordIntegrationTest`, `polaris_integration_test_total`), the Grafana panel, and the comments in `discoveryEngine.ts` and `discoveryScheduler.ts` that still say it refreshes `lastTestOk` every 10 minutes. | L | M | 1 | fixed@c86a581ae | read |
| CQ-B005 | dead-function | `discoveryEngine.ts` `sidTag`, `isMeaningfulSid`; `notificationEngine.ts` `runFor` | Uncalled. | L | S | 1 | fixed@a14685cf2 | tsc |
| CQ-B006 | dead-export | `src/utils/*` | About 56 UPPER_CASE constants and 35 functions/types exported but used only in their own file (`burstPing` 8, `stateProbes` 5, `haAdvisories` 5, `wildcard.globMatches`, `dbRetry.extractPgCode`, `routePath.resolvedRequestPath`, `remoteExec.sshRunOne`). Un-export. knip's list is the authority. | L | M | 1 | fixed@5b4e70834 | knip |
| CQ-B007 | dead-export | `src/services/*` | The rest of knip's 504 + 281 (top: `notificationTypes` 62, `monitoringService` 23, `pathCheckService` 16, `credentialService` 16, `genericApiService` 14). Same treatment as B006. | L | M | 1 | fixed@5b4e70834 | knip |
| CQ-B008 | dead-export | 10 route files (`automationScripts`, `calendar`, `contacts`, `firmware`, `logFlagRules`, `maintenanceSchedules`, `notificationRules`, `notifications`, `pathChecks`, `pwa`) | Each exports its router both named and as `default`. Keep one form. | L | S | 2 | fixed@5b4e70834 | knip |
| CQ-B009 | dead-export | `alertChartService` `CHART_WINDOW_MS`/`STORAGE_USAGE_WINDOW_MS`, `pollingCompatibility` `VCENTER_STREAMS`/`PROXMOX_STREAMS`, `regionHierarchy` `levelByDepth`/`DEFAULT_LEVEL_RULE` | One value under two exported names. Check whether the alias is meaningful (two concepts that happen to be equal) before merging. | L | S | 2 | fixed@5b4e70834 | knip |
| CQ-B010 | test-only | about 1,450 exports | Reached only by tests (top: `nocDashboardService` 45, `monitoringService` 41, `notificationEngine` 40, `vcenterService` 31). Most are legitimate test seams; triage per the policy above. | L | L | 2 | test-only | knip-prod |
| CQ-B014 | dead-function | about 45 production symbols nothing calls, still exported only so `noUnusedLocals` does not fail: `agentChannelService` `sendProbeNow` / `liveSessionCount` / `shutdownAllSessions`, `queueService.publishMonitorJob`, `haHeartbeatService.readActiveInstance`, `mapRegionService.getRegion`, `roleService.getRoleByName`, `savedDashboardService.getSavedDashboard`, `oidRegistry` `listModelOverrides` / `getMibSymbolCount` / `resolveSymbolForMib`, `ouiService.lookupOuiBatch`, `remoteExec.sshRunOne`, the `__reset…ForTests` / `_reset…` hooks no test calls, and unused types (`CredentialConfig`, the four `timescaleService` table-name types, `ScriptAction`, `RebootAction`, `EscalationTierV2`, …). `npm run check:dead` lists them all. | Delete in one reviewed batch WITH its doc sync: about 60 skill passages name these as public API, and several are already wrong about them (agent-services.md says `sendProbeNow` backs /probe-now and is called from monitoringService; it is not). Keep the credential config interfaces (`SshConfig` and siblings carry the field documentation business rule 21 cites); give `CredentialConfig` a consumer or a knip `@public` tag instead. | M | M | 1 | fixed@446f42c60 (sendProbeNow + CredentialConfig kept under `@public`; shutdownAllSessions deleted, never wired) | knip+tsc |
| CQ-B011 | test-only | `logFlagRuleService.globToRegExp` | No production caller ("kept for reference / display only"). Delete it and its describe block. | L | S | 1 | fixed@343251f46 | read |
| CQ-B012 | dead-code | `monitoringService.ts` legacy tier settings types | Marked `@deprecated`. Remove once no stored setting carries the legacy shape. | M | S | 2 | verified | read |
| CQ-B013 | dead-code | May one-shot jobs (`clampAssetAcquiredAt`, `scrubLegacySidGuidTags`, `normalizeManufacturers`, `migrate*`) | Run markers make them no-ops on every boot. Retire once every install has run them; needs a minimum-upgrade-path decision. | M | S | 2 | verified | read |

### Duplicated helpers

| id | kind | where | canonical | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|---|
| CQ-B020 | dup-helper | `dependencyTreeService.chunk`, `directorySyncService.chunk`, `utils/burstPing.chunk`, `mapRegionService.chunk50`, `discoveryEngine.chunkIds` | `utils/chunk.ts → chunkArray` | Five private copies. `chunkArray` throws on size < 1; every site passes a constant ≥ 1. `lossSweep.chunkForSweep` stays as a wrapper (own default and test). | L | S | 1 | fixed@ddb676962 | read |
| CQ-B021 | dup-helper | inline `slice(i, i + N)` loops in `routes/assets.ts`, `genericApiNetworkSync`, `duplicateSerialConflictService`, `firmwareGroupService`, `softwareInventoryService`, `vcenterService` | `chunkArray` | Each sits inside a loop body with other state; convert case by case. | L | S | 2 | verified | grep |
| CQ-B022 | dup-helper | `azureArcService.sleep(ms, signal)`, `fortimanagerService.sleepWithAbort`, `updateService` local `sleep` | `utils/sleep.ts` gains an optional `signal` (resolve on abort) | `firmwareEngines/types.sleep` is NOT a copy: it rejects with AbortError and the engines depend on that. | L | S | 1 | fixed@16f74cc89 | read |
| CQ-B023 | dup-helper | regex escape in `alertRenameService`, `efficiencyAdvisorService`, `logFlagRuleService`, `unraidService`, `vcenterService` (×2), `utils/snmpIdentity` | new `utils/regex.ts → escapeRegExp` | Seven identical character classes. (The plan expected this to also hoist the RegExp out of the `unraidService` and `snmpIdentity` loops; it cannot, because both patterns depend on the loop variable.) | L | S | 1 | fixed@2b51c7531 | read |
| CQ-B024 | dup-helper | `agentHostPinService.normalizeHex` (+ an inline copy) | `tlsCertPinService.normalizeFingerprint` | Byte-identical; the import direction already exists. | L | S | 1 | fixed@df09157a9 | read |
| CQ-B025 | dup-helper | tag append `[...kept, ...tags.filter(t => !kept.includes(t))]` ×7 in `discoveryEngine`, `genericApiSync`, `workloadSync`, `assetBulkTagService` | new `tagNormalize.appendMissingTags` | `unionTags` is NOT a drop-in: it trims, case-folds and sorts. The new helper must be exact-match and order-preserving so every written array stays byte-identical. Read `asset-tag-mutators.md` first. | M | S | 1 | fixed@089a9a5f5 | read |
| CQ-B026 | dup-helper | `monitoringService.toPositiveInt`, `migrateMonitorSettingsHierarchy.toInt` | new `utils/num.ts` | The only byte-identical pair. | L | S | 1 | fixed@7070f212a | read |
| CQ-B027 | dup-helper | `toInt` / `asNumber` / `numOrNull` / `pickFiniteNumber` / `clampPct` / `clamp` variants (about 9) | — | Distinct contracts (null vs fallback, trimming, number passthrough). Consolidate only where a contract matches. | M | M | 2 | verified | read |
| CQ-B028 | dup-helper | `routes/agents.ts formatMacColonUpper`, `entraIdService.formatMac`, `ipUpstreamChainService.macKey` | `utils/mac.ts` | Two are one-line wrappers; `macKey` is hand-rolled (verify equivalence first). | L | S | 1 | wontfix (both wrappers already delegate to normalizeMacOrNull and only adapt input/output; macKey is not equivalent — no 12-hex validation, keeps all-zero and dotted forms, so swapping changes matching) | read |
| CQ-B029 | dup-helper | `pathCheckServerRunner.withTimeout`, `serverTraceroute.withTimeout`, five ad-hoc `Promise.race` timeouts | — | Settle and error semantics differ per site. | M | M | 2 | verified | read |
| CQ-B030 | dup-helper | `softwareInventoryService.runPool`, `discoveryEngine.batchSettled`, the pool in `fortimanagerService` | `utils/concurrency.ts → mapWithConcurrency` | Differ in settle-all vs fail-fast. | M | M | 2 | verified | read |
| CQ-B031 | dup-helper | `split(".")[0]` short hostname ×5 | — | A one-expression idiom; the hostname utils carry business rules and are the wrong home. | L | S | — | wontfix (idiom) | read |
| CQ-B032 | dup-helper | `syncLog` closure ×9 (`discoveryEngine` ×6, `genericApiSync`, `genericApiNetworkSync`, `workloadSync`) | new `discovery/syncLog.ts → makeSyncLog` | Same `integration.sync` event writer. | L | S | 2 | verified | read |
| CQ-B033 | dup-helper | `firmwareResultEmailTemplate.ts` ↔ `rebootResultEmailTemplate.ts` (68 lines); `firmwareScheduleService` ↔ `rebootScheduleService` (59 lines) | — | Parallel result-email and booking code; a shared base would keep the two from drifting. | M | M | 2 | verified | jscpd |
| CQ-B034 | dup-helper | `fortigateService` ↔ `fortimanagerService` (152 lines) | — | Expected parity surface (CLAUDE.md); shared parsing belongs in one helper the two transports call. | M | M | 2 | verified | jscpd |
| CQ-B035 | dup-helper | `jobs/monitorAssets.ts` ↔ `monitoringService.ts computeDueWork` (69 lines) | — | Documented lockstep twins. Extract the shared due-check so the lockstep is enforced by code. | M | M | 2 | verified | jscpd |
| CQ-B036 | dup-helper | `discoveryEngine` ↔ `genericApiSync` ↔ `workloadSync` (37 to 52 lines each pair) | — | Same projection / sweep steps in each sync. | M | M | 3 | verified | jscpd |

### Inconsistent patterns

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-B040 | canon-violation | route query parsing | Pagination parsed four ways in about 12 route files; boolean query flags coerced 8 different ways. A `utils/queryParams.ts` (`intParam`, `boolParam`, `pageParams`) reproducing each site's default and cap. The Zod-coerce routes stay as they are. | M | M | 1 | fixed@9b12b270b | grep |
| CQ-B041 | canon-violation | `src/jobs/*` | No job wrapper: each of 87 jobs hand-rolls `setTimeout` + `setInterval` + try/catch + `runInstrumentedJob`. Errors logged at warn in 32 files and error in 55, in six payload shapes. A `defineJob({ name, firstRunDelayMs, intervalMs, run })` in `_metrics.ts`. | M | L | 2 | fixed: helper 0e64acc56, 32 jobs 3fc5d0489, last 11 + intervalAfterFirstRun 2dbbdc946 — every periodic job on defineJob (overlap skip + error-level { err, job }, operator decision); source guard in defineJob.test.ts | read |
| CQ-B042 | canon-violation | `process.env` in ~25 services | `POLARIS_PUBLIC_URL` read in 7 places despite `utils/publicUrl.ts`; `POLARIS_PROXY_CERT_PATH` in 6 despite `utils/proxyMode.ts`. Route through the existing modules; no new god-module. | L | M | 2 | verified | grep |
| CQ-B043 | canon-violation | `routes/integrations.ts` | About 228 Zod schema references inside handlers rather than at the top of the file. | L | M | 2 | verified | grep |
| CQ-B044 | canon-violation | `routes/auth.ts` (23), `tags.ts` (10), `map.ts` (5), `mibs.ts` (1) | Inline Prisma in route files that are not on CLAUDE.md's legacy list. Extract to services, keeping each mutation's `logEvent`. | M | M | 2 | verified | grep |
| CQ-B045 | canon-violation | 21 sites (`agentlessProcessService` ×4, `pathCheckServerRunner` ×2, `automationActionService` ×2, `auth.ts` ×2, …) | Services throw plain `Error` instead of `AppError`. The two in `middleware/permissions.ts` are programmer-error asserts and may stay. | L | S | 2 | verified | grep |
| CQ-B046 | canon-violation | about 20 `.then(` chains (`dashServer`, `alertChartService`, `appMapDiscoveryService`, `firmwareUpgradeService`, …) | CLAUDE.md says async/await. Serialisation chains (`appMapDiscoveryService`, `assetQuarantineService`, `discoveryDurationService`, `fortimanagerService`) are legitimate and stay. | L | S | 2 | verified | grep |
| CQ-B047 | canon-violation | `.env.example` | `POLARIS_PATRONI_REST` and `POLARIS_BUILD_COMMIT_COUNT` are read by code but undocumented there. | L | S | 2 | verified | grep |

### Efficiency

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-B050 | efficiency | awaited Prisma calls inside `for` loops: `discoveryEngine` 55, `notificationEngine` 32, `quietTimeSummaryService` 8, `directorySyncService` 8, `firmwareGroupService` 6, `dependencyTreeService` 6, `subnetRefreshService` 5 | Batch with `$transaction([...])` or `Promise.all` where order does not matter. Some loops are deliberately sequential; check each. Scale-check at 2000 assets. | M | L | 2 | verified | grep |
| CQ-B051 | efficiency | `monitoringService` probe loads (about 10 sites) and `routes/agents.ts computeConfigEtag` | Each includes the full `Credential` rows and the whole `discoveredByIntegration` row (config blob). Derive the `select` from `AssetMonitorContext`'s keys (`satisfies Record<keyof …, true>`); never hand-list columns, because an omitted optional override silently reads as "inherit" (2026-09 audit warning). | H | M | 2 | fixed@bd582c82f — as an OMIT of the five unused JSON blobs, not the derived select (collectors read far beyond AssetMonitorContext); computeConfigEtag also stops loading the integration config | tsc+grep |
| CQ-B052 | efficiency | `asset.findMany` with no `select`: `appMapDiscoveryService`, `connectionPathService` ×2, `controllerChildrenService`, `deviceFilterService`, `searchService` ×5, `jobs/auditPollingCapability` | Full rows loaded where a few columns are read. | L | M | 2 | verified | grep |
| CQ-B053 | efficiency | sort comparators calling `new Date(x).getTime()` per comparison: `discoveryEngine` ×4, `routes/agents.ts`, `agentBuildService`, `pathCheckIngestService` | Decorate-sort-undecorate. | L | S | 2 | fixed@345b645f3 (9 sites; a bad time now sorts oldest instead of NaN) | grep |
| CQ-B054 | efficiency | `JSON.stringify` equality ×7 (`alertGroupService`, `credentialUseAuditService`, `directorySyncService`, `duplicateReservationConflictService`, `eventLogService` ×2, `mapRegionService`) | Key-order sensitive: two equal objects built in different orders compare unequal. Check each for a real false-negative before changing. | M | S | 2 | fixed@5aba13223 — REAL BUG: jsonb reorders keys, so 6 of 7 sites saw a change on every pass (directory sync rewrites, duplicate-reservation refreshes, alert-group retires) | grep+pg17 |
| CQ-B055 | efficiency | `.filter(x => list.includes(x))` over subnet lists in `fortigateService`, `fortimanagerService` | O(n²) on per-gate subnet objects; use a `Set`. | L | S | 2 | fixed@4b04e20a7 | grep |

### Structure

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-B060 | structure | `discoveryEngine.ts syncDhcpSubnets` | One function of about 5,700 lines (half the file). Split along its existing phase comments into `discovery/dhcp/phase-*.ts` sharing one context object. | H | L | 3 | verified | read |
| CQ-B061 | structure | `monitoringService.ts` (15k lines) | Nine clusters: settings resolution, probes, generic collectors, Fortinet REST, SNMP core and collectors, result recording, probe outcome, per-stream runners and scheduler, retention. | H | L | 3 | verified | read |
| CQ-B062 | structure | `routes/assets.ts` (7.5k lines, about 110 routes, 154 inline Prisma calls) | Sub-routers under one `assetsRouter`, extracting services as each moves. | M | L | 3 | verified | read |
| CQ-B063 | structure | `notificationEngine.ts` (7.7k), `notificationTypes.ts` (6.3k, 287 exports) | Readings, threshold evaluation, alert groups and the preview API are separable. | M | L | 3 | verified | read |
| CQ-B064 | structure | no shared integration interface | Dispatch is an if-chain on `integration.type`, written twice: `runPreflightTest` (stored integrations; `POST /:id/test` has called it since c86a581ae, which deleted a third copy) and the draft `POST /integrations/test` route, which tests a narrowed unsaved config with no integration id. `triggerDiscovery` hand-writes the per-type required-field checks a third way. Each integration names its own test/discover functions. An adapter interface would turn the ~30-callsite onboarding checklist into a type error. | M | L | 3 | verified | read |

## Frontend (F)

### Dead code

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-F001 | dead-function | `assets.js` `_viewLeaseActionHTML`, `_vcUsageBar`, `_probeMethodLabel`, `bulkOuiLookup`, `_isUploadedMib`, `_credentialOptionsFor`, `_credentialOptionsForAny`, `_monsetField`, `_monsetOverrideSummary`, `_monsetDirectPollWarningHTML` | Defined, never referenced in `public/` or `tests/`. | L | S | 1 | fixed@96f557a70 | grep |
| CQ-F002 | dead-function | `server-settings.js _capacityFormatPct`; `automations-wizard.js holdClause`, `triggerDurationMinutes`; `integrations.js _polarisReadCredFourStream`; `map.js fortigateNodeColor`; `users.js checkPasswordMatch`; `assets-maintenance.js _maintFmtDate`; `automations-portability.js diffRowsHtml`; `ipam.js tabButton` | Same. | L | S | 1 | fixed@96f557a70 | grep |
| CQ-F003 | dead-function | `app.js` `isNetworkAdmin`, `isAssetsAdmin`, `hexToRgba`, `tagsToArray`, `tagsToString` | Same. `toggleTheme` stays: the canon keeps it as an alias. | L | S | 1 | fixed@96f557a70 | grep |
| CQ-F004 | test-only | `integrations.js _titleForType`, `server-settings.js _tagRegistryChipHTML`, `users.js collectRegionPicker` | Only tests call them. Move the assertions to the rendered DOM, then delete. | L | S | 1 | partly fixed: _titleForType@1a9038354; _tagRegistryChipHTML was a live-bug, see CQ-F009; collectRegionPicker moves to CQ-F008 | grep |
| CQ-F005 | dead-global | `window.__polarisUser` (mobile/app.js), `_notifGetSchema`, `_notifLoadRules` (automations.js), `_pollFailedIntegrations`, `_pollSigningAlert`, `_pollPlatformAdvisories` (app.js) | Written, never read. | L | S | 1 | fixed@96f557a70 | grep |
| CQ-F006 | dead-global | `users.js REGION_TAG_CATEGORY` | Re-declares `app.js`'s constant on a page that loads both. | L | S | 1 | fixed@b67e77f07 | read |
| CQ-F007 | dead-css | `styles.css` `.lift-card`, `.anchor-left`, `.drop-up`, `.overview-grid`(`-2col`), `.stacked-bar`(`-segment`), `.subnet-name-link`, `.asset-name-link`, `.dashboard-grid`, `.dashboard-card` | No reference in `public/`, `design/`, `tests/`, `src/` or the skills. A `styles.css` change re-triggers the design-system sync. | L | S | 1 | fixed@074f91676 | grep |
| CQ-F008 | dead-function | `users.js` region picker: `regionPickerHtml`, its document-wide `.region-chip` click delegate, `collectRegionPicker` | The whole picker is orphaned (region scope now flows through the tag picker); its only remaining "users" are `usersRegionPicker.test.ts` (15 references), a stub in `roleMatrixLaddersDom.test.ts`, and `asset-tag-mutators.md` citing "regionPickerHtml's unreadable-catalogue posture". Delete code, test and doc mention together. | L | S | 1 | fixed@0e30fd163 | grep |
| CQ-F009 | bug | `server-settings.js` Tags card | Merge d580d19e0 (2026-10-16) dropped the card's call to `_tagRegistryChipHTML` for an inline copy: azure: chips showed Edit/Delete (always 409), verbs gated on the role not the Tags key, and the assets slide-in could never open. Found because the helper had no caller. Needs a click-through on a live install. | M | S | 1 | fixed@a1f532d26 | read+git |

### Duplicated helpers and canon drift

| id | kind | where | canonical | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|---|
| CQ-F010 | bug | `users.js sectionHeading(text, first)` | `app.js sectionHeading(text)` | Same global name, different markup; on `users.html` the users.js copy silently replaces the canonical one for the whole page. Rename the users.js one. | L | S | 1 | fixed@210442fad | read |
| CQ-F011 | dup-helper | `esc` / `escapeAttr` re-implementations in `alert-ack-view`, `appmap`, `graph-export`, `assistant-markdown`, `mobile/charts`; guard shims in `favorites`, `quiet-time-editor`, `recurrence-editor`, `saved-tree`, `server-settings-firmware`, `server-settings-ha`, `condition-builder` | `api.js escapeHtml` | `api.js` loads first on every host page. `mobile/charts.js escapeAttr` does not escape `'`. | L | S | 1 | wontfix except the quote gap (fixed@02a25934b): these modules load standalone in their tests (alertAckPage, assistantWidget, conditionBuilderDom, regionTreeRender, the mobile chart tests) and the typeof-escapeHtml guards exist for that; pointing all 14 at the global failed 83 tests and was reverted | read |
| CQ-F012 | dup-helper | `toast()` aliases ×10 | `api.js showToast` | Keep: `password-self.js` also runs on `login.html`, which has no `api.js`. The 20 inline `typeof showToast` guards on pages that always load `api.js` are cosmetic. | L | S | 2 | wontfix (aliases needed) | read |
| CQ-F013 | dup-helper | `formatTimeAgo` ×3 (mobile `alerts-tab`, `asset-detail`, `more-tab`) | `api.js timeAgo` | Identical wrappers adding an empty/invalid guard. Fold the guard into `timeAgo` (today it renders "NaNd ago"). | L | S | 1 | fixed@386237d80 | read |
| CQ-F014 | dup-helper | `fmtLocal` / `fmtDate` in `ops-calendar`, `assets-maintenance`, `automations-settings` | `recurrence-editor.js` (`window.PolarisRecurrence`) | Zone-less wall-clock strings; `formatDateTime` is the WRONG canonical (it applies the display timezone). | L | S | 1 | wontfix: identical output in every copy; ops-calendar is a standalone module (opsCalendar.test loads it alone) and pathChecksUi.test evaluates assets-maintenance without recurrence-editor | read |
| CQ-F015 | dup-helper | mobile `permAtLeast` ×5, two signatures (`alerts`, `asset-edit` take `(key, level)`; `alerts-tab`, `reservation-actions`, `subnet-detail` take `(user, key, level)`) | new `PolarisAuth.permAtLeast(key, level, user?)` in `mobile/auth.js` | `mobile.html` never loads `app.js`. | L | S | 1 | wontfix: each mobile module is a standalone IIFE its test loads without mobile/auth.js (mobileAlertsAckDom, mobileAssetEdit); four-line copies do not justify rewiring every harness | read |
| CQ-F016 | dup-helper | `assets.js _formatCertFingerprint` ≡ `pinned-tls-certs.js fmt` | new `api.js formatHexFingerprint` | The two files never share a page. | L | S | 1 | wontfix: two lines in two files that never share a page; not worth an api.js dependency in assets.js tests | read |
| CQ-F017 | dup-helper | about 12 date formatters calling bare `toLocaleString()` (`passkeys-self`, `agent-build`, `automations-settings fmtAt`, `pinned-tls-certs when`, …) | `api.js formatDateTime` | They ignore the operator's display timezone. | L | M | 2 | verified | grep |
| CQ-F018 | dup-helper | `mobile/charts.js formatBytes` | `api.js formatBytes` | Shadows the canonical name with different output. | M | S | 2 | verified | read |
| CQ-F019 | dup-helper | `events.js renderPagination`, `assets.js _renderAssetEventsPagination` | `app.js renderPageControls` | Same algorithm, two ellipsis characters. | L | S | 2 | verified | read |
| CQ-F020 | canon-violation | status palettes: `MONITOR_STATE_COLORS`, `POLARIS_HEALTH_COLORS`, `POLARIS_WIDGET_STATUS_COLORS`, `widgets/siteMap COLOR`, `path-checks OK_COLOR/FAIL_COLOR`; severity order ×4, rank maps ×3, colour maps ×5 | extend `monitor-states.js` | Five palettes where the canon allows two. | M | M | 2 | verified | grep |
| CQ-F021 | bug | `agent-build.js _agentStatusBadge` vs `assets.js _agentStatusColor` | — | `upgrade_failed` reads danger on one page and secondary on the other. | L | S | 2 | verified | read |
| CQ-F022 | dup-helper | `mobile/chat-tab.js` re-declares `lsGet`, `ask`, `ensureConversation`, `messageHTML`, `idleResetIfDue`, `reportHTML`, `stampHTML`, `fileStem`, `fromServer` | `assistant.js` | Both load on `mobile.html`. | M | M | 2 | verified | grep |
| CQ-F023 | dup-helper | `dash-boot.js` re-declares 17 `app.js` functions (theme engine, `fetchCurrentUser`, `permLevel`, `permAtLeast`, `isAdmin`); `mobile/app.js` re-declares the theme-fade helpers (about 150 lines each per jscpd) | — | Three theme engines. A shared `theme-core.js` loaded by all three. | M | L | 2 | verified | jscpd |
| CQ-F024 | dup-helper | ~15 helpers mirrored between `mobile/asset-detail.js` and `assets.js` (`ipsecIsRemoteAccess`, `tableFilterMatches`, `buildWirelessTree`, `arpAgeLabel`, …); `mobile/charts.js` ports of `assets.js` chart helpers; `mobile/map-tab.js` and `mobile/topology-tab.js` ports of `map.js` | — | "Change one, change both" comments. A shared module per family. | M | L | 2 | verified | jscpd |
| CQ-F025 | dup-helper | about 20 hand-rolled slide-over open/close triples; `wireSlideoverEscape` not used by `agent-build`, `assets-compare`, `events`, `users` | — | A slide-over factory, and Escape-to-close everywhere. | M | M | 2 | verified | grep |
| CQ-F026 | dup-helper | raw `fetch("/auth/me")` ×4, raw logout POST ×3 | `api.js` | Bypass the shared client. | L | S | 2 | verified | grep |
| CQ-F027 | dup-helper | 33 pasted mobile spinner literals; 117 + 45 raw `empty-state` strings; download icon pasted 11×, camera icon 4× | `app.js ICONS` | Small helpers. | L | S | 2 | verified | grep |
| CQ-F028 | dup-helper | `PolarisPrefs` save/restore pairs ×8; `lsGet`/`lsSet`-style try/catch wrappers ×7; three localStorage key schemes (`polaris-…`, `polaris.…`, camelCase) | `table-sf.js PolarisPrefs` | One prefs helper and one naming scheme. | L | M | 2 | verified | grep |
| CQ-F029 | canon-violation | script order: `users.html` loads `table-sf.js` before `api.js`; `automations.html` and `path-monitor.html` load `push.js` and the password / TOTP / passkey modules after `app.js`, every other page before it | — | Works today only because nothing at load time depends on the order. | L | S | 2 | verified | read |

### Efficiency

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-F040 | efficiency | 31 widget `setInterval`s (22 widgets on 30 s / 60 s) | Keep polling in a hidden tab. `app.js pollVisible` is local to its IIFE and `dash.html` does not load `app.js`, so add `PolarisWidgets.pollVisible(fn, ms)` in `widgets/index.js` and have `app.js` use it too. | L | M | 2 | fixed@5f246cea5 (30 polls; deviceMap rotation is a display timer and stays) | grep |
| CQ-F041 | efficiency | `assets.js` (1.67 MB), `integrations.js` (650 KB), `automations-wizard.js` (609 KB) | Load on index, map, appmap, automations and path-monitor as well as their own pages. | M | L | 3 | verified | read |
| CQ-F042 | efficiency | `querySelectorAll().forEach(addEventListener)` row loops (assets 61, server-settings 30, events 12, automations 10) | Delegation would bind once per table. | L | M | 2 | verified | grep |

### Structure

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-F050 | structure | `assets.js` (30.7k lines, 774 top-level functions) | About 30 responsibility clusters; split into `assets-*.js` on the `assets-tabs.js` pattern with a load-order test. | H | L | 3 | verified | read |
| CQ-F051 | structure | `server-settings.js` (12.8k), `automations-wizard.js` (10.3k, one IIFE), `integrations.js` (10k), `app.js` (6.6k; several notice sections appear twice) | Same treatment, one file per session. | M | L | 3 | verified | read |

## Go agent (G)

| id | kind | where | summary | risk | effort | tier | status | verified-by |
|---|---|---|---|---|---|---|---|---|
| CQ-G001 | lint | 9 committed files not gofmt-clean (`main.go`, `pacing_test.go`, `cputimes_test.go`, `eventlog_windows.go`, `path_check_traceroute.go`, `systeminfo.go`, `config.go`, `client.go`, `ws.go`) | Format by name only (never package-wide on a CRLF checkout); add `fmt-check` and `vet` Makefile targets and CI steps. | L | S | 1 | fixed@618592773 | gofmt |
| CQ-G002 | bug | `path_check.go` and `path_check_http.go` UTF-8 trimming loops | Rescan the string each pass (O(n²)) and empty the whole string when an earlier byte is invalid, e.g. a binary response body. | M | S | 1 | fixed@618592773 | read |
| CQ-G003 | bug | `path_check_traceroute.go truncateNote` | Can cut a multi-byte character in half. | L | S | 1 | fixed@618592773 | read |
| CQ-G004 | efficiency | `telemetry.go` + `meminfo.go` | Memory is read twice per telemetry tick and the first result discarded. | L | S | 1 | fixed@618592773 | read |
| CQ-G005 | dup-helper | atomic cursor save ×3 (`eventlog.go`, `processlog.go`, `servicelog.go`), cursor load ×3, journalctl tail-cursor ×3, `journalStr` ≡ `jsonLineField`, hand-rolled `trimSpace` | One `writeFileAtomic` on the safer `CreateTemp` pattern from `config.go`, one cursor helper. | L | M | 1 | deferred: the cursor/journal paths are per-OS runtime code (journalctl on Linux, wevtutil on Windows) that compiles here but cannot be exercised; do it beside a Linux and a Windows agent | read |
| CQ-G006 | dup-helper | ten "run collector with a deadline" blocks in `main.go` | One generic `withTimeout[T]`. | L | S | 1 | deferred: the ten collector-deadline blocks in main.go deliberately leak a goroutine on timeout; a generic wrapper should land with the transport-context work in CQ-G009 | read |
| CQ-G007 | canon-violation | `interface{}` ×4; `%v` on errors in the three `reboot_*.go`; `bytes.Index([]byte(line), …)` ×3 | `any`, `%w`, `strings.Index`. | L | S | 1 | fixed@618592773 | read |
| CQ-G008 | dead-export | `MemBreakdownOnce`, `ValidateCheckDef`, `WSDialer.Dial`, `pinned.Prefix` | Exported, used only inside their package. Un-export after checking `src/` does not name them. | L | S | 1 | partly fixed@618592773 (MemBreakdownOnce, ValidateCheckDef, WSDialer.Dial unexported); pinned.Prefix stays exported — making config.go use it would pull crypto/tls into the config package for one constant | grep |
| CQ-G009 | canon-violation | `internal/transport` | No tests at all (934 lines), and no HTTP call takes a context, so shutdown cannot cancel an in-flight request. `Client.bearer` is written by `SetBearer` with no synchronisation. | M | M | 2 | verified | read |
| CQ-G010 | efficiency | `processtelemetry.go` | Primes CPU with a 300 ms blocking `Percent(0)`, the approach README says 0.20.0 replaced. | L | S | 2 | verified | read |
| CQ-G011 | efficiency | `path_check_http.go` | Compiles the check's regex on every probe; cache per check definition. | L | S | 2 | verified | read |
| CQ-G012 | canon-violation | exec timeouts | 5 to 60 s depending on file; three commands (`systeminfo_darwin`, `reboot_darwin`, `reboot_windows`) have none. | L | S | 2 | verified | read |
| CQ-G013 | canon-violation | logging | Plain `log.Printf` with a global `verbose` flag; one stream logs as both `pathCheck:` and `path-check sent:`. | L | S | 2 | verified | read |
| CQ-G014 | dead-file | build-tagged stubs `eventlog_other.go`, `path_check_icmp_other.go`, `systeminfo_other.go`, `reboot_other.go`, `processlog_open_other.go` | Never compiled by the Makefile's six targets. Keep only if a non-linux/darwin/windows build is wanted. | L | S | 2 | verified | read |
| CQ-G015 | canon-violation | `agent/README.md`, `go.mod` | README says one dependency (there are four). (The survey also said three direct deps were marked indirect; they are not — `go mod tidy` changes nothing.) | L | S | 1 | fixed@618592773 | read |

## Survey claims that were wrong (do not act on them)

| Claim | Reality |
|---|---|
| `.kpi-card`, `.kpi-grid`, `.kpi-label`, `.kpi-value` are dead CSS | Used by the design-system pages and `POLARIS-UI-GUIDE.md`; `.design-sync/build.mjs` fails on a class the stylesheet lacks. |
| `window.appMapProcessCapableTypes` is never read | `appmap-rules-wizard.js` reads it. |
| Three `globToRegExp` copies to consolidate | Two are one-line wrappers over `compileGlob` with different options; only the `logFlagRuleService` one is a real builder, and it is test-only (CQ-B011). |
| The tag merges can use `unionTags` | `unionTags` trims, case-folds and sorts; see CQ-B025. |
| Five abortable `sleep` copies | Two different contracts; see CQ-B022. |
| `src/models/types.ts` has 7 importers | It has none (CQ-B003). |
| jscpd `threshold: 0` makes it report-only | `threshold` is the percentage above which it fails; 0 fails on any clone. The config has no threshold. |
