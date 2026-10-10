-- Business rule 102: per-MAC addresses + the operator-pinned primary address.

-- Discovery-written address rows name the gate that reported them and the
-- medium the binding rode in on.
ALTER TABLE "asset_associated_ips" ADD COLUMN "device" TEXT;
ALTER TABLE "asset_associated_ips" ADD COLUMN "medium" TEXT;
CREATE INDEX "asset_associated_ips_device_idx" ON "asset_associated_ips"("device");

-- The (MAC, IP) pair an operator chose to monitor the asset on.
ALTER TABLE "assets" ADD COLUMN "primaryAddressMac" TEXT;
ALTER TABLE "assets" ADD COLUMN "primaryAddressIp" TEXT;
ALTER TABLE "assets" ADD COLUMN "primaryAddressPinnedAt" TIMESTAMP(3);
ALTER TABLE "assets" ADD COLUMN "primaryAddressPinnedBy" TEXT;
