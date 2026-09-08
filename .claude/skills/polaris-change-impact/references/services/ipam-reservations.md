# Services — blocks, subnets, reservations, network scans, IP conflicts

Per-service touches (What it owns / Public API / Cross-service deps / Used by / Invariants / When changing this), verbatim from TOUCHES.md. Code references are `path/file.ts → symbolName()` — grep the symbol.

## services/allocationTemplateService.ts

**What it owns:** Named saved multi-subnet allocation templates backed by Setting table.

**Public API:** listTemplates, saveTemplate, deleteTemplate.

**Used by:** src/api/routes/allocationTemplates.ts (all CRUD operations).

**Invariants:**
- Templates stored as JSON blob in Setting.networkAllocationTemplates
- Prefix length must be [8, 32] per entry
- Non-skip entries require a name; skip entries reserve space only
- VLAN, when present, must be [1, 4094]
- Template name uniqueness (case-insensitive) enforced
- anchorPrefix optional, defaults to 24 if omitted when used

**When changing this:**
- Verify saveTemplate's name-collision detection (idempotent update vs new insert)
- Check prefix length validation matches subnetService expectations
- Test that VLAN validation in allocationTemplateService is consistent with route schema

---

## services/ipContextService.ts

**What it owns:** The one-address cross-reference behind the manual Add Asset form -- what Polaris already knows about an IP, gathered from tables other services write.

**Public API:** `lookupIpContext(ip, { includeSubnets, includeReservations })`, the pure `pickNamedGate(subnetGate, sightingGate)` and `buildSuggestions({mac, reservation, firewall})`, plus the `IpContext*` result types.

**Cross-service deps:** `subnetService` (`buildIpContexts` -- containment), `utils/cidr` (`isValidIpAddress`), `utils/fortinetParentKey` (`buildInfraParentIndex` / `resolveInfraParentAsset`).

**Reads:** `Subnet` (+ its `IpBlock` and `Integration`), `Reservation`, `AssetArpEntry`, `AssetFortigateSighting`, `AssetMacTableEntry`, `AssetWirelessStation`, `Asset` (+ `AssetAssociatedIp` via `associatedIpRows`).

**Writes:** nothing. No device I/O, no Events, no rows -- it is a lookup, and every mutation stays in the operator's hands.

**Used by:**
- `src/api/routes/assets.ts` -> `GET /assets/ip-context` -- the only caller. Gated `assets:read`, with `includeSubnets` / `includeReservations` resolved per request from `hasPermission(req, "subnets"|"reservations", "read")`.
- `public/js/assets-ipcontext.js` -- renders the result under the Add Asset form's IP field.

**Invariants:**
- **Containment goes through `buildIpContexts`, never a fresh `cidr >>= ip` query.** That helper is documented as the single implementation of the most-specific-containing-subnet SQL (`masklen DESC`); a second copy would let this surface disagree with the assets table's View-Lease button and the dns_resolved reconciler about which subnet an address belongs to.
- **A gate NAME resolves through `utils/fortinetParentKey.ts`, never against `Asset.hostname`.** `Subnet.fortigateDevice` and `AssetFortigateSighting.fortigateDevice` both hold FortiManager's device name, and the hostname match is exactly the conflation that module exists to prevent. A name that resolves to no asset still NAMES the gate -- "behind CENTRALFMG1" is useful without an asset row, and dropping it would silently answer "no firewall".
- **The gate ranking is by how directly the source observed THIS address:** ARP (live, and its gate is already an asset -- no name resolution at all) > subnet (config truth, and the only source that answers for an address nothing has ever seen) > sighting (historical; survives the device moving or the address being re-issued). The subnet-over-sighting half is the pure `pickNamedGate` so the ranking is stated once and tested.
- **The subnet is resolved even for a caller without `subnets:read`** -- it is how the reservation is found and one of the three gate sources. Only the EMITTED `subnet` block is gated. The gate name it contributes is the same value `Asset.learnedLocation` already shows to any `assets:read` caller, so this leaks nothing new; the reservation, by contrast, is not queried at all without `reservations:read`.
- **`visibility` must keep reporting which halves were consulted.** A hidden section has to render as "not shown"; collapsing it into an absent one would have the panel assert "no network contains this address" to a role that never looked.
- **Suggestions are advisory and never applied server-side**, and only ever carry a value some row actually supplied -- so an empty block means "nothing known". MAC prefers ARP over the reservation for the same reason placeholder-MAC adoption does (business rule 26): a live L2 binding is what the wire says, a reservation MAC is what somebody typed. Coordinates come from the GATE, because a gate's coordinates are the site's.
- **Row caps are per source (`ROW_CAP` = 10).** An address resolving to more rows than that in any of these tables is itself a duplicate-address finding; the cap keeps a pathological one from filling the panel.
- **The AP station lookup (`apStations`) has two ways in, and the second needs no MAC.** Stations are matched by the resolved MAC (`staMacAddr`) OR by the address the AP itself recorded for the station (`staIpAddr`), each row saying which (`matchedBy`). The switch-port line can only ever follow a MAC; the AP line is the one source here that can place a device nothing wired has ever seen. The same two paths drive the `ipUpstreamChainService` sweep's `lastSeenAp` stamp.

**When changing this:** the frontend's `buildFindings` reads every field name in `IpContextResult` -- adding a source means a finding line in `public/js/assets-ipcontext.js` and a case in `tests/unit/ipContextDom.test.ts`. A new source that can name a gate belongs in the ranking (`pickNamedGate` or `resolveFirewall`), not in a fourth ad-hoc branch. Any new table joined by IP needs an index on its IP column -- this runs from a debounced keystroke handler (`asset_fortigate_sightings_ipAddress_idx`, migration `20260820000000_sighting_ip_index`, was added for exactly that). Pure halves are covered by `tests/unit/ipContextService.test.ts`.

---

## services/blockService.ts

**What it owns:** IP block CRUD and metadata (name, tags, description), plus the `block.created` / `block.updated` / `block.deleted` audit Events (emitted in-service after each mutation resolves; create/update inputs carry `actor?`, deleteBlock takes `(id, actor?)`).

**Public API:** listBlocks, getBlock, createBlock, updateBlock, deleteBlock.

**Used by:** src/api/routes/blocks.ts (all CRUD operations), src/services/subnetService.ts (block parent lookups, overlap validation).

**Invariants:**
- Block deletion forbidden if any active reservations exist across child subnets
- CIDR must be normalized and unique
- IP version immutable after creation (v4 vs v6)
- Tags are optional arrays, filtered client-side in listBlocks
- Exactly ONE audit Event per mutation, fired `void` after the write resolves — never from the route layer (double-logging) and never before/inside the write (phantom on failure). `tests/integration/blocks.test.ts` asserts the one-per-mutation + zero-on-validation-failure contract.

**When changing this:**
- Verify deleteBlock's active-reservation cascade check (affects data integrity)
- Test CIDR normalization in createBlock (e.g., 10.1.1.5/24 → 10.1.1.0/24)
- Check block-listing performance if tag filtering is optimized

---

## services/dnsService.ts

**What it owns:** Reverse (IP → PTR) and forward (hostname → A/AAAA) DNS lookup via three modes (standard/UDP, DoT/TLS, DoH/HTTPS); per-asset TTL caching; resolver configuration storage.

**Public API:** DnsSettings, PtrRecord, ARecord, ResolverLike, getDnsSettings, updateDnsSettings, createResolver, getConfiguredResolver.

**Used by:**
- src/api/routes/assets.ts — GET /assets/:id, resolve PTR names for associated IPs
- src/services/discovery/discoveryEngine.ts — resolve PTR during discovery (dispatched from POST /integrations/discover)
- src/api/routes/serverSettings.ts — GET/PUT /server-settings/dns, CRUD DNS config + test endpoint

**Invariants:**
- Three modes (standard, dot, doh): standard falls back to system DNS, returns null TTL; DoT connects to port 853 (configurable), parses TCP wire format; DoH uses JSON API (Cloudflare/Google/Quad9).
- Standard mode cannot retrieve TTL from Node's DNS API; callers apply a sensible default (3600s).
- Per-asset PTR caching lives on AssetAssociatedIp.ptrName/ptrTtl/ptrFetchedAt (separate call path for bulk DNS job).
- IPv6 PTR queries use fully-expanded form with nibble reversal (e.g., 2001:db8::1 → 1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.ip6.arpa).
- DoH and DoT timeouts are 5 seconds. TLS verification on the DoH/DoT connection is operator-controlled via `DnsSettings.verifyTls` (Server Settings → DNS) — read-side is `verifyTls === true`, so a stored setting with no flag keeps the prior no-verify behavior (migrate-safe; 2026-06-03 review M3). Threaded from `createResolver` → `dohFetchJson(url, verifyTls)` / `sendTlsQuery(host, port, query, verifyTls)`.
- Standard mode resolver is constructed with `{ timeout: 5000, tries: 1 }` to keep one unresponsive upstream from compounding into ~20s of per-host wall-clock (c-ares defaults to 4 tries) — critical for the AD forward-DNS pre-pass which can fan out hundreds of names.

**When changing this:**
- Test all three modes end-to-end; verify TTL handling (null for standard, numeric for DoT/DoH).
- Test IPv6 expansion and nibble reversal separately.
- Verify DoT socket cleanup on timeout (don't leak TLS connections).
- Check DoH JSON parse for missing/malformed responses; filter by type number (1=A, 28=AAAA, 12=PTR).

---

## services/ipService.ts

**What it owns:** IP validation, availability checking, and subnet capacity reporting.

**Public API:** assertValidIp, assertValidCidr, assertIpInSubnet, isIpAvailable, getActiveReservationsForSubnet, subnetCapacity.

**Used by:** src/api/routes/reservations.ts (multiple callers), src/services/reservationService.ts (ipInCidr, detectIpVersion), src/services/reservationPushService.ts (isValidIpAddress).

**Invariants:**
- IPv4-only for capacity calculations (IPv6 raises 400)
- All CIDR inputs are normalized (host bits zeroed)
- IP addresses must be validated before subnet containment checks
- Active reservations indexed on subnetId + status = "active"

**When changing this:**
- Review all calls to assertValidIp/assertValidCidr in routes (ipAddress validation gates many Reservation operations)
- Check utilization calculations depend on subnetCapacity (affects Dashboard utilization card)
- Test with both IPv4 and IPv6 where applicable

---

## services/duplicateIpConflictService.ts

**What it owns:** The `duplicate-ip` Conflict flavour end to end (business rule 40) — detection, the raise/refresh/auto-close lifecycle, and BOTH resolution verbs (reassign one member to a new address; merge members that are one device recorded twice). Sibling of `ipOverrideService` (same JSON-path dedup pattern, same auto-resolution convention), but detection-driven rather than write-driven.

**Public API:** pure — `claimIsOperatorOwned(row)`, `claimIsCurrent(row, cutoff)`, `distinctDeviceCount(members)`, `groupCurrentClaims(rows, cutoff)`, `memberSetKey(members)`, `pickPrimaryMemberId(members)`, `groupHasEligibleType(members)`, `resolveMergeTargets(members, survivorId, rawAbsorbIds)`, `toStoredMember(row)`, `duplicateIpRejectMessage(conflict)`; DB — `loadDuplicateIpClaims()`, `reconcileDuplicateIpConflicts()` (the job's entry point), `reassignDuplicateIpAsset(conflict, assetId, rawIp, actor)`, `mergeDuplicateIpAssets(conflict, survivorAssetId, absorbIds, actor)`, `logDuplicateIpDismissal(conflict, actor)`, `logScanFailure(err)`. Constants `DUPLICATE_IP_COLLISION_REASON`, `CLAIM_FRESH_DAYS`, `CONFLICT_ELIGIBLE_ASSET_TYPES`.

**Cross-service deps:** `prisma`, `logEvent` + `buildChanges` (eventLogService), `UNMONITORABLE_STATUSES` (utils/assetInvariants), `isValidIpAddress` (utils/cidr), `resolvePendingIpOverrideConflicts` (ipOverrideService), `mergeAssets` (assetMergeService — the merge verb delegates rather than re-implementing an absorb).

**Used by:** `src/jobs/detectDuplicateIpAssets.ts` (10-min sweep, scheduler role), `src/api/routes/conflicts.ts` (`POST /:id/reassign-ip` + the duplicate-IP branch of `POST /:id/merge`), `src/services/conflictResolutionService.ts` (imports `DUPLICATE_IP_COLLISION_REASON` + `logDuplicateIpDismissal` for the accept-refusal and reject branches). Frontend reader: `renderDuplicateIpConflictCard` in `public/js/events.js` + the reason label in `public/js/widgets/conflictQueue.js`.

**Invariants:**
- ONE pending conflict per ADDRESS (never per pair) — a three-way collision is one row, every claimant in `proposedAssetFields.members[]`.
- `Conflict.assetId` is the LOWEST-id member. Stable on purpose: it is the FK whose cascade cleans the conflict up when an asset is deleted, and following the most-recent sighting would churn it every refresh.
- Only statuses NOT in `UNMONITORABLE_STATUSES` participate (`active` + `maintenance`) — derived from that constant, never a hardcoded status list.
- A member counts only while its claim is CURRENT: operator-owned (pin == address, or `ipSource="manual"`) never expires; a discovered claim needs the `(asset, ip)` `AssetIpHistory.lastSeen` (or `Asset.lastSeen` when there is no history row) within `CLAIM_FRESH_DAYS`.
- Members sharing one non-null MAC are ONE device (`distinctDeviceCount`); a null MAC counts as its own.
- A group needs at least ONE claimant whose `assetType` is in `CONFLICT_ELIGIBLE_ASSET_TYPES` (switch / access_point / firewall / server) — but every other claimant stays in `members[]`, since an endpoint that took an AP's address is what the card has to name. Tested on the CURRENT claims, so a stale switch record can't license an endpoint-only conflict.
- The scan's SQL `bool_or` prefilter on that list is a SUPERSET (it cannot see the freshness verdict); `groupHasEligibleType` in JS is the decision. Keep the two in step — they read the same exported constant, so don't inline the list into the SQL.
- Narrowing that list needs no migration: a pending conflict whose members stop qualifying is retired by the reconcile's own auto-close path.
- Accept is REFUSED for this flavour (`acceptAssetConflict` throws 400) — nothing to adopt.
- A REJECTED row with the SAME member set suppresses re-raise; a changed set raises again.
- `reassignDuplicateIpAsset` writes `ipAddress` + `ipOverride` + `ipSource="manual"` in ONE update so the `db.ts` override guard defers, and refuses a target another network-present asset already records (409).
- `mergeDuplicateIpAssets` re-points `Conflict.assetId` at the survivor BEFORE the first merge — deleting an absorbed asset cascades to conflicts pointing at it, which would destroy this row (and the audit trail) mid-operation.
- The merge verb takes NO field winners: blank-fill is what every automatic absorb uses, and per-field control lives on the asset Sources tab. It delegates to `mergeAssets` — never a private absorb — and writes one `asset.merged` Event per absorbed row, mirroring the `POST /assets/:id/merge` Event shape.
- Both resolution verbs close the conflict only when fewer than two CURRENT claims remain; a three-way collision stays open on the survivors.
- Auto-close convention matches `resolveStaleReservationConflicts` / `ipOverrideService`: `status="rejected"`, `resolvedBy="system:auto-resolved"`.
- Reconcile is idempotent — a fleet with no duplicates issues zero writes.

**When changing this:**
- The `proposedAssetFields` shape is read by `renderDuplicateIpConflictCard` (events.js), the `conflictQueue` widget subtitle, `reassignDuplicateIpAsset`'s member check and `resolveMergeTargets` — change all five together.
- The card's two action wirings (`[data-dupip-apply]` and `[data-dupip-merge]`) are bound in `loadConflicts` in events.js, not in the renderer — a new action needs both halves.
- The scan's SQL names raw columns (`assets`, `asset_ip_history`); a rename in `prisma/schema.prisma` needs a matching edit here (it bypasses the Prisma client, and therefore also bypasses the secret-at-rest and override extensions — do not add asset WRITES to it).
- Adding a status to `UNMONITORABLE_STATUSES` (business rule 10) automatically narrows this sweep — intended, but re-read rule 40(a) before assuming it.
- Adding an asset type to `CONFLICT_ELIGIBLE_ASSET_TYPES` widens what raises (`hypervisor` and `router` are the two deliberately-omitted candidates — business rule 40(g)); operator-added custom types are outside it by design, per the `assetType`-branching convention in CLAUDE.md.
- Keep the raise Event on `conflict.detected`: the baseline "IP conflict detected" automation subscribes to that action string, and a new action would silently un-alert the feature.
- The JSON path filter (`proposedAssetFields.path ["collisionReason"]`) requires PostgreSQL; keep it in step with `DUPLICATE_IP_COLLISION_REASON`.

---

## services/ipOverrideService.ts

**What it owns:** Side effects of the operator IP pin (`Asset.ipOverride`) around discovery writes — the pin's ONLY writer besides the assets PUT route. The pure decision (release-on-match / reassert-on-mismatch) lives in `applyIpOverride` (`src/utils/assetInvariants.ts`), executed inside the `enforceOperatorOverrides` guard in `src/db.ts`; this service handles what happens next, invoked fire-and-forget AFTER the guarded write lands.

**Public API:** `handleIpOverrideReleased(assetId, ip)` (release path: auto-close pending ip-override conflicts + `asset.ip_override.released` Event), `raiseIpOverrideConflict(assetId, discoveredIp, ipSource?)` (mismatch path: create/refresh the asset's single pending Conflict), `resolvePendingIpOverrideConflicts(assetId, resolvedBy)` (close pending rows; returns count), `IP_OVERRIDE_COLLISION_REASON`.

**Cross-service deps:** `prisma` (db.ts — imported lazily FROM db.ts via dynamic import to break the cycle), `logEvent`.

**Used by:** `src/db.ts` (`fireIpOverrideFollowUp` after asset update/upsert), `src/api/routes/assets.ts` (PUT calls `resolvePendingIpOverrideConflicts` when the operator sets/clears the pin). Resolution UI path: `src/services/conflictResolutionService.ts` (`acceptIpOverrideConflict` / `rejectIpOverrideConflict` branch on `proposedAssetFields.collisionReason === "ip-override"`).

**Invariants:**
- At most ONE pending ip-override conflict per asset — repeat sightings refresh it (re-pointing `proposedAssetFields.ipAddress` when the discovered IP moves again) and keep `existingAssetSnapshot` current while pending.
- A REJECTED conflict with the same proposed IP suppresses re-raising (the rejected row IS the dedup marker); a new discovered IP raises a fresh conflict.
- `proposedAssetFields` shape: `{ collisionReason: "ip-override", ipAddress, ipSource, overrideIp, hostname }` — no `proposedDeviceId` / AssetSource identity; `hostname` is there for the conflictQueue widget subtitle.
- Race-guarded: re-reads the asset and no-ops when the override was cleared (or moved onto the discovered IP) between the guarded write and the follow-up.
- Auto-resolution convention matches `resolveStaleReservationConflicts`: `status="rejected"` + `resolvedBy` ("auto" for discovery-convergence, actor for operator pin changes).
- Everything is best-effort (errors logged + swallowed) — runs after the asset write already landed and must never break it.

**When changing this:**
- Keep the accept/reject handlers in `src/services/conflictResolutionService.ts` in sync with the `proposedAssetFields` shape (accept reads `ipAddress`/`ipSource`/`overrideIp`).
- Keep the events.js `renderIpOverrideConflictCard` reading the same keys.
- If the dedup model changes (e.g. per-IP instead of per-asset pending rows), revisit `resolvePendingIpOverrideConflicts` callers — the PUT route assumes "close everything pending for this asset."
- The JSON path filter (`proposedAssetFields.path ["collisionReason"]`) requires PostgreSQL; keep it in sync with `IP_OVERRIDE_COLLISION_REASON`.
- Sibling flavour: `services/duplicateIpConflictService.ts` (`duplicate-ip`) copies this dedup/auto-resolve pattern and CALLS `resolvePendingIpOverrideConflicts` when its reassign writes a new pin — a change to that function's contract touches both.

---

## services/reservationService.ts

**What it owns:** Reservation creation, updates, release, expiry, and DHCP push orchestration — including ALL the reservation audit Events: the push-lifecycle detail rows AND the top-level `reservation.created` / `reservation.updated` / `reservation.released` CRUD rows (createReservation is a thin wrapper around the internal flow that emits the one created-Event with the final push outcome in its message; `via: "auto-allocate"` discriminates the nextAvailableReservation message; releaseReservation takes `(id, actor?)` and emits after its transaction commits).

**Public API:** listReservations, getReservation, createReservation, updateReservation, releaseReservation, findNextAvailableIps, nextAvailableReservation, expireStaleReservations. `findNextAvailableIps(subnetId, count, contiguous)` is the picker BOTH the single auto-allocate and the IP panel's multiple-IP preview go through (`nextAvailableReservation` is now `findNextAvailableIps(id, 1, false)` + `createReservation`), so there is one definition of "next available" and one set of guards. Selection itself is the pure `utils/ipAllocation.ts`; this function owns the subnet guards, the paged walk (256/page, `SCAN_CEILING` 65536 addresses), and the 409 wording. `MAX_BULK_ALLOCATE` (64) is exported and mirrored by `ALLOC_MAX` in `public/js/ip-panel.js` — change one, change both.

**Cross-service deps:** reservationPushService (pushReservation, updatePushedReservation, unpushReservation, releaseDhcpLease, normalizeMac).

**Used by:** src/api/routes/reservations.ts (all CRUD + next-available), src/jobs/expireReservations.ts (expireStaleReservations every 15 min).

**Invariants:**
- MAC address required when push eligible (subnet discovered by FMG/FortiGate with pushReservations=true)
- Full-subnet reservation (ipAddress=null) → subnet.status = "reserved"; per-IP → remains available
- No duplicate active reservations (unique constraint on subnetId, ipAddress, status="active")
- Subnet must not be deprecated (409 if status="deprecated")
- The taken-set for auto-allocate is EVERY active reservation regardless of `sourceType` — so a `vip`, an `interface_ip`, a lease and an infra row are all simply never offered as "available". Nothing filters by source type here, and nothing should: an address someone else answers on is not free.
- **Device-owned rows are read-only, and the guard lives in the ROUTE, not here.** A `vip` / `interface_ip` reservation cannot be edited or released from Polaris (`assertNotDeviceOwned` in `api/routes/reservations.ts`, 409). It is deliberately NOT a service-layer check, because discovery's own reconcile calls `releaseReservation` on exactly these rows when a VIP disappears from the gate — moving it down here would strand every retired VIP as an active reservation forever. Creating over one needs no new guard: neither type is in `isSupersedableByCreate`, so the collision check already 409s.
- **Contiguous is refused, never downgraded.** When no run of `count` consecutive free addresses exists, `findNextAvailableIps` throws 409 naming the largest run that does, rather than falling back to scattered addresses or returning a short list. A partial bulk allocation is not a success, and silently scattering defeats the reason an operator asked for a run.
- Push failure rolls back the Polaris reservation (fail-on-failure semantics)
- `listReservations` decorates every row with `pushEligible: boolean` (true when integration is fortimanager/fortigate AND `config.pushReservations === true` AND `ipAddress` is non-null) and strips the raw integration config from the response — callers only need the flag and config can carry credentials. Mobile reservations-tab reads this to color the Reserve button green.
- updateReservation accepts an optional `macAddress`; on push-eligible subnets a MAC change pushes a PUT to the FortiGate via reservationPushService.updatePushedReservation BEFORE the Polaris write — device-side failure throws and Polaris stays untouched. Clearing the MAC on a push-eligible subnet is rejected with 400 (DHCP reservations are MAC→IP).
- Both createReservation and updateReservation auto-stamp `owner` with the caller's username when the operator didn't type one (create: `input.owner || input.createdBy`; update: `input.owner === undefined` → actor). Pairs with the discovery sync's MAC-aware owner-preservation rule in `discoveryEngine.ts` `syncDhcpSubnets` Phase 6 — discovery only overwrites owner with `asset.assignedTo` when the discovered MAC differs from `reservation.macAddress`, so a Polaris-stamped owner survives across discovery cycles for stable reservations.
- Released reservations clear pushedTo* fields and drop historical released rows (unique constraint relief)
- `expireStaleReservations` applies the SAME unique-constraint relief for `expired`: inside one `$transaction` it first DELETEs (set-based `DELETE…USING` self-join) any stale `expired` row sharing (subnetId, ipAddress) with an active row about to expire, THEN runs the active→expired `updateMany`. Without the pre-delete a reserve→expire→re-reserve→expire cycle leaves a colliding `expired` row, and since the flip is one bulk updateMany a single P2002 aborts the whole batch (job fails every 15 min, nothing expires). NULL ipAddress (full-subnet) never collides (NULL distinct) and is excluded by the `=` join.
- Discovered dhcp_lease release attempts bestEffort via releaseDhcpLease (failure does not block Polaris release)
- Releasing a dhcp_reservation (non-pending) deletes the device-side reserved-address (unpushReservation — pinned ids for Polaris-pushed, resolve-by-CIDR/IP for discovered when pushReservations=true) AND drops the IP's active lease (releaseDhcpLease). Both best-effort; neither blocks the Polaris release.

**When changing this:**
- Test createReservation's push eligibility detection and MAC validation order
- Verify releaseReservation's transaction scope (unpush, lease release, subnet status reset)
- Check expireStaleReservations is called every 15 min via jobs/expireReservations.ts
- Audit the atomic create-and-push path for rollback edge cases (orphaned device entries)
- Exactly ONE top-level CRUD Event per mutation, in-service (route layer emits nothing) — `tests/integration/reservations.test.ts` asserts the contract. A queued release intentionally writes TWO rows (`reservation.released` top-level + `reservation.push.queued.released` detail) — historical behavior, preserved.

---

## services/networkScanService.ts

**What it owns:** The saved network **Discovery** (`NetworkScan`) — CRUD, validation, run dispatch, cancellation, target preview, adoption, and (since 2026-09) the private/public **visibility** scope. Owns the operator-facing caps (`MAX_SCAN_TARGET_ROWS` 50, `MAX_CREDENTIALS_PER_METHOD` 10, `MAX_ADOPT_PER_CALL` 500, `SCAN_RUN_STALE_MS` 3 min) and the `ScanAutoMonitor` shape (auto-monitor selection keyed by POLLING METHOD).

**Public API:** `listScans(viewerId)` / `getScan(id, viewerId)` / `getScanForWrite(id, viewerId)` / `createScan(input, viewer)` / `updateScan(row, input, viewer)` / `deleteScan`, `triggerScan(id, viewer)` / `cancelRun(runId, viewer)` / `getRun(runId, viewerId)` / `isScanRunning`, `previewTargets`, `adoptHits(runId, addresses, viewer)`, plus the pure `validateScanInput` / `assetTypeForHit` / `methodKeyForHit` / `normalizeVisibility` / `ownsScan` / `scanVisibleTo`. Note `updateScan` takes the ROW, not an id — the route has already loaded it to run its ownership check, and reading it twice is how the two would drift.

**Reads:** `NetworkScan`, `NetworkScanRun`, and (via `loadKnownAddresses` in the runner) `Asset.ipAddress` + `AssetAssociatedIp.ip`.

**Writes:** `NetworkScan` rows, `NetworkScanRun` rows (queued), `Asset` (adoption ONLY), and `network_scan.created|updated|deleted|cancel_requested|adopted` Events.

**Used by:** `src/api/routes/networkScans.ts` exclusively. The wizard (`public/js/assets-discovery.js`) talks to those routes.

**Invariants:**
- **Running creates nothing.** `triggerScan` writes a run row and hands it to a worker — no Asset, no AssetSource, no pin. That is what lets a `networkScan`-only role sweep a range, and it is why `adoptHits` is the single asset writer here (route-chained on `assets:write`).
- **`validateScanInput` lives here, not in the route.** An imported `.discovery.json` must pass the same checks, and the caps are properties of the feature. It EXPANDS the targets, so an over-cap CIDR is refused when typed rather than by a run that fails minutes later.
- **Dispatch mirrors `triggerDiscovery` exactly** — publish, else run in-process detached. pg-boss is NOT always on (`Setting.monitor.queueMode` defaults to cursor), so the fallback is mandatory rather than a nicety, and the route answers 202 either way.
- **Adoption re-checks inventory at ADOPT time**, not scan time: hours may have passed and another operator (or a discovery run) may have created the device. The in-loop `known.add(address)` additionally guards one call against a duplicate selection.
- **No `network-scan` sourceKind.** Assets are created like the manual `POST /assets` path so the `db.ts` extension mints the `manual` AssetSource row; `projectAssetFromSources` has zero rules for a kind outside its union, so a scan-kind row would project nothing while `projectionDriftService` compared projection against the stored row.
- **Pins resolve through the SAME pure resolvers** the integration auto-monitor pass uses (`resolvePinnedInterfaces` → `splitPinsByProvenance`, `resolvePinnedStorage`), against the inventory the scan collected — so a selection means the same thing here as on the Integrations tab.
- `ScanAutoMonitor` is keyed by polling METHOD because what can be pinned depends on what answered; one flat selection would mean something different per group.
- `assetTypeForHit` is deliberately shallow — only a device saying what it is in as many words gets a type. Guessing from a vendor name is right often enough to look correct and wrong the rest of the time.
- `deleteScan` refuses while a run is in flight (a stalled heartbeat does not count as in flight); the run rows cascade, being history OF this Discovery.
- **Visibility is the service's job; ownership is the route's** (business rule 34g). Every by-id read goes through `loadVisible` → `assertScanVisible`, which throws **404, not 403** — a private Discovery's name is a site name. Owner-or-fullwrite for EDIT/DELETE lives in `networkScans.ts` because it needs `req.permissionLevel`, which the service has no access to.
- **`triggerScan` checks visibility, never ownership.** Running somebody else's SHARED Discovery is the entire point of publishing one; gating the run on ownership would make the feature do nothing.
- **A run inherits its Discovery's visibility** (`loadVisibleRun`, used by `getRun` / `cancelRun` / `adoptHits`). The hits ARE the recon material, so a run id must not be a way around a private row.
- **`normalizeVisibility` fails closed** — anything that is not literally `"public"` is private, so a typo, a half-applied migration or a future third value can never open a Discovery up.
- **A NULL `ownerId` is owned by NOBODY** — in particular not by the next caller who also has no id, which is how a bearer token would otherwise have inherited every orphan. Two consequences guard the "a row nobody can see is a row nobody can fix" case: a viewer with no id may not create a PRIVATE Discovery, and an orphan may not be made private.
- **Names are unique per OWNER** (`assertNameFree`), checked against the ROW's owner on update so an admin editing someone else's Discovery can't collide it with their own.

**When changing this:**
- Keep `validateScanInput` the single authority for semantics — the route's Zod is shape only, and the import path has no route at all.
- If adoption grows a field, check it against the manual `POST /assets` create rather than inventing a second convention, and do NOT add an AssetSource kind without also adding projection rules (see the invariant above).
- Never widen the adopt route to a single gate. "May scan" and "may create assets" being separable is the reason the `networkScan` key exists.
- Any NEW by-id read or run-scoped verb must go through `loadVisible` / `loadVisibleRun` rather than a bare `findUnique`. That is the only thing keeping a private Discovery private, and a bare read fails open.
- Do NOT move publishing to `fullwrite` to match saved filters/dashboards. Those mounts sit at `read` and spend `write` on the publish; this one is already at `write` for any change, and `networkadmin` / `assetsadmin` hold `write` — the escalation would put sharing out of reach of the roles that author Discoveries.
- Keep `visibility` out of the `.discovery.json` export (`stripForExport` whitelists fields, so this holds by construction). It is an ownership fact about one install; an import lands private.

---

## services/networkScanRunner.ts

**What it owns:** Execution of ONE network **Discovery** (business rule 34) — expand the operator's targets, subtract what inventory already has, ICMP for liveness, then the enabled methods in the operator's order for identification. Owns the run row's transitions (`running` → `completed` / `aborted` / `error`), its counters, its heartbeat, and the `hits` blob the wizard's Results step reads. Owns the pacing constants (`SCAN_PING_CONCURRENCY` 64 / `SCAN_PING_TIMEOUT_MS` 1500 / `SCAN_IDENTIFY_CONCURRENCY` 12 / `SCAN_WALK_MAX_ROWS` 800 / `SCAN_MAX_HITS` 2000 / `SCAN_PROGRESS_FLUSH_MS` 2000) — constants rather than env vars because a Discovery is an explicit, cancellable, progress-visible action with no steady-state tuning problem.

**Public API:** `runScan(runId, actor)` (never throws — a failed run is a `status:"error"` row, because the row IS the wizard's view of it), `identifyAddress(address, methods, creds, opts)` (the per-address method/credential cascade; returns null when nothing answered), `parseStoredTargets` / `parseStoredMethods` (JSON-column normalizers), `loadKnownAddresses`, `SCAN_METHODS`, and the pacing constants. Types `ScanMethod` / `ScanMethodType` / `ScanHit`.

**Reads:** `NetworkScan` + `NetworkScanRun` (its own row), `Asset.ipAddress` + `AssetAssociatedIp.ip` (the known-address set — note the column on that table is `ip`, not `ipAddress`), `Credential` via `credentialService.getCredential(id, {revealSecrets:true})`.

**Writes:** `NetworkScanRun` (counters / status / hits / heartbeat), `NetworkScan.lastRunAt`, and `network_scan.started|completed|aborted|error` Events. **Creates no assets** — adoption is a separate operator action on a separate route with `assets:write` chained.

**Depends on:** `utils/cidr.expandScanTargets` (all IP math lives there), `utils/icmpPing.pingHost`, `utils/concurrency.mapSettledWithConcurrency` (the ONE bounded mapper — do not hand-roll a sixth), `monitoringService.probeCredentialAgainstHost` + `snmpWalkRaw`, `utils/snmpIdentity` (which itself reads `utils/snmpDescrIdentity` for the vendors whose sysDescr layout is documented — adding a vendor there is what gives a hit a `model` / `osVersion`, and `adoptHits` writes both), `utils/snmpInventory`.

**Invariants:**
- **Nothing calls `withSnmpGate` here, and that is correct** — both `probeCredentialAgainstHost("snmp")` and `snmpWalkRaw` acquire the per-(host, port) gate internally, so the scan already FIFOs behind the monitor loop on any host Polaris polls. Wrapping again would deadlock against a gate the callee also wants.
- **Known addresses are subtracted BEFORE any packet.** "New addresses only" means the scan has no reason to touch a device Polaris already knows; not probing it is cheaper and quieter, and `skippedKnownCount` is what keeps "nothing new" distinguishable from "nothing there".
- **The operator's method order is a PRIORITY order.** The first method that answers with a credential owns the identity; later methods record that they answered but never overwrite it. Credentials within a method stop at the first success.
- **An address that answered something keeps the other methods' failure reasons** (`ScanHit.errors`) — "answered ICMP, refused every community" is the most common shape and names the credential to fix. A method with no credential says so rather than reading as silent.
- A per-address failure is a recorded nothing, never an aborted sweep; a failed WALK costs detail, never the responder.
- **The counters mean ONE thing for the whole run.** `totalTargets` is the address count after exclusions, written once and never rewritten; `scannedCount` counts addresses FULLY processed so it rises monotonically to `totalTargets`; `hitCount` counts responders. That matters because the two stages cover different sets: a dead address is fully processed the moment its ping fails, a live one only after identification, so stage 1 counts the dead and stage 2 counts the live. An earlier shape re-pointed the counters at the identification pass — resetting `totalTargets` to the live count — which made the wizard's "N of M" jump backwards mid-run and left a sweep where nothing answered reading "0 of 0 scanned" after covering a whole /29 (caught by an end-to-end run, not by a test).
- **Progress is throttled** (`SCAN_PROGRESS_FLUSH_MS`), and the cancel check rides the same tick — a /16 must not become 65k UPDATEs plus 65k SELECTs on a row the wizard polls every 2s.
- The cancel clock is **per run**, not module-scope: two concurrent Discoveries must not share it.
- `hits` is capped at `SCAN_MAX_HITS` with a **loud** warn — a silently truncated responder list would read as a smaller network.

**When changing this:**
- Scale-check at both ends: a /29 (6 addresses) and the `SCAN_MAX_TARGETS` ceiling of 65536. The ping stage's concurrency is what decides whether a /16 of empty space takes ~25 minutes or four hours; the identify stage's is what decides how loud the scan is.
- If a new method is added, add it to `SCAN_METHODS`, to `probeCredentialAgainstHost`'s union, and to the wizard's step 3 — and decide whether it can supply an identity (only SNMP does today).
- Never make the runner create or update an Asset. Adoption is `networkScanService` + a route chaining `assets:write`; keeping the sweep read-only is what lets a `networkScan`-only role run it.

---

## services/arpPrimeService.ts

**What it owns:** The ARP-priming presence sweep — fire-and-forget UDP datagrams at reserved IPs so a FortiGate is forced to ARP-resolve each target right before discovery reads its ARP table. Owns the sweep constants (port 33434, batch 256 / pause 25ms, cap 4096, `ARP_SETTLE_MS` 2s). Sends packets; never reads or writes the DB.

**Public API:** `planSweepBatches(ips, batchSize?, maxTargets?)` (pure: dedupe / IPv4-validate / cap / chunk), `primeArpCache(ips)` (paced send, never throws), `ARP_SETTLE_MS`, `ARP_SWEEP_PORT`, `ARP_SWEEP_BATCH_SIZE`, `ARP_SWEEP_MAX_TARGETS`.

**Used by:** `fortimanagerService.discoverDhcpSubnets` Step 3d.54 (proxy mode, per-device, targets from the `arpSweepTargets` map param) and `fortigateService.discoverDhcpSubnets` Chain D Step 3e.54 (standalone + FMG-direct, targets from `FortiGateConfig.arpSweepIps`). Targets are built by `buildArpSweepTargets` in `src/services/discovery/discoveryEngine.ts` (active dhcp_reservation IPs grouped per FortiGate device) only when `Integration.config.arpPresenceSweep === true`.

**Invariants:**
- Fire-and-forget: no replies expected, per-datagram errors swallowed, function never throws — a failed sweep degrades to "no priming," never blocks discovery
- Per-gate targeting only (each FortiGate is swept with its own subnets' reserved IPs immediately before ITS table read) — never a fleet-wide blast; FortiOS GCs unreferenced neighbor-cache entries in ~60–90s so sweep → settle → read must stay contiguous
- Callers await the send (socket close drops queued datagrams behind the implicit bind) and then settle `ARP_SETTLE_MS` before the ARP query
- Over-cap overflow is logged (never silent); malformed/non-IPv4 entries are skipped silently (never sweepable)
- Opt-in per integration (default off — IDS-visible traffic); the Phase 7.6 lastSeenArp stamping is NOT gated by the toggle (passive ARP bindings are equally valid evidence)

**When changing this:**
- Keep the settle window well inside the FortiOS neighbor-cache GC window (~60s floor) — if you raise `ARP_SETTLE_MS`, remember proxy-mode FMG devices serialize, so N devices pay N × settle per cycle
- Scale-check pacing at 2000+ reservations per gate (batch × pause math) and confirm the socket send path stays awaited before close
- If sweep targets gain a new source, keep the per-gate grouping — a global sweep at discovery start ages out before late devices' reads

---

## services/reservationStaleService.ts

**What it owns:** Stale DHCP-reservation detection, alerting, and alert management (snooze, ignore) — including the lifecycle audit Events (`reservation.stale-settings.updated` / `reservation.stale.snoozed` / `reservation.stale.ignored` / `reservation.stale.unignored`), emitted in-service with the route passing `actor`.

**Public API:** getStaleSettings, updateStaleSettings, listStaleReservations, snoozeReservation, setStaleIgnored, flagStaleReservations.

**Used by:** src/api/routes/reservations.ts (list/snooze/ignore endpoints), src/jobs/flagStaleReservations.ts (flagStaleReservations every 6 hours).

**Reads (cross-signal):** Asset.lastSeen, AssetMacAddress.mac, AssetAssociatedIp.ip — `buildAssetPresenceResolver` correlates each candidate reservation to an Asset (MAC first via `normalizeMacOrNull`, then IP) so a statically-addressed device that never pulls a DHCP lease but is still on the network is NOT flagged stale. Three batched, indexed findMany calls per scan (bounded by candidate-reservation count); no per-row queries. Also reads `Reservation.lastSeenArp` — written by `syncDhcpSubnets` Phase 7.6 (discoveryEngine.ts) when the owning FortiGate's ARP table binds the reserved IP to the reserved MAC; the opt-in `Integration.config.arpPresenceSweep` toggle makes `arpPrimeService` prime the gate's ARP cache (per-gate UDP sweep) right before each table read so ICMP-silent static devices resolve too.

**Invariants:**
- Stale threshold (staleAfterDays) defaults to 60 days, 0 = disabled
- Cold-start grace: effective baseline = max(createdAt, detectionStartedAt) to avoid flooding on first run
- Effective last signal = freshest of {lastSeenLeased, lastSeenArp, matched Asset.lastSeen}; baseline is a fallback used only when NONE exists (not a floor — a real but old signal still flags during cold-start)
- lastSeenArp is stamped only on an exact (device, ip, MAC) match — a different MAC answering the reserved IP is not presence; absence of an ARP entry is never negative evidence (sweep reach depends on routing + firewall policy)
- A row is stale if effectiveLastSignalMs < (now − threshold) AND (threshold > 0)
- Active list/count exclude reservations on DEPRECATED subnets (decommissioned-firewall networks) via `where.subnet.status != "deprecated"`; the ignored review list is NOT filtered by subnet status
- MAC correlation wins over IP (DHCP reservations are MAC→IP, the stable identity); entry carries assetLastSeen + assetPresenceMatch ("mac" | "ip" | null)
- Snooze extends alert by staleAfterDays from now (not from threshold); clears staleNotifiedAt
- Ignored rows stay suppressed regardless of threshold; detectionStartedAt persists across runs
- flagStaleReservations emits one reservation.stale Event per fresh transition (staleNotifiedAt null → timestamp)
- Discovery clears staleNotifiedAt on re-sighting (re-arms alert for future silence) — both the lease path (Phase 5) and the ARP path (Phase 7.6) clear staleNotifiedAt + staleSnoozedUntil

**When changing this:**
- Verify staleAfterDays threshold propagates to all callers (threshold=0 should disable all alerts)
- Test cold-start grace window (rows pre-dating detectionStartedAt get full threshold window)
- Check flagStaleReservations only fires on active dhcp_reservation rows (not discovered dhcp_lease)
- Audit snooze idempotency: repeated snooze clicks should extend from "now" not from prior snooze
- effectiveLastSignalMs is pure + exported — extend its unit test when changing evidence precedence
- Keep the presence resolver batched (no per-row asset lookups) — scale-check at 2000 assets

---

## services/dnsResolvedReservationService.ts

**What it owns:** Auto-creation, update, and release of `sourceType="dns_resolved"` Reservation rows that mirror Assets whose primary `ipAddress` isn't covered by an authoritative reservation. Plays no part in DHCP push, conflict raising, or asset writes themselves — strictly a downstream observer of the Asset table.

**Public API:** `reconcileDnsResolvedForAsset(assetId)`, `reconcileDnsResolvedForAllAssets()`, `releaseDnsResolvedForAsset(assetId)`, `releaseDnsResolvedAt(subnetId, ipAddress)`, `ReconcileResult` interface.

**Used by:** `src/db.ts` Prisma extension (per-asset reconcile on create/update/upsert; release on delete); `src/jobs/reconcileDnsResolvedReservations.ts` (periodic sweep); `src/services/discovery/discoveryEngine.ts` `syncDhcpSubnets` + `src/api/routes/integrations.ts` `registerFortinetHost` (inline `releaseDnsResolvedAt` before each authoritative create); `src/services/reservationService.ts:createReservation` (same inline release for manual creates).

**Invariants:**
- `sourceType="dns_resolved"` + `createdBy="system:dns-resolved"` is the system-actor signature — both are required to identify a row as system-owned.
- Identity match for "is this asset's existing row?" = `createdBy=SYSTEM_ACTOR AND sourceType=dns_resolved AND status=active AND (macAddress=asset.macAddress OR hostname=asset.hostname)`. Reservation has no `assetId` FK so this is the proxy.
- Eligible asset statuses: `active | maintenance | storage | quarantined`. `decommissioned | disabled` always release-without-creating.
- IPv4 only (gated by `detectIpVersion(ip) === "v4"`).
- Defers silently to ANY non-released non-dns_resolved active reservation at the same `(subnetId, ipAddress)`. Never raises a Conflict.
- Never pushes to FortiGate — writes go through `prisma.reservation.create` directly, not `reservationService.createReservation`.
- All public functions are best-effort: they log at warn and never throw out of the public surface so a transient DB error can't break the asset write that called them.
- Events emitted: `reservation.dns_resolved.created`, `reservation.dns_resolved.updated`, `reservation.dns_resolved.released` (info level).

**When changing this:**
- Adding a new authoritative `sourceType`? Add a `releaseDnsResolvedAt(subnetId, ip)` call in `discoveryEngine.ts` next to the new create, and (if it can be created from the manual UI) in `reservationService.createReservation`. The activeResMap exclusion already covers the discovery read path.
- Adding a new column to the eligibility check? Update `assetEligible()` and ensure the periodic job's `findMany` scope still surfaces rows that need release-without-create. The job intentionally scans even ineligible-by-status assets so they can release stale rows.
- Switching to a real `Reservation.assetId` FK? Replace `findOwnedSystemRows`'s identity-match SQL with a direct join, and the per-asset reconcile becomes trivially correct (no more "hostname or MAC" heuristic).
- Verify the unique-on-active constraint: create an authoritative reservation at an IP that has a dns_resolved row; the release MUST run before the create (the order matters — Postgres can't have two active rows at the same `(subnetId, ipAddress)`).
- Performance check at 2000 monitored assets: the periodic sweep should complete in seconds. If it slows, raise BATCH from 25; the inner work is one `findContainingSubnet` + one upsert per asset, both index-friendly.

---

## services/subnetRefreshService.ts

**What it owns:** Per-subnet "refresh from device" reconciler — the action behind the **Refresh** button in the IP panel slide-in. Queries the originating FortiGate for ONE DHCP scope (CMDB reservations + live leases), reconciles against Polaris's `dhcp_reservation` + `dhcp_lease` rows on the same subnet, and bumps `Subnet.lastDiscoveredAt`. Manual / VIP / interface-IP rows are left alone.

**Public API:** refreshSubnet(subnetId, actor) → { lastDiscoveredAt, created, updated, released, skipped }.

**Cross-service deps:** reservationPushService (buildTransportForIntegration, findScopeIdForCidr, listReservedAddresses, callFortiOs, normalizeMac), events.logEvent.

**Used by:** src/api/routes/subnets.ts (POST /subnets/:id/refresh route handler — user-or-above).

**Invariants:**
- Only works on subnets whose `discoveredBy` integration is type fortimanager or fortigate, AND `fortigateDevice` is set; 400 otherwise.
- CMDB reservations win on overlap with a live lease for the same IP (matching syncDhcpSubnets' source-of-truth ordering).
- Manual / VIP / interface-IP rows on the same subnet are skipped — the next full integration discovery is where Polaris raises hostname/owner conflicts on those rows via upsertConflict.
- Releases dhcp_*-sourced active rows whose IPs are no longer on the device (operator removed them on the FortiGate). Does NOT touch reservations on other subnets.
- Bumps `Subnet.lastDiscoveredAt` only on success (so the IP panel's "Discovered N minutes ago" updates).

**When changing this:**
- Keep the scope narrow: don't reach into asset sightings / decommissions / map regions — those are owned by `syncDhcpSubnets` and reconcile on the next full integration cycle.
- If the read shape from FortiOS `/api/v2/monitor/system/dhcp` changes, update both `fetchLiveLeasesForScope` here AND the corresponding shape in fortimanagerService.ts / fortigateService.ts so the partial refresh and full discovery stay in sync.
- Description-to-hostname extraction (`extractHostnameFromDescription`) is the inverse of `buildDescription` in reservationPushService — keep them paired.

---

## services/subnetArchiveService.ts

**What it owns:** Retiring a subnet into the archive tables (business rule 41) — the `ArchivedSubnet` / `ArchivedReservation` writes, the `subnet.archived` Event, and the two review reads.

**Public API:** `snapshotSubnet(subnetId, {reason, actor}, tx?)` (COPY only — live rows untouched; accepts a transaction client so the chassis-replacement path archives and re-points in one commit), `archiveSubnet(subnetId, {actor, reason?})` (snapshot + DELETE the live subnet), `getArchivedSubnet(id)`, `listArchivedSubnets(filter)`, `ArchiveReason`, `SnapshotResult`.

**Cross-service deps:** eventLogService (`subnet.archived`), utils/chunk (`chunkArray`).

**Used by:** `src/api/routes/subnets.ts` (`GET /subnets/archived`, `GET /subnets/archived/:id`, `POST /subnets/:id/archive` — surfaced as **Archive** in the Networks row menu, `public/js/subnets.js:confirmArchiveSubnet`), `src/services/discovery/discoveryEngine.ts` (BOTH entry points: `snapshotSubnet` from the Phase 1 chassis-replacement pass, and `archiveSubnet` from the create path when a live gate re-reports a DEPRECATED row's range), `src/services/subnetChassisConflictService.ts` (`getArchivedSubnet` for the diff's old side).

**Invariants:**
- **`archiveSubnet` is what frees the CIDR.** A `deprecated` row still holds `@@unique([blockId, cidr])`; moving it OUT is the entire point. `tests/integration/subnetArchive.test.ts` pins BOTH halves — that a deprecated row still 409s a same-CIDR create, and that archiving lets it through.
- **Discovery calls it too, and that path is the one that matters in practice.** Phase 1 retires a dead row when a DIFFERENT gate re-reports its range; `tests/integration/subnetSupersedeDeprecated.test.ts` drives the REAL `syncDhcpSubnets` for it, because the bug that shipped lived entirely in the wiring — `classifyDeprecatedSupersede` was correct and simply unreachable, which no unit test could have caught.
- **`snapshotSubnet` is additive and must stay so.** The chassis-replacement path calls it on an automatic detection; deleting or releasing anything there would make a false positive cost data.
- **No FKs out of the archive to `ip_blocks` or `integrations`.** `Subnet.block` is `onDelete: Cascade`, so an FK would let deleting a block erase the archive. Block/integration identity is denormalized (`blockCidr`/`blockName`/`integrationName`) instead — the `DirectoryContactSource.integrationId` reasoning.
- **Push POINTERS are never copied** (`pushedScopeId`/`pushedEntryId`/`pushedToId`). They address an entry inside a scope on a chassis that no longer exists; a future restore or unpush carrying them forward would aim a delete at whatever now occupies those ids on a different box. Push STATE (`pushStatus`/`pushedAt`) is kept.
- **Business rule 4's active-reservation protection deliberately does NOT apply.** It guards against accidental destruction; this preserves everything it moves.
- **Not a retention entity.** Nothing prunes these tables, by design.
- Reservation copies go through `createMany` in `COPY_CHUNK` batches — never a per-row await (a /16 scope can hold a lot).

**When changing this:**
- Adding a column to `Reservation` that a reviewer would want? Add it to `RESERVATION_SELECT` **and** `ArchivedReservation` — the copy is explicit, not a spread, so a new column is silently dropped otherwise.
- If a RESTORE path is ever added, it must not resurrect push pointers (they aren't stored) and must refuse when the CIDR is occupied in that block.
- Keep `snapshotSubnet` transaction-capable; the discovery path depends on it.

---

## services/subnetChassisConflictService.ts

**What it owns:** The `chassis-replaced` Conflict flavour (business rule 41) — the first and only `entityType="subnet"` variant. Raise/refresh/suppress, the per-address diff, and the accept/reject handlers plus their `subnet.chassis.adopted` / `subnet.chassis.dismissed` Events.

**Public API:** `raiseChassisReplacedConflict(input)` → `"raised" | "refreshed" | "suppressed"`, `buildChassisDiff(conflict)`, `diffReservationLines(oldRows, newRows)` (pure), `notMigratableReasonFor(sourceType)` (pure), `migrateArchivedReservations(conflict, ips, opts)`, `acceptChassisReplacement`, `rejectChassisReplacement`, `listChassisConflicts`, `CHASSIS_REPLACED_COLLISION_REASON`, `MIGRATABLE_SOURCE_TYPES`, and the `ChassisReplacedPayload` / `DiffSide` / `ChassisDiffLine` / `LineVerdict` / `NotMigratableReason` / `MigrateOutcome` types.

**Cross-service deps:** subnetArchiveService (`getArchivedSubnet`), reservationService (`DEVICE_OWNED_SOURCE_TYPES`), reservationPushService (`integrationPushEnabled`), utils/chassisIdentity (`normalizeSerial`), utils/chunk (`chunkArray`), eventLogService.

**Used by:** `src/services/discovery/discoveryEngine.ts` (raise, from the Phase 1 pass), `src/services/conflictResolutionService.ts` (the `entityType === "subnet"` branch of `acceptConflict` / `rejectConflict`), `src/api/routes/conflicts.ts` (`GET /conflicts/:id/chassis-diff`, `POST /conflicts/:id/migrate-reservations`).

**Invariants:**
- **Dedup is keyed on the (oldSerial, newSerial) PAIR, not the subnet.** A pending row for the same pair refreshes, a REJECTED row for the same pair suppresses, and a different pair — the box swapped twice — raises anew.
- **Raising never re-points `Subnet.fortigateSerial`.** The pending conflict is the unresolved state, and the stored serial is what keeps the detection derivable from the subnet row rather than dependent on the conflict row surviving. `acceptChassisReplacement` is what moves it; `verdictWritesSerial` returns null for `replaced` to enforce the same thing on the discovery side.
- **The diff is computed ON READ, never snapshotted.** Discovery syncs subnets in Phase 1 and reservations in Phases 3–5, so a payload built at detection time would compare the old chassis against itself.
- **Only `manual` and `dhcp_reservation` are migratable** (`MIGRATABLE_SOURCE_TYPES`) — the two source types that represent an assignment somebody MADE and the new box is missing. The three refusals carry DISTINCT reasons and must not be collapsed: `device-owned` (`vip`/`interface_ip`, from the shared `DEVICE_OWNED_SOURCE_TYPES` — the new gate's own config states them), `observed` (`dhcp_lease`/`dns_resolved` — a sighting is not an assignment), `device-managed` (the four Fortinet infra types — still on the wire, re-discovered within a cycle, and migrating fights rule 23). Refused lines are still returned by the diff, because hiding one leaves an operator hunting for an address they remember.
- **A colliding address is UPDATED, never inserted.** `@@unique([subnetId, ipAddress, status])` makes an insert at a live address a constraint violation, so `same`/`differs` lines update the live row in place — which is also what "overwrite old onto new" means.
- **Every migrated row lands `manual` with `dhcpBinding: null`.** Only a `manual` row is pushable (discovery flips it to `dhcp_reservation` once it sees it on the device), and with push off the claim is Polaris's alone — rule 23's split, stated exactly.
- **The push is QUEUED, never inline** (`pushStatus: "pending"` + `pushQueuedAt`, drained by `retryQueuedReservationPushes`), and the dead chassis's push POINTERS are never carried. A freshly-installed gate is the device most likely to be briefly unreachable; a migrate must not fail on that.
- **Migrating does not close the conflict.** An operator migrates in passes, so the diff has to stay reachable; `adopt: true` on the route runs the normal accept alongside.
- **The dispatcher owns the conflict's status.** These handlers must NOT stamp `status`/`resolvedBy`/`resolvedAt` — `conflictResolutionService.acceptConflict`/`rejectConflict` do it after every handler returns, as for the reservation and asset variants.
- Raise refuses equal or blank serials outright, so a caller cannot manufacture a self-conflict.

**When changing this:**
- Adding a compared field to the diff? It goes in `COMPARED_FIELDS`, and `tests/unit/chassisDiff.test.ts` has a table-driven case per field — extend it.
- A second `entityType="subnet"` flavour must add its own `collisionReason` and its own branch in the two dispatchers; `CHASSIS_CONFLICT_WHERE` filters on the reason, not the entity type alone.
- Adding a source type to `MIGRATABLE_SOURCE_TYPES` is a claim that the new gate is MISSING an assignment somebody made — check it against the three refusal reasons first, and extend the table-driven cases in `tests/unit/chassisDiff.test.ts`.
- The carried-field list is spelled out inline in `migrateArchivedReservations` (`hostname` / `owner` / `projectRef` / `notes` / `macAddress` / `expiresAt`), deliberately not a spread of the archived row — a spread would carry `status` and the push columns too. A new operator-meaningful `Reservation` column has to be added there by hand.

---

## services/subnetExclusionService.ts

**What it owns:** The exclusion registry (business rule 42) — `SubnetExclusion` CRUD, the `subnet.exclusion.created` / `.updated` / `.deleted` Events, and `assertNotExcluded`, the 409 every subnet-creating path meets.

**Public API:** `listExclusions()` (rows decorated with the live networks each covers), `loadExclusions()` (bare — THE read for enforcement paths), `loadExclusionsOverlapping(scopeCidr)`, `assertNotExcluded(cidr, known?)`, `createExclusion`, `updateExclusion` (name/notes only), `deleteExclusion`, plus the `SubnetExclusionRow` / `SubnetExclusionDto` / `ExclusionMatch` types.

**Cross-service deps:** eventLogService, utils/cidr (`isValidCidr` / `normalizeCidr` / `detectIpVersion`), utils/subnetExclusion (the pure containment half).

**Used by:** `src/api/routes/subnets.ts` (`GET|POST /subnets/exclusions`, `PUT|DELETE /subnets/exclusions/:id`), `src/services/subnetService.ts` (`assertNotExcluded` inside `createSubnetRowChecked`; `loadExclusions` + `exclusionsOverlapping` in `allocateNextSubnet` / `bulkAllocate` / `previewBulkAllocate`), `src/services/discovery/discoveryEngine.ts` (reads `prisma.subnetExclusion` directly into its own per-run Promise.all and matches with `findCoveringExclusion` — Phases 1 and 2), `public/js/subnets.js` (the Networks → Exclusions dialog).

**Invariants:**
- **`createSubnetRowChecked` is the single enforcement seam for creation.** Manual create, auto-allocate, bulk allocate and the discovery create all pass through it, which is what makes "an excluded CIDR is never added to the networks list" true of all of them from one check. A new subnet-creating path that bypasses that seam bypasses this too — the same trap business rule 20a describes for the overlap lock.
- **Excluded space is TAKEN space to an allocator, never a refusal.** `allocateNextSubnet` / `bulkAllocate` / `previewBulkAllocate` append the overlapping exclusions' CIDRs to the taken list handed to `findNextAvailableSubnet` / `packIntoAnchor`, so the allocator steps over the range. A caller asking for "any free /N" must not get a 409 naming an exclusion — that turns a policy into an obstacle the operator has to notice and route around. The preview must use the SAME list as the write, or it shows a plan the write then refuses.
- **Containment is one-directional and lives in `utils/subnetExclusion`.** An exclusion covers itself and anything narrower; a WIDER discovered CIDR is not excluded (excluding one /24 must not swallow a /8). The allocator's question is different and uses plain overlap. Never collapse the two.
- **Adding an exclusion destroys nothing.** Live networks it covers are reported (`matchCount` / `matches`) and left in place; retiring one stays `subnetArchiveService.archiveSubnet`. A config write must not delete address-space records as a side effect.
- **`cidr` is the identity and is frozen after create.** `updateExclusion` accepts name/notes only and the route schema carries no `cidr` — re-pointing an exclusion in place would silently un-exclude the space the operator excluded. Changing the range is a delete plus an add.
- **Discovery skips a covered entry WHOLE, not just the create.** The conflict this feature exists to stop (rule 41's `chassis-replaced`, raised because every site's gate reports a different serial for the shared row) comes from the UPDATE side, so the Phase 1 skip sits ABOVE the existing-row branch. Phase 2's stale sweep skips them too: their `fortigateDevice` is frozen at whichever site claimed the row first.
- **IPv4 only**, refused at the door. The containment math is netmask-backed, so a stored v6 exclusion would match nothing while looking like it worked.
- Mutations are gated `subnets:fullwrite`, reads `subnets:read` — the `POST /subnets/:id/archive` reasoning: an exclusion is fleet-wide and covers discovered rows whose `createdBy` is null, so the ownership-aware `write` tier could never be the right gate.

**When changing this:**
- Adding a subnet-creating path? Route it through `createSubnetRowChecked` (or call `assertNotExcluded` yourself) — and pass an already-loaded exclusion list where the path is a loop, the way discovery does, so the check costs no read per row.
- Making exclusions per-block would defeat the feature: the CIDR needs excluding precisely because several sites serve it.
- If a "retire the networks this covers" action is ever added, it belongs on the exclusion's own row as an explicit verb — not on create.
- `tests/integration/subnetExclusions.test.ts` pins the four load-bearing claims (seam refuses, allocators skip, existing rows survive and are counted, CIDR frozen); `tests/unit/subnetExclusion.test.ts` pins the containment asymmetry.

---

## services/subnetService.ts

**What it owns:** Subnet creation, allocation, bulk templates, and lifecycle (manual vs discovered), plus the `subnet.created` / `subnet.updated` / `subnet.deleted` / `subnet.bulk-allocated` audit Events (emitted in-service; inputs carry `actor?`, and `via: "auto-allocate"` discriminates the allocateNextSubnet message from a manual create).

**Public API:** listSubnets, getSubnet, createSubnet, allocateNextSubnet, bulkAllocate, previewBulkAllocate, updateSubnet, getSubnetIps, deleteSubnet, buildIpContexts + IpContext (batched IP → most-specific containing subnet + active-reservation summary; THE single implementation of the `cidr >>= ip` / `masklen DESC` containment SQL).

**Cross-service deps:** ipService (indirectly via cidrContains/cidrOverlaps from utils/cidr.ts), subnetExclusionService (`assertNotExcluded` inside `createSubnetRowChecked`; `loadExclusions` + `exclusionsOverlapping` in the two allocators — business rule 42).

**Used by:** src/api/routes/subnets.ts (all operations), src/api/routes/assets.ts (buildIpContexts — per-row `ipContext` for the asset table's View Lease button), src/services/dnsResolvedReservationService.ts (buildIpContexts — target-subnet resolution in the reconciler), src/services/ipContextService.ts (buildIpContexts — the containing network behind the Add Asset IP cross-reference; deliberately reuses this rather than re-implementing the `cidr >>= ip` / `masklen DESC` query), src/services/reservationService.ts (subnet lookups, status checks), src/services/utilizationService.ts (subnet status grouping).

**Invariants:**
- Subnet must be contained within parent block CIDR
- No overlapping sibling subnets in the same block (checked before create)
- IPv4-only for auto-allocation (allocateNextSubnet, bulkAllocate)
- Subnet status = "deprecated" rejects new reservations — but it does NOT release the CIDR. A deprecated row still holds `@@unique([blockId, cidr])` and is still counted by `createSubnetRowChecked`'s overlap re-read, while discovery's `subnetByCidr` index skips it: no update path and no create path, so the address space becomes unrecordable rather than reusable. Retiring a subnet so its CIDR can be re-used is `subnetArchiveService.archiveSubnet`, not a status change (business rule 41)
- Full-subnet reservation (ipAddress=null) sets subnet status → "reserved"
- Prefix length must be [8, 32] for IPv4
- **First-claim parity (discovery side, lives in `src/services/discovery/discoveryEngine.ts` syncDhcpSubnets Phase 1):** when a discovery cycle's CIDR matches a manual subnet (`existing.discoveredBy == null`), the row gets brought into parity with a freshly-discovered subnet — `name` rewritten to `DHCP: <scope> (<fortigate>)`, `status` reset to `available`, `tags` union-merged with `["dhcp-discovered", <integrationType>]`, `purpose` stamped only when blank. Subsequent passes see `discoveredBy` set and skip the claim branch (operator can rename/retag after claim and edits survive). One `subnet.claimed` Event per first-claim.

**When changing this:**
- Test allocateNextSubnet's findNextAvailableSubnet logic (concurrent allocations must not race)
- Verify bulkAllocate's anchor-aligned packing (all-or-nothing transaction)
- Check updateSubnet does not allow status changes that violate reservation constraints
- Review overlapping-sibling check performance for large blocks
- **`createSubnetRowChecked` is also where the exclusion list is enforced** (business rule 42), for the same reason the overlap lock lives there: it is the one seam manual create, auto-allocate, bulk allocate and the discovery create all pass through, so one check covers every path. Its `opts.exclusions` escape hatch exists so a loop that already loaded the set (discovery, once per run) pays no read per created subnet. The two ALLOCATORS treat excluded ranges as taken space instead — appended to the list handed to `findNextAvailableSubnet` / `packIntoAnchor` — because a caller asking for "any free /N" must be stepped past an exclusion, not refused by it; `previewBulkAllocate` must build that list identically or the preview shows a plan `bulkAllocate` rejects
- **`createSubnetRowChecked`'s sibling re-read is status-BLIND on purpose** — it counts deprecated rows, which is what makes them block a same-CIDR create. Do not add a status filter to make room for a replacement subnet; that is the archive's job, and filtering here would leave two live rows racing the unique index instead
- **bulkAllocate's single `subnet.bulk-allocated` Event must stay AFTER the `$transaction` resolves** (an event from inside would be a phantom on rollback), and the per-subnet `tx.subnet.create` calls must stay event-free — `tests/integration/subnets.test.ts` asserts one-bulk-event + zero-per-subnet-events. allocateNextSubnet delegates to createSubnet, so it must keep passing `via: "auto-allocate"` rather than emitting its own event.

---

## services/utilizationService.ts

**What it owns:** Aggregates subnet usage statistics (blocks, subnets, reservations) for dashboards.

**Public API:** getGlobalUtilization, getBlockUtilization, getRecentManualReservations.

**Used by:** src/api/routes/utilization.ts (GET / for dashboard, GET /blocks/:id for per-block drill-down). `src/api/routes/dashboard.ts` (`/dashboard/summary` consumes `getGlobalUtilization` for `blockUtilization` and `getRecentManualReservations` for `recentReservations`).

**Invariants:**
- Global utilization counts all blocks, subnets, and active reservations in one query set
- IPv6 block addresses capped at Number.MAX_SAFE_INTEGER to avoid precision loss
- Deprecated subnets excluded from allocatedAddresses calculation
- Subnet status grouping: available, reserved, deprecated
- `getRecentManualReservations(limit, sourceTypes?)` — default `sourceTypes=undefined` filters to `["manual"]` (back-compat); explicit array narrows or broadens; empty array disables the filter entirely. Caller (the dashboard route) validates source-type values against the known enum before passing through.

**When changing this:**
- Test large fleet performance (blocks query with full subnet tree may be slow with 100k+ subnets)
- Verify usagePercent calculation (allocatedAddresses / blockAddresses) matches business intent
- Check that deprecated subnets are correctly filtered from block capacity

---
