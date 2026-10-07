-- Business rule 40(j): an operator may BLANK an offline device's address from
-- a duplicate-IP conflict card. `ipCleared` remembers which address was
-- blanked so a discovery write re-reporting it (the offline device's stale
-- lease) cannot walk the row back onto the contested address while another
-- device holds it; any other discovered address fills the blank and releases
-- the hold. Nullable, no default, no backfill: existing rows hold nothing.

ALTER TABLE "assets" ADD COLUMN "ipCleared" TEXT;
