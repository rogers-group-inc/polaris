-- Default tags: one per alert severity, grouped under the "Priority" tag
-- category, so every install starts with a ready-made priority vocabulary
-- that reads the same as the automation severity ladder.
--
-- The names and order follow SEVERITIES in src/services/notificationTypes.ts
-- (notice → informational → warning → serious → critical). The colors keep
-- the severity pills' hues (slate / blue / amber / orange / red) but at
-- mid-tones: a tag chip draws its color as TEXT on a tint of itself
-- (_tagChipStyle in public/js/app.js) in every theme, so the dark-theme pill
-- values (#ffd600 yellow) would vanish on the daylight themes.
--
-- These are ordinary manual tags (no assetCondition): the operator recolors,
-- renames or deletes them like any other. ON CONFLICT DO NOTHING leaves a
-- pre-existing tag of the same name exactly as the operator has it (any
-- category, any color), and because a migration runs once, a deleted default
-- stays deleted.

INSERT INTO "tags" ("id", "name", "category", "color") VALUES
  (gen_random_uuid()::text, 'Notice',        'Priority', '#64748b'),
  (gen_random_uuid()::text, 'Informational', 'Priority', '#0288d1'),
  (gen_random_uuid()::text, 'Warning',       'Priority', '#f59e0b'),
  (gen_random_uuid()::text, 'Serious',       'Priority', '#ff8a00'),
  (gen_random_uuid()::text, 'Critical',      'Priority', '#ef4444')
ON CONFLICT ("name") DO NOTHING;
