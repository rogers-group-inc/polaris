# Services — asset identity, merge, type, quarantine, pins, dependency tree, tags

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/macAddressService.ts

**What it owns:** The two AssetMacAddress side-table WRITERS (moved from utils/macAddresses 2026-08 — utils stay pure): `reconcileMacAddresses(assetId, macs)` (discovery's in-memory-list sync — bulk INSERT…ON CONFLICT, mac-sorted for deterministic lock order, deadlock-retried) and `reconcileInterfaceMacs(assetId, macs, now?)` (the interface-scrape fold into `[mac, macEnd]` range rows, source-scoped full-replace with the occupied-key slide).

**Public API:** `reconcileMacAddresses`, `reconcileInterfaceMacs`.

**Cross-service deps:** `prisma` (asset_mac_addresses), `utils/dbRetry.retryOnDeadlock`, and the pure surface in `utils/macAddresses` (INTERFACE_MAC_SOURCE, foldMacsToRanges, macToInt/intToMac, MacJsonEntry/MacRangeEntry).

**Used by:** `discovery/discoveryEngine` (every asset-write site that rebuilt a mac list), `api/routes/agents.ts` (interfaces push + sample-merge), `monitoringService` (system-info interface scrape).

**Invariants:**
- Ownership split: rows with `source="monitor-interface"` (the only rows that may carry `macEnd`) belong to `reconcileInterfaceMacs`; `reconcileMacAddresses` filters them from its input AND scopes its deletes away from them. Neither writer may churn the other's rows.
- When another source holds a would-be range's start key, the range starts one past it (the occupied row keeps its richer discovery metadata).
- All writes ride `retryOnDeadlock`; the discovery reconcile sorts by mac asc so ~50 parallel reconciles acquire index-page locks in deterministic order.

**When changing this:** search behavior depends on canonical colon-uppercase storage (string order == numeric order for range containment — see searchService); anything changing the stored MAC shape breaks range lookup.

---

## services/tagAssignmentService.ts

**What it owns:** Filter-based tag auto-assignment ("managed sync"). Both device-filter contracts on `Tag` — the CURRENT `assetCondition` condition tree (the automations / address-book shape) and the LEGACY flat `criteria` blob it superseded — the asset-matching engines behind each, and the diff-based reconcile that keeps every filter-bearing tag synced onto matching assets via the `TagAutoAssignment` provenance table. Strictly an asset-tagging service — it never writes block/subnet tags.

**Public API:** Filter shape — `TagFilter` / `TagFilterView` types, `tagFilterOf` (the ONE normalizer every reader goes through), `tagIsManaged`, `normalizeTagCondition` (validate a POSTED tree), `tagFilterView` (the editor projection), `resolveTagFilterAssetIds`. Legacy shape — `TagCriteria` / `CriteriaRule` types, `normalizeCriteria`, `buildPrefilterWhere`, `assetMatchesCriteria` (pure predicate, test-only convenience), `resolveMatchingAssetIds`. Reconcile + preview — `reconcileTag`, `reconcileAllTags`, `reconcileTagsForAsset`, `previewTagFilter`, `stripTagAssignments`. Also `listAssetTags` (the `tag` value list behind either device-filter builder) and `listTagCatalog` (the REGISTRY as a picker needs it — id/name/category/colour + the `enforce` flag).

**Cross-service deps:** `deviceFilterConditionSchema` / `evaluateScopeCondition` / `scopeConditionStats` / `conditionFields` / `conditionNeedsInterfaces` from `notificationTypes.ts` (the tree contract + evaluator); `resolveDeviceFilterAssetIds` / `deviceFilterSelect` from `deviceFilterService.ts` (fleet-wide tree resolution); `criteriaToCondition` from `utils/criteriaToCondition.ts` (the fold-forward); `compileWildcard` from `autoMonitorInterfacesService.ts` (pattern compile); `isValidCidr` / `isValidIpAddress` from `utils/cidr.ts`; `isKnownAssetType` / `normalizeAssetTypeName` from `utils/assetTypes.ts`; `prisma.asset` (tags[] read-modify-write), `prisma.tag` (criteria read), `prisma.tagAutoAssignment` (provenance), one raw inet `>>=` query for subnet membership.

**Used by:**
- `src/api/routes/serverSettings.ts` Tag routes — `normalizeTagCondition` + `normalizeCriteria` (validate on POST/PUT via the local `readPostedTagFilter`), `tagFilterView` (decorates `GET /tags` so the editor can open a legacy tag in the builder), `tagIsManaged` (whether DELETE has provenance to strip), `reconcileTag` (inline after create/edit), `stripTagAssignments` (on delete), `previewTagFilter` (`POST /server-settings/tags/preview-criteria`), plus `listAssetTags` for `GET /server-settings/tags/filter-schema`.
- `src/services/contactService.ts` — `normalizeCriteria` / `assetMatchesCriteria` / `resolveMatchingAssetIds` / `cidrsContainingIp` / `collectCidrs` / `SINGLE_ASSET_CANDIDATE_SELECT` for contacts still on the legacy blob, and `listAssetTags` for the address book's filter schema.
- `src/services/discovery/discoveryEngine.ts` Phase 13.65 — `reconcileAllTags()` at end of FMG/FortiGate discovery.
- `src/api/routes/assets.ts` POST/PUT — `reconcileTagsForAsset(id)` (best-effort) on create + on update when a criteria-relevant field changed.
- `src/jobs/reconcileTagAssignments.ts` — 6h safety-net tick calls `reconcileAllTags()`.
- `src/api/router.ts` — `listTagCatalog` behind `GET /server-settings/tags/catalog`, declared ABOVE the blanket `serverSettingsSystem:read` mount so it is auth-only. That route exists because the shared tag picker (`tagFieldHTML` in `public/js/app.js`) is rendered by every form that can tag something — asset edit, blocks, subnets, the IPAM block panel — and none of those roles hold `serverSettingsSystem`: every non-admin built-in is seeded `none`, so the picker's read of `GET /tags` + `/tags/settings` 403'd and `_ensureTagCache`'s swallowed failure made it render "No tags defined yet" at an install with a full registry. `public/js/users.js` `loadTagList` reads the same route (it used to skip the read entirely for a user administrator without the grant).

**Invariants:**
- **The prefilter is a strict SUPERSET of the predicate.** `buildPrefilterWhere` may only ever loosen: exact→insensitive-equals, contains→insensitive-contains, pattern→`startsWith(literalPrefix)` ONLY when every value in the rule has a prefix (else the rule contributes no DB clause); subnet rules are always predicate-only. Never tighten — a candidate dropped by the prefilter is silently never matched.
- **Managed sync touches only engine-owned copies.** A tag is removed from an asset only when a `TagAutoAssignment` row exists for that (tag, asset). A hand-applied copy of the same tag name on a non-matching asset (no provenance) is preserved forever. This is the manual-vs-auto collision defense — keep the provenance check on every remove path.
- **Decommissioned assets are ineligible unless the filter mentions `status`** — on BOTH paths. Implicit in `buildPrefilterWhere` for the flat shape; stated explicitly for the tree in `tagEligibilityWhere` (fleet) / `tagAssetIsEligible` (single asset), ANDed OUTSIDE the tree so it stays sound under `or` / `none` / `notAll` groups. The shape cutover would otherwise have quietly begun auto-tagging retired inventory.
- **An EMPTY condition tree is NO filter, never "all devices."** `and([])` is true for every asset by boolean identity — which is exactly what `Contact` means by it, as the stored form of an explicit All-devices checkbox. A tag has no such control (just an Auto-assign toggle), so an empty tree could only arrive from a half-built form and honoring it would tag the whole fleet on save. `normalizeTagCondition` collapses it to null, and the browser posts an explicit `assetCondition: null` rather than the empty tree.
- **Exactly ONE filter shape is live per row.** A write of either column clears the other, so a row can never carry two answers to "which devices?". Readers must go through `tagFilterOf` and never branch on a column directly.
- **A stored tree that no longer validates drops to null, it does not throw** — one bad row must not 500 the tag list or wedge the reconcile job.
- Subnet membership goes through the family-aware inet query (`cidrContainmentMap`), NOT the v4-only `Netmask`/`ipInCidr` path — IPv6 CIDRs must work.
- Neither column set (`tagIsManaged` false — an ordinary manual tag) makes the tag invisible to the engine: it is never added or removed.
- **The "Map Regions" category is locked to the Device Map**, enforced in `serverSettings.ts` (`assertNotRegionCategory` + the filter check in `readPostedTagFilter`), not here: creating a tag in it is refused, MOVING one in is refused (the same act), and a tag in it may not carry an auto-assign filter — `RegionTagAssignment` already manages those tag NAMES, and `TagAutoAssignment` on the same name would be a second reconciler stripping the first's work every cycle.
- Reconcile writes are idempotent + batched (chunks of 50 in `$transaction`); skip when the tags array doesn't change. Scale-checked: fleet passes are bounded to (#managed tags) prefilter queries; per-asset path is O(#managed tags) + one inet round-trip.

**When changing this:**
- Adding a field to the CURRENT (tree) vocabulary is a change to `DEVICE_FILTER_FIELD_OPS` in `notificationTypes.ts`, not here — see that service's entry; the tag surface picks it up for free through `GET /server-settings/tags/filter-schema`. Remember the asset-write hook's field list in `assets.ts`, which decides when a PUT re-runs `reconcileTagsForAsset`.
- Adding a field to the LEGACY (flat) vocabulary: don't. It exists only to keep un-migrated rows matching. If you must, extend `STRING_FIELDS`/`ENUM_FIELDS` (+ domain validation), add the column to `CANDIDATE_SELECT`, keep `buildPrefilterWhere` a superset, AND teach `utils/criteriaToCondition.ts` to fold it — an unfoldable field pins every row carrying it on the legacy predicate forever.
- Relation-backed fields (`RELATION_FIELDS` = `integration`, `fortigate` — added for the maintenance asset filter) match discovery provenance, not Asset columns: `integration` (exact-only Integration ids) = `discoveredByIntegrationId` OR any `AssetSource.integrationId`; `fortigate` (string ops) = `learnedLocation` OR any `AssetFortigateSighting.fortigateDevice`. Their relations are loaded only when referenced (`buildCandidateSelect`); their prefilter must OR across BOTH surfaces (narrowing on one would drop predicate matches from the other). They're deliberately NOT in the assets.ts write-hook field list — operator PUTs can't change provenance; the periodic reconcile covers discovery-side drift. The maintenance builder surfaces them; the Tags UI doesn't yet.
- The browser no longer parses either shape by hand: `public/js/server-settings.js` renders the tag filter through the shared `PolarisConditionBuilder` (`_tagFilterSectionHTML` / `_collectTagFilter` / `_wireTagFilterBuilder`), so there is nothing to keep in sync beyond the vocabulary the schema route serves. `server-settings.html` must keep loading `/js/condition-builder.js`.
- **The editor omits BOTH shape keys to mean "leave the filter alone."** A tag whose legacy blob can't be folded (`assetFilterUnconvertible` non-empty) renders the toggle ON with an empty builder and a warning; saving without building anything must not post `assetCondition: null`, which would clear a live filter the operator was only warned about. `_collectTagFilter(builder, stuck)` is where that lives.
- Criteria tags are normal registry tags, fully editable in the manual tag picker. (`region:` tags are too, since 2026-08 — the picker's protected-prefix machinery is gone; provenance is what protects hand-edits now, for both engines.)
- **`listTagCatalog` must stay LEAN, and its route must stay above the mount.** A `Tag` row also carries `assetCondition` / `criteria` — the auto-assignment device filter, which is registry-management detail and belongs behind the `serverSettingsSystem` gate. What a picker needs (name, category, colour) is what every asset, block and subnet row already shows anyone with read on that page, which is what makes the auth-only gate right. If you add a column to the projection, ask which of those two it is. And if you ever need the catalogue at a THIRD surface, read this route rather than adding a fourth workaround — `GET /automations/scope-options`' `tagCatalog` field and `GET /server-settings/tags/filter-schema`' `tags` already exist because this route didn't.
- See cross-cutting **Asset.tags** for the full writer list (this service is now one of them).

---

## services/assetIpHistoryService.ts

**What it owns:** Asset IP history reads, Settings-backed retention policy, pruning sweep, and the batch writer for *associated* interface IPs (`recordIpHistoryEntries`). The primary-IP rows are still written by the Prisma query extension in `src/db.ts` (`recordIpHistory`).

**Public API:** `getIpHistory(), recordIpHistoryEntries(), prepareIpHistoryEntries(), pruneOldHistory(), getHistorySettings(), updateHistorySettings()`

**Cross-service deps:** None. (`recordIpHistoryEntries` is called by `monitoringService.recordSystemInfoResult`.)

**Used by:** `src/api/routes/assets.ts — fetch IP history for asset detail modal`, `src/api/routes/assets.ts — prune endpoint (manual trigger)`, `src/services/monitoringService.ts — recordIpHistoryEntries() after the asset_associated_ips persist`

**Invariants:**
- History has two writers: (1) the `src/db.ts` Prisma extension on every Asset write that touches the primary `ipAddress`; (2) `recordIpHistoryEntries()`, called from the systemInfo scrape persist with the asset's interface IPs (incl. public WAN / secondary addresses). The batch writer **skips the asset's primary `ipAddress`** (already owned by writer 1) so the two never flip `source` back and forth and churn `firstSeen`.
- `recordIpHistoryEntries()` is best-effort (swallows DB errors) and fire-and-forget — it must never block or fail the scrape. Single multi-row `INSERT … ON CONFLICT` per call (one round-trip regardless of interface count — scale-safe at thousands of assets). `prepareIpHistoryEntries()` is the pure (testable) dedupe/skip-primary half.
- Retention is Setting-backed (`retentionDays`, default 0 = keep forever); `getIpHistory()` filters on read, stored rows never auto-delete unless `pruneOldHistory()` is called.
- `pruneOldHistory()` is a manual operation (not yet hooked to a background job); operator triggers via Server Settings → Maintenance → Prune old IP history.
- Setting persists across app restarts; read-time filtering is applied client-side by `getIpHistory()` calls.

**When changing this:**
- If adding background prune job (jobs/pruneIpHistory.ts), ensure it respects the Setting key "assetIpHistorySettings".
- Verify Prisma extension in `src/db.ts` still writes `AssetIpHistory` on Asset.ipAddress changes.
- Check assets.html History tab UI for retentionDays Setting control + prune button.
- Ensure Prisma schema AssetIpHistory._unique_ constraint on (assetId, ip) handles re-sight updates (lastSeen bump).

---

## services/assetGhostMergeService.ts

**What it owns:** Automated ghost merging, two flavors: (1) the endpoint-ghost merge — collapses a duplicate `fortigate-endpoint` placeholder Asset (created when a managed FortiSwitch/FortiAP's mgmt interface pulled a DHCP lease and the FortiGate's DHCP/device-inventory pathway learned its MAC as an ordinary client; hostname = the device serial) into the canonical infrastructure asset, then deletes the ghost; and (2) the duplicate-hostname policy + executor behind the mergeDuplicateHostnameAssets sweep (moved from the job 2026-08 so they're unit-testable): `decideDuplicateHostnameGroup` picks the canonical by source-kind tier (identity-tagged 1 > fortiswitch 2 > fortiap 3 > firewall 4 > endpoint 5 > manual 6 > orphan 7; lastSeen/updatedAt tiebreak; same-tier conflicting-MAC groups skip for operator review) and `mergeDuplicateHostnameGhost` runs the per-ghost transaction (side-table transfer, null-fill scalar absorption + tag union, bumpLastSeen-gated lastSeen adoption, ghost cascade-delete).

**Public API:** `isMergeableGhostSourceKinds` (pure), `isMergeableEndpointGhost`, `mergeEndpointGhostIntoAsset`, `GhostMergeResult`, `decideDuplicateHostnameGroup` (pure), `mergeDuplicateHostnameGhost`, `DuplicateHostnameAssetRow`, `DuplicateGroupDecision`

**Cross-service deps:** `prisma`, `assetMergeService.transferAssetSideTables` (shared side-table transfer), `monitorOverrideService.recomputeMonitorOverrideForAssets` (after a monitored carry-over).

**Used by:** `src/services/discovery/discoveryEngine.ts` — the `sweepEndpointGhostsInto` helper called from the FortiSwitch + FortiAP loops of `syncDhcpSubnets` (both update and create branches; candidates = base-MAC lookup + hostname==serial lookup, never bare IP); `src/jobs/mergeFortiswitchEndpointGhosts.ts` (one-shot startup sweep for the legacy NULL-MAC shape).

**Invariants:**
- Eligibility is provenance-based, never assetType-based: the ghost must carry a `fortigate-endpoint` AssetSource and NO authoritative source (`fortiswitch` / `fortiap` / `fortigate-firewall` / `ad` / `entra` / `intune` / `polaris-agent`). The empty `manual` row an operator edit stamps does NOT disqualify. Hand-created assets and real discovered devices can never be absorbed.
- Ghost AssetSource rows are DELETED, not re-bound — deliberately different from `assetMergeService.mergeAssets` (see that entry): re-binding would staple a stale fortigate-endpoint / orphaned manual source onto the infra asset. Tags are NOT unioned for the same reason.
- The duplicate-hostname merge null-fills scalars from the ghost (mirrors `acceptAssetConflict`'s ghost block) and treats `assetType = "other"` as null (`isGenericAssetType`): a canonical still filed as `other` adopts the ghost's specific type, never the reverse, and one specific type never replaces another — the canonical was chosen by source tier. The job's `select` must keep carrying `assetType` for this to fire.
- The ghost's MAC is adopted only when the canonical has none; `monitored=true` carries over only when the ghost was monitored and the canonical wasn't (endpoint ghosts are never auto-monitored, so that flag is operator intent), followed by a best-effort `recomputeMonitorOverrideForAssets`.
- Ghost sample hypertable rows are orphaned (no Asset FK since migration `20260615000000`) and age out via `drop_chunks` — never row-deleted (compressed-chunk bloat).

**When changing this:**
- Keep `AUTHORITATIVE_SOURCE_KINDS` in sync with the AssetSource `sourceKind` vocabulary — a new authoritative kind that isn't listed makes its assets eligible for absorption.
- The discovery-side caller updates the in-memory `AssetIndex` (`remove(ghost)` + `reindex(canonical)`) after each merge — later phases in the same sync would otherwise write to the deleted ghost.

---

## services/assetMergeService.ts

**What it owns:** Operator-driven asset merge (inverse of split) — re-binds an absorbed ("ghost") asset's multi-source discovery rows + side tables onto a survivor ("canonical") asset, applies per-field winners, then deletes the ghost.

**Public API:** `MERGEABLE_FIELDS`, `MergeableField`, `FieldWinner`, `MergeAssetsResult`, `mergeAssets`, `transferAssetSideTables`, `SideTableTransferCounts`, `absorbAssetRelations`, `AbsorbedRelationCounts`, `transferDependencyEdges`, `DependencyParentWinner`, `DependencyTransferCounts`, `resolveMonitoringCarry`, `CONCATENATED_FIELDS`, `combineAssetNotes`, `NotesSide`

**Cross-service deps:** `prisma`, `AppError`, `clampAcquiredToLastSeen`, `monitorOverrideService.recomputeMonitorOverrideForAssets` (after a monitored carry-over).

**Used by:** `src/api/routes/assets.ts` — `POST /assets/:id/merge`; `assetGhostMergeService.ts` (imports `transferAssetSideTables`).

**Invariants:**
- Canonical and ghost must be distinct IDs; all transfers run in a single `$transaction`.
- Ghost `AssetSource` rows re-bind to canonical (global `(sourceKind, externalId)` uniqueness means no collision); `AssetMacAddress` / `AssetAssociatedIp` / `AssetIpHistory` / `AssetFortigateSighting` delete-on-conflict when duplicates exist.
- `ManagedAgent` transfers only if the survivor has none; `lastSeen` keeps the more recent value; tags union; `acquiredAt` clamped to stay ≤ `lastSeen`.
- **An empty value never overwrites a populated one, whatever `fieldWinners` says — and for `assetType` the `other` catch-all counts as empty** (`fieldIsEmpty`, built on `utils/assetTypes.isGenericAssetType`). Default: a survivor filed as `other` takes the ghost's specific type. Explicit: a `ghost` winner whose value is `other` is refused when the survivor holds a specific type; two specific types still go to whichever side the body names. Mirrored by `_mergeFieldIsEmpty` in `public/js/asset-merge-modal.js` (radio defaults + the review-step preview), and applied identically by `assetGhostMergeService.mergeDuplicateHostnameGhost` and `conflictResolutionService.acceptAssetConflict`.
- **`monitored` is OR-ed, not "survivor wins"** — either side monitored ⇒ the survivor is monitored (`carriedMonitoring` in the result; same intent as `assetGhostMergeService.transferredMonitored`). ON-flip only: an unmonitored ghost never turns a monitored survivor off, and a survivor that was already monitored keeps its own config untouched. When the flip happens the ghost's monitoring CONFIG rides along — `MONITOR_CONFIG_FIELDS` (per-stream polling methods, credentials, MIB pins, interval/timeout overrides; ghost's non-null wins, survivor keeps its own where the ghost has none) and `MONITOR_PIN_FIELDS` (monitored/mapped interface / storage / tunnel / process / service arrays; UNIONed) — because enabling the flag alone would leave a monitored asset resolving streams off empty overrides. `monitorStatus` resets to null + failure/success counters to 0 (the ghost's samples are orphaned, so no history backs a carried status), then `recomputeMonitorOverrideForAssets` runs post-transaction.
- Business rule 10 outranks the carry-over: the merged status (`fieldWinners`-resolved, not just the survivor's current) landing on `decommissioned`/`disabled` skips it entirely. Resolved in-service because the `db.ts` clamp only fires when a write stages `status`, which a status-preserving merge doesn't.
- **Dependency edges survive the merge** (`transferDependencyEdges`, shared with the conflict-absorb path): edges where the ghost is the PARENT always re-point to the survivor (self-edges and rows whose child already holds the same (child, survivor, source) edge are left to cascade); the ghost's own parent links blank-fill onto a survivor with none, and when BOTH sides have parent rows `dependencyWinner` decides WHOLESALE (default "canonical" keeps the survivor's) — never a union, because one physical device has one real upstream and unioning parent sets weakens all-down suppression. The merge modal shows the conflict (a "Dependency parents" row with Keep A/B radios when both sides' effective parent sets differ) and passes the pick as the merge body's `dependencyWinner`. `lastSeenSwitch`/`lastSeenAp` carry with lastSeen-recency semantics so the endpoint edge can re-derive.
- Ghost's TimescaleDB sample rows are orphaned (no FK) and age out via `drop_chunks` — never row-deleted here.
- **`notes` is COMBINED, not won** (`CONCATENATED_FIELDS` — currently just that one field). Every other mergeable field names a single fact about the device, so a winner is the right verb and the loser's value is redundant; notes are an accumulated operator record where each side was written by somebody who did not know the other row existed, and a merge is irreversible. `combineAssetNotes` labels each block with its asset (`[hostname]`), orders survivor-first, and writes nothing at all in the cases where combining would manufacture noise: one side empty (the other passes through UNLABELED), identical text, or the survivor already containing the absorbed text — that last one is the idempotence guard that stops a second merge stacking the same block twice. Identical hostnames (the duplicate-hostname merge) disambiguate with a short id. `notes` stays in `MERGEABLE_FIELDS` so the list remains the one vocabulary the route validates and `ASSET_SELECT` derives from; a `fieldWinners` entry naming it is accepted and IGNORED rather than refused, so an older client and the conflict-card merge (which sends no winners) cannot fail on it.

**When changing this:**
- Keep `MERGEABLE_FIELDS` in sync with the comparison UI in `public/js/asset-merge-modal.js` (`_mergeCompareFields`; `combine: true` marks the concatenated ones).
- The comparison UI defaults the survivor to the side with the longer polling history (`GET /assets/:id/polling-history` → `sampleHistoryService.readPollingHistorySummary`; span first, sample count as tiebreak) precisely because the ghost's samples are orphaned here — if the merge ever starts carrying sample history over, retire that auto-select + the confirm-step "deleting the longer record" warning in `public/js/asset-merge-modal.js`.
- A new per-asset monitoring override column (polling method / credential / cadence / pin array) belongs in `MONITOR_CONFIG_FIELDS` or `MONITOR_PIN_FIELDS`, or a merge will enable monitoring without it. `ASSET_SELECT` derives from both lists, so adding it there is enough.
- The merge modal's review step mirrors the carry-over client-side (`monitoringCarried` in `_buildMergePlan`, `public/js/asset-merge-modal.js`) — keep the rule 10 exclusion in sync so the preview can't promise a flip the server refuses.
- **The per-field winner RADIOS default from the operator's Sources priority order**, not from "A wins" (`_mergeSourceRank` / `_mergePreferredSide` / `_mergeDefaultWinner` in `public/js/asset-merge-modal.js`, fed by `GET /assets/source-priority`). Two rows that are really one device were learned by different integrations, and that list is where the operator already said which of those they trust. Client-side only: the service still applies exactly the `fieldWinners` the body carries, so nothing here changes if the modal stops sending them. Three things not to break — the empty-value rule OUTRANKS the priority in both directions (an empty winner can never overwrite a value here, so defaulting to one renders a radio that does nothing; emptiness is per field via `_mergeFieldIsEmpty`, which reads a Type of `other` as empty); a `combine: true` field never reaches it, since those render no radios at all; and the survivor radio keeps defaulting on POLLING HISTORY rather than on source rank, because that choice is about which sample history is destroyed, not about which row is more trustworthy.
- `combineAssetNotes` is mirrored by `_mergeCombineNotes` in `public/js/asset-merge-modal.js` so the modal can PREVIEW what will be written. There is no build step to share one implementation; `tests/unit/mergeNotesMirror.test.ts` evaluates the browser file in a vm and asserts identical output across every shape decision, so a one-sided change fails there. Fix the mirror rather than the assertion — a preview that disagrees with the write is worse than none on an irreversible action.
- Adding a field to `CONCATENATED_FIELDS` needs the same three edits: the combine function, the `combine: true` flag in `_mergeCompareFields`, and the mirror test's case list.

---

## services/assetTypeService.ts

**What it owns:** CRUD + in-memory cache for the `AssetTypeDef` registry (replaces the retired `AssetType` enum). Built-in types (the eight historical + vCenter's `hypervisor` + Azure Arc's `kubernetes_cluster`) are protected; custom types support transactional rename and use-checked delete. The `virtual_machine` built-in was retired by migration 20260722000000 (vCenter VMs are typed `server`) — keep it out of `BUILT_IN_SEEDS` / `BUILT_IN_ASSET_TYPES` or the boot self-heal resurrects it.

**Public API:** `AssetTypeRow`, `listAssetTypes`, `getAssetType`, `createAssetType`, `updateAssetType`, `deleteAssetType`, `refreshCache`, `seedBuiltInAssetTypes`, `previewMatchRules`, `applyMatchRules`, `MatchPreviewRow`, `MatchPreviewResult`

**Cross-service deps:** `prisma`, `AppError`, `setAssetTypeRegistry` + asset-type validate/normalize helpers + `BUILT_IN_ASSET_TYPES` (utils/assetTypes), plus `utils/assetTypeMatch` (`setAssetTypeMatchRegistry`, `validateMatchRules`, `validateMatchContexts`, `normalizeMatchRules`, `explainAssetType`, `DEFAULT_TYPE_MATCHING`) — the pure resolver behind the matching columns. Since the 2026-09 tree cutover `matchConditionMeta()` there also publishes the condition-builder catalog served by `GET /asset-types/match-schema`.

**Used by:** `src/api/routes/assetTypes.ts` (registry CRUD), `src/jobs/seedAssetTypes.ts` (boot seed). Frontend readers of `GET /asset-types` (`api.assetTypes.list()`): `public/js/assets.js` (`_loadAssetTypeOptions` → `ASSET_TYPE_OPTIONS` + `ASSET_TYPE_LABELS`, which drive the Type column filter, the create/edit + PDF-import Type selects, and the row/bulk type menus — **every option list reads `ASSET_TYPE_OPTIONS`, never `ASSET_TYPE_LABELS`**: the labels map is seeded with the built-ins and only ever GAINS keys from the registry, so a menu built off it offers a type an operator deleted and, when built before the fetch resolves, offers ONLY the built-ins. That second half is what hid custom types from the bulk-bar Type menu until 2026-09 — `_wireBulkBarDropdowns()` runs at init well before `_loadAssetTypeOptions()` is awaited, so `_renderBulkTypeMenu()` is split out and called AGAIN from `_loadAssetTypeOptions`; the row pill menu and the edit form escaped it only by building at click/open time. A menu showing one asset's current type keeps that value as an option when the registry no longer carries it, `assetTypeOptionsHTML`'s rule, so opening it can't silently retype the row), `automations-wizard.js`, `appmap-rules-wizard.js`, `assets-maintenance.js`, `server-settings.js` (tag criteria).

**Invariants:**
- Built-in rows (`isBuiltIn` + `isProtected`) can't be renamed, relabelled, re-described or deleted; reserved built-in names are preserved across operator edits. **`isProtected` guards IDENTITY only** — since the match-rules cutover `updateAssetType` scopes its 403 to a name/label/description change and lets `matchRules` / `matchContexts` / `matchPriority` through on every row, because code branches on the literal names but nothing branches on how a device got into a bucket.
- Custom rename is atomic: every `Asset.assetType` rewrite happens in the same transaction as the registry row update (Asset.assetType is a String, not a relation).
- Delete refuses with 409 when any Asset references the type; cache refreshed on every write and at boot.
- **`refreshCache()` installs BOTH caches in one call** — `setAssetTypeRegistry` (for `isKnownAssetType`) and `setAssetTypeMatchRegistry` (for the resolver). They must never be separately warm: a rule edit that reached the DB but not the resolver leaves discovery typing devices by the previous rules with nothing on any surface saying so.
- **The match cache distinguishes never-loaded from loaded-and-empty.** An operator clearing every rule is a real answer and is honoured; a `null` cache means this process has not asked yet and falls back to `DEFAULT_TYPE_MATCHING`. This is load-bearing in the split-role layout: `seedAssetTypes` runs only where `runsMigrations` is true (web / all), so the DISCOVERY process — the one that types devices — reaches the resolver cold, and answering "nothing matches" there would file a whole run under Other. `startBackgroundJobs` warms it on every role and `runDiscovery` re-reads it per run (the `refreshProjectionPriority` pattern, same process split, same reason).
- **Preview and apply are bounded to assets typed `other`**, which is the same guard the discovery engine has always applied before re-typing an existing asset — so preview, apply and discovery cannot disagree about what is eligible, and a type an authoritative source or an operator set is never overwritten. Apply is one `updateMany` per TARGET TYPE in one transaction (bounded by registry size, ~10-15, not by the fleet) and re-asserts `assetType: "other"` in each WHERE, so a discovery run landing between the read and the write is a no-op rather than a clobber.
- **A draft preview substitutes into the live registry, never evaluates alone** — a clause only matters relative to the types that outrank it, so a draft judged in isolation over-reports every device a higher-priority type would have claimed first.
- **`toRow` is the ONLY place the stored rule shape is decided.** Every read goes out through it, so `normalizeMatchRules` folds the pre-2026-09 flat `{clauses}` list — leaf `op`, `starts_with`/`ends_with`, `negate: true` — forward to the current tree, and nothing downstream (route, preview, resolver, editor) knows a legacy row from a current one. There is no migration and there deliberately isn't one: the fold is total and lossless, so a rewrite would buy nothing an operator could observe, and a row keeps its old shape until the next save from the editor. Two consequences to keep: `validateMatchRules` must keep ACCEPTING the legacy shape (read-side normalization gates on it, so refusing it would blank every seeded built-in's rules on read), and the write paths take `MatchRulesInput` — the union — rather than `MatchRules`.
- **`previewMatchRules` / `applyMatchRules` supply facts through one helper (`factsOf`)**, including `osVersion`, so a rule on any OFFERED field is previewed against the same input the resolver gets. `chassis` is the one match field with no Asset column (it exists only on an Entra/Intune record mid-sync), so a rule using it previews as no-match — which is honest, not a gap to paper over.

**When changing this:**
- Built-in type names are hardcoded in branch logic elsewhere (dependency tree, topology, polling defaults) — don't rename them.
- **The shipped matching lives in TWO places that cannot share source, and since 2026-09 not even a SHAPE.** Migration `20260901010000_asset_type_match_rules` is where EXISTING installs get their rules and it wrote the flat `{clauses}` list; `DEFAULT_TYPE_MATCHING` (`src/utils/assetTypeMatch.ts`) is what `seedBuiltInAssetTypes` stamps on a row it has to CREATE from scratch (a `prisma migrate reset`, a nuked volume) and what the resolver falls back to on a cold cache, and it now spells the OR tree the fold produces. One is SQL, so they are transcriptions of each other through `normalizeMatchRules`. `tests/unit/assetTypeMatch.test.ts` pins the BEHAVIOUR both must produce rather than the text: it reimplements the two retired predicates (`inferAssetTypeFromOs`, `assetTypeForHit`) as oracles and holds the resolver against them over a corpus. If you change one, change the other and check that test still passes — a drift here re-types a fleet on its next discovery run with nothing in the UI explaining why.
- **The self-heal seed only stamps matching on rows it creates.** An existing row's rules are the operator's even when they are EMPTY — re-asserting a default over a deliberately cleared rule set is how a boot job silently undoes a configuration change.
- **The editor is the shared condition builder now, so a change to the tree grammar is a THREE-way lockstep**: `utils/assetTypeMatch.ts` (shape + validation + evaluation + `matchConditionMeta`), the recursive Zod union in `api/routes/assetTypes.ts`, and the `_dt*` half of `public/js/server-settings.js` (which mirrors the read-side fold in `_dtRulesTree` and the prune in `_dtPruneTree` so a legacy row opens with its rule intact and the previewed draft equals the stored row). What must stay shared with the device filter is the group operators, the leaf key (`operator`, never `op`), the six overlapping operator NAMES and their LABELS, and the depth cap; what must stay divergent is documented in polaris-ui-canon → Nested condition tree. `tests/unit/assetTypeMatch.test.ts` pins the label + group-operator parity against `scopeConditionMeta`, and `tests/unit/deviceTypesCardDom.test.ts` pins the editor's half.
- **Adding a built-in type is a SIX-way lockstep, and the dashboard widgets are the half that gets forgotten.** The backend three are the migration, `BUILT_IN_ASSET_TYPES` (`src/utils/assetTypes.ts`) and the `BUILT_IN_SEEDS` entry (`seedBuiltInAssetTypes` skips any seed whose name isn't in the built-in list, so two of the three is a silent no-op). The frontend three all live in `public/js/widgets/`: `BUILTIN_ASSET_TYPES`, `ASSET_TYPE_LABELS` and `ASSET_TYPE_COLORS` in `index.js`. **The widget maps are the SEED, not the whole vocabulary, since 2026-09** — the gear's asset-type grid and the Assets-by-type hide list paint the built-in maps synchronously and then repaint from `PolarisWidgets.getAssetTypeOptions()`, which rides the one memoized `/dashboard/filter-options` fetch (built-ins + every custom type the registry carries, registry-labelled — present-in-the-fleet until 2026-09, which left a just-created type with no checkbox). So a name missing from the static maps is no longer invisible — it is unordered, uncoloured, and absent until that fetch lands (and absent for good on a page with no API client). `ASSET_TYPE_COLORS` has no registry source at all: an unknown type gets a name-derived hue. `tests/unit/widgetAssetTypes.test.ts` asserts the parity and names the missing type when it breaks; it is the cheapest way to find out you only did three of the six.
- **The filter names what to HIDE, and that is what made custom types filterable.** `?hideAssetTypes=` carries the grid's switched-off names (stored as `config.assetTypesOff`) and `resolveFilteredAssetIds` (`nocDashboardService.ts`) excludes exactly those. The older `?assetTypes=` — the ENABLED built-ins, from which the hidden set is derived as (built-ins − enabled) — is still accepted and UNIONED with it, because stored configs and cached bundles still send it. That derivation is why an operator-added type could not be filtered at all before 2026-09: a custom name was never in the built-in list, so it was never in `hidden`, so it showed through every widget. It is also why a name the widget's list has but the SERVER's lacks would be silently excluded instead — `nocDashboardService` imports `BUILT_IN_ASSET_TYPES` rather than re-listing it precisely because its own private copy is what fell behind (`hypervisor` and `kubernetes_cluster` were unfilterable from the day each was added until 2026-08).
- **Stored widget configs are the migration hazard.** The filter is persisted as the enabled list, so a config saved before a new built-in existed simply doesn't name it — shape-identical to an operator having switched it off. `effectiveAssetTypes` in `widgets/index.js` resolves that in favour of showing data: a stored list carrying all eight LEGACY types is read as "everything was on when this was saved" and widens to every current built-in, which makes the all-on test suppress the query param entirely. Without it, adding a built-in flips every already-all-on widget from unfiltered (8 of 8) to a strict subset (8 of 10) and the server starts hiding the new types. If you add a built-in, leave `LEGACY_ASSET_TYPES` alone — it is a historical marker, not a mirror of the current list. A config the grid has saved since 2026-09 carries `assetTypesOff` as well, and `hiddenAssetTypes(config)` folds both shapes into the one hidden set: the off-list needs no widening (a type nobody switched off is not in it), which is what retires the widening rule's known limit — unchecking ONLY the newer built-ins used to store an all-eight-legacy enabled list that read as all-on and widened straight back.
- Anything that renders a type NAME should tolerate one it doesn't know: `PolarisWidgets.assetTypeLabel(t)` is the one place that decides (static map → registry label once fetched → humanized snake_case), used by the Down Assets / Down Interfaces rows and CSV exports, which printed `network_camera` verbatim until 2026-09. The Assets-by-type widget iterates its rows and adds a name-derived hue, because it used to map over the label map's keys and drop unknown types from the drawing while still counting them in the total (a pie missing a wedge, with every other percentage reading low).

---

## services/assetQuarantineService.ts

**What it owns:** Push/pull FortiGate MAC quarantine via persistent `user.quarantine.targets` CMDB tree; orchestrates multi-FortiGate best-effort with per-device all-or-nothing atomicity.

**Public API:** `quarantineAsset(), releaseQuarantine(), verifyAssetQuarantine(), getQuarantinePushAvailability(), buildTransportForIntegration(), pushQuarantineToFortigate(), unpushQuarantineFromFortigate(), normalizeMac(), quarantineTargetName()`

**Cross-service deps:** `assetSightingService.ts` (for candidate targeting).

**Used by:** `src/api/routes/assets.ts — quarantine/release/verify endpoints + GET /assets/quarantine-availability`, `src/services/discovery/discoveryEngine.ts — auto-quarantine post-discovery on new FortiGate sighting`

**Availability probe readers (the UI gate):** `public/js/assets.js` (`_quarantinePushAvailable()` — row menu, bulk-bar Quarantine button, asset-details tab visibility), `public/js/mobile/asset-detail.js` (`quarantinePushAvailable()` — hero button), `public/js/api.js` (`api.assets.quarantineAvailability`)

**Invariants:**
- Infrastructure assets (firewall/switch/access_point) rejected at `quarantineAsset()` entry; release does NOT enforce type guard (operator can orphan old entries).
- Per-FortiGate is all-or-nothing (partial failures roll back); across-FortiGate is best-effort (failed targets recorded as `status: "failed"` in `quarantineTargets[]`).
- MAC reconcile is a single multiplexed call, not per-MAC loops: a new target is created with all MACs in one POST; an existing target is reconciled with one `PUT` of the full desired `macs` array (FortiOS CMDB replaces the child table → adds + removes atomically), guarded by a `needsReconcile` diff so a matching set is a no-op. Per FMG API Best Practices Guide (multiplex into one request). `callFortiOs` carries the PUT body on both transports, so FMG↔FortiGate parity holds. Read-back verification still follows the write.
- `statusBeforeQuarantine` preserved on quarantine → release restores it (null → "active" fallback), and `monitoredBeforeQuarantine` does the same for `Asset.monitored` (null → not-monitored). **Both restore in ONE write**, because "quarantined" is one of the four statuses that cannot carry monitoring (business rule 10): the quarantine write trips the db.ts clamp and turns polling off, so without the park a release would hand the device back to the network unwatched — and staging monitored in a SEPARATE write from the status would have the clamp judge it against "quarantined" and refuse.
- Standalone FortiGate + FMG (proxy/direct) both supported via `buildTransportForIntegration()` parity.
- **There is ONE write mechanism: `PUT /api/v2/cmdb/user/quarantine` carrying the whole `targets` array.** `user.quarantine` is a COMPLEX (single) object with `targets` as a child table, so that child table has no collection resource: `POST /api/v2/cmdb/user/quarantine/targets` answers **405**, and `DELETE /targets/<entry>` is equally unreal — which is why create, release AND rollback were all broken by the same fact and none could be fixed alone. FortiOS exposes POST/DELETE on a child table only when the parent is itself a table and the URL carries the parent mkey (`/firewall/policy/1/srcaddr`). A partial PUT naming only `targets` leaves `quarantine` / `traffic-policy` / `firewall-groups` untouched.
- **That table is shared, so the write is read-modify-write with three guards.** The gate's own Quarantine Host action, NAC policies and automation stitches write entries there, and a full-array PUT deletes whatever it omits. So: foreign entries pass through VERBATIM minus device-owned readonly fields (`parent`, `q_origin_key` — FortiOS refuses them on write); the read-back verifies every foreign entry SURVIVED, not just that ours landed; and rollback restores the exact array that was read rather than deleting our entry, so a failure can never leave the table shorter than it started. **Known limitation:** no ETag/CAS exists on FortiOS CMDB, so a lost-update window remains — `withQuarantineLane` serializes per gate within a process, but split-role means a web-role push and a discovery-role auto-quarantine can still interleave; the foreign-entry check turns silent entry loss into a failed push with the table restored.
- **A push into a disabled feature is refused, not written.** The object's own `quarantine` flag (schema default `enable`) gates the push: an entry written while it is `disable` would leave the asset reading `quarantined` while the gate forwarded its traffic. An ABSENT flag reads as enabled — refusing because an older build does not publish it would be the wrong way to be careful.
- **The write matches the table's own schema, and the schema is the authority — `GET /api/v2/cmdb/user/quarantine/targets?action=schema` on any gate.** Four facts it settles, every one of which was wrong in the shipped code and silent when wrong: (1) the mkey is **`entry`**, not `name` — the create POST carried `name`, so it went up with no mkey and FortiOS answered **500**, on every install and both transports, from the day the service shipped; the local interface had modelled `entry` all along and no writer used it. (2) `macs[].drop` defaults to **`disable`**, glossed by the schema as "Sends quarantined device traffic to FortiGate" — so an omitted `drop` lists the MAC and blocks nothing: a containment action that reads as success. Polaris sets `drop: "enable"` explicitly on every MAC. (3) Both `description` fields are size **63**; the cap was 64. (4) `access_group` is **`wifi`** (WiFi & Switch Controller), NOT the User & Device the tree's name suggests — which is what the Quarantine Push tab's access-profile copy now states. Do not add a field to either body without reading the schema first; `tests/unit/quarantineRequestShape.test.ts` captures the JSON through a fake Transport and pins all of it.
- **Every string this service writes into a CMDB field is printable ASCII** (`asciiForDevice`). The target description carried an em dash (U+2014) from the day the service shipped and the per-MAC description takes the asset hostname as typed, so a push could put non-ASCII bytes into a device config string. The cost of a refused write is asymmetric: `pushQuarantineToFortigate` rolls a newly created target back and the asset never reaches `quarantined`, so a containment action fails on a decoration. Sanitize BEFORE the 64-char cap (the cap must count what is actually sent), and give every caller a fallback — a hostname made entirely of non-ASCII sanitizes to "". Description SYNC is deliberately not sanitized: there the text is the operator's intent, not our phrasing.
- `quarantineTargets` JSON tracks per-target status: `"synced"` (verified), `"drift"` (missing on later verify), `"failed"` (push error); only `"synced"` eligible for drift-flip on verify.
- Token-scoped quarantine (bearer token) filters sightings by integration before push; release refuses outright if quarantine touches out-of-scope integrations (no partial release).
- **Push is per-integration and OFF by default** (`config.pushQuarantine`, the Quarantine Push tab on both Fortinet integration types), and `quarantineAsset()` silently SKIPS every sighting whose integration has it off. With it off fleet-wide the run lands on zero targets and throws `502 … 0/0 FortiGate(s) accepted the push` — a device-shaped error for a feature that was never enabled. `getQuarantinePushAvailability()` is the frontends' pre-check so the verb is withheld instead: install-wide (never per-asset — the row menu asks per row over a 2000-asset table), so on a mixed install it is the OPTIMISTIC answer and the push stays the authority.
- **Release is never gated on that toggle**, and no UI surface may gate it: `releaseQuarantine()` unpushes from the targets recorded on the ASSET without consulting the integration config, so a device quarantined before an operator switched push off must stay releasable (the desktop tab likewise stays visible for an already-quarantined asset so Release + the recorded targets are reachable). The availability gate is also FAIL-OPEN — an unanswered or failed probe reads as available, since hiding a containment verb on a transient error is worse than surfacing the push's own error.

**When changing this:**
- Audit `fortigateService.ts` + `fortimanagerService.ts` transport compatibility if FortiOS version bumps or endpoint changes.
- Changing either write path: `pushQuarantineToFortigate` and `unpushQuarantineFromFortigate` share `readQuarantineObject` / `writeQuarantineTargets` / `withQuarantineLane` and must stay on them — a new caller that reaches for POST or a child-path DELETE is writing to a resource that does not exist, and will only find out on a device. `tests/unit/quarantineRequestShape.test.ts` fakes the gate at the `callFortiOs` seam and echoes writes back, so the foreign-entry guard, the rollback and the idempotent no-op are exercised rather than asserted.
- Diagnosing a refused push: the per-target `error` on `Asset.quarantineTargets[]` and the `asset.quarantine.failed` Event's `details.targets` carry the transport's message, which since 2026-08-31 includes FortiOS's own `cli_error` + numeric CLI code (`fgErrorDetail` in fortigateService — the direct path used to discard the response body on a non-2xx while the FMG-proxy path always relayed it, so "FortiGate returned HTTP 500" was the whole story). A 404 from the target GET is SWALLOWED as "not present", so an install whose FortiOS does not expose `user/quarantine/targets` surfaces on the POST, not the read.
- Check infrastructure-asset type list (firewall/switch/access_point) against the `BUILT_IN_ASSET_TYPES` constant in `src/utils/assetTypes.ts` + discovery source-kind tagging. (Custom operator-added AssetTypeDef rows DO NOT receive infrastructure special-casing — they fall through to "other"-like generic behavior.)
- Verify `getSightingSettings()` Settings key and max-age filter alignment with caller expectations.
- Adding another surface that STARTS a quarantine: gate it on `canQuarantineAssets()` (the `assetsQuarantine` key, seeded `write` for the built-in `assetsadmin` and `fullwrite` for `admin`) AND on the availability probe; `tests/unit/assetQuarantineGates.test.ts` + `tests/unit/assetRowMenu.test.ts` pin both, including that Release stays ungated.
- Review rollback/error-logging in event payload (event action names: asset.quarantine.succeeded/partial/failed/released/unpush.failed).

---

## services/assetSourcePriorityService.ts

**What it owns:** The operator-settable priority behind the assets table's **Sources** column — which discovery source's "where was this learned?" answer wins when an asset is known to several at once. One Setting row (`assetSourcePriority`, `{order[], integrationPrefix}`) over `createSettingStore` with a 30s TTL. The catalogue of who can contribute what is the pure `utils/assetSourceLocation.ts`; this service owns persistence, validation, audit, and installing the order into the projection.

**Public API:** `getSourceLocationPriority()`, `getSourcePrioritySettings()`, `saveSourceLocationPriority(input, actor)`, `refreshProjectionPriority()`, `invalidateSourcePriorityCache()`, `ASSET_SOURCE_PRIORITY_KEY`

**Cross-service deps:** `settingsStore.createSettingStore`, `eventLogService.logEvent`, `utils/assetSourceLocation` (catalogue + normalizer), `utils/assetProjection.setLearnedLocationPriority` (the install seam).

**Used by:** `src/api/routes/assets.ts — GET/PUT /assets/source-priority`, `src/services/discovery/discoveryEngine.ts — refreshProjectionPriority() at the top of runDiscovery`, `src/app.ts — refreshProjectionPriority() once per process in startBackgroundJobs`, and client-side by two browser files — the Assets → Settings → Sources drag list (`public/js/assets.js`, read + write) and the **merge modal** (`public/js/asset-merge-modal.js`, read only), which defaults each differing field's winner radio to the side whose best-ranked discovery source sits higher in the order.

**Invariants:**
- The order feeds `Asset.learnedLocation` through the projection, **not just rendering**. The Sources column, its text filter, its sort, "behind FortiGate X" tag/maintenance criteria and the Device Map's per-site narrowing all read `learnedLocation` — deciding the winner at render time would make the column disagree with everything that filters on it. Never "fix" this by moving the resolution into the list enrichment.
- **Propagation is pull-based, and must stay that way.** The projection runs inside the DISCOVERY process in the split-role layout, so a web-role write can't push it. `refreshProjectionPriority()` at boot (every role) + at the start of every `runDiscovery` is the whole mechanism; the per-run refresh is also the moment learnedLocation is next written, so nothing is observably stale. Adding a new projection caller in another process means adding a refresh there too.
- Reordering is **not retroactive** — existing rows re-project on their integration's next discovery run. The UI says so; don't promise otherwise.
- The READ path self-heals (`normalizeSourceLocationPriority` drops unknown kinds, collapses duplicates, appends missing kinds in default order) while the WRITE path REJECTS unknown/duplicate kinds with a 400. Asymmetric on purpose: a stored row must survive a catalogue change, a client posting a typo must hear about it.
- `refreshProjectionPriority()` never throws — a DB hiccup leaves the DEFAULT order in force (pre-feature behavior) rather than failing a discovery run.
- **A source blob may never hold the projection's own OUTPUT.** `fortigate-endpoint`'s observed blob is stamped from `Asset.learnedLocation` — which the projection wrote — so with `integrationPrefix` on, the render fed straight back into its own input and every discovery cycle prefixed it again (prod, 2026-08: a laptop reached 32 `FMG1:` segments before anyone noticed; with the toggle off the projection is idempotent, which is why it hid). The loop is now cut at the source rather than sanitized on the way through: `buildFortigateEndpointObservedBlob` takes the gate name as a PARAMETER, supplied per asset by the touch site that saw it (`fortigateEndpointDeviceByAsset` — DHCP `entry.device` / inventory `inv.device` / switch-MAC + ARP `row.fortigateDevice`), and `backfillFortigateEndpointSources` reads `AssetFortigateSighting`; neither reads the Asset row. Cutting it also fixed the quieter half of the same laundering, which the prefix strip could never have caught: `Asset.learnedLocation` on a domain-joined laptop holds AD's OU path, so the blob had this source claiming the FortiGate said `OU=Computer Workstation2`, and an install ranking `fortigate-endpoint` first read exactly that in the column (prod, 2026-08). `contributedLocation` still bares any `fortinetDevice` value before prefixing (`bareFortinetDeviceName` — a FortiGate/FMG name can't contain a colon, so anything before the last one is rendering). Keep the read-side strip even though the write side is fixed: it heals rows already polluted, and it's what stops the next writer that stamps a rendered location from restarting the growth.
- The default order is **closest-to-a-place first**: sighting FortiGate > label-only cloud sources (arc / intune / entra / arc-k8s) > vCenter cluster > AD's OU path > fortiswitch / fortiap. It is NOT the pre-feature `LEARNED_LOCATION_RULES` order any more (that led with AD, on the accident that an OU path is usually named after a building). `tests/unit/assetSourceLocation.test.ts` pins the list verbatim — changing it silently re-labels every asset in every install that never saved its own order, on that install's next discovery run.
- **A Fortinet infra source suppresses the `fortigate-endpoint` location rule**, at any operator order (`LOCATION_SUPPRESSING_INFRA_SOURCES` in `assetProjection.ts`: fortigate-firewall / fortiswitch / fortiap). A managed device's site label is its own identity or its controller; the gate that sighted it as a DHCP client BEFORE adoption is not its location, and that endpoint row outlives the adoption. This held by accident while the default order put fortiswitch/fortiap above fortigate-endpoint — it is explicit now that the sighting gate leads.

**When changing this:**
- **The order has a second consumer that is not the location column**: the merge modal ranks each asset's sources by it to pre-select the per-field winners (see the `assetMergeService` entry). So reordering the list now changes what a merge DEFAULTS to as well as what the Sources column reads, and a kind absent from the catalogue ranks below every listed one on both surfaces — `manual`, `polaris-agent`, `snmp-sysdescr` and `fortigate-firewall` are deliberately not promoted to the top of a merge just because no one placed them.
- Adding a source kind: add it to `LOCATION_CONTRIBUTORS` in `utils/assetSourceLocation.ts` (declaration order IS `DEFAULT_LOCATION_ORDER`; put a new kind at the END unless you mean to change the default for every install, since the normalizer appends unmentioned kinds to stored orders in that same order) and to the `learnedLocation` row of the skill references' (formerly ARCHITECTURE.md's) projection priority table. No client change needed; the settings list is server-driven.
- Adding a **field**-mode contributor: confirm the observed key is actually written by the discovery path that mints the source row. A contributor whose key never appears is a silent no-op.
- Touching the `integrationPrefix` rendering: it reads `observed.integrationName`, stamped by `buildFortigateEndpointObservedBlob` + `upsertFortinetInfraAssetSource` in `discoveryEngine.ts`. Rows written before that stamp fall back to the bare device name — keep that fallback or pre-upgrade assets render a dangling `:name`. Whatever you change, `contributedLocation` must stay IDEMPOTENT under its own output (see the feedback-loop invariant above); the test file pins that directly.
- Any change to what a source contributes is a change to `Asset.learnedLocation`: re-check the "behind FortiGate" matchers in `tagAssignmentService` / maintenance criteria (`utils/integrationFilter.ts` reads AD's `ouPath` off learnedLocation as a fallback) and `dashboard.ts`'s per-site narrowing.

---

## services/assetSightingService.ts

**What it owns:** Records DHCP-only (asset, FortiGate) sightings to drive quarantine fan-out targeting.

**Public API:** `recordSightings(), computeFreshestGateChanges(), getSightingsForAsset(), getQuarantineCandidates(), getSightingSettings(), updateSightingSettings()`

**Cross-service deps:** `eventLogService` (`buildFirewallChangedEvent` + `logEventsBatch` — the `asset.gateway_firewall.changed` audit row), `utils/assetSourceLocation.bareFortinetDeviceName` (device-name normalization).

**Used by:** `src/services/discovery/discoveryEngine.ts — batch-record sightings after DHCP discovery sync`, `src/api/routes/assets.ts — fetch sighting list for Quarantine tab`, `src/services/assetQuarantineService.ts — fan-out targeting within quarantineAsset()`

**Invariants:**
- Sightings are deduped by `(assetId, fortigateDevice)` pair; `seenAt` determines entry precedence, `dhcp_reservation` trumps `dhcp_lease` on tie.
- `getQuarantineCandidates()` filters by `sightingMaxAgeDays` Setting (default 180; 0 = no filter); stored rows never auto-prune.
- Only DHCP evidence qualifies (transit via System tab interface scrape intentionally excluded per design).
- Every caller of `recordSightings()` must dedupe + normalize before passing; batch upsert handles dedup again for safety.
- **Gateway-change audit** (`computeFreshestGateChanges`, pure + unit-tested): "freshest" is max `lastSeen` across the asset's rows — the SAME rule `syncEndpointDependencyEdges` uses to pick an endpoint's parent gate, so the event tracks the value that drives dependency suppression. A gate move INSERTS a row (the unique key includes `fortigateDevice`) and nothing prunes the old one, which is why the question is "which row is freshest" rather than "which exists". Three deliberate silences: no prior rows = first sighting, not a move; device names compare through `bareFortinetDeviceName` + case-fold; and the **takeover guard** — nothing is reported while the incumbent gate is ALSO refreshed in the same batch, because a device holding live leases on two gates has both rows stamped to ~now every run and would otherwise tie-flip an event every cycle forever. Cost of the guard: a real move reports once the old gate stops handing out the address, up to the old lease's life later.
- `SightingInput.assetHostname` is supplied by the CALLER (which already holds the asset row) purely to name the audit event — this service must never query assets to label them.
- Detection is wrapped in its own try/catch on both halves (pre-read and emit): `recordSightings` never throws, and an audit failure must not change that.

**When changing this:**
- Check `assetQuarantineService.ts` `quarantineAsset()` for sighting-filter logic (max-age, integration scoping).
- Verify `discoveryEngine.ts` `syncDhcpSubnets()` call site still matches expected SightingInput shape.
- Review Settings UI (assets.html) sighting age control and max-age tooltip.
- Ensure `pruneOldHistory` job (if added) respects Setting-backed retention separately from max-age filter.

---

## services/duplicateSerialConflictService.ts

**What it owns:** Both serial Conflict flavours end to end (business rule 83) — `serial-two-controllers` (one managed device on the roster of two controller FortiGates) and `duplicate-serial` (one serial on two Asset rows) — plus the write path that makes the first one detectable at all (`recordControllerClaims`, the `AssetControllerClaim` rows discovery re-asserts per pass). Sibling of `duplicateIpConflictService` (same sweep shape, same raise/refresh/auto-close lifecycle, same dedup-on-dismissal convention); it lives here rather than with the IPAM services because its subject is asset identity, not address space.

**Public API:** pure — `isUsableSerial(raw)`, `controllerKeyFor(claim)`, `claimFoldKey(claim, ctx)`, `groupContestedSerials(claims, cutoff, ctx?)`, `claimantSetKey(claimants)`, `groupDuplicateSerialAssets(rows)`, `memberSetKey(members)`, `pickPrimaryMemberId(members)`, `resolveMergeTargets(members, survivorId, rawAbsorbIds)`, `freshnessCutoff(now?)`, `conflictSerialOf(conflict)`, `conflictClaimantsOf(conflict)`, `conflictMembersOf(conflict)`, `serialClaimRejectMessage(conflict)`, `duplicateSerialRejectMessage(conflict)`; DB — `recordControllerClaims(inputs)`, `pruneStaleControllerClaims(now?)`, `loadFreshControllerClaims(cutoff)`, `loadControllerContext(claims)`, `loadDuplicateSerialAssets()`, `reconcileSerialConflicts(now?)` (the job's entry point), `mergeDuplicateSerialAssets(conflict, survivorAssetId, absorbIds, actor)`, `logSerialClaimDismissal(conflict, actor)`, `logDuplicateSerialDismissal(conflict, actor)`, `logScanFailure(err)`. Constants `SERIAL_CLAIM_COLLISION_REASON`, `DUPLICATE_SERIAL_COLLISION_REASON`, `CLAIM_FRESH_DAYS`, `CLAIM_PRUNE_DAYS`, `CLAIM_EXCLUDED_STATUSES`, `MAX_PLAUSIBLE_DUPLICATES`, `EMPTY_CONTROLLER_CONTEXT`.

**Cross-service deps:** `prisma`, `logEvent` (eventLogService), `mergeAssets` (assetMergeService — the merge verb delegates rather than re-implementing an absorb), `utils/fortinetParentKey` (`buildInfraParentIndex` / `resolveInfraParentAsset` / `normalizeSerialKey` / `normalizeNameKey` — controller resolution goes through the shared resolver, never a hostname compare).

**Used by:** `src/jobs/detectSerialConflicts.ts` (30-min sweep, scheduler role), `src/services/discovery/discoveryEngine.ts` (`syncDhcpSubnets` — the FortiSwitch and FortiAP loops collect claims through a local `noteControllerClaim` and flush once with `recordControllerClaims` before Phase 4), `src/api/routes/conflicts.ts` (the duplicate-serial branch of `POST /:id/merge`), `src/services/conflictResolutionService.ts` (imports both reason constants + both dismissal loggers for the accept-refusal and reject branches). Frontend readers: `renderSerialClaimConflictCard` / `renderDuplicateSerialConflictCard` in `public/js/events.js` and the reason labels in `public/js/widgets/conflictQueue.js`.

**Invariants:**
- ONE pending conflict per SERIAL per flavour, never per pair; extra pending rows on one serial are auto-closed as stranded (the duplicate-IP convention).
- `AssetControllerClaim` is evidence, never a projection input — `projectAssetFromSources` does not read it and no claim decides which controller wins. Discovery's last-writer-wins stamp is deliberately untouched (rule 83's report-only scope).
- Claims are written ONCE PER PASS in batched `$transaction` chunks of 200, not per device — the switch/AP loops already carry several awaits per device and 2000 managed devices must not add 2000 more.
- Recording a claim is best-effort: `recordControllerClaims` swallows and logs a chunk failure, and the discovery call site wraps it again. A run that reports inventory must never fail because a report's evidence could not be stored.
- A claim counts only while fresh (`CLAIM_FRESH_DAYS` = 2). That is what auto-closes a completed device move, and it is SHORTER than duplicate-IP's 7 on purpose — a controller claim is re-asserted by every discovery pass, an address claim is not.
- **HA folds to one claimant**: claimants are grouped by the firewall ASSET they resolve to (`claimFoldKey`), because every cluster member serial maps to one asset through its own `fortigate-firewall` AssetSource row. The same fold absorbs a gate re-registered under a second FMG device entry. Resolution order is `loadControllerContext`: the AssetSource serial map first, then `resolveInfraParentAsset` for name-keyed claims — never `Asset.hostname` matching (see `cross-cutting/fortinet-parent-key-resolution.md`).
- `controllerKey` is the upper-cased controller serial, else `name:<lower-cased device name>`. The prefix is load-bearing: without it a name could collide with a serial.
- Status filter is `CLAIM_EXCLUDED_STATUSES` (`decommissioned` / `disabled`) — deliberately NARROWER than duplicate-IP's `UNMONITORABLE_STATUSES`, because a `storage` or `quarantined` device still holds map placement and region tags and still changes owner. Do not "fix" this to match rule 40(a).
- A serial only counts when `isUsableSerial` accepts it (SMBIOS placeholders, < 4 chars, single repeated character), and a duplicate group larger than `MAX_PLAUSIBLE_DUPLICATES` (8) is treated as a vendor default rather than a device recorded nine times.
- Accept is REFUSED for both flavours (`acceptAssetConflict` throws 400). `serial-two-controllers` has NO resolution verb at all — the fix is on the gates; `duplicate-serial`'s verb is the merge.
- Re-raise suppression: a REJECTED row suppresses the same CLAIMANT set (contested) or the same MEMBER set (duplicate); a changed set raises anew.
- Auto-close convention matches the sibling sweeps: `status="rejected"`, `resolvedBy="system:auto-resolved"`.
- `mergeDuplicateSerialAssets` re-points `Conflict.assetId` at the survivor BEFORE the first merge — deleting an absorbed asset cascades to conflicts pointing at it — takes NO field winners, and delegates to `mergeAssets`.
- Reconcile is idempotent: a fleet with no serial trouble issues zero writes beyond the claim prune.

**When changing this:**
- The `proposedAssetFields` shapes are read by both card renderers in `events.js`, the `conflictQueue` widget subtitles and `resolveMergeTargets` — change them together.
- The duplicate-serial card reuses the duplicate-IP merge WIRING in `events.js` (`[data-dupip-merge], [data-dupserial-merge]` in one `querySelectorAll`, wording switched off the attribute). A new action needs both the renderer and that block.
- Merge stays `assets:fullwrite` on every path, matching rule 40's level and `POST /assets/:id/merge`.
- Adding a `sourceKind` to the claim write (a third managed-device kind) means adding it to the discovery call sites AND to the card's kind label.
- Both flavours stamp `conflict.detected`; the baseline "IP conflict detected" automation subscribes to that action string, so its seeded description names them. A new action string would silently un-alert the feature.
- The duplicate-serial scan's SQL names raw columns (`assets`); a rename in `prisma/schema.prisma` needs a matching edit here. Reads only — never add writes to it (it bypasses the `db.ts` extensions).
- `CLAIM_FRESH_DAYS` is the auto-close clock. Lengthening it keeps finished moves on the queue; shortening it below a slow install's discovery interval closes real conflicts between passes.

---

## services/assetUpstreamService.ts

**What it owns:** `resolveAssetUpstream(assetId, {includeFirewall, includeSubnetGate})` — turning the three UPSTREAM device NAMES the asset-details General tab renders (Last Seen Switch / AP / Firewall) into the Asset rows behind them, so those rows can carry verbs (open the device, open its HTTPS UI, SSH to it) instead of being text an operator re-finds by hand in the Assets list. Since 2026-09 it also answers the firewall row for a device NO gate has ever sighted, from IPAM (business rule 55).

**Public API:** `resolveAssetUpstream`, the pure `splitLastSeenSwitch`, and the `AssetUpstream` / `UpstreamEntry` / `UpstreamAssetRef` types.

**Cross-service deps:** `utils/fortinetParentKey.ts` (`parentAssetWhereOr` + `buildInfraParentIndex` + `resolveInfraParentAsset` — the shared precedence, never a bare hostname match), `fortinetManagementAccessService.shapeManagementAccessForClient` (the four fields the client's remote-access gate reads), `ipUpstreamChainService.resolveOwningGateContexts` (the IPAM fallback — the same resolver the rule 45 sweep and the endpoint dependency tier use). Reads `Asset` + `AssetFortigateSighting` + (via that resolver) `Subnet` directly; writes nothing.

**Used by:** `src/api/routes/assets.ts — GET /api/v1/assets/:id/upstream` (gated `assets:read`, `includeFirewall` from `hasPermission(req, "assetsQuarantine", "read")`, `includeSubnetGate` from `hasPermission(req, "subnets", "read")` — two DIFFERENT grants, because the two answers come from two tables). Total 1 call site today; `public/js/assets.js → _mountAssetViewAsyncSections` is the only consumer.

**Invariants:**
- **The displayed NAME never changes.** The firewall half reports the FRESHEST sighting's `fortigateDevice` and resolves exactly that one — it deliberately does NOT walk down the list for the first name that resolves (right for `resolveEndpointParent`, whose job is to find *a* parent; wrong here, where the value is already on screen and the row must keep naming the gate that last saw the device).
- **Unresolved is a state, not an error** — `{name, asset: null}`. An unadopted switch, a gate another integration hasn't discovered yet and a decommissioned AP all land there legitimately, and the UI keeps rendering the name as plain text.
- **Resolution rides `fortinetParentKey`, and it has to.** The sighting carries FortiManager's DEVICE NAME, which is under no obligation to match the gate's own hostname; hostname-only matching is the failure that silently unparented every switch on this install once.
- **Index per KIND, not one index over everything.** `buildInfraParentIndex` is first-writer-wins per key, so a switch sharing a gate's hostname would shadow it and the type guard would then reject the match.
- **Never resolves to the asset being viewed** (`id: { not: assetId }`) — a switch whose own `lastSeenSwitch` reflects itself must not link to its own page.
- **All three are null for an `assetType: "firewall"`** and no sighting query runs: a gate is the thing doing the sighting, and the General tab hides the rows for one.
- **One candidate query for all three names**, each branch type-scoped — never a query per name, and never `findFirst` with an OR (which gives no control over which match comes back).
- `visibility.firewall` says whether the sighting half was consulted, so a caller without `assetsQuarantine:read` reads "not shown" rather than a confident "no gate has ever seen this device" (the `/ip-context` precedent); `visibility.subnetGate` does the same for the IPAM fallback, which rides `subnets:read` instead.
- **The IPAM fallback is a FALLBACK, and is labelled** (business rule 55). It runs only when no sighting names a gate, and only for a non-firewall asset with an address. The entry carries `source: "subnet"` + the containing `subnetCidr` and deliberately NO `lastSeen` — an inference has no moment, and a row headed "Last Seen" must not print one for a device nothing has seen. A sighting-sourced entry now carries `source: "sighting"` explicitly rather than by omission.
- **The fallback yields nothing when the gate has no Asset row.** The row exists to carry verbs; with no row there is neither a verb nor a name worth printing (unlike the sighting half, which always has FMG's device name to show). It resolves by id in the SAME candidate query as the other branches, not a second round trip.
- **`ipContextService.pickNamedGate` ranks these two sources the OPPOSITE way** (subnet above sighting) and that is deliberate, not drift: that panel answers "what is at this address today", where the serving gate wins; this row answers "where was this last seen", where evidence wins. One shared resolver underneath so the gate-identification precedence cannot diverge.

**When changing this:**
- If `lastSeenSwitch`'s `"<switch>/<port>"` format ever shifts, update `splitLastSeenSwitch` here AND `switchNameFromLastSeenSwitch` in `dependencyTreeService.ts` / `parseLastSeenSwitch` in `connectionPathService.ts` — three parsers of one column.
- Adding a fourth upstream row means one more type-scoped branch in the same query, not a second round trip.
- The firewall row now has TWO sources. Anything that changes which one wins is a business rule 55 change — amend the rule, not just the code, and keep the `source` field on the wire: `public/js/assets.js → _upgradeUpstreamRow` renders the "(owns <cidr>)" suffix off it, and a row that silently loses the label reads as evidence it isn't.
- If the shape of `UpstreamAssetRef` grows, remember the browser gates verbs through `_assetMgmtAccess` — add the field there rather than branching on `assetType` in the row renderer.

**Tests:** `tests/integration/assetUpstream.test.ts` (resolution against a real DB: switch by serial, AP by hostname, firewall by FMG device name with a mismatched hostname; unresolved; self-link refusal; the firewall gate), `tests/integration/ipamOwningGateUpstream.test.ts` (the IPAM fallback: it answers when nothing sighted the device, a sighting outranks it, the `subnets:read` withholding, an unknown address, and a gate with no Asset row), `tests/unit/assetUpstream.test.ts` (the splitter), `tests/unit/assetUpstreamRowsDom.test.ts` (the rows + menus).

---

## services/assetVipService.ts

**What it owns:** `resolveAssetVips(assetId)` — the firewall VIPs and load-balance virtual servers that PUBLISH one asset, for the asset-details General tab's VIP rows: the external address the device answers on, and the gate the VIP is configured on. Before it, the external address of a published server was reachable only by finding its reservation in Networks and reading the VIP badge's tooltip.

**Public API:** `resolveAssetVips(assetId)`, the pure `parseVipInfo(raw)`, and the `AssetVips` / `AssetVipEntry` / `AssetVipRole` types.

**Cross-service deps:** `subnetService` (`buildIpContexts` — containment + the active reservation per address), `utils/fortinetParentKey` (`parentAssetWhereOr` + `buildInfraParentIndex` + `resolveInfraParentAsset`).

**Reads:** `Asset` (+ `AssetAssociatedIp` via `associatedIpRows`), `Subnet` (through `buildIpContexts`), `Reservation.vipInfo`.

**Writes:** nothing — no device I/O, no rows, no Events. Every fact is one discovery already stamped (`discoveryEngine` Phase 3c writes `Reservation.vipInfo` = `{ name, device, extip, role, isVirtualServer }` for the VIP's external IP, each mapped IP and each virtual-server realserver).

**Used by:**
- `src/api/routes/assets.ts → GET /api/v1/assets/:id/vips` — the only caller. Gated `assets:read` AND `reservations:read`, chained (the `/assets/:id/contacts` precedent: reading it exposes IPAM content).
- `public/js/assets.js → _mountAssetViewAsyncSections` + `assetVipRowsHTML` — the General-tab rows.

**Invariants:**
- **Containment goes through `buildIpContexts`, never a fresh `cidr >>= ip` query** — the same rule `ipContextService` states, for the same reason: a second implementation would let this row disagree with the View-Lease button about which reservation belongs to an address. The reservation IDS that helper returns are what the `vipInfo` read is keyed on, which is also what stops a same-address reservation in a subnet that does NOT contain the asset's address from contributing a row.
- **The gate NAME resolves through `utils/fortinetParentKey.ts`, never against `Asset.hostname`.** `vipInfo.device` is FortiManager's device name (discovery copies it straight off the VIP's owning device), so the hostname match is exactly the conflation that module exists to prevent.
- **Unresolved is a state, not an error** — `asset: null` with the name kept. A VIP on a gate Polaris holds no Asset row for is still worth naming, and the row renders the name as plain text.
- **The DISPLAYED gate name is the VIP config's spelling**, not the resolved asset's hostname (which rides the link's `title`) — the `assetUpstreamService` posture, and what an operator comparing the row against the FortiGate config needs.
- **ASSOCIATED addresses count, not just the primary one.** A multi-homed server can be a VIP target on one interface and a virtual-server pool member on another; each address contributes its own entry, and the entry names the address it was found on so the rows stay readable.
- **One reservation per (subnet, address) means ONE VIP per address** — a server published through several VIPs on one address shows the most recently discovered one, because that is all the schema records. Not a bug to work around here: fixing it means a VIP table, not a second lookup.
- **`parseVipInfo` rejects a stamp missing the VIP name or the gate name** (the two halves the row exists to answer) and tolerates a missing `extip`; an unrecognized `role` falls back to `"mapped"`, the reading that understates rather than asserting something about the device's exposure that nothing checked.
- **One query per stage, never per address or per gate** — the asset + its associated IPs, one containment join, one `vipInfo` read, one candidate query over every distinct gate name.

**When changing this:** a new `vipInfo` field means `parseVipInfo` AND the row renderer — the blob is written in three places in `discoveryEngine.ts` Phase 3c (create, VIP-rename refresh, DHCP-collision update) and all three must stamp it or the row shows it only for VIPs discovered since. If the VIP badge in `public/js/ip-panel.js` and this row ever disagree about what a stamp means, they are reading the same column and one of them is wrong. A caller that wants the gate's VERBS (Open HTTPS / SSH) needs `shapeManagementAccessForClient` on the ref, the way `assetUpstreamService` does it — the row deliberately carries only a link today.

**Tests:** `tests/integration/assetVips.test.ts` (against a real DB: the gate resolved by FMG device name with a mismatched hostname, an unresolved gate, associated addresses, a same-address reservation in a non-containing subnet, the `reservations:read` gate, 404), `tests/unit/assetVipService.test.ts` (`parseVipInfo`), `tests/unit/assetVipRowsDom.test.ts` (the rows).

---

## services/ipUpstreamChainService.ts

**What it owns:** The IP-keyed upstream chain (business rule 45): for an asset that has an address and NO MAC, derive `lastSeenSwitch` / `lastSeenAp` by walking IP → containing subnet's owning FortiGate → THAT gate's `AssetArpEntry` → MAC → `AssetMacTableEntry` (lowest-cardinality learned port) / `AssetWirelessStation` (by MAC, or by the station's own recorded address). Every other writer of those two columns is keyed by MAC, so an asset from AD / Azure Arc / a vCenter cluster / an active scan / the operator form could never acquire them — this service reads the current-state tables those writers leave behind and joins the chain. No device I/O.

**Public API:** `resolveIpUpstreamForMaclessAssets(now?)` → `IpUpstreamChainResult` counts; `resolveOwningGateContexts(ips)` → `Map<ip, OwningGate>` (the shared "which gate owns this address" resolver — three consumers, see below); the pure `claimIsFresh`, `pickArpMac`, `pickBestSwitchPort`, `switchPortLabel`, `portKey`, `stampChanged`, `macKey`, `partitionAdoptableMacs`; `loadMaclessClaims`; `EVIDENCE_FRESH_MS`, `ADOPTED_MAC_SOURCE`.

**Cross-service deps:** `subnetService.buildIpContexts` (containment — the single most-specific-subnet SQL), `utils/fortinetParentKey` (`buildInfraParentIndex` / `resolveInfraParentAsset` — the subnet's `fortigateSerial` first, its FMG device NAME second, never a hostname match), `duplicateIpConflictService.claimIsOperatorOwned` + `CLAIM_FRESH_DAYS` (rule 40's claim model, imported rather than re-stated), `eventLogService.buildConnectionChangedEvent` + `logEventsBatch`, `utils/dbRetry.retryOnDeadlock`, `utils/chunk.chunkArray`, `utils/assetInvariants.UNMONITORABLE_STATUSES`.

**Used by:** `src/jobs/resolveIpUpstreamChain.ts` (boot + 90s, then every 10 min; scheduler role). `resolveOwningGateContexts` additionally by `src/services/assetUpstreamService.ts` (the Last Seen Firewall IPAM fallback) and `src/services/dependencyTreeService.ts` (the fourth endpoint-parent tier) — business rule 55. Keep it ONE function: three consumers re-deriving the subnet → gate precedence is the exact drift rule 41 exists to prevent.

**Invariants:**
- **MAC-less assets ONLY** (`macAddress IS NULL`). A MAC-bearing asset is already served by discovery Phase 7.5 and the FortiAP station scrape, whose label format (`<switchId>/<portName>`) differs from this one (`<hostname>/<ifName>`); a second writer would ping-pong the column every tick and audit both halves as changes forever. This job writes only what no other writer can.
- **Fortinet infrastructure is excluded** (`firewall` / `switch` / `access_point`) — their topology lives on `fortinetTopology`, the Phase 7.5 exclusion.
- **The ARP lookup is scoped to the owning gate.** With a gate resolved, only its rows count; with none, rows are accepted only when exactly ONE gate reports the address — two gates answering is the overlapping-RFC1918 case (the Phase 7.6 / rule 26 `(gate, ip)` scoping). `pickArpMac` is the pure statement of this.
- **Two MACs at one address is `"ambiguous"`, not a pick** — a duplicate on the wire is not evidence (rule 26's ARP rule).
- **Two freshness gates.** The asset's claim on the address must be current per rule 40 (`claimIsFresh`: operator-owned never expires; a discovered claim needs its `(asset, ip)` `AssetIpHistory.lastSeen`, or `Asset.lastSeen` when no history row, within `CLAIM_FRESH_DAYS`); ARP / FDB / station rows must have `lastSeen` within `EVIDENCE_FRESH_MS` (24h) — the tables are delete-replaced per scrape, so an older row means its writer stopped answering.
- **Port rank is lowest MAC cardinality** (`pickBestSwitchPort`, Phase 7.5's rule: an access port sees one MAC, the trunk above it sees fifty), then freshest, then a stable name order so ties can't flip the stamp between ticks. Cardinality comes from ONE `groupBy` bounded to the switches involved, never the fleet.
- **The derived MAC IS adopted onto the asset** (2026-09, business rule 45 as amended). Safety is `partitionAdoptableMacs`, not a Setting: the wire-level ambiguities are already refused by `pickArpMac` and the two freshness gates, so the only duplicate left to manufacture is a MAC already spoken for — refused when another asset carries it, and refused for BOTH when two candidates in one pass resolve to the same MAC (rule 40's duplicate-IP conflict is an operator decision, not a silent merge). A refusal drops the ADOPTION only; the switch/AP stamps from the same MAC still land, because a stamp is reversible and a merge is not. Adopted in the same `$transaction` as the stamps, audited as `asset.mac.adopted` (naming the address), and mirrored into `AssetMacAddress` with source `ADOPTED_MAC_SOURCE` ("ip-upstream-arp", NOT a hardware source) after the commit, bounded by `MAC_ROW_CONCURRENCY`. Adoption also ENDS eligibility — the candidate query is `macAddress IS NULL`, so a placed row leaves the candidate set rather than being re-derived every tick. **Residual, deliberate:** a gate misresolved under rule 41 or an address recycled inside `CLAIM_FRESH_DAYS` still adopts; the collision check only sees a duplicate whose other half is already in inventory.
- **Stamps are never cleared** — absence of evidence is not a move — and written only on change (`stampChanged`, case-insensitive like the station scrape's compare).
- **Writes are sorted by asset id inside `$transaction` chunks under `retryOnDeadlock`** (the documented `lastSeenAp` 3-way deadlock fix), and the `asset.switch_port.changed` / `asset.wireless_ap.changed` Events (actor `system:upstream-chain`, source `ip-upstream-chain`) are batched AFTER each commit, never inside it.
- **Set-based end to end**: one claim query (`LIMIT` `CANDIDATE_CAP`), one containment query, one firewall load, IN-chunked ARP / FDB / station queries, one device-name query, chunked updates. No per-asset awaits.

**When changing this:**
- Widening the sweep to MAC-bearing assets means first reconciling the two label formats with Phase 7.5 (`discoveryEngine.ts`) and the SNMP `persistMacTable` path, or every tick emits change Events in both directions.
- **Adoption is live.** Anything that widens which rows reach it — relaxing `pickArpMac`, widening the freshness gates, accepting an unscoped gate — widens what can be merged by `mergeDuplicateHostnameAssets` and Entra's MAC cross-link. Re-read those tie rules before touching either gate, and keep `partitionAdoptableMacs` between the derivation and the write.
- Changing `resolveOwningGateContexts` changes THREE surfaces at once (this sweep's ARP scoping, the Last Seen Firewall row, endpoint dependency parents — rule 55). The last of those decides which devices suppress, so a widened match there silences alerts.
- If `lastSeenSwitch`'s `"<switch>/<port>"` shape shifts, `switchPortLabel` here joins the three parsers listed under `assetUpstreamService`.
- A fourth evidence table (e.g. a DHCP client table) goes in as another `load*Rows` + a pure picker, and its freshness rides `EVIDENCE_FRESH_MS`.

**Tests:** `tests/unit/ipUpstreamChain.test.ts` (the pure pickers and both freshness rules), `tests/unit/ipamOwningGateUpstream.test.ts` (`macKey`, every `partitionAdoptableMacs` refusal, the four-tier endpoint precedence), `tests/integration/ipUpstreamChain.test.ts` (gate scoping by FMG device name, the other-gate refusal, the two-MAC refusal, the stale claim, the MAC-bearing exclusion, the station-by-IP path, the adoption + its audit row, the held-MAC refusal that still stamps the port, and the second pass finding no candidates), `tests/integration/ipamOwningGateUpstream.test.ts` (both rule 55 consumers).

---

## services/connectionPathService.ts

**What it owns:** `resolveConnectionPath(assetId)` — endpoint → switch → … → FortiGate connection-path resolver. Walks the upward dependency chain so the Device Map topology overlay can dim everything off-path.

**Public API:** `resolveConnectionPath`, plus the `ConnectionPath` / `ConnectionPathHop` / `ConnectionHopKind` types.

**Cross-service deps:** Reads `Asset` rows directly + `AssetDependencyParent` (the same source-of-truth `dependencyTreeService` writes). Falls back to `Asset.fortinetTopology` when the dependency tree is empty.

**Used by:** `src/api/routes/assets.ts — GET /api/v1/assets/:id/connection-path`. Total 1 call site today.

**Invariants:**
- Firewall start short-circuits: `hops = [self]`, `siteId = self.id`, `alternateUplinks = 0`.
- Switch / AP start: walk begins at self.
- Endpoint start (workstation / server / printer / other): parse `Asset.lastSeenSwitch = "<switchId>/<port>"`; resolve the switch by hostname OR serialNumber under `assetType="switch"`.
- Upward walk reads `AssetDependencyParent` rows; `source="override"` set takes precedence over `source="computed"` per the existing dependency convention. Empty override set is NOT modeled here — the resolver just sees zero parents and falls through to fortinetTopology.
- MCLAG / dual-homed parents pick the one with `monitorStatus="up"` AND most-recent `lastMonitorAt`; remaining parent count is summed across hops into `alternateUplinks`.
- Fallback to `fortinetTopology.controllerFortigate` (switch → firewall) and `.parentSwitch` (AP → switch) only when `AssetDependencyParent` returns zero rows for the cursor — covers fresh installs before `backfillDependencyTree` runs and freshly-discovered switches awaiting recompute.
- Cycle / pathological-data guard: walk cap of 16 hops + a `seen` set so a self-referential override row can't infinite-loop the resolver.
- `endpointPort` lives only on the first switch hop after an endpoint (parsed from `lastSeenSwitch`); `uplinkInterface` lives on every switch / AP hop (from `fortinetTopology.uplinkInterface`).

**When changing this:**
- If MCLAG parent-preference rules change, update both the sort and the `alternateUplinks` accumulation in lock-step.
- If `lastSeenSwitch` format ever shifts beyond `"<switchId>/<port>"`, update `parseLastSeenSwitch`. Discovery writes both `hostname` and `serialNumber` forms today; both are matched by `findSwitchByName`.
- Keep the fortinetTopology fallback rules aligned with how FMG / FortiGate discovery stamps these fields — see fortimanagerService.ts FortiSwitch / FortiAP write paths.
- Don't include `dependencyLayer` in hops — the resolver runs even when the layer is null (e.g. fresh switches between recomputes), and the consumer doesn't need it.
- AssetDependencyParent DOES contain endpoint rows since 2026-08 (`source="endpoint"`, one leaf edge per endpoint from `dependencyTreeService.syncEndpointDependencyEdges`). This resolver predates them and still parses `lastSeenSwitch` itself for the endpoint's first hop rather than reading that row — harmless duplication (same signal, same precedence), but if the endpoint-half precedence changes, decide deliberately whether this walk should read the row instead. Note the resolver's own upward walk filters `source === "computed"` literally, so it never picks up an `endpoint`/`vcenter` parent mid-chain; that only matters if an endpoint ever becomes a non-leaf.

---

## services/dependencyTreeService.ts

**What it owns:** Dependency-DAG computation and multi-parent suppression semantics — assigns layers via BFS from FortiGate roots, prefers the most-physical edge per (child,parent) pair, hangs every non-infra asset off that tree as a leaf, and reconciles `Asset.dependencySuppressed` on the reconciler cadence.

**Public API:** `DependencyDetectedVia`, `DependencySource`, `FORTINET_INFRA_ASSET_TYPES`, `ENDPOINT_DEPENDENCY_SOURCE`, `DepAsset`, `DependencyEdge`, `LayerAssignment`, `buildDependencyEdgesFromInputs`, `assignLayers`, `evaluateSuppression`, `blameFromGraph` / `resolveDependencyBlame` / `newBlameLoadCache` / `BLAME_MAX_HOPS` (+ `DependencyBlame`, `DependencyBlameNode`, `DependencyBlameReason`, `BlameNodeState`, `BlameLoadCache` — business rule 78), `DepEndpoint`, `EndpointParentResolution`, `switchNameFromLastSeenSwitch`, `resolveEndpointParent`, `buildEndpointDependencyEdges`, `syncEndpointDependencyEdges`, `recomputeDependencyTree`, `reconcileDependencySuppression`, `propagateAfterStatusChange`, `SuppressionAssetState`

**Cross-service deps:** `prisma`, `interfaceTopologyService`, `logEvent`, `logger`, `utils/assetInvariants.EXCLUDED_LIFECYCLE_STATUSES`, `utils/assetSourceLocation.bareFortinetDeviceName`, `utils/fortinetParentKey`, `ipUpstreamChainService` (`resolveOwningGateContexts` + `claimIsFresh`, for the fourth endpoint tier), `duplicateIpConflictService.CLAIM_FRESH_DAYS`.

**Used by:** `src/api/routes/integrations.ts` + `src/api/routes/assets.ts` (dependency test / admin endpoints), `src/services/monitoringService.ts` (suppression queries), `src/jobs/dependencyReconciler.ts` (reconciler tick), `src/jobs/backfillDependencyTree.ts` (migration).

**Invariants:**
- All-down semantics: an asset suppresses only when ALL effective parents are down/suppressed; unmonitored parents are transparent (walk continues to grandparents).
- **Unmonitored HA-standby parents are IGNORED, not transparent** (`SuppressionAssetState.isHaStandby`, populated by `reconcileDependencySuppression` from a narrow `fortinetTopology->>'haRole'='secondary'` firewall query): filtered from every parent set (top-level + the transparent-walk recursion) so a switch LLDP-cabled to both HA members suppresses on the primary's confirmed-down alone. The transparent rule's "no monitored ancestor = ok" would otherwise permanently veto suppression sitewide, since standbys are unmonitored by design (the flip-off sweep in discoveryEngine.ts). A MONITORED standby (operator opt-in) evaluates normally. Standby-only parent sets never suppress (safe post-failover transient).
- The dependency DAG has NO edge between HA members — both are layer-1 roots, so member↔member LLDP edges are same-layer and pruned. The asset-details tree panel shows the cluster's second box via the display-only `haPeer` field on `GET /assets/:id/dependencies` (resolved from `fortinetTopology.haPeerSerial`), NOT via a graph edge.
- Only a confirmed-down edge propagates — warning/recovering flapping does not.
- **Release is asymmetric (hysteresis, 2026-08).** Entering suppression still needs a parent confirmed `down`; LEAVING it needs a parent that is genuinely back, so `recovering` counts as down for a child that is ALREADY suppressed (`SuppressionAssetState.currentlySuppressed` selects the side). A recovering parent has answered once and is still short of the covering automation's success threshold — releasing there un-suppresses the whole subtree on one packet, every child's own probes are still failing, and the outage re-alerts device by device as plain Down. Only `down` and `recovering` are asymmetric: `unknown`, `passive` and `warning` stay ok on both sides, or a subtree could strand in Dep. Down with nothing able to clear it.
- Operator override rows take precedence over computed rows; the admin Dependency-Test overlay (`dependencyTestUntil`) is a what-if that auto-expires + emits an Event.
- A `status="maintenance"` parent counts as down (test-overlay semantics, no grandparent walk-through) — UNLESS its schedule opted out (`MaintenanceSchedule.suppressChildren=false` → `SuppressionAssetState.maintenanceSuppressChildren=false`, OR-ed across the asset's open windows by `reconcileDependencySuppression`; a deleted-schedule window or a manual maintenance status with no windows defaults to suppressing), in which case the parent falls through to its frozen `monitorStatus`.
- **The blame walk names WHO silenced a device, and it is not `evaluateSuppression`'s boolean** (business rule 78). `blameFromGraph(states, parentsByChild, assetId)` takes `evaluateSuppression`'s inputs plus a hostname: a parent is blamed as `dependency_test` / `maintenance` (a schedule that opted out of `suppressChildren` is NOT blamed) / `suppressed` / `down` — in THAT order, so a switch that is both suppressed and reading `down` under a dark gate is blamed as `suppressed` and the walk carries on to the gate, which is the ROOT CAUSE; `down` is reserved for a node dark in its own right. Unmonitored parents are transparent, unmonitored HA standbys ignored, a definitive reason outranks `suppressed` among redundant parents and hostname breaks ties. Bounded by `BLAME_MAX_HOPS` (16) and marked `truncated` on the cap or a cycle. `resolveDependencyBlame(assetId, cache)` loads the ancestor closure hop by hop (edges, then parent states; open maintenance windows and `haRole` only for the parents that need them) into a `BlameLoadCache` the engine renews per tick, so 300 PLCs behind one switch load the switch and gate once; it never throws — a failed read yields null and the alert goes out unnamed. Deliberately NOT `connectionPathService.resolveConnectionPath` (its tie-break prefers an `up` parent — the wrong bias for blame) and NOT the reconciler Event's `parentAssetIds` (the whole set, never past layer 1).
- `assignLayers` keeps only parent-edges (`parent.layer === child.layer - 1`); preferred edge is interface > lldp > mesh > controller.
- **Endpoint half (2026-08).** Every asset whose type is NOT in `FORTINET_INFRA_ASSET_TYPES` gets AT MOST ONE parent, written with `source="endpoint"` by `syncEndpointDependencyEdges`. Before it, an endpoint had zero parents and "no parents" means "never suppressed" — a camera-station server behind a dead FortiGate alerted as plain Down while every switch and AP behind that gate correctly read "Dep. Down".
  - Precedence, most-specific first: `Asset.lastSeenSwitch` (→ `detectedVia="switch-port"`) → `Asset.lastSeenAp` (→ `"wireless"`) → the freshest `AssetFortigateSighting.fortigateDevice` that resolves (→ `"sighting"`) → **the FortiGate that owns the network the endpoint's address sits in, per IPAM** (→ `"subnet"`, business rule 55). Nothing resolves ⇒ no row ⇒ alerting unchanged, which is the safe direction.
  - **The fourth tier is an inference and is bounded as one.** It is resolved in a SECOND pass over only the endpoints the three observed tiers left unplaced (`resolveIpamGatesForEndpoints` → `ipUpstreamChainService.resolveOwningGateContexts`), so the placed majority never pays for the containment query or the firewall load. Because an unplaced endpoint had NO parent, this tier can only ADD suppression, never move an existing edge: the failure mode is a missed alert, never a false one, and entering suppression still needs the gate confirmed `down`. The endpoint's claim on its address must be current under rule 40 (`claimIsFresh`) — a recycled DHCP address would otherwise parent a departed device to whoever serves that range today.
  - **SINGLE parent, deliberately not a union.** The evaluator's multi-parent rule is all-down (built for redundant uplinks), but a switch and the gate above it are in SERIES: listing both would let a dead access switch with a healthy gate satisfy "some parent is ok" and keep the endpoint alerting. The series behavior comes for free from the switch being suppressed by its own gate.
  - Parent resolution goes through `fortinetParentKey` (serial → FMG device name → hostname), never a bare hostname match. `AssetFortigateSighting.fortigateDevice` holds FMG's DEVICE NAME.
  - An asset already carrying a `source="vcenter"` row (VM→ESXi placement) is SKIPPED — the hypervisor is the more specific truth, and unioning the two would break the existing vCenter suppression under all-down (host down + switch up would stop suppressing).
  - Fleet-wide and NOT narrowed by `integrationId`, because most endpoints belong to an AD / Entra / vCenter integration that never calls `recomputeDependencyTree`; a scoped pass would leave them permanently unparented. Writes are DIFFED (insert missing / delete gone / update a changed `detectedVia`) rather than delete-replaced, so a steady fleet writes zero rows and two integrations finalizing at once can't churn each other's. `Asset.dependencyLayer` is stamped parent-layer + 1 (null when the parent is unlayered), also only where it differs.
  - Refreshed on the discovery-finalize cadence only (plus the boot backfill), so a device that moves ports carries a stale parent until the next cycle. Both the stale and fresh parent are upstream of it in practice; the failure mode is a missed suppression, not a false one.
  - Exceptions to endpoint edges are the two the reconciler already honors: decommissioned/disabled assets are excluded from the pass entirely, and an operator `source="override"` row wins as always.

**When changing this:**
- `propagateAfterStatusChange` is a latency optimization; `reconcileDependencySuppression` is the source of truth.
- Anything that resolves "the effective parent set" must treat every NON-`override` source as computed — `loadEffectiveParents` does, and `loadBoundChildRows` + the parents shaping in `GET /assets/:id/dependencies` were fixed in 2026-08 to match (they tested `source === "computed"` literally, which hid both `endpoint` and `vcenter` rows from the asset-details tree while the reconciler was suppressing on them).
- The endpoint half makes a site FortiGate's child set fleet-sized. `GET /assets/:id/dependencies` keeps BOTH downward layers infra-only and capped (`DEP_INFRA_CHILD_CAP` / `DEP_GRANDCHILD_CAP`); any new consumer that walks children downward needs its own type filter and its own bound. Suppression itself is unaffected — the reconciler reads every edge regardless of what the tree displays.

---

## services/ouiService.ts

**What it owns:** IEEE OUI database download and CSV parsing; lazy in-memory lookup map; admin-editable overrides (prefix → manufacturer+device); cache persistence via Setting table.

**Public API:** lookupOui, lookupOuiBatch, lookupOuiOverride, refreshOuiDatabase, getOuiStatus, OuiOverride, getOuiOverrides, setOuiOverride, deleteOuiOverride.

**Used by:**
- src/api/routes/assets.ts — GET /assets/:id, look up MAC OUI (vendor name)
- src/services/discovery/discoveryEngine.ts — tag assets with vendor during discovery
- src/api/routes/serverSettings.ts — GET/PUT /server-settings/oui, CRUD overrides + trigger refresh
- src/jobs/ouiRefresh.ts — Weekly cron job, refresh database and log entries/size

**Invariants:**
- IEEE database is downloaded from standards-oui.ieee.org/oui/oui.csv; stored as JSON in Setting table; loaded on-demand into module-level in-memory map (singleton pattern, reset only on refresh).
- Prefix format: "AABBCC" (6 hex chars); input normalization handles colon/dash/mixed-case (AA:BB:CC, aa-bb-cc, etc.).
- Overrides take priority over IEEE DB; back-compat layer supports legacy bare-string overrides (migrate to {manufacturer, device?} shape on load).
- lookupOuiBatch() avoids repeated DB reads; used by discovery to tag multiple assets in one pass.
- refreshOuiDatabase() runs at startup (skip if <6 days old) and weekly; on 30s HTTP timeout, entire refresh fails (not incremental).

**When changing this:**
- Test MAC normalization (colon/dash/mixed-case input) and prefix extraction.
- Verify override priority (override lookup before IEEE DB).
- Test batch lookup (multiple MACs in one call).
- Check CSV parser for quoted fields (commas inside quotes should not split).
- Ensure refresh doesn't block startup; use timeout so network failures don't hang boot.

---

## services/discoveredHostnameService.ts

**What it owns:** The answer to "what hostname would this asset have if the operator pin were cleared?" — a batched read of `AssetSource.observed` run through `projectAssetFromSources`, keyed by assetId. It exists because `Asset.hostnameOverride` makes the pinned value THE `hostname` column (the assets PUT writes both, the src/db.ts guard re-asserts the pin over every projection write), so the discovered name is persisted nowhere on the Asset row.

**Public API:** `projectHostnamesFromSourceRows(rows)` (pure — groups by assetId + projects each group), `getDiscoveredHostnames(assetIds)`, `getDiscoveredHostname(assetId)`

**Cross-service deps:** `utils/assetProjection.ts` (`projectAssetFromSources`) + prisma.assetSource. No writes at all.

**Used by:** `api/routes/assets.ts` — `enrichAssetList` (list rows, ids filtered to those carrying `hostnameOverride`) and `GET /assets/:id` (only when the row is pinned). Both surface it as the wire field `hostnameDiscovered`; `public/js/assets.js` `hostnameOriginalLineHTML()` renders it as the subdued second line in the Hostname cell and in the slide-over Hostname row.

**Invariants:**
- **Read-only and never called for unpinned rows.** The caller filters the id set, so a page with no overridden hostnames issues no extra query; otherwise it is ONE indexed `assetId IN (...)` scan of `asset_sources` per request.
- **Deliberately uncapped id set.** The bound is how many hostnames an operator has hand-pinned (a per-device manual act), and a silent top-N would blank the sub-line on arbitrary rows — the "no silent caps" rule.
- **Computed, not stashed.** A `hostnameDiscovered` column written by the db.ts guard was the alternative; projecting on read keeps the value LIVE (what discovery says today, not what it said when the pin was typed) and makes it retroactive for assets pinned before the feature, with no migration and no backfill job.
- Null means "there is no original" (manually created asset, or only `inferred` phase-1 skeleton sources) and an id with no source rows is simply absent from the map. The frontend renders nothing in both cases, and also when the projection AGREES with the pin — a duplicate line says nothing.
- Same projection function as the pin-clear path in `assets.ts` (`loadProjection().projected.hostname`), so what the sub-line shows is exactly what clearing the pin would write.

**When changing this:**
- Hostname priority rule changes in `assetProjection.ts` change what this prints — the two are the same function on purpose; don't fork it.
- Adding a caller: pass only pinned ids (the query cost is proportional to the id set), and keep `hostnameDiscovered` as the wire field name — the frontend helper keys on it plus `hostnameOverride`.
- `ASSET_LIST_SELECT` must keep `hostnameOverride`: it is both the render gate and the id filter.

---

## services/projectionDriftService.ts

**What it owns:** Best-effort fire-and-forget shadow drift detection after successful AssetSource upserts; logs disagreements only (observability, no behavior change).

**Public API:** `detectAndLogDrift(assetId, integrationKind)`

**Cross-service deps:** None (uses `projectAssetFromSources()` utility + pino logger).

**Used by:** (Not yet called; Phase 3b shadow phase pending Phase 3b.1 actual write implementation)

**Invariants:**
- Fire-and-forget: any internal error is swallowed via `logger.warn()`; drift detection failures must never break the Asset write.
- Drift is asymmetric: projection has X ≠ Y on asset → logged; projection has X, asset null → logged; projection null → silent (no comment = no disagreement).
- Logs to pino with `event: "asset.projection.drift"` (NOT audit Event table); high volume during full sweeps, operators grep app logs.
- Compared fields: hostname, serialNumber, manufacturer, model, os, osVersion, learnedLocation, ipAddress, latitude, longitude (match `ProjectedAsset` keys). latitude/longitude are SKIPPED when `Asset.coordSource === "manual"`, hostname is SKIPPED when `Asset.hostnameOverride` is set, and ipAddress is SKIPPED when `Asset.ipOverride` is set — an operator pin deliberately diverges from the projection (the db.ts guard re-asserts it over discovery writes), so it's not drift (the IP disagreement already surfaces as an ip-override Conflict instead).
- Logs include `assetId, integrationKind, drifts[]` with per-field projected/current/winningSource provenance.

**When changing this:**
- Sync `PROJECTED_FIELDS` list against `ProjectedAsset` interface additions (assetProjection.ts).
- If projection rules change in `projectAssetFromSources()`, review which drifts are expected (e.g. hostname tiebreak logic).
- Check pino logger setup in `src/utils/logger.ts` for structured field compatibility.
- Once Phase 3b.1 write is implemented, wire `detectAndLogDrift()` into the post-upsert callback in discovery sync paths.

---
