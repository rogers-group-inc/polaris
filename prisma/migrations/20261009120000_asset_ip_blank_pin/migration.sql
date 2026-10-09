-- Operator pin to NO address (Asset.ipBlankPinned). Clearing an IP in the
-- asset edit form used to release the pin and re-project the address, which
-- put a discovered address straight back; it now pins the asset blank. False
-- for every existing row — no asset is blank-pinned until an operator clears.
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "ipBlankPinned" BOOLEAN NOT NULL DEFAULT false;
