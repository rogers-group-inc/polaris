-- Business rule 103: polling evidence for the address-confidence score — the
-- IP Polaris's own probes have been answering on, and since when.
ALTER TABLE "assets" ADD COLUMN "ipConfirmedFor" TEXT;
ALTER TABLE "assets" ADD COLUMN "ipConfirmedSince" TIMESTAMP(3);
