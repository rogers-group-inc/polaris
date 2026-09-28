-- Service inventory: per-service CPU and the Windows service description.
--
-- cpuPct is the agent's interval mean since its previous inventory scrape
-- (100 = one core, the asset_processes convention); description is
-- Win32_Service.Description (null on systemd). Both nullable — an older agent
-- simply never sends them. asset_services is delete-replaced per scrape, so no
-- backfill: the next scrape from an upgraded agent fills them.

ALTER TABLE "asset_services" ADD COLUMN "description" TEXT;
ALTER TABLE "asset_services" ADD COLUMN "cpuPct" DOUBLE PRECISION;
