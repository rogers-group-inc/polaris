---
name: polaris-domain-model
description: "Polaris data model: every Prisma entity (Asset, Subnet, Reservation, Integration, NotificationRule/Notification, Role, Credential, the sample hypertables and rollups, every Asset* side table), its fields, enums and load-bearing invariants. Load whenever a task names a table, model, column, enum, AssetSource kind, sourceType, monitorStatus or dhcpBinding; asks what a field means or where something is stored; adds a field/column/model; edits prisma/schema.prisma; or writes a migration."
---

# Polaris domain model

`prisma/schema.prisma` is the source of truth for types and relations. This skill carries
the **semantics** the schema cannot: what each entity is for, the invariant that makes it
load-bearing, the field-level notes, and the per-entity schema dump with inline comments.

Every reference file has the same three parts for its entities: **Definitions and
invariants** (one bullet per entity — the contract), **Schema** (the field dump), **Notes**
(the extended behavioral notes). Read the definitions first; go to Schema/Notes for a field.

## Which file

| Entities | File |
|---|---|
| IpBlock, Subnet, ArchivedSubnet / ArchivedReservation, SubnetExclusion, Reservation, Integration, DiscoveryRun, NetworkScan / NetworkScanRun, Conflict, allocation templates | [references/ipam.md](references/ipam.md) |
| Asset, AssetSource, AssetDependencyParent, AssetTypeDef, AssetMacAddress / AssetAssociatedIp / AssetIpHistory / AssetFortigateSighting | [references/assets-core.md](references/assets-core.md) |
| AssetInterface (+Override), AssetMacTableEntry, AssetArpEntry, AssetTrunkMember, AssetPhysicalEntity, AssetLldpNeighbor / AssetWirelessStation, AssetApRadio / AssetApVap, AssetMclagPeer, AssetProcess / AssetService / AssetProcessConnection, AssetSdwanRule, VcenterDatastore | [references/assets-inventory-tables.md](references/assets-inventory-tables.md) |
| The seven sample hypertables + *Hourly/*Daily rollups, AssetCustomWidgetSample, AssetStateSample, HostMetricsSample, MonitorClassOverride | [references/samples-rollups.md](references/samples-rollups.md) |
| NotificationRule, Notification, NotificationRuleState, NotificationChannel, NotificationDelivery, the alert email, Contact (+DirectoryContactSource), MaintenanceSchedule / AssetMaintenanceWindow, PushSubscription, AutomationScript / AutomationScriptRun, AgentCommand | [references/alerting.md](references/alerting.md) |
| User, Role, ApiToken, Credential, SshHostKey, GroupMapping, ManagedAgent, MibFile, ManufacturerProfile family, ManufacturerAlias, DeviceIcon, UserDashboard, SavedDashboard, UserTableTabs, SavedTableFilter, TopologyLayout, ApplicationMapLayout, Event, Setting, Tag / TagAutoAssignment / RegionTagAssignment, GeocodeCache | [references/platform.md](references/platform.md) |

## Rules that bind every write

- **Sample tables have NO foreign key to Asset and are never row-DELETEd/UPDATEd** where a row could sit in a compressed TimescaleDB chunk (see samples-rollups.md). Prune by `drop_chunks`, never by cascade.
- **Write-time clamps live in the Prisma extension** (`src/db.ts`): `acquiredAt ≤ lastSeen` (rule 9), the unmonitorable-status clamp (rule 10), hostname/IP override pins, Windows OS normalization (rule 28), secret sealing (rule 20b). A new write path gets them for free; raw SQL bypasses them.
- **`Asset.lastSeen` is written only through `bumpLastSeen()`** (rule 12). **Subnets are created only through `createSubnetRowChecked()` / `lockBlockForSubnetWrites()`** (rules 1, 20a, 42).
- **Adding a model or column**: schema + migration, Zod schema in the route file, service type, the matching Definitions bullet + Schema block here, and the file-map / TOUCHES entry via `/polaris-docs-sync`. `npm run check:docs` fails on a Prisma model no skill file names.
- Behavior a rule governs is spelled out in `polaris-business-rules`; who reads/writes a field is in `polaris-change-impact`.

## Enums

```
IpVersion:               v4 | v6
SubnetStatus:            available | reserved | deprecated
ReservationStatus:       active | expired | released
ReservationSourceType:   manual | dhcp_reservation | dhcp_lease | interface_ip | vip | fortiswitch | fortinap | fortimanager | fortigate | dns_resolved
ConflictStatus:          pending | accepted | rejected
// UserRole enum retired in the dynamic-roles cutover (migration
// 20260524000000_roles_table_cutover). Role identity + permission matrix
// now live in the `Role` table and are joined into User via `User.roleId`.
AssetStatus:             active | maintenance | decommissioned | storage | disabled | quarantined
// AssetType enum retired in the asset-type registry cutover (migration
// 20260527000000_asset_types_registry_cutover). Asset.assetType is now a
// free-form String validated at write time against the `AssetTypeDef`
// registry. The eight historical enum values (server / switch / router /
// firewall / workstation / printer / access_point / other) are seeded as
// `isBuiltIn=true, isProtected=true` registry rows so behavior matches
// pre-cutover for installs that never add custom types; the vCenter
// integration added the `hypervisor` built-in the same way (migration
// 20260709000000 + the seedAssetTypes self-heal), and the Azure Arc
// integration added `kubernetes_cluster` the same way (migration
// 20260807020000) for Arc-enabled connected clusters — note that
// registration is a SIX-WAY lockstep. Backend three: the migration,
// BUILT_IN_ASSET_TYPES, AND the BUILT_IN_SEEDS entry, because
// seedBuiltInAssetTypes skips any seed whose name isn't in the built-in list.
// Frontend three, all in public/js/widgets/index.js: BUILTIN_ASSET_TYPES,
// ASSET_TYPE_LABELS and ASSET_TYPE_COLORS. Those maps are the SEED and the
// offline fallback: since 2026-09 the gear's asset-type grid repaints from
// GET /dashboard/filter-options (built-ins + every custom type the asset-type
// registry carries, registry-labelled), so a name absent from them is unordered,
// uncoloured and late rather than invisible. Before that the widgets read no
// registry at all, and because the server derived the hidden set as
// (built-ins − the enabled ones the widget sent), a name they lacked was
// impossible to filter on: both `hypervisor` and `kubernetes_cluster` were
// unfilterable from the day each was added until 2026-08, and every
// operator-added custom type was until 2026-09. tests/unit/widgetAssetTypes.test.ts pins the parity; the full
// checklist is in polaris-change-impact → services (the `services/assetTypeService.ts` entry). The `hypervisor` type's
// `virtual_machine` sibling was retired by migration 20260722000000 — vCenter VMs are typed
// plain `server` (VM identity lives in Asset.virtualization + the
// vcenter-vm AssetSource row; the per-class config block kept its
// vmMonitor name, dispatched by integration type — `server` on a vcenter
// integration resolves to vmMonitor, on a directory integration to
// serverMonitor). Code that branches on `assetType === "firewall" |
// "switch" | "access_point"` (dependency tree, fortinetTopology, polling
// source defaults, topology rendering, inferAssetTypeFromOs) only
// special-cases those Fortinet built-ins — custom operator-added types
// fall through to "other"-like generic behavior by design, and the
// vCenter surfaces key on their own data instead (syncVcenterDevices,
// vmMonitor/hostMonitor class blocks, the virtualization endpoint, the
// "vcenter" polling method).
```

`AssetStatus` and the six `monitorStatus` values (`up | down | warning | recovering | unknown | passive`) are the two state machines most code branches on — `passive` means "no down automation covers this device, so Polaris renders no verdict" (rule 36), and anything testing `!== "up"` as a proxy for unreachable must exempt it.
