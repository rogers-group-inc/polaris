-- Business rule 160: deleting an integration detaches what it discovered.
--
-- integrationDetachService now does this at delete time. This migration is the
-- other half: it removes what integrations deleted BEFORE this release left
-- behind on an existing install. A fresh install has none of these rows, and
-- no seed job writes them, so there is no seed-side twin.
--
-- It only touches source kinds that are written with an integration id on
-- every sync (vCenter, Azure Arc, Unraid / TrueNAS / Proxmox, Generic API).
-- For those kinds a NULL integration id has exactly one cause: the integration
-- was deleted and the foreign key nulled the column. Kinds that can
-- legitimately carry no integration (manual, polaris-agent, the SNMP
-- enrichment rows, and the entra / ad / intune / Fortinet rows the legacy
-- shadow-write derives from an asset tag) are deliberately left alone.

-- 1. Source rows of integrations that no longer exist. These kept feeding the
--    projection (hostname / OS / serial) and counted as "still reported", which
--    stopped the asset ever being auto-decommissioned.
DELETE FROM "asset_sources"
 WHERE "integrationId" IS NULL
   AND "sourceKind" IN (
     'vcenter-vm', 'vcenter-host',
     'arc', 'arc-k8s',
     'unraid-host', 'unraid-vm', 'unraid-container',
     'truenas-host', 'truenas-vm', 'truenas-app',
     'proxmox-node', 'proxmox-qemu', 'proxmox-lxc',
     'generic-api'
   );

-- 2. Hypervisor placement edges (VM / container -> host) whose child no longer
--    has a source row from that platform. Only that platform's own sync ever
--    replaced them, so with the integration gone they were frozen for good.
--    Operator overrides and computed edges are a different `source` and are
--    not touched.
DELETE FROM "asset_dependency_parents" e
 WHERE e."source" = 'vcenter'
   AND NOT EXISTS (SELECT 1 FROM "asset_sources" s WHERE s."assetId" = e."assetId" AND s."sourceKind" IN ('vcenter-vm', 'vcenter-host'));

DELETE FROM "asset_dependency_parents" e
 WHERE e."source" = 'unraid'
   AND NOT EXISTS (SELECT 1 FROM "asset_sources" s WHERE s."assetId" = e."assetId" AND s."sourceKind" IN ('unraid-host', 'unraid-vm', 'unraid-container'));

DELETE FROM "asset_dependency_parents" e
 WHERE e."source" = 'truenas'
   AND NOT EXISTS (SELECT 1 FROM "asset_sources" s WHERE s."assetId" = e."assetId" AND s."sourceKind" IN ('truenas-host', 'truenas-vm', 'truenas-app'));

DELETE FROM "asset_dependency_parents" e
 WHERE e."source" = 'proxmox'
   AND NOT EXISTS (SELECT 1 FROM "asset_sources" s WHERE s."assetId" = e."assetId" AND s."sourceKind" IN ('proxmox-node', 'proxmox-qemu', 'proxmox-lxc'));

-- 3. `azure:` tags on an asset that no longer has any Azure Arc source row.
--    Operators cannot remove these (every write path preserves them) and only
--    an Arc run ever stripped them. The tag registry's own rows are reconciled
--    by the reconcileTagAssignments job once no asset carries the tag.
UPDATE "assets" a
   SET "tags" = ARRAY(SELECT t FROM unnest(a."tags") AS t WHERE lower(t) NOT LIKE 'azure:%')
 WHERE EXISTS (SELECT 1 FROM unnest(a."tags") AS t WHERE lower(t) LIKE 'azure:%')
   AND NOT EXISTS (SELECT 1 FROM "asset_sources" s WHERE s."assetId" = a."id" AND s."sourceKind" IN ('arc', 'arc-k8s'));
