---
name: polaris-change-impact
description: "'If I change X, what else touches it?' — the Polaris touches index: per-service writers/readers/invariants/change checklists for every service, 26 cross-cutting concerns (monitor state machine, asset projection, polling resolver, reservation push, dependency suppression, sample retention, permission matrix, migrations, metrics…), the 17 canonical backend patterns to copy, and the file-by-file source map. Load BEFORE editing anything in src/services, src/jobs, src/utils or a route; before adding a service, job, integration type or metric; when asked where something lives or what depends on it; and when a figure on the Maintenance tab looks wrong — capacity snapshot, steady-state size projection, disk forecast, TimescaleDB chunk intervals."
---

# Polaris change impact (the touches index)

A lookup index for cross-cutting invariants and per-service relationships. It answers
**"if I change X, what else touches it?"** without reading every consumer, and names the
**canonical backend patterns** to model new work after ("there are five places that already
do this — which one is the reference?"). The UI counterpart is `polaris-ui-canon`.

## How to use

1. **Before changing a service or a shared invariant**, find its section here (tables below).
2. Walk the **Used by** / **Writers** / **Readers** lists to see what depends on the thing you're touching.
3. Run through the **When changing this** checklist before you commit.
4. **Keep this index current.** If your change moved writers/readers, broke an invariant, or
   invalidated a checklist item, fix the entry in the same commit (`/polaris-docs-sync`).
   `npm run check:docs` fails on a service with no `## services/<name>.ts` entry.

## Format

**Per-service** sections: **What it owns** / **Public API** / **Cross-service deps** /
**Used by** (`file → symbol — purpose`) / **Invariants** / **When changing this**.
**Cross-cutting** sections swap **Used by** for **Writers** / **Readers**.
**Pattern** sections: **What it is** / **Canonical implementation** / **Key conventions** /
**When adding a new instance** — copy the canonical's shape rather than inventing a parallel one.

> Code references are `path/file.ts → symbolName()` — never line numbers, they drift.
> Grep the symbol name to locate it.

## Cross-cutting concerns (one file each, under `references/cross-cutting/`)

| Concern | Read when |
|---|---|
| [five-state-monitor-machine](references/cross-cutting/five-state-monitor-machine.md) | anything sets or reads `monitorStatus` / `consecutiveFailures` |
| [asset-source-projection](references/cross-cutting/asset-source-projection.md) | a discovery source writes an Asset field; AssetSource priority |
| [windows-os-name-correction](references/cross-cutting/windows-os-name-correction.md) | `os` / `osVersion` on Windows hosts (rule 28) |
| [polling-method-resolver](references/cross-cutting/polling-method-resolver.md) | per-stream polling method, the four tiers, `pollingCompatibility.ts` |
| [integration-type-onboarding](references/cross-cutting/integration-type-onboarding.md) | adding an 8th integration type (~30-callsite checklist) |
| [fmg-fortigate-parity-surfaces](references/cross-cutting/fmg-fortigate-parity-surfaces.md) | a FortiManager feature that must also ship on standalone FortiGate |
| [asset-write-time-clamps-and-shadow-writes](references/cross-cutting/asset-write-time-clamps-and-shadow-writes.md) | the `src/db.ts` Prisma extension hooks |
| [asset-management-access](references/cross-cutting/asset-management-access.md) | Open HTTPS / SSH / RDP verbs, `allowaccess` |
| [asset-last-seen-presence](references/cross-cutting/asset-last-seen-presence.md) | `lastSeen`, `bumpLastSeen`, presence verification (rule 12) |
| [asset-change-events](references/cross-cutting/asset-change-events.md) | firmware / switch-port / AP / gateway change Events |
| [reservation-push-lifecycle](references/cross-cutting/reservation-push-lifecycle.md) | pushStatus, queued push, retry, FortiGate DHCP writes |
| [fortigate-snmp-location-and-coord-writeback](references/cross-cutting/fortigate-snmp-location-and-coord-writeback.md) | sysLocation, lat/long, coordSource |
| [fortinet-infra-dhcp-binding](references/cross-cutting/fortinet-infra-dhcp-binding.md) | `dhcpBinding`, infra reservations (rule 23) |
| [dns-resolved-reservations](references/cross-cutting/dns-resolved-reservations.md) | `dns_resolved` rows (rule 11) |
| [location-codes](references/cross-cutting/location-codes.md) | `a:` `b:` `f:` `r:` `jb:` parsing (rule 15) |
| [asset-tag-mutators](references/cross-cutting/asset-tag-mutators.md) | anything that adds or strips `Asset.tags` |
| [dependency-aware-monitoring-suppression](references/cross-cutting/dependency-aware-monitoring-suppression.md) | `dependencySuppressed`, the DAG, Dep. Down (rule 38) |
| [fortinet-parent-key-resolution](references/cross-cutting/fortinet-parent-key-resolution.md) | resolving a switch/AP's controlling gate — never by hostname |
| [verbose-debug-mode](references/cross-cutting/verbose-debug-mode.md) | `verboseLogging` on an integration |
| [pgbouncer-compatibility](references/cross-cutting/pgbouncer-compatibility.md) | anything needing a direct Postgres connection |
| [schema-migrations-and-prisma-client-lifecycle](references/cross-cutting/schema-migrations-and-prisma-client-lifecycle.md) | writing a migration, regenerating the client, update scripts |
| [observability-metrics](references/cross-cutting/observability-metrics.md) | adding / renaming a `polaris_*` metric |
| [tiered-sample-retention](references/cross-cutting/tiered-sample-retention.md) | sample tables, rollups, retention windows, TimescaleDB chunks |
| [server-side-list-tables](references/cross-cutting/server-side-list-tables.md) | a paginated / filtered list endpoint |
| [csp-inline-script-policy](references/cross-cutting/csp-inline-script-policy.md) | any inline `<script>` or new page |
| [dynamic-roles-permission-matrix](references/cross-cutting/dynamic-roles-permission-matrix.md) | function keys, levels, role snapshots |
| [sso-login-and-group-mapping](references/cross-cutting/sso-login-and-group-mapping.md) | OIDC / LDAP / SAML / App Proxy login, group → role |
| [alert-acknowledgement](references/cross-cutting/alert-acknowledgement.md) | acknowledge from email / push / in-app (rule 25) |
| [automation-action-types](references/cross-cutting/automation-action-types.md) | the four action types and the eight action locations |
| polaris-agent, polaris-agent-build, deployment | moved: `polaris-agent/references/cross-cutting-polaris-agent*.md`, `polaris-deploy/references/cross-cutting-deployment.md` |

## Per-service entries (grouped, under `references/services/`)

| Group file | Services |
|---|---|
| [alerting-engine](references/services/alerting-engine.md) | notificationEngine, notificationRuleService, notificationService, notificationTypes, notificationChangeEvents, downDetectionService, probeLossQuery, automationTestService |
| [alerting-scope-dimensions](references/services/alerting-scope-dimensions.md) | deviceFilterService, scopeRelationIndex, notificationDimensionService, notificationCadenceService, regionScopeService, maintenanceScheduleService, automationActionService |
| [alerting-delivery](references/services/alerting-delivery.md) | notificationDeliveryService, notificationEscalationService, notificationRecipientService, notificationPreferenceService, notificationChannelService, pushSubscriptionService, alertChartService, alertBrandService, alertInterfaceService, contactService, directorySyncService, directorySearchService, automationScriptService, automationScriptRunner |
| [monitoring-collection](references/services/monitoring-collection.md) | monitoringService, probePatchBuffer, interfaceInventoryService, interfaceTopologyService, apRadioService, arpTableService, peerInferredLldpService, agentlessHostService, agentlessProcessService, monitorOverrideService, osEventLogService, logFlagRuleService |
| [snmp-mibs-profiles](references/services/snmp-mibs-profiles.md) | oidRegistry, stdMibLibrary, mibService, mibParserUtils, vendorTelemetryProfiles, manufacturerProfileService, manufacturerAliasService |
| [samples-timeseries](references/services/samples-timeseries.md) | sampleWriteBuffer, sampleRollupService, sampleRetentionService, sampleHistoryService, sampleQueryRouter, probeOutageService, timescaleService, storageForecastService, capacityService, capacityAdvisorService, capacityDbIo |
| [discovery-fortinet](references/services/discovery-fortinet.md) | fortimanagerService, fmgWorker, fmgActivityService, fortigateService, fortigateCoordPushService, fortigateLocationService, descriptionSyncService, reservationPushService, integrationHealthService, discoveryCancelWatchdog, discoveryDurationService, discoveryAutoAbortService, discoveryRunState, geocoderService |
| [discovery-directory-cloud](references/services/discovery-directory-cloud.md) | entraIdService, activeDirectoryService, azureArcService, vcenterService, windowsServerService, presenceVerificationService, ldapClient, intunePublishService, arcPublishService |
| [ipam-reservations](references/services/ipam-reservations.md) | subnetService, subnetRefreshService, subnetArchiveService, subnetChassisConflictService, subnetExclusionService, blockService, ipService, reservationService, reservationStaleService, dnsResolvedReservationService, arpPrimeService, allocationTemplateService, utilizationService, networkScanService, networkScanRunner, duplicateIpConflictService, ipOverrideService, ipContextService, dnsService |
| [assets-inventory](references/services/assets-inventory.md) | assetMergeService, assetGhostMergeService, assetTypeService, assetQuarantineService, assetSourcePriorityService, assetSightingService, assetIpHistoryService, assetUpstreamService, dependencyTreeService, connectionPathService, tagAssignmentService, discoveredHostnameService, projectionDriftService, macAddressService, ouiService |
| [assets-auto-monitor-pins](references/services/assets-auto-monitor-pins.md) | autoMonitorInterfacesService, autoMonitorStorageService, massPinService |
| [auth-identity](references/services/auth-identity.md) | azureAuthService, oidcAuthService, ldapAuthService, entraProxyAuthService, ssoProvisioning, groupMappingService, roleService, apiTokenService, totpService, credentialService, sshHostKeyService, sshOnboardingScript, windowsSshOnboardingService, loginAccessService, apiDocsAccessService |
| [settings-platform](references/services/settings-platform.md) | settingsStore, serverSettingsService, brandingService, brandLogoService, appIconService, backupService, backupScheduleService, updateService, queueService, eventLogService, eventArchiveService, nginxApplyService, nginxConfigParser, nginxRenderer, proxyConfigService, privilegedSysadmin, dashSettingsService, dashRoleSnapshotService, weatherProxyService, deviceIconService, certInfo |
| [agent-services](references/services/agent-services.md) | agentInstallService, agentInstallScripts, agentAutoDeployService, agentBuildService, agentChannelService, agentTokenService, agentCommandService, agentCommandWake, serviceInventoryService |
| [dashboards-maps-tables](references/services/dashboards-maps-tables.md) | mapRegionService, regionHierarchyService, topologyLayoutService, applicationMapService, appMapDiscoveryService, savedDashboardService, savedFilterService, tableTabsService, userDashboardService, nocDashboardService, searchService |

A new service goes in the group whose "What it owns" it most resembles; when in doubt,
`grep -l "## services/<sibling>.ts" references/services/*.md` to find where its siblings sit.

## Canonical backend patterns (under `references/patterns/`)

- [backend-patterns-data.md](references/patterns/backend-patterns-data.md) — per-instance multi-lane worker; cross-asset graph derivation + persisted DAG; serialized check-then-insert (advisory lock); encrypt-at-rest for a JSON config column; server-generated keypair; current-state table refreshed per scrape (delete-replace); high-volume append-only time-series writes (batch-flush buffer); tiered rollups; operator-declared value mapping → alertable dimension.
- [backend-patterns-integration.md](references/patterns/backend-patterns-integration.md) — Setting-backed admin CRUD with reconciler; Prometheus metric instrumentation; per-integration verbose debug logging; permission-gated route + function key; queue-on-transient-failure with retry tick; outbound multi-channel delivery; deferred alert-email content; integration type (config + discovery + sync + modal).

Each pattern section carries **What it is** (one-sentence scope), **Canonical implementation** (entry-point `path/file.ts → symbolName()`), **Key conventions** (data shape, helpers, persistence, refresh model) and **When adding a new instance** (checklist before merging).

Only diverge from a canonical when the new surface genuinely needs something it doesn't — and note the divergence in your PR.

## File map (under `references/file-map/`)

The repository tree with a purpose note per file: [root-docs](references/file-map/root-docs.md) ·
[public-1](references/file-map/public-1.md) · [public-2](references/file-map/public-2.md) ·
[src-api-dash-setup-models](references/file-map/src-api-dash-setup-models.md) ·
[src-services-1](references/file-map/src-services-1.md) · [src-services-2](references/file-map/src-services-2.md) · [src-services-3](references/file-map/src-services-3.md) ·
[src-jobs](references/file-map/src-jobs.md) · [src-utils-1](references/file-map/src-utils-1.md) · [src-utils-2](references/file-map/src-utils-2.md) ·
[tests](references/file-map/tests.md). Every `src/services|jobs|api/routes|utils` file must appear in one of them (`npm run check:docs`).
Services are listed in concern order, not alphabetically — `grep -l "name.ts" references/file-map/*.md`.
