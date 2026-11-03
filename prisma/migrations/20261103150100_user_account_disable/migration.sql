-- Account disable (business rule 140): an administrator can disable an
-- account — no sign-in by any path, sessions ended, its saved folders /
-- filters / dashboards released exactly as a delete releases them. Null =
-- active, so every existing account stays active.

ALTER TABLE "users" ADD COLUMN "disabled_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "disabled_by" TEXT;
