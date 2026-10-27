-- The download formats an AI assistant report offers (rule 95(c)): only the
-- ones the user asked for. Empty = all three (CSV, PDF, Markdown), which is
-- what every report stored before this column offered.
ALTER TABLE "assistant_reports" ADD COLUMN "formats" TEXT[] DEFAULT ARRAY[]::TEXT[];
