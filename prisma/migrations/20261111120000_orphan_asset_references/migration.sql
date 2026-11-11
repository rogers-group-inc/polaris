-- Business rule 157: an asset leaves nothing behind when its row goes.
--
-- assetRemovalService now cleans these up at delete / merge time. This
-- migration is the other half: it removes what earlier deletes and merges
-- already left on an EXISTING install. A fresh install has none of these rows,
-- so every statement here matches nothing there (and no seed job writes them,
-- so there is no seed-side twin to keep in step).
--
-- Each statement only removes references to asset ids that no longer exist.
-- It never touches a row whose asset is still present, and it never empties a
-- list whose emptiness would widen a target: an automation's scope.assetIds
-- and the Application Map's rule pins are deliberately NOT rewritten here.

-- Pin lists: drop ids that name no asset. Safe when it empties the list — a
-- path check, contact or maintenance schedule with no pins targets only what
-- its own filter matches (nothing, when it has none).
UPDATE "path_checks" t
   SET "assetIds" = ARRAY(SELECT x FROM unnest(t."assetIds") AS x WHERE EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = x))
 WHERE EXISTS (SELECT 1 FROM unnest(t."assetIds") AS x WHERE NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = x));

UPDATE "contacts" t
   SET "assetIds" = ARRAY(SELECT x FROM unnest(t."assetIds") AS x WHERE EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = x))
 WHERE EXISTS (SELECT 1 FROM unnest(t."assetIds") AS x WHERE NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = x));

UPDATE "maintenance_schedules" t
   SET "assetIds" = ARRAY(SELECT x FROM unnest(t."assetIds") AS x WHERE EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = x))
 WHERE EXISTS (SELECT 1 FROM unnest(t."assetIds") AS x WHERE NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = x));

-- Per-asset rows on tables that carry the asset id with no foreign key.
DELETE FROM "log_flag_rules" t
 WHERE t."assetId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = t."assetId");

DELETE FROM "asset_process_configs" t
 WHERE NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = t."assetId");

DELETE FROM "asset_processes" t
 WHERE NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = t."assetId");

DELETE FROM "asset_services" t
 WHERE NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = t."assetId");

DELETE FROM "asset_sdwan_rules" t
 WHERE NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = t."assetId");

DELETE FROM "asset_inventory_scrapes" t
 WHERE NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = t."assetId");

-- Commands and agent script runs still waiting on a device that is gone.
UPDATE "agent_commands" t
   SET "status" = 'failed',
       "error" = 'withdrawn: the device this was queued for was deleted or merged away',
       "completedAt" = (now() AT TIME ZONE 'UTC')
 WHERE t."status" IN ('pending', 'sent')
   AND NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = t."assetId");

UPDATE "automation_script_runs" t
   SET "status" = 'failed',
       "stderr" = 'withdrawn: the device this was queued for was deleted or merged away',
       "completedAt" = (now() AT TIME ZONE 'UTC')
 WHERE t."runOn" = 'agent'
   AND t."status" IN ('pending', 'running')
   AND t."assetId" IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM "assets" a WHERE a."id" = t."assetId");
