-- Business rule 165: remember the FortiGates that still hold a quarantine block
-- after the asset was released (the gate could not be reached at release time),
-- so Polaris can show them, retry them and let an operator dismiss them.
-- Additive, with a default: existing rows read as "nothing stranded". Nothing to
-- backfill - earlier stranded entries were recorded only as Events, which carry
-- no reliable pointer back to a gate, and no seed writes this column.
ALTER TABLE "assets" ADD COLUMN "quarantineStranded" JSONB NOT NULL DEFAULT '[]';
