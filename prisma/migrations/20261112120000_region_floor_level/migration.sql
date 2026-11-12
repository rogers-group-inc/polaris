-- Numbered floors (business rule 168): a floor's code is a whole number (f:-1,
-- f:2); its name ("Basement", "Surface") is only a label. Additive: existing
-- floors keep their name and get a number when an operator gives them one, or
-- here when their name already is one.
ALTER TABLE "region_nodes" ADD COLUMN "level" INTEGER;
UPDATE "region_nodes" SET "level" = CAST(btrim("name") AS INTEGER)
 WHERE "kind" = 'floor' AND btrim("name") ~ '^-?[0-9]{1,2}$';
