-- Business rule 135: maintenance for path checks. A schedule may target path
-- checks (pathCheckIds) instead of assets; while one is in window its checks
-- stop running (agents and the server) and their alerts freeze. Open rows in
-- path_check_maintenance_windows are the source of truth, as
-- asset_maintenance_windows is for assets.

-- AlterTable
ALTER TABLE "maintenance_schedules" ADD COLUMN     "pathCheckIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "path_check_maintenance_windows" (
    "id" TEXT NOT NULL,
    "pathCheckId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "scheduleName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "endReason" TEXT,

    CONSTRAINT "path_check_maintenance_windows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "path_check_maintenance_windows_pathCheckId_startedAt_idx" ON "path_check_maintenance_windows"("pathCheckId", "startedAt");

-- CreateIndex
CREATE INDEX "path_check_maintenance_windows_endedAt_idx" ON "path_check_maintenance_windows"("endedAt");

-- AddForeignKey
ALTER TABLE "path_check_maintenance_windows" ADD CONSTRAINT "path_check_maintenance_windows_pathCheckId_fkey" FOREIGN KEY ("pathCheckId") REFERENCES "path_checks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "path_check_maintenance_windows" ADD CONSTRAINT "path_check_maintenance_windows_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "maintenance_schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
