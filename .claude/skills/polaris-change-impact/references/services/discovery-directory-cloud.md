# Services — Entra / AD / Arc / vCenter / Windows Server discovery

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/vcenterService.ts

**What it owns:** VMware vCenter discovery + monitoring client — vSphere Automation REST session client (inventory: clusters, hosts, per-host VM lists, per-VM detail + VMware Tools guest identity/networking) plus SOAP property-collector calls against `/sdk` for everything REST won't answer: batched VM quickStats (CPU/RAM, power state, uptime, `guest.disk`, `guest.net`), batched ESXi host stats + virtual networking paired with the datastore fetch in one session (`fetchVcenterHostSnapshot`, shared with discovery's Phase 2), and datastore summary/host-mounts/backing. Plus the NAA-prefix array-vendor map (`vendorFromNaa`) and the pure vMotion-safe dependency-edge builder.

**Public API:** testConnection, proxyQuery (REST surface only — rejects non-`/api/` paths), discoverInventory, fetchVcenterQuickStats, fetchVcenterHostSnapshot, pickVmExternalId, hostExternalId, buildClusterHostMap, buildVcenterDependencyEdges, vcenterSweepBlockedReason, partitionStaleVcenterSources, matchesVmWildcard, filterVms, vendorFromNaa, backingLabelFor, extractObjectBlocks / parseObjRef / parsePropValue / parseQuickStatsBlock / parseGuestDisks / parseGuestNics / parseHostPnics / parseHostVnics / parseHostVswitches / parseHostProxySwitches / parseHostPortgroups / parseHostStatsBlock / parseDatastoreBlock (SOAP parsers), parseVmDetail, VcenterConfig + Discovered* + VcenterHost* types.

**Cross-service deps:** dnsService.getConfiguredResolver (host FQDN → resolvedIp; REST exposes no host mgmt IP).

**Used by:** src/api/routes/integrations.ts — test connection (create-form), Query API proxy branch. src/services/discovery/discoveryEngine.ts — preflight test + discovery dispatch (`discoverInventory` → `syncVcenterDevices`). src/services/monitoringService.ts — `fetchVcenterQuickStats` and `fetchVcenterHostSnapshot` behind two per-integration warm caches (`fetchVcenterQuickStatsCached` / `fetchVcenterHostSnapshotCached`, 30s TTL + promise-singleton each) that back the "vcenter" polling method's FOUR streams (response-time, cpuMemory, interfaces, storage) for VMs and ESXi hosts alike.

**Invariants:**
- VM externalId = `instanceUuid` (survives vMotion), fallback `${integrationId}:${moref}`; host externalId = `${integrationId}:${hostMoref}` ALWAYS (morefs repeat across vCenters). Sync + conflict resolution + telemetry cache all key on these — change them in lockstep or existing AssetSource rows orphan.
- VM lists are fetched PER HOST (`?hosts=<moref>`) — that's what pins VM→host placement AND sidesteps the 4000-item global list cap. Don't "optimize" to one global list.
- Every SOAP surface degrades to nulls independently; datastores fall back to the REST list (no mounts/backing/provisioned) when `/sdk` is unreachable. Guest calls are per-call try/caught (Tools-off returns 503).
- `buildVcenterDependencyEdges`: clustered VM → one edge per cluster-member host (all-down suppression = whole-cluster-dark → vMotion-safe); standalone → single edge; skips hosts with no asset; dedupes; never self-parents. Edges land with `source="vcenter"` / `detectedVia="hypervisor"` — never `"computed"` (the Fortinet recompute deletes that scope).
- The disappearance sweep is **claim-based, and only reads a WHOLE inventory**. `syncVcenterDevices` decommissions an asset that lost its vcenter source ONLY when no other `AssetSource` row remains (directory / arc / polaris-agent / the `manual` row all veto it). `vcenterSweepBlockedReason` skips the sweep AND the source deletes on an incomplete (`inventoryComplete=false`) or empty inventory; `partitionStaleVcenterSources` retains rows whose moref is still in `presentVmMorefs` so a `vmInclude`/`vmExclude` change never decommissions. Both are pure and live here — keep them here rather than inlining the logic back into the engine, because they are the only unit-testable part of that pass.
- `discoverInventory` must keep populating `presentVmMorefs` (raw pre-filter, pre-detail VM morefs) and `inventoryComplete` (false when ANY per-host VM list threw). A new early-return or a new swallowed failure in the inventory read has to set `inventoryComplete=false` too, or the sweep will read that gap as deleted devices.
- REST session: one automatic re-auth on a mid-run 401, logout in `finally`. SOAP session likewise logged out best-effort.
- quickStats cache entries are keyed by BOTH externalId forms so the per-asset lookup matches whatever the sync stored. Host cache entries key on `${integrationId}:${moref}`, which is the only form `hostExternalId` produces.
- **`null` is not `[]` on any guest or host inventory array.** `parseGuestDisks` / `parseGuestNics` / `parseHostPnics` / `parseHostVnics` return `null` when the property is ABSENT (Tools not running; a disconnected host publishes no config) and an array when it was read. The monitor path turns `null` into an empty list, which `recordSystemInfoResult` SKIPS rather than treating as a wipe — return `[]` from a parser and a VM with Tools off empties its own interface inventory.
- `parseHostPnics` reads the live `<linkSpeed>` from the entry PREFIX only (everything before `<validLinkSpecification>` / `<spec>`). Both of those carry `<speedMb>` elements describing what the NIC SUPPORTS or is CONFIGURED for, and ESXi omits `linkSpeed` entirely on a down port — so a whole-entry match reports 10 Gb on a dark uplink. `splitAtSpec` generalizes the same head-vs-spec split for the vSwitch and port-group parsers, whose `numPorts`/`mtu` also appear on both sides.
- **vSwitch uplinks are DEVICE names, read from the spec.** `vswitch.pnic[]` / `proxySwitch.pnic[]` hold opaque keys (`key-vim.host.PhysicalNic-vmnic0`); `spec.bridge.nicDevice[]` and `spec.backing.pnicSpec[].pnicDevice` carry `vmnic0` directly, which is what lets `buildVcenterSystemInfo` join onto the interface rows without a key-mapping table. The NIC-teaming policy is read from inside `<nicTeaming>`, because `spec.policy` is ALSO an element named `policy` (it survives only because the outer one has child elements rather than a text value — too subtle to leave untested, so `vcenterService.test.ts` pins it).
- A distributed switch's own configuration (its port groups, their VLANs, host span) is a per-vCenter object and is deliberately NOT read here. `parseHostProxySwitches` reports only what the HOST's end knows — DVS name, uuid, and this host's uplinks — and leaves `teamingPolicy` null rather than guessing.
- `fetchVcenterHostSnapshot` reports its two halves' failures SEPARATELY (`hostError` / `datastoreError`) and throws only on a failed login. A vCenter role can be granted host properties and refused datastores or the reverse, so the caller decides which half it cannot proceed without: the monitor cache THROWS on `hostError` (an empty host map would read as "this host left the inventory" and fail the probe, where the honest answer is `unreachable` -> skip), while discovery treats `datastoreError` as its REST-fallback trigger and a `hostError` as "vSwitches stay null this run".

**When changing this:**
- Field shapes are verify-on-real-vCenter (7.x/8.x): REST VM detail (`identity`, `nics`, `disks.backing.vmdk_file` bracket format), Tools guest endpoints, SOAP quickStats/datastore-info property paths. The SOAP parsers are regex-based over shapes we request — update tests/unit/vcenterService.test.ts fixtures with real captures.
- Adding a projected field → also add the `vcenter-vm`/`vcenter-host` rule in `src/utils/assetProjection.ts` (directly below polaris-agent) and mirror the observed-blob key in `buildVcenterVmObservedBlob` / `buildVcenterHostObservedBlob` (discoveryEngine.ts).
- Changing quickStats or host-stats fields → update `readVcenterAsset` / `collectTelemetryVcenter` / `buildVcenterSystemInfo` (monitoringService) + the parser fixtures in tests/unit/vcenterService.test.ts. Adding a STREAM the method serves is a five-place lockstep: `VCENTER_STREAMS` (pollingCompatibility.ts), `defaultPollingForSource` (monitoringService), the collector, the `assets.ts` PUT guard, and the `_VCENTER_STREAMS` + `_polarisSourceDefaultPolling` mirrors in public/js/integrations.js.
- New datastore fields → `VcenterDatastore` model + migration + the `/assets/:id/virtualization` serializer + assets.js `_assetVirtualizationHTML`. Note the General-tab block is INVENTORY only: anything that is a reading over time (guest filesystems moved out in 2026-08) belongs on the `vcenter` storage/interfaces streams so the System tab charts it. New HOST blob fields sourced from SOAP must be carried forward from the prior blob when absent (`priorVirt` in `syncVcenterDevices`) — the rest of that blob comes from REST, so writing null on a SOAP-half failure would mix fresh and blanked facts in one object.
- New per-class monitor knobs → `VcenterConfigSchema` (`vmMonitor`/`hostMonitor`) + `monitorOverrideService` block-key maps + `pickClassStreamsBlock` + the integrations.js `vms`/`hosts` subtabs and save readers.
- VMs are typed `server` (the `virtual_machine` built-in was retired by migration 20260722000000). The auto-monitor/deploy **klass** name stays `virtual_machine` (queries pair it with `discoveredByIntegrationId`), but nothing writes that asset type anymore. `server` → block-key resolution is integration-type-dependent everywhere it happens (`monitorOverrideService.getAddAsMonitoredFromConfig` / `classBlockKeyForAssetType(assetType, integrationType)` / both raw-SQL sweeps, `monitoringService.pickClassStreamsBlock`): vcenter → `vmMonitor`, directory → `serverMonitor`. VM-class behaviors (dependencyLayer=2, vmMonitor sweep) gate on `discoveredByIntegrationId` ownership, not on the type.
- Both the VM pass and the host pass raise a `bothAssetsExist` sibling Conflict when the device has its own asset AND a hostname-twin non-vCenter asset exists (so operators merge from the Conflicts queue). If you change the collision proposedAssetFields shape, keep `conflictResolutionService.ts` `conflictSourceFor` + `rejectAssetConflict`'s `alreadyOwned` short-circuit + the events.js `bothAssetsExist` card branch in lockstep.

---

## services/activeDirectoryService.ts

**What it owns:** On-prem Active Directory device discovery via LDAP/LDAPS client (computer objects, OU filtering, SID/GUID identity, disabled-account handling).

**Public API:** testConnection, proxyQuery, discoverDevices, ActiveDirectoryConfig, DiscoveredAdDevice, AdDiscoveryResult, AdDiscoveryProgressCallback.

**Cross-service deps:** None (pure LDAP client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts — discovery trigger, test connection, manual LDAP proxy query. src/services/discovery/discoveryEngine.ts — sync path syncActiveDirectoryDevices.

**Invariants:**
- LDAP simple bind (no Kerberos); default port 636 (LDAPS) or 389 (plain LDAP).
- Device identity: AD `objectGUID` (lowercased hex) → `Asset.assetTag = "ad:{guid}"` (legacy) and `AssetSource.externalId` with `sourceKind="ad"`.
- Cross-link via `objectSid` (string SID) == Entra's `onPremisesSecurityIdentifier` → `tags` stamped with `sid:{SID}` (uppercase) for hybrid-join matching.
- Disabled accounts (userAccountControl & 0x2) → `decommissioned` status when includeDisabled=true (default); skipped entirely when false.
- `ouInclude`/`ouExclude` filters match against full distinguishedName with wildcard support (e.g., `*OU=Workstations*`).
- `lastLogonTimestamp` replicates ~14 days; use as coarse "last seen" signal only.
- Paged subtree search under baseDn with filter `(&(objectCategory=computer)(objectClass=computer))`; hard cap 10,000 results.
- proxyQuery is LDAP search pass-through (filter/baseDn/scope/attributes/sizeLimit configurable).

**When changing this:**
- Verify LDAP bind connection + TLS options (verifyTls flag) still work for LDAPS.
- Test OU filtering (ouInclude/ouExclude wildcard match) against distinguishedName.
- Confirm disabled-account tagging (`ad-disabled` tag) and status logic (decommissioned).
- Check SID cross-link stamping `sid:{SID}` (uppercase) for hybrid-join asset deduplication.
- Validate syncActiveDirectoryDevices creates correct AssetSource rows with sourceKind="ad".
- Test paged search (page size 1000) doesn't miss assets with large OU hierarchies.
- syncActiveDirectoryDevices in discoveryEngine.ts runs a forward-DNS pre-pass (via dnsService.getConfiguredResolver) to fill Asset.ipAddress for new + IP-less existing assets. Gate is `!existing.ipAddress` — never overwrites a non-empty IP from FortiGate/Entra/operator. ipSource stamped "activedirectory-dns".

---

## services/ldapClient.ts

**What it owns:** Shared `ldapts` connection helpers (TLS, bind/unbind lifecycle, AbortSignal, RFC-4515 escaping, objectGUID decode) — one code path used by both on-prem AD discovery and LDAP user auth.

**Public API:** `buildLdapUrl`, `newLdapClient`, `withBoundLdapClient`, `escapeLdapFilterValue`, `decodeObjectGuid`, `formatLdapError`

**Cross-service deps:** none (ldapts, node:crypto).

**Used by:** `src/services/ldapAuthService.ts` and `src/services/activeDirectoryService.ts` (bind + search helpers).

**Invariants:**
- Single TLS decision: `rejectUnauthorized = !!config.verifyTls`; default ports 389/636; bounded connect + general timeouts.
- No referral chasing (referrals surface as non-results, not recursive binds).
- `escapeLdapFilterValue` runs on every user-supplied filter value — order: backslash first, then `*`, `(`, `)`, null.

**When changing this:**
- Don't add referral chasing without threat-modeling attacker-influenced server binding; don't weaken the filter escape.

---

## services/intunePublishService.ts

**What it owns:** Publishing the Windows SSH onboarding pair to Intune as a Remediation (`deviceHealthScript`), and the Graph API-version probe that finds where the tenant serves that collection.

**Public API:** `INTUNE_POLICY_NAME`, `IntunePublishTarget`, `IntunePublishResult`, `listPublishTargets`, `publishOnboardingScripts`, `_resetResolvedBase`.

**Cross-service deps:** `entraIdService.graphApiRequest`, `windowsSshOnboardingService.getOnboardingScript`, `eventLogService`, `db` (prisma).

**Used by:**
- src/api/routes/serverSettings.ts — `GET /agents/script-publish/targets`, `POST /agents/script-publish/intune`
- public/js/agent-ssh-onboarding.js — the Publish pane

**Invariants:**
- **NEVER calls `/assign`.** Assignment is the human review gate for a script that grants fleet-wide administrative SSH. Two tests (create AND update paths) assert no request URL contains `/assign` or `assignments`. Adding one is a product decision with a security review attached, not a missing feature.
- Upsert is by `displayName`, so **renaming `INTUNE_POLICY_NAME` strands the published policy** and the next publish creates a second one.
- The version probe treats **404 as "wrong API version, try the next"** and **403 as "this version exists, permission missing"**. Falling through on a 403 would report the wrong problem and publish to the wrong base. It depends on `graphApiRequest`'s 403 message wording — the graphRequest test pins that string.
- Opt-in per integration (`publishToIntune`); refuses with a message naming the checkbox, and reaches the tenant zero times when off.
- **The Graph scope this needs is `DeviceManagementScripts.ReadWrite.All`**, observed against a live tenant 2026-09-08 — NOT the `DeviceManagementConfiguration.*` the v1.0 reference lists for `deviceHealthScripts`. Which one a tenant enforces tracks the API version it answers the collection on, which is what the version probe is for. Operator-facing copy (the integration modal's Script Publishing tab, README, INSTALL) names the Scripts scope and tells the reader the 403 text is the authority. Do not "fix" this back to a single scope from the docs alone.
- **The version-probe cache is keyed by `tenantId`, never process-global.** Which API version serves `deviceHealthScripts` is a property of the TENANT, so one shared string would let the first tenant probed decide for every other one — an install with two Entra integrations (prod + test, or a post-acquisition pair) would publish against the wrong base and fail confusingly. `resolvedBaseByTenant` + `_resetResolvedBase()` (test seam, clears all); two tests pin it — a second tenant gets its own probe, and a repeat publish to the SAME tenant re-probes zero times.

**When changing this:**
- Tests: `tests/unit/intunePublish.test.ts` (20) + `tests/unit/graphRequest.test.ts` (14, the transport).
- Route gate is chained at **fullwrite on BOTH** `serverSettingsSystem` and `integrations` — `integrations:write` is the blanket gate on that whole router and must not confer tenant writes.

---

## services/arcPublishService.ts

**What it owns:** Running the SSH onboarding script on Azure Arc machines — target listing, roster re-resolution, dispatch orchestration and the batch audit. The ARM write itself lives in `azureArcService.dispatchRunCommand`.

**Public API:** `ARC_RUN_COMMAND_NAME`, `ArcPublishTarget`, `ArcPublishResult`, `listPublishTargets`, `listMachines`, `runOnboardingOnMachines`, `getMachineResult`.

**Cross-service deps:** `azureArcService` (`dispatchRunCommand` / `listRunCommandTargets` / `readRunCommandResult`), `windowsSshOnboardingService.getOnboardingScript`, `eventLogService`, `db` (prisma).

**Used by:**
- src/api/routes/serverSettings.ts — `/agents/script-publish/arc{,/machines,/result}`
- public/js/agent-ssh-onboarding.js — the Publish pane's Arc machine picker

**Invariants:**
- **Arc has NO inert state.** A run command executes on creation, so unlike Intune there is nothing to hand a reviewer after the fact. The review gate is the operator's explicit selection — never add an "all machines" or filter-expanding affordance to this path.
- **ARM ids are re-resolved against the live roster**, case-insensitively. The subscription / resourceGroup / region that reach ARM must come from Azure, not from a request body a caller could point elsewhere. Ids not in the roster are dropped and recorded in the audit `unknownArmIds`.
- Capped at 200 targets per call, so a slip in the picker cannot become a fleet-wide event.
- **Both platform scripts are sent**; `dispatchRunCommand` routes per `osType` and SKIPS an undeterminable OS rather than guessing — guessing wrong runs PowerShell through a shell as root.
- Per-item tolerant: one machine's failure never aborts the batch, and the result reports dispatched / skipped / failed separately (a successes-only view cannot distinguish "42 onboarded" from "42 attempted, 30 skipped").
- **One warning-level Event per batch**, not per machine — 200 targets would bury the Events page.
- Opt-in per integration (`allowRunCommand`), enforced in BOTH this service and `dispatchRunCommand` itself, so the low-level write is safe even if a future caller forgets.

**When changing this:**
- Tests: `tests/unit/arcPublish.test.ts` (13, orchestration) + `tests/unit/arcRunCommand.test.ts` (10, the ARM write — OS routing, skips, partial failure). The second exists because the first mocks `dispatchRunCommand`, which is where the safety-critical logic lives.
- The required Azure grant is an **RBAC role assignment** (`Microsoft.HybridCompute/machines/runCommands/write`), NOT a Graph permission. `README.md`'s "Reader is sufficient" guidance is now conditional.

---

## services/entraIdService.ts

**What it owns:** Microsoft Entra ID (Azure AD) + Intune device discovery via OAuth2 Graph API client (device registration, Intune enrollment, compliance, user assignment).

**Public API:** testConnection, proxyQuery, discoverDevices, EntraIdConfig, DiscoveredEntraDevice, EntraDiscoveryResult, EntraDiscoveryProgressCallback.

**Cross-service deps:** None (pure Graph API client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts — discovery trigger, test connection, manual Graph proxy query. src/services/discovery/discoveryEngine.ts — sync path syncEntraDevices.

**Invariants:**
- OAuth2 client-credentials flow; tokens cached in-memory by tenantId:clientId until expiry ≥60s buffer.
- **A 403 on a CACHED token re-mints once and retries; a 403 on a fresh token does not.** An app-only token freezes its `roles` claim at issuance, so a permission granted after the cached token was minted is invisible for up to an hour — the operator fixes the grant, clicks again, and gets a byte-identical 403. `getAccessToken` returns `{token, fromCache}` for exactly this decision; the `fromCache` guard is what keeps a genuinely unauthorized app from paying a token fetch per attempt. Three cases in `tests/unit/graphRequest.test.ts` pin all three outcomes.
- Device identity: Entra `deviceId` (GUID) is stable key → `AssetSource.externalId` with `sourceKind="entra"` or `"intune"`.
- When enableIntune=true, both `/v1.0/devices` and `/v1.0/deviceManagement/managedDevices` are fetched & merged on azureADDeviceId ↔ deviceId; Intune data wins on shared fields.
- Hybrid-joined devices carry `onPremisesSecurityIdentifier` (SID) → cross-link to activeDirectoryService via `sid:{SID}` tags.
- Disabled devices (accountEnabled=false) → `decommissioned` status when `includeDisabled=true` (default).
- Asset type inferred from Intune `chassisType` (desktop/laptop → workstation; other → other); Entra-only defaults to workstation.
- `deviceInclude`/`deviceExclude` filters match against displayName with wildcard support.
- proxyQuery is read-only Graph API pass-through (GET only, /v1.0/ or /beta/ prefix required).

**When changing this:**
- Test OAuth2 token caching + refresh 60s before expiry; verify no mid-request expirations, and that the 401/403 re-mint paths still retry exactly once.
- Verify Intune merge logic on shared fields (Intune data must win over Entra).
- Check hybrid-join SID cross-link still tags assets correctly for AD ↔ Entra matching.
- Validate deviceInclude/deviceExclude wildcard matching against displayName.
- Confirm syncEntraDevices in integrations.ts creates AssetSource rows with correct sourceKind ("entra"/"intune") based on sources array.

---

## services/azureArcService.ts

**What it owns:** Azure Arc (Arc-enabled servers) discovery via Azure Resource Manager — `Microsoft.HybridCompute/machines`. The Connected Machine agent runs in the guest, so this source carries host truth (running OS SKU, real FQDN, live SMBIOS data, heartbeat status) rather than a directory record.

**Public API:** `testConnection(config)`, `proxyQuery(config, method, path, query?, body?)`, `discoverMachines(config, signal?, onProgress?)`, plus the pure helpers the unit tests drive: `normalizeSubscriptionId`, `buildArcMachinesQuery`, `buildArcVmInstancesQuery`, `buildArcSqlInstancesQuery`, `buildArcClustersQuery`, `normalizeArcCluster`, `buildArcClusterObservedBlob`, `normalizeVmUuid`, `swapVmUuidEndianness`, `parseArmResourceId`, `parentMachineIdFromExtensionId`, `normalizeArcMachine`, `normalizeArcVmInstance`, `normalizeArcSqlInstance`, `extractIpAddresses`, `inferArcAssetType`, `arcStatusIsConnected`, `matchesTagFilter`, `filterArcMachines`, `arcHostnameCandidates`, `buildArcObservedBlob`, `describeAadTokenError`, `extractArmError`, `throttleDelayMs`. Types `AzureArcConfig` / `DiscoveredArcMachine` / `ArcVmInstance` / `ArcSqlInstance` / `ArcDiscoveryResult`.

**Cross-service deps:** `src/utils/entraClientCredentials.ts` (the SAME token-request builder the Graph client uses — only the scope differs, at `https://management.azure.com/.default`; do not fork it), `src/utils/integrationFilter.ts -> matchesWildcard`, `src/utils/errors.ts -> AppError`.

**Used by:** `src/api/routes/integrations.ts` (config schema, `/:id/test`, pre-save `/test`, `/:id/query`), `src/services/discovery/discoveryEngine.ts` (`runPreflightTest`, the dispatch branch, and `syncArcDevices`).

**Invariants:**
- Token cached per `tenantId:clientId`; invalidated on 401 with exactly one retry. `testConnection` always invalidates first so it exercises the freshly-typed secret.
- **ONLY GUID-validated subscription ids are interpolated into the Resource Graph query.** Every other filter (resource group, machine name, tags) is applied client-side in `filterArcMachines` specifically so free-form operator wildcards never reach the query language. Do not "optimize" those into KQL without adding escaping and tests.
- `normalizeVmUuid` REJECTS the all-zero (and all-F) GUID. Some BIOSes report it; if those collapsed onto one map key every such machine would mass-merge into a single asset.
- `swapVmUuidEndianness` is involutive and BOTH variants must be indexed at match time. Windows, `dmidecode` and VMware disagree about byte-swapping the first three SMBIOS UUID fields, so the same machine can present either form — index one only and every Arc-on-VMware machine silently duplicates instead of merging.
- ARG and per-subscription rows must normalize IDENTICALLY (`normalizeArcMachine`); a unit test locks this. Drift means the two read paths mint different assets for the same machine.
- `proxyQuery` is host-pinned to `management.azure.com`, requires an `api-version`, and permits POST only to `/providers/Microsoft.ResourceGraph/resources`.
- API versions are module-level consts and are **verify-on-real-tenant**, as is the `detectedProperties` bag — its key names vary by Connected Machine agent version, so every read of it is optional-chained and case-tolerant.
- `fetchNetworkProfile` is ONE GET PER MACHINE: default off, concurrency-capped, deadline-bounded, and it reports what it skipped rather than silently truncating.
- The extension-resource enrichment (`enableVmInstances` / `enableSqlServer`) is **Resource-Graph-only and creates no assets**. Both fold into the owning machine's record. If you ever add a resource-provider fallback for them, remember why there isn't one: ARG costs one query for the tenant, the RP costs one GET per machine. The two parent links are NOT the same shape — VM instances nest under the machine id, SQL instances point at it via `properties.containerResourceId`.
- An extension row whose parent machine isn't in this run's result set is ORPHANED, not an error — the machine may simply have been filtered out.
- The serial bridge (`src/utils/hardwareIdentity.ts`) is what lets an Arc machine merge onto an AD-discovered asset — those two sources share NO definitive key otherwise. Matching on a raw serial is unsafe: `normalizeHardwareSerial` rejects vendor placeholders, and `indexUniqueBy` must ALSO drop serials claimed by two assets, because the agent's Windows fallback reports `SystemSKU` (a model SKU) when the real serial is empty. Never match on a serial without both guards; the failure mode is merging a whole model line into one asset, which is silent.
- Connected Kubernetes clusters (`enableKubernetes`) are the ONE Arc entity that becomes an asset in its own right — `assetType: "kubernetes_cluster"`, `sourceKind: "arc-k8s"`, synced by `syncArcClusters`. Adding that asset type is a THREE-WAY lockstep (migration + `BUILT_IN_ASSET_TYPES` + `BUILT_IN_SEEDS`); `seedBuiltInAssetTypes` skips seeds not in the built-in list, so two-of-three is a silent no-op on fresh volumes and restored backups. `tests/unit/arcAssetTypeLockstep.test.ts` guards it.
- Because the cluster class is a NEW asset type rather than a reused workstation/server one, it needs a `classBlockKeyForAssetType` arm, an `AddAsMonitoredAssetType` member, a `pickClassStreamsBlock` branch and **all three raw-SQL CASE expressions** in `monitorOverrideService`. That is the whole cost difference between Phase 4 and Phases 1–3.

**When changing this:**
- A new PROJECTED field needs three things in lockstep: the key in `buildArcObservedBlob`, an `arc` rule in `src/utils/assetProjection.ts` at a justified rank, and the `syncArcDevices` line that copies it out of the projection.
- A new per-class knob needs `AzureArcConfigSchema` in `src/api/routes/integrations.ts` + the readers in `public/js/integrations.js -> getArcFormConfig()`.
- Arc reuses the `workstationMonitor` / `serverMonitor` block names DELIBERATELY — most downstream registries key on the block name, not the integration type, which is why `monitorOverrideService`'s raw-SQL CASE expressions and `classToBlockKey` needed no change. Renaming those blocks would fan out across all of them.
- Field shapes are unverified against a live tenant. Capture a real response, **scrub it to synthetic all-zero GUIDs**, and freeze it as a fixture before trusting any new field.

**Related:** [cross-cutting/integration-type-onboarding](#cross-cuttingintegration-type-onboarding), `services/entraIdService.ts` (the shape this file mirrors), `services/vcenterService.ts` (the vmUuid cross-link counterpart).

---

## services/presenceVerificationService.ts

**What it owns:** Post-discovery network-presence verification for AD/Entra/Intune assets — a cheapest-first signal cascade (already-fresh → agent heartbeat → answering monitor probe → single ICMP) that establishes `Asset.lastSeen`, with bounded ICMP concurrency and a hard pass deadline.

**Public API:** `PresenceCandidate`, `PresenceSignal`, `PresenceVerificationSummary`, `classifyPresenceSignal`, `runPresenceVerification`

**Cross-service deps:** `prisma`, `logger`, `logEvent`, `bumpLastSeen`, `pingHost`.

**Used by:** `src/services/discovery/discoveryEngine.ts` — discovery post-sync pass / `verify-presence` (integration `config.verifyPresence` toggle).

**Invariants:**
- A failed ping writes NOTHING (Windows hosts commonly drop ICMP; no pong ≠ absence) — `lastSeen` advances only on positive evidence via `bumpLastSeen`.
- ICMP is concurrency-capped with a per-ping timeout and a hard pass deadline; `lastSeen` writes are batched in chunked transactions.
- Ping target priority is dnsName > hostname > ipAddress (stored ipAddress is often stale on directory-discovered assets).

**When changing this:**
- Agent-heartbeat and monitor-probe steps are best-effort; keep the no-write-on-ping-failure rule.

---

## services/windowsServerService.ts

**What it owns:** Windows Server DHCP discovery via WinRM PowerShell remoting (DHCP scopes, subnets, include/exclude filtering).

**Public API:** testConnection, discoverDhcpScopes, WindowsServerConfig, DiscoveredDhcpScope.

**Cross-service deps:** None (WinRM client; no service-to-service calls).

**Used by:** src/api/routes/integrations.ts — discovery trigger, test connection. src/services/discovery/discoveryEngine.ts — subnet sync.

**Invariants:**
- WinRM simple auth (HTTP/HTTPS, default port 5985/5986); no Kerberos.
- PowerShell Get-DhcpServerv4Scope query returns ScopeId (MAC + subnet); mapped to DiscoveredDhcpScope shape (cidr/name/fortigateDevice/dhcpServerId).
- `fortigateDevice` field repurposed to hold DHCP server hostname for compatibility with FMG/FortiGate discovery result shape.
- `dhcpInclude`/`dhcpExclude` scope filtering applied server-side before returning.
- Results fed to same syncDhcpSubnets pipeline as FMG/FortiGate (produces Subnet rows, no device inventory).
- No per-device iteration; single WinRM call returns all scopes on that server.

**When changing this:**
- Verify WinRM URL construction (scheme + port based on useSsl flag).
- Check PowerShell query still works on target Windows versions (Server 2016+).
- Confirm dhcpInclude/dhcpExclude filtering still matches scope IDs/names correctly.
- Test DiscoveredDhcpScope mapping (cidr/name/fortigateDevice/dhcpServerId) feeds syncDhcpSubnets correctly.
- Validate error messages for auth failures, service not running, connection timeouts.

---
