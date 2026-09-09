# Domain model — IPAM, integrations, discovery runs and conflicts

Each entity below carries its CLAUDE.md definition + load-bearing invariant, followed (in the **Schema** and **Notes** parts) by the field-level schema dump and the extended notes that lived in the skill references (formerly ARCHITECTURE.md). `prisma/schema.prisma` is the source of truth for types; these are the semantics.

## Definitions and invariants

- **IpBlock** — top-level CIDR namespace; has many Subnets.

- **Subnet** — CIDR carved from a block; has many Reservations; tracks discovery origin. `tags` carries operator tags **plus inherited `region:<name>` tags** (a subnet served by a FortiGate inside a map region inherits it, matched through `controllerIdentityKeys`) — provenance-bounded by `RegionTagAssignment`, so a reconcile strips only what it applied and hand-added region tags survive. **`fortigateSerial` is the CHASSIS identity of the serving gate** — `fortigateDevice` is a NAME, and a name cannot tell a RENAME from a REPLACEMENT, which need opposite handling. Tri-state (NULL = unknown, applies no constraint and is never backfilled), compared per run against the reporting device's whole cluster serial set so an HA failover reads as the same gate; anything else raises the `chassis-replaced` Conflict. **A retired subnet MOVES to the archive rather than going `deprecated`** — a deprecated row still holds `@@unique([blockId, cidr])`, so its address space became unrecordable rather than reusable. See business rule 41.

- **ArchivedSubnet / ArchivedReservation** — a retired subnet and the reservations it held, kept for review after the live row is gone (business rule 41; written by `subnetArchiveService`). Separate tables rather than a status for two reasons: a `deprecated` row still occupies `@@unique([blockId, cidr])`, so a replacement gate serving the same space could never be recorded (discovery's index skips deprecated rows — no update path — while the overlap check counts them — no create path); and an archived reservation is **locked by construction**, not in `reservations` at all, so none of the ~50 write sites can reach it and there is no guard for a future writer to forget. **No FKs out to `IpBlock` / `Integration`, deliberately** — `Subnet.block` cascades, so an FK would let deleting a block erase the archive (the `DirectoryContactSource` reasoning); block/integration identity is denormalized. Push **pointers** (`pushedScopeId`/`pushedEntryId`/`pushedToId`) are deliberately not copied — they address an entry on a chassis that no longer exists — while push STATE is. **Not a retention entity**: nothing prunes it.

- **SubnetExclusion** — a CIDR declared OUT OF SCOPE for the networks list (business rule 42; `subnetExclusionService`). The address space several sites serve identically — a management VLAN, an out-of-band range — which Polaris' one-row-per-CIDR model can only record once and which since rule 41 reads as a chassis REPLACEMENT on every run because each site's gate answers with its own serial. Global (not per block), IPv4-only, and `cidr` is the FROZEN identity — the PUT takes name/notes only. Covers itself and anything narrower, one direction only. Enforced at `createSubnetRowChecked` (the seam every subnet-creating path meets), in the two allocators (excluded space is TAKEN space, so auto-allocate steps over it rather than 409-ing), and in discovery Phases 1 (skipped WHOLE, above the existing-row branch) and 2 (exempt from the stale sweep). Adding one reports the live networks it covers and leaves them alone — retiring a row stays `POST /subnets/:id/archive`.

- **Reservation** — single IP (or full-subnet) entry; `sourceType` distinguishes manual from discovered. Carries FortiGate push state (`pushStatus`, `pushQueuedAt`, etc.), stale-detection state, and `dhcpBinding` (`null` | `"lease"` | `"reservation"` — how the gate hands the address out, deliberately orthogonal to `sourceType`'s "who owns it"; see business rule 23). **A `vip` or `interface_ip` row is READ-ONLY** — a FortiGate virtual IP and a statically-configured router/firewall interface address are owned by the DEVICE's own config, not by anything Polaris granted, so Polaris reports them and offers no Reserve / Release / Edit. Creating over one was already refused (neither sourceType is in `isSupersedableByCreate`, so the collision check 409s); `assertNotDeviceOwned` in `api/routes/reservations.ts` closes the PUT and DELETE, at the ROUTE layer rather than in the service because discovery's own reconcile still has to refresh and retire these rows. Both render with the purple `.ip-dot-device-config` dot in the IP panel ("VIP" / "Interface").

- **Integration** — FMG / FortiGate / Entra ID / AD / Windows Server / vCenter / Azure Arc config + discovery state.

- **Conflict** — discovery-vs-existing conflicts (reservation, asset **and, since 2026-09, subnet** variants. The subnet one is `chassis-replaced` on `proposedSubnetFields` — the gate serving a subnet answered with a serial that is neither the stored one nor any member of its HA cluster, i.e. the box was swapped; raised from discovery Phase 1 by `subnetChassisConflictService` AFTER the old chassis's subnet + reservations are COPIED to the archive, so raising destroys nothing. Accept adopts the new chassis (stamps `Subnet.fortigateSerial`); reject dismisses, and the rejected row is the dedup marker for that exact (old, new) serial PAIR, so a box swapped twice raises again. `POST /conflicts/:id/migrate-reservations` carries chosen addresses' archived reservations onto the new gate — `manual` + `dhcp_reservation` only (`MIGRATABLE_SOURCE_TYPES`; device-owned / observed / device-managed rows are shown and refused), an `only-old` address created and a colliding one UPDATED in place, every row landing `manual` + `dhcpBinding: null` and QUEUED for push rather than pushed inline, and the conflict left OPEN so an operator can migrate in passes (`adopt: true` closes it in the same call). `GET /conflicts/:id/chassis-diff` computes the per-address old-vs-new diff on READ — discovery syncs subnets in Phase 1 and reservations in Phases 3–5, so a snapshotted payload would compare the old chassis against itself. See business rule 41. the asset variant also covers the ip-override flavor — `proposedAssetFields.collisionReason="ip-override"`, raised when discovery disagrees with an operator IP pin — and the **duplicate-ip** flavor (`collisionReason="duplicate-ip"`), raised by the `detectDuplicateIpAssets` sweep when two or more network-present assets record the SAME `Asset.ipAddress` and at least one of them is a type whose address was CHOSEN (`CONFLICT_ELIGIBLE_ASSET_TYPES` — switch / access_point / firewall / server). That one is **one pending row per ADDRESS, never per pair** — every claimant rides `proposedAssetFields.members[]` — and it is the one flavor Accept is REFUSED on: there is nothing to adopt, so the verbs are `POST /conflicts/:id/reassign-ip` (two devices — give ONE of them a different address) and `POST /conflicts/:id/merge` with a `{ survivorAssetId, absorbAssetIds }` body (one device recorded twice — absorb the duplicates through the operator merge engine). See business rule 40.)

- **DiscoveryRun** — per-integration discovery-run state; one row per integration. `scopeDeviceName` marks a SCOPED (single-device) run of ANY scopeable type — it is the DISPLAY label only; the structured `DiscoveryScope` travels in the job payload.

- **NetworkScan / NetworkScanRun** — a saved, re-runnable **active scan** of operator-supplied IP ranges (operator-facing name: a **Discovery**), and one row per execution. **Private or public** since 2026-09 (`visibility` + `ownerId`, the `SavedDashboard` / `SavedTableFilter` model; `createdBy` doubles as the username snapshot): visibility decides who may SEE and RUN one — publishing exists so somebody else can run it — while EDIT and DELETE stay the owner's, `networkScan:fullwrite` being the housekeeping override. An invisible row answers 404, not 403, and a run inherits its Discovery's visibility (the hits are the recon material). `name` is unique per OWNER, not globally. Existing rows migrated as `public` (every one was visible to every reader before); new ones default `private`, and the export carries no visibility at all. See business rule 34g. Reached from the Assets page's `+ Add Asset(s)` menu, not Integrations: the path for equipment that answers SNMP or a REST API but belongs to no controller and no directory. Deliberately **not** a `DiscoveryRun` row (that table is one-per-integration and a queued row there would trip the backup-restore guard and show up as an integration that isn't one) and deliberately **no `network-scan` AssetSource kind** — adoption creates assets like the manual `POST /assets` path. **Adoption is new-addresses-only**, so a re-run enriches nothing. Gated by the `networkScan` key with `assets:write` chained for adoption. See business rule 34.

## Schema

```
IpBlock
  id            UUID PK
  name          String
  cidr          String    @unique
  ipVersion     IpVersion
  description   String?
  tags          String[]
  subnets       Subnet[]

Subnet
  id              UUID PK
  blockId         UUID FK → IpBlock (cascade delete)
  cidr            String          -- Host bits zeroed on write
  name            String
  purpose         String?
  status          SubnetStatus    @default(available)
  vlan            Int?            -- 802.1Q VLAN ID (1–4094)
  tags            String[]
  discoveredBy    UUID? FK → Integration (set null on delete)
  fortigateDevice String?         -- FortiGate hostname/device
  createdBy       String?         -- username
  -- Bumped whenever discovery touches this subnet: the integration-wide
  -- syncDhcpSubnets pass stamps it for every create/update, and the
  -- per-subnet Refresh action (POST /subnets/:id/refresh, invoked by the
  -- IP panel's Refresh button) stamps it on success. Seeded to updatedAt
  -- for pre-existing discovered subnets via the column-add migration so
  -- the slide-in's "Discovered N minutes ago" line has a value to render
  -- without waiting for the next full discovery cycle.
  lastDiscoveredAt DateTime?
  reservations    Reservation[]

Reservation
  id              UUID PK
  subnetId        UUID FK → Subnet (cascade delete)
  ipAddress       String?         -- Null = full subnet reservation
  hostname        String?
  owner           String?
  projectRef      String?
  expiresAt       DateTime?
  notes           String?
  status          ReservationStatus     @default(active)
  sourceType      ReservationSourceType @default(manual)
  createdBy       String?
  conflictMessage String?         -- human-readable conflict summary
  vipInfo         Json?           -- VIP detail blob for sourceType="vip" rows (FortiGate device + mapped target); cleared when a VIP IP is succeeded by a dhcp_* lease/reservation (Phase 5 VIP succession)
  -- DHCP reservation push to FortiGate. Populated only when the subnet was
  -- discovered by an FMG integration with `pushReservations=true` AND the
  -- reservation is sourceType=manual + per-IP (full-subnet reservations are
  -- never pushed). pushedScopeId / pushedEntryId pin the device-side row so
  -- unpush hits the exact entry without re-resolving by IP. macAddress is the
  -- MAC sent to the device — DHCP reservations are MAC→IP, so a missing MAC
  -- on a push-eligible subnet aborts the create with 400.
  --
  -- pushStatus values:
  --   "synced"           — verified on device
  --   "drift"            — was synced, missing on a later discovery (operator deleted on device)
  --   "pending"          — queued: transient device-side failure at create or retry time. Polaris row
  --                        persists, retry job keeps trying. sourceType stays "manual" until the push lands.
  --   "failed_permanent" — terminal: 4xx, verify mismatch, auth failure, or lost an IP-collision race
  --                        against discovery. Operator must release or retry-now after fixing the cause.
  -- On create-time PERMANENT push failure (classifyPushError → "permanent") the entire create aborts
  -- and no row is persisted. Permanent vs transient classification lives in
  -- `reservationPushService.classifyPushError` — single source of truth across create + retry paths.
  --
  -- pushQueuedAt / pushAttempts / pushLastAttemptAt drive the 60s retry tick
  -- (`jobs/retryQueuedReservationPushes.ts`) + the `monitor.status_changed →
  -- up` hook in `monitoringService`. Monitored firewalls retry as soon as
  -- `Asset.monitorStatus="up"`; unmonitored firewalls back off exponentially
  -- (`min(60 * 2^(attempts-1), 1800)` seconds) keyed on attempts +
  -- pushLastAttemptAt. No TTL — queued rows live forever until success,
  -- release, or operator-triggered retry-now via POST /reservations/:id/retry-push.
  macAddress        String?
  pushedToId        UUID? FK → Integration (set null on delete)
  pushedScopeId     Int?            -- FortiOS DHCP server `id`
  pushedEntryId     Int?            -- reserved-address row id under that scope
  pushStatus        String?         -- "synced" | "drift" | "pending" | "failed_permanent"
  pushedAt          DateTime?
  pushError         String?
  pushQueuedAt      DateTime?       -- when the row entered pending; drives retry-order (oldest first)
  pushAttempts      Int             @default(0)  -- incremented on each retry; surfaced in UI tooltips + backoff math
  pushLastAttemptAt DateTime?       -- pairs with attempts for the unmonitored-gate backoff window
  -- Stale-reservation detection. lastSeenLeased is bumped during DHCP
  -- discovery whenever /api/v2/monitor/system/dhcp confirms the reservation's
  -- IP is being actively held by a client right now. lastSeenArp is bumped by
  -- sync Phase 7.6 whenever the owning FortiGate's ARP table binds this
  -- reservation's IP to its reserved MAC (minutes-fresh L2 presence; the
  -- opt-in `config.arpPresenceSweep` toggle actively primes the gate's cache
  -- via arpPrimeService right before the table read so quiet devices resolve
  -- too). staleNotifiedAt records
  -- the last `reservation.stale` Event emitted for this row; cleared by the
  -- sync on activity so the alert re-arms cleanly when the row goes silent
  -- again. staleSnoozedUntil hides the row from the active alert list while
  -- in the future (operator-driven Snooze; cleared by sync on activity).
  -- staleIgnored permanently silences the row until an admin un-ignores
  -- (network-admin/admin-driven; NOT cleared by sync — operator intent
  -- persists across online/offline cycles). See reservationStaleService.ts.
  lastSeenLeased    DateTime?
  lastSeenArp       DateTime?
  staleNotifiedAt   DateTime?
  staleSnoozedUntil DateTime?
  staleIgnored      Boolean        @default(false)
  -- dhcpBinding: how the FortiGate hands this address out, kept orthogonal to
  -- sourceType (which says who OWNS it). null = never observed in DHCP data;
  -- "lease" = leased dynamically, no reserved-address entry on the gate;
  -- "reservation" = a real MAC->IP entry exists. Written by the Phase 5 infra
  -- branch for fortiswitch/fortinap rows only — the source types whose binding
  -- state nothing else could observe. A "lease" row is takeover-able by an
  -- operator Reserve (isSupersedableByCreate); "reservation" and null still
  -- 409. Never paired with expiresAt on these rows: that would hand them to
  -- expireReservations and churn a live AP. See business rule 23 +
  -- src/utils/infraDhcpBinding.ts.
  dhcpBinding       String?
  conflicts       Conflict[]
  @@unique([subnetId, ipAddress, status])

Integration
  id            UUID PK
  type          String            -- e.g. "fortimanager", "fortigate", "windowsserver"
  name          String
  config        Json              -- Type-specific connection settings (host, port, adom, credentials, etc.)
  enabled       Boolean           @default(true)
  autoDiscover  Boolean           @default(true)
  pollInterval  Int               @default(4)  -- Hours between auto-discovery runs (1–24)
  lastTestAt    DateTime?
  lastTestOk    Boolean?
  lastDiscoveryAt DateTime?        -- Stamped at start of each run; used by scheduler to gate auto-runs across restarts
  interfaceAggregateCache Json?    -- Precomputed Auto-Monitor "By name" checklist source, refreshed at end of each successful discovery; { [class]: { computedAt, rows:[{ifName, ifType, deviceCount}] } }. NULL → routes live-compute (pre-first-discovery window)
  storageAggregateCache   Json?    -- Same, for the storage mount-path checklist (AD/Entra workstation/server classes only); { [class]: { computedAt, rows:[{mountPath, deviceCount}] } }
  subnets       Subnet[]

DiscoveryRun
  id              UUID PK
  integrationId   String  @unique   -- One active run per integration (DB-level invariant; paired with the discovery queue's singletonKey)
  integrationName String
  type            String            -- mirrors Integration.type
  status          String            -- queued | running | completed | aborted | error
  actor           String            -- username or "auto-discovery"
  startedAt       DateTime?         -- set by the discovery worker at run start
  finishedAt      DateTime?
  totalDevices    Int?              -- FMG/FortiGate device count once known
  completedCount / skippedOfflineCount / skippedErrorCount Int  -- rolling progress counters
  activeDevices   Json              -- [{name, startedAt}] currently-running FortiGates (FMG)
  slowAlerted / slowAlertedDevices  -- slow-run dedup flags
  cancelRequested Boolean           -- web sets it; the discovery worker polls and aborts
  workerHeartbeatAt DateTime?        -- drives the stale-run reaper
  scopeDeviceName String?           -- set when the run is SCOPED to one device (POST /assets/:id/rediscover); NULL = full run. A display label only (`scopeLabel` — an operator-recognisable name where one exists, else the scope's identifier); the structured DiscoveryScope rides the job payload, not this column. Surfaced by /discoveries for the "Discovering <device>…" card label
  -- Cross-process live discovery state. Replaces the former in-memory
  -- `activeDiscovery` Map so the web process can render progress + signal
  -- cancel while the `discovery`-role process executes the run. Written by the
  -- discovery worker, read by the web process's /discoveries endpoint +
  -- isDiscoveryRunning + slow-run check. See "Multi-process architecture".

NetworkScan
  id          UUID PK
  name        String            -- the operator's handle; round-trips through the .discovery.json filename. UNIQUE PER OWNER (@@unique([ownerId, name])), not globally: two operators may each keep a private "Plant 3 sweep", and a 409 naming a row the caller cannot see is both a dead end and a disclosure
  description String?
  visibility  String            -- "private" (the owner alone) | "public" (every networkScan:read holder). Default private; existing rows migrated public
  targets     Json              -- ScanTarget[]: [{ kind: "cidr"|"range"|"single", value }]
  methods     Json              -- ScanMethod[]: [{ type: "icmp"|"snmp"|"restapi"|"ssh"|"winrm", credentialIds[] }], tried in array order
  autoMonitor Json?             -- per-polling-method { interfaces?, storage? } selection applied to adopted assets; NULL = pin nothing
  ownerId     String?           -- FK -> User, ON DELETE SET NULL. What ownership is DECIDED on. NULL = an orphan (deleted account) or a bearer-token-created row: owned by nobody, manageable only at fullwrite
  createdBy / createdAt / updatedAt / lastRunAt
  -- createdBy doubles as SavedDashboard's `ownerName` -- the username snapshot
  -- that survives the account -- rather than a second column holding the same
  -- string.
  runs        NetworkScanRun[]
  -- A saved, re-runnable ACTIVE SCAN of operator-supplied IP ranges.
  -- Operator-facing name: a **Discovery**. Named NetworkScan* so nothing
  -- collides with the integration-discovery machinery (DiscoveryRun /
  -- discoveryEngine / discoveryRunState) -- the Automation/NotificationRule
  -- split. Deliberately NOT an 8th Integration type (that carries the ~30
  -- callsite onboarding checklist and would put a scan on the Integrations
  -- page) and deliberately NOT a DiscoveryRun row: that table's
  -- `integrationId` is @unique AND NOT NULL, and a queued/running row there
  -- would trip the backup-restore guard (`anyRunActive()`) and surface in the
  -- /integrations/discoveries progress UI as an integration that isn't one.
  -- The `autoMonitor` blob reuses the integration Monitoring tab's
  -- byNames/byPatterns/byTypes/byLldp vocabulary verbatim, so the pure
  -- resolvers (resolvePinnedInterfaces / resolvePinnedStorage) are shared
  -- rather than reimplemented. Gated by the `networkScan` RBAC key; ADOPTING
  -- the results chains `assets:write` on top, so "may find out what is on the
  -- network" and "may add it to inventory" stay separable.
  --
  -- PRIVATE OR PUBLIC since 2026-09 (migration
  -- 20260904060000_network_scan_visibility), the SavedDashboard /
  -- SavedTableFilter model, because scoping a sweep is real work and the only
  -- way to hand it to a colleague was exporting a file. The split is
  -- VISIBILITY vs OWNERSHIP and the two answer different questions: visibility
  -- decides who may SEE and RUN one (running somebody else's shared Discovery
  -- is what publishing one is FOR, so triggerScan asks only whether the caller
  -- can see the row), while ownership decides who may EDIT or DELETE it, with
  -- `networkScan:fullwrite` as the housekeeping override -- a check that lives
  -- in the route because it needs req.permissionLevel. An invisible row
  -- answers 404, not 403 (the GET /alerts/:id posture: a private Discovery's
  -- name is a site name), and a NetworkScanRun inherits its Discovery's
  -- visibility because the hits ARE the recon material. Publishing costs
  -- nothing above the `write` every mutation here already needs -- the one
  -- divergence from saved filters/dashboards, whose mounts sit at `read` --
  -- since networkadmin/assetsadmin hold write and author most Discoveries.
  -- The .discovery.json export deliberately carries NO visibility: it is an
  -- ownership fact about one install, not portable configuration, so an
  -- import lands private. See business rule 34g.

NetworkScanRun
  id       UUID PK
  scanId   String   -- FK -> NetworkScan, ON DELETE CASCADE (not a hypertable, so the no-FK rule does not apply)
  status   String   -- queued | running | completed | aborted | error
  actor    String
  error    String?
  totalTargets / droppedTargetCount / scannedCount / hitCount / skippedKnownCount Int
  hits     Json     -- ScanHit[]: one per responder (address, which method answered, identified fields, collected interface/storage inventory)
  cancelRequested   Boolean    -- the web role sets it; the worker polls and aborts its own AbortController
  workerHeartbeatAt DateTime?  -- drives the stale-run reaper
  startedAt / finishedAt / createdAt / updatedAt
  -- One row per execution. Carries DiscoveryRun's operational columns but NOT
  -- its one-row-per-parent uniqueness: run history is wanted, and an
  -- addressable in-flight run is what lets the wizard REATTACH to a scan
  -- instead of losing it when the operator closes the modal (the
  -- agent-build.js progress-strip precedent). `droppedTargetCount` counts both
  -- over-the-cap truncation and the addresses excluded regardless of what the
  -- operator typed (loopback / link-local incl. cloud metadata / multicast /
  -- unspecified) -- silent truncation would read as "the range is clean".

Conflict                        -- Discovery conflict resolution (two variants)
  id                UUID PK
  entityType        String         -- "reservation" | "asset"
  reservationId     UUID? FK → Reservation (cascade delete; null for asset conflicts)
  assetId           UUID? FK → Asset (cascade delete; null for reservation conflicts)
  integrationId     UUID?
  -- Reservation-conflict proposed values (null for asset conflicts):
  proposedHostname  String?
  proposedOwner     String?
  proposedProjectRef String?
  proposedNotes     String?
  proposedSourceType String?       -- Required for reservations, null for assets
  -- Asset-conflict proposed values (null for reservation conflicts):
  proposedDeviceId  String?        -- Entra deviceId (dedupe key across discovery runs)
  proposedAssetFields Json?        -- Full snapshot: hostname, serial, mac, model, manufacturer, os, osVersion, assignedTo, chassisType, complianceState, trustType
  existingAssetSnapshot Json?      -- Asset-conflict only. Snapshot of the collision-target asset's displayed fields (hostname, serial, mac, ip, manufacturer, model, os, osVersion, assignedTo) frozen at raise time, refreshed on each discovery run while pending, frozen at resolution. The Conflict Review card's "Existing Asset" column reads this so a resolved card shows conflict-time state, not the post-merge live row. Null for conflicts predating the column (UI falls back to the live `asset` relation).
  conflictFields    String[]       -- Field names that differ
  status            ConflictStatus @default(pending)
  resolvedBy        String?
  resolvedAt        DateTime?
```

## Notes

CLAUDE.md keeps each entity's definition and its load-bearing invariant; the full
reasoning for the entities below lives here.

#### Subnet

**Subnet** — CIDR carved from a block; has many Reservations; tracks discovery origin. `tags` carries operator tags **plus inherited `region:<name>` tags**: a subnet served by a FortiGate inside an operator-drawn map region inherits that region from its gate (`mapRegionService`, matched on `fortigateDevice` through `controllerIdentityKeys` — the same key set that propagates the region to the subnet's assets), which is what lets the IPAM Networks list — whose **Sources** column IS `fortigateDevice` — be filtered by region. Same provenance-bounded contract as asset region tags: membership adds and records a `RegionTagAssignment` row; the reconcile strips only recorded pairs that left membership (a subnet re-served by an out-of-region gate), so hand-applied region tags survive; rename/delete strip wholesale.

**`Subnet.fortigateSerial`** (2026-09, business rule 41) is the CHASSIS identity of the gate that serves the subnet, alongside `fortigateDevice`'s NAME. It exists because name-only identity cannot tell a RENAME from a REPLACEMENT, and those need opposite handling: a rename must re-point quietly, while a replacement must be reported, because the new box knows nothing about the reservations Polaris holds and every pushed row's `pushedScopeId`/`pushedEntryId` now addresses a DHCP entry on a chassis that no longer exists. Both failures were live — a new-name replacement deprecated the subnet (whose CIDR then could never be re-created, see below), and a SAME-name replacement, the ordinary RMA case, fired nothing at all and let the new chassis silently inherit the old one's rows. TRI-STATE: NULL is unknown (a row predating the column, or a source that published no serial) and applies no constraint, which is why no migration backfills it — the first pass that reads a serial adopts it as a LEARN. Compared per run by `utils/chassisIdentity.ts:classifyChassis` against the reporting device's whole cluster serial set (its own `sn` plus every `ha_slave[]` member, assembled in `syncDhcpSubnets` as `clusterSerialsByDevice`), so an HA failover reads as the same gate; a serial outside that set raises the `chassis-replaced` Conflict and deliberately does NOT re-point the stored value, since the pending conflict is the unresolved state.

#### ArchivedSubnet / ArchivedReservation

**ArchivedSubnet / ArchivedReservation** — a retired subnet and the reservations it held, kept for review after the live row is gone (business rule 41; written by `subnetArchiveService`). Two things make this a separate table rather than a `deprecated` status. **(1) A deprecated row still holds `@@unique([blockId, cidr])`**, so a replacement gate serving the same address space could never be recorded: discovery's `subnetByCidr` index skips deprecated rows (no update path) while `createSubnetRowChecked`'s committed-state overlap check counts them (no create path), and every such subnet came back as `Skipped subnet <cidr>: Subnet <cidr> overlaps with existing subnet <cidr>` on every run — taking that subnet's leases, DHCP reservations, VIPs and interface IPs with it, since `findSubnetForIp` skips deprecated rows too. **(2) Locked by construction**: an archived reservation is not in `reservations` at all, so none of the ~50 reservation write sites can reach it — no guard to add in fifty places and no future writer to forget one (contrast `assertNotDeviceOwned`, which must sit at the route layer precisely because discovery still writes the rows it protects). Block and integration identity are DENORMALIZED with **no FKs out**, deliberately: `Subnet.block` is `onDelete: Cascade`, so an FK would let deleting a block erase the archive — the `DirectoryContactSource.integrationId` reasoning. The device-side push POINTERS (`pushedScopeId`/`pushedEntryId`/`pushedToId`) are deliberately NOT copied — they address an entry inside a scope on a chassis that no longer exists, and carrying them forward would let a future restore or unpush aim a delete at whatever now occupies those ids on a different box; push STATE (`pushStatus`/`pushedAt`) is kept, being what a reviewer needs. Deliberately **not a retention entity** — nothing prunes it; subnets number in the thousands at most.

**SubnetExclusion** — a CIDR the operator has declared out of scope for the networks list (business rule 42; written by `subnetExclusionService`). It exists because a Polaris subnet is ONE row per CIDR (`@@unique([blockId, cidr])`) while some address space is the SAME at every site — a management VLAN, an out-of-band range, an appliance's fixed subnet — so the first site discovered claims the row and every other site collides with it. Since rule 41 that collision is a CONFLICT rather than noise: each site's gate answers with its own serial, so the shared row's chassis identity reads `replaced` on every discovery run and a `chassis-replaced` card is raised about a box nobody swapped. **Discovery skips a covered entry WHOLE** — before the existing-row branch, not just the create — because the conflict this prevents is raised by the UPDATE side; the row is also left out of the Phase 2 stale sweep, since its `fortigateDevice` is frozen at whichever site claimed it first and deprecating it when that one gate leaves the roster would be discovery acting on a subnet it was told to leave alone. **Global, not per block, deliberately**: the whole reason a CIDR needs excluding is that several sites serve it, and scoping the exclusion to one block would let the same CIDR be recorded through another. **`cidr` is the IDENTITY and is frozen after create** — the PUT takes `name`/`notes` only, because re-pointing an exclusion at different address space in place would silently un-exclude what the operator excluded (that is a delete plus an add), and it is normalized on write so `10.1.1.5/24` and `10.1.1.0/24` are one row. **Adding one destroys nothing**: networks already in the list that it covers come back on the response as `matchCount` / `matches` and are left alone — retiring one stays the operator's explicit `POST /subnets/:id/archive`. Enforced in four places: `createSubnetRowChecked` (the seam every subnet-creating path meets, so manual create / auto-allocate / the discovery create are all covered by one check), the two allocators (excluded ranges join the taken-space list handed to `findNextAvailableSubnet` / `packIntoAnchor`, so auto-allocate SKIPS over excluded space rather than 409-ing on it — a caller asking for "any free /N" must not be handed a wall), and discovery Phases 1 + 2. IPv4-only. Not a retention entity.

#### DiscoveryRun

**DiscoveryRun** — per-integration discovery-run state (status / actor / progress counts / timestamps); one row per integration (`integrationId` unique). `scopeDeviceName` marks a SCOPED single-device run (`POST /assets/:id/rediscover`, the asset slide-in's Discover Now) — full run machinery narrowed to one device. **No longer FortiGate-specific**: the scope kinds are `fmg-device` / `entra-device` / `ad-object` / `vcenter-vm` / `vcenter-host` / `arc-machine` (`src/services/discovery/discoveryScope.ts`), and this column holds only the display LABEL for the card; the structured scope rides the pg-boss payload. The `integrationId` uniqueness is why a scoped run cannot overlap its integration's fleet sweep — the route 409s rather than queueing. Per type, a scoped run suppresses the fleet-absence work: FMG finalizes `"finalize-scoped"` (Phase 2b per-controller switch/AP decommission only, never the roster sweeps); vCenter skips dependency-edge delete-replace, the datastore delete-replace and the stale-source sweep (`vcenterPassEnabled`); every asset-only type skips the four post-sync passes (`assetOnlyPostSyncPassesEnabled`); Entra/AD/Arc syncs have no fleet-absence passes to suppress.
