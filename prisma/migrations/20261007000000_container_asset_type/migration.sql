-- Unraid / TrueNAS SCALE integrations: the `container` built-in asset type.
--
-- A Docker container on an Unraid host, or a TrueNAS SCALE App (a compose
-- project, folded into one asset), is a genuinely new entity: it is not a
-- machine (no agent, no SNMP, no interfaces of its own worth inventorying),
-- so it gets its own type rather than riding `server`. VMs on those hosts
-- stay `server`, exactly as vCenter VMs do; the hosts are `hypervisor`.
--
-- ON CONFLICT DO UPDATE adopts a pre-existing operator-created custom type of
-- the same name rather than failing the upgrade (same posture as
-- 20260807020000 for `kubernetes_cluster`).
--
-- LOCKSTEP: the name must ALSO be in src/utils/assetTypes.ts
-- (BUILT_IN_ASSET_TYPES), BUILT_IN_SEEDS in src/services/assetTypeService.ts,
-- and the three browser lists in public/js/widgets/index.js.

INSERT INTO "asset_type_defs" ("id", "name", "label", "description", "is_built_in", "is_protected", "updatedAt") VALUES
  (gen_random_uuid()::text, 'container', 'Container', 'Docker container (Unraid) or App (TrueNAS SCALE). Parented by its host in the dependency tree; it runs no Polaris Agent.', true, true, CURRENT_TIMESTAMP)
ON CONFLICT ("name") DO UPDATE SET
  "label"        = EXCLUDED."label",
  "description"  = EXCLUDED."description",
  "is_built_in"  = true,
  "is_protected" = true,
  "updatedAt"    = CURRENT_TIMESTAMP;
