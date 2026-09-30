-- The Path Check wizard's finder filter: the device filter an operator used to
-- find agent hosts before ticking them into assetIds. Display only; it never
-- decides who runs the check.
ALTER TABLE "path_checks" ADD COLUMN "sourceFilter" JSONB;
