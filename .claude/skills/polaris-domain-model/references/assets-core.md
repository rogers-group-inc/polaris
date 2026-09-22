# Domain model — Asset, AssetSource, dependency edges, asset types

Each entity below carries its CLAUDE.md definition + load-bearing invariant, followed (in the **Schema** and **Notes** parts) by the field-level schema dump and the extended notes that lived in the skill references (formerly ARCHITECTURE.md). `prisma/schema.prisma` is the source of truth for types; these are the semantics.

## Definitions and invariants

- **Asset** — device inventory. Owns six-state monitor machine (`monitorStatus` — the fifth/sixth being `unknown` and `passive`; see business rule 36), polling-method per stream, FortiGate sightings, dependency layer/suppression, quarantine state, and the `managementAccess` summary (read-only `allowaccess` read during FMG/FortiGate discovery → asset slide-over Open HTTPS / Open SSH buttons, the same verbs in the Assets list row menu **and behind the three upstream rows on a device's General tab**, + FortiAP SNMP-disabled warning; see `fortinetManagementAccessService`). **A managed FortiSwitch has no per-device profile to read** — its access is a POLICY on the controller (`config switch-controller security-policy local-access`), so the summary comes from that object's `internal-allowaccess` (or `mgmt-allowaccess` when `switchManagementInterface` names the out-of-band port), with a per-switch interface `allowaccess` still winning where firmware exposes one and `protocols: null` (unknown, never "nothing permitted") when neither can be read. **A `server` gets Open RDP / Open SSH off its TYPE instead** — nothing reads a Windows or Linux host's management surface, so there is no `allowaccess` to consult and never will be; the verbs are offered through the same `_assetMgmtAccess` gate with the same "unknown is not denied" optimism the unreadable-FortiSwitch path takes. Deliberately not extended to `workstation` (two dead verbs on every endpoint row) and HTTPS is deliberately not offered on a server (its :443 is the application, not a management UI).

- **AssetSource** — per-discovery-source view of an asset (entra / intune / ad / arc / arc-k8s / fortigate-firewall / fortiswitch / fortiap / fortigate-endpoint / vcenter-vm / vcenter-host / **snmp-sysdescr** / manual / polaris-agent). Discovery-owned Asset fields are projected from these rows. **`snmp-sysdescr` is ENRICHMENT, not ownership** — it is the device's OWN answer to sysDescr, parsed through its vendor's documented format (`utils/snmpDescrIdentity.ts`) and written by the monitor path, so it says what the device claims to be and never that anything holds it in an inventory. `ENRICHMENT_SOURCE_KINDS` / `sourceClaimsExistence` in `utils/assetProjection.ts` is that distinction, and the vCenter disappearance sweep filters on it: counting one as a claim leaves a VM deleted from vCenter active forever, vouched for by its own SNMP reply. It ranks directly above `fortigate-endpoint` for manufacturer / model / os / osVersion — a device's own self-report beats a gate's DHCP fingerprint, which answers with a category (`"ip camera"`) rather than a model — and deliberately BELOW the agent / Arc / vCenter / MDM rows, which read the running system from inside it. A row exists only where `parseVendorSysDescr` recognized the layout (AXIS today), so a Windows host answering `"Hardware: Intel64 Family 6 - Software: Windows Version 6.3"` never gets one and can never displace Intune's model with it. **Two readers take it, on one anchor** (`Asset.lastDescrAt`, `DESCR_READ_INTERVAL_SEC` = 600s): the SNMP **system-info pass**, which reads sysDescr in its own multi-GET but only runs when an interfaces / LLDP / storage stream is enabled AND the asset reads `up`, and the SNMP **response-time probe**, which carries sysDescr as ONE EXTRA VARBIND in the GET it already makes when the anchor says the read is due — same packet, same session, same per-host gate, no new queue. That second reader is what reaches a device configured for SNMP response time and nothing else (a camera has one interface nobody polls, so requiring an interfaces stream to learn its model was backwards), and it also reaches a FLAPPING asset, which never earns a heavy pass. The probe's stamp rides `probePatchBuffer` (so it costs no write of its own) and is stamped whenever the string came back, parseable or not — an unparseable answer is still an answer, and re-asking every 60s would never start parsing. An identity write is best-effort and may never turn a successful probe into a failed one. **The raw sysDescr is kept on the source row and deliberately NOT offered to the `os` projection** — the asset page renders OS / Firmware as `[os, osVersion]`, so contributing it printed the whole semicolon-delimited string where `8.40.3` belonged; the parsed halves land in `model` / `osVersion` / **`Asset.productType`** instead, and `applyDescrIdentity` clears a stored `os` that IS the string the device is currently reporting (provenance-bounded, one-way — projection only ever writes non-null, so a column nobody states any more would keep its last value forever). **`productType` is what the device calls ITSELF** ("Network Camera"), projected from this source alone, and it is a first-class device-type MATCH FIELD: one `productType contains camera` rule types a camera fleet, where the same rule over `any` also reads `hostname` and typed an NVR called CAMERA-NVR-01 as a camera. `applyDescrIdentity` runs the type resolver in the **`scan`** context (an SNMP read on the monitor path is the same KIND of evidence a Network Discovery collects, so a rule written once applies to both — and this is the only reader that reaches a device already in inventory), **`other`-only** like the registry's own retroactive Apply, auditing as `asset.type_inferred`.

- **AssetDependencyParent** — parent→child edges of the dependency DAG; drives `Asset.dependencySuppressed`. `source` ∈ `computed` (Fortinet infra recompute) / `override` (operator pins, always win) / `vcenter` (VM→host) / `endpoint` (fleet-wide, at most ONE parent, resolved most-specific-first). **One parent, never a union** — all-down semantics model REDUNDANT parents, but a switch and the gate above it are in SERIES. Consumers resolving the effective set must test `source !== "override"`, **not** `source === "computed"`. **The controlling gate's own inventory BOUNDS the graph**: every discovery cycle asks each gate for its managed switch / AP inventory and stamps the answer on the GATE (`fortinetTopology.managedSwitchSerials` / `managedApSerials`) — FMG reads FortiManager's device DB, which answers even for a gate that is offline; standalone reads the gate's own CMDB. A device absent from gate G's list cannot sit under G at all, so an interface- or LLDP-derived adjacency that contradicts it is dropped in BOTH directions (`violatesMembership`; undirected adjacency in `assignLayers` means one direction is not enough), as is a child↔child edge whose ends belong to different gates. **Tri-state, and the distinction is load-bearing**: the field ABSENT means unknown (unreadable roster, or a row predating the feature) and applies no constraint; `[]` is the real answer "manages none"; a populated list constrains to exactly those serials — so discovery stamps the field ONLY when the read actually answered, and an unreadable roster can never read as "manages nothing". Membership is matched on SERIAL (the switch half reads `sn`, never the `switch-id` mkey, which is only the serial by default and is frequently renamed to the hostname); it needs nothing from the child, which is what lets it cover a device whose own `controllerSerial` stamp is missing or stale. HA needs no carve-out — the stamp is written per cluster member, so both rows carry the same list. It never influences a sweep: `cmdbSwitchSerials` / `cmdbApSerials` still exist separately to PROTECT assets from decommission, and membership only ever REJECTS an edge, never asserts one. Supersedes the child-side `contradictsController` veto (retired), which could act only when the child carried a `controllerSerial` and could only reject a direct child↔firewall pair. **A `decommissioned` or `disabled` device is dropped from the graph entirely** (`EXCLUDED_LIFECYCLE_STATUSES`, the statuses the endpoint half already excluded): rule 10 forces `monitored=false`, and `evaluateSuppression` treats an unmonitored parent as TRANSPARENT — it walks to the grandparents and, finding none, returns **ok**. A firewall is layer 1 with no parents, so a retired gate is a permanent “everything is fine” vote that vetoes suppression for every child still bound to it, and unlike a live gate it can never go down again. Retired assets stay IN SCOPE while leaving the graph, which is what retracts their own rows and nulls their layer rather than freezing them — filtering the read instead would strand a retired switch's stale parent rows forever, nothing ever bringing it back into scope. `storage` and `quarantined` are deliberately NOT dropped (still-present devices, and quarantine is reversible), so they keep the transparent-parent ok vote — a real gap whose answer belongs in `evaluateSuppression`, not in graph membership.

- **AssetMacAddress / AssetAssociatedIp / AssetIpHistory / AssetFortigateSighting / AssetControllerClaim** — side tables behind Asset. `AssetControllerClaim` is the newest (business rule 83): one row per (managed-device serial, claiming controller FortiGate), which is the evidence `AssetSource` structurally cannot hold.

- **AssetTypeDef** — operator-extensible asset-type registry (replaces the prior `AssetType` enum), and since 2026-09 the home of the **device-type matching rules** (`matchRules` / `matchContexts` / `matchPriority`, resolver in `src/utils/assetTypeMatch.ts`). `matchRules` is a **nested AND/OR condition tree** — the same grammar the automations device filter stores (`{op, children}` over and/or/none/notAll, leaf key `operator`), edited in the same shared `PolarisConditionBuilder` off a catalog built by `matchConditionMeta()` in `scopeConditionMeta()`'s own shape. It was a flat ANY-of clause list until 2026-09 (a transcription of the `||` ladders this layer replaced), which meant "a Windows box that is NOT a server" had to be written as one regex and left two look-alike condition dialects on one settings tab. **The shape converges; the EVALUATOR cannot** — `evaluateScopeCondition` filters stored Asset rows, these match facts about a device with no Asset row yet — so three things differ deliberately: the field vocabulary is disjoint (no tag / subnet / status / relation fields; a `chassis` string and an `any`-of-the-facts pseudo-field instead), negation lives on the OPERATOR (`notContains`, `notRegex`, …) rather than in a `none` group, and **an ABSENT fact never matches either polarity** (a device filter's `notContains` on a NULL column IS satisfied; here a missing fact means *not yet known*, and letting absence satisfy a negation is how one silent field outage re-types a fleet). Nothing is migrated: the pre-2026-09 rows — flat `{clauses}`, `starts_with`/`ends_with`, leaf `op`, `negate: true` — are folded forward on READ by `normalizeMatchRules`, losslessly and forever, and a row keeps its old shape until the next save. That fold also **prunes** (a valueless leaf, then any group left empty, then a root with nothing left → null), which is the structural answer to `and([]) === true` claiming the whole fleet for a type whose last condition was deleted. Those rules are the INFERENCE layer only — they decide the cases where Polaris would otherwise be guessing a type from a text field, and they can never override a source that STATES the type (a Fortinet controller's CMDB, vCenter's inventory, Azure Arc) or an operator's own edit. They replaced two hardcoded predicates, `inferAssetTypeFromOs` (directory sources) and `assetTypeForHit` (Network Discovery), and migration `20260901010000_asset_type_match_rules` seeds both verbatim, so the cutover is a no-op until an operator edits a rule. Three invariants: **`isProtected` guards identity, not matching** — a built-in cannot be renamed or relabelled (code branches on the literal names) but its rules are editable like any other row's, because nothing branches on how a device got into a bucket; **contexts are per-type**, since server/workstation were directory-only and firewall/switch/access_point/router/printer scan-only, and one merged set would type an AD computer "printer" off its OS string; and **re-typing is `other`-only** — preview, apply and discovery all share that eligibility, so a type an authoritative source or an operator set is never overwritten. The process cache falls back to the shipped rules when it has NEVER been loaded (distinct from loaded-and-empty, which is a real answer): `seedAssetTypes` runs only where `runsMigrations` is true, so the split-role discovery process reaches the resolver cold — `startBackgroundJobs` warms it on every role and `runDiscovery` re-reads it per run. Managed on Server Settings → Identification → **Device Types**.

## Schema

```
Asset
  id              UUID PK
  ipAddress       String?
  ipSource        String?         -- Where ipAddress was last set from: "manual", "fortimanager", "fortigate", etc.
  macAddress      String?         -- Most recently seen MAC (Intune writes prefer Ethernet over Wi-Fi when both are reported)
  -- macAddresses: stored in the AssetMacAddress side table (one row per
  -- assetId+mac pair). The list/get response still serializes the relation
  -- back into the legacy `macAddresses: [...]` JSON shape so the frontend
  -- reads the same field name as before. Discovery code paths (FMG /
  -- FortiGate DHCP, device-inventory, Intune sync, conflict ghost-merge)
  -- hydrate `asset.macAddresses` from the rows on load, modify the array
  -- in JS as before, then call `reconcileMacAddresses(assetId, macs)` from
  -- src/services/macAddressService.ts to sync the side table after the
  -- asset.update lands.
  hostname        String?
  hostnameOverride String?        -- Operator hostname pin (coordSource-style). Set/cleared ONLY by PUT /assets/:id (`assets:write`): typing a different Hostname in the edit form writes both `hostname` and `hostnameOverride`; blanking the field clears the pin and reverts `hostname` to the fresh discovery projection (null when no source has an opinion). While set, the Prisma extension in src/db.ts (`enforceOperatorOverrides` → `applyHostnameOverride` in utils/assetInvariants.ts) rewrites ANY asset update/upsert that stages `hostname` without touching `hostnameOverride` back to the pin — discovery projection writes can never clobber it, and no discovery writer needs to know it exists. A form save echoing the current hostname back is a no-op (does NOT pin). Pinned assets are excluded from `mergeDuplicateHostnameAssets` grouping (a pin colliding with another asset's hostname is operator intent, not a ghost) and from hostname drift in projectionDriftService. Rendered as an "overridden" badge on the asset details General tab, and — on BOTH the assets-list Hostname cell and that General-tab row — with the discovery-projected hostname printed under the pinned one as a subdued second line (wire field `hostnameDiscovered`, projected on read from the AssetSource blobs by services/discoveredHostnameService.ts for pinned rows only; blank when discovery agrees with the pin or has no opinion).
  ipOverride      String?         -- Operator IP pin (hostnameOverride-style, migration 20260716000000) with DISCOVERY-GETS-A-VOTE semantics. Set/cleared ONLY by PUT /assets/:id: typing a different IP Address in the edit form writes ipAddress + ipOverride + ipSource="manual"; blanking the field clears the pin and reverts ipAddress/ipSource to the fresh discovery projection. While set, the same src/db.ts guard (`enforceOperatorOverrides` → `applyIpOverride` in utils/assetInvariants.ts, unit-tested in tests/unit/ipOverride.test.ts) intercepts any update/upsert staging `ipAddress` without `ipOverride`: a staged IP EQUAL to the pin RELEASES it in the same write (self-disabling — discovery converged; audited as `asset.ip_override.released`, pending ip-override conflicts auto-closed); a DIFFERENT staged IP is rewritten back to the pin and a fire-and-forget follow-up (src/services/ipOverrideService.ts) raises/refreshes ONE pending Conflict per asset (entityType="asset", proposedAssetFields.collisionReason="ip-override", conflictFields=["ipAddress"]) — accept adopts the discovered IP + releases the pin, reject keeps the pin and the SAME discovered IP won't re-raise (a new one will). A staged clear (null) is re-asserted silently — no conflict. Pinned assets skip ipAddress drift in projectionDriftService. Rendered as an "overridden" marker on the details IP row; edit-form hints mirror the hostname pin's.
  dnsName         String?         -- FQDN from PTR lookup
  dnsNameFetchedAt DateTime?      -- When the last PTR lookup ran (success or failure)
  dnsNameTtl      Int?            -- TTL (seconds) from the PTR record; null = unknown (standard mode falls back to 3600s)
  assetTag        String? @unique -- Internal tracking tag
  serialNumber    String?
  manufacturer    String?
  model           String?
  assetType       String          @default("other")  -- validated against AssetTypeDef registry at write time
  status          AssetStatus     @default(active)
  location        String?         -- User-set (overrides learnedLocation)
  learnedLocation String?         -- Auto-discovered from DHCP (FortiGate name)
  department      String?
  assignedTo      String?
  os              String?
  osVersion       String?
  lastSeenSwitch  String?         -- e.g. "FS-248E-01/port15"
  lastSeenAp      String?         -- FortiAP name
  lastSeen        DateTime?       -- Verified network presence — last time Polaris had direct evidence the device was alive on the network. Written through bumpLastSeen() (src/utils/assetInvariants.ts; no-regress — only advances) for discovery/merge/conflict/presence writers, and through the probePatchBuffer bulk-update on the monitor hot path (recordProbeResult stamps "probe" on a successful probe). Evidence: live DHCP lease (seenLeased), FortiGate device-inventory sighting (the FortiGate's own per-client last_seen, never discovery-run time), connected FortiSwitch/FortiAP, firewall answering discovery, agent heartbeat, answering monitor probe, presence-verification ping. POLLING IS AUTHORITATIVE FOR MONITORED ASSETS: when monitored=true, bumpLastSeen refuses discovery-origin sources (discovery/device-inventory/dhcp-lease) so only the probe advances lastSeen — a monitored-but-down device freezes at its last successful poll regardless of what the FortiGate reports. Device inventory outranks the lease only for UNmonitored assets — when a MAC is in this cycle's device inventory the DHCP-lease bump is skipped so the inventory's real last_seen/is_online wins (a bound-but-idle lease can't stamp `now`). Fortinet-discovery-owned infra (firewall/switch/access_point with a fortinetTopology stamp) skips BOTH client-sighting bumps entirely — presence for those comes only from their own discovery loop (answered-live/connected/!offline gates) and the probe, so an offline-in-FMG gate can't be freshened by a lingering lease or stale cached is_online. Directory timestamps (Entra lastSyncDateTime, AD lastLogonTimestamp) deliberately do NOT write it — they live on AssetSource rows and render as "Last Directory Activity" in the slide-over.
  lastSeenSource  String?         -- Provenance label stamped by bumpLastSeen alongside every lastSeen advance: "dhcp-lease" | "device-inventory" | "discovery" | "agent" | "probe" | "ping" | "conflict-accept" | "conflict-reject". Shown as a "via …" suffix on the slide-over's Last Seen row.
  -- associatedIps: stored in the AssetAssociatedIp side table (one row per
  -- asset+ip pair). The list/get response still serializes the relation back
  -- into the legacy `associatedIps: [...]` JSON shape so the frontend reads
  -- the same field name as before. Per-row PTR cache (ptrName/ptrTtl/
  -- ptrFetchedAt) lives on the row directly. Persist semantics: monitor
  -- system-info pass deletes all source != "manual" rows for the asset and
  -- re-inserts the fresh interface set in one $transaction; manual entries
  -- are preserved across pulls.
  associatedUsers Json            -- [{user, domain?, lastSeen, source?}]
  latitude        Float?          -- Geo coord; drives Device Map pins. Discovery-populated on firewall assets OR operator-typed on any asset via the edit form (`assets:write` — admin + assetsadmin by default). Discovery resolution priority on firewall assets: geocoded location → FMG coordinate metavars → CMDB `gui-device-latitude`/`gui-device-longitude`. The geocoded-location tier's source string is resolved per device as: FMG **address metavar** (named by `fortigateMonitor.addressMetavar`, opt-in) when set+populated → SNMP `sysLocation` (when `pullSnmpLocation` is on) as fallback; the chosen string is run through Nominatim. The coordinate metavars are named by `fortigateMonitor.latitudeMetavar`/`longitudeMetavar` (default `Latitude`/`Longitude`; FMG-only). Each tier validates the (lat,lng) pair via `isValidGeoCoord` (rejects null/NaN/(0,0)/out-of-range) so a half-valid tier falls through to the next instead of mixing values. Same priority order applies to `longitude`.
  longitude       Float?
  coordSource     String?         -- Provenance of latitude/longitude: "manual" = operator-typed via the asset create/edit form (pair-validated by `manualCoordPatchError` in utils/geo.ts — both set, both cleared, or both omitted; (0,0) rejected). While "manual", syncDhcpSubnets skips its projected coord write and projectionDriftService skips lat/long drift, so the pin is never clobbered or logged as drift. NULL = discovery-owned / unset. Stamped only on a REAL value change (a form save echoing discovery-stamped values back does NOT pin them); clearing both fields resets to NULL so discovery may repopulate next cycle. A coord change on a firewall also fires a best-effort `reconcileMapRegions()` so region-tag membership updates without waiting for the periodic job.
  snmpLocation          String?   -- Raw SNMP sysLocation (OID 1.3.6.1.2.1.1.6.0) pulled via REST `GET /api/v2/cmdb/system.snmp/sysinfo` during discovery when the originating FMG/FortiGate integration has `fortigateMonitor.pullSnmpLocation` enabled. Captured independently of whether geocoding produced usable coords — operators see what the FortiGate reports for sysLocation even when Nominatim couldn't resolve it. Surfaced on the asset details General tab. Only populated on `assetType="firewall"` rows.
  snmpLocationFetchedAt DateTime? -- Bumped on every successful sysLocation REST pull (including pulls that returned an empty string — the UI can show "checked X minutes ago, no value reported"). Null on firewalls that haven't been pulled yet or on integrations whose `pullSnmpLocation` is off.
  learnedAddress        String?   -- Auto-discovered street address, projected from the FMG per-device address metavar named by the originating integration's `fortigateMonitor.addressMetavar` (FMG-only, opt-in). Distinct from `learnedLocation` (site/controller label) and `snmpLocation` (raw sysLocation). Only (re)written when an address metavar is configured that discovery cycle — mirrors the snmpLocation "only when we looked" rule. Surfaced as "Address" on the asset details General tab.
  fortinetTopology Json?           -- { role: "fortigate" | "fortiswitch" | "fortiap", deviceName?, controllerFortigate?, uplinkInterface?, parentSwitch?, parentPort?, parentVlan?, state?, haMode?, haRole?, haPeerSerial? } — real connection graph from FMG/FortiGate discovery. `deviceName` (firewall role only) is the FMG/dvmdb device name — differs from the member hostname on renamed devices / HA members — stamped so device-targeted write paths (description sync) can build a transport without a dvmdb lookup. `state` (switch/AP roles) is the controller admission state — "Authorized"/"Unauthorized" on FortiSwitches (managed-switch/status `state`), "authorized"/"discovered"/... on FortiAPs (managed_ap `state`); distinct from connectivity status, rendered as the Authorization badge row on the asset details General tab (desktop `authorizationRowHTML` + mobile General sheet). `haMode` / `haRole` / `haPeerSerial` are populated only on firewall-role assets in an HA cluster (a-p / a-a) by the per-member Phase 3 fan-out; `haRole` is "primary" | "secondary", `haPeerSerial` points at the OTHER member's serial. Standalone firewalls omit the HA fields or carry `haMode: "standalone"`.
  managementAccess Json?          -- { source: "firewall-interface" | "fortiswitch" | "fortiap-profile", interfaceName?, profileName?, mgmtIp?, protocols: string[] | null, https, ssh, snmp, checkedAt } — management-access (`allowaccess`) summary read during FMG/FortiGate discovery (syncDhcpSubnets Phase 13.6, via `fortinetManagementAccessService`). Firewall: the operator-named `config.mgmtInterface` interface's allowaccess. FortiAP: the AP's `wtp-profile` allowaccess. FortiSwitch: the switch's internal/custom interface (best-effort — `protocols: null` when the REST shape can't be read). Drives the asset slide-over's Open HTTPS / Open SSH buttons, the same two verbs in the Assets list row menu (`_managementAccessMenuItems`; the list payload carries the `shapeManagementAccess` four-field reduction, not the whole blob), + the FortiAP "SNMP not enabled in profile" warning. Monitor/discovery-owned (never projected from AssetSource). Read-only; never writes the device.
  acquiredAt      DateTime?
  warrantyExpiry  DateTime?
  purchaseOrder   String?
  notes           String?
  description     String?          -- Operator-owned device description (VarChar 255). When the originating integration's `syncDescriptions` toggle is on (business rule 14), description-synced with the device — Polaris-primary: empty → seeded (adopted) from the device; a value in Polaris → written to the device (FortiGate `system/global` alias / FortiSwitch managed-switch description / FortiAP wtp `location` per `fortinetTopology.role`) and re-asserted over device-side edits. All audited. See descriptionSyncService.
  descriptionSync Json?            -- Device-level description-sync state: { status: "synced"|"failed"|"conflict", at, value?: baseline (last agreed value; key present = merge base known), error?, device?/polaris?: conflicting values }. Null = never synced / cleared. Stamped only by actual push attempts / reconcile decisions (transport errors leave it untouched); cleared when the operator empties `description`.
  tags            String[]
  createdBy       String?
  discoveredByIntegrationId UUID? FK → Integration (set null on delete) -- Stamped on FortiGate firewall asset writes (FMG + standalone) and on Windows-OS Active Directory asset writes. Drives the polling-method resolver's source-default fallback: FMG/FortiGate-discovered firewalls default to REST API on every stream; AD-discovered hosts default to ICMP for response-time and "not delivered" for the other three streams.
  monitored       Boolean         @default(false)
  monitorOverride Boolean    @default(false) -- **Explicit operator-intent bit**: true when an operator deliberately set this asset's `monitored` state away from the discovering integration's per-class `addAsMonitored` default. Discovery sweeps `monitored` to match `addAsMonitored` on every cycle EXCEPT when this is true — the override protects an explicit operator choice from being clobbered. WRITTEN only at operator-action time: every operator write to `monitored` (PUT /assets/:id, POST /assets/bulk-monitor, Status pill toggle) runs `recomputeMonitorOverrideForAssets()` for the touched ids (single SQL UPDATE computing monitored XOR addAsMonitored), and `POST /assets/:id/monitor-override/reset` clears it (realigns `monitored` to the flag). It is **never re-derived from incidental divergence** — discovery, the create path, the decommission clamp, and HA-standby seeding leave it alone, so an asset that ends up `monitored=false` for a non-operator reason keeps `monitorOverride=false` and self-heals (the next sweep retakes it). On integration save, `sweepMonitoredForIntegration()` applies the new per-class flag across non-override assets only and does NOT recompute overrides — a flag flip respects pins. Manually-created assets (no `discoveredByIntegrationId`) stay false. (Replaced the legacy `monitoredOperatorSet` sticky flag, then the convergent model whose every-boot/every-save re-derivation wrongly stamped incidental divergence as override.)
  monitorCredentialId UUID? FK → Credential (set null on delete) -- Generic fallback credential used by polling methods that need authentication (snmp/winrm/ssh/restapi/http). Type-agnostic at write time. FMG/FortiGate-discovered firewalls fall back to the integration's stored API token / SNMP credential when this is null.
  -- Per-stream credential FKs (set null on delete) — most-specific tier of the
  -- credential resolver, one per stream. null = fall back to monitorCredentialId
  -- → class-override per-stream credential → integration fallback. See
  -- "Credential resolution" in polaris-monitoring-discovery → monitoring-architecture (polling / fortinet) and polaris-agent → agent-server-side.md.
  responseTimeCredentialId  UUID? FK → Credential
  cpuMemoryCredentialId     UUID? FK → Credential
  temperatureCredentialId   UUID? FK → Credential
  interfacesCredentialId    UUID? FK → Credential
  lldpCredentialId          UUID? FK → Credential
  customWidgetCredentialId  UUID? FK → Credential
  monitorIntervalSec Int?         -- Per-asset response-time probe interval; null inherits from the resolved tier (see "Monitor Settings Hierarchy" below).
  probeTimeoutMs  Int?            -- Per-asset probe timeout (ms). Range 100..60000; null inherits from the resolved tier (default 5000ms). UI shows a soft warning under 500ms.
  cpuMemoryTimeoutMs   Int?       -- Per-asset CPU/memory collector timeout (ms). Range 1000..120000; null inherits from the resolved tier (default 10000ms). Applied to FortiOS REST + SNMP session timeouts inside `collectTelemetry`. Distinct from probeTimeoutMs so the cheap response-time probe and the heavier CPU/memory scrape can be tuned independently — CPU/memory usually wants a longer ceiling because a busy SNMP agent can take seconds to answer a multi-OID walk.
  temperatureTimeoutMs Int?       -- Per-asset hardware-sensor collector timeout (ms). Range 1000..120000; null inherits from the resolved tier (default 10000ms). Applied to FortiOS REST (`/api/v2/monitor/system/sensor-info`) + SNMP session timeouts inside `collectHardwareSensors`. (Column name kept `temperatureTimeoutMs` — the internal polling-stream key is still `temperature`.) Separate from cpuMemoryTimeoutMs because hardware sensors dispatch on their own polling method — a small-branch FortiGate with CPU/memory on REST and hardware sensors on SNMP often wants different ceilings on each.
  systemInfoTimeoutMs Int?        -- Per-asset interface / storage / LLDP collector timeout (ms). Range 1000..120000; null inherits from the resolved tier (default 10000ms). Applied to FortiOS REST + SNMP sessions inside collectSystemInfo + collectFastFiltered (the per-minute fast-cadence pin pull — the SNMP fast path uses wire-level filtering and finishes in sub-second on most agents, but the heavy pass still walks full IF-MIB / ifXTable / LLDP-MIB / storage in one session). Same independent-tuning rationale as telemetryTimeoutMs.
  customWidgetTimeoutMs Int?      -- Per-asset custom-widget (Slice 7) collector timeout (ms). null inherits from the resolved tier. Applied to the SNMP session inside collectAndRecordCustomWidgets.
  monitorStatus   String?         -- "up" | "warning" | "recovering" | "down" | "unknown" — see "Five-state monitor machine" below. UI renders "recovering" as **Recovering** (was-down, now succeeding) and "unknown"/null as **Pending** (never probed); same blue treatment, different labels.
  monitorStatusChangedAt DateTime? -- Bumped on every monitorStatus transition (any-to-any, not just up↔down). Drives the "how long has this been warning/down" duration on the Dashboard's Monitor Alerts card. Null until the first transition. Stamped inside the same recordProbeResult Asset.update that writes monitorStatus. The one-shot backfillMonitorStatusChangedAt startup job seeds existing warning/down assets from the latest `monitor.status_changed` Event when one is still inside the 7-day retention window.
  lastMonitorAt   DateTime?
  recoveryStartedAt DateTime?     -- The success that ended the last outage: stamped by recordProbeResult when a probe takes monitorStatus out of "down"/"unknown" (via probePatchBuffer, preserved-on-absent). The packet-loss ratio's SECOND anchor (business rule 29b) -- probeLossQuery measures from GREATEST(first success in window, this), so an outage that started mid-window leaves the denominator; the alert-email loss chart applies the same anchor to its caption (its line covers the whole window and marks where the measurement starts). A warning->up recovery deliberately does NOT stamp it (flapping must stay measurable). Never cleared, never backfilled: it ages out of the window on its own and the next recovery overwrites it. Predicate + anchor math are the pure utils/probeLossAnchor.ts
  lastLossSampleAt DateTime?      -- Cadence anchor for the ICMP packet-loss sweep (utils/lossSweep.ts). Kept its name through the sampler-to-sweep cutover so an in-flight anchor is not orphaned. Its OWN column, so the sampler cannot disturb the response-time poll's due-check; stamped on every attempt (success or failure) so a ping-blocked host is not re-queued each tick
  lastResponseTimeMs Int?         -- Most recent successful probe RTT; null while in flux or after a failure
  lastUptimeSec   Int?            -- Last device-uptime reading (whole seconds), captured on the probe path: SNMP sysUpTime (free — already fetched for liveness), FortiOS system/status, and the Polaris Agent (host.Uptime via the responseTime stream). Compared against the next probe's reading for reboot detection. Null for assets whose probe transport never reports uptime (ICMP/SSH/WinRM). Surfaced as the System-tab "Uptime" row (formatUptime in utils/uptime.ts + public/js/app.js): live value = lastUptimeSec + (now - lastMonitorAt), plus a "since <lastRebootAt>" line.
  lastRebootAt    DateTime?       -- When Polaris last detected lastUptimeSec decrease (a reboot); drives the NOC "Recent Reboots" widget via the device.reboot Event. Both written through the probePatchBuffer (COALESCE-preserved on probes that didn't report uptime).
  consecutiveFailures Int         @default(0)
  consecutiveSuccesses Int        @default(0) -- Drives recovering/warning -> up. Reset to 0 on any failure; failureThreshold doubles as the recovery threshold (same number of confirmations gates up <-> down both ways).
  -- Controller link state for a FortiGate-managed FortiSwitch / FortiAP
  -- (business rule 59). What the PARENT GATE says about its own session to the
  -- device -- the FortiLink session for a switch, the CAPWAP tunnel for an AP
  -- -- as distinct from what the monitor loop sees on the operator's chosen
  -- transport. The two are allowed to disagree and the disagreement is the
  -- point: a switch with a dead FortiLink session answers ICMP and SNMP
  -- perfectly, so monitorStatus reads "up" while the gate has stopped managing
  -- it. Written ONLY by services/fortinetLinkStateService.ts (the 60s
  -- jobs/sweepFortinetLinkState tick); never by the probe path, and never
  -- feeding monitorStatus / consecutiveFailures.
  --
  -- Deliberately four scalar columns rather than keys on fortinetTopology:
  -- discovery rewrites that blob wholesale every cycle, so a 60s sweep
  -- read-modify-writing it would lose-update the discovery stamp. Scalars also
  -- let notificationEngine's resolveAssetStateReadings read the field straight
  -- off the scope row like monitorStatus, with no query of its own.
  fortilinkStatus    String?      -- "up" | "down" | "unknown"; null = the sweep has never spoken about this device (not FortiGate-managed, or a pre-feature row awaiting its first tick). "unknown" is answered-but-ABSENT from the controller's table, which is NOT "down" -- a post-config-push window looks identical and down-detection authority is rule 36's. A controller the sweep could not READ writes nothing at all, so a dark FMG leaves the last known values standing instead of reporting a fleet-wide link outage. Exposed as the `fortilinkStatus` asset_state automation field, where a null produces NO READING (a reading of null would make `!= up` true of every workstation in a fleet-wide scope).
  fortilinkStatusRaw String?      -- The raw word the controller used: "Connected"/"Disconnected" for a switch, "online"/"connected"/"offline"/"discovered" for an AP. DISPLAY ONLY -- every predicate, including the automation field, reads fortilinkStatus. Kept because the three AP words that all normalize to "down" mean different things to an operator.
  fortilinkCheckedAt DateTime?    -- When the controller last ANSWERED about this device, refreshed on every successful sweep whether or not the value moved. Two readers: the automation engine uses it as the READING ANCHOR for fortilinkStatus (so a forPolls hold counts times the controller answered, not monitor-loop ticks that never looked), and the asset-details row reads a stalled value as "last confirmed <time>" rather than presenting it as current. A frozen timestamp is how an unreadable controller surfaces at all.
  fortilinkChangedAt DateTime?    -- When fortilinkStatus last changed value. Deliberately NOT bumped by a confirmation, which is what makes the "down for 2h 13m" on the details row the outage length rather than the age of the last sweep. Timestamp on the asset.fortilink.changed Event.
  -- Per-stream polling-method overrides — top tier of the polling-method
  -- hierarchy. Each accepts the 5-way enum "rest_api" | "snmp" | "winrm" |
  -- "ssh" | "icmp" or null (= inherit from the class override / integration
  -- tier / source default). The resolver applies the compatibility matrix
  -- from utils/pollingCompatibility — values that don't match the asset's
  -- source kind are silently ignored at resolution time. Routes
  -- (PUT /assets/:id, monitor-settings/* writes) reject incompatible
  -- methods at write time so the operator sees the error early.
  responseTimePolling       String?
  cpuMemoryPolling          String?
  temperaturePolling        String?
  interfacesPolling         String?
  lldpPolling               String?
  -- Storage stream — SNMP-only when enabled. Source default is "disabled" on
  -- fortimanager / fortigate (no meaningful mountable storage on FortiOS
  -- appliances), null on every other source. Reuses the asset's interfaces
  -- credential; no per-stream credential or MIB column.
  storagePolling            String?
  -- Custom-widget stream (Slice 7) polling method — "rest_api" | "snmp" |
  -- "disabled". SNMP-only in v1 for actual collection; null inherits from the
  -- resolved tier. Drives collectAndRecordCustomWidgets on the telemetry cadence.
  customWidgetPolling       String?
  -- Per-asset request path override for HTTP-CHECK WIDGETS (migration
  -- 20260821000000). It was built for the "http" polling method, which was
  -- retired in 2026-08; the escape hatch it provides is still wanted, since
  -- the widget's own `modelPattern` covers "this MODEL answers elsewhere" and
  -- this covers the single device that does. Deliberately per-asset only --
  -- there is no class-override twin, because a class-tier path override would
  -- just be a second widget. NULL / "" = no override, which is a different
  -- statement from "/": blanking the field returns the device to the
  -- credential's path rather than repointing it at the web root, and
  -- resolveHttpTarget (utils/httpCheck.ts) is the single place that decides it.
  -- Only read when responseTimePolling resolves to "http".
  httpCheckPath             String?
  -- Per-stream MIB id hints. Either `"std:<key>"` (built-in MIB; UI-only,
  -- ignored by the collector) or an uploaded MibFile UUID. null = inherit
  -- from the resolved tier. Consumed by `collectCpuMemorySnmp` /
  -- `collectTemperatureSnmp`: when `cpuMemoryMibId` resolves to an uploaded
  -- MibFile, its `manufacturer + moduleName + model` are fed into
  -- `pickVendorProfile` instead of the asset's own identity — lets operators
  -- redirect a misclassified asset (e.g. a FortiSwitch whose discovery
  -- sources stamped manufacturer=Fortinet with no model hint) into the right
  -- profile without renaming. Symbol resolution scope (oidRegistry) still
  -- uses the asset's own manufacturer/model so per-device MIB uploads
  -- continue to win.
  responseTimeMibId         String?
  cpuMemoryMibId            String?
  temperatureMibId          String?
  interfacesMibId           String?
  lldpMibId                 String?
  -- System tab cadences (asset details modal). Same monitorAssets job, but
  -- on independent timers from the response-time probe. CPU/memory + temperature
  -- dispatch on their own polling methods (`cpuMemoryPolling` vs
  -- `temperaturePolling`) — `runTelemetryFor` runs `collectTelemetry` and
  -- `collectHardwareSensors` in parallel each tick, each using its own
  -- credential / MIB / timeout, but off ONE asset read: the pass loads the
  -- row once through `TELEMETRY_ASSET_INCLUDE` (the union of what the two
  -- collectors plus the custom-widget pass need) and hands it to all three.
  -- Each used to fetch the same row itself, so collecting from one device
  -- opened three wide reads of Asset — the widest table in the schema —
  -- plus their credential and integration joins. Both collectors still
  -- accept an assetId alone for the standalone callers (probe-now, the
  -- cursor path), which load it themselves. Common branch-class FortiGate setup: CPU/mem
  -- on REST, temperature on SNMP because `/api/v2/monitor/system/sensor-info`
  -- is unreliable on the 60F/61F/91G platforms. Today both streams still
  -- share the telemetry cadence trigger (cpuMemoryIntervalSeconds drives
  -- when both fire). An independent `temperatureIntervalSec` timer is a
  -- future follow-up — the column already exists but isn't yet consulted by
  -- the cadence ticker.
  cpuMemoryIntervalSec   Int?
  temperatureIntervalSec Int?
  systemInfoIntervalSec  Int?
  -- Phase 2 carve-out: LLDP + Storage each ride their own pg-boss queue
  -- (polaris-monitor-lldp / polaris-monitor-storage). null = inherit from
  -- the resolved tier. The publisher in monitorAssets.ts reads `last*At +
  -- *IntervalSeconds` per asset to decide when each is due.
  lldpIntervalSec        Int?
  storageIntervalSec     Int?
  customWidgetIntervalSec Int?           -- Custom-widget (Slice 7) cadence; rides the telemetry tick. null = inherit.
  lastTelemetryAt       DateTime?
  lastSystemInfoAt      DateTime?
  lastLldpAt            DateTime?
  lastStorageAt         DateTime?
  lastCustomWidgetAt    DateTime?        -- Bumped after each successful collectAndRecordCustomWidgets pass.
  -- ifNames pinned for fast-cadence polling on the System tab. Each entry
  -- in this array is also scraped on the response-time interval (default
  -- 60s) so the operator gets sub-minute throughput + error history for
  -- chosen uplinks/critical ports. The full system-info pass at ~10 min
  -- still covers all interfaces and skips the fast-scrape collision.
  monitoredInterfaces   String[]   @default([])
  -- Storage hrStorageDescr mountPaths pinned for fast-cadence polling.
  -- Same model as monitoredInterfaces — sub-minute disk-usage history for
  -- chosen volumes; the full system-info pass still covers all mountpoints.
  monitoredStorage      String[]   @default([])
  -- Phase-1 IPsec tunnel names pinned for fast-cadence polling. The full
  -- /api/v2/monitor/vpn/ipsec endpoint can be slow on busy gateways and is
  -- normally skipped on the fast cadence; pinning a tunnel here issues a
  -- targeted scrape that filters down to just the requested phase-1.
  -- ADVPN dynamic shortcut tunnels are filtered out of discovery (the
  -- collector skips any tunnel with a non-empty `parent` field) so they
  -- don't pollute the table or this pinning surface.
  monitoredIpsecTunnels String[]   @default([])
  -- All three pin arrays gate ALERTING as well as cadence: an automation
  -- produces readings only for pinned interfaces / mounts / tunnels
  -- (services/notificationEngine.ts -> interfaceIsPinned() /
  -- storageIsPinned() / tunnelIsPinned()). Every stream also writes samples
  -- for the UNPINNED members (cadence="slow"), so the pin is the only thing
  -- deciding what can raise an alert; un-pinning is how alerting stops.
  -- Asset.status (active/maintenance/decommissioned/...) lifecycle audit.
  -- statusChangedAt is bumped whenever `status` changes value; statusChangedBy
  -- records who/what changed it (username, integration name, or "system").
  statusChangedAt        DateTime?
  statusChangedBy        String?
  -- Quarantine state. Status "quarantined" is owned by the dedicated quarantine
  -- endpoints and cannot be set/cleared via the generic PUT /assets/:id update.
  -- quarantineTargets is a JSON array of per-FortiGate push records:
  --   [{ fortigateDevice, integrationId, pushedMacs[], pushedAt, status: "synced"|"drift"|"failed", error? }]
  -- statusBeforeQuarantine preserves the prior status so release can restore it;
  -- monitoredBeforeQuarantine does the same for the `monitored` flag, because
  -- "quarantined" is one of the four statuses that cannot carry monitoring
  -- (business rule 10) — the db.ts clamp turns polling off on the way in, and
  -- without the park a release would hand the device back to the network with
  -- nobody watching it. null pops back to not-monitored.
  statusBeforeQuarantine String?
  monitoredBeforeQuarantine Boolean?
  quarantineReason       String?
  quarantinedAt          DateTime?
  quarantinedBy          String?
  quarantineTargets      Json?
  -- Dependency-aware monitoring suppression. dependencyLayer is the BFS
  -- shortest-path distance from any FortiGate root computed by
  -- dependencyTreeService.recomputeDependencyTree (1 = FortiGate, 2 = direct
  -- child switch/AP, 3+ = chained). dependencySuppressed is the runtime flag
  -- set by the dependency reconciler when ALL of the asset's effective
  -- parents are confirmed down (or themselves suppressed); see the
  -- AssetDependencyParent model above for the resolution rules. While
  -- suppressed, telemetry / systemInfo / fastFiltered cadences pause and
  -- the response-time probe runs at 2× the resolved interval, with each
  -- failed probe stamped AssetMonitorSample.dependencyDown so the charts
  -- can grey the stretch instead of drawing a red outage over it.
  -- RELEASE IS ASYMMETRIC: the flag is SET when every parent reads `down`,
  -- but CLEARED only once a parent is genuinely back — `recovering` holds it,
  -- because releasing on one answered packet un-suppresses the whole
  -- subtree while every child's own probes are still failing, and the
  -- outage then re-alerts device by device as plain Down.
  dependencyLayer        Int?
  dependencySuppressed   Boolean   @default(false)
  dependencySuppressedAt DateTime?
  -- Admin-only "dependency test" simulation: while dependencyTestUntil is in
  -- the future, the asset is treated as down for suppression-propagation
  -- testing without a real outage. dependencyTestStartedBy records the admin.
  dependencyTestUntil    DateTime?
  dependencyTestStartedBy String?

AssetFortigateSighting          -- DHCP-only sightings: tracks which FortiGate each asset has been seen on
  id                UUID PK
  assetId           UUID FK → Asset (cascade delete)
  integrationId     UUID? FK → Integration (set null on delete)
  fortigateDevice   String          -- FortiGate device name from the DHCP entry
  source            String          -- "dhcp_lease" | "dhcp_reservation" | "interface_ip" | "vip"
  ipAddress         String?         -- IP last seen on this FortiGate. Bumped on every re-sighting alongside lastSeen. Nullable for rows recorded before this column existed; the Quarantine tab joins it against Subnet.cidr (filtered by fortigateDevice) at read time to surface subnet name + VLAN.
  lastSeen          DateTime
  @@unique([assetId, fortigateDevice]) -- one row per (asset, FortiGate); updated on re-sighting

AssetControllerClaim            -- Which controller FortiGate(s) claim a managed device, by SERIAL (business rule 83)
  id                UUID PK       -- Written by discovery's FortiSwitch/FortiAP loops through
                                  -- duplicateSerialConflictService.recordControllerClaims(), once per pass in
                                  -- batched transactions (never per device). Read ONLY by that service's sweep.
                                  -- It is NOT a projection input: projectAssetFromSources never sees it, and a
                                  -- claim never decides which controller wins — discovery keeps its existing
                                  -- last-writer-wins stamp and the conflict card reports the disagreement.
  assetId           UUID FK → Asset (cascade delete)
  deviceSerial      String          -- The MANAGED DEVICE's serial, upper-cased — the same key AssetSource.externalId
                                    -- uses for the fortiswitch/fortiap kinds. This table exists BECAUSE that key is
                                    -- unique per device: a second claiming gate overwrote the first's row instead of
                                    -- colliding with it, so no evidence of the collision was ever persisted.
  sourceKind        String          -- "fortiswitch" | "fortiap"
  controllerSerial  String?         -- Chassis identity of the CLAIMING gate (rule 41's vocabulary). Null when the
                                    -- gate published none, which is what controllerKey's name: fallback covers.
  controllerDevice  String          -- FortiManager's device NAME for the claiming gate (what
                                    -- fortinetTopology.controllerFortigate holds — never compared to Asset.hostname)
  controllerKey     String          -- Dedupe key: upper-cased controllerSerial, else `name:<lower-cased device name>`
  integrationId     UUID? FK → Integration (set null on delete)
  firstSeen         DateTime
  lastSeen          DateTime        -- Re-asserted every discovery pass. A claim not renewed within CLAIM_FRESH_DAYS
                                    -- (2) stops counting, which is how a completed device move closes its own
                                    -- conflict; rows go entirely after CLAIM_PRUNE_DAYS (30).
  @@unique([deviceSerial, controllerKey]) -- one row per (device serial, claiming controller)

AssetIpHistory                  -- Auto-populated log of every IP each asset has held
  id            UUID PK           -- two writers: (1) db.ts Prisma extension recordIpHistory() on Asset.ipAddress
                                  --   change (the primary IP); (2) assetIpHistoryService.recordIpHistoryEntries(),
                                  --   called from the systemInfo scrape persist, folds in the asset's *associated*
                                  --   interface IPs (incl. public WAN / secondary addresses, which never become the
                                  --   primary ipAddress) — skipping the primary IP so the two writers don't churn firstSeen.
  assetId       UUID FK → Asset (cascade delete)
  ip            String
  source        String          -- "manual", "fortimanager", "fortigate", "dns", "monitor-system-info" (associated IPs), etc.
  firstSeen     DateTime
  lastSeen      DateTime
  @@unique([assetId, ip])       -- one row per (asset, ip); lastSeen and source update on re-sighting

AssetMacAddress                 -- All MACs an asset has been seen with. Replaces the legacy Asset.macAddresses JSONB column.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  mac           String                    -- normalized colon-uppercase (AA:BB:CC:DD:EE:FF)
  macEnd        String?                   -- when set, the row is the INCLUSIVE contiguous range [mac, macEnd] (interface-fold rows only; canonical form makes lexicographic == numeric, so containment is `mac <= X AND macEnd >= X`)
  source        String                    -- "fmg-discovery" | "fortigate" | "intune-ethernet" | "intune-wifi" | "device-inventory" | "ad" | "manual" | "monitor-interface" | various
  device        String?                   -- FortiGate device name when this MAC came from a DHCP scrape
  subnetCidr    String?                   -- populated when the IP at sighting time fell inside a known subnet
  subnetName    String?
  firstSeen     DateTime
  lastSeen      DateTime
  @@unique([assetId, mac])
  -- Persist: discovery code that builds an in-memory mac list (deduped + sorted lastSeen desc) calls `reconcileMacAddresses(assetId, macs)` from src/services/macAddressService.ts after the asset.update lands. The list/get response serializes the relation back into the legacy `macAddresses: [...]` JSON shape so existing API consumers keep reading the same field name. The system-info scrape AND the Polaris Agent `interfaces` push (`agents.ts POST /samples`) additionally fold EVERY scraped interface MAC (monitored or not) in via `reconcileInterfaceMacs` (source="monitor-interface"), coalescing contiguous MACs into `[mac, macEnd]` RANGE rows so a 48-port switch stores one row instead of 48. That reconcile is full-replace scoped to its own source; symmetrically `reconcileMacAddresses` filters monitor-interface entries from its input and scopes its deletes away from them, so the two writers never churn each other's rows. When another source already holds a row at a would-be range's start key, the range is written starting one past it instead of fighting over the row. Global search finds an individual MAC inside a range via lexicographic containment (canonical colon-uppercase makes string order == numeric order); in-memory MAC→asset indexes (LLDP match, quarantine push) expand ranges via `expandMacRange` (capped).
  -- Operator DELETES are the only manual write: `DELETE /assets/:id/macs/:mac` (assets:write) removes ONE row and, when it was the asset's primary, re-promotes through `selectPrimaryMac`. There is deliberately no tombstone — a removed MAC the network reports again is re-added by the next reconcile (business rule 79). There is also **no manual INSERT path**: `source="manual"` rows exist only from the legacy JSONB backfill and the ghost-merge carry-over. The edit modal's MAC box writes the `Asset.macAddress` SCALAR and never this table, so an operator cannot add a row here — if you are adding one, you are adding a feature, not using one.

AssetAssociatedIp               -- Additional ("secondary") IPs an asset holds beyond Asset.ipAddress. Replaces the legacy Asset.associatedIps JSONB column.
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  ip            String
  source        String          -- "manual" | "monitor-system-info" | various legacy values from the JSON backfill
  interfaceName String?
  mac           String?
  ptrName       String?         -- reverse-DNS cache, populated by the bulk DNS job and the per-asset DNS lookup endpoint
  ptrTtl        Int?
  ptrFetchedAt  DateTime?
  firstSeen     DateTime
  lastSeen      DateTime
  @@unique([assetId, ip])
  -- Persist: system-info scrape deletes all source != "manual" rows for the asset and re-inserts the fresh interface set in one $transaction; source="manual" rows are preserved. The list/get response serializes the relation back into the legacy `associatedIps: [...]` JSON shape so the frontend reads the same field name as before.

AssetSource                     -- Per-discovery-source view of an asset (Phase 1 of the multi-source asset model)
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)
  sourceKind    String          -- Phase 1: "entra" | "ad" | "fortigate-firewall" | "manual". Phase 2 cutover adds "intune" | "fortiswitch" | "fortiap" | "fortigate-dhcp-host" | ...
  externalId    String          -- Source-natural identity: entra.deviceId / ad.objectGUID / fortigate-firewall.serial. Manual sources use Asset.id itself.
  integrationId UUID? FK → Integration (set null on delete) -- null for "manual" rows and for inferred rows where the integration linkage couldn't be reconstructed
  observed      Json            -- Source-shaped raw observation blob (see "Per-source observed shapes" below). Stays as the source said it; the Asset row is the merged projection across sources.
  inferred      Boolean         @default(false) -- true when the row was synthesized by the Phase-1 backfill from legacy assetTag / sid: / ad-guid: tags rather than discovered fresh; cleared on next real run
  syncedAt      DateTime?       -- last successful refresh from this source (drives staleness)
  firstSeen     DateTime        -- when Polaris first recorded this source
  lastSeen      DateTime        -- last time this source reported the device as active
  @@unique([sourceKind, externalId]) -- (sourceKind, externalId) is the dedupe key — re-runs upsert in place
  -- Backfilled from existing assetTag / "sid:" / "ad-guid:" tags via the shadow-write Prisma extension in src/db.ts plus the one-shot backfillAssetSources startup job. All major discovery pathways (AD, Entra/Intune, FMG/FortiGate firewalls, FortiSwitches, FortiAPs, endpoints) now write AssetSource rows as the source of truth; projected Asset fields are derived from these rows via projectAssetFromSources(). The unified Asset row stays the stable FK target for everything downstream (monitoring, ip-history, sightings, quarantine).

AssetDependencyParent           -- Persistent parent→child edges of the dependency DAG. Drives dependency-aware monitoring suppression (see Asset.dependencySuppressed / dependencyLayer below).
  id            UUID PK
  assetId       UUID FK → Asset (cascade delete)        -- the child
  parentAssetId UUID FK → Asset (cascade delete)        -- the parent (FortiGate / upstream switch / AP / ESXi host)
  source        String          -- "computed" (Fortinet infra half) | "endpoint" (the leaf edge every non-infra asset hangs off its last-seen switch/AP/FortiGate by) | "vcenter" (VM→ESXi placement) | "override" (operator pin). Override rows take precedence per asset; if any override exists for a child the computed set is ignored. Empty override set = explicit "no parents" pin (asset opts out of suppression). EVERY non-override source is part of the effective "computed" set — loadEffectiveParents buckets them together, so anything resolving effective parents must test `source !== "override"` rather than `source === "computed"` (the literal test is what hid the endpoint and vcenter halves from the asset-details tree until 2026-08).
  detectedVia   String          -- "controller" (Asset.fortinetTopology.controllerFortigate / parentSwitch) | "interface" (interfaceTopologyService inferred edge — FortiLink / MCLAG aggregate naming) | "lldp" (AssetLldpNeighbor.matchedAssetId fallback) | "mesh" (wireless mesh leaf AP via AssetWirelessStation, OR FortiLink switch bridged behind a FortiAP via LLDP) | "switch-port" (endpoint half — Asset.lastSeenSwitch) | "wireless" (endpoint half — Asset.lastSeenAp) | "sighting" (endpoint half — the freshest AssetFortigateSighting) | "hypervisor" (vCenter placement) | "manual" (operator override)
  @@unique([assetId, parentAssetId, source])
  -- recomputeDependencyTree (in dependencyTreeService) replaces the source="computed" rows for an integration's assets at end of every FMG/FortiGate discovery cycle, then syncEndpointDependencyEdges DIFFS the fleet-wide source="endpoint" set in the same call (one parent per endpoint, most-specific of switch-port → wireless → sighting; assets already carrying a "vcenter" row are skipped). source="override" rows are operator-managed via the admin override endpoints and are never touched by either. Multi-parent rows model MCLAG / dual-homed switches; "all-down" semantics in the reconciler mean a redundant uplink keeps an asset polling normally — which is exactly why an endpoint gets ONE parent and not a union (a switch and the gate above it are in series, not parallel).

AssetTypeDef                    -- Operator-extensible asset-type registry; replaces the prior hardcoded `AssetType` enum
  id            UUID PK
  name          String @unique  -- machine value stored on `Asset.assetType`; 2-32 chars, lowercase + dash/underscore. Validated by `validateAssetTypeName` in `src/utils/assetTypes.ts`.
  label         String          -- human-facing display label, e.g. "Access Point"
  description   String?
  isBuiltIn     Boolean        @default(false) -- true for the eight seeded rows (server / switch / router / firewall / workstation / printer / access_point / other)
  isProtected   Boolean        @default(false) -- true for every built-in row; blocks rename/delete of IDENTITY (name + label + description). Since the match-rules cutover it does NOT block the three matching columns below: Asset.assetType stores `name` literally and special-case code keys on the eight literals, but nothing branches on HOW a device got into a bucket, so which devices land in "printer" stays the operator's question.
  createdBy     String?
  createdAt     DateTime
  updatedAt     DateTime
  matchRules    Json?          -- Inference rules: a nested AND/OR condition tree, `{op:"and"|"or"|"none"|"notAll", children:[leaf | group]}` with leaves `{field, operator, value}` — the automations device-filter grammar, so the shared PolarisConditionBuilder edits it unchanged. Null / empty = this type is never inferred, only assigned by an authoritative source or by hand (`other`, `hypervisor` and `kubernetes_cluster` ship that way). The pre-2026-09 flat shape (`{clauses:[{field, op, value, negate?}]}`, an ANY-of) is still IN the column on every existing install and is folded forward on read by `normalizeMatchRules` — no migration. Validated by `validateMatchRules` in `src/utils/assetTypeMatch.ts` (depth ≤ 5, ≤ 64 leaves fleet-wide across the tree); regexes are compile-checked at WRITE time because the resolver runs per device per discovery run.
  matchContexts String[]       @default([]) -- Which inference contexts the rules run in: `directory` (AD / Entra / Intune / Arc / FortiGate-endpoint OS inference) and `scan` (Network Discovery). PER-TYPE rather than global because the two predicates this replaced asked different questions of different inputs — server/workstation were directory-only, firewall/switch/access_point/router/printer scan-only, and one merged set would type an AD computer "printer" off its OS string.
  matchPriority Int            @default(100) -- Evaluation order, ascending; ties break on `name` so two installs with the same registry infer the same type. The seeds preserve the old if-ladder order (firewall 10 → switch 12 → access_point 14 → router 16 → printer 18 → server 20 → workstation 30), which is what keeps a "Windows Server 2019" box a server rather than falling into workstation's windows regex.
  -- Seeded by `prisma/migrations/20260527000000_asset_types_registry_cutover/migration.sql`.
  -- The eight built-in rows reproduce the pre-cutover enum exactly so
  -- existing installs see no behavior change. Operator-created custom
  -- types are stored as `isBuiltIn=false, isProtected=false` rows and
  -- can be renamed in place (renames are transactional — every Asset
  -- row holding the old name is rewritten to the new name atomically
  -- with the registry-row update; see `assetTypeService.updateAssetType`).
  -- Custom rows can be deleted only when no Asset.assetType row
  -- references them. Asset.assetType is a String (not a relation), so
  -- the service counts usage explicitly before issuing the delete.
  --
  -- Behavioral special-cases (FortiGate / switch / access_point in
  -- dependency tree, fortinetTopology, polling source defaults,
  -- topology rendering) only fire for the eight built-in names —
  -- custom types fall through to "other"-like generic behavior by
  -- design. Known limitation; documented next to the registry's UI
  -- surface (Server Settings → Identification → Device Types).
  -- INFERENCE is no longer part of that limitation: `inferAssetTypeFromOs`
  -- used to be on the list above and now delegates to the rules, so a
  -- CUSTOM type can claim a device on either context. What a custom
  -- type still cannot do is inherit the Fortinet / vCenter behaviors.
  --
  -- Cache: `src/utils/assetTypes.ts` holds the in-memory map populated
  -- by `assetTypeService.refreshCache()` at boot and after every CRUD
  -- mutation. Synchronous `isKnownAssetType()` reads it; until the
  -- cache loads it falls back to accepting the eight built-in names so
  -- early-boot writes stay legal.
```

## Notes

#### AssetDependencyParent

**AssetDependencyParent** — parent→child edges of the dependency DAG; drives `Asset.dependencySuppressed`. `source="computed"` rows are the Fortinet infra recompute's (delete-replaced per Fortinet discovery); `source="override"` rows are operator pins (always win); `source="vcenter"` rows are VM→ESXi-host edges written by `syncVcenterDevices` (delete-replaced per vCenter run, scoped to its own source value — the Fortinet recompute never touches them; any non-override source feeds the all-down suppression evaluation); `source="endpoint"` rows are the **endpoint half** (2026-08) — every asset whose type isn't firewall/switch/access_point gets AT MOST ONE parent, resolved most-specific-first from `Asset.lastSeenSwitch` (`detectedVia="switch-port"`) → `Asset.lastSeenAp` (`"wireless"`) → the freshest `AssetFortigateSighting` (`"sighting"`), skipping any asset already parented by vCenter. Before it the DAG was infra-only and "no parents" means "never suppressed": a camera-station server behind a dead FortiGate alerted as plain Down while every switch and AP behind the same gate read "Dep. Down". **One parent, never a union** — all-down semantics model REDUNDANT parents, but a switch and the gate above it are in SERIES, so listing both would let a dead access switch under a healthy gate satisfy "some parent is ok"; series propagation instead comes from the switch's own suppression (and an unmonitored intermediate stays transparent, so gate state still decides). Written fleet-wide by `syncEndpointDependencyEdges` inside `recomputeDependencyTree` — NOT integration-scoped, since most endpoints belong to a directory/vCenter integration that never runs it — and DIFFED rather than delete-replaced so a steady fleet writes zero rows per discovery finalize. Consumers resolving the effective set must test `source !== "override"`, not `source === "computed"`.
