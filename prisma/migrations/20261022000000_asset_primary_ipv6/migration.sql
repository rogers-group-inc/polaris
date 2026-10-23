-- An asset's primary IPv6 address and its operator pin (business rule 128).
-- `assets` is an ordinary table. ipv6Address starts NULL everywhere and is
-- filled by the reconcilePrimaryIpv6 job from each asset's IPv6 address-list
-- rows — only while IPv6 is on for the install.

ALTER TABLE "assets" ADD COLUMN "ipv6Address"  TEXT;
ALTER TABLE "assets" ADD COLUMN "ipv6Pinned"   BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "assets" ADD COLUMN "ipv6PinnedAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "ipv6PinnedBy" TEXT;
