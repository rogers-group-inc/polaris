-- Business rule 136: the five Priority tags are built in and locked.
--
-- 20261011200000_priority_severity_tags seeded them as ordinary tags, so an
-- install may have renamed, recoloured, moved or deleted one, or kept a
-- same-named tag it already had (ON CONFLICT DO NOTHING). From here on they are
-- fixed: name, category "Priority" and the severity colour, never deleted.
--
-- A tag still carrying the name is ADOPTED: moved into Priority with its
-- severity colour, keeping its id, its auto-assign filter and every asset /
-- interface that carries it. A missing one is re-created. A default the
-- operator renamed (e.g. "Critical" -> "P1") stays the ordinary tag it became,
-- and a fresh "Critical" is created beside it.

ALTER TABLE "tags" ADD COLUMN "builtIn" BOOLEAN NOT NULL DEFAULT false;

INSERT INTO "tags" ("id", "name", "category", "color", "builtIn") VALUES
  (gen_random_uuid()::text, 'Notice',        'Priority', 'severity:notice',        true),
  (gen_random_uuid()::text, 'Informational', 'Priority', 'severity:informational', true),
  (gen_random_uuid()::text, 'Warning',       'Priority', 'severity:warning',       true),
  (gen_random_uuid()::text, 'Serious',       'Priority', 'severity:serious',       true),
  (gen_random_uuid()::text, 'Critical',      'Priority', 'severity:critical',      true)
ON CONFLICT ("name") DO UPDATE
  SET "category" = EXCLUDED."category",
      "color"    = EXCLUDED."color",
      "builtIn"  = true;
