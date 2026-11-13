-- Business rule 118(a): an attempt stamp for the LLDP and storage cadences, so a
-- failing device waits a cadence instead of being re-queued every heavy tick.
-- Nullable, no default: NULL means never attempted, which the due check reads
-- through the existing last*At stamp exactly as before.
ALTER TABLE "assets" ADD COLUMN "lastLldpAttemptAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "lastStorageAttemptAt" TIMESTAMP(3);
