-- Interface-scrape address rows name whether the address is the interface's
-- primary or one of its secondary addresses (FortiOS CMDB `secondary-ip`).
-- Null for every source that cannot tell.
ALTER TABLE "asset_associated_ips" ADD COLUMN "interfaceRole" TEXT;
