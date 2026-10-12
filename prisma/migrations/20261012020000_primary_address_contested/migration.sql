-- Business rule 103(a): when discovery last tried to move a pinned asset off
-- its pin. The automatic pin release refuses while this is recent.
ALTER TABLE "assets" ADD COLUMN "primaryAddressContestedAt" TIMESTAMP(3);
